/**
 * v0.3.0 「仪表盘」:store 六个查询方法的语义测试。
 * 对账基准 = AstrBot audit/echo_audit_dashboard.py 的 API 层
 * (threads 四态机 / longing 复刻公式 / graph 类型推断 / DMAE 三态)。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { openStore, MASTER_ID } from '../lib/store.js'

const NOW = () => Date.now() / 1000

function freshStore () {
  const store = openStore(':memory:')
  store.db.prepare("INSERT INTO user_profile (user_id, name) VALUES (?, '阿岚')").run(MASTER_ID)
  return store
}

test('仪表盘:审计流写入→读回,JSON 字段已解析', () => {
  const store = freshStore()
  try {
    store.writeAudit({
      traceId: 't1', sessionId: 'global', userInput: '还记得面试吗',
      injectedMemories: '[]', agentState: '{}', llmReply: '当然记得',
      moodIntensity: 4, prevMoodIntensity: 3, emotionVector: { affection: 8 }, toolCall: ''
    })
    const rows = store.listAudit(0, 10)
    assert.equal(rows.length, 1)
    assert.equal(rows[0].userInput, '还记得面试吗')
    assert.deepEqual(rows[0].emotionVector, { affection: 8 })
    // since 过滤:只取更新的
    const later = store.listAudit(rows[0].timestamp, 10)
    assert.equal(later.length, 0)
  } finally { store.close() }
})

test('仪表盘:悬置话题四态机(AstrBot v8.5.7 语义逐字对齐)', () => {
  const store = freshStore()
  try {
    const now = NOW()
    const ins = store.db.prepare(
      'INSERT INTO pending_threads (user_id, content, status, follow_up_after, last_mentioned_at, created_at, updated_at)' +
      " VALUES (?, ?, 'open', ?, ?, ?, ?)"
    )
    ins.run(MASTER_ID, '明天提醒我跑步', now + 3600, 0, now, now)      // 等待中
    ins.run(MASTER_ID, '到点的约定', now - 60, 0, now, now)             // 到点
    ins.run(MASTER_ID, '已经提过了', 0, now - 10, now, now)             // 已兑现(提过就不再提)
    ins.run(MASTER_ID, '只记录不主动提', 0, 0, now, now)                // 不定时
    const t = store.listThreads()
    assert.equal(t.waiting.length, 1)
    assert.equal(t.waiting[0].secondsLeft > 3500, true)
    assert.equal(t.due.length, 1)
    assert.equal(t.done.length, 1)
    assert.equal(t.untimed.length, 1)
  } finally { store.close() }
})

test('仪表盘:D5 面板五档 —— 冷却 / 已了结 / 归档三个新档(老四桶原位不动)', () => {
  const store = freshStore()
  try {
    const now = NOW()
    const ins = store.db.prepare(
      'INSERT INTO pending_threads (user_id, content, status, follow_up_after, last_mentioned_at,' +
      ' created_at, updated_at, kind, cooling_at, archived_at, superseded_by)' +
      ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    )
    ins.run(MASTER_ID, '活跃-承诺', 'open', 0, 0, now, now, 'promise', 0, 0, 0)
    ins.run(MASTER_ID, '冷却了但还记着', 'open', 0, 0, now, now, 'care', now - 100, 0, 0)
    ins.run(MASTER_ID, '已经说完了', 'resolved', 0, 0, now, now, 'promise', 0, 0, 0)
    ins.run(MASTER_ID, '归档留档的', 'archived', 0, 0, now, now, 'topic', now - 999, now - 50, 3)
    const t = store.listThreads()
    // 老四桶:只剩"活跃档"的行(冷却/归档/已了结都不进)
    assert.equal(t.untimed.length, 1)
    assert.equal(t.untimed[0].content, '活跃-承诺')
    assert.equal(t.untimed[0].kind, 'promise', '每行要带 kind(D5 的徽标)')
    assert.equal(t.waiting.length + t.due.length + t.done.length, 0)
    // 三个新档
    assert.equal(t.cooling.length, 1)
    assert.equal(t.cooling[0].content, '冷却了但还记着')
    assert.equal(t.cooling[0].coolingAt > 0, true)
    assert.equal(t.resolved.length, 1)
    assert.equal(t.resolved[0].content, '已经说完了')
    assert.equal(t.archived.length, 1)
    assert.equal(t.archived[0].content, '归档留档的')
    assert.equal(t.archived[0].archivedAt > 0, true)
    assert.equal(t.archived[0].supersededBy, 3, '被取代的指向要带出来')
  } finally { store.close() }
})

test('仪表盘:想念复刻公式(H=3h,幂律补差,clamp [0,10])', () => {
  const store = freshStore()
  try {
    const now = NOW()
    // value=5,anchor 2h 前,updated 1h 前 → inc = 10·7200/18000 − 10·3600/14400 = 1.5
    store.db.prepare(
      'INSERT INTO longing_state (user_id, value, anchor_at, updated_at, kicked, last_user_msg_at, last_care_at, care_count)' +
      ' VALUES (?, 5, ?, ?, 0, ?, 0, 2)'
    ).run(MASTER_ID, now - 7200, now - 3600, now - 3600)
    const rows = store.longingRows()
    assert.equal(rows.length, 1)
    assert.equal(rows[0].threshold, 7.0)
    assert.ok(Math.abs(rows[0].value - 6.5) < 0.05, 'value=' + rows[0].value)
    assert.equal(rows[0].careCount, 2)
    assert.ok(rows[0].sinceMessage > 3500 && rows[0].sinceMessage < 3700)
  } finally { store.close() }
})

test('仪表盘:图谱类型推断(人物名单/习惯/偏好)+ 度数权重', () => {
  const store = freshStore()
  try {
    const nn = store.db.prepare('INSERT INTO graph_nodes (node_id, name, node_type) VALUES (?, ?, ?)')
    nn.run('n1', '阿岚', 'concept')     // 人物名单 → person
    nn.run('n2', '跑步', 'concept')     // 习惯边 → habit
    nn.run('n3', '辣的东西', 'concept') // 偏好边 → preference
    nn.run('n4', '面试', 'event')       // 已有类型不覆盖
    const ne = store.db.prepare('INSERT INTO graph_edges (source_id, target_id, relation, weight) VALUES (?, ?, ?, ?)')
    ne.run('n1', 'n2', '习惯', 2)
    ne.run('n1', 'n3', '讨厌', 1)
    const g = store.graphData({ personNames: ['阿岚'] })   // P1b:名单显式喂一份(默认读 names.json)
    const byId = Object.fromEntries(g.nodes.map((n) => [n.id, n]))
    assert.equal(byId.n1.type, 'person')
    assert.equal(byId.n2.type, 'habit')
    assert.equal(byId.n3.type, 'preference')
    assert.equal(byId.n4.type, 'event')
    assert.equal(byId.n1.weight, 2) // 两条边都挂在 n1
    assert.equal(g.edges.length, 2)
    assert.equal(g.edges[0].relation, '习惯')
    // P1b(模块5):名单**空 ⇒ 中性**(设计文档 row 7:不猜、不兜底)——
    // 同一个节点不再被判成 person,按关系落到 habit。以前名单硬编码在代码里,
    // 这条"空名单"的行为根本无从表达;现在它是数据,必须有这一条。
    const neutral = Object.fromEntries(store.graphData({ personNames: [] }).nodes.map((n) => [n.id, n]))
    assert.equal(neutral.n1.type, 'habit', '没有名单 ⇒ 不许凭空判 person')
  } finally { store.close() }
})

test('图谱:引擎超集字段透传 + 激活度现算(v0.13.2 图谱数据面)', () => {
  const store = freshStore()
  try {
    const now = NOW()
    // JS DDL 补齐超集列后,:memory: 新库也能落激活度/取代链。
    // 节点物化激活度 8(低)—— 现算应被邻边推导覆盖(50)。
    store.db.prepare(
      "INSERT INTO graph_nodes (node_id, name, node_type, activation, intrinsic_value, half_life, recall_count)" +
      " VALUES ('n1', '阿岚', 'person', 8, 15, 40, 3)"
    ).run()
    // 边:last_accessed 恰好一个半衰期前 → R=0.5 → 现算激活度 50;
    // 物化列 55 原样透传(快照 vs 现算可对照)。
    // v0.16.0 M2:graphData 现在会滤掉端点不在节点表里的悬空边(归一
    // 后墓碑节点会让旧边悬空),所以 n1b 必须先作为节点存在。
    store.db.prepare(
      "INSERT INTO graph_nodes (node_id, name, node_type) VALUES ('n1b', '猫', 'concept')"
    ).run()
    store.db.prepare(
      "INSERT INTO graph_edges (source_id, target_id, relation, weight, activation, intrinsic_value," +
      " occurred_at, layer, is_active, superseded_by, half_life, recall_count, temporal_status, last_accessed)" +
      " VALUES ('n1', 'n1b', '喜欢', 3, 55, 12, 1790000000, 'L0', 0, 9, 37.5, 2, 'current', ?)"
    ).run(now - 37.5 * 3600)
    const g = store.graphData()
    const n = g.nodes.find((x) => x.id === 'n1')
    assert.equal(n.activation, 50)           // 邻边现算推导,盖过物化 8
    assert.equal(n.activationStored, 8)
    assert.equal(n.intrinsicValue, 15)
    assert.equal(n.halfLife, 40)
    assert.equal(n.recallCount, 3)
    assert.equal(n.temporalStatus, 'time_unknown')
    const e = g.edges[0]
    assert.equal(e.activation, 50)           // R(Δt=H)=0.5 → 50,半衰期边界
    assert.equal(e.activationStored, 55)     // 物化快照原样透传
    assert.equal(e.intrinsicValue, 12)
    assert.equal(e.occurredAt, 1790000000)
    assert.equal(e.layer, 'L0')
    assert.equal(e.isActive, false)          // is_active=0 → 已被取代
    assert.equal(e.supersededBy, 9)
    assert.equal(e.temporalStatus, 'current')
  } finally { store.close() }
})

test('仪表盘:情绪历史读回', () => {
  const store = freshStore()
  try {
    store.saveState({ moodIntensity: 6, prevMoodIntensity: 3, userEmotion: 'happy', moodReason: '阿岚夸我了', currentTopic: '', emotionVector: { affection: 9 }, previousEmotionVector: null })
    const rows = store.emotionStates(5)
    assert.equal(rows.length, 1)
    assert.equal(rows[0].moodIntensity, 6)
    assert.equal(rows[0].userEmotion, 'happy')
    assert.deepEqual(rows[0].emotionVector, { affection: 9 })
  } finally { store.close() }
})

test('仪表盘:记忆体检 —— DMAE 三态现场计算 + 时间分布 + 悬置计数', () => {
  const store = freshStore()
  try {
    const now = NOW()
    // 活跃:刚记的(H0 大,R=1)
    store.insertMemory({ keywords: ['今天'], summary: '刚发生的事', emotionScore: 5 })
    // 休眠:R≈0.25(half_life=100h,上次想起 300h 前)
    const dormantId = store.insertMemory({ keywords: ['旧事'], summary: '有点久的事', emotionScore: 5 })
    store.db.prepare('UPDATE episodic_memory SET half_life = 100, last_recalled = ? WHERE memory_id = ?').run(now - 300 * 3600, dormantId)
    // 归档:R≈0.0001(half_life=0.01h,100h 没想起)
    const archivedId = store.insertMemory({ keywords: ['更旧'], summary: '快忘掉的事', emotionScore: 5 })
    store.db.prepare('UPDATE episodic_memory SET half_life = 0.01, last_recalled = ? WHERE memory_id = ?').run(now - 100 * 3600, archivedId)
    const h = store.memoryHealth()
    assert.equal(h.dmae.total, 3)
    assert.equal(h.dmae.active, 1)
    assert.equal(h.dmae.dormant, 1)
    assert.equal(h.dmae.archived, 1)
    assert.ok(h.dmae.avgR > 0.3 && h.dmae.avgR < 0.6, 'avgR=' + h.dmae.avgR)
    // 时间状态默认 time_unknown ×3
    assert.equal(h.temporal.time_unknown, 3)
    assert.deepEqual(h.threads, { open: 0, due: 0 })
  } finally { store.close() }
})
