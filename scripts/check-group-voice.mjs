#!/usr/bin/env node
/**
 * check-group-voice.mjs — 不掉线、不发 QQ，验证「群聊语音」到底走了哪条 HTTP 路径。
 *
 * 与 check-song-group.mjs 同一套做法：**真实 QQApi + 只记账的假 fetch**，
 * 断言真实 URL 与请求体；语音合成默认注入假实现（不碰 Python/GPU），
 * 加 `--real` 才跑真实 TTS→RVC→SILK（仍不连 QQ）。
 *
 * 验证：
 *   1. 群里明确「用语音说」→ POST /v2/groups/{gid}/files + /messages（msg_type=7, msg_id=被动）
 *   2. 群里普通消息 → 只有 msg_type=0 文字，不误触发语音
 *   3. 私聊「在群里用语音说晚安」→ 主动群语音（msg_type=7, **无 msg_id**）+ 私聊如实回执
 *   4. 私聊问「你现在能在群里发语音吗」而模型答「做不到」→ 发送前被替换成真话
 *
 * 用法：node scripts/check-group-voice.mjs [--real]
 * 不碰 data/（全部临时文件），不连 QQ 网关。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { loadConfig, parseDotenv } from "../src/config.js";
import { QQApi } from "../src/qq/api.js";
import { MessageEngine } from "../src/core/engine.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const REAL = process.argv.includes("--real");

const SILK = Buffer.concat([
  Buffer.from("\x02#!SILK_V3", "latin1"),
  Buffer.from([0x00, 0x01, 0x02, 0x03]),
]);

let failures = 0;
function check(ok, label, detail = "") {
  if (ok) console.log(`  ✔ ${label}`);
  else {
    failures += 1;
    console.log(`  ✖ ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

function loadEnv() {
  const file = path.join(ROOT, ".env");
  return fs.existsSync(file) ? parseDotenv(fs.readFileSync(file, "utf8")) : {};
}

/** 假 fetch：按 URL 返回平台形状 JSON，并记录每一次调用 */
function makeFetch(log) {
  return async (url, init = {}) => {
    const method = init.method ?? "GET";
    const u = new URL(url);
    const entry = {
      method,
      path: u.pathname,
      body: init.body ? JSON.parse(init.body) : null,
    };
    log.push(entry);
    const json = (obj) => ({
      ok: true,
      status: 200,
      headers: { get: () => "application/json" },
      text: async () => JSON.stringify(obj),
    });
    if (u.pathname === "/app/getAppAccessToken") {
      return json({ access_token: "fake-token", expires_in: 7200 });
    }
    if (u.pathname.endsWith("/files")) return json({ file_info: `fi_${log.length}` });
    if (u.pathname.endsWith("/messages")) {
      return json({ id: `msg_${log.length}`, timestamp: new Date().toISOString() });
    }
    return json({});
  };
}

function makeEngine({ log, env = {}, synth, generate = async () => "好呀～" }) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "chk-group-voice-"));
  const docEnv = loadEnv();
  const config = loadConfig({
    ...docEnv,
    ...env,
    QQ_APP_ID: "1000",
    QQ_APP_SECRET: "secret",
    QQ_ADMIN_USERS: OWNER,
    QQ_GROUP_TRIGGER: "mention",
    QQ_MULTI_MESSAGE: "false",
    QQ_AI_LABEL_STYLE: "none",
    AI_LABEL: "",
    QQ_SING_ENABLED: "false",
    QQ_PENDING_ACTIONS: "true",
    QQ_PENDING_DELIVERY: "proactive",
    QQ_REMINDERS: "false",
    QQ_PROACTIVE: "false",
    QQ_RATE_LIMIT_PER_MINUTE: "1000",
    QQ_MEMORY_FILE: path.join(tmp, "memory.json"),
    QQ_TOPIC_FILE: path.join(tmp, "topics.json"),
    QQ_OWNER_MEMORY_FILE: path.join(tmp, "owner-memory.json"),
    QQ_PENDING_FILE: path.join(tmp, "pending-actions.json"),
    QQ_REMINDER_FILE: path.join(tmp, "reminders.json"),
    QQ_GROUPS_FILE: path.join(tmp, "groups.json"),
    QQ_PROACTIVE_QUOTA_FILE: path.join(tmp, "proactive-quota.json"),
    QQ_SESSION_FILE: path.join(tmp, "session.json"),
  });
  const api = new QQApi({
    appId: "1000",
    clientSecret: "secret",
    apiBase: "https://api.example.invalid",
    tokenBase: "https://bots.example.invalid",
    fetchImpl: makeFetch(log),
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  });
  const engine = new MessageEngine({
    config,
    api,
    generate,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    ttsSynth:
      synth ??
      (async () => ({ ok: true, silk: SILK, durationMs: 2400, timings: { total: 5 } })),
  });
  return { engine, config, tmp };
}

const GROUP = "GROUP_OPENID_VOICE_1";
const OWNER = "OWNER_OPENID_VOICE_1";
let seq = 0;

const groupMsg = (text) => ({
  scope: "group",
  rawEventType: "GROUP_AT_MESSAGE_CREATE",
  senderId: OWNER,
  senderName: "主人",
  memberRole: "member",
  content: `<@!1> ${text}`,
  messageId: `gv-g-${++seq}`,
  groupOpenid: GROUP,
  targetId: GROUP,
  kind: "text",
  attachments: [],
});

const c2cMsg = (text) => ({
  scope: "c2c",
  rawEventType: "C2C_MESSAGE_CREATE",
  senderId: OWNER,
  senderName: "主人",
  targetId: OWNER,
  messageId: `gv-c-${++seq}`,
  content: text,
  kind: "text",
  attachments: [],
});

const filePosts = (log) => log.filter((e) => e.method === "POST" && e.path.endsWith("/files"));
const msgPosts = (log) => log.filter((e) => e.method === "POST" && e.path.endsWith("/messages"));

async function main() {
  console.log(`[check] 群语音链路（${REAL ? "真实 TTS/RVC" : "假合成器"}）`);

  // ---- 1) 群聊明确语音请求 → 群语音管道 ----
  console.log("\n[1] 群里「用语音说句晚安」→ /v2/groups/{gid}/files + /messages");
  {
    const log = [];
    const { engine } = makeEngine({ log, env: { TTS_ALLOW_GROUP: "on-demand" } });
    const res = await engine.handle(groupMsg("用语音说句晚安"));
    const files = filePosts(log);
    const msgs = msgPosts(log);
    check(res.voice === true, "结果标记为真的发了语音", JSON.stringify(res));
    check(files.length === 1, `上传 1 条（实际 ${files.length}）`);
    check(
      files[0]?.path === `/v2/groups/${GROUP}/files`,
      "上传路径是 /v2/groups/{group_openid}/files",
      files.map((f) => f.path).join(","),
    );
    check(files[0]?.body?.file_type === 3, "file_type=3（语音）");
    const data = String(files[0]?.body?.file_data ?? "");
    check(
      Buffer.from(data, "base64").subarray(0, 10).toString("latin1") === "\x02#!SILK_V3",
      "上传内容是 tencent SILK",
    );
    check(
      msgs.length === 1 && msgs[0].path === `/v2/groups/${GROUP}/messages`,
      "发送路径是 /v2/groups/{group_openid}/messages",
      msgs.map((m) => m.path).join(","),
    );
    check(msgs[0]?.body?.msg_type === 7, "msg_type=7（语音）");
    check(Boolean(msgs[0]?.body?.msg_id), "带 msg_id（被动回复，不烧主动配额）");
    check(
      !log.some((e) => e.path.startsWith("/v2/users/")),
      "全程没有误用 /v2/users/ 管道",
    );
    if (REAL) console.log(`      timings=${JSON.stringify(res.timings ?? null)}`);
  }

  // ---- 2) 群聊普通消息 → 文字 ----
  console.log("\n[2] 群里「今天天气不错」→ 只发文字");
  {
    const log = [];
    const { engine } = makeEngine({ log, env: { TTS_ALLOW_GROUP: "on-demand" } });
    await engine.handle(groupMsg("今天天气不错"));
    const files = filePosts(log);
    const msgs = msgPosts(log);
    check(files.length === 0, "没有语音上传");
    check(msgs.length === 1 && msgs[0].body?.msg_type === 0, "只发了一条文字（msg_type=0）");
  }

  // ---- 3) 私聊下令 → 主动群语音 ----
  console.log("\n[3] 私聊「在群里用语音说晚安」→ 主动群语音（无 msg_id）+ 私聊回执");
  {
    const log = [];
    const { engine } = makeEngine({ log, env: { TTS_ALLOW_GROUP: "on-demand" } });
    engine.groups.observe({ groupOpenid: GROUP, senderOpenid: OWNER });
    await engine.handle(c2cMsg("在群里用语音说晚安"));
    const files = filePosts(log);
    const msgs = msgPosts(log);
    const groupVoice = msgs.filter(
      (m) => m.path === `/v2/groups/${GROUP}/messages` && m.body?.msg_type === 7,
    );
    const c2cText = msgs.filter(
      (m) => m.path === `/v2/users/${OWNER}/messages` && m.body?.msg_type === 0,
    );
    check(files.length === 1, `上传 1 条群语音（实际 ${files.length}）`);
    check(
      files[0]?.path === `/v2/groups/${GROUP}/files`,
      "主动语音也走 /v2/groups/{openid}/files",
      files.map((f) => f.path).join(","),
    );
    check(groupVoice.length === 1, "群里收到 1 条语音消息");
    check(groupVoice[0]?.body?.msg_id === undefined, "主动消息不带 msg_id");
    check(c2cText.length === 1, "私聊收到 1 条回执");
    const receipt = String(c2cText[0]?.body?.content ?? "");
    console.log(`      回执：「${receipt}」`);
    check(/语音/.test(receipt) && /已经|发到群里/.test(receipt), "回执说清是语音、已发到群里");
    check(!/没发出去|没发到/.test(receipt), "回执没有谎报失败");
    const stored = engine.pendingActions.listAll().find((a) => a.kind === "voice");
    check(stored?.status === "done", "待办已结清");
  }

  // ---- 4) 「群里发不了语音」的自我否认 → 代码闸门纠正 ----
  console.log("\n[4] 私聊问「群里能发语音吗」而模型答「做不到」→ 发送前替换成真话");
  {
    const log = [];
    const { engine } = makeEngine({
      log,
      env: { TTS_ALLOW_GROUP: "on-demand" },
      generate: async () => "做不到，群里发不了语音。",
    });
    await engine.handle(c2cMsg("你现在能在群里发语音吗？"));
    const texts = msgPosts(log)
      .filter((m) => m.body?.msg_type === 0)
      .map((m) => String(m.body?.content ?? ""));
    console.log(`      实际回复：「${texts.join(" / ")}」`);
    check(texts.length === 1, "回了一条文字");
    check(!/做不到|发不了/.test(texts[0] ?? ""), "没有把已实现的能力说成做不到");
    check(/语音/.test(texts[0] ?? "") && /用语音说|明确/.test(texts[0] ?? ""), "说清了群聊需明确要求");
    check(engine.stats.voiceCapabilityCorrected === 1, "纠偏统计 +1");
  }

  console.log(failures === 0 ? "\n[check] 全部通过 ✅" : `\n[check] 有 ${failures} 项失败 ❌`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("[check] 失败：", err?.stack ?? err);
  process.exit(1);
});
