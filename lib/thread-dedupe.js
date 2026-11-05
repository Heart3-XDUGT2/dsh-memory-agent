/**
 * 悬置话题的规整与去重(合并脚本用)· JS 镜像
 * ============================================================
 * **权威实现在 `python/engine/threads.py:35-83`**(`_norm_content` +
 * `remember_pending_thread` 的双向包含去重)。本文件是逐字镜像,只服务
 * **离线脚本** —— 合并 A 侧话题时不能借引擎的手(那要现起一个 python
 * worker,而活库上已经有一个在写;一次数据搬迁不该多一个并发写者)。
 *
 * 为什么必须有镜像而不是「随便插进去」:话题是**她主动开口**的燃料。
 * 同一件事存两条 = 她隔两天问你两遍同样的话(`list_due_pending_threads`
 * 按条返回)。所以合并时的去重口径必须与写入时**完全一致**:
 *   ① 空白折叠(任意空白连成一串 → 单空格)+ 300 字硬顶;
 *   ② 全等命中;
 *   ③ **≥6 字**的双向包含命中(「明天要告诉你面试的结果怎么样」 ⊃
 *      「面试的结果怎么样」);< 6 字的短子串**不算**(「面试」太泛)。
 * 夹具与 `python/tests/test_threads.py:34-74` 同一组,两边判定必须一致。
 */

/** 规整上限:与 threads.py `[:300]` 同值。 */
import { similarityOf } from './speech-guard.js'

export const THREAD_NORM_MAX = 300

/** 码点数(python 的 `len()` 是码点,JS 的 `.length` 是 UTF-16 单元)。 */
export function cpLength (text) {
  return Array.from(String(text ?? '')).length
}

/** 码点截断(与 python 切片同语义,emoji 不会切半个)。 */
function cpSlice (text, n) {
  const cp = Array.from(String(text ?? ''))
  return cp.length <= n ? cp.join('') : cp.slice(0, n).join('')
}

/**
 * 空白折叠 + 300 字硬顶(镜像 `threads.py:_norm_content`)。
 * @param {unknown} content
 * @returns {string} 规整后的内容;全空白 → `''`
 */
export function normThreadContent (content) {
  const collapsed = String(content ?? '').split(/\s+/).filter((x) => x !== '').join(' ')
  return cpSlice(collapsed, THREAD_NORM_MAX)
}

/**
 * 在既有 open 话题里找重提命中(镜像 `threads.py:54-75`)。
 * @param {Array<{threadId?: number|string, thread_id?: number|string, content?: string}>} openThreads
 *        调用方需按 `updated_at DESC` 排好并自行限制条数(权威实现是 LIMIT 30)
 * @param {unknown} content 新内容
 * @returns {number} 命中的 thread_id;没命中 → 0
 */
export function matchOpenThread (openThreads, content) {
  const normalized = normThreadContent(content)
  if (normalized === '') return 0
  const low = normalized.toLowerCase()
  for (const row of Array.isArray(openThreads) ? openThreads : []) {
    const id = Number(row?.threadId ?? row?.thread_id ?? 0) || 0
    if (id <= 0) continue
    const cur = String(row?.content ?? '').toLowerCase()
    if (low === cur) return id
    if (cpLength(low) >= 6 && (low.includes(cur) || cur.includes(low))) return id
  }
  return 0
}

// ---- 语义去重(2026-10-06 D4;设计文档 §4.2)------------------------------
// 字面层(matchOpenThread)拦不住"措辞不同的同一件事"。补一层保守的语义判据:
//   同 kind ∧ |created_at 之差| < 48h ∧ 字符二元组 Jaccard ≥ 0.70
// 相似度借 `speech-guard.similarityOf`(**一处实现,不许有两份**),
// 与引擎侧 `python/engine/threads.py:thread_similarity`(dedupe.summary_overlap)
// 同一把尺子(字符二元组 Jaccard)。
//
// 阈值 0.70 是**拿现网 6 组近重复标定出来的**(不是拍脑袋):数据结构组 0.714
// 并得掉;次高 0.412(OJ)、0.25(三公里跑)、0.192(分流)、0.156(重启 web)、
// 0.111(火车)都并不掉;不该并的对照"上周/这周面试" 0.60 也并不掉。
// 数字与理由同时写在引擎侧注释里,`tests/thread-dedupe.test.js` 钉住两边一致。
export const THREAD_SEMANTIC_WINDOW_SEC = 48 * 3600
export const THREAD_SEMANTIC_SIMILARITY = 0.70

/**
 * **判重专用归一**:去空白 + 去标点 + 小写 —— 与引擎侧 `dedupe.norm_text`
 * (`python/engine/dedupe.py:28-39`)逐字对齐。
 *
 * 为什么不能直接用 `normThreadContent`:那只折叠空白、**保留标点** ⇒ 同一对
 * 句子两边算出来的 Jaccard 不一样(实测 0.714 vs 0.667,跨过 0.70 阈值就成
 * "一边并一边不并")。语义层要的是**两侧同一把尺子**。
 */
const PUNCT_RE = /[·・.,,、。:：;；!！?？'"“”‘’()（）[\]【】{}｛｝<>《》\-_/\\|+*&#@~^$%]/g
export function normForSimilarity (text) {
  return String(text ?? '').replace(/\u3000/g, ' ').replace(/\s+/g, '').replace(PUNCT_RE, '').toLowerCase()
}

/**
 * 语义命中:开着的行里有没有"同一件事的另一种说法"。
 * @param {Array<{threadId:number, content:string, kind?:string, createdAt?:number}>} open
 * @param {{content:string, kind?:string, createdAt?:number}} candidate
 * @param {{windowSec?:number, similarity?:number}} [opts]
 * @returns {number} 命中的 `threadId`,没命中 ⇒ 0
 */
export function semanticThreadMatch (open, candidate = {}, opts = {}) {
  const cand = (candidate && typeof candidate === 'object') ? candidate : {}
  const windowSec = Number.isFinite(opts.windowSec) ? Number(opts.windowSec) : THREAD_SEMANTIC_WINDOW_SEC
  const threshold = Number.isFinite(opts.similarity) ? Number(opts.similarity) : THREAD_SEMANTIC_SIMILARITY
  const me = normForSimilarity(cand.content)
  if (me === '') return 0
  const myKind = String(cand.kind ?? '')
  const myCreated = Number(cand.createdAt) || 0
  for (const row of Array.isArray(open) ? open : []) {
    const id = Number(row?.threadId) || 0
    if (id <= 0) continue
    if (String(row?.kind ?? '') !== myKind) continue
    const created = Number(row?.createdAt) || 0
    if (!(Math.abs(created - myCreated) < windowSec)) continue
    const old = normForSimilarity(row?.content)
    if (old === '') continue
    const sim = old === me ? 1 : similarityOf(old, me)
    if (sim >= threshold) return id
  }
  return 0
}
// ---- RT10/C4 话题去重惩罚(出处:Mio :379-432)--------------------------------
// 「检索/开口前,对**刚说过的话题**加惩罚,别复读」。
// 这里先落**纯惩罚器**(可离线测);接线到"开口前挑话题"那一步单独一刀 ——
// 因为那一步挑错了会让她**该说的话不说**,比"多说一句"严重得多。
//
// 与"话题重提合并"(上面的 matchOpenThread)是两件事,别混:
//   · matchOpenThread:新话题**是不是老的**(是 ⇒ 合并,不新开一条);
//   · 本函数:这一拍**该不该再提**(刚提过 ⇒ 降分,给别的候选让位)。
// 相似度直接借 speech-guard 的字符二元组 Jaccard —— **一处实现,不许有两份**。

/** 命中"上一拍刚说过"时,这一拍的分数乘多少(0.5 = 砍一半)。 */
export const TOPIC_REPEAT_PENALTY = 0.5
/** 多像才算"同一个话题"(Jaccard;聊天里的短句,0.6 已经很严)。 */
export const TOPIC_REPEAT_SIMILARITY = 0.6

/**
 * 连说两拍的第二拍:降分。
 * @param {{prevTopics?: unknown[], topic?: unknown, penalty?: number, similarity?: number}} opts
 *        `prevTopics` = **上一拍**已经提过的话题(不是全部历史 —— 只有"刚刚"才算复读)
 * @returns {{score: number, hit: boolean, penalty: number, matched: string}}
 */
export function topicRepeatPenalty ({ prevTopics = [], topic = '', penalty = TOPIC_REPEAT_PENALTY, similarity = TOPIC_REPEAT_SIMILARITY } = {}) {
  const me = normThreadContent(topic)
  const p = Number.isFinite(penalty) && penalty > 0 ? Math.min(1, Number(penalty)) : TOPIC_REPEAT_PENALTY
  const thr = Number.isFinite(similarity) && similarity > 0 ? Math.min(1, Number(similarity)) : TOPIC_REPEAT_SIMILARITY
  if (me === '') return { score: 1, hit: false, penalty: p, matched: '' }
  let best = ''
  let bestSim = 0
  for (const prev of Array.isArray(prevTopics) ? prevTopics : []) {
    const old = normThreadContent(prev)
    if (old === '') continue
    const sim = old === me ? 1 : similarityOf(old, me)
    if (sim > bestSim) { bestSim = sim; best = old }
  }
  const hit = bestSim >= thr
  return { score: hit ? p : 1, hit, penalty: p, matched: hit ? best : '' }
}