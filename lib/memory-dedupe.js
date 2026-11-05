/**
 * 记忆近重复判定(M3)· JS 镜像
 * ============================================================
 * **权威实现在 `python/engine/dedupe.py`**(写入闸在引擎侧,她落库那一刻
 * 就要判)。本文件是逐字镜像,只服务离线脚本(memory-doctor 体检、
 * memory-dedupe 一次性清理)—— 离线清理要在**不启动 worker** 的情况下
 * 跑,所以不能借引擎的手。两份必须同参同式,任何改动两边一起改,
 * `python/tests/test_dedupe.py` 与 `tests/dedupe.test.js` 用**同一组
 * 夹具**钉住(同一对句子在两边的判定必须一致)。
 *
 * 为什么需要它(2026-09-25 实测):去重键 = `slot || field`
 * (`judge.py:327`),而 L2 没有 field、slot 由模型自由命名(同一件事
 * 写成 food_preference 与 preferred_food),导入行与反思行**键全空**
 * ⇒ 活库 7 条 L0 在说同一件事。所以除了「同键同句」,还要一道
 * **换说法的近似判定**。
 *
 * 判据(保守):
 *   同层(layer 相同)+ (关键词 Jaccard ≥ 0.6 或 摘要双字重合 ≥ 0.7)
 * 两条阈值都可通过 `dedupeSimilarity` / `dedupeSummarySimilarity` 覆盖,
 * **0 = 关闭**(回到今天的「同键同句才算想起」)。
 */

export const DEDUPE_DEFAULTS = Object.freeze({
  kwThreshold: 0.6,
  summaryThreshold: 0.7,
  // 关键词一致时还要求的**摘要下限**(镜像 python/engine/dedupe.py):
  // 单靠关键词一致不够 —— 「他的第 N 只猫」11 条关键词完全相同。
  summaryFloor: 0.35
})

/** 关键词:接受 JSON 字符串或数组,归一后去重去空。 */
export function keywordList (raw) {
  let arr = raw
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw)
      arr = Array.isArray(parsed) ? parsed : [raw]
    } catch { arr = raw.split(/[,，、\s]+/) }
  }
  if (!Array.isArray(arr)) arr = []
  const out = []
  const seen = new Set()
  for (const item of arr) {
    const k = String(item ?? '').trim().toLowerCase()
    if (k === '' || seen.has(k)) continue
    seen.add(k)
    out.push(k)
  }
  return out
}

/** 归一化文本(判重专用):NFKC + 去空白标点。 */
export function normText (text) {
  return String(text ?? '')
    .normalize('NFKC')
    .replace(/[\s\u3000]+/g, '')
    .replace(/[·・.,,、。:：;；!！?？'"'"“”‘’()（）[\]【】{}｛｝<>《》\-_/\\|+*&#@~^$%]/g, '')
    .toLowerCase()
}

export function jaccard (a, b) {
  const A = a instanceof Set ? a : new Set(a ?? [])
  const B = b instanceof Set ? b : new Set(b ?? [])
  if (A.size === 0 || B.size === 0) return 0
  let inter = 0
  for (const x of A) if (B.has(x)) inter += 1
  return inter / (A.size + B.size - inter)
}

/** 双字滑窗字符集:中文摘要的「换说法但讲同一件事」判据。 */
export function bigrams (text) {
  const s = normText(text)
  const out = new Set()
  if (s.length < 2) {
    if (s.length === 1) out.add(s)
    return out
  }
  for (let i = 0; i + 2 <= s.length; i += 1) out.add(s.slice(i, i + 2))
  return out
}

export function summaryOverlap (a, b) {
  return jaccard(bigrams(a), bigrams(b))
}

/**
 * 读侧层归一:**空层当作 L2**。
 *
 * 为什么(2026-10-10):judge 的降级路径此前没给 `insert_memory` 传 layer
 * ⇒ 吃默认 `layer=""` ⇒ 活库积了 47 行空层(source='private')。写入侧已修
 * (python/engine/judge.py 降级路径补传 layer="L2"),**不再增长**;
 * 但历史数据**不动** —— 于是读侧把 '' 与 'L2' 视为同层,让那 47 行重新
 * 能被去重命中(与 Python 侧 `dedupe.normalize_layer` 口径逐字对齐)。
 *
 * 为什么等价:`''` 与 `'L2'` 在判据里行为一致 —— `lib/retrieve.js:103`
 * 只豁免 `'L0'`;`dmae` 侧两者同落 tier=0.15 的 else 分支。
 *
 * ⚠️ 只把空/None 归到 `'L2'`;`'L0'` / `'L1'` 原样保留 ——
 * 空层**不是**「任意层」,不能拿它去撞 L0。
 */
export function normalizeLayer (layer) {
  const s = String(layer ?? '').trim().toUpperCase()
  return s === '' ? 'L2' : s
}

/** 层归一(行对象入口)。 */
function layerOf (row) {
  return normalizeLayer(row?.layer)
}

/** 把数字统一成 # 后的签名 —— 用来识别「只在数字上不同」的句子。 */
export function digitSig (text) {
  return normText(text).replace(/\d+/g, '#')
}

/**
 * 近重复判定。**同层**是硬前提 —— L0(身份画像)与 L2(片段)永不同判。
 * 判据(故意保守,宁可漏合不可错合):
 *   ① 只在数字上不同 → 不是重复(「第1只猫」与「第2只猫」是两件事)
 *   ② 摘要双字重合 ≥ summaryThreshold → 是
 *   ③ 关键词 Jaccard ≥ kwThreshold **且** 摘要重合 ≥ summaryFloor → 是
 * 阈值为 0 = 关闭该判据;两个阈值都为 0 = 完全关闭。
 * @param {object} a @param {object} b
 * @param {{kwThreshold?: number, summaryThreshold?: number, summaryFloor?: number}} [opts]
 */
export function isNearDuplicate (a, b, opts = {}) {
  const kwT = opts.kwThreshold ?? DEDUPE_DEFAULTS.kwThreshold
  const sumT = opts.summaryThreshold ?? DEDUPE_DEFAULTS.summaryThreshold
  const floor = opts.summaryFloor ?? DEDUPE_DEFAULTS.summaryFloor
  if (kwT <= 0 && sumT <= 0) return false
  if (layerOf(a) !== layerOf(b)) return false
  if (String(a?.status ?? 'active') !== String(b?.status ?? 'active')) return false
  const sa = a?.summary
  const sb = b?.summary
  const na = normText(sa)
  const nb = normText(sb)
  if (na !== '' && nb !== '' && na !== nb && digitSig(sa) === digitSig(sb)) return false
  const overlap = summaryOverlap(sa, sb)
  if (sumT > 0 && overlap >= sumT) return true
  const kwHit = kwT > 0 && jaccard(keywordList(a?.keywords), keywordList(b?.keywords)) >= kwT
  return kwHit && overlap >= floor
}

/**
 * 聚类(并查集):返回 ≥2 行的重复组,组内按 survivor 优先排序。
 * @param {Array<object>} rows 需带 memoryId/layer/keywords/summary/status/intrinsicValue/learnedAt
 * @param {{kwThreshold?: number, summaryThreshold?: number}} [opts]
 */
export function findDuplicateGroups (rows, opts = {}) {
  const list = Array.isArray(rows) ? rows : []
  const parent = list.map((_, i) => i)
  const find = (i) => {
    let r = i
    while (parent[r] !== r) r = parent[r]
    while (parent[i] !== r) { const next = parent[i]; parent[i] = r; i = next }
    return r
  }
  const union = (i, j) => {
    const a = find(i); const b = find(j)
    if (a !== b) parent[b] = a
  }
  for (let i = 0; i < list.length; i += 1) {
    for (let j = i + 1; j < list.length; j += 1) {
      if (isNearDuplicate(list[i], list[j], opts)) union(i, j)
    }
  }
  const buckets = new Map()
  for (let i = 0; i < list.length; i += 1) {
    const root = find(i)
    if (!buckets.has(root)) buckets.set(root, [])
    buckets.get(root).push(list[i])
  }
  const groups = []
  for (const members of buckets.values()) {
    if (members.length < 2) continue
    groups.push(pickSurvivor(members, opts))
  }
  return groups
}

/**
 * 选 survivor:**I 最高优先**(长期价值优先),平手看 learnedAt 更近,
 * 再平手看 memoryId 更大。`rule: 'recent'` 可切到「最近优先」。
 * @returns {{survivor: object, losers: Array<object>, members: Array<object>}}
 */
export function pickSurvivor (members, opts = {}) {
  const rule = opts.survivorRule ?? 'value'
  const list = [...(Array.isArray(members) ? members : [])]
  const num = (v) => Number(v) || 0
  list.sort((x, y) => {
    if (rule === 'recent') {
      if (num(y.learnedAt) !== num(x.learnedAt)) return num(y.learnedAt) - num(x.learnedAt)
      if (num(y.intrinsicValue) !== num(x.intrinsicValue)) return num(y.intrinsicValue) - num(x.intrinsicValue)
    } else {
      if (num(y.intrinsicValue) !== num(x.intrinsicValue)) return num(y.intrinsicValue) - num(x.intrinsicValue)
      if (num(y.learnedAt) !== num(x.learnedAt)) return num(y.learnedAt) - num(x.learnedAt)
    }
    return num(y.memoryId) - num(x.memoryId)
  })
  return { survivor: list[0], losers: list.slice(1), members: list }
}
