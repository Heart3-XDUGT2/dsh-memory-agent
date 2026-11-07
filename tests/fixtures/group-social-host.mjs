/** 044: real public host and ToolRuntime, synthetic model/outbox only. */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import tls from 'node:tls'
import http from 'node:http'
import https from 'node:https'
import { syncBuiltinESMExports } from 'node:module'

export const temporaryRoot = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'echo044-host-'))
const home = path.join(temporaryRoot, 'home')
fs.mkdirSync(home)
const profileKeys = ['HOME', 'USERPROFILE', 'DSH_HOME', 'DSH_DATA_DIR', 'ECHO_DATA_DIR',
  'APPDATA', 'LOCALAPPDATA', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME']
for (const name of Object.keys(process.env)) if (profileKeys.some(key => key.toLowerCase() === name.toLowerCase())) delete process.env[name]
for (const name of profileKeys) process.env[name] = home
export const isolation = { networkAttempts: 0 }
function blocked () { isolation.networkAttempts++; throw Error('echo044_network_forbidden') }
net.connect = net.createConnection = net.Socket.prototype.connect = blocked
tls.connect = http.request = http.get = https.request = https.get = blocked
globalThis.fetch = blocked
globalThis.WebSocket = class { constructor () { blocked() } }
syncBuiltinESMExports()

const [{ Context }, { AgentRegistry }, { SessionStore }, { SessionProjectionRegistry }, { AgentLoop },
  { SystemPrompt }, { ToolRuntime, defineTool }, llm, { createRelay, renderInboundText }, { createSpeaker },
  { relayToolDefinitions }, { createGroupParticipation, observeGroupParticipation }, { createTurnStopper }] = await Promise.all([
  import('@deepseek-ai/cordis'), import('@deepseek-ai/dsh-agent'), import('@deepseek-ai/dsh-session'),
  import('@deepseek-ai/dsh-session-projection'), import('@deepseek-ai/dsh-agent-loop'),
  import('@deepseek-ai/dsh-system-prompt'), import('@deepseek-ai/dsh-tools'), import('@deepseek-ai/dsh-llm'),
  import('../../lib/relay.js'), import('../../lib/speak.js'), import('../../lib/relay-tools.js'),
  import('../../lib/group-social.js'), import('../../lib/turn-stopping.js')
])
let serial = 0
export const groupEnvelope = (patch = {}) => ({
  v: 1, platform: 'qq', chat: { id: '33', type: 'group', title: '合成群' },
  sender: { id: '22', name: '合成群友', isMaster: false },
  text: '合成问题', msgId: 'message-' + ++serial, ts: 100,
  groupContext: { v: 1, chatId: '33', recent: [] }, ...patch
})
export function * response (text = '', calls = []) {
  let index = 0
  if (text) {
    yield { type: 'block-start', index, blockType: 'text' }
    yield { type: 'text-delta', index, text }
    yield { type: 'block-end', index: index++, block: { type: 'text', text } }
  }
  for (const call of calls) {
    const id = 'native-call-' + ++serial, args = JSON.stringify(call.args ?? {})
    yield { type: 'block-start', index, blockType: 'tool-call' }
    yield { type: 'tool-call-delta', index, id, name: call.name, argumentsDelta: args }
    yield { type: 'block-end', index: index++, block: { type: 'tool-call', id, name: call.name, arguments: args } }
  }
  yield { type: 'finish', reason: { kind: calls.length ? 'tool-calls' : 'stop' } }
}
export async function createSocialHost (t, { script, autoReply = true, officialDispatch, endingFault,
  renderOptions, claimed, assemble } = {}) {
  const ctx = new Context(), queued = [], results = [], requests = [], bindings = [], stops = [], ends = []
  const channels = new Map(), inbox = new Set(), nativeCalls = new Map(), sid = 'echo044-native-' + ++serial
  let agent, speaker, activeSource
  const participation = createGroupParticipation()
  const store = {
    relayBeginInbound: ({ msgId }) => { const duplicate = inbox.has(msgId); inbox.add(msgId); return { duplicate } },
    relayCommitInbound: () => true, relayRollbackInbound: ({ msgId }) => inbox.delete(msgId),
    relayUpsertChannel: row => channels.set(row.chatId, { ...row, enabled: 1, proactive: 1, lastInAt: row.now }),
    relayChannelsOfSession: () => [...channels.values()], relayListChannels: () => [...channels.values()],
    relayRecentOutbound: () => [], relayCancelBubbles: () => ({ rows: 0 }),
    relayEnqueue: row => { queued.push(row); return { ok: true } }
  }
  channels.set('11', { platform: 'qq', chatId: '11', chatType: 'private', sessionId: sid,
    label: '合成私聊', enabled: 1, proactive: 1, lastInAt: 1 })
  const relay = createRelay({ store, config: () => ({ sessionId: sid, permissionPreset: '',
    autoReplyToOrigin: autoReply, bubble: { enabled: false }, proactiveScope: 'private' }),
    isEnabled: () => true, ensureCompanion: async () => ({ agent, sessionId: sid }),
    applyPermission: () => 'ok',
    injectInbound: async (_agent, env, text, execution) => {
      const accepted = await agent.runMaintenance(() => {
        const source = { kind: 'plugin:dsh-echo', form: 'relay', platform: env.platform,
          chatId: env.chatId, chatType: env.chatType, senderId: env.senderId, senderName: env.senderName,
          isMaster: env.isMaster, rawText: env.text, ...(env.groupContext ? { groupParticipation: true } : {}) }
        const message = llm.createUserMessage({ content: [{ type: 'text',
          text: renderOptions ? renderInboundText(env, renderOptions) : text }], source })
        bindings.push(participation.bind({ agent, message, env, isCurrent: execution.isCurrent ?? (() => true) }))
        activeSource = source
        agent.followup(message)
        return Promise.resolve(true)
      })
      return accepted ? 'ok' : 'busy'
    }
  })
  speaker = createSpeaker({ transport: relay })
  class SyntheticAdapter extends llm.LlmAdapter {
    async resolveModel (provider, model) { return { provider, id: model, name: model } }
    async * stream (request) {
      const index = requests.length
      requests.push(request)
      yield * (script ? script(request, index) : response('合成回复'))
    }
  }
  for (const [plugin, config] of [[AgentRegistry], [SessionStore], [SessionProjectionRegistry],
    [SystemPrompt, { includeRuntimeContext: false }], [llm.LlmRuntime], [ToolRuntime, { mode: 'native' }],
    [AgentLoop, { agents: [], maxParallelToolCalls: 4 }]]) await ctx.plugin(plugin, config)
  ctx.llm.registerAdapter(['echo044-fake'], new SyntheticAdapter())
  for (const definition of relayToolDefinitions({ relay: speaker, groupParticipation: participation,
    isEnabled: () => true, sessionEnabledOf: () => true,
    dispatchOfficial: input => officialDispatch?.(input, activeSource) })) {
    ctx.tools.register(defineTool({ ...definition, execute: async (args, exec) => {
      const value = await definition.execute(args, exec)
      const call = nativeCalls.get(exec.callId)
      // ToolRuntime freezes exec at result notification, after the body runs.
      results.push({ name: definition.name, value,
        native: call?.name === definition.name && exec.agent === agent
          && typeof exec.token === 'symbol' && Symbol.keyFor(exec.token) === undefined
          && exec.signal instanceof AbortSignal && exec.rootCallId === exec.callId,
        hasOwnTurn: Object.hasOwn(exec, 'turn'), callId: exec.callId })
      return value
    } }))
  }
  const stopper = createTurnStopper({ groupParticipationOf: (instance, turn) => {
    const state = participation.snapshot(instance.session)
    return state && state.turn !== turn ? { ...state, blocked: true, active: false } : state
  }, createUserMessage: llm.createUserMessage })
  t.after(() => ctx.fiber.dispose())
  const handle = await ctx.agents.create({ sessionId: sid, meta: { cwd: temporaryRoot },
    agentOptions: { provider: 'echo044-fake', model: 'synthetic' }, setup: (agentCtx, instance) => {
      agentCtx.on('agent/inbox/claimed', payload => {
        participation.observeClaim(payload)
        claimed?.(payload, participation)
      })
      if (assemble) agentCtx.on('system-prompt/assemble',
        (assembly, context, next) => assemble(assembly, context, next, participation))
      agentCtx.on('session/event', (session, event) => {
        if (event.type === 'tool/call') nativeCalls.set(event.data.callId, event.data)
        const observedEvent = event.type === 'turn/end' && endingFault
          ? { ...event, ...(endingFault === 'sequence' ? { seq: event.seq + 1 } : {}) } : event
        const ending = observeGroupParticipation(participation, session, observedEvent)
        if (event.type === 'assistant/message') {
          const text = (event.data.message.content ?? []).filter(b => b.type === 'text').map(b => b.text).join('\n')
          if (text) speaker.captureSegment(sid, text)
        }
        if (event.type === 'turn/end') {
          ends.push({ reason: event.data.reason.kind, participation: ending })
          speaker.finishTurn(sid, { groupParticipation: ending })
        }
      })
      agentCtx.on('agent/turn-stopping', async payload => {
        const state = participation.snapshot(instance.session)
        stops.push(await stopper.handle({ ...payload, capture: {
          sessionId: sid, turnText: state?.action === 'listen' ? '' : '想你',
          longingRead: { pre: { exists: true, due: true, value: 9, threshold: 1 } }
        } }))
      })
    } })
  agent = handle.agent
  return { ctx, agent, participation, queued, results, requests, bindings, stops, ends,
    follow: async (raw, execution = {}) => {
      const result = await relay.handleInbound(raw, execution)
      await agent.whenIdle()
      return result
    },
    local: async (source = { kind: 'user' }) => {
      activeSource = source
      agent.followup(llm.createUserMessage({ content: [{ type: 'text', text: '合成本地输入' }], source }))
      await agent.whenIdle()
    } }
}
