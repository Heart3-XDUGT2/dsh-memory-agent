# -*- coding: utf-8 -*-
"""记忆图谱引擎(M2-b2)。

AstrBot 移植源与行号:
  存储侧  echo_memory_engine.py:75-366(_graph_get_or_create_node /
          _graph_add_edge 三分支 / _graph_load / _graph_learn)
  数学侧  brain_pipeline.py:105-384(已在 dmae.py)
  种子侧  brain_pipeline.py:97-101(STOPWORDS), 391-510(机械切分 /
          实体链接 / 节点直扫)
  BFS     brain_pipeline.py:513-672(graph_activate)
  渲染    brain_pipeline.py:675-780(_fmt_day / _time_note / render_paths)
  LTP     brain_pipeline.py:787-816(apply_ltp)
  持久化  brain_pipeline.py:819-946(dmae_update_and_persist)

三个「不带就死」的修复(v8.9.3 法医:不带则 186 轮真实对话 BFS 扩散 0 次):
  1. 双向邻接 + 逆向 `<-` 前缀 —— 这张图几乎所有知识边的 source 都是
     「用户」节点,单按 source 建邻接表则提到目标端时无路可走;
  2. R 闸门 r_dormant=0.1:Archived 边不做中继,但**种子节点的邻接边
     免闸** —— 那是 Archived 记忆唯一的唤醒通道(「想不起来,但一提
     就记起」);
  3. 新边 activation=100 出生即 Active —— 旧版不带 activation(默认 0),
     derive_state(0)==Archived,新边一生下来就是「已遗忘」。

其他保真点:
  - pinned(L0 核心边)独占配额不参与竞争,且**不算想起**(不写
    recall_count、不做 LTP)—— 否则每轮注入等于每轮强化,指标失真;
  - LTP 只加 weight 不写 last_accessed(v8.7.2:时间簿记归 DMAE 一家);
  - 物化 10 分钟桶跳过本轮命中(防旧快照覆盖),剪枝 1 小时桶豁免
    本轮唤醒(防「先强化再被 DELETE」的静默撤销);
  - 剪枝只清「从未想起 + I<15 + R<0.02 + 沉默>60 天」的噪声;
    孤点清理保留 person 与 protected 节点;
  - owner_key 必填:归属隔离由调用点显式声明。DSH 约定单主人
    owner='master'(import-astrbot.mjs 搬家即此键;AstrBot 侧是
    '__shared__',两边不同,worker 沿用调用方传键,不做隐式映射)。
"""

import heapq
import re
import sqlite3
import time
import uuid

from . import cancel
from . import dmae
from . import evidence as evidence_mod
from . import relations as relations_mod
from .db import connect  # noqa: F401 —— 供壳侧/测试经 graph.connect 取连接
def default_relation():
    """事实边默认谓词:数据优先(`graph.json.relations.defaultRelation`),空 ⇒ 内置「相关」。

    P3-e(2026-10-05):`graph.py` 原来有 5 处写死的 `"相关"`(漂点)—— 数据改了
    默认谓词,只有闸门那条读点会跟着变,这里不变。现在统一走这一个口,
    取值函数在 `python/engine/relations.py:353`(`configure_from_data` 解析)。
    """
    return relations_mod.default_relation_data() or "相关"

# ---- 常量(与 AstrBot 逐值一致)----
ACTIVATION_DECAY = 0.5
ACTIVATION_THRESHOLD = 0.15
ACTIVATION_MAX_HOPS = 5
ACTIVATION_TOP_K = 5
L0_GRAPH_ALWAYS_ON_LIMIT = 12
LTP_BOOST = 0.5
LTP_MAX_WEIGHT = 10
PROTECTED_BOOST = 1.0

STOPWORDS = frozenset(
    "我你他她它了的是在有和就都也啊吧呢吗哦哎呀这个那个什么怎么为什么"
    "非常特别真的好像应该可能大概已经还是就是只是不过然而虽然所以因为"
    "？！？，。、；：\"\"''（）《》 \t\n"
)

# ---------------------------------------------------------------- 数据覆盖(P3 #5)
#: 帧里下发的停用词覆盖(`lexicon.json.stopwords`,形状 = 引擎侧 `data_from_frame()`
#: 认的那块)。`None` ⇒ 用上面的内置表 —— **空数据 = 迁移前行为**,这是 P3 的
#: 等价性要求。它与 `lexical.py` 消费**同一份数据**(设计 §1.2:两份口径收敛到
#: `lexicon.json.stopwords`)。
#: (注:`data_from_frame` 在闸门模块里;本文件不依赖它 —— 这里只吃已解析好的 dict。)
_STOPWORDS_OVERRIDE = None


def configure_from_data(data):
    """用帧里的数据块覆盖种子提取的停用词表。**never-throw**:形状不对就当没给。

    `data` = 壳侧 `lib/data-tables.js::frameData()` 下的整块(形状 = 引擎侧
    `data_from_frame()` 认的那块);空 / 缺 / 坏 ⇒ 回落内置表。
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


def _stopwords():
    """当前生效的停用词表(数据覆盖优先,空 ⇒ 内置)。"""
    return _STOPWORDS_OVERRIDE if _STOPWORDS_OVERRIDE else STOPWORDS


_TEMPORAL_LABELS = {
    "enduring": "长期有效",
    "current": "当前有效",
    "historical": "过去事件",
    "planned": "未来计划",
    "time_unknown": "时间未知",
}


# ═══════════════════════════════════════════════════════════════════════
# 谓词归并(F10,2026-09-27)
# ═══════════════════════════════════════════════════════════════════════
#
# 现场(活库 35 条边里大半是同一个事实的换说法):
#
#   用户 -[希望打造]-> Echo      变体 期望打造 / 想打造 / 希望塑造   (4 条,全现役)
#   用户 -[就读于]-> 新工科大学   变体 读于 / 就读专业               (3 条,全现役)
#   用户 -[负责]->  Echo记忆架构  变体 在忙/正在搭建/在做/正在开发/搭建(6 条,全归档)
#
# 后果不只是"看着乱":`graph_activate` 的 BFS 会把同一个事实**重复算进路径**,
# 于是「希望打造 Echo」那一组四条边一起被想起、一起被强化,而它其实只值一条;
# 面板上也会把它画成四根并排的线。
#
# 与 `_alias_target`(节点别名,表 `graph_aliases`)是同一件事的两半:那个解决
# 「西电 ↔ 西安电子科技大学」,这个解决谓词。节点侧走表是因为合并脚本要写映射;
# 谓词侧只有这一小撮、且判据要从活库取证,所以**写成常量表 + 一个 parity 守卫**
# (跨语言没有第二份实现 —— 图边只有 Python 在写,JS 侧不写 `graph_edges`)。
RELATION_ALIASES = relations_mod.CANONICAL_RELATION
#: ⚠️ 这张表的**唯一出处**已搬到 `python/engine/relations.py`(A2,2026-10-01)。
#: 这里保留同名绑定:① 老调用点(`merge_relation_variants`)不用改;
#: ② 单测 `test_relations_cardinality` 会钉住"两处是同一个对象",防止又长出第二份表。

#: 层级强弱,合并时取高的那个(不要因为并了一条低层的边就把 L1 掉成普通)。
_LAYER_RANK = {"L0": 3, "L1": 2, "L2": 1}


def _layer_rank(layer) -> int:
    return _LAYER_RANK.get(str(layer or "").strip(), 0)


def canonical_relation(rel: str) -> str:
    """谓词的规范写法。**唯一出处 = `relations.CANONICAL_RELATION`**(A2)。

    表外的原样返回(白名单,不是"猜近义");这里是转发,免得两处各有一套表。
    """
    return relations_mod.canonical_relation(rel)


def merge_relation_variants(conn, owner_key, *, commit=True, dry_run=False):
    """F10:把已存在的同义谓词边并到规范写法上。返回 {"renamed": [...], "merged": [(变体, 幸存者)]}。

    两种处置,都不物理删除:

    * 该 (主语, 宾语) 下**还没有**规范谓词的边 ⇒ 直接把谓词改规范(改名);
    * 已经有 ⇒ 变体**留档下线**:`is_active=0` + `superseded_by=幸存者`,
      幸存者吸收 `max(intrinsic_value)` / `max(recall_count)` / 较高层级。

    幂等:已带 `superseded_by` 的行直接跳过。

    ⚠️ 只并**表内**的谓词。表外的一律不动 —— 这是白名单,不是"近义词猜测"
    (猜错的代价是把两件不同的事并成一件,比多几根线严重得多)。
    """
    owner = str(owner_key)
    renamed = []
    merged = []
    for rel in sorted(RELATION_ALIASES):
        canon = RELATION_ALIASES[rel]
        if canon == rel:
            continue          # 规范写法本身就是"天然幸存者",它在下面被找出来
        rows = conn.execute(
            "SELECT edge_id, source_id, target_id, intrinsic_value, recall_count,"
            " layer, COALESCE(superseded_by, 0) FROM graph_edges"
            " WHERE owner_key = ? AND relation = ?",
            (owner, rel),
        ).fetchall()
        for r in rows:
            eid = int(r[0])
            if int(r[6]) != 0:
                continue      # 已经并过了(幂等)
            existing = conn.execute(
                "SELECT edge_id FROM graph_edges WHERE owner_key = ? AND source_id = ?"
                " AND target_id = ? AND relation = ? AND edge_id <> ?",
                (owner, str(r[1]), str(r[2]), canon, eid),
            ).fetchone()
            if existing is None:
                if not dry_run:
                    conn.execute(
                        "UPDATE graph_edges SET relation = ? WHERE edge_id = ?",
                        (canon, eid),
                    )
                renamed.append(eid)
            else:
                survivor = int(existing[0])
                if not dry_run:
                    _absorb_edge(conn, survivor, r)
                merged.append((eid, survivor))
    if commit and not dry_run and (renamed or merged):
        conn.commit()
    return {"renamed": renamed, "merged": merged}


def _absorb_edge(conn, survivor_id, row):
    """变体边并进幸存者:取 max(iv)、max(rc)、较高层级;变体留档下线。"""
    held = conn.execute(
        "SELECT intrinsic_value, recall_count, layer FROM graph_edges WHERE edge_id = ?",
        (survivor_id,),
    ).fetchone()
    iv = max(float(held[0] or 0.0), float(row[3] or 0.0))
    rc = max(int(held[1] or 0), int(row[4] or 0))
    layer = held[2] if _layer_rank(held[2]) >= _layer_rank(row[5]) else row[5]
    conn.execute(
        "UPDATE graph_edges SET intrinsic_value = ?, recall_count = ?, layer = ?"
        " WHERE edge_id = ?",
        (iv, rc, str(layer or ""), survivor_id),
    )
    conn.execute(
        "UPDATE graph_edges SET is_active = 0, superseded_by = ? WHERE edge_id = ?",
        (survivor_id, int(row[0])),
    )


# ═══════════════════════════════════════════════════════════════════════
# 存储侧
# ═══════════════════════════════════════════════════════════════════════

def _alias_target(conn, name: str):
    """v0.16.0 M2:查别名表 —— 这个名字该归到哪个 canonical 名下。

    合并脚本(`scripts/graph-merge.mjs`)把映射写进 `graph_aliases`,此后
    **每一次写入都自动接地**:合并结果不会被下一轮对话重新长出来。
    表不存在/查不到都返回 None(老库、新库都能跑)。
    """
    try:
        row = conn.execute(
            "SELECT canonical_name FROM graph_aliases WHERE alias = ?", (name,)
        ).fetchone()
    except sqlite3.Error:
        return None
    if not row:
        return None
    canon = str(row[0] or "").strip()
    if not canon or canon == name:
        return None
    return canon


def get_or_create_node(conn, name: str, node_type: str = "concept",
                       owner_key: str = "master") -> str:
    """按名取节点,无则创建(node_id=uuid16),命中刷新 last_accessed。

    v0.16.0 M2:取之前先过一遍别名表 —— 「西电」落到「西安电子科技大学」。

    阶段 1a(2026-10-01,PLAN_MEMORY_GRAPH_ACTION §2③):新节点**显式写入**
    `node_type`。取值域四个:`concept`(默认)/ `person` / `episode` / `belief`
    (`belief` 由阶段 1b 补 —— `lib/soul-snapshot.js:38` 早就在查
    `node_type = 'belief'`,书写侧却不在取值域里;取值域以闸门模块的
    `NODE_TYPE_BELIEF` 为准,两边**手工对齐,不互相 import**);
    缺省 `concept` ⇒ 与既有行为逐位一致(基表 DDL 的默认值也是 `concept`)。
    **既有 28 个节点一律不回填**(回填属"改"不属"纯增",需单独批准)。

    阶段 2d(2026-10-01):**归属必须显式声明**(与 `add_edge` 同风格)。
    此前这条 INSERT 的列里**没有 `owner_key`** ⇒ 引擎现场新建的每个节点
    `owner_key` 都是 NULL(实测活库 28 个节点里 5 个 NULL)。现在 `owner_key`
    是**显式入参、默认 `"master"`**,INSERT 列带上它 —— 新节点从此不再留 NULL。
    既有调用点**一个都不改**(不传新参 ⇒ 走默认 `"master"`,与活库唯一 owner
    一致 ⇒ 行为兼容;§11-14 已证"读路径全宽容"= 补这一列零行为变化)。
    回填老行**不在本函数内做**:那是"改",归 `scripts/graph-owner-key-backfill.mjs`
    (默认 dry-run)。
    """
    name = (name or "").strip()[:32]
    if not name:
        raise ValueError("empty node name")
    node_type = (node_type or "concept").strip()[:16] or "concept"
    owner_key = (owner_key or "master").strip()[:32] or "master"
    canon = _alias_target(conn, name)
    if canon:
        name = canon[:32]
    row = conn.execute(
        "SELECT node_id FROM graph_nodes WHERE name = ?", (name,)
    ).fetchone()
    if row:
        node_id = str(row[0])
        conn.execute(
            "UPDATE graph_nodes SET last_accessed = ? WHERE node_id = ?",
            (time.time(), node_id),
        )
        conn.commit()
        return node_id
    node_id = uuid.uuid4().hex[:16]
    conn.execute(
        "INSERT INTO graph_nodes"
        " (node_id, name, node_type, last_accessed, owner_key)"
        " VALUES (?, ?, ?, ?, ?)",
        (node_id, name, node_type, time.time(), owner_key),
    )
    conn.commit()
    return node_id


def _has_column(conn, table: str, column: str) -> bool:
    """表里有没有这一列(老库兼容用;查不到就当没有 —— 由调用方决定回退口径)。"""
    try:
        rows = conn.execute("PRAGMA table_info(%s)" % table).fetchall()
    except sqlite3.Error:
        return False
    return column in {str(r[1]) for r in rows}


def top_nodes(conn, owner_key: str, limit: int = 20):
    """v0.16.0 M2:度数最高的实体名(给反思提示词当「已有实体」名单)。

    提示词带一张现成名单,比事后合并便宜得多,而且**保真** —— 合并不
    可能无损(「后端架构」到底指哪件事,机器不知道,模型知道)。

    阶段 3a 卡口 2(2026-10-01):这段 `LEFT JOIN graph_edges` 原来**只过滤节点
    owner、不过滤边的 owner** ⇒ 影子边(`kind='cooccur_*'`,归属键 `__shadow__`)
    会灌进度数,把 `音理` 从第 7 名顶到第 2 名(实测),而这张名单喂的是
    `extract_prompt` 的「已有实体」。现在只看**事实边**(`kind` 为空串);
    既有数据 `kind` 全是空串 ⇒ 对它们**逐位零变化**。老库还没有 `kind` 列时
    退回不过滤(那时也不存在影子边)。

    ⚠️ 卡口 3(2026-10-01 实测,两次踩坑):过滤必须写在 **`ON` 子句**里,不能写在
    `WHERE` 里 ——
      · 写 `WHERE ... AND COALESCE(e.kind,'')=''`:凡是**有影子边**的节点,`LEFT JOIN`
        先匹配上影子行、再被 `WHERE` 打掉 ⇒ 这个节点一行不剩、**从榜单里整条消失**
        (实测:12 个节点只剩 3 个;不是"度数不变",是"节点没了");
      · `AND` 又比 `OR` 结合得紧,`WHERE` 里那串 `OR` 不加括号还会让 owner 命中的
        节点**照样**灌影子边度数(`音理` 仍被顶到第 2 名)。
    所以:条件放 `ON`,`LEFT JOIN` 的语义(左表一行不少)才是完整的 ——
    有影子边的节点度数按 0 算、照样在榜上。
    """
    facts_only = (" AND COALESCE(e.kind, '') = ''"
                  if _has_column(conn, "graph_edges", "kind") else "")
    try:
        rows = conn.execute(
            "SELECT n.name AS name, COUNT(e.edge_id) AS degree"
            " FROM graph_nodes n"
            " LEFT JOIN graph_edges e"
            "   ON (e.source_id = n.node_id OR e.target_id = n.node_id)"
            + facts_only
            + " WHERE (n.owner_key = ? OR n.owner_key IS NULL OR n.owner_key = '')"
            " GROUP BY n.node_id ORDER BY degree DESC, n.recall_count DESC"
            " LIMIT ?",
            (owner_key, int(limit)),
        ).fetchall()
    except sqlite3.Error:
        return []
    return [str(r[0]) for r in rows if str(r[0] or "").strip()]


def _merge_evidence(old: str, new_ids, limit: int = 8) -> str:
    """v0.16.0 M1:边依据合并 —— 去重、新在前、截断到 limit。

    新在前:面板最想看的是「这条边最近一次是听谁说的」。解析失败一律
    当空(老行/脏数据不该把写入链带崩)。`new_ids` 可以是列表,也可以是
    已经拼好的「11、12」串(调用方两种都传得出来,别让它猜字符)。
    """
    seq = []
    for chunk in str(old or "").replace(",", "、").replace("，", "、").split("、"):
        chunk = chunk.strip()
        if chunk and chunk not in seq:
            seq.append(chunk)
    items = new_ids
    if isinstance(items, str):
        items = items.replace(",", "、").replace("，", "、").split("、")
    for item in (items or []):
        try:
            token = str(int(item))
        except (TypeError, ValueError):
            continue
        if token in seq:
            seq.remove(token)
        seq.insert(0, token)
    return "、".join(seq[:limit])


def add_edge(conn, s, rel, t, owner_key, intrinsic_value=0.0, *,
             layer="", occurred_at=0.0, temporal_status="", evidence="",
             kind=""):
    """固化一条边:v6.0 半衰期状态 + v2-A1「按基数换代」,三分支。

    ① 精确命中同一三元组(含已停用行)→ 视为一次「想起」:权重 +0.5、
       半衰期按间隔效应延长、recall_count+1、activation=100、复活时先让
       槽位现役版本让位;
    ② (复活分支并入 ① 的 was_active 判定)
    ③ 全新边 → INSERT activation=100(出生即 Active)、weight=1.0、
       H0=initial_half_life(I)、I 缺省 10;新宾语落进已有槽位 → 旧版本
       is_active=0 留档(不删除,DMAE 状态原样保留 —— 「我以前住哪」
       仍翻得出来)。

    **v2-A1(2026-10-01)** —— 换代判据从「槽位唯一」改成「**关系基数**」:

    * `slot` 升为**三元组身份** `源|关系|目标`(老值留在 `slot_v1`,回退一句
      UPDATE 反灌);
    * 换代只在 `relations.is_single_value_relation(rel)` 为真时发生,查的是
      `(owner_key, source_id, relation)`,**不再**用槽位唯一性;
    * 多值关系(喜欢玩 / 喜欢 / 参加 …)下新旧目标**并列**,谁也不顶谁 ——
      「并列不是矛盾」。实测动机:`用户—喜欢玩—KARDS` 曾被 `—德美跳` 顶下线,
      导致 `KARDS` 节点悬空。取证见 `docs/ASSOC_GRAPH_SURVEY.md` §7 共识 3。
    """
    s = (s or "").strip()[:32]
    t = (t or "").strip()[:32]
    rel_raw = (rel or default_relation()).strip()[:16] or default_relation()
    # v2-A3:类型层入口守卫。`kind` 空串 = 事实边(**承重约定**,见 `evidence.py`
    # 的长注释):`top_nodes()` 与剪枝都按 `COALESCE(kind,'')=''` 过滤事实边,影子/
    # 共现边已另立 `graph_shadow_edges`。传 `"fact"` 会被归一成空串(存 `'fact'`
    # 会让那两处过滤把这条边当影子边漏掉),不认的 kind 直接抛。
    # 让它算出来(不认的 kind 会在此抛错),再**显式**写进 INSERT:
    # 归一后必然是空串,写出来是为了让"这一列写的是什么"在写入点一眼可见。
    _kind = evidence_mod.normalize_kind(kind)
    # F10:写入侧就接地 —— 同一件事的换说法不再各长一条边
    # (`merge_relation_variants` 负责把**已经**长出来的并掉)。
    # v2-A2:原话留在 `relation_raw`(回退/审计依据),`relation` 存规范写法。
    rel = canonical_relation(rel_raw)
    if not s or not t:
        return
    src = get_or_create_node(conn, s)
    tgt = get_or_create_node(conn, t)
    if src == tgt:
        return

    i_val = float(intrinsic_value or 0.0)
    if i_val <= 0:
        i_val = 10.0  # 缺省给保守值,而不是 0(否则 H0 会被压到最小)
    h0 = dmae.initial_half_life(i_val, dmae.DMAE_DEFAULT)
    now = time.time()
    # v2-A1:槽位 = 三元组身份(`源|关系|目标`)。换代判据走基数表,
    # 不再靠"落进同一槽位"——多值关系下并列共存。
    slot = f"{src}|{rel}|{tgt}"
    single_valued = relations_mod.is_single_value_relation(rel)
    tstat = (temporal_status or "").strip() or "time_unknown"
    # v0.16.0 M1:这条边的「依据」= 本轮反思落库的 memory_id。
    # 合并语义在 _merge_evidence(新在前、去重、上限 8)。
    merged_evidence = _merge_evidence("", evidence)

    # ① 精确命中同一三元组(含已停用行)。UNIQUE(s,t,rel,owner) 保证
    #    「回到旧值」不可能靠 INSERT 复活 —— 必须先把旧行查出来 UPDATE。
    row = conn.execute(
        "SELECT edge_id, weight, half_life, intrinsic_value,"
        " last_accessed, is_active, evidence"
        " FROM graph_edges"
        " WHERE source_id = ? AND target_id = ? AND relation = ?"
        " AND owner_key = ?",
        (src, tgt, rel, owner_key),
    ).fetchone()

    if row:
        eid = int(row[0])
        was_active = int(row[5] if row[5] is not None else 1)
        old_evidence = str(row[6] or "")
        merged_evidence = _merge_evidence(old_evidence, evidence)
        new_w = min(10.0, float(row[1] or 1.0) + 0.5)
        old_h = float(row[2] or 0.0) or h0
        old_i = float(row[3] or 0.0)
        last = float(row[4] or now)
        r_before = dmae.retrievability((now - last) / 3600.0, old_h)
        new_h = dmae.reinforce_half_life(old_h, r_before, dmae.DMAE_DEFAULT)
        top = dmae.DMAE_DEFAULT.max_score
        if not was_active and single_valued:
            # ② 复活:先让这个槽位上现役的版本让位,再把本条重新置为
            #    现役 —— 这也是一次「想起」,半衰期照常按间隔效应延长。
            #    v2-A1:只有**单值关系**才让位(多值关系下并列是正常的)。
            conn.execute(
                "UPDATE graph_edges SET is_active = 0, superseded_by = ?"
                " WHERE owner_key = ? AND source_id = ? AND relation = ?"
                " AND is_active = 1 AND edge_id <> ?",
                (eid, owner_key, src, rel, eid),
            )
        conn.execute(
            "UPDATE graph_edges SET weight = ?, half_life = ?,"
            " intrinsic_value = ?, recall_count = recall_count + 1,"
            " activation = ?, last_accessed = ?, is_active = 1,"
            " superseded_by = 0,"
            " evidence = CASE WHEN ? <> '' THEN ? ELSE evidence END,"
            " layer = CASE WHEN ? <> '' THEN ? ELSE layer END,"
            " temporal_status = CASE WHEN ? <> '' THEN ? ELSE temporal_status END,"
            " occurred_at = CASE WHEN ? > 0 THEN ? ELSE occurred_at END,"
            " learned_at = CASE WHEN learned_at > 0 THEN learned_at ELSE ? END,"
            " relation_raw = CASE WHEN COALESCE(relation_raw, '') = '' THEN ?"
            "                     ELSE relation_raw END"
            " WHERE edge_id = ?",
            (
                new_w, new_h, max(i_val, old_i), top, now,
                merged_evidence, merged_evidence,
                layer, layer,
                tstat if temporal_status else "", tstat if temporal_status else "",
                occurred_at, occurred_at,
                now, rel_raw, eid,
            ),
        )
    else:
        cur = conn.execute(
            "INSERT INTO graph_edges (source_id, target_id, relation,"
            " weight, last_accessed, owner_key, intrinsic_value,"
            " half_life, recall_count, activation, slot, is_active,"
            " superseded_by, layer, occurred_at, learned_at, temporal_status,"
            " evidence, relation_raw, kind)"
            " VALUES (?, ?, ?, 1.0, ?, ?, ?, ?, 0, 100.0, ?, 1, 0, ?, ?, ?, ?, ?, ?, ?)",
            (
                src, tgt, rel, now, owner_key, i_val, h0, slot,
                layer, occurred_at, now, tstat, merged_evidence, rel_raw, _kind,
            ),
        )
        new_eid = int(cur.lastrowid or 0)
        if new_eid and single_valued:
            # ③ 新宾语落进一个已有槽位 → 旧版本让位(不删除、不衰减篡改)。
            #    v2-A1:仅单值关系(例如「住在」);多值关系并列保留。
            conn.execute(
                "UPDATE graph_edges SET is_active = 0, superseded_by = ?"
                " WHERE owner_key = ? AND source_id = ? AND relation = ?"
                " AND is_active = 1 AND edge_id <> ?",
                (new_eid, owner_key, src, rel, new_eid),
            )
    try:
        for nid in (src, tgt):
            conn.execute(
                "UPDATE graph_nodes SET is_protected = 1"
                " WHERE node_id = ? AND node_type = 'person'",
                (nid,),
            )
    except Exception:
        pass
    conn.commit()


def load(conn, owner_key: str):
    """加载该归属者的子图:(by_id, by_name, edges)。

    owner_key 必填(而不是默认全图):归属隔离必须由调用点显式声明。
    节点只加载被本人边引用到的那些。
    """
    by_id = {}
    by_name = {}
    edges = []
    try:
        rows = conn.execute(
            "SELECT node_id, name, is_protected FROM graph_nodes"
            " WHERE (node_id IN (SELECT source_id FROM graph_edges WHERE owner_key = ?)"
            " OR node_id IN (SELECT target_id FROM graph_edges WHERE owner_key = ?))"
            # v0.16.0 M2:归一后的墓碑节点不参与检索 —— 合并必须对
            # BFS 真的生效(否则「西电」还会被扩散到)。列不存在的老库
            # 由 COALESCE 兜住(迁移会补列)。
            " AND COALESCE(is_active, 1) = 1",
            (owner_key, owner_key),
        ).fetchall()
        for row in rows:
            node = {"node_id": str(row[0]), "name": str(row[1]),
                    "is_protected": int(row[2] or 0)}
            by_id[node["node_id"]] = node
            by_name[node["name"]] = node
        rows = conn.execute(
            "SELECT edge_id, source_id, target_id, relation, weight,"
            " half_life, recall_count, last_accessed, intrinsic_value,"
            " slot, is_active, superseded_by, layer,"
            " occurred_at, temporal_status"
            " FROM graph_edges WHERE owner_key = ?",
            (owner_key,),
        ).fetchall()
        for row in rows:
            edges.append({
                "edge_id": int(row[0]), "source_id": str(row[1]),
                "target_id": str(row[2]),
                "relation": str(row[3] or default_relation()),
                "weight": float(row[4] or 1.0),
                # v6.0:真相只有这三样,R 由它们现算(不读 activation)
                "half_life": float(row[5] or 0.0),
                "recall_count": int(row[6] or 0),
                "last_accessed": float(row[7] or 0.0),
                "intrinsic_value": float(row[8] or 0.0),
                # ---- v8.4.0 ----
                "slot": str(row[9] or ""),
                "is_active": int(row[10] if row[10] is not None else 1),
                "superseded_by": int(row[11] or 0),
                "layer": str(row[12] or ""),
                "occurred_at": float(row[13] or 0.0),
                "temporal_status": str(row[14] or "time_unknown"),
            })
    except Exception:
        return {}, {}, []
    return by_id, by_name, edges


def learn(conn, triples, owner_key, emotion=5.0, evidence_ids=None, diag=None) -> int:
    """从三元组学习,返回写入边数(边记在 owner_key 名下)。

    三元组与情景记忆共用同一套 Judge 字段(certainty / attribution /
    stability / evidenceQuotes)→ 共用同一个内在价值 I,不再「各记各的」。
    兼容旧形式 [[s, rel, t]](无字段可用,给保守 I=10)。
    occurredAt 为 epoch 秒(相对时间由壳/b4 Judge 换算后传入)。

    v0.16.0 M1:`evidence_ids` = 本轮反思落库的情景记忆 id 列表 ——
    每条边都记下「听谁说的」,图谱页据此点回原文。缺省 None 表示
    调用方没有 id 可给(老调用点/测试),边依据留空而不是瞎填。
    """
    done = 0
    for item in triples or []:
        try:
            fields = None
            if isinstance(item, dict):
                s = str(item.get("s") or item.get("source") or "")[:32]
                rel = str(item.get("relation") or default_relation())[:16]
                t = str(item.get("t") or item.get("target") or "")[:32]
                fields = item
            elif isinstance(item, (list, tuple)) and len(item) == 3:
                s, rel, t = (str(x).strip()[:32] for x in item)
            else:
                continue
            if not s or not t:
                continue

            i_val = 10.0
            _layer = ""
            _occ = 0.0
            _tstat = ""
            if fields is not None:
                # v8.4:layer 真正参与存储(L0 豁免/pinned 判定靠它)。
                _layer = str(fields.get("layer") or "")
                _tstat = str(fields.get("temporalStatus")
                             or fields.get("temporal_status") or "")
                occ = fields.get("occurredAt") or fields.get("occurred_at") or 0
                try:
                    _occ = max(0.0, float(occ or 0.0))
                except (TypeError, ValueError):
                    _occ = 0.0
                quotes = fields.get("evidenceQuotes") or []
                if not isinstance(quotes, list):
                    quotes = []
                i_val = dmae.compute_intrinsic_value(
                    layer=_layer or "L2",
                    certainty=str(fields.get("certainty") or ""),
                    attribution=str(fields.get("attribution") or ""),
                    stability=str(fields.get("stability") or ""),
                    emotion=emotion,
                    quote_count=len(quotes),
                )
            add_edge(conn, s, rel, t, owner_key, i_val,
                     layer=_layer, occurred_at=_occ, temporal_status=_tstat,
                     evidence=evidence_ids)
            if diag is not None:
                # v2-A3:把「这条边有没有依据」计进诊断口(纯计数,不改写库行为)。
                evidence_mod.count_into(diag, evidence_ids)
            done += 1
        except Exception:
            continue
    return done


# ═══════════════════════════════════════════════════════════════════════
# 种子侧
# ═══════════════════════════════════════════════════════════════════════

def extract_seed_nodes(user_input, max_seeds=5):
    """机械种子提取(LLM 通道失败/关闭时的兜底)。

    v8.9.4:>8 字长块的 2 字滑窗退役(任意截断不是分词,'又给'/'你修'
    这类碎片永远匹配不上节点名 —— 186 轮法医:扩散 0 次)。保留两样
    真有用的:标点切出的 2~8 字完整块、ASCII 整词。中文语义切分交给
    LLM 通道(壳侧跑,词表喂入做实体链接)。
    """
    text = (user_input or "").strip()
    if not text:
        return []
    words = re.findall(r"[A-Za-z0-9]{2,}", text)
    chunks = re.split(r"[，。！？、；：\s\"\"''（）《》,.!?;:()\[\]{}]+", text)
    seeds = []
    for ch in chunks:
        ch = ch.strip()
        if 2 <= len(ch) <= 8 and ch not in seeds and ch not in _stopwords():
            seeds.append(ch)
        if len(seeds) >= max_seeds:
            break
    for w in words:
        if len(seeds) >= max_seeds:
            break
        if w.lower() not in (s.lower() for s in seeds):
            seeds.append(w)
    return seeds[:max_seeds]


def match_seeds_to_graph(raw_seeds, nodes_by_name, max_seeds=8):
    """种子 → 节点名模糊链接(双向子串,最短名优先)。

    2026-09-27 F8:**匹配不上的种子不再原样返回**。
    旧版末尾有一段「兜底保留原词」,把没链接上的词也塞进结果 —— 而它唯一的
    调用方(`worker.py:874`)把返回值当作「本轮图种子」,`graph_activate` 又只认
    `nodes_by_name` 里的真节点名(`:580` 处 `if not node: continue` 静默跳过)。
    于是那些词:

      * 对 BFS **毫无贡献**(既不做种子边也不扩散);
      * 却让 `seedNames`(`worker.py:900` 进帧)把它们**报成"本轮种子"** ——
        诊断信号从"实体链接结果"退化成"原样回显";
      * 一次真实检索里 `seedNames` 会混进 `'有什么想说的吗'`、`'QQ'`、
        `'——'` 这类词,而 F6 的验收恰恰要靠 `seedNames` 判通道②是否接上。

    函数名承诺的是「把种子匹配到图」,返回不匹配的词就是违约。要诊断未匹配的
    词,调用方自己做差集即可 —— 别让"匹配"这个动词说谎。
    """
    matched = []
    matched_set = set()
    node_names = list(nodes_by_name.keys())

    for seed in raw_seeds:
        s = str(seed).strip()
        if not s or s in matched_set:
            continue
        if s in nodes_by_name:
            matched.append(s)
            matched_set.add(s)
            if len(matched) >= max_seeds:
                break
            continue
        best = None
        best_len = 999
        for nn in node_names:
            if nn in matched_set:
                continue
            if s in nn or nn in s:
                if len(nn) < best_len:
                    best = nn
                    best_len = len(nn)
        if best:
            matched.append(best)
            matched_set.add(best)
        if len(matched) >= max_seeds:
            break

    return matched[:max_seeds]


def direct_seed_hits(text, nodes_by_name, max_hits=8):
    """v8.9.3:拿节点名直接扫消息文本 —— 「提到就命中」,零成本零损耗。

    消息里字面出现了「西电」就命中「西电」;种子提取降级为补充通道。
    ASCII 节点名不区分大小写(echo 命中 Echo);单字节点不参与直扫
    (会大面积误命中)。
    """
    t = str(text or "").lower()
    if not t:
        return []
    hits = []
    for name in nodes_by_name:
        n = str(name or "").strip()
        if len(n) < 2:
            continue
        if n.lower() in t:
            hits.append(n)
            if len(hits) >= max_hits:
                break
    return hits


# ═══════════════════════════════════════════════════════════════════════
# BFS 扩散
# ═══════════════════════════════════════════════════════════════════════

def graph_activate(
    seed_names, nodes_by_id, nodes_by_name, edges,
    now_ts=0.0, params=None,
    decay=ACTIVATION_DECAY, threshold=ACTIVATION_THRESHOLD,
    max_hops=ACTIVATION_MAX_HOPS, top_k=ACTIVATION_TOP_K,
):
    """从种子节点出发做 best-first 关联扩散。

    返回 (paths, seed_edge_ids):
      paths         —— pinned(L0 强注)在前 + BFS 结果按分排序(独占配额)
      seed_edge_ids —— 「被直接提到」的边(种子邻接边,无论 R 多低
                       都算一次想起 —— Archived 的唯一唤醒通道)
    """
    p = params or dmae.DMAE_DEFAULT
    now = float(now_ts) or time.time()
    if not edges:
        return [], set()

    # v8.4 槽位取代:被取代的边退出扩散(仍留档,翻得出来,但不作为
    # 「当前事实」参与激活 —— 这是「换代」不是「删除」)。
    live_edges = [e for e in edges if int(e.get("is_active", 1) or 0) == 1]

    # v8.4 L0 核心边强制注入:身份/称呼/长期关系不因「本轮没命中种子词」
    # 而消失。pinned 不算「被想起」—— 调用方跳过它们,不写 recall_count、
    # 不做 LTP,否则每轮注入等于每轮强化,L0 指标彻底失真。
    pinned = []
    for e in sorted(
        (e for e in live_edges if str(e.get("layer") or "") == "L0"),
        key=lambda x: -float(x.get("intrinsic_value") or 0.0),
    )[:L0_GRAPH_ALWAYS_ON_LIMIT]:
        eid = e.get("edge_id")
        if eid is None:
            continue
        src_node = nodes_by_id.get(str(e.get("source_id") or ""))
        tgt_node = nodes_by_id.get(str(e.get("target_id") or ""))
        if src_node is None or tgt_node is None:
            continue
        pinned.append({
            "path": [str(src_node["name"]), str(tgt_node["name"])],
            "relations": [str(e.get("relation") or default_relation())],
            "score": 0.0,
            "edge_ids": [int(eid)],
            "temporal_status": str(e.get("temporal_status") or "time_unknown"),
            "occurred_at": float(e.get("occurred_at") or 0.0),
            "learned_at": float(e.get("learned_at") or 0.0),
            "pinned": True,
        })

    edges = live_edges
    if not seed_names or not edges:
        return pinned, set()
    adj = {}
    for e in edges:
        try:
            # v8.9.3:邻接表双向化。旧版只按 source 建,而这张图几乎所有
            # 知识边的 source 都是「用户」节点 ——「用户」二字又永远不会
            # 字面出现在消息里,于是提到「西电」(目标端)时从它出发
            # 无路可走:186 轮真实对话 BFS 扩散一次都没跑起来。
            # 事实边在语义上是双向的:被提到时,两个端点都算「被提到」。
            adj.setdefault(str(e["source_id"]), []).append(e)
            adj.setdefault(str(e["target_id"]), []).append(e)
        except (KeyError, TypeError, AttributeError):
            continue

    # 先收集「被提到」的边:种子节点的全部邻接边,不看 R。
    seed_edge_ids = set()
    for name in seed_names:
        node = nodes_by_name.get(str(name).strip())
        if not node:
            continue
        for e in adj.get(str(node["node_id"]), []):
            eid = e.get("edge_id")
            if eid is not None:
                seed_edge_ids.add(int(eid))

    results = []
    heap = []
    visited_best = {}
    for name in seed_names:
        node = nodes_by_name.get(str(name).strip())
        if not node:
            continue
        nid = str(node["node_id"])
        heapq.heappush(heap, (-1.0, 0, nid, [node["name"]], [], []))
        visited_best[nid] = 1.0
    while heap and len(results) < max(15, top_k * 3):
        # 取消检查点:图谱游走是本引擎最不可预测的一段(堆里可能还有
        # 几千个待扩展节点,取决于图的连通度)。放在轮首:出堆之后、
        # 展开之前,此时抛弃这一轮的中间结果没有副作用。
        cancel.checkpoint()
        neg_score, hops, nid, path, rels, eids = heapq.heappop(heap)
        score = -neg_score
        if score < threshold:
            continue
        if hops > 0:
            results.append(
                {"path": list(path), "relations": list(rels),
                 "score": round(score, 3), "edge_ids": list(eids)}
            )
        if hops >= max_hops:
            continue
        for e in adj.get(nid, []):
            try:
                w = max(0.0, min(10.0, float(e.get("weight", 1.0))))
                tgt = str(e["target_id"])
                # v8.9.3:双向邻接后,从目标端走是「逆向步」—— 真实方向
                # 是 source-[rel]->target,游走方向相反。路径保持游走顺序,
                # 关系带 <- 前缀,渲染时箭头反向画,事实方向绝不失真。
                backward = str(e.get("source_id") or "") != nid
                if backward:
                    tgt = str(e["source_id"])
            except (TypeError, ValueError, AttributeError):
                continue
            # R 闸门:Archived 的边不做中继(它仍可能通过 seed_edge_ids 被唤醒)
            r = dmae.dmae_edge_r(e, now, p)
            if r < p.r_dormant:
                continue
            recall_bonus = p.w_recall * r
            child_score = score * (0.5 + min(max(w, 0.0), 10.0) / 10.0 + recall_bonus) * decay
            if child_score < threshold:
                continue
            if visited_best.get(tgt, 0) >= child_score:
                continue
            visited_best[tgt] = child_score
            tgt_node = nodes_by_id.get(tgt)
            tgt_name = tgt_node["name"] if tgt_node else tgt
            eid = e.get("edge_id")
            # v8.7.2:边随子节点一起入堆,弹出时并入它自己那条路径 ——
            # 旧版把「当前→子节点」的边记到上一条弹出的结果上,逐路径
            # edge_ids 系统性错一跳。
            child_eids = list(eids)
            if eid is not None:
                child_eids.append(int(eid))
            rel = str(e.get("relation") or default_relation())
            if backward:
                rel = "<-" + rel
            heapq.heappush(
                heap,
                (-child_score, hops + 1, tgt,
                 path + [str(tgt_name)],
                 rels + [rel],
                 child_eids),
            )
    results.sort(key=lambda r: -r["score"])
    # pinned(L0 核心)独占自己的配额,不参与 top_k 竞争,也永远不会被挤掉。
    return pinned + results[: max(1, int(top_k))], seed_edge_ids


# ═══════════════════════════════════════════════════════════════════════
# 渲染
# ═══════════════════════════════════════════════════════════════════════

def _fmt_day(ts):
    try:
        value = float(ts or 0.0)
    except (TypeError, ValueError):
        return ""
    if value <= 0:
        return ""
    try:
        return time.strftime("%Y-%m-%d", time.localtime(value))
    except (ValueError, OSError, OverflowError):
        return ""


def _time_note(occurred_at, learned_at, temporal_status) -> str:
    """渲染时间注记 —— 「她记错时间」的机械防线。

    occurred_at 事情**发生**的时间;learned_at 我们**得知**的时间。
    这行字是给模型看的硬边界:数据自己写着「事情发生时间未确认」,
    不需要靠模型自觉。
    """
    occurred = _fmt_day(occurred_at)
    learned = _fmt_day(learned_at)
    label = _TEMPORAL_LABELS.get(str(temporal_status or "").strip(), "")
    tail = f"·{label}" if label else ""
    if occurred:
        return f"（发生时间 {occurred}{tail}）"
    if learned:
        return f"（{learned} 提到,事情发生时间未确认{tail}）"
    return f"（时间未确认{tail}）"


def render_paths(paths) -> str:
    """路径渲染:逆向箭头反向画、[核心] 前缀、单跳才带时间注记。"""
    if not paths:
        return ""
    lines = []
    for p in paths:
        names = p["path"]
        rels = p["relations"]
        segs = [names[0]]
        for rel, name in zip(rels, names[1:]):
            if rel.startswith("<-"):
                # v8.9.3 逆向步:读作「name -[rel]-> 前一个节点」。
                # 例:西电 <-[就读于]- 用户 = 用户就读于西电。
                segs.append(f" <-[{rel[2:]}]- {name}")
            else:
                segs.append(f"-[{rel}]-> {name}")
        line = "".join(segs)
        if p.get("pinned"):
            # [核心] 标记的是「无条件注入的 L0 事实」:恒定背景,
            # 不是本轮话题命中,别拿它当「<称呼>刚提到」来对话。
            line = f"[核心] {line}"
        # 时间注记只给单跳路径 —— 多跳横跨好几条边,「发生时间」说不清是哪条。
        if len(rels) == 1:
            line += _time_note(
                p.get("occurred_at", 0.0),
                p.get("learned_at", 0.0),
                p.get("temporal_status", ""),
            )
        lines.append(line)
    return "\n".join(f"{i}. {line}" for i, line in enumerate(lines, 1))


# ═══════════════════════════════════════════════════════════════════════
# LTP + DMAE 持久化
# ═══════════════════════════════════════════════════════════════════════

def apply_ltp(conn, edge_ids, is_master=True) -> int:
    """长时程增强:被激活的边权重 +0.5,主人相关 +1.0,上限 10。

    v8.7.2:LTP 不写 last_accessed —— 时间簿记归 DMAE 一家管,
    同一轮 recall_updates 会为同批边写入真实的 last_accessed。
    """
    if not edge_ids:
        return 0
    boost = PROTECTED_BOOST if is_master else LTP_BOOST
    boosted = 0
    for eid in set(int(e) for e in edge_ids):
        conn.execute(
            "UPDATE graph_edges SET weight = MIN(?, weight + ?) WHERE edge_id = ?",
            (LTP_MAX_WEIGHT, boost, eid),
        )
        boosted += 1
    conn.commit()
    return boosted


def update_and_persist(conn, user_hit_ids, now_ts, buckets=None) -> dict:
    """DMAE v6.0:强化被想起的边,并清理从未被想起过的噪声。

    不对每条边逐轮累加衰减 —— R 是 (now, last_accessed, half_life) 的
    纯函数,任何时刻现算。本函数只做三件事:
      1. 强化:user_hit 的边 → H 增益、R 归 1、recall_count+1、时钟前移
      2. 物化:10 分钟桶把 R 写进 activation(面板用),跳过本轮命中
         (防旧快照覆盖刚强化的 100)
      3. 剪枝:1 小时桶清「从未想起」的噪声,豁免本轮唤醒
         (all_edges 是强化写库前的旧快照,首次被想起的边在快照里
         仍是「从未想起+长期沉默」的模样 —— 不豁免则「一提就记起」
         在同一事务里先强化再被 DELETE,唤醒被静默撤销)
    buckets:调用方持有的桶状态 dict(键 last_materialize_bucket /
    last_prune_bucket)。worker 把 state dict 传进来跨帧持久。
    """
    p = dmae.DMAE_DEFAULT
    now_ts = float(now_ts)
    buckets = buckets if buckets is not None else {}
    try:
        # 阶段 3a 第二步裁决②·DMAE 卡口(2026-10-01):DMAE 只管**事实边**。
        # 影子边(`kind='cooccur_*'`,归属键 `__shadow__`)**不参与强化/物化/剪枝** ——
        # 否则:① 物化会往影子边写 `activation`(与"S1 不动 DMAE 字段"的意图冲突);
        # ② `prune_min_age_days=60` 之后,从未被想起的影子边会被**当噪声整批删掉**
        # (实测:+61 天推演下 47 条影子边 → 0)。既有事实边 `kind` 全是空串 ⇒ 这段
        # 过滤对它们**零变化**。老库还没迁移出 `kind` 列时退回不过滤(那时也不存在
        # 影子边,过滤没有意义;与 `top_nodes()` 的同一道卡口共用 `_has_column`)。
        _facts_only = (" AND COALESCE(kind, '') = ''"
                       if _has_column(conn, "graph_edges", "kind") else "")
        all_edges = [
            {
                "edge_id": row[0], "activation": row[1],
                "intrinsic_value": row[2], "half_life": row[3],
                "recall_count": row[4], "last_accessed": row[5],
                "weight": row[6],
            }
            for row in conn.execute(
                "SELECT edge_id, activation, intrinsic_value, half_life,"
                " recall_count, last_accessed, weight FROM graph_edges"
                " WHERE 1 = 1" + _facts_only
            ).fetchall()
        ]
        engine = dmae.DmaeEngine(p)
        updates = engine.recall_updates(all_edges, user_hit_ids, now_ts)

        changed = []
        # ---- 1. 强化 ----
        for u in updates:
            conn.execute(
                "UPDATE graph_edges SET activation = ?, half_life = ?,"
                " recall_count = ?, last_accessed = ? WHERE edge_id = ?",
                (u["activation"], u["half_life"], u["recall_count"],
                 u["last_accessed"], u["edge_id"]),
            )
            changed.append({
                "id": u["edge_id"],
                "a_old": round(u["r_before"] * 100.0, 2),
                "a_new": round(u["activation"], 2),
                "state": u["state"],
                "reason": (
                    f"想起时R={u['r_before']:.3f} "
                    f"H {u['h_before']:.1f}h→{u['half_life']:.1f}h"
                ),
            })

        # ---- 2. 物化(约 10 分钟一次)----
        bucket_10m = int(now_ts // 600)
        materialized = False
        if buckets.get("last_materialize_bucket") != bucket_10m:
            buckets["last_materialize_bucket"] = bucket_10m
            materialized = True
            for m in engine.materialize(all_edges, now_ts):
                if m["edge_id"] in user_hit_ids:
                    continue  # 刚强化过的不要被旧快照覆盖
                conn.execute(
                    "UPDATE graph_edges SET activation = ? WHERE edge_id = ?",
                    (m["activation"], m["edge_id"]),
                )

        # ---- 3. 剪枝(约 1 小时一次)----
        bucket_1h = int(now_ts // 3600)
        pruned = 0
        if buckets.get("last_prune_bucket") != bucket_1h:
            buckets["last_prune_bucket"] = bucket_1h
            prune_ids = [
                i for i in engine.plan_prune(all_edges, now_ts)
                if i not in user_hit_ids
            ]
            if prune_ids:
                qmarks = ",".join("?" for _ in prune_ids)
                cur = conn.execute(
                    f"DELETE FROM graph_edges WHERE edge_id IN ({qmarks})",
                    tuple(prune_ids),
                )
                pruned = int(cur.rowcount or 0)
            conn.execute(
                "DELETE FROM graph_nodes WHERE node_id NOT IN"
                " (SELECT source_id FROM graph_edges)"
                " AND node_id NOT IN (SELECT target_id FROM graph_edges)"
                " AND node_type != 'person'"
                " AND is_protected = 0"
            )

        conn.commit()
        return {
            "changed": changed, "pruned": pruned, "now": now_ts,
            "hits": len(user_hit_ids), "edges": len(all_edges),
            "materialized": materialized,
        }
    except Exception:
        return {"changed": [], "pruned": 0, "now": now_ts, "hits": 0,
                "edges": 0, "materialized": False}
