/**
 * v0.31.0 P2 真机验收(**只读**):`node scripts/accept-p2.mjs [--port 3080] [--base URL] [--json]`
 *
 * 为什么单开一条脚本:前面三件(P1 契约自检 / P2 退避+账+闹钟)都改在**跑着的宿主进程**里,
 * 而"改完提交"和"真的在跑"是两件事 —— 2026-09-26~28 那几次事故全是后者。
 * 所以验收的口径是**从外面看**:状态面拿得到新字段、活的账本里真有表真有行、
 * 最近一拍的时间戳说明心跳在跳。**一条不通过就不许说验收过。**
 *
 * 只读纪律:库用 readOnly 打开,不发任何请求以外的动作,不改配置、不建表。
 * 默认端口 3080(本 GUI);找不到就报出来,不猜。
 */
import { DatabaseSync } from 'node:sqlite'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { summarizeBeats, describeReason } from '../lib/care-report.js'

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
const dbPath = flag('--db', '') || (process.env.DSH_ECHO_DB ?? join(homedir(), '.dsh', 'echo', 'echo.db'))

/** 心跳能写进账的理由(枚举,与 lib/heartbeat.js 的 logBeat 调用点一一对应)。 */
const LEDGER_REASONS = new Set([
  'sent', 'engine-says-no', 'night-hold', 'session-mismatch', 'daily-cap', 'pending-ack',
  'deliver-busy', 'tick-error', 'reminder-sent', 'reminder-busy',
  'wake-sent', 'wake-night-hold', 'wake-busy', 'wake-off'
])

const lines = []
const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok: ok === true, detail: String(detail) })
  lines.push((ok === true ? '  ok   ' : '  FAIL ') + name + (detail === '' ? '' : ' —— ' + detail))
  return ok === true
}

// ---- ① 状态面(宿主里那份真的加载了吗) ----
let status = null
let fetchErr = ''
try {
  const res = await fetch(base + '/api/echo/status', { signal: AbortSignal.timeout(4000) })
  status = await res.json()
} catch (err) { fetchErr = String(err?.message ?? err) }

if (status === null) {
  let ports = ''
  try {
    ports = execFileSync('pwsh', ['-NoProfile', '-Command', 'Get-NetTCPConnection -State Listen | Select-Object -ExpandProperty LocalPort | Sort-Object -Unique'], { encoding: 'utf8', timeout: 4000 }).trim().split('\n').join(' ')
  } catch { ports = '(列不出来)' }
  check('状态面可达 ' + base + '/api/echo/status', false, fetchErr + ';本机在听的端口: ' + ports)
} else {
  check('状态面可达 ' + base + '/api/echo/status', true)
  // 版本:P2 是 0.31.0 ⇒ 看到新版本号 = 宿主真的加载了新代码
  const v = String(status.version ?? '')
  check('加载的是新代码(version ≥ 0.31.0)', /^0\.(3[1-9]|[4-9]\d|\d{3,})\./.test(v), '实际 version=' + v + '(期望 0.31.0;旧号 = 还没重启)')
  const care = status.care
  check('care 是对象(P2 的 careTrace 挂上了)', care !== null && typeof care === 'object')
  if (care !== null && typeof care === 'object') {
    check('care.reason 在枚举里', LEDGER_REASONS.has(String(care.reason ?? '')) || String(care.reason) === 'backoff' || String(care.reason) === 'idle', 'reason=' + String(care.reason) + ' 人话=' + describeReason(care.reason))
    check('care 带退避字段(quietStreak / nextPollAt)', typeof care.quietStreak === 'number' && typeof care.nextPollAt === 'number', 'quietStreak=' + care.quietStreak + ' nextPollAt=' + care.nextPollAt)
    check('care 带落账失败计数(writeFailed === 0)', Number(care.writeFailed) === 0, 'writeFailed=' + care.writeFailed)
    const at = Number(care.at) || 0
    const ageMin = at > 0 ? Math.round((Date.now() / 1000 - at) / 60) : -1
    // 心跳 60s 一跳 + 退避最多 8 分钟 ⇒ 15 分钟内一定有新结论(否则心跳没在跳)
    check('心跳在跳(care.at 在 15 分钟内)', ageMin >= 0 && ageMin <= 15, at === 0 ? 'care.at=0 —— 一次都没判过' : '最近一次判定 ' + ageMin + ' 分钟前')
  }
  // 服务契约(P1)挂在**进程内的服务对象**上(`echo:relay` 的 `status()` 才带 api/capabilities),
  // **不在这个 HTTP 面上** —— 这个面(`statusPayload().relay`)只有队列/渠道那几项。
  // 所以要到嘴那边看:`/api/echo-qq/status` 会把 `probeService()` 的结论
  // (`channel.contract`)与主包干跑自检(`channel.selftest`)一并报出来。
  // ⚠️ 这条是本次验收**自己抓到的口径错**(第一版在这里查主包 HTTP 面,恒 FAIL)。
  check('主包 HTTP 面不带 api/capabilities(与设计一致)', status.api === undefined,
    'status.api=' + JSON.stringify(status.api) + ' —— 契约面在进程内服务上,查法见下两条')
  let qq = null
  try {
    const r2 = await fetch(base + '/api/echo-qq/status', { signal: AbortSignal.timeout(4000) })
    qq = await r2.json()
  } catch (err) {
    check('嘴那边可达 /api/echo-qq/status', false, '渠道插件没起?—— ' + String(err?.message ?? err))
  }
  if (qq !== null) {
    const c = qq?.channel?.contract ?? null
    const s = qq?.channel?.selftest ?? null
    check('嘴那边 P1 契约判定 ok(channel.contract.ok)', c?.ok === true,
      'api=' + JSON.stringify(c?.api) + ' 能力=' + (Array.isArray(c?.have) ? c.have.length : 0) + ' 项 missing=' + JSON.stringify(c?.missing ?? []))
    check('嘴那边主包干跑自检 ok(channel.selftest.ok)', s?.ok === true,
      '检查项=' + (Array.isArray(s?.checks) ? s.checks.length : 0) + ' ' + String(s?.note ?? ''))
  }
}

// ---- ② 活的账本(表在不在、有没有行、最近一拍多久以前) ----
let rows = []
let sum = { total: 0, acted: 0, byReason: [] }
if (!existsSync(dbPath)) {
  check('账本文件在位 ' + dbPath, false, '找不到 —— 她还没起过?或 --db 指错了')
} else {
  check('账本文件在位', true, dbPath)
  let db = null
  try {
    db = new DatabaseSync(dbPath, { readOnly: true })
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => String(r.name)))
    check('care_beats 表已建(说明 P2 的 store 真的跑过)', tables.has('care_beats'))
    check('echo_wakes 表已建', tables.has('echo_wakes'))
    if (tables.has('care_beats')) {
      const since = Date.now() / 1000 - 86400
      rows = db.prepare('SELECT * FROM care_beats WHERE at >= ? ORDER BY at DESC LIMIT 200').all(since)
      sum = summarizeBeats(rows.slice().reverse())
      check('最近 24 小时有账(至少一拍)', rows.length > 0, rows.length + ' 拍')
      if (rows.length > 0) {
        const last = rows[0]
        const ageMin = Math.round((Date.now() / 1000 - Number(last.at)) / 60)
        check('最近一拍在 15 分钟内(心跳正落账)', ageMin <= 15, '最近一拍 ' + ageMin + ' 分钟前 reason=' + String(last.reason))
        const bad = rows.map((r) => String(r.reason)).filter((r) => !LEDGER_REASONS.has(r))
        check('账上的 reason 全在枚举里(没有自由发挥)', bad.length === 0, bad.length === 0 ? '' : '越界值: ' + [...new Set(bad)].join(','))
      }
    }
    if (tables.has('echo_wakes')) {
      const w = db.prepare('SELECT COUNT(*) AS n FROM echo_wakes').get()
      const due = db.prepare('SELECT COUNT(*) AS n FROM echo_wakes WHERE fired_at = 0 AND canceled_at = 0').get()
      lines.push('  info 她排过的闹钟共 ' + Number(w?.n ?? 0) + ' 个,其中还没响/没撤的 ' + Number(due?.n ?? 0) + ' 个')
    }
  } catch (err) {
    check('只读打开账本', false, String(err?.message ?? err))
  } finally {
    try { db?.close() } catch { /* 退进程时会关 */ }
  }
}

// ---- 报告 ----
const failed = results.filter((r) => !r.ok)
if (asJson) {
  console.log(JSON.stringify({ base, dbPath, results, care: status?.care ?? null, total: sum.total, byReason: sum.byReason, recent: rows.slice(0, 5) }, null, 2))
} else {
  console.log('# P2 真机验收 · ' + base + '(只读)')
  for (const l of lines) console.log(l)
  if (sum.total > 0) {
    console.log('  ── 最近 24 小时的账:' + sum.total + ' 拍 / 开口 ' + sum.acted + ' 次')
    for (const g of sum.byReason) console.log('     ' + String(g.reason).padEnd(18) + ' ×' + g.count + '  ' + describeReason(g.reason))
    console.log('  ── 最近 5 拍(新的在前):')
    for (const r of rows.slice(0, 5)) {
      console.log('     ' + new Date(Number(r.at) * 1000).toLocaleString('zh-CN') + '  ' + String(r.reason).padEnd(18) + ' acted=' + Number(r.acted) + ' value=' + Number(r.value))
    }
  }
  console.log(failed.length === 0
    ? '结论:全通过 —— P2 三件真的活在宿主里。'
    : '结论:' + failed.length + ' 条没通过(见上面的 FAIL)—— 没通过就不算验收过。')
}
process.exitCode = failed.length === 0 ? 0 : 1
