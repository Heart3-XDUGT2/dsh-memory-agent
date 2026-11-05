/**
 * v0.5.0 「关怀心跳」(M3-a):投递层双通道的离线电池。
 * 引擎/代理全用假件(心跳模块依赖注入,不碰宿主包);store 用真件
 * (日上限的真相源在审计表)。对齐先例:dsh-schedule 的维护相认领
 * 与 followup 投递纪律。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { isolateTestHome, assertHomeIsolated } from './fixtures/test-home.js'

// 2026-09-30 测试隔离:先隔离 `DSH_HOME`,再**动态** import 库模块。
// `lib/toggle.js` 的 CONFIG_PATH / `lib/persona.js` 的 DATA_DIR 是模块级常量,
// 首次 import 时就按当时的 DSH_HOME 定死 —— 静态 import 会先于下一行执行,
// 那就又读到真机 config.json 了(真机上 `proactiveScoring.enabled=true`,会把
// 本文件里"该走老路"的用例判成 no-topic)。
const TEST_HOME = isolateTestHome()
const { CONFIG_PATH } = await import('../lib/toggle.js')
assertHomeIsolated(CONFIG_PATH)
const { openStore, MASTER_ID } = await import('../lib/store.js')
const {
  createHeartbeat, renderCareFraming, renderRemindFraming,
  HEARTBEAT_INTERVAL_MS, CARE_DAILY_CAP, PROACTIVE_SCORING_OFF
} = await import('../lib/heartbeat.js')

const NOW = () => Date.now() / 1000

function freshStore () {
  const store = openStore(':memory:')
  store.db.prepare("INSERT INTO user_profile (user_id, name) VALUES (?, '阿岚')").run(MASTER_ID)
  return store
}

/** 假引擎:剧本化响应 + 调用留痕(断言因果链用)。 */
function fakeEngine (script = {}) {
  const calls = []
  // v0.14.4 S4/S5:参数留痕 —— 断言「配置与兴趣真的喂到引擎帧」。
  const seen = { tick: undefined, care: undefined, agendaPick: undefined }
  return {
    calls,
    seen,
    async threadsRemindable () { calls.push('remindable'); return { items: script.remindable ?? [] } },
    async threadsMark (id) { calls.push('threadsMark:' + id) },
    async longingTick (cfg) { calls.push('tick'); seen.tick = cfg },
    async longing (userId, cfg) { calls.push('longing'); seen.longing = cfg; return script.longing ?? null },
    async agendaPick (userId, opts) { calls.push('agendaPick'); seen.agendaPick = { userId, ...(opts || {}) }; return script.agenda ?? null },
    async agendaMark (id) { calls.push('agendaMark:' + id) },
    async longingCare (userId, cfg) { calls.push('care'); seen.care = cfg }
  }
}

/** 假代理:schedule 的 runMaintenance/followup 契约(busy → 抛)。 */
function fakeAgent (sid, { busy = false } = {}) {
  const sent = []
  return {
    session: { id: sid },
    sent,
    runMaintenance (cb) {
      if (busy) throw new Error('maintenance busy')
      return Promise.resolve(cb()).then(() => true)
    },
    followup (msg) { sent.push(msg) }
  }
}

const fakeCreateUserMessage = (m) => ({ role: 'user', ...m })

function makeHeartbeat (engine, store, opts = {}) {
  return createHeartbeat({
    engine, store, logger: null,
    isEnabled: opts.isEnabled ?? (() => true),
    createUserMessage: fakeCreateUserMessage,
    masterId: MASTER_ID,
    // v0.14.4 S4/S5:壳注入的调参与兴趣提供者(缺省 = 不传,旧行为)
    getLongingConfig: opts.getLongingConfig,
    getInterests: opts.getInterests,
    // 2026-09-30 测试隔离:默认**显式**注入"打分器关着" —— 用例自带环境。
    // 不注入就会回落到 readSettings() 读真机配置:真机开着打分器时,
    // 这里每一拍都会被打分器改成 no-topic(20 条红的根因)。
    getProactiveScoring: opts.getProactiveScoring ?? (() => PROACTIVE_SCORING_OFF)
  })
}

const careState = (over = {}) => ({
  value: 8.2, threshold: 5.5, sinceMessage: 41400, sessionId: 'sess-1',
  shouldCare: true, ...over
})

test('心跳常量:60s 一跳,关怀日上限 3(Mio 护栏先例)', () => {
  assert.equal(HEARTBEAT_INTERVAL_MS, 60000)
  assert.equal(CARE_DAILY_CAP, 3)
})

test('提醒通道:到点约定必发,发送成功才落账,本轮不叠关怀', async () => {
  const store = freshStore()
  const engine = fakeEngine({ remindable: [
    { thread_id: 5, content: '明天提醒我跑步', session_id: 'sess-1' },
    { thread_id: 9, content: '别人的会话', session_id: 'sess-other' }
  ] })
  const agent = fakeAgent('sess-1')
  try {
    await makeHeartbeat(engine, store).tick(agent)
    // 会话路由:只提「这个会话」的约定
    assert.equal(agent.sent.length, 1)
    const text = agent.sent[0].content[0].text
    assert.ok(text.startsWith('[ECHO REMIND]'))
    assert.ok(text.includes('明天提醒我跑步'))
    assert.ok(!text.includes('别人的会话'))
    assert.ok(text.includes('reminders_json:'))
    // 两相提交:发送成功才 mark(5 落账,9 不归它管)
    assert.deepEqual(engine.calls, ['remindable', 'threadsMark:5'])
    // 审计留痕:tool_call='remind'
    const audits = store.listAudit(0, 10)
    assert.equal(audits.length, 1)
    assert.equal(audits[0].toolCall, 'remind')
    // 提醒已发,本轮不查想念(不打扰的另一半:一次只说一件事)
    assert.ok(!engine.calls.includes('longing'))
  } finally { store.close() }
})

test('提醒通道:投递忙 → 不落账留池,下轮重试(宁可漏提不烦人)', async () => {
  const store = freshStore()
  const engine = fakeEngine({ remindable: [{ thread_id: 5, content: 'x', session_id: 'sess-1' }] })
  const agent = fakeAgent('sess-1', { busy: true })
  try {
    await makeHeartbeat(engine, store).tick(agent)
    assert.equal(agent.sent.length, 0)
    assert.deepEqual(engine.calls, ['remindable']) // mark 没调 —— 留池
    assert.equal(store.listAudit(0, 10).length, 0)
  } finally { store.close() }
})

test('关怀通道:想念过阈值 + 会话匹配 → 她开口,缓解+降权**等 ack 才落**(v0.18.1 C5)', async () => {
  const store = freshStore()
  const engine = fakeEngine({
    longing: careState(),
    agenda: { itemId: 3, content: '想让他讲讲面试结果' }
  })
  const agent = fakeAgent('sess-1')
  const hb = makeHeartbeat(engine, store)
  try {
    await hb.tick(agent)
    assert.equal(agent.sent.length, 1)
    const text = agent.sent[0].content[0].text
    assert.ok(text.startsWith('[ECHO CARE]'))
    assert.ok(text.includes('"value":8.2'))
    assert.ok(text.includes('agenda_json: {"itemId":3'))
    assert.ok(text.includes('想让他讲讲面试结果'))
    // 投递成功只到「排进了她这一轮」—— 她的正文还没有,更没送到他手机上。
    // A 侧纪律:发送成功才降权(`main.py:1836-1841`「她没说出口就不算提过」)。
    assert.deepEqual(engine.calls,
      ['remindable', 'tick', 'longing', 'agendaPick'])
    assert.equal(hb.pendingCareCount(), 1)
    const audits = store.listAudit(0, 10)
    assert.equal(audits[0].toolCall, 'care')
    assert.equal(store.careCountSince(0), 1)
    // 适配器 ack = 真的送到他手机上了 ⇒ 这一刻才算「她说过」
    await hb.noteProactiveAcked([{ kind: 'proactive', sessionId: 'sess-1' }])
    assert.deepEqual(engine.calls,
      ['remindable', 'tick', 'longing', 'agendaPick', 'agendaMark:3', 'care'])
    assert.equal(hb.pendingCareCount(), 0, '账兑现了就不该再挂着')
  } finally { store.close() }
})

test('C5 反例:reply 的 ack、别的会话的 ack 都不兑现关怀账', async () => {
  const store = freshStore()
  const engine = fakeEngine({
    longing: careState(), agenda: { itemId: 3, content: 'x' }
  })
  const hb = makeHeartbeat(engine, store)
  try {
    await hb.tick(fakeAgent('sess-1'))
    assert.equal(hb.pendingCareCount(), 1)
    // ① 回话的 ack(不是她主动说的那条)
    await hb.noteProactiveAcked([{ kind: 'reply', sessionId: 'sess-1' }])
    assert.equal(hb.pendingCareCount(), 1)
    assert.ok(!engine.calls.includes('care'), '回话送达不该给她"说过关怀"的账')
    // ② 另一个会话的 ack
    await hb.noteProactiveAcked([{ kind: 'proactive', sessionId: 'sess-other' }])
    assert.equal(hb.pendingCareCount(), 1)
    assert.ok(!engine.calls.includes('care'))
    // ③ 本会话的主动 ack 才兑现
    await hb.noteProactiveAcked([{ kind: 'proactive', sessionId: 'sess-1' }])
    assert.equal(hb.pendingCareCount(), 0)
    assert.ok(engine.calls.includes('agendaMark:3'))
    assert.ok(engine.calls.includes('care'))
  } finally { store.close() }
})

test('S4/S5 传参:想念配置与她的兴趣真的喂到引擎帧(此前一个都不传)', async () => {
  const store = freshStore()
  const engine = fakeEngine({
    longing: careState(),
    agenda: { itemId: 3, content: '想让他讲讲面试结果' }
  })
  const agent = fakeAgent('sess-1')
  const CFG = {
    enabled: true, half_life_hours: 6, threshold: 5, msg_drop: 3,
    care_relief: 0.4, protest_kick: 2, cooldown_minutes: 30,
    night_hold: false, demo_rate: 4
  }
  try {
    // 情绪向量先落库:断言它原样交给 agendaPick(引擎侧靠它算 moody ×1.5)
    store.saveState({
      moodIntensity: 6, prevMoodIntensity: 5,
      emotionVector: { target_master: { affection: 8, sadness: 4 } }
    })
    const hb = makeHeartbeat(engine, store, {
      getLongingConfig: () => CFG,
      getInterests: () => ['写代码', '看番']
    })
    await hb.tick(agent)
    assert.equal(agent.sent.length, 1)
    assert.deepEqual(engine.seen.tick, CFG, '想念配置必须原样进 longing_tick')
    assert.deepEqual(engine.seen.longing, CFG, '读(判定/展示)也得用同一份配置,否则两套数学')
    // v0.18.1:care 帧由 ack 触发(发送成功才落账),所以补一次 ack 再断言配置
    await hb.noteProactiveAcked([{ kind: 'proactive', sessionId: 'sess-1' }])
    assert.deepEqual(engine.seen.care, CFG, '关怀帧同样带配置(引擎侧 merge_config 靠它)')
    assert.equal(engine.seen.agendaPick.userId, MASTER_ID)
    assert.deepEqual(engine.seen.agendaPick.vector, { target_master: { affection: 8, sadness: 4 } })
    assert.deepEqual(engine.seen.agendaPick.interests, ['写代码', '看番'])
  } finally { store.close() }
})

test('S4/S5 缺省:没有提供者时两个参数都是空(不塞 undefined 进帧)', async () => {
  const store = freshStore()
  const engine = fakeEngine({ longing: careState(), agenda: null })
  const agent = fakeAgent('sess-1')
  const hb = makeHeartbeat(engine, store)
  try {
    await hb.tick(agent)
    assert.equal(engine.seen.tick, null)
    assert.equal(engine.seen.agendaPick.userId, MASTER_ID)
    assert.equal(engine.seen.agendaPick.vector, null)   // store 里没有向量
    assert.deepEqual(engine.seen.agendaPick.interests, [])
    await hb.noteProactiveAcked([{ kind: 'proactive', sessionId: 'sess-1' }])
    assert.equal(engine.seen.care, null)
  } finally { store.close() }
})

test('关怀通道:无议程选题也照开口(纯想念,agenda_json: null)', async () => {
  const store = freshStore()
  const engine = fakeEngine({ longing: careState(), agenda: { itemId: null, content: null } })
  const agent = fakeAgent('sess-1')
  const hb = makeHeartbeat(engine, store)
  try {
    await hb.tick(agent)
    assert.equal(agent.sent.length, 1)
    const text = agent.sent[0].content[0].text
    assert.ok(text.includes('agenda_json: null'))
    assert.ok(!engine.calls.includes('agendaMark'))
    await hb.noteProactiveAcked([{ kind: 'proactive', sessionId: 'sess-1' }])
    assert.ok(engine.calls.includes('care'))
    assert.ok(!engine.calls.includes('agendaMark'), '没有选题就不该有降权调用')
  } finally { store.close() }
})

test('C2 话头行:最新反思信念比状态行新 → [最近聊到] 用它(A 侧 main.py:1800-1811)', async () => {
  const store = freshStore()
  const engine = fakeEngine({ longing: careState(), agenda: null })
  const agent = fakeAgent('sess-1')
  const now = NOW()
  try {
    // 状态行的话题是旧的,反思行更新 ⇒ 用反思那条
    store.saveState({ moodIntensity: 4, currentTopic: '(状态行里的话题)' })
    store.db.prepare('UPDATE agent_state SET updated_at = ?').run(now - 3600)
    store.insertMemory({
      keywords: ['秋招'], summary: '他在准备秋招面试', emotionScore: 4,
      layer: 'reflection', timestamp: now - 60
    })
    await makeHeartbeat(engine, store).tick(agent)
    assert.equal(agent.sent.length, 1)
    const text = agent.sent[0].content[0].text
    assert.ok(text.includes('[最近聊到] 他在准备秋招面试(这几件都可以当由头,不必只用最后一件)'),
      '话头行要照 A 侧逐字,且优先用反思信念')
    assert.ok(!text.includes('(状态行里的话题)'))
  } finally { store.close() }
})

test('C2 话头行:反思比状态行旧 → 退回状态行的 current_topic', async () => {
  const store = freshStore()
  const engine = fakeEngine({ longing: careState(), agenda: null })
  const agent = fakeAgent('sess-1')
  const now = NOW()
  try {
    store.saveState({ moodIntensity: 4, currentTopic: '他下午有宣讲会' })
    store.db.prepare('UPDATE agent_state SET updated_at = ?').run(now)
    store.insertMemory({
      keywords: ['旧'], summary: '很久以前的反思', emotionScore: 3,
      layer: 'reflection', timestamp: now - 7200
    })
    await makeHeartbeat(engine, store).tick(agent)
    const text = agent.sent[0].content[0].text
    assert.ok(text.includes('[最近聊到] 他下午有宣讲会(这几件都可以当由头,不必只用最后一件)'))
    assert.ok(!text.includes('很久以前的反思'))
  } finally { store.close() }
})

test('C2 话头行:什么都没有时整行消失(不留空标签)', async () => {
  const store = freshStore()
  const engine = fakeEngine({ longing: careState(), agenda: null })
  const agent = fakeAgent('sess-1')
  try {
    await makeHeartbeat(engine, store).tick(agent)
    const text = agent.sent[0].content[0].text
    assert.ok(!text.includes('[最近聊到]'), '没有话头就不该出现这一行')
  } finally { store.close() }
})

test('开口目标:投到**她那一条会话**,不是这一拍抽到的那条(2026-09-29 换掉旧闸)', async () => {
  const store = freshStore()
  // 引擎说该开口,"她锚的会话"是 sess-other(他最后说话的那条,已关掉/不在跑)
  const engine = fakeEngine({ longing: careState({ sessionId: 'sess-other' }), agenda: null })
  const tickAgent = fakeAgent('sess-1')       // 这一拍 tick 抽到的会话
  const herAgent = fakeAgent('her-session')   // 她那一条(壳注入的解析器给的就是它)
  try {
    const hb = createHeartbeat({
      engine, store, logger: null, isEnabled: () => true,
      createUserMessage: fakeCreateUserMessage, masterId: MASTER_ID,
      resolveCareTarget: async () => ({ agent: herAgent, sessionId: 'her-session' }),
      // 2026-09-30 测试隔离:这条测的是**开口目标**,打分器必须显式关着 ——
      // 否则真机配置 enabled=true 时这一拍会先被打分器判成 no-topic。
      getProactiveScoring: () => PROACTIVE_SCORING_OFF
    })
    await hb.tick(tickAgent)
    // 旧行为:两个身份不相等 ⇒ 一个字都不发。新行为:照发,而且发进她那一条。
    assert.equal(tickAgent.sent.length, 0, '不要往"抽到的那条会话"里塞')
    assert.equal(herAgent.sent.length, 1, '要投到她那一条会话')
    // 缓解(longingCare)照旧等 ack 才落 —— 这里不该已经调过
    assert.ok(!engine.calls.includes('care'))
  } finally { store.close() }
})

test('开口目标:注入了却拿不到 ⇒ no-target 留账,不开口(不静默)', async () => {
  const store = freshStore()
  const engine = fakeEngine({ longing: careState(), agenda: null })
  const agent = fakeAgent('sess-1')
  try {
    const hb = createHeartbeat({
      engine, store, logger: null, isEnabled: () => true,
      createUserMessage: fakeCreateUserMessage, masterId: MASTER_ID,
      resolveCareTarget: async () => { throw new Error('sessionController 不可用') },
      getProactiveScoring: () => PROACTIVE_SCORING_OFF // 测试隔离:测 no-target,不测打分
    })
    await hb.tick(agent)
    assert.equal(agent.sent.length, 0)
    assert.deepEqual(store.careBeatsSince(0).map((b) => b.reason), ['no-target'])
    assert.equal(hb.careTrace().reason, 'no-target')
  } finally { store.close() }
})

test('护栏层:今日关怀已达上限 → 闭嘴(她自己的台账是真相源)', async () => {
  const store = freshStore()
  const engine = fakeEngine({ longing: careState(), agenda: null })
  const agent = fakeAgent('sess-1')
  try {
    // 上限判据 = care_beats 里 reason='sent' 的拍(2026-09-29 改;
    // 此前数 audit_logs,而那张表是全局 100 行滚动窗,会被别的会话挤掉)
    for (let i = 0; i < CARE_DAILY_CAP; i++) {
      store.careBeatAdd({ at: NOW(), kind: 'care', reason: 'sent', acted: true })
    }
    await makeHeartbeat(engine, store).tick(agent)
    assert.equal(agent.sent.length, 0)
    assert.ok(!engine.calls.includes('care'))
    // 昨天的不算:上限按本地午夜切
    store.db.prepare('UPDATE care_beats SET at = ?').run(NOW() - 86400 * 2)
    await makeHeartbeat(engine, store).tick(agent)
    assert.equal(agent.sent.length, 1)
  } finally { store.close() }
})

test('闸门链:休眠不开口;引擎不在不开口;未过阈值不开口', async () => {
  const store = freshStore()
  const agent = fakeAgent('sess-1')
  try {
    const sleeping = makeHeartbeat(fakeEngine({ longing: careState() }), store, { isEnabled: () => false })
    await sleeping.tick(agent)
    assert.equal(agent.sent.length, 0)

    const noEngine = makeHeartbeat(fakeEngine({ longing: null }), store)
    await noEngine.tick(agent)
    assert.equal(agent.sent.length, 0)

    const calm = makeHeartbeat(fakeEngine({ longing: careState({ shouldCare: false }) }), store)
    await calm.tick(agent)
    assert.equal(agent.sent.length, 0)
  } finally { store.close() }
})

// ── 2026-09-30 P2:话题打分器接线(默认关 = 零行为变化;开了才走新路)──────────

/** 固定钟面(2026-09-28 15:00 本地)—— 打分是**时间**判据,测试必须能拨。 */
const P2_AT = () => new Date(2026, 8, 28, 15, 0, 0, 0).getTime()

/** 直接种一条**会被打分器选中**的记忆(打分的候选池读的就是这张表)。
 *  ⚠️ 记忆候选的分数**出不了 0.6**(具体性只有 0.2、悬置性按天算几乎为 0,
 *  上界 ≈0.56)—— 这是打分器设计的**真实结论**,不是测试写错:所以"能过线"
 *  的那两条用例得用**日记**(artifact,具体性 1)来种。 */
function seedMemory (store, { agoSec = 7200, emotion = 9, summary = '他今天面试那家店给了回复' } = {}) {
  store.db.prepare(
    'INSERT INTO episodic_memory (user_id, keywords, summary, emotion_score, timestamp, is_active, status, layer)'
    + " VALUES (?, '面试', ?, ?, ?, 1, 'active', '')"
  ).run(MASTER_ID, summary, emotion, P2_AT() / 1000 - agoSec)
}

/** 种一条**今天的日记**(artifact:具体性满分 ⇒ 能真过 0.6 的线)。
 *  `mood` 决定它的 emotionScore(×2,见 `topic-score.js diaryCandidates` 的注释):
 *  mood=4 ⇒ 8;mood=1 ⇒ 2。 */
function seedDiary (store, { agoSec = 6 * 3600, mood = 4, text = '今天他坐了夜车回家' } = {}) {
  store.db.prepare('INSERT INTO diary (date, content, mood, longing_value, created_at) VALUES (?, ?, ?, 3, ?)')
    .run('2026-09-28', text, mood, P2_AT() / 1000 - agoSec)
}

const SCORING_ON = (over = {}) => ({
  enabled: true, threshold: 0.6, reviewEnabled: true, reviewDelta: 0.08,
  reviewBudgetPerDay: 6, sourceFloor: 5, windowHours: 72, cooldownMin: 180,
  wUnstale: 0.25, wGap: 0.15, wConcreteness: 0.20, wRecency: 0.15, wFreshness: 0.15, wEmotion: 0.10,
  ...over
})

/** 带 P2 两个注入的心跳(其余与 makeHeartbeat 同款)。 */
function makeScoringHeartbeat (engine, store, opts = {}) {
  return createHeartbeat({
    engine, store, logger: null, isEnabled: () => true, now: opts.now ?? P2_AT,
    createUserMessage: fakeCreateUserMessage, masterId: MASTER_ID,
    getProactiveScoring: opts.getProactiveScoring ?? (() => SCORING_ON()),
    reviewTopic: opts.reviewTopic
  })
}

test('P2:打分器关着(默认)⇒ 零行为变化:走老路、账上没有打分读数', async () => {
  const store = freshStore()
  try {
    seedDiary(store)
    // 注入一个"永远被调用"的复核桩:关着时它**一次都不该被叫到**
    let reviewed = 0
    const hb = makeScoringHeartbeat(fakeEngine({ longing: careState() }), store, {
      getProactiveScoring: () => ({ ...SCORING_ON(), enabled: false }),
      reviewTopic: async () => { reviewed += 1; return { ok: true, speak: true, why: '' } }
    })
    const agent = fakeAgent('sess-1')
    await hb.tick(agent)
    assert.equal(agent.sent.length, 1, '关着 = 老路(引擎说该开口就开口,不打分)')
    const row = store.careBeatsSince(0, 10)[0]
    assert.equal(row.reason, 'sent')
    assert.equal(row.candidates, 0, '关着 ⇒ 候选数 0(这一拍没打分)')
    assert.equal(row.topScore, 0)
    assert.equal(row.rejectedBy, '')
    assert.equal(row.topicId, '')
    assert.equal(row.payload.reviewed, undefined, '没打分就不该有 reviewed 标记')
    assert.equal(reviewed, 0, '关着就不许花任何模型调用')
    // 反过来:完全不注入 getProactiveScoring(旧装机位/测试位)也必须是老路。
    // 这一拍走的就是 heartbeat 内部那条 readSettings() 回落 —— 而回落读的是**盘上的
    // config.json**。所以这里**自己**往隔离后的临时 HOME 写一份已知配置,判据就与
    // 真机/种子配置无关了:enabled=false ⇒ 回落 = 关着 ⇒ 老路。
    // (不这么钉的话,一台 `enabled=true` 的机器上这条会红 —— 那正是本次要修的毛病。)
    // 用完**还原**(可能本来就有种子 config —— 后面还有用例要跑,别把环境拆了)。
    const cfgFile = join(TEST_HOME, 'echo', 'config.json')
    const cfgBefore = existsSync(cfgFile) ? readFileSync(cfgFile, 'utf8') : null
    try {
      writeFileSync(cfgFile, JSON.stringify({ settings: { proactiveScoring: { enabled: false } } }) + '\n')
      const hb2 = createHeartbeat({
        engine: fakeEngine({ longing: careState() }), store, logger: null,
        isEnabled: () => true, now: P2_AT,
        createUserMessage: fakeCreateUserMessage, masterId: MASTER_ID
      })
      const agent2 = fakeAgent('sess-1')
      await hb2.tick(agent2)
      assert.equal(agent2.sent.length, 1, '回落读到关着 ⇒ 老路')
    } finally {
      if (cfgBefore === null) rmSync(cfgFile, { force: true })
      else writeFileSync(cfgFile, cfgBefore)
    }
  } finally { store.close() }
})

test('P2:开着 ⇒ 本地分过线就开口,四列读数落账、话题取代议程簿当开场', async () => {
  const store = freshStore()
  try {
    seedDiary(store, { agoSec: 6 * 3600 }) // 分 ≈0.66
    let reviewed = 0
    const hb = makeScoringHeartbeat(fakeEngine({ longing: careState() }), store, {
      // ⚠️ 线压到 0.5 是为了**离边缘区远一点**:真实分(日记 ≈0.66)在出厂线 0.6
      //    的 ±0.08 里,本来就该走复核(那条在下一个用例)。这条测的是"明显过线"。
      getProactiveScoring: () => SCORING_ON({ threshold: 0.5 }),
      reviewTopic: async () => { reviewed += 1; return { ok: true, speak: true, why: '' } }
    })
    const agent = fakeAgent('sess-1')
    await hb.tick(agent)
    assert.equal(agent.sent.length, 1, '本地分过线 ⇒ 照常开口')
    assert.equal(reviewed, 0, '明显过线 ⇒ 不该花复核')
    const row = store.careBeatsSince(0, 10)[0]
    assert.equal(row.reason, 'sent', '开口仍是 sent(复核通过也不新增枚举)')
    assert.equal(row.acted, true)
    assert.equal(row.candidates, 1, '候选数落账')
    assert.ok(row.topScore >= 0.5, 'top_score 落账:' + row.topScore)
    assert.equal(row.rejectedBy, '', '开口了就没有"被谁判掉"')
    assert.equal(row.topicId, 'diary:2026-09-28', 'topic_id 记那条候选是谁')
    assert.equal(row.payload.reviewed, false, '明显过线不走复核 ⇒ reviewed=false')
    assert.ok(row.payload.why && row.payload.why.unstale, 'why 逐维贡献进 payload(可解释)')
    // 想念两列**一个字不动**(新分数另走 top_score —— 同行双读数)
    assert.equal(row.value, 8.2)
    assert.equal(row.threshold, 5.5)
    // 挑中的话题取代议程簿当开场(喂进 framing 的 agenda 段)
    const text = agent.sent[0].content[0].text
    assert.ok(text.includes('今天他坐了夜车回家'), 'framing 要带上挑中的话题')
    assert.ok(text.includes('agenda_json'), '走的就是既有那条 agenda 段')
  } finally { store.close() }
})

test('P2:边缘区 ⇒ 花一次复核;复核说"说" ⇒ reason 仍 sent + payload.reviewed=true', async () => {
  const store = freshStore()
  try {
    seedDiary(store, { agoSec: 9.5 * 3600 }) // 分 ≈0.65 ⇒ 落进 0.6±0.08 的边缘区
    let seen = null
    const hb = makeScoringHeartbeat(fakeEngine({ longing: careState() }), store, {
      reviewTopic: async (opts) => { seen = opts; return { ok: true, speak: true, why: '有真实内容' } }
    })
    const agent = fakeAgent('sess-1')
    await hb.tick(agent)
    assert.ok(seen !== null, '边缘区必须触发一次复核')
    assert.equal(seen.candidate.id, 'diary:2026-09-28')
    assert.ok(seen.threshold === 0.6)
    assert.equal(agent.sent.length, 1)
    const row = store.careBeatsSince(0, 10)[0]
    assert.equal(row.reason, 'sent')
    assert.equal(row.payload.reviewed, true, '复核通过并开口 ⇒ payload 记 reviewed:true')
    assert.equal(row.payload.reviewWhy, '有真实内容')
  } finally { store.close() }
})

test('P2:复核没过 / 复核超时 ⇒ no-topic-after-review,归因 review,不许硬说', async () => {
  for (const verdict of [
    { ok: true, speak: false, why: '像催他回应' }, // 复核判"不说"
    { ok: false, speak: false, why: 'timeout', timedOut: true } // 超时 = 未过
  ]) {
    const store = freshStore()
    try {
      seedDiary(store, { agoSec: 9.5 * 3600 })
      const hb = makeScoringHeartbeat(fakeEngine({ longing: careState() }), store, {
        reviewTopic: async () => verdict
      })
      const agent = fakeAgent('sess-1')
      await hb.tick(agent)
      assert.equal(agent.sent.length, 0, '复核没过 ⇒ 不开口(沉默是合法结果)')
      const row = store.careBeatsSince(0, 10)[0]
      assert.equal(row.reason, 'no-topic-after-review')
      assert.equal(row.acted, false)
      assert.equal(row.rejectedBy, 'review', '归因:复核判掉的')
      assert.equal(row.topicId, 'diary:2026-09-28')
      assert.ok(row.topScore > 0)
      assert.equal(row.value, 8.2, '想念读数照记(不是"没读数")')
    } finally { store.close() }
  }
})

test('P2:本地分没过 ⇒ no-topic(归因 local);池子空也是 no-topic', async () => {
  const store = freshStore()
  try {
    // 一条**在窗口内但分不够**的日记(mood=1 ⇒ 分 ≈0.575,池里有它、线过不去)
    // + 一条出窗口的记忆(连池都进不去)
    seedDiary(store, { agoSec: 72 * 3600, mood: 1 })
    seedMemory(store, { agoSec: 60 * 24 * 3600, emotion: 1, summary: '很久以前的一件小事' })
    let reviewed = 0
    const hb = makeScoringHeartbeat(fakeEngine({ longing: careState() }), store, {
      reviewTopic: async () => { reviewed += 1; return { ok: true, speak: true, why: '' } }
    })
    const agent = fakeAgent('sess-1')
    await hb.tick(agent)
    assert.equal(agent.sent.length, 0)
    assert.equal(reviewed, 0, '本地明显没过 ⇒ 不许花复核')
    const row = store.careBeatsSince(0, 10)[0]
    assert.equal(row.reason, 'no-topic')
    assert.equal(row.rejectedBy, 'local')
    assert.equal(row.candidates, 1, '出窗口的记忆不进池,今天的日记在池里(但没过线)')
    assert.equal(row.topScore, 0, '没过线 ⇒ top_score 记 0(能过线的才写分)')
    assert.equal(row.topicId, '', '没过线就没有"挑中的那条"')
  } finally { store.close() }

  const store2 = freshStore()
  try {
    // 池子**空**(数据库里什么都没种)⇒ 也是 no-topic
    const hb = makeScoringHeartbeat(fakeEngine({ longing: careState() }), store2)
    const agent = fakeAgent('sess-1')
    await hb.tick(agent)
    assert.equal(agent.sent.length, 0)
    assert.deepEqual(store2.careBeatsSince(0, 10).map((b) => b.reason), ['no-topic'])
  } finally { store2.close() }
})

/** 把**复核**日额度用光:今天已经有 6 拍 payload.reviewed=true。
 *  ⚠️ 种在**昨天**,否则它会同时把「今天开口 3 次」的护栏喂满 —— 那一闸在打分器
 *  **之前**,于是这一拍根本走不到打分那一步(`daily-cap`)。日额度只看 payload,
 *  不看日期在哪一天里的位置,所以放昨天照样占额度。 */
function useUpReviewBudget (store) {
  for (let i = 0; i < 6; i++) {
    store.careBeatAdd({
      at: P2_AT() / 1000 - 86400 - i, kind: 'care', reason: 'sent', acted: true,
      traceId: 'seed-review-' + i, payload: { reviewed: true }
    })
  }
}

/** 这一拍自己写下的那一行(种子行的 at 更早,所以不能用 careBeatsSince[0])。 */
const tickRow = (store) => store.careBeatsSince(0, 50).find((b) => b.traceId !== '' && !b.traceId.startsWith('seed-'))

test('P2:日额度只管**复核**那一步,不许拦她过线的开口', async () => {
  const store = freshStore()
  try {
    seedDiary(store, { agoSec: 6 * 3600 }) // 分 ≈0.66
    useUpReviewBudget(store)
    let reviewed = 0
    const hb = makeScoringHeartbeat(fakeEngine({ longing: careState() }), store, {
      // 线压到 0.5 ⇒ 离边缘区远(额度那一步根本不参与)
      getProactiveScoring: () => SCORING_ON({ threshold: 0.5 }),
      reviewTopic: async () => { reviewed += 1; return { ok: true, speak: true, why: '' } }
    })
    const agent = fakeAgent('sess-1')
    await hb.tick(agent)
    assert.equal(reviewed, 0, '额度用完 ⇒ 一次都不许调模型')
    assert.equal(agent.sent.length, 1, '本地明显过线 ⇒ 照常开口(额度只管复核那一步)')
    const row = tickRow(store)
    assert.equal(row.reason, 'sent')
    assert.equal(row.payload.reviewed, false, '没过复核这条路 ⇒ reviewed=false')
    assert.equal(row.rejectedBy, '')
  } finally { store.close() }
})

test('P2:额度用完 + 边缘区 ⇒ 不开口(按本地分判 = 没过线),不许降级成"硬说"', async () => {
  const store = freshStore()
  try {
    seedDiary(store, { agoSec: 9.5 * 3600 }) // 分 ≈0.657
    useUpReviewBudget(store)
    let reviewed = 0
    const hb = makeScoringHeartbeat(fakeEngine({ longing: careState() }), store, {
      // 线抬到 0.7 ⇒ 0.657 落进 ±0.08 的边缘区(但本地线也没过)
      getProactiveScoring: () => SCORING_ON({ threshold: 0.7 }),
      reviewTopic: async () => { reviewed += 1; return { ok: true, speak: true, why: '' } }
    })
    const agent = fakeAgent('sess-1')
    await hb.tick(agent)
    assert.equal(reviewed, 0, '额度用完 ⇒ 一次都不许调模型')
    assert.equal(agent.sent.length, 0, '边缘区 + 没额度 ⇒ 沉默(不许硬说)')
    const row = tickRow(store)
    assert.equal(row.reason, 'no-topic', '退成本地判:没过线就是 no-topic')
    assert.equal(row.rejectedBy, 'local')
  } finally { store.close() }
})

test('P2:复核没接上(壳没注入)⇒ 边缘区判"不说",绝不降级成硬说', async () => {
  const store = freshStore()
  try {
    seedDiary(store, { agoSec: 9.5 * 3600 })
    const hb = makeScoringHeartbeat(fakeEngine({ longing: careState() }), store, { reviewTopic: null })
    const agent = fakeAgent('sess-1')
    await hb.tick(agent)
    assert.equal(agent.sent.length, 0)
    const row = store.careBeatsSince(0, 10)[0]
    assert.equal(row.reason, 'no-topic-after-review')
    assert.equal(row.rejectedBy, 'review')
    assert.equal(row.payload.review, 'no-run', '要写清是"复核这条路没接上"')
  } finally { store.close() }
})

test('P2:打分器自己炸了 ⇒ 这一拍不开口,但**必须留痕**(不许变成查不出来的静默)', async () => {
  const store = freshStore()
  try {
    seedDiary(store, { agoSec: 6 * 3600 })
    const hb = makeScoringHeartbeat(fakeEngine({ longing: careState() }), store, {
      // `windowHours` 给一个**读不动的值**(Symbol 过不了 Number())⇒ 打分那一段
      // 真的抛错。注意读配置那一步(`scoringCfg`)自己是有 try/catch 的(读不出来
      // 就当关着),所以这里炸的是**打分**本身,不是读配置。
      getProactiveScoring: () => SCORING_ON({ windowHours: Symbol('bad') })
    })
    const agent = fakeAgent('sess-1')
    await hb.tick(agent) // 不许把整拍吞掉/抛出
    assert.equal(agent.sent.length, 0, '不知道值不值得说 ⇒ 沉默(同复核超时那套保守纪律)')
    const row = store.careBeatsSince(0, 10)[0]
    assert.equal(row.reason, 'no-topic')
    assert.equal(row.rejectedBy, 'local')
    assert.ok(String(row.payload.error).length > 0, '炸了的原因要能查出来')
  } finally { store.close() }
})

// ── 2026-09-30 方案 A:阈值**分类型**(他拍板;三个扁平键 + 坏值回退统一线)────────

/** 种一条**悬置话题**(候选池的第三类来源;话题**没有窗口闸** ⇒ 老话题也进池)。
 *  7 天前那条的分 = 0.25(悬置封顶)+0.075(缺口)+0.08(具体性)+0(时效)+0.15(新鲜)= **0.555**
 *  —— 正好卡在两条线**之间**:统一 0.6 过不去,话题自己的 0.52 过得去。 */
function seedThread (store, { agoSec = 7 * 86400, content = '她答应过要问的那家店' } = {}) {
  store.db.prepare(
    'INSERT INTO pending_threads (user_id, content, status, follow_up_after, last_mentioned_at, created_at)'
    + " VALUES (?, ?, 'open', 0, 0, ?)"
  ).run(MASTER_ID, content, P2_AT() / 1000 - agoSec)
  return Number(store.db.prepare('SELECT thread_id FROM pending_threads ORDER BY thread_id DESC LIMIT 1').get().thread_id)
}

test('方案 A:悬置话题按**自己的线**(0.52)过 —— 统一线 0.6 根本过不了', async () => {
  const store = freshStore()
  try {
    const id = seedThread(store)
    const hb = makeScoringHeartbeat(fakeEngine({ longing: careState() }), store, {
      // 统一线仍是 0.6,只给话题自己的线;复核关掉 ⇒ 只测"过线"这一件事
      getProactiveScoring: () => SCORING_ON({ threshold: 0.6, thresholdThread: 0.52, reviewEnabled: false }),
      reviewTopic: async () => { throw new Error('这一拍不该走到复核') }
    })
    const agent = fakeAgent('sess-1')
    await hb.tick(agent)
    assert.equal(agent.sent.length, 1, '按话题自己的线过线 ⇒ 开口')
    const row = store.careBeatsSince(0, 10)[0]
    assert.equal(row.reason, 'sent')
    assert.equal(row.topicId, 'thread:' + id)
    assert.ok(row.topScore >= 0.52 && row.topScore < 0.6, '分落在两条线之间:' + row.topScore)
  } finally { store.close() }

  // ★ 回滚路径:同一份数据、同一拍,**不给类型键** ⇒ 回退统一 0.6 ⇒ no-topic
  const store2 = freshStore()
  try {
    seedThread(store2)
    const hb = makeScoringHeartbeat(fakeEngine({ longing: careState() }), store2, {
      getProactiveScoring: () => SCORING_ON({ threshold: 0.6 })
    })
    const agent = fakeAgent('sess-1')
    await hb.tick(agent)
    assert.equal(agent.sent.length, 0, '没有类型键 ⇒ 回到统一线(0.6)⇒ 这一拍沉默')
    assert.equal(store2.careBeatsSince(0, 10)[0].reason, 'no-topic')
  } finally { store2.close() }
})

test('方案 A:记忆按自己的线,且**复核用的是同一条类型线**(不是统一线)', async () => {
  const store = freshStore()
  try {
    // 记忆写在 13 天前 ⇒ 默认 72h 窗口会把它挡在池外,这里窗口放到面板上限 336h。
    // 分 = 0.25(悬置封顶)+0.075+0.04+0(时效)+0.15+0.05(情绪 5 ⇒ 0.5)= **0.565** ——
    // 又是"卡在两条线之间":统一 0.6 过不去,记忆自己的 0.55 过得去。
    store.db.prepare(
      'INSERT INTO episodic_memory (user_id, keywords, summary, emotion_score, timestamp, is_active, status, layer)'
      + " VALUES (?, '面试', ?, ?, ?, 1, 'active', '')"
    ).run(MASTER_ID, '他上次提到想去的那家店', 5, P2_AT() / 1000 - 13 * 86400)
    let seen = null
    const hb = makeScoringHeartbeat(fakeEngine({ longing: careState() }), store, {
      getProactiveScoring: () => SCORING_ON({ threshold: 0.6, thresholdMemory: 0.55, windowHours: 336 }),
      reviewTopic: async (opts) => { seen = opts; return { ok: true, speak: true, why: '有真实内容' } }
    })
    const agent = fakeAgent('sess-1')
    await hb.tick(agent)
    assert.ok(seen !== null, '0.565 落在 0.55±0.08 的边缘区 ⇒ 该花一次复核')
    assert.equal(seen.threshold, 0.55, '★ 复核必须用**记忆的**那条线,不是统一 0.6')
    assert.equal(agent.sent.length, 1)
    const row = store.careBeatsSince(0, 10)[0]
    assert.equal(row.reason, 'sent', '复核通过并开口 ⇒ reason 仍 sent')
    assert.equal(row.payload.reviewed, true)
    assert.ok(String(row.topicId).startsWith('mem:'), 'topic_id 是记忆那条:' + row.topicId)
    assert.ok(row.payload.why && row.payload.why.concreteness, 'why 逐维贡献照样进 payload')
  } finally { store.close() }
})

test('串行重入:上一跳没跑完,这一跳直接让路(不叠加不抢跑)', async () => {
  const store = freshStore()
  let release = null
  let releaseReady = null
  const releaseReadyPromise = new Promise((r) => { releaseReady = r })
  const engine = fakeEngine({})
  engine.longing = () => {
    engine.calls.push('longing') // 覆盖了假引擎原方法,记账自己来
    const p = new Promise((resolve) => { release = () => resolve(careState()) })
    releaseReady() // longing 已被调用,释放器已就位
    return p
  }
  const agent = fakeAgent('sess-1')
  try {
    const hb = makeHeartbeat(engine, store) // 同一实例:ticking 旗才共享
    const first = hb.tick(agent)
    const second = hb.tick(agent) // ticking=true → no-op
    await second
    await releaseReadyPromise // 等第一跳真的走到 longing(不猜微任务时序)
    release()
    await first
    assert.equal(engine.calls.filter((c) => c === 'longing').length, 1)
    assert.equal(agent.sent.length, 1)
  } finally { store.close() }
})

test('framing 纪律:稳定前缀 + JSON 转义动态值(schedule 先例)', () => {
  const care = renderCareFraming({
    st: { value: 7.5, threshold: 4.5, sinceMessage: 3600 },
    agendaItem: { itemId: 2, content: '他说"下周"要交稿 —— 引号与换行\n都要转义' }
  })
  assert.ok(care.includes('[ECHO CARE]'))
  assert.ok(care.includes('"silentHours":1'))
  // JSON.stringify 转义后的内容原样可 parse(不破帧)
  const m = care.match(/agenda_json: (\{.*\})/)
  assert.deepEqual(JSON.parse(m[1]), { itemId: 2, content: '他说"下周"要交稿 —— 引号与换行\n都要转义' })

  const remind = renderRemindFraming([{ thread_id: 1, content: 'a"b' }])
  assert.ok(remind.startsWith('[ECHO REMIND]'))
  assert.deepEqual(JSON.parse(remind.match(/reminders_json: (\[.*\])/)[1]),
    [{ threadId: 1, content: 'a"b', due: '已到约定时间' }])
})

// ---- v0.14.5 S12:框架纪律与接地字段(照抄 A 的两套提示词)----

test('S12 提醒 framing:字数预算 + 不道歉 + 只问这一件事 + 约定时间 + 兜底句', () => {
  const due = new Date(2026, 8, 25, 8, 30).getTime() / 1000
  const text = renderRemindFraming([{ thread_id: 5, content: '去喝水', follow_up_after: due }])
  assert.ok(text.includes('15~40 字'), '要有字数预算(她的话不能变成长篇)')
  assert.ok(text.includes('不要道歉'))
  assert.ok(text.includes('只问这一件事'))
  assert.ok(text.includes('不要追问细节'))
  assert.ok(text.includes('09-25 08:30'), '要带上约定时间的钟面(A 的 due_str)')
  // 确定性兜底(A 在代码里 return 模板;DSH 没有输出侧钩子 → 写进 framing)
  // P3-e:兜底句的称呼不再写死 —— 默认中性「用户」,`alias` 可注入
  assert.ok(text.includes('用户,之前你提到「去喝水」,现在怎么样啦?'))
  // 动态值仍然可 parse(加了 due 字段后帧形状变了,这里钉住)
  assert.deepEqual(JSON.parse(text.match(/reminders_json: (\[.*\])/)[1]),
    [{ threadId: 5, content: '去喝水', due: '09-25 08:30' }])
  // 没有约定时间(不定时)→ A 的兜底措辞
  assert.ok(renderRemindFraming([{ thread_id: 6, content: 'x' }]).includes('已到约定时间'))
})

test('S12 关怀 framing:档位纪律 + 禁词 + 四件接地字段', () => {
  const st = { value: 8.4, threshold: 5.5, sinceMessage: 41400, shouldCare: true, sessionId: 'sess-1' }
  const text = renderCareFraming({
    st,
    agendaItem: { itemId: 3, content: '想问他面试结果' },
    alias: '阿岚',
    anchor: '你是 Echo,调皮毒舌但对他心软。',
    state: {
      moodIntensity: 7, prevMoodIntensity: 5, moodReason: '想他',
      userEmotion: 'anxious',
      emotionVector: {
        global: { fatigue: 6, valence: -3, arousal: 5 },
        target_master: { affection: 9, playfulness: 6, sadness: 4, dependency: 8 }
      }
    },
    now: new Date(2026, 8, 25, 2, 10).getTime()
  })
  // 字数预算 + 档位 + 禁词 + 两条不许
  assert.ok(text.includes('15~50 字'))
  assert.ok(text.includes('想念值高时可以带一点小委屈;想念值不高时轻轻一句就好,不要夸张'))
  assert.ok(text.includes('不要说"系统""算法""想念值"这类词'))
  assert.ok(text.includes('不要提任何"约定/答应过"的事'))
  assert.ok(text.includes('不许暗示你记得更多细节'))
  assert.ok(text.includes('"还没算账""那件事"这类词是禁区'))
  // 四件接地字段:A 喂给组稿模型的都是真值,不是让她猜
  assert.ok(text.includes('[你的核心人设] 你是 Echo,调皮毒舌但对他心软。'))
  assert.ok(text.includes('[对话对象的称呼] 阿岚'))
  assert.ok(text.includes('[现在时刻] 2026-09-25 周五 02:10(凌晨)'), '她得知道现在是凌晨')
  assert.ok(text.includes('[你此刻的体感]'), '体感滤镜从 describeMood 来')
  assert.ok(text.includes('疲惫 6'), '体感是真实状态,不是默认句')
  assert.ok(text.includes('[他最近的心情] anxious'))
  // 缺省(壳没喂状态/锚点)时不编造:用 A 的默认行,且不留空标签
  const bare = renderCareFraming({ st, agendaItem: null })
  assert.ok(bare.includes('[你此刻的体感] 平静,没有特别的体感'))
  assert.ok(bare.includes('[他最近的心情] 平静,没有特别的事'))
  assert.ok(!bare.includes('[你的核心人设]'))
  assert.ok(bare.includes('agenda_json: null'))
})

test('v0.30.1 防重复开口:ack 没回来之前,同一会话不再说第二句', async () => {
  // 2026-09-27 中午现场:适配器不在的那段时间(电脑刚醒、AstrBot 还
  // 没起),on_care_sent / 冷却闸都只认 ack —— 心跳每 60 秒就把同一句
  // 想念再说一遍。待兑现账(pendingCare)本来就在记这个状态,现在
  // 让它把门看住。
  const store = freshStore()
  const engine = fakeEngine({ longing: careState() })
  const agent = fakeAgent('sess-1')
  try {
    const hb = makeHeartbeat(engine, store)
    await hb.tick(agent)
    assert.equal(agent.sent.length, 1, '第一次:她开口了')
    assert.equal(store.listAudit(0, 10).filter((r) => r.toolCall === 'care').length, 1)
    // ack 没回 —— 下一跳不许重复开口
    await hb.tick(agent)
    assert.equal(agent.sent.length, 1, 'ack 未回,同一句想念不许说第二遍')
    assert.equal(store.listAudit(0, 10).filter((r) => r.toolCall === 'care').length, 1, '审计也不许再添一行')
    // ack 回来 = 真的送到手机上了:账落了(longingCare),门才开
    await hb.noteProactiveAcked([{ kind: 'proactive', sessionId: 'sess-1' }])
    assert.ok(engine.calls.includes('care'), 'ack 落账:on_care_sent(想念 ×0.5)')
    await hb.tick(agent)
    assert.equal(agent.sent.length, 2, '账清了,想念仍过线 → 才可以再开口')
  } finally { store.close() }
})

/**
 * v0.30.2 关怀留痕:2026-09-28 早上他问「她今天早上为什么没主动关怀」。
 * 引擎侧 /api/echo/longing 报 shouldCare=true(7.13 ≥ 5.23),壳侧一句话没发,
 * 而理由只喊在宿主 stdout 上 —— 45 小时里谁都不知道卡在哪。
 * 从此每跳都留一份结论:reason 说清卡点,不写库(状态面足够,不造噪声)。
 */
test('关怀留痕:引擎说夜间憋话 ⇒ reason=night-hold,不写库', async () => {
  const store = freshStore()
  const engine = fakeEngine({ longing: careState({ shouldCare: false, nightHold: true }) })
  const agent = fakeAgent('sess-1')
  const hb = makeHeartbeat(engine, store)
  try {
    await hb.tick(agent)
    assert.equal(hb.careTrace().reason, 'night-hold', '夜闸卡住也要点名')
    assert.equal(hb.careTrace().shouldCare, false)
    assert.equal(agent.sent.length, 0)
    assert.equal(store.listAudit(0, 10).length, 0, '留痕不落库')
  } finally { store.close() }
})

test('关怀留痕:她那条会话拿不到 ⇒ reason=no-target(要点名,不许静默)', async () => {
  const store = freshStore()
  const engine = fakeEngine({ longing: careState({ sessionId: 'sess-other' }) })
  const agent = fakeAgent('sess-1')
  const hb = createHeartbeat({
    engine, store, logger: null, isEnabled: () => true,
    createUserMessage: fakeCreateUserMessage, masterId: MASTER_ID,
    resolveCareTarget: async () => null,
    getProactiveScoring: () => PROACTIVE_SCORING_OFF // 测试隔离:测 no-target,不测打分
  })
  try {
    await hb.tick(agent)
    const t = hb.careTrace()
    assert.equal(t.reason, 'no-target', '解析不到目标 ⇒ 要点名,不许静默')
    assert.equal(t.shouldCare, true, '引擎说的是"该开口",卡点是壳侧')
    assert.equal(t.value, 8.2)
    assert.equal(t.threshold, 5.5)
    assert.equal(agent.sent.length, 0)
    assert.equal(store.listAudit(0, 10).length, 0)
  } finally { store.close() }
})

test('关怀留痕:投递忙 ⇒ reason=deliver-busy(每分钟重试,状态面可查)', async () => {
  const store = freshStore()
  const engine = fakeEngine({ longing: careState() })
  const agent = fakeAgent('sess-1', { busy: true })
  const hb = makeHeartbeat(engine, store)
  try {
    await hb.tick(agent)
    assert.equal(hb.careTrace().reason, 'deliver-busy')
    assert.equal(hb.pendingCareCount(), 0, '没投出去就不许记待兑现账')
    assert.equal(store.listAudit(0, 10).length, 0)
  } finally { store.close() }
})

test('关怀留痕:真开口了 ⇒ reason=sent(与审计里的 care 行同一跳)', async () => {
  const store = freshStore()
  const engine = fakeEngine({ longing: careState(), agenda: null })
  const agent = fakeAgent('sess-1')
  const hb = makeHeartbeat(engine, store)
  try {
    await hb.tick(agent)
    const t = hb.careTrace()
    assert.equal(t.reason, 'sent')
    assert.equal(t.sessionId, 'sess-1')
    assert.equal(t.targetSessionId, 'sess-1', '2026-09-29:留痕要带"投到哪条会话"')
    assert.equal(store.careBeatsSince(0)[0].targetSessionId, 'sess-1', '台账里也带')
    assert.ok(t.at > 0, '留痕带时间戳(面板要能说"她上次判定的时刻")')
    assert.equal(store.listAudit(0, 10).filter((r) => r.toolCall === 'care').length, 1)
  } finally { store.close() }
})
