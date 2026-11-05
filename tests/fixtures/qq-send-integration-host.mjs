/** 037-C2：真实B/fs/present/native/A，网络仅允许本机临时假OneBot。 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import tls from 'node:tls'
import dns from 'node:dns'
import dgram from 'node:dgram'
import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import { syncBuiltinESMExports } from 'node:module'
import { pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'
import { WebSocket } from 'ws'

const tmpParent = fs.realpathSync(os.tmpdir())
export const tmpRoot = fs.mkdtempSync(path.join(tmpParent, 'echo-037-integration-'))
for (const [name, relative] of Object.entries({
  DSH_HOME: 'dsh', DSH_DATA_DIR: 'dsh', ECHO_DATA_DIR: 'echo',
  ECHO_QQ_DATA_DIR: 'qq', ECHO_QQ_OFFICIAL_DATA_DIR: 'official',
  XDG_CONFIG_HOME: 'config', XDG_DATA_HOME: 'data'
})) {
  process.env[name] = path.join(tmpRoot, relative)
  fs.mkdirSync(process.env[name], { recursive: true })
}
process.env.ECHO_DB = path.join(tmpRoot, 'echo', 'synthetic-integration.db')

const ports = new Set()
const nativeConnect = net.Socket.prototype.connect
export const isolation = { deniedNetworkAttempts: 0, allowedLoopbackConnections: 0, persistenceMounted: false }
function forbidden () { isolation.deniedNetworkAttempts++; throw Error('integration_external_network_forbidden') }
net.Socket.prototype.connect = function (...args) {
  let first = args[0]
  if (Array.isArray(first)) first = first[0]
  const options = first && typeof first === 'object' ? first : { port: first, host: args[1] }
  const host = options.host ?? options.hostname
  const port = Number(options.port)
  if (host !== '127.0.0.1' || !ports.has(port)) return forbidden()
  isolation.allowedLoopbackConnections++
  return Reflect.apply(nativeConnect, this, args)
}
tls.connect = forbidden
dns.lookup = (hostname, options, callback) => {
  if (hostname !== '127.0.0.1') return forbidden()
  const completion = typeof options === 'function' ? options : callback
  const answer = { address: '127.0.0.1', family: 4 }
  process.nextTick(() => {
    if (options?.all) completion(null, [answer])
    else completion(null, answer.address, answer.family)
  })
}
dns.resolve = forbidden
for (const key of Object.keys(dns.promises)) {
  if (typeof dns.promises[key] === 'function' && /^(lookup|resolve)/.test(key)) dns.promises[key] = forbidden
}
dns.promises.lookup = async (hostname, options) => {
  if (hostname !== '127.0.0.1') return forbidden()
  const answer = { address: '127.0.0.1', family: 4 }
  return options?.all ? [answer] : answer
}
dgram.createSocket = forbidden
globalThis.fetch = forbidden
globalThis.WebSocket = class { constructor () { forbidden() } }
syncBuiltinESMExports()

const [
  { Context }, { AgentRegistry }, { SessionStore }, { SessionProjectionRegistry },
  { AgentLoop }, { SystemPrompt }, { ToolRuntime, defineTool }, llm,
  { LocalFileSystem }, present,
  { createQQFileSender }, { createQQSendArtifacts },
  { createQQFileSendService }, { createOneBot },
  { buildPrivateEnvelope }, { allowsInbound },
  { parseEnvelope, renderInboundText }, relayContent, eyes,
  { prepareForwardImages }, { ECHO_SOURCE_KIND }
] = await Promise.all([
  import('@deepseek-ai/cordis'), import('@deepseek-ai/dsh-agent'),
  import('@deepseek-ai/dsh-session'), import('@deepseek-ai/dsh-session-projection'),
  import('@deepseek-ai/dsh-agent-loop'), import('@deepseek-ai/dsh-system-prompt'),
  import('@deepseek-ai/dsh-tools'), import('@deepseek-ai/dsh-llm'),
  import('@deepseek-ai/dsh-fs-local'),
  import('@deepseek-ai/dsh-tool-present'),
  import('../../lib/qq-send-file.js'), import('../../lib/qq-send-artifacts.js'),
  import('../../../dsh-qq-bridge/lib/file-send-service.js'), import('../../../dsh-qq-bridge/lib/onebot.js'),
  import('../../../dsh-qq-bridge/lib/envelope.js'), import('../../../dsh-qq-bridge/lib/config.js'),
  import('../../lib/relay.js'), import('../../lib/relay-content.js'), import('../../lib/eyes.js'),
  import('../../lib/relay-image-content.js'), import('../../lib/source-kind.js')
])

export const { createUserMessage } = llm
export const TOOL = 'echo_qq_file_send'
export const REF = 'report.txt'
export const BODY = '037-C2真实字节装配\n中文😀\n'
export const PRIVATE = Object.freeze({
  platform: 'qq', chatType: 'private', chatId: '11', senderId: '11', isMaster: true
})
export const GROUP = Object.freeze({
  platform: 'qq', chatType: 'group', chatId: '33', senderId: '11', isMaster: true
})
export const deferred = () => {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}
export async function bounded (promise, ms = 3000) {
  let timer
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(Error('integration_boundary_not_reached')), ms)
    })])
  } finally { clearTimeout(timer) }
}
export async function settled (promise, ms = 25) {
  let timer
  try {
    return await Promise.race([promise.then(() => true), new Promise(resolve => { timer = setTimeout(() => resolve(false), ms) })])
  } finally { clearTimeout(timer) }
}
export function * response (text = '合成结束', calls = []) {
  let index = 0
  if (text) {
    yield { type: 'block-start', index, blockType: 'text' }
    yield { type: 'text-delta', index, text }
    yield { type: 'block-end', index: index++, block: { type: 'text', text } }
  }
  for (const call of calls) {
    yield { type: 'block-start', index, blockType: 'tool-call' }
    yield { type: 'tool-call-delta', index, id: call.id, name: call.name, argumentsDelta: call.arguments ?? '{}' }
    yield { type: 'block-end', index: index++, block: { type: 'tool-call', ...call } }
  }
  yield { type: 'finish', reason: { kind: calls.length ? 'tool-calls' : 'stop' } }
}
export const toolCall = (id, name, args) => ({ id, name, arguments: JSON.stringify(args) })
export const presentCall = (id, files = ['echo-outgoing/' + REF]) =>
  toolCall(id, 'present', { files: files.map(value => typeof value === 'string' ? { path: value } : value) })
export const sendCall = (id, ref = REF) => toolCall(id, TOOL, { ref })

const indexSource = fs.readFileSync(new URL('../../lib/index.js', import.meta.url), 'utf8')
const injectStart = indexSource.indexOf('  async function injectInboundNow (')
const injectEnd = indexSource.indexOf('\n  }\n', injectStart)
assert.ok(injectStart >= 0 && injectEnd > injectStart, '实际入站函数声明可提取')
const actualInject = indexSource.slice(injectStart, injectEnd + '\n  }'.length)

async function freePort () {
  const probe = net.createServer()
  probe.listen(0, '127.0.0.1')
  await once(probe, 'listening')
  const port = probe.address().port
  await new Promise(resolve => probe.close(resolve))
  return port
}
let serial = 0
export async function assemble (t, {
  files = { ['echo-outgoing/' + REF]: BODY },
  script, beforeRequest, onUpload, fakeTools = [],
  timeoutMs = 2500, uploadTimeoutMs = 2000
} = {}) {
  const tag = 'integration-' + ++serial
  const cwd = path.join(tmpRoot, tag)
  fs.mkdirSync(path.join(cwd, 'echo-outgoing'), { recursive: true })
  function filename (relative) {
    const target = path.resolve(cwd, relative)
    const within = path.relative(cwd, target)
    if (!within || within.startsWith('..') || path.isAbsolute(within)) throw Error('unsafe_synthetic_fixture_path')
    return target
  }
  function write (relative, value) {
    const target = filename(relative)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, value)
    return target
  }
  for (const [relative, value] of Object.entries(files)) write(relative, value)
  const ctx = new Context(), frames = [], logs = [], transportHandles = [], binds = [], followups = [], followupBindings = []
  const values = [], executions = [], events = [], entered = [], claims = [], runtimeResults = [], requests = []
  const artifactTrace = { prepare: [], register: [], list: [], snapshot: [], revoke: [], close: 0 }
  const registered = deferred()
  const settings = {
    enabled: true, groupEnabled: true, allowedUsers: ['11'], allowedGroups: ['33'],
    masterId: '11', selfId: '99', accessToken: 'synthetic-integration-037'
  }
  const awake = new Set(['33'])
  let admission = true, agent, sender, clientSocket, callbackError
  const port = await freePort()
  ports.add(port)
  const onebot = createOneBot({
    host: '127.0.0.1', port, accessToken: settings.accessToken,
    heartbeatMs: 60000, fileUploadTimeoutMs: uploadTimeoutMs,
    log: (level, message, extra) => logs.push({ level, message, extra })
  })
  const nativeService = createQQFileSendService({
    clientOf: () => onebot, settingsOf: () => settings,
    isAwake: id => awake.has(String(id)), isCurrent: () => admission
  })
  const service = {
    beginFileUpload (...args) {
      const handle = nativeService.beginFileUpload(...args)
      transportHandles.push(handle)
      return handle
    }
  }
  sender = createQQFileSender({
    isEnabled: () => true, sessionEnabledOf: () => true, timeoutMs,
    serviceOf: () => service,
    createArtifacts: options => {
      const actual = createQQSendArtifacts(options)
      return {
        async prepare (...args) {
          const value = await actual.prepare(...args)
          artifactTrace.prepare.push({ ok: value.ok, code: value.code })
          return value
        },
        async registerPresented (...args) {
          const value = await actual.registerPresented(...args)
          artifactTrace.register.push({ ok: value.ok, code: value.code, items: value.items,
            rejected: value.rejected, presentation: args[1] })
          registered.resolve(value)
          return value
        },
        async list (...args) {
          const value = await actual.list(...args)
          artifactTrace.list.push({ ok: value.ok, code: value.code, items: value.items })
          return value
        },
        async snapshot (...args) {
          const value = await actual.snapshot(...args)
          artifactTrace.snapshot.push({ ok: value.ok, code: value.code, ref: value.ref,
            name: value.name, bytes: value.bytes, dataBytes: value.data?.byteLength })
          return value
        },
        async revoke (...args) {
          const value = await actual.revoke(...args)
          artifactTrace.revoke.push({ ok: value?.ok, code: value?.code })
          return value
        },
        async close () { artifactTrace.close++; return actual.close() }
      }
    }
  })
  const harness = {}
  function reply (entry, patch = {}) {
    entry.socket.send(JSON.stringify({
      status: 'ok', retcode: 0, echo: entry.frame.echo,
      data: { file_id: 'synthetic-integration-confirmation' }, ...patch
    }))
  }
  t.after(async () => {
    admission = false
    await sender.dispose()
    nativeService.dispose?.()
    try { clientSocket?.close() } catch {}
    await onebot.stop()
    await Promise.allSettled(transportHandles.map(value => value.physicalDone))
    ports.delete(port)
    await ctx.fiber.dispose()
    if (callbackError) throw callbackError
  })
  await onebot.start()
  clientSocket = new WebSocket('ws://127.0.0.1:' + port, { headers: { authorization: 'Bearer ' + settings.accessToken } })
  clientSocket.on('message', data => {
    const entry = { socket: clientSocket, frame: JSON.parse(String(data)) }
    frames.push(entry)
    if (!['upload_private_file', 'upload_group_file'].includes(entry.frame.action)) {
      if (!['get_login_info', 'get_status'].includes(entry.frame.action)) {
        callbackError = Error('integration_unexpected_onebot_action')
      }
      reply(entry, { data: {} }); return
    }
    try {
      const answer = onUpload ? onUpload(entry, harness) : true
      Promise.resolve(answer).then(send => { if (send !== false) reply(entry) }).catch(error => { callbackError = error })
    } catch (error) { callbackError = error }
  })
  await once(clientSocket, 'open')
  class FakeAdapter extends llm.LlmAdapter {
    async resolveModel (provider, model) { return { provider, id: model, name: model } }
    async * stream (request) {
      const index = requests.length
      requests.push({ index })
      if (beforeRequest) await beforeRequest(index, harness)
      if (script) yield * script(request, index, harness)
      else if (index % 3 === 0) yield * response('', [presentCall(tag + '-p-' + index)])
      else if (index % 3 === 1) yield * response('', [sendCall(tag + '-s-' + index)])
      else yield * response('合成文件装配结束')
    }
  }
  for (const [plugin, config] of [
    [AgentRegistry], [SessionStore], [SessionProjectionRegistry],
    [SystemPrompt, { includeRuntimeContext: false }], [llm.LlmRuntime],
    [ToolRuntime, { mode: 'native' }], [AgentLoop, { agents: [], maxParallelToolCalls: 2 }]
  ]) await ctx.plugin(plugin, config)
  new LocalFileSystem(ctx, { cwd, diffBasisMaxBytes: 10 * 1024 * 1024 })
  ctx.llm.registerAdapter(['send-integration-fake'], new FakeAdapter())
  const definition = sender.toolDefinition()
  ctx.tools.register(defineTool({
    ...definition,
    execute: async (args, exec) => {
      executions.push({ exec, args, hasTurn: 'turn' in exec, hasStep: 'step' in exec })
      const value = await definition.execute(args, exec)
      values.push(value)
      return value
    }
  }))
  for (const tool of fakeTools) ctx.tools.register(defineTool({
    description: 'Synthetic integration tool', parameters: {}, isConcurrencySafe: () => true,
    output: { schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true } } },
      render: () => [{ type: 'text', text: '合成工具结果' }] },
    ...tool,
    execute: async (args, exec) => tool.execute(args, exec, { ctx, sender })
  }))
  const handle = await ctx.agents.create({
    sessionId: tag, meta: { cwd },
    agentOptions: { provider: 'send-integration-fake', model: 'memory-only' },
    setup: async (agentCtx, instance) => {
      agent = instance
      await agentCtx.plugin(present, { maxFiles: 8 })
      agentCtx.on('session/event', (session, event) => {
        events.push(event)
        sender.observeSessionEvent(session, event)
        if (event.type === 'user/message') entered.push(event.data)
      })
      agentCtx.on('agent/inbox/claimed', payload => { claims.push(payload); sender.observeClaim(payload) })
      agentCtx.on('tools/result', (exec, result) => {
        runtimeResults.push({ exec, result })
        sender.observeToolResult(exec, result)
      })
    }
  })
  agent = handle.agent
  assert.ok(agent)
  const followup = agent.followup.bind(agent)
  agent.followup = input => {
    followups.push(input)
    followupBindings.push({ input, binding: binds.at(-1), bindCount: binds.length })
    return followup(input)
  }
  const deps = {
    ...eyes, ...relayContent, prepareForwardImages, ECHO_SOURCE_KIND, createUserMessage,
    attachments: {}, audit: () => {},
    ctx: { logger: { info: () => {}, warn: () => {} } },
    forwardReader: { bind: () => assert.fail('fixture has no received forward') },
    fileReader: { bind: () => assert.fail('fixture has no received file') },
    fileSender: { bind: options => { binds.push(options); return sender.bind(options) } }
  }
  const inject = new Function(...Object.keys(deps), actualInject + '\nreturn injectInboundNow')(...Object.values(deps))
  let messageSequence = 0
  function environment (source, { text = '请把本轮已展示文件发到这里', voices } = {}) {
    const built = buildPrivateEnvelope({
      userId: source.senderId, userName: '合成发送者', messageId: tag + '-input-' + ++messageSequence,
      text, isMaster: source.isMaster, chatType: source.chatType,
      groupId: source.chatType === 'group' ? source.chatId : '', voices
    })
    assert.equal(built.ok, true)
    const parsed = parseEnvelope(built.envelope)
    assert.equal(parsed.ok, true)
    return parsed.value
  }
  Object.assign(harness, {
    tag, cwd, output: path.join(cwd, 'echo-outgoing'), ctx, agent, sender, onebot, service,
    frames, logs, transportHandles, values, executions, events, entered, claims, runtimeResults,
    requests, artifactTrace, settings, awake, binds, followups, followupBindings, registered, reply,
    admission: value => { admission = value },
    filePath: filename, write,
    uploadFrames: () => frames.filter(value => ['upload_private_file', 'upload_group_file'].includes(value.frame.action)),
    async enqueue (source = PRIVATE, options = {}) {
      const env = environment(source, options)
      const current = () => admission &&
        allowsInbound(settings, { userId: env.senderId, chatType: env.chatType,
          groupId: env.chatType === 'group' ? env.chatId : '' }).ok === true &&
        (env.chatType !== 'group' || awake.has(env.chatId))
      const result = await inject(agent, env, renderInboundText(env), { isCurrent: current })
      return { result, env }
    },
    async enqueueLocal () {
      const input = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '合成本地请求' }] })
      await agent.runMaintenance(async () => agent.followup(input))
      return input
    }
  })
  return harness
}

export function sendResults (h) {
  const ids = new Set(h.executions.map(x => x.exec.callId))
  return h.events.filter(e => e.type === 'tool/result' && ids.has(e.data.message.toolCallId)).map(e => e.data.message)
}
export function safeValues (h) {
  const visible = JSON.stringify(h.values) + sendResults(h).flatMap(value => value.content || [])
    .filter(block => block.type === 'text').map(block => block.text).join('\n') + JSON.stringify(h.logs)
  assert.doesNotMatch(visible, /base64:\/\/|file_id|synthetic-integration-confirmation|chatId|senderId|authority|[A-Za-z]:\\|C:\/|https?:\/\//)
  assert.deepEqual(JSON.parse(JSON.stringify(h.values)), h.values)
}
export function cleanupRoot () {
  const resolved = fs.realpathSync(tmpRoot)
  if (path.dirname(resolved) !== tmpParent || !path.basename(resolved).startsWith('echo-037-integration-')) {
    throw Error('unsafe_integration_cleanup')
  }
  fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 3 })
}
