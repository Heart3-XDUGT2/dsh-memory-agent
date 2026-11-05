# -*- coding: utf-8 -*-
"""A6:只读 PPR(同域联想)+ 时间邻近缓冲 —— **这一期只出报表,不接进 prompt**。

一层一句话:给定种子概念,沿"概念 ↔ 记忆行"的双向图做一轮 personalized PageRank,
把"同一个域里的东西"(哪怕图上没有直接边)排出来,**并给出可解释路径**;
时间上挨着的记忆只做**候选**(不落边、不进图)。

用法(在 `python/` 目录下):
    python -m engine.ppr --db <path> --seed KARDS --seed 德美跳
    python -m engine.ppr --db <path> --query "KARDS 那个卡组怎么搭" --json
    python -m engine.ppr --db <path> --seed 校园跑 --report <md>

图的三层(每层都能在报表里看到**来源计数**,免得"图上有什么"变成玄学):
  1. **概念↔概念**:现行事实边(`kind` 空、active;权重 = `weight`)+ A4 证据层派生
     的共现 pair(权重 = 几条记忆作证)。
  2. **概念↔记忆行**(照 HippoRAG:节点与记忆同图):来源 ①证据行 `node_ids`;
     ②事实边 `evidence` 里的记忆 id(经 `engine.evidence.evidence_ids` 解析);
     ③回执的 `evidence_memory_id`;④记忆关键词与节点名精确相等。
  3. **时间邻近(只做候选)**:与"作证记忆"同一天 / ±6 小时的记忆 ⇒ 只进候选名单,
     **不进图、不落边**(验收时能看到它们被标成 `candidates_only`)。

⚠️ 确定性与降权:
  * 幂迭代按**节点键排序**遍历 + 平票按键取小 ⇒ 同输入两次跑逐位一致;
  * **hub 降权**:转移概率 `w(u,v) / deg(v)^HUB_BETA`(默认 0.5)。不降权时 `用户`
    (度 21)会把质量全吸走 —— 报表里两组数并排给你看(计划书 §5.A6 坑②)。

⚠️ 只读纪律:本模块**不写任何表**,也**不进检索/渲染路径**(进 prompt 要单独裁决)。
有 grep 级守卫盯着检索侧文件里不出现 `ppr` 的耦合。
"""

import argparse
import json
import math
import os
import sys

from . import db as db_mod
from . import evidence as evidence_mod
from . import graph as graph_mod

#: 记忆节点在图里的键前缀(`mem:123`);概念节点就是 `node_id`。
MEM_PREFIX = "mem:"
OWNER = "master"
DAMPING = 0.85
MAX_ITERS = 20
TOL = 1e-9
#: hub 降权的指数:0 = 不降权(标准 PPR);0.5 = 把高度节点的"吸引力"开方压一次。
HUB_BETA = 0.5
#: 报表规则:**度 ≥ 这个数的概念只当"导管",不进排名**(它仍然传播质量 —— 那正是它当导管的
#: 用处)。实测:`用户`(度 126)在 beta=0.5 下质量占比从 0.14 掉到 0.03,但排名**仍是第一**
#: (它跟谁都相邻)⇒ 光靠降权不够,得让它退出排名,并在报表里**看得见**。
HUB_RANK_MAX_DEG = 30
#: 时间邻近缓冲:窗口(秒)与"只做候选"的权重提示。
TEMPORAL_WINDOW = 6 * 3600
TEMPORAL_SAME_DAY = True
#: 报表里最多列几条路径 / 几个候选。
TOP = 10
PATH_LIMIT = 5

#: 检索/渲染侧文件:出现本模块的名字 = 红(说明有人把它接进在线路径了)。
READ_SIDE_FILES = (
    "python/engine/retrieve.py",
    "python/engine/graph.py",
    "python/worker.py",
    "lib/store.js",
    "lib/soul-snapshot.js",
)
FORBIDDEN_NAMES = ("engine.ppr", "from . import ppr", "ppr.")


def mem_key(memory_id):
    return MEM_PREFIX + str(int(memory_id))


def _node_names(conn):
    try:
        return {str(r[0]): str(r[1] or r[0]) for r in conn.execute(
            "SELECT node_id, name FROM graph_nodes")}
    except Exception:
        return {}


def _bump(d, k, v):
    d[k] = d.get(k, 0.0) + float(v)


def build_graph(conn, *, owner=OWNER, include_fact=True, include_cooc=True,
                include_receipts=True, include_keywords=True, cooc_owner="__cooc__"):
    """概念↔概念 + 概念↔记忆行 的双向图(只读)。返回邻接表 + 来源计数。"""
    names = _node_names(conn)
    adj, kinds, sources = {}, {}, {}

    def add(a, b, w, src):
        if a == b or w <= 0:
            return
        adj.setdefault(a, {})
        adj.setdefault(b, {})
        _bump(adj[a], b, w)
        _bump(adj[b], a, w)
        kinds[a] = "memory" if str(a).startswith(MEM_PREFIX) else "concept"
        kinds[b] = "memory" if str(b).startswith(MEM_PREFIX) else "concept"
        sources[src] = sources.get(src, 0) + 1

    # ① 概念↔概念:事实边
    if include_fact:
        try:
            for s, t, w in conn.execute(
                    "SELECT source_id, target_id, COALESCE(weight, 1) FROM graph_edges"
                    " WHERE COALESCE(kind, '') = '' AND COALESCE(is_active, 1) = 1"):
                if str(s) in names and str(t) in names:
                    add(str(s), str(t), float(w or 1), "fact-edge")
        except Exception:
            pass
    # ①' 概念↔概念:证据层共现(权重 = 几条记忆作证)
    cooc_rows = []
    if include_cooc:
        try:
            cooc_rows = conn.execute(
                "SELECT owner_key, scope_kind, memory_id, day_key, node_ids, pairs"
                " FROM graph_cooc_evidence WHERE owner_key = ?", (cooc_owner,)).fetchall()
        except Exception:
            cooc_rows = []
        try:
            for key, n in conn.execute(
                    "SELECT pair_key, COUNT(*) FROM v_cooc_pairs WHERE owner_key = ?"
                    " GROUP BY pair_key", (cooc_owner,)):
                a, _, b = str(key).partition("|")
                if a in names and b in names:
                    add(a, b, float(n or 1), "cooc-pair")
        except Exception:
            pass
    # ② 概念↔记忆行(四个来源)
    seen_mem_nodes = set()
    for _ow, scope, memory_id, _day, node_ids, _pairs in cooc_rows:
        if str(scope) != "same_memory" or not int(memory_id or 0):
            continue
        m = mem_key(memory_id)
        seen_mem_nodes.add(m)
        for nid in str(node_ids or "").split("、"):
            nid = nid.strip()
            if nid in names:
                add(m, nid, 1.0, "cooc-evidence-memory")
    if include_fact:
        try:
            for s, t, ev in conn.execute(
                    "SELECT source_id, target_id, COALESCE(evidence, '') FROM graph_edges"
                    " WHERE COALESCE(kind, '') = '' AND COALESCE(is_active, 1) = 1"
                    " AND COALESCE(evidence, '') <> ''"):
                for mid in evidence_mod.evidence_ids(ev):
                    m = mem_key(mid)
                    seen_mem_nodes.add(m)
                    for nid in (str(s), str(t)):
                        if nid in names:
                            add(m, nid, 1.0, "fact-edge-memory")
        except Exception:
            pass
    if include_receipts:
        try:
            for mid, s, t in conn.execute(
                    "SELECT evidence_memory_id, source_id, target_id FROM graph_edge_receipts"
                    " WHERE COALESCE(evidence_memory_id, '') <> ''"
                    " AND COALESCE(action, '') = 'accept'"):
                m = mem_key(mid)
                seen_mem_nodes.add(m)
                for nid in (str(s), str(t)):
                    if nid in names:
                        add(m, nid, 1.0, "receipt-memory")
        except Exception:
            pass
    if include_keywords:
        try:
            by_name = {}
            for nid, nm in names.items():
                by_name.setdefault(str(nm), nid)
            for mid, kw in conn.execute(
                    "SELECT memory_id, COALESCE(keywords, '') FROM episodic_memory"
                    " WHERE COALESCE(is_active, 1) = 1"):
                for piece in str(kw or "").replace(",", "、").split("、"):
                    nid = by_name.get(piece.strip())
                    if nid:
                        m = mem_key(mid)
                        seen_mem_nodes.add(m)
                        add(m, nid, 1.0, "keyword-memory")
        except Exception:
            pass

    return {"adj": adj, "kinds": kinds, "names": names, "sources": sources,
            "memory_nodes": sorted(seen_mem_nodes),
            "concept_nodes": sorted(n for n, k in kinds.items() if k == "concept"),
            "nodes": len(adj), "edges": sum(len(v) for v in adj.values()) // 2}


# ── PPR ─────────────────────────────────────────────────────────────────────

def _transition(adj, deg, hub_beta):
    """转移概率:出边权重按 `deg(v)^beta` 压制目标 —— `beta=0` 就是标准 PPR。

    ⚠️ 每一行必须**行和为 1**(否则质量不守恒,PPR 就不是分布了)。
    2026-10-01:第一版写成 `{v: ww / z for v, w in row.items()}`,那个 `ww` 是外层
    循环的**自由变量**(取的是最后一轮的值)⇒ 每行所有值相等、行和随机 —— 玩具图
    每个节点只有一条出边,刚好看不出来。现在用独立的推导变量名 + 两条单测钉住
    (行和 = 1、总质量 = 1)。
    """
    out = {}
    for u in sorted(adj):
        row, z = {}, 0.0
        for v, w in sorted(adj[u].items()):
            scaled = float(w) / math.pow(max(1.0, float(deg.get(v, 1))), float(hub_beta))
            row[v] = scaled
            z += scaled
        if z <= 0:
            continue
        out[u] = {v: val / z for v, val in row.items()}
    return out


def run_ppr(g, seeds, *, damping=DAMPING, max_iters=MAX_ITERS, hub_beta=HUB_BETA,
            tol=TOL):
    """确定性的幂迭代。返回 `{scores, iters, converged, predecessor}`。"""
    adj = g["adj"]
    seeds = [s for s in (seeds or []) if s in adj]
    if not seeds:
        return {"scores": {}, "iters": 0, "converged": True, "predecessor": {},
                "seeds": []}
    deg = {u: sum(float(w) for w in adj[u].values()) for u in adj}
    T = _transition(adj, deg, hub_beta)
    keys = sorted(adj)
    share = 1.0 / len(seeds)
    p = {k: (share if k in seeds else 0.0) for k in keys}
    pred = {}
    iters = 0
    for _ in range(max(1, int(max_iters))):
        iters += 1
        nxt = {k: (1.0 - float(damping)) * (share if k in seeds else 0.0) for k in keys}
        best = {}
        for u in keys:
            pu = p.get(u, 0.0)
            if pu <= 0:
                continue
            for v, pr in sorted(T.get(u, {}).items()):
                contrib = pu * pr
                _bump(nxt, v, float(damping) * contrib)
                if contrib > best.get(v, (0.0, ""))[0]:
                    best[v] = (contrib, u)
        for v, (c, u) in best.items():
            pred[v] = u
        delta = sum(abs(nxt[k] - p.get(k, 0.0)) for k in keys)
        p = nxt
        if delta < float(tol):
            break
    return {"scores": p, "iters": iters, "converged": delta < float(tol), "delta": delta,
            "predecessor": pred, "seeds": seeds, "deg": deg, "hub_beta": hub_beta,
            "mass": sum(p.values())}


def explain(g, run, target, *, limit=PATH_LIMIT):
    """从 `target` 沿 `predecessor` 回溯到某个种子 —— 这就是"可解释路径"。"""
    pred = run.get("predecessor") or {}
    seeds = set(run.get("seeds") or [])
    names = g["names"]

    def label(k):
        if str(k).startswith(MEM_PREFIX):
            return "记忆#" + str(k)[len(MEM_PREFIX):]
        return names.get(str(k), str(k))

    path, cur, guard = [target], target, 0
    while cur not in seeds and guard < 12:
        nxt = pred.get(cur)
        if not nxt or nxt in path:
            break
        path.append(nxt)
        cur = nxt
        guard += 1
    if cur not in seeds:
        return None
    return {"target": str(target), "target_label": label(target),
            "path": [str(x) for x in reversed(path)],
            "labels": [label(x) for x in reversed(path)],
            "hops": len(path) - 1}


def temporal_buffer(conn, memory_ids, *, window=TEMPORAL_WINDOW, same_day=TEMPORAL_SAME_DAY,
                    limit=TOP):
    """时间邻近的**候选**(只进名单,不进图):同一天 / ±window 秒内的记忆。"""
    ids = [int(m) for m in (memory_ids or []) if str(m).strip().isdigit()]
    if not ids:
        return []
    rows = {}
    try:
        for mid, ts, occ, summary in conn.execute(
                "SELECT memory_id, COALESCE(timestamp, 0), COALESCE(occurred_at, 0),"
                " COALESCE(summary, '') FROM episodic_memory"
                " WHERE COALESCE(is_active, 1) = 1"):
            rows[int(mid)] = (float(ts or 0), float(occ or 0), str(summary or ""))
    except Exception:
        return []
    out = []
    for anchor in sorted(ids):
        a = rows.get(anchor)
        if not a:
            continue
        at = a[1] or a[0]
        for mid in sorted(rows):
            if mid == anchor:
                continue
            bt = rows[mid][1] or rows[mid][0]
            if not bt or not at:
                continue
            same_day_hit = same_day and int(bt // 86400) == int(at // 86400)
            near = abs(bt - at) <= float(window)
            if same_day_hit or near:
                out.append({"anchor": anchor, "memory_id": mid,
                            "why": "same-day" if same_day_hit else "nearby",
                            "gap_seconds": abs(bt - at),
                            "summary": rows[mid][2][:60],
                            "candidates_only": True})
            if len(out) >= int(limit) * max(1, len(ids)):
                break
    # 去重(同一个候选可能被多个锚点拉出来)
    seen, uniq = set(), []
    for c in sorted(out, key=lambda c: (c["memory_id"], c["anchor"])):
        if c["memory_id"] in seen:
            continue
        seen.add(c["memory_id"])
        uniq.append(c)
    return uniq[:int(limit)]


def _shares_evidence(conn, a, b, *, owner="__cooc__"):
    """两个概念有没有**同一条证据行**(= 同一条记忆里一起出现过)——机械判据。"""
    try:
        for (ids,) in conn.execute(
                "SELECT node_ids FROM graph_cooc_evidence WHERE owner_key = ?", (owner,)):
            parts = [x.strip() for x in str(ids or "").split("、")]
            if str(a) in parts and str(b) in parts:
                return True
    except Exception:
        pass
    return False


def _seed_concepts(g, query=None, seeds=None, *, max_seeds=8):
    """种子通道复用引擎既有的三个纯函数(不另造一套)。"""
    names = g["names"]
    by_name = {}
    for nid, nm in names.items():
        by_name.setdefault(str(nm), nid)
    picked = []
    for s in (seeds or []):
        s = str(s).strip()
        if s in by_name:
            picked.append(by_name[s])
    if query:
        raw = graph_mod.extract_seed_nodes(query)
        for nm in graph_mod.match_seeds_to_graph(raw, by_name, max_seeds=max_seeds):
            nid = by_name.get(str(nm))
            if nid and nid not in picked:
                picked.append(nid)
        for nm in graph_mod.direct_seed_hits(query, by_name, max_hits=max_seeds):
            nid = by_name.get(str(nm))
            if nid and nid not in picked:
                picked.append(nid)
    return picked[:max_seeds]


def report(conn, *, query=None, seeds=None, top=TOP, hub_beta=HUB_BETA,
           include_fact=True, include_cooc=True, hub_rank_max_deg=HUB_RANK_MAX_DEG):
    """只读报表:排名 + 路径 + hub 对照 + 时间邻近候选。**一个字节都不写。**"""
    g = build_graph(conn, include_fact=include_fact, include_cooc=include_cooc)
    seed_nodes = _seed_concepts(g, query=query, seeds=seeds)
    out = {"query": str(query or ""), "seed_names": [g["names"].get(s, s) for s in seed_nodes],
           "seeds": list(seed_nodes), "graph": {"nodes": g["nodes"], "edges": g["edges"],
                                                "memory_nodes": len(g["memory_nodes"]),
                                                "concept_nodes": len(g["concept_nodes"]),
                                                "sources": g["sources"]},
           "ranking": [], "memories": [], "paths": [], "hub": [], "temporal": [],
           "hub_excluded": [], "notes": []}
    if not seed_nodes:
        out["notes"].append("没有种子命中图(查询词与节点名都不匹配)")
        return out
    run = run_ppr(g, seed_nodes, hub_beta=hub_beta)
    plain = run_ppr(g, seed_nodes, hub_beta=0.0)
    names = g["names"]
    ranked = sorted(run["scores"].items(), key=lambda kv: (-kv[1], kv[0]))
    out["iters"] = run["iters"]
    out["converged"] = run["converged"]
    out["delta"] = float(run.get("delta", 0.0))
    out["mass"] = round(float(run.get("mass", 0.0)), 8)
    for k, v in ranked:
        if str(k).startswith(MEM_PREFIX):
            continue
        if k in seed_nodes:
            continue
        if float(run["deg"].get(k, 0)) >= float(hub_rank_max_deg):
            out["hub_excluded"].append(names.get(str(k), str(k)))
            continue
        out["ranking"].append({"node_id": str(k), "name": names.get(str(k), str(k)),
                               "score": round(float(v), 8),
                               "plain_score": round(float(plain["scores"].get(k, 0.0)), 8),
                               "deg": int(run["deg"].get(k, 0))})
        if len(out["ranking"]) >= int(top):
            break
    mems = [(k, v) for k, v in ranked if str(k).startswith(MEM_PREFIX)]
    for k, v in mems[:int(top)]:
        mid = int(str(k)[len(MEM_PREFIX):])
        row = conn.execute("SELECT COALESCE(summary, '') FROM episodic_memory"
                           " WHERE memory_id = ?", (mid,)).fetchone()
        out["memories"].append({"memory_id": mid, "score": round(float(v), 8),
                                "summary": str(row[0])[:80] if row else ""})
    targets = [r["node_id"] for r in out["ranking"][:3]] + \
              [str(m[0]) for m in mems[:2]]
    for t in targets:
        p = explain(g, run, t)
        if p:
            out["paths"].append(p)
    # hub 对照:度数最高的那几个节点,两组口径下的质量占比
    deg = run["deg"]
    total_hub = sum(run["scores"].values()) or 1.0
    total_plain = sum(plain["scores"].values()) or 1.0
    for h in sorted(deg, key=lambda k: (-deg[k], k))[:5]:
        out["hub"].append({"node": names.get(str(h), str(h)), "deg": int(deg[h]),
                           "share_with_penalty": round(float(run["scores"].get(h, 0.0)) / total_hub, 6),
                           "share_plain": round(float(plain["scores"].get(h, 0.0)) / total_plain, 6)})
    # 时间邻近缓冲:候选只进名单(拿排在前面的记忆当锚点)
    out["temporal"] = temporal_buffer(conn, [m["memory_id"] for m in out["memories"][:3]],
                                      limit=int(top))
    out["notes"].append("时间邻近缓冲只出候选:不落边、不进图、不进 prompt")
    if out["hub_excluded"]:
        out["notes"].append("度 ≥ %d 的概念只当导管、不进排名:%s"
                            % (int(hub_rank_max_deg), "、".join(out["hub_excluded"])))
    return out


def to_text(rep):
    out = ["== A6 只读 PPR(同域联想;本阶段**只报表**)=="]
    out.append("① 种子:%s" % ("、".join(rep["seed_names"]) or "(无)"))
    out.append("② 图:%d 节点(概念 %d / 记忆 %d)/ %d 边;来源 %s"
               % (rep["graph"]["nodes"], rep["graph"]["concept_nodes"],
                  rep["graph"]["memory_nodes"], rep["graph"]["edges"],
                  json.dumps(rep["graph"]["sources"], ensure_ascii=False)))
    if rep.get("iters"):
        out.append("③ 幂迭代 %d 轮(收敛 %s,末轮 Δ=%.2e,总质量 %.6f)"
                   % (rep["iters"], rep["converged"], rep.get("delta", 0.0),
                      rep.get("mass", 0.0)))
    for r in rep["ranking"][:8]:
        out.append("   %-22s score=%.6f(不降权 %.6f) 度=%d"
                   % (r["name"][:22], r["score"], r["plain_score"], r["deg"]))
    for m in rep["memories"][:5]:
        out.append("   记忆 #%-4d score=%.6f %s"
                   % (m["memory_id"], m["score"], m["summary"][:52]))
    for p in rep["paths"][:5]:
        out.append("   路径(%d 跳):%s" % (p["hops"], " → ".join(p["labels"])))
    for h in rep["hub"][:5]:
        out.append("   hub %-14s 度=%-3d 降权后占比 %.4f / 不降权 %.4f"
                   % (h["node"][:14], h["deg"], h["share_with_penalty"], h["share_plain"]))
    if rep["temporal"]:
        out.append("④ 时间邻近**候选**(不落边):%d 条,例:%s"
                   % (len(rep["temporal"]),
                      "、".join("记忆#%d(%s)" % (c["memory_id"], c["why"])
                                for c in rep["temporal"][:4])))
    for n in rep["notes"]:
        out.append("   · " + n)
    return "\n".join(out)


def main(argv=None):
    ap = argparse.ArgumentParser(description="A6 只读 PPR 报表(不写库、不进 prompt)")
    ap.add_argument("--db", default=None)
    ap.add_argument("--seed", action="append", default=[])
    ap.add_argument("--query", default=None)
    ap.add_argument("--top", type=int, default=TOP)
    ap.add_argument("--hub-beta", type=float, default=HUB_BETA)
    ap.add_argument("--hub-max-deg", type=float, default=HUB_RANK_MAX_DEG,
                    help="度 ≥ 这个数的概念只当导管、不进排名(默认 %g)" % HUB_RANK_MAX_DEG)
    ap.add_argument("--no-fact", action="store_true")
    ap.add_argument("--no-cooc", action="store_true")
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--report", default=None)
    ap.add_argument("--from-audit", type=int, default=0,
                    help="拿最近 N 条**真实提问**(audit_logs.user_input)跑一遍,出汇总")
    ap.add_argument("--sweep", type=int, default=0,
                    help="12 题式小样本:图上度数最高的 N 个概念逐个当种子,机械判据出命中率")
    args = ap.parse_args(argv)

    path = args.db or os.path.join(os.path.expanduser("~"), ".dsh", "echo", "echo.db")
    conn = db_mod.connect(path)
    try:
        if args.sweep:
            g = build_graph(conn, include_fact=not args.no_fact,
                            include_cooc=not args.no_cooc)
            deg = {u: sum(float(w) for w in g["adj"][u].values()) for u in g["adj"]}
            concepts = [n for n in sorted(g["adj"], key=lambda k: (-deg[k], k))
                        if g["kinds"].get(n) == "concept"]
            picks = concepts[:int(args.sweep)]
            items, hit1, hit3 = [], 0, 0
            for seed in picks:
                run = run_ppr(g, [seed], hub_beta=args.hub_beta)
                ranked = [k for k, _v in sorted(run["scores"].items(),
                                                key=lambda kv: (-kv[1], kv[0]))
                          if k != seed and not str(k).startswith(MEM_PREFIX)
                          and float(run["deg"].get(k, 0)) < float(args.hub_max_deg)]
                top = ranked[:3]
                first_ok = bool(top) and _shares_evidence(conn, seed, top[0])
                any_ok = any(_shares_evidence(conn, seed, t) for t in top)
                hit1 += 1 if first_ok else 0
                hit3 += 1 if any_ok else 0
                items.append({"seed": g["names"].get(seed, seed), "deg": int(deg[seed]),
                              "top3": [g["names"].get(t, t) for t in top],
                              "top1_shares_evidence": first_ok, "top3_shares_evidence": any_ok,
                              "paths": len([p for p in [explain(g, run, str(t))
                                                        for t in top] if p])})
            agg = {"seeds": len(picks), "top1_shared": hit1, "top3_shared": hit3,
                   "items": items,
                   "rule": "判据是**机械**的:排第一/前三的联想与种子是否共享一条证据行"}
            text = ("== A6 PPR 小样本(图上度数最高的 %d 个概念当种子)==\n" % agg["seeds"]
                    + "① 排第一就同证据:%d/%d;前三里有同证据:%d/%d"
                    % (hit1, agg["seeds"], hit3, agg["seeds"])
                    + "".join("\n   %-16s(度 %-3d)→ %s"
                              % (it["seed"][:16], it["deg"],
                                 "、".join(it["top3"]) or "(无)")
                              for it in items))
            if args.report:
                with open(args.report, "w", encoding="utf-8") as fh:
                    fh.write("# A6 PPR · 小样本\n\n库:`%s`\n\n%s\n" % (path, text))
            if args.json:
                print(json.dumps({"db": path, "sweep": agg}, ensure_ascii=False, indent=2))
            else:
                print("库 %s\n%s" % (path, text))
            return 0
        if args.from_audit:
            items, seed_hit, with_path = [], 0, 0
            for text, ts in conn.execute(
                    "SELECT COALESCE(user_input, ''), COALESCE(timestamp, 0) FROM audit_logs"
                    " WHERE COALESCE(user_input, '') <> ''"
                    "   AND user_input NOT LIKE '(%'"
                    "   AND user_input NOT LIKE '%structured_output%'"
                    "   AND user_input NOT LIKE '%[标签%'"
                    " ORDER BY timestamp DESC LIMIT ?",
                    (int(args.from_audit),)):
                rep = report(conn, query=text, top=args.top, hub_beta=args.hub_beta,
                             include_fact=not args.no_fact, include_cooc=not args.no_cooc)
                hit = bool(rep["seeds"])
                seed_hit += 1 if hit else 0
                with_path += 1 if rep["paths"] else 0
                items.append({"q": str(text)[:60], "at": float(ts or 0), "hit": hit,
                              "seeds": rep["seed_names"],
                              "top": [r["name"] for r in rep["ranking"][:3]],
                              "paths": len(rep["paths"]),
                              "temporal": len(rep["temporal"])})
            agg = {"questions": len(items), "seed_hit": seed_hit, "with_path": with_path,
                   "items": items,
                   "note": "样本 = 库里**真实提问**(最近 N 条);正式 12 题样本在 A8"}
            text = ("== A6 PPR 真数据抽样(%d 题)==" % agg["questions"]
                    + "\n① 种子命中 %d/%d;有可解释路径 %d/%d"
                    % (seed_hit, len(items), with_path, len(items))
                    + "".join("\n   %-28s → %s(%d 条路径)"
                              % (it["q"][:28], "、".join(it["top"]) or "(无排名)", it["paths"])
                              for it in items))
            if args.report:
                with open(args.report, "w", encoding="utf-8") as fh:
                    fh.write("# A6 PPR · 真数据抽样\n\n库:`%s`\n\n%s\n" % (path, text))
            if args.json:
                print(json.dumps({"db": path, "audit": agg}, ensure_ascii=False, indent=2))
            else:
                print("库 %s\n%s" % (path, text))
            return 0
        rep = report(conn, query=args.query, seeds=args.seed, top=args.top,
                     hub_beta=args.hub_beta, include_fact=not args.no_fact,
                     include_cooc=not args.no_cooc, hub_rank_max_deg=args.hub_max_deg)
        text = to_text(rep)
        if args.report:
            with open(args.report, "w", encoding="utf-8") as fh:
                fh.write("# A6 只读 PPR · 报表\n\n库:`%s`\n\n%s\n" % (path, text))
        if args.json:
            print(json.dumps({"db": path, "report": rep}, ensure_ascii=False, indent=2))
        else:
            print("库 %s\n%s" % (path, text))
            print("\n⚠️ 本阶段**不接进 prompt**(接线是另一次独立裁决);本模块不写任何表。")
        return 0
    finally:
        try:
            conn.close()
        except Exception:
            pass


if __name__ == "__main__":
    sys.exit(main())
