/**
 * dsh-echo — 命令式提醒识别(v0.14.1 F4)
 * ============================================================
 * A 侧 main.py v8.5.2 的逐字移植:`_REMINDER_CMD_RE`(触发层)+
 * `_extract_reminder_task`(任务抽取)。时间换算**不在这里** ——
 * 那是引擎侧 timeutil.resolve_follow_up_time 的活(单一事实源),
 * 壳只负责认出「这是命令」并把原话交回去。
 *
 * 为什么要有这一层(Judge 已经会登记 pendingThreads 了):
 * Judge 是保守判定引擎,漏登记是它的天性 —— 实测两次漏掉明确的
 * 「提醒我X」,嘴上答应了系统里却没有这条约定,提醒永远不响。
 * 「提醒我X」是**命令**不是判断:命令要确定性执行,触发层不许赌
 * LLM 的心情(A 侧原话:Mio 教训,行为决策层必须确定性)。
 *
 * 换算不出时间就不登记 —— 没有时间的约定归被动提及管,不归主动
 * 提醒(闸在引擎侧:requireTime 项 resolved 为 0 即丢弃)。
 */

/** 触发模式:「提醒我…」「记得叫我…」「别忘了…我」「到点喊我」。 */
export const REMINDER_CMD_RE = /(?:提醒|记得|记着|别忘了|别忘记).{0,8}我|到点.{0,4}(?:喊|叫|催)/

/** 时间短语:相对(「两分钟后」)与绝对钟点(「明晚八点」)。 */
const TIME_PHRASE_RE = new RegExp(
  '(?:半|一|二|两|三|四|五|六|七|八|九|十|\\d+)\\s*个?\\s*'
  + '(?:秒|分钟|分|小时|时|天|日)\\s*(?:钟)?\\s*(?:以)?后'
  + '|(?:今晚|明晚|今天|明天|后天)?\\s*\\d{1,2}\\s*[点时:：]\\s*(?:半|\\d{1,2})?'
)

/**
 * 从「echo,提醒我两分钟后去洗澡」里抠出任务短语「洗澡」;抠不出返回空串。
 * 策略照抄 A:砍唤醒前缀 → 找时间短语 → 取其后的话 → 剥命令动词。
 * 抠不出时由调用方用整句兜底(组稿时她自会润色,兜底句也能读懂)。
 */
export function extractReminderTask (text) {
  const t = String(text || '').trim().replace(/^\s*\S{1,12}[,，]\s*/, '')
  const m = TIME_PHRASE_RE.exec(t)
  let tail = ''
  if (m !== null && m.index + m[0].length < t.length) {
    tail = t.slice(m.index + m[0].length).trim().split(/[,，。!！?？]/)[0]
  }
  tail = tail
    .replace(/^[,，。!！?？、\s]*(?:提醒|记得|记着|别忘了?|到点|帮我|给我|帮|给|喊|叫|催|我|去)+/, '')
    .trim()
  return tail.slice(0, 80)
}

/**
 * 识别一条用户消息里的提醒命令。
 * @returns {task, raw} | null —— task 是任务短语(抠不出回落整句前 120 字),
 *   raw 是原话(交给引擎侧解析时间,壳不碰时间语义)。
 */
export function detectReminder (text) {
  const raw = String(text || '').trim()
  if (raw === '' || !REMINDER_CMD_RE.test(raw)) return null
  const task = extractReminderTask(raw)
  return { task: task !== '' ? task : raw.slice(0, 120), raw }
}
