/** 037-C1：仅合成事件与对象，无宿主执行、文件读取、网络或模型。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createQQSendOrigin } from '../lib/qq-send-origin.js'

const SEND = 'echo_qq_file_send'
const PRIVATE = Object.freeze({ chatType: 'private', chatId: '11', senderId: '11', isMaster: true })
const FILES = Object.freeze([{ path: 'echo-outgoing/合成.txt', description: '合成产物' }])
function freeze (value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value) }
  return value
}
const sourceOf = patch => ({ kind: 'plugin:dsh-echo', form: 'relay', platform: 'qq', ...PRIVATE, ...patch })
function rig (options = {}) {
  const events = new Map(), presented = [], revoked = [], outcomes = []
  let serial = 0, turn = 0, step = 0, enabled = true, scoped = true, current = true
  const session = { id: 'synthetic-session', seq: 0, eventAt: seq => events.get(seq) }
  const agent = { session, status: 'idle', inbox: {}, ctx: {} }
  const origin = createQQSendOrigin({
    isEnabled: () => enabled, sessionEnabledOf: () => scoped,
    onPresented: value => presented.push(value), onRevoke: value => revoked.push(value), ...options
  })
  const message = (patch = {}, text = '请把工作区产物发来') => freeze({
    id: 'message-' + ++serial, role: 'user', source: sourceOf(patch), content: [{ type: 'text', text }]
  })
  const bind = (m, env = { platform: 'qq', ...PRIVATE }, guard = () => current) => origin.bind({ agent, message: m, env, isCurrent: guard })
  const emit = (type, data, extra = {}) => {
    const event = freeze({ type, data, seq: session.seq++, ...extra })
    events.set(event.seq, event)
    outcomes.push({ event, result: origin.observeSessionEvent(session, event) })
    return event
  }
  const start = () => { agent.status = 'running'; step = 0; emit('turn/start', { turn: ++turn }) }
  const claim = m => origin.observeClaim({ agent, message: m, turn })
  const startStep = () => emit('step/start', { turn, step: ++step })
  const endStep = () => emit('step/end', { turn, step })
  const enter = m => { if (!step) startStep(); emit('user/message', m, { surfaceOp: 'append' }) }
  const activate = patch => {
    const m = message(patch)
    assert.equal(bind(m).ok, true)
    start(); claim(m); enter(m)
    return m
  }
  function roots (definitions) {
    const calls = definitions.map(one => {
      const args = one.args ?? (one.name === 'present' ? { files: FILES } : { ref: '合成.txt' })
      const id = one.id ?? 'root-' + ++serial
      const controller = new AbortController()
      return { name: one.name, args, id, controller, exec: {
        agent, callId: id, rootCallId: id, name: one.name, arguments: args,
        token: Symbol(id), signal: controller.signal
      } }
    })
    emit('assistant/message', { turn, step, message: {
      role: 'assistant', content: calls.map(call => ({ type: 'tool-call',
        id: call.id, name: call.name, arguments: JSON.stringify(call.args) }))
    } }, { surfaceOp: 'append' })
    for (const call of calls) {
      call.callEvent = emit('tool/call', { turn, step, name: call.name, callId: call.id, arguments: JSON.stringify(call.args) })
    }
    return calls
  }
  const root = (name = SEND, args, id) => roots([{ name, args, id }])[0]
  const resultEvent = (call, patch = {}) => emit('tool/result', { message: {
    id: 'result-' + ++serial, role: 'tool', toolCallId: call.id,
    source: { kind: 'tool', callId: call.id }, isError: false, content: [], ...patch
  } }, { surfaceOp: 'append', sourceEventSeqs: [call.callEvent.seq] })
  function present (call = root('present'), order = 'event-first', patch = {}) {
    const files = patch.files ?? FILES
    const descriptor = { turn, callId: call.id, files, ...patch.descriptor }
    const result = freeze({ isError: false, value: { turn, files }, content: [] })
    Object.freeze(call.exec)
    if (order === 'event-first') emit('deliverables/presented', descriptor)
    origin.observeToolResult(call.exec, result)
    if (order !== 'event-first') emit('deliverables/presented', descriptor)
    resultEvent(call)
    return call
  }
  const prove = call => origin.proveSend(call.args, call.exec)
  const end = () => {
    if (step) endStep()
    emit('turn/end', { turn, reason: { kind: 'completed' } })
    agent.status = 'idle'; step = 0
  }
  return { origin, agent, session, events, presented, revoked, outcomes, message, bind, emit, start, claim,
    startStep, endStep, enter, activate, roots, root, resultEvent, present, prove, end,
    power: value => { enabled = value }, scope: value => { scoped = value }, current: value => { current = value } }
}

test('037来源：普通QQ文字维护绑定→claim→实际入场后才可证明原生发送根', () => {
  const h = rig(); h.activate()
  const call = h.root(), proof = h.prove(call)
  assert.equal(proof.ok, true)
  assert.deepEqual(proof.source, PRIVATE)
  assert.equal(proof.signal, call.controller.signal)
  assert.equal(proof.isCurrent(), true)
  const scope = h.origin.scopeOf(proof.grant)
  assert.equal(scope.agent, h.agent)
  assert.equal(scope.session, h.session)
  assert.equal(scope.turn, 1)
  assert.equal(scope.isCurrent(), true)
  assert.equal(h.origin.scopeOf({}), null)
  assert.equal(h.prove(call).ok, false, '根只能执行一次')
  assert.equal('turn' in call.exec, false)
  assert.equal('step' in call.exec, false)
})

for (const mode of ['only-bind', 'only-claim', 'unbound-owner', 'replacement-message']) {
  test('037来源：不完整真实入场拒绝 ' + mode, () => {
    const h = rig(), m = h.message()
    if (mode !== 'unbound-owner') h.bind(m)
    h.start()
    if (mode !== 'only-bind') h.claim(m)
    if (mode === 'replacement-message') h.enter(h.message())
    else if (mode !== 'only-claim') h.enter(m)
    else h.startStep()
    assert.equal(h.prove(h.root()).ok, false)
  })
}

for (const patch of [
  { isMaster: false }, { platform: 'qq-official' }, { chatId: '22', senderId: '22' },
  { chatType: 'group', chatId: '33', senderId: '22', isMaster: false },
  { kind: 'user' }, { kind: 'runtime-context' }, { form: 'care' }
]) test('037来源：绑定不接受自报/其它来源 ' + JSON.stringify(patch), () => {
  const h = rig(), m = h.message(patch)
  assert.equal(h.bind(m).ok, false)
})

test('037来源：主人醒群可绑定，但群友不能借同群或同sid', () => {
  const group = { chatType: 'group', chatId: '33', senderId: '11', isMaster: true }
  const h = rig(), m = h.message(group)
  assert.equal(h.bind(m, { platform: 'qq', ...group }).ok, true)
  h.start(); h.claim(m); h.enter(m)
  assert.equal(h.prove(h.root()).ok, true)
  h.end()
  const guest = h.message({ ...group, senderId: '22', isMaster: false })
  assert.equal(h.bind(guest, { platform: 'qq', ...group, senderId: '22', isMaster: false }).ok, false)
})

for (const patch of [
  { parent: Symbol('parent') }, { rootCallId: 'outer' }, { token: 'fake' }, { signal: undefined },
  { callId: 'missing' }, { arguments: { ref: 'other.txt' } }, { name: 'echo_qq_say' }
]) test('037来源：原生根上下文不完整拒绝 ' + Object.keys(patch).join(','), () => {
  const h = rig(); h.activate(); const call = h.root()
  assert.equal(h.origin.proveSend(call.args, { ...call.exec, ...patch }).ok, false)
})

test('037来源：同sid的另一Agent/Session不能借用证明', () => {
  const h = rig(); h.activate(); const call = h.root()
  assert.equal(h.origin.proveSend(call.args, { ...call.exec, agent: { ...h.agent } }).ok, false)
  h.agent.session = { ...h.session }
  assert.equal(h.prove(call).ok, false)
})

for (const order of ['event-first', 'runtime-first']) {
  test('037来源：真实present三证任意观察器顺序仅登记一次 ' + order, () => {
    const h = rig(); h.activate(); const call = h.present(undefined, order)
    assert.equal(h.presented.length, 1)
    assert.equal(h.presented[0].callId, call.id)
    assert.deepEqual(h.presented[0].files, FILES.map(file => ({ path: file.path })))
    const grant = h.presented[0].grant
    assert.equal(h.origin.scopeOf(grant).isCurrent(), true)
    h.emit('deliverables/presented', { turn: 1, callId: call.id, files: FILES })
    assert.equal(h.presented.length, 1)
  })
}

test('037来源：present结算/step结束后authority不失效，下步发送同一authority', () => {
  const h = rig(); h.activate(); h.present()
  const first = h.origin.scopeOf(h.presented[0].grant)
  h.endStep(); h.startStep()
  assert.equal(first.isCurrent(), true)
  const proof = h.prove(h.root())
  assert.equal(proof.ok, true)
  assert.equal(h.origin.scopeOf(proof.grant).authority, first.authority)
  assert.equal(first.isCurrent(), true)
})

test('037来源：present、发送与重查复用同一canonical grant，轮末撤销同一个对象', () => {
  const h = rig(); h.activate(); h.present()
  const grant = h.presented[0].grant, scope = h.origin.scopeOf(grant)
  h.endStep(); h.startStep()
  const first = h.root(), firstProof = h.prove(first)
  assert.equal(firstProof.ok, true)
  assert.equal(firstProof.grant, grant)
  h.resultEvent(first); h.endStep(); h.startStep()
  h.present()
  assert.equal(h.presented[1].grant, grant)
  h.endStep(); h.startStep()
  const query = h.root(), queryProof = h.prove(query)
  assert.equal(queryProof.ok, true)
  assert.equal(queryProof.grant, grant)
  assert.equal(h.origin.scopeOf(queryProof.grant).authority, scope.authority)
  assert.equal(firstProof.isCurrent(), false)
  assert.equal(queryProof.isCurrent(), true)
  h.resultEvent(query); h.end()
  assert.equal(h.revoked.length, 1)
  assert.equal(h.revoked[0].grant, grant)
  assert.equal(scope.isCurrent(), false)
  assert.equal(h.origin.scopeOf(grant), null)
})

test('037来源：未present直接发送和重复查询所用grant也能在轮末准确撤销', () => {
  const h = rig(); h.activate()
  const first = h.root(), firstProof = h.prove(first)
  assert.equal(firstProof.ok, true)
  assert.equal(h.presented.length, 0)
  const scope = h.origin.scopeOf(firstProof.grant)
  h.resultEvent(first); h.endStep(); h.startStep()
  const query = h.root(), queryProof = h.prove(query)
  assert.equal(queryProof.ok, true)
  assert.equal(queryProof.grant, firstProof.grant, 'B.list建立的空scope与轮末revoke必须使用同一grant')
  assert.equal(h.origin.scopeOf(queryProof.grant).authority, scope.authority)
  h.resultEvent(query); h.end()
  assert.equal(h.revoked.length, 1)
  assert.equal(h.revoked[0].grant, firstProof.grant)
  assert.equal(h.origin.scopeOf(firstProof.grant), null)
  h.activate()
  const next = h.prove(h.root())
  assert.equal(next.ok, true)
  assert.notEqual(next.grant, firstProof.grant, 'canonical只在同一轮authority内共享')
  assert.equal(h.origin.scopeOf(firstProof.grant), null)
  assert.equal(scope.isCurrent(), false)
})

test('037来源：canonical grant共享不扩大每个原生根的取消与runtime结算guard', () => {
  const h = rig(); h.activate()
  const [first, second] = h.roots([{ name: SEND }, { name: SEND }])
  const firstProof = h.prove(first), secondProof = h.prove(second)
  assert.equal(firstProof.ok, true)
  assert.equal(secondProof.ok, true)
  assert.equal(firstProof.grant, secondProof.grant)
  assert.equal(firstProof.signal, first.controller.signal)
  assert.equal(secondProof.signal, second.controller.signal)
  const scope = h.origin.scopeOf(firstProof.grant)
  first.controller.abort()
  assert.equal(firstProof.isCurrent(), false)
  assert.equal(secondProof.isCurrent(), true)
  assert.equal(scope.isCurrent(), true)
  Object.freeze(second.exec)
  assert.equal(h.origin.observeToolResult(second.exec, freeze({ isError: false, value: {}, content: [] })).ok, true)
  assert.equal(secondProof.isCurrent(), false)
  assert.equal(scope.isCurrent(), true, '工具根结束不撤销轮内B授权')
  h.resultEvent(second); h.end()
  assert.equal(h.revoked[0].grant, firstProof.grant)
  assert.equal(scope.isCurrent(), false)
})

for (const missing of ['runtime', 'deliverable', 'session-result']) test('037来源：少一份present证据不能登记 ' + missing, () => {
  const h = rig(); h.activate(); const call = h.root('present')
  Object.freeze(call.exec)
  if (missing !== 'runtime') h.origin.observeToolResult(call.exec, freeze({ isError: false, value: { turn: 1, files: FILES }, content: [] }))
  if (missing !== 'deliverable') h.emit('deliverables/presented', { turn: 1, callId: call.id, files: FILES })
  if (missing !== 'session-result') h.resultEvent(call)
  assert.equal(h.presented.length, 0)
})

for (const bad of ['wrong-call', 'wrong-turn', 'wrong-files', 'error-result', 'nested-present', 'mutable-exec']) {
  test('037来源：不匹配或非原生成功present拒绝 ' + bad, () => {
    const h = rig(); h.activate(); const call = h.root('present')
    if (bad === 'nested-present') call.exec.parent = Symbol('parent')
    if (bad !== 'mutable-exec') Object.freeze(call.exec)
    h.emit('deliverables/presented', { turn: bad === 'wrong-turn' ? 2 : 1,
      callId: bad === 'wrong-call' ? 'other' : call.id,
      files: bad === 'wrong-files' ? [{ path: 'echo-outgoing/other.txt' }] : FILES })
    h.origin.observeToolResult(call.exec, freeze({ isError: bad === 'error-result', value: { turn: 1, files: FILES }, content: [] }))
    h.resultEvent(call, bad === 'error-result' ? { isError: true } : {})
    assert.equal(h.presented.length, 0)
  })
}

test('037来源：只有旧message.callId字段或不匹配sourceEventSeqs不登记', () => {
  for (const oldField of [true, false]) {
    const h = rig(); h.activate(); const call = h.root('present')
    Object.freeze(call.exec)
    h.emit('deliverables/presented', { turn: 1, callId: call.id, files: FILES })
    h.origin.observeToolResult(call.exec, freeze({ isError: false, value: { turn: 1, files: FILES }, content: [] }))
    h.emit('tool/result', { message: { id: 'bad', role: 'tool', ...(oldField ? { callId: call.id } : { toolCallId: call.id }),
      source: { kind: 'tool', callId: call.id }, isError: false, content: [] } },
    { surfaceOp: 'append', sourceEventSeqs: [999] })
    assert.equal(h.presented.length, 0)
  }
})

test('037来源：scope跨step，单根guard随根结算失效而不撤authority', () => {
  const h = rig(); h.activate(); const call = h.root(), proof = h.prove(call)
  const scoped = h.origin.scopeOf(proof.grant)
  h.resultEvent(call)
  assert.equal(proof.isCurrent(), false)
  assert.equal(scoped.isCurrent(), true)
  h.endStep(); h.startStep()
  assert.equal(scoped.isCurrent(), true)
  assert.equal(h.prove(h.root()).ok, true)
})

test('037来源：未claim运行上下文不授予权限，工具后附加上下文不更换真实owner', () => {
  const context = freeze({ id: 'runtime-context-only', role: 'user',
    source: { kind: 'runtime-context' }, content: [{ type: 'text', text: '合成运行信息' }] })
  const empty = rig(), pending = empty.message()
  empty.bind(pending); empty.start(); empty.startStep()
  empty.emit('user/message', context, { surfaceOp: 'append' })
  assert.equal(empty.prove(empty.root()).ok, false)
  const h = rig(); h.activate(); h.present()
  const scope = h.origin.scopeOf(h.presented[0].grant)
  h.emit('user/message', context, { surfaceOp: 'append' })
  assert.equal(scope.isCurrent(), true)
  assert.equal(h.presented.length, 1)
  h.endStep(); h.startStep()
  assert.equal(h.prove(h.root()).ok, true)
})

test('037来源：换真实输入源、本地插入后回QQ都不能恢复同轮旧authority', () => {
  const h = rig(); h.activate(); const call = h.root(), proof = h.prove(call)
  const scope = h.origin.scopeOf(proof.grant)
  h.resultEvent(call); h.endStep()
  const local = h.message({ kind: 'user' })
  h.claim(local)
  h.startStep(); h.enter(local)
  assert.equal(scope.isCurrent(), false)
  assert.equal(h.origin.scopeOf(proof.grant), null)
  assert.equal(h.prove(h.root()).ok, false)
  assert.equal(h.revoked.length, 1)
})

for (const action of ['power', 'scope', 'guard', 'turn-end', 'dispose']) test('037来源：撤权/结束使所有grant失效一次 ' + action, () => {
  const h = rig(); h.activate(); h.present(); h.endStep(); h.startStep()
  const call = h.root(), proof = h.prove(call), scope = h.origin.scopeOf(proof.grant)
  if (action === 'power') h.power(false)
  if (action === 'scope') h.scope(false)
  if (action === 'guard') h.current(false)
  if (action === 'turn-end') h.end()
  if (action === 'dispose') h.origin.dispose()
  assert.equal(scope.isCurrent(), false)
  assert.equal(h.origin.scopeOf(proof.grant), null)
  h.power(true); h.scope(true); h.current(true)
  assert.equal(scope.isCurrent(), false, '不能在旧轮撤权后复活')
  assert.equal(h.revoked.length, 1)
})

test('037来源：伪造事件身份、跳seq、重复根都拒绝', () => {
  const h = rig(); h.activate()
  const event = freeze({ type: 'step/end', data: { turn: 1, step: 1 }, seq: h.session.seq })
  assert.equal(h.origin.observeSessionEvent(h.session, event).ok, false)
  assert.equal(h.prove(h.root()).ok, false)
  const k = rig(); k.activate(); const call = k.root(); assert.equal(k.prove(call).ok, true)
  k.resultEvent(call); k.endStep(); k.startStep()
  assert.equal(k.prove(k.root(SEND, call.args, call.id)).ok, false)
})

test('037来源：非无损JSON的稀疏消息不能取得与空数组相同的绑定指纹', () => {
  const h = rig(), message = h.message()
  const sparse = freeze({ ...message, content: Array(1) })
  assert.equal(h.bind(sparse).ok, false)
})

test('037来源：异步/抛错guard以及回调异常安全，不透任何原文', async () => {
  for (const guard of [async () => { throw Error('synthetic-private'); }, () => { throw Error('synthetic-private') }]) {
    const h = rig(), m = h.message()
    assert.equal(h.bind(m, { platform: 'qq', ...PRIVATE }, guard).ok, false)
  }
  const h = rig({ onPresented: () => { throw Error('synthetic-private') }, onRevoke: () => Promise.reject(Error('synthetic-private')) })
  h.activate(); h.present(); h.end()
  await Promise.resolve()
  assert.doesNotMatch(JSON.stringify(h.revoked), /synthetic-private/)
})

test('037来源生命周期：超过1024个合法普通owner轮后仍可present并发送', () => {
  const h = rig()
  let firstMessage
  for (let index = 0; index < 1100; index++) {
    const message = h.activate()
    if (!firstMessage) firstMessage = message
    assert.equal(h.outcomes.at(-1).result.ok, true, '普通owner入场不能因历史累计永久耗尽')
    h.end()
  }
  assert.equal(h.bind(firstMessage).ok, false, '仍持有的旧实际消息对象不能重新绑定')
  h.activate(); h.present()
  assert.equal(h.presented.length, 1)
  h.endStep(); h.startStep()
  assert.equal(h.prove(h.root()).ok, true)
})

test('037来源生命周期：旧轮根记录有界轮转，旧exec/token/grant仍不可重放', () => {
  const h = rig(); h.activate()
  let oldCall, oldProof
  for (let index = 0; index < 1024; index++) {
    const call = h.root(), proof = h.prove(call)
    assert.equal(proof.ok, true)
    if (!oldCall) { oldCall = call; oldProof = proof }
    h.resultEvent(call)
    if (index !== 1023) { h.endStep(); h.startStep() }
  }
  h.end()
  assert.equal(h.origin.scopeOf(oldProof.grant), null)
  h.activate(); h.present()
  assert.equal(h.presented.length, 1, '历史1024个已结束根不能永久挡住新轮')
  h.endStep(); h.startStep()
  const second = h.root()
  assert.equal(h.prove(second).ok, true)
  h.resultEvent(second); h.end()
  // 最近ID缓存已滚过旧根；新轮的真实上下文仍必须有新execution/token。
  h.activate()
  const fresh = h.root(SEND, oldCall.args, oldCall.id)
  assert.equal(h.origin.proveSend(fresh.args, oldCall.exec).ok, false)
  assert.equal(h.origin.proveSend(fresh.args, { ...oldCall.exec }).ok, false, '克隆旧exec也不能借旧token')
  assert.equal(h.prove(fresh).ok, true)
  assert.equal(h.origin.scopeOf(oldProof.grant), null)
})

test('037来源生命周期：未claim失效绑定可清理，满额只淘汰非当前claim', () => {
  const h = rig()
  for (let index = 0; index < 100; index++) {
    const permit = { live: true }
    assert.equal(h.bind(h.message(), { platform: 'qq', ...PRIVATE }, () => permit.live).ok, true)
    permit.live = false
  }
  h.activate(); h.present()
  assert.equal(h.presented.length, 1)

  const current = rig(), original = current.message()
  assert.equal(current.bind(original).ok, true)
  current.start(); assert.equal(current.claim(original).ok, true)
  current.agent.status = 'idle' // 真maintenance绑定其它等待消息的阶段。
  for (let index = 0; index < 70; index++) assert.equal(current.bind(current.message()).ok, true)
  current.agent.status = 'running'; current.enter(original)
  assert.equal(current.outcomes.at(-1).result.ok, true, '当前已claim输入不得被新待入场绑定淘汰')
  assert.equal(current.prove(current.root()).ok, true)
})

test('037来源：ref长度与B合同2048对齐，2049仍拒绝', () => {
  const h = rig(); h.activate()
  const ref = 'a/'.repeat(1022) + 'f.md'
  assert.equal(ref.length, 2048)
  const [valid, tooLong] = h.roots([{ name: SEND, args: { ref } }, { name: SEND, args: { ref: ref + 'x' } }])
  assert.equal(h.prove(valid).ok, true)
  assert.equal(h.prove(tooLong).ok, false)
})
