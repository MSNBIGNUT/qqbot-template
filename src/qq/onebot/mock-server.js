/**
 * mock-server.js —— 假的 OneBot v11 服务端（用于本地端到端测试）。
 *
 * 为什么必须有它：
 *   接小号要装 NapCat + 登录真实 QQ —— 一旦代码有问题，**影响的是真实账号**。
 *   有了这个假服务端，就能在**完全不碰 QQ** 的情况下跑通：
 *     收消息 → 引擎处理 → 回消息 → 发图片/语音 → 拿群列表/成员列表
 *   代码稳了再装 NapCat，那时只差填个地址。
 *
 * 实现要点：
 *   · 零依赖：用 node:http 做 HTTP 动作路由，手写极简 WebSocket 服务推送事件
 *     （只有 101 握手 + 文本帧编解码，够用就行）
 *   · 记录所有发出去的消息（sentMessages），测试直接断言
 *   · 提供 pushGroupMessage / pushPrivateMessage 主动推事件
 */
import crypto from 'node:crypto'
import http from 'node:http'

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

/** 编码一个服务端 → 客户端的 WebSocket 帧（不掩码） */
export function encodeWsFrame(payload) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8')
  const len = data.length
  let header
  if (len < 126) {
    header = Buffer.alloc(2)
    header[0] = 0x81 // FIN + text
    header[1] = len
  } else if (len < 65536) {
    header = Buffer.alloc(4)
    header[0] = 0x81
    header[1] = 126
    header.writeUInt16BE(len, 2)
  } else {
    header = Buffer.alloc(10)
    header[0] = 0x81
    header[1] = 127
    header.writeBigUInt64BE(BigInt(len), 2)
  }
  return Buffer.concat([header, data])
}

/**
 * 解码客户端 → 服务端的帧（客户端帧**必须**带掩码）。
 * 只处理文本/关闭/心跳，够 mock 用。
 * @returns {{opcode:number, payload:Buffer, consumed:number}|null}
 */
export function decodeWsFrame(buf) {
  if (!buf || buf.length < 2) return null
  const b0 = buf[0]
  const b1 = buf[1]
  const opcode = b0 & 0x0f
  const masked = (b1 & 0x80) !== 0
  let len = b1 & 0x7f
  let offset = 2
  if (len === 126) {
    if (buf.length < 4) return null
    len = buf.readUInt16BE(2)
    offset = 4
  } else if (len === 127) {
    if (buf.length < 10) return null
    len = Number(buf.readBigUInt64BE(2))
    offset = 10
  }
  let maskKey = null
  if (masked) {
    if (buf.length < offset + 4) return null
    maskKey = buf.subarray(offset, offset + 4)
    offset += 4
  }
  if (buf.length < offset + len) return null
  const payload = Buffer.from(buf.subarray(offset, offset + len))
  if (maskKey) {
    for (let i = 0; i < payload.length; i += 1) payload[i] ^= maskKey[i % 4]
  }
  return { opcode, payload, consumed: offset + len }
}

export class MockOneBotServer {
  /**
   * @param {object} [opts]
   * @param {number} [opts.port] 0 = 随机端口
   * @param {string} [opts.selfId] 假机器人的 QQ 号
   * @param {string[]} [opts.groups] 假群名（会生成 group_id = 1001, 1002…）
   * @param {object} [opts.logger]
   */
  constructor({ port = 0, selfId = '22222', groups = ['测试群', '第二个群'], logger = null } = {}) {
    this.selfId = String(selfId)
    this.logger = logger
    this.groups = groups.map((name, i) => ({
      group_id: 1001 + i,
      group_name: name,
      member_count: 3,
      max_member_count: 200,
    }))
    /** 群成员：groupId → [{user_id, nickname, card, role}] */
    this.members = new Map()
    for (const g of this.groups) {
      this.members.set(g.group_id, [
        { user_id: 11111, nickname: '张三', card: '小张', role: 'owner' },
        { user_id: 33333, nickname: '李四', card: '', role: 'member' },
        { user_id: 44444, nickname: '王五', card: '', role: 'admin' },
      ])
    }
    this.port = port
    this.server = null
    this.sockets = new Set()
    /** 所有通过 API 发出去的消息 */
    this.sentMessages = []
    /** 收到的 API 调用（用于断言） */
    this.apiCalls = []
    this._seq = 0
  }

  async start() {
    this.server = http.createServer((req, res) => this.#handleHttp(req, res))
    this.server.on('upgrade', (req, socket) => this.#handleUpgrade(req, socket))
    await new Promise((resolve, reject) => {
      this.server.once('error', reject)
      this.server.listen(this.port, '127.0.0.1', () => {
        this.port = this.server.address().port
        resolve()
      })
    })
    this.logger?.info?.(`Mock OneBot 已启动：http://127.0.0.1:${this.port}  ws://127.0.0.1:${this.port}/`)
    return this
  }

  async stop() {
    for (const s of this.sockets) {
      try {
        s.destroy()
      } catch {
        /* ignore */
      }
    }
    this.sockets.clear()
    if (this.server) {
      await new Promise((resolve) => this.server.close(resolve))
      this.server = null
    }
  }

  get httpUrl() {
    return `http://127.0.0.1:${this.port}`
  }

  get wsUrl() {
    return `ws://127.0.0.1:${this.port}/`
  }

  // ── WebSocket 握手 / 帧 ──────────────────────────────────

  #handleUpgrade(req, socket) {
    const key = req.headers['sec-websocket-key']
    if (!key) {
      socket.destroy()
      return
    }
    const accept = crypto
      .createHash('sha1')
      .update(key + WS_GUID)
      .digest('base64')
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    )
    this.sockets.add(socket)
    socket.on('data', (buf) => {
      const frame = decodeWsFrame(buf)
      if (!frame) return
      if (frame.opcode === 0x8) {
        // 客户端要关闭
        this.sockets.delete(socket)
        socket.end()
      }
      // 心跳（0x9）可以回一个 pong，但 mock 不要求
    })
    socket.on('close', () => this.sockets.delete(socket))
    socket.on('error', () => this.sockets.delete(socket))

    // 连上就发 lifecycle 事件（真 NapCat 也会发）
    this.#broadcast({
      post_type: 'meta_event',
      meta_event_type: 'lifecycle',
      sub_type: 'connect',
      self_id: Number(this.selfId),
      time: Math.floor(Date.now() / 1000),
    })
  }

  #broadcast(obj) {
    const frame = encodeWsFrame(JSON.stringify(obj))
    for (const s of this.sockets) {
      try {
        s.write(frame)
      } catch {
        /* ignore */
      }
    }
  }

  // ── HTTP 动作 ────────────────────────────────────────────

  async #handleHttp(req, res) {
    const url = new URL(req.url, 'http://localhost')
    const action = url.pathname.replace(/^\/+/, '')
    const chunks = []
    for await (const c of req) chunks.push(c)
    let params = {}
    try {
      params = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
    } catch {
      params = {}
    }
    if (req.method === 'GET' && !action) {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('mock onebot')
      return
    }
    this.apiCalls.push({ action, params, at: Date.now() })

    const ok = (data) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ status: 'ok', retcode: 0, data }))
    }
    const fail = (retcode, wording) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ status: 'failed', retcode, wording }))
    }

    switch (action) {
      case 'get_login_info':
        ok({ user_id: Number(this.selfId), nickname: '小号机器人' })
        return
      case 'get_group_list':
        ok(this.groups)
        return
      case 'get_group_info': {
        const g = this.groups.find((x) => x.group_id === Number(params.group_id))
        g ? ok(g) : fail(100, '群不存在')
        return
      }
      case 'get_group_member_list': {
        const list = this.members.get(Number(params.group_id))
        list ? ok(list) : fail(100, '群不存在')
        return
      }
      case 'get_stranger_info': {
        const hit = [...this.members.values()].flat().find((m) => m.user_id === Number(params.user_id))
        ok(hit ?? { user_id: Number(params.user_id), nickname: '' })
        return
      }
      case 'send_private_msg':
      case 'send_group_msg': {
        this._seq += 1
        this.sentMessages.push({
          seq: this._seq,
          action,
          scope: action === 'send_group_msg' ? 'group' : 'c2c',
          targetId: String(params.group_id ?? params.user_id ?? ''),
          message: params.message ?? [],
        })
        ok({ message_id: 9000 + this._seq })
        return
      }
      case 'send_msg': {
        this._seq += 1
        this.sentMessages.push({
          seq: this._seq,
          action,
          scope: params.message_type === 'group' ? 'group' : 'c2c',
          targetId: String(params.group_id ?? params.user_id ?? ''),
          message: params.message ?? [],
        })
        ok({ message_id: 9000 + this._seq })
        return
      }
      default:
        fail(1404, `未知动作 ${action}`)
    }
  }

  // ── 测试驱动：主动推事件 ─────────────────────────────────

  /** 推一条群消息 */
  pushGroupMessage({ groupId = 1001, userId = 11111, nickname = '张三', card = '', role = 'member', text = '你好', segments = null, messageId = null } = {}) {
    this._seq += 1
    const message = segments ?? [{ type: 'text', data: { text } }]
    const ev = {
      post_type: 'message',
      message_type: 'group',
      sub_type: 'normal',
      message_id: messageId ?? 5000 + this._seq,
      group_id: Number(groupId),
      user_id: Number(userId),
      self_id: Number(this.selfId),
      time: Math.floor(Date.now() / 1000),
      sender: { user_id: Number(userId), nickname, card, role },
      message,
      raw_message: text,
    }
    this.#broadcast(ev)
    return ev
  }

  /** 推一条私聊 */
  pushPrivateMessage({ userId = 11111, nickname = '张三', text = '你好', segments = null, messageId = null } = {}) {
    this._seq += 1
    const message = segments ?? [{ type: 'text', data: { text } }]
    const ev = {
      post_type: 'message',
      message_type: 'private',
      sub_type: 'friend',
      message_id: messageId ?? 6000 + this._seq,
      user_id: Number(userId),
      self_id: Number(this.selfId),
      time: Math.floor(Date.now() / 1000),
      sender: { user_id: Number(userId), nickname },
      message,
      raw_message: text,
    }
    this.#broadcast(ev)
    return ev
  }

  /** 等某条"发出去的消息"满足条件（测试用） */
  async waitForSent(predicate, timeoutMs = 5000) {
    const t0 = Date.now()
    while (Date.now() - t0 < timeoutMs) {
      const hit = this.sentMessages.find(predicate)
      if (hit) return hit
      await new Promise((r) => setTimeout(r, 30))
    }
    return null
  }
}
