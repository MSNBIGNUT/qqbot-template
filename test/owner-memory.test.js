/**
 * 跨场景记忆（主人私聊 ↔ 群聊）与隔离测试。
 *
 * 修的问题（用户原话）：「春禾私聊和群聊的记忆不相通，且在私聊里下的指令无法在群聊里实现」。
 *
 * 硬约束：群里还有别人。**绝不允许**把主人的私聊内容泄漏给群成员，
 * 也不允许群成员之间通过她互相串话。所以这些用例既测"通"，也测"不通"。
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { MessageEngine, sessionKeyOf, groupSessionKey } from "../src/core/engine.js";
import { MemoryStore } from "../src/core/memory.js";
import { OwnerMemoryStore, extractOwnerMemory } from "../src/core/owner-memory.js";
import { TopicStore } from "../src/core/topics.js";
import { loadConfig } from "../src/config.js";
import { createLogger } from "../src/util/log.js";

const logger = createLogger("silent");

const OWNER = "OWNER_OPENID_0001";
const MEMBER_A = "MEMBER_OPENID_AAAA";
const MEMBER_B = "MEMBER_OPENID_BBBB";
const GROUP_1 = "GROUP_OPENID_1111";
const GROUP_2 = "GROUP_OPENID_2222";

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "qqbot-owner-"));
}

function makeFakeApi() {
  const sent = [];
  return {
    sent,
    async sendMessage(scope, targetId, content, opts = {}) {
      sent.push({ scope, targetId, content, msgId: opts.msgId });
      return { id: `fake-${sent.length}`, content };
    },
    async sendProactiveMessage(scope, targetId, content) {
      sent.push({ scope, targetId, content, proactive: true });
      return { id: `fake-p-${sent.length}` };
    },
  };
}

/** 起一个真实引擎：真实记忆/话题/长期记忆存储 + 假 api + 记录 ctx 的假人格层 */
function makeEngine(env = {}) {
  const dir = tmpDir();
  const config = loadConfig({
    QQ_APP_ID: "test-app-id",
    QQ_APP_SECRET: "test-app-secret",
    QQ_GROUP_TRIGGER: "all",
    QQ_ADMIN_USERS: OWNER,
    QQ_MEMORY_FILE: path.join(dir, "memory.json"),
    QQ_TOPIC_FILE: path.join(dir, "topics.json"),
    QQ_OWNER_MEMORY_FILE: path.join(dir, "owner-memory.json"),
    QQ_REMINDERS: "false",
    QQ_MULTI_MESSAGE: "false",
    QQ_VOICE_REPLY: "off",
    QQ_SING_ENABLED: "false",
    QQ_PROACTIVE: "false",
    ...env,
  });
  const api = makeFakeApi();
  const seen = [];
  const engine = new MessageEngine({
    config,
    api,
    logger,
    generate: async (ctx) => {
      seen.push(ctx);
      return "嗯，春禾记住啦";
    },
  });
  return { engine, api, seen, dir, config };
}

let seq = 0;

function c2cMsg(text, openid = OWNER) {
  seq += 1;
  return {
    scope: "c2c",
    targetId: openid,
    senderId: openid,
    senderName: openid === OWNER ? "主人" : "路人",
    messageId: `c2c-${seq}`,
    content: text,
    kind: "text",
    attachments: [],
  };
}

function groupMsg(text, { openid = OWNER, groupOpenid = GROUP_1, role = "member" } = {}) {
  seq += 1;
  return {
    scope: "group",
    targetId: groupOpenid,
    groupOpenid,
    senderId: openid,
    senderName: openid === OWNER ? "群主" : "群友",
    memberRole: role,
    rawEventType: "GROUP_AT_MESSAGE_CREATE",
    messageId: `g-${seq}`,
    content: `<@!123> ${text}`,
    kind: "text",
    attachments: [],
  };
}

const flat = (history) => (history ?? []).map((m) => m.content).join("\n");

// ---------------------------------------------------------------------------
// 1) 会话键：主人跨场景合并，其他人保持隔离
// ---------------------------------------------------------------------------

test("会话键：主人私聊与群聊使用同一个 owner 键（核心需求）", () => {
  assert.equal(sessionKeyOf(c2cMsg("你好"), [OWNER]), `owner:${OWNER}`);
  assert.equal(sessionKeyOf(groupMsg("你好", { groupOpenid: GROUP_1 }), new Set([OWNER])), `owner:${OWNER}`);
  assert.equal(sessionKeyOf(groupMsg("你好", { groupOpenid: GROUP_2 }), [OWNER]), `owner:${OWNER}`);
});

test("会话键：非主人仍然按「群+人」/「私聊人」严格隔离", () => {
  assert.equal(sessionKeyOf(groupMsg("你好", { openid: MEMBER_A, groupOpenid: GROUP_1 }), [OWNER]), `group:${GROUP_1}:${MEMBER_A}`);
  assert.equal(sessionKeyOf(groupMsg("你好", { openid: MEMBER_A, groupOpenid: GROUP_2 }), [OWNER]), `group:${GROUP_2}:${MEMBER_A}`);
  assert.equal(sessionKeyOf(c2cMsg("你好", MEMBER_A), [OWNER]), `c2c:${MEMBER_A}`);
});

test("会话键：没有配置主人时保持旧行为（向后兼容）", () => {
  assert.equal(sessionKeyOf(c2cMsg("你好")), `c2c:${OWNER}`);
  assert.equal(sessionKeyOf(groupMsg("你好")), `group:${GROUP_1}:${OWNER}`);
  assert.equal(sessionKeyOf(c2cMsg("你好"), []), `c2c:${OWNER}`);
  assert.equal(sessionKeyOf(groupMsg("你好"), null), `group:${GROUP_1}:${OWNER}`);
  // 群级键不受影响
  assert.equal(groupSessionKey(groupMsg("你好")), `group:${GROUP_1}`);
});

// ---------------------------------------------------------------------------
// 2) 核心：主人私聊说的话，群里能看到
// ---------------------------------------------------------------------------

test("跨场景：主人私聊说的话，群里能接上（带来源标注）", async () => {
  const { engine, seen } = makeEngine();

  await engine.handle(c2cMsg("我最喜欢的数字是 20261017，记住别忘"));
  await engine.handle(groupMsg("我最喜欢的数字是多少"));

  const groupCtx = seen.at(-1);
  assert.equal(groupCtx.scope, "group");
  assert.equal(groupCtx.isOwnerUser, true);
  assert.equal(groupCtx.crossScene, true, "群里应知道有来自私聊的记忆");
  assert.match(flat(groupCtx.history), /20261017/, "群里的上下文必须包含私聊说过的话");
  assert.match(flat(groupCtx.history), /〔私聊〕/, "私聊来源必须标注，供提示词加安全阀");
});

test("跨场景：私聊里下的指令（长期记忆），群里也生效", async () => {
  const { engine, seen } = makeEngine();

  await engine.handle(c2cMsg("以后叫我老大，别叫主人了"));
  await engine.handle(groupMsg("我是谁来着"));

  const groupCtx = seen.at(-1);
  assert.ok(
    groupCtx.ownerMemory.some((f) => /叫我老大/.test(f.text)),
    `群里应拿到主人长期记忆，实际：${JSON.stringify(groupCtx.ownerMemory)}`,
  );
  // 合并后的历史里的称呼也一并可回溯
  assert.match(flat(groupCtx.history), /老大/);
});

test("跨场景：群聊说的事，主人私聊里也能回忆", async () => {
  const { engine, seen } = makeEngine();

  await engine.handle(groupMsg("我们群里下周要办数学竞赛", { role: "owner" }));
  await engine.handle(c2cMsg("我们下周要干嘛"));

  const c2cCtx = seen.at(-1);
  assert.equal(c2cCtx.scope, "c2c");
  assert.match(flat(c2cCtx.history), /数学竞赛/);
  assert.match(flat(c2cCtx.history), /〔群聊〕/);
});

test("跨场景：主人切换群聊时，另一群的上下文也在（同一份记忆）", async () => {
  const { engine, seen } = makeEngine();

  await engine.handle(groupMsg("这个群在聊线性代数", { groupOpenid: GROUP_1 }));
  await engine.handle(groupMsg("我们刚才聊了什么", { groupOpenid: GROUP_2 }));

  assert.match(flat(seen.at(-1).history), /线性代数/);
});

// ---------------------------------------------------------------------------
// 3) 隔离：非主人 / 其他群成员的内容绝不串场
// ---------------------------------------------------------------------------

test("隔离：非主人在群里的内容，主人私聊看不到", async () => {
  const { engine, seen } = makeEngine();

  await engine.handle(groupMsg("我女朋友叫小美，千万别告诉别人", { openid: MEMBER_A }));
  await engine.handle(c2cMsg("刚才群里聊了什么"));

  const c2cCtx = seen.at(-1);
  const visible = JSON.stringify({
    history: c2cCtx.history,
    topics: c2cCtx.topics,
    ownerMemory: c2cCtx.ownerMemory,
  });
  assert.ok(!visible.includes("小美"), `主人的私聊上下文绝不能出现群成员的私事：${visible}`);
  assert.deepEqual(c2cCtx.ownerMemory, [], "群成员的话不能写进主人的长期记忆");
});

test("隔离：群里 A 的会话内容不会进入 B 的上下文", async () => {
  const { engine, seen } = makeEngine();

  await engine.handle(groupMsg("我喜欢吃螺蛳粉", { openid: MEMBER_A }));
  await engine.handle(groupMsg("刚才有人说了什么", { openid: MEMBER_B }));

  const bCtx = seen.at(-1);
  assert.equal(bCtx.sessionKey, `group:${GROUP_1}:${MEMBER_B}`);
  assert.ok(!flat(bCtx.history).includes("螺蛳粉"), "B 的历史里不能出现 A 的对话");
  assert.deepEqual(bCtx.ownerMemory, [], "非主人拿不到主人的长期记忆");
});

test("隔离：群成员同名消息不会写进主人的长期记忆", async () => {
  const { engine } = makeEngine();

  await engine.handle(groupMsg("以后叫我老大", { openid: MEMBER_A }));
  assert.equal(engine.ownerMemory.size, 0, "只有主人的话才会被记成长期记忆");
});

test("隔离：非主人的私聊仍是自己的独立会话", async () => {
  const { engine, seen } = makeEngine();

  await engine.handle(c2cMsg("我是甲的私事", MEMBER_A));
  await engine.handle(c2cMsg("我是乙的私事", MEMBER_B));
  await engine.handle(c2cMsg("我是主人的事", OWNER));

  assert.ok(!flat(seen.at(-1).history).includes("甲的私事"));
  assert.equal(seen.find((c) => c.senderId === MEMBER_B)?.sessionKey, `c2c:${MEMBER_B}`);
});

test("话题库：群成员的话题不会出现在主人的私聊里", () => {
  const store = new TopicStore({});
  store.add({ text: "我女朋友叫小美，千万别告诉别人", scope: "group", owner: `group:${GROUP_1}:${MEMBER_A}`, shared: true });
  store.add({ text: "主人在研究钢筋截面配筋", scope: "c2c", owner: `c2c:${OWNER}`, shared: true });

  const inOwnerC2C = store.relevant({
    query: "刚才聊了什么",
    includeShared: true,
    owner: `owner:${OWNER}`,
    scene: `owner:${OWNER}`,
    ownerIds: [OWNER],
  });
  assert.ok(!inOwnerC2C.some((t) => t.text.includes("小美")), "主人私聊不能看到群成员的私事");
  assert.ok(inOwnerC2C.some((t) => t.text.includes("钢筋")), "主人自己的话题应该能看到");
});

// ---------------------------------------------------------------------------
// 4) 长期记忆：读写、持久化、容量、边界
// ---------------------------------------------------------------------------

test("长期记忆：识别主人的偏好/指令，忽略寒暄与提问", () => {
  const cases = [
    ["以后叫我老大", /老大/],
    ["我喜欢蓝色，讨厌香菜", /蓝色/],
    ["记住：周六要考试", /周六/],
    ["别忘了我的生日是 3 月 7 日", /生日/],
  ];
  for (const [text, re] of cases) {
    const got = extractOwnerMemory(text);
    assert.ok(got, `应能识别：${text}`);
    assert.match(got.text, re);
  }
  for (const text of ["你好呀", "在吗", "今天天气怎么样", "1+1 等于几", "唱首歌"]) {
    assert.equal(extractOwnerMemory(text), null, `不该记：${text}`);
  }
});

test("长期记忆：去重、容量上限、可持久化", () => {
  const dir = tmpDir();
  const file = path.join(dir, "owner-memory.json");
  const s1 = new OwnerMemoryStore({ file, maxFacts: 5, logger });
  s1.learn("以后叫我老大");
  s1.learn("以后叫我老大"); // 重复的不新加
  assert.equal(s1.size, 1, "重复内容应合并");
  for (let i = 1; i <= 8; i += 1) s1.learn(`记住第${i}件事`);
  assert.equal(s1.size, 5, "容量上限应生效");
  s1.flush(true);

  const s2 = new OwnerMemoryStore({ file, maxFacts: 5, logger });
  assert.ok(s2.list().some((f) => /第8件事/.test(f.text)), "重启后仍在");
  assert.ok(!s2.list().some((f) => /第1件事/.test(f.text)), "超上限的旧内容应被淘汰");

  s2.clear();
  assert.equal(s2.size, 0);
});

test("长期记忆：注入上下文时只给主人，且不超过上限", async () => {
  const { engine, seen } = makeEngine();

  for (let i = 1; i <= 12; i += 1) {
    await engine.handle(c2cMsg(`记住第${i}条：春禾要记住的事`));
  }
  const ctx = seen.at(-1);
  assert.ok(ctx.ownerMemory.length <= 20, "注入条数应有上限");

  await engine.handle(groupMsg("随便聊聊", { openid: MEMBER_A }));
  assert.deepEqual(seen.at(-1).ownerMemory, [], "群成员无权读取主人的长期记忆");
});

test("边界：会话不存在时历史为空，不抛错", () => {
  const m = new MemoryStore({ maxTurns: 8, logger });
  assert.deepEqual(m.getForModel(`owner:${OWNER}`, { annotate: true }), []);
  assert.deepEqual(m.getForModel("不存在的键"), []);
});

test("边界：没有配置主人时，长期记忆不写、不注入", async () => {
  const { engine, seen } = makeEngine({ QQ_ADMIN_USERS: "" });

  await engine.handle(c2cMsg("以后叫我老大"));
  await engine.handle(c2cMsg("我是谁"));

  assert.equal(engine.ownerMemory.size, 0, "没有主人配置就不该产生长期记忆");
  assert.deepEqual(seen.at(-1).ownerMemory, []);
  assert.equal(seen.at(-1).sessionKey, `c2c:${OWNER}`, "没有主人配置时会话键保持旧行为");
});

// ---------------------------------------------------------------------------
// 5) 老数据迁移：14 个旧会话键一条都不能丢
// ---------------------------------------------------------------------------

function legacyFixture() {
  // 形状与真实 data/memory.json 一致：主人 3 份 + 其他成员 11 份 = 14 个键
  const sessions = {};
  const fill = (n, label) => Array.from({ length: n }, (_, i) => ({
    role: i % 2 === 0 ? "user" : "assistant",
    content: `${label}-${i + 1}`,
  }));
  sessions[`c2c:${OWNER}`] = fill(6, "主人私聊");
  sessions[`group:${GROUP_1}:${OWNER}`] = fill(16, "主人大群");
  sessions[`group:${GROUP_2}:${OWNER}`] = fill(2, "主人小群");
  const others = [
    MEMBER_A, MEMBER_B, "MEMBER_C", "MEMBER_D", "MEMBER_E",
    "MEMBER_F", "MEMBER_G", "MEMBER_H", "MEMBER_I",
  ];
  for (const [i, id] of others.entries()) {
    sessions[`group:${GROUP_1}:${id}`] = fill(2 + i, `群成员${id}`);
  }
  sessions[`c2c:${MEMBER_A}`] = fill(4, "成员私聊");
  sessions[`c2c:${MEMBER_B}`] = fill(4, "成员私聊2");
  return sessions;
}

test("迁移：旧 owner 会话合并到统一键，旧键与内容原样保留（14 个键不丢）", () => {
  const dir = tmpDir();
  const file = path.join(dir, "memory.json");
  const legacy = legacyFixture();
  assert.equal(Object.keys(legacy).length, 14, "fixture 应还原真实的 14 个会话键");
  fs.writeFileSync(file, JSON.stringify({ version: 1, sessions: legacy }), "utf8");

  const m = new MemoryStore({ maxTurns: 8, file, logger });
  m.migrateOwnerSessions([OWNER]);

  const ownerKey = `owner:${OWNER}`;
  assert.ok(m.get(ownerKey).length > 0, "应生成统一的主人会话");
  assert.match(flat(m.get(ownerKey)), /主人私聊/, "私聊内容必须带进统一会话");
  // 旧键不能被动：一条都不能少
  for (const [key, msgs] of Object.entries(legacy)) {
    assert.equal(m.get(key).length, msgs.length, `旧会话 ${key} 的消息数不能变`);
    assert.deepEqual(m.get(key).map((x) => x.content), msgs.map((x) => x.content), `旧会话 ${key} 的内容不能变`);
  }
  // 统一键也受轮数上限约束
  assert.ok(m.get(ownerKey).length <= 16);
});

test("迁移：重启后不重复合并（幂等）", () => {
  const dir = tmpDir();
  const file = path.join(dir, "memory.json");
  fs.writeFileSync(file, JSON.stringify({ version: 1, sessions: legacyFixture() }), "utf8");

  const m1 = new MemoryStore({ maxTurns: 8, file, logger });
  m1.migrateOwnerSessions([OWNER]);
  m1.flush(true);
  const once = m1.get(`owner:${OWNER}`).length;

  const m2 = new MemoryStore({ maxTurns: 8, file, logger });
  m2.migrateOwnerSessions([OWNER]);
  assert.equal(m2.get(`owner:${OWNER}`).length, once, "第二次启动不应重复拼接导致内容翻倍");
  assert.equal(m2.get(`c2c:${OWNER}`).length, 6, "旧会话仍然在（归档）");
});

test("迁移：合并后的历史带场景标注，能区分私聊与群聊", () => {
  const dir = tmpDir();
  const file = path.join(dir, "memory.json");
  fs.writeFileSync(file, JSON.stringify({ version: 1, sessions: legacyFixture() }), "utf8");

  const m = new MemoryStore({ maxTurns: 8, file, logger });
  m.migrateOwnerSessions([OWNER]);
  const forModel = m.getForModel(`owner:${OWNER}`, { annotate: true });
  assert.ok(forModel.some((x) => x.content.startsWith("〔私聊〕")), "应有私聊标注");
  assert.ok(forModel.some((x) => x.content.startsWith("〔群聊〕")), "应有群聊标注");
});

test("迁移：标记还在但统一键被旧版本进程覆盖丢失时，能重新合并出来", () => {
  // 真实场景：新旧版本共存过一阵，旧进程重启后按 v1 写了文件，
  // ownerMerged 标记还在、统一键却没了。不能因为"标记说合并过"就永远空着。
  const dir = tmpDir();
  const file = path.join(dir, "memory.json");
  fs.writeFileSync(
    file,
    JSON.stringify({ version: 2, ownerMerged: [OWNER], sessions: legacyFixture() }),
    "utf8",
  );

  const m = new MemoryStore({ maxTurns: 8, file, logger });
  m.migrateOwnerSessions([OWNER]);
  assert.ok(m.get(`owner:${OWNER}`).length > 0, "统一键丢失时应重新合并，而不是永远为空");
  assert.match(flat(m.get(`owner:${OWNER}`)), /主人私聊/);
});

test("边界：没有主人配置时迁移是空操作", () => {
  const dir = tmpDir();
  const file = path.join(dir, "memory.json");
  fs.writeFileSync(file, JSON.stringify({ version: 1, sessions: legacyFixture() }), "utf8");

  const m = new MemoryStore({ maxTurns: 8, file, logger });
  m.migrateOwnerSessions([]);
  assert.equal(m.size, 14, "不应新增/删除任何会话");
});
