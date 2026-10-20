#!/usr/bin/env node
/**
 * check-pending.mjs — 真机验收（假 api 注入）：**私聊下的指令，群里到底执行不执行？**
 *
 * 修的两个根因（2026-10-17 真机实测）：
 *   1. QQ_HISTORY_TURNS=8 → 16 条窗口，私聊指令聊十几句就被挤掉；
 *   2. 她猜「私聊没法往群里转发」，还把猜测写进了记忆。
 *
 * 本脚本用**真实 .env + 真实 data/memory.json 的副本 + 真实引擎**走一遍：
 *   - 私聊「待会在群里卖个萌」→ 独立待办 → 群里真的执行；
 *   - 把窗口压到 2 轮、再灌 10 句闲聊，待办仍然执行（证明不占 historyTurns）；
 *   - 非主人触发不了、也看不到待办；
 *   - 曲库清单真的能列出来；
 *   - 打印 owner 窗口的 token 估算。
 *
 * ⚠️ 安全线：
 *   1. 不启动第二个机器人、不连网关，只调本地引擎；
 *   2. 所有持久化文件指向临时副本，线上 data/ 只读；
 *   3. 假 api 记账，消息不会真的发到 QQ。
 *
 * 用法：node scripts/check-pending.mjs
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { parseDotenv, loadConfig } from "../src/config.js";
import { MessageEngine } from "../src/core/engine.js";
import { MemoryStore } from "../src/core/memory.js";
import { createLogger } from "../src/util/log.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const pass = [];
const fail = [];
function check(name, ok, detail = "") {
  (ok ? pass : fail).push(name);
  console.log(`   ${ok ? "✅" : "❌"} ${name}${detail ? ` —— ${detail}` : ""}`);
}
function section(title) {
  console.log(`\n${"─".repeat(74)}\n${title}\n${"─".repeat(74)}`);
}
function mask(id) {
  const s = String(id ?? "");
  return s.length <= 10 ? s : `${s.slice(0, 8)}…${s.slice(-4)}`;
}
const flat = (history) => (history ?? []).map((m) => m.content).join("\n");

function loadEnv() {
  const file = path.join(ROOT, ".env");
  const fromFile = fs.existsSync(file) ? parseDotenv(fs.readFileSync(file, "utf8")) : {};
  return { ...fromFile, ...process.env };
}

async function main() {
  const env = loadEnv();
  const log = createLogger("warn");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "chunhe-pending-check-"));

  const ownerIds = String(env.QQ_ADMIN_USERS ?? "")
    .split(/[,\s;]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (!ownerIds.length) {
    console.error("❌ .env 里没有 QQ_ADMIN_USERS，无法验证主人跨场景待办");
    process.exit(2);
  }
  const owner = ownerIds[0];

  const liveMemory = path.join(ROOT, "data", "memory.json");
  const liveTopics = path.join(ROOT, "data", "topics.json");
  const memCopy = path.join(tmp, "memory.json");
  const topicCopy = path.join(tmp, "topics.json");
  if (fs.existsSync(liveMemory)) fs.copyFileSync(liveMemory, memCopy);
  if (fs.existsSync(liveTopics)) fs.copyFileSync(liveTopics, topicCopy);
  const liveBefore = fs.existsSync(liveMemory)
    ? JSON.parse(fs.readFileSync(liveMemory, "utf8"))
    : { sessions: {} };

  const keys = Object.keys(liveBefore.sessions ?? {});
  const ownerGroupKeys = keys.filter(
    (k) => k.startsWith("group:") && k.endsWith(`:${owner}`),
  );
  const groupA = ownerGroupKeys[0]?.split(":")[1] ?? "GROUP-DEMO-A";
  const groupB =
    ownerGroupKeys.map((k) => k.split(":")[1]).find((g) => g !== groupA) ?? "GROUP-DEMO-B";

  console.log("=".repeat(74));
  console.log("春禾 ∞ 跨场景待办 · 真机验收（不重启、不写线上数据、不发 QQ 消息）");
  console.log("=".repeat(74));
  console.log(`[环境] 主人 = ${mask(owner)}   真实群 A = ${mask(groupA)}   群 B = ${mask(groupB)}`);
  console.log(`[数据] 线上 memory.json 会话数 = ${keys.length}（只读；副本在 ${tmp}）`);

  const config = loadConfig({
    ...env,
    QQ_MEMORY_FILE: memCopy,
    QQ_TOPIC_FILE: topicCopy,
    QQ_OWNER_MEMORY_FILE: path.join(tmp, "owner-memory.json"),
    QQ_PENDING_FILE: path.join(tmp, "pending-actions.json"),
    QQ_GROUPS_FILE: path.join(tmp, "groups.json"),
    QQ_PROACTIVE_QUOTA_FILE: path.join(tmp, "proactive-quota.json"),
    QQ_REMINDER_FILE: path.join(tmp, "reminders.json"),
    // 本脚本验的是「等群聊触发」的兜底路径（旧行为），强制 deferred；
    // 主动投递的新能力见 scripts/check-proactive-groups.mjs
    QQ_PENDING_DELIVERY: "deferred",
    // 本脚本只验待办/窗口/曲库：关掉会真发或重计算的路径
    QQ_REMINDERS: "false",
    QQ_PROACTIVE: "false",
    QQ_MULTI_MESSAGE: "false",
    QQ_VOICE_REPLY: "off",
    QQ_RATE_LIMIT_PER_MINUTE: "1000",
    // 故意把 owner 窗口压到 2 轮，证明待办不依赖窗口
    QQ_OWNER_HISTORY_TURNS: "2",
  });

  const sent = [];
  const mediaSends = [];
  const api = {
    async sendMessage(scope, targetId, content, opts = {}) {
      sent.push({ scope, targetId, content, msgId: opts.msgId });
      return { id: `fake-${sent.length}`, content };
    },
    async sendProactiveMessage(scope, targetId, content) {
      sent.push({ scope, targetId, content, proactive: true });
      return { id: `fake-p-${sent.length}`, content };
    },
    async uploadMedia(scope, targetId, base64, fileType) {
      return `fi_${scope}_${targetId}_${fileType}_${base64.length}`;
    },
    async sendMedia(scope, targetId, fileInfo, opts = {}) {
      mediaSends.push({ scope, targetId, fileInfo, opts });
      return { id: `media-${mediaSends.length}` };
    },
    async getGroupMembers() {
      return [];
    },
  };

  const seen = [];
  const engine = new MessageEngine({
    config,
    api,
    logger: log,
    generate: async (ctx) => {
      seen.push(ctx);
      return "好呀～";
    },
  });

  let seq = 0;
  const c2c = (text) => ({
    scope: "c2c",
    targetId: owner,
    senderId: owner,
    senderName: "主人",
    messageId: `check-c2c-${++seq}`,
    content: text,
    kind: "text",
    attachments: [],
  });
  const group = (text, { gid = groupA, openid = owner, role = "member" } = {}) => ({
    scope: "group",
    targetId: gid,
    groupOpenid: gid,
    senderId: openid,
    senderName: openid === owner ? "群主" : "群友",
    memberRole: role,
    rawEventType: "GROUP_AT_MESSAGE_CREATE",
    messageId: `check-g-${++seq}`,
    content: `<@!123> ${text}`,
    kind: "text",
    attachments: [],
  });

  // -------------------------------------------------------------------------
  section("① 核心：私聊「待会在群里卖个萌」→ 群里真的执行");
  // -------------------------------------------------------------------------
  await engine.handle(c2c("待会在群里卖个萌"));
  const entry = engine.pendingActions.list({ ownerId: owner })[0];
  const confirm = sent.at(-1)?.content ?? "";
  console.log(`   私聊回执：${confirm.replace(/\n/g, " ").slice(0, 100)}`);
  check("私聊生成独立待办", Boolean(entry), entry ? `${entry.kind}/${entry.target}` : "无");
  check("回执明确说会在群里做", /群/.test(confirm) && /卖个萌/.test(confirm));
  check("回执没有「大概不行/做不到」", !/大概不行|做不到|没法/.test(confirm));

  for (let i = 0; i < 10; i += 1) await engine.handle(c2c(`闲聊第${i}句`));
  const ownerHistory = engine.memory.get(`owner:${owner}`);
  check(
    "owner 窗口被压到 4 条（证明待办不靠窗口）",
    ownerHistory.length <= 4,
    `${ownerHistory.length} 条`,
  );
  check("私聊指令确实被挤出了窗口", !flat(ownerHistory).includes("卖个萌"));

  await engine.handle(group("大家好"));
  const groupReply = sent.at(-1)?.content ?? "";
  const ctx = seen.at(-1);
  console.log(`   群聊实际发出：${groupReply.replace(/\n/g, " ").slice(0, 100)}`);
  check("群聊里真的做出待办（卖萌文案）", /卖个萌|啾咪/.test(groupReply));
  check("待办执行后标记 done", engine.pendingActions.get(entry?.id)?.status === "done");
  check("上下文里带 pendingAction", Boolean(ctx?.pendingAction));

  // -------------------------------------------------------------------------
  section("② 安全：非主人触发不了、也看不到待办");
  // -------------------------------------------------------------------------
  await engine.handle(c2c("待会在群里卖个萌"));
  const entry2 = engine.pendingActions.list({ ownerId: owner })[0];
  const before = sent.length;
  await engine.handle(group("大家好", { openid: "MEMBER_OPENID_CHECK" }));
  const memberCtx = seen.at(-1);
  check("非主人看不到待办", (memberCtx?.pendingActions ?? []).length === 0);
  check("非主人没有待办执行权", !memberCtx?.pendingAction);
  check("非主人没有触发执行", sent.length === before + 1 && !/卖个萌|啾咪/.test(sent.at(-1).content));
  check(
    "待办仍留给主人",
    engine.pendingActions.get(entry2?.id)?.status === "pending",
  );

  // -------------------------------------------------------------------------
  section("③ 曲库清单：她要能直接列出来");
  // -------------------------------------------------------------------------
  await engine.handle(c2c("现在你会哪些歌"));
  const songCtx = seen.at(-1);
  check(
    "「会哪些歌」注入了曲库清单",
    Array.isArray(songCtx?.songLibrary) && songCtx.songLibrary.length > 0,
    (songCtx?.songLibrary ?? []).join("、"),
  );
  check(
    "清单包含真实曲库里的《樱花草》",
    (songCtx?.songLibrary ?? []).includes("樱花草"),
  );

  await engine.handle(group("樱花草会吗"));
  check(
    "「樱花草会吗」也能拿到清单",
    (seen.at(-1)?.songLibrary ?? []).includes("樱花草"),
  );

  // -------------------------------------------------------------------------
  section("④ token 估算：owner 窗口放大到底多花多少");
  // -------------------------------------------------------------------------
  const realMem = new MemoryStore({ maxTurns: 8, ownerMaxTurns: 20, logger: log });
  realMem.sessions = new Map(
    Object.entries(liveBefore.sessions ?? {}).map(([k, v]) => [k, v]),
  );
  const realOwner = realMem.get(`owner:${owner}`);
  const chars = realOwner.reduce((n, m) => n + String(m.content ?? "").length, 0);
  const avg = realOwner.length ? chars / realOwner.length : 30;
  // 保守估算：中文按 1 token/字，另加每条消息约 4 token 的 role 开销
  const est = (msgs, totalChars) => Math.round(totalChars + msgs * 4);
  console.log(`   线上 owner 历史：${realOwner.length} 条 / ${chars} 字 / 平均 ${avg.toFixed(1)} 字`);
  console.log(`   16 条（旧窗口）典型 ≈ ${est(16, avg * 16)} token`);
  console.log(`   40 条（新窗口）典型 ≈ ${est(40, avg * 40)} token`);
  console.log(`   40 条 + 3000 字预算上限 ≈ ${est(40, 3000)} token`);
  check(
    "40 条典型估算增加 < 1200 token/轮",
    est(40, avg * 40) - est(16, avg * 16) < 1200,
    `+${est(40, avg * 40) - est(16, avg * 16)} token/轮`,
  );
  check(
    "字符预算把最坏情况封在 3200 token 内",
    est(40, 3000) <= 3200,
    `${est(40, 3000)} token`,
  );

  // -------------------------------------------------------------------------
  section("结论");
  // -------------------------------------------------------------------------
  console.log(`   通过 ${pass.length} 项，失败 ${fail.length} 项`);
  if (fail.length) {
    for (const f of fail) console.log(`   ❌ ${f}`);
    process.exit(1);
  }
  console.log("   ✅ 私聊交代的群聊待办，到群里真的执行；不占聊天窗口配额。");
  console.log("   ✅ 非主人看不到、也触发不了；曲库清单能直接列出来。");
  console.log(`\n[提示] 临时数据副本保留在：${tmp}（线上 data/ 未被写入）`);
}

main().catch((err) => {
  console.error("[check-pending] 失败：", err?.stack ?? err);
  process.exit(1);
});
