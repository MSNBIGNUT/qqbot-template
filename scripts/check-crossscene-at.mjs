#!/usr/bin/env node
/**
 * check-crossscene-at.mjs — 跨场景 @ 指令 + 假承诺防护 · 真机数据验收
 *
 * 用**真实 data/memory.json 的副本**（线上 3 个真实群）跑真实引擎，api 全部是假的：
 *   ① 「能在群里@junh让他去漂唱吗」→ 歧义/敏感：只留待确认草稿，**不主动发群**，
 *      回执明确说没发，模型也不许先答应；
 *   ② 「去大群里@张三说该开会了」→ 真的主动发到 9F42，群里是「@张三 …该开会了」文字，
 *      回执明确说明：做不了真 @ 提醒（群成员表 11253 无权限）；
 *   ③ 没有回执时模型说「这就去」→ 代码闸门删掉假承诺；
 *   ④ 非主人：不建待办、不发群。
 *
 * ⚠️ 安全线：不启动第二个机器人、不连网关、不发真实 QQ 消息；
 *    线上 data/ 只读，脚本前后核对 SHA256（topics.json 可能被正在运行的机器人
 *    自己写盘，脚本不碰它）。
 *
 * 用法：node scripts/check-crossscene-at.mjs
 */

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { parseDotenv, loadConfig } from "../src/config.js";
import { MessageEngine } from "../src/core/engine.js";
import { createLogger } from "../src/util/log.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const LIVE_MEMORY = path.join(ROOT, "data", "memory.json");
const LIVE_GROUPS = path.join(ROOT, "data", "groups.json");
const LIVE_PENDING = path.join(ROOT, "data", "pending-actions.json");

const pass = [];
const fail = [];
function check(name, ok, detail = "") {
  (ok ? pass : fail).push(name);
  console.log(`   ${ok ? "✅" : "❌"} ${name}${detail ? ` —— ${detail}` : ""}`);
}
function section(title) {
  console.log(`\n${"─".repeat(74)}\n${title}\n${"─".repeat(74)}`);
}
function sha256(file) {
  if (!fs.existsSync(file)) return "(missing)";
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex").toUpperCase();
}
const short = (id) => (id && id.length > 14 ? `${id.slice(0, 8)}…${id.slice(-4)}` : String(id ?? ""));

function fakeApi() {
  const sent = [];
  return {
    sent,
    async sendMessage(scope, targetId, content, opts = {}) {
      sent.push({ scope, targetId, content, msgId: opts.msgId });
      return { id: `fake-${sent.length}`, content };
    },
    async sendProactiveMessage(scope, targetId, content) {
      sent.push({ scope, targetId, content, proactive: true });
      return { id: `fake-p-${sent.length}`, content };
    },
    async uploadMedia() {
      return "fi_check";
    },
    async sendMedia() {
      return { id: "media-check" };
    },
    async getGroupMembers() {
      // 真机实测：11253 无接口访问权限
      return [];
    },
  };
}

/** 真机记忆副本 + 临时持久化；memory="empty" 用来模拟"一个群都不知道" */
function makeEngine(env, { api, memory = "live", reply } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chunhe-at-check-"));
  const memCopy = path.join(dir, "memory.json");
  const data =
    memory === "live"
      ? JSON.parse(fs.readFileSync(LIVE_MEMORY, "utf8"))
      : { version: 2, sessions: {} };
  fs.writeFileSync(memCopy, JSON.stringify(data), "utf8");
  const config = loadConfig({
    ...env,
    QQ_MEMORY_FILE: memCopy,
    QQ_TOPIC_FILE: path.join(dir, "topics.json"),
    QQ_OWNER_MEMORY_FILE: path.join(dir, "owner-memory.json"),
    QQ_PENDING_FILE: path.join(dir, "pending-actions.json"),
    QQ_REMINDER_FILE: path.join(dir, "reminders.json"),
    QQ_GROUPS_FILE: path.join(dir, "groups.json"),
    QQ_PROACTIVE_QUOTA_FILE: path.join(dir, "proactive-quota.json"),
    QQ_PENDING_DELIVERY: "proactive",
    QQ_REMINDERS: "false",
    QQ_MULTI_MESSAGE: "false",
    QQ_VOICE_REPLY: "off",
    QQ_SING_ENABLED: "false",
    QQ_PROACTIVE: "false",
    QQ_RATE_LIMIT_PER_MINUTE: "1000",
    QQ_GROUP_TRIGGER: "all",
  });
  const engine = new MessageEngine({
    config,
    api,
    logger: createLogger("error"),
    generate: async (ctx) => (reply ? reply(ctx) : "好呀～"),
  });
  return { engine, dir };
}

let seq = 0;
const c2c = (owner, text) => ({
  scope: "c2c",
  targetId: owner,
  senderId: owner,
  senderName: "主人",
  messageId: `check-at-c2c-${++seq}`,
  content: text,
  kind: "text",
  attachments: [],
});

async function main() {
  const envFile = path.join(ROOT, ".env");
  const env = fs.existsSync(envFile)
    ? { ...parseDotenv(fs.readFileSync(envFile, "utf8")), ...process.env }
    : { ...process.env };

  if (!fs.existsSync(LIVE_MEMORY)) {
    console.error("❌ 找不到 data/memory.json，无法用真机数据验收");
    process.exit(2);
  }
  const live = JSON.parse(fs.readFileSync(LIVE_MEMORY, "utf8"));
  const owner =
    String(env.QQ_ADMIN_USERS ?? "").split(/[,\s;]+/).filter(Boolean)[0] ??
    Object.keys(live.sessions ?? {})
      .find((k) => k.startsWith("owner:"))
      ?.slice("owner:".length);
  if (!owner) {
    console.error("❌ 认不出主人 openid");
    process.exit(2);
  }

  const before = {
    memory: sha256(LIVE_MEMORY),
    groups: sha256(LIVE_GROUPS),
    pending: sha256(LIVE_PENDING),
  };

  console.log("=".repeat(74));
  console.log("春禾 ∞ 跨场景 @ 指令 · 假承诺防护 · 真机数据验收（假 api，不发 QQ）");
  console.log("=".repeat(74));
  console.log(`[环境] 主人 = ${short(owner)}`);
  console.log(`[数据] 只读 data/memory.json，SHA256 = ${before.memory}`);

  // -------------------------------------------------------------------------
  section("① 真机事故复现：歧义 @ 指令 → 先确认，不自动发，不许先答应");
  // -------------------------------------------------------------------------
  {
    const api = fakeApi();
    const { engine } = makeEngine(env, {
      api,
      reply: (ctx) =>
        /漂唱/.test(ctx.text)
          ? "好嘞，那春禾这就去大群里 @junh，提醒他该去玩火影啦～"
          : "好呀～",
    });
    console.log(`   群清单：${engine.groups.all().map((g) => `${short(g.groupOpenid)}(${g.sizeText})`).join(" ")}`);
    await engine.handle(c2c(owner, "能在群里@junh让他去漂唱吗"));

    const groupSends = api.sent.filter((s) => s.proactive);
    const receipt = api.sent.filter((s) => s.scope === "c2c").at(-1)?.content ?? "";
    const entry = engine.pendingActions.list({ ownerId: owner, status: null }).at(-1);
    console.log(`   实际群消息：${groupSends.length} 条`);
    console.log(`   私聊回执：${receipt.replace(/\n/g, " ")}`);
    console.log(`   待办草稿：kind=${entry?.kind} mention=${entry?.payload?.mention} message=${entry?.payload?.message} needsConfirm=${entry?.payload?.needsConfirm} delivery=${entry?.delivery}`);
    check("歧义内容没有发到群里", groupSends.length === 0);
    check("解析出 @ 名字", entry?.payload?.mention === "junh", entry?.payload?.mention);
    check("解析出转述内容", /漂唱/.test(entry?.payload?.message ?? ""), entry?.payload?.message);
    check("标记为待确认草稿", entry?.payload?.needsConfirm === true);
    check("草稿不会走主动发送", entry?.delivery === "deferred", entry?.delivery);
    check("回执明确说还没发", /没发|没敢发/.test(receipt));
    check("没有假承诺", !/这就去|马上就去|已经发了/.test(receipt), receipt);
    check("没有宣称对方一定看到", !/一定看到|收到提醒/.test(receipt));
  }

  // -------------------------------------------------------------------------
  section("② 「去大群里@张三说该开会了」→ 真发文字 @，回执说明做不了真 @");
  // -------------------------------------------------------------------------
  {
    const api = fakeApi();
    const { engine } = makeEngine(env, {
      api,
      reply: (ctx) =>
        /@张三/.test(ctx.text) ? "这就去大群里 @张三 说一声～" : "好呀～",
    });
    await engine.handle(c2c(owner, "去大群里@张三说该开会了"));

    const send = api.sent.filter((s) => s.proactive).at(-1);
    const receipt = api.sent.filter((s) => s.scope === "c2c").at(-1)?.content ?? "";
    console.log(`   群消息实际发出：${JSON.stringify(send?.content ?? "")} → ${short(send?.targetId)}`);
    console.log(`   私聊回执：${receipt.replace(/\n/g, " ")}`);
    check("真的主动发了一条", Boolean(send?.proactive));
    check("发到真机大群 9F42", send?.targetId === "9F425ED551BCB8B9F4EEA343C5D334C4", short(send?.targetId));
    check("群消息含 @张三", /@张三/.test(send?.content ?? ""), send?.content);
    check("转述内容没丢", /该开会了/.test(send?.content ?? ""), send?.content);
    check("回执说明不是真 @", /真 ?@/.test(receipt), receipt);
    check("回执说明只能发文字", /文字|做不了|没权限/.test(receipt), receipt);
    check("有回执时允许说已发", /已经发到|发到群里/.test(receipt));
  }

  // -------------------------------------------------------------------------
  section("③ 没有回执的「这就去」→ 代码闸门删掉（一个群都不知道）");
  // -------------------------------------------------------------------------
  {
    const api = fakeApi();
    const { engine } = makeEngine(env, {
      api,
      memory: "empty",
      reply: async () => "好嘞，那春禾这就去大群里 @张三，提醒他该开会啦～",
    });
    await engine.handle(c2c(owner, "去大群里@张三说该开会了"));
    const receipt = api.sent.filter((s) => s.scope === "c2c").at(-1)?.content ?? "";
    console.log(`   私聊回执：${receipt.replace(/\n/g, " ")}`);
    console.log(`   闸门计数：promiseGuarded=${engine.stats.promiseGuarded}`);
    check("假承诺被删掉", !/这就去|马上就去|已经发了/.test(receipt), receipt);
    check("换成诚实的「还没做到」", /还没真的做到|不先跟主人保证/.test(receipt), receipt);
    check("闸门确实触发过", engine.stats.promiseGuarded >= 1, String(engine.stats.promiseGuarded));
    check("群里没有消息", api.sent.filter((s) => s.proactive).length === 0);
  }

  // -------------------------------------------------------------------------
  section("④ 安全：非主人不能触发 @ 待办");
  // -------------------------------------------------------------------------
  {
    const api = fakeApi();
    const { engine } = makeEngine(env, { api });
    await engine.handle(c2c("NOT_THE_OWNER_0001", "去大群里@张三说该开会了"));
    check("非主人不建待办", engine.pendingActions.listAll().length === 0);
    check("非主人不发群消息", api.sent.filter((s) => s.proactive).length === 0);
  }

  // -------------------------------------------------------------------------
  section("⑤ 线上数据只读核对");
  // -------------------------------------------------------------------------
  check("data/memory.json 未被脚本改写", before.memory === sha256(LIVE_MEMORY));
  check("data/groups.json 未被脚本改写", before.groups === sha256(LIVE_GROUPS));
  check("data/pending-actions.json 未被脚本改写", before.pending === sha256(LIVE_PENDING));

  console.log(`\n结论：通过 ${pass.length} 项，失败 ${fail.length} 项`);
  if (fail.length) {
    for (const f of fail) console.log(`   ❌ ${f}`);
    process.exit(1);
  }
  console.log("   ✅ 歧义 @ 先确认不自动发；普通 @ 待办真发文字并如实说明不是真 @；假承诺被代码拦下。");
}

main().catch((err) => {
  console.error("[check-crossscene-at] 失败：", err?.stack ?? err);
  process.exit(1);
});
