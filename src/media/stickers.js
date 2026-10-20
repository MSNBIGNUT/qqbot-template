/**
 * 表情包（自定义表情）发送。
 *
 * 背景：QQ 官方机器人**没有「表情包」这个独立消息类型**——官方发送侧只有
 * msg_type 0/2/3/7（文本/Markdown/卡片/富媒体），且「表情表态」仅频道支持，
 * 单聊与群聊都是 ❌。
 *
 * 所以表情包**就是图片**：走既有的 file_type=1 + msg_type=7 这条路，
 * 与本项目发图/发语音用的是同一条已验证的链路，不碰协议层。
 *
 * 素材放在 assets/stickers/，文件名（去扩展名）就是名字。见该目录的 README。
 */

import { promises as fsp } from "node:fs";
import path from "node:path";

export const STICKER_TOOL_NAME = "send_sticker";
export const DEFAULT_STICKER_DIR = path.join("assets", "stickers");
/** 允许的图片格式；gif 也走 file_type=1 */
export const STICKER_EXTENSIONS = [".png", ".jpg", ".jpeg", ".webp", ".gif"];
/** 单张上限：QQ 富媒体有上限，超了会被平台拒 */
export const DEFAULT_STICKER_MAX_BYTES = 2 * 1024 * 1024;
/**
 * 建议的最长边（像素）。
 *
 * 实测结论：QQ 按**图片像素尺寸**决定气泡大小，与消息类型无关——
 * 同一张图，128px 显示成小块，300px 就明显偏大（用户对比确认过 128 合适）。
 * 所以素材要预先缩小；这个常量只用来「发现没缩的图并提醒」，不做拦截，
 * 因为运行时没有图像库（本项目零依赖），改不了像素。
 */
export const STICKER_SUGGESTED_PX = 128;
/** 超过这个尺寸就认为「忘了缩」，值得提醒一句 */
export const STICKER_WARN_PX = 256;

/**
 * 读图片的像素尺寸（只解文件头，不依赖任何图像库）。
 *
 * 支持 PNG / JPEG / GIF——覆盖 QQ 表情包的全部常见格式。
 * 解不出来就返回 null（不该因为量不出尺寸就发不出去）。
 */
export function readImageSize(buf) {
  if (!buf || buf.length < 10) return null;

  // PNG：8 字节签名 + IHDR，宽高是大端 32 位
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    if (buf.length < 24) return null;
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), format: "png" };
  }

  // GIF：'GIF8'，宽高是小端 16 位
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) {
    return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8), format: "gif" };
  }

  // WebP：RIFF....WEBP。三种子格式的宽高位置不同（与表情库扩展名 .webp 对应）
  if (
    buf.length >= 30 &&
    buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
    buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50
  ) {
    const chunk = buf.toString("latin1", 12, 16);
    if (chunk === "VP8X") {
      return {
        width: 1 + buf.readUIntLE(24, 3),
        height: 1 + buf.readUIntLE(27, 3),
        format: "webp",
      };
    }
    if (chunk === "VP8 ") {
      return {
        width: buf.readUInt16LE(26) & 0x3fff,
        height: buf.readUInt16LE(28) & 0x3fff,
        format: "webp",
      };
    }
    if (chunk === "VP8L" && buf[20] === 0x2f) {
      const b = buf.readUInt32LE(21);
      return {
        width: (b & 0x3fff) + 1,
        height: ((b >> 14) & 0x3fff) + 1,
        format: "webp",
      };
    }
  }

  // JPEG：扫到 SOFn 段（排除 DHT/JPG 等非 SOF 的 0xC4/0xC8/0xCC）
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    // 读 SOF 要访问到 i+8，所以边界是 i+9 <= 长度（写 < 会漏掉紧贴结尾的 SOF）
    while (i + 9 <= buf.length) {
      if (buf[i] !== 0xff) {
        i += 1;
        continue;
      }
      const marker = buf[i + 1];
      if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)) {
        i += 2;
        continue;
      }
      const len = buf.readUInt16BE(i + 2);
      const isSOF = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isSOF) {
        return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7), format: "jpeg" };
      }
      i += 2 + len;
    }
  }

  return null;
}

const here = import.meta.dirname; // <项目>/src/media
/** 项目根目录（src/media 往上两级） */
export const PROJECT_ROOT = path.resolve(here, "..", "..");

function str(v) {
  return typeof v === "string" ? v.trim() : v == null ? "" : String(v).trim();
}

function num(v, fallback) {
  const n = Number(str(v));
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * 解析表情包配置。
 *
 * `enabled` 只表示「没被显式关掉」；真正有没有表情包要等 listStickers 扫目录。
 * 目录空 = 不注册工具（与画图没 key 就不注册工具同一个原则：
 * 装一个必然失败的工具，只会让模型每轮都调、每次都失败）。
 */
export function resolveStickerConfig(env = {}) {
  const dir = str(env.STICKER_DIR) || DEFAULT_STICKER_DIR;
  return {
    enabled: str(env.STICKER_ENABLED).toLowerCase() !== "false",
    dir: path.isAbsolute(dir) ? dir : path.join(PROJECT_ROOT, dir),
    maxBytes: num(env.STICKER_MAX_BYTES, DEFAULT_STICKER_MAX_BYTES),
    /** 表情库上限（张）。存图会把主人发的图加进来，必须有硬上限 */
    maxCount: Math.max(1, Math.floor(num(env.STICKER_MAX_COUNT, 200))),
    /** 是否允许引擎在轻松场合主动补一张（关掉就只保留「用户明确要」和模型工具） */
    auto: str(env.STICKER_AUTO).toLowerCase() !== "false",
  };
}

/** 文件名 → 表情包名（同时支持 `开心,高兴,笑.png` 这种多别名写法） */
export function stickerNamesOf(filename) {
  const base = filename.replace(/\.[^.]+$/, "");
  return base
    .split(/[,，]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function mimeOf(file) {
  const s = file.toLowerCase();
  if (s.endsWith(".png")) return "image/png";
  if (s.endsWith(".webp")) return "image/webp";
  if (s.endsWith(".gif")) return "image/gif";
  return "image/jpeg";
}

/**
 * 扫出可用的表情包。**永不抛出**：目录不存在/读不了就当作没有。
 *
 * @returns {Promise<Array<{name: string, file: string, path: string, ext: string}>>}
 */
export async function listStickers(cfg, deps = {}) {
  if (!cfg?.enabled) return [];
  const readdirImpl = deps.readdir ?? ((p) => fsp.readdir(p, { withFileTypes: true }));
  const logger = deps.logger;

  let entries;
  try {
    entries = await readdirImpl(cfg.dir);
  } catch (err) {
    // 还没放素材是最常见的情况，不该吵；debug 足够
    logger?.debug?.(`表情包目录不可用（${cfg.dir}）：${err?.message ?? err}`);
    return [];
  }

  const out = [];
  // 2026-10-19：读「主人教的」元数据，打上 taught 标记。
  // 起因：主人教的挡箭牌图（「以后有人要床照就发这张」）名字不是「春禾-*」，
  // 而挑表情时**只在自己的 15 张里挑**，导致他教的图永远用不上（真机反馈）。
  let taughtMap = {};
  try {
    const metaPath = path.join(cfg.dir, ".taught.json");
    const raw = await (deps.readFile ?? ((p) => fsp.readFile(p, "utf8")))(metaPath);
    const parsed = JSON.parse(String(raw));
    if (parsed && typeof parsed === "object") taughtMap = parsed;
  } catch {
    /* 没有元数据文件是正常情况 */
  }
  for (const e of entries) {
    const isFile = typeof e?.isFile === "function" ? e.isFile() : true;
    if (!isFile) continue;
    const filename = e?.name ?? String(e);
    const ext = path.extname(filename).toLowerCase();
    if (!STICKER_EXTENSIONS.includes(ext)) continue; // 跳过 README.md 之类
    const stem = path.basename(filename, ext);
    const meta = taughtMap?.[stem] ?? null;
    for (const name of stickerNamesOf(filename)) {
      out.push({
        name,
        file: filename,
        path: path.join(cfg.dir, filename),
        ext,
        ...(meta ? { taught: true, purpose: String(meta.purpose ?? "") } : {}),
      });
    }
  }
  // 名字排序，保证工具描述稳定（便于测试与排查）
  out.sort((a, b) => a.name.localeCompare(b.name, "zh"));
  return out;
}

/** 构造 generate 用的工具定义；把可用名字写成 enum，模型就不会瞎编 */
export function buildStickerTool(names, { description } = {}) {
  const list = Array.isArray(names) ? names.filter(Boolean) : [];
  if (list.length === 0) return null;

  return {
    type: "function",
    function: {
      name: STICKER_TOOL_NAME,
      description:
        description ??
        "发一个表情包（贴图）给对话方。适合表达情绪或接梗，比打字更有味道。" +
          "可用名字见参数 enum。别每条都发，也别刷屏。",
      parameters: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "要发的表情包名字（从 enum 里选）",
            enum: list,
          },
        },
        required: ["name"],
      },
    },
  };
}

/** 能对应到素材文件的情绪词（用户说「来个比心」时要能落到「春禾-比心」） */
export const STICKER_MOOD_WORDS = [
  "卖萌", "撒娇", "比心", "害羞", "开心", "得意", "委屈", "哭哭", "无语",
  "生气", "震惊", "困了", "星星眼", "抱歉", "谢谢", "疑问", "加油",
];

/** 问「有几个/能不能」时不是在要图，别触发 */
const STICKER_NOT_A_REQUEST_RE =
  /(?:几个|多少|哪些|有没有|能不能|会不会|可不可以|行不行|发不了|发不出|只能发|发不到|转不到)/;

/**
 * 这句话是不是在**要一张表情包**？
 *
 * 为什么需要它：只靠模型的工具选择，同一个「看看你卖萌的样子」有时发图、
 * 有时只回文字（真机 2026-10-17 22:22 就是后者）。表情包是引擎能确定做到的事，
 * 不该交给模型掷骰子——命中就由引擎直接发。
 *
 * 返回 `{keyword, generic}`：
 *   - keyword：用户点名的情绪（卖萌/比心/…），用来选具体那张；
 *   - generic：只说「发个表情包」，没点名，随便挑一张。
 * 不是要图时返回 null。
 *
 * @param {string} rawText
 * @returns {{keyword: string, generic: boolean}|null}
 */
export function detectStickerRequest(rawText) {
  const text = String(rawText ?? "").trim();
  if (!text) return null;
  if (STICKER_NOT_A_REQUEST_RE.test(text)) return null;
  // 「能发个比心吗」是能力询问/客气话，先别替她决定发哪张
  if (/(?:吗|呢|么)\s*[?？]?\s*$/.test(text) && /(?:能|会|可以)/.test(text)) return null;

  // ① 明确提到「表情包 / 贴图 / 表情」：这就是要图
  if (/(?:表情包|贴图|表情)/.test(text)) return { keyword: "", generic: true };

  // ② 「看看你卖萌的样子」「来个比心」「发张星星眼」：点名了情绪，但没提"表情包"
  const moods = STICKER_MOOD_WORDS.join("|");
  const re = new RegExp(
    `(?:看看|瞧瞧|看下|看一下|来(?:个|张|一张)?|发(?:个|张|一张)?|整(?:个|张)?|给我来?)` +
      `(?:你|你的|一个)?(?:的)?[^。！？!?\\n]{0,6}?(${moods})(?:的(?:样子|表情|图)?)?`,
  );
  const hit = re.exec(text);
  if (hit) return { keyword: hit[1], generic: false };
  return null;
}

/**
 * 从素材库里挑一张。
 *
 * 优先「春禾-」开头的自家表情包（用户说「看看**你**卖萌的样子」时，
 * 发一张猫猫图就不对了）；点名的情绪优先精确匹配，其次包含匹配。
 * 挑不到就返回 ""，调用方按「没有素材」处理，绝不编一个名字。
 *
 * @param {Array<{name:string}>} stickers
 * @param {{keyword?: string, generic?: boolean}} req
 * @returns {string}
 */
export function pickStickerName(stickers, req = {}) {
  const list = Array.isArray(stickers) ? stickers : [];
  if (!list.length) return "";
  const own = list.filter((s) => s.name.startsWith("春禾-"));
  const pool = own.length ? own : list;
  const kw = String(req?.keyword ?? "").trim();

  if (kw) {
    const hit =
      pool.find((s) => s.name === kw) ||
      pool.find((s) => s.name.includes(kw)) ||
      pool.find((s) => kw.includes(s.name)) ||
      list.find((s) => s.name.includes(kw));
    if (hit) return hit.name;
  }
  if (!kw && !req?.generic) return "";
  // 没点名：优先「开心」（最安全，不会表错情），否则取排序后的第一张
  return (pool.find((s) => /开心/.test(s.name)) ?? pool[0]).name;
}

/**
 * 执行表情包工具调用。
 *
 * 契约与画图工具一致：返回 { ok, images, content }，**永不抛出**。
 * images 会被上层当作「待发送的图片」走富媒体链路发出去。
 */
export async function executeStickerCall(name, rawArgs, cfg, deps = {}) {
  if (name !== STICKER_TOOL_NAME) {
    return { ok: false, images: [], content: `未知工具：${name}` };
  }
  if (!cfg?.enabled) {
    return { ok: false, images: [], content: "表情包功能未启用。" };
  }

  let args;
  try {
    args = typeof rawArgs === "string" ? JSON.parse(rawArgs || "{}") : (rawArgs ?? {});
  } catch (err) {
    return {
      ok: false,
      images: [],
      content: `工具参数不是合法 JSON：${err?.message ?? err}。请重新调用并给出 {"name":"..."}`,
    };
  }

  const want = str(args?.name);
  if (!want) {
    return { ok: false, images: [], content: '参数缺少 name（要发哪个表情包），请补上。' };
  }

  const all = await listStickers(cfg, deps);
  if (all.length === 0) {
    return { ok: false, images: [], content: "表情包库里还没有素材，先用文字回吧。" };
  }

  // 先精确、再包含，最后放弃——名字写错时给出可选列表，让模型自己纠正
  let hit = all.find((s) => s.name === want);
  if (!hit) hit = all.find((s) => s.name.includes(want) || want.includes(s.name));
  if (!hit) {
    const names = [...new Set(all.map((s) => s.name))].join("、");
    return {
      ok: false,
      images: [],
      content: `没有叫「${want}」的表情包。现在有的：${names}。请从中挑一个重新调用。`,
    };
  }

  const readFileImpl = deps.readFile ?? ((p) => fsp.readFile(p));
  let buf;
  try {
    buf = await readFileImpl(hit.path);
  } catch (err) {
    deps.logger?.warn?.(`表情包读取失败（${hit.file}）：${err?.message ?? err}`);
    return { ok: false, images: [], content: `表情包「${hit.name}」读不出来，先用文字回吧。` };
  }
  if (!buf || buf.length === 0) {
    return { ok: false, images: [], content: `表情包「${hit.name}」是个空文件。` };
  }
  if (buf.length > cfg.maxBytes) {
    return {
      ok: false,
      images: [],
      content:
        `表情包「${hit.name}」有 ${(buf.length / 1024 / 1024).toFixed(1)}MB，` +
        `超过 ${(cfg.maxBytes / 1024 / 1024).toFixed(1)}MB 上限，平台会拒收。`,
    };
  }

  deps.logger?.info?.(`发送表情包：${hit.name}（${hit.file}，${(buf.length / 1024).toFixed(0)}KB）`);

  // 尺寸提醒：QQ 按像素决定气泡大小，没缩过的图会显示得很大。
  // 只提醒不拦截——运行时没有图像库，改不了像素，拦下来只会让她发不出表情包。
  const size = readImageSize(buf);
  if (size && Math.max(size.width, size.height) > STICKER_WARN_PX) {
    deps.logger?.warn?.(
      `表情包「${hit.name}」是 ${size.width}×${size.height}，超过 ${STICKER_WARN_PX}px，` +
        `在 QQ 里会显示得偏大；建议缩到 ${STICKER_SUGGESTED_PX}px（tools/resize_stickers.py）`,
    );
  }

  return {
    ok: true,
    images: [
      {
        base64: buf.toString("base64"),
        bytes: buf.length,
        mime: mimeOf(hit.file),
        name: hit.name,
        width: size?.width,
        height: size?.height,
      },
    ],
    content: `已发送表情包「${hit.name}」。不用再复述它画的是什么，自然接话就行。`,
  };
}
