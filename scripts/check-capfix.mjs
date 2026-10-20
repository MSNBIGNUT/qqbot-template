#!/usr/bin/env node
/**
 * check-capfix.mjs — 三个真机问题的链路验证（不重启春禾、不发真消息）。
 *
 * 复现的真实输入（data/live.err / live.log，2026-10-17 22:20 与 22:22）：
 *   1. 私聊「能在群里@晴空吗」→ 模型说「私聊没法推到群里」，回执却说「已经发到群里啦」；
 *   2. 私聊「群里发下」→ 被解析成动作「发下」，真的往群里发了一条叫「发下」的消息；
 *   3. 私聊「看看你卖萌的样子」→ 只回文字，没有发表情包。
 *
 * 做法：
 *   - 真实 MessageEngine + 真实表情包文件；
 *   - A 段用**真实 QQApi + 假 fetch**，断言群聊发图走的是
 *     POST /v2/groups/{gid}/files → POST /v2/groups/{gid}/messages（msg_type=7）；
 *   - B 段用假 api（只记账）跑真实引擎，断言文本里不再自相矛盾、动作不再是「发下」。
 *
 * 用法：node scripts/check-capfix.mjs
 * 不碰 data/（全部临时文件），不连 QQ，不启动第二个机器人。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { MessageEngine } from "../src/core/engine.js";
import { loadConfig } from "../src/config.js";
import { createLogger } from "../src/util/log.js";
import { QQApi } from "../src/qq/api.js";
import { PROJECT_ROOT, executeStickerCall } from "../src/media/stickers.js";

const logger = createLogger("silent");
const OWNER = "OWNER_CAPFIX_0001";
const GROUP = "GROUP_CAPFIX_90A0";
const STICKER_DIR = path.join(PROJECT_ROOT, "assets", "stickers");

let failures = 0;
function check(ok, label, detail = "") {
  if (ok) console.log(`  ✔ ${label}`);
  else {
    failures += 1;
    console.log(`  ✖ ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "qqbot-capfix-"));
}

function baseConfig() {
  const dir = tmpDir();
  return loadConfig({
    QQ_APP_ID: "test-app-id",
    QQ_APP_SECRET: "test-app-secret",
    QQ_GROUP_TRIGGER: "all",
    QQ_ADMIN_USERS: OWNER,
    QQ_MEMORY_FILE: path.join(dir, "memory.json"),
    QQ_TOPIC_FILE: path.join(dir, "topics.json"),
    QQ_OWNER_MEMORY_FILE: path.join(dir, "owner-memory.json"),
    QQ_PENDING_FILE: path.join(dir, "pending-actions.json"),
    QQ_REMINDER_FILE: path.join(dir, "reminders.json"),
    QQ_GROUPS_FILE: path.join(dir, "groups.json"),
    QQ_PROACTIVE_QUOTA_FILE: path.join(dir, "proactive-quota.json"),
    QQ_PENDING_DELIVERY: "proactive",
    QQ_GROUP_PROACTIVE_DAILY_LIMIT: "1000",
    QQ_GROUP_PROACTIVE_MINUTE_LIMIT: "20",
    QQ_PENDING_PROACTIVE_DAILY_LIMIT: "20",
    QQ_GROUP_DEFAULT_PICK: "active",
    QQ_REMINDERS: "false",
    QQ_MULTI_MESSAGE: "false",
    QQ_VOICE_REPLY: "off",
    QQ_SING_ENABLED: "false",
    QQ_PROACTIVE: "false",
    QQ_RATE_LIMIT_PER_MINUTE: "1000",
    STICKER_DIR,
  });
}

let seq = 0;
const c2c = (text) => ({
  scope: "c2c",
  targetId: OWNER,
  senderId: OWNER,
  senderName: "主人",
  messageId: `capfix-c2c-${(seq += 1)}`,
  content: text,
  kind: "text",
  attachments: [],
});
const group = (text) => ({
  scope: "group",
  targetId: GROUP,
  groupOpenid: GROUP,
  senderId: OWNER,
  senderName: "群主",
  memberRole: "owner",
  rawEventType: "GROUP_AT_MESSAGE_CREATE",
  messageId: `capfix-g-${(seq += 1)}`,
  content: `<@!123> ${text}`,
  kind: "text",
  attachments: [],
});

function seedGroup(engine) {
  for (const id of [OWNER, "m1", "m2", "m3", "m4", "m5", "m6", "m7"]) {
    engine.groups.observe({ groupOpenid: GROUP, senderOpenid: id });
  }
  engine.groups.addMessages(GROUP, 50);
}

// ---------------------------------------------------------------------------
// A) 真实 QQApi + 假 fetch：群聊表情包到底打哪些 HTTP 路径
// ---------------------------------------------------------------------------
async function partA() {
  console.log("\n[A] 真实 QQApi + 假 fetch：群聊发表情包走哪条 HTTP 路径");
  const log = [];
  const json = (obj) => ({
    ok: true,
    status: 200,
    headers: { get: () => "application/json" },
    text: async () => JSON.stringify(obj),
  });
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(String(url));
    const entry = {
      method: init.method ?? "GET",
      path: u.pathname,
      body: init.body ? JSON.parse(init.body) : null,
    };
    log.push(entry);
    if (u.pathname === "/app/getAppAccessToken") {
      return json({ access_token: "capfix-token", expires_in: 7200 });
    }
    if (u.pathname.endsWith("/members")) return json({ members: [] });
    if (u.pathname.endsWith("/files")) return json({ file_info: "CAPFIX_FILE_INFO" });
    return json({ id: "capfix-msg-1" });
  };

  const api = new QQApi({
    appId: "1",
    clientSecret: "s",
    apiBase: "https://fake.local",
    tokenBase: "https://fake.local",
    fetchImpl,
    logger,
  });
  const config = baseConfig();
  const engine = new MessageEngine({
    config,
    api,
    logger,
    generate: async () => "喏，表情包来啦～",
  });
  seedGroup(engine);

  await engine.handle(group("发个表情包"));

  const files = log.filter((e) => e.path.endsWith("/files"));
  const messages = log.filter((e) => e.path.endsWith("/messages"));
  check(
    files.length === 1 && files[0].path === `/v2/groups/${GROUP}/files`,
    "上传走 POST /v2/groups/{gid}/files",
    files.map((f) => f.path).join(","),
  );
  check(
    messages.length >= 1 && messages.every((m) => m.path === `/v2/groups/${GROUP}/messages`),
    "发送走 POST /v2/groups/{gid}/messages",
    messages.map((m) => m.path).join(","),
  );
  check(
    !log.some((e) => e.path.startsWith("/v2/users/")),
    "没有误走单聊路径 /v2/users/…",
  );
  const mediaMsg = messages.find((m) => m.body?.msg_type === 7);
  const sent = mediaMsg?.body ?? {};
  check(Boolean(mediaMsg), "有一条 msg_type=7 的富媒体消息", JSON.stringify(messages.map((m) => m.body?.msg_type)));
  check(sent.msg_type === 7, "msg_type=7（富媒体）", String(sent.msg_type));
  check(
    sent.media?.file_info === "CAPFIX_FILE_INFO",
    "请求体带 file_info",
    JSON.stringify(sent.media),
  );
  const upload = files[0]?.body ?? {};
  check(
    String(upload.file_data ?? "").length > 100,
    "上传请求体带 base64 图片数据",
    String(String(upload.file_data ?? "").length),
  );
  check(upload.file_type === 1, "file_type=1（图片）", String(upload.file_type));
}

// ---------------------------------------------------------------------------
// B) 假 api + 真实引擎：复现两个 WRN 的真实输入
// ---------------------------------------------------------------------------
function fakeApi() {
  const texts = [];
  const uploads = [];
  const mediaSends = [];
  return {
    texts,
    uploads,
    mediaSends,
    async sendMessage(scope, targetId, content, opts = {}) {
      texts.push({ scope, targetId, content, opts });
      return { id: `t-${texts.length}`, content };
    },
    async sendProactiveMessage(scope, targetId, content) {
      texts.push({ scope, targetId, content, proactive: true });
      return { id: `p-${texts.length}` };
    },
    async uploadMedia(scope, targetId, base64, fileType) {
      uploads.push({ scope, targetId, fileType, bytes: Buffer.from(base64, "base64").length });
      return "FI";
    },
    async sendMedia(scope, targetId, fileInfo, opts = {}) {
      mediaSends.push({ scope, targetId, fileInfo, opts });
      return { id: `m-${mediaSends.length}` };
    },
    async getGroupMembers() {
      return [];
    },
  };
}

async function partB() {
  console.log("\n[B] 假 api + 真实引擎：复现 22:20 / 22:22 的两句 WRN");

  // B1：能在群里@晴空吗 → 模型否认 + 引擎回执，不许打架
  {
    const api = fakeApi();
    const engine = new MessageEngine({
      config: baseConfig(),
      api,
      logger,
      generate: async () =>
        "私聊这边春禾没法直接推消息到群里；不过主人在群里喊一声「@晴空」，春禾回复时就会把「@晴空」写进去～真 @ 能不能转成功要看群权限。",
    });
    seedGroup(engine);
    await engine.handle(c2c("能在群里@晴空吗"));
    const reply = api.texts.filter((t) => t.scope === "c2c").at(-1)?.content ?? "";
    check(/已经发到群里/.test(reply), "回执在（已经发到群里）", reply);
    check(!/没法|做不到|不能直接推/.test(reply), "模型否认句已被回执替换", reply);
    check(
      api.texts.some((t) => t.scope === "group" && t.proactive),
      "群里真的收到了主动消息",
    );
    check(engine.stats.capabilityContradictions >= 1, "矛盾闸门计数 +1");
  }

  // B2：群里发下 → 不许发「发下」，要发贴纸
  {
    const api = fakeApi();
    const engine = new MessageEngine({
      config: baseConfig(),
      api,
      logger,
      generate: async () =>
        "〔私聊〕表情包好像只能发在当前这个窗口里，春禾没法把它直接转到群里去。主人在群里说一句「卖个萌」，春禾就在群里发给你看～",
    });
    seedGroup(engine);
    await engine.handle(c2c("群里发下"));
    const entry = engine.pendingActions.listAll().at(-1);
    check(Boolean(entry?.payload?.sticker), "待办解析成发贴纸（payload.sticker）", entry?.action);
    check(!/^发下$/.test(entry?.action ?? ""), "动作名不再是「发下」", entry?.action);
    check(
      api.uploads.length === 1 && api.uploads[0].scope === "group",
      "群聊真的上传了一张图",
      JSON.stringify(api.uploads),
    );
    check(api.uploads[0]?.fileType === 1, "file_type=1");
    check(api.mediaSends[0]?.scope === "group", "发送走群聊");
    const reply = api.texts.filter((t) => t.scope === "c2c").at(-1)?.content ?? "";
    check(/表情包已经发到群里/.test(reply), "回执说的是表情包", reply);
    check(!/没法|只能发在当前|转不到/.test(reply), "没有和回执打架的否认", reply);
    check(
      !api.texts.some((t) => String(t.content).trim() === "发下"),
      "群里没有收到一条叫「发下」的消息",
    );
  }

  // B3：看看你卖萌的样子 → 真的发卖萌表情包（不靠模型选工具）
  {
    const api = fakeApi();
    const engine = new MessageEngine({
      config: baseConfig(),
      api,
      logger,
      generate: async () => "喏～",
    });
    seedGroup(engine);
    await engine.handle(c2c("看看你卖萌的样子"));
    const want = await executeStickerCall("send_sticker", { name: "春禾-卖萌" }, {
      enabled: true,
      dir: STICKER_DIR,
      maxBytes: 2 * 1024 * 1024,
    });
    check(api.uploads.length === 1, "真的上传了一张表情包", String(api.uploads.length));
    check(api.uploads[0]?.scope === "c2c", "发在私聊会话", api.uploads[0]?.scope);
    check(
      api.uploads[0]?.bytes === Buffer.from(want.images[0].base64, "base64").length,
      "上传的就是「春禾-卖萌」那张",
      `${api.uploads[0]?.bytes} vs ${Buffer.from(want.images[0].base64, "base64").length}`,
    );
    check(api.mediaSends.length === 1, "并且真的发出去（sendMedia）");
    check(
      (api.texts.filter((t) => t.scope === "c2c").at(-1)?.content ?? "").length > 0,
      "图之后还接了话",
    );
  }
}

console.log("capfix 链路验证（假 api / 假 fetch，不连 QQ）");
await partA();
await partB();
console.log(`\n结果：${failures === 0 ? "全部通过 ✔" : `${failures} 项失败 ✖`}`);
process.exit(failures === 0 ? 0 : 1);
