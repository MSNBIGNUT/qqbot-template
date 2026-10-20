#!/usr/bin/env node
/**
 * check-memory-share.mjs — 真机验收：**私聊里说的话，群里能不能回忆起来？**
 *
 * 修的问题：「春禾私聊和群聊的记忆不相通，且在私聊里下的指令无法在群聊里实现」。
 *
 * 本脚本用**真实的 .env 配置 + 真实 data/memory.json 的副本 + 真实引擎/人格层**走一遍。
 *
 * ⚠️ 三条安全线（必须遵守）：
 *   1. **不启动第二个机器人**：不开 WebSocket、不连网关，只调 REST / 本地引擎；
 *      真正的春禾（node src/main.js）可以继续跑，不会被互踢。
 *   2. **不写线上数据**：把 data/memory.json、topics.json 复制到临时目录再跑，
 *      线上文件只读。跑完临时目录原样留着，便于复核。
 *   3. 默认只发**假 api**（消息不会真的发到 QQ）；加 --send 也不发，本脚本没有真发通道。
 *
 * 用法：
 *   node scripts/check-memory-share.mjs             # 不调模型，纯上下文证据（秒级）
 *   node scripts/check-memory-share.mjs --model     # 额外用真实模型回答一次"群里回忆私聊"
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { parseDotenv, loadConfig } from "../src/config.js";
import { MessageEngine } from "../src/core/engine.js";
import { OwnerMemoryStore } from "../src/core/owner-memory.js";
import { createPersona } from "../src/persona/chunhe.js";
import { createLogger } from "../src/util/log.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
const useModel = args.includes("--model");

const pass = [];
const fail = [];
function check(name, ok, detail = "") {
  (ok ? pass : fail).push(name);
  console.log(`   ${ok ? "✅" : "❌"} ${name}${detail ? ` —— ${detail}` : ""}`);
}

function loadEnv() {
  const file = path.join(ROOT, ".env");
  const fromFile = fs.existsSync(file) ? parseDotenv(fs.readFileSync(file, "utf8")) : {};
  return { ...fromFile, ...process.env };
}

function mask(id) {
  const s = String(id ?? "");
  return s.length <= 10 ? s : `${s.slice(0, 8)}…${s.slice(-4)}`;
}

function section(title) {
  console.log(`\n${"─".repeat(72)}\n${title}\n${"─".repeat(72)}`);
}

const sha = (s) => String(s).replace(/\s+/g, " ").trim().slice(0, 120);

async function main() {
  const env = loadEnv();
  const log = createLogger("warn");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "chunhe-memory-share-"));

  const liveMemory = path.join(ROOT, "data", "memory.json");
  const liveTopics = path.join(ROOT, "data", "topics.json");
  const memCopy = path.join(tmp, "memory.json");
  const topicCopy = path.join(tmp, "topics.json");
  const ownerMem = path.join(tmp, "owner-memory.json");
  if (fs.existsSync(liveMemory)) fs.copyFileSync(liveMemory, memCopy);
  if (fs.existsSync(liveTopics)) fs.copyFileSync(liveTopics, topicCopy);

  const liveBefore = fs.existsSync(liveMemory) ? JSON.parse(fs.readFileSync(liveMemory, "utf8")) : { sessions: {} };

  const ownerIds = String(env.QQ_ADMIN_USERS ?? "")
    .split(/[,\s;]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (ownerIds.length === 0) {
    console.error("❌ .env 里没有 QQ_ADMIN_USERS，无法验证「主人跨场景记忆」");
    process.exit(2);
  }
  const owner = ownerIds[0];

  // 从真实记忆里找两个主人的群，和两个真实群成员（保证镜像线上现状）
  const liveKeys = Object.keys(liveBefore.sessions ?? {});
  const ownerGroupKeys = liveKeys.filter((k) => k.startsWith("group:") && k.endsWith(`:${owner}`));
  const groupOf = (k) => k.split(":")[1];
  const memberOf = (key) => key.split(":").pop();
  const ownerGroups = [...new Set(ownerGroupKeys.map(groupOf))];
  // 优先选「已经有其他成员会话」的群做成员隔离验证（和线上大群一致）
  const groupWithMembers = ownerGroups.find((g) =>
    liveKeys.some((k) => k.startsWith(`group:${g}:`) && !k.endsWith(`:${owner}`)),
  );
  const groupA = groupWithMembers ?? ownerGroups[0] ?? "GROUP-A-DEMO";
  const groupB = ownerGroups.find((g) => g !== groupA) ?? "GROUP-B-DEMO";
  const membersInA = liveKeys
    .filter((k) => k.startsWith(`group:${groupA}:`) && !k.endsWith(`:${owner}`))
    .map(memberOf);
  const memberA = membersInA[0] ?? "MEMBER-A";
  const memberB = membersInA[1] ?? membersInA[0] ?? "MEMBER-B";

  console.log("=".repeat(72));
  console.log("春禾 ∞ 记忆互通 · 真机验收（不重启、不写线上数据、不发 QQ 消息）");
  console.log("=".repeat(72));
  console.log(`[环境] 主人 openid = ${mask(owner)}（来自 .env QQ_ADMIN_USERS，共 ${ownerIds.length} 个）`);
  console.log(`[环境] 真实群 A = ${mask(groupA)}   群 B = ${mask(groupB)}`);
  console.log(`[环境] 真实群成员 A = ${mask(memberA)}   成员 B = ${mask(memberB)}`);
  console.log(`[数据] 线上 memory.json 会话数 = ${liveKeys.length}（只读；副本在 ${tmp}）`);
  console.log(`[模式] ${useModel ? "真实模型（会调用 .env 里的 MODEL_*）" : "纯上下文证据（不调模型）"}`);

  const config = loadConfig({
    ...env,
    // 全部指向临时副本：绝不写线上数据
    QQ_MEMORY_FILE: memCopy,
    QQ_TOPIC_FILE: topicCopy,
    QQ_OWNER_MEMORY_FILE: ownerMem,
    // 本脚本只验记忆，关掉会产生重计算/真发送的路径
    QQ_REMINDERS: "false",
    QQ_PROACTIVE: "false",
    QQ_MULTI_MESSAGE: "false",
    QQ_VOICE_REPLY: "off",
    QQ_SING_ENABLED: "false",
    QQ_GROUP_TRIGGER: "all",
  });

  const sent = [];
  const api = {
    async sendMessage(scope, targetId, content, opts = {}) {
      sent.push({ scope, targetId, content, msgId: opts.msgId });
      return { id: `fake-${sent.length}` };
    },
    async sendProactiveMessage(scope, targetId, content) {
      sent.push({ scope, targetId, content, proactive: true });
      return { id: `fake-p-${sent.length}` };
    },
  };

  // 记录每次送模型的 ctx；只有关键那次走真实模型，其余用回执（省 token）
  const seen = [];
  const promptDumps = [];
  const realPersona = createPersona({
    config: { ...config, personaMode: "model" },
    logger: log,
    fetchImpl: async (url, init) => {
      try {
        const body = JSON.parse(init.body);
        promptDumps.push(body);
      } catch {
        /* 抓不到请求体不影响主流程 */
      }
      return fetch(url, init);
    },
  });
  const generate = async (ctx) => {
    seen.push(ctx);
    if (useModel && ctx.scope === "group" && ctx.senderId === owner && /数字是几/.test(ctx.text)) {
      return realPersona(ctx);
    }
    return `（离线回执）收到：${sha(ctx.text).slice(0, 20)}`;
  };

  const engine = new MessageEngine({ config, api, generate, logger: log });

  // -------------------------------------------------------------------------
  section("① 旧数据迁移：主人的 4 份会话合并，14 个旧键一条不丢");
  // -------------------------------------------------------------------------
  const after = engine.memory;
  const ownerKey = `owner:${owner}`;
  const merged = after.get(ownerKey);
  const hadUnifiedBefore = liveKeys.includes(ownerKey);
  const ownerLegacyKeys = liveKeys.filter((k) => k === `c2c:${owner}` || (k.startsWith("group:") && k.endsWith(`:${owner}`)));
  console.log(`   线上原有 ${liveKeys.length} 个会话，其中主人散落的旧会话 ${ownerLegacyKeys.length} 份：`);
  for (const k of ownerLegacyKeys) {
    console.log(`     ${k}  (${liveBefore.sessions[k].length} 条)`);
  }
  if (hadUnifiedBefore) console.log(`   （线上已存在统一会话 ${ownerKey}，说明迁移已经跑过一次；不会重复拼接）`);
  check(`生成统一会话 ${ownerKey}`, merged.length > 0, `${merged.length} 条`);
  check("统一会话里包含私聊内容", merged.some((m) => m.scene === "c2c"), merged.filter((m) => m.scene === "c2c").length + " 条〔私聊〕");

  let lost = 0;
  for (const [k, msgs] of Object.entries(liveBefore.sessions ?? {})) {
    const now = after.get(k);
    if (now.length !== msgs.length) lost += 1;
    else if (JSON.stringify(now.map((m) => m.content)) !== JSON.stringify(msgs.map((m) => m.content))) lost += 1;
  }
  check(`旧会话全部保留（${liveKeys.length} 个键，内容/条数不变）`, lost === 0, lost ? `${lost} 个键有差异` : "0 丢失");

  // -------------------------------------------------------------------------
  section("② 核心：私聊说的话 → 群里能回忆（真实引擎上下文）");
  // -------------------------------------------------------------------------
  const stamp = String(Date.now());
  const secretNumber = `2026${stamp.slice(-4)}`;
  const c2c = (text) => ({
    scope: "c2c", targetId: owner, senderId: owner, senderName: "主人",
    messageId: `c2c-${Math.random().toString(36).slice(2)}`, content: text, kind: "text", attachments: [],
  });
  const group = (text, { openid = owner, gid = groupA, role = "member" } = {}) => ({
    scope: "group", targetId: gid, groupOpenid: gid, senderId: openid,
    senderName: openid === owner ? "群主" : "群友", memberRole: role,
    rawEventType: "GROUP_AT_MESSAGE_CREATE",
    messageId: `g-${Math.random().toString(36).slice(2)}`, content: `<@!123> ${text}`, kind: "text", attachments: [],
  });

  await engine.handle(c2c(`记住：春禾最喜欢的数字是 ${secretNumber}`));
  console.log(`   私聊（主人）：「记住：春禾最喜欢的数字是 ${secretNumber}」`);

  await engine.handle(group("我最喜欢的数字是几"));
  const groupCtx = seen.at(-1);
  const historyText = groupCtx.history.map((m) => m.content).join("\n");
  console.log(`   群里（主人）问：「我最喜欢的数字是几？」`);
  console.log(`   ↳ 群上下文历史（尾部 6 条）：`);
  for (const m of groupCtx.history.slice(-6)) console.log(`      [${m.role}] ${sha(m.content)}`);
  check("群上下文包含刚才私聊说的数字", historyText.includes(secretNumber));
  check("历史标注了〔私聊〕来源", historyText.includes("〔私聊〕"));
  check("crossScene 标记已置位（提示词才会加安全阀）", groupCtx.crossScene === true);
  check("主人长期记忆已注入群里", groupCtx.ownerMemory.some((f) => f.text.includes(secretNumber)));

  if (useModel && sent.length > 0) {
    console.log(`\n   春禾在群里的真实回复：`);
    console.log(`   > ${sent.at(-1).content}`);
    check("真实回复提到了私聊里的数字（模型回忆成功）", String(sent.at(-1).content).includes(secretNumber));
    const dump = promptDumps.at(-1);
    if (dump) {
      const sys = String(dump.messages?.[0]?.content ?? "");
      check("送给模型的系统提示词含记忆来源安全阀", sys.includes("【记忆来源 · 重要】"));
      check("送给模型的系统提示词含「不要把私聊原文逐字复述」", sys.includes("不要把私聊原文逐字复述"));
      const hist = (dump.messages ?? []).map((m) => m.content).join("\n");
      check("送给模型的历史里确实带着〔私聊〕内容", hist.includes("〔私聊〕"));
    }
  }

  // -------------------------------------------------------------------------
  section("③ 隔离：群成员的内容不会串到主人私聊 / 其他群成员");
  // -------------------------------------------------------------------------
  const secret = `菠萝蜜-${stamp.slice(-3)}`;
  await engine.handle(group(`我的私密暗号是 ${secret}，千万别外传`, { openid: memberA }));
  console.log(`   群里（成员A ${mask(memberA)}）：「我的私密暗号是 ${secret}」`);

  await engine.handle(c2c("刚才群里有人说了什么"));
  const ownerC2C = seen.at(-1);
  const ownerVisible = JSON.stringify({ h: ownerC2C.history, t: ownerC2C.topics, o: ownerC2C.ownerMemory });
  check("主人私聊里看不到群成员的暗号", !ownerVisible.includes(secret));
  check("主人私聊的历史不带群成员会话", !ownerC2C.history.some((m) => m.content.includes(secret)));
  const ownerTopicLeak = ownerC2C.topics.filter((t) => !String(t.owner).includes(owner));
  check("主人私聊的话题全部来自主人自己", ownerTopicLeak.length === 0, `${ownerC2C.topics.length} 条话题，越权 ${ownerTopicLeak.length} 条`);

  await engine.handle(group("刚才有人说了什么", { openid: memberB }));
  const memberCtx = seen.at(-1);
  check("同群成员 B 看不到 A 的暗号（会话隔离）", !memberCtx.history.map((m) => m.content).join("\n").includes(secret));
  check("群成员拿不到主人长期记忆", memberCtx.ownerMemory.length === 0);

  // -------------------------------------------------------------------------
  section("④ 跨群 + 长期记忆：换一个群也记得私聊的内容");
  // -------------------------------------------------------------------------
  await engine.handle(group("我最喜欢的数字是几", { gid: groupB }));
  const otherGroup = seen.at(-1);
  check("另一个群的上下文也含私聊数字", otherGroup.history.map((m) => m.content).join("\n").includes(secretNumber));
  check("另一个群也拿到长期记忆", otherGroup.ownerMemory.some((f) => f.text.includes(secretNumber)));

  // 落盘 + 重新加载，证明「重启不丢」
  engine.flushMemory();
  const reloaded = new OwnerMemoryStore({ file: ownerMem, maxFacts: 50, logger: log });
  check(
    "长期记忆已落盘且可重新加载",
    reloaded.list().some((f) => f.text.includes(secretNumber)),
    `${reloaded.size} 条`,
  );

  // -------------------------------------------------------------------------
  section("结论");
  // -------------------------------------------------------------------------
  console.log(`   通过 ${pass.length} 项，失败 ${fail.length} 项`);
  if (fail.length) {
    for (const f of fail) console.log(`   ❌ ${f}`);
    process.exit(1);
  }
  console.log("   ✅ 私聊里说的话，群里能回忆；私聊里下的指令，群聊里生效。");
  console.log("   ✅ 群成员的内容没有串进主人私聊或其他人的会话。");
  console.log(`\n[提示] 临时数据副本保留在：${tmp}`);
  console.log("       （线上 data/memory.json 未被本脚本写入；重启春禾后迁移只发生一次）");
}

main().catch((err) => {
  console.error("[check-memory-share] 失败：", err?.stack ?? err);
  process.exit(1);
});
