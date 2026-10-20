/**
 * 成长（growth）—— 让她**在对话中变好**，而不只是记事。
 *
 * 背景（2026-10-19 主人要求）：「能不能春禾在对话中成长」。
 *
 * 现状：她会记事实（`ownerMemory`：称呼/偏好），但不会**改行为**。
 *   被说「太长了」下次还是长；被说「别这样」下次还这样。
 *   因为她只存"主人是什么样"，没存"我该怎么说话"。
 *
 * 这个模块补的就是后者 —— 一条**可累积、可淘汰、会进化的行为准则库**：
 *
 *   来源（自动识别，不靠模型）：
 *     · 纠正：「别这么说话」「太长了」「你该先说结论」「不要每次都道歉」
 *     · 认可：「这样就好」「就这么说」「我喜欢你这样」
 *     · 主人明示：「以后都先给结论」→ 直接当规则
 *
 *   生命周期：
 *     · 新规则 → 置信度 1，注入时占 1 行
 *     · 被重复确认（同类说法再来）→ 置信度 +1（更靠前）
 *     · 长期没被提及 → 慢慢降权，最后被新规则挤出去
 *     · **上限 24 条**，按置信度取前 12 条注入（防提示词膨胀）
 *
 * 存盘：`data/growth.json`
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

const DEFAULT_FILE = "data/growth.json";

/** 规则上限（超过就淘汰置信度最低的） */
export const MAX_LESSONS = 24;
/** 注入上限（每轮只带这么多条，防 token 膨胀） */
export const INJECT_LESSONS = 12;

/** 纠正信号：= 她该改的行为 */
const CORRECTION_PATTERNS = [
  { re: /(?:别|不要|不用|甭)(?:这么|这样|总是|老)(?:说|回|讲|做)/, kind: "tone" },
  { re: /(?:太|有点|稍微)(?:长|啰嗦|多|少|短|硬|冷|油|客气|正式)/, kind: "style" },
  { re: /你(?:不该|不应该|不能)(?:这么|这样)/, kind: "behavior" },
  { re: /(?:不要|别)(?:每次|总是)(?:都)?(?:说|问|道歉|解释|重复)/, kind: "habit" },
  { re: /(?:先|直接)(?:说|给)(?:结论|答案|重点)/, kind: "structure" },
  { re: /(?:以后|下次)(?:都|要|别)(?:先|直接|别|不)/, kind: "explicit" },
  { re: /(?:太|好)(?:AI|机器|客服)(?:了|味)/, kind: "tone" },
  { re: /(?:别)(?:一直|老)(?:发表情|用感叹号|加括号)/, kind: "habit" },
];

/** 认可信号：= 有效做法，值得强化 */
const APPROVAL_PATTERNS = [
  { re: /(?:这样|这么|这么回|这么说)(?:就)?(?:好|对|行|不错|可以)/, kind: "approve" },
  { re: /(?:我喜欢|就喜欢)(?:你)?(?:这样|这么|这么说话)/, kind: "approve" },
  { re: /(?:这才对|这就对了|就是这样)/, kind: "approve" },
];

/**
 * 从一句话里识别"她该学的规则"。
 *
 * @param {string} text 主人/群友说的话
 * @returns {{kind: string, text: string, polarity: "correction"|"approval"}|null}
 */
export function detectGrowthSignal(text) {
  const s = String(text ?? "").trim();
  if (!s || s.length > 120) return null;
  for (const p of APPROVAL_PATTERNS) {
    if (p.re.test(s)) return { kind: p.kind, text: s.slice(0, 60), polarity: "approval" };
  }
  for (const p of CORRECTION_PATTERNS) {
    if (p.re.test(s)) return { kind: p.kind, text: s.slice(0, 60), polarity: "correction" };
  }
  return null;
}

/**
 * 把主人的原话压成一条**可执行的行为规则**。
 *
 * 不做语义改写（那要模型），只做"去掉口水 + 加前缀"，
 * 让规则读起来像"她应该怎么做"。
 */
export function condenseLesson(signal) {
  if (!signal) return "";
  const raw = String(signal.text ?? "").trim();
  if (!raw) return "";
  if (signal.polarity === "approval") {
    return `继续保持：${raw}（主人认可过这种做法）`;
  }
  // 纠正类：保留原话，但标明"这是要改的"
  return `要改：${raw}`;
}

export class GrowthBook {
  /**
   * @param {{file?: string, logger?: object, now?: () => number}} [opts]
   */
  constructor({ file = DEFAULT_FILE, logger = null, now = () => Date.now() } = {}) {
    this.file = file;
    this.logger = logger;
    this.now = now;
    /** id → { text, kind, polarity, weight, hits, createdAt, updatedAt } */
    this.lessons = new Map();
    this.#loadSync();
  }

  #loadSync() {
    try {
      const data = JSON.parse(fs.readFileSync(this.file, "utf8"));
      for (const l of data?.lessons ?? []) {
        const id = String(l?.id ?? "");
        const text = String(l?.text ?? "").trim();
        if (!id || !text) continue;
        this.lessons.set(id, {
          text,
          kind: String(l?.kind ?? "tone"),
          polarity: l?.polarity === "approval" ? "approval" : "correction",
          weight: Number(l?.weight) || 1,
          hits: Number(l?.hits) || 1,
          createdAt: Number(l?.createdAt) || 0,
          updatedAt: Number(l?.updatedAt) || 0,
        });
      }
    } catch {
      /* 首次运行 */
    }
  }

  async flush() {
    try {
      await fsp.mkdir(path.dirname(this.file), { recursive: true });
      const data = {
        version: 1,
        savedAt: new Date(this.now()).toISOString(),
        lessons: [...this.lessons.entries()].map(([id, v]) => ({ id, ...v })),
      };
      await fsp.writeFile(this.file, JSON.stringify(data, null, 2));
    } catch (err) {
      this.logger?.warn?.(`成长记录写入失败：${err?.message ?? err}`);
    }
  }

  /**
   * 学一条。同类已存在则**加强**（weight +1），否则新增。
   *
   * @param {{kind: string, text: string, polarity: "correction"|"approval"}} signal
   * @param {{condensed?: string}} [opts]
   * @returns {{id: string, isNew: boolean, weight: number}}
   */
  learn(signal, { condensed = "" } = {}) {
    const text = String(condensed || condenseLesson(signal) || "").trim();
    if (!text) return { id: "", isNew: false, weight: 0 };
    // 去重键：同类 + 文本（文本取前 30 字，容忍轻微改写）
    const key = `${signal.kind}:${text.slice(0, 30)}`;
    const existing = [...this.lessons.entries()].find(
      ([, v]) => `${v.kind}:${v.text.slice(0, 30)}` === key,
    );
    const now = this.now();
    if (existing) {
      const [id, v] = existing;
      const weight = Math.min(10, v.weight + 1);
      this.lessons.set(id, { ...v, weight, hits: v.hits + 1, updatedAt: now });
      this.logger?.info?.(`成长：强化规则「${text.slice(0, 30)}」→ 权重 ${weight}`);
      void this.flush();
      return { id, isNew: false, weight };
    }
    const id = `l_${now.toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    this.lessons.set(id, {
      text,
      kind: signal.kind,
      polarity: signal.polarity,
      weight: 1,
      hits: 1,
      createdAt: now,
      updatedAt: now,
    });
    this.#enforceCap();
    this.logger?.info?.(`成长：学到新规则「${text.slice(0, 40)}」`);
    void this.flush();
    return { id, isNew: true, weight: 1 };
  }

  /** 超过上限就淘汰权重最低、最旧的 */
  #enforceCap() {
    if (this.lessons.size <= MAX_LESSONS) return;
    const sorted = [...this.lessons.entries()].sort(
      (a, b) => a[1].weight - b[1].weight || a[1].updatedAt - b[1].updatedAt,
    );
    for (const [id] of sorted.slice(0, this.lessons.size - MAX_LESSONS)) {
      this.lessons.delete(id);
    }
  }

  /** 取最该注入的规则（按权重降序，最多 INJECT_LESSONS 条） */
  top(limit = INJECT_LESSONS) {
    return [...this.lessons.values()]
      .sort((a, b) => b.weight - a.weight || b.updatedAt - a.updatedAt)
      .slice(0, Math.max(0, limit));
  }

  /**
   * 给模型看的一段话。没有规则时返回空串（不注入，零成本）。
   */
  describe(limit = INJECT_LESSONS) {
    const list = this.top(limit);
    if (!list.length) return "";
    const lines = ["【你从对话里学到的（按重要性排序，请照做）】"];
    for (const l of list) lines.push(`- ${l.text}`);
    lines.push("（这些是主人/群友明确表达过的偏好，**优先于默认习惯**。）");
    return lines.join("\n");
  }

  /** 诊断用 */
  snapshot() {
    return [...this.lessons.entries()].map(([id, v]) => ({ id, ...v }));
  }
}
