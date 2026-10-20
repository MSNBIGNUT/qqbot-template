/**
 * 重连策略状态机（纯逻辑，可离线测试）。
 *
 * 为什么单独抽出来：重连逻辑埋在 WebSocket 事件回调里时极难调试
 * （真实教训：退避梯度因为自增位置不对，永远停在 1 秒，靠猜改了三次都没对）。
 * 抽成纯函数后，退避序列可以在毫秒内被完整断言。
 */

export const RECONNECT_DELAYS = [1000, 2000, 5000, 10000, 30000, 60000];
export const RATE_LIMIT_DELAY = 60000;
export const MAX_RECONNECT_ATTEMPTS = 100;
export const QUICK_DISCONNECT_THRESHOLD_MS = 5000;
/** 只有连续稳定在线超过这个时长，才认为连接真的健康并复位退避梯度 */
export const STABLE_RESET_MS = 60000;
export const MAX_QUICK_DISCONNECTS = 3;

export class ReconnectPolicy {
  constructor({ log } = {}) {
    this.log = log;
    this.attempts = 0;
    this.quickDisconnects = 0;
    this.override = null;
  }

  /** 本次断开后，下一次重连应等待多久（从官方退避序列取值） */
  nextDelayMs() {
    const idx = Math.min(Math.max(0, this.attempts), RECONNECT_DELAYS.length - 1);
    return Math.max(this.override ?? 0, RECONNECT_DELAYS[idx]);
  }

  /** 是否已超过最大重连次数 */
  isExhausted() {
    return this.attempts > MAX_RECONNECT_ATTEMPTS;
  }

  /**
   * 记录一次断开，推进状态。
   * @param {object} p
   * @param {number} p.aliveMs 本次连接存活时长
   * @param {number|null} p.delayOverride 关闭码指定的强制延迟
   * @returns {number} 下一次重连的等待时长
   */
  recordClose({ aliveMs, delayOverride = null }) {
    if (aliveMs < QUICK_DISCONNECT_THRESHOLD_MS) {
      this.quickDisconnects += 1;
    } else {
      this.quickDisconnects = 0;
    }

    this.override = delayOverride;

    // 连续快速断开：插入一次长冷却（对齐官方 MAX_QUICK_DISCONNECT_COUNT）
    if (this.quickDisconnects >= MAX_QUICK_DISCONNECTS) {
      this.override = Math.max(this.override ?? 0, 10000);
      this.quickDisconnects = 0;
    }

    // 稳定在线足够久 → 梯度复位；否则推进
    if (aliveMs >= STABLE_RESET_MS && !delayOverride) {
      this.attempts = 0;
    } else {
      this.attempts += 1;
    }

    return this.nextDelayMs();
  }

  /** 取走并清空本次的强制延迟（延迟只作用于紧接着的一次重连） */
  consumeDelay() {
    const delay = this.nextDelayMs();
    this.override = null;
    return delay;
  }
}

/** 关闭码 → 处置策略（对齐官方 reconnect.ts 语义） */
export function classifyClose(code) {
  if (code === 4004) return { refreshToken: true, clearSession: true, refreshUrl: true }; // 鉴权失败
  if (code === 4006) return { clearSession: true }; // session 无效
  if (code === 4007) return { clearSession: true }; // seq 越界
  if (code === 4008) return { delay: RATE_LIMIT_DELAY }; // 限流
  if (code === 4009) return { clearSession: true }; // 会话超时
  if (code === 4901 || code === 4902) return { delay: 5000 }; // 内部错误：官方要求 5s 后重连
  if (code >= 4900 && code <= 4913) return {}; // 其他服务端错误，正常退避
  if (code === 4914 || code === 4915) return { fatal: true }; // intents 越权，重连无用
  return {};
}
