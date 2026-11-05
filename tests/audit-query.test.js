/** ECHO-002：仅内存库；直接插入查询夹具，避免把保留策略混进取数契约。 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { openStore } from '../lib/store.js'

function fixture (t) {
  const store = openStore(':memory:', { auditKeep: 1000 })
  t.after(() => store.close())
  const insert = store.db.prepare(
    'INSERT INTO audit_logs (trace_id, session_id, timestamp) VALUES (?, ?, ?)'
  )
  store.db.exec('BEGIN')
  for (const at of [10, 20, 30]) insert.run('target-' + at, 'fixture-target', at)
  for (let i = 1; i <= 600; i++) insert.run('noise-' + i, 'fixture-noise', 1000 + i)
  store.db.exec('COMMIT')
  return store
}

test('会话过滤在截窗之前：目标旧行不被全局最近 200 条挤掉', (t) => {
  const store = fixture(t)
  const global = store.listAudit(0, 200)
  assert.equal(global.length, 200)
  assert.ok(global.every(row => row.sessionId === 'fixture-noise'))
  assert.deepEqual(store.listAudit(0, 200, false, 'fixture-target').map(row => row.timestamp), [30, 20, 10])
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM audit_logs').get().n, 603)
})

test('since 严格大于边界，并与会话过滤、倒序和 limit 组合', (t) => {
  const store = fixture(t)
  assert.deepEqual(store.listAudit(10, 2, false, 'fixture-target').map(row => row.timestamp), [30, 20])
  assert.deepEqual(store.listAudit(10, 1, false, 'fixture-target').map(row => row.timestamp), [30])
  assert.deepEqual(store.listAudit(30, 10, false, 'fixture-target'), [])
  assert.deepEqual(store.listAudit('20', 10, false, 'fixture-target').map(row => row.timestamp), [30])
  assert.deepEqual(store.listAudit('invalid', 10, false, 'fixture-target').map(row => row.timestamp), [30, 20, 10])
})

test('空或省略会话保持旧调用；未知、空白和大小写不同的会话不回退', (t) => {
  const store = fixture(t)
  const legacy = store.listAudit(0, 3, false)
  for (const session of ['', undefined, null]) {
    assert.deepEqual(store.listAudit(0, 3, false, session), legacy)
  }
  for (const session of ['fixture-missing', ' ', 'FIXTURE-TARGET']) {
    assert.deepEqual(store.listAudit(0, 10, false, session), [])
  }
  store.db.prepare('INSERT INTO audit_logs (trace_id, session_id, timestamp) VALUES (?, ?, ?)')
    .run('spaced', ' fixture-target ', 40)
  assert.deepEqual(store.listAudit(0, 10, false, ' fixture-target ').map(row => row.timestamp), [40])
})

const limitCases = [
  ['省略', undefined, 50], ['空值', null, 50], ['空串', '', 50], ['空白', ' ', 50],
  ['零', 0, 50], ['负零', -0, 50], ['NaN', NaN, 50], ['正无穷', Infinity, 50],
  ['负无穷', -Infinity, 50], ['非法数字串', 'invalid', 50], ['无穷串', 'Infinity', 50],
  ['负数', -8, 1], ['负小数', -2.7, 1], ['小于一', 0.5, 1], ['小数', 2.9, 2],
  ['数字串', '7', 7], ['小数字串', '3.8', 3], ['五百', 500, 500],
  ['超上限', 501, 500], ['超上限小数', 500.9, 500], ['大整数', Number.MAX_SAFE_INTEGER, 500]
]

test('limit 默认 50、最大 500；异常与小数不会触发 SQLite LIMIT 类型错误', async (t) => {
  const store = fixture(t)
  assert.equal(store.listAudit().length, 50)
  for (const [label, limit, expected] of limitCases) {
    await t.test(label, () => {
      const rows = store.listAudit(0, limit, false, 'fixture-noise')
      assert.equal(rows.length, expected)
      assert.equal(rows[0].timestamp, 1600)
      assert.equal(rows.at(-1).timestamp, 1601 - expected)
    })
  }
})

test('since、会话和 limit 均绑定；SQL 字符只按完整会话值匹配', (t) => {
  const store = fixture(t)
  const session = "fixture' OR 1=1 --"
  store.db.prepare('INSERT INTO audit_logs (trace_id, session_id, timestamp) VALUES (?, ?, ?)')
    .run('quoted', session, 40)
  const prepare = store.db.prepare.bind(store.db)
  const calls = []
  const spy = t.mock.method(store.db, 'prepare', (sql) => {
    const statement = prepare(sql)
    return { all: (...args) => { calls.push({ sql, args }); return statement.all(...args) } }
  })
  try {
    assert.deepEqual(store.listAudit(30, 1, false, session).map(row => row.timestamp), [40])
    assert.equal(calls.length, 1)
    assert.ok(!calls[0].sql.includes(session))
    assert.match(calls[0].sql, /WHERE timestamp > \? AND session_id = \? ORDER BY timestamp DESC LIMIT \?$/)
    assert.deepEqual(calls[0].args, [30, session, 1])
    assert.deepEqual(store.listAudit(0, 1, false, "absent' OR 1=1 --"), [])
  } finally { spy.mock.restore() }
})

test('旧三参数与带会话查询保持完整字段、light 截断及 JSON/null 语义', (t) => {
  const store = fixture(t)
  const profile = 'P'.repeat(750)
  const memories = 'M'.repeat(850)
  const pack = 'E'.repeat(750)
  const structured = JSON.stringify({ value: 'S'.repeat(750) })
  const state = { value: 'A'.repeat(750) }
  const reply = 'R'.repeat(850)
  store.db.prepare(
    'UPDATE audit_logs SET injected_profile = ?, injected_memories = ?, emotion_pack = ?,' +
    ' emotion_pack_structured = ?, agent_state = ?, llm_reply = ?, latency = 1.25,' +
    ' mood_intensity = 5, prev_mood_intensity = 4, emotion_vector = ?, emotion_delta = ?,' +
    ' tool_call = ?, stage = ?, step = 2, stage_detail = ?, say_again = 1, extra_reply = ?' +
    ' WHERE trace_id = ?'
  ).run(profile, memories, pack, structured, JSON.stringify(state), reply,
    '{"affection":3}', 'delta', 'fixture-tool', 'fixture-stage', '{"result":"ok"}', 'extra', 'noise-600')
  const expected = {
    traceId: 'noise-600', sessionId: 'fixture-noise', userInput: '',
    injectedProfile: profile, injectedMemories: memories, emotionPack: pack,
    emotionPackStructured: structured, agentState: state, llmReply: reply, latency: 1.25,
    moodIntensity: 5, prevMoodIntensity: 4, emotionVector: { affection: 3 }, emotionDelta: 'delta',
    toolCall: 'fixture-tool', stage: 'fixture-stage', step: 2, stageDetail: '{"result":"ok"}',
    sayAgain: 1, extraReply: 'extra', timestamp: 1600
  }
  assert.deepEqual(store.listAudit(0, 1, false), [expected])
  assert.deepEqual(store.listAudit(0, 1, false, 'fixture-noise'), [expected])
  const lightExpected = { ...expected, injectedProfile: profile.slice(0, 600),
    emotionPack: pack.slice(0, 600), emotionPackStructured: structured.slice(0, 600), agentState: null }
  assert.deepEqual(store.listAudit(0, 1, true), [lightExpected])
  assert.deepEqual(store.listAudit(0, 1, true, 'fixture-noise'), [lightExpected])
  store.db.prepare('UPDATE audit_logs SET agent_state = ? WHERE trace_id = ?').run('{"value":1}', 'noise-600')
  assert.deepEqual(store.listAudit(0, 1, true)[0].agentState, { value: 1 })
  const sparse = store.listAudit(0, 1, true, 'fixture-target')[0]
  assert.deepEqual(sparse.agentState, {})
  assert.equal(sparse.latency, null)
  assert.equal(sparse.sayAgain, null)
  assert.equal(sparse.extraReply, null)
})

// 只执行实际注册块，不导入/启动宿主 index，不接触运行数据库或 HTTP 服务。
const indexSource = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const routeAt = indexSource.indexOf("path: '/api/echo/audit'")
const routeStart = indexSource.lastIndexOf('  ctx.effect(() => webServer.register({', routeAt)
const routeEndMarker = "}), 'echo.api.audit()')"
const routeEnd = indexSource.indexOf(routeEndMarker, routeAt)
assert.ok(routeAt >= 0 && routeStart >= 0 && routeEnd > routeAt, '必须找到实际审计注册块')
const registerAudit = new Function('ctx', 'webServer', 'store', 'queryOf', 'json', 'offline',
  indexSource.slice(routeStart, routeEnd + routeEndMarker.length))

function auditRoute (store) {
  let route
  registerAudit({ effect: fn => fn() }, { register: value => { route = value } }, store,
    req => new URL(req.url, 'http://127.0.0.1').searchParams,
    (res, status, data) => { res.status = status; res.data = data },
    res => { res.status = 503 })
  assert.equal(route.kind, 'exact')
  assert.equal(route.path, '/api/echo/audit')
  return (params = {}, method = 'GET') => {
    const res = {}
    route.handler({ method, url: '/api/echo/audit?' + new URLSearchParams(params) }, res)
    return res
  }
}

test('实际 GET 注册块透传 sessionId/since/limit/light，仍只返回 rows', (t) => {
  const store = fixture(t)
  store.db.prepare('UPDATE audit_logs SET injected_profile = ? WHERE session_id = ?')
    .run('P'.repeat(750), 'fixture-target')
  const ask = auditRoute(store)
  const filtered = ask({ sessionId: 'fixture-target', since: '10', limit: '2', light: '1' })
  assert.equal(filtered.status, 200)
  assert.deepEqual(Object.keys(filtered.data), ['rows'])
  assert.deepEqual(filtered.data.rows.map(row => row.timestamp), [30, 20])
  assert.ok(filtered.data.rows.every(row => row.injectedProfile.length === 600))
  for (const light of ['', '0', 'true']) {
    assert.equal(ask({ sessionId: 'fixture-target', limit: '1', light }).data.rows[0].injectedProfile.length, 750)
  }
  assert.equal(ask().data.rows.length, 50)
  assert.deepEqual(ask({ sessionId: '' }), ask())
  assert.deepEqual(ask({ sessionId: 'fixture-missing' }).data, { rows: [] })
  assert.equal(ask({}, 'POST').status, 405)
  assert.equal(auditRoute(null)().status, 503)
})

test('实际 GET 注册块处理编码会话、500 上限和异常 limit', (t) => {
  const store = fixture(t)
  const session = "fixture' &+=? --"
  store.db.prepare('INSERT INTO audit_logs (trace_id, session_id, timestamp) VALUES (?, ?, ?)')
    .run('encoded', session, 50)
  const ask = auditRoute(store)
  assert.deepEqual(ask({ sessionId: session }).data.rows.map(row => row.timestamp), [50])
  for (const [limit, expected] of [['500', 500], ['900', 500], ['2.9', 2], ['0', 50],
    ['NaN', 50], ['Infinity', 50], ['-Infinity', 50], ['invalid', 50], ['-2', 1]]) {
    const result = ask({ sessionId: 'fixture-noise', limit })
    assert.equal(result.status, 200)
    assert.equal(result.data.rows.length, expected)
  }
})
