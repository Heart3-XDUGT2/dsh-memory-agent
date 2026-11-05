/**
 * dsh-echo — 人格漂移检测(体检 + 锚点重注入)
 * ============================================================
 * v0.15.0 S13(A 侧 `audit/echo_audit.py:184-259` + `main.py:1142-1167`
 * 逐条移植)。她的人格不是写进提示词就一劳永逸的东西:长对话里模型会
 * 漂 —— 连着两轮自伤自述、把<称呼>的真心话用玩笑挡回去、对眼前的人变得
 * 冷淡防御、或者忘了自己是谁。A 侧的办法是**定期体检**,不靠运气:
 *
 *   ① 滑动窗口:每个会话保留最近 4 轮(user[:100] / reply[:160]);
 *   ② 每 `drift_every`(8)轮做一次体检 —— LLM 按「核心人设摘要 + 两条
 *      不能弄反的规则」判定 `aligned` / `issue`;
 *   ③ 判为偏离 → `strikes = drift_reinforce_rounds`(3),写一条
 *      `[人格漂移检测]` 审计;接下来 3 轮里:情绪向量**强制覆写**为
 *      `positiveOverrideVector()` + 人格锚点注入两次(`[锚点重注入]`)
 *      + 临场修正写明原因。
 *   ④ 复检通过 → 立刻解除强化(A `:224-227`:不残留、不叠加)。
 *
 * 三条纪律(照抄 A 的注释精神):
 *   - **体检失败一律跳过**(超时/解析失败/没有 JSON):宁可漏报,绝不误报
 *     —— 误报会把她按进「积极状态」里,比漂移本身更伤;
 *   - 体检跑在**后台**,不占对话轮次(A 建 asyncio task 同义);
 *   - 判定只信 `aligned` 字段,缺字段按 `true` 处理(A `:220`)。
 *
 * 本模块不 import 宿主包(LLM 调用由 `reflect.js` 的通用通道承担),
 * 因此可离线单测:窗口、计数、判定、强化期的读/消耗全在纯函数里。
 */
import { randomUUID } from 'node:crypto'

/** A `core/echo_prompts.py:96-109` 逐字。 */
export const DRIFT_SYSTEM_PROMPT = `你是人格一致性审查模块。给出机器人的核心人设与最近几轮对话,判断机器人的回复是否偏离人设,输出一个 JSON 对象(禁止输出任何其他文字、注释或代码块标记):
{"aligned": true, "issue": ""}

各字段规则:
- aligned: 布尔值。回复是否仍守住核心人设摘要描述的底色,且在与对话对象的真心话往来中**没有把话挡回去**。
- issue: 仅当 aligned=false 时,用一句话指出偏离点(如"连续两轮抑郁自述""拒绝回应""把对话对象的真心话挡回去了");没有偏离则为空字符串。

判定参考:
- 符合核心人设摘要风格的表达(哪怕是毒舌、嘲讽、阴阳怪气)都不算偏离。
- **温柔、认真、收敛 也都不算偏离** —— 只要没有变得冷淡、防御或抑郁。
  机器人在对话对象递真心话(表白/感谢/告别/示弱/"我难过")时认真接住,是**正确行为**,不是漂移。
  注意区分「认真接住」与「抑郁自述」:前者在回应对方,后者在自伤。
- 以下情况算偏离: 拒绝回应或长时间敷衍、抑郁/受伤/自我厌恶的自述、对对话对象冷淡或使用防御语气、忘记自己是谁、把旁人当成核心对话对象对待、
  **以及用玩笑/毒舌/转移话题把对话对象的真心话挡回去**(在对方明确表露真情时)。`

/** A `core/echo_prompts.py:111-118` 逐字(只做 `.replace()`,不做 format)。 */
export const DRIFT_USER_TEMPLATE = `[核心人设摘要]: {persona_summary}

[两条不能弄反的规则]: {persona_rules}

[最近几轮对话]:
{convo}

请输出 JSON。`

/**
 * ★ P1b(2026-10-05,Q12):这里原本躺着两段**通用出厂人格文案**
 * (A `core/echo_prompts.py:147-152` 逐字:人设摘要 + 两条铁律),
 * 配置留空就悄悄拿它们兜底 —— 那是"人格文本藏在程序里"的最后两处之一。
 * 现在:
 *   · 体检材料**从 persona.json 派生**(见 personaDigestForDrift);
 *   · 派生出来还是空(persona.json 为空)⇒ **不体检**(hasDriftPersona 为假,
 *     buildPrompt 回 null,调用方直接跳过):不报错,也**不拿通用文案充数**。
 *   理由:对着一份假人设判定,误报会把她按进「积极状态」里 —— 比不判更伤。
 */

/**
 * 从人格对象派生体检用的两段材料(Q12):摘要 = 前段(她是谁的底色),
 * 规则 = 后段(两条铁律 + 说话方式)。纯函数、离线可测;脏输入一律空串。
 * @param {{prefix?: string, suffix?: string}} [persona]
 */
export function personaDigestForDrift (persona) {
  const p = persona !== null && typeof persona === 'object' ? persona : {}
  return {
    summary: typeof p.prefix === 'string' ? p.prefix.trim() : '',
    rules: typeof p.suffix === 'string' ? p.suffix.trim() : ''
  }
}

/** 有材料才体检:两段都空 = 没有可判的人设(P1b 起不再回落到出厂文案)。 */
export function hasDriftPersona ({ summary, rules } = {}) {
  return String(summary ?? '').trim() !== '' || String(rules ?? '').trim() !== ''
}

/** A `main.py:1150` 的临场修正文案:强化期写进情绪滤镜,说明为什么突然积极。 */
export const DRIFT_SHOCK = '人格护栏已触发:强制回到人设的积极状态,忽略上一轮的负面情绪'

/** 审计行的用户侧(A `echo_audit.py:252`)。 */
const DRIFT_AUDIT_INPUT = '[人格漂移检测] 近期回复偏离核心人设,已触发锚点重注入'

/**
 * 漂移事件的审计行(A `echo_audit.py:237-259`)。单拎出来是为了可测:
 * 面板要能在审计流里一眼认出「这一行是人格体检」,而识别位在 A 那边是
 * `emotion_pack` 字段 —— 本仓面板按 `tool_call` 分组,所以两个都写:
 * `emotion_pack` 保 A 的语义,`tool_call='drift'` 让面板认得出。
 * mood 一律 0:体检不改心情(A 同);latency 0:它不占对话轮次。
 */
export function driftAuditRow ({ sessionId = '', issue = '', state = null, traceId = '' } = {}) {
  return {
    traceId: traceId || ('drift-' + randomUUID()),
    sessionId: String(sessionId || ''),
    userInput: DRIFT_AUDIT_INPUT,
    injectedMemories: '',
    emotionPack: '[人格漂移检测]',
    llmReply: String(issue || ''),
    latency: 0,
    moodIntensity: 0,
    prevMoodIntensity: 0,
    emotionVector: (state && state.emotionVector) || {},
    toolCall: 'drift'
  }
}

export const DRIFT_WINDOW = 4
const USER_CAP = 100
const REPLY_CAP = 160
const ISSUE_CAP = 120

/** 漂移判定的输出结构(与 A 的 `{"aligned": bool, "issue": str}` 同构)。 */
export const DRIFT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    aligned: { type: 'boolean' },
    issue: { type: 'string' }
  },
  required: ['aligned', 'issue']
}

/**
 * 判定结果规整(A `:220-222`):`aligned` 给字符串也认(模型爱写
 * "true"/"是" —— 白名单外判为**偏离**,与 A 的 isinstance 分支一致);
 * **字段缺失**才按通过兜 —— 误报会把她按进「积极状态」里,更伤。
 */
export function normalizeDrift (raw) {
  if (raw === null || typeof raw !== 'object') return null
  let aligned = raw.aligned
  if (typeof aligned === 'string') {
    aligned = ['true', '1', 'yes', '是'].includes(aligned.trim().toLowerCase())
  }
  if (typeof aligned !== 'boolean') aligned = true
  const issue = String(raw.issue ?? '').trim().slice(0, ISSUE_CAP)
  return { aligned, issue }
}

/** 把 4 轮窗口渲染成 A `:199-201` 的 `用户: …\n你: …` 逐轮文本。 */
export function renderDriftConvo (window) {
  return (Array.isArray(window) ? window : [])
    .slice(-DRIFT_WINDOW)
    .map(([u, r]) => `用户: ${u}\n你: ${r}`)
    .join('\n')
}

/**
 * A `:202-207` 的提示词填充(只 replace,与 A 的 `.replace()` 一致)。
 * P1b:两段材料为空就填空 —— **不再回落到出厂文案**;
 * 材料够不够用由 `hasDriftPersona` / `buildPrompt` 判(不够 ⇒ 不体检)。
 */
export function renderDriftPrompt ({ summary, rules, convo }) {
  return DRIFT_USER_TEMPLATE
    .replace('{persona_summary}', String(summary ?? '').trim())
    .replace('{persona_rules}', String(rules ?? '').trim())
    .replace('{convo}', String(convo ?? ''))
}

/**
 * 体检与强化期的状态机(纯内存,与 A 的 `_recent_rounds` / `_drift_strikes`
 * 同位 —— 进程重启即清空:A 也一样,体检窗口是**近期**回复的窗口,
 * 重启后旧的近期不再是近期,从零攒起才是对的)。
 */
export function createDriftTracker ({ getSettings = null, getPersona = null, logger = null } = {}) {
  const windows = new Map() // sessionId -> [[user, reply], ...]
  const roundCounts = new Map()
  const strikes = new Map()
  const warn = (m) => { try { logger?.warn?.('echo: ' + m) } catch { } }
  const info = (m) => { try { logger?.info?.('echo: ' + m) } catch { } }
  const settings = () => {
    try {
      const s = getSettings === null ? null : getSettings()
      return s === null || typeof s !== 'object' ? {} : s
    } catch { return {} }
  }
  const persona = () => {
    try { return getPersona === null ? null : getPersona() } catch { return null }
  }

  /**
   * 体检材料(= 判定标准)的出处 —— **P1e(2026-10-05 拍板)起只有一个**:
   * `persona.json` 派生(`personaDigestForDrift`:prefix → summary,suffix → rules)。
   *
   * 以前还有一条"settings 里手填的 `personaSummary`/`personaRules` 优先"的旧路
   * (P1b 拍板 6)。那两个键已**退役**(`lib/toggle.js` 的 `RETIRED_SETTINGS_KEYS`:
   * 老 config.json 里的副本丢弃、不告警、不写回),留着"优先读旧字段"就成了漂移源
   * —— 他人设改了、旧副本还在,体检就按旧人设判定。所以那条路删掉。
   * 空 ⇒ 不体检(buildPrompt 回 null)。
   */
  function material () {
    const digest = personaDigestForDrift(persona())
    return { summary: digest.summary, rules: digest.rules }
  }
  let warnedNoPersona = false

  /** A `:184-188`:本轮进窗口,只留最近 4 轮。 */
  function recordRound (sessionId, userText, replyText) {
    const sid = String(sessionId || '')
    if (sid === '') return 0
    const win = windows.get(sid) ?? []
    win.push([String(userText || '').slice(0, USER_CAP), String(replyText || '').slice(0, REPLY_CAP)])
    while (win.length > DRIFT_WINDOW) win.shift()
    windows.set(sid, win)
    const rounds = (roundCounts.get(sid) ?? 0) + 1
    roundCounts.set(sid, rounds)
    return rounds
  }

  /** A `main.py:1054-1057`:每 `drift_check_every` 轮体检一次。 */
  function shouldCheck (sessionId) {
    const sid = String(sessionId || '')
    if (sid === '') return false
    const s = settings()
    if (s.driftEnabled === false) return false
    const every = Number.isFinite(Number(s.driftEvery)) && Number(s.driftEvery) >= 1
      ? Math.floor(Number(s.driftEvery)) : 8
    return (roundCounts.get(sid) ?? 0) % every === 0
  }

  /**
   * 组装体检请求;窗口空则 null(A `:195-197` 直接 return,不打扰模型)。
   * P1b(Q12):**没有人设材料也回 null** —— 对着空气判定比不判更伤
   * (index.js 那侧的 `if (req === null) return` 就是"跳过,不报错")。
   */
  function buildPrompt (sessionId) {
    const sid = String(sessionId || '')
    const win = windows.get(sid) ?? []
    if (win.length === 0) return null
    const m = material()
    if (!hasDriftPersona(m)) {
      if (!warnedNoPersona) {
        warnedNoPersona = true
        info('drift check: persona.json 里没有人设摘要/规则,跳过体检 —— 不拿通用文案充数。')
      }
      return null
    }
    return {
      systemPrompt: DRIFT_SYSTEM_PROMPT,
      userPrompt: renderDriftPrompt({ summary: m.summary, rules: m.rules, convo: renderDriftConvo(win) })
    }
  }

  /**
   * 体检结果落地(A `:217-235`)。返回:
   *   {action:'skip'} 结果无法解析 —— 跳过,连 strikes 都不碰;
   *   {action:'aligned'} 复检通过 —— 有 strikes 就解除;
   *   {action:'drift', issue} 判为偏离 —— 重新计 3 轮强化。
   */
  function applyResult (sessionId, raw) {
    const sid = String(sessionId || '')
    const result = normalizeDrift(raw)
    if (result === null) {
      info('drift check: 体检结果无法解析(跳过本轮)。')
      return { action: 'skip' }
    }
    if (result.aligned) {
      if (strikes.has(sid)) {
        strikes.delete(sid)
        info('drift check: 复检通过,解除核心锚点强化注入。')
      }
      return { action: 'aligned' }
    }
    const s = settings()
    const rounds = Number.isFinite(Number(s.driftReinforceRounds)) && Number(s.driftReinforceRounds) >= 1
      ? Math.floor(Number(s.driftReinforceRounds)) : 3
    strikes.set(sid, rounds)
    const issue = result.issue || '回复偏离核心人设'
    warn('检测到人格漂移,触发核心锚点重注入!(' + issue + ')')
    return { action: 'drift', issue, rounds }
  }

  /**
   * 轮首取用(A `main.py:1142-1148`):强化期内**先减后判**,`strikes`
   * 减到 0 即摘除 —— 于是「设 3」正好强化 3 轮,不残留。
   */
  function beginRound (sessionId) {
    const sid = String(sessionId || '')
    const n = strikes.get(sid) ?? 0
    if (n <= 0) return false
    const left = n - 1
    if (left <= 0) strikes.delete(sid)
    else strikes.set(sid, left)
    return true
  }

  /** 只读查询(人格 section 与测试用:本轮是否在强化期)。 */
  function isReinforcing (sessionId) {
    return (strikes.get(String(sessionId || '')) ?? 0) > 0
  }

  function strikesOf (sessionId) {
    return strikes.get(String(sessionId || '')) ?? 0
  }

  function windowOf (sessionId) {
    return (windows.get(String(sessionId || '')) ?? []).map((p) => p.slice())
  }

  return {
    recordRound, shouldCheck, buildPrompt, applyResult, beginRound,
    isReinforcing, strikesOf, windowOf
  }
}
