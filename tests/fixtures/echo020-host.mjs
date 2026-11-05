// Install isolation before dynamically importing any host/Echo module.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import tls from 'node:tls'
import http from 'node:http'
import https from 'node:https'
import { syncBuiltinESMExports } from 'node:module'

export const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'echo020-'))
if (!path.isAbsolute(tmpRoot) || !path.basename(tmpRoot).startsWith('echo020-') || path.dirname(tmpRoot) !== path.resolve(os.tmpdir())) throw Error('invalid_test_tmp')
for (const [name, sub] of Object.entries({ DSH_HOME: 'dsh', DSH_DATA_DIR: 'dsh', ECHO_DATA_DIR: 'echo', ECHO_QQ_DATA_DIR: 'qq', ECHO_QQ_OFFICIAL_DATA_DIR: 'official', XDG_CONFIG_HOME: 'config', XDG_DATA_HOME: 'data' })) {
  process.env[name] = path.join(tmpRoot, sub)
  fs.mkdirSync(process.env[name], { recursive: true })
}
export const isolation = { networkAttempts: 0, persistenceMounted: false, echoEntryImported: false }
function blocked () { isolation.networkAttempts++; throw Error('echo020_network_forbidden') }
net.connect = net.createConnection = net.Socket.prototype.connect = blocked
tls.connect = http.request = http.get = https.request = https.get = blocked
globalThis.fetch = blocked
globalThis.WebSocket = class { constructor () { blocked() } }
syncBuiltinESMExports()

const [{ Context }, { AgentRegistry }, { SessionStore }, { SessionProjectionRegistry }, { AgentLoop }, { SystemPrompt }, { ToolRuntime, defineTool }, llm, tracker] = await Promise.all([
  import('@deepseek-ai/cordis'), import('@deepseek-ai/dsh-agent'), import('@deepseek-ai/dsh-session'), import('@deepseek-ai/dsh-session-projection'),
  import('@deepseek-ai/dsh-agent-loop'), import('@deepseek-ai/dsh-system-prompt'), import('@deepseek-ai/dsh-tools'), import('@deepseek-ai/dsh-llm'), import('../../lib/official-turns.js')
])
export const { createUserMessage } = llm
export const traces = []
export function official (id = 'a', text = '合成输入') {
  const ref = { sourceKey: 'source-' + id, inboundKey: 'inbound-' + id, scopeKey: 'scope-synthetic' }
  return { ...ref, message: createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'plugin:dsh-echo', form: 'relay', platform: 'qq-official', replyContext: ref } }) }
}
export const local = text => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
export function * response (text = '合成回复', calls = [], finish = calls.length ? 'tool-calls' : 'stop') {
  let index = 0
  if (text) {
    yield { type: 'block-start', index, blockType: 'text' }
    yield { type: 'text-delta', index, text }
    yield { type: 'block-end', index: index++, block: { type: 'text', text } }
  }
  for (const call of calls) {
    yield { type: 'block-start', index, blockType: 'tool-call' }
    yield { type: 'tool-call-delta', index, id: call.id, name: call.name, argumentsDelta: call.arguments ?? '{}' }
    yield { type: 'block-end', index: index++, block: { type: 'tool-call', id: call.id, name: call.name, arguments: call.arguments ?? '{}' } }
  }
  yield { type: 'finish', reason: { kind: finish } }
}
let serial = 0
export async function host (t, { script, resolveModel, preStep, onEvent, seed, sid, tools = [], trackerLimits } = {}) {
  const ctx = new Context(), trace = [], requests = [], executions = [], rejectedObservations = []
  const tag = 'case-' + ++serial
  traces.push({ tag, trace, requests, executions, rejectedObservations })
  let trackerInstance, agent
  class FakeAdapter extends llm.LlmAdapter {
    async resolveModel (provider, model, signal) {
      trace.push({ type: 'fake/prepare' })
      if (resolveModel) await resolveModel({ provider, model, signal })
      return { provider, id: model, name: model }
    }
    async * stream (request) {
      requests.push({ messageIds: request.messages.map(m => m.id) })
      trace.push({ type: 'fake/stream', requestIndex: requests.length - 1 })
      yield * (script ? script(request, requests.length - 1) : response())
    }
  }
  for (const [plugin, config] of [[AgentRegistry], [SessionStore], [SessionProjectionRegistry], [SystemPrompt, { includeRuntimeContext: false }], [llm.LlmRuntime], [ToolRuntime, { mode: 'native' }], [AgentLoop, { agents: [], maxParallelToolCalls: 10 }]]) await ctx.plugin(plugin, config)
  ctx.llm.registerAdapter(['echo020-fake'], new FakeAdapter())
  for (const def of tools) ctx.tools.register(defineTool({ name: def.name, description: 'Synthetic memory-only tool', parameters: {}, isConcurrencySafe: () => true,
    output: { schema: { type: 'object', properties: { ok: { type: 'boolean' } }, additionalProperties: false }, render: () => [{ type: 'text', text: 'synthetic tool result' }] },
    execute: async (_args, exec) => {
      // The actual ToolRuntime supplies this exec; no hand-written turn fields.
      const resolution = trackerInstance.resolveToolCall(exec)
      executions.push({ callId: exec.callId, rootCallId: exec.rootCallId ?? null, hasTurn: 'turn' in exec, hasStep: 'step' in exec, resolution })
      trace.push({ type: 'fake/tool-body', callId: exec.callId, resolution })
      if (def.execute) await def.execute(exec, { ctx, get agent () { return agent }, tracker: trackerInstance })
      return { ok: true }
    } }))
  t.after(async () => { traces.find(c => c.tag === tag).final = trackerInstance?.snapshot(); await ctx.fiber.dispose() })
  const handle = await ctx.agents.create({ sessionId: sid ?? 'echo020-' + serial, meta: { cwd: tmpRoot }, ...(seed ? { seed } : {}), agentOptions: { provider: 'echo020-fake', model: 'memory-model' },
    setup: (agentCtx, instance) => {
      trackerInstance = tracker.createOfficialTurnTracker({ agent: instance, session: instance.session, bootEpoch: 'test-boot', agentEpoch: tag, liveFromSeq: instance.session.seq, ...(trackerLimits ? { limits: trackerLimits } : {}) })
      agentCtx.on('session/event', (session, event) => {
        trace.push({ type: event.type, seq: event.seq, ...(event.type === 'user/message' ? { messageId: event.data.id, userHasTurn: 'turn' in event.data } : { turn: event.data?.turn, step: event.data?.step }), ...(event.type === 'assistant/message' ? { interrupted: event.data.interrupted === true } : {}), ...(event.type === 'turn/end' ? { reason: event.data.reason.kind, error: event.data.reason.error } : {}) })
        const result = trackerInstance.observeSessionEvent({ agent: instance, session, event })
        if (!result.ok) rejectedObservations.push({ type: event.type, seq: event.seq, reason: result.reason })
        onEvent?.(event, instance, trackerInstance)
      })
      agentCtx.on('agent/inbox/claimed', payload => {
        const result = trackerInstance.observeClaim({ ...payload, session: instance.session })
        trace.push({ type: 'agent/inbox/claimed', messageId: payload.message.id, turn: payload.turn, result, state: trackerInstance.sourceStatus(payload.message.source.replyContext?.sourceKey)?.state })
        if (!result.ok) rejectedObservations.push({ type: 'agent/inbox/claimed', reason: result.reason })
      })
      if (preStep) agentCtx.on('agent/pre-step', (payload, next) => preStep(payload, next, { tracker: trackerInstance, trace }))
    } })
  agent = handle.agent
  if (!agent) throw Error('public_factory_handle_missing_agent')
  return { ctx, agent, handle, tracker: trackerInstance, trace, requests, executions, rejectedObservations,
    follow: source => { const r = trackerInstance.registerSource(source); if (!r.ok) throw Error(r.reason); agent.followup(source.message) },
    seed: () => agent.session.snapshotEvents(0) }
}
export function cleanTmp () {
  const resolved = path.resolve(tmpRoot), parent = path.resolve(os.tmpdir())
  if (path.dirname(resolved) !== parent || !path.basename(resolved).startsWith('echo020-')) throw Error('unsafe_cleanup')
  fs.rmSync(resolved, { recursive: true, force: true })
}
