/**
 * 认账条款:上一条若是**她自己主动说的**,这一轮注入"你刚说过什么"+防火墙。
 *
 * A 侧出处:`main.py:1855-1900 _build_proactive_line`(v8.8.0「主动消息不进对话历史」的根修)。
 * 为什么需要它 —— A 侧原文:
 *   「主动消息经 context.send_message 直发,不进 AstrBot 对话历史,
 *     没有这条她会翻脸不认自己刚说的话。」
 * 措辞逐字照抄,连 `[:80]` 的截断和「刚才 / N分钟前」的分档都一样:
 *
 *   【你刚主动说过】{刚才|N分钟前}你主动说:「{text[:80]}」——这是你亲口说的,
 *   用户现在回应的就是这句话,先对上话头再往下聊;记不起具体细节就如实说
 *   你一直惦记这事,不许否认自己说过,也不许编造细节。
 *
 * 取文本的两条路(A 侧主路径 + 兜底,这里换成 B 侧更结实的两个来源):
 *   1. **主**:本会话 `conversation_log` 最后一行,且它的 `user_text` 是她主动
 *      开口的哨兵 `(她主动开口)` ⇒ 她那一句就在 `reply_text` 里。
 *      A 侧用的是插件内存窗口(重载即丢),B 侧这一行落库、重载不丢 ——
 *      所以这条主路径在 B 比在 A 更靠得住。
 *   2. **兜底**:最近 10 分钟内的审计行里,`tool_call` 非空的那条。A 侧读
 *      `llm_reply`;B 侧的关怀审计行 `llm_reply` 是空的(文字在
 *      `tool_call='relay_proactive'` 那行的 `user_input` 里,带 `[标签] ` 前缀),
 *      所以两列都看,取得到就用。
 *
 * 他回过一轮以后,会话最后一行就变成对话轮 ⇒ 这一行自然消失(A 侧语义:
 * 「她认过账就不再唠叨」)。
 */

/** 时长 → 人话(A 侧同款分档:不足 1 分钟说「刚才」)。 */
export function ageText (ageSec) {
  const min = Math.max(0, Number(ageSec) || 0) / 60
  return min >= 1 ? Math.round(min) + '分钟前' : '刚才'
}

/** 纯渲染(A 侧 `_build_proactive_line` 的返回串,逐字)。 */
export function renderProactiveAckLine (text, ageSec = 0, { maxChars = 80 } = {}) {
  const body = String(text ?? '').trim()
  if (body === '') return ''
  const cut = body.slice(0, Math.max(1, Number(maxChars) || 80))
  return '\n【你刚主动说过】' + ageText(ageSec) + '你主动说:「' + cut + '」'
    + '——这是你亲口说的,用户现在回应的就是这句话,先对上话头再往下聊;'
    + '记不起具体细节就如实说你一直惦记这事,不许否认自己说过,'
    + '也不许编造细节。'
}

/**
 * **只有这些 tool_call 才可能是"她对他开口说过的话"**。
 *
 * 为什么用白名单而不是黑名单(2026-10-10 修):审计表里 `tool_call` 有 40+ 种
 * (工具调用 / 内部观测 / 会话清理 / 并行支…),黑名单**一定会漏** ——
 * 现场就是这么漏进来的:2026-10-09「期 0 并行支观测」新加的
 * `same_turn_emotion` 行也带 `tool_call`,于是兜底把它当成了她说过的话,
 * 渲染出「你刚主动说过:(并行支 same_turn_emotion) 起跑 2026-10-09T16:16:31Z」,
 * 还配上"用户现在回应的就是这句话" —— 而那是一个内部事件。
 *
 * 逐个判过活库里的取值(2026-10-10):
 *   · relay_out / relay_proactive —— 出站,她那句话在 user_input(带 `[标签] ` 前缀)✓
 *   · echo_qq_say                 —— 她用手说,`(用 QQ 说)<正文>` ✓
 *   · echo_wake                   —— 她的闹钟到点开口,`(她自己排了个闹钟)<正文>` ✓
 *   · care                        —— 主动关怀;正文在 llm_reply,缺席时 user_input 只是标记
 * 排除的:`structured_output`(抽取产物)、`extract`(llm_reply 是投递报告不是原话)、
 * `diary`(日记不是对他说的)、`remind`/`wake`/`longing_steer`/`care_silent`(纯内部注记)、
 * `same_turn_emotion`/`query_expand`(并行支观测)以及一切工具调用。
 */
export const SPEAKING_TOOL_CALLS = Object.freeze([
  'relay_out', 'relay_proactive', 'echo_qq_say', 'echo_wake', 'care'
])

/** 去掉审计行里的**内部注记**:`[标签] ` 前缀与 `(……)` 前缀。 */
function stripInternalMarker (s) {
  return String(s ?? '')
    .replace(/^\[[^\]]*\]\s*/, '')      // [QQ:私聊] <正文>
    .replace(/^[（(][^）)]*[）)]\s*/, '') // (用 QQ 说) <正文>
    .trim()
}

/**
 * 审计行里的文字:优先 llmReply,退回 user_input(剥掉内部注记)。
 *
 * ⚠️ 退回 user_input 这一步**不能删**:活库实测 `relay_out` / `relay_proactive` /
 * `echo_qq_say` 三种行的 `llm_reply` **全是空**(58/50/9 行,0 行有值)——
 * 它们的正文就在 user_input 里。删掉退回 = 这三条主路径全废。
 * 真正要挡的是"剥完注记后什么都不剩"的行(纯标记),那才不是她说的话。
 */
function textOfAuditRow (row) {
  const reply = String(row?.llmReply ?? '').trim()
  if (reply !== '') return { text: reply, at: Number(row?.timestamp) || 0 }
  const raw = String(row?.userInput ?? '').trim()
  if (raw === '') return null
  const stripped = stripInternalMarker(raw)
  return stripped === '' ? null : { text: stripped, at: Number(row?.timestamp) || 0 }
}

/**
 * 组装这一轮的认账行(取不到就返回空串 —— 她没主动说过,就不许提)。
 *
 * @param {{store: object, sessionId: string, now?: number, lookbackSec?: number}} args
 *   now 单位是**秒**(与库里的 timestamp 一致)
 */
export function buildProactiveAck ({ store, sessionId, now = 0, lookbackSec = 600, marker = '' } = {}) {
  const sid = String(sessionId ?? '')
  if (sid === '' || store === null || store === undefined) return ''
  const t = Number(now) || Date.now() / 1000
  // ① 主路径:这个会话最后一行对话记录,且她那一句是主动说的
  try {
    if (typeof store.latestConversation === 'function') {
      const last = store.latestConversation(sid)
      if (last !== null && last !== undefined && String(last.userText || '').trim() === String(marker || '')) {
        const text = String(last.replyText || '').trim()
        if (text !== '') return renderProactiveAckLine(text, t - Number(last.createdAt || 0))
      }
    }
  } catch { /* 读不到就走兜底 */ }
  // ② 兜底:最近 10 分钟的审计里,tool_call 非空的那条(她主动开口留下的痕)
  try {
    if (typeof store.listAudit === 'function') {
      const rows = store.listAudit(t - Math.max(60, Number(lookbackSec) || 600), 30) || []
      // B 侧的关怀审计行 session_id 是 'global'(她的心情/主动是"一个人"的状态,
      // 跨会话延续 —— 见 `lib/store.js` 顶部那条约定),所以先按会话认,认不到
      // 再收 'global' 的行:A 侧这条兜底要的是"她刚说过什么",不是"哪条会话说的"。
      // 白名单:只认"她对他开口"的那几种事件。其余(并行支观测 / 工具调用 /
      // 内部注记)一律不看 —— 见 SPEAKING_TOOL_CALLS 的注释。
      const usable = rows.filter((r) => SPEAKING_TOOL_CALLS.includes(String(r.toolCall || '').trim()))
      const hit = usable.find((r) => String(r.sessionId || '') === sid)
        ?? usable.find((r) => String(r.sessionId || '') === 'global')
      const got = textOfAuditRow(hit)
      if (got !== null) return renderProactiveAckLine(got.text, t - got.at)
    }
  } catch { /* 兜底失败就是没有这一行 */ }
  return ''
}
