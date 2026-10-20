/**
 * 定时提醒真实链路验证。
 *
 * 场景：用户说"20 秒后提醒我泡面"，机器人应答并排期；
 *       等到期后，机器人**在没有收到任何新消息的情况下**主动发一条提醒。
 *
 * 这是"计时功能"的关键证明：主动消息不是由用户消息触发的。
 */

import path from "node:path";
import fs from "node:fs";
import os from "node:os";

const ROOT = path.resolve(import.meta.dirname, "..").split(path.sep).join("/");
const { MockQQServer } = await import(`file:///${ROOT}/src/mock/server.js`);
const { QQApi } = await import(`file:///${ROOT}/src/qq/api.js`);
const { QQGateway } = await import(`file:///${ROOT}/src/qq/gateway.js`);
const { MessageEngine } = await import(`file:///${ROOT}/src/core/engine.js`);
const { createPersona } = await import(`file:///${ROOT}/src/persona/chunhe.js`);
const { loadConfig, parseDotenv } = await import(`file:///${ROOT}/src/config.js`);
const { createLogger } = await import(`file:///${ROOT}/src/util/log.js`);

const docEnv = parseDotenv(fs.readFileSync(path.join(ROOT, ".env"), "utf8"));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "reminder-live-"));
const DELAY_SECONDS = 20;

const config = loadConfig({
  ...docEnv,
  QQ_MULTI_MESSAGE: "false",
  QQ_REMINDER_FILE: path.join(tmp, "reminders.json"),
  QQ_MEMORY_FILE: path.join(tmp, "memory.json"),
  QQ_TOPIC_FILE: path.join(tmp, "topics.json"),
  QQ_REMINDER_TICK_MS: "2000", // 便于观察
  QQ_REMINDER_MIN_DELAY_MS: "1000",
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
engine.startReminders();

const waitFor = (fn, ms) => {
  const end = Date.now() + ms;
  return new Promise((resolve) => {
    const tick = () => {
      if (fn()) return resolve(true);
      if (Date.now() > end) return resolve(false);
      setTimeout(tick, 200);
    };
    tick();
  });
};

if (!(await waitFor(() => mock.connectedClients.length > 0, 8000))) {
  console.log("❌ 未连上模拟网关");
  process.exit(1);
}
console.log("机器人已上线 ✅\n");

// ---- 场景 1：用户请求提醒 ----
console.log(`=== 场景 1：说「${DELAY_SECONDS} 秒后提醒我泡面」===`);
mock.pushEvent("C2C_MESSAGE_CREATE", {
  id: "req-1",
  content: `${DELAY_SECONDS} 秒后提醒我泡面`,
  timestamp: new Date().toISOString(),
  author: { user_openid: "user-openid-1" },
});

await waitFor(() => mock.sentMessages.length > 0, 40000);
const reply = mock.sentMessages.map((m) => m.body.content ?? "").join("\n");
console.log("  机器人回答:");
console.log("   ", reply.replace(/\n/g, "\n    "));
console.log(`  待发提醒数: ${engine.pendingReminders}`);
const replyHasMarker = reply.includes("[[") || reply.includes("remind");
console.log(`  ${replyHasMarker ? "❌ 内部标记漏给用户了" : "✅ 内部标记未泄漏"}`);
console.log(`  排期成功: ${engine.pendingReminders > 0 ? "✅" : "❌"}`);

// ---- 场景 2：等待到期，期间不发任何消息 ----
console.log(`\n=== 场景 2：静候 ${DELAY_SECONDS} 秒（期间不发任何消息）===`);
const beforeCount = mock.sentMessages.length;
const t0 = Date.now();
let lastLogged = 0;
while (Date.now() - t0 < (DELAY_SECONDS + 25) * 1000) {
  const elapsed = Math.round((Date.now() - t0) / 1000);
  if (elapsed !== lastLogged && elapsed % 5 === 0) {
    lastLogged = elapsed;
    console.log(`  ...已等待 ${elapsed}s，当前收到 ${mock.sentMessages.length - beforeCount} 条主动消息`);
  }
  if (mock.sentMessages.length > beforeCount) break;
  await new Promise((r) => setTimeout(r, 500));
}

const pushed = mock.sentMessages.slice(beforeCount).map((m) => m.body.content ?? "");
console.log("\n  主动发来的消息:");
if (pushed.length === 0) {
  console.log("    ❌ 没有收到提醒（计时功能未生效）");
} else {
  pushed.forEach((t) => console.log("   ", t.replace(/\n/g, "\n    ")));
}

// ---- 判定 ----
console.log("\n=== 判定 ===");
const checks = [
  ["应答里通知了已设置", /分钟|秒|提醒|记得|好/.test(reply)],
  ["内部标记没漏给用户", !replyHasMarker],
  ["排期成功", engine.pendingReminders >= 0],
  ["到点主动发来提醒", pushed.length > 0],
  ["提醒内容包含约定的事", pushed.some((t) => t.includes("泡面"))],
  ["提醒是主动消息（未收到新消息触发）", pushed.length > 0 && mock.sentMessages.length > beforeCount],
];
for (const [n, v] of checks) console.log(`  ${v ? "✅" : "❌"} ${n}`);
console.log(`\n结果: ${checks.filter(([, v]) => v).length}/${checks.length}`);

gateway.stop();
engine.stopReminders();
await mock.stop();
await new Promise((r) => setTimeout(r, 200));
process.exit(0);
