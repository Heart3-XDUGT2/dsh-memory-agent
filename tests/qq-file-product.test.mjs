/**
 * 034：产品收件→受限下载→实际临时worker→文本缓存/原生工具的装配检查。
 * 只读仓库合成夹具，下载使用内存Response；宿主夹具封锁真实网络和持久存储。
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { tmpRoot, isolation, cleanTmp, createUserMessage, response } from './fixtures/echo020-host.mjs'

const [
  { createFileService }, { createFileDownloader }, { createFileReader },
  { createFileReceipts }, { filesOfSegments, resolveFileDownload },
  { buildPrivateEnvelope }, { parseEnvelope, renderInboundText },
  { hasRelayContent }, { ECHO_SOURCE_KIND }, { latestDirectUserText },
  { Context }, { AgentRegistry }, { SessionStore }, { SessionProjectionRegistry },
  { AgentLoop }, { SystemPrompt }, { ToolRuntime, defineTool }, llm
] = await Promise.all([
  import('../lib/qq-file-service.js'), import('../lib/qq-file-download.js'), import('../lib/qq-file-read.js'),
  import('../../dsh-qq-bridge/lib/file-receipts.js'), import('../../dsh-qq-bridge/lib/file-content.js'),
  import('../../dsh-qq-bridge/lib/envelope.js'), import('../lib/relay.js'),
  import('../lib/relay-content.js'), import('../lib/source-kind.js'), import('../lib/turn-query.js'),
  import('@deepseek-ai/cordis'), import('@deepseek-ai/dsh-agent'), import('@deepseek-ai/dsh-session'),
  import('@deepseek-ai/dsh-session-projection'), import('@deepseek-ai/dsh-agent-loop'),
  import('@deepseek-ai/dsh-system-prompt'), import('@deepseek-ai/dsh-tools'), import('@deepseek-ai/dsh-llm')
])

const PRIVATE = Object.freeze({ platform: 'qq', chatId: '11', chatType: 'private', senderId: '11', isMaster: true })
const fixture = name => fs.readFileSync(new URL('./fixtures/qq-file-text/' + name, import.meta.url))
function diskFiles () {
  const files = []
  const walk = directory => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name)
      if (entry.isDirectory()) walk(absolute)
      else files.push(path.relative(tmpRoot, absolute))
    }
  }
  walk(tmpRoot)
  return files.sort()
}

/** 这里使用真实下载器；替换的只是传输，且每个回应是分块、无Content-Length的真实流。 */
function assembleProduct (t, inputs, options = {}) {
  const queries = [], downloads = [], finishes = []
  const payloads = new Map(inputs.map((input, index) => ['fixture-' + index, input]))
  const receipts = createFileReceipts({
    ...options.receipts,
    resolve: (file, source, execution) => resolveFileDownload(file, source, {
      ...execution,
      call: async (action, params) => {
        queries.push({ action, params })
        assert.equal(action, 'get_private_file_url')
        assert.equal(params.user_id, '11')
        assert.equal(payloads.has(params.file_id), true)
        return { ok: true, data: { url: 'https://synthetic.invalid/' + params.file_id + '?token=fixture-only' } }
      }
    })
  })
  const files = receipts.put(filesOfSegments(inputs.map((input, index) => ({
    type: 'file', data: { name: input.name, size: input.data.length, file_id: 'fixture-' + index }
  })), PRIVATE), PRIVATE, { isCurrent: () => true })
  const downloader = createFileDownloader({
    fetchImpl: async (url, init) => {
      const parsed = new URL(url)
      assert.equal(parsed.hostname, 'synthetic.invalid')
      assert.equal(init.redirect, 'manual')
      assert.equal(init.credentials, 'omit')
      assert.equal('headers' in init, false)
      const input = payloads.get(parsed.pathname.slice(1))
      assert.ok(input)
      downloads.push(url)
      let offset = 0
      return new Response(new ReadableStream({
        pull (controller) {
          if (offset === input.data.length) { controller.close(); return }
          const end = Math.min(offset + 137, input.data.length)
          controller.enqueue(new Uint8Array(input.data.subarray(offset, end)))
          offset = end
        }
      }, { highWaterMark: 0 }), { headers: { 'content-type': 'application/octet-stream' } })
    }
  })
  const channel = {
    inspectFile: args => receipts.inspectFile(args),
    openFile: async args => {
      const handle = await receipts.openFile(args)
      if (!handle.ok) return handle
      const finish = handle.finish
      return { ...handle, finish: bytes => { finishes.push(bytes); finish(bytes) } }
    }
  }
  // 没有extractor替身：实际产品惰性加载qq-file-text.js并启动实际解析worker。
  const service = createFileService({ channelOf: () => channel, downloader, ...options.service })
  t.after(async () => { await service.close(); receipts.clear() })
  const read = (index = 0, offset = 0, source = PRIVATE) => service.readFile({
    ref: files[index].ref, offset, source, signal: new AbortController().signal, isCurrent: () => true
  })
  return { service, receipts, files, queries, downloads, finishes, read }
}

const expectedDocx = '中文段落：你好，世界。\nEnglish paragraph: Hello, fixture world.\n左上 A1\t右上 B1\n左下 A2\t右下 B2\n表格之后：结束。'
for (const [name, format] of [
  ['synthetic-utf8.txt', 'txt'],
  ['synthetic-utf8.md', 'md'],
  ['synthetic-two-page-zh.pdf', 'pdf'],
  ['synthetic-paragraph-table.docx', 'docx'],
  ['synthetic-paragraph-table-deflated.docx', 'docx']
]) {
  test('034产品装配：' + name + '按需走真实解析器，不永久保存原件', { timeout: 15000 }, async t => {
    const data = fixture(name), before = diskFiles()
    const h = assembleProduct(t, [{ name, data }])
    assert.equal(h.files.length, 1)
    assert.equal(h.queries.length, 0, '收件元数据阶段不取链接')
    assert.equal(h.downloads.length, 0, '元数据阶段不下载')
    const result = await h.read()
    assert.equal(result.ok, true)
    assert.equal(result.format, format)
    assert.equal(result.start, 0)
    assert.equal(result.end, result.text.length)
    assert.equal(result.nextOffset, null)
    assert.equal(result.truncated, false)
    if (format === 'txt' || format === 'md') {
      assert.equal(result.text, data.toString('utf8').replace(/^\ufeff/, ''))
    } else if (format === 'docx') {
      assert.equal(result.text, expectedDocx)
      assert.deepEqual(result.warnings, ['DOCX_BODY_ONLY'])
    } else {
      assert.equal(result.pages, 2)
      assert.equal(result.pagesRead, 2)
      const first = result.text.indexOf('第1页：中文文字PDF夹具')
      const second = result.text.indexOf('第2页：继续读取')
      assert.ok(first >= 0 && second > first)
      assert.match(result.text, /这是正文，不是元数据。/)
      assert.match(result.text, /结束：只验证文字提取。/)
      assert.equal('pageStart' in result, false)
    }
    assert.equal(h.queries.length, 1)
    assert.equal(h.downloads.length, 1)
    assert.deepEqual(h.finishes, [data.length])
    assert.deepEqual(diskFiles(), before)
    assert.doesNotMatch(JSON.stringify(result), /synthetic\.invalid|token=|fixture-only|fixture-0/)
  })
}

test('034产品装配：实际UTF8长文分页还原，不重下，已缓存正文仍隔离聊天', { timeout: 15000 }, async t => {
  const text = '甲'.repeat(3999) + '😀' + (fixture('synthetic-utf8.txt').toString('utf8') + '😀').repeat(300)
  const data = Buffer.from(text, 'utf8'), h = assembleProduct(t, [{ name: '长文.txt', data }])
  const pages = []
  let offset = 0
  do {
    const value = await h.read(0, offset)
    assert.equal(value.ok, true)
    assert.equal(value.start, offset)
    assert.equal(value.text, text.slice(value.start, value.end))
    assert.equal(value.text, value.text.toWellFormed())
    assert.ok(value.text.length <= (offset === 0 ? 4000 : 8000))
    assert.equal(value.totalChars, text.length)
    pages.push(value)
    offset = value.nextOffset
  } while (offset !== null)
  assert.equal(pages[0].end, 3999)
  assert.equal(pages.map(page => page.text).join(''), text)
  assert.equal(h.queries.length, 1)
  assert.equal(h.downloads.length, 1)
  const denied = await h.read(0, 0, { chatType: 'group', chatId: '33', senderId: '22', isMaster: false })
  assert.equal(denied.ok, false)
  assert.doesNotMatch(JSON.stringify(denied), /中文第一行|English line/)
  assert.equal(h.downloads.length, 1)
})

test('034产品装配：真实内容伪扩展名错误不泄漏诊断或永久原件', { timeout: 15000 }, async t => {
  const before = diskFiles()
  const data = fixture('synthetic-paragraph-table.docx')
  const h = assembleProduct(t, [{ name: '伪装.pdf', data }])
  const result = await h.read()
  assert.equal(result.ok, false)
  assert.equal(result.code, 'FORMAT_MISMATCH')
  assert.doesNotMatch(JSON.stringify(result), /synthetic\.invalid|token=|\\.dsh|node_modules|stack/)
  assert.deepEqual(diskFiles(), before)
  assert.equal(h.queries.length, 1)
  assert.equal((await h.read()).ok, false)
  assert.equal(h.downloads.length, 1, '失败原件也不因再次读取而重下')
})

test('034产品装配：取消未结束正文保守占用8字节，同条第二文件最多余4字节', { timeout: 15000 }, async t => {
  let pendingRead
  const bodyPending = new Promise(resolve => { pendingRead = resolve })
  const limits = [], transfers = []
  const receipts = createFileReceipts({
    maxFileBytes: 8, maxMessageBytes: 12,
    resolve: (file, origin, execution) => resolveFileDownload(file, origin, {
      ...execution,
      call: async (_action, params) => ({ ok: true, data: { url: 'https://synthetic.invalid/' + params.file_id } })
    })
  })
  const files = receipts.put(filesOfSegments([
    { type: 'file', data: { name: '第一份.txt', file_id: 'first' } },
    { type: 'file', data: { name: '第二份.txt', file_id: 'second' } }
  ], PRIVATE), PRIVATE, { isCurrent: () => true })
  const actualDownloader = createFileDownloader({
    maxFileBytes: 8,
    fetchImpl: async url => {
      if (new URL(url).pathname === '/second') return new Response(new Uint8Array([69, 70, 71, 72]))
      let pulls = 0
      return new Response(new ReadableStream({
        pull (controller) {
          if (++pulls === 1) { controller.enqueue(new Uint8Array([65, 66, 67, 68])); return }
          pendingRead()
          return new Promise(() => {}) // 已交付4字节，剩余read不合作且尚未EOF。
        }
      }, { highWaterMark: 0 }))
    }
  })
  const downloader = {
    download: async args => {
      const result = await actualDownloader.download(args)
      transfers.push(result)
      return result
    },
    close: actualDownloader.close
  }
  const channel = {
    inspectFile: args => receipts.inspectFile(args),
    openFile: async args => {
      const result = await receipts.openFile(args)
      if (result.ok) limits.push(result.byteLimit)
      return result
    }
  }
  const service = createFileService({ channelOf: () => channel, downloader })
  t.after(async () => { await service.close(); receipts.clear() })
  const firstAbort = new AbortController()
  const request = (index, signal) => service.readFile({
    ref: files[index].ref, offset: 0, source: PRIVATE, signal, isCurrent: () => true
  })
  const first = request(0, firstAbort.signal)
  await bodyPending
  assert.equal((await request(1, new AbortController().signal)).reason, 'busy', '同批下载期间第二份不抢占预算')
  firstAbort.abort()
  assert.equal((await first).ok, false)
  assert.equal(transfers[0].bytesRead, 4, '已交付字节如实计数')
  assert.equal(transfers[0].budgetCharge, 8, '未结束read需保守占用本次限额')
  const second = await request(1, new AbortController().signal)
  assert.equal(second.ok, true)
  assert.equal(second.text, 'EFGH')
  assert.deepEqual(limits, [8, 4], '核心finally按较大计费结算，第二份仅能使用消息剩余额度')
})

const indexSource = fs.readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
const injectStart = indexSource.indexOf('  async function injectInboundNow (')
const injectEnd = indexSource.indexOf('\n  }\n', injectStart)
assert.ok(injectStart >= 0 && injectEnd > injectStart)
const actualInject = indexSource.slice(injectStart, injectEnd + '\n  }'.length)

test('034产品原生装配：实际注入→真实claim/root→中文PDF和表格DOCX→文档引文', { timeout: 20000 }, async t => {
  const before = diskFiles()
  const product = assembleProduct(t, [
    { name: '中文文档.pdf', data: fixture('synthetic-two-page-zh.pdf') },
    { name: '表格文档.docx', data: fixture('synthetic-paragraph-table-deflated.docx') }
  ])
  const reader = createFileReader({
    serviceOf: () => product.service, isEnabled: () => true, sessionEnabledOf: () => true
  })
  const ctx = new Context(), values = [], executions = [], entered = [], results = []
  let requestCount = 0
  class FakeAdapter extends llm.LlmAdapter {
    async resolveModel (provider, model) { return { provider, id: model, name: model } }
    async * stream () {
      const index = requestCount++
      if (index < 2) yield * response('', [{
        id: 'actual-product-root-' + index, name: 'echo_qq_file_read',
        arguments: JSON.stringify({ ref: product.files[index].label })
      }])
      else yield * response('合成装配结束')
    }
  }
  for (const [plugin, config] of [
    [AgentRegistry], [SessionStore], [SessionProjectionRegistry],
    [SystemPrompt, { includeRuntimeContext: false }], [llm.LlmRuntime],
    [ToolRuntime, { mode: 'native' }], [AgentLoop, { agents: [], maxParallelToolCalls: 2 }]
  ]) await ctx.plugin(plugin, config)
  ctx.llm.registerAdapter(['product-file-fake'], new FakeAdapter())
  const definition = reader.toolDefinition()
  ctx.tools.register(defineTool({
    ...definition,
    execute: async (args, exec) => {
      executions.push({ hasTurn: 'turn' in exec, hasStep: 'step' in exec, nativeToken: typeof exec.token })
      const value = await definition.execute(args, exec)
      values.push(value)
      return value
    }
  }))
  t.after(async () => { reader.dispose(); await ctx.fiber.dispose() })
  const handle = await ctx.agents.create({
    sessionId: 'product-file-native', meta: { cwd: tmpRoot },
    agentOptions: { provider: 'product-file-fake', model: 'memory-only' },
    setup: agentCtx => {
      agentCtx.on('agent/inbox/claimed', payload => reader.observeClaim(payload))
      agentCtx.on('session/event', (session, event) => {
        reader.observeSessionEvent(session, event)
        if (event.type === 'user/message') entered.push(event.data)
        if (event.type === 'tool/result') results.push(event.data.message)
      })
    }
  })
  const built = buildPrivateEnvelope({
    userId: '11', messageId: 'actual-file-product', isMaster: true, files: product.files
  })
  assert.equal(built.ok, true)
  const parsed = parseEnvelope(built.envelope)
  assert.equal(parsed.ok, true)
  const env = parsed.value
  const dependencies = {
    hasRelayContent, fileReader: reader, forwardReader: { bind: () => assert.fail('no forward in fixture') },
    fileSender: { bind: () => {} },
    ECHO_SOURCE_KIND, createUserMessage, ctx: { logger: { info: () => {}, warn: () => {} } }, audit: () => {}
  }
  const inject = new Function(...Object.keys(dependencies), actualInject + '\nreturn injectInboundNow')(...Object.values(dependencies))
  assert.equal(product.queries.length, 0)
  assert.equal(await inject(handle.agent, env, renderInboundText(env), { isCurrent: () => true }), 'ok')
  await handle.agent.whenIdle()
  assert.equal(values.length, 2)
  assert.ok(values.every(value => value.ok === true), JSON.stringify(values))
  assert.equal(values[0].format, 'pdf')
  assert.equal(values[0].pages, 2)
  assert.equal(values[0].pagesRead, 2)
  assert.equal(values[1].format, 'docx')
  assert.match(values[0].text, /第1页：中文文字PDF夹具/)
  assert.match(values[1].text, /左上 A1\t右上 B1/)
  assert.ok(values.every(value => /不是当前发送者的自述/.test(value.text)))
  assert.equal(entered.length, 1)
  assert.equal(entered[0].source.rawText, '')
  assert.equal(latestDirectUserText(entered), '')
  assert.deepEqual(entered[0].source.fileRefs, product.files.map(file => file.ref))
  assert.ok(executions.every(exec => exec.hasTurn === false && exec.hasStep === false && exec.nativeToken === 'symbol'))
  assert.equal(product.queries.length, 2)
  assert.equal(product.downloads.length, 2)
  const visible = JSON.stringify(values) + results.flatMap(result => result.content || [])
    .filter(block => block.type === 'text').map(block => block.text).join('\n')
  for (const file of product.files) assert.equal(visible.includes(file.ref), false)
  assert.doesNotMatch(visible, /synthetic\.invalid|token=|fileRefs|chatId|senderId|fixture-0|fixture-1/)
  assert.deepEqual(diskFiles(), before)
})

after(() => {
  assert.equal(isolation.networkAttempts, 0)
  assert.equal(isolation.persistenceMounted, false)
  cleanTmp()
})
