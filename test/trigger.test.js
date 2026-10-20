/**
 * 群聊触发测试：喊名字就应答、闲聊不打扰、上下文缓冲。
 *
 * 这个功能的边界很敏感：判错了要么"喊了不理人"，要么"别人闲聊它突然插话"，
 * 两种都很难在真机上复现，所以必须在这里守住。
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { matchWakeName } from "../src/core/chat-split.js";
import { MessageEngine, stripWakeNames } from "../src/core/engine.js";
import { loadConfig } from "../src/config.js";
import { createLogger } from "../src/util/log.js";

const logger = createLogger("silent");

/**
 * 每个引擎一份临时记忆文件。
 * 群注册表与主动消息配额会跟着记忆文件落到同目录——否则跑一次测试
 * 就会在线上 data/ 里留下假的 groups.json（真实踩过）。
 */
function tempMemoryFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qqbot-trigger-"));
  return path.join(dir, "memory.json");
}

// ---------------- 唤名匹配 ----------------

test("唤名：常见叫法都应命中", () => {
  const names = ["春禾"];
  for (const t of [
    "春禾",
    "春禾？",
    "春禾在吗",
    "春禾 帮我算个题",
    "喂春禾，在不在",
    "春禾~",
    "那个春禾呀",
  ]) {
    assert.equal(matchWakeName(t, names), true, `应命中：${t}`);
  }
});

test("唤名：不相干的闲聊不应命中（避免突然插话）", () => {
  const names = ["春禾"];
  for (const t of [
    "今天天气不错",
    "你们谁去吃饭",
    "这个 bug 怎么修",
    "禾春是不是写反了",
    "春天来了",
    "",
  ]) {
    assert.equal(matchWakeName(t, names), false, `不应命中：${t}`);
  }
});

test("唤名：支持多个小名", () => {
  const names = ["春禾", "小禾", "禾禾"];
  assert.equal(matchWakeName("小禾在吗", names), true);
  assert.equal(matchWakeName("禾禾帮我看下", names), true);
  assert.equal(matchWakeName("在吗", names), false);
});

test("唤名：空名字列表不应把所有消息都当命中", () => {
  assert.equal(matchWakeName("随便说点什么", []), false);
  assert.equal(matchWakeName("随便说点什么", [""]), false);
});

test("去掉唤名：只剥唤名，不动其他内容", () => {
  assert.equal(stripWakeNames("春禾帮我算个题", ["春禾"]), "帮我算个题");
  assert.equal(stripWakeNames("春禾，在吗", ["春禾"]), "在吗");
  assert.equal(stripWakeNames("喂春禾 1+1 等于几", ["春禾"]), "喂 1+1 等于几");
  assert.equal(stripWakeNames("今天天气不错", ["春禾"]), "今天天气不错");
});

// ---------------- 触发闸门 ----------------

function makeEngine(env = {}) {
  const config = loadConfig({
    QQ_APP_ID: "1",
    QQ_APP_SECRET: "s",
    QQ_MEMORY_FILE: tempMemoryFile(),
    ...env,
  });
  // 不要把这个数组赋给 engine.sent！
  // engine 内部已有一个 sent 数组，赋同一个引用会导致每条消息被记两遍
  // （spy 推一次 + #sendOne 推一次），造成"发了 2 条"的假失败。
  const apiCalls = [];
  const api = {
    sendMessage: async (scope, targetId, text) => {
      apiCalls.push({ scope, targetId, text });
      return { id: `m${apiCalls.length}` };
    },
  };
  const engine = new MessageEngine({
    config,
    api,
    // 让回复可预测，不依赖模型
    generate: async (ctx) => `回应:${ctx.text || "(空)"}`,
    logger,
  });
  engine.apiCalls = apiCalls;
  /** 实际发出的文本列表（以调用方视角为准） */
  engine.sentTexts = () => apiCalls.map((c) => c.text);
  return engine;
}

// 注意：messageId 必须由调用方显式给出且稳定。
// 早期这里用随机 id，结果 atMsg() 内部调 groupMsg() 会生成两次不同的 id，
// 同一个逻辑消息被当成两条不同消息，去重拦不住，导致"发了 2 条"的假失败。
let msgSeq = 0;
const groupMsg = (over = {}) => ({
  kind: "group",
  scope: "group",
  rawEventType: "GROUP_MESSAGE_CREATE",
  senderId: "u1",
  senderName: "群友甲",
  content: "今天天气不错",
  messageId: `g-${++msgSeq}`,
  groupOpenid: "g1",
  targetId: "g1",
  attachments: [],
  ...over,
});

const atMsg = (over = {}) => groupMsg({ rawEventType: "GROUP_AT_MESSAGE_CREATE", ...over });

test("默认 mention 模式：@ 回应，普通发言不回应", async () => {
  const e = makeEngine();

  const r1 = await e.handle(atMsg({ content: "<@!1> 1+1" }));
  assert.equal(r1.action, "replied", "@ 必须回应");

  const r2 = await e.handle(groupMsg({ content: "你们吃饭了吗" }));
  assert.equal(r2.action, "skipped", "普通发言不该回应（否则很扰民）");
  assert.equal(r2.reason, "group_not_mentioned");
  assert.equal(
    e.sentTexts().length,
    1,
    `只该发出 @ 那一条的回应，实际发出：${JSON.stringify(e.sentTexts())}`,
  );
});

test("wake 模式：喊名字就应答，不喊就不理", async () => {
  const e = makeEngine({ QQ_GROUP_TRIGGER: "wake" });

  const hit = await e.handle(groupMsg({ content: "春禾在吗" }));
  assert.equal(hit.action, "replied", "喊唤名必须应答");
  // 这里只关心"唤名被剥掉"，不假设 AI 标识的存在（由 AI_LABEL_STYLE 决定，默认 none）
  assert.equal(
    e.sentTexts().at(-1).replace(/^【AI】/, ""),
    "回应:在吗",
    "唤名本身应被剥掉，不送给模型",
  );

  const hit2 = await e.handle(groupMsg({ content: "春禾帮我算 (1+2)*3" }));
  assert.equal(hit2.action, "replied");
  assert.match(e.sentTexts().at(-1), /\(1\+2\)\*3/, "唤名后的内容要完整保留");

  // ⚠️ 2026-10-19 行为变更：wake 模式新增 follow-up ——
  //    她**刚在这个群说过话**（2 分钟内）时，紧接着的发言会被当成"接着她说的"而回应。
  //    真机反馈（丙某）：「必须塞句『春禾』才会回应，接不上话。」
  //    所以这里的"不喊就不理"要用一个**她没说过话**的新群实例来验证。
  const e2 = makeEngine({ QQ_GROUP_TRIGGER: "wake" });
  const miss = await e2.handle(groupMsg({ content: "今天有啥好吃的" }));
  assert.equal(miss.action, "skipped");
  assert.equal(miss.reason, "group_no_wake");
});

test("wake 模式：她刚说过话时，别人接着说话算 follow-up（不用喊名字）", async () => {
  const e = makeEngine({ QQ_GROUP_TRIGGER: "wake" });
  // 先被她叫到，产生一次回复 → 记录「她刚在这个群说过话」
  const first = await e.handle(groupMsg({ content: "春禾在吗" }));
  assert.equal(first.action, "replied");
  // 紧接着一句没喊名字的话：应判为 follow-up 并回应
  const next = await e.handle(groupMsg({ content: "那你说说今天吃啥" }));
  assert.equal(next.action, "replied", "她刚说过话，紧接着的发言应视为在对她说");
});

test("wake 模式：follow-up 时间窗过期后，没喊名字就不理", async () => {
  const e = makeEngine({ QQ_GROUP_TRIGGER: "wake" });
  await e.handle(groupMsg({ content: "春禾在吗" }));
  // 把"她上次说话"推到 3 分钟前（窗口默认 120s）
  for (const k of e.lastHerReplyAt.keys()) e.lastHerReplyAt.set(k, Date.now() - 3 * 60_000);
  const stale = await e.handle(groupMsg({ content: "今天有啥好吃的" }));
  assert.equal(stale.action, "skipped");
  assert.equal(stale.reason, "group_no_wake");
});

test("wake 模式：@ 依然有效（喊名字只是额外放宽）", async () => {
  const e = makeEngine({ QQ_GROUP_TRIGGER: "wake" });
  const r = await e.handle(atMsg({ content: "<@!1> 你好" }));
  assert.equal(r.action, "replied");
  assert.equal(r.reason ?? e.stats.replied >= 1, true);
});

test("all 模式：群里任何消息都回应（可选，但会扰民）", async () => {
  const e = makeEngine({ QQ_GROUP_TRIGGER: "all" });
  const r = await e.handle(groupMsg({ content: "随便聊聊" }));
  assert.equal(r.action, "replied");
});

test("单聊不受群触发模式影响：始终有话必应", async () => {
  const e = makeEngine({ QQ_GROUP_TRIGGER: "mention" });
  const r = await e.handle({
    kind: "c2c",
    scope: "c2c",
    rawEventType: "C2C_MESSAGE_CREATE",
    senderId: "u1",
    content: "在吗",
    messageId: "c-1",
    targetId: "u1",
    attachments: [],
  });
  assert.equal(r.action, "replied", "单聊不该被群聊规则挡住");
});

// ---------------- 上下文缓冲 ----------------

test("未触发的群消息会记入上下文缓冲（不花钱但记得住）", async () => {
  const e = makeEngine({ QQ_GROUP_TRIGGER: "wake", QQ_GROUP_WATCH: "true" });

  await e.handle(groupMsg({ content: "我们下周要交线性代数作业", senderName: "小明" }));
  await e.handle(groupMsg({ content: "我还没开始写", senderName: "小红" }));

  const watched = e.getGroupWatch("g1");
  assert.equal(watched.length, 2, "两条闲聊都该被记下");
  assert.match(watched[0], /小明: 我们下周要交线性代数作业/);
  assert.match(watched[1], /小红: 我还没开始写/);

  // 此时被叫到，应能取到上下文
  const r = await e.handle(groupMsg({ content: "春禾你觉得呢" }));
  assert.equal(r.action, "replied");
  assert.equal(e.stats.skipped, 2, "两条闲聊都算跳过");
});

test("上下文缓冲有长度上限，不会无限增长", async () => {
  const e = makeEngine({ QQ_GROUP_TRIGGER: "wake", QQ_GROUP_WATCH_LIMIT: "3" });
  for (let i = 1; i <= 6; i += 1) {
    await e.handle(groupMsg({ content: `第 ${i} 条闲聊`, messageId: `w-${i}` }));
  }
  const watched = e.getGroupWatch("g1");
  assert.equal(watched.length, 3, "应只保留最近 3 条");
  assert.match(watched.at(-1), /第 6 条/);
});

test("可以关闭上下文缓冲", async () => {
  const e = makeEngine({ QQ_GROUP_TRIGGER: "wake", QQ_GROUP_WATCH: "false" });
  await e.handle(groupMsg({ content: "不该被记住的闲聊" }));
  assert.equal(e.getGroupWatch("g1").length, 0);
});

test("上下文缓冲不会因为频繁闲聊而触发模型调用", async () => {
  let called = 0;
  const config = loadConfig({ QQ_APP_ID: "1", QQ_APP_SECRET: "s", QQ_GROUP_TRIGGER: "wake", QQ_MEMORY_FILE: tempMemoryFile() });
  const e = new MessageEngine({
    config,
    api: { sendMessage: async () => ({ id: "x" }) },
    generate: async () => {
      called += 1;
      return "ok";
    },
    logger,
  });

  for (let i = 0; i < 10; i += 1) {
    await e.handle(groupMsg({ content: `闲聊第 ${i} 句`, messageId: `n-${i}` }));
  }
  assert.equal(called, 0, "闲聊绝不能触发模型调用（费钱）");
  assert.equal(e.stats.skipped, 10);

  await e.handle(groupMsg({ content: "春禾在吗", messageId: "wake-1" }));
  assert.equal(called, 1, "被叫到时才调用一次");
});

test("唤名出现在群里也支持带 @ 的组合", async () => {
  const e = makeEngine({ QQ_GROUP_TRIGGER: "wake" });
  const r = await e.handle(atMsg({ content: "<@!1> 春禾帮我看看这段代码" }));
  assert.equal(r.action, "replied");
  assert.match(e.sentTexts().at(-1), /帮我看看这段代码/);
  assert.ok(!e.sentTexts().at(-1).includes("春禾"), "唤名不应残留在送给模型的内容里");
});
