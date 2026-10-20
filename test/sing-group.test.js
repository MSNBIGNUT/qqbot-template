/**
 * 群聊唱歌测试：**群里点歌必须真的发出歌声，发不出去就必须如实说**。
 *
 * 修的两个真实 bug（2026-10-17 真机实测）：
 *   1. `#sendLibrarySong` / `#sendSynthSong` 只走 C2C 管道
 *      （uploadC2CFile → /v2/users/{group_openid}/files、sendC2CVoice），
 *      群场景根本没有可用的发送路径 → 点了歌什么都没发出去。
 *   2. 唱不出来时 send() 回落到"模型的文字回复"，模型就把**编的歌词**当唱歌发出去，
 *      主人看到 59 个字，以为唱了，其实一个音符都没有。这比不唱更糟。
 *
 * 因此这里锁死：
 *   - c2c → C2C 上传+发送（老路径不许改坏）
 *   - group → 群文件上传 + 群消息发送（uploadMedia/sendMedia，带 msg_id 走被动回复）
 *   - 群聊多段：按顺序、msg_seq 严格递增、段间有间隔
 *   - 唱歌失败 → 如实说"没发出去"，**一个字歌词都不许发**
 *   - 曲库没这首 → 说"不会"，绝不合成别的歌顶替
 *   - 群里不 @ 不回（设计如此），@ 了才唱
 *
 * 全部离线：api 是记账用的假实现，曲库是临时目录，不碰真实数据、不联网。
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { MessageEngine } from "../src/core/engine.js";
import { loadConfig } from "../src/config.js";
import { CHUNHE_SYSTEM_PROMPT } from "../src/persona/chunhe.js";
import { createLogger } from "../src/util/log.js";

const logger = createLogger("silent");

// ---------------------------------------------------------------- 打桩工具

/** 造一段合法的 tencent SILK_V3：header + N 个 20ms 包 + 终止包 */
function makeSilk(frames, payload = 8) {
  const chunks = [Buffer.from("\x02#!SILK_V3", "binary")];
  for (let i = 0; i < frames; i += 1) {
    const len = Buffer.alloc(2);
    len.writeUInt16LE(payload);
    chunks.push(len, Buffer.alloc(payload, (i * 7) & 0xff));
  }
  const end = Buffer.alloc(2);
  chunks.push(end);
  return Buffer.concat(chunks);
}

function tempLib() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chunhe-group-sing-"));
  return {
    dir,
    write(file, frames) {
      const p = path.join(dir, file);
      fs.writeFileSync(p, makeSilk(frames));
      return p;
    },
    cleanup() {
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

function apiError(message, bizCode = 40034) {
  const err = new Error(message);
  err.bizCode = bizCode;
  return err;
}

/**
 * 假 api：只记账。
 *
 * 刻意**同时**提供两套接口：
 *   - C2C：uploadC2CFile / sendC2CVoice（老路径）
 *   - 分场景：uploadMedia / sendMedia（api.js 里的通用路径，图片已经在用）
 * 这样测试就能断言"群聊到底走了哪一条"。
 */
function fakeApi({ failGroupUpload = false, failC2CUpload = false } = {}) {
  const calls = [];
  const c2cUploads = [];
  const mediaUploads = [];
  const mediaSends = [];
  const texts = [];
  let n = 0;

  return {
    calls,
    c2cUploads,
    mediaUploads,
    mediaSends,
    texts,
    async uploadC2CFile(targetId, base64, fileType) {
      calls.push({ fn: "uploadC2CFile", targetId });
      if (failC2CUpload) throw apiError("网络错误 [c2c]：fetch failed");
      const buf = Buffer.from(base64, "base64");
      c2cUploads.push({ targetId, buf, fileType });
      n += 1;
      return `c2c_fi_${n}`;
    },
    async sendC2CVoice(targetId, fileInfo, opts = {}) {
      calls.push({ fn: "sendC2CVoice", targetId, opts });
      return { id: `c2c_voice_${n}` };
    },
    async uploadMedia(scope, targetId, base64, fileType) {
      calls.push({ fn: "uploadMedia", scope, targetId });
      if (failGroupUpload && scope === "group") {
        throw apiError("API 错误 [/v2/groups/g1/files]：no permission");
      }
      const buf = Buffer.from(base64, "base64");
      mediaUploads.push({ scope, targetId, buf, fileType });
      n += 1;
      return `media_fi_${n}`;
    },
    async sendMedia(scope, targetId, fileInfo, opts = {}) {
      calls.push({ fn: "sendMedia", scope, targetId, opts });
      mediaSends.push({ scope, targetId, fileInfo, opts });
      return { id: `media_msg_${n}` };
    },
    async sendMessage(scope, targetId, text) {
      calls.push({ fn: "sendMessage", scope, targetId });
      texts.push(text);
      return { id: `text_${texts.length}` };
    },
    async getGroupMembers() {
      return [];
    },
  };
}

function tmpFile(name) {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "chunhe-sing-state-")), name);
}

/** 造引擎：曲库指向临时目录；持久化文件全部指向临时路径（绝不碰 data/） */
function makeEngine(env = {}, apiOpts = {}) {
  const api = fakeApi(apiOpts);
  return { engine: engineWith(api, env), api, config: buildConfig(env) };
}

function buildConfig(env = {}) {
  return loadConfig({
    QQ_APP_ID: "1",
    QQ_APP_SECRET: "s",
    QQ_SING_ENABLED: "true",
    QQ_MULTI_MESSAGE: "false",
    QQ_AI_LABEL_STYLE: "none",
    AI_LABEL: "",
    SING_LIBRARY_GAP_MS: "0",
    QQ_MEMORY_FILE: tmpFile("memory.json"),
    QQ_TOPIC_FILE: tmpFile("topics.json"),
    QQ_REMINDER_FILE: tmpFile("reminders.json"),
    QQ_OWNER_MEMORY_FILE: tmpFile("owner-memory.json"),
    ...env,
  });
}

/** 用指定的假 api 造引擎（需要自己控制 api 行为时用这个） */
function engineWith(api, env = {}) {
  return new MessageEngine({
    config: buildConfig(env),
    api,
    generate: async () => "好呀～",
    logger,
  });
}

let msgSeq = 0;

function groupMsg(text, over = {}) {
  return {
    scope: "group",
    rawEventType: "GROUP_MESSAGE_CREATE",
    senderId: "u1",
    senderName: "群友甲",
    content: text,
    messageId: `g-${++msgSeq}`,
    groupOpenid: "g1",
    targetId: "g1",
    kind: "text",
    attachments: [],
    ...over,
  };
}

const atMsg = (text, over = {}) =>
  groupMsg(text, { rawEventType: "GROUP_AT_MESSAGE_CREATE", ...over });

function c2cMsg(text, id = `c-${++msgSeq}`) {
  return {
    scope: "c2c",
    rawEventType: "C2C_MESSAGE_CREATE",
    targetId: "user_openid_test",
    senderId: "user_openid_test",
    senderName: "主人",
    messageId: id,
    content: text,
    kind: "text",
    attachments: [],
  };
}

/** 模型编出来的"歌词"——失败的实现会把它当唱歌发出去 */
const FAKE_LYRICS = "晚风吹动樱花草\n月光洒在你眉梢\n想说的话都藏好\n只等你回头笑";

// ---------------------------------------------------------------- 管道选择

test("群聊点歌：走群文件上传 + 群消息发送（不再走 C2C 管道）", async () => {
  const lib = tempLib();
  try {
    const p = lib.write("樱花草_绮萱RVC_57s.silk", 60);
    const { engine, api } = makeEngine({ SING_LIBRARY_DIR: lib.dir });

    const res = await engine.send(groupMsg("唱樱花草"), "好呀～");

    assert.equal(res.action, "replied");
    assert.equal(res.song, true, "群里点歌必须真的唱出来");

    // 群聊：只允许走 uploadMedia("group") / sendMedia("group")
    assert.deepEqual(
      api.calls.filter((c) => c.fn === "uploadC2CFile"),
      [],
      "群聊绝不能调 C2C 上传（/v2/users/{group_openid}/files 是错的）",
    );
    assert.deepEqual(
      api.calls.filter((c) => c.fn === "sendC2CVoice"),
      [],
      "群聊绝不能调 C2C 发送（/v2/users/{group_openid}/messages 是错的）",
    );
    assert.equal(api.mediaUploads.length, 1);
    assert.equal(api.mediaUploads[0].scope, "group");
    assert.equal(api.mediaUploads[0].targetId, "g1", "必须发到 group_openid");
    assert.deepEqual(api.mediaUploads[0].buf, fs.readFileSync(p), "发出去的必须是曲库那份字节");
    assert.equal(api.mediaSends.length, 1);
    assert.equal(api.mediaSends[0].scope, "group");
    assert.equal(api.texts.length, 0, "唱成了就不该再补文字");
  } finally {
    lib.cleanup();
  }
});

test("单聊点歌：仍走 C2C 上传 + 发送（老路径不许改坏）", async () => {
  const lib = tempLib();
  try {
    lib.write("樱花草_绮萱RVC_57s.silk", 60);
    const { engine, api } = makeEngine({ SING_LIBRARY_DIR: lib.dir });

    const res = await engine.send(c2cMsg("唱樱花草"), "好呀～");

    assert.equal(res.song, true);
    assert.equal(api.c2cUploads.length, 1);
    assert.deepEqual(api.calls.filter((c) => c.fn === "uploadMedia"), [], "单聊不该改走群接口");
    assert.equal(api.texts.length, 0);
  } finally {
    lib.cleanup();
  }
});

test("群聊多段歌：按顺序发、msg_seq 严格递增、段间有间隔、全部带 msg_id 被动回复", async () => {
  const lib = tempLib();
  try {
    const p1 = lib.write("樱花草_绮萱RVC_full_1of3.silk", 20);
    const p2 = lib.write("樱花草_绮萱RVC_full_2of3.silk", 25);
    const p3 = lib.write("樱花草_绮萱RVC_full_3of3.silk", 30);
    const { engine, api } = makeEngine({
      SING_LIBRARY_DIR: lib.dir,
      SING_LIBRARY_GAP_MS: "40",
    });

    const startedAt = Date.now();
    const res = await engine.send(groupMsg("唱樱花草"), "好呀～");
    const elapsed = Date.now() - startedAt;

    assert.equal(res.song, true);
    assert.equal(res.segments, 3, "三段都要发出去");
    assert.deepEqual(
      api.mediaUploads.map((u) => u.buf),
      [fs.readFileSync(p1), fs.readFileSync(p2), fs.readFileSync(p3)],
      "必须按 1→2→3 顺序发同样字节",
    );

    const seqs = api.mediaSends.map((s) => s.opts.msgSeq);
    assert.equal(seqs.length, 3);
    for (const s of seqs) assert.equal(typeof s, "number");
    assert.ok(
      seqs[0] < seqs[1] && seqs[1] < seqs[2],
      `同一 msg_id 连续发语音时 msg_seq 必须递增，实际 ${seqs.join(",")}`,
    );
    // 被动回复：每条都带同一条用户消息的 msg_id（不带就是主动消息，会烧配额）
    const msgId = api.mediaSends[0].opts.msgId;
    assert.ok(msgId, "群聊语音必须带 msg_id 走被动回复");
    assert.ok(api.mediaSends.every((s) => s.opts.msgId === msgId));

    assert.ok(elapsed >= 70, `段间应当等一等（3 段 ≥ 2×40ms），实际 ${elapsed}ms`);
    assert.equal(api.texts.length, 0);
  } finally {
    lib.cleanup();
  }
});

// ---------------------------------------------------------------- 诚实（最重要）

test("群聊唱歌失败：绝不把编造的歌词当唱歌发出去，如实说没发出去", async () => {
  const lib = tempLib();
  try {
    lib.write("樱花草_绮萱RVC_57s.silk", 60);
    const { engine, api } = makeEngine(
      { SING_LIBRARY_DIR: lib.dir },
      { failGroupUpload: true },
    );

    const res = await engine.send(groupMsg("唱樱花草"), FAKE_LYRICS);

    assert.notEqual(res.song, true, "没唱成就不许报成唱了");
    assert.equal(api.mediaUploads.length, 0);
    assert.equal(api.texts.length, 1, "失败也必须回一句话，不能静默丢消息");

    const sent = api.texts[0];
    assert.ok(!sent.includes("晚风吹动樱花草"), `不许把编的歌词发出去，实际：${sent}`);
    assert.ok(!sent.includes("月光洒在你眉梢"), "歌词一句都不许漏");
    assert.match(sent, /没发|发不出|没声音|唱不了|没唱成/, `必须如实说唱不出来，实际：${sent}`);
  } finally {
    lib.cleanup();
  }
});

test("单聊唱歌失败：同样不拿歌词冒充（这是全场景规则，不只是群聊）", async () => {
  const lib = tempLib();
  try {
    lib.write("樱花草_绮萱RVC_57s.silk", 60);
    const { engine, api } = makeEngine(
      { SING_LIBRARY_DIR: lib.dir },
      { failC2CUpload: true },
    );

    const res = await engine.send(c2cMsg("唱樱花草"), FAKE_LYRICS);

    assert.notEqual(res.song, true);
    assert.equal(api.texts.length, 1);
    assert.ok(!api.texts[0].includes("晚风吹动樱花草"), "失败时绝不许把歌词当唱歌发");
    assert.match(api.texts[0], /没发|发不出|没声音|唱不了|没唱成/);
  } finally {
    lib.cleanup();
  }
});

test("曲库没这首：说「不会」，绝不合成别的歌顶替、也不编歌词", async () => {
  const lib = tempLib();
  try {
    lib.write("送别_RVC学姐.silk", 40);

    // 造一个"合成必然成功"的假 python：产出的是《稻香》副歌那段 27863ms。
    // 引擎若在"曲库没有"时回落合成，就会拿稻香顶替客人点的歌——必须拦住。
    const synthScript = path.join(lib.dir, "fake_synth.mjs");
    fs.writeFileSync(
      synthScript,
      `import fs from "node:fs";
const i = process.argv.indexOf("--out");
const out = process.argv[i + 1];
const head = Buffer.from("\\x02#!SILK_V3", "binary");
const frames = [head];
for (let n = 0; n < 1393; n += 1) { const l = Buffer.alloc(2); l.writeUInt16LE(8); frames.push(l, Buffer.alloc(8, 7)); }
const end = Buffer.alloc(2); frames.push(end);
fs.writeFileSync(out, Buffer.concat(frames));
console.log(JSON.stringify({ ok: true, duration_ms: 27863 }));`,
    );

    const { engine, api } = makeEngine({
      SING_LIBRARY_DIR: lib.dir,
      SING_TMP_DIR: lib.dir,
      SING_PYTHON: process.execPath,
      SING_SCRIPT: synthScript,
    });

    const res = await engine.send(groupMsg("唱樱花草"), "好呀～");

    assert.notEqual(res.song, true, "曲库没有就不许假装唱了");
    assert.equal(api.mediaUploads.length, 0, "不许把合成出来的稻香发出去");
    assert.equal(api.c2cUploads.length, 0);
    assert.equal(api.texts.length, 1);
    assert.match(api.texts[0], /不会|还没学会|没学会/, `应当直说不会，实际：${api.texts[0]}`);
    assert.ok(api.texts[0].includes("樱花草"), "要说清楚是哪首不会");
  } finally {
    lib.cleanup();
  }
});

test("群聊唱失败后写进记忆的是实话，不是那段歌词", async () => {
  const lib = tempLib();
  try {
    lib.write("樱花草_绮萱RVC_57s.silk", 60);
    const { engine, api } = makeEngine(
      { SING_LIBRARY_DIR: lib.dir },
      { failGroupUpload: true },
    );

    const msg = atMsg("<@!1> 唱首樱花草");
    await engine.handle(msg);

    assert.equal(api.texts.length, 1);
    assert.ok(!api.texts[0].includes("晚风吹动樱花草"));

    const history = engine.memory.get(`group:g1:${msg.senderId}`) ?? [];
    const last = [...history].reverse().find((m) => m.role === "assistant");
    assert.ok(last, "应当记下这一轮回复");
    assert.ok(
      !String(last.content).includes("晚风吹动樱花草"),
      `记忆里不许写成"我唱了那段歌词"，实际：${last.content}`,
    );
  } finally {
    lib.cleanup();
  }
});

test("群聊 @ 前缀不能妨碍点歌识别：@ 了唱没学会的歌 → 说不会，绝不编歌词", async () => {
  const lib = tempLib();
  try {
    lib.write("送别_RVC学姐.silk", 40);
    const { engine, api } = makeEngine({ SING_LIBRARY_DIR: lib.dir });

    // 真实群消息长这样：<@7BB2…> 唱首樱花草听听（见 data/live.log 11:13:15）
    // 曲库里没有《小星星》→ 必须说"不会"，而且要点名是哪首。
    const res = await engine.send(atMsg("<@!1> 唱小星星"), FAKE_LYRICS);
    assert.notEqual(res.song, true);
    assert.equal(api.texts.length, 1);
    assert.ok(!api.texts[0].includes("晚风吹动樱花草"), "更不许拿编的歌词顶上");
    assert.match(api.texts[0], /不会|还没学会|没学会/, `应当直说不会，实际：${api.texts[0]}`);
    assert.ok(api.texts[0].includes("小星星"), `要点名是哪首不会，实际：${api.texts[0]}`);

    // 带「首」的说法同样要点名
    const res2 = await engine.send(atMsg("<@!1> 唱首小星星"), "好呀～");
    assert.notEqual(res2.song, true);
    assert.ok(api.texts[1].includes("小星星"), `带@和「首」时也要点名，实际：${api.texts[1]}`);
  } finally {
    lib.cleanup();
  }
});

test("群聊被动回复被拒时：退一步走主动消息把歌发出去（不让主人白等）", async () => {
  const lib = tempLib();
  try {
    lib.write("樱花草_绮萱RVC_57s.silk", 60);
    const api = fakeApi();
    // 平台拒收「带 msg_id 的语音被动回复」：第一次带 msgId 就抛，不带就成功。
    // （真机上还没验证过群聊语音被动回复，这里保证真遇到时有兜底而不是白丢一首歌。）
    const realSendMedia = api.sendMedia;
    const calls = [];
    api.sendMedia = async (scope, targetId, fileInfo, opts = {}) => {
      calls.push(opts);
      if (opts.msgId) throw apiError("API 错误 [/v2/groups/g1/messages]：msg_id invalid");
      return realSendMedia.call(api, scope, targetId, fileInfo, opts);
    };

    const engine = engineWith(api, { SING_LIBRARY_DIR: lib.dir });
    const res = await engine.send(groupMsg("唱樱花草"), "好呀～");

    assert.equal(res.song, true, "被动回复被拒也要把歌发出去");
    assert.equal(calls.length, 2, "先试被动、再试主动");
    assert.ok(calls[0].msgId, "第一次必须优先被动回复（不烧配额）");
    assert.equal(calls[1].msgId, undefined, "第二次退成主动消息");
    assert.equal(api.mediaSends.length, 1, "最终只成功发出一条，不重复");
    assert.equal(api.texts.length, 0, "唱成了就不该再补文字");
  } finally {
    lib.cleanup();
  }
});

test("唱歌失败的那句实话也要带 AI 标识（合规包装不能被绕过）", async () => {
  const lib = tempLib();
  try {
    lib.write("樱花草_绮萱RVC_57s.silk", 60);
    const { engine, api } = makeEngine(
      { SING_LIBRARY_DIR: lib.dir, AI_LABEL_STYLE: "prefix", AI_LABEL: "【AI】" },
      { failGroupUpload: true },
    );
    await engine.send(groupMsg("唱樱花草"), FAKE_LYRICS);
    assert.equal(api.texts.length, 1);
    assert.ok(
      api.texts[0].startsWith("【AI】"),
      `失败回复也必须带 AI 明示标识，实际：${api.texts[0]}`,
    );
  } finally {
    lib.cleanup();
  }
});

// ---------------------------------------------------------------- 人格层

test("人格层硬规则：唱歌必须真发语音，发不出来就如实说，不许拿歌词冒充", () => {
  const prompt = CHUNHE_SYSTEM_PROMPT;
  assert.match(
    prompt,
    /绝对不许把歌词当/,
    "提示词里必须有「不许把歌词当成唱歌」的硬规则（模型编歌词冒充唱歌的源头）",
  );
  assert.match(prompt, /发不出来就如实说/, "必须写明发不出来要如实说");
  assert.match(prompt, /还没学会/, "必须给出「还没学会」这种诚实的说法");
  assert.match(prompt, /群里/, "必须说明群里发不外的情况，而不是让模型自己编");
});

// ---------------------------------------------------------------- 群触发条件

test("群聊触发：@ 了才唱，不 @ 不回应（这是设计，不是 bug）", async () => {
  const lib = tempLib();
  try {
    lib.write("樱花草_绮萱RVC_57s.silk", 60);
    const { engine, api } = makeEngine({ SING_LIBRARY_DIR: lib.dir });

    // 不 @：mention 模式下不该回应，更不该发歌
    const quiet = await engine.handle(groupMsg("唱首樱花草"));
    assert.equal(quiet.action, "skipped", "群里不 @ 不该回应");
    assert.equal(api.mediaUploads.length, 0, "没被叫到就更不许唱歌");

    // @ 了：必须回应，而且是真唱
    const loud = await engine.handle(atMsg("<@!1> 唱首樱花草"));
    assert.equal(loud.action, "replied");
    assert.equal(loud.song, true, "群里 @ 点歌必须真的唱");
    assert.equal(api.mediaUploads.length, 1);
    assert.equal(api.mediaUploads[0].scope, "group");
  } finally {
    lib.cleanup();
  }
});
