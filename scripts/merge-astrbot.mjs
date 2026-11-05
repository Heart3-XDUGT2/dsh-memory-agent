#!/usr/bin/env node
/**
 * R1 · 增量合并:AstrBot 活库 → ~/.dsh/echo/echo.db(M1-e)
 * ============================================================
 * 用法:
 *   node scripts/merge-astrbot.mjs                        # dry-run:只出清单(默认)
 *   node scripts/merge-astrbot.mjs --write                # 落库(先备份 echo.db 三件套)
 *   node scripts/merge-astrbot.mjs --src <path>           # 指定源库(默认 A 的活库)
 *   node scripts/merge-astrbot.mjs --export-audit docs/   # A 的审计导出留档(不并库)
 *   node scripts/merge-astrbot.mjs --json                 # 机读
 *
 * 与 `import-astrbot.mjs` 的分工:那个是**一次性搬家**(目标非空即拒绝),
 * 这个只搬**后来多长出来的**(A 侧种完之后又聊出来的那点),而且要求
 * **幂等** —— 复跑必须报「新增 0」。规格:`docs/DB_MERGE_ANALYSIS.md` §5.1,
 * 计划:`docs/CORE_IN_DSH_PLAN.md` §3.1。
 *
 * 三条比原规格更严的地方(2026-09-25 补):
 *   ① **近重复也拦**:原规格只按 summary 全等去重。合并最容易干的事就是
 *      把「同一件事的两种说法」又灌回两条,所以第二道闸用
 *      `lib/memory-dedupe.js` 的近重复判据(同层 + 双阈值 + 「只在数字上
 *      不同不算重复」)。
 *   ② **图谱搬进来就接地**:A 侧也碎着同一批节点(西电/大一新生/新工科…)。
 *      搬之前先查 DSH 的 `graph_aliases`:别名命中就并到 canonical 节点,
 *      不新建。Tier2(可能真是两件事)一律不自动并,交给
 *      `scripts/graph-merge.mjs` 出审阅单让他点头。
 *   ③ **不记水位、可重跑**:图谱不是只增不减(`python/engine/graph.py:816-835`
 *      的 DMAE 维护段每小时删边清孤点),所以每次都以**当前库**为准重新算。
 *
 * 不搬(理由见 DB_MERGE_ANALYSIS §5 步骤 6):
 *   想念值(DSH 是活脑,拿 A 的旧值等于让她倒退回搬家那天的心情)、
 *   `agent_state`(两库表名相同但字段语义不同)、反思游标(局部量)、
 *   `A-state/state.db`(另一个老插件的形状,归档即可)、
 *   `data_v4.db`(宿主框架自己的对话历史,A 插件对它零引用)。
 *   A 的审计同理:**导出成文件留档**,不并库 —— 并进来会被
 *   `audit_keep=100` 当场裁掉,那叫搬完即删。
 */
import { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdirSync, writeFileSync, copyFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { openStore, MASTER_ID } from '../lib/store.js'
import { DEDUPE_DEFAULTS, isNearDuplicate, normText } from '../lib/memory-dedupe.js'
import { normThreadContent, matchOpenThread } from '../lib/thread-dedupe.js'
import { normalizeName } from '../lib/graph-aliases.js'

const argv = process.argv.slice(2)
const write = argv.includes('--write')
const asJson = argv.includes('--json')
const argOf = (flag) => {
  const i = argv.indexOf(flag)
  return i !== -1 && argv[i + 1] ? argv[i + 1] : ''
}
const DEFAULT_SRC = join(homedir(), '.astrbot', 'data', 'plugin_data', 'astrbot_plugin_memory_middleware', 'memory.db')
const srcPath = argOf('--src') || DEFAULT_SRC
const exportDir = argOf('--export-audit')
const dbPath = process.env.ECHO_DB ?? join(homedir(), '.dsh', 'echo', 'echo.db')

if (!existsSync(srcPath)) {
  console.error('源库不存在: ' + srcPath)
  process.exit(1)
}
if (!existsSync(dbPath)) {
  console.error('目标库不存在: ' + dbPath + '(先跑一次 dsh web,让插件建库)')
  process.exit(1)
}

const src = new DatabaseSync(srcPath, { readOnly: true })
// 走 openStore:顺带补齐 v0.16.0 的 evidence / 墓碑列(裸开库碰不到)
const store = openStore(dbPath)
const db = store.db
const now = Date.now() / 1000

/** 表在不在(源库可能是老版本)。 */
function hasTable (handle, name) {
  try {
    return handle.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined
  } catch { return false }
}

/** 表的列集合(源库列可能与 DSH 不同构)。 */
function columnsOf (handle, name) {
  try {
    return new Set(handle.prepare("SELECT name FROM pragma_table_info('" + name + "')").all().map((r) => String(r.name)))
  } catch { return new Set() }
}

/** 取值:列不存在就给默认值(源库老版本照样能搬)。 */
function pick (row, cols, name, fallback) {
  return cols.has(name) ? row[name] : fallback
}

const srcMemCols = columnsOf(src, 'episodic_memory')
const srcNodeCols = columnsOf(src, 'graph_nodes')
const srcEdgeCols = columnsOf(src, 'graph_edges')
const srcThreadCols = columnsOf(src, 'pending_threads')
const srcAgendaCols = columnsOf(src, 'her_agenda')

// ============================================================
// 一、读目标现状(全部只读;合并计划完全由它算出来)
// ============================================================
const tgtMem = db.prepare(
  'SELECT memory_id, summary, keywords, layer, status, is_active FROM episodic_memory'
).all()
const tgtMemByNorm = new Map()
const tgtMemByLayer = new Map()
for (const m of tgtMem) {
  const key = normText(m.summary)
  if (key !== '' && !tgtMemByNorm.has(key)) tgtMemByNorm.set(key, Number(m.memory_id))
  const layer = String(m.layer ?? '').trim().toUpperCase()
  if (!tgtMemByLayer.has(layer)) tgtMemByLayer.set(layer, [])
  tgtMemByLayer.get(layer).push(m)
}

const tgtNodes = db.prepare(
  'SELECT node_id, name, COALESCE(is_active, 1) AS is_active FROM graph_nodes'
).all()
const tgtNodeById = new Map(tgtNodes.map((n) => [String(n.node_id), n]))
const tgtNodeByName = new Map()
for (const n of tgtNodes) {
  if (Number(n.is_active) !== 1) continue
  const key = String(n.name ?? '').trim()
  if (key !== '' && !tgtNodeByName.has(key)) tgtNodeByName.set(key, String(n.node_id))
}
const tgtAlias = new Map()
try {
  for (const a of db.prepare('SELECT alias, canonical_name FROM graph_aliases').all()) {
    tgtAlias.set(normalizeName(a.alias), String(a.canonical_name ?? '').trim())
  }
} catch { /* 老库可能还没有别名表 */ }
const tgtEdgeKeys = new Set()
for (const e of db.prepare('SELECT source_id, target_id, relation, owner_key FROM graph_edges').all()) {
  tgtEdgeKeys.add(edgeKey(e.source_id, e.target_id, e.relation, e.owner_key))
}
const tgtThreads = db.prepare(
  "SELECT thread_id, content FROM pending_threads WHERE user_id = ? AND status = 'open'" +
  ' ORDER BY updated_at DESC LIMIT 30'
).all(MASTER_ID)
const tgtAgenda = new Set()
try {
  for (const a of db.prepare('SELECT content FROM her_agenda WHERE is_active = 1').all()) {
    tgtAgenda.add(agendaKey(a.content))
  }
} catch { /* 源/目标老库可能缺表 */ }

function edgeKey (s, t, rel, owner) {
  return [String(s), String(t), String(rel ?? '相关'), String(owner ?? '').trim() || MASTER_ID].join('\u0001')
}
function agendaKey (text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim().toLowerCase()
}

// ============================================================
// 二、算合并计划(不写库)
// ============================================================
const plan = {
  episodic: { source: 0, skippedNotMaster: 0, empty: 0, existing: 0, nearDup: 0, inactive: 0, insert: [] },
  nodes: { source: 0, existing: 0, grounded: 0, tombstone: 0, insert: [] },
  edges: { source: 0, existing: 0, selfLoop: 0, missingEndpoint: 0, insert: [] },
  threads: { source: 0, existing: 0, empty: 0, insert: [] },
  agenda: { source: 0, existing: 0, empty: 0, insert: [] }
}
const groundedNote = []

// ---- 2.1 情景记忆:全等 → 近重复 → 插入 ----
if (hasTable(src, 'episodic_memory')) {
  const rows = src.prepare('SELECT * FROM episodic_memory').all()
  // 本批已接受的候选也进池:合并内部自己也会撞车
  const accepted = []
  for (const r of rows) {
    if (Number(pick(r, srcMemCols, 'is_master', 1)) !== 1) { plan.episodic.skippedNotMaster += 1; continue }
    const summary = String(pick(r, srcMemCols, 'summary', '') ?? '')
    const key = normText(summary)
    if (key === '') { plan.episodic.empty += 1; continue }
    plan.episodic.source += 1
    if (tgtMemByNorm.has(key)) { plan.episodic.existing += 1; continue }
    const candidate = {
      summary,
      keywords: String(pick(r, srcMemCols, 'keywords', '[]') ?? '[]'),
      layer: String(pick(r, srcMemCols, 'layer', '') ?? ''),
      status: String(pick(r, srcMemCols, 'status', 'active') ?? 'active')
    }
    const layer = candidate.layer.trim().toUpperCase()
    const pool = [...(tgtMemByLayer.get(layer) ?? []), ...accepted]
    const hit = pool.find((m) => isNearDuplicate(m, candidate, DEDUPE_DEFAULTS))
    if (hit !== undefined) { plan.episodic.nearDup += 1; continue }
    if (Number(pick(r, srcMemCols, 'is_active', 1)) !== 1) plan.episodic.inactive += 1
    accepted.push(candidate)
    plan.episodic.insert.push(r)
  }
}

// ---- 2.2 图谱节点:先查别名接地,再考虑新建 ----
const nodeMap = new Map() // A 的 node_id → DSH 的 node_id
if (hasTable(src, 'graph_nodes')) {
  for (const r of src.prepare('SELECT * FROM graph_nodes').all()) {
    plan.nodes.source += 1
    const id = String(r.node_id)
    const name = String(pick(r, srcNodeCols, 'name', '') ?? '').trim()
    const existing = tgtNodeById.get(id)
    if (existing !== undefined && Number(existing.is_active) === 1) {
      nodeMap.set(id, id)
      plan.nodes.existing += 1
      continue
    }
    // 别名接地:DSH 已经归一过这个名字(或名字本身就是 canonical)
    const canonical = tgtAlias.get(normalizeName(name)) ?? name
    const target = tgtNodeByName.get(canonical) ?? tgtNodeByName.get(name)
    if (target !== undefined) {
      nodeMap.set(id, target)
      plan.nodes.grounded += 1
      if (name !== canonical) groundedNote.push(name + ' → ' + canonical)
      continue
    }
    if (existing !== undefined) {
      // 在 DSH 是墓碑(canonical 不明):边仍旧指过去,但报出来
      nodeMap.set(id, id)
      plan.nodes.tombstone += 1
      continue
    }
    nodeMap.set(id, id)
    plan.nodes.insert.push(r)
  }
}

// ---- 2.3 图谱边:端点跟着接地走 ----
if (hasTable(src, 'graph_edges')) {
  const knownIds = new Set([...tgtNodeById.keys(), ...plan.nodes.insert.map((r) => String(r.node_id))])
  for (const r of src.prepare('SELECT * FROM graph_edges').all()) {
    plan.edges.source += 1
    const s = nodeMap.get(String(r.source_id)) ?? String(r.source_id)
    const t = nodeMap.get(String(r.target_id)) ?? String(r.target_id)
    if (s === t) { plan.edges.selfLoop += 1; continue }
    const key = edgeKey(s, t, pick(r, srcEdgeCols, 'relation', '相关'), MASTER_ID)
    if (tgtEdgeKeys.has(key)) { plan.edges.existing += 1; continue }
    if (!knownIds.has(s) || !knownIds.has(t)) { plan.edges.missingEndpoint += 1; continue }
    plan.edges.insert.push({ row: r, s, t })
    tgtEdgeKeys.add(key)
  }
}

// ---- 2.4 悬置话题:走与引擎同一套规整与去重 ----
if (hasTable(src, 'pending_threads')) {
  const open = tgtThreads.map((t) => ({ threadId: Number(t.thread_id), content: String(t.content ?? '') }))
  for (const r of src.prepare("SELECT * FROM pending_threads WHERE status = 'open'").all()) {
    plan.threads.source += 1
    const raw = String(pick(r, srcThreadCols, 'content', '') ?? '')
    const content = normThreadContent(raw)
    if (content === '') { plan.threads.empty += 1; continue }
    const hit = matchOpenThread(open, content)
    if (hit > 0) { plan.threads.existing += 1; continue }
    plan.threads.insert.push(content)
    open.push({ threadId: -1, content }) // 本批已登记的也算(它自己内部不许重)
  }
}

// ---- 2.5 议程:按 content 去重 ----
if (hasTable(src, 'her_agenda')) {
  const rows = src.prepare('SELECT * FROM her_agenda WHERE is_active = 1').all()
  for (const r of rows) {
    plan.agenda.source += 1
    const content = String(pick(r, srcAgendaCols, 'content', '') ?? '').trim()
    if (content === '') { plan.agenda.empty += 1; continue }
    const key = agendaKey(content)
    if (tgtAgenda.has(key)) { plan.agenda.existing += 1; continue }
    plan.agenda.insert.push(r)
    tgtAgenda.add(key)
  }
}

// 「只在 A 的条目」= 合并完成后仍未被 DSH 代表的条数(验收口径)
const onlyInA = plan.episodic.insert.length + plan.nodes.insert.length
  + plan.edges.insert.length + plan.threads.insert.length + plan.agenda.insert.length

// ============================================================
// 三、审计导出(A 的 200 行是她「当年看到什么」的证据链)
// ============================================================
let auditExport = ''
if (exportDir !== '') {
  const rows = hasTable(src, 'audit_logs') ? src.prepare('SELECT * FROM audit_logs ORDER BY timestamp ASC').all() : []
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  mkdirSync(exportDir, { recursive: true })
  const jsonFile = join(exportDir, 'astrbot-audit-' + stamp + '.json')
  const mdFile = join(exportDir, 'astrbot-audit-' + stamp + '.md')
  writeFileSync(jsonFile, JSON.stringify(rows, null, 2), 'utf8')
  const L = []
  L.push('# A 侧审计留档(AstrBot 时期她看到的与说过的)')
  L.push('')
  L.push('> 由 `scripts/merge-astrbot.mjs --export-audit` 导出,**不并库** ——')
  L.push('> DSH 的 `audit_keep=100` 会立刻裁掉老行,并库等于搬完即删。')
  L.push('> 行数:' + rows.length + ' | 源库:' + srcPath)
  L.push('')
  L.push('| 时间 | 他说 | 她回 | 标签 |')
  L.push('|---|---|---|---|')
  for (const r of rows) {
    const ts = Number(r.timestamp) || 0
    const when = ts > 0 ? new Date(ts * 1000).toISOString().replace('T', ' ').slice(0, 19) : ''
    const cell = (v, n) => String(v ?? '').replace(/\|/g, '\\|').replace(/\s+/g, ' ').slice(0, n)
    L.push('| ' + when + ' | ' + cell(r.user_input, 120) + ' | ' + cell(r.llm_reply, 160)
      + ' | ' + cell(r.tool_call, 40) + ' |')
  }
  L.push('')
  writeFileSync(mdFile, L.join('\n'), 'utf8')
  auditExport = mdFile
  if (!asJson) console.log('审计留档: ' + rows.length + ' 行 →\n  ' + jsonFile + '\n  ' + mdFile)
}

// ============================================================
// 四、输出计划 / 落库
// ============================================================
const report = {
  at: now,
  src: srcPath,
  db: dbPath,
  write,
  plan: {
    episodic: { ...plan.episodic, insert: plan.episodic.insert.length },
    nodes: { ...plan.nodes, insert: plan.nodes.insert.length },
    edges: { ...plan.edges, insert: plan.edges.insert.length },
    threads: { ...plan.threads, insert: plan.threads.insert.length },
    agenda: { ...plan.agenda, insert: plan.agenda.insert.length }
  },
  onlyInA,
  grounded: groundedNote,
  auditExport
}

if (asJson) {
  console.log(JSON.stringify(report, null, 2))
  finish()
}

console.log('源库(只读): ' + srcPath)
console.log('目标库: ' + dbPath)
console.log('')
console.log('情景记忆: 源 ' + plan.episodic.source + ' 条(非主人 ' + plan.episodic.skippedNotMaster
  + ' / 空摘要 ' + plan.episodic.empty + ') → 已在库 ' + plan.episodic.existing
  + ',近重复 ' + plan.episodic.nearDup + ',本次插入 ' + plan.episodic.insert.length
  + '(其中已让位 ' + plan.episodic.inactive + ')')
console.log('图谱节点: 源 ' + plan.nodes.source + ' 个 → 已在库 ' + plan.nodes.existing
  + ',别名接地 ' + plan.nodes.grounded + ',停在墓碑 ' + plan.nodes.tombstone
  + ',本次插入 ' + plan.nodes.insert.length)
console.log('图谱边:   源 ' + plan.edges.source + ' 条 → 已在库 ' + plan.edges.existing
  + ',自环 ' + plan.edges.selfLoop + ',端点不在库 ' + plan.edges.missingEndpoint
  + ',本次插入 ' + plan.edges.insert.length)
console.log('悬置话题: 源 ' + plan.threads.source + ' 条 → 命中既有 ' + plan.threads.existing
  + ',空内容 ' + plan.threads.empty + ',本次登记 ' + plan.threads.insert.length)
console.log('议程:     源 ' + plan.agenda.source + ' 条 → 已在库 ' + plan.agenda.existing
  + ',空内容 ' + plan.agenda.empty + ',本次插入 ' + plan.agenda.insert.length)
if (groundedNote.length > 0) {
  console.log('接地明细: ' + groundedNote.slice(0, 12).join('、') + (groundedNote.length > 12 ? ' …' : ''))
}
console.log('')
console.log('不搬: 想念值 / agent_state / 反思游标 / state.db / data_v4.db(理由见文件头)')

if (!write) {
  console.log('')
  console.log('[dry-run] 没写库。要落库加 --write(会先把 echo.db 三件套备份到 ~/.dsh/echo/backup/)。')
  const preview = plan.episodic.insert.slice(0, 8)
  if (preview.length > 0) {
    console.log('')
    console.log('将插入的记忆(前 ' + preview.length + ' 条):')
    for (const r of preview) {
      console.log('  · [' + String(pick(r, srcMemCols, 'layer', '') ?? '') + '] '
        + String(pick(r, srcMemCols, 'summary', '') ?? '').slice(0, 70))
    }
  }
  finish()
}

// ---- 4.1 备份三件套(WAL 也要,只备份主库会丢最近一次提交) ----
const backupDir = join(homedir(), '.dsh', 'echo', 'backup', 'merge-' + new Date().toISOString().replace(/[:.]/g, '-'))
mkdirSync(backupDir, { recursive: true })
for (const suffix of ['', '-wal', '-shm']) {
  const from = dbPath + suffix
  if (existsSync(from)) copyFileSync(from, join(backupDir, 'echo.db' + suffix))
}
console.log('')
console.log('备份: ' + backupDir)

// ---- 4.2 落库(一块事务;失败整体回滚,不会留半截) ----
let inserted = { episodic: 0, nodes: 0, edges: 0, threads: 0, agenda: 0 }
try {
  db.exec('BEGIN IMMEDIATE')
  const insMem = db.prepare(
    'INSERT INTO episodic_memory (user_id, keywords, summary, emotion_score, timestamp, is_active,' +
    ' source, source_label, actor, speaker_id, is_master, intrinsic_value, half_life, recall_count,' +
    ' last_recalled, occurred_at, learned_at, temporal_status, memory_key, superseded_by, layer, evidence, status,' +
    // 2026-10-12:类型两列。**合并进来的老数据没有类型信息** ⇒ 一律落空串,与老行同形。
    ' memory_type, memory_stability)' +
    " VALUES (?, ?, ?, ?, ?, ?, 'qq', ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', '')"
  )
  // 2026-09-27 F1:同 import-astrbot.mjs —— `superseded_by` 必须重映射。
  // 本脚本只插 `plan.episodic.insert` 这个子集,目标行很可能不在批次里;
  // 那种情况**只能留 0**(写一条解析不到的引用 = 留档链撒谎)。
  const memIdMap = new Map()
  const memRefPending = []
  for (const r of plan.episodic.insert) {
    const info = insMem.run(
      MASTER_ID,
      String(pick(r, srcMemCols, 'keywords', '[]') ?? '[]'),
      String(pick(r, srcMemCols, 'summary', '') ?? ''),
      Math.round(Number(pick(r, srcMemCols, 'emotion_score', 0)) || 0),
      Number(pick(r, srcMemCols, 'timestamp', 0)) || 0,
      Number.isFinite(Number(pick(r, srcMemCols, 'is_active', 1))) ? Number(pick(r, srcMemCols, 'is_active', 1)) : 1,
      String(pick(r, srcMemCols, 'source_label', '') ?? ''),
      String(pick(r, srcMemCols, 'actor', '') ?? ''),
      String(pick(r, srcMemCols, 'speaker_id', '') ?? ''),
      Number(pick(r, srcMemCols, 'intrinsic_value', 0)) || 0,
      Number(pick(r, srcMemCols, 'half_life', 0)) || 0,
      Math.round(Number(pick(r, srcMemCols, 'recall_count', 0)) || 0),
      Number(pick(r, srcMemCols, 'last_recalled', 0)) || 0,
      Number(pick(r, srcMemCols, 'occurred_at', 0)) || 0,
      Number(pick(r, srcMemCols, 'learned_at', 0)) || 0,
      String(pick(r, srcMemCols, 'temporal_status', 'time_unknown') ?? 'time_unknown'),
      String(pick(r, srcMemCols, 'memory_key', '') ?? ''),
      0, // ← 引用先留 0,下面按映射回填
      String(pick(r, srcMemCols, 'layer', '') ?? ''),
      String(pick(r, srcMemCols, 'evidence', '') ?? ''),
      String(pick(r, srcMemCols, 'status', 'active') ?? 'active')
    )
    const oldId = Number(pick(r, srcMemCols, 'memory_id', 0))
    if (Number.isFinite(oldId)) memIdMap.set(oldId, Number(info.lastInsertRowid))
    const oldRef = Math.round(Number(pick(r, srcMemCols, 'superseded_by', 0)) || 0)
    if (oldRef > 0) memRefPending.push([Number(info.lastInsertRowid), oldRef])
    inserted.episodic += 1
  }
  {
    const remap = db.prepare('UPDATE episodic_memory SET superseded_by = ? WHERE memory_id = ?')
    let remapped = 0
    let dropped = 0
    for (const [newId, oldRef] of memRefPending) {
      const target = memIdMap.get(oldRef)
      if (target === undefined) { dropped += 1; continue }
      remap.run(target, newId)
      remapped += 1
    }
    if (remapped || dropped) {
      console.log('  superseded_by 重映射: ' + remapped + ' 条,丢弃(目标不在批次)' + dropped + ' 条')
    }
  }

  const insNode = db.prepare(
    'INSERT INTO graph_nodes (node_id, name, node_type, is_protected, properties,' +
    ' last_accessed, activation, user_silence, model_silence, intrinsic_value, half_life,' +
    ' recall_count, occurred_at, learned_at, temporal_status, owner_key, is_active, superseded_by)' +
    " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, '')"
  )
  for (const r of plan.nodes.insert) {
    insNode.run(
      String(r.node_id), String(pick(r, srcNodeCols, 'name', '') ?? ''),
      String(pick(r, srcNodeCols, 'node_type', 'concept') ?? 'concept'),
      Math.round(Number(pick(r, srcNodeCols, 'is_protected', 0)) || 0),
      String(pick(r, srcNodeCols, 'properties', '{}') ?? '{}'),
      Number(pick(r, srcNodeCols, 'last_accessed', 0)) || 0,
      Number(pick(r, srcNodeCols, 'activation', 0)) || 0,
      Math.round(Number(pick(r, srcNodeCols, 'user_silence', 0)) || 0),
      Math.round(Number(pick(r, srcNodeCols, 'model_silence', 0)) || 0),
      Number(pick(r, srcNodeCols, 'intrinsic_value', 10)) || 10,
      Number(pick(r, srcNodeCols, 'half_life', 0)) || 0,
      Math.round(Number(pick(r, srcNodeCols, 'recall_count', 0)) || 0),
      Number(pick(r, srcNodeCols, 'occurred_at', 0)) || 0,
      Number(pick(r, srcNodeCols, 'learned_at', 0)) || 0,
      String(pick(r, srcNodeCols, 'temporal_status', 'time_unknown') ?? 'time_unknown'),
      MASTER_ID
    )
    inserted.nodes += 1
  }

  const insEdge = db.prepare(
    'INSERT INTO graph_edges (source_id, target_id, relation, weight, last_accessed,' +
    ' owner_key, half_life, recall_count, occurred_at, learned_at, temporal_status)' +
    ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  )
  for (const e of plan.edges.insert) {
    insEdge.run(
      e.s, e.t, String(pick(e.row, srcEdgeCols, 'relation', '相关') ?? '相关'),
      Number(pick(e.row, srcEdgeCols, 'weight', 1)) || 1,
      Number(pick(e.row, srcEdgeCols, 'last_accessed', 0)) || 0,
      MASTER_ID,
      Number(pick(e.row, srcEdgeCols, 'half_life', 0)) || 0,
      Math.round(Number(pick(e.row, srcEdgeCols, 'recall_count', 0)) || 0),
      Number(pick(e.row, srcEdgeCols, 'occurred_at', 0)) || 0,
      Number(pick(e.row, srcEdgeCols, 'learned_at', 0)) || 0,
      String(pick(e.row, srcEdgeCols, 'temporal_status', 'time_unknown') ?? 'time_unknown')
    )
    inserted.edges += 1
  }

  const insThread = db.prepare(
    "INSERT INTO pending_threads (user_id, content, status, follow_up_after, source_memory_id," +
    ' session_id, last_mentioned_at, created_at, updated_at)' +
    " VALUES (?, ?, 'open', 0, 0, '', 0, ?, ?)"
  )
  const srcThreadCreated = new Map()
  for (const r of src.prepare("SELECT thread_id, content, created_at FROM pending_threads WHERE status = 'open'").all()) {
    srcThreadCreated.set(normThreadContent(pick(r, srcThreadCols, 'content', '')), Number(pick(r, srcThreadCols, 'created_at', 0)) || 0)
  }
  for (const content of plan.threads.insert) {
    // follow_up_after 一律清零:A 的到期值都是 0(历史提醒早该过期,
    // 不该在 DSH 里补发);created_at 保留她当年登记的时间
    const createdAt = srcThreadCreated.get(content) || now
    insThread.run(MASTER_ID, content, createdAt, now)
    inserted.threads += 1
  }

  const insAgenda = db.prepare(
    'INSERT INTO her_agenda (content, origin, source_ids, weight, created_at, last_used_at, is_active)' +
    " VALUES (?, ?, ?, ?, ?, 0, 1)"
  )
  for (const r of plan.agenda.insert) {
    insAgenda.run(
      String(pick(r, srcAgendaCols, 'content', '') ?? '').trim(),
      String(pick(r, srcAgendaCols, 'origin', 'persona') ?? 'persona'),
      String(pick(r, srcAgendaCols, 'source_ids', '') ?? ''),
      Number(pick(r, srcAgendaCols, 'weight', 1)) || 1,
      Number(pick(r, srcAgendaCols, 'created_at', 0)) || now
    )
    inserted.agenda += 1
  }

  // 老库回填(与 import-astrbot.mjs 同一口径,只碰 source='qq'):
  // learned_at 空 → 用 timestamp 补;layer 空且 I ≥ 50 → 判 L0。
  // 不回填 occurred_at —— 事情何时发生旧数据真的不知道。
  const learned = db.prepare(
    "UPDATE episodic_memory SET learned_at = timestamp" +
    " WHERE source = 'qq' AND (learned_at IS NULL OR learned_at = 0) AND timestamp > 0"
  ).run()
  const layered = db.prepare(
    "UPDATE episodic_memory SET layer = 'L0'" +
    " WHERE source = 'qq' AND (layer IS NULL OR layer = '') AND intrinsic_value >= 50"
  ).run()
  db.prepare(
    'INSERT INTO audit_logs (trace_id, session_id, user_key, is_master, user_input, tool_call, timestamp)' +
    ' VALUES (?, ?, ?, 1, ?, ?, ?)'
  ).run(randomUUID(), 'global', MASTER_ID,
    'A 侧增量合并:记忆 ' + inserted.episodic + ' 条、节点 ' + inserted.nodes
    + '、边 ' + inserted.edges + '、话题 ' + inserted.threads + '、议程 ' + inserted.agenda
    + '(接地 ' + plan.nodes.grounded + ',近重复拦下 ' + plan.episodic.nearDup + ')',
    'astrbot_merge', now)
  db.exec('COMMIT')
  console.log('老库回填: learned_at ' + Number(learned?.changes ?? 0) + ' 行,layer→L0 '
    + Number(layered?.changes ?? 0) + ' 行')
} catch (err) {
  try { db.exec('ROLLBACK') } catch { /* 事务可能本就没开成 */ }
  console.error('落库失败,已回滚: ' + String(err?.message ?? err))
  finish(1)
}

console.log('')
console.log('合并完成: 记忆 +' + inserted.episodic + ',节点 +' + inserted.nodes
  + ',边 +' + inserted.edges + ',话题 +' + inserted.threads + ',议程 +' + inserted.agenda)
console.log('验收:再跑一次 dry-run,上面五个「本次插入/登记」应全为 0;')
console.log('      再跑 node scripts/memory-doctor.mjs 看规模与图谱健康。')
console.log('提示:新搬进来的节点若还有碎名字,跑 node scripts/graph-merge.mjs 出审阅单(Tier1 会自动并)。')
finish(0)

function finish (code = 0) {
  try { store.close() } catch { try { db.close() } catch { /* 已关 */ } }
  try { src.close() } catch { /* 已关 */ }
  process.exit(code)
}
