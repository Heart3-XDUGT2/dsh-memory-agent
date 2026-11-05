import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'
import { captureAuditInput, makeAuditIO, encodeAuditDetail, createArmAudit, captureRetrievedItems, createRetrieveAudit, auditNumber } from '../lib/audit-io.js'
import { createQueryExpander } from '../lib/query-expand.js'
import { createSameTurnScorer, parseScore } from '../lib/emotion-score.js'
import { createEngine } from '../lib/engine.js'

const score = () => ({ global: { fatigue: 0, valence: -2, arousal: 3 }, target_master: { affection: 5, playfulness: 4, sadness: 0, dependency: 5 }, intensity: 0, reason: '提出去河边散步' })
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }
const detail = row => JSON.parse(row.stageDetail)

test('bounded observations preserve explicit zero/null/false/empty values and detach nested data', () => {
  const input = { text: '', options: { zero: 0, missing: null, enabled: false, list: [] } }
  const captured = captureAuditInput(input)
  input.options.zero = 99
  const output = { score: { intensity: 0 }, terms: [] }
  const io = makeAuditIO('query_expand', captured, { fromCache: false }, output)
  io.output.score.intensity = 8
  assert.equal(output.score.intensity, 0)
  assert.deepEqual(io.input, { text: '', options: { zero: 0, missing: null, enabled: false, list: [] } })
  assert.deepEqual([auditNumber(null), auditNumber(undefined), auditNumber(''), auditNumber(0)], [null, null, null, 0])
})

test('large snapshots stay legal within store budget with original counts and source/version', () => {
  const items = Array.from({ length: 48 }, (_, n) => ({ summary: '合成长摘要'.repeat(1500), r_now: n, total: 0, hits: null, forced: false }))
  const returned = captureRetrievedItems(items)
  const io = makeAuditIO('retrieve', captureAuditInput({ text: '合成查询'.repeat(4000), topK: 48, options: { enabled: false } }), { status: 'success' }, returned.output, returned.truncation)
  const encoded = encodeAuditDetail({ turnTrace: 'synthetic-round', raw: '合成返回'.repeat(2000), ok: true }, io)
  assert.ok(encoded.length <= 4000)
  const saved = JSON.parse(encoded)
  assert.equal(saved.io.version, 1)
  assert.equal(saved.io.source, 'retrieve')
  assert.equal(saved.io.output.count, 48)
  assert.ok(saved.io.truncation.truncated)
  const cuts = [...(saved.io.truncation.fields || []), ...(saved.truncation?.fields || [])]
  assert.ok(cuts.some(c => c.originalCount === 48 && c.savedCount < 48))
  assert.equal(items[0].summary.length, 7500)
})

test('cycles, throwing getters and missing candidate scores do not fabricate observations', () => {
  const input = { text: '合成输入' }; input.cycle = input
  Object.defineProperty(input, 'bad', { enumerable: true, get () { throw Error('synthetic getter') } })
  const captured = captureAuditInput(input)
  assert.ok(captured.truncation.truncated)
  assert.doesNotThrow(() => JSON.stringify(captured))
  const result = captureRetrievedItems([{ summary: '', r_now: 0, hits: null, forced: false }, { summary: '只有摘要' }])
  assert.deepEqual(result.output.items, [{ summary: '', r_now: 0, hits: null, forced: false }, { summary: '只有摘要' }])
  assert.deepEqual(captureRetrievedItems(null).output, { items: null, count: null })
  assert.deepEqual(captureRetrievedItems([]).output, { items: [], count: 0 })
})

test('unavailable input/output provenance survives the second snapshot budget', () => {
  const input = { input: null, truncation: { truncated: true, unavailable: true, fields: [] } }
  const io = makeAuditIO('query_expand', input, { status: 'success' }, { terms: [], count: 0 })
  assert.equal(io.truncation.truncated, true)
  assert.equal(io.truncation.unavailable, true)
  const output = makeAuditIO('retrieve', captureAuditInput({ text: '查询' }), { status: 'success' }, { items: null, count: null }, { truncated: true, unavailable: true, fields: [] })
  assert.equal(output.truncation.truncated, true)
  assert.equal(output.truncation.unavailable, true)
})

test('pathological keys and many cuts remain bounded and visibly marked', () => {
  const captured = captureAuditInput({ text: '查询', options: { ['long'.repeat(2500)]: 'value' } })
  const io = makeAuditIO('retrieve', captured, { status: 'success' }, { items: [], count: 0 })
  assert.ok(JSON.stringify(captured).length <= 1400)
  assert.equal(io.version, 1)
  assert.equal(io.source, 'retrieve')
  assert.equal(io.truncation.truncated, true)
  const encoded = encodeAuditDetail({ turnTrace: 'captured-round', turnAssociation: 'captured' }, io)
  assert.ok(encoded.length <= 4000)
  assert.equal(JSON.parse(encoded).turnTrace, 'captured-round')
  const cuts = Array.from({ length: 12 }, (_, n) => ({ path: 'field.' + n, kind: 'items', originalCount: 20, savedCount: 0 }))
  const combined = makeAuditIO('retrieve', { input: null, truncation: { truncated: true, fields: cuts } }, {}, {})
  assert.equal(combined.truncation.fields.length + combined.truncation.omittedFields, 12)
})

test('arm identity and start input/round are frozen; repeats and unassociated results stay distinct', () => {
  const rows = []; let n = 0; let trace = 'round-old'; const previousVector = score().global
  const args = { store: { writeAudit: row => rows.push(row) }, arm: 'same_turn_emotion', step: 21, beginAt: 10, sessionId: 'synthetic-session', userText: '起跑输入', previousVector, now: () => 25, id: () => 'event-' + ++n }
  const a = createArmAudit({ ...args, turnTrace: trace }), b = createArmAudit({ ...args, turnTrace: trace })
  trace = 'round-new'; previousVector.fatigue = 9
  a({ ok: true, ms: 0 }); b({ ok: false, ms: null })
  createArmAudit(args)({ ok: false })
  assert.equal(new Set(rows.map(r => r.traceId)).size, 3)
  assert.equal(detail(rows[0]).turnTrace, 'round-old')
  assert.equal(detail(rows[0]).io.input.previousVector.fatigue, 0)
  assert.equal(detail(rows[0]).ms, 0)
  assert.equal(detail(rows[1]).ms, null)
  assert.equal(rows[0].userInput, '起跑输入')
  assert.equal(detail(rows[2]).turnAssociation, 'unavailable')
  assert.equal(detail(rows[2]).turnTrace, 'event-3')
  assert.doesNotThrow(() => createArmAudit({ ...args, store: { writeAudit () { throw Error('writer') } } })({ ok: true }))
})

test('index uses factory at start and shares the exact text with parallel arms', () => {
  const src = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
  const start = src.indexOf('const armUserText = turnSnapshot.queryOf(sid)')
  const end = src.indexOf('// ★ 两个开关', start)
  assert.ok(start >= 0 && end > start)
  const rows = []; let trace = 'original-round'; let input = '起跑时文本'
  const make = new Function('createArmAudit', 'store', 'turnSnapshot', 'turnTrace', 'sid', 'prev', src.slice(start, end) + '\nreturn auditArm;')
  const factory = make(createArmAudit, { writeAudit: r => rows.push(r) }, { queryOf: () => input }, { of: () => trace }, 'synthetic', { emotionVector: score() })
  const settle = factory('query_expand', 20, 100)
  input = '后来文本'; trace = 'later-round'; settle({ ok: true })
  assert.equal(rows[0].userInput, '起跑时文本')
  assert.equal(detail(rows[0]).turnTrace, 'original-round')
  assert.match(src.slice(end, end + 1200), /userText: armUserText/)
})

test('query observer cannot alter returned terms, pending, cache or request count', async () => {
  let calls = 0; const observations = []
  const expander = createQueryExpander({ run: async () => { calls++; return { terms: ['沿河', '步行'] } } })
  const observe = r => { observations.push(structuredClone(r.io)); r.io.output.terms.push('observer-only'); throw Error('observer') }
  assert.deepEqual(await expander.begin('s', { userText: '出去走走', onSettle: observe }), ['沿河', '步行'])
  assert.deepEqual(expander.take('s', '出去走走'), { key: '出去走走', terms: ['沿河', '步行'], fromCache: false })
  assert.deepEqual(await expander.begin('s', { userText: '出去走走', onSettle: observe }), ['沿河', '步行'])
  assert.deepEqual(expander.take('s', '出去走走'), { key: '出去走走', terms: ['沿河', '步行'], fromCache: true })
  assert.equal(expander.take('s', '出去走走'), null)
  assert.equal(calls, 1)
  assert.deepEqual(observations.map(x => x.process.fromCache), [false, true])
  assert.deepEqual(observations[1].output, { terms: ['沿河', '步行'], count: 2 })
})

for (const kind of ['empty_query', 'no_run', 'empty_result', 'failed', 'timeout']) {
  test('query observation distinguishes ' + kind, async () => {
    let observation, calls = 0
    const expander = createQueryExpander({ getTimeoutMs: () => 200, run: kind === 'no_run' ? null : async () => { calls++; if (kind === 'failed') throw Error('synthetic'); if (kind === 'timeout') return new Promise(() => {}); return { terms: [] } } })
    const keepAlive = delay(350)
    await expander.begin('s', { userText: kind === 'empty_query' ? '' : '合成输入', onSettle: r => { observation = r.io } })
    assert.equal(observation.process.status, kind)
    assert.equal(calls, ['empty_query', 'no_run'].includes(kind) ? 0 : 1)
    assert.deepEqual(observation.output.terms, ['empty_query', 'no_run'].includes(kind) ? null : [])
    assert.equal(expander.take('s', '合成输入'), null)
    await keepAlive
  })
}

test('emotion exposes validated zero score separately from raw; observer cannot alter take', async () => {
  let io; const original = score()
  const scorer = createSameTurnScorer({ run: async () => original, now: () => 10 })
  assert.equal(scorer.begin('s', { userText: '出去散步', prevVector: score(), onSettle: r => { io = structuredClone(r.io); r.io.output.score.intensity = 9; r.io.output.score.vector.global.fatigue = 9; throw Error('observer') } }), true)
  const result = await scorer.take('s')
  assert.deepEqual(result.score, parseScore(original))
  assert.equal(io.output.score.intensity, 0)
  assert.equal(io.output.score.vector.global.fatigue, 0)
  assert.equal(typeof io.output.raw, 'string')
  assert.equal(scorer.take('s') instanceof Promise, true)
  assert.equal(await scorer.take('s'), null)
})

for (const kind of ['empty_query', 'no_run', 'invalid', 'failed', 'timeout']) {
  test('emotion observation distinguishes ' + kind, async () => {
    let io, calls = 0
    const scorer = createSameTurnScorer({ getTimeoutMs: () => 100, run: kind === 'no_run' ? null : async () => { calls++; if (kind === 'failed') throw Error('synthetic'); if (kind === 'timeout') return new Promise(() => {}); return '{bad json' } })
    const keepAlive = delay(200)
    scorer.begin('s', { userText: kind === 'empty_query' ? '' : '合成输入', onSettle: r => { io = r.io } })
    assert.equal(await scorer.take('s'), null)
    assert.equal(io.process.status, kind)
    assert.equal(io.output.score, null)
    assert.equal(calls, ['empty_query', 'no_run'].includes(kind) ? 0 : 1)
    if (kind === 'invalid') assert.equal(io.output.raw, '{bad json')
    await keepAlive
  })
}

test('late emotion observation retains its input snapshot while the next turn starts', async () => {
  const wait = deferred(), rows = [], prev = score(); let next = false
  const scorer = createSameTurnScorer({ run: () => next ? Promise.resolve(score()) : wait.promise })
  scorer.begin('s', { userText: '旧轮输入', prevVector: prev, onSettle: r => rows.push(r.io) })
  await delay(0); const old = scorer.take('s')
  next = true; prev.global.fatigue = 8
  scorer.begin('s', { userText: '新轮输入', prevVector: prev, onSettle: r => rows.push(r.io) })
  await scorer.take('s'); wait.resolve(score()); await old
  const late = rows.find(r => r.input.text === '旧轮输入')
  assert.equal(late.input.previousVector.global.fatigue, 0)
  assert.equal(rows.length, 2)
})

function fakeStore (rows, options = {}) {
  return { retrieve: (...args) => { options.calls?.push(args); if (options.fail) throw Error('baseline'); return [{ summary: '合成记忆', r_now: 0, hits: 0, forced: false, keywords: ['散步'] }] }, getState: () => ({}), getProfile: () => null, writeAudit: r => { if (options.writerFail) throw Error('writer'); rows.push(r) } }
}
function fakeClient (requests, { graphFail = false, retrieveFail = false, gate = null } = {}) {
  return { running: true, state: () => ({ breakerOpen: false }), start: async () => ({ version: 'synthetic' }), stop: async () => {}, request: async (op, args, options) => {
    requests.push({ op, args: structuredClone(args), options })
    if (op === 'retrieve') { if (gate) await gate.promise; if (retrieveFail) throw Error('retrieve'); return { text: '合成情景记忆', items: [{ summary: '已取得的合成摘要', r_now: 0, total: null, forced: false, keywords: ['散步'] }] } }
    if (graphFail) throw Error('graph')
    return { pathsText: '合成图路径', seedNames: ['散步'], hitEdgeIds: [], ltpEdgeIds: [] }
  } }
}

for (const scenario of ['success', 'graph_failure', 'retrieve_failure', 'writer_failure']) {
  test('python retrieval keeps request sequence/strategy and observation: ' + scenario, async () => {
    const rows = [], requests = [], baselineCalls = []
    const engine = createEngine({ store: fakeStore(rows, { calls: baselineCalls, writerFail: scenario === 'writer_failure' }), detect: async () => ({ path: 'synthetic' }), clientOpts: { client: fakeClient(requests, { graphFail: scenario === 'graph_failure', retrieveFail: scenario === 'retrieve_failure' }) } })
    await engine.init()
    const result = await engine.retrieve('合成查询', 3, { sessionId: 'synthetic', turnTrace: 'round-start', retrievalOpts: { pinnedFree: false, augKeys: true }, extraSeeds: ['显式种子'] })
    assert.deepEqual(requests.map(r => r.op), scenario === 'retrieve_failure' ? ['retrieve'] : ['retrieve', 'graph_query'])
    assert.deepEqual(requests[0], { op: 'retrieve', args: { userId: 'master', query: '合成查询', topK: 3, opts: { pinnedFree: false, augKeys: true } }, options: { timeoutMs: 4000 } })
    assert.equal(baselineCalls.length, 0)
    if (scenario === 'retrieve_failure') assert.equal(result, null)
    else { assert.equal(result.engine, 'python'); assert.ok(result.text.includes('合成情景记忆')); assert.equal(result.graphHits === null, scenario === 'graph_failure') }
    if (scenario === 'writer_failure') assert.equal(rows.length, 0)
    else {
      assert.equal(rows.length, 1)
      const saved = detail(rows[0]); assert.equal(saved.turnTrace, 'round-start')
      assert.equal(saved.io.process.status, scenario === 'retrieve_failure' ? 'failed' : 'success')
      if (scenario !== 'retrieve_failure') { assert.equal(saved.io.output.items[0].r_now, 0); assert.equal(saved.io.output.count, 1) }
      if (scenario === 'graph_failure') { assert.equal(saved.io.process.graph, 'failed'); assert.equal(saved.io.process.graphError, 'graph') }
    }
    await engine.stop()
  })
}

test('baseline observation adds no second retrieve and writer failures preserve return', async () => {
  for (const writerFail of [false, true]) {
    const rows = [], calls = []; const engine = createEngine({ store: fakeStore(rows, { calls, writerFail }), detect: async () => null })
    await engine.init(); const result = await engine.retrieve('合成查询', 2)
    assert.equal(result.engine, 'baseline'); assert.ok(result.text.includes('合成记忆'))
    assert.equal(calls.length, 1)
    assert.deepEqual(calls[0].slice(0, 2), ['合成查询', 2])
    assert.ok(Number.isFinite(calls[0][2]))
    assert.equal(calls[0][3], null)
    assert.equal(rows.length, writerFail ? 0 : 1)
    if (!writerFail) { assert.equal(detail(rows[0]).io.output.items[0].r_now, 0); assert.equal(detail(rows[0]).io.process.graph, 'not_requested') }
  }
})

test('baseline failures and offline do not invent returned items', async () => {
  const rows = [], calls = []; const engine = createEngine({ store: fakeStore(rows, { calls, fail: true }), detect: async () => null })
  await engine.init(); assert.equal(await engine.retrieve('合成查询'), null)
  assert.equal(calls.length, 1); assert.equal(detail(rows[0]).io.process.status, 'failed'); assert.equal(detail(rows[0]).io.output.items, null)
  const offline = createEngine({ store: null, detect: async () => null }); await offline.init()
  assert.equal(await offline.retrieve('合成查询'), null)
})

test('retrieve input and association freeze before await; trace lookup/writer errors are fail-soft', async () => {
  const gate = deferred(), rows = [], requests = []; let trace = 'old-round'
  const options = { pinnedFree: false }; const extraSeeds = ['旧种子']
  const engine = createEngine({ store: fakeStore(rows), detect: async () => ({ path: 'synthetic' }), clientOpts: { client: fakeClient(requests, { gate }) }, auditTraceOf: () => trace })
  await engine.init(); const result = engine.retrieve('起跑输入', 2, { retrievalOpts: options, extraSeeds, sessionId: 'synthetic' })
  trace = 'new-round'; options.pinnedFree = true; extraSeeds.push('后添种子'); gate.resolve()
  assert.equal((await result).engine, 'python')
  const saved = detail(rows[0]); assert.equal(saved.turnTrace, 'old-round'); assert.equal(saved.io.input.options.pinnedFree, false); assert.deepEqual(saved.io.input.extraSeeds, ['旧种子'])
  const bad = createEngine({ store: fakeStore([]), detect: async () => null, auditTraceOf: () => { throw Error('trace') } }); await bad.init()
  assert.equal((await bad.retrieve('合成查询')).engine, 'baseline')
})

test('retrieve audit observer snapshots count/elapsed time without undefined-to-zero conversion', () => {
  const rows = []; let now = 10
  const record = createRetrieveAudit({ store: { writeAudit: r => rows.push(r) }, query: '', topK: 0, options: null, sessionId: '', turnTrace: '', now: () => now, id: () => 'event' })
  now = 35; record({ engine: 'baseline', status: 'success', returned: captureRetrievedItems([]) })
  const saved = detail(rows[0]); assert.equal(saved.ms, 25); assert.equal(saved.candidates, 0); assert.equal(saved.io.input.topK, 0); assert.equal(saved.io.input.text, ''); assert.equal(saved.turnAssociation, 'unavailable')
})
