/** ECHO-008: production scheduling/engines with isolated stores and delayed synthetic model output. */
import './_isolate.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { openStore, MASTER_ID } from '../lib/store.js'
import { snapshotCapture } from '../lib/reflect.js'
import { createEngine } from '../lib/engine.js'
import { detectPython } from '../lib/sidecar-client.js'
import { createTurnTrace } from '../lib/turn-trace.js'
import { isSubagentSession } from '../lib/agent-scope.js'

const read = file => readFileSync(new URL(file, import.meta.url), 'utf8').replace(/\r\n/g, '\n')
function section (source, start, end, includeEnd = false) {
  const a = source.indexOf(start), b = source.indexOf(end, a + start.length)
  assert.ok(a >= 0 && b > a, 'must execute actual production block')
  return source.slice(a, b + (includeEnd ? end.length : 0))
}
const index = read('../lib/index.js')
const fireSource = section(index, '  const fireReflect = (capture) => {', '\n  // v0.35.0 B4:把这一趟')
const shape = new Function(section(index, 'const REFLECT_STATS_SHAPE = {', '\n}', true) + ';return REFLECT_STATS_SHAPE')()
const view = {}
new Function('globalThis', read('../web/audit-view.js'))(view)
const buildTurns = view.EchoAuditView.buildTurns
const roundKeyOf = new Function('return (' + section(read('../web/mock/final/views/audit.js'), '  function roundKeyOf(turn) {', '  function detailOf(').trim() + ')')()
const vector = { global: { fatigue: 2, valence: 2, arousal: 3, dominance: 4 },
  target_master: { affection: 8, playfulness: 7, sadness: 0, dependency: 6 }, ipc_dyad: { kept: 1 } }
const raw = label => ({ keywords: ['散步' + label], summary: '合成记忆' + label, emotion_score: 7, emotion_state: 'neutral',
  mood_intensity: 6, mood_reason: '合成原因', name: '合成新名', emotion_vector: vector, askKeys: ['合成问法'],
  candidates: [], triples: [], pendingThreads: [] })
const cap = (label, sessionId = 'test-main') => ({ userText: '今天去公园散步' + label, assistantText: '公园天气很好' + label,
  qzoneComment: '', lastInjected: '合成记忆块' + label, profileSnapshot: '合成画像' + label, startedAt: 1,
  sessionId, agent: { session: { id: sessionId } } })
function fresh (t, dbPath = ':memory:') {
  const store = openStore(dbPath)
  store.db.prepare('INSERT OR IGNORE INTO user_profile (user_id, name) VALUES (?, ?)').run(MASTER_ID, '合成旧名')
  store.saveState({ moodIntensity: 3, prevMoodIntensity: 3, userEmotion: 'neutral', emotionVector: vector })
  t.after(() => store.close())
  return store
}
function deferred () {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
async function until (fn) {
  const end = Date.now() + 8000
  while (!fn()) { if (Date.now() > end) assert.fail('isolated scheduler timeout'); await new Promise(resolve => setImmediate(resolve)) }
}
const tag = row => { try { return JSON.parse(row.stageDetail).turnTrace } catch { return undefined } }
function assertStoredTag (store, input, expected) {
  const rows = store.listAudit().filter(r => r.toolCall === 'extract' && r.userInput === input)
  assert.equal(rows.length, 1)
  const row = rows[0]
  assert.equal(tag(row), expected)
  assert.match(row.traceId, /^[0-9a-f-]{36}$/u)
  assert.notEqual(row.traceId, expected)
  const sql = store.db.prepare('SELECT stage_detail FROM audit_logs WHERE trace_id = ?').get(row.traceId)
  assert.equal(tag({ stageDetail: sql.stage_detail }), expected)
  assert.equal(Object.hasOwn(row, 'turnTraceCaptured'), false)
  return row
}
async function scheduler (t, { store = fresh(t), trace = { of: () => 'round-a' }, outcomes = [], throwFirst = false } = {}) {
  const engine = createEngine({ store, dbPath: ':memory:', detect: async () => null })
  assert.equal(await engine.init(), 'baseline')
  t.after(() => engine.stop())
  const model = [], starts = [], ipc = [], scheduled = []
  let active = 0, maximum = 0, traceCalls = 0
  const transport = { mode: 'llm', structured: async request => {
    const position = model.length, gate = deferred()
    model.push({ request, gate })
    await gate.promise
    return outcomes[position] === null ? null : raw(['甲', '乙', '丙'][position])
  } }
  const wrapped = { reflect: async (tr, args) => {
    const position = starts.length
    starts.push(args); active++; maximum = Math.max(maximum, active)
    try {
      const out = await engine.reflect(tr, args)
      if (position === 0 && throwFirst) throw Error('synthetic completion failure')
      return out
    } finally { active-- }
  }, episodicCleanup: () => assert.fail('unrelated cleanup should not run') }
  const deps = { store, subagents: {}, snapshotCapture, isSubagentSession, engine: wrapped, randomUUID,
    turnTrace: { of: sid => { traceCalls++; return trace.of(sid) } },
    ctx: { logger: { warn () {}, info () {} } }, readSettings: () => ({ cleanupEvery: 1000 }),
    reflectTransport: () => ({ transport, note: '' }), llmChannel: { snapshot: () => ({}) },
    sayAgain: { schedule: item => scheduled.push(item) }, ipcAppraiser: { run: async item => { ipc.push(item); return { ok: true } } },
    REFLECT_STATS_SHAPE: shape }
  const harness = new Function(...Object.keys(deps), 'let reflecting=false,pendingReflect=null,writesSinceCleanup=0;const reflectStats={...REFLECT_STATS_SHAPE};\n' +
    fireSource + '\nreturn {fire:fireReflect,stats:()=>({...reflectStats}),idle:()=>!reflecting&&pendingReflect===null}')(...Object.values(deps))
  return { ...harness, store, starts, model, ipc, scheduled, maximum: () => maximum, traceCalls: () => traceCalls,
    finish: async count => { await until(() => harness.idle() && harness.stats().runs === count && ipc.length === count) } }
}

test('008 snapshot preserves value metadata across repeated copies, strict flag, text isolation and agent handle', () => {
  const live = { ...cap('甲'), turnTrace: 'round-a', turnTraceCaptured: true }
  const first = snapshotCapture(live), second = snapshotCapture(first)
  live.userText = ''; live.turnTrace = 'round-b'; live.turnTraceCaptured = false
  assert.deepEqual(second, { ...cap('甲'), agent: live.agent, turnTrace: 'round-a', turnTraceCaptured: true })
  assert.equal(first.agent, live.agent)
  assert.equal(second.agent, live.agent)
  for (const flag of [undefined, false, 1, 'true', {}]) assert.equal(snapshotCapture({ turnTrace: 'round-a', turnTraceCaptured: flag }).turnTraceCaptured, false)
  assert.equal(snapshotCapture({ turnTrace: {}, turnTraceCaptured: true }).turnTrace, '')
  assert.equal(snapshotCapture({ turnTraceCaptured: true }).turnTraceCaptured, true)
})

for (const state of ['known', 'empty', 'throws']) test('008 actual fireReflect microtask preserves ' + state + ' context and does not mutate live slot', async t => {
  let current = 'round-a'
  const trace = { of: () => { if (current === 'throw') throw Error('synthetic trace'); return current } }
  if (state !== 'known') current = state === 'empty' ? '' : 'throw'
  const h = await scheduler(t, { trace }), live = cap('甲'), original = { ...live }
  h.store.setTurnTraceResolver(() => 'round-b')
  h.fire(live)
  assert.deepEqual(live, original, 'metadata belongs to snapshot, not live capture')
  current = 'round-b'; live.userText = ''; live.assistantText = ''; live.lastInjected = ''
  await until(() => h.model.length === 1)
  assert.equal(h.starts[0].userText, '今天去公园散步甲')
  assert.equal(h.starts[0].turnTrace, state === 'known' ? 'round-a' : '')
  assert.equal(h.starts[0].turnTraceCaptured, true)
  h.model[0].gate.resolve(); await h.finish(1)
  const row = assertStoredTag(h.store, '今天去公园散步甲', state === 'known' ? 'round-a' : undefined)
  assert.equal(row.injectedMemories, '合成记忆块甲'); assert.equal(row.injectedProfile, '合成画像甲')
  assert.equal(h.traceCalls(), 1)
  assert.equal(h.maximum(), 1)
})

test('008 explicit captured known context survives re-snapshot without live lookup', async t => {
  const h = await scheduler(t, { trace: { of: () => assert.fail('captured task must not look up live round') } })
  h.store.setTurnTraceResolver(() => assert.fail('captured audit must not look up live round'))
  const live = { ...cap('甲'), turnTrace: 'round-a', turnTraceCaptured: true }
  h.fire(live); live.turnTrace = 'round-new'
  await until(() => h.model.length === 1); h.model[0].gate.resolve(); await h.finish(1)
  assertStoredTag(h.store, '今天去公园散步甲', 'round-a')
  assert.equal(h.traceCalls(), 0)
})

test('008 queued known context keeps its own session after another session advances', async t => {
  const current = new Map([['test-main', 'round-a'], ['test-other', 'round-b']])
  const h = await scheduler(t, { trace: { of: sid => current.get(sid) || '' } })
  h.store.setTurnTraceResolver(sid => current.get(sid) || '')
  h.fire(cap('甲')); await until(() => h.model.length === 1)
  h.fire(cap('乙', 'test-other')); current.set('test-other', 'round-new'); current.set('test-main', 'round-c')
  h.model[0].gate.resolve(); await until(() => h.model.length === 2)
  h.model[1].gate.resolve(); await h.finish(2)
  assertStoredTag(h.store, '今天去公园散步甲', 'round-a')
  const row = assertStoredTag(h.store, '今天去公园散步乙', 'round-b')
  assert.equal(row.sessionId, 'test-other'); assert.equal(h.traceCalls(), 2); assert.equal(h.maximum(), 1)
})

for (const first of ['success', 'null', 'throw']) test('008 queued B retains B after A ' + first + ', slot cleared and current C', async t => {
  let current = 'round-a'
  const h = await scheduler(t, { trace: { of: () => current }, outcomes: first === 'null' ? [null] : [], throwFirst: first === 'throw' })
  h.store.setTurnTraceResolver(() => current)
  h.fire(cap('甲')); await until(() => h.model.length === 1)
  current = 'round-b'; const live = cap('乙'); h.fire(live); live.userText = ''; live.assistantText = ''
  current = 'round-c'
  h.model[0].gate.resolve(); await until(() => h.model.length === 2)
  h.model[1].gate.resolve(); await h.finish(2)
  assert.deepEqual(h.starts.map(r => [r.userText, r.turnTrace, r.turnTraceCaptured]),
    [['今天去公园散步甲', 'round-a', true], ['今天去公园散步乙', 'round-b', true]])
  assertStoredTag(h.store, '今天去公园散步乙', 'round-b')
  assert.equal(h.maximum(), 1); assert.equal(h.traceCalls(), 2)
  assert.equal(h.stats().runs, 2); assert.equal(h.stats().queueMerged, 1); assert.equal(h.stats().busySkipped, 1)
  assert.equal(h.stats().fails, first === 'throw' ? 1 : 0)
  assert.deepEqual(h.ipc.map(r => r.userText), ['今天去公园散步甲', '今天去公园散步乙'])
})

test('008 latest-only queue replaces B with C across sessions and freezes explicit captured unknown', async t => {
  const live = new Map([['test-main', 'round-a'], ['test-other', 'round-b']])
  const h = await scheduler(t, { trace: { of: sid => live.get(sid) || '' } })
  h.store.setTurnTraceResolver(() => 'round-new')
  h.fire(cap('甲')); await until(() => h.model.length === 1)
  h.fire(cap('乙', 'test-other'))
  const c = { ...cap('丙', 'test-other'), turnTrace: '', turnTraceCaptured: true }
  h.fire(c); c.turnTrace = 'round-new'; c.userText = ''
  live.set('test-other', 'round-new')
  h.model[0].gate.resolve(); await until(() => h.model.length === 2)
  h.model[1].gate.resolve(); await h.finish(2)
  assert.deepEqual(h.starts.map(r => [r.userText, r.sessionId, r.turnTrace]),
    [['今天去公园散步甲', 'test-main', 'round-a'], ['今天去公园散步丙', 'test-other', '']])
  assertStoredTag(h.store, '今天去公园散步甲', 'round-a')
  assertStoredTag(h.store, '今天去公园散步丙', undefined)
  assert.equal(h.store.listAudit().some(r => r.userInput === '今天去公园散步乙'), false)
  assert.equal(h.stats().queueMerged, 2); assert.equal(h.stats().busySkipped, 2)
  assert.equal(h.maximum(), 1); assert.equal(h.traceCalls(), 2, 'A/B lookup only; C was captured already')
})

for (const mode of ['empty', 'throws']) test('008 queued unknown from ' + mode + ' never adopts later known round', async t => {
  let state = 'round-a'
  const h = await scheduler(t, { trace: { of: () => { if (state === 'throws') throw Error('synthetic'); return state } } })
  h.store.setTurnTraceResolver(() => 'round-new')
  h.fire(cap('甲')); await until(() => h.model.length === 1)
  state = mode === 'empty' ? '' : 'throws'; h.fire(cap('乙')); state = 'round-new'
  h.model[0].gate.resolve(); await until(() => h.model.length === 2)
  h.model[1].gate.resolve(); await h.finish(2)
  assert.equal(h.starts[1].turnTrace, ''); assert.equal(h.starts[1].turnTraceCaptured, true)
  assertStoredTag(h.store, '今天去公园散步乙', undefined)
  assert.equal(h.traceCalls(), 2)
})

for (const invalidation of ['forget', 'expire']) test('008 actual turn-trace ' + invalidation + ' cannot change accepted context', async t => {
  let now = 1000
  const trace = createTurnTrace({ uuid: () => 'round-a', ttlMs: 1, now: () => now })
  trace.begin('test-main')
  const h = await scheduler(t, { trace })
  h.store.setTurnTraceResolver(sid => trace.of(sid))
  h.fire(cap('甲'))
  if (invalidation === 'forget') trace.forget('test-main'); else now += 2
  assert.equal(trace.of('test-main'), '')
  await until(() => h.model.length === 1); h.model[0].gate.resolve(); await h.finish(1)
  assertStoredTag(h.store, '今天去公园散步甲', 'round-a')
})

test('008 acceptance gates, Qzone independent text and IPC run after each completion', async t => {
  const h = await scheduler(t)
  h.fire({ ...cap('甲'), userText: '', assistantText: '' })
  h.fire({ ...cap('甲'), agent: null })
  h.fire({ ...cap('甲'), agent: { session: { id: 'test-sub', header: { origin: 'subagent', parentSession: 'p', delegationDepth: 1 } } } })
  assert.equal(h.stats().noAgentSkipped, 1); assert.equal(h.stats().subagentSkipped, 1)
  assert.equal(h.starts.length, 0)
  h.fire({ ...cap('甲'), userText: '', qzoneComment: '合成空间评论甲' })
  await until(() => h.model.length === 1)
  assert.equal(h.ipc.length, 0)
  assert.equal(h.starts[0].source, 'qzone'); assert.equal(h.starts[0].layer, '')
  h.model[0].gate.resolve(); await h.finish(1)
  const memory = h.store.db.prepare('SELECT source,layer FROM episodic_memory').get()
  assert.deepEqual({ ...memory }, { source: 'qzone', layer: '' })
  assert.deepEqual(h.ipc, [{ sessionId: 'test-main', userText: '', assistantText: '公园天气很好甲' }])
  assert.equal(h.scheduled.length, 1)
})

const graph = { triplesRaw: 8, triplesSchemaRejected: 2, triplesWritten: 3, triplesRejected: 3,
  learned: 3, graphError: 'synthetic graph note', dropReasons: ['synthetic-drop-a', 'synthetic-drop-b'] }
const ack = { written: [7], quarantined: [], learned: 3, threadsRegistered: 0, name: '合成新名', profileUpdate: { '语言': '合成语言', forbidden: '合成不允许字段' },
  extract: { keywords: ['散步甲'], summary: '合成记忆甲', moodIntensity: 6, moodReason: '合成原因', emotionState: 'neutral', emotionVector: vector, sayAgain: 1, extraReply: '合成补话' },
  stats: { triplesRaw: 8, triplesSchemaRejected: 2, triplesWritten: 3, triplesRejected: 3 }, graphError: 'synthetic graph note',
  triplesRejected: ['synthetic-drop-a', 'synthetic-drop-b'] }
async function deterministicEngine (t, store, mode, gate) {
  const frames = [], nameChanges = []
  const client = { running: true, state: () => ({ breakerOpen: false }), start: async () => ({ version: 'test' }), stop: async () => {},
    request: async (op, args) => { frames.push({ op, args }); if (op === 'extract_prompt') return { prompt: '合成提取提示', schema: {} }; if (op === 'extract_commit') { await gate.promise; return ack }; assert.fail('unexpected test frame') } }
  const engine = createEngine({ store, dbPath: ':memory:', detect: async () => mode === 'python' ? { path: 'unused-test-client' } : null,
    clientOpts: { client }, onNameChange: (...args) => nameChanges.push(args) })
  assert.equal(await engine.init(), mode); t.after(() => engine.stop())
  return { engine, frames, nameChanges }
}
for (const mode of ['baseline', 'python']) for (const context of ['known', 'unknown', 'legacy', 'legacy-known']) {
  test('008 actual engine ' + mode + ' delayed ' + context + ' audit preserves metadata and business fields', async t => {
    const store = fresh(t), gate = deferred(), started = deferred()
    store.saveProfileTraits({ '代词': '合成代词' })
    let current = 'round-a'
    store.setTurnTraceResolver(() => current)
    const { engine, frames, nameChanges } = await deterministicEngine(t, store, mode, gate)
    const transport = { mode: 'llm', structured: async () => { started.resolve(); if (mode === 'baseline') await gate.promise; return raw('甲') } }
    const extra = context.startsWith('legacy') ? { traceId: context === 'legacy-known' ? 'round-a' : '' }
      : { turnTrace: context === 'known' ? 'round-a' : '', turnTraceCaptured: true, traceId: 'round-conflict' }
    const pending = engine.reflect(transport, { userText: '今天去公园散步甲', assistantText: '公园天气很好甲', parent: cap('甲').agent,
      sessionId: 'test-main', injectedMemories: '合成记忆块甲', injectedProfile: '合成画像甲', latencyMs: 27, ...extra })
    await started.promise; current = 'round-b'; gate.resolve()
    assert.notEqual(await pending, null)
    const expectedTag = context === 'unknown' ? undefined : context === 'legacy' ? 'round-b' : 'round-a'
    const row = assertStoredTag(store, '今天去公园散步甲', expectedTag)
    assert.equal(row.llmReply, '公园天气很好甲'); assert.equal(row.sessionId, 'test-main')
    assert.equal(row.injectedMemories, '合成记忆块甲'); assert.equal(row.injectedProfile, '合成画像甲')
    assert.equal(row.latency, 27); assert.equal(row.stage, mode === 'python' ? 'extract' : 'reflect'); assert.equal(row.step, 7)
    assert.equal(row.moodIntensity, 6); assert.equal(row.prevMoodIntensity, 3); assert.deepEqual(row.emotionVector, vector)
    assert.equal(row.emotionDelta, '无变化'); assert.equal(store.getState().moodIntensity, 6); assert.deepEqual(store.getState().emotionVector, vector)
    assert.equal(store.getProfile().name, '合成新名')
    if (mode === 'python') {
      assert.deepEqual(JSON.parse(row.stageDetail), { ...graph, ...(expectedTag ? { turnTrace: expectedTag } : {}) })
      assert.deepEqual(store.getProfile().coreTraits, ['语言:合成语言', '代词:合成代词'])
      assert.deepEqual(JSON.parse(store.db.prepare('SELECT core_traits FROM user_profile WHERE user_id = ?').get(MASTER_ID).core_traits), { '代词': '合成代词', '语言': '合成语言' })
      assert.equal(row.sayAgain, 1); assert.equal(row.extraReply, '合成补话')
      assert.deepEqual(nameChanges, [['合成旧名', '合成新名']])
      assert.deepEqual(frames.map(r => r.op), ['extract_prompt', 'extract_commit'])
      assert.deepEqual(Object.keys(frames[1].args).sort(), ['dedupe', 'sessionId', 'structured', 'text', 'userId'])
      assert.equal(store.memoryStats().episodicTotal, 0, 'client test seam supplies ack; no claim of worker memory writes')
    } else {
      assert.deepEqual(store.getProfile().coreTraits, ['代词:合成代词'])
      const memory = store.db.prepare('SELECT summary, keywords, source, layer FROM episodic_memory').get()
      assert.deepEqual({ ...memory }, { summary: '合成记忆甲', keywords: '["散步甲"]', source: 'dsh', layer: '' })
    }
  })
}

for (const known of [true, false]) test('008 isolated real Python worker delayed result preserves ' + (known ? 'known' : 'unknown') + ' context', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'echo-round-context-')), dbPath = join(dir, 'test.db'), store = openStore(dbPath)
  let engine
  t.after(async () => { await engine?.stop(); store.close(); rmSync(dir, { recursive: true, force: true }) })
  store.db.prepare('INSERT OR IGNORE INTO user_profile (user_id,name) VALUES (?,?)').run(MASTER_ID, '合成旧名')
  store.saveState({ moodIntensity: 3, prevMoodIntensity: 3, emotionVector: vector })
  engine = createEngine({ store, dbPath, detect: detectPython })
  assert.equal(await engine.init(), 'python')
  const gate = deferred(), started = deferred()
  const transport = { mode: 'llm', structured: async () => { started.resolve(); await gate.promise; return raw('甲') } }
  store.setTurnTraceResolver(() => 'round-b')
  const pending = engine.reflect(transport, { userText: '今天去公园散步甲', assistantText: '公园天气很好甲', parent: cap('甲').agent,
    sessionId: 'test-main', turnTrace: known ? 'round-a' : '', turnTraceCaptured: true })
  await started.promise; gate.resolve()
  const out = await pending
  assert.notEqual(out, null); assert.equal(out.written.length, 1)
  assertStoredTag(store, '今天去公园散步甲', known ? 'round-a' : undefined)
  assert.equal(store.memoryStats().episodicTotal, 1)
  assert.equal(store.getState().moodIntensity, 6)
})

for (const flag of [undefined, false, 0, 1, 'true', {}, true]) for (const known of [false, true]) {
  test('008 strict store selection ' + (typeof flag) + ':' + String(flag) + ' known=' + known, t => {
    const store = fresh(t)
    let resolverCalls = 0
    store.setTurnTraceResolver(() => { resolverCalls++; return 'round-live' })
    store.writeAudit({ traceId: 'same-event', sessionId: 'test-main', userInput: 'before',
      stageDetail: JSON.stringify(known ? { turnTrace: 'round-old', kept: 7 } : { kept: 7 }), turnTraceCaptured: flag })
    const expectedTag = known ? 'round-old' : flag === true ? undefined : 'round-live'
    const rows = store.listAudit()
    assert.equal(tag(rows[0]), expectedTag); assert.equal(resolverCalls, flag === true ? 0 : 1)
    assert.equal(Object.hasOwn(rows[0], 'turnTraceCaptured'), false)
    store.writeAudit({ traceId: 'same-event', sessionId: 'test-main', userInput: 'after', stageDetail: 'not-json', turnTraceCaptured: flag })
    assert.equal(store.listAudit().length, 1); assert.equal(store.listAudit()[0].userInput, 'after')
    assert.equal(store.listAudit()[0].stageDetail, 'not-json')
  })
}

test('008 throwing resolver preserves explicit captured detail and old fallback error behavior', t => {
  const store = fresh(t)
  let calls = 0
  store.setTurnTraceResolver(() => { calls++; throw Error('synthetic resolver') })
  store.writeAudit({ traceId: 'captured', sessionId: 'test-main', stageDetail: '{"kept":1}', turnTraceCaptured: true })
  assert.equal(calls, 0)
  store.writeAudit({ traceId: 'legacy', sessionId: 'test-main', stageDetail: '{"kept":2}' })
  assert.equal(calls, 1)
  assert.deepEqual(store.listAudit().map(r => JSON.parse(r.stageDetail).kept).sort(), [1, 2])
})

test('008 actual persisted async rows belong to original turns and actual public key survives row ID changes', async t => {
  let current = 'round-a'
  const h = await scheduler(t, { trace: { of: () => current } })
  h.store.setTurnTraceResolver(() => current)
  h.store.writeAudit({ traceId: 'input-a', userInput: '今天去公园散步甲', toolCall: 'relay_in', sessionId: 'test-main', stageDetail: '{"turnTrace":"round-a"}' })
  h.fire(cap('甲')); current = 'round-b'
  h.store.writeAudit({ traceId: 'input-b', userInput: '今天去公园散步乙', toolCall: 'relay_in', sessionId: 'test-main', stageDetail: '{"turnTrace":"round-b"}' })
  await until(() => h.model.length === 1); h.model[0].gate.resolve(); await h.finish(1)
  const rows = h.store.listAudit()
  const expected = { 'round-a': [['extract', '今天去公园散步甲'], ['relay_in', '今天去公园散步甲']], 'round-b': [['relay_in', '今天去公园散步乙']] }
  for (const input of [rows, rows.slice().reverse(), rows.map(r => ({ ...r, traceId: randomUUID() }))]) {
    const turns = buildTurns(input)
    assert.equal(turns.length, 2)
    assert.deepEqual(Object.fromEntries(turns.map(turn => [turn.id, turn.rows.map(r => [r.toolCall, r.userInput]).sort()])), expected)
    for (const turn of turns) assert.equal(roundKeyOf(turn), roundKeyOf({ id: turn.id }))
  }
})
