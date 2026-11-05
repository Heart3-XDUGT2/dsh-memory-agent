/**
 * 切换前的「真库迁移彩排」:拿**线上那份 echo.db** 做一次新版桥的落库演练。
 * ==================================================================
 * R2 的三张表是 `CREATE TABLE IF NOT EXISTS` 加出来的,而线上那份库是**老版本
 * 建的**(里面还没有这三张表)。单元测试与冒烟用的都是临时库 —— 「在新版代码
 * 打开真库的那一刻会发生什么」没人验过,而那正好是他重启 `dsh web` 的第一秒。
 *
 *   node scripts/rehearse-migration.mjs          # 默认看 ~/.dsh/echo/echo.db
 *   node scripts/rehearse-migration.mjs --db=<路径>
 *   node scripts/rehearse-migration.mjs --json
 *
 * 纪律:**只动副本**。先用 `VACUUM INTO` 从真库拉一份一致快照(库正被写也安全;
 * 拿不到就退回三件套复制),之后所有操作都在临时目录里,跑完即删。
 *
 * 它回答四个问题:
 *   ① 新版 store 打开真库会不会抛(DDL 能不能落上去);
 *   ② 落完之后**原有表一行都不许变**(迁移不是重建);
 *   ③ `integrity_check` 过不过(顺手体检:切换前该知道库是不是好的);
 *   ④ 三张新表在这份真库上**读得动、写得进吗**(入队 → 领租约 → 销账走一遍)。
 */
import { copyFileSync, existsSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { openStore } from '../lib/store.js'

const args = process.argv.slice(2)
const asJson = args.includes('--json')
const val = (name, dflt) => {
  const hits = args.filter((a) => a.startsWith('--' + name + '='))
  return hits.length === 0 ? dflt : hits[hits.length - 1].slice(name.length + 3)
}
const LIVE = val('db', join(homedir(), '.dsh', 'echo', 'echo.db'))
const RELAY_TABLES = ['relay_inbox_seen', 'relay_channels', 'relay_outbox']

const problems = []
const notes = []
const lines = []
const ok = (label, msg) => lines.push(['  ✓', label, msg])
const bad = (label, msg) => { lines.push(['  !', label, msg]); problems.push(label + ':' + msg) }
const note = (label, msg) => { lines.push(['  ·', label, msg]); notes.push(label + ':' + msg) }

const q = (s) => "'" + String(s).replace(/'/g, "''") + "'"

/** 表的行数快照(只读打开,不建不写)。 */
function tableCounts (path) {
  const db = new DatabaseSync(path, { readOnly: true })
  const names = db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
  ).all().map((r) => r.name)
  const counts = {}
  for (const n of names) {
    try { counts[n] = db.prepare('SELECT COUNT(*) AS n FROM "' + n + '"').get().n } catch { counts[n] = -1 }
  }
  const out = { names, counts }
  db.close()
  return out
}

function integrityOf (path) {
  const db = new DatabaseSync(path, { readOnly: true })
  const row = db.prepare('PRAGMA integrity_check').get()
  const jm = db.prepare('PRAGMA journal_mode').get()
  const ps = db.prepare('PRAGMA page_size').get()
  db.close()
  return {
    ok: String(Object.values(row ?? {})[0] ?? '') === 'ok',
    detail: String(Object.values(row ?? {})[0] ?? '?'),
    journalMode: String(Object.values(jm ?? {})[0] ?? '?'),
    pageSize: Number(Object.values(ps ?? {})[0]) || 0
  }
}

/** 真库本身的几个 PRAGMA(journal 模式要问真库 —— 快照自己永远是 delete)。 */
function livePragmas () {
  try {
    const db = new DatabaseSync(LIVE, { readOnly: true })
    const jm = db.prepare('PRAGMA journal_mode').get()
    const ps = db.prepare('PRAGMA page_size').get()
    const pageCount = db.prepare('PRAGMA page_count').get()
    db.close()
    return {
      journalMode: String(Object.values(jm ?? {})[0] ?? '?'),
      pageSize: Number(Object.values(ps ?? {})[0]) || 0,
      bytes: (Number(Object.values(pageCount ?? {})[0]) || 0) * (Number(Object.values(ps ?? {})[0]) || 0)
    }
  } catch { return null }
}

/** 从真库拉一份一致快照(库在写也安全);失败退回三件套复制。 */
function snapshotLive (destPath) {
  try {
    const db = new DatabaseSync(LIVE, { readOnly: true })
    db.exec('VACUUM INTO ' + q(destPath))
    db.close()
    return 'VACUUM INTO(一致快照,库在写也安全)'
  } catch (e) {
    notes.push('VACUUM INTO 失败(' + e.message + '),退回三件套复制')
    copyFileSync(LIVE, destPath)
    for (const suffix of ['-wal', '-shm']) {
      if (existsSync(LIVE + suffix)) {
        try { copyFileSync(LIVE + suffix, destPath + suffix) } catch { /* 拷不到就算了 */ }
      }
    }
    return '三件套复制(快照可能被并发写撕开,看 integrity_check)'
  }
}

const dir = mkdtempSync(join(tmpdir(), 'echo-rehearse-'))
const copy = join(dir, basename(LIVE))
const report = { at: new Date().toISOString(), live: LIVE, copy, how: null, problems, notes }

try {
  if (!existsSync(LIVE)) {
    console.log('没找到真库:' + LIVE + '(用 --db= 指一份)')
    process.exit(2)
  }
  const size = statSync(LIVE).size
  report.how = snapshotLive(copy)
  report.livePragmas = livePragmas()
  report.integrity = integrityOf(LIVE)          // 真库体检(只读)
  report.snapshotIntegrity = integrityOf(copy)  // 快照完不完整(被并发写撕开会在这里露)
  const before = tableCounts(copy)
  report.tablesBefore = before.names
  report.countsBefore = before.counts
  // 桥表可能**早就在库里**(比如跑过合并脚本时 openStore 落过 DDL)——
  // 那也算通过,只是不该谎报「本次新建」。
  report.relayPresentBefore = RELAY_TABLES.filter((t) => before.names.includes(t))

  // ② 新版 store 打开副本(= 他重启后的第一秒)
  let store = null
  try {
    store = openStore(copy)
    ok('新版 store 打开真库', '没抛异常(' + report.how + ')')
  } catch (e) {
    bad('新版 store 打开真库', '抛了:' + e.message)
  }

  if (store !== null) {
    const after = tableCounts(copy)
    report.tablesAfter = after.names
    report.countsAfter = after.counts
    const added = after.names.filter((n) => !before.names.includes(n))
    const removed = before.names.filter((n) => !after.names.includes(n))
    report.tablesAdded = added
    const relayAdded = RELAY_TABLES.filter((t) => after.names.includes(t))
    report.relayPresentAfter = relayAdded
    if (relayAdded.length === RELAY_TABLES.length) {
      const news = RELAY_TABLES.filter((t) => !before.names.includes(t))
      ok('三张桥表在位', news.length === 0
        ? '打开前就在库里(' + relayAdded.join('、') + ')—— 没新建,旧库也不算缺'
        : '本次新建:' + news.join('、'))
    } else {
      bad('三张桥表在位', '缺 ' + RELAY_TABLES.filter((t) => !after.names.includes(t)).join('、'))
    }
    if (removed.length > 0) bad('原有表还在', '有表不见了:' + removed.join('、'))
    else ok('原有表还在', after.names.length - added.length + ' 张原有表都在')

    // ② 原有表一行都不许变
    const changed = []
    for (const [table, was] of Object.entries(before.counts)) {
      const now = after.counts[table]
      if (typeof now === 'number' && now !== was) changed.push(table + ' ' + was + '→' + now)
    }
    report.changed = changed
    if (changed.length > 0) bad('原有数据未被动过', changed.join('、'))
    else ok('原有数据未被动过', Object.keys(before.counts).length + ' 张表行数逐张一致')

    // ③ 体检
    if (report.integrity.ok) ok('真库 integrity_check', 'ok(journal=' + report.integrity.journalMode + ', page=' + report.integrity.pageSize + 'B)')
    else bad('真库 integrity_check', report.integrity.detail)
    if (!report.snapshotIntegrity.ok) {
      note('快照 integrity_check', report.snapshotIntegrity.detail + '(并发写撕开的副本,不代表真库坏)')
    }

    // ④ 三张新表在这份真库上读得动、写得进吗
    report.probe = {}
    try {
      const enq = store.relayEnqueue({
        platform: 'qq', chatId: 'rehearse-probe', sessionId: 'session-echo-companion',
        turnId: 'rehearse-turn', kind: 'reply', text: '彩排探针', now: 1_760_000_000
      })
      const leased = store.relayLeaseOutbox({ platform: 'qq', limit: 5, leaseSec: 30, now: 1_760_000_001 })
      const mine = (leased.items || []).find((i) => i.chatId === 'rehearse-probe')
      const acked = store.relayAckOutbox({ ids: [enq.outId], now: 1_760_000_002 })
      report.probe = { enqueued: enq.ok === true, leased: mine !== undefined, acked: Number(acked.acked ?? acked.changes ?? 0) }
      if (enq.ok && mine !== undefined && Number(acked.acked ?? acked.changes ?? 0) >= 1) {
        ok('三张新表读写', '入队 → 领租约 → 销账 走通(out_id=' + enq.outId + ')')
      } else {
        bad('三张新表读写', JSON.stringify(report.probe))
      }
      report.queueStats = store.relayQueueStats({})
      ok('队列统计可读', JSON.stringify(report.queueStats))
    } catch (e) {
      bad('三张新表读写', '抛了:' + e.message)
    }
    try { store.close() } catch { /* 关不掉不算错 */ }
  }

  // 切段/合同相关:也让两侧 DDL 的列名露个脸(答辩时能指着说「这就是那三张表」)
  try {
    const db = new DatabaseSync(copy, { readOnly: true })
    report.columns = {}
    for (const t of RELAY_TABLES) {
      if (!report.tablesAfter.includes(t)) continue
      report.columns[t] = db.prepare('PRAGMA table_info("' + t + '")').all().map((c) => c.name)
    }
    db.close()
  } catch { /* 只是附加信息 */ }
} finally {
  try { rmSync(dir, { recursive: true, force: true }) } catch { /* 清理失败不该影响结论 */ }
}

if (asJson) {
  console.log(JSON.stringify(report, null, 2))
} else {
  console.log('== 真库迁移彩排(只动副本)==')
  const lp = report.livePragmas
  console.log('真库   ' + LIVE + (lp ? '  (' + (lp.bytes / 1024 / 1024).toFixed(2) + 'MB, journal=' + lp.journalMode + ', page=' + lp.pageSize + 'B)' : ''))
  console.log('快照   ' + report.how)
  console.log('副本   ' + report.copy + '(跑完已删)')
  console.log('')
  for (const [mark, label, msg] of lines) console.log(mark + ' ' + String(label).padEnd(18) + ' ' + msg)
  if (report.columns) {
    console.log('')
    console.log('落库后的三张表:')
    for (const [t, cols] of Object.entries(report.columns)) console.log('  ' + t.padEnd(18) + cols.join(', '))
  }
  console.log('')
  console.log(problems.length === 0
    ? '  ✓ 彩排通过:新版桥在真库上能落表、不碰旧数据、读写都通 —— 重启那一秒不会出事'
    : '  ! 有 ' + problems.length + ' 项要先看(见上)')
}
process.exit(problems.length === 0 ? 0 : 1)
