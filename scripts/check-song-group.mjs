#!/usr/bin/env node
/**
 * check-song-group.mjs — 不掉线、不联网，验证"群里唱歌"走的到底是哪条 HTTP 路径。
 *
 * 做法：用**真实**的 `QQApi`（src/qq/api.js）+ 一个只记账的假 fetch，
 * 这样断言的是真实 URL / 真实请求体，而不是"我以为它会调哪个函数"：
 *
 *   群聊：POST /v2/groups/{group_openid}/files   上传
 *        POST /v2/groups/{group_openid}/messages 发送（msg_type=7 + msg_id）
 *   单聊：POST /v2/users/{openid}/files
 *        POST /v2/users/{openid}/messages
 *
 * 同时验证最要紧的一条：**群聊发不出去时，发出去的必须是实话，不是模型编的歌词**。
 *
 * 用法：node scripts/check-song-group.mjs
 * 不会碰 data/ 里的真实记忆（全部指向临时文件），也不会连 QQ。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { loadConfig } from "../src/config.js";
import { QQApi } from "../src/qq/api.js";
import { MessageEngine } from "../src/core/engine.js";
import { defaultLibraryDir, listLibrarySongs } from "../src/media/sing.js";

const TOKEN = "fake-access-token";
let failures = 0;
function check(ok, label, detail = "") {
  if (ok) {
    console.log(`  ✔ ${label}`);
  } else {
    failures += 1;
    console.log(`  ✖ ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

/** 假 fetch：按 URL 返回平台形状的 JSON，并把每次调用记下来 */
function makeFetch(log, { failGroupUpload = false } = {}) {
  return async (url, init = {}) => {
    const method = init.method ?? "GET";
    const u = new URL(url);
    const entry = { method, path: u.pathname, body: init.body ? JSON.parse(init.body) : null };
    log.push(entry);
    const json = (obj) => ({
      ok: true,
      status: 200,
      headers: { get: () => "application/json" },
      text: async () => JSON.stringify(obj),
    });

    if (u.pathname === "/app/getAppAccessToken") {
      return json({ access_token: TOKEN, expires_in: 7200 });
    }
    if (u.pathname.endsWith("/files")) {
      if (failGroupUpload && entry.path.startsWith("/v2/groups/")) {
        return {
          ok: false,
          status: 403,
          headers: { get: () => "application/json" },
          text: async () => JSON.stringify({ code: 40034, message: "no permission" }),
        };
      }
      return json({ file_info: `fi_${log.length}` });
    }
    if (u.pathname.endsWith("/messages")) {
      return json({ id: `msg_${log.length}`, timestamp: new Date().toISOString() });
    }
    return json({});
  };
}

function makeEngine({ log, failGroupUpload = false }) {
  const cfg = loadConfig({
    QQ_APP_ID: "1000",
    QQ_APP_SECRET: "secret",
    QQ_SING_ENABLED: "true",
    QQ_MULTI_MESSAGE: "false",
    QQ_AI_LABEL_STYLE: "none",
    AI_LABEL: "",
    SING_LIBRARY_GAP_MS: "0",
    QQ_MEMORY_FILE: path.join(os.tmpdir(), `chk-song-memory-${process.pid}.json`),
    QQ_TOPIC_FILE: path.join(os.tmpdir(), `chk-song-topics-${process.pid}.json`),
    QQ_REMINDER_FILE: path.join(os.tmpdir(), `chk-song-rem-${process.pid}.json`),
    QQ_OWNER_MEMORY_FILE: path.join(os.tmpdir(), `chk-song-owner-${process.pid}.json`),
  });
  const api = new QQApi({
    appId: "1000",
    clientSecret: "secret",
    apiBase: "https://api.example.invalid",
    tokenBase: "https://bots.example.invalid",
    fetchImpl: makeFetch(log, { failGroupUpload }),
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  });
  const engine = new MessageEngine({
    config: cfg,
    api,
    generate: async () => "好呀～",
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  });
  return engine;
}

const groupMsg = (text, id = "GMSG-1") => ({
  scope: "group",
  rawEventType: "GROUP_AT_MESSAGE_CREATE",
  senderId: "member-1",
  senderName: "闲人",
  content: text,
  messageId: id,
  groupOpenid: "GROUPOPENID123",
  targetId: "GROUPOPENID123",
  kind: "text",
  attachments: [],
});

const c2cMsg = (text, id = "CMSG-1") => ({
  scope: "c2c",
  rawEventType: "C2C_MESSAGE_CREATE",
  senderId: "user-1",
  senderName: "主人",
  content: text,
  messageId: id,
  targetId: "USEROPENID456",
  kind: "text",
  attachments: [],
});

const FAKE_LYRICS = "晚风吹动樱花草\n月光洒在你眉梢\n想说的话都藏好\n只等你回头笑";

async function main() {
  const libDir = defaultLibraryDir({});
  console.log(`[check] 曲库：${libDir}`);
  const songs = await listLibrarySongs({ dir: libDir });
  console.log(`[check] 曲库条目 ${songs.length} 个：${[...new Set(songs.map((s) => s.name))].join("、")}`);
  if (!songs.length) throw new Error("曲库为空，先确认 SILK 文件在不在");

  // ------------------------------------------------ 1) 群聊点歌：真走群路径
  console.log("\n[1] 群聊「@春禾 唱首樱花草听听」→ 应当走群文件上传 + 群消息发送");
  {
    const log = [];
    const engine = makeEngine({ log });
    const res = await engine.send(groupMsg("<@!1> 唱首樱花草听听"), "好呀～");

    const uploads = log.filter((e) => e.method === "POST" && e.path.endsWith("/files"));
    const sends = log.filter((e) => e.method === "POST" && e.path.endsWith("/messages"));
    const toUsers = log.filter((e) => e.path.startsWith("/v2/users/"));

    check(res.song === true, "结果标记为「唱了」(song=true)", JSON.stringify(res));
    check(uploads.length === 5, `5 段全部上传（实际 ${uploads.length}）`);
    check(
      uploads.every((e) => e.path === "/v2/groups/GROUPOPENID123/files"),
      "上传路径是 /v2/groups/{group_openid}/files",
      uploads.map((e) => e.path).join(","),
    );
    check(toUsers.length === 0, "全程没有误用 /v2/users/（这就是原来的 bug）");
    check(
      sends.every((e) => e.path === "/v2/groups/GROUPOPENID123/messages"),
      "发送路径是 /v2/groups/{group_openid}/messages",
      sends.map((e) => e.path).join(","),
    );
    check(sends.every((e) => e.body.msg_type === 7), "msg_type=7（语音）");
    check(sends.every((e) => e.body.msg_id === "GMSG-1"), "每条都带 msg_id（被动回复，不烧主动配额）");
    const seqs = sends.map((e) => e.body.msg_seq);
    check(
      seqs.length === 5 && seqs.every((v, i) => i === 0 || v > seqs[i - 1]),
      `msg_seq 严格递增：${seqs.join(",")}`,
    );
    check(sends.every((e) => e.body.media?.file_info), "每条都带 media.file_info");
  }

  // ------------------------------------------------ 2) 单聊点歌：老路径不变
  console.log("\n[2] 单聊「唱首樱花草听听」→ 应当仍走 C2C 路径");
  {
    const log = [];
    const engine = makeEngine({ log });
    const res = await engine.send(c2cMsg("唱首樱花草听听"), "好呀～");
    const uploads = log.filter((e) => e.method === "POST" && e.path.endsWith("/files"));
    const sends = log.filter((e) => e.method === "POST" && e.path.endsWith("/messages"));
    check(res.song === true, "单聊也唱出来了");
    check(
      uploads.length === 5 && uploads.every((e) => e.path === "/v2/users/USEROPENID456/files"),
      "单聊上传路径仍是 /v2/users/{openid}/files",
    );
    check(
      sends.every((e) => e.path === "/v2/users/USEROPENID456/messages" && e.body.msg_id === "CMSG-1"),
      "单聊发送路径与 msg_id 保持不变",
    );
  }

  // ------------------------------------------------ 3) 群聊发不出去：必须说实话
  console.log("\n[3] 群聊上传被平台拒绝（模拟没权限/网络失败）→ 只能回实话，不许回歌词");
  {
    const log = [];
    const engine = makeEngine({ log, failGroupUpload: true });
    const res = await engine.send(groupMsg("<@!1> 唱首樱花草听听"), FAKE_LYRICS);

    const texts = log.filter(
      (e) => e.method === "POST" && e.path.endsWith("/messages") && e.body?.msg_type === 0,
    );
    const sent = texts.map((e) => e.body.content).join("\n");
    console.log(`      实际回给群里的是：「${sent}」`);
    check(res.song !== true, "没唱成就不标记成唱了");
    check(texts.length === 1, `失败也要回一句（实际 ${texts.length} 条文字）`);
    check(!sent.includes("晚风吹动樱花草"), "编造的歌词一个字都没发出去");
    check(/没发出去|发不出|没声音|唱不了|没唱成/.test(sent), "如实说了没发出去");
    check(texts.every((e) => e.body.msg_id === "GMSG-1"), "失败回复同样走被动回复");
  }

  // ------------------------------------------------ 4) 曲库没这首：说不会
  console.log("\n[4] 群里点一首曲库没有的歌 → 说「不会」，不许拿合成/歌词顶替");
  {
    const log = [];
    const engine = makeEngine({ log });
    const res = await engine.send(groupMsg("<@!1> 唱首小星星"), "好呀～");
    const uploads = log.filter((e) => e.path.endsWith("/files"));
    const texts = log.filter((e) => e.body?.msg_type === 0).map((e) => e.body.content).join("\n");
    console.log(`      实际回给群里的是：「${texts}」`);
    check(res.song !== true, "没唱成");
    check(uploads.length === 0, "一个音频都没传（不许拿稻香顶替）");
    check(/还没学会|不会|没学会/.test(texts), "说清楚这首不会");
    check(texts.includes("小星星"), "点名是哪一首");
  }

  console.log(failures === 0 ? "\n[check] 全部通过 ✅" : `\n[check] 有 ${failures} 项失败 ❌`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("[check] 失败：", err?.stack ?? err);
  process.exit(1);
});
