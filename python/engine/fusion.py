"""RT10 三臂融合器(RRF)+ 绝对阈值 + 滞回 —— **纯函数,默认不生效**。

计划 §3.3 的三句话,逐条落在这里:

1. **排序 = 三臂 RRF**:词法臂(`cov`,已在算)/ 可回忆性臂(`r_now`,已在算)/
   情绪臂(`emotion_score`,已在 `episodic_memory` 里)。**向量臂今天恒空** ——
   RT12 已实测本机没有 ollama / sentence-transformers / openai key,所以它只是
   一个"随时能插进来"的位置,不是一段假装存在的代码。
   ⇒ RRF 只决定**顺序**。
2. **是否注入 = 绝对分比阈值**(不是排名):分不够就不进,哪怕它是本轮的榜一。
   为什么必须绝对阈值:排名制在"库里只有三条"和"库里有五千条"时会给出同样自信的
   榜一 —— 绝对分才说得清"这条到底够不够格当'她想起来了'"。
3. **滞回**(进去容易出来难):`enter >= exit`。已经进过的条目掉到 `exit` 以上就留着,
   新条目要够 `enter` 才进 —— 防的是**相邻两轮之间抖进抖出**(她一会儿记得一会儿不记得)。

⚠️ 本模块**不 import 任何别的东西、不碰库** —— 纯函数 + 常量,离线可测。
   接线(`retrieve.retrieve(fusion=...)`)由调用方给,**默认 None = 完全走老路**。
"""

# RRF 的 k:业界默认 60(先信常见值,别自己发明 —— 要调也是**量完再调**)。
RRF_K = 60

# 绝对阈值与滞回的默认值(先给保守值:只拦"分低到不该算想起来"的)
# 阈值单位 = **最高可能融合分的比例**(见 normalize):1.0 = 三臂里全排第一。
# 一开始我把阈值写成了 0.25 的"原始 RRF 分" —— 单测当场把它拆穿:k=60 时三臂全第一
# 也只有 3/61 ≈ 0.049,所以 0.25 这个门槛**永远没人过得去**(等于把注入全关掉,
# 而面板上看起来还挺"宽松")。阈值必须跟分的量纲对上,否则这个旋钮是假的。
DEFAULT_THRESHOLD = 0.5
DEFAULT_EXIT = 0.35

# 三臂的名字与"从哪取分"的唯一一份说明(改这里就等于改口径,别在别处另写一份)
ARM_FIELDS = (
    ("lexical", "hits"),           # 词法臂:doc_coverage 连续覆盖率
    ("recall", "r_now"),           # 可回忆性臂:DMAE retrievability
    ("emotion", "emotion_score"),  # 情绪臂:这条记忆落库时的情绪强度
)


def _key(items, field):
    """按某一臂降序排出来的 id 序列(分相同按 id 稳定排序 —— 不许随机)。"""
    scored = []
    for it in items:
        try:
            mid = int(it.get("memory_id"))
        except (TypeError, ValueError):
            continue
        try:
            val = float(it.get(field) or 0.0)
        except (TypeError, ValueError):
            val = 0.0
        scored.append((val, mid))
    scored.sort(key=lambda p: (-p[0], p[1]))
    return [mid for _, mid in scored]


def rrf_fuse(items, k=RRF_K, arms=None):
    """多臂 RRF:score(d) = Σ_臂 1/(k + 该臂里 d 的排名)。

    榜上每个 id 都拿得到分(在某一臂里排第一就是 1/(k+1))。`items` 里没有的 id
    不会凭空出现 —— 融合只**重排候选**,不**扩大候选池**(那是另一件事,不在这批)。

    `arms`(2026-09-30 新增,默认 None ⇒ 老行为逐位不变):允许调用方指定臂,
    形如 `(("lexical", "hits"), ("total", "total"))` —— 用途是把量台里
    **R3RRF同族(R0 81.0% → 85.7%,N4 档 66.7% → 100%)** 那对臂搬进生产。
    不传就是 `ARM_FIELDS`(覆盖/可回忆/情绪)那三臂。
    """
    arms = tuple(arms) if arms else ARM_FIELDS
    scores = {}
    for name, field in arms:
        for rank, mid in enumerate(_key(items, field), start=1):
            scores[mid] = scores.get(mid, 0.0) + 1.0 / (float(k) + rank)
    return scores


def max_possible(k=RRF_K, arms=len(ARM_FIELDS)):
    """三臂全排第一时的融合分 = 上界(归一化的分母)。"""
    return float(arms) / (float(k) + 1.0)


def normalize(scores, k=RRF_K):
    """把融合分折到 [0,1]:1.0 = 三臂里都排第一。

    为什么值得折:阈值是要**上设置面板给他调**的。留原始 RRF 分的话,
    旋钮的刻度取决于 k(改 k 就整体平移)⇒ 没人调得明白。折成比例之后,
    「0.5」就是「这条得在起码两臂里都排得靠前」,人话能说清。
    排序不受影响(除以同一个正数,单调)。
    """
    denom = max_possible(k)
    return {mid: float(s) / denom for mid, s in scores.items()}


def relevance_scores(items, field="hits"):
    """**绝对量纲**那一份分:每条的覆盖率 `cov`(词法臂,[0,1])。

    为什么非要它:单测当场量出 RRF 分**不能当绝对置信度**用 —— 三臂 RRF 里,
    只要一条记忆在每一臂都出现,分就 ≥ 3/(k+候选池)。实测两条候选时"全末位"那条
    归一化之后是 **0.98**,榜一是 1.0 ⇒ 差别只有 2%,而它的实际相关性可以差十倍。
    RRF 衡量的是**排名一致性**,不是**相关性大小**。所以:
      · 顺序 ⇒ 听 RRF 的;
      · 谁够格进注入 ⇒ 得比一个**带量纲**的数(覆盖率),这才是"绝对分比阈值"。
    """
    out = {}
    for it in items:
        try:
            mid = int(it.get("memory_id"))
        except (TypeError, ValueError):
            continue
        try:
            out[mid] = float(it.get(field) or 0.0)
        except (TypeError, ValueError):
            out[mid] = 0.0
    return out


def rank_by(scores):
    """按融合分降序(分相同按 id 升序,稳定)。返回 id 列表。"""
    return [mid for mid, _ in sorted(scores.items(), key=lambda p: (-p[1], p[0]))]


def absolute_gate(scores, threshold=DEFAULT_THRESHOLD):
    """绝对分比阈值:够格的 id 集合(不是排名前 N)。"""
    t = float(threshold)
    return {mid for mid, s in scores.items() if float(s) >= t}


def hysteresis(prev_in, scores, enter=DEFAULT_THRESHOLD, exit_=DEFAULT_EXIT):
    """滞回:进去容易出来难。

    * 不在上一轮名单里 ⇒ 要够 `enter` 才进;
    * 已在名单里 ⇒ 只要还够 `exit_` 就留着;
    * 掉到 `exit_` 以下 ⇒ 出来(下一轮想回来得重新够 `enter`)。
    `enter < exit_` 是**配置错误**(那就成了"出来容易进去难",与意图相反),
    按"从严"处理:把 `exit_` 拉到 `enter`(宁可不进,也不抖)。
    """
    e_in = float(enter)
    e_out = float(exit_)
    if e_out > e_in:
        e_out = e_in
    keep = set()
    for mid, s in scores.items():
        s = float(s)
        if mid in prev_in:
            if s >= e_out:
                keep.add(mid)
        elif s >= e_in:
            keep.add(mid)
    return keep


def rrf_fuse_lists(lists, k=RRF_K, weights=None):
    """**名单对名单**的 RRF(2026-09-30 新增)。

    与 `rrf_fuse` 的区别:`rrf_fuse` 从 item 的字段里现算各臂的名次;这里直接吃
    **调用方给的名次表** —— 用来融合一路"**不受 MIN_COVERAGE 门槛限制的全语料词法名次**"
    (它的尾巴在生产 item 里根本不存在,所以必须由调用方把名单递进来)。

    量到的用途:量台 R3RRF同族(R0 81.0% → 85.7%,N4 档 66.7% → 100%)。
    2026-09-30 对照实验证明**那 +1 条全靠第一臂的"长尾"**:把第一臂换成"只含已过门槛的
    候选",同一融合**一条都不动**(C 配置 17/21)。⇒ 这不是"重排",是**扩池**,
    所以它在生产里必须由 `fusion["lexArm"]` 显式打开,而不是蹭 `enabled` 默认上。
    """
    acc = {}
    for li, lst in enumerate(lists):
        w = 1.0 if not weights else float(weights[li])
        for rank, mid in enumerate(lst, start=1):
            acc[mid] = acc.get(mid, 0.0) + w / (float(k) + rank)
    return [mid for mid, _ in sorted(acc.items(), key=lambda p: (-p[1], p[0]))]


def decide(items, prev_in=(), k=RRF_K, threshold=DEFAULT_THRESHOLD, exit_=DEFAULT_EXIT,
           gate_field="hits", arms=None):
    """一次调用的完整决定:**顺序听 RRF,进不进听带量纲的覆盖率**(理由见 relevance_scores)。

    * `ordered_ids` —— 融合后的顺序(注入席位按它排);
    * `injected_ids` —— 过得了绝对阈值与滞回的那些(调用方据此决定"谁算被她想起来");
    * `scores` —— 每个 id 的**归一化 RRF 分**(留痕/调参用;⚠️ 它不是置信度);
    * `gate` —— 门槛实际比的那份分(覆盖率)。

    `arms` 见 `rrf_fuse`(默认 None = 原来的三臂)。
    """
    raw = rrf_fuse(items, k=k, arms=arms)
    ordered = rank_by(raw)
    gate = relevance_scores(items, field=gate_field)
    injected = hysteresis(set(prev_in or ()), gate, enter=threshold, exit_=exit_)
    return ordered, injected, normalize(raw, k=k), gate
