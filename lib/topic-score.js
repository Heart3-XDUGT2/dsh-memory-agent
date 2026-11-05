/**
 * 主动性 v2 —— 话题打分器(P1:**纯新增,不接线**)
 * ============================================================
 * 出处:`docs/PLAN_PROACTIVE_TOPIC_SCORER_CODE.md` §2.1 / §3.5 / §4。
 * 原则:**念头不生成,只打分** —— 这里没有任何模型调用、没有第二个开口点;
 * 它只回答"这堆候选里哪条最值得开口",要不要真开口仍由 `heartbeat.js` 的
 * `deliver` 那**一次**调用说了算(P2 才接线)。
 *
 * 本文件只做三件事:
 *   ① `scoreTopic/pickTop` —— 六维加权打分(可解释:`why` 逐维 contrib 之和 == score);
 *   ② `timingGate/needsReview` —— 时机闸与"边缘区"折中判定(纯判断,表驱动可测);
 *   ③ `collectCandidates` —— **唯一摸库处**,且**只读**(SELECT,永不写)。
 *
 * 三条纪律(施工图 §2.1/§3.3 原话):
 *   · 纯函数零 IO、零模型、零时钟(`now` 一律从 `ctx` 传进来)、无随机 ——
 *     同输入必须同输出,否则单测钉不住;
 *   · "悬了多久"**必须用 `created_at`**(`updated_at` 会被引擎到点逻辑改写,
 *     见 `python/engine/threads.py:87` ⇒ 用错会把"到点重算"读成"她提过了");
 *   · 新鲜度维度**复用** `lib/thread-dedupe.js:87 topicRepeatPenalty` ——
 *     那个惩罚器写好至今未接线,这里是它的**第一次接线**,不是第二份实现。
 */
import {
  topicRepeatPenalty,
  TOPIC_REPEAT_PENALTY,
  TOPIC_REPEAT_SIMILARITY
} from './thread-dedupe.js'
// 2026-09-30 P4a:第四类候选来源 —— 她自由活动的产出(工作目录里的文件)。
// 只借它的**读口**(`listActivityNotes` 自带"读不到/目录不在 ⇒ 空数组,不抛"),
// 文件格式与清理规则都在那边一处写死,这里不拼文件名。
import { listActivityNotes } from './her-activity.js'

/** 出厂权重(`lib/toggle.js` 的 `proactiveScoring.w*` 默认值必须与这里同值)。 */
export const DEFAULT_WEIGHTS = Object.freeze({
  unstale: 0.25, gap: 0.15, concreteness: 0.20, recency: 0.15, freshness: 0.15, emotion: 0.10
})

/** 维度固定顺序 —— `score` 就按这个顺序累加,单测才能断言"逐维之和 == score"。 */
export const DIMENSIONS = Object.freeze(['unstale', 'gap', 'concreteness', 'recency', 'freshness', 'emotion'])

/** 各维封顶/中性值(`ctx.caps` 可逐项覆盖)。 */
export const DEFAULT_CAPS = Object.freeze({
  /** 悬置封顶:7 天以上满分(再悬也不会更"未结")。 */
  unstaleDays: 7,
  /** 时效窗口:超过 72 小时记 0 分(与 `windowHours` 默认同口径)。 */
  recencyHours: 72,
  /** `emotion_score` 的实测区间(INTEGER,实测 1~9)。 */
  emotionMin: 1,
  emotionMax: 9,
  /** 信息缺口:没字段可近似时的**中性值**(§3.3 的妥协,不许假装知道)。 */
  gapNeutral: 0.5,
  /** 信息缺口:这条已经**摆到他面前过**(`last_mentioned_at > 0`)⇒ 缺口缩小。 */
  gapMentioned: 0.25
})

/** `pickTop` 的出厂分数线(`proactiveScoring.threshold` 的默认值另在 toggle 里)。 */
export const DEFAULT_MIN_SCORE = 0
/** 复核折中方案的两条默认值(§3.5 决定①)。 */
export const DEFAULT_THRESHOLD = 0.6
export const DEFAULT_REVIEW_DELTA = 0.08

/**
 * 阈值**分类型**(2026-09-30,用户拍板"方案 A")。
 * ============================================================
 * 为什么不整体下调:实测真数据上**话题 ≈0.548 / 记忆 ≈0.563** 永远过不了那一条
 * 单一 0.6,只有日记(修后 ≈0.659)能过 —— 可把整条线拉低到 0.55 会让**日记也
 * 跟着变松**,那是另一回事。A 方案 = **每种类型一条线**,各按各的口径比:
 * 有真有产出(日记)的线保持高,靠"她记得 / 她惦记"的线放低,谁也不过谁的界。
 *
 * 三个键都是**扁平标量键**(`proactiveScoring.threshold*`,可在仪表盘设置),
 * 且 `threshold` 仍是**兜底**:专属键缺失/非法/该类型没设 ⇒ 回退 `threshold`
 * ⇒ **把这三个键删掉就回到今天的单一阈值**(用户点名的回滚路径)。
 */
export const TYPE_THRESHOLD_KEYS = Object.freeze({
  artifact: 'thresholdArtifact', // 日记 / 她的产出
  thread: 'thresholdThread',     // 悬置话题(她惦记着、还没结掉的)
  memory: 'thresholdMemory'      // 记忆(她记得的事)
})

/** 三个键的出厂值(`lib/toggle.js SETTINGS_DEFAULTS.proactiveScoring` 必须与它同值)。 */
export const DEFAULT_TYPE_THRESHOLDS = Object.freeze({
  artifact: 0.60, thread: 0.52, memory: 0.55
})

/** 合法线:有限数字且落在 [0,1];其余(负数/NaN/Infinity/字符串/越界)当"没设"。 */
function lineOrNull (v) {
  if (typeof v !== 'number') return null
  return Number.isFinite(v) && v >= 0 && v <= 1 ? v : null
}

/**
 * 取一条线(方案 A 的**唯一**入口 —— 判断过线与边缘区复核都必须走它,
 * 不许一处用类型线、另一处还用全局线)。
 *
 * 顺序:**该类型的专属键(合法才认)** → 兜底 `threshold`(合法才认)→ 出厂
 * `DEFAULT_THRESHOLD`。坏输入一律不崩、也不静默变成"永远沉默"(那正是 45 小时
 * 静默的同科):认不出就退回兜底,兜底也认不出才退回出厂值。
 *
 * @param {string} type 候选类型(`artifact` / `thread` / `memory`;别的类型没有专属线)
 * @param {{threshold?:number, thresholdArtifact?:number, thresholdThread?:number,
 *          thresholdMemory?:number}} [scoring] 打分器整组配置(扁平键)
 * @returns {number} 这条类型的过线分
 */
export function thresholdFor (type, scoring = {}) {
  const s = objOf(scoring)
  const key = TYPE_THRESHOLD_KEYS[String(type ?? '')]
  const own = key === undefined ? null : lineOrNull(s[key])
  if (own !== null) return own
  const base = lineOrNull(s.threshold)
  return base === null ? DEFAULT_THRESHOLD : base
}

/** 各候选类型的"具体性"底分 —— 有实物/进度才高分(§2.1 concreteness)。 */
export const TYPE_CONCRETENESS = Object.freeze({
  artifact: 1, // 日记这类**真有产出**的
  agenda: 0.5, // 关系账本(她惦记着要做的事)
  thread: 0.4, // 悬置话题(有内容、有到点,但还不是实物)
  memory: 0.2, // 纯记忆:是"她记得",不是"她做得出"
  identity: 0.1 // 核心记忆/画像:每轮都在心里,不靠主动开口
})

/**
 * 来源保底(2026-09-30,P2 用户新拍的决定④):**每个来源保底 N 条 + 余量按分数轮转**。
 *
 * 为什么要有:P1 暴露的真问题 —— 组卷是"话题 → 记忆 → 日记"顺序切的,
 * 日记这类**有实物的来源**永远排在最后,于是池子里只要话题/记忆够多,日记
 * 就**永远进不了池**(饥饿);而 `TYPE_CONCRETENESS.artifact = 1` 恰恰说
 * "有真有产出最该被看见"。保底先把每个来源的前 N 条无条件收进来,
 * 剩下的席位**按分数**从各来源的余量里轮转挑选 —— 于是"保底管公平、
 * 余量管择优",两边都不偏。
 *
 * 纯函数(可离线测):`sources` 是 `[{type, items}]`,`scored` 是已经算好
 * `score` 的候选表(按 `id` 对得上)。
 */
export function selectBySourceFloor (sources, { limit = 50, floor = 0, scored = null, scoreCtx = null } = {}) {
  const cap = clampLimit(limit, 50)
  const fl = Math.max(0, Math.round(num(floor, 0)))
  const list = (Array.isArray(sources) ? sources : [])
    .filter((s) => s !== null && typeof s === 'object' && Array.isArray(s.items))
  const scoreOf = (item) => {
    if (scored !== null && typeof scored.get === 'function') {
      const hit = scored.get(item?.id)
      if (hit !== undefined && Number.isFinite(Number(hit))) return Number(hit)
    }
    const done = scoreTopic(item, scoreCtx === null ? {} : scoreCtx)
    return Number.isFinite(Number(done?.score)) ? Number(done.score) : 0
  }

  const chosen = []
  const rest = [] // 每个来源没被保底收走的那部分(带着来源序号与原序号)
  list.forEach((src, si) => {
    let n = 0
    for (let i = 0; i < src.items.length; i++) {
      const item = src.items[i]
      if (n < fl) { chosen.push(item); n++ } else rest.push({ item, si, i })
    }
  })

  if (fl === 0) {
    // ★ **零保底 = P1 的老行为逐条相同**:按来源顺序切开(cap 个座位)——
    //   `rest` 本来就是这么攒的,直接截断即可。这条不许动:它是
    //   `tests/topic-score.test.js` 里 `collectCandidates` 那两条的钉子,
    //   也是"关掉保底就回到今天"的回滚路径。
    return rest.slice(0, cap).map((r) => r.item)
  }

  const left = cap - chosen.length
  if (left > 0 && rest.length > 0) {
    // 余量按分数降序轮转;同分时**先来的先上**(与 `pickTop` 同一条纪律:不靠
    // V8 的 sort 稳定性当契约,显式带序号兜底)。
    rest.sort((a, b) => (scoreOf(b.item) - scoreOf(a.item)) || (a.si - b.si) || (a.i - b.i))
    for (let k = 0; k < left && k < rest.length; k++) chosen.push(rest[k].item)
  }
  return chosen.slice(0, cap)
}

/** `timingGate` 的理由常量(与 `lib/heartbeat.js:673-703` 现用词**同名**,别造新词)。 */
export const TIMING_REASONS = Object.freeze({
  ok: 'ok',
  nightHold: 'night-hold', // 夜闸(引擎/心跳同款词)
  tooSoon: 'too-soon', // 离他上一句话太近 = 打断
  idleTooLong: 'idle-too-long', // 静默太久的**上界**(过了这个点就不补说了)
  dailyCap: 'daily-cap', // 当天额度用尽(心跳同款词)
  cooldown: 'cooldown' // 同一个话题刚提过,还在冷却
})

// ---- 小工具:坏输入一律不崩 --------------------------------------------------

function num (v, fallback = 0) {
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}

/** 认得出有限数字 → 数值;否则 null(用来区分"没这个字段"和"字段是 0")。 */
function numOrNull (v) {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/** 正数(封顶分母用;0/负数/NaN ⇒ 回落)。 */
function posit (v, fallback) {
  const n = num(v, fallback)
  return n > 0 ? n : fallback
}

function clamp01 (v) {
  const n = num(v, 0)
  return n <= 0 ? 0 : n >= 1 ? 1 : n
}

function objOf (v) {
  return v !== null && typeof v === 'object' ? v : {}
}

/** 权重表:逐维取 `ctx.weights` 的值,认不出/负数 ⇒ 回落出厂值(负数不许把分拉负)。 */
function weightOf (weights) {
  const w = objOf(weights)
  const out = {}
  for (const dim of DIMENSIONS) {
    const raw = numOrNull(w[dim])
    out[dim] = raw === null ? DEFAULT_WEIGHTS[dim] : Math.max(0, raw)
  }
  return out
}

// ---- ① 六维打分 --------------------------------------------------------------

/**
 * 给一条候选话题打六维分。
 *
 * @param {{id?:unknown, type?:string, text?:unknown, createdAt?:number, lastMentionedAt?:number,
 *          gap?:number, concreteness?:number, emotionScore?:number, hasArtifact?:boolean}} topic
 * @param {{now?:number, weights?:object, caps?:object, prevTopics?:unknown[],
 *          repeatPenalty?:number, repeatSimilarity?:number}} [ctx]
 *        `now` **必须由调用方给**(秒;纯函数不许自己看表)。`prevTopics` = 上一拍
 *        已经提过的话题(交给 `topicRepeatPenalty`,只有"刚刚"才算复读)。
 * @returns {{id:unknown, type:string, text:string, score:number,
 *            why:Object<string,{value:number, weight:number, contrib:number, note?:string}>}}
 */
export function scoreTopic (topic, ctx = {}) {
  const t = objOf(topic)
  const c = objOf(ctx)
  const now = num(c.now, 0)
  const caps = { ...DEFAULT_CAPS, ...objOf(c.caps) }
  const weights = weightOf(c.weights)

  const createdAt = num(t.createdAt ?? t.created_at, 0)
  const hasClock = createdAt > 0 && now > 0
  const ageSec = hasClock ? Math.max(0, now - createdAt) : 0
  const ageDays = ageSec / 86400
  const ageHours = ageSec / 3600

  // unstale(未结性):悬了多久 —— **只用 created_at**(§1.2 头号坑),带封顶。
  const unstale = hasClock ? clamp01(ageDays / posit(caps.unstaleDays, DEFAULT_CAPS.unstaleDays)) : 0

  // gap(信息缺口):他知不知道这件事的近似。
  // 现成字段里**没有**"他确认过没有"这一列(§3.3),所以只有两种近似:
  //   · 显式给 `topic.gap`(测试/后续来源可用);
  //   · `last_mentioned_at > 0` ⇒ 这条已经摆到他面前过 ⇒ 缺口缩小;
  //   · 都没有 ⇒ **退回中性 0.5**,并在 `why.gap.note` 里注明(不假装知道)。
  let gap = clamp01(caps.gapNeutral)
  let gapNote = 'no-field'
  const gapExplicit = numOrNull(t.gap)
  if (gapExplicit !== null) {
    gap = clamp01(gapExplicit)
    gapNote = 'explicit'
  } else if (num(t.lastMentionedAt ?? t.last_mentioned_at, 0) > 0) {
    gap = clamp01(caps.gapMentioned)
    gapNote = 'mentioned-before'
  }

  // concreteness(具体性):有实物/进度才高分。
  const concreteExplicit = numOrNull(t.concreteness)
  const concreteness = concreteExplicit !== null
    ? clamp01(concreteExplicit)
    : (t.hasArtifact === true ? 1 : clamp01(TYPE_CONCRETENESS[String(t.type ?? '')] ?? 0.3))

  // recency(时效):越近越高(`now - createdAt`)。
  const recency = hasClock
    ? clamp01(1 - ageHours / posit(caps.recencyHours, DEFAULT_CAPS.recencyHours))
    : 0

  // freshness(新鲜度,反向):**复用** thread-dedupe 的惩罚器 —— 刚说过的话题挨罚。
  const penaltyOpts = { prevTopics: Array.isArray(c.prevTopics) ? c.prevTopics : [], topic: String(t.text ?? '') }
  const pv = numOrNull(c.repeatPenalty)
  const sv = numOrNull(c.repeatSimilarity)
  if (pv !== null) penaltyOpts.penalty = pv
  if (sv !== null) penaltyOpts.similarity = sv
  const repeat = topicRepeatPenalty(penaltyOpts)
  const freshness = clamp01(num(repeat?.score, 1))

  // emotion(情绪权重):emotion_score 归一化(INTEGER,实测 1~9;0 = 没有读数)。
  const rawEmotion = num(t.emotionScore, 0)
  const lo = num(caps.emotionMin, DEFAULT_CAPS.emotionMin)
  const hi = posit(caps.emotionMax, DEFAULT_CAPS.emotionMax)
  const emotion = rawEmotion >= lo && hi > lo ? clamp01((rawEmotion - lo) / (hi - lo)) : 0

  const values = { unstale, gap, concreteness, recency, freshness, emotion }
  const why = {}
  let score = 0
  // 固定顺序累加 ⇒ `why` 逐维 contrib 之和与 `score` **逐位相同**(可解释性靠这条)。
  for (const dim of DIMENSIONS) {
    const value = clamp01(values[dim])
    const weight = weights[dim]
    const contrib = value * weight
    why[dim] = { value, weight, contrib }
    if (dim === 'gap') why[dim].note = gapNote
    score += contrib
  }

  const out = { id: t.id, type: String(t.type ?? ''), text: String(t.text ?? ''), score, why }
  // 2026-09-30 P4a:候选上的**来源标记**要跟着结果一起透出(她自由活动的产出带
  // `source:'self-activity'`)。为什么必须透:过了线的候选会一路走到台账
  // (`topicId`)与开口那一句,判到一半就查不出"这条到底是谁的产出"的话,
  // "防污染"就只剩一句口号。只透**调用方真给了**的字段 ⇒ 老候选形状逐字不变。
  if (t.source !== undefined) out.source = t.source
  return out
}

/**
 * 折中方案(§3.5 决定①)的"边缘区"判定:**只有**本地分贴着他拍板的 threshold
 * 两侧 `reviewDelta` 以内,才值得花那一次模型复核;其余(明显过/明显不过)直接定。
 *
 * @param {number} score 本地分
 * @param {{threshold?:number, reviewDelta?:number, reviewEnabled?:boolean, reviewBudgetLeft?:number}} [opts]
 * @returns {boolean}
 */
export function needsReview (score, opts = {}) {
  const o = objOf(opts)
  if (o.reviewEnabled !== true) return false
  const s = numOrNull(score)
  if (s === null) return false // NaN/坏输入:不许崩,也不许进复核
  const budget = numOrNull(o.reviewBudgetLeft)
  if (budget !== null && budget <= 0) return false // 日额度用完 ⇒ 沉默
  const thr = num(o.threshold, DEFAULT_THRESHOLD)
  const delta = numOrNull(o.reviewDelta)
  const d = Math.max(0, delta === null ? DEFAULT_REVIEW_DELTA : delta)
  return Math.abs(s - thr) <= d
}

/**
 * 挑一条:先按底线过滤,再按分数**稳定**降序(同分保留原顺序),取 top-1。
 *
 * 底线有两种给法(2026-09-30 方案 A 加的第二种):
 *   · `minScore` —— 一条**全局**线(老行为);
 *   · `minScoreOf(item)` —— **逐条**底线(按候选自己的类型取线)。给了它就以它为准,
 *     免得 0.52 那条悬置话题在粗筛那一步先被全局 0.6 挡掉 —— 那样"分类型"就白分了。
 *     它认不出某条时(`null`/`undefined`)退回 `minScore`。
 *
 * @param {Array<object>} cands 候选(`collectCandidates` 的产物,或已打过分带 `score` 的)
 * @param {{minScore?:number, minScoreOf?:(item:object)=>number, ctx?:object} & object} [opts]
 *        `opts.ctx` 是 `scoreTopic` 的上下文;不写就**把 opts 本身当 ctx**
 *        (于是 `{now, weights, prevTopics, minScore}` 一层传进去也合法)。
 * @returns {object|null} 打过分的那一条;空/全不过线 → `null`
 */
export function pickTop (cands, opts = {}) {
  const list = Array.isArray(cands) ? cands : []
  const o = objOf(opts)
  const floor = numOrNull(o.minScore)
  const floorOf = typeof o.minScoreOf === 'function' ? o.minScoreOf : null
  const ctxFor = objOf(o.ctx)
  const ctx = Object.keys(ctxFor).length > 0 ? ctxFor : o

  const scored = []
  for (let i = 0; i < list.length; i++) {
    const item = list[i]
    if (item === null || typeof item !== 'object') continue
    const done = Number.isFinite(Number(item.score)) ? item : scoreTopic(item, ctx)
    if (!Number.isFinite(Number(done?.score))) continue
    let line = floor === null ? DEFAULT_MIN_SCORE : floor
    if (floorOf !== null) {
      const own = numOrNull(floorOf(item))
      if (own !== null) line = Math.max(0, own)
    }
    if (Number(done.score) < line) continue
    scored.push({ done, i })
  }
  if (scored.length === 0) return null
  // 显式带序号兜底:同分时**先来的先上**(不靠 V8 的 sort 稳定性当契约)。
  scored.sort((a, b) => (Number(b.done.score) - Number(a.done.score)) || (a.i - b.i))
  return scored[0].done
}

// ---- ② 时机闸 ----------------------------------------------------------------

/**
 * 时机闸(纯判断)。判定顺序 = **夜闸 → 空闲下界/上界 → 额度 → 同题冷却**。
 * 一条常识:任何一闸的**参数没给**(0/undefined/null)就当这一闸**关着** ——
 * 宁可判 `ok`,也不许因为"配置缺一项"就把她永久憋住(那是 45 小时静默的同科)。
 *
 * @param {{now?:number, lastUserAt?:number, lastTopicAt?:number, quotaLeft?:number,
 *          cooldownMin?:number, isNight?:boolean, minIdleMin?:number, maxIdleMin?:number}} [inputs]
 *        `now`/`lastUserAt`/`lastTopicAt` = **秒**;`cooldownMin`/`minIdleMin`/`maxIdleMin` = **分钟**。
 *        `minIdleMin` = 离他上一句至少隔多久(太近 = 打断);
 *        `maxIdleMin` = 最多隔多久就不再补说(上界);两者为 0 即关闭该闸。
 *        `quotaLeft` 为 undefined 即"没有额度信息"(不判额度)。
 * @returns {{ok:boolean, reason:string, detail:object}}
 */
export function timingGate (inputs = {}) {
  const i = objOf(inputs)
  const now = num(i.now, 0)
  const lastUserAt = num(i.lastUserAt, 0)
  const lastTopicAt = num(i.lastTopicAt, 0)
  const quotaLeft = numOrNull(i.quotaLeft)
  const cooldownMin = num(i.cooldownMin, 0)
  const minIdleMin = num(i.minIdleMin, 0)
  const maxIdleMin = num(i.maxIdleMin, 0)
  const idleSec = now > 0 && lastUserAt > 0 ? Math.max(0, now - lastUserAt) : null

  const detail = {
    isNight: i.isNight === true,
    idleMin: idleSec === null ? null : idleSec / 60,
    quotaLeft,
    cooldownMin,
    minIdleMin,
    maxIdleMin
  }

  // ① 夜闸(23~8 点憋话:与心跳/引擎同款 reason)
  if (i.isNight === true) return { ok: false, reason: TIMING_REASONS.nightHold, detail: { ...detail, gate: 'night' } }
  // ② 空闲下界:太近 = 打断他
  if (idleSec !== null && minIdleMin > 0 && idleSec < minIdleMin * 60) {
    return { ok: false, reason: TIMING_REASONS.tooSoon, detail: { ...detail, gate: 'idle-min', needIdleMin: minIdleMin } }
  }
  // ③ 空闲上界:太久 = 那个时刻已经过去了,补说反而像复读
  if (idleSec !== null && maxIdleMin > 0 && idleSec > maxIdleMin * 60) {
    return { ok: false, reason: TIMING_REASONS.idleTooLong, detail: { ...detail, gate: 'idle-max', maxIdleMin } }
  }
  // ④ 额度:当天开口次数用尽(与心跳 `daily-cap` 同名)
  if (quotaLeft !== null && quotaLeft <= 0) {
    return { ok: false, reason: TIMING_REASONS.dailyCap, detail: { ...detail, gate: 'quota' } }
  }
  // ⑤ 同题冷却:这个话题刚提过,还没到能再提的时候
  if (cooldownMin > 0 && lastTopicAt > 0 && now > 0 && now - lastTopicAt < cooldownMin * 60) {
    const leftMin = (cooldownMin * 60 - (now - lastTopicAt)) / 60
    return { ok: false, reason: TIMING_REASONS.cooldown, detail: { ...detail, gate: 'cooldown', cooldownLeftMin: leftMin } }
  }
  return { ok: true, reason: TIMING_REASONS.ok, detail }
}

// ---- ③ 候选抽取(**唯一摸库处,只读**)----------------------------------------

/** `limit` 钳位(default 50,1~200)。 */
function clampLimit (v, fallback = 50) {
  const n = Math.round(num(v, fallback))
  if (!Number.isFinite(n) || n <= 0) return fallback
  return Math.max(1, Math.min(200, n))
}

/** 只读一次:`SELECT ... .all(params)`;表不在/列不在/返回 null ⇒ `[]`,**永不抛**。 */
function readAll (handle, sql, params = []) {
  try {
    if (handle === null || typeof handle.prepare !== 'function') return []
    const rows = handle.prepare(sql).all(...(Array.isArray(params) ? params : [params]))
    return Array.isArray(rows) ? rows : []
  } catch {
    // 容错就是纪律:缺表/缺列(老库还没迁移)不是"这一拍炸了",是"这一类来源今天没有"
    return []
  }
}

/** 读口(store 对象)优先:任何异常都退成 null,好让调用方走原始 SELECT。 */
function readVia (storeLike, method, args) {
  try {
    if (storeLike === null || typeof storeLike[method] !== 'function') return null
    return storeLike[method](...args)
  } catch { return null }
}

function pickHandle (db, store) {
  for (const cand of [db, store]) {
    if (cand === null || typeof cand !== 'object') continue
    if (typeof cand.prepare === 'function') return cand
    const inner = cand.db // store 对象:句柄挂在 `.db` 上(与 `store.js` 的返回形状一致)
    if (inner !== null && typeof inner === 'object' && typeof inner.prepare === 'function') return inner
  }
  return null
}

/** 认 store 读口:有 `listThreads`/`listMemories`/`latestDiaries` 之一就当 store(鸭子类型)。 */
function pickDoors (db, store) {
  for (const cand of [db, store]) {
    if (cand === null || typeof cand !== 'object') continue
    if (typeof cand.listMemories === 'function' || typeof cand.latestDiaries === 'function' || typeof cand.listThreads === 'function') return cand
  }
  return null
}

/**
 * 悬置话题:过滤 `status='open'` + 生命周期(**2026-10-06 D3:只认活跃档**)。
 *
 * 冷却/归档的行(`cooling_at>0` / `archived_at>0`)不进候选池 —— 它们是"她不再
 * 打算问的事",拿它们去喂主动性打分等于让旧事围着开口机会转(设计 §6.2)。
 * **`created_at` 是未结性的唯一合法来源**(§1.2)。
 */
function threadCandidates (handle, per, sessionId) {
  const rows = readAll(
    handle,
    'SELECT thread_id, content, session_id, last_mentioned_at, created_at FROM pending_threads' +
    " WHERE status = 'open' AND COALESCE(cooling_at, 0) = 0 AND COALESCE(archived_at, 0) = 0" +
    ' ORDER BY created_at DESC LIMIT ?',
    [per]
  )
  const out = []
  for (const r of rows) {
    const id = num(r?.thread_id, 0)
    const text = String(r?.content ?? '')
    if (id <= 0 || text === '') continue // 空壳行跳过(不是这一类来源的错)
    out.push({
      id: 'thread:' + id,
      type: 'thread',
      text,
      createdAt: num(r?.created_at, 0),
      lastMentionedAt: num(r?.last_mentioned_at, 0),
      sessionId: String(r?.session_id ?? ''),
      emotionScore: 0,
      hasArtifact: false
    })
  }
  return out
}

/** 记忆:过滤 `is_active=1 AND status='active' AND summary!=''`;读口优先 `listMemories`。
 *  `nowSec > 0` 时叠一道窗口闸(与日记同一口径)—— "很久以前记得的一件事"
 *  不该占今天主动开口的席位(P1 的 `windowHours` 只卡了日记)。 */
function memoryCandidates (handle, doors, per, nowSec = 0, windowHours = 72) {
  const out = []
  const windowSec = Math.max(0, num(windowHours, 72)) * 3600
  const inWindow = (createdAt) => !(nowSec > 0 && windowSec > 0 && createdAt > 0 && nowSec - createdAt > windowSec)
  const viaDoor = readVia(doors, 'listMemories', [{ state: 'active', limit: per }])
  if (viaDoor !== null && Array.isArray(viaDoor.rows)) {
    for (const r of viaDoor.rows) {
      const text = String(r?.summary ?? '')
      if (text === '') continue
      const createdAt = num(r?.timestamp, 0)
      if (!inWindow(createdAt)) continue
      out.push({
        id: 'mem:' + num(r?.memoryId, 0),
        type: 'memory',
        text,
        createdAt,
        emotionScore: num(r?.emotionScore, 0),
        hasArtifact: false
      })
    }
    return out
  }
  const rows = readAll(
    handle,
    'SELECT memory_id, summary, emotion_score, timestamp FROM episodic_memory' +
    " WHERE is_active = 1 AND status = 'active' AND summary != ''" +
    ' ORDER BY timestamp DESC LIMIT ?',
    [per]
  )
  for (const r of rows) {
    const text = String(r?.summary ?? '')
    if (text === '') continue
    const createdAt = num(r?.timestamp, 0)
    if (!inWindow(createdAt)) continue
    out.push({
      id: 'mem:' + num(r?.memory_id, 0),
      type: 'memory',
      text,
      createdAt,
      emotionScore: num(r?.emotion_score, 0),
      hasArtifact: false
    })
  }
  return out
}

/**
 * 日记:近 `windowHours` 天;读口优先 `latestDiaries`(`hasArtifact:true` = 真有产出)。
 *
 * 2026-09-30 P2:`emotionScore` 从 `mood` 换算(×2)。为什么必须给:P2 接线时
 * 实测出一个**会让整条链哑掉**的事实 —— 日记候选原来 emotionScore 恒 0,于是
 * 它的分数上限是 `0.075+0.2+0.15+0.15 = 0.575 < 0.6`(出厂线)⇒ **任何真实
 * 候选都过不了本地线**,她永远只有"沉默"和"边缘区复核"两条路。
 * `mood` 与 `emotion_score` 都是 1~10 的整数、都是"这件事有多重"的读数
 * (mood 是**她自己**那天的心情),这里当代理是有意选择,不是假装知道:
 * 乘 2 把它抬回 `emotion_score` 实测的 1~9 量级(缺省 mood=3 ⇒ 6)。
 */
function diaryCandidates (handle, doors, nowSec, windowHours, per) {
  const rows = []
  const viaDoor = readVia(doors, 'latestDiaries', [per])
  if (Array.isArray(viaDoor)) {
    for (const r of viaDoor) rows.push({ date: r?.date, content: r?.content, created_at: r?.createdAt, mood: r?.mood })
  } else {
    for (const r of readAll(handle, 'SELECT date, content, mood, created_at FROM diary ORDER BY date DESC LIMIT ?', [per])) {
      rows.push({ date: r?.date, content: r?.content, created_at: r?.created_at, mood: r?.mood })
    }
  }
  const windowSec = Math.max(0, num(windowHours, 72)) * 3600
  const out = []
  for (const r of rows) {
    const date = String(r?.date ?? '')
    const text = String(r?.content ?? '')
    const createdAt = num(r?.created_at, 0)
    if (date === '' || text === '') continue
    // `now` 没给 ⇒ **不判窗口**(宁可多收,也不许拿本机时钟当判据)
    if (nowSec > 0 && windowSec > 0 && createdAt > 0 && nowSec - createdAt > windowSec) continue
    out.push({
      id: 'diary:' + date,
      type: 'artifact',
      text,
      createdAt,
      // mood(1~10,缺省 3)× 2 ⇒ 1~10 的"这件事多重"读数(见本函数注释)
      emotionScore: Math.max(0, Math.min(10, Math.round(num(r?.mood, 3) * 2))),
      hasArtifact: true
    })
  }
  return out
}

/**
 * 她的自由活动产出(P4a,第四类来源):`~/.dsh/echo/workspace` 里那些
 * `日记-YYYY-MM-DD.md`。`hasArtifact:true`(具体性满分方向),id 前缀 `note:`、
 * `source:'self-activity'` —— 数据层面可识别,不许和主记忆混在一起。
 *
 * 三条"没有就没有":目录没给 / 目录不在 / 文件读不动 ⇒ **跳过该来源**(空数组),
 * 一律不抛。窗口口径与日记/记忆同一条(`windowHours`,0 = 不判窗口)。
 */
function activityCandidates (dir, per, nowSec, windowHours) {
  if (String(dir ?? '') === '') return [] // 调用方没给目录 ⇒ 这一类来源今天没有(零行为变化)
  try {
    return listActivityNotes(dir, { limit: per, nowMs: nowSec * 1000, windowHours })
  } catch {
    return []
  }
}

/**
 * 组卷:把三类候选(**P1 只做这三类**,图谱实测全是 concept ⇒ §1 表里已划掉)读出来。
 * 这是本模块**唯一**摸库的地方,而且**只读** —— 任何情况下不 INSERT/UPDATE/DELETE,
 * 不开 WAL 写;缺表/缺列/返回 null/假对象 ⇒ 退空数组或跳过该来源,**不抛**。
 *
 * 2026-09-30 P2:多了两个可选旋钮 ——
 *   · `floor`(`proactiveScoring.sourceFloor`):**每个来源保底 N 条**,
 *     余下的席位按分数轮转(修 P1 暴露的"日记进不了池"饥饿;见
 *     `selectBySourceFloor`)。`floor` 为 0 时行为与 P1 的"顺序切"**逐条相同**。
 *   · `windowHours` 现在也卡记忆(以前只卡日记,见 `memoryCandidates`)。
 *
 * @param {{db?:object, store?:object, now?:number, sessionId?:string, limit?:number,
 *          windowHours?:number, floor?:number, weights?:object, prevTopics?:unknown[],
 *          activityDir?:string}} [opts]
 *        `db` = sqlite 句柄(最小替身:带 `prepare().all()`)或 store 对象(鸭子类型);
 *        `store` = 可选,给了就读它的**现成读口**(`listMemories`/`latestDiaries`)——
 *        施工图 §2.1 的原话是"读口优先"。
 *        `now` = 秒(日记/记忆的窗口;不给就不判窗口)。`sessionId` 记进话题候选。
 *        `activityDir` = 她自由活动的工作目录(**第四类来源**,P4a);不给 ⇒ 这一类
 *        来源今天没有(与 P1/P2 的老行为逐条相同)。
 * @returns {Array<object>} 候选(**未打分**;交给 `pickTop` / `scoreTopic`)
 */
export function collectCandidates ({ db = null, store = null, now = 0, sessionId = '', limit = 50, windowHours = 72, floor = 0, weights = undefined, prevTopics = undefined, activityDir = '' } = {}) {
  const handle = pickHandle(db, store)
  const doors = pickDoors(db, store)
  const cap = clampLimit(limit, 50)
  const fl = Math.max(0, Math.min(cap, Math.round(num(floor, 0))))
  const nowSec = num(now, 0)
  const sid = String(sessionId ?? '')
  // 保底要成立,"每个来源最多读几条"就不能小于 floor —— 否则保底是空话
  const per = Math.max(cap, fl)

  const sources = [
    { type: 'thread', items: threadCandidates(handle, per, sid) },
    { type: 'memory', items: memoryCandidates(handle, doors, per, nowSec, windowHours) },
    { type: 'artifact', items: diaryCandidates(handle, doors, nowSec, windowHours, per) },
    // P4a:第四类来源排最后 —— 于是 `floor=0`(= P1 的"按来源顺序切")时
    // 前三类的行为**逐条不变**,这一类只在真有产出时自己占席位。
    { type: 'artifact', items: activityCandidates(activityDir, per, nowSec, windowHours) }
  ]
  return selectBySourceFloor(sources, {
    limit: cap,
    floor: fl,
    scoreCtx: { now: nowSec, weights, prevTopics }
  })
}
