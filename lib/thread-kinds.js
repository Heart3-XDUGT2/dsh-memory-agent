/**
 * 悬置话题的类别(2026-10-06 D1;设计文档《悬置话题机制设计》§1)· **JS 镜像**
 * ============================================================
 * **权威实现在 `python/engine/threads.py`**(`THREAD_KINDS` / `KIND_RULES` /
 * `HAS_TIME_RE` / `resolve_thread_kind`)—— 写入路径在引擎侧(`remember_pending_thread`),
 * 本文件是逐条镜像,只服务壳侧需要它的地方(面板/导出/文档/一致性电池),
 * 纪律与 `lib/thread-dedupe.js` 完全同款:两边判定必须一致,否则同一件事
 * 会在两侧被判成两类。
 *
 * 一致性由 `tests/thread-kinds.test.js` 看着:它**从 python/engine/threads.py
 * 正则抠出那三张表**逐条比对(照 `python/tests/test_ddl_parity.py` 抠
 * `lib/store.js` DDL 的先例)—— 改一边不改另一边,灯就红。
 *
 * 语义纪律(设计 §1.3):**确定性规则优先 → LLM 字段兜底 → 认不出回 ''(不猜)**。
 * `''` = 未分类:不参与注入(D3)、冷却期按 7 天(D2)。宁可不分类,也不要猜错。
 */
import { normThreadContent } from './thread-dedupe.js'

/** 允许的类别值(写入时白名单;认不出的值一律当空)。 */
export const THREAD_KINDS = ['promise', 'schedule', 'reminder', 'care', 'topic']

/**
 * 确定性规则(**顺序即优先级**)。与 python 的 `KIND_RULES` 逐字相同。
 * 刻意窄(高精度低召回):宽规则会把 LLM 那一层的判断顶掉。
 * @type {Array<[string, string]>}
 */
export const KIND_RULES = [
  ['reminder', '提醒我|提醒他|提醒她|分钟后|叫我|喊我|别忘'],
  ['schedule', '面试|考试|开会|火车|航班|飞机|车票|到站|出发|返回|回家|去上班|去上课'],
  ['care', '到了之后|顺利|好些|怎么样|问候|平安|注意身体|早点睡|有没有事|还好吗'],
  ['promise', '待会儿|还没|还没有|打算|计划|欠着|要补|补跑|准备|开始学']
]

/** 时间锚:schedule 必须**同时**命中它 + 上表里的动词。与 python 逐字相同。 */
export const HAS_TIME_RE = '今天|明天|后天|大后天|今晚|今早|上午|下午|中午|早上|晚上|凌晨|[0-9]{1,2}点|[0-9]{1,2}月|[0-9]{1,2}日|[0-9]{1,2}号|周[一二三四五六日天]|星期[一二三四五六日天]|下周|下个月'

/** 这个值是不是合法类别。 */
export function isThreadKind (kind) {
  return THREAD_KINDS.includes(String(kind ?? '').trim().toLowerCase())
}

/**
 * 定一条悬置话题的类别(纯函数,永不抛)。镜像 `threads.py:resolve_thread_kind`。
 * @param {unknown} content 话题正文
 * @param {unknown} [llmKind] 模型判的那一版(可为空/不合法)
 * @returns {string} 五个类别之一,或 `''`(未分类,不猜)
 */
export function resolveThreadKind (content, llmKind = '') {
  const text = normThreadContent(content)
  const llm = String(llmKind ?? '').trim().toLowerCase()
  if (text !== '') {
    for (const [kind, pattern] of KIND_RULES) {
      if (!new RegExp(pattern).test(text)) continue
      // 有"回家/面试"这种词但没有时间锚 ⇒ 不当日程(交给 LLM / 留空)
      if (kind === 'schedule' && !new RegExp(HAS_TIME_RE).test(text)) continue
      return kind
    }
    if (new RegExp(HAS_TIME_RE).test(text)) return 'schedule'
  }
  return isThreadKind(llm) ? llm : ''
}
