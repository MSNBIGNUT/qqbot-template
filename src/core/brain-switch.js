/**
 * 双引擎切换：「春禾启动主脑」/「春禾关闭主脑」。
 *
 * 背景：
 *   春禾有两套引擎，共用同一个 QQ AppID（在 .env 里配），
 *   而 QQ 只允许一条 WebSocket 连接 —— 所以两套**不能同时在线**，切换必须真的交接。
 *
 *     lite  = 旧春禾引擎（qqbot-chunhe，提示词精炼、工具少，省 token，默认）
 *     brain = openclaw 的 chunhe agent（工作区文件 + 完整工具定义 + 完整 transcript，能干活但烧 token）
 *
 * 这个模块只负责两件事：
 *   1. 认出触发词（`isBrainSwitchRequest`）—— 判错代价很大，见下方正则的注释；
 *   2. 把切换脚本**分离**地拉起来（`spawnBrainSwitch`）。
 *
 * ⚠️ 顺序是硬约束：调用方必须**先把回复发出去**，再调 spawnBrainSwitch。
 *    因为 `-Mode brain` 的第一件事就是把旧春禾停掉 —— 先停再回，主人什么都收不到。
 *    spawn 本身是分离进程 + unref：脚本不依赖本进程存活，本进程被杀也照跑。
 */

import path from "node:path";
import fs from "node:fs";
import { spawn } from "node:child_process";
import { botName } from "../persona/naming.js";

/** 收到「启动主脑」时先发出去的这句话（必须在停机之前送达） */
export const BRAIN_REPLY_ON =
  "好～主脑启动中，" + botName() + "这就把 QQ 交给 openclaw，大约 30 秒后就能用了 ✨";

/** 旧引擎在线时收到「关闭主脑」的回复：本来就在普通模式，不该再跑一遍脚本 */
export const BRAIN_REPLY_OFF =
  "主人，现在" + botName() + "就是普通模式呀～（想让 openclaw 接管，就说「" + botName() + "启动主脑」）";

/**
 * 「主脑」是个足够独特的词，但也不是随便一句都该触发停机。
 * 规则：**动词必须紧贴「主脑」**（中间只允许一个"到/成/为"），夹了别的字就不算
 * （"打开了主脑"不算，"主脑是什么"因为没有动词也不算）。
 */
const ON_RE = /(启动|开启|打开|切换|切到|换成|进入|开)[到成为]?主脑/;
const OFF_RE = /(关闭|关掉|关了|关下|停用|停止|退出|结束|下线|关)[到成为]?主脑/;

/** 否定/取消：说了这些就一律不触发（"不要启动主脑"不能真去停机） */
const NEGATION_RE = /(不要|不用|别|先不|暂不|取消|禁止|不准)/;

/** 疑问/咨询：像"…是什么意思""…怎么用"这类是在问概念，不是在下指令 */
const QUESTION_RE = /(是什么|什么意思|啥意思|怎么用|什么用|有什么用|能不能|可不可以)/;

/** 归一化：去掉空白与中英文标点，让「春禾，启动主脑！」也能命中 */
export function normalizeTriggerText(text) {
  return String(text ?? "")
    .replace(/[\s\u3000]+/g, "")
    .replace(/[，。！？、；：,.!?;:~～"'“”‘’（）()【】\[\]{}「」『』《》<>]/g, "");
}

/**
 * 判断一句话是不是双引擎切换指令。
 *
 * @param {string} text 用户原话
 * @returns {"on"|"off"|null} on=启动主脑，off=关闭主脑，null=不是指令
 */
export function isBrainSwitchRequest(text) {
  if (text === null || text === undefined) return null;
  const t = normalizeTriggerText(text);
  if (!t) return null;
  if (NEGATION_RE.test(t)) return null;
  if (QUESTION_RE.test(t)) return null;

  // 先判 off：`关闭主脑` 里也含 `关`，而 ON_RE 里没有 `关`，两者不冲突；
  // 但为了语义明确仍然先判 off。
  if (OFF_RE.test(t)) return "off";
  if (ON_RE.test(t)) return "on";
  return null;
}

/**
 * 解析切换脚本的绝对路径。
 *
 * 优先用配置（QQ_BRAIN_SWITCH_SCRIPT / BRAIN_SWITCH_SCRIPT），
 * 否则按「源码目录 → 项目根 → 当前工作目录」的顺序找。
 * 之所以要按源码目录找：脚本放在 **宝库根**（qqbot-chunhe 的上一级），
 * 而运行时的 cwd 未必是项目根 —— 用相对路径找会静默找不到。
 */
export function resolveSwitchScript(config = {}) {
  const configured = config?.brainSwitchScript;
  if (configured && String(configured).trim()) return String(configured).trim();

  const candidates = [];
  const here = import.meta.dirname; // <项目>/src/core
  if (here) {
    // src/core → src → 项目根 → 宝库根
    candidates.push(path.resolve(here, "..", "..", "..", "switch-brain.ps1"));
    candidates.push(path.resolve(here, "..", "..", "switch-brain.ps1"));
  }
  candidates.push(path.resolve(process.cwd(), "..", "switch-brain.ps1"));
  candidates.push(path.resolve(process.cwd(), "switch-brain.ps1"));

  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return c;
    } catch {
      /* 找不到就试下一个 */
    }
  }
  return candidates[0];
}

/** 优先用系统自带的 PowerShell 5.1（脚本本身就按 5.1 兼容写的） */
export function defaultPowershell() {
  const sys = process.env.SystemRoot || "C:\\Windows";
  const p = path.join(sys, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  try {
    if (fs.existsSync(p)) return p;
  } catch {
    /* 落到 PATH 上的 powershell */
  }
  return "powershell.exe";
}

/** cmd.exe —— 只是为了借 `start` 给 powershell 一个新控制台，见下方注释 */
export function defaultComspec() {
  const c = process.env.ComSpec || process.env.COMSPEC;
  if (c && /cmd\.exe$/i.test(c)) return c;
  const sys = process.env.SystemRoot || "C:\\Windows";
  return path.join(sys, "System32", "cmd.exe");
}

/** cmd 会重新解析一遍命令行，含空格的参数必须自己加引号 */
function quoteForCmd(arg) {
  if (/[\s"]/.test(arg)) return `"${arg}"`;
  return arg;
}

/**
 * 分离地启动切换脚本。
 *
 * 为什么不 await 结果：脚本会把这个进程杀掉（brain 模式第一步就是停旧春禾），
 * 所以必须是真正独立的进程。
 *
 * ⚠️ 这里的 spawn 参数是踩了两个坑之后定下来的，别随手改：
 *
 *   坑 1：直接 `spawn(powershell, args, {detached:true})` —— 不行。
 *     detached 在 Windows 上走 `DETACHED_PROCESS`（不创建控制台），
 *     powershell.exe 拿不到控制台会**静默退出、一个字节都不执行**，而且不报错。
 *     表现：机器人回了「主脑启动中」，然后什么都没发生。
 *     → 所以外面套一层 `cmd /c start "" /b`，由 start 给 powershell 一个新控制台。
 *
 *   坑 2：不加 `detached:true` —— 也不行。
 *     libuv 对非 detached 的子进程会创建 `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`
 *     的 Job Object 并把它放进去；旧春禾一被杀，父句柄关闭 → job 关闭 →
 *     **脚本自己也被连带杀掉**。
 *     表现：日志停在「已停止旧春禾」，然后两边都不在线（实测真机复现过）。
 *     → 所以必须 `detached:true` 把子进程从 job 里摘出去。
 *
 * 永不抛出 —— 调用方还要靠返回值决定要不要补一条失败提示。
 *
 * @returns {{ok:boolean, pid:(number|null), error?:string}}
 */
export function spawnBrainSwitch({
  target,
  scriptPath,
  delaySec = 0,
  powershell = "",
  comspec = "",
  spawnImpl = spawn,
  logger = null,
} = {}) {
  try {
    if (target !== "brain" && target !== "lite") {
      return { ok: false, pid: null, error: `未知的切换目标：${target}` };
    }
    if (!scriptPath) {
      return { ok: false, pid: null, error: "切换脚本路径为空" };
    }

    const ps = powershell || defaultPowershell();
    const cmd = comspec || defaultComspec();

    const inner = [ps, "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath, "-Mode", target];
    if (delaySec > 0) inner.push("-DelaySec", String(delaySec));

    // start 的第一个引号参数会被当成"窗口标题"，必须显式给一个空的占位
    const args = ["/c", "start", "", "/b", ...inner.map(quoteForCmd)];

    const child = spawnImpl(cmd, args, {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      cwd: path.dirname(scriptPath),
    });
    if (child && typeof child.unref === "function") child.unref();

    logger?.info?.(
      `[brain-switch] 已分离启动切换脚本：-Mode ${target}（cmd pid=${child?.pid ?? "?"}）`,
    );
    return { ok: true, pid: child?.pid ?? null };
  } catch (err) {
    const msg = String(err?.message ?? err);
    logger?.error?.(`[brain-switch] 启动切换脚本失败：${msg}`);
    return { ok: false, pid: null, error: msg };
  }
}
