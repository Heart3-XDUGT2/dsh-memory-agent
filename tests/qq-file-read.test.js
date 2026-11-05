import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createFileReader } from '../lib/qq-file-read.js'

const REF = 'a'.repeat(32), SECOND = 'b'.repeat(32)
const LABEL = '文件2026-11-02T03:04:05.006Z-1'
const LABEL2 = '文件2026-11-02T03:04:05.006Z-2'
const NAME = 'echo_qq_file_read'
const scope = Object.freeze({ chatId: '11', chatType: 'private', senderId: '11', isMaster: true })
const sourceOf = patch => ({ kind: 'plugin:dsh-echo', form: 'relay', platform: 'qq', ...scope, ...patch })
const freeze = value => {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value) }
  return value
}
const bodyOf = (patch = {}) => ({
  ok: true, ref: REF, label: LABEL, name: '合成.txt', format: 'txt', text: '合成文档正文',
  start: 0, end: 6, totalChars: 16000, nextOffset: 6, truncated: false, warnings: [], ...patch
})

function rig ({ origin = scope, files, read } = {}) {
  let time = 1000, live = true, inScope = true, turn = 0, step = 0, serial = 0
  const events = new Map(), calls = []
  const session = { id: 'shared-file-session', seq: 0, eventAt: seq => events.get(seq) }
  const agent = { session, status: 'idle', inbox: {} }
  let service = {
    readFile: async request => {
      calls.push(request)
      return read ? read(request) : bodyOf({ ref: request.ref, label: request.ref === SECOND ? LABEL2 : LABEL,
        start: request.offset, end: request.offset + 6, nextOffset: request.offset + 6 })
    }
  }
  const reader = createFileReader({
    serviceOf: () => service, isEnabled: () => live, sessionEnabledOf: () => inScope, now: () => time
  })
  const bind = (items = files || [{ ref: REF, label: LABEL }], owner = origin) => reader.bind({
    agent, env: { platform: 'qq', ...owner, files: items }
  })
  bind()
  const emit = (type, data, append = false) => {
    const event = freeze({ type, data, seq: session.seq++, ...(append ? { surfaceOp: 'append' } : {}) })
    events.set(event.seq, event)
    return reader.observeSessionEvent(session, event)
  }
  const start = () => { agent.status = 'running'; turn++; step = 0; emit('turn/start', { turn }) }
  const message = (source = sourceOf({ fileRefs: [REF] })) => freeze({
    id: 'file-message-' + ++serial, role: 'user', content: [{ type: 'text', text: '读取合成文件' }], source
  })
  const claim = one => reader.observeClaim({ agent, message: one, turn })
  const beginStep = () => {
    if (!step) { step = 1; emit('step/start', { turn, step }) }
  }
  const enter = one => { beginStep(); return emit('user/message', one, true) }
  const publish = (args = { ref: LABEL }, id = 'file-root-' + ++serial) => {
    emit('assistant/message', { turn, step, message: {
      role: 'assistant', content: [{ type: 'tool-call', id, name: NAME, arguments: JSON.stringify(args) }]
    } }, true)
    emit('tool/call', { turn, step, callId: id, name: NAME, arguments: JSON.stringify(args) })
    const controller = new AbortController()
    return { args, controller, exec: { agent, callId: id, rootCallId: id, name: NAME,
      arguments: args, token: Symbol(id), signal: controller.signal } }
  }
  const activate = (source = sourceOf({ fileRefs: [REF] }), args = { ref: LABEL }) => {
    start(); const one = message(source); claim(one); enter(one); return publish(args)
  }
  const end = () => {
    if (step) emit('step/end', { turn, step })
    emit('turn/end', { turn, reason: { kind: 'completed' } })
    step = 0; agent.status = 'idle'
  }
  const execute = call => reader.toolDefinition().execute(call.args, call.exec)
  return {
    reader, agent, session, calls, bind, emit, start, message, claim, beginStep, enter, publish, activate, end, execute,
    clock: value => { time = value }, power: value => { live = value }, sessionPower: value => { inScope = value },
    service: value => { service = value }
  }
}

test('034来源：真实claim入场后缺省offset在证明通过后归零，内部引用仅传服务', async () => {
  const h = rig(), call = h.activate(), value = await h.execute(call)
  assert.equal(value.ok, true)
  assert.equal(h.calls.length, 1)
  assert.equal(h.calls[0].ref, REF)
  assert.equal(h.calls[0].offset, 0)
  assert.equal(typeof h.calls[0].isCurrent, 'function')
  assert.equal(h.calls[0].isCurrent(), true)
  assert.equal(h.calls[0].signal, call.exec.signal)
  assert.deepEqual(h.calls[0].source, scope)
  assert.equal(value.ref, LABEL)
  assert.match(value.text, /合成文档正文/)
  assert.match(value.text, /不是当前发送者的自述/)
  assert.equal('turn' in call.exec, false)
  assert.doesNotMatch(JSON.stringify(value), /a{32}|echo_qq_file_read|chatId|senderId/)
  assert.deepEqual(JSON.parse(JSON.stringify(value)), value)
})

test('034来源：双文件分别映射，后续同聊天没有fileRefs也可继续', async () => {
  const h = rig({ files: [{ ref: REF, label: LABEL }, { ref: SECOND, label: LABEL2 }] })
  assert.equal((await h.execute(h.activate(sourceOf({ fileRefs: [REF, SECOND] })))).ok, true)
  h.end()
  assert.equal((await h.execute(h.activate(sourceOf({}), { ref: LABEL2, offset: 12 }))).ok, true)
  assert.deepEqual(h.calls.map(one => [one.ref, one.offset]), [[REF, 0], [SECOND, 12]])
})

test('034来源：单独bind或claim均不激活文件名称', async () => {
  for (const mode of ['bind', 'claim']) {
    const h = rig(); h.start()
    const one = h.message(mode === 'claim' ? sourceOf({ fileRefs: [REF] }) : sourceOf({}))
    h.claim(one)
    if (mode === 'claim') h.beginStep()
    else h.enter(one)
    assert.equal((await h.execute(h.publish())).ok, false)
    assert.equal(h.calls.length, 0)
  }
})

test('034来源：第二引用错误不能部分激活第一引用', async () => {
  const h = rig()
  assert.equal((await h.execute(h.activate(sourceOf({ fileRefs: [REF, SECOND] })))) .ok, false)
  h.end()
  assert.equal((await h.execute(h.activate(sourceOf({})))).ok, false)
  assert.equal(h.calls.length, 0)
})

test('034来源：bind双文件先整体核验，第二个无效不能留下第一绑定', async () => {
  const h = rig({ files: [] })
  assert.equal(h.bind([{ ref: REF, label: LABEL }, { ref: SECOND, label: '无效' }]).ok, false)
  assert.equal((await h.execute(h.activate())).ok, false)
  assert.equal(h.calls.length, 0)
})

for (const fileRefs of [[], [REF, REF], [REF, SECOND, 'c'.repeat(32)], ['bad'], REF]) {
  test('034来源：异常fileRefs拒绝 ' + JSON.stringify(fileRefs), async () => {
    const h = rig(), value = await h.execute(h.activate(sourceOf({ fileRefs })))
    assert.equal(value.ok, false)
    assert.equal(h.calls.length, 0)
  })
}

test('034来源：同sid跨群/私聊/非主人/官方与本地不能读旧私聊', async () => {
  for (const source of [
    sourceOf({ chatType: 'group', chatId: '33', senderId: '44', isMaster: false }),
    sourceOf({ senderId: '22' }), sourceOf({ isMaster: false }),
    sourceOf({ platform: 'qq-official' }), { kind: 'user' }
  ]) {
    const h = rig()
    assert.equal((await h.execute(h.activate())).ok, true)
    h.end()
    assert.equal((await h.execute(h.activate(source))).ok, false)
    assert.equal(h.calls.length, 1)
  }
})

test('034来源：群友可读同群已授权文件，不能读别群', async () => {
  const group = { chatType: 'group', chatId: '33', senderId: '11', isMaster: true }
  const h = rig({ origin: group })
  assert.equal((await h.execute(h.activate(sourceOf({ ...group, senderId: '22', isMaster: false, fileRefs: [REF] })))).ok, true)
  h.end()
  assert.equal((await h.execute(h.activate(sourceOf({ ...group, chatId: '44' })))).ok, false)
})

test('034来源：真实claim被prestep改id或改正文均拒绝', async () => {
  for (const mode of ['id', 'text']) {
    const h = rig(); h.start()
    const one = h.message()
    h.claim(one)
    h.enter(mode === 'id' ? h.message(one.source) : { ...one, content: [{ type: 'text', text: '合成替换' }] })
    assert.equal((await h.execute(h.publish())).ok, false)
    assert.equal(h.calls.length, 0)
  }
})

test('034来源：嵌套PTC/伪根/参数篡改/无signal/换agent均拒绝', async () => {
  for (const patch of [
    { parent: Symbol('outer') }, { rootCallId: 'outer' }, { callId: 'unknown' },
    { arguments: { ref: LABEL, offset: 0 } }, { signal: undefined }, { agent: {} }
  ]) {
    const h = rig(), call = h.activate()
    Object.assign(call.exec, patch)
    assert.equal((await h.execute(call)).ok, false)
    assert.equal(h.calls.length, 0)
  }
})

test('034来源：任意URL/路径/内部token和额外自报来源不是模型参数', async () => {
  for (const args of [
    { ref: REF }, { ref: 'https://example.invalid/signed' }, { ref: 'C:/fiction.txt' },
    { ref: LABEL, offset: '0' }, { ref: LABEL, offset: -1 }, { ref: LABEL, offset: 100001 },
    { ref: LABEL, url: 'https://example.invalid' }, { ref: LABEL, chatId: '11' }
  ]) {
    const h = rig(), value = await h.execute(h.activate(undefined, args))
    assert.equal(value.ok, false)
    assert.equal(h.calls.length, 0)
  }
})

test('034来源：总闸/会话闸/取消/TTL均在调用服务前复核', async () => {
  for (const change of [
    (h, call) => call.controller.abort(), h => h.power(false), h => h.sessionPower(false),
    h => h.clock(1801001)
  ]) {
    const h = rig(), call = h.activate()
    change(h, call)
    assert.equal((await h.execute(call)).ok, false)
    assert.equal(h.calls.length, 0)
  }
})

test('034来源：等待期间取消/轮末/服务变化/dispose不提供旧结果，isCurrent随即失效', async () => {
  for (const change of [
    (h, call) => call.controller.abort(), h => h.end(),
    h => h.service({ readFile: async () => bodyOf() }), h => h.reader.dispose()
  ]) {
    const gate = Promise.withResolvers()
    const h = rig({ read: () => gate.promise }), call = h.activate()
    const pending = h.execute(call)
    await Promise.resolve()
    assert.equal(h.calls[0].isCurrent(), true)
    change(h, call)
    assert.equal(h.calls[0].isCurrent(), false)
    gate.resolve(bodyOf({ text: '不应泄露', end: 4, nextOffset: 4 }))
    const value = await pending
    assert.equal(value.ok, false)
    assert.doesNotMatch(JSON.stringify(value), /不应泄露/)
  }
})

test('034来源：本原生根仅能使用一次，跨轮重放也拒绝', async () => {
  const h = rig(), call = h.activate()
  assert.equal((await h.execute(call)).ok, true)
  assert.equal((await h.execute(call)).ok, false)
  h.end()
  assert.equal((await h.execute(call)).ok, false)
  assert.equal(h.calls.length, 1)
})

test('034来源：文件绑定最多32项，容量淘汰后旧名称不可重新使用', async () => {
  const labels = new Map([[REF, LABEL]])
  const h = rig({ read: request => bodyOf({ ref: request.ref, label: labels.get(request.ref) }) })
  for (let i = 1; i <= 32; i++) {
    const ref = i.toString(16).padStart(32, '0'), label = '文件2026-11-02T03:04:05.006Z-' + (i + 2)
    labels.set(ref, label)
    assert.equal(h.bind([{ ref, label }]).ok, true)
  }
  assert.equal((await h.execute(h.activate())).ok, false)
  h.end()
  const ref = '1'.padStart(32, '0')
  assert.equal((await h.execute(h.activate(sourceOf({ fileRefs: [ref] }), { ref: labels.get(ref) }))).ok, true)
})

test('034来源：容量满时同条双文件中已核的旧引用不被新引用淘汰', async () => {
  const h = rig()
  for (let i = 1; i <= 31; i++) {
    const ref = i.toString(16).padStart(32, '0'), label = '文件2026-11-02T03:04:05.006Z-' + (i + 2)
    assert.equal(h.bind([{ ref, label }]).ok, true)
  }
  assert.equal(h.bind([{ ref: SECOND, label: LABEL2 }, { ref: REF, label: LABEL }]).ok, true)
  assert.equal((await h.execute(h.activate(sourceOf({ fileRefs: [REF, SECOND] })))).ok, true)
})

test('034来源：TTL30分钟到期与重绑同名引用都不继承旧别名授权', async () => {
  const h = rig(), first = h.activate()
  h.clock(1800999)
  assert.equal((await h.execute(first)).ok, true)
  h.end(); h.clock(1801000)
  assert.equal((await h.execute(h.activate(sourceOf({})))).ok, false)
  h.end(); h.clock(1801001)
  assert.equal(h.bind([{ ref: SECOND, label: LABEL }]).ok, true)
  assert.equal((await h.execute(h.activate(sourceOf({})))).ok, false)
  h.end()
  h.service({ readFile: request => bodyOf({ ref: request.ref }) })
  assert.equal((await h.execute(h.activate(sourceOf({ fileRefs: [SECOND] })))).ok, true)
})

test('034投影：不信任服务返回的ref/label/区间/截断/超长正文', async () => {
  for (const patch of [
    { ref: SECOND }, { label: LABEL2 }, { start: 1 }, { end: 3 },
    { totalChars: 3 }, { nextOffset: 20 }, { truncated: 'false' },
    { text: 'x'.repeat(4001), end: 4001, nextOffset: 4001 }
  ]) {
    const h = rig({ read: () => bodyOf(patch) })
    const value = await h.execute(h.activate())
    assert.equal(value.ok, false, JSON.stringify(patch).slice(0, 80))
    assert.doesNotMatch(JSON.stringify(value), /合成文档正文|x{100}/)
  }
})

test('034投影：PDF页统计与字符游标分开，截断不冒称全文已读', async () => {
  const h = rig({ read: () => bodyOf({ format: 'pdf', name: '合成.pdf', pages: 6, pagesRead: 2,
    truncated: true, nextOffset: null, totalChars: 6 }) })
  const call = h.activate(), value = await h.execute(call)
  assert.equal(value.ok, true)
  assert.equal(value.pages, 6)
  assert.equal(value.pagesRead, 2)
  assert.match(value.text, /UTF-16.*\[0, 6\)/)
  assert.match(value.text, /截断|未读/)
  assert.match(value.text, /不对应.*页|不代表.*页/)
  assert.doesNotMatch(value.text, /已读全文|全文已读/)
})

test('034投影：失败只投影受控reason/code，不泄露服务异常与任意hint', async () => {
  for (const read of [
    () => { throw Error('https://example.invalid/secret?token=fiction') },
    () => ({ ok: false, reason: 'https://example.invalid/secret', code: 'fiction', hint: 'C:/fiction/secret' })
  ]) {
    const h = rig({ read }), call = h.activate(), value = await h.execute(call)
    assert.equal(value.ok, false)
    const rendered = h.reader.toolDefinition().output.render(call.args, value)
    assert.doesNotMatch(JSON.stringify({ value, rendered }), /https?:|fiction|secret/)
  }
})

test('034投影：已确认解析错误用固定文案说明原因，不回显服务hint', async () => {
  const h = rig({ read: () => ({ ok: false, reason: 'parse-failed', code: 'PDF_ENCRYPTED',
    hint: 'https://example.invalid/fiction?secret=1' }) })
  const call = h.activate(), value = await h.execute(call)
  assert.deepEqual(value, { ok: false, reason: 'parse-failed', code: 'PDF_ENCRYPTED' })
  const rendered = h.reader.toolDefinition().output.render(call.args, value)
  assert.match(rendered[0].text, /密码|解密|解锁/)
  assert.doesNotMatch(JSON.stringify({ value, rendered }), /https?:|fiction|secret/)
})
