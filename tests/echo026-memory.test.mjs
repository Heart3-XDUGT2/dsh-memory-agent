import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { writeTestTrace } from './fixtures/test-trace.mjs'
import { coreHost, response, identity, gate, until, isolation, cleanTmp } from './fixtures/echo024-core.mjs'
const { createTurnSnapshot } = await import('../lib/turn-snapshot.js')
const { latestDirectUserText, humanTurn } = await import('../lib/turn-query.js')
const { createRelay } = await import('../lib/relay.js')
const { codec } = await import('./fixtures/echo022-state.mjs')
const evidence = []
after(() => {
  assert.equal(isolation.networkAttempts, 0)
  const label = process.env.ECHO026_RUN_LABEL ?? 'manual-' + Date.now()
  if (!/^[a-z0-9-]+$/.test(label)) throw Error('invalid_trace_label')
  writeTestTrace("echo-executor-026-trace", label, { actualCore: true, actualHost: true, actualQueryAndSnapshot: true, engine: 'synthetic memory only', isolation, cases: evidence })
  cleanTmp()
})
function memory () {
  const retrieves = [], captures = new Map(), injections = []
  const snapshot = createTurnSnapshot({
    engine: { retrieve: async (query, topK, opts) => {
      retrieves.push({ query, topK, sessionId: opts.sessionId })
      return { text: 'SYNTHETIC_MEMORY_BLOCK: ' + query, engine: 'synthetic-test', graphHits: { hitEdgeIds: [], ltpEdgeIds: [] } }
    } },
    store: { getProfile: () => ({ name: 'SyntheticOwner' }), listConversations: () => [] },
    readSettings: () => ({ injectTopK: 3, sharedRounds: 0, recallExpand: false }),
    captureOf: session => { if (!captures.has(session)) captures.set(session, {}); return captures.get(session) },
    readAliases: () => [], readRetiredAliases: () => [], onInject: value => injections.push(value)
  })
  return { snapshot, retrieves, captures, injections }
}
function wireMemory (f) {
  const m = memory(), notes = [], composed = []
  f.h.agent.ctx.on('agent/inbox/claimed', ({ agent, message }) => {
    const accepted = m.snapshot.noteClaimed(agent.session.id, message)
    notes.push({ accepted, messageId: message.id, rawText: message.source.rawText ?? null, query: m.snapshot.queryOf(agent.session.id) })
  })
  f.h.agent.ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    const target = await next()
    const session = context.agent?.session ?? context.scope?.session
    if (session === f.h.agent.session) {
      const result = await m.snapshot.compose(session)
      if (result) target.sections.push(m.snapshot.sectionOf(result.text))
      composed.push({ query: m.snapshot.queryOf(session.id), memoryText: result?.memoryText ?? null })
    }
    return target
  })
  return { ...m, notes, composed }
}
const incoming = f => f.h.agent.session.snapshotEvents(0).filter(e => e.type === 'user/message' && e.data.source?.platform === 'qq-official')
async function settled (f, count = 1) { await until(() => f.h.requests.length >= count); await f.h.agent.whenIdle() }

test('026 actual core source keeps exact raw words/private owner semantics and stable host message identity', async t => {
  const f = await coreHost(t, { script: () => response('synthetic assistant') })
  const text = 'synthetic question for the existing memory path'
  const receipt = await f.binding.inject(identity('026-source', { text }))
  await settled(f)
  const message = incoming(f)[0].data
  assert.equal(message.source.rawText, text)
  assert.equal(message.content[0].text, text)
  assert.equal(message.id, receipt.receipt.hostMessageId)
  assert.equal(message.source.isMaster, true)
  assert.equal(message.source.chatType, 'private')
  assert.equal(message.source.kind, 'plugin:dsh-echo')
  assert.equal(message.source.form, 'relay')
  assert.equal(message.source.replyContext.version, 2)
  assert.equal(humanTurn(message.source).rawText, text)
  assert.equal(latestDirectUserText([message]), text)
  assert.ok(Object.isFrozen(message.source))
  evidence.push({ name: t.name, source: message.source, messageId: message.id, receiptHostMessageId: receipt.receipt.hostMessageId, query: latestDirectUserText([message]) })
})
test('026 real claimed -> actual turnSnapshot -> fake engine.retrieve -> memory section in real model request', async t => {
  const requests = []
  const f = await coreHost(t, { script: request => {
    requests.push(request.messages.filter(m => m.role === 'system').flatMap(m => m.content.filter(b => b.type === 'text').map(b => b.text)).join('\n'))
    return response('synthetic assistant')
  } })
  const m = wireMemory(f), first = 'synthetic first memory question', second = 'synthetic next memory question'
  const a = await f.binding.inject(identity('026-memory-a', { text: first })); await settled(f)
  assert.equal(m.notes[0].accepted, true)
  assert.equal(m.snapshot.queryOf(f.h.agent.session.id), first)
  assert.deepEqual(m.retrieves.map(r => r.query), [first])
  assert.ok(requests[0].includes('SYNTHETIC_MEMORY_BLOCK: ' + first))
  assert.equal(m.notes[0].messageId, a.receipt.hostMessageId)
  const b = await f.binding.inject(identity('026-memory-b', { text: second })); await settled(f, 2)
  assert.deepEqual(m.retrieves.map(r => r.query), [first, second])
  assert.ok(m.retrieves.every(r => r.sessionId === f.h.agent.session.id && r.topK === 3))
  assert.equal(m.snapshot.queryOf(f.h.agent.session.id), second)
  assert.ok(requests[1].includes('SYNTHETIC_MEMORY_BLOCK: ' + second))
  assert.equal(m.notes[1].messageId, b.receipt.hostMessageId)
  assert.equal(f.h.ctx.agents.list().length, 1)
  evidence.push({ name: t.name, actualClaims: m.notes, fakeEngineRetrieves: m.retrieves, composed: m.composed,
    modelSystemSections: requests, originalAgentCount: f.h.ctx.agents.list().length })
})
test('026 snapshot mutation cannot separate rawText/content/digest or change verified nested scope', async t => {
  const f = await coreHost(t, { script: () => response('synthetic assistant') }), started = gate(), hold = gate()
  f.store.before = async ({ call }) => { if (call === 1) { started.resolve(); await hold.promise } }
  const input = identity('026-snapshot', { text: '  synthetic original raw words  ' }), original = structuredClone(input)
  const pending = f.binding.inject(input)
  await started.promise
  input.text = 'synthetic changed after snapshot'
  input.scope.appId = 'ChangedApp'
  input.scope.ownerHash = 'changed-scope'
  input.scope.chatId = 'changed-chat'
  hold.resolve()
  const receipt = await pending; await settled(f)
  const message = incoming(f)[0].data
  const record = await f.store.read({ scopeKey: message.source.replyContext.scopeKey, inboundKey: original.inboundKey })
  assert.equal(message.source.rawText, original.text)
  assert.equal(message.content[0].text, original.text)
  assert.equal(message.id, receipt.receipt.hostMessageId)
  assert.equal(message.source.chatId, original.scope.chatId)
  assert.equal(message.source.replyContext.inboundKey, original.inboundKey)
  assert.equal(record.inputDigest, codec.inputDigest({ scopeKey: record.scopeKey, inboundKey: original.inboundKey, replyAnchorKey: original.replyAnchorKey, text: message.source.rawText }))
  assert.equal(latestDirectUserText([message]), original.text.trim(), 'retain the old query trim policy')
  evidence.push({ name: t.name, source: message.source, content: message.content, inputDigest: record.inputDigest })
})
test('026 existing image-only/internal snapshot/runtime/tool/noise query filters still reject without retrieval', async t => {
  const f = await coreHost(t, { script: () => response('synthetic assistant') })
  await f.binding.inject(identity('026-filter-source')); await settled(f)
  const actual = incoming(f)[0].data, m = memory()
  const variants = [
    { ...actual, source: { ...actual.source, rawText: '' }, content: [{ type: 'text', text: 'synthetic image-only transport wrapper' }] },
    { ...actual, source: { ...actual.source, form: 'snapshot' } },
    { ...actual, source: { kind: 'runtime-context' } },
    { ...actual, source: { kind: 'tool' } },
    { ...actual, source: { kind: 'user' }, content: [{ type: 'text', text: 'Current runtime context. This snapshot supersedes earlier runtime-context snapshots.' }] }
  ]
  for (const message of variants) {
    m.snapshot.forget(f.h.agent.session.id)
    assert.equal(latestDirectUserText([message]), '')
    assert.equal(m.snapshot.noteClaimed(f.h.agent.session.id, message), false)
    assert.equal(await m.snapshot.compose(f.h.agent.session), null)
  }
  assert.equal(m.retrieves.length, 0)
})
test('026 non-owner admission remains blocked before memory/model work, without loosening query filters', async t => {
  const f = await coreHost(t, { bind: false, script: () => response('synthetic assistant') }), m = wireMemory(f)
  await assert.rejects(f.service.openBinding({ scope: f.scope, authorization: { kind: 'local-explicit-owner', authorized: false,
    appId: f.scope.appId, ownerHash: f.scope.ownerHash }, metadataStore: f.store }), /authorization/)
  let touched = 0
  const relay = createRelay({ config: () => ({}), isEnabled: () => true,
    store: new Proxy({}, { get: () => () => { touched++; throw Error('unexpected store') } }),
    ensureCompanion: async () => { touched++ } })
  const denied = await relay.handleInbound({ v: 1, platform: 'qq', chat: { id: 'synthetic-private', type: 'private' },
    sender: { id: 'synthetic-non-owner', isMaster: false }, text: 'synthetic unauthorized text', msgId: 'synthetic-non-owner-message', ts: 1000 })
  assert.equal(denied.body.reason, 'not-master')
  assert.equal(touched, 0); assert.equal(f.h.requests.length, 0); assert.equal(m.retrieves.length, 0)
})
