/**
 * XML 小工具：本项目只需要"取文本"，不需要完整 XML 解析器。
 * 保持零依赖，用正则 + 手写实体解码即可满足提取需求。
 */

/** 解码 XML 实体（含数字实体）；顺带处理 &nbsp; 之类的常见命名实体 */
export function decodeXmlEntities(s) {
  return String(s ?? "")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => safeFromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => safeFromCodePoint(parseInt(d, 10)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&"); // 必须最后处理，避免二次解码
}

function safeFromCodePoint(code) {
  try {
    if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return "";
    return String.fromCodePoint(code);
  } catch {
    return "";
  }
}

/** 取出所有匹配 <tag ...>content</tag> 的内容（不处理嵌套同名标签，够用） */
export function collectTagContent(xml, tag) {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "g");
  const out = [];
  for (const m of xml.matchAll(re)) out.push(m[1]);
  return out;
}

/** 去掉所有 XML 标签，只留文字 */
export function stripTags(xml) {
  return decodeXmlEntities(String(xml ?? "").replace(/<[^>]*>/g, ""));
}

/** 压缩连续空白（保留单个换行语义） */
export function tidy(text) {
  return String(text ?? "")
    .replace(/[ \t\u00a0]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
