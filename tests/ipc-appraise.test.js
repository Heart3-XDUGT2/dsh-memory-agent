/**
 * 用户侧坐标打分器(`lib/ipc-appraise.js`)单测。
 *
 * 钉的是**设计文档 §1 的五条纪律**(拍板 ①③④⑤⑥):
 *   ① 双轨 + 对账:他的点走打分器、她的点仍走映射,残差**只记账、不回写**;
 *   ② 一次调用出**双方**(缺一侧 ⇒ 那一侧是 `null`,**不许填 0**);
 *   ③ 节流(轮数 + 时间两道闸)与 **gain 门槛**(不够就不落库);
 *   ④ 失败/跳过**必须留痕**(写审计),不许静默返回 null;
 *   ⑤ 零 DDL:结果并进已有 `emotion_vector` JSON 的 `ipc_dyad` 键,别的键一个不动。
 *
 * 全部用假件:假通道(不联网)、假库(不落盘)—— 这个文件一条真实副作用都没有。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createIpcAdapter } from '../lib/ipc-adapter.js'
import {
  IPC_DYAD_KEY, resolveIpcAppraise, mappedSelf, residualOf, gainOf,
  buildDyad, applyGate, mergeDyad, readDyad, createIpcAppraiser
} from '../lib/ipc-appraise.js'

/** 她的情绪向量:爱意 8 / 依赖 6 ⇒ 映射 c=0.8、a=0.4(见 emotion-ipc-bridge 的字典)。 */
const VEC = { global: { valence: 4, arousal: 6, fatigue: 1 }, target_master: { affection: 8, dependency: 6, playfulness: 7, sadness: 0 } }

/** 一份"看起来正常"的打分输出(上游形状:嵌套 self/other + confidence)。 */
const RAW_OK = JSON.stringify({
  self: { a: 0.62, c: 0.78 },
  other: { a: 0.28, c: 0.55 },
  confidence: 0.9,
  reason: '他这句收着说,但一直在接话'
})

const fakeStore = (vec = VEC) => {
  const state = { emotionVector: vec, previousEmotionVector: {}, moodIntensity: 3, prevMoodIntensity: 3 }
  const saved = []
  return {
    state,
    saved,
    getState: () => state,
    saveEmotionVector: (v) => { saved.push(v); state.emotionVector = v; return true }
  }
}

const makeAppraiser = ({ raw = RAW_OK, store = fakeStore(), audits = [], settings = {}, now = () => 1_760_000_000_000 } = {}) => {
  const adapter = createIpcAdapter({})
  const appraiser = createIpcAppraiser({
    adapter,
    callStructured: async () => raw,
    store,
    audit: (f) => audits.push(f),
    getSettings: () => ({ ipcAppraiseEnabled: true, ...settings }),
    recentTurns: () => [{ user: '在吗', assistant: '在。' }],
    getPersonaAnchor: () => '（人格正文）',
    getNames: () => ({ userName: '他', agentName: '她' }),
    now
  })
  return { adapter, appraiser, store, audits }
}

// ---------------------------------------------------------------- 参数与映射

test('resolveIpcAppraise:默认值 + 越界回退 + 总闸(面板乱填也不炸)', () => {
  const d = resolveIpcAppraise({})
  assert.equal(d.enabled, true)
  assert.equal(d.everyTurns, 3)
  assert.equal(d.minMinutes, 10)
  assert.equal(d.gainMin, 0.35)
  assert.equal(d.transcriptTurns, 5)
  // 越界/胡写 ⇒ 回默认(不是 0)
  assert.equal(resolveIpcAppraise({ ipcAppraiseEveryTurns: 0 }).everyTurns, 1, '轮数下限 1')
  assert.equal(resolveIpcAppraise({ ipcAppraiseEveryTurns: 'abc' }).everyTurns, 3)
  assert.equal(resolveIpcAppraise({ ipcAppraiseMinMinutes: 99999 }).minMinutes, 1440)
  assert.equal(resolveIpcAppraise({ ipcAppraiseGainMin: 5 }).gainMin, 1)
  assert.equal(resolveIpcAppraise({ ipcAppraiseTurns: -3 }).transcriptTurns, 1)
  // 只有显式 false 才关(与仓库其余总闸同口径)
  assert.equal(resolveIpcAppraise({ ipcAppraiseEnabled: false }).enabled, false)
  assert.equal(resolveIpcAppraise({ ipcAppraiseEnabled: 'no' }).enabled, true)
})

test('mappedSelf:她的点仍走**映射**(affection→c、dependency→(1−a)),缺维记账不猜', () => {
  const m = mappedSelf(VEC)
  assert.equal(m.point.c, 0.8)
  assert.equal(m.point.a, 0.4)
  assert.deepEqual(m.missing, [])
  const miss = mappedSelf({ target_master: { affection: 8 } })
  assert.ok(miss.missing.includes('dependency'), '缺的那一维要记账')
  assert.equal(miss.point.a, 0.5, '缺维按中性,不假装 0')
})

// ---------------------------------------------------------------- 残差(只记账)

test('residualOf:两侧都齐才算;分带走 space-bridge 的同一套阈值', () => {
  const r = residualOf({ appraised: { a: 0.62, c: 0.78 }, mapped: { a: 0.4, c: 0.8 } })
  assert.equal(r.ok, true)
  assert.equal(r.a, 0.22)
  assert.equal(r.c, -0.02)
  assert.equal(r.maxAbs, 0.22)
  assert.equal(r.gate, 'yellow', '0.15 ≤ |0.22| ≤ 0.30 ⇒ 黄档(只给方向)')
  // 绿 / 红
  assert.equal(residualOf({ appraised: { a: 0.41, c: 0.8 }, mapped: { a: 0.4, c: 0.8 } }).gate, 'green')
  assert.equal(residualOf({ appraised: { a: 0.9, c: 0.8 }, mapped: { a: 0.4, c: 0.8 } }).gate, 'red')
  // 缺一侧 ⇒ unknown(不是 0、不是绿)
  const u = residualOf({ appraised: null, mapped: { a: 0.4, c: 0.8 } })
  assert.equal(u.ok, false)
  assert.equal(u.maxAbs, null)
  assert.equal(u.gate, 'unknown')
})

test('残差**只记账**:不改入参、不动映射值、数不进任何坐标', () => {
  const appraised = Object.freeze({ a: 0.62, c: 0.78 })
  const mapped = Object.freeze({ a: 0.4, c: 0.8 })
  const r = residualOf({ appraised, mapped })
  assert.equal(r.ok, true)
  // 入参原样(冻结对象没被碰过;能跑完就说明没写它)
  assert.deepEqual(appraised, { a: 0.62, c: 0.78 })
  assert.deepEqual(mapped, { a: 0.4, c: 0.8 })
  // 返回的只是差值对象 —— 没有"修正后的坐标"这种东西
  assert.deepEqual(Object.keys(r).sort(), ['a', 'c', 'gate', 'maxAbs', 'note', 'ok'])
})

// ---------------------------------------------------------------- gain 与落库形状

test('gainOf:自信 × 解析完整度(不完整打对折),缺 confidence 用 0.6', () => {
  assert.equal(gainOf({ confidence: 0.9, complete: true }), 0.9)
  assert.equal(gainOf({ confidence: 0.9, complete: false }), 0.45)
  assert.equal(gainOf({ complete: true }), 0.6)
  assert.equal(gainOf(null), 0.3, 'null ⇒ 0.6 × 对折')
})

test('buildDyad:双方 + 映射值 + 残差 + gate 都在;`self` 只作对账证据', () => {
  const mapped = { a: 0.4, c: 0.8 }
  const d = buildDyad({
    appraisal: { self: { a: 0.62, c: 0.78 }, other: { a: 0.28, c: 0.55 }, labels: { self: '主导', other: '随和' }, confidence: 0.9, complete: true, reason: 'r' },
    mapped,
    gain: 0.9,
    at: 123,
    dynamics: { reactivity: 0.5, maxStepPerTurn: 0.2, escalated: false }
  })
  assert.deepEqual(d.self, { a: 0.62, c: 0.78 })
  assert.deepEqual(d.other, { a: 0.28, c: 0.55 })
  assert.deepEqual(d.mapped, mapped, '映射出来的她要原样留证据(对账用)')
  assert.equal(d.gate, 'yellow')
  assert.equal(d.lowConfidence, false)
  assert.equal(d.at, 123)
  assert.equal(d.src, 'appraise@ipc-core')
  assert.equal(d.dynamics.reactivity, 0.5)
})

test('缺 other ⇒ `null`(**绝不填 0**);`applyGate` 不给点、面板照旧灰环', () => {
  const d = buildDyad({ appraisal: { self: { a: 0.6, c: 0.6 }, other: null, confidence: 0.9, complete: true }, mapped: { a: 0.4, c: 0.8 }, gain: 0.9, at: 1 })
  assert.equal(d.other, null)
  const g = applyGate(d)
  assert.equal(g.draw, false)
  assert.equal(g.other, null)
  assert.ok(String(g.note).includes('可信度') || String(g.note).includes('坐标'))
  // 红档:两个点都不给
  const red = buildDyad({ appraisal: { self: { a: 0.95, c: 0.6 }, other: { a: 0.1, c: 0.6 }, confidence: 0.9, complete: true }, mapped: { a: 0.4, c: 0.6 }, gain: 0.9, at: 1 })
  assert.equal(red.gate, 'red')
  assert.equal(applyGate(red).draw, false)
  assert.ok(String(applyGate(red).note).includes('红档'))
  // 没有 dyad(从没判过 / 总闸关)⇒ 一样不给点
  assert.equal(applyGate(null).draw, false)
  assert.equal(applyGate(undefined).other, null)
  // 正常 ⇒ 给
  const ok = buildDyad({ appraisal: { self: { a: 0.42, c: 0.8 }, other: { a: 0.3, c: 0.55 }, confidence: 0.9, complete: true }, mapped: { a: 0.4, c: 0.8 }, gain: 0.9, at: 1 })
  assert.equal(ok.gate, 'green')
  assert.deepEqual(applyGate(ok).other, { a: 0.3, c: 0.55 })
})

test('mergeDyad / readDyad:零 DDL 落点;不改入参;脏数据当没有', () => {
  const vec = { global: { valence: 4 }, target_master: { affection: 8 } }
  const out = mergeDyad(vec, { other: { a: 0.3, c: 0.5 } })
  assert.equal(Object.hasOwn(vec, IPC_DYAD_KEY), false, '不许改入参')
  assert.deepEqual(out.global, vec.global, '别的键一个不动')
  assert.equal(out[IPC_DYAD_KEY].other.a, 0.3)
  assert.deepEqual(readDyad(out).other, { a: 0.3, c: 0.5 })
  for (const bad of [null, undefined, 42, 'x', [], {}, { ipc_dyad: 7 }, { ipc_dyad: [] }]) {
    assert.equal(readDyad(bad), null, String(bad) + ' 该当没有')
  }
})

// ---------------------------------------------------------------- 端到端(假通道)

test('run:一次调用出**双方** ⇒ 落库带 ipc_dyad、别的键不动、审计留一行「已判定」', async () => {
  const { adapter, appraiser, store, audits } = makeAppraiser({})
  await adapter.ensure()
  const out = await appraiser.run({ sessionId: 's1', userText: '在吗', assistantText: '在。' })
  assert.equal(out.ok, true)
  assert.ok(out.dyad.self && out.dyad.other, '双方都要在(上游一次出两边)')
  // ⚠️ 这一格**期望就是黄档**:两把尺子天生不一样 —— 她的 a 是映射出来的 0.4,
  // 模型直判的 self 是 0.62。差 0.2(不是 0.22:上游 `parseAppraisal` 会把坐标
  // **量化到 0.1 网格** —— `quantizePoint`,所以 0.62 → 0.6)。这正是"对账"要记账的
  // 东西:不假装一致、也不去修任何一边。
  assert.equal(out.gate, 'yellow')
  assert.equal(out.residual.maxAbs, 0.2)
  assert.equal(store.saved.length, 1, '落库一次')
  const saved = store.saved[0]
  assert.deepEqual(saved.global, VEC.global, '别的键一个不动')
  assert.deepEqual(saved.target_master, VEC.target_master)
  // ⚠️ 这一格**不是**原样抄模型给的 `other`(0.3/0.6):落库前过了 upsream 的
  // 惯性结算(`integrateDyad` 的 `latent`,从上一位置朝打分点走一步)。
  // 第一版这里读错字段(`point`,上游其实叫 `latent`)⇒ 惯性被静默跳过,
  // 而落库结果"看起来正常" —— 所以这条断言专门钉住"确实走了动力学"。
  const other = saved[IPC_DYAD_KEY].other
  assert.ok(other && Number.isFinite(other.a) && Number.isFinite(other.c), '落库的点要是个真坐标')
  assert.ok(out.dyad.dynamics && out.dyad.dynamics.latent, '动力学结算结果要留下证据')
  assert.ok(other.a < 0.5, '起点 0.5 → 打分 0.3:一步之内该往低调,但不会一步到底')
  assert.equal(out.dyad.dynamics.escalated, false)
  assert.equal(saved[IPC_DYAD_KEY].src, 'appraise@ipc-core')
  assert.equal(audits.length, 1)
  assert.equal(audits[0].toolCall, 'ipc-appraise')
  assert.ok(String(audits[0].userInput).includes('已判定'))
  // 状态面读得到
  const st = appraiser.stats()
  assert.equal(st.ok, 1)
  assert.equal(st.lastGate, 'yellow')
})

test('run:gain 门槛不足 ⇒ **不落库** + 审计留痕(宁可没有,也不要假点)', async () => {
  const raw = JSON.stringify({ self: { a: 0.5, c: 0.5 }, other: { a: 0.4, c: 0.5 }, confidence: 0.2 })
  const { adapter, appraiser, store, audits } = makeAppraiser({ raw })
  await adapter.ensure()
  const out = await appraiser.run({ sessionId: 's1' })
  assert.equal(out.ok, false)
  assert.ok(String(out.reason).includes('可信度不足'))
  assert.equal(store.saved.length, 0, '门槛不足不许落库')
  assert.equal(audits.length, 1, '但必须留痕')
  assert.ok(String(audits[0].userInput).includes('门槛不足'))
  assert.equal(appraiser.stats().lowGain, 1)
})

test('run:通道空产出 / 解析不了 ⇒ 失败**必须留痕**(不许静默 null)', async () => {
  for (const [raw, word] of [[null, '没有产出'], ['这里没有 JSON', '解析失败']]) {
    const { adapter, appraiser, store, audits } = makeAppraiser({ raw })
    await adapter.ensure()
    const out = await appraiser.run({ sessionId: 's1' })
    assert.equal(out.ok, false)
    assert.ok(String(out.reason).includes(word), '原因要写清:' + out.reason)
    assert.equal(store.saved.length, 0)
    assert.equal(audits.length, 1, '失败也要落审计')
    assert.ok(String(audits[0].userInput).includes('失败'))
    assert.equal(appraiser.stats().failed, 1)
  }
})

test('run:节流两道闸(轮数 + 时间)⇒ skipped;**节流不写审计**(否则每轮一行噪音)', async () => {
  const { adapter, appraiser, audits } = makeAppraiser({ settings: { ipcAppraiseEveryTurns: 3, ipcAppraiseMinMinutes: 10 } })
  await adapter.ensure()
  const first = await appraiser.run({ sessionId: 's1' })
  assert.equal(first.ok, true)
  const second = await appraiser.run({ sessionId: 's1' })
  assert.equal(second.ok, false)
  assert.equal(second.skipped, true)
  assert.ok(String(second.reason).includes('节流'))
  assert.equal(appraiser.stats().skipped, 1)
  assert.equal(audits.length, 1, '只有第一次成功那行;节流不写')
  // 时间到了 / 轮数够了 ⇒ 又能跑(把 now 推到 11 分钟后)
  const { adapter: a2, appraiser: ap2 } = makeAppraiser({ settings: { ipcAppraiseEveryTurns: 1, ipcAppraiseMinMinutes: 10 }, now: () => 1_760_000_000_000 })
  await a2.ensure()
  assert.equal((await ap2.run({ sessionId: 's1' })).ok, true)
  const later = createIpcAppraiser({
    adapter: a2,
    callStructured: async () => RAW_OK,
    store: fakeStore(),
    audit: () => {},
    getSettings: () => ({ ipcAppraiseEnabled: true, ipcAppraiseEveryTurns: 1, ipcAppraiseMinMinutes: 10 }),
    recentTurns: () => [{ user: 'u', assistant: 'a' }],
    getNames: () => ({ userName: '他', agentName: '她' }),
    now: () => 1_760_000_700_000
  })
  assert.equal((await later.run({ sessionId: 's1' })).ok, true, '过了时间闸就能跑')
})

test('run:总闸关 / ipc-core 不可用 ⇒ 跳过且**留痕**(不可用不是"节流")', async () => {
  const off = makeAppraiser({ settings: { ipcAppraiseEnabled: false } })
  await off.adapter.ensure()
  const r1 = await off.appraiser.run({ sessionId: 's1' })
  assert.equal(r1.skipped, true)
  assert.ok(String(r1.reason).includes('总闸'))
  assert.equal(off.audits.length, 1, '总闸关不是节流 ⇒ 要留痕')
  const broken = createIpcAppraiser({
    adapter: createIpcAdapter({ modulePath: './ipc-core/__definitely_missing__.js' }),
    callStructured: async () => RAW_OK,
    store: fakeStore(),
    audit: () => { audits2.push(1) },
    getSettings: () => ({ ipcAppraiseEnabled: true })
  })
  const audits2 = []
  await broken.run({ sessionId: 's1' })
  assert.equal(audits2.length, 1)
  assert.equal(broken.stats().runs, 0)
})

test('run:通道抛错 ⇒ 吞掉并留痕(它是增益,不是依赖)', async () => {
  const audits = []
  const adapter = createIpcAdapter({})
  const ap = createIpcAppraiser({
    adapter,
    callStructured: async () => { throw new Error('适配器炸了') },
    store: fakeStore(),
    audit: (f) => audits.push(f),
    getSettings: () => ({ ipcAppraiseEnabled: true }),
    recentTurns: () => [{ user: 'u', assistant: 'a' }],
    getNames: () => ({ userName: '他', agentName: '她' })
  })
  await adapter.ensure()
  const out = await ap.run({ sessionId: 's1' })
  assert.equal(out.ok, false)
  assert.ok(String(out.reason).includes('适配器炸了'))
  assert.equal(audits.length, 1)
})
