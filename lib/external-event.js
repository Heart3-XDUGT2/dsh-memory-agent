/**
 * v0.38.0 F1:外部事件入口 —— 传感器/语音平台打进来的那道门。
 *
 * 出处:aura-scheduler 的 `sensors.ts`。**为什么这条对我们是要紧的**:
 * 「主体最终是自主搭建的语音对话平台,QQ 只是工具」—— 语音平台要能说
 * "他到家了""他在电脑前坐下了",她才算真有感官。这条入口就是那扇门。
 *
 * 设计纪律(抄自计划,一条都不许松):
 *   1. **复用 P2 已经建好的手**:事件只负责**排一个到点的 wake**(`echo_wakes`),
 *      投递、夜闸、留账全走心跳那条老路 —— **绝不新开第二条投递链**
 *      (第二条链就是第二个"45 小时没人发现"的地方);
 *   2. **fail-closed**:开关 `externalWake` 默认 **off**;关着就 403,不静默收下;
 *   3. **留账**:每个收下的事件都写一行审计(`event_in`),外加 wake 自己的
 *      `wake-sent`/`wake-off`/`wake-night-hold` —— 收没收到、响没响,查得到;
 *   4. 这一层是**纯解析**(时间、文本、场合),不碰库、不碰宿主,离线可测。
 */

/** 事件文本的上限(它会被塞进注入块;截断要留痕,见 `truncated`)。 */
export const EVENT_MAX_CHARS = 200
/** 最远允许排到多久以后(与 echo_wake 同一个上限:30 天)。 */
export const EVENT_MAX_AHEAD_MS = 30 * 24 * 60 * 60 * 1000

const isoLike = (s) => /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2})?/.test(String(s || ''))

/** epoch 秒 / 毫秒 / ISO 字符串 → 毫秒(认不出就 null)。 */
export function parseEventTime (raw, nowMs = Date.now()) {
  if (raw === undefined || raw === null || raw === '') return nowMs
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    // 秒还是毫秒?用"看起来像哪天"来判(与全仓其它地方同一把尺)
    const ms = raw < 1e11 ? raw * 1000 : raw
    return ms
  }
  const s = String(raw).trim()
  if (/^\d+$/.test(s)) return parseEventTime(Number(s), nowMs)
  if (isoLike(s)) {
    const t = Date.parse(s.length <= 10 ? s + 'T00:00' : s.replace(' ', 'T'))
    return Number.isFinite(t) ? t : null
  }
  return null
}

/**
 * 解析一个外部事件体。回 `{ok:true, kind, note, at, sessionId, truncated}` 或 `{ok:false, error}`。
 *
 * 体:`{kind:'arrived-home', text?:'他到楼下了', at?:<秒|毫秒|ISO>, sessionId?:'…'}`
 * `kind` 必填(没有 kind 的事件 = 分不清是谁说的,宁可拒收 —— 拒收要写清理由)。
 */
export function parseExternalEvent (body, nowMs = Date.now()) {
  const b = (body && typeof body === 'object') ? body : {}
  const kind = String(b.kind ?? b.type ?? '').trim()
  if (kind === '') return { ok: false, error: 'bad request: {kind} required' }
  if (kind.length > 60) return { ok: false, error: 'bad request: kind 太长(≤60)' }
  const rawText = String(b.text ?? b.note ?? '').trim()
  const text = rawText.slice(0, EVENT_MAX_CHARS)
  const at = parseEventTime(b.at, nowMs)
  if (at === null) return { ok: false, error: 'bad request: at 认不出来(用 epoch 秒/毫秒或 ISO)' }
  // 过去的时间 ⇒ 就是"现在该响了"(传感器说"他两分钟前到的"也一样立刻唤起)
  const when = Math.max(nowMs, Math.min(at, nowMs + EVENT_MAX_AHEAD_MS))
  // 她读到的那句话:事件名 + 他给的补充(没有补充就只有事件名)
  const note = (text === '' ? kind : kind + '：' + text)
  return {
    ok: true,
    kind,
    note,
    at: Math.round(when / 1000),
    sessionId: String(b.sessionId ?? '').trim(),
    truncated: rawText.length > EVENT_MAX_CHARS
  }
}

/** 事件在账上/日志里的一句话(`why` 用)。 */
export function eventReason (kind) {
  return '外部事件:' + String(kind || '').slice(0, 40)
}
