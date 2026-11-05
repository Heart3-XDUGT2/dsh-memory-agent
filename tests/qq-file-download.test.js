/**
 * 034：实际ReadableStream假fetch；不访问QQ/外网/用户文件，不写下载原件。
 * 运行：node --test --import ./tests/_isolate.mjs tests/qq-file-download.test.js
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setTimeout as delay, setImmediate as tick } from 'node:timers/promises'
import { createFileDownloader } from '../lib/qq-file-download.js'

const URL_A = 'https://files.invalid/a'
const bytes = value => typeof value === 'string' ? new TextEncoder().encode(value) : Uint8Array.from(value)
function stream (chunks = [], { hang = false, status = 200, headers = {} } = {}) {
  let cancelled = 0
  const body = new ReadableStream({
    start (controller) {
      for (const chunk of chunks) controller.enqueue(typeof chunk === 'string' ? bytes(chunk) : chunk)
      if (!hang) controller.close()
    },
    cancel () { cancelled++ }
  })
  return { response: new Response(body, { status, headers }), body, cancelled: () => cancelled }
}
function downloader (t, options = {}) {
  const instance = createFileDownloader({ timeoutMs: 100, ...options })
  t.after(() => instance.close())
  return instance
}
function failure (result, code, count) {
  assert.equal(result.ok, false)
  assert.equal(result.code, code)
  assert.equal(result.bytesRead, count)
  assert.equal('data' in result, false, '失败不保留部分或超限字节')
  assert.equal(typeof result.reason, 'string')
  assert.equal(typeof result.hint, 'string')
}

test('034 download：逐块读取UTF8字节，成功只返回有界bytes与安全MIME', async t => {
  const partA = bytes('甲'), partB = bytes('乙')
  const s = stream([partA, partB], { headers: { 'content-type': 'text/plain; charset=utf-8' } })
  const d = downloader(t, { maxFileBytes: 6, fetchImpl: async () => s.response })
  const result = await d.download({ url: URL_A })
  assert.equal(result.ok, true)
  assert.ok(result.data instanceof Uint8Array)
  assert.equal(new TextDecoder().decode(result.data), '甲乙')
  assert.equal(result.bytes, 6)
  assert.equal(result.contentType, 'text/plain')
  assert.equal(s.body.locked, false)
  assert.equal('url' in result, false)
})

test('034 download：无Content-Length，真实超限立即取消且计入触发chunk', async t => {
  const s = stream([bytes([1, 2, 3, 4]), bytes([5, 6, 7, 8, 9])], { hang: true })
  let signal
  const d = downloader(t, { maxFileBytes: 8, fetchImpl: async (_url, options) => { signal = options.signal; return s.response } })
  const result = await d.download({ url: URL_A })
  failure(result, 'SIZE_LIMIT', 9)
  assert.equal(signal.aborted, true)
  assert.equal(s.cancelled(), 1)
  assert.equal(s.body.locked, false)
})

test('034 download：声明很小也不能绕过真实大小', async t => {
  const s = stream([bytes([1, 2]), bytes([3, 4, 5])], { hang: true })
  const d = downloader(t, { maxFileBytes: 4, fetchImpl: async () => s.response })
  failure(await d.download({ url: URL_A, declaredSize: 0 }), 'SIZE_LIMIT', 5)
  assert.equal(s.cancelled(), 1)
})

test('034 download：刚好到上限可成功，未知长度不当作0字节', async t => {
  const d = downloader(t, { maxFileBytes: 4, fetchImpl: async () => stream([bytes([1, 2]), bytes([3, 4])]).response })
  const result = await d.download({ url: URL_A })
  assert.equal(result.ok, true)
  assert.deepEqual([...result.data], [1, 2, 3, 4])
  assert.equal(result.bytes, 4)
})

test('034 download：声明大小提前拒绝，不发fetch', async t => {
  let calls = 0
  const d = downloader(t, { maxFileBytes: 4, fetchImpl: async () => { calls++; return stream(['x']).response } })
  failure(await d.download({ url: URL_A, declaredSize: 5 }), 'SIZE_LIMIT', 0)
  assert.equal(calls, 0)
})

test('034 download：响应长度提前拒绝并取消未读body', async t => {
  const s = stream([], { hang: true, headers: { 'content-length': '9999999999999999999999' } })
  let signal
  const d = downloader(t, { maxFileBytes: 4, fetchImpl: async (_url, options) => { signal = options.signal; return s.response } })
  failure(await d.download({ url: URL_A }), 'SIZE_LIMIT', 0)
  assert.equal(s.cancelled(), 1)
  assert.equal(signal.aborted, true)
})

test('034 download：byteLimit只能下调且失败按实际收到字节结算', async t => {
  const s = stream([bytes([1, 2]), bytes([3, 4, 5])], { hang: true })
  const d = downloader(t, { maxFileBytes: 8, fetchImpl: async () => s.response })
  failure(await d.download({ url: URL_A, byteLimit: 4 }), 'SIZE_LIMIT', 5)
})

test('034 download：剩余预算为0不查询，不能上调构造预算', async t => {
  let calls = 0
  const d = downloader(t, { maxFileBytes: 4, fetchImpl: async () => { calls++; return stream(['x']).response } })
  failure(await d.download({ url: URL_A, byteLimit: 0 }), 'SIZE_LIMIT', 0)
  failure(await d.download({ url: URL_A, byteLimit: 5 }), 'INVALID_INPUT', 0)
  assert.equal(calls, 0)
})

test('034 download：不支持协议、本机路径、URL账号密码与坏URL均不fetch', async t => {
  let calls = 0
  const d = downloader(t, { fetchImpl: async () => { calls++; return stream(['x']).response } })
  for (const url of ['file:///C:/fake/a.txt', 'C:\\fake\\a.txt', '/fake/a.txt', 'data:text/plain,hello',
    'ftp://files.invalid/a', 'https://user:secret@files.invalid/a', 'https://user@files.invalid/a', 'not-a-url', 'http:example.invalid']) {
    failure(await d.download({ url }), 'INVALID_URL', 0)
  }
  assert.equal(calls, 0)
})

test('034 download：已取消输入不发请求，不回显signal reason', async t => {
  const controller = new AbortController()
  controller.abort('synthetic-private-reason')
  let calls = 0
  const d = downloader(t, { fetchImpl: async () => { calls++; return stream(['x']).response } })
  const result = await d.download({ url: URL_A, signal: controller.signal })
  failure(result, 'ABORTED', 0)
  assert.equal(calls, 0)
  assert.equal(JSON.stringify(result).includes('synthetic-private-reason'), false)
})

test('034 download：等待响应头也受总超时约束', async t => {
  let signal
  const d = downloader(t, { timeoutMs: 20, fetchImpl: (_url, options) => { signal = options.signal; return new Promise(() => {}) } })
  failure(await d.download({ url: URL_A }), 'TIMEOUT', 0)
  assert.equal(signal.aborted, true)
})

test('034 download：慢响应正文覆盖在同一个超时里，已读字节保留计数', async t => {
  const s = stream(['abc'], { hang: true })
  let signal
  const d = downloader(t, { timeoutMs: 25, fetchImpl: async (_url, options) => { signal = options.signal; return s.response } })
  failure(await d.download({ url: URL_A }), 'TIMEOUT', 3)
  assert.equal(signal.aborted, true)
  assert.equal(s.cancelled(), 1)
  assert.equal(s.body.locked, false)
})

test('034 download：响应头等待时可取消，即使fetch不合作也能结算', async t => {
  const controller = new AbortController()
  let signal
  const d = downloader(t, { fetchImpl: (_url, options) => { signal = options.signal; return new Promise(() => {}) } })
  const pending = d.download({ url: URL_A, signal: controller.signal })
  await tick()
  controller.abort()
  failure(await pending, 'ABORTED', 0)
  assert.equal(signal.aborted, true)
})

test('034 download：正文等待时可取消且取消reader', async t => {
  const controller = new AbortController()
  const s = stream(['abc'], { hang: true })
  const d = downloader(t, { fetchImpl: async () => s.response })
  const pending = d.download({ url: URL_A, signal: controller.signal })
  await tick()
  controller.abort()
  failure(await pending, 'ABORTED', 3)
  assert.equal(s.cancelled(), 1)
  assert.equal(s.body.locked, false)
})

test('034 download：原生read交付字节后同步取消仍结算实际已交付块', async t => {
  const controller = new AbortController()
  const body = new ReadableStream({
    pull (sink) {
      sink.enqueue(new Uint8Array(8))
      controller.abort()
    }
  }, { highWaterMark: 0 })
  const d = downloader(t, { maxFileBytes: 8, fetchImpl: async () => new Response(body) })
  const result = await d.download({ url: URL_A, signal: controller.signal })
  failure(result, 'ABORTED', 8)
  assert.equal(body.locked, false)
})

test('034 download：原生read同一微任务跨过期限仍计实读，未完正文另保留预算', async t => {
  const body = new ReadableStream({
    pull (sink) {
      const until = performance.now() + 60
      while (performance.now() < until) {}
      sink.enqueue(new Uint8Array(8))
    }
  }, { highWaterMark: 0 })
  const d = downloader(t, { maxFileBytes: 12, timeoutMs: 30, fetchImpl: async () => new Response(body) })
  const result = await d.download({ url: URL_A })
  failure(result, 'TIMEOUT', 8)
  assert.equal(result.budgetCharge, 12, '保守占额单独返回，不能冒称12字节实际已读')
  assert.equal(body.locked, false)
})

test('034 download：不合作read取消后仍占本次额度，迟到块不使12字节批次预算复原', async t => {
  const controller = new AbortController()
  let resolveRead, markStarted, calls = 0, cancelled = 0, released = 0
  const started = new Promise(resolve => { markStarted = resolve })
  const reader = {
    read () {
      markStarted()
      return new Promise(resolve => { resolveRead = resolve })
    },
    cancel () { cancelled++; return new Promise(() => {}) },
    releaseLock () { released++ }
  }
  const response = { status: 200, headers: new Headers(), body: { getReader: () => reader } }
  const d = downloader(t, { maxFileBytes: 8, fetchImpl: async () => { calls++; return response } })
  const pending = d.download({ url: URL_A, signal: controller.signal })
  await started
  controller.abort()
  const result = await pending
  failure(result, 'ABORTED', 0)
  assert.equal(result.budgetCharge, 8, '未知迟到正文按受控byteLimit保守占额')
  assert.equal(cancelled, 1)
  assert.equal(released, 1)
  const remaining = 12 - Math.max(result.bytesRead, result.budgetCharge || 0)
  assert.equal(remaining, 4)
  const snapshot = JSON.stringify(result)
  resolveRead({ done: false, value: new Uint8Array(8) })
  await tick()
  assert.equal(JSON.stringify(result), snapshot, '结算后不把迟到字节改写成早先已知')
  failure(await d.download({ url: URL_A, declaredSize: 8, byteLimit: remaining }), 'SIZE_LIMIT', 0)
  assert.equal(calls, 1, '余下4字节不能重新放行第二份8字节文件')
})

test('034 download：重定向手工跟随，跨源也没有本机凭据或referrer', async t => {
  const calls = []
  const first = stream([], { hang: true, status: 302, headers: { location: 'https://cdn.invalid/final' } })
  const d = downloader(t, {
    headers: { authorization: 'synthetic-local-secret', cookie: 'synthetic-cookie' },
    fetchImpl: async (url, options) => {
      calls.push({ url, options })
      return calls.length === 1 ? first.response : stream(['done']).response
    }
  })
  const result = await d.download({ url: URL_A, headers: { authorization: 'synthetic-local-secret' } })
  assert.equal(result.ok, true)
  assert.deepEqual(calls.map(call => call.url), [URL_A, 'https://cdn.invalid/final'])
  for (const { options } of calls) {
    assert.equal(options.method, 'GET')
    assert.equal(options.redirect, 'manual')
    assert.equal(options.credentials, 'omit')
    assert.equal(options.referrerPolicy, 'no-referrer')
    assert.equal(new Headers(options.headers).has('authorization'), false)
    assert.equal(new Headers(options.headers).has('cookie'), false)
  }
  assert.equal(first.cancelled(), 1)
})

test('034 download：相对重定向合法，原URL片段不参与循环身份', async t => {
  const calls = []
  const d = downloader(t, { fetchImpl: async url => {
    calls.push(url)
    return calls.length === 1
      ? stream([], { status: 303, headers: { location: '../final' } }).response
      : stream(['x']).response
  } })
  assert.equal((await d.download({ url: 'https://files.invalid/dir/start#fragment' })).ok, true)
  assert.deepEqual(calls, ['https://files.invalid/dir/start', 'https://files.invalid/final'])
})

test('034 download：重定向到不支持协议或URL凭据时不跟随', async t => {
  for (const location of ['file:///C:/fake/a.txt', 'data:text/plain,x', 'https://user:secret@cdn.invalid/a']) {
    let calls = 0
    const s = stream([], { hang: true, status: 302, headers: { location } })
    const d = downloader(t, { fetchImpl: async () => { calls++; return s.response } })
    const result = await d.download({ url: URL_A })
    failure(result, 'UNSAFE_REDIRECT', 0)
    assert.equal(calls, 1)
    assert.equal(s.cancelled(), 1)
    assert.equal(JSON.stringify(result).includes('secret'), false)
  }
})

test('034 download：缺失Location、未知3xx与循环都固定拒绝', async t => {
  for (const [status, headers, code] of [
    [302, {}, 'UNSAFE_REDIRECT'],
    [300, { location: '/next' }, 'HTTP_ERROR'],
    [307, { location: '/a#other' }, 'REDIRECT_LOOP']
  ]) {
    let calls = 0
    const d = downloader(t, { fetchImpl: async () => { calls++; return stream([], { status, headers }).response } })
    failure(await d.download({ url: URL_A }), code, 0)
    assert.equal(calls, 1)
  }
})

test('034 download：最多跟3跳，所有跳转共用总期限', async t => {
  let calls = 0
  const d = downloader(t, { fetchImpl: async () => {
    calls++
    return stream([], { status: 308, headers: { location: '/redirect-' + calls } }).response
  } })
  failure(await d.download({ url: URL_A }), 'REDIRECT_LIMIT', 0)
  assert.equal(calls, 4)
})

test('034 download：重定向头部延迟累计到同一个超时', async t => {
  let calls = 0
  const d = downloader(t, { timeoutMs: 180, fetchImpl: async (_url, options) => {
    calls++
    await delay(110)
    if (options.signal.aborted) throw Error('stopped')
    return stream([], { status: 302, headers: { location: '/r-' + calls } }).response
  } })
  failure(await d.download({ url: URL_A }), 'TIMEOUT', 0)
  assert.equal(calls, 2)
})

test('034 download：忽略abort而迟到的fetch响应也取消正文', async t => {
  let resolveFetch
  const s = stream(['late'], { hang: true })
  const d = downloader(t, { timeoutMs: 20, fetchImpl: () => new Promise(resolve => { resolveFetch = resolve }) })
  failure(await d.download({ url: URL_A }), 'TIMEOUT', 0)
  resolveFetch(s.response)
  await tick()
  assert.equal(s.cancelled(), 1)
  assert.equal(s.body.locked, false)
})

test('034 download：body的取消Promise不合作也不会阻塞结算或遗留reader锁', async t => {
  let cancelled = 0
  const body = new ReadableStream({
    start (controller) { controller.enqueue(bytes('abc')) },
    cancel () { cancelled++; return new Promise(() => {}) }
  })
  const d = downloader(t, { timeoutMs: 20, fetchImpl: async () => new Response(body) })
  failure(await d.download({ url: URL_A }), 'TIMEOUT', 3)
  assert.equal(cancelled, 1)
  assert.equal(body.locked, false)
})

test('034 download：fetch若自行跟随重定向，不能当作已校验成功', async t => {
  const s = stream(['x'])
  Object.defineProperty(s.response, 'redirected', { value: true })
  const d = downloader(t, { fetchImpl: async () => s.response })
  failure(await d.download({ url: URL_A }), 'UNSAFE_REDIRECT', 0)
})

test('034 download：HTTP失败、body不可读及非字节chunk不走无界arrayBuffer回退', async t => {
  let fallbackCalled = 0
  const badBody = { status: 200, ok: true, headers: new Headers(), body: {},
    arrayBuffer: () => { fallbackCalled++; throw Error('not-allowed') } }
  const d = downloader(t, { fetchImpl: async () => badBody })
  failure(await d.download({ url: URL_A }), 'BODY_UNAVAILABLE', 0)
  const badChunk = new Response(new ReadableStream({ start: controller => { controller.enqueue('not-bytes'); controller.close() } }))
  const d2 = downloader(t, { fetchImpl: async () => badChunk })
  failure(await d2.download({ url: URL_A }), 'INVALID_BODY', 0)
  const d3 = downloader(t, { fetchImpl: async () => stream([], { status: 403 }).response })
  failure(await d3.download({ url: URL_A }), 'HTTP_ERROR', 0)
  assert.equal(fallbackCalled, 0)
})

test('034 download：空文件与坏声明大小有明确失败，不编正文', async t => {
  let calls = 0
  const d = downloader(t, { fetchImpl: async () => { calls++; return new Response(null) } })
  failure(await d.download({ url: URL_A, declaredSize: -1 }), 'INVALID_INPUT', 0)
  failure(await d.download({ url: URL_A, declaredSize: 'not-a-size' }), 'INVALID_INPUT', 0)
  assert.equal(calls, 0)
  failure(await d.download({ url: URL_A, declaredSize: 0 }), 'EMPTY_BODY', 0)
})

test('034 download：下载异常不输出URL、令牌、本机路径或stack', async t => {
  let calls = 0
  const d = downloader(t, { fetchImpl: async () => {
    calls++
    throw Error('https://files.invalid/private-token C:\\fake\\private.txt')
  } })
  const result = await d.download({ url: URL_A })
  failure(result, 'DOWNLOAD_FAILED', 0)
  assert.equal(calls, 1)
  assert.doesNotMatch(JSON.stringify(result), /files\.invalid|private-token|private\.txt|stack/)
})

test('034 download：最多2个活动下载，超额无请求，取消后释放槽位', async t => {
  const a = new AbortController(), b = new AbortController()
  let calls = 0
  const d = downloader(t, { fetchImpl: () => { calls++; return new Promise(() => {}) } })
  const first = d.download({ url: URL_A, signal: a.signal })
  const second = d.download({ url: URL_A, signal: b.signal })
  await tick()
  failure(await d.download({ url: URL_A }), 'BUSY', 0)
  assert.equal(calls, 2)
  a.abort()
  failure(await first, 'ABORTED', 0)
  const c = new AbortController()
  const third = d.download({ url: URL_A, signal: c.signal })
  await tick()
  assert.equal(calls, 3)
  c.abort(); b.abort()
  failure(await third, 'ABORTED', 0)
  failure(await second, 'ABORTED', 0)
})

test('034 download：close取消活动任务并等结算，幂等且永久停止受理', async t => {
  const s = stream(['abc'], { hang: true })
  const d = downloader(t, { fetchImpl: async () => s.response })
  const pending = d.download({ url: URL_A })
  await tick()
  await d.close()
  failure(await pending, 'CLOSED', 3)
  await d.close()
  failure(await d.download({ url: URL_A }), 'CLOSED', 0)
  assert.equal(s.cancelled(), 1)
})

test('034 download：关闭不合作的响应头等待也能结算，关闭前未启动的请求不会发出', async t => {
  let calls = 0
  const d = downloader(t, { fetchImpl: () => { calls++; return new Promise(() => {}) } })
  const first = d.download({ url: URL_A })
  await tick()
  const second = d.download({ url: URL_A })
  await d.close()
  failure(await first, 'CLOSED', 0)
  failure(await second, 'CLOSED', 0)
  assert.equal(calls, 1)
})

test('034 download：非法受控配置不能抬高硬限额', () => {
  for (const options of [
    { maxFileBytes: 8 * 1024 * 1024 + 1 }, { maxFileBytes: 0 },
    { timeoutMs: 15001 }, { timeoutMs: 0 }, { maxRedirects: 4 },
    { maxConcurrent: 3 }, { maxConcurrent: 0 }, { fetchImpl: null }
  ]) assert.throws(() => createFileDownloader(options), /INVALID_DOWNLOAD_OPTIONS/)
})
