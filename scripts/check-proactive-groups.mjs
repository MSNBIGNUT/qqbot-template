#!/usr/bin/env node
/**
 * check-proactive-groups.mjs — 真机数据 + 假 api 验收：
 *   **私聊下的指令，她会不会自己跑到群里说？能不能分出大群小群？**
 *
 * 用**真实 data/memory.json 的副本**（里面就是线上 3 个真实群）跑真实引擎：
 *   - 群分级：9F42（8 位发言人下限）→ 大群；AB20（2 位）→ 小群；90A0（1 位）→ 小群；
 *   - 私聊「在群里卖个萌」→ 立即调用群主动消息，发到最活跃的 9F42，并回报成功；
 *   - 私聊「去小群说晚安」→ 发到 AB20；
 *   - 配额用完 → 不发、如实说；
 *   - 平台拒发 → 如实说没发出去，不假装；
 *   - 非主人 → 不建待办、不发群消息。
 *
 * ⚠️ 安全线：
 *   1. 不启动第二个机器人、不连网关；
 *   2. 所有持久化文件指向临时副本，线上 data/ 只读（脚本前后核对 SHA256）；
 *   3. 假 api 记账，**不会真的发 QQ 消息**。
 *
 * 用法：node scripts/check-proactive-groups.mjs
 */

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { parseDotenv, loadConfig } from "../src/config.js";
import { MessageEngine } from "../src/core/engine.js";
import { createLogger } from "../src/util/log.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const LIVE_MEMORY = path.join(ROOT, "data", "memory.json");
const LIVE_GROUPS = path.join(ROOT, "data", "groups.json");

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

function fakeApi({ failProactive = null } = {}) {
  const sent = [];
  return {
    sent,
    async sendMessage(scope, targetId, content, opts = {}) {
      sent.push({ scope, targetId, content, msgId: opts.msgId });
      return { id: `fake-${sent.length}`, content };
    },
    async sendProactiveMessage(scope, targetId, content) {
      if (failProactive) throw failProactive;
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
      // 真机实测：11253 无接口访问权限。返回 [] 模拟这条限制。
      return [];
    },
  };
}

function makeEngine(env, { api }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chunhe-proactive-check-"));
  const memCopy = path.join(dir, "memory.json");
  const liveData = JSON.parse(fs.readFileSync(LIVE_MEMORY, "utf8"));
  fs.writeFileSync(memCopy, JSON.stringify(liveData), "utf8");
  const config = loadConfig({
    ...env,
    QQ_MEMORY_FILE: memCopy,
    QQ_TOPIC_FILE: path.join(dir, "topics.json"),
    QQ_OWNER_MEMORY_FILE: path.join(dir, "owner-memory.json"),
    QQ_PENDING_FILE: path.join(dir, "pending-actions.json"),
    QQ_REMINDER_FILE: path.join(dir, "reminders.json"),
    QQ_GROUPS_FILE: path.join(dir, "groups.json"),
    QQ_PROACTIVE_QUOTA_FILE: path.join(dir, "proactive-quota.json"),
    QQ_REMINDERS: "false",
    QQ_MULTI_MESSAGE: "false",
    QQ_VOICE_REPLY: "off",
    QQ_SING_ENABLED: "false",
    QQ_PROACTIVE: "false",
    QQ_RATE_LIMIT_PER_MINUTE: "1000",
    QQ_GROUP_TRIGGER: "all",
  });
  const seen = [];
  const engine = new MessageEngine({
    config,
    api,
    logger: createLogger("warn"),
    generate: async (ctx) => {
      seen.push(ctx);
      return "好呀～";
    },
  });
  return { engine, dir, memCopy, liveData };
}

let seq = 0;
const c2c = (owner, text) => ({
  scope: "c2c",
  targetId: owner,
  senderId: owner,
  senderName: "主人",
  messageId: `check-proactive-c2c-${++seq}`,
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
  const liveBefore = JSON.parse(fs.readFileSync(LIVE_MEMORY, "utf8"));
  const owner =
    String(env.QQ_ADMIN_USERS ?? "").split(/[,\s;]+/).filter(Boolean)[0] ??
    Object.keys(liveBefore.sessions ?? {})
      .find((k) => k.startsWith("owner:"))
      ?.slice("owner:".length);
  if (!owner) {
    console.error("❌ 认不出主人 openid（.env QQ_ADMIN_USERS / memory owner: 键都为空）");
    process.exit(2);
  }

  const shaMemBefore = sha256(LIVE_MEMORY);
  const groupsExistedBefore = fs.existsSync(LIVE_GROUPS);
  const shaGroupsBefore = sha256(LIVE_GROUPS);

  console.log("=".repeat(74));
  console.log("春禾 ∞ 群主动消息 + 大小群分级 · 真机数据验收（假 api，不发 QQ 消息）");
  console.log("=".repeat(74));
  console.log(`[环境] 主人 = ${short(owner)}`);
  console.log(`[数据] 只读 data/memory.json，SHA256 = ${shaMemBefore}`);

  const { engine, dir } = makeEngine(env, { api: fakeApi() });

  // -------------------------------------------------------------------------
  section("① 群分级：用真实记忆里的 3 个群");
  // -------------------------------------------------------------------------
  const groups = engine.groups.all();
  for (const g of groups) {
    console.log(
      `   ${short(g.groupOpenid)}  ${g.sizeText}  observed=${g.observedCount}  ` +
        `msgs=${g.messageCount}  source=${g.source}  lowerBound=${g.lowerBound}`,
    );
  }
  check("从真实记忆认出 3 个群", groups.length === 3, `实际 ${groups.length}`);
  const big = groups.find((g) => g.groupOpenid === "9F425ED551BCB8B9F4EEA343C5D334C4");
  const mid = groups.find((g) => g.groupOpenid === "AB20A861393138B96F6A1D0E128B8D7A");
  const tiny = groups.find((g) => g.groupOpenid === "90A0D35AC8B75178249E8D89CF1802F3");
  check("9F42（8 位发言人）判为大群", big?.sizeLabel === "large", big?.sizeText);
  check("AB20（2 位）判为小群", mid?.sizeLabel === "small");
  check("90A0（1 位）判为小群", tiny?.sizeLabel === "small");
  check("人数标注为 observed 下限", big?.source === "observed" && big?.lowerBound === true);
  check("mock 冒烟留下的假群被过滤", !groups.some((g) => g.groupOpenid === "group-openid-1"));
  check(
    "「去大群」选中 9F42",
    engine.groups.selectTarget({ sizeLabel: "large" }).groupOpenid ===
      "9F425ED551BCB8B9F4EEA343C5D334C4",
  );
  check(
    "「去小群」选中更活跃的 AB20（不是最小的 90A0）",
    engine.groups.selectTarget({ sizeLabel: "small" }).groupOpenid ===
      "AB20A861393138B96F6A1D0E128B8D7A",
  );

  // -------------------------------------------------------------------------
  section("② 私聊「在群里卖个萌」→ 真的主动发到群里");
  // -------------------------------------------------------------------------
  await engine.handle(c2c(owner, "在群里卖个萌"));
  const proactive = engine.api.sent.filter((s) => s.proactive);
  const receipt = engine.api.sent.filter((s) => s.scope === "c2c").at(-1)?.content ?? "";
  console.log(`   群消息实际发出：${JSON.stringify(proactive.at(-1)?.content ?? "")}`);
  console.log(`   私聊回执：${receipt.replace(/\n/g, " ")}`);
  check("调用了群主动消息（不是被动回复）", proactive.length === 1);
  check("发到最活跃的 9F42（大群）", proactive[0]?.targetId === big?.groupOpenid);
  check("内容是卖萌而不是空话", /啾咪|卖个萌/.test(proactive[0]?.content ?? ""));
  const entry1 = engine.pendingActions.list({ ownerId: owner, status: null })[0];
  check("待办标记 done（不会重复发）", entry1?.status === "done", entry1?.status);
  check("回执说明已发 + 目标群大小/依据", /发到|已经发/.test(receipt) && /大群|发言人/.test(receipt));
  check("回执没有让她等主人开口", !/等你.*群里.*说|到群里说一声/.test(receipt));

  // -------------------------------------------------------------------------
  section("③ 「去小群说晚安」→ 按标签选群");
  // -------------------------------------------------------------------------
  await engine.handle(c2c(owner, "去小群说一句晚安"));
  const smallSend = engine.api.sent.filter((s) => s.proactive).at(-1);
  console.log(`   小群实际发出：${JSON.stringify(smallSend?.content ?? "")} → ${short(smallSend?.targetId)}`);
  check("发到 AB20（小群）", smallSend?.targetId === mid?.groupOpenid);
  check("内容是晚安", /晚安/.test(smallSend?.content ?? ""));

  // -------------------------------------------------------------------------
  section("④ 配额：用完就停，如实说");
  // -------------------------------------------------------------------------
  {
    const quotaApi = fakeApi();
    const { engine: qEngine } = makeEngine(
      { ...env, QQ_PENDING_PROACTIVE_DAILY_LIMIT: "2" },
      { api: quotaApi },
    );
    await qEngine.handle(c2c(owner, "在群里卖个萌"));
    await qEngine.handle(c2c(owner, "在群里说一句晚安"));
    await qEngine.handle(c2c(owner, "在群里说一句早安"));
    const sentGroup = quotaApi.sent.filter((s) => s.proactive);
    const lastReceipt = quotaApi.sent.filter((s) => s.scope === "c2c").at(-1)?.content ?? "";
    console.log(`   自限 2 条，实际发出 ${sentGroup.length} 条`);
    console.log(`   第三条回执：${lastReceipt.replace(/\n/g, " ")}`);
    check("配额到顶后不再发送", sentGroup.length === 2);
    check("如实说明额度", /额度|配额|上限|发不了/.test(lastReceipt));
  }

  // -------------------------------------------------------------------------
  section("⑤ 平台拒发：如实回报，不假装");
  // -------------------------------------------------------------------------
  {
    const failErr = new Error("API 错误：主动消息发送失败，无权限");
    failErr.bizCode = 40034105;
    failErr.httpStatus = 400;
    const failApi = fakeApi({ failProactive: failErr });
    const { engine: fEngine } = makeEngine(env, { api: failApi });
    await fEngine.handle(c2c(owner, "在群里卖个萌"));
    const r = failApi.sent.filter((s) => s.scope === "c2c").at(-1)?.content ?? "";
    console.log(`   失败回执：${r.replace(/\n/g, " ")}`);
    const fe = fEngine.pendingActions.list({ ownerId: owner, status: null })[0];
    check("明确说没发出去", /没发出去|发送失败/.test(r));
    check("给出人话原因（权限）", /权限/.test(r));
    check("不假装已经发了", !/已经发|发出去啦|发好啦/.test(r));
    check("待办保留，可兜底", fe?.status === "pending", fe?.status);
  }

  // -------------------------------------------------------------------------
  section("⑥ 安全：非主人不能触发");
  // -------------------------------------------------------------------------
  {
    const safeApi = fakeApi();
    const { engine: sEngine } = makeEngine(env, { api: safeApi });
    await sEngine.handle(c2c("NOT_THE_OWNER_0001", "在群里卖个萌"));
    check("非主人不建待办", sEngine.pendingActions.listAll().length === 0);
    check("非主人不发群消息", safeApi.sent.filter((s) => s.proactive).length === 0);
  }

  // -------------------------------------------------------------------------
  section("⑦ 线上数据只读核对");
  // -------------------------------------------------------------------------
  const shaMemAfter = sha256(LIVE_MEMORY);
  const shaGroupsAfter = sha256(LIVE_GROUPS);
  check("data/memory.json 未被脚本改写", shaMemBefore === shaMemAfter, `${shaMemBefore} → ${shaMemAfter}`);
  check(
    "没有新建 data/groups.json",
    groupsExistedBefore === fs.existsSync(LIVE_GROUPS) && shaGroupsBefore === shaGroupsAfter,
  );

  console.log(`\n[临时副本] ${dir}（线上 data/ 只读）`);
  console.log(`\n结论：通过 ${pass.length} 项，失败 ${fail.length} 项`);
  if (fail.length) {
    for (const f of fail) console.log(`   ❌ ${f}`);
    process.exit(1);
  }
  console.log("   ✅ 私聊指令会自己跑到群里说；大群/小群按真实数据分得清；失败与配额都如实回报。");
}

main().catch((err) => {
  console.error("[check-proactive-groups] 失败：", err?.stack ?? err);
  process.exit(1);
});
