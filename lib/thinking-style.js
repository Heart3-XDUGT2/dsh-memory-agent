/**
 * C2 思考风格双档 —— 干活时中立,跟她说话时角色化。
 *
 * 出处:`dsh-cosplay` 的 `THINKING_DIRECTIVES`(neutral / role 两套思维链指令,
 * 追加在 persona 末尾,`store.js:142-145`)。作者自己注明了两个弱点:系统提示位
 * 比模型训练位弱、而且是**概率触发**(`store.js:139-141`)—— 我们不假装比它强,
 * 所以这一条只做**最小剂量**:干活那一步加一行,**其余一个字不加**。
 *
 * ⚠️ 本仓有一条疤,必须写在这里:2026-09-26 晚我们试过在**尾部**贴一张"开口前自检"
 * 清单(`echo:voice`,order 10280),量出来的结果是 —— 她真发出的 8 条里「～」仍 0%、
 * 「主人」0%,句长反而变长,而她**思考(reasoning)里**「像 Echo 吗」「人格规则」
 * 「防漂移/自检」的提及率从 9%/4%/0% 升到 **25%/25%/25%**。他看她的感觉就是
 * 「演」和「怪」。那条段当天就撤了(见 `lib/index.js:1410-1425`)。
 *
 * ⇒ 所以这里三条自律:
 *   ① **不是自检表**:只说"这一步是干活,用中性思考",绝不提醒她"你在扮演";
 *   ② **只在干活那一步出现**(本轮真用过宿主工具),聊天轮一个字不加 —— 他读她
 *      语气的时刻,不受这段影响;
 *   ③ **有开关**(`thinkingNeutralWhenWorking`),而且关掉 = 回到今天的行为。
 */

/** 默认:本轮用过 ≥1 件宿主工具就算"干活"。 */
export const THINKING_DEFAULT_MIN_TOOLS = 1

/** 多步轮到这个步数,即使还没调工具也算长任务。 */
export const LONG_TASK_STEP = 3

export const STYLE_ROLE = 'role'
export const STYLE_NEUTRAL = 'neutral'

/**
 * 干活档那一行。**一句话,不列清单,不提问句** —— 问句会让她在思考里自问自答
 * (那正是"演"的来源)。
 */
export const NEUTRAL_THINKING_LINE = '[干活档] 这一步是干活,不是聊天:思考直白、就事论事,把事办成最要紧;'
  + '汇报用最短的话说清结果,语气留到跟你说话的时候再拿回来。'

/**
 * 挑档(纯函数)。返回 `'neutral' | 'role'`。
 *
 * 判据只两条,都来自"这一步到底在干嘛":
 *   · `toolCallsThisTurn >= minTools` ⇒ 干活;
 *   · `step >= LONG_TASK_STEP` ⇒ 长任务(多步轮,哪怕还没调工具)。
 *
 * **坏输入一律回落角色档**(fail-safe):认不出来就当她在聊天,不加任何字。
 * `force` 只为测试与排错留(`'neutral'` / `'role'` 之外的值忽略)。
 */
export function pickThinkingStyle ({
  enabled = true,
  toolCallsThisTurn = 0,
  step = 1,
  minTools = THINKING_DEFAULT_MIN_TOOLS,
  longTaskStep = LONG_TASK_STEP,
  force = null
} = {}) {
  if (force === STYLE_NEUTRAL || force === STYLE_ROLE) return force
  if (enabled !== true) return STYLE_ROLE
  const tools = Number(toolCallsThisTurn)
  if (Number.isFinite(tools) && tools >= minTools && tools > 0) return STYLE_NEUTRAL
  const st = Number(step)
  if (Number.isFinite(st) && st >= longTaskStep) return STYLE_NEUTRAL
  return STYLE_ROLE
}

/** 档 ⇒ 要追加的那一行(角色档 = 空串:一个字不加)。 */
export function thinkingLine (style) {
  return style === STYLE_NEUTRAL ? NEUTRAL_THINKING_LINE : ''
}

/** 一步到位:给状态,拿那一行(`''` = 不加)。 */
export function thinkingText (state = {}) {
  return thinkingLine(pickThinkingStyle(state))
}
