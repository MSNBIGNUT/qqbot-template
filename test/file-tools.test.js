/**
 * file-tools.test.js —— 文件工具的单元测试。
 *
 * 重点测**安全边界**：越界、符号链接、二进制、覆盖保护。
 * 这些都是"出错就会伤到主人电脑"的地方，必须钉死。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  executeFileTool,
  FILE_TOOLS,
  formatReadForModel,
  listDir,
  readFileTool,
  resolveInsideRoot,
  searchFiles,
  writeFileTool,
} from '../src/media/file-tools.js'

function makeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qqbot-ft-'))
  fs.writeFileSync(path.join(root, 'a.txt'), '第一行 苹果\n第二行 香蕉\n', 'utf8')
  fs.mkdirSync(path.join(root, 'sub'), { recursive: true })
  fs.writeFileSync(path.join(root, 'sub', 'b.md'), '# 标题\n这里也有苹果\n', 'utf8')
  fs.writeFileSync(path.join(root, 'bin.dat'), Buffer.from([0, 1, 2, 3, 0, 255]))
  return root
}

// ── 安全边界（最重要） ──────────────────────────────────────

test('文件工具：越界路径一律拒绝（../ 绝对路径 符号链接）', async () => {
  const root = makeRoot()
  try {
    for (const bad of ['../escape.txt', '../../Windows/win.ini', 'C:\\Windows\\win.ini', '/etc/passwd']) {
      await assert.rejects(() => resolveInsideRoot(bad, root), /不在允许的目录/, `${bad} 必须被拒`)
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('文件工具：符号链接指向外部时也要拒绝', async () => {
  const root = makeRoot()
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'qqbot-out-'))
  try {
    const link = path.join(root, 'evil')
    try {
      fs.symlinkSync(outside, link, 'junction')
    } catch {
      // 没权限建符号链接就跳过（CI 环境常见）
      return
    }
    await assert.rejects(() => resolveInsideRoot('evil/x.txt', root), /不在允许的目录|符号链接/)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
    fs.rmSync(outside, { recursive: true, force: true })
  }
})

test('文件工具：rootDir 内部的普通路径要能正常解析', async () => {
  const root = makeRoot()
  try {
    const p = await resolveInsideRoot('sub/b.md', root)
    assert.ok(p.endsWith('b.md'))
    // 相对 "." 也要能解析
    const d = await resolveInsideRoot('.', root)
    assert.ok(d.length > 0)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

// ── 读 ─────────────────────────────────────────────────────

test('文件工具：读文本正常，二进制/目录要如实拒绝', async () => {
  const root = makeRoot()
  try {
    const ok = await readFileTool('a.txt', { rootDir: root })
    assert.equal(ok.ok, true)
    assert.ok(ok.text.includes('苹果'))

    const bin = await readFileTool('bin.dat', { rootDir: root })
    assert.equal(bin.ok, false)
    assert.match(bin.reason, /二进制/)

    const dir = await readFileTool('sub', { rootDir: root })
    assert.equal(dir.ok, false)
    assert.match(dir.reason, /目录/)

    const missing = await readFileTool('nope.txt', { rootDir: root })
    assert.equal(missing.ok, false)
    assert.match(missing.reason, /不存在/)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('文件工具：读失败时格式化明确要求「不要编」', () => {
  const text = formatReadForModel({ ok: false, reason: '文件不存在' })
  assert.match(text, /文件不存在/)
  assert.match(text, /不要编/)
})

// ── 写 ─────────────────────────────────────────────────────

test('文件工具：已存在默认不覆盖，显式 overwrite 才覆盖', async () => {
  const root = makeRoot()
  try {
    const blocked = await writeFileTool('a.txt', '新内容', { rootDir: root })
    assert.equal(blocked.ok, false)
    assert.match(blocked.reason, /已存在/)
    // 原文件不能被改
    assert.ok(fs.readFileSync(path.join(root, 'a.txt'), 'utf8').includes('苹果'))

    const forced = await writeFileTool('a.txt', '新内容', { rootDir: root, overwrite: true })
    assert.equal(forced.ok, true)
    assert.equal(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), '新内容')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('文件工具：写文件会自动建目录', async () => {
  const root = makeRoot()
  try {
    const r = await writeFileTool('deep/er/x.txt', 'hi', { rootDir: root })
    assert.equal(r.ok, true)
    assert.ok(fs.existsSync(path.join(root, 'deep', 'er', 'x.txt')))
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('文件工具：写文件跑不出根目录', async () => {
  const root = makeRoot()
  try {
    const r = await writeFileTool('../outside.txt', 'x', { rootDir: root })
    assert.equal(r.ok, false)
    assert.match(r.reason, /不在允许的目录/)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

// ── 列目录 / 搜内容 ────────────────────────────────────────

test('文件工具：列目录把子目录排在前面并标出来', async () => {
  const root = makeRoot()
  try {
    const r = await listDir('.', { rootDir: root })
    assert.equal(r.ok, true)
    assert.ok(r.entries[0].startsWith('[目录]'), '子目录应该排第一')
    assert.ok(r.entries.some((e) => e.includes('a.txt')))
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('文件工具：按内容搜能给出文件与行号，搜不到如实说', async () => {
  const root = makeRoot()
  try {
    const hit = await searchFiles('苹果', { rootDir: root })
    assert.equal(hit.ok, true)
    assert.ok(hit.hits.length >= 1)
    assert.ok(hit.hits.every((h) => h.file && h.line > 0))

    const miss = await searchFiles('这段文字根本不存在', { rootDir: root })
    assert.equal(miss.ok, true)
    assert.equal(miss.hits.length, 0)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

// ── 工具定义与分发 ────────────────────────────────────────

test('文件工具：四个工具定义齐全，描述里必须写清「如实说」', () => {
  const names = FILE_TOOLS.map((t) => t.function.name).sort()
  assert.deepEqual(names, ['list_dir', 'read_file', 'search_files', 'write_file'])
  for (const t of FILE_TOOLS) {
    assert.equal(t.type, 'function')
    assert.ok(t.function.description.length > 30)
    assert.match(t.function.description, /如实|不要假装|不要绕/, `${t.function.name} 缺少"如实"约束`)
  }
})

test('文件工具：executeFileTool 分发表能把四种调用都转过去', async () => {
  const root = makeRoot()
  try {
    const l = await executeFileTool('list_dir', { path: '.' }, { rootDir: root })
    assert.equal(l.ok, true)

    const r = await executeFileTool('read_file', { path: 'a.txt' }, { rootDir: root })
    assert.equal(r.ok, true)

    const w = await executeFileTool('write_file', { path: 'n.txt', content: 'x' }, { rootDir: root })
    assert.equal(w.ok, true)

    const s = await executeFileTool('search_files', { query: '苹果' }, { rootDir: root })
    assert.equal(s.ok, true)

    const unknown = await executeFileTool('rm_rf', {}, { rootDir: root })
    assert.equal(unknown.ok, false, '未知工具名必须拒绝，不能猜')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
