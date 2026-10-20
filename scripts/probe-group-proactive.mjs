/**
 * 一次性探测：QQ 群**主动消息**（不带 msg_id）到底能不能发。
 *
 * 只发一条，绝不重试——主动消息有配额，失败就是失败，如实记录 bizCode。
 * 默认 --dry-run（只打印计划）；加 --send 才真的发。
 *
 * 运行：
 *   node scripts/probe-group-proactive.mjs --group 90A0... --dry-run
 *   node scripts/probe-group-proactive.mjs --group 90A0... --send
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { parseDotenv, resolveApiBase, loadConfig } from "../src/config.js";
import { QQApi } from "../src/qq/api.js";

const ROOT = path.resolve(import.meta.dirname, "..");

function parseArgs(argv) {
  const out = { group: "", text: "", dryRun: true };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--group") out.group = argv[++i] ?? "";
    else if (a === "--text") out.text = argv[++i] ?? "";
    else if (a === "--send") out.dryRun = false;
  }
  return out;
}

function loadEnv() {
  const file = path.join(ROOT, ".env");
  if (!fs.existsSync(file)) return {};
  return parseDotenv(fs.readFileSync(file, "utf8"));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const group = String(args.group ?? "").trim();
  if (!group) throw new Error("必须用 --group 指定 group_openid（本脚本不会猜）");
  const text = String(args.text ?? "").trim() || "【AI】春禾主动消息通道测试，只发这一条，测试完不再打扰～";

  const env = { ...loadEnv(), ...process.env };
  const cfg = loadConfig(env);
  if (!cfg.appId || !cfg.clientSecret) throw new Error("缺少 QQ_APP_ID / QQ_APP_SECRET");

  const api = new QQApi({
    appId: cfg.appId,
    clientSecret: cfg.clientSecret,
    apiBase: resolveApiBase(cfg),
    tokenBase: cfg.tokenBase,
    logger: { info: () => {}, warn: (m) => console.warn("[warn]", m), debug: () => {} },
  });

  console.log(`[probe-group-proactive] 环境   : ${cfg.sandbox ? "沙箱" : "正式"}`);
  console.log(`[probe-group-proactive] 目标群 : ${group}`);
  console.log(`[probe-group-proactive] 内容   : ${text}`);
  console.log(`[probe-group-proactive] 路径   : POST /v2/groups/${group}/messages（不带 msg_id）`);

  if (args.dryRun) {
    console.log("[probe-group-proactive] --dry-run：不实际发送。加 --send 才发。");
    return;
  }

  const startedAt = Date.now();
  try {
    const res = await api.sendProactiveMessage("group", group, text);
    console.log(`[probe-group-proactive] ✅ 成功（${Date.now() - startedAt}ms）`);
    console.log("[probe-group-proactive] 响应 =", JSON.stringify(res));
  } catch (err) {
    console.log(`[probe-group-proactive] ❌ 失败（${Date.now() - startedAt}ms）`);
    console.log("  message    =", err?.message ?? err);
    console.log("  httpStatus =", err?.httpStatus);
    console.log("  bizCode    =", err?.bizCode);
    console.log("  path       =", err?.path);
    process.exitCode = 2;
  }
}

main().catch((err) => {
  console.error("[probe-group-proactive] 异常：", err?.message ?? err);
  process.exitCode = 1;
});
