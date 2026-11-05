/**
 * v0.31.0 P2 电池:**空拍退避 + 一拍一账 + 她自己的闹钟**。
 *
 * 这一批保护的是 2026-09-28 那两次**同一类事故**:
 *   ① 45 小时里她一声不吭,而他(和我)只能靠推 —— 判定理由只活在宿主 stdout 上;
 *   ② 全仓 8 条悬置话题全是哑的(follow_up_after=0 ⇒ 永不主动提)——
 *      她答应他的事永远不会自己冒出来。
 * 所以这里钉三件事:**理由必落账**(可 GROUP BY)、**退避只在纯安静时长**、
 * **闹钟的优先级写死**(夜闸 > 她的闹钟 > 想念关怀;但闹钟不消耗)。
 *
 * 引擎/代理全用假件(依赖注入);store 用真件(账的真相源就是库)。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { isolateTestHome, assertHomeIsolated } from './fixtures/test-home.js'

// 2026-09-30 测试隔离:先隔离 `DSH_HOME`,再**动态** import 库模块 ——
// `lib/toggle.js` 的 CONFIG_PATH 是模块级常量,首次 import 时按当时的 DSH_HOME
// 定死;静态 import 会先于隔离执行,用例就会读到真机 config.json
// (真机上 `proactiveScoring.enabled=true` ⇒ 本文件里该判 sent 的一拍被判 no-topic)。
isolateTestHome()
const { CONFIG_PATH } = await import('../lib/toggle.js')
assertHomeIsolated(CONFIG_PATH)
const { openStore, MASTER_ID } = await import('../lib/store.js')
const {
  createHeartbeat, renderWakeFraming, isNightHour, quietWords,
  CARE_BACKOFF, CARE_DAILY_CAP, NIGHT_HOLD_FROM_HOUR, NIGHT_HOLD_TO_HOUR,
  PROACTIVE_SCORING_OFF
} = await import('../lib/heartbeat.js')
const { resolveWakeAt, wakeGateLine, wakeAtText, WAKE_MAX_AHEAD_MS, WAKE_MIN_AHEAD_MS } =
  await import('../lib/wake-tools.js')

function freshStore () {
  const store = openStore(':memory:')
  store.db.prepare("INSERT INTO user_profile (user_id, name) VALUES (?, '阿岚')").run(MASTER_ID)
  return store
}

/** 可控时钟(退避是**时间**判据,测试必须能拨)。 */
function clock (atMs) {
  let ms = atMs
  return {
    now: () => ms,
    advance: (minutes) => { ms += Math.round(minutes * 60 * 1000) },
    set: (v) => { ms = v }
  }
}
/** 本地钟面的某一天某个点(夜闸判据走本地时间)。 */
const atLocal = (h, m = 0, day = 28) => new Date(2026, 8, day, h, m, 0, 0).getTime()

function fakeEngine (script = {}) {
  return {
    calls: [],
    async threadsRemindable () { this.calls.push('remindable'); return { items: script.remindable ?? [] } },
    async threadsMark (id) { this.calls.push('threadsMark:' + id) },
    async longingTick () { this.calls.push('tick') },
    async longing () { this.calls.push('longing'); return script.longing ?? null },
    async agendaPick () { this.calls.push('agendaPick'); return script.agenda ?? null },
    async agendaMark (id) { this.calls.push('agendaMark:' + id) },
    async longingCare () { this.calls.push('care') }
  }
}

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

const careState = (over = {}) => ({
  value: 8.2, threshold: 5.5, sinceMessage: 41400, sessionId: 'sess-1',
  shouldCare: true, ...over
})

function makeHeartbeat (engine, store, opts = {}) {
  return createHeartbeat({
    engine, store, logger: null,
    isEnabled: opts.isEnabled ?? (() => true),
    createSessionEnabled: undefined,
    isSessionEnabled: opts.isSessionEnabled,
    createUserMessage: (m) => ({ role: 'user', ...m }),
    masterId: MASTER_ID,
    getNightHold: opts.getNightHold,
    getBackoff: opts.getBackoff,
    getWakeEnabled: opts.getWakeEnabled,
    resolveCareTarget: opts.resolveCareTarget,
    now: opts.now,
    // 2026-09-30 测试隔离:默认**显式**注入"打分器关着"(用例自带环境)。
    // 不注入就回落到 readSettings():真机开着打分器时这一拍会被判 no-topic。
    getProactiveScoring: opts.getProactiveScoring ?? (() => PROACTIVE_SCORING_OFF)
  })
}

const beats = (store) => store.careBeatsSince(0, 200)
const reasonsOf = (store) => beats(store).map((b) => b.reason)

// ---- 纯函数面:窗口与退避常量 -------------------------------------------------

test('P2 常量:退避是 ×2 上限 8 倍,夜闸窗口与设置里的说明一致(23~8)', () => {
  assert.equal(CARE_BACKOFF.baseMs, 60000)
  assert.equal(CARE_BACKOFF.factor, 2)
  assert.equal(CARE_BACKOFF.maxFactor, 8)
  assert.equal(NIGHT_HOLD_FROM_HOUR, 23)
  assert.equal(NIGHT_HOLD_TO_HOUR, 8)
})

test('isNightHour:23:00~07:59 算夜里,08:00 与 22:59 不算(纯函数)', () => {
  assert.equal(isNightHour(new Date(atLocal(23, 0))), true)
  assert.equal(isNightHour(new Date(atLocal(3, 30))), true)
  assert.equal(isNightHour(new Date(atLocal(7, 59))), true)
  assert.equal(isNightHour(new Date(atLocal(8, 0))), false)
  assert.equal(isNightHour(new Date(atLocal(15, 0))), false)
  assert.equal(isNightHour(new Date(atLocal(22, 59))), false)
})

test('quietWords:很短就说秒(别把 40 秒说成 0.0 小时)', () => {
  assert.equal(quietWords(40), '40 秒')
  assert.equal(quietWords(600), '10 分钟')
  assert.equal(quietWords(7200), '2 小时')
})

// ---- ① 一拍一账(理由必留痕,纯安静不刷屏)---------------------------------

test('账:她开口那一拍必须有一行(kind=care / reason=sent / acted=1)', async () => {
  const store = freshStore()
  const engine = fakeEngine({ longing: careState(), agenda: { itemId: 3, content: '面试结果' } })
  try {
    await makeHeartbeat(engine, store).tick(fakeAgent('sess-1'))
    const rows = beats(store)
    assert.equal(rows.length, 1)
    assert.equal(rows[0].kind, 'care')
    assert.equal(rows[0].reason, 'sent')
    assert.equal(rows[0].acted, true)
    assert.equal(rows[0].shouldAct, true)
    assert.equal(rows[0].value, 8.2, '想念值要落账(不然翻历史只能看到"开口了",看不到"多想要")')
    assert.equal(rows[0].threshold, 5.5)
    assert.equal(rows[0].sessionId, 'sess-1')
    assert.equal(rows[0].payload.agendaItemId, 3)
    assert.equal(store.careBeatSummary(0)[0].reason, 'sent', 'summary 要能 GROUP BY')
  } finally { store.close() }
})

test('账:每一步否定都留痕(daily-cap / no-target / pending-ack 各一行)', async () => {
  const store = freshStore()
  try {
    // ① 日上限:先造 3 条 sent 拍(2026-09-29 起真相源是 care_beats,不再是审计),再 tick
    for (let i = 0; i < CARE_DAILY_CAP; i++) {
      store.careBeatAdd({ at: Date.now() / 1000, kind: 'care', reason: 'sent', acted: true })
    }
    await makeHeartbeat(fakeEngine({ longing: careState() }), store).tick(fakeAgent('sess-1'))
    assert.deepEqual(reasonsOf(store).filter((r) => r !== 'sent'), ['daily-cap'])
    const cap = beats(store).find((b) => b.reason === 'daily-cap')
    assert.equal(cap.acted, false)
    assert.equal(cap.shouldAct, true, '引擎说"该开口",卡在壳侧 —— 这两个值都要在账上')
  } finally { store.close() }

  const store2 = freshStore()
  try {
    // ② 她那条会话拿不到(注入了解析器但它给不出目标)⇒ no-target
    // (旧判词 session-mismatch 已退役:2026-09-29 起开口目标不再要求"两个身份相等")
    const hb = createHeartbeat({
      engine: fakeEngine({ longing: careState({ sessionId: 'sess-other' }) }), store: store2,
      logger: null, isEnabled: () => true,
      createUserMessage: (m) => ({ role: 'user', ...m }), masterId: MASTER_ID,
      resolveCareTarget: async () => null,
      // 2026-09-30 测试隔离:这条测的是 no-target 判词,打分器显式关着
      // (否则真机配置 enabled=true 时这一拍先被打分器判成 no-topic)
      getProactiveScoring: () => PROACTIVE_SCORING_OFF
    })
    await hb.tick(fakeAgent('sess-1'))
    assert.deepEqual(reasonsOf(store2), ['no-target'])
  } finally { store2.close() }

  const store3 = freshStore()
  try {
    // ③ 待兑现(同一会话:先开口一次,再 tick 一次)
    const engine = fakeEngine({ longing: careState() })
    const hb = makeHeartbeat(engine, store3)
    await hb.tick(fakeAgent('sess-1'))
    await hb.tick(fakeAgent('sess-1'))
    assert.deepEqual(reasonsOf(store3), ['pending-ack', 'sent'], '新的在前')
  } finally { store3.close() }
})

test('账:纯安静不刷屏 —— 同一理由连着的第二拍不再写一行(靠退避让路)', async () => {
  const store = freshStore()
  const c = clock(atLocal(15, 0))
  try {
    const hb = makeHeartbeat(fakeEngine({ longing: careState({ shouldCare: false }) }), store, { now: c.now })
    await hb.tick(fakeAgent('sess-1'))
    c.advance(1) // 下一分钟:还在退避里 ⇒ 让路
    await hb.tick(fakeAgent('sess-1'))
    assert.deepEqual(reasonsOf(store), ['engine-says-no'], '同理由只留一行')
    assert.equal(hb.careTrace().reason, 'backoff', '让路也要在状态面说清')
    assert.ok(hb.careTrace().nextPollAt > 0, '状态面要能说"下一拍几点判"')
  } finally { store.close() }
})

test('账:安静超过 30 分钟补一条(否则"她一整天安静"这件事查不出来)', async () => {
  const store = freshStore()
  const c = clock(atLocal(15, 0))
  try {
    const hb = makeHeartbeat(fakeEngine({ longing: careState({ shouldCare: false }) }), store, { now: c.now })
    await hb.tick(fakeAgent('sess-1'))
    c.advance(31) // 退避最远 8 分钟 ⇒ 这一拍一定会真的判
    await hb.tick(fakeAgent('sess-1'))
    assert.deepEqual(reasonsOf(store), ['engine-says-no', 'engine-says-no'])
    assert.equal(beats(store)[0].value, 8.2, '引擎给了读数就照记(安静 ≠ 不想)')
  } finally { store.close() }
})

test('账:引擎不在(没有读数)时 value=0 必须标成"没读数"', async () => {
  const store = freshStore()
  try {
    // 引擎不在 ⇒ frame() 给 null ⇒ 心跳拿不到任何读数
    await makeHeartbeat(fakeEngine({ longing: null }), store).tick(fakeAgent('sess-1'))
    const rows = beats(store)
    assert.deepEqual(rows.map((r) => r.reason), ['engine-says-no'])
    assert.equal(rows[0].value, 0)
    assert.equal(rows[0].payload.noReading, true, '0 不许被读成"她一点也不想他"')
    assert.equal(rows[0].shouldAct, false)
  } finally { store.close() }
})

// ---- ② 空拍退避 ---------------------------------------------------------------

test('退避:连续安静时下一拍只会越来越远,上限 8 倍(8 分钟)', async () => {
  const store = freshStore()
  const c = clock(atLocal(15, 0))
  try {
    const hb = makeHeartbeat(fakeEngine({ longing: careState({ shouldCare: false }) }), store, { now: c.now })
    const waits = []
    for (let i = 0; i < 6; i++) {
      await hb.tick(fakeAgent('sess-1'))
      waits.push(Math.round((hb.careTrace().nextPollAt * 1000 - c.now()) / 60000))
      c.advance(9) // 一定越过下一拍
    }
    assert.deepEqual(waits, [2, 4, 8, 8, 8, 8], '2/4/8 分钟后封顶(×2 上限 8 倍)')
  } finally { store.close() }
})

test('退避:他说话了 / 她开口了 ⇒ 立刻复位回 60 秒的节拍', async () => {
  const store = freshStore()
  const c = clock(atLocal(15, 0))
  try {
    const hb = makeHeartbeat(fakeEngine({ longing: careState({ shouldCare: false }) }), store, { now: c.now })
    await hb.tick(fakeAgent('sess-1'))
    c.advance(9)
    await hb.tick(fakeAgent('sess-1'))
    assert.ok(hb.careTrace().quietStreak >= 2)
    hb.noteExternalEvent()
    assert.equal(hb.careTrace().quietStreak, 0, '他一开口,退避的前提就没了')
    assert.equal(hb.careTrace().nextPollAt, 0)
  } finally { store.close() }

  const store2 = freshStore()
  const c2 = clock(atLocal(15, 0))
  try {
    // 开口那一拍也要复位:安静两拍 → 想念过线 → 开口
    const engine = fakeEngine({ longing: careState({ shouldCare: false }) })
    const hb = makeHeartbeat(engine, store2, { now: c2.now })
    await hb.tick(fakeAgent('sess-1'))
    c2.advance(9)
    await hb.tick(fakeAgent('sess-1'))
    assert.ok(hb.careTrace().quietStreak >= 2)
    engine.longing = async () => careState()
    c2.advance(9)
    await hb.tick(fakeAgent('sess-1'))
    assert.equal(hb.careTrace().reason, 'sent')
    assert.equal(hb.careTrace().quietStreak, 0, '开口了就不该还在退避')
  } finally { store2.close() }
})

// ---- ③ 她自己的闹钟(优先级写死)-------------------------------------------

test('闹钟:到点就开口(带她自己写下的原话),响了才落账', async () => {
  const store = freshStore()
  const c = clock(atLocal(15, 0))
  try {
    store.wakeAdd({ at: c.now() / 1000 + 300, note: '问他面试怎么样', why: '他上午面试', sessionId: 'sess-1' })
    const agent = fakeAgent('sess-1')
    const hb = makeHeartbeat(fakeEngine({ longing: careState({ shouldCare: false }) }), store, { now: c.now })
    c.advance(6) // 到点
    await hb.tick(agent)
    assert.equal(agent.sent.length, 1, '闹钟到点必须开口')
    const text = agent.sent[0].content[0].text
    assert.ok(text.startsWith('[ECHO WAKE]'))
    assert.ok(text.includes('问他面试怎么样'), '要带上她当时写下的原话')
    assert.ok(text.includes('[闸门现状]'), '闸门现状要事前声明')
    assert.equal(agent.sent[0].source.form, 'wake', 'form 必须是 wake(否则出站会被当"回话")')
    const rows = beats(store)
    assert.equal(rows[0].kind, 'wake')
    assert.equal(rows[0].reason, 'wake-sent')
    assert.equal(rows[0].acted, true)
    assert.equal(store.wakeList(5)[0].firedAt > 0, true, '响了才落 fired_at')
    // 再来一拍:这闹钟已经响过,不许再响
    c.advance(2)
    await hb.tick(agent)
    assert.equal(agent.sent.length, 1)
  } finally { store.close() }
})

test('闹钟:夜里到点被压住 —— 但**不消耗**,早上第一拍放行', async () => {
  const store = freshStore()
  const c = clock(atLocal(23, 30))
  try {
    store.wakeAdd({ at: atLocal(23, 35) / 1000, note: '提醒他睡觉', sessionId: 'sess-1' })
    const agent = fakeAgent('sess-1')
    const hb = makeHeartbeat(fakeEngine({ longing: careState({ shouldCare: false }) }), store, { now: c.now })
    c.advance(6) // 到点(23:36)
    await hb.tick(agent)
    assert.equal(agent.sent.length, 0, '夜闸压住(23~8 点不吵他)')
    assert.deepEqual(reasonsOf(store), ['wake-night-hold'])
    assert.equal(store.wakeList(5)[0].firedAt, 0, '压住 ≠ 取消:闹钟必须还在')
    // 早上(隔天 08:05 —— 注意别把时钟往回拨,那会变成"还没到点")
    c.set(atLocal(8, 5, 29))
    await hb.tick(agent)
    assert.equal(agent.sent.length, 1, '早上第一拍放行')
    assert.equal(store.wakeList(5)[0].firedAt > 0, true)
  } finally { store.close() }
})

test('闹钟:她正忙 ⇒ 不消耗,下一拍再试(宁可晚,不许丢)', async () => {
  const store = freshStore()
  const c = clock(atLocal(15, 0))
  try {
    store.wakeAdd({ at: c.now() / 1000 + 60, note: 'x', sessionId: 'sess-1' })
    const hb = makeHeartbeat(fakeEngine({ longing: careState({ shouldCare: false }) }), store, { now: c.now })
    c.advance(2)
    await hb.tick(fakeAgent('sess-1', { busy: true }))
    assert.deepEqual(reasonsOf(store), ['wake-busy'])
    assert.equal(store.wakeList(5)[0].firedAt, 0)
    c.advance(1)
    const agent = fakeAgent('sess-1')
    await hb.tick(agent)
    assert.equal(agent.sent.length, 1, '忙完就补上')
  } finally { store.close() }
})

test('优先级:日上限**管不着**闹钟(她排的时候就想好了),而且这条差别写进账里', async () => {
  const store = freshStore()
  const c = clock(atLocal(15, 0))
  try {
    for (let i = 0; i < CARE_DAILY_CAP; i++) {
      store.writeAudit({
        traceId: 't' + i, userInput: '(想念主动关怀)', llmReply: '',
        moodIntensity: 3, prevMoodIntensity: 3, emotionVector: {}, toolCall: 'care'
      })
    }
    store.wakeAdd({ at: c.now() / 1000 + 60, note: 'y', sessionId: 'sess-1' })
    const agent = fakeAgent('sess-1')
    const hb = makeHeartbeat(fakeEngine({ longing: careState() }), store, { now: c.now })
    c.advance(2)
    await hb.tick(agent)
    assert.equal(agent.sent.length, 1, '日上限是给"想念关怀"的护栏,不该拦她自己的闹钟')
    assert.equal(beats(store)[0].kind, 'wake')
  } finally { store.close() }
})

test('优先级:电源闸关着 ⇒ 谁都不发(最高一级);夜闸关掉时闹钟直通', async () => {
  const store = freshStore()
  const c = clock(atLocal(23, 30))
  try {
    store.wakeAdd({ at: atLocal(23, 35) / 1000, note: 'z', sessionId: 'sess-1' })
    const off = fakeAgent('sess-1')
    await makeHeartbeat(fakeEngine({ longing: careState() }), store, { now: c.now, isEnabled: () => false }).tick(off)
    assert.equal(off.sent.length, 0)
    assert.deepEqual(reasonsOf(store), [], '电源闸是**他拨的开关**,状态面上看得见,不另落账(否则休眠期间每分钟一行)')
  } finally { store.close() }

  const store2 = freshStore()
  const c2 = clock(atLocal(23, 30))
  try {
    store2.wakeAdd({ at: atLocal(23, 35) / 1000, note: 'z2', sessionId: 'sess-1' })
    const agent = fakeAgent('sess-1')
    await makeHeartbeat(fakeEngine({ longing: careState() }), store2, { now: c2.now, getNightHold: () => false }).tick(agent)
    assert.equal(agent.sent.length, 1, '夜闸开关关掉 ⇒ 夜里也直通')
  } finally { store2.close() }
})

test('闹钟 framing:纯函数,把她的原话与闸门现状都带上', () => {
  const t = renderWakeFraming({ item: { note: '问他面试', why: '他上午面试', at: 100 }, alias: '阿岚', gateLine: wakeGateLine({ used: 1, cap: 3, night: false }) })
  assert.ok(t.startsWith('[ECHO WAKE]'))
  assert.ok(t.includes('问他面试'))
  assert.ok(t.includes('[闸门现状]'))
  assert.ok(t.includes('1/3'))
  assert.ok(t.includes('闹钟不计入'), '必须说清"闹钟不吃日上限"')
})

// ---- ⑤ 两个行为开关(计划里承诺的"每个特性独立开关 / 可回滚")-----------------

test('开关:退避关掉 ⇒ 每分钟都判(状态面不再有"下一拍")', async () => {
  const store = freshStore()
  const c = clock(atLocal(15, 0))
  try {
    const hb = makeHeartbeat(fakeEngine({ longing: careState({ shouldCare: false }) }), store,
      { now: c.now, getBackoff: () => false })
    await hb.tick(fakeAgent('sess-1'))
    assert.equal(hb.careTrace().nextPollAt, 0, '关掉退避 = 不留下一拍')
    c.advance(1)
    await hb.tick(fakeAgent('sess-1'))
    assert.equal(hb.careTrace().reason, 'engine-says-no', '第二拍照旧真的判一次(不是 backoff 让路)')
    assert.equal(hb.careTrace().quietStreak, 2, '安静还在数(状态面照样能说"安静多久了")')
  } finally { store.close() }
})

test('开关:「她的闹钟」关掉 ⇒ 到点不响、留痕、闹钟不消耗;开回来还在', async () => {
  const store = freshStore()
  const c = clock(atLocal(15, 0))
  try {
    store.wakeAdd({ at: c.now() / 1000 + 60, note: '关着也要到点', sessionId: 'sess-1' })
    const agent = fakeAgent('sess-1')
    const off = makeHeartbeat(fakeEngine({ longing: careState({ shouldCare: false }) }), store,
      { now: c.now, getWakeEnabled: () => false })
    c.advance(2)
    await off.tick(agent)
    assert.equal(agent.sent.length, 0, '面板关掉了闹钟 ⇒ 不响')
    assert.deepEqual(reasonsOf(store), ['wake-off'], '关了所以没响 —— 这件事必须查得到')
    assert.equal(store.wakeList(5)[0].firedAt, 0, '关掉 ≠ 取消:闹钟还在')
    // 他开回来
    const on = makeHeartbeat(fakeEngine({ longing: careState({ shouldCare: false }) }), store, { now: c.now })
    c.advance(2)
    await on.tick(agent)
    assert.equal(agent.sent.length, 1, '开回来,到点的闹钟照响')
  } finally { store.close() }
})

// ---- ④ 时间换算(她排闹钟时最容易错的一步)---------------------------------

test('B5 已退役:他在干活**不再**压关怀(2026-09-29 他裁定删掉这条闸)', async () => {
  const store = freshStore()
  const c = clock(atLocal(15, 0))
  try {
    // 旧实现:这里会判 working 并静默。现在:引擎说该开口就开口 ——
    // 而且这条闸原来读的是"这一拍 tick 到的那条会话有没有在跑工具",
    // 等于让她开不开口取决于竞速。删的是闸,不是数据源。
    const hb = makeHeartbeat(fakeEngine({ longing: careState({ shouldCare: true }) }), store,
      { now: c.now })
    const agent = fakeAgent('sess-1')
    await hb.tick(agent)
    assert.equal(agent.sent.length, 1, '他干活时她也照说(他 2026-09-29 的裁定)')
    assert.equal(hb.careTrace().reason, 'sent')
    assert.deepEqual(reasonsOf(store).filter((r) => r === 'working'), [],
      'working 这个判词不该再出现')
  } finally { store.close() }
})

test('目标解析也管着提醒与她的闹钟(三条路同一个目标)', async () => {
  const store = freshStore()
  const c = clock(atLocal(15, 0))
  try {
    const herAgent = fakeAgent('her-session')
    const hb = createHeartbeat({
      engine: fakeEngine({ longing: careState({ shouldCare: false }) }), store,
      logger: null, isEnabled: () => true, now: c.now,
      createUserMessage: (m) => ({ role: 'user', ...m }), masterId: MASTER_ID,
      resolveCareTarget: async () => ({ agent: herAgent, sessionId: 'her-session' }),
      getProactiveScoring: () => PROACTIVE_SCORING_OFF // 测试隔离:测目标解析,不测打分
    })
    const tickAgent = fakeAgent('sess-1')
    await hb.tick(tickAgent)
    // 闹钟落在"抽到的那条会话"里也能被查到(它按 session_id 取),但**说**要投到她那条
    store.wakeAdd({ at: c.now() / 1000 - 1, note: '到点了', sessionId: 'sess-1' })
    c.advance(0.5)
    await hb.tick(tickAgent)
    assert.equal(hb.careTrace().reason, 'wake-sent')
    assert.equal(tickAgent.sent.length, 0, '不投到抽到的那条')
    assert.equal(herAgent.sent.length, 1, '投到她那一条')
    assert.equal(store.careBeatsSince(0)[0].targetSessionId, 'her-session', '账上带目标会话')
  } finally { store.close() }
})

test('G1:退避窗口里到点的闹钟**照样准点响**(退避只压关怀通道,不压她的闹钟)', async () => {
  const store = freshStore()
  const c = clock(atLocal(15, 0))
  try {
    const hb = makeHeartbeat(fakeEngine({ longing: careState({ shouldCare: false }) }), store, { now: c.now })
    const agent = fakeAgent('sess-1')
    await hb.tick(agent)
    assert.equal(hb.careTrace().quietStreak, 1, '第一拍纯安静 ⇒ 安静计数起来')
    assert.ok(hb.careTrace().nextPollAt > 0, '并排下一拍(退避窗口开了)')
    c.advance(0.5) // 30 秒后:还在退避窗口里(第一拍给的窗口是 2 分钟)
    await hb.tick(agent)
    assert.equal(hb.careTrace().reason, 'backoff', '窗口内普通一拍:让路(省引擎帧)')
    // 现在她在窗口里排了一个**已经到点**的闹钟(他今天亲测的那一幕)
    store.wakeAdd({ at: c.now() / 1000 - 1, note: '到点了就得响', sessionId: 'sess-1' })
    c.advance(0.5)
    await hb.tick(agent)
    assert.equal(agent.sent.length, 1, '到点的闹钟在退避窗口里也必须响(修前:最多晚 8 分钟)')
    assert.equal(hb.careTrace().reason, 'wake-sent', '账上写的是 wake-sent,不是 backoff')
    assert.equal(hb.careTrace().quietStreak, 0, '她开口了 ⇒ 退避复位')
  } finally { store.close() }
})

test('G1:退避窗口里到点的**约定提醒**也不许被拖(他下的命令到点就是到点)', async () => {
  const store = freshStore()
  const c = clock(atLocal(15, 0))
  try {
    const engine = fakeEngine({ longing: careState({ shouldCare: false }) })
    const hb = makeHeartbeat(engine, store, { now: c.now })
    const agent = fakeAgent('sess-1')
    await hb.tick(agent)                       // 纯安静 ⇒ 退避窗口开
    assert.equal(agent.sent.length, 0)
    assert.ok(hb.careTrace().nextPollAt > 0, '退避窗口已开')
    // 到点了:他托付的那件事该提醒了(窗口中途才变成"有东西可提醒")
    engine.threadsRemindable = async () => ({ items: [{ thread_id: 7, session_id: 'sess-1', content: '说好这时候提醒他' }] })
    c.advance(0.5) // 还在退避窗口里(30 秒 < 2 分钟)
    await hb.tick(agent)
    assert.equal(agent.sent.length, 1, '提醒不该被退避拖住')
    assert.equal(hb.careTrace().reason, 'reminder-sent')
  } finally { store.close() }
})

test('resolveWakeAt:分钟 / HH:MM(过了算明天) / ISO;过去与太远要拦住', () => {
  const now = atLocal(15, 0)
  assert.deepEqual(resolveWakeAt({ after_minutes: 30 }, now), { ok: true, at: Math.round((now + 1800000) / 1000) })
  assert.deepEqual(resolveWakeAt({ at: '20:30' }, now), { ok: true, at: Math.round(atLocal(20, 30) / 1000) })
  assert.deepEqual(resolveWakeAt({ at: '09:00' }, now), { ok: true, at: Math.round(atLocal(9, 0, 29) / 1000) }, '今天过了 ⇒ 明天')
  assert.equal(resolveWakeAt({ at: '2026-09-29T08:00' }, now).ok, true)
  assert.equal(resolveWakeAt({}, now).reason, 'bad-time')
  assert.equal(resolveWakeAt({ after_minutes: '  ' }, now).reason, 'bad-time')
  assert.equal(resolveWakeAt({ after_minutes: 'abc' }, now).reason, 'bad-time')
  assert.equal(resolveWakeAt({ at: '25:00' }, now).reason, 'bad-time')
  assert.equal(resolveWakeAt({ after_minutes: 0.1 }, now).reason, 'bad-time', '排在过去/立刻 = 拦掉')
  assert.equal(resolveWakeAt({ after_minutes: 60 * 24 * 40 }, now).reason, 'too-far')
  assert.equal(WAKE_MAX_AHEAD_MS, 30 * 24 * 60 * 60 * 1000)
})

test('wakeAtText:回执上的钟面是本地人话(相对时间不许说成「0.0 小时后」)', () => {
  const now = atLocal(15, 0)
  assert.equal(wakeAtText(now / 1000, now), '09-28 15:00(0 分钟后)')
  assert.equal(wakeAtText(now / 1000 + 30 * 60, now), '09-28 15:30(30 分钟后)')
  assert.equal(wakeAtText(now / 1000 + 7200, now), '09-28 17:00(2 小时后)')
})

test('闹钟最早只能排到 30 秒后(排在过去 = 立刻响,那不该叫闹钟)', () => {
  assert.equal(WAKE_MIN_AHEAD_MS, 30000)
  const now = atLocal(15, 0)
  assert.equal(resolveWakeAt({ after_minutes: 0.4 }, now).reason, 'bad-time')
  assert.equal(resolveWakeAt({ after_minutes: 1 }, now).ok, true)
})
