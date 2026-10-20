/**
 * 真实视觉链路端到端验证（不连 QQ，用模拟网关 + 真实模型）。
 *
 * 流程：本地图片服务 → 模拟网关推送带附件的消息 → 机器人下载图片 →
 *      base64 送模型 → 断言回答里出现图片的真实内容。
 */

import http from "node:http";
import zlib from "node:zlib";
import path from "node:path";
import fs from "node:fs";

const ROOT = path.resolve(import.meta.dirname, "..").replace(/\\/g, "/");

// ---------- 1) 生成一张内容明确的测试图（纯 Node，无外部依赖） ----------
let CRC_TABLE = null;
function crc32(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c;
    }
  }
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return c ^ 0xffffffff;
}
function makePng(w, h, draw) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y += 1) {
    const rs = y * (w * 3 + 1);
    for (let x = 0; x < w; x += 1) {
      const [r, g, b] = draw(x, y);
      const p = rs + 1 + x * 3;
      raw[p] = r; raw[p + 1] = g; raw[p + 2] = b;
    }
  }
  const chunk = (t, d) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(d.length, 0);
    const tb = Buffer.from(t, "ascii");
    const cb = Buffer.alloc(4); cb.writeUInt32BE(crc32(Buffer.concat([tb, d])) >>> 0, 0);
    return Buffer.concat([len, tb, d, cb]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0)),
  ]);
}

// 蓝底 + 中央黄色大圆 + 圆内左上角一个红色方块（可判定）
const TRUTH = { bg: ["蓝色", "蓝"], shape: ["黄色", "黄"], marker: ["红色", "红"], pos: ["左上"] };
const png = makePng(320, 240, (x, y) => {
  const inCircle = (x - 160) ** 2 + (y - 120) ** 2 <= 80 ** 2;
  if (!inCircle) return [0, 0, 255];
  if (x >= 110 && x <= 150 && y >= 60 && y <= 100) return [255, 0, 0];
  return [255, 255, 0];
});

// ---------- 2) 起图片服务 ----------
const imgServer = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "image/png", "Content-Length": png.length });
  res.end(png);
});
await new Promise((r) => imgServer.listen(0, "127.0.0.1", r));
const imageUrl = `http://127.0.0.1:${imgServer.address().port}/test.png`;
console.log("测试图直链:", imageUrl);
console.log("图中真实内容: 蓝色背景 + 中央黄色圆形 + 圆内左上角红色方块\n");

// ---------- 3) 启动机器人栈（模拟网关） ----------
const { MockQQServer } = await import("file:///" + ROOT + "/src/mock/server.js");
const { QQApi } = await import("file:///" + ROOT + "/src/qq/api.js");
const { QQGateway } = await import("file:///" + ROOT + "/src/qq/gateway.js");
const { MessageEngine } = await import("file:///" + ROOT + "/src/core/engine.js");
const { createPersona } = await import("file:///" + ROOT + "/src/persona/chunhe.js");
const { loadConfig, parseDotenv } = await import("file:///" + ROOT + "/src/config.js");
const { createLogger } = await import("file:///" + ROOT + "/src/util/log.js");

const docEnv = parseDotenv(fs.readFileSync(path.join(ROOT, ".env"), "utf8"));
const config = loadConfig({ ...process.env, ...docEnv });
console.log(`人格层配置: 模型=${config.modelName} 视觉=${config.modelVision}\n`);

const logger = createLogger("info");
const mock = await new MockQQServer({ heartbeatInterval: 45000 }).start();

const api = new QQApi({
  appId: mock.expectedAppId,
  clientSecret: mock.expectedSecret,
  apiBase: mock.baseUrl,
  tokenBase: mock.baseUrl,
  logger,
});
const engine = new MessageEngine({
  config: { ...config, allowUsers: [], denyUsers: [], allowGroups: [] },
  api,
  generate: createPersona({ config, logger }),
  logger,
});
const gateway = new QQGateway({
  getAccessToken: () => api.getAccessToken(),
  getGatewayUrl: () => api.getGatewayUrl(),
  intents: config.intents,
  onMessage: (m) => engine.handle(m),
  sessionFile: null,
  logger,
});
gateway.start();

const waitFor = (fn, ms = 8000) => {
  const end = Date.now() + ms;
  return new Promise((resolve) => {
    const tick = () => {
      if (fn()) return resolve(true);
      if (Date.now() > end) return resolve(false);
      setTimeout(tick, 50);
    };
    tick();
  });
};

if (!(await waitFor(() => mock.connectedClients.length > 0, 6000))) {
  console.log("❌ 未能连上模拟网关");
  process.exit(1);
}
console.log("机器人已连上模拟网关 ✅\n");

// ---------- 4) 推送一条「纯图片」消息 ----------
mock.pushEvent("C2C_MESSAGE_CREATE", {
  id: "vision-1",
  content: "",
  timestamp: new Date().toISOString(),
  author: { user_openid: "user-openid-1" },
  attachments: [{ content_type: "image/png", url: imageUrl }],
  message_type: 1,
});
console.log("已推送一张图片（无文字）…\n");

if (!(await waitFor(() => mock.sentMessages.length > 0, 30000))) {
  console.log("❌ 机器人没有回复");
  gateway.stop();
  await mock.stop();
  imgServer.close();
  process.exit(1);
}

const reply = mock.sentMessages[0].body.content ?? "";
console.log("=== 机器人回复 ===");
console.log(reply);
console.log("\n=== 判定 ===");
// 注意：不能用 new RegExp("蓝色/蓝") 来表示"或"，'/' 在正则里只是普通字符。
// 这里用数组 + some.includes，避免这类自伤。
const hit = (words) => words.some((w) => reply.includes(w));
const checks = [
  ["提到蓝色背景", hit(TRUTH.bg)],
  ["提到黄色圆形", hit(TRUTH.shape)],
  ["提到红色方块", hit(TRUTH.marker)],
  ["指出在左上方", hit(TRUTH.pos)],
  ["带 AI 标识", reply.startsWith("【AI】")],
  ["没有否认看不到", !reply.includes("看不到") && !reply.includes("无法查看")],
];
for (const [name, ok] of checks) console.log(`  ${ok ? "✅" : "❌"} ${name}`);
const passed = checks.filter(([, ok]) => ok).length;
console.log(`\n结果: ${passed}/${checks.length}`);
console.log(
  passed >= 4
    ? "✅ 真实视觉链路打通：机器人确实读懂了图片"
    : "❌ 视觉链路未达预期（详见上方回复）",
);

gateway.stop();
await mock.stop();
imgServer.close();
await new Promise((r) => setTimeout(r, 200));
process.exit(0);
