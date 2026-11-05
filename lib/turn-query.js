/**
 * 这一轮该拿什么去检索记忆(2026-09-26 修,他问「上下文注入是不是没注入角色人格」)。
 *
 * 现场:QQ 上跟她说的每一句(以及她每次主动开口)**记忆都没注入** —— 审计里
 * `injected_memories` 是空的,而本地窗口那些轮次是 1700~2200 字节。他先看出来
 * 不对劲,问的是人格;查下来人格没问题(它走 systemPrompt 段,按会话判定,与
 * 查询词无关),**漏的是记忆/画像这一整块**。
 *
 * 根因在 index.js 的判断:`source.kind !== 'user'` 就跳过 —— 那是宿主自己造的
 * 「真人在键盘上打的字」。而桥注入的那条是插件来源(旧 `kind:'plugin'`;0.2.0-rc
 * 起升级为产出者自有形状 `'plugin:dsh-echo'`),于是 query 为空,
 * pre-step 在检索之前就 early-return 了。可桥注入的那条**就是他打的话**,只是
 * 经了插件的手;「只有本窗口里打的字才算数」恰恰是 2026-09-26 他拍掉的那个口径
 * (射程只看这个会话里插件开没开,不看别的)。
 *
 * 两条纪律:
 *   1. **绝不拿我们自己的注入当查询词** —— `form:'snapshot'` 是记忆块本身,
 *      让它回头检索自己会把噪声越滚越大;
 *   2. 他发图不写字时(`rawText` 空)**不拿带包装的正文当查询词**
 *      (「【QQ·私聊】…说:」「(回他请用 echo_qq_say…)」是框架不是他的话),
 *      而是回退到该批次里**上一条**有字的话 —— 「他刚发的那张图」的语境,
 *      本来就是上一条话。
 *
 * 注(2026-09-26 当晚):那条逐轮工具指令已按他的裁定从注入里去掉了,但**剥壳
 * 逻辑保留** —— 老会话的历史里还带着它,而且剥壳本身是"绝不拿框架当查询词"的
 * 纪律,不依赖那句指令是否存在。
 *
 * ── 2026-09-27 F9:宿主噪声也走这道门 ───────────────────────────────
 * 审计对出来的「串味」:22 条 extract 里 3 条的 `user_input` 是
 * `Current runtime context…` / `<goal_complete>…` / `[model changed…]`
 * —— **DSH 的运行时快照与子代理通告被当成"用户输入"参与了检索**。
 *
 * 漏点就在下面这个循环:宿主注入的那些是 `source.kind === 'user'`(宿主眼里
 * 它就是"用户这一轮的输入"),于是 `humanTurn` 放行、`textOf(m)` 拿到正文、
 * 直接成了查询词。所以这里追加 `isHumanUtterance` —— 与捕获层**同一份判据**,
 * 不另起一套(两套判据迟早会分叉)。
 *
 * 代价照旧是「这一轮她没记」:整批都是噪声时查询为空,调用方跳过注入。
 */

import { isHumanUtterance } from './inbound-filter.js'
import { isHumanForm } from './speak.js'
// 2026-10-03:注入的形状在 0.2.0-rc 换成"产出者自有"kind(`plugin:dsh-echo`)——
// 用容错判定(新旧都认),别把桥注入的那句"他的话"漏成空查询词。
import { isEchoSource } from './source-kind.js'

/**
 * 一条消息是不是「他的话」这一轮的入口。
 * S1-b:改问 `isHumanForm()`(lib/speak.js)—— 判据归一成渠道无关枚举,
 * 旧值 `'relay'` 仍是别名,所以今天的行为逐字不变(原集合就是 {'relay','care'})。
 * @param {object|undefined} source 消息的 source 字段
 * @returns {{kind:'user'|'relay'|'care', rawText:string}|null} 不是就返回 null
 */
export function humanTurn (source) {
  if (source === null || typeof source !== 'object') return null
  if (source.kind === 'user') return { kind: 'user', rawText: '' }
  if (isEchoSource(source) && isHumanForm(source.form)) {
    return { kind: String(source.form), rawText: String(source.rawText ?? '') }
  }
  return null
}

const textOf = (msg) => {
  const blocks = msg?.content
  if (!Array.isArray(blocks)) return ''
  return blocks
    .filter((b) => b !== null && typeof b === 'object' && b.type === 'text')
    .map((b) => String(b.text || ''))
    .join('\n')
}

/**
 * 本步进入批里最新的「他的话」(检索查询)。
 * @param {Array} messages 进入批(decision.messages)
 * @returns {string} 检索查询词;没有就返回空串(调用方据此跳过注入)
 */
export function latestDirectUserText (messages) {
  let text = ''
  if (!Array.isArray(messages)) return ''
  for (const m of messages) {
    if (m?.role !== 'user') continue
    const src = humanTurn(m.source)
    if (src === null) continue
    // 桥/心跳注入的那条:用**他打的原话**(rawText);发图没写字就跳过这条,
    // 让循环继续往前找上一条有字的话。
    const t = (src.rawText !== '' ? src.rawText : (src.kind === 'user' ? textOf(m) : '')).trim()
    if (t === '') continue
    // F9:宿主注入(运行时快照 / 目标信封 / 换模型通告…)长得像"用户输入",
    // 但不是他说的话 —— 拿它当查询词就会把整条管线带进沟里。
    if (!isHumanUtterance(t)) continue
    text = t
  }
  return text
}
