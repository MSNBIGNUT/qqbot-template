/**
 * 一次性只读探测：群成员列表 API 是否可用。
 *
 * 只发 GET（/v2/groups/{group_openid}/members），绝不发送任何消息。
 * 用途：如实记录平台是否开放该权限，以及返回的字段形状。
 *
 * 运行：node scripts/probe-group-members.mjs
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { QQApi } from "../src/qq/api.js";
import { loadConfig, parseDotenv } from "../src/config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const GROUP_OPENID = "9F425ED551BCB8B9F4EEA343C5D334C4";

function loadDotenv() {
  try {
    return parseDotenv(fs.readFileSync(path.join(ROOT, ".env"), "utf8"));
  } catch {
    return {};
  }
}

async function main() {
  const env = { ...process.env, ...loadDotenv() };
  const cfg = loadConfig(env);

  if (!cfg.appId || !cfg.clientSecret) {
    console.error("缺少 QQ_APP_ID / QQ_APP_SECRET，无法建 client。");
    process.exit(2);
  }

  const api = new QQApi({
    appId: cfg.appId,
    clientSecret: cfg.clientSecret,
    apiBase: cfg.apiBase,
    tokenBase: cfg.tokenBase,
    logger: {
      info: (...a) => console.log("[info]", ...a),
      warn: (...a) => console.warn("[warn]", ...a),
      debug: () => {},
      error: (...a) => console.error("[error]", ...a),
    },
  });

  console.log(`探测群成员列表 GET /v2/groups/${GROUP_OPENID}/members`);
  try {
    const members = await api.getGroupMembers(GROUP_OPENID, { maxPages: 3 });
    console.log(`\n✅ 成功：成员数 = ${Array.isArray(members) ? members.length : "?"}`);
    const sample = (members ?? []).slice(0, 8).map((m) => ({
      member_openid: m?.member_openid ?? m?.member_openid,
      username: m?.username ?? m?.nickname ?? "(无)",
      member_role: m?.member_role ?? "(字段缺失)",
    }));
    console.log("前若干成员：");
    for (const s of sample) console.log("  ", JSON.stringify(s, null, 0));
    if ((members ?? []).length > 8) console.log(`  …其余 ${members.length - 8} 位略`);
    // 顺便打印第一条原始字段名，便于核对真实形状
    if (members?.[0]) {
      console.log("\n首条原始字段：", Object.keys(members[0]).join(", "));
    }
  } catch (err) {
    console.log("\n❌ 失败（原样记录错误，这是要如实交付的平台限制）：");
    console.log("  message =", err?.message ?? err);
    console.log("  httpStatus =", err?.httpStatus);
    console.log("  bizCode =", err?.bizCode);
    console.log("  path =", err?.path);
  }
}

main();
