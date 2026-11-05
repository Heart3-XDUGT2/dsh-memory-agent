/** 037-C1控制测试：真实事件形状、mock产物/上传；无文件或网络访问。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import { createQQFileSender } from '../lib/qq-send-file.js'

const REF = 'report.txt'
const OWNER = { platform: 'qq', chatType: 'private', chatId: '11', senderId: '11', isMaster: true }
const future = () => {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}
const freeze = object => {
  if (object && typeof object === 'object') { Object.values(object).forEach(freeze); Object.freeze(object) }
  return object
}
async function until (condition) {
  const stop = Date.now() + 1500
  while (!condition() && Date.now() < stop) await delay(1)
  assert.equal(condition(), true, '合成控制流程应到达预期边界')
}
async function settled (promise, ms = 15) {
  let timer
  try { return await Promise.race([promise.then(() => true), new Promise(done => { timer = setTimeout(() => done(false), ms) })]) }
  finally { clearTimeout(timer) }
}

function rig (t, options = {}) {
  const events = new Map(), uploads = [], uploadContexts = [], registrations = [], snapshots = [], prepared = [], revokes = []
  const states = new WeakMap(), known = new WeakMap()
  const session = { id: 'synthetic-send-session', seq: 0, header: { cwd: '/synthetic-workspace' },
    eventAt: seq => events.get(seq) }
  const agent = { session, status: 'idle', inbox: {}, ctx: {} }
  let enabled = true, current = true, serial = 0, turn = 0, step = 0, scopeOf, artifactsClosed = false
  const service = {
    beginFileUpload: (args, execution) => {
      uploads.push(args)
      uploadContexts.push(execution)
      return options.begin ? options.begin(args) : {
        result: Promise.resolve({ ok: true, state: 'confirmed', code: 'CONFIRMED', bytes: args.data.byteLength }),
        physicalDone: Promise.resolve()
      }
    }
  }
  let channel = service
  function stateOf (grant) {
    const scope = scopeOf(grant)
    assert.ok(scope && scope.isCurrent(), 'B接口必须收到实际当前grant')
    known.set(grant, scope)
    let state = states.get(scope.authority)
    if (!state) { state = { items: new Map(), content: new Map(), scope }; states.set(scope.authority, state) }
    return state
  }
  const artifacts = {
    async prepare (grant) { prepared.push(grant); stateOf(grant); return { ok: true, relativeRoot: 'echo-outgoing' } },
    async registerPresented (grant, info) {
      registrations.push({ grant, info })
      if (options.register) await options.register(grant, info)
      const state = stateOf(grant), items = []
      if (options.registerResult) return options.registerResult
      for (const file of info.files) {
        const ref = file.path.replace(/^echo-outgoing[\\/]/, '')
        const text = options.contentOf ? options.contentOf(file.path) : options.content ?? '合成正文'
        let entry = state.content.get(text)
        if (!entry) {
          const data = new TextEncoder().encode(text)
          entry = { ref, name: ref.split('/').at(-1), bytes: data.byteLength, data, identity: {}, taken: false }
          state.content.set(text, entry); state.items.set(ref, entry)
        }
        items.push({ ref: entry.ref, name: entry.name, bytes: entry.bytes })
      }
      return { ok: true, items, rejected: [] }
    },
    async list (grant) {
      const state = stateOf(grant)
      const result = { ok: true, items: [...state.items.values()].map(({ ref, name, bytes }) => ({ ref, name, bytes })) }
      return options.list ? options.list(grant, result) : result
    },
    async snapshot (grant, ref, operation) {
      snapshots.push({ grant, ref, operation })
      if (options.snapshot) return options.snapshot(grant, ref, operation, () => stateOf(grant))
      const entry = stateOf(grant).items.get(ref)
      if (!entry) return { ok: false, code: 'NOT_FOUND', reason: 'missing' }
      if (entry.taken) return { ok: false, code: 'ALREADY_TAKEN', identity: entry.identity }
      entry.taken = true
      return { ok: true, ref: entry.ref, name: entry.name, bytes: entry.bytes,
        data: new Uint8Array(entry.data), identity: entry.identity }
    },
    async revoke (grant) { revokes.push(grant) },
    async close () { artifactsClosed = true }
  }
  const sender = createQQFileSender({
    createArtifacts: deps => { scopeOf = deps.scopeOf; return artifacts },
    serviceOf: () => typeof channel === 'function' ? channel() : channel,
    isEnabled: () => enabled, sessionEnabledOf: () => true,
    captureAudit: options.captureAudit, audit: options.audit,
    timeoutMs: options.timeoutMs ?? 1000
  })
  t.after(() => sender.dispose())
  const source = patch => ({ kind: 'plugin:dsh-echo', form: 'relay', ...OWNER, ...patch, rawText: '请发本轮报告' })
  const message = origin => freeze({ id: 'owner-' + ++serial, role: 'user',
    source: source(origin), content: [{ type: 'text', text: '请发本轮报告' }] })
  const emit = (type, data, meta = {}) => {
    const event = freeze({ type, data, seq: session.seq++, ...meta })
    events.set(event.seq, event)
    sender.observeSessionEvent(session, event)
    return event
  }
  const user = message(options.source)
  assert.equal(sender.bind({ agent, message: user, env: { ...OWNER, ...options.source }, isCurrent: () => current }).ok, true)
  const start = () => {
    agent.status = 'running'; turn++; step = 1
    emit('turn/start', { turn })
    sender.observeClaim({ agent, message: user, turn })
    emit('step/start', { turn, step })
    emit('user/message', user, { surfaceOp: 'append' })
  }
  const nextStep = () => {
    emit('step/end', { turn, step }); step++
    emit('step/start', { turn, step })
  }
  const publish = (name, args) => {
    const id = name + '-' + ++serial
    const assistant = emit('assistant/message', { turn, step, message: { role: 'assistant',
      content: [{ type: 'tool-call', id, name, arguments: JSON.stringify(args) }] } }, { surfaceOp: 'append' })
    const call = emit('tool/call', { turn, step, callId: id, name, arguments: JSON.stringify(args) },
      { sourceEventSeqs: [assistant.seq] })
    const controller = new AbortController()
    return { args, controller, call,
      exec: { agent, name, callId: id, rootCallId: id, arguments: args, token: Symbol(id), signal: controller.signal } }
  }
  const toolResult = (call, isError = false) => {
    emit('tool/result', { turn, step, message: { id: 'result-' + ++serial, role: 'tool',
      toolCallId: call.exec.callId, source: { kind: 'tool', callId: call.exec.callId }, isError,
      content: [{ type: 'text', text: '合成结果' }] } }, { surfaceOp: 'append', sourceEventSeqs: [call.call.seq] })
  }
  const present = (files = [{ path: 'echo-outgoing/' + REF }]) => {
    const call = publish('present', { files })
    emit('deliverables/presented', { turn, callId: call.exec.callId, files })
    Object.freeze(call.exec)
    sender.observeToolResult(call.exec, { isError: false, value: { turn, files },
      content: [{ type: 'text', text: 'Presented synthetic file' }] })
    toolResult(call)
    nextStep()
    return call
  }
  start(); present(options.files)
  const send = args => publish('echo_qq_file_send', args ?? { ref: REF })
  const execute = call => sender.toolDefinition().execute(call.args, call.exec)
  const end = () => { emit('step/end', { turn, step }); emit('turn/end', { turn, reason: { kind: 'completed' } }); agent.status = 'idle' }
  return { sender, agent, session, uploads, uploadContexts, registrations, snapshots, prepared, revokes, artifacts,
    send, execute, nextStep, present, toolResult, end, source, emit,
    scopeOf: grant => scopeOf(grant), isClosed: () => artifactsClosed,
    current: value => { current = value }, power: value => { enabled = value }, swap: value => { channel = value },
    service }
}

test('037-C1：真实普通QQ绑定与成功present后跨step发送，仅当前目标及安全结果', async t => {
  const h = rig(t), call = h.send(), value = await h.execute(call)
  assert.equal(value.state, 'confirmed')
  assert.equal(h.uploads.length, 1)
  assert.equal(h.uploads[0].chatType, 'private')
  assert.equal(h.uploads[0].chatId, '11')
  assert.equal(new TextDecoder().decode(h.uploads[0].data), '合成正文')
  assert.equal(h.scopeOf(h.registrations[0].grant).isCurrent(), true, 'present根settled与step结束不能撤掉authority')
  assert.equal(h.scopeOf(h.snapshots[0].grant).authority, h.scopeOf(h.registrations[0].grant).authority)
  assert.equal(value.ref, REF)
  assert.doesNotMatch(JSON.stringify(value), /chatId|senderId|identity|base64|synthetic-workspace|data|file_id/)
  assert.match(h.sender.toolDefinition().description, /echo-outgoing/)
})

test('037-C1：主人群目标来自真实来源，不能加to自选目标', async t => {
  const h = rig(t, { source: { chatType: 'group', chatId: '33' } })
  const value = await h.execute(h.send())
  assert.equal(value.state, 'confirmed')
  assert.equal(h.uploads[0].chatType, 'group')
  assert.equal(h.uploads[0].chatId, '33')
  h.nextStep()
  const denied = await h.execute(h.send({ ref: REF, to: '44' }))
  assert.equal(denied.state, 'not_submitted')
  assert.equal(h.uploads.length, 1)
})

test('037-C2：服务独立取得已证明来源，不把权限源混入A传输参数', async t => {
  const h = rig(t)
  assert.equal((await h.execute(h.send())).state, 'confirmed')
  assert.deepEqual(h.uploadContexts[0], { source: {
    chatType: 'private', chatId: '11', senderId: '11', isMaster: true
  } })
  assert.equal(Object.hasOwn(h.uploads[0], 'source'), false)
})

test('037-C2：异步终态固定受理时审计上下文，重复查询没有第二条审计', async t => {
  const result = future(), physical = future(), rows = []
  const captured = { sessionId: 'synthetic-send-session', turn: 1,
    turnTrace: 'original-trace', traceId: 'original-row' }
  const h = rig(t, {
    captureAudit: () => captured, audit: row => rows.push(row),
    begin: () => ({ result: result.promise, physicalDone: physical.promise })
  })
  const call = h.send(), pending = h.execute(call)
  await until(() => h.uploads.length === 1)
  captured.turnTrace = 'later-trace'; captured.turn = 2
  result.resolve({ ok: true, state: 'confirmed', code: 'CONFIRMED',
    file_id: 'private-remote-id', raw: 'private-base64-payload' })
  assert.equal((await pending).state, 'confirmed')
  physical.resolve()
  assert.equal(rows.length, 1)
  assert.equal(rows[0].context.turnTrace, 'original-trace')
  assert.equal(rows[0].context.turn, 1)
  assert.equal(Object.isFrozen(rows[0].context), true)
  assert.doesNotMatch(JSON.stringify(rows), /private-remote|private-base64|identity|rawText|synthetic-workspace/)
  h.toolResult(call); h.nextStep()
  assert.equal((await h.execute(h.send())).state, 'confirmed')
  assert.equal(rows.length, 1)
})

test('037-C2：改名查询等待新登记，原unknown物理占额时不占新发送槽', async t => {
  const physical = future(), registration = future()
  t.after(() => { physical.resolve(); registration.resolve() })
  let registrations = 0
  const h = rig(t, {
    register: () => ++registrations === 2 ? registration.promise : undefined,
    begin: () => ({ result: Promise.resolve({ ok: false, state: 'unknown', code: 'ABORTED' }),
      physicalDone: physical.promise })
  })
  const first = h.send()
  assert.equal((await h.execute(first)).state, 'unknown')
  h.toolResult(first); h.nextStep()
  h.present([{ path: 'echo-outgoing/renamed.txt' }])
  const pending = h.execute(h.send({ ref: 'renamed.txt' }))
  await until(() => h.registrations.length === 2)
  assert.equal(await settled(pending), false, '状态查询必须等待已验证present登记')
  registration.resolve()
  const value = await pending
  assert.equal(value.state, 'unknown')
  assert.equal(value.code, 'ALREADY_RECORDED')
  assert.equal(h.uploads.length, 1)
  assert.equal(h.snapshots.length, 1)
  physical.resolve()
})

test('037-C2：unknown物理持额时唯一叶名查询可用，未发送的重名条目仍产生歧义', async t => {
  for (const ambiguous of [false, true]) {
    const physical = future()
    t.after(() => physical.resolve())
    const h = rig(t, {
      files: [{ path: 'echo-outgoing/nested/report.txt' },
        ...(ambiguous ? [{ path: 'echo-outgoing/other/report.txt' }] : [])],
      contentOf: path => path,
      begin: () => ({ result: Promise.resolve({ ok: false, state: 'unknown', code: 'ABORTED' }),
        physicalDone: physical.promise })
    })
    const first = h.send({ ref: 'nested/report.txt' })
    assert.equal((await h.execute(first)).state, 'unknown')
    h.toolResult(first); h.nextStep()
    const value = await h.execute(h.send({ ref: 'report.txt' }))
    assert.equal(value.state, ambiguous ? 'not_submitted' : 'unknown')
    assert.equal(value.code, ambiguous ? 'AMBIGUOUS_REF' : 'ALREADY_RECORDED')
    assert.equal(h.uploads.length, 1)
    assert.equal(h.snapshots.length, 1)
    physical.resolve()
    await h.sender.dispose()
  }
})

test('037-C1：同authority重复root/新root及重新present不重发', async t => {
  const h = rig(t), first = h.send()
  assert.equal((await h.execute(first)).state, 'confirmed')
  assert.equal((await h.execute(first)).state, 'not_submitted')
  h.toolResult(first); h.nextStep()
  const again = h.send()
  assert.equal((await h.execute(again)).state, 'confirmed')
  assert.equal(h.uploads.length, 1)
  h.toolResult(again); h.nextStep()
  h.present([{ path: 'echo-outgoing/renamed.txt' }])
  const afterRename = h.send({ ref: 'renamed.txt' })
  assert.equal((await h.execute(afterRename)).state, 'confirmed')
  assert.equal(h.uploads.length, 1)
})

test('037-C1：ALREADY_TAKEN无本端记录不冒称已发送', async t => {
  const h = rig(t, { snapshot: async () => ({ ok: false, code: 'ALREADY_TAKEN', identity: {} }) })
  const value = await h.execute(h.send())
  assert.equal(value.state, 'not_submitted')
  assert.equal(h.uploads.length, 0)
})

test('037-C1：等待真实present登记后再snapshot，失败文案不透传', async t => {
  const gate = future()
  const h = rig(t, { register: () => gate.promise })
  const pending = h.execute(h.send())
  await until(() => h.registrations.length > 0)
  assert.equal(h.snapshots.length, 0)
  gate.resolve()
  assert.equal((await pending).state, 'confirmed')
})

test('037-C1：调用参数拒绝路径/额外字段/未知ref，不读快照', async t => {
  for (const args of [{ ref: '../secret' }, { ref: 'C:\\synthetic\\secret' },
    { ref: REF, deadlineAt: 9999999999 }, { ref: 'missing.txt' }, { ref: 'https://synthetic.invalid/x' }]) {
    const h = rig(t)
    const value = await h.execute(h.send(args))
    assert.equal(value.state, 'not_submitted')
    assert.equal(h.snapshots.length, 0)
    assert.equal(h.uploads.length, 0)
  }
})

test('037-C1：已知产物元数据/字节不一致，不把内部data或错误给模型', async t => {
  for (const snapshot of [
    async () => ({ ok: false, code: 'PRIVATE_CREDENTIAL', reason: 'C:\\synthetic\\secret TOKEN_037' }),
    async () => { throw Error('TOKEN_037 C:\\synthetic\\secret') },
    async () => ({ ok: true, ref: REF, name: 'report.txt', bytes: 3, data: new Uint8Array(4), identity: {} })
  ]) {
    const h = rig(t, { snapshot }), value = await h.execute(h.send())
    assert.equal(value.state, 'not_submitted')
    assert.equal(h.uploads.length, 0)
    assert.doesNotMatch(JSON.stringify(value), /TOKEN_037|C:|PRIVATE_CREDENTIAL|identity|data/)
  }
})

test('037-C1：写前取消/换服务/总闸变化不提交，未结束快照仍占名额', async t => {
  for (const change of [(h, call) => call.controller.abort(), h => h.swap({ ...h.service }), h => h.power(false)]) {
    const gate = future()
    const h = rig(t, { snapshot: () => gate.promise }), call = h.send(), pending = h.execute(call)
    await until(() => h.snapshots.length > 0)
    change(h, call)
    const value = await pending
    assert.equal(value.state, 'not_submitted')
    assert.equal(h.uploads.length, 0)
    gate.resolve({ ok: false, code: 'ABORTED' })
  }
})

test('037-C1：未知提交逻辑先返回，直到physicalDone仍占真实session额度', async t => {
  const physical = future()
  const h = rig(t, { begin: () => ({
    result: Promise.resolve({ ok: false, state: 'unknown', code: 'TIMEOUT' }),
    physicalDone: physical.promise
  }) })
  const first = h.send()
  assert.equal((await h.execute(first)).state, 'unknown')
  h.toolResult(first); h.nextStep()
  const queried = await h.execute(h.send())
  assert.equal(queried.state, 'unknown')
  assert.equal(h.uploads.length, 1)
  assert.equal(h.snapshots.length, 1, '已有意图只查记录，不再次交出')
  physical.resolve()
})

test('037-C1：跨控制器全局2在snapshot前占额，不随取消提前释放', async t => {
  const gates = [future(), future()], holders = []
  for (let i = 0; i < 2; i++) {
    const h = rig(t, { snapshot: () => gates[i].promise }), call = h.send()
    const pending = h.execute(call)
    holders.push({ h, call, pending })
    await until(() => h.snapshots.length > 0)
    call.controller.abort()
    assert.equal((await pending).state, 'not_submitted')
  }
  const third = rig(t)
  const denied = await third.execute(third.send())
  assert.equal(denied.state, 'not_submitted')
  assert.equal(denied.code, 'BUSY')
  assert.equal(third.snapshots.length, 0)
  for (const gate of gates) gate.resolve({ ok: false, code: 'ABORTED' })
})

test('037-C1：写后取消/换轮或service抛错保持unknown，不伪称未发', async t => {
  for (const mode of ['cancel', 'turn-end', 'throw']) {
    const logical = future(), physical = future()
    const h = rig(t, { begin: () => {
      if (mode === 'throw') throw Error('PRIVATE_REMOTE_037')
      return { result: logical.promise, physicalDone: physical.promise }
    } })
    const call = h.send(), pending = h.execute(call)
    await until(() => h.uploads.length === 1)
    if (mode === 'cancel') call.controller.abort()
    if (mode === 'turn-end') h.end()
    const value = await pending
    assert.equal(value.state, 'unknown')
    assert.doesNotMatch(JSON.stringify(value), /PRIVATE_REMOTE_037/)
    logical.resolve({ ok: true, state: 'confirmed', code: 'CONFIRMED' })
    physical.resolve()
  }
})

test('037-C1：不合作snapshot过总截止时只返回未提交，实际结束后才释放', async t => {
  const gate = future()
  const h = rig(t, { timeoutMs: 60, snapshot: () => gate.promise })
  const call = h.send(), pending = h.execute(call)
  await until(() => h.snapshots.length > 0)
  assert.equal((await pending).state, 'not_submitted')
  assert.equal(h.uploads.length, 0)
  gate.resolve({ ok: false, code: 'ABORTED' })
})

test('037-C1：服务trace代理可变但底层身份稳定时可发，仍调用作用域代理', async t => {
  const h = rig(t)
  let proxiedCalls = 0
  const original = h.service
  h.swap(() => new Proxy({}, { get: (_target, key) => key === Symbol.for('cordis.original') ? original
    : key === 'beginFileUpload' ? args => { proxiedCalls++; return original.beginFileUpload(args) } : undefined }))
  assert.equal((await h.execute(h.send())).state, 'confirmed')
  assert.equal(proxiedCalls, 1)
})

test('037-C1：关闭期间返回安全状态并等待真实physicalDone，不重置额度', async t => {
  const physical = future()
  const h = rig(t, { begin: () => ({ result: Promise.resolve({ ok: false, state: 'unknown', code: 'TIMEOUT' }),
    physicalDone: physical.promise }) })
  assert.equal((await h.execute(h.send())).state, 'unknown')
  const closing = h.sender.dispose()
  assert.equal(await settled(closing), false)
  physical.resolve()
  await closing
  assert.equal(h.isClosed(), true)
})

test('037-C1：begin同步跨过总截止后不能抢在timer之前返回confirmed', async t => {
  const h = rig(t, { timeoutMs: 20, begin: () => {
    const until = performance.now() + 65
    while (performance.now() < until) {}
    return { result: Promise.resolve({ ok: true, state: 'confirmed', code: 'CONFIRMED' }),
      physicalDone: Promise.resolve() }
  } })
  const value = await h.execute(h.send())
  assert.equal(h.uploads.length, 1)
  assert.equal(value.state, 'unknown')
  assert.equal(value.code, 'TIMEOUT')
})

test('037-C1：最后service读取同步取消后不得再调用begin', async t => {
  const h = rig(t), call = h.send()
  let canceled = false
  h.swap(() => {
    if (h.snapshots.length > 0 && !canceled) { canceled = true; call.controller.abort() }
    return h.service
  })
  const value = await h.execute(call)
  assert.equal(value.state, 'not_submitted')
  assert.equal(h.uploads.length, 0)
})

test('037-C1：已有ref的状态查询也等待本次成功present登记，不靠模型延迟', async t => {
  const gate = future()
  let registrations = 0
  const h = rig(t, { register: () => ++registrations === 2 ? gate.promise : undefined })
  const first = h.send()
  assert.equal((await h.execute(first)).state, 'confirmed')
  h.toolResult(first); h.nextStep()
  h.present([{ path: 'echo-outgoing/renamed.txt' }])
  const pending = h.execute(h.send())
  try {
    await until(() => h.registrations.length === 2)
    assert.equal(await settled(pending), false)
  } finally { gate.resolve() }
  assert.equal((await pending).state, 'confirmed')
  assert.equal(h.uploads.length, 1)
})

test('037-C1：首个send前换真实服务就撤销旧authority，不能给新服务发旧grant', async t => {
  const h = rig(t)
  await until(() => h.registrations.length === 1)
  const grant = h.registrations[0].grant
  assert.equal(h.scopeOf(grant).isCurrent(), true)
  h.swap({ ...h.service })
  assert.equal(h.scopeOf(grant), null)
  assert.equal((await h.execute(h.send())).state, 'not_submitted')
  assert.equal(h.uploads.length, 0)
})

test('037-C1：B固定失败映射8MiB/空文件/输出根原因，不透原始reason', async t => {
  for (const [artifactCode, code, text] of [
    ['TOO_LARGE', 'FILE_TOO_LARGE', /8MiB/],
    ['EMPTY_FILE', 'EMPTY_FILE', /为空|非空/],
    ['OUTSIDE_OUTPUT', 'OUTSIDE_OUTPUT', /echo-outgoing/],
    ['SOURCE_CHANGED', 'SOURCE_CHANGED', /变化/]
  ]) {
    const h = rig(t, { registerResult: { ok: false, code: artifactCode, reason: 'PRIVATE_B_PATH_037' } })
    const definition = h.sender.toolDefinition(), value = await h.execute(h.send())
    assert.equal(value.state, 'not_submitted')
    assert.equal(value.code, code)
    assert.match(definition.output.render({}, value)[0].text, text)
    assert.doesNotMatch(JSON.stringify(value), /PRIVATE_B_PATH_037/)
    assert.equal(h.uploads.length, 0)
  }
})

test('037-C1：无关的长叶名条目不影响正常ref，仅拒绝选中的过长上传名', async t => {
  const longName = 'x'.repeat(180) + '.bin'
  const h = rig(t, { list: (_grant, result) => ({ ...result,
    items: [{ ref: longName, name: longName, bytes: 1 }, ...result.items] }) })
  const first = h.send()
  assert.equal((await h.execute(first)).state, 'confirmed')
  h.toolResult(first); h.nextStep()
  const value = await h.execute(h.send({ ref: longName }))
  assert.equal(value.state, 'not_submitted')
  assert.equal(value.code, 'INVALID_NAME')
  assert.equal(h.uploads.length, 1)
})

test('037-C1：B合同2048内长相对ref可选，上传仍只用安全叶名', async t => {
  const ref = 'reports/'.repeat(140) + 'report.txt'
  const h = rig(t, { files: [{ path: 'echo-outgoing/' + ref }] })
  const value = await h.execute(h.send({ ref }))
  assert.equal(value.state, 'confirmed')
  assert.equal(value.ref, ref)
  assert.equal(h.uploads[0].name, 'report.txt')
  assert.match(h.sender.toolDefinition().description, /8MiB/)
})

test('037-C1：同一真实session的另一文件也须等physicalDone，不能只靠不同ref并发', async t => {
  const physical = future()
  const h = rig(t, {
    files: [{ path: 'echo-outgoing/' + REF }, { path: 'echo-outgoing/other.txt' }],
    contentOf: path => path,
    begin: () => ({ result: Promise.resolve({ ok: false, state: 'unknown', code: 'TIMEOUT' }),
      physicalDone: physical.promise })
  })
  const first = h.send()
  assert.equal((await h.execute(first)).state, 'unknown')
  h.toolResult(first); h.nextStep()
  const second = h.send({ ref: 'other.txt' })
  assert.equal((await h.execute(second)).code, 'BUSY')
  assert.equal(h.snapshots.length, 1)
  assert.equal(h.uploads.length, 1)
  physical.resolve()
  await delay(0)
  h.toolResult(second); h.nextStep()
  assert.equal((await h.execute(h.send({ ref: 'other.txt' }))).state, 'unknown')
  assert.equal(h.snapshots.length, 2)
  assert.equal(h.uploads.length, 2)
})
