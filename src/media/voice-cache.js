/**
 * 语音成品缓存：把「文本 + 音色参数」映射到已经编好的 tencent SILK 文件。
 *
 * 为什么需要它：RVC 变声比纯 edge-tts 慢一个数量级（模型加载 + F0 + 声码器），
 * 而春禾的日常回复里大量是「好的」「嗯嗯」「主人～」这种重复短句。命中缓存时
 * 连 TTS/RVC/SILK 全都不用跑，直接读文件秒回。
 *
 * 设计：
 *  - key = sha256(规范化后的参数数组)，参数任何一项变了 key 就变 → 自动失效；
 *  - value = `<dir>/<key>.silk`，命中前校验 tencent SILK 魔数，坏文件当未命中；
 *  - 淘汰按 mtime 最旧优先，同时限制条数与总字节数（默认 200 条 / 50MB）；
 *  - 所有文件操作失败都静默降级成「未命中 / 不写入」，缓存永远不能拖垮语音。
 */

import crypto from "node:crypto";
import { promises as fsp } from "node:fs";
import path from "node:path";

export const SILK_MAGIC = Buffer.from("\x02#!SILK_V3", "latin1");

export const DEFAULT_CACHE_MAX_ENTRIES = 200;
export const DEFAULT_CACHE_MAX_BYTES = 50 * 1024 * 1024;

function str(v) {
  return typeof v === "string" ? v.trim() : v == null ? "" : String(v).trim();
}

function num(v, fallback) {
  const n = Number.parseFloat(str(v));
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/** 默认缓存目录：<repo>/data/voice-cache */
export function defaultCacheDir() {
  return path.join(import.meta.dirname, "..", "..", "data", "voice-cache");
}

/**
 * 从环境变量解析缓存配置。
 * @param {Record<string, string|undefined>} [env]
 */
export function resolveVoiceCacheConfig(env = {}) {
  return {
    enabled: str(env.VOICE_CACHE_ENABLED ?? "true").toLowerCase() !== "false",
    dir: str(env.VOICE_CACHE_DIR) || defaultCacheDir(),
    maxEntries: Math.max(1, Math.floor(num(env.VOICE_CACHE_MAX_ENTRIES, DEFAULT_CACHE_MAX_ENTRIES))),
    maxBytes: Math.max(0, num(env.VOICE_CACHE_MAX_MB, 50) * 1024 * 1024),
  };
}

/**
 * 生成缓存 key。
 *
 * 只放**会影响成品音频**的字段；device 之类不影响声音的字段刻意不放，
 * 否则换一次设备就全量失效。文本用清洗+截断后的 `spoken`，不要用原文。
 */
export function voiceCacheKey({ text, cfg }) {
  const rvc = cfg?.rvc ?? {};
  const emotion = cfg?.emotion ?? {};
  const payload = [
    2, // 缓存格式版本：将来改链路时 +1 即可整体失效
    String(text ?? ""),
    str(cfg?.voice),
    str(cfg?.rate),
    str(cfg?.pitch),
    Boolean(emotion.enabled),
    str(emotion.mode),
    Boolean(rvc.enabled),
    path.basename(str(rvc.model)),
    path.basename(str(rvc.index)),
    String(rvc.key ?? ""),
    String(rvc.indexRate ?? ""),
    String(rvc.protect ?? ""),
    String(rvc.rmsMixRate ?? ""),
    str(rvc.f0Method),
    String(rvc.silkBitrate ?? ""),
  ];
  return crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

/**
 * 创建缓存对象。测试可注入 `fs` / `now` / `dir`。
 *
 * @param {object} cfg 由 resolveVoiceCacheConfig 产出
 * @param {{fs?: object, dir?: string, now?: () => number}} [deps]
 */
export function createVoiceCache(cfg = {}, deps = {}) {
  const fs = deps.fs ?? fsp;
  const dir = deps.dir ?? str(cfg.dir) ?? "";
  const now = deps.now ?? (() => Date.now());
  const maxEntries = Math.max(1, Math.floor(num(cfg.maxEntries, DEFAULT_CACHE_MAX_ENTRIES)));
  const maxBytes = Math.max(0, num(cfg.maxBytes, DEFAULT_CACHE_MAX_BYTES));
  const enabled = cfg.enabled !== false && Boolean(dir);

  const fileOf = (key) => path.join(dir, `${key}.silk`);

  async function statSafe(file) {
    try {
      return await fs.stat(file);
    } catch {
      return null;
    }
  }

  /** 删除一个缓存文件（失败忽略）。 */
  async function drop(file) {
    try {
      await fs.unlink(file);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 读缓存。命中返回 Buffer，未命中 / 文件坏了返回 null。
   * 命中时刷新 mtime，让「最旧优先」的淘汰变成近似 LRU。
   */
  async function get(key) {
    if (!enabled || !key) return null;
    const file = fileOf(key);
    let buf;
    try {
      buf = await fs.readFile(file);
    } catch {
      return null;
    }
    // 头不对说明文件损坏或被别的版本写过：删掉当未命中，避免发出去平台拒收
    if (!buf || buf.length < SILK_MAGIC.length || !buf.subarray(0, SILK_MAGIC.length).equals(SILK_MAGIC)) {
      await drop(file);
      return null;
    }
    try {
      const t = new Date(now());
      await fs.utimes(file, t, t);
    } catch {
      /* mtime 刷不新不影响读 */
    }
    return buf;
  }

  /**
   * 写缓存并淘汰。写失败（只读盘、目录被占）静默忽略。
   * @returns {Promise<boolean>} 是否写入成功
   */
  async function set(key, buf) {
    if (!enabled || !key || !buf || buf.length === 0) return false;
    const file = fileOf(key);
    try {
      await fs.mkdir(dir, { recursive: true });
      const tmp = `${file}.${process.pid}.${Math.floor(Math.random() * 1e6)}.tmp`;
      await fs.writeFile(tmp, buf);
      await fs.rename(tmp, file);
      try {
        const t = new Date(now());
        await fs.utimes(file, t, t);
      } catch {
        /* 不影响可用性 */
      }
    } catch {
      return false;
    }
    await prune();
    return true;
  }

  /** 按条数与总字节数淘汰最旧的文件；至少保留刚写入的那一条。 */
  async function prune() {
    let names;
    try {
      names = await fs.readdir(dir);
    } catch {
      return { removed: 0, count: 0, bytes: 0 };
    }
    const entries = [];
    for (const name of names) {
      if (!name.endsWith(".silk")) continue;
      const file = path.join(dir, name);
      const st = await statSafe(file);
      if (!st || typeof st.mtimeMs !== "number") continue;
      entries.push({ file, mtimeMs: st.mtimeMs, size: st.size ?? 0 });
    }
    entries.sort((a, b) => a.mtimeMs - b.mtimeMs);
    let count = entries.length;
    let bytes = entries.reduce((sum, e) => sum + e.size, 0);
    let removed = 0;
    while (entries.length > 0 && (count > maxEntries || bytes > maxBytes)) {
      const victim = entries.shift();
      if (!victim) break;
      await drop(victim.file);
      count -= 1;
      bytes -= victim.size;
      removed += 1;
    }
    return { removed, count, bytes };
  }

  /** 当前缓存规模（测试与日志用）。 */
  async function stats() {
    if (!enabled) return { count: 0, bytes: 0 };
    try {
      const names = await fs.readdir(dir);
      let count = 0;
      let bytes = 0;
      for (const name of names) {
        if (!name.endsWith(".silk")) continue;
        const st = await statSafe(path.join(dir, name));
        if (!st) continue;
        count += 1;
        bytes += st.size ?? 0;
      }
      return { count, bytes };
    } catch {
      return { count: 0, bytes: 0 };
    }
  }

  return {
    enabled,
    dir,
    maxEntries,
    maxBytes,
    keyFor: voiceCacheKey,
    get,
    set,
    prune,
    stats,
  };
}
