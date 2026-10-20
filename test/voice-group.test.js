/**
 * 群聊语音（被动回复 + 跨场景主动投递）——用户实测 bug 的回归测试。
 *
 * 真机 2026-10-18：主人在私聊问「你现在能在群里发语音吗？」，春禾答「做不到」。
 * 根因有两条：
 *   ① `TTS_ALLOW_GROUP=false` 让 `decideVoiceReply` 在群聊一律返回 false；
 *   ② 跨场景待办没有 `voice` 这种 kind，「在群里用语音说晚安」解析不出来。
 *
 * 本文件锁死的新行为：
 *   1. 群聊**明确**要求语音（「用语音说句话」）→ 走群语音管道
 *      （uploadMedia(group) → sendMedia(group)，file_type=3，带 msg_id）；
 *   2. 群聊普通消息 → 仍是文字（不误触发）；
 *   3. `TTS_ALLOW_GROUP=false` 时群聊仍不发语音（总开关语义）；
 *   4. 待办 kind=voice：解析 + 主动投递走群语音管道（不带 msg_id，算主动消息）；
 *   5. 「在群里说晚安」仍是文字 say（不误伤现有行为）；
 *   6. TTS 失败 → 文字降级，绝不假装发了语音；
 *   7. 「群聊能不能发语音」被答成「做不到」时，由确定性闸门纠正为真话。
 *
 * 全部离线：假 api + 注入的假合成器，不启动 Python、不连 QQ、不碰 data/。
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { MessageEngine } from "../src/core/engine.js";
import { loadConfig } from "../src/config.js";
import { parsePendingInstruction } from "../src/core/pending-actions.js";
import { resolveTtsConfig, decideVoiceReply } from "../src/media/tts.js";
import { describeProactiveDeliveryForModel } from "../src/persona/chunhe.js";
import { VOICE_FILE_TYPE } from "../src/qq/api.js";
import { CHUNHE_SYSTEM_PROMPT } from "../src/persona/chunhe.js";

const OWNER = "OWNER_VOICE_GROUP_0001";
const GROUP = "GROUP_VOICE_GROUP_AAAA";
const TTS_ALLOW_GROUP_KEY = "TTS_ALLOW_GROUP";

const SILK = Buffer.concat([
  Buffer.from("\x02#!SILK_V3", "latin1"),
  Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04]),
]);

const sleep = () => new Promise((r) => setTimeout(r, 0));
let seq = 0;

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "qqbot-voice-group-"));
}

function fakeApi({ failUpload = false, failMedia = false, failProactive = false } = {}) {
  const texts = [];
  const uploads = [];
  const mediaSends = [];
  return {
    texts,
    uploads,
    mediaSends,
    async sendMessage(scope, targetId, content, opts = {}) {
      texts.push({ scope, targetId, content, msgId: opts.msgId, proactive: false });
      return { id: `text-${texts.length}`, content };
    },
    async sendProactiveMessage(scope, targetId, content) {
      if (failProactive) throw new Error("proactive denied");
      texts.push({ scope, targetId, content, proactive: true });
      return { id: `proactive-${texts.length}`, content };
    },
    async uploadMedia(scope, targetId, base64, fileType) {
      if (failUpload) throw new Error("upload denied");
      uploads.push({ scope, targetId, fileType, buf: Buffer.from(base64, "base64") });
      return `fi_${uploads.length}`;
    },
    async sendMedia(scope, targetId, fileInfo, opts = {}) {
      if (failMedia) throw new Error("media denied");
      mediaSends.push({ scope, targetId, fileInfo, opts });
      return { id: `media-${mediaSends.length}` };
    },
    async getGroupMembers() {
      return [];
    },
  };
}

function makeEngine({
  env = {},
  api = fakeApi(),
  synth = async () => ({ ok: true, silk: SILK, durationMs: 2600, timings: {} }),
  generate = async () => "好呀～",
} = {}) {
  const dir = tmpDir();
  const config = loadConfig({
    QQ_APP_ID: "test-app-id",
    QQ_APP_SECRET: "test-app-secret",
    QQ_ADMIN_USERS: OWNER,
    QQ_GROUP_TRIGGER: "mention",
    QQ_MEMORY_FILE: path.join(dir, "memory.json"),
    QQ_TOPIC_FILE: path.join(dir, "topics.json"),
    QQ_OWNER_MEMORY_FILE: path.join(dir, "owner-memory.json"),
    QQ_PENDING_FILE: path.join(dir, "pending-actions.json"),
    QQ_REMINDER_FILE: path.join(dir, "reminders.json"),
    QQ_GROUPS_FILE: path.join(dir, "groups.json"),
    QQ_PROACTIVE_QUOTA_FILE: path.join(dir, "proactive-quota.json"),
    QQ_SESSION_FILE: path.join(dir, "session.json"),
    QQ_REMINDERS: "false",
    QQ_MULTI_MESSAGE: "false",
    QQ_SING_ENABLED: "false",
    QQ_PROACTIVE: "false",
    QQ_PENDING_DELIVERY: "proactive",
    QQ_RATE_LIMIT_PER_MINUTE: "1000",
    QQ_AI_LABEL_STYLE: "none",
    AI_LABEL: "",
    QQ_VOICE_REPLY: "mirror",
    QQ_VOICE_RVC: "false",
    VOICE_CACHE_ENABLED: "false",
    [TTS_ALLOW_GROUP_KEY]: "on-demand",
    ...env,
  });
  const calls = [];
  const engine = new MessageEngine({
    config,
    api,
    logger: {
      debug() {},
      info() {},
      warn() {},
      error() {},
    },
    generate,
    ttsSynth: async (text, cfg, deps) => {
      calls.push({ text, cfg });
      await sleep();
      return synth(text, cfg, deps);
    },
  });
  return { engine, api, calls, dir, config };
}

function groupMsg(text, { openid = OWNER, gid = GROUP } = {}) {
  seq += 1;
  return {
    scope: "group",
    rawEventType: "GROUP_AT_MESSAGE_CREATE",
    senderId: openid,
    senderName: "主人",
    memberRole: "member",
    content: `<@!123> ${text}`,
    messageId: `voice-group-${seq}`,
    groupOpenid: gid,
    targetId: gid,
    kind: "text",
    attachments: [],
  };
}

function c2cMsg(text, openid = OWNER) {
  seq += 1;
  return {
    scope: "c2c",
    rawEventType: "C2C_MESSAGE_CREATE",
    senderId: openid,
    senderName: "主人",
    targetId: openid,
    messageId: `voice-c2c-${seq}`,
    content: text,
    kind: "text",
    attachments: [],
  };
}

function seedGroup(engine, gid = GROUP) {
  engine.groups.observe({ groupOpenid: gid, senderOpenid: OWNER });
}

// ---------------------------------------------------------------------------
// ① 配置语义：off / on-demand / always
// ---------------------------------------------------------------------------

test("群语音开关：on-demand 只认明确语音请求，普通消息不触发", () => {
  const onDemand = resolveTtsConfig({
    QQ_VOICE_REPLY: "mirror",
    TTS_ALLOW_GROUP: "on-demand",
  });
  assert.equal(onDemand.groupMode, "on-demand");
  assert.equal(
    decideVoiceReply({ cfg: onDemand, media: null, scope: "group", text: "用语音说句话" }),
    true,
    "群里明确点播必须真的用语音回",
  );
  assert.equal(
    decideVoiceReply({ cfg: onDemand, media: null, scope: "group", text: "今天天气不错" }),
    false,
    "普通群消息仍用文字",
  );
  assert.equal(
    decideVoiceReply({
      cfg: onDemand,
      media: { type: "voice" },
      scope: "group",
      text: "",
    }),
    false,
    "on-demand 下别人发语音也不自动跟着发语音（避免吵）",
  );
  assert.equal(
    decideVoiceReply({ cfg: onDemand, media: null, scope: "c2c", text: "用语音说句话" }),
    true,
    "私聊行为不变",
  );
});

test("群语音开关：false 仍是总开关（群聊一律不发）", () => {
  const off = resolveTtsConfig({ QQ_VOICE_REPLY: "mirror", TTS_ALLOW_GROUP: "false" });
  assert.equal(off.groupMode, "off");
  assert.equal(
    decideVoiceReply({ cfg: off, media: null, scope: "group", text: "用语音说句话" }),
    false,
  );
  const always = resolveTtsConfig({ QQ_VOICE_REPLY: "mirror", TTS_ALLOW_GROUP: "true" });
  assert.equal(always.groupMode, "always");
  assert.equal(
    decideVoiceReply({ cfg: always, media: { type: "voice" }, scope: "group", text: "" }),
    true,
    "true 语义保持原样：群聊镜像/点播都发",
  );
});

// ---------------------------------------------------------------------------
// ② 群聊被动回复：明确语音请求 → 群语音管道
// ---------------------------------------------------------------------------

test("群聊明确要语音：走 /v2/groups 同一条管道（uploadMedia group + sendMedia group）", async () => {
  const api = fakeApi();
  const { engine, calls } = makeEngine({ api });

  const res = await engine.handle(groupMsg("用语音说句晚安"));
  assert.equal(res.action, "replied");
  assert.equal(res.voice, true, "结果必须标记成真的发了语音");

  assert.equal(api.uploads.length, 1, "只上传一条语音");
  assert.equal(api.uploads[0].scope, "group", "上传必须走群管道");
  assert.equal(api.uploads[0].targetId, GROUP);
  assert.equal(api.uploads[0].fileType, VOICE_FILE_TYPE);
  assert.equal(
    api.uploads[0].buf.subarray(0, 10).toString("latin1"),
    "\x02#!SILK_V3",
    "上传的必须是 tencent SILK",
  );
  assert.equal(api.mediaSends.length, 1, "只发一条语音消息");
  assert.equal(api.mediaSends[0].scope, "group");
  assert.equal(api.mediaSends[0].targetId, GROUP);
  assert.ok(api.mediaSends[0].opts.msgId, "被动回复必须带 msg_id");
  assert.equal(api.texts.length, 0, "明确语音请求不该再补一条文字");

  assert.equal(calls.length, 1);
  assert.match(calls[0].text, /好呀|晚安|春禾/, "合成的是模型回复正文");
});

test("群聊普通消息：仍是文字，绝不误触发语音", async () => {
  const api = fakeApi();
  // 2026-10-19：弱关联表情会把「今天天气不错」当闲聊补一张（那是**图片**上传，不是语音）。
  // 这个测试关心的是语音，所以关掉自动补表情来隔离。
  const { engine, calls } = makeEngine({ api, env: { STICKER_AUTO: "false" } });

  const res = await engine.handle(groupMsg("今天天气不错"));
  assert.equal(res.action, "replied");
  assert.equal(api.uploads.length, 0, "没有语音上传");
  assert.equal(api.mediaSends.length, 0, "没有语音消息");
  assert.equal(api.texts.length, 1, "回了一条文字");
  assert.equal(calls.length, 0, "没有调用 TTS");
});

test("TTS_ALLOW_GROUP=false：群聊明确点播也仍用文字（总开关优先）", async () => {
  const api = fakeApi();
  const { engine, calls } = makeEngine({
    api,
    env: { [TTS_ALLOW_GROUP_KEY]: "false" },
  });

  await engine.handle(groupMsg("用语音说句晚安"));
  assert.equal(api.uploads.length, 0, "总开关关着就不许发群语音");
  assert.equal(api.mediaSends.length, 0);
  assert.equal(api.texts.length, 1, "老老实实回文字");
  assert.equal(calls.length, 0, "连合成都不该尝试");
});

test("TTS 失败：群语音降级文字，不静默、不假装", async () => {
  const api = fakeApi();
  const { engine } = makeEngine({
    api,
    synth: async () => ({ ok: false, reason: "合成器爆了" }),
  });

  const res = await engine.handle(groupMsg("用语音说句晚安"));
  assert.equal(res.action, "replied");
  assert.equal(api.uploads.length, 0);
  assert.equal(api.mediaSends.length, 0);
  assert.equal(api.texts.length, 1, "语音失败后仍要有一条文字，不能没回");
  assert.equal(api.texts[0].content, "好呀～", "降级发的是模型回复正文");
});

test("语音时长超过 QQ 的 58s 上限：不发，降级文字", async () => {
  const api = fakeApi();
  const { engine } = makeEngine({
    api,
    synth: async () => ({ ok: true, silk: SILK, durationMs: 59000 }),
  });

  await engine.handle(groupMsg("用语音说句晚安"));
  assert.equal(api.uploads.length, 0, "超长语音不该上传（平台会拒收）");
  assert.equal(api.mediaSends.length, 0);
  assert.equal(api.texts.length, 1, "降级文字");
});

// ---------------------------------------------------------------------------
// ③ 待办 kind=voice：解析
// ---------------------------------------------------------------------------

test("待办解析：群里「用语音说」识别为 voice，不再误判成 say", () => {
  const cases = [
    ["在群里用语音说晚安", "晚安", "any_group"],
    ["去大群里语音说句大家好", "大家好", "size:large"],
    ["到群里发条语音说想你们了", "想你们了", "any_group"],
    ["在群里语音说：今天好累", "今天好累", "any_group"],
    ["你能在群里用语音说句晚安吗", "晚安", "any_group"],
  ];
  for (const [text, said, target] of cases) {
    const p = parsePendingInstruction(text);
    assert.ok(p, `应该识别成待办：${text}`);
    assert.equal(p.kind, "voice", `kind 应为 voice：${text}`);
    assert.equal(p.payload.text, said, `语音内容：${text}`);
    assert.equal(p.target, target);
  }
});

test("待办解析：「在群里说晚安」仍是文字 say（不误伤）", () => {
  for (const text of ["在群里说晚安", "在群里说一句晚安", "去小群说一句晚安"]) {
    const p = parsePendingInstruction(text);
    assert.ok(p, `应识别成待办：${text}`);
    assert.equal(p.kind, "say", `必须仍是 say：${text}`);
    assert.notEqual(p.kind, "voice");
  }
});

test("待办解析：只是问「群里能不能发语音」不该变成待办", () => {
  for (const text of [
    "你现在能在群里发语音吗",
    "群里能发语音吗",
    "你能在群里用语音说话吗",
    "在群里发条语音",
  ]) {
    const p = parsePendingInstruction(text);
    assert.ok(
      !p || p.kind !== "voice",
      `语音能力询问/无内容指令不该变成 voice 待办：${text} → ${JSON.stringify(p)}`,
    );
  }
});

test("待办解析：真机原话「嗯，你现在能在群里发语音吗？」绝不能变成待办", () => {
  // 用户实测原句带了「嗯，」前缀 —— 句首不是「你/能」，
  // 不能因此绕过能力询问的判断，把「语音吗」当成一句话发到群里。
  for (const text of [
    "嗯，你现在能在群里发语音吗？",
    "那个，群里能发语音吗？",
    "春禾，你能在群里发语音吗？",
    "嗯，你现在能在群里发语音？",
    "群里能发语音？",
  ]) {
    assert.equal(parsePendingInstruction(text), null, `不该建待办：${text}`);
  }
});

// ---------------------------------------------------------------------------
// ④ 待办 kind=voice：主动投递
// ---------------------------------------------------------------------------

test("待办 voice：私聊下令 → 主动把语音发到群里（不带 msg_id，走群管道）", async () => {
  const api = fakeApi();
  const { engine, calls } = makeEngine({ api });
  seedGroup(engine);

  const res = await engine.handle(c2cMsg("在群里用语音说晚安"));
  assert.equal(res.action, "replied");

  assert.equal(api.uploads.length, 1, "应当上传一条语音");
  assert.equal(api.uploads[0].scope, "group");
  assert.equal(api.uploads[0].targetId, GROUP);
  assert.equal(api.uploads[0].fileType, VOICE_FILE_TYPE);
  assert.equal(api.mediaSends.length, 1, "应当发一条群语音消息");
  assert.equal(api.mediaSends[0].scope, "group");
  assert.equal(api.mediaSends[0].targetId, GROUP);
  assert.equal(api.mediaSends[0].opts.msgId, undefined, "主动消息不能带 msg_id");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].text, "晚安", "TTS 念的应当是待办内容");

  const confirm = api.texts.find((t) => t.scope === "c2c" && !t.proactive);
  assert.ok(confirm, "私聊必须给回执");
  assert.match(confirm.content, /语音/);
  assert.match(confirm.content, /已经|发到群里/);
  assert.doesNotMatch(confirm.content, /没发出去|没发到/);

  const stored = engine.pendingActions.listAll().find((a) => a.kind === "voice");
  assert.equal(stored?.status, "done", "真的发出去之后才能标记完成");
});

test("待办 voice：TTS_ALLOW_GROUP=false 时改文字，回执说清群语音没开通", async () => {
  const api = fakeApi();
  const { engine } = makeEngine({
    api,
    env: { [TTS_ALLOW_GROUP_KEY]: "false" },
  });
  seedGroup(engine);

  await engine.handle(c2cMsg("在群里用语音说晚安"));
  assert.equal(api.uploads.length, 0, "总开关关着不许发群语音");
  const groupText = api.texts.filter((t) => t.scope === "group" && t.proactive);
  assert.equal(groupText.length, 1, "内容仍要送到群里");
  const confirm = api.texts.find((t) => t.scope === "c2c" && !t.proactive);
  assert.match(confirm.content, /群里语音.*(?:还没|没有)开通|群语音/);
  assert.match(confirm.content, /文字/);
});

test("给模型看的结果提示：语音降级文字时必须说清是文字", () => {
  const hint = describeProactiveDeliveryForModel({
    ok: true,
    kind: "voice",
    voice: false,
    voiceFallback: "合成器爆了",
  });
  assert.match(hint, /文字/);
  assert.match(hint, /语音/);
  assert.match(hint, /合成器爆了/);
  assert.doesNotMatch(hint, /已经.*语音.*了/);
});

test("待办 voice：TTS 失败 → 文字兜底发到群里，回执如实说改成了文字", async () => {
  const api = fakeApi();
  const { engine } = makeEngine({
    api,
    synth: async () => ({ ok: false, reason: "RVC/edge-tts 都挂了" }),
  });
  seedGroup(engine);

  await engine.handle(c2cMsg("在群里用语音说晚安"));

  assert.equal(api.uploads.length, 0, "合成失败不许上传空语音");
  assert.equal(api.mediaSends.length, 0);
  const groupText = api.texts.filter((t) => t.scope === "group" && t.proactive);
  assert.equal(groupText.length, 1, "内容仍要送到群里（降级文字）");
  assert.equal(groupText[0].content, "晚安");

  const confirm = api.texts.find((t) => t.scope === "c2c" && !t.proactive);
  assert.match(confirm.content, /文字/, "必须如实说是文字，不是语音");
  assert.match(confirm.content, /合成|语音/, "要说明语音为什么没成");
  const stored = engine.pendingActions.listAll().find((a) => a.kind === "voice");
  assert.equal(stored?.status, "done", "降级文字也算送到，不能无限重试");
});

test("待办 voice：语音通道上传失败 → 文字兜底；全失败 → 如实说没发", async () => {
  const api = fakeApi({ failUpload: true });
  const { engine } = makeEngine({ api });
  seedGroup(engine);
  await engine.handle(c2cMsg("在群里用语音说晚安"));
  const groupText = api.texts.filter((t) => t.scope === "group" && t.proactive);
  assert.equal(groupText.length, 1, "上传失败后要改用文字发");
  assert.equal(groupText[0].content, "晚安");
  const confirm = api.texts.find((t) => t.scope === "c2c" && !t.proactive);
  assert.match(confirm.content, /文字/);

  // 语音上传和文字主动消息全失败 → 回执必须承认没发出去
  const api2 = fakeApi({ failUpload: true, failProactive: true });
  const { engine: engine2 } = makeEngine({ api: api2 });
  seedGroup(engine2);
  await engine2.handle(c2cMsg("在群里用语音说晚安"));
  const confirm2 = api2.texts.find((t) => t.scope === "c2c" && !t.proactive);
  assert.match(confirm2.content, /没发|没发出去|没发到|没发成/, "全失败必须如实说没发");
  const stored = engine2.pendingActions.listAll().find((a) => a.kind === "voice");
  assert.equal(stored?.status, "pending", "发送失败要保留待办，后面还能补");
});

// ---------------------------------------------------------------------------
// ⑤ 自我否认：群里其实能发语音，不能答「做不到」
// ---------------------------------------------------------------------------

test("能力纠偏：群语音已开通时，「做不到」被替换成真话", async () => {
  const api = fakeApi();
  const { engine } = makeEngine({
    api,
    generate: async () => "做不到，群里发不了语音。",
  });

  await engine.handle(c2cMsg("你现在能在群里发语音吗？"));
  const reply = api.texts.find((t) => t.scope === "c2c")?.content ?? "";
  assert.doesNotMatch(reply, /做不到|发不了/, "不能把已实现的能力说成做不到");
  assert.match(reply, /语音/, "要给出真实的语音能力说明");
  assert.match(reply, /用语音说|明确/, "要说清群聊需要明确要求");
  assert.match(reply, /@/, "当前群语音也认「@ 她」，真话必须说全，不能只讲一半");
});

test("能力纠偏：群语音确实没开通时，说「群里还没开通语音」而不是笼统做不到", async () => {
  const api = fakeApi();
  const { engine } = makeEngine({
    api,
    env: { [TTS_ALLOW_GROUP_KEY]: "false" },
    generate: async () => "做不到。",
  });

  await engine.handle(c2cMsg("你现在能在群里发语音吗？"));
  const reply = api.texts.find((t) => t.scope === "c2c")?.content ?? "";
  assert.match(reply, /群里.*(?:还没|没有)开通|群里.*只能打字/, "要具体说清群语音没开通");
  assert.doesNotMatch(reply, /^做不到。?$/, "不许笼统地说做不到");
});

test("人格层：明确写出「群聊也能发语音（需明确要求）」", () => {
  assert.match(CHUNHE_SYSTEM_PROMPT, /群聊[\s\S]{0,40}语音|语音[\s\S]{0,40}群聊/);
  assert.match(CHUNHE_SYSTEM_PROMPT, /明确(?:要求|说)/);
  assert.match(CHUNHE_SYSTEM_PROMPT, /用语音说/);
});

test("人格层：本地规则模式也能正确回答群语音能力", async () => {
  const { makeLocalGenerator } = await import("../src/persona/chunhe.js");
  const generate = makeLocalGenerator({ logger: { warn() {} } });
  const reply = await generate({
    text: "你现在能在群里发语音吗？",
    scope: "c2c",
    voiceCapability: { enabled: true, groupMode: "on-demand" },
  });
  assert.match(reply, /语音/);
  assert.doesNotMatch(reply, /做不到/);
});
