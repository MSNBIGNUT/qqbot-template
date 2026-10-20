/**
 * 把一段回复拆成"人味"的多条消息。
 *
 * 为什么需要：一条几百字的回复甩过去，像客服工单，不像聊天。
 * 真人会分几口气说，中间有停顿。
 *
 * 设计要点：
 *  - **绝不切在句子中间**：只在段落、句末标点、换行、逗号处断开
 *  - 段落数量有上下限，太短的话不拆（一两句话拆开更假）
 *  - 代码块、Markdown 列表尽量保持完整，避免拆坏格式
 */

/** 依据结尾标点决定停顿长短（毫秒）——问号、省略号后停更久，像在等人反应 */
export function gapAfter(text) {
  const last = String(text).trimEnd().slice(-1);
  if ("？?！!".includes(last)) return 900;
  if ("。.~～".includes(last)) return 700;
  if ("…".includes(last)) return 1100;
  if ("，,、；;：:".includes(last)) return 400;
  return 600;
}

/**
 * 匹配唤名（默认"春禾"）。
 *
 * 为什么单独抽出来：群里要支持"喊一句春禾就应答"，
 * 但唤名判断必须**保守**——误判会让机器人在别人闲聊时突然插话，很扰民。
 *
 * 规则：
 *  - 正则里剥掉唤名后，若剩下的全是语气词/标点/空白，可能是"春禾在吗"这类，算命中；
 *  - 也支持唤名出现在句中（"春禾帮我算个题"）。
 *
 * @param {string} text 已去掉 @提及 的文本
 * @param {string[]} names
 * @returns {boolean}
 */
export function matchWakeName(text, names = ["春禾"]) {
  const clean = String(text ?? "").trim();
  if (!clean) return false;
  const list = (names ?? []).map((n) => String(n ?? "").trim()).filter(Boolean);

  // 只要唤名出现在文本里就算被叫到（"春禾"、"春禾在吗"、"春禾帮我算个题" 都命中）。
  // 之所以不做更严格的"独立成词"判断：中文没有词边界，过度收紧反而会漏掉自然的叫法。
  return list.some((name) => clean.includes(name));
}

/** 在标点处切句，且不破坏括号/引号内的内容（够用的近似：按标点切分后回填） */
function splitSentences(text) {
  const out = [];
  let buf = "";
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    buf += ch;
    const isHard = "。！？!?…".includes(ch);
    const isSoft = "；;".includes(ch);
    // 换行也是天然断点
    if (isHard || isSoft || ch === "\n") {
      // 标点后若还有引号/括号收尾，一并带走
      let j = i + 1;
      while (j < text.length && "\"'\u201d\u2019)）」』".includes(text[j])) {
        buf += text[j];
        j += 1;
        i = j - 1;
      }
      out.push(buf.trim());
      buf = "";
    }
  }
  if (buf.trim()) out.push(buf.trim());
  return out.filter(Boolean);
}

/** 段落/代码块优先：换行分段的块不会被合并，保证列表与代码完整 */
function splitBlocks(text) {
  return String(text)
    .split(/\n{2,}/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * 把回复拆成多条。
 *
 * @param {string} text
 * @param {object} [opts]
 * @param {boolean} [opts.enabled] 关闭时原样返回单条
 * @param {number} [opts.maxSegments] 最多几条
 * @param {number} [opts.maxChars] 每条软上限（超出才考虑多拆）
 * @param {number} [opts.minChars] 小于这个长度不拆
 * @returns {string[]} 至少一条
 */
export function splitReply(text, opts = {}) {
  const {
    enabled = true,
    maxSegments = 3,
    maxChars = 120,
    minChars = 60,
  } = opts;

  const full = String(text ?? "").trim();
  if (!full) return [];
  if (!enabled) return [full];

  // 短回复不拆：一两句拆开反而更假
  if (full.length <= minChars) return [full];

  // 先按空行分块，尽量保证列表/代码完整
  let blocks = splitBlocks(full);
  if (blocks.length === 1) {
    // 没有空行：按句子分，再合并成不超过 maxSegments 段
    const sentences = splitSentences(full);
    blocks = [];
    let cur = "";
    for (const s of sentences) {
      const candidate = cur ? `${cur}${cur.endsWith("\n") ? "" : ""}${s}` : s;
      if (cur && candidate.length > maxChars) {
        blocks.push(cur.trim());
        cur = s;
      } else {
        cur = candidate;
      }
    }
    if (cur.trim()) blocks.push(cur.trim());
  }

  if (blocks.length <= 1) return [full];

  // 块数超过上限：把超出部分合并到最后一个（保持顺序与完整）
  if (blocks.length > maxSegments) {
    const head = blocks.slice(0, maxSegments - 1);
    const tail = blocks.slice(maxSegments - 1).join("\n\n");
    blocks = [...head, tail];
  }

  // 过滤掉空段，并保证每段都有内容
  blocks = blocks.map((b) => b.trim()).filter(Boolean);
  return blocks.length ? blocks : [full];
}

/**
 * 计算多段发送之间的停顿序列。
 * @param {string[]} segments
 * @param {object} [opts]
 * @param {number} [opts.minMs]
 * @param {number} [opts.maxMs]
 * @param {(ms:number)=>number} [opts.jitter] 便于测试注入确定性抖动
 */
export function planGaps(segments, opts = {}) {
  const { minMs = 350, maxMs = 1400, jitter = (ms) => ms } = opts;
  const gaps = [];
  for (let i = 1; i < segments.length; i += 1) {
    const base = gapAfter(segments[i - 1]);
    const clamped = Math.min(Math.max(base, minMs), maxMs);
    gaps.push(Math.round(jitter(clamped)));
  }
  return gaps;
}
