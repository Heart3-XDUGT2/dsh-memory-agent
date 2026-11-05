// 「她为什么没开口」的查询口(只读)。
//
// 用法:
//   node scripts/echoq.mjs                 # 最近 24 小时的人读报告
//   node scripts/echoq.mjs --since 7d      # / 90m / 30s / ISO 串 / epoch 秒
//   node scripts/echoq.mjs --limit 50      # 最多读多少拍(默认 50)
//   node scripts/echoq.mjs --json          # { since, now, total, byReason, rows, metrics }
//                                          # metrics = 三列只读指标(P3.1,取不到就退空)
//   node scripts/echoq.mjs --db <path>     # 换库(默认 $DSH_ECHO_DB,否则 ~/.dsh/echo/echo.db)
//
// 为什么有这个口(2026-09-28):关心链断了 45 小时,`shouldCare` 是 true,
// 而理由是**瞬时字段**,当时它只喊在宿主 stdout 上 —— 过后谁都查不到。
// 现在否定判断落进 `care_beats`(`docs/DISCIPLINE.md` 第一条):
//   **reason 只许枚举,可 GROUP BY** ——「最近 24 小时她没开口的原因分布」
//   必须是一条 SQL 就能答的问题。本脚本就是那条 SQL 的出口。
//
// 只读纪律:库用 readOnly 打开,**绝不写库、绝不建表、绝不迁移**。
// 表不存在 / 文件不在 / 打不开 ⇒ 打一句人话 + exitCode=1,不许抛栈
// (看不了账本本身也是「失败必须可见」的一种,但得让人读得懂)。
//
// 2026-09-30 P3.1:报告末尾那**三列只读指标**(reply_rate / follow_up / revisit)的
// 取数接到这里 —— 喂给 `summarizeBeats(rows, { turns, topics })` / `renderBeats`。
// 取数**只读 SELECT**(与 `store.listConversations({limit})` 逐字段同形),任何一张表
// 读不到 ⇒ 那一项退化成空数组(报告照出、指标段自己说"没有数据"),绝不带倒整份报告。
import { DatabaseSync } from 'node:sqlite'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { parseSince, renderBeats, summarizeBeats, DEFAULT_SINCE_SEC } from '../lib/care-report.js'

const DEFAULT_LIMIT = 50
/** 他的消息取多少条:与 `store.listConversations` 的上限同口径(全局滚动窗就是 100)。 */
const TURNS_LIMIT = 100

/** 他的消息(`conversation_log`)—— 形状与 `store.listConversations({limit})` 对齐
 *  (`sessionId` / `userText` / `createdAt`;`normTurns` 认的就是这个)。读不到 ⇒ []。 */
function fetchTurns (db, limit = TURNS_LIMIT) {
  try {
    const cap = Math.max(1, Math.min(TURNS_LIMIT, Number(limit) || TURNS_LIMIT))
    return db.prepare('SELECT session_id, user_text, created_at FROM conversation_log ORDER BY turn_id DESC LIMIT ?').all(cap)
  } catch { return [] }
}

/** `care_beats.topic_id` → 正文的去处(`thread:19` / `mem:7` / `diary:2026-09-30`)。 */
const TOPIC_SOURCES = Object.freeze([
  { prefix: 'thread:', sql: 'SELECT content AS text FROM pending_threads WHERE thread_id = ?' },
  { prefix: 'mem:', sql: 'SELECT summary AS text FROM episodic_memory WHERE memory_id = ?' },
  { prefix: 'diary:', sql: 'SELECT content AS text FROM diary WHERE date = ?' }
])

/** 话题正文:`[{id, text}]`(取不到正文的话题**不编** —— 那一项在报告里算"没数据")。 */
function fetchTopics (db, rows) {
  const ids = [...new Set((Array.isArray(rows) ? rows : [])
    .map((r) => String(r?.topic_id ?? ''))
    .filter((s) => s !== ''))]
  const out = []
  for (const id of ids) {
    const src = TOPIC_SOURCES.find((s) => id.startsWith(s.prefix))
    if (src === undefined) continue
    try {
      const row = db.prepare(src.sql).get(id.slice(src.prefix.length))
      const text = String(row?.text ?? '').trim()
      if (text !== '') out.push({ id, text })
    } catch { /* 表不在 / 读不动 ⇒ 这个话题算"没正文",不抛 */ }
  }
  return out
}

const argv = process.argv.slice(2)
const flagValue = (name) => {
  const i = argv.indexOf(name)
  return i !== -1 && argv[i + 1] !== undefined ? String(argv[i + 1]) : ''
}
const asJson = argv.includes('--json')
const sinceRaw = flagValue('--since')
const limitRaw = flagValue('--limit')
const limit = /^[0-9]+$/.test(limitRaw) && Number(limitRaw) > 0 ? Number(limitRaw) : DEFAULT_LIMIT
const now = Date.now() / 1000
const win = parseSince(sinceRaw, now)

const dbPath = flagValue('--db') !== ''
  ? flagValue('--db')
  : (process.env.DSH_ECHO_DB ?? join(homedir(), '.dsh', 'echo', 'echo.db'))

if (sinceRaw !== '' && win.fallback) {
  console.error('说明:「' + sinceRaw + '」认不出(--since 认 24h/7d/90m/30s、ISO 串或 epoch 秒);'
    + '按默认 ' + DEFAULT_SINCE_SEC / 3600 + ' 小时算。')
}
if (!existsSync(dbPath)) {
  console.error('账本不在:' + dbPath + '(她还没起过?或 --db / $DSH_ECHO_DB 指错了)')
  process.exitCode = 1
} else {
  let db = null
  try {
    db = new DatabaseSync(dbPath, { readOnly: true })
  } catch (err) {
    console.error('账本打不开(只读):' + dbPath + ' —— ' + String(err?.message ?? err))
    process.exitCode = 1
  }
  if (db !== null) {
    try {
      // 表可能还没建(它由写入侧另一处建)—— 那是「看不了」而不是「没拍」,必须说清。
      const rows = db.prepare('SELECT * FROM care_beats WHERE at >= ? ORDER BY at DESC LIMIT ?').all(win.since, limit)
      const asc = rows.slice().reverse() // 报告按时间正序排(最近 5 拍 = 尾部那 5 条)
      // P3.1:三列指标的取数(只读;取不到就是空数组,指标段自己说"没有数据")
      const turns = fetchTurns(db)
      const topics = fetchTopics(db, asc)
      if (asJson) {
        const sum = summarizeBeats(asc, { turns, topics })
        console.log(JSON.stringify({ since: win.since, now, total: sum.total, byReason: sum.byReason, rows: asc, metrics: sum.metrics }, null, 2))
      } else {
        console.log(renderBeats({ rows: asc, since: win.since, now, turns, topics }))
        if (win.fallback && sinceRaw !== '') console.log('  (窗口按默认 ' + DEFAULT_SINCE_SEC / 3600 + ' 小时算,不是你说的那个)')
      }
    } catch (err) {
      console.error('读 care_beats 失败:' + String(err?.message ?? err))
      console.error('  ⇒ care_beats 表可能还没建(它由写入侧建表),或者这个库不是她的账本。')
      process.exitCode = 1
    } finally {
      try { db.close() } catch { /* 关不掉就算了,进程本来就要退 */ }
    }
  }
}
