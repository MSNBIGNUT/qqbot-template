/**
 * WPS（.wps / .et / .dps）与旧版 Office 二进制（.doc / .xls / .ppt）文本提取器。
 *
 * 设计约束：
 *  - 零依赖：只 `import` Node 内建模块（这里只用 node:zlib + 内建 Buffer/TextDecoder）。
 *  - 绝不抛异常：聊天流程里一个坏文件不能中断对话，任何失败都返回
 *    `{ text: "", warnings: ["原因"] }`。
 *  - 返回形状：`{ text: string, meta?: object, warnings?: string[] }`，
 *    文本一律截断到 `opts.maxChars`（默认 20000）并在 warnings 里说明。
 *
 * WPS 三兄弟有两种可能，两种都尝试：
 *   1. 新版 = ZIP / OOXML 风格：文件头 `PK\x03\x04` → 自己读 EOCD/中央目录/本地头，
 *      method 8 用 `zlib.inflateRawSync`，method 0 直接取。
 *   2. 旧版 = OLE 复合文档：文件头 `D0 CF 11 E0 A1 B1 1A E1` → 自己读
 *      FAT / MiniFAT / 目录项 / 扇区链。
 *   3. 都失败 → “可读文本段启发式扫描”（UTF-16LE 与 GBK 双路打分取优）。
 */

import { inflateRawSync } from "node:zlib";

const DEFAULT_MAX_CHARS = 20000;
const MAX_DECOMPRESSED = 64 * 1024 * 1024; // 单个 ZIP 条目解压上限（防 zip bomb）
const MAX_STREAM_BYTES = 64 * 1024 * 1024; // OLE 单个流读取上限
const MIN_RUN = 4; // 启发式扫描里“可读文本段”的最短长度
const SCORE_THRESHOLD = 8; // 文本像不像人话的最低分
const ENDOFCHAIN = 0xfffffffe;
const FREESECT = 0xffffffff;

/* ------------------------------------------------------------------ *
 * 基础工具
 * ------------------------------------------------------------------ */

/** 把任意输入统一成 Buffer；不是二进制就返回 null（绝不抛）。 */
function asBuffer(input) {
  try {
    if (Buffer.isBuffer(input)) return input;
    if (input instanceof Uint8Array) return Buffer.from(input.buffer, input.byteOffset, input.byteLength);
    if (input instanceof ArrayBuffer) return Buffer.from(input);
    if (ArrayBuffer.isView(input)) return Buffer.from(input.buffer, input.byteOffset, input.byteLength);
    if (typeof input === "string") return Buffer.from(input, "binary");
  } catch {
    /* 落到 null */
  }
  return null;
}

function u16le(b, o) {
  return o >= 0 && o + 2 <= b.length ? b[o] | (b[o + 1] << 8) : 0;
}

function u32le(b, o) {
  return o >= 0 && o + 4 <= b.length
    ? (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0
    : 0;
}

function isZip(b) {
  return (
    b.length >= 4 &&
    b[0] === 0x50 &&
    b[1] === 0x4b &&
    (b[2] === 0x03 || b[2] === 0x05 || b[2] === 0x07) &&
    (b[3] === 0x04 || b[3] === 0x06 || b[3] === 0x08)
  );
}

function isOle(b) {
  return (
    b.length >= 8 &&
    b[0] === 0xd0 &&
    b[1] === 0xcf &&
    b[2] === 0x11 &&
    b[3] === 0xe0 &&
    b[4] === 0xa1 &&
    b[5] === 0xb1 &&
    b[6] === 0x1a &&
    b[7] === 0xe1
  );
}

function utf16leDecode(bytes) {
  try {
    return new TextDecoder("utf-16le", { fatal: false }).decode(bytes);
  } catch {
    return "";
  }
}

/** 按名字取解码器；运行时不支持该编码（例如裁剪版 ICU 没有 gbk）时返回 null。 */
function decodeWith(encoding, bytes) {
  try {
    return new TextDecoder(encoding, { fatal: false }).decode(bytes);
  } catch {
    return null;
  }
}

/**
 * 单字节（8-bit）文本解码：Word 压缩分片 / BIFF 非 Unicode 串 / PPT TextBytesAtom。
 * 中文环境里这些“ANSI”字节通常是 GBK；纯 ASCII 直接读，含高位字节时优先试 GBK。
 */
function decodeAnsiBytes(bytes) {
  if (!bytes || bytes.length === 0) return "";
  let high = 0;
  for (let i = 0; i < bytes.length; i++) if (bytes[i] >= 0x80) high++;
  if (high === 0) return bytes.toString("latin1");
  const gbk = decodeWith("gbk", bytes);
  if (gbk && !gbk.includes("\ufffd") && /[\u3400-\u9fff\uf900-\ufaff]/.test(gbk)) return gbk;
  return bytes.toString("latin1");
}

/** 统一换行、去掉不可见控制符（保留 \t 与 \n）、压缩空行。 */
function normalizeText(s) {
  if (typeof s !== "string" || !s) return "";
  let t = s.replace(/\r\n?/g, "\n").replace(/\u000b/g, "\n");
  t = t.replace(/[\u0000-\u0008\u000e-\u001f\u007f]/g, "");
  t = t.replace(/[ \t]+\n/g, "\n").replace(/[ \t]{3,}/g, "  ");
  t = t.replace(/\n{3,}/g, "\n\n");
  return t.trim();
}

/** Word 正文里的特殊控制符：\r=段落、\x07=单元格、\x13..\x15=域。 */
function cleanWordText(s) {
  let out = "";
  let inField = false;
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if (c === 0x13) {
      inField = true;
      continue;
    }
    if (c === 0x14 || c === 0x15) {
      inField = false;
      continue;
    }
    if (inField) continue;
    if (c === 0x0d || c === 0x0c) out += "\n";
    else if (c === 0x07) out += "\t";
    else if (c === 0x0e) out += "\n";
    else if (c === 0x1e) out += "-";
    else if (c < 0x20 && c !== 0x09 && c !== 0x0a) continue;
    else out += ch;
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * 文本“像不像人话”打分 + 启发式扫描
 * ------------------------------------------------------------------ */

function isTextUnit(c) {
  if (c === 0x09 || c === 0x0a || c === 0x0d) return true;
  if (c >= 0x20 && c <= 0x7e) return true;
  if (c >= 0x3400 && c <= 0x4dbf) return true; // CJK 扩展 A
  if (c >= 0x4e00 && c <= 0x9fff) return true; // CJK 基本区
  if (c >= 0x3000 && c <= 0x303f) return true; // CJK 标点
  if (c >= 0xff00 && c <= 0xffef) return true; // 全角
  if (c >= 0x2010 && c <= 0x203a) return true; // 引号/破折号/省略号
  if (c >= 0x00b0 && c <= 0x00ff) return true; // latin-1 补充
  if (c >= 0xd800 && c <= 0xdfff) return true; // 代理对
  if (c === 0x00a0 || c === 0x2022) return true;
  return false;
}

function scoreText(s) {
  if (!s) return 0;
  let score = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if (c >= 0x4e00 && c <= 0x9fff) score += 3;
    else if (c >= 0x3400 && c <= 0x4dbf) score += 3;
    else if (c >= 0x3000 && c <= 0x303f) score += 1;
    else if (c >= 0xff01 && c <= 0xff5e) score += 1.5;
    else if ((c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a)) score += 1;
    else if (c >= 0x20 && c <= 0x7e) score += 0.2;
    else if (c === 0xfffd) score -= 5;
  }
  return score;
}

/** 在指定奇偶对齐上扫描 UTF-16LE 可读串。 */
function scanUtf16Runs(buf, align) {
  const runs = [];
  let cur = [];
  const push = () => {
    if (cur.length >= MIN_RUN) runs.push(cur.join(""));
    cur = [];
  };
  for (let i = align; i + 1 < buf.length; i += 2) {
    const c = buf[i] | (buf[i + 1] << 8);
    if (c === 0) {
      push();
      continue;
    }
    if (isTextUnit(c)) cur.push(String.fromCharCode(c));
    else push();
  }
  push();
  return runs;
}

/** 把整段字节按 GBK 解释后扫描中英文可读串。 */
function scanAnsiRuns(buf) {
  const dec = decodeWith("gbk", buf) ?? buf.toString("latin1");
  const runs = [];
  let cur = [];
  const push = () => {
    if (cur.length >= MIN_RUN) runs.push(cur.join(""));
    cur = [];
  };
  for (const ch of dec) {
    const c = ch.codePointAt(0);
    if (c !== 0 && isTextUnit(c)) cur.push(ch);
    else push();
  }
  push();
  return runs;
}

/** 返回 { text, score }，不产生 warning（供多流比较用）。 */
function bestHeuristic(buf) {
  if (!buf || buf.length === 0) return { text: "", score: 0 };
  const candidates = [];
  candidates.push(scanUtf16Runs(buf, 0).join("\n"));
  candidates.push(scanUtf16Runs(buf, 1).join("\n"));
  candidates.push(scanAnsiRuns(buf).join("\n"));
  // 纯 UTF-8 文本（例如被改名成 .doc 的 txt）也试一把：能整段解码且无替换字符才认
  const utf8 = decodeWith("utf-8", buf);
  if (utf8 && !utf8.includes("\ufffd") && utf8.length > 0) candidates.push(utf8);
  let text = "";
  let score = 0;
  for (const c of candidates) {
    const s = scoreText(c);
    if (s > score) {
      score = s;
      text = c;
    }
  }
  return { text: score >= SCORE_THRESHOLD ? normalizeText(text) : "", score };
}

function heuristicText(buf, warnings, note) {
  const { text } = bestHeuristic(buf);
  if (text) warnings.push(note);
  return text;
}

/** 在一堆 OLE 流里挑“最像正文”的那个。 */
function pickBestStreamText(streams, warnings, note) {
  let best = "";
  let bestScore = 0;
  for (const [name, data] of streams) {
    if (!data || data.length === 0 || data.length > MAX_STREAM_BYTES) continue;
    if (/^(compobj|summaryinformation|documentsummaryinformation|objinfo|ole)$/i.test(name)) continue;
    const r = bestHeuristic(data);
    if (r.text && r.score > bestScore) {
      bestScore = r.score;
      best = r.text;
    }
  }
  if (best) warnings.push(note);
  return best;
}

/* ------------------------------------------------------------------ *
 * ZIP（OOXML 风格容器）解析
 * ------------------------------------------------------------------ */

function findEocd(buf) {
  const start = Math.max(0, buf.length - 66000);
  for (let i = buf.length - 22; i >= start; i--) {
    if (buf[i] === 0x50 && buf[i + 1] === 0x4b && buf[i + 2] === 0x05 && buf[i + 3] === 0x06) return i;
  }
  return -1;
}

/** 读中央目录，返回 Map<路径, {method, compSize, raw}>。 */
function unzip(buf, warnings) {
  const entries = new Map();
  const eocd = findEocd(buf);
  if (eocd < 0) {
    warnings.push("ZIP: 未找到中央目录（EOCD），文件可能损坏");
    return entries;
  }
  const count = u16le(buf, eocd + 10);
  const cdOff = u32le(buf, eocd + 16);
  if (cdOff === 0xffffffff || count === 0xffff || cdOff >= buf.length) {
    warnings.push("ZIP: ZIP64 或中央目录偏移异常，暂不支持");
    return entries;
  }
  let p = cdOff;
  for (let i = 0; i < count && p + 46 <= buf.length; i++) {
    if (u32le(buf, p) !== 0x02014b50) break;
    const method = u16le(buf, p + 10);
    const compSize = u32le(buf, p + 20);
    const nameLen = u16le(buf, p + 28);
    const extraLen = u16le(buf, p + 30);
    const commentLen = u16le(buf, p + 32);
    const lho = u32le(buf, p + 42);
    const name = buf
      .subarray(p + 46, p + 46 + nameLen)
      .toString("utf8")
      .replace(/\\/g, "/");
    p += 46 + nameLen + extraLen + commentLen;
    if (!name || lho + 30 > buf.length || u32le(buf, lho) !== 0x04034b50) {
      warnings.push(`ZIP: 条目 ${name || "(无名)"} 本地头无效，已跳过`);
      continue;
    }
    const lNameLen = u16le(buf, lho + 26);
    const lExtraLen = u16le(buf, lho + 28);
    const dataStart = lho + 30 + lNameLen + lExtraLen;
    if (dataStart + compSize > buf.length) {
      warnings.push(`ZIP: 条目 ${name} 数据越界，已跳过`);
      continue;
    }
    entries.set(name, { method, compSize, raw: buf.subarray(dataStart, dataStart + compSize) });
  }
  return entries;
}

function unzipRead(entries, name, warnings) {
  const e = entries.get(name);
  if (!e) return null;
  try {
    if (e.method === 0) return Buffer.from(e.raw);
    if (e.method === 8) {
      return Buffer.from(inflateRawSync(e.raw, { maxOutputLength: MAX_DECOMPRESSED }));
    }
    warnings.push(`ZIP: 条目 ${name} 使用不支持的压缩方式 ${e.method}`);
    return null;
  } catch (err) {
    warnings.push(`ZIP: 条目 ${name} 解压失败（${err?.message ?? err}）`);
    return null;
  }
}

function unzipReadText(entries, name, warnings) {
  const b = unzipRead(entries, name, warnings);
  if (!b) return "";
  return b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf ? b.subarray(3).toString("utf8") : b.toString("utf8");
}

function firstMatch(entries, re) {
  for (const name of entries.keys()) if (re.test(name)) return name;
  return null;
}

function allMatches(entries, re) {
  const out = [];
  for (const name of entries.keys()) if (re.test(name)) out.push(name);
  return out;
}

function naturalIndex(name, re) {
  const m = re.exec(name);
  return m ? Number(m[1]) : 0;
}

/* ------------------------------------------------------------------ *
 * XML 小工具（正则提取，不引入 XML 解析器）
 * ------------------------------------------------------------------ */

function decodeEntities(s) {
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, g) => {
    if (g[0] === "#") {
      const code = g[1] === "x" || g[1] === "X" ? parseInt(g.slice(2), 16) : parseInt(g.slice(1), 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return m;
      try {
        return String.fromCodePoint(code);
      } catch {
        return m;
      }
    }
    switch (g) {
      case "amp":
        return "&";
      case "lt":
        return "<";
      case "gt":
        return ">";
      case "quot":
        return '"';
      case "apos":
        return "'";
      case "nbsp":
        return " ";
      default:
        return m;
    }
  });
}

function stripTag(x) {
  return x.replace(/^<[^>]*>/, "").replace(/<[^>]*>$/, "");
}

function innerText(xml, tagRe) {
  const hits = xml.match(tagRe) || [];
  return hits.map((h) => decodeEntities(stripTag(h))).join("");
}

/** docx / WPS 文字：按 w:p 段落取 w:t，w:tab→\t、w:br→\n。 */
function xmlDocText(xml) {
  if (!xml) return "";
  const paras = xml.match(/<w:p\b[^>]*\/>|<w:p\b[\s\S]*?<\/w:p>/g) || [];
  if (paras.length) {
    const lines = [];
    for (const p of paras) {
      const tokens = p.match(/<w:t\b[^>]*>[\s\S]*?<\/w:t>|<w:tab\b[^>]*\/?>|<w:br\b[^>]*\/?>|<w:cr\b[^>]*\/?>/g) || [];
      let line = "";
      for (const t of tokens) {
        if (/^<w:t\b/.test(t)) line += decodeEntities(stripTag(t));
        else if (/^<w:tab\b/.test(t)) line += "\t";
        else line += "\n";
      }
      lines.push(line);
    }
    return normalizeText(lines.join("\n"));
  }
  return normalizeText(innerText(xml, /<w:t\b[^>]*>[\s\S]*?<\/w:t>/g));
}

function colIndex(letters) {
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/** xlsx / WPS 表格：按行取单元格，t="s" 查共享字符串，t="inlineStr" 取内联串。 */
function xmlSheetText(xml, shared) {
  if (!xml) return "";
  const rows = xml.match(/<row\b[\s\S]*?<\/row>|<row\b[^>]*\/>/g) || [];
  if (!rows.length) return normalizeText(innerText(xml, /<t\b[^>]*>[\s\S]*?<\/t>/g));
  const lines = [];
  const cRe = /<c\b([^>]*)\/>|<c\b([^>]*)>([\s\S]*?)<\/c>/g;
  for (const row of rows) {
    const cells = [];
    let m;
    cRe.lastIndex = 0;
    while ((m = cRe.exec(row))) {
      const attrs = m[1] ?? m[2] ?? "";
      const inner = m[3] ?? "";
      const t = /\bt="([^"]*)"/.exec(attrs)?.[1] ?? "n";
      const vM = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(inner);
      const v = vM ? decodeEntities(vM[1]) : "";
      let val = "";
      if (t === "s") val = shared[Number(v)] ?? "";
      else if (t === "inlineStr") val = innerText(inner, /<t\b[^>]*>[\s\S]*?<\/t>/g);
      else if (t === "b") val = v === "1" ? "TRUE" : "FALSE";
      else if (t === "e") val = v;
      else if (t === "str") val = v;
      else val = v;
      if (val === "") {
        const fM = /<f\b[^>]*>([\s\S]*?)<\/f>/.exec(inner);
        if (fM && t !== "inlineStr") val = `=${decodeEntities(fM[1])}`;
      }
      const ref = /\br="([A-Z]+)\d+"/.exec(attrs)?.[1];
      cells.push({ col: ref ? colIndex(ref) : cells.length, val });
    }
    cells.sort((a, b) => a.col - b.col);
    const line = cells
      .map((c) => c.val)
      .filter((s) => s !== "")
      .join("\t");
    if (line.trim() !== "") lines.push(line);
  }
  return normalizeText(lines.join("\n"));
}

/** pptx / WPS 演示：按 a:p 段落取 a:t。 */
function xmlSlideText(xml) {
  if (!xml) return "";
  const paras = xml.match(/<a:p\b[^>]*\/>|<a:p\b[\s\S]*?<\/a:p>/g);
  if (paras && paras.length) {
    const lines = [];
    for (const p of paras) {
      const line = innerText(p, /<a:t\b[^>]*>[\s\S]*?<\/a:t>/g);
      if (line.trim() !== "") lines.push(line);
    }
    return normalizeText(lines.join("\n"));
  }
  return normalizeText(innerText(xml, /<a:t\b[^>]*>[\s\S]*?<\/a:t>/g));
}

function parseSharedStrings(entries, warnings) {
  const name = firstMatch(entries, /^xl\/sharedStrings\.xml$/i);
  if (!name) return [];
  const xml = unzipReadText(entries, name, warnings);
  const out = [];
  const siRe = /<si\b[^>]*>([\s\S]*?)<\/si>|<si\b[^>]*\/>/g;
  let m;
  while ((m = siRe.exec(xml))) out.push(innerText(m[1] ?? "", /<t\b[^>]*>[\s\S]*?<\/t>/g));
  return out;
}

/** 兜底：ZIP 里路径不眼熟时，抓所有像正文的 XML 去标签。 */
function zipGenericText(entries, warnings) {
  const xmlNames = allMatches(entries, /\.xml$/i);
  const preferred = xmlNames.filter((n) => /(document|sheet|slide|sharedstrings|content|text|body|main)/i.test(n));
  const chosen = (preferred.length ? preferred : xmlNames).slice(0, 16);
  const parts = [];
  for (const n of chosen) {
    const xml = unzipReadText(entries, n, warnings);
    if (!xml) continue;
    const txt = decodeEntities(xml.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
    if (txt) parts.push(txt);
  }
  if (parts.length) warnings.push("ZIP: 未匹配到已知 OOXML 路径，已按通用 XML 文本提取");
  return normalizeText(parts.join("\n"));
}

function docxFromZip(buf, warnings) {
  const entries = unzip(buf, warnings);
  if (entries.size === 0) return "";
  const name =
    firstMatch(entries, /^word\/document\d*\.xml$/i) ??
    firstMatch(entries, /^word\/.*\.xml$/i);
  if (name) return xmlDocText(unzipReadText(entries, name, warnings));
  return zipGenericText(entries, warnings);
}

function xlsxFromZip(buf, warnings) {
  const entries = unzip(buf, warnings);
  if (entries.size === 0) return "";
  const shared = parseSharedStrings(entries, warnings);
  const sheets = allMatches(entries, /^xl\/worksheets\/sheet\d+\.xml$/i).sort(
    (a, b) => naturalIndex(a, /sheet(\d+)\.xml$/i) - naturalIndex(b, /sheet(\d+)\.xml$/i),
  );
  if (sheets.length) {
    return normalizeText(
      sheets.map((n) => xmlSheetText(unzipReadText(entries, n, warnings), shared)).filter(Boolean).join("\n"),
    );
  }
  return zipGenericText(entries, warnings);
}

function pptxFromZip(buf, warnings) {
  const entries = unzip(buf, warnings);
  if (entries.size === 0) return "";
  const slides = allMatches(entries, /^ppt\/slides\/slide\d+\.xml$/i).sort(
    (a, b) => naturalIndex(a, /slide(\d+)\.xml$/i) - naturalIndex(b, /slide(\d+)\.xml$/i),
  );
  if (slides.length) {
    return normalizeText(
      slides.map((n) => xmlSlideText(unzipReadText(entries, n, warnings))).filter(Boolean).join("\n"),
    );
  }
  return zipGenericText(entries, warnings);
}

/* ------------------------------------------------------------------ *
 * OLE 复合文档（CFB）解析
 * ------------------------------------------------------------------ */

function sectorOffset(buf, sectorSize, sector) {
  const off = (sector + 1) * sectorSize;
  return off + sectorSize <= buf.length ? off : -1;
}

/**
 * 读 OLE 复合文档，返回 { streams: Map<名字, Buffer>, rootMiniStream }。
 * 解析失败返回 null（调用方退回启发式）。
 */
function readOle(buf, warnings) {
  const sectorSize = 1 << u16le(buf, 0x1e);
  const miniSectorSize = 1 << u16le(buf, 0x20);
  if (sectorSize !== 512 && sectorSize !== 4096) {
    warnings.push(`OLE: 扇区大小异常（${sectorSize}），无法解析`);
    return null;
  }
  if (miniSectorSize < 8 || miniSectorSize > 4096) {
    warnings.push(`OLE: 迷你扇区大小异常（${miniSectorSize}），无法解析`);
    return null;
  }
  const numFat = u32le(buf, 0x2c);
  const firstDir = u32le(buf, 0x30);
  const cutoff = u32le(buf, 0x38) || 4096;
  const firstMiniFat = u32le(buf, 0x3c);
  const numMiniFat = u32le(buf, 0x40);
  const firstDifat = u32le(buf, 0x44);
  const numDifat = u32le(buf, 0x48);
  const perSector = sectorSize / 4;

  // DIFAT → FAT 扇区号列表
  const fatSectors = [];
  for (let i = 0; i < 109 && fatSectors.length < numFat; i++) {
    const s = u32le(buf, 0x4c + i * 4);
    if (s === FREESECT || s === ENDOFCHAIN || s >= 0xfffffffa) break;
    fatSectors.push(s);
  }
  let difat = firstDifat;
  let guard = 0;
  while (
    difat !== ENDOFCHAIN &&
    difat !== FREESECT &&
    difat < 0xfffffffa &&
    guard++ < 4096 &&
    fatSectors.length < numFat
  ) {
    const off = sectorOffset(buf, sectorSize, difat);
    if (off < 0) break;
    for (let i = 0; i < perSector - 1 && fatSectors.length < numFat; i++) {
      const s = u32le(buf, off + i * 4);
      if (s !== FREESECT && s !== ENDOFCHAIN && s < 0xfffffffa) fatSectors.push(s);
    }
    difat = u32le(buf, off + (perSector - 1) * 4);
  }
  if (!fatSectors.length) {
    warnings.push("OLE: FAT 为空，无法解析");
    return null;
  }

  const fat = new Uint32Array(fatSectors.length * perSector);
  for (let i = 0; i < fatSectors.length; i++) {
    const off = sectorOffset(buf, sectorSize, fatSectors[i]);
    if (off < 0) continue;
    for (let j = 0; j < perSector; j++) fat[i * perSector + j] = u32le(buf, off + j * 4);
  }

  const readFatChain = (start, maxBytes) => {
    const chunks = [];
    const seen = new Set();
    let sec = start;
    let total = 0;
    let steps = 0;
    while (sec !== ENDOFCHAIN && sec !== FREESECT && sec < fat.length) {
      if (seen.has(sec) || steps++ > 1 << 20) {
        warnings.push("OLE: 扇区链存在环或过长，已截断");
        break;
      }
      seen.add(sec);
      const off = sectorOffset(buf, sectorSize, sec);
      if (off < 0) break;
      chunks.push(buf.subarray(off, off + sectorSize));
      total += sectorSize;
      if (maxBytes && total >= maxBytes + sectorSize) break;
      sec = fat[sec];
    }
    if (!chunks.length) return Buffer.alloc(0);
    return chunks.length === 1 ? chunks[0] : Buffer.concat(chunks);
  };

  const dirBuf = readFatChain(firstDir, 32 * 1024 * 1024);
  if (!dirBuf.length) {
    warnings.push("OLE: 目录流为空，无法解析");
    return null;
  }

  const dirEntries = [];
  for (let off = 0; off + 128 <= dirBuf.length; off += 128) {
    const nameLen = u16le(dirBuf, off + 64);
    const type = dirBuf[off + 66];
    if (type !== 1 && type !== 2 && type !== 5) continue;
    if (nameLen < 2 || nameLen > 64) continue;
    const name = utf16leDecode(dirBuf.subarray(off, off + nameLen - 2)).replace(/\u0000+$/, "");
    dirEntries.push({
      name,
      type,
      start: u32le(dirBuf, off + 116),
      size: u32le(dirBuf, off + 124) * 4294967296 + u32le(dirBuf, off + 120),
    });
  }
  const root = dirEntries.find((e) => e.type === 5) ?? dirEntries[0];
  const miniStream = root && root.size > 0 ? readFatChain(root.start, Math.min(root.size, MAX_STREAM_BYTES)) : Buffer.alloc(0);

  let miniFat = new Uint32Array(0);
  if (numMiniFat > 0 && firstMiniFat !== ENDOFCHAIN && firstMiniFat !== FREESECT) {
    const raw = readFatChain(firstMiniFat, Math.min(numMiniFat * sectorSize, 16 * 1024 * 1024));
    const n = Math.floor(raw.length / 4);
    miniFat = new Uint32Array(n);
    for (let i = 0; i < n; i++) miniFat[i] = u32le(raw, i * 4);
  }

  const readMiniChain = (start, size) => {
    const chunks = [];
    const seen = new Set();
    let sec = start;
    let total = 0;
    let steps = 0;
    while (sec < miniFat.length && steps++ < 1 << 20) {
      if (seen.has(sec)) {
        warnings.push("OLE: 迷你扇区链存在环，已截断");
        break;
      }
      seen.add(sec);
      const off = sec * miniSectorSize;
      if (off + miniSectorSize > miniStream.length) break;
      chunks.push(miniStream.subarray(off, off + miniSectorSize));
      total += miniSectorSize;
      if (total >= size) break;
      const next = miniFat[sec];
      if (next === ENDOFCHAIN || next === FREESECT) break;
      sec = next;
    }
    if (!chunks.length) return Buffer.alloc(0);
    const joined = chunks.length === 1 ? chunks[0] : Buffer.concat(chunks);
    return joined.subarray(0, size);
  };

  const streams = new Map();
  for (const e of dirEntries) {
    if (e.type !== 2) continue;
    if (!e.name) continue;
    if (e.size === 0) {
      streams.set(e.name, Buffer.alloc(0));
      continue;
    }
    if (e.size > MAX_STREAM_BYTES) {
      warnings.push(`OLE: 流 ${e.name} 过大（${e.size} 字节），已跳过`);
      continue;
    }
    let data;
    try {
      data = e.size < cutoff ? readMiniChain(e.start, e.size) : readFatChain(e.start, e.size).subarray(0, e.size);
    } catch (err) {
      warnings.push(`OLE: 读取流 ${e.name} 失败（${err?.message ?? err}）`);
      continue;
    }
    streams.set(e.name, data);
  }
  return { streams, sectorSize, miniSectorSize, cutoff };
}

/* ------------------------------------------------------------------ *
 * .doc / .wps（旧版）正文解析
 * ------------------------------------------------------------------ */

/**
 * 压缩（8-bit）分片解码。
 * 西方代码页里 1 字符 = 1 字节；但中文 Word 的 GBK 分片是 DBCS：
 * 一个汉字占 2 字节，而分片头里的 cch 数的是**字符数**，
 * 所以必须按前导字节规则逐字符吃字节，否则会串位（读进半个汉字）。
 */
function decodeCompressedPiece(bytes, charCount, dbcs) {
  if (!dbcs) return decodeAnsiBytes(bytes.subarray(0, charCount));
  const parts = [];
  let i = 0;
  let n = 0;
  while (i < bytes.length && n < charCount) {
    const b = bytes[i];
    const wide = b >= 0x81 && b <= 0xfe && i + 1 < bytes.length;
    parts.push(bytes.subarray(i, i + (wide ? 2 : 1)));
    i += wide ? 2 : 1;
    n++;
  }
  return parts.length ? decodeAnsiBytes(Buffer.concat(parts)) : "";
}

/**
 * CLX → PLC PCD 分片表 → 正文。
 * mode.fcShift: fCompressed=1 时 fc 是否要 /2（规范如此，少数实现不除，两种都试）
 * mode.dbcs:    压缩分片是否按 DBCS（GBK）逐字符吃字节
 */
function decodePlcPcd(wordDoc, plc, warnings, mode) {
  if (plc.length < 4) return "";
  const n = (plc.length - 4) / 12;
  if (!Number.isInteger(n) || n <= 0 || n > 100000) {
    warnings.push("DOC: 分片表长度异常");
    return "";
  }
  let out = "";
  for (let i = 0; i < n; i++) {
    const cpFrom = u32le(plc, i * 4);
    const cpTo = u32le(plc, (i + 1) * 4);
    const chars = cpTo - cpFrom;
    if (chars <= 0) continue;
    const pcdOff = (n + 1) * 4 + i * 8;
    const fcRaw = u32le(plc, pcdOff + 2);
    const compressed = (fcRaw & 0x40000000) !== 0;
    const fc = fcRaw & 0x3fffffff;
    if (compressed) {
      const off = mode.fcShift ? fc >>> 1 : fc;
      if (off >= wordDoc.length) {
        warnings.push("DOC: 压缩分片偏移越界，已跳过该分片");
        continue;
      }
      // 按字符数最多 2 字节/字符取够（DBCS）
      const span = wordDoc.subarray(off, Math.min(off + chars * 2, wordDoc.length));
      out += decodeCompressedPiece(span, chars, mode.dbcs);
    } else {
      if (fc >= wordDoc.length) {
        warnings.push("DOC: 分片偏移越界，已跳过该分片");
        continue;
      }
      out += utf16leDecode(wordDoc.subarray(fc, Math.min(fc + chars * 2, wordDoc.length)));
    }
  }
  return cleanWordText(out);
}

/** 四种解释组合全试一遍，取“最像人话”的那份。 */
function decodePlcPcdBest(wordDoc, plc, warnings) {
  const modes = [
    { fcShift: true, dbcs: true },
    { fcShift: true, dbcs: false },
    { fcShift: false, dbcs: true },
    { fcShift: false, dbcs: false },
  ];
  let best = "";
  let bestScore = 0;
  let bestMode = modes[0];
  for (const mode of modes) {
    const t = decodePlcPcd(wordDoc, plc, [], mode);
    const s = scoreText(t);
    if (s > bestScore) {
      bestScore = s;
      best = t;
      bestMode = mode;
    }
  }
  if (bestScore >= SCORE_THRESHOLD) return best;
  // 都不像人话时，把胜出组合的真实告警抛出来，便于定位
  return decodePlcPcd(wordDoc, plc, warnings, bestMode);
}

function readPieceTable(wordDoc, tbl, fcClx, lcbClx, warnings) {
  let pos = fcClx;
  const end = Math.min(fcClx + lcbClx, tbl.length);
  while (pos < end) {
    const tag = tbl[pos];
    if (tag === 0x01) {
      if (pos + 3 > end) break;
      pos += 3 + u16le(tbl, pos + 1); // 跳过 Prc/grpprl
    } else if (tag === 0x02) {
      if (pos + 5 > end) break;
      const lcb = u32le(tbl, pos + 1);
      const start = pos + 5;
      if (start + lcb > tbl.length || lcb < 4) {
        warnings.push("DOC: 分片表越界或长度不足");
        return "";
      }
      return decodePlcPcdBest(wordDoc, tbl.subarray(start, start + lcb), warnings);
    } else {
      break;
    }
  }
  return "";
}

function wordBinaryText(wordDoc, streams, warnings) {
  const wIdent = u16le(wordDoc, 0);
  const nFib = u16le(wordDoc, 2);
  const flags = u16le(wordDoc, 0x0a);
  const fComplex = (flags & 0x0004) !== 0;
  const tblName = flags & 0x0200 ? "1Table" : "0Table";
  const fcMin = u32le(wordDoc, 0x18);
  const fcMac = u32le(wordDoc, 0x1c);
  if (wIdent !== 0xa5ec && wIdent !== 0xa5dc) {
    warnings.push(`DOC: FIB 标识 0x${wIdent.toString(16)} 非预期（继续尝试解析）`);
  }

  // 1) Word 97+ 分片表（fcClx 固定落在 0x01A2）
  if (nFib >= 193 && wordDoc.length >= 0x1aa) {
    const fcClx = u32le(wordDoc, 0x1a2);
    const lcbClx = u32le(wordDoc, 0x1a6);
    const tbl = streams.get(tblName) ?? streams.get(tblName === "1Table" ? "0Table" : "1Table");
    if (tbl && lcbClx > 0 && fcClx + lcbClx <= tbl.length) {
      const text = readPieceTable(wordDoc, tbl, fcClx, lcbClx, warnings);
      if (text.trim()) return text;
    } else if (lcbClx > 0) {
      warnings.push(`DOC: 找不到分片表流 ${tblName}`);
    }
  }

  // 2) Word 6/95 或非复杂文档：正文直接躺在 fcMin..fcMac
  if (fcMac > fcMin + 8 && fcMac <= wordDoc.length && fcMin >= 0) {
    const direct = cleanWordText(decodeAnsiBytes(wordDoc.subarray(fcMin, fcMac)));
    if (scoreText(direct) >= SCORE_THRESHOLD) return direct;
    const direct16 = cleanWordText(utf16leDecode(wordDoc.subarray(fcMin, fcMac)));
    if (scoreText(direct16) >= SCORE_THRESHOLD) return direct16;
  }
  if (fComplex) warnings.push("DOC: 复杂文档但分片表不可用，退回启发式扫描");

  return "";
}

/* ------------------------------------------------------------------ *
 * .xls / .et（旧版）BIFF 解析
 * ------------------------------------------------------------------ */

function collectBiffRecords(buf, warnings) {
  const records = [];
  let pos = 0;
  while (pos + 4 <= buf.length) {
    const type = u16le(buf, pos);
    const len = u16le(buf, pos + 2);
    if (type === 0 && len === 0) {
      pos += 4; // 填充
      continue;
    }
    if (pos + 4 + len > buf.length) {
      if (records.length === 0) warnings.push("XLS: BIFF 记录长度越界，文件可能损坏");
      break;
    }
    records.push({ type, data: buf.subarray(pos + 4, pos + 4 + len) });
    pos += 4 + len;
  }
  return records;
}

const MAX_SST_STRINGS = 200000;

function parseSstBody(buf, warnings) {
  const unique = u32le(buf, 4);
  const strings = [];
  let p = 8;
  const limit = Math.min(unique, MAX_SST_STRINGS);
  for (let i = 0; i < limit; i++) {
    if (p + 3 > buf.length) {
      warnings.push("XLS: 共享字符串表被截断");
      break;
    }
    const cch = u16le(buf, p);
    const grbit = buf[p + 2];
    p += 3;
    const high = (grbit & 0x01) !== 0;
    const ext = (grbit & 0x04) !== 0;
    const rich = (grbit & 0x08) !== 0;
    let cRun = 0;
    let cbExt = 0;
    if (rich) {
      cRun = u16le(buf, p);
      p += 2;
    }
    if (ext) {
      cbExt = u32le(buf, p);
      p += 4;
    }
    if (p + cch > buf.length) {
      warnings.push("XLS: 共享字符串表越界，已停止");
      break;
    }
    if (high) {
      strings.push(utf16leDecode(buf.subarray(p, p + cch * 2)));
      p += cch * 2;
    } else {
      strings.push(decodeAnsiBytes(buf.subarray(p, p + cch)));
      p += cch;
    }
    p += cRun * 4 + cbExt;
    if (p > buf.length) break;
  }
  return strings;
}

/** 返回 { cells:[{row,col,text}], sst:[], sheetNames:[] } */
function parseBiff(workbook, warnings) {
  const records = collectBiffRecords(workbook, warnings);
  const cells = [];
  const sheetNames = [];
  let sst = [];
  let sstRaw = null;
  const continuations = [];

  for (let i = 0; i < records.length; i++) {
    const { type, data } = records[i];
    if (type === 0x00fc) {
      sstRaw = data;
      continuations.length = 0;
      for (let j = i + 1; j < records.length && records[j].type === 0x003c; j++) continuations.push(records[j].data);
    } else if (type === 0x0085 && data.length >= 8) {
      const cch = data[6];
      const grbit = data[7];
      const body = data.subarray(8, 8 + ((grbit & 0x01) !== 0 ? cch * 2 : cch));
      sheetNames.push((grbit & 0x01) !== 0 ? utf16leDecode(body) : decodeAnsiBytes(body));
    } else if (type === 0x00fd && data.length >= 10) {
      cells.push({ row: u16le(data, 0), col: u16le(data, 2), isst: u32le(data, 6), text: null });
    } else if (type === 0x0204) {
      const lab = parseLabelRecord(data);
      if (lab) cells.push(lab);
    } else if (type === 0x0203 && data.length >= 14) {
      const val = readDouble(data, 6);
      if (Number.isFinite(val)) {
        cells.push({ row: u16le(data, 0), col: u16le(data, 2), text: formatNumber(val) });
      }
    } else if (type === 0x027e && data.length >= 10) {
      const val = decodeRk(u32le(data, 6));
      if (Number.isFinite(val)) {
        cells.push({ row: u16le(data, 0), col: u16le(data, 2), text: formatNumber(val) });
      }
    } else if (type === 0x00bd && data.length >= 12) {
      const row = u16le(data, 0);
      const firstCol = u16le(data, 2);
      const count = (data.length - 6) / 6;
      for (let k = 0; k < count; k++) {
        const rk = u32le(data, 4 + k * 6 + 2);
        const val = decodeRk(rk);
        if (Number.isFinite(val)) cells.push({ row, col: firstCol + k, text: formatNumber(val) });
      }
    }
  }

  if (sstRaw) {
    sst = parseSstBody(sstRaw, warnings);
    if (sst.length === 0 && continuations.length) {
      // 退化：把 CONTINUE 直接拼上去再试一次
      const merged = Buffer.concat([sstRaw, ...continuations]);
      sst = parseSstBody(merged, warnings);
    } else if (continuations.length) {
      warnings.push("XLS: 共享字符串表跨 CONTINUE 记录，长表可能有缺字");
    }
  }

  const out = [];
  for (const c of cells) {
    let text = c.text;
    if (text === null || text === undefined) text = sst[c.isst] ?? "";
    if (text === "") continue;
    out.push({ row: c.row, col: c.col, text });
  }
  out.sort((a, b) => a.row - b.row || a.col - b.col);
  return { cells: out, sst, sheetNames };
}

function parseLabelRecord(data) {
  if (data.length < 9) return null;
  const row = u16le(data, 0);
  const col = u16le(data, 2);
  const cch = data[6];
  const grbit = data[7];
  const high = (grbit & 0x01) !== 0;
  const need = high ? cch * 2 : cch;
  if (8 + need > data.length) return null;
  const body = data.subarray(8, 8 + need);
  return { row, col, text: high ? utf16leDecode(body) : decodeAnsiBytes(body) };
}

function readDouble(b, o) {
  try {
    return b.readDoubleLE(o);
  } catch {
    return NaN;
  }
}

function decodeRk(rk) {
  const isInt = (rk & 0x02) !== 0;
  const div100 = (rk & 0x01) !== 0;
  let v;
  if (isInt) {
    v = rk >> 2; // 有符号 30 位
  } else {
    const buf = Buffer.alloc(8);
    buf.writeUInt32LE((rk & 0xfffffffc) >>> 0, 4);
    v = buf.readDoubleLE(0);
  }
  return div100 ? v / 100 : v;
}

function formatNumber(v) {
  if (!Number.isFinite(v)) return "";
  if (Number.isInteger(v) && Math.abs(v) < 1e15) return String(v);
  return String(Number(v.toFixed(10)));
}

const XLS_MAX_CELLS = 200000;

function xlsBinaryText(workbook, warnings) {
  let parsed = null;
  try {
    parsed = parseBiff(workbook, warnings);
  } catch (err) {
    warnings.push(`XLS: BIFF 解析异常（${err?.message ?? err}）`);
  }
  if (parsed && parsed.cells.length) {
    const capped = parsed.cells.slice(0, XLS_MAX_CELLS);
    if (parsed.cells.length > capped.length) warnings.push(`XLS: 单元格过多，仅取前 ${capped.length} 个`);
    const lines = [];
    let row = -1;
    let cols = [];
    for (const c of capped) {
      if (c.row !== row) {
        if (cols.length) lines.push(cols.join("\t"));
        row = c.row;
        cols = [];
      }
      cols.push(c.text);
    }
    if (cols.length) lines.push(cols.join("\t"));
    return normalizeText(lines.join("\n"));
  }
  if (parsed && parsed.sst.length) {
    warnings.push("XLS: 未定位到单元格，回退为共享字符串表内容");
    return normalizeText(parsed.sst.join("\n"));
  }
  return "";
}

/* ------------------------------------------------------------------ *
 * .ppt / .dps（旧版）记录流解析
 * ------------------------------------------------------------------ */

const PPT_TEXT_CHARS = 4000;
const PPT_TEXT_BYTES = 4008;
const MAX_PPT_RECORDS = 500000;

/**
 * 容器类型 → 文本归属。母版/大纲里的文字是占位符或幻灯片正文的重复，不作为正文。
 * 注意：幻灯片正文藏在 PPDrawing(1036) 内的 Escher 容器（61442→61443→61444→…）里，
 * 这些容器用同一套 8 字节记录头，所以除 1016/4080 外一律继续下钻。
 */
const PPT_BUCKETS = new Map([
  [1006, "slides"], // Slide
  [1008, "notes"], // Notes
  [1016, "skip"], // MainMaster（“单击此处编辑母版标题样式”之类）
  [4080, "skip"], // SlideListWithText（大纲，和幻灯片正文重复）
]);

/** 母版占位符提示语，整段丢弃：空占位符的形状会把母版提示语抄一份进幻灯片。 */
const PPT_PLACEHOLDER_RE = /^(单击此处编辑母版|Click to edit Master)/;

function pptAtomPayload(type, data) {
  if (type === PPT_TEXT_CHARS) return utf16leDecode(data);
  if (type === PPT_TEXT_BYTES) return decodeAnsiBytes(data);
  // 4026 CString 是形状名/属性（MH_LIBRARY、___PPT9 之类），不是正文
  return "";
}

/** 递归走记录树：recVer=0xF 是容器，其余是原子。文本按所属容器分桶。 */
function walkPptRecords(buf, start, end, buckets, warnings, state) {
  let p = start;
  while (p + 8 <= end) {
    if (state.count++ > MAX_PPT_RECORDS) {
      warnings.push("PPT: 记录数超限，已停止解析");
      return;
    }
    const info = u16le(buf, p);
    const ver = info & 0x000f;
    const type = u16le(buf, p + 2);
    const len = u32le(buf, p + 4);
    if (type === 0 && len === 0) break; // 记录流结束
    if (p + 8 + len > end) break;
    if (ver === 0x0f) {
      if (state.depth < 32) {
        const bucket = PPT_BUCKETS.get(type) ?? state.bucket;
        const prev = state.bucket;
        state.bucket = bucket;
        state.depth++;
        walkPptRecords(buf, p + 8, p + 8 + len, buckets, warnings, state);
        state.depth--;
        state.bucket = prev;
      }
    } else if (state.bucket !== "skip") {
      const text = pptAtomPayload(type, buf.subarray(p + 8, p + 8 + len));
      if (text && !PPT_PLACEHOLDER_RE.test(text)) (buckets[state.bucket] ?? buckets.other).push(text);
    }
    p += 8 + len;
  }
}

/** 兜底：直接线性扫 TextCharsAtom / TextBytesAtom。 */
function pptAtomScan(buf, out) {
  let p = 0;
  while (p + 8 <= buf.length) {
    const info = u16le(buf, p);
    const ver = info & 0x000f;
    const type = u16le(buf, p + 2);
    const len = u32le(buf, p + 4);
    const okVer = ver === 0 || ver === 1 || ver === 2;
    if (okVer && len > 0 && p + 8 + len <= buf.length) {
      if (type === PPT_TEXT_CHARS && len % 2 === 0) {
        out.push(utf16leDecode(buf.subarray(p + 8, p + 8 + len)));
        p += 8 + len;
        continue;
      }
      if (type === PPT_TEXT_BYTES && len < 1 << 20) {
        out.push(decodeAnsiBytes(buf.subarray(p + 8, p + 8 + len)));
        p += 8 + len;
        continue;
      }
    }
    p += 2;
  }
}

function pptBinaryText(ppt, warnings) {
  const bounded = ppt.length > 32 * 1024 * 1024 ? ppt.subarray(0, 32 * 1024 * 1024) : ppt;
  if (bounded.length !== ppt.length) warnings.push("PPT: 演示流过大，仅解析前 32MB");
  const buckets = { slides: [], notes: [], other: [] };
  walkPptRecords(bounded, 0, bounded.length, buckets, warnings, { depth: 0, count: 0, bucket: "other" });
  const ordered = [...buckets.slides, ...buckets.notes, ...buckets.other];
  let text = normalizeText(ordered.join("\n"));
  if (scoreText(text) < SCORE_THRESHOLD) {
    const out2 = [];
    pptAtomScan(bounded, out2);
    const alt = normalizeText(out2.join("\n"));
    if (scoreText(alt) > scoreText(text)) {
      text = alt;
      warnings.push("PPT: 记录树解析结果可疑，改用原子线性扫描");
    }
  }
  return text;
}

/* ------------------------------------------------------------------ *
 * 公共返回形状
 * ------------------------------------------------------------------ */

function maxCharsOf(opts) {
  const v = opts && typeof opts === "object" ? opts.maxChars : undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_MAX_CHARS;
  return Math.floor(n);
}

function safeSlice(text, limit) {
  let s = text.slice(0, limit);
  const last = s.charCodeAt(s.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) s = s.slice(0, -1); // 别把代理对切成半个
  return s;
}

function makeResult(raw, opts, warnings, baseMeta) {
  const rawText = typeof raw === "string" ? raw : (raw?.text ?? "");
  const maxChars = maxCharsOf(opts);
  const before = typeof rawText === "string" ? rawText : "";
  let text = normalizeText(before);
  const warns = Array.isArray(warnings) ? warnings.slice() : [];
  if (text.length > maxChars) {
    text = safeSlice(text, maxChars);
    warns.push(`文本超过 ${maxChars} 字符上限，已截断（原始约 ${before.length} 字符）`);
  }
  if (!text && warns.length === 0) warns.push("未提取到可读文本");
  const extra = raw && typeof raw === "object" ? raw.meta : null;
  const meta = { ...(baseMeta ?? {}), ...(extra ?? {}) };
  const res = { text, warnings: warns };
  if (Object.keys(meta).length) res.meta = meta;
  return res;
}

/** 统一入口：保证不抛异常、保证形状一致。 */
function runSafe(input, opts, fn, kind) {
  const warnings = [];
  const buf = asBuffer(input);
  if (!buf || buf.length === 0) return { text: "", warnings: ["输入为空或不是有效的二进制数据"] };
  const baseMeta = {
    kind: kind ?? "legacy",
    container: isZip(buf) ? "zip" : isOle(buf) ? "ole" : "raw",
    bytes: buf.length,
  };
  try {
    const raw = fn(buf, opts ?? {}, warnings);
    return makeResult(raw, opts, warnings, baseMeta);
  } catch (err) {
    try {
      opts?.logger?.warn?.(`wps 提取失败：${err?.message ?? err}`);
    } catch {
      /* 日志本身不能再抛 */
    }
    warnings.push(`解析异常：${err?.message ?? String(err)}`);
    return { text: "", warnings };
  }
}

/* ------------------------------------------------------------------ *
 * 六个导出提取器
 * ------------------------------------------------------------------ */

/** .doc 旧版 Word 二进制（也容忍实为 OOXML 包的情况）。 */
export function extractDoc(buf, opts) {
  return runSafe(buf, opts, (b, _o, w) => {
    if (isZip(b)) return docxFromZip(b, w);
    if (!isOle(b)) return heuristicText(b, w, "DOC: 非 OLE 复合文档头，已按启发式扫描");
    const ole = readOle(b, w);
    if (!ole) return heuristicText(b, w, "DOC: OLE 结构解析失败，已按启发式扫描整个文件");
    const wd = ole.streams.get("WordDocument");
    if (wd && wd.length) {
      const t = wordBinaryText(wd, ole.streams, w);
      if (t.trim()) return t;
      const h = heuristicText(wd, w, "DOC: 正文解析失败，已按启发式扫描 WordDocument 流");
      if (h) return h;
    } else {
      w.push("DOC: OLE 内缺少 WordDocument 流");
    }
    return pickBestStreamText(ole.streams, w, "DOC: 已改为扫描 OLE 内文本最多的流");
  }, "doc");
}

/** .xls 旧版 Excel 二进制（BIFF5/8）。 */
export function extractXls(buf, opts) {
  return runSafe(buf, opts, (b, _o, w) => {
    if (isZip(b)) return xlsxFromZip(b, w);
    if (!isOle(b)) return heuristicText(b, w, "XLS: 非 OLE 复合文档头，已按启发式扫描");
    const ole = readOle(b, w);
    if (!ole) return heuristicText(b, w, "XLS: OLE 结构解析失败，已按启发式扫描整个文件");
    const wb = ole.streams.get("Workbook") ?? ole.streams.get("Book");
    if (wb && wb.length) {
      const t = xlsBinaryText(wb, w);
      if (t.trim()) return t;
      const h = heuristicText(wb, w, "XLS: BIFF 解析失败，已按启发式扫描 Workbook 流");
      if (h) return h;
    } else {
      w.push("XLS: OLE 内缺少 Workbook/Book 流");
    }
    return pickBestStreamText(ole.streams, w, "XLS: 已改为扫描 OLE 内文本最多的流");
  }, "xls");
}

/** .ppt 旧版 PowerPoint 二进制。 */
export function extractPpt(buf, opts) {
  return runSafe(buf, opts, (b, _o, w) => {
    if (isZip(b)) return pptxFromZip(b, w);
    if (!isOle(b)) return heuristicText(b, w, "PPT: 非 OLE 复合文档头，已按启发式扫描");
    const ole = readOle(b, w);
    if (!ole) return heuristicText(b, w, "PPT: OLE 结构解析失败，已按启发式扫描整个文件");
    const ppt = ole.streams.get("PowerPoint Document") ?? ole.streams.get("Pictures");
    if (ppt && ppt.length) {
      const t = pptBinaryText(ppt, w);
      if (t.trim()) return t;
      const h = heuristicText(ppt, w, "PPT: 记录解析失败，已按启发式扫描演示流");
      if (h) return h;
    } else {
      w.push("PPT: OLE 内缺少 PowerPoint Document 流");
    }
    return pickBestStreamText(ole.streams, w, "PPT: 已改为扫描 OLE 内文本最多的流");
  }, "ppt");
}

/** .wps WPS 文字：ZIP(OOXML 风格) 或 OLE(兼容 doc 二进制)。 */
export function extractWps(buf, opts) {
  return runSafe(buf, opts, (b, _o, w) => {
    if (isZip(b)) {
      const t = docxFromZip(b, w);
      if (t.trim()) return t;
      w.push("WPS: ZIP 包内未提取到正文文本（已尝试 word/document*.xml 与通用 XML 提取）");
      return t;
    }
    if (!isOle(b)) return heuristicText(b, w, "WPS: 未知文件头，已按启发式扫描");
    const ole = readOle(b, w);
    if (!ole) return heuristicText(b, w, "WPS: OLE 结构解析失败，已按启发式扫描整个文件");
    const wd = ole.streams.get("WordDocument");
    if (wd && wd.length) {
      const t = wordBinaryText(wd, ole.streams, w);
      if (t.trim()) return t;
    }
    for (const name of ["WpsDocument", "Text", "Contents", "Data", "BodyText"]) {
      const s = ole.streams.get(name);
      if (s && s.length) {
        const r = bestHeuristic(s);
        if (r.text) {
          w.push(`WPS: 已从 OLE 流 ${name} 按启发式提取文本`);
          return r.text;
        }
      }
    }
    return pickBestStreamText(ole.streams, w, "WPS: 已改为扫描 OLE 内文本最多的流") ||
      heuristicText(b, w, "WPS: 未能解析，已按启发式扫描整个文件");
  }, "wps");
}

/** .et WPS 表格：ZIP(OOXML 风格) 或 OLE(兼容 xls 二进制)。 */
export function extractEt(buf, opts) {
  return runSafe(buf, opts, (b, _o, w) => {
    if (isZip(b)) {
      const t = xlsxFromZip(b, w);
      if (t.trim()) return t;
      w.push("ET: ZIP 包内未提取到单元格文本（已尝试 xl/worksheets/sheet*.xml 与通用 XML 提取）");
      return t;
    }
    if (!isOle(b)) return heuristicText(b, w, "ET: 未知文件头，已按启发式扫描");
    const ole = readOle(b, w);
    if (!ole) return heuristicText(b, w, "ET: OLE 结构解析失败，已按启发式扫描整个文件");
    const wb = ole.streams.get("Workbook") ?? ole.streams.get("Book");
    if (wb && wb.length) {
      const t = xlsBinaryText(wb, w);
      if (t.trim()) return t;
    }
    for (const name of ["EtObjectPool", "Workbook", "Book", "Text", "Data"]) {
      const s = ole.streams.get(name);
      if (s && s.length) {
        const r = bestHeuristic(s);
        if (r.text) {
          w.push(`ET: 已从 OLE 流 ${name} 按启发式提取文本`);
          return r.text;
        }
      }
    }
    return pickBestStreamText(ole.streams, w, "ET: 已改为扫描 OLE 内文本最多的流") ||
      heuristicText(b, w, "ET: 未能解析，已按启发式扫描整个文件");
  }, "et");
}

/** .dps WPS 演示：ZIP(OOXML 风格) 或 OLE(兼容 ppt 二进制)。 */
export function extractDps(buf, opts) {
  return runSafe(buf, opts, (b, _o, w) => {
    if (isZip(b)) {
      const t = pptxFromZip(b, w);
      if (t.trim()) return t;
      w.push("DPS: ZIP 包内未提取到幻灯片文本（已尝试 ppt/slides/slide*.xml 与通用 XML 提取）");
      return t;
    }
    if (!isOle(b)) return heuristicText(b, w, "DPS: 未知文件头，已按启发式扫描");
    const ole = readOle(b, w);
    if (!ole) return heuristicText(b, w, "DPS: OLE 结构解析失败，已按启发式扫描整个文件");
    const ppt = ole.streams.get("PowerPoint Document") ?? ole.streams.get("Pictures");
    if (ppt && ppt.length) {
      const t = pptBinaryText(ppt, w);
      if (t.trim()) return t;
    }
    for (const name of ["DpsDocument", "Text", "Data"]) {
      const s = ole.streams.get(name);
      if (s && s.length) {
        const r = bestHeuristic(s);
        if (r.text) {
          w.push(`DPS: 已从 OLE 流 ${name} 按启发式提取文本`);
          return r.text;
        }
      }
    }
    return pickBestStreamText(ole.streams, w, "DPS: 已改为扫描 OLE 内文本最多的流") ||
      heuristicText(b, w, "DPS: 未能解析，已按启发式扫描整个文件");
  }, "dps");
}

export default { extractDoc, extractXls, extractPpt, extractWps, extractEt, extractDps };
