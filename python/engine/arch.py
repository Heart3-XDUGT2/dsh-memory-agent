# -*- coding: utf-8 -*-
"""A7a:运维读口的**唯一聚合器** + 一键回退(按 receipt 反做最近一批)。

一层一句话:面板要看的每一格,这里**一次算完**(口径只在引擎里有一份),
面板只负责显示 —— 「面板不许成为第二个判定处」是既有纪律(§5.A7 坑)。

这个模块**只读聚合 + 一个显式的回退动作**:
  * `status(conn)` —— 各层读数收在一起(主题簇 / 证据层 / 影子表 / 回执 / 回退入口),
    每一格都标它是**算法产物**还是**事实**(验收③);
  * `plan_rollback(conn, route)` —— 只看不写:这个回退会动几行、动哪张表、SQL 是什么;
  * `rollback(conn, route, apply=True)` —— 真做:动前面那几行,**并写一条回执**(谁退的/退了多少)。

回退路线的口径(唯一出处 = `ROLLBACK_ROUTES`):
  · `cooc-evidence` 共现证据层最近一批(按 `created_at` 那一批,删行;可再跑一次重算)
  · `topic-view`    主题簇视图整批退役(`is_active=0`,行不删)
  · `shadow-table`  **不提供回退**:3a 的历史、已冻结 ⇒ 明确说"没有这个动作",不是静默 0 行。

用法:
    python -m engine.arch --db <path> --json
    python -m engine.arch --db <path> --rollback cooc-evidence              # 只看(dry-run)
    python -m engine.arch --db <path> --rollback cooc-evidence --apply      # 真退(带确认串)
"""

import argparse
import json
import os
import sys
import time

from . import cooc as cooc_mod
from . import db as db_mod
from . import evidence_debt as debt_mod
from . import graph_gate as gate_mod
from . import topics as topics_mod

TOPIC_OWNER = topics_mod.TOPIC_OWNER
COOC_OWNER = cooc_mod.COOC_OWNER
RECEIPTS_TABLE = gate_mod.RECEIPTS_TABLE
#: 事实图/凭据债的归属(与 `ppr.OWNER`、`graph.add_edge` 的默认一致 —— 活库只有一个 owner)。
GRAPH_OWNER = "master"

#: 「这一格是算法产物还是事实」——面板必须显示,别把重算结果说成他真说过的话(验收③)。
NATURE = {
    "topics": "算法产物(可重算)",
    "evidence": "中间层(只读派生)",
    "shadow": "3a 历史(已冻结)",
    "receipts": "流水账(留痕)",
    "graph": "事实(他说过的话里长出来的)",
    # 凭据债是**给人看的账**(查"她凭什么"),永远不进她的上下文 —— 他 2026-10-02 定的通例。
    "debt": "凭据账(只给人看,不进她的上下文)",
}

#: 回退路线表 —— **唯一出处**。
ROLLBACK_ROUTES = (
    {"route": "cooc-evidence",
     "what": "共现证据层:最近一批证据行",
     "table": cooc_mod.EVIDENCE_TABLE,
     "how": "DELETE 最近一批 created_at 的证据行;想回来再跑一次 `python -m engine.cooc --apply`",
     "recomputable": True},
    {"route": "topic-view",
     "what": "主题簇视图:整批退役(行不删)",
     "table": topics_mod.CLUSTER_TABLE,
     "how": "UPDATE is_active=0;想回来再跑一次 `python -m engine.topics --apply`",
     "recomputable": True},
    {"route": "shadow-table",
     "what": "影子表(3a 历史,已冻结):**不提供回退**",
     "table": gate_mod.SHADOW_TABLE,
     "how": "它不再增长,也就没有「最近一批」可退;要清是手工 SQL,不是这里的动作",
     "recomputable": False},
)


def _table_exists(conn, name):
    try:
        return conn.execute("SELECT 1 FROM sqlite_master WHERE type IN ('table','view')"
                            " AND name = ?", (str(name),)).fetchone() is not None
    except Exception:
        return False


def _count(conn, sql, params=()):
    try:
        return int(conn.execute(sql, params).fetchone()[0] or 0)
    except Exception:
        return 0


def _recent_receipts(conn, limit=12):
    if not _table_exists(conn, RECEIPTS_TABLE):
        return []
    try:
        return [{"id": int(r[0]), "run_id": str(r[1] or ""), "at": float(r[2] or 0),
                 "kind": str(r[3] or ""), "action": str(r[4] or ""),
                 "source_id": str(r[5] or ""), "target_id": str(r[6] or ""),
                 "route": str(r[7] or ""), "note": str(r[8] or "")[:60]}
                for r in conn.execute(
                    "SELECT id, run_id, created_at, kind, action, source_id, target_id,"
                    " COALESCE(route, ''), COALESCE(note, '') FROM " + RECEIPTS_TABLE +
                    " ORDER BY id DESC LIMIT ?", (int(limit),))]
    except Exception:
        return []


def _params(raw):
    """`params` 列是 JSON **文本**(不是 dict)——面板要的是 dict,这里只解析、不改写。"""
    if isinstance(raw, dict):
        return raw
    try:
        got = json.loads(str(raw or "{}"))
        return got if isinstance(got, dict) else {}
    except Exception:
        return {}


def status(conn, *, topic_owner=TOPIC_OWNER, cooc_owner=COOC_OWNER, receipts=12,
           debt_limit=12, graph_owner=GRAPH_OWNER):
    """各层读数(**只读**)。面板 GET 就把这个直接画出来。"""
    out = {"generated_at": time.time(), "nature": dict(NATURE), "notes": [],
           "topics": {"table": topics_mod.CLUSTER_TABLE, "present": False, "clusters": [],
                      "active_batch": "", "computed_at": 0.0, "summaries": 0},
           "evidence": {"present": False, "rows": 0, "pairs": 0, "nodes": 0, "by_scope": {}},
           "shadow": {"table": gate_mod.SHADOW_TABLE, "rows": 0, "frozen": True},
           "graph": {"nodes": 0, "edges": 0, "active_edges": 0},
           "receipts": {"total": 0, "recent": []},
           "debt": {"present": False, "active": {}, "weak_total": 0, "weak": [],
                    "nonfact_kind_rows": 0},
           "rollback": []}

    # 主题簇(算法产物)
    ts = out["topics"]
    ts["present"] = _table_exists(conn, topics_mod.CLUSTER_TABLE)
    if ts["present"]:
        try:
            view = topics_mod.active_view(conn, owner=topic_owner)
            ts["clusters"] = [{"cluster_id": c["cluster_id"], "label": c["label"],
                               "summary": c["summary"], "size": c["size"],
                               "soft": c.get("soft") or [],
                               "batch_key": c["batch_key"],
                               "computed_at": c["computed_at"],
                               "algorithm": _params(c.get("params")).get(
                                   "algorithm", topics_mod.ALGORITHM),
                               "nature": "algorithm", "stale_days": 0.0}
                              for c in view]
            ts["active_batch"] = view[0]["batch_key"] if view else ""
            ts["computed_at"] = float(view[0]["computed_at"]) if view else 0.0
            ts["summaries"] = sum(1 for c in ts["clusters"] if c["summary"])
            for c in ts["clusters"]:
                c["stale_days"] = round(
                    max(0.0, (time.time() - float(c["computed_at"] or 0)) / 86400.0), 2)
            if not ts["clusters"]:
                out["notes"].append("主题簇表在,但**现行批次为空**(没算过 / 已退役)")
        except Exception as exc:
            out["notes"].append("主题簇读不出来:%s" % exc)
    else:
        out["notes"].append("主题簇两张表还没建(引擎下一次 connect() 纯增建表;零行)")

    # 证据层(中间层)
    ev = out["evidence"]
    ev["present"] = _table_exists(conn, cooc_mod.EVIDENCE_TABLE)
    if ev["present"]:
        ev["rows"] = _count(conn, "SELECT COUNT(*) FROM " + cooc_mod.EVIDENCE_TABLE +
                            " WHERE owner_key = ?", (cooc_owner,))
        ev["pairs"] = _count(conn, "SELECT COUNT(DISTINCT pair_key) FROM v_cooc_pairs"
                                   " WHERE owner_key = ?", (cooc_owner,)) \
            if _table_exists(conn, "v_cooc_pairs") else 0
        ev["nodes"] = _count(conn, "SELECT COUNT(DISTINCT node_ids) FROM " +
                             cooc_mod.EVIDENCE_TABLE + " WHERE owner_key = ?", (cooc_owner,))
        for scope, n in conn.execute(
                "SELECT scope_kind, COUNT(*) FROM " + cooc_mod.EVIDENCE_TABLE +
                " WHERE owner_key = ? GROUP BY scope_kind ORDER BY scope_kind", (cooc_owner,)):
            ev["by_scope"][str(scope)] = int(n)
        if not ev["rows"]:
            out["notes"].append("证据层是空的 ⇒ 主题簇/PPR 的'同域'会偏薄(重算前先看这一格)")
    else:
        out["notes"].append("证据层表还没建(引擎下一次 connect() 纯增建表;零行)")

    # 凭据债(只给人看:查"她凭什么" —— 它**永不进她的上下文**,他 2026-10-02 定的通例)
    db_k = out["debt"]
    if _table_exists(conn, "graph_edges"):
        db_k["present"] = True
        try:
            sv = debt_mod.survey(conn, graph_owner, limit=debt_limit)
            db_k["active"] = sv["active"]
            db_k["weak_total"] = int(sv["weak_active_total"])
            db_k["weak"] = sv["weak_active"]
            db_k["nonfact_kind_rows"] = int(sv["nonfact_kind_rows"])
            if db_k["weak_total"]:
                out["notes"].append(
                    "凭据债:活跃边 %d 条里 **%d 条没依据**(只给人看;要还债得他给编号)"
                    % (db_k["active"]["edges"], db_k["weak_total"]))
            if db_k["nonfact_kind_rows"]:
                out["notes"].append("⚠️ 有 %d 条事实边的 `kind` 非空(事实边不该带 kind)"
                                    % db_k["nonfact_kind_rows"])
        except Exception as exc:
            out["notes"].append("凭据债读不出来:%s" % exc)

    # 影子表(冻结)
    if _table_exists(conn, gate_mod.SHADOW_TABLE):
        out["shadow"]["rows"] = _count(conn, "SELECT COUNT(*) FROM " + gate_mod.SHADOW_TABLE)

    # 事实图
    if _table_exists(conn, "graph_nodes"):
        out["graph"]["nodes"] = _count(conn, "SELECT COUNT(*) FROM graph_nodes")
    if _table_exists(conn, "graph_edges"):
        out["graph"]["edges"] = _count(conn, "SELECT COUNT(*) FROM graph_edges")
        out["graph"]["active_edges"] = _count(
            conn, "SELECT COUNT(*) FROM graph_edges WHERE COALESCE(is_active, 1) = 1")

    # 回执(失效史)
    out["receipts"]["total"] = _count(conn, "SELECT COUNT(*) FROM " + RECEIPTS_TABLE) \
        if _table_exists(conn, RECEIPTS_TABLE) else 0
    out["receipts"]["recent"] = _recent_receipts(conn, limit=receipts)

    # 回退入口:每条路线的"现在会不会动东西"
    for route in ROLLBACK_ROUTES:
        item = {"route": route["route"], "what": route["what"], "table": route["table"],
                "how": route["how"], "recomputable": bool(route["recomputable"])}
        if route["route"] == "shadow-table":
            item.update({"available": False, "rows": 0,
                         "why_not": "已冻结:没有'最近一批'可退"})
        else:
            plan = plan_rollback(conn, route["route"], topic_owner=topic_owner,
                                 cooc_owner=cooc_owner)
            item.update({"available": bool(plan.get("rows")), "rows": int(plan.get("rows") or 0),
                         "detail": plan.get("detail", ""), "sql": plan.get("sql", "")})
        out["rollback"].append(item)
    return out


def plan_rollback(conn, route, *, topic_owner=TOPIC_OWNER, cooc_owner=COOC_OWNER):
    """**只看不写**:这条路线的回退会动几行。"""
    route = str(route or "").strip()
    if route == "cooc-evidence":
        if not _table_exists(conn, cooc_mod.EVIDENCE_TABLE):
            return {"route": route, "rows": 0, "detail": "证据层表不存在(没什么可退)",
                    "sql": ""}
        row = conn.execute("SELECT MAX(created_at) FROM " + cooc_mod.EVIDENCE_TABLE +
                           " WHERE owner_key = ?", (cooc_owner,)).fetchone()
        batch = float(row[0] or 0) if row else 0.0
        n = _count(conn, "SELECT COUNT(*) FROM " + cooc_mod.EVIDENCE_TABLE +
                   " WHERE owner_key = ? AND created_at = ?", (cooc_owner, batch))
        return {"route": route, "rows": n,
                "detail": "最近一批 created_at=%r 的 %d 条证据行" % (batch, n),
                "sql": "DELETE FROM " + cooc_mod.EVIDENCE_TABLE +
                       " WHERE owner_key = '%s' AND created_at = %r" % (cooc_owner, batch),
                "batch_created_at": batch}
    if route == "topic-view":
        if not _table_exists(conn, topics_mod.CLUSTER_TABLE):
            return {"route": route, "rows": 0, "detail": "主题簇表不存在(没什么可退)",
                    "sql": ""}
        n = _count(conn, "SELECT COUNT(*) FROM " + topics_mod.CLUSTER_TABLE +
                   " WHERE owner_key = ? AND COALESCE(is_active, 1) = 1", (topic_owner,))
        return {"route": route, "rows": n, "detail": "现行批次里 %d 个簇会退役(行不删)" % n,
                "sql": "UPDATE " + topics_mod.CLUSTER_TABLE + " SET is_active = 0"
                       " WHERE owner_key = '%s' AND is_active = 1" % topic_owner}
    if route == "shadow-table":
        return {"route": route, "rows": 0, "detail": "已冻结:**没有这个回退动作**", "sql": ""}
    return {"route": route, "rows": 0, "detail": "不认识的路线", "sql": ""}


def rollback(conn, route, *, apply=False, topic_owner=TOPIC_OWNER, cooc_owner=COOC_OWNER,
             now=None, run_id="", by="arch"):
    """回退:不做 `apply` 就只出计划;做了才动行,并**写一条回执**。"""
    now = float(now or time.time())
    plan = plan_rollback(conn, route, topic_owner=topic_owner, cooc_owner=cooc_owner)
    out = dict(plan)
    out["applied"] = False
    out["receipts"] = 0
    if not apply:
        out["dry_run"] = True
        return out
    out["dry_run"] = False
    if str(route) == "shadow-table":
        out["refused"] = "已冻结:没有这个回退动作(不是静默 0 行)"
        return out
    if str(route) == "cooc-evidence":
        if not plan.get("rows"):
            out["refused"] = "最近一批没有行可退"
            return out
        batch = plan.get("batch_created_at")
        conn.execute("DELETE FROM " + cooc_mod.EVIDENCE_TABLE +
                     " WHERE owner_key = ? AND created_at = ?", (cooc_owner, batch))
        out["applied"] = True
    elif str(route) == "topic-view":
        if not plan.get("rows"):
            out["refused"] = "没有现行批次可退役"
            return out
        res = topics_mod.deactivate(conn, owner=topic_owner, now=now)
        out["applied"] = True
        out["deactivated"] = res["deactivated"]
    else:
        out["refused"] = "不认识的路线"
        return out
    # 回执:谁退的、退了什么(流水账语义 —— 回退本身也要留痕)
    rec = gate_mod.write_receipts(conn, [{
        "kind": "cooc" if str(route) == "cooc-evidence" else "topic",
        "source_kind": "rollback", "target_kind": "batch",
        "source_id": str(route), "target_id": str(plan.get("batch_created_at") or ""),
        "action": "rollback", "reason": "panel-" + str(by),
        "note": "%s:%d 行" % (route, int(plan.get("rows") or 0)), "ts": now,
    }], run_id=run_id or ("rollback-" + str(int(now))), route="rollback-" + str(route))
    conn.commit()
    out["receipts"] = int(rec.get("inserted") or 0)
    out["table_missing"] = bool(rec.get("table_missing"))
    return out


def to_text(st):
    out = ["== A7 记忆架构 v2 · 状态(面板就画这些)=="]
    out.append("主题簇(%s):现行批次 %s,共 %d 簇,有摘要 %d、可重算"
               % (NATURE["topics"], st["topics"]["active_batch"] or "(无)",
                  len(st["topics"]["clusters"]), st["topics"]["summaries"]))
    for c in st["topics"]["clusters"]:
        out.append("   #%-3d %-24s %2d 人%s  摘要:%s"
                   % (c["cluster_id"], c["label"][:24], c["size"],
                      "(软 %d)" % len(c["soft"]) if c["soft"] else "",
                      c["summary"] or "(还没写)"))
    ev = st["evidence"]
    out.append("证据层(%s):%d 行 / %d 对 / 作用域 %s"
               % (NATURE["evidence"], ev["rows"], ev["pairs"],
                  json.dumps(ev["by_scope"], ensure_ascii=False)))
    out.append("影子表(%s):%d 行(冻结)" % (NATURE["shadow"], st["shadow"]["rows"]))
    d = st.get("debt") or {}
    if d.get("present") and d.get("active"):
        a = d["active"]
        out.append("凭据债(%s):活跃 %d 条里 无依据 %d / 仅推定 %d / 有依据 %d%s"
                   % (NATURE["debt"], a.get("edges", 0), a.get("none", 0), a.get("inferred", 0),
                      int(a.get("mixed", 0)) + int(a.get("real", 0)),
                      " · 非空 kind %d 条 ⚠️" % d["nonfact_kind_rows"]
                      if d.get("nonfact_kind_rows") else ""))
        for w in (d.get("weak") or [])[:4]:
            out.append("   #%-4d %-10s %s" % (w["edge_id"], w["relation"], w["evidence"] or "(空)"))
        if d.get("weak_total", 0) > 4:
            out.append("   …共 %d 条没依据(报表:`python -m engine.evidence_debt`)" % d["weak_total"])
    out.append("事实图:%d 节点 / %d 边(active %d)"
               % (st["graph"]["nodes"], st["graph"]["edges"], st["graph"]["active_edges"]))
    out.append("回执 %d 条;最近:%s"
               % (st["receipts"]["total"],
                  ";".join("#%d %s %s" % (r["id"], r["action"], r["note"] or "-")
                           for r in st["receipts"]["recent"][:4]) or "(无)"))
    out.append("回退入口:")
    for r in st["rollback"]:
        out.append("   %-14s %s → %s%s"
                   % (r["route"], r["what"],
                      ("可退 %d 行" % r["rows"]) if r["available"] else "现在没有可退的",
                      "" if r["recomputable"] else "(不可重算,只有审计)"))
    for n in st["notes"]:
        out.append("   · " + n)
    return "\n".join(out)


def main(argv=None):
    ap = argparse.ArgumentParser(description="A7 运维读口聚合 + 一键回退")
    ap.add_argument("--db", default=None)
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--report", default=None)
    ap.add_argument("--rollback", default=None, help="路线名(cooc-evidence / topic-view)")
    ap.add_argument("--apply", action="store_true", help="真的退(不带就只看)")
    ap.add_argument("--by", default="cli")
    args = ap.parse_args(argv)

    path = args.db or os.path.join(os.path.expanduser("~"), ".dsh", "echo", "echo.db")
    conn = db_mod.connect(path)
    try:
        if args.rollback:
            res = rollback(conn, args.rollback, apply=bool(args.apply), by=args.by)
            text = ("== A7 回退" + ("(APPLY)" if args.apply else "(DRY-RUN)") + " ==\n"
                    + json.dumps(res, ensure_ascii=False, indent=2))
            print(text if not args.json else json.dumps(res, ensure_ascii=False))
            return 0
        st = status(conn)
        if args.report:
            with open(args.report, "w", encoding="utf-8") as fh:
                fh.write("# A7 记忆架构 v2 · 状态\n\n库:`%s`\n\n%s\n" % (path, to_text(st)))
        if args.json:
            print(json.dumps({"db": path, "status": st}, ensure_ascii=False, indent=2))
        else:
            print("库 %s\n%s" % (path, to_text(st)))
        return 0
    finally:
        try:
            conn.close()
        except Exception:
            pass


if __name__ == "__main__":
    sys.exit(main())
