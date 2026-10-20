/**
 * OOXML 文本提取：.docx / .xlsx / .pptx（以及同结构的 WPS 新版文件）。
 *
 * 零依赖：ZIP 容器自己解（zip.js），XML 自己扫（xml.js）。
 * 不追求 100% 还原排版，目标是"让模型读懂文件里写了什么"。
 */

import { isZip, readEntries } from "./zip.js";
import { decodeXmlEntities, tidy } from "./xml.js";

const DEFAULT_MAX_CHARS = 20000;

/** 统一的返回形状 */
function result(text, meta = {}, warnings = []) {
  return { text, meta, warnings };
}

function fail(why) {
  return { text: "", meta: {}, warnings: [why] };
}

function truncate(text, maxChars, warnings) {
  if (text.length <= maxChars) return text;
  warnings.push(`内容过长，已截断到 ${maxChars} 字（原文 ${text.length} 字）`);
  return `${text.slice(0, maxChars)}\n…（已截断）`;
}

// ---------------------------------------------------------------- Word

/**
 * 提取 .docx 文本。
 * 保留段落与表格结构：表格以 `| a | b |` 形式呈现，便于模型理解行列关系。
 */
export function extractDocx(buf, { maxChars = DEFAULT_MAX_CHARS } = {}) {
  if (!isZip(buf)) return fail("不是有效的 docx（应为 ZIP 容器）");
  const warnings = [];

  let files;
  try {
    files = readEntries(buf, (e) => e.name === "word/document.xml" || /^word\/(header|footer)\d*\.xml$/.test(e.name));
  } catch (err) {
    return fail(`docx 解析失败：${err.message}`);
  }

  const docXml = files.get("word/document.xml")?.toString("utf8");
  if (!docXml) return fail("docx 里没有 word/document.xml（可能不是 Word 文件）");

  const body = extractDocxBody(docXml);

  // 页眉页脚附在后面（信息可能有用）
  const hf = [];
  for (const [name, content] of files) {
    if (!/^word\/(header|footer)/.test(name)) continue;
    const t = tidy(extractDocxText(content.toString("utf8")));
    if (t) hf.push(t);
  }

  let text = body;
  if (hf.length) text += `\n\n[页眉/页脚]\n${hf.join("\n")}`;
  return result(truncate(text, maxChars, warnings), { kind: "docx", paragraphs: body.split("\n\n").length }, warnings);
}

/** 逐段处理，遇到表格单独按行渲染 */
function extractDocxBody(xml) {
  const parts = [];
  // 先按表格切分，表格之外按段落
  const blocks = xml.split(/(<w:tbl>[\s\S]*?<\/w:tbl>)/g);
  for (const block of blocks) {
    if (!block) continue;
    if (block.startsWith("<w:tbl")) {
      const rows = [];
      for (const rowXml of block.split(/<w:tr[\s>]/).slice(1)) {
        const cells = rowXml
          .split(/<w:tc>/)
          .slice(1)
          .map((c) => tidy(extractDocxText(c)).replace(/\n+/g, " "));
        if (cells.some((c) => c)) rows.push(`| ${cells.join(" | ")} |`);
      }
      if (rows.length) parts.push(rows.join("\n"));
    } else {
      const t = tidy(extractDocxText(block));
      if (t) parts.push(t);
    }
  }
  return parts.join("\n\n").trim();
}

/** 从一段 Word XML 里取出可见文字（按段落、制表符、换行处理） */
function extractDocxText(xml) {
  let out = "";
  const re = /<w:(t|tab|br|cr)(?:\s[^>]*)?(?:\/>|>([\s\S]*?)<\/w:\1>)/g;
  for (const m of xml.matchAll(re)) {
    const tag = m[1];
    if (tag === "t") out += decodeXmlEntities(m[2] ?? "");
    else if (tag === "tab") out += "\t";
    else out += "\n";
  }
  // <w:p> 代表段落结束
  out = out.replace(/\n{3,}/g, "\n\n");
  return out;
}

// ---------------------------------------------------------------- Excel

/**
 * 提取 .xlsx 文本。
 * 输出为「工作表名 + 制表符分隔的行」，公式会原样保留（便于模型看计算逻辑）。
 */
export function extractXlsx(buf, { maxChars = DEFAULT_MAX_CHARS } = {}) {
  if (!isZip(buf)) return fail("不是有效的 xlsx（应为 ZIP 容器）");
  const warnings = [];

  let entries;
  try {
    entries = readEntries(
      buf,
      (e) =>
        e.name === "xl/sharedStrings.xml" ||
        /^xl\/worksheets\/sheet\d+\.xml$/.test(e.name) ||
        e.name === "xl/workbook.xml",
    );
  } catch (err) {
    return fail(`xlsx 解析失败：${err.message}`);
  }

  // 共享字符串表：单元格里是索引，真实文本在这里
  const sharedStrings = [];
  const ssXml = entries.get("xl/sharedStrings.xml")?.toString("utf8");
  if (ssXml) {
    for (const si of ssXml.split(/<si[\s>]/).slice(1)) {
      // 一个 si 内可能被拆成多个 <t>，拼接
      const parts = [...si.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((m) => decodeXmlEntities(m[1]));
      sharedStrings.push(parts.join(""));
    }
  }

  // 工作表名（按顺序）与文件名的对应关系
  const sheetNames = [];
  const wbXml = entries.get("xl/workbook.xml")?.toString("utf8");
  if (wbXml) {
    for (const m of wbXml.matchAll(/<sheet\b[^>]*name="([^"]*)"/g)) sheetNames.push(decodeXmlEntities(m[1]));
  }

  const sheetFiles = [...entries.keys()]
    .filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n))
    .sort((a, b) => sheetIndex(a) - sheetIndex(b));

  const out = [];
  sheetFiles.forEach((name, idx) => {
    const xml = entries.get(name).toString("utf8");
    const rows = extractSheetRows(xml, sharedStrings);
    if (!rows.length) return;
    const label = sheetNames[idx] ?? `Sheet${idx + 1}`;
    out.push(`[工作表：${label}]`);
    out.push(rows.join("\n"));
  });

  if (!out.length) return fail("xlsx 里没有找到可读数据");
  return result(truncate(out.join("\n"), maxChars, warnings), { kind: "xlsx", sheets: sheetFiles.length }, warnings);
}

function sheetIndex(name) {
  const m = name.match(/sheet(\d+)\.xml$/);
  return m ? Number(m[1]) : 0;
}

/** 把 sheet XML 转成以制表符分列、换行分行的文本 */
function extractSheetRows(xml, sharedStrings) {
  const rows = [];
  for (const rowXml of xml.split(/<row[\s>]/).slice(1)) {
    const cells = [];
    for (const cellXml of rowXml.split(/<c[\s>]/).slice(1)) {
      const refMatch = cellXml.match(/r="([A-Z]+)\d+"/);
      const typeMatch = cellXml.match(/t="([^"]+)"/);
      const type = typeMatch?.[1];

      let value = "";
      if (type === "s") {
        // 共享字符串
        const v = cellXml.match(/<v>([\s\S]*?)<\/v>/);
        const i = v ? Number(v[1]) : NaN;
        value = Number.isInteger(i) ? (sharedStrings[i] ?? "") : "";
      } else if (type === "inlineStr" || type === "str") {
        const t = cellXml.match(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/);
        value = t ? decodeXmlEntities(t[1]) : "";
      } else {
        // 数字
        const v = cellXml.match(/<v>([\s\S]*?)<\/v>/);
        value = v ? decodeXmlEntities(v[1]).trim() : "";
        // 公式单独标注，便于模型理解计算逻辑
        const f = cellXml.match(/<f(?:\s[^>]*)?>([\s\S]*?)<\/f>/);
        if (f) value = `=${decodeXmlEntities(f[1])}${value ? ` → ${value}` : ""}`;
      }
      if (value === "") continue;
      // 用列号补空位，保持列对齐
      const col = refMatch ? colToIndex(refMatch[1]) : cells.length;
      while (cells.length < col) cells.push("");
      cells[col] = value;
    }
    if (cells.some((c) => c !== "")) rows.push(cells.join("\t"));
  }
  return rows;
}

/** A→0, B→1, ..., AA→26 */
export function colToIndex(letters) {
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

// ---------------------------------------------------------------- PowerPoint

/**
 * 提取 .pptx 文本，按幻灯片顺序输出。
 */
export function extractPptx(buf, { maxChars = DEFAULT_MAX_CHARS } = {}) {
  if (!isZip(buf)) return fail("不是有效的 pptx（应为 ZIP 容器）");
  const warnings = [];

  let entries;
  try {
    entries = readEntries(buf, (e) => /^ppt\/slides\/slide\d+\.xml$/.test(e.name));
  } catch (err) {
    return fail(`pptx 解析失败：${err.message}`);
  }

  const slides = [...entries.keys()].sort((a, b) => slideIndex(a) - slideIndex(b));
  if (!slides.length) return fail("pptx 里没有找到幻灯片");

  const out = [];
  slides.forEach((name, i) => {
    const xml = entries.get(name).toString("utf8");
    const lines = [];
    // <a:p> 是段落，<a:t> 是文字
    for (const p of xml.split(/<a:p>|<a:p\s/).slice(1)) {
      const text = [...p.matchAll(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/g)]
        .map((m) => decodeXmlEntities(m[1]))
        .join("")
        .trim();
      if (text) lines.push(text);
    }
    if (lines.length) out.push(`[第 ${i + 1} 页]\n${lines.join("\n")}`);
  });

  if (!out.length) return fail("pptx 里没有可读文字（可能是纯图片幻灯片）");
  return result(truncate(out.join("\n\n"), maxChars, warnings), { kind: "pptx", slides: slides.length }, warnings);
}

function slideIndex(name) {
  const m = name.match(/slide(\d+)\.xml$/);
  return m ? Number(m[1]) : 0;
}
