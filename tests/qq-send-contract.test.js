/**
 * 037-C合同接缝：真实controller/origin/B，合成opaque composed fs与原生事件形状。
 * 不加载产品入口、真实宿主持久层、网络或模型；不读取任何真实文件正文。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { createQQFileSender } from '../lib/qq-send-file.js'
import { createQQSendArtifacts } from '../lib/qq-send-artifacts.js'

const OWNER = Object.freeze({
  platform: 'qq', chatType: 'private', chatId: '11', senderId: '11', isMaster: true
})
const TOOL = 'echo_qq_file_send'
const REF = 'report.txt'
const BODY = new TextEncoder().encode('037合同合成字节\n')
function freeze (value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze)
    Object.freeze(value)
  }
  return value
}
function memoryFilesystem (style, { noIO = false } = {}) {
  const p = path[style], cwd = style === 'win32' ? 'Q:\\synthetic-workspace' : '/synthetic-workspace'
  const counts = { resolve: 0, processPath: 0, contains: 0, lstat: 0, stat: 0, readBytes: 0 }
  const output = p.join(cwd, 'echo-outgoing')
  const content = new Map([
    [p.join(output, REF), BODY],
    [p.join(output, 'renamed.txt'), BODY],
    [p.join(output, 'next.txt'), new TextEncoder().encode('037另一份合成字节\n')]
  ])
  const entries = new Map([
    [cwd, { type: 'directory', version: 'opaque-workspace-version' }],
    [output, { type: 'directory', version: 'opaque-output-version' }],
    ...[...content].map(([name, bytes], index) => [
      name, { type: 'file', version: 'opaque-file-version-' + index, size: bytes.length }
    ])
  ])
  const keys = new Map([...entries.keys()].map((name, index) => [name, 'opaque-target-' + index]))
  const names = new Map([...keys].map(([name, key]) => [key, name]))
  function called (name) {
    counts[name]++
    if (noIO) assert.fail('无产物目录查询不应执行任何composed fs方法：' + name)
  }
  const filesystem = {
    async resolve (value, options) {
      called('resolve')
      return { targetKey: keys.get(p.resolve(options?.cwd ?? cwd, value)) }
    },
    processPath (target) { called('processPath'); return names.get(target.targetKey) },
    contains (parent, child) {
      called('contains')
      const relative = p.relative(names.get(parent.targetKey), names.get(child.targetKey))
      return relative === '' || (relative !== '..' && !relative.startsWith('..' + p.sep) && !p.isAbsolute(relative))
    },
    async lstat (value, options) {
      called('lstat')
      return entries.get(p.resolve(options?.cwd ?? cwd, value))
    },
    async stat (target) { called('stat'); return entries.get(names.get(target.targetKey)) },
    async readBytes (target, signal, limit) {
      called('readBytes')
      const bytes = content.get(names.get(target.targetKey))
      assert.equal(signal, undefined, '保留B已核Node22正文读取取消策略')
      assert.equal(limit, bytes.length)
      return new Uint8Array(bytes)
    }
  }
  return { filesystem, counts, cwd, p, output, content }
}

let serial = 0
function assembly (t, { maxScopes = 32 } = {}) {
  const uploads = [], operations = [], revocations = [], registered = []
  let registries = 0
  const channel = {
    beginFileUpload (input) {
      uploads.push({ name: input.name, bytes: new Uint8Array(input.data) })
      return {
        result: Promise.resolve({ ok: true, state: 'confirmed', code: 'CONFIRMED' }),
        physicalDone: Promise.resolve()
      }
    }
  }
  const sender = createQQFileSender({
    isEnabled: () => true, sessionEnabledOf: () => true, serviceOf: () => channel,
    createArtifacts (options) {
      registries++
      const actual = createQQSendArtifacts({ ...options, limits: { maxScopes } })
      const wrapped = { close: () => actual.close() }
      for (const name of ['prepare', 'registerPresented', 'list', 'snapshot', 'revoke']) {
        wrapped[name] = (...args) => {
          const scope = options.scopeOf(args[0])
          const entry = { name, grant: args[0], scope }
          operations.push(entry)
          entry.done = Promise.resolve(actual[name](...args)).then(result => {
            entry.result = result
            if (name === 'registerPresented') registered.push(result)
            return result
          })
          if (name === 'revoke') revocations.push(entry)
          return entry.done
        }
      }
      return wrapped
    }
  })
  t.after(async () => { await sender.dispose() })
  function nativeAgent (style = 'posix', options = {}) {
    const id = 'synthetic-contract-' + ++serial
    const fs = memoryFilesystem(style, options), events = new Map()
    const session = { id, header: { cwd: fs.cwd }, seq: 0, eventAt: seq => events.get(seq) }
    const agent = { session, status: 'idle', inbox: {}, ctx: { get: key => key === 'fs' ? fs.filesystem : undefined } }
    const turn = 1
    let step = 1, root = 0, open = true
    const emit = (type, data, extra = {}) => {
      const event = freeze({ type, data, seq: session.seq++, ...extra })
      events.set(event.seq, event)
      assert.equal(sender.observeSessionEvent(session, event).ok, true, '合成原生事件被拒绝：' + type)
      return event
    }
    const message = freeze({
      id: id + '-input', role: 'user',
      source: { kind: 'plugin:dsh-echo', form: 'relay', ...OWNER },
      content: [{ type: 'text', text: '合成当前主人发送请求' }]
    })
    assert.equal(sender.bind({ agent, message, env: OWNER, isCurrent: () => true }).ok, true)
    agent.status = 'running'
    emit('turn/start', { turn })
    assert.equal(sender.observeClaim({ agent, message, turn }).ok, true)
    emit('step/start', { turn, step })
    emit('user/message', message, { surfaceOp: 'append' })
    const next = () => {
      emit('step/end', { turn, step })
      emit('step/start', { turn, step: ++step })
    }
    function publish (name, args) {
      const callId = id + '-root-' + ++root
      emit('assistant/message', {
        turn, step, message: { role: 'assistant', content: [{
          type: 'tool-call', id: callId, name, arguments: JSON.stringify(args)
        }] }
      }, { surfaceOp: 'append' })
      const event = emit('tool/call', { turn, step, callId, name, arguments: JSON.stringify(args) })
      const exec = Object.freeze({
        agent, callId, rootCallId: callId, name, arguments: args,
        token: Symbol(callId), signal: new AbortController().signal
      })
      return { callId, args, event, exec }
    }
    function result (call, value) {
      assert.equal(sender.observeToolResult(call.exec, { isError: false, value, content: [] }).ok, true)
      emit('tool/result', {
        turn, step, message: {
          id: call.callId + '-result', role: 'tool', toolCallId: call.callId,
          source: { kind: 'tool', callId: call.callId }, isError: false, content: []
        }
      }, { surfaceOp: 'append', sourceEventSeqs: [call.event.seq] })
      next()
    }
    return {
      agent, session, fs,
      present (filename) {
        const files = [{ path: filename }], call = publish('present', { files })
        emit('deliverables/presented', { turn, callId: call.callId, files })
        result(call, { turn, files })
      },
      async send (ref) {
        const call = publish(TOOL, { ref })
        const value = await sender.toolDefinition().execute(call.args, call.exec)
        result(call, value)
        assertSafe(value)
        return { value, exec: call.exec }
      },
      async endTurn () {
        assert.equal(open, true)
        open = false
        emit('step/end', { turn, step })
        emit('turn/end', { turn, reason: { kind: 'completed' } })
        agent.status = 'idle'
        await Promise.all(revocations.map(entry => entry.done))
      }
    }
  }
  return { sender, nativeAgent, uploads, operations, revocations, registered, registryCount: () => registries }
}
function assertSafe (value) {
  const json = JSON.stringify(value)
  assert.deepEqual(JSON.parse(json), value)
  assert.doesNotMatch(json, /[A-Za-z]:[\\/]|\/synthetic-workspace|opaque-|targetKey|identity|authority|base64:|file_id/)
}

for (const style of ['posix', 'win32']) {
  for (const initialAbsolute of [false, true]) {
    for (const separators of style === 'win32' ? ['native', 'forward'] : ['native']) {
      test(`037合同：${style}/${separators}执行世界${initialAbsolute ? '绝对' : '相对'}首展→绝对路径同字节改名，新ref只查原状态`,
        { timeout: 6000 }, async t => {
          const h = assembly(t), native = h.nativeAgent(style)
          const absolute = name => {
            const result = native.fs.p.join(native.fs.output, name)
            return separators === 'forward' ? result.replaceAll('\\', '/') : result
          }
          native.present(initialAbsolute ? absolute(REF) : 'echo-outgoing/' + REF)
          const first = await native.send(REF)
          assert.equal(first.value.state, 'confirmed')
          native.present(absolute('renamed.txt'))
          const renamed = await native.send('renamed.txt')
          const original = await native.send(REF)
          assert.equal(h.registered.length, 2)
          assert.equal(h.registered[1].ok, true)
          assert.equal(h.registered[1].items[0].ref, REF, '真实B应保留规范ref与已交出身份')
          assert.equal(h.uploads.length, 1)
          assert.deepEqual(h.uploads[0].bytes, BODY)
          assert.equal(h.uploads[0].name, REF)
          assert.equal(renamed.value.state, 'confirmed')
          assert.equal(renamed.value.code, 'ALREADY_RECORDED')
          assert.equal(renamed.value.ref, REF)
          assert.equal(original.value.state, 'confirmed')
          assert.equal(original.value.code, 'ALREADY_RECORDED')
          assert.equal(h.operations.filter(entry => entry.name === 'snapshot').length, 1)
          assert.equal(h.registryCount(), 1)
          await native.endTurn()
        })
    }
  }
}

test('037合同：maxScopes1同registry多个独立Agent无present发送失败，turnEnd释放空scope且0FS/0上传', { timeout: 6000 }, async t => {
  const h = assembly(t, { maxScopes: 1 }), answers = [], agents = []
  for (let number = 0; number < 4; number++) {
    const native = h.nativeAgent(number % 2 ? 'win32' : 'posix', { noIO: true })
    agents.push(native)
    answers.push((await native.send('not-presented.txt')).value)
    await native.endTurn()
  }
  assert.deepEqual(answers.map(value => value.state), Array(4).fill('not_submitted'))
  assert.deepEqual(answers.map(value => value.code), Array(4).fill('NOT_REGISTERED'))
  assert.equal(h.registryCount(), 1, '生命周期不得通过重建B清空额度或去重账本')
  assert.equal(h.uploads.length, 0)
  assert.equal(h.registered.length, 0)
  assert.equal(h.operations.filter(entry => entry.name === 'list').length, 4)
  assert.equal(h.revocations.length, 4)
  for (const native of agents) assert.deepEqual(Object.values(native.fs.counts), Array(6).fill(0))
  for (const revoke of h.revocations) {
    assert.notEqual(revoke.result.code, 'INVALID_GRANT', '轮末须用B此前实际见过的grant撤销')
    assert.equal(h.operations.some(entry => entry.name === 'list' && entry.grant === revoke.grant), true)
  }
})

for (const style of ['posix', 'win32']) {
  test(`037合同：${style}正常present跨步骤共用轮内canonicalgrant，独立工具guard与旧exec拒绝保持`, { timeout: 6000 }, async t => {
    const h = assembly(t), native = h.nativeAgent(style)
    native.present('echo-outgoing/' + REF)
    const first = await native.send(REF)
    assert.equal(first.value.state, 'confirmed')
    native.present('echo-outgoing/next.txt')
    const second = await native.send('next.txt')
    assert.equal(second.value.state, 'confirmed')
    assert.equal(h.uploads.length, 2)
    assert.notEqual(first.exec.token, second.exec.token)
    assert.equal(h.operations.filter(entry => entry.name === 'snapshot').length, 2)
    const live = h.operations.filter(entry => entry.name !== 'revoke')
    assert.equal(new Set(live.map(entry => entry.grant)).size, 1)
    assert.equal(new Set(live.map(entry => entry.scope.authority)).size, 1)
    for (const entry of live) {
      assert.equal(entry.scope.agent, native.agent)
      assert.equal(entry.scope.session, native.session)
      assert.equal(entry.scope.turn, 1)
    }
    const firstSnapshot = live.find(entry => entry.name === 'snapshot')
    assert.equal(firstSnapshot.scope.isCurrent(), true, '已结束工具根不能撤销仍在本轮的canonicalgrant')
    await native.endTurn()
    assert.equal(firstSnapshot.scope.isCurrent(), false)
    assert.equal(h.revocations.length, 1)
    assert.equal(h.revocations[0].grant, firstSnapshot.grant)
    assert.notEqual(h.revocations[0].result.code, 'INVALID_GRANT')
    const stale = await h.sender.toolDefinition().execute({ ref: REF }, first.exec)
    assert.equal(stale.state, 'not_submitted')
    assert.equal(stale.code, 'ORIGIN_UNPROVEN')
    assert.equal(h.uploads.length, 2)
    assertSafe(stale)
  })
}
