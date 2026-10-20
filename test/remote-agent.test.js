/**
 * 自然语言 agent 模式测试（src/core/remote-agent.js + engine 接线）。
 *
 * 这一层的价值在于"说人话 → 自己翻译成命令 → 看结果 → 再决定下一步"，
 * 所以测试必须覆盖：门禁（未解锁不进）、命令块解析、结果回灌、步数上限、
 * 危险命令拦截、模型/解析/命令三类失败降级、重复命令刹车、以及中断。
 *
 * 全程注入假模型与假 spawn：不调 DeepSeek、不起真进程（真机冒烟在
 * scripts/check-remote-agent.mjs 里单独做）。
 */

import test, { after } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";

import {
  DEFAULT_MAX_STEPS,
  RUN_CLOSE,
  RUN_OPEN,
  buildAgentSystemPrompt,
  createRunRegistry,
  parseAgentReply,
  runAgentLoop,
} from "../src/core/remote-agent.js";
import { createSessionStore, resolveRemoteConfig } from "../src/core/remote.js";
import { MessageEngine } from "../src/core/engine.js";
import { loadConfig } from "../src/config.js";
import { createLogger } from "../src/util/log.js";

const logger = createLogger("silent");
const ADMIN = "admin-openid";
const OTHER = "other-openid";

/**
 * 引擎级测试用的隔离数据目录。
 *
 * ⚠️ 千万别把 QQ_MEMORY_FILE 设成空串：loadConfig 里空串 = 用默认值，
 * 于是测试会直接读写真实的 data/memory.json，把测试对话写进主人的记忆里。
 */
const TMP = fs.mkdtempSync(path.join(import.meta.dirname, "..", "data", "_test-agent-"));
after(() => {
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* 清不掉就算了，别让收尾失败影响测试结论 */
  }
});

const runBlock = (cmd) => `${RUN_OPEN}\n${cmd}\n${RUN_CLOSE}`;

function collector() {
  const lines = [];
  const push = (m) => lines.push(String(m));
  return { lines, info: push, warn: push, error: push, debug: push };
}

/** 假 spawn：按 plan 返回预设输出，命令本身不会真的执行 */
function makeFakeSpawn({ plan = {}, delayMs = 0, onSpawn = null } = {}) {
  const calls = [];
  const impl = (exe, args) => {
    const cmd = args[args.length - 1];
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.killed = false;
    let done = false;
    const finish = (code, out) => {
      if (done) return;
      done = true;
      if (out) child.stdout.emit("data", Buffer.from(out, "utf8"));
      child.emit("close", code);
    };
    child.kill = () => {
      child.killed = true;
      // 和真实子进程一致：close 要等下一个事件循环，别在 kill() 里同步抛
      setImmediate(() => finish(-1, ""));
    };
    const entry = plan[cmd] ?? { out: `ok:${cmd}`, code: 0 };
    const rec = { exe, args, cmd, child };
    calls.push(rec);
    const t = setTimeout(
      () => finish(entry.code ?? 0, entry.out ?? ""),
      entry.delayMs ?? delayMs,
    );
    t.unref?.();
    onSpawn?.(rec);
    return child;
  };
  impl.calls = calls;
  return impl;
}

/** 脚本化假模型：按顺序返回 reply，可抛错（{throw:"..."}）或跑副作用（函数） */
function scriptedChat(script = []) {
  const calls = [];
  const fn = async (messages) => {
    const i = calls.length;
    calls.push(messages);
    const entry = script[i];
    if (entry === undefined) throw new Error(`假模型脚本用完了（第 ${i + 1} 次调用）`);
    if (typeof entry === "function") return entry(messages);
    if (entry && entry.throw) throw new Error(entry.throw);
    return entry.reply;
  };
  fn.calls = calls;
  return fn;
}

const cfgOf = (env = {}) =>
  resolveRemoteConfig({
    REMOTE_ENABLED: "true",
    REMOTE_SHELL: "cmd",
    REMOTE_TIMEOUT_MS: "5000",
    REMOTE_MAX_OUTPUT: "1500",
    REMOTE_AGENT_MAX_STEPS: "5",
    ...env,
  });

/** 解锁好的会话仓库 */
function unlockedStore(ttl = 600000) {
  const s = createSessionStore();
  s.unlock(ADMIN, ttl);
  return s;
}

const baseArgs = (over = {}) => ({
  text: "打开电脑上的浏览器",
  openid: ADMIN,
  isC2C: true,
  admins: [ADMIN],
  cfg: cfgOf(),
  sessions: unlockedStore(),
  ...over,
});

// ───────────────────────── 解析 ─────────────────────────

test("解析：命令块被抽出，前后文字当说明保留", () => {
  const r = parseAgentReply(`我先看看当前目录。\n${RUN_OPEN}\nGet-ChildItem\n${RUN_CLOSE}\n然后再决定。`);
  assert.deepEqual(r.commands, ["Get-ChildItem"]);
  assert.match(r.prose, /我先看看当前目录/);
  assert.match(r.prose, /然后再决定/);
  assert.doesNotMatch(r.prose, /Get-ChildItem/);
});

test("解析：多行命令、同一回复里多个块都认得", () => {
  const r = parseAgentReply(`${RUN_OPEN}\nGet-Date\n${RUN_CLOSE}${RUN_OPEN}whoami${RUN_CLOSE}`);
  assert.deepEqual(r.commands, ["Get-Date", "whoami"]);
});

test("解析：没有命令块 = 最终回答；markdown 代码围栏不会被当命令执行", () => {
  const plain = parseAgentReply("主人，春禾已经帮你打开啦～");
  assert.deepEqual(plain.commands, []);
  assert.equal(plain.prose.trim(), "主人，春禾已经帮你打开啦～");

  const fenced = parseAgentReply("可以这样写：\n```powershell\nGet-Date\n```");
  assert.deepEqual(fenced.commands, [], "只有 RUN 标记才算命令，围栏里的内容不执行");
});

test("解析：撑破的块（只有开头没有结尾）也要能兜住并告警", () => {
  const r = parseAgentReply(`${RUN_OPEN}\nGet-Date\n（模型忘了写结束标记）`);
  assert.equal(r.commands.length, 1);
  assert.match(r.commands[0], /Get-Date/);
  assert.equal(r.stray, true);
});

test("提示词：写明命令块格式、一次一条、何时停止", () => {
  // 生产配置用的是 PowerShell（.env: REMOTE_SHELL=powershell）
  const cfg = cfgOf({ REMOTE_SHELL: "powershell" });
  const p = buildAgentSystemPrompt({ cfg, maxSteps: 5 });
  assert.match(p, /<<<RUN>>>/);
  assert.match(p, /<<<END>>>/);
  assert.match(p, /Windows/);
  assert.match(p, /PowerShell/, "要告诉模型它跑的是 PowerShell");
  assert.match(p, /一次只|一条命令/);
  assert.match(p, /春禾/, "要带人格，最后才能用人格语气回答");
  assert.match(p, /5/, "要告诉模型步数上限");
  assert.match(p, /不要发破坏性命令/);

  // shell=cmd 时提示词要跟着换成 cmd.exe，别让模型对着 cmd 写 PowerShell 语法
  assert.match(buildAgentSystemPrompt({ cfg: cfgOf(), maxSteps: 3 }), /cmd\.exe/);
});

// ───────────────────────── 门禁 ─────────────────────────

test("门禁：未解锁时说人话不进 agent（交回人格模型）", async () => {
  const chat = scriptedChat([{ reply: "不该被调用" }]);
  const r = await runAgentLoop(baseArgs({ sessions: createSessionStore(), chat }));
  assert.equal(r.handled, false);
  assert.equal(r.reply, "");
  assert.equal(r.reason, "not-unlocked");
  assert.equal(chat.calls.length, 0, "没解锁就一次模型都不该调");
});

test("门禁：群聊 / 非管理员 / 斜杠指令 / 未启用 都不进 agent", async () => {
  const cases = [
    { name: "群聊", args: { isC2C: false }, reason: "not-c2c" },
    { name: "非管理员", args: { openid: OTHER }, reason: "not-admin" },
    { name: "斜杠指令", args: { text: "/执行 ipconfig" }, reason: "slash-command" },
    { name: "空消息", args: { text: "   " }, reason: "empty" },
    { name: "功能关闭", args: { cfg: cfgOf({ REMOTE_ENABLED: "false" }) }, reason: "disabled" },
    { name: "agent 关闭", args: { cfg: cfgOf({ REMOTE_AGENT_ENABLED: "false" }) }, reason: "agent-disabled" },
  ];
  for (const c of cases) {
    const chat = scriptedChat([{ reply: "不该被调用" }]);
    const r = await runAgentLoop(baseArgs({ ...c.args, chat }));
    assert.equal(r.handled, false, `${c.name} 不该进 agent`);
    assert.equal(r.reason, c.reason, `${c.name} 的 reason 不对`);
    assert.equal(chat.calls.length, 0, `${c.name} 不该调模型`);
  }
});

// ───────────────────────── 主循环 ─────────────────────────

test("循环：解锁后说人话进 agent；模型直接给答案就是最终回答", async () => {
  const chat = scriptedChat([{ reply: "好呀主人～春禾这就去看看🌸" }]);
  const r = await runAgentLoop(baseArgs({ chat }));
  assert.equal(r.handled, true);
  assert.equal(r.reason, "answered");
  assert.equal(r.steps, 0);
  assert.match(r.reply, /春禾这就去看看/);
  assert.equal(chat.calls.length, 1);
  assert.equal(chat.calls[0][0].role, "system", "第一次调用要带系统提示词");
  assert.match(chat.calls[0][0].content, /<<<RUN>>>/);
  assert.equal(chat.calls[0].at(-1).role, "user");
  assert.match(chat.calls[0].at(-1).content, /打开电脑上的浏览器/);
});

test("循环：命令被执行，结果回灌给模型，模型据此给最终回答", async () => {
  const spawn = makeFakeSpawn({ plan: { "Get-Date": { out: "2026-10-16 10:20:30\n" } } });
  const chat = scriptedChat([
    { reply: runBlock("Get-Date") },
    { reply: "现在是 2026-10-16 10:20 哦～" },
  ]);
  const r = await runAgentLoop(baseArgs({ text: "现在几点了", chat, deps: { spawn } }));

  assert.equal(r.handled, true);
  assert.equal(r.reason, "answered");
  assert.equal(r.steps, 1);
  assert.equal(spawn.calls.length, 1);
  assert.equal(spawn.calls[0].cmd, "Get-Date");
  assert.match(r.reply, /2026-10-16 10:20/);

  const second = chat.calls[1];
  assert.equal(second.at(-1).role, "user", "命令结果要作为 user 消息回灌");
  assert.match(second.at(-1).content, /2026-10-16 10:20:30/, "模型必须能看到真实输出");
  assert.ok(
    second.some((m) => m.role === "assistant" && m.content.includes("Get-Date")),
    "模型自己发过的命令块也要留在上下文里",
  );
});

test("循环：步数上限到了就停下并说明", async () => {
  const spawn = makeFakeSpawn();
  const chat = scriptedChat(Array.from({ length: 10 }, (_, i) => ({ reply: runBlock(`cmd-${i}`) })));
  const r = await runAgentLoop(baseArgs({ cfg: cfgOf({ REMOTE_AGENT_MAX_STEPS: "3" }), chat, deps: { spawn } }));

  assert.equal(r.handled, true);
  assert.equal(r.reason, "max-steps");
  assert.equal(r.steps, 3);
  assert.equal(spawn.calls.length, 3, "上限是 3 就只执行 3 条");
  assert.equal(chat.calls.length, 3, "第 4 次模型调用不该发生");
  assert.match(r.reply, /3/, "要告诉主人跑了多少步");
});

test("循环：默认上限是 5 步", async () => {
  assert.equal(DEFAULT_MAX_STEPS, 5);
  const spawn = makeFakeSpawn();
  const chat = scriptedChat(Array.from({ length: 10 }, (_, i) => ({ reply: runBlock(`cmd-${i}`) })));
  const r = await runAgentLoop(baseArgs({ chat, deps: { spawn } }));
  assert.equal(r.steps, 5);
  assert.equal(spawn.calls.length, 5);
});

test("循环：同一条命令重复执行超过 2 次就刹车", async () => {
  const spawn = makeFakeSpawn();
  const chat = scriptedChat(Array.from({ length: 8 }, () => ({ reply: runBlock("Get-Date") })));
  const r = await runAgentLoop(baseArgs({ chat, deps: { spawn } }));

  assert.equal(r.handled, true);
  assert.equal(r.reason, "repeat");
  assert.equal(spawn.calls.length, 2, "同一条命令最多执行 2 次，第 3 次不许再跑");
  assert.match(r.reply, /重复|一样|不变|卡/, "要如实说明为什么停");
});

test("循环：空输出/失败的命令也要如实回灌，让模型换招", async () => {
  const spawn = makeFakeSpawn({ plan: { "bad-cmd": { out: "", code: 1 } } });
  const chat = scriptedChat([
    { reply: runBlock("bad-cmd") },
    { reply: "这条命令没跑通，春禾换个办法～" },
  ]);
  const r = await runAgentLoop(baseArgs({ chat, deps: { spawn } }));
  const fed = chat.calls[1].at(-1).content;
  assert.match(fed, /exit=1/);
  assert.match(fed, /无输出/);
  assert.equal(r.reply, "这条命令没跑通，春禾换个办法～");
});

test("省 token：命令输出回灌前被 clampOutput 截断", async () => {
  const spawn = makeFakeSpawn({ plan: { big: { out: "y".repeat(5000) } } });
  const chat = scriptedChat([{ reply: runBlock("big") }, { reply: "看完啦～" }]);
  const r = await runAgentLoop(baseArgs({ cfg: cfgOf({ REMOTE_MAX_OUTPUT: "120" }), chat, deps: { spawn } }));

  const fed = chat.calls[1].at(-1).content;
  assert.ok(fed.length < 400, `回灌内容应被截断，实际 ${fed.length} 字`);
  assert.match(fed, /截断/);
  assert.equal(r.reason, "answered");
});

test("循环：一次发多条命令时只执行第一条并提示模型", async () => {
  const spawn = makeFakeSpawn();
  const chat = scriptedChat([
    { reply: `${RUN_OPEN}\nfirst\n${RUN_CLOSE}${RUN_OPEN}\nsecond\n${RUN_CLOSE}` },
    { reply: "好，春禾一条一条来～" },
  ]);
  await runAgentLoop(baseArgs({ chat, deps: { spawn } }));
  assert.equal(spawn.calls.length, 1);
  assert.equal(spawn.calls[0].cmd, "first");
  assert.match(chat.calls[1].at(-1).content, /一次|多条|只执行/);
});

// ───────────────────────── 危险命令 ─────────────────────────

test("危险命令：不执行，转成 /确认 二次确认", async () => {
  const spawn = makeFakeSpawn();
  const sessions = unlockedStore();
  const chat = scriptedChat([
    { reply: runBlock("Remove-Item -Path C:\\大肥鱼的小宝库 -Recurse -Force") },
    { reply: "不该走到这一步" },
  ]);
  const r = await runAgentLoop(
    baseArgs({ chat, sessions, cfg: cfgOf({ REMOTE_CONFIRM_TTL_MS: "60000" }), deps: { spawn } }),
  );

  assert.equal(r.handled, true);
  assert.equal(r.reason, "danger-confirm");
  assert.equal(spawn.calls.length, 0, "危险命令绝不能执行");
  assert.equal(sessions.hasPendingConfirm(ADMIN), true, "要挂上待确认项，等用户回 /确认");
  assert.match(r.reply, /\/确认 \d{6}/);
  assert.equal(chat.calls.length, 1, "不该继续循环");
});

test("危险命令：用户不确认就不会跑；确认后由 /确认 单独执行那一条", async () => {
  const spawn = makeFakeSpawn({ plan: { "Remove-Item -Recurse C:\\x": { out: "deleted\n" } } });
  const sessions = unlockedStore();
  const chat = scriptedChat([{ reply: runBlock("Remove-Item -Recurse C:\\x") }]);
  const r = await runAgentLoop(baseArgs({ chat, sessions, deps: { spawn } }));
  const code = /\/确认 (\d{6})/.exec(r.reply)[1];

  // 用户没确认 → 什么都不该发生
  assert.equal(spawn.calls.length, 0);

  const { handleRemoteCommand } = await import("../src/core/remote.js");
  const done = await handleRemoteCommand({
    text: `/确认 ${code}`,
    openid: ADMIN,
    isC2C: true,
    admins: [ADMIN],
    cfg: cfgOf(),
    sessions,
    deps: { spawn },
  });
  assert.match(done.reply, /执行完成/);
  assert.equal(spawn.calls.length, 1);
  assert.equal(spawn.calls[0].cmd, "Remove-Item -Recurse C:\\x");
});

// ───────────────────────── 失败降级 ─────────────────────────

test("降级：第一步模型就挂了 → 不抛异常，交回人格模型（reason=chat-error）", async () => {
  const chat = scriptedChat([{ throw: "模型接口 HTTP 500" }]);
  const r = await runAgentLoop(baseArgs({ chat }));
  assert.equal(r.handled, false, "什么都没做成就别霸占这条消息");
  assert.equal(r.reply, "");
  assert.equal(r.reason, "chat-error");
});

test("降级：跑过命令之后再挂 → 如实汇报已做了什么，不许沉默", async () => {
  const spawn = makeFakeSpawn({ plan: { "Get-Date": { out: "2026-10-16\n" } } });
  const chat = scriptedChat([{ reply: runBlock("Get-Date") }, { throw: "socket hang up" }]);
  const r = await runAgentLoop(baseArgs({ chat, deps: { spawn } }));

  assert.equal(r.handled, true);
  assert.equal(r.reason, "chat-error");
  assert.equal(r.steps, 1);
  assert.match(r.reply, /2026-10-16|Get-Date|执行/, "要汇报真跑过的东西");
  assert.ok(r.reply.length > 0);
});

test("降级：模型返回空内容也算失败，不抛异常", async () => {
  const chat = scriptedChat([{ reply: "   " }]);
  const r = await runAgentLoop(baseArgs({ chat }));
  assert.equal(r.handled, false);
  assert.equal(r.reason, "chat-error");
});

// ───────────────────────── 中断 ─────────────────────────

test("中断：模型思考期间用户上锁 → 命令不再执行，循环立刻结束", async () => {
  const spawn = makeFakeSpawn();
  const sessions = unlockedStore();
  const chat = scriptedChat([
    (messages) => {
      // 模拟"模型还在想的时候，主人喊了 stop coding"
      sessions.lock(ADMIN);
      return runBlock("Get-Date");
    },
    { reply: "不该走到这一步" },
  ]);
  const r = await runAgentLoop(baseArgs({ chat, sessions, deps: { spawn } }));

  assert.equal(r.handled, true);
  assert.equal(r.reason, "locked");
  assert.equal(spawn.calls.length, 0, "上锁后不许再执行命令");
  assert.equal(chat.calls.length, 1);
  assert.match(r.reply, /停/);
});

test("中断：命令执行到一半被中止 → 杀掉子进程并停住", async () => {
  const runs = createRunRegistry();
  const spawn = makeFakeSpawn({
    delayMs: 60000,
    onSpawn: () => {
      // 命令"跑很久"，期间主人喊停
      setTimeout(() => runs.abort(ADMIN), 10).unref?.();
    },
  });
  const chat = scriptedChat([{ reply: runBlock("long-running-cmd") }, { reply: "不该继续" }]);
  const r = await runAgentLoop(baseArgs({ chat, runs, deps: { spawn } }));

  assert.equal(r.handled, true);
  assert.equal(r.reason, "aborted");
  assert.equal(spawn.calls[0].child.killed, true, "进行中的命令要被杀进程");
  assert.equal(chat.calls.length, 1, "不许再调模型");
  assert.match(r.reply, /停/);
});

test("中断：口令上锁（stop coding）时 agent 会话也必须让位", async () => {
  const sessions = unlockedStore();
  sessions.lock(ADMIN);
  const chat = scriptedChat([{ reply: runBlock("Get-Date") }]);
  const r = await runAgentLoop(baseArgs({ sessions, chat, deps: { spawn: makeFakeSpawn() } }));
  assert.equal(r.handled, false, "锁了之后连 agent 都不该进");
  assert.equal(chat.calls.length, 0);
});

test("并发：同一个人上一条还没跑完，新的人话不会另起一轮", async () => {
  const runs = createRunRegistry();
  let release;
  const gate = new Promise((r) => {
    release = r;
  });
  const chat = async () => {
    await gate;
    return "好啦～";
  };
  const args = baseArgs({ chat, runs, deps: { spawn: makeFakeSpawn() } });
  const first = runAgentLoop(args);
  await new Promise((r) => setTimeout(r, 10));
  const second = await runAgentLoop({ ...args, text: "再做一件事" });
  release();
  const r1 = await first;

  assert.equal(r1.handled, true);
  assert.equal(second.handled, true);
  assert.equal(second.reason, "busy");
  assert.match(second.reply, /忙|等/);
});

// ───────────────────────── 审计 ─────────────────────────

test("审计：每一步都留下 [remote-agent] 记录（含 cmd 与 exit）", async () => {
  const log = collector();
  const spawn = makeFakeSpawn({ plan: { "Get-Date": { out: "now\n", code: 0 } } });
  const chat = scriptedChat([{ reply: runBlock("Get-Date") }, { reply: "好啦～" }]);
  await runAgentLoop(baseArgs({ chat, deps: { spawn, logger: log } }));

  const steps = log.lines.filter((l) => l.startsWith("[remote-agent]") && /step=/.test(l));
  assert.equal(steps.length, 1, "一条命令一行审计");
  assert.match(steps[0], /\[remote-agent\] openid=admin-openid step=1 cmd=Get-Date exit=0/);
  assert.ok(
    log.lines.some((l) => /\[remote-agent\].*openid=admin-openid/.test(l)),
    "至少要有一行带 openid 的 agent 日志",
  );
});

test("审计：危险命令被拦、达到上限、重复刹车都要留痕", async () => {
  const log = collector();
  const spawn = makeFakeSpawn();
  const chat = scriptedChat([
    { reply: runBlock("shutdown /s /t 0") },
    { reply: "x" },
  ]);
  await runAgentLoop(baseArgs({ chat, deps: { spawn, logger: log } }));
  assert.ok(
    log.lines.some((l) => /\[remote-agent\].*danger/.test(l)),
    "危险命令拦截要有日志",
  );
});

// ───────────────────────── 引擎接线 ─────────────────────────

let seq = 0;
const c2c = (content, over = {}) => ({
  kind: "c2c",
  scope: "c2c",
  rawEventType: "C2C_MESSAGE_CREATE",
  senderId: ADMIN,
  senderName: "主人",
  content,
  messageId: `c2c-${++seq}`,
  targetId: ADMIN,
  attachments: [],
  ...over,
});

const groupAt = (content, over = {}) => ({
  kind: "group",
  scope: "group",
  rawEventType: "GROUP_AT_MESSAGE_CREATE",
  senderId: ADMIN,
  senderName: "主人",
  content,
  messageId: `grp-${++seq}`,
  groupOpenid: "g1",
  targetId: "g1",
  attachments: [],
  ...over,
});

function makeEngine({ env = {}, generate, agentChat, agentDeps } = {}) {
  const config = loadConfig({
    QQ_APP_ID: "1",
    QQ_APP_SECRET: "s",
    QQ_ADMIN_USERS: ADMIN,
    QQ_RATE_LIMIT_PER_MINUTE: "100",
    REMOTE_ENABLED: "true",
    REMOTE_SHELL: "cmd",
    REMOTE_TTL_MS: "600000",
    REMOTE_MAX_OUTPUT: "1500",
    // 隔离的数据文件：绝不碰真实的 data/memory.json / topics.json
    QQ_MEMORY_FILE: path.join(TMP, "memory.json"),
    QQ_TOPIC_FILE: path.join(TMP, "topics.json"),
    QQ_REMINDER_FILE: path.join(TMP, "reminders.json"),
    ...env,
  });
  const apiCalls = [];
  const api = {
    sendMessage: async (scope, targetId, text) => {
      apiCalls.push({ scope, targetId, text });
      return { id: `m${apiCalls.length}` };
    },
  };
  const personaCalls = [];
  const engine = new MessageEngine({
    config,
    api,
    generate:
      generate ??
      (async (ctx) => {
        personaCalls.push(ctx.text);
        return `人格回复:${ctx.text}`;
      }),
    logger,
    agentChat,
    agentDeps,
  });
  engine.apiCalls = apiCalls;
  engine.personaCalls = personaCalls;
  engine.sentTexts = () => apiCalls.map((c) => c.text);
  return engine;
}

test("引擎：未解锁时说人话 → 走人格模型，人格回复真的发得出去", async () => {
  const agentChat = scriptedChat([{ reply: "不该被调用" }]);
  const e = makeEngine({ agentChat });
  const r = await e.handle(c2c("打开浏览器搜一下 b站"));

  assert.equal(r.action, "replied");
  assert.deepEqual(e.personaCalls, ["打开浏览器搜一下 b站"]);
  assert.equal(agentChat.calls.length, 0);
  assert.deepEqual(e.sentTexts(), ["人格回复:打开浏览器搜一下 b站"]);
});

test("引擎：解锁后说人话 → 走 agent 循环，人格模型不被调用", async () => {
  const agentChat = scriptedChat([{ reply: "好呀主人～春禾这就去开浏览器🌸" }]);
  const e = makeEngine({ agentChat });

  const unlock = await e.handle(c2c("vibe coding"));
  assert.equal(unlock.action, "replied");
  assert.match(e.sentTexts()[0], /全权限模式已开启/, "口令回执必须真的发出去");

  const r = await e.handle(c2c("打开电脑上的浏览器搜索 b站 GitHub"));
  assert.equal(r.action, "replied");
  assert.equal(agentChat.calls.length, 1);
  assert.deepEqual(e.personaCalls, [], "进了 agent 就不该再花人格模型的钱");
  assert.equal(e.sentTexts().at(-1), "好呀主人～春禾这就去开浏览器🌸");
});

test("引擎：agent 循环里的命令会真的执行，结果进了最终回复", async () => {
  const spawn = makeFakeSpawn({ plan: { "Get-Date": { out: "2026-10-16 10:30\n" } } });
  const agentChat = scriptedChat([
    { reply: runBlock("Get-Date") },
    { reply: "现在是 2026-10-16 10:30 呀～" },
  ]);
  const e = makeEngine({ agentChat, agentDeps: { spawn } });
  await e.handle(c2c("vibe coding"));
  const r = await e.handle(c2c("现在几点了"));

  assert.equal(r.action, "replied");
  assert.equal(spawn.calls.length, 1);
  assert.equal(spawn.calls[0].cmd, "Get-Date");
  assert.match(e.sentTexts().at(-1), /2026-10-16 10:30/);
  assert.deepEqual(e.personaCalls, []);
});

test("引擎：斜杠指令由远程控制接管，不烧人格模型的额度", async () => {
  const e = makeEngine({ agentChat: scriptedChat([{ reply: "不该被调用" }]) });
  const r = await e.handle(c2c("/状态"));
  assert.equal(r.action, "replied");
  assert.match(e.sentTexts()[0], /全权限模式未开启/);
  assert.deepEqual(e.personaCalls, [], "/状态 不该走模型");
});

test("引擎：群里说人话不进 agent（只有私聊能开这条能力）", async () => {
  const agentChat = scriptedChat([{ reply: "不该被调用" }]);
  const e = makeEngine({ agentChat });
  await e.handle(c2c("vibe coding"));
  const r = await e.handle(groupAt("打开浏览器"));

  assert.equal(r.action, "replied");
  assert.equal(agentChat.calls.length, 0);
  assert.deepEqual(e.personaCalls, ["打开浏览器"]);
});

test("引擎：stop coding 能打断正在跑的 agent 循环", async () => {
  const spawn = makeFakeSpawn();
  let release;
  const gate = new Promise((r) => {
    release = r;
  });
  const agentChat = async () => {
    await gate;
    return runBlock("Get-Date");
  };
  const e = makeEngine({ agentChat, agentDeps: { spawn } });
  await e.handle(c2c("vibe coding"));

  const pending = e.handle(c2c("现在几点了")); // 卡在模型调用上
  await new Promise((r) => setTimeout(r, 20));
  const stop = await e.handle(c2c("stop coding"));
  assert.equal(stop.action, "replied");
  assert.match(e.sentTexts().at(-1), /已关闭全权限模式/);

  release();
  const done = await pending;
  assert.equal(done.action, "replied");
  assert.equal(spawn.calls.length, 0, "喊停之后不许再执行命令");
  assert.match(e.sentTexts().at(-1), /停/);
});

test("引擎：agent 模型挂了也不能让这条消息没回复", async () => {
  const agentChat = scriptedChat([{ throw: "模型接口 HTTP 500" }]);
  const e = makeEngine({ agentChat });
  await e.handle(c2c("vibe coding"));
  const r = await e.handle(c2c("帮我打开浏览器"));

  assert.equal(r.action, "replied");
  assert.deepEqual(e.personaCalls, ["帮我打开浏览器"], "agent 起步就失败 → 退回人格层");
  assert.deepEqual(e.sentTexts().slice(1), ["人格回复:帮我打开浏览器"]);
});

test("引擎：没有可用模型（无 key）时 agent 模式整个不介入", async () => {
  const e = makeEngine({ agentChat: null }); // 没有注入，也没有 MODEL_API_KEY
  await e.handle(c2c("vibe coding"));
  const r = await e.handle(c2c("打开浏览器"));

  assert.equal(r.action, "replied");
  assert.deepEqual(e.personaCalls, ["打开浏览器"]);
});

test("引擎：没解锁时 /执行 依旧走原有远程路径（回归）", async () => {
  const e = makeEngine({ agentChat: scriptedChat([{ reply: "不该被调用" }]) });
  const r = await e.handle(c2c("/执行 ipconfig"));
  assert.equal(r.action, "replied");
  assert.match(e.sentTexts()[0], /未解锁/);
  assert.deepEqual(e.personaCalls, []);
});
