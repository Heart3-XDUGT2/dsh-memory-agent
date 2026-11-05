/**
 * 词元层与文本相似度原语(RT1 的 JS 侧镜像)—— 检索打分的确定性基础,零依赖、无 LLM。
 *
 * 与 `python/engine/lexical.py` **同源同规则**(差分锚点逐点对表,见 RT6):
 *   normalize(text)       NFKC + 小写
 *   tokenize(text)        CJK 连续段切**单字与二字组合都产出**(段内另保留 2~16 字整串)
 *                         + Latin/数字/标识符整词
 *   docText(row)          打分用正文 = summary + keywords
 *   buildIndex(docs)      BM25 需要的 df / avgdl / N
 *   docCoverage(...)      单文档对查询的 **idf 加权覆盖率** ∈ [0,1]
 *   charBigrams/jaccard   近重复判定(去冗余用)
 *
 * ## 为什么这么做(依 Python 侧实测依据)
 *
 * * **只用关键词字段匹配 ⇒ 抽取器没写的词永远搜不到** —— 这是"信息不在索引里",
 *   不是"算法不够好"。所以打分要索引**正文**(摘要 + 关键词两样都要:keywords 里
 *   有 `episodic.derive_keywords` 产的 CJK 二元滑窗,那是短查询的主力)。
 * * CJK 没有空格:`unicode61` 之类分词器对中文**返回 0 命中**。二字组合是零依赖
 *   里唯一既能召回又不误召的切法。
 * * **二字组合必须配停用词**:不加时「他上的什么学校」会靠 `什么`/`为什` 命中一堆
 *   无关记忆。
 * * **单字必须产**:只产二字的话,查询「猫」匹配不到文档「他喜欢猫」
 *   (边界二字 `于猫`/`猫吗` 与文档里的 `欢猫` 不同 ⇒ 0 命中),这是 CJK 二元索引
 *   的经典缺陷;Lucene 的 CJKAnalyzer 也是 unigram + bigram 都产。单字噪声由两层
 *   压住:STOPWORDS 滤掉虚词(的/了/吗/他/我…),idf 让常见字权重自然变低。
 *
 * ⚠️ **已知刻意偏差**:Python 用 `casefold()`,JS 用 `toLowerCase()`(规格指定)。
 * 对 `ß`/`İ` 这类字符两者结果不同 —— 中文与常见拉丁文本上等价,这里记明。
 */

import { existsSync, readFileSync, statSync } from 'node:fs'
import { resolveDataFilePath } from './data-dir.js'

// ---- 切分原语 ----
// CJK 统一表意文字(含扩展 A / 兼容区)。刻意不含标点 —— 标点由 normalize 之后的
// 非字母数字边界自然断开(findall 本就不含标点)。
const CJK_RUN_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+/g
const LATIN_RE = /[a-z0-9._\-/+]+/g

// ---- BM25 常数(文献值,不是拟合值)----
export const BM25_K1 = 1.2
export const BM25_B = 0.75

// 覆盖率下限:低于它视为"没命中"。挡的是"只命中一个极常见词"的伪命中
// (例:查询与某条记忆只共享 `什么`)。0 = 关闭(纯看有无重叠)。
export const MIN_COVERAGE = 0.10

// 近重复阈值:字符二字 Jaccard ≥ 它视为同一事实。手调值,由测台扫曲线后再定(RT4)。
export const DEDUPE_THRESHOLD = 0.55

// 判重的最小文本长度(去空白后)。短于此长度不参与判重 —— 短串的二字
// Jaccard 极不稳定(见 nearDupOf 的说明)。
export const DEDUPE_MIN_CHARS = 12

// ---- 停用词(保守:只收功能词与疑问词)----
// ★ P1b(2026-10-05,模块7):这张表是**语言默认表**(中文功能词,不是个人数据)——
//   设计文档 row 12 明说"空 ⇒ 语言默认表(非个人,**可留程序作兜底**)",所以他没在
//   数据文件里填 stopwords 时,行为与 P1b 之前**一个字不变**;他若填了
//   `<数据目录>/lexicon.json` 的 `stopwords`,就**以数据为准**(覆盖这张表)。
//   读点见 `loadStopwords` / `stopwordsOf`。
// 与 python/engine/lexical.py 的 STOPWORDS **逐字一致**(表里的重复项也照抄,
// 集合语义下无影响)。注意 tokenize 产出的是**二字组合**,所以表里以二字形式为主
// (「为什」必须收:「为什么你不主动关怀我」靠它命中)。
// 单字(吗/呢/的/了/他/我/你…)不必列 —— 单字 CJK 噪声大,列着无害,只是留个说明。
export const STOPWORDS = new Set(`
为什么 怎么 怎么样 怎样 为什 什么 怎么 么样 怎样 是不 不是 有点 有点
那边 这边 那里 这里 哪里 一个 一下 一起 时候 多少 几点 哪个 哪些 干嘛 为啥
我们 你们 他们 她们 咱们 人家 自己 这样 那样 这些 那些 这个 那个
没有 就是 还是 一直 已经 正在 因为 所以 但是 而且 然后 如果 可以 应该
只是 不过 其实 真的 好像 觉得 知道 告诉我 有没有 是不是 好不好
吗 呢 吧 啊 呀 哦 嗯 哈 诶 唉 的 了 着 过 他 她 我 你 它 您 和 与 及
在 是 有 不 没 这 那 就 都 也 很 太 还 才 又 再 只 被 把 给 让 对 从 到
向 为 以 于 而 且 或 但 却 因 所 要 会 能 想 说 个 些 之 其 等 把 来 去
`.split(/\s+/).filter((w) => w !== ''))

/**
 * 读 lexicon.json 的 stopwords(只读、缺文件/坏文件 ⇒ 空表,**永不抛**)。
 * @param {string|null} [path]
 */
export function loadStopwords (path = resolveDataFilePath('lexicon.json')) {
  try {
    if (path === null || path === undefined || !existsSync(path)) return []
    const raw = JSON.parse(readFileSync(path, 'utf8'))
    const out = []
    for (const w of Array.isArray(raw?.stopwords) ? raw.stopwords : []) {
      if (typeof w !== 'string') continue
      const s = w.trim()
      if (s !== '') out.push(s)
    }
    return out
  } catch { return [] }
}

/**
 * tokenize 该用哪张停用词表:数据文件里有就用它,没有就回**语言默认表**(STOPWORDS)。
 *
 * 缓存按 `mtime + size` 失效 ⇒ 他改了 lexicon.json **落盘即生效**,
 * 又不至于每次 tokenize 都解析一遍 JSON(它是检索热路径上的函数)。
 */
let stopwordsCache = null
export function stopwordsOf (path = resolveDataFilePath('lexicon.json')) {
  if (path === null || path === undefined) return STOPWORDS
  try {
    const st = statSync(path)
    if (stopwordsCache !== null && stopwordsCache.path === path
      && stopwordsCache.mtimeMs === st.mtimeMs && stopwordsCache.size === st.size) {
      return stopwordsCache.set
    }
    const words = loadStopwords(path)
    const set = words.length > 0 ? new Set(words) : STOPWORDS
    stopwordsCache = { path, mtimeMs: st.mtimeMs, size: st.size, set }
    return set
  } catch { return STOPWORDS }   // 文件不在/读不动 ⇒ 语言默认表
}

/** 清缓存(测试与新装数据目录后的显式失效口;正常靠 mtime 自动失效)。 */
export function resetStopwordsCache () {
  stopwordsCache = null
}

/**
 * NFKC 归一 + 小写。
 *
 * NFKC 把全角/兼容字符折叠成标准形(「Ａ」「①」「３ｋｍ」→ `A`/`1`/`3km`),
 * 否则同一条记忆的同一件事会因为输入法差异切成不同的词元。
 */
export function normalize (text) {
  return String(text || '').normalize('NFKC').toLowerCase()
}

/**
 * 切词元。输出**保持顺序并允许重复**(BM25 要算 tf);去重用 `uniqTerms`。
 *
 * * CJK 连续段:**单字与二字组合都产出**,段长为 2~16 时**另保留整串**。
 * * Latin/数字/标识符:长度 >1 或纯数字才收(滤掉单字母噪声)。
 * * 最后按**停用词表**过滤(P1b:数据文件里有就以数据为准,否则语言默认表 ——
 *   见 `stopwordsOf`)。
 */
export function tokenize (text) {
  const t = normalize(text)
  const sw = stopwordsOf()
  const out = []
  for (const run of t.match(CJK_RUN_RE) || []) {
    for (const ch of run) out.push(ch)
    for (let i = 0; i < run.length - 1; i++) out.push(run.slice(i, i + 2))
    // 段内整串保留是短查询的 idf 主力(「章鱼小丸子」整串 vs 二元组);
    // 只在 2~16 字时保留,超长段整串没有检索价值。
    if (run.length <= 16) out.push(run)
  }
  for (const m of t.match(LATIN_RE) || []) {
    if (m.length > 1 || /^\d+$/.test(m)) out.push(m)
  }
  return out.filter((x) => !sw.has(x))
}

/** 去重但保序的词元表(查询侧与 df 统计用)。 */
export function uniqTerms (text) {
  const out = []
  const seen = new Set()
  for (const t of tokenize(text)) {
    if (!seen.has(t)) { seen.add(t); out.push(t) }
  }
  return out
}

/**
 * 打分用正文 = 摘要 + 关键词 + 说法键。
 *
 * 三者都要:摘要里有"她当时到底说了什么",keywords 里有 `derive_keywords`
 * 产的 CJK 二元滑窗(短查询「面试」只有靠它才吃得到),`augKeys` 是**写入时**
 * 就写好的"以后他可能怎么问这件事"的说法(2026-09-30;Python 侧同名 `aug_keys`,
 * 两条路必须一致)。字段缺失/类型异常一律按空串处理 —— 这是纯函数,
 * 不许因为一行脏数据炸掉整轮检索。
 */
export function docText (row, withAug = true) {
  const r = row || {}
  const summary = String(r.summary || '')
  const kws = Array.isArray(r.keywords) ? r.keywords : []
  const kwText = kws.filter((k) => typeof k === 'string' && k).join(' ')
  // augKeys:库里是 JSON 数组字符串;调用方也可能直接给数组。
  // 解析不出来就当空(一行脏数据不许炸掉整轮)。
  // `withAug=false` ⇒ 逐位等于老行为(与 Python 侧 `doc_text(with_aug=False)` 对齐)。
  const rawAug = withAug ? (r.augKeys ?? r.aug_keys) : null
  let aug = []
  if (Array.isArray(rawAug)) aug = rawAug
  else if (typeof rawAug === 'string' && rawAug.trim() !== '') {
    try {
      const parsed = JSON.parse(rawAug)
      if (Array.isArray(parsed)) aug = parsed
    } catch { aug = [] }
  }
  const augText = aug.filter((k) => typeof k === 'string' && k).join(' ')
  return (summary + ' ' + kwText + ' ' + augText).trim()
}

// ---------------------------------------------------------------- BM25
/**
 * 建 BM25 索引。`docs` = 词元表(可含重复)。
 *
 * 返回 `{n, df, avgdl, len}`。df 按**文档内去重**计数(标准做法:
 * 一条文档里 `量子` 出现 3 次,df 仍只 +1)。
 */
export function buildIndex (docs) {
  const list = Array.isArray(docs) ? docs : []
  const n = list.length
  const df = new Map()
  const lengths = []
  for (const d of list) {
    lengths.push(d.length)
    for (const t of new Set(d)) df.set(t, (df.get(t) || 0) + 1)
  }
  const avgdl = n ? lengths.reduce((a, b) => a + b, 0) / n : 0.0
  return { n, df, avgdl, len: lengths }
}

/**
 * `idf = log(1 + (N - df + 0.5) / (df + 0.5))`(BM25 常用平滑式)。
 *
 * df=0 时也返回有限值(该词不在语料里,调用方负责排除,见 `docCoverage`)。
 */
export function termIdf (index, term) {
  const d = index.df.get(term) || 0
  return Math.log(1.0 + (index.n - d + 0.5) / (d + 0.5))
}

/**
 * 查询里**语料中真实存在**的词元 idf 之和(覆盖率的归一化分母)。
 *
 * 刻意**不**把 OOV 词算进分母:否则「量子纠缠」这种库里根本没有的查询会
 * 因为分母被拉大而让真正命中的词显得微不足道 —— 而它本来就该是 0 命中。
 */
export function queryTotalIdf (index, queryTerms) {
  let total = 0.0
  for (const t of queryTerms || []) {
    if (index.df.get(t)) total += termIdf(index, t)
  }
  return total
}

/**
 * 单文档对查询的 **idf 加权覆盖率** ∈ [0,1]。
 *
 *     sat(tf) = tf·(k1+1) / (tf + k1·(1 − b + b·dl/avgdl))
 *     score   = Σ_t idf(t)·sat(tf_t)      (只对查询词)
 *     cov     = clamp01(score / Σ_t idf(t))   ← 同为 idf 加权 ⇒ 量纲一致
 *
 * 直观:`tf=1` 且文档长度正好是平均长度时 `sat=1`,于是"包含查询全部词元"
 * 的文档覆盖率≈1,长文档被长度归一压低。**与命中档位(1.0/0.7/0.5…)不同,
 * 这里是有序的连续分,不再"先到先得"。**
 */
export function docCoverage (index, docTerms, queryTerms, totalIdf = null,
  k1 = BM25_K1, b = BM25_B) {
  const q = queryTerms || []
  if (q.length === 0 || index.n === 0) return 0.0
  const total = (totalIdf === null || totalIdf === undefined)
    ? queryTotalIdf(index, q)
    : totalIdf
  if (total <= 0) return 0.0
  const tf = new Map()
  for (const t of docTerms || []) tf.set(t, (tf.get(t) || 0) + 1)
  const dl = (docTerms || []).length
  const avgdl = index.avgdl
  // avgdl 为 0(空语料)时长度归一取 1 —— 否则除零。
  const norm = avgdl > 0 ? (1.0 - b + b * (dl / avgdl)) : 1.0
  let score = 0.0
  for (const t of q) {
    const c = tf.get(t) || 0
    if (!c) continue
    const sat = c * (k1 + 1.0) / (c + k1 * norm)
    score += termIdf(index, t) * sat
  }
  const cov = score / total
  return cov < 1.0 ? cov : 1.0
}

// ---------------------------------------------------------------- 近重复
/**
 * 字符二字集合(去空白)—— 近重复判定的指纹。
 *
 * 与检索的 CJK 二字组合不同:这里对**所有字符**取二字(含拉丁),因为要比较的是
 * "两句话是不是同一件事",而不是"能不能被搜到"。去空白防止格式差异造成假不同。
 */
export function charBigrams (text) {
  const s = String(text || '').replace(/\s+/g, '')
  if (s.length < 2) return s ? new Set([s]) : new Set()
  const out = new Set()
  for (let i = 0; i < s.length - 1; i++) out.add(s.slice(i, i + 2))
  return out
}

/** 集合 Jaccard 相似度;任一为空返回 0。 */
export function jaccard (a, b) {
  if (!a || !b || a.size === 0 || b.size === 0) return 0.0
  let inter = 0
  for (const x of a) if (b.has(x)) inter++
  return inter / (a.size + b.size - inter)
}

/** 去空白后的文本(判重前的归一;格式差异不该算成"不同的事实")。 */
function compact (text) {
  return String(text || '').replace(/\s+/g, '')
}

/**
 * `text` 是否与 `keptTexts` 里的某条近重复(该被抑制)。
 *
 * **短文本一律不参与判重** —— 这是实测教训:字符二字 Jaccard 在短串上极不
 * 稳定,「常规命中A」与「常规命中B」只差一个字,J 就达 0.6(≥ 阈值),
 * 于是三条互不相同的事实被当成一条互相吃掉。真实记忆的摘要是 20~60 字,
 * 0.55 这个阈值在那里才有意义。
 *
 * ⚠️ 已知局限:本函数按**字符重合**判重,**换一种说法讲同一件事**的 J 只有
 * 约 0.3,判不出来 —— 阈值保持保守(宁可漏判,不许误吃)。
 */
export function nearDupOf (text, keptTexts, threshold = DEDUPE_THRESHOLD,
  minChars = DEDUPE_MIN_CHARS) {
  const s = compact(text)
  if (s.length < minChars) return false
  const fp = charBigrams(s)
  for (const k of keptTexts || []) {
    const ks = compact(k)
    if (ks.length < minChars) continue
    if (jaccard(fp, charBigrams(ks)) >= threshold) return true
  }
  return false
}
