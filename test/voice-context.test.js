/**
 * 语音链路的「上下文」三件事，都来自真机事故：
 *
 *  1) 语音转写没进记忆 → 记忆里主人那一轮是空白（data/memory.json 实证）；
 *  2) 系统提示没给当前时间 → 用户问「今天几月几号」，她只能承认看不到；
 *  3) 文字里明确要求「用语音说」却回文字 → 用户实测：你能用语音说句话吗 → 32 字文字。
 *
 * 这三条都属于「模型其实做得到，但引擎没把话说清楚」，所以全部在引擎/链路上堵住，
 * 不靠提示词自由发挥。
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { MessageEngine, userMemoryTextOf } from "../src/core/engine.js";
import { loadConfig } from "../src/config.js";
import { describeNowForModel, makeModelGenerator, CHUNHE_SYSTEM_PROMPT } from "../src/persona/chunhe.js";
import { resolveTtsConfig, decideVoiceReply, wantsVoiceReply } from "../src/media/tts.js";
import { createLogger } from "../src/util/log.js";

const logger = createLogger("silent");
const OWNER = "OWNER-OPENID-1";

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "qqbot-voice-ctx-"));

function makeFakeApi() {
  const sent = [];
  return {
    sent,
    async sendMessage(scope, targetId, content, opts = {}) {
      sent.push({ scope, targetId, content, msgId: opts.msgId });
      return { id: `fake-${sent.length}`, content };
    },
    async sendProactiveMessage(scope, targetId, content) {
      sent.push({ scope, targetId, content, proactive: true });
      return { id: `fake-p-${sent.length}` };
    },
  };
}

/** 起一个真实引擎：真实记忆存储 + 假 api + 记录 ctx 的假人格层 */
function makeEngine(env = {}) {
  const dir = tmpDir();
  const config = loadConfig({
    QQ_APP_ID: "test-app-id",
    QQ_APP_SECRET: "test-app-secret",
    QQ_ADMIN_USERS: OWNER,
    QQ_MEMORY_FILE: path.join(dir, "memory.json"),
    QQ_TOPIC_FILE: path.join(dir, "topics.json"),
    QQ_OWNER_MEMORY_FILE: path.join(dir, "owner-memory.json"),
    QQ_REMINDERS: "false",
    QQ_MULTI_MESSAGE: "false",
    QQ_VOICE_REPLY: "off",
    QQ_SING_ENABLED: "false",
    QQ_PROACTIVE: "false",
    ...env,
  });
  const api = makeFakeApi();
  const seen = [];
  const engine = new MessageEngine({
    config,
    api,
    logger,
    generate: async (ctx) => {
      seen.push(ctx);
      return "嗯，春禾记住啦";
    },
  });
  return { engine, api, seen, dir, config };
}

let seq = 0;

function c2cMsg(text, attachments = []) {
  seq += 1;
  return {
    scope: "c2c",
    targetId: OWNER,
    senderId: OWNER,
    senderName: "主人",
    messageId: `vc-${seq}`,
    content: text,
    kind: attachments.length ? "voice" : "text",
    attachments,
  };
}

/** QQ 语音消息的真实形状：content 为空，转写只在 attachments[].asr_refer_text */
function voiceMsg(asrText) {
  return c2cMsg("", [
    {
      content_type: "voice",
      filename: "abc.amr",
      url: "https://example.invalid/abc.amr",
      asr_refer_text: asrText,
    },
  ]);
}

// ---------------------------------------------------------------------------
// ② 语音转写必须进记忆（否则记忆里主人那一轮是空白）
// ---------------------------------------------------------------------------

test("ASR 记忆：语音消息存「语音转写：…」，不再是空字符串", async () => {
  const { engine } = makeEngine();
  await engine.handle(voiceMsg("今天几月几号？"));

  const history = engine.memory.get(`owner:${OWNER}`);
  const userTurn = history.find((m) => m.role === "user");
  assert.ok(userTurn, "记忆里应该有主人这一轮");
  assert.equal(userTurn.content, "语音转写：今天几月几号？", "不能是空串");
  assert.match(userTurn.content, /今天几月几号/, "转写内容要真的落进记忆");
});

test("ASR 记忆：文字原样保存（不因为附带语音附件就被改写成转写）", async () => {
  const { engine } = makeEngine();
  await engine.handle(
    c2cMsg("主人打字说的这句", [
      { content_type: "voice", asr_refer_text: "语音里说的另一句" },
    ]),
  );
  const userTurn = engine.memory.get(`owner:${OWNER}`).find((m) => m.role === "user");
  assert.equal(userTurn.content, "主人打字说的这句");
});

test("ASR 记忆：语音但平台没给转写时也不留空行", async () => {
  const { engine } = makeEngine();
  await engine.handle(voiceMsg(""));
  const userTurn = engine.memory.get(`owner:${OWNER}`).find((m) => m.role === "user");
  assert.notEqual(userTurn.content, "", "空行会让这轮对话彻底消失");
  assert.match(userTurn.content, /语音/);
});

test("ASR 记忆：老数据不动（向后兼容，只在写入路径生效）", () => {
  // 纯函数层面：老条目（空 content）不该被"修复"，读取路径也不改写
  assert.equal(userMemoryTextOf("", null), "");
  assert.equal(userMemoryTextOf("原样", { type: "voice", asrText: "转写" }), "原样");
  assert.equal(userMemoryTextOf("", { type: "image" }), "", "图片仍按老行为处理");
});

// ---------------------------------------------------------------------------
// ④ 文字里明确要求「用语音说」→ 必须真的用语音回
// ---------------------------------------------------------------------------

/** mirror 模式的配置（生产默认） */
const mirrorCfg = () => resolveTtsConfig({ QQ_VOICE_REPLY: "mirror", TTS_ALLOW_GROUP: "false" });

test("语音触发：用户亲选的句式都认", () => {
  const cases = [
    "你能用语音说句话吗",
    "用语音说",
    "语音说句，春禾是大聪明可以吗",
    "用声音说给我听",
    "念一下这首诗",
    "说句话给我听",
    "我要听你说",
    "语音回我",
    "发语音",
    "说话给我听",
    "今晚语音说晚安好不好",
  ];
  for (const text of cases) {
    assert.equal(wantsVoiceReply(text), true, `应识别为语音请求：${text}`);
  }
});

test("语音触发：能力询问不触发（不误判成点播）", () => {
  const cases = [
    "你会用语音吗",
    "语音功能怎么样",
    "你有语音功能吗",
    "语音功能怎么开",
    "你能发语音吗",
    "支持语音吗",
    "语音是怎么实现的",
  ];
  for (const text of cases) {
    assert.equal(wantsVoiceReply(text), false, `不该触发语音：${text}`);
  }
});

test("语音触发：普通聊天不触发", () => {
  for (const text of ["今天几月几号", "随便说什么对我撒娇就行了", "我发的语音你没听见吗", ""]) {
    assert.equal(wantsVoiceReply(text), false, `不该触发语音：${text}`);
  }
});

test("语音触发：接入 decideVoiceReply 后 mirror 模式也发语音", () => {
  const cfg = mirrorCfg();
  // 原来只认「对方发了语音」→ 文字点播一律回文字（真机 bug）
  assert.equal(decideVoiceReply({ cfg, media: null, scope: "c2c", text: "你能用语音说句话吗" }), true);
  assert.equal(decideVoiceReply({ cfg, media: null, scope: "c2c", text: "今天几月几号" }), false);
  // 能力询问仍然只有文字
  assert.equal(decideVoiceReply({ cfg, media: null, scope: "c2c", text: "你会用语音吗" }), false);
});

test("语音触发：群聊仍受 TTS_ALLOW_GROUP 限制", () => {
  const cfg = mirrorCfg();
  assert.equal(
    decideVoiceReply({ cfg, media: null, scope: "group", text: "用语音说句话" }),
    false,
    "群聊默认不该因为一句话就开口",
  );
  const allow = resolveTtsConfig({ QQ_VOICE_REPLY: "mirror", TTS_ALLOW_GROUP: "true" });
  assert.equal(decideVoiceReply({ cfg: allow, media: null, scope: "group", text: "用语音说句话" }), true);
});

test("语音触发：TTS 关闭 / always 模式的既有行为不变", () => {
  const off = resolveTtsConfig({ QQ_VOICE_REPLY: "off" });
  assert.equal(decideVoiceReply({ cfg: off, media: null, scope: "c2c", text: "用语音说句话" }), false);
  const always = resolveTtsConfig({ QQ_VOICE_REPLY: "always" });
  assert.equal(decideVoiceReply({ cfg: always, media: null, scope: "c2c", text: "随便聊聊" }), true);
});

test("语音触发：引擎真的走到了语音分支（合成失败才降级文字）", async () => {
  // 这条测的是「接线」，不是合成：把 TTS python 指到不存在的路径，
  // 若引擎确实尝试发语音，就一定会留下「语音回复失败，降级为文字」的告警。
  // 反过来，普通文字消息不该出现这条告警。
  const warns = [];
  const dir = tmpDir();
  const config = loadConfig({
    QQ_APP_ID: "test-app-id",
    QQ_APP_SECRET: "test-app-secret",
    QQ_ADMIN_USERS: OWNER,
    QQ_MEMORY_FILE: path.join(dir, "memory.json"),
    QQ_TOPIC_FILE: path.join(dir, "topics.json"),
    QQ_OWNER_MEMORY_FILE: path.join(dir, "owner-memory.json"),
    QQ_REMINDERS: "false",
    QQ_MULTI_MESSAGE: "false",
    QQ_SING_ENABLED: "false",
    QQ_PROACTIVE: "false",
    QQ_VOICE_REPLY: "mirror",
    QQ_VOICE_RVC: "false",
    TTS_PYTHON: "C:\\definitely-not-a-real-python-for-test.exe",
    TTS_TIMEOUT_MS: "3000",
    VOICE_CACHE_ENABLED: "false",
  });
  const engine = new MessageEngine({
    config,
    api: makeFakeApi(),
    logger: { info() {}, warn: (m) => warns.push(String(m)), error() {}, debug() {} },
    generate: async () => "主人～春禾在这儿呢",
  });

  await engine.handle(c2cMsg("你能用语音说句话吗"));
  assert.ok(
    warns.some((w) => w.includes("语音回复失败")),
    `文字点播应触发语音分支，实际日志：${JSON.stringify(warns)}`,
  );

  warns.length = 0;
  await engine.handle(c2cMsg("今天几月几号"));
  assert.ok(
    !warns.some((w) => w.includes("语音回复失败")),
    "普通文字不该触发语音",
  );
});


// ---------------------------------------------------------------------------
// ③ 当前时间必须注入（否则「今天几月几号」只能承认看不到）
// ---------------------------------------------------------------------------

test("时间注入：格式固定、星期对得上、补零", () => {
  assert.equal(
    describeNowForModel(new Date("2026-10-18T23:05:00+08:00")),
    "【当前时间】2026-10-18 23:05 星期日（北京时间）",
  );
  // 单数字月/日/时/分都要补零，否则「2026-1-5 9:7」既难读也难被模型当日期解析
  assert.match(describeNowForModel(new Date("2026-01-05T09:07:00+08:00")), /2026-01-05 09:07 星期一/);
});

test("时间注入：每轮现算，不是模块加载时缓存", async () => {
  // 假时钟：第一次 23:05，第二次 23:07。若实现把时间算在模块顶层，两条会一模一样。
  const times = [
    new Date("2026-10-18T23:05:00+08:00"),
    new Date("2026-10-18T23:07:00+08:00"),
  ];
  let i = 0;
  const captured = [];
  const gen = makeModelGenerator({
    config: {
      modelBaseUrl: "https://example.invalid/v1",
      modelApiKey: "k",
      modelName: "m",
      historyTurns: 8,
      modelTimeoutMs: 5000,
    },
    logger,
    now: () => times[Math.min(i++, times.length - 1)],
    fetchImpl: async (_url, init) => {
      captured.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ choices: [{ message: { content: "在的" } }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  });

  const ctx = { text: "今天几月几号", scope: "c2c", history: [], isOwnerUser: true };
  await gen({ ...ctx });
  await gen({ ...ctx });

  assert.equal(captured.length, 2);
  const sys = (n) => captured[n].messages.find((m) => m.role === "system").content;
  assert.match(sys(0), /【当前时间】2026-10-18 23:05 星期日/, "第一轮要带当时的时间");
  assert.match(sys(1), /【当前时间】2026-10-18 23:07 星期日/, "第二轮必须是新的时间");
});

test("时间注入：系统提示词本体不变（视觉替换逻辑依赖原文）", async () => {
  const captured = [];
  const gen = makeModelGenerator({
    config: {
      modelBaseUrl: "https://example.invalid/v1",
      modelApiKey: "k",
      modelName: "m",
      historyTurns: 8,
      modelTimeoutMs: 5000,
    },
    logger,
    fetchImpl: async (_url, init) => {
      captured.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ choices: [{ message: { content: "嗯" } }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  });
  await gen({ text: "你好", scope: "c2c", history: [], isOwnerUser: true });
  const sys = captured[0].messages.find((m) => m.role === "system").content;
  // 时间只是额外一段附注，不能改写 buildSystemPrompt 的产物
  assert.ok(sys.includes(CHUNHE_SYSTEM_PROMPT), "原始人格提示词必须原样保留");
  assert.match(sys, /\n\n【当前时间】/, "时间要以独立段落追加");
});
