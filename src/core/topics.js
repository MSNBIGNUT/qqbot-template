/**
 * 话题库：让"在哪个场景聊过的事"能被另一个场景接上。
 *
 * 为什么需要它（而不是靠"认出同一个人"）：
 * QQ 的单聊标识是 user_openid，群内标识是 member_openid，**两者不同**，
 * 平台也不允许自动关联（隐私设计）。所以"自动认出群里是你"这条路走不通。
 *
 * 替代方案：把话题本身作为可共享的记忆单元。
 *   - 单聊聊到的话题 → 记入共享话题库
 *   - 群里的对话也能取用共享话题库 → 于是"私聊说的事，群里能续上"
 *
 * 隐私边界（重要）：
 *   共享话题只应包含**主人/管理员自己的**话题，绝不能把 A 用户的私聊话题
 *   泄露给群里其他人。引擎侧按 scope 决定写入哪一类，读取时再做过滤。
 */

import fs from "node:fs";
import path from "node:path";

const MAX_TOPICS = 200;
const MAX_TOPIC_LEN = 120;

export class TopicStore {
  /**
   * @param {object} [opts]
   * @param {string} [opts.file] 持久化路径；为空则纯内存
   * @param {number} [opts.maxTopics]
   * @param {object} [opts.logger]
   */
  constructor({ file = "", maxTopics = MAX_TOPICS, logger } = {}) {
    this.file = file;
    this.maxTopics = maxTopics;
    this.logger = logger;
    /** @type {Array<{text:string, scope:string, owner:string, at:number, shared:boolean, hits:number}>} */
    this.topics = [];
    this._dirty = false;
    this._timer = null;
    if (this.file) this.load();
  }

  /**
   * 记一个话题。
   * @param {object} p
   * @param {string} p.text 话题内容
   * @param {string} p.scope 'c2c' | 'group'
   * @param {string} p.owner 会话标识（用于隔离他人隐私）
   * @param {boolean} [p.shared] 是否进入共享话题库（跨场景可见）
   */
  add({ text, scope, owner, shared = false }) {
    const clean = normalizeTopic(text);
    if (!clean) return null;

    // 去重：内容高度相似就不重复记，只更新时间与命中次数
    const existing = this.topics.find((t) => similar(t.text, clean));
    if (existing) {
      existing.at = Date.now();
      existing.hits += 1;
      if (shared) existing.shared = true;
      this._markDirty();
      return existing;
    }

    const topic = { text: clean, scope, owner, at: Date.now(), shared, hits: 1 };
    this.topics.push(topic);
    // 超出上限：优先淘汰最旧且未被共享的
    if (this.topics.length > this.maxTopics) {
      this.topics.sort((a, b) => {
        if (a.shared !== b.shared) return a.shared ? 1 : -1;
        return a.at - b.at;
      });
      this.topics.splice(0, this.topics.length - this.maxTopics);
    }
    this._markDirty();
    return topic;
  }

  /**
   * 取与当前消息相关的话题。
   * @param {object} [opts]
   * @param {string} [opts.query] 当前用户说的话（用于相关度排序）
   * @param {boolean} [opts.includeShared] 是否包含共享话题
   * @param {string} [opts.owner] 只看这个 owner 的话题（当前会话键）
   * @param {string} [opts.scene] 当前场景键；给了就按场景隔离（群成员话题只在同群可见）
   * @param {string[]} [opts.ownerIds] 主人 id；主人的话题只对主人自己可见
   * @param {number} [opts.limit]
   */
  relevant({ query = "", includeShared = true, owner = "", scene = "", ownerIds = [], limit = 5 } = {}) {
    const tokens = tokenize(query);
    const pool = this.topics.filter((t) => {
      // 主人的话题：只在主人自己的会话里可见（调用方必须只在主人会话传 ownerIds）
      if (includeShared && isOwnedBy(t, ownerIds)) return true;
      if (scene) {
        if (owner && t.owner === owner) return true;
        return Boolean(t.shared && includeShared && sceneOfTopicOwner(t.owner) === scene);
      }
      // 兼容旧调用（没有 scene）：保持原有「共享 / 自己的」判定
      if (t.shared && includeShared) return true;
      if (owner && t.owner === owner) return true;
      return false;
    });

    const scored = pool.map((t) => {
      let score = 0;
      // 关键词重合
      const tt = tokenize(t.text);
      for (const tok of tokens) if (tt.has(tok)) score += 3;
      // 共享话题有基础权重；最近聊过的更可能被提起
      if (t.shared) score += 1;
      const ageHours = (Date.now() - t.at) / 3600000;
      score += Math.max(0, 2 - ageHours / 24);
      score += Math.min(t.hits, 5) * 0.2;
      return { topic: t, score };
    });

    return scored
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((s) => s.topic);
  }

  /** 随机挑一个话题（用于"自己找话题"） */
  pick({ includeShared = true, owner = "", scene = "", ownerIds = [], avoid = [] } = {}) {
    const pool = this.topics.filter((t) => {
      if (avoid.includes(t.text)) return false;
      if (includeShared && isOwnedBy(t, ownerIds)) return true;
      if (scene) {
        if (owner && t.owner === owner) return true;
        return Boolean(t.shared && includeShared && sceneOfTopicOwner(t.owner) === scene);
      }
      if (t.shared && includeShared) return true;
      if (owner && t.owner === owner) return true;
      return false;
    });
    if (!pool.length) return null;
    // 近期被别人聊过的、以及命中多的，概率略高：用"最近一半"做加权池
    const recent = pool.slice().sort((a, b) => b.at - a.at).slice(0, Math.max(1, Math.ceil(pool.length / 2)));
    return recent[Math.floor(Math.random() * recent.length)] ?? null;
  }

  get size() {
    return this.topics.length;
  }

  _markDirty() {
    if (!this.file) return;
    this._dirty = true;
    if (this._timer) return;
    this._timer = setTimeout(() => {
      this._timer = null;
      this.flush();
    }, 800);
    this._timer.unref?.();
  }

  /** @param {boolean} [force] */
  flush(force = false) {
    if (!this.file) return;
    if (!this._dirty && !force) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, savedAt: new Date().toISOString(), topics: this.topics }), "utf8");
      fs.renameSync(tmp, this.file);
      this._dirty = false;
    } catch (err) {
      this.logger?.warn?.(`话题库写盘失败：${err?.message}`);
    }
  }

  load() {
    try {
      if (!fs.existsSync(this.file)) return;
      const data = JSON.parse(fs.readFileSync(this.file, "utf8"));
      const arr = Array.isArray(data?.topics) ? data.topics : [];
      this.topics = arr
        .filter((t) => t && typeof t.text === "string" && t.text.trim())
        .map((t) => ({
          text: normalizeTopic(t.text),
          scope: String(t.scope ?? "c2c"),
          owner: String(t.owner ?? ""),
          at: Number(t.at) || Date.now(),
          shared: Boolean(t.shared),
          hits: Number(t.hits) || 1,
        }))
        .slice(-this.maxTopics);
      this.logger?.info?.(`已加载 ${this.topics.length} 条话题记忆`);
    } catch (err) {
      this.logger?.warn?.(`话题库读取失败，按空启动：${err?.message}`);
      this.topics = [];
    }
  }
}

/**
 * 话题 owner（会话键）→ 所属场景键。
 *
 * 旧数据没有场景字段，但 owner 里已经编了场景：
 *   `c2c:<openid>`         → `c2c:<openid>`（这个人的私聊）
 *   `group:<gid>:<openid>` → `group:<gid>`（这个群，群内本就公开）
 *   `owner:<openid>`       → `owner:<openid>`（主人统一记忆，只对主人可见）
 */
export function sceneOfTopicOwner(owner) {
  const s = String(owner ?? "");
  if (s.startsWith("owner:")) return s;
  const g = s.match(/^group:([^:]+):/);
  if (g) return `group:${g[1]}`;
  const c = s.match(/^c2c:(.+)$/);
  if (c) return `c2c:${c[1]}`;
  return "";
}

/** 这条话题是不是主人自己说过的（任意场景） */
function isOwnedBy(topic, ownerIds = []) {
  if (!Array.isArray(ownerIds) || ownerIds.length === 0) return false;
  const parts = String(topic?.owner ?? "").split(":");
  return parts.some((p) => ownerIds.includes(p));
}

/** 清洗话题文本：去换行、去 @、截断 */export function normalizeTopic(text) {
  const clean = String(text ?? "")
    .replace(/<@!?\d+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!clean) return "";
  return clean.length > MAX_TOPIC_LEN ? `${clean.slice(0, MAX_TOPIC_LEN)}…` : clean;
}

/** 粗粒度分词：中文按字/双字，英文按单词。用于相关度排序，不做语义理解 */
export function tokenize(text) {
  const s = String(text ?? "").toLowerCase();
  const tokens = new Set();
  for (const w of s.match(/[a-z0-9]{2,}/g) ?? []) tokens.add(w);
  const cjk = s.replace(/[^\u4e00-\u9fa5]/g, "");
  for (let i = 0; i < cjk.length - 1; i += 1) tokens.add(cjk.slice(i, i + 2));
  return tokens;
}

/** 话题是否高度相似（够用的近似：字符集合重合度） */
function similar(a, b) {
  if (a === b) return true;
  const sa = new Set(a);
  const sb = new Set(b);
  if (sa.size === 0 || sb.size === 0) return false;
  let inter = 0;
  for (const ch of sa) if (sb.has(ch)) inter += 1;
  return inter / Math.min(sa.size, sb.size) > 0.85;
}
