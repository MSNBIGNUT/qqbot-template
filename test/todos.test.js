/**
 * todos.test.js —— 待办清单的单元测试。
 *
 * 重点：整份替换语义、按 owner 隔离、清空、容错、上限。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  executeTodoTool,
  MAX_TODOS,
  normalizeTodo,
  normalizeTodoList,
  TODO_TOOL,
  TODO_TOOL_NAME,
  TodoStore,
} from '../src/core/todos.js'

function makeStore() {
  const f = path.join(os.tmpdir(), `qqbot-todos-${Date.now()}-${Math.random()}.json`)
  return { store: new TodoStore({ file: f }), file: f }
}

test('待办：建清单 / 读回 / 统计', async () => {
  const { store, file } = makeStore()
  try {
    const r = executeTodoTool(store, 'o1', {
      todos: [
        { content: '列文件', status: 'completed' },
        { content: '分组', status: 'in_progress' },
        { content: '移动' },
      ],
    })
    assert.equal(r.ok, true)
    assert.match(r.content, /共 3 项/)
    assert.match(r.content, /还剩 2 件/)

    const s = store.summary('o1')
    assert.deepEqual(s, { total: 3, done: 1, active: 2 })

    // 落盘再读回
    await store.flush()
    const again = new TodoStore({ file })
    assert.equal(again.list('o1').length, 3)
    assert.equal(again.list('o1')[1].status, 'in_progress')
  } finally {
    fs.rmSync(file, { force: true })
  }
})

test('待办：整份替换（不是追加）', async () => {
  const { store, file } = makeStore()
  try {
    executeTodoTool(store, 'o1', { todos: ['a', 'b', 'c'] })
    executeTodoTool(store, 'o1', { todos: ['只剩这一条'] })
    assert.equal(store.list('o1').length, 1, '应该整份替换，不是追加')
  } finally {
    fs.rmSync(file, { force: true })
  }
})

test('待办：空数组 = 清空，且 describe 变空串（不占上下文）', async () => {
  const { store, file } = makeStore()
  try {
    executeTodoTool(store, 'o1', { todos: ['a', 'b'] })
    assert.ok(store.describe('o1').length > 0)
    const r = executeTodoTool(store, 'o1', { todos: [] })
    assert.equal(r.ok, true)
    assert.match(r.content, /清空/)
    assert.equal(store.describe('o1'), '')
  } finally {
    fs.rmSync(file, { force: true })
  }
})

test('待办：按 owner 隔离，别人看不到', async () => {
  const { store, file } = makeStore()
  try {
    executeTodoTool(store, 'owner-a', { todos: ['a 的任务'] })
    assert.equal(store.list('owner-b').length, 0)
    assert.equal(store.describe('owner-b'), '')
    assert.match(store.describe('owner-a'), /a 的任务/)
  } finally {
    fs.rmSync(file, { force: true })
  }
})

test('待办：清洗（空串/非法状态/超长/去重/上限）', () => {
  assert.equal(normalizeTodo(''), null)
  assert.equal(normalizeTodo(null), null)
  assert.equal(normalizeTodo('   '), null)

  // 非法状态回落到 pending
  assert.equal(normalizeTodo({ content: 'x', status: '瞎写' }).status, 'pending')

  // 超长截断到 120
  const long = normalizeTodo('a'.repeat(300))
  assert.equal(long.content.length, 120)

  // 空数组元素被丢弃
  assert.deepEqual(normalizeTodoList([null, '', '  ', {}]), [])

  // 上限
  const many = Array.from({ length: MAX_TODOS + 20 }, (_, i) => `任务${i}`)
  assert.equal(normalizeTodoList(many).length, MAX_TODOS)
})

test('待办：容错 —— 模型把数组当 JSON 字符串传也能接住', async () => {
  const { store, file } = makeStore()
  try {
    const r = executeTodoTool(store, 'o1', { todos: '[{"content":"a","status":"completed"}]' })
    assert.equal(r.ok, true)
    assert.equal(store.list('o1').length, 1)
  } finally {
    fs.rmSync(file, { force: true })
  }
})

test('待办：参数不对时如实失败，不假装记了', () => {
  const { store, file } = makeStore()
  try {
    const r = executeTodoTool(store, 'o1', { todos: 12345 })
    assert.equal(r.ok, false)
    assert.match(r.content, /不要假装记了|没记成/)
    assert.equal(store.list('o1').length, 0)
  } finally {
    fs.rmSync(file, { force: true })
  }
})

test('待办：describe 带状态图标和「别念清单」的提醒', async () => {
  const { store, file } = makeStore()
  try {
    executeTodoTool(store, 'o1', [
      { content: '完成的事', status: 'completed' },
      { content: '在做的事', status: 'in_progress' },
      { content: '没做的事' },
    ].map((t) => t))
    executeTodoTool(store, 'o1', { todos: [
      { content: '完成的事', status: 'completed' },
      { content: '在做的事', status: 'in_progress' },
      { content: '没做的事' },
    ] })
    const text = store.describe('o1')
    assert.match(text, /✔/, '完成项要有 ✔')
    assert.match(text, /▶/, '进行项要有 ▶')
    assert.match(text, /☐/, '未做项要有 ☐')
    assert.match(text, /别在回复里重复|不要.*念/)
  } finally {
    fs.rmSync(file, { force: true })
  }
})

test('待办：工具定义完整', () => {
  assert.equal(TODO_TOOL.type, 'function')
  assert.equal(TODO_TOOL.function.name, TODO_TOOL_NAME)
  assert.ok(TODO_TOOL.function.description.length > 50)
  // 必须写清「一两步别建清单」和「别念给主人听」
  assert.match(TODO_TOOL.function.description, /一两步|不要建清单/)
  assert.match(TODO_TOOL.function.description, /不要.*念|别.*念/)
  assert.deepEqual(TODO_TOOL.function.parameters.required, ['todos'])
  const st = TODO_TOOL.function.parameters.properties.todos.items.properties.status.enum
  assert.deepEqual(st.sort(), ['completed', 'in_progress', 'pending'])
})
