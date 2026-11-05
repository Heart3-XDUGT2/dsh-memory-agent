/**
 * 主动性 v2 · 边缘区**模型复核**(2026-09-30 P2,施工图 §3.5 决定①)
 * ============================================================
 * 这是折中方案的"贵"那一半:本地分先跑,**只有落进边缘区**
 * (`|score - threshold| <= reviewDelta`)才花**一次**模型复核。
 *
 * 三条硬约束(一条都不许松):
 *   ① **唯一允许的新增模型调用点** —— 而且它只决定"说**不说**",
 *      开口仍复用 `heartbeat.js` 的 `deliver`(**绝不新增第二个开口调用点**);
 *   ② 受**日额度** `reviewBudgetPerDay` 约束(额度用完 ⇒ 按本地分判,不许硬说);
 *   ③ 输入**只给候选话题 + 最近上下文摘要,不给全文**(省 token + 不泄隐私)。
 *
 * 失败与超时一律**视为未过**(沉默是合法结果,施工图 §7「不为了主动而主动」)。
 * 超时写法**复用** `lib/emotion-score.js:227 scoreOnce` / `lib/query-expand.js:98
 * expandOnce` 的 `Promise.race` 降级形状 —— 不另造一套。
 *
 * 本文件是**纯逻辑**(零 IO、零宿主依赖):`run` 由调用方注入 ⇒ 离线可测。
 */

/** 复核等多久(毫秒)。它挡在开口之前,不许把她的开口拖成"等模型的回复"。 */
export const REVIEW_DEFAULT_TIMEOUT_MS = 4000
export const REVIEW_MIN_MS = 500
export const REVIEW_MAX_MS = 15000

/** 结构化输出的 schema(宿主 `runStructured` 契约)。 */
export const REVIEW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    speak: { type: 'boolean', description: '这句话现在值不值得说出口' },
    why: { type: 'string', description: '一句话理由(给台账看,不要写给人看的长文)' }
  },
  required: ['speak']
}

export function clampReviewTimeoutMs (v) {
  const n = Number(v)
  if (!Number.isFinite(n) || n <= 0) return REVIEW_DEFAULT_TIMEOUT_MS
  return Math.max(REVIEW_MIN_MS, Math.min(REVIEW_MAX_MS, Math.round(n)))
}

/**
 * 组复核的输入。**只给候选话题 + 最近上下文摘要**:
 *   · `candidate.text` 截到 120 字(够判断"值不值得说",不够泄露一整篇);
 *   · `context` 是调用方给的**摘要行**(她自己上一句 / 上次聊到的题目),
 *     同样逐行截断;
 *   · 全程不给任何"记忆全文 / 日记全文"。
 */
export function reviewPrompt ({ candidate = null, context = '', threshold = 0, score = 0 } = {}) {
  const text = String(candidate?.text ?? '').slice(0, 120)
  const ctx = String(context ?? '').split('\n').map((l) => l.trim()).filter((l) => l !== '').slice(0, 3)
  const lines = [
    '你是"她该不该现在主动开口"的复核员。本地打分刚好卡在分数线附近,需要你判一句。',
    '(只判"说不说";具体怎么说由她自己决定,不要替她写台词。)',
    '',
    '候选话题:' + text,
    '本地分:' + Number(score || 0).toFixed(3) + '(线 ' + Number(threshold || 0).toFixed(2) + ')',
    '最近上下文:' + (ctx.length === 0 ? '(无)' : ctx.join(' / ')),
    '',
    '请判断:**这句话值得现在主动对他说出口吗?**',
    '判据(按重要性):① 这话对他有没有真实内容(不是"我想你了"式的空话);',
    '② 现在说合不合时机(他刚走开/刚说完就不必追);③ 会不会像在催他回应。',
    '拿不准就判**不说** —— 沉默不扣分,硬说才扣分。',
    '',
    '只输出 JSON:{"speak": true|false, "why": "一句话"}'
  ]
  return lines.join('\n')
}

/**
 * 清洗模型产出:`{speak, why}`。
 * **认不出 = 未过**(`speak:false`)—— 坏输出绝不许变成"她说了一句"。
 */
export function parseReview (raw) {
  const o = (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) ? raw : null
  if (o === null) return { speak: false, why: 'unparsed' }
  if (o.speak !== true && o.speak !== false) return { speak: false, why: 'unparsed' }
  return { speak: o.speak === true, why: String(o.why ?? '').slice(0, 120) }
}

/**
 * 一次复核 = **赛跑**(纯逻辑,`run` 注入)。
 * 赢: `{ok:true, speak, why}`;超时 / 失败 / 认不出: `{ok:false, ...}`(**都不说**)。
 */
export async function reviewOnce ({ run, candidate = null, context = '', threshold = 0, score = 0, timeoutMs = REVIEW_DEFAULT_TIMEOUT_MS, parent = null, now = () => Date.now() } = {}) {
  const t0 = now()
  const ms = (r) => ({ ...r, ms: Math.max(0, now() - t0) })
  if (typeof run !== 'function') return ms({ ok: false, speak: false, why: 'no-run', timedOut: false })
  let timer = null
  try {
    const raced = await Promise.race([
      Promise.resolve()
        .then(() => run(reviewPrompt({ candidate, context, threshold, score }), REVIEW_SCHEMA, parent))
        .then((out) => ({ kind: 'done', out }))
        .catch((err) => ({ kind: 'failed', err })),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve({ kind: 'timeout' }), clampReviewTimeoutMs(timeoutMs))
        try { if (typeof timer?.unref === 'function') timer.unref() } catch { /* 测试替身没有 unref */ }
      })
    ])
    // ⚠️ 超时 = **未过**(沉默),不是"用本地分硬说"(施工图 §3.5 原话)
    if (raced.kind === 'timeout') return ms({ ok: false, speak: false, why: 'timeout', timedOut: true })
    if (raced.kind === 'failed') return ms({ ok: false, speak: false, why: 'failed', timedOut: false })
    const verdict = parseReview(raced.out)
    return ms({ ok: true, speak: verdict.speak, why: verdict.why, timedOut: false })
  } catch {
    return ms({ ok: false, speak: false, why: 'failed', timedOut: false })
  } finally {
    if (timer !== null) { try { clearTimeout(timer) } catch { /* 清不掉也无害 */ } }
  }
}
