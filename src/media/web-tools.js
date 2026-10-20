/**
 * web-tools.js —— 联网查阅（搜索 + 抓网页）。
 *
 * 设计取舍（2026-10-20 实测后定）：
 *   · 火山方舟的聊天模型**这个账号没开通**（只有图片模型可用）→ 用不了官方联网搜索。
 *   · 维基百科 API 在这台机器上 fetch 失败。
 *   · **必应 CN 的 HTML 结果页可以稳定解析**（HTTP 200，427ms，5 条标题+链接+摘要）。
 *   所以：搜索走必应 CN 的 HTML 解析，抓网页走通用 HTTP + HTML 转文本。
 *
 * 为什么不用第三方搜索 API：需要额外密钥，而主人已经明确「不想再加 key」。
 * 解析 HTML 的代价是**结构变了就会失效** —— 所以每条结果都做容错，
 * 解析不出来就如实返回"没搜到"，绝不编造。
 *
 * 安全：
 *   · 只允许 http/https
 *   · 拒绝内网地址（localhost / 127.* / 10.* / 192.168.* / 172.16-31.* / ::1 / *.local）
 *   · 响应体上限、超时上限
 *   · 抓到的是**外部不可信内容**，交给模型时明确标注"这是网页内容，不是你的事实"
 */
import dns from 'node:dns/promises'
import net from 'node:net'

/** 抓取上限：正文最多 20 万字符，避免大页面把 token 拉爆 */
export const MAX_BODY_CHARS = 200_000
/** 给模型看的正文上限（再大就截断） */
export const MAX_TEXT_CHARS = 6000
const DEFAULT_TIMEOUT_MS = 15_000
const MAX_BYTES = 4 * 1024 * 1024

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

// ── 安全：地址检查 ────────────────────────────────────────────

/** 内网/保留地址判定 */
export function isPrivateAddress(ip) {
  const v = String(ip ?? '').trim()
  if (!v) return true
  if (net.isIPv4(v)) {
    const p = v.split('.').map(Number)
    if (p[0] === 10) return true
    if (p[0] === 127) return true
    if (p[0] === 0) return true
    if (p[0] === 169 && p[1] === 254) return true
    if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true
    if (p[0] === 192 && p[1] === 168) return true
    if (p[0] === 100 && p[1] >= 64 && p[1] <= 127) return true
    return false
  }
  if (net.isIPv6(v)) {
    const low = v.toLowerCase()
    if (low === '::1' || low === '::') return true
    if (low.startsWith('fc') || low.startsWith('fd')) return true
    if (low.startsWith('fe80')) return true
    // ::ffff:127.0.0.1 这类映射
    const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(low)
    if (m) return isPrivateAddress(m[1])
    return false
  }
  return true
}

/**
 * 校验并返回可抓取的 URL；不安全就抛错（调用方负责转成"如实拒绝"）。
 */
export async function assertFetchable(rawUrl) {
  let u
  try {
    u = new URL(String(rawUrl ?? '').trim())
  } catch {
    throw new Error(`不是合法的网址：${String(rawUrl).slice(0, 60)}`)
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error(`只支持 http/https，收到 ${u.protocol}`)
  }
  const host = u.hostname.toLowerCase()
  if (!host) throw new Error('网址没有主机名')
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) {
    throw new Error(`不允许访问本机/内网地址：${host}`)
  }
  // 域名 → IP，拒绝内网
  let addrs = []
  try {
    if (net.isIP(host)) addrs = [{ address: host }]
    else addrs = await dns.lookup(host, { all: true })
  } catch {
    throw new Error(`解析不了这个域名：${host}`)
  }
  for (const a of addrs) {
    if (isPrivateAddress(a.address)) {
      // 这台机器的 hosts 里把不少域名指到了 127.0.0.1（去广告/屏蔽用），
      // 所以"解析到内网"不等于有人在做 SSRF —— 要让人一眼看懂是这个原因。
      const loopback = /^(?:127\.|::1$|0\.0\.0\.0$)/.test(a.address)
      const hint = loopback
        ? `这个域名在你本机被 hosts 指到了本地（${host} → ${a.address}），可能是去广告/屏蔽规则；要么改用别的站点，要么先改 hosts`
        : `拒绝访问内网地址（${host} → ${a.address}）`
      throw new Error(hint)
    }
  }
  return u
}

// ── HTML → 纯文本 ────────────────────────────────────────────

const ENTITIES = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&apos;': "'",
  '&nbsp;': ' ',
  '&ensp;': ' ',
  '&emsp;': ' ',
  '&middot;': '·',
  '&hellip;': '…',
  '&mdash;': '—',
  '&ndash;': '-',
  '&ldquo;': '“',
  '&rdquo;': '”',
  '&lsquo;': '‘',
  '&rsquo;': '’',
}

export function decodeEntities(s) {
  return String(s ?? '')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => {
      const c = parseInt(h, 16)
      return Number.isFinite(c) && c > 0 && c < 0x10ffff ? String.fromCodePoint(c) : ''
    })
    .replace(/&#(\d+);/g, (_, d) => {
      const c = Number(d)
      return Number.isFinite(c) && c > 0 && c < 0x10ffff ? String.fromCodePoint(c) : ''
    })
    .replace(/&[a-z]+;/gi, (m) => ENTITIES[m.toLowerCase()] ?? m)
}

/** 把 HTML 转成可读纯文本 */
export function htmlToText(html) {
  let s = String(html ?? '')
  // 去掉整块不需要的
  s = s.replace(/<script[\s\S]*?<\/script>/gi, ' ')
  s = s.replace(/<style[\s\S]*?<\/style>/gi, ' ')
  s = s.replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
  s = s.replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
  s = s.replace(/<!--[\s\S]*?-->/g, ' ')
  // 块级标签转换行
  s = s.replace(/<\/?(?:p|div|br|li|tr|h[1-6]|section|article|header|footer|table|ul|ol)\b[^>]*>/gi, '\n')
  // 其余标签剥掉
  s = s.replace(/<[^>]+>/g, ' ')
  s = decodeEntities(s)
  // 空白整理
  s = s.replace(/[ \t\u00a0]+/g, ' ')
  s = s.replace(/\n{3,}/g, '\n\n')
  return s.trim()
}

/** 从 HTML 里抠 <title> */
export function extractTitle(html) {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(String(html ?? ''))
  return m ? decodeEntities(m[1]).replace(/\s+/g, ' ').trim().slice(0, 200) : ''
}

// ── 抓网页 ──────────────────────────────────────────────────

/**
 * 抓一个网页并转成纯文本。
 * @returns {Promise<{ok:boolean, url?:string, title?:string, text?:string, status?:number, reason?:string}>}
 */
export async function fetchPage(rawUrl, { maxChars = MAX_TEXT_CHARS, timeoutMs = DEFAULT_TIMEOUT_MS, fetchImpl = fetch } = {}) {
  let u
  try {
    u = await assertFetchable(rawUrl)
  } catch (err) {
    return { ok: false, reason: err?.message ?? String(err) }
  }

  let res
  try {
    res = await fetchImpl(u.toString(), {
      headers: {
        'user-agent': UA,
        accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
        'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (err) {
    return { ok: false, reason: `抓取失败：${err?.message ?? err}` }
  }

  if (!res.ok) {
    return { ok: false, status: res.status, reason: `HTTP ${res.status}（${res.statusText || '请求失败'}）` }
  }

  const ct = String(res.headers.get('content-type') ?? '')
  const buf = await res.arrayBuffer()
  if (buf.byteLength > MAX_BYTES) {
    return { ok: false, status: res.status, reason: `页面太大（${Math.round(buf.byteLength / 1024)} KB > 4 MB），没有读完` }
  }
  const html = Buffer.from(buf).toString('utf8')

  // JSON 直接格式化，别按 HTML 处理
  if (ct.includes('json')) {
    let pretty = html
    try {
      pretty = JSON.stringify(JSON.parse(html), null, 2)
    } catch {
      /* 保持原文 */
    }
    return {
      ok: true,
      url: u.toString(),
      title: '(JSON)',
      text: pretty.slice(0, maxChars),
      status: res.status,
      truncated: pretty.length > maxChars,
    }
  }

  const text = htmlToText(html)
  if (!text) {
    return { ok: false, status: res.status, reason: '页面里没有可读文本（可能是图片/脚本页）' }
  }
  return {
    ok: true,
    url: u.toString(),
    title: extractTitle(html) || u.hostname,
    text: text.slice(0, maxChars),
    status: res.status,
    truncated: text.length > maxChars,
  }
}

/**
 * 解析必应 CN 的结果页。
 * 导出出来是为了能单独测（HTML 结构变了要能立刻发现）。
 */
export function parseBingResults(html, limit = 5) {
  const out = []
  const src = String(html ?? '')
  // 每条结果在 <li class="b_algo"> 里，标题是 h2 > a
  const blocks = src.split(/<li class="b_algo"/i).slice(1)
  for (const b of blocks) {
    if (out.length >= limit) break
    const t = /<h2[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(b)
    if (!t) continue
    const url = decodeEntities(t[1])
    const title = htmlToText(t[2])
    if (!url || !title) continue
    // 摘要：<p> 里最长的那个
    let snippet = ''
    for (const m of b.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)) {
      const s = htmlToText(m[1])
      if (s.length > snippet.length) snippet = s
    }
    if (!snippet) {
      const m2 = /<div class="b_caption"[^>]*>([\s\S]{0,600}?)<\/div>/i.exec(b)
      if (m2) snippet = htmlToText(m2[1])
    }
    if (!/^https?:\/\//i.test(url)) continue
    out.push({ title: title.slice(0, 120), url, snippet: snippet.slice(0, 240) })
  }
  return out
}

/**
 * 联网搜索。
 * @returns {Promise<{ok:boolean, query?:string, results?:Array, reason?:string}>}
 */
export async function searchWeb(rawQuery, { limit = 5, timeoutMs = DEFAULT_TIMEOUT_MS, fetchImpl = fetch } = {}) {
  const query = String(rawQuery ?? '').trim()
  if (!query) return { ok: false, reason: '搜索词是空的' }
  if (query.length > 200) return { ok: false, reason: '搜索词太长（上限 200 字）' }

  const url = `https://cn.bing.com/search?q=${encodeURIComponent(query)}&setlang=zh-CN&ensearch=0`
  let res
  try {
    res = await fetchImpl(url, {
      headers: {
        'user-agent': UA,
        accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
        'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (err) {
    return { ok: false, reason: `搜索请求失败：${err?.message ?? err}` }
  }
  if (!res.ok) return { ok: false, reason: `搜索接口返回 HTTP ${res.status}` }

  const html = await res.text()
  const results = parseBingResults(html, limit)
  if (!results.length) {
    // 反爬或结构变了 —— 如实说，别编
    if (/验证码|安全验证|人机验证/.test(html)) {
      return { ok: false, reason: '搜索被反爬拦住了（要人机验证），这次查不了' }
    }
    return { ok: false, reason: '没解析出结果（可能是没搜到，也可能是搜索页面结构变了）' }
  }
  return { ok: true, query, results }
}

// ── 工具定义（交给模型调用） ──────────────────────────────────

export const WEB_SEARCH_TOOL_NAME = 'web_search'
export const WEB_FETCH_TOOL_NAME = 'web_fetch'

export const WEB_TOOLS = [
  {
    type: 'function',
    function: {
      name: WEB_SEARCH_TOOL_NAME,
      description:
        '联网搜索。当你不知道最新的事实、新闻、价格、天气、某个东西是什么，' +
        '而主人又期望你答得准时调用。搜到的是**网页摘要**，不是真相本身。\n' +
        '【硬规则】\n' +
        '1. 只搜当前话题真正需要的词，不要用搜索代替思考。\n' +
        '2. 搜到的内容必须**说清来源**（「据某某网站」），不要当成自己的知识。\n' +
        '3. 搜不到就如实说「没搜到」，**绝对不要编**一个看起来合理的答案。\n' +
        '4. 需要正文细节时，再对某条结果的 url 调用 web_fetch。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '搜索词，中文即可，越具体越好' },
          limit: {
            type: 'number',
            description: '要几条结果，默认 5，最多 10',
          },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: WEB_FETCH_TOOL_NAME,
      description:
        '抓取一个网页并读它的正文（自动去掉标签、脚本）。用于：主人给了链接、' +
        '或搜索结果里某条摘要不够、需要看详细内容时。\n' +
        '【硬规则】\n' +
        '1. 只抓公开网页；抓不到就如实说，不要编内容。\n' +
        '2. 抓到的内容是**别人写的**，转述时要说明出处，不要当成你自己的判断。\n' +
        '3. 不要抓登录后才能看的页面（会失败）。',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: '要抓取的网址（http/https）' },
          max_chars: { type: 'number', description: '最多读多少字，默认 6000' },
        },
        required: ['url'],
      },
    },
  },
]

/** 给模型看的结果格式化（纯文本，控制长度） */
export function formatSearchForModel(result) {
  if (!result?.ok) return `搜索失败：${result?.reason ?? '未知原因'}。（如实告诉对方没查到，不要编）`
  const lines = [`搜索「${result.query}」找到 ${result.results.length} 条：`]
  result.results.forEach((r, i) => {
    lines.push(`${i + 1}. ${r.title}`)
    lines.push(`   ${r.url}`)
    if (r.snippet) lines.push(`   ${r.snippet}`)
  })
  lines.push('（以上是网页摘要，转述时请说明来源；不确定的不要当成事实。）')
  return lines.join('\n')
}

export function formatFetchForModel(result) {
  if (!result?.ok) return `抓取失败：${result?.reason ?? '未知原因'}。（如实说没打开，不要编内容）`
  const head = `网页：${result.title || '(无标题)'}\n地址：${result.url}\nHTTP ${result.status}`
  const tail = result.truncated ? '\n（正文过长，已截断）' : ''
  return `${head}\n\n${result.text}${tail}`
}
