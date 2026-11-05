/**
 * 033：执行index.js真实注入/排队函数体，只替换宿主、抓图和保存依赖。
 * 必须使用tests/_isolate.mjs；不启动插件，不访问网络、QQ、模型或用户库。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createInboundQueue } from '../lib/inbound-queue.js'
import * as eyes from '../lib/eyes.js'
import * as relayContent from '../lib/relay-content.js'
import { ECHO_SOURCE_KIND } from '../lib/source-kind.js'

const source = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
const start = source.indexOf('async function injectInboundNow (')
const end = source.indexOf('  function applyRelayPermission (', start)
assert.ok(start >= 0 && end > start, '必须找到实际injectInboundNow到flushInboundQueue的声明段')
const actualDeclarations = source.slice(start, end)
assert.match(actualDeclarations, /async function injectInbound \(/)
assert.match(actualDeclarations, /async function flushInboundQueue \(/)

function deferred () {
  let resolve
  const promise = new Promise(yes => { resolve = yes })
  return { promise, resolve }
}
async function until (predicate) {
  for (let i = 0; i < 100; i += 1) {
    if (predicate()) return
    await Promise.resolve()
  }
  assert.ok(predicate(), '假依赖驱动的注入链应在微任务内推进')
}
const emptyImages = () => ({ images: [], problems: [], bytes: 0 })
const envOf = (patch = {}) => ({
  platform: 'qq', chatId: '33', chatType: 'group',
  senderId: '11', senderName: '甲', isMaster: true,
  msgId: 'guard-message', text: '原始键入文字', images: [],
  voices: [{ received: true }], forwardContent: null,
  ...patch
})

function harness (options = {}) {
  const queue = createInboundQueue({ limit: 50 })
  const sent = [], collectCalls = [], logs = [], bound = []
  const control = {
    busy: options.busy === true,
    idleGate: options.idleGate ?? null,
    collectGate: options.collectGate ?? null,
    maintenanceGate: options.maintenanceGate ?? null
  }
  const agent = {
    session: { id: 'test-guard-session' },
    runMaintenance (callback) {
      if (control.busy) throw Error('synthetic busy')
      if (control.maintenanceGate) return control.maintenanceGate.promise.then(callback)
      return Promise.resolve(callback())
    },
    followup: message => sent.push(message),
    whenIdle: () => control.idleGate ? control.idleGate.promise : Promise.resolve()
  }
  const logger = { info: (...args) => logs.push(args), warn: (...args) => logs.push(args) }
  const dependencies = {
    ...eyes, ...relayContent,
    ECHO_SOURCE_KIND,
    inboundQueue: queue,
    ctx: { logger },
    log: (...args) => logs.push(args),
    audit: () => {},
    attachments: { imageLimits: {} },
    forwardReader: { bind: value => bound.push(value) },
    fileSender: { bind: () => {} },
    createUserMessage: value => ({ role: 'user', ...value }),
    collectImages: async refs => {
      collectCalls.push(refs)
      return control.collectGate ? await control.collectGate.promise : emptyImages()
    },
    saveImageBlocks: async () => []
  }
  // The three production function bodies and their flushing latch execute unchanged.
  const factory = new Function(...Object.keys(dependencies),
    actualDeclarations + '\nreturn { injectInboundNow, injectInbound, flushInboundQueue }')
  return { ...factory(...Object.values(dependencies)), queue, agent, control, sent, collectCalls, logs, bound }
}

function hasFunction (value) {
  if (typeof value === 'function') return true
  if (!value || typeof value !== 'object') return false
  return Object.values(value).some(hasFunction)
}

test('033 execution：抓图await期间撤销，实际injectInboundNow不得followup', async () => {
  const collectGate = deferred(), h = harness({ collectGate })
  let current = true
  const execution = { isCurrent: () => current }
  const env = envOf({ images: [{ url: 'https://example.invalid/guard.png' }] })
  const pending = h.injectInboundNow(h.agent, env, '实际渲染正文', execution)
  await until(() => h.collectCalls.length === 1)
  current = false
  collectGate.resolve(emptyImages())
  const result = await pending
  assert.notEqual(result, 'ok')
  assert.equal(h.sent.length, 0)
  assert.equal(h.bound.length, 0)
})

test('033 execution：正常busy排队保存同一execution对象，仍有效时成功', async () => {
  const idleGate = deferred(), h = harness({ busy: true, idleGate })
  const execution = { isCurrent: () => true }
  const env = envOf()
  const original = structuredClone(env)
  try {
    assert.equal(await h.injectInbound(h.agent, env, '实际渲染正文', execution), 'queued')
    assert.equal(h.queue.size(), 1)
    assert.equal(h.queue.peek().execution, execution, 'execution不能在wrapper或queue浅拷贝时丢失')
    assert.equal('execution' in h.queue.peek().env, false)
    assert.deepEqual(env, original)
    h.control.busy = false
    idleGate.resolve()
    await until(() => h.queue.size() === 0)
    assert.equal(h.sent.length, 1)
    assert.equal(h.sent[0].source.rawText, env.text)
  } finally {
    h.control.busy = false
    idleGate.resolve()
  }
})

test('033 execution：busy排队后stop再wake，旧scope context不能复活', async () => {
  const idleGate = deferred(), h = harness({ busy: true, idleGate })
  const oldScope = {}, scopes = new Map([['group-a', oldScope]])
  const execution = { isCurrent: () => scopes.get('group-a') === oldScope }
  try {
    assert.equal(await h.injectInbound(h.agent, envOf(), '旧轮正文', execution), 'queued')
    scopes.delete('group-a')
    scopes.set('group-a', {})
    h.control.busy = false
    idleGate.resolve()
    await until(() => h.queue.size() === 0)
    assert.equal(h.sent.length, 0, '必须实际经过flush时复核旧execution')
  } finally {
    h.control.busy = false
    idleGate.resolve()
  }
})

test('033 execution：另一群stop不误杀本群仍有效的context', async () => {
  const idleGate = deferred(), h = harness({ busy: true, idleGate })
  const scopeA = {}, scopes = new Map([['group-a', scopeA], ['group-b', {}]])
  const execution = { isCurrent: () => scopes.get('group-a') === scopeA }
  try {
    assert.equal(await h.injectInbound(h.agent, envOf(), '本群正文', execution), 'queued')
    scopes.delete('group-b')
    scopes.set('group-b', {})
    h.control.busy = false
    idleGate.resolve()
    await until(() => h.queue.size() === 0)
    assert.equal(h.sent.length, 1)
    assert.equal(h.sent[0].source.chatId, '33')
  } finally {
    h.control.busy = false
    idleGate.resolve()
  }
})

test('033 execution：context函数不写入JSON信封或模型content/source', async () => {
  const h = harness(), execution = { isCurrent: () => true }
  const env = envOf(), original = structuredClone(env)
  assert.equal(await h.injectInbound(h.agent, env, '附加内容与原话分块后的正文', execution), 'ok')
  assert.deepEqual(env, original)
  assert.equal(hasFunction(env), false)
  assert.equal(h.sent.length, 1)
  assert.equal(hasFunction(h.sent[0]), false)
  for (const key of ['execution', 'isCurrent', 'signal']) {
    assert.equal(key in h.sent[0].source, false)
    assert.equal(key in env, false)
  }
  assert.equal(h.sent[0].source.rawText, '原始键入文字')
})

test('033 execution：缺省第四参时保持旧注入行为', async () => {
  const h = harness()
  const env = envOf({ voices: [] })
  assert.equal(await h.injectInbound(h.agent, env, '旧调用渲染正文'), 'ok')
  assert.equal(h.sent.length, 1)
  assert.equal(h.sent[0].source.rawText, env.text)
})

test('033 execution：起点已撤销时不抓图、不排队、不followup', async () => {
  const h = harness(), execution = { isCurrent: () => false }
  const result = await h.injectInbound(h.agent,
    envOf({ images: [{ url: 'https://example.invalid/guard.png' }] }), '旧轮正文', execution)
  assert.notEqual(result, 'ok')
  assert.notEqual(result, 'queued')
  assert.equal(h.collectCalls.length, 0)
  assert.equal(h.queue.size(), 0)
  assert.equal(h.sent.length, 0)
})

test('033 execution：maintenance等待后撤销，真实callback提交点仍须复核', async () => {
  const maintenanceGate = deferred(), h = harness({ maintenanceGate })
  let current = true
  const pending = h.injectInboundNow(h.agent, envOf(), '旧轮正文', { isCurrent: () => current })
  await Promise.resolve()
  current = false
  maintenanceGate.resolve()
  assert.notEqual(await pending, 'ok')
  assert.equal(h.sent.length, 0)
})
