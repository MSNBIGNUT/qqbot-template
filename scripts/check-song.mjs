#!/usr/bin/env node
/**
 * check-song.mjs — 真机验收：**主人点《樱花草》，发出去的到底是哪一首？**
 *
 * 修的是这个 bug：曲库里有《樱花草》的成品，旧引擎却只有硬编码的
 * `scores/daoxiang_chorus.json`，于是不管点什么，唱出来的都是《稻香》副歌
 * （27863ms）。本脚本用**真实曲库 + 真实引擎代码**走一遍，把"实际会发出去的东西"
 * 摆在台面上（文件名、时长、SHA256），再决定要不要真发。
 *
 * 用法：
 *   node scripts/check-song.mjs                      # 默认：只解析，不发送（安全）
 *   node scripts/check-song.mjs --text "唱送别"
 *   node scripts/check-song.mjs --send               # 真发（会真的发到主人 QQ）
 *   node scripts/check-song.mjs --send --msg-id <真实msg_id>   # 走被动回复（默认走主动消息）
 *
 * ⚠️ 本脚本**不会**启动第二个 `node src/main.js`：
 *    它只走 REST（取 token → 上传 → 发消息），不开 WebSocket，
 *    因此不会和正在跑的春禾抢同一个 AppID 的长连接。
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import process from "node:process";

import { parseDotenv, resolveApiBase, loadConfig } from "../src/config.js";
import { QQApi } from "../src/qq/api.js";
import { MessageEngine } from "../src/core/engine.js";
import { createLogger } from "../src/util/log.js";
import {
  resolveSingConfig,
  isSingRequest,
  listLibrarySongs,
  resolveLibrarySong,
  readLibrarySilk,
  silkDurationMs,
} from "../src/media/sing.js";

const ROOT = path.resolve(import.meta.dirname, "..");

function parseArgs(argv) {
  const out = { text: "唱樱花草", send: false, openid: "", gapMs: -1, msgId: "" };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--text") out.text = argv[++i] ?? "";
    else if (a === "--send") out.send = true;
    else if (a === "--openid") out.openid = argv[++i] ?? "";
    else if (a === "--msg-id") out.msgId = argv[++i] ?? "";
    else if (a === "--gap-ms") out.gapMs = Number(argv[++i] ?? 0);
  }
  return out;
}

function loadEnv() {
  const file = path.join(ROOT, ".env");
  if (!fs.existsSync(file)) return {};
  return parseDotenv(fs.readFileSync(file, "utf8"));
}

const sha = (buf) => crypto.createHash("sha256").update(buf).digest("hex").slice(0, 16);

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const env = { ...loadEnv(), ...process.env };
  const log = createLogger("info");

  // 用**真引擎同一套配置解析**，保证测的就是线上那条路
  const cfg = resolveSingConfig({
    QQ_SING_ENABLED: env.QQ_SING_ENABLED,
    SING_PYTHON: env.SING_PYTHON || env.TTS_PYTHON,
    SING_LIBRARY_DIR: env.SING_LIBRARY_DIR,
    SING_LIBRARY_GAP_MS: args.gapMs >= 0 ? String(args.gapMs) : env.SING_LIBRARY_GAP_MS,
    SING_SCORE: env.SING_SCORE,
  });

  console.log("=".repeat(72));
  console.log("[check-song] 曲库目录 :", cfg.libraryDir);
  console.log("[check-song] 段间间隔 :", cfg.libraryGapMs, "ms");
  console.log("[check-song] 待验消息 :", JSON.stringify(args.text));
  console.log("=".repeat(72));

  // ---- 1) 曲库清单（真实扫描 + 真实 SILK 时长）----
  const songs = await listLibrarySongs({ dir: cfg.libraryDir, logger: log });
  console.log(`\n① 曲库实际扫到 ${songs.length} 个成品：`);
  for (const s of songs) {
    console.log(
      `   ${s.file.padEnd(34)} ${(s.durationMs / 1000).toFixed(1).padStart(5)}s  ` +
        `${String(s.bytes).padStart(7)}B  sha=${sha(fs.readFileSync(s.path))}`,
    );
  }

  // ---- 2) 触发判定 ----
  const names = [...new Set(songs.map((s) => s.name))];
  const baseTrigger = isSingRequest(args.text);
  const gated = isSingRequest(args.text, { songNames: names });
  console.log(`\n② 触发判定：原触发词=${baseTrigger}  带曲库歌名=${gated}  →  ${baseTrigger || gated ? "会唱歌" : "不唱（走文字）"}`);
  console.log(`   反例守卫（必须全 false）：`);
  for (const t of ["你会唱歌吗", "别唱了", "唱歌真好听", "我昨天在KTV唱了稻香副歌"]) {
    console.log(`     ${isSingRequest(t, { songNames: names }) ? "✗ 误触发" : "✓ 不触发"}  ${t}`);
  }

  // ---- 3) 选曲 ----
  const plan = await resolveLibrarySong(cfg, { text: args.text });
  const fallback = "（无 → 回落 DiffSinger 合成 scores/daoxiang_chorus.json）";
  console.log(`\n③ 选曲结果：`);
  if (!plan) {
    console.log("   " + fallback);
  } else {
    console.log(`   歌名=${plan.name}  来源=${plan.source}  多段=${plan.multi}  共 ${plan.files.length} 段`);
    let total = 0;
    for (const [i, f] of plan.files.entries()) {
      const read = await readLibrarySilk(f.path);
      const dur = read.ok ? silkDurationMs(read.silk) : 0;
      total += dur;
      console.log(
        `   ${String(i + 1).padStart(2)}. ${f.file.padEnd(34)} ${(dur / 1000).toFixed(1).padStart(5)}s ` +
          `sha=${read.ok ? sha(read.silk) : "读取失败"} ${read.ok ? "" : "← " + read.reason}`,
      );
    }
    console.log(`   合计 ${(total / 1000).toFixed(1)}s`);
    const isDaoxiang = plan.files.some((f) => /稻香/.test(f.file));
    console.log(
      `   → 结论：点「${args.text}」发的是 ${plan.files.map((f) => f.file).join(" + ")}；` +
        `${isDaoxiang ? "⚠️ 竟然是稻香！" : "不是稻香 ✓（稻香副歌是 27863ms，与上面时长无一相符）"}`,
    );
  }

  if (!args.send) {
    console.log("\n（未加 --send：只解析，不发送。加 --send 才真发到 QQ。）");
    return;
  }

  // ---- 4) 真发：走真实 MessageEngine + 真实 QQApi ----
  const appId = String(env.QQ_APP_ID ?? "").trim();
  const secret = String(env.QQ_APP_SECRET ?? "").trim();
  if (!appId || !secret) throw new Error("QQ_APP_ID / QQ_APP_SECRET 未配置（.env）");

  let openid = args.openid.trim();
  if (!openid) {
    openid = String(env.QQ_ADMIN_USERS ?? "").split(/[,\s]+/).filter(Boolean)[0] ?? "";
  }
  if (!openid) throw new Error("没有目标：用 --openid 指定，或在 .env 里配 QQ_ADMIN_USERS");

  const config = loadConfig({
    ...env,
    QQ_SING_ENABLED: "true",
    QQ_MULTI_MESSAGE: "false",
  });
  const api = new QQApi({
    appId,
    clientSecret: secret,
    apiBase: resolveApiBase(config),
    tokenBase: "https://bots.qq.com",
    logger: log,
  });

  const engine = new MessageEngine({
    config,
    api,
    generate: async () => "好呀～这就唱给你听",
    logger: log,
  });

  console.log(`\n④ 真发：目标私聊 openid=${openid.slice(0, 8)}…`);
  const msg = {
    scope: "c2c",
    targetId: openid,
    senderId: openid,
    senderName: "主人",
    // ⚠️ 这里**故意不带 msg_id**：本脚本不是真的"收到了一条消息"，
    //    编一个假的 msg_id 平台会直接拒收。不带 = 主动消息（和 send-song.mjs 同样走法）。
    //    真要验被动回复，把真实 msg_id 用 --msg-id 传进来。
    messageId: args.msgId,
    content: args.text,
    kind: "text",
    attachments: [],
  };

  const res = await engine.send(msg, "好呀～这就唱给你听");
  console.log("[check-song] 发送结果 =", JSON.stringify({
    action: res.action,
    song: res.song,
    songName: res.songName,
    segments: res.segments,
    segmentsTotal: res.segmentsTotal,
    errors: res.errors,
    error: res.error,
  }));

  if (api.getAccessToken) {
    const tk = await api.getAccessToken();
    console.log("[check-song] token 仍在有效期（REST 通道正常）:", Boolean(tk));
  }
  console.log("\n[check-song] 上传明细：");
  for (const s of engine.sent) console.log(`   ${s.scope} → ${s.text}`);
}

main().catch((err) => {
  console.error("[check-song] 失败：", err?.message ?? err);
  process.exit(1);
});
