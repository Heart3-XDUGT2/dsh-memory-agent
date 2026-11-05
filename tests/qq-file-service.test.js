import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createFileService } from '../lib/qq-file-service.js'

const REF = 'a'.repeat(32)
const LABEL = '文件2026-11-02T03:04:05.006Z-1'
const scope = { chatType: 'private', chatId: '11', senderId: '11', isMaster: true }
const future = () => {
  let resolve
  const promise = new Promise(r => { resolve = r })
  return { resolve, promise }
}
async function waitFor (condition) {
  const until = Date.now() + 1000
  while (!condition() && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 1))
  assert.equal(condition(), true, '服务应开始受控提取')
}

function rig (t, options = {}) {
  let current = true, time = 1000, spent = 0
  const opened = [], finished = [], downloads = [], extracts = []
  const meta = { received: true, name: '资料.txt', ref: REF, label: LABEL, ...options.meta }
  const refs = new Set()
  const channel = {
    inspectFile: async ({ ref, source }) => current && ref === REF && source.chatId === scope.chatId
      ? { ok: true, ...meta } : { ok: false, reason: 'expired' },
    openFile: async args => {
      opened.push(args)
      if (refs.has(args.ref)) return { ok: false, reason: 'expired' }
      refs.add(args.ref)
      return { ok: true, ...meta, url: 'http://download.invalid/signed?token=fixture',
        byteLimit: 8 * 1024 * 1024, signal: args.signal, isCurrent: args.isCurrent,
        finish: n => { spent += n; finished.push(n) } }
    }
  }
  let liveChannel = channel
  const service = createFileService({
    channelOf: () => liveChannel,
    downloader: {
      download: async args => { downloads.push(args); return options.download ? options.download(args)
        : { ok: true, data: new TextEncoder().encode('原始输入'), bytes: 12 } },
      close: async () => {}
    },
    extractor: {
      extract: async args => { extracts.push(args); return options.extract ? options.extract(args) :
        { ok: true, format: 'txt', text: options.text ?? '正文'.repeat(10000), truncated: false, warnings: [] } },
      close: async () => {}
    },
    now: () => time, ...options.service
  })
  t.after(() => service.close())
  const controller = new AbortController()
  const read = patch => service.readFile({ ref: REF, offset: 0, source: scope,
    signal: controller.signal, isCurrent: () => current, ...patch })
  return { service, opened, finished, downloads, extracts, controller, read,
    setCurrent: value => { current = value }, clock: value => { time = value },
    swap: () => { liveChannel = { ...channel } }, spent: () => spent }
}

test('034服务：元数据后按需首读4000/续读8000，不重下、不存二进制', async t => {
  const h = rig(t)
  const first = await h.read()
  assert.equal(first.ok, true)
  assert.equal(first.text.length, 4000)
  assert.equal(first.start, 0)
  assert.equal(first.end, 4000)
  assert.equal(first.nextOffset, 4000)
  const next = await h.read({ offset: first.nextOffset })
  assert.equal(next.ok, true)
  assert.equal(next.text.length, 8000)
  assert.equal(next.start, 4000)
  assert.equal(next.end, 12000)
  assert.equal(h.opened.length, 1)
  assert.equal(h.downloads.length, 1)
  assert.equal(h.extracts.length, 1)
  assert.equal(h.spent(), 12)
  assert.doesNotMatch(JSON.stringify(next), /download\.invalid|token=|原始输入/)
})

test('034服务：UTF16窗口不拆emoji，非法游标不下载', async t => {
  const text = '甲'.repeat(3999) + '😀' + '乙'.repeat(9000)
  const h = rig(t, { text })
  assert.equal((await h.read({ offset: 4000 })).ok, false)
  assert.equal(h.downloads.length, 0)
  const first = await h.read()
  assert.equal(first.end, 3999)
  assert.equal((await h.read({ offset: 4000 })).reason, 'invalid-offset')
  const next = await h.read({ offset: 3999 })
  assert.equal(next.text.startsWith('😀'), true)
  assert.equal(first.text + next.text, text.slice(0, next.end))
})

test('034服务：提取截断/PDF完整保留页与展示游标分开', async t => {
  const h = rig(t, { meta: { name: '资料.pdf' },
    extract: () => ({ ok: true, format: 'pdf', text: '文'.repeat(5000), truncated: true,
      warnings: ['部分页面没有可提取文字。'], pages: 9, pagesRead: 2 }) })
  const first = await h.read()
  assert.equal(first.truncated, true)
  assert.equal(first.pages, 9)
  assert.equal(first.pagesRead, 2)
  const tail = await h.read({ offset: first.nextOffset })
  assert.equal(tail.nextOffset, null)
  assert.equal(tail.truncated, true)
  assert.equal('pageStart' in tail, false)
})

test('034服务：缓存绝对TTL到期请重发，禁止续读自动重新下载', async t => {
  const h = rig(t, { service: { ttlMs: 30 } })
  assert.equal((await h.read()).ok, true)
  h.clock(1031)
  assert.equal((await h.read()).reason, 'expired')
  assert.equal(h.downloads.length, 1)
})

test('034服务：文本缓存预算不足不重下原件', async t => {
  const h = rig(t, { service: { maxTextBytes: 20 } })
  assert.equal((await h.read()).ok, false)
  assert.equal((await h.read()).ok, false)
  assert.equal(h.downloads.length, 1)
})

test('034服务：缓存按UTF8/UTF16较大占用和项数淘汰，不能重新下载同一原件', async t => {
  for (const limits of [{ maxEntries: 1 }, { maxTextBytes: 30 }, { maxTextBytes: 50 }]) {
    const refs = [REF, 'b'.repeat(32)], attempted = new Set()
    let fetches = 0
    const meta = ref => ({ received: true, name: '资料.txt', ref,
      label: LABEL.slice(0, -1) + (refs.indexOf(ref) + 1) })
    const channel = {
      inspectFile: ({ ref }) => ({ ok: true, ...meta(ref) }),
      openFile: args => {
        if (attempted.has(args.ref)) return { ok: false, reason: 'expired' }
        attempted.add(args.ref)
        return { ok: true, ...meta(args.ref), url: 'http://download.invalid/',
          byteLimit: 100, signal: args.signal, isCurrent: args.isCurrent, finish: () => {} }
      }
    }
    const service = createFileService({
      channelOf: () => channel, ...limits,
      downloader: { download: async () => { fetches++; return { ok: true, data: new Uint8Array(1), bytes: 1 } }, close: async () => {} },
      extractor: { extract: async () => ({ ok: true, format: 'txt', text: '文'.repeat(10), truncated: false, warnings: [] }), close: async () => {} }
    })
    t.after(() => service.close())
    const read = ref => service.readFile({ ref, offset: 0, source: scope,
      signal: new AbortController().signal, isCurrent: () => true })
    assert.equal((await read(refs[0])).ok, true)
    assert.equal((await read(refs[1])).ok, true)
    assert.equal((await read(refs[0])).reason, 'expired')
    assert.equal(fetches, 2)
  }
})

for (const name of ['音频.mp3', '图片.jpg', '程序.exe', '旧版.doc', '宏.docm']) {
  test('034服务：不支持扩展名在取链接/下载前拒绝 ' + name, async t => {
    const h = rig(t, { meta: { name } })
    assert.equal((await h.read()).reason, 'unsupported')
    assert.equal(h.opened.length, 0)
    assert.equal(h.downloads.length, 0)
    assert.equal(h.extracts.length, 0)
  })
}

test('034服务：声明过大在取链接前拒绝，下载失败真实字节照计费', async t => {
  const large = rig(t, { meta: { declaredSize: 8388609 } })
  assert.equal((await large.read()).reason, 'too-large')
  assert.equal(large.opened.length, 0)
  const broken = rig(t, { download: () => ({ ok: false, code: 'SIZE_LIMIT', bytesRead: 5000,
    reason: 'http://secret.invalid', hint: 'arbitrary-error' }) })
  assert.equal((await broken.read()).ok, false)
  assert.equal(broken.spent(), 5000)
  assert.equal(broken.extracts.length, 0)
})

test('034服务：未决read取消的保守额度用于批次结算，不冒称实际bytesRead', async t => {
  const h = rig(t, { download: () => ({ ok: false, code: 'ABORTED', bytesRead: 7, budgetCharge: 9000 }) })
  assert.equal((await h.read()).ok, false)
  assert.equal(h.spent(), 9000)
  assert.equal(h.extracts.length, 0)
})

test('034服务：真实来源在缓存命中仍校验，不因相同ref跨聊天读', async t => {
  const h = rig(t)
  assert.equal((await h.read()).ok, true)
  assert.equal((await h.read({ source: { ...scope, chatId: '22' } })).ok, false)
  assert.equal(h.downloads.length, 1)
})

test('034服务：await中来源/服务/取消变化，不泄露正文且结束资源', async t => {
  for (const change of [h => h.setCurrent(false), h => h.swap(), h => h.controller.abort()]) {
    const gate = future()
    const h = rig(t, { extract: () => gate.promise })
    const pending = h.read()
    await waitFor(() => h.extracts.length > 0)
    change(h)
    gate.resolve({ ok: true, format: 'txt', text: '不得泄露的合成正文', truncated: false, warnings: [] })
    const value = await pending
    assert.equal(value.ok, false)
    assert.doesNotMatch(JSON.stringify(value), /不得泄露/)
    assert.equal(h.finished.length, 1)
  }
})

test('034服务：解析异常与任意诊断不透传；相同引用不并发重复下载', async t => {
  const gate = future()
  const h = rig(t, { extract: () => gate.promise })
  const pending = h.read()
  await waitFor(() => h.extracts.length > 0)
  assert.equal((await h.read()).reason, 'busy')
  gate.resolve({ ok: false, code: 'PDF_ENCRYPTED', reason: 'http://secret.invalid', hint: 'secret' })
  const result = await pending
  assert.equal(result.code, 'PDF_ENCRYPTED')
  assert.doesNotMatch(JSON.stringify(result), /secret\.invalid|secret/)
  assert.equal(h.downloads.length, 1)
})

test('034服务：close取消等待中的解析并等到其结束，关闭后不受理', async t => {
  const gate = future()
  const h = rig(t, { extract: args => {
    args.signal.addEventListener('abort', () => gate.resolve({ ok: false, code: 'ABORTED' }), { once: true })
    return gate.promise
  } })
  const pending = h.read()
  await waitFor(() => h.extracts.length > 0)
  await h.service.close()
  assert.equal((await pending).ok, false)
  assert.equal((await h.read()).reason, 'closed')
  assert.equal(h.finished.length, 1)
})
