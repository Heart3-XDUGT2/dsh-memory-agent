/** 037-C1：真实宿主/present，仅产物与QQ提交端使用内存mock。 */
import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import {
  tmpRoot, isolation, cleanTmp, createUserMessage, response
} from './echo020-host.mjs'

const [
  { Context }, { AgentRegistry }, { SessionStore }, { SessionProjectionRegistry },
  { AgentLoop }, { SystemPrompt }, { ToolRuntime, defineTool }, llm,
  { LocalFileSystem }, present
] = await Promise.all([
  import('@deepseek-ai/cordis'), import('@deepseek-ai/dsh-agent'),
  import('@deepseek-ai/dsh-session'), import('@deepseek-ai/dsh-session-projection'),
  import('@deepseek-ai/dsh-agent-loop'), import('@deepseek-ai/dsh-system-prompt'),
  import('@deepseek-ai/dsh-tools'), import('@deepseek-ai/dsh-llm'),
  import('@deepseek-ai/dsh-fs-local'),
  import('@deepseek-ai/dsh-tool-present')
])

export { tmpRoot, isolation, cleanTmp, createUserMessage, response }
export const TOOL = 'echo_qq_file_send'
export const PRIVATE = Object.freeze({
  platform: 'qq', chatId: '11', chatType: 'private', senderId: '11', isMaster: true
})
export const GROUP = Object.freeze({
  platform: 'qq', chatId: '33', chatType: 'group', senderId: '11', isMaster: true
})
export const BODY = '037-C1合成产物\n中文😀\n'
export const REF = 'report.txt'
export const message = (source = PRIVATE, text = '请把本轮已展示文件发到这里') => createUserMessage({
  content: [{ type: 'text', text }],
  source: { kind: 'plugin:dsh-echo', form: 'relay', ...source, rawText: text }
})
export const localMessage = () => createUserMessage({
  source: { kind: 'user' }, content: [{ type: 'text', text: '合成本地输入' }]
})
export const deferred = () => {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}
export async function bounded (promise, milliseconds = 2000) {
  let timer
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(Error('synthetic_c1_boundary_not_reached')), milliseconds)
    })])
  } finally { clearTimeout(timer) }
}

function createArtifactsMock (scopeOf, cwd, trace, options = {}) {
  const byAuthority = new WeakMap(), byGrant = new WeakMap(), states = new Set()
  let closed = false
  const fail = code => ({ ok: false, code, reason: '合成产物状态' })
  function scope (grant) {
    const current = scopeOf(grant)
    if (closed || !current || current.agent.session !== current.session || current.isCurrent() !== true) return null
    let state = byAuthority.get(current.authority)
    if (!state) {
      state = { authority: current.authority, agent: current.agent, session: current.session,
        turn: current.turn, entries: new Map(), identity: Object.freeze({}), revoked: false }
      byAuthority.set(current.authority, state); states.add(state)
    }
    if (state.revoked || state.agent !== current.agent || state.session !== current.session || state.turn !== current.turn) return null
    byGrant.set(grant, state)
    return { current, state }
  }
  function metadata (entry) {
    return { ref: entry.ref, name: entry.name, bytes: entry.data.byteLength }
  }
  return {
    async prepare (grant) {
      const ready = scope(grant)
      trace.prepare.push({ grant, valid: !!ready, scope: ready?.current })
      return ready ? { ok: true, relativeRoot: 'echo-outgoing' } : fail('ORIGIN_UNPROVEN')
    },
    async registerPresented (grant, payload) {
      const first = scope(grant)
      trace.registerStarts.push({ grant, valid: !!first, scope: first?.current, payload, atSeq: trace.lastSeq })
      // Move beyond the present root/step; the grant must remain an authority grant.
      await new Promise(resolve => setImmediate(resolve))
      if (options.registrationGate) await options.registrationGate.promise
      const ready = scope(grant)
      trace.register.push({ grant, valid: !!ready, scope: ready?.current, payload, atSeq: trace.lastSeq })
      if (!ready) return fail('ORIGIN_UNPROVEN')
      const items = [], rejected = []
      for (const [index, file] of payload.files.entries()) {
        const absolute = path.resolve(cwd, file.path)
        const output = path.join(cwd, 'echo-outgoing')
        const relative = path.relative(output, absolute)
        if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
          rejected.push({ index, code: 'OUTSIDE_ROOT', reason: '合成边界拒绝' }); continue
        }
        const ref = relative.split(path.sep).join('/')
        // This is a mock of B's data/identity contract, not a filesystem safety claim.
        let entry = ready.state.entries.values().next().value
        if (!entry) {
          entry = { ref, name: path.basename(ref), data: new TextEncoder().encode(BODY),
            identity: ready.state.identity, taken: false }
          ready.state.entries.set(ref, entry)
        }
        items.push(metadata(entry))
      }
      return items.length ? { ok: true, items, rejected } : fail('NO_ARTIFACTS')
    },
    async list (grant) {
      const ready = scope(grant)
      trace.list.push({ grant, valid: !!ready, scope: ready?.current })
      return ready ? { ok: true, items: [...ready.state.entries.values()].map(metadata) } : fail('ORIGIN_UNPROVEN')
    },
    async snapshot (grant, ref, operation) {
      const ready = scope(grant)
      trace.snapshot.push({ grant, ref, valid: !!ready, scope: ready?.current, operation, atSeq: trace.lastSeq })
      if (!ready) return fail('ORIGIN_UNPROVEN')
      const entry = ready.state.entries.get(ref)
      if (!entry) return fail('UNKNOWN_REF')
      if (entry.taken) return { ...fail('ALREADY_TAKEN'), identity: entry.identity }
      if (operation?.signal?.aborted || (operation?.isCurrent && operation.isCurrent() !== true)) return fail('ABORTED')
      entry.taken = true
      return { ok: true, ...metadata(entry), identity: entry.identity, data: new Uint8Array(entry.data) }
    },
    async revoke (grant) {
      const state = byGrant.get(grant)
      trace.revoke.push({ grant, known: !!state })
      if (state) state.revoked = true
    },
    async close () {
      closed = true
      trace.closed++
      for (const state of states) { state.revoked = true; state.entries.clear() }
    }
  }
}

let serial = 0
export async function assemble (t, {
  createSender, script, preStep, onSessionEvent, upload,
  registrationGate, fakeTools = [], sessionId
} = {}) {
  const ctx = new Context(), tag = 'send-c1-host-' + ++serial
  const cwd = path.join(tmpRoot, tag), output = path.join(cwd, 'echo-outgoing')
  fs.mkdirSync(output, { recursive: true })
  fs.writeFileSync(path.join(output, REF), BODY, 'utf8')
  fs.writeFileSync(path.join(output, 'renamed.txt'), BODY, 'utf8')
  const events = [], runtimeResults = [], entered = [], claims = [], values = [], executions = [], requests = [], uploads = []
  const trace = { prepare: [], registerStarts: [], register: [], list: [], snapshot: [], revoke: [], closed: 0, lastSeq: -1 }
  let admission = true, sender, instance
  const cleanup = []
  const service = {
    beginFileUpload (args) {
      uploads.push(args)
      if (upload) return upload(args, { cleanup, uploads })
      return { result: Promise.resolve({ ok: true, state: 'confirmed', code: 'CONFIRMED', bytes: args.data.byteLength }),
        physicalDone: Promise.resolve() }
    }
  }
  sender = createSender({
    isEnabled: () => true, sessionEnabledOf: () => true,
    serviceOf: () => service,
    timeoutMs: 500,
    createArtifacts: ({ scopeOf }) => createArtifactsMock(scopeOf, cwd, trace, { registrationGate })
  })
  t.after(async () => {
    for (const done of cleanup) done()
    if (registrationGate) registrationGate.resolve()
    await sender.dispose()
    await ctx.fiber.dispose()
  })
  class FakeAdapter extends llm.LlmAdapter {
    async resolveModel (provider, model) { return { provider, id: model, name: model } }
    async * stream (request) {
      const index = requests.length
      requests.push(request)
      if (script) yield * script(request, index, { tag, sender, agent: instance, cwd })
      else if (index % 3 === 0) yield * response('', [{
        id: tag + '-present-' + index, name: 'present',
        arguments: JSON.stringify({ files: [{ path: 'echo-outgoing/' + REF }] })
      }])
      else if (index % 3 === 1) yield * response('', [{
        id: tag + '-send-' + index, name: TOOL, arguments: JSON.stringify({ ref: REF })
      }])
      else yield * response('合成发送测试结束')
    }
  }
  for (const [plugin, config] of [
    [AgentRegistry], [SessionStore], [SessionProjectionRegistry],
    [SystemPrompt, { includeRuntimeContext: false }], [llm.LlmRuntime],
    [ToolRuntime, { mode: 'native' }], [AgentLoop, { agents: [], maxParallelToolCalls: 2 }]
  ]) await ctx.plugin(plugin, config)
  new LocalFileSystem(ctx, { cwd, diffBasisMaxBytes: 1024 * 1024 })
  ctx.llm.registerAdapter(['send-c1-fake'], new FakeAdapter())
  const definition = sender.toolDefinition()
  ctx.tools.register(defineTool({
    ...definition,
    execute: async (args, exec) => {
      executions.push({ exec, hasTurn: 'turn' in exec, hasStep: 'step' in exec, parent: exec.parent })
      const value = await definition.execute(args, exec)
      values.push(value)
      return value
    }
  }))
  for (const tool of fakeTools) ctx.tools.register(defineTool({
    description: 'Synthetic tool for source rejection tests', parameters: {}, isConcurrencySafe: () => true,
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true } } },
      render: () => [{ type: 'text', text: '合成工具结束' }]
    },
    ...tool,
    execute: async (args, exec) => tool.execute(args, exec, { ctx, sender })
  }))
  const handle = await ctx.agents.create({
    sessionId: sessionId ?? tag, meta: { cwd },
    agentOptions: { provider: 'send-c1-fake', model: 'memory-only' },
    setup: async (agentCtx, agent) => {
      instance = agent
      // Actual installed present owns its execute and tools/result lifecycle.
      await agentCtx.plugin(present, { maxFiles: 8 })
      agentCtx.on('tools/result', (exec, result) => {
        runtimeResults.push({ exec, result, afterSeq: trace.lastSeq })
        sender.observeToolResult(exec, result)
      })
      agentCtx.on('session/event', (session, event) => {
        events.push(event)
        trace.lastSeq = event.seq
        sender.observeSessionEvent(session, event)
        if (event.type === 'user/message') entered.push(event.data)
        onSessionEvent?.(session, event, { sender, agent })
      })
      agentCtx.on('agent/inbox/claimed', payload => { claims.push(payload); sender.observeClaim(payload) })
      if (preStep) agentCtx.on('agent/pre-step', (payload, next) => preStep(payload, next, agent))
    }
  })
  assert.ok(handle.agent)
  assert.equal(path.resolve(handle.agent.session.header.cwd), path.resolve(cwd))
  return {
    ctx, sender, agent: handle.agent, service, cwd, output,
    events, runtimeResults, entered, claims, values, executions, requests, uploads, trace,
    admission: value => { admission = value },
    async enqueue (input, env = PRIVATE, { bindMessage = input, bind = true } = {}) {
      await handle.agent.runMaintenance(async () => {
        if (bind && env) sender.bind({ agent: handle.agent, message: bindMessage, env, isCurrent: () => admission })
        handle.agent.followup(input)
      })
    }
  }
}

export function sendResultMessages (h) {
  const ids = new Set(h.executions.filter(one => one.exec.parent === undefined).map(one => one.exec.callId))
  return h.events.filter(event => event.type === 'tool/result')
    .map(event => event.data.message).filter(message => ids.has(message.toolCallId))
}
export function assertSafeSendValues (assert, h) {
  const visible = JSON.stringify(h.values) + sendResultMessages(h)
    .flatMap(result => result.content || []).filter(block => block.type === 'text').map(block => block.text).join('\n')
  assert.doesNotMatch(visible, /base64:\/\/|file_id|chatId|senderId|authority|[A-Za-z]:\\|C:\/|https?:\/\//)
  assert.deepEqual(JSON.parse(JSON.stringify(h.values)), h.values)
}
