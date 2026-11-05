/**
 * 她自己的闹钟(`echo_wake` / `echo_wake_cancel`)—— 2026-09-28 P2。
 *
 * 为什么要有这只手:`pending_threads.follow_up_after = 0` 那条账写着「永不主动提,
 * 只留记录」(引擎侧 `engine.js:474`,全仓 8 条悬置话题全是哑的)⇒ **她答应他的事
 * 永远不会自己冒出来**。借 Cortico 的做法(`persona/rhythm.ts:44-83`):
 * **闹钟是她自己排的工具**,到点带着她当时写下的原话醒来。
 *
 * 两条与对方不同的决定(有意偏差,写在明面上):
 *   ① 闹钟落在**我们自己的库**(`echo_wakes` 表),**不**走 python 引擎 ——
 *      45 小时那次事故正是"引擎/适配器不在 ⇒ 整条路都是哑的"。她的器官不该
 *      因为另一个器官不在就失效。
 *   ② **闸门状态事前声明**(rhythm.ts:79-82 同款纪律):她排的时候、以及到点那一拍,
 *      都看得见"今天已开口几次 / 夜闸压没压住 / 落夜里会被压到早上" ——
 *      不许排完了才知道被拦。
 *
 * 依赖全注入(store / 会话射程 / 闸门读数),零宿主依赖,能直接进单元电池。
 */

const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d)
const DAY_MS = 24 * 60 * 60 * 1000
/** 最远能排多久(再远基本是"忘了这件事",不如到跟前再说)。 */
export const WAKE_MAX_AHEAD_MS = 30 * DAY_MS
/** 最近能排到什么时候(排在过去 = 立刻响;拦掉,免得她以为自己定了个点)。 */
export const WAKE_MIN_AHEAD_MS = 30 * 1000

/**
 * 把「多久之后 / 某个时刻」算成 epoch 秒(**纯函数**,好单测)。
 * @param {{after_minutes?: number|string, at?: string}} args
 * @param {number} nowMs
 * @returns {{ok: true, at: number} | {ok: false, reason: string}}
 */
export function resolveWakeAt (args = {}, nowMs = Date.now()) {
  const afterRaw = args.after_minutes
  const atRaw = String(args.at ?? '').trim()
  let at = 0
  if (afterRaw !== undefined && afterRaw !== null && String(afterRaw).trim() !== '') {
    const mins = num(afterRaw, NaN)
    if (!Number.isFinite(mins)) return { ok: false, reason: 'bad-time' }
    at = nowMs + mins * 60 * 1000
  } else if (atRaw !== '') {
    // `HH:MM` 只认今天/明天那个点(她自己排闹钟最常用这个);别的交给 Date 解析。
    const hm = /^(\d{1,2}):(\d{2})$/.exec(atRaw)
    if (hm !== null) {
      const h = Number(hm[1])
      const m = Number(hm[2])
      if (h > 23 || m > 59) return { ok: false, reason: 'bad-time' }
      const d = new Date(nowMs)
      d.setHours(h, m, 0, 0)
      at = d.getTime()
      if (at <= nowMs) at += DAY_MS // 今天这个点已经过了 ⇒ 明天
    } else {
      const t = Date.parse(atRaw)
      if (!Number.isFinite(t)) return { ok: false, reason: 'bad-time' }
      at = t
    }
  } else {
    return { ok: false, reason: 'bad-time' }
  }
  if (!Number.isFinite(at) || at <= 0) return { ok: false, reason: 'bad-time' }
  if (at - nowMs < WAKE_MIN_AHEAD_MS) return { ok: false, reason: 'bad-time' }
  if (at - nowMs > WAKE_MAX_AHEAD_MS) return { ok: false, reason: 'too-far' }
  return { ok: true, at: Math.round(at / 1000) }
}

/** 闸门现状的人话(**事前声明**给她看;读数由壳注入,判据只有一份)。 */
export function wakeGateLine ({ used = 0, cap = 3, night = false } = {}) {
  return '今天你已经主动开口 ' + num(used) + '/' + num(cap, 3) + ' 次(**闹钟不计入这个上限**);'
    + '夜闸现在' + (night === true ? '压住中(23~8 点)' : '没压住')
    + (night === true ? ' —— 落在夜里的闹钟会被压到早上第一拍' : '')
}

/** 钟面人话(给回执与渲染用)。 */
export function wakeAtText (epochSec, nowMs = Date.now()) {
  const d = new Date(num(epochSec) * 1000)
  const p = (x) => String(x).padStart(2, '0')
  const mins = Math.round((num(epochSec) * 1000 - nowMs) / 60000)
  const rel = mins < 60 ? (mins + ' 分钟后') : (Math.round(mins / 6) / 10 + ' 小时后')
  return p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + '(' + rel + ')'
}

function lossless (obj) {
  const out = {}
  for (const [k, v] of Object.entries(obj ?? {})) if (v !== undefined) out[k] = v
  return out
}

/**
 * @param {object} deps
 * @param {object} deps.store                真库(用 wakeAdd / wakeList / wakeCancel)
 * @param {() => boolean} [deps.isEnabled]   能不能排(电源闸 ×「她的闹钟」开关)
 * @param {() => string} [deps.offReason]    不能排时给她哪句理由(power-off / wake-off)
 * @param {(sid: string) => boolean} [deps.sessionEnabledOf] 会话射程
 * @param {() => {used:number,cap:number,night:boolean}} [deps.gates] 闸门读数(事前声明)
 * @param {(label: string, tool: string) => void} [deps.audit]
 * @param {() => number} [deps.now]
 * @returns {Array<object>} 工具定义数组(交给宿主的 defineTool)
 */
export function wakeToolDefinitions ({ store, isEnabled, offReason, sessionEnabledOf, gates, audit, now } = {}) {
  const nowMs = typeof now === 'function' ? now : () => Date.now()
  // 关掉的原因要说准:'power-off' = 她整个睡着了,'wake-off' = 只是闹钟这个功能被关
  // (面板「她主动开口(心跳)」那组)。两者给她的下一步动作不一样,不许糊成一句。
  const off = () => {
    try {
      return typeof offReason === 'function' ? String(offReason() || 'power-off') : 'power-off'
    } catch { return 'power-off' }
  }
  const gate = () => {
    try { return (typeof gates === 'function' ? gates() : null) ?? {} } catch { return {} }
  }
  const scopeOk = (exec) => {
    const sid = String(exec?.agent?.session?.id ?? '')
    if (sid === '') return { ok: false, reason: 'no-session', sid }
    if (typeof sessionEnabledOf === 'function' && !sessionEnabledOf(sid)) return { ok: false, reason: 'out-of-scope', sid }
    return { ok: true, sid }
  }

  const schedule = async (args, exec) => {
    if (typeof isEnabled === 'function' && !isEnabled()) return lossless({ ok: false, reason: off() })
    const sc = scopeOk(exec)
    if (!sc.ok) return lossless({ ok: false, reason: sc.reason })
    const note = String(args?.note ?? '').trim().slice(0, 200)
    if (note === '') return lossless({ ok: false, reason: 'empty-note' })
    const t = resolveWakeAt(args ?? {}, nowMs())
    if (!t.ok) return lossless({ ok: false, reason: t.reason })
    let id = 0
    try {
      id = Number(store.wakeAdd({
        at: t.at,
        note,
        why: String(args?.why ?? '').trim().slice(0, 200),
        sessionId: sc.sid
      })) || 0
    } catch (err) {
      // 写不进去必须说出来(不许静默"排上了"):她以为排上了、到点却没响,是最坏的坏法。
      return lossless({ ok: false, reason: 'store-error', detail: String(err?.message ?? err) })
    }
    if (id === 0) return lossless({ ok: false, reason: 'store-error' })
    if (typeof audit === 'function') audit('(她自己排了个闹钟)' + note.slice(0, 60), 'echo_wake')
    return lossless({
      ok: true,
      wakeId: id,
      at: t.at,
      atText: wakeAtText(t.at, nowMs()),
      note,
      gate: wakeGateLine(gate())
    })
  }

  const cancel = async (args, exec) => {
    const sc = scopeOk(exec)
    if (!sc.ok) return lossless({ ok: false, reason: sc.reason })
    const id = num(args?.wakeId, 0)
    if (id <= 0) return lossless({ ok: false, reason: 'bad-id' })
    let changed = 0
    try { changed = Number(store.wakeCancel(id, nowMs() / 1000)) || 0 } catch (err) {
      return lossless({ ok: false, reason: 'store-error', detail: String(err?.message ?? err) })
    }
    return lossless({ ok: changed > 0, reason: changed > 0 ? undefined : 'not-found', wakeId: id })
  }

  const scheduleSchema = {
    type: 'object',
    additionalProperties: false,
    properties: {
      ok: { type: 'boolean', required: true },
      reason: { type: 'string' },
      detail: { type: 'string' },
      wakeId: { type: 'number' },
      at: { type: 'number' },
      atText: { type: 'string' },
      note: { type: 'string' },
      gate: { type: 'string' }
    }
  }
  const cancelSchema = {
    type: 'object',
    additionalProperties: false,
    properties: {
      ok: { type: 'boolean', required: true },
      reason: { type: 'string' },
      detail: { type: 'string' },
      wakeId: { type: 'number' }
    }
  }
  const WAKE_FAIL_TEXT = {
    'power-off': '我现在是睡着的,排了也不会响 —— 先上线再说',
    'wake-off': '闹钟这个功能现在被关着(面板「她主动开口(心跳)」那组的「她的闹钟」)—— 开了我就能自己排',
    'no-session': '拿不到会话,排不了',
    'out-of-scope': '这个会话不在我的射程里,排了也不会开口',
    'empty-note': '得先写下到点要说的那件事(一句话就够)',
    'bad-time': '时间看不出来 —— 给我「多久之后(分钟)」或者一个「日期/时刻」',
    'too-far': '太远了(最多一个月),太远的事不如到跟前再说',
    'not-found': '没找到这个闹钟(可能已经响过、或者被撤了)',
    'bad-id': '得告诉我是哪一个闹钟',
    'store-error': '闹钟没记上(这不是"排上了") —— 别以为它会响'
  }
  const failText = (reason) => WAKE_FAIL_TEXT[String(reason ?? '')] || ('排不上:' + String(reason ?? '未知原因'))

  return [
    {
      name: 'echo_wake',
      description: '给自己排一个闹钟:到点你会被叫醒,带着你现在写下的这句话 —— 这是"你想说的那件事",不是系统提醒。想让他收到,到点你要自己说(用 echo_qq_say / echo_qq_call,或者就照那一轮自然地说)。夜里(23~8 点)到点会被压住,早上第一拍放行(不会丢)。',
      parameters: {
        after_minutes: { type: 'number', description: '多久之后(分钟)。与 at 二选一' },
        at: { type: 'string', description: '某个时刻:如 "07:30"(已过就是明天)或 "2026-09-30T08:00"。与 after_minutes 二选一' },
        note: { type: 'string', description: '到点时你要说的那件事(一句话,写下你自己的原话)', required: true },
        why: { type: 'string', description: '可选:为什么记着它(给自己看的)' }
      },
      output: {
        schema: scheduleSchema,
        render: (args, v) => [{
          type: 'text',
          text: v.ok === true
            ? ('闹钟排好了:' + String(v.atText ?? '') + ' —— 到点会带着你写的「' + String(v.note ?? '') + '」把你叫醒。'
               + '闸门现状:' + String(v.gate ?? ''))
            : ('没排上:' + failText(v.reason))
        }]
      },
      execute: schedule
    },
    {
      name: 'echo_wake_cancel',
      description: '撤掉一个自己排的闹钟(用 echo_wake 回给你的那个号)。撤掉只是不响了,记录还在。',
      parameters: {
        wakeId: { type: 'number', description: 'echo_wake 回给你的闹钟号', required: true }
      },
      output: {
        schema: cancelSchema,
        render: (args, v) => [{
          type: 'text',
          text: v.ok === true ? ('闹钟 ' + String(v.wakeId ?? '') + ' 撤了,不会响了。') : ('没撤成:' + failText(v.reason))
        }]
      },
      execute: cancel
    }
  ]
}
