# -*- coding: utf-8 -*-
"""情景记忆检索(M2-b3)—— echo_memory_engine.py:948-1132 逐字移植。

打分 = 相关性(覆盖率) ×1.0 + 可回忆度 R ×0.15 + 情感分 ×0.02

RT2(2026-09-27,漏洞①):相关性分从"五档先到先得的关键词字符串包含"换成
**正文(摘要 + 关键词)上的 BM25 idf 加权覆盖率**。旧档位有两个毛病:
  (a) 只匹配 `keywords` 字段 —— 抽取器没写进关键词的词**永远搜不到**。
      这是"信息不在索引里",不是"算法不够好"(索引正文严格更有信息)。
  (b) 分数离散(1.0/0.7/0.5/0.3/0.4),同档内分不出"命中 1 个词"与
      "命中 5 个词",排序只能靠 R 与情感分,于是新鲜度夺走了主导权。
公式与词元规则见 `lexical.py`(与 `lib/lexical.js` 同源,差分锚点对表)。

权重(待裁决①):R 从 **40% 降到 15%**。通用 RAG 里新鲜度只占约 5%,但陪伴
场景中"他上周说的"确实该压过"去年说的";15% 让相关性主导、新鲜度只做同档微调。
这个数要由测台的时间档量出来后再定 —— 不是拍出来的。

L0 管理(b3 的主题):
  - 豁免:身份/称呼/长期偏好不该因为「本轮话题没命中关键词」就消失
    —— 那正是「她忘了你是谁」的成因。L0 零命中也进候选池。
  - 强制占位:按内在价值取前 min(L0_ALWAYS_ON_LIMIT, top_k−2) 条,
    至少给常规结果留 2 席 —— 否则 L0 一旦变多,检索等于被核心事实挤没。
  - **强制占位 ≠ 被想起(F5,2026-09-27)**:纯靠强制占位进来的 L0 不再
    写回强化 —— 与图侧 `pinned` 对称。旧版刻意不豁免,代价实测:
    `#125` 每轮被强制占位⇒每轮被强化,`recall_count` 涨到 2463
    (第 2 名 784),R 被钉在 0.999,正反馈锁死;指标失真、霸榜、还把真正
    切题的记忆挤出常规席位。靠分数**真进** top_k 的 L0 仍算被想起,照常强化。

被想起来就强化(v6.0):检索不再是纯只读 —— top 里**非强制**的每条按间隔
效应延长半衰期、recall_count+1、last_recalled 前移。
旧版纯只读导致情景记忆永远得不到强化,只能靠时间单向变淡。

差分锚点:与 JS lib/retrieve.js 同源同公式(NOW=1700000000 基准行
逐点对表)。已知偏差已修:JS M1 的 L0 上限误写 4,AstrBot 真值 8,
本模块取 8,JS 侧同步修正。
"""

import json
import math
import re
import time

from . import cancel
from . import dmae
from . import lexical
from . import fusion as fusion_mod  # RT10:三臂 RRF(默认不生效)
from . import synonyms as synonyms_mod  # RT11:零依赖语义臂(默认不生效)
from . import timeintent  # 时间臂(默认不生效)

L0_ALWAYS_ON_LIMIT = 8
CANDIDATE_LIMIT = 500

# ---------------------------------------------------------------- 生产注入路径的默认
# 2026-09-30 他批准的三项(实测见 `docs/RETRIEVAL_OPT_2026-09-30.md`):
#   ① `core_block` —— L0 常驻改挂独立区块,**不占证据席位**(K=5 时实测 17/21 → 18/21,
#      N4 知识更新 2/3 → 3/3,无档退)。引擎默认仍是 False(量台/历史读数可比),
#      **只由生产注入路径(`worker.py` 的 retrieve 帧)打开**。
#   ② `fusion["lexArm"]` —— 词法长尾臂(扩池)一起开。
#   ③ K:实测 K=8 在"L0 占席"口径下同效;独立区块生效后**先不动 K**(省 token),
#      要动等下一次读数。
PROD_CORE_BLOCK = True
# ⚠️ 生产**不开融合**:① 现有三臂融合实测是 **−2**(18→15,见 §2 的 B);
#    ② 长尾臂(`lexArm`)实测**零增益**,却会**扩池**——把与问法零重合的记忆也当候选,
#       小语料下当场注入无关条目(2026-09-30 端到端抓到的真事:`今天天气怎么样`
#       把「深夜 熬夜 夜聊」那条当成 matched 注入了)。
# 代码与旋钮都留着(面板 `recallLexArm` / `recallCoreBlock`),默认关。
PROD_FUSION = None
PROD_TIME_ARM = False        # 实测在真金标上是 no-op(见同文档 §3①)⇒ 不开
# 2026-09-30 第二批:查询扩展**进主打分**(扩展词由宿主模型现生成,见 §7)。
# 实测:R0(含上面两项)18/21 → **20/21**(N2 3/5→4/5、N3 3/4→4/4),且负控误取 6/7 → 3/7。
PROD_EXPAND_SCORE = True
# 2026-09-30 第三批:写入侧"说法键"进打分正文(`lexical.doc_text`)。
# 实测**零增益**(§9:18/21 → 18/21,与不开逐条同状态)⇒ **默认关**。
# 代码/列/旋钮留着:① 键本身是下一步"读时重排"的底座;② 面板一键能开。
PROD_AUG_KEYS = False


# 总分权重(RT2)。相关性主导;新鲜度只做同档微调;情感是极小的抬升。
W_REL = 1.0
W_REC = 0.15
W_EMO = 0.02

# 时间臂(2026-09-30,默认关;LongMemEval 的 time-aware query expansion)。
#   * 救援折扣:窗口内但词面没撞上的记忆,按这个覆盖率进场 ——
#     比同义词救援(RESCUE_DISCOUNT)保守一档,因为"时间对"比"词义对"弱;
#   * 加权:窗口内已在候选里的,总分乘一个温和系数(**连续加权**,不做硬分组 ——
#     硬分组会把强证据压到弱证据下面,那是 2026-09-29 量台里 V3/V4 掉分同一类错)。
TIME_RESCUE_DISCOUNT = 0.30
TIME_BOOST = 1.25


def _round4(x):
    """四舍五入到 4 位小数 —— **必须**用这个,不许用内置 `round()`。

    内置 `round()` 是"四舍六入五取偶"(0.15625 → 0.1562),JS 的 `Math.round`
    是"五入"(→ 0.1563)—— 实测 8 条查询 × 12 行里,**唯一**一处跨语言分歧就是
    这个平局(见 scripts/parity-check)。排名用的是未取整的值,所以它只影响
    产物字段的第 4 位小数,但差分锚点要求逐点相等,所以两侧统一成
    `floor(x*10000 + 0.5)/10000`(两侧都是 IEEE754 double,同一个乘法结果相同,
    因此逐位一致)。
    """
    return math.floor(x * 10000.0 + 0.5) / 10000.0

# 查询分段用的切分模式(仅调试/对照用,RT2 起不参与打分)。
# 原版把这两个字符集直接写在 `segment_query` 里的 r"" 字面量中,而字面量里
# 含 ASCII 引号 ⇒ **提前终结字符串**,后半段退化成非 raw 串并抛
# SyntaxWarning("\[" is an invalid escape sequence)。字符集与旧版完全一致,
# 只是挪到模块级并正确转义。
_SEG_SPLIT_RE = re.compile("[，。！？、；："
                           "\\s\"'\u201c\u201d\u2018\u2019（）《》"
                           ",.!?;:()\\[\\]{}]+")
_SEG_SPLIT_RE2 = re.compile("[,，。；;！？\\s]+")


def parse_keywords(raw):
    """关键词解析:JSON 数组优先,兼容 AstrBot v5.x 逗号拼接旧格式。

    AstrBot 原版 json.loads 失败时静默回落空数组 —— 反思层/老记忆的
    逗号串关键词就此丢失,检索永远漏掉它们(实测:16 条含「面试」的
    记忆一条都检不出来)。DSH M1 已修此坑(store.js safeJsonArray),
    Python 侧保持同一修复,两边行为一致 —— 这是**有据的刻意偏差**,
    不是对原版的漂移。

    RT2 追加:关键词现在只是**打分正文的一部分**(见 lexical.doc_text),
    不再是唯一索引面 —— 所以逗号串回落的必要性更强了(丢它 = 丢一条
    记忆的全部词面钩子)。
    """
    s = str(raw or "").strip()
    if not s:
        return []
    try:
        v = json.loads(s)
        if isinstance(v, list):
            return [k for k in v if isinstance(k, str) and k]
        return []
    except (TypeError, ValueError):
        return [k.strip() for k in re.split(r"[,，、]", s) if k.strip()]


def segment_query(query):
    """查询分段:标点+空白切词,保留 ≥2 字的段。

    AstrBot 原文跑两轮切分(第二轮字符集是第一轮的子集,防御性冗余)
    —— 逐字保留,输出与单轮等价。

    RT2 起**不再用于打分**(词元层已由 `lexical.tokenize` 统一负责),
    保留是因为它对"人看的调试输出"仍有用,且差分锚点里两侧都在用它做
    一致性对照。
    """
    segs = set()
    for seg in _SEG_SPLIT_RE.split(query):
        seg = seg.strip()
        if len(seg) >= 2:
            segs.add(seg)
    for seg in _SEG_SPLIT_RE2.split(query):
        seg = seg.strip()
        if len(seg) >= 2:
            segs.add(seg)
    return segs


def hit_score(row, index, doc_terms, query_terms, total_idf):
    """单行相关性分(RT2):BM25 idf 加权覆盖率 ∈ [0,1]。

    参数比旧版多(`index`/`doc_terms`/`query_terms`/`total_idf`)—— 语料统计
    整批只算一次,不能每行重算 df(179 行各自建表会白烧算力)。
    """
    return lexical.doc_coverage(index, doc_terms, query_terms, total_idf)


def _cover_per_concept(index, doc_terms, groups, query_terms, total_idf):
    """RT11 第三刀(3b):**逐概念**覆盖率 —— 分母**固定为原查询概念数**。

    为什么:第二刀把扩展词元并进同一个词元集(`:170`),分母被撑大 ⇒ 覆盖率被稀释 ⇒
    分档不动、捞回 0。这里换一种判据:**对每个原词元(概念),只要它组里任一变体
    在正文里出现过,就记这个概念命中**;分母恒等于 `len(query_terms)`。
    ⇒ 扩展词只用来"把同一个概念捞回来",不再摊薄分母。

    v1 口径(故意保守,量台说话):
      * **不加权**(命中概念数 / 概念数)—— 加权要按概念组重算 idf,先把最简单的口径量出来;
      * 单变体判定只看 `> 0`,所以传进来的 `total_idf` 尺度不影响结论(它只改变数值大小,
        不改变"有没有出现过");
      * `groups` 缺席 ⇒ 退回"只有原词元自己"(等于不做扩展,但分母照样不变)。
    """
    if not query_terms:
        return 0.0
    hit = 0
    for w in query_terms:
        group = (groups or {}).get(str(w)) or {str(w)}
        for variant in group:
            if lexical.doc_coverage(index, doc_terms, [variant], total_idf) > 0.0:
                hit += 1
                break
    return hit / len(query_terms)


def rank_memories(rows, query, top_k, now, *, dedupe=True, fusion=None, synonyms=None,
                  extra_terms=None, stats=None, per_concept=False, groups=None,
                  time_arm=False, time_mode="boost", core_block=False, expand_score=False,
                  aug_keys=False):
    """排名 + L0 强制占位(纯函数,不碰库)。`dedupe=True` 时另做近重复抑制。

    rows: dict 列(DB 列名 snake_case):memory_id, keywords[], summary,
    emotion_score, timestamp, intrinsic_value, half_life, recall_count,
    last_recalled, layer, occurred_at, learned_at, temporal_status,
    source, source_label, actor。

    2026-09-27 RT2/RT3/RT4:
      * 相关性 = 正文(摘要 + 关键词)上的 BM25 覆盖率(漏洞①)
      * 每条 item 带 `matched`:是否真的命中本轮查询 —— 渲染层靠它区分
        "本轮相关"与"只是常在场"(漏洞②)。**L0 豁免与强制占位未改**。
      * 末尾近重复抑制(漏洞③);强制占位的 L0 **受保护**,不会被丢掉。
    """
    if not rows:
        return []
    now = float(now)
    query_terms = lexical.uniq_terms(query)

    # ---- 时间臂(默认关):LongMemEval 的 time-aware query expansion ----
    # 查询里抓到**确定的**时间线索(今天/最近/中秋/凌晨…)⇒ 该窗口内的记忆
    #   ① 被覆盖率门槛挡掉的,**救回候选**(时间轴上的召回通道,与同义词救援并列);
    #   ② 已在候选里的,**乘一个加权**(连续加权,不做硬分组 → 不会把强证据压到弱证据下面)。
    # 抓不到线索 ⇒ windows 为空 ⇒ 下面每一位都不生效(老行为逐位不变)。
    twin = timeintent.parse_time_intent(query, now) if time_arm else {"windows": [], "cues": []}
    t_windows = twin["windows"]
    # scoped:只对**精确锚**(某一天/节日/带小时的时钟)硬分组 —— 文献的"收窄检索范围"。
    # 时段词(最近/上个月)一个窗口能装 100+ 条,拿它收窄 = 砸精度 ⇒ scoped 时**不用**它们。
    t_scoped = twin.get("precise") or [] if (time_arm and time_mode == "scoped") else []
    # ---- 词法臂长尾(2026-09-30,`fusion["lexArm"]`,默认关)----
    # 量台 R3RRF同族在真金标上是 **17/21 → 18/21**(N4 档 2/3 → 3/3,无档退);
    # 同一融合若把第一臂限制在"已过 MIN_COVERAGE 的候选"上,**一条都不动**(C 配置)。
    # ⇒ 那 +1 条完全来自**让没过门槛的行参与融合** —— 是**扩池**,不是重排,
    #   所以它必须显式打开(蹭 `enabled` 上会偷偷改注入结果)。
    lex_arm = bool(isinstance(fusion, dict) and fusion.get("enabled") and fusion.get("lexArm"))
    lex_all = []
    pool_items = []
    _stats = stats if isinstance(stats, dict) else None
    if _stats is not None and time_arm:
        _stats["time_windows"] = len(t_windows)
        _stats["time_precise"] = len(twin.get("precise") or [])
        _stats["time_cues"] = list(twin.get("cues") or [])

    # 语料统计整批算一次(候选池即"语料")
    # `aug_keys`(默认 **关**):写入侧"说法键"是否进打分正文。关 ⇒ doc_text 与老版
    # 逐位一致(库里有键也不加字面)⇒ 量台/历史读数不受影响;生产显式开(§8)。
    docs = [lexical.tokenize(lexical.doc_text(r, with_aug=aug_keys)) for r in rows]
    index = lexical.build_index(docs)
    total_idf = lexical.query_total_idf(index, query_terms)
    # ---- 查询扩展进**主打分**(2026-09-30,`expand_score=True`,默认关)----
    # 为什么必须进主打分:`extra_terms` 的老用法只走"同义词**救援**"那条通道,
    # 而救援是按 `RESCUE_DISCOUNT`(0.30)折扣进场的 ⇒ **永远排不过词面命中**,
    # 进不了 top5。实测(扩展词由**通用提示词**现生成,不含本语料线索):
    #    gi9 金标名次 32/48 → **4/1**;gi13 37/38 → **1/3**;总 18/21 → 20/21。
    # 用并集词元(问法词元 + 扩展词元)算覆盖率与分母 —— 扩展词只影响**谁被算相关**,
    # 门槛(MIN_COVERAGE)与豁免逻辑一个字不动。抓不到扩展词 ⇒ 并集 = 原样。
    score_terms = query_terms
    if expand_score and extra_terms:
        # ⚠️ 扩展词必须**按同一套词元规则切**(CJK 单字 + 二元)—— 直接把"深夜"当一个词元
        # 递进去,只有分词器恰好也产这个 token 时才撞得上(实测漏掉 gi13 就是这么漏的)。
        _ext = lexical.uniq_terms(" ".join(str(t) for t in extra_terms if str(t).strip()))
        if _ext:
            score_terms = list(dict.fromkeys(list(query_terms) + list(_ext)))
            total_idf = lexical.query_total_idf(index, score_terms)
            if _stats is not None:
                _stats["expand_terms"] = len(_ext)
                _stats["expand_scored"] = 1
    # RT11:同义词/别名臂 —— **只用来捞人**(见 synonyms.py 顶部:RT10 量出"重排"是负的)
    # 词元来源有两条,都进同一个"捞人"通道(见下):
    #   ① `synonyms`:静态同义/别名表(库里 graph_aliases);
    #   ② `extra_terms`:**大模型当场给的扩展词元**(查询扩展)。模型只看到问句,
    #      所以它可以泛化 —— 这正好补上"手写表 19 个词元与 838 条问法零交集"那个洞。
    _stats = stats if isinstance(stats, dict) else None
    query_terms_syn = None
    if synonyms or extra_terms:
        _exp = synonyms_mod.expand_terms(query_terms, synonyms) if synonyms else set(query_terms)
        if extra_terms:
            _exp = set(_exp) | {str(t) for t in extra_terms if str(t).strip()}
        if _exp != set(query_terms):
            query_terms_syn = _exp

    scored = []
    for row, doc_terms in zip(rows, docs):
        # 取消检查点:候选池最大 500 条,每条都要算 BM25 覆盖率 —— 这是
        # 整个 retrieve 最长的循环之一。放在轮首而不是循环体中段:取消的
        # 语义是「尽快停」,留下写了一半的 scored 没有意义。
        cancel.checkpoint()
        # ---- L0 豁免话题过滤 ----
        is_core = str(row.get("layer") or "") == "L0"
        cov = lexical.doc_coverage(index, doc_terms, score_terms, total_idf)
        matched = cov >= lexical.MIN_COVERAGE
        rescued = False
        time_rescued = False
        in_time = False
        in_time_scoped = False
        if t_windows or t_scoped:
            _t = float(row.get("occurred_at") or 0.0) or float(row.get("timestamp") or 0.0)
            in_time = timeintent.in_windows(_t, t_windows)
            in_time_scoped = bool(t_scoped) and timeintent.in_windows(_t, t_scoped)
        if lex_arm:
            # 全语料词法名次(**不受 MIN_COVERAGE 限制**)—— 这一路正是量台 R3 的第一臂。
            try:
                lex_all.append((cov, int(row.get("memory_id") or 0)))
            except (TypeError, ValueError):
                pass
        if _stats is not None and query_terms_syn is not None:
            _stats["cands_tried"] = _stats.get("cands_tried", 0) + 1
        if not matched and not is_core and query_terms_syn is not None:
            # 直接命中不够、同义词捞得住 ⇒ 拉回候选,按折扣排(排不过直接命中的)
            if per_concept and groups:
                # v0.42.0 RT11 第三刀:**分母不变的逐概念判定**(默认关;量台开它做对照)。
                cov_syn = _cover_per_concept(index, doc_terms, groups, query_terms, total_idf)
                # ⚠️ 逐概念这条路**不能借 MIN_COVERAGE=0.1**:那个门槛是在"小词元集"上
                # 校准的覆盖率门槛,而中文词元集含单字+二元,一条真实问法切出 10~15 个
                # 词元是常态 ⇒ 单个概念命中 ≈ 1/15 ≈ 0.067 < 0.1 ⇒ 捞人**恒不成立**。
                # 2026-09-29 实测:cands_tried=600、fired=0(600 次机会一次没救成)。
                # 所以这里换成本路的门槛:**至少 1 个概念命中**,再按概念命中比例给折扣分
                # 排序(救回来的排在直接命中之后)。
                _ok = cov_syn > 0.0
            else:
                cov_syn = lexical.doc_coverage(index, doc_terms, query_terms_syn, total_idf)
                _ok = cov_syn >= lexical.MIN_COVERAGE
            if _ok:
                cov = synonyms_mod.RESCUE_DISCOUNT * cov_syn
                matched = True
                rescued = True
                if _stats is not None:
                    _stats["fired"] = _stats.get("fired", 0) + 1
        if not matched and not is_core and in_time:
            # 时间臂救援:窗口内的记忆即使词面没撞上,也进候选(弱分进场,排不过直接命中的)
            cov = TIME_RESCUE_DISCOUNT
            matched = True
            time_rescued = True
            if _stats is not None:
                _stats["time_fired"] = _stats.get("time_fired", 0) + 1
        if not matched and not is_core:
            if not lex_arm:
                continue
            # 开了"词法臂长尾"时才给未过门槛的行建 item(默认关 ⇒ 一个都不建,
            # 输出与旧版逐位一致)。这些行**进不了 scored**,只进 pool,等融合把它们捞上来。
        half_life = float(row.get("half_life") or 0.0)
        if half_life <= 0:
            half_life = dmae.initial_half_life(
                float(row.get("intrinsic_value") or 0.0) or 10.0, dmae.DMAE_DEFAULT)
        last = float(row.get("last_recalled") or 0.0) \
            or float(row.get("timestamp") or 0.0) or now
        r_now = dmae.retrievability((now - last) / 3600.0, half_life)
        emo = float(row.get("emotion_score") or 0)
        total = W_REL * cov + W_REC * r_now + W_EMO * emo
        if in_time:
            total *= TIME_BOOST          # 时间臂加权(连续加权,不硬分组)
        item = dict(row)
        upd = {
            # `hits` 保留旧字段名(工具路径 memory_search 与面板都在读它),
            # 但含义已从"离散档位"变成"连续覆盖率"。
            "hits": _round4(cov),
            "matched": matched,
            "rescued": rescued,  # RT11:这条是靠同义词捞回来的
            "r_now": _round4(r_now),
            "half_life": half_life,
            "age_days": (now - float(row.get("timestamp") or 0.0)) / 86400.0,
            "total": _round4(total),
        }
        if time_arm:
            # ⚠️ 只在时间臂打开时加这两个字段 —— 默认关时输出与旧版**逐位一致**
            # (面板/工具链在读这些 item,凭空多两个键会改差分锚点)。
            upd["in_time"] = in_time
            upd["time_rescued"] = time_rescued
            if time_mode == "scoped":
                upd["in_time_scoped"] = in_time_scoped
        item.update(upd)
        if matched or is_core:
            scored.append((total, item))
        else:
            # 只有 lexArm 打开的人才走到这里(matched=False 且非 L0):
            # 它们是**词法长尾**,总分不够但可能词法名次靠前 ⇒ 交给融合去定生死。
            item["matched"] = False
            pool_items.append((total, item))
    scored.sort(key=lambda pair: pair[0], reverse=True)
    ranked = [item for _, item in scored]

    # ---- scoped 模式:精确时间锚命中的记忆**提到前面**(稳定分组,不丢任何候选)----
    # boost 模式只加权 —— 2026-09-30 实测:在真金标上**是 no-op**(R7 = R0 = 81.0%),
    # 因为救回的条目按 0.30 折扣进场,永远排不过词面命中 ⇒ 进不了 top5。
    # scoped 才是文献那句「refining the search scope」的字面实现;窗口为空 ⇒ 一个字不走。
    if t_scoped:
        _in = [it for it in ranked if it.get("in_time_scoped")]
        if _in:
            ranked = _in + [it for it in ranked if not it.get("in_time_scoped")]
            if _stats is not None:
                _stats["time_scoped_head"] = len(_in)

    # ---- 词法臂长尾融合(与 RT10 的融合**互斥**:两条都是"顺序听谁"的路线)----
    if lex_arm and len(lex_all) > 1:
        by_id_all = {}
        for _, it in list(scored) + list(pool_items):
            try:
                by_id_all[int(it.get("memory_id") or 0)] = it
            except (TypeError, ValueError):
                pass
        arm_lex = [mid for _, mid in sorted(lex_all, key=lambda p: (-p[0], p[1])) if mid]
        arm_tot = []
        for _, it in scored:
            try:
                arm_tot.append(int(it.get("memory_id") or 0))
            except (TypeError, ValueError):
                pass
        fused = fusion_mod.rrf_fuse_lists(
            [arm_lex, arm_tot], k=int(fusion.get("k") or fusion_mod.RRF_K))
        promoted = 0
        new_ranked = []
        for mid in fused:
            it = by_id_all.get(mid)
            if it is None:
                continue
            if not it.get("matched"):
                # 从长尾被融合捞上来 ⇒ 本轮**相关**成立(渲染层据此说"这轮想起来的")
                it["matched"] = True
                it["fused_pool"] = True
                promoted += 1
            new_ranked.append(it)
        if new_ranked:
            ranked = new_ranked
        if _stats is not None:
            _stats["lex_pool"] = len(pool_items)
            _stats["lex_promoted"] = promoted

    # ---- RT10:三臂 RRF 只**重排**(不扩大候选池);是否够格注入另听绝对阈值 ----
    # 默认 fusion=None ⇒ 一个字都不走下面这段,老行为逐位不变。
    fusion_gate = None
    if isinstance(fusion, dict) and fusion.get("enabled") and not lex_arm:
        # RT10 第三刀:**把"重排"和"过门槛"拆开单独量**。
        # 第二刀的读数(N2 60→40)说明伤在门槛,但那是"两件事一起上"的结果 ——
        # mode 让量台能只开一半:reorder / gate / both(默认)。
        mode = str(fusion.get("mode") or "both")
        _ids, _inj, _rrf, _gate = fusion_mod.decide(
            ranked,
            prev_in=fusion.get("prevIn") or (),
            k=int(fusion.get("k") or fusion_mod.RRF_K),
            threshold=float(fusion.get("threshold", fusion_mod.DEFAULT_THRESHOLD)),
            exit_=float(fusion.get("exit", fusion_mod.DEFAULT_EXIT)),
            arms=fusion.get("arms") or None,   # 2026-09-30:可指定臂(默认三臂不变)
        )
        if mode in ("reorder", "both"):
            order = {mid: i for i, mid in enumerate(_ids)}
            ranked.sort(key=lambda it: (order.get(int(it.get("memory_id") or 0), 10 ** 9),
                                        -float(it.get("total") or 0.0)))
        if mode in ("gate", "both"):
            fusion_gate = (_inj, _gate)

    # ---- L0 强制注入:按内在价值占位,至少给常规结果留 2 席 ----
    #
    # ⚠️ 2026-09-30 实测(`docs/RETRIEVAL_OPT_2026-09-30.md`):**常驻块占席位本身是瓶颈**。
    # 库里 L0 共 3 条 ⇒ K=5 时 `core_cap=3` 吃掉 3 席,**只剩 2 席给本轮证据**,而金标常
    # 落在常规榜第 5~10 名 ⇒ N4 知识更新那档漏的不是"找不到",是"没位置"。
    # 实测:L0 占位=0 ⇒ 17/21 → **18/21**(N4 2/3 → 3/3,无档退);K=8(等效 5 席证据)同 18/21。
    #
    # `core_block=True`:常驻块**改挂成独立区块**(自己的名额,不占证据席位)——
    # 语义上"常在场"本来就不等于"本轮证据",两者本来不该抢同一批席位。
    # 默认 **False ⇒ 老行为逐位不变**(量台/历史读数不受影响);生产注入路径显式打开。
    core_cap = min(L0_ALWAYS_ON_LIMIT, max(1, int(top_k) - 2))
    if core_block:
        # 区块自己的名额:仍然不给它无限大(身份条目也不该淹没证据),
        # 但**不再**从 top_k 里扣 —— 证据席位满 top_k。
        core_cap = min(L0_ALWAYS_ON_LIMIT, max(1, int(top_k) - 2))
    forced = sorted(
        (it for it in ranked if it.get("layer") == "L0"),
        key=lambda it: -float(it.get("intrinsic_value") or 0.0),
    )[:core_cap]
    # F5:「被选进强制列表」本身就是强制注入的证据 —— 一律不算被想起。
    # 不必再判"它其实也命中了":L0 的入选与查询无关,它的相关性不决定
    # 它进不进注入,所以强化它永远没有意义(图侧 pinned 是同一个立场)。
    # 没被选进 forced 的 L0 照常参与竞争,靠分数进榜 ⇒ 照常强化。
    for it in forced:
        it["forced"] = True

    # ---- RT4 去冗余:近重复只留分最高的那条(仅注入用途)----
    # 在"强制 L0 + 常规结果"**合并之后**做 —— 否则同一事实会从两个通道
    # 各进一条。强制占位的 L0 **受保护**(常在场语义优先),只丢常规结果里的
    # 近重复:既去掉冗余,又不吃掉 core_cap 那个保证。
    #
    # ⚠️ `dedupe=False` 是**必须**存在的开关:去冗余属于"喂给她的席位"优化,
    # 不属于"枚举"用途。`memory_forget` 的「>10 拒绝」保护是**数匹配条数**的,
    # 折叠近重复会让 11 条近似记忆变成 1 条 ⇒ 保护失效,他一句「忘掉猫」就能
    # 把 11 条一起抹掉(实测:forget["ok"] 从 False 翻成 True)。
    # 顺带:去冗余后强化回写的条数会变少 —— 那是**修好**(同一事实不再被反复
    # 喂大 recall_count),不是副作用。
    if not dedupe:
        rest = [it for it in ranked if not it.get("forced")]
        for it in rest:
            it["forced"] = False
        if core_block:
            # 枚举路径也照"独立区块"排版:证据在前、常驻块在后
            return rest[: max(0, int(top_k))] + forced
        return forced + rest[: max(0, int(top_k) - len(forced))]
    kept = [] if core_block else list(forced)
    # 去冗余的保护名单:常驻 L0 的文本**永远**先进保护名单(常规结果里的近重复照丢),
    # 区别只在 `core_block` 时它们不占 top_k 的计数。
    kept_texts = [it.get("summary") for it in forced]
    if not core_block:
        kept_texts = kept_texts  # 老路径:kept 里就是 forced,名单一致
    limit = max(0, int(top_k))
    for it in ranked:
        if it.get("forced"):
            continue
        if len(kept) >= limit:
            break
        if lexical.near_dup_of(it.get("summary"), kept_texts):
            continue
        # RT10:过了绝对阈值+滞回才占注入席位(只走 dedupe=True 这条**注入**路 ——
        # memory_forget / memory_search 是**枚举**用途,不许被门槛砍掉条数)
        if fusion_gate is not None and int(it.get("memory_id") or 0) not in fusion_gate[0]:
            continue
        it["forced"] = False
        kept.append(it)
        kept_texts.append(it.get("summary"))
    if core_block:
        return kept + forced
    return kept


def retrieve(conn, user_id, query, top_k, now=None, *, reinforce=True,
             dedupe=True, time_arm=False, time_mode="boost", fusion=None,
             core_block=False, extra_terms=None, expand_score=False, aug_keys=False):
    """检索 top_k:读库 → 排名 → 被想起来就强化(写回)。

    返回 (items, reinforced)。候选池 = 该用户最近 CANDIDATE_LIMIT 条
    活跃记忆(时间倒序)。
    reinforce=False(M3-b echo_forget 用):只读不写 —— 遗忘前的匹配
    绝不能强化目标(「查到要忘的事」不该让它活得更久)。
    dedupe=False(**枚举用途**)关掉近重复抑制:`memory_forget` 数匹配条数
    做「>10 拒绝」保护,`memory_search` 是查全的搜索 —— 折叠会让它们少报。
    只有**注入**这条路才折叠(见 rank_memories 里的说明)。

    (v0.29.0 个人机器人裁剪:channel / channel_chat 渠道过滤随群聊
    拒收一起退役 —— 只服务他一个人,所有记忆对所有轮次可见,没有
    「往哪儿渗」的问题。)
    """
    now = float(now) if now else time.time()
    rows = []
    for r in conn.execute(
        "SELECT memory_id, keywords, summary, emotion_score, timestamp, "
        "source, source_label, actor, intrinsic_value, half_life, "
        "recall_count, last_recalled, layer, occurred_at, learned_at, "
        "temporal_status FROM episodic_memory "
        "WHERE user_id = ? AND is_active = 1 "
        "AND (status IS NULL OR status = 'active')"
        " ORDER BY timestamp DESC LIMIT ?",
        (user_id, CANDIDATE_LIMIT),
    ).fetchall():
        keywords = parse_keywords(r[1])
        rows.append({
            "memory_id": int(r[0]), "keywords": keywords,
            "summary": str(r[2] or ""), "emotion_score": r[3],
            "timestamp": float(r[4] or 0.0),
            "source": str(r[5] or "private"), "source_label": str(r[6] or ""),
            "actor": str(r[7] or ""),
            "intrinsic_value": float(r[8] or 0.0),
            "half_life": float(r[9] or 0.0),
            "recall_count": int(r[10] or 0),
            "last_recalled": float(r[11] or 0.0),
            "layer": str(r[12] or ""),
            "occurred_at": float(r[13] or 0.0),
            "learned_at": float(r[14] or 0.0),
            "temporal_status": str(r[15] or "time_unknown"),
        })
    top = rank_memories(rows, query, top_k, now, dedupe=dedupe, time_arm=time_arm,
                        time_mode=time_mode, fusion=fusion, core_block=core_block,
                        extra_terms=extra_terms, expand_score=expand_score,
                        aug_keys=aug_keys)
    if not top:
        return [], 0
    if not reinforce:
        return top, 0

    # ---- 被想起来就强化(纯靠强制占位进来的除外,见 F5)----
    # 2026-09-27 F5:强制占位的 L0 **不再**写回强化 —— 与图侧 `pinned` 对称。
    # 现场:`#125`(风又音理)是全库唯一活着的 L0,每轮被强制占位,于是每轮
    # 被强化,`recall_count` 涨到 **2463**(第 2 名 784,同层 #42/#53 只有 110),
    # half_life 涨到 440h、R 恒 0.999 —— 正反馈锁死。
    # 图侧早就防住了这件事(`graph.py:536`「pinned 不算被想起……否则每轮注入
    # 等于每轮强化」),情景侧原来刻意不防(旧 docstring 自称"刻意的不对称"),
    # 实测代价:(a) recall_count/half_life 变成噪声指标;(b) R 被钉在 1,
    # 一旦不再强制占位就会霸榜数月;(c) 在 merit 榜上把自己顶到前面,
    # 把真正切题的记忆挤出常规席位。
    # 注意:只豁免**纯强制**的 —— 靠分数真进 top_k 的 L0 仍然算被想起。
    #
    # RT4 追加:去冗余之后,**同一事实不再有多条同时被强化**(旧行为是
    # 5 条换说法的记忆各自 recall_count+1)。回写条数变少是修好,不是副作用。
    reinforced = 0
    skipped = 0
    for it in top:
        if it.get("forced"):
            skipped += 1
            continue
        new_h = dmae.reinforce_half_life(
            float(it["half_life"]), float(it["r_now"]), dmae.DMAE_DEFAULT)
        conn.execute(
            "UPDATE episodic_memory SET half_life = ?,"
            " recall_count = recall_count + 1, last_recalled = ?"
            " WHERE memory_id = ?",
            (new_h, now, it["memory_id"]),
        )
        reinforced += 1
    conn.commit()
    return top, reinforced


def render_episodic(memories):
    """情景渲染:年龄标签 + 情感分 + 时间注记,L0 加 [核心]。

    brain_pipeline.py:762-780 逐字移植(行首 '- ',不编号 —— 编号是
    图路径的格式,两边刻意不同)。

    2026-09-26 现场(他让我「分析一下每轮大模型输入的语言」):**关键词不再
    渲染进这一行**。关键词是给检索打分用的 —— `episodic.derive_keywords`
    对 CJK 走的是**二元滑窗**(「的设/设计/计灵/灵感…」),那是刻意的设计
    (短查询「面试」只有靠它才吃得到那一档 hit_score),但它一旦被渲染给
    模型看,读起来就是一串乱码(#125/#126/#130 三条记忆就长这样)。
    检索照旧用关键词,只是不往她眼前摆。

    RT3(2026-09-27,漏洞②):**整轮零主题命中**时,这批记忆是"只是常在场"
    而不是"与本轮相关" —— 必须说出来。否则她会拿长期身份去回答一个完全
    无关的问题:实测问「量子纠缠」这种库里根本没有的东西,现状返回 `#125`
    那条 L0 记忆,她于是"以为自己有"(三条负控 3/3 全中)。
    **有命中时不加任何标注** —— 标注本身是噪声,只在必要时出现。

    2026-09-27 补(RT3-b):光靠"全语料零命中"当触发条件**太脆**。测台实测:
    19 条寒暄负控里 **17 条**仍被判 `matched=True`(top1 覆盖率 0.36~1.00;
    短查询只剩一个词元时覆盖率非 0 即 1,`MIN_COVERAGE=0.10` 退化掉了),
    于是横幅不出现,L0 又混在"相关材料"里。改成**逐条标注**:只要整块里
    有命中(所以不是全空),那些**没命中的常在场记忆**就在它自己那行末尾
    带上 `(常在场,不是本轮相关)`。
      * 两级标注**不同时出现**:全未命中 → 块级横幅(覆盖全块,不必逐条);
        有命中 → 逐条标(只标那几条不是本轮相关的)。
      * 只在 `matched` 字段**存在**时才标 —— 别让老的、不带该字段的调用方
        把所有行都标上。
    """
    if not memories:
        return ""
    has_flag = any("matched" in m for m in memories)
    topic_matched = any(bool(m.get("matched")) for m in memories)
    lines = []
    if not topic_matched:
        lines.append(
            "(本轮话题没有命中任何记忆;以下是你的长期身份,"
            "不要拿它们回答眼前的问题)"
        )
    for m in memories:
        summary = m.get("summary", "")
        es = m.get("emotion_score", 0)
        age = m.get("age_days", 0)
        age_tag = "今天" if age < 1 else f"{int(age)}天前"
        core = "[核心] " if str(m.get("layer") or "") == "L0" else ""
        from .graph import _time_note
        note = _time_note(
            m.get("occurred_at", 0.0),
            m.get("learned_at", 0.0),
            m.get("temporal_status", ""),
        )
        # 有命中时逐条标"这条不是本轮相关"(块级横幅已覆盖"全都没命中"那种)
        mark = ""
        if has_flag and topic_matched and not m.get("matched"):
            mark = "(常在场,不是本轮相关)"
        lines.append(f"- {core}[{age_tag}|情感{es}] {summary}{note}{mark}")
    return "\n".join(lines)
