# -*- coding: utf-8 -*-
"""阶段 3a 第一步:候选边挖掘(同记忆共现)—— **默认关,只挖不猜**。

定位
====

写入侧流水线是两段:`挖掘(mine)→ 闸门(gate)`。本模块只管**挖**,裁决全在
`graph_gate`(R1–R6)——两边职责不重叠:挖掘负责"哪些节点对在同一处出现过 + 证据是哪几条记忆",
闸门负责"这条边配不配进图"。

口径(与 `scripts/graph-baseline.mjs` 的**契约 v1.1 同记忆口径**逐条对齐)
======================================================================

* **实体识别 = 朴素子串匹配**:拿 `graph_nodes` 的**名字**在 `summary` 里 `in` 一下
  (无分词、无大小写折叠 —— 与契约同款,不引入"更聪明"的分词,否则数字对不上基线);
* **别名归一 = 只剔除"名字本身是别名键"的重名节点**(如 `西电` / `助手`),
  **不把 summary 里的别名串展开成 canonical**(契约默认口径;展开会把 30/5 抬到 34/8);
* **同记忆 = 一条记忆内命中的节点两两成对**;`count` = 该对**共现的记忆条数**;
  `evidence_memory_id` = 该对同时出现的那批 memory_id(升序);
* **两端必须是既有节点**(`graph_nodes` 里存在、且是概念类:concept / person)。
  **本模块绝不建节点**(建节点是 `graph.create_node` 的职权,写入侧另有开关)。

给闸门(R2)的两端证据
=====================

`R2 零重合不得注入` 要的是**每一端各自的记忆集合**,不是两端的并集:

* `source_memory_ids` = **本批里命中过 source 那一端**的 memory_id 列表(可以不要求
  target 也在场 —— 这正是 R2 能看出"两端其实没在同一处出现过"的地方);
* `target_memory_ids` = 同理,target 那一端命中过的 memory_id 列表;
* `evidence_memory_id` = 两端**同时**出现的 memory_id(交集 = 这条共现边的依据);
* 所以 `intersection(source_memory_ids, target_memory_ids) == evidence_memory_id`(不变式,单测钉住)。

**契约 v1.1 里没有前两个字段**(它只有并集式的 `evidence_memory_id`)⇒ 这正是
"契约不能直接当闸门输入"的原因(见 1b 评审):只喂并集,R2 会退化成"证据非空即过"。
**这两端记忆集由 3a 提供,闸门不替它推。**

不写库
======

本模块**只读、只在内存里拼候选**;落库是 `graph_gate.write_accepted_edges` 的事,
且只在开关(`ECHO_GRAPH_GATE`)开、闸门通过时才发生。CLI 只有 `--dry-run` 一种模式:
在真库上走**只读连接**、内存里过闸门、报数字,**绝不写**。
"""
from __future__ import annotations

import json
import os
import sqlite3
import sys
import time

from . import graph_gate as gate

#: 挖矿版本号(候选里带它,便于对账"这批数字是哪版口径算的")。
MINE_VERSION = "3a-step1-2026-10-01"

#: 概念类节点类型(两端必须是这些之一;`episode` / `belief` 不是概念端点)。
CONCEPT_NODE_TYPES = (gate.NODE_TYPE_CONCEPT, gate.NODE_TYPE_PERSON)

#: 记忆过滤口径(与契约同款:活跃 + `status='active'` + summary 非空)。
MEMORY_FILTER = "is_active = 1 AND status = 'active' AND summary IS NOT NULL AND summary <> ''"


def build_matchers(nodes, aliases):
    """构造匹配池:`[(needle, canonical_name)]` —— 契约的别名归一口径。

    * `aliases` 的**键**是要被剔除的重名节点名(它们该由 canonical 代表);
    * 名字本身是别名键的节点**不进池**;
    * **不**把别名串当 needle(不展开 —— 展开是 `--expand-aliases` 的非默认口径)。

    `nodes` 接受 `(node_id, name, node_type)` 或 `{"node_id","name","node_type"}`。
    """
    rows = [_node_row(n) for n in (nodes or [])]
    alias_keys = {gate._text(a[0]) for a in (aliases or []) if gate._text(a[0])}
    matchers = []
    for row in rows:
        if row["name"] and row["name"] not in alias_keys:
            matchers.append((row["name"], row["name"]))
    return matchers


def _node_row(node):
    if isinstance(node, dict):
        return {"node_id": gate._text(node.get("node_id")),
                "name": gate._text(node.get("name")),
                "node_type": gate._text(node.get("node_type")) or gate.DEFAULT_NODE_TYPE}
    return {"node_id": gate._text(node[0]), "name": gate._text(node[1]),
            "node_type": gate._text(node[2]) or gate.DEFAULT_NODE_TYPE}


def hit_nodes(text, nodes, aliases=None) -> list:
    """一条文本命中的**既有概念节点**(canonical 名去重,按 node_id 稳定排序)。

    与配对口径**同一把尺子**:给了 `aliases` 就同样剔除"名字本身是别名键"的重名节点
    (它们该由 canonical 代表);不给就只按"存在 + 概念类"筛。
    """
    text = str(text or "")
    alias_keys = {gate._text(a[0]) for a in (aliases or []) if gate._text(a[0])}
    out = {}
    for node in (_node_row(n) for n in (nodes or [])):
        if not node["node_id"] or not node["name"]:
            continue
        if node["node_type"] not in CONCEPT_NODE_TYPES:
            continue
        if node["name"] in alias_keys:
            continue
        if node["name"] in text:
            out.setdefault(node["node_id"], node)
    return [out[k] for k in sorted(out)]


def mine_same_memory_candidates(memories, nodes, aliases) -> list:
    """同记忆共现候选(**纯函数**:给记忆行 + 节点表 + 别名表,出不写库的候选)。

    `memories`: `[(memory_id, summary, timestamp, occurred_at)]` 或同名字典序列。
    返回候选列表(**已按闸门入参形状构造**,不是契约 NDJSON 形状),每条::

        {
          "kind": "cooccur_same_memory",
          "source_id", "target_id",               # 裸 node_id
          "source_name", "target_name",
          "source_kind", "target_kind",           # 都是 "node"
          "endpoint_kind": "node",                # 兼容字段(两端同值)
          "source_type", "target_type",           # 节点类型(concept / person)
          "relation": "共现",                      # 保留谓词名(R5:不挤事实边槽位)
          "source_memory_ids", "target_memory_ids",  # 两端各自的记忆集(给 R2)
          "evidence_memory_id",                   # 两端同时出现的记忆(升序)
          "weight", "count",                      # = 共现记忆条数(契约说两者恒等)
          "speaker_node_excluded": False,         # 闸门自己按 R1 判,这里不预判
          "occurred_at", "occurred_at_source",    # episodic_memory;取不到 ⇒ null
          "mine_version": MINE_VERSION,
        }
    """
    alias_keys = {gate._text(a[0]) for a in (aliases or []) if gate._text(a[0])}
    node_rows = [_node_row(n) for n in (nodes or [])]
    pool = [n for n in node_rows
            if n["node_id"] and n["name"] and n["node_type"] in CONCEPT_NODE_TYPES]
    # 匹配池:名字本身是别名键的节点剔除(由 canonical 代表;不展开别名串)
    matchers = [(n["name"], n) for n in pool if n["name"] not in alias_keys]
    by_id = {n["node_id"]: n for n in pool}

    pairs = {}                     # (src_id, tgt_id) -> [memory_id...](两端同时出现)
    node_mems = {}                 # node_id -> set(memory_id)(该端"在本批里"命中过的记忆)
    occ = {}                       # memory_id -> 该记忆的 occurred_at(>0 才记)
    for mem in (memories or []):
        mid, summary, occurred_at = _memory_row(mem)
        if mid is None:
            continue
        if occurred_at and occurred_at > 0:
            occ[mid] = occurred_at
        text = str(summary or "")
        hit = {}
        for needle, node in matchers:
            if needle in text:
                hit.setdefault(node["node_id"], node)
        ids = sorted(hit)
        for nid in ids:
            node_mems.setdefault(nid, set()).add(mid)
        for i in range(len(ids)):
            for j in range(i + 1, len(ids)):
                pairs.setdefault((ids[i], ids[j]), []).append(mid)
    out = []
    for (src, tgt), both in sorted(pairs.items()):
        left, right = by_id[src], by_id[tgt]
        evidence = sorted(set(both))
        occurred_at, source = _time_of(evidence, occ)
        out.append({
            "kind": gate.KIND_COOCCUR_SAME_MEMORY,
            "source_id": src, "target_id": tgt,
            "source_name": left["name"], "target_name": right["name"],
            "source_kind": "node", "target_kind": "node",
            "endpoint_kind": "node",
            "source_type": left["node_type"], "target_type": right["node_type"],
            "relation": gate.SHADOW_RELATIONS[gate.KIND_COOCCUR_SAME_MEMORY],
            "evidence_scope": gate.EVIDENCE_SCOPE_SAME_MEMORY,
            "source_memory_ids": sorted(node_mems.get(src, set())),
            "target_memory_ids": sorted(node_mems.get(tgt, set())),
            "evidence_memory_id": evidence,
            "weight": float(len(evidence)), "count": len(evidence),
            "speaker_node_excluded": False,
            "occurred_at": occurred_at, "occurred_at_source": source,
            "mine_version": MINE_VERSION,
        })
    return out


def _memory_row(mem):
    """记忆行归一 ⇒ `(memory_id, summary, occurred_at)`;认不出 id 就返回 None。"""
    if isinstance(mem, dict):
        raw_id = mem.get("memory_id")
        return (_as_id(raw_id), str(mem.get("summary") or ""),
                _as_float(mem.get("occurred_at")))
    try:
        return (_as_id(mem[0]), str(mem[1] or ""), _as_float(mem[3] if len(mem) > 3 else 0.0))
    except (TypeError, IndexError):
        return (None, "", 0.0)


def _time_of(evidence_ids, occ_by_memory):
    """时间只从 `episodic_memory` 取:证据里**时间最晚且非零**那条;取不到 ⇒ null。

    (契约同款:来源必定落在 `evidence_memory_id` 里;不拿图侧死列、也不拿 learned_at。)
    """
    best = 0.0
    for mid in evidence_ids:
        value = float(occ_by_memory.get(mid) or 0.0)
        if value > best:
            best = value
    if best <= 0:
        return (None, None)
    return (best, gate.TIME_SOURCE_EPISODIC)


def _as_id(value):
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _as_float(value):
    try:
        return float(value or 0.0)
    except (TypeError, ValueError):
        return 0.0


# ═══════════════════════════════════════════════════════════════════════
# 同天共现(阶段 3a 第二步;口径 = 契约 v1.1 同天口径)
# ═══════════════════════════════════════════════════════════════════════

#: 证据数组上限(契约 v1.1 默认 `--evidence-cap 16`)。
EVIDENCE_CAP = 16


def local_day(timestamp) -> str:
    """本地日期 `'YYYY-MM-DD'`(与契约同款:**本地时区,不是 UTC**)。"""
    return time.strftime("%Y-%m-%d", time.localtime(float(timestamp or 0.0)))


def day_midnight_epoch(day: str) -> float:
    """那一天**本地 00:00** 的 epoch 秒(契约:同天边的 `occurred_at` 直接取"那一天")。"""
    parts = [int(x) for x in str(day).split("-")]
    y, m, d = parts[0], parts[1], parts[2]
    return float(time.mktime((y, m, d, 0, 0, 0, 0, 0, -1)))


def mine_same_day_candidates(memories, nodes, aliases, *, evidence_cap=EVIDENCE_CAP) -> list:
    """同天共现候选(**纯函数**)。

    口径(契约 v1.1):

    * **按本地日期分组**,日内取"当天所有记忆命中的节点**并集**"再两两成对
      (跨记忆的共现也算 —— 这正是同天口径比同记忆口径大得多的原因);
    * `day` = 锚定日期(**取最近那一天**);`occurred_at` = 当天本地 00:00 的 epoch;
      `occurred_at_source='same_day_group'`;
    * `count = weight = 覆盖天数`(**不是**记忆条数、也不是证据数组长度);
    * `evidence_memory_id` = "能支撑两端的**一小组**":每个命中日取"提到 A 的最晚一条 +
      提到 B 的最晚一条";按日期**从新到旧**拼接去重,超 `evidence_cap` 就裁掉尾部
      —— **裁剪时最近那一天的两条(两端各一条依据)必须保住**;
      `evidence_truncated` = 是否发生了裁剪;
    * 两端必须是既有概念节点;**绝不建节点**。

    ⚠️ **R2 口径提醒(见 3a 报告)**:同天边的"同一处"是**那一天**,不是某一条记忆。
    本函数照裁决给出两端各自的记忆集(那天提到该端的记忆),但因此
    `intersection(两端)` 对"只在同一天、不在同一条记忆里相遇"的边是空的 ⇒ 闸门 R2
    (交集判据)会把它们判成零重合。**这类边要不要过 R2 需要单独裁决**;
    本函数只保证"数字算得准、可选口径都在报告里",不替闸门做决定。
    """
    alias_keys = {gate._text(a[0]) for a in (aliases or []) if gate._text(a[0])}
    pool = [n for n in (_node_row(n) for n in (nodes or []))
            if n["node_id"] and n["name"] and n["node_type"] in CONCEPT_NODE_TYPES]
    matchers = [(n["name"], n) for n in pool if n["name"] not in alias_keys]
    # 记忆序:契约按 (timestamp, memory_id) 排;"最晚一条"取的就是这个序的最后一条
    ordered = []
    for mem in (memories or []):
        mid, summary, timestamp, occurred_at = _memory_row4(mem)
        if mid is None:
            continue
        ordered.append((float(timestamp or 0.0), int(mid), mid, str(summary or "")))
    ordered.sort()
    days = {}                      # day -> {"nodes": {id: node}, "mems": {id: []}, "order": [mid...]}
    for _ts, _mid, mid, summary in ordered:
        day = local_day(_ts)
        slot = days.setdefault(day, {"nodes": {}, "mems": {}, "order": []})
        slot["order"].append(mid)
        for needle, node in matchers:
            if needle in summary:
                slot["nodes"].setdefault(node["node_id"], node)
                slot["mems"].setdefault(node["node_id"], []).append(mid)
    # 成对:同一对内 per-day 只算一次(覆盖天数)
    pairs = {}                     # (src,tgt) -> {"days": [day...], "contrib": {day: [ids]}}
    for day in sorted(days):
        slot = days[day]
        ids = sorted(slot["nodes"])
        for i in range(len(ids)):
            for j in range(i + 1, len(ids)):
                key = (ids[i], ids[j])
                entry = pairs.setdefault(key, {"days": [], "contrib": {}})
                entry["days"].append(day)
                a, b = slot["mems"].get(ids[i]) or [], slot["mems"].get(ids[j]) or []
                entry["contrib"][day] = sorted({a[-1], b[-1]})
    out = []
    for (src, tgt), entry in sorted(pairs.items()):
        left, right = days[entry["days"][-1]]["nodes"][src], days[entry["days"][-1]]["nodes"][tgt]
        evidence, truncated = _same_day_evidence(entry, evidence_cap)
        day = entry["days"][-1]                     # 锚 = 最近那一天
        out.append({
            "kind": gate.KIND_COOCCUR_SAME_DAY,
            "source_id": src, "target_id": tgt,
            "source_name": left["name"], "target_name": right["name"],
            "source_kind": "node", "target_kind": "node",
            "endpoint_kind": "node",
            "source_type": left["node_type"], "target_type": right["node_type"],
            "relation": gate.SHADOW_RELATIONS[gate.KIND_COOCCUR_SAME_DAY],
            "evidence_scope": gate.EVIDENCE_SCOPE_SAME_DAY,
            "day": day,
            "source_memory_ids": sorted({m for d in entry["days"]
                                         for m in (days[d]["mems"].get(src) or [])}),
            "target_memory_ids": sorted({m for d in entry["days"]
                                         for m in (days[d]["mems"].get(tgt) or [])}),
            "evidence_memory_id": evidence,
            "evidence_truncated": truncated,
            "weight": float(len(entry["days"])), "count": len(entry["days"]),
            "speaker_node_excluded": False,
            "occurred_at": day_midnight_epoch(day),
            "occurred_at_source": gate.TIME_SOURCE_SAME_DAY,
            "mine_version": MINE_VERSION,
        })
    return out


def _same_day_evidence(entry, cap):
    """按日期**从新到旧**拼证据;超上限裁尾部但保住**最近一天的两条**(两端各一)。"""
    days_desc = sorted(entry["contrib"], reverse=True)
    full = []
    for day in days_desc:
        for mid in entry["contrib"][day]:
            if mid not in full:
                full.append(mid)
    if len(full) <= cap:
        return (sorted(full), False)
    keep = []
    for mid in entry["contrib"][days_desc[0]]:      # 最近一天的两条:必须留
        if mid not in keep:
            keep.append(mid)
    for mid in full:
        if len(keep) >= cap:
            break
        if mid not in keep:
            keep.append(mid)
    return (sorted(keep), True)


def _memory_row4(mem):
    """记忆行归一 ⇒ `(memory_id, summary, timestamp, occurred_at)`。"""
    if isinstance(mem, dict):
        return (_as_id(mem.get("memory_id")), str(mem.get("summary") or ""),
                _as_float(mem.get("timestamp")), _as_float(mem.get("occurred_at")))
    try:
        return (_as_id(mem[0]), str(mem[1] or ""), _as_float(mem[2] if len(mem) > 2 else 0.0),
                _as_float(mem[3] if len(mem) > 3 else 0.0))
    except (TypeError, IndexError):
        return (None, "", 0.0, 0.0)


#: 两类挖掘器的对外名字(`--kind` 用)。
KIND_SAME_MEMORY = "same_memory"
KIND_SAME_DAY = "same_day"
MINE_KINDS = (KIND_SAME_MEMORY, KIND_SAME_DAY)


def mine_candidates(memories, nodes, aliases, *, kinds=MINE_KINDS) -> list:
    """两类候选合并输出(顺序稳定:先同记忆,后同天)。"""
    out = []
    if KIND_SAME_MEMORY in kinds:
        out.extend(mine_same_memory_candidates(memories, nodes, aliases))
    if KIND_SAME_DAY in kinds:
        out.extend(mine_same_day_candidates(memories, nodes, aliases))
    return out


# ═══════════════════════════════════════════════════════════════════════
# 只读快照 + 与闸门对接(写入侧那条路)
# ═══════════════════════════════════════════════════════════════════════

def read_snapshot(conn, *, max_memory_id=None, memory_id=None, latest_only=False) -> dict:
    """只读一张挖矿快照:`{"nodes", "aliases", "memories", "latest_memory_id"}`。

    * `memory_id`  ⇒ 只取那一条(运行时路径:刚写入的那条记忆);
    * `latest_only`⇒ 取**最新的一条**活跃记忆;
    * 都不给       ⇒ 取全部(离线对账用);`max_memory_id` 用来钉住"历史快照"口径。
    缺表(老库/测试库)时对应部分是空的 —— 不抛:挖不到边不该把主流程带崩。
    """
    snapshot = {"nodes": [], "aliases": [], "memories": [], "latest_memory_id": None}
    try:
        snapshot["nodes"] = conn.execute(
            "SELECT node_id, name, node_type FROM graph_nodes").fetchall()
    except sqlite3.Error:
        snapshot["nodes"] = []
    try:
        snapshot["aliases"] = conn.execute(
            "SELECT alias, canonical_name FROM graph_aliases").fetchall()
    except sqlite3.Error:
        snapshot["aliases"] = []
    try:
        sql = ("SELECT memory_id, summary, timestamp, occurred_at FROM episodic_memory"
               " WHERE " + MEMORY_FILTER)
        params = []
        if memory_id is not None:
            sql += " AND memory_id = ?"
            params.append(int(memory_id))
        elif latest_only:
            sql += " ORDER BY memory_id DESC LIMIT 1"
        else:
            if max_memory_id:
                sql += " AND memory_id <= ?"
                params.append(int(max_memory_id))
            sql += " ORDER BY memory_id"
        snapshot["memories"] = conn.execute(sql, tuple(params)).fetchall()
        if snapshot["memories"]:
            snapshot["latest_memory_id"] = int(snapshot["memories"][-1][0])
    except sqlite3.Error:
        snapshot["memories"] = []
    return snapshot


def candidates_for_latest_memory(conn, *, memory_id=None, max_memory_id=None) -> list:
    """运行时入口:**刚写入的那条记忆**(或显式 `memory_id`)⇒ 一批候选(**只同记忆类**)。

    裁决(2026-10-01):运行时口径 = **只挖刚写入的那一条记忆**;同天边属于
    "一次性历史回填"那条路(一条记忆本身构不成"同天")。**窗口反复挖被禁止**
    (同一对会被反复重计)—— 本模块因此不提供 `--last N` 之类的窗口入口。

    只读 `conn`(调用方给的连接;本函数不建连接、不提交事务)。
    """
    snapshot = read_snapshot(conn, memory_id=memory_id,
                             latest_only=memory_id is None,
                             max_memory_id=max_memory_id)
    return mine_same_memory_candidates(snapshot["memories"], snapshot["nodes"],
                                       snapshot["aliases"])


def candidates_for_history(conn, *, max_memory_id=None, kinds=MINE_KINDS) -> list:
    """**一次性历史回填**入口:整段历史上所有活跃记忆 ⇒ 一批候选。

    `kinds` 默认两类都要(一次性回填就该把路网一次建全)。
    """
    snapshot = read_snapshot(conn, max_memory_id=max_memory_id)
    return mine_candidates(snapshot["memories"], snapshot["nodes"],
                           snapshot["aliases"], kinds=kinds)


# ═══════════════════════════════════════════════════════════════════════
# 只读 dry-run(CLI;真库上跑,**绝不写**)
# ═══════════════════════════════════════════════════════════════════════

def dry_run(db_path, *, max_memory_id=None, memory_id=None, latest_only=False,
            kinds=MINE_KINDS, names=None) -> dict:
    """只读连接 + 内存里过闸门,报数字。**连一句 INSERT 都没有**(只读 URI 双保险)。

    `names`(P1 收口拍板 3):名字集合随调用方进来,形状与引擎帧一致 ——
    `{"speakers": [...], "personNames": [...]}`(外加 `ownerNames` 也接受,本函数不用它)。
    以前这里没有口子:名字空 ⇒ R1 说话人规则**恒不触发**、契约口径恒为中性(0),
    离线对账只能靠改模块全局。
    **空 / 缺 / 坏形状 ⇒ 中性退化**(`speakers=∅` ⇒ 没有节点被当说话人),永不抛。
    """
    speaker_names, person_names = gate.names_from_obj(names)
    uri = "file:%s?mode=ro" % os.path.abspath(db_path).replace("\\", "/")
    conn = sqlite3.connect(uri, uri=True)
    conn.execute("PRAGMA busy_timeout = 5000")
    if memory_id is not None or latest_only:
        # 运行时口径:单条记忆构不成"同天" ⇒ 只可能是同记忆类
        kinds = (KIND_SAME_MEMORY,)
    try:
        if memory_id is not None:
            candidates = candidates_for_latest_memory(conn, memory_id=memory_id)
            scope = "memory_id=%s" % memory_id
        elif latest_only:
            candidates = candidates_for_latest_memory(conn)
            scope = "latest-memory(运行时口径:只同记忆类)"
        else:
            candidates = candidates_for_history(conn, max_memory_id=max_memory_id, kinds=kinds)
            scope = ("history" + ("(<=%s)" % max_memory_id if max_memory_id else "")
                     + " kinds=" + "+".join(kinds))
        ctx = gate.build_context_from_db(conn, speakers=speaker_names,
                                        person_names=person_names)
        edge_rows_before = _read_active_edges(conn)
    finally:
        conn.close()
    gated = gate.gate_edges(candidates, ctx, enabled=True)
    counters = gated["counters"]
    reasons = counters["reasons"]
    speakers = _speaker_endpoint_candidates(candidates, speaker_names)
    r2_drop = int(reasons.get(gate.REASON_ZERO_OVERLAP, 0))
    r2_checkable = _r2_checkable(candidates)
    # 另一条口径:同天边**不做交集判据**(同天边的"同一处"是那一天,不是某一条记忆)。
    # 做法 = 同天候选不带两端 ids ⇒ R2 走"证据非空 ⇒ 过"那条路。这里只**测**,不改闸门。
    lenient = _lenient_variant(candidates, ctx, kinds)
    lenient["merged_view"] = _edge_readings(edge_rows_before, lenient.get("accepted") or [],
                                           ctx, speaker_names)
    readings = _edge_readings(edge_rows_before, gated["accepted"], ctx, speaker_names)
    return {
        "db": os.path.abspath(db_path),
        "mode": "dry-run(只读;不写库)",
        "scope": scope,
        "kinds": list(kinds),
        "mine_version": MINE_VERSION,
        "context": {
            "nodes": len(ctx.get("by_name") or {}),
            "aliases": len(ctx.get("aliases") or {}),
            "existing_fact_slots": len(ctx.get("existing_fact_slots") or ()),
        },
        "candidates": len(candidates),
        "candidates_by_kind": _by_kind(candidates),
        "speaker_node_excluded_contract_flag": speakers,
        "r1_excluded": int(reasons.get(gate.REASON_SPEAKER_NODE, 0)),
        "r1_excluded_by_kind": _by_kind(
            [{"kind": r.get("kind"), "reason": r.get("reason")}
             for r in gated["receipts"]], gate.REASON_SPEAKER_NODE),
        "r2_checked": len(gated["accepted"]) + r2_drop,
        "r2_hit_zero_overlap_dropped": r2_drop,
        "r2_passed": len(gated["accepted"]),
        "would_write": len(gated["accepted"]),
        "would_write_by_kind": _by_kind(gated["accepted"]),
        "rewritten": len(gated["rewritten"]),
        "counters": counters,
        "receipts": len(gated["receipts"]),
        "r2_self_test": _r2_self_test(candidates, ctx, speaker_names),
        "lenient_same_day": lenient,
        "merged_view": readings,
        "examples": [
            {"src": c.get("source_name"), "tgt": c.get("target_name"),
             "count": c.get("count"), "evidence": c.get("evidence_memory_id")}
            for c in sorted(candidates, key=lambda x: -int(x.get("count") or 0))[:5]
        ],
    }


def _by_kind(items, reason=None):
    """按 `kind` 计数(`reason` 给了就只数"被该原因丢掉的那些"—— 靠 `items` 里已带 kind)。"""
    out = {}
    for c in (items or []):
        k = gate._text(c.get("kind")) or "(空)"
        if reason is not None and gate._text(c.get("reason")) != reason:
            continue
        out[k] = out.get(k, 0) + 1
    return out


def _r2_checkable(candidates):
    return sum(1 for c in candidates
               if c.get("source_memory_ids") is not None
               and c.get("target_memory_ids") is not None)


def _lenient_variant(candidates, ctx, kinds):
    """**对照口径**(仅测量、不改闸门):同天候选去掉两端 ids 会写入多少。

    裁决①选了"kind-aware R2"(用对的谓词判)而不是"拔掉 ids" ⇒ 这条对照现在是**核对**:
    两条路应当给出同一个数(42),既证明 kind-aware 判据等价于放开同天交集,
    也证明 R2 仍然活着(去掉 ids 的那条路才是"退化"的那条)。
    """
    if not any(c.get("kind") == gate.KIND_COOCCUR_SAME_DAY for c in candidates):
        return {"ran": False}
    probe = []
    for c in candidates:
        item = dict(c)
        if item.get("kind") == gate.KIND_COOCCUR_SAME_DAY:
            item.pop("source_memory_ids", None)
            item.pop("target_memory_ids", None)
        probe.append(item)
    gated = gate.gate_edges(probe, ctx, enabled=True)
    return {
        "ran": True,
        "would_write": len(gated["accepted"]),
        "would_write_by_kind": _by_kind(gated["accepted"]),
        "accepted": gated["accepted"],
        "r2_checked": _r2_checkable(probe),
        "reasons": gated["counters"]["reasons"],
        "note": "对照口径:同天候选去掉两端 ids(退化路径)⇒ 只用来核对 kind-aware R2 的数字一致",
    }


def _read_active_edges(conn):
    """只读:当前活跃边的 `(source_id, target_id, relation, owner_key)` + 节点名表。"""
    rows, names = [], {}
    try:
        rows = conn.execute(
            "SELECT source_id, target_id, relation, COALESCE(owner_key,'') FROM graph_edges"
            " WHERE COALESCE(is_active,1) = 1").fetchall()
    except sqlite3.Error:
        rows = []
    try:
        names = {gate._text(r[0]): gate._text(r[1])
                 for r in conn.execute("SELECT node_id, name FROM graph_nodes")}
    except sqlite3.Error:
        names = {}
    return {"rows": rows, "names": names}


def _edge_readings(before, accepted, ctx, speaker_names=None) -> dict:
    """合并视图:**两类全启用后**活跃边会变成多少 / 不含说话人节点的活跃边会变成多少。

    `speaker_names`(P1 收口):说话人池由调用方给(帧路/离线 CLI);空 ⇒ 没有说话人 ⇒
    "不含说话人"那一列等于总数(中性退化,不再偷偷用模块全局)。
    """
    rows = (before or {}).get("rows") or []
    names = (before or {}).get("names") or {}

    def is_speaker_pair(src, tgt):
        return (gate.is_speaker_name(names.get(gate._text(src), ""), speaker_names)
                or gate.is_speaker_name(names.get(gate._text(tgt), ""), speaker_names))

    active = len(rows)
    active_no_speaker = sum(1 for r in rows if not is_speaker_pair(r[0], r[1]))
    taken = {(gate._text(r[0]), gate._text(r[1]), gate._text(r[2]), gate._text(r[3]))
             for r in rows}
    new = {}
    for c in (accepted or []):
        src = gate._text(c.get("source_id")) or gate._text(c.get("source_name"))
        tgt = gate._text(c.get("target_id")) or gate._text(c.get("target_name"))
        rel = gate._text(c.get("relation"))
        new[(src, tgt, rel, "")] = c
    fresh = {k: c for k, c in new.items() if k not in taken}
    fresh_no_speaker = {k: c for k, c in fresh.items()
                        if not is_speaker_pair(c.get("source_id"), c.get("target_id"))}
    return {
        "active_edges_before": active,
        "active_edges_after": active + len(fresh),
        "active_edges_delta": len(fresh),
        "active_edges_without_speaker_before": active_no_speaker,
        "active_edges_without_speaker_after": active_no_speaker + len(fresh_no_speaker),
        "accepted_rows": len(new),
        "slot_row_collisions_with_existing": len(new) - len(fresh),
        "duplicate_accepted_rows": len(accepted or []) - len(new),
        "note": ("同记忆与同天两类的 relation 不同(共现 / 同日共现)⇒ 槽位不同 ⇒ 同一对会各占一行;"
                 "只有 `slot_row_collisions_with_existing` 会被 `UNIQUE(source_id,target_id,"
                 "relation,owner_key)` 吞掉"),
    }


def _speaker_endpoint_candidates(candidates, speaker_names=None):
    """契约里的 `speaker_node_excluded` 口径(共现端点是否说话人节点)—— 只用于对账。

    `speaker_names` 同上:由调用方给;空 ⇒ 恒 0(中性,而不是拿模块全局凑数)。
    """
    n = 0
    for c in candidates:
        names = (gate._text(c.get("source_name")), gate._text(c.get("target_name")))
        if any(gate.is_speaker_name(x, speaker_names) for x in names):
            n += 1
    return n


def _r2_self_test(candidates, ctx, speaker_names=None) -> dict:
    """证明 R2 **是活的**(不是空转):把一条候选的两端记忆改成互不相交,它必须被丢。

    为什么要自检:挖掘出来的候选天然满足"交集非空"(不变式),所以 R2 在这批输入上
    恒不触发 —— 只看 `R2 丢 = 0` 会让人误以为 R2 没在跑。这里当场造一个反面样本。
    注意证据仍非空(non-empty evidence):**只有严格口径**才会丢它,
    所以这条自检同时证明"两端 ids 真的被用来判了"(退化口径会让它通过)。
    """
    if not candidates:
        return {"ran": False, "dropped": None, "reason": None}
    # 挑一条**能过 R1** 的候选当样本(否则先被 R1 丢掉,看到的 reason 会是 speaker-node,
    # 证明不了 R2 在跑)
    sample = None
    for c in candidates:
        names = (gate._text(c.get("source_name")), gate._text(c.get("target_name")))
        if not any(gate.is_speaker_name(x, speaker_names) for x in names):
            sample = c
            break
    if sample is None:
        return {"ran": False, "dropped": None, "reason": None,
                "note": "没有一条候选能过 R1,无法做 R2 自检"}
    probe = dict(sample)
    probe["source_memory_ids"] = [900001]
    probe["target_memory_ids"] = [900002]
    probe["evidence_memory_id"] = [900001, 900002]
    verdict = gate.gate_edge(probe, ctx, enabled=True)
    return {"ran": True, "dropped": not verdict["accepted"], "reason": verdict["reason"]}


def render_dry_run(report) -> str:
    mv = report["merged_view"]
    lines = [
        "阶段 3a 候选挖掘 dry-run(只读,不写库)",
        "  库: " + report["db"] + "   范围: " + report["scope"],
        "  口径版本: " + report["mine_version"],
        "  闸门上下文: 节点 %d / 别名 %d / 既有事实边槽位 %d(未迁移的库这里会是 0)"
        % (report["context"]["nodes"], report["context"]["aliases"],
           report["context"]["existing_fact_slots"]),
        "  候选 = %d 条 %s(契约口径 speaker_node_excluded = %d 条)"
        % (report["candidates"], json.dumps(report["candidates_by_kind"], ensure_ascii=False),
           report["speaker_node_excluded_contract_flag"]),
        "  R1 排除(说话人端点)= %d 条 %s"
        % (report["r1_excluded"], json.dumps(report["r1_excluded_by_kind"], ensure_ascii=False)),
        "  R2 检查 = %d 条(**过 R1 之后**、两端 memory ids 齐备;同记忆判交集、同天判两端各自非空);"
        "命中零重合被丢 = %d;通过 = %d"
        % (report["r2_checked"], report["r2_hit_zero_overlap_dropped"], report["r2_passed"]),
        "  R2 自检(造一对「两端互不相交」的候选,证明 R2 是活的): %s"
        % ("未跑(候选为 0)" if not report["r2_self_test"]["ran"] else
           "被丢 = %s(reason=%s)" % (report["r2_self_test"]["dropped"],
                                    report["r2_self_test"]["reason"])),
        "  **会写入 = %d 条** %s(被闸门改写 = %d);回执 = %d 行"
        % (report["would_write"], json.dumps(report["would_write_by_kind"], ensure_ascii=False),
           report["rewritten"], report["receipts"]),
        "  裁决计数: " + json.dumps(report["counters"], ensure_ascii=False),
    ]
    if report["lenient_same_day"].get("ran"):
        lm = report["lenient_same_day"]["merged_view"]
        lines.append("  〔对照口径·仅测量〕同天边去掉两端 ids ⇒ 会写入 = %d 条 %s"
                     " (与上面同天数一致即证明 kind-aware R2 没被拔牙)"
                     % (report["lenient_same_day"]["would_write"],
                        json.dumps(report["lenient_same_day"]["would_write_by_kind"],
                                   ensure_ascii=False)))
        lines.append("    该口径下的合并视图:活跃边 %d → **%d**;不含说话人节点的活跃边 %d → **%d**"
                     % (lm["active_edges_before"], lm["active_edges_after"],
                        lm["active_edges_without_speaker_before"],
                        lm["active_edges_without_speaker_after"]))
    lines += [
        "  ── 合并视图(两类全启用后)──",
        "  活跃边: %d → **%d**(净增 %d;与既有边撞槽位被吞 %d;重复候选 %d)"
        % (mv["active_edges_before"], mv["active_edges_after"], mv["active_edges_delta"],
           mv["slot_row_collisions_with_existing"], mv["duplicate_accepted_rows"]),
        "  不含说话人节点的活跃边: %d → **%d**"
        % (mv["active_edges_without_speaker_before"], mv["active_edges_without_speaker_after"]),
        "  top 共现对: " + ", ".join(
            "%s–%s(%d)" % (e["src"], e["tgt"], e["count"]) for e in report["examples"]),
        "  (dry-run 全程只读连接;库文件不该有任何改动)",
    ]
    return "\n".join(lines)


def main(argv) -> int:
    argv = list(argv)
    if "--help" in argv or "-h" in argv:
        print("用法: python -m engine.graph_mine --dry-run --db <path>"
              " [--kinds same_memory+same_day]"
              " [--max-memory-id N | --memory-id N | --latest] [--names FILE] [--json]")
        print("      --kinds     一次性历史回填要挖哪几类(默认 same_memory+same_day)")
        print("      --latest     运行时口径:只挖刚写入的那条记忆(只有同记忆类)")
        print("      --names     名字集合文件(就是数据目录的 names.json)—— 不给 ⇒ 中性退化")
        print("                  (说话人集合空 ⇒ R1 恒不触发、契约口径恒 0;不再靠改模块全局凑数)")
        print("      写入只能发生在 worker 的接线口(开关 ECHO_GRAPH_GATE);本 CLI 只做 dry-run")
        print("      **没有**窗口口径(--last N):同一对会被反复重计")
        return 0
    if "--write" in argv or "--apply" in argv:
        print("拒绝:本 CLI 只有 dry-run。写库只能走 worker 的接线口"
              "(开关 ECHO_GRAPH_GATE=1);这里绝不碰真库。", file=sys.stderr)
        return 1

    def val(flag):
        if flag in argv:
            i = argv.index(flag)
            if i + 1 < len(argv) and not argv[i + 1].startswith("--"):
                return argv[i + 1]
        return ""

    db_path = val("--db") or os.environ.get("ECHO_DB") or os.path.join(
        os.path.expanduser("~"), ".dsh", "echo", "echo.db")
    if not os.path.exists(db_path):
        print("库不在: " + db_path, file=sys.stderr)
        return 1
    max_memory_id = val("--max-memory-id")
    memory_id = val("--memory-id")
    kinds_arg = val("--kinds")
    kinds = MINE_KINDS
    if kinds_arg:
        picked = tuple(k.strip() for k in kinds_arg.split("+") if k.strip())
        bad = [k for k in picked if k not in MINE_KINDS]
        if bad:
            print("不认的 kinds: %s(只能是 %s)" % (bad, "/".join(MINE_KINDS)), file=sys.stderr)
            return 1
        kinds = picked or MINE_KINDS
    if "--latest" in argv or memory_id:
        kinds = (KIND_SAME_MEMORY,)      # 运行时口径:单条记忆只有同记忆类
    started = time.time()
    # P1 收口(拍板 3):名字集合由调用方给(CLI 就 --names 指一份 names.json);
    # 不给 ⇒ 中性退化(不是"偷偷用模块全局")。
    names = None
    names_path = val("--names")
    if names_path:
        try:
            with open(names_path, encoding="utf-8") as fh:
                names = json.load(fh)
        except Exception as exc:
            print("读不了 --names 那份文件: %s(%s)" % (names_path, exc), file=sys.stderr)
            return 1
    report = dry_run(db_path,
                     max_memory_id=int(max_memory_id) if max_memory_id else None,
                     memory_id=int(memory_id) if memory_id else None,
                     latest_only="--latest" in argv,
                     kinds=kinds,
                     names=names)
    report["elapsed_ms"] = int((time.time() - started) * 1000)
    if "--json" in argv:
        print(json.dumps(report, ensure_ascii=False, indent=2))
    else:
        print(render_dry_run(report))
    return 0


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main(sys.argv[1:]))
