/**
 * 好感度（affinity）—— 「对好人好态度，对恶人坏态度，对主人永远好」。
 *
 * 2026-10-19 主人要求。之前的问题是二元的：
 *   要么太软（谁骚扰都忍），要么一刀切冷（所有人都冷）。
 * 好感度把态度变成**连续量**，按每个人实际做过的事累积。
 *
 * 规则：
 *   · **主人恒定最高**（不参与加减，永远是亲的）。
 *   · 群友从 0 开始：
 *       骚扰/辱骂/威胁 → −2 ~ −3
 *       礼貌/感谢/夸奖   → +1
 *   · 分数决定注入给她的"态度提示"，进而影响措辞的冷暖。
 *
 * 存盘：`data/affinity.json`（小文件，改动即写）。
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

const DEFAULT_FILE = "data/affinity.json";

export const AFFINITY = Object.freeze({
  MIN: -20,
  MAX: 20,
  /** 主人固定值（不参与加减） */
  OWNER: 999,
});

/** 态度分层（给模型看的提示） */
export const AFFINITY_TIERS = Object.freeze([
  { min: 6, key: "warm", label: "亲近", hint: "你挺喜欢这个人的，说话可以软一点、暖一点，用点语气词。" },
  { min: 2, key: "friendly", label: "友好", hint: "你对这个人印象不错，正常友善地聊就行。" },
  { min: -2, key: "neutral", label: "中性", hint: "普通关系，客气自然即可，不用特别热情也不用冷。" },
  { min: -6, key: "cold", label: "冷淡", hint: "这人对你不太客气过。**话短一点、别主动热络**，但不主动攻击。" },
  { min: -Infinity, key: "hostile", label: "敌意", hint: "这人反复骚扰/骂过你。**不必客气**：可以怼、可以骂回去、可以只回一两个字甚至不理。" },
]);

/**
 * 从文本判断"善意信号"（加分）。
 * 只认明确的好意，避免误加。
 */
export function detectKindness(text) {
  const s = String(text ?? "").trim();
  if (!s || s.length > 60) return 0;
  let score = 0;
  if (/(?:谢谢|谢啦|多谢|感谢|辛苦了|麻烦你了)/.test(s)) score += 1;
  if (/(?:可爱|好看|厉害|聪明|真棒|喜欢你|好乖|温柔)/.test(s)) score += 1;
  if (/(?:对不起|抱歉|不好意思|我错了)/.test(s)) score += 1;
  return Math.min(score, 2);
}

export class AffinityStore {
  /**
   * @param {{file?: string, logger?: object, ownerIds?: string[], now?: () => number}} [opts]
   */
  constructor({ file = DEFAULT_FILE, logger = null, ownerIds = [], defaultScore = 0, now = () => Date.now() } = {}) {
    this.file = file;
    this.logger = logger;
    this.now = now;
    this.ownerIds = new Set((ownerIds ?? []).filter(Boolean));
    /** 陌生人的初始好感度（QQ_AFFINITY_DEFAULT 可调，默认 0） */
    this.defaultScore = Math.max(AFFINITY.MIN, Math.min(AFFINITY.MAX, Number(defaultScore) || 0));
    /** openid → { score, reasons: string[], updatedAt } */
    this.map = new Map();
    this.#loadSync();
  }

  #loadSync() {
    try {
      const data = JSON.parse(fs.readFileSync(this.file, "utf8"));
      for (const [id, v] of Object.entries(data?.people ?? {})) {
        const score = Number(v?.score);
        if (!id || !Number.isFinite(score)) continue;
        this.map.set(String(id), {
          score,
          reasons: Array.isArray(v?.reasons) ? v.reasons.slice(-5).map(String) : [],
          updatedAt: Number(v?.updatedAt) || 0,
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
        people: Object.fromEntries(this.map),
      };
      await fsp.writeFile(this.file, JSON.stringify(data, null, 2));
    } catch (err) {
      this.logger?.warn?.(`好感度写入失败：${err?.message ?? err}`);
    }
  }

  /** 当前分数（主人恒定最高） */
  get(openid) {
    const id = String(openid ?? "").trim();
    if (!id) return 0;
    if (this.ownerIds.has(id)) return AFFINITY.OWNER;
    return this.map.get(id)?.score ?? this.defaultScore;
  }

  /**
   * 加减好感度。
   * @param {string} openid
   * @param {number} delta 正=加分，负=减分
   * @param {string} [reason] 简短原因（保留最近 5 条，供排查）
   * @returns {number} 新分数
   */
  adjust(openid, delta, reason = "") {
    const id = String(openid ?? "").trim();
    if (!id || this.ownerIds.has(id)) return AFFINITY.OWNER; // 主人不参与
    const d = Number(delta) || 0;
    if (!d) return this.get(id);
    const cur = this.map.get(id) ?? { score: 0, reasons: [], updatedAt: 0 };
    const score = Math.max(AFFINITY.MIN, Math.min(AFFINITY.MAX, cur.score + d));
    const reasons = [...cur.reasons, `${d > 0 ? "+" : ""}${d} ${String(reason).slice(0, 20)}`].slice(-5);
    this.map.set(id, { score, reasons, updatedAt: this.now() });
    this.logger?.info?.(`好感度 ${score >= 0 ? "+" : ""}${score}（${d > 0 ? "+" : ""}${d}：${reason}）尾号 ${id.slice(-4)}`);
    void this.flush();
    return score;
  }

  /** 层级信息 */
  tierOf(openid) {
    const score = this.get(openid);
    if (this.ownerIds.has(String(openid ?? "").trim())) {
      return { score, key: "owner", label: "主人", hint: "这是主人 —— **永远对他好**：软、黏、有耐心，别冷淡。" };
    }
    for (const t of AFFINITY_TIERS) {
      if (score >= t.min) return { ...t, score };
    }
    return { ...AFFINITY_TIERS[AFFINITY_TIERS.length - 1], score };
  }

  /**
   * 给模型看的态度提示。
   * @param {string} openid
   * @param {{label?: string}} [opts]
   */
  describe(openid, { label = "" } = {}) {
    const id = String(openid ?? "").trim();
    if (!id) return "";
    const t = this.tierOf(id);
    const who = label || `尾号 ${id.slice(-4)}`;
    if (t.key === "owner") return `【好感度】${who}：${t.label}。${t.hint}`;
    return `【好感度】${who}：${t.score} 分（${t.label}）。${t.hint}`;
  }
}
