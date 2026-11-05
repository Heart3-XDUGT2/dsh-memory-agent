import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { writeTestTrace } from './fixtures/test-trace.mjs'
import { host, official, response, traces, isolation, cleanTmp } from './fixtures/echo020-host.mjs'
const { createDeveloperMessage, createSystemMessage } = await import('@deepseek-ai/dsh-llm')
const { createOfficialTurnTracker } = await import('../lib/official-turns.js')

after(() => {
  assert.equal(isolation.networkAttempts, 0)
  const label = process.env.ECHO020_RUN_LABEL ?? 'manual-' + Date.now()
  if (!/^[a-z0-9-]+$/.test(label)) throw Error('invalid_trace_label')
  writeTestTrace("echo-executor-020-r1-trace", label, { kind: 'real installed host; synthetic replacement cases; pure malformed cases separately named', isolation, cases: traces })
  cleanTmp()
})

async function replacementCase (t, label, replace) {
  const input = official('r1-' + label)
  const observed = { replacements: [], before: null, after: null, exec: null }
  const h = await host(t, { tools: [{ name: 'surface_change', execute: (exec, state) => {
    observed.exec = exec
    observed.before = state.tracker.resolveToolCall(exec)
    const session = state.agent.session
    const append = (kind, startSeq, endSeq = startSeq, extra = {}) => {
      const target = session.eventAt(startSeq)
      const source = extra.source ?? target?.data?.message?.source ?? { kind: 'plugin:echo020-r1' }
      const message = (kind === 'system/message' ? createSystemMessage : createDeveloperMessage)({
        content: [{ type: 'text', text: 'synthetic replacement ' + label }], source
      })
      const sources = extra.sources ?? session.surface.nodes.slice(session.surface.nodes.indexOf(startSeq), session.surface.nodes.indexOf(endSeq) + 1)
      const event = session.append(kind, { turn: 1, step: 1, message }, { surfaceOp: { op: 'replace', startSeq, endSeq }, sourceEventSeqs: sources })
      observed.replacements.push({ seq: event.seq, type: event.type, surfaceOp: event.surfaceOp, sourceEventSeqs: event.sourceEventSeqs, nodesAfter: [...session.surface.nodes] })
      return event
    }
    replace({ state, session, input, append, observed })
    observed.after = state.tracker.resolveToolCall(exec)
  } }], script: (_req, index) => index === 0 ? response('', [{ id: 'root-' + label, name: 'surface_change' }]) : response('synthetic final answer') })
  h.follow(input); await h.agent.whenIdle()
  return { h, input, observed, turn: h.tracker.snapshot().turns[0] }
}
const inputSeq = (s, input) => s.snapshotEvents(0).find(e => e.type === 'user/message' && e.data.id === input.message.id).seq
const rootSeq = s => s.snapshotEvents(0).find(e => e.type === 'assistant/message').seq
function checkRejected (r, reason) {
  assert.equal(r.observed.replacements.length > 0, true, 'replacement must be accepted by real Session')
  assert.equal(r.h.requests.length, 2, 'real model loop must reach second request')
  assert.equal(r.observed.before.ok, true)
  assert.equal(r.observed.after.ok, false, 'previous provisional association must close immediately')
  assert.equal(r.turn.associationEligible, false)
  assert.ok(r.turn.reasons.includes(reason), JSON.stringify(r.turn.reasons))
  assert.equal(r.h.tracker.resolveToolCall(r.observed.exec).ok, false)
}

for (const kind of ['developer/message', 'system/message']) test('real R1: ' + kind + ' object replacement covering official input closes qualification', async t => {
  const r = await replacementCase(t, kind.split('/')[0] + '-input', ({ session, input, append }) => append(kind, inputSeq(session, input), undefined, { source: { kind: 'plugin:echo020-r1' } }))
  assert.equal(r.h.requests[0].messageIds.includes(r.input.message.id), true)
  assert.equal(r.h.requests[1].messageIds.includes(r.input.message.id), false)
  checkRejected(r, 'surface_input_replaced')
})

test('real R1: replacement removing assistant root closes actual exec and final qualification', async t => {
  const r = await replacementCase(t, 'root', ({ session, append }) => append('developer/message', rootSeq(session), undefined, { source: { kind: 'plugin:echo020-r1' } }))
  checkRejected(r, 'surface_root_replaced')
  assert.equal(r.h.requests[1].messageIds.includes(r.h.agent.session.eventAt(rootSeq(r.h.agent.session)).data.message.id), false)
})

test('real R1: mixed input/assistant range cannot retain qualification', async t => {
  const r = await replacementCase(t, 'mixed', ({ session, input, append }) => append('developer/message', inputSeq(session, input), rootSeq(session), { source: { kind: 'plugin:echo020-r1' } }))
  checkRejected(r, 'surface_input_replaced')
  assert.equal(r.h.requests[1].messageIds.includes(r.input.message.id), false)
})

for (const kind of ['developer/message', 'system/message']) test('real R1: provable own single-node ' + kind + ' update preserves normal multistep qualification', async t => {
  const r = await replacementCase(t, kind.split('/')[0] + '-self', ({ session, append }) => {
    let seq
    if (kind === 'system/message') seq = session.surface.nodes[0]
    else {
      const own = session.append(kind, { turn: 1, step: 1, message: createDeveloperMessage({ content: [{ type: 'text', text: 'synthetic own developer prompt' }], source: { kind: 'plugin:echo020-r1' } }) }, { surfaceOp: 'append' })
      seq = own.seq
    }
    append(kind, seq)
  })
  assert.equal(r.observed.replacements.length, 1)
  assert.equal(r.observed.after.ok, true)
  assert.equal(r.h.requests.length, 2)
  assert.equal(r.h.requests[1].messageIds.includes(r.input.message.id), true)
  assert.equal(r.turn.associationEligible, true)
  assert.deepEqual(r.turn.reasons, [])
  assert.deepEqual(r.h.rejectedObservations, [])
})

test('real R1: a cited input outside actual self-prompt replacement is not treated as removed', async t => {
  const r = await replacementCase(t, 'citation', ({ session, input, append }) => {
    const own = session.append('developer/message', { turn: 1, step: 1, message: createDeveloperMessage({ content: [{ type: 'text', text: 'synthetic cited prompt' }], source: { kind: 'plugin:echo020-r1' } }) }, { surfaceOp: 'append' })
    append('developer/message', own.seq, undefined, { sources: [own.seq, inputSeq(session, input)] })
  })
  assert.equal(r.turn.associationEligible, true)
  assert.equal(r.observed.after.ok, true)
  assert.equal(r.h.requests[1].messageIds.includes(r.input.message.id), true)
  assert.deepEqual(r.h.rejectedObservations, [])
})

test('real R1: automatic host system prompt update between steps remains usable', async t => {
  const h = await host(t, { tools: [{ name: 'prompt_update', execute: (_exec, state) => {
    state.agent.ctx.systemPrompt.section({ name: 'echo020-r1:synthetic-update', text: 'synthetic changed prompt for second step', order: 9999 })
  } }], script: (_request, index) => index === 0 ? response('', [{ id: 'root-auto-update', name: 'prompt_update' }]) : response('synthetic final') })
  const input = official('r1-auto')
  h.follow(input); await h.agent.whenIdle()
  const replacements = h.agent.session.snapshotEvents(0).filter(e => e.surfaceOp?.op === 'replace')
  assert.ok(replacements.some(e => e.type === 'system/message'))
  assert.equal(h.requests.length, 2)
  assert.equal(h.requests[1].messageIds.includes(input.message.id), true)
  assert.equal(h.tracker.snapshot().turns[0].associationEligible, true)
  assert.deepEqual(h.rejectedObservations, [])
})

test('real R1: changed prompt producer is not sufficient evidence for self-only update', async t => {
  const r = await replacementCase(t, 'changed-producer', ({ session, append }) => {
    const own = session.append('developer/message', { turn: 1, step: 1, message: createDeveloperMessage({ content: [{ type: 'text', text: 'synthetic prompt' }], source: { kind: 'plugin:echo020-r1' } }) }, { surfaceOp: 'append' })
    append('developer/message', own.seq, undefined, { source: { kind: 'plugin:other-synthetic-producer' } })
  })
  checkRejected(r, 'surface_replacement_unproven')
  assert.equal(r.h.requests[1].messageIds.includes(r.input.message.id), true)
})

test('real R1: multi-node prompt range is explicitly outside narrow single-node proof', async t => {
  const r = await replacementCase(t, 'multiple-prompts', ({ session, append }) => {
    const seqs = [1, 2].map(n => session.append('developer/message', { turn: 1, step: 1, message: createDeveloperMessage({ content: [{ type: 'text', text: 'synthetic prompt ' + n }], source: { kind: 'plugin:echo020-r1' } }) }, { surfaceOp: 'append' }).seq)
    append('developer/message', seqs[0], seqs[1])
  })
  checkRejected(r, 'surface_replacement_unproven')
})

for (const metadata of [
  { op: 'replace', startSeq: -1, endSeq: 0 },
  { op: 'replace', startSeq: 0, endSeq: 999 },
  { op: 'replace', startSeq: 0, endSeq: 0, extra: true },
  { op: 'remove', startSeq: 0, endSeq: 0 },
  { op: 'replace', startSeq: 0 }
]) test('pure R1 malformed metadata: ' + JSON.stringify(metadata), () => {
  const session = { id: 'synthetic' }, agent = { session }
  const tracker = createOfficialTurnTracker({ agent, session, bootEpoch: 'b', agentEpoch: 'a', liveFromSeq: 0 })
  const input = official('pure-r1')
  tracker.registerSource(input)
  const feed = (seq, type, data, extra = {}) => tracker.observeSessionEvent({ agent, session, event: { seq, type, data, ...extra } })
  feed(0, 'turn/start', { turn: 1 })
  tracker.observeClaim({ agent, session, turn: 1, message: input.message })
  feed(1, 'step/start', { turn: 1, step: 1 })
  feed(2, 'user/message', input.message, { surfaceOp: 'append' })
  const result = feed(3, 'developer/message', { turn: 1, step: 1 }, { surfaceOp: metadata, sourceEventSeqs: [0] })
  assert.equal(result.ok, false)
  feed(4, 'step/end', { turn: 1, step: 1 })
  const final = feed(5, 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  assert.equal(final.turn.associationEligible, false)
})
