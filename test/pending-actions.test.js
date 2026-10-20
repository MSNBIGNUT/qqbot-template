/**
 * 跨场景「待办指令」+ owner 记忆窗口 + 禁止凭空断定 + 曲库清单 测试。
 *
 * 修的真实问题（用户原话）：
 *   「主人在私聊下的指令，群聊里不执行」。
 *
 * 上一轮只做了会话合并（owner 键），但真机仍然不行，根因有两个：
 *   1. QQ_HISTORY_TURNS=8 → 16 条上限，私聊指令聊十几句就被挤出窗口；
 *   2. 她"猜"这件事做不到，还把「私聊没法替你往群里转发消息」写进了记忆。
 *
 * 本测试锁死：
 *   - 私聊说「在群里做 X」→ 独立待办队列（不占 historyTurns）；
 *   - 主人到群里说话 → 待办被执行并标记 done；
 *   - 过期 / 多群 / 指定群 / 持久化；
 *   - owner 窗口放大但受字符预算约束（token 不失控）；
 *   - 人格规则禁止「大概不行」式猜测，历史里的错误自述被清理；
 *   - 曲库清单能被直接列出；
 *   - 非主人完全看不到待办与主人记忆。
 *
 * 全部离线：假 api、临时曲库、临时持久化文件，不碰 data/、不联网、不跑合成。
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { MessageEngine, detectCapabilityDenial } from "../src/core/engine.js";
import { MemoryStore, MISLEADING_DENIAL_PATTERNS } from "../src/core/memory.js";
import {
  PendingActionStore,
  parsePendingInstruction,
  describePendingActionForModel,
  PENDING_TARGET_ANY_GROUP,
} from "../src/core/pending-actions.js";
import { loadConfig } from "../src/config.js";
import {
  CHUNHE_SYSTEM_PROMPT,
  describeSongLibraryForModel,
  makeLocalGenerator,
  makeModelGenerator,
} from "../src/persona/chunhe.js";
import { createLogger } from "../src/util/log.js";

const logger = createLogger("silent");

const OWNER = "OWNER_OPENID_PENDING_0001";
const MEMBER_A = "MEMBER_OPENID_PENDING_AAAA";
const GROUP_1 = "GROUP_OPENID_PENDING_1111";
const GROUP_2 = "GROUP_OPENID_PENDING_2222";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "qqbot-pending-"));
}

function tmpFile(name = "pending-actions.json") {
  return path.join(tmpDir(), name);
}

/** 造一段合法的 tencent SILK_V3，供曲库扫描用（不实际发声音） */
function makeSilk(frames = 30, payload = 8) {
  const chunks = [Buffer.from("\x02#!SILK_V3", "binary")];
  for (let i = 0; i < frames; i += 1) {
    const len = Buffer.alloc(2);
    len.writeUInt16LE(payload);
    chunks.push(len, Buffer.alloc(payload, (i * 7) & 0xff));
  }
  chunks.push(Buffer.alloc(2));
  return Buffer.concat(chunks);
}

function tempLib() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qqbot-pending-lib-"));
  return {
    dir,
    write(file, frames) {
      fs.writeFileSync(path.join(dir, file), makeSilk(frames));
    },
    cleanup() {
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

function fakeApi() {
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
      return [];
    },
  };
}

function makeEngine(env = {}, { generate } = {}) {
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
    QQ_REMINDERS: "false",
    QQ_MULTI_MESSAGE: "false",
    QQ_VOICE_REPLY: "off",
    QQ_SING_ENABLED: "false",
    QQ_PROACTIVE: "false",
    // 这些用例会连续注入几十条消息；限流不是被测对象，别让它截断窗口。
    QQ_RATE_LIMIT_PER_MINUTE: "1000",
    ...env,
  });
  const api = fakeApi();
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
    messageId: `c2c-pending-${seq}`,
    content: text,
    kind: "text",
    attachments: [],
  };
}

function groupMsg(text, { openid = OWNER, gid = GROUP_1, role = "member" } = {}) {
  seq += 1;
  return {
    scope: "group",
    targetId: gid,
    groupOpenid: gid,
    senderId: openid,
    senderName: openid === OWNER ? "群主" : "群友",
    memberRole: role,
    rawEventType: "GROUP_AT_MESSAGE_CREATE",
    messageId: `g-pending-${seq}`,
    content: `<@!123> ${text}`,
    kind: "text",
    attachments: [],
  };
}

const statusOf = (engine, id) => engine.pendingActions.get(id)?.status;
const firstPending = (engine) => engine.pendingActions.list({ ownerId: OWNER })[0];

// ---------------------------------------------------------------------------
// 0) 配置默认值 / 关闭开关
// ---------------------------------------------------------------------------

test("配置：owner 窗口、待办 TTL、曲库上限的默认值可预期", () => {
  const cfg = loadConfig({});
  assert.equal(cfg.ownerHistoryTurns, 20);
  assert.equal(cfg.ownerHistoryMaxChars, 3000);
  assert.equal(cfg.pendingEnabled, true);
  assert.equal(cfg.pendingFile, "data/pending-actions.json");
  assert.equal(cfg.pendingTtlHours, 24);
  assert.equal(cfg.songLibraryLimit, 60);
});

test("关闭开关：QQ_PENDING_ACTIONS=false 时既不创建也不执行", async () => {
  const { engine, api } = makeEngine({ QQ_PENDING_ACTIONS: "false" });
  await engine.handle(c2cMsg("待会在群里卖个萌"));
  assert.equal(engine.pendingActions.pendingCount(OWNER), 0, "关闭后不该创建待办");

  await engine.handle(groupMsg("大家好"));
  assert.ok(!/卖个萌|啾咪/.test(api.sent.at(-1).content), "关闭后不该执行待办");
});

// ---------------------------------------------------------------------------
// 1) 识别：私聊里的「在群里做 X」
// ---------------------------------------------------------------------------

test("待办识别：在群里卖个萌 → cute / any_group", () => {
  const got = parsePendingInstruction("待会在群里卖个萌");
  assert.ok(got, "应识别为待办");
  assert.equal(got.kind, "cute");
  assert.equal(got.target, PENDING_TARGET_ANY_GROUP, "没点名群 → 任意群");
  assert.match(got.action, /卖个萌/);
  assert.equal(got.recurring, false);
  assert.ok(got.expiresAt > Date.now());

  // 真机数据里出现过「买个萌」这个错别字/玩笑写法，也要认
  const typo = parsePendingInstruction("在群里买个萌");
  assert.ok(typo, "「买个萌」也要识别");
  assert.equal(typo.kind, "cute");
});

test("待办识别：唱/说/@/指定群 都能解析", () => {
  const sing = parsePendingInstruction("待会到群里唱《小星星》");
  assert.equal(sing.kind, "sing");
  assert.equal(sing.payload.songName, "小星星");

  const say = parsePendingInstruction("在群里说一句晚安");
  assert.equal(say.kind, "say");
  assert.match(say.payload.text, /晚安/);

  const at = parsePendingInstruction("在群里@张三");
  assert.equal(at.kind, "at");
  assert.equal(at.payload.mention, "张三");

  const specific = parsePendingInstruction(`到群 ${GROUP_2} 里卖个萌`);
  assert.equal(specific.target, `group:${GROUP_2}`);

  // 表情包/贴图不是"说一句话"：交给模型用 send_sticker 工具，别把"表情包"三个字发出去
  const sticker = parsePendingInstruction("在群里发个表情包");
  assert.equal(sticker.kind, "generic");
});

test("待办识别：提问、闲聊、否定、能力问题都不误判", () => {
  const cases = [
    "现在私聊里发的指令能在群聊实现吗",
    "你在群里都聊什么",
    "在群里能做什么",
    "群里有人吗",
    "我会在群里说这件事吗",
    "不要在群里说这个",
    "别在群里喊我",
    "好的",
    "今天天气不错",
  ];
  for (const text of cases) {
    assert.equal(parsePendingInstruction(text), null, `不该识别成待办：${text}`);
  }
});

test("待办识别：以后每次… → recurring（长期规矩，不建一次性待办）", () => {
  const got = parsePendingInstruction("以后每次在群里都卖个萌");
  assert.ok(got);
  assert.equal(got.recurring, true);
});

// ---------------------------------------------------------------------------
// 2) 核心：私聊下指令 → 群聊真正执行
// ---------------------------------------------------------------------------

test("核心：私聊说「在群里卖个萌」→ 群聊时待办被触发并标记 done", async () => {
  const { engine, api, seen } = makeEngine();

  await engine.handle(c2cMsg("待会在群里卖个萌"));
  assert.equal(engine.pendingActions.pendingCount(OWNER), 1, "私聊应生成一条待办");
  assert.match(api.sent.at(-1).content, /卖个萌/, "私聊要明确回执，不能只说空话");
  assert.match(api.sent.at(-1).content, /群/, "回执要说清是在群里做");

  const entry = firstPending(engine);
  assert.equal(entry.status, "pending");
  assert.equal(entry.createdScene, "c2c");
  assert.equal(entry.target, PENDING_TARGET_ANY_GROUP);

  await engine.handle(groupMsg("大家好"));
  const ctx = seen.at(-1);
  assert.ok(ctx.pendingAction, "群聊里应把待办交给这一轮执行");
  assert.equal(ctx.pendingAction.kind, "cute");
  assert.match(api.sent.at(-1).content, /卖个萌|啾咪|萌/, "群里必须真的做出待办");
  assert.equal(statusOf(engine, entry.id), "done", "执行成功后必须标记 done");
});

test("核心：私聊说「在群里唱小星星」→ 群里真的发歌（曲库命中）", async () => {
  const lib = tempLib();
  try {
    lib.write("小星星_绮萱RVC_57s.silk", 40);
    const { engine, api } = makeEngine({
      QQ_SING_ENABLED: "true",
      SING_LIBRARY_DIR: lib.dir,
    });

    await engine.handle(c2cMsg("待会在群里唱小星星"));
    const entry = firstPending(engine);
    assert.equal(entry.kind, "sing");

    await engine.handle(groupMsg("大家好"));
    assert.ok(api.mediaSends.length >= 1, "群里必须真的发出歌声");
    assert.equal(statusOf(engine, entry.id), "done");
  } finally {
    lib.cleanup();
  }
});

test("核心：待办点了一首曲库没有的歌 → 如实说不会，不编歌词，并标记 done", async () => {
  const lib = tempLib();
  try {
    const { engine, api } = makeEngine({
      QQ_SING_ENABLED: "true",
      SING_LIBRARY_DIR: lib.dir,
    });

    await engine.handle(c2cMsg("待会在群里唱青花瓷"));
    const entry = firstPending(engine);
    await engine.handle(groupMsg("大家好"));

    const text = api.sent.at(-1).content;
    assert.match(text, /没学会|不会|没发出去/, "必须如实说不会");
    assert.ok(!/晚风|月光|歌词/.test(text), "绝不许编歌词冒充唱歌");
    assert.equal(statusOf(engine, entry.id), "done", "已如实回应的待办不再反复重试");
  } finally {
    lib.cleanup();
  }
});

test("待办回执：私聊里明确说明已记下，不让她说「大概不行」", async () => {
  const { engine, api } = makeEngine();
  await engine.handle(c2cMsg("待会到群里帮我@张三"));
  const reply = api.sent.at(-1).content;
  assert.match(reply, /群/);
  assert.match(reply, /@?张三/);
  assert.ok(!/大概不行|做不到|没法/.test(reply), `回执绝不能是否定：${reply}`);
});

test("待办执行提示：generic 待办必须明确告诉模型这一轮做什么", async () => {
  const entry = {
    id: "pa_generic",
    action: "问问大家吃饭了没",
    kind: "generic",
    target: PENDING_TARGET_ANY_GROUP,
    status: "pending",
    expiresAt: Date.now() + 3600_000,
  };
  const hint = describePendingActionForModel(entry, { scene: "group" });
  assert.match(hint, /问问大家吃饭了没/, "模型必须知道这一轮要执行的待办内容");
  assert.match(hint, /不要.*做不到|不要说.*做不到|自然.*做到/, "同时要禁止她解释成做不到");

  // 集成：真实模型生成器收到的 system prompt 里必须带这条待办
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
      return new Response(JSON.stringify({ choices: [{ message: { content: "好呀" } }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  });
  await gen({
    text: "大家好",
    scope: "group",
    history: [],
    pendingAction: entry,
    pendingActions: [],
    pendingExecuted: null,
  });
  const sys = String(captured.messages[0].content);
  assert.match(sys, /问问大家吃饭了没/);
  assert.match(sys, /待办/);
});

// ---------------------------------------------------------------------------
// 3) 独立存储：不占 historyTurns 窗口
// ---------------------------------------------------------------------------

test("独立存储：窗口被闲聊挤爆后，待办仍然执行（不占 16 条配额）", async () => {
  const { engine, api } = makeEngine({ QQ_OWNER_HISTORY_TURNS: "2" });
  await engine.handle(c2cMsg("待会在群里卖个萌"));
  const entry = firstPending(engine);

  for (let i = 0; i < 8; i += 1) {
    await engine.handle(c2cMsg(`闲聊第${i}句`));
  }
  assert.ok(
    engine.memory.get(`owner:${OWNER}`).length <= 4,
    "测试前提：owner 窗口确实被挤到很小",
  );
  assert.ok(
    !engine.memory.get(`owner:${OWNER}`).some((m) => m.content.includes("卖个萌")),
    "测试前提：私聊指令已被挤出了会话窗口",
  );

  await engine.handle(groupMsg("在吗"));
  assert.match(api.sent.at(-1).content, /卖个萌|啾咪|萌/);
  assert.equal(statusOf(engine, entry.id), "done", "待办必须独立于窗口存活");
});

test("独立存储：持久化 + 执行后 done 可重新加载", () => {
  const file = tmpFile();
  const s1 = new PendingActionStore({ file, ttlMs: 24 * 3600 * 1000, logger });
  const e = s1.create({
    ownerId: OWNER,
    action: "卖个萌",
    kind: "cute",
    target: PENDING_TARGET_ANY_GROUP,
    createdScene: "c2c",
  });
  s1.flush(true);

  const s2 = new PendingActionStore({ file, ttlMs: 24 * 3600 * 1000, logger });
  assert.equal(s2.pendingCount(OWNER), 1, "重启后待办还在");
  s2.markDone(e.id, { groupOpenid: GROUP_1, result: "ok" });
  s2.flush(true);

  const s3 = new PendingActionStore({ file, ttlMs: 24 * 3600 * 1000, logger });
  assert.equal(s3.get(e.id).status, "done");
  assert.equal(s3.get(e.id).doneGroup, GROUP_1);
  assert.equal(s3.pendingCount(OWNER), 0);
});

test("独立存储：文件损坏时降级为空，不影响启动", () => {
  const file = tmpFile();
  fs.writeFileSync(file, "{ 坏掉的 JSON", "utf8");
  const s = new PendingActionStore({ file, logger });
  assert.equal(s.size, 0);
  const e = s.create({ ownerId: OWNER, action: "卖个萌", kind: "cute" });
  assert.equal(s.get(e.id).status, "pending");
});

// ---------------------------------------------------------------------------
// 4) 过期 / 多群 / 指定群
// ---------------------------------------------------------------------------

test("过期：超过 TTL 的待办自动变为 expired，绝不再执行", async () => {
  const store = new PendingActionStore({ ttlMs: 15, logger });
  const e = store.create({ ownerId: OWNER, action: "卖个萌", kind: "cute" });
  assert.ok(store.match({ ownerId: OWNER, groupOpenid: GROUP_1, fromOwner: true }));

  await sleep(30);
  assert.equal(store.match({ ownerId: OWNER, groupOpenid: GROUP_1, fromOwner: true }), null);
  assert.equal(store.get(e.id).status, "expired");
});

test("多群：any_group 只执行一次（A 群 done 后 B 群不再执行）", async () => {
  const { engine, api } = makeEngine();
  await engine.handle(c2cMsg("待会在群里卖个萌"));
  const entry = firstPending(engine);

  await engine.handle(groupMsg("大家好", { gid: GROUP_1 }));
  assert.match(api.sent.at(-1).content, /卖个萌|啾咪|萌/);
  assert.equal(statusOf(engine, entry.id), "done");

  const before = api.sent.length;
  await engine.handle(groupMsg("大家好", { gid: GROUP_2 }));
  assert.equal(api.sent.length, before + 1, "B 群只应有普通回复");
  assert.ok(!/卖个萌|啾咪/.test(api.sent.at(-1).content), "已完成的待办不能在别的群重复执行");
});

test("多群：指定群 target 只在该群执行（A 群不执行，B 群执行）", async () => {
  const { engine, api } = makeEngine();
  const entry = engine.pendingActions.create({
    ownerId: OWNER,
    action: "卖个萌",
    kind: "cute",
    target: `group:${GROUP_2}`,
    createdScene: "c2c",
  });

  await engine.handle(groupMsg("大家好", { gid: GROUP_1 }));
  assert.equal(statusOf(engine, entry.id), "pending", "A 群不该执行指定给 B 群的待办");
  assert.ok(!/卖个萌|啾咪/.test(api.sent.at(-1).content));

  await engine.handle(groupMsg("大家好", { gid: GROUP_2 }));
  assert.equal(statusOf(engine, entry.id), "done");
  assert.match(api.sent.at(-1).content, /卖个萌|啾咪|萌/);
});

// ---------------------------------------------------------------------------
// 5) owner 窗口：放大但受字符预算约束
// ---------------------------------------------------------------------------

test("owner 窗口：默认 20 轮（40 条），非主人仍是 8 轮（16 条）", async () => {
  const { engine, seen } = makeEngine();
  for (let i = 0; i < 30; i += 1) {
    await engine.handle(c2cMsg(`第${i}轮：${"长".repeat(60)}`));
  }
  assert.equal(engine.memory.get(`owner:${OWNER}`).length, 40, "owner 存储窗口应放大到 40 条");
  const ctx = seen.at(-1);
  assert.equal(ctx.historyLimit, 40);
  assert.ok(ctx.history.length <= 40);

  for (let i = 0; i < 12; i += 1) {
    await engine.handle(c2cMsg(`路人第${i}句`, MEMBER_A));
  }
  assert.equal(engine.memory.get(`c2c:${MEMBER_A}`).length, 16, "非主人窗口保持 8 轮");
});

test("owner 窗口：字符预算封顶，token 估算有上界", async () => {
  const { engine, seen } = makeEngine({
    QQ_OWNER_HISTORY_TURNS: "20",
    QQ_OWNER_HISTORY_MAX_CHARS: "1200",
  });
  for (let i = 0; i < 30; i += 1) {
    await engine.handle(c2cMsg(`第${i}轮：${"长".repeat(100)}`));
  }
  const ctx = seen.at(-1);
  const chars = ctx.history.reduce((n, m) => n + m.content.length, 0);
  assert.ok(chars <= 1200, `字符预算必须生效，实际 ${chars}`);
  // 保守估算：中文按 1 token/字，另加每条消息约 4 token 的 role 开销
  const estimatedTokens = chars + ctx.history.length * 4;
  assert.ok(estimatedTokens <= 1400, `token 估算应有上界，实际约 ${estimatedTokens}`);
});

test("owner 窗口：模型生成器按 ctx.historyLimit 切片，而不是固定 16 条", async () => {
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

  const history = Array.from({ length: 40 }, (_, i) => ({
    role: i % 2 === 0 ? "user" : "assistant",
    content: `历史第${i}条`,
  }));
  await gen({ text: "在吗", history, historyLimit: 40 });
  assert.equal(captured.messages.length, 42, "system + 40 条历史 + 当前消息");
});

// ---------------------------------------------------------------------------
// 6) 禁止「凭空断定做不到」+ 清理历史里的错误自述
// ---------------------------------------------------------------------------

test("人格规则：明确禁止凭空断定做不到，并点出错误示范", () => {
  const p = CHUNHE_SYSTEM_PROMPT;
  assert.match(p, /不要凭空|不许凭空|禁止凭空/, "必须有禁止凭空判断的硬规则");
  assert.match(p, /大概不行/, "要点名真实出现过的错误说法");
  assert.match(p, /实际试一次|我不确定，我试试|查.*清单/, "要给出正确做法");
  assert.match(p, /不能.*猜.*当.*结论|绝不把.*猜.*记进记忆/, "禁止把猜测写进记忆");
  assert.match(p, /跨场景待办|待办/, "应告知模型：私聊交代的群聊待办会被执行");
});

test("能力否认探测：跨场景「大概不行」必须被抓到", () => {
  const real =
    "大概不行哦，主人～私聊里说的指令，春禾只会在这个私聊窗口里照做，比如提醒、唱歌；" +
    "想让它发生在群里，比如在群里唱歌、@某个人，还得在群里说一声，私聊这边没法替你往群里转发消息 🌱";
  assert.ok(detectCapabilityDenial(real).length > 0, "真实错误回答必须能被探测到");

  const real2 =
    "主人得到群里 @ 春禾一下，或者喊声名字，春禾就在群里卖给你看～ 私聊这边没法把话传到群里去呀 🌸";
  assert.ok(detectCapabilityDenial(real2).length > 0, "改写过的那条错误自述也要能探测到");

  const real3 = "春禾这边看不到完整的曲库清单，主人直接点一首试试～";
  assert.ok(detectCapabilityDenial(real3).length > 0, "「看不到曲库清单」也是能力否认");

  const fine = [
    "能的，主人。你在私聊里交代的群聊待办，春禾记着呢，到群里就做～",
    "春禾不确定这首歌的歌词，先试试唱，唱不了会如实说。",
  ];
  for (const text of fine) {
    assert.equal(detectCapabilityDenial(text).length, 0, `不该误报：${text}`);
  }
});

test("记忆清理：owner 会话里的错误自述被移除，其他会话不受影响", () => {
  const file = path.join(tmpDir(), "memory.json");
  const bad =
    "大概不行哦，主人～私聊里说的指令，春禾只会在这个私聊窗口里照做，私聊这边没法替你往群里转发消息 🌱";
  const bad2 =
    "主人得到群里 @ 春禾一下，或者喊声名字，春禾就在群里卖给你看～ 私聊这边没法把话传到群里去呀 🌸";
  const badSong = "春禾这边看不到完整的曲库清单，主人直接点一首试试，能唱就唱给你听～🌱";
  const sessions = {
    [`owner:${OWNER}`]: [
      { role: "user", content: "现在私聊里发的指令能在群聊实现吗" },
      { role: "assistant", content: bad },
      { role: "user", content: "在吗" },
      { role: "assistant", content: "在的" },
      { role: "assistant", content: badSong },
    ],
    [`c2c:${OWNER}`]: [
      { role: "user", content: "旧问题" },
      { role: "assistant", content: bad },
      { role: "user", content: "旧正常" },
      { role: "assistant", content: "旧正常回答" },
      { role: "assistant", content: bad2 },
    ],
    [`c2c:${MEMBER_A}`]: [
      { role: "user", content: "别人" },
      { role: "assistant", content: bad },
    ],
  };
  fs.writeFileSync(file, JSON.stringify({ version: 2, sessions }), "utf8");

  const m = new MemoryStore({ maxTurns: 8, ownerMaxTurns: 20, file, logger });
  assert.ok(MISLEADING_DENIAL_PATTERNS.length > 0);
  const removed = m.purgeMisleadingDenials([OWNER]);
  assert.equal(removed, 4, "跨场景错误自述 + 曲库错误自述都要清");
  assert.ok(!m.get(`owner:${OWNER}`).some((x) => x.content.includes("私聊这边没法")));
  assert.ok(!m.get(`owner:${OWNER}`).some((x) => x.content.includes("看不到完整的曲库清单")));
  assert.ok(!m.get(`c2c:${OWNER}`).some((x) => x.content.includes("没法把话传到群里")));
  assert.ok(m.get(`c2c:${OWNER}`).some((x) => x.content === "旧正常回答"), "正常内容不能误伤");
  assert.equal(m.get(`c2c:${MEMBER_A}`).length, 2, "非主人会话保持原样");
  assert.ok(
    !m.getForModel(`owner:${OWNER}`).some((x) => x.content.includes("大概不行")),
    "即便漏网，送模型前也必须过滤",
  );
});

test("记忆清理：引擎启动时自动执行，无需人工改文件", () => {
  const dir = tmpDir();
  const file = path.join(dir, "memory.json");
  const bad = "大概不行哦，私聊里说的指令，春禾只会在这个私聊窗口里照做，私聊这边没法替你往群里转发消息";
  fs.writeFileSync(
    file,
    JSON.stringify({
      version: 2,
      sessions: {
        [`owner:${OWNER}`]: [
          { role: "user", content: "现在私聊里发的指令能在群聊实现吗" },
          { role: "assistant", content: bad },
        ],
      },
    }),
    "utf8",
  );

  const config = loadConfig({
    QQ_APP_ID: "1",
    QQ_APP_SECRET: "s",
    QQ_ADMIN_USERS: OWNER,
    QQ_MEMORY_FILE: file,
    QQ_TOPIC_FILE: path.join(dir, "topics.json"),
    QQ_OWNER_MEMORY_FILE: path.join(dir, "owner-memory.json"),
    QQ_PENDING_FILE: path.join(dir, "pending.json"),
    QQ_REMINDERS: "false",
    QQ_SING_ENABLED: "false",
    QQ_MULTI_MESSAGE: "false",
  });
  const engine = new MessageEngine({
    config,
    api: fakeApi(),
    generate: async () => "在的",
    logger,
  });
  assert.ok(
    !engine.memory.get(`owner:${OWNER}`).some((x) => x.content.includes("私聊这边没法")),
    "引擎构造时就应清掉错误自述",
  );
});

test("长期规矩：以后每次在群里卖萌 → 记进长期记忆，不建一次性待办", async () => {
  const { engine, api } = makeEngine();
  await engine.handle(c2cMsg("以后每次在群里都卖个萌"));
  assert.equal(engine.pendingActions.pendingCount(OWNER), 0, "反复发生的事不该当一次性待办");
  assert.ok(
    engine.ownerMemory.list().some((f) => /每次.*卖个萌/.test(f.text)),
    "应记进长期记忆，群里每轮都能看到",
  );
  assert.match(api.sent.at(-1).content, /长期|记住|规矩/);
});

// ---------------------------------------------------------------------------
// 7) 曲库清单：她要能直接列出来
// ---------------------------------------------------------------------------

test("曲库：主人问「会哪些歌」时，清单被注入上下文", async () => {
  const lib = tempLib();
  try {
    lib.write("小半_绮萱RVC_57s.silk", 20);
    lib.write("樱花草_绮萱RVC_57s.silk", 20);
    lib.write("送别_绮萱RVC_57s.silk", 20);
    const { engine, seen } = makeEngine({
      QQ_SING_ENABLED: "true",
      SING_LIBRARY_DIR: lib.dir,
    });

    await engine.handle(c2cMsg("现在你会哪些歌"));
    const ctx = seen.at(-1);
    assert.ok(Array.isArray(ctx.songLibrary) && ctx.songLibrary.length === 3, "应注入曲库清单");
    for (const name of ["小半", "樱花草", "送别"]) {
      assert.ok(ctx.songLibrary.includes(name), `清单应包含 ${name}`);
    }
  } finally {
    lib.cleanup();
  }
});

test("曲库：问「樱花草会吗」也能拿到清单（不再说看不到）", async () => {
  const lib = tempLib();
  try {
    lib.write("樱花草_绮萱RVC_57s.silk", 20);
    const { engine, seen } = makeEngine({
      QQ_SING_ENABLED: "true",
      SING_LIBRARY_DIR: lib.dir,
    });
    await engine.handle(groupMsg("樱花草会吗"));
    assert.deepEqual(seen.at(-1).songLibrary, ["樱花草"]);
  } finally {
    lib.cleanup();
  }
});

test("曲库：提示词与注入文案明确「按清单回答」", () => {
  assert.match(CHUNHE_SYSTEM_PROMPT, /曲库/, "人格提示词应提到曲库");
  assert.match(CHUNHE_SYSTEM_PROMPT, /看不到.*曲库|曲库.*看不到/, "应点名这条错误说法");
  const hint = describeSongLibraryForModel(["小半", "樱花草"]);
  assert.match(hint, /小半/);
  assert.match(hint, /樱花草/);
  assert.match(hint, /不要.*看不到|不要再说/, "必须禁止「看不到曲库」");
});

test("曲库：本地规则模式也能直接报出清单", async () => {
  const gen = makeLocalGenerator({});
  const reply = await gen({ text: "你会哪些歌", songLibrary: ["小半", "樱花草"] });
  assert.match(reply, /小半/);
  assert.match(reply, /樱花草/);
});

test("曲库：模型提示词里带清单", async () => {
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
      return new Response(JSON.stringify({ choices: [{ message: { content: "有这些哦" } }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  });
  await gen({ text: "你会哪些歌", history: [], songLibrary: ["小半", "樱花草"] });
  const sys = String(captured.messages[0].content);
  assert.match(sys, /曲库/);
  assert.match(sys, /小半/);
  assert.match(sys, /樱花草/);
});

// ---------------------------------------------------------------------------
// 8) 安全隔离：非主人完全看不到待办 / 主人记忆
// ---------------------------------------------------------------------------

test("隔离：非主人在群里既不触发待办，也看不到待办", async () => {
  const { engine, api, seen } = makeEngine();
  await engine.handle(c2cMsg("待会在群里卖个萌"));
  const entry = firstPending(engine);
  const before = api.sent.length;

  await engine.handle(groupMsg("大家好", { openid: MEMBER_A }));
  const ctx = seen.at(-1);
  assert.equal(ctx.isOwnerUser, false);
  assert.equal(ctx.pendingAction, null, "非主人不能拿到待办执行权");
  assert.deepEqual(ctx.pendingActions, [], "非主人不能看到主人的待办");
  assert.deepEqual(ctx.ownerMemory, [], "非主人不能看到主人长期记忆");
  assert.equal(api.sent.length, before + 1, "只发普通回复");
  assert.ok(!/卖个萌|啾咪/.test(api.sent.at(-1).content));
  assert.equal(statusOf(engine, entry.id), "pending", "待办不能被非主人消耗");
});

// ---------------------------------------------------------------------------
// 9) 「发」类动作：真机 2026-10-17 22:22 把「群里发下」解析成动作「发下」，
//    然后真的往群里发了一条叫「发下」的消息。动词残片绝不能当内容发出去。
// ---------------------------------------------------------------------------

test("待办识别：发类动作要结合常识——「群里发下」= 发表情包，不是发「发下」", () => {
  const fragment = parsePendingInstruction("群里发下");
  assert.ok(fragment, "「群里发下」是一个指令");
  assert.equal(fragment.payload?.sticker, true, "应解析成发表情包");
  assert.ok(
    !/^(?:发下|发一下|发个|发表情)$/.test(fragment.action),
    `动作名不能是动词残片：${fragment.action}`,
  );

  for (const text of ["在群里发个表情包", "群里发表情", "群里发个贴图"]) {
    const got = parsePendingInstruction(text);
    assert.ok(got, `应识别：${text}`);
    assert.equal(got.payload?.sticker, true, `应解析成贴纸：${text}`);
  }

  const say = parsePendingInstruction("在群里发个消息说该开会了");
  assert.ok(say);
  assert.equal(say.kind, "say");
  assert.equal(say.payload.text, "该开会了");

  // 只说「发一下/发个」——不知道发什么，必须先问清楚，不能盲发
  for (const text of ["群里发一下", "群里发个"]) {
    const vague = parsePendingInstruction(text);
    assert.ok(vague, `仍要记下来问清楚：${text}`);
    assert.equal(vague.needsConfirm, true, `模糊时必须先问清楚：${text}`);
  }
});

test("待办识别：「群里发下」不再往群里发一条叫「发下」的消息，而是真的发贴纸", async () => {
  const { engine, api, dir } = makeEngine({ QQ_PENDING_DELIVERY: "proactive" });
  // 临时素材目录，避免依赖开发机上的 assets/stickers
  const stickerDir = path.join(dir, "stickers");
  fs.mkdirSync(stickerDir, { recursive: true });
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
  fs.writeFileSync(path.join(stickerDir, "春禾-卖萌,春禾-撒娇.png"), bytes);
  engine.config.stickers = { enabled: true, dir: stickerDir, maxBytes: 2 * 1024 * 1024 };
  engine.groups.observe({ groupOpenid: GROUP_1, senderOpenid: OWNER });
  engine.groups.observe({ groupOpenid: GROUP_1, senderOpenid: MEMBER_A });

  await engine.handle(c2cMsg("群里发下"));

  // 主动投递成功后会立刻 markDone，所以要连已完成的一起查
  const entry = engine.pendingActions.listAll().at(-1);
  assert.ok(entry, "应记下待办");
  assert.equal(entry.payload?.sticker, true, "待办应是发贴纸");
  assert.ok(!/^发下$/.test(entry.action), `动作名不能是「发下」：${entry.action}`);

  assert.equal(api.mediaUploads.length, 1, "应真的上传了一张表情包");
  assert.equal(api.mediaUploads[0].scope, "group", "应发到群里，不是私聊");
  assert.equal(api.mediaUploads[0].targetId, GROUP_1);
  assert.equal(api.mediaUploads[0].fileType, 1, "表情包就是图片 file_type=1");
  assert.deepEqual(api.mediaUploads[0].buf, bytes);
  assert.equal(api.mediaSends.length, 1);
  assert.equal(api.mediaSends[0].scope, "group");

  for (const item of api.sent) {
    assert.ok(!/^发下$/.test(String(item.content).trim()), `绝不能发「发下」：${item.content}`);
  }
});

test("隔离：非主人私聊看不到待办；不传 ownerId 的查询返回空", async () => {
  const { engine, seen } = makeEngine();
  await engine.handle(c2cMsg("待会在群里卖个萌"));
  await engine.handle(c2cMsg("你好", MEMBER_A));

  assert.deepEqual(seen.at(-1).pendingActions, []);
  assert.equal(seen.at(-1).pendingAction, null);
  assert.deepEqual(engine.pendingActions.list({}), []);
  assert.deepEqual(engine.pendingActions.list({ ownerId: MEMBER_A }), []);
});
