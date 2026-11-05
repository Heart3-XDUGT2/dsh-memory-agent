import { test } from 'node:test'
import assert from 'node:assert/strict'
import { openStore, cleanName, MASTER_ID } from '../lib/store.js'

const fresh = () => openStore(':memory:')

test('M1:graphData 把边依据带出来(evidenceIds 是数字数组)', () => {
  const store = fresh()
  store.db.prepare(
    "INSERT INTO graph_nodes (node_id, name, owner_key) VALUES ('n1','用户',?)"
  ).run(MASTER_ID)
  store.db.prepare(
    "INSERT INTO graph_nodes (node_id, name, owner_key) VALUES ('n2','章鱼小丸子',?)"
  ).run(MASTER_ID)
  store.db.prepare(
    "INSERT INTO graph_edges (source_id, target_id, relation, owner_key, evidence)" +
    " VALUES ('n1','n2','喜欢',?,'169、99、(推定)')"
  ).run(MASTER_ID)
  const g = store.graphData()
  assert.equal(g.edges.length, 1)
  // 非数字 token 丢掉:面板只拿得到能点开的 id
  assert.deepEqual(g.edges[0].evidenceIds, [169, 99])
  store.close()
})

test('M1:memoriesByIds 保序、含已让位行、越界 id 静默丢弃', () => {
  const store = fresh()
  const a = store.insertMemory({ keywords: ['猫'], summary: '他养了一只猫', emotionScore: 5 })
  const b = store.insertMemory({ keywords: ['狗'], summary: '他想养狗', emotionScore: 5 })
  store.setMemoryState({ memoryId: b, action: 'forget' })  // 已让位:仍是历史,回指要翻得到
  const rows = store.memoriesByIds([a, 999999, b])
  assert.deepEqual(rows.map((r) => r.memoryId), [a, b])
  assert.equal(rows[1].isActive, 0)   // 0/1 原样出库(面板按 falsy 判「已让位」)
  assert.equal(rows[1].status, 'active')  // 面板靠 status/supersededBy 说清「被谁取代」
  assert.equal(rows[1].supersededBy, 0)
  assert.deepEqual(store.memoriesByIds([]), [])
  store.close()
})

test('M2:graph_aliases 表在 JS 侧也存在(两边 DDL 同源)', () => {
  const store = fresh()
  const cols = store.db.prepare('PRAGMA table_info(graph_aliases)').all().map((r) => r.name)
  assert.deepEqual(cols.sort(), ['alias', 'canonical_name', 'canonical_node_id', 'created_at', 'source'])
  store.db.prepare(
    "INSERT INTO graph_aliases (alias, canonical_name, canonical_node_id, created_at, source)" +
    " VALUES ('西电','西安电子科技大学','n9',1,'merge')"
  ).run()
  const row = store.db.prepare("SELECT canonical_name FROM graph_aliases WHERE alias = '西电'").get()
  assert.equal(row.canonical_name, '西安电子科技大学')
  store.close()
})

test('M2:墓碑节点与它的边不出现在面板数据里', () => {
  const store = fresh()
  store.db.prepare(
    "INSERT INTO graph_nodes (node_id, name, owner_key, is_active) VALUES ('n1','西安电子科技大学',?,1)"
  ).run(MASTER_ID)
  store.db.prepare(
    "INSERT INTO graph_nodes (node_id, name, owner_key, is_active, superseded_by)" +
    " VALUES ('n2','西电',?,0,'n1')"
  ).run(MASTER_ID)
  store.db.prepare(
    "INSERT INTO graph_nodes (node_id, name, owner_key, is_active) VALUES ('n3','校园跑',?,1)"
  ).run(MASTER_ID)
  store.db.prepare(
    "INSERT INTO graph_edges (source_id, target_id, relation, owner_key) VALUES ('n1','n3','要求',?)"
  ).run(MASTER_ID)
  store.db.prepare(
    "INSERT INTO graph_edges (source_id, target_id, relation, owner_key, is_active)" +
    " VALUES ('n2','n3','要求',?,0)"
  ).run(MASTER_ID)
  const g = store.graphData()
  assert.deepEqual(g.nodes.map((n) => n.name).sort(), ['校园跑', '西安电子科技大学'].sort())
  // 指向墓碑的留档边一并隐藏:否则力导向图会画出悬空边
  assert.equal(g.edges.length, 1)
  assert.equal(g.edges[0].source, 'n1')
  store.close()
})

test('M1:topEntityNames 按度数取前 N(给提示词的现成名单)', () => {
  const store = fresh()
  for (const [id, name] of [['n1', '用户'], ['n2', '校园跑'], ['n3', '3km速度限制']]) {
    store.db.prepare('INSERT INTO graph_nodes (node_id, name, owner_key) VALUES (?,?,?)')
      .run(id, name, MASTER_ID)
  }
  store.db.prepare("INSERT INTO graph_edges (source_id, target_id, relation, owner_key) VALUES ('n1','n2','参加',?)").run(MASTER_ID)
  store.db.prepare("INSERT INTO graph_edges (source_id, target_id, relation, owner_key) VALUES ('n2','n3','要求',?)").run(MASTER_ID)
  const names = store.topEntityNames(5)
  assert.equal(names[0], '校园跑')      // 度 2
  assert.ok(names.includes('用户'))
  store.close()
})

test('M4:getProfile 只做 L0 只读投影(不复制身份事实)', () => {
  const store = fresh()
  store.insertMemory({
    keywords: ['专业'], summary: '他就读于西安电子科技大学', emotionScore: 5,
    layer: 'L0', memoryKey: 'occupation'
  })
  store.insertMemory({
    keywords: ['猫'], summary: '他养了一只猫', emotionScore: 5, layer: 'L2'
  })
  const p = store.getProfile()
  assert.deepEqual(p.derivedFromL0.map((x) => x.field), ['occupation'])
  assert.equal(p.derivedFromL0[0].summary, '他就读于西安电子科技大学')
  assert.equal(p.coreTraits, null)
  assert.equal(p.name, '')
  store.close()
})

test('M4:cleanName 挡住占位词(活库曾写进 name="null")', () => {
  assert.equal(cleanName(null), '')
  assert.equal(cleanName('  '), '')
  assert.equal(cleanName('null'), '')
  assert.equal(cleanName('NULL'), '')
  assert.equal(cleanName('undefined'), '')
  assert.equal(cleanName('阿岚'), '阿岚')
  const store = fresh()
  store.setName('null')
  assert.equal(store.getProfile().name, '')   // 占位词不落库
  store.setName('阿岚')
  assert.equal(store.getProfile().name, '阿岚')
  store.close()
})
