/**
 * 037-C1：真实安装AgentLoop/ToolRuntime/present，B产物与QQ上传均依赖注入。
 * 临时合成文件、禁止网络，无实际B模块或真实发送。
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { createQQFileSender } from '../lib/qq-send-file.js'
import {
  assemble, PRIVATE, GROUP, TOOL, REF, BODY, message, localMessage,
  response, deferred, bounded, assertSafeSendValues, sendResultMessages,
  isolation, cleanTmp
} from './fixtures/qq-send-c1-host.mjs'

const host = (t, options = {}) => assemble(t, { createSender: createQQFileSender, ...options })
const call = (id, name, args) => ({ id, name, arguments: JSON.stringify(args) })
const presentCall = (id, path = 'echo-outgoing/' + REF) => call(id, 'present', { files: [{ path }] })
const sendCall = (id, ref = REF) => call(id, TOOL, { ref })
async function isSettled (promise) {
  let timer
  try {
    return await Promise.race([promise.then(() => true), new Promise(resolve => { timer = setTimeout(() => resolve(false), 25) })])
  } finally { clearTimeout(timer) }
}

for (const [label, source] of [['主人私聊', PRIVATE], ['主人群聊', GROUP]]) {
  test('037-C1 host：普通' + label + '真实present跨步后发送，不依赖034附加引用', { timeout: 6000 }, async t => {
    const h = await host(t), input = message(source)
    assert.equal(Object.hasOwn(input.source, 'fileRefs'), false)
    await h.enqueue(input, source)
    await h.agent.whenIdle()
    assert.equal(h.values.length, 1)
    assert.equal(h.values[0].state, 'confirmed')
    assert.equal(h.uploads.length, 1)
    assert.equal(h.uploads[0].chatType, source.chatType)
    assert.equal(h.uploads[0].chatId, source.chatId)
    assert.equal(h.uploads[0].name, REF)
    assert.equal(Buffer.from(h.uploads[0].data).toString('utf8'), BODY)
    assert.ok(h.uploads[0].deadlineAt <= Date.now() + 60000)
    assert.equal(h.trace.register.length, 1)
    assert.equal(h.trace.register[0].valid, true)
    assert.equal(h.trace.snapshot.length, 1)
    assert.equal(h.trace.snapshot[0].valid, true)
    const registration = h.trace.register[0], snapshot = h.trace.snapshot[0]
    assert.equal(registration.scope.authority, snapshot.scope.authority)
    assert.equal(registration.scope.agent, h.agent)
    assert.equal(registration.scope.session, h.agent.session)
    const presentRoot = h.events.find(e => e.type === 'tool/call' && e.data.name === 'present')
    const delivered = h.events.find(e => e.type === 'deliverables/presented')
    const nativeResult = h.runtimeResults.find(x => x.exec.name === 'present')
    const sessionResult = h.events.find(e => e.type === 'tool/result' &&
      e.data.message.toolCallId === presentRoot.data.callId)
    const stepEnd = h.events.find(e => e.type === 'step/end' && e.data.step === 1)
    assert.equal(delivered.data.callId, presentRoot.data.callId)
    assert.equal(delivered.data.turn, 1)
    assert.equal(nativeResult.result.isError, false)
    assert.deepEqual(nativeResult.result.value.files, delivered.data.files)
    assert.ok(delivered.seq <= nativeResult.afterSeq)
    assert.equal(sessionResult.data.message.isError, false)
    assert.ok(sessionResult.seq < stepEnd.seq)
    assert.ok(registration.atSeq > stepEnd.seq, 'mock登记故意跨过present根settled和step/end')
    assert.ok(h.executions.every(x => x.hasTurn === false && x.hasStep === false))
    assert.equal(h.entered.length, 1, '目录/ref提示不能伪造主人user/message')
    assert.equal(h.entered[0].id, input.id)
    assert.equal(h.entered[0].source.rawText, input.source.rawText)
    const definition = h.sender.toolDefinition()
    assert.deepEqual(Object.keys(definition.parameters), ['ref'])
    assert.match(definition.description, /echo-outgoing/)
    assert.match(definition.description, /present/)
    assert.equal(sendResultMessages(h)[0].isError, false)
    assertSafeSendValues(assert, h)
  })
}

for (const [label, input, env] of [
  ['本地DSH', () => localMessage(), null],
  ['醒群非主人', () => message({ ...GROUP, senderId: '22', isMaster: false }), { ...GROUP, senderId: '22', isMaster: false }],
  ['官方平台', () => message({ ...PRIVATE, platform: 'qq-official' }), { ...PRIVATE, platform: 'qq-official' }],
  ['未知来源', () => message({ ...PRIVATE, isMaster: false }), PRIVATE]
]) {
  test('037-C1 host：' + label + '即使真实present成功也不能借发送权限', { timeout: 6000 }, async t => {
    const h = await host(t)
    await h.enqueue(input(), env)
    await h.agent.whenIdle()
    assert.equal(h.values.length, 1)
    assert.equal(h.values[0].state, 'not_submitted')
    assert.equal(h.trace.register.length, 0)
    assert.equal(h.trace.snapshot.length, 0)
    assert.equal(h.uploads.length, 0)
    assertSafeSendValues(assert, h)
  })
}

for (const mode of ['only-bind', 'only-claim']) {
  test('037-C1 host：仅登记或仅claim不足以授权 ' + mode, { timeout: 6000 }, async t => {
    const h = await host(t), input = message()
    await h.enqueue(input, PRIVATE, mode === 'only-bind' ? { bindMessage: message() } : { bind: false })
    await h.agent.whenIdle()
    assert.equal(h.values[0]?.state, 'not_submitted')
    assert.equal(h.uploads.length, 0)
    assert.equal(h.trace.snapshot.length, 0)
    assertSafeSendValues(assert, h)
  })
}

test('037-C1 host：同sid下一轮换QQ聊天，不能继承已展示ref', { timeout: 6000 }, async t => {
  const h = await host(t, {
    script: function * (_request, index, { tag }) {
      if (index === 0) yield * response('', [presentCall(tag + '-p')])
      else if (index === 1 || index === 3) yield * response('', [sendCall(tag + '-s-' + index)])
      else yield * response('合成结束')
    }
  })
  await h.enqueue(message(PRIVATE), PRIVATE)
  await h.agent.whenIdle()
  assert.equal(h.values[0].state, 'confirmed')
  await h.enqueue(message(GROUP), GROUP)
  await h.agent.whenIdle()
  assert.equal(h.values.length, 2)
  assert.equal(h.values[1].state, 'not_submitted')
  assert.equal(h.uploads.length, 1)
  assert.equal(h.trace.register.length, 1)
  assertSafeSendValues(assert, h)
})

test('037-C1 host：同一实际轮混入两个QQ聊天，拒绝共享authority', { timeout: 6000 }, async t => {
  const h = await host(t), a = message(PRIVATE), b = message(GROUP)
  await h.agent.runMaintenance(async () => {
    h.sender.bind({ agent: h.agent, message: a, env: PRIVATE, isCurrent: () => true })
    h.sender.bind({ agent: h.agent, message: b, env: GROUP, isCurrent: () => true })
    h.agent.followup(a); h.agent.inject(b)
  })
  await h.agent.whenIdle()
  assert.equal(h.claims.length, 2)
  assert.equal(h.claims[0].turn, h.claims[1].turn, 'next-step输入须实际在同一轮被claim')
  assert.equal(h.values[0]?.state, 'not_submitted')
  assert.equal(h.uploads.length, 0)
  assert.equal(h.trace.snapshot.length, 0)
  assertSafeSendValues(assert, h)
})

test('037-C1 host：pre-step替换不能冒认已经claim的主人消息', { timeout: 6000 }, async t => {
  const input = message(), replacement = message(PRIVATE, '合成替换输入')
  let replaced = false
  const h = await host(t, {
    preStep: async (_payload, next) => {
      const decision = await next()
      if (!replaced && decision.kind === 'enter') { replaced = true; return { ...decision, messages: [replacement] } }
      return decision
    }
  })
  await h.enqueue(input, PRIVATE)
  await h.agent.whenIdle()
  assert.equal(h.claims.some(p => p.message.id === input.id), true)
  assert.equal(h.claims.some(p => p.message.id === replacement.id), false)
  assert.equal(h.entered.some(m => m.id === replacement.id), true)
  assert.equal(h.values[0]?.state, 'not_submitted')
  assert.equal(h.trace.register.length, 0)
  assert.equal(h.uploads.length, 0)
  assertSafeSendValues(assert, h)
})

test('037-C1 host：同名deliverables事件没有实际present根，不登记产物', { timeout: 6000 }, async t => {
  const h = await host(t, {
    fakeTools: [{
      name: 'synthetic_forge_present',
      execute: async (_args, exec) => {
        exec.agent.session.append('deliverables/presented', {
          turn: 1, callId: exec.callId, files: [{ path: 'echo-outgoing/' + REF }]
        })
        return { ok: true }
      }
    }],
    script: function * (_request, index, { tag }) {
      if (index === 0) yield * response('', [call(tag + '-f', 'synthetic_forge_present', {})])
      else if (index === 1) yield * response('', [sendCall(tag + '-s')])
      else yield * response('合成结束')
    }
  })
  await h.enqueue(message(), PRIVATE)
  await h.agent.whenIdle()
  assert.equal(h.events.some(e => e.type === 'deliverables/presented'), true)
  assert.equal(h.runtimeResults.some(r => r.exec.name === 'present'), false)
  assert.equal(h.trace.register.length, 0)
  assert.equal(h.values[0]?.state, 'not_submitted')
  assert.equal(h.uploads.length, 0)
  assertSafeSendValues(assert, h)
})

test('037-C1 host：实际present失败不授权发送其它存在的文件', { timeout: 6000 }, async t => {
  const h = await host(t, {
    script: function * (_request, index, { tag }) {
      if (index === 0) yield * response('', [presentCall(tag + '-missing', 'echo-outgoing/missing.txt')])
      else if (index === 1) yield * response('', [sendCall(tag + '-s')])
      else yield * response('合成结束')
    }
  })
  await h.enqueue(message(), PRIVATE)
  await h.agent.whenIdle()
  assert.equal(h.runtimeResults.find(r => r.exec.name === 'present')?.result.isError, true)
  assert.equal(h.events.some(e => e.type === 'deliverables/presented'), false)
  assert.equal(h.trace.register.length, 0)
  assert.equal(h.values[0]?.state, 'not_submitted')
  assert.equal(h.uploads.length, 0)
  assertSafeSendValues(assert, h)
})

test('037-C1 host：真实Runtime的nested子调用不能借原生发送根', { timeout: 6000 }, async t => {
  const h = await host(t, {
    fakeTools: [{
      name: 'synthetic_nested_send',
      execute: async (_args, exec, { ctx }) => {
        const result = await ctx.tools.execute({
          callId: exec.callId + '-child', rootCallId: exec.rootCallId, name: TOOL,
          arguments: { ref: REF }, agent: exec.agent, parent: exec.token, signal: exec.signal
        })
        assert.equal(result.isError, false)
        return { ok: true }
      }
    }],
    script: async function * (_request, index, { tag }) {
      if (index === 0) yield * response('', [presentCall(tag + '-p')])
      else if (index === 1) {
        await new Promise(resolve => setImmediate(resolve))
        yield * response('', [call(tag + '-n', 'synthetic_nested_send', {})])
      }
      else yield * response('合成结束')
    }
  })
  await h.enqueue(message(), PRIVATE)
  await h.agent.whenIdle()
  assert.equal(h.trace.register.length, 1)
  assert.equal(h.values[0]?.state, 'not_submitted')
  assert.equal(h.executions[0]?.parent !== undefined, true)
  assert.equal(h.trace.snapshot.length, 0)
  assert.equal(h.uploads.length, 0)
  assertSafeSendValues(assert, h)
})

test('037-C1 host：重新present改名相同内容与新send根只查询旧终态', { timeout: 6000 }, async t => {
  const h = await host(t, {
    script: async function * (_request, index, { tag }) {
      if (index === 0) yield * response('', [presentCall(tag + '-p')])
      else if (index === 1 || index === 3) {
        yield * response('', [sendCall(tag + '-s-' + index)])
      }
      else if (index === 2) yield * response('', [presentCall(tag + '-renamed', 'echo-outgoing/renamed.txt')])
      else yield * response('合成结束')
    }
  })
  await h.enqueue(message(), PRIVATE)
  await h.agent.whenIdle()
  assert.equal(h.values.length, 2)
  assert.equal(h.values[0].state, 'confirmed')
  assert.equal(h.values[1].state, 'confirmed')
  assert.equal(h.trace.register.length, 2)
  assert.ok(h.trace.register.every(r => r.valid))
  assert.equal(h.trace.register[0].scope.authority, h.trace.register[1].scope.authority)
  assert.equal(h.uploads.length, 1)
  assert.equal(h.entered.length, 1)
  assertSafeSendValues(assert, h)
})

test('037-C1 host：写后真实取消不抹unknown，physicalDone仍由服务结算', { timeout: 6000 }, async t => {
  const started = deferred(), logical = deferred(), physical = deferred()
  const h = await host(t, {
    upload: (args, { cleanup }) => {
      started.resolve(args)
      const abort = () => logical.resolve({ ok: false, state: 'unknown', code: 'ABORTED', bytes: args.data.byteLength })
      args.signal.addEventListener('abort', abort, { once: true })
      cleanup.push(() => { logical.resolve({ ok: false, state: 'unknown', code: 'ABORTED' }); physical.resolve() })
      return { result: logical.promise, physicalDone: physical.promise }
    }
  })
  await h.enqueue(message(), PRIVATE)
  const active = await bounded(started.promise)
  assert.equal(active.isCurrent(), true)
  h.agent.cancel({ kind: 'user' })
  await h.agent.whenIdle()
  assert.equal(active.signal.aborted, true)
  assert.equal(h.values[0]?.state, 'unknown')
  assert.equal(await isSettled(physical.promise), false)
  assert.equal(h.uploads.length, 1)
  assertSafeSendValues(assert, h)
  physical.resolve()
})

test('037-C1 host：调用上传后抛原始错误仍保守unknown且不外露诊断', { timeout: 6000 }, async t => {
  const h = await host(t, {
    upload: () => { throw Error('C:\\synthetic\\private-token base64://SYNTHETIC_SECRET') }
  })
  await h.enqueue(message(), PRIVATE)
  await h.agent.whenIdle()
  assert.equal(h.values[0]?.state, 'unknown')
  assert.equal(h.uploads.length, 1)
  assert.doesNotMatch(JSON.stringify(h.values), /private-token|SYNTHETIC_SECRET/)
  assertSafeSendValues(assert, h)
})

after(() => {
  assert.equal(isolation.networkAttempts, 0)
  assert.equal(isolation.persistenceMounted, false)
  cleanTmp()
})
