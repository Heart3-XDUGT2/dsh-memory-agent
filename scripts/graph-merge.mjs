#!/usr/bin/env node
/**
 * 图谱实体归一(合并,M2)
 * ============================================================
 * 用法:
 *   node scripts/graph-merge.mjs                          # dry-run:打印计划(默认)
 *   node scripts/graph-merge.mjs --report docs/GRAPH_MERGE_REVIEW.md
 *   node scripts/graph-merge.mjs --apply                  # 只并 Tier1(高置信)
 *   node scripts/graph-merge.mjs --apply --tier2 助手,后端架构
 *   node scripts/graph-merge.mjs --json                   # 机器读(给体检/报告)
 *
 * 规则表在 `lib/graph-aliases.js`(体检脚本与测试共用同一份真值):
 *   Tier1 = 高置信同实体(西电→西安电子科技大学)可自动并;
 *   Tier2 = 可能真是两件事(记忆架构家族),必须他点头后按名指定。
 *
 * 合并怎么落地(为什么不是 DELETE):
 *   `graph_edges` 上有 `UNIQUE(source_id, target_id, relation, owner_key)`。
 *   把旧边改指到 canonical 时,若那条三元组已存在就**撞唯一约束** ——
 *   所以:
 *     · 不冲突的边 → 直接改指 canonical;
 *     · 冲突的边   → 数字并入保留者(权重取大、想起次数相加、依据合并),
 *                    旧边 `is_active=0` 留档(仍指着旧节点);
 *     · 旧节点     → `is_active=0 + superseded_by=canonical`(墓碑),
 *                    不物理删除(删了会让留档边悬空)。
 *   面板与 BFS 只看 `is_active=1`,所以墓碑不会出现在图里。
 *   别名表 + 备份 JSON 是回滚依据(`~/.dsh/echo/backup/`)。
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { planMerges } from '../lib/graph-aliases.js'
import { openStore } from '../lib/store.js'

const argv = process.argv.slice(2)
const apply = argv.includes('--apply')
const asJson = argv.includes('--json')
const reportArg = (() => {
  const i = argv.indexOf('--report')
  return i !== -1 && argv[i + 1] ? argv[i + 1] : ''
})()
const tier2Arg = (() => {
  const i = argv.indexOf('--tier2')
  return i !== -1 && argv[i + 1] ? argv[i + 1].split(/[,，、]/).map((s) => s.trim()).filter(Boolean) : []
})()
const dbPath = process.env.ECHO_DB ?? join(homedir(), '.dsh', 'echo', 'echo.db')
if (!existsSync(dbPath)) {
  console.error('库不存在: ' + dbPath)
  process.exit(1)
}

// 走 openStore:顺带补齐 v0.16.0 的 evidence 列与节点墓碑列
// (裸开库碰不到这两列,活库在插件插桩之前就是那个状态)。
const store = openStore(dbPath)
const db = store.db
const owner = 'master'
const now = Date.now() / 1000

// 只拿现役节点:已经并过的别名是墓碑,再列一遍会让人以为还没做
const nodeRows = db.prepare(
  'SELECT node_id AS id, name FROM graph_nodes WHERE COALESCE(is_active, 1) = 1'
).all()
const aliasRows = db.prepare(
  'SELECT alias, canonical_name FROM graph_aliases ORDER BY created_at'
).all()
const plan = planMerges(nodeRows)

/** 依据串合并:数字去重、新在前,保留 (推定) 标记,上限 8 个 id。 */
function mergeEvidence (a, b) {
  const ids = []
  const push = (x) => { if (x && !ids.includes(x)) ids.push(x) }
  for (const chunk of String(b || '').split(/[、,，\s]+/)) if (/^\d+$/.test(chunk)) push(chunk)
  for (const chunk of String(a || '').split(/[、,，\s]+/)) if (/^\d+$/.test(chunk)) push(chunk)
  const tail = /推定/.test(String(a)) || /推定/.test(String(b)) ? '(推定)' : ''
  return ids.slice(0, 8).join('、') + tail
}

function mergeOne (m) {
  const canon = String(m.canonicalId)
  const loser = String(m.loserId)
  const out = { canonical: m.canonical, loser: m.loser, repointed: 0, merged: 0, selfLoops: 0 }
  db.prepare('UPDATE graph_nodes SET is_active = 1 WHERE node_id = ?').run(canon)
  const edges = db.prepare(
    'SELECT edge_id, source_id, target_id, relation, owner_key, weight, half_life,' +
    ' recall_count, intrinsic_value, activation, evidence, is_active FROM graph_edges' +
    ' WHERE source_id = ? OR target_id = ?'
  ).all(loser, loser)
  for (const e of edges) {
    const ns = String(e.source_id) === loser ? canon : String(e.source_id)
    const nt = String(e.target_id) === loser ? canon : String(e.target_id)
    const eid = Number(e.edge_id)
    if (ns === nt) {
      db.prepare('UPDATE graph_edges SET is_active = 0 WHERE edge_id = ?').run(eid)
      out.selfLoops += 1
      continue
    }
    const dup = db.prepare(
      'SELECT edge_id, weight, half_life, recall_count, intrinsic_value, activation, evidence' +
      ' FROM graph_edges WHERE source_id = ? AND target_id = ? AND relation = ?' +
      ' AND owner_key = ? AND edge_id <> ?'
    ).get(ns, nt, String(e.relation), String(e.owner_key ?? owner), eid)
    if (dup !== undefined) {
      const keepId = Number(dup.edge_id)
      db.prepare(
        'UPDATE graph_edges SET weight = ?, half_life = ?, recall_count = ?, intrinsic_value = ?,' +
        ' activation = ?, last_accessed = ?, evidence = ? WHERE edge_id = ?'
      ).run(
        Math.max(Number(dup.weight) || 1, Number(e.weight) || 1),
        Math.max(Number(dup.half_life) || 0, Number(e.half_life) || 0),
        (Number(dup.recall_count) || 0) + (Number(e.recall_count) || 0),
        Math.max(Number(dup.intrinsic_value) || 0, Number(e.intrinsic_value) || 0),
        Math.max(Number(dup.activation) || 0, Number(e.activation) || 0),
        now, mergeEvidence(dup.evidence, e.evidence), keepId
      )
      db.prepare('UPDATE graph_edges SET is_active = 0, superseded_by = ? WHERE edge_id = ?').run(keepId, eid)
      out.merged += 1
    } else {
      db.prepare('UPDATE graph_edges SET source_id = ?, target_id = ? WHERE edge_id = ?').run(ns, nt, eid)
      out.repointed += 1
    }
  }
  db.prepare('UPDATE graph_nodes SET is_active = 0, superseded_by = ? WHERE node_id = ?').run(canon, loser)
  db.prepare(
    'INSERT OR REPLACE INTO graph_aliases (alias, canonical_name, canonical_node_id, created_at, source)' +
    ' VALUES (?, ?, ?, ?, ?)'
  ).run(m.loser, m.canonical, canon, now, 'merge')
  return out
}

function backup (path) {
  const dir = join(homedir(), '.dsh', 'echo', 'backup')
  mkdirSync(dir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const file = join(dir, 'graph-' + stamp + '.json')
  writeFileSync(file, JSON.stringify({
    at: now, nodeRows, nodes: db.prepare('SELECT * FROM graph_nodes').all(), edges: db.prepare('SELECT * FROM graph_edges').all()
  }, null, 2), 'utf8')
  return file
}

const tier1 = plan.tier1
const tier2 = plan.tier2
const chosen2 = tier2.filter((m) => tier2Arg.includes(m.loser))
const todo = apply ? [...tier1, ...chosen2] : []

if (reportArg !== '') {
  const L = []
  L.push('# 图谱实体归一审阅单(M2)')
  L.push('')
  L.push('> 由 `scripts/graph-merge.mjs --report` 生成。Tier1 可自动并(高置信同实体);')
  L.push('> Tier2 **需要你点头** —— 它们可能真是两件事,合并会丢信息。')
  L.push('')
  L.push('## 已归一(别名表,已生效)')
  for (const a of aliasRows) L.push('- `' + a.alias + '` → `' + a.canonical_name + '`')
  if (aliasRows.length === 0) L.push('(无)')
  L.push('')
  L.push('## Tier1(自动)')
  for (const m of tier1) L.push('- `' + m.loser + '` → `' + m.canonical + '` —— ' + m.why)
  if (tier1.length === 0) L.push('(无)')
  L.push('')
  L.push('## Tier2(待你确认,用 `--tier2 名字1,名字2` 指定要并的)')
  for (const m of tier2) L.push('- [ ] `' + m.loser + '` → `' + m.canonical + '` —— ' + m.why)
  if (tier2.length === 0) L.push('(无)')
  L.push('')
  L.push('## 启发式候选(规则表未覆盖,需你定规则)')
  for (const h of plan.heuristic) L.push('- ' + h.names.map((x) => '`' + x + '`').join(' / ') + ' —— ' + h.note)
  if (plan.heuristic.length === 0) L.push('(无)')
  L.push('')
  writeFileSync(reportArg, L.join('\n'), 'utf8')
  console.log('审阅单已写: ' + reportArg)
}

if (asJson) {
  console.log(JSON.stringify({ tier1, tier2, heuristic: plan.heuristic }, null, 2))
  db.close()
  process.exit(0)
}

if (!apply) {
  console.log('Tier1(自动,可并):')
  for (const m of tier1) console.log('  ' + m.loser + ' → ' + m.canonical + '   (' + m.why + ')')
  console.log('Tier2(待确认):')
  for (const m of tier2) console.log('  [ ] ' + m.loser + ' → ' + m.canonical)
  console.log('\n[dry-run] 没写库。加 --apply 并 Tier1;Tier2 用 --tier2 点名。')
  db.close()
  process.exit(0)
}

if (todo.length === 0) {
  console.log('没有要并的(检查规则表或 --tier2 名字是否写对)')
  db.close()
  process.exit(0)
}

const file = backup(dbPath)
console.log('备份: ' + file)
const results = []
for (const m of todo) results.push(mergeOne(m))
// 顺手:无主节点归属补齐(实测 3 个历史节点 owner_key 为 NULL)
const orphan = db.prepare("UPDATE graph_nodes SET owner_key = ? WHERE owner_key IS NULL OR owner_key = ''").run(owner)
try {
  db.prepare(
    'INSERT INTO audit_logs (trace_id, session_id, user_key, is_master, user_input, tool_call, timestamp)' +
    ' VALUES (?, ?, ?, 1, ?, ?, ?)'
  ).run(randomUUID(), 'global', 'master',
    '图谱归一: ' + results.map((r) => r.loser + '→' + r.canonical).join('、')
    + ';改指 ' + results.reduce((a, r) => a + r.repointed, 0)
    + ' 条边,并入 ' + results.reduce((a, r) => a + r.merged, 0)
    + ' 条,丢自环 ' + results.reduce((a, r) => a + r.selfLoops, 0)
    + ' 条;补齐无主节点 ' + Number(orphan?.changes ?? 0) + ' 个',
    'graph_merge', now)
} catch { /* 审计写不进不该让合并失败 */ }
for (const r of results) {
  console.log('  合并 ' + r.loser + ' → ' + r.canonical + ':改指 ' + r.repointed
    + ',并入 ' + r.merged + ',自环 ' + r.selfLoops)
}
const left = db.prepare('SELECT COUNT(*) AS n FROM graph_nodes WHERE COALESCE(is_active,1)=1').get()
console.log('现役节点数: ' + Number(left?.n ?? 0))
db.close()
