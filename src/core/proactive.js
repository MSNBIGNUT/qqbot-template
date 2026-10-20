/**
 * 主动消息：让春禾偶尔"自说自话"。
 *
 * ⚠️ 平台现实（必须先读，官方 FAQ 明确写了）：
 *   1. 主动消息有**每日配额**：官方文档示例里"主动消息每日每频道限 20 条"，
 *      且部分场景只对白名单开放。超配额会直接报错。
 *   2. 用户可以在机器人资料卡里**手动关闭主动推送**，届时收不到任何主动消息
 *      （平台会下发 C2C_MSG_REJECT / GROUP_MSG_REJECT 事件）。
 *   3. 因此：本功能**默认关闭**，需要显式开启，并且自带每日上限与静默时段。
 *
 * 设计：
 *   - 只对「近期活跃过、但已安静一段时间」的会话发起
 *   - 每日总量受配置限制（默认 3 条，远低于平台上限，留安全余量）
 *   - 可选静默时段（默认 23:00-08:00 不发，像个正常人）
 *   - 计数持久化到磁盘，重启不重置（避免重启绕过配额）
 */

import fs from "node:fs";
import path from "node:path";

const DEFAULT_IDLE_MINUTES = 90;
const DEFAULT_DAILY_LIMIT = 3;
const DEFAULT_QUIET_HOURS = "23-8";

export class ProactiveScheduler {
  /**
   * @param {object} opts
   * @param {boolean} opts.enabled
   * @param {number} [opts.idleMinutes] 静默多久才考虑发起
   * @param {number} [opts.dailyLimit] 每天最多几条
   * @param {string} [opts.quietHours] 静默时段，如 "23-8"
   * @param {number} [opts.checkIntervalMs]
   * @param {string} [opts.stateFile] 配额计数持久化
   * @param {() => Promise<{scope:string,targetId:string,text:string}|null>} opts.compose
   * @param {(scope:string, targetId:string, text:string) => Promise<unknown>} opts.send
   * @param {object} [opts.logger]
   * @param {() => number} [opts.now]
   */
  constructor(opts) {
    this.enabled = Boolean(opts.enabled);
    this.idleMinutes = opts.idleMinutes ?? DEFAULT_IDLE_MINUTES;
    this.dailyLimit = opts.dailyLimit ?? DEFAULT_DAILY_LIMIT;
    this.quietHours = opts.quietHours ?? DEFAULT_QUIET_HOURS;
    this.checkIntervalMs = opts.checkIntervalMs ?? 60000;
    this.stateFile = opts.stateFile ?? "";
    this.compose = opts.compose;
    this.send = opts.send;
    this.logger = opts.logger;
    this.now = opts.now ?? (() => Date.now());

    /** @type {Map<string, number>} 会话键 → 最后活动时间 */
    this.lastActivity = new Map();
    /** @type {Map<string, {scope:string, targetId:string}>} 会话键 → 发送目标 */
    this.targets = new Map();
    /** 被用户关闭主动推送的会话，永久跳过 */
    this.muted = new Set();

    this.state = { date: todayKey(this.now()), sent: 0 };
    this._timer = null;
    this._loading = false;
    this.loadState();
  }

  /** 记录一条会话活动（收到消息时调用） */
  touch(sessionKey, { scope, targetId }) {
    this.lastActivity.set(sessionKey, this.now());
    if (scope && targetId) this.targets.set(sessionKey, { scope, targetId });
  }

  /** 用户关闭了主动推送（收到 C2C_MSG_REJECT / GROUP_MSG_REJECT 事件时调用） */
  mute(sessionKey) {
    if (this.muted.has(sessionKey)) return;
    this.muted.add(sessionKey);
    this.logger?.warn?.(`用户关闭了主动推送，之后不再打扰：${sessionKey}`);
    this.saveState();
  }

  /** 今天还能发几条 */
  remaining() {
    this.#rollDate();
    return Math.max(0, this.dailyLimit - this.state.sent);
  }

  /** 是否处于静默时段 */
  inQuietHours() {
    const { start, end } = parseQuietHours(this.quietHours);
    if (start === end) return false;
    const hour = new Date(this.now()).getHours();
    // 跨午夜，例如 23-8
    return start < end ? hour >= start && hour < end : hour >= start || hour < end;
  }

  /** 取一个"该被搭话"的会话；没有则返回 null */
  pickIdleSession() {
    if (!this.enabled || this.inQuietHours() || this.remaining() <= 0) return null;
    const idleMs = this.idleMinutes * 60000;
    const now = this.now();

    const candidates = [];
    for (const [sessionKey, at] of this.lastActivity) {
      if (this.muted.has(sessionKey)) continue;
      if (!this.targets.has(sessionKey)) continue;
      const silent = now - at;
      if (silent >= idleMs) candidates.push({ sessionKey, at, silent });
    }
    if (!candidates.length) return null;

    // 最久没说话的优先（更像"想起你了"）
    candidates.sort((a, b) => a.at - b.at);
    return candidates[0];
  }

  /** 执行一次检查；返回本次是否真的发了 */
  async tick() {
    const pick = this.pickIdleSession();
    if (!pick) return { sent: false, reason: this.#skipReason() };

    const target = this.targets.get(pick.sessionKey);
    let payload = null;
    try {
      payload = await this.compose({ sessionKey: pick.sessionKey, ...target });
    } catch (err) {
      this.logger?.warn?.(`主动消息生成失败：${err?.message}`);
      return { sent: false, reason: "compose_failed" };
    }

    // 容错：compose 可能返回 {text} 对象，也可能返回裸字符串。
    // 曾经因为真实实现返回字符串、而这里只认 payload.text，
    // 导致每轮都调模型却一条都发不出去（静默烧 token）。
    // 这里两种都接受，避免同类契约不一致再次变成"静默失败"。
    const text = typeof payload === "string" ? payload.trim() : String(payload?.text ?? "").trim();
    if (!text) {
      if (payload) this.logger?.debug?.("主动消息：compose 返回了空内容，跳过");
      return { sent: false, reason: "nothing_to_say" };
    }

    try {
      await this.send(target.scope, target.targetId, payload.text);
      this.#consume();
      // 发完就刷新活动时间，避免连续追问
      this.lastActivity.set(pick.sessionKey, this.now());
      this.logger?.info?.(
        `主动说了句（今日 ${this.state.sent}/${this.dailyLimit}）：${payload.text.slice(0, 40)}`,
      );
      return { sent: true, text: payload.text };
    } catch (err) {
      const msg = String(err?.message ?? err);
      // 用户关闭推送 / 配额用尽：不要重试，标记并停手
      if (/关闭|reject|配额|limit|频率/i.test(msg)) {
        this.logger?.warn?.(`主动消息被平台拒绝（可能用户已关闭推送）：${msg}`);
        this.mute(pick.sessionKey);
      } else {
        this.logger?.warn?.(`主动消息发送失败：${msg}`);
      }
      return { sent: false, reason: "send_failed" };
    }
  }

  /** 启动定时检查 */
  start() {
    if (!this.enabled) {
      this.logger?.info?.("主动消息：未启用（如需开启请设置 QQ_PROACTIVE=true）");
      return;
    }
    this.logger?.info?.(
      `主动消息：已启用（静默 ${this.idleMinutes} 分钟后搭话，每日上限 ${this.dailyLimit} 条，静默时段 ${this.quietHours}）`,
    );
    this._timer = setInterval(() => {
      void this.tick();
    }, this.checkIntervalMs);
    this._timer.unref?.();
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
  }

  #skipReason() {
    if (!this.enabled) return "disabled";
    if (this.inQuietHours()) return "quiet_hours";
    if (this.remaining() <= 0) return "daily_limit";
    return "no_idle_session";
  }

  #rollDate() {
    const key = todayKey(this.now());
    if (key !== this.state.date) {
      this.state = { date: key, sent: 0 };
      this.saveState();
    }
  }

  #consume() {
    this.#rollDate();
    this.state.sent += 1;
    this.saveState();
  }

  saveState() {
    if (!this.stateFile || this._loading) return;
    try {
      fs.mkdirSync(path.dirname(this.stateFile), { recursive: true });
      fs.writeFileSync(
        this.stateFile,
        JSON.stringify({ version: 1, date: this.state.date, sent: this.state.sent, muted: [...this.muted] }),
        "utf8",
      );
    } catch (err) {
      this.logger?.warn?.(`主动消息状态写盘失败：${err?.message}`);
    }
  }

  loadState() {
    if (!this.stateFile) return;
    try {
      if (!fs.existsSync(this.stateFile)) return;
      this._loading = true;
      const data = JSON.parse(fs.readFileSync(this.stateFile, "utf8"));
      this.state = {
        date: String(data?.date ?? todayKey(this.now())),
        sent: Number(data?.sent) || 0,
      };
      for (const key of data?.muted ?? []) this.muted.add(String(key));
      // 跨天则清零
      this.#rollDate();
    } catch {
      /* 状态坏了就按新的一天开始 */
    } finally {
      this._loading = false;
    }
  }
}

/** 本地日期键，用于"每天"配额 */
export function todayKey(ts = Date.now()) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** 解析 "23-8" 这类静默时段 */
export function parseQuietHours(spec) {
  const m = String(spec ?? "").match(/^(\d{1,2})\s*-\s*(\d{1,2})$/);
  if (!m) return { start: 23, end: 8 };
  return { start: Number(m[1]) % 24, end: Number(m[2]) % 24 };
}
