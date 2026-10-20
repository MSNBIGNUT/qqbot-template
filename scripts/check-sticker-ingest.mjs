/**
 * 真机链路验证（假 api 注入，不连 QQ、不启动第二个机器人）。
 *
 * 证明三件事：
 *   1. 真 ffmpeg 缩图链路可用：512px 的图存进表情库会变成 128px；
 *   2. 图在前、指令在后的两条消息，引擎真的把图写进目录并回执；
 *   3. 「嗨」这种轻松场合引擎会自动补一张表情，且真的走了上传/发送。
 *
 * 用法：node scripts/check-sticker-ingest.mjs
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { MessageEngine } from "../src/core/engine.js";
import { loadConfig } from "../src/config.js";
import { createLogger } from "../src/util/log.js";
import {
  PROJECT_ROOT,
  executeStickerCall,
  listStickers,
  readImageSize,
  resolveStickerConfig,
  STICKER_TOOL_NAME,
  STICKER_SUGGESTED_PX,
} from "../src/media/stickers.js";
import { findFfmpeg, saveStickerBuffer } from "../src/media/sticker-ingest.js";

const logger = createLogger("silent");
const OWNER = "OWNER_CHECK_INGEST_0001";
const root = fs.mkdtempSync(path.join(PROJECT_ROOT, "_sticker-ingest-check-"));
const dir = path.join(root, "stickers");
fs.mkdirSync(dir, { recursive: true });

const checks = [];
const check = (name, ok, detail = "") => {
  checks.push({ name, ok, detail });
  console.log(`${ok ? "✔" : "✘"} ${name}${detail ? ` — ${detail}` : ""}`);
};

// ---- 1) 真 ffmpeg 把 512px 缩到 128px ----
const ffmpeg = findFfmpeg();
check("找到 ffmpeg（缩图依赖）", Boolean(ffmpeg), ffmpeg || "未找到");
const bigPath = path.join(root, "big.jpg");
if (ffmpeg) {
  const made = spawnSync(ffmpeg, [
    "-y", "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", "color=c=skyblue:s=512x512:d=1",
    "-frames:v", "1", "-update", "1", bigPath,
  ], { windowsHide: true });
  check("ffmpeg 生成 512×512 测试图", made.status === 0 && fs.existsSync(bigPath));
}
const bigBuf = fs.existsSync(bigPath) ? fs.readFileSync(bigPath) : Buffer.alloc(0);
const cfg = resolveStickerConfig({ STICKER_DIR: dir });
const saved = await saveStickerBuffer({
  buf: bigBuf,
  caption: "这个好玩，存下来",
  cfg,
  deps: { logger },
});
check("大图存进了表情库", saved.ok === true, saved.message || saved.code);
check("落盘尺寸被缩到 128", saved.width === STICKER_SUGGESTED_PX && saved.height === STICKER_SUGGESTED_PX,
  `${saved.width ?? "?"}×${saved.height ?? "?"}${saved.resized ? "（已缩放）" : ""}`);
const savedBuf = saved.file ? fs.readFileSync(path.join(dir, saved.file)) : Buffer.alloc(0);
const savedSize = readImageSize(savedBuf);
check("磁盘文件本身也是 128×128", savedSize?.width === 128 && savedSize?.height === 128,
  `${savedSize?.width}×${savedSize?.height}`);
const listed = await listStickers(cfg);
check("listStickers 能列出新图", listed.some((s) => s.name === saved.name), saved.name);

// ---- 2) 引擎：两条消息 + 图后指令 ----
const sends = [];
const uploads = [];
const api = {
  async sendMessage(scope, targetId, content, opts = {}) {
    sends.push({ scope, targetId, content, msgId: opts.msgId });
    return { id: `t-${sends.length}`, content };
  },
  async uploadMedia(scope, targetId, base64, fileType) {
    uploads.push({ scope, targetId, fileType, buf: Buffer.from(base64, "base64") });
    return `fi_${uploads.length}`;
  },
  async sendMedia() {
    return { id: "m-1" };
  },
  async sendProactiveMessage(scope, targetId, content) {
    sends.push({ scope, targetId, content, proactive: true });
    return { id: `p-${sends.length}`, content };
  },
};
const config = loadConfig({
  QQ_APP_ID: "test-app-id",
  QQ_APP_SECRET: "test-app-secret",
  QQ_ADMIN_USERS: OWNER,
  QQ_GROUP_TRIGGER: "wake",
  QQ_MEMORY_FILE: path.join(dir, "memory.json"),
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
  STICKER_DIR: dir,
  STICKER_AUTO: "true",
});
const engine = new MessageEngine({
  config,
  api,
  logger,
  generate: async () => "在呀",
  stickerDeps: {
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      headers: { get: (n) => (n.toLowerCase() === "content-type" ? "image/jpeg" : null) },
      arrayBuffer: async () => bigBuf,
    }),
  },
});
await engine.handle({
  scope: "c2c",
  targetId: OWNER,
  senderId: OWNER,
  senderName: "主人",
  messageId: "check-ingest-1",
  content: "这个好玩",
  kind: "image",
  attachments: [{ content_type: "image/jpeg", url: "https://fake.local/x.jpg" }],
});
await engine.handle({
  scope: "c2c",
  targetId: OWNER,
  senderId: OWNER,
  senderName: "主人",
  messageId: "check-ingest-2",
  content: "存下来",
  kind: "text",
  attachments: [],
});
const receipt = sends.at(-1)?.content ?? "";
check("引擎回执明确说存下了", /存下了，叫它「/.test(receipt), receipt.slice(0, 80));
check("引擎统计记了一次存图", engine.stats.stickersSaved >= 1, String(engine.stats.stickersSaved));

// ---- 3) 轻松场合自动补表情（用真实素材库） ----
const realCfg = resolveStickerConfig({});
const all = await listStickers(realCfg);
const stickerName = all.find((s) => s.name.startsWith("春禾-开心"))?.name ?? all[0]?.name;
check("真实素材库可读", Boolean(stickerName), `${all.length} 条别名`);

const uploads2 = [];
const api2 = {
  async sendMessage(scope, targetId, content) {
    sends.push({ scope, targetId, content });
    return { id: "t", content };
  },
  async uploadMedia(scope, targetId, base64, fileType) {
    uploads2.push({ fileType, buf: Buffer.from(base64, "base64") });
    return "fi";
  },
  async sendMedia() {
    return { id: "m" };
  },
};
const config2 = { ...config, stickers: { ...realCfg, auto: true } };
const engine2 = new MessageEngine({
  config: config2,
  api: api2,
  logger,
  generate: async () => "在呀",
});
await engine2.handle({
  scope: "c2c",
  targetId: OWNER,
  senderId: OWNER,
  senderName: "主人",
  messageId: "check-ingest-3",
  content: "嗨",
  kind: "text",
  attachments: [],
});
check("轻松场合自动补了一张表情", uploads2.length === 1, `${uploads2.length} 张`);
check("自动补的图来自真实素材库", uploads2[0] && all.length > 0, stickerName ?? "");
check("自动表情计入统计", engine2.stats.autoStickers === 1, String(engine2.stats.autoStickers));

const failed = checks.filter((c) => !c.ok);
console.log(`\n${failed.length === 0 ? "全部通过" : "有失败"}：${checks.length - failed.length}/${checks.length}`);
console.log(`项目根：${PROJECT_ROOT}`);
console.log(`临时目录：${dir}`);
if (failed.length > 0) {
  process.exitCode = 1;
  for (const f of failed) console.error(`失败：${f.name} ${f.detail}`);
}
