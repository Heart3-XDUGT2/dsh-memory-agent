import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { writeTestTrace } from './fixtures/test-trace.mjs'
// Isolation runs before host imports; the old fixture is reused unchanged.
import { host, local, createUserMessage, traces, isolation, cleanTmp } from './fixtures/echo020-host.mjs'
import { MemoryMetadataStore, identity, tick, gate } from './fixtures/echo022-state.mjs'
import * as codec from 'dsh-echo/official-c2c-codec'
import { createOfficialInput } from '../lib/official-input.js'
const results = []
after(() => {
  assert.equal(isolation.networkAttempts, 0)
  const label = process.env.ECHO022_RUN_LABEL ?? 'manual-' + Date.now()
  if (!/^[a-z0-9-]+$/.test(label)) throw Error('invalid_trace_label')
  writeTestTrace("echo-executor-022-host-trace", label, { isolation, codec: 'actual package public subpath', cases: traces, results })
  cleanTmp()
})
async function assemble (t, options = {}) {
  const h = await host(t, options.host)
  const hostAgentsAtCreation = h.ctx.agents.list().length
  const scheduled = [], constructed = [], selectedAgents = []
  let gen = 1, targetCurrent = true
  const target = { agent: h.agent, session: h.agent.session, tracker: h.tracker, isCurrent: () => targetCurrent }
  const store = options.store ?? new MemoryMetadataStore()
  const worker = { schedule: fn => scheduled.push(fn), wait: async current => { await current.agent.whenIdle(); return { kind: 'ready' } },
    publish: async (current, commit) => { await current.agent.runMaintenance(async () => { commit() }); return { kind: 'published' } }, ...options.worker }
  const component = createOfficialInput({ scope: identity().scope, generation: 1, getGeneration: () => gen, codec, metadataStore: store,
    resolveTarget: async () => { selectedAgents.push(h.agent); if (options.resolve) await options.resolve(); return target },
    createMessage: value => { const message = createUserMessage(value); constructed.push(message); return message },
    worker, clock: { now: Date.now, setTimeout, clearTimeout }, ...options.input })
  const r = { h, component, store, target, constructed, selectedAgents, scheduled,
    generation: value => { gen = value }, replaceTarget: () => { targetCurrent = false },
    async drive () {
      for (let n = 0; n < 2000; n++) {
        if (scheduled.length) scheduled.shift()()
        await tick()
        const s = component.status()
        if (!scheduled.length && !s.pendingTasks.length && !s.queued.length) return
      }
      throw Error('synthetic worker failed to quiesce')
    },
    async observed (receipt) { await h.agent.whenIdle(); return component.refresh(receipt.sourceKey) } }
  t.after(() => { results.push({ sourceStatus: component.status(), sameAgentForAllSelections: selectedAgents.every(a => a === h.agent), createdMessages: constructed.map(m => ({ id: m.id, source: m.source })), hostAgentsAtCreation }) })
  return r
}

test('real host + actual 023 codec: multiple admissions return to one original agent with genuine entered events', async t => {
  const f = await assemble(t), hold = gate()
  const maintenance = f.h.agent.runMaintenance(() => hold.promise)
  const a = await f.component.inject(identity('host-a')), b = await f.component.inject(identity('host-b'))
  assert.equal(a.processingState, 'queued_volatile'); assert.equal(b.processingState, 'queued_volatile')
  assert.equal(f.h.requests.length, 0)
  f.h.agent.followup(local('synthetic local insertion'))
  if (f.scheduled.length) f.scheduled.shift()()
  await tick()
  hold.resolve(); await maintenance; await f.drive()
  const oa = await f.observed(a), ob = await f.observed(b)
  assert.equal(oa.observation.state, 'turn_closed'); assert.equal(ob.observation.state, 'turn_closed')
  assert.notEqual(oa.observation.enteredUid, ob.observation.enteredUid)
  assert.deepEqual(f.h.tracker.snapshot().turns.map(x => x.associationEligible), [false, true, true])
  assert.equal(f.h.ctx.agents.list().length, 1)
  assert.ok(f.selectedAgents.every(agent => agent === f.h.agent))
  assert.equal(f.constructed.length, 2)
  assert.ok(f.constructed.every(m => f.h.requests.some(r => r.messageIds.includes(m.id))))
  assert.ok(f.constructed.every(m => m.source.replyContext.version === 2 && m.source.replyContext.keyScheme === codec.KEY_SCHEME))
  assert.deepEqual(f.h.rejectedObservations, [])
})
test('real host pending concurrent and lost response duplicate produces exactly one model turn', async t => {
  const resolving = gate(), hold = gate(), f = await assemble(t, { resolve: async () => { resolving.resolve(); await hold.promise } })
  const first = f.component.inject(identity('concurrent')); await resolving.promise
  const pending = await f.component.inject(identity('concurrent'))
  assert.equal(pending.admissionState, 'admitting'); assert.equal(pending.duplicate, false)
  hold.resolve(); const receipt = await first
  await f.drive(); await f.h.agent.whenIdle()
  const duplicate = await f.component.inject(identity('concurrent')); await f.drive()
  assert.deepEqual(duplicate.receipt, receipt.receipt); assert.equal(duplicate.duplicate, true)
  assert.equal(f.h.requests.length, 1); assert.equal(f.constructed.length, 1)
  assert.equal((await f.observed(receipt)).observation.state, 'turn_closed')
})
test('real host busy retries reuse exact immutable message and source', async t => {
  let waits = 0
  const f = await assemble(t, { worker: { wait: async () => ({ kind: ++waits < 3 ? 'busy' : 'ready' }) } })
  const receipt = await f.component.inject(identity('busy')); await f.drive()
  const observation = await f.observed(receipt)
  assert.equal(waits, 3); assert.equal(f.constructed.length, 1)
  assert.equal(observation.observation.messageId, f.constructed[0].id)
  assert.equal(f.h.requests.length, 1)
})
test('real host queue eviction during idle wait cannot remove or publish the new head incorrectly', async t => {
  const hold = gate(), waiting = gate(), f = await assemble(t, { input: { capacity: 1 }, worker: { wait: async () => { waiting.resolve(); await hold.promise; return { kind: 'ready' } } } })
  const old = await f.component.inject(identity('old')), work = f.component.pump()
  await waiting.promise
  const next = await f.component.inject(identity('new'))
  hold.resolve(); await work; await f.drive()
  assert.equal(f.h.requests.length, 1)
  assert.equal(f.h.requests[0].messageIds.includes(old.receipt.hostMessageId), false)
  assert.equal(f.h.requests[0].messageIds.includes(next.receipt.hostMessageId), true)
  assert.equal((await f.component.sourceStatus(identity('old'))).processingState, 'evicted')
  assert.equal((await f.observed(next)).observation.state, 'turn_closed')
})
test('real followup then lost worker result is unknown and never injected twice', async t => {
  const f = await assemble(t, { worker: { publish: async (target, commit) => {
    await target.agent.runMaintenance(async () => commit())
    throw Error('synthetic lost publish receipt')
  } } })
  const receipt = await f.component.inject(identity('unknown')); await f.drive()
  await f.h.agent.whenIdle()
  assert.equal((await f.component.sourceStatus(identity('unknown'))).processingState, 'unknown')
  assert.equal((await f.component.inject(identity('unknown'))).duplicate, true)
  await f.drive(); assert.equal(f.h.requests.length, 1)
  const fact = await f.observed(receipt)
  assert.equal(fact.observation.state, 'turn_closed')
  assert.equal(fact.processingState, 'turn_closed')
})
test('real tracker capacity refusal is reported without fake entered state or another Agent', async t => {
  const f = await assemble(t, { host: { trackerLimits: { sources: 1 } } })
  const a = await f.component.inject(identity('limit-a')); await f.drive(); await f.observed(a)
  const b = await f.component.inject(identity('limit-b')); await f.drive()
  assert.equal((await f.component.sourceStatus(identity('limit-b'))).processingState, 'tracker_rejected')
  assert.equal(f.h.tracker.sourceStatus(b.sourceKey), null)
  assert.equal(f.h.requests.length, 1); assert.equal(f.h.ctx.agents.list().length, 1)
})
test('real revoke fences official work and leaves shared original agent usable for local messages', async t => {
  const f = await assemble(t), hold = gate(), maintenance = f.h.agent.runMaintenance(() => hold.promise)
  await f.component.inject(identity('revoke'))
  const work = f.component.pump(); await tick()
  f.component.revoke()
  assert.equal(f.component.status().active, false)
  assert.equal((await f.component.drain({ timeoutMs: 5 })).drained, false)
  const m = local('synthetic local remains usable')
  f.h.agent.followup(m); hold.resolve(); await maintenance; await work; await f.drive(); await f.h.agent.whenIdle()
  assert.equal(f.h.requests.length, 1)
  assert.equal(f.h.requests[0].messageIds.includes(m.id), true)
  assert.equal(f.h.tracker.snapshot().turns[0].associationEligible, false)
  assert.equal((await f.component.drain({ timeoutMs: 30 })).sharedStoreClosed, false)
})
test('real target replacement while waiting suppresses stale publication', async t => {
  const wait = gate(), entered = gate(), f = await assemble(t, { worker: { wait: async () => { entered.resolve(); await wait.promise; return { kind: 'ready' } } } })
  await f.component.inject(identity('replace')); const work = f.component.pump()
  await entered.promise; f.replaceTarget(); wait.resolve(); await work; await f.drive()
  assert.equal(f.h.requests.length, 0)
  assert.equal((await f.component.sourceStatus(identity('replace'))).processingState, 'target_replaced')
})
test('real pre-step rejection is visible as not_entered rather than guessed completion', async t => {
  const f = await assemble(t, { host: { preStep: async () => ({ kind: 'reject' }) } })
  const r = await f.component.inject(identity('blocked')); await f.drive(); await f.h.agent.whenIdle()
  const fact = await f.observed(r)
  assert.equal(fact.observation.state, 'not_entered')
  assert.equal(fact.processingState, 'not_entered')
  assert.equal(fact.observation.endReason, 'blocked')
  assert.equal(f.h.requests.length, 0)
  assert.equal(fact.everAccepted, true)
})
