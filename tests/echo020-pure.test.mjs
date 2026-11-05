import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createOfficialTurnTracker } from '../lib/official-turns.js'

// These are deliberately synthetic malformed-event tests, NOT host integration.
function frozen (v) { if (v && typeof v === 'object') { Object.values(v).forEach(frozen); Object.freeze(v) }; return v }
function source (id = 'a', text = 'synthetic') {
  const ref = { sourceKey: 'src-' + id, inboundKey: 'in-' + id, scopeKey: 'scope' }
  return { ...ref, message: frozen({ id: 'msg-' + id, role: 'user', content: [{ type: 'text', text }], source: { kind: 'plugin:dsh-echo', form: 'relay', platform: 'qq-official', replyContext: ref } }) }
}
function fixture (options = {}) {
  const session = { id: 'same-sid' }, agent = { session }
  const tracker = createOfficialTurnTracker({ agent, session, bootEpoch: 'boot-a', agentEpoch: 'agent-a', liveFromSeq: 0, ...options })
  let seq = options.liveFromSeq ?? 0
  let turn = 1, step = 1
  const event = (type, data, extra = {}) => tracker.observeSessionEvent({ agent, session, event: { type, data, seq: seq++, ...extra } })
  const claim = s => tracker.observeClaim({ agent, session, turn, message: s.message })
  const start = () => event('turn/start', { turn })
  const enter = (s = source()) => { assert.equal(tracker.registerSource(s).ok, true); start(); claim(s); event('step/start', { turn, step }); return event('user/message', s.message, { surfaceOp: 'append' }) }
  const assistant = (calls = [], extra = {}) => event('assistant/message', { turn, step, message: { id: 'assistant', role: 'assistant', source: { provider: 'fake', model: 'fake' }, content: calls }, ...extra }, { surfaceOp: 'append' })
  const end = (reason = 'completed') => { event('step/end', { turn, step }); return event('turn/end', { turn, reason: { kind: reason } }) }
  const exec = (id = 'call-a', extra = {}) => ({ agent, callId: id, rootCallId: id, name: 'fake', signal: new AbortController().signal, ...extra })
  return { tracker, agent, session, event, claim, start, enter, assistant, end, exec, nextTurn: () => { turn++; step = 1 }, nextStep: () => { step++ } }
}
const root = (id = 'call-a') => ({ type: 'tool-call', id, name: 'fake', arguments: '{}' })
const denied = f => {
  const s = f.tracker.snapshot()
  assert.equal(s.current?.associationEligible ?? false, false)
  assert.equal(s.turns.some(t => t.associationEligible), false)
}

test('pure: configuration requires exact instances, explicit next seq and unique epoch labels', () => {
  assert.throws(() => createOfficialTurnTracker({}), /invalid_tracker_identity/)
  const session = { id: 's' }, agent = { session }
  assert.throws(() => createOfficialTurnTracker({ agent, session, bootEpoch: 'b', agentEpoch: 'a', liveFromSeq: 0, limits: { sources: 10000 } }), /invalid_tracker_limits/)
})
test('pure: mutable messages and untrusted context cannot register', () => {
  const f = fixture(), s = source()
  assert.equal(f.tracker.registerSource({ ...s, message: structuredClone(s.message) }).reason, 'invalid_source_registration')
  assert.equal(f.tracker.registerSource({ ...s, sourceKey: 'forged' }).reason, 'source_context_mismatch')
  assert.equal(f.tracker.snapshot().registeredSources, 0)
})
test('pure: trusted registration and full content/source fingerprint are both required', () => {
  const f = fixture(), s = source(), changed = frozen({ ...structuredClone(s.message), content: [{ type: 'text', text: 'changed' }] })
  f.tracker.registerSource(s); f.start(); f.claim(s); f.event('step/start', { turn: 1, step: 1 })
  assert.equal(f.event('user/message', changed, { surfaceOp: 'append' }).reason, 'source_enter_conflict')
  f.end(); denied(f)
})
test('pure: same source key or original key cannot acquire a fresh message id', () => {
  const f = fixture(), s = source()
  f.tracker.registerSource(s)
  const message = frozen({ ...structuredClone(s.message), id: 'another-id' })
  assert.equal(f.tracker.registerSource({ ...s, message }).reason, 'source_identity_conflict')
  assert.equal(f.tracker.snapshot().registeredSources, 1)
})
test('pure: identical registration is idempotent, changed source under same id is refused', () => {
  const f = fixture(), s = source()
  assert.equal(f.tracker.registerSource(s).duplicate, false)
  assert.equal(f.tracker.registerSource(s).duplicate, true)
  const message = frozen({ ...structuredClone(s.message), source: { ...structuredClone(s.message.source), rawText: 'changed' } })
  assert.equal(f.tracker.registerSource({ ...s, message }).reason, 'source_identity_conflict')
})
test('pure: matching user/message without candidate claim is refused', () => {
  const f = fixture(), s = source()
  f.tracker.registerSource(s); f.start(); f.event('step/start', { turn: 1, step: 1 })
  assert.equal(f.event('user/message', s.message, { surfaceOp: 'append' }).reason, 'source_enter_conflict')
  f.end(); denied(f)
})
for (const kind of ['local_human', 'other_human', 'unknown_input', 'untrusted_official', 'proactive']) test('pure: complete final input set rejects ' + kind, () => {
  const f = fixture(); f.enter()
  const sources = { local_human: { kind: 'user' }, other_human: { kind: 'plugin:dsh-echo', form: 'relay', platform: 'qq' }, unknown_input: { kind: 'plugin:unknown' }, untrusted_official: { kind: 'plugin:dsh-echo', form: 'relay', platform: 'qq-official' }, proactive: { kind: 'plugin:dsh-echo', form: 'care' } }
  f.event('user/message', { id: 'additional', role: 'user', source: sources[kind], content: [] }, { surfaceOp: 'append' })
  const result = f.end().turn
  assert.equal(result.inputs.length, 2); assert.equal(result.inputs[1].kind, kind); denied(f)
})
for (const reason of ['blocked', 'error', 'aborted', 'max-tokens', 'interrupted', 'forked', 'unknown']) test('pure: final reason ' + reason + ' does not qualify', () => {
  const f = fixture(); f.enter(); const result = f.end(reason).turn
  assert.equal(result.endReason, reason); denied(f)
})
test('pure: completed alone has no delivery, persistence or no-loss promise', () => {
  const f = fixture(); f.enter(); f.assistant(); const result = f.end().turn
  assert.equal(result.associationEligible, true)
  assert.equal(result.deliveryAuthorized, false); assert.equal(result.persisted, false)
})
test('pure: interrupted assistant remains ineligible even if malformed closer says completed', () => {
  const f = fixture(); f.enter(); f.assistant([], { interrupted: true }); f.end(); denied(f)
})
for (const mode of ['no-turn', 'no-step', 'duplicate-start', 'duplicate-step', 'wrong-step-end', 'wrong-turn-end', 'assistant-wrong-turn', 'assistant-no-step', 'duplicate-end', 'gap', 'out-of-order', 'replacement', 'user-after-assistant']) test('pure malformed boundary: ' + mode, () => {
  const f = fixture(), s = source()
  if (mode === 'no-turn') f.event('user/message', s.message, { surfaceOp: 'append' })
  else if (mode === 'no-step') { f.tracker.registerSource(s); f.start(); f.claim(s); f.event('user/message', s.message, { surfaceOp: 'append' }) }
  else {
    f.enter(s)
    if (mode === 'duplicate-start') f.start()
    if (mode === 'duplicate-step') f.event('step/start', { turn: 1, step: 1 })
    if (mode === 'wrong-step-end') f.event('step/end', { turn: 1, step: 2 })
    if (mode === 'wrong-turn-end') { f.event('step/end', { turn: 1, step: 1 }); f.event('turn/end', { turn: 2, reason: { kind: 'completed' } }) }
    if (mode === 'assistant-wrong-turn') f.assistant([], { turn: 2 })
    if (mode === 'assistant-no-step') { f.event('step/end', { turn: 1, step: 1 }); f.assistant() }
    if (mode === 'duplicate-end') { f.end(); f.event('turn/end', { turn: 1, reason: { kind: 'completed' } }) }
    if (mode === 'gap') f.event('irrelevant', {}, { seq: 100 })
    if (mode === 'out-of-order') f.event('irrelevant', {}, { seq: 0 })
    if (mode === 'replacement') f.event('user/message', s.message, { surfaceOp: 'replace' })
    if (mode === 'user-after-assistant') { f.assistant(); f.event('user/message', source('later').message, { surfaceOp: 'append' }) }
  }
  denied(f)
})
test('pure: source registration plus candidate are not actual admission', () => {
  const f = fixture(), s = source()
  f.tracker.registerSource(s); f.start(); f.claim(s)
  assert.equal(f.tracker.sourceStatus(s.sourceKey).state, 'claimed')
  const result = f.event('turn/end', { turn: 1, reason: { kind: 'blocked' } }).turn
  assert.equal(result.inputs.length, 0); assert.equal(result.claims.length, 1)
  assert.equal(f.tracker.sourceStatus(s.sourceKey).state, 'not_entered')
})
test('pure: wrong instances with same ids and epochs never mutate current association', () => {
  const f = fixture(); f.enter(); f.assistant([root()])
  const session = { id: f.session.id }, agent = { session }
  assert.equal(f.tracker.observeSessionEvent({ agent, session, event: { seq: 99, type: 'turn/end' } }).reason, 'wrong_instance')
  assert.equal(f.tracker.observeClaim({ agent, session, turn: 1, message: source().message }).reason, 'wrong_instance')
  assert.equal(f.tracker.resolveToolCall(f.exec('call-a', { agent })).reason, 'wrong_instance')
  assert.equal(f.tracker.resolveToolCall(f.exec()).ok, true)
  assert.equal(f.end().turn.associationEligible, true)
})
test('pure: valid roots resolve only after publication and within their step', () => {
  const f = fixture(); f.enter()
  assert.equal(f.tracker.resolveToolCall(f.exec()).reason, 'unpublished_root')
  f.assistant([root()])
  assert.equal(f.tracker.resolveToolCall(f.exec()).ok, true)
  assert.equal(f.tracker.resolveToolCall(f.exec('call-a', { name: 'different' })).reason, 'unpublished_root')
  f.event('step/end', { turn: 1, step: 1 }); f.nextStep(); f.event('step/start', { turn: 1, step: 2 })
  assert.equal(f.tracker.resolveToolCall(f.exec()).reason, 'unpublished_root')
})
test('pure: unknown nested/PTC propagation and canceled signals fail closed', () => {
  const f = fixture(); f.enter(); f.assistant([root()])
  assert.equal(f.tracker.resolveToolCall(f.exec('child', { rootCallId: 'call-a' })).reason, 'nested_unverified')
  const ac = new AbortController(); ac.abort()
  assert.equal(f.tracker.resolveToolCall(f.exec('call-a', { signal: ac.signal })).reason, 'canceled_or_missing_signal')
  assert.equal(f.tracker.resolveToolCall(f.exec('call-a', { signal: undefined })).reason, 'canceled_or_missing_signal')
  assert.equal(f.tracker.resolveToolCall(f.exec('call-a', { rootCallId: 'unknown' })).reason, 'nested_unverified')
})
test('pure: root collision, duplicate inputs and duplicate claims close qualification', () => {
  const roots = fixture(); roots.enter(); roots.assistant([root(), root()]); roots.end(); denied(roots)
  const inputs = fixture(), s = source(); inputs.enter(s); inputs.event('user/message', s.message, { surfaceOp: 'append' }); inputs.end(); denied(inputs)
  const claims = fixture(); claims.tracker.registerSource(s); claims.start(); claims.claim(s); assert.equal(claims.claim(s).reason, 'duplicate_claim')
})
test('pure: revoke and turn close prevent late tool resolution and resurrection', () => {
  const closed = fixture(); closed.enter(); closed.assistant([root()]); closed.end()
  assert.equal(closed.tracker.resolveToolCall(closed.exec()).reason, 'no_live_step')
  const revoked = fixture(); revoked.enter(); revoked.assistant([root()]); revoked.tracker.revoke()
  assert.equal(revoked.tracker.resolveToolCall(revoked.exec()).reason, 'revoked')
  assert.equal(revoked.end().turn.endReason, 'completed'); denied(revoked)
  assert.equal(revoked.tracker.registerSource(source('later')).reason, 'revoked')
})
test('pure: history seq below explicit live watermark is never replayed as live', () => {
  const f = fixture({ liveFromSeq: 50 })
  assert.equal(f.event('turn/start', { turn: 1 }, { seq: 0 }).reason, 'historical_event')
  assert.equal(f.tracker.snapshot().current, null)
  assert.equal(f.tracker.snapshot().integrityLost, false)
})
test('pure: new boot/agent generations cannot share a host turn identity', () => {
  const a = fixture(), b = fixture({ bootEpoch: 'boot-b' }), c = fixture({ agentEpoch: 'agent-b' })
  for (const f of [a, b, c]) f.enter()
  assert.equal(new Set([a, b, c].map(f => f.tracker.snapshot().current.hostTurnUid)).size, 3)
})
test('pure: source capacity keeps replay guards and disables qualification, never silently evicts', () => {
  const f = fixture({ limits: { sources: 1 } }); f.enter()
  assert.equal(f.tracker.registerSource(source('overflow')).reason, 'source_capacity')
  assert.equal(f.tracker.snapshot().registeredSources, 1); f.end(); denied(f)
})
test('pure: message byte capacity rejects instead of truncating to complete', () => {
  const f = fixture({ limits: { messageBytes: 500 } })
  assert.equal(f.tracker.registerSource(source('long', 'x'.repeat(1000))).reason, 'message_capacity')
  assert.equal(f.tracker.snapshot().registeredSources, 0); denied(f)
})
test('pure: input, root and whole-turn bounds cannot become eligible partial summaries', () => {
  const inputs = fixture({ limits: { inputs: 1 } }); inputs.enter(); inputs.event('user/message', source('extra').message, { surfaceOp: 'append' }); inputs.end(); denied(inputs)
  const roots = fixture({ limits: { roots: 1 } }); roots.enter(); roots.assistant([root('one'), root('two')]); roots.end(); denied(roots)
  const bytes = fixture({ limits: { turnBytes: 1 } }); bytes.enter(); bytes.end(); denied(bytes)
})
test('pure: recent turn summaries are bounded while source identity guards remain', () => {
  const f = fixture({ limits: { turns: 2 } })
  for (let i = 0; i < 3; i++) { f.enter(source('ring-' + i)); f.end(); f.nextTurn() }
  assert.equal(f.tracker.snapshot().turns.length, 2)
  assert.equal(f.tracker.snapshot().registeredSources, 3)
  assert.equal(f.tracker.sourceStatus('src-ring-0').state, 'turn_closed')
  const external = f.tracker.snapshot(); external.turns[0].inputs[0].kind = 'forged'
  assert.equal(f.tracker.snapshot().turns[0].inputs[0].kind, 'official')
})
test('pure: malformed observations are contained, not thrown into old callers', () => {
  const f = fixture()
  assert.doesNotThrow(() => f.tracker.observeSessionEvent({ agent: f.agent, session: f.session, event: null }))
  assert.equal(f.tracker.observeClaim(null).reason, 'wrong_instance')
  assert.equal(f.tracker.resolveToolCall(null).reason, 'wrong_instance')
})

test('pure regression: reused callId in a later turn cannot capture a late prior exec', () => {
  const f = fixture(); f.enter(source('first')); f.assistant([root()])
  const late = f.exec()
  assert.equal(f.tracker.resolveToolCall(late).ok, true)
  f.end(); f.nextTurn(); f.enter(source('second')); f.assistant([root()])
  assert.equal(f.tracker.resolveToolCall(late).ok, false)
  assert.ok(f.tracker.snapshot().current.reasons.includes('root_identity_conflict'))
})

test('pure: bounded root tombstones survive recent-turn eviction and fail closed when full', () => {
  const f = fixture({ limits: { turns: 1, rootIdentities: 1 } })
  f.enter(source('one')); f.assistant([root('old-root')]); f.end(); f.nextTurn()
  f.enter(source('two')); f.assistant([root('new-root')]); f.end()
  assert.equal(f.tracker.snapshot().turns.length, 1)
  assert.equal(f.tracker.snapshot().rootIdentities, 1)
  assert.equal(f.tracker.snapshot().integrityLost, true)
  denied(f)
})
