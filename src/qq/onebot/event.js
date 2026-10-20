/**
 * event.js —— OneBot v11 事件 → 春禾内部消息结构。
 *
 * 为什么要这一层：
 *   现在 engine 吃的是**官方机器人 API** 的形状（`d.author.member_openid`、
 *   `d.group_openid`、`attachments[]`…）。接小号走 **OneBot v11**，字段完全不同
 *   （`user_id`、`group_id`、`message[]` 段数组）。这一层负责把 OneBot 事件
 *   翻译成 engine **已经认识**的形状 —— 这样 engine / persona / 所有记忆与技能
 *   一行都不用改。
 *
 * 纯函数，不碰网络、不碰磁盘，便于单测。
 *
 * OneBot v11 消息事件样子（节选）：
 *   {
 *     post_type: "message",
 *     message_type: "group" | "private",
 *     message_id: 12345,
 *     group_id: 987654,                    // 仅群
 *     user_id: 11111,
 *     sender: { nickname: "张三", card: "群名片", role: "owner|admin|member" },
 *     message: [
 *       { type: "text",  data: { text: "你好" } },
 *       { type: "image", data: { file: "...", url: "http://..." } },
 *       { type: "at",    data: { qq: "11111" } },
 *       { type: "record",data: { file: "...", url: "..." } },
 *     ],
 *     raw_message: "你好",
 *     time: 1700000000,
 *     self_id: 22222,
 *   }
 */

/** OneBot 的 message 段类型 → 春禾的 contentType */
const SEG_TO_CONTENT_TYPE = {
  image: 'image/jpeg',
  face: 'image/jpeg', // 表情包也是图
  mface: 'image/jpeg', // 商城表情包
  record: 'voice/silk',
  video: 'video/mp4',
  file: 'file',
}

/**
 * 把 OneBot 的 `message` 段数组拆成两部分：
 *   · text        —— 拼好的纯文本（at 段变成 `<@qq>`，方便复用已有的 @ 解析）
 *   · attachments —— 图片/语音/文件，形状对齐官方 API 的 attachments[]
 *
 * @param {Array} segments
 * @returns {{text:string, attachments:Array, mentions:Array, atMe:boolean}}
 */
export function parseSegments(segments, { selfId } = {}) {
  const attachments = []
  const mentions = []
  let text = ''
  let atMe = false
  const list = Array.isArray(segments) ? segments : []

  for (const seg of list) {
    const type = String(seg?.type ?? '')
    const data = seg?.data ?? {}
    switch (type) {
      case 'text':
        text += String(data?.text ?? '')
        break
      case 'at': {
        const qq = String(data?.qq ?? '')
        if (!qq) break
        // `at` 段里 qq 可能是 "all"
        text += `<@${qq}>`
        mentions.push({ id: qq, username: '' })
        if (selfId && qq === String(selfId)) atMe = true
        break
      }
      case 'reply':
        // 引用回复：不当作正文，但记下来（她可以据此知道在回哪句）
        break
      case 'face':
        // QQ 小黄脸：保留成文本占位，别当成图片
        text += `[表情:${data?.id ?? ''}]`
        break
      default: {
        const contentType = SEG_TO_CONTENT_TYPE[type]
        if (!contentType) {
          // 未知段（share/music/json/xml 等）→ 拿摘要文字，不要丢
          const fallback = data?.summary ?? data?.text ?? ''
          if (fallback) text += String(fallback)
          break
        }
        // 图片/语音/文件：统一成官方 API 的 attachments 形状
        attachments.push({
          content_type: contentType,
          url: String(data?.url ?? data?.file ?? ''),
          // OneBot 的 file 可能是 base64:// 或本地路径，原样带上，上层按需取
          filename: String(data?.file ?? ''),
          // 语音的转写文字（NapCat 若开了语音转文字会有）
          ...(type === 'record' && data?.text ? { asr_refer_text: String(data.text) } : {}),
        })
        break
      }
    }
  }

  return { text: text.trim(), attachments, mentions, atMe }
}

/** 主要 content 类型 → 春禾的 kind（engine 用它决定走哪条处理路径） */
export function kindOf(attachments) {
  if (!Array.isArray(attachments) || !attachments.length) return 'text'
  const first = String(attachments[0]?.content_type ?? '')
  if (first.startsWith('image/')) return 'image'
  if (first.startsWith('voice/') || first.startsWith('audio/')) return 'voice'
  if (first.startsWith('video/')) return 'video'
  return 'file'
}

/**
 * OneBot 事件 → 春禾内部 msg。
 *
 * 返回 null 表示"这条不用管"（不是消息事件、或者自己发的消息 → 防自激）。
 *
 * @param {object} event OneBot 上报事件
 * @param {{selfIds?: string[]}} [opts] 机器人自己的 QQ 号（用于识别"是不是自己发的"）
 */
export function normalizeOneBotEvent(event, { selfIds = [] } = {}) {
  if (!event || event.post_type !== 'message') return null

  const selfSet = new Set((selfIds ?? []).filter(Boolean).map(String))
  const selfId = String(event?.self_id ?? '')
  const userId = String(event?.user_id ?? '')
  if (!userId) return null

  // 自己发的消息不处理，否则会自激复读
  if (selfSet.size && selfSet.has(userId)) return null
  if (!selfSet.size && selfId && userId === selfId) return null

  const { text, attachments, mentions, atMe } = parseSegments(event?.message, {
    selfId: selfId || [...selfSet][0],
  })

  const sender = event?.sender ?? {}
  const senderName = String(sender?.card || sender?.nickname || '').trim() || undefined

  if (event.message_type === 'group') {
    const groupId = String(event?.group_id ?? '')
    if (!groupId) return null
    return {
      kind: 'group',
      scope: 'group',
      rawEventType: 'GROUP_MESSAGE_CREATE',
      senderId: userId,
      senderName,
      senderIsBot: false,
      // OneBot 的 role：owner / admin / member
      memberRole: sender?.role ?? null,
      content: text,
      attachments,
      messageType: attachments.length ? kindOf(attachments) : undefined,
      messageId: String(event?.message_id ?? ''),
      timestamp: event?.time ? new Date(Number(event.time) * 1000).toISOString() : undefined,
      groupOpenid: groupId,
      targetId: groupId,
      mentions: mentions.length ? mentions : undefined,
      // OneBot 直接告诉我们"有没有 at 自己"——比官方的 rawEventType 更可靠
      onebotAtMe: atMe,
    }
  }

  if (event.message_type === 'private') {
    return {
      kind: 'c2c',
      scope: 'c2c',
      rawEventType: 'C2C_MESSAGE_CREATE',
      senderId: userId,
      senderName,
      content: text,
      attachments,
      messageType: attachments.length ? kindOf(attachments) : undefined,
      messageId: String(event?.message_id ?? ''),
      timestamp: event?.time ? new Date(Number(event.time) * 1000).toISOString() : undefined,
      targetId: userId,
    }
  }

  return null
}

// ── 发送方向的编码 ──────────────────────────────────────────

/**
 * 纯文本 → OneBot 的 message 段数组。
 * 文本里的 `<@qq>` 会被换成真正的 at 段（OneBot 要求 at 是独立段）。
 */
export function encodeTextToSegments(text) {
  const s = String(text ?? '')
  const segments = []
  let rest = s
  const atRe = /<@([^>\s]+)>/g
  let last = 0
  let m
  while ((m = atRe.exec(s)) !== null) {
    if (m.index > last) segments.push({ type: 'text', data: { text: s.slice(last, m.index) } })
    segments.push({ type: 'at', data: { qq: m[1] } })
    last = m.index + m[0].length
  }
  if (last < s.length) segments.push({ type: 'text', data: { text: s.slice(last) } })
  void rest
  return segments.length ? segments : [{ type: 'text', data: { text: '' } }]
}

/** 图片（base64）→ image 段 */
export function encodeImageSegment(base64) {
  return { type: 'image', data: { file: `base64://${String(base64 ?? '')}` } }
}

/** 语音（SILK base64）→ record 段 */
export function encodeRecordSegment(base64) {
  return { type: 'record', data: { file: `base64://${String(base64 ?? '')}` } }
}
