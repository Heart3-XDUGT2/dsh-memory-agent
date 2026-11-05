# -*- coding: utf-8 -*-
"""DMAE v6.0 数学 —— brain_pipeline.py:105-384 逐字移植。

三个核心量:
  R  可回忆度 ∈ [0,1]    R(Δt) = 1 / (1 + Δt/H)   Δt = 墙上小时数
  H  半衰期(小时)        R(H) = 0.5              可直接解释、可直接调
  I  内在价值 ∈ (0,100]  由 Judge 的多维字段合成,决定 H 的起点

两条曲线:
  遗忘  R(Δt) = 1/(1 + Δt/H)                  陡→平,尾巴极长,**永不归零**
  强化  H' = H · (1 + k·(1 − R_想起时))        提取越吃力增益越大(间隔效应)

真相只存三样:H(半衰期)/ last_accessed(上次想起)/ recall_count。
R 永远现算 —— 进程重启、离线一周再上线,都不会算出失真的 R。
物化的 activation 纯粹是面板/审计的展示快照,任何数学处绝不读它。

差分测试锚点:本模块与 JS 基线 lib/dmae.js 同源同公式,
同输入必须同输出(跨语言数值一致性是 M2 的验收纪律之一)。
"""


class DmaeParams:
    """DMAE v6.0 可调参数集(默认值与 AstrBot 逐字段一致)。"""

    def __init__(
        self,
        max_score: float = 100.0,
        h_min: float = 24.0,
        i_ref: float = 10.0,
        gamma: float = 1.2,
        k_reinforce: float = 1.8,
        r_active: float = 0.5,
        r_dormant: float = 0.1,
        w_recall: float = 0.4,
        salience_exp: float = 0.5,
        prune_r: float = 0.02,
        prune_i: float = 15.0,
        prune_min_age_days: float = 60.0,
        prune_interval_hours: float = 6.0,
    ):
        self.max_score = max_score
        self.h_min = h_min
        self.i_ref = i_ref
        self.gamma = gamma
        self.k_reinforce = k_reinforce
        self.r_active = r_active
        self.r_dormant = r_dormant
        self.w_recall = w_recall
        self.salience_exp = salience_exp
        self.prune_r = prune_r
        self.prune_i = prune_i
        self.prune_min_age_days = prune_min_age_days
        self.prune_interval_hours = prune_interval_hours


DMAE_DEFAULT = DmaeParams()


def retrievability(dt_hours, half_life) -> float:
    """幂律可回忆度: R(Δt) = 1 / (1 + Δt / H)。永不归零。"""
    if half_life is None or float(half_life) <= 0:
        return 0.0
    dt = max(0.0, float(dt_hours or 0.0))
    return 1.0 / (1.0 + dt / float(half_life))


def initial_half_life(intrinsic_value, params: DmaeParams) -> float:
    """H0 = h_min · (I / i_ref)^γ —— 内在价值决定「起手能记多久」。"""
    i = max(1.0, float(intrinsic_value or 0.0))
    return params.h_min * (i / params.i_ref) ** params.gamma


def reinforce_half_life(half_life, r_at_recall, params: DmaeParams) -> float:
    """H' = H · (1 + k·(1 − R_想起时)) —— 间隔效应 + 提取难度。

    快忘掉时才想起 → 增益大;刚复习过又想起 → 增益小。
    自我调节,不需要「这是第几次复习」的额外状态。
    """
    h = max(1e-6, float(half_life or 0.0))
    r = min(1.0, max(0.0, float(r_at_recall or 0.0)))
    return h * (1.0 + params.k_reinforce * (1.0 - r))


def derive_state(r, params: DmaeParams) -> str:
    """三态按可回忆度划分。Archived 仍可被唤醒(种子直提照常强化)。"""
    rr = float(r or 0.0)
    if rr >= params.r_active:
        return "Active"
    if rr >= params.r_dormant:
        return "Dormant"
    return "Archived"


def dmae_state_of(activation_x100, params: DmaeParams) -> str:
    """给面板/审计用:把物化的 activation(R×100)转成三态。"""
    return derive_state(float(activation_x100 or 0.0) / 100.0, params)


# 内在价值的因子权重(来自 Memory Judge 的字段)
_CERTAINTY_W = {"explicit": 1.00, "inferred": 0.55, "uncertain": 0.25}
_ATTRIBUTION_W = {"user_explicit": 1.00, "mixed": 0.70, "assistant_inferred": 0.40}


def compute_intrinsic_value(
    *,
    layer: str = "L2",
    certainty: str = "",
    attribution: str = "",
    stability: str = "",
    emotion: float = 5.0,
    quote_count: int = 0,
    salience_exp: float = 0.5,
) -> float:
    """内在价值  I = 100 · Tier · Trust · Salience^salience_exp  ∈ (0, 100]

    用**乘积**而不是加权平均:三维是「否决式」的 —— 一条被推断出来的
    碎片,不该因为情绪很强烈就变得重要。

      Tier      层级 × 持久性  —— 身份级 1.00 / 近况级 0.45 / 碎片级 0.15
      Trust     确定性 × 归属  —— 谁会为这句话负责
      Salience  显著度 = 0.55 + 0.45·(情绪/10) + 0.10·min(1, 引文数)

    Salience 开平方根是**刻意的**:情绪与引文数应当「调节」重要性,
    而不该主导它 —— 身份事实即使说得平淡,也仍然最重要。

    参照值: L0 身份事实 ≈ 88.6 | L1 近况 ≈ 41 | L2 一次性琐事 ≈ 14
    | 推断碎片 ≈ 2.9(对应半衰期 ≈ 13.7 天 / 5.4 天 / 1.5 天 / 4.9 小时)
    """
    if layer == "L0" or stability == "stable":
        tier = 1.00
    elif layer == "L1" or stability == "situational":
        tier = 0.45
    else:
        tier = 0.15

    trust = (
        _CERTAINTY_W.get(str(certainty or "").strip(), 0.55)
        * _ATTRIBUTION_W.get(str(attribution or "").strip(), 0.40)
    )

    emo = min(10.0, max(0.0, float(emotion or 0.0)))
    salience = min(
        1.0,
        0.55 + 0.45 * (emo / 10.0) + 0.10 * min(1, max(0, int(quote_count or 0))),
    )

    return round(100.0 * tier * trust * (salience ** float(salience_exp)), 3)


def dmae_edge_r(edge: dict, now_ts: float, params: DmaeParams = None) -> float:
    """按边上的持久状态现算可回忆度(H<=0 时按 I 现推 H0)。"""
    p = params or DMAE_DEFAULT
    h = float(edge.get("half_life") or 0.0)
    if h <= 0:
        h = initial_half_life(edge.get("intrinsic_value"), p)
    last = float(edge.get("last_accessed") or now_ts)
    dt_hours = max(0.0, (float(now_ts) - last) / 3600.0)
    return retrievability(dt_hours, h)


def dmae_should_prune(edge: dict, now_ts: float, params: DmaeParams = None) -> bool:
    """只清「从未被想起过的噪声」,凡被想起过至少一次就永不删除。

    四个条件同时成立才删,保证不会误删。
    """
    p = params or DMAE_DEFAULT
    try:
        recall_count = int(edge.get("recall_count") or 0)
    except (TypeError, ValueError):
        recall_count = 0
    if recall_count > 0:
        return False
    i = float(edge.get("intrinsic_value") or 0.0)
    if i >= p.prune_i:
        return False
    if dmae_edge_r(edge, now_ts, p) >= p.prune_r:
        return False
    last = float(edge.get("last_accessed") or now_ts)
    age_days = max(0.0, (float(now_ts) - last) / 86400.0)
    return age_days > p.prune_min_age_days


class DmaeEngine:
    """DMAE v6.0 引擎 —— 无状态。R 是派生量,不再缓存。

    只负责两件事:
      1. recall_updates() —— 被想起的边该写回什么(H 增益、R 归 1、
         次数 +1、时钟前移)
      2. plan_prune()     —— 哪些噪声边该清掉(只清从未被想起过的)
    """

    def __init__(self, params: DmaeParams = None):
        self.params = params or DMAE_DEFAULT

    def recall_updates(self, edges, hit_ids, now_ts: float):
        """对每个被想起的边算出要写回 DB 的字段(只含被想起的边)。"""
        p = self.params
        out = []
        for edge in edges or []:
            eid = edge.get("edge_id")
            if eid is None or eid not in hit_ids:
                continue
            h_before = float(edge.get("half_life") or 0.0)
            if h_before <= 0:
                h_before = initial_half_life(edge.get("intrinsic_value"), p)
            r_before = dmae_edge_r(edge, now_ts, p)
            try:
                rc = int(edge.get("recall_count") or 0)
            except (TypeError, ValueError):
                rc = 0
            out.append({
                "edge_id": int(eid),
                "activation": p.max_score,              # R = 1 的物化值
                "half_life": reinforce_half_life(h_before, r_before, p),
                "recall_count": rc + 1,
                "last_accessed": float(now_ts),
                # 仅用于审计展示
                "r_before": round(r_before, 4),
                "h_before": round(h_before, 2),
                "state": derive_state(1.0, p),
            })
        return out

    def plan_prune(self, edges, now_ts: float):
        """返回应当删除的边 ID(只含从未被想起过的噪声)。"""
        p = self.params
        return [
            int(e["edge_id"])
            for e in (edges or [])
            if e.get("edge_id") is not None and dmae_should_prune(e, now_ts, p)
        ]

    def materialize(self, edges, now_ts: float):
        """把 R 物化进 activation,供面板/审计读取。"""
        p = self.params
        out = []
        for e in edges or []:
            if e.get("edge_id") is None:
                continue
            out.append({
                "edge_id": int(e["edge_id"]),
                "activation": round(dmae_edge_r(e, now_ts, p) * p.max_score, 3),
            })
        return out

    def state_of(self, edge: dict, now_ts: float) -> str:
        return derive_state(dmae_edge_r(edge, now_ts, self.params), self.params)
