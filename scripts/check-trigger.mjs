/**
 * 群聊触发真实链路验证：喊名字就应答、闲聊不打扰、上下文能接上。
 */

import path from "node:path";
import fs from "node:fs";
import os from "node:os";

const ROOT = path.resolve(import.meta.dirname, "..").replace(/\\/g, "/");
const { MockQQServer } = await import(`file:///${ROOT}/src/mock/server.js`);
const { QQApi } = await import(`file:///${ROOT}/src/qq/api.js`);
const { QQGateway } = await import(`file:///${ROOT}/src/qq/gateway.js`);
const { MessageEngine } = await import(`file:///${ROOT}/src/core/engine.js`);
const { createPersona } = await import(`file:///${ROOT}/src/persona/chunhe.js`);
const { loadConfig, parseDotenv } = await import(`file:///${ROOT}/src/config.js`);
const { createLogger } = await import(`file:///${ROOT}/src/util/log.js`);

const docEnv = parseDotenv(fs.readFileSync(path.join(ROOT, ".env"), "utf8"));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "trigger-live-"));
const config = loadConfig({
  ...docEnv,
  QQ_GROUP_TRIGGER: "wake",
  QQ_WAKE_NAMES: "春禾",
  QQ_MULTI_MESSAGE: "false",
  QQ_MEMORY_FILE: path.join(tmp, "memory.json"),
  QQ_TOPIC_FILE: path.join(tmp, "topics.json"),
  QQ_ADMIN_USERS: "user-openid-1",
});

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

const waitFor = (fn, ms = 40000) => {
  const end = Date.now() + ms;
  return new Promise((resolve) => {
    const tick = () => {
      if (fn()) return resolve(true);
      if (Date.now() > end) return resolve(false);
      setTimeout(tick, 100);
    };
    tick();
  });
};

if (!(await waitFor(() => mock.connectedClients.length > 0, 6000))) {
  console.log("❌ 未连上模拟网关");
  process.exit(1);
}
console.log("机器人已上线 ✅\n");

// 普通群消息（不喊名字）——用 GROUP_MESSAGE_CREATE
const plain = (content, id, name = "群友甲") =>
  mock.pushEvent("GROUP_MESSAGE_CREATE", {
    id,
    content,
    timestamp: new Date().toISOString(),
    group_openid: "group-openid-1",
    author: { member_openid: `m-${id}`, username: name },
  });

// @ 消息
const at = (content, id, name = "群友乙") =>
  mock.pushEvent("GROUP_AT_MESSAGE_CREATE", {
    id,
    content,
    timestamp: new Date().toISOString(),
    group_openid: "group-openid-1",
    author: { member_openid: `m-${id}`, username: name },
  });

console.log("=== 场景 1：群里闲聊（没喊名字）——应该完全不回应 ===");
await plain("我们下周要交线性代数作业", "p1", "小明");
await plain("我还没开始写", "p2", "小红");
await new Promise((r) => setTimeout(r, 1500));
console.log(
  `  机器人回应条数: ${mock.sentMessages.length}  ${mock.sentMessages.length === 0 ? "✅ 没打扰" : "❌ 插话了"}`,
);
console.log(`  stats.skipped = ${engine.stats.skipped}`);
console.log(`  上下文缓冲: ${JSON.stringify(engine.getGroupWatch("group-openid-1"))}`);

console.log("\n=== 场景 2：喊一句「春禾」——应该应答，并能接上刚才的话题 ===");
mock.sentMessages.length = 0;
await plain("春禾你觉得呢", "w1", "小明");
const ok = await waitFor(() => mock.sentMessages.length > 0, 40000);
if (!ok) {
  console.log("  ❌ 喊名字没回应");
} else {
  console.log("  回复:", mock.sentMessages.map((m) => m.body.content).join("\n        "));
}

console.log("\n=== 场景 3：@ 依然有效 ===");
mock.sentMessages.length = 0;
await at("<@!100> 1+1 等于几", "a1");
const atOk = await waitFor(() => mock.sentMessages.length > 0, 40000);
console.log("  回复:", mock.sentMessages.map((m) => m.body.content).join(" | ") || "(无)");

console.log("\n=== 判定 ===");
const checks = [
  ["闲聊不打扰（0 条回应）", engine.stats.skipped >= 2],
  ["喊名字能应答", ok],
  ["上下文被记住", engine.getGroupWatch("group-openid-1").length >= 2],
  ["@ 依然有效", atOk],
];
for (const [n, v] of checks) console.log(`  ${v ? "✅" : "❌"} ${n}`);
console.log(`\n结果: ${checks.filter(([, v]) => v).length}/${checks.length}`);

gateway.stop();
await mock.stop();
await new Promise((r) => setTimeout(r, 200));
process.exit(0);
