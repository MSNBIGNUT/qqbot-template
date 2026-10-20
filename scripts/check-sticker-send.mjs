/**
 * 真机链路验证（假 api 注入，不连 QQ、不启动第二个机器人）。
 *
 * 目的：证明「模型选出新表情 → 引擎真的把它当图片上传并发出去」这条链路是通的，
 * 而不只是 executeStickerCall 返回了一个 base64。
 *
 * 做法：
 *   - 用真实 MessageEngine + 真实表情包文件；
 *   - 假 api 记录 uploadMedia / sendMedia 的入参（真机上这两个方法才会打 QQ 接口）；
 *   - 假人格层里调用真实的 executeStickerCall("send_sticker", {name:"春禾-星星眼"})，
 *     把返回的 images 挂到 ctx.generatedImages（与 makeModelGenerator 的契约一致）。
 *
 * 用法：node scripts/check-sticker-send.mjs
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { MessageEngine } from "../src/core/engine.js";
import { loadConfig } from "../src/config.js";
import { createLogger } from "../src/util/log.js";
import {
  PROJECT_ROOT,
  executeStickerCall,
  readImageSize,
  resolveStickerConfig,
  STICKER_TOOL_NAME,
} from "../src/media/stickers.js";

const logger = createLogger("silent");
const OWNER = "OWNER_OPENID_0001";
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qqbot-sticker-check-"));

const uploads = [];
const mediaSends = [];
const texts = [];
const api = {
  async uploadMedia(scope, targetId, base64, fileType) {
    uploads.push({ scope, targetId, base64, fileType });
    return { file_uuid: "fake-uuid", file_info: "fake-file-info", ttl: 60 };
  },
  async sendMedia(scope, targetId, fileInfo, opts = {}) {
    mediaSends.push({ scope, targetId, fileInfo, opts });
    return { id: `fake-media-${mediaSends.length}` };
  },
  async sendMessage(scope, targetId, content, opts = {}) {
    texts.push({ scope, targetId, content, opts });
    return { id: `fake-text-${texts.length}`, content };
  },
  async sendProactiveMessage(scope, targetId, content) {
    texts.push({ scope, targetId, content, proactive: true });
    return { id: `fake-p-${texts.length}` };
  },
};

const config = loadConfig({
  QQ_APP_ID: "test-app-id",
  QQ_APP_SECRET: "test-app-secret",
  QQ_GROUP_TRIGGER: "all",
  QQ_ADMIN_USERS: OWNER,
  QQ_MEMORY_FILE: path.join(dir, "memory.json"),
  QQ_TOPIC_FILE: path.join(dir, "topics.json"),
  QQ_REMINDERS: "false",
  QQ_MULTI_MESSAGE: "false",
  QQ_VOICE_REPLY: "off",
  QQ_SING_ENABLED: "false",
  QQ_PROACTIVE: "false",
  // 与 config.js 的读取键一致（不是 QQ_STICKER_DIR，写错会静默回退默认目录）
  STICKER_DIR: path.join(PROJECT_ROOT, "assets", "stickers"),
});

const PICK = "春禾-星星眼";
let picked = null;

const engine = new MessageEngine({
  config,
  api,
  logger,
  generate: async (ctx) => {
    // 真正走一次「工具调用」：同一个函数模型会调，参数就用 enum 里的名字
    const res = await executeStickerCall(
      STICKER_TOOL_NAME,
      JSON.stringify({ name: PICK }),
      resolveStickerConfig({}),
    );
    if (!res.ok) throw new Error(`executeStickerCall 失败：${res.content}`);
    ctx.generatedImages = res.images;
    picked = res.images[0];
    return "喏，星星眼给你～";
  },
});

const messageId = "sticker-check-1";
await engine.handle({
  scope: "c2c",
  targetId: OWNER,
  senderId: OWNER,
  senderName: "主人",
  messageId,
  content: "发个星星眼给我看看",
  kind: "text",
  attachments: [],
});

const checks = [];
const check = (name, ok, detail = "") => {
  checks.push({ name, ok, detail });
  console.log(`${ok ? "✔" : "✘"} ${name}${detail ? ` — ${detail}` : ""}`);
};

const disk = fs.readFileSync(path.join(PROJECT_ROOT, "assets", "stickers", `${PICK}.jpg`));
const size = readImageSize(disk);

check("模型/工具选中了表情包", picked?.name === PICK, picked?.name ?? "null");
check("引擎调用了 uploadMedia（图片真的被上传）", uploads.length === 1, `${uploads.length} 次`);
check("上传的是 file_type=1（图片）", uploads[0]?.fileType === 1, String(uploads[0]?.fileType));
check(
  "上传内容与磁盘文件逐字节一致",
  uploads[0]?.base64 === disk.toString("base64"),
  `磁盘 ${disk.length} 字节`,
);
check(
  "上传的是 128×128（QQ 气泡尺寸）",
  size?.width === 128 && size?.height === 128,
  `${size?.width}×${size?.height}`,
);
check("引擎调用了 sendMedia 发图", mediaSends.length === 1, `${mediaSends.length} 次`);
check("发图带了 msg_id（被动回复约束）", mediaSends[0]?.opts?.msgId === messageId, String(mediaSends[0]?.opts?.msgId));
check("随后发了文字", texts.length >= 1 && /星星眼/.test(texts[0]?.content ?? ""), texts[0]?.content ?? "");

const failed = checks.filter((c) => !c.ok);
console.log(
  `\n${failed.length === 0 ? "全部通过" : "有失败"}：${checks.length - failed.length}/${checks.length}`,
);
if (failed.length > 0) {
  process.exitCode = 1;
  for (const f of failed) console.error(`失败：${f.name} ${f.detail}`);
}
