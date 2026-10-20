/**
 * web-tools.test.js —— 联网查阅的单元测试。
 *
 * 不联网：所有网络调用都用假的 fetchImpl 注入，测的是**解析、清洗、安全边界**。
 * 真实联网的冒烟由 scripts/check-web.mjs 负责（需要网络，不进 CI）。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  assertFetchable,
  decodeEntities,
  extractTitle,
  fetchPage,
  formatFetchForModel,
  formatSearchForModel,
  htmlToText,
  isPrivateAddress,
  parseBingResults,
  searchWeb,
  WEB_TOOLS,
  WEB_SEARCH_TOOL_NAME,
  WEB_FETCH_TOOL_NAME,
} from '../src/media/web-tools.js'

// ── 安全边界 ────────────────────────────────────────────────

test('联网：内网地址判定覆盖回环/私网/链路本地/IPv6', () => {
  for (const ip of [
    '127.0.0.1',
    '127.1.2.3',
    '10.0.0.1',
    '192.168.1.1',
    '172.16.0.1',
    '172.31.255.255',
    '169.254.1.1',
    '0.0.0.0',
    '100.64.0.1',
    '::1',
    'fc00::1',
    'fe80::1',
    '::ffff:127.0.0.1',
  ]) {
    assert.equal(isPrivateAddress(ip), true, `${ip} 应该被判为内网`)
  }
  for (const ip of ['8.8.8.8', '1.1.1.1', '202.89.233.100', '2001:df2:e500:ed1a::1']) {
    assert.equal(isPrivateAddress(ip), false, `${ip} 应该是公网`)
  }
})

test('联网：非 http/https 与 localhost 一律拒绝', async () => {
  await assert.rejects(() => assertFetchable('file:///C:/Windows/win.ini'), /只支持 http/)
  await assert.rejects(() => assertFetchable('javascript:alert(1)'), /只支持 http/)
  await assert.rejects(() => assertFetchable('ftp://example.com/x'), /只支持 http/)
  await assert.rejects(() => assertFetchable('http://localhost:8080/x'), /本机\/内网|内网/)
  await assert.rejects(() => assertFetchable('http://127.0.0.1/x'), /内网|本机/)
  await assert.rejects(() => assertFetchable('http://192.168.0.1/x'), /内网|本机/)
  await assert.rejects(() => assertFetchable('不是网址'), /不是合法的网址/)
})

// ── HTML 清洗 ───────────────────────────────────────────────

test('联网：htmlToText 去脚本/样式/标签，块级转行', () => {
  const html = `
    <html><head><title>标题 A</title><style>.x{color:red}</style></head>
    <body>
      <script>alert('x')</script>
      <h1>大标题</h1>
      <p>第一段 <b>加粗</b></p>
      <p>第二段</p>
      <!-- 注释 -->
    </body></html>`
  const text = htmlToText(html)
  assert.ok(!text.includes('alert'), '脚本必须被去掉')
  assert.ok(!text.includes('color:red'), '样式必须被去掉')
  assert.ok(!text.includes('注释'), '注释必须被去掉')
  assert.ok(text.includes('大标题'))
  assert.ok(text.includes('第一段 加粗'), '标签内文字要保留且空格合理')
  assert.ok(text.includes('\n'), '块级标签要转换行')
  assert.equal(extractTitle(html), '标题 A')
})

test('联网：实体解码（命名/十进制/十六进制）', () => {
  assert.equal(decodeEntities('a&amp;b'), 'a&b')
  assert.equal(decodeEntities('&lt;tag&gt;'), '<tag>')
  assert.equal(decodeEntities('&#39;q&#39;'), "'q'")
  assert.equal(decodeEntities('&#x4e2d;&#x6587;'), '中文')
  assert.equal(decodeEntities('&nbsp;x'), ' x')
  // 未知实体保持原样，不要吞掉
  assert.equal(decodeEntities('&unknownentity;'), '&unknownentity;')
})

test('联网：抓网页遇到二进制/空正文要如实失败', async () => {
  const fakeFetch = async () => new Response('', { status: 200, headers: { 'content-type': 'image/png' } })
  const r = await fetchPage('https://example.com/x', { fetchImpl: fakeFetch })
  assert.equal(r.ok, false)
  assert.match(r.reason, /没有可读文本|读不出/)
})

test('联网：抓网页把 JSON 格式化后再截断', async () => {
  const fakeFetch = async () =>
    new Response(JSON.stringify({ a: 1, b: [1, 2, 3] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  const r = await fetchPage('https://example.com/j', { fetchImpl: fakeFetch, maxChars: 50 })
  assert.equal(r.ok, true)
  assert.equal(r.title, '(JSON)')
  assert.ok(r.text.includes('"a": 1'), 'JSON 应该被 pretty print')
})

test('联网：HTTP 非 2xx 要如实报错，不假装成功', async () => {
  const fakeFetch = async () => new Response('nope', { status: 403, statusText: 'Forbidden' })
  const r = await fetchPage('https://example.com/x', { fetchImpl: fakeFetch })
  assert.equal(r.ok, false)
  assert.equal(r.status, 403)
  assert.match(r.reason, /403/)
})

// ── 搜索结果解析 ────────────────────────────────────────────

test('联网：parseBingResults 能解析标题/链接/摘要，且跳过非 http 链接', () => {
  const html = `
    <ol id="b_results">
      <li class="b_algo">
        <h2><a href="https://a.example/1">第一条 &amp; 标题</a></h2>
        <div class="b_caption"><p>第一条的摘要内容。</p></div>
      </li>
      <li class="b_algo">
        <h2><a href="javascript:void(0)">坏链接</a></h2>
        <p>不该被收进来</p>
      </li>
      <li class="b_algo">
        <h2><a href="https://b.example/2">第二条</a></h2>
        <p>第二条的摘要。</p>
      </li>
    </ol>`
  const out = parseBingResults(html, 5)
  assert.equal(out.length, 2, 'javascript: 链接必须被丢掉')
  assert.equal(out[0].title, '第一条 & 标题', '标题要解码实体')
  assert.equal(out[0].url, 'https://a.example/1')
  assert.ok(out[0].snippet.includes('第一条的摘要'))
  assert.equal(out[1].url, 'https://b.example/2')
})

test('联网：搜索失败时返回原因，不返回空数组冒充成功', async () => {
  const fakeFetch = async () => new Response('<html>no results here</html>', { status: 200 })
  const r = await searchWeb('随便什么', { fetchImpl: fakeFetch })
  assert.equal(r.ok, false)
  assert.ok(r.reason)
})

test('联网：搜索遇到人机验证要明确说出来', async () => {
  const fakeFetch = async () => new Response('<html>请完成安全验证</html>', { status: 200 })
  const r = await searchWeb('随便什么', { fetchImpl: fakeFetch })
  assert.equal(r.ok, false)
  assert.match(r.reason, /反爬|验证/)
})

test('联网：搜索词为空/过长直接拒绝，不发请求', async () => {
  let called = 0
  const fakeFetch = async () => {
    called += 1
    return new Response('', { status: 200 })
  }
  assert.equal((await searchWeb('', { fetchImpl: fakeFetch })).ok, false)
  assert.equal((await searchWeb('x'.repeat(201), { fetchImpl: fakeFetch })).ok, false)
  assert.equal(called, 0, '校验不过就不该发请求')
})

// ── 给模型的格式化 ──────────────────────────────────────────

test('联网：成功结果带来源与「别当事实」的提醒', async () => {
  const fakeFetch = async () =>
    new Response(
      '<ol><li class="b_algo"><h2><a href="https://a.example/1">标题一</a></h2><p>摘要一</p></li></ol>',
      { status: 200 },
    )
  const r = await searchWeb('测试', { fetchImpl: fakeFetch })
  const text = formatSearchForModel(r)
  assert.ok(text.includes('标题一'))
  assert.ok(text.includes('https://a.example/1'), '必须给出链接，方便她引用来源')
  assert.ok(text.includes('摘要'), '必须带上摘要')
})

test('联网：失败时格式化明确要求「不要编」', () => {
  const text = formatSearchForModel({ ok: false, reason: '网络不通' })
  assert.match(text, /网络不通/)
  assert.match(text, /不要编/)
  const text2 = formatFetchForModel({ ok: false, reason: 'HTTP 404' })
  assert.match(text2, /404/)
  assert.match(text2, /不要编/)
})

// ── 工具定义 ────────────────────────────────────────────────

test('联网：工具定义完整（名称/描述/必填参数）', () => {
  assert.equal(WEB_TOOLS.length, 2)
  const byName = Object.fromEntries(WEB_TOOLS.map((t) => [t.function.name, t]))
  assert.ok(byName[WEB_SEARCH_TOOL_NAME])
  assert.ok(byName[WEB_FETCH_TOOL_NAME])
  for (const t of WEB_TOOLS) {
    assert.equal(t.type, 'function')
    assert.ok(t.function.description.length > 40, '描述要够长，模型才知道什么时候用')
    assert.match(t.function.description, /不要编|如实/, '必须写清"不许编"的硬规则')
  }
  assert.deepEqual(byName[WEB_SEARCH_TOOL_NAME].function.parameters.required, ['query'])
  assert.deepEqual(byName[WEB_FETCH_TOOL_NAME].function.parameters.required, ['url'])
})
