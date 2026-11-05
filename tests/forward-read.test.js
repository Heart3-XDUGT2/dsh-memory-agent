import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createForwardReader } from '../lib/forward-read.js'

const TOKEN = 'a'.repeat(32)
const LABEL = '转发2026-11-02T03:04:05.006Z-1'
const scope = { chatId: '11', chatType: 'private', senderId: '11', isMaster: true }
const freeze = value => {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value) }
  return value
}
const sourceOf = patch => ({ kind: 'plugin:dsh-echo', form: 'relay', platform: 'qq', ...scope, ...patch })
const pageOf = (patch = {}) => ({
  source: 'qq-forward-quote', ref: TOKEN, label: LABEL, page: 2, totalPages: 3, hasMore: true,
  nodes: [{ sender: { id: '22', name: '乙' }, time: 1700000000, text: '合成引文', depth: 0, at: [], imageIndexes: [],
    sourceIndex: 0, textStart: 0, textEnd: 4, continued: false, hasMoreText: false }],
  images: [], notices: [], truncated: false, stats: { requests: 0 },
  ...patch
})

function rig ({ boundScope = scope, read, enabled = true, allowed = true } = {}) {
  const events = new Map(), calls = []
  let time = 1000, live = enabled, inScope = allowed, serial = 0, currentTurn = 0, currentStep = 0
  const session = { id: 'same-session', seq: 0, eventAt: seq => events.get(seq) }
  const agent = { session, status: 'idle', inbox: {} }
  let service = { readForward: async request => { calls.push(request); return read ? read(request) : { ok: true, forwardContent: pageOf() } } }
  const reader = createForwardReader({ serviceOf: () => service, isEnabled: () => live, sessionEnabledOf: () => inScope, now: () => time })
  const bind = (ref = TOKEN, label = LABEL, origin = boundScope) => reader.bind({
    agent, env: { platform: 'qq', ...origin, forwardContent: { ref, label } }
  })
  bind()
  const emit = (type, data, append = false) => {
    const event = freeze({ type, data, seq: session.seq++, ...(append ? { surfaceOp: 'append' } : {}) })
    events.set(event.seq, event)
    reader.observeSessionEvent(session, event)
    return event
  }
  const start = () => { agent.status = 'running'; currentTurn++; currentStep = 0; emit('turn/start', { turn: currentTurn }) }
  const message = (source = sourceOf({ forwardRef: TOKEN }), text = '继续读') => freeze({
    id: 'message-' + ++serial, role: 'user', content: [{ type: 'text', text }], source
  })
  const claim = m => reader.observeClaim({ agent, message: m, turn: currentTurn })
  const enter = m => {
    if (!currentStep) { currentStep = 1; emit('step/start', { turn: currentTurn, step: currentStep }) }
    emit('user/message', m, true)
  }
  const publish = (id = 'root-' + ++serial, args = { ref: LABEL, page: 2 }) => {
    emit('assistant/message', { turn: currentTurn, step: currentStep, message: {
      role: 'assistant', content: [{ type: 'tool-call', id, name: 'echo_qq_forward_read', arguments: JSON.stringify(args) }]
    } }, true)
    emit('tool/call', { turn: currentTurn, step: currentStep, callId: id, name: 'echo_qq_forward_read', arguments: JSON.stringify(args) })
    const controller = new AbortController()
    return { args, controller, exec: { agent, callId: id, rootCallId: id, name: 'echo_qq_forward_read',
      arguments: args, token: Symbol(id), signal: controller.signal } }
  }
  const activate = (source = sourceOf({ forwardRef: TOKEN })) => {
    start(); const m = message(source); claim(m); enter(m); return publish()
  }
  const end = () => {
    if (currentStep) emit('step/end', { turn: currentTurn, step: currentStep })
    emit('turn/end', { turn: currentTurn, reason: { kind: 'completed' } })
    currentStep = 0; agent.status = 'idle'
  }
  const execute = call => reader.toolDefinition().execute(call.args, call.exec)
  return { reader, session, agent, calls, bind, emit, start, message, claim, enter, publish, activate, end, execute,
    setService: value => { service = value }, clock: value => { time = value },
    power: value => { live = value }, sessionPower: value => { inScope = value } }
}

test('033读取：真实当前QQ来源内按友好名映射内部token，输出不泄漏token/工具名', async () => {
  const h = rig(), call = h.activate(), value = await h.execute(call)
  assert.equal(value.ok, true)
  assert.equal(value.ref, LABEL)
  assert.equal(h.calls.length, 1)
  assert.equal(h.calls[0].ref, TOKEN)
  assert.deepEqual(h.calls[0].source, scope)
  assert.equal('turn' in call.exec, false)
  const rendered = h.reader.toolDefinition().output.render(call.args, value)
  assert.doesNotMatch(JSON.stringify({ value, rendered }), /a{32}|echo_qq_forward_read|chatId|senderId/)
  assert.deepEqual(JSON.parse(JSON.stringify(value)), value)
})

test('033读取：同聊天后续可继续，即使异常重名也不静默继承新token', async () => {
  const h = rig(), first = h.activate()
  assert.equal((await h.execute(first)).ok, true)
  h.end()
  const second = h.activate(sourceOf({}))
  assert.equal((await h.execute(second)).ok, true)
  h.end()
  assert.equal(h.bind('b'.repeat(32)).ok, true)
  const notClaimedNew = h.activate(sourceOf({}))
  assert.equal((await h.execute(notClaimedNew)).ok, false)
  h.end()
  const fresh = h.activate(sourceOf({ forwardRef: 'b'.repeat(32) }))
  h.setService({ readForward: async request => ({ ok: true, forwardContent: pageOf({ ref: request.ref }) }) })
  assert.equal((await h.execute(fresh)).ok, true)
})

for (const current of [
  sourceOf({ chatId: '33', chatType: 'group', senderId: '22', isMaster: false, forwardRef: undefined }),
  sourceOf({ senderId: '22', forwardRef: undefined }),
  sourceOf({ isMaster: false, forwardRef: undefined }),
  { kind: 'user' },
  { kind: 'plugin:other', form: 'relay', platform: 'qq', ...scope },
  sourceOf({ platform: 'qq-official', forwardRef: undefined })
]) {
  // 去掉undefined，匹配真实lossless host消息。
  const source = Object.fromEntries(Object.entries(current).filter(([, value]) => value !== undefined))
  test('033读取：跨聊天/非主人/其它来源拒绝 ' + JSON.stringify(source), async () => {
    const h = rig(), call = h.activate(source)
    assert.equal((await h.execute(call)).ok, false)
    assert.equal(h.calls.length, 0)
  })
}

test('033读取：已醒群当前群友仅可读同群，不能越到另一群', async () => {
  const group = { chatId: '33', chatType: 'group', senderId: '11', isMaster: true }
  const h = rig({ boundScope: group })
  const call = h.activate(sourceOf({ ...group, senderId: '22', isMaster: false, forwardRef: TOKEN }))
  assert.equal((await h.execute(call)).ok, true)
  h.end()
  const wrong = h.activate(sourceOf({ ...group, chatId: '44', senderId: '22', isMaster: false }))
  assert.equal((await h.execute(wrong)).ok, false)
})

test('033读取：同turn QQ→本地→QQ不能恢复权限', async () => {
  const h = rig(); h.start()
  const a = h.message(sourceOf({ forwardRef: TOKEN })), b = h.message({ kind: 'user' }), c = h.message(sourceOf({}))
  h.claim(a); h.claim(b); h.claim(c); h.enter(a); h.enter(b); h.enter(c)
  assert.equal((await h.execute(h.publish())).ok, false)
  assert.equal(h.calls.length, 0)
})

test('033读取：只claim但未真正进入，或prestep换id，都不能授权', async () => {
  const h = rig(); h.start(); const original = h.message(); h.claim(original)
  h.enter(h.message(original.source))
  assert.equal((await h.execute(h.publish())).ok, false)
  assert.equal(h.calls.length, 0)
})

test('033读取：不能靠同sid的另一个agent或替换session对象借权', async () => {
  const a = rig(), call = a.activate()
  const clone = { ...call.exec, agent: { ...a.agent, session: a.session } }
  assert.equal((await a.reader.toolDefinition().execute(call.args, clone)).ok, false)
  a.agent.session = { ...a.session }
  assert.equal((await a.execute(call)).ok, false)
  assert.equal(a.calls.length, 0)
})

test('033读取：未发布根、缺signal、嵌套PTC和参数篡改拒绝', async () => {
  for (const patch of [
    { callId: 'unpublished', rootCallId: 'unpublished' },
    { signal: undefined }, { parent: Symbol('parent') },
    { rootCallId: 'outer' }, { arguments: { ref: LABEL, page: 3 } }
  ]) {
    const h = rig(), call = h.activate()
    call.exec = { ...call.exec, ...patch }
    assert.equal((await h.execute(call)).ok, false)
    assert.equal(h.calls.length, 0)
  }
})

test('033读取：内部token不能直接作为模型参数，额外自报chat也不受理', async () => {
  for (const args of [{ ref: TOKEN, page: 2 }, { ref: LABEL, page: 2, chatId: '11' }, { ref: LABEL, page: '2' }]) {
    const h = rig(); h.activate(); const call = h.publish(undefined, args)
    assert.equal((await h.execute(call)).ok, false)
    assert.equal(h.calls.length, 0)
  }
})

test('033读取：本根只能执行一次，轮末和跨轮重用根都不可借权', async () => {
  const h = rig(), first = h.activate()
  assert.equal((await h.execute(first)).ok, true)
  assert.equal((await h.execute(first)).ok, false)
  h.end()
  assert.equal((await h.execute(first)).ok, false)
  h.activate(sourceOf({}))
  const replay = h.publish(first.exec.callId)
  assert.equal((await h.execute(replay)).ok, false)
  assert.equal(h.calls.length, 1)
})

test('033读取：请求前取消/总闸/会话闸拒绝，过期引用不能读取', async () => {
  for (const change of [
    (h, call) => call.controller.abort(),
    h => h.power(false), h => h.sessionPower(false),
    h => h.clock(601001)
  ]) {
    const h = rig(), call = h.activate(); change(h, call)
    assert.equal((await h.execute(call)).ok, false)
    assert.equal(h.calls.length, 0)
  }
})

test('033读取：await后取消或轮末不返回旧私聊内容', async () => {
  for (const change of [(h, call) => call.controller.abort(), h => h.end()]) {
    const gate = Promise.withResolvers()
    const h = rig({ read: () => gate.promise }), call = h.activate()
    const pending = h.execute(call)
    await Promise.resolve()
    change(h, call)
    gate.resolve({ ok: true, forwardContent: pageOf({ nodes: [{ text: '不应返回的旧内容' }] }) })
    const value = await pending
    assert.equal(value.ok, false)
    assert.doesNotMatch(JSON.stringify(value), /不应返回的旧内容/)
  }
})

test('033读取：await期间服务被替换或disposed，旧结果不返回', async () => {
  for (const change of [h => h.setService({ readForward: async () => ({ ok: false }) }), h => h.reader.dispose()]) {
    const gate = Promise.withResolvers()
    const h = rig({ read: () => gate.promise }), call = h.activate()
    const pending = h.execute(call); await Promise.resolve(); change(h)
    gate.resolve({ ok: true, forwardContent: pageOf() })
    assert.equal((await pending).ok, false)
  }
})

test('033读取：工具页图只报未提供，不返回引用JSON或假看见', async () => {
  const h = rig({ read: () => ({ ok: true, forwardContent: pageOf({
    images: [{ url: 'https://example.invalid/p.png' }],
    nodes: [{ text: '这张图', imageIndexes: [0], depth: 0 }]
  }) }) })
  const value = await h.execute(h.activate())
  assert.equal(value.ok, true)
  assert.equal(value.imageCount, 1)
  assert.match(value.text, /未向本次工具结果提供图片.*本次未读/)
  assert.doesNotMatch(JSON.stringify(value), /example\.invalid|https?:|a{32}|echo_qq_forward_read/)
})

test('033读取：缓存返回错误ref/page或抛错不泄漏任意文本', async () => {
  for (const read of [
    () => ({ ok: true, forwardContent: pageOf({ ref: 'b'.repeat(32) }) }),
    () => ({ ok: true, forwardContent: pageOf({ page: 1 }) }),
    () => { throw Error('https://example.invalid/secret?token=fiction') }
  ]) {
    const h = rig({ read }), value = await h.execute(h.activate())
    assert.equal(value.ok, false)
    assert.doesNotMatch(JSON.stringify(value), /example\.invalid|secret|fiction/)
  }
})
