/**
 * P1 电池:`lib/topic-score.js` —— 六维打分 / 可解释性 / 挑选 / 候选抽取。
 *
 * 这一套钉的是"她该不该开口"的第一道闸(施工图 §2.1):**分数必须讲得出为什么**
 * (`why` 逐维之和 == score,不是近似相等),**同分必须有确定答案**(稳定取第一,
 * 免得"谁先谁后"变成随机),**缺表不许炸**(老库还没迁移时,这一类来源今天没有 ——
 * 那不等于"这一拍炸了")。
 *
 * 纯函数一律喂假数据;只有 `collectCandidates` 用**假 db 替身**(带 `prepare().all()`
 * 的最小件)—— 不碰真库、不开网络。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  scoreTopic, pickTop, timingGate, needsReview, collectCandidates, selectBySourceFloor,
  thresholdFor, DEFAULT_WEIGHTS, DEFAULT_CAPS, DIMENSIONS, TYPE_CONCRETENESS,
  DEFAULT_THRESHOLD, DEFAULT_REVIEW_DELTA, DEFAULT_TYPE_THRESHOLDS, TYPE_THRESHOLD_KEYS
} from '../lib/topic-score.js'
import { TOPIC_REPEAT_PENALTY, TOPIC_REPEAT_SIMILARITY } from '../lib/thread-dedupe.js'

const NOW = 1_800_000_000 // 纯数字假时钟,固定值(纯函数不许看真表)
const DAY = 86400
const HOUR = 3600

/** 按**模块自己的维度顺序**求和 —— 与 `scoreTopic` 内部同一顺序,才能断言"逐位相同"。 */
const sumWhy = (scored) => DIMENSIONS.reduce((acc, dim) => acc + scored.why[dim].contrib, 0)

const base = (over = {}) => ({
  id: 't1', type: 'thread', text: '要不要把校园跑补上', createdAt: NOW - DAY, ...over
})

// ---- ① 六维各自单调:输入变大 ⇒ 该维变大 --------------------------------------

test('六维各自单调:同一维的输入变大,只有它变大(其余不动)', () => {
  // unstale:悬得越久越高
  const young = scoreTopic(base({ createdAt: NOW - 1 * DAY }), { now: NOW })
  const old = scoreTopic(base({ createdAt: NOW - 4 * DAY }), { now: NOW })
  assert.ok(old.why.unstale.value > young.why.unstale.value, '悬得久 ⇒ unstale 更大')
  assert.equal(old.why.recency.value < young.why.recency.value, true, '同一事实的时效必须反向(越久越低)')
  assert.equal(old.why.gap.value, young.why.gap.value, '只动 created_at,别的维不许跟着动')

  // recency:越近越高(拿两条同类型的比)
  const fresh = scoreTopic(base({ createdAt: NOW - 1 * HOUR }), { now: NOW })
  const stale = scoreTopic(base({ createdAt: NOW - 48 * HOUR }), { now: NOW })
  assert.ok(fresh.why.recency.value > stale.why.recency.value, '越近 ⇒ recency 越大')

  // gap:显式缺口越大越高
  const lowGap = scoreTopic(base({ gap: 0.2 }), { now: NOW })
  const highGap = scoreTopic(base({ gap: 0.8 }), { now: NOW })
  assert.ok(highGap.why.gap.value > lowGap.why.gap.value, '信息缺口大 ⇒ gap 更大')

  // concreteness:有实物 > 纯记忆
  const mem = scoreTopic({ id: 'm', type: 'memory', text: '她记得他说过的话', createdAt: NOW }, { now: NOW })
  const art = scoreTopic({ id: 'd', type: 'artifact', text: '今天的日记', createdAt: NOW, hasArtifact: true }, { now: NOW })
  assert.ok(art.why.concreteness.value > mem.why.concreteness.value, '有产出 ⇒ concreteness 更大')
  assert.equal(mem.why.concreteness.value, TYPE_CONCRETENESS.memory)
  assert.equal(art.why.concreteness.value, 1)

  // freshness(反向):刚提过 ⇒ 变小。这里证明"变小"的方向,值本身在 ⑦ 钉
  const notRepeat = scoreTopic(base(), { now: NOW, prevTopics: [] })
  const repeated = scoreTopic(base(), { now: NOW, prevTopics: ['要不要把校园跑补上'] })
  assert.ok(repeated.why.freshness.value < notRepeat.why.freshness.value, '刚提过 ⇒ freshness 更小')

  // emotion:情绪分越高越高
  const calm = scoreTopic(base({ emotionScore: 2 }), { now: NOW })
  const hot = scoreTopic(base({ emotionScore: 9 }), { now: NOW })
  assert.ok(hot.why.emotion.value > calm.why.emotion.value, '情绪分高 ⇒ emotion 更大')
})

// ---- ② 封顶:caps 生效 -------------------------------------------------------

test('封顶:7 天以上 unstale 满分;recency 归零;ctx.caps 可覆盖', () => {
  const ancient = scoreTopic(base({ createdAt: NOW - 100 * DAY }), { now: NOW })
  assert.equal(ancient.why.unstale.value, 1, '悬超 7 天 ⇒ 封顶 1(再悬也不更"未结")')
  assert.equal(ancient.why.recency.value, 0, '100 天前 ⇒ 时效归零')
  assert.equal(DEFAULT_CAPS.unstaleDays, 7)

  const capped = scoreTopic(base({ createdAt: NOW - 10 * DAY }), { now: NOW, caps: { unstaleDays: 30 } })
  assert.ok(capped.why.unstale.value < 1 && capped.why.unstale.value > 0, 'cap=30 天 ⇒ 10 天只有 1/3')
  assert.equal(Math.round(capped.why.unstale.value * 100) / 100, 0.33)

  const widened = scoreTopic(base({ createdAt: NOW - 48 * HOUR }), { now: NOW, caps: { recencyHours: 96 } })
  assert.equal(widened.why.recency.value, 0.5, '窗口放大到 96h ⇒ 48h 前记 0.5')

  const neutral = scoreTopic(base({ createdAt: NOW - 999 * DAY, gap: undefined }), { now: NOW, caps: { gapNeutral: 0.9 } })
  assert.equal(neutral.why.gap.value, 0.9, '中性值也能被 caps 覆盖')
})

// ---- ③ 权重生效 --------------------------------------------------------------

test('权重生效:只留 emotion 的权重 ⇒ 分数就等于 emotion 的值', () => {
  const t = base({ emotionScore: 9, createdAt: NOW, gap: 1 })
  const only = scoreTopic(t, { now: NOW, weights: { ...DEFAULT_WEIGHTS, emotion: 1, unstale: 0, gap: 0, concreteness: 0, recency: 0, freshness: 0 } })
  assert.equal(only.why.emotion.value, 1)
  assert.equal(only.score, 1)
  assert.equal(only.why.unstale.contrib, 0)

  const zero = scoreTopic(t, { now: NOW, weights: { unstale: 0, gap: 0, concreteness: 0, recency: 0, freshness: 0, emotion: 0 } })
  assert.equal(zero.score, 0, '全零权重 ⇒ 0 分')

  // 权重缺项/负数一律回落/夹住(不许把分数拉成负的)
  const fallback = scoreTopic(t, { now: NOW, weights: { emotion: -5 } })
  assert.equal(fallback.why.emotion.weight, 0, '负权重夹到 0')
  assert.equal(fallback.why.unstale.weight, DEFAULT_WEIGHTS.unstale, '没给的维回落出厂权重')
})

// ---- ④ 可解释性:why 逐维求和 == score --------------------------------------

test('可解释性:why 逐维 contrib 之和**逐位相同**于 score;每维 value∈[0,1]', () => {
  const cases = [
    [base({ createdAt: NOW - 3 * DAY, emotionScore: 7, hasArtifact: true }), { now: NOW, prevTopics: [] }],
    [base({ createdAt: NOW, emotionScore: 1 }), { now: NOW, prevTopics: ['要不要把校园跑补上'] }],
    [{ id: 'm9', type: 'memory', text: '一句话', createdAt: NOW - 5 * HOUR, emotionScore: 9 }, { now: NOW }],
    [base({ createdAt: NOW - 40 * DAY }), { now: NOW, weights: { unstale: 0.9 } }],
    [{}, {}] // 全空输入也要出数,不许炸
  ]
  for (const [topic, ctx] of cases) {
    const s = scoreTopic(topic, ctx)
    assert.equal(sumWhy(s), s.score, 'why 之和必须严格等于 score')
    // 分数上界 = 权重之和(出厂权重和为 1;调用方给超配的权重时上界跟着变 ——
    // 这里*不*替他把权重归一化,免得"权重生效"那条测试失去意义)
    const wSum = DIMENSIONS.reduce((acc, dim) => acc + s.why[dim].weight, 0)
    assert.ok(Number.isFinite(s.score) && s.score >= 0 && s.score <= wSum + 1e-9, 'score 落在 [0,Σweight]:' + s.score)
    for (const dim of DIMENSIONS) {
      const cell = s.why[dim]
      assert.ok(cell.value >= 0 && cell.value <= 1, dim + ' 的值必须在 0~1')
      assert.equal(cell.contrib, cell.value * cell.weight, dim + ' 的 contrib == value*weight')
    }
  }
  // 纯函数:同输入同输出
  const a = scoreTopic(base({ emotionScore: 5 }), { now: NOW })
  const b = scoreTopic(base({ emotionScore: 5 }), { now: NOW })
  assert.deepEqual(a, b)
  // 出厂权重之和必须是 1(否则 score 与 threshold 0.6 就不同量纲了)
  const dw = DIMENSIONS.reduce((acc, dim) => acc + DEFAULT_WEIGHTS[dim], 0)
  assert.ok(Math.abs(dw - 1) < 1e-9, '出厂权重和 ≈ 1,实际 ' + dw)
})

// ---- ⑤ 信息缺口:没有字段就退回中性 0.5 并注明 --------------------------------

test('gap:没有"他知不知道"的字段 ⇒ 中性 0.5 且注明;提过 ⇒ 缺口缩小', () => {
  const unknown = scoreTopic(base({ lastMentionedAt: 0 }), { now: NOW })
  assert.equal(unknown.why.gap.value, DEFAULT_CAPS.gapNeutral)
  assert.equal(unknown.why.gap.note, 'no-field', '§3.3:缺字段的妥协必须写清楚,不许假装知道')

  const told = scoreTopic(base({ lastMentionedAt: NOW - HOUR }), { now: NOW })
  assert.equal(told.why.gap.value, DEFAULT_CAPS.gapMentioned)
  assert.equal(told.why.gap.note, 'mentioned-before')

  const explicit = scoreTopic(base({ gap: 0.75 }), { now: NOW })
  assert.equal(explicit.why.gap.value, 0.75)
  assert.equal(explicit.why.gap.note, 'explicit')
})

// ---- ⑥ 挑选:过滤 + 稳定取第一 + 空 → null ------------------------------------

test('pickTop:空候选/全不过线 → null;过线取 top-1', () => {
  assert.equal(pickTop([], { minScore: 0.5 }), null)
  assert.equal(pickTop(null, { minScore: 0.5 }), null)
  assert.equal(pickTop([null, undefined, 3], { minScore: 0 }), null, '坏元素跳过,不许炸')

  const cands = [
    { id: 'low', type: 'memory', text: '淡淡的一件小事', createdAt: NOW - 60 * DAY, emotionScore: 1 },
    { id: 'high', type: 'artifact', text: '今天的日记', createdAt: NOW - HOUR, emotionScore: 9, hasArtifact: true }
  ]
  const top = pickTop(cands, { minScore: 0.5, now: NOW })
  assert.equal(top.id, 'high')
  assert.ok(top.score >= 0.5)

  assert.equal(pickTop(cands, { minScore: 0.999, now: NOW }), null, '全不过线 ⇒ null')
  assert.equal(pickTop(cands, { minScore: 0, now: NOW }).id, 'high')
})

test('pickTop:同分稳定取**先来的那条**(换个顺序答案就换)', () => {
  const mk = (id) => ({ id, type: 'memory', text: '一模一样的两句话', createdAt: NOW - HOUR, emotionScore: 5 })
  const ab = pickTop([mk('a'), mk('b')], { now: NOW })
  const ba = pickTop([mk('b'), mk('a')], { now: NOW })
  assert.equal(ab.score, ba.score, '前提:两条同分')
  assert.equal(ab.id, 'a')
  assert.equal(ba.id, 'b')
  // 已打过分的候选直接复用,不再重算(分数由调用方说了算)
  assert.equal(pickTop([{ id: 'x', score: 0.1 }, { id: 'y', score: 0.9 }], { now: NOW }).id, 'y')
})

// ---- ⑦ freshness 真的复用了 thread-dedupe 的惩罚器 ---------------------------

test('freshness:复用 topicRepeatPenalty(同值同常量的第一次接线)', () => {
  const topic = base({ text: '这周末要不要去把校园跑补上,还差三次' })
  const hit = scoreTopic(topic, { now: NOW, prevTopics: ['这周末要不要去把校园跑补上,还差三次'] })
  assert.equal(hit.why.freshness.value, TOPIC_REPEAT_PENALTY, '命中就吃那个惩罚值,不是新写的系数')
  assert.equal(hit.why.freshness.value, 0.5)

  const miss = scoreTopic(topic, { now: NOW, prevTopics: ['你面试那家店后来给你回复了吗'] })
  assert.equal(miss.why.freshness.value, 1, '换话题不罚')

  const none = scoreTopic(topic, { now: NOW })
  assert.equal(none.why.freshness.value, 1, '没给 prevTopics 不许当"罚"')

  // 惩罚参数可透传(惩罚器自己的 opts 契约)
  const custom = scoreTopic(topic, { now: NOW, prevTopics: ['这周末要不要去把校园跑补上,还差三次'], repeatPenalty: 0.9 })
  assert.equal(custom.why.freshness.value, 0.9)
  // 相似度阈值也是它的常量(0.6),沾边不罚
  const far = scoreTopic(base({ text: '你今天在图书馆看见谁了' }), { now: NOW, prevTopics: ['我明天想去图书馆待一下午'] })
  assert.equal(far.why.freshness.value, 1)
  assert.equal(TOPIC_REPEAT_SIMILARITY, 0.6)
})

// ---- ⑧ 候选抽取:假 db,三类来源 ---------------------------------------------

/** 假 db 替身:`prepare(sql).all(...params)`,按 SQL 认表;表不在 ⇒ 抛(模拟 SQLite 缺表)。 */
function fakeDb (tables = {}) {
  const kindOf = (sql) => sql.includes('pending_threads')
    ? 'threads'
    : sql.includes('episodic_memory') ? 'memories' : sql.includes('diary') ? 'diary' : 'other'
  return {
    prepare (sql) {
      return {
        all () {
          const k = kindOf(sql)
          if (!Object.prototype.hasOwnProperty.call(tables, k)) throw new Error('no such table: ' + k)
          return tables[k]
        }
      }
    }
  }
}

test('collectCandidates:三类来源各用哪个读口、字段怎么落(假 db)', () => {
  const db = fakeDb({
    threads: [
      { thread_id: 19, content: '用户坐今晚10点的火车回家', session_id: 'session-2d2a', last_mentioned_at: 0, created_at: NOW - 3 * DAY },
      { thread_id: 20, content: '', session_id: 's', last_mentioned_at: 0, created_at: NOW }, // 空壳 ⇒ 跳过
      { thread_id: 0, content: '缺主键的脏行', created_at: NOW } // 脏行 ⇒ 跳过
    ],
    memories: [
      { memory_id: 7, summary: '用户说以后会学做章鱼小丸子', emotion_score: 9, timestamp: NOW - 6 * HOUR },
      { memory_id: 8, summary: '', emotion_score: 3, timestamp: NOW } // 空 summary ⇒ 跳过
    ],
    diary: [
      { date: '2026-09-30', content: '今天他坐了夜车', created_at: NOW - HOUR },
      { date: '2026-08-01', content: '很久以前的一页', created_at: NOW - 30 * DAY } // 出窗口 ⇒ 跳过
    ]
  })
  const out = collectCandidates({ db, now: NOW, sessionId: 'session-x', limit: 50, windowHours: 72 })
  const byId = Object.fromEntries(out.map((c) => [c.id, c]))

  assert.deepEqual(out.map((c) => c.id), ['thread:19', 'mem:7', 'diary:2026-09-30'], '出窗口/空壳行都不该出现')
  assert.deepEqual(byId['thread:19'], {
    id: 'thread:19', type: 'thread', text: '用户坐今晚10点的火车回家',
    createdAt: NOW - 3 * DAY, lastMentionedAt: 0, sessionId: 'session-2d2a', emotionScore: 0, hasArtifact: false
  })
  assert.deepEqual(byId['mem:7'], {
    id: 'mem:7', type: 'memory', text: '用户说以后会学做章鱼小丸子',
    createdAt: NOW - 6 * HOUR, emotionScore: 9, hasArtifact: false
  })
  assert.deepEqual(byId['diary:2026-09-30'], {
    id: 'diary:2026-09-30', type: 'artifact', text: '今天他坐了夜车',
    // 2026-09-30 P2:日记的情绪分从 `mood` 换算(×2,mood 缺省 3 ⇒ 6)。
    // 以前恒 0 —— 那是"日记永远过不了 0.6 线"的根因(见 diaryCandidates 注释)。
    createdAt: NOW - HOUR, emotionScore: 6, hasArtifact: true
  })

  // limit 生效(总候选数上限;先话题、后记忆、再日记)
  assert.deepEqual(collectCandidates({ db, now: NOW, limit: 1 }).map((c) => c.id), ['thread:19'])
  assert.deepEqual(collectCandidates({ db, now: NOW, limit: 2 }).map((c) => c.id), ['thread:19', 'mem:7'])
  // now 不给 ⇒ 日记不判窗口(宁可多收,也不拿本机时钟当判据)
  assert.ok(collectCandidates({ db }).some((c) => c.id === 'diary:2026-08-01'))
})

test('collectCandidates:容错(缺表/返回 null/假对象/db 为空)一律不抛', () => {
  // 只有话题表:另两类缺表 ⇒ 当场空的,不炸
  const onlyThreads = fakeDb({ threads: [{ thread_id: 1, content: '只有这一条', created_at: NOW }] })
  assert.deepEqual(collectCandidates({ db: onlyThreads, now: NOW }).map((c) => c.id), ['thread:1'])

  // 返回 null / 非数组
  const nullish = { prepare: () => ({ all: () => null }) }
  assert.deepEqual(collectCandidates({ db: nullish, now: NOW }), [])

  // prepare 本身抛(表都没建出来)
  const angry = { prepare: () => { throw new Error('no such table') } }
  assert.deepEqual(collectCandidates({ db: angry, now: NOW }), [])

  // 什么都没有
  assert.deepEqual(collectCandidates({ db: null, now: NOW }), [])
  assert.deepEqual(collectCandidates({ db: {}, now: NOW }), [])
  assert.deepEqual(collectCandidates({}), [])

  // 坏 limit 回落默认,不许返回 undefined
  assert.ok(Array.isArray(collectCandidates({ db: onlyThreads, limit: -3 })))
})

test('collectCandidates:给 store 对象时走**现成读口**(listMemories/latestDiaries)', () => {
  const inner = fakeDb({
    threads: [{ thread_id: 5, content: '悬着的约定', session_id: 's5', last_mentioned_at: NOW - HOUR, created_at: NOW - 2 * DAY }]
  })
  const calls = []
  const storeLike = {
    db: inner, // 话题没有可用读口(store.listThreads() 不吐 created_at)⇒ 走只读 SELECT
    listThreads: () => { calls.push('listThreads'); return { waiting: [], due: [], done: [], untimed: [], now: NOW } },
    listMemories: (opts) => {
      calls.push(['listMemories', opts])
      return { total: 1, page: 1, limit: 50, rows: [{ memoryId: 7, summary: '她记得的', emotionScore: 9, timestamp: NOW - 60 }] }
    },
    latestDiaries: (n) => {
      calls.push(['latestDiaries', n])
      return [{ date: '2026-09-30', content: '今天的日记', mood: 3, longingValue: 0, createdAt: NOW - 2 * HOUR }]
    }
  }
  const out = collectCandidates({ db: storeLike, now: NOW, windowHours: 72 })
  assert.deepEqual(out.map((c) => c.id), ['thread:5', 'mem:7', 'diary:2026-09-30'])
  assert.equal(out[1].emotionScore, 9)
  assert.equal(out[2].hasArtifact, true)
  assert.ok(calls.some((c) => Array.isArray(c) && c[0] === 'listMemories'), '记忆走了读口')
  assert.ok(calls.some((c) => Array.isArray(c) && c[0] === 'latestDiaries'), '日记走了读口')

  // 读口炸了 ⇒ 退回原始 SELECT(不许把整卷丢掉)
  const brokenDoors = { db: inner, listMemories: () => { throw new Error('boom') }, latestDiaries: () => { throw new Error('boom') } }
  assert.ok(Array.isArray(collectCandidates({ db: brokenDoors, now: NOW })))
})

// ---- ⑨ 复核边缘区(折中方案)--------------------------------------------------

test('needsReview:开关/额度/边缘区三条边界', () => {
  const thr = DEFAULT_THRESHOLD
  assert.equal(DEFAULT_REVIEW_DELTA, 0.08)
  assert.equal(DEFAULT_THRESHOLD, 0.6)

  const on = { reviewEnabled: true, threshold: thr, reviewDelta: DEFAULT_REVIEW_DELTA, reviewBudgetLeft: 6 }
  assert.equal(needsReview(thr, on), true, '正好在阈值上 ⇒ 边缘区')
  assert.equal(needsReview(thr + DEFAULT_REVIEW_DELTA, on), true, '== threshold+delta ⇒ 命中(闭区间)')
  assert.equal(needsReview(thr - DEFAULT_REVIEW_DELTA, on), true, '== threshold-delta ⇒ 命中')
  assert.equal(needsReview(thr + DEFAULT_REVIEW_DELTA + 1e-6, on), false, '出边缘区 ⇒ 本地定')
  assert.equal(needsReview(0.99, on), false, '明显过线 ⇒ 不花复核')

  assert.equal(needsReview(thr, { ...on, reviewEnabled: false }), false, '开关关着 ⇒ 一律 false')
  assert.equal(needsReview(thr, { ...on, reviewEnabled: undefined }), false, '只有 === true 才算开')
  assert.equal(needsReview(thr, { ...on, reviewBudgetLeft: 0 }), false, '日额度用完 ⇒ false')
  assert.equal(needsReview(thr, { ...on, reviewBudgetLeft: -1 }), false)

  // 坏输入不许崩
  assert.equal(needsReview(NaN, on), false)
  assert.equal(needsReview(undefined, on), false)
  assert.equal(needsReview(thr, {}), false, '没写 reviewEnabled ⇒ false')
  assert.equal(needsReview(thr, { reviewEnabled: true, threshold: NaN, reviewDelta: -1 }), true, '坏阈值/负 delta 回落默认且不崩')
})

// ---- ⑪ 来源保底:每个来源保底 N 条 + 余量按分数轮转(2026-09-30 P2 决定④)----

test('保底:日记不再被话题/记忆挤掉(P1 暴露的饥饿 —— artifact 具体性最高却永远进不了池)', () => {
  const mk = (id) => ({ id, type: 'memory', text: '记忆 ' + id, createdAt: NOW - HOUR, emotionScore: 5 })
  const sources = [
    { type: 'thread', items: [1, 2, 3, 4, 5, 6].map((n) => ({ id: 'thread:' + n, type: 'thread', text: '悬置 ' + n, createdAt: NOW - 2 * DAY })) },
    { type: 'memory', items: [1, 2, 3, 4, 5, 6].map((n) => mk('mem:' + n)) },
    { type: 'artifact', items: [{ id: 'diary:2026-09-30', type: 'artifact', text: '今天的日记', createdAt: NOW - HOUR, hasArtifact: true }] }
  ]
  // 不保底:座位先被话题/记忆吃光,日记**进不了池**(这就是那个饥饿问题)
  const without = selectBySourceFloor(sources, { limit: 4, floor: 0, scoreCtx: { now: NOW } })
  assert.deepEqual(without.map((c) => c.id), ['thread:1', 'thread:2', 'thread:3', 'thread:4'])
  assert.equal(without.some((c) => c.id.startsWith('diary:')), false, '前提:不保底时日记进不了池')
  // 保底 1 条/来源:日记**必进**,剩下按分数轮转
  const withFloor = selectBySourceFloor(sources, { limit: 4, floor: 1, scoreCtx: { now: NOW } })
  assert.ok(withFloor.some((c) => c.id === 'diary:2026-09-30'), '保底必须把日记收进来')
  assert.equal(withFloor[0].id, 'thread:1', '每个来源的第一条按来源顺序先落座')
  assert.equal(withFloor[1].id, 'mem:1')
  assert.equal(withFloor[2].id, 'diary:2026-09-30')
  assert.equal(withFloor.length, 4)
})

test('保底:余量按**分数**轮转(同分先来的先上,不靠 sort 稳定性)', () => {
  const cheap = (id) => ({ id, type: 'memory', text: '很淡的一件事 ' + id, createdAt: NOW - 60 * DAY, emotionScore: 1 })
  const rich = (id) => ({ id, type: 'artifact', text: '今天的日记 ' + id, createdAt: NOW - 1000, emotionScore: 9, hasArtifact: true })
  const sources = [
    { type: 'thread', items: [cheap('t1'), cheap('t2'), cheap('t3')] },
    { type: 'memory', items: [cheap('m1'), cheap('m2'), cheap('m3')] },
    { type: 'artifact', items: [rich('d1'), rich('d2'), rich('d3')] }
  ]
  const out = selectBySourceFloor(sources, { limit: 5, floor: 1, scoreCtx: { now: NOW } })
  // 保底先收 t1/m1/d1,余 2 个座位给分最高的两条(d2/d3 —— artifact 分最高)
  assert.deepEqual(out.map((c) => c.id), ['t1', 'm1', 'd1', 'd2', 'd3'])
})

test('保底:floor=0 与 P1 的"顺序切"逐条相同(回滚路径不许变);坏输入不崩', () => {
  const items = (p) => [1, 2, 3].map((n) => ({ id: p + n, type: 'memory', text: 'x', createdAt: NOW }))
  const sources = [{ type: 'thread', items: items('t') }, { type: 'memory', items: items('m') }]
  assert.deepEqual(
    selectBySourceFloor(sources, { limit: 4, floor: 0 }).map((c) => c.id),
    ['t1', 't2', 't3', 'm1'], 'floor=0 ⇒ 老行为(按来源顺序截断)'
  )
  // 边界与坏输入
  assert.deepEqual(selectBySourceFloor([], { limit: 5, floor: 5 }), [])
  assert.deepEqual(selectBySourceFloor(null, {}), [])
  assert.deepEqual(selectBySourceFloor([{ type: 'x', items: null }], { limit: 5, floor: 2 }), [])
  assert.equal(selectBySourceFloor(sources, { limit: 100, floor: 5 }).length, 6, '池子就这么多 ⇒ 全收,不补空')
  assert.equal(selectBySourceFloor(sources, { limit: NaN, floor: -3 }).length > 0, true, '坏 limit/负 floor 回落且不崩')
})

test('collectCandidates:floor 真的进池(空 floor = 老行为;给 floor 则每个来源都有份)', () => {
  // 造一个"话题管够、日记只有一条"的真库(假 db 替身)
  const threads = Array.from({ length: 10 }, (_, i) => (
    { thread_id: i + 1, content: '悬置话题 ' + (i + 1), session_id: 's', last_mentioned_at: 0, created_at: NOW - 2 * DAY }
  ))
  const memories = Array.from({ length: 10 }, (_, i) => (
    { memory_id: i + 1, summary: '记忆 ' + (i + 1), emotion_score: 5, timestamp: NOW - HOUR }
  ))
  const db = fakeDb({
    threads,
    memories,
    diary: [{ date: '2026-09-30', content: '今天的日记', created_at: NOW - HOUR }]
  })
  const noFloor = collectCandidates({ db, now: NOW, limit: 4 })
  assert.equal(noFloor.some((c) => c.id.startsWith('diary:')), false, '不保底:日记还是进不去')
  const floored = collectCandidates({ db, now: NOW, limit: 4, floor: 1 })
  assert.ok(floored.some((c) => c.id === 'diary:2026-09-30'), '保底 1 ⇒ 日记进池')
  assert.equal(floored.length, 4, 'limit 仍是硬上限(保底不撑破池子)')
  // 记忆也吃窗口(2026-09-30 P2:以前只卡日记)
  const oldMem = fakeDb({
    memories: [{ memory_id: 99, summary: '很久以前的事', emotion_score: 9, timestamp: NOW - 30 * DAY }]
  })
  assert.deepEqual(collectCandidates({ db: oldMem, now: NOW, windowHours: 72 }), [], '出窗口的记忆不进池')
  assert.equal(collectCandidates({ db: oldMem, now: NOW, windowHours: 24 * 60 }).length, 1, '窗口放大 ⇒ 又进池')
})

// ---- ⑫ 时机闸也在本文件自证一次(表驱动细节在 timing-gate.test.js)----------

test('timingGate:夜闸与全过两条路(详细表在 timing-gate.test.js)', () => {
  const night = timingGate({ now: NOW, lastUserAt: NOW - 10 * HOUR, quotaLeft: 5, isNight: true })
  assert.equal(night.ok, false)
  assert.equal(night.reason, 'night-hold')
  const ok = timingGate({ now: NOW, lastUserAt: NOW - 10 * HOUR, lastTopicAt: NOW - 10 * HOUR, quotaLeft: 5, cooldownMin: 180, minIdleMin: 30, maxIdleMin: 720 })
  assert.equal(ok.ok, true)
  assert.equal(ok.reason, 'ok')
})

// ---- ⑬ 阈值**分类型**(方案 A,2026-09-30 用户拍板)---------------------------

/** 真配置形状:统一线 0.6 + 三条类型线。 */
const LINES = {
  threshold: 0.6,
  thresholdArtifact: 0.60,
  thresholdThread: 0.52,
  thresholdMemory: 0.55
}
/** 已打过分的候选(直接带 `score`,`pickTop` 就不重算 —— 表驱动比较干净)。 */
const scored = (type, score, i = 0) => ({ id: type + i, type, text: 'x', score })

test('thresholdFor:三类型各取自己的线(表驱动)', () => {
  assert.equal(TYPE_THRESHOLD_KEYS.artifact, 'thresholdArtifact')
  assert.equal(TYPE_THRESHOLD_KEYS.thread, 'thresholdThread')
  assert.equal(TYPE_THRESHOLD_KEYS.memory, 'thresholdMemory')
  assert.deepEqual({ ...DEFAULT_TYPE_THRESHOLDS }, { artifact: 0.60, thread: 0.52, memory: 0.55 })

  const table = [
    ['artifact', 0.60],
    ['thread', 0.52],
    ['memory', 0.55]
  ]
  for (const [type, line] of table) {
    assert.equal(thresholdFor(type, LINES), line, type + ' 该用自己的线')
    assert.equal(thresholdFor(type, { ...LINES, threshold: 0.9 }), line, '类型线优先于统一线')
  }
  // 没设类型线的类型(identity/agenda…)与认不出的类型 ⇒ 统一线
  for (const type of ['identity', 'agenda', '', 'THREAD', undefined, null]) {
    assert.equal(thresholdFor(type, LINES), 0.6, String(type) + ' 没有专属线 ⇒ 统一线')
  }
})

test('thresholdFor:类型键缺失 ⇒ 回退统一线(**删掉三个键就回到今天**,回滚路径)', () => {
  const onlyGlobal = { threshold: 0.6 }
  for (const type of ['artifact', 'thread', 'memory']) {
    assert.equal(thresholdFor(type, onlyGlobal), 0.6)
  }
  // 统一线也让出来 ⇒ 出厂 0.6
  assert.equal(thresholdFor('thread', {}), DEFAULT_THRESHOLD)
  assert.equal(thresholdFor('thread', null), DEFAULT_THRESHOLD)
})

test('thresholdFor:非法值(负数/NaN/Infinity/字符串/越界)⇒ 回退兜底且不崩', () => {
  const bad = [NaN, -0.1, 1.5, Infinity, -Infinity, '0.2', '', null, undefined, true, [], {}]
  for (const v of bad) {
    const scoring = { threshold: 0.6, thresholdThread: v }
    assert.equal(thresholdFor('thread', scoring), 0.6, '坏值 ' + String(v) + ' 必须回退统一线')
  }
  // 兜底自己也是坏的 ⇒ 出厂值(不许变成 0,那等于"永远开口")
  assert.equal(thresholdFor('thread', { threshold: NaN, thresholdThread: NaN }), DEFAULT_THRESHOLD)
  assert.equal(thresholdFor('thread', { threshold: 99 }), DEFAULT_THRESHOLD)
})

test('pickTop:逐条按自己类型的线判过/不过(表驱动;一条全局线做不到这件事)', () => {
  const floorOf = (item) => thresholdFor(item?.type, LINES)
  const cases = [
    // [类型, 分, 该不该过它自己的线]
    ['artifact', 0.61, true], ['artifact', 0.59, false],
    ['thread', 0.53, true], ['thread', 0.51, false],
    ['memory', 0.56, true], ['memory', 0.54, false]
  ]
  for (const [type, score, pass] of cases) {
    const top = pickTop([scored(type, score)], { minScoreOf: floorOf, minScore: 0.6 })
    assert.equal(top === null, !pass, type + ' @' + score + ' 该' + (pass ? '过' : '不过') + '线')
  }
  // 同一池子里的真实形状:日记 0.59(自己 0.60 ⇒ 不过)输给悬置话题 0.53(自己 0.52 ⇒ 过)
  const mixed = [scored('artifact', 0.59, 1), scored('thread', 0.53, 2), scored('memory', 0.54, 3)]
  assert.equal(pickTop(mixed, { minScoreOf: floorOf, minScore: 0.6 }).id, 'thread2')
  // 对照:没有逐条底线时,统一线 0.6 把**整池**判死(方案 A 修的就是这个)
  assert.equal(pickTop(mixed, { minScore: 0.6 }), null)
  // 两条底线都给时,逐条优先;逐条认不出 ⇒ 退回统一线
  assert.equal(pickTop([scored('thread', 0.55)], { minScore: 0.6, minScoreOf: floorOf }).id, 'thread0')
  assert.equal(pickTop([scored('thread', 0.55)], { minScore: 0.6, minScoreOf: () => null }), null)
  // 坏底线不许崩,也不许把分拉负
  assert.equal(pickTop([scored('thread', 0.55)], { minScoreOf: () => NaN, minScore: 0.6 }), null)
  assert.equal(pickTop([scored('thread', 0)], { minScoreOf: () => -5 }).id, 'thread0', '负底线按 0 算')
})
