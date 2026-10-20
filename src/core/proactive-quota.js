/**
 * 主动消息配额账本。
 *
 * 为什么必须单独记：
 *   - QQ 对**主动消息**有平台频控（群聊：单群 20 条/分钟、1000 条/天，
 *     见官方《发送群聊消息》文档；超限错误码 40034100）；
 *   - 用户还可以在客户端关掉「允许主动发送」，关了以后每条都会失败；
 *   - 失败如果无脑重试，会既烧配额又像骚扰。所以**发之前查、发完记账**，
 *     超限就不发，并如实告诉主人。
 *
 * 双层限制：
 *   1. 平台硬限制：dailyLimit / minuteLimit（默认 1000/天、20/分钟，与官方一致）；
 *   2. 功能软限制：softDailyLimit（默认 20/天），只作用于 purpose="pending"
 *      （私聊指令转群主动消息），防止她一天到晚替主人往群里喊话。
 *
 * 账本落盘到 data/proactive-quota.json，重启不清零。
 */

import fs from "node:fs";
import path from "node:path";

const KEEP_MS = 40 * 24 * 3600 * 1000;
const MAX_RECORDS = 20000;

/** 本地日期键（用户看到的是本地时间，配额也按本地天算） */
export function dayKeyOf(ts = Date.now()) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export class ProactiveQuota {
  /**
   * @param {object} [opts]
   * @param {string} [opts.file]
   * @param {number} [opts.dailyLimit] 平台硬限制：单目标每天
   * @param {number} [opts.minuteLimit] 平台硬限制：单目标每分钟
   * @param {number} [opts.softDailyLimit] 功能软限制（仅 pending），0=关闭
   * @param {number} [opts.warnRatio] 到多少比例算「接近上限」
   * @param {object} [opts.logger]
   * @param {() => number} [opts.now]
   */
  constructor({
    file = "",
    dailyLimit = 1000,
    minuteLimit = 20,
    softDailyLimit = 0,
    warnRatio = 0.8,
    logger,
    now,
  } = {}) {
    this.file = file;
    this.dailyLimit = Math.max(1, Number(dailyLimit) || 1000);
    this.minuteLimit = Math.max(1, Number(minuteLimit) || 20);
    this.softDailyLimit = Math.max(0, Number(softDailyLimit) || 0);
    this.warnRatio = Math.min(1, Math.max(0.1, Number(warnRatio) || 0.8));
    this.logger = logger;
    this.now = now ?? (() => Date.now());
    /** @type {Array<{at:number, scope:string, targetId:string, purpose:string, ok:boolean, error:string}>} */
    this.records = [];
    if (this.file) this.load();
  }

  get size() {
    return this.records.length;
  }

  #today(now) {
    return dayKeyOf(now);
  }

  /** 单目标统计（默认只算 attempts：失败的也占平台配额） */
  stats({ targetId = "", scope = "group", now = this.now() } = {}) {
    const target = String(targetId ?? "");
    const day = this.#today(now);
    const minuteFloor = now - 60 * 1000;
    let dayCount = 0;
    let minuteCount = 0;
    let failCount = 0;
    for (const r of this.records) {
      if (target && r.targetId !== target) continue;
      if (scope && r.scope !== scope) continue;
      if (r.at > minuteFloor) minuteCount += 1;
      if (dayKeyOf(r.at) === day) {
        dayCount += 1;
        if (!r.ok) failCount += 1;
      }
    }
    return { dayCount, minuteCount, failCount, day, targetId: target };
  }

  /**
   * 发之前检查。
   * @returns {{ok:boolean, reason:string, level:"ok"|"warn"|"blocked", dayCount:number, minuteCount:number, remaining:number, limit:number}}
   */
  check({ targetId = "", scope = "group", purpose = "pending", now = this.now() } = {}) {
    const s = this.stats({ targetId, scope, now });
    const soft = purpose === "pending" ? this.softDailyLimit : 0;

    // 顺序很关键：先判「天」再判「分钟」。
    // 两者同时到顶时，主人更该看到「今天额度用完了」而不是「这一分钟太频繁」。
    if (s.dayCount >= this.dailyLimit) {
      return { ok: false, reason: "daily_limit", level: "blocked", ...s, remaining: 0, limit: this.dailyLimit };
    }
    if (soft > 0 && s.dayCount >= soft) {
      return { ok: false, reason: "soft_daily_limit", level: "blocked", ...s, remaining: 0, limit: soft };
    }
    if (s.minuteCount >= this.minuteLimit) {
      return {
        ok: false,
        reason: "minute_limit",
        level: "blocked",
        ...s,
        remaining: 0,
        limit: this.minuteLimit,
      };
    }

    const effectiveLimit = soft > 0 ? Math.min(this.dailyLimit, soft) : this.dailyLimit;
    const ratio = effectiveLimit > 0 ? s.dayCount / effectiveLimit : 0;
    const minuteRatio = this.minuteLimit > 0 ? s.minuteCount / this.minuteLimit : 0;
    const level = Math.max(ratio, minuteRatio) >= this.warnRatio ? "warn" : "ok";
    return {
      ok: true,
      reason: "",
      level,
      ...s,
      remaining: Math.max(0, effectiveLimit - s.dayCount),
      limit: effectiveLimit,
    };
  }

  /** 发完（或失败）记账。主动消息很少，直接同步落盘，避免重启丢账。 */
  record({ targetId = "", scope = "group", purpose = "pending", ok = true, error = "", now = this.now() } = {}) {
    const rec = {
      at: Number(now) || this.now(),
      scope: String(scope || "group"),
      targetId: String(targetId ?? ""),
      purpose: String(purpose || "generic"),
      ok: Boolean(ok),
      error: String(error ?? "").slice(0, 200),
    };
    this.records.push(rec);
    this._prune(rec.at);
    this.flush(true);
    return rec;
  }

  _prune(now = this.now()) {
    const floor = now - KEEP_MS;
    this.records = this.records.filter((r) => r.at >= floor).slice(-MAX_RECORDS);
  }

  flush(force = false) {
    if (!this.file) return;
    if (!force) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const payload = {
        version: 1,
        savedAt: new Date().toISOString(),
        records: this.records,
      };
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(payload), "utf8");
      fs.renameSync(tmp, this.file);
    } catch (err) {
      this.logger?.warn?.(`主动消息配额写盘失败：${err?.message}`);
    }
  }

  load() {
    try {
      if (!fs.existsSync(this.file)) return;
      const data = JSON.parse(fs.readFileSync(this.file, "utf8"));
      const arr = Array.isArray(data?.records) ? data.records : [];
      const now = this.now();
      this.records = arr
        .filter((r) => r && Number.isFinite(Number(r.at)))
        .map((r) => ({
          at: Number(r.at),
          scope: String(r.scope ?? "group"),
          targetId: String(r.targetId ?? ""),
          purpose: String(r.purpose ?? "generic"),
          ok: Boolean(r.ok),
          error: String(r.error ?? ""),
        }));
      this._prune(now);
      this.logger?.info?.(`已加载主动消息配额账本：${this.records.length} 条`);
    } catch (err) {
      this.logger?.warn?.(`主动消息配额读取失败，按空启动：${err?.message}`);
      this.records = [];
    }
  }
}
