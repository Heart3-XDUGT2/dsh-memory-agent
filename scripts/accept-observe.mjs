/**
 * v0.32.0 B1 真机探针(**只读**):`node scripts/accept-observe.mjs [--port 3080] [--since 24h] [--json]`
 *
 * 验什么 —— "她干了什么"这格补上了没有:
 *   ① 状态面 `toolAudit` 在(说明 B1 已加载),并报 seen/written/各档 skip/failed;
 *   ② **活的审计表里真的有非自家工具**(`tool_call` 不以 `echo_` 开头)——
 *      这是 B1 与旧行为的**唯一区别**,没看到就等于没生效;
 *   ③ 顺手把"她最常调什么"排出来(按名字计数)。
 *
 * 纪律:库 readOnly 打开;不改配置、不建表、不写任何东西。看不出来就说看不出来(exit 1)。
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
const base = (() => {
  const b = flag('--base', '')
  if (b !== '') return /^https?:\/\//i.test(b) ? b : 'http://' + b
  return 'http://127.0.0.1:' + (flag('--port', '3080') || '3080')
})()
const since = (() => {
  const raw = flag('--since', '24h')
  const m = /^(\d+(?:\.\d+)?)([hdm]?)$/.exec(raw)
  if (m === null) return 86400
  const n = Number(m[1])
  return m[2] === 'h' || m[2] === '' ? n * 3600 : (m[2] === 'd' ? n * 86400 : n * 60)
})()
const dbPath = flag('--db', '') || (process.env.DSH_ECHO_DB ?? join(homedir(), '.dsh', 'echo', 'echo.db'))

const lines = []
const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok: ok === true, detail: String(detail) })
  lines.push((ok === true ? '  ok   ' : '  FAIL ') + name + (detail === '' ? '' : ' —— ' + detail))
  return ok === true
}

let st = null
let err = ''
try {
  const res = await fetch(base + '/api/echo/status', { signal: AbortSignal.timeout(4000) })
  st = await res.json()
} catch (e) { err = String(e?.message ?? e) }

if (st === null) {
  check('状态面可达', false, err)
} else {
  check('状态面可达', true)
  const a = st.toolAudit
  check('toolAudit 在位(B1 已加载)', a !== null && typeof a === 'object',
    a === undefined ? '字段不在 ⇒ 新代码还没被宿主加载(要重启 dsh web)' : '')
  if (a !== null && typeof a === 'object') {
    lines.push('  info 本进程统计:看到 ' + a.seen + ' 次 / 记账 ' + a.written + ' 次'
      + ' · 射程外 ' + a.skippedScope + ' · 自家 ' + a.ownSkipped + ' · 电源关 ' + a.skippedPower
      + (a.failed > 0 ? ' · ⚠写库失败 ' + a.failed : ''))
    check('没有写库失败(失败必须可见)', Number(a.failed) === 0, 'failed=' + a.failed)
    const names = Object.keys(a.byName ?? {})
    check('统计里出现过工具名', names.length > 0 || Number(a.seen) === 0,
      names.length === 0 ? '(还没人在会话里调过工具)' : '')
  }
  // v0.35.0 B4:反思那一趟的留痕(子代理)——耗时/成败/为什么跳过
  const rf = st.reflect
  check('reflect 在位(B4 已加载)', rf !== null && typeof rf === 'object',
    rf === undefined ? '字段不在 ⇒ 新代码还没被宿主加载(要重启 dsh web)' : '')
  if (rf !== null && typeof rf === 'object') {
    lines.push('  info 反思:' + rf.runs + ' 趟(失败 ' + rf.fails + ')'
      + (rf.lastMs === null ? ' · 还没跑过' : ' · 上次 ' + (rf.lastMs / 1000).toFixed(1) + 's ' + (rf.lastOk === false ? '失败' : 'ok'))
      + ' · 忙时排队 ' + rf.busySkipped + ' · 缺 parent 跳过 ' + rf.noAgentSkipped
      + (rf.lastNote === '' ? '' : ' · "' + rf.lastNote + '"'))
    check('反思没有连续失败(失败必须看得见)', Number(rf.fails) === 0 || Number(rf.runs) > Number(rf.fails),
      'fails=' + rf.fails + ' runs=' + rf.runs)
  }
}

// ---- 活的审计表:B1 写的宿主工具审计行真的落进去了吗 ----
// ⚠️ 口径(第一版写错过,记在这儿):不能拿"tool_call 不以 echo_ 开头"当判据 ——
// 我们**自家**的内部标签也不带前缀(extract / relay_out / reflection / care / wake …),
// 那样一查全是假阳性。B1 写的行有**独一份的签名**:`user_input` 以 `(工具) ` 开头
// (见 lib/tool-audit.js),照这个查才准。
let rows = []
let own = []
if (!existsSync(dbPath)) {
  check('审计库在位 ' + dbPath, false, '找不到')
} else {
  let db = null
  try {
    db = new DatabaseSync(dbPath, { readOnly: true })
    const t = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='audit_logs'").get()
    check('audit_logs 表在', t !== undefined && t !== null)
    const sinceAt = Date.now() / 1000 - since
    rows = db.prepare("SELECT tool_call, COUNT(*) AS n, MAX(timestamp) AS last FROM audit_logs"
      + " WHERE timestamp >= ? AND user_input LIKE '(工具)%'"
      + ' GROUP BY tool_call ORDER BY n DESC').all(sinceAt)
    own = db.prepare("SELECT tool_call, COUNT(*) AS n FROM audit_logs"
      + " WHERE timestamp >= ? AND tool_call LIKE 'echo_%' GROUP BY tool_call ORDER BY n DESC").all(sinceAt)
  } catch (e) {
    check('只读打开审计库', false, String(e?.message ?? e))
  } finally {
    try { db?.close() } catch { }
  }
  const total = rows.reduce((s, r) => s + Number(r.n), 0)
  // v0.40.0:分得清「钩子根本没在跳」与「她还没用过工具」——
  // `seen > 0` 就是钩子在跳的铁证(本进程统计),那"没有 (工具) 行"只是**还没发生**,
  // 不该喊成 FAIL(2026-09-28 夜真机上 34 次全在射程外,正是这种情况)。
  const hookSeen = Number(st?.toolAudit?.seen) || 0
  if (hookSeen > 0) {
    lines.push('  info 钩子在跳(本进程看到 ' + hookSeen + ' 次工具调用),但最近 '
      + Math.round(since / 3600) + ' 小时里**她那边一次都没调过工具**'
      + (total > 0 ? '' : ' ⇒ 还没有 (工具) 行的真实证据(不是"B1 未生效")'))
  } else {
    check('审计表里有 B1 写的**宿主工具**行(`(工具)` 签名)', total > 0,
      total === 0 ? '最近 ' + Math.round(since / 3600) + ' 小时里没有,而且钩子一次都没跳过 —— B1 可能真没生效' : '')
  }
  lines.push('  ── 宿主工具(B1 写的,最近 ' + Math.round(since / 3600) + ' 小时,' + total + ' 次):'
    + (rows.length === 0 ? '(无)' : rows.map((r) => r.tool_call + '×' + r.n).join(', ')))
  lines.push('  ── 自家工具(她伸手):' + (own.length === 0 ? '(无)' : own.map((r) => r.tool_call + '×' + r.n).join(', ')))
  if (rows.length > 0) {
    lines.push('  ── 最近一次宿主工具:' + rows[0].tool_call + ' @ '
      + new Date(Number(rows[0].last) * 1000).toLocaleString('zh-CN'))
  }
  // v0.36.0 B2:一轮的行串起来了吗(同一个 trace_id 下挂多行)——“下面统一查”
}

// ---- v0.36.0 B2:这一轮能串起来查吗(trace_id 下挂多行)----
let turns = []
let hasTraceCol = false
let recentRows = 0
if (existsSync(dbPath)) {
  const sid = flag('--sid', '')
  let db = null
  const sinceAt = Date.now() / 1000 - since
  try {
    db = new DatabaseSync(dbPath, { readOnly: true })
    // 列在不在**先查**(在关库之前)—— 顺序写反过:拿关掉的连接问 PRAGMA,
    // 异常被 catch 吃掉就变成一条假 FAIL(2026-09-28 夜自查发现)。
    hasTraceCol = db.prepare('PRAGMA table_info(audit_logs)').all().some((c) => c.name === 'trace_id')
    recentRows = Number(db.prepare('SELECT COUNT(*) AS n FROM audit_logs WHERE timestamp >= ?').get(sinceAt)?.n) || 0
    turns = db.prepare('SELECT trace_id, COUNT(*) AS n, MAX(tool_call) AS last_tool,'
      + ' MIN(timestamp) AS from_at, MAX(timestamp) AS to_at FROM audit_logs'
      + ' WHERE timestamp >= ? AND trace_id IS NOT NULL AND trace_id != \'\''
      + (sid === '' ? '' : ' AND session_id = ?')
      + ' GROUP BY trace_id HAVING n > 1 ORDER BY to_at DESC LIMIT 8').all(...(sid === '' ? [sinceAt] : [sinceAt, sid]))
  } catch { /* 库读不到上面已经报过 */ } finally { try { db?.close() } catch { } }
  check('audit_logs 有 trace_id 列(B2 的地基;没有 = 还是旧代码在写)', hasTraceCol)
  // 「还没有一轮挂多行」= 在等一种特定的轮次(她一轮调两次以上工具),
  // 不是代码没生效 ⇒ 归到 info(判据留给"列在不在"这一条硬的)。
  if (turns.length > 0) {
    check('有"一轮挂了多行"的 trace(B2 生效的直接证据)', true)
  } else {
    lines.push('  info B2 的**直接证据先欠着**:' + (recentRows === 0
      ? '最近 ' + Math.round(since / 3600) + ' 小时一条账都没有 —— 没人跟她说句话'
      : '有 ' + recentRows + ' 条账,但还没有"一轮挂多行"的轮次(要等她一次轮里调两次以上工具)'))
  }
  for (const t of turns.slice(0, 3)) {
    lines.push('  ── trace ' + String(t.trace_id).slice(0, 8) + '… ×' + t.n + ' 行 · '
      + new Date(Number(t.from_at) * 1000).toLocaleTimeString('zh-CN') + ' → '
      + new Date(Number(t.to_at) * 1000).toLocaleTimeString('zh-CN'))
  }
}

const failed = results.filter((r) => !r.ok)
if (asJson) {
  console.log(JSON.stringify({ base, dbPath, results, toolAudit: st?.toolAudit ?? null, hostTools: rows, ownTools: own }, null, 2))
} else {
  console.log('# 工具审计探针 · ' + base + '(只读)')
  for (const l of lines) console.log(l)
  // 结论要说清**验到了什么、还欠什么** —— 不许把"等数据"写成"留痕了"。
  const pending = lines.filter((l) => l.includes('info') && l.includes('欠着')).length > 0
  console.log(failed.length === 0
    ? ('结论:代码都在位并通过校验。' + (pending
      ? '还欠一条直接证据:她那边要发生一次"一轮调两次以上工具"的轮次,B2 的多行 trace 才有样本。'
      : '她在会话里用的宿主工具也留痕了。'))
    : '结论:' + failed.length + ' 条没通过。')
}
process.exitCode = failed.length === 0 ? 0 : 1
