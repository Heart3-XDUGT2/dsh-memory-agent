# -*- coding: utf-8 -*-
"""词元层与文本相似度原语(RT1)—— 检索打分的确定性基础,零依赖、无 LLM。

与 `lib/lexical.js` **同源同规则**(差分锚点逐点对表,见 RT6)。

    normalize(text)       NFKC + locale 无关小写
    tokenize(text)        CJK 连续段切**二字组合**(段内另保留 2~16 字整串)
                          + Latin/数字/标识符整词;**丢弃单字 CJK**
    doc_text(row)         打分用正文 = summary + keywords
    build_index(docs)     BM25 需要的 df / avgdl / N
    doc_coverage(...)     单文档对查询的 **idf 加权覆盖率** ∈ [0,1]
    char_bigrams/jaccard  近重复判定(去冗余用)

## 为什么这么做(实测依据)

* **只用关键词字段匹配 ⇒ 抽取器没写的词永远搜不到** —— 这是"信息不在索引里",
  不是"算法不够好"。所以打分要索引**正文**(摘要 + 关键词两样都要:keywords 里
  有 `episodic.derive_keywords` 产的 CJK 二元滑窗,那是短查询的主力)。
* CJK 没有空格:`unicode61` 之类分词器对中文**返回 0 命中**(本机 SQLite 3.50.4
  实测:「西安电子科技大学」「章鱼小丸子」「就读」全部 0 命中)。二字组合是零依赖
  里唯一既能召回又不误召的切法。
* **二字组合必须配停用词**:不加时「他上的什么学校」会靠 `什么`/`为什` 命中一堆
  无关记忆(实测返回 `[256,224,209,221,166]`,全是"为什么不主动关怀我/QQ昵称/
  迎新晚会")。加停用词 + 丢弃单字后命中率 85.2% → 88.9%。
* 单字 CJK 一律丢弃:噪声大(「吗」「的」「了」),参考实现(dsh-auto-memory
  `shadow-retrieval.js:186`)也是这么做的。

⚠️ **偏差声明**:上面 85.2% → 88.9% 那次实测用的金标**已知有偏**(题面词元平均
69.8% 直接来自答案记忆)。所以停用词表刻意保持**保守**(只收功能词与疑问词),
`MIN_COVERAGE` 也留成可测的常数 —— 真正的调参留给 RT0 重建后的评测集
(见 `docs/RETRIEVAL_PLAN.md`)。
"""

import json
import math
import re
import unicodedata

# ---- 切分原语 ----
# CJK 统一表意文字(含扩展 A / 兼容区)。刻意不含标点 —— 标点由 normalize 之后的
# 非字母数字边界自然断开(下面对 run 做 findall,标点本就不在类里)。
CJK_RUN_RE = re.compile(r"[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+")
LATIN_RE = re.compile(r"[a-z0-9._\-/+]+")

# ---- BM25 常数(文献值,不是拟合值)----
BM25_K1 = 1.2
BM25_B = 0.75

# 覆盖率下限:低于它视为"没命中"。挡的是"只命中一个极常见词"的伪命中
# (例:查询与某条记忆只共享 `什么`)。0 = 关闭(纯看有无重叠)。
MIN_COVERAGE = 0.10

# 近重复阈值:字符二字 Jaccard ≥ 它视为同一事实。手调值,由测台扫曲线后再定(RT4)。
DEDUPE_THRESHOLD = 0.55

# 判重的最小文本长度(去空白后)。短于此长度不参与判重 —— 短串的二字
# Jaccard 极不稳定(见 near_dup_of 的说明)。
DEDUPE_MIN_CHARS = 12

# ---- 停用词(保守:只收功能词与疑问词)----
# 注意 tokenize 产出的是**二字组合**,所以表里必须以二字形式为主
# (「为什」必须收:「为什么你不主动关怀我」靠它命中)。
# 单字(吗/呢/的/了/他/我/你…)不必列 —— 单字 CJK 已被 tokenize 丢弃;
# 列着无害,只是留个说明。
STOPWORDS = frozenset("""
为什么 怎么 怎么样 怎样 为什 什么 怎么 么样 怎样 是不 不是 有点 有点
那边 这边 那里 这里 哪里 一个 一下 一起 时候 多少 几点 哪个 哪些 干嘛 为啥
我们 你们 他们 她们 咱们 人家 自己 这样 那样 这些 那些 这个 那个
没有 就是 还是 一直 已经 正在 因为 所以 但是 而且 然后 如果 可以 应该
只是 不过 其实 真的 好像 觉得 知道 告诉我 有没有 是不是 好不好
吗 呢 吧 啊 呀 哦 嗯 哈 诶 唉 的 了 着 过 他 她 我 你 它 您 和 与 及
在 是 有 不 没 这 那 就 都 也 很 太 还 才 又 再 只 被 把 给 让 对 从 到
向 为 以 于 而 且 或 但 却 因 所 要 会 能 想 说 个 些 之 其 等 把 来 去
""".split())

# ---------------------------------------------------------------- 数据覆盖(P3 #5)
#: 帧里下发的停用词覆盖(`lexicon.json.stopwords`,形状见
#: `python/engine/graph_gate.py::data_from_frame`)。`None` ⇒ 用上面的内置表 ——
#: **空数据 = 迁移前行为**,这是 P3 的等价性要求(与 `lib/lexical.js::stopwordsOf`
#: 消费**同一份**数据;设计 §1.2 要求两份口径收敛到 `lexicon.json.stopwords`)。
_STOPWORDS_OVERRIDE = None


def configure_from_data(data):
    """用帧里的数据块覆盖停用词表。**never-throw**:形状不对就当没给。

    `data` = 壳侧 `lib/data-tables.js::frameData()` 下的整块(形状见
    `python/engine/graph_gate.py::data_from_frame`);空 / 缺 / 坏 ⇒ 回落内置表。
    """
    global _STOPWORDS_OVERRIDE
    table = None
    if isinstance(data, dict) and isinstance(data.get("data"), dict):
        data = data["data"]        # 也认"整帧"(防呆:`frame` 与 `frame["data"]` 都收)
    if isinstance(data, dict):
        lex = data.get("lexicon")
        raw = lex.get("stopwords") if isinstance(lex, dict) else None
        if isinstance(raw, list):
            clean = [x.strip() for x in raw if isinstance(x, str) and x.strip()]
            table = frozenset(clean) or None
    _STOPWORDS_OVERRIDE = table
    # 词元表是按**输入文本**记忆化的(`_TOKEN_CACHE`)⇒ 换了停用词表必须清一次,
    # 否则同一句话会拿旧表切出来的旧词元,"数据落盘即生效"就是假的。
    _TOKEN_CACHE.clear()


def _stopwords():
    """当前生效的停用词表(数据覆盖优先,空 ⇒ 内置)。"""
    return _STOPWORDS_OVERRIDE if _STOPWORDS_OVERRIDE else STOPWORDS


def normalize(text):
    """NFKC 归一 + locale 无关小写。

    NFKC 把全角/兼容字符折叠成标准形(「Ａ」「①」「３ｋｍ」→ `A`/`1`/`3km`),
    否则同一条记忆的同一件事会因为输入法差异切成不同的词元。
    `casefold()` 而非 `lower()`:对 `ß`/`İ` 之类更彻底,且不依赖 locale。
    """
    return unicodedata.normalize("NFKC", str(text or "")).casefold()


# 词元表记忆化(纯函数的结果缓存,不改语义)。详见 `tokenize` 末尾的说明。
_TOKEN_CACHE = {}
_TOKEN_CACHE_CAP = 8192


def tokenize(text):
    """切词元。输出**保持顺序并允许重复**(BM25 要算 tf);去重用 `uniq_terms`。

    * CJK 连续段:**单字与二字组合都产出**,段长为 2~16 时**另保留整串**。
      单字必须产 —— 只产二字的话,查询「猫」匹配不到文档「他喜欢猫」
      (**边界二字 `于猫`/`猫吗` 与文档里的 `欢猫` 不同 ⇒ 0 命中**),
      这是 CJK 二元索引的经典缺陷;Lucene 的 CJKAnalyzer 也是 unigram +
      bigram 都产。单字噪声由两层压住:STOPWORDS 滤掉虚词(的/了/吗/他/我…),
      idf 让常见字权重自然变低。
    * Latin/数字/标识符:长度 >1 或纯数字才收(滤掉单字母噪声)。
    * 最后按 `STOPWORDS` 过滤(帧里给了 `lexicon.stopwords` 就以数据为准,
      见 `configure_from_data` / `_stopwords()`)。

    实测依据:
      * 只产二字时 `echo_forget "猫"` 匹配到 0 条,「太宽」保护失效
        (test_memory_tools 的回归);
      * 段内整串保留是短查询的 idf 主力(「章鱼小丸子」整串 vs 二元组)。
    """
    key = str(text or "")
    hit = _TOKEN_CACHE.get(key)
    if hit is not None:
        return list(hit)
    t = normalize(key)
    out = []
    for run in CJK_RUN_RE.findall(t):
        out.extend(run)
        for i in range(len(run) - 1):
            out.append(run[i:i + 2])
        if len(run) <= 16:
            out.append(run)
    for m in LATIN_RE.findall(t):
        if len(m) > 1 or m.isdigit():
            out.append(m)
    out = [x for x in out if x not in _stopwords()]
    # 记忆化:`retrieve()` 每轮都把同一批记忆重新切一遍(171 条 × 每次约 20µs
    # ⇒ 实测 3.46 ms/轮,比旧打分器慢 4.7 倍)。键就是**原始文本本身**,所以
    # 不可能读到陈旧的词元表;返回副本防止调用方改坏缓存。
    if len(_TOKEN_CACHE) >= _TOKEN_CACHE_CAP:
        _TOKEN_CACHE.clear()
    _TOKEN_CACHE[key] = out
    return list(out)


def uniq_terms(text):
    """去重但保序的词元表(查询侧与 df 统计用)。"""
    out, seen = [], set()
    for t in tokenize(text):
        if t not in seen:
            seen.add(t)
            out.append(t)
    return out


def doc_text(row, with_aug=True):
    """打分用正文 = 摘要 + 关键词 + 说法键。

    三者都要:摘要里有"她当时到底说了什么",keywords 里有 `derive_keywords`
    产的 CJK 二元滑窗(短查询「面试」只有靠它才吃得到),`aug_keys` 是**写入时**
    就写好的"以后他可能怎么问这件事"的说法(LongMemEval 的 fact-augmented keys,
    实测 +9.4% recall@k)—— 它专治"同一个意思的两种说法"(问法里的词在记忆里
    一个字都不出现)。字段缺失/类型异常一律按空串处理 —— 这是纯函数,不许因为
    一行脏数据炸掉整轮检索。
    """
    summary = str(row.get("summary") or "")
    kws = row.get("keywords") or []
    if not isinstance(kws, (list, tuple)):
        kws = []
    kw_text = " ".join(str(k) for k in kws if isinstance(k, str) and k)
    # aug_keys 落库是 JSON 数组字符串;老行为 NULL/空串 ⇒ 不加字面。
    # 也容忍已经是 list 的调用方(量台/测试直接喂 dict)。解析不出来就**当空**,
    # 绝不抛(一行脏数据不许炸掉整轮)。
    aug = row.get("aug_keys")
    aug_text = ""
    if not with_aug:
        # 旋钮关掉时**逐位等于老行为**(库里有键也不加字面)。
        aug = None
    if isinstance(aug, (list, tuple)):
        aug_text = " ".join(str(k) for k in aug if isinstance(k, str) and k)
    elif isinstance(aug, str) and aug.strip():
        try:
            parsed = json.loads(aug)
        except (ValueError, TypeError):
            parsed = None
        if isinstance(parsed, list):
            aug_text = " ".join(str(k) for k in parsed if isinstance(k, str) and k)
    return (summary + " " + kw_text + " " + aug_text).strip()


# ---------------------------------------------------------------- BM25
def build_index(docs):
    """建 BM25 索引。`docs` = 词元表(可含重复)。

    返回 `{"n", "df", "avgdl", "len"}`。df 按**文档内去重**计数(标准做法:
    一条文档里 `量子` 出现 3 次,df 仍只 +1)。
    """
    n = len(docs)
    df = {}
    lengths = []
    for d in docs:
        lengths.append(len(d))
        for t in set(d):
            df[t] = df.get(t, 0) + 1
    avgdl = (sum(lengths) / n) if n else 0.0
    return {"n": n, "df": df, "avgdl": avgdl, "len": lengths}


def term_idf(index, term):
    """`idf = log(1 + (N - df + 0.5) / (df + 0.5))`(BM25 常用平滑式)。

    df=0 时也返回有限值(该词不在语料里,调用方负责排除,见 `doc_coverage`)。
    """
    d = index["df"].get(term, 0)
    return math.log(1.0 + (index["n"] - d + 0.5) / (d + 0.5))


def query_total_idf(index, query_terms):
    """查询里**语料中真实存在**的词元 idf 之和(覆盖率的归一化分母)。

    刻意**不**把 OOV 词算进分母:否则「量子纠缠」这种库里根本没有的查询会
    因为分母被拉大而让真正命中的词显得微不足道 —— 而它本来就该是 0 命中。
    """
    total = 0.0
    for t in query_terms:
        if index["df"].get(t):
            total += term_idf(index, t)
    return total


def doc_coverage(index, doc_terms, query_terms, total_idf=None, k1=BM25_K1, b=BM25_B):
    """单文档对查询的 **idf 加权覆盖率** ∈ [0,1]。

        sat(tf) = tf·(k1+1) / (tf + k1·(1 − b + b·dl/avgdl))
        score   = Σ_t idf(t)·sat(tf_t)      (只对查询词)
        cov     = clamp01(score / Σ_t idf(t))   ← 同为 idf 加权 ⇒ 量纲一致

    直观:`tf=1` 且文档长度正好是平均长度时 `sat=1`,于是"包含查询全部词元"
    的文档覆盖率≈1,长文档被长度归一压低。**与命中档位(1.0/0.7/0.5…)不同,
    这里是有序的连续分,不再"先到先得"。**
    """
    if not query_terms or index["n"] == 0:
        return 0.0
    if total_idf is None:
        total_idf = query_total_idf(index, query_terms)
    if total_idf <= 0:
        return 0.0
    tf = {}
    for t in doc_terms:
        tf[t] = tf.get(t, 0) + 1
    dl = len(doc_terms)
    avgdl = index["avgdl"]
    norm = (1.0 - b + b * (dl / avgdl)) if avgdl > 0 else 1.0
    score = 0.0
    for t in query_terms:
        c = tf.get(t, 0)
        if not c:
            continue
        sat = c * (k1 + 1.0) / (c + k1 * norm)
        score += term_idf(index, t) * sat
    cov = score / total_idf
    return cov if cov < 1.0 else 1.0


# ---------------------------------------------------------------- 近重复
def char_bigrams(text):
    """字符二字集合(去空白)—— 近重复判定的指纹。

    与检索的 CJK 二字组合不同:这里对**所有字符**取二字(含拉丁),因为要比较的是
    "两句话是不是同一件事",而不是"能不能被搜到"。去空白防止格式差异造成假不同。
    """
    s = re.sub(r"\s+", "", str(text or ""))
    if len(s) < 2:
        return {s} if s else set()
    return {s[i:i + 2] for i in range(len(s) - 1)}


def jaccard(a, b):
    """集合 Jaccard 相似度;任一为空返回 0。"""
    if not a or not b:
        return 0.0
    return len(a & b) / len(a | b)


def is_near_dup(text_a, text_b, threshold=DEDUPE_THRESHOLD):
    """两段文本是否近重复(供上层缓存指纹用)。"""
    return jaccard(char_bigrams(text_a), char_bigrams(text_b)) >= threshold


def _compact(text):
    """去空白后的文本(判重前的归一;格式差异不该算成"不同的事实")。"""
    return re.sub(r"\s+", "", str(text or ""))


def near_dup_of(text, kept_texts, threshold=DEDUPE_THRESHOLD,
                min_chars=DEDUPE_MIN_CHARS):
    """`text` 是否与 `kept_texts` 里的某条近重复(该被抑制)。

    **短文本一律不参与判重** —— 这是实测教训:字符二字 Jaccard 在短串上极不
    稳定,「常规命中A」与「常规命中B」只差一个字,J 就达 0.6(≥ 阈值),
    于是三条互不相同的事实被当成一条互相吃掉。真实记忆的摘要是 20~60 字,
    0.55 这个阈值在那里才有意义(语料体检:179 条里 14 条近重复)。

    ⚠️ 已知局限:本函数按**字符重合**判重,**换一种说法讲同一件事**
    (「很难买到,几年才能吃一次」vs「很稀有,几乎几年才吃一次」)的 J 只有
    约 0.3,判不出来 —— 阈值该怎么定必须由 RT0 重建后的评测集扫出来,
    现在取 0.55 是**保守**选择(宁可漏判,不许误吃)。
    """
    s = _compact(text)
    if len(s) < min_chars:
        return False
    fp = char_bigrams(s)
    for k in kept_texts:
        ks = _compact(k)
        if len(ks) < min_chars:
            continue
        if jaccard(fp, char_bigrams(ks)) >= threshold:
            return True
    return False
