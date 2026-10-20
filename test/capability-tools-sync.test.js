/**
 * capability-tools-sync.test.js —— 防止「能力清单」和「实际工具」再次脱节。
 *
 * 真机 bug（2026-10-20）：
 *   主人：你现在能联网查阅东西吗
 *   她：不能，春禾这边没有联网的工具。系统清单里也没有这一项。
 *
 * `web_search` / `web_fetch` 明明已经注册成工具了，但人格的
 * `describeCapabilitiesForModel()` 没写联网 —— 模型照着清单判断自己会什么，
 * 于是"工具在、她说没有"。这种脱节**不会报错**，只会让她一直说错。
 *
 * 这个测试的价值：以后再加工具却忘了写清单，CI 立刻红。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { describeCapabilitiesForModel as describeChunhe } from '../src/persona/default.js'

/** 一个"全开"的配置：所有能力都打开 */
const ALL_ON = {
  singEnabled: true,
  reminders: true,
  imageGen: { enabled: true, apiKey: 'x' },
  remoteEnabled: true,
  stickers: { enabled: true },
  pendingActions: true,
  groupTrigger: 'wake',
  webToolsEnabled: true,
  ttsAllowGroup: 'on-demand',
}

/** 一个"全关"的配置：所有能力都关掉 */
const ALL_OFF = {
  singEnabled: false,
  reminders: false,
  imageGen: { enabled: false, apiKey: '' },
  remoteEnabled: false,
  stickers: { enabled: false },
  pendingActions: false,
  groupTrigger: 'mention',
  webToolsEnabled: false,
  ttsAllowGroup: false,
}

test('能力清单：联网查阅必须是独立的一条，不能只在别处顺带提到', () => {
  const text = describeChunhe(ALL_ON, { songCount: 4, stickerCount: 30 })
  assert.match(text, /联网查阅/, '打开联网时，能力清单里必须有「联网查阅」这一条')
  // 关键：要明确告诉她"能真搜"，否则模型还是不敢用
  assert.match(text, /能真搜网页/, '要写明能真搜网页（web_search）')
  assert.match(text, /web_fetch|读网页正文/, '要写明能读网页正文')
})

test('能力清单：联网没开时要如实说「没开」，且不许凭记忆编实时数据', () => {
  const text = describeChunhe(ALL_OFF, {})
  assert.match(text, /联网查阅/)
  assert.match(text, /关着|没开/, '关掉时要明确说关着')
  assert.match(text, /不要凭记忆|不许编|如实/, '关掉时也要禁止编造实时数据')
})

test('能力清单：硬规则必须写进提示词（说来源 / 查不到就认）', () => {
  const text = describeChunhe(ALL_ON, {})
  assert.match(text, /说清来源/, '必须要求她标注来源')
  assert.match(text, /查不到就如实说没查到|不要编|不许编/, '必须明确"查不到就认，不许编"')
})

test('能力清单：每个打开的能力都要出现（防止漏写）', () => {
  const text = describeChunhe(ALL_ON, { songCount: 4, stickerCount: 30 })
  for (const [name, re] of [
    ['唱歌', /唱歌/],
    ['定时提醒', /定时提醒/],
    ['画图', /画图/],
    ['控制电脑', /控制电脑/],
    ['表情包', /表情包/],
    ['跨场景主动消息', /跨场景主动消息/],
    ['群聊回应', /群聊回应/],
    ['联网查阅', /联网查阅/],
  ]) {
    assert.match(text, re, `能力清单缺少「${name}」`)
  }
})

test('能力清单：配置为空时返回空串（不要吐出半截清单）', () => {
  assert.equal(describeChunhe(null, {}), '')
  assert.equal(describeChunhe(undefined, {}), '')
  assert.equal(describeChunhe('不是对象', {}), '')
})
