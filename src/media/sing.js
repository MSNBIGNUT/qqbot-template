/**
 * 唱歌（曲库优先 → 歌声合成）→ tencent SILK。
 *
 * 与 tts.js 的分工：
 *   - tts.js 是「说话」：文字 → edge-tts → SILK
 *   - 本模块是「唱歌」：**先查成品曲库（RVC 真人唱，秒级）**，
 *     曲库没有才走乐谱 JSON → DiffSinger ONNX 歌声 → SILK
 *
 * ⚠️ 为什么必须有曲库这条路（真实 bug）：
 *   曲库里明明躺着《樱花草》的成品，旧实现却只看硬编码的
 *   `scores/daoxiang_chorus.json`——主人点《樱花草》，她答"会呀"，
 *   唱出来的却是**稻香副歌**（27863ms，一听就穿帮）。
 *   答应了却唱成别的歌，比直接说不会更糟。
 *
 * 设计约束与 tts.js 一致：
 *   1. JS 侧保持零依赖，真正的合成交给 Python 助手 tools/sing_silk.py。
 *   2. **任何失败都降级，绝不抛**——返回 {ok, reason}，让调用方退回文字。
 *   3. 歌声合成比说话慢得多（CPU 上约 1:1 实时），所以超时给得很宽。
 */

import { spawn as nodeSpawn } from "node:child_process";
import { promises as fsp } from "node:fs";
import path from "node:path";

/** 默认乐谱：稻香副歌（随仓库分发） */
export function defaultScorePath() {
  return path.join(import.meta.dirname, "..", "..", "scores", "daoxiang_chorus.json");
}

/** 助手脚本：<repo>/tools/sing_silk.py */
export function defaultScriptPath() {
  return path.join(import.meta.dirname, "..", "..", "tools", "sing_silk.py");
}

// ---------------------------------------------------------------------------
// 成品曲库（.silk）
//
// 曲库里是**已经渲染好的整首歌**（RVC 转的真人唱 / 早期 DiffSinger 成品），
// 直接读文件发出去即可——比现场合成快几个数量级，音质也好得多。
// 目录可配（SING_LIBRARY_DIR / QQ_SING_LIBRARY_DIR），因为沙箱与机器可能变。
// ---------------------------------------------------------------------------

/** tencent SILK_V3 文件头：QQ 只认这个（校验它才不会把坏文件发出去被拒收） */
export const SILK_HEADER = "\x02#!SILK_V3";

/** 一个 SILK 包的时长：QQ/微信用的 SILK 固定 20ms 一包 */
export const SILK_FRAME_MS = 20;

/** 默认曲库目录（成品歌都放在受信媒体目录里，上传才不会被拦） */
export const DEFAULT_LIBRARY_DIR = "data/songs";

/** 曲库目录（环境变量可覆盖） */
export function defaultLibraryDir(env = process.env) {
  return (
    str(env?.SING_LIBRARY_DIR) ||
    str(env?.QQ_SING_LIBRARY_DIR) ||
    DEFAULT_LIBRARY_DIR
  );
}

/**
 * 数一段 SILK 里有多少个 20ms 包。
 *
 * 为什么要自己数：文件名里没有时长，而「多个版本命中同一首歌时发最长的那个」
 * 必须有个可靠的时长来源。SILK_V3 的结构很简单——
 * `\x02#!SILK_V3` + 反复的「2 字节小端长度 + 该长度的包」，遇到长度 0（或 0xFFFF）结束，
 * 所以包数 × 20ms 就是时长（实测与曲库标注完全一致：稻香 27.9s、樱花草 57.0s）。
 *
 * @returns {number} 包数；头不对/截断/为空一律 0（= 不可用）
 */
export function silkFrames(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return 0;
  if (buf.subarray(0, SILK_HEADER.length).toString("binary") !== SILK_HEADER) return 0;
  let i = SILK_HEADER.length;
  let frames = 0;
  while (i + 2 <= buf.length) {
    const len = buf.readUInt16LE(i);
    i += 2;
    if (len === 0 || len === 0xffff) break; // 终止包
    if (i + len > buf.length) return 0;     // 截断 → 时长不可信
    i += len;
    frames += 1;
  }
  return frames;
}

/** 一段 SILK 的时长（毫秒）；不可用时 0 */
export function silkDurationMs(buf) {
  return silkFrames(buf) * SILK_FRAME_MS;
}

/**
 * 拆解曲库文件名：`歌名_版本_分段.silk`。
 *
 * 例：`樱花草_绮萱RVC_full_3of5.silk`
 *   → { name:"樱花草", singer:"绮萱RVC", variant:"full",
 *       base:"樱花草_绮萱RVC_full", part:3, parts:5 }
 *
 * `base` 是"同一份音频的同一批切分"的组标识：`_1of5..5of5` 共用一个 base，
 * 靠它才能把 5 段认成一套、按顺序发。
 *
 * @returns {{name,singer,variant,base,part,parts}|null} 不是 .silk / 文件名为空 → null
 */
export function parseSongFileName(filename) {
  const file = str(filename);
  if (!/\.silk$/i.test(file)) return null;
  let base = file.replace(/\.silk$/i, "").trim();
  if (!base) return null;

  let part = 0;
  let parts = 1;
  const m = base.match(/^(.*)_(\d+)\s*of\s*(\d+)$/i);
  if (m && m[1].trim()) {
    base = m[1].replace(/[_\-\s]+$/, "");
    const p = Number(m[2]);
    const total = Number(m[3]);
    if (total >= 2 && p >= 1 && p <= total) {
      part = p;
      parts = total;
    }
  }

  const segs = base.split("_").map((x) => x.trim()).filter(Boolean);
  if (!segs.length || !segs[0]) return null;
  return {
    name: segs[0],
    singer: segs[1] ?? "",
    variant: segs.slice(2).join("_"),
    base,
    part,
    parts,
  };
}

/** 匹配用的归一化：去空白/标点/大小写，只留内容（"唱首 樱花草！" → "唱首樱花草"） */
function normalizeForMatch(v) {
  return str(v)
    .toLowerCase()
    .replace(/[\s\u3000]/g, "")
    .replace(/[，,。.、!！?？~～:：;；"'“”‘’()（）【】\[\]《》<>·…—-]/g, "");
}

/** 曲库清单缓存：每条消息都要判断"是不是点歌"，不能每次都读 1MB 文件 */
const LIBRARY_CACHE_TTL_MS = 60_000;
let _libraryCache = null;

/**
 * 扫曲库，列出**真正能发出去的**成品歌。
 *
 * 只认 `.silk` 且**文件头必须是 tencent SILK_V3、能数出包数**——
 * 坏文件宁可当它不存在，也不能发出去让 QQ 拒收（那会变成"点了歌却没声音"）。
 *
 * **永不抛出**：目录读不到、单个文件坏掉都只是少一条。
 *
 * @param {{dir?:string, readdir?:Function, readFile?:Function, logger?:object, cache?:boolean}} [deps]
 * @returns {Promise<Array<object>>}
 */
export async function listLibrarySongs(deps = {}) {
  const dir = deps.dir === undefined || deps.dir === null ? defaultLibraryDir() : str(deps.dir);
  const readdirImpl = deps.readdir ?? ((p) => fsp.readdir(p, { withFileTypes: true }));
  const readFileImpl = deps.readFile ?? ((p) => fsp.readFile(p));
  const useCache = deps.cache !== false && !deps.readdir && !deps.readFile;

  if (!dir) return [];
  if (useCache && _libraryCache && _libraryCache.dir === dir &&
      Date.now() - _libraryCache.at < LIBRARY_CACHE_TTL_MS) {
    return _libraryCache.songs;
  }

  let entries;
  try {
    entries = await readdirImpl(dir);
  } catch (err) {
    deps.logger?.debug?.(`曲库目录不可用（${dir}）：${err?.message ?? err}`);
    return [];
  }

  const out = [];
  for (const e of Array.isArray(entries) ? entries : []) {
    const isFile = typeof e?.isFile === "function" ? e.isFile() : true;
    if (!isFile) continue;
    const filename = e?.name ?? String(e);
    const info = parseSongFileName(filename);
    if (!info) continue;

    const full = path.join(dir, filename);
    let buf;
    try {
      buf = await readFileImpl(full);
    } catch (err) {
      deps.logger?.warn?.(`曲库文件读不到，跳过：${filename}（${err?.message ?? err}）`);
      continue;
    }
    const buffer = Buffer.isBuffer(buf) ? buf : Buffer.from(buf ?? "");
    const durationMs = silkDurationMs(buffer);
    if (durationMs <= 0) {
      deps.logger?.warn?.(`曲库文件不是有效的 SILK，跳过：${filename}`);
      continue;
    }
    out.push({ ...info, file: filename, path: full, bytes: buffer.length, durationMs });
  }

  out.sort(
    (a, b) =>
      a.name.localeCompare(b.name, "zh") ||
      a.base.localeCompare(b.base, "zh") ||
      a.part - b.part,
  );

  if (useCache) _libraryCache = { dir, at: Date.now(), songs: out };
  return out;
}

/**
 * 按主人在话里点的歌名，从曲库里挑出**要发的那一份（或一套）**。
 *
 * 挑选规则（顺序即优先级）：
 *   ① 有完整的分段整套（`_1of5.._5of5`）→ 发整套，按序号排好序
 *      —— 那是"整首"，主人说"唱给我听"要的就是它
 *   ② 否则取**时长最长的单个文件**（同一首歌往往有多个版本，
 *      最长的信息量最大；实测也正是音质最好的那一版）
 *   ③ 只有残缺的分段（缺号）→ 把现有的按序号发出去，总比不发强
 *
 * **永不抛出**：挑不到就返回 null，交给合成兜底。
 *
 * @param {string} text 主人的原话
 * @param {Array<object>} songs `listLibrarySongs` 的结果
 * @returns {{name:string, files:Array<object>, multi:boolean, totalMs:number}|null}
 */
export function planLibrarySong(text, songs) {
  const flat = normalizeForMatch(text);
  const list = Array.isArray(songs) ? songs.filter(Boolean) : [];
  if (!flat || !list.length) return null;

  // ① 消息里直接出现了完整歌名——最可靠（长名优先，免得「稻香」抢掉「稻香副歌」）
  const names = [...new Set(list.map((x) => x.name).filter(Boolean))].sort(
    (a, b) => b.length - a.length,
  );
  let name = names.find((n) => flat.includes(normalizeForMatch(n))) ?? "";

  // ② 没直接出现，就用抽出来的候选名去比（"唱稻香" → 曲库里的「稻香副歌」）
  if (!name) {
    const guess = normalizeForMatch(extractSongName(text));
    if (guess.length >= 2) {
      const hit = list.find((x) => {
        const n = normalizeForMatch(x.name);
        return n.includes(guess) || guess.includes(n) || normalizeForMatch(x.base).includes(guess);
      });
      if (hit) name = hit.name;
    }
  }
  if (!name) return null;

  const matched = list.filter((x) => x.name === name);
  if (!matched.length) return null;

  // ① 完整整套优先
  const groups = new Map();
  for (const e of matched) {
    if (e.parts > 1) {
      if (!groups.has(e.base)) groups.set(e.base, []);
      groups.get(e.base).push(e);
    }
  }
  for (const arr of groups.values()) {
    arr.sort((a, b) => a.part - b.part);
    const total = Math.max(...arr.map((e) => e.parts));
    const complete = arr.length === total && arr.every((e, i) => e.part === i + 1);
    if (complete) {
      return { name, files: arr, multi: true, totalMs: sumMs(arr) };
    }
  }

  // ② 单个文件里取最长的
  const singles = matched.filter((e) => e.parts <= 1).sort((a, b) => b.durationMs - a.durationMs);
  if (singles.length) {
    return { name, files: [singles[0]], multi: false, totalMs: singles[0].durationMs };
  }

  // ③ 只剩残缺分段：按序号发现有的（仍然是这首歌）
  for (const arr of groups.values()) {
    arr.sort((a, b) => a.part - b.part);
    if (arr.length) return { name, files: arr, multi: arr.length > 1, totalMs: sumMs(arr) };
  }
  return null;
}

function sumMs(arr) {
  return arr.reduce((n, e) => n + (Number(e?.durationMs) || 0), 0);
}

/**
 * 解析"主人这次想听哪首"：先看本条消息，看不到就回看最近几轮（同一会话）。
 *
 * 为什么必须回看历史：真实 bug 的现场就是这样——
 *   「春禾会唱樱花草吗」（她答"会呀"）→「唱给我听」
 * 第二句里根本没有歌名，只看本条就会退化成默认那首（= 又唱成稻香）。**本轮的优先。**
 *
 * @returns {Promise<{name,files,multi,totalMs,source:"text"|"recent"}|null>}
 */
export async function resolveLibrarySong(cfg, { text = "", recentTexts = [], deps = {} } = {}) {
  const dir = deps.dir ?? (cfg?.libraryDir ?? cfg?.library_dir ?? defaultLibraryDir());
  let songs;
  try {
    songs = await listLibrarySongs({ ...deps, dir });
  } catch (err) {
    deps.logger?.debug?.(`曲库扫描异常（已降级）：${err?.message ?? err}`);
    return null;
  }
  if (!songs.length) return null;

  const direct = planLibrarySong(text, songs);
  if (direct) return { ...direct, source: "text" };

  const recent = Array.isArray(recentTexts) ? recentTexts : [];
  for (let i = recent.length - 1; i >= 0; i -= 1) {
    const plan = planLibrarySong(recent[i], songs);
    if (plan) return { ...plan, source: "recent" };
  }
  return null;
}

/**
 * 读一份曲库 SILK。**永不抛出**：读不到 / 头不对都返回 {ok:false, reason}。
 * 头不对必须拦住——QQ 会直接拒收，主人那边就是"点了歌却没动静"。
 */
export async function readLibrarySilk(filePath, deps = {}) {
  const readFileImpl = deps.readFile ?? ((p) => fsp.readFile(p));
  try {
    const buf = await readFileImpl(filePath);
    const buffer = Buffer.isBuffer(buf) ? buf : Buffer.from(buf ?? "");
    if (buffer.subarray(0, SILK_HEADER.length).toString("binary") !== SILK_HEADER) {
      return { ok: false, reason: "不是 tencent SILK_V3（QQ 会拒收）" };
    }
    return { ok: true, silk: buffer, reason: "" };
  } catch (err) {
    return { ok: false, reason: `读不到曲库文件（${err?.message ?? err}）` };
  }
}

/**
 * 从主人的话里抽出**候选歌名**（抽不出返回空串）。
 *
 * 做法是"剥壳"：把呼名、客套、唱歌动作、语气词一层层剥掉，剩下的就是歌名。
 *   「春禾，唱首樱花草」→ 樱花草     「点歌 樱花草」→ 樱花草
 *   「唱给我听」→ 空（没点具体哪首）  「你会唱歌吗」→ 空（描述/疑问，不是歌名）
 *
 * 注意：这只是**候选**。真正"有没有这首歌"由曲库说了算
 * （`planLibrarySong` 先按完整歌名匹配，匹配不到才用这个候选去比），
 * 所以这里宁可漏也不要乱猜——剩下的字里还带"唱/歌"这类词就一律不算歌名。
 */
export function extractSongName(text) {
  let s = str(text);
  if (!s) return "";

  for (let i = 0; i < 8; i += 1) {
    const before = s;
    s = s.replace(/^[\s\u3000，,。.、!！?？~～:：;；"'“”‘’()（）【】\[\]《》]+/, "");
    s = s.replace(/^(?:春禾|小禾|禾禾)/, "");                          // 呼名
    s = s.replace(/^(?:请|麻烦|帮忙|帮我|可以|能不能|给我|你|您)+/, ""); // 客套
    s = s.replace(/^(?:唱|来|点|放)(?:一?首|一?个|一?段|一?句|一下|一次|一曲)?/, ""); // 动作
    s = s.replace(/^(?:歌曲|歌|曲)/, "");
    s = s.replace(/^(?:听听|给我听|唱给我听|听)/, "");
    if (s === before) break;
  }

  s = s.replace(/^(?:吧|啊|呀|哦|嘛|呢|啦|咯|哟|那|就)+/, "");
  s = s.replace(/(?:吧|啊|呀|哦|嘛|呢|啦|咯|哟|吗)+$/, "");
  s = s.trim();

  if (!s || s.length > 12) return "";
  // 剥完还剩"唱/歌"这类词 → 这句是描述或疑问，不是歌名
  if (/[唱歌]/.test(s)) return "";
  if (/(什么|怎么|如何|是不是|真的|好听|难听|哪|谁)/.test(s)) return "";
  return s;
}


export const DEFAULT_TIMEOUT_MS = 240000;

function str(v) {
  return typeof v === "string" ? v.trim() : v == null ? "" : String(v).trim();
}

function num(v, fallback) {
  const n = Number.parseFloat(str(v));
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** 允许 0 的数值解析（间隔可以设成 0，测试与调试要用） */
function numZero(v, fallback) {
  const n = Number.parseFloat(str(v));
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/** 多段成品歌之间的默认间隔：一段一段发，别让 QQ 判成刷屏 */
export const DEFAULT_LIBRARY_GAP_MS = 5000;

/**
 * 从环境变量解析唱歌配置。
 * @param {Record<string, string|undefined>} [env]
 */
export function resolveSingConfig(env = {}) {
  return {
    enabled: str(env.QQ_SING_ENABLED ?? "true").toLowerCase() !== "false",
    python: str(env.SING_PYTHON) || str(env.TTS_PYTHON),
    script: str(env.SING_SCRIPT) || defaultScriptPath(),
    score: str(env.SING_SCORE) || defaultScorePath(),
    /** 成品曲库目录（点歌优先从这里发，查不到才合成） */
    libraryDir: defaultLibraryDir(env),
    /** 多段成品歌之间的间隔（毫秒） */
    libraryGapMs: numZero(env.SING_LIBRARY_GAP_MS, DEFAULT_LIBRARY_GAP_MS),
    singerDir: str(env.SING_SINGER_DIR),
    voicebank: str(env.SING_VOICEBANK),
    vocoder: str(env.SING_VOCODER),
    vibratoCents: num(env.SING_VIBRATO_CENTS, 70),
    squeakCents: num(env.SING_SCOOP_CENTS, 150),
    portamentoMs: num(env.SING_PORTAMENTO_MS, 35),
    timeoutMs: num(env.SING_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
    tmpDir: str(env.SING_TMP_DIR),
  };
}

/** 歌声合成的中间 SILK 落地位置（与 tts.js 同理：不用系统 temp）。 */
function tmpSilkPath(cfg) {
  const dir =
    cfg?.tmpDir ||
    path.join(import.meta.dirname, "..", "..", "data", "tts-tmp");
  const name = `chunhe-sing-${Date.now()}-${Math.floor(Math.random() * 1e6)}.silk`;
  return path.join(dir, name);
}

function runChild(spawnImpl, cmd, args, timeoutMs, env) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnImpl(cmd, args, { windowsHide: true, env });
    } catch (err) {
      resolve({ code: -1, error: err, stdout: "", stderr: "" });
      return;
    }
    let stdout = "";
    let stderr = "";
    let done = false;
    let timer = null;
    const finish = (payload) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      resolve({ stdout, stderr, ...payload });
    };
    timer = setTimeout(() => {
      try {
        child.kill?.();
      } catch {
        /* 杀不掉也无所谓 */
      }
      finish({ code: -1, timedOut: true });
    }, num(timeoutMs, DEFAULT_TIMEOUT_MS));

    child.stdout?.on?.("data", (d) => {
      stdout += d.toString();
    });
    child.stderr?.on?.("data", (d) => {
      stderr += d.toString();
    });
    child.on?.("error", (err) => finish({ code: -1, error: err }));
    child.on?.("close", (code) => finish({ code }));
  });
}

/**
 * 合成一首歌，返回 tencent SILK 字节。**永不抛出。**
 *
 * @param {ReturnType<typeof resolveSingConfig>} cfg
 * @param {object} [deps] 仅测试用
 * @returns {Promise<{ok: boolean, silk?: Buffer, reason: string, meta?: object}>}
 */
export async function synthesizeSong(cfg, deps = {}) {
  const spawnImpl = deps.spawn ?? nodeSpawn;
  const readFileImpl = deps.readFile ?? ((p) => fsp.readFile(p));
  const removeFileImpl = deps.removeFile ?? ((p) => fsp.rm(p, { force: true }).catch(() => {}));
  const makeTmpPath = deps.makeTmpPath ?? (() => tmpSilkPath(cfg));
  const scriptPath = deps.scriptPath ?? cfg?.script ?? defaultScriptPath();
  const scorePath = deps.scorePath ?? cfg?.score ?? defaultScorePath();

  if (!cfg?.enabled) return { ok: false, reason: "唱歌功能未启用" };
  if (!cfg.python) return { ok: false, reason: "未配置 SING_PYTHON / TTS_PYTHON" };

  const outPath = makeTmpPath();
  const args = [scriptPath, "--score", scorePath, "--out", outPath];
  if (cfg.singerDir) args.push("--voicebank", path.join(cfg.singerDir, "voicebank"),
                               "--vocoder", path.join(cfg.singerDir, "vocoder"));
  if (cfg.voicebank) args.push("--voicebank", cfg.voicebank);
  if (cfg.vocoder) args.push("--vocoder", cfg.vocoder);
  args.push("--vibrato-cents", String(cfg.vibratoCents));
  args.push("--scoop-cents", String(cfg.squeakCents));
  args.push("--portamento-ms", String(cfg.portamentoMs));

  const env = { ...process.env };
  if (cfg.singerDir) env.CHUNHE_SINGER_DIR = cfg.singerDir;

  const res = await runChild(spawnImpl, cfg.python, args, cfg.timeoutMs, env);

  if (res.error) return { ok: false, reason: `启动歌声助手失败：${res.error?.message ?? res.error}` };
  if (res.timedOut) return { ok: false, reason: `歌声合成超时（>${cfg.timeoutMs}ms）` };

  let payload = null;
  try {
    const lastLine = String(res.stdout).trim().split("\n").pop() ?? "";
    payload = lastLine ? JSON.parse(lastLine) : null;
  } catch {
    payload = null;
  }
  if (payload && payload.ok === false) {
    return { ok: false, reason: `歌声合成失败：${payload.error ?? "助手返回 ok:false"}` };
  }
  if (res.code !== 0) {
    const detail = String(payload?.error || res.stderr || "").trim().slice(0, 300);
    return { ok: false, reason: `歌声助手退出码 ${res.code}${detail ? `：${detail}` : ""}` };
  }

  let silk = null;
  try {
    silk = await readFileImpl(outPath);
  } catch (err) {
    await removeFileImpl(outPath);
    return { ok: false, reason: `读不到歌声文件（${err?.message ?? err}）` };
  }
  await removeFileImpl(outPath);

  if (!silk || silk.length === 0) return { ok: false, reason: "歌声文件为空，放弃发送" };

  return {
    ok: true,
    silk,
    reason: "",
    meta: payload ? { durationMs: payload.duration_ms, elapsed: payload.elapsed } : null,
  };
}

/**
 * 这条消息是不是在**要求**春禾唱歌？
 *
 * 触发词必须保守。第一版写成「同时出现『唱』和『歌』就触发」，结果
 * 「你会唱歌吗」「唱歌真好听」「别唱歌了」全都会触发，而且每次都发同一首，
 * 听感上就是"傻傻地重复发之前的音频"（用户反馈）。
 *
 * 现在要求是**明确的祈使句**：要么是命令式动词短语，要么以请求语气收尾。
 * 疑问、否定、评价一律不触发。
 *
 * 新增（2026-10-16）：光有「唱」+ 曲库里真有的**具体歌名**（「唱樱花草」）也算点歌。
 * 这条规则**必须**带上曲库白名单才生效（`opts.songNames`）：
 * 否则「我昨天在KTV唱稻香」这种叙述也会被当成点歌——而那正是这次要修的 bug
 * 的另一面（点了歌却唱成别的）。没有歌名表时行为与旧版完全一致。
 *
 * @param {string} text
 * @param {{songNames?: string[]}} [opts] 曲库里确实存在的歌名（不给 = 不启用新规则）
 */
export function isSingRequest(text, opts = {}) {
  const s = str(text);
  if (!s) return false;

  // 先排除：否定、疑问、评价、第三人称描述——这些都不是"要求她唱"
  if (/(不要|不用|不想|不想听|不会|能不能别)/.test(s)) return false;
  // 「别」只在否定**唱歌动作**时才算否定。
  // 不能写成裸的 /别/：曲库里有《送别》，「唱送别」会被那个「别」字误判成否定，
  // 主人点了歌却什么都没听到（已实测）。
  if (/别(?=[唱歌来点放听说])/.test(s)) return false;
  if (/(好听|难听|跑调|怎么样|如何|为什么|是不是|真的吗)/.test(s)) return false;
  // 「会唱歌吗」「在唱歌」「唱歌的时候」这类描述/疑问
  if (/(会唱|在唱|唱歌的|唱歌时|唱歌吗|唱过)/.test(s)) return false;

  // 明确的祈使请求
  if (/(唱|来|点)(一?首|个|一段|两句)/.test(s)) return true;        // 唱首歌 / 来一首 / 点一首
  if (/(给我唱|唱给我|唱给我听|你来唱|你唱)/.test(s)) return true;   // 给我唱 / 唱给我听
  if (/^(唱吧|唱歌|开唱|唱一个|点歌)/.test(s)) return true;         // 直接下令

  // 带具体歌名的点歌：「唱樱花草」「春禾唱稻香」「樱花草」（整句就是歌名）
  const names = Array.isArray(opts.songNames) ? opts.songNames.map(str).filter(Boolean) : [];
  if (names.length) {
    // 讲过去的事不算点歌（"昨天在KTV唱了稻香副歌"）
    if (/(昨天|上次|刚才|刚刚|那天|以前|曾经|小时候)/.test(s)) return false;
    const flat = normalizeForMatch(s);
    const guess = normalizeForMatch(extractSongName(s));
    const hit =
      names.find((n) => flat.includes(normalizeForMatch(n))) ||
      (guess.length >= 2 ? names.find((n) => normalizeForMatch(n).includes(guess)) : "");
    if (hit) {
      // 整句就是歌名（多半就是"点这首"）
      if (normalizeForMatch(extractSongName(s)) === normalizeForMatch(hit)) return true;
      // 或者话里带着唱歌动作
      if (/(唱|来|点|放)/.test(s)) return true;
    }
  }
  return false;
}
