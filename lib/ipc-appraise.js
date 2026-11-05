/**
 * 用户侧坐标(`ipc_dyad`)—— 轮末异步打分编排 + **两把尺子对账**(拍板 ①,2026-10-06)。
 *
 * 设计全文见桌面的 `情绪面板缺口补齐设计-2026-10-06.md` §1。三条纪律原样搬过来:
 *
 *   1. **双轨**:他的点走 `lib/ipc-core/appraise.js` 的 `other`(LLM 直判);她的点
 *      **仍走映射**(`lib/emotion-ipc-bridge.js`:`affection→c`、`dependency→(1−a)`),
 *      **不动联合空间、不动门禁、不动标定**。
 *   2. **同一次调用出双方**:`self` 与 `other` 出自同一份 prompt、同一个模型 ⇒ 那一半
 *      天然同源;剩下的差异用**残差 `ipc_err`** 显式记账 —— 只记账、**绝不回写**任何坐标
 *      (与 `lib/space-bridge.js` 的"误差只记账"同一条纪律;门禁函数直接复用它的
 *      `gateOf`/`GATE_BANDS`,不另起一套阈值)。
 *   3. **零 DDL**:结果塞进已有的 `emotion_vector` JSON 列(新键 `ipc_dyad`),
 *      `agent_state` 是 JS/PY 共有表,一期不加列、不加表。
 *
 * 另外三条属于本层的:
 *   · **不进 prompt**(拍板 ⑥):这里只产数据,注入侧一个字都不读它;
 *   · **失败必须留痕**(拍板③ + P3-A 教训):跳过 / 超时 / 解析失败 / 门槛不足
 *     **一律写审计**,由调用方带上来的 `audit()` 落库 —— 不许静默返回 null;
 *   · **不许抛**:这个模块跑在轮末异步链上,任何异常都不能影响回复。
 *
 * ⚠️ 一期**没有**做设计 §1.7 的"判他只看他的行"(证据分离):那是给
 * `buildAppraisalUserContent` 追加约束文本,属于**改提示词**(拍板 ④ 说不改)。
 * 本期落地的是同一节里的另外两条:上一轮锚定(`previousLabels`)+ `gain` 门槛。
 */

import { gateOf, GATE_BANDS, directionOf } from './space-bridge.js'
import { echoToIpc } from './emotion-ipc-bridge.js'

/** `emotion_vector` 里存双方坐标的那个键(零 DDL 的落点)。 */
export const IPC_DYAD_KEY = 'ipc_dyad'

/** 来源标记:审计/面板要能分辨"这份坐标是谁算的"。 */
export const DYAD_SRC = 'appraise@ipc-core'

/** 节流与门槛默认值(面板可改;键在 `lib/settings-fields.js` 的 IPC 组)。 */
export const DEFAULT_IPC_APPRAISE = Object.freeze({
  enabled: true, // 总闸
  everyTurns: 3, // 至少隔几轮才判一次
  minMinutes: 10, // 至少隔几分钟才判一次(两条都满足才跑)
  gainMin: 0.35, // 可信度下限:低于它不落库(只写审计)
  transcriptTurns: 5, // 喂给打分器的最近几轮
  maxChars: 1000, // 转写预算(上游 `renderTranscript` 的默认值)
  perMessageChars: 200
})

const clampNum = (v, lo, hi, dv) => {
  const n = Number(v)
  if (!Number.isFinite(n)) return dv
  return Math.min(hi, Math.max(lo, n))
}
const clamp01 = (v) => clampNum(v, 0, 1, 0)
const numOr = (v, fb = null) => {
  if (v === null || v === undefined || v === '') return fb
  const n = Number(v)
  return Number.isFinite(n) ? n : fb
}
const round3 = (x) => Math.round(x * 1000) / 1000
const pt = (p) => (p && typeof p === 'object' && numOr(p.a) !== null && numOr(p.c) !== null
  ? { a: round3(clamp01(p.a)), c: round3(clamp01(p.c)) }
  : null)

/** 面板乱填也不能让这一层炸。 */
export function resolveIpcAppraise (input = {}) {
  const raw = (input && typeof input === 'object') ? input : {}
  const d = DEFAULT_IPC_APPRAISE
  return {
    enabled: raw.ipcAppraiseEnabled !== false,
    everyTurns: Math.round(clampNum(raw.ipcAppraiseEveryTurns, 1, 100, d.everyTurns)),
    minMinutes: clampNum(raw.ipcAppraiseMinMinutes, 0, 1440, d.minMinutes),
    gainMin: clampNum(raw.ipcAppraiseGainMin, 0, 1, d.gainMin),
    transcriptTurns: Math.round(clampNum(raw.ipcAppraiseTurns, 1, 20, d.transcriptTurns)),
    maxChars: d.maxChars,
    perMessageChars: d.perMessageChars
  }
}

/**
 * "映射出来的她" —— 现网真源的那一套(`emotion-ipc-bridge` D2/E1)。
 * **只读**:不改向量、不写库;缺维按中性处理并在 `missing` 里记账。
 */
export function mappedSelf (vector) {
  try {
    const out = echoToIpc(vector && typeof vector === 'object' ? vector : {})
    return { point: pt(out.point) ?? { a: 0.5, c: 0.5 }, missing: Array.isArray(out.missing) ? out.missing : [], note: out.note }
  } catch {
    return { point: { a: 0.5, c: 0.5 }, missing: [], note: 'echoToIpc 失败,按中性处理' }
  }
}

/**
 * 两把尺子的残差:同一次 appraise 的 `self`(LLM 直判) 与 `mapped`(向量映射)。
 *
 * **只记账**:返回的数和 `gate` 都只往审计/面板走 —— 绝不去修正任何一个坐标,
 * 也不进 `space-bridge` 的 `s` 或它的门禁(那是联合空间自己的残差)。
 * 分带用 `space-bridge` 的 `gateOf`(同一套阈值,同一个函数)。
 */
export function residualOf ({ appraised, mapped } = {}) {
  const s = pt(appraised)
  const m = pt(mapped)
  if (s === null || m === null) {
    return { ok: false, a: null, c: null, maxAbs: null, gate: 'unknown', note: '两侧读数不齐,残差算不了' }
  }
  const da = round3(s.a - m.a)
  const dc = round3(s.c - m.c)
  const maxAbs = Math.max(Math.abs(da), Math.abs(dc))
  return {
    ok: true,
    a: da,
    c: dc,
    maxAbs: round3(maxAbs),
    gate: gateOf(maxAbs),
    note: '[推断] 两把尺子(LLM 直判 vs 向量映射)的差,只记账、不回写'
  }
}

/**
 * 可信度 `gain`:上游的 `confidence`(自报把握)× 解析完整度。
 * 解析不完整(`complete === false`,说明至少一侧是靠词表兜底出来的)⇒ 打对折。
 */
export function gainOf (appraisal) {
  const conf = numOr(appraisal && appraisal.confidence, 0.6)
  const complete = appraisal && appraisal.complete === true
  return round3(clamp01(conf * (complete ? 1 : 0.5)))
}

/**
 * 拼一份要落库的 dyad 快照(纯函数,不改入参)。
 * `gate !== 'green'` 时上层按门禁决定画不画(见 `applyGate`);这里只如实存。
 */
export function buildDyad ({ appraisal, mapped, gain, at, src = DYAD_SRC, dynamics = null, gainMin = DEFAULT_IPC_APPRAISE.gainMin } = {}) {
  const self = pt(appraisal && appraisal.self)
  const other = pt(appraisal && appraisal.other)
  const residual = residualOf({ appraised: self, mapped })
  const g = round3(clamp01(gain))
  return {
    self, // 同一次调用里"她"的位置(仅用于对账,不取代映射值)
    other, // ★用户侧坐标
    mapped: mapped ?? null, // 映射出来的她(现网真源,原样留证据)
    gain: g,
    lowConfidence: g < clampNum(gainMin, 0, 1, DEFAULT_IPC_APPRAISE.gainMin),
    labels: {
      self: (appraisal && appraisal.labels && appraisal.labels.self) ?? null,
      other: (appraisal && appraisal.labels && appraisal.labels.other) ?? null
    },
    reason: (appraisal && appraisal.reason) ?? null,
    scale: (appraisal && appraisal.scale) ?? null,
    residual,
    gate: residual.gate,
    dynamics: dynamics === null ? null : {
      reactivity: numOr(dynamics.reactivity, null),
      maxStepPerTurn: numOr(dynamics.maxStepPerTurn, null),
      escalated: dynamics.escalated === true,
      // 结算后的落点(与 `other` 同一个值,但这里留**证据**:面板/审计要能看出
      // "这个点不是模型的原始读数,是过了一步惯性")+ 这一步的位移。
      // ⚠️ 位移可以是**负的**,所以它走 `numOr` 而不是 `pt`(后者会钳到 [0,1])。
      latent: dynamics.latent ? { self: pt(dynamics.latent.self), other: pt(dynamics.latent.other) } : null,
      delta: (dynamics.delta && typeof dynamics.delta === 'object')
        ? {
            self: { a: numOr(dynamics.delta.self && dynamics.delta.self.a, null), c: numOr(dynamics.delta.self && dynamics.delta.self.c, null) },
            other: { a: numOr(dynamics.delta.other && dynamics.delta.other.a, null), c: numOr(dynamics.delta.other && dynamics.delta.other.c, null) }
          }
        : null
    },
    src,
    at: numOr(at, Date.now())
  }
}

/**
 * 门禁的**只读**落地:哪些能上屏。红档 ⇒ 两个点都不画(`other: null`,
 * 面板照旧画灰环占位),与 `docs/EMOTION_SPACE.md` 的"缺维不写"同一条纪律。
 */
export function applyGate (dyad) {
  if (dyad === null || typeof dyad !== 'object') {
    return { draw: false, other: null, gate: 'unknown', note: '这轮没有判定' }
  }
  const gate = dyad.gate ?? 'unknown'
  if (gate === 'red') {
    return { draw: false, other: null, gate, note: '两侧判断系统性分歧(红档):本版不画数、不给点' }
  }
  if (gate === 'unknown') {
    return { draw: false, other: null, gate, note: '残差算不出(缺一侧读数):不给点' }
  }
  const other = pt(dyad.other)
  if (other === null || dyad.lowConfidence === true) {
    return { draw: false, other: null, gate, note: '可信度不足(或他没被打出坐标):不给点' }
  }
  return { draw: true, other, gate, note: null }
}

/** 把 dyad 写进向量 JSON(**零 DDL**;纯函数:返回新对象,不改入参)。 */
export function mergeDyad (vector, dyad) {
  const base = (vector && typeof vector === 'object' && !Array.isArray(vector)) ? vector : {}
  return { ...base, [IPC_DYAD_KEY]: dyad }
}

/** 从向量里读回 dyad(读不到 ⇒ `null`;脏数据一律当没有)。 */
export function readDyad (vector) {
  if (vector === null || typeof vector !== 'object') return null
  const d = vector[IPC_DYAD_KEY]
  return (d && typeof d === 'object' && !Array.isArray(d)) ? d : null
}

/**
 * 轮末异步打分器(有状态:节流计数 + 状态面)。
 *
 * @param {object} deps
 * @param {object} deps.adapter `lib/ipc-adapter.js` 的实例(**唯一入口**,本模块不 import ipc-core)
 * @param {(args:object)=>Promise<object|null>} deps.callStructured 现有 LLM 直调通道(`reflectTransport().transport.structured`)
 * @param {object} deps.store 库(只用 `getState()` / `saveEmotionVector()`)
 * @param {(fields:object)=>void} deps.audit 审计落库(失败留痕;**不许静默**)
 * @param {(msg:string)=>void} [deps.log]
 * @param {()=>object} [deps.getSettings]
 * @param {(sessionId:string, limit:number)=>Array<{user:string,assistant:string}>} [deps.recentTurns]
 * @param {()=>string} [deps.getPersonaAnchor] 开局判断用的人格正文
 * @param {()=>({userName:string,agentName:string})} [deps.getNames]
 * @param {()=>number} [deps.now]
 */
export function createIpcAppraiser ({
  adapter, callStructured, store, audit, log = null, getSettings = () => ({}),
  recentTurns = null, getPersonaAnchor = null, getNames = null, now = () => Date.now()
} = {}) {
  const stats = {
    turns: 0, runs: 0, ok: 0, skipped: 0, failed: 0, lowGain: 0,
    lastAt: 0, lastTurnRun: null, lastGate: null, lastErr: null, lastReason: null, lastNote: ''
  }
  const note = (msg) => {
    stats.lastNote = String(msg)
    try { if (typeof log === 'function') log(String(msg)) } catch { /* fail-soft */ }
  }
  /** 失败留痕:审计 + 状态面(设计 §5 风险 3:「静默失败」是本案最贵的失败)。 */
  const record = (fields, sessionId) => {
    stats.lastReason = fields && fields.reason ? String(fields.reason) : null
    try {
      if (typeof audit === 'function') {
        audit({
          sessionId: sessionId || undefined,
          userInput: '(人际打分·' + String((fields && fields.kind) || '未判定') + ')',
          llmReply: String((fields && fields.reason) || '') + (fields && fields.gate ? ' gate=' + fields.gate : ''),
          toolCall: 'ipc-appraise'
        })
      }
    } catch { /* 审计失败不绊打分 */ }
  }
  const settings = () => { try { return resolveIpcAppraise(getSettings() || {}) } catch { return resolveIpcAppraise({}) } }

  /** 该不该跑这一轮(节流两道闸:轮数 + 时间)。**只读判断**,不产生副作用。 */
  function shouldRun (at = now()) {
    const p = settings()
    if (!p.enabled) return { ok: false, reason: '总闸关闭(ipcAppraiseEnabled=false)' }
    if (adapter === null || typeof adapter.relationshipSync !== 'function' || adapter.available() !== true) {
      return { ok: false, reason: 'ipc-core 副本不可用(关系代数缺席)' }
    }
    if (typeof stats.lastTurnRun === 'number' && Number.isFinite(stats.lastTurnRun)) {
      const turnsSince = stats.turns - stats.lastTurnRun
      if (turnsSince < p.everyTurns) return { ok: false, reason: '节流:还差 ' + String(p.everyTurns - turnsSince) + ' 轮' }
    }
    const sinceMs = at - stats.lastAt
    if (stats.lastAt > 0 && sinceMs < p.minMinutes * 60_000) {
      const left = Math.ceil((p.minMinutes * 60_000 - sinceMs) / 60_000)
      return { ok: false, reason: '节流:还差约 ' + String(left) + ' 分钟' }
    }
    return { ok: true, reason: null, params: p }
  }

  return {
    stats: () => ({ ...stats }),
    shouldRun,

    /**
     * 跑一轮。**绝不抛**;返回 `{ ok, skipped?, reason?, dyad?, gate? }`。
     * 成功时把结果并进 `emotion_vector`(零 DDL)并写审计。
     */
    async run ({ sessionId = '', userText = '', assistantText = '', messages = null } = {}) {
      const at = now()
      stats.turns += 1
      const gate0 = shouldRun(at)
      if (gate0.ok !== true) {
        stats.skipped += 1
        // 节流是**正常行为**,不写审计(否则每轮一行噪音);但"不可用"这种要留痕。
        const soft = String(gate0.reason || '').startsWith('节流:')
        if (!soft) record({ kind: '跳过', reason: gate0.reason }, sessionId)
        return { ok: false, skipped: true, reason: gate0.reason }
      }
      const p = gate0.params
      const names = (() => {
        try { const n = getNames ? getNames() : null; return { userName: (n && n.userName) || '用户', agentName: (n && n.agentName) || '角色' } } catch { return { userName: '用户', agentName: '角色' } }
      })()
      let previous = null
      try { previous = readDyad(store.getState().emotionVector) } catch { previous = null }
      const vector = (() => { try { return store.getState().emotionVector || {} } catch { return {} } })()
      const mapped = mappedSelf(vector)
      // 最近对话:调用方给了就用,没给就从会话日志现取(形状 `{user, assistant}`,老→新)。
      let turnRows = []
      if (Array.isArray(messages)) {
        turnRows = messages
      } else if (typeof recentTurns === 'function') {
        try { turnRows = recentTurns(sessionId, p.transcriptTurns) || [] } catch { turnRows = [] }
      }
      const transcriptMessages = Array.isArray(turnRows) && turnRows.length > 0 && typeof turnRows[0] === 'object' && 'user' in turnRows[0]
        ? turnRows.flatMap((r) => [
          { role: 'user', text: String(r.user || '') },
          { role: 'assistant', text: String(r.assistant || '') }
        ])
        : turnRows
      const opening = transcriptMessages.length === 0
      const persona = (() => {
        if (!opening) return undefined
        try { return getPersonaAnchor ? String(getPersonaAnchor() || '') : '' } catch { return '' }
      })()
      const prompt = adapter.appraisalPromptSync(transcriptMessages, {
        roleName: names.agentName,
        userName: names.userName,
        current: previous === null || pt(previous.other) === null
          ? { self: mapped.point, other: { a: 0.5, c: 0.5 } }
          : { self: mapped.point, other: pt(previous.other) },
        previousLabels: previous === null ? undefined : (previous.labels || undefined),
        maxChars: p.maxChars,
        perMessageChars: p.perMessageChars,
        opening,
        persona: opening ? persona : undefined
      })
      if (prompt === null) {
        stats.failed += 1
        stats.lastErr = 'prompt 构建失败(ipc-core 副本不可用?)'
        record({ kind: '失败', reason: stats.lastErr }, sessionId)
        return { ok: false, reason: stats.lastErr }
      }
      let raw = null
      try {
        raw = await callStructured({
          prompt: String(prompt.system || '') + '\n\n' + String(prompt.user || ''),
          label: 'echo-ipc-appraise',
          sessionId
        })
      } catch (err) {
        stats.failed += 1
        stats.lastErr = 'LLM 调用抛错:' + String((err && err.message) || err)
        record({ kind: '失败', reason: stats.lastErr }, sessionId)
        return { ok: false, reason: stats.lastErr }
      }
      // 通道形状:`llm-channel.runStructured` **不带 schema 时回字符串**(正文原文),
      // 带 schema 时回**已解析的对象**;`parseAppraisal` 两样都吃(字符串走它自己的
      // 宽容解析:剥围栏 / 截断救援 / 词→坐标)。所以这里两样都收,只把"空产出"判掉。
      const candidate = (() => {
        if (raw === null || raw === undefined) return null
        if (typeof raw === 'string') return raw
        if (typeof raw !== 'object') return null
        // 已经是打分对象(顶层就有 self/other 或扁平 selfA/selfC|a/c)⇒ 直接交给解析器。
        if (raw.self !== undefined || raw.other !== undefined || raw.selfA !== undefined
          || raw.self_a !== undefined || raw.a !== undefined || raw.agency !== undefined) return raw
        const inner = raw.text ?? raw.content ?? raw.raw
        if (typeof inner === 'string') return inner
        return (inner && typeof inner === 'object') ? inner : null
      })()
      if (candidate === null || (typeof candidate === 'string' && candidate.trim() === '')) {
        stats.failed += 1
        stats.lastErr = 'LLM 没有产出(通道不可用 / 超时 / 空产出)'
        record({ kind: '失败', reason: stats.lastErr }, sessionId)
        return { ok: false, reason: stats.lastErr }
      }
      const appraisal = adapter.parseAppraisalSync(candidate)
      if (appraisal === null) {
        stats.failed += 1
        stats.lastErr = '解析失败:输出里既没有 self 也没有 other'
        record({ kind: '失败', reason: stats.lastErr }, sessionId)
        return { ok: false, reason: stats.lastErr }
      }
      const gain = gainOf(appraisal)
      if (gain < p.gainMin) {
        stats.lowGain += 1
        const residual = residualOf({ appraised: appraisal.self, mapped: mapped.point })
        record({ kind: '门槛不足', reason: 'gain=' + String(gain) + ' < ' + String(p.gainMin), gate: residual.gate }, sessionId)
        return { ok: false, reason: '可信度不足(gain=' + String(gain) + ')', gain, gate: residual.gate }
      }
      const dynamics = (() => {
        try {
          const base = adapter.defaultDynamicsSync()
          const cur = previous === null || pt(previous.other) === null
            ? { self: mapped.point, other: pt(appraisal.other) ?? mapped.point }
            : { self: mapped.point, other: pt(previous.other) ?? mapped.point }
          const out = adapter.integrateDyadSync(cur, { self: appraisal.self, other: appraisal.other }, base, gain)
          // ⚠️ 上游返回的是 `{latent:{self,other}, grid, delta, reactivity, escalated, …}`
          // —— **根本没有 `point`**。第一版就是按 `point` 读的,于是惯性结算被
          // **静默跳过**(打分点原样落库,看起来还挺正常)—— 这类"看起来正常"的
          // 假成功正是本仓最贵的失败形态,所以这里显式认 `latent`(退化才用 `grid`)。
          const after = (out && out.latent && typeof out.latent === 'object')
            ? out.latent
            : ((out && out.grid && typeof out.grid === 'object') ? out.grid : null)
          if (after === null) return null
          return {
            latent: { self: pt(after.self), other: pt(after.other) },
            delta: (out && out.delta) || null,
            reactivity: (out && Number.isFinite(out.reactivity)) ? out.reactivity : (base && base.reactivity),
            maxStepPerTurn: (base && base.maxStepPerTurn) ?? null,
            escalated: (out && Number.isFinite(out.escalated)) ? out.escalated > 0 : false
          }
        } catch { return null }
      })()
      // 惯性结算后的**他的点**优先(与她的点同一套动力学);拿不到才退回原始打分。
      const smoothed = (dynamics && dynamics.latent && pt(dynamics.latent.other) !== null)
        ? pt(dynamics.latent.other)
        : null
      const dyad = buildDyad({
        appraisal: smoothed === null ? appraisal : { ...appraisal, other: smoothed },
        mapped: mapped.point,
        gain,
        at,
        dynamics,
        gainMin: p.gainMin
      })
      stats.runs += 1
      stats.ok += 1
      stats.lastAt = at
      stats.lastTurnRun = stats.turns
      stats.lastGate = dyad.gate
      // 零 DDL:并进已有的 emotion_vector JSON(不新增列、不动 mood_intensity)。
      try {
        if (store !== null && typeof store.saveEmotionVector === 'function') {
          store.saveEmotionVector(mergeDyad(vector, dyad))
        }
      } catch (err) {
        stats.failed += 1
        stats.lastErr = '落库失败:' + String((err && err.message) || err)
        record({ kind: '失败', reason: stats.lastErr, gate: dyad.gate }, sessionId)
        return { ok: false, reason: stats.lastErr, dyad }
      }
      record({
        kind: '已判定',
        reason: 'other=' + JSON.stringify(dyad.other) + ' gain=' + String(dyad.gain),
        gate: dyad.gate
      }, sessionId)
      note('ipc-appraise 已判定 gate=' + String(dyad.gate) + ' gain=' + String(dyad.gain))
      return { ok: true, dyad, gate: dyad.gate, gain, residual: dyad.residual }
    },

    /** 上一轮判定(给面板/审计只读用)。 */
    previous (vector) { return readDyad(vector) }
  }
}

export { gateOf, GATE_BANDS, directionOf }
