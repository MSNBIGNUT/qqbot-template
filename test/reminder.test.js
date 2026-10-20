/**
 * 定时提醒测试。
 *
 * 这是"用户能明显感觉到"的功能：设错了要么永远不提醒（失望），
 * 要么半夜刷屏（更糟）。所以边界必须守住。
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { ReminderStore, parseDuration, humanizeDelay } from "../src/core/reminders.js";
import { extractReminderMarkers, parseReminderRequest } from "../src/core/reminder-intent.js";
import { MessageEngine } from "../src/core/engine.js";
import { loadConfig } from "../src/config.js";
import { createLogger } from "../src/util/log.js";

const logger = createLogger("silent");
const tmpFile = (name = "reminders.json") =>
  path.join(fs.mkdtempSync(path.join(os.tmpdir(), "qqbot-rem-")), name);

// ---------------- 时长解析 ----------------

test("时长解析：支持秒/分/时/天与中英文", () => {
  assert.equal(parseDuration("30s"), 30000);
  assert.equal(parseDuration("5m"), 300000);
  assert.equal(parseDuration("2h"), 7200000);
  assert.equal(parseDuration("1d"), 86400000);
  assert.equal(parseDuration("5分钟"), 300000);
  assert.equal(parseDuration("3小时"), 10800000);
  assert.equal(parseDuration("2天"), 172800000);
  // 纯数字按分钟
  assert.equal(parseDuration("90"), 5400000);
});

test("时长解析：非法输入返回 null，不瞎猜", () => {
  for (const bad of ["", "abc", "0", "-5", "5x", null, undefined]) {
    assert.equal(parseDuration(bad), null, `应拒绝：${bad}`);
  }
});

test("时长口语化：用于回执文案", () => {
  assert.equal(humanizeDelay(30000), "30 秒");
  assert.equal(humanizeDelay(300000), "5 分钟");
  assert.equal(humanizeDelay(7200000), "2 小时");
  assert.equal(humanizeDelay(86400000), "1 天");
});

// ---------------- 模型标记 ----------------

test("标记解析：能从回复里抽出提醒并剥离标记", () => {
  const r = extractReminderMarkers("好的主人～[[remind:5m:泡面该吃啦]]记得回来哦");
  assert.equal(r.text, "好的主人～记得回来哦", "标记必须从用户可见文本里消失");
  assert.equal(r.reminders.length, 1);
  assert.equal(r.reminders[0].delayMs, 300000);
  assert.equal(r.reminders[0].message, "泡面该吃啦");
});

test("标记解析：无标记时原样返回", () => {
  const r = extractReminderMarkers("今天天气不错呀～");
  assert.equal(r.text, "今天天气不错呀～");
  assert.equal(r.reminders.length, 0);
});

test("标记解析：多个标记都能取出，且剥离干净", () => {
  const r = extractReminderMarkers("好～[[remind:1m:喝水]]还有[[remind:2h:开会]]");
  assert.equal(r.reminders.length, 2);
  assert.ok(!r.text.includes("[["), `标记应全部移除，实际：${r.text}`);
  assert.match(r.text, /好～/);
});

test("标记解析：非法时长被标出（delayMs 为 null），由上层拒绝", () => {
  const r = extractReminderMarkers("好[[remind:乱写:某事]]");
  assert.equal(r.reminders.length, 1);
  assert.equal(r.reminders[0].delayMs, null, "解析不出时长就该是 null，不能猜");
});

// ---------------- 本地意图 ----------------

test("本地意图：能识别常见的提醒请求", () => {
  const a = parseReminderRequest("五分钟后提醒我泡面");
  assert.ok(a, "应识别");
  assert.equal(a.delayMs, 300000);
  assert.match(a.message, /泡面/);

  const b = parseReminderRequest("30秒后叫我一下");
  assert.ok(b);
  assert.equal(b.delayMs, 30000);

  const c = parseReminderRequest("1小时后提醒我：开会");
  assert.ok(c);
  assert.equal(c.message, "开会", "冒号后的内容应作为提醒正文");
});

test("本地意图：普通闲聊不误判", () => {
  for (const s of [
    "今天天气不错",
    "提醒我这个词是什么意思",
    "吃完饭后我们聊聊",
    "你好呀",
    "",
  ]) {
    assert.equal(parseReminderRequest(s), null, `不该误判：${s}`);
  }
});

// ---------------- 存储 ----------------

test("存储：排期后能按时取出", () => {
  let now = 1000000;
  const store = new ReminderStore({ now: () => now });
  const r = store.schedule({ sessionKey: "c2c:u1", scope: "c2c", targetId: "u1", text: "喝水", delayMs: 60000 });
  assert.equal(r.ok, true);
  assert.equal(store.size, 1);

  assert.deepEqual(store.takeDue(), [], "还没到期不该取出");

  now += 60000;
  const due = store.takeDue();
  assert.equal(due.length, 1);
  assert.equal(due[0].text, "喝水");
  assert.equal(store.size, 0, "取出后应从队列移除");
});

test("存储：太短与太长的延迟都被拒绝", () => {
  const store = new ReminderStore({ minDelayMs: 5000, maxDelayMs: 86400000 });
  assert.equal(
    store.schedule({ sessionKey: "c2c:u1", scope: "c2c", targetId: "u1", text: "x", delayMs: 100 }).ok,
    false,
    "太短（<5s）应拒绝——那么短没必要定时",
  );
  const tooFar = store.schedule({ sessionKey: "c2c:u1", scope: "c2c", targetId: "u1", text: "x", delayMs: 8 * 86400000 });
  assert.equal(tooFar.ok, false);
  assert.equal(tooFar.reason, "too_far");
});

test("存储：空内容与缺目标被拒绝", () => {
  const store = new ReminderStore();
  assert.equal(store.schedule({ sessionKey: "c2c:u1", scope: "c2c", targetId: "u1", text: "  ", delayMs: 60000 }).ok, false);
  assert.equal(store.schedule({ sessionKey: "", scope: "c2c", targetId: "u1", text: "x", delayMs: 60000 }).ok, false);
});

test("存储：每日上限生效（防止定时提醒被滥用成刷屏）", () => {
  const store = new ReminderStore({ perSessionLimit: 2 });
  const args = { sessionKey: "c2c:u1", scope: "c2c", targetId: "u1", text: "x", delayMs: 60000 };
  assert.equal(store.schedule(args).ok, true);
  assert.equal(store.schedule(args).ok, true);
  const third = store.schedule(args);
  assert.equal(third.ok, false);
  assert.equal(third.reason, "daily_limit");

  // 另一个会话不受影响
  assert.equal(
    store.schedule({ ...args, sessionKey: "c2c:u2" }).ok,
    true,
    "上限应按会话隔离",
  );
});

test("存储：可取消某会话或全部", () => {
  const store = new ReminderStore();
  store.schedule({ sessionKey: "c2c:u1", scope: "c2c", targetId: "u1", text: "a", delayMs: 60000 });
  store.schedule({ sessionKey: "c2c:u2", scope: "c2c", targetId: "u2", text: "b", delayMs: 60000 });
  assert.equal(store.cancel("c2c:u1"), 1);
  assert.equal(store.size, 1);
  assert.equal(store.cancel(), 1);
  assert.equal(store.size, 0);
});

test("存储：持久化后重启仍在（按绝对时间算，不会重置）", () => {
  const file = tmpFile();
  let now = 1000000;
  const s1 = new ReminderStore({ file, now: () => now });
  s1.schedule({ sessionKey: "c2c:u1", scope: "c2c", targetId: "u1", text: "喝水", delayMs: 60000 });
  s1.flush(true);

  // 重启：时间前进 30 秒
  now += 30000;
  const s2 = new ReminderStore({ file, now: () => now });
  assert.equal(s2.size, 1, "重启后提醒不应丢失");
  assert.deepEqual(s2.takeDue(), [], "还没到点，不该立刻发");
  now += 30000;
  assert.equal(s2.takeDue().length, 1, "到点后应发出");
});

test("存储：过期太久的提醒不补发（避免开机刷屏）", () => {
  const file = tmpFile();
  let now = 1000000;
  const s1 = new ReminderStore({ file, now: () => now });
  s1.schedule({ sessionKey: "c2c:u1", scope: "c2c", targetId: "u1", text: "很久以前的事", delayMs: 60000 });
  s1.flush(true);

  // 模拟关机一整晚
  now += 10 * 3600000;
  const s2 = new ReminderStore({ file, now: () => now });
  assert.equal(s2.size, 0, "过期超过 30 分钟的提醒应被丢弃，不要一开机轰一堆消息");
});

test("存储：文件损坏时降级为空，不阻塞启动", () => {
  const file = tmpFile();
  fs.writeFileSync(file, "{ 不是 JSON", "utf8");
  const store = new ReminderStore({ file });
  assert.equal(store.size, 0);
  assert.equal(store.schedule({ sessionKey: "c2c:u1", scope: "c2c", targetId: "u1", text: "x", delayMs: 60000 }).ok, true);
});

test("存储：nextDueAt 给出正确的下一个到期时间", () => {
  let now = 1000;
  const store = new ReminderStore({ now: () => now });
  assert.equal(store.nextDueAt(), null);
  store.schedule({ sessionKey: "c2c:u1", scope: "c2c", targetId: "u1", text: "b", delayMs: 120000 });
  store.schedule({ sessionKey: "c2c:u1", scope: "c2c", targetId: "u1", text: "a", delayMs: 60000 });
  assert.equal(store.nextDueAt(), now + 60000);
});

// ---------------- 引擎集成 ----------------

function makeEngine(env = {}) {
  const config = loadConfig({
    QQ_APP_ID: "1",
    QQ_APP_SECRET: "s",
    QQ_REMINDER_FILE: tmpFile(),
    QQ_TOPIC_FILE: tmpFile("topics.json"),
    QQ_MEMORY_FILE: tmpFile("memory.json"),
    ...env,
  });
  const sent = [];
  const proactive = [];
  const engine = new MessageEngine({
    config,
    api: {
      sendMessage: async (scope, targetId, text) => {
        sent.push({ scope, targetId, text });
        return { id: `m${sent.length}` };
      },
      sendProactiveMessage: async (scope, targetId, text) => {
        proactive.push({ scope, targetId, text });
        return { id: `p${proactive.length}` };
      },
    },
    generate: async () => "好的主人～春禾会记得的 [[remind:1m:喝水]]",
    logger,
  });
  engine.sentMessages = sent;
  engine.proactiveMessages = proactive;
  return engine;
}

const c2cMsg = (over = {}) => ({
  kind: "c2c",
  scope: "c2c",
  rawEventType: "C2C_MESSAGE_CREATE",
  senderId: "u1",
  content: "一分钟后提醒我喝水",
  messageId: `m-${Math.random().toString(36).slice(2)}`,
  targetId: "u1",
  attachments: [],
  ...over,
});

test("引擎：模型写了标记就排期，且标记不出现在发给用户的消息里", async () => {
  const e = makeEngine();
  const r = await e.handle(c2cMsg());
  assert.equal(r.action, "replied");
  const text = e.sentMessages.at(-1).text;
  assert.ok(!text.includes("[[remind"), `用户不该看到内部标记：${text}`);
  assert.match(text, /1 分钟/, "应有一句自然的回执，让用户知道设上了");
  assert.equal(e.pendingReminders, 1, "应排入一条提醒");
});

test("引擎：到期后主动发出提醒（带 AI 标识策略）", async () => {
  const e = makeEngine({ QQ_REMINDER_MIN_DELAY_MS: "1" });
  // 直接排一条 1ms 的
  const res = e.scheduleReminder({
    sessionKey: "c2c:u1",
    scope: "c2c",
    targetId: "u1",
    message: "该喝水啦",
    delayMs: 10,
  });
  assert.equal(res.ok, true);
  await new Promise((r) => setTimeout(r, 30));

  const out = await e.tickReminders();
  assert.equal(out.sent, 1, "应发出 1 条");
  assert.equal(e.proactiveMessages.length, 1);
  assert.match(e.proactiveMessages[0].text, /该喝水啦/);
  assert.equal(e.proactiveMessages[0].scope, "c2c");
});

test("引擎：用户退订主动消息后，提醒一并取消", async () => {
  const e = makeEngine({ QQ_REMINDER_MIN_DELAY_MS: "1" });
  // 模拟用户关闭推送
  e.proactive = { muted: new Set(["c2c:u1"]), mute: (k) => e.proactive.muted.add(k) };

  const res = e.scheduleReminder({
    sessionKey: "c2c:u1",
    scope: "c2c",
    targetId: "u1",
    message: "不该发出去",
    delayMs: 10,
  });
  assert.equal(res.ok, false, "退订后不该再排提醒");
  assert.equal(res.reason, "user_muted");
});

test("引擎：本地模式也能识别提醒请求（不依赖模型标记）", async () => {
  const config = loadConfig({
    QQ_APP_ID: "1",
    QQ_APP_SECRET: "s",
    QQ_REMINDER_FILE: tmpFile(),
    QQ_REMINDER_MIN_DELAY_MS: "1",
    QQ_TOPIC_FILE: tmpFile("t2.json"),
    QQ_MEMORY_FILE: tmpFile("m2.json"),
  });
  const sent = [];
  const e = new MessageEngine({
    config,
    api: { sendMessage: async (s, t, text) => (sent.push(text), { id: "1" }) },
    // 本地规则式回复：不含标记
    generate: async () => "好呀，主人放心去忙～",
    logger,
  });

  const r = await e.handle(c2cMsg({ content: "5分钟后提醒我泡面" }));
  assert.equal(r.action, "replied");
  assert.equal(e.pendingReminders, 1, "即使模型没写标记，也应从用户原话识别出提醒");
  assert.match(sent.at(-1), /5 分钟/, "应告知已设置");
});

test("引擎：普通聊天不会误排提醒", async () => {
  const config = loadConfig({
    QQ_APP_ID: "1",
    QQ_APP_SECRET: "s",
    QQ_REMINDER_FILE: tmpFile(),
    QQ_TOPIC_FILE: tmpFile("t3.json"),
    QQ_MEMORY_FILE: tmpFile("m3.json"),
  });
  const e = new MessageEngine({
    config,
    api: { sendMessage: async () => ({ id: "1" }) },
    generate: async () => "今天天气确实不错呀～",
    logger,
  });
  await e.handle(c2cMsg({ content: "今天天气不错" }));
  assert.equal(e.pendingReminders, 0, "闲聊不该产生提醒");
});

test("引擎：标记里的非法时长不会排期", async () => {
  const config = loadConfig({
    QQ_APP_ID: "1",
    QQ_APP_SECRET: "s",
    QQ_REMINDER_FILE: tmpFile(),
    QQ_TOPIC_FILE: tmpFile("t4.json"),
    QQ_MEMORY_FILE: tmpFile("m4.json"),
  });
  const sent = [];
  const e = new MessageEngine({
    config,
    api: { sendMessage: async (s, t, text) => (sent.push(text), { id: "1" }) },
    generate: async () => "好[[remind:乱写:某事]]",
    logger,
  });
  await e.handle(c2cMsg({ content: "随便" }));
  assert.equal(e.pendingReminders, 0);
  assert.ok(!sent.at(-1).includes("[["), "无效标记也要从用户可见文本里删掉");
});
