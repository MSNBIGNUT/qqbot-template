/**
 * onebot.test.js —— OneBot v11 适配层的测试。
 *
 * 全部**不碰真 QQ**：事件映射是纯函数；客户端/服务端测的是本机 mock。
 * 这样接小号之前就能把整条链路验证干净。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  encodeImageSegment,
  encodeRecordSegment,
  encodeTextToSegments,
  kindOf,
  normalizeOneBotEvent,
  parseSegments,
} from '../src/qq/onebot/event.js'
import { OneBotApiError, OneBotClient } from '../src/qq/onebot/client.js'
import { decodeWsFrame, encodeWsFrame, MockOneBotServer } from '../src/qq/onebot/mock-server.js'

const SELF = '22222'

// ── 事件映射（纯函数） ─────────────────────────────────────

test('OneBot：群消息映射到内部结构（昵称优先群名片、带 role）', () => {
  const msg = normalizeOneBotEvent(
    {
      post_type: 'message',
      message_type: 'group',
      message_id: 1,
      group_id: 987654,
      user_id: 11111,
      self_id: 22222,
      time: 1700000000,
      sender: { nickname: '张三', card: '小张', role: 'admin' },
      message: [{ type: 'text', data: { text: '帮我画只猫' } }],
    },
    { selfIds: [SELF] },
  )
  assert.equal(msg.scope, 'group')
  assert.equal(msg.kind, 'group')
  assert.equal(msg.senderId, '11111')
  assert.equal(msg.senderName, '小张', '群名片优先于昵称')
  assert.equal(msg.memberRole, 'admin')
  assert.equal(msg.groupOpenid, '987654')
  assert.equal(msg.targetId, '987654')
  assert.equal(msg.content, '帮我画只猫')
})

test('OneBot：没群名片时退回昵称', () => {
  const msg = normalizeOneBotEvent({
    post_type: 'message',
    message_type: 'group',
    group_id: 1,
    user_id: 2,
    self_id: 22222,
    sender: { nickname: '李四', card: '', role: 'member' },
    message: [{ type: 'text', data: { text: 'hi' } }],
  })
  assert.equal(msg.senderName, '李四')
})

test('OneBot：@ 变成 <@qq> 文本并记录 mentions', () => {
  const { text, mentions, atMe } = parseSegments(
    [
      { type: 'at', data: { qq: '11111' } },
      { type: 'text', data: { text: ' 你好' } },
      { type: 'at', data: { qq: SELF } },
    ],
    { selfId: SELF },
  )
  assert.equal(text, '<@11111> 你好<@22222>')
  assert.equal(mentions.length, 2)
  assert.equal(atMe, true, 'at 里出现自己 → atMe')
})

test('OneBot：图片/语音/文件进 attachments，形状对齐官方 API', () => {
  const r = parseSegments([
    { type: 'image', data: { url: 'https://x/a.jpg', file: 'a.jpg' } },
    { type: 'record', data: { url: 'https://x/a.silk', file: 'a.silk' } },
    { type: 'file', data: { file: 'doc.pdf', url: 'https://x/doc.pdf' } },
  ])
  assert.equal(r.attachments.length, 3)
  assert.equal(r.attachments[0].content_type, 'image/jpeg')
  assert.equal(r.attachments[1].content_type, 'voice/silk')
  assert.equal(r.attachments[0].url, 'https://x/a.jpg')
  assert.equal(kindOf(r.attachments), 'image')
})

test('OneBot：小黄脸保留成文本占位，不当图片', () => {
  const { text, attachments } = parseSegments([{ type: 'face', data: { id: '178' } }])
  assert.match(text, /表情:178/)
  assert.equal(attachments.length, 0)
})

test('OneBot：未知段用摘要兜底，不丢内容', () => {
  const { text } = parseSegments([{ type: 'json', data: { summary: '【卡片】某链接' } }])
  assert.match(text, /某链接/)
})

test('OneBot：自己发的消息 / 非消息事件 / 缺字段 → null（不自激）', () => {
  assert.equal(
    normalizeOneBotEvent(
      { post_type: 'message', message_type: 'private', user_id: 22222, self_id: 22222, message: [] },
      { selfIds: [SELF] },
    ),
    null,
  )
  assert.equal(normalizeOneBotEvent({ post_type: 'notice' }, { selfIds: [SELF] }), null)
  assert.equal(
    normalizeOneBotEvent({ post_type: 'message', message_type: 'private', self_id: 22222 }, { selfIds: [SELF] }),
    null,
  )
})

test('OneBot：发送编码把 <@qq> 拆成独立 at 段', () => {
  const segs = encodeTextToSegments('你好 <@11111> 在吗')
  assert.deepEqual(segs, [
    { type: 'text', data: { text: '你好 ' } },
    { type: 'at', data: { qq: '11111' } },
    { type: 'text', data: { text: ' 在吗' } },
  ])
  assert.deepEqual(encodeTextToSegments('纯文本'), [{ type: 'text', data: { text: '纯文本' } }])
  assert.match(encodeImageSegment('QUJD').data.file, /^base64:\/\//)
  assert.match(encodeRecordSegment('U0lMSw==').data.file, /^base64:\/\//)
})

// ── WebSocket 帧 ───────────────────────────────────────────

test('OneBot：WS 帧编解码（短/中/长 三种长度）', () => {
  for (const text of ['a', 'x'.repeat(200), 'y'.repeat(70000)]) {
    const frame = encodeWsFrame(text)
    const clientFrame = Buffer.from(frame)
    // 模拟客户端掩码：服务端帧没掩码，decode 也支持无掩码
    const decoded = decodeWsFrame(clientFrame)
    assert.ok(decoded, '应该能解析')
    assert.equal(decoded.payload.toString('utf8'), text)
  }
})

// ── 客户端 + Mock 服务端（本机、无 QQ） ────────────────────

async function withStack(fn) {
  const srv = await new MockOneBotServer({ groups: ['测试群'] }).start()
  const client = new OneBotClient({ wsUrl: srv.wsUrl, httpUrl: srv.httpUrl })
  try {
    client.start()
    const ready = await client.ready(5000)
    assert.equal(ready, true, '应该能连上 mock 服务端')
    await fn(srv, client)
  } finally {
    client.stop()
    await srv.stop()
  }
}

test('OneBot 端到端：mock 推群消息 → 客户端收到正确结构', async () => {
  await withStack(async (srv, client) => {
    const got = []
    client.on('message', (m) => got.push(m))
    srv.pushGroupMessage({ groupId: 1001, userId: 11111, card: '小张', role: 'owner', text: '在吗' })
    await new Promise((r) => setTimeout(r, 300))
    assert.equal(got.length, 1)
    assert.equal(got[0].scope, 'group')
    assert.equal(got[0].senderName, '小张')
    assert.equal(got[0].memberRole, 'owner')
    assert.equal(got[0].content, '在吗')
  })
})

test('OneBot 端到端：客户端发消息 → mock 服务端收到正确段', async () => {
  await withStack(async (srv, client) => {
    await client.sendText('group', '1001', '好的 <@11111>')
    await new Promise((r) => setTimeout(r, 200))
    const sent = srv.sentMessages.at(-1)
    assert.equal(sent.action, 'send_group_msg')
    assert.equal(sent.targetId, '1001')
    assert.equal(sent.message[0].type, 'text')
    assert.equal(sent.message[1].type, 'at')
  })
})

test('OneBot 端到端：群列表 / 群名 / 成员列表（官方 API 拿不到的能力）', async () => {
  await withStack(async (srv, client) => {
    const groups = await client.getGroupList()
    assert.equal(groups.length, 1)
    assert.equal(groups[0].group_name, '测试群')

    const members = await client.getGroupMemberList(1001)
    assert.equal(members.length, 3)
    assert.ok(members.some((m) => m.role === 'owner'))
    assert.ok(members.some((m) => m.nickname === '李四'))
  })
})

test('OneBot 端到端：发语音用 record 段', async () => {
  await withStack(async (srv, client) => {
    await client.sendVoice('group', '1001', 'U0lMSw==')
    await new Promise((r) => setTimeout(r, 200))
    const sent = srv.sentMessages.at(-1)
    assert.equal(sent.message[0].type, 'record')
    assert.match(sent.message[0].data.file, /^base64:\/\//)
  })
})

test('OneBot：API 业务失败要抛带 retcode 的错误', async () => {
  const fakeFetch = async () =>
    new Response(JSON.stringify({ status: 'failed', retcode: 100, wording: '权限不足' }), { status: 200 })
  const c = new OneBotClient({ wsUrl: 'ws://x', httpUrl: 'http://x', fetchImpl: fakeFetch })
  await assert.rejects(
    () => c.call('send_group_msg', {}),
    (err) => {
      assert.ok(err instanceof OneBotApiError)
      assert.equal(err.retcode, 100)
      return true
    },
  )
})

test('OneBot：没配 httpUrl 时拒绝发送（不静默失败）', async () => {
  const c = new OneBotClient({ wsUrl: 'ws://x' })
  await assert.rejects(() => c.sendText('group', '1', 'x'), /没配 ONEBOT_HTTP_URL/)
})

test('OneBot：没配 wsUrl 时 start 直接报错', () => {
  const c = new OneBotClient({ httpUrl: 'http://x' })
  assert.throws(() => c.start(), /wsUrl 是空的/)
})
