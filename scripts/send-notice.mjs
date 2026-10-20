#!/usr/bin/env node
/**
 * send-notice.mjs — 用 QQ 官方 API 主动给主人发一条**文字**消息。
 *
 * 为什么单独写一个：
 *   看门狗在「春禾进程已经死了」的时候要通知主人。这时候引擎不在线，
 *   不能靠它自己发，只能走官方 HTTP API（/v2/users/{openid}/messages，
 *   不带 msg_id = 主动消息）。send-song.mjs 只发语音，这里补上文字。
 *
 * ⚠️ 平台约束：主动消息有配额，且用户可在机器人资料卡关闭推送。
 *    被拒（C2C_MSG_REJECT 之类）时按失败退出，**绝不重试刷屏**。
 *
 * 用法：
 *   node scripts/send-notice.mjs --text "掉线了，已恢复"
 *   node scripts/send-notice.mjs --text-file C:\path\to\text.txt   （推荐：避免命令行编码问题）
 *   node scripts/send-notice.mjs --text "..." --openid <openid> --dry-run
 */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { parseDotenv, resolveApiBase, loadConfig } from "../src/config.js";
import { QQApi } from "../src/qq/api.js";

const ROOT = path.resolve(import.meta.dirname, "..");

function parseArgs(argv) {
  const out = { text: "", textFile: "", openid: "", dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--text") out.text = argv[++i] ?? "";
    else if (a === "--text-file") out.textFile = argv[++i] ?? "";
    else if (a === "--openid") out.openid = argv[++i] ?? "";
    else if (a === "--dry-run") out.dryRun = true;
  }
  return out;
}

function loadEnv() {
  const file = path.join(ROOT, ".env");
  if (!fs.existsSync(file)) throw new Error(`找不到 .env：${file}`);
  return parseDotenv(fs.readFileSync(file, "utf8"));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const env = { ...loadEnv(), ...process.env };

  let text = args.text;
  if (args.textFile) {
    const f = path.resolve(args.textFile);
    if (!fs.existsSync(f)) throw new Error(`文本文件不存在：${f}`);
    text = fs.readFileSync(f, "utf8").replace(/^\uFEFF/, "").trim();
  }
  if (!text) throw new Error("没有要发的内容（用 --text 或 --text-file）");
  if (text.length > 500) text = text.slice(0, 500);

  const appId = String(env.QQ_APP_ID ?? "").trim();
  const secret = String(env.QQ_APP_SECRET ?? "").trim();
  const sandbox = String(env.QQ_SANDBOX ?? "false").toLowerCase() === "true";
  if (!appId || !secret) throw new Error("QQ_APP_ID / QQ_APP_SECRET 未配置");

  let openid = args.openid.trim();
  if (!openid) {
    const admins = String(env.QQ_ADMIN_USERS ?? "").split(/[,\s]+/).filter(Boolean);
    openid = admins[0] ?? "";
  }
  if (!openid) throw new Error("没有目标 openid（--openid 或 .env 里的 QQ_ADMIN_USERS）");

  console.log(`[send-notice] 目标   : 私聊 ${openid}`);
  console.log(`[send-notice] 环境   : ${sandbox ? "沙箱" : "正式"}`);
  console.log(`[send-notice] 内容   : ${text}`);

  if (args.dryRun) {
    console.log("[send-notice] --dry-run：不实际发送");
    return;
  }

  const cfg = loadConfig(env);
  const api = new QQApi({
    appId,
    clientSecret: secret,
    apiBase: resolveApiBase(cfg),
    tokenBase: "https://bots.qq.com",
    logger: { info: (m) => console.log("  ", m), warn: (m) => console.warn("  !", m), error: (m) => console.error("  x", m) },
  });

  await api.getAccessToken();
  const res = await api.sendProactiveMessage("c2c", openid, text);
  console.log("[send-notice] 响应 =", JSON.stringify(res));
  console.log("[send-notice] 完成；msg id =", res?.id ?? res?.message_id ?? "(未返回)");
}

main().catch((err) => {
  console.error("[send-notice] 失败：", err?.message ?? err);
  process.exit(1);
});
