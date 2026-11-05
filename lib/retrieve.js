/**
 * 情景记忆检索打分 —— JS 侧镜像 `python/engine/retrieve.py:rank_memories`。
 * 纯函数:输入行数组 + 查询串,输出排名结果,不碰数据库。
 * (数据库读写与"被想起来就强化"的回写在 lib/store.js。)
 *
 * 打分 = 相关性(覆盖率) ×1.0 + 可回忆度 R ×0.15 + 情感分 ×0.02
 *
 * RT2(2026-09-27,漏洞①):相关性分从"五档先到先得的关键词字符串包含"换成
 * **正文(摘要 + 关键词)上的 BM25 idf 加权覆盖率**(公式与词元规则见
 * lib/lexical.js,与 Python 侧同源)。旧档位有两个毛病:
 *   (a) 只匹配 `keywords` 字段 —— 抽取器没写进关键词的词**永远搜不到**;
 *   (b) 分数离散(1.0/0.7/0.5/0.3/0.4),同档内分不出"命中 1 个词"与
 *       "命中 5 个词",排序只能靠 R 与情感分,于是新鲜度夺走了主导权。
 *
 * L0 管理(b3 的主题):
 *   - 豁免:身份/称呼/长期偏好不该因为「本轮话题没命中关键词」就消失。
 *   - 强制占位:按内在价值取前 min(L0_ALWAYS_ON_LIMIT, top_k−2) 条,
 *     至少给常规结果留 2 席。
 *   - **强制占位 ≠ 被想起(F5)**:纯靠强制占位进来的 L0 不算被想起
 *     (store.js 据 `forced` 决定是否写回强化)。
 *
 * 差分锚点:与 Python 侧同源同公式(NOW=1700000000 基准行逐点对表)。
 */

import { retrievability, initialHalfLife, DMAE_DEFAULT } from './dmae.js'
import {
  uniqTerms, tokenize, docText, buildIndex, queryTotalIdf, docCoverage,
  nearDupOf, MIN_COVERAGE
} from './lexical.js'

// AstrBot 真值 8(echo_memory_engine L0_ALWAYS_ON_LIMIT);M1 曾误写 4,
// v0.4.3 随 M2-b3 对齐规格书「min(8, top_k−2)」。
export const L0_ALWAYS_ON_LIMIT = 8
export const CANDIDATE_LIMIT = 500

// 总分权重(RT2,与 Python 侧同名同值)。相关性主导;新鲜度只做同档微调;
// 情感是极小的抬升。
export const W_REL = 1.0
export const W_REC = 0.15
export const W_EMO = 0.02

/** 查询分段:中英文标点+空白切词,保留 ≥2 字的段。
 *  RT2 起**不再用于打分**(词元层已由 lexical.tokenize 统一负责),
 *  保留是因为它对"人看的调试输出"仍有用,且差分锚点里两侧都在用它做对照。 */
export function segmentQuery (query) {
  const segs = new Set()
  for (const seg of String(query || '').split(/[，。！？、；：\s"'（）《》,.!?;:()[\]{}]+/)) {
    const s = seg.trim()
    if (s.length >= 2) segs.add(s)
  }
  return segs
}

/** round4(x) —— **必须**与 Python 侧 `retrieve._round4` 同形。

 *  不能用 `Math.round(x*10000)/10000`:它是"五入",而 Python 内置 `round()`
 *  是"四舍六入五取偶"(0.15625 → 0.1562 vs 0.1563)。实测 8 条查询 × 12 行里
 *  **唯一**一处跨语言分歧就是这个平局(scripts/parity-check)。两侧统一成
 *  `floor(x*10000 + 0.5)/10000` —— 都是 IEEE754 double,同一个乘法结果相同,
 *  所以逐位一致。 */
function round4 (x) {
  return Math.floor(x * 10000 + 0.5) / 10000
}

/**
 * 排名 + L0 强制占位(纯函数,不碰库)。`opts.dedupe === false` 时另做近重复抑制。
 *
 * rows: {memoryId, keywords[], summary, emotionScore, timestamp, intrinsicValue,
 *        halfLife, recallCount, lastRecalled, layer, occurredAt, learnedAt,
 *        temporalStatus, source, sourceLabel, actor}
 *
 * RT2/RT3/RT4:
 *   * 相关性 = 正文(摘要 + 关键词)上的 BM25 覆盖率(漏洞①)
 *   * 每条 item 带 `matched`:是否真的命中本轮查询 —— 渲染层靠它区分
 *     "本轮相关"与"只是常在场"(漏洞②)。**L0 豁免与强制占位未改**。
 *   * 末尾近重复抑制(漏洞③);强制占位的 L0 **受保护**,不会被丢掉。
 *
 * ⚠️ `dedupe: false` 是**必须**存在的开关(枚举用途):`memory_forget` 的
 * 「>10 拒绝」保护是**数匹配条数**的,折叠近重复会让 11 条近似记忆变成 1 条、
 * 保护失效。只有**注入**这条路才折叠(默认 true)。
 */
export function rankMemories (rows, query, topK, now = Date.now() / 1000, opts = null) {
  if (!rows || rows.length === 0) return []
  const dedupe = !(opts && opts.dedupe === false)
  const tNow = Number(now)
  const queryTerms = uniqTerms(query)

  // 2026-09-30:写入侧"说法键"是否进打分正文。**默认关**,与 Python 侧
  // `rank_memories(aug_keys=False)` 逐位对齐 —— 两条路同一个默认值,
  // 量台/历史读数才不会被这次改动动到;生产由 turn-snapshot 显式传 true。
  const withAug = !!(opts && opts.augKeys === true)

  // 语料统计整批算一次(候选池即"语料")—— 不能每行重算 df。
  const docs = rows.map((r) => tokenize(docText(r, withAug)))
  const index = buildIndex(docs)
  const totalIdf = queryTotalIdf(index, queryTerms)

  const scored = []
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]
    const docTerms = docs[i]
    // ---- L0 豁免话题过滤 ----
    const isCore = String(row.layer || '') === 'L0'
    const cov = docCoverage(index, docTerms, queryTerms, totalIdf)
    const matched = cov >= MIN_COVERAGE
    if (!matched && !isCore) continue
    let halfLife = Number(row.halfLife) || 0.0
    if (halfLife <= 0) {
      halfLife = initialHalfLife(Number(row.intrinsicValue) || 10.0, DMAE_DEFAULT)
    }
    const last = Number(row.lastRecalled) || Number(row.timestamp) || tNow
    const rNow = retrievability((tNow - last) / 3600.0, halfLife)
    const emo = Number(row.emotionScore) || 0
    const total = W_REL * cov + W_REC * rNow + W_EMO * emo
    // 排序键用**未取整**的 total(与 Python 侧一致:round 只进产物字段)。
    scored.push({
      key: total,
      item: {
        ...row,
        // `hits` 保留旧字段名(工具路径 memory_search 与面板都在读它),
        // 但含义已从"离散档位"变成"连续覆盖率"。
        hits: round4(cov),
        matched,
        rNow: round4(rNow),
        halfLife,
        ageDays: (tNow - (Number(row.timestamp) || 0)) / 86400.0,
        total: round4(total)
      }
    })
  }
  scored.sort((a, b) => b.key - a.key)
  const ranked = scored.map((s) => s.item)

  // ---- L0 强制注入:按内在价值占位,至少给常规结果留 2 席 ----
  //
  // ⚠️ 2026-09-30(与 Python 侧同一刀,实测见 `docs/RETRIEVAL_OPT_2026-09-30.md`):
  // 库里 L0 就 1 条 ⇒ K=5 时那 1 席常驻正好挡掉 N4 知识更新那条金标(常规榜第 5 名)。
  // **常驻块改挂独立区块**(自己的名额,不占证据席位)⇒ 17/21 → 18/21。
  // 默认 **关**(老行为,与 Python 侧一致:引擎默认关、**生产路径显式开**)——
  // 默认开会让历史读数与量台一起漂,那是这个仓最忌讳的"静默改锚点"。
  const coreBlock = !!(opts && opts.coreBlock === true)
  const capK = Math.trunc(Number(topK))
  const coreCap = Math.min(L0_ALWAYS_ON_LIMIT, Math.max(1, capK - 2))
  const forced = ranked
    .filter((it) => it.layer === 'L0')
    .sort((a, b) => (Number(b.intrinsicValue) || 0) - (Number(a.intrinsicValue) || 0))
    .slice(0, coreCap)
  // F5:「被选进强制列表」本身就是强制注入的证据 —— 一律不算被想起。
  // 旧版靠 memoryId 集合反查,新语义下直接标在对象上(与 Python 侧同一立场)。
  for (const it of forced) it.forced = true

  // ---- RT4 去冗余:近重复只留分最高的那条(仅注入用途)----
  // 在"强制 L0 + 常规结果"**合并之后**做 —— 否则同一事实会从两个通道
  // 各进一条。强制占位的 L0 **受保护**(常在场语义优先),只丢常规结果里的
  // 近重复:既去掉冗余,又不吃掉 coreCap 那个保证。
  if (!dedupe) {
    // 枚举用途(关掉去冗余):按旧语义只做 top_k 截断,不折叠。
    const rest = ranked.filter((it) => !it.forced)
    for (const it of rest) it.forced = false
    return coreBlock
      ? [...rest.slice(0, Math.max(0, capK)), ...forced]
      : [...forced, ...rest.slice(0, Math.max(0, capK - forced.length))]
  }
  const kept = coreBlock ? [] : [...forced]
  const keptTexts = forced.map((it) => it.summary)
  const limit = Math.max(0, capK)
  for (const it of ranked) {
    if (it.forced) continue
    if (kept.length >= limit) break
    if (nearDupOf(it.summary, keptTexts)) continue
    it.forced = false
    kept.push(it)
    keptTexts.push(it.summary)
  }
  return coreBlock ? [...kept, ...forced] : kept
}
