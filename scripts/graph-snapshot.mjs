#!/usr/bin/env node
/**
 * 记忆架构 v2 · 阶段 A0 —— 回退点快照(纯增脚本,绝不写真库)
 * ==================================================================
 * 用法:
 *   node scripts/graph-snapshot.mjs                       # 给真库拉一个回退点(默认 ~/.dsh/echo/echo.db)
 *   node scripts/graph-snapshot.mjs --db <path>           # 指定库(也认 --db=<path> 与 $ECHO_DB)
 *   node scripts/graph-snapshot.mjs --label=a1-before     # 给这个回退点起个名(便于事后找)
 *   node scripts/graph-snapshot.mjs --out-dir <dir>       # 换落点(默认 <repo>/.scratch/snapshots)
 *   node scripts/graph-snapshot.mjs --keep=10             # 只留最近 N 个(默认 10,永不删最新的)
 *   node scripts/graph-snapshot.mjs --copy-to <path>      # 彩排副本模式:把一致快照放到指定路径(供演练改)
 *   node scripts/graph-snapshot.mjs --json                # 结构化结果
 *
 * 纪律(与 docs/MIGRATION_DISCIPLINE.md 同源):
 *   ① **只读开真库**:`file:<abs>?mode=ro` URI + `readOnly: true` 双保险,连 PRAGMA 都不写;
 *   ② 快照用 `VACUUM INTO`(库正被写也拿得到一致副本),不是文件拷贝;
 *   ③ 快照完**逐表行数 + schema 指纹 + integrity_check** 三项都对上,才算回退点成立;
 *   ④ 跑完真库的 sha256 与 mtime 必须**没变** —— 变了就红(说明有别的进程在写,回退点不干净);
 *   ⑤ 落点在 `.scratch/`(已 gitignore):快照里是真库全量,**绝不能进 git**。
 */
import { createHash } from 'node:crypto'
import {
  closeSync, copyFileSync, existsSync, mkdirSync, openSync, readdirSync, readSync, statSync, unlinkSync, writeFileSync
} from 'node:fs'
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
const quiet = has('quiet')
const label = val('label', '')
const keep = Math.max(0, Number(val('keep', '10')) || 10)
const dbPath = resolve(val('db', process.env.ECHO_DB || join(homedir(), '.dsh', 'echo', 'echo.db')))
const copyTo = val('copy-to', '')
const repoRoot = resolve(dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..')
const outDir = resolve(val('out-dir', join(repoRoot, '.scratch', 'snapshots')))

const uriOf = (p) => 'file:' + p.replace(/\\/g, '/') + '?mode=ro'
const sqlStr = (s) => "'" + String(s).replace(/'/g, "''") + "'"
/** 分块算 sha256:大库也不把内存吃满。
 *  读不了(宿主正持有库句柄时 Windows 会拒绝)⇒ 返回 null,表示**未知**,
 *  调用方必须按"未知"处理,绝不把 null 当成"变了"。 */
const shaOf = (p) => {
  try {
    const h = createHash('sha256')
    const fd = openSync(p, 'r')
    const buf = Buffer.alloc(1 << 20)
    try {
      for (;;) {
        const n = readSync(fd, buf, 0, buf.length, null)
        if (n <= 0) break
        h.update(buf.subarray(0, n))
      }
    } finally { closeSync(fd) }
    return h.digest('hex')
  } catch {
    return null
  }
}
const fileStat = (p) => {
  const st = statSync(p)
  return { path: p, bytes: st.size, mtimeMs: st.mtimeMs, sha256: shaOf(p) }
}
function dbFacts (p) {
  const db = new DatabaseSync(uriOf(p), { readOnly: true })
  try {
    const names = db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
    ).all().map((r) => r.name)
    const counts = {}
    for (const n of names) {
      try { counts[n] = Number(db.prepare('SELECT COUNT(*) AS n FROM "' + n + '"').get().n) } catch { counts[n] = -1 }
    }
    const schemaRows = db.prepare(
      "SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name"
    ).all()
    const schemaHash = createHash('sha256').update(schemaRows.map((r) => String(r.type) + '|' + String(r.name) + '|' + String(r.sql)).join('\n')).digest('hex')
    const integ = String(Object.values(db.prepare('PRAGMA integrity_check').get() ?? {})[0] ?? '?')
    const jm = String(Object.values(db.prepare('PRAGMA journal_mode').get() ?? {})[0] ?? '?')
    const ps = Number(Object.values(db.prepare('PRAGMA page_size').get() ?? {})[0]) || 0
    return { tableCount: names.length, tables: names, counts, schemaHash, integrity: integ, integrityOk: integ === 'ok', journalMode: jm, pageSize: ps }
  } finally { db.close() }
}

/** 一致快照(VACUUM INTO);失败退回三件套复制。 */
function snapshotInto (from, dest) {
  mkdirSync(dirname(dest), { recursive: true })
  try {
    const db = new DatabaseSync(uriOf(from), { readOnly: true })
    try { db.exec('VACUUM INTO ' + sqlStr(dest.replace(/\\/g, '/'))) } finally { db.close() }
    return 'VACUUM INTO'
  } catch (e) {
    copyFileSync(from, dest)
    for (const sfx of ['-wal', '-shm']) if (existsSync(from + sfx)) { try { copyFileSync(from + sfx, dest + sfx) } catch { /* 拷不到就算了 */ } }
    return '三件套复制(VACUUM 失败:' + e.message + ')'
  }
}

const problems = []
const say = (...a) => { if (!quiet) console.log(...a) }
const ts = new Date()
const stamp = ts.toISOString().replace(/[-:T]/g, '').slice(0, 14).replace(/(\d{8})(\d{6})/, '$1-$2')
const suffix = label ? '-' + label.replace(/[^A-Za-z0-9_.-]/g, '_') : ''

if (!existsSync(dbPath)) {
  console.error('库不存在:' + dbPath + '(用 --db <path> 或 $ECHO_DB 指定)')
  process.exit(2)
}
const liveBefore = fileStat(dbPath)
const liveFacts = dbFacts(dbPath)

let dest
if (copyTo) {
  dest = resolve(copyTo)
} else {
  mkdirSync(outDir, { recursive: true })
  dest = join(outDir, 'echo-' + stamp + suffix + '.db')
}
if (dest === dbPath) { console.error('落点不能是真库本身:' + dest); process.exit(2) }

const how = snapshotInto(dbPath, dest)
const snapStat = fileStat(dest)
const snapFacts = dbFacts(dest)
const liveAfter = fileStat(dbPath)

// 三项对上才算回退点成立
if (!snapFacts.integrityOk) problems.push('快照 integrity_check=' + snapFacts.integrity)
if (snapFacts.schemaHash !== liveFacts.schemaHash) problems.push('schema 指纹不一致(快照 与 真库,说明抓拍期间被 DDL 改过)')
const countDiff = []
for (const [t, n] of Object.entries(liveFacts.counts)) if (snapFacts.counts[t] !== n) countDiff.push(t + ' ' + n + '→' + snapFacts.counts[t])
if (countDiff.length > 0) problems.push('逐表行数不一致:' + countDiff.join('、'))
const liveTouched = liveAfter.sha256 !== liveBefore.sha256 || liveAfter.mtimeMs !== liveBefore.mtimeMs
if (liveTouched) problems.push('真库在抓拍期间被动过(sha/mtime 变了)⇒ 回退点不干净,请重跑')

const manifest = {
  at: ts.toISOString(),
  label: label || null,
  kind: copyTo ? 'rehearsal-copy' : 'rollback-point',
  how,
  live: { path: dbPath, ...liveBefore, journalMode: liveFacts.journalMode, pageSize: liveFacts.pageSize, tableCount: liveFacts.tableCount },
  snapshot: { path: dest, ...snapStat, tableCount: snapFacts.tableCount, integrityOk: snapFacts.integrityOk, schemaHash: snapFacts.schemaHash },
  counts: snapFacts.counts,
  keyCounts: {
    graph_edges: snapFacts.counts.graph_edges ?? null,
    graph_nodes: snapFacts.counts.graph_nodes ?? null,
    graph_shadow_edges: snapFacts.counts.graph_shadow_edges ?? null,
    graph_edge_receipts: snapFacts.counts.graph_edge_receipts ?? null,
    graph_aliases: snapFacts.counts.graph_aliases ?? null,
    episodic_memory: snapFacts.counts.episodic_memory ?? null
  },
  liveUntouched: !liveTouched,
  problems
}

let pruned = []
if (!copyTo && keep > 0) {
  const all = readdirSync(outDir).filter((f) => /^echo-.*\.db$/.test(f))
  const sorted = all.map((f) => ({ f, m: statSync(join(outDir, f)).mtimeMs })).sort((a, b) => b.m - a.m)
  for (const it of sorted.slice(keep)) {
    if (join(outDir, it.f) === dest) continue
    try { unlinkSync(join(outDir, it.f)) } catch { /* 删不掉不影响结论 */ }
    for (const sfx of ['.manifest.json', '-wal', '-shm']) { try { unlinkSync(join(outDir, it.f) + sfx) } catch { /* 同上 */ } }
    pruned.push(it.f)
  }
}

if (!copyTo) {
  writeFileSync(dest + '.manifest.json', JSON.stringify(manifest, null, 2), 'utf8')
}

if (asJson) {
  console.log(JSON.stringify({ ...manifest, dest, pruned }, null, 2))
} else {
  say('== 回退点快照(只读真库 + VACUUM INTO)==')
  say('真库   ' + dbPath + '  (' + (liveBefore.bytes / 1024 / 1024).toFixed(2) + 'MB, ' + liveFacts.tableCount + ' 张表, journal=' + liveFacts.journalMode + ')')
  say('落点   ' + dest + '  (' + how + ', ' + (snapStat.bytes / 1024 / 1024).toFixed(2) + 'MB)')
  say('指纹   sha256=' + snapStat.sha256.slice(0, 16) + '…  schema=' + snapFacts.schemaHash.slice(0, 16) + '…')
  say('关键数 graph_edges=' + manifest.keyCounts.graph_edges + ' nodes=' + manifest.keyCounts.graph_nodes +
      ' shadow=' + manifest.keyCounts.graph_shadow_edges + ' receipts=' + manifest.keyCounts.graph_edge_receipts +
      ' aliases=' + manifest.keyCounts.graph_aliases + ' memories=' + manifest.keyCounts.episodic_memory)
  say('真库   ' + (manifest.liveUntouched ? '✓ sha256/mtime 未变(没碰过它)' : '! 被抓拍期间被动过'))
  if (problems.length === 0) say('结论   ✓ 回退点成立(integrity ok · schema 指纹一致 · 逐表行数一致)')
  else for (const p of problems) say('结论   ! ' + p)
  if (pruned.length > 0) say('清理   按 --keep=' + keep + ' 删了 ' + pruned.length + ' 个旧快照:' + pruned.join('、'))
  if (copyTo) say('模式   彩排副本:拿它去改,改坏了直接删')
}
process.exit(problems.length === 0 ? 0 : 1)
