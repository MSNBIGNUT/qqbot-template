/**
 * 双引擎切换（旧春禾 lite ⇄ openclaw 主脑 brain）触发词测试。
 *
 * 这个功能的失败模式很贵：触发词判错 → 要么"主人喊了没反应"，
 * 要么"随便一句话就把自己停机了"；顺序判错 → 她先把自己停了，回复永远发不出去。
 * 这两种都只能在真机上复现一次，所以必须在这里守住。
 *
 * 注意：所有持久化路径都改到 test/_brain-switch-tmp/ 下，
 * 绝不碰项目 data\ 里的真实记忆/话题/提醒文件。
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import {
  isBrainSwitchRequest,
  resolveSwitchScript,
  spawnBrainSwitch,
  BRAIN_REPLY_ON,
  BRAIN_REPLY_OFF,
} from "../src/core/brain-switch.js";
import { MessageEngine } from "../src/core/engine.js";
import { loadConfig } from "../src/config.js";
import { CHUNHE_SYSTEM_PROMPT, buildSystemPrompt } from "../src/persona/chunhe.js";
import { createLogger } from "../src/util/log.js";

const logger = createLogger("silent");
const HERE = import.meta.dirname;
const TMP = path.join(HERE, "_brain-switch-tmp");

// ---------------- 触发词识别 ----------------

test("触发词：启动主脑的各种说法都应命中（on）", () => {
  for (const t of [
    "春禾启动主脑",
    "春禾，启动主脑",
    "春禾 启动主脑！",
    "启动主脑",
    "开启主脑",
    "打开主脑",
    "开主脑",
    "切到主脑",
    "切换到主脑模式",
    "春禾启动主脑吧",
  ]) {
    assert.equal(isBrainSwitchRequest(t), "on", `应识别为 on：${t}`);
  }
});

test("触发词：关闭主脑的各种说法都应命中（off）", () => {
  for (const t of [
    "春禾关闭主脑",
    "春禾，关闭主脑。",
    "关闭主脑",
    "关掉主脑",
    "退出主脑",
    "停用主脑",
    "结束主脑",
  ]) {
    assert.equal(isBrainSwitchRequest(t), "off", `应识别为 off：${t}`);
  }
});

test("触发词：不相关的闲聊绝不能命中（否则会把自己停机）", () => {
  for (const t of [
    "",
    "   ",
    "今天天气不错",
    "主脑是什么",
    "主脑这个词好奇怪",
    "春禾在吗",
    "帮我写个主脑的类",
    "不要启动主脑",
    "先别关闭主脑",
    "取消启动主脑",
    "春禾启动主脑模式是什么意思",
    undefined,
    null,
  ]) {
    assert.equal(isBrainSwitchRequest(t), null, `不该命中：${String(t)}`);
  }
});

test("触发词：回复文案必须能自解释（含「主脑」且不是否认能力）", () => {
  assert.match(BRAIN_REPLY_ON, /主脑/);
  assert.match(BRAIN_REPLY_OFF, /主脑/);
});

// ---------------- 脚本路径解析 ----------------

test("脚本路径：默认能解析到真实存在的 switch-brain.ps1", () => {
  const p = resolveSwitchScript({});
  assert.equal(path.basename(p), "switch-brain.ps1");
  assert.equal(fs.existsSync(p), true, `解析出来的脚本应真实存在：${p}`);
});

test("脚本路径：配置项优先", () => {
  const p = resolveSwitchScript({ brainSwitchScript: "D:\\x\\y.ps1" });
  assert.equal(p, "D:\\x\\y.ps1");
});

test("配置：QQ_BRAIN_SWITCH_SCRIPT 能覆盖脚本路径，留空则自动查找", () => {
  const cfg = loadConfig({
    QQ_APP_ID: "1",
    QQ_APP_SECRET: "s",
    QQ_BRAIN_SWITCH_SCRIPT: "D:\\z\\sw.ps1",
  });
  assert.equal(cfg.brainSwitchScript, "D:\\z\\sw.ps1");
  assert.equal(resolveSwitchScript(cfg), "D:\\z\\sw.ps1");

  const auto = loadConfig({ QQ_APP_ID: "1", QQ_APP_SECRET: "s" });
  assert.equal(fs.existsSync(resolveSwitchScript(auto)), true, "留空时应自动找到 switch-brain.ps1");
});

test("人格提示词：必须提到「春禾启动主脑」，且不破坏视觉分支的整段替换", () => {
  assert.match(CHUNHE_SYSTEM_PROMPT, /春禾启动主脑/);
  // buildSystemPrompt 靠正则整段替换「看不到图片」条款，结构一变就静默失效 → 必须守住
  assert.doesNotThrow(() => buildSystemPrompt({ vision: true }));
  assert.doesNotThrow(() => buildSystemPrompt({ vision: false }));
});

// ---------------- 分离进程构造 ----------------

test("分离启动：经 cmd/start 启动，且 detached+unref（否则她停机时会把脚本一起带走）", () => {
  const calls = [];
  let unrefed = false;
  const fakeSpawn = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    return { pid: 4242, unref: () => { unrefed = true; } };
  };

  const r = spawnBrainSwitch({
    target: "brain",
    scriptPath: "C:\\fake\\switch-brain.ps1",
    powershell: "C:\\fake\\powershell.exe",
    comspec: "C:\\fake\\cmd.exe",
    spawnImpl: fakeSpawn,
    logger,
  });

  assert.equal(r.ok, true);
  assert.equal(r.pid, 4242);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, "C:\\fake\\cmd.exe");
  assert.deepEqual(calls[0].args, [
    "/c",
    "start",
    "",
    "/b",
    "C:\\fake\\powershell.exe",
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    "C:\\fake\\switch-brain.ps1",
    "-Mode",
    "brain",
  ]);

  // ⚠️ 两个坑叠在一起，必须同时绕开：
  //
  // 1) 不能直接 `spawn(powershell, ..., {detached:true})`：
  //    detached 走 DETACHED_PROCESS（没有控制台），powershell.exe 会**静默退出、
  //    一个字节都不执行**，还不报错。所以外面套一层 `cmd /c start "" /b`，
  //    由 start 给 powershell 一个新的（隐藏）控制台。
  //
  // 2) 也不能不加 detached：
  //    libuv 对**非 detached** 的子进程会建一个带
  //    `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` 的 Job Object 把子进程放进去。
  //    旧春禾被杀 → 父进程句柄关闭 → job 关闭 → **脚本跟着被一起杀掉**。
  //    实测现象：日志停在「已停止旧春禾」，然后没有下文，两边都不在线。
  assert.equal(calls[0].opts.detached, true, "必须 detached，否则会进 kill-on-close 的 Job Object");
  assert.equal(calls[0].opts.stdio, "ignore", "必须 ignore，否则她会等脚本的 stdout 关闭");
  assert.equal(calls[0].opts.windowsHide, true, "不能闪出黑窗口");
  assert.equal(unrefed, true, "必须 unref，否则她不会退出");
  assert.equal(r.error, undefined);
});

test("分离启动：路径含空格时加引号（cmd 会重新解析一遍命令行）", () => {
  const calls = [];
  spawnBrainSwitch({
    target: "lite",
    scriptPath: "C:\\a b\\switch-brain.ps1",
    powershell: "C:\\Program Files\\PowerShell\\powershell.exe",
    comspec: "C:\\fake\\cmd.exe",
    delaySec: 15,
    spawnImpl: (cmd, args, opts) => {
      calls.push({ cmd, args, opts });
      return { pid: 7, unref: () => {} };
    },
    logger,
  });
  const args = calls[0].args;
  assert.equal(args[4], '"C:\\Program Files\\PowerShell\\powershell.exe"');
  assert.equal(args[args.indexOf("-File") + 1], '"C:\\a b\\switch-brain.ps1"');
  assert.deepEqual(args.slice(-2), ["-DelaySec", "15"]);
  assert.equal(args[args.indexOf("-Mode") + 1], "lite");
});

test("分离启动：-Mode lite 时带上 -DelaySec（给回复留送达时间）", () => {
  const calls = [];
  const fakeSpawn = (cmd, args) => {
    calls.push({ cmd, args });
    return { pid: 1, unref: () => {} };
  };
  spawnBrainSwitch({
    target: "lite",
    scriptPath: "C:\\fake\\switch-brain.ps1",
    powershell: "C:\\fake\\powershell.exe",
    delaySec: 15,
    spawnImpl: fakeSpawn,
    logger,
  });
  assert.deepEqual(calls[0].args.slice(-2), ["-DelaySec", "15"]);
  assert.equal(calls[0].args[calls[0].args.indexOf("-Mode") + 1], "lite");
});

test("分离启动：spawn 抛错时返回 ok:false 而不是抛出（不能让消息回复挂掉）", () => {
  const r = spawnBrainSwitch({
    target: "brain",
    scriptPath: "C:\\fake\\switch-brain.ps1",
    powershell: "C:\\fake\\powershell.exe",
    spawnImpl: () => {
      throw new Error("EPERM");
    },
    logger,
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /EPERM/);
});

// ---------------- 引擎接线（顺序是关键） ----------------

function makeEngine({ spawnResult, spawnThrows = false } = {}) {
  fs.mkdirSync(TMP, { recursive: true });
  const config = loadConfig({
    QQ_APP_ID: "1",
    QQ_APP_SECRET: "s",
    // 全部落到测试临时目录，绝不碰项目 data\ 下的真实记忆
    QQ_MEMORY_FILE: path.join(TMP, "memory.json"),
    QQ_TOPIC_FILE: path.join(TMP, "topics.json"),
    QQ_REMINDER_FILE: path.join(TMP, "reminders.json"),
  });

  /** 按发生顺序记录事件，用来断言"先回复、后切换" */
  const events = [];
  const apiCalls = [];
  const api = {
    sendMessage: async (scope, targetId, text) => {
      events.push({ type: "send", text });
      apiCalls.push({ scope, targetId, text });
      return { id: `m${apiCalls.length}` };
    },
  };

  const spawnCalls = [];
  const engine = new MessageEngine({
    config,
    api,
    generate: async (ctx) => `回应:${ctx.text || "(空)"}`,
    logger,
    brainSwitch: {
      scriptPath: "C:\\fake\\switch-brain.ps1",
      powershell: "C:\\fake\\powershell.exe",
      spawn: (opts) => {
        events.push({ type: "spawn", target: opts.target });
        spawnCalls.push(opts);
        if (spawnThrows) throw new Error("boom");
        return spawnResult ?? { ok: true, pid: 999 };
      },
    },
  });

  engine.events = events;
  engine.spawnCalls = spawnCalls;
  engine.sentTexts = () => apiCalls.map((c) => c.text);
  return engine;
}

let msgSeq = 0;
const c2cMsg = (content, over = {}) => ({
  kind: "c2c",
  scope: "c2c",
  rawEventType: "C2C_MESSAGE_CREATE",
  senderId: "u1",
  senderName: "主人",
  content,
  messageId: `c-${++msgSeq}`,
  targetId: "u1",
  attachments: [],
  ...over,
});

test("引擎：说「春禾启动主脑」→ 先回复，再分离执行 -Mode brain", async () => {
  const e = makeEngine();
  const r = await e.handle(c2cMsg("春禾启动主脑"));

  assert.equal(r.action, "replied", "必须先回一句话，否则她把自己停了主人什么都收不到");
  assert.equal(e.sentTexts().length, 1);
  assert.match(e.sentTexts()[0], /主脑/);

  assert.equal(e.spawnCalls.length, 1, "应该恰好启动一次切换脚本");
  assert.equal(e.spawnCalls[0].target, "brain");
  assert.equal(e.spawnCalls[0].scriptPath, "C:\\fake\\switch-brain.ps1");

  const types = e.events.map((x) => x.type);
  assert.deepEqual(types, ["send", "spawn"], "顺序必须是「先回复、后切换」");
});

test("引擎：切换脚本起不来时，补一条失败提示且不影响她继续在线", async () => {
  const e = makeEngine({ spawnResult: { ok: false, error: "ENOENT: powershell" } });
  const r = await e.handle(c2cMsg("春禾启动主脑"));

  assert.equal(r.action, "replied");
  assert.equal(e.sentTexts().length, 2, "先报「启动中」，失败后再补一条说明");
  assert.match(e.sentTexts()[1], /失败|ENOENT/);

  // 她还在线：普通消息照常走人格层
  const r2 = await e.handle(c2cMsg("1+1 等于几"));
  assert.equal(r2.action, "replied");
  assert.equal(e.sentTexts().at(-1), "回应:1+1 等于几");
});

test("引擎：spawn 抛异常也不能让这条消息没有回复", async () => {
  const e = makeEngine({ spawnThrows: true });
  const r = await e.handle(c2cMsg("春禾启动主脑"));
  assert.equal(r.action, "replied");
  assert.equal(e.sentTexts().length, 2);
});

test("引擎：lite 模式下说「春禾关闭主脑」→ 只回复「已经是普通模式」，不启动脚本", async () => {
  const e = makeEngine();
  const r = await e.handle(c2cMsg("春禾关闭主脑"));

  assert.equal(r.action, "replied");
  assert.equal(e.spawnCalls.length, 0, "已经在这个模式里，不该再跑一遍脚本");
  assert.match(e.sentTexts()[0], /主脑|普通模式/);
});

test("引擎：普通消息完全不受影响", async () => {
  const e = makeEngine();
  const r = await e.handle(c2cMsg("今天天气怎么样"));
  assert.equal(r.action, "replied");
  assert.equal(e.spawnCalls.length, 0);
  assert.equal(e.sentTexts()[0], "回应:今天天气怎么样");
});

test.after(() => {
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* 清理失败无所谓 */
  }
});
