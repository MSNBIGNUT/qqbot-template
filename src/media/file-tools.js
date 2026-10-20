/**
 * file-tools.js —— 文件工具（列目录 / 读文件 / 写文件 / 搜内容）。
 *
 * 为什么要搬这套（2026-10-20 主人要求「把你的能力 copy 一份给她」）：
 *   她原来只会读**主人发给她的附件**，碰不到本机文件 ——
 *   主人说「看看我桌面上那个文件」「帮我把这段存成 txt」她只能干瞪眼。
 *
 * 安全边界（重要）：
 *   · **仅主人 + 仅私聊**（和 remote-agent 同一条线；群里任何人不给）
 *   · **只能碰 rootDir 以内的路径** —— 用 realpath 解析后判断前缀，
 *     `..` 穿越、符号链接、绝对路径跳出都会被拒
 *   · 读：文本上限 200KB；写：上限 1MB，且**默认不覆盖**（要 overwrite 显式说）
 *   · 不碰二进制（有 NUL 字节就拒绝，告诉她"这是二进制文件"）
 *
 * 为什么这不算放大风险：主人已经能用 remote-agent 执行任意本机命令
 * （比写文件强得多）。这套工具是**更安全的自然接口**，不是新开的口子。
 */
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'

export const FILE_LIST_TOOL = 'list_dir'
export const FILE_READ_TOOL = 'read_file'
export const FILE_WRITE_TOOL = 'write_file'
export const FILE_SEARCH_TOOL = 'search_files'

const MAX_READ_BYTES = 200 * 1024
const MAX_WRITE_BYTES = 1024 * 1024
const MAX_LIST_ENTRIES = 200
const MAX_SEARCH_HITS = 50

/** 明显的二进制扩展名：直接拒绝，别浪费 token */
const BINARY_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.pdf',
  '.mp3', '.wav', '.flac', '.m4a', '.ogg', '.silk', '.mp4', '.mkv', '.avi',
  '.zip', '.rar', '.7z', '.gz', '.tar', '.exe', '.dll', '.so', '.pyd',
  '.pt', '.pth', '.ckpt', '.onnx', '.bin', '.safetensors', '.faiss', '.index',
  '.woff', '.woff2', '.ttf', '.otf', '.db', '.sqlite',
])

/**
 * 把用户给的路径解析成"确定在 rootDir 以内"的绝对路径。
 * 不安全就抛错（调用方转成"如实拒绝"）。
 */
export async function resolveInsideRoot(rawPath, rootDir) {
  const root = await fsp.realpath(path.resolve(rootDir))
  const wanted = String(rawPath ?? '').trim()
  if (!wanted) throw new Error('路径是空的')

  // 允许写相对路径（相对 rootDir）
  const abs = path.isAbsolute(wanted) ? path.resolve(wanted) : path.resolve(root, wanted)

  // 先做字面判断（挡住 `..` 穿越），再用 realpath 挡住符号链接
  const rel = path.relative(root, abs)
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`路径不在允许的目录里：${wanted}（只允许 ${root} 以内）`)
  }

  // 目标可能还不存在（新建文件）→ 对最近的已存在祖先做 realpath
  let probe = abs
  const tail = []
  while (!fs.existsSync(probe)) {
    const parent = path.dirname(probe)
    if (parent === probe) break
    tail.unshift(path.basename(probe))
    probe = parent
  }
  let realProbe
  try {
    realProbe = await fsp.realpath(probe)
  } catch {
    throw new Error(`解析不了这个路径：${wanted}`)
  }
  const realTarget = tail.length ? path.join(realProbe, ...tail) : realProbe
  const rel2 = path.relative(root, realTarget)
  if (rel2.startsWith('..') || path.isAbsolute(rel2)) {
    throw new Error(`路径不在允许的目录里：${wanted}（符号链接指向了外部）`)
  }
  return realTarget
}

function fmtSize(n) {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

/** 列目录 */
export async function listDir(rawPath, { rootDir, max = MAX_LIST_ENTRIES } = {}) {
  let target
  try {
    target = await resolveInsideRoot(rawPath ?? '.', rootDir)
  } catch (err) {
    return { ok: false, reason: err?.message ?? String(err) }
  }
  let entries
  try {
    entries = await fsp.readdir(target, { withFileTypes: true })
  } catch (err) {
    return { ok: false, reason: `打不开这个目录：${err?.message ?? err}` }
  }
  entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
  const shown = entries.slice(0, max)
  const lines = shown.map((e) => (e.isDirectory() ? `[目录] ${e.name}/` : `${e.name}`))
  return {
    ok: true,
    path: target,
    total: entries.length,
    truncated: entries.length > shown.length,
    entries: lines,
  }
}

/** 读文件 */
export async function readFileTool(rawPath, { rootDir, maxBytes = MAX_READ_BYTES } = {}) {
  let target
  try {
    target = await resolveInsideRoot(rawPath, rootDir)
  } catch (err) {
    return { ok: false, reason: err?.message ?? String(err) }
  }
  const ext = path.extname(target).toLowerCase()
  let st
  try {
    st = await fsp.stat(target)
  } catch {
    return { ok: false, reason: `文件不存在：${rawPath}` }
  }
  if (st.isDirectory()) return { ok: false, reason: `这是个目录，不是文件：${rawPath}（要看得用 list_dir）` }
  if (BINARY_EXT.has(ext)) return { ok: false, reason: `这是二进制文件（${ext}），读不了文本内容` }
  if (st.size > maxBytes) {
    return { ok: false, reason: `文件太大（${fmtSize(st.size)} > ${fmtSize(maxBytes)}），不读了` }
  }
  const buf = await fsp.readFile(target)
  if (buf.includes(0)) return { ok: false, reason: '文件里有二进制内容（含 NUL 字节），不是纯文本' }
  let text = buf.toString('utf8')
  // 去 BOM
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
  return { ok: true, path: target, size: st.size, text }
}

/** 写文件 */
export async function writeFileTool(rawPath, content, { rootDir, overwrite = false, maxBytes = MAX_WRITE_BYTES } = {}) {
  let target
  try {
    target = await resolveInsideRoot(rawPath, rootDir)
  } catch (err) {
    return { ok: false, reason: err?.message ?? String(err) }
  }
  const body = String(content ?? '')
  const bytes = Buffer.byteLength(body, 'utf8')
  if (bytes > maxBytes) {
    return { ok: false, reason: `内容太大（${fmtSize(bytes)} > ${fmtSize(maxBytes)}），不写了` }
  }
  if (fs.existsSync(target) && !overwrite) {
    return { ok: false, reason: `文件已存在：${rawPath}。要覆盖得明确说「覆盖」` }
  }
  try {
    await fsp.mkdir(path.dirname(target), { recursive: true })
    await fsp.writeFile(target, body, 'utf8')
  } catch (err) {
    return { ok: false, reason: `写入失败：${err?.message ?? err}` }
  }
  return { ok: true, path: target, bytes, overwritten: fs.existsSync(target) }
}

/** 在某个目录里按关键词搜文本文件内容 */
export async function searchFiles(query, { rootDir, subPath = '.', max = MAX_SEARCH_HITS, maxFileBytes = MAX_READ_BYTES } = {}) {
  const needle = String(query ?? '').trim()
  if (!needle) return { ok: false, reason: '搜索词是空的' }
  let start
  try {
    start = await resolveInsideRoot(subPath, rootDir)
  } catch (err) {
    return { ok: false, reason: err?.message ?? String(err) }
  }

  const hits = []
  const skipDirs = new Set(['node_modules', '.git', '.voice-venv', '.tools', 'build', 'dist'])
  const walk = async (dir, depth) => {
    if (hits.length >= max || depth > 6) return
    let entries
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (hits.length >= max) return
      const full = path.join(dir, e.name)
      if (e.isDirectory()) {
        if (skipDirs.has(e.name)) continue
        await walk(full, depth + 1)
        continue
      }
      if (!e.isFile()) continue
      const ext = path.extname(e.name).toLowerCase()
      if (BINARY_EXT.has(ext)) continue
      try {
        const st = await fsp.stat(full)
        if (st.size > maxFileBytes) continue
        const buf = await fsp.readFile(full)
        if (buf.includes(0)) continue
        const text = buf.toString('utf8')
        text.split(/\r?\n/).forEach((line, i) => {
          if (hits.length >= max) return
          if (line.includes(needle)) {
            hits.push({
              file: path.relative(rootDir, full),
              line: i + 1,
              preview: line.trim().slice(0, 160),
            })
          }
        })
      } catch {
        /* 单个文件读失败就跳过，不影响整体 */
      }
    }
  }
  await walk(start, 0)
  return { ok: true, query: needle, hits, truncated: hits.length >= max }
}

// ── 工具定义 ────────────────────────────────────────────────

export const FILE_TOOLS = [
  {
    type: 'function',
    function: {
      name: FILE_LIST_TOOL,
      description:
        '列出一个目录里有什么（文件和子目录）。用于「桌面上有什么」「看看这个文件夹」这类请求。' +
        '只能访问主人允许的目录，外面的一律拒绝——被拒就如实说没权限，不要绕。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '目录路径；相对路径相对允许的根目录，默认当前目录' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: FILE_READ_TOOL,
      description:
        '读一个文本文件的内容。主人说「看看这个文件」「里面写了什么」时用。' +
        '二进制文件（图片/音频/压缩包/模型）会读不了，如实说。' +
        '**读完要真的基于内容回答**，不要假装看过。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '文件路径（相对或绝对，必须在允许的目录内）' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: FILE_WRITE_TOOL,
      description:
        '把一段文本写进一个文件（会自动建目录）。用于「把这段存成 xxx.txt」「帮我记到文件里」。' +
        '**文件已存在时默认不覆盖** —— 真覆盖必须在参数里写 overwrite=true。' +
        '写成功要如实说写到了哪里；失败要说原因，**不要假装写了**。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '目标文件路径' },
          content: { type: 'string', description: '要写入的文本内容' },
          overwrite: { type: 'boolean', description: '文件已存在时是否覆盖，默认 false' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: FILE_SEARCH_TOOL,
      description:
        '在一个目录里搜哪些文件包含某段文字（会告诉你文件名和行号）。' +
        '主人问「哪个文件里写了 xxx」时用。搜不到就如实说没搜到。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '要搜的文字' },
          path: { type: 'string', description: '在哪个目录里搜，默认允许的根目录' },
        },
        required: ['query'],
      },
    },
  },
]

/** 执行一次文件工具调用 */
export async function executeFileTool(name, args = {}, { rootDir } = {}) {
  switch (name) {
    case FILE_LIST_TOOL: {
      const r = await listDir(args?.path, { rootDir })
      return { ok: r.ok, content: formatListForModel(r) }
    }
    case FILE_READ_TOOL: {
      const r = await readFileTool(args?.path, { rootDir })
      return { ok: r.ok, content: formatReadForModel(r) }
    }
    case FILE_WRITE_TOOL: {
      const r = await writeFileTool(args?.path, args?.content, {
        rootDir,
        overwrite: args?.overwrite === true || String(args?.overwrite) === 'true',
      })
      return { ok: r.ok, content: formatWriteForModel(r) }
    }
    case FILE_SEARCH_TOOL: {
      const r = await searchFiles(args?.query, { rootDir, subPath: args?.path ?? '.' })
      return { ok: r.ok, content: formatSearchFilesForModel(r) }
    }
    default:
      return { ok: false, content: `未知的文件工具：${name}` }
  }
}

// ── 给模型看的格式化 ────────────────────────────────────────

export function formatListForModel(r) {
  if (!r?.ok) return `列目录失败：${r?.reason ?? '未知原因'}。（如实告诉对方没打开，不要猜里面有什么）`
  const head = `目录：${r.path}（共 ${r.total} 项${r.truncated ? '，只显示前 200 项' : ''}）`
  return [head, ...r.entries.map((e) => `· ${e}`)].join('\n')
}

export function formatReadForModel(r) {
  if (!r?.ok) return `读取失败：${r?.reason ?? '未知原因'}。（如实说没读到，不要编内容）`
  return `文件：${r.path}（${fmtSize(r.size)}）\n\n${r.text}`
}

export function formatWriteForModel(r) {
  if (!r?.ok) return `写入失败：${r?.reason ?? '未知原因'}。（如实说没写成，**不要假装写了**）`
  return `已写入：${r.path}（${fmtSize(r.bytes)}${r.overwritten ? '，覆盖了原文件' : ''}）`
}

export function formatSearchFilesForModel(r) {
  if (!r?.ok) return `搜索失败：${r?.reason ?? '未知原因'}。`
  if (!r.hits.length) return `没搜到包含「${r.query}」的文件。（如实说没搜到）`
  const lines = [`搜到 ${r.hits.length} 处${r.truncated ? '（已截断）' : ''}：`]
  for (const h of r.hits) lines.push(`· ${h.file}:${h.line}  ${h.preview}`)
  return lines.join('\n')
}
