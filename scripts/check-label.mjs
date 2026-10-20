/**
 * 验证 AI 标识三种方式在真实链路里的效果（用模拟网关 + 真模型）。
 *
 * 用途：让使用者亲眼看到"关掉 AI 标识后聊天长什么样"，再决定是否保留。
 * 问题可通过环境变量 CHECK_QUESTION 指定（避免 PowerShell 传中文参数时被转义破坏）。
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
const logger = createLogger("warn");

function waitFor(predicate, timeoutMs) {
  const end = Date.now() + timeoutMs;
  return new Promise(function tick(resolve) {
    if (predicate()) return resolve(true);
    if (Date.now() > end) return resolve(false);
    setTimeout(() => tick(resolve), 100);
  });
}

async function ask(style, question) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `label-${style}-`));
  const config = loadConfig({
    ...docEnv,
    AI_LABEL_STYLE: style,
    QQ_MULTI_MESSAGE: "false",
    QQ_MEMORY_FILE: path.join(tmp, "memory.json"),
    QQ_TOPIC_FILE: path.join(tmp, "topics.json"),
    QQ_ADMIN_USERS: "user-openid-1",
  });

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

  const connected = await waitFor(() => mock.connectedClients.length > 0, 8000);
  if (!connected) {
    gateway.stop();
    await mock.stop();
    return null;
  }

  mock.pushEvent("C2C_MESSAGE_CREATE", {
    id: `m-${style}`,
    content: question,
    timestamp: new Date().toISOString(),
    author: { user_openid: "user-openid-1" },
  });

  await waitFor(() => mock.sentMessages.length > 0, 40000);
  const text = mock.sentMessages.map((m) => m.body.content ?? "").join("\n");

  gateway.stop();
  await mock.stop();
  return text;
}

const question = process.env.CHECK_QUESTION || process.argv[2] || "你好呀，今天感觉怎么样";

console.log("=== AI 标识三种方式的真实效果 ===");
console.log(`问题：${question}\n`);

for (const style of ["none", "prefix", "suffix"]) {
  const text = await ask(style, question);
  console.log("=".repeat(60));
  console.log(`【AI_LABEL_STYLE=${style}】`);
  console.log("=".repeat(60));
  console.log(text || "(无回应)");
  console.log("");
}

await new Promise((r) => setTimeout(r, 200));
process.exit(0);
