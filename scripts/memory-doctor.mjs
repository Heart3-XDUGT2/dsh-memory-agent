#!/usr/bin/env node
/**
 * 记忆体检(doctor,M0)
 * ============================================================
 * 用法:
 *   node scripts/memory-doctor.mjs            # 人读报告(默认)
 *   node scripts/memory-doctor.mjs --json     # 机器读(面板/答辩截图/前后对照)
 *   node scripts/memory-doctor.mjs --db <path>  # 指定库(默认 ~/.dsh/echo/echo.db)
 *   node scripts/memory-doctor.mjs --self-ref   # 列出工程自指/注入残留的行(只读)
 *   node scripts/memory-doctor.mjs --clean      # 干跑:打印将要归档的行
 *   node scripts/memory-doctor.mjs --clean --yes # 真归档(is_active=0 + 批次审计留痕)
 *   node scripts/memory-doctor.mjs --rollback <批次id>   # 一键撤销那一批归档
 *
 * 原则:
 *   - **只读**(readOnly 打开,绝不建表/迁移)—— 修理前后各跑一次做对照,
 *     也能在 M1 迁移之前就跑出基线。`--clean --yes` 与 `--rollback` 是仅有的
 *     两条写路径,且**只归档不硬删**:is_active=0 + 审计留痕,行还在库里翻得出来。
 *   - **归档侧有自己的守卫**(2026-09-27 F7):`lib/cleanup-guard.js`。
 *     写入侧的 `rejectReason` 是"宁可漏拒",追溯施加到归档侧代价完全不同 ——
 *     错拒 = 把他已经记住的东西删掉。实测它把**他当前正在做的项目整簇**
 *     (含 #248「去找开源图谱实现作参照」那条请求)当脏记忆归档了。
 *     现在:L0 / I≥50 / 情感≥6 / 近 7 天 一律豁免。
 *   - 缺列/缺表一律降级成一行说明,不炸:它是体检,不是断言
 *   - 七项症状(对应 docs/MEMORY_ARCHITECTURE.md 的五条原因):
 *     ① 活跃记忆里的「换说法重复组」  ② 图谱同义节点(alias 计划)
 *     ③ 无依据边(evidence 覆盖)      ④ 画像空值/脏值
 *     ⑤ 节点激活度物化 vs 现算        ⑥ 悬置话题/议程/孤点归属
 *     ⑦ **工程自指污染**(2026-09-26 现场,他的裁决:一律拒收)
 */
import { DatabaseSync } from 'node:sqlite'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { planMerges } from '../lib/graph-aliases.js'
import { findDuplicateGroups } from '../lib/memory-dedupe.js'
import { retrievability, initialHalfLife } from '../lib/dmae.js'
import { rejectReason, isHumanUtterance } from '../lib/inbound-filter.js'
import {
  planCleanup, archiveBatch, rollbackBatch, newBatchId, PROTECT_IV,
  PROTECT_EMOTION, PROTECT_DAYS
} from '../lib/cleanup-guard.js'

const argv = process.argv.slice(2)
const asJson = argv.includes('--json')
const selfRefList = argv.includes('--self-ref')
const doClean = argv.includes('--clean')
const confirmed = argv.includes('--yes')
const rollbackArg = (() => {
  const i = argv.indexOf('--rollback')
  return i !== -1 && argv[i + 1] ? argv[i + 1] : ''
})()
const dbArg = (() => {
  const i = argv.indexOf('--db')
  return i !== -1 && argv[i + 1] ? argv[i + 1] : ''
})()
const dbPath = dbArg !== '' ? dbArg : (process.env.ECHO_DB ?? join(homedir(), '.dsh', 'echo', 'echo.db'))

if (!existsSync(dbPath)) {
  console.error('库不存在: ' + dbPath)
  process.exit(1)
}

// ── 回滚(独立入口:不需要 --clean,也不走报告) ────────────────────────
if (rollbackArg !== '') {
  const wdb = new DatabaseSync(dbPath)
  try {
    const r = rollbackBatch(wdb, rollbackArg, Date.now() / 1000)
    if (r.notFound) {
      console.error('批次 ' + rollbackArg + ' 找不到 —— 审计索引可能已被裁掉'
        + '(store.writeAudit 只留最近 100 条),或者批次 id 写错了。')
      process.exitCode = 2
    } else {
      console.log('批次 ' + rollbackArg + ' 已回滚:恢复 ' + r.restored + ' 条记忆'
        + '(#' + r.ids.join(' #') + ')')
    }
  } finally {
    wdb.close()
  }
  process.exit(process.exitCode ?? 0)
}
// 唯一的写路径:--clean --yes。其余一律只读。
const writable = doClean && confirmed
const db = new DatabaseSync(dbPath, { readOnly: !writable })
const q = (sql, ...args) => {
  try { return db.prepare(sql).all(...args) } catch { return [] }
}
const n = (sql, ...args) => {
  try { return Number(db.prepare(sql).get(...args)?.n) || 0 } catch { return 0 }
}
const hasTable = (t) => n("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name=?", t) > 0
const hasColumn = (t, c) => {
  try { return db.prepare(`PRAGMA table_info(${t})`).all().some((r) => r.name === c) } catch { return false }
}

const out = { dbPath, at: Date.now() / 1000 }

// ── 规模 ──────────────────────────────────────────────────────────
out.scale = {
  episodicTotal: n('SELECT COUNT(*) AS n FROM episodic_memory'),
  episodicActive: n("SELECT COUNT(*) AS n FROM episodic_memory WHERE is_active=1 AND status='active'"),
  episodicQuarantined: n("SELECT COUNT(*) AS n FROM episodic_memory WHERE is_active=1 AND status='quarantined'"),
  byLayer: Object.fromEntries(q('SELECT layer, COUNT(*) AS n FROM episodic_memory GROUP BY layer').map((r) => [r.layer || '(空)', r.n])),
  bySource: Object.fromEntries(q('SELECT source, COUNT(*) AS n FROM episodic_memory GROUP BY source').map((r) => [r.source || '(空)', r.n])),
  graphNodes: n('SELECT COUNT(*) AS n FROM graph_nodes'),
  graphEdges: n('SELECT COUNT(*) AS n FROM graph_edges'),
  graphEdgesActive: hasColumn('graph_edges', 'is_active')
    ? n('SELECT COUNT(*) AS n FROM graph_edges WHERE is_active=1')
    : null,
  pendingThreads: n('SELECT COUNT(*) AS n FROM pending_threads'),
  agenda: n('SELECT COUNT(*) AS n FROM her_agenda'),
  diary: n('SELECT COUNT(*) AS n FROM diary'),
  audit: n('SELECT COUNT(*) AS n FROM audit_logs'),
  hasEvidenceColumn: hasColumn('graph_edges', 'evidence'),
  hasAliasTable: hasTable('graph_aliases')
}

// ── ① 活跃记忆里的「换说法重复组」 ─────────────────────────────────
const memRows = q(
  'SELECT memory_id AS memoryId, summary, keywords, layer, status, intrinsic_value AS intrinsicValue,' +
  ' learned_at AS learnedAt, source, recall_count AS recallCount FROM episodic_memory' +
  " WHERE is_active = 1 AND status IN ('active','quarantined')"
)
const dupGroups = findDuplicateGroups(memRows)
out.duplicateGroups = dupGroups.map((g) => ({
  survivor: { id: g.survivor.memoryId, layer: g.survivor.layer, summary: g.survivor.summary, I: g.survivor.intrinsicValue },
  losers: g.losers.map((l) => ({ id: l.memoryId, layer: l.layer, summary: l.summary, I: l.intrinsicValue })),
  layer: g.survivor.layer || '(空)'
}))
out.duplicateGroupCount = out.duplicateGroups.length
out.duplicateRowCount = out.duplicateGroups.reduce((a, g) => a + g.losers.length, 0)
out.l0Active = n("SELECT COUNT(*) AS n FROM episodic_memory WHERE is_active=1 AND status='active' AND layer='L0'")

// ── ② 图谱同义节点(alias 计划) ───────────────────────────────────
// 只拿现役节点:并过的别名是墓碑,再列一遍会让人以为还没做(与
// graph-merge.mjs 同一口径 —— 两个脚本必须看到同一份计划)。
const nodeRows = hasColumn('graph_nodes', 'is_active')
  ? q('SELECT node_id AS id, name FROM graph_nodes WHERE COALESCE(is_active,1)=1')
  : q('SELECT node_id AS id, name FROM graph_nodes')
const plan = planMerges(nodeRows)
out.aliasPlan = {
  tier1: plan.tier1,
  tier2: plan.tier2,
  heuristic: plan.heuristic,
  tier1Count: plan.tier1.length,
  tier2Count: plan.tier2.length
}
out.orphanOwnerNodes = q("SELECT name FROM graph_nodes WHERE owner_key IS NULL OR owner_key=''").map((r) => r.name)
// v0.16.0 M2 归一后的健康检查:墓碑节点数 / 悬空边(指向根本不存在的
// 节点)/ 指向墓碑的边。悬空边会让力导向图画出不存在的位置 —— 合并
// 脚本最容易踩的坑,体检必须能一眼看见。
out.graphHealth = {
  activeNodes: hasColumn('graph_nodes', 'is_active')
    ? n('SELECT COUNT(*) AS n FROM graph_nodes WHERE COALESCE(is_active,1)=1')
    : null,
  tombstoneNodes: hasColumn('graph_nodes', 'is_active')
    ? n('SELECT COUNT(*) AS n FROM graph_nodes WHERE COALESCE(is_active,1)=0')
    : 0,
  danglingEdges: n(
    'SELECT COUNT(*) AS n FROM graph_edges e WHERE' +
    ' e.source_id NOT IN (SELECT node_id FROM graph_nodes)' +
    ' OR e.target_id NOT IN (SELECT node_id FROM graph_nodes)'
  ),
  edgesTouchingTombstone: hasColumn('graph_nodes', 'is_active')
    ? n(
      'SELECT COUNT(*) AS n FROM graph_edges e WHERE e.is_active = 1 AND (' +
      ' e.source_id IN (SELECT node_id FROM graph_nodes WHERE COALESCE(is_active,1)=0)' +
      ' OR e.target_id IN (SELECT node_id FROM graph_nodes WHERE COALESCE(is_active,1)=0))'
    )
    : 0
}

// ── ③ 无依据边 ────────────────────────────────────────────────────
if (out.scale.hasEvidenceColumn) {
  out.evidence = {
    edgesTotal: out.scale.graphEdges,
    edgesWithEvidence: n("SELECT COUNT(*) AS n FROM graph_edges WHERE evidence IS NOT NULL AND evidence <> ''"),
    edgesWithoutEvidence: n("SELECT COUNT(*) AS n FROM graph_edges WHERE evidence IS NULL OR evidence = ''")
  }
} else {
  out.evidence = { edgesTotal: out.scale.graphEdges, edgesWithEvidence: null, edgesWithoutEvidence: out.scale.graphEdges, note: 'evidence 列不存在(M1 未做)' }
}

// ── ④ 画像空值/脏值 ───────────────────────────────────────────────
out.profile = q('SELECT * FROM user_profile').map((r) => {
  const dirty = []
  for (const [k, v] of Object.entries(r)) {
    if (v === null || v === undefined) dirty.push(k + '=NULL')
    else if (['null', 'undefined', ''].includes(String(v).trim())) dirty.push(k + "='" + String(v) + "'")
  }
  return { row: r, dirty }
})

// ── ⑤ 节点激活度:物化 vs 现算 ────────────────────────────────────
const nowSec = Date.now() / 1000
const edgeRows = q('SELECT edge_id AS id, source_id AS source, target_id AS target, relation, half_life AS halfLife,' +
  ' intrinsic_value AS intrinsicValue, last_accessed AS lastAccessed, activation FROM graph_edges')
const live = new Map()
for (const e of edgeRows) {
  const h = Number(e.halfLife) > 0 ? Number(e.halfLife) : initialHalfLife(Number(e.intrinsicValue) || 10)
  const dtH = Math.max(0, (nowSec - (Number(e.lastAccessed) || 0)) / 3600)
  const act = Math.round(retrievability(dtH, h) * 1000) / 10
  for (const nid of [e.source, e.target]) {
    if (!live.has(nid) || act > live.get(nid)) live.set(nid, act)
  }
}
const nodeActs = q('SELECT name, activation FROM graph_nodes')
out.activation = {
  nodesMaterializedZero: nodeActs.filter((r) => (Number(r.activation) || 0) === 0).length,
  nodesTotal: nodeActs.length,
  edgesMaterializedZero: edgeRows.filter((r) => (Number(r.activation) || 0) === 0).length,
  edgesTotal: edgeRows.length,
  sample: nodeActs.slice(0, 5).map((r) => ({ name: r.name, materialized: Number(r.activation) || 0, live: live.get(r.name) ?? 0 }))
}

// ── ⑥ 证据完整性(悬置话题 / 议程) ────────────────────────────────
out.evidenceGaps = {
  threadsWithoutSession: hasColumn('pending_threads', 'session_id')
    ? n("SELECT COUNT(*) AS n FROM pending_threads WHERE session_id IS NULL OR session_id=''")
    : null,
  agendaWithoutEvidence: hasColumn('her_agenda', 'evidence')
    ? n("SELECT COUNT(*) AS n FROM her_agenda WHERE evidence IS NULL OR evidence=''")
    : null
}

// ── ⑦ 工程自指污染(2026-09-26 现场) ──────────────────────────────
// 他的原话:「我说这个记忆图谱为什么会出现那么多奇怪的记忆?我之前在
// astrbot 上面可没有这个问题啊,那个记忆图是非常干净的」。他的裁决:
// **工程自指一律拒收**。这里用与写入端**同一份判据**(lib/inbound-filter.js)
// 回扫全库 —— 第二份判据就是第二套 bug。
// **绝不能**让整条 SQL 因为少一列而报错被 q() 吞成空数组:那会让这项
// 症状显示「0 条」,而实际情况是一屏脏数据(第一版就这么骗了自己一次)。
// (v0.29.0:渠道维度随群聊拒收退役,SELECT 不再带 channel 列。)
const selfRows = q(
  'SELECT memory_id AS memoryId, summary, layer, source, status, is_active AS isActive,'
  + ' intrinsic_value AS intrinsicValue, emotion_score AS emotionScore, timestamp'
  + ' FROM episodic_memory ORDER BY memory_id'
)
if (selfRows.length === 0 && n('SELECT COUNT(*) AS n FROM episodic_memory') > 0) {
  throw new Error('体检自指扫描读到 0 行,但库里明明有数据 —— SQL 或列名不对,拒绝给出假报告')
}
const classify = (r) => rejectReason(String(r.summary || '')).reason
const brief = (r) => ({
  id: r.memoryId, layer: r.layer, source: r.source,
  active: Number(r.isActive) === 1,
  intrinsicValue: Number(r.intrinsicValue || 0),
  emotionScore: Number(r.emotionScore || 0),
  timestamp: Number(r.timestamp || 0),
  summary: String(r.summary || '').slice(0, 80)
})
out.selfReferential = selfRows
  .filter((r) => classify(r) === 'self-referential')
  .map(brief)
out.hostInjection = selfRows
  .filter((r) => classify(r) === 'host-injection')
  .map(brief)
out.selfReferentialActive = out.selfReferential.filter((r) => r.active).length
out.hostInjectionActive = out.hostInjection.filter((r) => r.active).length
// 自指节点:图上站着「Echo记忆架构 / agent后端架构」这种
out.selfReferentialNodes = nodeRows
  .filter((r) => rejectReason(String(r.name || '')).reason === 'self-referential')
  .map((r) => r.name)
// (v0.29.0:渠道分布段随群聊拒收退役 —— 记忆不再分渠道;老库里的
// channel 列原样留着,不再被引用。)
// 残留的群渠道行(路由表):入站闸拒收 + 出站只走私聊之后,它们是
// 死行 —— 收不到也发不出任何东西。报出来,让人心里有数。
out.staleGroupChannels = n("SELECT COUNT(*) AS n FROM relay_channels WHERE chat_type = 'group'")
// 清理路径要用的列存在性,必须在 db.close() **之前**算好 ——
// hasColumn 走的是同一个句柄,关掉之后再问会抛错被吞成 false,
// 于是「归档自指节点」整段静默跳过(第一版就这么漏掉了 Echo记忆架构)。
const canTombstoneNodes = hasColumn('graph_nodes', 'is_active')

// ── ⑧ 对话回放里的宿主注入残留(2026-09-26 现场) ──────────────────
// 与记忆层同一个病:宿主每轮注入的 runtime context 被捕获进了
// conversation_log(实测 44/100 行)。它现在进不了记忆、进不了共享窗口、
// 进不了反思信封(三处都挡了),但**回放页照旧显示** —— 面板上看着还是脏。
// 这里只报数,清理由 --clean 一起做(归档式:留行 + 审计)。
const convRows = q('SELECT turn_id, channel, user_text FROM conversation_log')
out.hostNoiseTurns = convRows.filter((r) => !isHumanUtterance(String(r.user_text || ''))).length
out.conversationTotal = convRows.length

db.close()

// ── 清理(写路径之一:--clean --yes;另一条是 --rollback) ────────────
// F7(2026-09-27):归档侧有自己的守卫,不再是无条件执行写入侧的 rejectReason。
const cand = [...out.selfReferential, ...out.hostInjection]
const cleanPlan = planCleanup(cand, Date.now() / 1000)
out.cleanupPlan = {
  candidates: cand.length,
  archivable: cleanPlan.targets.length,
  protected: cleanPlan.kept.length,
  protectRules: { iv: PROTECT_IV, emotion: PROTECT_EMOTION, days: PROTECT_DAYS },
  kept: cleanPlan.kept.map((r) => ({ id: r.id, why: r.why, layer: r.layer, summary: r.summary }))
}
if (doClean) {
  if (!confirmed) {
    console.log('干跑:候选 ' + cand.length + ' 条,其中 **' + cleanPlan.targets.length
      + ' 条**可归档、' + cleanPlan.kept.length + ' 条被守卫豁免。加 --yes 才真归档。')
    console.log('  归档 = is_active=0 + 批次审计留痕;行还在库里,面板翻得出来。')
    console.log('  守卫规则:L0 / I≥' + PROTECT_IV + ' / 情感≥' + PROTECT_EMOTION
      + ' / 近 ' + PROTECT_DAYS + ' 天 一律豁免。')
    console.log('')
    if (cleanPlan.kept.length > 0) {
      console.log('  被豁免(不归档):')
      for (const r of cleanPlan.kept) {
        console.log('    #' + String(r.id).padStart(4) + ' [' + r.why + '] '
          + String(r.summary).slice(0, 56))
      }
      console.log('')
    }
    console.log('  将归档:')
    for (const r of cleanPlan.targets) {
      console.log('    #' + String(r.id).padStart(4) + ' [' + (r.layer || '?') + '] '
        + String(r.summary).slice(0, 60))
    }
    console.log('')
    process.exit(0)
  }
  const wdb = new DatabaseSync(dbPath)
  const now = Date.now() / 1000
  const batchId = newBatchId(now)
  let done = 0
  let nodesDone = 0
  try {
    const res = archiveBatch(wdb, batchId, cleanPlan.targets, now)
    done = res.archived
    // 自指节点一并归档(墓碑:is_active=0 + 它的边一起下线)。
    // 与 graph-merge 的墓碑同款做法 —— 不物理删除,留档可查。
    if (canTombstoneNodes) {
      for (const name of out.selfReferentialNodes) {
        try {
          const node = wdb.prepare('SELECT node_id FROM graph_nodes WHERE name = ? AND COALESCE(is_active,1)=1').get(name)
          if (node === undefined) continue
          wdb.prepare('UPDATE graph_nodes SET is_active = 0 WHERE node_id = ?').run(node.node_id)
          wdb.prepare('UPDATE graph_edges SET is_active = 0 WHERE source_id = ? OR target_id = ?')
            .run(node.node_id, node.node_id)
          wdb.prepare(
            'INSERT OR REPLACE INTO audit_logs (trace_id, session_id, user_key, user_input, tool_call, timestamp)' +
            ' VALUES (?, ?, ?, ?, ?, ?)'
          ).run('cleanup-node:' + batchId + ':' + node.node_id, 'global', 'master',
            '批次 ' + batchId + ' 归档自指节点 ' + name, 'graph_cleanup', now)
          nodesDone += 1
        } catch (err) {
          console.error('  节点 ' + name + ' 归档失败: ' + String(err?.message ?? err))
        }
      }
    }
  } finally {
    wdb.close()
  }
  console.log('已归档 ' + done + ' 条记忆 + ' + nodesDone + ' 个自指节点'
    + '(行仍在库,is_active=0 + 审计留痕)。')
  console.log('  被守卫豁免 ' + cleanPlan.kept.length + ' 条(L0 / I≥' + PROTECT_IV
    + ' / 情感≥' + PROTECT_EMOTION + ' / 近 ' + PROTECT_DAYS + ' 天)。')
  console.log('  批次 id: ' + batchId + '   —— 撤销:node scripts/memory-doctor.mjs --rollback '
    + batchId)
  console.log('')
}

// ── 输出 ──────────────────────────────────────────────────────────
if (asJson) {
  console.log(JSON.stringify(out, null, 2))
  process.exit(0)
}

const L = []
L.push('记忆体检 · ' + dbPath)
L.push('')
L.push('规模:')
L.push('  情景记忆 ' + out.scale.episodicTotal + ' 行(现役 ' + out.scale.episodicActive
  + ' / 隔离 ' + out.scale.episodicQuarantined + ');L0 现役 ' + out.l0Active + ' 条')
L.push('  分层 ' + JSON.stringify(out.scale.byLayer) + '  来源 ' + JSON.stringify(out.scale.bySource))
L.push('  图谱 ' + out.scale.graphNodes + ' 节点 / ' + out.scale.graphEdges + ' 边'
  + (out.scale.graphEdgesActive === null ? '' : '(现役 ' + out.scale.graphEdgesActive + ')'))
L.push('  悬置话题 ' + out.scale.pendingThreads + ' / 议程 ' + out.scale.agenda
  + ' / 日记 ' + out.scale.diary + ' / 审计 ' + out.scale.audit)
L.push('')
L.push('① 换说法重复组: ' + out.duplicateGroupCount + ' 组,可让位 ' + out.duplicateRowCount + ' 行')
for (const g of out.duplicateGroups.slice(0, 8)) {
  L.push('   [' + g.layer + '] 留 #' + g.survivor.id + ' I=' + g.survivor.I + ' 「' + String(g.survivor.summary).slice(0, 32) + '」')
  for (const l of g.losers) L.push('        让 #' + l.id + ' I=' + l.I + ' 「' + String(l.summary).slice(0, 32) + '」')
}
if (out.duplicateGroupCount > 8) L.push('   …还有 ' + (out.duplicateGroupCount - 8) + ' 组(--json 看全)')
L.push('')
L.push('② 图谱同义节点: Tier1(自动) ' + out.aliasPlan.tier1Count + ' 条 / Tier2(待你点头) ' + out.aliasPlan.tier2Count + ' 条')
for (const m of out.aliasPlan.tier1) L.push('   T1 ' + m.loser + ' → ' + m.canonical)
for (const m of out.aliasPlan.tier2) L.push('   T2 ' + m.loser + ' → ' + m.canonical + '   (' + m.why + ')')
for (const h of out.aliasPlan.heuristic.slice(0, 6)) L.push('   ?  ' + h.names.join(' / ') + '   (' + h.note + ')')
L.push('   孤点归属缺失: ' + (out.orphanOwnerNodes.length ? out.orphanOwnerNodes.join('、') : '无'))
L.push('   现役节点 ' + out.graphHealth.activeNodes + ' / 墓碑 ' + out.graphHealth.tombstoneNodes
  + ';悬空边 ' + out.graphHealth.danglingEdges + ' 条,指向墓碑的现役边 ' + out.graphHealth.edgesTouchingTombstone + ' 条')
L.push('')
L.push('③ 边依据: ' + (out.evidence.edgesWithEvidence === null
  ? 'evidence 列不存在(M1 未做)'
  : out.evidence.edgesWithEvidence + '/' + out.evidence.edgesTotal + ' 有依据'))
L.push('')
L.push('④ 画像:')
for (const p of out.profile) {
  L.push('   ' + JSON.stringify(p.row))
  L.push('   脏值/空值: ' + (p.dirty.length ? p.dirty.join(', ') : '无'))
}
L.push('')
L.push('⑤ 激活度: 节点物化全 0 的 ' + out.activation.nodesMaterializedZero + '/' + out.activation.nodesTotal
  + ' 个;边物化全 0 的 ' + out.activation.edgesMaterializedZero + '/' + out.activation.edgesTotal + ' 条(面板现算)')
L.push('')
L.push('⑥ 证据完整性: 悬置话题缺 session ' + out.evidenceGaps.threadsWithoutSession
  + ' 条;议程缺依据 ' + out.evidenceGaps.agendaWithoutEvidence + ' 条')
L.push('')
L.push('⑦ 工程自指污染(他的裁决:一律拒收):')
L.push('   情景记忆 自指 ' + out.selfReferential.length + ' 条(现役 ' + out.selfReferentialActive
  + ') / 宿主注入残留 ' + out.hostInjection.length + ' 条(现役 ' + out.hostInjectionActive + ')')
L.push('   图谱节点 自指 ' + out.selfReferentialNodes.length + ' 个'
  + (out.selfReferentialNodes.length ? ': ' + out.selfReferentialNodes.slice(0, 12).join('、') : ''))
L.push('   群聊渠道残留行 ' + out.staleGroupChannels + ' 条  (v0.29.0 个人机器人:群聊一律拒收,'
  + '这些行收不到也发不出任何东西,留在库里只是历史)')
L.push('   对话回放 宿主注入残留 ' + out.hostNoiseTurns + ' / ' + out.conversationTotal + ' 行'
  + '  (记忆/共享窗口/反思信封三处都已挡;回放页照旧显示)')
L.push('   归档守卫(F7):候选 ' + out.cleanupPlan.candidates + ' 条 → 可归档 '
  + out.cleanupPlan.archivable + ' 条,被豁免 ' + out.cleanupPlan.protected + ' 条'
  + '(L0 / I≥' + PROTECT_IV + ' / 情感≥' + PROTECT_EMOTION + ' / 近 ' + PROTECT_DAYS + ' 天)')
for (const r of out.cleanupPlan.kept.slice(0, 12)) {
  L.push('     豁免 #' + String(r.id).padStart(4) + ' [' + r.why + '] ' + r.summary)
}
if (out.cleanupPlan.kept.length > 12) {
  L.push('     …还有 ' + (out.cleanupPlan.kept.length - 12) + ' 条(--json 看全)')
}
if (selfRefList) {
  for (const r of out.selfReferential) {
    L.push('   自指 #' + String(r.id).padStart(4) + ' ' + (r.active ? '[现役]' : '[已归档]')
      + ' [' + (r.layer || '?') + '] ' + r.summary)
  }
  for (const r of out.hostInjection) {
    L.push('   注入 #' + String(r.id).padStart(4) + ' ' + (r.active ? '[现役]' : '[已归档]')
      + ' [' + (r.layer || '?') + '] ' + r.summary)
  }
}
console.log(L.join('\n'))
