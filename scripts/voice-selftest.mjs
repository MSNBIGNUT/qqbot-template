/**
 * 语音自检：合成一条语音并真实发到 QQ 单聊，用来端到端验证整条链路。
 *
 * 它**只走 HTTP API**（取 token → 上传富媒体 → 发 msg_type=7），
 * 不连 WebSocket 网关，所以可以在春禾正在运行时直接跑，不会抢会话。
 *
 * 用法：
 *   node scripts/voice-selftest.mjs --openid <user_openid>
 *   node scripts/voice-selftest.mjs --openid <openid> --text "主人好呀～"
 *   node scripts/voice-selftest.mjs --dry-run          # 只合成，不联网
 *
 * 也可用环境变量：QQ_VOICE_TEST_OPENID / QQ_VOICE_TEST_TEXT
 *
 * 退出码：0 成功；1 失败（失败原因会打印得很具体，便于判断是不是权限问题）。
 */

import path from "node:path";
import fs from "node:fs";

const ROOT = path.resolve(import.meta.dirname, "..").split(path.sep).join("/");
const { loadConfig, parseDotenv } = await import(`file:///${ROOT}/src/config.js`);
const { QQApi, VOICE_FILE_TYPE } = await import(`file:///${ROOT}/src/qq/api.js`);
const { resolveTtsConfig, synthesizeSilk } = await import(`file:///${ROOT}/src/media/tts.js`);
const { createLogger } = await import(`file:///${ROOT}/src/util/log.js`);

// ---------------------------------------------------------------- 参数

function argOf(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--")
    ? process.argv[i + 1]
    : fallback;
}

const dryRun = process.argv.includes("--dry-run");
const openid = argOf("openid") || process.env.QQ_VOICE_TEST_OPENID || "";
const text =
  argOf("text") ||
  process.env.QQ_VOICE_TEST_TEXT ||
  "主人好呀，我是春禾~今天想聊点什么呢？";

const logger = createLogger("info");

console.log("=== 春禾语音自检 ===");
console.log(`文本  : ${text}`);
console.log(`模式  : ${dryRun ? "dry-run（只合成，不发）" : "真实发送"}`);
console.log("");

// ---------------------------------------------------------------- 配置

const envPath = path.join(ROOT, ".env");
const docEnv = fs.existsSync(envPath) ? parseDotenv(fs.readFileSync(envPath, "utf8")) : {};
const config = loadConfig(docEnv);

// 自检时强制打开语音，避免因为 .env 里 QQ_VOICE_REPLY=off 而什么都不做
const tts = resolveTtsConfig({
  ...docEnv,
  QQ_VOICE_REPLY: "always",
  TTS_PYTHON: config.ttsPython,
  TTS_SCRIPT: config.ttsScript,
  TTS_VOICE: config.ttsVoice,
  TTS_MAX_CHARS: config.ttsMaxChars,
});

console.log("[1/3] 合成语音 (edge-tts → tencent SILK)");
console.log(`      音色 : ${tts.voice}`);
console.log(`      python: ${tts.python || "(PATH 上的 python)"}`);

const t0 = Date.now();
const synth = await synthesizeSilk(text, tts);
if (!synth.ok) {
  console.error(`\n✗ 合成失败：${synth.reason}`);
  console.error("  排查建议：");
  console.error("   - 确认 TTS_PYTHON 指向装了 edge-tts + silk-python + miniaudio 的 venv");
  console.error("   - 手动试一次：<python> tools/tts_silk.py --text 你好 --out t.silk");
  process.exit(1);
}
const head = synth.silk.subarray(0, 10).toString("latin1");
console.log(`      ✓ ${(synth.silk.length / 1024).toFixed(1)} KB，头部 ${JSON.stringify(head)}，用时 ${Date.now() - t0}ms`);

if (head !== "\u0002#!SILK_V3") {
  console.error(`\n✗ 产出的不是 tencent SILK（头部应为 \\x02#!SILK_V3），QQ 会拒收。`);
  process.exit(1);
}

if (dryRun) {
  console.log("\n[dry-run] 到此为止，未发起任何网络请求。");
  process.exit(0);
}

if (!openid) {
  console.error("\n✗ 缺少 --openid（私聊对方 user_openid）。");
  console.error("  可从 data/memory.json 的 c2c:<openid> 键里找到。");
  process.exit(1);
}
if (!config.appId || !config.clientSecret) {
  console.error("\n✗ .env 里缺少 QQ_APP_ID / QQ_APP_SECRET，无法调用平台接口。");
  process.exit(1);
}

const api = new QQApi({
  appId: config.appId,
  clientSecret: config.clientSecret,
  apiBase: config.apiBase,
  tokenBase: config.tokenBase,
  logger,
});

// ---------------------------------------------------------------- 上传

console.log("\n[2/3] 上传富媒体 (POST /v2/users/{openid}/files)");
let fileInfo = null;
try {
  fileInfo = await api.uploadC2CFile(openid, synth.silk.toString("base64"), VOICE_FILE_TYPE);
} catch (err) {
  console.error(`\n✗ 上传失败：${err?.message}`);
  if (err?.bizCode !== undefined) {
    console.error(`  bizCode = ${err.bizCode}`);
    console.error("  → 大概率是应用**未开通「富媒体消息」/语音权限**。");
    console.error("    去 QQ 开放平台 → 应用管理 → API 权限 里开通后再试。");
  }
  console.error(`  openid = ${openid}`);
  process.exit(1);
}
if (!fileInfo) {
  console.error("\n✗ 上传返回成功但没有 file_info，无法发送。");
  process.exit(1);
}
console.log(`      ✓ file_info = ${fileInfo}`);

// ---------------------------------------------------------------- 发送

console.log("\n[3/3] 发送语音 (msg_type=7)");
try {
  const res = await api.sendC2CVoice(openid, fileInfo);
  console.log(`      ✓ 已发送`);
  if (res?.timestamp) console.log(`      平台时间戳: ${res.timestamp}`);
  console.log("\n=== 成功：语音链路端到端可用 ===");
  console.log("请到 QQ 私聊查看这条语音。");
  process.exit(0);
} catch (err) {
  console.error(`\n✗ 发送失败：${err?.message}`);
  if (err?.bizCode !== undefined) console.error(`  bizCode = ${err.bizCode}`);
  console.error("  提示：主动消息受平台配额与「用户是否允许推送」限制；");
  console.error("        若配额用尽，可改为先给机器人发一条消息，让它以被动回复的方式发语音。");
  process.exit(1);
}
