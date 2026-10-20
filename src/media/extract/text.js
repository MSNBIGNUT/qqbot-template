/**
 * 纯文本与代码文件的提取。
 *
 * 难点不是读取，而是**编码判断**：中文环境下的 .txt/.csv 可能是 GBK，
 * 直接按 UTF-8 读会得到一堆乱码，模型就完全读不懂了。
 *
 * 策略：优先 UTF-8（严格模式，遇非法序列会失败）→ 失败则回退 GBK 近似解码。
 */

const DEFAULT_MAX_CHARS = 20000;

/** 扩展名 → 语言/类型标签，仅用于给模型一个上下文提示 */
const CODE_EXT = new Set([
  "js", "mjs", "cjs", "ts", "tsx", "jsx", "py", "rb", "go", "rs", "java", "kt",
  "c", "h", "cpp", "hpp", "cc", "cs", "swift", "php", "lua", "pl", "r", "jl",
  "sh", "bash", "zsh", "ps1", "bat", "cmd", "sql", "m", "scala", "dart", "vue", "svelte",
]);
const DATA_EXT = new Set(["json", "jsonl", "xml", "yaml", "yml", "toml", "ini", "cfg", "conf", "env", "properties"]);
const DOC_EXT = new Set(["txt", "md", "markdown", "log", "csv", "tsv", "rst", "tex", "srt", "vtt"]);

export function isTextLike(ext) {
  const e = String(ext ?? "").toLowerCase().replace(/^\./, "");
  return CODE_EXT.has(e) || DATA_EXT.has(e) || DOC_EXT.has(e);
}

/** 用 BOM 判断编码 */
function bomInfo(buf) {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return { encoding: "utf8-bom", offset: 3 };
  }
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return { encoding: "utf16le", offset: 2 };
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) return { encoding: "utf16be", offset: 2 };
  return { encoding: null, offset: 0 };
}

/** 在严格模式下试 UTF-8；非法序列会抛错 */
function tryUtf8(buf) {
  const dec = new TextDecoder("utf-8", { fatal: true });
  return dec.decode(buf);
}

/** 用 TextDecoder("gbk") 解 GBK；Node 的 ICU 通常支持 */
function tryGbk(buf) {
  return new TextDecoder("gbk", { fatal: false }).decode(buf);
}

/** 判断解码结果是否"看起来像乱码" */
export function looksGarbled(text) {
  if (!text) return false;
  const bad = (text.match(/\uFFFD/g) ?? []).length; // 替换字符
  if (bad / text.length > 0.02) return true;
  // 大量私用区/控制字符也是坏信号
  const weird = (text.match(/[\uE000-\uF8FF\u0000-\u0008\u000B\u000C\u000E-\u001F]/g) ?? []).length;
  return weird / text.length > 0.05;
}

/** UTF-16BE 需要手工转（TextDecoder 有 utf-16be，但保险起见用交换字节的写法） */
function decodeUtf16be(buf) {
  const swapped = Buffer.from(buf);
  swapped.swap16();
  return swapped.toString("utf16le");
}

/**
 * 提取文本/代码文件。
 * @param {Buffer} buf
 * @param {object} [opts]
 * @param {string} [opts.ext] 扩展名（用于语言标签）
 * @param {number} [opts.maxChars]
 * @returns {{text:string, meta:object, warnings:string[]}}
 */
export function extractTextFile(buf, { ext = "", maxChars = DEFAULT_MAX_CHARS } = {}) {
  const warnings = [];
  const e = String(ext ?? "").toLowerCase().replace(/^\./, "");
  if (buf.length === 0) return { text: "", meta: {}, warnings: ["文件是空的"] };

  const bom = bomInfo(buf);
  let text;
  let encoding = bom.encoding;

  if (bom.encoding === "utf16le") {
    text = buf.subarray(bom.offset).toString("utf16le");
  } else if (bom.encoding === "utf16be") {
    text = decodeUtf16be(buf.subarray(bom.offset));
  } else {
    const body = buf.subarray(bom.offset);
    try {
      text = tryUtf8(body);
      encoding = "utf8";
    } catch {
      // UTF-8 失败：很可能是 GBK（中文记事本、老 Excel 导出的 CSV）
      text = tryGbk(body);
      encoding = "gbk";
      warnings.push("文件不是合法 UTF-8，已按 GBK 解码");
    }
    if (looksGarbled(text)) {
      const alt = tryGbk(body);
      if (!looksGarbled(alt)) {
        text = alt;
        encoding = "gbk";
        warnings.push("按 UTF-8 解出乱码，已改用 GBK");
      } else {
        warnings.push("编码识别可能有误，若内容不可读请另存为 UTF-8 后重发");
      }
    }
  }

  // 统一换行
  text = text.replace(/\r\n?/g, "\n");

  const kind = CODE_EXT.has(e) ? "code" : DATA_EXT.has(e) ? "data" : "text";
  const meta = { kind, ext: e, encoding, bytes: buf.length, lines: text.split("\n").length };

  let out = text;
  if (out.length > maxChars) {
    warnings.push(`内容过长，已截断到 ${maxChars} 字（原文 ${out.length} 字）`);
    out = `${out.slice(0, maxChars)}\n…（已截断）`;
  }
  return { text: out, meta, warnings };
}

/**
 * CSV/TSV 转成更利于模型理解的表格文本。
 * 不是完整 CSV 解析（不处理引号内换行这类边界），够用即可。
 */
export function extractCsv(buf, { ext = "csv", maxChars = DEFAULT_MAX_CHARS, logger } = {}) {
  const base = extractTextFile(buf, { ext, maxChars, ...(logger ? { logger } : {}) });
  if (!base.text) return base;

  const delim = String(ext).toLowerCase() === "tsv" ? "\t" : ",";
  const lines = base.text.split("\n").filter((l) => l.trim() !== "");
  if (lines.length <= 1) return base;

  const header = splitCsvLine(lines[0], delim);
  const preview = lines.slice(0, 500);
  const formatted = preview.map((line, i) => {
    if (i === 0) return `表头: ${header.join(" | ")}`;
    const cells = splitCsvLine(line, delim);
    return cells.join(" | ");
  });

  const meta = { ...base.meta, kind: "table", rows: lines.length - 1, columns: header.length };
  const text = `[表格：${meta.rows} 行 × ${meta.columns} 列]\n${formatted.join("\n")}`;
  return { text, meta, warnings: base.warnings };
}

function splitCsvLine(line, delim) {
  const out = [];
  let cur = "";
  let inQuote = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuote && line[i + 1] === '"') {
        cur += '"';
        i += 1;
      } else {
        inQuote = !inQuote;
      }
    } else if (ch === delim && !inQuote) {
      out.push(cur.trim());
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur.trim());
  return out;
}
