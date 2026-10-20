/**
 * 存图：把主人发来的图片收进表情库。
 *
 * 为什么单独一个模块：发送（stickers.js）和「收素材」是两套生命周期——
 * 发送只读、永不写盘；存图要下载、校验格式、缩放、重名处理、记账、写 README。
 * 混在一起会让发送路径多出写文件的能力，这不是好事。
 *
 * 安全边界（硬性的，不靠提示词）：
 *  - 只有主人能存（引擎层判断）；
 *  - 单次只存一张，多图先问；
 *  - 必须是真图片（按魔数判断，不信扩展名/Content-Type）；
 *  - 单张不超过 STICKER_MAX_BYTES；超了就尝试缩到 128，缩不了如实拒绝；
 *  - 张数有上限（默认 200）；同一张图重复存会认出来，不重复占位；
 *  - 运行环境没有内容审核能力：默认**如实标记未审**；
 *    注入 moderate 钩子（可用时）判定不当就不入库。
 */

import { promises as fsp, existsSync, readdirSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { spawn } from "node:child_process";

import { fetchFileAsBuffer } from "./image.js";
import { botName } from "../persona/naming.js";
import {
  readImageSize,
  PROJECT_ROOT,
  STICKER_EXTENSIONS,
  STICKER_SUGGESTED_PX,
  stickerNamesOf,
} from "./stickers.js";

/** 下载上限：比入库上限宽松，留给缩放；再大就不下 */
export const STICKER_SOURCE_MAX_BYTES = 12 * 1024 * 1024;
/** 整个表情库的体积上限（按张数也有上限，双保险） */
export const STICKER_LIBRARY_MAX_BYTES = 60 * 1024 * 1024;

const EXT_OF_FORMAT = { jpeg: "jpg", png: "png", gif: "gif", webp: "webp" };

const COMMAND_WORDS_RE =
  /(?:存下来|存起来|存进|存到|存入|存在|收下这张|收下|收起来|收藏起来|收藏|记住了?|记住这张|把这张|把那个|把这张图|入库|放进|加到|当你的表情包|当你表情包|当表情包|当你的|以后|留着|有人|别人|要|就|再|发这张|发给你|发出来|用这张|用这个|用|吧|了|呀|啊|哦|嘛|呢|哈|~|～|，|,|。|！|!|？|\?)/g;
const LEADING_FILLER_RE =
  /^(?:主人|春禾|你|我|这个|这张|那个|那张|这张图|这个图|图片|图|表情包|表情|你的|我的)\s*/g;

const GENERIC_NAMES = new Set([
  "存",
  "收",
  "记",
  "发",
  "用",
  "图",
  "图片",
  "表情",
  "表情包",
  "这个",
  "那个",
  "这张",
  "那张",
]);

const EXPLICIT_NAME_RE =
  /(?:叫(?:它|这个|这张|做|成)?|名字(?:叫|是)|取名(?:叫)?|起名(?:叫)?)\s*[「“"']?([^」”"'，,。！？!?\s]{1,12})/;

/**
 * 这句话是不是在让春禾把某张图存进表情库？
 *
 * @returns {{strong: boolean, name: string}|null}
 *   strong=true 表示是「存/收/收藏/入库」这类明确动作；没有图时值得问一句「图呢」。
 *   weak（例如「这个以后用」）只在确实有图/有待存图片时才处理，避免把日常话误当指令。
 */
export function detectStickerSaveRequest(rawText, { hasPendingImage = false } = {}) {
  const text = String(rawText ?? "").trim();
  if (!text) return null;

  // 否定/取消：主人明确说别存，就别自作主张
  if (/(?:别|不要|不用|不必|先不|别急着|算了)\s*(?:存|收|收藏|记)|存(?:着)?(?:不用|干嘛)/.test(text)) {
    return null;
  }

  const direct =
    /(?:存|收)(?:下来|起来|进|到|入|着|一下|了)|收下(?:这张|这个|它)?|收藏(?:一下|起来)?|入库|放进(?:你的)?表情库|加到(?:你的)?表情库/;
  const contextual =
    /把(?:这张|这个|那张|那个)?(?:图)?(?:记住|存|收)|记住这张|当(?:你的|我)?(?:的)?表情包|(?:这个|这张|那个|那张)[^。！？!?]{0,8}(?:以后|留着)[^。！？!?]{0,6}(?:用|发)|(?:以后|留着)[^。！？!?]{0,10}(?:就|再)(?:发|用)(?:这张|这个|它|这个表情|这张图)|(?:存|收|放|加|进|入)[^。！？!?]{0,6}表情库|表情库[^。！？!?]{0,6}(?:存|收|放|加)/;

  const strong = direct.test(text);
  if (strong) {
    const m = EXPLICIT_NAME_RE.exec(text);
    return { strong, name: sanitizeStickerName(m?.[1] ?? "") };
  }
  if (contextual.test(text)) {
    const m = EXPLICIT_NAME_RE.exec(text);
    return { strong: false, name: sanitizeStickerName(m?.[1] ?? "") };
  }

  // ⭐ 2026-10-19 修：**有候选图时**放宽判定。
  //   真机：主人在私聊连发几张图，说「这个也行」「无语时就发这张」——
  //   这些都不是标准存图话术，但意思显然是「把这张收了」。
  //   只在**确实刚发过图**时放宽，避免把日常闲聊误当指令。
  if (hasPendingImage) {
    const accepts =
      /(?:这个|这张|它|就这个|就这张)(?:也|就)?(?:行|可以|好|不错|要|收|算)|^(?:行|可以|好|要|收了|收)$|(?:无语|不想说话|烦|生气|被骚扰|有人说|有人问)[^。！？!?]{0,10}(?:就|的时候)?[^。！？!?]{0,6}(?:发|用)(?:这张|这个|它)/;
    if (accepts.test(text)) {
      const m = EXPLICIT_NAME_RE.exec(text);
      return { strong: false, name: sanitizeStickerName(m?.[1] ?? ""), weakAccept: true };
    }
  }
  return null;
}

/** 文件名/别名清洗：去掉非法字符、路径分隔符、别名分隔符、首尾点号 */
export function sanitizeStickerName(raw) {
  let s = String(raw ?? "").trim();
  if (!s) return "";
  s = s
    .replace(/[「」“”"'《》【】()（）]/g, "")
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "")
    .replace(/[,，]/g, "")
    .replace(/[.。]+$/g, "")
    .replace(/^[.\s]+|[.\s]+$/g, "");
  s = Array.from(s).slice(0, 20).join("").trim();
  if (!s || GENERIC_NAMES.has(s)) return "";
  if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(s)) s = `表情-${s}`;
  return s;
}

/**
 * 没指定名字时，从主人原话里提取一个有意义的名字。
 *
 * 例：「这个好玩，存下来」→ 好玩；「以后有人要床照就发这张」→ 床照。
 * 提取不出就返回 ""（调用方用时间戳兜底），绝不硬编一个"表情包1"。
 */
export function inferStickerName(rawText) {
  let s = String(rawText ?? "").replace(/[「」“”"'《》【】()（）]/g, " ").trim();
  if (!s) return "";
  s = s.replace(COMMAND_WORDS_RE, " ").replace(LEADING_FILLER_RE, " ").trim();
  // 去掉标点，按第一段有意义的词取名字
  const parts = s.split(/[\s，,。！？!?；;：:~～]+/).map((p) => p.trim()).filter(Boolean);
  for (const p of parts) {
    const cleaned = p.replace(LEADING_FILLER_RE, "").replace(COMMAND_WORDS_RE, "").trim();
    const name = sanitizeStickerName(cleaned);
    if (name && Array.from(name).length >= 2) return Array.from(name).slice(0, 8).join("");
  }
  return "";
}

/** 按魔数判断真实格式（QQ 存下来的图经常扩展名和格式对不上） */
export function stickerFormatOf(buf) {
  if (!buf || buf.length < 6) return "";
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpeg";
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "png";
  if (buf.toString("latin1", 0, 4) === "GIF8") return "gif";
  if (
    buf.length >= 12 &&
    buf.toString("latin1", 0, 4) === "RIFF" &&
    buf.toString("latin1", 8, 12) === "WEBP"
  ) {
    return "webp";
  }
  return "";
}

function sha1(buf) {
  return crypto.createHash("sha1").update(buf).digest("hex");
}

function formatBytes(n) {
  const b = Number(n) || 0;
  if (b >= 1024 * 1024) return `${(b / 1024 / 1024).toFixed(1)}MB`;
  return `${Math.max(1, Math.round(b / 1024))}KB`;
}

function two(n) {
  return String(n).padStart(2, "0");
}

function dateLabel(now) {
  return `${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())}`;
}

function timestampName(now) {
  return `表情${two(now.getMonth() + 1)}${two(now.getDate())}-${two(now.getHours())}${two(now.getMinutes())}`;
}

/** 默认依赖：全部走真实文件系统 */
function fsDeps(deps = {}) {
  return {
    readdir: deps.readdir ?? ((p) => fsp.readdir(p, { withFileTypes: true })),
    readFile: deps.readFile ?? ((p) => fsp.readFile(p)),
    writeFile: deps.writeFile ?? ((p, b) => fsp.writeFile(p, b)),
    mkdir: deps.mkdir ?? ((p) => fsp.mkdir(p, { recursive: true })),
    appendFile: deps.appendFile ?? ((p, s) => fsp.appendFile(p, s, "utf8")),
    exists: deps.exists ?? ((p) => existsSync(p)),
  };
}

/** 「这张是主人教的挡箭牌」这类用途关键词 */
const HARASS_PURPOSE_RE = /骚扰|床照|裸照|私照|挡箭|还击|有人要|有人问|恶心|烦人|不想说话/;

/**
 * 记「主人教的」元数据（`.taught.json`）。
 *
 * 为什么需要：挑表情时原来**只在她自己的「春禾-*」15 张里挑**，
 * 主人教的图名字不带前缀，永远用不上（真机反馈：「她并没有用我给的图片还击」）。
 * 有了这份元数据，`stickers.listStickers` 能打上 taught/purpose 标记，
 * `sticker-mood` 在被骚扰时就会优先用主人教的挡箭牌。
 *
 * 写失败只告警，不回滚已入库的图。
 */
async function appendTaughtMeta({ cfg, finalName, caption, now, deps, logger }) {
  try {
    const fd = fsDeps(deps);
    const metaPath = path.join(cfg.dir, ".taught.json");
    let meta = {};
    try {
      const raw = String(await fd.readFile(metaPath));
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") meta = parsed;
    } catch {
      /* 首次写入 */
    }
    const purpose = HARASS_PURPOSE_RE.test(String(caption ?? "")) ? "harassment" : "";
    meta[finalName] = {
      savedAt: new Date(Number(now) || Date.now()).toISOString(),
      caption: String(caption ?? "").replace(/\s+/g, " ").trim().slice(0, 80),
      purpose,
    };
    await fd.writeFile(metaPath, JSON.stringify(meta, null, 2));
  } catch (err) {
    logger?.warn?.(`表情元数据写入失败（不影响入库）：${err?.message ?? err}`);
  }
}

async function appendReadme({ cfg, file, name, reviewed, now, deps, logger }) {  const fd = fsDeps(deps);
  const readme = path.join(cfg.dir, "README.md");
  let content = "";
  try {
    content = String(await fd.readFile(readme));
  } catch {
    /* 没有 README 就新建 */
  }
  const header = "## 主人教的（新存入）";
  let add = "";
  if (!content.includes(header)) {
    if (content && !content.endsWith("\n")) add += "\n";
    add += `\n${header}\n`;
  } else if (!content.endsWith("\n")) {
    add += "\n";
  }
  add += `- \`${file}\` — 名字「${name}」，主人教的，${dateLabel(now)}${reviewed ? "" : "（未审）"}\n`;
  try {
    await fd.appendFile(readme, add);
  } catch (err) {
    // README 写失败不该让已经落盘的素材回滚，但必须留痕
    logger?.warn?.(`表情库 README 追加失败：${err?.message ?? err}`);
  }
}

/**
 * 把一个图片 Buffer 存进表情库。
 *
 * @param {object} opts
 * @param {Buffer} opts.buf
 * @param {string} [opts.caption] 主人的原话（用于起名）
 * @param {string} [opts.name] 主人指定的名字
 * @param {{enabled:boolean,dir:string,maxBytes:number,maxCount?:number}} opts.cfg
 * @param {object} [opts.deps] 可注入：resizeImage / moderate / fs / now / logger
 * @returns {Promise<object>} 永不抛出；ok=false 时带 code 与给主人看的 message
 */
export async function saveStickerBuffer({ buf, caption = "", name = "", cfg, deps = {} }) {
  const logger = deps.logger;
  const now = typeof deps.now === "function" ? deps.now() : (deps.now ?? new Date());
  const fd = fsDeps(deps);

  if (!cfg?.enabled) {
    return { ok: false, code: "disabled", message: "表情包功能现在关着，存不了。" };
  }
  if (!cfg.dir) {
    return { ok: false, code: "no_dir", message: "表情库目录没配置，存不了。" };
  }
  if (!Buffer.isBuffer(buf) || buf.length === 0) {
    return { ok: false, code: "invalid_format", message: "这张没读到图片内容，存不了。" };
  }

  let format = stickerFormatOf(buf);
  if (!format) {
    return {
      ok: false,
      code: "invalid_format",
      message: "这不是" + botName() + "能存的图片（只认 jpg/png/webp/gif）。",
    };
  }

  // 内容审核：默认没有这个能力，如实标记未审；注入钩子且判定不安全就不入库
  let reviewed = false;
  if (typeof deps.moderate === "function") {
    try {
      const verdict = await deps.moderate({ buf, caption, format });
      if (verdict && verdict.safe === false) {
        const why = String(verdict.reason ?? "").trim();
        return {
          ok: false,
          code: "moderated",
          message: `这张${botName()}觉得不太合适${why ? `（${why}）` : ""}，先没放进表情库。`,
        };
      }
      reviewed = true;
    } catch (err) {
      logger?.warn?.(`存图审核失败（按未审处理）：${err?.message ?? err}`);
    }
  }

  // 扫现有素材：张数上限、体积上限、同名别名、内容去重
  let entries = [];
  try {
    entries = await fd.readdir(cfg.dir);
  } catch {
    /* 目录还不存在：下面 mkdir 会建 */
  }
  const files = entries
    .filter((e) => {
      const isFile = typeof e?.isFile === "function" ? e.isFile() : true;
      return isFile && STICKER_EXTENSIONS.includes(path.extname(e?.name ?? "").toLowerCase());
    })
    .map((e) => e.name ?? String(e));

  const maxCount = Math.max(1, Number(cfg.maxCount) || 200);
  if (files.length >= maxCount) {
    return {
      ok: false,
      code: "limit",
      message: `表情库已经到上限了（${maxCount} 张），主人先删几张，${botName()}再存。`,
    };
  }

  const existing = [];
  let totalBytes = 0;
  for (const file of files) {
    try {
      const b = await fd.readFile(path.join(cfg.dir, file));
      totalBytes += b.length;
      existing.push({ file, buf: b });
    } catch (err) {
      logger?.debug?.(`旧表情读取失败（${file}）：${err?.message ?? err}`);
    }
  }
  if (totalBytes > STICKER_LIBRARY_MAX_BYTES) {
    return {
      ok: false,
      code: "limit",
      message: `表情库体积到上限了（${formatBytes(totalBytes)}），主人先清理几张再存。`,
    };
  }

  const hash = sha1(buf);
  for (const e of existing) {
    if (sha1(e.buf) === hash) {
      const dupName = stickerNamesOf(e.file)[0] || e.file;
      return {
        ok: true,
        duplicate: true,
        code: "duplicate",
        name: dupName,
        file: e.file,
        bytes: e.buf.length,
        message: `这张${botName()}库里已经有啦，叫「${dupName}」，就不重复存了。`,
      };
    }
  }

  // 缩放：像素超过 128 或字节超限时处理（和现有素材保持一致，QQ 气泡才不会巨大）
  let outBuf = buf;
  let outFormat = format;
  let resized = false;
  const size = readImageSize(buf);
  const tooBig = buf.length > cfg.maxBytes;
  const tooWide = !size || Math.max(size.width, size.height) > STICKER_SUGGESTED_PX;
  if (tooBig || tooWide) {
    const resizeImpl = deps.resizeImage ?? resizeWithFfmpeg;
    let result = null;
    try {
      result = await resizeImpl(buf, {
        format,
        maxBytes: cfg.maxBytes,
        targetPx: STICKER_SUGGESTED_PX,
        ffmpegPath: deps.ffmpegPath,
        logger,
      });
    } catch (err) {
      logger?.warn?.(`存图缩放失败：${err?.message ?? err}`);
    }
    if (result?.buf?.length) {
      outBuf = result.buf;
      outFormat = stickerFormatOf(outBuf) || result.format || format;
      resized = true;
    } else if (tooBig) {
      return {
        ok: false,
        code: "too_large",
        message:
          `图有 ${formatBytes(buf.length)}，超过 ${formatBytes(cfg.maxBytes)} 上限，` +
          "" + botName() + "这边也没法缩（没找到缩图工具），存不了。主人发张小一点的或者截一下？",
      };
    } else {
      // 没缩成但体积没超：先存原图，别因为工具缺失就把主人的图拒之门外
      logger?.warn?.(`存图未缩放（${size ? `${size.width}×${size.height}` : "尺寸未知"}），按原图存储`);
    }
  }
  if (outBuf.length > cfg.maxBytes) {
    return {
      ok: false,
      code: "too_large",
      message: `缩完还有 ${formatBytes(outBuf.length)}，超过 ${formatBytes(cfg.maxBytes)} 上限，存不了。`,
    };
  }
  if (!outFormat) outFormat = format;

  // 命名：主人指定 > 原话提取 > 时间戳；重名加后缀，绝不覆盖
  let base =
    sanitizeStickerName(name) ||
    inferStickerName(caption) ||
    timestampName(now);
  let finalName = base;
  const taken = new Set();
  for (const e of existing) for (const n of stickerNamesOf(e.file)) taken.add(n);
  for (let i = 2; taken.has(finalName) || (fd.exists(path.join(cfg.dir, `${finalName}.${EXT_OF_FORMAT[outFormat]}`))); i += 1) {
    finalName = `${base}-${i}`;
  }
  const file = `${finalName}.${EXT_OF_FORMAT[outFormat]}`;

  await fd.mkdir(cfg.dir);
  await fd.writeFile(path.join(cfg.dir, file), outBuf);
  await appendReadme({ cfg, file, name: finalName, reviewed, now, deps, logger });
  // 记「主人教的」元数据：挑表情时「被骚扰」场合要优先用这张挡箭牌。
  // 见 stickers.js 的 taught 标记与 sticker-mood.js 的 taughtFirst。
  await appendTaughtMeta({ cfg, finalName, caption, now, deps, logger });

  const newSize = readImageSize(outBuf);
  const notes = [];
  if (!reviewed) notes.push("" + botName() + "看不出内容合不合适");
  if (resized) notes.push("原图太大已经缩到 128px");
  const note = notes.length ? `，${notes.join("，")}` : "";
  const message = `存下了，叫它「${finalName}」。（主人教的${note}）`;

  logger?.info?.(`存图成功：${file}（${formatBytes(outBuf.length)}${resized ? "，已缩放" : ""}）`);

  return {
    ok: true,
    duplicate: false,
    code: "saved",
    name: finalName,
    file,
    bytes: outBuf.length,
    width: newSize?.width,
    height: newSize?.height,
    format: outFormat,
    resized,
    reviewed,
    count: files.length + 1,
    message,
  };
}

/**
 * 从 QQ 附件下载并入库。
 * 下载失败不抛：返回 ok=false + 给主人看的诚意文案。
 */
export async function ingestStickerAttachment({ attachment, caption = "", name = "", cfg, deps = {} }) {
  const url = String(attachment?.url ?? "").trim();
  if (!url) {
    return { ok: false, code: "no_url", message: "这张图没拿到下载地址，主人重新发一次？" };
  }
  const fetchFn = deps.fetchFileAsBuffer ?? fetchFileAsBuffer;
  let got = null;
  try {
    got = await fetchFn(url, {
      maxBytes: STICKER_SOURCE_MAX_BYTES,
      fetchImpl: deps.fetchImpl,
      logger: deps.logger,
    });
  } catch (err) {
    deps.logger?.warn?.(`存图下载异常：${err?.message ?? err}`);
  }
  if (!got?.buf?.length) {
    return {
      ok: false,
      code: "download_failed",
      message: "图没下载下来（可能链接过期了）。主人重新发一次那张图，我马上存。",
    };
  }
  return saveStickerBuffer({ buf: got.buf, caption, name, cfg, deps });
}

// ---------------------------------------------------------------------------
// 缩放：运行时没有图像库，优先用本机 ffmpeg（存在才用；找不到就如实降级）
// ---------------------------------------------------------------------------

let cachedFfmpeg = null;

/** 找 ffmpeg：env → PATH → 本机已知位置（项目零依赖，不能要求主人装东西） */
export function findFfmpeg(explicit) {
  if (explicit !== undefined) {
    if (!explicit) return "";
    return existsSync(explicit) ? explicit : "";
  }
  if (cachedFfmpeg !== null) return cachedFfmpeg;

  const envPath = String(process.env.STICKER_FFMPEG ?? process.env.FFMPEG_PATH ?? "").trim();
  const candidates = [];
  if (envPath) candidates.push(envPath);
  for (const dir of String(process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    candidates.push(path.join(dir, process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg"));
  }
  // 本机现成的：唱歌训练用 / 变声器组件目录
  candidates.push(path.resolve(PROJECT_ROOT, "..", "_tts-train", "bin", "ffmpeg.exe"));
  try {
    const base = path.resolve(PROJECT_ROOT, "..", "变声器", "data", "components");
    for (const name of readdirSync(base)) {
      if (/^ffmpeg/i.test(name)) {
        // 变声器自带的两种布局都试：`ffmpeg-x.y.z/bin/ffmpeg.exe` 和 `ffmpeg-x.y.z/ffmpeg.exe`
        candidates.push(path.join(base, name, "bin", "ffmpeg.exe"));
        candidates.push(path.join(base, name, "ffmpeg.exe"));
      }
    }
  } catch {
    /* 目录不存在就算了 */
  }

  cachedFfmpeg = candidates.find((p) => p && existsSync(p)) ?? "";
  return cachedFfmpeg;
}

function runProcess(cmd, args, timeoutMs = 15000) {
  return new Promise((resolve) => {
    let settled = false;
    let stderr = "";
    let child;
    try {
      child = spawn(cmd, args, { windowsHide: true });
    } catch (err) {
      resolve({ ok: false, reason: err?.message ?? String(err) });
      return;
    }
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill();
      } catch {
        /* ignore */
      }
      resolve({ ok: false, reason: "timeout" });
    }, timeoutMs);
    child.stderr?.on("data", (d) => {
      stderr += String(d);
    });
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, reason: err?.message ?? String(err) });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: code === 0, reason: stderr.slice(0, 300) });
    });
  });
}

/**
 * 用 ffmpeg 把图缩到最长边 128（保留宽高比）。
 * 失败/没有 ffmpeg 返回 null，由调用方决定拒绝还是按原图存。
 */
export async function resizeWithFfmpeg(buf, opts = {}) {
  const ffmpeg = findFfmpeg(opts.ffmpegPath);
  if (!ffmpeg) return null;
  const sourceFormat = stickerFormatOf(buf) || opts.format || "jpeg";
  const inExt = sourceFormat === "jpeg" ? "jpg" : sourceFormat;
  // webp 输出统一转 png：编码器不一定全，png 最稳
  const outFormat = sourceFormat === "webp" ? "png" : sourceFormat;
  const outExt = EXT_OF_FORMAT[outFormat] || "png";

  // 临时文件放在项目 data/tmp 下：Windows 上 ffmpeg 子进程写系统 TEMP 可能被
  // 安全软件/权限策略拒绝（实测 Permission denied），项目目录内最稳。
  const tmpRoot = path.join(PROJECT_ROOT, "data", "tmp");
  let tmp;
  try {
    await fsp.mkdir(tmpRoot, { recursive: true });
    tmp = await fsp.mkdtemp(path.join(tmpRoot, "sticker-"));
  } catch {
    tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "chunhe-sticker-"));
  }
  const inPath = path.join(tmp, `in.${inExt}`);
  const outPath = path.join(tmp, `out.${outExt}`);
  try {
    await fsp.writeFile(inPath, buf);
    const args = [
      "-y",
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      inPath,
      "-vf",
      `scale=${STICKER_SUGGESTED_PX}:${STICKER_SUGGESTED_PX}:force_original_aspect_ratio=decrease:flags=lanczos`,
    ];
    if (outFormat === "jpeg") args.push("-q:v", "4");
    if (outFormat === "png") args.push("-compression_level", "9");
    if (outFormat === "gif") args.push("-loop", "0");
    // 静图输出必须 -update 1，否则 image2 复用器会要求文件名带 %03d 而直接失败
    if (outFormat === "jpeg" || outFormat === "png") args.push("-update", "1");
    args.push(outPath);

    const run = await runProcess(ffmpeg, args);
    if (!run.ok) {
      opts.logger?.warn?.(`ffmpeg 缩图失败：${run.reason}`);
      return null;
    }
    const out = await fsp.readFile(outPath);
    const actual = stickerFormatOf(out);
    if (!out.length || !actual) return null;
    const size = readImageSize(out);
    return { buf: out, format: actual, width: size?.width, height: size?.height };
  } catch (err) {
    opts.logger?.warn?.(`缩图异常：${err?.message ?? err}`);
    return null;
  } finally {
    try {
      await fsp.rm(tmp, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}
