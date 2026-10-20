#!/usr/bin/env node
/**
 * send-song.mjs — 把一首渲染好的歌（SILK）通过 QQ 官方平台发到指定私聊。
 *
 * 复用春禾自己的 src/qq/api.js，因此发送路径与机器人正常运行完全一致
 * （uploadC2CFile -> msg_type=7），只是不需要把整个 bot 跑起来。
 *
 * 用法：
 *   node scripts/send-song.mjs --silk <path.silk> [--openid <openid>] [--dry-run]
 *
 * 不带 --openid 时取 QQ_ADMIN_USERS 的第一项（春禾的 .env 里就是主人本人）。
 */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { parseDotenv, resolveApiBase, loadConfig } from "../src/config.js";
import {
  QQApi,
  VOICE_FILE_TYPE,
  nextMsgSeq,
  groupMessagePath,
  groupFileUploadPath,
  buildFileUploadBody,
  buildVoiceMessageBody,
} from "../src/qq/api.js";

const ROOT = path.resolve(import.meta.dirname, "..");

function parseArgs(argv) {
  const out = { silk: "", openid: "", group: "", dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--silk") out.silk = argv[++i] ?? "";
    else if (a === "--openid") out.openid = argv[++i] ?? "";
    else if (a === "--group") out.group = argv[++i] ?? "";
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

  const appId = String(env.QQ_APP_ID ?? "").trim();
  const secret = String(env.QQ_APP_SECRET ?? "").trim();
  const sandbox = String(env.QQ_SANDBOX ?? "false").toLowerCase() === "true";
  if (!appId || !secret) throw new Error("QQ_APP_ID / QQ_APP_SECRET 未配置");

  // 目标：命令行优先，其次 .env 的管理员列表第一项
  let openid = args.openid.trim();
  if (!openid) {
    const admins = String(env.QQ_ADMIN_USERS ?? "").split(/[,\s]+/).filter(Boolean);
    openid = admins[0] ?? "";
  }
  const group = args.group.trim();
  if (!group && !openid) throw new Error("没有目标（用 --openid 或 --group 指定）");

  const silkPath = path.resolve(args.silk);
  if (!fs.existsSync(silkPath)) throw new Error(`SILK 文件不存在：${silkPath}`);
  const buf = fs.readFileSync(silkPath);
  const head = buf.subarray(0, 10);
  const isTencentSilk = head.equals(Buffer.from("\x02#!SILK_V3", "binary"));
  console.log(`[send-song] silk   : ${silkPath} (${buf.length} bytes)`);
  console.log(`[send-song] header : ${isTencentSilk ? "OK tencent SILK" : "!! 不是 tencent SILK"}`);
  console.log(`[send-song] 目标   : ${group ? "群 " + group : "私聊 " + openid}`);
  console.log(`[send-song] 环境   : ${sandbox ? "沙箱" : "正式"}`);
  if (!isTencentSilk) throw new Error("头部不是 tencent SILK，QQ 会拒收");

  if (args.dryRun) {
    console.log("[send-song] --dry-run：不实际发送");
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

  console.log("[send-song] 1/3 取 access_token ...");
  await api.getAccessToken();
  console.log("[send-song]      OK");

  console.log("[send-song] 2/3 上传富媒体 ...");
  let fileInfo;
  if (group) {
    // 群聊富媒体：api.js 目前只封装了 C2C 的上传/发送，这里用它的公开
    // 路径与请求体构造器走同一条链路（msg_type=7 + 群 file_info）。
    const token = await api.getAccessToken();
    const up = await api.request(
      token,
      "POST",
      groupFileUploadPath(group),
      buildFileUploadBody({ groupOpenid: group, fileDataBase64: buf.toString("base64"), fileType: VOICE_FILE_TYPE }),
    );
    fileInfo = up?.file_info ?? up;
  } else {
    fileInfo = await api.uploadC2CFile(openid, buf.toString("base64"), VOICE_FILE_TYPE);
  }
  console.log("[send-song]      file_info =", typeof fileInfo === "string" ? fileInfo.slice(0, 40) + "..." : JSON.stringify(fileInfo));

  console.log("[send-song] 3/3 发送语音（msg_type=7）...");
  let res;
  if (group) {
    const token = await api.getAccessToken();
    res = await api.request(
      token,
      "POST",
      groupMessagePath(group),
      buildVoiceMessageBody({ fileInfo, msgId: undefined, msgSeq: nextMsgSeq() }),
    );
  } else {
    res = await api.sendC2CVoice(openid, fileInfo);
  }
  console.log("[send-song]      响应 =", JSON.stringify(res));
  console.log("[send-song] 完成；msg id =", res?.id ?? res?.message_id ?? "(未返回)");
}

main().catch((err) => {
  console.error("[send-song] 失败：", err?.message ?? err);
  process.exit(1);
});
