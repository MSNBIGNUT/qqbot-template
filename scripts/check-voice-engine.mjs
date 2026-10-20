#!/usr/bin/env node
/**
 * check-voice-engine.mjs — 假 API 注入，验证「引擎 → 语音合成 → 上传 → 发语音」整条链路。
 *
 * 不发 QQ、不连网关：api 是内存里的假实现，只记录调用参数。
 * 这条脚本验证的是：
 *   1. 语音回复判定真的走进 #sendVoice；
 *   2. 上传的是 tencent SILK（file_type=3，base64 解码后头是 0x02#!SILK_V3）；
 *   3. 最后调用的是 sendC2CVoice（msg_type=7 那条路），不是文字消息。
 *
 * 用法：node scripts/check-voice-engine.mjs
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { parseDotenv, loadConfig } from "../src/config.js";
import { MessageEngine } from "../src/core/engine.js";
import { createLogger } from "../src/util/log.js";
import { resetRvcWorker } from "../src/media/rvc-worker.js";

const ROOT = path.resolve(import.meta.dirname, "..");

function loadEnv() {
  const file = path.join(ROOT, ".env");
  return fs.existsSync(file) ? parseDotenv(fs.readFileSync(file, "utf8")) : {};
}

async function main() {
  const docEnv = loadEnv();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "chunhe-voice-engine-"));
  const config = loadConfig({
    ...docEnv,
    QQ_VOICE_REPLY: "always", // 本条是私聊文本消息，也要强制用语音回
    VOICE_CACHE_ENABLED: "false", // 强制走真实 TTS+RVC，证明上传的确实是绮萱音频
    QQ_PENDING_ACTIONS: "false",
    QQ_REMINDERS: "false",
    QQ_PROACTIVE: "false",
    QQ_MEMORY_FILE: path.join(tmp, "memory.json"),
    QQ_TOPIC_FILE: path.join(tmp, "topics.json"),
    QQ_REMINDER_FILE: path.join(tmp, "reminders.json"),
    QQ_PENDING_FILE: path.join(tmp, "pending-actions.json"),
    QQ_OWNER_MEMORY_FILE: path.join(tmp, "owner-memory.json"),
    QQ_SESSION_FILE: path.join(tmp, "session.json"),
  });
  const logger = createLogger("info");

  const uploads = [];
  const voices = [];
  const texts = [];
  const api = {
    getAccessToken: async () => "fake-token",
    uploadC2CFile: async (targetId, base64, fileType) => {
      uploads.push({ targetId, base64, fileType });
      return "FILE_INFO_FAKE";
    },
    sendC2CVoice: async (targetId, fileInfo, opts) => {
      voices.push({ targetId, fileInfo, opts });
      return { id: "voice-msg-1" };
    },
    sendMessage: async (scope, targetId, text) => {
      texts.push({ scope, targetId, text });
      return { id: "text-msg-1" };
    },
  };

  const engine = new MessageEngine({
    config,
    api,
    generate: async () => "主人，春禾在这儿呢～",
    logger,
  });
  engine.warmVoice();

  const msg = {
    scope: "c2c",
    rawEventType: "C2C_MESSAGE_CREATE",
    senderId: "USER_OPENID",
    senderName: "主人",
    targetId: "USER_OPENID",
    messageId: "msg-voice-1",
    content: "",
    kind: "voice",
    attachments: [{ content_type: "voice/wav", url: "https://example.invalid/a.wav" }],
  };

  const started = Date.now();
  const result = await engine.handle(msg);
  const wall = Date.now() - started;

  const upload = uploads[0] ?? null;
  const head = upload ? Buffer.from(upload.base64, "base64").subarray(0, 10).toString("latin1") : "";
  const report = {
    ok:
      result?.action === "replied" &&
      Boolean(result.voice) &&
      uploads.length === 1 &&
      upload?.fileType === 3 &&
      head === "\x02#!SILK_V3" &&
      voices.length === 1 &&
      voices[0]?.fileInfo === "FILE_INFO_FAKE" &&
      texts.length === 0,
    wallMs: wall,
    action: result?.action,
    voice: result?.voice,
    uploads: uploads.map((u) => ({
      targetId: u.targetId,
      fileType: u.fileType,
      bytes: Buffer.from(u.base64, "base64").length,
      head,
    })),
    voices: voices.map((v) => ({ targetId: v.targetId, fileInfo: v.fileInfo, msgId: v.opts?.msgId })),
    textMessages: texts.length,
  };

  console.log(JSON.stringify(report, null, 2));
  fs.rmSync(tmp, { recursive: true, force: true });
  resetRvcWorker();
  if (!report.ok) process.exitCode = 1;
}

main().catch((err) => {
  console.error("check-voice-engine 失败：", err);
  resetRvcWorker();
  process.exitCode = 1;
});
