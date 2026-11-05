/**
 * 037-C2：实际安装宿主、原生present、真实B/fs、QQ service与A回环WS。
 * 文件、模型与QQ均为临时合成；仅准许127.0.0.1已登记临时端口。
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import {
  assemble, PRIVATE, GROUP, TOOL, REF, BODY,
  response, toolCall, presentCall, sendCall,
  deferred, bounded, settled, sendResults, safeValues, cleanupRoot, isolation
} from './fixtures/qq-send-integration-host.mjs'

const MAX_BYTES = 8 * 1024 * 1024
const done = h => bounded(h.agent.whenIdle(), 6000)
function uploaded (h, expected, source = PRIVATE, name = REF) {
  const uploads = h.uploadFrames()
  assert.equal(uploads.length, 1)
  const frame = uploads[0].frame
  assert.equal(frame.action, source.chatType === 'private' ? 'upload_private_file' : 'upload_group_file')
  const target = source.chatType === 'private' ? 'user_id' : 'group_id'
  assert.equal(String(frame.params[target]), source.chatId)
  assert.deepEqual(Object.keys(frame.params).sort(), [target, 'file', 'name', 'upload_file'].sort())
  assert.equal(frame.params.name, name)
  assert.equal(frame.params.upload_file, true)
  assert.ok(frame.params.file.startsWith('base64://'))
  assert.deepEqual(Buffer.from(frame.params.file.slice(9), 'base64'), Buffer.from(expected))
  return frame
}
function rejected (h, code) {
  assert.equal(h.values.length, 1)
  assert.equal(h.values[0].state, 'not_submitted')
  if (code) assert.equal(h.values[0].code, code)
  assert.equal(h.uploadFrames().length, 0)
  safeValues(h)
}

for (const [label, source] of [['主人私聊', PRIVATE], ['主人醒群', GROUP]]) {
  test('037-C2 E2E：' + label + '实际present→B快照→service→OneBot原字节确认', { timeout: 8000 }, async t => {
    const h = await assemble(t)
    const { result } = await h.enqueue(source)
    assert.equal(result, 'ok')
    await done(h)
    assert.equal(h.values.length, 1)
    assert.equal(h.values[0].state, 'confirmed')
    assert.equal(h.values[0].name, REF)
    assert.equal(h.values[0].bytes, Buffer.byteLength(BODY))
    uploaded(h, BODY, source)
    assert.equal(h.artifactTrace.prepare.length, 1)
    assert.equal(h.artifactTrace.register.length, 1)
    assert.equal(h.artifactTrace.register[0].ok, true)
    assert.equal(h.artifactTrace.snapshot.length, 1)
    assert.equal(h.artifactTrace.snapshot[0].ok, true)
    assert.equal(h.transportHandles.length, 1)
    assert.equal(await settled(h.transportHandles[0].physicalDone), true)
    assert.equal(h.entered.length, 1, '目录/ref不得新增伪造user/message')
    assert.equal(h.executions.every(value => !value.hasTurn && !value.hasStep), true)
    assert.equal(sendResults(h)[0].isError, false)
    safeValues(h)
  })
}

test('037-C2 E2E：真实入站绑定同一原生消息后followup，保留rawText与语音收件事实', { timeout: 8000 }, async t => {
  const h = await assemble(t)
  const text = '这是一条合成原话，请发送本轮展示文件。'
  const { env } = await h.enqueue(PRIVATE, { text, voices: [{ received: true, durationSeconds: 7 }] })
  await done(h)
  assert.equal(h.binds.length, 1)
  assert.equal(h.followups.length, 1)
  assert.equal(h.followupBindings[0].bindCount, 1)
  assert.equal(h.followupBindings[0].binding.message, h.followupBindings[0].input)
  assert.equal(h.followupBindings[0].binding.env, env)
  assert.equal(h.binds[0].message, h.followups[0])
  assert.equal(h.entered.length, 1)
  assert.equal(h.entered[0].id, h.followups[0].id)
  assert.equal(h.entered[0].source.rawText, text)
  assert.equal(h.entered[0].source.hasSupplementalContent, true)
  assert.deepEqual(h.entered[0].source.receiptKinds, ['voice'])
  assert.match(h.entered[0].content.map(value => value.text || '').join('\n'), /7秒/)
  assert.equal(h.values[0].state, 'confirmed')
  uploaded(h, BODY)
  safeValues(h)
})

test('037-C2 E2E：8MiB完整文件经真实B与WS确认，未截断未转宿主路径', { timeout: 12000 }, async t => {
  const body = Buffer.alloc(MAX_BYTES)
  for (let index = 0; index < body.length; index++) body[index] = (index * 17 + 23) % 251
  const h = await assemble(t, {
    files: { ['echo-outgoing/' + REF]: body }, timeoutMs: 6000, uploadTimeoutMs: 5000
  })
  await h.enqueue()
  await done(h)
  assert.equal(h.values[0]?.state, 'confirmed')
  assert.equal(h.values[0].bytes, MAX_BYTES)
  assert.equal(h.artifactTrace.register[0].items[0].bytes, MAX_BYTES)
  uploaded(h, body)
  safeValues(h)
})

for (const [label, body, code, artifact] of [
  ['超8MiB', () => Buffer.alloc(MAX_BYTES + 1, 19), 'FILE_TOO_LARGE', 'TOO_LARGE'],
  ['空文件', () => '', 'EMPTY_FILE', 'EMPTY_FILE']
]) {
  test('037-C2 E2E：' + label + '原生展示成功后由真实B明确拒绝且零WS', { timeout: 8000 }, async t => {
    const h = await assemble(t, { files: { ['echo-outgoing/' + REF]: body() } })
    await h.enqueue()
    await done(h)
    assert.equal(h.runtimeResults.find(value => value.exec.name === 'present')?.result.isError, false)
    assert.equal(h.artifactTrace.register.length, 1)
    assert.equal(h.artifactTrace.register[0].ok, false)
    assert.equal(h.artifactTrace.register[0].rejected[0].code, artifact)
    rejected(h, code)
    assert.equal(h.transportHandles.length, 0)
    const rendered = sendResults(h).flatMap(value => value.content || []).map(value => value.text || '').join('\n')
    assert.match(rendered, code === 'FILE_TOO_LARGE' ? /8MiB/ : /空/)
  })
}

test('037-C2 E2E：echo-outgoing外的普通已展示文件不允许外发', { timeout: 8000 }, async t => {
  const h = await assemble(t, {
    files: { 'ordinary.txt': BODY },
    script: function * (_request, index, { tag }) {
      if (index === 0) yield * response('', [presentCall(tag + '-outside', ['ordinary.txt'])])
      else if (index === 1) yield * response('', [sendCall(tag + '-send', 'ordinary.txt')])
      else yield * response()
    }
  })
  await h.enqueue()
  await done(h)
  assert.equal(h.runtimeResults.find(value => value.exec.name === 'present')?.result.isError, false)
  assert.equal(h.artifactTrace.register[0].ok, false)
  rejected(h, 'OUTSIDE_OUTPUT')
})

test('037-C2 E2E：实际登记完成后源文件被改，snapshot拒绝旧字节且零WS', { timeout: 8000 }, async t => {
  const h = await assemble(t, {
    beforeRequest: async (index, h) => {
      if (index !== 1) return
      const registration = await bounded(h.registered.promise)
      assert.equal(registration.ok, true)
      h.write('echo-outgoing/' + REF, BODY + '合成变化')
    }
  })
  await h.enqueue()
  await done(h)
  assert.equal(h.artifactTrace.register[0].ok, true)
  assert.equal(h.artifactTrace.snapshot[0].ok, false)
  assert.equal(h.artifactTrace.snapshot[0].code, 'SOURCE_CHANGED')
  rejected(h, 'SOURCE_CHANGED')
})

test('037-C2 E2E：同一present批次含超限与合法文件，坏条目不阻断合法条目', { timeout: 8000 }, async t => {
  const h = await assemble(t, {
    files: { 'echo-outgoing/large.bin': Buffer.alloc(MAX_BYTES + 1), ['echo-outgoing/' + REF]: BODY },
    script: function * (_request, index, { tag }) {
      if (index === 0) yield * response('', [presentCall(tag + '-mixed', ['echo-outgoing/large.bin', 'echo-outgoing/' + REF])])
      else if (index === 1) yield * response('', [sendCall(tag + '-send')])
      else yield * response()
    }
  })
  await h.enqueue()
  await done(h)
  assert.equal(h.artifactTrace.register[0].ok, true)
  assert.equal(h.artifactTrace.register[0].items.length, 1)
  assert.equal(h.artifactTrace.register[0].rejected[0].index, 0)
  assert.equal(h.artifactTrace.register[0].rejected[0].code, 'TOO_LARGE')
  assert.equal(h.values[0]?.state, 'confirmed')
  uploaded(h, BODY)
  safeValues(h)
})

test('037-C2 E2E：真实B改名同字节后用新ref查询原终态，实际上传只有一次', { timeout: 8000 }, async t => {
  const h = await assemble(t, {
    files: { ['echo-outgoing/' + REF]: BODY, 'echo-outgoing/renamed.txt': BODY },
    script: function * (_request, index, { tag }) {
      if (index === 0) yield * response('', [presentCall(tag + '-first')])
      else if (index === 1) yield * response('', [sendCall(tag + '-send-first')])
      else if (index === 2) yield * response('', [presentCall(tag + '-renamed', ['echo-outgoing/renamed.txt'])])
      else if (index === 3) yield * response('', [sendCall(tag + '-send-renamed', 'renamed.txt')])
      else yield * response()
    }
  })
  await h.enqueue()
  await done(h)
  assert.equal(h.artifactTrace.register.length, 2)
  assert.equal(h.artifactTrace.register.every(value => value.ok), true)
  assert.equal(h.artifactTrace.register[1].items[0].ref, REF, 'B保留首个规范ref')
  assert.deepEqual(h.executions.map(value => value.args.ref), [REF, 'renamed.txt'])
  assert.equal(h.values.length, 2)
  assert.equal(h.values[0].state, 'confirmed')
  assert.equal(h.values[1].state, 'confirmed')
  assert.equal(h.values[1].code, 'ALREADY_RECORDED')
  assert.equal(h.values[1].ref, REF)
  assert.equal(h.artifactTrace.snapshot.length, 1)
  uploaded(h, BODY)
  safeValues(h)
})

test('037-C2 E2E：醒群非主人实际present不能获得发送权限', { timeout: 8000 }, async t => {
  const h = await assemble(t)
  await h.enqueue({ ...GROUP, senderId: '22', isMaster: false })
  await done(h)
  assert.equal(h.entered.length, 1)
  assert.equal(h.runtimeResults.find(value => value.exec.name === 'present')?.result.isError, false)
  assert.equal(h.artifactTrace.register.length, 0)
  rejected(h, 'ORIGIN_UNPROVEN')
})

test('037-C2 E2E：本地DSH原生消息不能借present获得QQ发送权限', { timeout: 8000 }, async t => {
  const h = await assemble(t)
  await h.enqueueLocal()
  await done(h)
  assert.equal(h.binds.length, 0)
  assert.equal(h.entered.length, 1)
  assert.equal(h.artifactTrace.register.length, 0)
  rejected(h, 'ORIGIN_UNPROVEN')
})

test('037-C2 E2E：同一真实session换QQ聊天不能继承上轮ref', { timeout: 8000 }, async t => {
  const h = await assemble(t, {
    script: function * (_request, index, { tag }) {
      if (index === 0) yield * response('', [presentCall(tag + '-present')])
      else if (index === 1 || index === 3) yield * response('', [sendCall(tag + '-send-' + index)])
      else yield * response()
    }
  })
  await h.enqueue(PRIVATE)
  await done(h)
  assert.equal(h.values[0]?.state, 'confirmed')
  await h.enqueue(GROUP)
  await done(h)
  assert.equal(h.claims.length, 2)
  assert.notEqual(h.claims[0].turn, h.claims[1].turn)
  assert.equal(h.values.length, 2)
  assert.equal(h.values[1].state, 'not_submitted')
  assert.equal(h.artifactTrace.register.length, 1)
  uploaded(h, BODY)
  safeValues(h)
})

test('037-C2 E2E：真实Runtime nested/PTC子调用被拒，不能借已登记产物', { timeout: 8000 }, async t => {
  const h = await assemble(t, {
    fakeTools: [{
      name: 'synthetic_nested_send',
      execute: async (_args, exec, { ctx }) => {
        const value = await ctx.tools.execute({
          callId: exec.callId + '-child', rootCallId: exec.rootCallId, name: TOOL,
          arguments: { ref: REF }, agent: exec.agent, parent: exec.token, signal: exec.signal
        })
        assert.equal(value.isError, false)
        return { ok: true }
      }
    }],
    beforeRequest: async (index, h) => {
      if (index === 1) assert.equal((await bounded(h.registered.promise)).ok, true)
    },
    script: function * (_request, index, { tag }) {
      if (index === 0) yield * response('', [presentCall(tag + '-present')])
      else if (index === 1) yield * response('', [toolCall(tag + '-nested', 'synthetic_nested_send', {})])
      else yield * response()
    }
  })
  await h.enqueue()
  await done(h)
  assert.equal(h.artifactTrace.register[0].ok, true)
  assert.notEqual(h.executions[0].exec.parent, undefined)
  assert.equal(h.artifactTrace.snapshot.length, 0)
  rejected(h, 'ORIGIN_UNPROVEN')
})

for (const mode of ['group-sleep', 'allowlist-revoked']) {
  test('037-C2 E2E：present之后' + mode + '立即失权且零WS', { timeout: 8000 }, async t => {
    const h = await assemble(t, {
      beforeRequest: async (index, h) => {
        if (index !== 1) return
        assert.equal((await bounded(h.registered.promise)).ok, true)
        if (mode === 'group-sleep') h.awake.delete(GROUP.chatId)
        else h.settings.allowedGroups.length = 0
      }
    })
    await h.enqueue(GROUP)
    await done(h)
    assert.equal(h.artifactTrace.register[0].ok, true)
    rejected(h, 'ORIGIN_UNPROVEN')
  })
}

test('037-C2 E2E：null确认为unknown，同轮重复只查旧状态且不重发', { timeout: 8000 }, async t => {
  const h = await assemble(t, {
    onUpload: (entry, h) => { h.reply(entry, { data: { file_id: null } }); return false },
    script: function * (_request, index, { tag }) {
      if (index === 0) yield * response('', [presentCall(tag + '-present')])
      else if (index === 1 || index === 2) yield * response('', [sendCall(tag + '-send-' + index)])
      else yield * response()
    }
  })
  await h.enqueue()
  await done(h)
  assert.equal(h.values.length, 2)
  assert.equal(h.values[0].state, 'unknown')
  assert.equal(h.values[0].code, 'UNCONFIRMED')
  assert.equal(h.values[1].state, 'unknown')
  assert.equal(h.values[1].code, 'ALREADY_RECORDED')
  assert.equal(h.transportHandles.length, 1)
  assert.equal(h.artifactTrace.snapshot.length, 1)
  uploaded(h, BODY)
  assert.match(sendResults(h)[0].content.map(value => value.text || '').join('\n'), /(未知|不确定).*不自动重发/)
  safeValues(h)
})

test('037-C2 E2E：真实WS拒绝保留安全状态，原始错误与file_id不进入新工具结果', { timeout: 8000 }, async t => {
  const h = await assemble(t, {
    onUpload: (entry, h) => {
      h.reply(entry, {
        status: 'failed', retcode: 1400,
        wording: 'C:\\synthetic\\secret base64://SYNTHETIC_PRIVATE',
        data: { file_id: 'SYNTHETIC_REMOTE_PRIVATE' }
      })
      return false
    }
  })
  await h.enqueue()
  await done(h)
  assert.equal(h.values[0]?.state, 'rejected')
  assert.equal(h.values[0].code, 'REMOTE_REJECTED')
  uploaded(h, BODY)
  assert.doesNotMatch(JSON.stringify(h.values) + JSON.stringify(h.logs) + JSON.stringify(sendResults(h)),
    /SYNTHETIC_PRIVATE|SYNTHETIC_REMOTE_PRIVATE|synthetic\\\\secret/)
  safeValues(h)
})

test('037-C2 E2E：写后取消为unknown，跨轮仍占物理额度，迟到匹配ACK只释放额度', { timeout: 10000 }, async t => {
  const submitted = deferred()
  const h = await assemble(t, {
    timeoutMs: 5000, uploadTimeoutMs: 4500,
    onUpload: entry => { submitted.resolve(entry); return false },
    script: function * (_request, index, { tag }) {
      if (index === 0 || index === 2) yield * response('', [presentCall(tag + '-present-' + index)])
      else if (index === 1 || index === 3) yield * response('', [sendCall(tag + '-send-' + index)])
      else yield * response()
    }
  })
  await h.enqueue()
  const entry = await bounded(submitted.promise)
  assert.equal(h.transportHandles.length, 1)
  const physical = h.transportHandles[0].physicalDone
  assert.equal(await settled(physical), false)
  h.agent.cancel({ kind: 'user' })
  await done(h)
  assert.equal(h.values[0]?.state, 'unknown')
  assert.equal(await settled(physical), false)
  await h.enqueue()
  await done(h)
  assert.equal(h.values.length, 2)
  assert.equal(h.values[1].state, 'not_submitted')
  assert.equal(h.values[1].code, 'BUSY')
  assert.equal(h.transportHandles.length, 1)
  assert.equal(h.uploadFrames().length, 1)
  h.reply(entry)
  await bounded(physical)
  assert.equal(h.values[0].state, 'unknown')
  assert.equal(h.uploadFrames().length, 1)
  safeValues(h)
})

test('037-C2 E2E：超过1024个真实普通主人轮次后，本轮present/send仍能建立权限', { timeout: 60000 }, async t => {
  let phase = 'ordinary', sendingStep = 0
  const h = await assemble(t, {
    script: function * (_request, index, { tag }) {
      if (phase === 'ordinary') { yield * response('合成普通回合'); return }
      if (sendingStep++ === 0) yield * response('', [presentCall(tag + '-long-present')])
      else if (sendingStep === 2) yield * response('', [sendCall(tag + '-long-send')])
      else yield * response()
    }
  })
  for (let round = 0; round < 1025; round++) {
    const result = await h.enqueue(PRIVATE, { text: '合成普通回合 ' + round })
    assert.equal(result.result, 'ok')
    await done(h)
  }
  assert.equal(h.claims.length, 1025)
  assert.equal(new Set(h.claims.map(value => value.turn)).size, 1025)
  assert.equal(h.values.length, 0)
  assert.equal(h.artifactTrace.register.length, 0)
  phase = 'send'
  await h.enqueue()
  await done(h)
  assert.equal(h.claims.length, 1026)
  assert.equal(h.entered.length, 1026)
  assert.equal(h.values.length, 1)
  assert.equal(h.values[0].state, 'confirmed')
  assert.equal(h.artifactTrace.register[0].ok, true)
  uploaded(h, BODY)
  safeValues(h)
})

after(() => {
  assert.equal(isolation.deniedNetworkAttempts, 0)
  assert.equal(isolation.allowedLoopbackConnections, 20)
  assert.equal(isolation.persistenceMounted, false)
  cleanupRoot()
})
