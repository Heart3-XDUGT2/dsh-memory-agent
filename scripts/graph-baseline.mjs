#!/usr/bin/env node
/**
 * 白送路网基线 —— 阶段 0(只读测算,可复现)
 * ============================================================
 * 用法:
 *   node scripts/graph-baseline.mjs                    # 人类可读报表(默认库:~/.dsh/echo/echo.db)
 *   node scripts/graph-baseline.mjs --db <path>        # 指定库(也可用环境变量 ECHO_DB)
 *   node scripts/graph-baseline.mjs --json             # 结构化结果(JSON 到 stdout,便于对表/回归)
 *   node scripts/graph-baseline.mjs --expand-aliases   # 别名展开口径(见下「两条口径」)
 *   node scripts/graph-baseline.mjs --edges-json <path> # 导出「候选边明细」NDJSON(二期 2a/2b 的输入契约,见下)
 *   node scripts/graph-baseline.mjs --edges-json -     # 同上,但打到 stdout(此时人读报表改走 stderr)
 *   node scripts/graph-baseline.mjs --edges-json p --time-source fallback    # 允许 learned_at 兜底 occurred_at
 *   node scripts/graph-baseline.mjs --edges-json p --evidence-mode strongest # 证据只留最强那一条
 *   node scripts/graph-baseline.mjs --edges-json p --evidence-cap 16         # 证据数组上限(默认 16)
 *
 * ===================== 候选边明细契约(定稿 v1.1,二期 2a/2b 的实现依据) =====================
 * NDJSON:一个候选边一行 JSON,**每行字段集合完全一致**(15 个字段,不多不少):
 *
 *   kind                  : 'temporal' | 'cooccur_same_memory' | 'cooccur_same_day'
 *   source_kind/target_kind: 'node'(共现端点 = graph_nodes.node_id) | 'memory'(时间端点 = memory_id)
 *   endpoint_kind         : 兼容字段;共现 = 'node'、时间 = 'memory',两端同值(保留给老消费方)
 *   source_id/target_id   : **裸 id,不加前缀**。共现边 = 两个概念节点的 node_id;时间边 = 两条相邻
 *                           记忆的 memory_id。**同一列两种语义 ⇒ 消费方必须按 kind/source_kind 分派**
 *   day                   : 仅 `cooccur_same_day` 有值 = 该边锚定的**本地日期** 'YYYY-MM-DD';其余 kind 恒 null。
 *                           ⚠️ 一条同天边的 `count` 可能 >1(跨多天),而 day 只有一格 ⇒ **取最近那天当锚**
 *                           (与其他地方"取时间最晚"一致);要全部日子请另加 days 数组,别偷偷改这里
 *   evidence_memory_id    : 支撑该边的记忆 id 数组(升序,**必然非空**):
 *                            · 同记忆共现 = 两条端点**同时出现**的全部记忆(超上限裁最近 N 条)
 *                            · 同天共现 = **能支撑两端的一小组**:每个命中日取"提到 A 的最晚一条 +
 *                              提到 B 的最晚一条"(两端各 ≥1 条依据;裁剪时这两个"必须留"的 id 会被保住)
 *                            · 时间边 = [前, 后] 两条端点记忆(端点本身即依据)
 *   evidence_truncated    : bool,**含义 = `|evidence_memory_id| < 全量证据集大小`**
 *                           (共现边才可能 true:`--evidence-mode strongest` 或超 `--evidence-cap` 被裁;时间边恒 false)
 *   speaker_node_excluded : 命中 R1(共现端点是说话人节点 —— 名单现读 `<数据目录>/names.json`
 *                            的 `speakers`,见下面 SPEAKERS 那段)⇒ **边仍然导出**、
 *                           只置 true(要能审计"排除了多少",不丢数据)。**时间边恒 false** ——
 *                           时间端点不是概念节点,R1 不适用;**别拿这个字段表达别的规则**
 *   weight / count        : **`count` 的含义按 kind 定义**:
 *                            · `cooccur_same_memory` = 该对**共现的记忆条数**
 *                            · `cooccur_same_day`    = 该对**覆盖的天数**
 *                            · `temporal`            = 1(一条相邻关系)
 *                           **没有** `count === |evidence_memory_id|` 这条不变式(定稿 v1.1 明确放弃);
 *                           结构断言改为"证据非空 + 每个 id 都能为该边至少一端提供依据"。
 *                           `weight` 与 `count` 现在恒等(留给二期的加权位,**当前无任何加权/衰减**)
 *   occurred_at           : · 时间边 / 同记忆边:**只从 episodic_memory 取**(图侧那两列是死列:28 个节点
 *                            全为 0)= 证据池里"**时间最晚且 occurred_at 非零**"那条的值,
 *                            来源必定落在 evidence_memory_id 里
 *                          · 同天边:**不取记忆时间戳**,直接取"**那一天**" = 当天本地 00:00 的 epoch 秒
 *                            (日粒度的边天然知道是哪天;拿记忆 occurred_at 既不准又多 time_unknown)
 *   occurred_at_source    : 'episodic_memory' | 'fallback_learned_at' | **'same_day_group'** | null
 *                            · 默认 `--time-source strict`:取不到就 null + skipped_reason 'no-occurred-at'
 *                            · `--time-source fallback`:仍取不到时用"证据里时间最晚那条"的
 *                              **learned_at** 兜底,并记 'fallback_learned_at'(系统时间、语义不同 ⇒
 *                              必须显式选、必须标来源);**同天边恒 'same_day_group'、不受该开关影响**
 *   skipped_reason        : null,或逗号分隔取值(域:'no-occurred-at' / 'speaker-node' /
 *                            'alias-missing-canonical');一条边可同时命中多个,故不是单值枚举。
 *                            fallback 兜底成功的边**不再**记 'no-occurred-at'(来源看 occurred_at_source);
 *                            同天边因时间来自"日"本身 ⇒ **永不**记 'no-occurred-at'
 *
 * **三个开关默认值**:`--time-source strict` · `--evidence-mode full` · `--evidence-cap 16`。
 * 默认组合就是二期 2a/2b 的验收基线口径(审计优先、不兜底)。
 *
 * 导出默认钉住的记忆口径:未显式给 `--max-memory-id` 时,`--edges-json` 自动用
 * **306**(= 旧测算快照,活跃 217 / 时间边 216 / 同记忆 30→5 / 同天 94→42 那一版),
 * 因为活库边跑边写,不钉住就没有可复现的验收基线。显式给 `--max-memory-id 0` = 不设上限(live)。
 * 行序稳定(便于 diff):temporal → cooccur_same_memory → cooccur_same_day,组内按 (-count, id) 排序。
 * 导出的目标文件请放仓库外或 `.scratch/`(gitignore):免得给仓库添新文件。
 *
 *
 * 为什么有它:docs/PLAN_MEMORY_GRAPH.md 把「时间相邻 + 共现统计」定为新增边的两条主来源
 * (都在已有 episodic_memory 里"白送"),但那份数字是**一次性手算**的 —— 一次性测算做完就忘,
 * 改一行 schema 或换一个过滤条件,数字就漂了。本脚本把那次测算固化成**默认只读**的基线:
 * 以后任何改动前后各跑一次,对不上就是改动动了地基。
 *
 * 三条硬约束(为什么这么写):
 *   ① **只读**:走 `file:<abs>?mode=ro` URI + `readOnly: true` 双保险,连 `PRAGMA` 都不写。
 *      **故意不走 lib/store.js 的 openStore()** —— 它顺带做 v0.16.0 的 evidence 列迁移
 *      (ALTER TABLE = 写库)。测算脚本绝不能因为"随手打开库"而改库。
 *   ② **不改既有代码**:本文件是纯新增;没有往 package.json 的 scripts 里加入口
 *      (加了就是改一个既有文件;`node scripts/graph-baseline.mjs` 直接可跑,不需要 npm 别名)。
 *   ③ **口径必须与旧测算一致**:见下。
 *
 * 两条口径(默认 = 旧测算口径,别随手改) ——
 *   · **实体识别**:用现有 graph_nodes 的**名字**在 `summary` 里做**朴素子串匹配**(无分词、
 *     无大小写折叠)。先过 graph_aliases 做归一:**名字本身就是某个别名键的节点**(被 merge 掉
 *     的重名节点,如 `西电` / `助手` / `大学生`)从匹配池里剔除 —— 它们该由 canonical 代表。
 *     **默认不把 summary 里的别名串展开成 canonical**(`--expand-aliases` 才展开)。
 *     这一条不是审美选择:只有"剔除重名节点、不展开展开"才复现旧测算的
 *     30/5(同记忆)、94/42(同天)与共现度数 top(用户 44 / Echo 40 / 音理 29 …)。
 *     别名展开口径会把同样的数字抬到 34/8、116/58(见 --expand-aliases 输出)。
 *   · **同天**:按 `timestamp`(unix 秒)的**本地日期**分组,**日内取节点并集**再两两成对
 *     (跨记忆的共现也算 —— 这是同天口径比同记忆口径大得多的原因:94 vs 30)。
 *
 * 输出八块:基本盘 / 度数分布 / 情景记忆 / 共现边候选 / 时间边候选 / 桥节点候选 / 识别口径与别名表 /
 * 候选边明细统计(三类条数 + R1 排除 + 跳过,二期 2a/2b 的验收基线)。
 * 末尾固定打印「本报表只读,未修改任何数据」,并在跑完后再读一次库文件 mtime 作证。
 */
import { DatabaseSync } from 'node:sqlite'
import { existsSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { loadNames } from '../lib/names.js'

// ---- 参数 ----
const argv = process.argv.slice(2)
const has = (f) => argv.includes(f)
const valOf = (f) => {
  const i = argv.indexOf(f)
  return i !== -1 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : ''
}
if (has('--help') || has('-h')) {
  console.log('用法: node scripts/graph-baseline.mjs [--db <path>] [--json] [--expand-aliases] [--max-memory-id N]')
  console.log('       [--edges-json <path|->] [--time-source strict|fallback] [--evidence-mode full|strongest] [--evidence-cap N]')
  process.exit(0)
}
const asJson = has('--json')
const expandAliases = has('--expand-aliases')
const edgesJsonTarget = valOf('--edges-json') // '' = 不导出;'-' = stdout
if (asJson && edgesJsonTarget === '-') {
  console.error('--json 与 --edges-json - 都是"往 stdout 打结构化输出",不能同时用')
  process.exit(1)
}
// 契约三开关(默认值见文件头「三个开关默认值」;默认组合 = 验收基线口径)
const TIME_SOURCE = valOf('--time-source') || 'strict' // strict | fallback
if (TIME_SOURCE !== 'strict' && TIME_SOURCE !== 'fallback') {
  console.error('--time-source 只认 strict|fallback,收到: ' + TIME_SOURCE)
  process.exit(1)
}
const EVIDENCE_MODE = valOf('--evidence-mode') || 'full' // full | strongest
if (EVIDENCE_MODE !== 'full' && EVIDENCE_MODE !== 'strongest') {
  console.error('--evidence-mode 只认 full|strongest,收到: ' + EVIDENCE_MODE)
  process.exit(1)
}
const EVIDENCE_CAP = valOf('--evidence-cap') !== '' ? Math.max(1, Number(valOf('--evidence-cap')) || 16) : 16
// 活库一直在长(插件边跑边写):`--max-memory-id N` 把口径钉在某个快照上,
// 否则今天的"活跃 222"和上周的"217"永远对不上账。
const EDGES_JSON_DEFAULT_MAX_MEMORY_ID = 306 // 旧测算快照;见文件头
const rawMax = valOf('--max-memory-id')
const maxMemoryIdExplicit = rawMax !== ''
let maxMemoryId = maxMemoryIdExplicit ? Math.max(0, Number(rawMax) || 0) : 0
let pinnedByDefault = false
if (edgesJsonTarget && !maxMemoryIdExplicit) { maxMemoryId = EDGES_JSON_DEFAULT_MAX_MEMORY_ID; pinnedByDefault = true }
const dbPath = valOf('--db') || process.env.ECHO_DB || join(homedir(), '.dsh', 'echo', 'echo.db')

/** 说话人 / 人格节点:共现里"人人都在场",必须能一键剔除(PLAN_MEMORY_GRAPH.md §6-3)。
 *
 * ★ P3-c(设计 §1.1 第 23 行,总纲五处名单之外的**第六处**):名单**不在代码里**了 ——
 * 现读 `<数据目录>/names.json` 的 `speakers`,与 `lib/memory-read-tools.js:79` 走**同一条路**
 * (`lib/names.js` 是 JS 侧唯一读点)。**空 ⇒ 空集合**(中性,不猜:一份名单都没有时
 * 谁也不当说话人 —— 与 P1b/P1c 的口径一致,不回落旧硬编码)。
 *
 * 放在开库之前:它是**配置**(只读一个 JSON),与库在不在无关 —— 顺带让"名单读没读到"
 * 在"库不存在"这种情况下也看得见(退化不许静默)。 */
const SPEAKERS = loadNames().speakers
if (SPEAKERS.length === 0) {
  console.error('echo: names.json 里没有 speakers(换机/清过数据目录)⇒ 本表按"无说话人"算')
}

// ---- 只读开库 ----
const uri = 'file:' + dbPath.replace(/\\/g, '/') + '?mode=ro'
let db = null
let mtimeBefore = 0
if (!existsSync(dbPath)) {
  console.error('库不存在: ' + dbPath + '(用 --db <path> 或环境变量 ECHO_DB 指定)')
  process.exit(1)
}
try {
  mtimeBefore = statSync(dbPath).mtimeMs
  db = new DatabaseSync(uri, { readOnly: true })
} catch (err) {
  console.error('开库失败(只读):' + uri)
  console.error(String(err && err.message ? err.message : err))
  process.exit(1)
}

const tableExists = (name) => !!db.prepare("select 1 from sqlite_master where type='table' and name = ?").get(name)

const nodes = db.prepare('select node_id, name, node_type, is_protected, coalesce(is_active,1) as is_active from graph_nodes order by node_id').all()
  .map((r) => ({ id: String(r.node_id), name: String(r.name), type: String(r.node_type), isProtected: Number(r.is_protected) === 1, isActive: Number(r.is_active) === 1 }))
const aliases = tableExists('graph_aliases')
  ? db.prepare('select alias, canonical_name from graph_aliases order by alias').all().map((r) => ({ alias: String(r.alias), canonical: String(r.canonical_name) }))
  : []
const edges = db.prepare('select edge_id, source_id, target_id, relation, coalesce(is_active,1) as is_active from graph_edges order by edge_id').all()
  .map((r) => ({ id: Number(r.edge_id), source: String(r.source_id), target: String(r.target_id), relation: String(r.relation), isActive: Number(r.is_active) === 1 }))
const MEM_FILTER = "is_active = 1 AND status = 'active' AND summary IS NOT NULL AND summary <> ''"
const mems = db.prepare('select memory_id, summary, timestamp, coalesce(occurred_at,0) as occurred_at, coalesce(learned_at,0) as learned_at from episodic_memory where ' + MEM_FILTER + ' order by timestamp, memory_id').all()
  .map((r) => ({ id: Number(r.memory_id), summary: String(r.summary), timestamp: Number(r.timestamp), occurredAt: Number(r.occurred_at), learnedAt: Number(r.learned_at) }))
  .filter((m) => !maxMemoryId || m.id <= maxMemoryId)

// ---- 实体识别口径:节点名 → 匹配池(别名归一 = 剔除"名字本身是别名键"的重名节点) ----
const aliasKeys = new Set(aliases.map((a) => a.alias))
const matchers = [] // [needle, canonicalName]
for (const n of nodes) if (!aliasKeys.has(n.name)) matchers.push([n.name, n.name]) // 名字本身是别名键的重名节点:由 canonical 代表,不进匹配池
if (expandAliases) for (const a of aliases) matchers.push([a.alias, a.canonical])

/** 一条记忆里命中的已知节点(canonical 名去重)。 */
function hits (text) {
  const out = new Set()
  for (const [needle, canonical] of matchers) if (text.includes(needle)) out.add(canonical)
  return [...out]
}

// ---- 本地日期(与旧测算同口径:本地时区,不是 UTC) ----
const dayOf = (ts) => {
  const d = new Date(ts * 1000)
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')
}

// ---- 1. 基本盘 ----
const typeDist = new Map()
for (const n of nodes) typeDist.set(n.type, (typeDist.get(n.type) || 0) + 1)
const activeEdges = edges.filter((e) => e.isActive)
const nameById = new Map(nodes.map((n) => [n.id, n.name]))
const nodeIdByName = new Map(nodes.map((n) => [n.name, n.id]))

// ---- 2. 度数分布(活跃边) ----
const deg = new Map()
for (const e of activeEdges) {
  for (const id of [e.source, e.target]) {
    const nm = nameById.get(id) || '(' + id + ')'
    deg.set(nm, (deg.get(nm) || 0) + 1)
  }
}
const degSorted = [...deg].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
const degZero = nodes.map((n) => n.name).filter((n) => !deg.has(n))
const edgesNoSpeaker = activeEdges.filter((e) => !SPEAKERS.includes(nameById.get(e.source) || '') && !SPEAKERS.includes(nameById.get(e.target) || ''))

// ---- 3. 情景记忆 ----
let memGe1 = 0
let memGe2 = 0
const perMemHitCount = new Map()
const memNodes = new Map() // memory_id → Set(canonical 名):结构断言要用它判断"这条记忆能不能为某一条端提供依据"
for (const m of mems) {
  const h = hits(m.summary)
  perMemHitCount.set(m.id, h.length)
  memNodes.set(m.id, new Set(h))
  if (h.length >= 1) memGe1++
  if (h.length >= 2) memGe2++
}

// ---- 4. 共现边候选 ----
const pairKey = (a, b) => (a < b ? a + '\u0000' + b : b + '\u0000' + a)
const push = (map, k, v) => { if (!map.has(k)) map.set(k, []); map.get(k).push(v) }
/** 同记忆:每条记忆内的节点集合两两成对,按"出现在几条记忆里"计数。 */
const sameMem = new Map()
const sameMemIds = new Map() // pairKey → 两条端点**同时出现**的 memory_id(证据)
for (const m of mems) {
  const h = hits(m.summary).sort()
  for (let i = 0; i < h.length; i++) for (let j = i + 1; j < h.length; j++) {
    const k = pairKey(h[i], h[j])
    sameMem.set(k, (sameMem.get(k) || 0) + 1)
    push(sameMemIds, k, m.id)
  }
}
/** 同天:每天取"当天所有记忆的节点并集",日内两两成对,按"共同出现在几天里"计数。 */
const daySets = new Map()
const dayNodeMems = new Map() // day → (nodeName → [memory_id])
for (const m of mems) {
  const d = dayOf(m.timestamp)
  if (!daySets.has(d)) { daySets.set(d, new Set()); dayNodeMems.set(d, new Map()) }
  for (const n of hits(m.summary)) {
    daySets.get(d).add(n)
    push(dayNodeMems.get(d), n, m.id)
  }
}
const sameDay = new Map()
for (const [, set] of daySets) {
  const l = [...set].sort()
  for (let i = 0; i < l.length; i++) for (let j = i + 1; j < l.length; j++) {
    const k = pairKey(l[i], l[j])
    sameDay.set(k, (sameDay.get(k) || 0) + 1)
  }
}
const pairNames = (k) => k.split('\u0000')
const countNoSpeaker = (pairs) => {
  let n = 0
  for (const k of pairs.keys()) { const [a, b] = pairNames(k); if (!SPEAKERS.includes(a) && !SPEAKERS.includes(b)) n++ }
  return n
}
const topPairs = (pairs, n) => [...pairs].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, n)
  .map(([k, c]) => { const [a, b] = pairNames(k); return { a, b, count: c } })

// ---- 5. 时间边候选:按 timestamp 排序后的相邻两条记忆 ----
const temporalEdges = Math.max(0, mems.length - 1)

// ---- 6. 桥节点候选(同天口径的共现度数)+ 从不出现者 ----
const coDeg = new Map()
for (const [k, c] of sameDay) {
  const [a, b] = pairNames(k)
  coDeg.set(a, (coDeg.get(a) || 0) + c)
  coDeg.set(b, (coDeg.get(b) || 0) + c)
}
const coDegSorted = [...coDeg].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
const neverInCooccur = matchers.map((m) => m[1]).filter((v, i, arr) => arr.indexOf(v) === i).filter((n) => !coDeg.has(n)).sort()

// ---- 候选边明细(二期 2a/2b 的输入契约;字段口径见文件头「候选边明细契约(定稿 v1)」) ----
const KIND_ORDER = ['temporal', 'cooccur_same_memory', 'cooccur_same_day']
const memById = new Map(mems.map((m) => [m.id, m]))
/** 证据池里"时间最晚"的那条;needPositiveOccurred=true 时只考虑 occurred_at 非零的。 */
const pickLatest = (ids, needPositiveOccurred) => {
  let pick = null
  for (const id of ids) {
    const m = memById.get(id)
    if (!m) continue
    if (needPositiveOccurred && m.occurredAt <= 0) continue
    if (!pick || m.timestamp > pick.timestamp || (m.timestamp === pick.timestamp && m.id > pick.id)) pick = m
  }
  return pick
}
/**
 * occurred_at 只从 episodic_memory 取。strict:只有 occurred_at 非零才给值;
 * fallback:仍取不到时用"证据里时间最晚那条"的 learned_at 兜底,并如实标来源。
 */
const occurredFor = (ids) => {
  const withOcc = pickLatest(ids, true)
  if (withOcc) return { occurred_at: withOcc.occurredAt, source: 'episodic_memory', sourceId: withOcc.id }
  if (TIME_SOURCE === 'fallback') {
    const any = pickLatest(ids, false)
    if (any && any.learnedAt > 0) return { occurred_at: any.learnedAt, source: 'fallback_learned_at', sourceId: any.id }
  }
  return { occurred_at: null, source: null, sourceId: null }
}
/** 证据裁剪:full 保留全部(超上限裁到最近 N 条),strongest 只留最强(= 时间最晚)那一条。 */
const evidenceFor = (ids, occSourceId, mustCover) => {
  const all = [...new Set(ids)].sort((x, y) => x - y)
  if (EVIDENCE_MODE === 'strongest') {
    const pick = pickLatest(all, true) || pickLatest(all, false)
    return pick ? [pick.id] : []
  }
  if (all.length <= EVIDENCE_CAP) return all
  const byRecency = [...all].sort((x, y) => {
    const mx = memById.get(x)
    const my = memById.get(y)
    return (my ? my.timestamp : 0) - (mx ? mx.timestamp : 0) || y - x
  })
  const kept = byRecency.slice(0, EVIDENCE_CAP)
  // 裁到最近 N 条后要保住的"必须留着"的 id:
  //   ① occurred_at 的来源(同记忆边;这样"来源 ∈ evidence_memory_id"裁剪后也成立)
  //   ② 两端各自的依据(同天边;这样"每端至少 1 条依据"裁剪后也成立)
  const must = [occSourceId, ...(mustCover || [])].filter((x) => x !== null && x !== undefined)
  for (const id of must) {
    if (kept.includes(id)) continue
    kept.pop() // 丢掉保留段里最旧的一条
    kept.push(id)
  }
  return kept.sort((x, y) => x - y)
}
/** 端点解析:canonical 名 → node_id;解析不到就是 alias-canonical 在 graph_nodes 里不存在,不硬造。 */
const resolveNode = (name) => {
  const id = nodeIdByName.get(name)
  return id === undefined ? { id: null, bad: true } : { id, bad: false }
}
/** 本地日期字符串 → 当天 00:00 的 epoch 秒(时区 = 机器本地 = Asia/Shanghai,与分组同口径)。 */
const dayMidnight = (day) => {
  const [y, m, d] = day.split('-').map(Number)
  return Math.floor(new Date(y, m - 1, d, 0, 0, 0, 0).getTime() / 1000)
}
// built 里带上 a/b(成对的两个 canonical 名)供结构断言用;落进 edgeRows 的只有契约字段
const built = []
// (1) 时间边:相邻两条记忆。两端都是 memory(裸 memory_id),R1 不适用 ⇒ speaker_node_excluded 恒 false
for (let i = 0; i + 1 < mems.length; i++) {
  const a = mems[i]
  const b = mems[i + 1]
  const occ = occurredFor([a.id, b.id])
  const reasons = []
  if (occ.occurred_at === null) reasons.push('no-occurred-at')
  built.push({
    a: null,
    b: null,
    fullLen: 2,
    row: {
      kind: 'temporal',
      source_kind: 'memory',
      target_kind: 'memory',
      endpoint_kind: 'memory',
      source_id: String(a.id),
      target_id: String(b.id),
      day: null, // 时间边不是日粒度,没有 day
      evidence_memory_id: [a.id, b.id], // 时间边的证据恒为两端(端点本身即依据)
      evidence_truncated: false, // 时间边不裁剪、不套 evidence-mode
      speaker_node_excluded: false,
      weight: 1,
      count: 1,
      occurred_at: occ.occurred_at,
      occurred_at_source: occ.source,
      skipped_reason: reasons.length ? reasons.join(',') : null
    }
  })
}
// (2) 同记忆共现边:端点 = 两个概念节点的 node_id;证据 = 两条端点同时出现的记忆(全量,超上限裁最近 N 条)
for (const [k, count] of sameMem) {
  const [a, b] = pairNames(k)
  const full = [...new Set(sameMemIds.get(k) || [])].sort((x, y) => x - y)
  const occ = occurredFor(full)
  const evidence = evidenceFor(full, occ.sourceId)
  const ra = resolveNode(a)
  const rb = resolveNode(b)
  const reasons = []
  if (SPEAKERS.includes(a) || SPEAKERS.includes(b)) reasons.push('speaker-node')
  if (ra.bad || rb.bad) reasons.push('alias-missing-canonical')
  if (occ.occurred_at === null) reasons.push('no-occurred-at')
  built.push({
    a,
    b,
    fullLen: full.length,
    row: {
      kind: 'cooccur_same_memory',
      source_kind: 'node',
      target_kind: 'node',
      endpoint_kind: 'node',
      source_id: ra.id,
      target_id: rb.id,
      day: null,
      evidence_memory_id: evidence,
      evidence_truncated: evidence.length < full.length,
      speaker_node_excluded: SPEAKERS.includes(a) || SPEAKERS.includes(b),
      weight: count,
      count,
      occurred_at: occ.occurred_at,
      occurred_at_source: occ.source,
      skipped_reason: reasons.length ? reasons.join(',') : null
    }
  })
}
// (3) 同天共现边:日粒度的边 ⇒ 时间锚就是"那一天"(occurred_at = 当天本地 00:00,来源 same_day_group);
//     证据 = 能支撑两端的一小组(每个命中日:提到 A 的最晚一条 + 提到 B 的最晚一条),超上限裁最近 N 条
for (const [k, count] of sameDay) {
  const [a, b] = pairNames(k)
  const days = []
  const full = new Set()
  const coverA = []
  const coverB = []
  for (const [day, set] of daySets) {
    if (!set.has(a) || !set.has(b)) continue
    days.push(day)
    const per = dayNodeMems.get(day)
    const la = pickLatest(per.get(a) || [], false)
    const lb = pickLatest(per.get(b) || [], false)
    if (la) { full.add(la.id); coverA.push(la.id) }
    if (lb) { full.add(lb.id); coverB.push(lb.id) }
  }
  days.sort()
  const fullList = [...full].sort((x, y) => x - y)
  // 两端各留一条"必须存在"的依据:取各自最晚的那条(裁剪时会被保住)
  const mustA = pickLatest(coverA, false)
  const mustB = pickLatest(coverB, false)
  const evidence = evidenceFor(fullList, null, [mustA ? mustA.id : null, mustB ? mustB.id : null])
  const anchorDay = days.length ? days[days.length - 1] : null // count>1 时取最近那天当锚
  const ra = resolveNode(a)
  const rb = resolveNode(b)
  const reasons = []
  if (SPEAKERS.includes(a) || SPEAKERS.includes(b)) reasons.push('speaker-node')
  if (ra.bad || rb.bad) reasons.push('alias-missing-canonical')
  // 同天边的时间来自"日"本身 ⇒ 不存在取不到的情况,不再有 no-occurred-at
  built.push({
    a,
    b,
    fullLen: fullList.length,
    row: {
      kind: 'cooccur_same_day',
      source_kind: 'node',
      target_kind: 'node',
      endpoint_kind: 'node',
      source_id: ra.id,
      target_id: rb.id,
      day: anchorDay,
      evidence_memory_id: evidence,
      evidence_truncated: evidence.length < fullList.length,
      speaker_node_excluded: SPEAKERS.includes(a) || SPEAKERS.includes(b),
      weight: count,
      count,
      occurred_at: anchorDay === null ? null : dayMidnight(anchorDay),
      occurred_at_source: anchorDay === null ? null : 'same_day_group',
      skipped_reason: reasons.length ? reasons.join(',') : null
    }
  })
}
// 行序稳定(便于 diff):temporal → same_memory → same_day,组内按 (-count, id)
built.sort((x, y) => {
  const dk = KIND_ORDER.indexOf(x.row.kind) - KIND_ORDER.indexOf(y.row.kind)
  if (dk !== 0) return dk
  if (x.row.kind !== 'temporal') {
    if (y.row.count !== x.row.count) return y.row.count - x.row.count
    const kx = String(x.row.source_id) + '|' + String(x.row.target_id)
    const ky = String(y.row.source_id) + '|' + String(y.row.target_id)
    if (kx !== ky) return kx < ky ? -1 : 1
  }
  return Number(x.row.source_id) - Number(y.row.source_id) || Number(y.row.target_id) - Number(x.row.target_id)
})
const edgeRows = built.map((x) => x.row)
/** 每行字段集合必须一致(契约 15 个字段,定稿 v1.1 起多一个 day):列出来给报表自检用。 */
const EDGE_FIELDS = ['kind', 'source_kind', 'target_kind', 'endpoint_kind', 'source_id', 'target_id', 'day', 'evidence_memory_id', 'evidence_truncated', 'speaker_node_excluded', 'weight', 'count', 'occurred_at', 'occurred_at_source', 'skipped_reason']
const fieldMismatch = edgeRows.filter((e) => Object.keys(e).length !== EDGE_FIELDS.length || EDGE_FIELDS.some((f) => !(f in e))).length
// 新结构断言(替代旧的"count === |evidence|"):证据非空,且每个 id 都能为该边的至少一端提供依据
const evidenceEmpty = built.filter((x) => x.row.evidence_memory_id.length === 0).length
const evidenceUnsupporting = built.filter((x) => {
  if (x.row.kind === 'temporal') return false // 时间边的证据就是两个端点本身
  return x.row.evidence_memory_id.some((id) => {
    const set = memNodes.get(Number(id))
    return !set || (!set.has(x.a) && !set.has(x.b))
  })
}).length
// 额外一层(同天边专属):裁剪后两端是否仍各 ≥1 条依据
const sameDayCoverLost = built.filter((x) => {
  if (x.row.kind !== 'cooccur_same_day') return false
  const sets = x.row.evidence_memory_id.map((id) => memNodes.get(Number(id)))
  return !sets.some((s) => s && s.has(x.a)) || !sets.some((s) => s && s.has(x.b))
}).length
// count 语义按 kind 不同 ⇒ 只校验取值范围(时间边 1;共现 = 记忆条数/天数,必须 ≥1)
const countBad = edgeRows.filter((e) => (e.kind === 'temporal' ? e.count !== 1 : !(e.count >= 1))).length
const truncMismatch = built.filter((x) => x.row.kind !== 'temporal' && x.row.evidence_truncated !== (x.row.evidence_memory_id.length < x.fullLen)).length
const edgeStats = {
  memoryMaxId: maxMemoryId || null,
  memoryPinnedByDefault: pinnedByDefault,
  defaultMaxMemoryId: EDGES_JSON_DEFAULT_MAX_MEMORY_ID,
  timeSource: TIME_SOURCE,
  evidenceMode: EVIDENCE_MODE,
  evidenceCap: EVIDENCE_CAP,
  fields: EDGE_FIELDS,
  fieldMismatch,
  evidenceEmpty,
  evidenceUnsupporting,
  sameDayCoverLost,
  countBad,
  evidenceTruncationMismatch: truncMismatch,
  total: edgeRows.length,
  kinds: Object.fromEntries(KIND_ORDER.map((kind) => {
    const rows = edgeRows.filter((e) => e.kind === kind)
    const src = (v) => rows.filter((e) => e.occurred_at_source === v).length
    return [kind, {
      total: rows.length,
      speakerNodeExcluded: rows.filter((e) => e.speaker_node_excluded).length,
      noOccurredAt: rows.filter((e) => e.occurred_at === null).length,
      aliasMissingCanonical: rows.filter((e) => String(e.skipped_reason || '').includes('alias-missing-canonical')).length,
      evidenceTruncated: rows.filter((e) => e.evidence_truncated).length,
      occurredAtSource: { episodic_memory: src('episodic_memory'), fallback_learned_at: src('fallback_learned_at'), same_day_group: src('same_day_group'), null: src(null) }
    }]
  }))
}

const mtimeAfter = statSync(dbPath).mtimeMs
db.close()

// ---- 导出候选边明细(NDJSON):默认不写任何东西,只有给了 --edges-json 才写 ----
let edgesWritten = 0
if (edgesJsonTarget) {
  const body = edgeRows.map((e) => JSON.stringify(e)).join('\n') + (edgeRows.length ? '\n' : '')
  if (edgesJsonTarget === '-') {
    process.stdout.write(body) // 人读报表此时走 stderr(见末尾)
  } else {
    writeFileSync(edgesJsonTarget, body, 'utf8') // UTF-8 无 BOM;目标请放仓库外或 .scratch/
  }
  edgesWritten = edgeRows.length
}

// ---- 结构化结果 ----
const result = {
  db: { path: dbPath, uri, readOnly: true, mtimeBefore, mtimeAfter, mtimeUnchanged: mtimeBefore === mtimeAfter, localTimezone: Intl.DateTimeFormat().resolvedOptions().timeZone, memoryFilter: MEM_FILTER, maxMemoryId: maxMemoryId || null, pairWindow: 'same-memory: 记忆内两两; same-day: 本地日期日内节点并集两两', aliasMode: expandAliases ? 'expand (summary 内别名串展开为 canonical)' : 'normalize (仅剔除名字本身是别名键的重名节点;不展开)', speakers: SPEAKERS },
  graph: {
    nodes: nodes.length,
    nodeTypes: [...typeDist].sort((a, b) => b[1] - a[1]),
    protectedNodes: nodes.filter((n) => n.isProtected).length,
    inactiveNodes: nodes.filter((n) => !n.isActive).length,
    edges: edges.length,
    activeEdges: activeEdges.length,
    activeEdgesWithoutSpeakerEndpoints: edgesNoSpeaker.length,
    degreeTop: degSorted.slice(0, 12).map(([name, d]) => ({ name, degree: d })),
    degreeZero: degZero
  },
  episodic: { active: mems.length, withAtLeast1Node: memGe1, withAtLeast2Nodes: memGe2 },
  cooccur: {
    sameMemory: { pairs: sameMem.size, pairsWithoutSpeakers: countNoSpeaker(sameMem), top: topPairs(sameMem, 15) },
    sameDay: { pairs: sameDay.size, pairsWithoutSpeakers: countNoSpeaker(sameDay), top: topPairs(sameDay, 15), days: daySets.size }
  },
  temporal: { candidates: temporalEdges, firstMemoryId: mems.length ? mems[0].id : null, lastMemoryId: mems.length ? mems[mems.length - 1].id : null },
  bridge: { cooccurDegreeTop: coDegSorted.slice(0, 15).map(([name, d]) => ({ name, degree: d })), neverInAnySameDayCooccurrence: neverInCooccur },
  entityMatch: { poolSize: matchers.length, matchers: matchers.map(([needle, canonical]) => ({ needle, canonical })), aliasMap: aliases, aliasKeysDroppedNodes: nodes.filter((n) => aliasKeys.has(n.name)).map((n) => n.name) },
  edgeCandidates: edgeStats // 明细本身在 NDJSON 里(--edges-json);这里只放统计,免得 --json 输出被 340 行边灌爆
}

// ---- 人类可读报表 ----
if (!asJson) {
  const L = []
  const say = (s = '') => L.push(s)
  const pad = (s, n) => String(s) + ' '.repeat(Math.max(0, n - [...String(s)].reduce((w, c) => w + (c.charCodeAt(0) > 0x2e80 ? 2 : 1), 0)))
  const table = (rows, headers) => {
    const widths = headers.map((h, i) => Math.max(...[h, ...rows.map((r) => String(r[i]))].map((s) => [...String(s)].reduce((w, c) => w + (c.charCodeAt(0) > 0x2e80 ? 2 : 1), 0))))
    say('  ' + headers.map((h, i) => pad(h, widths[i])).join('  '))
    for (const r of rows) say('  ' + r.map((c, i) => pad(c, widths[i])).join('  '))
  }
  say('白送路网基线(只读测算 —— 时间相邻 + 共现统计)')
  say('='.repeat(66))
  say('库: ' + dbPath)
  say('只读 URI: ' + uri + '(readOnly: true)')
  say('时区: ' + result.db.localTimezone + '(同天分组用本地日期)')
  say('记忆过滤: ' + MEM_FILTER + (maxMemoryId ? '  + memory_id <= ' + maxMemoryId : ''))
  say('别名口径: ' + result.entityMatch.matchers.length + ' 个匹配串,模式=' + (expandAliases ? '展开(expand-aliases)' : '归一(默认)'))
  say()
  say('[1] 基本盘')
  table([['graph_nodes 总数', nodes.length], ['node_type 分布', result.graph.nodeTypes.map(([t, c]) => t + '=' + c).join(' / ')], ['is_protected=1', result.graph.protectedNodes], ['is_active=0 节点', result.graph.inactiveNodes], ['graph_edges 总数', edges.length], ['活跃边 coalesce(is_active,1)=1', activeEdges.length]], ['项', '值'])
  say()
  say('[2] 度数分布(活跃边,按端点计数)')
  table(result.graph.degreeTop.map((d) => [d.name, d.degree]), ['节点', '度'])
  say('  度为 0 的节点(' + degZero.length + '):' + (degZero.length ? degZero.join('、') : '无'))
  say('  不含说话人节点的活跃边数: ' + edgesNoSpeaker.length + '  (说话人=' + SPEAKERS.join('/') + ')')
  say()
  say('[3] 情景记忆')
  table([['活跃条数(见上过滤)', mems.length], ['提到 >=1 个已知节点名', memGe1], ['提到 >=2 个已知节点名', memGe2]], ['项', '条数'])
  say()
  say('[4] 共现边候选')
  table([
    ['同记忆 无序对', sameMem.size, countNoSpeaker(sameMem)],
    ['同天   无序对', sameDay.size, countNoSpeaker(sameDay)]
  ], ['口径', '对数', '去说话人后'])
  say('  同记忆 共现对 top 15:')
  table(topPairs(sameMem, 15).map((p) => [p.a + ' – ' + p.b, p.count]), ['对', '次数'])
  say('  同天 共现对 top 15:')
  table(topPairs(sameDay, 15).map((p) => [p.a + ' – ' + p.b, p.count]), ['对', '次数'])
  say('  同天分组天数: ' + daySets.size)
  say()
  say('[5] 时间边候选')
  say('  相邻记忆边数 = 活跃条数 - 1 = ' + temporalEdges + '(记忆 #' + result.temporal.firstMemoryId + ' … #' + result.temporal.lastMemoryId + ',按 timestamp 排序)')
  say()
  say('[6] 桥节点候选')
  say('  共现度数(同天口径)top 15:')
  table(coDegSorted.slice(0, 15).map(([name, degree]) => [name, degree]), ['节点', '共现度数'])
  say('  在任何共现里都不出现的节点(同天口径,' + neverInCooccur.length + ' 个):' + neverInCooccur.join('、'))
  say()
  say('[7] 实体识别口径')
  say('  口径 = 用现有 graph_nodes 的名字在 summary 里做朴素子串匹配;先过 graph_aliases 归一')
  say('    · 归一动作:名字本身是别名键的重名节点从匹配池剔除 → ' + (result.entityMatch.aliasKeysDroppedNodes.join('、') || '无'))
  say('    · ' + (expandAliases ? '本次为展开口径:summary 里的别名串也计入 canonical(非旧测算口径)' : '本次为默认口径:不把 summary 里的别名串展开(与旧测算一致)'))
  say('  别名映射(alias -> canonical,' + aliases.length + ' 条):')
  if (aliases.length) table(aliases.map((a) => [a.alias, a.canonical]), ['alias', 'canonical'])
  else say('    (无 graph_aliases 表或表为空)')
  say('  匹配池(' + matchers.length + ' 串):' + result.entityMatch.matchers.map((m) => m.needle === m.canonical ? m.needle : m.needle + '→' + m.canonical).join('、'))
  say()
  say('[8] 候选边明细(二期 2a/2b 的验收基线)')
  say('  记忆口径: ' + (edgeStats.memoryMaxId ? 'memory_id <= ' + edgeStats.memoryMaxId : '不设上限(live)')
    + (edgeStats.memoryPinnedByDefault ? '(未显式指定,已按 --edges-json 的默认值 ' + edgeStats.defaultMaxMemoryId + ' 钉住)' : ''))
  say('  开关: --time-source ' + edgeStats.timeSource + ' / --evidence-mode ' + edgeStats.evidenceMode + ' / --evidence-cap ' + edgeStats.evidenceCap)
  table(KIND_ORDER.map((kind) => {
    const s = edgeStats.kinds[kind]
    return [kind, s.total, s.speakerNodeExcluded, s.noOccurredAt, s.aliasMissingCanonical, s.evidenceTruncated]
  }), ['kind', '条数', 'R1 排除(speaker-node)', 'no-occurred-at', 'alias-missing-canonical', 'evidence 裁剪'])
  say('  occurred_at 来源:')
  table(KIND_ORDER.map((kind) => {
    const s = edgeStats.kinds[kind].occurredAtSource
    return [kind, s.episodic_memory, s.fallback_learned_at, s.same_day_group, s.null]
  }), ['kind', 'episodic_memory', 'fallback_learned_at', 'same_day_group', 'null'])
  say('  三条合计: ' + edgeStats.total + ' 条候选边;R1 排除 '
    + KIND_ORDER.reduce((n, k) => n + edgeStats.kinds[k].speakerNodeExcluded, 0) + ' 条;因 no-occurred-at 跳过 '
    + KIND_ORDER.reduce((n, k) => n + edgeStats.kinds[k].noOccurredAt, 0) + ' 条;'
    + (edgeStats.timeSource === 'fallback' ? 'fallback 兜底 ' + KIND_ORDER.reduce((n, k) => n + edgeStats.kinds[k].occurredAtSource.fallback_learned_at, 0) + ' 条' : '未启用兜底(strict)'))
  say('  结构断言: 字段集合不一致 ' + edgeStats.fieldMismatch + ' 条;证据为空 ' + edgeStats.evidenceEmpty + ' 条;'
    + '证据 id 无法为任何一端提供依据 ' + edgeStats.evidenceUnsupporting + ' 条(时间边只看端点自身);'
    + '同天边裁剪后丢掉某一端依据 ' + edgeStats.sameDayCoverLost + ' 条;count 取值越界 ' + edgeStats.countBad + ' 条;'
    + 'evidence_truncated 与实际裁剪不符 ' + edgeStats.evidenceTruncationMismatch + ' 条')
  say('  被 R1 排除的边仍**照常导出**,只置 speaker_node_excluded=true(可审计"排除了多少",不丢数据)')
  if (edgesJsonTarget === '-') say('  明细已打到 stdout: ' + edgesWritten + ' 行 NDJSON(本报表因此改走 stderr)')
  else if (edgesJsonTarget) say('  明细已导出: ' + edgesWritten + ' 行 NDJSON → ' + edgesJsonTarget)
  else say('  明细未导出(要它请加 --edges-json <path|->;默认不写任何东西)')
  say()
  say('库文件 mtime: 前=' + mtimeBefore + ' 后=' + mtimeAfter + (mtimeBefore === mtimeAfter ? ' (未变)' : ' (!! 变了)'))
  say('本报表只读,未修改任何数据')
  const emit = edgesJsonTarget === '-' ? console.error : console.log // 明细占了 stdout 时,报表让路到 stderr
  emit(L.join('\n'))
} else {
  console.log(JSON.stringify(result, null, 2))
}
