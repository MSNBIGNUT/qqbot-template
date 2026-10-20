/**
 * 存图 + 多用表情包（2026-10-19 新能力）。
 *
 * 用户原话：「可以适当多些表情包回应……顺带增加存图的能力，比如我看到有个表情挺好玩的，
 * 可以让她存进她的表情库」
 *
 * 锁死的行为：
 *   1. 主人发图 + 「存下来」→ 真的写进表情库、能被 listStickers 列出、README 记来源；
 *   2. 图在前、指令在后的**两条消息**也能接上；
 *   3. 没指令不存；只有指令没图 → 问清楚，不假装存；
 *   4. 过大（可缩则缩、不能缩则如实拒）、非法格式、超上限、多图 → 不静默入库；
 *   5. 命名：指定 / 从原话提取 / 时间戳兜底；同名加后缀；同名不同图不覆盖；
 *   6. 内容审不了就如实标记（未审），有审核钩子时不当图不入库；
 *   7. 轻松场合会自动补一张表情，严肃场合不发，连续发表情有硬阈值；
 *   8. 人格层有【多用表情包】一节，并且不再声称「存不了图」。
 *
 * 全部离线：假 api、临时目录、不碰 data/、不发真实 QQ 消息。
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { MessageEngine } from "../src/core/engine.js";
import { loadConfig } from "../src/config.js";
import { createLogger } from "../src/util/log.js";
import {
  readImageSize,
  resolveStickerConfig,
  listStickers,
} from "../src/media/stickers.js";
import {
  detectStickerSaveRequest,
  inferStickerName,
  saveStickerBuffer,
} from "../src/media/sticker-ingest.js";
import {
  StickerMoodBudget,
  detectStickerMood,
  isSeriousScene,
} from "../src/media/sticker-mood.js";
import { CHUNHE_SYSTEM_PROMPT } from "../src/persona/chunhe.js";

const logger = createLogger("silent");
const OWNER = "OWNER_STICKER_INGEST_0001";
const MEMBER = "MEMBER_STICKER_INGEST_0002";

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "qqbot-sticker-ingest-"));
}

/** 最小合法 JPEG 头（readImageSize 只解 SOF，不需要真像素） */
function jpeg(width = 128, height = 128, pad = 0) {
  const head = Buffer.from([
    0xff, 0xd8,
    0xff, 0xc0, 0x00, 0x0b, 0x08,
    (height >> 8) & 0xff, height & 0xff,
    (width >> 8) & 0xff, width & 0xff,
    0x01, 0x01, 0x11, 0x00,
    0xff, 0xd9,
  ]);
  return pad > 0 ? Buffer.concat([head, Buffer.alloc(pad)]) : head;
}

function png(width = 128, height = 128) {
  const b = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.write("IHDR", 12, "latin1");
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return b;
}

function webpVp8x(width = 128, height = 128) {
  const b = Buffer.alloc(30);
  b.write("RIFF", 0, "latin1");
  b.writeUInt32LE(22, 4);
  b.write("WEBP", 8, "latin1");
  b.write("VP8X", 12, "latin1");
  b.writeUIntLE(width - 1, 24, 3);
  b.writeUIntLE(height - 1, 27, 3);
  return b;
}

function cfgOf(dir, extra = {}) {
  return {
    enabled: true,
    dir,
    maxBytes: 2 * 1024 * 1024,
    maxCount: 200,
    auto: true,
    ...extra,
  };
}

function listImageFiles(dir) {
  try {
    return fs.readdirSync(dir).filter((n) => /\.(?:png|jpe?g|webp|gif)$/i.test(n));
  } catch {
    return [];
  }
}

async function save(buf, cfg, opts = {}) {
  return saveStickerBuffer({
    buf,
    caption: opts.caption ?? "这个好玩，存下来",
    name: opts.name,
    cfg,
    deps: { now: () => new Date(2026, 9, 19, 17, 6), ...opts.deps },
  });
}

// ---------------------------------------------------------------------------
// 1) 触发识别与命名
// ---------------------------------------------------------------------------

test("存图：认得「存下来/存进表情库/收下这张/把这张记住/当表情包」这些话", () => {
  for (const t of [
    "这个好玩，存下来",
    "存进你的表情库",
    "这个以后用",
    "收下这张",
    "把这张记住",
    "这个当你的表情包",
    "以后有人要床照就发这张",
    "收藏一下",
  ]) {
    const r = detectStickerSaveRequest(t);
    assert.ok(r, `应识别为存图指令：${t}`);
  }
  for (const t of ["存不存在这个问题", "别存了", "不用存", "今天天气不错", "这个文件在哪"]) {
    assert.equal(detectStickerSaveRequest(t), null, `不该当成存图指令：${t}`);
  }
});

test("存图：主人指定名字时优先用指定的", () => {
  assert.equal(detectStickerSaveRequest("这个好玩，叫它狗头，存下来").name, "狗头");
  assert.equal(detectStickerSaveRequest("存进表情库，名字叫「地铁老人」").name, "地铁老人");
  assert.equal(detectStickerSaveRequest("这个以后用").name, "");
});

test("存图：没指定名字时从原话里提取一个有意义的名字", () => {
  assert.equal(inferStickerName("这个好玩，存下来"), "好玩");
  assert.equal(inferStickerName("以后有人要床照就发这张"), "床照");
  assert.equal(inferStickerName("这个当你的表情包"), "");
  assert.equal(inferStickerName("把这张记住"), "");
});

test("存图：能读出 WebP 的尺寸（新增格式）", () => {
  const size = readImageSize(webpVp8x(256, 64));
  assert.deepEqual(size && { w: size.width, h: size.height, f: size.format }, { w: 256, h: 64, f: "webp" });
});

// ---------------------------------------------------------------------------
// 2) 落盘：校验、命名冲突、上限、去重、内容标记
// ---------------------------------------------------------------------------

test("存图：合法图片真的写进目录、能被 listStickers 列出、README 记来源", async () => {
  const dir = tmpDir();
  const cfg = cfgOf(dir);
  const res = await save(png(128, 128), cfg, { name: "狗头" });

  assert.equal(res.ok, true, res.message);
  assert.equal(res.name, "狗头");
  assert.equal(res.file, "狗头.png");
  assert.ok(fs.existsSync(path.join(dir, "狗头.png")), "文件必须真的落盘");

  const names = (await listStickers(cfg)).map((s) => s.name);
  assert.ok(names.includes("狗头"), `listStickers 应列出新图：${names.join(",")}`);

  const readme = fs.readFileSync(path.join(dir, "README.md"), "utf8");
  assert.match(readme, /主人教的/);
  assert.match(readme, /狗头\.png/);
  assert.match(res.message, /存下了，叫它「狗头」/);
  assert.match(res.message, /主人教的/);
  assert.match(res.message, /看不出内容/, "没有审核钩子时必须如实说没审，不能装作审核过");
});

test("存图：同名不同图加后缀，不覆盖已有素材", async () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, "开心.png"), png(128, 128));
  const res = await save(jpeg(128, 128), cfgOf(dir), { name: "开心" });
  assert.equal(res.ok, true, res.message);
  assert.equal(res.file, "开心-2.jpg", "同名要加后缀，并且扩展名按真实格式");
  assert.ok(fs.existsSync(path.join(dir, "开心.png")), "旧文件不能被覆盖");
});

test("存图：同一张图重复存时认出来，不重复占位", async () => {
  const dir = tmpDir();
  const cfg = cfgOf(dir);
  const buf = png(128, 128);
  const first = await save(buf, cfg, { name: "狗头" });
  const second = await save(buf, cfg, { name: "狗头二号" });
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(second.duplicate, true);
  assert.equal(second.name, "狗头", "重复时应报已有的名字");
  assert.equal(listImageFiles(dir).length, 1);
});

test("存图：超过大小上限且缩不了 → 如实拒绝，不落盘", async () => {
  const dir = tmpDir();
  const cfg = cfgOf(dir, { maxBytes: 1024 });
  const res = await save(jpeg(600, 600, 4096), cfg, {
    name: "大图",
    deps: { resizeImage: async () => null },
  });
  assert.equal(res.ok, false);
  assert.equal(res.code, "too_large");
  assert.match(res.message, /超过|太大|上限/);
  assert.equal(listImageFiles(dir).length, 0);
});

test("存图：过大但能缩放时缩到 128 再存（和大表情库一致）", async () => {
  const dir = tmpDir();
  const cfg = cfgOf(dir, { maxBytes: 1024 });
  let calledWith = null;
  const res = await save(jpeg(600, 600, 4096), cfg, {
    name: "大图",
    deps: {
      resizeImage: async (buf, opts) => {
        calledWith = opts;
        return { buf: jpeg(128, 128), format: "jpeg", width: 128, height: 128 };
      },
    },
  });
  assert.equal(res.ok, true, res.message);
  assert.equal(res.resized, true);
  assert.equal(res.width, 128);
  assert.equal(res.height, 128);
  assert.ok(calledWith, "缩放函数应被调用");
  const size = readImageSize(fs.readFileSync(path.join(dir, res.file)));
  assert.deepEqual([size.width, size.height], [128, 128]);
  assert.match(res.message, /缩到 128/);
});

test("存图：非法格式拒绝（不是图片就不收）", async () => {
  const dir = tmpDir();
  const res = await save(Buffer.from("这不是图片，是一段文字"), cfgOf(dir), { name: "假图" });
  assert.equal(res.ok, false);
  assert.equal(res.code, "invalid_format");
  assert.equal(listImageFiles(dir).length, 0);
});

test("存图：超过张数上限时提示，不写盘", async () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, "已有.png"), png(128, 128));
  const res = await save(png(128, 128), cfgOf(dir, { maxCount: 1 }), { name: "新的" });
  assert.equal(res.ok, false);
  assert.equal(res.code, "limit");
  assert.match(res.message, /上限|满/);
  assert.equal(listImageFiles(dir).length, 1);
});

test("存图：审核钩子判定不当 → 不入库，并明确告诉主人", async () => {
  const dir = tmpDir();
  const res = await save(png(128, 128), cfgOf(dir), {
    name: "不合适",
    deps: { moderate: async () => ({ safe: false, reason: "疑似真人裸露" }) },
  });
  assert.equal(res.ok, false);
  assert.equal(res.code, "moderated");
  assert.match(res.message, /不合适|没放/);
  assert.match(res.message, /真人裸露/);
  assert.equal(listImageFiles(dir).length, 0, "不能静默入库");
});

test("存图：默认按扩展名/真实格式一致落盘（QQ 常见 png 其实是 jpeg）", async () => {
  const dir = tmpDir();
  const res = await save(jpeg(128, 128), cfgOf(dir), { name: "伪装的图" });
  assert.equal(res.file, "伪装的图.jpg");
  assert.equal(readImageSize(fs.readFileSync(path.join(dir, res.file))).format, "jpeg");
});

// ---------------------------------------------------------------------------
// 3) 引擎接入：两条消息、不存、多图、非主人
// ---------------------------------------------------------------------------

function fakeApi() {
  const sent = [];
  const mediaUploads = [];
  const mediaSends = [];
  let n = 0;
  return {
    sent,
    mediaUploads,
    mediaSends,
    async sendMessage(scope, targetId, content, opts = {}) {
      sent.push({ scope, targetId, content, msgId: opts.msgId });
      return { id: `t-${sent.length}`, content };
    },
    async sendProactiveMessage(scope, targetId, content) {
      sent.push({ scope, targetId, content, proactive: true });
      return { id: `p-${sent.length}`, content };
    },
    async uploadMedia(scope, targetId, base64, fileType) {
      mediaUploads.push({ scope, targetId, fileType, buf: Buffer.from(base64, "base64") });
      n += 1;
      return `fi_${n}`;
    },
    async sendMedia(scope, targetId, fileInfo, opts = {}) {
      mediaSends.push({ scope, targetId, fileInfo, opts });
      return { id: `m-${mediaSends.length}` };
    },
    async getGroupMembers() {
      return [];
    },
  };
}

function makeEngine({ dir = tmpDir(), stickers = {}, generate, stickerDeps, api = fakeApi() } = {}) {
  const config = loadConfig({
    QQ_APP_ID: "test-app-id",
    QQ_APP_SECRET: "test-app-secret",
    QQ_GROUP_TRIGGER: "wake",
    QQ_ADMIN_USERS: OWNER,
    QQ_MEMORY_FILE: path.join(dir, "memory.json"),
    QQ_TOPIC_FILE: path.join(dir, "topics.json"),
    QQ_OWNER_MEMORY_FILE: path.join(dir, "owner-memory.json"),
    QQ_PENDING_FILE: path.join(dir, "pending-actions.json"),
    QQ_REMINDER_FILE: path.join(dir, "reminders.json"),
    QQ_GROUPS_FILE: path.join(dir, "groups.json"),
    QQ_PROACTIVE_QUOTA_FILE: path.join(dir, "proactive-quota.json"),
    QQ_REMINDERS: "false",
    QQ_MULTI_MESSAGE: "false",
    QQ_VOICE_REPLY: "off",
    QQ_SING_ENABLED: "false",
    QQ_PROACTIVE: "false",
    QQ_RATE_LIMIT_PER_MINUTE: "1000",
    STICKER_DIR: dir,
    STICKER_AUTO: stickers.auto ?? "false",
    ...(stickers.env ?? {}),
  });
  const engine = new MessageEngine({
    config,
    api,
    logger,
    generate: generate ?? (async () => "在呀"),
    stickerDeps,
  });
  return { engine, api, dir, config };
}

let seq = 0;
function c2c(text, attachments = [], openid = OWNER) {
  seq += 1;
  return {
    scope: "c2c",
    targetId: openid,
    senderId: openid,
    senderName: openid === OWNER ? "主人" : "路人",
    messageId: `ingest-${seq}`,
    content: text,
    kind: attachments.length ? "image" : "text",
    attachments,
  };
}

const imageAttachment = (url = "https://fake.local/sticker.jpg") => [
  { content_type: "image/jpeg", url, filename: "sticker.jpg" },
];

function imageFetch(buf, contentType = "image/jpeg") {
  return async () => ({
    ok: true,
    status: 200,
    headers: { get: (n) => (n.toLowerCase() === "content-type" ? contentType : null) },
    arrayBuffer: async () => buf,
  });
}

test("引擎：图在前、指令在后两条消息 → 能接上并真的存下", async () => {
  const dir = tmpDir();
  const buf = png(128, 128);
  const { engine, api } = makeEngine({ dir, stickerDeps: { fetchImpl: imageFetch(buf) } });

  await engine.handle(c2c("这个好玩", imageAttachment()));
  assert.equal(listImageFiles(dir).length, 0, "只发图没指令时不该存");

  const res = await engine.handle(c2c("存下来"));
  assert.equal(res.action, "replied", "要真的回一句回执");
  assert.equal(listImageFiles(dir).length, 1);
  const names = (await listStickers(cfgOf(dir))).map((s) => s.name);
  assert.ok(names.includes("好玩"), `命名应接上图前的原话：${names.join(",")}`);
  assert.match(api.sent.at(-1).content, /存下了，叫它「好玩」/);
  assert.match(api.sent.at(-1).content, /主人教的/);
});

test("引擎：同一条消息里图 + 指令 → 直接存，不经过模型", async () => {
  const dir = tmpDir();
  let generated = 0;
  const { engine, api } = makeEngine({
    dir,
    generate: async () => {
      generated += 1;
      return "不该被调用";
    },
    stickerDeps: { fetchImpl: imageFetch(png(128, 128)) },
  });
  await engine.handle(c2c("这个好玩，存下来", imageAttachment()));
  assert.equal(generated, 0, "存图回执必须确定性，不能交给模型编");
  assert.equal(listImageFiles(dir).length, 1);
  assert.match(api.sent.at(-1).content, /存下了，叫它「好玩」/);
});

test("引擎：只有指令没有图 → 问清楚，不假装存了", async () => {
  const dir = tmpDir();
  const { engine, api } = makeEngine({ dir });
  await engine.handle(c2c("存下来"));
  assert.equal(listImageFiles(dir).length, 0);
  assert.match(api.sent.at(-1).content, /图呢|先把.*图|发.*图/);
  assert.ok(!/存下了/.test(api.sent.at(-1).content), "没有图绝不许说存下了");
});

test("引擎：一条消息多张图 → 先问存哪张，不擅自挑", async () => {
  const dir = tmpDir();
  const { engine, api } = makeEngine({
    dir,
    stickerDeps: { fetchImpl: imageFetch(png(128, 128)) },
  });
  await engine.handle(
    c2c("存下来", [
      { content_type: "image/jpeg", url: "https://fake.local/a.jpg" },
      { content_type: "image/png", url: "https://fake.local/b.png" },
    ]),
  );
  assert.equal(listImageFiles(dir).length, 0, "多图时一张都不该存");
  assert.match(api.sent.at(-1).content, /哪张|哪一个|哪一张/, "要问存哪一张");
});

test("表情包：轻松场景能识别，技术/难过/正经场景不碰", () => {
  assert.equal(detectStickerMood("嗨")?.mood, "greeting");
  assert.equal(detectStickerMood("在吗？")?.mood, "greeting");
  assert.equal(detectStickerMood("你好可爱")?.mood, "praise");
  assert.equal(detectStickerMood("哈哈哈哈")?.mood, "laugh");
  assert.equal(detectStickerMood("晚安")?.mood, "night");
  assert.equal(detectStickerMood("谢谢你")?.mood, "thanks");
  assert.equal(detectStickerMood("滚，变态")?.mood, "speechless");

  // ⚠️ 2026-10-19 语义变更：主人要求「触发条件不需要关键词，弱关联，让她学着怎么用表情」。
  //    没命中关键词的闲聊不再返回 null，而是 casual（弱关联）；具体发哪张交给她和好感度决定。
  assert.equal(detectStickerMood("今天天气不错")?.mood, "casual", "闲聊走弱关联");
  assert.equal(detectStickerMood("我刚吃完饭")?.mood, "casual");

  // 仍然**不发**的：任务指令、做题、长文
  assert.equal(detectStickerMood("用语音说句晚安"), null, "任务指令（语音）不是闲聊");
  assert.equal(detectStickerMood("唱首樱花草"), null, "歌名里的「草」不该被当成大笑");
  assert.equal(detectStickerMood("这道题怎么算"), null, "做题场景不该发表情");
  assert.equal(detectStickerMood("今天天气不错呀我们一起出去走走吧听说附近新开了一家书店环境挺好的我们可以先去逛一圈然后找个地方坐下来喝点东西聊聊天"), null, "长文（57 字 > 40）不当闲聊");

  assert.equal(isSeriousScene("帮我看看这段代码为什么报错"), true);
  assert.equal(isSeriousScene("我有点难过"), true);
  assert.equal(isSeriousScene("在吗"), false);
  assert.equal(isSeriousScene("你好可爱"), false);
});

test("表情包：连续发表情有硬阈值（不是每条都发）", () => {
  let now = 1000;
  const b = new StickerMoodBudget({ cooldownTurns: 3, maxPerHour: 10, now: () => now });
  assert.equal(b.canSend("s"), true, "第一次可以发");
  b.record("s");
  b.noteTurn("s");
  assert.equal(b.canSend("s"), false, "刚发完的下一条不许再发");
  b.noteTurn("s");
  assert.equal(b.canSend("s"), false);
  b.noteTurn("s");
  assert.equal(b.canSend("s"), true, "隔 3 轮才允许再发");
});

test("表情包：轻松场合会自动补一张，且和文字一起发", async () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, "春禾-开心.jpg"), jpeg(128, 128));
  const { engine, api } = makeEngine({ dir, stickers: { auto: "true" } });
  await engine.handle(c2c("嗨"));
  assert.equal(api.mediaUploads.length, 1, "打招呼应补一张表情");
  assert.ok(api.sent.at(-1).content.length > 0, "文字照发");
});

test("表情包：严肃场合不发（技术问题/难过）", async () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, "春禾-开心.jpg"), jpeg(128, 128));
  const { engine, api } = makeEngine({ dir, stickers: { auto: "true" } });
  await engine.handle(c2c("帮我看看这段代码为什么报错"));
  await engine.handle(c2c("我有点难过"));
  assert.equal(api.mediaUploads.length, 0, "严肃场合不该甩表情");
});

test("表情包：连发三条时只发送第一条（有节制）", async () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, "春禾-开心.jpg"), jpeg(128, 128));
  const { engine, api } = makeEngine({ dir, stickers: { auto: "true" } });
  await engine.handle(c2c("嗨"));
  await engine.handle(c2c("哈哈哈"));
  await engine.handle(c2c("谢谢你"));
  assert.equal(api.mediaUploads.length, 1, "连续三条里只允许一张表情");
  assert.equal(api.sent.length, 3, "但三条文字都要回");
});

test("表情包：用户明确要表情时只发一张，自动补一张不重复", async () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, "春禾-比心.jpg"), jpeg(128, 128));
  const { engine, api } = makeEngine({ dir, stickers: { auto: "true" } });
  await engine.handle(c2c("发个比心"));
  assert.equal(api.mediaUploads.length, 1, "明确请求 + 自动补图不能发两张");
});

test("表情包：STICKER_AUTO=false 时不做自动补图（保留开关）", async () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, "春禾-开心.jpg"), jpeg(128, 128));
  const { engine, api } = makeEngine({ dir, stickers: { auto: "false" } });
  await engine.handle(c2c("嗨"));
  assert.equal(api.mediaUploads.length, 0);
});

// ---------------------------------------------------------------------------
// 5) 人格层
// ---------------------------------------------------------------------------

test("人格层：新增【多用表情包】一节，且不再声称存不了图", () => {
  assert.match(CHUNHE_SYSTEM_PROMPT, /【多用表情包（让对话轻松）】/);
  assert.match(CHUNHE_SYSTEM_PROMPT, /连续 3 条/);
  assert.match(CHUNHE_SYSTEM_PROMPT, /别在严肃场合发表情/);
  assert.ok(!/没有保存用户图片的能力/.test(CHUNHE_SYSTEM_PROMPT), "能力已实现，提示词不能再说做不到");
  assert.match(CHUNHE_SYSTEM_PROMPT, /存进(?:你的)?表情库|存下来/);
});

// 让 linter/测试都明确用上 fsp（部分用例读目录时使用）
test("存图：测试辅助自检", async () => {
  const dir = tmpDir();
  await fsp.writeFile(path.join(dir, "x.png"), png());
  assert.deepEqual(await fsp.readdir(dir), ["x.png"]);
});
