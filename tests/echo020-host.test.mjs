import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { writeTestTrace } from './fixtures/test-trace.mjs'
import { host, official, local, createUserMessage, response, traces, isolation, cleanTmp } from './fixtures/echo020-host.mjs'

after(() => {
  assert.equal(isolation.networkAttempts, 0)
  const label = process.env.ECHO020_RUN_LABEL ?? 'manual-' + Date.now()
  if (!/^[a-z0-9-]+$/.test(label)) throw Error('invalid_trace_label')
  writeTestTrace("echo-executor-020-host-trace", label, { kind: 'real installed host; memory-only fake adapter; synthetic inputs', isolation, cases: traces })
  cleanTmp()
})

test('real maintenance gate: followup only enqueues; ordinary inputs each get their actual turn', async t => {
  const h = await host(t), a = official('queue-a'), b = official('queue-b'), m = local('合成本地插入')
  const gate = Promise.withResolvers()
  const maintenance = h.agent.runMaintenance(() => gate.promise)
  h.follow(a); h.agent.followup(m); h.follow(b)
  assert.equal(h.tracker.sourceStatus(a.sourceKey).state, 'registered')
  assert.equal(h.trace.some(e => e.type === 'turn/start'), false)
  assert.equal(h.agent.inbox.nextTurn.length, 3)
  gate.resolve(); await maintenance; await h.agent.whenIdle()
  const turns = h.tracker.snapshot().turns
  assert.deepEqual(turns.map(x => x.inputs[0].messageId), [a.message.id, m.id, b.message.id])
  assert.deepEqual(turns.map(x => x.associationEligible), [true, false, true])
  assert.equal(new Set(turns.map(x => x.hostTurnUid)).size, 3)
  assert.deepEqual(h.rejectedObservations, [])
})

test('real next-step batch: two official messages in one actual turn are ambiguous', async t => {
  const h = await host(t), a = official('batch-a'), b = official('batch-b')
  assert.equal(h.tracker.registerSource(b).ok, true)
  h.agent.inject(b.message); h.follow(a)
  await h.agent.whenIdle()
  const turn = h.tracker.snapshot().turns[0]
  assert.equal(turn.inputs.length, 2)
  assert.deepEqual(turn.inputs.map(x => x.messageId), [b.message.id, a.message.id])
  assert.ok(turn.inputs.every(x => x.step === 1))
  assert.ok(turn.reasons.includes('ambiguous_inputs'))
  assert.equal(turn.associationEligible, false)
  assert.equal(h.requests.length, 1)
})

test('real final inputs: snapshot and runtime context do not impersonate human inputs', async t => {
  const h = await host(t), a = official('context')
  h.agent.inject(createUserMessage({ content: [{ type: 'text', text: '合成快照' }], source: { kind: 'plugin:dsh-echo', form: 'snapshot' } }))
  h.agent.inject(createUserMessage({ content: [{ type: 'text', text: '合成运行上下文' }], source: { kind: 'runtime-context' } }))
  h.follow(a); await h.agent.whenIdle()
  assert.deepEqual(h.tracker.snapshot().turns[0].inputs.map(x => x.kind), ['context', 'context', 'official'])
  assert.equal(h.tracker.snapshot().turns[0].associationEligible, true)
})

test('real pre-step rejection: claimed never becomes entered', async t => {
  const h = await host(t, { preStep: async () => ({ kind: 'reject' }) }), a = official('reject')
  h.follow(a); await h.agent.whenIdle()
  assert.equal(h.tracker.sourceStatus(a.sourceKey).state, 'not_entered')
  const turn = h.tracker.snapshot().turns[0]
  assert.equal(turn.claims.length, 1); assert.equal(turn.inputs.length, 0)
  assert.equal(turn.endReason, 'blocked'); assert.equal(turn.associationEligible, false)
  assert.equal(h.requests.length, 0)
})

test('real pre-step replacement: similar source with fresh id cannot claim original ownership', async t => {
  const a = official('replace')
  const replacement = createUserMessage({ content: a.message.content, source: a.message.source })
  const h = await host(t, { preStep: async () => ({ kind: 'enter', messages: [replacement] }) })
  h.follow(a); await h.agent.whenIdle()
  assert.notEqual(replacement.id, a.message.id)
  assert.equal(h.tracker.sourceStatus(a.sourceKey).state, 'not_entered')
  const turn = h.tracker.snapshot().turns[0]
  assert.equal(turn.inputs[0].kind, 'untrusted_official')
  assert.equal(turn.associationEligible, false)
  assert.deepEqual(h.requests[0].messageIds.filter(id => id === replacement.id || id === a.message.id), [replacement.id])
})

test('real prepareCall failure: open step and claim do not imply user/message', async t => {
  const h = await host(t, { resolveModel: async () => { throw Error('synthetic prepare failure') } }), a = official('prepare')
  h.follow(a); await h.agent.whenIdle()
  const turn = h.tracker.snapshot().turns[0]
  assert.equal(turn.steps, 1); assert.equal(turn.inputs.length, 0)
  assert.equal(turn.endReason, 'error'); assert.equal(turn.associationEligible, false)
  assert.equal(h.trace.some(e => e.type === 'user/message'), false)
  assert.equal(h.requests.length, 0)
})

test('real cancellation in user append observer: entered, then buildRequest never dispatches adapter', async t => {
  const h = await host(t, { onEvent: (e, agent) => { if (e.type === 'user/message') agent.cancel({ kind: 'user' }) } }), a = official('post-append')
  h.follow(a); await h.agent.whenIdle()
  const turn = h.tracker.snapshot().turns[0]
  assert.equal(turn.inputs[0].messageId, a.message.id)
  assert.equal(turn.endReason, 'aborted'); assert.equal(turn.associationEligible, false)
  assert.equal(h.requests.length, 0)
  assert.ok(h.trace.findIndex(e => e.type === 'user/message') < h.trace.findIndex(e => e.type === 'turn/end'))
})

test('real stream failure after input commit: entered is not successful processing', async t => {
  const h = await host(t, { script: async function * () { throw Error('synthetic stream failure') } }), a = official('stream-error')
  h.follow(a); await h.agent.whenIdle()
  const turn = h.tracker.snapshot().turns[0]
  assert.equal(turn.inputs.length, 1); assert.equal(turn.endReason, 'error')
  assert.equal(turn.associationEligible, false); assert.equal(h.requests.length, 1)
  assert.ok(h.trace.findIndex(e => e.type === 'user/message') < h.trace.findIndex(e => e.type === 'fake/stream'))
})

test('real empty turn and empty assistant are distinct observations', async t => {
  const empty = await host(t, { preStep: async () => ({ kind: 'enter', messages: [] }) })
  empty.follow(official('empty-turn')); await empty.agent.whenIdle()
  assert.equal(empty.tracker.snapshot().turns[0].steps, 0)
  assert.equal(empty.tracker.snapshot().turns[0].associationEligible, false)
  const reply = await host(t, { script: () => response('', [], 'stop') })
  reply.follow(official('empty-reply')); await reply.agent.whenIdle()
  const turn = reply.tracker.snapshot().turns[0]
  assert.equal(turn.endReason, 'completed')
  assert.equal(turn.assistantMessages, 1)
  assert.equal(turn.associationEligible, true) // association only; no output/delivery conclusion
  assert.equal(turn.deliveryAuthorized, false)
})

test('real max-tokens never releases completed association eligibility', async t => {
  const h = await host(t, { script: () => response('合成截断前缀', [], 'max-tokens') })
  h.follow(official('max')); await h.agent.whenIdle()
  assert.equal(h.tracker.snapshot().turns[0].endReason, 'max-tokens')
  assert.equal(h.tracker.snapshot().turns[0].associationEligible, false)
})

test('real midstream abort records interrupted prefix and closes eligibility', async t => {
  const h = await host(t, { script: async function * (request) {
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: '合成中断前缀' }
    h.agent.cancel({ kind: 'user' })
    request.signal.throwIfAborted()
  } })
  h.follow(official('abort')); await h.agent.whenIdle()
  const turn = h.tracker.snapshot().turns[0]
  assert.equal(turn.endReason, 'aborted'); assert.ok(turn.reasons.includes('interrupted'))
  assert.equal(turn.associationEligible, false)
  assert.equal(h.trace.some(e => e.type === 'assistant/message' && e.interrupted), true)
})

test('real parallel tool bodies resolve published roots, same actual exec and model order', { timeout: 5000 }, async t => {
  let started = 0, simultaneous = 0
  const release = Promise.withResolvers(), seen = []
  const execute = async exec => { seen.push(exec); started++; simultaneous = Math.max(simultaneous, started); if (started === 2) release.resolve(); await release.promise; started-- }
  const h = await host(t, { tools: [{ name: 'alpha', execute }, { name: 'beta', execute }], script: (_r, index) => index === 0 ? response('', [{ id: 'root-a', name: 'alpha' }, { id: 'root-b', name: 'beta' }]) : response('合成尾声') })
  h.follow(official('tools')); await h.agent.whenIdle()
  assert.equal(simultaneous, 2)
  assert.deepEqual(h.executions.map(x => x.resolution.ok), [true, true])
  assert.deepEqual(h.executions.map(x => x.resolution.order), [0, 1])
  assert.ok(h.executions.every(x => x.rootCallId === x.callId && !x.hasTurn && !x.hasStep && x.resolution.provisional && !x.resolution.deliveryAuthorized))
  assert.equal(h.trace.filter(e => e.type === 'assistant/message').length, 2)
  assert.ok(h.trace.findIndex(e => e.type === 'assistant/message') < h.trace.findIndex(e => e.type === 'fake/tool-body'))
  assert.equal(h.tracker.snapshot().turns[0].associationEligible, true)
  assert.equal(h.tracker.resolveToolCall(seen[0]).reason, 'no_live_step')
  assert.deepEqual(h.rejectedObservations, [])
})

test('real steering during a tool enters next step of same turn and invalidates prior provisional association', async t => {
  const m = local('合成同轮插话')
  const h = await host(t, { tools: [{ name: 'steering', execute: (_exec, state) => state.agent.steer(m) }], script: (_r, index) => index === 0 ? response('', [{ id: 'root-steer', name: 'steering' }]) : response('合成第二步') })
  h.follow(official('steering')); await h.agent.whenIdle()
  const turn = h.tracker.snapshot().turns[0]
  assert.equal(turn.steps, 2)
  assert.deepEqual(turn.inputs.map(x => [x.kind, x.step]), [['official', 1], ['local_human', 2]])
  assert.equal(h.executions[0].resolution.ok, true)
  assert.equal(turn.associationEligible, false)
})

test('real proactive context in admitted batch closes passive qualification', async t => {
  const h = await host(t)
  h.agent.inject(createUserMessage({ content: [{ type: 'text', text: '合成提醒' }], source: { kind: 'plugin:dsh-echo', form: 'reminder' } }))
  h.follow(official('proactive')); await h.agent.whenIdle()
  assert.ok(h.tracker.snapshot().turns[0].reasons.includes('proactive_input'))
  assert.equal(h.tracker.snapshot().turns[0].associationEligible, false)
})

test('real seeded factory create does not replay historical session/event into new tracker', async t => {
  const first = await host(t, { sid: 'echo020-restart' })
  first.follow(official('before-restart')); await first.agent.whenIdle()
  const oldUid = first.tracker.snapshot().turns[0].hostTurnUid
  const restored = await host(t, { sid: 'echo020-restart', seed: first.seed() })
  assert.equal(restored.trace.length, 0)
  assert.equal(restored.tracker.snapshot().turns.length, 0)
  restored.follow(official('after-restart')); await restored.agent.whenIdle()
  assert.equal(restored.tracker.snapshot().turns.length, 1)
  assert.equal(restored.tracker.snapshot().turns[0].associationEligible, true)
  assert.notEqual(restored.tracker.snapshot().turns[0].hostTurnUid, oldUid)
  assert.equal(restored.tracker.snapshot().turns[0].turn, 2)
})

test('real public PTC presentation fails closed without ptcRuntime; nested execution remains unverified', async t => {
  const h = await host(t)
  assert.equal(h.ctx.get('ptcRuntime'), undefined)
  h.agent.ctx.tools.presentAs('ptc')
  h.follow(official('ptc-unavailable')); await h.agent.whenIdle()
  const turn = h.tracker.snapshot().turns[0]
  assert.equal(turn.endReason, 'error'); assert.equal(turn.inputs.length, 0)
  assert.equal(turn.associationEligible, false); assert.equal(h.executions.length, 0)
  assert.match(h.trace.find(e => e.type === 'turn/end').error.message, /ptcRuntime/)
})

test('real separate host instances with identical sid and root call id cannot resolve each other', { timeout: 5000 }, async t => {
  const gate = Promise.withResolvers(), execs = []
  const options = { sid: 'echo020-collision', tools: [{ name: 'shared', execute: async (exec, state) => {
    execs.push({ exec, state })
    if (execs.length === 2) gate.resolve()
    await gate.promise
    const other = execs.find(item => item.exec !== exec)
    assert.equal(state.tracker.resolveToolCall(exec).ok, true)
    assert.equal(state.tracker.resolveToolCall(other.exec).reason, 'wrong_instance')
  } }], script: (_r, index) => index === 0 ? response('', [{ id: 'same-root', name: 'shared' }]) : response() }
  const a = await host(t, options), b = await host(t, options)
  a.follow(official('collision-a')); b.follow(official('collision-b'))
  await Promise.all([a.agent.whenIdle(), b.agent.whenIdle()])
  assert.equal(execs.length, 2)
  assert.notEqual(a.agent, b.agent); assert.notEqual(a.agent.session, b.agent.session)
  assert.equal(a.tracker.snapshot().turns[0].associationEligible, true)
  assert.equal(b.tracker.snapshot().turns[0].associationEligible, true)
})

test('real revoke during actual tool closes capability while continuing to observe final reason', async t => {
  const h = await host(t, { tools: [{ name: 'revoker', execute: (exec, state) => {
    state.tracker.revoke()
    assert.equal(state.tracker.resolveToolCall(exec).reason, 'revoked')
  } }], script: (_r, index) => index === 0 ? response('', [{ id: 'revoke-root', name: 'revoker' }]) : response() })
  h.follow(official('revoke')); await h.agent.whenIdle()
  const result = h.tracker.snapshot()
  assert.equal(result.revoked, true)
  assert.equal(result.turns[0].endReason, 'completed')
  assert.equal(result.turns[0].associationEligible, false)
  assert.ok(result.turns[0].reasons.includes('revoked'))
})

test('real repeated provider callId in later turn rejects old exec rather than reassigning it', async t => {
  const captured = []
  const h = await host(t, { tools: [{ name: 'reused', execute: exec => captured.push(exec) }], script: (_r, index) => index % 2 === 0 ? response('', [{ id: 'provider-reused-id', name: 'reused' }]) : response() })
  h.follow(official('root-reuse-a')); await h.agent.whenIdle()
  h.follow(official('root-reuse-b')); await h.agent.whenIdle()
  const turns = h.tracker.snapshot().turns
  assert.deepEqual(turns.map(x => x.associationEligible), [true, false])
  assert.deepEqual(h.executions.map(x => x.resolution.ok), [true, false])
  assert.ok(turns[1].reasons.includes('root_identity_conflict'))
  assert.equal(h.tracker.resolveToolCall(captured[0]).ok, false)
})

test('real public factory: stable message id, candidate claim, entered and completed', async t => {
  const h = await host(t), input = official()
  assert.ok(Object.isFrozen(input.message))
  assert.equal(h.tracker.registerSource(input).ok, true)
  assert.equal(h.tracker.registerSource(input).duplicate, true)
  h.agent.followup(input.message)
  await h.agent.whenIdle()
  assert.equal(h.tracker.sourceStatus(input.sourceKey).state, 'turn_closed')
  assert.equal(h.tracker.snapshot().turns[0].associationEligible, true)
  assert.equal(h.tracker.snapshot().turns[0].inputs[0].messageId, input.message.id)
  assert.equal(h.trace.find(e => e.type === 'agent/inbox/claimed').state, 'claimed')
  assert.equal(h.trace.find(e => e.type === 'user/message').userHasTurn, false)
  assert.ok(h.requests[0].messageIds.includes(input.message.id))
  assert.deepEqual(h.rejectedObservations, [])
})
