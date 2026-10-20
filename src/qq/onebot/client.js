/**
 * client.js —— OneBot v11 客户端（NapCat / Lagrange 都兼容）。
 *
 * 分两条通道（标准 OneBot 部署）：
 *   · **WS** 收事件（消息、戳一戳、群成员变动…）
 *   · **HTTP** 发动作（发消息、拿群列表、拿成员列表…）
 * 也可以用**反向 WS**（由 NapCat 连我们），但这里只做**正向**：
 * 我们主动连 NapCat 的 WS 地址 —— 配置最简单，也让"谁是服务端"没有歧义。
 *
 * 零依赖：Node 22.4+ 内建 WebSocket（package.json 的 engines 已经要求 >=22.4）。
 *
 * 断线：指数退避重连（1s → 2s → 4s … 封顶 30s），带抖动，避免雪崩。
 */
import { normalizeOneBotEvent, encodeTextToSegments, encodeImageSegment, encodeRecordSegment } from './event.js'

const DEFAULT_TIMEOUT_MS = 15_000
const RECONNECT_BASE_MS = 1_000
const RECONNECT_MAX_MS = 30_000

/** HTTP 动作失败时抛这个，带上 OneBot 的 retcode */
export class OneBotApiError extends Error {
  constructor(message, { action = '', retcode = undefined, status = 0 } = {}) {
    super(message)
    this.name = 'OneBotApiError'
    this.action = action
    this.retcode = retcode
    this.status = status
  }
}

export class OneBotClient {
  /**
   * @param {object} opts
   * @param {string} opts.wsUrl   例：ws://127.0.0.1:3001
   * @param {string} [opts.httpUrl] 例：http://127.0.0.1:3000
   * @param {string} [opts.token]  access_token（没设就不带）
   * @param {string[]} [opts.selfIds] 机器人自己的 QQ 号（用于识别/过滤自己发的消息）
   * @param {object} [opts.logger]
   * @param {Function} [opts.fetchImpl]
   * @param {Function} [opts.WebSocketImpl]
   */
  constructor({
    wsUrl,
    httpUrl = '',
    token = '',
    selfIds = [],
    logger = null,
    fetchImpl = fetch,
    WebSocketImpl = globalThis.WebSocket,
  } = {}) {
    this.wsUrl = String(wsUrl ?? '').trim()
    this.httpUrl = String(httpUrl ?? '').trim().replace(/\/+$/, '')
    this.token = String(token ?? '').trim()
    this.selfIds = (selfIds ?? []).filter(Boolean).map(String)
    this.logger = logger
    this.fetchImpl = fetchImpl
    this.WebSocketImpl = WebSocketImpl

    this.ws = null
    this.running = false
    this.connected = false
    this.attempt = 0
    this.reconnectTimer = null
    this.handlers = { message: [], ready: [], disconnect: [], error: [] }
    /** 已就绪的 promise（首次连上时 resolve） */
    this.readyPromise = null
    this._resolveReady = null
    this.stats = { received: 0, sent: 0, apiErrors: 0, reconnects: 0 }
  }

  // ── 生命周期 ─────────────────────────────────────────────

  /** 开始连接（不会等连上就返回；要等就 await ready()） */
  start() {
    if (this.running) return
    if (!this.wsUrl) throw new Error('OneBot wsUrl 是空的（检查 ONEBOT_WS_URL）')
    if (typeof this.WebSocketImpl !== 'function') {
      throw new Error('这个 Node 没有内置 WebSocket，需要 22.4+')
    }
    this.running = true
    this.readyPromise = new Promise((resolve) => {
      this._resolveReady = resolve
    })
    this.#connect()
  }

  /** 等首次连上（带超时） */
  async ready(timeoutMs = 20_000) {
    if (this.connected) return true
    if (!this.readyPromise) return false
    return Promise.race([
      this.readyPromise,
      new Promise((resolve) => setTimeout(() => resolve(false), timeoutMs)),
    ])
  }

  stop() {
    this.running = false
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    try {
      this.ws?.close()
    } catch {
      /* ignore */
    }
    this.ws = null
    this.connected = false
  }

  on(event, handler) {
    if (this.handlers[event]) this.handlers[event].push(handler)
    return () => {
      const arr = this.handlers[event]
      const i = arr.indexOf(handler)
      if (i >= 0) arr.splice(i, 1)
    }
  }

  #emit(event, ...args) {
    for (const h of this.handlers[event] ?? []) {
      try {
        h(...args)
      } catch (err) {
        this.logger?.warn?.(`OneBot 事件处理器出错（${event}）：${err?.message ?? err}`)
      }
    }
  }

  #connect() {
    if (!this.running) return
    const url = this.token
      ? `${this.wsUrl}${this.wsUrl.includes('?') ? '&' : '?'}access_token=${encodeURIComponent(this.token)}`
      : this.wsUrl

    let ws
    try {
      ws = new this.WebSocketImpl(url)
    } catch (err) {
      this.logger?.warn?.(`OneBot WS 创建失败：${err?.message ?? err}`)
      this.#scheduleReconnect()
      return
    }
    this.ws = ws

    ws.addEventListener('open', () => {
      this.connected = true
      this.attempt = 0
      this.logger?.info?.(`OneBot 已连上：${this.wsUrl}`)
      this.#emit('ready')
      this._resolveReady?.(true)
      this._resolveReady = null
    })

    ws.addEventListener('message', (ev) => {
      let data
      try {
        data = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data))
      } catch {
        return
      }
      this.#handlePayload(data)
    })

    ws.addEventListener('close', (ev) => {
      const wasConnected = this.connected
      this.connected = false
      if (wasConnected) {
        this.logger?.warn?.(`OneBot 连接断开（code=${ev?.code ?? '?'}）`)
        this.#emit('disconnect', ev)
      }
      this.#scheduleReconnect()
    })

    ws.addEventListener('error', () => {
      // 具体错误信息 ws 不给，close 会跟着来；这里只记一笔避免刷屏
      this.logger?.debug?.('OneBot WS 出错（详情见 close）')
    })
  }

  #scheduleReconnect() {
    if (!this.running || this.reconnectTimer) return
    this.attempt += 1
    this.stats.reconnects += 1
    const base = Math.min(RECONNECT_BASE_MS * 2 ** (this.attempt - 1), RECONNECT_MAX_MS)
    // 抖动 ±20%，避免多个实例同时重连撞在一起
    const delay = Math.round(base * (0.8 + Math.random() * 0.4))
    this.logger?.info?.(`OneBot ${delay}ms 后重连（第 ${this.attempt} 次）`)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.#connect()
    }, delay)
  }

  #handlePayload(data) {
    // 动作回执（有 echo）——我们目前全走 HTTP，理论上不会来，忽略即可
    if (data?.post_type === undefined) return

    if (data.post_type === 'meta_event') {
      // 心跳/生命周期：只用来确认活着
      if (data.meta_event_type === 'lifecycle' && data.sub_type === 'connect') {
        this.logger?.info?.(`OneBot 生命周期：已连接 self_id=${data.self_id ?? '?'}`)
        if (data.self_id && !this.selfIds.includes(String(data.self_id))) {
          this.selfIds.push(String(data.self_id))
        }
      }
      return
    }

    if (data.post_type === 'message') {
      this.stats.received += 1
      const msg = normalizeOneBotEvent(data, { selfIds: this.selfIds })
      if (msg) this.#emit('message', msg, data)
      return
    }
    // notice / request 等暂不处理
  }

  // ── 动作（HTTP） ─────────────────────────────────────────

  /**
   * 调一个 OneBot 动作。
   * @param {string} action 例：send_group_msg
   * @param {object} params
   */
  async call(action, params = {}, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    if (!this.httpUrl) {
      throw new OneBotApiError(`没配 ONEBOT_HTTP_URL，发不了 ${action}`, { action })
    }
    const url = `${this.httpUrl}/${action}`
    const headers = { 'content-type': 'application/json' }
    if (this.token) headers.authorization = `Bearer ${this.token}`

    let res
    try {
      res = await this.fetchImpl(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(params),
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (err) {
      this.stats.apiErrors += 1
      throw new OneBotApiError(`调用 ${action} 失败：${err?.message ?? err}`, { action })
    }
    if (!res.ok) {
      this.stats.apiErrors += 1
      throw new OneBotApiError(`调用 ${action} 返回 HTTP ${res.status}`, {
        action,
        status: res.status,
      })
    }
    let body
    try {
      body = await res.json()
    } catch {
      this.stats.apiErrors += 1
      throw new OneBotApiError(`调用 ${action} 的响应不是 JSON`, { action, status: res.status })
    }
    // OneBot 的约定：status=ok / retcode=0 才算成功
    if (body?.status === 'failed' || (body?.retcode !== undefined && body.retcode !== 0)) {
      this.stats.apiErrors += 1
      throw new OneBotApiError(
        `调用 ${action} 失败：retcode=${body?.retcode ?? '?'} ${body?.wording ?? body?.message ?? ''}`.trim(),
        { action, retcode: body?.retcode, status: res.status },
      )
    }
    return body?.data ?? body
  }

  // ── 发消息 ────────────────────────────────────────────────

  async sendPrivate(userId, segments) {
    const r = await this.call('send_private_msg', {
      user_id: Number(userId),
      message: segments,
    })
    this.stats.sent += 1
    return r
  }

  async sendGroup(groupId, segments) {
    const r = await this.call('send_group_msg', {
      group_id: Number(groupId),
      message: segments,
    })
    this.stats.sent += 1
    return r
  }

  /** 按 scope 发纯文本（内部会转成段数组，`<@qq>` 变 at 段） */
  async sendText(scope, targetId, text) {
    const segments = encodeTextToSegments(text)
    return scope === 'group' ? this.sendGroup(targetId, segments) : this.sendPrivate(targetId, segments)
  }

  /** 发图片（base64，不带 data: 前缀） */
  async sendImage(scope, targetId, base64) {
    const segments = [...encodeTextToSegments(''), encodeImageSegment(base64)]
    return scope === 'group' ? this.sendGroup(targetId, segments) : this.sendPrivate(targetId, segments)
  }

  /** 发语音（SILK base64） */
  async sendVoice(scope, targetId, base64) {
    const segments = [encodeRecordSegment(base64)]
    return scope === 'group' ? this.sendGroup(targetId, segments) : this.sendPrivate(targetId, segments)
  }

  // ── 信息查询（这些是接小号白捡的能力）────────────────────

  /** 群列表：[{ group_id, group_name, member_count, max_member_count }] */
  async getGroupList() {
    const data = await this.call('get_group_list', {})
    return Array.isArray(data) ? data : []
  }

  /** 群成员：[{ user_id, nickname, card, role, ... }] —— 官方 API 拿不到这个 */
  async getGroupMemberList(groupId) {
    const data = await this.call('get_group_member_list', { group_id: Number(groupId) })
    return Array.isArray(data) ? data : []
  }

  /** 群信息：[{ group_id, group_name, member_count }] */
  async getGroupInfo(groupId) {
    return this.call('get_group_info', { group_id: Number(groupId) })
  }

  /** 登录号信息（拿到 self_id） */
  async getLoginInfo() {
    return this.call('get_login_info', {})
  }

  /** 陌生人信息（拿昵称） */
  async getStrangerInfo(userId) {
    return this.call('get_stranger_info', { user_id: Number(userId) })
  }
}
