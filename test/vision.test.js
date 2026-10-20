/**
 * 视觉能力测试。
 *
 * 这里守住的关键行为：
 *  1. 图片必须下载后以 base64 内联（实测：直链会被模型服务端拒，HTTP 400）
 *  2. 开视觉时系统提示词要改成"你能看图"，否则模型会莫名拒绝描述
 *  3. 未开视觉时本地模式必须诚实说"看不到"，不能编造
 *  4. 图片下载失败要降级，而不是让整轮对话失败
 */

import test from "node:test";
import assert from "node:assert/strict";

import { fetchImageAsDataUrl } from "../src/media/image.js";
import {
  makeModelGenerator,
  makeLocalGenerator,
  buildSystemPrompt,
  CHUNHE_SYSTEM_PROMPT,
} from "../src/persona/chunhe.js";
import { createLogger } from "../src/util/log.js";

const logger = createLogger("silent");

/** 造一个最小的假图片响应 */
function imageResponse(bytes = [1, 2, 3, 4], contentType = "image/png") {
  return new Response(Buffer.from(bytes), {
    status: 200,
    headers: { "content-type": contentType, "content-length": String(bytes.length) },
  });
}

const VISION_CONFIG = {
  modelBaseUrl: "https://example.invalid/v1",
  modelApiKey: "k",
  modelName: "m",
  historyTurns: 8,
  modelTimeoutMs: 5000,
  modelVision: true,
  visionMaxBytes: 5 * 1024 * 1024,
  visionTimeoutMs: 5000,
};

test("图片下载：成功时返回 base64 data URL", async () => {
  const dataUrl = await fetchImageAsDataUrl("https://cdn.example.invalid/a.png", {
    fetchImpl: async () => imageResponse([9, 8, 7]),
    logger,
  });
  assert.ok(dataUrl, "应返回 data URL");
  assert.match(dataUrl, /^data:image\/png;base64,/);
  assert.equal(Buffer.from(dataUrl.split(",")[1], "base64").toString("hex"), "090807");
});

test("图片下载：非 http(s) 协议一律拒绝", async () => {
  for (const bad of ["file:///C:/secret.png", "ftp://x/a.png", "javascript:alert(1)"]) {
    const r = await fetchImageAsDataUrl(bad, { fetchImpl: async () => imageResponse(), logger });
    assert.equal(r, null, `应拒绝 ${bad}`);
  }
  assert.equal(await fetchImageAsDataUrl("", { logger }), null);
  assert.equal(await fetchImageAsDataUrl("not a url", { logger }), null);
});

test("图片下载：非图片类型拒绝", async () => {
  const r = await fetchImageAsDataUrl("https://cdn.example.invalid/a.txt", {
    fetchImpl: async () => imageResponse([1, 2, 3], "text/plain"),
    logger,
  });
  assert.equal(r, null, "只接受图片类型");
});

test("图片下载：超出大小上限时拒绝（按声明与实际双重判断）", async () => {
  // 声明超大
  const declared = await fetchImageAsDataUrl("https://cdn.example.invalid/big.png", {
    maxBytes: 10,
    fetchImpl: async () =>
      new Response(Buffer.alloc(0), {
        status: 200,
        headers: { "content-type": "image/png", "content-length": "999999" },
      }),
    logger,
  });
  assert.equal(declared, null, "声明超限应直接拒绝，不必下载");

  // 实际超大
  const actual = await fetchImageAsDataUrl("https://cdn.example.invalid/big2.png", {
    maxBytes: 10,
    fetchImpl: async () => imageResponse(new Array(50).fill(7)),
    logger,
  });
  assert.equal(actual, null, "实际超限应拒绝");
});

test("图片下载：HTTP 错误 / 超时 / 空内容都降级为 null，不抛错", async () => {
  const notFound = await fetchImageAsDataUrl("https://cdn.example.invalid/404.png", {
    fetchImpl: async () => new Response("nope", { status: 404 }),
    logger,
  });
  assert.equal(notFound, null);

  const timeout = await fetchImageAsDataUrl("https://cdn.example.invalid/slow.png", {
    fetchImpl: async () => {
      const err = new Error("timed out");
      err.name = "TimeoutError";
      throw err;
    },
    logger,
  });
  assert.equal(timeout, null, "超时不能抛出去，否则整轮对话失败");

  const empty = await fetchImageAsDataUrl("https://cdn.example.invalid/empty.png", {
    fetchImpl: async () => imageResponse([]),
    logger,
  });
  assert.equal(empty, null);
});

test("开视觉时，图片以多模态格式内联送入模型", async () => {
  let captured = null;
  const gen = makeModelGenerator({
    config: VISION_CONFIG,
    logger,
    fetchImpl: async (_url, init) => {
      if (String(_url).includes("chat/completions")) {
        captured = JSON.parse(init.body);
        return new Response(JSON.stringify({ choices: [{ message: { content: "看到啦" } }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      // 图片下载
      return imageResponse([1, 2, 3]);
    },
  });

  const reply = await gen({
    text: "",
    media: { type: "image", label: "图片/表情包", count: 1 },
    attachments: [{ content_type: "image/png", url: "https://cdn.example.invalid/a.png" }],
    history: [],
  });

  assert.equal(reply, "看到啦");
  const userMsg = captured.messages.at(-1);
  assert.ok(Array.isArray(userMsg.content), "带图时 content 应是数组（多模态格式）");
  const imgPart = userMsg.content.find((p) => p.type === "image_url");
  assert.ok(imgPart, "应包含 image_url 片段");
  assert.match(imgPart.image_url.url, /^data:image\/png;base64,/, "必须是 base64 内联，不能是直链");
  assert.ok(
    !imgPart.image_url.url.startsWith("http"),
    "绝不能用直链——实测模型服务端会拒（400）",
  );
  // 系统提示词应切换为"你能看图"
  assert.match(captured.messages[0].content, /确实收到了图片|可以直接看/);
});

test("关视觉时，退回纯文本附注（不会误发图片）", async () => {
  let captured = null;
  const gen = makeModelGenerator({
    config: { ...VISION_CONFIG, modelVision: false },
    logger,
    fetchImpl: async (_url, init) => {
      captured = JSON.parse(init.body);
      return new Response(JSON.stringify({ choices: [{ message: { content: "收到" } }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  });

  await gen({
    text: "",
    media: { type: "image", label: "图片/表情包", count: 1 },
    attachments: [{ content_type: "image/png", url: "https://cdn.example.invalid/a.png" }],
    history: [],
  });

  const userMsg = captured.messages.at(-1);
  assert.equal(typeof userMsg.content, "string", "未开视觉时不应发送图片内容");
  assert.match(userMsg.content, /图片|表情包/, "但应告知模型用户发了图");
});

test("图片下载失败时降级为纯文本，不中断对话", async () => {
  let captured = null;
  const gen = makeModelGenerator({
    config: VISION_CONFIG,
    logger,
    fetchImpl: async (_url, init) => {
      if (String(_url).includes("chat/completions")) {
        captured = JSON.parse(init.body);
        return new Response(JSON.stringify({ choices: [{ message: { content: "没图也能聊" } }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("boom", { status: 500 }); // 图片下载失败
    },
  });

  const reply = await gen({
    text: "这张图什么意思",
    media: { type: "image", label: "图片/表情包", count: 1 },
    attachments: [{ content_type: "image/png", url: "https://cdn.example.invalid/broken.png" }],
    history: [],
  });

  assert.equal(reply, "没图也能聊", "图挂了也要继续回话");
  assert.equal(typeof captured.messages.at(-1).content, "string", "降级为纯文本请求");
  assert.match(captured.messages.at(-1).content, /这张图什么意思/, "用户的文字不能丢");
});

test("系统提示词按视觉开关切换措辞", () => {
  const noVision = buildSystemPrompt({ vision: false });
  assert.equal(noVision, CHUNHE_SYSTEM_PROMPT, "无视觉时用原始提示词");
  assert.match(noVision, /看不到图片/);

  const vision = buildSystemPrompt({ vision: true });
  assert.match(vision, /确实收到了图片|可以直接看/, "有视觉时应告知模型能看图");
  assert.ok(!/你看不到图片/.test(vision), "不该再说自己看不到");
  // 诚实条款的其他内容不能被替换掉
  assert.match(vision, /绝不编造|不能编造/);
  assert.match(vision, /关于记忆/);
});

test("本地规则模式始终如实说看不到图（不会因配置而产生幻觉）", async () => {
  // 即使外部配置开了视觉，本地规则生成器也没有视觉能力，必须诚实
  const gen = makeLocalGenerator({ logger, vision: false });
  const reply = await gen({
    text: "",
    media: { type: "image", label: "图片/表情包", count: 1 },
  });
  assert.match(reply, /看不到/, "本地模式必须承认看不到");
  assert.ok(!/好可爱|我看到了/.test(reply), "不能编造画面内容");
});
