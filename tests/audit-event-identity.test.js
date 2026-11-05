/** ECHO-007: execute production audit boundaries against real in-memory SQLite. */
import './_isolate.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { openStore, MASTER_ID } from '../lib/store.js'
import { sectionCounts } from '../lib/context.js'
import { createToolAudit } from '../lib/tool-audit.js'
import { createTurnStopper } from '../lib/turn-stopping.js'
import { commitExtract } from '../lib/reflect.js'

const source = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
function between (text, start, end) {
  const a = text.indexOf(start), b = text.indexOf(end, a + start.length)
  assert.ok(a >= 0 && b > a, 'actual production block must be found')
  return text.slice(a, b)
}
const injectionSource = between(source, '    onInject: (info) => {', '\n  })')
const stopperSource = between(source, 'const EVENT_STEP = ', '\n  // turn-stopping 的 payload')
function evaluate (body, deps) { return new Function(...Object.keys(deps), body)(...Object.values(deps)) }
function injectWith (store, traceOf = () => 'fixture-turn-a') {
  return evaluate('return ({\n' + injectionSource + '\n}).onInject', {
    store, turnTrace: { of: traceOf }, randomUUID, sectionCounts,
    personaCache: { prefix: '人格前段', suffix: '人格后段' }, sessionEnabled: () => true
  })
}
function stopperWith (store, traceOf = () => 'fixture-turn-a', settings = {}, warnings = []) {
  // Execute both the actual wrapper and its actual createTurnStopper registration.
  return evaluate(stopperSource + '\nreturn turnStopper', {
    store, randomUUID, createTurnStopper, MASTER_ID,
    ctx: { logger: { warn: () => warnings.push('warning'), info () {} } },
    readEnabled: () => true, sessionEnabled: () => true, readSettings: () => settings,
    createUserMessage: value => value, turnTrace: { of: traceOf }
  })
}
const sandbox = {}
evaluate(readFileSync(new URL('../web/audit-view.js', import.meta.url), 'utf8'), { globalThis: sandbox })
const buildTurns = sandbox.EchoAuditView.buildTurns
const publicSource = readFileSync(new URL('../web/mock/final/views/audit.js', import.meta.url), 'utf8')
const roundKeyOf = evaluate('return (' + between(publicSource, '  function roundKeyOf(turn) {', '  function detailOf(').trim() + ')', {})
const sid = 'fixture-session'
const frozenMs = 1_800_000_000_123
const vector = {
  global: { fatigue: 2, valence: 2, arousal: 3, dominance: 4 },
  target_master: { affection: 8, playfulness: 7, sadness: 0, dependency: 6 },
  ipc_dyad: { retained: 1 }
}
const nextVector = {
  global: { fatigue: 3, valence: 2, arousal: 3, dominance: 4 },
  target_master: { affection: 7, playfulness: 7, sadness: 0, dependency: 6 },
  ipc_dyad: { retained: 1 }
}
const injected = '【现在】A\n【情景记忆】B\n[使用纪律]C'
const injection = { sessionId: sid, query: 'fixture-user', text: injected, profileSnapshot: 'fixture-profile', ms: 12 }
const extract = {
  summary: '合成提取摘要', keywords: ['合成关键词'], askKeys: ['合成问法'], emotionScore: 7,
  name: '合成用户', moodIntensity: 6, emotionState: 'calm', moodReason: '合成原因', emotionVector: nextVector
}
const extractArgs = { userText: 'fixture-user', assistantText: 'fixture-reply', injectedMemories: injected,
  injectedProfile: 'fixture-profile', latencyMs: 29, sessionId: sid, traceId: 'fixture-turn-a', source: 'qzone', layer: '' }
const detail = { now: 6, time: 0, paths: 0, epi: 8, state: 0, rules: 7, ack: 0, total: 21,
  persona: 4, personaRules: 4, personaActive: true }
const expectedEmotionPack = [
  '上一轮结束时你的情绪强度是 3/10,这一句之后变成 4/10(变化 +1)。',
  '这句话没有改变你的情绪,延续着上一轮的状态。',
  '当下整体感受:有一点在意,语气里带得出亲近。',
  '触发点:合成旧原因。',
  '- 身体与整体: 疲惫 2/10(有点累),心情不错(+2),唤醒度 3/10(状态在线)。',
  '- 对眼前的人(用户): 爱意 8/10(爱意几乎满格)、调皮 7/10(玩心爆棚)、委屈 0/10(没什么委屈)、依赖 6/10(非常依赖)。',
  '- 剧本: 看到用户来了；亲近感和玩心立刻占了上风,语气比平时更活；按你们一贯的相处方式对待用户,分寸里全是亲近；绝对不对用户使用冷漠或轻蔑的语气 —— 在他面前,你的温度不许打折。',
  '行为要求:让语气、句长和用词贴合这个强度 —— 强度越高,句子越短、越直白、越少修饰;情绪往下掉时,回复更轻、更慢、更少主动挑起话题,但安静不等于变冷 —— 短也要短得有温度,别把话收干。'
].join('\n')
function fresh (t) {
  const store = openStore(':memory:')
  store.db.prepare('INSERT OR IGNORE INTO user_profile (user_id, name) VALUES (?, ?)').run(MASTER_ID, '合成初名')
  store.saveState({ moodIntensity: 4, prevMoodIntensity: 3, userEmotion: 'neutral',
    moodReason: '合成旧原因', currentTopic: '合成旧话题', emotionVector: vector })
  t.after(() => store.close())
  return store
}
function defaults (over) {
  return { sessionId: sid, userInput: '', injectedMemories: '', injectedProfile: '', emotionPack: '',
    llmReply: '', latency: 0, moodIntensity: 0, prevMoodIntensity: 0, emotionVector: {}, emotionDelta: '',
    toolCall: '', stage: '', step: 0, stageDetail: {}, ...over }
}
const fields = ['sessionId', 'userInput', 'injectedMemories', 'injectedProfile', 'emotionPack', 'llmReply',
  'latency', 'moodIntensity', 'prevMoodIntensity', 'emotionVector', 'emotionDelta', 'toolCall', 'stage', 'step', 'stageDetail']
const columns = ['session_id', 'user_input', 'injected_memories', 'injected_profile', 'emotion_pack', 'llm_reply',
  'latency', 'mood_intensity', 'prev_mood_intensity', 'emotion_vector', 'emotion_delta', 'tool_call', 'stage', 'step', 'stage_detail']
const parseDetail = value => value ? JSON.parse(value) : {}
function assertEvents (store, expected, tag = 'fixture-turn-a') {
  const sql = store.db.prepare('SELECT * FROM audit_logs ORDER BY rowid').all()
  const listed = store.listAudit(0, 500)
  assert.equal(sql.length, expected.length, 'SQL must retain every independent event')
  assert.equal(listed.length, expected.length, 'listAudit must retain every independent event')
  assert.equal(new Set(sql.map(row => row.trace_id)).size, expected.length, 'row IDs must be distinct')
  for (const [i, wanted] of expected.entries()) {
    const row = sql[i], listedRow = listed.find(item => item.traceId === row.trace_id)
    assert.match(row.trace_id, /^[0-9a-f-]{36}$/u)
    assert.notEqual(row.trace_id, tag)
    assert.equal(row.timestamp, frozenMs / 1000, 'same millisecond for every write')
    const sqlFields = Object.fromEntries(fields.map((key, n) => [key,
      key === 'emotionVector' ? JSON.parse(row[columns[n]]) : key === 'stageDetail' ? parseDetail(row[columns[n]]) : row[columns[n]]]))
    const listFields = Object.fromEntries(fields.map(key => [key, key === 'stageDetail' ? parseDetail(listedRow[key]) : listedRow[key]]))
    const fullExpected = { ...wanted, stageDetail: { ...wanted.stageDetail, ...(tag ? { turnTrace: tag } : {}) } }
    assert.deepEqual(sqlFields, fullExpected, 'SQL event fields at checkpoint ' + (i + 1))
    assert.deepEqual(listFields, fullExpected, 'listAudit event fields at checkpoint ' + (i + 1))
  }
  return listed
}
const expectedInject = () => defaults({ toolCall: 'inject', stage: 'assemble', step: 3, userInput: 'fixture-user',
  injectedMemories: injected, injectedProfile: 'fixture-profile', latency: 12, stageDetail: detail })
const capture = { longingRead: { pre: { exists: true, value: 8, threshold: 7, due: true } }, turnText: '合成普通回复', fromPlatform: true }
function agentWith (steer = () => {}) { return { session: { id: sid }, steer } }

test('007 real same-millisecond inject/tools/repeated tool/steer/extract retain all six events and grouping', async t => {
  t.mock.method(Date, 'now', () => frozenMs)
  const store = fresh(t), expected = []
  store.setTurnTraceResolver(() => 'fixture-turn-a')
  injectWith(store)(injection)
  expected.push(expectedInject())
  assertEvents(store, expected)
  let toolMs = 100
  const hooks = new Map(), decision = { kind: 'deny', reason: 'fixture-decision' }
  const audit = createToolAudit({ store, traceOf: () => 'fixture-turn-a', now: () => toolMs })
  audit.attach({ on: (event, fn) => { hooks.set(event, fn); return () => hooks.delete(event) } })
  const calls = [
    { name: 'run_code', args: { code: 'one' }, result: { isError: false, content: [{ text: 'result-one' }] }, start: 100, end: 137,
      want: defaults({ toolCall: 'run_code', stage: 'tool:run_code', step: 4, userInput: '(工具) run_code {"code":"one"}', llmReply: 'ok · result-one', latency: 37 }) },
    { name: 'read_file', args: { file: 'two' }, result: { isError: true, error: 'result-two' }, start: 200, end: 205,
      want: defaults({ toolCall: 'read_file', stage: 'tool:read_file', step: 4, userInput: '(工具) read_file {"file":"two"}', llmReply: 'failed · [错误] result-two', latency: 5 }) },
    { name: 'run_code', args: { code: 'three' }, result: { ok: true, text: 'result-three' }, start: 300, end: 307,
      want: defaults({ toolCall: 'run_code', stage: 'tool:run_code', step: 4, userInput: '(工具) run_code {"code":"three"}', llmReply: 'ok · result-three', latency: 7 }) }
  ]
  for (const call of calls) {
    const exec = { name: call.name, args: call.args, agent: agentWith() }
    toolMs = call.start
    assert.equal(await hooks.get('tools/pre-execute')(exec, async () => decision), decision)
    toolMs = call.end
    assert.equal(await hooks.get('tools/post-execute')(exec, call.result, async () => decision), decision)
    expected.push(call.want)
    assertEvents(store, expected)
  }
  assert.deepEqual(audit.stats(), { seen: 3, written: 3, skippedPower: 0, skippedScope: 0, ownSkipped: 0, failed: 0,
    byName: { run_code: 2, read_file: 1 }, at: 307 })
  assert.equal(audit.turnTools(sid), 3)
  let steers = 0
  const stopper = stopperWith(store, undefined, { longing: { cooldown_minutes: 5 } })
  const agent = agentWith(() => { steers++ })
  assert.deepEqual(await stopper.handle({ agent, turn: 1, capture }), { steer: true, reason: 'due-and-unsaid', value: 8, threshold: 7, steered: true })
  expected.push(defaults({ toolCall: 'longing_steer', stage: 'longing_steer', step: 8, userInput: '想念 8.0 ≥ 7.0 未表达',
    moodIntensity: 4, prevMoodIntensity: 4, emotionVector: vector, latency: null }))
  assertEvents(store, expected)
  assert.equal((await stopper.handle({ agent, turn: 1, capture })).reason, 'already-steered')
  assert.equal((await stopper.handle({ agent, turn: 2, capture })).reason, 'cooldown')
  assert.equal(steers, 1)
  assertEvents(store, expected)
  const committed = commitExtract(store, extract, extractArgs)
  expected.push(defaults({ toolCall: 'extract', stage: 'reflect', step: 7, userInput: 'fixture-user', llmReply: 'fixture-reply',
    injectedMemories: injected, injectedProfile: 'fixture-profile', emotionPack: expectedEmotionPack, latency: 29,
    moodIntensity: 6, prevMoodIntensity: 4, emotionVector: nextVector, emotionDelta: '整体[疲惫+1]; 对主人[爱意-1]' }))
  const rows = assertEvents(store, expected)
  assert.deepEqual(committed.extract, extract)
  const memories = store.listMemories({ state: 'all' })
  assert.equal(memories.total, 1)
  assert.equal(memories.rows[0].memoryId, committed.memoryId)
  assert.equal(memories.rows[0].summary, '合成提取摘要')
  assert.equal(memories.rows[0].emotionScore, 7)
  const memory = store.db.prepare('SELECT keywords, source, layer, temporal_status, aug_keys FROM episodic_memory WHERE memory_id = ?').get(committed.memoryId)
  assert.deepEqual({ ...memory }, { keywords: '["合成关键词"]', source: 'qzone', layer: '', temporal_status: 'time_unknown', aug_keys: '["合成问法"]' })
  assert.equal(store.getProfile().name, '合成用户')
  assert.deepEqual(store.getState(), { moodIntensity: 6, prevMoodIntensity: 4, userEmotion: 'calm', moodReason: '合成原因',
    currentTopic: '合成关键词', emotionVector: nextVector, previousEmotionVector: vector, updatedAt: frozenMs / 1000 })
  const turns = buildTurns(rows)
  assert.equal(turns.length, 1)
  assert.equal(turns[0].id, 'fixture-turn-a')
  const membership = ['inject', 'longing_steer', 'extract', 'run_code', 'read_file', 'run_code'].sort()
  assert.deepEqual(turns[0].rows.map(row => row.toolCall).sort(), membership)
  assert.deepEqual(turns[0].rows.map(row => row.userInput).sort(), expected.map(row => row.userInput).sort())
  const changedIDs = buildTurns(rows.map(row => ({ ...row, traceId: randomUUID() })))
  assert.equal(changedIDs.length, 1)
  assert.equal(changedIDs[0].id, 'fixture-turn-a')
  assert.deepEqual(changedIDs[0].rows.map(row => [row.toolCall, row.userInput]).sort(),
    expected.map(row => [row.toolCall, row.userInput]).sort())
  assert.match(roundKeyOf(turns[0]), /^[0-9a-f]{10}$/u)
  assert.equal(roundKeyOf(changedIDs[0]), roundKeyOf(turns[0]), 'actual public key must be independent of row IDs')
})

for (const mode of ['absent', 'empty', 'throws']) {
  test('007 event writers survive store resolver ' + mode + ' without a round tag', async t => {
    t.mock.method(Date, 'now', () => frozenMs)
    const store = fresh(t)
    if (mode !== 'absent') store.setTurnTraceResolver(() => { if (mode === 'throws') throw Error('fixture-resolver'); return '' })
    injectWith(store, () => '')(injection)
    const audit = createToolAudit({ store, traceOf: () => '' })
    assert.equal(audit.record({ name: 'empty_trace', args: {}, agent: agentWith() }, { ok: true, text: 'empty-result' }), 'written')
    assert.equal((await stopperWith(store, () => '').handle({ agent: agentWith(), turn: 1, capture })).steered, true)
    const committed = commitExtract(store, extract, { ...extractArgs, traceId: '' })
    assert.ok(committed.memoryId)
    const rows = store.listAudit()
    assert.equal(rows.length, 4)
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM audit_logs').get().n, 4)
    assert.equal(new Set(rows.map(row => row.traceId)).size, 4)
    assert.deepEqual(rows.map(row => row.toolCall).sort(), ['empty_trace', 'extract', 'inject', 'longing_steer'])
    for (const row of rows) { assert.match(row.traceId, /^[0-9a-f-]{36}$/u); assert.equal(parseDetail(row.stageDetail).turnTrace, undefined) }
    assert.deepEqual(parseDetail(rows.find(row => row.toolCall === 'inject').stageDetail), detail)
  })
  test('007 explicit captured old round survives store resolver ' + mode, async t => {
    t.mock.method(Date, 'now', () => frozenMs)
    const store = fresh(t)
    if (mode !== 'absent') store.setTurnTraceResolver(() => { if (mode === 'throws') throw Error('fixture-resolver'); return '' })
    injectWith(store)(injection)
    createToolAudit({ store, traceOf: () => 'fixture-turn-a' }).record({ name: 'captured', agent: agentWith() }, { ok: true })
    await stopperWith(store).handle({ agent: agentWith(), turn: 1, capture })
    commitExtract(store, extract, extractArgs)
    const rows = store.listAudit()
    assert.equal(rows.length, 4)
    assert.equal(new Set(rows.map(row => row.traceId)).size, 4)
    for (const row of rows) assert.equal(parseDetail(row.stageDetail).turnTrace, 'fixture-turn-a')
  })
}

test('007 captured round beats advanced resolver at every boundary, including delayed JS extract', async t => {
  const store = fresh(t)
  store.setTurnTraceResolver(() => 'fixture-turn-new')
  injectWith(store)(injection)
  createToolAudit({ store, traceOf: () => 'fixture-turn-a' }).record({ name: 'captured', agent: agentWith() }, { ok: true })
  await stopperWith(store).handle({ agent: agentWith(), turn: 1, capture })
  commitExtract(store, extract, extractArgs)
  const rows = store.listAudit()
  assert.equal(rows.length, 4)
  for (const row of rows) assert.equal(parseDetail(row.stageDetail).turnTrace, 'fixture-turn-a')
  assert.equal(buildTurns(rows).length, 1)
})

test('007 two explicit rounds have independent handwritten memberships in either input order', t => {
  t.mock.method(Date, 'now', () => frozenMs)
  const store = fresh(t)
  injectWith(store)(injection)
  createToolAudit({ store, traceOf: () => 'fixture-turn-a' }).record({ name: 'alpha', agent: agentWith() }, { ok: true })
  injectWith(store, () => 'fixture-turn-b')({ ...injection, query: 'fixture-second-user' })
  createToolAudit({ store, traceOf: () => 'fixture-turn-b' }).record({ name: 'beta', agent: agentWith() }, { ok: true })
  const rows = store.listAudit()
  assert.equal(rows.length, 4)
  for (const input of [rows, rows.slice().reverse()]) {
    const turns = buildTurns(input)
    assert.equal(turns.length, 2)
    assert.deepEqual(Object.fromEntries(turns.map(turn => [turn.id, turn.rows.map(row => [row.toolCall, row.userInput]).sort()])), {
      'fixture-turn-a': [['alpha', '(工具) alpha '], ['inject', 'fixture-user']],
      'fixture-turn-b': [['beta', '(工具) beta '], ['inject', 'fixture-second-user']]
    })
  }
})

test('007 upstream trace failures keep existing inject/tool/steer degradation', async t => {
  const store = fresh(t), warnings = [], fail = () => { throw Error('fixture-trace') }
  injectWith(store, fail)(injection)
  const audit = createToolAudit({ store, traceOf: fail, logger: { warn: () => warnings.push('warning') } })
  assert.equal(audit.record({ name: 'failed_trace', agent: agentWith() }, {}), 'fail:write')
  assert.equal(audit.stats().failed, 1)
  assert.equal(audit.stats().written, 0)
  assert.equal(audit.turnTools(sid), 1)
  let steers = 0
  const stopper = stopperWith(store, fail)
  assert.equal((await stopper.handle({ agent: agentWith(() => { steers++ }), turn: 1, capture })).steered, true)
  assert.equal(store.listAudit().length, 1, 'stopper trace adapter catches failure and wrapper writes without a tag')
  assert.equal(parseDetail(store.listAudit()[0].stageDetail).turnTrace, undefined)
  assert.equal(steers, 1)
  assert.equal(warnings.length, 1)
})

test('007 actual wrapper write failure preserves steer success, same-turn dedupe and cooldown', async t => {
  const store = fresh(t), warnings = []
  t.mock.method(Date, 'now', () => frozenMs)
  t.mock.method(store, 'writeAudit', () => { throw Error('fixture-write') })
  let steers = 0
  const agent = agentWith(() => { steers++ }), stopper = stopperWith(store, undefined, { longing: { cooldown_minutes: 5 } }, warnings)
  assert.equal((await stopper.handle({ agent, turn: 1, capture })).steered, true)
  assert.equal((await stopper.handle({ agent, turn: 1, capture })).reason, 'already-steered')
  assert.equal((await stopper.handle({ agent, turn: 2, capture })).reason, 'cooldown')
  assert.equal(steers, 1)
  assert.equal(warnings.length, 1)
  assert.equal(store.listAudit().length, 0)
})

test('007 steer throw still downgrades and can retry, cooldown expires with actual wrapper', async t => {
  const store = fresh(t)
  let ms = frozenMs, steers = 0
  t.mock.method(Date, 'now', () => ms)
  const stopper = stopperWith(store, undefined, { longing: { cooldown_minutes: 5 } })
  const bad = await stopper.handle({ agent: agentWith(() => { throw Error('fixture-steer') }), turn: 1, capture })
  assert.equal(bad.reason, 'error')
  assert.equal(store.listAudit().length, 0)
  const agent = agentWith(() => { steers++ })
  assert.equal((await stopper.handle({ agent, turn: 1, capture })).steered, true)
  ms += 5 * 60000
  assert.equal((await stopper.handle({ agent, turn: 2, capture })).steered, true)
  assert.equal(steers, 2)
  assert.equal(store.listAudit().length, 2)
})

test('007 direct same-event writeAudit retains replacement semantics and explicit branch suffixes', t => {
  const store = fresh(t)
  store.setTurnTraceResolver(() => 'fixture-turn-a')
  const row = { traceId: 'fixture-event-id', sessionId: sid, userInput: 'before', toolCall: 'fixture' }
  store.writeAudit(row)
  store.writeAudit({ ...row, userInput: 'after' })
  assert.equal(store.listAudit().length, 1)
  assert.equal(store.listAudit()[0].userInput, 'after')
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM audit_logs').get().n, 1)
  for (const arm of ['retrieve', 'emotion']) store.writeAudit({ ...row, traceId: 'fixture-turn-a#' + arm,
    toolCall: arm, stageDetail: JSON.stringify({ turnTrace: 'fixture-turn-a' }) })
  const rows = store.listAudit()
  assert.equal(rows.length, 3)
  assert.deepEqual(rows.map(row => row.traceId).sort(), ['fixture-event-id', 'fixture-turn-a#emotion', 'fixture-turn-a#retrieve'])
  assert.equal(buildTurns(rows)[0].rows.length, 3)
})
