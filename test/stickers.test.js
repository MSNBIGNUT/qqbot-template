/**
 * 表情包发送：全离线打桩，不碰网络也不碰真实素材目录。
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  STICKER_TOOL_NAME,
  DEFAULT_STICKER_MAX_BYTES,
  resolveStickerConfig,
  stickerNamesOf,
  listStickers,
  buildStickerTool,
  executeStickerCall,
  readImageSize,
  detectStickerRequest,
  pickStickerName,
} from "../src/media/stickers.js";
import { QQApi, IMAGE_FILE_TYPE } from "../src/qq/api.js";

/** 假的目录项：只有名字，全都当文件 */
function dir(...names) {
  return async () => names.map((name) => ({ name, isFile: () => true }));
}
function dirEnoent() {
  return async () => {
    throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
  };
}

const PNG = Buffer.from("FAKEPNGDATA");

test("stickers: 文件名即名字，支持逗号写多个别名", () => {
  assert.deepEqual(stickerNamesOf("开心.png"), ["开心"]);
  assert.deepEqual(stickerNamesOf("开心,高兴,笑.png"), ["开心", "高兴", "笑"]);
  assert.deepEqual(stickerNamesOf("开心，高兴.jpg"), ["开心", "高兴"]);
  assert.deepEqual(stickerNamesOf("noext"), ["noext"]);
});

test("stickers: 默认配置指向 assets/stickers，且默认开启", () => {
  const cfg = resolveStickerConfig({});
  assert.equal(cfg.enabled, true);
  assert.match(cfg.dir.replace(/\\/g, "/"), /assets\/stickers$/);
  assert.equal(cfg.maxBytes, DEFAULT_STICKER_MAX_BYTES);
});

test("stickers: STICKER_ENABLED=false 可关掉", () => {
  assert.equal(resolveStickerConfig({ STICKER_ENABLED: "false" }).enabled, false);
  assert.equal(resolveStickerConfig({ STICKER_ENABLED: "FALSE" }).enabled, false);
  assert.equal(resolveStickerConfig({ STICKER_ENABLED: "true" }).enabled, true);
});

test("stickers: 自定义目录（相对路径挂到项目根，绝对路径原样用）", () => {
  const rel = resolveStickerConfig({ STICKER_DIR: "my/stickers" });
  assert.match(rel.dir.replace(/\\/g, "/"), /my\/stickers$/);
  const abs = resolveStickerConfig({ STICKER_DIR: "C:/abs/stickers" });
  assert.match(abs.dir.replace(/\\/g, "/"), /^C:\/abs\/stickers$/);
});

test("stickers: 扫目录时跳过非图片文件（README.md 不该被当成表情包）", async () => {
  const cfg = resolveStickerConfig({});
  const got = await listStickers(cfg, {
    readdir: dir("README.md", "开心.png", "无语.JPG", "notes.txt", "点赞.gif"),
  });
  assert.deepEqual(
    got.map((s) => s.name),
    ["开心", "无语", "点赞"].sort((a, b) => a.localeCompare(b, "zh")),
  );
  assert.ok(got.every((s) => s.file !== "README.md"));
});

test("stickers: 目录不存在时返回空数组，不抛异常（还没放素材是常态）", async () => {
  const cfg = resolveStickerConfig({});
  assert.deepEqual(await listStickers(cfg, { readdir: dirEnoent() }), []);
});

test("stickers: 关掉功能时连目录都不扫", async () => {
  const cfg = resolveStickerConfig({ STICKER_ENABLED: "false" });
  let called = false;
  const got = await listStickers(cfg, {
    readdir: async () => {
      called = true;
      return [];
    },
  });
  assert.deepEqual(got, []);
  assert.equal(called, false, "关掉后不该再碰文件系统");
});

test("stickers: 没有素材时不注册工具（否则模型每轮都调一个必然失败的工具）", () => {
  assert.equal(buildStickerTool([]), null);
  assert.equal(buildStickerTool(null), null);
});

test("stickers: 工具定义把可用名字写进 enum（模型就不会瞎编名字）", () => {
  const tool = buildStickerTool(["无语", "开心", "点赞"]);
  assert.equal(tool.function.name, STICKER_TOOL_NAME);
  const en = tool.function.parameters.properties.name.enum;
  // 两侧用同一个比较器，别让排序方式本身成为被测对象
  assert.deepEqual([...en].sort(), ["无语", "开心", "点赞"].sort());
  assert.deepEqual(tool.function.parameters.required, ["name"]);
});

test("stickers: listStickers 的输出顺序稳定，与目录返回顺序无关", async () => {
  const cfg = resolveStickerConfig({});
  const a = await listStickers(cfg, { readdir: dir("无语.png", "开心.png", "点赞.png") });
  const b = await listStickers(cfg, { readdir: dir("点赞.png", "开心.png", "无语.png") });
  assert.deepEqual(a.map((s) => s.name), b.map((s) => s.name), "两次扫出的顺序应一致");
  assert.deepEqual(
    a.map((s) => s.name),
    ["无语", "开心", "点赞"].sort((x, y) => x.localeCompare(y, "zh")),
  );
});

test("stickers: 发一个存在的表情包 → 返回可发送的图片", async () => {
  const cfg = resolveStickerConfig({});
  const res = await executeStickerCall(
    STICKER_TOOL_NAME,
    JSON.stringify({ name: "开心" }),
    cfg,
    { readdir: dir("开心.png"), readFile: async () => PNG, logger: null },
  );
  assert.equal(res.ok, true);
  assert.equal(res.images.length, 1);
  assert.equal(res.images[0].base64, PNG.toString("base64"));
  assert.equal(res.images[0].mime, "image/png");
  assert.equal(res.images[0].name, "开心");
});

test("stickers: 别名（逗号写法）也能命中同一个文件", async () => {
  const cfg = resolveStickerConfig({});
  const res = await executeStickerCall(
    STICKER_TOOL_NAME,
    JSON.stringify({ name: "高兴" }),
    cfg,
    { readdir: dir("开心,高兴,笑.png"), readFile: async () => PNG },
  );
  assert.equal(res.ok, true);
  assert.equal(res.images[0].name, "高兴");
});

test("stickers: 名字写错了 → 失败并把可选名字告诉模型，让它自己纠正", async () => {
  const cfg = resolveStickerConfig({});
  const res = await executeStickerCall(
    STICKER_TOOL_NAME,
    JSON.stringify({ name: "愤怒" }),
    cfg,
    { readdir: dir("开心.png", "无语.png"), readFile: async () => PNG },
  );
  assert.equal(res.ok, false);
  assert.match(res.content, /没有叫「愤怒」/);
  assert.match(res.content, /开心/);
  assert.match(res.content, /无语/);
});

test("stickers: 缺 name 参数时明确报错，不猜", async () => {
  const cfg = resolveStickerConfig({});
  const res = await executeStickerCall(STICKER_TOOL_NAME, "{}", cfg, { readdir: dir("开心.png") });
  assert.equal(res.ok, false);
  assert.match(res.content, /缺少 name/);
});

test("stickers: 参数不是合法 JSON 时不抛异常", async () => {
  const cfg = resolveStickerConfig({});
  const res = await executeStickerCall(STICKER_TOOL_NAME, "{坏掉的", cfg, { readdir: dir("开心.png") });
  assert.equal(res.ok, false);
  assert.match(res.content, /JSON/);
});

test("stickers: 超过大小上限时拒绝，并说明原因", async () => {
  const cfg = { ...resolveStickerConfig({}), maxBytes: 1024 };
  const res = await executeStickerCall(
    STICKER_TOOL_NAME,
    JSON.stringify({ name: "开心" }),
    cfg,
    { readdir: dir("开心.png"), readFile: async () => Buffer.alloc(2048) },
  );
  assert.equal(res.ok, false);
  assert.match(res.content, /上限/);
});

test("stickers: 文件读不出来时降级为文字，不抛", async () => {
  const cfg = resolveStickerConfig({});
  const res = await executeStickerCall(
    STICKER_TOOL_NAME,
    JSON.stringify({ name: "开心" }),
    cfg,
    {
      readdir: dir("开心.png"),
      readFile: async () => {
        throw Object.assign(new Error("EACCES"), { code: "EACCES" });
      },
    },
  );
  assert.equal(res.ok, false);
  assert.match(res.content, /读不出来/);
});

test("stickers: 空文件也当失败处理", async () => {
  const cfg = resolveStickerConfig({});
  const res = await executeStickerCall(
    STICKER_TOOL_NAME,
    JSON.stringify({ name: "开心" }),
    cfg,
    { readdir: dir("开心.png"), readFile: async () => Buffer.alloc(0) },
  );
  assert.equal(res.ok, false);
  assert.match(res.content, /空文件/);
});

test("stickers: 功能关掉后调用会被明确拒绝", async () => {
  const cfg = resolveStickerConfig({ STICKER_ENABLED: "false" });
  const res = await executeStickerCall(STICKER_TOOL_NAME, '{"name":"开心"}', cfg, {
    readdir: dir("开心.png"),
  });
  assert.equal(res.ok, false);
  assert.match(res.content, /未启用/);
});

test("stickers: 别的工具名交给别人处理", async () => {
  const res = await executeStickerCall("generate_image", "{}", resolveStickerConfig({}), {});
  assert.equal(res.ok, false);
  assert.match(res.content, /未知工具/);
});

test("stickers: 目录空时给出「还没素材」而不是崩", async () => {
  const cfg = resolveStickerConfig({});
  const res = await executeStickerCall(STICKER_TOOL_NAME, '{"name":"开心"}', cfg, {
    readdir: dir("README.md"),
  });
  assert.equal(res.ok, false);
  assert.match(res.content, /还没有素材/);
});

// ---------------------------------------------------------------- 像素尺寸

/** 造一个最小可解析的 PNG 头（只到 IHDR，够读宽高了） */
function pngHeader(w, h) {
  const b = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8); // IHDR 长度
  b.write("IHDR", 12);
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return b;
}

test("stickers: 能读出 PNG 的尺寸", () => {
  const s = readImageSize(pngHeader(128, 96));
  assert.deepEqual({ w: s.width, h: s.height, f: s.format }, { w: 128, h: 96, f: "png" });
});

test("stickers: 能读出 GIF 的尺寸（小端）", () => {
  const b = Buffer.alloc(13);
  b.write("GIF89a", 0, "ascii");
  b.writeUInt16LE(300, 6);
  b.writeUInt16LE(200, 8);
  const s = readImageSize(b);
  assert.deepEqual({ w: s.width, h: s.height, f: s.format }, { w: 300, h: 200, f: "gif" });
});

test("stickers: 能跳过 APP0/DHT 找到 JPEG 的 SOF，读出尺寸", () => {
  // SOI + APP0(长度16) + DHT(0xC4，必须跳过) + SOF0(0xC0)
  const head = Buffer.alloc(2 + 18 + 4 + 11);
  head.writeUInt16BE(0xffd8, 0); // SOI
  head.writeUInt16BE(0xffe0, 2); // APP0
  head.writeUInt16BE(16, 4); // 该段长度 16
  let o = 2 + 2 + 16;
  head.writeUInt16BE(0xffc4, o); // DHT（非 SOF，必须跳过）
  head.writeUInt16BE(4, o + 2);
  o += 2 + 4;
  head.writeUInt16BE(0xffc0, o); // SOF0
  head.writeUInt16BE(11, o + 2);
  head[o + 4] = 8; // 精度
  head.writeUInt16BE(240, o + 5); // 高
  head.writeUInt16BE(320, o + 7); // 宽
  const s = readImageSize(head);
  assert.deepEqual({ w: s.width, h: s.height, f: s.format }, { w: 320, h: 240, f: "jpeg" });
});

test("stickers: 认不出的数据返回 null，不抛", () => {
  assert.equal(readImageSize(Buffer.from("not an image at all")), null);
  assert.equal(readImageSize(Buffer.alloc(0)), null);
  assert.equal(readImageSize(null), null);
});

test("stickers: 发送时把像素尺寸带在结果里（便于排查显示过大）", async () => {
  const cfg = resolveStickerConfig({});
  const res = await executeStickerCall(STICKER_TOOL_NAME, '{"name":"开心"}', cfg, {
    readdir: dir("开心.png"),
    readFile: async () => pngHeader(128, 128),
  });
  assert.equal(res.ok, true);
  assert.equal(res.images[0].width, 128);
  assert.equal(res.images[0].height, 128);
});

test("stickers: 素材没缩小（超大）时给出提醒，但仍然发得出去", async () => {
  const cfg = resolveStickerConfig({});
  const warns = [];
  const res = await executeStickerCall(STICKER_TOOL_NAME, '{"name":"巨大"}', cfg, {
    readdir: dir("巨大.png"),
    readFile: async () => pngHeader(1308, 1202),
    logger: { warn: (m) => warns.push(m), info: () => {} },
  });
  assert.equal(res.ok, true, "只提醒，不拦截——拦了她就发不出表情包了");
  assert.ok(
    warns.some((w) => w.includes("1308×1202") && w.includes("resize_stickers.py")),
    `应提醒尺寸并给出脚本：${warns.join(" | ")}`,
  );
});

// ---------------------------------------------------------------------------
// 「看看你卖萌的样子」这类请求：引擎要能自己认出来，不能靠模型掷骰子
// 真机 2026-10-17 22:22：同一句话，模型有时调 send_sticker、有时只回文字。
// ---------------------------------------------------------------------------

test("stickers: 认出「看看你卖萌的样子」「发个比心」「发个表情包」", () => {
  assert.deepEqual(detectStickerRequest("看看你卖萌的样子"), {
    keyword: "卖萌",
    generic: false,
  });
  assert.deepEqual(detectStickerRequest("来个比心"), { keyword: "比心", generic: false });
  assert.deepEqual(detectStickerRequest("发个你的表情包"), { keyword: "", generic: true });
  assert.deepEqual(detectStickerRequest("发表情"), { keyword: "", generic: true });

  // 问数量 / 问能力 / 闲聊 / 否认句，都不是要图
  for (const t of [
    "现在你有几个表情包",
    "你能发个比心吗",
    "今天天气不错",
    "表情包好像只能发在当前这个窗口里",
    "",
  ]) {
    assert.equal(detectStickerRequest(t), null, `不该触发：${t}`);
  }
});

test("stickers: 点名情绪优先命中「春禾-」自己的那张，不拿猫图糊弄", () => {
  const all = [
    { name: "卖萌" },
    { name: "圆头猫" },
    { name: "春禾-卖萌" },
    { name: "春禾-比心" },
    { name: "春禾-开心" },
  ];
  assert.equal(pickStickerName(all, { keyword: "卖萌" }), "春禾-卖萌");
  assert.equal(pickStickerName(all, { keyword: "比心" }), "春禾-比心");
  assert.equal(pickStickerName(all, { generic: true }), "春禾-开心");
  assert.equal(pickStickerName([], { generic: true }), "");
  assert.equal(pickStickerName(all, {}), "", "没点名又不是通用请求就不挑");
});

test("stickers: 群聊发图走 /v2/groups/{gid}/files + /messages，不是单聊路径", async () => {
  const calls = [];
  const jsonRes = (obj) => ({
    ok: true,
    status: 200,
    headers: { get: () => "application/json" },
    text: async () => JSON.stringify(obj),
  });
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : null });
    if (String(url).includes("/app/getAppAccessToken")) {
      return jsonRes({ access_token: "tok", expires_in: 7200 });
    }
    if (String(url).includes("/files")) return jsonRes({ file_info: "FI_GROUP" });
    return jsonRes({ id: "msg_1" });
  };
  const api = new QQApi({
    appId: "1",
    clientSecret: "s",
    apiBase: "https://fake.local",
    tokenBase: "https://fake.local",
    fetchImpl,
  });

  const base64 = Buffer.from("FAKEPNGDATA").toString("base64");
  const fileInfo = await api.uploadMedia("group", "GID_90A0", base64, IMAGE_FILE_TYPE);
  assert.equal(fileInfo, "FI_GROUP");
  await api.sendMedia("group", "GID_90A0", fileInfo, { msgSeq: 1 });

  const paths = calls.map((c) => c.url.replace("https://fake.local", ""));
  assert.deepEqual(paths.slice(-2), [
    "/v2/groups/GID_90A0/files",
    "/v2/groups/GID_90A0/messages",
  ]);
  assert.ok(!paths.some((p) => p.includes("/v2/users/")), "群聊不该走单聊路径");
  assert.equal(calls.at(-1).body.msg_type, 7, "图片必须走 msg_type=7 富媒体");
  assert.equal(calls.at(-1).body.media.file_info, "FI_GROUP");
});

test("stickers: 尺寸合规时不吵（不该每条都warn）", async () => {
  const cfg = resolveStickerConfig({});
  const warns = [];
  await executeStickerCall(STICKER_TOOL_NAME, '{"name":"小图"}', cfg, {
    readdir: dir("小图.png"),
    readFile: async () => pngHeader(128, 128),
    logger: { warn: (m) => warns.push(m), info: () => {} },
  });
  assert.deepEqual(warns, []);
});
