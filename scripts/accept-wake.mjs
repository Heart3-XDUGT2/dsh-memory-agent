/**
 * v0.38.0 F1 真机探针:`node scripts/accept-wake.mjs [--port 3080] [--since 24h] [--post] [--json]`
 *
 * **默认只读**:问三件事 ——
 *   ① 状态面在不在、`externalWake` 开关什么状态(默认关是设计,不是故障);
 *   ② 账上(审计)有没有 `event_in` 行(外部事件被收下过的直接证据);
 *   ③ `echo_wakes` 里有没有 `why` 带「外部事件」的闹钟,以及它响没响
 *      (`fired_reason`:fired / 还在等 / 被取消)。
 *
 * 加 `--post` 才**真的敲门**(POST /api/echo/event,带写闸头):这是唯一会写东西的
 * 模式,而且需要「外部唤醒」开关已经打开 —— 关着就如实报 403,不假装成功。
 *
 * 纪律:不开关、不改配置;`--post` 那一击是他自己要的端到端演练。
 */
import { DatabaseSync } from 'node:sqlite'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const argv = process.argv.slice(2)
const flag = (name, def = '') => {
  const i = argv.indexOf(name)
  return i !== -1 && argv[i + 1] !== undefined ? String(argv[i + 1]) : (argv.find((a) => a.startsWith(name + '='))?.slice(name.length + 1) ?? def)
}
const asJson = argv.includes('--json')
const doPost = argv.includes('--post')
const kind = flag('--kind', 'arrived-home')
const text = flag('--text', '他到楼下了(探针造的)')
const base = (() => {
  const b = flag('--base', '')
  if (b !== '') return /^https?:\/\//i.test(b) ? b : 'http://' + b
  return 'http://127.0.0.1:' + (flag('--port', '3080') || '3080')
})()
const since = (() => {
  const m = /^(\d+(?:\.\d+)?)([hdm]?)$/.exec(flag('--since', '24h'))
  if (m === null) return 86400
  const n = Number(m[1])
  return m[2] === 'd' ? n * 86400 : (m[2] === 'm' ? n * 60 : n * 3600)
})()
const dbPath = flag('--db', '') || (process.env.DSH_ECHO_DB ?? join(homedir(), '.dsh', 'echo', 'echo.db'))

const lines = []
const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok: ok === true, detail: String(detail) })
  // 通过的那条不带 detail —— 否则会出现「ok … —— 新代码还没被宿主加载(要重启)」
  // 这种自相矛盾的行(2026-09-28 夜自查发现)。
  lines.push((ok === true ? '  ok   ' : '  FAIL ') + name + (ok === true || detail === '' ? '' : ' —— ' + detail))
}

let st = null
try {
  const res = await fetch(base + '/api/echo/status', { signal: AbortSignal.timeout(4000) })
  st = await res.json()
  check('状态面可达', true)
} catch (e) {
  check('状态面可达', false, String(e?.message ?? e))
}

// ⚠️ 开关不在状态面上 —— 调参走 /api/echo/settings(2026-09-28 夜自查纠正:
// 第一版探针读 st.settings,于是永远报"字段不在 ⇒ 要重启",把**已加载**的代码
// 误报成没加载。探针读错接口,比没有探针更坏 —— 它会把人指去重启)。
let cfg = null
try {
  const res = await fetch(base + '/api/echo/settings', { signal: AbortSignal.timeout(4000) })
  cfg = await res.json()
} catch (e) { cfg = null }
let switchOn = null
if (cfg !== null) {
  const s = cfg.settings ?? {}
  switchOn = s.externalWake === true || s.externalWake === 1
  lines.push('  info 「外部唤醒」开关:' + (switchOn ? '开' : '关(默认)')
    + (switchOn ? '' : ' —— 门关着时 /api/echo/event 应回 403,这是设计'))
  check('调参面能读到开关(说明这版代码被加载了)', Object.hasOwn(s, 'externalWake'),
    'externalWake 不在 ⇒ 新代码还没被宿主加载(要重启 dsh web)')
  // C5 的阈值也在这张表里 —— 顺手证明它被加载(不额外发请求)
  if (Object.hasOwn(s, 'staleHours')) lines.push('  info C5 过期阈值已加载:staleHours = ' + s.staleHours + ' 小时')
  else lines.push('  info C5 过期阈值**不在**(staleHours)—— 这版还没被加载')
}

// ---- 真的敲门(要显式 --post)----
let posted = null
if (doPost) {
  try {
    const res = await fetch(base + '/api/echo/event', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-echo-edit': '1' },
      body: JSON.stringify({ kind, text }),
      signal: AbortSignal.timeout(4000)
    })
    posted = { status: res.status, body: await res.json().catch(() => null) }
    check('敲门后按预期回应(200 收下 / 403 门关着)',
      posted.status === 200 || (posted.status === 403 && posted.body?.error === 'external-wake-off'),
      'HTTP ' + posted.status + ' ' + JSON.stringify(posted.body))
  } catch (e) {
    check('敲门', false, String(e?.message ?? e))
  }
}

// ---- 账上:事件收下的痕迹 + 闹钟响没响 ----
let events = []
let wakes = []
if (existsSync(dbPath)) {
  let db = null
  try {
    db = new DatabaseSync(dbPath, { readOnly: true })
    const sinceAt = Date.now() / 1000 - since
    events = db.prepare("SELECT tool_call, user_input, timestamp FROM audit_logs"
      + " WHERE timestamp >= ? AND tool_call = 'event_in' ORDER BY timestamp DESC LIMIT 5").all(sinceAt)
    wakes = db.prepare('SELECT id, at, note, why, session_id, fired_at, canceled_at, fired_reason'
      + ' FROM echo_wakes WHERE why LIKE ? ORDER BY id DESC LIMIT 5').all('外部事件%')
  } catch (e) {
    check('只读打开库 ' + dbPath, false, String(e?.message ?? e))
  } finally { try { db?.close() } catch { } }
  lines.push('  ── 账上的外部事件(event_in,最近 ' + Math.round(since / 3600) + ' 小时):'
    + (events.length === 0 ? '(无)' : ''))
  for (const e of events) {
    lines.push('       ' + new Date(Number(e.timestamp) * 1000).toLocaleString('zh-CN') + '  ' + String(e.user_input).slice(0, 60))
  }
  lines.push('  ── 外部事件排下的闹钟:')
  if (wakes.length === 0) lines.push('       (无)')
  for (const w of wakes) {
    const fired = Number(w.fired_at) > 0
    const canceled = Number(w.canceled_at) > 0
    lines.push('       wake#' + w.id + ' @ ' + new Date(Number(w.at) * 1000).toLocaleString('zh-CN')
      + '  ' + (canceled ? '已取消' : (fired ? '已响(' + (w.fired_reason || 'fired') + ')' : '还在等'))
      + '  why=' + String(w.why).slice(0, 30) + '  note=' + String(w.note).slice(0, 40))
  }
  // 「收下了但没排上」这类断层也要看得见
  if (doPost && posted !== null && posted.status === 200) {
    check('收下的事件在库里留下了闹钟(不新开投递链,但账要连上)', wakes.length > 0, 'echo_wakes 里没有外部事件的闹钟')
    check('收下的事件在审计里留了行(event_in)', events.length > 0)
  }
} else {
  check('库在位 ' + dbPath, false, '找不到')
}

const failed = results.filter((r) => !r.ok)
if (asJson) {
  console.log(JSON.stringify({ base, dbPath, results, posted, events, wakes }, null, 2))
} else {
  console.log('# 外部唤醒探针 · ' + base + (doPost ? '(敲门模式)' : '(只读)'))
  for (const l of lines) console.log(l)
  console.log(failed.length === 0
    ? '结论:通过。'
    : '结论:' + failed.length + ' 条没通过'
      + (doPost ? '' : ' —— 只读模式只问"门与账在不在";要看端到端请加 --post'))
}
process.exitCode = failed.length === 0 ? 0 : 1
