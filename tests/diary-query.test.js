/** ECHO-004：仅隔离内存库；执行实际注册块、定时回调及 commitDiary。 */
import './_isolate.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { openStore, MASTER_ID } from '../lib/store.js'
import { commitDiary, composeDiary, todayKey, planDiaryTick, midnightOfKey, diaryRetryMs } from '../lib/diary.js'

const source = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
function section (start, end, from = 0) {
  const a = source.indexOf(start, from)
  const b = source.indexOf(end, a + start.length)
  assert.ok(a >= 0 && b > a, '必须定位实际源码块')
  return source.slice(a, b + end.length)
}
const actualJson = new Function('return (' + section('function json(res, status, data) {', '\n}') + ')')()
const offlineLine = source.split('\n').find(line => line.startsWith('  const offline = '))
const queryLine = source.split('\n').find(line => line.startsWith('  const queryOf = '))
assert.ok(offlineLine && queryLine, '必须使用实际离线和查询解析实现')
const routeAt = source.indexOf("path: '/api/echo/diary'")
const routeStart = source.lastIndexOf('  ctx.effect(() => webServer.register({', routeAt)
assert.ok(routeAt >= 0 && routeStart >= 0)
const registerDiary = new Function('ctx', 'webServer', 'store', 'json', offlineLine + '\n' + queryLine + '\n' +
  section('  ctx.effect(() => webServer.register({', "}), 'echo.api.diary()')", routeStart))

function route (store) {
  let registered
  registerDiary({ effect: (fn, label) => { assert.equal(label, 'echo.api.diary()'); fn() } },
    { register: value => { registered = value } }, store, actualJson)
  assert.equal(registered.kind, 'exact')
  assert.equal(registered.path, '/api/echo/diary')
  return (query = '', method = 'GET') => {
    const res = { writeHead: (status, headers) => { res.status = status; res.headers = headers }, end: body => { res.body = body } }
    registered.handler({ method, url: '/api/echo/diary' + (query ? '?' + query : '') }, res)
    return { status: res.status, headers: res.headers, data: JSON.parse(res.body) }
  }
}
const queryFor = date => new URLSearchParams({ date }).toString()
function fresh (t) {
  const store = openStore(':memory:', { auditKeep: 1000 })
  store.db.prepare('INSERT OR IGNORE INTO user_profile (user_id, name) VALUES (?, ?)').run(MASTER_ID, '合成用户')
  t.after(() => store.close())
  return store
}
const dates = ['2024-02-20', '2024-02-21', '2024-02-22', '2024-02-23', '2024-02-24', '2024-02-25',
  '2024-02-26', '2024-02-27', '2024-02-28', '2024-02-29', '2024-03-01', '2024-03-02']
const prefix = '共享开头'.repeat(160)
const contentOf = date => prefix + '\n唯一日期：' + date + '\n' + '完整正文'.repeat(80)
function pages (t) {
  const store = fresh(t)
  for (const [i, date] of dates.entries()) store.insertDiary({ date, content: contentOf(date), mood: i % 3 + 4, longingValue: i / 4 })
  return store
}

test('实际GET默认仍最近7篇、原字段与全文；其他参数不改默认窗口', t => {
  const store = pages(t), ask = route(store)
  const result = ask()
  assert.equal(result.status, 200)
  assert.deepEqual(result.headers, { 'content-type': 'application/json' })
  assert.deepEqual(Object.keys(result.data), ['rows'])
  assert.deepEqual(result.data.rows.map(row => row.date), ['2024-03-02', '2024-03-01', '2024-02-29', '2024-02-28', '2024-02-27', '2024-02-26', '2024-02-25'])
  for (const row of result.data.rows) {
    assert.deepEqual(Object.keys(row), ['date', 'content', 'mood', 'longingValue', 'createdAt'])
    assert.equal(row.content, contentOf(row.date))
    assert.equal(row.mood, dates.indexOf(row.date) % 3 + 4)
    assert.equal(row.longingValue, dates.indexOf(row.date) / 4)
    assert.ok(row.createdAt > 0)
  }
  assert.deepEqual(ask('limit=1').data, result.data)
  assert.equal(store.listAudit().length, 0, '读取不得新写审计')
})

test('实际GET第8篇及最早篇按日期精确取全文，超过80/600字且共有前缀不混淆', t => {
  const store = pages(t), calls = []
  const adapter = {
    latestDiaries: (...args) => { calls.push(['latest', ...args]); return store.latestDiaries(...args) },
    getDiaryDate: (...args) => { calls.push(['date', ...args]); return store.getDiaryDate(...args) }
  }
  const ask = route(adapter)
  for (const date of ['2024-02-24', '2024-02-20']) {
    const res = ask(queryFor(date))
    assert.equal(res.status, 200)
    assert.deepEqual(res.data, { rows: [store.getDiaryDate(date)] })
    assert.equal(res.data.rows[0].content, contentOf(date))
    assert.ok(res.data.rows[0].content.length > 600)
  }
  assert.deepEqual(calls, [['date', '2024-02-24'], ['date', '2024-02-20']])
  assert.equal(contentOf('2024-02-24').slice(0, 600), contentOf('2024-02-20').slice(0, 600))
  assert.notEqual(contentOf('2024-02-24'), contentOf('2024-02-20'))
  assert.equal(store.latestDiaries(90).length, 12)
})

test('实际GET合法闰日及世纪/早年边界；合法未知日期200空数组', t => {
  const store = pages(t), ask = route(store)
  assert.equal(ask(queryFor('2024-02-29')).data.rows[0].content, contentOf('2024-02-29'))
  for (const date of ['2000-02-29', '2400-02-29', '0001-01-01', '0099-12-31', '1900-02-28', '9999-12-31', '2024-04-30']) {
    assert.deepEqual(ask(queryFor(date)).data, { rows: [] })
    assert.equal(ask(queryFor(date)).status, 200)
  }
})

const invalidDates = ['', ' ', '\t', '2024-02-29 ', ' 2024-02-29', '2024-02-29\n', '2024-02-29\r',
  '2023-02-29', '1900-02-29', '2100-02-29', '2024-02-30', '2024-04-31', '2024-11-31',
  '2024-00-10', '2024-13-01', '2024-01-00', '2024-01-32', '0000-01-01', '2024-2-29', '24-02-29',
  '02024-02-29', '2024/02/29', '2024-02-29T00:00:00Z', '２０２４-０２-２９', "2024-02-29' OR 1=1 --"]
test('实际GET非法/空白/SQL样式date均400，不查询、不退回列表、不泄露入参', async t => {
  const store = pages(t), calls = []
  const ask = route({ latestDiaries: () => { calls.push('latest') }, getDiaryDate: () => { calls.push('date') } })
  for (const [n, date] of invalidDates.entries()) await t.test('非法边界 ' + (n + 1), () => {
    const res = ask(queryFor(date))
    assert.equal(res.status, 400)
    assert.deepEqual(res.data, { error: 'invalid date' })
  })
  assert.deepEqual(ask('date').data, { error: 'invalid date' })
  assert.deepEqual(calls, [])
  assert.equal(store.latestDiaries(90).length, 12)
})

test('实际GET重复date均400，包含同值、空值与编码键', t => {
  const ask = route(pages(t))
  for (const query of ['date=2024-02-29&date=2024-02-29', 'date=&date=2024-02-29',
    'date=2024-02-29&date=2024-03-01', 'date=2024-02-29&%64ate=2024-02-29']) {
    assert.equal(ask(query).status, 400)
    assert.deepEqual(ask(query).data, { error: 'invalid date' })
  }
})

test('实际GET保留405与真实offline=200语义，存储错误只给固定安全错误', t => {
  const ask = route(pages(t))
  for (const method of ['POST', 'PUT', 'DELETE', 'HEAD']) {
    assert.equal(ask(queryFor('2024-02-29'), method).status, 405)
    assert.deepEqual(ask('', method).data, { error: 'method not allowed' })
    assert.equal(route(null)('', method).status, 405)
  }
  for (const query of ['', 'date=', queryFor('2024-02-29')]) {
    assert.deepEqual(route(null)(query), { status: 200, headers: { 'content-type': 'application/json' }, data: { offline: true } })
  }
  const fail = () => { throw new Error('fixture storage failure with private details') }
  const broken = route({ latestDiaries: fail, getDiaryDate: fail })
  for (const query of ['', queryFor('2024-02-29')]) {
    assert.equal(broken(query).status, 500)
    assert.deepEqual(broken(query).data, { error: 'diary unavailable' })
  }
})

test('真实commitDiary审计引用实际日期，保留80字/标记/trace与一天一页幂等', t => {
  const store = fresh(t), dateKey = '2024-02-20', content = contentOf(dateKey)
  assert.equal(commitDiary(store, { dateKey, content, mood: 6, longingValue: 2.5 }), true)
  assert.equal(commitDiary(store, { dateKey, content: '不应覆盖', mood: 1 }), false)
  assert.equal(store.getDiaryDate(dateKey).content, content)
  const rows = store.listAudit()
  assert.equal(rows.length, 1)
  assert.deepEqual(JSON.parse(rows[0].stageDetail), { diaryDate: dateKey })
  assert.equal(rows[0].llmReply, content.slice(0, 80))
  assert.equal(rows[0].stage, 'diary')
  assert.equal(rows[0].step, 90)
  assert.equal(rows[0].toolCall, 'diary')
  assert.equal(rows[0].userInput, '(她写了日记)')
  assert.match(rows[0].traceId, /^[0-9a-f-]{36}$/u)
})

test('真实commitDiary缺日期使用同一实际写入日，不新增日记或审计关联修复', t => {
  const store = fresh(t)
  assert.equal(commitDiary(store, { content: '合成的当天日记正文。', mood: 4 }), true)
  const page = store.latestDiaries(1)[0]
  assert.equal(JSON.parse(store.listAudit()[0].stageDetail).diaryDate, page.date)
  store.writeAudit({ traceId: 'fixture-legacy-diary', userInput: '(她写了日记)', toolCall: 'diary', llmReply: '旧摘要' })
  assert.equal(store.listAudit().find(row => row.traceId === 'fixture-legacy-diary').stageDetail, '')
})

const tickStart = source.indexOf('  if (subagents !== undefined) {', source.indexOf('// ---- 3.6 她写日记'))
assert.ok(tickStart >= 0)
const tickSource = section('  if (subagents !== undefined) {', "}, 'echo.diary()')\n  }", tickStart)
function diaryTick (store, now, content) {
  let tick, starts = 0, disposed = 0
  class Clock extends Date { static now () { return now } }
  const subagents = { list: () => ['fixture'], start: async (provider, request) => {
    assert.ok(request.parent.session && request.signal instanceof AbortSignal)
    starts++
    return { result: Promise.resolve({ stopReason: 'completed', structured: { content, mood: 5 } }), dispose: async () => { disposed++ } }
  } }
  const deps = { store, subagents, readEnabled: () => true, planDiaryTick, todayKey: () => todayKey(now), midnightOfKey,
    engine: null, MASTER_ID, readSettings: () => ({}), composeDiary, routeAgent: { session: { id: 'fixture-diary-parent' } },
    commitDiary, randomUUID, diaryRetryMs, Date: Clock,
    ctx: { logger: { info () {}, warn () {} }, effect: (fn, label) => { assert.equal(label, 'echo.diary()'); fn() } },
    setInterval: (fn, ms) => { assert.equal(ms, 60000); tick = fn; return { unref () {} } }, clearInterval () {} }
  new Function(...Object.keys(deps), tickSource)(...Object.values(deps))
  assert.equal(typeof tick, 'function')
  return { tick: () => tick(), counts: () => ({ starts, disposed }) }
}

test('实际定时回调正常写入：只有成功审计，日期引用与正文一致，下一拍不重复', async t => {
  const store = fresh(t), now = new Date(2026, 8, 28, 23, 0).getTime()
  const dateKey = '2026-09-28', content = contentOf(dateKey)
  const run = diaryTick(store, now, content)
  await run.tick(); await run.tick()
  assert.deepEqual(run.counts(), { starts: 1, disposed: 1 })
  assert.equal(store.getDiaryDate(dateKey).content, content)
  const rows = store.listAudit()
  assert.equal(rows.length, 1)
  assert.equal(rows[0].stage, 'diary')
  assert.equal(rows[0].step, 90)
  assert.equal(rows[0].llmReply, content.slice(0, 80))
  assert.deepEqual(JSON.parse(rows[0].stageDetail), { diaryDate: dateKey })
})

test('实际定时回调补写：普通80字和旁注60字均引用补写日，一天一页幂等', async t => {
  const store = fresh(t), now = new Date(2026, 8, 28, 9, 0).getTime()
  store.insertDiary({ date: '2026-09-26', content: '合成的既有页。' })
  const dateKey = '2026-09-27', content = contentOf(dateKey)
  const run = diaryTick(store, now, content)
  await run.tick(); await run.tick()
  assert.deepEqual(run.counts(), { starts: 1, disposed: 1 })
  assert.equal(store.latestDiaries(90).length, 2)
  assert.equal(store.getDiaryDate(dateKey).content, content)
  assert.notEqual(dateKey, todayKey(now), '补写日期不等于触发日')
  const rows = store.listAudit(), normal = rows.find(row => row.stage === 'diary'), backfill = rows.find(row => row.traceId.startsWith('diary-backfill-'))
  assert.equal(rows.length, 2)
  assert.equal(normal.llmReply, content.slice(0, 80))
  assert.equal(backfill.llmReply, content.slice(0, 60))
  assert.equal(backfill.userInput, '(日记补写) ' + dateKey)
  assert.equal(backfill.toolCall, 'diary')
  assert.equal(backfill.stage, '')
  assert.equal(backfill.step, 0)
  assert.notEqual(normal.traceId, backfill.traceId)
  for (const row of rows) assert.deepEqual(JSON.parse(row.stageDetail), { diaryDate: dateKey })
})
