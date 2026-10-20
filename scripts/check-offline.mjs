/**
 * 离线空转实测：机器人在"没人跟它说话"时，到底会向模型发多少次请求？
 *
 * 重要：这里不发真实模型请求（用假 fetch 拦下来计数），
 * 所以不会消耗任何真实 token —— 这正是"想知道会不会被偷吃"的正确测法。
 *
 * 覆盖两种设置状态：
 *   A. 当前设置（主动消息关闭、无待发提醒）
 *   B. 主动消息开启（最坏情况：系统可能自己找人搭话）
 */

import path from "node:path";
import fs from "node:fs";
import os from "node:os";

const ROOT = path.resolve(import.meta.dirname, "..").split(path.sep).join("/");
const { MockQQServer } = await import(`file:///${ROOT}/src/mock/server.js`);
const { QQApi } = await import(`file:///${ROOT}/src/qq/api.js`);
const { QQGateway } = await import(`file:///${ROOT}/src/qq/gateway.js`);
const { MessageEngine } = await import(`file:///${ROOT}/src/core/engine.js`);
const { createPersona, createProactiveComposer } = await import(`file:///${ROOT}/src/persona/chunhe.js`);
const { ProactiveScheduler } = await import(`file:///${ROOT}/src/core/proactive.js`);
const { loadConfig, parseDotenv } = await import(`file:///${ROOT}/src/config.js`);
const { createLogger } = await import(`file:///${ROOT}/src/util/log.js`);

const docEnv = parseDotenv(fs.readFileSync(path.join(ROOT, ".env"), "utf8"));
const logger = createLogger("warn");

/** 假模型：记录每次调用，不发真实请求 */
function makeCountingFetch() {
  const calls = [];
  const fakeFetch = async (url, init) => {
    const body = init?.body ? JSON.parse(init.body) : {};
    calls.push({
      at: Date.now(),
      url: String(url),
      system: String(body?.messages?.[0]?.content ?? "").slice(0, 40),
      user: String(body?.messages?.at(-1)?.content ?? "").slice(0, 40),
    });
    return {
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: "假回复（测试用）" } }] }),
      text: async () => "",
    };
  };
  return { fakeFetch, calls };
}

async function runScenario({ name, env, waitSeconds, withPendingReminder }) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "offline-"));
  const config = loadConfig({
    ...docEnv,
    QQ_MEMORY_FILE: path.join(tmp, "memory.json"),
    QQ_TOPIC_FILE: path.join(tmp, "topics.json"),
    QQ_REMINDER_FILE: path.join(tmp, "reminders.json"),
    QQ_PROACTIVE_STATE_FILE: path.join(tmp, "proactive.json"),
    ...env,
  });

  const { fakeFetch, calls } = makeCountingFetch();
  const mock = await new MockQQServer({ heartbeatInterval: 45000 }).start();
  const api = new QQApi({
    appId: mock.expectedAppId,
    clientSecret: mock.expectedSecret,
    apiBase: mock.baseUrl,
    tokenBase: mock.baseUrl,
    logger,
  });

  const generate = createPersona({ config, logger, fetchImpl: fakeFetch });
  const engine = new MessageEngine({
    config: { ...config, allowUsers: [], denyUsers: [], allowGroups: [] },
    api,
    generate,
    logger,
  });

  // 主动消息：与 main.js 同样的接线
  // 注意必须把 generate 传进去，否则生成器会走"无模型"分支（返回 null），
  // 那测出来的 0 次调用是假的——之前就踩过这个坑。
  const composer = createProactiveComposer({
    config,
    logger,
    fetchImpl: fakeFetch,
    generate,
    getTopics: () => {
      try {
        const picked = engine.topics.pick({ includeShared: true, limit: 3 });
        return Array.isArray(picked) ? picked : [];
      } catch {
        return [];
      }
    },
  });

  const proactive = new ProactiveScheduler({
    enabled: config.proactive,
    idleMinutes: config.proactiveIdleMinutes,
    dailyLimit: config.proactiveDailyLimit,
    quietHours: "0-24", // 关掉静默时段，让"最坏情况"暴露出来
    checkIntervalMs: config.proactiveCheckIntervalMs,
    stateFile: config.proactiveStateFile,
    // 注意必须把 generate 传进去，否则生成器会走"无模型"分支（返回 null），
    // 那测出来的 0 次调用是假的——之前就踩过这个坑。
    compose: async (args) => {
      const out = await composer(args);
      console.log(`      [compose] 返回 ${out ? JSON.stringify(String(out.text ?? out).slice(0, 40)) : "null"}`);
      return out;
    },
    send: async (scope, targetId, text) => {
      try {
        const r = await api.sendProactiveMessage(scope, targetId, text);
        console.log(`      [send OK] ${scope}/${targetId} → ${String(text).slice(0, 30)}`);
        return r;
      } catch (err) {
        console.log(`      [send FAIL] ${err?.constructor?.name}: ${err?.message}`);
        throw err;
      }
    },
    logger,
  });
  engine.proactive = proactive;

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

  if (!(await waitFor(() => mock.connectedClients.length > 0, 8000))) {
    console.log(`  ❌ ${name}：未连上模拟网关`);
    gateway.stop();
    await mock.stop();
    return null;
  }

  // 先制造一轮活动，让会话进入"已活跃"状态（否则主动消息没有目标）
  mock.pushEvent("C2C_MESSAGE_CREATE", {
    id: "seed-1",
    content: "你好",
    timestamp: new Date().toISOString(),
    author: { user_openid: "user-openid-1" },
    // 标记为很久以前，方便直接满足"静默足够久"的条件
  });
  await waitFor(() => mock.sentMessages.length > 0, 20000);
  const callsAfterSeed = calls.length;
  const sentAfterSeed = mock.sentMessages.length;

  // 可选：排一条很晚才到期的提醒（验证"轮询本身不调模型"）
  if (withPendingReminder) {
    engine.scheduleReminder({
      sessionKey: "c2c:user-openid-1",
      scope: "c2c",
      targetId: "user-openid-1",
      message: "很久以后的事",
      delayMs: 3600000,
    });
  }

  engine.startReminders();
  proactive.start();

  // 诊断：把调度器内部状态打出来，避免"没触发"被误当成"不会触发"
  if (proactive.enabled) {
    console.log(`\n  [诊断] 主动消息调度器状态`);
    console.log(`    enabled=${proactive.enabled} idleMinutes=${proactive.idleMinutes} quietHours=${proactive.quietHours}`);
    console.log(`    inQuietHours=${proactive.inQuietHours()} remaining=${proactive.remaining()} checkIntervalMs=${proactive.checkIntervalMs}`);
    console.log(`    lastActivity 条目数=${proactive.lastActivity.size} targets 条目数=${proactive.targets.size}`);
    for (const [k, v] of proactive.lastActivity) console.log(`      session=${k} 上次活动=${new Date(v).toLocaleTimeString()}`);
    const pick = proactive.pickIdleSession();
    console.log(`    pickIdleSession() = ${pick ? JSON.stringify(pick) : "null ← 这就是没触发的原因"}`);
  }

  const t0 = Date.now();
  await new Promise((r) => setTimeout(r, waitSeconds * 1000));
  const idleSeconds = Math.round((Date.now() - t0) / 1000);

  const idleCalls = calls.length - callsAfterSeed;
  const idleSent = mock.sentMessages.length - sentAfterSeed;

  console.log(`\n${"=".repeat(64)}`);
  console.log(`场景 ${name}`);
  console.log(`${"=".repeat(64)}`);
  console.log(`  离线空转时长        : ${idleSeconds}s`);
  console.log(`  期间模型请求次数    : ${idleCalls}  ${idleCalls === 0 ? "✅ 没有偷调模型" : "⚠️ 调了模型"}`);
  console.log(`  期间主动发出消息    : ${idleSent} 条`);
  console.log(`  提醒轮询次数(理论)  : ${Math.floor((idleSeconds * 1000) / config.reminderTickMs)} 次（每次都不调模型，除非有到期的）`);
  if (proactive.enabled) {
    console.log(`  主动消息检查(理论)  : ${Math.floor((idleSeconds * 1000) / proactive.checkIntervalMs)} 次`);
  } else {
    console.log(`  主动消息            : 已关闭（未启用）`);
  }
  if (idleCalls > 0) {
    console.log(`  调用明细：`);
    calls.slice(callsAfterSeed, callsAfterSeed + 5).forEach((c) =>
      console.log(`    - system="${c.system}" user="${c.user}"`),
    );
  }

  gateway.stop();
  engine.stopReminders();
  proactive.stop();
  await mock.stop();
  return { idleCalls, idleSent, idleSeconds };
}

console.log("离线空转实测（假模型计数，不消耗真实 token）");

const results = [];

// A：当前设置（主动消息关闭）+ 一条很久以后才到期的提醒
results.push(
  await runScenario({
    name: "A. 当前设置（QQ_PROACTIVE=false）+ 有待发提醒",
    env: { QQ_PROACTIVE: "false" },
    waitSeconds: 40,
    withPendingReminder: true,
  }),
);

// B：主动消息开启，最坏情况
results.push(
  await runScenario({
    name: "B. 主动消息开启（QQ_PROACTIVE=true）",
    env: {
      QQ_PROACTIVE: "true",
      QQ_PROACTIVE_IDLE_MINUTES: "0", // 立刻满足"静默足够久"
      QQ_PROACTIVE_CHECK_INTERVAL_MS: "5000", // 缩短检查间隔，暴露行为
      QQ_PROACTIVE_DAILY_LIMIT: "3",
      QQ_PROACTIVE_QUIET_HOURS: "0-24",
    },
    waitSeconds: 40,
    withPendingReminder: false,
  }),
);

console.log(`\n${"=".repeat(64)}`);
console.log("汇总");
console.log(`${"=".repeat(64)}`);
results.forEach((r, i) => {
  if (!r) return;
  console.log(`  ${i === 0 ? "A" : "B"}: ${r.idleSeconds}s 空转 → 模型请求 ${r.idleCalls} 次，主动消息 ${r.idleSent} 条`);
});

process.exit(0);
