/**
 * "像个人"功能的真实链路验证：多段回复 + 话题跨场景续接。
 * 不连 QQ，用模拟网关 + 真实模型。
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
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "chat-live-"));
const config = loadConfig({
  ...docEnv,
  QQ_MEMORY_FILE: path.join(tmp, "memory.json"),
  QQ_TOPIC_FILE: path.join(tmp, "topics.json"),
  QQ_PROACTIVE_STATE_FILE: path.join(tmp, "proactive.json"),
  // 把测试用户当作"主人"，这样单聊话题会进入共享库（模拟跨场景）
  QQ_ADMIN_USERS: "user-openid-1",
  QQ_MULTI_MESSAGE_MIN: "1",
  QQ_MULTI_MESSAGE_MAX: "3",
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

/** 等某个条件成立（用于连接就绪） */
const waitFor = (fn, ms = 30000) => {
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

/** 等消息数量稳定下来（多段回复是分批发的，不能只等第一条） */
async function waitQuiet(getCount, quietMs = 1200, maxMs = 40000) {
  const deadline = Date.now() + maxMs;
  let last = -1;
  let stableSince = 0;
  for (;;) {
    const n = getCount();
    if (n !== last) {
      last = n;
      stableSince = Date.now();
    } else if (n > 0 && Date.now() - stableSince >= quietMs) {
      return true;
    }
    if (Date.now() > deadline) return last > 0;
    await new Promise((r) => setTimeout(r, 100));
  }
}

if (!(await waitFor(() => mock.connectedClients.length > 0, 6000))) {
  console.log("❌ 未能连上模拟网关");
  process.exit(1);
}
console.log("机器人已上线 ✅\n");

// ---------- 场景 1：单聊聊一件具体的事（应被记入共享话题） ----------
console.log("=== 场景 1：单聊里聊一件事 ===");
mock.pushEvent("C2C_MESSAGE_CREATE", {
  id: "m1",
  content: "我最近在学线性代数，特征值那部分有点绕",
  timestamp: new Date().toISOString(),
  author: { user_openid: "user-openid-1" },
});
await waitQuiet(() => mock.sentMessages.length);
const batch = mock.sentMessages.slice();
console.log(`机器人分 ${batch.length} 条回复：`);
batch.forEach((m, i) => console.log(`  [${i + 1}] ${(m.body.content ?? "").slice(0, 90)}`));
console.log(`话题库大小: ${engine.topics.size}`);
engine.topics.topics.slice(-3).forEach((t) => console.log(`  · ${t.text} (shared=${t.shared})`));

// ---------- 场景 2：群里问一句，看能不能续上私聊的事 ----------
console.log("\n=== 场景 2：群里问最近在忙什么（看能否续上私聊话题）===");
mock.sentMessages.length = 0;
mock.pushEvent("GROUP_AT_MESSAGE_CREATE", {
  id: "g1",
  content: "<@!100> 我最近在忙什么来着",
  timestamp: new Date().toISOString(),
  group_openid: "group-openid-1",
  author: { member_openid: "member-x", username: "群友" },
});
await waitQuiet(() => mock.sentMessages.length);
const groupReplies = mock.sentMessages.map((m) => m.body.content ?? "");
groupReplies.forEach((c, i) => console.log(`  [${i + 1}] ${c.slice(0, 160)}`));

// ---------- 判定 ----------
console.log("\n=== 判定 ===");
const mentionsTopic = groupReplies.join(" ").includes("线性代数");
const checks = [
  ["单聊能回复", batch.length >= 1],
  ["多段回复生效", batch.length >= 2],
  ["话题被记入共享库", engine.topics.size >= 1],
  ["群里回复了", groupReplies.length >= 1],
  ["群里提到私聊聊过的『线性代数』", mentionsTopic],
];
for (const [name, ok] of checks) console.log(`  ${ok ? "✅" : "❌"} ${name}`);
console.log(`\n结果: ${checks.filter(([, ok]) => ok).length}/${checks.length}`);
console.log(
  checks.filter(([, ok]) => ok).length >= 3
    ? "✅ 跨场景话题续接打通"
    : "⚠️ 未完全达到预期（详见上方输出）",
);

gateway.stop();
await mock.stop();
await new Promise((r) => setTimeout(r, 200));
process.exit(0);
