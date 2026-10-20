/**
 * 验证"能力否认"问题是否修好。
 *
 * 回归的真实故障：主人问"现在会计时了吗"，春禾回答
 * 「春禾没有真正的定时能力…按诚实条款得说实话：没法主动定时推送」
 * —— 用诚实条款否决了真实功能，还向用户汇报了内部机制。
 *
 * 这里用当时那几句话原样再问一次。
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

// 这些是"她曾经错误否认"的说法，命中就说明还没修好
const DENIAL_PATTERNS = [
  /没有真正的定时/,
  /没有(真正的)?(定时|计时)能力/,
  /没法(真的)?(主动)?(定时)?推送/,
  /不能.*主动.*(发|推送)消息/,
  /只是设定/,
  /其实是假/,
  /按诚实条款.*做不到/,
  /\[\[remind/,
  /标记/,
];

async function ask(question) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cap-"));
  const config = loadConfig({
    ...docEnv,
    QQ_MULTI_MESSAGE: "false",
    QQ_MEMORY_FILE: path.join(tmp, "memory.json"),
    QQ_TOPIC_FILE: path.join(tmp, "topics.json"),
    QQ_REMINDER_FILE: path.join(tmp, "reminders.json"),
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

  const waitFor = (fn, ms) => {
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

  if (!(await waitFor(() => mock.connectedClients.length > 0, 8000))) return null;

  mock.pushEvent("C2C_MESSAGE_CREATE", {
    id: `q-${Math.random().toString(36).slice(2)}`,
    content: question,
    timestamp: new Date().toISOString(),
    author: { user_openid: "user-openid-1" },
  });

  await waitFor(() => mock.sentMessages.length > 0, 40000);
  const text = mock.sentMessages.map((m) => m.body.content ?? "").join("\n");
  const pending = engine.pendingReminders;

  gateway.stop();
  await mock.stop();
  return { text, pending };
}

const questions = ["现在会计时了吗", "五分钟后提醒我泡面"];

let pass = 0;
let total = 0;
for (const q of questions) {
  const r = await ask(q);
  total += 1;
  console.log("=".repeat(64));
  console.log(`问：${q}`);
  console.log("=".repeat(64));
  if (!r) {
    console.log("  ❌ 无回应");
    continue;
  }
  console.log(r.text);
  const hits = DENIAL_PATTERNS.filter((re) => re.test(r.text)).map((re) => re.source);
  const ok = hits.length === 0;
  if (ok) pass += 1;
  console.log("");
  console.log(ok ? "  ✅ 没有否认自己的能力，也没泄漏内部机制" : `  ❌ 仍出现否认/泄漏：${JSON.stringify(hits)}`);
  if (q.includes("提醒")) {
    console.log(`  待发提醒数：${r.pending} ${r.pending > 0 ? "✅ 已排期" : "❌ 未排期"}`);
  }
  console.log("");
}

console.log(`结果: ${pass}/${total}`);
await new Promise((r) => setTimeout(r, 200));
process.exit(0);
