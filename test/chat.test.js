/**
 * "像个人一样" 的三块能力测试：多段回复、话题跨场景、主动搭话。
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { splitReply, planGaps, gapAfter } from "../src/core/chat-split.js";
import { TopicStore, tokenize, normalizeTopic } from "../src/core/topics.js";
import { ProactiveScheduler, parseQuietHours, todayKey } from "../src/core/proactive.js";
import { extractTopic } from "../src/core/engine.js";
import { createProactiveComposer, PROACTIVE_PROMPT } from "../src/persona/chunhe.js";
import { createLogger } from "../src/util/log.js";

const logger = createLogger("silent");
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "qqbot-chat-"));

// ---------------- 多段回复 ----------------

test("多段：短句不拆（一两句拆开反而更假）", () => {
  assert.deepEqual(splitReply("好的呀～", { minChars: 20 }), ["好的呀～"]);
  assert.deepEqual(splitReply("春禾在的，今天想聊什么？", { minChars: 20 }), ["春禾在的，今天想聊什么？"]);
});

test("多段：长回复在句子边界拆开，且不切断句子", () => {
  const text = "春禾先说结论：这个算法的时间复杂度是 O(n log n)。原因在于排序那一步占了主导。后面的遍历都是线性的，不会成为瓶颈。";
  const segs = splitReply(text, { maxSegments: 3, maxChars: 40, minChars: 20 });
  assert.ok(segs.length >= 2, `应拆成多段，实际 ${segs.length}`);
  assert.ok(segs.length <= 3, "不应超过上限");
  // 拼接后内容不丢
  assert.equal(segs.join("").replace(/\s/g, ""), text.replace(/\s/g, ""), "内容不能丢字");
  // 每段都应以句末标点或完整句子结尾（不被切断）
  for (const s of segs.slice(0, -1)) {
    assert.ok(/[。！？!?…]$/.test(s), `分段不应切断句子：${s}`);
  }
});

test("多段：按空行划分的段落优先保留（列表/代码不被拆坏）", () => {
  const text = "第一段：先说背景。\n\n第二段：再说结论。\n\n第三段：补充边界。";
  const segs = splitReply(text, { maxSegments: 5, maxChars: 100, minChars: 10 });
  assert.equal(segs.length, 3, "三个段落应拆成三条");
  assert.match(segs[0], /^第一段/);
  assert.match(segs[2], /^第三段/);
});

test("多段：超过上限时把尾部合并，保持顺序", () => {
  const text = "A段。\n\nB段。\n\nC段。\n\nD段。";
  const segs = splitReply(text, { maxSegments: 2, maxChars: 100, minChars: 1 });
  assert.equal(segs.length, 2);
  assert.match(segs[0], /A段/);
  assert.match(segs[1], /B段[\s\S]*D段/, "尾部应合并到第二段");
});

test("多段：关闭开关时原样返回单条", () => {
  const text = "很长的一段话。".repeat(20);
  assert.deepEqual(splitReply(text, { enabled: false }), [text]);
});

test("停顿：问号/省略号后停更久，逗号后更短", () => {
  assert.ok(gapAfter("你好吗？") > gapAfter("你好，"));
  assert.ok(gapAfter("让我想想…") > gapAfter("你好。"));
  const gaps = planGaps(["你好吗？", "春禾在的。", "说吧。"]);
  assert.equal(gaps.length, 2, "N 段应有 N-1 个停顿");
  assert.ok(gaps.every((g) => g >= 350 && g <= 1400), `停顿应在合理区间：${gaps}`);
});

// ---------------- 话题库 ----------------

test("话题清洗：去 @、压空白、限长", () => {
  assert.equal(normalizeTopic("<@!123> 我在学   线性代数"), "我在学 线性代数");
  assert.equal(normalizeTopic(""), "");
  const long = "字".repeat(200);
  assert.ok(normalizeTopic(long).length <= 121);
});

test("话题：相同话题不重复记，只累加命中", () => {
  const store = new TopicStore({});
  store.add({ text: "我在学线性代数", scope: "c2c", owner: "o1", shared: true });
  store.add({ text: "我在学线性代数", scope: "c2c", owner: "o1", shared: true });
  assert.equal(store.size, 1, "重复话题应合并");
});

test("话题隐私：他人的私聊话题绝不进入群场景", () => {
  const store = new TopicStore({});
  store.add({ text: "主人在做 QQ 机器人项目", scope: "c2c", owner: "c2c:owner-1", shared: true });
  store.add({ text: "别人的私事：我在追某个明星", scope: "c2c", owner: "c2c:other", shared: false });
  store.add({ text: "群里聊过要买键盘", scope: "group", owner: "group:g1", shared: false });

  const inGroup = store.relevant({ query: "最近忙什么", includeShared: true, owner: "group:g1" });
  assert.ok(
    !inGroup.some((t) => t.text.includes("明星")),
    "群里绝不能看到他人私聊话题（这是真实的人隐私）",
  );
  const picked = store.pick({ includeShared: true, owner: "group:g1" });
  assert.ok(!picked || !picked.text.includes("明星"), "随机的也不能抽到他人私事");
});

test("话题：能按关键词把相关话题排到前面（私聊的事群里能续上）", () => {
  const store = new TopicStore({});
  store.add({ text: "主人最近在学线性代数", scope: "c2c", owner: "o1", shared: true });
  store.add({ text: "主人周末去爬山了", scope: "c2c", owner: "o1", shared: true });

  const hit = store.relevant({ query: "线性代数学得怎么样了", includeShared: true, limit: 1 });
  assert.equal(hit.length, 1);
  assert.match(hit[0].text, /线性代数/, "相关话题应排第一——这就是'群里能续上'的机制");
});

test("话题：可持久化，重启后仍在", () => {
  const file = path.join(tmpDir(), "topics.json");
  const s1 = new TopicStore({ file });
  s1.add({ text: "主人喜欢数字 7", scope: "c2c", owner: "o1", shared: true });
  s1.flush(true);

  const s2 = new TopicStore({ file });
  const got = s2.relevant({ includeShared: true, limit: 5 });
  assert.ok(got.some((t) => t.text.includes("数字 7")), "重启后话题应还在");
});

test("话题：文件损坏时降级为空，不阻塞启动", () => {
  const file = path.join(tmpDir(), "broken.json");
  fs.writeFileSync(file, "{ 不是 JSON", "utf8");
  const store = new TopicStore({ file });
  assert.equal(store.size, 0);
  store.add({ text: "还能用吗", scope: "c2c", owner: "o1", shared: true });
  assert.equal(store.size, 1);
});

test("分词：中文双字 + 英文单词", () => {
  const t = tokenize("在学 linear algebra 线性代数");
  assert.ok(t.has("linear"));
  assert.ok(t.has("线性"));
});

// ---------------- 话题提取（写入策略） ----------------

test("话题提取：寒暄/附和/命令/短句不记，实质内容才记", () => {
  for (const s of ["你好", "好的", "嗯", "哈哈", "/help", "在吗？", ""]) {
    assert.equal(extractTopic(s), null, `不应记录：${s}`);
  }
  assert.match(extractTopic("我在学线性代数，特征值有点绕"), /线性代数/);
  assert.match(extractTopic("这个项目打算用 Node 写"), /Node/);
});

test("话题提取：只取第一句，避免把整段闲聊塞进去", () => {
  const t = extractTopic("我在学线性代数。另外今天天气不错，还去跑了步。");
  assert.ok(!t.includes("跑步"), `应只取第一句：${t}`);
});

// ---------------- 主动消息 ----------------

test("主动消息：默认关闭，不启用时不会发", async () => {
  let sent = 0;
  const s = new ProactiveScheduler({
    enabled: false,
    idleMinutes: 0,
    compose: async () => ({ text: "在吗" }),
    send: async () => {
      sent += 1;
    },
    logger,
  });
  s.touch("c2c:u1", { scope: "c2c", targetId: "u1" });
  const r = await s.tick();
  assert.equal(r.sent, false);
  assert.equal(r.reason, "disabled");
  assert.equal(sent, 0, "未启用时绝不能主动发消息");
});

test("主动消息：达到每日上限后停止（平台有硬配额，必须自设上限留余量）", async () => {
  const s = new ProactiveScheduler({
    enabled: true,
    idleMinutes: 0,
    dailyLimit: 2,
    quietHours: "0-0", // 关闭静默时段
    compose: async () => ({ text: "在忙吗～" }),
    send: async () => ({}),
    logger,
  });
  s.touch("c2c:u1", { scope: "c2c", targetId: "u1" });
  assert.equal((await s.tick()).sent, true);
  assert.equal((await s.tick()).sent, true);
  const third = await s.tick();
  assert.equal(third.sent, false);
  assert.equal(third.reason, "daily_limit");
  assert.equal(s.remaining(), 0);
});

test("主动消息：静默时段内不发（半夜不吵人）", async () => {
  const night = new Date("2026-10-11T02:00:00").getTime();
  const s = new ProactiveScheduler({
    enabled: true,
    idleMinutes: 0,
    dailyLimit: 5,
    quietHours: "23-8",
    compose: async () => ({ text: "睡了吗" }),
    send: async () => {
      throw new Error("不该发");
    },
    now: () => night,
    logger,
  });
  s.touch("c2c:u1", { scope: "c2c", targetId: "u1" });
  const r = await s.tick();
  assert.equal(r.sent, false);
  assert.equal(r.reason, "quiet_hours");
});

test("主动消息：用户关闭推送后永久不再打扰", async () => {
  let sent = 0;
  const s = new ProactiveScheduler({
    enabled: true,
    idleMinutes: 0,
    dailyLimit: 5,
    quietHours: "0-0",
    compose: async () => ({ text: "在吗" }),
    send: async () => {
      sent += 1;
    },
    logger,
  });
  s.touch("c2c:u1", { scope: "c2c", targetId: "u1" });
  s.mute("c2c:u1");
  const r = await s.tick();
  assert.equal(r.sent, false);
  assert.equal(sent, 0, "被关闭后必须彻底停手");
});

test("主动消息：配额跨重启保留（不能靠重启绕过上限）", async () => {
  const file = path.join(tmpDir(), "proactive.json");
  const s1 = new ProactiveScheduler({
    enabled: true,
    idleMinutes: 0,
    dailyLimit: 1,
    quietHours: "0-0",
    stateFile: file,
    compose: async () => ({ text: "在吗" }),
    send: async () => ({}),
    logger,
  });
  s1.touch("c2c:u1", { scope: "c2c", targetId: "u1" });
  await s1.tick();
  assert.equal(s1.remaining(), 0);

  const s2 = new ProactiveScheduler({
    enabled: true,
    idleMinutes: 0,
    dailyLimit: 1,
    quietHours: "0-0",
    stateFile: file,
    compose: async () => ({ text: "又来" }),
    send: async () => ({}),
    logger,
  });
  assert.equal(s2.remaining(), 0, "重启后当日配额应保持已用状态");
});

test("主动消息：不活跃的会话不会被搭话", async () => {
  const s = new ProactiveScheduler({
    enabled: true,
    idleMinutes: 60,
    dailyLimit: 5,
    quietHours: "0-0",
    compose: async () => ({ text: "在吗" }),
    send: async () => ({}),
    now: () => Date.now(),
    logger,
  });
  s.touch("c2c:u1", { scope: "c2c", targetId: "u1" }); // 刚刚活跃
  const r = await s.tick();
  assert.equal(r.sent, false);
  assert.equal(r.reason, "no_idle_session");
});

test("主动消息生成器：没有模型时用话题拼一句，没话题就不说", async () => {
  const compose = createProactiveComposer({ logger, getTopics: () => [] });
  assert.equal(await compose({ sessionKey: "c2c:u1" }), null, "没话题就不硬找话说");

  const withTopic = createProactiveComposer({
    logger,
    getTopics: () => [{ text: "主人在学线性代数" }],
  });
  const out = await withTopic({ sessionKey: "c2c:u1" });
  // 契约：必须返回 { text } 对象。曾经这里断言的是裸字符串，
  // 正好把"返回字符串导致调度器发不出去"的 bug 固化成了"正确行为"。
  assert.ok(out && typeof out === "object", "必须返回 {text} 对象");
  assert.match(out.text, /线性代数/);
});

test("主动消息生成器：有模型时走主动提示词", async () => {
  let captured = null;
  const compose = createProactiveComposer({
    logger,
    getTopics: () => [{ text: "主人在做机器人" }],
    generate: async (ctx) => {
      captured = ctx;
      return "在忙什么呢～";
    },
  });
  const out = await compose({ sessionKey: "c2c:u1" });
  assert.ok(out && typeof out === "object", "必须返回 {text} 对象，不能是裸字符串");
  assert.equal(out.text, "在忙什么呢～");
  assert.equal(captured.systemOverride, PROACTIVE_PROMPT, "应使用主动搭话的提示词");
  assert.match(captured.text, /机器人/, "应把话题交给模型");
});

test("静默时段解析：非法输入回退默认值", () => {
  assert.deepEqual(parseQuietHours("23-8"), { start: 23, end: 8 });
  assert.deepEqual(parseQuietHours("0-7"), { start: 0, end: 7 });
  assert.deepEqual(parseQuietHours("垃圾输入"), { start: 23, end: 8 });
  assert.equal(todayKey(new Date("2026-10-11T15:00:00").getTime()), "2026-10-11");
});
