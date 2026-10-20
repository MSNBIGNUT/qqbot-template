#!/usr/bin/env node
/**
 * check-voice-rvc.mjs — 真机验收：RVC 绮萱语音链路 + 缓存 + 延迟 + 试听产出。
 *
 * 不启动第二个机器人、不发 QQ：只调用生产同一套 `synthesizeSilk`，
 * 把中间 RVC WAV 复制到 `data\rvc-preview\`，并校验最终 SILK 解码后的包络。
 *
 * 用法：
 *   node scripts/check-voice-rvc.mjs
 *   node scripts/check-voice-rvc.mjs --no-cache     # 不写成品缓存
 */

import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { parseDotenv, loadConfig } from "../src/config.js";
import { resolveTtsConfig, synthesizeSilk } from "../src/media/tts.js";
import { getRvcWorker, resetRvcWorker } from "../src/media/rvc-worker.js";
import { createVoiceCache } from "../src/media/voice-cache.js";

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(import.meta.dirname, "..");
const PREVIEW_DIR = process.env.RVC_PREVIEW_DIR || path.join(ROOT, "data", "rvc-preview");
const noCache = process.argv.includes("--no-cache");

function loadEnv() {
  const file = path.join(ROOT, ".env");
  return fs.existsSync(file) ? parseDotenv(fs.readFileSync(file, "utf8")) : {};
}

function ttsEnvFromConfig(config, overrides = {}) {
  return {
    QQ_VOICE_REPLY: "always",
    TTS_VOICE: config.ttsVoice,
    TTS_PYTHON: config.ttsPython,
    TTS_SCRIPT: config.ttsScript,
    TTS_RATE: config.ttsRate,
    TTS_PITCH: config.ttsPitch,
    TTS_MAX_CHARS: config.ttsMaxChars,
    TTS_TIMEOUT_MS: config.ttsTimeoutMs,
    TTS_ALLOW_GROUP: "false",
    QQ_VOICE_RVC: config.rvcEnabled ? "true" : "false",
    RVC_PYTHON: config.rvcPython,
    RVC_SCRIPT: config.rvcScript,
    RVC_MODEL: config.rvcModel,
    RVC_INDEX: config.rvcIndex,
    RVC_KEY: config.rvcKey,
    RVC_INDEX_RATE: config.rvcIndexRate,
    RVC_PROTECT: config.rvcProtect,
    RVC_RMS_MIX: config.rvcRmsMix,
    RVC_F0_METHOD: config.rvcF0Method,
    RVC_DEVICE: config.rvcDevice,
    RVC_TIMEOUT_MS: config.rvcTimeoutMs,
    RVC_ROOT: config.rvcRoot,
    RVC_IO_DIR: config.rvcIoDir,
    RVC_WORKER: config.rvcWorker ? "true" : "false",
    RVC_STARTUP_TIMEOUT_MS: config.rvcStartupTimeoutMs,
    SILK_BITRATE: config.silkBitrate,
    TTS_EMOTION: config.ttsEmotion ? "true" : "false",
    EMOTION_MODULE: config.emotionModule,
    EMOTION_MODE: config.emotionMode,
    VOICE_CACHE_ENABLED: noCache ? "false" : config.voiceCacheEnabled ? "true" : "false",
    VOICE_CACHE_DIR: config.voiceCacheDir,
    VOICE_CACHE_MAX_ENTRIES: config.voiceCacheMaxEntries,
    VOICE_CACHE_MAX_MB: config.voiceCacheMaxMb,
    ...overrides,
  };
}

function wavRate(file) {
  const buf = fs.readFileSync(file);
  if (buf.length < 44 || buf.toString("latin1", 0, 4) !== "RIFF") return null;
  return buf.readUInt32LE(24);
}

async function verifyEnvelope(python, silkPath, wavPath) {
  const { stdout } = await execFileAsync(
    python,
    [path.join(ROOT, "tools", "silk_envelope.py"), silkPath, wavPath],
    { timeout: 30000, windowsHide: true },
  );
  return JSON.parse(String(stdout).trim().split("\n").pop());
}

const SCENARIOS = [
  {
    id: "F",
    label: "绮萱短句",
    text: "主人，春禾在这儿呢～",
    file: "语音F_绮萱短句.wav",
  },
  {
    id: "G",
    label: "绮萱中句",
    text: "刚才那首歌春禾还没学会，等学会了再唱给你听好不好？",
    file: "语音G_绮萱中句.wav",
  },
  {
    id: "H",
    label: "绮萱情绪句",
    text: "主人今天回来啦，春禾等你好久了呢～春禾好开心！",
    file: "语音H_绮萱情绪句.wav",
  },
];

async function main() {
  const docEnv = loadEnv();
  const config = loadConfig(docEnv);
  const cfg = resolveTtsConfig(ttsEnvFromConfig(config));

  console.log("=".repeat(76));
  console.log("[check-voice-rvc] 模型 :", cfg.rvc.model);
  console.log("[check-voice-rvc] 参数 :", JSON.stringify({
    key: cfg.rvc.key,
    indexRate: cfg.rvc.indexRate,
    protect: cfg.rvc.protect,
    rmsMixRate: cfg.rvc.rmsMixRate,
    f0: cfg.rvc.f0Method,
    device: cfg.rvc.device,
  }));
  console.log("[check-voice-rvc] worker:", cfg.rvc.worker, " cache:", cfg.cache.enabled, cfg.cache.dir);
  console.log("=".repeat(76));

  if (!noCache) {
    fs.rmSync(cfg.cache.dir, { recursive: true, force: true });
  }
  fs.mkdirSync(PREVIEW_DIR, { recursive: true });

  // 预热 worker（真实机器人启动时也会这么做），单独计时
  const env = { RVC_ROOT: cfg.rvc.root, RVC_TMP_DIR: path.join(cfg.rvc.ioDir, "scratch") };
  const worker = getRvcWorker({ rvc: cfg.rvc, env, logger: console });
  const warmStart = Date.now();
  await worker.start();
  const warmMs = Date.now() - warmStart;
  console.log(`[check-voice-rvc] worker 预热完成：${warmMs}ms device=${worker.device}`);

  const rows = [];
  let cacheHits = 0;
  let cacheMisses = 0;

  for (const sc of SCENARIOS) {
    console.log(`\n--- ${sc.id} ${sc.label} ---`);
    console.log(`文本：${sc.text}`);
    const res = await synthesizeSilk(sc.text, cfg, { keepTemp: true, logger: console });
    if (!res.ok) {
      console.log(`FAILED: ${res.reason}`);
      rows.push({ ...sc, ok: false, reason: res.reason });
      continue;
    }
    if (res.cache === "hit") cacheHits += 1;
    else cacheMisses += 1;

    const target = path.join(PREVIEW_DIR, sc.file);
    fs.copyFileSync(res.artifacts.rvcWav, target);
    const rate = wavRate(target);
    const bytes = fs.statSync(target).size;
    const envCheck = await verifyEnvelope(cfg.python, res.artifacts.silkPath, res.artifacts.rvcWav);

    console.log(
      `timings tts=${res.timings.tts}ms rvc=${res.timings.rvc}ms silk=${res.timings.silk}ms ` +
        `total=${res.timings.total}ms rtf=${res.timings.rtf.toFixed(2)}`,
    );
    console.log(
      `rvc.ok=${res.rvc.ok} device=${res.rvc.device} emotion=${res.emotion?.emotion ?? "?"} ` +
        `(${res.emotion?.prosody ?? "-"})`,
    );
    console.log(`preview=${target} rate=${rate}Hz bytes=${bytes} silkEnvelopeCorr=${envCheck.corr}`);

    rows.push({
      ...sc,
      ok: true,
      totalMs: res.timings.total,
      ttsMs: res.timings.tts,
      rvcMs: res.timings.rvc,
      silkMs: res.timings.silk,
      rtf: res.timings.rtf,
      device: res.rvc.device,
      emotion: res.emotion?.emotion ?? null,
      prosody: res.emotion?.prosody ?? null,
      rate,
      bytes,
      corr: envCheck.corr,
      preview: target,
      cache: res.cache,
    });
  }

  // 缓存命中演示：同一个短句再来一次
  console.log("\n--- 缓存命中演示（同一句 F）---");
  const hitStart = Date.now();
  const hit = await synthesizeSilk(SCENARIOS[0].text, cfg, { logger: console });
  const hitMs = Date.now() - hitStart;
  console.log(`cache=${hit.cache} wall=${hitMs}ms timings.total=${hit.timings?.total}ms ok=${hit.ok}`);
  if (hit.cache === "hit") cacheHits += 1;
  else cacheMisses += 1;

  const cache = createVoiceCache(cfg.cache);
  const stats = await cache.stats();
  const rate = cacheHits + cacheMisses > 0 ? ((cacheHits / (cacheHits + cacheMisses)) * 100).toFixed(0) : "0";
  console.log(`\n缓存：hit=${cacheHits} miss=${cacheMisses} hitRate=${rate}% files=${stats.count} bytes=${stats.bytes}`);

  console.log("\n=== SUMMARY JSON ===");
  console.log(
    JSON.stringify(
      {
        workerWarmMs: warmMs,
        device: worker.device,
        rows,
        cacheHitDemo: { cache: hit.cache, wallMs: hitMs },
        cache: { hits: cacheHits, misses: cacheMisses, hitRate: rate, files: stats.count, bytes: stats.bytes },
      },
      null,
      2,
    ),
  );

  resetRvcWorker();
}

main().catch(async (err) => {
  console.error("check-voice-rvc 失败：", err);
  resetRvcWorker();
  process.exitCode = 1;
});
