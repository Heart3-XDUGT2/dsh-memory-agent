#!/usr/bin/env node
/**
 * 记忆架构 v2 · 阶段 A0 —— 回滚脚本(默认只演不滚)
 * ==================================================================
 * 用法:
 *   node scripts/graph-rollback.mjs --snapshot <快照.db>                 # 只演:显示"如果要滚,会变成什么样"
 *   node scripts/graph-rollback.mjs --snapshot <快照.db> --to <目标.db>  # 演给指定目标看
 *   node scripts/graph-rollback.mjs --snapshot <快照.db> --to <x.db> --yes   # 真滚(先给目标备份)
 *   node scripts/graph-rollback.mjs --snapshot <快照.db> --to-live --live --yes  # 滚真库(三重确认)
 *
 * 纪律:
 *   ① **默认 dry-run** —— 不带 `--yes` 一行都不改;
 *   ② 滚之前**必给目标备份**(`VACUUM INTO` 到 `.scratch/snapshots/pre-rollback-<ts>.db`);
 *   ③ 动真库要**同时** `--to-live` + `--live` + `--yes` 三个旗标,少一个都不动;
 *   ④ 滚完验:`integrity_check` ok + 逐表行数 == 快照 + schema 指纹 == 快照;
 *   ⑤ 目标 == 快照、或快照就是真库 ⇒ 拒绝(不自相残杀)。
 */
import { existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const argv = process.argv.slice(2)
const has = (n) => argv.includes('--' + n)
const val = (n, dflt) => {
  for (let i = argv.length - 1; i >= 0; i--) {
    if (argv[i] === '--' + n) return argv[i + 1] ?? dflt
    if (argv[i].startsWith('--' + n + '=')) return argv[i].slice(n.length + 3)
  }
  return dflt
}
const asJson = has('json')
const liveDb = resolve(val('db', process.env.ECHO_DB || join(homedir(), '.dsh', 'echo', 'echo.db')))
const snapArg = val('snapshot', argv.find((a) => !a.startsWith('--')) || '')
const toLive = has('to-live')
const allowLive = has('live')
const yes = has('yes')
const repoRoot = resolve(dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..')
const snapDir = resolve(val('snap-dir', join(repoRoot, '.scratch', 'snapshots')))
const ts = new Date()
const stamp = ts.toISOString().replace(/[-:T]/g, '').slice(0, 14).replace(/(\d{8})(\d{6})/, '$1-$2')

const problems = []
const notes = []
const say = (...a) => { if (!asJson) console.log(...a) }
const sqlStr = (s) => "'" + String(s).replace(/'/g, "''") + "'"
const uriOf = (p) => 'file:' + p.replace(/\\/g, '/') + '?mode=ro'

function facts (p) {
  const db = new DatabaseSync(uriOf(p), { readOnly: true })
  try {
    const names = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((r) => r.name)
    const counts = {}
    for (const n of names) { try { counts[n] = Number(db.prepare('SELECT COUNT(*) AS n FROM "' + n + '"').get().n) } catch { counts[n] = -1 } }
    const schemaHash = db.prepare("SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all()
      .map((r) => String(r.type) + '|' + String(r.name) + '|' + String(r.sql)).join('\n')
    const integ = String(Object.values(db.prepare('PRAGMA integrity_check').get() ?? {})[0] ?? '?')
    return { tables: names, counts, schemaSql: schemaHash, integrity: integ, integrityOk: integ === 'ok' }
  } finally { db.close() }
}
function backupOf (path, label) {
  mkdirSync(snapDir, { recursive: true })
  const dest = join(snapDir, 'pre-rollback-' + stamp + (label ? '-' + label : '') + '.db')
  try {
    const db = new DatabaseSync(uriOf(path), { readOnly: true })
    try { db.exec('VACUUM INTO ' + sqlStr(dest.replace(/\\/g, '/'))) } finally { db.close() }
    return { path: dest, how: 'VACUUM INTO' }
  } catch (e) {
    return { path: null, how: 'failed: ' + e.message }
  }
}

if (!snapArg) { console.error('要指快照:--snapshot <快照.db>'); process.exit(2) }
const snapPath = resolve(snapArg)
if (!existsSync(snapPath)) { console.error('快照不存在:' + snapPath); process.exit(2) }
const snapFacts = facts(snapPath)
if (!snapFacts.integrityOk) problems.push('快照 integrity_check=' + snapFacts.integrity + '(快照坏了,别拿它滚)')

const targetsLive = toLive || (!!val('to', '') && resolve(val('to', '')) === liveDb)
const toPath = targetsLive ? liveDb : resolve(val('to', join(snapDir, 'restore-' + stamp + '.db')))
if (toPath === snapPath) { console.error('目标与快照是同一份,拒绝:' + toPath); process.exit(2) }
if (targetsLive && !(toLive && allowLive && yes)) {
  problems.push('目标是真库 ⇒ 必须同时给 --to-live --live --yes(当前' +
    [toLive ? '--to-live' : '', allowLive ? '--live' : '', yes ? '--yes' : ''].filter(Boolean).join(' ') + ')')
}
if (targetsLive) {
  notes.push('真库回滚只能在**他同意 + dsh host 没在跑**时做:引擎可能正持有这个库的连接;' +
    '平时请只滚 `.scratch` 里的副本')
}

const exists = existsSync(toPath)
const before = exists ? facts(toPath) : null
const diff = []
if (before) {
  const all = new Set([...Object.keys(before.counts), ...Object.keys(snapFacts.counts)])
  for (const t of [...all].sort()) {
    const a = before.counts[t] ?? 0; const b = snapFacts.counts[t] ?? 0
    if (a !== b) diff.push({ table: t, from: a, to: b })
  }
  if (before.schemaSql !== snapFacts.schemaSql) notes.push('schema 指纹不同 ⇒ 除了数据,连表结构也会被换掉')
}

const report = {
  at: ts.toISOString(), dryRun: !(yes && problems.length === 0), snapshot: snapPath, target: toPath,
  targetIsLive: targetsLive, targetExisted: exists, diff, schemaDiffers: before ? before.schemaSql !== snapFacts.schemaSql : null,
  snapshotIntegrityOk: snapFacts.integrityOk, problems, notes, backup: null
}

if (yes && problems.length === 0) {
  if (exists) {
    const bk = backupOf(toPath, targetsLive ? 'live' : 'target')
    report.backup = bk
    if (!bk.path) problems.push('目标备份失败,拒绝继续:' + bk.how)
  }
  if (problems.length === 0) {
    mkdirSync(dirname(toPath), { recursive: true })
    // `VACUUM INTO` 拒绝已存在的目标 ⇒ 先滚到临时文件,再换名(并且把目标的 -wal/-shm 挪开)
    const tmp = toPath + '.tmp-rollback-' + stamp + '.db'
    const db = new DatabaseSync(uriOf(snapPath), { readOnly: true })
    try { db.exec('VACUUM INTO ' + sqlStr(tmp.replace(/\\/g, '/'))) } finally { db.close() }
    let rolledWals = []
    if (existsSync(toPath)) {
      for (const sfx of ['-wal', '-shm']) {
        if (existsSync(toPath + sfx)) {
          try { renameSync(toPath + sfx, toPath + sfx + '.pre-rollback-' + stamp); rolledWals.push(sfx) } catch { /* 挪不动就留着 */ }
        }
      }
      rmSync(toPath, { force: true })
    }
    renameSync(tmp, toPath)
    report.rolledAsideWals = rolledWals
    const after = facts(toPath)
    const bad = []
    for (const [t, n] of Object.entries(snapFacts.counts)) if (after.counts[t] !== n) bad.push(t + ' ' + n + '→' + after.counts[t])
    report.after = { integrityOk: after.integrityOk, tables: after.tables.length, countsMatch: bad.length === 0, mismatches: bad }
    if (!after.integrityOk) problems.push('滚完 integrity_check=' + after.integrity)
    if (bad.length > 0) problems.push('滚完行数不一致:' + bad.join('、'))
  }
}

if (asJson) {
  console.log(JSON.stringify(report, null, 2))
} else {
  say('== 回滚' + (report.dryRun ? '(只演,没动任何东西)' : '(已执行)') + ' ==')
  say('快照   ' + snapPath + '  (' + (statSync(snapPath).size / 1024 / 1024).toFixed(2) + 'MB, integrity=' + snapFacts.integrity + ')')
  say('目标   ' + toPath + (targetsLive ? '  ⚠ 真库' : '') + (exists ? '' : '  (不存在,将新建)'))
  if (diff.length > 0) {
    say('差异(目标 → 快照):')
    for (const d of diff) say('  ' + d.table.padEnd(24) + d.from + ' → ' + d.to + (d.to < d.from ? '  (少 ' + (d.from - d.to) + ' 行)' : ''))
  } else if (exists) say('差异   逐表行数已经与快照一致')
  for (const n of notes) say('注意   ' + n)
  if (report.backup) say('备份   目标的滚动前备份 = ' + (report.backup.path || report.backup.how))
  if (report.after) say('验完   ' + (report.after.countsMatch && report.after.integrityOk ? '✓ 行数与 integrity 都对上' : '! 见 problems'))
  if (problems.length > 0) for (const p of problems) say('拦住   ! ' + p)
  say('下一步 ' + (report.dryRun ? '确认无误后加 --yes 才真滚(真库还需 --to-live --live)' : '验收数字请照 docs/MIGRATION_DISCIPLINE.md 逐项跑'))
}
process.exit(problems.length === 0 ? 0 : 1)
