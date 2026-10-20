/**
 * 骚扰追踪 + 告状（2026-10-19 主人要求：「被群里其他人骚扰太多次就找我告状」）。
 *
 * 这些测试锁住三件事：
 *   1. 检测**宁漏勿错** —— 明确的性/身体词汇算，日常句不算。
 *   2. 按人累积到阈值才告状；同一个人有冷却；全天有上限。
 *   3. 报告文本说清事实（谁、几次、最后一句原话），不撒娇。
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  detectHarassment,
  HarassmentTracker,
  DEFAULT_HARASS_POLICY,
  composeHarassReport,
} from "../src/core/harassment.js";

test("检测：明确的性/身体词汇命中", () => {
  const hits = [
    "真没有和群主的床照吗",
    "发张你的自拍看看",
    "能不能看看你的",
    "喜欢吃群主的O鲸鲸吗", // 真机原话：用昵称代替下流词
    "来点涩涩的",
  ];
  for (const s of hits) {
    assert.equal(detectHarassment(s).hit, true, `应命中：${s}`);
  }
});

test("检测：日常句子不误报（宁漏勿错）", () => {
  const clean = [
    "今天吃什么",
    "哈哈哈哈",
    "吃你做的饭真好吃",
    "这个人真变态", // 可能在骂别人，不该算成对她的骚扰
    "这道题怎么算",
    "",
    "   ",
  ];
  for (const s of clean) {
    assert.equal(detectHarassment(s).hit, false, `不该命中：${s}`);
  }
});

test("检测：区分 explicit 与 request 两级", () => {
  assert.equal(detectHarassment("发张你的床照").level, "explicit");
  assert.equal(detectHarassment("能不能看看你的").level, "request");
});

test("追踪：explicit 记 2 分，达到阈值才告状", () => {
  const t = new HarassmentTracker({ threshold: 4 });
  const t0 = 1_000_000_000_000;
  const r1 = t.record({ senderId: "u1", text: "床照", level: "explicit", now: t0 });
  assert.equal(r1.score, 2);
  assert.equal(r1.shouldAlert, false);
  assert.equal(r1.reason, "below_threshold");

  const r2 = t.record({ senderId: "u1", text: "床照", level: "explicit", now: t0 + 1000 });
  assert.equal(r2.score, 4);
  assert.equal(r2.shouldAlert, true);
});

test("追踪：不同人各问一句不合并", () => {
  const t = new HarassmentTracker({ threshold: 4 });
  const t0 = 1_000_000_000_000;
  const a = t.record({ senderId: "u1", text: "床照", level: "explicit", now: t0 });
  const b = t.record({ senderId: "u2", text: "床照", level: "explicit", now: t0 + 1000 });
  assert.equal(a.shouldAlert, false);
  assert.equal(b.shouldAlert, false, "换个人应独立计数");
  assert.equal(b.score, 2);
});

test("追踪：告状后有冷却，不连番打扰主人", () => {
  const t = new HarassmentTracker({ threshold: 4, cooldownMs: 60_000 });
  const t0 = 1_000_000_000_000;
  t.record({ senderId: "u1", text: "x", level: "explicit", now: t0 });
  const alert = t.record({ senderId: "u1", text: "x", level: "explicit", now: t0 + 1000 });
  assert.equal(alert.shouldAlert, true);

  const next = t.record({ senderId: "u1", text: "x", level: "explicit", now: t0 + 2000 });
  assert.equal(next.shouldAlert, false);
  assert.equal(next.reason, "cooldown");
});

test("追踪：统计窗口过期后重新计数", () => {
  const t = new HarassmentTracker({ threshold: 4, windowMs: 1000 });
  const t0 = 1_000_000_000_000;
  t.record({ senderId: "u1", text: "x", level: "explicit", now: t0 });
  const later = t.record({ senderId: "u1", text: "x", level: "explicit", now: t0 + 5000 });
  assert.equal(later.score, 2, "超出窗口应重新起算，而不是累加到 4");
  assert.equal(later.shouldAlert, false);
});

test("追踪：全天有上限", () => {
  const t = new HarassmentTracker({ threshold: 2, cooldownMs: 0, dailyLimit: 2 });
  const t0 = 1_000_000_000_000;
  const senders = ["a", "b", "c"];
  const results = senders.map((s, i) =>
    t.record({ senderId: s, text: "x", level: "explicit", now: t0 + i * 1000 }),
  );
  assert.equal(results.filter((r) => r.shouldAlert).length, 2);
  assert.equal(results[2].reason, "daily_limit");
});

test("报告文本：说清谁、几次、最后原话，不撒娇", () => {
  const s = composeHarassReport({
    senderLabel: "丙某（尾号 817A）",
    groupLabel: "9F425E…",
    count: 3,
    snippets: ["真没有和群主的床照吗", "喜欢吃群主的O鲸鲸吗"],
  });
  assert.match(s, /9F425E…/);
  assert.match(s, /丙某（尾号 817A）/);
  assert.match(s, /3 次/);
  assert.match(s, /喜欢吃群主的O鲸鲸吗/, "应带最后一句原话");
  assert.match(s, /管管他|烦死|要不要处理/, "报告应给出处理请求");
  assert.doesNotMatch(s, /呜呜|嘤嘤|求求你/, "报告不该撒娇");
});

test("默认策略：阈值/冷却/上限都有合理默认值", () => {
  assert.equal(typeof DEFAULT_HARASS_POLICY.threshold, "number");
  assert.ok(DEFAULT_HARASS_POLICY.threshold >= 2);
  assert.ok(DEFAULT_HARASS_POLICY.cooldownMs >= 60_000, "冷却不能太短，否则会刷屏");
  assert.ok(DEFAULT_HARASS_POLICY.dailyLimit >= 1);
});

test("区分：骂主人 vs 骚扰她（2026-10-19 主人要求）", () => {
  // 骂/威胁主人 → target=owner，且是 owner 级
  for (const s of ["cnm你主人", "主人我cnm", "我要打你的主人", "打你的主人"]) {
    const r = detectHarassment(s);
    assert.equal(r.hit, true, `应命中：${s}`);
    assert.equal(r.target, "owner", `应判为骂主人：${s}`);
  }
  // 单纯骚扰她 → target=self
  for (const s of ["我想c", "有和群主的床照吗"]) {
    const r = detectHarassment(s);
    assert.equal(r.hit, true);
    assert.equal(r.target, "self", `应判为针对她：${s}`);
  }
  // 夸主人不算
  assert.equal(detectHarassment("主人真好看").hit, false);
});

test("骂主人：一次就告状，不用等累积", () => {
  const t = new HarassmentTracker({ threshold: 4 });
  const r = t.record({
    senderId: "u1",
    text: "cnm你主人",
    snippet: "cnm你主人",
    level: "owner",
    target: "owner",
    now: 1_000_000_000_000,
  });
  assert.equal(r.shouldAlert, true, "骂主人应该立刻告状");
});

test("报告样式：骂主人和骚扰她的措辞不同", () => {
  const owner = composeHarassReport({
    senderLabel: "丙某（尾号 817A）",
    groupLabel: "大群",
    count: 1,
    snippets: ["cnm你主人"],
    target: "owner",
  });
  assert.match(owner, /有人骂主人/);
  assert.match(owner, /在骂你\/威胁你/);
  assert.doesNotMatch(owner, /连着 1 次/);

  const self = composeHarassReport({
    senderLabel: "丙某（尾号 817A）",
    groupLabel: "大群",
    count: 4,
    snippets: ["有和群主的床照吗"],
    target: "self",
  });
  // 2026-10-19 主人要求：骚扰她的报告改成**委屈求安慰**的语气
  assert.match(self, /主人……/);
  assert.match(self, /连着 4 次/);
  assert.match(self, /管管他|烦死/, "骚扰报告应带委屈/求安慰");
});