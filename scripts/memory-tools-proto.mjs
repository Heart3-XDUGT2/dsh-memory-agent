#!/usr/bin/env node
/**
 * 记忆工具原型(只读)—— 阶段 2「记忆工具化」的可跑原型
 * ============================================================================
 * 本文件**只做原型与测量**,不接线:
 *   · 不注册任何会话侧工具(`lib/index.js` 一个字不改);
 *   · 不改既有检索默认路径(`load()` / turn-snapshot 注入不动);
 *   · 不碰三条红线(压缩域 / 人格注入点 / `lib/relay.js`);
 *   · 对本库**只 SELECT,不 INSERT / UPDATE / DELETE**。
 * 设计依据:docs/PLAN_MEMORY_GRAPH_ACTION.md §3(阶段 2)。
 *
 * 用法:
 *   node scripts/memory-tools-proto.mjs                       # 跑默认 4 个代表性查询 + 差异报表
 *   node scripts/memory-tools-proto.mjs --db <path>           # 指定库(也可用环境变量 ECHO_DB)
 *   node scripts/memory-tools-proto.mjs --limit 5             # search 每次返回上限(默认 5,硬顶 12)
 *   node scripts/memory-tools-proto.mjs --json                # 结构化结果(JSON 到 stdout)
 *   node scripts/memory-tools-proto.mjs --query 校园跑        # 只跑一个 search 查询(可重复)
 *   node scripts/memory-tools-proto.mjs --node 校园跑         # 只跑一个 neighbors 查询
 *   node scripts/memory-tools-proto.mjs --days 7              # 只跑一个 timeline 查询
 *   node scripts/memory-tools-proto.mjs --memory-id 42        # 只跑一个 get 查询
 *
 * 最小工具集(4 个,全部只读、全部限条/限深/限时):
 *   memory.search     query, limit        → hits[{memoryId, summary, cov, total, matched, layer, ageDays}]
 *   memory.get        memoryId, maxChars  → 单条全字段(原文截断)
 *   memory.neighbors  node, depth, limit  → 一跳邻域(节点名 + 边)
 *   memory.timeline   days, limit         → 时间窗内的记忆(倒序)
 *
 * 三条硬约束(为什么这么写):
 *   ① **只读开库**:走 `file:<abs>?mode=ro` URI + `readOnly: true` 双保险,连 `PRAGMA` 都不写。
 *      **故意不走 `lib/store.js` 的 `openStore()`** —— 它顺带做列迁移(ALTER TABLE = 写库)。
 *      这与既有脚本 `scripts/graph-baseline.mjs` 是同一套做法(它已实测可行),本文件沿用。
 *   ② **不 import 任何会做迁移/写入的模块**。本文件只 import `lib/retrieve.js` 的纯函数
 *      `rankMemories`(它 import 的 `lib/dmae.js` / `lib/lexical.js` 都是纯数学/纯分词,
 *      0 fs、0 DB、0 全局副作用 —— 本原型实测核对过),因此拿到的是**与线上同源**的打分,
 *      而不是自己另写一套。
 *   ③ **只读 ≠ 无副作用**:线上检索那条路(`lib/store.js` retrieve)**会写库**
 *      (`UPDATE episodic_memory SET half_life=…, recall_count=recall_count+1 …` = 「被想起就强化」),
 *      `echo_memory` 走的正是它(`lib/engine.js` memorySearch 自述「含强化」)。
 *      ⇒ 本原型**只调纯函数**,不碰那段回写 —— 所以它跑完库文件的 mtime 必须**不变**。
 *      这不是细节:把"只读工具"接到那个入口,等于每查一次改一次库。
 */
import { DatabaseSync } from 'node:sqlite'
import { existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { rankMemories, CANDIDATE_LIMIT } from '../lib/retrieve.js'
import { loadNames } from '../lib/names.js'

// ---- 参数 ----
const argv = process.argv.slice(2)
const has = (f) => argv.includes(f)
const valOf = (f) => {
  const i = argv.indexOf(f)
  return i !== -1 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : ''
}
const allOf = (f) => {
  const out = []
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === f && argv[i + 1] && !argv[i + 1].startsWith('--')) out.push(argv[i + 1])
  }
  return out
}
if (has('--help') || has('-h')) {
  console.log('用法: node scripts/memory-tools-proto.mjs [--db <path>] [--limit N] [--json]')
  console.log('       [--query <text>]... [--node <name|id>]... [--days N] [--memory-id N]')
  process.exit(0)
}
const asJson = has('--json')
const dbPath = valOf('--db') || process.env.ECHO_DB || join(homedir(), '.dsh', 'echo', 'echo.db')

// ---- 工具边界(硬上限在**工具侧**强制,不信任调用方给的 limit)----
const HARD = {
  searchLimit: 12, searchDefault: 5, summaryChars: 120,
  getChars: 1200, getDefault: 400,
  neighborsLimit: 20, neighborsDefault: 8, depthMax: 1,
  timelineLimit: 20, timelineDefault: 10, daysMax: 30, daysDefault: 7,
  callTimeoutMs: 1500 // 声明值:单次工具调用超过它即视为"该轮废"(本原型只报数,不中断)
}
const clamp = (v, lo, hi, dflt) => {
  const n = Number(v)
  if (!Number.isFinite(n)) return dflt
  return Math.min(hi, Math.max(lo, Math.trunc(n)))
}
/** 一切可见性都锚在归属者上:与 `python/engine/graph.py:load(conn, owner_key)` 同一把尺。 */
const OWNER_KEY = 'master'
const MEM_FILTER = "user_id = ? AND is_active = 1 AND (status IS NULL OR status = 'active')"
/** 说话人 / 人格节点(与 `scripts/graph-baseline.mjs` 同一份口径)。
 *
 * ★ P3-c(设计 §1.1 第 23 行,总纲五处名单之外的**第七处**):名单现读
 * `<数据目录>/names.json` 的 `speakers`(`lib/names.js` 是 JS 侧唯一读点,
 * 与 `lib/memory-read-tools.js:79` 同一条路)。**空 ⇒ 空集合**(中性,不猜,不回落旧硬编码)。
 * 这条 import **不破**本文件上面那条"只读"纪律:`lib/names.js` 只 `readFileSync`
 * 一个 JSON(`lib/data-dir.js` 的 `resolveDataFilePath()` 是纯拼路径,不 mkdir、不 scaffold),
 * 库文件一个字节都不动。 */
const SPEAKERS = loadNames().speakers
if (SPEAKERS.length === 0) {
  console.error('echo: names.json 里没有 speakers(换机/清过数据目录)⇒ 本表按"无说话人"算')
}

// ---- 只读开库 ----
if (!existsSync(dbPath)) {
  console.error('库不存在: ' + dbPath + '(用 --db <path> 或环境变量 ECHO_DB 指定)')
  process.exit(1)
}
const uri = 'file:' + dbPath.replace(/\\/g, '/') + '?mode=ro'
let db = null
let mtimeBefore = 0
try {
  mtimeBefore = statSync(dbPath).mtimeMs
  db = new DatabaseSync(uri, { readOnly: true })
} catch (err) {
  console.error('开库失败(只读):' + uri)
  console.error(String(err && err.message ? err.message : err))
  process.exit(1)
}

// ---- 只读取数(全部 prepared statement;query 永远走绑定参数,不拼 SQL)----
const tableExists = (name) => !!db.prepare("select 1 from sqlite_master where type='table' and name = ?").get(name)
const safeJsonArray = (v) => {
  if (Array.isArray(v)) return v
  try { const a = JSON.parse(String(v || '[]')); return Array.isArray(a) ? a : [] } catch { return [] }
}
const rowToMemory = (r) => ({
  memoryId: r.memory_id,
  userId: r.user_id,
  keywords: safeJsonArray(r.keywords),
  summary: r.summary || '',
  emotionScore: r.emotion_score || 0,
  timestamp: Number(r.timestamp) || 0,
  isActive: r.is_active,
  source: r.source || 'private',
  sourceLabel: r.source_label || '',
  actor: r.actor || '',
  intrinsicValue: Number(r.intrinsic_value) || 0,
  halfLife: Number(r.half_life) || 0,
  recallCount: r.recall_count || 0,
  lastRecalled: Number(r.last_recalled) || 0,
  occurredAt: Number(r.occurred_at) || 0,
  learnedAt: Number(r.learned_at) || 0,
  temporalStatus: r.temporal_status || 'time_unknown',
  memoryKey: r.memory_key || '',
  layer: r.layer || '',
  evidence: r.evidence || '',
  status: r.status || 'active',
  supersededBy: Number(r.superseded_by) || 0,
  augKeys: safeJsonArray(r.aug_keys)
})
/** 候选池口径 = `lib/store.js` retrieve 的取数(同一个 CANDIDATE_LIMIT、同一个排序)。 */
const candidateRows = db.prepare(
  'SELECT * FROM episodic_memory WHERE ' + MEM_FILTER + ' ORDER BY timestamp DESC LIMIT ' + CANDIDATE_LIMIT
).all(OWNER_KEY).map(rowToMemory)
// ⚠️ 节点**不按 owner_key 过滤**:实测本库 28 个节点里 **5 个 owner_key 是 NULL**
// (含度最高的桥节点 `音理`)。而 `load()` 的可见性口径**不是**节点自己的 owner_key,
// 而是「**被本人边引用到**」(graph.py:442-443)⇒ 工具面若照 node.owner_key 过滤,
// 会把 `音理` 这类节点静默藏掉。这里照 load() 的口径:全表读,另算 `visibleInLoad`。
const nodeRows = db.prepare(
  'select node_id, name, node_type, is_protected, owner_key, coalesce(is_active,1) as is_active from graph_nodes'
).all().map((r) => ({
  id: String(r.node_id), name: String(r.name), type: String(r.node_type),
  isProtected: Number(r.is_protected) === 1, isActive: Number(r.is_active) === 1,
  ownerKey: r.owner_key === null || r.owner_key === undefined ? null : String(r.owner_key),
  visibleInLoad: false // 下面按"被本人边引用到"回填
}))
const edgeRows = db.prepare(
  'select edge_id, source_id, target_id, relation, weight, coalesce(is_active,1) as is_active from graph_edges where owner_key = ?'
).all(OWNER_KEY).map((r) => ({
  id: Number(r.edge_id), source: String(r.source_id), target: String(r.target_id),
  relation: String(r.relation || '相关'), weight: Number(r.weight) || 1, isActive: Number(r.is_active) === 1
}))
const aliases = tableExists('graph_aliases')
  ? db.prepare('select alias, canonical_name from graph_aliases order by alias').all().map((r) => ({ alias: String(r.alias), canonical: String(r.canonical_name) }))
  : []
const nodeById = new Map(nodeRows.map((n) => [n.id, n]))
const nodeByName = new Map(nodeRows.map((n) => [n.name, n]))
const memoryById = new Map(candidateRows.map((m) => [m.memoryId, m]))
// 实体识别口径与 graph-baseline 同源:节点名(剔除"名字本身是别名键"的重名节点)在 summary 里朴素子串匹配
const aliasKeys = new Set(aliases.map((a) => a.alias))
const matchers = nodeRows.filter((n) => !aliasKeys.has(n.name)).map((n) => [n.name, n.name])
const entitiesOf = (text) => {
  const out = new Set()
  for (const [needle, canonical] of matchers) if (String(text || '').includes(needle)) out.add(canonical)
  return [...out]
}
const degreeOf = new Map()
for (const e of edgeRows) {
  if (!e.isActive) continue
  degreeOf.set(e.source, (degreeOf.get(e.source) || 0) + 1)
  degreeOf.set(e.target, (degreeOf.get(e.target) || 0) + 1)
  // load() 口径的可见性:被**本人边**引用到(与 graph.py:442-443 同一把尺)
  for (const id of [e.source, e.target]) {
    const n = nodeById.get(id)
    if (n) n.visibleInLoad = true
  }
}

// ---- 计时与调用账本 ----
const calls = []
const cut = (s, n) => (String(s || '').length > n ? String(s).slice(0, n) + '…[裁到' + n + '字]' : String(s || ''))
/**
 * 一次工具调用:计时、记账、硬上限兜底。
 * `fn` 只允许读内存里的数组(库已经在上面一次性读完并只读关闭前的句柄不再复用)。
 */
function call (name, args, fn) {
  const t0 = performance.now()
  let result = null
  let error = null
  try { result = fn() } catch (err) { error = String(err && err.message ? err.message : err) }
  const ms = Math.round((performance.now() - t0) * 1000) / 1000
  const entry = { tool: name, args, ms, overBudget: ms > HARD.callTimeoutMs, error }
  calls.push(entry)
  if (error !== null) return { ok: false, reason: 'tool-error', error, _ms: ms }
  return { ok: true, _ms: ms, ...result }
}

// ---- 工具 1:memory.search ----
// 只读、只走纯函数打分器(**不**做强化回写 —— 见文件头 ③);可见性 = OWNER_KEY;跨会话:否。
function memorySearch (query, opts = {}) {
  const limit = clamp(opts.limit, 1, HARD.searchLimit, HARD.searchDefault)
  const q = String(query || '').slice(0, 120)
  return call('memory.search', { query: q, limit }, () => {
    if (q.trim().length < 2) return { ok: false, reason: 'query 太短', hits: [] }
    const ranked = rankMemories(candidateRows, q, limit, Date.now() / 1000, { dedupe: true })
    return {
      hits: ranked.map((it) => ({
        memoryId: it.memoryId,
        summary: cut(it.summary, HARD.summaryChars),
        cov: it.hits, total: it.total, matched: it.matched !== false,
        layer: it.layer, ageDays: Math.round(it.ageDays * 10) / 10,
        entities: entitiesOf(it.summary)
      }))
    }
  })
}
// ---- 工具 2:memory.get ----
// 原文:能看,但截断(getChars);跨会话:否(只查 OWNER_KEY 的活跃记忆)。
function memoryGet (memoryId, opts = {}) {
  const id = Number(memoryId)
  const maxChars = clamp(opts.maxChars, 80, HARD.getChars, HARD.getDefault)
  return call('memory.get', { memoryId: id, maxChars }, () => {
    const m = memoryById.get(id)
    if (!m) return { ok: false, reason: 'not-found(不在本归属者的活跃记忆里)' }
    return {
      memoryId: m.memoryId, summary: cut(m.summary, maxChars), keywords: m.keywords,
      layer: m.layer, timestamp: m.timestamp, occurredAt: m.occurredAt,
      temporalStatus: m.temporalStatus, halfLife: m.halfLife, recallCount: m.recallCount,
      evidence: cut(m.evidence, 300), supersededBy: m.supersededBy
    }
  })
}
// ---- 工具 3:memory.neighbors ----
// 一跳邻域。depth 硬顶 1(本阶段不做多跳扩散 —— 那是阶段 4 的 PPR);跨会话:否。
function memoryNeighbors (node, opts = {}) {
  const depth = clamp(opts.depth, 1, HARD.depthMax, 1)
  const limit = clamp(opts.limit, 1, HARD.neighborsLimit, HARD.neighborsDefault)
  return call('memory.neighbors', { node: String(node || ''), depth, limit }, () => {
    const seed = nodeByName.get(String(node)) || nodeById.get(String(node))
    if (!seed) return { ok: false, reason: 'node-not-found', neighbors: [] }
    const out = []
    for (const e of edgeRows) {
      if (!e.isActive) continue
      let other = null
      let direction = null
      if (e.source === seed.id) { other = e.target; direction = 'out' }
      else if (e.target === seed.id) { other = e.source; direction = 'in' }
      else continue
      const n = nodeById.get(other)
      if (!n || !n.isActive) continue
      out.push({
        nodeId: n.id, name: n.name, nodeType: n.type,
        relation: e.relation, weight: e.weight, direction,
        isSpeakerNode: SPEAKERS.includes(n.name)
      })
    }
    out.sort((a, b) => b.weight - a.weight || (a.name < b.name ? -1 : 1))
    return {
      node: seed.name,
      seedVisibleInLoad: seed.visibleInLoad,
      depth, neighbors: out.slice(0, limit), totalNeighbors: out.length, truncated: out.length > limit
    }
  })
}
// ---- 工具 4:memory.timeline ----
// 时间窗(天)→ 倒序。时间只从 episodic_memory.timestamp 取(图侧时间列是死列)。
function memoryTimeline (opts = {}) {
  const days = clamp(opts.days, 1, HARD.daysMax, HARD.daysDefault)
  const limit = clamp(opts.limit, 1, HARD.timelineLimit, HARD.timelineDefault)
  return call('memory.timeline', { days, limit }, () => {
    const nowSec = Date.now() / 1000
    const from = nowSec - days * 86400
    const items = candidateRows
      .filter((m) => m.timestamp >= from)
      .sort((a, b) => b.timestamp - a.timestamp || b.memoryId - a.memoryId)
    return {
      days, from: Math.floor(from), totalInWindow: items.length,
      items: items.slice(0, limit).map((m) => ({
        memoryId: m.memoryId, summary: cut(m.summary, HARD.summaryChars),
        timestamp: m.timestamp, occurredAt: m.occurredAt, layer: m.layer,
        entities: entitiesOf(m.summary)
      })),
      truncated: items.length > limit
    }
  })
}

// ---- 现状口径(对照):一轮注入 = rankMemories 一次,没有第二轮 ----
const BASELINE_TOPK = 6
function baselineOnce (query) {
  const ranked = rankMemories(candidateRows, query, BASELINE_TOPK, Date.now() / 1000, { dedupe: true })
  return ranked.map((it) => it.memoryId)
}

/**
 * 「多一轮」到底多拿到多少:
 *   R1 = memory.search(query, limit) —— **口径固定 = `BASELINE_TOPK`**,与现状一轮注入**条数相同**,
 *        于是 R1 必须与 baseline 逐位一致(这是"工具通道 = 同一个打分器"的现场证据,也是负控的一半)。
 *   R2 = 两**条独立通道**(都限死上限、轮数硬顶 2):
 *        ch1 图跳  : R1 命中文里的节点当种子 → memory.neighbors(一跳) → 邻居名再 memory.search
 *        ch2 时间  : memory.timeline(近 2 天) —— "最近还发生了什么"(与查询词无关的通道)
 * 报表字段:new_hits(分通道)/ changed_rank / stop_reason。
 */
function iterateReport (query, opts = {}) {
  const limit = BASELINE_TOPK // 见上:R1 与现状同条数,增益只可能来自 R2
  const base = baselineOnce(query)
  const r1 = memorySearch(query, { limit })
  const r1Ids = r1.ok ? r1.hits.map((h) => h.memoryId) : []
  const seeds = []
  for (const h of r1.ok ? r1.hits : []) {
    for (const nm of h.entities) if (!SPEAKERS.includes(nm) && !seeds.includes(nm)) seeds.push(nm)
  }
  seeds.sort((a, b) => (degreeOf.get(nodeByName.get(b)?.id) || 0) - (degreeOf.get(nodeByName.get(a)?.id) || 0))
  const seedTop = seeds.slice(0, 3)
  const r1Set = new Set(r1Ids)

  // ---- ch1:图跳(neighbors 一跳 → 邻居名再检索一次)----
  const ch1Calls = []
  const ch1Ids = []
  for (const nm of seedTop) {
    const nb = memoryNeighbors(nm, { depth: 1, limit: HARD.neighborsDefault })
    const neighborNames = (nb.ok ? nb.neighbors : [])
      .filter((x) => !x.isSpeakerNode && !SPEAKERS.includes(x.name))
      .map((x) => x.name)
      .slice(0, 3)
    ch1Calls.push({ seed: nm, neighborCount: nb.ok ? nb.neighbors.length : 0, expanded: neighborNames, ms: nb._ms })
    for (const nname of neighborNames) {
      const s = memorySearch(nname, { limit: 3 })
      for (const h of s.ok ? s.hits : []) if (!ch1Ids.includes(h.memoryId)) ch1Ids.push(h.memoryId)
    }
  }

  // ---- ch2:时间轮(最近 2 天,与查询词无关)----
  const tl = memoryTimeline({ days: 2, limit: HARD.timelineLimit })
  const ch2Ids = (tl.ok ? tl.items : []).map((it) => it.memoryId)

  const newCh1 = ch1Ids.filter((id) => !r1Set.has(id))
  const newCh2 = ch2Ids.filter((id) => !r1Set.has(id))
  const newIds = [...new Set([...newCh1, ...newCh2])]
  const newVsBaseline = newIds.filter((id) => !base.includes(id))
  const changedRank = r1Ids.filter((id, i) => base.indexOf(id) !== -1 && base.indexOf(id) !== i).length
  return {
    query, limit,
    baseline_once: { topK: BASELINE_TOPK, memoryIds: base },
    tool_round1: { memoryIds: r1Ids, ms: r1._ms || 0, equalsBaseline: r1Ids.length === base.length && r1Ids.every((id, i) => id === base[i]) },
    tool_round2: {
      ch1_graph: { seeds: seedTop, calls: ch1Calls, memoryIds: ch1Ids, ms: ch1Calls.reduce((n, c) => n + (c.ms || 0), 0) },
      ch2_time: { days: 2, memoryIds: ch2Ids, inWindow: tl.totalInWindow || 0, ms: tl._ms || 0 }
    },
    new_hits: {
      vs_round1: newIds.length, vs_baseline: newVsBaseline.length,
      by_channel: { graph: newCh1.length, time: newCh2.length },
      ids: newIds, idsNotInBaseline: newVsBaseline
    },
    changed_rank: changedRank,
    union_with_tools: r1Ids.length + newIds.length,
    gain_vs_baseline: newVsBaseline.length,
    stop_reason: seedTop.length === 0 && newIds.length === 0
      ? 'no-seed(R1 没命中任何已知节点)'
      : (newIds.length === 0 ? 'no-new-hit(再跳也拿不到新的)' : 'budget:轮数硬顶 2')
  }
}

// ---- 跑:默认 4 个代表性查询 / 或用户指定的那几个 ----
const custom = allOf('--query').length > 0 || allOf('--node').length > 0 || valOf('--days') !== '' || valOf('--memory-id') !== ''
const limitArg = valOf('--limit') !== '' ? clamp(valOf('--limit'), 1, HARD.searchLimit, HARD.searchDefault) : HARD.searchDefault
const direct = []
if (custom) {
  for (const q of allOf('--query')) direct.push({ kind: 'search', out: memorySearch(q, { limit: limitArg }) })
  for (const n of allOf('--node')) direct.push({ kind: 'neighbors', out: memoryNeighbors(n, { depth: 1, limit: HARD.neighborsDefault }) })
  if (valOf('--days') !== '') direct.push({ kind: 'timeline', out: memoryTimeline({ days: valOf('--days'), limit: HARD.timelineDefault }) })
  if (valOf('--memory-id') !== '') direct.push({ kind: 'get', out: memoryGet(valOf('--memory-id'), {}) })
}
// 默认套件:① 桥节点「校园跑」② 桥节点「章鱼小丸子」③ 最近 7 天 ④ 「音理」一跳邻域
//          + ⑤ 近期现场词「合肥」(用来验"多一轮"在长尾话题上的表现)
const suite = custom ? null : {
  searches: ['校园跑', '章鱼小丸子', '合肥'],
  nodes: ['音理', '校园跑'],
  days: HARD.daysDefault
}
const report = { searches: [], neighbors: [], timeline: null, iterate: [], direct }
if (suite) {
  for (const q of suite.searches) {
    const r = memorySearch(q, { limit: limitArg })
    report.searches.push({ query: q, ...r })
  }
  for (const n of suite.nodes) {
    const r = memoryNeighbors(n, { depth: 1, limit: HARD.neighborsDefault })
    report.neighbors.push({ node: n, ...r })
  }
  report.timeline = memoryTimeline({ days: suite.days, limit: HARD.timelineDefault })
  for (const q of suite.searches) report.iterate.push(iterateReport(q, { limit: limitArg }))
}

const mtimeAfter = statSync(dbPath).mtimeMs
db.close()

// ---- 输出 ----
const meta = {
  db: {
    path: dbPath, uri, readOnly: true,
    mtimeBefore, mtimeAfter, mtimeUnchanged: mtimeBefore === mtimeAfter,
    ownerKey: OWNER_KEY, memoryFilter: MEM_FILTER,
    candidates: candidateRows.length, nodes: nodeRows.length, edges: edgeRows.length,
    activeEdges: edgeRows.filter((e) => e.isActive).length, aliases: aliases.length
  },
  limits: HARD,
  callCount: calls.length,
  totalToolMs: Math.round(calls.reduce((n, c) => n + c.ms, 0) * 1000) / 1000,
  overBudgetCalls: calls.filter((c) => c.overBudget).length,
  calls
}
if (asJson) {
  console.log(JSON.stringify({ meta, report }, null, 2))
} else {
  const L = []
  const say = (s = '') => L.push(s)
  const pad = (s, n) => String(s) + ' '.repeat(Math.max(0, n - [...String(s)].reduce((w, c) => w + (c.charCodeAt(0) > 0x2e80 ? 2 : 1), 0)))
  const table = (rows, headers) => {
    if (!rows.length) { say('  (无)'); return }
    const widths = headers.map((h, i) => Math.max(...[h, ...rows.map((r) => String(r[i]))].map((s) => [...String(s)].reduce((w, c) => w + (c.charCodeAt(0) > 0x2e80 ? 2 : 1), 0))))
    say('  ' + headers.map((h, i) => pad(h, widths[i])).join('  '))
    for (const r of rows) say('  ' + r.map((c, i) => pad(c, widths[i])).join('  '))
  }
  say('记忆工具原型(只读)—— 阶段 2 的最小工具集 + 「多一轮」差异报表')
  say('='.repeat(72))
  say('库: ' + dbPath)
  say('只读 URI: ' + uri + '(readOnly: true)')
  say('归属者 owner_key=' + OWNER_KEY + '  记忆过滤: ' + MEM_FILTER)
  say('候选池: ' + candidateRows.length + ' 条活跃记忆 / 图 ' + nodeRows.length + ' 节点(' + meta.db.activeEdges + ' 活跃边,load() 口径可见 '
    + nodeRows.filter((n) => n.visibleInLoad).length + ' 个;owner_key 为 NULL 的 '
    + nodeRows.filter((n) => n.ownerKey === null).length + ' 个)/ 别名 ' + aliases.length + ' 条')
  say('工具硬上限: search≤' + HARD.searchLimit + '(默认' + HARD.searchDefault + ') · get≤' + HARD.getChars + '字 · neighbors≤' + HARD.neighborsLimit + '/depth≤' + HARD.depthMax + ' · timeline≤' + HARD.timelineLimit + '/days≤' + HARD.daysMax + ' · 单次声明超时 ' + HARD.callTimeoutMs + 'ms')
  say()
  if (custom) {
    for (const d of report.direct) {
      say('[工具] ' + d.kind + '  (' + d.out._ms + ' ms)' + (d.out.ok ? '' : '  ✗ ' + d.out.reason))
      say('  ' + JSON.stringify(d.out, null, 2).split('\n').join('\n  '))
      say()
    }
  } else {
    say('[1] memory.search(limit=' + limitArg + ')')
    for (const s of report.searches) {
      say('  查询「' + s.query + '」 → ' + (s.ok ? (s.hits.length + ' 条') : '✗ ' + s.reason) + '  (' + s._ms + ' ms)')
      table((s.hits || []).map((h) => [h.memoryId, h.cov, h.layer || '-', h.ageDays + 'd', h.summary.slice(0, 46)]), ['id', 'cov', 'layer', 'age', 'summary'])
    }
    say()
    say('[2] memory.neighbors(depth=1, limit=' + HARD.neighborsDefault + ')')
    for (const nb of report.neighbors) {
      say('  节点「' + nb.node + '」 → ' + (nb.ok ? (nb.totalNeighbors + ' 个邻居,显示 ' + nb.neighbors.length + (nb.truncated ? '(已裁)' : '') + '   [load() 口径可见: ' + (nb.seedVisibleInLoad ? '是' : '否') + ']') : '✗ ' + nb.reason) + '  (' + nb._ms + ' ms)')
      table((nb.neighbors || []).map((x) => [x.name, x.nodeType, x.relation, x.direction, x.weight, x.isSpeakerNode ? '是' : '']), ['邻居', '类型', '关系', '方向', '权重', '说话人'])
    }
    say()
    say('[3] memory.timeline(days=' + suite.days + ', limit=' + HARD.timelineDefault + ')')
    const tl = report.timeline
    say('  窗口内 ' + tl.totalInWindow + ' 条,显示 ' + tl.items.length + (tl.truncated ? '(已裁)' : '') + '  (' + tl._ms + ' ms)')
    table(tl.items.map((it) => [it.memoryId, new Date(it.timestamp * 1000).toISOString().slice(0, 16).replace('T', ' '), it.summary.slice(0, 46)]), ['id', '时间', 'summary'])
    say()
    say('[4] 「多一轮」差异报表(现状一轮注入 vs 工具可再查一轮)')
    table(report.iterate.map((r) => [
      r.query,
      r.baseline_once.memoryIds.length,
      r.tool_round1.memoryIds.length + (r.tool_round1.equalsBaseline ? '(逐位同)' : '(!异)'),
      r.new_hits.by_channel.graph,
      r.new_hits.by_channel.time,
      r.new_hits.vs_baseline,
      r.changed_rank,
      Math.round((r.tool_round1.ms + r.tool_round2.ch1_graph.ms + r.tool_round2.ch2_time.ms) * 100) / 100,
      r.stop_reason
    ]), ['查询', '现状top' + BASELINE_TOPK, '工具R1', 'R2图跳新增', 'R2时间新增', '总新增', '名次变化', '工具耗时ms', '停止原因'])
    for (const r of report.iterate) {
      say('  · 「' + r.query + '」R2 图跳种子=' + (r.tool_round2.ch1_graph.seeds.join('、') || '无')
        + '  时间窗 ' + r.tool_round2.ch2_time.days + ' 天内有 ' + r.tool_round2.ch2_time.inWindow + ' 条')
      say('    新拿到 id: ' + (r.new_hits.ids.join(',') || '无') + '   (其中不在现状 top' + BASELINE_TOPK + ' 里的: ' + (r.new_hits.idsNotInBaseline.join(',') || '无') + ')')
    }
    say()
  }
  say('[5] 每次工具调用耗时')
  table(calls.map((c) => [c.tool, JSON.stringify(c.args), c.ms + ' ms', c.overBudget ? '超预算' : '', c.error || '']), ['工具', '入参', '耗时', '预算', '错误'])
  say('  合计 ' + calls.length + ' 次调用 / ' + meta.totalToolMs + ' ms;超 ' + HARD.callTimeoutMs + 'ms 的调用 ' + meta.overBudgetCalls + ' 次')
  say()
  say('库文件 mtime: 前=' + mtimeBefore + ' 后=' + mtimeAfter + (mtimeBefore === mtimeAfter ? ' (未变)' : ' (!! 变了,只读被破坏)'))
  say('本工具只读,未修改任何数据')
  console.log(L.join('\n'))
}
