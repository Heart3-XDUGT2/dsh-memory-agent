/**
 * 2026-09-30 P3:三列**只读**指标(`reply_rate` / `follow_up` / `revisit`)。
 *
 * 它们的用处是回答一个问题:**她开口之后,那件事有没有真的接上?**
 * 所以这份电池的重点在**边界**,不在"正常情况跑得出来":
 *   · 没有数据(空账 / 空消息 / 没喂取数)⇒ null + 说明,**不许抛**;
 *   · 她开口后他没回 ⇒ 分母在、分子 0(不是"算不出来");
 *   · 同一话题多次 ⇒ 只算一次;
 *   · 跨会话 ⇒ 默认不算,`anySession:true` 才算(两种都要能测)。
 *
 * 取数来源(实库):`care_beats`(她开口那几拍)× `conversation_log`
 * (`session_id` / `user_text` / `created_at`)× 话题正文(`pending_threads.content`
 * / `episodic_memory.summary` / `diary.content`)。本文件全部用假数据喂纯函数 ——
 * **不碰库、不迁列**。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import {
  replyRate, followUp, revisit, topicKeywords, computeMetrics,
  summarizeBeats, renderBeats, DEFAULT_REPLY_WINDOW_SEC, SAME_BEAT_SEC
} from '../lib/care-report.js'

/** care:report 的**真实入口**(package.json 的 `care:report` 指向它)。 */
const ECHOQ = fileURLToPath(new URL('../scripts/echoq.mjs', import.meta.url))

const T = 1_800_000_000
/** 一条"她开口了"的拍。 */
const sentBeat = (at, over = {}) => ({ reason: 'sent', acted: 1, at, sessionId: 's1', targetSessionId: 's1', topicId: '', ...over })
/** 一条"他说话了"。 */
const hisTurn = (at, text, sessionId = 's1') => ({ sessionId, userText: text, at })

// ═══ ① reply_rate ═══════════════════════════════════════════════════════════

test('P3 指标 reply_rate:她开口后他多久回(中位数 + 回复率)', () => {
  const rows = [sentBeat(T), sentBeat(T + 10000)]
  const turns = [hisTurn(T + 300, '在的'), hisTurn(T + 12000, '嗯')]
  const r = replyRate(rows, turns)
  assert.equal(r.total, 2)
  assert.equal(r.replied, 2)
  assert.equal(r.rate, 1)
  assert.equal(r.medianSec, 1150, '(300 + 2000) / 2')
  assert.equal(r.why, '')
})

test('P3 指标 reply_rate:她开口后他没回 ⇒ 分母在、分子 0(不是算不出来)', () => {
  const rows = [sentBeat(T), sentBeat(T + 3600)]
  const turns = [hisTurn(T - 100, '他早就说过的话,在她开口**之前**')] // 时间在她开口前
  const r = replyRate(rows, turns)
  assert.equal(r.total, 2)
  assert.equal(r.replied, 0)
  assert.equal(r.rate, 0, '有分母 ⇒ 0,不是 null')
  assert.equal(r.medianSec, null)
  assert.ok(r.why.includes('没找到'), r.why)
})

test('P3 指标 reply_rate:没有数据时安全返回(null + 说明,绝不抛)', () => {
  const noBeats = replyRate([], [hisTurn(T, '在吗')])
  assert.equal(noBeats.total, 0)
  assert.equal(noBeats.rate, null)
  assert.ok(noBeats.why !== '', '要说清为什么算不出来')
  const noTurns = replyRate([sentBeat(T)], [])
  assert.equal(noTurns.total, 1)
  assert.equal(noTurns.replied, 0)
  assert.equal(noTurns.rate, null, '没有他的消息 ⇒ 比率算不出(不是 0%)')
  assert.ok(noTurns.why.includes('没有可用'))
  for (const bad of [null, undefined, 5, 'x', {}]) {
    assert.doesNotThrow(() => replyRate(bad, bad))
    assert.equal(replyRate(bad, bad).rate, null)
  }
})

test('P3 指标 reply_rate:会话对不上 ⇒ 默认不算;anySession 才算(跨会话是显式的)', () => {
  const rows = [sentBeat(T, { sessionId: 'her', targetSessionId: 'her' })]
  const turns = [hisTurn(T + 600, '在别处说的', 'other')]
  assert.equal(replyRate(rows, turns).replied, 0, '默认只认同一会话')
  const cross = replyRate(rows, turns, { anySession: true })
  assert.equal(cross.replied, 1, 'anySession:true ⇒ 跨会话也算')
  assert.equal(cross.anySession, true)
})

test('P3 指标 reply_rate:超出回复窗口的不算(不算"他三天后回了")', () => {
  const rows = [sentBeat(T)]
  const late = [hisTurn(T + DEFAULT_REPLY_WINDOW_SEC + 60, '刚看到')]
  assert.equal(replyRate(rows, late).replied, 0)
  assert.equal(replyRate(rows, late, { windowSec: 3 * 86400 }).replied, 1, '窗口是可调的')
})

test('P3 指标 reply_rate:宿主注入/插件提示词不算"他回了我"', () => {
  const rows = [sentBeat(T)]
  const turns = [
    hisTurn(T + 10, 'Current runtime context. This snapshot supersedes earlier runtime-context snapshots.'),
    hisTurn(T + 20, '你是一个严格的记忆与情绪反思模块,输出一个 JSON 对象')
  ]
  assert.equal(replyRate(rows, turns).replied, 0, '机器话不是他打的字')
})

// ═══ ② follow_up(启发式)═══════════════════════════════════════════════════

test('P3 指标 follow_up:他回了之后是否反问(疑问标点/疑问词 —— 启发式)', () => {
  const rows = [sentBeat(T), sentBeat(T + 10000)]
  const turns = [hisTurn(T + 60, '几点到?'), hisTurn(T + 11000, '行,我知道了')]
  const f = followUp(rows, turns)
  assert.equal(f.replied, 2)
  assert.equal(f.asked, 1)
  assert.equal(f.rate, 0.5)
  assert.ok(f.heuristic.includes('疑问'), '必须写明这是启发式')
})

test('P3 指标 follow_up:他没回 ⇒ 分母 0,比率 null(不许印成 0%)', () => {
  const f = followUp([sentBeat(T)], [])
  assert.equal(f.replied, 0)
  assert.equal(f.rate, null)
  assert.ok(f.why.includes('没有可用'))
  const none = followUp([], [])
  assert.equal(none.total, 0)
  assert.equal(none.rate, null)
})

// ═══ ③ revisit(启发式)════════════════════════════════════════════════════

test('P3 指标 revisit:她提过的话题后来被他主动提起(关键词命中 = 启发式)', () => {
  const rows = [sentBeat(T, { topicId: 'thread:19' })]
  const topics = [{ id: 'thread:19', text: '用户坐今晚10点的火车回家' }]
  const turns = [hisTurn(T + 7200, '我明天还得坐火车回去')]
  const r = revisit(rows, turns, topics)
  assert.equal(r.topics, 1)
  assert.equal(r.revisited, 1)
  assert.equal(r.rate, 1)
  assert.equal(r.details[0].keyword, '火车')
  assert.ok(r.heuristic.includes('关键词'), '要写明这是启发式')
  // 他没提到 ⇒ 0
  assert.equal(revisit(rows, [hisTurn(T + 7200, '今天好累')], topics).revisited, 0)
})

test('P3 指标 revisit:同一话题多次只算一次(取最早那一拍)', () => {
  const rows = [sentBeat(T, { topicId: 'thread:19' }), sentBeat(T + 100, { topicId: 'thread:19' })]
  const topics = [{ id: 'thread:19', text: '用户坐火车回家' }]
  const r = revisit(rows, [hisTurn(T + 50, '火车票买好了')], topics)
  assert.equal(r.topics, 1, '同一个话题算一个')
  assert.equal(r.revisited, 1)
  assert.equal(r.rate, 1)
})

test('P3 指标 revisit:跨会话(默认不算 / anySession 才算)', () => {
  const rows = [sentBeat(T, { topicId: 'mem:7', sessionId: 'her', targetSessionId: 'her' })]
  const topics = [{ id: 'mem:7', text: '面试结果出来了' }]
  const turns = [hisTurn(T + 100, '面试过了', 'other')]
  assert.equal(revisit(rows, turns, topics).revisited, 0)
  assert.equal(revisit(rows, turns, topics, { anySession: true }).revisited, 1)
})

test('P3 指标 revisit:没有数据时安全返回(null/0 + 说明)', () => {
  const noTopicId = revisit([sentBeat(T)], [hisTurn(T + 10, 'x')], [])
  assert.equal(noTopicId.topics, 0)
  assert.equal(noTopicId.rate, null)
  assert.ok(noTopicId.why.includes('topic_id'), '要说清"账上没有带话题的开口"')
  // 有 topic_id 但调用方没喂正文 ⇒ 算"没数据",不许瞎猜
  const noText = revisit([sentBeat(T, { topicId: 'diary:2026-09-30' })], [hisTurn(T + 10, 'x')], [])
  assert.equal(noText.topics, 1)
  assert.equal(noText.revisited, 0)
  assert.equal(noText.rate, 0)
  assert.ok(noText.why.includes('没有正文'))
  for (const bad of [null, 5, 'x', {}]) {
    assert.doesNotThrow(() => revisit(bad, bad, bad))
    assert.equal(revisit(bad, bad, bad).rate, null)
  }
})

test('P3 指标 topicKeywords:长句切出可比的词,高频虚词被剔掉', () => {
  const keys = topicKeywords('用户坐今晚10点的火车回家')
  assert.ok(keys.includes('火车'), keys.join('/'))
  assert.ok(!keys.includes('用户'), '虚词/指代词要剔掉')
  assert.ok(!keys.includes('今天'))
  assert.deepEqual(topicKeywords('做章鱼小丸子'), ['做章', '章鱼', '鱼小', '小丸', '丸子'])
  assert.deepEqual(topicKeywords(''), [])
  assert.doesNotThrow(() => topicKeywords(null))
})

// ═══ ④ 报告结构:挂上去 / 不挂上去 ════════════════════════════════════════
test('P3 指标:summarizeBeats 只在喂了 turns/topics 时才带 metrics(老形状一个字不变)', () => {
  const rows = [sentBeat(T)]
  const plain = summarizeBeats(rows)
  assert.equal(plain.metrics, undefined, '没喂取数 ⇒ 不许多出键(老调用点/echoq --json 逐字不变)')
  assert.deepEqual(summarizeBeats([]), { total: 0, byReason: [], firstAt: null, lastAt: null, acted: 0 })
  const withData = summarizeBeats(rows, { turns: [hisTurn(T + 60, '在的')], topics: [] })
  assert.ok(withData.metrics !== undefined, '喂了取数 ⇒ 挂在同一个对象上(仪表盘那份 JSON)')
  assert.equal(withData.metrics.reply_rate.replied, 1)
  assert.ok(typeof withData.metrics.now === 'number')
})

test('P3 指标:renderBeats 喂了取数才印指标段(不喂 ⇒ 报告逐字不变)', () => {
  const rows = [sentBeat(T)]
  const plain = renderBeats({ rows, since: T - 3600, now: T + 3600 })
  assert.ok(!plain.includes('指标'), '没取数就别印一段"算不出"的空指标')
  const withData = renderBeats({ rows, since: T - 3600, now: T + 3600, turns: [hisTurn(T + 60, '几点到?')], topics: [] })
  assert.ok(withData.includes('reply_rate'), '要印出来')
  assert.ok(withData.includes('follow_up'))
  assert.ok(withData.includes('revisit'))
  assert.ok(withData.includes('启发式'), '启发式必须写在报告上')
  assert.ok(withData.includes('滚动窗'), '数据局限也要写在报告上')
})

test('P3 指标:computeMetrics 任何一列自己炸了都不带倒整份报告', () => {
  const m = computeMetrics({ rows: null, turns: null, topics: null })
  assert.ok(m.reply_rate !== undefined)
  assert.ok(m.follow_up !== undefined)
  assert.ok(m.revisit !== undefined)
  // 喂一个"读属性就炸"的怪对象:三个 key 仍然都在
  const boom = { get at () { throw new Error('boom') } }
  assert.doesNotThrow(() => computeMetrics({ rows: [boom], turns: [boom], topics: [boom] }))
  const m2 = computeMetrics({ rows: [boom, sentBeat(T)], turns: [hisTurn(T + 5, '在')], topics: [] })
  assert.equal(m2.reply_rate.replied, 1)
})

// ═══ ⑤ 2026-09-30 P3.1:被哨兵拦下的那一拍不许进分母(修污染) ═══════════════
//
// `copy-blocked` 那一笔与她"开口"是**同一拍** —— 她其实没说出去(理由只是没送到
// 他手机上)。不排除的话,"她说了却没发"会被当成一次有效开口,把 reply_rate /
// follow_up 的分母灌水。

test('P3.1 指标:同拍被哨兵拦下的"开口"不进 reply_rate / follow_up 的分母', () => {
  const blockedBeat = (at) => ({ reason: 'copy-blocked', acted: 0, at })
  const rows = [sentBeat(T), sentBeat(T + 10000), blockedBeat(T + 0.3)]
  const turns = [hisTurn(T + 60, '在的'), hisTurn(T + 10060, '嗯')]
  const r = replyRate(rows, turns)
  assert.equal(r.total, 1, '被拦的那一拍不许算分母')
  assert.equal(r.replied, 1, '只剩真发出去的那一拍')
  assert.equal(r.rate, 1)
  const f = followUp(rows, turns)
  assert.equal(f.total, 1)
  assert.equal(f.replied, 1)
  // `at` 完全相等也算同拍;隔着别的拍的 `copy-blocked` 不许牵连别人
  assert.equal(replyRate([sentBeat(T), blockedBeat(T)], turns).total, 0)
  assert.equal(replyRate([sentBeat(T), blockedBeat(T + 600)], turns).total, 1, '隔着别拍的拦住不许牵连')
  assert.ok(SAME_BEAT_SEC > 0)
})

// ═══ ⑥ 2026-09-30 P3.1:三列接到真实入口(`scripts/echoq.mjs`) ═════════════
//
// 指标不能只在纯函数里跑得出来 —— 得从 `npm run care:report` 那条真入口被印出来。
// 入口开库是 **readOnly**:表不存在 / 读不到 ⇒ 退化成空取数,报告照出、指标段
// 自己说"没有数据"(绝不带倒整份报告)。

/** 造一个最小库:`care_beats` + 一笔 sent;其余表按 `with` 决定建不建。 */
function makeDb (dir, { conversation = false } = {}) {
  const dbPath = join(dir, 'echoq.db')
  const db = new DatabaseSync(dbPath)
  db.exec('CREATE TABLE care_beats (id INTEGER PRIMARY KEY AUTOINCREMENT, at REAL NOT NULL,'
    + ' kind TEXT, reason TEXT, value REAL DEFAULT 0, threshold REAL DEFAULT 0,'
    + ' should_act INTEGER DEFAULT 0, acted INTEGER DEFAULT 0, session_id TEXT DEFAULT \'\','
    + ' target_session_id TEXT DEFAULT \'\', candidates INTEGER DEFAULT 0, top_score REAL DEFAULT 0,'
    + ' rejected_by TEXT DEFAULT \'\', topic_id TEXT DEFAULT \'\', trace_id TEXT DEFAULT \'\','
    + ' payload_json TEXT DEFAULT \'\')')
  const at = Date.now() / 1000 - 60
  db.prepare('INSERT INTO care_beats (at, kind, reason, acted, session_id, target_session_id) VALUES (?, ?, ?, ?, ?, ?)')
    .run(at, 'care', 'sent', 1, 's1', 's1')
  if (conversation) {
    db.exec('CREATE TABLE conversation_log (turn_id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT,'
      + ' channel TEXT, user_text TEXT, reply_text TEXT, created_at REAL)')
    db.prepare('INSERT INTO conversation_log (session_id, user_text, created_at) VALUES (?, ?, ?)')
      .run('s1', '在的,我看到了', at + 30)
  }
  db.close()
  return { dbPath, at }
}

test('P3.1 入口:取数缺失(没有 conversation_log / 话题表)⇒ 安全退化成"没数据",报告照出', () => {
  const dir = mkdtempSync(join(tmpdir(), 'echoq-empty-'))
  try {
    const { dbPath } = makeDb(dir, { conversation: false })
    const out = execFileSync(process.execPath, [ECHOQ, '--db', dbPath, '--since', '7d'], { encoding: 'utf8' })
    assert.ok(out.includes('reply_rate'), '三列要印出来')
    assert.ok(out.includes('follow_up'))
    assert.ok(out.includes('revisit'))
    assert.ok(out.includes('没有可用'), '取数缺失 ⇒ 明说"没有数据"(安全退化)')
    assert.ok(!out.includes('NaN'), '不许把"没数据"印成 NaN')
    assert.ok(out.includes('Echo 关心账'), '报告本体照常')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('P3.1 入口:取数齐(有他的回复)⇒ 三列真印出读数,不是摆设', () => {
  const dir = mkdtempSync(join(tmpdir(), 'echoq-full-'))
  try {
    const { dbPath } = makeDb(dir, { conversation: true })
    const out = execFileSync(process.execPath, [ECHOQ, '--db', dbPath, '--since', '7d'], { encoding: 'utf8' })
    assert.ok(out.includes('reply_rate  她开口 1 次,他回了 1 次(回复率 100%)'), out)
    assert.ok(!out.includes('(reply_rate:'), '有取数就不该给 reply_rate 印"算不出"的说明')
    // --json 也带上 metrics(仪表盘那份 JSON)
    const json = JSON.parse(execFileSync(process.execPath, [ECHOQ, '--db', dbPath, '--since', '7d', '--json'], { encoding: 'utf8' }))
    assert.equal(json.metrics.reply_rate.total, 1)
    assert.equal(json.metrics.reply_rate.replied, 1)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
