#!/usr/bin/env node
/**
 * 记忆搬家:AstrBot 活库 → ~/.dsh/echo/echo.db(一次性,M1-d)
 * ============================================================
 * 用法:
 *   node scripts/import-astrbot.mjs            # 导入(目标已有记忆时拒绝)
 *   node scripts/import-astrbot.mjs --fresh    # 推平 echo.db 重新导入
 *   node scripts/import-astrbot.mjs --dry-run  # 只统计不写入
 *   node scripts/import-astrbot.mjs --src <path>  # 指定源库(默认 AstrBot 活库)
 *
 * 原则:
 *   - 源库只读(readOnly 打开),QQ 侧 v8.10.0 冻结不动
 *   - DMAE 状态原样搬运(half_life/recall_count/last_recalled/intrinsic_value):
 *     她的记忆带着"磨损程度"搬家 —— 哪些快忘了、哪些常想起,都是历史
 *   - 只搬主人的记忆(is_master=1):DSH 的她只有一个<称呼>
 *   - agent_state 取最近更新的一行 → 'global':她带着搬家那一刻的心情抵达
 *   - source 改写为 'qq':注入时渲染"(在QQ听说的事)",场合不串线
 */
import { DatabaseSync } from 'node:sqlite'
import { existsSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { openStore, MASTER_ID } from '../lib/store.js'

const args = new Set(process.argv.slice(2))
const DEFAULT_SRC = join(homedir(), '.astrbot', 'data', 'plugin_data', 'astrbot_plugin_memory_middleware', 'memory.db')
const srcPath = (() => {
  const i = process.argv.indexOf('--src')
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : DEFAULT_SRC
})()
const dbPath = process.env.ECHO_DB ?? join(homedir(), '.dsh', 'echo', 'echo.db')

if (!existsSync(srcPath)) {
  console.error('源库不存在: ' + srcPath)
  process.exit(1)
}

const src = new DatabaseSync(srcPath, { readOnly: true })
console.log('源库(只读): ' + srcPath)

// ---- 统计源 ----
const count = (sql, ...args2) => {
  try { return Number(src.prepare(sql).get(...args2)?.n) || 0 } catch { return 0 }
}
const srcEpisodic = count('SELECT COUNT(*) AS n FROM episodic_memory WHERE is_master = 1')
const srcAll = count('SELECT COUNT(*) AS n FROM episodic_memory')
const srcNodes = count('SELECT COUNT(*) AS n FROM graph_nodes')
const srcEdges = count('SELECT COUNT(*) AS n FROM graph_edges')
const srcLonging = count('SELECT COUNT(*) AS n FROM longing_state')
const srcAgenda = count('SELECT COUNT(*) AS n FROM her_agenda WHERE is_active = 1')
console.log(`源统计: 主人记忆 ${srcEpisodic}/${srcAll} 条 | 图谱 ${srcNodes} 节点 ${srcEdges} 边 | 想念 ${srcLonging} 行 | 议程 ${srcAgenda} 条`)

if (args.has('--dry-run')) {
  src.close()
  process.exit(0)
}

// ---- 目标 ----
if (args.has('--fresh')) {
  for (const suffix of ['', '-wal', '-shm']) {
    try { rmSync(dbPath + suffix, { force: true }) } catch { /* 无妨 */ }
  }
  console.log('--fresh: 已清空目标库 ' + dbPath)
}
const store = openStore(dbPath)
const existing = store.memoryStats().episodicTotal
if (existing > 0 && !args.has('--fresh')) {
  console.error(`目标库已有 ${existing} 条记忆 —— 重复导入会叠加。要重导请用 --fresh(会清空 echo.db)。`)
  store.close()
  src.close()
  process.exit(1)
}

// ---- 1. 情景记忆(主人):DMAE 状态与三种时间原样搬 ----
let n = 0
{
  const rows = src.prepare('SELECT * FROM episodic_memory WHERE is_master = 1').all()
  const ins = store.db.prepare(
    'INSERT INTO episodic_memory (user_id, keywords, summary, emotion_score, timestamp, is_active,' +
    ' source, source_label, actor, speaker_id, is_master, intrinsic_value, half_life, recall_count,' +
    ' last_recalled, occurred_at, learned_at, temporal_status, memory_key, superseded_by, layer, evidence,' +
    // 2026-10-12:类型两列。**AstrBot 老数据没有类型信息**(它不经 Judge 的
    // field/stability)⇒ 一律落空串,与老行同形。不猜。
    ' memory_type, memory_stability)' +
    " VALUES (?, ?, ?, ?, ?, ?, 'qq', ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', '')"
  )
  // 2026-09-27 F1:`superseded_by` 必须**重映射**,不许原样照抄。
  // 现场 bug:A 侧 id 到了 445,迁移只搬 256 行;照抄过来的引用全部指向空气。
  // 实测 16 行悬空(日期全在 09-18~09-21,正是这批迁移),后果是那些 L0 记忆
  // 被标了「被 #431 取代」而 #431 谁都不知道是什么 —— 事实等于被无声抹掉。
  // 两趟:先全插(引用先留 0)+ 记 old→new 映射;插完再按映射回填,
  // 映射不到的(源不是 is_master=1、没被搬过来)就保持 0,绝不编造引用。
  const idMap = new Map()
  const pendingRefs = []
  for (const r of rows) {
    const info = ins.run(
      MASTER_ID,
      String(r.keywords ?? '[]'),
      String(r.summary ?? ''),
      Math.round(Number(r.emotion_score) || 0),
      Number(r.timestamp) || 0,
      Number.isFinite(Number(r.is_active)) ? Number(r.is_active) : 1,
      String(r.source_label ?? ''),
      String(r.actor ?? ''),
      String(r.speaker_id ?? ''),
      Number(r.intrinsic_value) || 0,
      Number(r.half_life) || 0,
      Math.round(Number(r.recall_count) || 0),
      Number(r.last_recalled) || 0,
      Number(r.occurred_at) || 0,
      Number(r.learned_at) || 0,
      String(r.temporal_status ?? 'time_unknown'),
      String(r.memory_key ?? ''),
      0, // ← 引用先留 0,第二趟按映射回填
      String(r.layer ?? ''),
      String(r.evidence ?? '')
    )
    const oldId = Number(r.memory_id)
    const newId = Number(info.lastInsertRowid)
    if (Number.isFinite(oldId)) idMap.set(oldId, newId)
    const oldRef = Math.round(Number(r.superseded_by) || 0)
    if (oldRef > 0) pendingRefs.push([newId, oldRef])
    n++
  }
  const remap = store.db.prepare('UPDATE episodic_memory SET superseded_by = ? WHERE memory_id = ?')
  let remapped = 0
  let dropped = 0
  for (const [newId, oldRef] of pendingRefs) {
    const target = idMap.get(oldRef)
    if (target === undefined) { dropped += 1; continue } // 目标没搬过来 ⇒ 保持 0
    remap.run(target, newId)
    remapped += 1
  }
  if (remapped || dropped) {
    console.log('  superseded_by 重映射: ' + remapped + ' 条,丢弃(目标未搬)' + dropped + ' 条')
  }
}
console.log('情景记忆: ' + n + ' 条(source=qq)')

// ---- 1b. 老库回填(v0.15.1 G20;A `core/echo_schema.py:277-301`)----
// 为什么放在**导入器**而不是 db.connect:这条回填的前提是「空 layer = 老行」,
// 而 DSH 的 JS 基线写记忆时会留空 layer(insertMemory 的 layer 参数默认 ''),
// 所以在 connect 上常开会让**新写的**高 I 记忆被误升 L0 —— L0 是每轮强制
// 注入的核心记忆,那就等于把一条普通碎片抬成「她永远记得的事」
// (实测:一条 I=80 的降级记忆被抬成 L0 后,任何检索都会带上它)。
// A 那边这条回填是**一次性老库迁移**,导入器正是 DSH 里"老库"这件事发生
// 的地方 —— 范围用 source='qq' 圈定,只碰这一次搬进来的行。
//   * learned_at 空 → 用 timestamp 补(timestamp 就是写入时间 = 得知时间,
//     从不被改写,所以它是可信的);**不回填 occurred_at** —— 「事情何时
//     发生」旧数据真的不知道,必须留 0 并保持 time_unknown。
//   * layer 空且 I ≥ 50 → 判 L0(compute_intrinsic_value 的 Tier 是乘性的,
//     L1 上限 = 100×0.45 = 45,所以 I ≥ 50 不可能是 L1/L2)。
{
  const learned = store.db.prepare(
    "UPDATE episodic_memory SET learned_at = timestamp" +
    " WHERE source = 'qq' AND (learned_at IS NULL OR learned_at = 0) AND timestamp > 0"
  ).run()
  const layered = store.db.prepare(
    "UPDATE episodic_memory SET layer = 'L0'" +
    " WHERE source = 'qq' AND (layer IS NULL OR layer = '') AND intrinsic_value >= 50"
  ).run()
  console.log('老库回填: learned_at ' + String(learned.changes) + ' 行,layer→L0 '
    + String(layered.changes) + ' 行(仅限本次导入的行)')
}

// ---- 2. 认知状态:最近一行 → global(她带着那一刻的心情抵达) ----
{
  const r = src.prepare('SELECT * FROM agent_state ORDER BY updated_at DESC LIMIT 1').get()
  if (r !== undefined) {
    store.saveState({
      moodIntensity: Number(r.mood_intensity) || 3,
      prevMoodIntensity: Number(r.prev_mood_intensity) || 3,
      userEmotion: String(r.user_emotion ?? 'neutral'),
      moodReason: String(r.mood_reason ?? ''),
      currentTopic: String(r.current_topic ?? ''),
      emotionVector: safeJson(r.emotion_vector),
      previousEmotionVector: safeJson(r.previous_emotion_vector)
    })
    console.log('认知状态: mood=' + (Number(r.mood_intensity) || 3) + ' → global')
  } else {
    console.log('认知状态: 源库无行,保持默认')
  }
}

// ---- 3. 称呼(user_profile) ----
{
  const r = src.prepare('SELECT * FROM user_profile ORDER BY last_updated DESC LIMIT 1').get()
  const name = r?.name ? String(r.name).trim() : ''
  if (name) {
    store.setName(name)
    console.log('称呼: ' + name)
  } else {
    console.log('称呼: 源库为空,跳过')
  }
}

// ---- 4. 想念值(M2 消费,先落位) ----
{
  const r = src.prepare('SELECT * FROM longing_state LIMIT 1').get()
  if (r !== undefined) {
    store.db.prepare(
      'INSERT OR REPLACE INTO longing_state (user_id, value, anchor_at, updated_at, kicked,' +
      ' last_user_msg_at, last_care_at, care_count, session_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(
      MASTER_ID,
      Number(r.value) || 0, Number(r.anchor_at) || 0, Number(r.updated_at) || 0,
      Math.round(Number(r.kicked) || 0), Number(r.last_user_msg_at) || 0,
      Number(r.last_care_at) || 0, Math.round(Number(r.care_count) || 0),
      String(r.session_id ?? '')
    )
    console.log('想念值: ' + (Number(r.value) || 0).toFixed(2) + '(M2 接曲线)')
  }
}

// ---- 5. 图谱(M2 接 BFS,数据先到家) ----
{
  let nn = 0
  const nodes = src.prepare('SELECT * FROM graph_nodes').all()
  const insN = store.db.prepare(
    'INSERT OR REPLACE INTO graph_nodes (node_id, name, node_type, is_protected, properties,' +
    ' last_accessed, activation, user_silence, model_silence, intrinsic_value, half_life,' +
    ' recall_count, occurred_at, learned_at, temporal_status, owner_key)' +
    ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  )
  for (const r of nodes) {
    insN.run(
      String(r.node_id), String(r.name), String(r.node_type ?? 'concept'),
      Math.round(Number(r.is_protected) || 0), String(r.properties ?? '{}'),
      Number(r.last_accessed) || 0, Number(r.activation) || 0,
      Math.round(Number(r.user_silence) || 0), Math.round(Number(r.model_silence) || 0),
      Number(r.intrinsic_value) || 10, Number(r.half_life) || 0,
      Math.round(Number(r.recall_count) || 0), Number(r.occurred_at) || 0,
      Number(r.learned_at) || 0, String(r.temporal_status ?? 'time_unknown'),
      MASTER_ID
    )
    nn++
  }
  let ne = 0
  const edges = src.prepare('SELECT * FROM graph_edges').all()
  const insE = store.db.prepare(
    'INSERT OR REPLACE INTO graph_edges (source_id, target_id, relation, weight, last_accessed,' +
    ' owner_key, half_life, recall_count, occurred_at, learned_at, temporal_status)' +
    ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  )
  for (const r of edges) {
    insE.run(
      String(r.source_id), String(r.target_id), String(r.relation ?? '相关'),
      Number(r.weight) || 1, Number(r.last_accessed) || 0,
      MASTER_ID, Number(r.half_life) || 0, Math.round(Number(r.recall_count) || 0),
      Number(r.occurred_at) || 0, Number(r.learned_at) || 0,
      String(r.temporal_status ?? 'time_unknown')
    )
    ne++
  }
  console.log('图谱: ' + nn + ' 节点 ' + ne + ' 边(owner=master)')
}

// ---- 6. 反思游标 + 议程(M2 燃料) ----
{
  store.db.prepare(
    "INSERT OR REPLACE INTO reflection_state (user_id, last_memory_id, last_at) VALUES (?, 0, 0)"
  ).run(MASTER_ID)
  let na = 0
  try {
    const rows = src.prepare('SELECT * FROM her_agenda WHERE is_active = 1').all()
    const ins = store.db.prepare(
      'INSERT INTO her_agenda (content, origin, source_ids, weight, created_at, last_used_at, is_active)' +
      " VALUES (?, ?, ?, ?, ?, 0, 1)"
    )
    for (const r of rows) {
      ins.run(String(r.content ?? ''), String(r.origin ?? 'persona'), String(r.source_ids ?? ''),
        Number(r.weight) || 1, Number(r.created_at) || Date.now() / 1000)
      na++
    }
  } catch { /* 源库无表 */ }
  console.log('议程: ' + na + ' 条(M2 消费)')
}

const stats = store.memoryStats()
console.log('---')
console.log(`搬家完成: echo.db 现有情景记忆 ${stats.episodicActive}/${stats.episodicTotal} 条(L0 ${stats.l0} 条)` +
  `,图谱 ${stats.graphNodes}n/${stats.graphEdges}e,心情 ${stats.moodIntensity}/10`)
store.close()
src.close()

function safeJson (raw) {
  try {
    const v = JSON.parse(String(raw || '{}'))
    return (v && typeof v === 'object' && !Array.isArray(v)) ? v : {}
  } catch { return {} }
}
