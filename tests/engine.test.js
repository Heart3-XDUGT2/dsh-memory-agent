/**
 * M2-d 引擎门面:离线 battery 双态(PLAN M2-d 验收)。
 * 基线态(detect→null)/ Python 态(真 worker)/ offline(store 缺)/
 * 引擎中途死亡回落基线 —— 四个剧本全打真实件。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'

const { createEngine, collectSeeds, MAX_SEED_NAMES } = await import('../lib/engine.js')
const { openStore } = await import('../lib/store.js')
const { detectPython } = await import('../lib/sidecar-client.js')

async function freshStore () {
  const dir = mkdtempSync(join(tmpdir(), 'echo-engine-'))
  const dbPath = join(dir, 'echo.db')
  const store = openStore(dbPath)
  store.insertMemory({
    keywords: ['章鱼小丸子', '稀有'],
    summary: '他很难吃到章鱼小丸子,打算学着自己做',
    emotionScore: 8,
    source: 'dsh',
    temporalStatus: 'time_unknown'
  })
  return { dir, dbPath, store }
}

/** 假 subagents:回一段固定结构化输出(通道形状对齐 reflect.js)。
 *  v0.13.3 mock 逼真化:start 缺 parent 直接拒收 —— 宿主真服务要
 *  request.parent.session 建目录,此前 mock 来者不拒,测试全绿线上
 *  全死(mock 漂移)。mock 必须比宿主更严,漂移才在测试里炸。
 *  v0.13.5 同理加严:signal 必须是真 AbortSignal(provider 无条件读
 *  .aborted —— 阶段探针实锤的最后一层根因)。 */
function fakeSubagents (structured) {
  return {
    list: () => ['spawn'],
    start: async (provider, req) => {
      if (req?.parent === undefined) throw new Error('mock: subagents.start 缺 parent(宿主契约)')
      if (typeof req?.signal?.aborted !== 'boolean') throw new Error('mock: subagents.start 缺真 signal(宿主契约)')
      return {
        result: Promise.resolve({ stopReason: 'completed', structured }),
        dispose: async () => { }
      }
    }
  }
}

/** v0.14.1 F2/F3:录制型假子代理 —— 把交给模型的提示词原样存下来,
 *  供断言「当前时间锚 + 最近对话 5 轮」真的进了信封。 */
function recordingSubagents (structured, sink) {
  const inner = fakeSubagents(structured)
  return {
    list: inner.list,
    start: async (provider, req) => {
      const blocks = Array.isArray(req?.prompt) ? req.prompt : []
      sink.prompt = blocks.map((b) => String(b?.text ?? '')).join('\n')
      sink.req = req
      return await inner.start(provider, req)
    }
  }
}

const PARENT = { session: { id: 'engine-test' } }

async function waitFor (fn, timeoutMs = 8000, everyMs = 10) {
  const t0 = Date.now()
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() - t0 > timeoutMs) throw new Error('waitFor timeout')
    await new Promise((r) => setTimeout(r, everyMs))
  }
}

/** 测试收尾:先关引擎(杀 worker)、再关库句柄,最后删临时目录。 */
async function cleanup (engine, store, dir) {
  if (engine !== null) await engine.stop().catch(() => { })
  try { store.close() } catch { }
  rmSync(dir, { recursive: true, force: true })
}

test('基线态:探测不到 Python → M1 冻结链原样服务', async () => {
  const { dir, dbPath, store } = await freshStore()
  let engine = null
  try {
    engine = createEngine({ store, dbPath, detect: async () => null })
    assert.equal(await engine.init(), 'baseline')
    assert.equal(engine.state().mode, 'baseline')
    assert.equal(engine.state().python, null)
    // 检索:JS 基线渲染(M1 形状)
    const r = await engine.retrieve('章鱼小丸子')
    assert.equal(r.engine, 'baseline')
    assert.ok(r.text.includes('他很难吃到章鱼小丸子'))
    assert.ok(r.text.includes('[她的记忆与心情'))
    assert.ok(r.text.includes('[她此刻的状态]'))
    // 反思:基线 M1 链(假子代理 → 规整 → commitExtract 落库+状态+审计)
    const before = store.memoryStats().episodicActive
    const ack = await engine.reflect(fakeSubagents({
      keywords: ['测试'], summary: '他聊了测试的事', emotion_score: 6,
      emotion_state: 'happy', mood_intensity: 7, mood_reason: '开心',
      emotion_vector: { global: { valence: 3 }, target_master: { affection: 8 } }
    }), { userText: '测试', assistantText: '好的', parent: PARENT })
    assert.ok(ack.memoryId > 0)
    assert.equal(store.memoryStats().episodicActive, before + 1)
    assert.equal(store.getState().moodIntensity, 7)
    assert.ok(store.listAudit(0, 10).length >= 1)
    // subagents 缺席 → 反思跳过(增益不是依赖)
    assert.equal(await engine.reflect(undefined, { userText: 'x', assistantText: 'y', parent: PARENT }), null)
    // v0.13.3 宿主契约:缺 parent → 显式跳过(不再让 TypeError 沉底)
    assert.equal(await engine.reflect(fakeSubagents({}), { userText: 'x', assistantText: 'y' }), null)
  } finally { await cleanup(engine, store, dir) }
})

test('2026-10-07 修(P5c 同族):基线链落库也不许丢掉 emotion_vector 的额外键(ipc_dyad)', async () => {
  const { dir, dbPath, store } = await freshStore()
  let engine = null
  try {
    const seedVector = {
      global: { valence: 2, arousal: 3, fatigue: 2 },
      target_master: { affection: 8, dependency: 6, playfulness: 7, sadness: 0 },
      ipc_dyad: { other: { a: 0.3, c: 0.55 }, src: 'appraise@ipc-core', gate: 'green' }
    }
    store.saveState({ moodIntensity: 3, emotionVector: seedVector })
    engine = createEngine({ store, dbPath, detect: async () => null }) // 基线链(reflect.js 那条)
    assert.equal(await engine.init(), 'baseline')
    const ack = await engine.reflect(fakeSubagents({
      keywords: ['测试'], summary: '他聊了测试的事', emotion_score: 6,
      emotion_state: 'happy', mood_intensity: 7, mood_reason: '开心',
      emotion_vector: { global: { valence: 3 }, target_master: { affection: 8 } }
    }), { userText: '测试', assistantText: '好的', parent: PARENT })
    assert.ok(ack !== null)
    const after = store.getState().emotionVector
    assert.equal(after.global.valence, 3, '已知维照常按 LLM 给的落地')
    assert.deepEqual(after.ipc_dyad, seedVector.ipc_dyad,
      '额外键必须活过这一轮(否则面板永远看不到青点)')
  } finally { await cleanup(engine, store, dir) }
})

test('Python 态:真 worker 服务检索与写入链,壳侧落地状态与审计', async () => {
  const { dir, dbPath, store } = await freshStore()
  let engine = null
  try {
    engine = createEngine({ store, dbPath, detect: detectPython })
    const mode = await engine.init()
    if (mode !== 'python') {
      assert.fail('本机应有 Python(探测链 PATH 兜底),init 却回了 ' + mode)
    }
    const st = engine.state()
    assert.equal(st.mode, 'python')
    assert.ok(st.python.path)
    assert.equal(st.sidecar.running, true)
    // 检索:引擎渲染的情景段 + 壳侧状态段,同一封信
    const r = await engine.retrieve('章鱼小丸子')
    assert.equal(r.engine, 'python')
    assert.ok(r.text.includes('他很难吃到章鱼小丸子'))
    assert.ok(r.text.includes('[她此刻的状态]'))
    // 单写者:python 召回即强化(读库验证,不走 store.retrieve 防双写)
    const rc = store.db.prepare('SELECT recall_count FROM episodic_memory WHERE summary LIKE ?')
      .get('%章鱼小丸子%')
    assert.ok(rc.recall_count >= 1, '召回即强化:recall_count 应 ≥1,实为 ' + rc.recall_count)
    // 2026-10-07 修(P5c 同族)前置:像"轮末判定成功"那样先塞一个额外键进向量。
    // ⚠️ 夹具初始**没有 agent_state 行** ⇒ 必须用 saveState 建行(saveEmotionVector
    // 是只改两列的 UPDATE,没有行会静默返回 false —— 上一版这里就栽在这)。
    const seedVector = {
      global: { valence: 2, arousal: 3, fatigue: 2 },
      target_master: { affection: 8, dependency: 6, playfulness: 7, sadness: 0 },
      ipc_dyad: { other: { a: 0.3, c: 0.55 }, src: 'appraise@ipc-core', gate: 'green' }
    }
    store.saveState({ moodIntensity: 3, emotionVector: seedVector })
    // 反思:合并版载荷 → extract_commit(降级路径:无候选,情感分 6≥4 门卫)
    const ack = await engine.reflect(fakeSubagents({
      keywords: ['校园跑'], summary: '他说校园跑很累', emotion_score: 6,
      emotion_state: 'neutral', mood_intensity: 4, mood_reason: '',
      emotion_vector: { global: {}, target_master: {} },
      candidates: [], triples: [], pendingThreads: []
    }), { userText: '校园跑好累', assistantText: '辛苦啦', sessionId: 's-test', parent: PARENT })
    assert.equal(ack.written.length, 1)          // 降级写入
    assert.equal(ack.stats.degraded, true)
    assert.equal(ack.learned, 0)
    // 壳侧落地:agent_state(壳拥有的表)+ 审计
    assert.equal(store.getState().moodIntensity, 4)
    assert.equal(store.getState().userEmotion, 'neutral')
    assert.ok(store.listAudit(0, 10).length >= 1)
    // ⚠️ 2026-10-07 回归钉子(`lib/engine.js` 那条写者 = `applyExtractAck`):
    // 以前它用裸 `applyEmotionVector` ⇒ clamp 只重建已知维 ⇒ 把 `ipc_dyad` 抹掉
    // ⇒ 判定结果活不过下一轮反思,面板上的青点/六个量/残差卡永远"缺席"。
    assert.deepEqual(store.getState().emotionVector.ipc_dyad, seedVector.ipc_dyad,
      '额外键必须活过这一轮反思(engine.js 那条路)')
    const row = store.db.prepare('SELECT summary FROM episodic_memory WHERE summary LIKE ?')
      .get('%校园跑很累%')
    assert.ok(row)
    // 想念真值(M2-f):帧口径读即刷新;种一行锚在一小时前的想念
    const HOUR = 3600
    store.db.prepare(
      'INSERT INTO longing_state (user_id, value, anchor_at, updated_at,' +
      ' kicked, last_user_msg_at, last_care_at, care_count, session_id)' +
      " VALUES ('master', 0, ?, ?, 0, ?, 0, 0, '')"
    ).run(Date.now() / 1000 - HOUR, Date.now() / 1000 - HOUR, Date.now() / 1000 - HOUR)
    const lg = await engine.longing('master')
    assert.notEqual(lg, null)
    assert.equal(lg.exists, true)
    assert.ok(lg.value > 2 && lg.value < 5, 'M(1h)=2.5 附近,实为 ' + lg.value)
    // v0.6.0 先读后削:longingMessage 帧带回双值 —— pre(她等你时的
    // 值,注入【想念】行用)高于 post(你回来了,想念落地)
    const lmsg = await engine.longingMessage('master', '我回来啦', 's-test')
    assert.notEqual(lmsg, null)
    assert.equal(lmsg.ok, true)
    assert.equal(lmsg.pre.exists, true)
    assert.ok(lmsg.pre.value > 2, 'pre 应是削减前的爬升值,实为 ' + lmsg.pre.value)
    assert.ok(lmsg.post.value < lmsg.pre.value, '锚点重置后 post < pre')
    // 信封带钟面与想念行(v0.6.0):同一封信,顺序照 QQ 认知上下文
    const r2 = await engine.retrieve('章鱼小丸子', 6, {
      now: Date.now(),
      longingLine: '【想念】距离上次对话 1.0 小时,她想你想到 2.5/10 —— 让回复自然带出这份想念,不要报数值。'
    })
    assert.ok(r2.text.includes('【现在】'))
    assert.ok(r2.text.includes('【想念】距离上次对话 1.0 小时'))
    assert.ok(r2.text.indexOf('【现在】') < r2.text.indexOf('章鱼小丸子'))
    // 记忆工具族(M3-b):直教 → 翻查 → 遗忘,全帧往返
    const add = await engine.memoryAdd('master', '我下周三有算法面试,要复习图论', {})
    assert.notEqual(add, null)
    assert.ok(add.memoryId > 0)
    assert.equal(add.layer, 'L2')
    // 直教 = stability 稳定 → tier 1.0:教过的记很久(I≈88,
    // 比推断碎片 ≈3 重一个数量级 —— 用户肯亲口教就该这个待遇)
    assert.ok(add.I > 60, 'taught I 应 >60,实为 ' + add.I)
    assert.ok(add.keywords.includes('面试'))
    const found = await engine.memorySearch('master', '面试', 6)
    assert.equal(found.items.length, 1)
    assert.ok(found.items[0].summary.includes('算法面试'))
    assert.ok(found.reinforced >= 1) // 翻=想起=强化
    const gone = await engine.memoryForget('master', '面试')
    assert.equal(gone.ok, true)
    assert.equal(gone.forgotten.length, 1)
    const found2 = await engine.memorySearch('master', '面试', 6)
    assert.equal(found2.items.length, 0) // 想不起了
    // v0.18.3 M3:画像常驻锚点端到端 —— L0 language 候选 → 引擎 profileUpdate
    // → 壳侧落 core_traits(以前这一帧只打日志就丢了,语言/代词永远进不了她
    // 的常驻视野)。同时验证非白名单的 L0 字段不进常驻区。
    // 放在本用例末尾:这两条 L0 记忆价值高,会参与后面的检索断言。
    await engine.reflect(fakeSubagents({
      keywords: ['中文'], summary: '他说他平时说中文', emotion_score: 5,
      emotion_state: 'neutral', mood_intensity: 4, mood_reason: '',
      emotion_vector: { global: {}, target_master: {} },
      candidates: [
        { layer: 'L0', field: 'language', summary: '中文', confidence: 0.9,
          certainty: 'explicit', attribution: 'user_explicit', stability: 'stable',
          shouldWrite: true, evidenceQuotes: ['我平时说中文'], temporal_status: 'enduring' },
        { layer: 'L0', field: 'occupation', summary: '做后端的', confidence: 0.9,
          certainty: 'explicit', attribution: 'user_explicit', stability: 'stable',
          shouldWrite: true, evidenceQuotes: ['我做后端的'], temporal_status: 'enduring' }
      ],
      triples: [], pendingThreads: []
    }), { userText: '我平时说中文', assistantText: '嗯', sessionId: 's-test', parent: PARENT })
    assert.deepEqual(store.getProfile().coreTraits, ['语言:中文'],
      '只有 语言/代词 进常驻画像,occupation 归记忆层')
    // 基线态没有引擎 → null(路由回落 JS 复刻)
  } finally { await cleanup(engine, store, dir) }
})

test('F1 图谱接线:反思学边 → 检索想起 → 路径进信 → 轮末回传,库真值变化', async () => {
  const { dir, dbPath, store } = await freshStore()
  let engine = null
  try {
    engine = createEngine({ store, dbPath, detect: detectPython })
    if (await engine.init() !== 'python') assert.fail('本机应有 Python,init 却没回 python')
    // ① 反思把一条关系型知识学进图(过 validate_triple + 五道门)
    const ack = await engine.reflect(fakeSubagents({
      keywords: ['章鱼小丸子'], summary: '他说他最喜欢吃章鱼小丸子', emotion_score: 7,
      emotion_state: 'happy', mood_intensity: 6, mood_reason: '开心',
      emotion_vector: { global: {}, target_master: {} },
      candidates: [], pendingThreads: [],
      triples: [{
        s: '用户', relation: '最喜欢吃', t: '章鱼小丸子',
        layer: 'L2', certainty: 'explicit', attribution: 'user_explicit',
        stability: 'stable', shouldWrite: true,
        evidenceQuotes: ['嗯，我喜欢吃章鱼小丸子']
      }]
    }), { userText: '嗯，我喜欢吃章鱼小丸子', assistantText: '记下了', sessionId: 's-graph', parent: PARENT })
    assert.equal(ack.learned, 1, '三元组应学进图,实为 ' + ack.learned)
    // ② 检索同一话题 → 图谱直扫命中种子 → 【关联知识路径】与【情景记忆】
    //    同信,且顺序照 QQ 认知上下文(路径在前)。
    //    调用形状必须照现场:壳每轮都传 now: Date.now()(**毫秒**)——
    //    引擎侧要的是秒,单位换算就在这条路径上(v0.14.2 的事故点)。
    const r = await engine.retrieve('章鱼小丸子', 6, { now: Date.now() })
    assert.equal(r.engine, 'python')
    assert.ok(r.text.includes('【关联知识路径】'), '路径段应进信')
    assert.ok(r.text.includes('【情景记忆】'), '情景段应进信')
    assert.ok(r.text.indexOf('【关联知识路径】') < r.text.indexOf('【情景记忆】'),
      '路径段应在情景段之前(QQ 认知上下文顺序)')
    assert.ok(r.text.includes('章鱼小丸子'))
    assert.ok(Array.isArray(r.graphHits.hitEdgeIds))
    assert.ok(r.graphHits.hitEdgeIds.length >= 1, '本轮想起的边应带回 graphHits')
    assert.ok(typeof r.graphHits.pathsText === 'string', '节点/谓词文本也该带回 graphHits(关怀路 [可以接的线] 用它)')
    assert.ok(r.graphHits.ltpEdgeIds.length >= 1, '路径边应进 LTP 集')
    // ③ 轮末回传:apply_ltp 权重增强 + 时钟前移(库真值,不是渲染层现算)
    const edgeId = r.graphHits.ltpEdgeIds[0]
    const before = store.db.prepare('SELECT weight, last_accessed, recall_count FROM graph_edges WHERE edge_id = ?').get(edgeId)
    const rg = await engine.reinforceGraph(r.graphHits)
    assert.notEqual(rg, null)
    assert.ok(rg.ltp >= 1, 'LTP 应至少增强一条边,实为 ' + rg.ltp)
    assert.ok(rg.reinforced >= 1, '应有边被强化/时钟前移,实为 ' + rg.reinforced)
    const after = store.db.prepare('SELECT weight, last_accessed, recall_count FROM graph_edges WHERE edge_id = ?').get(edgeId)
    assert.ok(after.weight > before.weight, 'LTP:权重应涨 ' + before.weight + ' → ' + after.weight)
    assert.ok(after.recall_count > before.recall_count, '召回次数应 +1')
    // ④ v0.14.4 S3:没想起任何边(null/空集)**也照发帧** —— 引擎的
    //    物化(10 分钟桶把 R 写进 activation)与剪枝(1 小时桶清从未
    //    想起的噪声)就挂在这一帧上,A 侧 brain_pipeline.py:1424 每轮
    //    无条件调用;此前「空集即 return null」让桶在没有命中边的轮次
    //    里停摆(面板活跃度与库真值越拖越不一致)。
    const rgEmpty = await engine.reinforceGraph({ hitEdgeIds: [], ltpEdgeIds: [] })
    assert.notEqual(rgEmpty, null, '空集也要发帧(物化/剪枝桶靠它推进)')
    assert.equal(rgEmpty.type, 'graph_reinforce_result')
    assert.equal(rgEmpty.reinforced, 0, '空集不该强化任何边')
    const rgNull = await engine.reinforceGraph(null)
    assert.notEqual(rgNull, null, 'null 入参按空集处理,同样发帧')
    // ⑤ v0.14.2 单位事故回归:把边的时钟推回**过去的秒级时间戳**
    //    (现实形态 —— 新建边的 last_accessed=0 会走 now 兜底,恰好
    //    躲过这一枪,所以只有老边暴露)。壳曾把 Date.now() 毫秒当
    //    now 传给 graph_query,引擎按秒算 Δt → R 恒为 0 → 边全被判
    //    「休眠」不扩散,注入里只剩置顶的核心边(A 侧 v8.9.3 法医
    //    记录的症状:186 轮 BFS 零扩散)。
    store.db.prepare('UPDATE graph_edges SET last_accessed = ? WHERE edge_id = ?')
      .run(Math.floor(Date.now() / 1000) - 10 * 3600, edgeId) // 10 小时前
    const r3 = await engine.retrieve('章鱼小丸子', 6, { now: Date.now() })
    assert.ok(r3.text.includes('【关联知识路径】'),
      '有历史时钟的老边也要能扩散出路径(毫秒当秒传会让 R 归零)')
    assert.ok(r3.graphHits.ltpEdgeIds.includes(edgeId),
      'LTP 集只装非置顶的**渲染出的**路径边 —— 它空了就是扩散死了')
  } finally { await cleanup(engine, store, dir) }
})

test('F6 种子收集(纯函数):强制占位的 L0 不入种子、去重、限量、显式优先', () => {
  // 现场:BFS 每轮贡献 0 条路径,因为通道②从没接上、通道③只吐垃圾。
  assert.deepEqual(collectSeeds([], null), [])
  assert.deepEqual(collectSeeds(null, null), [])
  // 取非强制项的 keywords
  assert.deepEqual(
    collectSeeds([{ keywords: ['章鱼小丸子', '夜宵'], forced: false }], null),
    ['章鱼小丸子', '夜宵'])
  // 强制占位的 L0 跳过(它是无条件注入的身份背景,不是这一轮的话题)
  assert.deepEqual(
    collectSeeds([
      { keywords: ['阿岚', '称呼'], forced: true },
      { keywords: ['章鱼小丸子'], forced: false }
    ], null),
    ['章鱼小丸子'])
  // 去重 + 去空 + 显式给的排前面
  assert.deepEqual(
    collectSeeds([{ keywords: ['a', 'a', '  ', 'b', null] }], ['x', 'a']),
    ['x', 'a', 'b'])
  // 超长词丢掉(那是摘要不是实体名)
  assert.deepEqual(collectSeeds([{ keywords: ['x'.repeat(40), 'ok'] }], null), ['ok'])
  // 限量
  const many = [{ keywords: Array.from({ length: 40 }, (_, i) => 'k' + i) }]
  assert.equal(collectSeeds(many, null).length, MAX_SEED_NAMES)
})

test('F6 图谱种子通道②接线:查询字面不含节点名,靠检索到的记忆关键词走图', async () => {
  const { dir, dbPath, store } = await freshStore()
  let engine = null
  try {
    engine = createEngine({ store, dbPath, detect: detectPython })
    if (await engine.init() !== 'python') assert.fail('本机应有 Python,init 却没回 python')
    // ① 学一条边:用户 -[最喜欢吃]-> 章鱼小丸子
    const ack = await engine.reflect(fakeSubagents({
      keywords: ['章鱼小丸子'], summary: '他说他最喜欢吃章鱼小丸子', emotion_score: 7,
      emotion_state: 'happy', mood_intensity: 6, mood_reason: '开心',
      emotion_vector: { global: {}, target_master: {} },
      candidates: [], pendingThreads: [],
      triples: [{
        s: '用户', relation: '最喜欢吃', t: '章鱼小丸子',
        layer: 'L2', certainty: 'explicit', attribution: 'user_explicit',
        stability: 'stable', shouldWrite: true,
        evidenceQuotes: ['嗯，我喜欢吃章鱼小丸子']
      }]
    }), { userText: '嗯，我喜欢吃章鱼小丸子', assistantText: '记下了', sessionId: 's-seed', parent: PARENT })
    assert.equal(ack.learned, 1, '三元组应学进图,实为 ' + ack.learned)

    // ② freshStore 那条记忆的 keywords = ['章鱼小丸子', '稀有']。
    //    拿「稀有」当查询:**字面不含节点名「章鱼小丸子」** ⇒ 通道①(直扫)
    //    和通道③(机械切分)都够不着它;只有通道②(来自检索结果的关键词)
    //    能把它捞出来。
    const memKws = store.db.prepare(
      'SELECT keywords FROM episodic_memory WHERE is_active = 1').all()
    assert.ok(memKws.some((r) => String(r.keywords).includes('章鱼小丸子')),
      '前提:库里那条记忆的关键词含「章鱼小丸子」')
    const q = '稀有'
    assert.ok(!q.includes('章鱼小丸子'), '前提:查询本身没有节点名')

    const r = await engine.retrieve(q, 6, { now: Date.now() })
    assert.equal(r.engine, 'python')
    assert.ok(r.text.includes('【情景记忆】'), '那条记忆该被检索到(否则没有种子)')
    assert.ok(r.text.includes('【关联知识路径】'), '图那段该亮 —— 通道②接上了')
    assert.ok(r.graphHits.hitEdgeIds.length >= 1,
      'BFS 该走出边(此前恒为空:BFS 每轮贡献 0 路径)')
    assert.ok(r.text.includes('章鱼小丸子'),
      '路径里该出现「章鱼小丸子」—— 种子来自刚检索到的记忆的关键词')
    assert.ok(r.graphHits.ltpEdgeIds.length >= 1, '路径边该进 LTP 集')
  } finally { await cleanup(engine, store, dir) }
})

test('F2/F3 反思信封:当前时间锚 + 最近对话 5 轮(更早的丢弃)', async () => {
  const { dir, dbPath, store } = await freshStore()
  let engine = null
  try {
    engine = createEngine({ store, dbPath, detect: async () => null })
    assert.equal(await engine.init(), 'baseline')
    // 写 7 轮:反思只该看到最后 5 轮(当前轮已在日志里 —— 轮末先写
    // 日志后起火,所以不额外补一次,免得同一个回合出现两遍)
    for (let i = 1; i <= 7; i++) {
      store.writeConversation({
        sessionId: 's-f23', channel: '私聊',
        userText: '第' + i + '句:我想吃章鱼小丸子', replyText: '第' + i + '句回复:好呀'
      })
    }
    const sink = {}
    const ack = await engine.reflect(recordingSubagents({
      keywords: ['章鱼小丸子'], summary: '他说想吃章鱼小丸子', emotion_score: 6,
      emotion_state: 'happy', mood_intensity: 5, mood_reason: '想吃',
      emotion_vector: { global: {}, target_master: {} }
    }, sink), {
      userText: '第7句:我想吃章鱼小丸子', assistantText: '第7句回复:好呀',
      sessionId: 's-f23', parent: PARENT
    })
    assert.notEqual(ack, null)
    // A 侧 Judge 信封形状(brain_pipeline.py:1950-1956)
    assert.ok(sink.prompt.includes('conversationId: s-f23'))
    assert.match(sink.prompt, /当前时间：\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} 周[日一二三四五六]/)
    assert.ok(sink.prompt.includes('最近对话：'))
    assert.ok(sink.prompt.includes('第 5 轮：'))
    assert.ok(!sink.prompt.includes('第 6 轮：'), '只喂 5 轮')
    assert.ok(!sink.prompt.includes('第1句'), '更早的轮次不进信封')
    assert.ok(sink.prompt.includes('第3句'), '5 轮 = 第 3~7 句')
    assert.ok(sink.prompt.includes('第7句'), '当前轮在里面')
    assert.ok(sink.prompt.includes('[上一轮结束时的情绪向量]'), '情绪向量照旧进信')
    // 顺序:conversationId → 当前时间 → 最近对话
    const at = (s) => sink.prompt.indexOf(s)
    assert.ok(at('conversationId') < at('当前时间：'))
    assert.ok(at('当前时间：') < at('最近对话：'))
  } finally { await cleanup(engine, store, dir) }
})

test('offline 态:库打不开 → 检索/反思全跳过,人格不陪葬', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'echo-engine-off-'))
  let engine = null
  try {
    engine = createEngine({ store: null, dbPath: join(dir, 'x.db'), detect: async () => null })
    assert.equal(await engine.init(), 'offline')
    assert.equal(await engine.retrieve('随便'), null)
    assert.equal(await engine.reflect(fakeSubagents({}), { userText: 'x', assistantText: 'y', parent: PARENT }), null)
    assert.equal(engine.state().mode, 'offline')
  } finally {
    if (engine !== null) await engine.stop().catch(() => { })
    rmSync(dir, { recursive: true, force: true })
  }
})

test('降级链:Python 中途死亡 → 检索回落基线,反思回落 M1 链', async () => {
  const { dir, dbPath, store } = await freshStore()
  let engine = null
  try {
    engine = createEngine({
      store, dbPath, detect: detectPython,
      clientOpts: { restartBackoffMs: 60000 } // 死透窗口拉长:回落可测
    })
    assert.equal(await engine.init(), 'python')
    // 击杀 worker → 门面看到明确死透 → 本轮回落基线
    process.kill(engine.state().sidecar.pid)
    await waitFor(() => engine.state().sidecar.running === false)
    const r = await engine.retrieve('章鱼小丸子')
    assert.equal(r.engine, 'baseline')          // 回落,不是跳过
    assert.ok(r.text.includes('他很难吃到章鱼小丸子'))
    // 反思同样回落 M1 链
    const ack = await engine.reflect(fakeSubagents({
      keywords: ['回落'], summary: '回落链也活着', emotion_score: 5,
      emotion_state: 'neutral', mood_intensity: 3, mood_reason: '',
      emotion_vector: {}
    }), { userText: 'x', assistantText: 'y', parent: PARENT })
    assert.ok(ack.memoryId > 0)
  } finally { await cleanup(engine, store, dir) }
})

test('S1 反思整固:两帧成对(判触发 → 组提示词 → 守卫落库 → 推游标)', async () => {
  const { dir, dbPath, store } = await freshStore()
  let engine = null
  try {
    engine = createEngine({ store, dbPath, detect: detectPython })
    if (await engine.init() !== 'python') assert.fail('本机应有 Python,init 却没回 python')

    // ① 窗口里只有一条情感分 8 的记忆 → 重要性 8 < 阈值 30,不触发。
    //    时钟必须钉成白天:夜窗(23-8 且距上次整固 >12h)本身就会触发,
    //    拿 Date.now() 断言「不触发」会在半夜自己变红(踩过一次)。
    const daytime = new Date()
    daytime.setHours(14, 0, 0, 0)
    const p0 = await engine.reflectionPrompt(daytime.getTime())
    assert.notEqual(p0, null)
    assert.equal(p0.triggered, false)
    assert.equal(p0.reason, 'below_threshold')

    // ② 攒够重要性(6 条 × 7 = 42 ≥ 30)→ 触发,提示词就是 reflection.py 的原件
    for (let i = 0; i < 5; i++) {
      store.insertMemory({
        keywords: ['整固' + i],
        summary: '待整固的第 ' + i + ' 条',
        emotionScore: 7,
        source: 'dsh',
        temporalStatus: 'time_unknown'
      })
    }
    const p1 = await engine.reflectionPrompt(Date.now())
    assert.equal(p1.triggered, true)
    assert.ok(String(p1.systemPrompt).includes('记忆整固模块'))
    assert.ok(String(p1.userPrompt).includes('[待整固的记忆]'))
    assert.ok(Array.isArray(p1.candidateIds) && p1.candidateIds.length >= 6,
      '候选窗口应带编号,实为 ' + JSON.stringify(p1.candidateIds))

    // ③ 空载荷 → 不推游标(丢记忆比慢一拍严重;下轮重试)
    const empty = await engine.reflectionCommit([], Date.now())
    assert.equal(empty.written, 0)
    assert.equal(empty.cursorAdvanced, false)

    // ④ 游标没动 → 同一批候选还能再触发一次(「下轮重试」真的成立)
    const p2 = await engine.reflectionPrompt(Date.now())
    assert.equal(p2.triggered, true)
    assert.deepEqual(p2.candidateIds, p1.candidateIds, '游标不动则窗口不漂移')

    // ⑤ 有效条目:洞察 + ongoing → 落库为 reflection 层 + 进她的议程簿
    const ids = p1.candidateIds.slice(0, 3)
    const ack = await engine.reflectionCommit([
      { kind: 'insight', summary: '他在连着折腾记忆系统', evidence_ids: ids, keywords: '记忆', ongoing: true }
    ], Date.now())
    assert.equal(ack.written, 1)
    assert.equal(ack.agenda, 1)
    assert.equal(ack.cursorAdvanced, true)
    assert.equal(ack.cursor, p1.candidateIds[p1.candidateIds.length - 1])
    const row = store.db.prepare(
      "SELECT summary, layer, evidence FROM episodic_memory WHERE layer = 'reflection'").get()
    assert.ok(row && row.summary === '他在连着折腾记忆系统')
    assert.ok(String(row.evidence).includes('依据:记忆'))
    const agenda = store.db.prepare(
      "SELECT content FROM her_agenda WHERE is_active = 1 AND origin = 'reflection'").get()
    assert.equal(agenda.content, '他在连着折腾记忆系统')

    // ⑥ 游标推过窗口 → 下一轮没有候选,不再触发(不会反复嚼同一批)
    const p3 = await engine.reflectionPrompt(Date.now())
    assert.equal(p3.triggered, false)
    assert.equal(p3.reason, 'no_candidates')

    // ⑦ 没有在飞的整固轮 → commit 是帧层错误(门面回 null,壳不会瞎写)
    assert.equal(await engine.reflectionCommit([{ kind: 'insight', summary: 'x', evidence_ids: [] }], Date.now()), null)
  } finally { await cleanup(engine, store, dir) }
})

test('v0.15.1 G14/G15:话题登记/结掉与整库清空的帧级接线(真 worker)', async () => {
  const { dir, dbPath, store } = await freshStore()
  let engine = null
  try {
    engine = createEngine({ store, dbPath, detect: detectPython })
    if (await engine.init() !== 'python') assert.fail('本机应有 Python,init 却没回 python')

    // ① 初始:没有悬置话题(如实空数组,不是 null)
    const empty = await engine.threadsList(20)
    assert.notEqual(empty, null)
    assert.deepEqual(empty.items, [])

    // ② 登记:不带时间 → followUpAfter=0(永不主动提,只留记录)
    const added = await engine.threadsAdd('下个月一起去看樱花', 's-test')
    assert.notEqual(added, null)
    assert.ok(added.threadId > 0)
    assert.equal(added.created, true)
    // 同一句再登记 → 不重复建(A 的幂等:同一件事不该排两条)
    const again = await engine.threadsAdd('下个月一起去看樱花', 's-test')
    assert.equal(again.created, false)
    assert.equal(again.threadId, added.threadId)

    const listed = await engine.threadsList(20)
    assert.equal(listed.items.length, 1)
    assert.equal(listed.items[0].content, '下个月一起去看樱花')
    assert.equal(listed.items[0].followUpAfter, 0)

    // ③ 结掉:双向子串同一把尺子;没匹配上如实回 threadId=null,不新建
    const done = await engine.threadsDone('樱花')
    assert.notEqual(done, null)
    assert.equal(done.threadId, added.threadId)
    const miss = await engine.threadsDone('完全无关的事')
    assert.equal(miss.threadId, null)
    assert.deepEqual((await engine.threadsList(20)).items, [])

    // ④ 整库清空:清掉的是**注入内容**——验证注入信里真的不再有那条记忆
    const before = await engine.retrieve('章鱼小丸子')
    assert.ok(before.text.includes('他很难吃到章鱼小丸子'))
    const cleared = await engine.memoryClear()
    assert.notEqual(cleared, null)
    assert.equal(cleared.episodic, 1)
    const after = await engine.retrieve('章鱼小丸子')
    assert.ok(!after.text.includes('他很难吃到章鱼小丸子'),
      '清空后注入信里不许再有那条记忆:' + after.text.slice(0, 200))
    // 库侧真值:行没了(A 的 _clear_all 是物理删,不是打标记)
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM episodic_memory').get().n, 0)
    // 图谱/话题/审计不在清空范围内(A 同款边界)
    assert.ok(store.db.prepare('SELECT COUNT(*) AS n FROM audit_logs').get().n >= 0)
    // 空库再清一次:如实回 0,不炸(v0.29.0:includeMembers 参数随群聊退役)
    const again2 = await engine.memoryClear()
    assert.equal(again2.episodic, 0)
  } finally { await cleanup(engine, store, dir) }
})

/**
 * 2026-09-30(实测见 docs/RETRIEVAL_OPT_2026-09-30.md):
 * 「常驻不占席」这一项**真的要穿到 python 侧**才算数 —— 这层壳最容易出的错是
 * 设置改了、帧里没带,于是面板上开着而行为一点没变(老坑:`must_say` 那种"假开关")。
 * 所以这里走**真 worker**:同一问法、同一库,只翻 coreBlock,断言**顺序真的变了**。
 */
test('检索三项真的穿到 python:coreBlock 翻转时,常驻块从"最前"挪到"最后"', async () => {
  const { dir, dbPath, store } = await freshStore()
  let engine = null
  try {
    // 一条 L0 长期身份 + 一条会命中的常规记忆
    const coreId = store.insertMemory({
      keywords: ['身份'], summary: '他叫我 echo,我是他的陪伴', layer: 'L0',
      intrinsicValue: 90, emotionScore: 3, source: 'dsh'
    })
    assert.ok(coreId > 0, 'L0 那条要插进去')
    engine = createEngine({ store, dbPath, detect: detectPython })
    if (await engine.init() !== 'python') assert.fail('本机应有 Python')

    const off = await engine.retrieve('章鱼小丸子', 6, {
      retrievalOpts: { coreBlock: false }
    })
    const on = await engine.retrieve('章鱼小丸子', 6, {
      retrievalOpts: { coreBlock: true, fusion: { enabled: true, mode: 'reorder', lexArm: true } }
    })
    // `engine.retrieve` 对外只给渲染好的 text(单一事实源在引擎侧)⇒ 按**行序**断言。
    const pos = (text, needle) => String(text).indexOf(needle)
    const CORE = '他叫我 echo'
    const EVID = '他很难吃到章鱼小丸子'
    for (const [name, r] of [['off', off], ['on', on]]) {
      assert.ok(pos(r.text, CORE) >= 0, name + ':常驻那条要在注入信里')
      assert.ok(pos(r.text, EVID) >= 0, name + ':证据那条要在注入信里')
    }
    assert.ok(pos(off.text, CORE) < pos(off.text, EVID),
      '老行为:常驻 L0 渲染在证据**前面**(占席)')
    assert.ok(pos(on.text, CORE) > pos(on.text, EVID),
      '新行为:常驻块渲染在证据**后面**(不占证据席)')

    // ---- RT11b(2026-09-30):查询扩展真的穿到 python 吗 ----
    // 造一条"问法一个字都不重、只与扩展词同字面"的记忆;它只该在**带扩展词**时进榜。
    store.insertMemory({
      keywords: ['深夜'], summary: '深夜 熬夜 夜聊 熬到很晚',
      emotionScore: 5, source: 'dsh'
    })
    const noExp = await engine.retrieve('今天天气怎么样', 3, {
      retrievalOpts: { coreBlock: true, expandTerms: null }
    })
    const withExp = await engine.retrieve('今天天气怎么样', 3, {
      retrievalOpts: { coreBlock: true, expandTerms: ['深夜', '熬夜', '夜聊'] }
    })
    const NIGHT = '熬夜 夜聊'
    assert.ok(!String(noExp.text).includes(NIGHT),
      '没给扩展词:那条不许进注入信(词面撞不上)')
    assert.ok(String(withExp.text).includes(NIGHT),
      '给了扩展词:那条应当被捞进注入信(' + String(withExp.text).slice(0, 200) + ')')
  } finally { await cleanup(engine, store, dir) }
})
