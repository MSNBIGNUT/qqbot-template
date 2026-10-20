/**
 * tool-coverage.test.js —— 「注册了工具，但没告诉她」这个错误必须在 CI 就红。
 *
 * 为什么单独一个文件：
 *   真机事故（2026-10-20）——`web_search` / `web_fetch` 已经注册好几天了，
 *   但 `describeCapabilitiesForModel()` 的能力清单里没有联网。结果：
 *     主人：你现在能联网查阅东西吗
 *     她：不能，春禾这边没有联网的工具。系统清单里也没有这一项。
 *   这不是崩溃，是**她会一直诚恳地说错话**，而且只有主人主动问才会暴露。
 *
 * 这个测试的规则很简单：
 *   **每一个注册给模型的工具名，都必须在能力清单里被提到。**
 *   加新工具忘了写清单 → 这里立刻失败，并告诉你缺哪个。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

import { describeCapabilitiesForModel } from '../src/persona/default.js'
import { WEB_TOOLS, WEB_SEARCH_TOOL_NAME, WEB_FETCH_TOOL_NAME } from '../src/media/web-tools.js'
import { IMAGE_TOOL_NAME } from '../src/media/imagegen.js'
import { STICKER_TOOL_NAME } from '../src/media/stickers.js'
import { SEND_GROUP_TOOL_NAME } from '../src/media/group-send.js'
import { STAY_SILENT_TOOL_NAME } from '../src/persona/default.js'

const SRC = path.resolve(import.meta.dirname, '..', 'src')

/** 全开配置 */
const ALL_ON = {
  singEnabled: true,
  reminders: true,
  imageGen: { enabled: true, apiKey: 'x' },
  remoteEnabled: true,
  stickers: { enabled: true },
  pendingActions: true,
  groupTrigger: 'wake',
  webToolsEnabled: true,
  fileToolsEnabled: true,
  ttsAllowGroup: 'on-demand',
}

/**
 * 每个工具 → 能力清单里必须出现的关键词。
 * 加新工具时，**这张表也要加一行** —— 这就是「让她知道」的落点。
 */
const TOOL_TO_CAPABILITY = [
  { tool: IMAGE_TOOL_NAME, keywords: ['画图'], configFlag: 'imageGen' },
  { tool: STICKER_TOOL_NAME, keywords: ['表情包'], configFlag: 'stickers' },
  { tool: SEND_GROUP_TOOL_NAME, keywords: ['跨场景主动消息', '群里'], configFlag: 'pendingActions' },
  { tool: STAY_SILENT_TOOL_NAME, keywords: ['不回复', '沉默', '不用回'], configFlag: null },
  { tool: WEB_SEARCH_TOOL_NAME, keywords: ['联网查阅'], configFlag: 'webToolsEnabled' },
  { tool: WEB_FETCH_TOOL_NAME, keywords: ['联网查阅'], configFlag: 'webToolsEnabled' },
  // 2026-10-20：文件工具（仅主人 + 仅私聊）
  { tool: 'list_dir', keywords: ['读写文件'], configFlag: 'fileToolsEnabled' },
  { tool: 'read_file', keywords: ['读写文件'], configFlag: 'fileToolsEnabled' },
  { tool: 'write_file', keywords: ['读写文件'], configFlag: 'fileToolsEnabled' },
  { tool: 'search_files', keywords: ['读写文件'], configFlag: 'fileToolsEnabled' },
]

test('工具覆盖：每个注册给模型的工具，能力清单里都得说她知道', () => {
  const text = describeCapabilitiesForModel(ALL_ON, { songCount: 4, stickerCount: 30 })
  const missing = []
  for (const { tool, keywords } of TOOL_TO_CAPABILITY) {
    const hit = keywords.some((k) => text.includes(k))
    if (!hit) missing.push(`工具 ${tool} 对应的能力（关键词 ${keywords.join('/')}）不在清单里`)
  }
  assert.deepEqual(missing, [], `有工具没告诉她：\n${missing.join('\n')}`)
})

test('工具覆盖：WEB_TOOLS 里每个 name 都出现在覆盖表里', () => {
  const covered = new Set(TOOL_TO_CAPABILITY.map((x) => x.tool))
  for (const t of WEB_TOOLS) {
    assert.ok(covered.has(t.function.name), `新增的联网工具 ${t.function.name} 没进 TOOL_TO_CAPABILITY 表`)
  }
})

test('工具覆盖：源码里出现的工具名常量，都能在能力清单里找到对应描述', () => {
  // 从源码里扫出所有 *_TOOL_NAME 常量定义，防止有人加了工具但没进覆盖表
  const names = new Set()
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.name.endsWith('.js')) {
        const src = fs.readFileSync(p, 'utf8')
        for (const m of src.matchAll(/export const (\w+_TOOL(?:_NAME)?)\s*=\s*["'`]([a-z_]+)["'`]/g)) {
          names.add(m[2])
        }
      }
    }
  }
  walk(SRC)
  assert.ok(names.size >= 4, `扫到的工具名太少（${names.size} 个），扫描逻辑可能坏了：${[...names]}`)
  const covered = new Set(TOOL_TO_CAPABILITY.map((x) => x.tool))
  const gap = [...names].filter((n) => !covered.has(n))
  assert.deepEqual(gap, [], `这些工具名没进覆盖表，等于没告诉她：${gap.join(', ')}`)
})

test('工具覆盖：关掉某个能力时，清单要明确说「关着」而不是只字不提', () => {
  const off = { ...ALL_ON, webToolsEnabled: false }
  const text = describeCapabilitiesForModel(off, {})
  assert.match(text, /联网查阅/, '关掉也要有一条，不能直接消失（否则她不知道是"没开"还是"没有"）')
  assert.match(text, /关着|没开/)
})
