/**
 * 远程控制（src/core/remote.js）回归测试。
 *
 * 背景：这套能力是"任意命令执行"，最危险的一档，所以每一条边界都要钉死在测试里：
 * 四道门（仅私聊 / 白名单 / 口令 / 危险确认）、解析、裁剪、执行（含超时与不抛异常）。
 *
 * 组装约定：凡是涉及真实子进程的地方一律注入假 spawn，
 * 只有最后一组「真机冒烟」才会真的起 cmd.exe（只读命令，安全）。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

import {
  DEFAULT_MAX_OUTPUT,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_TTL_MS,
  clampOutput,
  createSessionStore,
  executeRemote,
  handleRemoteCommand,
  hashPassphrase,
  helpText,
  isDangerous,
  isRemoteCommand,
  makeConfirmCode,
  normalizePhrase,
  parseRemoteCommand,
  resolveRemoteConfig,
} from "../src/core/remote.js";

const ADMIN = "admin-openid";
const OTHER = "other-openid";

/** 收集日志行，方便断言审计输出 */
function collector() {
  const lines = [];
  const push = (m) => lines.push(String(m));
  return { lines, info: push, warn: push, error: push, debug: push };
}

/** 假 spawn：命令 → 结果由 plan 决定，永不真起进程 */
function fakeSpawn({ plan = {}, delayMs = 0 } = {}) {
  const calls = [];
  const impl = (exe, args, opts) => {
    const cmd = args[args.length - 1];
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.killed = false;
    let done = false;
    const finish = (code, out, errOut) => {
      if (done) return;
      done = true;
      if (out) child.stdout.emit("data", Buffer.from(out, "utf8"));
      if (errOut) child.stderr.emit("data", Buffer.from(errOut, "utf8"));
      child.emit("close", code);
    };
    child.kill = () => {
      child.killed = true;
      // 真实的子进程不会在 kill() 里同步抛 close（都是下一个事件循环），
      // 这里必须一样异步——否则会把"超时"的信息盖掉，测出假失败。
      setImmediate(() => finish(-1, ""));
    };
    const entry = plan[cmd] ?? {};
    calls.push({ exe, args, opts, cmd, child });
    const t = setTimeout(() => finish(entry.code ?? 0, entry.out ?? "", entry.err), entry.delayMs ?? delayMs);
    t.unref?.();
    return child;
  };
  impl.calls = calls;
  return impl;
}

const cfgOf = (env = {}) =>
  resolveRemoteConfig({
    REMOTE_ENABLED: "true",
    REMOTE_SHELL: "cmd",
    REMOTE_TIMEOUT_MS: "5000",
    ...env,
  });

// ───────────────────────── 配置 ─────────────────────────

test("配置：默认值是安全的（关闭、cmd、10 分钟、30 秒超时）", () => {
  const cfg = resolveRemoteConfig({});
  assert.equal(cfg.enabled, false, "默认必须是关闭的");
  assert.equal(cfg.shell, "cmd");
  assert.equal(cfg.ttlMs, DEFAULT_TTL_MS);
  assert.equal(cfg.timeoutMs, DEFAULT_TIMEOUT_MS);
  assert.equal(cfg.maxOutput, DEFAULT_MAX_OUTPUT);
  assert.equal(cfg.confirmTtlMs, 60000);
  assert.equal(cfg.unlockPhrase, "vibe coding");
  assert.equal(cfg.lockPhrase, "stop coding");
});

test("配置：环境变量可覆盖，且哈希只认 64 位十六进制", () => {
  const cfg = resolveRemoteConfig({
    REMOTE_ENABLED: "TRUE",
    REMOTE_SHELL: "PowerShell",
    REMOTE_TTL_MS: "1000",
    REMOTE_TIMEOUT_MS: "2000",
    REMOTE_MAX_OUTPUT: "10",
    REMOTE_UNLOCK_PHRASE: "  Open   Sesame ",
    REMOTE_PASS_HASH: "A".repeat(64),
  });
  assert.equal(cfg.enabled, true);
  assert.equal(cfg.shell, "powershell");
  assert.equal(cfg.ttlMs, 1000);
  assert.equal(cfg.timeoutMs, 2000);
  assert.equal(cfg.maxOutput, 10);
  assert.equal(cfg.unlockPhrase, "open sesame", "口令要归一化");
  assert.equal(cfg.passHash, "a".repeat(64), "哈希应小写化");

  assert.equal(resolveRemoteConfig({ REMOTE_PASS_HASH: "not-a-hash" }).passHash, "");
  assert.equal(resolveRemoteConfig({ REMOTE_PASS_HASH: "abc" }).passHash, "");
});

test("口令：normalizePhrase 小写化并折叠空白", () => {
  assert.equal(normalizePhrase("  Vibe   CODING \n"), "vibe coding");
  assert.equal(normalizePhrase(null), "");
  assert.equal(normalizePhrase(undefined), "");
  assert.equal(hashPassphrase("vibe coding").length, 64);
});

// ───────────────────────── 会话仓库 ─────────────────────────

test("会话：解锁/查询/上锁/剩余时间", () => {
  let now = 1000;
  const s = createSessionStore(() => now);
  assert.equal(s.isUnlocked(ADMIN), false);

  s.unlock(ADMIN, 60000);
  assert.equal(s.isUnlocked(ADMIN), true);
  assert.equal(s.remainingMs(ADMIN), 60000);

  now += 30000;
  assert.equal(s.remainingMs(ADMIN), 30000);

  now += 30001; // 过期
  assert.equal(s.isUnlocked(ADMIN), false);
  assert.equal(s.remainingMs(ADMIN), 0);

  s.unlock(ADMIN, 60000);
  s.lock(ADMIN);
  assert.equal(s.isUnlocked(ADMIN), false);
});

test("会话：解锁状态按 openid 隔离", () => {
  const s = createSessionStore();
  s.unlock(ADMIN, 60000);
  assert.equal(s.isUnlocked(ADMIN), true);
  assert.equal(s.isUnlocked(OTHER), false, "别人不该跟着一起解锁");
});

test("会话：确认码一次性、错码无效、过期失效", () => {
  let now = 5000;
  const s = createSessionStore(() => now);
  s.putConfirm(ADMIN, "shutdown /s", "123456", 60000);
  assert.equal(s.hasPendingConfirm(ADMIN), true);

  assert.equal(s.takeConfirm(ADMIN, "000000"), null, "错码不该通过");
  assert.equal(s.hasPendingConfirm(ADMIN), true, "错码不该消耗掉待确认项");

  assert.equal(s.takeConfirm(ADMIN, "123456"), "shutdown /s");
  assert.equal(s.takeConfirm(ADMIN, "123456"), null, "用过的码必须失效");
  assert.equal(s.hasPendingConfirm(ADMIN), false);

  s.putConfirm(ADMIN, "format c:", "654321", 60000);
  now += 60001;
  assert.equal(s.takeConfirm(ADMIN, "654321"), null, "过期的码必须失效");
  assert.equal(s.hasPendingConfirm(ADMIN), false);
});

// ───────────────────────── 解析 ─────────────────────────

test("判定：只有 / 开头的才算指令", () => {
  assert.equal(isRemoteCommand("/执行 ipconfig"), true);
  assert.equal(isRemoteCommand("/状态"), true);
  assert.equal(isRemoteCommand(" /状态"), true, "前面有空白也应识别（trim 后）");
  assert.equal(isRemoteCommand("vibe coding"), false);
  assert.equal(isRemoteCommand("帮我执行 ipconfig"), false);
  assert.equal(isRemoteCommand("/"), false, "光一个斜杠不算");
  assert.equal(isRemoteCommand(""), false);
});

test("判定：危险命令能认出来，日常命令不误伤", () => {
  for (const c of [
    "shutdown /s /t 0",
    "Restart-Computer",
    "Stop-Computer -Force",
    "format D: /q",
    "diskpart",
    "del /f /s /q C:\\tmp",
    "rd /s /q D:\\data",
    "rmdir /s C:\\x",
    "Remove-Item -Path C:\\x -Recurse -Force",
    "reg delete HKLM\\Software\\x /f",
    "bcdedit /set {default} safeboot minimal",
    "cipher /w:C",
    "taskkill /f /im chrome.exe",
  ]) {
    assert.equal(isDangerous(c), true, `应判为危险：${c}`);
  }
  for (const c of [
    "ipconfig",
    "Get-Date",
    "dir C:\\Users",
    "echo hello",
    "git status",
    "tasklist",
    "start chrome",
    "Get-ChildItem -Recurse -Depth 2", // 递归但不删
  ]) {
    assert.equal(isDangerous(c), false, `不应判为危险：${c}`);
  }
});

test("解析：中英文指令别名都认识", () => {
  assert.deepEqual(parseRemoteCommand("/执行 ipconfig"), { kind: "run", arg: "ipconfig" });
  assert.deepEqual(parseRemoteCommand("/run ipconfig"), { kind: "run", arg: "ipconfig" });
  assert.deepEqual(parseRemoteCommand("/sh Get-Date"), { kind: "run", arg: "Get-Date" });
  assert.deepEqual(parseRemoteCommand("/cmd dir"), { kind: "run", arg: "dir" });
  assert.deepEqual(parseRemoteCommand("/确认 123456"), { kind: "confirm", arg: "123456" });
  assert.deepEqual(parseRemoteCommand("/解锁 vibe coding"), { kind: "unlock", arg: "vibe coding" });
  assert.deepEqual(parseRemoteCommand("/锁定"), { kind: "lock", arg: "" });
  assert.deepEqual(parseRemoteCommand("/状态"), { kind: "status", arg: "" });
  assert.deepEqual(parseRemoteCommand("/帮助"), { kind: "help", arg: "" });
  assert.equal(parseRemoteCommand("/不存在").kind, "unknown");
  assert.equal(parseRemoteCommand("随便聊聊").kind, "unknown");
});

test("裁剪：超长输出被截断并标记", () => {
  const short = clampOutput("hello", 100);
  assert.deepEqual(short, { text: "hello", truncated: false });

  const long = clampOutput("x".repeat(50), 10);
  assert.equal(long.text.length, 10);
  assert.equal(long.truncated, true);

  const withNul = clampOutput("a\u0000b", 100);
  assert.equal(withNul.text, "ab", "控制字符要清掉");
});

test("确认码：6 位数字，取模不越界", () => {
  for (const buf of [Buffer.from([0, 0, 0, 0]), Buffer.from([0xff, 0xff, 0xff, 0xff])]) {
    const code = makeConfirmCode(() => buf);
    assert.match(code, /^\d{6}$/);
  }
  assert.match(makeConfirmCode(), /^\d{6}$/);
});

test("帮助文本：列出关键指令与当前 shell", () => {
  const text = helpText(cfgOf());
  assert.match(text, /\/执行/);
  assert.match(text, /\/确认/);
  assert.match(text, /vibe coding/);
  assert.match(text, /shell=cmd/);
  // 自然语言 agent 是本档能力的一部分，帮助里要说一声，否则主人根本不知道能这么说
  assert.match(text, /说人话|直接说|自然语言/);
  assert.match(helpText(resolveRemoteConfig({ REMOTE_AGENT_ENABLED: "false" })), /shell=cmd/);
  assert.doesNotMatch(helpText(resolveRemoteConfig({ REMOTE_AGENT_ENABLED: "false" })), /最多连跑/);
});

// ───────────────────────── 执行 ─────────────────────────

test("执行：spawn 用数组形式，命令整体作为单个 argv 元素", async () => {
  const spawn = fakeSpawn({ plan: { "echo hi": { out: "hi\n" } } });
  const res = await executeRemote("echo hi", cfgOf(), { spawn });
  assert.equal(res.ok, true);
  assert.equal(res.code, 0);
  assert.equal(res.output, "hi\n");
  assert.equal(spawn.calls.length, 1);
  assert.equal(spawn.calls[0].exe, "cmd.exe");
  assert.deepEqual(spawn.calls[0].args.slice(0, 3), ["/d", "/s", "/c"]);
  assert.equal(spawn.calls[0].args.length, 4);
  assert.equal(spawn.calls[0].args[3], "echo hi", "整条命令只占一个参数，不做 JS 侧拼接");
});

test("执行：powershell 时换成 powershell.exe -Command", async () => {
  const spawn = fakeSpawn();
  await executeRemote("Get-Date", cfgOf({ REMOTE_SHELL: "powershell" }), { spawn });
  assert.equal(spawn.calls[0].exe, "powershell.exe");
  assert.deepEqual(spawn.calls[0].args.slice(0, 3), ["-NoProfile", "-NonInteractive", "-Command"]);
});

test("执行：stdout 与 stderr 合并返回（git/ffmpeg 常把信息写 stderr）", async () => {
  const spawn = fakeSpawn({ plan: { boom: { out: "out-part\n", err: "err-part\n", code: 1 } } });
  const res = await executeRemote("boom", cfgOf(), { spawn });
  assert.equal(res.ok, false, "非零退出必须 ok:false");
  assert.equal(res.code, 1);
  assert.match(res.output, /out-part/);
  assert.match(res.output, /err-part/);
});

test("执行：空命令直接拒绝，不起进程", async () => {
  const spawn = fakeSpawn();
  const res = await executeRemote("   ", cfgOf(), { spawn });
  assert.equal(res.ok, false);
  assert.equal(spawn.calls.length, 0);
});

test("执行：超时会杀进程并如实标记 timedOut", async () => {
  const spawn = fakeSpawn({ delayMs: 60000 });
  const res = await executeRemote("Get-ChildItem C:\\ -Recurse", cfgOf({ REMOTE_TIMEOUT_MS: "50" }), { spawn });
  assert.equal(res.ok, false);
  assert.equal(res.timedOut, true);
  assert.equal(spawn.calls[0].child.killed, true, "超时必须尝试杀掉子进程");
});

test("执行：启动失败/子进程 error 都不抛出，只降级成文字", async () => {
  const throwSpawn = () => {
    throw new Error("EPERM 不给起进程");
  };
  const r1 = await executeRemote("whoami", cfgOf(), { spawn: throwSpawn });
  assert.equal(r1.ok, false);
  assert.match(r1.output, /EPERM/);

  const spawn = fakeSpawn();
  const r2Promise = executeRemote("whoami", cfgOf(), { spawn });
  spawn.calls[0].child.emit("error", new Error("spawn ENOENT"));
  const r2 = await r2Promise;
  assert.equal(r2.ok, false);
  assert.match(r2.output, /ENOENT/);
});

test("执行（真机冒烟）：cmd 里跑一条只读命令", async () => {
  const res = await executeRemote("echo chunhe-ok", cfgOf({ REMOTE_TIMEOUT_MS: "20000" }));
  assert.equal(res.ok, true, `真实执行失败：${res.output}`);
  assert.match(res.output, /chunhe-ok/);
});

// ───────────────────────── 指令总入口：四道门 ─────────────────────────

test("门①：群聊里的指令一律拒绝", async () => {
  const log = collector();
  const r = await handleRemoteCommand({
    text: "/执行 ipconfig",
    openid: ADMIN,
    isC2C: false,
    admins: [ADMIN],
    cfg: cfgOf({ REMOTE_PASS_HASH: hashPassphrase("x") }),
    sessions: createSessionStore(),
    deps: { logger: log, spawn: fakeSpawn() },
  });
  assert.equal(r.handled, true);
  assert.match(r.reply, /只在私聊/);
  assert.ok(log.lines.some((l) => /拒绝群聊指令/.test(l)), "必须留下拒绝日志");
});

test("门②：非管理员静默丢弃（不回细节、不执行）", async () => {
  const spawn = fakeSpawn();
  const r = await handleRemoteCommand({
    text: "/执行 ipconfig",
    openid: OTHER,
    isC2C: true,
    admins: [ADMIN],
    cfg: cfgOf(),
    sessions: createSessionStore(),
    deps: { spawn },
  });
  assert.equal(r.handled, false);
  assert.equal(r.reply, "");
  assert.equal(spawn.calls.length, 0);
});

test("非指令：交回人格模型（handled:false），未启用时也不接管", async () => {
  const r = await handleRemoteCommand({
    text: "今天天气不错",
    openid: ADMIN,
    isC2C: true,
    admins: [ADMIN],
    cfg: cfgOf(),
    sessions: createSessionStore(),
    deps: { spawn: fakeSpawn() },
  });
  assert.equal(r.handled, false);

  const off = await handleRemoteCommand({
    text: "/执行 ipconfig",
    openid: ADMIN,
    isC2C: true,
    admins: [ADMIN],
    cfg: cfgOf({ REMOTE_ENABLED: "false" }),
    sessions: createSessionStore(),
    deps: { spawn: fakeSpawn() },
  });
  assert.equal(off.handled, false, "未启用时连指令都不接管");
});

test("门③：口令必须整句匹配，聊天里顺口提到不解锁", async () => {
  const sessions = createSessionStore();
  const cfg = cfgOf();
  const say = (text) =>
    handleRemoteCommand({
      text,
      openid: ADMIN,
      isC2C: true,
      admins: [ADMIN],
      cfg,
      sessions,
      deps: { spawn: fakeSpawn() },
    });

  const partial = await say("我今天想 vibe coding 一下");
  assert.equal(partial.handled, false, "包含匹配不算命中");
  assert.equal(sessions.isUnlocked(ADMIN), false);

  const unlock = await say("Vibe   Coding");
  assert.equal(unlock.handled, true);
  assert.match(unlock.reply, /全权限模式已开启/);
  assert.equal(sessions.isUnlocked(ADMIN), true, "大小写与空白差异不该影响口令");

  const lock = await say("stop coding");
  assert.match(lock.reply, /已关闭/);
  assert.equal(sessions.isUnlocked(ADMIN), false);

  // /解锁 走的是另一个入口，口令不对要拒绝
  const bad = await say("/解锁 猜一个");
  assert.match(bad.reply, /口令不对/);
  assert.equal(sessions.isUnlocked(ADMIN), false);

  const good = await say("/解锁 vibe coding");
  assert.match(good.reply, /已解锁/);
  assert.equal(sessions.isUnlocked(ADMIN), true);
});

test("/状态 与 /锁定：如实反映解锁情况", async () => {
  const sessions = createSessionStore();
  const cfg = cfgOf();
  const say = (text) =>
    handleRemoteCommand({ text, openid: ADMIN, isC2C: true, admins: [ADMIN], cfg, sessions, deps: { spawn: fakeSpawn() } });

  assert.match((await say("/状态")).reply, /未开启/);
  await say("vibe coding");
  assert.match((await say("/状态")).reply, /剩余 \d+ 分钟/);
  assert.match((await say("/锁定")).reply, /已上锁/);
  assert.equal(sessions.isUnlocked(ADMIN), false);
});

test("/执行：未解锁拒绝；解锁后执行并回结果", async () => {
  const sessions = createSessionStore();
  const spawn = fakeSpawn({ plan: { ipconfig: { out: "IPv4: 192.168.1.5\n" } } });
  const cfg = cfgOf();
  const say = (text) =>
    handleRemoteCommand({ text, openid: ADMIN, isC2C: true, admins: [ADMIN], cfg, sessions, deps: { spawn } });

  const locked = await say("/执行 ipconfig");
  assert.match(locked.reply, /未解锁/);
  assert.equal(spawn.calls.length, 0);

  sessions.unlock(ADMIN, 60000);
  const run = await say("/执行 ipconfig");
  assert.match(run.reply, /执行完成/);
  assert.match(run.reply, /192\.168\.1\.5/);
  assert.equal(spawn.calls.length, 1);
  assert.equal(await say("/执行").then((r) => r.reply), "用法：/执行 <命令>");
});

test("门④：危险命令先要确认码，确认后才执行那一条", async () => {
  const log = collector();
  const sessions = createSessionStore();
  const spawn = fakeSpawn({ plan: { "shutdown /s": { out: "would-poweroff\n" } } });
  const cfg = cfgOf();
  const deps = { spawn, logger: log, rand: () => Buffer.from([0, 0, 0x30, 0x39]) }; // 12345
  const say = (text) =>
    handleRemoteCommand({ text, openid: ADMIN, isC2C: true, admins: [ADMIN], cfg, sessions, deps });

  sessions.unlock(ADMIN, 60000);
  const pending = await say("/执行 shutdown /s");
  assert.equal(pending.handled, true);
  assert.match(pending.reply, /需要确认/);
  assert.match(pending.reply, /\/确认 \d{6}/);
  assert.equal(spawn.calls.length, 0, "危险命令绝不能直接执行");
  assert.equal(sessions.hasPendingConfirm(ADMIN), true);

  const code = /\/确认 (\d{6})/.exec(pending.reply)[1];
  const wrong = await say("/确认 000000");
  assert.match(wrong.reply, /没有待确认的操作/);
  assert.equal(spawn.calls.length, 0);

  const confirmed = await say(`/确认 ${code}`);
  assert.match(confirmed.reply, /执行完成/);
  assert.match(confirmed.reply, /would-poweroff/);
  assert.equal(spawn.calls.length, 1, "确认后只执行那一条");
  assert.equal(await say(`/确认 ${code}`).then((r) => r.reply), "没有待确认的操作，或确认码不对/已过期。");
});

test("永不抛出：spawn 抛异常时指令入口仍返回人话", async () => {
  const sessions = createSessionStore();
  sessions.unlock(ADMIN, 60000);
  const r = await handleRemoteCommand({
    text: "/执行 whoami",
    openid: ADMIN,
    isC2C: true,
    admins: [ADMIN],
    cfg: cfgOf(),
    sessions,
    deps: {
      spawn: () => {
        throw new Error("权限不足");
      },
    },
  });
  assert.equal(r.handled, true);
  assert.match(r.reply, /权限不足/);
});

test("未知指令：给出 /帮助 提示而不是静默", async () => {
  const r = await handleRemoteCommand({
    text: "/乱写的指令",
    openid: ADMIN,
    isC2C: true,
    admins: [ADMIN],
    cfg: cfgOf(),
    sessions: createSessionStore(),
    deps: { spawn: fakeSpawn() },
  });
  assert.equal(r.handled, true);
  assert.match(r.reply, /未知指令/);
  assert.match(r.reply, /\/帮助/);
});
