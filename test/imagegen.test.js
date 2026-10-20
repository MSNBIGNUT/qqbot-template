/**
 * 单元测试：画图能力（工具调用 → 火山方舟 Seedream → QQ 富媒体图片）。
 *
 * 全程离线：Ark 与图片下载都用注入的 fetchImpl 打桩。
 *
 * 重点验证三件事：
 *   1. **没配 ARK_API_KEY 时工具根本不注册**——否则等于给模型装一个必然失败的工具，
 *      它会每轮都调、每次都失败，既烧 token 又永远画不出来。
 *   2. **任何失败都降级、绝不抛**：参数不是合法 JSON、Ark 报错、下载失败、
 *      图片过大，都必须变成一段可读的文字回填给模型。
 *   3. 工具调用循环有轮数上限，不会无限打转。
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_IMAGE_MODEL,
  DEFAULT_ARK_BASE,
  IMAGE_TOOL_NAME,
  IMAGE_TOOL,
  resolveImageGenConfig,
  buildToolList,
  generateImage,
  executeToolCall,
  parseReferences,
  MAX_REFERENCES,
} from "../src/media/imagegen.js";
// 用命名空间引用新增的自画像判定函数：缺失时只让对应那条测试变红，
// 而不是整个文件的 import 直接炸掉（那样看不出到底哪条坏了）。
import * as imagegenNs from "../src/media/imagegen.js";
import { STICKER_TOOL_NAME } from "../src/media/stickers.js";

import { makeModelGenerator, CHUNHE_SYSTEM_PROMPT } from "../src/persona/chunhe.js";

// ---------------------------------------------------------------- 打桩工具

/** 造一个返回指定 JSON 的 fetch */
function jsonFetch(payload, { status = 200 } = {}) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, body: init?.body ? JSON.parse(init.body) : null, headers: init?.headers });
    return {
      ok: status >= 200 && status < 300,
      status,
      async json() { return payload; },
      async text() { return JSON.stringify(payload); },
    };
  };
  fn.calls = calls;
  return fn;
}

/** 假图片字节（PNG 头） */
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

/** 同时处理「Ark 生图」与「下载图片」两件事的 fetch 打桩 */
function arkAndImageFetch({ arkPayload, arkStatus = 200, imageBytes = PNG, imageOk = true } = {}) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, body: init?.body ? JSON.parse(init.body) : null, headers: init?.headers });
    if (String(url).includes("/images/generations")) {
      return {
        ok: arkStatus >= 200 && arkStatus < 300,
        status: arkStatus,
        async json() { return arkPayload; },
        async text() { return JSON.stringify(arkPayload); },
      };
    }
    // 图片下载
    return {
      ok: imageOk,
      status: imageOk ? 200 : 404,
      headers: { get: () => "image/png" },
      async arrayBuffer() { return imageBytes.buffer.slice(imageBytes.byteOffset, imageBytes.byteOffset + imageBytes.byteLength); },
      async text() { return ""; },
    };
  };
  fn.calls = calls;
  return fn;
}

// ---------------------------------------------------------------- 配置

test("imagegen: 没有 ARK_API_KEY 时功能关闭", () => {
  const cfg = resolveImageGenConfig({});
  assert.equal(cfg.enabled, false);
  assert.equal(cfg.apiKey, "");
});

test("imagegen: 有 key 时启用，并用已验证存在的默认模型", () => {
  const cfg = resolveImageGenConfig({ ARK_API_KEY: "ark-test" });
  assert.equal(cfg.enabled, true);
  assert.equal(cfg.model, DEFAULT_IMAGE_MODEL);
  assert.equal(cfg.baseUrl, DEFAULT_ARK_BASE);
  // 文档里那个 doubao-seedream-5-0-lite-260128 在方舟侧根本不存在，
  // 这里锁死成实测「已开通、能出图」的那个，避免以后再被写回去。
  assert.notEqual(cfg.model, "doubao-seedream-5-0-lite-260128");
  assert.equal(cfg.model, "doubao-seedream-5-0-pro-260628");
});

test("imagegen: IMAGE_GEN_ENABLED=false 可强制关闭（即使有 key）", () => {
  const cfg = resolveImageGenConfig({ ARK_API_KEY: "ark-test", IMAGE_GEN_ENABLED: "false" });
  assert.equal(cfg.enabled, false);
});

test("imagegen: 模型名/尺寸/超时可用环境变量覆盖", () => {
  const cfg = resolveImageGenConfig({
    ARK_API_KEY: "k",
    ARK_IMAGE_MODEL: "doubao-seedream-5-0-pro-260628",
    ARK_IMAGE_SIZE: "2K",
    IMAGE_GEN_TIMEOUT_MS: "120000",
    IMAGE_GEN_MAX_ROUNDS: "5",
  });
  assert.equal(cfg.model, "doubao-seedream-5-0-pro-260628");
  assert.equal(cfg.size, "2K");
  assert.equal(cfg.timeoutMs, 120000);
  assert.equal(cfg.maxRounds, 5);
});

// ---------------------------------------------------------------- 工具注册

test("imagegen: 未启用时不注册任何工具（不给模型装必然失败的工具）", () => {
  assert.deepEqual(buildToolList(resolveImageGenConfig({})), []);
});

test("imagegen: 启用时注册 generate_image，且 prompt 为必填", () => {
  const tools = buildToolList(resolveImageGenConfig({ ARK_API_KEY: "k" }));
  assert.equal(tools.length, 1);
  assert.equal(tools[0].type, "function");
  assert.equal(tools[0].function.name, IMAGE_TOOL_NAME);
  assert.equal(IMAGE_TOOL_NAME, "generate_image");
  assert.deepEqual(tools[0].function.parameters.required, ["prompt"]);
});

// ---------------------------------------------------------------- 生图

test("imagegen: 成功时返回图片 base64", async () => {
  const fetchImpl = arkAndImageFetch({ arkPayload: { data: [{ url: "https://ark.example/a.png" }] } });
  const cfg = resolveImageGenConfig({ ARK_API_KEY: "k" });
  const res = await generateImage("一只金毛", cfg, { fetchImpl });

  assert.equal(res.ok, true, res.reason);
  assert.equal(res.images.length, 1);
  assert.equal(res.images[0].base64, PNG.toString("base64"));
  assert.equal(res.images[0].bytes, PNG.length);
});

test("imagegen: 请求体带上模型/提示词/尺寸，且用 Bearer key", async () => {
  const fetchImpl = arkAndImageFetch({ arkPayload: { data: [{ url: "https://ark.example/a.png" }] } });
  const cfg = resolveImageGenConfig({ ARK_API_KEY: "ark-secret", ARK_IMAGE_SIZE: "2K" });
  await generateImage("一只猫", cfg, { fetchImpl });

  const ark = fetchImpl.calls.find((c) => c.url.includes("/images/generations"));
  assert.ok(ark, "应调用 Ark 生图接口");
  assert.equal(ark.body.model, DEFAULT_IMAGE_MODEL);
  assert.equal(ark.body.prompt, "一只猫");
  assert.equal(ark.body.size, "2K");
  assert.match(String(ark.headers.Authorization), /^Bearer /);
});

test("imagegen: Ark 报错时降级并把原因说清楚（不抛）", async () => {
  const fetchImpl = arkAndImageFetch({
    arkPayload: { error: { message: "has not activated the model doubao-x" } },
    arkStatus: 404,
  });
  const res = await generateImage("猫", resolveImageGenConfig({ ARK_API_KEY: "k" }), { fetchImpl });
  assert.equal(res.ok, false);
  assert.match(res.reason, /not activated|404|Ark/i);
});

test("imagegen: 网络异常时降级（不抛）", async () => {
  const fetchImpl = async () => { throw new Error("ECONNRESET"); };
  const res = await generateImage("猫", resolveImageGenConfig({ ARK_API_KEY: "k" }), { fetchImpl });
  assert.equal(res.ok, false);
  assert.match(res.reason, /ECONNRESET/);
});

test("imagegen: 没有 key 时不发请求，直接降级", async () => {
  const fetchImpl = arkAndImageFetch({ arkPayload: { data: [{ url: "x" }] } });
  const res = await generateImage("猫", resolveImageGenConfig({}), { fetchImpl });
  assert.equal(res.ok, false);
  assert.equal(fetchImpl.calls.length, 0, "没有 key 不该发起任何请求");
});

test("imagegen: 图片下载失败时降级", async () => {
  const fetchImpl = arkAndImageFetch({
    arkPayload: { data: [{ url: "https://ark.example/a.png" }] },
    imageOk: false,
  });
  const res = await generateImage("猫", resolveImageGenConfig({ ARK_API_KEY: "k" }), { fetchImpl });
  assert.equal(res.ok, false);
  assert.match(res.reason, /下载|download|404/i);
});

test("imagegen: 图片过大时降级（不发出去被平台拒）", async () => {
  const big = Buffer.alloc(2048);
  const fetchImpl = arkAndImageFetch({
    arkPayload: { data: [{ url: "https://ark.example/big.png" }] },
    imageBytes: big,
  });
  const cfg = resolveImageGenConfig({ ARK_API_KEY: "k" });
  cfg.maxBytes = 1024;
  const res = await generateImage("猫", cfg, { fetchImpl });
  assert.equal(res.ok, false);
  assert.match(res.reason, /过大|maxBytes|2048/i);
});

test("imagegen: Ark 返回空 data 时降级", async () => {
  const fetchImpl = arkAndImageFetch({ arkPayload: { data: [] } });
  const res = await generateImage("猫", resolveImageGenConfig({ ARK_API_KEY: "k" }), { fetchImpl });
  assert.equal(res.ok, false);
});

// ---------------------------------------------------------------- 角色参考图

/** 参考图打桩：只记录是否读了文件 */
function refIo(content = "FAKEJPEG") {
  const read = [];
  return {
    read,
    readFile: async (p) => { read.push(p); return Buffer.from(content); },
  };
}

test("imagegen: 未配参考图时请求体里没有 image 字段（行为不变）", async () => {
  const fetchImpl = arkAndImageFetch({ arkPayload: { data: [{ url: "https://ark.example/a.png" }] } });
  await generateImage("猫", resolveImageGenConfig({ ARK_API_KEY: "k" }), { fetchImpl });
  const ark = fetchImpl.calls.find((c) => c.url.includes("/images/generations"));
  assert.ok(!("image" in ark.body), "不该出现 image 字段");
});

test("imagegen: 配了参考图路径时，以 data URI 传给模型", async () => {
  const io = refIo();
  const fetchImpl = arkAndImageFetch({ arkPayload: { data: [{ url: "https://ark.example/a.png" }] } });
  const cfg = resolveImageGenConfig({ ARK_API_KEY: "k", ARK_IMAGE_REFERENCE: "C:/ref/chunhe.jpg" });

  assert.equal(cfg.reference, "C:/ref/chunhe.jpg");
  await generateImage("画春禾", cfg, { fetchImpl, readFile: io.readFile, includeSelf: true });

  const ark = fetchImpl.calls.find((c) => c.url.includes("/images/generations"));
  assert.match(String(ark.body.image), /^data:image\/jpeg;base64,/, "应是 jpeg 的 data URI");
  assert.equal(io.read.length, 1, "应读了参考图文件");
});

test("imagegen: 参考图本来就是 data URI 时直接透传，不读文件", async () => {
  const io = refIo();
  const fetchImpl = arkAndImageFetch({ arkPayload: { data: [{ url: "https://ark.example/a.png" }] } });
  const uri = "data:image/png;base64,QUJD";
  const cfg = resolveImageGenConfig({ ARK_API_KEY: "k", ARK_IMAGE_REFERENCE: uri });

  await generateImage("画春禾", cfg, { fetchImpl, readFile: io.readFile, includeSelf: true });
  const ark = fetchImpl.calls.find((c) => c.url.includes("/images/generations"));
  assert.equal(ark.body.image, uri);
  assert.equal(io.read.length, 0, "data URI 不该再读文件");
});

test("imagegen: 参考图文件读不到时，仍然出图（只是没有形象约束）", async () => {
  const fetchImpl = arkAndImageFetch({ arkPayload: { data: [{ url: "https://ark.example/a.png" }] } });
  const cfg = resolveImageGenConfig({ ARK_API_KEY: "k", ARK_IMAGE_REFERENCE: "C:/ref/missing.jpg" });
  const res = await generateImage("画春禾", cfg, {
    fetchImpl,
    includeSelf: true,
    readFile: async () => { throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); },
  });
  assert.equal(res.ok, true, "参考图缺失不该让整次生图失败");
  const ark = fetchImpl.calls.find((c) => c.url.includes("/images/generations"));
  assert.ok(!("image" in ark.body), "读不到就不带 image");
});

test("imagegen: IMAGE_GEN_REFERENCE 也能配参考图（别名）", () => {
  const cfg = resolveImageGenConfig({ ARK_API_KEY: "k", IMAGE_GEN_REFERENCE: "D:/x.png" });
  assert.equal(cfg.reference, "D:/x.png");
});

// ---------------------------------------------------------------- 多张参考图

test("imagegen: 分号/换行分隔的参考图列表会被拆开", () => {
  assert.deepEqual(parseReferences("a.jpg;b.jpg"), ["a.jpg", "b.jpg"]);
  assert.deepEqual(parseReferences("a.jpg\nb.jpg\nc.jpg"), ["a.jpg", "b.jpg", "c.jpg"]);
  assert.deepEqual(parseReferences("  a.jpg ; ; b.jpg  "), ["a.jpg", "b.jpg"]);
  assert.deepEqual(parseReferences(""), []);
  // 逗号**不**作为分隔符：Windows 路径与文件名都可能含逗号
  assert.deepEqual(parseReferences("C:/a,b.jpg"), ["C:/a,b.jpg"]);
});

test("imagegen: data URI 自带的分号不能被当成分隔符（否则一张图被拆两半）", () => {
  const one = "data:image/png;base64,QUJD";
  assert.deepEqual(parseReferences(one), [one], "单个 data URI 必须完整保留");
  // data URI 与路径混用时要正确拆成 2 个
  assert.deepEqual(parseReferences(`C:/ref/sheet.jpg;${one}`), ["C:/ref/sheet.jpg", one]);
});

test("imagegen: 单张参考图 → image 是字符串（保持原行为）", async () => {
  const fetchImpl = arkAndImageFetch({ arkPayload: { data: [{ url: "https://ark.example/a.png" }] } });
  const cfg = resolveImageGenConfig({ ARK_API_KEY: "k", ARK_IMAGE_REFERENCE: "C:/ref/one.jpg" });
  await generateImage("画春禾", cfg, { fetchImpl, includeSelf: true, readFile: async () => Buffer.from("JPEG") });
  const ark = fetchImpl.calls.find((c) => c.url.includes("/images/generations"));
  assert.equal(typeof ark.body.image, "string");
  assert.match(ark.body.image, /^data:image\/jpeg;base64,/);
});

test("imagegen: 多张参考图 → image 是数组，且顺序与配置一致", async () => {
  const fetchImpl = arkAndImageFetch({ arkPayload: { data: [{ url: "https://ark.example/a.png" }] } });
  const cfg = resolveImageGenConfig({
    ARK_API_KEY: "k",
    ARK_IMAGE_REFERENCE: "C:/ref/sheet.jpg;C:/ref/shy.png",
  });
  await generateImage("画春禾", cfg, { fetchImpl, includeSelf: true, readFile: async () => Buffer.from("X") });
  const ark = fetchImpl.calls.find((c) => c.url.includes("/images/generations"));
  assert.ok(Array.isArray(ark.body.image), "多张应是数组");
  assert.equal(ark.body.image.length, 2);
  assert.match(ark.body.image[0], /^data:image\/jpeg;base64,/);
  assert.match(ark.body.image[1], /^data:image\/png;base64,/);
});

test("imagegen: 多张里有一张读不到，跳过它但其余照用（不整单失败）", async () => {
  const fetchImpl = arkAndImageFetch({ arkPayload: { data: [{ url: "https://ark.example/a.png" }] } });
  const cfg = resolveImageGenConfig({
    ARK_API_KEY: "k",
    ARK_IMAGE_REFERENCE: "C:/ref/ok.jpg;C:/ref/missing.jpg",
  });
  const res = await generateImage("画春禾", cfg, {
    fetchImpl,
    includeSelf: true,
    readFile: async (p) => {
      if (String(p).includes("missing")) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return Buffer.from("OK");
    },
  });
  assert.equal(res.ok, true, "一张缺失不该让整次生图失败");
  const ark = fetchImpl.calls.find((c) => c.url.includes("/images/generations"));
  // 只剩一张时方舟收字符串（不是长度 1 的数组），两种都要认
  const imgs = Array.isArray(ark.body.image) ? ark.body.image : [ark.body.image];
  assert.equal(imgs.length, 1, "只应带上读到的那张");
});

// ---------------------------------------------------------------- 角色锚定

test("imagegen: 配了角色锚定时，锚点拼在场景描述之前", async () => {
  const fetchImpl = arkAndImageFetch({ arkPayload: { data: [{ url: "https://ark.example/a.png" }] } });
  const cfg = resolveImageGenConfig({
    ARK_API_KEY: "k",
    IMAGE_GEN_CHARACTER_LOCK: "【角色锚定】深蓝色羽翼状兽耳，白色短袖连衣裙。",
  });
  assert.match(cfg.characterLock, /羽翼状兽耳/);

  await generateImage("在窗边自拍", cfg, { fetchImpl, includeSelf: true });
  const ark = fetchImpl.calls.find((c) => c.url.includes("/images/generations"));
  assert.ok(ark.body.prompt.startsWith("【角色锚定】"), "锚点必须排在最前");
  assert.ok(ark.body.prompt.includes("在窗边自拍"), "场景描述不能丢");
  assert.ok(
    ark.body.prompt.indexOf("兽耳") < ark.body.prompt.indexOf("在窗边自拍"),
    "锚点要排在场景描述之前（先立人设，再讲这次画什么）",
  );
});

test("imagegen: 没配锚定时 prompt 原样不变（零行为变化）", async () => {
  const fetchImpl = arkAndImageFetch({ arkPayload: { data: [{ url: "https://ark.example/a.png" }] } });
  await generateImage("在窗边自拍", resolveImageGenConfig({ ARK_API_KEY: "k" }), { fetchImpl });
  const ark = fetchImpl.calls.find((c) => c.url.includes("/images/generations"));
  assert.equal(ark.body.prompt, "在窗边自拍");
});

// ------------------------------------------------ 用户本次发来的图当参考（A 方案）

test("imagegen: 用户发来的图作为额外参考，排在主立绘之后", async () => {
  const fetchImpl = arkAndImageFetch({ arkPayload: { data: [{ url: "https://ark.example/a.png" }] } });
  const cfg = resolveImageGenConfig({ ARK_API_KEY: "k", ARK_IMAGE_REFERENCE: "C:/ref/sheet.jpg" });
  const userImg = "data:image/jpeg;base64,VVNFUg==";

  await generateImage("画春禾", cfg, {
    fetchImpl,
    includeSelf: true,
    readFile: async () => Buffer.from("X"),
    extraReferences: [userImg],
  });

  const ark = fetchImpl.calls.find((c) => c.url.includes("/images/generations"));
  assert.ok(Array.isArray(ark.body.image), "两张以上应是数组");
  assert.equal(ark.body.image.length, 2);
  assert.match(ark.body.image[0], /^data:image\/jpeg;base64,/, "主立绘在前（锁长相）");
  assert.equal(ark.body.image[1], userImg, "用户发来的图在后（带画风）");
});

test("imagegen: 没配主立绘、只有用户发来的图时，image 是字符串（单张）", async () => {
  const fetchImpl = arkAndImageFetch({ arkPayload: { data: [{ url: "https://ark.example/a.png" }] } });
  const userImg = "data:image/png;base64,QUJD";
  await generateImage("画", resolveImageGenConfig({ ARK_API_KEY: "k" }), {
    fetchImpl,
    extraReferences: [userImg],
  });
  const ark = fetchImpl.calls.find((c) => c.url.includes("/images/generations"));
  assert.equal(ark.body.image, userImg);
});

test("imagegen: 参考图总数有上限，用户狂发图也不会撑爆请求", async () => {
  const fetchImpl = arkAndImageFetch({ arkPayload: { data: [{ url: "https://ark.example/a.png" }] } });
  const cfg = resolveImageGenConfig({ ARK_API_KEY: "k", ARK_IMAGE_REFERENCE: "C:/a.jpg;C:/b.jpg" });
  const many = Array.from({ length: 10 }, (_, i) => `data:image/jpeg;base64,AAA${i}`);
  await generateImage("画", cfg, {
    fetchImpl,
    includeSelf: true,
    readFile: async () => Buffer.from("X"),
    extraReferences: many,
  });
  const ark = fetchImpl.calls.find((c) => c.url.includes("/images/generations"));
  assert.ok(ark.body.image.length <= MAX_REFERENCES, `最多 ${MAX_REFERENCES} 张，实际 ${ark.body.image.length}`);
});

test("imagegen: extraReferences 为空/未给时行为完全不变", async () => {
  const fetchImpl = arkAndImageFetch({ arkPayload: { data: [{ url: "https://ark.example/a.png" }] } });
  await generateImage("画", resolveImageGenConfig({ ARK_API_KEY: "k" }), {
    fetchImpl,
    extraReferences: [],
  });
  const ark = fetchImpl.calls.find((c) => c.url.includes("/images/generations"));
  assert.ok(!("image" in ark.body));
});

test("imagegen: 用了主人的参考图时会留一条可查的日志（否则出问题无从排查）", async () => {
  const fetchImpl = arkAndImageFetch({ arkPayload: { data: [{ url: "https://ark.example/a.png" }] } });
  const lines = [];
  const cfg = resolveImageGenConfig({ ARK_API_KEY: "k", ARK_IMAGE_REFERENCE: "C:/ref/sheet.jpg" });
  await generateImage("画", cfg, {
    fetchImpl,
    includeSelf: true,
    readFile: async () => Buffer.from("X"),
    extraReferences: ["data:image/jpeg;base64,QQ=="],
    logger: { info: (m) => lines.push(m) },
  });
  assert.ok(lines.some((l) => /主立绘 1 张 \+ 主人发来 1 张/.test(l)), `日志里应有参考图构成：${lines.join(" | ")}`);
});

test("imagegen: 锚定与参考图可以同时生效", async () => {
  const fetchImpl = arkAndImageFetch({ arkPayload: { data: [{ url: "https://ark.example/a.png" }] } });
  const cfg = resolveImageGenConfig({
    ARK_API_KEY: "k",
    ARK_IMAGE_REFERENCE: "C:/ref/sheet.jpg",
    IMAGE_GEN_CHARACTER_LOCK: "锚点文本",
  });
  await generateImage("场景", cfg, { fetchImpl, includeSelf: true, readFile: async () => Buffer.from("X") });
  const ark = fetchImpl.calls.find((c) => c.url.includes("/images/generations"));
  assert.ok(ark.body.image, "参考图要带上");
  assert.ok(ark.body.prompt.startsWith("锚点文本"), "锚点要带上");
});

test("imagegen: 全部参考图都读不到 → 退回纯文生图（不带 image）", async () => {
  const fetchImpl = arkAndImageFetch({ arkPayload: { data: [{ url: "https://ark.example/a.png" }] } });
  const cfg = resolveImageGenConfig({ ARK_API_KEY: "k", ARK_IMAGE_REFERENCE: "C:/ref/x.jpg" });
  const res = await generateImage("画春禾", cfg, {
    fetchImpl,
    includeSelf: true,
    readFile: async () => { throw new Error("ENOENT"); },
  });
  assert.equal(res.ok, true);
  const ark = fetchImpl.calls.find((c) => c.url.includes("/images/generations"));
  assert.ok(!("image" in ark.body));
});

// ---------------------------------------------------------------- 工具分发

test("imagegen: 工具参数不是合法 JSON 时回填可读错误，不抛", async () => {
  const res = await executeToolCall(IMAGE_TOOL_NAME, "{不是JSON", resolveImageGenConfig({ ARK_API_KEY: "k" }), {
    fetchImpl: arkAndImageFetch({ arkPayload: { data: [{ url: "x" }] } }),
  });
  assert.equal(res.ok, false);
  assert.match(res.content, /参数|解析|JSON/i);
  assert.deepEqual(res.images, []);
});

test("imagegen: 未知工具名回填错误而不是崩", async () => {
  const res = await executeToolCall("not_a_tool", "{}", resolveImageGenConfig({ ARK_API_KEY: "k" }), {});
  assert.equal(res.ok, false);
  assert.match(res.content, /未知|not_a_tool/);
});

test("imagegen: prompt 为空时回填错误", async () => {
  const res = await executeToolCall(IMAGE_TOOL_NAME, JSON.stringify({ prompt: "   " }), resolveImageGenConfig({ ARK_API_KEY: "k" }), {});
  assert.equal(res.ok, false);
  assert.match(res.content, /prompt|描述|空/i);
});

test("imagegen: 成功时 content 是给模型看的一句话，并带回图片", async () => {
  const fetchImpl = arkAndImageFetch({ arkPayload: { data: [{ url: "https://ark.example/a.png" }] } });
  const res = await executeToolCall(IMAGE_TOOL_NAME, JSON.stringify({ prompt: "一只猫" }), resolveImageGenConfig({ ARK_API_KEY: "k" }), { fetchImpl });
  assert.equal(res.ok, true, res.content);
  assert.equal(res.images.length, 1);
  assert.match(res.content, /已生成|成功|1 张|1张/);
});

// ---------------------------------------------------------------- 工具循环

/** 造一个按轮次返回不同响应的 chat 打桩（同时负责 Ark 生图与图片下载） */
function chatSequence(responses) {
  const calls = [];
  let i = 0;
  const fn = async (url, init) => {
    const u = String(url);
    // 顺序很重要：chat 必须先判，否则会被下面的"图片下载"分支吃掉
    if (u.includes("chat/completions")) {
      calls.push({ url, body: JSON.parse(init.body) });
      const r = responses[Math.min(i, responses.length - 1)];
      i += 1;
      return { ok: true, status: 200, async json() { return r; }, async text() { return JSON.stringify(r); } };
    }
    if (u.includes("/images/generations")) {
      // 生图请求也要记下来：自画像隔离的用例要检查真正发给方舟的 prompt / image
      calls.push({ url, body: init?.body ? JSON.parse(init.body) : null });
      // text() 必须和 json() 给出同样的内容：generateImage 读的是 text() 再自己 JSON.parse
      const arkPayload = { data: [{ url: "https://ark.example/a.png" }] };
      return {
        ok: true, status: 200,
        async json() { return arkPayload; },
        async text() { return JSON.stringify(arkPayload); },
      };
    }
    // 图片下载
    return {
      ok: true, status: 200, headers: { get: () => "image/png" },
      async arrayBuffer() { return PNG.buffer.slice(PNG.byteOffset, PNG.byteOffset + PNG.byteLength); },
      async text() { return ""; },
    };
  };
  fn.calls = calls;
  return fn;
}

function modelConfig(overrides = {}) {
  return {
    modelBaseUrl: "https://api.deepseek.com/v1",
    modelName: "deepseek-flash",
    modelApiKey: "sk-test",
    modelTimeoutMs: 30000,
    historyTurns: 4,
    modelVision: false,
    fileReading: false,
    /**
     * 表情包默认关掉。
     *
     * 因为 makeModelGenerator 会去**真实的** assets/stickers/ 扫目录——
     * 本机放了几张素材，测试结果就会跟着变（这正是它第一次暴露出来的问题：
     * 我往素材夹丢了一张测试图，这里两个断言就挂了）。
     * 测试必须与开发机上的素材无关，所以显式关掉；要测表情包就自己开。
     */
    stickers: { enabled: false, dir: "", maxBytes: 2097152 },
    ...overrides,
  };
}

function ctxOf(text) {
  return { text, history: [], scope: "c2c", attachments: [], senderName: "主人" };
}

test("imagegen: 未配 key 时请求体里没有 tools 字段（零行为变化）", async () => {
  const fetchImpl = chatSequence([{ choices: [{ message: { content: "你好" } }] }]);
  const gen = makeModelGenerator({
    config: modelConfig({
      imageGen: resolveImageGenConfig({}),
    }),
    logger: null,
    fetchImpl,
  });
  const ctx = ctxOf("你好");
  const out = await gen(ctx);
  assert.equal(out, "你好", "生成器仍返回字符串");
  assert.equal((ctx.generatedImages ?? []).length, 0);
  const body = fetchImpl.calls[0].body;
  // 2026-10-19 起：`stay_silent`（自主决定不回）是独立工具，与画图 key 无关，
  // 所以这里断言的是「**画图工具**不该出现」，而不是「完全没有 tools」。
  const toolNames = (body.tools ?? []).map((tl) => tl?.function?.name ?? "");
  assert.ok(
    !toolNames.some((n) => /image|draw|picture/i.test(n)),
    `没有画图 key 时不该带画图工具，实际：${toolNames.join(",")}`,
  );
  assert.ok(toolNames.includes("stay_silent"), "stay_silent 与画图无关，应始终可用");
});

test("imagegen: 配了 key 时请求体带 tools 与 tool_choice=auto", async () => {
  const fetchImpl = chatSequence([{ choices: [{ message: { content: "你好" } }] }]);
  const gen = makeModelGenerator({
    config: modelConfig({ imageGen: resolveImageGenConfig({ ARK_API_KEY: "k" }) }),
    logger: null,
    fetchImpl,
  });
  await gen(ctxOf("你好"));
  const body = fetchImpl.calls[0].body;
  assert.equal(body.tool_choice, "auto");
  // 按名字断言，不数个数：以后再加工具不该让这条测试无故变红
  const names = body.tools.map((t) => t.function.name);
  assert.ok(names.includes(IMAGE_TOOL_NAME), `应有画图工具，实际：${names.join(",")}`);
});

test("imagegen: 表情包关掉时不会混进 tools", async () => {
  const fetchImpl = chatSequence([{ choices: [{ message: { content: "你好" } }] }]);
  const gen = makeModelGenerator({
    config: modelConfig({
      imageGen: resolveImageGenConfig({ ARK_API_KEY: "k" }),
      stickers: { enabled: false, dir: "", maxBytes: 2097152 },
    }),
    logger: null,
    fetchImpl,
  });
  await gen(ctxOf("你好"));
  const names = fetchImpl.calls[0].body.tools.map((t) => t.function.name);
  assert.ok(!names.includes(STICKER_TOOL_NAME), `关掉后不该有表情包工具：${names.join(",")}`);
});

test("imagegen: 工具调用循环——执行工具、回填 role=tool、再请求，并带回图片", async () => {
  const fetchImpl = chatSequence([
    {
      choices: [{
        message: {
          content: "我这就画～",
          tool_calls: [{ id: "call_1", type: "function", function: { name: IMAGE_TOOL_NAME, arguments: JSON.stringify({ prompt: "一只金毛" }) } }],
        },
      }],
    },
    { choices: [{ message: { content: "画好啦，主人看看～" } }] },
  ]);
  const gen = makeModelGenerator({
    config: modelConfig({ imageGen: resolveImageGenConfig({ ARK_API_KEY: "k" }) }),
    logger: null,
    fetchImpl,
  });

  const ctx = ctxOf("帮我画一只金毛");
  const out = await gen(ctx);

  // 两次 chat 请求：第一次拿到 tool_calls，第二次拿最终文本
  const chats = fetchImpl.calls.filter((c) => c.url.includes("chat/completions"));
  assert.equal(chats.length, 2, "应有 2 次 chat 请求");

  // 第二次请求里必须有 assistant(tool_calls) 与 role=tool 回填
  const msgs = chats[1].body.messages;
  const assistant = msgs.find((m) => m.role === "assistant" && m.tool_calls);
  const toolMsg = msgs.find((m) => m.role === "tool");
  assert.ok(assistant, "缺少带 tool_calls 的 assistant 消息");
  assert.ok(toolMsg, "缺少 role=tool 的回填消息");
  assert.equal(toolMsg.tool_call_id, "call_1");

  // 图片要能传回给引擎（挂在 ctx 上，不改生成器的字符串契约）
  const images = ctx.generatedImages ?? [];
  assert.equal(images.length, 1, "应带回 1 张图片");
  assert.equal(images[0].base64, PNG.toString("base64"));

  // 最终文本取最后一轮的 content
  assert.match(String(out), /画好啦/);
});

test("imagegen: 工具循环有轮数上限，不能无限打转", async () => {
  // 每次都返回 tool_calls —— 没有上限就会死循环
  const always = {
    choices: [{
      message: {
        content: "",
        tool_calls: [{ id: "call_x", type: "function", function: { name: IMAGE_TOOL_NAME, arguments: JSON.stringify({ prompt: "猫" }) } }],
      },
    }],
  };
  const fetchImpl = chatSequence([always, always, always, always, always, always]);
  const cfg = resolveImageGenConfig({ ARK_API_KEY: "k", IMAGE_GEN_MAX_ROUNDS: "2" });
  const gen = makeModelGenerator({ config: modelConfig({ imageGen: cfg }), logger: null, fetchImpl });

  const out = await gen(ctxOf("一直画"));

  const chats = fetchImpl.calls.filter((c) => c.url.includes("chat/completions"));
  assert.ok(chats.length <= 3, `轮数应被限制，实际 ${chats.length} 次`);
  // 必须仍然返回一个字符串，而不是抛异常
  assert.equal(typeof out, "string");
});

test("imagegen: 工具执行失败时循环继续，模型能据此解释（不抛出）", async () => {
  const fetchImpl = chatSequence([
    {
      choices: [{
        message: {
          content: "",
          tool_calls: [{ id: "c1", type: "function", function: { name: IMAGE_TOOL_NAME, arguments: "{坏JSON" } }],
        },
      }],
    },
    { choices: [{ message: { content: "抱歉，画图没成功……" } }] },
  ]);
  const gen = makeModelGenerator({
    config: modelConfig({ imageGen: resolveImageGenConfig({ ARK_API_KEY: "k" }) }),
    logger: null,
    fetchImpl,
  });
  const out = await gen(ctxOf("画个猫"));
  assert.match(String(out), /抱歉|没成功/);

  const chats = fetchImpl.calls.filter((c) => c.url.includes("chat/completions"));
  const toolMsg = chats[1].body.messages.find((m) => m.role === "tool");
  assert.ok(toolMsg, "即使工具失败也要有 role=tool 回填");
  assert.match(String(toolMsg.content), /参数|JSON/i);
});

// ================================================================
// 自画像隔离 —— 真机 bug：让她「画座雪山」，图里出现了她自己
//
// 现场（data/live.log，2026-10-17）：
//   12:52:31 主人：能生成你穿女仆装的图片吗   → 出图（这一张本来就该有她）
//   12:53:29 主人：你能画座雪山吗            → 出图，**雪山前站着春禾**
//
// 根因不是「模型想多了」这么玄：ARK_IMAGE_REFERENCE（她的立绘）与
// IMAGE_GEN_CHARACTER_LOCK（她的外貌锚定）被**无条件**塞进每一次生图请求，
// 于是不管主人要画什么，生图模型都拿到了「春禾长这样」这个强条件。
// 这一组测试锁死三条线：
//   1) 非自画像请求：不拼锚定、不带主立绘、prompt 里出现她也要被剥掉；
//   2) 自画像请求：锚定与立绘照旧生效（能力不能被一刀切掉）；
//   3) 判定用主人**原话**，模型自己拍板的 include_self=true 不能凌驾其上。
// ================================================================

const SELF_LOCK = "【角色锚定·必须严格遵守】深蓝色大波浪长卷发少女，白色短袖连衣裙，鳍状兽耳。";

/** 一份「配了春禾立绘 + 外观锚定」的配置（生产 .env 就是这个样子） */
function selfCfg(extra = {}) {
  return resolveImageGenConfig({
    ARK_API_KEY: "k",
    ARK_IMAGE_REFERENCE: "C:/ref/chunhe-model-sheet.jpg",
    IMAGE_GEN_CHARACTER_LOCK: SELF_LOCK,
    ...extra,
  });
}

/** 记录「有没有去读立绘文件」的桩 */
function ioStub() {
  const read = [];
  return {
    read,
    readFile: async (p) => {
      read.push(p);
      return Buffer.from("SHEET");
    },
  };
}

function arkBody(fetchImpl) {
  const call = fetchImpl.calls.find((c) => String(c.url).includes("/images/generations"));
  assert.ok(call, `应调用 Ark 生图接口（实际请求：${fetchImpl.calls.map((c) => c.url).join(" | ")}）`);
  return call.body;
}

test("imagegen: 工具描述里写死了硬规则（只画点名要的 / 不许默认加自己 / 每次独立）", () => {
  const d = String(IMAGE_TOOL.function.description);

  // 1) 只描述用户点名要的东西
  assert.match(d, /只描述|只画/, "工具描述必须限定「只画主人要的」");
  // 2) 明确禁止把自己加进去
  assert.match(d, /不要加你自己|不要.*自己/, "工具描述必须明确不许默认加春禾自己");
  // 3) 只有明确要求才允许
  assert.match(d, /只有.*明确|明确.*才/, "工具描述必须写明「只有明确要求才画她自己」");
  // 4) 每次画图都是独立请求（上下文污染那条）
  assert.match(d, /独立/, "工具描述必须写明每次画图是独立请求，不延续上一张");
  // 5) 宁可少画
  assert.match(d, /宁可少画/, "工具描述必须写明「宁可少画，不要多画」");
  // 6) 告诉模型怎么用参数
  assert.match(d, /include_self/, "工具描述必须提到 include_self 参数");
});

test("imagegen: include_self 是可选布尔参数（默认 false），不勾就不画她", () => {
  const params = IMAGE_TOOL.function.parameters;
  const prop = params.properties.include_self;
  assert.ok(prop, "缺少 include_self 参数：模型没有明确表达的出口，只能靠猜");
  assert.equal(prop.type, "boolean");
  assert.match(String(prop.description), /春禾|你/, "参数说明要说清它管的是「画不画春禾」");
  assert.match(String(prop.description), /默认/, "参数说明要写清默认值（false）");
  // 保持可选：既有测试与历史调用都不该被迫传它
  assert.deepEqual(params.required, ["prompt"]);
});

test("imagegen: 自画像意图识别——只有明确要画她时才算", () => {
  const isSelf = imagegenNs.isSelfPortraitRequest;
  assert.equal(typeof isSelf, "function", "缺少 isSelfPortraitRequest 导出");

  const yes = [
    "能生成你穿女仆装的图片吗", // 真机原话（这一句本来就要画她）
    "画你穿女仆装",
    "画一张你的样子",
    "画个你自己",
    "给我画张自画像",
    "画春禾",
    "把你也画进去",
    "画一只猫和你一起",
    "你的立绘是什么样",
    "画我和你的合照", // 用户主动要和她同框
    "画张你和我一起的合影",
  ];
  for (const t of yes) {
    assert.equal(isSelf(t), true, `应识别为自画像：${t}`);
  }

  const no = [
    "你能画座雪山吗", // 真机原话（这一句不该画她）
    "画只猪",
    "画一座雪山",
    "画一只金毛和它的主人在公园",
    "帮我画张风景",
    "画只猫",
    "你能画一张图吗",
    "画你的猫", // 「你的」后面不是她的形象属性，不算自画像
  ];
  for (const t of no) {
    assert.equal(isSelf(t), false, `不该识别为自画像：${t}`);
  }
});

test("imagegen: 非自画像请求（画座雪山）绝不拼锚定，也不带主立绘、不读立绘文件", async () => {
  const fetchImpl = arkAndImageFetch({ arkPayload: { data: [{ url: "https://ark.example/a.png" }] } });
  const io = ioStub();

  const res = await generateImage("一座雪山，清晨蓝调，山脊有薄雾", selfCfg(), {
    fetchImpl,
    readFile: io.readFile,
    includeSelf: false,
  });

  assert.equal(res.ok, true, res.reason);
  const body = arkBody(fetchImpl);
  assert.equal(body.prompt, "一座雪山，清晨蓝调，山脊有薄雾", "非自画像请求的 prompt 必须原样，不许拼她的外貌");
  assert.ok(!("image" in body), "非自画像请求不该带她的立绘（那是最强的「她在图里」条件）");
  assert.equal(io.read.length, 0, "连立绘文件都不该读");
});

test("imagegen: 非自画像请求里出现春禾/我自己时会被剥离并留痕（模型自作主张也拦得住）", async () => {
  const fetchImpl = arkAndImageFetch({ arkPayload: { data: [{ url: "https://ark.example/a.png" }] } });
  const io = ioStub();
  const warns = [];

  await generateImage("春禾站在雪山前，裙摆被风吹起", selfCfg(), {
    fetchImpl,
    readFile: io.readFile,
    includeSelf: false,
    logger: { info: () => {}, warn: (m) => warns.push(m) },
  });

  const body = arkBody(fetchImpl);
  assert.ok(!body.prompt.includes("春禾"), `prompt 里仍留着春禾：${body.prompt}`);
  assert.equal(io.read.length, 0);
  assert.ok(
    warns.some((l) => /剥|去掉|春禾/.test(l)),
    `应留下可排查的记录，实际：${warns.join(" | ")}`,
  );
});

test("imagegen: 明确要画她时，锚定与主立绘照旧生效（自画像能力没被砍掉）", async () => {
  const fetchImpl = arkAndImageFetch({ arkPayload: { data: [{ url: "https://ark.example/a.png" }] } });
  const io = ioStub();

  const res = await generateImage("春禾穿女仆装站在窗边", selfCfg(), {
    fetchImpl,
    readFile: io.readFile,
    includeSelf: true,
  });

  assert.equal(res.ok, true, res.reason);
  const body = arkBody(fetchImpl);
  assert.ok(body.prompt.startsWith(SELF_LOCK), "自画像请求仍要拼锚定（且排在最前）");
  assert.ok(body.prompt.includes("春禾穿女仆装站在窗边"), "场景描述不能丢");
  assert.ok(body.image, "自画像请求仍要带主立绘");
  assert.equal(io.read.length, 1, "应读了立绘文件");
});

test("imagegen: 上一轮聊过「画你穿女仆装」，这一轮画雪山——即使模型硬把 include_self 设 true 也无效", async () => {
  const fetchImpl = arkAndImageFetch({ arkPayload: { data: [{ url: "https://ark.example/a.png" }] } });
  const io = ioStub();

  // 模型被上一轮带偏：prompt 里写了她，还自作主张 include_self=true
  const res = await executeToolCall(
    IMAGE_TOOL_NAME,
    JSON.stringify({ prompt: "春禾穿着女仆装站在雪山前微笑", include_self: true }),
    selfCfg(),
    {
      fetchImpl,
      readFile: io.readFile,
      userText: "你能画座雪山吗", // 主人这一轮的原话：没有一个字要画她
      // 上下文里确实还留着上一轮的视觉主题（这就是污染源）
      history: [
        { role: "user", content: "能生成你穿女仆装的图片吗" },
        { role: "assistant", content: "画好啦～主人看看喜欢吗" },
      ],
    },
  );

  assert.equal(res.ok, true, res.content);
  const body = arkBody(fetchImpl);
  assert.ok(!body.prompt.includes("【角色锚定"), `不该拼锚定：${body.prompt.slice(0, 60)}`);
  assert.ok(!("image" in body), "不该带她的立绘");
  assert.ok(!body.prompt.includes("春禾"), `不该出现春禾：${body.prompt}`);
  assert.equal(io.read.length, 0, "不该去读她的立绘");
});

test("imagegen: 画只猪 → 只有猪（没有人物、没有她）", async () => {
  const fetchImpl = arkAndImageFetch({ arkPayload: { data: [{ url: "https://ark.example/a.png" }] } });
  const io = ioStub();

  await executeToolCall(
    IMAGE_TOOL_NAME,
    JSON.stringify({ prompt: "一只圆滚滚的小猪在草地上打滚" }),
    selfCfg(),
    { fetchImpl, readFile: io.readFile, userText: "画只猪" },
  );

  const body = arkBody(fetchImpl);
  assert.equal(body.prompt, "一只圆滚滚的小猪在草地上打滚");
  assert.ok(!/春禾|少女|女孩/.test(body.prompt), `prompt 里不该有她：${body.prompt}`);
  assert.ok(!("image" in body));
});

test("imagegen: 主人明确要人物（金毛和主人）时，人物照画，不会被误删", async () => {
  const fetchImpl = arkAndImageFetch({ arkPayload: { data: [{ url: "https://ark.example/a.png" }] } });
  const io = ioStub();
  const prompt = "一只金毛犬和它的主人坐在公园长椅上，午后阳光，暖色调";

  await executeToolCall(IMAGE_TOOL_NAME, JSON.stringify({ prompt }), selfCfg(), {
    fetchImpl,
    readFile: io.readFile,
    userText: "画一只金毛和它的主人在公园",
  });

  const body = arkBody(fetchImpl);
  assert.equal(body.prompt, prompt, "主人点名要的「主人」必须原样保留");
  assert.ok(body.prompt.includes("主人"));
  assert.ok(!("image" in body), "但依然不该带她的立绘");
});

test("imagegen: 主人明确说「画你穿女仆装」时，工具路径照样带上锚定与立绘", async () => {
  const fetchImpl = arkAndImageFetch({ arkPayload: { data: [{ url: "https://ark.example/a.png" }] } });
  const io = ioStub();

  const res = await executeToolCall(
    IMAGE_TOOL_NAME,
    JSON.stringify({ prompt: "春禾穿女仆装站在窗边", include_self: true }),
    selfCfg(),
    { fetchImpl, readFile: io.readFile, userText: "能生成你穿女仆装的图片吗" },
  );

  assert.equal(res.ok, true, res.content);
  const body = arkBody(fetchImpl);
  assert.ok(body.prompt.startsWith(SELF_LOCK), "自画像请求要有锚定");
  assert.ok(body.image, "自画像请求要有主立绘");
});

test("imagegen: 模型路径把主人原话交给工具——带着上一轮的画她对话也不会污染这一轮", async () => {
  const fetchImpl = chatSequence([
    {
      choices: [{
        message: {
          content: "我这就画～",
          tool_calls: [{
            id: "call_self",
            type: "function",
            function: {
              name: IMAGE_TOOL_NAME,
              arguments: JSON.stringify({ prompt: "春禾站在雪山前", include_self: true }),
            },
          }],
        },
      }],
    },
    { choices: [{ message: { content: "画好啦～" } }] },
  ]);
  const gen = makeModelGenerator({
    config: modelConfig({ imageGen: selfCfg() }),
    logger: null,
    fetchImpl,
  });

  const ctx = ctxOf("你能画座雪山吗");
  ctx.history = [
    { role: "user", content: "能生成你穿女仆装的图片吗" },
    { role: "assistant", content: "画好啦～" },
  ];
  const out = await gen(ctx);

  assert.match(String(out), /画好啦/);
  const body = arkBody(fetchImpl);
  assert.ok(!body.prompt.includes("【角色锚定"), "锚定不该出现");
  assert.ok(!("image" in body), "她的立绘不该出现");
  assert.ok(!body.prompt.includes("春禾"), `prompt 仍含春禾：${body.prompt}`);
  assert.equal((ctx.generatedImages ?? []).length, 1, "图还是要出的");
});

test("imagegen: 人格层把「人格描述」和「生图描述」分开，并把画图硬规则写进提示词", () => {
  const p = CHUNHE_SYSTEM_PROMPT;

  // 外貌设定是聊天用的自我描述，不是画图的默认元素
  assert.match(p, /人格描述|聊天/, "人格层要标明外貌设定只用于聊天");
  assert.match(p, /不要.*(写进|画进)|别.*(写进|画进)/, "要明确禁止把外貌设定写进图片描述");

  // 画图硬规则必须同时进人格层（模型每轮都看得到）
  assert.match(p, /include_self/, "人格层要告诉模型 include_self 怎么用");
  assert.match(p, /独立/, "人格层要写明每次画图是独立请求");
  assert.match(p, /只画|只描述/, "人格层要写明只画主人点名要的东西");
});
