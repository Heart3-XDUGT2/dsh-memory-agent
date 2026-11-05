import { captureAuditInput, makeAuditIO } from './audit-io.js'
/**
 * C1 情绪单轮闭环 —— 他这一句惹到她,就**这一轮**带情绪。
 *
 * 出处:pad-emotion `index.js:833-846`(异步 waterfall + `Promise.race`)。
 *
 * 今天的实况(这就是要修的东西):情绪向量是**轮末**由提取调用产出的
 * (`extract_prompt` → 模型 → `extract_commit` 里的 `emotion_score`),
 * 而这一轮的心情快照读的是 `store.getState()` = **上一轮结束时**写下的向量。
 * ⇒ 他这句话让她炸毛,她也要等到**下一轮**才带着那股劲儿 —— 同轮生效率按构造就是 ~0%。
 *
 * 本模块只做**一件事**:在他开口的那一刻并起一次**很小的**打分调用,跟组装赛跑;
 * 赢了就把这一轮的心情快照换成新读数,输了(超时)就用旧向量,**照常回复**。
 *
 * ⚠️ 三条自律(都是踩过坑才写的):
 *   ① **不写库**:打分结果只用于**这一轮的渲染**。写库那条路仍然归轮末反思
 *      (`lib/reflect.js` 的 `commitExtract`)—— 两个写者同时 apply 同一个 delta
 *      会互相覆盖,而且"这一轮该不该带情绪"根本不需要落库。**显示归显示,账归账。**
 *   ② **超时不是失败**:超时 ⇒ 用旧向量继续(他等回复,不等情绪打分),但**要记账**
 *      (超时率是这条通道的体检指标,见 `accept-emotion.mjs`)。
 *   ③ **解析不出来就不换**:宁可这轮延续旧情绪,也不许把半个读数(只有一维、
 *      或 NaN)当成"她的新情绪"塞进她脑子里。
 *   ④ **子代理会话不评分**(v0.41.0,事故修复):这条通道每跑一次就起一个
 *      子代理,而子代理会话的 claim 事件一样会打到这里 ⇒ **结构性递归**
 *      (打分 A 起 B,B 起 C……宿主卡死)。判据归 `lib/agent-scope.js`
 *      一处,`begin()` 自己守门 —— 「起子代理的地方不许从子代理里被调用」
 *      这条纪律写死在通道里,不靠每个调用方记性。
 */
import { applyEmotionVector, clampEmotionVector } from './emotion.js'
import { isSubagentSession } from './agent-scope.js'
// 空 query 的判据与 `query_expand` 共用**同一把尺子**（不各写一份，免得口径分家）。
// 无循环依赖：query-expand 只另引入纯观测辅助。
import { normalizeQueryKey } from './query-expand.js'

export const EMOTION_SCORE_DEFAULT_MS = 800
export const EMOTION_SCORE_MIN_MS = 100
export const EMOTION_SCORE_MAX_MS = 10_000
export const EMOTION_SCORE_MAX_REASON = 40
/**
 * 审计里存「模型原始返回」时的截断长度。
 *
 * 2026-10-10 为什么补这个:活库出现 `ms=2433, timedOut=false, ok=false`
 * —— 调用**跑完了**、但 `parseScore` 返回 null。而当时审计里只有
 * `ms/timedOut/ok/reason/error`,**看不到模型到底返回了什么**
 * ⇒ 这类"解析失败"永远无法从库里诊断(只能靠猜)。
 *
 * 600 的依据:一份**合规**返回约 170 字
 * (`{"global":{"fatigue":2,"valence":1,"arousal":3},"target_master":{"affection":8,…},"intensity":3,"reason":"…"}`),
 * 加上缩进/换行/多余空白与 40 字 reason 仍远在 600 内。
 * **宁可给宽** —— 截断到看不见 `global` / `target_master`,就等于没存。
 */
export const EMOTION_SCORE_RAW_MAX = 600

/**
 * 要模型填的东西 —— **绝对新状态**,不是增量(与 `applyEmotionVector` 的语义一致:
 * 给了向量就用它,不给就沿用旧的)。
 */
export const EMOTION_SCORE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['global', 'target_master', 'intensity'],
  properties: {
    global: {
      type: 'object',
      additionalProperties: false,
      required: ['fatigue', 'valence', 'arousal'],
      properties: {
        fatigue: { type: 'number' },
        valence: { type: 'number' },
        arousal: { type: 'number' }
      }
    },
    target_master: {
      type: 'object',
      additionalProperties: false,
      required: ['affection', 'playfulness', 'sadness', 'dependency'],
      properties: {
        affection: { type: 'number' },
        playfulness: { type: 'number' },
        sadness: { type: 'number' },
        dependency: { type: 'number' }
      }
    },
    intensity: { type: 'number' },
    reason: { type: 'string' }
  }
}

/** 提示词:短、直给、不叙事 —— 这是一次**读情绪**的调用,不是让她写小作文。 */
export function scorePrompt ({ alias = '用户', userText = '', prev = null } = {}) {
  const v = prev !== null && typeof prev === 'object' ? prev : {}
  const g = v.global || {}
  const m = v.target_master || {}
  const fmt = (x, d) => (typeof x === 'number' && Number.isFinite(x) ? String(Math.round(x * 10) / 10) : String(d))
  const lines = [
    '你只做一件事:读下面这句话之后,Echo 的情绪**变成什么样**。',
    '不要解释、不要安慰、不要写对话 —— 只给数字。',
    '',
    '【现在的情绪(零点)】',
    '- 疲惫 ' + fmt(g.fatigue, 2) + '/10 · 心情 ' + fmt(g.valence, 2) + ' · 唤醒度 ' + fmt(g.arousal, 3) + '/10',
    '- 对他的爱意 ' + fmt(m.affection, 5) + '/10 · 玩心 ' + fmt(m.playfulness, 4) + '/10'
      + ' · 委屈 ' + fmt(m.sadness, 0) + '/10 · 依赖 ' + fmt(m.dependency, 5) + '/10',
    '',
    '【他刚说的这句】',
    String(userText || '').slice(0, 500),
    '',
    '【怎么改】',
    '- 数字都是 0~10。**没被这句话碰到的那几维,原样返回,不要动。**',
    '- 小刺激就小动(±0.5 以内),被戳到才大动(±2 以上);心情可以变负(范围 -10~10)。',
    '  · 他夸你、逗你、主动靠近 ⇒ 爱意/玩心/心情升,委屈降;',
    '  · 他冷落你、凶你、很久不理 ⇒ 委屈升,爱意/依赖/心情降;',
    '  · 他在布置正事(让你干活、查东西)⇒ 唤醒度升一点,玩心别乱动。',
    '- intensity 是**整体情绪强度** 0~10(不是心情正负,是"有多在意/多激动")。',
    // ⚠️ 2026-10-17 两次校正的最终结论：
    //   第一版 `"他那句 XX"`（占位符）⇒ 被抄。
    //   第二版 `"他说今天开会到十点"`（真例子）+「不许照抄示例」⇒ **还是被抄**
    //     （活库 8 条里 4 条是它/它的变体：「他说了今天开会到十点」「他说了这句」）。
    //   ⇒ 结论：**给什么都可能被抄** —— 差别只是频率。
    //   所以这里改成 `〈…〉` 的**字段说明体裁**（不像现成答案），
    //   并且**真正的兜底挪到代码**（`sanitizeReason()` 黑名单）。
    '- reason 是**触发点**,不超过 ' + EMOTION_SCORE_MAX_REASON + ' 个字,写成"他说了什么事"这种事实,不要写心情形容词。',
    '  ★ **必须换成他这句话里真实发生的事**（下面 JSON 里 〈…〉 括起来的是格式说明，不是答案）。',
    '',
    // ★ 2026-10-17：这一行**必须有** —— 以前只有上面那句「只给数字」，
    //   云端大模型自己猜到了要输出 JSON，本地 3B 老实按字面写自然语言
    //   ⇒ `llm-channel` 的 JSON 阶梯解析失败 ⇒ `BAD_JSON` ⇒ `raw:null`
    //   ⇒ 同轮情绪永不落库（现场：3 条 same_turn_emotion 全 ok:false/raw:null）。
    //   写法照 `lib/query-expand.js` 那行现成的成功先例（它一直有这行，所以不犯这个病）。
    //   ⚠️ 键名/层级必须与 EMOTION_SCORE_SCHEMA 逐字对齐 —— 改了 schema 就要改这里。
    '只输出 JSON:{"global":{"fatigue":2,"valence":0,"arousal":3},'
      + '"target_master":{"affection":5,"playfulness":4,"sadness":0,"dependency":5},'
      // ★ 2026-10-17：`reason` 的样板从**一个真例子**改成**字段说明体裁**。
      //   上一版给的是 `"他说今天开会到十点"`（想让它照格式换成实际内容），
      //   但本地 3B **把整句当答案抄了回来** —— 活库 8 条里 4 条是它/它的变体
      //   （「他说了今天开会到十点」「他说了这句」）。
      //   ⇒ 改成 `〈…〉` 包起来的字段说明：既保住"这里要填一句话"的形状，
      //    又不像一个现成答案。
      //   ⚠️ 真正的兜底在 `sanitizeReason()`（黑名单）—— prompt 只是减少触发率。
      + '"intensity":3,"reason":"〈一句话说清触发点〉"}'
  ]
  return lines.join('\n').replace('Echo', String(alias || 'Echo'))
}

/** 超时旋钮规整:坏值回落默认(不许因为一个乱填的 0 把通道关死)。 */
export function clampScoreTimeoutMs (v) {
  const n = Number(v)
  if (!Number.isFinite(n) || n <= 0) return EMOTION_SCORE_DEFAULT_MS
  return Math.min(EMOTION_SCORE_MAX_MS, Math.max(EMOTION_SCORE_MIN_MS, Math.round(n)))
}

function clamp01to10 (v, dflt) {
  const n = Number(v)
  if (!Number.isFinite(n)) return dflt
  return Math.min(10, Math.max(0, n))
}

/**
 * 解析模型给的东西。**认不出来就回 null**(宁可这一轮延续旧情绪)。
 * 向量本体交给 `clampEmotionVector`(与引擎那条路同一个钳位器 —— 两个真相源
 * 最容易漂的地方,只留一个),我们只负责"够不够格换"。
 */
export function parseScore (structured) {
  if (structured === null || structured === undefined) return null
  let obj = structured
  if (typeof obj === 'string') {
    try { obj = JSON.parse(obj) } catch { return null }
  }
  if (typeof obj !== 'object' || Array.isArray(obj)) return null
  const g = obj.global
  const m = obj.target_master
  const hasGlobal = g !== null && typeof g === 'object' && ['fatigue', 'valence', 'arousal']
    .every((k) => Number.isFinite(Number(g[k])))
  if (!hasGlobal) return null // 三维缺一维 ⇒ 不换(半个读数不是读数)
  const vec = { global: { fatigue: Number(g.fatigue), valence: Number(g.valence), arousal: Number(g.arousal) } }
  const hasMaster = m !== null && typeof m === 'object' && ['affection', 'playfulness', 'sadness', 'dependency']
    .every((k) => Number.isFinite(Number(m[k])))
  if (hasMaster) {
    vec.target_master = {
      affection: Number(m.affection),
      playfulness: Number(m.playfulness),
      sadness: Number(m.sadness),
      dependency: Number(m.dependency)
    }
  }
  const intensity = clamp01to10(obj.intensity, 5)
  const reason = sanitizeReason(obj.reason)
  return { vector: clampEmotionVector(vec), intensity, reason }
}

/**
 * ★ 2026-10-17：样板值黑名单（`reason` 的）。
 *
 * 现场：本地 3B **把 `scorePrompt` 里样板 JSON 的 `reason` 字面值抄了回来**。
 * 活库最近 8 条里有 4 条是它（含各种变体）：
 *
 *   「他说今天开会到十点」    4 次   ← 样板原文
 *   「他说了今天开会到十点」  1 次   ← 多了个「了」
 *   「他说了这句」          1 次   ← 更含糊的变体
 *   「他那句 XX」           1 次   ← 上一代样板的残留
 *   真正抄对了的只有 1 条（「他面试通过了」）。
 *
 * 为什么在代码里挡而不是只改 prompt：prompt 写「不许照抄示例」模型未必听 ——
 * 这与 `is_self_referential`、`PENDING_CONTENT_PLACEHOLDERS` 是同一套设计：
 * **prompt 劝，代码是墙**。
 *
 * ⚠️ 判据是"**整条像样板**"，不是"包含样板词" —— 否则
 * 「他说今天开会到十点，累坏了」这种**真的写了事**的会被误伤。
 * 清空而不是替换成随便一句话：`reason` 只用于面板/审计的可读性，
 * **空串是诚实的**（"这轮没说清触发点"），瞎填才是骗人。
 */
const REASON_PLACEHOLDERS = [
  /^他说?了?(?:今天)?开会[到至]\s*十\s*点[。.!！]?$/,   // 样板原文及其变体
  /^他说?了?这句[。.!！]?$/,                            // 极含糊
  /^他那句\s*X{1,3}\s*[。.!！]?$/i,                     // 上一代样板「他那句 XX」
  /^示例[。.!！]?$/,                                    // 裸的「示例」
  /^<\s*(?:这里|此处)[^>]*>$/                           // 「<这里写触发点>」这类
]

/** 把 `reason` 规整成可落库的字符串；命中样板就清空。 */
export function sanitizeReason (value) {
  const s = String(value ?? '').trim().slice(0, EMOTION_SCORE_MAX_REASON)
  if (s === '') return ''
  return REASON_PLACEHOLDERS.some((re) => re.test(s)) ? '' : s
}

/**
 * 把这一轮的读数拼成"她此刻的状态"那份 state 的替身(只给渲染用,不落库)。
 * `prevIntensity` 取**上一轮**的值 ⇒ `describeMood` 会自然写出"上一轮 X,这一句之后 Y"。
 */
export function sameTurnState (state, score) {
  if (state === null || typeof state !== 'object') return state
  if (score === null || typeof score !== 'object') return state
  const out = { ...state }
  if (score.vector !== undefined) out.emotionVector = score.vector
  out.prevMoodIntensity = state.moodIntensity ?? null
  if (Number.isFinite(Number(score.intensity))) out.moodIntensity = Number(score.intensity)
  if (typeof score.reason === 'string' && score.reason !== '') out.moodReason = score.reason
  return out
}

/**
 * 打分器的门面(壳持有它;纯逻辑在下面,可离线测)。
 *
 * `run(prompt, schema)` = 一次结构化调用(壳传 `runStructured` 那条)。
 * `begin(sid, …)` 在他开口那一刻起跑,`take(sid)` 在组装注入时取结果(取走即清)。
 */
export function createSameTurnScorer ({ run = null, getTimeoutMs = null, logger = null, now = () => Date.now() } = {}) {
  const pending = new Map()
  const stats = { started: 0, applied: 0, timedOut: 0, failed: 0, skippedNoRun: 0, skippedSubagent: 0, emptyQuery: 0, lastMs: 0, lastReason: '' }
  const warn = (msg) => { try { log0(logger, msg) } catch { /* 日志失败不影响 */ } }

  function begin (sid, { userText = '', prevVector = null, parent = null, onSettle = null } = {}) {
    const key = String(sid || '')
    if (key === '') return false
    let auditInput
    try { auditInput = captureAuditInput({ text: userText, modelText: String(userText || '').slice(0, 500), previousVector: prevVector }) } catch { auditInput = null }
    const observeSkip = reason => { try { if (typeof onSettle === 'function') onSettle({ ok: false, timedOut: false, ms: 0, raw: null, reason, io: makeAuditIO('same_turn_emotion', auditInput, { status: reason }, { score: null, raw: null }) }) } catch { } }
    // ★ 2026-10-17：空 query 不白跑。
    //   `query_expand` 早就有这条闸（`normalizeQueryKey(text) === ''` ⇒ 早退），
    //   而**这里没有** ⇒ 拿到空 `userText` 照样拼出一份 prompt、**白烧一次 LLM 调用**。
    //   同一个 `turnSnapshot.queryOf(sid)` 同时喂这两条路，所以两边会**同时**拿到空串；
    //   以前的现象就是"情绪打分跑了、查询扩展没跑"——看起来像矛盾，其实是判空策略不同。
    //   ⚠️ 判空用与 `query_expand` **同一把尺子**（`normalizeQueryKey`），两边口径不许分家。
    //   ⚠️ 但**不静默早退**：记 `emptyQuery`，否则状态面上又会是「跑了但没数」的老病。
    if (normalizeQueryKey(userText) === '') {
      stats.emptyQuery += 1
      observeSkip('empty_query')
      return false
    }
    // v0.41.0 结构性闸(事故修复):子代理/辅助会话的 claim 也会走到这里,
    // 而这一次打分会**再起一个子代理** —— 于是打分 A 起 B、B 起 C……无限递归。
    // 判据在 lib/agent-scope.js(认不出来当顶层,所以不会误伤他的正常会话)。
    if (isSubagentSession(parent)) { stats.skippedSubagent += 1; observeSkip('subagent_scope'); return false }
    if (typeof run !== 'function') { stats.skippedNoRun += 1; observeSkip('no_run'); return false }
    const timeoutMs = typeof getTimeoutMs === 'function' ? clampScoreTimeoutMs(getTimeoutMs()) : EMOTION_SCORE_DEFAULT_MS
    stats.started += 1
    const startedAt = now()
    const promise = scoreOnce({ run, userText, prevVector, timeoutMs, parent, now })
      .then((r) => {
        stats.lastMs = Math.max(0, now() - startedAt)
        if (r.ok) { stats.applied += 1; stats.lastReason = r.score.reason || '' } else if (r.timedOut) stats.timedOut += 1
        else stats.failed += 1
        // 期 0 并发观测:settle 时回调(可选;模块本身仍然不碰 store、不 await)
        // 2026-10-10:`raw` 一并带出去 —— 审计要靠它诊断"跑完了但解析失败"。
        try { if (typeof onSettle === 'function') onSettle({ ok: r.ok === true, timedOut: r.timedOut === true, ms: Math.max(0, now() - startedAt), raw: r.raw ?? null, io: makeAuditIO('same_turn_emotion', auditInput, { status: r.timedOut ? 'timeout' : r.ok ? 'success' : typeof r.raw === 'string' && r.raw.startsWith('抛出:') ? 'failed' : 'invalid', timeoutMs }, { score: r.score, raw: r.raw ?? null }) }) } catch { }
        return r
      })
      .catch((err) => {
        stats.failed += 1
        warn('情绪同轮打分失败(照常回复): ' + String(err?.message ?? err))
        const em = String(err?.message ?? err).slice(0, 120)
        try { if (typeof onSettle === 'function') onSettle({ ok: false, timedOut: false, ms: Math.max(0, now() - startedAt), error: em, raw: '抛出:' + em, io: makeAuditIO('same_turn_emotion', auditInput, { status: 'failed', timeoutMs }, { score: null, raw: '抛出:' + em }) }) } catch { }
        return { ok: false, timedOut: false, ms: 0, score: null, raw: '抛出:' + em }
      })
    pending.set(key, promise)
    return true
  }

  /** 取这一轮的读数(**取走即清**:一次组装只用一次,不给下一步复用陈旧读数)。 */
  async function take (sid) {
    const key = String(sid || '')
    const p = pending.get(key)
    if (p === undefined) return null
    pending.delete(key)
    try {
      const r = await p
      if (r === null || r.ok !== true || r.score === null) return null
      return { score: r.score, timedOut: r.timedOut === true, ms: r.ms }
    } catch { return null }
  }

  function drop (sid) { pending.delete(String(sid || '')) }

  return { begin, take, drop, stats: () => ({ ...stats, at: now() }) }
}

function log0 (logger, msg) {
  if (logger !== null && logger !== undefined && typeof logger.warn === 'function') logger.warn('echo: ' + msg)
}

/**
 * 把模型原始返回压成**一条可入库的短串**(2026-10-10,为审计补的)。
 *
 * `run` 的契约(`llmChannel.runStructured`):给了 schema 时返回**已解析的对象**,
 * 一切失败(超时/终局块/空产出/JSON 不合规)一律返回 **`null`**。
 * ⇒ 这里三种形状都要能存:`null` 说明"根本没拿到";对象/数组 JSON 化;字符串原样。
 * 存不下就截断 —— 但按 `EMOTION_SCORE_RAW_MAX` 的依据,合规返回截不到。
 */
export function rawForAudit (out) {
  if (out === null || out === undefined) return null
  let s
  if (typeof out === 'string') s = out
  else { try { s = JSON.stringify(out) } catch { return '[不可序列化]' } }
  if (typeof s !== 'string') return null
  s = s.trim()
  if (s === '') return null
  return s.length > EMOTION_SCORE_RAW_MAX ? s.slice(0, EMOTION_SCORE_RAW_MAX) : s
}

/**
 * 一次打分 = **赛跑**(纯逻辑,`run` 由调用方注入 ⇒ 离线可测)。
 * 赢了 `{ok:true, score}`;超时 `{ok:false, timedOut:true}`(**不是失败**:用旧向量照常回复);
 * 解析不出来 `{ok:false, timedOut:false}`。
 *
 * ⚠️ 2026-10-10:返回值多带一个 `raw`(模型原始返回的短串)。**只给审计用**,
 * 不参与任何判定 —— 为什么需要见 `EMOTION_SCORE_RAW_MAX` 的注释。
 */
export async function scoreOnce ({ run, userText = '', prevVector = null, timeoutMs = EMOTION_SCORE_DEFAULT_MS, parent = null, now = () => Date.now() } = {}) {
  if (typeof run !== 'function') return { ok: false, timedOut: false, ms: 0, score: null, raw: null }
  const t0 = now()
  const ms = (r) => ({ ...r, ms: Math.max(0, now() - t0) })
  let timer = null
  try {
    const raced = await Promise.race([
      Promise.resolve()
        .then(() => run(scorePrompt({ userText, prev: prevVector }), EMOTION_SCORE_SCHEMA, parent))
        .then((out) => ({ kind: 'done', out })),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve({ kind: 'timeout' }), timeoutMs)
        try { if (typeof timer?.unref === 'function') timer.unref() } catch { /* 浏览器/测试替身没有 unref */ }
      })
    ])
    // 超时:racd.out 永远不存在 ⇒ raw 恒 null(不是"没读到",是"根本没到")
    if (raced.kind === 'timeout') return ms({ ok: false, timedOut: true, score: null, raw: null })
    const raw = rawForAudit(raced.out)
    const score = parseScore(raced.out)
    if (score === null) return ms({ ok: false, timedOut: false, score: null, raw })
    return ms({ ok: true, timedOut: false, score, raw })
  } catch (err) {
    return ms({ ok: false, timedOut: false, score: null, raw: '抛出:' + String(err?.message ?? err).slice(0, 120) })
  } finally {
    if (timer !== null) { try { clearTimeout(timer) } catch { /* 清不掉也无害 */ } }
  }
}
