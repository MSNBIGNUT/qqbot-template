/**
 * 零依赖 ZIP 读取（够用即可）。
 *
 * 为什么自己写：.docx/.xlsx/.pptx 以及新版 WPS 文件本质是 ZIP + XML。
 * Node 只有 zlib，没有 ZIP 容器解析，而本项目坚持零依赖，
 * 所以这里实现「读中央目录 → 定位本地头 → 解压条目」这条最小路径。
 *
 * 不实现（用不到，也不打算支持）：写 ZIP、加密 ZIP、ZIP64、分卷。
 */

import zlib from "node:zlib";

const SIG_EOCD = 0x06054b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;

/** 判断 Buffer 是不是 ZIP（PK\x03\x04） */
export function isZip(buf) {
  return Buffer.isBuffer(buf) && buf.length > 4 && buf.readUInt32LE(0) === SIG_LOCAL;
}

/** 从尾部倒着找中央目录结束标记 */
function findEocd(buf) {
  const minPos = Math.max(0, buf.length - 66000);
  for (let i = buf.length - 22; i >= minPos; i -= 1) {
    if (buf.readUInt32LE(i) === SIG_EOCD) return i;
  }
  return -1;
}

/**
 * 列出 ZIP 内所有条目（不解析内容）。
 * @returns {Array<{name:string, method:number, compSize:number, uncompSize:number, localOffset:number}>}
 */
export function listEntries(buf) {
  const eocd = findEocd(buf);
  if (eocd < 0) throw new Error("不是有效的 ZIP 文件（找不到中央目录）");
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);

  const entries = [];
  for (let i = 0; i < count; i += 1) {
    if (off + 46 > buf.length || buf.readUInt32LE(off) !== SIG_CENTRAL) break;
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const uncompSize = buf.readUInt32LE(off + 24);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOffset = buf.readUInt32LE(off + 42);
    const name = buf.toString("utf8", off + 46, off + 46 + nameLen);
    entries.push({ name, method, compSize, uncompSize, localOffset });
    off += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/**
 * 读取单个条目内容。
 * @param {Buffer} buf 整个 ZIP
 * @param {object} entry listEntries 返回的条目
 * @param {number} [maxBytes] 解压上限，防止 zip bomb
 */
export function readEntry(buf, entry, maxBytes = 32 * 1024 * 1024) {
  const lo = entry.localOffset;
  if (lo + 30 > buf.length || buf.readUInt32LE(lo) !== SIG_LOCAL) {
    throw new Error(`本地头损坏: ${entry.name}`);
  }
  const nameLen = buf.readUInt16LE(lo + 26);
  const extraLen = buf.readUInt16LE(lo + 28);
  const start = lo + 30 + nameLen + extraLen;
  const raw = buf.subarray(start, start + entry.compSize);

  if (entry.method === 0) return Buffer.from(raw);
  if (entry.method === 8) {
    // inflateRawSync 带 maxOutputLength，可拦住解压炸弹
    const out = zlib.inflateRawSync(raw, { maxOutputLength: maxBytes });
    return out;
  }
  throw new Error(`不支持的压缩方式 ${entry.method}: ${entry.name}`);
}

/**
 * 一次性读出所有条目内容（只读需要的那几个，避免白解压大文件）。
 * @param {Buffer} buf
 * @param {(entry:object) => boolean} [filter] 只要满足条件的条目
 * @param {object} [opts]
 */
export function readEntries(buf, filter = () => true, { maxBytes = 32 * 1024 * 1024 } = {}) {
  const out = new Map();
  for (const entry of listEntries(buf)) {
    if (!filter(entry)) continue;
    try {
      out.set(entry.name, readEntry(buf, entry, maxBytes));
    } catch {
      // 单个条目坏了不该拖垮整个文件解析
    }
  }
  return out;
}

/** 便捷：取某个条目并按 utf8 转字符串 */
export function readText(buf, name, opts) {
  const entries = listEntries(buf);
  const entry = entries.find((e) => e.name === name);
  if (!entry) return null;
  return readEntry(buf, entry, opts?.maxBytes).toString("utf8");
}
