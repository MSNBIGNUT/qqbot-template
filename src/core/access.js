/**
 * 访问控制三件套：去重、限流、白名单。
 *
 * 为什么必须有：
 *  - 去重：QQ 网关会**重推**同一条消息（断线补发、超时重试），不去重就会回两遍。
 *  - 限流：模型调用要花钱，失控会让额度被刷爆。
 *  - 白名单：机器人一旦被非预期用户触发，等于把额度送人；默认应「只放行指定用户」。
 */

/** 有界去重集合（FIFO 淘汰，防止内存无上限增长） */
export class DedupeCache {
  constructor(limit = 2000) {
    this.limit = Math.max(1, limit);
    this.set = new Set();
    this.queue = [];
  }

  /** @returns {boolean} true = 首次出现（应处理）；false = 重复（应丢弃） */
  check(id) {
    if (!id) return true;
    if (this.set.has(id)) return false;
    this.set.add(id);
    this.queue.push(id);
    if (this.queue.length > this.limit) {
      const old = this.queue.shift();
      this.set.delete(old);
    }
    return true;
  }

  get size() {
    return this.set.size;
  }
}

/** 滑动窗口限流（每小时/每分钟粒度足够小的场景用固定窗口即可） */
export class RateLimiter {
  constructor(perMinute = 12, windowMs = 60000) {
    this.perMinute = Math.max(1, perMinute);
    this.windowMs = windowMs;
    this.hits = new Map(); // key -> number[] 时间戳
  }

  /** @returns {{ok: boolean, remaining: number, retryAfterMs: number}} */
  take(key) {
    const now = Date.now();
    const arr = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (arr.length >= this.perMinute) {
      const retryAfterMs = this.windowMs - (now - arr[0]);
      this.hits.set(key, arr);
      return { ok: false, remaining: 0, retryAfterMs };
    }
    arr.push(now);
    this.hits.set(key, arr);
    return { ok: true, remaining: this.perMinute - arr.length, retryAfterMs: 0 };
  }

  /** 清理过期条目，避免长期运行内存缓慢增长 */
  sweep() {
    const now = Date.now();
    for (const [key, arr] of this.hits) {
      const kept = arr.filter((t) => now - t < this.windowMs);
      if (kept.length === 0) this.hits.delete(key);
      else this.hits.set(key, kept);
    }
  }
}

/**
 * 白名单判定。
 * 规则优先级：黑名单 > 白名单 > 默认。
 * 白名单为空时表示「不限制用户」（仅建议调试用）。
 */
export class AccessPolicy {
  constructor({ allowUsers = [], denyUsers = [], allowGroups = [] } = {}) {
    this.allowUsers = new Set(allowUsers);
    this.denyUsers = new Set(denyUsers);
    this.allowGroups = new Set(allowGroups);
  }

  /** @returns {{allowed: boolean, reason: string}} */
  checkUser(userId) {
    if (!userId) return { allowed: false, reason: "缺少用户标识" };
    if (this.denyUsers.has(userId)) return { allowed: false, reason: "用户在黑名单" };
    if (this.allowUsers.size === 0) return { allowed: true, reason: "未配置白名单，放行" };
    if (this.allowUsers.has(userId)) return { allowed: true, reason: "用户在白名单" };
    return { allowed: false, reason: "用户不在白名单" };
  }

  checkGroup(groupOpenid) {
    if (this.allowGroups.size === 0) return { allowed: true, reason: "未限制群" };
    if (this.allowGroups.has(groupOpenid)) return { allowed: true, reason: "群在白名单" };
    return { allowed: false, reason: "群不在白名单" };
  }
}
