/**
 * 单元测试：RVC 变声链路 + 成品缓存 + 降级链。
 *
 * 全部离线：RVC / TTS / SILK 三个子进程都用脚本化 spawn 打桩，
 * 不真的跑 CUDA、不联网、不发 QQ。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  DEFAULT_RVC_MODEL,
  DEFAULT_RVC_INDEX,
  resolveTtsConfig,
  buildTtsWavArgs,
  buildRvcArgs,
  buildSilkArgs,
  synthesizeSilk,
} from "../src/media/tts.js";

import {
  SILK_MAGIC,
  createVoiceCache,
  voiceCacheKey,
  resolveVoiceCacheConfig,
} from "../src/media/voice-cache.js";
import { resetRvcWorker } from "../src/media/rvc-worker.js";

// 任何用例都不该真的拉起 CUDA 进程；万一拉了，收尾也保证不留孤儿
test.after(() => resetRvcWorker());

// ---------------------------------------------------------------- 打桩工具

const SILK = Buffer.concat([SILK_MAGIC, Buffer.from([1, 2, 3, 4, 5])]);

/** 造一个假的 ChildProcess。hang=true 时永不 close（用来测超时）。 */
function fakeChild({ code = 0, stdout = "", stderr = "", error = null, hang = false } = {}) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => {};
  if (hang) return child;
  setImmediate(() => {
    if (error) {
      child.emit("error", error);
      return;
    }
    if (stdout) child.stdout.emit("data", stdout);
    if (stderr) child.stderr.emit("data", stderr);
    child.emit("close", code);
  });
  return child;
}

/** 按脚本参数判断当前是哪一步，并返回对应结果。 */
function chainSpawn(overrides = {}) {
  const calls = [];
  const fn = (cmd, args) => {
    calls.push({ cmd, args });
    const all = args.join(" ");
    if (all.includes("--wav-out")) {
      if (overrides.tts) return overrides.tts();
      return fakeChild({ code: 0, stdout: JSON.stringify({ ok: true, wav: "x.wav", duration_ms: 2000 }) });
    }
    if (all.includes("rvc_convert.py")) {
      if (overrides.rvc) return overrides.rvc();
      return fakeChild({
        code: 0,
        stdout: "[i] device=cuda:0 half=True engine=offline\n[ok] out.wav",
      });
    }
    if (all.includes("audio_to_silk.py")) {
      if (overrides.silk) return overrides.silk();
      return fakeChild({ code: 0, stdout: JSON.stringify({ ok: true, bytes: SILK.length }) });
    }
    if (overrides.other) return overrides.other();
    return fakeChild({ code: 0 });
  };
  fn.calls = calls;
  return fn;
}

function okDeps(spawned, extra = {}) {
  return {
    spawn: spawned,
    stat: async () => ({ isFile: () => true, size: 100 }),
    readFile: async () => SILK,
    removeFile: async () => {},
    ...extra,
  };
}

/** 只开 RVC、关缓存的基础配置。 */
function rvcCfg(extra = {}) {
  return resolveTtsConfig({
    QQ_VOICE_REPLY: "mirror",
    QQ_VOICE_RVC: "true",
    VOICE_CACHE_ENABLED: "false",
    TTS_EMOTION: "false",
    ...extra,
  });
}

// ---------------------------------------------------------------- 配置

test("rvc: 默认开启，模型/参数/设备都有生产默认值", () => {
  const cfg = resolveTtsConfig({ QQ_VOICE_REPLY: "mirror" });
  assert.equal(cfg.rvc.enabled, true);
  assert.equal(cfg.rvc.model, DEFAULT_RVC_MODEL);
  assert.equal(cfg.rvc.index, DEFAULT_RVC_INDEX);
  assert.equal(cfg.rvc.key, 2);
  assert.equal(cfg.rvc.indexRate, 0.7);
  assert.equal(cfg.rvc.protect, 0.33);
  assert.equal(cfg.rvc.rmsMixRate, 0.25);
  assert.equal(cfg.rvc.f0Method, "rmvpe");
  assert.equal(cfg.rvc.device, "cuda");
  assert.equal(cfg.rvc.timeoutMs, 30000);
  assert.equal(cfg.rvc.silkBitrate, 48000);
});

test("rvc: QQ_VOICE_RVC=false 时关闭", () => {
  const cfg = resolveTtsConfig({ QQ_VOICE_RVC: "false" });
  assert.equal(cfg.rvc.enabled, false);
});

test("rvc: 参数全部可配（含负数 key 与 0）", () => {
  const cfg = resolveTtsConfig({
    RVC_KEY: "-5",
    RVC_INDEX_RATE: "0.4",
    RVC_PROTECT: "0",
    RVC_RMS_MIX: "1",
    RVC_DEVICE: "cpu",
    RVC_TIMEOUT_MS: "1234",
    RVC_MODEL: "D:/m/x.pth",
    RVC_INDEX: "D:/m/x.index",
    SILK_BITRATE: "24000",
  });
  assert.equal(cfg.rvc.key, -5);
  assert.equal(cfg.rvc.indexRate, 0.4);
  assert.equal(cfg.rvc.protect, 0);
  assert.equal(cfg.rvc.rmsMixRate, 1);
  assert.equal(cfg.rvc.device, "cpu");
  assert.equal(cfg.rvc.timeoutMs, 1234);
  assert.equal(cfg.rvc.model, "D:/m/x.pth");
  assert.equal(cfg.rvc.index, "D:/m/x.index");
  assert.equal(cfg.rvc.silkBitrate, 24000);
});

test("rvc: 情绪层可开关，默认开", () => {
  assert.equal(resolveTtsConfig({}).emotion.enabled, true);
  assert.equal(resolveTtsConfig({ TTS_EMOTION: "false" }).emotion.enabled, false);
});

// ---------------------------------------------------------------- 参数构造

test("rvc: buildTtsWavArgs 只产 WAV 并带情绪参数", () => {
  const cfg = resolveTtsConfig({ TTS_VOICE: "zh-CN-XiaoyiNeural", TTS_RATE: "+0%", TTS_EMOTION: "true" });
  const args = buildTtsWavArgs({
    scriptPath: "C:/x/tools/tts_silk.py",
    text: "你好呀",
    wavPath: "C:/io/a.wav",
    cfg,
  });
  assert.equal(args[0], "C:/x/tools/tts_silk.py");
  assert.ok(args.includes("--wav-out"));
  assert.ok(args.includes("C:/io/a.wav"));
  assert.ok(!args.includes("--out"), "RVC 链路的第一步不应直接产 SILK");
  assert.ok(args.includes("--emotion"));
  assert.ok(args.includes("--emotion-module"));
  assert.ok(args.includes("--emotion-mode"));
});

test("rvc: buildRvcArgs 带上绮萱模型与全部调参", () => {
  const cfg = rvcCfg();
  const args = buildRvcArgs({
    scriptPath: "C:/x/singer/rvc_convert.py",
    inPath: "C:/io/in.wav",
    outPath: "C:/io/out.wav",
    rvc: cfg.rvc,
  });
  assert.equal(args[0], "C:/x/singer/rvc_convert.py");
  assert.ok(args.includes("--in") && args.includes("C:/io/in.wav"));
  assert.ok(args.includes("--out") && args.includes("C:/io/out.wav"));
  assert.ok(args.includes("--model") && args.includes(DEFAULT_RVC_MODEL));
  assert.ok(args.includes("--index") && args.includes(DEFAULT_RVC_INDEX));
  assert.ok(args.includes("--key") && args.includes("2"));
  assert.ok(args.includes("--index-rate") && args.includes("0.7"));
  assert.ok(args.includes("--protect") && args.includes("0.33"));
  assert.ok(args.includes("--rms-mix-rate") && args.includes("0.25"));
  assert.ok(args.includes("--f0-method") && args.includes("rmvpe"));
  assert.ok(args.includes("--device") && args.includes("cuda"));
});

test("rvc: buildSilkArgs 用 48kbps", () => {
  const cfg = rvcCfg();
  const args = buildSilkArgs({
    scriptPath: "C:/x/tools/audio_to_silk.py",
    inPath: "C:/io/rvc.wav",
    outPath: "C:/out/a.silk",
    bitrate: cfg.rvc.silkBitrate,
  });
  assert.ok(args.includes("--in") && args.includes("C:/io/rvc.wav"));
  assert.ok(args.includes("--out") && args.includes("C:/out/a.silk"));
  assert.ok(args.includes("--bitrate") && args.includes("48000"));
});

// ---------------------------------------------------------------- 成功链路

test("rvc: 成功链路是 TTS(WAV) → RVC → SILK，三步各跑一次", async () => {
  const spawned = chainSpawn();
  const res = await synthesizeSilk("主人，春禾在这儿呢～", rvcCfg(), okDeps(spawned));

  assert.equal(res.ok, true, res.reason);
  assert.equal(spawned.calls.length, 3, `应跑三步，实际 ${spawned.calls.length}`);
  assert.ok(spawned.calls[0].args.includes("--wav-out"));
  assert.ok(spawned.calls[1].args.some((a) => String(a).endsWith("rvc_convert.py")));
  assert.ok(spawned.calls[1].args.includes("--device"));
  assert.equal(spawned.calls[1].args[spawned.calls[1].args.indexOf("--device") + 1], "cuda");
  assert.ok(spawned.calls[2].args.some((a) => String(a).endsWith("audio_to_silk.py")));
  assert.equal(spawned.calls[2].args[spawned.calls[2].args.indexOf("--bitrate") + 1], "48000");

  assert.deepEqual(res.silk, SILK);
  assert.equal(res.rvc.ok, true);
  assert.equal(res.rvc.device, "cuda:0");
  assert.equal(res.cache, "miss");
  for (const key of ["tts", "rvc", "silk", "total"]) {
    assert.equal(typeof res.timings[key], "number", `timings.${key} 应是数字`);
  }
  assert.equal(typeof res.timings.rtf, "number");
});

test("rvc: TTS 助手收到的是清洗后的文本", async () => {
  const spawned = chainSpawn();
  await synthesizeSilk("你好呀🌸✨", rvcCfg(), okDeps(spawned));
  const { args } = spawned.calls[0];
  assert.equal(args[args.indexOf("--text") + 1], "你好呀");
});

// ---------------------------------------------------------------- 配置开关

test("rvc: QQ_VOICE_RVC=false 时退回旧的单步 TTS→SILK（只跑一次）", async () => {
  const spawned = chainSpawn();
  const cfg = resolveTtsConfig({
    QQ_VOICE_REPLY: "mirror",
    QQ_VOICE_RVC: "false",
    VOICE_CACHE_ENABLED: "false",
    TTS_EMOTION: "false",
  });
  const res = await synthesizeSilk("你好", cfg, okDeps(spawned));
  assert.equal(res.ok, true, res.reason);
  assert.equal(spawned.calls.length, 1);
  assert.ok(!spawned.calls[0].args.includes("--wav-out"));
  assert.ok(spawned.calls[0].args.includes("--out"));
  assert.equal(res.rvc, undefined);
});

// ---------------------------------------------------------------- 降级链

test("rvc: RVC 失败 → 回退到纯 TTS 语音（不是没声音）", async () => {
  const spawned = chainSpawn({ rvc: () => fakeChild({ code: 1, stderr: "CUDA out of memory" }) });
  const res = await synthesizeSilk("你好", rvcCfg(), okDeps(spawned));
  assert.equal(res.ok, true, res.reason);
  assert.equal(res.rvc.ok, false);
  assert.match(res.rvc.reason, /CUDA out of memory|退出码/);
  assert.equal(spawned.calls.length, 3, "TTS + RVC + SILK 都要跑（SILK 编 TTS 的原声）");
  const silkArgs = spawned.calls[2].args;
  assert.ok(!silkArgs.includes("rvc"), "SILK 应该编 TTS 的 WAV 而不是 RVC 的");
  assert.ok(spawned.calls[1].args.some((a) => String(a).endsWith("rvc_convert.py")));
});

test("rvc: RVC 超时 → 中断并回退纯 TTS", async () => {
  const spawned = chainSpawn({ rvc: () => fakeChild({ hang: true }) });
  const started = Date.now();
  const res = await synthesizeSilk(
    "你好",
    rvcCfg({ RVC_TIMEOUT_MS: "30" }),
    okDeps(spawned),
  );
  const wall = Date.now() - started;
  assert.equal(res.ok, true, res.reason);
  assert.equal(res.rvc.ok, false);
  assert.match(res.rvc.reason, /超时/);
  assert.ok(wall < 2000, `超时应在约 30ms 后结束，实际 ${wall}ms`);
});

test("rvc: TTS 失败 → 整条语音失败（调用方降级文字）", async () => {
  const spawned = chainSpawn({ tts: () => fakeChild({ code: 2, stderr: "edge-tts: no network" }) });
  const res = await synthesizeSilk("你好", rvcCfg(), okDeps(spawned));
  assert.equal(res.ok, false);
  assert.match(res.reason, /no network|退出码|TTS/i);
  assert.equal(spawned.calls.length, 1, "TTS 失败后不应继续跑 RVC");
});

test("rvc: SILK 失败 → 整条语音失败", async () => {
  const spawned = chainSpawn({ silk: () => fakeChild({ code: 1, stderr: "pysilk boom" }) });
  const res = await synthesizeSilk("你好", rvcCfg(), okDeps(spawned));
  assert.equal(res.ok, false);
  assert.match(res.reason, /pysilk boom|退出码/);
});

test("rvc: RVC 退出码 0 但没产出文件也按失败降级", async () => {
  const spawned = chainSpawn();
  let n = 0;
  const res = await synthesizeSilk("你好", rvcCfg(), {
    ...okDeps(spawned),
    stat: async (p) => {
      n += 1;
      // 第一次（TTS wav）存在；第二次（RVC out）不存在
      return n === 1 ? { isFile: () => true, size: 100 } : null;
    },
  });
  assert.equal(res.ok, true, res.reason);
  assert.equal(res.rvc.ok, false);
  assert.match(res.rvc.reason, /未产出|不存在/);
});

test("rvc: 临时文件用完清理（默认不保留）", async () => {
  const removed = [];
  const spawned = chainSpawn();
  await synthesizeSilk("你好", rvcCfg(), okDeps(spawned, { removeFile: async (p) => removed.push(p) }));
  assert.ok(removed.some((p) => p.endsWith(".wav")), `应清理 WAV：${removed.join(", ")}`);
});

// ---------------------------------------------------------------- 常驻 worker

test("rvc: 生产路径优先走常驻 worker（不再每次重启 python）", async () => {
  const calls = [];
  const fakeWorker = {
    async convert(inPath, outPath) {
      calls.push({ inPath, outPath });
      return { ok: true, device: "cuda:0", ms: 123 };
    },
  };
  const cfg = rvcCfg();
  const spawned = chainSpawn();
  const res = await synthesizeSilk("主人～", cfg, {
    ...okDeps(spawned),
    rvcWorker: fakeWorker,
  });
  assert.equal(res.ok, true, res.reason);
  assert.equal(res.rvc.ok, true);
  assert.equal(res.rvc.device, "cuda:0");
  assert.equal(calls.length, 1, "RVC 应交给常驻 worker");
  assert.equal(spawned.calls.length, 2, "TTS + SILK 仍然各跑一次，只有 RVC 走 worker");
});

test("rvc: worker 超时/失败同样降级成纯 TTS", async () => {
  const fakeWorker = {
    async convert() {
      return { ok: false, timedOut: true, reason: "RVC worker 超时（>30ms）" };
    },
  };
  const res = await synthesizeSilk("主人～", rvcCfg(), {
    ...okDeps(chainSpawn()),
    rvcWorker: fakeWorker,
  });
  assert.equal(res.ok, true, res.reason);
  assert.equal(res.rvc.ok, false);
  assert.match(res.rvc.reason, /超时/);
});

// ---------------------------------------------------------------- 缓存 key

test("cache: key 对文本与音色参数敏感", () => {
  const a = voiceCacheKey({ text: "好的", cfg: rvcCfg() });
  const b = voiceCacheKey({ text: "好的", cfg: rvcCfg({ RVC_KEY: "3" }) });
  const c = voiceCacheKey({ text: "好的", cfg: rvcCfg({ TTS_VOICE: "zh-CN-XiaoxiaoNeural" }) });
  const d = voiceCacheKey({ text: "嗯嗯", cfg: rvcCfg() });
  assert.notEqual(a, b, "key 变了缓存必须失效");
  assert.notEqual(a, c, "换音色缓存必须失效");
  assert.notEqual(a, d, "文本不同 key 必须不同");
  assert.equal(a, voiceCacheKey({ text: "好的", cfg: rvcCfg() }), "同参数 key 应稳定");
});

test("cache: 默认开启、目录在 data/voice-cache", () => {
  const cfg = resolveVoiceCacheConfig({});
  assert.equal(cfg.enabled, true);
  assert.ok(cfg.dir.endsWith(path.join("data", "voice-cache")), cfg.dir);
  assert.equal(cfg.maxEntries, 200);
});

// ---------------------------------------------------------------- 缓存行为

async function tempCache(overrides = {}) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "chunhe-vc-"));
  let tick = 1000;
  const cache = createVoiceCache(
    { enabled: true, dir, maxEntries: 10, maxBytes: 1024 * 1024, ...overrides },
    { now: () => (tick += 1000) },
  );
  return { dir, cache, cleanup: () => fsp.rm(dir, { recursive: true, force: true }) };
}

test("cache: 未命中返回 null，写入后命中，坏文件自动丢弃", async () => {
  const { dir, cache, cleanup } = await tempCache();
  try {
    assert.equal(await cache.get("k1"), null);
    assert.equal(await cache.set("k1", SILK), true);
    assert.deepEqual(await cache.get("k1"), SILK);

    await fsp.writeFile(path.join(dir, "k2.silk"), Buffer.from("not silk"));
    assert.equal(await cache.get("k2"), null);
    await assert.rejects(fsp.stat(path.join(dir, "k2.silk")));
  } finally {
    await cleanup();
  }
});

test("cache: 超过条数上限淘汰最旧的（近似 LRU）", async () => {
  const { dir, cache, cleanup } = await tempCache({ maxEntries: 2 });
  try {
    await cache.set("old", SILK);
    await cache.set("mid", SILK);
    await cache.set("new", SILK);
    assert.equal(await cache.get("old"), null, "最旧的应被淘汰");
    assert.deepEqual(await cache.get("mid"), SILK);
    assert.deepEqual(await cache.get("new"), SILK);
    const files = (await fsp.readdir(dir)).filter((n) => n.endsWith(".silk")).sort();
    assert.deepEqual(files, ["mid.silk", "new.silk"]);
  } finally {
    await cleanup();
  }
});

test("cache: 超过字节上限也会淘汰", async () => {
  const { cache, cleanup } = await tempCache({ maxEntries: 100, maxBytes: 8 });
  try {
    await cache.set("a", SILK); // 15 bytes > 8：写完会立刻把自己淘汰
    const st = await cache.stats();
    assert.ok(st.bytes <= 8, `应压到 8 字节内，实际 ${st.bytes}`);
  } finally {
    await cleanup();
  }
});

test("cache: 命中缓存时跳过 TTS+RVC+SILK，秒回", async () => {
  const { dir, cleanup } = await tempCache();
  try {
    const cfg = rvcCfg({ VOICE_CACHE_ENABLED: "true", VOICE_CACHE_DIR: dir });
    const first = await synthesizeSilk("好的", cfg, okDeps(chainSpawn()));
    assert.equal(first.ok, true, first.reason);
    assert.equal(first.cache, "miss");

    const noSpawn = () => {
      throw new Error("缓存命中不应该再启动任何子进程");
    };
    const second = await synthesizeSilk("好的", cfg, {
      spawn: noSpawn,
      stat: async () => null,
      readFile: async () => {
        throw new Error("缓存命中应该直接读缓存文件");
      },
      removeFile: async () => {},
    });
    assert.equal(second.ok, true, second.reason);
    assert.equal(second.cache, "hit");
    assert.deepEqual(second.silk, SILK);
    assert.equal(second.timings.tts, 0);
    assert.equal(second.timings.rvc, 0);
    assert.equal(second.timings.silk, 0);
  } finally {
    await cleanup();
  }
});

test("cache: 参数变化后缓存未命中（重新合成）", async () => {
  const { dir, cleanup } = await tempCache();
  try {
    const base = { VOICE_CACHE_ENABLED: "true", VOICE_CACHE_DIR: dir };
    const first = await synthesizeSilk("好的", rvcCfg(base), okDeps(chainSpawn()));
    assert.equal(first.cache, "miss");

    const spawned = chainSpawn();
    const second = await synthesizeSilk("好的", rvcCfg({ ...base, RVC_KEY: "5" }), okDeps(spawned));
    assert.equal(second.cache, "miss");
    assert.equal(spawned.calls.length, 3, "参数变了必须重新跑三步");
  } finally {
    await cleanup();
  }
});
