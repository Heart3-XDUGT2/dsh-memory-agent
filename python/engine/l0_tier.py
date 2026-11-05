# -*- coding: utf-8 -*-
"""L0 图位治理(F11 / F12,2026-09-27)。

## 现场

全库 35 条图边里**只有 2 条** `layer='L0'`,而两条都是**偏好**:

    edge#3   用户 -[喜欢]->   章鱼小丸子   iv=91.104
    edge#27  <称呼> -[喜欢吃]-> <话题>   iv=95.917

`graph.py:539-542` 的 L0 强注把它们**无条件**塞进每一轮注入 —— 实测 22/22
条审计行的注入里都有同样那两行。而真正的身份事实边

    用户 -[就读于]-> 西安电子科技大学   (edge#17)
    用户 -[就读于]-> 新工科大学         (edge#13)
    用户 -[是]->     大一学生           (edge#22)

`layer` 全是空的,拿不到那个核心位。**L0 图位被偏好占了,身份反而在外面。**

他的裁决(2026-09-27):「降级为普通边 + 补真正的 L0 边」。

## 规则

L0 图位 = **身份 / 归属 / 关系**("他是谁"),不放**偏好 / 活动 / 临时状态**
("他喜欢什么、在忙什么")。

依据在 `graph.py:535` 自己写的理由上:「身份/称呼/长期关系不因本轮没命中种子词
而消失」—— 偏好与活动**本来就该**靠联想召回(那正是图谱存在的意义);把它们
L0 化等于每轮无条件强灌,于是图永远只亮那一个偏好,其余知识一概出不来。

* `IDENTITY_RELATIONS` —— 允许留在 L0 的谓词白名单
* `demote_non_identity_l0_edges`(F11)—— 白名单外的 L0 边 `layer` 置空。
  **不物理删、不动 is_active**:留档语义不变,它照常参与 BFS,只是不再霸占核心位。
* `promote_identity_edges_from_l0_memories`(F12)—— 从 `layer='L0'` 的记忆里
  扫出它提到的节点名,把「自节点 ↔ 该节点」之间**已经存在**的身份类边提到 L0。
  不新建边:身份事实的边早就有了(`learn` 写的),缺的只是那个层标。

两条都**幂等**(第二次跑不改任何行)。挂法照 F3 的纪律:走**插件自己的代码路径**
(`worker.py` 的 graph_query),不靠谁手去改 echo.db。

## 为什么从"L0 记忆"派生时一律取全集(不过滤 is_active)

17 条 L0 记忆里 12 条的 `superseded_by` 指向**空气**(导入器原样照抄旧 id,
id 257~445 在本库从未存在 —— 见 `integrity.py` 的模块说明)。也就是说它们被
归档**本身就是那个 bug 造成的**,而不是"真的有了替代品"。身份事实(西电 /
大学生 / 新工科 / 大一)正是 F12 要的东西,所以这里按 `layer='L0'` 取全集。

(是否复活这 12 条**记忆**,是另一个决定,见 `docs/FIX_PLAN.md` 第 9 项 ——
本模块只碰图边,不碰 is_active。)

踩过的坑:第一版写成"现役 L0 为空才回退到全集",而现役恰好有 1 条
(#125 风又音理)⇒ 回退永不触发 ⇒ 12 条身份记忆全被排除 ⇒ 真库里提升 0 条。
"""

from . import relations as relations_mod  # P3-c:身份谓词表走它的数据覆盖读点

# ═══════════════════════════════════════════════════════════════════════
# 规则表
# ═══════════════════════════════════════════════════════════════════════

#: 自节点名(抽取侧的约定:「用户」是他的自节点,Echo 私下叫他「主人」)。
#: 身份事实的主语只可能是他自己 —— 别人的学校不算他的 L0。
#:
#: ★ P1c(2026-10-05):真名**不在代码里**。代码只留**角色槽**「用户」(协议约定的
#: 自节点名);「主人」这类称呼由数据下来 —— 由调用方显式传
#: `owner_node_names=`(维护脚本 / 帧驱动的调用点)。
#: ⚠️ [待拍板] `names.json` 目前**没有"自节点名"这个字段**:`speakers` 里含
#: 「她 / Echo / 助手」,`personNames` 里含「妹妹 / 姐姐 / 弟弟 / 朋友 / NPC」——
#: 拿这两份当自节点名,会把**她的自述边**或**别人的身份事实**提进他的 L0,
#: 所以这里**不猜**:不显式给就只认角色槽(退化,宁少不错)。
OWNER_NODE_NAMES = ("用户",)

#: 允许留在 L0 的谓词。只收「他是谁」这一类;偏好(喜欢/习惯)、活动
#: (在做/在忙/搭建/开发/参加)、态度(不喜欢)、未来可能(可能转到)一律不收。
#:
#: `读于` / `就读专业` 是 `就读于` 的同义变体 —— F10 会把它们归并掉,
#: 归并前这里一并放行,免得规则与归并赛跑。
#:
#: ★ P3-c:本表是**内置兜底**;`graph.json.relations.identityRelations` 给了就用数据
#: (整表替换)。取值只留一个口:`identity_relations()`。
IDENTITY_RELATIONS = (
    "是", "属于", "叫", "称呼", "就读于", "就读专业", "读于",
    "负责", "工作于", "住在", "来自",
)


def identity_relations():
    """当前生效的 L0 身份谓词白名单(数据优先,空 ⇒ 内置 `IDENTITY_RELATIONS`)。

    为什么经 `relations` 取:worker 每帧只对 `relations / timeintent / judge` 三个模块调
    `configure_from_data()`(`python/worker.py:136-141`)⇒ 帧里的
    `graph.json.relations.identityRelations` 只有 `relations` 手里有。那边只负责解析,
    内置表在本模块 ⇒ 兜底也留在这里(不把同一张表写成两份)。
    """
    return relations_mod.identity_relations_data() or frozenset(IDENTITY_RELATIONS)


def is_identity_relation(relation):
    """这个谓词说的是「他是谁」吗(而不是「他喜欢/在忙什么」)。"""
    return str(relation or "").strip() in identity_relations()


# ═══════════════════════════════════════════════════════════════════════
# F11:降级
# ═══════════════════════════════════════════════════════════════════════

def demote_non_identity_l0_edges(conn, owner_key, *, commit=True, dry_run=False):
    """F11:把 L0 里**不是身份事实**的边降到普通层。返回被降级的边 id 列表。

    留档语义不变:不删、不动 `is_active`,它照常被 BFS 扩散、照常能被想起,
    只是不再进 `graph.py` 的 pinned 强注。幂等。
    """
    rows = conn.execute(
        "SELECT edge_id, relation, is_active FROM graph_edges"
        " WHERE owner_key = ? AND COALESCE(layer, '') = 'L0'",
        (str(owner_key),),
    ).fetchall()
    hit = [int(r[0]) for r in rows if not is_identity_relation(r[1])]
    if hit and not dry_run:
        conn.execute(
            "UPDATE graph_edges SET layer = '' WHERE owner_key = ?"
            " AND edge_id IN (" + ",".join("?" for _ in hit) + ")",
            (str(owner_key),) + tuple(hit),
        )
        if commit:
            conn.commit()
    return hit


# ═══════════════════════════════════════════════════════════════════════
# F12:补真正的 L0 边
# ═══════════════════════════════════════════════════════════════════════

def _mentions(summary, node_names, *, min_len=2):
    """记忆摘要里字面提到了哪些节点名。

    与 `graph.direct_seed_hits` 同一把尺子(字面扫描、零成本、无幻觉):
    她记得「用户就读于西安电子科技大学」,那个节点名就在摘要里,
    不需要任何模型来告诉我们"这条记忆讲的是谁"。
    """
    text = str(summary or "")
    if not text:
        return []
    out = []
    for name in node_names:
        n = str(name or "").strip()
        if len(n) < min_len:
            continue          # 单字节点不参与字面扫描(噪声太大)
        if n in text and n not in out:
            out.append(n)
    return out


def promote_identity_edges_from_l0_memories(conn, owner_key, *, commit=True,
                                            dry_run=False, owner_node_names=None):
    """F12:按 L0 记忆把**已存在的**身份类边提到 L0。返回被提升的边 id 列表。

    只看现有边,不新建 —— 身份事实的边 `learn` 早就写下了,缺的是层标。
    只提 `is_active=1` 且当前不是 L0 的;只提一端是自节点、谓词在白名单里的。幂等。
    """
    owner = str(owner_key)
    # P1c:自节点名从调用方来(数据驱动);没给 ⇒ 代码里的角色槽(空集合口径的退化)。
    owner_names = tuple(OWNER_NODE_NAMES if owner_node_names is None
                        else owner_node_names)
    nodes = conn.execute(
        "SELECT node_id, name FROM graph_nodes WHERE COALESCE(is_active, 1) = 1"
    ).fetchall()
    name_by_id = {str(r[0]): str(r[1]) for r in nodes}
    id_by_name = {str(r[1]): str(r[0]) for r in nodes}
    owner_ids = {id_by_name[n] for n in owner_names if n in id_by_name}

    # 一律取 `layer='L0'` **全集**,不过滤 is_active。
    # 这里踩过一次坑:第一版写成"现役为空才回退到全集",而现役恰好有 1 条
    # (#125 风又音理)⇒ 回退永不触发 ⇒ 12 条身份记忆全被排除 ⇒ 真库里提升
    # 0 条。而那 12 条**正是**身份事实的唯一来源(它们被归档本身是导入器
    # 悬空引用那个 bug 造成的,见 `integrity.py`)。身份事实不因留档而失真,
    # 派生用全集既是本意也更简单。
    mems = conn.execute(
        "SELECT summary FROM episodic_memory WHERE COALESCE(layer, '') = 'L0'"
    ).fetchall()

    mentioned = set()
    for r in mems:
        for n in _mentions(r[0], id_by_name.keys()):
            mentioned.add(n)

    hit = []
    if mentioned and owner_ids:
        want = {id_by_name[n] for n in mentioned if n in id_by_name}
        for r in conn.execute(
            "SELECT edge_id, source_id, target_id, relation FROM graph_edges"
            " WHERE owner_key = ? AND COALESCE(is_active, 1) = 1"
            "   AND COALESCE(layer, '') <> 'L0'",
            (owner,),
        ).fetchall():
            eid, src, tgt, rel = int(r[0]), str(r[1]), str(r[2]), str(r[3])
            if not is_identity_relation(rel):
                continue
            # 一端是自节点、另一端是记忆里提到的节点
            if (src in owner_ids and tgt in want) or (tgt in owner_ids and src in want):
                hit.append(eid)

    if hit and not dry_run:
        conn.execute(
            "UPDATE graph_edges SET layer = 'L0' WHERE owner_key = ?"
            " AND edge_id IN (" + ",".join("?" for _ in hit) + ")",
            (owner,) + tuple(hit),
        )
        if commit:
            conn.commit()
    return hit


def migrate(conn, owner_key, *, commit=True, dry_run=False, owner_node_names=None):
    """跑一遍 F11 + F12,返回 {"demoted": [...], "promoted": [...]}。

    **先降后升**:先腾空被偏好占住的 L0 位,再让身份事实进来 —— 反过来的话
    `L0_GRAPH_ALWAYS_ON_LIMIT` 的配额会被偏好挤掉(F11 之前那两条就在配额里)。
    `owner_node_names`(P1c):自节点名从调用方来(数据驱动);不给 ⇒ 代码角色槽。
    """
    demoted = demote_non_identity_l0_edges(
        conn, owner_key, commit=False, dry_run=dry_run)
    promoted = promote_identity_edges_from_l0_memories(
        conn, owner_key, commit=False, dry_run=dry_run,
        owner_node_names=owner_node_names)
    if commit and not dry_run and (demoted or promoted):
        conn.commit()
    return {"demoted": demoted, "promoted": promoted}
