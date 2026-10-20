/**
 * 定时提醒：让春禾能"过一会儿主动说一句话"。
 *
 * 为什么需要单独一层：机器人平时只在收到消息时才回应，
 * 没有任何计时机制。用户说"五分钟后提醒我"，它只能老实回答"我做不到"。
 *
 * 设计要点：
 *  - **按绝对时间戳存**，而不是存"还剩多久"——这样重启后依然算得准；
 *  - 持久化到磁盘，重启不丢待发出的提醒；
 *  - 自带每日上限：QQ 对主动消息有配额，定时提醒属于主动消息，
 *    失控会撞配额甚至被平台判为骚扰；
 *  - 用户关闭主动推送时（由 ProactiveScheduler 报告），对应的提醒一并取消。
 */

import fs from "node:fs";
import path from "node:path";

const MAX_PER_SESSION_PER_DAY = 10;
const MAX_TOTAL = 200;

/** 解析 "5m" / "2h" / "30s" / "90"（默认分钟）为毫秒 */
export function parseDuration(text) {
  const s = String(text ?? "").trim().toLowerCase();
  if (!s) return null;

  // 纯数字 → 分钟
  if (/^\d+(\.\d+)?$/.test(s)) {
    const min = Number(s);
    return min > 0 ? Math.round(min * 60000) : null;
  }

  const m = s.match(/^(\d+(?:\.\d+)?)\s*(s|sec|secs|秒|m|min|mins|分钟|分|h|hr|hour|hours|小时|时|d|day|days|天)$/);
  if (!m) return null;
  const n = Number(m[1]);
  if (!(n > 0)) return null;
  const unit = m[2];
  const table = {
    s: 1000, sec: 1000, secs: 1000, 秒: 1000,
    m: 60000, min: 60000, mins: 60000, 分钟: 60000, 分: 60000,
    h: 3600000, hr: 3600000, hour: 3600000, hours: 3600000, 小时: 3600000, 时: 3600000,
    d: 86400000, day: 86400000, days: 86400000, 天: 86400000,
  };
  return Math.round(n * table[unit]);
}

/** 把毫秒说成人话，用于回执 */
export function humanizeDelay(ms) {
  const MINUTE = 60000;
  const HOUR = 3600000;
  const DAY = 86400000;
  // 边界容差：排期与回执之间会过几毫秒，59999ms 该说「1 分钟」而不是「60 秒」。
  // 真实踩过：说「1 分钟后提醒我」，回执却是「60 秒后主动来找你」，看着像没听懂。
  if (ms < MINUTE - 1000) return `${Math.round(ms / 1000)} 秒`;
  if (ms < HOUR - MINUTE) return `${Math.round(ms / MINUTE)} 分钟`;
  if (ms < DAY - HOUR) return `${(ms / HOUR).toFixed(ms % HOUR === 0 ? 0 : 1)} 小时`;
  return `${(ms / DAY).toFixed(ms % DAY === 0 ? 0 : 1)} 天`;
}

export function todayKey(ts = Date.now()) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export class ReminderStore {
  /**
   * @param {object} [opts]
   * @param {string} [opts.file] 持久化路径
   * @param {number} [opts.perSessionLimit] 每个会话每天最多几条
   * @param {number} [opts.minDelayMs] 最短延迟（太短就没必要定时）
   * @param {number} [opts.maxDelayMs] 最长延迟（默认 7 天）
   * @param {object} [opts.logger]
   * @param {() => number} [opts.now]
   */
  constructor({ file = "", perSessionLimit = MAX_PER_SESSION_PER_DAY, minDelayMs = 5000, maxDelayMs = 7 * 86400000, logger, now } = {}) {
    this.file = file;
    this.perSessionLimit = perSessionLimit;
    this.minDelayMs = minDelayMs;
    this.maxDelayMs = maxDelayMs;
    this.logger = logger;
    this.now = now ?? (() => Date.now());

    /** @type {Array<{id:string, sessionKey:string, scope:string, targetId:string, text:string, dueAt:number, createdAt:number, dayKey:string}>} */
    this.items = [];
    this._dirty = false;
    this._timer = null;
    if (this.file) this.load();
  }

  /** 待发送数量 */
  get size() {
    return this.items.length;
  }

  /** 某会话今天已排了几条 */
  countToday(sessionKey) {
    const key = todayKey(this.now());
    return this.items.filter((r) => r.sessionKey === sessionKey && r.dayKey === key).length;
  }

  /**
   * 排一条提醒。
   * @returns {{ok:boolean, reason?:string, reminder?:object}}
   */
  schedule({ sessionKey, scope, targetId, text, delayMs }) {
    const delay = Number(delayMs);
    if (!Number.isFinite(delay) || delay <= 0) return { ok: false, reason: "invalid_delay" };
    if (delay < this.minDelayMs) return { ok: false, reason: "too_soon" };
    if (delay > this.maxDelayMs) return { ok: false, reason: "too_far" };

    const clean = String(text ?? "").trim();
    if (!clean) return { ok: false, reason: "empty_text" };
    if (!sessionKey || !targetId) return { ok: false, reason: "missing_target" };

    if (this.countToday(sessionKey) >= this.perSessionLimit) {
      return { ok: false, reason: "daily_limit" };
    }
    if (this.items.length >= MAX_TOTAL) {
      // 淘汰最旧的，避免无限增长
      this.items.sort((a, b) => a.dueAt - b.dueAt);
      this.items.shift();
    }

    const now = this.now();
    const reminder = {
      id: `r-${now}-${Math.random().toString(36).slice(2, 8)}`,
      sessionKey,
      scope,
      targetId,
      text: clean,
      dueAt: now + delay,
      createdAt: now,
      dayKey: todayKey(now),
    };
    this.items.push(reminder);
    this.#markDirty();
    this.logger?.info?.(`已安排提醒：${humanizeDelay(delay)}后（${clean.slice(0, 30)}）`);
    return { ok: true, reminder };
  }

  /** 取消某会话的待发提醒；不传 sessionKey 则取消全部 */
  cancel(sessionKey) {
    const before = this.items.length;
    this.items = sessionKey ? this.items.filter((r) => r.sessionKey !== sessionKey) : [];
    const removed = before - this.items.length;
    if (removed > 0) this.#markDirty();
    return removed;
  }

  /** 取出所有已到期的提醒并从队列移除 */
  takeDue(now = this.now()) {
    const due = this.items.filter((r) => r.dueAt <= now);
    if (due.length === 0) return [];
    this.items = this.items.filter((r) => r.dueAt > now);
    this.#markDirty();
    return due;
  }

  /** 下一个到期时间（没有则 null），用于决定定时器间隔 */
  nextDueAt() {
    if (this.items.length === 0) return null;
    return Math.min(...this.items.map((r) => r.dueAt));
  }

  #markDirty() {
    if (!this.file) return;
    this._dirty = true;
  }

  /** @param {boolean} [force] */
  flush(force = false) {
    if (!this.file) return;
    if (!this._dirty && !force) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(
        tmp,
        JSON.stringify({ version: 1, savedAt: new Date().toISOString(), items: this.items }),
        "utf8",
      );
      fs.renameSync(tmp, this.file);
      this._dirty = false;
    } catch (err) {
      this.logger?.warn?.(`提醒写盘失败：${err?.message}`);
    }
  }

  load() {
    try {
      if (!fs.existsSync(this.file)) return;
      const data = JSON.parse(fs.readFileSync(this.file, "utf8"));
      const arr = Array.isArray(data?.items) ? data.items : [];
      const now = this.now();
      let dropped = 0;
      this.items = arr
        .filter((r) => r && typeof r.text === "string" && typeof r.dueAt === "number")
        // 已经过期太久的（比如关机一整晚）不再补发，避免开机瞬间刷一堆消息
        .filter((r) => {
          const late = now - r.dueAt;
          if (late > 30 * 60000) {
            dropped += 1;
            return false;
          }
          return true;
        })
        .map((r) => ({
          id: String(r.id ?? `r-${r.dueAt}`),
          sessionKey: String(r.sessionKey ?? ""),
          scope: String(r.scope ?? "c2c"),
          targetId: String(r.targetId ?? ""),
          text: String(r.text),
          dueAt: Number(r.dueAt),
          createdAt: Number(r.createdAt ?? now),
          dayKey: String(r.dayKey ?? todayKey(r.dueAt)),
        }));
      if (dropped > 0) this._dirty = true;
      this.logger?.info?.(
        `已加载 ${this.items.length} 条待发提醒${dropped ? `（丢弃 ${dropped} 条过期太久的）` : ""}`,
      );
    } catch (err) {
      this.logger?.warn?.(`提醒读取失败，按空启动：${err?.message}`);
      this.items = [];
    }
  }
}
