/**
 * 033：真实宿主的继续读接缝。先由fixture隔离目录并封锁全部网络，
 * 再注册实际ToolRuntime/AgentLoop；仅FakeAdapter与内存缓存返回合成数据。
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { tmpRoot, isolation, cleanTmp, createUserMessage, response } from './fixtures/echo020-host.mjs'

const [
  { Context }, { AgentRegistry }, { SessionStore }, { SessionProjectionRegistry },
  { AgentLoop }, { SystemPrompt }, { ToolRuntime, defineTool }, llm,
  { createForwardReader }
] = await Promise.all([
  import('@deepseek-ai/cordis'), import('@deepseek-ai/dsh-agent'),
  import('@deepseek-ai/dsh-session'), import('@deepseek-ai/dsh-session-projection'),
  import('@deepseek-ai/dsh-agent-loop'), import('@deepseek-ai/dsh-system-prompt'),
  import('@deepseek-ai/dsh-tools'), import('@deepseek-ai/dsh-llm'),
  import('../lib/forward-read.js')
])

const TOKEN = 'a'.repeat(32)
const LABEL = '转发2026-11-02T03:04:05.006Z-1'
const TOOL = 'echo_qq_forward_read'
const PRIVATE = Object.freeze({
  platform: 'qq', chatId: '11', chatType: 'private', senderId: '11', isMaster: true
})
const boundEnv = () => ({ ...PRIVATE, forwardContent: { ref: TOKEN, label: LABEL } })
const message = (source = PRIVATE, { ref = false, text = '合成聊天输入' } = {}) => createUserMessage({
  source: {
    kind: 'plugin:dsh-echo', form: 'relay', ...source,
    ...(ref ? { forwardRef: TOKEN } : {}), rawText: text
  },
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
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(Error('synthetic_boundary_not_reached')), 2000) })
    ])
  } finally { clearTimeout(timer) }
}

function cachePage (page, { images = false, text = '合成引用' } = {}) {
  return {
    ok: true,
    forwardContent: {
      source: 'qq-forward-quote', ref: TOKEN, label: LABEL,
      page, totalPages: 3, hasMore: page < 3,
      nodes: [{
        sender: { id: '22', name: '乙' }, time: 1700000000,
        text, depth: 0, at: [], imageIndexes: images ? [0] : [],
        sourceIndex: 0, textStart: 0, textEnd: text.length,
        continued: false, hasMoreText: false
      }],
      images: images ? [{ url: 'https://example.invalid/forward.png' }] : [],
      notices: [], truncated: false, stats: {}
    }
  }
}

let serial = 0
async function assemble (t, { script, preStep, readForward } = {}) {
  const ctx = new Context()
  const tag = 'forward-host-' + ++serial
  const requests = [], executions = [], values = [], claims = [], entered = [], toolEvents = [], calls = []
  const service = {
    async readForward (args) {
      calls.push(structuredClone(args))
      return readForward ? readForward(args) : cachePage(args.page)
    }
  }
  const reader = createForwardReader({
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
        arguments: JSON.stringify({ ref: LABEL, page: index < 2 ? 1 : 2 })
      }])
      else yield * response('合成结束')
    }
  }
  for (const [plugin, config] of [
    [AgentRegistry], [SessionStore], [SessionProjectionRegistry],
    [SystemPrompt, { includeRuntimeContext: false }], [llm.LlmRuntime],
    [ToolRuntime, { mode: 'native' }], [AgentLoop, { agents: [], maxParallelToolCalls: 2 }]
  ]) await ctx.plugin(plugin, config)
  ctx.llm.registerAdapter(['forward-host-fake'], new FakeAdapter())
  const definition = reader.toolDefinition()
  ctx.tools.register(defineTool({
    ...definition,
    execute: async (args, exec) => {
      // Retain the real definition's parameters/output/render. Never fill exec.turn.
      executions.push({ exec, hasTurn: 'turn' in exec, hasStep: 'step' in exec })
      const value = await definition.execute(args, exec)
      values.push(structuredClone(value))
      return value
    }
  }))
  const handle = await ctx.agents.create({
    sessionId: tag, meta: { cwd: tmpRoot },
    agentOptions: { provider: 'forward-host-fake', model: 'memory-only' },
    setup: (agentCtx, instance) => {
      agentCtx.on('session/event', (session, event) => {
        reader.observeSessionEvent(session, event)
        if (event.type === 'user/message') entered.push(event.data)
        if (event.type === 'tool/result') toolEvents.push(event.data.message)
      })
      agentCtx.on('agent/inbox/claimed', payload => {
        claims.push(payload)
        reader.observeClaim(payload)
      })
      if (preStep) agentCtx.on('agent/pre-step', (payload, next) => preStep(payload, next, instance))
    }
  })
  const agent = handle.agent
  assert.ok(agent, 'public host factory must supply the actual agent')
  return {
    reader, agent, calls, requests, executions, values, claims, entered, toolEvents,
    async enqueue (input, env = null) {
      await agent.runMaintenance(async () => {
        if (env) reader.bind({ agent, env })
        agent.followup(input)
      })
    }
  }
}

const rendered = h => h.toolEvents.flatMap(event => event.content || []).filter(block => block.type === 'text').map(block => block.text).join('\n')
function noPrivateResult (h) {
  const visible = JSON.stringify(h.values) + rendered(h)
  assert.equal(visible.includes(TOKEN), false, 'model result must not contain the internal cache token')
  assert.equal(visible.includes(TOOL), false, 'model result must not expose implementation tool names')
}

after(() => {
  assert.equal(isolation.networkAttempts, 0)
  assert.equal(isolation.persistenceMounted, false)
  cleanTmp()
})

test('033 host：实际claim和已发布工具根可继续读；真实exec没有turn字段', { timeout: 5000 }, async t => {
  const h = await assemble(t)
  const input = message(PRIVATE, { ref: true })
  await h.enqueue(input, boundEnv())
  await h.agent.whenIdle()
  assert.equal(h.executions.length, 1)
  assert.equal(h.executions[0].hasTurn, false)
  assert.equal(h.executions[0].hasStep, false)
  assert.equal(h.claims[0].agent, h.agent)
  assert.ok(Number.isInteger(h.claims[0].turn))
  assert.equal(h.entered.some(row => row.id === input.id), true)
  assert.equal(h.calls.length, 1)
  assert.equal(h.calls[0].ref, TOKEN)
  assert.equal(h.calls[0].source.chatType, 'private')
  assert.equal(h.calls[0].source.chatId, PRIVATE.chatId)
  assert.equal(h.values[0]?.ok, true)
  assert.equal(h.values[0]?.ref, LABEL)
  assert.deepEqual(JSON.parse(JSON.stringify(h.values[0])), h.values[0], 'tool output must remain lossless JSON')
  assert.notEqual(h.toolEvents[0]?.isError, true)
  assert.match(rendered(h), /合成引用/)
  noPrivateResult(h)
})

for (const mode of ['group', 'local']) test('033 host：同一session后续' + mode + ' claim不能读取旧私聊', { timeout: 5000 }, async t => {
  const h = await assemble(t)
  await h.enqueue(message(PRIVATE, { ref: true }), boundEnv())
  await h.agent.whenIdle()
  assert.equal(h.values[0]?.ok, true)
  const next = mode === 'group'
    ? message({ platform: 'qq', chatId: '33', chatType: 'group', senderId: '44', isMaster: false })
    : local()
  await h.enqueue(next)
  await h.agent.whenIdle()
  assert.equal(h.values.length, 2)
  assert.equal(h.values[1]?.ok, false)
  assert.equal(h.calls.length, 1, 'rejected scope must never reach the cache')
  noPrivateResult(h)
})

test('033 host：同聊天后续普通QQ消息不带forwardRef仍可按可访问label继续读', { timeout: 5000 }, async t => {
  const h = await assemble(t)
  await h.enqueue(message(PRIVATE, { ref: true }), boundEnv())
  await h.agent.whenIdle()
  const next = message(PRIVATE, { text: '继续看下一页' })
  assert.equal(Object.hasOwn(next.source, 'forwardRef'), false)
  await h.enqueue(next)
  await h.agent.whenIdle()
  assert.equal(h.values.length, 2)
  assert.ok(h.values.every(value => value.ok === true))
  assert.deepEqual(h.calls.map(call => call.page), [1, 2])
  assert.equal(h.values[1]?.page, 2)
  assert.equal(h.values[1]?.totalPages, 3)
  noPrivateResult(h)
})

for (const mode of ['fresh-message-same-source', 'local-claim-to-qq']) test('033 host：pre-step替换不能冒认真实claim ' + mode, { timeout: 5000 }, async t => {
  const original = mode === 'fresh-message-same-source' ? message(PRIVATE, { ref: true }) : local()
  const replacement = message(PRIVATE, { ref: true, text: '合成替换消息' })
  let replaced = false
  const h = await assemble(t, {
    preStep: async (_payload, next) => {
      const decision = await next()
      if (!replaced && decision.kind === 'enter') {
        replaced = true
        return { ...decision, messages: [replacement] }
      }
      return decision
    }
  })
  await h.enqueue(original, boundEnv())
  await h.agent.whenIdle()
  assert.notEqual(original.id, replacement.id)
  assert.equal(h.claims.some(row => row.message.id === original.id), true)
  assert.equal(h.claims.some(row => row.message.id === replacement.id), false)
  assert.equal(h.entered.some(row => row.id === replacement.id), true)
  assert.equal(h.values[0]?.ok, false)
  assert.equal(h.calls.length, 0)
  noPrivateResult(h)
})

test('033 host：实际工具等待期间取消后丢弃旧私聊页', { timeout: 5000 }, async t => {
  const started = deferred(), finish = deferred()
  const h = await assemble(t, {
    readForward: async args => {
      started.resolve()
      await finish.promise
      return cachePage(args.page, { text: '合成私密标记不应返回' })
    }
  })
  try {
    await h.enqueue(message(PRIVATE, { ref: true }), boundEnv())
    await bounded(started.promise)
    h.agent.cancel({ kind: 'user' })
    finish.resolve()
    await h.agent.whenIdle()
    assert.equal(h.executions[0]?.exec.signal.aborted, true)
    assert.equal(h.values[0]?.ok, false)
    assert.equal((JSON.stringify(h.values) + rendered(h)).includes('合成私密标记不应返回'), false)
    noPrivateResult(h)
  } finally { finish.resolve() }
})

test('033 host：本页图片不作为JSON引用假装已提供给模型', { timeout: 5000 }, async t => {
  const h = await assemble(t, { readForward: async args => cachePage(args.page, { images: true }) })
  await h.enqueue(message(PRIVATE, { ref: true }), boundEnv())
  await h.agent.whenIdle()
  assert.equal(h.values[0]?.ok, true)
  const text = rendered(h)
  assert.match(text, /图片/)
  assert.match(text, /本次未读|本次.*未.*提供|未.*本次.*提供/)
  assert.equal(text.includes('https://example.invalid/forward.png'), false)
  assert.equal(JSON.stringify(h.values).includes('https://example.invalid/forward.png'), false)
  assert.equal(h.toolEvents[0].content.some(block => block.type === 'image'), false)
  noPrivateResult(h)
})
