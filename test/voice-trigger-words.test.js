/**
 * voice-trigger-words.test.js —— 「说话」不是语音请求。
 *
 * 真机（2026-10-20）：
 *   你（文字）：可以尝试在后面的对话中对喜欢的人发颜文字表示你乐于与他说话吗
 *   她：[voice] 用语音回了
 *
 * 根因：VOICE_REQUEST_SAY 里原本有 `/说个?(话|句)/`，`个?` 可选，
 * 于是裸的「说话」也命中 —— 而「说话」是日常最常用的词之一。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { wantsVoiceReply } from '../src/media/tts.js'

test('语音触发：含「说话」的普通句子不该触发语音', () => {
  const ordinary = [
    '可以尝试在后面的对话中对喜欢的人发颜文字表示你乐于与他说话吗',
    '你在说话的时候就不用颜文字了，主要文本输出和语言输出还是有区别的',
    '他说话很客气',
    '刚才你说的那句话挺对的',
    '我们在说话呢你别插嘴',
  ]
  for (const t of ordinary) {
    assert.equal(wantsVoiceReply(t), false, `不该触发语音：${t}`)
  }
})

test('语音触发：真正的点播形态仍然要触发', () => {
  const requests = [
    '用语音说句晚安',
    '说话给我听',
    '说句话嘛',
    '说一句话给我听',
    '说个话呀',
    '发条语音',
    '语音回我',
    '念一下这段',
    '讲一段',
  ]
  for (const t of requests) {
    assert.equal(wantsVoiceReply(t), true, `应该触发语音：${t}`)
  }
})

test('语音触发：问能力不是点播', () => {
  for (const t of ['你能发语音吗', '你有语音功能吗', '语音怎么开']) {
    assert.equal(wantsVoiceReply(t), false, `问能力不该触发：${t}`)
  }
})