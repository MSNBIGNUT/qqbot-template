/**
 * 群聊触发模式对模型调用次数的影响。
 *
 * 为什么重要：QQ_GROUP_TRIGGER=all 会让机器人在群里"每条消息都回"，
 * 而每次回复都是一次真实的模型调用。这比"离线空转"重要得多。
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

async function measure(trigger) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `trig-${trigger}-`));
  const config = loadConfig({
    ...docEnv,
    QQ_GROUP_TRIGGER: trigger,
    QQ_MULTI_MESSAGE: "false",
    QQ_MEMORY_FILE: path.join(tmp, "memory.json"),
    QQ_TOPIC_FILE: path.join(tmp, "topics.json"),
    QQ_REMINDER_FILE: path.join(tmp, "reminders.json"),
  });

  let modelCalls = 0;
  const generate = async () => {
    modelCalls += 1;
    return "假回复";
  };

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
    generate,
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
        setTimeout(tick, 50);
      };
      tick();
    });
  };
  if (!(await waitFor(() => mock.connectedClients.length > 0, 8000))) return null;

  // 模拟群里 10 条普通闲聊（都没有 @ 机器人）
  const chats = [
    "今天中午吃什么",
    "我投泡面一票",
    "别老吃泡面",
    "那吃食堂",
    "食堂三楼那家不错",
    "几点去啊",
    "十二点吧",
    "行",
    "我晚点",
    "那我们先去",
  ];
  for (let i = 0; i < chats.length; i += 1) {
    mock.pushEvent("GROUP_MESSAGE_CREATE", {
      id: `c-${action(i)}`,
      content: chats[i],
      timestamp: new Date().toISOString(),
      group_openid: "g1",
      author: { member_openid: `m${i}`, username: `群友${i}` },
    });
  }
  await new Promise((r) => setTimeout(r, 2000));

  const result = { trigger, modelCalls, replied: engine.stats.replied, skipped: engine.stats.skipped };
  gateway.stop();
  await mock.stop();
  return result;
}

let seed = 0;
function action(i) {
  seed += 1;
  return `${i}-${seed}`;
}

console.log("=== 群里 10 条普通闲聊（没有 @ 机器人），模型调用次数对比 ===\n");
for (const trigger of ["mention", "wake", "all"]) {
  const r = await measure(trigger);
  if (!r) {
    console.log(`  ${trigger}: 失败`);
    continue;
  }
  console.log(`  QQ_GROUP_TRIGGER=${r.trigger.padEnd(8)} → 模型调用 ${String(r.modelCalls).padStart(2)} 次，回应 ${r.replied} 条，跳过 ${r.skipped} 条`);
}

console.log("\n结论：all 模式下每一条群消息都会消耗 token；mention 模式下闲聊完全不消耗。");
process.exit(0);
