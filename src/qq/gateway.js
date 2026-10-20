/**
 * QQ WebSocket 网关客户端。
 *
 * 协议完全对齐官方 SDK（gateway-connection.ts / constants.ts）：
 *   op 10 HELLO      → 拿 heartbeat_interval，发 IDENTIFY 或 RESUME
 *   op  2 IDENTIFY   → { token: "QQBot <accessToken>", intents, shard:[0,1] }
 *   op  6 RESUME     → { token, session_id, seq }
 *   op  1 HEARTBEAT  → { op:1, d: 最新 seq }
 *   op 11 HEARTBEAT_ACK
 *   op  0 DISPATCH   → READY / RESUMED / 各类消息事件
 *   op  7 RECONNECT / op 9 INVALID_SESSION → 重连
 *
 * 断线重连采用官方退避序列 [1s,2s,5s,10s,30s,60s]，并区分关闭码：
 *   4004 鉴权失败 → 清 token 缓存 + 清会话，重新 IDENTIFY
 *   4006/4007/4008/4009 → 清会话重连 / 限流等待
 */

import fs from "node:fs";
import path from "node:path";
import {
  ReconnectPolicy,
  RECONNECT_DELAYS,
  QUICK_DISCONNECT_THRESHOLD_MS,
  STABLE_RESET_MS,
  RATE_LIMIT_DELAY,
  classifyClose,
} from "./reconnect-policy.js";

export { RECONNECT_DELAYS, classifyClose } from "./reconnect-policy.js";

export const GatewayOp = {
  DISPATCH: 0,
  HEARTBEAT: 1,
  IDENTIFY: 2,
  RESUME: 6,
  RECONNECT: 7,
  INVALID_SESSION: 9,
  HELLO: 10,
  HEARTBEAT_ACK: 11,
};

export const GatewayEvent = {
  READY: "READY",
  RESUMED: "RESUMED",
  C2C_MESSAGE_CREATE: "C2C_MESSAGE_CREATE",
  AT_MESSAGE_CREATE: "AT_MESSAGE_CREATE",
  DIRECT_MESSAGE_CREATE: "DIRECT_MESSAGE_CREATE",
  GROUP_AT_MESSAGE_CREATE: "GROUP_AT_MESSAGE_CREATE",
  GROUP_MESSAGE_CREATE: "GROUP_MESSAGE_CREATE",
  INTERACTION_CREATE: "INTERACTION_CREATE",
};

/** 兼容 Node 内建 WebSocket（22.4+）与可选的 ws 包 */
async function resolveWebSocketImpl() {
  if (typeof globalThis.WebSocket === "function") {
    return { Ctor: globalThis.WebSocket, kind: "global" };
  }
  try {
    const mod = await import("ws");
    return { Ctor: mod.default ?? mod.WebSocket, kind: "ws" };
  } catch {
    throw new Error(
      "当前 Node 没有内建 WebSocket，且未安装 ws 包。请升级到 Node >= 22.4，或执行 npm i ws",
    );
  }
}

function isOpen(kind, ws) {
  if (!ws) return false;
  if (kind === "global") return ws.readyState === 1; // WebSocket.OPEN
  return ws.readyState === 1;
}

function wsSend(kind, ws, obj) {
  const text = typeof obj === "string" ? obj : JSON.stringify(obj);
  if (kind === "global") {
    ws.send(text);
    return true;
  }
  // ws 包的 send 支持回调，避免未处理异常
  ws.send(text, (err) => {
    if (err) void err;
  });
  return true;
}

export class QQGateway {
  /**
   * @param {object} opts
   * @param {() => Promise<string>} opts.getAccessToken
   * @param {() => Promise<string>} opts.getGatewayUrl
   * @param {number} opts.intents
   * @param {object} [opts.logger]
   * @param {() => void} [opts.onInvalidToken] 收到 4004 时清 token 缓存
   * @param {(msg: object) => void|Promise<void>} opts.onMessage 归一化后的消息
   * @param {(type: string, data: unknown) => void} [opts.onRawEvent]
   * @param {(data: unknown) => void} [opts.onReady]
   * @param {(err: Error) => void} [opts.onError]
   * @param {string} [opts.sessionFile] 会话持久化路径
   * @param {(ms: number) => Promise<void>} [opts.sleep] 便于测试注入
   */
  constructor(opts) {
    this.opts = opts;
    this.logger = opts.logger;
    this.intents = opts.intents;
    this.sessionFile = opts.sessionFile;

    this.ws = null;
    this.kind = "global";
    this.heartbeatTimer = null;
    this.sessionId = null;
    this.lastSeq = null;
    this.stopped = false;
    /** 重连策略（退避梯度、快速断开计数、强制延迟）——纯逻辑，见 reconnect-policy.js */
    this.policy = new ReconnectPolicy({ log: this.logger });
    this.connectedAt = 0;
    this._connecting = false;

    // 网关地址缓存（长期有效，避免每次重连都请求 /gateway 触发限流）
    this._gatewayUrl = null;
    this._forceRefreshUrl = false;
    this._urlFetchedAt = 0;

    this.stats = { connects: 0, identifies: 0, resumes: 0, heartbeats: 0, events: 0, errors: 0 };
    this._sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));

    this.#loadSession();
  }

  #loadSession() {
    if (!this.sessionFile) return;
    try {
      const raw = fs.readFileSync(this.sessionFile, "utf8");
      const data = JSON.parse(raw);
      if (data?.sessionId) {
        this.sessionId = data.sessionId;
        this.lastSeq = Number.isFinite(data.lastSeq) ? data.lastSeq : null;
        this.logger?.info?.(`已恢复会话 session_id=${String(data.sessionId).slice(0, 8)}…`);
      }
    } catch {
      /* 首次运行没有会话文件，正常 */
    }
  }

  #saveSession() {
    if (!this.sessionFile || !this.sessionId) return;
    try {
      fs.mkdirSync(path.dirname(this.sessionFile), { recursive: true });
      fs.writeFileSync(
        this.sessionFile,
        JSON.stringify({ sessionId: this.sessionId, lastSeq: this.lastSeq }, null, 2),
        "utf8",
      );
    } catch (err) {
      this.logger?.warn?.(`会话持久化失败：${err?.message}`);
    }
  }

  #clearSession() {
    this.sessionId = null;
    this.lastSeq = null;
    try {
      if (this.sessionFile && fs.existsSync(this.sessionFile)) fs.rmSync(this.sessionFile);
    } catch {
      /* 忽略 */
    }
  }

  /** 启动连接（主循环）。stop() 之前会一直保持在线。 */
  async start() {
    const impl = await resolveWebSocketImpl();
    this.WebSocketCtor = impl.Ctor;
    this.kind = impl.kind;
    this.logger?.debug?.(`WebSocket 实现：${impl.kind}`);

    while (!this.stopped) {
      const startedAt = Date.now();
      const result = await this.#runOnce();
      const alive = Date.now() - startedAt;
      if (this.stopped) break;
      if (result === "reset") {
        // 稳定在线后正常结束：梯度复位，重新开始
        this.policy.attempts = 0;
        continue;
      }

      const delay = this.policy.consumeDelay();
      if (this.policy.isExhausted()) {
        this.logger?.error?.("达到最大重连次数，放弃");
        this.opts.onError?.(new Error("达到最大重连次数"));
        break;
      }
      this.logger?.debug?.(`第 ${this.policy.attempts} 次重连，等待 ${delay}ms`);
      await this._sleep(delay);
    }
  }

  /** 单次连接生命周期；返回 'connected' | 'failed' */
  async #runOnce() {
    if (this._connecting) return "connected";
    this._connecting = true;

    /** 关闭码表示不可恢复（如 intents 越权）时置位，用于停止重连 */
    let fatal = false;

    try {
      const accessToken = await this.opts.getAccessToken();

      // 网关地址是长期有效的：缓存复用，避免每次重连都打 /gateway 触发限流。
      // 只有鉴权失败（4004）时才强制刷新。
      if (!this._gatewayUrl || this._forceRefreshUrl) {
        this._gatewayUrl = await this.#resolveGatewayUrl();
        this._forceRefreshUrl = false;
        this._urlFetchedAt = Date.now();
      }
      const url = this._gatewayUrl;
      this.logger?.info?.(`连接网关：${url}`);

      const ws = new this.WebSocketCtor(url);
      this.ws = ws;
      this.connectedAt = Date.now();

      const opened = await new Promise((resolve) => {
        let settled = false;
        const onOpen = () => {
          if (!settled) {
            settled = true;
            resolve(true);
          }
        };
        const onError = (err) => {
          if (!settled) {
            settled = true;
            this.logger?.warn?.(`连接失败：${err?.message ?? err}`);
            resolve(false);
          }
        };
        if (this.kind === "global") {
          ws.addEventListener("open", onOpen, { once: true });
          ws.addEventListener("error", onError, { once: true });
        } else {
          ws.once("open", onOpen);
          ws.once("error", onError);
        }
      });

      if (!opened) {
        this.#safeClose();
        return "failed";
      }

      this.stats.connects += 1;
      this.logger?.info?.("WebSocket 已连接");
      this._connecting = false;

      // 等这次连接结束（close / error）
      await new Promise((resolve) => {
        let closeHandled = false;
        const onMessage = async (ev) => {
          const raw = this.kind === "global" ? ev.data : ev;
          try {
            await this.#handlePayload(String(raw), accessToken);
          } catch (err) {
            this.stats.errors += 1;
            this.logger?.warn?.(`处理消息出错：${err?.message}`);
          }
        };
        const onError = (err) => {
          this.stats.errors += 1;
          this.logger?.warn?.(`WebSocket 错误：${err?.message ?? err}`);
          this.opts.onError?.(err instanceof Error ? err : new Error(String(err)));
        };
        const onClose = (ev) => {
          // 只处理第一次 close：同一个 socket 的重复事件不应二次改变状态
          if (closeHandled) return;
          closeHandled = true;
          // 整个关闭处理必须"绝不抛异常"：一旦抛了，退避/清理/会话处理全被跳过，
          // 连接会陷入半坏状态（真实事故：重构漏了 fatal 声明导致这里每次抛错）。
          try {
            const code = this.kind === "global" ? ev.code : ev;
            const elapsed = Date.now() - this.connectedAt;
            const action = classifyClose(code);

            if (action.refreshToken) {
              this.logger?.warn?.(`关闭码 ${code}：鉴权失败，清理 token、会话与网关地址`);
              this.opts.onInvalidToken?.();
            }
            if (action.clearSession) this.#clearSession();
            if (action.refreshUrl) this._forceRefreshUrl = true;

            // 交给策略状态机推进退避梯度（纯逻辑，已有单元测试覆盖）
            const nextDelay = this.policy.recordClose({
              aliveMs: elapsed,
              delayOverride: action.delay ?? null,
            });
            this.logger?.info?.(
              `WebSocket 关闭 code=${code} 存活 ${Math.round(elapsed / 1000)}s，将等待 ${nextDelay / 1000}s 重连`,
            );

            if (action.fatal) {
              fatal = true;
              this.logger?.error?.(`关闭码 ${code}：intents 越权或不可恢复，停止重连`);
            }
          } catch (err) {
            this.stats.errors += 1;
            this.logger?.error?.(`关闭处理异常（已兜住）：${err?.message ?? err}`);
          } finally {
            resolve();
          }
        };

        if (this.kind === "global") {
          ws.addEventListener("message", onMessage);
          ws.addEventListener("error", onError);
          ws.addEventListener("close", onClose);
        } else {
          ws.on("message", onMessage);
          ws.on("error", onError);
          ws.on("close", onClose);
        }
      });

      this.#cleanup();
      if (fatal) {
        this.stopped = true;
        return "failed";
      }
      // 稳定在线足够久后断开：通知主循环复位退避梯度
      if (Date.now() - this.connectedAt >= STABLE_RESET_MS) return "reset";
      return "connected";
    } catch (err) {
      this.logger?.error?.(`连接异常：${err?.message}`);
      this.opts.onError?.(err instanceof Error ? err : new Error(String(err)));
      this.#cleanup();
      // 429 限流：网关地址可能也拿不到，加长冷却并强制下次重新取地址
      if (err?.httpStatus === 429 || /频率限制|限流|Too many requests|100001/.test(String(err?.message))) {
        this.policy.override = RATE_LIMIT_DELAY;
        this._forceRefreshUrl = true;
        this.logger?.warn?.(`触发限流，冷却 ${RATE_LIMIT_DELAY / 1000}s 后再试`);
      }
      return "failed";
    } finally {
      this._connecting = false;
    }
  }

  /** 取网关地址（带一次重试，避免瞬时抖动导致重连风暴） */
  async #resolveGatewayUrl() {
    try {
      return await this.opts.getGatewayUrl();
    } catch (err) {
      await this._sleep(1500);
      return this.opts.getGatewayUrl();
    }
  }

  async #handlePayload(raw, accessToken) {
    let payload;
    try {
      payload = JSON.parse(raw);
    } catch {
      this.logger?.warn?.("收到非 JSON 网关消息，忽略");
      return;
    }
    const { op, d, s, t } = payload;
    if (Number.isFinite(s)) {
      this.lastSeq = s;
      this.#saveSession();
    }

    // 诊断开关：把网关发来的每条事件原样打出来。
    // 排查「群里 @ 了为什么没反应」时，它能区分「事件没送到」和「送到了但没识别」。
    if (this.opts.debugRawEvents && op === GatewayOp.DISPATCH) {
      let brief;
      try {
        brief = JSON.stringify(d).slice(0, 400);
      } catch {
        brief = "(无法序列化)";
      }
      this.logger?.info?.(`[原始事件] t=${t} s=${s} d=${brief}`);
    }

    switch (op) {
      case GatewayOp.HELLO: {
        const interval = Number(d?.heartbeat_interval) || 45000;
        if (this.sessionId && this.lastSeq !== null) {
          this.stats.resumes += 1;
          this.#send({
            op: GatewayOp.RESUME,
            d: { token: `QQBot ${accessToken}`, session_id: this.sessionId, seq: this.lastSeq },
          });
          this.logger?.debug?.("已发送 RESUME");
        } else {
          this.stats.identifies += 1;
          this.#send({
            op: GatewayOp.IDENTIFY,
            d: { token: `QQBot ${accessToken}`, intents: this.intents, shard: [0, 1] },
          });
          this.logger?.debug?.(`已发送 IDENTIFY intents=${this.intents}`);
        }
        this.#startHeartbeat(interval);
        break;
      }

      case GatewayOp.DISPATCH: {
        this.stats.events += 1;
        if (t === GatewayEvent.READY) {
          this.sessionId = d?.session_id ?? null;
          this.#saveSession();
          // 注意：这里**不**复位退避梯度。
          // 「能连上但反复被踢」时若在 READY 就复位，退避会永远停在 1s 形成重连风暴。
          // 只有稳定在线超过 STABLE_RESET_MS 才复位（见 start() 与 #runOnce 返回值）。
          this.logger?.info?.(`READY：机器人 ${d?.user?.username ?? "?"} 已上线`);
          this.opts.onReady?.(d);
          break;
        }
        if (t === GatewayEvent.RESUMED) {
          this.logger?.info?.("RESUMED：会话已恢复");
          break;
        }
        const normalized = normalizeEvent(t, d);
        if (normalized) {
          await this.opts.onMessage(normalized);
        } else {
          this.opts.onRawEvent?.(t, d);
        }
        break;
      }

      case GatewayOp.HEARTBEAT_ACK:
        break;

      case GatewayOp.RECONNECT:
        this.logger?.warn?.("服务端要求重连");
        this.#safeClose();
        break;

      case GatewayOp.INVALID_SESSION: {
        if (!d) this.#clearSession();
        this.logger?.warn?.(`INVALID_SESSION（可恢复=${Boolean(d)}）`);
        this.#safeClose();
        break;
      }

      default:
        this.logger?.debug?.(`未处理的 op=${op}`);
    }
  }

  #startHeartbeat(interval) {
    this.#stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (isOpen(this.kind, this.ws)) {
        this.stats.heartbeats += 1;
        this.#send({ op: GatewayOp.HEARTBEAT, d: this.lastSeq });
      }
    }, interval);
    // 不要让心跳定时器拖住进程退出
    this.heartbeatTimer?.unref?.();
  }

  #stopHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  #send(obj) {
    if (!isOpen(this.kind, this.ws)) return false;
    try {
      return wsSend(this.kind, this.ws, obj);
    } catch (err) {
      this.logger?.warn?.(`发送失败：${err?.message}`);
      return false;
    }
  }

  #safeClose() {
    try {
      if (this.ws && this.ws.readyState <= 1) this.ws.close();
    } catch {
      /* 忽略 */
    }
  }

  #cleanup() {
    this.#stopHeartbeat();
    this.ws = null;
  }

  /** 停止并释放资源 */
  stop() {
    this.stopped = true;
    this.#stopHeartbeat();
    this.#safeClose();
  }
}

/**
 * 把网关事件归一化成统一消息结构。
 * 返回 null 表示该事件不是「需要处理」的消息。
 */
export function normalizeEvent(type, d) {
  switch (type) {
    case GatewayEvent.C2C_MESSAGE_CREATE:
      return {
        kind: "c2c",
        scope: "c2c",
        rawEventType: type,
        senderId: d?.author?.user_openid,
        senderName: d?.author?.username,
        content: d?.content ?? "",
        // 图片/表情包/语音走 attachments，content 会是空串，必须一并传下去
        attachments: d?.attachments ?? [],
        messageType: d?.message_type,
        messageId: d?.id,
        timestamp: d?.timestamp,
        targetId: d?.author?.user_openid,
      };
    case GatewayEvent.GROUP_AT_MESSAGE_CREATE:
    case GatewayEvent.GROUP_MESSAGE_CREATE:
      return {
        kind: "group",
        scope: "group",
        rawEventType: type,
        senderId: d?.author?.member_openid,
        senderName: d?.author?.username,
        senderIsBot: Boolean(d?.author?.bot),
        // 群成员身份：owner / admin / member；平台未给时为 null
        memberRole: d?.author?.member_role ?? null,
        content: d?.content ?? "",
        attachments: d?.attachments ?? [],
        messageType: d?.message_type,
        messageId: d?.id,
        timestamp: d?.timestamp,
        groupOpenid: d?.group_openid,
        targetId: d?.group_openid,
        mentions: d?.mentions,
      };
    case GatewayEvent.AT_MESSAGE_CREATE:
      return {
        kind: "guild",
        scope: "guild",
        rawEventType: type,
        senderId: d?.author?.id,
        senderName: d?.author?.username,
        content: d?.content ?? "",
        attachments: d?.attachments ?? [],
        messageId: d?.id,
        timestamp: d?.timestamp,
        channelId: d?.channel_id,
        guildId: d?.guild_id,
        targetId: d?.channel_id,
      };
    case GatewayEvent.DIRECT_MESSAGE_CREATE:
      return {
        kind: "dm",
        scope: "dm",
        rawEventType: type,
        senderId: d?.author?.id,
        senderName: d?.author?.username,
        content: d?.content ?? "",
        attachments: d?.attachments ?? [],
        messageId: d?.id,
        timestamp: d?.timestamp,
        guildId: d?.guild_id,
        targetId: d?.guild_id,
      };
    default:
      return null;
  }
}
