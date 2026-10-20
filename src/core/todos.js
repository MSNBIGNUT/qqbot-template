/**
 * todos.js —— 待办清单（她自己维护的多步任务跟踪）。
 *
 * 为什么要这个（2026-10-20 主人要求：「把我的能力 copy 一份给她」）：
 *   她原来只有「定时提醒」—— 那是**到点发消息**，不是"这件事我做到第几步了"。
 *   主人说「帮我把桌面这 5 个文件整理一下」时，她做一步忘一步，
 *   也没法告诉主人还剩几件。
 *
 * 用法（和我的 todo_write 一样）：
 *   · todo_write 传**完整列表**，整份替换 —— 比增量修改更不容易出错
 *   · 当前清单会被注入提示词，所以她随时知道进度
 *
 * 存盘：`data/todos.json`，按 owner 分开（每个人的待办互不可见）。
 */
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'

const DEFAULT_FILE = 'data/todos.json'
/** 一个 owner 最多留多少条 —— 太多说明该拆任务了，也白占 token */
export const MAX_TODOS = 30
/** 单条内容长度上限 */
export const MAX_CONTENT = 120

export const TODO_STATUSES = ['pending', 'in_progress', 'completed']

export const TODO_TOOL_NAME = 'todo_write'

/** 状态 → 给模型看的图标 */
const STATUS_ICON = {
  pending: '☐',
  in_progress: '▶',
  completed: '✔',
}

/** 清洗一条待办；不合法返回 null */
export function normalizeTodo(raw) {
  if (!raw) return null
  // 允许传字符串（默认 pending），也允许传 {content, status}
  const content = String(typeof raw === 'string' ? raw : (raw?.content ?? '')).trim()
  if (!content) return null
  const status = String(typeof raw === 'string' ? 'pending' : (raw?.status ?? 'pending')).toLowerCase()
  return {
    content: Array.from(content).slice(0, MAX_CONTENT).join(''),
    status: TODO_STATUSES.includes(status) ? status : 'pending',
  }
}

/** 把一份列表清洗干净：去空、去重、截断 */
export function normalizeTodoList(rawList) {
  if (!Array.isArray(rawList)) return []
  const seen = new Set()
  const out = []
  for (const raw of rawList) {
    const t = normalizeTodo(raw)
    if (!t) continue
    const key = `${t.status}::${t.content}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(t)
    if (out.length >= MAX_TODOS) break
  }
  return out
}

export class TodoStore {
  /**
   * @param {{file?: string, logger?: object, now?: () => number}} [opts]
   */
  constructor({ file = DEFAULT_FILE, logger = null, now = () => Date.now() } = {}) {
    this.file = file
    this.logger = logger
    this.now = now
    /** ownerId → { items, updatedAt } */
    this.byOwner = new Map()
    this.loaded = false
    this.#loadSync()
  }

  #loadSync() {
    try {
      const raw = fs.readFileSync(this.file, 'utf8')
      const data = JSON.parse(raw)
      for (const [owner, v] of Object.entries(data?.byOwner ?? {})) {
        const items = normalizeTodoList(v?.items)
        if (!owner || !items.length) continue
        this.byOwner.set(String(owner), { items, updatedAt: Number(v?.updatedAt) || 0 })
      }
      this.loaded = true
    } catch {
      /* 首次运行没有文件，正常 */
    }
  }

  async flush() {
    try {
      await fsp.mkdir(path.dirname(this.file), { recursive: true })
      const byOwner = {}
      for (const [owner, v] of this.byOwner) byOwner[owner] = v
      await fsp.writeFile(
        this.file,
        JSON.stringify(
          { version: 1, savedAt: new Date(this.now()).toISOString(), byOwner },
          null,
          2,
        ),
      )
    } catch (err) {
      this.logger?.warn?.(`待办清单写入失败：${err?.message ?? err}`)
    }
  }

  /**
   * 整份替换某个 owner 的待办清单。
   * 空数组 = 清空（任务全做完了就该清掉，别留一串 ✔ 占上下文）。
   */
  replace(ownerId, rawList) {
    const owner = String(ownerId ?? '').trim()
    if (!owner) return { ok: false, reason: '没有 ownerId，不知道给谁记' }
    const items = normalizeTodoList(rawList)
    if (!items.length) {
      this.byOwner.delete(owner)
      void this.flush()
      return { ok: true, items: [], cleared: true }
    }
    this.byOwner.set(owner, { items, updatedAt: this.now() })
    void this.flush()
    return { ok: true, items }
  }

  /** 读某个 owner 的清单（副本） */
  list(ownerId) {
    const v = this.byOwner.get(String(ownerId ?? '').trim())
    return v ? v.items.map((t) => ({ ...t })) : []
  }

  /** 统计：还剩几件没做完 */
  summary(ownerId) {
    const items = this.list(ownerId)
    return {
      total: items.length,
      done: items.filter((t) => t.status === 'completed').length,
      active: items.filter((t) => t.status !== 'completed').length,
    }
  }

  /** 给模型看的清单；没有就返回空串（不占上下文） */
  describe(ownerId) {
    const items = this.list(ownerId)
    if (!items.length) return ''
    const s = this.summary(ownerId)
    const lines = [
      `【当前待办 · 共 ${s.total} 项，还剩 ${s.active} 件没做完】`,
      ...items.map((t, i) => `${i + 1}. ${STATUS_ICON[t.status] ?? '☐'} ${t.content}`),
      '（做一步就把那一步标 in_progress，做完标 completed，最后全做完就用空数组清掉。别在回复里重复整份清单。）',
    ]
    return lines.join('\n')
  }
}

// ── 工具定义 ────────────────────────────────────────────────

export const TODO_TOOL = {
  type: 'function',
  function: {
    name: TODO_TOOL_NAME,
    description:
      '维护一份**多步任务的待办清单**。用于：一件事要分好几步做（整理一批文件、查多份资料、' +
      '做一组对比），你需要记住做到哪了、还剩几件。\n' +
      '【怎么用】\n' +
      '1. 传**完整列表**，整份替换（不是增量追加）—— 更不容易出错。\n' +
      '2. 只在真正多步时用。**一两步就能做完的事不要建清单**，那是负担。\n' +
      '3. 做完一步就把那项改成 completed，别攒着。\n' +
      '4. 全部做完用空数组 [] 清掉，**不要留一串已完成占着上下文**。\n' +
      '5. 清单是你自己的工作记录，**不要在回复里把整份清单念给主人听**——' +
      '只需要说"做到第几步了/还剩什么"。',
    parameters: {
      type: 'object',
      properties: {
        todos: {
          type: 'array',
          description: '完整的新清单；传 [] 表示全部完成、清空',
          items: {
            type: 'object',
            properties: {
              content: { type: 'string', description: '这一步要做什么（一句话）' },
              status: {
                type: 'string',
                enum: TODO_STATUSES,
                description: 'pending=还没做 / in_progress=正在做 / completed=已完成',
              },
            },
            required: ['content'],
          },
        },
      },
      required: ['todos'],
    },
  },
}

/** 执行一次 todo_write */
export function executeTodoTool(store, ownerId, args = {}) {
  const list = args?.todos
  if (!Array.isArray(list) && typeof list !== 'string') {
    return {
      ok: false,
      content:
        '参数不对：todos 必须是一个数组（[{content, status}]）。要清空就传 []。（如实说没记成，不要假装记了）',
    }
  }
  // 有些模型会把整个数组当 JSON 字符串传进来 —— 容错一下
  let parsed = list
  if (typeof list === 'string') {
    try {
      parsed = JSON.parse(list)
    } catch {
      return { ok: false, content: 'todos 不是合法数组，没记成。（如实说，不要假装记了）' }
    }
  }
  const r = store.replace(ownerId, parsed)
  if (!r.ok) return { ok: false, content: `待办没记成：${r.reason}` }
  if (r.cleared) return { ok: true, content: '待办清单已清空（任务都完成了）。' }

  const s = store.summary(ownerId)
  const head = `待办已更新：共 ${s.total} 项，还剩 ${s.active} 件没做完。`
  const body = r.items.map((t, i) => `${i + 1}. ${STATUS_ICON[t.status] ?? '☐'} ${t.content}`).join('\n')
  return {
    ok: true,
    content: `${head}\n${body}\n（清单已记下，不用在回复里再念一遍；跟主人说进度就行。）`,
  }
}
