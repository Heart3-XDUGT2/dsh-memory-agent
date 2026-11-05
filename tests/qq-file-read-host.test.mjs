/**
 * 034：真实安装的AgentLoop/ToolRuntime文件工具来源接缝。
 * fixture先隔离临时目录并封锁网络；仅内存FakeAdapter与合成正文服务。
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { tmpRoot, isolation, cleanTmp, createUserMessage, response } from './fixtures/echo020-host.mjs'

const [
  { Context }, { AgentRegistry }, { SessionStore }, { SessionProjectionRegistry },
  { AgentLoop }, { SystemPrompt }, { ToolRuntime, defineTool }, llm,
  { createFileReader }
] = await Promise.all([
  import('@deepseek-ai/cordis'), import('@deepseek-ai/dsh-agent'),
  import('@deepseek-ai/dsh-session'), import('@deepseek-ai/dsh-session-projection'),
  import('@deepseek-ai/dsh-agent-loop'), import('@deepseek-ai/dsh-system-prompt'),
  import('@deepseek-ai/dsh-tools'), import('@deepseek-ai/dsh-llm'),
  import('../lib/qq-file-read.js')
])

const REF = 'a'.repeat(32), SECOND = 'b'.repeat(32)
const LABEL = '文件2026-11-02T03:04:05.006Z-1'
const LABEL2 = '文件2026-11-02T03:04:05.006Z-2'
const TOOL = 'echo_qq_file_read'
const PRIVATE = Object.freeze({ platform: 'qq', chatId: '11', chatType: 'private', senderId: '11', isMaster: true })
const fileOf = ref => ({ ref, label: ref === SECOND ? LABEL2 : LABEL })
const boundEnv = (refs = [REF]) => ({ ...PRIVATE, files: refs.map(fileOf) })
const message = (source = PRIVATE, { refs, text = '合成聊天输入' } = {}) => createUserMessage({
  source: { kind: 'plugin:dsh-echo', form: 'relay', ...source,
    ...(refs ? { fileRefs: refs } : {}), rawText: text },
  content: [{ type: 'text', text }]
})
const local = () => createUserMessage({
  source: { kind: 'user' }, content: [{ type: 'text', text: '合成本地输入' }]
})
const deferred = () => {
  let resolve
  const promise = new Promise(r => { resolve = r })
  return { promise, resolve }
}
async function bounded (promise) {
  let timer
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(Error('synthetic_file_boundary_not_reached')), 2000)
    })])
  } finally { clearTimeout(timer) }
}
function body (args, text = '合成文档正文') {
  return {
    ok: true, ref: args.ref, label: args.ref === SECOND ? LABEL2 : LABEL,
    name: '合成.txt', format: 'txt', text, start: args.offset, end: args.offset + text.length,
    totalChars: 16000, nextOffset: args.offset + text.length, truncated: false, warnings: []
  }
}

let serial = 0
async function assemble (t, { script, preStep, readFile } = {}) {
  const ctx = new Context(), tag = 'file-host-' + ++serial
  const requests = [], calls = [], executions = [], values = [], claims = [], entered = [], toolEvents = []
  const service = {
    async readFile (args) {
      calls.push(args)
      return readFile ? readFile(args) : body(args)
    }
  }
  const reader = createFileReader({
    serviceOf: () => service, isEnabled: () => true, sessionEnabledOf: () => true
  })
  t.after(async () => { reader.dispose(); await ctx.fiber.dispose() })
  class FakeAdapter extends llm.LlmAdapter {
    async resolveModel (provider, model) { return { provider, id: model, name: model } }
    async * stream (request) {
      const index = requests.length
      requests.push({ ids: request.messages.map(m => m.id) })
      if (script) yield * script(request, index)
      else if (index % 2 === 0) yield * response('', [{
        id: tag + '-call-' + index, name: TOOL,
        arguments: JSON.stringify(index < 2 ? { ref: LABEL } : { ref: LABEL, offset: 6 })
      }])
      else yield * response('合成结束')
    }
  }
  for (const [plugin, config] of [
    [AgentRegistry], [SessionStore], [SessionProjectionRegistry],
    [SystemPrompt, { includeRuntimeContext: false }], [llm.LlmRuntime],
    [ToolRuntime, { mode: 'native' }], [AgentLoop, { agents: [], maxParallelToolCalls: 2 }]
  ]) await ctx.plugin(plugin, config)
  ctx.llm.registerAdapter(['file-host-fake'], new FakeAdapter())
  const definition = reader.toolDefinition()
  ctx.tools.register(defineTool({
    ...definition,
    execute: async (args, exec) => {
      executions.push({ exec, hasTurn: 'turn' in exec, hasStep: 'step' in exec })
      const value = await definition.execute(args, exec)
      values.push(structuredClone(value))
      return value
    }
  }))
  const handle = await ctx.agents.create({
    sessionId: tag, meta: { cwd: tmpRoot },
    agentOptions: { provider: 'file-host-fake', model: 'memory-only' },
    setup: (agentCtx, instance) => {
      agentCtx.on('session/event', (session, event) => {
        reader.observeSessionEvent(session, event)
        if (event.type === 'user/message') entered.push(event.data)
        if (event.type === 'tool/result') toolEvents.push(event.data.message)
      })
      agentCtx.on('agent/inbox/claimed', payload => { claims.push(payload); reader.observeClaim(payload) })
      if (preStep) agentCtx.on('agent/pre-step', (payload, next) => preStep(payload, next, instance))
    }
  })
  const agent = handle.agent
  assert.ok(agent, 'public factory must supply an actual agent')
  return {
    reader, agent, requests, calls, executions, values, claims, entered, toolEvents,
    async enqueue (input, env = null) {
      await agent.runMaintenance(async () => {
        if (env) reader.bind({ agent, env })
        agent.followup(input)
      })
    }
  }
}
const rendered = h => h.toolEvents.flatMap(event => event.content || [])
  .filter(block => block.type === 'text').map(block => block.text).join('\n')
function safeVisible (h) {
  const visible = JSON.stringify(h.values) + rendered(h)
  assert.equal(visible.includes(REF), false)
  assert.equal(visible.includes(SECOND), false)
  assert.equal(visible.includes(TOOL), false)
  assert.doesNotMatch(visible, /chatId|senderId|https?:|C:\\/)
}
after(() => {
  assert.equal(isolation.networkAttempts, 0)
  assert.equal(isolation.persistenceMounted, false)
  cleanTmp()
})

test('034 host：缺省offset按真实原生根证明后归零，exec无turn/step', { timeout: 5000 }, async t => {
  const h = await assemble(t)
  const input = message(PRIVATE, { refs: [REF] })
  await h.enqueue(input, boundEnv())
  await h.agent.whenIdle()
  assert.equal(h.values[0]?.ok, true)
  assert.equal(h.calls.length, 1)
  assert.equal(h.calls[0].ref, REF)
  assert.equal(h.calls[0].offset, 0)
  assert.equal(h.executions[0]?.hasTurn, false)
  assert.equal(h.executions[0]?.hasStep, false)
  assert.equal(h.claims[0]?.agent, h.agent)
  assert.equal(h.entered.some(one => one.id === input.id), true)
  assert.equal(h.toolEvents[0]?.isError, false)
  assert.match(rendered(h), /合成文档正文/)
  assert.deepEqual(JSON.parse(JSON.stringify(h.values)), h.values)
  safeVisible(h)
})

test('034 host：同消息双文件各自授权，原生并行根分别映射内部引用', { timeout: 5000 }, async t => {
  const h = await assemble(t, {
    script: function * (_request, index) {
      if (index === 0) yield * response('', [LABEL, LABEL2].map((ref, i) => ({
        id: 'double-file-call-' + i, name: TOOL, arguments: JSON.stringify({ ref })
      })))
      else yield * response('合成结束')
    }
  })
  await h.enqueue(message(PRIVATE, { refs: [REF, SECOND] }), boundEnv([REF, SECOND]))
  await h.agent.whenIdle()
  assert.equal(h.values.length, 2)
  assert.ok(h.values.every(value => value.ok === true))
  assert.deepEqual(h.calls.map(one => one.ref).sort(), [REF, SECOND])
  assert.deepEqual(h.values.map(one => one.ref).sort(), [LABEL, LABEL2])
  safeVisible(h)
})

test('034 host：同聊天后续无fileRefs仍可继续读，保留字符游标', { timeout: 5000 }, async t => {
  const h = await assemble(t)
  await h.enqueue(message(PRIVATE, { refs: [REF] }), boundEnv())
  await h.agent.whenIdle()
  const next = message(PRIVATE, { text: '继续读后文' })
  assert.equal(Object.hasOwn(next.source, 'fileRefs'), false)
  await h.enqueue(next)
  await h.agent.whenIdle()
  assert.equal(h.values.length, 2)
  assert.ok(h.values.every(value => value.ok === true))
  assert.deepEqual(h.calls.map(one => one.offset), [0, 6])
  assert.equal(h.values[1]?.start, 6)
  assert.equal(h.values[1]?.end, 12)
  safeVisible(h)
})

for (const mode of ['only-bind', 'only-claim']) test('034 host：仅绑定或仅claim不能读取 ' + mode, { timeout: 5000 }, async t => {
  const h = await assemble(t)
  await h.enqueue(message(PRIVATE, { ...(mode === 'only-claim' ? { refs: [REF] } : {}) }),
    mode === 'only-bind' ? boundEnv() : null)
  await h.agent.whenIdle()
  assert.equal(h.values[0]?.ok, false)
  assert.equal(h.calls.length, 0)
  safeVisible(h)
})

test('034 host：双引用第二个无绑定，首个别名也不能部分激活', { timeout: 5000 }, async t => {
  const h = await assemble(t)
  await h.enqueue(message(PRIVATE, { refs: [REF, SECOND] }), boundEnv())
  await h.agent.whenIdle()
  assert.equal(h.values[0]?.ok, false)
  await h.enqueue(message(PRIVATE))
  await h.agent.whenIdle()
  assert.equal(h.values[1]?.ok, false)
  assert.equal(h.calls.length, 0)
  safeVisible(h)
})

for (const mode of ['group', 'other-private', 'local']) test('034 host：同sid不能把旧私聊文件带给其它来源 ' + mode, { timeout: 5000 }, async t => {
  const h = await assemble(t)
  await h.enqueue(message(PRIVATE, { refs: [REF] }), boundEnv())
  await h.agent.whenIdle()
  assert.equal(h.values[0]?.ok, true)
  const next = mode === 'local' ? local() : message(mode === 'group'
    ? { platform: 'qq', chatType: 'group', chatId: '33', senderId: '44', isMaster: false }
    : { ...PRIVATE, chatId: '22', senderId: '22' })
  await h.enqueue(next)
  await h.agent.whenIdle()
  assert.equal(h.values[1]?.ok, false)
  assert.equal(h.calls.length, 1)
  safeVisible(h)
})

for (const mode of ['fresh-message-same-source', 'local-claim-to-qq']) test('034 host：prestep替换不能冒认真实claim ' + mode, { timeout: 5000 }, async t => {
  const original = mode === 'fresh-message-same-source' ? message(PRIVATE, { refs: [REF] }) : local()
  const replacement = message(PRIVATE, { refs: [REF], text: '合成替换消息' })
  let replaced = false
  const h = await assemble(t, {
    preStep: async (_payload, next) => {
      const decision = await next()
      if (!replaced && decision.kind === 'enter') { replaced = true; return { ...decision, messages: [replacement] } }
      return decision
    }
  })
  await h.enqueue(original, boundEnv())
  await h.agent.whenIdle()
  assert.equal(h.claims.some(one => one.message.id === original.id), true)
  assert.equal(h.claims.some(one => one.message.id === replacement.id), false)
  assert.equal(h.entered.some(one => one.id === replacement.id), true)
  assert.equal(h.values[0]?.ok, false)
  assert.equal(h.calls.length, 0)
  safeVisible(h)
})

test('034 host：真实工具取消立即使服务signal/来源guard失效，旧正文不泄漏', { timeout: 5000 }, async t => {
  const started = deferred(), finish = deferred()
  let active
  const h = await assemble(t, {
    readFile: async args => {
      active = args
      started.resolve()
      await finish.promise
      return body(args, '合成私密标记不应返回')
    }
  })
  try {
    await h.enqueue(message(PRIVATE, { refs: [REF] }), boundEnv())
    await bounded(started.promise)
    assert.equal(active.isCurrent(), true)
    h.agent.cancel({ kind: 'user' })
    assert.equal(active.signal.aborted, true)
    assert.equal(active.isCurrent(), false)
    finish.resolve()
    await h.agent.whenIdle()
    assert.equal(h.values[0]?.ok, false)
    assert.equal((JSON.stringify(h.values) + rendered(h)).includes('合成私密标记不应返回'), false)
    safeVisible(h)
  } finally { finish.resolve() }
})
