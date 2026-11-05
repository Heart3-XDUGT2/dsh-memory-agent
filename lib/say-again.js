/**
 * v0.21.0 E5:情绪余波 say_again(「忍不住还想补一句」)。
 *
 * A 侧出处 `main.py:1382-1479`:
 *   - Judge 每轮多出两个字段:`say_again`(0/1)与 `extra_reply`(≤15 字的
 *     自然口语补充;`say_again=0` 时必须为空)。判据写得很窄 ——
 *     **仅当助手自己情绪余波未平**(刚被感动/被委屈/被逗到)才给 1,
 *     日常闲聊、答疑、寒暄一律 0;连续多轮给 1 属于错误行为
 *     (`core/echo_prompts.py:45-46`)。
 *   - `say_again=1 且 extra_reply 非空 且 开关开` ⇒ 挂起一次追加发言:
 *     延迟 `uniform(2.0, 5.0)` 秒;同一会话只保留最后一次(新的顶掉旧的)。
 *   - **用户再开口 = 抢话 ⇒ 立刻撤回**(`_cancel_pending_say`);送到之前
 *     还要再核一次会话序号(`_session_seq`),防止"睡醒前那一瞬"的竞态。
 *
 * B 侧为什么机制不同(刻意偏离,记在这):
 *   A 是**直接把那句话发出去**(平台 API 发一条纯文本)。B 里"嘴"是 agent
 *   自己的回合一 —— 插一句话要经宿主的维护相(`agent.runMaintenance` +
 *   `agent.followup`,与主动关怀同一条路 `heartbeat.js:171`)。所以我们把
 *   **那句话原样交给她、让她说出来**,而不是绕过她替她发:台词一样,
 *   出口仍是她的。代价:多一次极短的模型步;收益:平台侧(QQ/网页)走
 *   同一条出站路,气泡切分/租约/销账/失败重试全都复用。
 *
 * 本模块**不碰宿主 API**:定时器、投递、随机数、时钟全部注入 ⇒ 能离线
 * 用假定时器把"取消竞态"这种最难测的东西钉住(见 tests/say-again.test.js)。
 */

export const DEFAULT_MIN_DELAY_MS = 2000
export const DEFAULT_MAX_DELAY_MS = 5000
/** A 侧裁剪:main.py 取 `[:80]`(审计口径;DB 列 `[:200]`)。 */
export const EXTRA_REPLY_MAX_CHARS = 80
/** 同一会话只留最后一次;上限只为防病态,不参与正常路径。 */
const MAX_PENDING = 64

/**
 * 把 Judge 给的 `extra_reply` 规整成能说出口的一句。
 * 空/非字符串/只有空白 ⇒ `''`(= 不发)。
 */
export function extraReplyText (raw) {
  if (typeof raw !== 'string') return ''
  const t = raw.replace(/\s+/g, ' ').trim()
  return t.length > EXTRA_REPLY_MAX_CHARS ? t.slice(0, EXTRA_REPLY_MAX_CHARS) : t
}

/**
 * 纯判定:这一轮该不该挂起余波。
 * @returns {{fire: boolean, reason: string}}
 */
export function shouldSayAgain ({ enabled = true, sessionEnabled = true, sayAgain = 0, extraReply = '' } = {}) {
  if (!enabled) return { fire: false, reason: 'disabled' }
  if (!sessionEnabled) return { fire: false, reason: 'session-off' }
  if (Number(sayAgain) !== 1) return { fire: false, reason: 'judge-said-no' }
  if (extraReplyText(extraReply) === '') return { fire: false, reason: 'empty-extra-reply' }
  return { fire: true, reason: 'scheduled' }
}

/**
 * 交给她说那句话的信封(措辞与 lib/interrupted.js 的【你刚才被插嘴了】同族:
 * 台词原样给出,但明确"别复述、别解释")。
 */
export function renderSayAgainLine (text) {
  const line = extraReplyText(text)
  return '【情绪余波】你还有半句没说完 —— 就说这一句:「' + line + '」\n'
    + '直接说出来,不要复述上文、不要解释这句话、不要提"情绪余波"这三个字,也别道歉。'
}

/**
 * 调度器。
 *
 * @param {object} deps
 * @param {Function} deps.deliver     `async (agent, text, queryText, form) => boolean`
 *                                    (heartbeat 那条维护相投递;失败返回 false)
 * @param {Function} [deps.writeAudit] 送达后写一行审计(`toolCall:'say_again'`)
 * @param {Function} [deps.isEnabled] 总闸(设置 say_again.enabled)
 * @param {Function} [deps.isSessionEnabled] 会话范围闸
 * @param {Function} [deps.settingsOf] 读 `{minDelayMs, maxDelayMs}`(面板可调)
 * @param {Function} [deps.setTimer]/[deps.clearTimer] 定时器注入(测试用)
 * @param {Function} [deps.random]/[deps.now] 随机与时钟注入
 * @param {object} [deps.logger]
 */
export function createSayAgain ({
  deliver, writeAudit = null, isEnabled = () => true, isSessionEnabled = () => true,
  settingsOf = () => ({}), logger = null,
  setTimer = setTimeout, clearTimer = clearTimeout,
  random = Math.random, now = () => Date.now()
} = {}) {
  const warn = (m) => { try { logger?.warn?.('echo: ' + m) } catch { } }
  const info = (m) => { try { logger?.info?.('echo: ' + m) } catch { } }
  /** sessionId → {timer, seq, text, traceId, agent} */
  const pending = new Map()
  /** sessionId → 用户开口次数(A 的 `_session_seq`) */
  const seqOf = new Map()

  function delayMs () {
    let min = DEFAULT_MIN_DELAY_MS
    let max = DEFAULT_MAX_DELAY_MS
    try {
      const s = settingsOf() || {}
      if (Number.isFinite(Number(s.minDelayMs)) && Number(s.minDelayMs) >= 0) min = Number(s.minDelayMs)
      if (Number.isFinite(Number(s.maxDelayMs)) && Number(s.maxDelayMs) >= min) max = Number(s.maxDelayMs)
    } catch { }
    return Math.round(min + random() * (max - min))
  }

  /** 用户开口:序号 +1 并撤回挂起的那一次(A 的 `_cancel_pending_say`)。 */
  function bump (sessionId) {
    const sid = String(sessionId || '')
    if (sid === '') return
    seqOf.set(sid, (seqOf.get(sid) || 0) + 1)
    cancel(sid, 'user-spoke')
  }

  function cancel (sessionId, reason = 'cancelled') {
    const sid = String(sessionId || '')
    const p = pending.get(sid)
    if (p === undefined) return false
    pending.delete(sid)
    try { clearTimer(p.timer) } catch { }
    info('用户已抢先发言,撤回未发出的情绪余波(' + reason + '):' + p.text)
    return true
  }

  /**
   * 挂起一次余波。同一会话只保留最后一次(新的顶掉旧的 —— A 原文:
   * "挂起一次'意难平'的追加发言;同一会话只保留最后一次")。
   * @returns {{scheduled: boolean, reason: string, delayMs?: number}}
   */
  function schedule ({ agent = null, sessionId = '', sayAgain = 0, extraReply = '', traceId = '' } = {}) {
    const sid = String(sessionId || '')
    const text = extraReplyText(extraReply)
    let enabled = true
    let sessionOn = true
    try { enabled = Boolean(isEnabled()) } catch { enabled = true }
    try { sessionOn = sid === '' ? true : Boolean(isSessionEnabled(sid)) } catch { sessionOn = true }
    const verdict = shouldSayAgain({ enabled, sessionEnabled: sessionOn, sayAgain, extraReply: text })
    if (!verdict.fire) {
      // A 也把「say_again=1 但 extra_reply 为空」显式记一条日志,不静默
      if (verdict.reason === 'empty-extra-reply') info('say_again=1 但 extra_reply 为空,已忽略。')
      return { scheduled: false, reason: verdict.reason }
    }
    if (agent === null || typeof deliver !== 'function') {
      warn('情绪余波拿到台词却没有投递通道(agent/deliver 缺席),已放弃:' + text)
      return { scheduled: false, reason: 'no-channel' }
    }
    cancel(sid, 'replaced')
    const seq = seqOf.get(sid) || 0
    const delay = delayMs()
    const entry = { seq, text, traceId, agent, timer: null }
    entry.timer = setTimer(() => { void fire(sid, entry) }, delay)
    pending.set(sid, entry)
    if (pending.size > MAX_PENDING) {
      // 只会发生在会话 id 病态膨胀时:丢最早挂起的那一个,不无限攒
      const oldest = pending.keys().next().value
      if (oldest !== sid) cancel(oldest, 'overflow')
    }
    info('情绪余波已挂起(' + (delay / 1000).toFixed(1) + ' 秒后追加):' + text)
    return { scheduled: true, reason: 'scheduled', delayMs: delay }
  }

  async function fire (sid, entry) {
    const cur = pending.get(sid)
    if (cur !== entry) return // 已被新的顶掉 / 已取消
    pending.delete(sid)
    // 竞态闸:定时器醒来的这一刻,用户可能刚好又开口了(A 的 seq 核对)
    if ((seqOf.get(sid) || 0) !== entry.seq) {
      info('情绪余波到点时你已经又开口了,放弃:' + entry.text)
      return
    }
    let ok = false
    try {
      ok = Boolean(await deliver(entry.agent, renderSayAgainLine(entry.text), entry.text, 'say_again'))
    } catch (err) {
      warn('情绪余波投递异常(已忽略):' + String(err?.message ?? err))
      ok = false
    }
    if (writeAudit !== null) {
      try {
        writeAudit({
          traceId: entry.traceId || ('say-again-' + String(now())),
          stage: 'say_again',
          sessionId: sid,
          userInput: '(情绪余波)',
          injectedMemories: '',
          llmReply: '',
          toolCall: ok ? 'say_again' : 'say_again_failed',
          sayAgain: 1,
          extraReply: entry.text
        })
      } catch (err) {
        warn('情绪余波审计写入失败(不影响投递):' + String(err?.message ?? err))
      }
    }
    if (ok) info('情绪余波已送达:' + entry.text)
    else warn('情绪余波没送出去(她忙着或会话不在了),放弃:' + entry.text)
  }

  return {
    schedule,
    cancel,
    bump,
    pendingCount: () => pending.size,
    seqOf: (sid) => seqOf.get(String(sid || '')) || 0,
    /** 关插件/换配置时清干净(不留悬空定时器)。 */
    dispose: () => {
      for (const sid of [...pending.keys()]) cancel(sid, 'dispose')
      seqOf.clear()
    }
  }
}
