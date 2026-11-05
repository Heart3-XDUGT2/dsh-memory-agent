# -*- coding: utf-8 -*-
"""A2 谓词归一:把同义的现场写法并到规范谓词上(默认只演)。

用法(在 `python/` 目录下):
    python -m engine.normalize_relations --db <path>                  # 只演:出对照表
    python -m engine.normalize_relations --db <path> --report <md>    # 顺手把表写成 Markdown
    python -m engine.normalize_relations --db <path> --json           # 结构化
    python -m engine.normalize_relations --db <path> --apply          # 真写(先留 relation_raw)

判据**只在 `relations.py` 一处**:`CANONICAL_RELATION`(确定合并,只并同义)+
`RELATION_PENDING`(拿不准的,只报告、等他拍)。

写库纪律:
  ① 先把原话抄进 `relation_raw`(回退/审计依据),再改 `relation`;
  ② 改名/吸收交给既有的 `graph.merge_relation_variants`(已测、幂等、不物理删除);
  ③ 只动**表内**谓词,表外一律不碰;
  ④ 账本留名 `a2_relation_canonical`。
"""

import argparse
import json
import os
import sys

from . import db as db_mod
from . import graph
from . import relations as relations_mod

MARKER = "a2_relation_canonical"


def survey(conn, owner_key):
    """只读盘点:现场谓词分布 + **可执行的**合并计划 + 待定项。

    两条现场事实(2026-10-01 实测,决定了这份报表的口径):

    1. `graph_edges` 有 `UNIQUE(source_id, target_id, relation, owner_key)`
       —— 变体一旦被吸收归档,它的谓词就**必须永久保留原话**(改成规范写法会
       撞上幸存者那条唯一键)。所以「全表 distinct」是个**历史冻结值**。
    2. `merge_relation_variants` 会**跳过已归档行**(`superseded_by<>0`,幂等守卫)。

    ⇒ **能动的是活跃侧的词表**,报表按活跃侧给数;冻结的变体单列一层,不假装能瘦。
    """
    rows = conn.execute(
        "SELECT relation, COUNT(*) AS n,"
        " SUM(CASE WHEN is_active = 1 THEN 1 ELSE 0 END) AS act,"
        " SUM(CASE WHEN COALESCE(superseded_by, 0) <> 0 THEN 1 ELSE 0 END) AS arch"
        " FROM graph_edges WHERE owner_key = ? GROUP BY relation"
        " ORDER BY n DESC, relation", (owner_key,)).fetchall()
    live = {str(r[0]): {"n": int(r[1]), "active": int(r[2] or 0), "archived": int(r[3] or 0)}
            for r in rows}

    def rel_of(eid):
        row = conn.execute("SELECT relation FROM graph_edges WHERE edge_id = ?",
                           (int(eid),)).fetchone()
        return str(row[0]) if row else ""

    plan = graph.merge_relation_variants(conn, owner_key, dry_run=True)  # 纯读:dry_run 不写库
    ren, absorbed = {}, {}
    for eid in plan["renamed"]:
        ren.setdefault(rel_of(eid), []).append(int(eid))
    for eid, _surv in plan["merged"]:
        absorbed.setdefault(rel_of(eid), []).append(int(eid))

    variants = relations_mod.relation_merges()
    merges = []
    for variant, canon in sorted(variants.items()):
        if variant not in live:
            continue
        merges.append({"variant": variant, "canonical": canon, **live[variant],
                       "rename": ren.get(variant, []),
                       "absorb": absorbed.get(variant, []),
                       "processable": bool(ren.get(variant) or absorbed.get(variant))})
    frozen = sorted(r for r in live if r in variants and not (ren.get(r) or absorbed.get(r)))

    active_rel = {r for r, d in live.items() if d["active"]}
    cut = sum(1 for m in merges if live[m["variant"]]["active"] > 0 and m["processable"])
    pending = []
    cut_pending = 0
    for p in relations_mod.pending_relations():  # P3-c:数据(graph.json.relations.pending)优先,空 ⇒ 内置
        names = [x.strip() for x in str(p["variant"]).replace("/", " ").split() if x.strip()]
        hit = {n: live[n] for n in names if n in live}
        if hit:
            pending.append({**p, "in_live": hit})
            cut_pending += sum(1 for n in hit if live[n]["active"] > 0)
    return {"owner": owner_key, "live": live,
            "distinct_all": len(live), "distinct_active": len(active_rel),
            "merges": merges, "frozen": frozen, "pending": pending,
            "active_after": len(active_rel) - cut,
            "active_after_pending": len(active_rel) - cut - cut_pending}


def to_markdown(sv):
    out = []
    out.append("### 现状:45 条边用了 **%d** 个不同谓词;其中**活跃侧 %d 个**"
               % (sv["distinct_all"], sv["distinct_active"]))
    rows = sorted(sv["live"].items(), key=lambda kv: (-kv[1]["n"], kv[0]))
    out.append("| 谓词 | 边数 | 活跃 | 已归档 | 处置 |")
    out.append("|---|---|---|---|---|")
    merge_map = {m["variant"]: m for m in sv["merges"]}
    pend_names = {n: p["candidate"] for p in sv["pending"] for n in p["in_live"]}
    for name, d in rows:
        if name in merge_map:
            m = merge_map[name]
            how = ("**并 → %s**(改名 %d / 吸收 %d)" % (m["canonical"], len(m["rename"]), len(m["absorb"]))
                   if m["processable"] else
                   "并 → %s(仅有归档行,**冻结**:唯一键挡着)" % m["canonical"])
        elif name in pend_names:
            how = "待定(候选:%s)" % pend_names[name]
        elif name in sv["frozen"]:
            how = "冻结(全归档)"
        else:
            how = "保留"
        out.append("| %s | %d | %d | %d | %s |"
                   % (name, d["n"], d["active"], d["archived"], how))
    out.append("")
    out.append("### 这次真能动的(活跃侧):%d 组" % len([m for m in sv["merges"] if m["processable"]]))
    for m in sv["merges"]:
        if not m["processable"]:
            continue
        out.append("- `%s` → `%s`:%s(%d 条,活 %d)"
                   % (m["variant"], m["canonical"],
                      ("改名 " + str(m["rename"])) if m["rename"] else "",
                      m["n"], m["active"]))
        if m["absorb"]:
            out.append("  - 吸收留档:%s(同目标已有规范边)" % m["absorb"])
    if sv["frozen"]:
        out.append("")
        out.append("### 冻结的(%d 个变体只剩归档行,谓词永久留原话):%s"
                   % (len(sv["frozen"]), "、".join("`%s`" % f for f in sv["frozen"])))
    out.append("")
    out.append("### 待定(拿不准,**只有他能拍**):%d 项" % len(sv["pending"]))
    for p in sv["pending"]:
        hit = "、".join("%s(%d 条,活 %d)" % (k, v["n"], v["active"]) for k, v in p["in_live"].items())
        out.append("- `%s` → 候选 `%s` —— 现场:%s\n  - 疑点:%s"
                   % (p["variant"], p["candidate"], hit, p["why"]))
    out.append("")
    out.append("### 结果(活跃侧词表):**%d → %d**(确定合并后);若待定项也并 → **%d**"
               % (sv["distinct_active"], sv["active_after"], sv["active_after_pending"]))
    out.append("")
    out.append("> 注:全表 distinct %d 里含**归档行的历史原话** —— 唯一键 "
               "`UNIQUE(源,目标,谓词,owner)` 不允许它们改名,所以全表口径只会"
               "缓慢下降(每期新写边都走规范写法)。" % sv["distinct_all"])
    return "\n".join(out)


def apply_changes(conn, owner_key, sv, *, now=None):
    """真写:先抄 `relation_raw`,再交给既有的 `merge_relation_variants`。"""
    import time
    now = float(now or time.time())
    variants = [m["variant"] for m in sv["merges"]]
    if variants:
        qs = ",".join("?" for _ in variants)
        conn.execute(
            "UPDATE graph_edges SET relation_raw = relation"
            " WHERE owner_key = ? AND COALESCE(relation_raw, '') = ''"
            " AND relation IN (%s)" % qs, (owner_key, *variants))
        conn.commit()
    res = graph.merge_relation_variants(conn, owner_key, commit=True)
    # 改名之后槽位会漂(`slot` 是派生串)⇒ 当场对齐,不留"等下次开库"的窗口。
    db_mod.sync_slots(conn)
    db_mod._mark_migration(conn, MARKER, now=now)
    conn.commit()
    return {"renamed": res["renamed"], "merged": [list(x) for x in res["merged"]],
            "ran_at": now, "marker": MARKER}


def main(argv=None):
    ap = argparse.ArgumentParser(description="A2 谓词归一(默认只演)")
    ap.add_argument("--db", default=None)
    ap.add_argument("--owner", default="master")
    ap.add_argument("--apply", action="store_true")
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--report", default=None, help="把对照表写成 Markdown 到这个路径")
    args = ap.parse_args(argv)

    path = args.db or os.path.join(os.path.expanduser("~"), ".dsh", "echo", "echo.db")
    conn = db_mod.connect(path)
    try:
        sv = survey(conn, args.owner)
        md = to_markdown(sv)
        out = {"db": path, **sv, "apply": bool(args.apply)}
        if args.apply:
            out["written"] = apply_changes(conn, args.owner, sv)
        if args.report:
            with open(args.report, "w", encoding="utf-8") as fh:
                fh.write("# A2 谓词归一 · 对照表\n\n库:`%s`\n\n%s\n" % (path, md))
        if args.json:
            print(json.dumps(out, ensure_ascii=False, indent=2))
        else:
            print("== A2 谓词归一(%s)==" % ("真写" if args.apply else "只演"))
            print("库 %s" % path)
            print(md)
            if args.apply:
                print("\n已写:%s" % json.dumps(out["written"], ensure_ascii=False))
            else:
                print("\n下一步:核对后 --apply(先把原话抄进 relation_raw,再改名/吸收)")
        return 0
    finally:
        try:
            conn.close()
        except Exception:
            pass


if __name__ == "__main__":
    sys.exit(main())
