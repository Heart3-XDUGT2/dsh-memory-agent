# -*- coding: utf-8 -*-
"""A5:主题簇**视图**(软归属、可重算、**不进检索**)。

一层一句话:在 A4 的证据层上算出一层"他在聊什么"的簇 —— 每簇一句话(LLM 摘要,
由离线任务写)、一个概念可以属好几簇(软归属),但这一层**只是视图**:
不改任何边、不建本体、不进检索/人格注入。

用法(在 `python/` 目录下):
    python -m engine.topics --db <path>                # 只演:算一遍 + 报表
    python -m engine.topics --db <path> --report <md>  # 顺手写 Markdown 报告
    python -m engine.topics --db <path> --apply         # 真写(整批换代,幂等)
    python -m engine.topics --db <path> --json

算法(写在这里,别在别处长第二份):
  1. **图**:节点 = `graph_nodes`;边 = ① A4 证据层的 pair(权重 = **几条记忆作证**
     = `v_cooc_pairs` 里同一 pair 的行数);② **可选**:现行事实边(`kind` 空、active,
     每条权重 1.0,`include_fact=True` 才进)。
     ⚠️ 默认**只跑证据图**(计划书原文:"在 A4 证据图上跑")。实测掺事实边会把 `用户`
     这个 hub(度 21)当桥,把"游戏"和"软件工程专业 / Echo"拉进同一簇 —— 那种簇没法写摘要。
     想复现这个对照:`--include-fact`。
  2. **贪心模块度**(Louvain 第一相:每轮合并"模块度增益最大"的那一对,确定性 ——
     候选按增益、社区键排序取第一,同输入两次跑逐位一致),再丢掉成员数 < `min_cluster`
     的碎簇。
     ⚠️ 为什么不是标签传播:本仓库的图上实测过 —— 一条**弱桥**(他:一条边连着游戏、
     一条边连着学校)会把两个稠密社区**整个吞成一个**(LP 在平票下没有"社区质量"这个概念)。
     贪心模块度对这种合并不给正增益,所以不会塌。
  3. **软归属**:概念 n 对簇 c 的隶属强度 = 「n 与 c 的**本体成员**之间的共现记忆数」
     ÷ 「n 的全部共现记忆数」;≥ `min_membership` 才收,每节点最多 `max_memberships` 条
     (本体的那个 `is_primary=1`)。
  4. `weight` 列 = 隶属强度(primary 恒 1.0)。计划书写的"成员权重 = 共现记忆数"落成
     **占比**而不是计数:纯计数会让 `用户` 这种 hub(度 21)在每个簇里都最大。

⚠️ 只读纪律:本模块**不进任何检索/渲染路径**;两张新表只被面板/报表读。
⚠️ 簇**不许**写成 `graph_edges` 的边 —— 那就变成手写本体(§9 不做清单)。
"""

import argparse
import json
import os
import sys
import time

from . import db as db_mod

#: 视图自己的命名空间(不混进 `master` / `__cooc__`)。
TOPIC_OWNER = "__topic__"
#: 表名单一出处(建表在 `db.py` 的迁移里)。
CLUSTER_TABLE = "graph_topic_clusters"
MEMBER_TABLE = "graph_topic_members"
LEVEL_CONCEPT = "concept"
ALGORITHM = "greedy-modularity/v1"
#: 固定种子:本算法本身确定性,种子写进 `params` 是为了"重算可复现"这条验收有据可查。
SEED = 20261001
MAX_ITERS = 20
#: 碎簇下限(成员 < 这个数的簇不收 —— 单点/双点多半是噪声)。
MIN_CLUSTER = 3
#: 软归属阈值与上限。
MIN_MEMBERSHIP = 0.25
MAX_MEMBERSHIPS = 3
#: 一条事实边在图里的权重(1.0 = "一条断言");共现边权重是"几条记忆作证"。
FACT_WEIGHT = 1.0
SEP = "、"

#: 摘要的硬约束(离线任务填回;引擎侧**只认这个上限与形状**,不认内容好坏)。
SUMMARY_MAX_CHARS = 60
SUMMARY_SYSTEM = (
    "你在给一个记忆库的『主题簇』写一句摘要。"
    "这一簇是**算法产物**(不是用户说过的话,也不是你下的结论),"
    "你要做的只有一件事:把列出的概念读成一句人话 —— 『他常聊的这一摊是什么』。"
    "硬约束:① 只有一句话,不超过 %d 字;② **不许编**:只能用列出的概念、"
    "以及它们『在同一条记忆里一起出现』这个事实;③ 不许写『他喜欢 / 他讨厌 / 他打算』"
    "这类证据里没有的判断;④ 不要引号、不要换行、不要分点、不要复述这条指令。"
) % SUMMARY_MAX_CHARS

#: 视图的读者名单(检索/渲染侧):出现表名 = 红(与本层"不进检索"的纪律同源)。
READ_SIDE_FILES = (
    "python/engine/graph.py",
    "python/engine/retrieve.py",
    "python/worker.py",
    "lib/store.js",
    "lib/soul-snapshot.js",
)
FORBIDDEN_NAMES = ("graph_topic_clusters", "graph_topic_members")


# ── 读盘 ────────────────────────────────────────────────────────────────────

def node_names(conn):
    try:
        return {str(r[0]): str(r[1] or r[0]) for r in conn.execute(
            "SELECT node_id, name FROM graph_nodes")}
    except Exception:
        return {}


def evidence_witness(conn, owner="__cooc__"):
    """每个概念被**几条证据**作证(= 共现记忆数)。"""
    out = {}
    try:
        for (ids_text,) in conn.execute(
                "SELECT node_ids FROM graph_cooc_evidence WHERE owner_key = ?", (owner,)):
            for nid in str(ids_text or "").split(SEP):
                nid = nid.strip()
                if nid:
                    out[nid] = out.get(nid, 0) + 1
    except Exception:
        pass
    return out


def cooc_pair_weights(conn, owner="__cooc__"):
    """`pair_key -> 作证记忆数`(派生只走视图 `v_cooc_pairs`)。"""
    out = {}
    try:
        for key, n in conn.execute(
                "SELECT pair_key, COUNT(*) FROM v_cooc_pairs WHERE owner_key = ?"
                " GROUP BY pair_key", (owner,)):
            out[str(key)] = int(n)
    except Exception:
        pass
    return out


def fact_edges(conn):
    """现行事实边(``kind`` 空、未归档)—— 主题图里算"一条断言"。"""
    try:
        return [(str(r[0]), str(r[1])) for r in conn.execute(
            "SELECT source_id, target_id FROM graph_edges"
            " WHERE COALESCE(kind, '') = '' AND COALESCE(is_active, 1) = 1")]
    except Exception:
        return []


def build_graph(conn, *, include_fact=False, cooc_owner="__cooc__"):
    """产出 `(nodes, adj, witness, evidence_rows)`;全是只读。"""
    names = node_names(conn)
    witness = evidence_witness(conn, cooc_owner)
    adj = {}

    def _add(a, b, w):
        if a == b or a not in names or b not in names:
            return
        adj.setdefault(a, {})
        adj[a][b] = adj[a].get(b, 0.0) + float(w)
        adj.setdefault(b, {})
        adj[b][a] = adj[b].get(a, 0.0) + float(w)

    for key, n in cooc_pair_weights(conn, cooc_owner).items():
        a, _, b = str(key).partition("|")
        _add(a, b, n)
    fact_n = 0
    if include_fact:
        seen = set()
        for a, b in fact_edges(conn):
            k = tuple(sorted((a, b)))
            if k in seen:
                continue
            seen.add(k)
            fact_n += 1
            _add(a, b, FACT_WEIGHT)
    nodes = sorted(n for n in adj if n in names)
    return {"names": names, "nodes": nodes, "adj": adj, "witness": witness,
            "cooc_pairs": len(cooc_pair_weights(conn, cooc_owner)), "fact_edges": fact_n,
            "edges": sum(len(v) for v in adj.values()) // 2}


# ── 算 ──────────────────────────────────────────────────────────────────────

def _communities(nodes, adj):
    """贪心模块度(确定性):每轮合并增益最大的社区对,直到没有正增益。

    增益用加权模块度的标准式:`w_AB/m − (a_A·a_B)/(2m²)`
    (`w_AB` = 社区间边权和,`a_X` = 社区内节点度数和,`m` = 总边权)。
    确定性:候选按 `(−增益, 社区键A, 社区键B)` 排序取第一;社区键 = 社区里最小的节点号。
    """
    nodes = sorted(nodes)
    m = sum(sum(v.values()) for v in adj.values()) / 2.0
    if m <= 0:
        return {n: n for n in nodes}
    deg = {n: sum(float(w) for w in adj.get(n, {}).values()) for n in nodes}
    members = {n: {n} for n in nodes}
    while True:
        key_of = {n: k for k, ms in members.items() for n in ms}
        inter = {}
        for a in nodes:
            for b, w in adj.get(a, {}).items():
                ka, kb = key_of[a], key_of[b]
                if ka == kb:
                    continue
                kk = (ka, kb) if ka < kb else (kb, ka)
                inter[kk] = inter.get(kk, 0.0) + float(w) / 2.0
        mass = {k: sum(deg[n] for n in ms) for k, ms in members.items()}
        best = None
        for (ka, kb), wab in sorted(inter.items()):
            delta = wab / m - (mass[ka] * mass[kb]) / (2.0 * m * m)
            if delta <= 1e-12:
                continue
            cand = (-delta, ka, kb)
            if best is None or cand < best:
                best = cand
        if best is None:
            break
        _, ka, kb = best
        merged = members.pop(ka) | members.pop(kb)
        members[min(ka, kb)] = merged
    return {n: k for k, ms in members.items() for n in ms}


def _label_propagation(nodes, adj, *, max_iters=MAX_ITERS):
    """**不再使用**:标签传播(留着当反例,防止有人"顺手简化"回它)。

    在 A5 的夹具上它把"游戏组 / 学校组"通过一条弱桥合并成一个簇 —— 见模块头第 2 条。
    """
    order = sorted(nodes)
    rank = {n: i for i, n in enumerate(order)}
    labels = {n: n for n in order}
    for _ in range(max(1, int(max_iters))):
        changed = False
        for n in order:
            tally = {}
            for m, w in adj.get(n, {}).items():
                lab = labels.get(m, m)
                tally[lab] = tally.get(lab, 0.0) + float(w)
            if not tally:
                continue
            best = min(tally.items(), key=lambda kv: (-kv[1], rank.get(kv[0], 1 << 30)))
            if labels[n] != best[0]:
                labels[n] = best[0]
                changed = True
        if not changed:
            break
    return labels


def _soft_memberships(nodes, adj, primaries, *, min_membership=MIN_MEMBERSHIP,
                      max_memberships=MAX_MEMBERSHIPS):
    """概念 → 附属簇(≤max 条)。分子分母都用"共现记忆数",所以只有共现边参与。"""
    prim_sets = {c: set(ms) for c, ms in primaries.items()}
    out = {}
    for n in sorted(nodes):
        neigh = adj.get(n, {})
        denom = sum(float(w) for w in neigh.values())
        if denom <= 0:
            continue
        cands = []
        for c, members in prim_sets.items():
            if n in members:
                continue
            num = sum(float(w) for m, w in neigh.items() if m in members)
            if num <= 0:
                continue
            share = num / denom
            if share >= float(min_membership):
                cands.append((c, share))
        cands.sort(key=lambda kv: (-kv[1], kv[0]))
        if cands:
            out[n] = cands[:max(1, int(max_memberships))]
    return out


def compute(conn, *, include_fact=False, min_cluster=MIN_CLUSTER,
            min_membership=MIN_MEMBERSHIP, max_memberships=MAX_MEMBERSHIPS,
            max_iters=MAX_ITERS, cooc_owner="__cooc__"):
    """算一遍(纯读):返回视图计划 —— 不改库、不建边。"""
    g = build_graph(conn, include_fact=include_fact, cooc_owner=cooc_owner)
    nodes, adj, names, witness = g["nodes"], g["adj"], g["names"], g["witness"]
    labels = _communities(nodes, adj)

    groups = {}
    for n, lab in labels.items():
        groups.setdefault(lab, []).append(n)
    kept, dropped = {}, []
    for lab, members in sorted(groups.items()):
        if len(members) >= int(min_cluster):
            kept[lab] = sorted(members)
        else:
            dropped.extend(sorted(members))

    primaries = kept
    soft = _soft_memberships(nodes, adj, primaries,
                             min_membership=min_membership,
                             max_memberships=max_memberships)
    # 软归属的**份额单一出处**:{簇 key: {节点: 强度}} —— 落库与报表都从这里取。
    soft_shares = {}
    for n, ms in soft.items():
        for ckey, share in ms:
            soft_shares.setdefault(str(ckey), {})[str(n)] = float(share)

    clusters = []
    for lab, members in sorted(kept.items(), key=lambda kv: (-len(kv[1]), kv[0])):
        ranked = sorted(members, key=lambda n: (-int(witness.get(n, 0)), names.get(n, n), n))
        top = [names.get(n, n) for n in ranked[:2]]
        soft_here = [n for n, ms in soft.items() if any(c == lab for c, _ in ms)]
        clusters.append({
            "key": str(lab), "label": " · ".join(top) if top else str(lab),
            "members": [{"node_id": n, "name": names.get(n, n),
                         "weight": 1.0, "is_primary": 1} for n in ranked],
            "soft": sorted(soft_here, key=lambda n: names.get(n, n)),
            "size": len(members),
        })
    params = {"algorithm": ALGORITHM, "seed": SEED, "tie_break": "delta-desc,key-asc",
              "min_cluster": int(min_cluster), "min_membership": float(min_membership),
              "max_memberships": int(max_memberships), "include_fact": bool(include_fact),
              "fact_weight": FACT_WEIGHT, "level": LEVEL_CONCEPT}
    return {"params": params, "nodes": len(nodes), "edges": g["edges"],
            "cooc_pairs": g["cooc_pairs"], "fact_edges": g["fact_edges"],
            "clusters": clusters, "unclustered": dropped,
            "soft_total": sum(len(v) for v in soft.values()),
            "soft_shares": soft_shares,
            "labels": {n: labels[n] for n in sorted(labels)}}


# ── 落库(整批换代)──────────────────────────────────────────────────────────

def apply_plan(conn, plan, *, owner=TOPIC_OWNER, now=None,
               summary_map=None):
    """真写:旧批 `is_active=0`、新批写入(批号 `topic-<秒>`)。

    `summary_map`: {簇 label 或 key: 摘要} —— A5a 里通常是空的(`''` = 还没写摘要),
    摘要在离线任务(A5b)里补。
    """
    now = float(now or time.time())
    batch = "topic-%d" % int(now)
    deactivated = int(conn.execute(
        "UPDATE " + CLUSTER_TABLE + " SET is_active = 0"
        " WHERE owner_key = ? AND COALESCE(is_active, 1) = 1", (owner,)).rowcount or 0)
    summaries = dict(summary_map or {})
    clusters = members = soft = 0
    for c in plan["clusters"]:
        conn.execute(
            "INSERT INTO " + CLUSTER_TABLE +
            " (owner_key, level, label, summary, algorithm, params, member_count,"
            "  batch_key, computed_at, is_active) VALUES (?,?,?,?,?,?,?,?,?,1)",
            (owner, plan["params"].get("level") or LEVEL_CONCEPT, str(c["label"]),
             str(summaries.get(c["label"], summaries.get(c["key"], ""))),
             ALGORITHM, json.dumps(plan["params"], ensure_ascii=False, sort_keys=True),
             int(c["size"]), batch, now))
        cid = int(conn.execute("SELECT last_insert_rowid()").fetchone()[0])
        for m in c["members"]:
            conn.execute(
                "INSERT OR REPLACE INTO " + MEMBER_TABLE +
                " (cluster_id, member_kind, member_id, weight, is_primary, owner_key)"
                " VALUES (?, 'node', ?, ?, ?, ?)",
                (cid, str(m["node_id"]), float(m["weight"]), int(m["is_primary"]), owner))
            members += 1
        # 软归属:weight = 隶属强度(算在计划里)
        for nid, share in _soft_shares(plan, c):
            conn.execute(
                "INSERT OR REPLACE INTO " + MEMBER_TABLE +
                " (cluster_id, member_kind, member_id, weight, is_primary, owner_key)"
                " VALUES (?, 'node', ?, ?, 0, ?)",
                (cid, str(nid), float(share), owner))
            soft += 1
    db_mod._mark_migration(conn, "a5_topic_view_v1", now=now)
    conn.commit()
    return {"clusters": len(plan["clusters"]), "members": members, "soft_members": soft,
            "deactivated": deactivated, "batch_key": batch, "ran_at": now}


def deactivate(conn, *, owner=TOPIC_OWNER, now=None):
    """整批退役(回退用):现行批次 `is_active=0`,**不动**任何簇行/成员行。

    A7 的"一键回退"要的就是这个:视图层是可重算的算法产物,退役 = 读口看不见了,
    审计还在(行不删)。返回退役掉的簇数。
    """
    now = float(now or time.time())
    rows = int(conn.execute(
        "UPDATE " + CLUSTER_TABLE + " SET is_active = 0"
        " WHERE owner_key = ? AND COALESCE(is_active, 1) = 1", (owner,)).rowcount or 0)
    conn.commit()
    return {"deactivated": rows, "ran_at": now}


def _soft_shares(plan, cluster):
    """从计划里取"附属到这一簇"的 `(node_id, share)`。

    份额**只在 `compute()` 里算一次**(`plan['soft_shares']`),这里只搬运 ——
    不在这里重算,免得出现第二份真相。
    """
    shares = (plan.get("soft_shares") or {}).get(str(cluster["key"])) or {}
    return sorted(shares.items())


# ── 报表 ────────────────────────────────────────────────────────────────────

def active_view(conn, *, owner=TOPIC_OWNER):
    """现行批次读回来(**带 cluster_id**)—— 摘要流程按 id 对齐,不靠簇名猜。"""
    out = []
    try:
        rows = conn.execute(
            "SELECT cluster_id, label, COALESCE(summary, ''), member_count, batch_key,"
            " computed_at, params FROM " + CLUSTER_TABLE +
            " WHERE owner_key = ? AND COALESCE(is_active, 1) = 1"
            " ORDER BY member_count DESC, cluster_id", (owner,)).fetchall()
    except Exception:
        return out
    for cid, label, summary, count, batch, computed, params in rows:
        prim, soft = [], []
        for name, is_primary in conn.execute(
                "SELECT COALESCE(n.name, m.member_id), COALESCE(m.is_primary, 0)"
                " FROM " + MEMBER_TABLE + " m"
                " LEFT JOIN graph_nodes n ON n.node_id = m.member_id"
                " WHERE m.cluster_id = ? ORDER BY COALESCE(n.name, m.member_id)",
                (int(cid),)):
            (prim if int(is_primary) else soft).append(str(name))
        out.append({"cluster_id": int(cid), "label": str(label), "summary": str(summary),
                    "size": int(count or 0), "batch_key": str(batch),
                    "computed_at": float(computed or 0), "params": str(params),
                    "members": prim, "soft": soft})
    return out


def build_prompts(view):
    """给每个现行簇产一条提示词(system + user)。**引擎侧是提示词的单一出处**。"""
    prompts = []
    for c in view:
        members = list(c["members"]) + ["(软归属)" + m for m in c.get("soft", [])]
        user = ("这是记忆库里的一个『主题簇』(算法从共现里算出来的,不是谁手写的):\n"
                "概念:%s\n" % SEP.join(members))
        if c.get("soft"):
            user += ("带 `(软归属)` 的成员是算法判的『沾边』(它主要属别的簇),"
                     "写摘要时可以用,但别把它当这一簇的主干。\n")
        user += "请给这一簇写那一句话。"
        prompts.append({"cluster_id": int(c["cluster_id"]), "label": c["label"],
                        "system": SUMMARY_SYSTEM, "user": user,
                        "members": list(c["members"])})
    return prompts


def clean_summary(text):
    """把模型给的一句话规整到可入库的形状;不合格返回 `('', reason)`。"""
    raw = str(text or "").strip().strip('"').strip("「").strip("」").strip("『").strip("』")
    raw = " ".join(raw.split())
    if not raw:
        return "", "empty"
    if len(raw) > SUMMARY_MAX_CHARS:
        return "", "too-long"
    if "\n" in str(text or ""):
        return "", "not-one-line"
    if "算法产物" in raw:
        return "", "meta-talk"
    return raw, ""


def apply_summaries(conn, mapping, *, owner=TOPIC_OWNER, now=None):
    """把摘要填回**现行**批次的簇行(按 `cluster_id` 对齐)。

    纪律:① 只认现行批次里的 id(填错地方 = 造谣);② 一条不合格就**不写那一条**并
    记原因,绝不"净化后照写";③ 文本一样就不写(幂等)。
    """
    now = float(now or time.time())
    written, unchanged, rejected = 0, 0, []
    for key, text in (mapping or {}).items():
        try:
            cid = int(key)
        except (TypeError, ValueError):
            rejected.append({"key": str(key), "reason": "bad-key"})
            continue
        row = conn.execute(
            "SELECT COALESCE(summary, '') FROM " + CLUSTER_TABLE +
            " WHERE cluster_id = ? AND owner_key = ? AND COALESCE(is_active, 1) = 1",
            (cid, owner)).fetchone()
        if row is None:
            rejected.append({"key": cid, "reason": "not-active-cluster"})
            continue
        text2, why = clean_summary(text)
        if why:
            rejected.append({"key": cid, "reason": why})
            continue
        if str(row[0]) == text2:
            unchanged += 1
            continue
        conn.execute("UPDATE " + CLUSTER_TABLE + " SET summary = ?, computed_at = computed_at"
                     " WHERE cluster_id = ?", (text2, cid))
        written += 1
    conn.commit()
    return {"written": written, "unchanged": unchanged, "rejected": rejected}


def report(conn, *, owner=TOPIC_OWNER):
    out = {"owner": owner, "active_clusters": 0, "active_members": 0,
           "primary_members": 0, "soft_members": 0, "batches": [], "top": [],
           "summaries": 0}
    try:
        out["active_clusters"] = int(conn.execute(
            "SELECT COUNT(*) FROM " + CLUSTER_TABLE +
            " WHERE owner_key = ? AND COALESCE(is_active, 1) = 1", (owner,)).fetchone()[0])
        out["active_members"] = int(conn.execute(
            "SELECT COUNT(*) FROM " + MEMBER_TABLE + " m JOIN " + CLUSTER_TABLE + " c"
            " ON c.cluster_id = m.cluster_id"
            " WHERE c.owner_key = ? AND COALESCE(c.is_active, 1) = 1", (owner,)).fetchone()[0])
        out["primary_members"] = int(conn.execute(
            "SELECT COUNT(*) FROM " + MEMBER_TABLE + " m JOIN " + CLUSTER_TABLE + " c"
            " ON c.cluster_id = m.cluster_id WHERE c.owner_key = ?"
            " AND COALESCE(c.is_active, 1) = 1 AND COALESCE(m.is_primary, 0) = 1",
            (owner,)).fetchone()[0])
        out["soft_members"] = out["active_members"] - out["primary_members"]
        for batch, n, active, computed in conn.execute(
                "SELECT batch_key, COUNT(*), MAX(COALESCE(is_active, 1)), MAX(computed_at)"
                " FROM " + CLUSTER_TABLE + " WHERE owner_key = ?"
                " GROUP BY batch_key ORDER BY computed_at DESC LIMIT 5", (owner,)):
            out["batches"].append({"batch_key": str(batch), "clusters": int(n),
                                   "active": bool(int(active or 0)),
                                   "computed_at": float(computed or 0)})
        out["summaries"] = int(conn.execute(
            "SELECT COUNT(*) FROM " + CLUSTER_TABLE + " WHERE owner_key = ?"
            " AND COALESCE(is_active, 1) = 1 AND COALESCE(summary, '') <> ''",
            (owner,)).fetchone()[0])
        for cid, label, size, summary in conn.execute(
                "SELECT cluster_id, label, member_count, COALESCE(summary, '') FROM "
                + CLUSTER_TABLE + " WHERE owner_key = ? AND COALESCE(is_active, 1) = 1"
                " ORDER BY member_count DESC, cluster_id LIMIT 12", (owner,)):
            names = [str(r[0]) for r in conn.execute(
                "SELECT COALESCE(n.name, m.member_id) FROM " + MEMBER_TABLE + " m"
                " LEFT JOIN graph_nodes n ON n.node_id = m.member_id"
                " WHERE m.cluster_id = ? AND COALESCE(m.is_primary, 0) = 1"
                " ORDER BY COALESCE(n.name, m.member_id)", (int(cid),))]
            out["top"].append({"cluster_id": int(cid), "label": str(label),
                               "size": int(size), "summary": str(summary),
                               "members": names})
    except Exception:
        pass
    return out


def to_text(rep, plan=None):
    out = ["== A5 主题簇视图(软归属 · 可重算 · **不进检索**)=="]
    out.append("① 现行 %d 簇 / %d 个成员(本体 %d + 软归属 %d);有摘要的 %d 簇"
               % (rep["active_clusters"], rep["active_members"], rep["primary_members"],
                  rep["soft_members"], rep["summaries"]))
    if rep["batches"]:
        out.append("② 批次(新在前):%s"
                   % json.dumps(rep["batches"][:3], ensure_ascii=False))
    if plan is not None:
        out.append("③ 本次算:%d 节点 / %d 边(共现 %d 对 + 事实 %d 条)→ %d 簇"
                   "(%d 个概念落在碎簇里被收着不用)"
                   % (plan["nodes"], plan["edges"], plan["cooc_pairs"], plan["fact_edges"],
                      len(plan["clusters"]), len(plan["unclustered"])))
        out.append("   参数:%s" % json.dumps(plan["params"], ensure_ascii=False,
                                          sort_keys=True))
        for i, c in enumerate(plan["clusters"][:8], 1):
            out.append("   %2d. %-28s 本体 %2d + 软 %2d | %s"
                       % (i, c["label"][:28], c["size"], len(c["soft"]),
                          "、".join(m["name"] for m in c["members"][:6])))
    for row in rep["top"][:8]:
        out.append("   · #%d %-28s %d 人:%s%s"
                   % (row["cluster_id"], row["label"][:28], row["size"],
                      "、".join(row["members"][:6]),
                      ("  ‖ 摘要:" + row["summary"][:40]) if row["summary"] else ""))
    return "\n".join(out)


def main(argv=None):
    ap = argparse.ArgumentParser(description="A5 主题簇视图(默认只演)")
    ap.add_argument("--db", default=None)
    ap.add_argument("--apply", action="store_true")
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--report", default=None)
    ap.add_argument("--min-cluster", type=int, default=MIN_CLUSTER)
    ap.add_argument("--min-membership", type=float, default=MIN_MEMBERSHIP)
    ap.add_argument("--max-memberships", type=int, default=MAX_MEMBERSHIPS)
    ap.add_argument("--include-fact", action="store_true",
                    help="把事实边也掺进主题图(默认不掺:会引入 hub —— 见模块头)")
    ap.add_argument("--prompts", default=None,
                    help="把现行簇的提示词写到这个 JSON(A5b 离线摘要用)")
    ap.add_argument("--summaries", default=None,
                    help="从这个 JSON 读回 {cluster_id: 摘要}(A5b 填回;带校验)")
    args = ap.parse_args(argv)

    path = args.db or os.path.join(os.path.expanduser("~"), ".dsh", "echo", "echo.db")
    conn = db_mod.connect(path)
    try:
        plan = compute(conn, include_fact=args.include_fact,
                       min_cluster=args.min_cluster,
                       min_membership=args.min_membership,
                       max_memberships=args.max_memberships)
        written = apply_plan(conn, plan) if args.apply else None
        prompts = None
        if args.prompts:
            prompts = build_prompts(active_view(conn))
            with open(args.prompts, "w", encoding="utf-8") as fh:
                json.dump({"note": "每簇一条:system 是硬约束,user 是材料;"
                                   "只准回 {cluster_id: 一句话}",
                           "prompts": prompts}, fh, ensure_ascii=False, indent=2)
        summ = None
        if args.summaries:
            with open(args.summaries, encoding="utf-8-sig") as fh:
                raw = json.load(fh)
            mapping = raw.get("summaries", raw) if isinstance(raw, dict) else {}
            summ = apply_summaries(conn, mapping)
        rep = report(conn)
        text = to_text(rep, plan)
        if args.report:
            with open(args.report, "w", encoding="utf-8") as fh:
                fh.write("# A5 主题簇视图 · 报告\n\n库:`%s`\n\n%s\n" % (path, text))
        if args.json:
            print(json.dumps({"db": path, "plan": plan, "report": rep, "written": written,
                              "prompts": prompts, "summaries": summ},
                             ensure_ascii=False, indent=2))
        else:
            print("库 %s\n%s" % (path, text))
            if summ is not None:
                print("\n摘要填回:%s" % json.dumps(summ, ensure_ascii=False))
            print("\n%s" % ("已写:" + json.dumps(written, ensure_ascii=False)
                            if written else
                            "下一步:核对后 --apply(整批换代:旧批置 0、新批写入)"))
        return 0
    finally:
        try:
            conn.close()
        except Exception:
            pass


if __name__ == "__main__":
    sys.exit(main())
