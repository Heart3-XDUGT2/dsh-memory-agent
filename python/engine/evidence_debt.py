# -*- coding: utf-8 -*-
"""A3 证据债报表(**只读**,不写一行)。

用一句话说清这个工具的作用:**把"事实边到底有没有依据"从看不出来变成一眼可数。**

背景:活库 45 条事实边里 17 条 `evidence` 是空的,还有一批只有 `(推定)` 后缀
(那次字面匹配回填留下的)。空依据**不是错误**(`graph.learn` 的注释:"留空而不是
瞎填")—— 但"有多少条没依据"必须**能数**,否则 A8 评估时无法回答
「她的自信里有多少是凭据、多少是猜的」。

用法(在 `python/` 目录下):
    python -m engine.evidence_debt --db <path> [--owner master] [--json] [--limit N]
"""

import argparse
import json
import os
import sys

from . import db as db_mod
from . import evidence as ev

WEAK = ("none", "inferred")


def survey(conn, owner_key, limit=20):
    rows = conn.execute(
        "SELECT edge_id, relation, COALESCE(evidence, ''), is_active,"
        " COALESCE(layer, ''), COALESCE(learned_at, 0)"
        " FROM graph_edges WHERE owner_key = ? ORDER BY edge_id",
        (owner_key,)).fetchall()

    def tally(only_active):
        out = {"edges": 0, "none": 0, "inferred": 0, "mixed": 0, "real": 0}
        for r in rows:
            if only_active and not int(r[3]):
                continue
            out["edges"] += 1
            out[ev.strength(r[2])] += 1
        return out

    weak = [{"edge_id": int(r[0]), "relation": str(r[1]),
             "strength": ev.strength(r[2]), "evidence": str(r[2]),
             "layer": str(r[4]), "learned_at": float(r[5] or 0.0)}
            for r in rows if int(r[3]) and ev.strength(r[2]) in WEAK]
    bad_kind = conn.execute(
        "SELECT COUNT(*) FROM graph_edges WHERE COALESCE(kind, '') <> ''").fetchone()[0]
    return {"owner": owner_key, "all": tally(False), "active": tally(True),
            "weak_active": weak[:limit], "weak_active_total": len(weak),
            "nonfact_kind_rows": int(bad_kind)}


def to_text(sv):
    out = []
    out.append("== A3 证据债(只读报表)==")
    out.append("库归属 %s" % sv["owner"])
    out.append("① 类型守卫:`graph_edges` 里非空 `kind` = **%d** 条(必须 0 —— 非空 = 把事实边"
               "伪装成影子边,`top_nodes()` 与剪枝会漏掉它)" % sv["nonfact_kind_rows"])
    for label, key in (("全部事实边", "all"), ("活跃事实边", "active")):
        d = sv[key]
        out.append("② %s %d 条:无依据 **%d** | 仅推定 %d | 真编号+推定 %d | 有真编号 %d"
                   % (label, d["edges"], d["none"], d["inferred"], d["mixed"], d["real"]))
    if sv["weak_active_total"]:
        out.append("③ 弱依据的活跃边(前 %d / 共 %d):" % (len(sv["weak_active"]), sv["weak_active_total"]))
        for w in sv["weak_active"]:
            out.append("   #%-4d %-10s %-8s %s"
                       % (w["edge_id"], w["relation"], ev.describe(w["evidence"]),
                          ("layer=%s" % w["layer"]) if w["layer"] else "layer=(无)"))
    out.append("说明:空依据**不是错误**(诚实留空);本报表只数不改 —— 要不要"
               "去补依据,由他裁定(A8 评估时用这些数回答「自信里多少是凭据」)。")
    return "\n".join(out)


def main(argv=None):
    ap = argparse.ArgumentParser(description="A3 证据债报表(只读)")
    ap.add_argument("--db", default=None)
    ap.add_argument("--owner", default="master")
    ap.add_argument("--limit", type=int, default=20)
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args(argv)

    path = args.db or os.path.join(os.path.expanduser("~"), ".dsh", "echo", "echo.db")
    conn = db_mod.connect(path)
    try:
        sv = survey(conn, args.owner, limit=args.limit)
        if args.json:
            print(json.dumps({"db": path, **sv}, ensure_ascii=False, indent=2))
        else:
            print("库 %s\n%s" % (path, to_text(sv)))
        return 0
    finally:
        try:
            conn.close()
        except Exception:
            pass


if __name__ == "__main__":
    sys.exit(main())
