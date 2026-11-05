import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { openStore, MASTER_ID, PROACTIVE_ROUND_MARKER } from '../lib/store.js'

function freshStore () {
  return openStore(':memory:')
}

test('插入 → 检索 → 强化回写(被想起来就强化)', () => {
  const store = freshStore()
  const id = store.insertMemory({
    keywords: ['发烧', '39度'],
    summary: '他发烧到39度,很担心',
    emotionScore: 8
  })
  assert.ok(id > 0)
  const before = store.db.prepare('SELECT half_life, recall_count FROM episodic_memory WHERE memory_id = ?').get(id)
  const top = store.retrieve('他发烧好点了吗', 6)
  assert.equal(top.length, 1)
  assert.equal(top[0].memoryId, id)
  const after = store.db.prepare('SELECT half_life, recall_count, last_recalled FROM episodic_memory WHERE memory_id = ?').get(id)
  assert.equal(after.recall_count, before.recall_count + 1)
  assert.ok(after.half_life >= before.half_life)
  assert.ok(after.last_recalled > 0)
  store.close()
})

test('说法键落库(2026-09-30):augKeys 进列、空则 NULL、行里读得回来', () => {
  const store = freshStore()
  const a = store.insertMemory({
    keywords: ['Echo'], summary: '用户把 Echo 打造成心目中的样子', emotionScore: 9,
    augKeys: ['亲手做', '自己动手']
  })
  const b = store.insertMemory({ keywords: ['猫'], summary: '他喜欢猫', emotionScore: 5 })
  const ra = store.db.prepare('SELECT aug_keys FROM episodic_memory WHERE memory_id = ?').get(a)
  const rb = store.db.prepare('SELECT aug_keys FROM episodic_memory WHERE memory_id = ?').get(b)
  assert.deepEqual(JSON.parse(ra.aug_keys), ['亲手做', '自己动手'])
  assert.equal(rb.aug_keys, null) // 没给 ⇒ NULL ⇒ 检索时一个字面都不加
  // 行读回来也必须带出说法键(打分正文要用它)
  assert.deepEqual(store.memoriesByIds([a])[0].augKeys, ['亲手做', '自己动手'])
  store.close()
})

test('旧库补列:老表没有 aug_keys 时 openStore 幂等补上,老行读出来是空', () => {
  const dir = mkdtempSync(join(tmpdir(), 'echo-aug-'))
  const path = join(dir, 'old.db')
  // 造一个"老库":episodic_memory 是 v0.4.x 那种形状(没有 aug_keys)
  const raw = new DatabaseSync(path)
  raw.exec('CREATE TABLE episodic_memory (memory_id INTEGER PRIMARY KEY AUTOINCREMENT,' +
    ' user_id TEXT, keywords TEXT, summary TEXT, emotion_score INTEGER, timestamp TIMESTAMP,' +
    " is_active INTEGER DEFAULT 1, layer TEXT DEFAULT '', status TEXT DEFAULT 'active')")
  raw.exec("INSERT INTO episodic_memory (user_id, keywords, summary, emotion_score, timestamp)" +
    " VALUES ('master', '[\"猫\"]', '他喜欢猫', 5, 1700000000)")
  raw.close()
  const store = openStore(path)
  const cols = store.db.prepare('PRAGMA table_info(episodic_memory)').all().map(r => r.name)
  assert.ok(cols.includes('aug_keys'), 'openStore 该把 aug_keys 补上')
  const m = store.memoriesByIds([1])[0]
  assert.deepEqual(m.augKeys, [], '老行没有说法键 ⇒ 空数组(不是 undefined)')
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

test('I 降级路径:emotion_score×10 钳到 [1,100],决定 H0', () => {  const store = freshStore()
  store.insertMemory({ keywords: ['灌水'], summary: '闲聊一句', emotionScore: 1 })
  store.insertMemory({ keywords: ['大事'], summary: '重要的事', emotionScore: 10 })
  const rows = store.db.prepare('SELECT summary, intrinsic_value, half_life FROM episodic_memory ORDER BY memory_id').all()
  assert.equal(rows[0].intrinsic_value, 10)  // 1×10
  assert.equal(rows[1].intrinsic_value, 100) // 10×10
  assert.ok(rows[1].half_life > rows[0].half_life * 10)
  store.close()
})

test('槽位取代:同 memory_key 换代不叠加;同文重说=想起', () => {
  const store = freshStore()
  const k = { memoryKey: '偏好:咖啡' }
  const id1 = store.insertMemory({ ...k, keywords: ['咖啡'], summary: '他喜欢拿铁', emotionScore: 5 })
  const id2 = store.insertMemory({ ...k, keywords: ['咖啡'], summary: '他现在只喝美式', emotionScore: 5 })
  assert.notEqual(id1, id2)
  const old = store.db.prepare('SELECT is_active, superseded_by FROM episodic_memory WHERE memory_id = ?').get(id1)
  assert.equal(old.is_active, 0)
  assert.equal(old.superseded_by, id2)
  // 同文重说:不新增行,强化旧行
  const id3 = store.insertMemory({ ...k, keywords: ['咖啡'], summary: '他现在只喝美式', emotionScore: 5 })
  assert.equal(id3, id2)
  const count = store.db.prepare('SELECT COUNT(*) AS n FROM episodic_memory').get().n
  assert.equal(count, 2)
  store.close()
})

test('换代是原子的:新行写不进去 ⇒ 旧记忆必须还在,且不许留 superseded_by=-1', () => {
  // v0.42.0 审计 P0 回归。旧写法「先把旧行标 is_active=0 + superseded_by=-1,
  // 再 INSERT 新行」是两条独立语句:INSERT 失败(或 SQLITE_BUSY/进程死)就留下
  // 「已下架、无后继」的行 —— 那条记忆从召回里静默消失,而
  // python/engine/db.py 的 _repair_dangling_superseded 只清引用、不复活 is_active。
  // 这条测试就是那个窗口:用触发器把 INSERT 打回,然后看旧记忆还在不在。
  const store = freshStore()
  const k = { memoryKey: '偏好:咖啡' }
  const id1 = store.insertMemory({ ...k, keywords: ['咖啡'], summary: '他喜欢拿铁', emotionScore: 5 })
  store.db.exec("CREATE TRIGGER boom BEFORE INSERT ON episodic_memory"
    + " WHEN NEW.summary = '这一条必须写不进去'"
    + " BEGIN SELECT RAISE(ABORT, 'boom'); END")
  assert.throws(
    () => store.insertMemory({ ...k, keywords: ['咖啡'], summary: '这一条必须写不进去', emotionScore: 5 }),
    /boom/
  )
  const old = store.db.prepare('SELECT is_active, superseded_by FROM episodic_memory WHERE memory_id = ?').get(id1)
  assert.equal(old.is_active, 1, '新行没落库 ⇒ 旧记忆不许被下架')
  assert.notEqual(old.superseded_by, -1, '不许留「即将被取代」的悬空标记')
  assert.ok(store.retrieve('他喝什么咖啡', 6).some((it) => it.memoryId === id1), '旧记忆必须还在召回池里')
  assert.equal(
    store.db.prepare('SELECT COUNT(*) AS n FROM episodic_memory WHERE superseded_by = -1').get().n, 0,
    '全库一条 -1 悬空行都不许有'
  )
  // 事务没把库卡住:紧接着的正常写入仍要成功
  const id2 = store.insertMemory({ ...k, keywords: ['咖啡'], summary: '他改喝美式了', emotionScore: 5 })
  assert.ok(id2 > 0)
  const after = store.db.prepare('SELECT is_active, superseded_by FROM episodic_memory WHERE memory_id = ?').get(id1)
  assert.equal(after.is_active, 0)
  assert.equal(after.superseded_by, id2)
  store.close()
})

test('认知状态 upsert:prev 链条正确', () => {
  const store = freshStore()
  const s0 = store.getState()
  assert.equal(s0.moodIntensity, 3) // 安全默认
  store.saveState({ moodIntensity: 7, userEmotion: 'happy', moodReason: '被夸了', emotionVector: { target_master: { affection: 8 } } })
  const s1 = store.getState()
  assert.equal(s1.moodIntensity, 7)
  assert.equal(s1.prevMoodIntensity, 3) // prev = 上一轮的 current
  assert.equal(s1.emotionVector.target_master.affection, 8)
  store.saveState({ moodIntensity: 4, emotionVector: { target_master: { affection: 6 } } })
  const s2 = store.getState()
  assert.equal(s2.prevMoodIntensity, 7)
  assert.equal(s2.emotionVector.target_master.affection, 6)
  assert.equal(s2.previousEmotionVector.target_master.affection, 8)
  store.close()
})

test('称呼更新与画像读取', () => {
  const store = freshStore()
  assert.equal(store.getProfile().name, '')
  store.setName('阿岚')
  assert.equal(store.getProfile().name, '阿岚')
  store.setName('阿乙')
  assert.equal(store.getProfile().name, '阿乙') // 换代不是叠加
  store.close()
})

test('审计写入与统计', () => {
  const store = freshStore()
  store.insertMemory({ keywords: ['a'], summary: '记忆A', emotionScore: 5 })
  store.insertMemory({ keywords: ['b'], summary: '核心B', emotionScore: 9, layer: 'L0' })
  store.writeAudit({ traceId: 't1', userInput: '你好', llmReply: '你好呀', moodIntensity: 5, prevMoodIntensity: 3, emotionVector: {} })
  const stats = store.memoryStats()
  assert.equal(stats.episodicActive, 2)
  assert.equal(stats.episodicTotal, 2)
  assert.equal(stats.l0, 1)
  assert.ok(stats.lastMemoryAt > 0)
  const audit = store.db.prepare('SELECT COUNT(*) AS n FROM audit_logs').get().n
  assert.equal(audit, 1)
  store.close()
})

// ---- v0.15.1 G20/G22:索引、统计三项、情绪面板的会话与话题 ----

test('G20 三个索引真的建出来了(A 的 speaker/槽位/owner)', () => {
  const store = freshStore()
  const names = store.db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all()
    .map((r) => r.name)
  // 索引不是装饰:槽位取代链查询 WHERE owner_key=? AND slot=? 靠它免于扫表
  for (const idx of ['idx_episodic_user', 'idx_episodic_speaker', 'idx_audit_session',
    'idx_pending_threads_user', 'idx_graph_edge_src', 'idx_graph_edge_slot',
    'idx_graph_edge_owner']) {
    assert.ok(names.includes(idx), '缺索引 ' + idx + '(实为 ' + names.join(',') + ')')
  }
  store.close()
})

test('G22 统计三项:审计行数 / 换代过的记忆 / 画像字段', () => {
  const store = freshStore()
  store.insertMemory({ keywords: ['a'], summary: '记忆A', emotionScore: 5 })
  store.db.prepare(
    'INSERT INTO episodic_memory (user_id, keywords, summary, emotion_score, timestamp, superseded_by)' +
    " VALUES ('master', '[]', '被我更新掉的旧说法', 5, 1, 1)"
  ).run()
  store.writeAudit({ traceId: 't1', userInput: 'x', llmReply: 'y', moodIntensity: 4, prevMoodIntensity: 4, emotionVector: {} })
  store.writeAudit({ traceId: 't2', userInput: 'x', llmReply: 'y', moodIntensity: 4, prevMoodIntensity: 4, emotionVector: {} })
  store.setName('阿岚')
  const stats = store.memoryStats()
  assert.equal(stats.auditRows, 2)
  assert.equal(stats.superseded, 1)
  // ★ 2026-09-26 审查:这一项以前是 `COUNT(*) FROM user_profile`(恒 0/1),
  // 现在真的数 `core_traits` 的键数。setName('阿岚') 写的是 **name 列**、
  // 不是常驻项 ⇒ 0(见下面那条「画像字段数 = core_traits 键数」用例)。
  assert.equal(stats.profileFields, 0)
  store.close()
})

test('G22 情绪面板:每行带会话与当前话题(此前只 SELECT 了心情)', () => {
  const store = freshStore()
  store.saveState({
    moodIntensity: 6, prevMoodIntensity: 4, userEmotion: 'tired',
    moodReason: '他加班', currentTopic: '加班到很晚', emotionVector: { global: { fatigue: 4 } }
  })
  const rows = store.emotionStates(5)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].currentTopic, '加班到很晚')
  assert.equal(rows[0].sessionId, 'global')
  assert.equal(rows[0].emotionVector.global.fatigue, 4)
  store.close()
})

test('关键词格式兼容:JSON 与 AstrBot v5.x 逗号拼接(DSH 修复的历史坑)', () => {
  const store = freshStore()
  // 逗号拼接老格式:Python 版静默丢关键词,这里必须救回来
  store.db.prepare(
    "INSERT INTO episodic_memory (user_id, keywords, summary, emotion_score, timestamp) VALUES (?, ?, ?, 5, 1)"
  ).run('master', '面试,网站建设,失败', '他面试没过')
  const top = store.retrieve('面试准备得怎么样了', 3)
  assert.equal(top.length, 1)
  assert.deepEqual(top[0].keywords, ['面试', '网站建设', '失败'])
  store.close()
})

test('归属简化:单主人 + 全局状态(AstrBot 多会话 → DSH 单人)', () => {
  const store = freshStore()
  store.insertMemory({ keywords: ['x'], summary: 'x', emotionScore: 5 })
  const row = store.db.prepare('SELECT user_id, is_master FROM episodic_memory LIMIT 1').get()
  assert.equal(row.user_id, MASTER_ID)
  assert.equal(row.is_master, 1)
  const state = store.db.prepare('SELECT session_id FROM agent_state LIMIT 1')
  assert.equal(store.getState().moodIntensity, 3) // 未写状态时无行也有默认
  store.close()
})

// ---- M2-h 置信度门控的 JS 侧配套 ----

test('status 列迁移:旧库(v0.4.x 无此列)打开时幂等补列并回填', () => {
  const dir = mkdtempSync(join(tmpdir(), 'echo-store-mig-'))
  const dbPath = join(dir, 'echo.db')
  try {
    // 逼真旧形状:有 timestamp 等列,只缺 status
    const raw = new DatabaseSync(dbPath)
    raw.exec(
      'CREATE TABLE episodic_memory (memory_id INTEGER PRIMARY KEY AUTOINCREMENT,' +
      ' user_id TEXT, keywords TEXT, summary TEXT, emotion_score INTEGER,' +
      ' timestamp TIMESTAMP, is_active INTEGER DEFAULT 1, layer TEXT DEFAULT \'\')')
    raw.prepare("INSERT INTO episodic_memory (user_id, summary, is_active) VALUES ('master', '旧记忆', 1)").run()
    raw.close()
    const store = openStore(dbPath)
    const cols = store.db.prepare('PRAGMA table_info(episodic_memory)').all().map(r => r.name)
    assert.ok(cols.includes('status'))
    const row = store.db.prepare("SELECT status FROM episodic_memory WHERE summary = '旧记忆'").get()
    assert.equal(row.status, 'active') // 回填,不是 NULL
    // 幂等:重开不炸不重复
    store.close()
    const store2 = openStore(dbPath)
    assert.ok(store2.db.prepare('PRAGMA table_info(episodic_memory)').all().some(r => r.name === 'status'))
    store2.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('隔离行检索不可见 + 统计分桶(引擎写的 quarantined 行)', () => {
  const store = freshStore()
  const idA = store.insertMemory({ keywords: ['确凿'], summary: '确凿的事实', emotionScore: 5 })
  const idQ = store.insertMemory({ keywords: ['存疑'], summary: '半信半疑的事', emotionScore: 5 })
  // 模拟 Python 引擎的隔离写入
  store.db.prepare("UPDATE episodic_memory SET status = 'quarantined' WHERE memory_id = ?").run(idQ)
  const hitsQ = store.retrieve('半信半疑', 6)
  assert.equal(hitsQ.length, 0)          // 她不把没把握的事当真事记
  const hitsA = store.retrieve('确凿', 6)
  assert.equal(hitsA.length, 1)
  assert.equal(hitsA[0].memoryId, idA)
  const stats = store.memoryStats()
  assert.equal(stats.episodicActive, 1)  // 活跃只数正式行
  assert.equal(stats.quarantined, 1)     // 待观察单列一桶
  assert.equal(stats.episodicTotal, 2)
  store.close()
})

test('晋升收尾:基线写入同 key 正式行时,隔离候选一并让位', () => {
  const store = freshStore()
  const k = { memoryKey: 'prep_interview' }
  const idQ = store.insertMemory({ ...k, keywords: ['面试'], summary: '他好像在准备面试', emotionScore: 5 })
  store.db.prepare("UPDATE episodic_memory SET status = 'quarantined' WHERE memory_id = ?").run(idQ)
  // 基线接管后写入同 slot 的正式版本(Python 引擎亡故的场景)
  const idA = store.insertMemory({ ...k, keywords: ['面试'], summary: '他在准备面试', emotionScore: 6 })
  assert.notEqual(idA, idQ)
  const old = store.db.prepare('SELECT is_active, superseded_by, status FROM episodic_memory WHERE memory_id = ?').get(idQ)
  assert.equal(old.is_active, 0)          // 悬案定谳,让位
  assert.equal(old.superseded_by, idA)
  const hits = store.retrieve('准备面试', 6)
  assert.equal(hits.length, 1)
  assert.equal(hits[0].memoryId, idA)
  store.close()
})

// ---- M6-d 记忆手动管理:编辑 + 状态机(面板写路径)----

test('editMemory:改情绪分重算 I 与半衰期;关键词收分隔符字符串;留审计', () => {
  const store = freshStore()
  try {
    const id = store.insertMemory({ keywords: ['旧词'], summary: '原摘要', emotionScore: 2 }) // I=20
    const before = store.db.prepare('SELECT intrinsic_value, half_life FROM episodic_memory WHERE memory_id = ?').get(id)
    const out = store.editMemory({ memoryId: id, summary: '改后的摘要', keywords: '章鱼小丸子、夜宵', emotionScore: 9 })
    assert.equal(out.ok, true)
    const after = store.db.prepare('SELECT summary, keywords, emotion_score, intrinsic_value, half_life FROM episodic_memory WHERE memory_id = ?').get(id)
    assert.equal(after.summary, '改后的摘要')
    assert.deepEqual(JSON.parse(after.keywords), ['章鱼小丸子', '夜宵'])
    assert.equal(after.emotion_score, 9)
    assert.equal(after.intrinsic_value, 90)                       // I = 9×10
    assert.ok(after.half_life > before.half_life)                 // H0 随 I 单调上行(DMAE 非线性)
    // 审计留痕:审查席的修正本身可审查(listAudit 返回数组,包对象是路由层的事)
    const audit = store.listAudit(0, 10)
    assert.ok(audit.some((r) => r.toolCall === 'memory_edit' && r.userInput.includes('#' + id)))
    // 空摘要拒绝;不存在 → null;无字段 → 报错
    assert.equal(store.editMemory({ memoryId: id, summary: '  ' }).error, 'summary 不能为空')
    assert.equal(store.editMemory({ memoryId: 99999, summary: 'x' }), null)
    assert.equal(store.editMemory({ memoryId: id }).error, '没有可改的字段')
  } finally { store.close() }
})

test('setMemoryState:六动作全链 + 恢复清取代标记 + 未知动作拒绝', () => {
  const store = freshStore()
  try {
    const id = store.insertMemory({ keywords: ['面试'], summary: '他在准备面试', emotionScore: 5 })
    // 隔离 → 检索不可见;转正 → 回来
    assert.equal(store.setMemoryState({ memoryId: id, action: 'quarantine' }).ok, true)
    assert.equal(store.retrieve('准备面试', 6).length, 0)
    assert.equal(store.setMemoryState({ memoryId: id, action: 'activate' }).ok, true)
    assert.equal(store.retrieve('准备面试', 6).length, 1)
    // 遗忘 = 留档(is_active=0,行还在);恢复 = 回岗
    assert.equal(store.setMemoryState({ memoryId: id, action: 'forget' }).ok, true)
    assert.equal(store.listMemories({ state: 'forgotten' }).total, 1)
    assert.equal(store.listMemories({}).total, 0)
    assert.equal(store.setMemoryState({ memoryId: id, action: 'restore' }).ok, true)
    assert.equal(store.listMemories({}).total, 1)
    // L0 置顶/取消:层字段往返,统计口径跟上
    assert.equal(store.setMemoryState({ memoryId: id, action: 'l0' }).ok, true)
    assert.equal(store.memoryStats().l0, 1)
    assert.equal(store.setMemoryState({ memoryId: id, action: 'unl0' }).ok, true)
    assert.equal(store.memoryStats().l0, 0)
    // 恢复被取代的行:superseded_by 清零(人证优先于自动换代)
    const id2 = store.insertMemory({ memoryKey: '偏好:咖啡', keywords: ['咖啡'], summary: '他改喝美式了', emotionScore: 5 })
    store.setMemoryState({ memoryId: id, action: 'forget' }) // 无关行,制造点噪声
    const oldRow = store.db.prepare('SELECT superseded_by FROM episodic_memory WHERE memory_id = ?').get(id2)
    assert.ok(oldRow.superseded_by >= 0)
    store.setMemoryState({ memoryId: id2, action: 'forget' })
    store.setMemoryState({ memoryId: id2, action: 'restore' })
    const restored = store.db.prepare('SELECT superseded_by, is_active FROM episodic_memory WHERE memory_id = ?').get(id2)
    assert.equal(restored.superseded_by, 0)
    assert.equal(restored.is_active, 1)
    // 审计留痕 + 边界
    const audit = store.listAudit(0, 200)
    assert.ok(audit.some((r) => r.toolCall === 'memory_state' && r.userInput.includes('quarantine')))
    assert.equal(store.setMemoryState({ memoryId: 99999, action: 'forget' }), null)
    assert.equal(store.setMemoryState({ memoryId: id, action: 'nuke' }).error !== undefined, true)
  } finally { store.close() }
})

// ---- M6-b 记忆浏览器:原始行分页(审查记忆库的只读窗口)----

test('listMemories:默认只看正式行,时间倒序,分页形状齐全', () => {
  const store = freshStore()
  try {
    const ids = []
    for (let i = 1; i <= 5; i++) {
      const id = store.insertMemory({ keywords: ['事' + i], summary: '第' + i + '件事', emotionScore: 5 })
      // 同毫秒插入会让 timestamp 打平、排序不定 —— 显式错开(真实库写入相隔秒级)
      store.db.prepare('UPDATE episodic_memory SET timestamp = ? WHERE memory_id = ?').run(1695000000 + i, id)
      ids.push(id)
    }
    // 一条隔离行 + 一条被遗忘行:默认视图都不见
    const idQ = store.insertMemory({ keywords: ['存疑'], summary: '半信半疑', emotionScore: 5 })
    store.db.prepare("UPDATE episodic_memory SET status = 'quarantined' WHERE memory_id = ?").run(idQ)
    const idF = store.insertMemory({ keywords: ['旧事'], summary: '被忘掉的旧事', emotionScore: 5 })
    store.db.prepare('UPDATE episodic_memory SET is_active = 0 WHERE memory_id = ?').run(idF)

    const page1 = store.listMemories({ page: 1, limit: 3 })
    assert.equal(page1.total, 5)
    assert.equal(page1.page, 1)
    assert.equal(page1.limit, 3)
    assert.equal(page1.rows.length, 3)
    assert.ok(page1.rows[0].timestamp >= page1.rows[1].timestamp) // 时间倒序
    assert.equal(page1.rows[0].summary, '第5件事')
    // 行形状:审查要看的字段齐全
    const r = page1.rows[0]
    assert.equal(typeof r.memoryId, 'number')
    assert.ok(Array.isArray(r.keywords))
    assert.equal(typeof r.intrinsicValue, 'number')
    assert.equal(r.isActive, true)
    assert.equal(r.status, 'active')
    // 翻页
    const page2 = store.listMemories({ page: 2, limit: 3 })
    assert.equal(page2.rows.length, 2)
    // 越界钳到最后一页
    const page9 = store.listMemories({ page: 9, limit: 3 })
    assert.equal(page9.page, 2)
  } finally { store.close() }
})

test('listMemories:state/layer/source/q 过滤与 value 排序', () => {
  const store = freshStore()
  try {
    const idA = store.insertMemory({ keywords: ['面试'], summary: '他在准备算法面试', emotionScore: 9 }) // I=90
    const idB = store.insertMemory({ keywords: ['咖啡'], summary: '他喜欢喝拿铁', emotionScore: 3 })     // I=30
    const idQ = store.insertMemory({ keywords: ['存疑'], summary: '他好像换了工作', emotionScore: 5 })
    store.db.prepare("UPDATE episodic_memory SET status = 'quarantined' WHERE memory_id = ?").run(idQ)
    const idF = store.insertMemory({ keywords: ['旧'], summary: '被忘掉的旧事', emotionScore: 5 })
    store.db.prepare('UPDATE episodic_memory SET is_active = 0 WHERE memory_id = ?').run(idF)

    // state=quarantined:只看待观察
    const quarantined = store.listMemories({ state: 'quarantined' })
    assert.equal(quarantined.total, 1)
    assert.equal(quarantined.rows[0].memoryId, idQ)
    // state=forgotten:只看留档行
    const forgotten = store.listMemories({ state: 'forgotten' })
    assert.equal(forgotten.total, 1)
    assert.equal(forgotten.rows[0].memoryId, idF)
    // state=all:全量
    assert.equal(store.listMemories({ state: 'all' }).total, 4)
    // q 搜索:summary 与 keywords 都命中
    assert.equal(store.listMemories({ q: '拿铁' }).total, 1)
    assert.equal(store.listMemories({ q: '面试' }).total, 1)
    assert.equal(store.listMemories({ q: '不存在的东西' }).total, 0)
    // sort=value:I 值倒序(90 分的面试在前)
    const byValue = store.listMemories({ sort: 'value' })
    assert.equal(byValue.rows[0].memoryId, idA)
    assert.ok(byValue.rows[0].intrinsicValue > byValue.rows[1].intrinsicValue)
    // layer 过滤(空 layer 的行不匹配 L0)
    store.db.prepare("UPDATE episodic_memory SET layer = 'L0' WHERE memory_id = ?").run(idB)
    assert.equal(store.listMemories({ layer: 'L0' }).total, 1)
    // source 过滤
    store.db.prepare("UPDATE episodic_memory SET source = 'qq' WHERE memory_id = ?").run(idB)
    assert.equal(store.listMemories({ source: 'qq' }).total, 1)
  } finally { store.close() }
})

// ---- v0.10.0 共享灵魂库(M8-a):多进程并发的连接前提 ----

test('文件库开库即设 busy_timeout=5000 与 WAL(共享灵魂库前提)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'echo-m8-'))
  try {
    const store = openStore(join(dir, 'soul.db'))
    try {
      // busy_timeout:锁忙时等而不是炸(对齐 python 引擎与 AstrBot 侧的 5000ms)
      // 注:PRAGMA 读回来的列名是 timeout(SQLite 本名),不是 busy_timeout
      assert.equal(store.db.prepare('PRAGMA busy_timeout').get().timeout, 5000)
      // WAL:多进程读写并发的日志模式(幂等,已是 WAL 则 no-op)
      assert.equal(store.db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal')
    } finally { store.close() }
    // 第二次开库(模拟另一进程):PRAGMA 幂等,不炸
    const again = openStore(join(dir, 'soul.db'))
    try {
      assert.equal(again.db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal')
    } finally { again.close() }
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

// ---- v0.11.0 对话记录(M8-a):全局滚动 100 轮 + 渠道过滤 ----

test('对话记录:写入 + 全局滚动 100 轮(用户裁决的窗口)', () => {
  const store = freshStore()
  try {
    for (let i = 1; i <= 105; i++) {
      store.writeConversation({ sessionId: 'sess-' + (i % 3), channel: i % 2 ? 'QQ' : '', userText: 'u' + i, replyText: 'r' + i })
    }
    const all = store.db.prepare('SELECT COUNT(*) AS n FROM conversation_log').get().n
    assert.equal(all, 100) // 105 写 100 留:全局窗口,跨会话共用
    // 最老的 5 轮被修剪,最新一轮还在
    const ids = store.db.prepare('SELECT turn_id FROM conversation_log ORDER BY turn_id').all()
    assert.equal(ids[0].turn_id, 6)          // 1~5 让位
    const latest = store.listConversations({ limit: 1 })[0]
    assert.equal(latest.userText, 'u105')
    assert.ok(latest.createdAt > 0)
  } finally { store.close() }
})

test('对话记录:渠道过滤 + 倒序 + limit 上限', () => {
  const store = freshStore()
  try {
    for (let i = 1; i <= 6; i++) {
      store.writeConversation({ sessionId: 's', channel: i <= 4 ? 'QQ' : '', userText: 'u' + i, replyText: 'r' + i })
    }
    const qq = store.listConversations({ channel: 'QQ' })
    assert.equal(qq.length, 4)
    assert.equal(qq[0].userText, 'u4') // 倒序:最新在前
    assert.ok(qq.every((r) => r.channel === 'QQ'))
    const top2 = store.listConversations({ limit: 2 })
    assert.equal(top2.length, 2)
    assert.equal(top2[0].userText, 'u6')
    // 关怀轮:user 侧空、reply 侧有 —— 照记(回放要能看到她主动开口)
    store.writeConversation({ sessionId: 's', channel: 'QQ', userText: '', replyText: '她主动说的话' })
    const last = store.listConversations({ limit: 1 })[0]
    assert.equal(last.userText, '')
    assert.equal(last.replyText, '她主动说的话')
  } finally { store.close() }
})

// ---- v0.14.5 S10/S11:审计裁剪与六列、主动轮哨兵、只改向量列的写入 ----

test('S10 审计裁剪:只留最近 keep 条,下界 20(A _trim_audit)', () => {
  const store = openStore(':memory:', { auditKeep: 25 })
  try {
    for (let i = 1; i <= 60; i++) {
      store.writeAudit({ traceId: 'audit-' + i, userInput: 'u' + i, toolCall: 'manual' })
    }
    const rows = store.listAudit(0, 200)
    assert.equal(rows.length, 25, '写 60 条只该留 25 条')
    // 同一毫秒写入的 timestamp 会打平,裁剪之后**集合**才是可断言的东西:
    // 留的必须是最后写进去的那 25 条(靠 rowid 兜底的 DESC 顺序)。
    const kept = new Set(rows.map((r) => r.userInput))
    assert.equal(kept.size, 25)
    for (let i = 36; i <= 60; i++) assert.ok(kept.has('u' + i), 'u' + i + ' 该被留下')
    for (const gone of ['u1', 'u20', 'u35']) assert.equal(kept.has(gone), false, gone + ' 该被裁掉')
    // 配置写坏了也不至于把审计清成空表(审计是关怀日上限的真相源)
    assert.equal(store.setAuditKeep(0), 20)
    store.trimAudit()
    assert.equal(store.listAudit(0, 200).length, 20)
    // 缺省 keep = 100(本仓定案;A 是 200)
    const dflt = openStore(':memory:')
    try {
      for (let i = 1; i <= 150; i++) dflt.writeAudit({ traceId: 'd' + i, userInput: 'x' })
      assert.equal(dflt.listAudit(0, 200).length, 100)
    } finally { dflt.close() }
  } finally { store.close() }
})

/**
 * ★ 2026-09-26 全仓审查抓到的真 bug(高):关怀日上限的真相源会被自己裁掉。
 *
 * `heartbeat` 用 `careCountSince(本地午夜)` 挡 `CARE_DAILY_CAP=3`,而
 * `trimAudit` 无差别裁到最近 `keep` 条 —— 活库实测 audit_logs 恰 100 行
 * (=keep)且**全是当天**,意味着当天早些时候的关怀行已经被删 ⇒ 越到晚上
 * 越数不准,「一天最多主动开口三次」静默失效。
 *
 * 修法:裁剪时**当天的 care 行永不裁**(每天最多 3 条)。这条用例就是钉住它。
 */
test('S10b 日上限真相源:裁剪不许删掉当天的关怀行(care 行豁免)', () => {
  const store = openStore(':memory:', { auditKeep: 20 })
  try {
    const d = new Date()
    d.setHours(0, 0, 0, 0)
    const midnight = d.getTime() / 1000
    // 今天先来三次关怀(它们会被后面的日常行挤到 keep 之外)
    for (let i = 1; i <= 3; i++) {
      store.writeAudit({ traceId: 'care-' + i, userInput: '关怀 ' + i, toolCall: 'care' })
    }
    assert.equal(store.careCountSince(midnight), 3)
    // 再来 60 行普通审计 —— 足以把上面三条挤出 keep=20 的窗口
    for (let i = 1; i <= 60; i++) {
      store.writeAudit({ traceId: 'turn-' + i, userInput: '轮 ' + i, toolCall: 'manual' })
    }
    assert.equal(store.careCountSince(midnight), 3,
      '当天关怀行被裁掉了 —— 日上限会越晚越数不准(she 可能一天喊他超过三次)')
    // 但普通行照旧只留 keep:豁免是**只给当天 care 行**的
    const rows = store.listAudit(0, 500)
    const manual = rows.filter((r) => r.toolCall !== 'care')
    assert.equal(manual.length, 20, '普通审计行该照旧裁到 20,实际 ' + manual.length)
    // 昨天的 care 行不豁免(不然这张表会年年长)
    const y = midnight - 86400
    store.writeAudit({ traceId: 'old-care', userInput: '昨天的关怀', toolCall: 'care' })
    store.setAuditKeep(20)
    const before = store.careCountSince(y)
    for (let i = 1; i <= 60; i++) {
      store.writeAudit({ traceId: 'turn2-' + i, userInput: '轮2 ' + i, toolCall: 'manual' })
    }
    assert.ok(store.careCountSince(y) <= before, '昨天的 care 行也该随窗口被裁')
  } finally { store.close() }
})

test('2026-09-29 日上限真相源改走 care_beats:当天开口几次 = 几行 sent 拍', () => {
  const store = openStore(':memory:')
  try {
    const d = new Date()
    d.setHours(0, 0, 0, 0)
    const midnight = d.getTime() / 1000
    assert.equal(store.careSentCountSince(midnight), 0)
    // 只有 reason='sent' 算"她真的开口了" —— 其它判词都是"她没说"
    store.careBeatAdd({ at: midnight + 60, kind: 'care', reason: 'sent', acted: true })
    store.careBeatAdd({ at: midnight + 120, kind: 'care', reason: 'sent', acted: true })
    store.careBeatAdd({ at: midnight + 130, kind: 'care', reason: 'daily-cap' })
    store.careBeatAdd({ at: midnight + 140, kind: 'care', reason: 'no-target' })
    store.careBeatAdd({ at: midnight - 5, kind: 'care', reason: 'sent', acted: true }) // 昨天
    assert.equal(store.careSentCountSince(midnight), 2, '只数当天、只数 sent')
    // 两条口径各自成立(交叉核对用):审计那侧看的是 care 行
    store.careBeatAdd({ at: midnight + 150, kind: 'care', reason: 'sent', acted: true, targetSessionId: 'her-session' })
    const beat = store.careBeatsSince(midnight, 10).find((b) => b.reason === 'sent')
    assert.equal(beat.targetSessionId, 'her-session', '台账要能回答"她投到哪条会话"')
    assert.equal(store.careBeatsSince(midnight, 10).filter((b) => b.targetSessionId === '').length, 4,
      '老拍/别的通道没带目标 ⇒ 空串,不是 undefined')
  } finally { store.close() }
})

test('2026-09-29 care_beats 补列:老库(没有 target_session_id)打开时幂等补上', () => {
  const dir = mkdtempSync(join(tmpdir(), 'echo-beats-'))
  const file = join(dir, 'old.db')
  try {
    const old = openStore(file)
    // 造一张"老形状"的表:把新列去掉(sqlite 3.35+ 支持 DROP COLUMN)
    old.db.exec('ALTER TABLE care_beats DROP COLUMN target_session_id')
    old.db.prepare("INSERT INTO care_beats (at, kind, reason) VALUES (?, 'care', 'sent')").run(1)
    old.close()
    const again = openStore(file) // 打开即迁移
    try {
      const cols = again.db.prepare('PRAGMA table_info(care_beats)').all().map((r) => r.name)
      assert.ok(cols.includes('target_session_id'), '老库该被补列')
      const rows = again.careBeatsSince(0, 10)
      assert.equal(rows.length, 1, '老拍还在')
      assert.equal(rows[0].targetSessionId, '', '老拍没记目标 ⇒ 空串')
    } finally { again.close() } // Windows 上文件被占着删不掉
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('2026-09-29 修:recentUserTurnAt 读 conversation_log(旧的审计判据恒为 0)', () => {
  const store = openStore(':memory:')
  try {
    const now = Date.now() / 1000
    // 他在这条会话里说过一句话 ⇒ 记的是 conversation_log 一行。
    // 真实现场:审计里他那些话记在 tool_call='extract' 上,而老判据要求
    // tool_call 为空 ⇒ **全库 0 命中** ⇒ 这个读数恒为 0(两处判据一起静默失效)。
    store.writeConversation({ sessionId: 's-know', userText: 'echo在吗', replyText: '在呢', channel: 'DSH' })
    assert.ok(store.recentUserTurnAt('s-know', now - 60) > 0, '他在这条会话说过话 ⇒ 要读得出来')
    assert.equal(store.recentUserTurnAt('s-other', now - 60), 0, '别的会话没有 ⇒ 0')
    assert.equal(store.recentUserTurnAt('s-know', now + 60), 0, '窗口下界之后的才算')
    // 反面:审计里那些"看着像他的话"的行**不该**再骗到这条读数(它换了账本)
    store.writeAudit({ traceId: 'x', userInput: 'echo在吗', sessionId: 's-audit', toolCall: 'extract' })
    assert.equal(store.recentUserTurnAt('s-audit', now - 60), 0, '判据只看 conversation_log')
  } finally { store.close() }
})

test('G22 画像字段数 = core_traits 的键数(不是表行数,那张表恒 1 行)', () => {
  const store = openStore(':memory:')
  try {
    // 空画像:0(以前会显示「1 项」—— COUNT(*) 数的是行,不是字段)
    assert.equal(store.memoryStats().profileFields, 0)
    // 常驻项只收白名单里的键('语言'/'代词'),称呼走 name 列
    const out = store.saveProfileTraits({ 语言: '中文', 代词: '他' })
    assert.deepEqual(out.dropped, [], '白名单内的键不该被丢:' + JSON.stringify(out))
    assert.deepEqual(out.saved.sort(), ['代词', '语言'].sort())
    assert.equal(store.memoryStats().profileFields, 2, '两个常驻项就该是 2')
    store.saveProfileTraits({ 语言: null })
    assert.equal(store.memoryStats().profileFields, 1)
    store.saveProfileTraits({ 代词: null })
    assert.equal(store.memoryStats().profileFields, 0)
  } finally { store.close() }
})

test('S10 审计六列:agent_state / latency / emotion_delta / injected_profile / emotion_pack 真的落列', () => {
  const store = openStore(':memory:')
  try {
    store.saveState({
      moodIntensity: 7, prevMoodIntensity: 5, userEmotion: 'happy', moodReason: '他夸我',
      currentTopic: '面试', emotionVector: { global: { fatigue: 3 } }
    })
    store.writeAudit({
      traceId: 'a1',
      userInput: '在吗',
      injectedProfile: '[他的称呼] 阿岚',
      injectedMemories: '【情景记忆】…',
      emotionPack: '- 身体与整体: 疲惫 3 /10(有点累)。',
      llmReply: '在的',
      latency: 1234,
      moodIntensity: 7, prevMoodIntensity: 5,
      emotionVector: { global: { fatigue: 3 } },
      emotionDelta: '整体[疲惫+1]; 对主人[爱意+0.5]',
      toolCall: 'extract'
    })
    const row = store.listAudit(0, 1)[0]
    assert.equal(row.injectedProfile, '[他的称呼] 阿岚')
    assert.equal(row.emotionPack, '- 身体与整体: 疲惫 3 /10(有点累)。')
    // 差分按 A 的短句原样落库、原样读出(不是 JSON)
    assert.equal(row.emotionDelta, '整体[疲惫+1]; 对主人[爱意+0.5]')
    assert.equal(row.llmReply, '在的')
    assert.equal(row.latency, 1234)
    // agent_state 没显式给 → 自动快照当前状态(面板要回答「她当时什么状态」)
    assert.ok(row.agentState && row.agentState.moodIntensity === 7)
    assert.equal(row.agentState.currentTopic, '面试')
    assert.equal(row.agentState.emotionVector.global.fatigue, 3)
    // 没给 latency → NULL 而不是 0(「没测到」与「零延迟」不是一回事)。
    // 同毫秒写入的 timestamp 会打平,按 traceId 取行,别赌排序。
    store.writeAudit({ traceId: 'a2', userInput: 'x' })
    const all = store.listAudit(0, 10)
    const a2 = all.find((r) => r.traceId === 'a2')
    assert.equal(a2.latency, null)
  } finally { store.close() }
})

test('S8 saveEmotionVector:只动向量两列,不碰心情/话题(A 的衰减循环同款)', () => {
  const store = openStore(':memory:')
  try {
    store.saveState({
      moodIntensity: 8, prevMoodIntensity: 4, userEmotion: 'anxious', moodReason: '他好久没来',
      currentTopic: '加班', emotionVector: { global: { fatigue: 9 } }
    })
    const before = store.getState()
    store.saveEmotionVector({ global: { fatigue: 3, valence: 2, arousal: 3 } }, before.emotionVector)
    const after = store.getState()
    assert.equal(after.moodIntensity, 8, '心情强度不该被衰减顺手打回 3')
    assert.equal(after.prevMoodIntensity, 4)
    assert.equal(after.userEmotion, 'anxious', '他最近的心情不该被清成 neutral')
    assert.equal(after.moodReason, '他好久没来')
    assert.equal(after.currentTopic, '加班', '话题不该被清空')
    assert.equal(after.emotionVector.global.fatigue, 3)
    assert.equal(after.previousEmotionVector.global.fatigue, 9, '衰减前的向量留档')
    assert.ok(after.updatedAt >= before.updatedAt, '衰减也要推进时钟(不然下次算不到时长)')
    assert.equal(store.saveEmotionVector({ global: { fatigue: 1 } }), true, '有状态行 → 落库成功')
    // 库刚建、还没聊过:没有 agent_state 行就没有可衰减的向量 ——
    // 刻意只 UPDATE 不插入(凭空造行会让面板显示一份假状态),返回 false。
    const empty = openStore(':memory:')
    try {
      assert.equal(empty.saveEmotionVector({ global: { fatigue: 1 } }), false)
      assert.equal(empty.getState().emotionVector, null)
    } finally { empty.close() }
  } finally { store.close() }
})

test('S11 主动轮哨兵:对话窗口里记的是哨兵而不是空串(反思信封靠它特判)', () => {
  const store = openStore(':memory:')
  try {
    store.writeConversation({ sessionId: 's', userText: '在吗', replyText: '在的' })
    store.writeConversation({ sessionId: 's', userText: PROACTIVE_ROUND_MARKER, replyText: '突然有点想你' })
    const turns = store.recentTurns('s', 5)
    assert.equal(turns.length, 2)
    assert.equal(turns[0].user, '在吗')
    assert.equal(turns[1].user, PROACTIVE_ROUND_MARKER)
    assert.equal(turns[1].assistant, '突然有点想你')
    assert.equal(PROACTIVE_ROUND_MARKER, '(她主动开口)') // A 的字面量,别改
  } finally { store.close() }
})

test('反思信封的「最近 5 轮」不许被宿主注入占满(2026-09-26 现场)', () => {
  // 活库实测:conversation_log 100 行里 44 行正文是宿主每轮注入的
  // runtime context。这里是反思信封的语境窗口 —— 不过滤的话,模型会把
  // 那段当成"他前几轮说过的话"。
  const store = openStore(':memory:')
  try {
    const noise = 'Current runtime context. This snapshot supersedes earlier runtime-context snapshots.'
    // 噪音**更晚**写进来(倒序取时排在前面)—— 若先取满再过滤,真轮次会被挤掉
    store.writeConversation({ sessionId: 's', userText: '阿岚，我今天很累', replyText: '那就早点睡' })
    for (let i = 0; i < 6; i += 1) {
      store.writeConversation({ sessionId: 's', userText: noise, replyText: '（宿主注入）' })
    }
    const turns = store.recentTurns('s', 5)
    assert.equal(turns.length, 1, '噪音不许占满窗口,实为 ' + turns.length + ' 条')
    assert.equal(turns[0].user, '阿岚，我今天很累')
    assert.ok(!turns.some((t) => t.user.includes('Current runtime context')))
  } finally { store.close() }
})

// ---- v0.18.3 M3:画像常驻锚点的写侧纪律(A `_apply_profile_update`)----

test('M3:常驻画像只收白名单键,非白名单键记 dropped 不落库', () => {
  const store = openStore(':memory:')
  try {
    const r = store.saveProfileTraits({ 语言: '中文', occupation: '做后端的' })
    assert.deepEqual(r.saved, ['语言'])
    assert.deepEqual(r.dropped, ['occupation'])
    assert.deepEqual(store.getProfile().coreTraits, ['语言:中文'])
    const raw = store.db.prepare('SELECT core_traits FROM user_profile WHERE user_id = ?').get(MASTER_ID)
    assert.deepEqual(Object.keys(JSON.parse(raw.core_traits)), ['语言'])
  } finally { store.close() }
})

test('M3:值截 32 字;null = 该特征失效删除', () => {
  const store = openStore(':memory:')
  try {
    store.saveProfileTraits({ 语言: '中'.repeat(60) })
    assert.equal(JSON.parse(store.db.prepare(
      'SELECT core_traits FROM user_profile WHERE user_id = ?').get(MASTER_ID).core_traits).语言.length, 32)
    store.saveProfileTraits({ 代词: '他' })
    assert.deepEqual(store.getProfile().coreTraits, ['语言:' + '中'.repeat(32), '代词:他'])
    const r = store.saveProfileTraits({ 语言: null })
    assert.deepEqual(r.removed, ['语言'])
    assert.deepEqual(store.getProfile().coreTraits, ['代词:他'])
  } finally { store.close() }
})

test('M3:读侧白名单 —— 旧库残留几十个键也不漏进 prompt(A v8.1)', () => {
  const store = openStore(':memory:')
  try {
    const junk = { 语言: '中文', 职业: '后端', 城市: '西安', 猫: '有', 记忆库问题: 'WAL未合并' }
    store.db.prepare(
      'INSERT INTO user_profile (user_id, core_traits, last_updated) VALUES (?, ?, ?)'
    ).run(MASTER_ID, JSON.stringify(junk), Date.now() / 1000)
    assert.deepEqual(store.getProfile().coreTraits, ['语言:中文'])
    store.saveProfileTraits({ 代词: '他' })
    const kept = JSON.parse(store.db.prepare(
      'SELECT core_traits FROM user_profile WHERE user_id = ?').get(MASTER_ID).core_traits)
    assert.ok(Object.keys(kept).length <= 5, '总数应回落到上限内,实为 ' + Object.keys(kept).length)
    assert.equal(kept.代词, '他')
  } finally { store.close() }
})

test('M3:坏数据不当真 —— 非 JSON / 空白值一律不渲染', () => {
  const store = openStore(':memory:')
  try {
    store.db.prepare(
      'INSERT INTO user_profile (user_id, core_traits, last_updated) VALUES (?, ?, ?)'
    ).run(MASTER_ID, 'not-json{', Date.now() / 1000)
    assert.equal(store.getProfile().coreTraits, null)
    store.saveProfileTraits({ 语言: '   ' })
    assert.equal(store.getProfile().coreTraits, null)
  } finally { store.close() }
})

// ---- v0.29.0 个人机器人裁剪:渠道维度随群聊拒收一起退役 ----
// 他的裁决:「彻底移除一切和群体相关的东西」。B 方案的渠道过滤失去了
// 要防的对象(群消息在入站闸就被拒收,根本进不了记忆),整组退役。

test('v0.29.0:新库不再建 channel 列,检索不再按渠道过滤', () => {
  const store = openStore(':memory:')
  try {
    const cols = store.db.prepare('PRAGMA table_info(episodic_memory)').all().map((r) => r.name)
    assert.ok(!cols.includes('channel'), '新库不该有 channel 列:' + cols.join(','))
    assert.ok(!cols.includes('channel_chat'), '新库不该有 channel_chat 列')
    store.insertMemory({ keywords: ['加班'], summary: '他今晚要加班到十点', emotionScore: 5 })
    // 只服务他一个人:所有记忆对所有轮次可见,没有「往哪儿渗」的问题
    assert.equal(store.retrieve('今晚要加班吗', 6, Date.now() / 1000).length, 1)
  } finally { store.close() }
})

// ── 2026-10-06:注入留痕与审计裁剪(报告 §5.4 的现场) ─────────────────────────
// 现场:`audit_logs.injected_memories` 活库 160 行**全空**,而 9-25 的备份里有内容。
// 两个原因各钉一条电池:① 注入块以前只在轮末反思成功那行落库(写入端修在 index.js,
// 接线由 tests/turn-snapshot.test.js 钉);② 单预算裁剪下,工具行的洪水会把证据行
// 挤出保留窗(就是下面这条)。

test('2026-10-06 审计裁剪分两个预算:工具行的洪水挤不掉证据行', () => {
  const store = openStore(':memory:', { auditKeep: 50 })
  try {
    // 120 行工具行(带产地标记)+ 61 行证据行(注入留痕 = 这一轮她读到了什么)
    for (let i = 0; i < 120; i++) {
      store.writeAudit({
        traceId: 'tool-' + i, sessionId: 'session-x',
        userInput: '(工具) pwsh {"command":"echo ' + i + '"}', toolCall: 'pwsh'
      })
    }
    for (let i = 0; i < 60; i++) {
      store.writeAudit({
        traceId: 'ev-' + i, sessionId: 'session-x', userInput: '第' + i + '句',
        injectedMemories: '【情景记忆】块' + i, toolCall: 'extract'
      })
    }
    store.writeAudit({
      traceId: 'ev-last', sessionId: 'session-x', userInput: '最后一句',
      injectedMemories: '【情景记忆】最后一块', toolCall: 'inject'
    })
    const rows = store.listAudit(0, 1000)
    const isTool = (r) => String(r.userInput || '').startsWith('(工具) ')
    const toolRows = rows.filter(isTool)
    const evRows = rows.filter((r) => !isTool(r))
    assert.equal(toolRows.length, 50, '工具行留最近 keep 条')
    assert.equal(evRows.length, 50, '证据行也留最近 keep 条(旧版会被工具行挤掉)')
    assert.equal(rows.length, 100, '表体量有界:2 × keep')
    // 报告里那个现场:最新一条注入留痕必须还在,而且原文完整读得出
    const last = rows.find((r) => r.traceId === 'ev-last')
    assert.ok(last !== undefined, '最新一条注入留痕不许被裁掉')
    assert.equal(last.injectedMemories, '【情景记忆】最后一块')
    assert.equal(last.toolCall, 'inject')
    // 最老的证据行(第 0 句)才该被裁 —— 裁的仍是"最旧",不是"按类别整体丢"
    assert.equal(rows.some((r) => r.traceId === 'ev-0'), false, '证据行照旧按时间裁最旧')
  } finally { store.close() }
})

test('2026-10-06 注入留痕行:原样进库、原样读出(纯文本,不是 JSON)', () => {
  const store = openStore(':memory:')
  try {
    const block = '[她的记忆与心情]\n【关联知识路径】\n1. A-[喜欢]-> B\n\n【情景记忆】\n- 他今天面试炸了'
    store.writeAudit({
      traceId: 'inj-1', sessionId: 'session-y', userInput: '今天面试怎么样',
      injectedMemories: block, injectedProfile: '[他的称呼] 阿岚',
      llmReply: '', latency: 812, toolCall: 'inject'
    })
    const row = store.listAudit(0, 1)[0]
    assert.equal(row.injectedMemories, block, '多行原文不许被 JSON 化或折叠')
    assert.equal(row.injectedProfile, '[他的称呼] 阿岚')
    assert.equal(row.latency, 812, '留痕行记的是这一轮检索+组装的耗时')
    assert.equal(row.toolCall, 'inject')
    assert.equal(row.llmReply, '', '留痕行不是回复 —— 空着,不编')
  } finally { store.close() }
})

/**
 * 2026-10-10 D(衰减留痕)的**反面门**。
 *
 * 衰减 tick 一天跑 48 拍,而 `tool_call='care'` 是**主动开口日上限的真相源**
 * (`store.js:1671` 的 `careCountSince` → `index.js:5464` 的 gates → CARE_DAILY_CAP)。
 * 所以衰减留痕**绝不能借 care 这个标签**:借了就等于"她今天已经开口 48 次",
 * 日上限立刻打满 ⇒ **她再也不会主动说话,而且不报错**。
 *
 * 这条用例把那个失败模式钉死:一批 emotion_decay 行进来,care 计数必须纹丝不动。
 */
test('2026-10-10 衰减留痕不许污染 care 日上限(借 care 标签 = 她再也不会主动开口)', () => {
  const store = openStore(':memory:')
  try {
    const d = new Date()
    d.setHours(0, 0, 0, 0)
    const midnight = d.getTime() / 1000
    // 今天真的开口 2 次
    store.writeAudit({ traceId: 'care-1', userInput: '关怀 1', toolCall: 'care' })
    store.writeAudit({ traceId: 'care-2', userInput: '关怀 2', toolCall: 'care' })
    assert.equal(store.careCountSince(midnight), 2)
    // 衰减 tick 跑满一天(48 拍)—— 全都用 emotion_decay
    for (let i = 1; i <= 48; i++) {
      store.writeAudit({
        traceId: 'emotion-decay-' + i,
        userInput: '(工具) emotion_decay 经过 0.50h',
        toolCall: 'emotion_decay',
        emotionDelta: '对主人[爱意-0.1]'
      })
    }
    assert.equal(store.careCountSince(midnight), 2,
      'care 计数被衰减行污染了 —— 日上限会误判为已用满,她将不再主动开口')
    // 而且衰减行自己查得出来(这就是 D 的目的)
    const rows = store.listAudit(0, 500).filter((r) => r.toolCall === 'emotion_decay')
    assert.equal(rows.length, 48, '衰减行该照常落库、可查询')
    assert.equal(rows[0].emotionDelta, '对主人[爱意-0.1]', 'emotion_delta 列要带上差分')
  } finally { store.close() }
})