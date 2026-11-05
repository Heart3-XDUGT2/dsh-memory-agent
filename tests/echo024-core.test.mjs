import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { writeTestTrace } from './fixtures/test-trace.mjs'
import { coreHost, response, identity, local, gate, until, traces, isolation, cleanTmp } from './fixtures/echo024-core.mjs'
const call = (index, text = 'synthetic selected reply', name = 'echo_qq_say') => ({ id: 'mvp-root-' + index, name, arguments: JSON.stringify({ text }) })
const normal = (_r, index) => index % 2 === 0 ? response('', [call(index)]) : response('synthetic assistant tail is not sent')
after(() => {
  const label = process.env.ECHO024_RUN_LABEL ?? 'manual-' + Date.now()
  writeTestTrace("echo-executor-024-core-trace", label, { isolation, cases: traces })
  assert.equal(isolation.networkAttempts, 0); cleanTmp()
})
test('actual service + actual say + real host: tool body only, pending render, single reply and persistent confirmation', async t => {
  const f = await coreHost(t, { script: normal, legacy: true })
  const receipt = await f.binding.inject(identity('roundtrip'))
  assert.equal(receipt.everAccepted, true)
  const reply = await f.reply()
  assert.equal(reply.text, 'synthetic selected reply')
  assert.equal(reply.sourceKey, receipt.sourceKey); assert.equal(reply.inboundKey, identity('roundtrip').inboundKey)
  assert.equal(f.h.ctx.agents.list().length, 1)
  assert.equal(f.oldCalls.length, 0); assert.deepEqual(f.oldAuto, [])
  assert.ok(f.rendered.some(r => r.value.deliveryStatus === 'pending_turn_end' && r.result[0].text.includes('尚未发出')))
  assert.equal(f.binding.canSendReply({ replyId: reply.replyId, claimKey: 'synthetic-claim' }), true)
  assert.equal((await f.binding.confirmReply({ replyId: reply.replyId, claimKey: 'synthetic-claim', outcome: 'confirmed' })).ok, true)
  assert.equal(f.binding.canSendReply({ replyId: reply.replyId, claimKey: 'synthetic-claim' }), false)
  const record = await f.store.read({ scopeKey: reply.scopeKey, inboundKey: reply.inboundKey })
  assert.equal(record.ownerText.outcome, 'confirmed')
})
test('only official binding registers say without enabling call or generic legacy route', async t => {
  const f = await coreHost(t, { script: normal })
  assert.deepEqual([...f.registered], ['echo_qq_say'])
  await f.binding.inject(identity('only')); await f.reply()
  assert.equal(f.oldCalls.length, 0)
})
test('status and binding authorization do not select or create companion sessions', async t => {
  const f = await coreHost(t, { bind: false })
  assert.equal(f.service.status().available, true); assert.equal(f.selections(), 0)
  await assert.rejects(f.service.openBinding({ scope: f.scope, authorization: { authorized: false }, metadataStore: f.store }), /authorization/)
  assert.equal(f.selections(), 0)
})
test('normal queued messages keep original target object and each gets its own completed reply', async t => {
  const f = await coreHost(t, { script: normal }), hold = gate()
  const maintenance = f.h.agent.runMaintenance(() => hold.promise)
  const a = await f.binding.inject(identity('queued-a')), b = await f.binding.inject(identity('queued-b'))
  hold.resolve(); await maintenance; await until(() => f.h.requests.length >= 4); await f.h.agent.whenIdle()
  let first, second
  await until(() => f.h.requests.length === 4)
  first = await f.reply('claim-a')
  await f.binding.confirmReply({ replyId: first.replyId, claimKey: 'claim-a', outcome: 'confirmed' })
  second = (await f.binding.takeReply({ claimKey: 'claim-b' })).reply
  assert.ok(second)
  assert.deepEqual([first.sourceKey, second.sourceKey], [a.sourceKey, b.sourceKey])
  assert.equal(f.h.ctx.agents.list().length, 1)
})
test('same accepted input duplicate is one work/receipt and one claimant', async t => {
  const f = await coreHost(t, { script: normal }), input = identity('duplicate')
  const a = await f.binding.inject(input), b = await f.binding.inject(input)
  assert.equal(b.duplicate, true); assert.deepEqual(a.receipt, b.receipt)
  const reply = await f.reply('claim-original')
  assert.deepEqual((await f.binding.takeReply({ claimKey: 'claim-original' })).reply, reply)
  assert.equal((await f.binding.takeReply({ claimKey: 'another-claim' })).reply, null)
  assert.equal(f.h.requests.length, 2)
})
for (const mode of ['no-tool', 'error', 'mixed', 'proactive']) test('no reply for ' + mode + ' source/turn', async t => {
  const script = mode === 'no-tool' ? () => response('ordinary body') : mode === 'error' ? async function * () { throw Error('synthetic error') } : normal
  const f = await coreHost(t, { script, legacy: true })
  if (mode === 'mixed') f.h.agent.inject(local('synthetic local mixed input'))
  if (mode === 'proactive') {
    const { createUserMessage } = await import('@deepseek-ai/dsh-llm')
    f.h.agent.inject(createUserMessage({ source: { kind: 'plugin:dsh-echo', form: 'care' }, content: [{ type: 'text', text: 'synthetic proactive' }] }))
  }
  await f.binding.inject(identity(mode)); await f.quiet()
  assert.equal((await f.binding.takeReply({ claimKey: 'no-reply-' + mode })).reply, null)
  assert.equal(f.oldCalls.length, 0)
})
test('long individual tool arguments fail explicitly instead of old slice', async t => {
  const f = await coreHost(t, { script: (_r, i) => i === 0 ? response('', [call(i, 'x'.repeat(501))]) : response() })
  await f.binding.inject(identity('long-tool')); await f.quiet()
  assert.equal((await f.binding.takeReply({ claimKey: 'long' })).reply, null)
  assert.ok(f.rendered.some(r => r.value.reason === 'official_tool_too_long'))
})
test('ordered tool intents merge as one reply and over-1500 aggregate is rejected whole', async t => {
  const f = await coreHost(t, { script: (_r, i) => i === 0 ? response('', [call('one', 'first'), call('two', 'second')]) : response() })
  await f.binding.inject(identity('merge'))
  assert.equal((await f.reply()).text, 'first\nsecond')
  const tooLong = await coreHost(t, { script: (_r, i) => i === 0 ? response('', [0, 1, 2, 3].map(n => call('long-' + n, 'x'.repeat(500)))) : response() })
  await tooLong.binding.inject(identity('long-merge')); await tooLong.quiet()
  assert.equal((await tooLong.binding.takeReply({ claimKey: 'long-merge' })).reply, null)
  assert.equal(tooLong.binding.status().reason, 'official_reply_too_long')
})
test('existing guard hold and mask remain in the official path', async t => {
  const held = await coreHost(t, { script: normal, guard: () => ({ ok: false, reason: 'synthetic hold', words: ['synthetic'] }) })
  await held.binding.inject(identity('held')); await held.quiet()
  assert.equal((await held.binding.takeReply({ claimKey: 'hold' })).reply, null)
  assert.ok(held.rendered.some(r => r.value.reason === 'guard-hold'))
  const masked = await coreHost(t, { script: normal, guard: () => ({ ok: true, text: 'masked synthetic', reason: 'mask' }) })
  await masked.binding.inject(identity('mask'))
  assert.equal((await masked.reply()).text, 'masked synthetic')
})
test('new accepted message revokes active old round before completed and leaves new queued source usable', async t => {
  const hold = gate(), entered = gate()
  const f = await coreHost(t, { script: async function * (_r, index) {
    if (index === 1) { entered.resolve(); await hold.promise; yield * response('old tail'); return }
    yield * (index % 2 === 0 ? response('', [call(index)]) : response('new tail'))
  } })
  const old = await f.binding.inject(identity('old-active')); await entered.promise
  const next = await f.binding.inject(identity('new-active')); hold.resolve()
  const reply = await f.reply('new-active')
  assert.equal(reply.sourceKey, next.sourceKey); assert.notEqual(reply.sourceKey, old.sourceKey)
})
test('new message, close and target invalidation synchronously revoke claimed sending eligibility', async t => {
  for (const action of ['message', 'close', 'target']) {
    const f = await coreHost(t, { script: normal })
    await f.binding.inject(identity('cancel-' + action)); const reply = await f.reply(action)
    assert.equal(f.binding.canSendReply({ replyId: reply.replyId, claimKey: action }), true)
    if (action === 'message') await f.binding.inject(identity('later-' + action))
    else if (action === 'close') void f.binding.close()
    else f.invalidate()
    assert.equal(f.binding.canSendReply({ replyId: reply.replyId, claimKey: action }), false)
  }
})
test('429 keeps original claim; confirmed/unknown terminal facts cannot be overwritten or resend', async t => {
  const f = await coreHost(t, { script: normal })
  await f.binding.inject(identity('confirmation')); const reply = await f.reply('retry')
  const args = { replyId: reply.replyId, claimKey: 'retry' }
  assert.equal((await f.binding.confirmReply({ ...args, outcome: 'rate_limited' })).ok, true)
  assert.equal(f.binding.canSendReply(args), true)
  assert.equal((await f.binding.confirmReply({ ...args, outcome: 'confirmed' })).ok, true)
  assert.equal((await f.binding.confirmReply({ ...args, outcome: 'rate_limited' })).ok, false)
  assert.equal(f.binding.canSendReply(args), false)
  assert.equal((await f.binding.confirmReply({ ...args, outcome: 'confirmed' })).replayed, true)
})
test('local/old platform say and call keep their old immediate tool result semantics', async t => {
  const f = await coreHost(t, { script: (_r, i) => i === 0 ? response('', [call('local', 'legacy local', 'echo_qq_call')]) : response(), legacy: true })
  f.h.agent.followup(local('synthetic local round')); await f.h.agent.whenIdle()
  assert.equal(f.oldCalls.length, 1); assert.equal(f.oldCalls[0].mode, 'call')
  assert.ok(f.rendered.some(r => r.result[0].text.includes('发出去了')))
})
test('lost confirmation response cannot let a later 429 overwrite persisted confirmed', async t => {
  const f = await coreHost(t, { script: normal })
  await f.binding.inject(identity('lost-confirmation')); const reply = await f.reply('lost')
  let lost = false
  f.store.afterCommit = ({ record }) => {
    if (!lost && record?.ownerText?.outcome === 'confirmed') { lost = true; throw Error('synthetic confirmation response lost after commit') }
  }
  const request = { replyId: reply.replyId, claimKey: 'lost' }
  await assert.rejects(f.binding.confirmReply({ ...request, outcome: 'confirmed' }), /storage/)
  assert.equal(f.binding.canSendReply(request), false)
  assert.equal((await f.binding.confirmReply({ ...request, outcome: 'rate_limited' })).ok, false)
  assert.equal((await f.store.read({ scopeKey: reply.scopeKey, inboundKey: reply.inboundKey })).ownerText.outcome, 'confirmed')
  const retried = await f.binding.confirmReply({ ...request, outcome: 'confirmed' })
  assert.equal(retried.ok, true); assert.equal(retried.replayed, true)
})
test('observed target invalidation permanently cancels old claim rather than thawing it on return', async t => {
  const f = await coreHost(t, { script: normal })
  await f.binding.inject(identity('sticky-target')); const reply = await f.reply('sticky')
  const request = { replyId: reply.replyId, claimKey: 'sticky' }
  f.invalidate(); assert.equal(f.binding.canSendReply(request), false)
  f.restoreTarget(); assert.equal(f.binding.canSendReply(request), false)
})
test('existing Echo scope denial stops official publication without creating another agent', async t => {
  const f = await coreHost(t, { script: normal, sessionAllowed: () => false })
  const result = await f.binding.inject(identity('scope-off'))
  assert.equal(result.everAccepted, false)
  await f.quiet()
  assert.equal(f.h.requests.length, 0); assert.equal(f.h.ctx.agents.list().length, 1)
})
test('service recreation cannot wash tracker identity guards on the same still-live agent', async t => {
  const f = await coreHost(t, { script: normal })
  await f.binding.inject(identity('before-service-recreate')); await f.reply()
  await f.owner.dispose()
  const { createOfficialOwnerText } = await import('../lib/official-owner-text.js')
  const { createUserMessage } = await import('@deepseek-ai/dsh-llm')
  const { MemoryMetadataStore } = await import('./fixtures/echo022-state.mjs')
  const recreated = createOfficialOwnerText({ resolveTarget: async () => ({ agent: f.h.agent, session: f.h.agent.session, isCurrent: () => true }),
    createMessage: createUserMessage, isEnabled: () => true, isSessionEnabled: () => true, supportsHost: () => true, allowMemoryMetadata: true })
  t.after(() => recreated.dispose())
  const binding = await recreated.service.openBinding({ scope: f.scope, authorization: { kind: 'local-explicit-owner', authorized: true,
    appId: f.scope.appId, ownerHash: f.scope.ownerHash }, metadataStore: new MemoryMetadataStore() })
  assert.equal((await binding.inject(identity('after-service-recreate'))).everAccepted, false)
  assert.equal(f.h.ctx.agents.list().length, 1)
})
