/**
 * 群主动消息 + 群大小分级（新能力）。
 *
 * 用户原话：「大概就是主动发消息的能力，即私下发的指令能在群里执行，最好能让她分出大小群」。
 *
 * 本文件锁死的新行为：
 *   1. 私聊「去群里卖个萌」→ **立即**调用群主动消息（不带 msg_id），并回报发到哪个群；
 *   2. 主动消息失败 → 如实回报，不假装；待办保留，群里还能兜底执行；
 *   3. 群分级：成员数接口不可用时用「见过的发言人」当下限，标注 source=observed；
 *   4. 「去大群/小群」按标签选群；阈值可配；
 *   5. 主动消息配额：本地硬限制 + 记录，超限不发送、如实说；
 *   6. 非主人既不能创建、也不能触发。
 *
 * 全部离线：假 api、临时目录、不碰 data/、不发真实 QQ 消息。
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { MessageEngine, detectCapabilityDenial } from "../src/core/engine.js";
import { MemoryStore, MISLEADING_DENIAL_PATTERNS } from "../src/core/memory.js";
import { GroupRegistry, classifyGroupSize } from "../src/core/groups.js";
import { ProactiveQuota } from "../src/core/proactive-quota.js";
import { parsePendingInstruction } from "../src/core/pending-actions.js";
import { ApiError } from "../src/qq/api.js";
import { loadConfig } from "../src/config.js";
import {
  CHUNHE_SYSTEM_PROMPT,
  describeGroupsForModel,
  describeProactiveDeliveryForModel,
  makeModelGenerator,
} from "../src/persona/chunhe.js";
import { createLogger } from "../src/util/log.js";

const logger = createLogger("silent");

const OWNER = "OWNER_PROACTIVE_0001";
const MEMBER = "MEMBER_PROACTIVE_0002";
const GROUP_BIG = "GROUP_PROACTIVE_BIG_AAAA";
const GROUP_SMALL = "GROUP_PROACTIVE_SMALL_BB";
const GROUP_TINY = "GROUP_PROACTIVE_TINY_CCCC";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "qqbot-proactive-"));
}

function fakeApi({ failProactive = null } = {}) {
  const sent = [];
  const mediaUploads = [];
  const mediaSends = [];
  let n = 0;
  return {
    sent,
    mediaUploads,
    mediaSends,
    async sendMessage(scope, targetId, content, opts = {}) {
      sent.push({ scope, targetId, content, msgId: opts.msgId });
      return { id: `fake-${sent.length}`, content };
    },
    async sendProactiveMessage(scope, targetId, content) {
      if (failProactive) throw failProactive;
      sent.push({ scope, targetId, content, proactive: true });
      return { id: `fake-p-${sent.length}`, content };
    },
    async uploadMedia(scope, targetId, base64, fileType) {
      mediaUploads.push({ scope, targetId, fileType, buf: Buffer.from(base64, "base64") });
      n += 1;
      return `fi_${n}`;
    },
    async sendMedia(scope, targetId, fileInfo, opts = {}) {
      mediaSends.push({ scope, targetId, fileInfo, opts });
      return { id: `media-${n}` };
    },
    async getGroupMembers() {
      // 真机实测：该接口 11253 无权限。默认返回 []，引擎不得据此写成 0 人。
      return [];
    },
  };
}

function makeEngine(env = {}, { api = fakeApi(), generate } = {}) {
  const dir = tmpDir();
  const config = loadConfig({
    QQ_APP_ID: "test-app-id",
    QQ_APP_SECRET: "test-app-secret",
    QQ_GROUP_TRIGGER: "all",
    QQ_ADMIN_USERS: OWNER,
    QQ_MEMORY_FILE: path.join(dir, "memory.json"),
    QQ_TOPIC_FILE: path.join(dir, "topics.json"),
    QQ_OWNER_MEMORY_FILE: path.join(dir, "owner-memory.json"),
    QQ_PENDING_FILE: path.join(dir, "pending-actions.json"),
    QQ_REMINDER_FILE: path.join(dir, "reminders.json"),
    QQ_GROUPS_FILE: path.join(dir, "groups.json"),
    QQ_PROACTIVE_QUOTA_FILE: path.join(dir, "proactive-quota.json"),
    QQ_PENDING_DELIVERY: "proactive",
    QQ_GROUP_PROACTIVE_DAILY_LIMIT: "1000",
    QQ_GROUP_PROACTIVE_MINUTE_LIMIT: "20",
    QQ_PENDING_PROACTIVE_DAILY_LIMIT: "20",
    QQ_GROUP_DEFAULT_PICK: "active",
    QQ_REMINDERS: "false",
    QQ_MULTI_MESSAGE: "false",
    QQ_VOICE_REPLY: "off",
    QQ_SING_ENABLED: "false",
    QQ_PROACTIVE: "false",
    QQ_RATE_LIMIT_PER_MINUTE: "1000",
    ...env,
  });
  const seen = [];
  const engine = new MessageEngine({
    config,
    api,
    logger,
    generate:
      generate ??
      (async (ctx) => {
        seen.push(ctx);
        return "好呀～";
      }),
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
    messageId: `proactive-c2c-${seq}`,
    content: text,
    kind: "text",
    attachments: [],
  };
}

function groupMsg(text, { openid = OWNER, gid = GROUP_BIG, role = "member" } = {}) {
  seq += 1;
  return {
    scope: "group",
    targetId: gid,
    groupOpenid: gid,
    senderId: openid,
    senderName: openid === OWNER ? "群主" : "群友",
    memberRole: role,
    rawEventType: "GROUP_AT_MESSAGE_CREATE",
    messageId: `proactive-g-${seq}`,
    content: `<@!123> ${text}`,
    kind: "text",
    attachments: [],
  };
}

/** 给引擎灌一批「见过的发言人」——等价于真实 memory.json 里的 group:<gid>:<uid> 键 */
function seedGroup(engine, gid, senders, { messages = 0, memberCount = null } = {}) {
  senders.forEach((sid, i) => {
    engine.groups.observe({ groupOpenid: gid, senderOpenid: sid, at: 1000 + i });
  });
  if (messages > 0) engine.groups.addMessages(gid, messages);
  if (memberCount != null) engine.groups.setMemberCount(gid, memberCount, { source: "api" });
}

const c2cReplies = (api) => api.sent.filter((s) => s.scope === "c2c");
const groupProactive = (api) => api.sent.filter((s) => s.scope === "group" && s.proactive);
const firstPending = (engine) => engine.pendingActions.list({ ownerId: OWNER })[0];

// ---------------------------------------------------------------------------
// 1) 分级：阈值、observed 下限、标注
// ---------------------------------------------------------------------------

test("分级：成员数已知时阈值可配（默认 10 人）", () => {
  const large = classifyGroupSize({ memberCount: 10 });
  assert.equal(large.sizeLabel, "large");
  assert.equal(large.source, "api");
  assert.equal(large.confidence, "high");

  const small = classifyGroupSize({ memberCount: 9 });
  assert.equal(small.sizeLabel, "small");

  const custom = classifyGroupSize({ memberCount: 6, largeThreshold: 5 });
  assert.equal(custom.sizeLabel, "large", "阈值必须可配");

  const customSmall = classifyGroupSize({ memberCount: 6, largeThreshold: 7 });
  assert.equal(customSmall.sizeLabel, "small");
});

test("分级：没有成员数时用 observed 下限，并标注 source=observed", () => {
  // 实测样本：47 人的大群只观察到 8 位发言人 → observed 只是下限
  const observedLarge = classifyGroupSize({ observedCount: 8 });
  assert.equal(observedLarge.sizeLabel, "large");
  assert.equal(observedLarge.source, "observed");
  assert.equal(observedLarge.lowerBound, true, "必须标明这是下限，不是真实人数");
  assert.equal(observedLarge.confidence, "lower_bound");

  const observedTiny = classifyGroupSize({ observedCount: 2 });
  assert.equal(observedTiny.sizeLabel, "small");
  assert.equal(observedTiny.source, "observed");

  // API 成员数优先于 observed 下限
  const apiWins = classifyGroupSize({ memberCount: 4, observedCount: 2 });
  assert.equal(apiWins.sizeLabel, "small");
  assert.equal(apiWins.source, "api");

  // 阈值可配
  assert.equal(classifyGroupSize({ observedCount: 4, observedLargeThreshold: 4 }).sizeLabel, "large");
});

test("分级：注册表能从真实 memory 会话键算出每个群见过几个发言人", () => {
  const dir = tmpDir();
  const groups = new GroupRegistry({ file: path.join(dir, "groups.json"), logger });
  groups.seedFromSessions({
    [`group:${GROUP_BIG}:${OWNER}`]: [1, 2, 3],
    [`group:${GROUP_BIG}:${MEMBER}`]: [1],
    [`group:${GROUP_BIG}:A`]: [],
    [`group:${GROUP_SMALL}:${OWNER}`]: [1, 2],
    [`owner:${OWNER}`]: [1],
  });
  const big = groups.get(GROUP_BIG);
  assert.equal(big.observedSenders.length, 3, "同一个人多轮只算 1 位发言人");
  assert.equal(big.messageCount, 4);
  assert.equal(groups.get(GROUP_SMALL).observedSenders.length, 1);
  assert.equal(groups.get(`owner:${OWNER}`), null, "非群会话不能进群注册表");

  groups.flush(true);
  const reloaded = new GroupRegistry({ file: path.join(dir, "groups.json"), logger });
  assert.equal(reloaded.get(GROUP_BIG).observedSenders.length, 3, "重启后下限仍在");
});

test("分级：setMemberCount 成功拿到的真实人数优先，且不会被 observed 覆盖", () => {
  const dir = tmpDir();
  const groups = new GroupRegistry({ file: path.join(dir, "groups.json"), logger });
  groups.observe({ groupOpenid: GROUP_BIG, senderOpenid: OWNER });
  groups.setMemberCount(GROUP_BIG, 47, { source: "api" });
  const e = groups.get(GROUP_BIG);
  assert.equal(e.memberCount, 47);
  assert.equal(e.memberCountSource, "api");
  assert.equal(e.sizeLabel, "large");

  // 空数组（真实接口 11253 降级 / 分页空）不得写成 0 人
  groups.setMemberCount(GROUP_SMALL, 0, { source: "api" });
  assert.equal(groups.get(GROUP_SMALL), null);
});

// ---------------------------------------------------------------------------
// 2) 识别：去大群 / 去小群
// ---------------------------------------------------------------------------

test("识别：去大群/去小群 → size:large / size:small；没指定仍是 any_group", () => {
  const big = parsePendingInstruction("待会去大群卖个萌");
  assert.ok(big);
  assert.equal(big.target, "size:large");
  assert.equal(big.kind, "cute");

  const small = parsePendingInstruction("去小群说一句晚安");
  assert.ok(small);
  assert.equal(small.target, "size:small");
  assert.equal(small.kind, "say");
  assert.match(small.payload.text, /晚安/);

  const any = parsePendingInstruction("在群里卖个萌");
  assert.equal(any.target, "any_group");

  // 「大群里」这种自然说法也要认，别把「里」当成动作开头而漏掉
  const withLi = parsePendingInstruction("去大群里卖个萌");
  assert.equal(withLi?.target, "size:large");
  assert.equal(withLi?.kind, "cute");
});

test("识别：问句形式的请求（真机 21:03 原话）也必须执行", () => {
  // 主人真实说过：「现在你能在大群里买个萌吗」——不是问能力，是要她做
  const ask = parsePendingInstruction("现在你能在大群里买个萌吗");
  assert.ok(ask, "问句形式的请求不能被当成纯能力提问丢掉");
  assert.equal(ask.target, "size:large");
  assert.equal(ask.kind, "cute");
  assert.equal(ask.action, "买个萌", "句尾的「吗」不能留在动作里");

  const say = parsePendingInstruction("你能在群里说一句晚安吗");
  assert.equal(say?.kind, "say");
  assert.equal(say?.payload.text, "晚安");

  const at = parsePendingInstruction("你能在群里@张三吗");
  assert.equal(at?.kind, "at");
  assert.equal(at?.payload.mention, "张三");

  // 真正的能力询问仍然不能变成待办
  for (const text of [
    "你能在群里做什么吗",
    "你能在群里说话吗",
    "你能在群里唱首歌吗",
    "现在私聊里发的指令能在群聊实现吗",
  ]) {
    assert.equal(parsePendingInstruction(text), null, `不该识别成待办：${text}`);
  }
});

test("核心：主人用问句下指令（「你能在大群里买个萌吗」）→ 真的主动发", async () => {
  const { engine, api } = makeEngine();
  seedGroup(engine, GROUP_BIG, [OWNER, "a", "b", "c", "d", "e"], { messages: 50 });
  seedGroup(engine, GROUP_SMALL, [OWNER, "a"], { messages: 10 });

  await engine.handle(c2cMsg("现在你能在大群里买个萌吗"));

  const sent = groupProactive(api);
  assert.equal(sent.length, 1, "问句形式的指令也必须真的发");
  assert.equal(sent[0].targetId, GROUP_BIG);
  assert.match(sent[0].content, /啾咪|卖个萌/);
  assert.match(c2cReplies(api).at(-1).content, /发到|已经发/);
});

// ---------------------------------------------------------------------------
// 3) 核心：私聊下指令 → 真的主动发到群里
// ---------------------------------------------------------------------------

test("核心：私聊「去群里卖个萌」→ 立即调用群主动消息（不带 msg_id），并回报成功", async () => {
  const { engine, api } = makeEngine();
  seedGroup(engine, GROUP_BIG, [OWNER, "a", "b", "c", "d", "e", "f"], { messages: 90 });
  seedGroup(engine, GROUP_SMALL, [OWNER, "a"], { messages: 10 });

  await engine.handle(c2cMsg("待会在群里卖个萌"));

  const sends = groupProactive(api);
  assert.equal(sends.length, 1, "必须真的调用一次群主动消息");
  assert.equal(sends[0].targetId, GROUP_BIG, "默认选最活跃的群（真实样本里的主群）");
  assert.equal(sends[0].proactive, true, "走的是主动消息路径，不是被动回复");
  assert.match(sends[0].content, /啾咪|卖个萌/, "发出去的必须真的是卖萌的话");

  const reply = c2cReplies(api).at(-1).content;
  assert.match(reply, /发到|已经发|发出去/, "必须回报真的发了");
  assert.match(reply, /大群|群成员|发言人/, "回报里要说清目标群的大小/依据");
  assert.ok(!/等你.*群里.*说|到群里说一声/.test(reply), "不许再让她等主人开口");

  const entry = engine.pendingActions.list({ ownerId: OWNER, status: null })[0];
  assert.equal(engine.pendingActions.get(entry.id).status, "done");
  assert.equal(engine.pendingActions.get(entry.id).doneGroup, GROUP_BIG);
  assert.equal(engine.stats.pendingProactiveSent, 1);
});

test("核心：「去大群」「去小群」按标签选对群", async () => {
  {
    const { engine, api } = makeEngine();
    seedGroup(engine, GROUP_BIG, [OWNER, "a", "b", "c", "d", "e", "f"], { messages: 50 });
    seedGroup(engine, GROUP_SMALL, [OWNER, "a"], { messages: 90 });
    await engine.handle(c2cMsg("去大群卖个萌"));
    assert.equal(groupProactive(api)[0].targetId, GROUP_BIG, "去大群必须选 large");
  }
  {
    const { engine, api } = makeEngine();
    seedGroup(engine, GROUP_BIG, [OWNER, "a", "b", "c", "d", "e", "f"], { messages: 90 });
    seedGroup(engine, GROUP_SMALL, [OWNER, "a"], { messages: 10 });
    seedGroup(engine, GROUP_TINY, [OWNER], { messages: 5 });
    await engine.handle(c2cMsg("去小群说一句晚安"));
    const sent = groupProactive(api);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].targetId, GROUP_SMALL, "小群里选最活跃的那个（AB20 级），不是最小那个");
    assert.match(sent[0].content, /晚安/);
  }
});

test("核心：知道有哪些群、各自多大 —— 上下文里带群清单", async () => {
  const { engine, seen } = makeEngine();
  seedGroup(engine, GROUP_BIG, [OWNER, "a", "b", "c", "d", "e"], { messages: 40 });
  seedGroup(engine, GROUP_SMALL, [OWNER, "a"], { messages: 8, memberCount: 3 });

  await engine.handle(c2cMsg("你现在在哪些群"));
  const groups = seen.at(-1).groups;
  assert.ok(Array.isArray(groups) && groups.length === 2, "主人应该拿到群清单");
  const big = groups.find((g) => g.groupOpenid === GROUP_BIG);
  assert.equal(big.sizeLabel, "large");
  assert.equal(big.source, "observed");
  assert.equal(big.observedCount, 6);
  const small = groups.find((g) => g.groupOpenid === GROUP_SMALL);
  assert.equal(small.sizeLabel, "small");
  assert.equal(small.memberCount, 3);
});

// ---------------------------------------------------------------------------
// 4) 失败：如实回报，不假装
// ---------------------------------------------------------------------------

test("失败：平台拒发（无权限）→ 如实回报，不假装发了，待办保留", async () => {
  const fail = new ApiError("API 错误：主动消息发送失败，无权限", {
    httpStatus: 400,
    bizCode: 40034105,
    path: `/v2/groups/${GROUP_BIG}/messages`,
  });
  const { engine, api } = makeEngine({}, { api: fakeApi({ failProactive: fail }) });
  seedGroup(engine, GROUP_BIG, [OWNER, "a", "b"], { messages: 20 });

  await engine.handle(c2cMsg("在群里卖个萌"));

  const reply = c2cReplies(api).at(-1).content;
  assert.match(reply, /没发出去|发送失败|发不出去/, "必须如实说失败");
  assert.match(reply, /权限|主动消息|拒/, "要给出人话原因");
  assert.ok(!/已经发|发出去啦|发好啦/.test(reply), `绝不许假装：${reply}`);

  const entry = firstPending(engine);
  assert.equal(engine.pendingActions.get(entry.id).status, "pending", "失败要保留，别悄悄吞掉");
  assert.equal(engine.pendingActions.get(entry.id).attempts, 1);
  assert.match(engine.pendingActions.get(entry.id).lastError, /权限|40034105/);
  assert.equal(engine.stats.pendingProactiveFailed, 1);

  // 兜底：主人之后在群里说话，仍能执行这条待办
  const before = groupProactive(api).length;
  await engine.handle(groupMsg("大家好"));
  assert.equal(groupProactive(api).length, before, "兜底走被动回复，不该再烧主动配额");
  assert.equal(engine.pendingActions.get(entry.id).status, "done");
  assert.match(api.sent.at(-1).content, /卖个萌|啾咪|萌/);
});

test("失败：一个群都不知道 → 不瞎发，如实问；群里说话仍能兜底", async () => {
  const { engine, api } = makeEngine();
  await engine.handle(c2cMsg("在群里卖个萌"));

  assert.equal(groupProactive(api).length, 0, "不知道群就不许乱发");
  const reply = c2cReplies(api).at(-1).content;
  assert.match(reply, /群/, "要说明群里的事");
  assert.ok(/还不知道|没认出|说一声|哪个群/.test(reply), `要如实说明并给办法：${reply}`);

  const entry = firstPending(engine);
  assert.equal(engine.pendingActions.get(entry.id).status, "pending");
  assert.equal(engine.pendingActions.get(entry.id).attempts, 0, "没群可发不算一次失败重试");

  await engine.handle(groupMsg("在吗"));
  assert.equal(engine.pendingActions.get(entry.id).status, "done");
  assert.match(api.sent.at(-1).content, /卖个萌|啾咪|萌/);
});

test("失败：「去大群」但注册表里没有大群 → 说明白，不拿小群顶替", async () => {
  const { engine, api } = makeEngine();
  seedGroup(engine, GROUP_SMALL, [OWNER, "a"], { messages: 10 });

  await engine.handle(c2cMsg("去大群卖个萌"));
  assert.equal(groupProactive(api).length, 0, "没有大群就不能拿小群冒充");
  const reply = c2cReplies(api).at(-1).content;
  assert.match(reply, /大群/);
  assert.ok(/没|不知道|认不出|没有/.test(reply), `要如实说没有大群：${reply}`);
});

// ---------------------------------------------------------------------------
// 5) 配额：发之前检查、发完记录、接近上限要提醒
// ---------------------------------------------------------------------------

test("配额：本地每日限额用完 → 不发送、如实说明；已发记录可查", async () => {
  const dir = tmpDir();
  const quotaFile = path.join(dir, "quota.json");
  const quota = new ProactiveQuota({
    file: quotaFile,
    dailyLimit: 2,
    minuteLimit: 20,
    warnRatio: 0.5,
    logger,
  });
  assert.equal(quota.check({ targetId: GROUP_BIG, purpose: "pending" }).ok, true);
  quota.record({ targetId: GROUP_BIG, purpose: "pending", ok: true });
  const half = quota.check({ targetId: GROUP_BIG, purpose: "pending" });
  assert.equal(half.level, "warn", "到 50% 就该给提醒级别");
  quota.record({ targetId: GROUP_BIG, purpose: "pending", ok: true });
  const full = quota.check({ targetId: GROUP_BIG, purpose: "pending" });
  assert.equal(full.ok, false);
  assert.equal(full.reason, "daily_limit");

  const reloaded = new ProactiveQuota({ file: quotaFile, dailyLimit: 2, logger });
  assert.equal(reloaded.stats({ targetId: GROUP_BIG }).dayCount, 2, "配额必须落盘，重启不清零");

  // 端到端：限额 1 时第二条不再发
  const { engine, api } = makeEngine({
    QQ_PROACTIVE_QUOTA_FILE: path.join(tmpDir(), "quota2.json"),
    QQ_PENDING_PROACTIVE_DAILY_LIMIT: "1",
  });
  seedGroup(engine, GROUP_BIG, [OWNER, "a", "b"], { messages: 20 });
  await engine.handle(c2cMsg("在群里卖个萌"));
  assert.equal(groupProactive(api).length, 1);

  await engine.handle(c2cMsg("在群里说一句晚安"));
  assert.equal(groupProactive(api).length, 1, "配额用完必须停发");
  const reply = c2cReplies(api).at(-1).content;
  assert.match(reply, /额度|配额|上限|发不了/, `要如实说配额：${reply}`);
});

test("配额：时间窗口滚动后恢复（分钟级 + 天级）", async () => {
  const dir = tmpDir();
  let now = Date.UTC(2026, 0, 1, 0, 0, 0);
  const quota = new ProactiveQuota({
    file: path.join(dir, "q.json"),
    dailyLimit: 2,
    minuteLimit: 1,
    logger,
    now: () => now,
  });
  quota.record({ targetId: GROUP_BIG, purpose: "pending", ok: true, now });
  assert.equal(quota.check({ targetId: GROUP_BIG, now }).reason, "minute_limit");
  now += 61_000;
  assert.equal(quota.check({ targetId: GROUP_BIG, now }).ok, true, "过一分钟应恢复");
  quota.record({ targetId: GROUP_BIG, purpose: "pending", ok: true, now });
  assert.equal(quota.check({ targetId: GROUP_BIG, now }).ok, false);
  assert.equal(quota.check({ targetId: GROUP_BIG, now }).reason, "daily_limit");
  now += 24 * 3600 * 1000;
  assert.equal(quota.check({ targetId: GROUP_BIG, now }).ok, true, "跨天后恢复");
});

// ---------------------------------------------------------------------------
// 6) 安全：非主人不能触发
// ---------------------------------------------------------------------------

test("安全：非主人私聊下指令 → 不建待办、不发群消息", async () => {
  const { engine, api } = makeEngine();
  seedGroup(engine, GROUP_BIG, [OWNER, "a", "b"], { messages: 20 });

  await engine.handle(c2cMsg("在群里卖个萌", MEMBER));
  assert.equal(groupProactive(api).length, 0);
  assert.equal(engine.pendingActions.pendingCount(MEMBER), 0);
  assert.equal(engine.pendingActions.pendingCount(OWNER), 0);
});

// ---------------------------------------------------------------------------
// 7) 配置默认值
// ---------------------------------------------------------------------------

test("配置：群分级阈值 / 主动投递 / 配额的默认值可预期", () => {
  const cfg = loadConfig({});
  assert.equal(cfg.pendingDelivery, "proactive");
  assert.equal(cfg.pendingProactiveDailyLimit, 20);
  assert.equal(cfg.groupLargeThreshold, 10);
  assert.equal(cfg.groupObservedLargeThreshold, 5);
  assert.equal(cfg.groupDefaultPick, "active");
  assert.equal(cfg.groupsFile, "data/groups.json");
  assert.equal(cfg.proactiveQuotaFile, "data/proactive-quota.json");
  assert.equal(cfg.groupProactiveDailyLimit, 1000);
  assert.equal(cfg.groupProactiveMinuteLimit, 20);
});

test("配置：QQ_PENDING_DELIVERY=deferred → 保持旧行为（等群聊触发）", async () => {
  const { engine, api } = makeEngine({ QQ_PENDING_DELIVERY: "deferred" });
  seedGroup(engine, GROUP_BIG, [OWNER, "a", "b"], { messages: 20 });
  await engine.handle(c2cMsg("在群里卖个萌"));
  assert.equal(groupProactive(api).length, 0, "deferred 模式不主动发");
  assert.match(c2cReplies(api).at(-1).content, /群里/);

  await engine.handle(groupMsg("大家好"));
  assert.match(api.sent.at(-1).content, /卖个萌|啾咪|萌/);
  assert.equal(
    engine.pendingActions.list({ ownerId: OWNER, status: null })[0].status,
    "done",
  );
});

// ---------------------------------------------------------------------------
// 8) 人格/提示词：她知道有哪些群，也知道失败不许装
// ---------------------------------------------------------------------------

test("提示词：群清单告诉模型大小群、下限标注与派活规则", () => {
  const hint = describeGroupsForModel([
    {
      groupOpenid: GROUP_BIG,
      shortId: "GROUP_PR…AAAA",
      sizeText: "大群",
      sizeLabel: "large",
      observedCount: 8,
      memberCount: null,
      messageCount: 94,
    },
    {
      groupOpenid: GROUP_SMALL,
      shortId: "GROUP_PR…BB",
      sizeText: "小群",
      sizeLabel: "small",
      observedCount: 2,
      memberCount: 3,
      messageCount: 32,
    },
  ]);
  assert.match(hint, /大群/);
  assert.match(hint, /小群/);
  assert.match(hint, /下限|不是真实人数/, "必须标注 observed 是下限");
  assert.match(hint, /去大群\/小群/);
  assert.match(hint, /不要再说看不到群列表|不要.*看不到群列表/);
  assert.equal(describeGroupsForModel([]), "", "没有群时不要注入空清单");

  // 模型提示词里真的带上了这份清单
  let captured = null;
  const gen = makeModelGenerator({
    config: {
      modelBaseUrl: "https://example.invalid/v1",
      modelApiKey: "k",
      modelName: "m",
      historyTurns: 8,
      modelTimeoutMs: 5000,
    },
    logger,
    fetchImpl: async (_url, init) => {
      captured = JSON.parse(init.body);
      return new Response(JSON.stringify({ choices: [{ message: { content: "在的" } }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  });
  return gen({
    text: "你在哪些群",
    scope: "c2c",
    history: [],
    isOwnerUser: true,
    groups: [
      {
        groupOpenid: GROUP_BIG,
        shortId: "GROUP_PR…AAAA",
        sizeText: "大群",
        sizeLabel: "large",
        observedCount: 8,
        messageCount: 94,
      },
    ],
  }).then(() => {
    const sys = String(captured.messages[0].content);
    assert.match(sys, /春禾在的群/);
    assert.match(sys, /GROUP_PR…AAAA/);
  });
});

test("提示词：主动发群失败时，禁止模型说「已经发了」", () => {
  const fail = describeProactiveDeliveryForModel({ ok: false, reason: "send_failed" });
  assert.match(fail, /没成功/);
  assert.match(fail, /如实/);
  assert.match(fail, /绝不许说已经发了/);
  const ok = describeProactiveDeliveryForModel({ ok: true });
  assert.match(ok, /已成功/);
  assert.match(ok, /不要再说/);
  assert.equal(describeProactiveDeliveryForModel(null), "");
});

test("记忆清理：真机新出现的「私聊发出去只会落在私聊里」也要被清掉", () => {
  const bad =
    "主人去大群里说一句话，春禾就当场买个萌给大家看～私聊这边发出去的话只会落在私聊里，" +
    "所以还得等主人在群里先开口 😊";
  assert.ok(detectCapabilityDenial(bad).length > 0, "真实新说法必须能被探测到");
  assert.ok(
    MISLEADING_DENIAL_PATTERNS.some((re) => re.test(bad)),
    "必须进入记忆清理规则，否则会一直自我强化",
  );

  // 12:45 的另一条历史自述（实测仍在线上记忆里）也必须清掉
  const older =
    "私聊里发起的待办，得等主人在群里开口之后，春禾才接得上；这个由头得交给系统来触发。";
  assert.ok(detectCapabilityDenial(older).length > 0, "历史变体也要能探测");
  assert.ok(MISLEADING_DENIAL_PATTERNS.some((re) => re.test(older)), "历史变体要能清理");

  const dir = tmpDir();
  const file = path.join(dir, "memory.json");
  fs.writeFileSync(
    file,
    JSON.stringify({
      version: 2,
      sessions: {
        [`owner:${OWNER}`]: [
          { role: "user", content: "现在你能在大群里买个萌吗" },
          { role: "assistant", content: bad },
        ],
      },
    }),
    "utf8",
  );
  const mem = new MemoryStore({ maxTurns: 8, ownerMaxTurns: 20, file, logger });
  const removed = mem.purgeMisleadingDenials([OWNER]);
  assert.ok(removed >= 1, "启动时应删掉这条错误自述");
  assert.ok(!mem.get(`owner:${OWNER}`).some((m) => /只会落在私聊里/.test(m.content)));
});

// ---------------------------------------------------------------------------
// 7) 跨场景 @ 指令：解析 / 主动发送 / 真 @ 限制 / 谨慎确认
// ---------------------------------------------------------------------------

test("识别：@ 句式（真机原话）必须解析出 atName + 转述内容", () => {
  // 真机 2026-10-17 原话：问句 + @某人 + 转述内容
  const ask = parsePendingInstruction("能在群里@junh让他去漂唱吗");
  assert.ok(ask, "问句形式的 @ 指令不能被丢弃");
  assert.equal(ask.kind, "at");
  assert.equal(ask.payload.mention, "junh");
  assert.match(ask.payload.message ?? "", /漂唱/);
  assert.equal(ask.needsConfirm, true, "歧义/敏感内容必须先确认，不能自动发");

  // 句首没有「能」、但仍然是「在群里@某人…吗」的请求（任务描述里的原句）
  const askPlain = parsePendingInstruction("在群里@junh让他去漂唱吗");
  assert.ok(askPlain, "「在群里@某人…吗」也是请求，不能因为句尾「吗」丢掉");
  assert.equal(askPlain.kind, "at");
  assert.equal(askPlain.payload.mention, "junh");
  assert.match(askPlain.payload.message ?? "", /漂唱/);
  assert.equal(askPlain.needsConfirm, true);

  const big = parsePendingInstruction("去大群里@张三说该开会了");
  assert.equal(big?.kind, "at");
  assert.equal(big?.payload.mention, "张三");
  assert.equal(big?.payload.message, "该开会了", "「说」是转述引导词，不是内容");
  assert.equal(big?.target, "size:large");
  assert.notEqual(big?.needsConfirm, true, "普通提醒不该被当成敏感内容");

  // 没写场景锚点，但以 @ 开头：按跨场景指令处理（默认任意群）
  const bare = parsePendingInstruction("@李四提醒他交作业");
  assert.equal(bare?.kind, "at");
  assert.equal(bare?.payload.mention, "李四");
  assert.equal(bare?.payload.message, "交作业");
  assert.equal(bare?.target, "any_group");
});

test("核心：@ 待办真的主动发到群，回执如实说明「做不了真 @ 提醒」", async () => {
  const { engine, api } = makeEngine();
  seedGroup(engine, GROUP_BIG, [OWNER, "a", "b", "c", "d", "e"], { messages: 50 });

  await engine.handle(c2cMsg("去大群里@张三说该开会了"));

  const sends = groupProactive(api);
  assert.equal(sends.length, 1, "必须真的主动发一次");
  assert.equal(sends[0].targetId, GROUP_BIG);
  assert.match(sends[0].content, /@张三/, "群里发出去的必须含 @名字 文字");
  assert.match(sends[0].content, /该开会了/, "转述内容不能丢");

  const reply = c2cReplies(api).at(-1).content;
  assert.match(reply, /发到|已经发/, "成功要有回执");
  assert.match(reply, /真 ?@/, "回执必须点明不是真 @");
  assert.match(reply, /文字|做不了|不是真|没权限/, `要说明限制：${reply}`);
  assert.ok(!/一定看到|肯定看到|会收到提醒/.test(reply), "不许宣称对方一定收到提醒");

  const entry = engine.pendingActions.list({ ownerId: OWNER, status: null })[0];
  assert.equal(engine.pendingActions.get(entry.id).status, "done");
});

test("谨慎：@ 内容含歧义/敏感词 → 只留待确认草稿，不自动发群", async () => {
  const { engine, api } = makeEngine();
  seedGroup(engine, GROUP_BIG, [OWNER, "a", "b", "c", "d", "e"], { messages: 50 });

  await engine.handle(c2cMsg("能在群里@junh让他去漂唱吗"));

  assert.equal(groupProactive(api).length, 0, "含义没确认前绝不许发到群里");

  const entry = firstPending(engine);
  assert.ok(entry, "解析结果要留档，不能凭空丢掉");
  assert.equal(entry.payload?.needsConfirm, true);
  assert.equal(entry.delivery, "deferred", "待确认的草稿不能走主动发送");

  const reply = c2cReplies(api).at(-1).content;
  assert.ok(!/这就去|已经发了|马上就去/.test(reply), `不许先答应：${reply}`);
  assert.match(reply, /确认|拿不准|不确定|先问|没发/, `要如实说还没发：${reply}`);
});

// ---------------------------------------------------------------------------
// 8) 假承诺防护：没有回执，绝不许说「这就去 / 已经发了」
// ---------------------------------------------------------------------------

test("假承诺：没有回执时，回复里的「这就去 / 已经发了」必须被改掉", async () => {
  // 一个群都不知道 → 主动投递必然失败；模型却先答应了（真机第 36 条原话）
  const { engine, api } = makeEngine({}, {
    generate: async () => "好嘞，那春禾这就去大群里 @junh，提醒他该去玩火影啦～",
  });

  await engine.handle(c2cMsg("在群里@junh让他去玩火影"));

  const reply = c2cReplies(api).at(-1).content;
  assert.ok(!/这就去|已经发了|马上就去/.test(reply), `假承诺必须被拦下：${reply}`);
  assert.match(reply, /没发|还没|发不出去|不知道|群/, `必须给出诚实话：${reply}`);
  assert.equal(groupProactive(api).length, 0, "本来就没发，群里不能有消息");
});

test("假承诺：有回执（真的发出去了）时才允许说「已经发了」", async () => {
  const { engine, api } = makeEngine({}, {
    generate: async () => "春禾已经发好啦～",
  });
  seedGroup(engine, GROUP_BIG, [OWNER, "a", "b", "c", "d", "e"], { messages: 50 });

  await engine.handle(c2cMsg("去大群里卖个萌"));

  assert.equal(groupProactive(api).length, 1, "先要真的有回执");
  const reply = c2cReplies(api).at(-1).content;
  assert.match(reply, /已经发好啦/, "有回执时不该误伤正常表述");
  assert.match(reply, /已经发到|发到群里/, "确定性回执也要在");
});

test("提示词：无回执不许承诺「这就去」，主动 @ 不是真 @", () => {
  assert.match(CHUNHE_SYSTEM_PROMPT, /没有(?:回执|证据)/, "人格层要有硬规则");
  assert.match(CHUNHE_SYSTEM_PROMPT, /这就去/, "要点名具体禁用说法");
  assert.match(CHUNHE_SYSTEM_PROMPT, /真 ?@/, "要说清主动 @ 与真 @ 的区别");

  const okAt = describeProactiveDeliveryForModel({ ok: true, kind: "at" });
  assert.match(okAt, /文字|真 ?@/, "主动 @ 的提示要说明限制");
  assert.match(okAt, /真 ?@/);
});

// ---------------------------------------------------------------------------
// 9) 自相矛盾闸门：真机 2026-10-17 22:20 / 22:22 的两句 WRN
//    模型说「没法推到群里」，引擎紧接着回执「已经发到群里啦」——同一句话里打架。
//    有确定性回执时，模型那段否认必须被回执替换（代码闸门，不是提示词建议）。
// ---------------------------------------------------------------------------

/** 造一个临时表情包目录并挂到引擎上（不依赖开发机素材） */
function installStickerDir(engine) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qqbot-stickers-"));
  const img = (n) =>
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from(String(n)),
    ]);
  const meng = img("meng");
  const heart = img("heart");
  fs.writeFileSync(path.join(dir, "春禾-卖萌,春禾-撒娇.png"), meng);
  fs.writeFileSync(path.join(dir, "春禾-比心.png"), heart);
  engine.config.stickers = { enabled: true, dir, maxBytes: 2 * 1024 * 1024 };
  return { meng, heart, dir };
}

test("矛盾闸门：主动 @ 成功时，模型说「私聊没法直接推到群里」必须被回执替换", async () => {
  const api = fakeApi();
  const { engine } = makeEngine({}, {
    api,
    generate: async () =>
      "私聊这边春禾没法直接推消息到群里；不过主人在群里喊一声「@乙某」，春禾回复时就会把「@乙某」写进去～真 @ 能不能转成功要看群权限。",
  });
  seedGroup(engine, GROUP_BIG, [OWNER, "a", "b", "c", "d", "e"], { messages: 50 });

  await engine.handle(c2cMsg("能在群里@乙某吗"));

  assert.equal(groupProactive(api).length, 1, "先要真的有回执");
  const reply = c2cReplies(api).at(-1).content;
  assert.match(reply, /已经发到群里/, `必须有确定性回执：${reply}`);
  assert.ok(!/没法|做不到|不能直接推/.test(reply), `不能和回执自相矛盾：${reply}`);
});

test("矛盾闸门：真机第二句——「表情包没法转到群里」不能紧挨着「已经发到群里啦」", async () => {
  const api = fakeApi();
  const { engine } = makeEngine({}, {
    api,
    generate: async () =>
      "〔私聊〕表情包好像只能发在当前这个窗口里，春禾没法把它直接转到群里去。主人在群里说一句「卖个萌」，春禾就在群里发给你看～",
  });
  const { meng, heart } = installStickerDir(engine);
  seedGroup(engine, GROUP_BIG, [OWNER, "a", "b", "c", "d", "e"], { messages: 50 });

  await engine.handle(c2cMsg("群里发下"));

  assert.equal(api.mediaUploads.length, 1, "表情包要真的发到群里");
  assert.equal(api.mediaUploads[0].scope, "group");
  assert.ok(
    [meng, heart].some((b) => b.equals(api.mediaUploads[0].buf)),
    "发出去的必须是素材库里的图",
  );

  const reply = c2cReplies(api).at(-1).content;
  assert.match(reply, /已经发到群里/, `必须有确定性回执：${reply}`);
  assert.ok(
    !/没法|只能发在当前|转不到|做不到/.test(reply),
    `不能一边说没法一边说已经发了：${reply}`,
  );
});

test("矛盾闸门：没有回执（平台拒发）时，模型说「已经发到群里」必须被删掉", async () => {
  const api = fakeApi({
    failProactive: new ApiError("拒发", { bizCode: 40034105 }),
  });
  const { engine } = makeEngine({}, {
    api,
    generate: async () => "好嘞，春禾已经发到群里啦～",
  });
  seedGroup(engine, GROUP_BIG, [OWNER, "a", "b", "c", "d", "e"], { messages: 50 });

  await engine.handle(c2cMsg("在群里@张三"));

  const reply = c2cReplies(api).at(-1).content;
  assert.ok(!/已经发(?:到|进|啦)/.test(reply), `没发出去就不能说发了：${reply}`);
  assert.match(reply, /没发|拒|失败|权限|没成功/, `必须如实说没发出去：${reply}`);
});

// ---------------------------------------------------------------------------
// 10) 表情包：引擎确定性触发（不靠模型掷骰子）
// ---------------------------------------------------------------------------

test("表情包：群聊里「发个表情包」走群路径真的发出去", async () => {
  const api = fakeApi();
  const { engine } = makeEngine({}, { api });
  const { meng, heart } = installStickerDir(engine);

  const result = await engine.handle(groupMsg("发个表情包"));

  assert.equal(result.action, "replied");
  assert.equal(api.mediaUploads.length, 1, "应上传一张表情包");
  assert.equal(api.mediaUploads[0].scope, "group", "群聊必须走群上传路径");
  assert.equal(api.mediaUploads[0].targetId, GROUP_BIG);
  assert.equal(api.mediaUploads[0].fileType, 1, "file_type=1");
  assert.ok(
    [meng, heart].some((b) => b.equals(api.mediaUploads[0].buf)),
    "发出去的必须是素材库里的图",
  );
  assert.equal(api.mediaSends.length, 1, "上传后要发 msg_type=7 消息");
  assert.equal(api.mediaSends[0].scope, "group");
  assert.equal(api.mediaSends[0].targetId, GROUP_BIG);
});

test("表情包：「看看你卖萌的样子」必须真的发一张卖萌表情包，不能只回文字", async () => {
  const api = fakeApi();
  const { engine } = makeEngine({}, { api });
  const { meng } = installStickerDir(engine);

  await engine.handle(c2cMsg("看看你卖萌的样子"));

  assert.equal(api.mediaUploads.length, 1, "只回文字就是真机那个问题");
  assert.equal(api.mediaUploads[0].scope, "c2c");
  assert.deepEqual(api.mediaUploads[0].buf, meng);
  assert.equal(api.mediaSends.length, 1);
  assert.equal(c2cReplies(api).length, 1, "图之后还要正常接话");
});

test("表情包：「发个比心」命中比心那张", async () => {
  const api = fakeApi();
  const { engine } = makeEngine({}, { api });
  const { heart } = installStickerDir(engine);

  await engine.handle(c2cMsg("发个比心"));

  assert.equal(api.mediaUploads.length, 1);
  assert.deepEqual(api.mediaUploads[0].buf, heart, "应命中「春禾-比心」");
  assert.equal(api.mediaSends.length, 1);
});

