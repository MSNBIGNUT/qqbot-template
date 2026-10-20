/**
 * api-adapter.js —— 让 OneBot 冒充官方的 QQApi。
 *
 * 关键设计：**engine 一行都不用改**。
 *   engine 现在调的是 `this.api.sendMessage / uploadMedia / sendMedia / ...`。
 *   这些是**官方 API 的语义**（先 upload 拿 file_info，再 sendMedia 发出去）。
 *   OneBot 没有"先上传后发送"这套 —— 图片/语音是**一段 base64 直接发**。
 *
 *   所以这一层做两件事：
 *     ① 把官方语义的方法名映射到 OneBot 动作
 *     ② `uploadMedia` 返回一个**票据对象**，`sendMedia` 拿票据真发出去
 *        （票据里就存着 base64 —— 不落盘、不跨进程，够用）
 *
 * 这样官方 / OneBot 两套协议可以**同一个 engine**跑，切换只改 main.js。
 */
import {
  encodeTextToSegments,
  encodeImageSegment,
  encodeRecordSegment,
} from './event.js'

export class OneBotApiAdapter {
  /**
   * @param {object} opts
   * @param {import('./client.js').OneBotClient} opts.client
   * @param {object} [opts.logger]
   */
  constructor({ client, logger = null } = {}) {
    this.client = client
    this.logger = logger
    /** 票据 id → { base64, kind, scope, targetId } */
    this._tickets = new Map()
    this._seq = 0
  }

  // ── 官方 API 的"拿 token / 网关地址"在这里没有意义，但 engine/main 可能调 ──
  async getAccessToken() {
    return 'onebot'
  }
  clearTokenCache() {}
  async getGatewayUrl() {
    return this.client.wsUrl
  }

  // ── 文本 ──────────────────────────────────────────────────

  /**
   * @param {'c2c'|'group'} scope
   * @param {string} targetId
   * @param {string} text
   */
  async sendMessage(scope, targetId, text, opts = {}) {
    void opts
    const segments = encodeTextToSegments(text)
    return scope === 'group'
      ? this.client.sendGroup(targetId, segments)
      : this.client.sendPrivate(targetId, segments)
  }

  /** 主动消息（OneBot 没有"主动/被动"之分，同一套接口） */
  async sendProactiveMessage(scope, targetId, text) {
    return this.sendMessage(scope, targetId, text)
  }

  // ── 富媒体：upload → 票据；sendMedia → 真发 ────────────────

  /**
   * 官方语义：先把二进制传上去，拿 file_info。
   * OneBot 语义：没有上传这一步，直接发。
   * 这里返回一个**票据**，真正发送推迟到 sendMedia。
   *
   * @param {string} fileDataBase64 不带 data: 前缀
   * @param {number} fileType 官方枚举：1=图片 3=语音（IMAGE_FILE_TYPE / VOICE_FILE_TYPE）
   */
  async uploadMedia(scope, targetId, fileDataBase64, fileType, { timeoutMs } = {}) {
    void timeoutMs
    const base64 = String(fileDataBase64 ?? '')
    if (!base64) throw new Error('uploadMedia：内容为空')
    this._seq += 1
    const ticketId = `ob_${this._seq}`
    // 官方枚举：1 图片 / 2 视频 / 3 语音 / 4 文件
    const kind = Number(fileType) === 3 ? 'voice' : Number(fileType) === 2 ? 'video' : 'image'
    this._tickets.set(ticketId, { base64, kind, scope, targetId })
    // 返回结构对齐官方 file_info 的用法：调用方只把它原样传给 sendMedia
    return { file_info: ticketId, __onebot_ticket: ticketId }
  }

  /**
   * 把 uploadMedia 拿到的票据真正发出去。
   * @param {object} fileInfo uploadMedia 的返回值
   */
  async sendMedia(scope, targetId, fileInfo, { msgId, msgSeq } = {}) {
    void msgId
    void msgSeq
    const ticketId = fileInfo?.__onebot_ticket ?? fileInfo?.file_info ?? ''
    const t = this._tickets.get(String(ticketId))
    if (!t) throw new Error(`sendMedia：找不到票据 ${ticketId}（可能已经发过或没上传成功）`)
    this._tickets.delete(String(ticketId))

    const seg =
      t.kind === 'voice'
        ? encodeRecordSegment(t.base64)
        : t.kind === 'video'
          ? { type: 'video', data: { file: `base64://${t.base64}` } }
          : encodeImageSegment(t.base64)

    return scope === 'group'
      ? this.client.sendGroup(targetId, [seg])
      : this.client.sendPrivate(targetId, [seg])
  }

  /** 官方：上传单聊文件 */
  async uploadC2CFile(openid, fileDataBase64, fileType, opts = {}) {
    return this.uploadMedia('c2c', openid, fileDataBase64, fileType, opts)
  }

  /** 官方：发单聊语音 */
  async sendC2CVoice(openid, fileInfo, opts = {}) {
    return this.sendMedia('c2c', openid, fileInfo, opts)
  }

  // ── 群成员（官方是 11253 无权限，OneBot 直接给）──────────

  /**
   * @returns {Promise<Array<{ member_openid: string, username: string, member_role: string }>>}
   *   形状对齐官方 getGroupMembers 的返回，engine 不用改。
   */
  async getGroupMembers(groupOpenid, { maxPages } = {}) {
    void maxPages
    const list = await this.client.getGroupMemberList(groupOpenid)
    return (list ?? []).map((m) => ({
      member_openid: String(m?.user_id ?? ''),
      username: String(m?.card || m?.nickname || ''),
      member_role: String(m?.role ?? 'member'),
    }))
  }

  async getGroupMember(groupOpenid, memberOpenid) {
    const all = await this.getGroupMembers(groupOpenid)
    return all.find((m) => m.member_openid === String(memberOpenid)) ?? null
  }

  // ── 额外的：OneBot 独有能力（官方拿不到）────────────────

  /** 群列表（带真群名） */
  async getGroupList() {
    return this.client.getGroupList()
  }

  /** 群信息（含群名、人数） */
  async getGroupInfo(groupId) {
    return this.client.getGroupInfo(groupId)
  }
}
