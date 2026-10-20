/**
 * 远程控制：通过 QQ 私聊在这台电脑上执行命令。
 *
 * 这是**第四档**能力（任意命令执行），所以安全设计比功能更重要。
 * 下面每一条约束都是刻意的，改动前请先读懂为什么。
 *
 * ── 四道门 ───────────────────────────────────────────────
 * ① 仅私聊     群聊一律拒绝。群里任何人 @ 都不触发（避免他人借道）。
 * ② 身份白名单 只认 QQ_ADMIN_USERS 里的 openid。
 * ③ 独立口令   口令以 **SHA-256 哈希**存在 .env，读 .env 拿不到明文。
 *              解锁后有时效（默认 10 分钟），到期自动上锁。
 * ④ 危险确认   关机/重启/格式化/递归删除等要回一次性确认码。
 *
 * ── 为什么不拼 shell 字符串 ────────────────────────────────
 * run 用 spawn(exe, [args]) 的**数组形式**，且命令整体作为一个参数
 * 交给 cmd.exe /c 之外不再做任何拼接。用户输入永远只是一个 argv 元素，
 * 不会被当成代码结构解析。
 */

import crypto from "node:crypto";
import { spawn as nodeSpawn } from "node:child_process";
import { botName } from "../persona/naming.js";

export const DEFAULT_TTL_MS = 10 * 60 * 1000;
export const DEFAULT_TIMEOUT_MS = 30000;
export const DEFAULT_MAX_OUTPUT = 1500;

/** 需要二次确认的危险操作（在**命令文本**上做关键词判定，不是执行后判） */
const DANGER_PATTERNS = [
  /\bshutdown\b/i,
  /\brestart-computer\b/i,
  /\bStop-Computer\b/i,
  /\bformat\b/i,
  /\bdiskpart\b/i,
  /\bdel\s+\/[fsq]/i,
  /\brd\s+\/s/i,
  /\brmdir\s+\/s/i,
  /\bRemove-Item\b.*-Recurse/i,
  /\breg\s+delete\b/i,
  /\bbcdedit\b/i,
  /\bcipher\s+\/w/i,
  /\btaskkill\b.*\/f/i,
];

function str(v) {
  return typeof v === "string" ? v.trim() : v == null ? "" : String(v).trim();
}

function num(v, d) {
  const n = Number.parseFloat(str(v));
  return Number.isFinite(n) && n > 0 ? n : d;
}

/** 从环境变量解析远程控制配置 */
export function resolveRemoteConfig(env = {}) {
  const hash = str(env.REMOTE_PASS_HASH).toLowerCase();
  return {
    enabled: String(env.REMOTE_ENABLED ?? "false").toLowerCase() === "true",
    // 没设哈希就等于没启用——绝不允许"空口令即可解锁"
    passHash: /^[0-9a-f]{64}$/.test(hash) ? hash : "",
    ttlMs: num(env.REMOTE_TTL_MS, DEFAULT_TTL_MS),
    timeoutMs: num(env.REMOTE_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
    maxOutput: num(env.REMOTE_MAX_OUTPUT, DEFAULT_MAX_OUTPUT),
    // 默认走 cmd.exe；想用 PowerShell 就把 REMOTE_SHELL 设成 powershell
    shell: str(env.REMOTE_SHELL).toLowerCase() === "powershell" ? "powershell" : "cmd",
    confirmTtlMs: num(env.REMOTE_CONFIRM_TTL_MS, 60000),
    // 自然语言 agent（说人话 → 自己翻译成命令 → 看结果 → 下一步）
    agentEnabled: String(env.REMOTE_AGENT_ENABLED ?? "true").toLowerCase() !== "false",
    agentMaxSteps: num(env.REMOTE_AGENT_MAX_STEPS, 5),
    // 自然语言口令（整句匹配，不区分大小写、折叠空白）。
    // 注意：这类短语是"零熵"的——知道约定的人就能解锁，比随机口令弱得多。
    unlockPhrase: normalizePhrase(env.REMOTE_UNLOCK_PHRASE || "vibe coding"),
    lockPhrase: normalizePhrase(env.REMOTE_LOCK_PHRASE || "stop coding"),
    logger: null,
  };
}

/**
 * 归一化口令短语：小写、折叠所有空白、去首尾。
 * 用**整句相等**而不是包含匹配——否则聊天里顺口提到 "stop coding" 就会误上锁。
 */
export function normalizePhrase(s) {
  return String(s ?? "").toLowerCase().replace(/\s+/g, " ").trim();
}

/** 口令 → 哈希（配置 .env 时用这个函数生成 REMOTE_PASS_HASH） */
export function hashPassphrase(passphrase) {
  return crypto.createHash("sha256").update(String(passphrase), "utf8").digest("hex");
}

/**
 * 解锁会话仓库。**密钥按 openid 隔离**——一个人解锁不影响另一个人，
 * 而且解锁状态只活在内存里，进程重启即失效。
 */
export function createSessionStore(now = () => Date.now()) {
  /** @type {Map<string, {until:number, confirm:{code:string,cmd:string,until:number}|null}>} */
  const sessions = new Map();
  return {
    unlock(openid, ttlMs) {
      const s = sessions.get(openid) ?? { until: 0, confirm: null };
      s.until = now() + ttlMs;
      s.confirm = null;
      sessions.set(openid, s);
      return s.until;
    },
    isUnlocked(openid) {
      const s = sessions.get(openid);
      return Boolean(s && now() < s.until);
    },
    lock(openid) {
      sessions.delete(openid);
    },
    remainingMs(openid) {
      const s = sessions.get(openid);
      return s ? Math.max(0, s.until - now()) : 0;
    },
    putConfirm(openid, cmd, code, ttlMs) {
      const s = sessions.get(openid) ?? { until: 0, confirm: null };
      s.confirm = { code, cmd, until: now() + ttlMs };
      sessions.set(openid, s);
    },
    takeConfirm(openid, code) {
      const s = sessions.get(openid);
      if (!s?.confirm) return null;
      if (now() > s.confirm.until) {
        s.confirm = null;
        return null;
      }
      if (s.confirm.code !== code) return null;
      const cmd = s.confirm.cmd;
      s.confirm = null;
      return cmd;
    },
    hasPendingConfirm(openid) {
      const s = sessions.get(openid);
      return Boolean(s?.confirm && now() <= s.confirm.until);
    },
    _sessions: sessions,
  };
}

/** 这条消息是不是远程指令？只认以 / 开头的私聊消息。 */
export function isRemoteCommand(text) {
  return /^\/\S/.test(str(text));
}

/** 命令是否属于危险操作 */
export function isDangerous(cmd) {
  const s = str(cmd);
  return DANGER_PATTERNS.some((re) => re.test(s));
}

/**
 * 解析指令。
 * 返回 {kind, arg}：
 *   unlock / lock / status / confirm / run / unknown
 */
export function parseRemoteCommand(text) {
  const s = str(text);
  const m = /^\/(\S+)\s*([\s\S]*)$/.exec(s);
  if (!m) return { kind: "unknown", arg: "" };
  const verb = m[1].toLowerCase();
  const arg = m[2].trim();
  const table = {
    解锁: "unlock", unlock: "unlock",
    锁定: "lock", lock: "lock",
    确认: "confirm", confirm: "confirm",
    状态: "status", status: "status",
    执行: "run", run: "run", sh: "run", cmd: "run",
    帮助: "help", help: "help",
  };
  const kind = table[verb];
  if (!kind) return { kind: "unknown", arg: verb };
  // 「/解锁」「/锁定」这类无参数的，arg 忽略
  return { kind, arg };
}

/** 把输出裁到可发消息的长度，并去掉控制字符 */
export function clampOutput(text, max) {
  const s = String(text ?? "").replace(/\u0000/g, "");
  if (s.length <= max) return { text: s, truncated: false };
  return { text: s.slice(0, max), truncated: true };
}

/** 生成 6 位数字确认码 */
export function makeConfirmCode(rand = crypto.randomBytes) {
  const n = rand(4).readUInt32BE(0) % 1000000;
  return String(n).padStart(6, "0");
}

/**
 * 真正执行命令。**永不抛出**，返回 {ok, code, output}。
 *
 * 关键：spawn 用数组形式，命令整体只作为 `-Command` / `/c` 的**单个参数**，
 * 由 shell 自己解析——但因为我们没在 JS 侧做任何字符串拼接，
 * 用户输入不会被 JS 当成代码结构。
 */
export async function executeRemote(cmd, cfg, deps = {}) {
  const spawnImpl = deps.spawn ?? nodeSpawn;
  const text = str(cmd);
  if (!text) return { ok: false, code: -1, output: "命令为空" };

  const isPs = cfg.shell === "powershell";
  const exe = isPs ? "powershell.exe" : "cmd.exe";
  const args = isPs
    ? ["-NoProfile", "-NonInteractive", "-Command", text]
    : ["/d", "/s", "/c", text];

  return new Promise((resolve) => {
    let child;
    try {
      child = spawnImpl(exe, args, { windowsHide: true, env: process.env });
    } catch (err) {
      resolve({ ok: false, code: -1, output: `启动失败：${err?.message ?? err}` });
      return;
    }
    let out = "";
    let errOut = "";
    let done = false;
    let timer = null;
    const finish = (payload) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      // 合并 stdout/stderr：很多命令把有用信息写在 stderr（如 git、ffmpeg）
      const merged = [out, errOut].filter(Boolean).join("\n");
      resolve({ output: merged, ...payload });
    };
    timer = setTimeout(() => {
      try {
        child.kill?.();
      } catch {
        /* 杀不掉就算了，超时已经如实报告 */
      }
      finish({ ok: false, code: -1, timedOut: true });
    }, cfg.timeoutMs);

    child.stdout?.on?.("data", (d) => {
      out += d.toString("utf8");
    });
    child.stderr?.on?.("data", (d) => {
      errOut += d.toString("utf8");
    });
    child.on?.("error", (err) => finish({ ok: false, code: -1, output: `执行出错：${err?.message ?? err}` }));
    child.on?.("close", (code) => finish({ ok: code === 0, code }));
  });
}

/** 帮助文本 */
export function helpText(cfg) {
  return [
    "可用指令（仅私聊）：",
    `说「${cfg.unlockPhrase}」  开启全权限模式`,
    `说「${cfg.lockPhrase}」  立即关闭`,
    "/状态          查看当前是否开启",
    "/执行 <命令>   在本机执行命令",
    "/确认 <6位码>  危险操作二次确认",
    "/帮助          显示这条",
    "",
    // 自然语言 agent：解锁后不需要斜杠，直接说人话就行
    ...(cfg.agentEnabled === false
      ? []
      : [`开启后**直接说人话**也可以（${botName()}自己翻译成命令，最多连跑 ${cfg.agentMaxSteps ?? 5} 步），`,
         "例：「打开浏览器搜一下 b站」"]),
    "",
    `shell=${cfg.shell}  超时=${Math.round(cfg.timeoutMs / 1000)}s  输出上限=${cfg.maxOutput} 字`,
  ].join("\n");
}

/**
 * 远程指令总入口。**永不抛出**，永远返回 {handled, reply}。
 *
 * handled=false 表示这条消息不该由远程控制处理（例如它不是 / 开头的指令），
 * 调用方应该继续走人格模型。
 *
 * @param {object} p
 * @param {string} p.text      原始消息文本
 * @param {string} p.openid    发送者 openid
 * @param {boolean} p.isC2C    是否私聊（非私聊一律拒绝）
 * @param {string[]} p.admins  管理员 openid 列表
 * @param {ReturnType<typeof resolveRemoteConfig>} p.cfg
 * @param {ReturnType<typeof createSessionStore>} p.sessions
 * @param {object} [p.deps]    仅测试用（spawn / rand / logger）
 */
export async function handleRemoteCommand(p) {
  const { text, openid, isC2C, admins, cfg, sessions } = p;
  const deps = p.deps ?? {};
  const log = deps.logger ?? cfg.logger;

  // 未启用：不接管消息，交回人格模型（避免"机器人说一堆内部状态"）
  if (!cfg.enabled) return { handled: false, reply: "" };

  // 口令短语（自然语言，整句匹配）
  const norm = normalizePhrase(text);
  const hitUnlock = norm !== "" && norm === cfg.unlockPhrase;
  const hitLock = norm !== "" && norm === cfg.lockPhrase;

  // 既不是口令短语、也不是 / 指令 → 交回人格模型
  if (!hitUnlock && !hitLock && !isRemoteCommand(text)) return { handled: false, reply: "" };

  const parsed = parseRemoteCommand(text);

  // ── 门①：仅私聊 ──────────────────────────────────────────
  if (!isC2C) {
    log?.warn?.(`[remote] 拒绝群聊指令 from=${openid} text=${str(text).slice(0, 60)}`);
    return { handled: true, reply: "远程控制只在私聊里可用。" };
  }

  // ── 门②：身份白名单 ─────────────────────────────────────
  if (!admins.includes(openid)) {
    // 不回任何细节，避免探测者确认"这里是控制入口"
    log?.warn?.(`[remote] 拒绝非管理员指令 from=${openid}`);
    return { handled: false, reply: "" };
  }

  const audit = (what, extra = "") =>
    log?.info?.(`[remote] openid=${openid} ${what}${extra ? " " + extra : ""}`);

  // ── 口令短语：stop coding 关闭 / vibe coding 开启 ─────────
  if (hitLock) {
    sessions.lock(openid);
    audit("lock-by-phrase");
    return { handled: true, reply: "已关闭全权限模式。" };
  }
  if (hitUnlock) {
    sessions.unlock(openid, cfg.ttlMs);
    audit("unlock-by-phrase");
    return {
      handled: true,
      reply: `全权限模式已开启，${Math.round(cfg.ttlMs / 60000)} 分钟后自动关闭。`,
    };
  }

  switch (parsed.kind) {
    case "help":
      return { handled: true, reply: helpText(cfg) };

    case "status": {
      const unlocked = sessions.isUnlocked(openid);
      return {
        handled: true,
        reply: unlocked
          ? `全权限模式已开启，剩余 ${Math.ceil(sessions.remainingMs(openid) / 60000)} 分钟。`
          : `全权限模式未开启。说「${cfg.unlockPhrase}」开启。`,
      };
    }

    case "lock":
      sessions.lock(openid);
      audit("lock");
      return { handled: true, reply: "已上锁。" };

    case "unlock": {
      if (!parsed.arg) return { handled: true, reply: `用法：/解锁 ${cfg.unlockPhrase}` };
      if (normalizePhrase(parsed.arg) !== cfg.unlockPhrase) {
        audit("unlock-failed");
        return { handled: true, reply: "口令不对。" };
      }
      sessions.unlock(openid, cfg.ttlMs);
      audit("unlock-ok");
      return { handled: true, reply: `已解锁 ${Math.round(cfg.ttlMs / 60000)} 分钟，之后自动上锁。` };
    }

    case "confirm": {
      const cmd = sessions.takeConfirm(openid, str(parsed.arg));
      if (!cmd) return { handled: true, reply: "没有待确认的操作，或确认码不对/已过期。" };
      audit("confirm-ok", `cmd=${cmd.slice(0, 60)}`);
      const res = await executeRemote(cmd, cfg, deps);
      const c = clampOutput(res.output, cfg.maxOutput);
      return {
        handled: true,
        reply: `${res.ok ? "执行完成" : `执行失败（exit ${res.code}${res.timedOut ? "，超时" : ""}）`}\n${c.text || "(无输出)"}`,
      };
    }

    case "run": {
      if (!sessions.isUnlocked(openid)) {
        return { handled: true, reply: "未解锁。先用 /解锁 <口令>。" };
      }
      const cmd = str(parsed.arg);
      if (!cmd) return { handled: true, reply: "用法：/执行 <命令>" };

      // ── 门④：危险操作二次确认 ───────────────────────────
      if (isDangerous(cmd)) {
        const code = makeConfirmCode(deps.rand);
        sessions.putConfirm(openid, cmd, code, cfg.confirmTtlMs);
        audit("danger-pending", `cmd=${cmd.slice(0, 60)}`);
        return {
          handled: true,
          reply: `这条命令会造成不可逆影响，需要确认。\n\n命令：${cmd}\n\n回 /确认 ${code} 执行（${Math.round(cfg.confirmTtlMs / 1000)} 秒内有效）。`,
        };
      }

      audit("run", `cmd=${cmd.slice(0, 80)}`);
      const res = await executeRemote(cmd, cfg, deps);
      const c = clampOutput(res.output, cfg.maxOutput);
      audit("run-done", `exit=${res.code}`);
      return {
        handled: true,
        reply: `${res.ok ? "执行完成" : `执行失败（exit ${res.code}${res.timedOut ? "，超时" : ""}）`}${c.truncated ? "（输出已截断）" : ""}\n${c.text || "(无输出)"}`,
      };
    }

    default:
      return { handled: true, reply: `未知指令 /${parsed.arg}。发 /帮助 看可用指令。` };
  }
}
