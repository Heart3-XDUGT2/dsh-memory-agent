#!/usr/bin/env node
/**
 * 图谱边依据回填(M1)
 * ============================================================
 * 用法:
 *   node scripts/graph-evidence-backfill.mjs              # dry-run(默认):只打印计划
 *   node scripts/graph-evidence-backfill.mjs --apply      # 落库(写 evidence + 一行审计)
 *   node scripts/graph-evidence-backfill.mjs --limit 20   # 只看/只补前 N 条
 *
 * 为什么需要:evidence 列是 v0.16.0 M1 才有的,**老边没有任何依据**
 * (活库 33 条边全是空的)。历史没法凭空恢复,只能用字面匹配做**推定**
 * 回填,并且:
 *   - 只认「两个端点名都出现在同一条记忆里」的强匹配(score ≥ 2);
 *   - 匹配不到就**留空** —— 宁可承认「追不到原话」,也不瞎指;
 *   - 写进去的值后缀 `(推定)`,面板与解析器都能一眼看出这不是写入时
 *     记下的原生依据(store.js 解析 evidenceIds 时非数字 token 会被丢掉)。
 *
 * 原则:默认 dry-run;幂等(已有 evidence 的边不动);只读源=同一个库。
 */
import { existsSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { openStore } from '../lib/store.js'

const argv = process.argv.slice(2)
const apply = argv.includes('--apply')
const limitArg = (() => {
  const i = argv.indexOf('--limit')
  return i !== -1 && argv[i + 1] ? Number(argv[i + 1]) : 0
})()
const dbPath = process.env.ECHO_DB ?? join(homedir(), '.dsh', 'echo', 'echo.db')
if (!existsSync(dbPath)) {
  console.error('库不存在: ' + dbPath)
  process.exit(1)
}

// 走 openStore:它顺带把 v0.16.0 M1 的 evidence 列迁移补上(裸开库会
// `no such column: evidence` —— 活库在插件插桩之前就是这个状态)。
const store = openStore(dbPath)
const db = store.db
const now = Date.now() / 1000

const nodes = new Map(
  db.prepare('SELECT node_id, name FROM graph_nodes').all().map((r) => [String(r.node_id), String(r.name)])
)
const edges = db.prepare(
  "SELECT edge_id, source_id, target_id, relation FROM graph_edges" +
  " WHERE evidence IS NULL OR evidence = '' ORDER BY edge_id" +
  (limitArg > 0 ? ' LIMIT ' + Math.floor(limitArg) : '')
).all()

const mems = db.prepare(
  "SELECT memory_id, summary, keywords, memory_key FROM episodic_memory" +
  " WHERE is_active = 1 AND status = 'active'"
).all().map((r) => ({
  id: Number(r.memory_id),
  text: [String(r.summary || ''), String(r.keywords || ''), String(r.memory_key || '')].join(' ')
}))

const plan = []
for (const e of edges) {
  const sName = nodes.get(String(e.source_id)) || ''
  const tName = nodes.get(String(e.target_id)) || ''
  const rel = String(e.relation || '')
  if (sName === '' || tName === '') continue
  const scored = []
  for (const m of mems) {
    let score = 0
    if (m.text.includes(sName)) score += 1
    if (m.text.includes(tName)) score += 1
    if (score < 2) continue
    if (rel !== '' && m.text.includes(rel)) score += 1
    scored.push({ id: m.id, score })
  }
  scored.sort((a, b) => (b.score - a.score) || (b.id - a.id))
  const picked = scored.filter((x) => x.score >= 2).slice(0, 3)
  plan.push({
    edgeId: Number(e.edge_id),
    triple: sName + ' -' + rel + '-> ' + tName,
    evidence: picked.map((x) => x.id),
    score: picked.length > 0 ? picked[0].score : 0
  })
}

const hit = plan.filter((p) => p.evidence.length > 0)
console.log('待回填边: ' + plan.length + ' 条;能推定出依据的: ' + hit.length + ' 条')
for (const p of plan) {
  console.log('  #' + p.edgeId + ' ' + p.triple + ' → '
    + (p.evidence.length ? p.evidence.map((x) => '记忆#' + x).join('、') + '(推定)' : '(追不到原话,留空)'))
}

if (!apply) {
  console.log('\n[dry-run] 没写库。加 --apply 落库。')
  db.close()
  process.exit(0)
}

let written = 0
for (const p of hit) {
  db.prepare('UPDATE graph_edges SET evidence = ? WHERE edge_id = ?')
    .run(p.evidence.map((x) => x).join('、') + '(推定)', p.edgeId)
  written += 1
}
try {
  db.prepare(
    'INSERT INTO audit_logs (trace_id, session_id, user_key, is_master, user_input, tool_call, timestamp)' +
    ' VALUES (?, ?, ?, 1, ?, ?, ?)'
  ).run(randomUUID(), 'global', 'master',
    '图谱依据回填: ' + written + ' 条(共 ' + plan.length + ' 条待回填,强匹配才写)',
    'graph_evidence_backfill', now)
} catch { /* 审计写不进不该让回填失败 */ }
console.log('\n已写 ' + written + ' 条边的依据(后缀 (推定))+ 1 行审计。')
db.close()
