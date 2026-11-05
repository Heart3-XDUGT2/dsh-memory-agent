# -*- coding: utf-8 -*-
"""A4:把共现**降级为 n 元证据层**(不落 pair 边)。

一层一句话:影子表那 48 条 pair 行是"已拆开的两两事实",本模块把它们**收回**
成"哪条记忆/哪一天里同时出现了哪些概念"的 n 元证据,并把 pair 留给只读视图按需派生。

用法(在 `python/` 目录下):
    python -m engine.cooc --db <path>                # 只演:分组计划 + 覆盖率
    python -m engine.cooc --db <path> --report <md>  # 顺手写 Markdown 报告
    python -m engine.cooc --db <path> --apply        # 真写(幂等:INSERT OR REPLACE)
    python -m engine.cooc --db <path> --json

口径(全部写在这里,别在别处长第二份):
  * **一条证据** = (scope_kind, 桶键):`same_memory` 按记忆 id;`same_day` 按 `occurred_at` 天的桶;
  * `node_ids` = 这条证据覆盖到的概念(排序、去重、`、` 连接)—— **n 元**;
  * `pairs`    = 闸门当时放行的 pair(`源|目标`,小的在前,逗号分隔)—— 判据原样保留,
                 **不在盘上铺成边**;`v_cooc_pairs` 按需展开;
  * `weight`   = 这条证据里最强那一对的 weight(影子表的 weight 语义 = "几条记忆作证")。

⚠️ 只读纪律:本模块**不进任何检索/渲染路径**(进 prompt 要单独裁决)。有 grep 级
守卫测试盯着检索侧文件里不许出现 `graph_cooc_evidence` / `v_cooc_pairs`。
"""

import argparse
import json
import os
import sys
import time

from . import db as db_mod

COOC_OWNER = "__cooc__"
SHADOW_OWNER = "__shadow__"
#: 证据表 / 只读视图的名字(**单一出处**:建表在 `db.py` 的迁移里,引用都从这里取)。
EVIDENCE_TABLE = "graph_cooc_evidence"
EVIDENCE_VIEW = "v_cooc_pairs"
SCOPE_SAME_MEMORY = "same_memory"
SCOPE_SAME_DAY = "same_day"
#: 影子表里属于"共现"的两类(其它 kind 不由本层负责 —— 例如 `temporal`)。
#: 覆盖率只拿这两类比:跳过的不算"丢"。
COOC_KINDS = ("cooccur_same_memory", "cooccur_same_day")
SEP = "、"

#: 证据层的读者名单(检索/渲染侧):这些文件里出现表名/视图名 = 红。
#: ⚠️ `graph_gate.py` **不在**名单里 —— 它是**写入侧**(v2-A4 起把共现落进证据层);
#: 闸门里"读的那半边"(`build_context_from_db`)由单测单独盯(见
#: `test_the_gate_reader_does_not_read_it`),免得整文件一刀切把写口也判红。
#: ⚠️ 2026-10-02 起 JS 侧的幽灵层(图谱上只给人看的两层)也走同一套先例:
#: 两个名字**收进 `lib/graph-ghost.js` 一个文件**(展示层孤门),名单保持原样。
#: 孤门的守卫(test_the_ghost_module_is_the_only_js_door)三条:
#:   ① 名字只许在孤门里出现 —— `lib/` 其它文件一律不许提(比原来更紧);
#:      唯一例外:`lib/index.js` 的写入侧文案(echo_graph_gate 的 writesTo/rollback
#:      帮助文本)—— 只许当文案提,不许和任何 SQL 执行同行(单测逐行盯);
#:   ② 孤门里必须有 `inRetrieval: false`(它给出去的东西检索永远看不见);
#:   ③ 检索/渲染侧(Python 读侧名单)连孤门的存在都不许知道。
#: `lib/store.js` 是孤门的唯一调用方(graphData 的展示段)—— 名字钉子照样管住它。
READ_SIDE_FILES = (
    "python/engine/graph.py",
    "python/engine/retrieve.py",
    "python/worker.py",
    "lib/store.js",
    "lib/soul-snapshot.js",
)
#: 允许提到禁名的 JS 文件(展示层孤门;它给出去的东西一律 inRetrieval: false)。
GHOST_MODULE = "lib/graph-ghost.js"
FORBIDDEN_NAMES = ("graph_cooc_evidence", "v_cooc_pairs")


def _ids(raw):
    """拆记忆 id 串(`'280、285'` → `[280, 285]`);不认的段落丢掉。"""
    out = []
    for chunk in str(raw or "").replace(",", SEP).replace("，", SEP).split(SEP):
        try:
            out.append(int(chunk.strip()))
        except (TypeError, ValueError):
            continue
    return out


def pair_key(a, b):
    """pair 的**规范键**:小的在前(`源|目标`)。方向无关,去重才稳。"""
    x, y = str(a), str(b)
    return (x + "|" + y) if x <= y else (y + "|" + x)


def build_plan(conn, *, shadow_owner=SHADOW_OWNER, cooc_owner=COOC_OWNER):
    """读影子表(**只读**),产出 n 元证据行的计划。"""
    try:
        rows = conn.execute(
            "SELECT source_id, target_id, kind, COALESCE(evidence, ''),"
            " COALESCE(occurred_at, 0), COALESCE(weight, 1), COALESCE(is_active, 1)"
            " FROM graph_shadow_edges WHERE COALESCE(owner_key, '') = ?",
            (shadow_owner,)).fetchall()
    except Exception:
        rows = []

    buckets = {}          # (scope_kind, key) -> {"pairs": set, "weight": float, "mem": [...]}
    skipped = []
    for src, tgt, kind, evidence, occurred_at, weight, is_active in rows:
        if not int(is_active or 0):
            skipped.append({"reason": "archived"})
            continue
        key_pair = pair_key(src, tgt)
        if str(kind) == "cooccur_same_memory":
            mems = _ids(evidence)
            if not mems:
                skipped.append({"reason": "same_memory-without-id", "pair": key_pair})
                continue
            for mid in mems:
                b = buckets.setdefault((SCOPE_SAME_MEMORY, str(mid)),
                                       {"pairs": set(), "weight": 0.0, "memory_id": mid,
                                        "day_key": ""})
                b["pairs"].add(key_pair)
                b["weight"] = max(b["weight"], float(weight or 1.0))
        elif str(kind) == "cooccur_same_day":
            day_key = str(int(float(occurred_at or 0)))
            b = buckets.setdefault((SCOPE_SAME_DAY, day_key),
                                   {"pairs": set(), "weight": 0.0, "memory_id": 0,
                                    "day_key": day_key})
            b["pairs"].add(key_pair)
            b["weight"] = max(b["weight"], float(weight or 1.0))
        else:
            skipped.append({"reason": "kind-not-cooc", "kind": str(kind), "pair": key_pair})

    items = []
    for (scope, _key), b in sorted(buckets.items()):
        nodes = sorted({n for p in b["pairs"] for n in p.split("|")})
        items.append({"owner_key": cooc_owner, "scope_kind": scope,
                      "memory_id": int(b["memory_id"]), "day_key": b["day_key"],
                      "node_ids": SEP.join(nodes), "pairs": ",".join(sorted(b["pairs"])),
                      "node_count": len(nodes), "pair_count": len(b["pairs"]),
                      "weight": float(b["weight"])})
    shadow_pairs = {pair_key(r[0], r[1]) for r in rows
                    if int(r[6] or 0) and str(r[2]) in (COOC_KINDS)}
    return {"shadow_rows": len(rows), "shadow_pairs": sorted(shadow_pairs),
            "skipped": skipped, "items": items,
            "scopes": {s: len([i for i in items if i["scope_kind"] == s])
                       for s in (SCOPE_SAME_MEMORY, SCOPE_SAME_DAY)}}


def apply_plan(conn, plan, *, source_kind="shadow-migrate", now=None):
    """真写(幂等):`INSERT OR REPLACE` —— 同一个 (owner, scope, 桶) 只留一行。"""
    now = float(now or time.time())
    written = 0
    for it in plan["items"]:
        conn.execute(
            "INSERT OR REPLACE INTO graph_cooc_evidence"
            " (evidence_id, owner_key, scope_kind, memory_id, day_key, node_ids, pairs,"
            "  node_count, pair_count, weight, source_kind, created_at)"
            " VALUES ((SELECT evidence_id FROM graph_cooc_evidence WHERE owner_key = ?"
            "          AND scope_kind = ? AND memory_id = ? AND day_key = ?),"
            "  ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (it["owner_key"], it["scope_kind"], int(it["memory_id"]), it["day_key"],
             it["owner_key"], it["scope_kind"], int(it["memory_id"]), it["day_key"],
             it["node_ids"], it["pairs"], int(it["node_count"]), int(it["pair_count"]),
             float(it["weight"]), source_kind, now))
        written += 1
    db_mod._mark_migration(conn, "a4_cooc_evidence_v1", now=now)
    conn.commit()
    return {"written": written, "source_kind": source_kind, "ran_at": now}


def projected_coverage(plan):
    """**只演**时算的覆盖率:apply 之后视图会派生出的 pair(从计划直接推)。"""
    keys = {p for it in plan["items"] for p in it["pairs"].split(",") if p}
    want = set(plan["shadow_pairs"])
    return {"mode": "projected", "derived_rows": sum(it["pair_count"] for it in plan["items"]),
            "derived_keys": len(keys), "shadow_pairs": len(want),
            "missing": sorted(want - keys), "extra_keys": len(keys - want)}


def coverage(conn, plan, *, cooc_owner=COOC_OWNER):
    """派生出来的 pair 覆盖影子表那 48 条吗?(验收②③)

    分两个数:`derived_rows` = 视图里的行数(同一条 pair 可能被多条证据作证 ⇒ 会重复),
    `derived_keys` = **去重**后的 pair 键数 —— 覆盖率比的是后者。
    """
    try:
        rows = [str(r[0]) for r in conn.execute(
            "SELECT pair_key FROM v_cooc_pairs WHERE owner_key = ?", (cooc_owner,))]
    except Exception:
        rows = []
    derived = set(rows)
    want = set(plan["shadow_pairs"])
    return {"mode": "verified", "derived_rows": len(rows), "derived_keys": len(derived),
            "shadow_pairs": len(want), "missing": sorted(want - derived),
            "extra_keys": len(derived - want)}


def report(conn, *, cooc_owner=COOC_OWNER, shadow_owner=SHADOW_OWNER):
    """只读盘点:证据行 / n 元规模 / 派生 pair / 影子表是否冻结。"""
    out = {"owner": cooc_owner, "rows": 0, "by_scope": {}, "node_refs": 0,
           "derived_pairs": 0, "shadow_rows": 0, "shadow_kinds": {}}
    try:
        out["rows"] = int(conn.execute(
            "SELECT COUNT(*) FROM graph_cooc_evidence WHERE owner_key = ?",
            (cooc_owner,)).fetchone()[0])
        for scope, n, nodes, pairs in conn.execute(
                "SELECT scope_kind, COUNT(*), SUM(node_count), SUM(pair_count)"
                " FROM graph_cooc_evidence WHERE owner_key = ? GROUP BY scope_kind",
                (cooc_owner,)):
            out["by_scope"][str(scope)] = {"rows": int(n), "node_refs": int(nodes or 0),
                                          "pair_refs": int(pairs or 0)}
        out["derived_pairs"] = int(conn.execute(
            "SELECT COUNT(*) FROM v_cooc_pairs WHERE owner_key = ?",
            (cooc_owner,)).fetchone()[0])
    except Exception:
        pass
    try:
        out["shadow_rows"] = int(conn.execute(
            "SELECT COUNT(*) FROM graph_shadow_edges WHERE COALESCE(owner_key,'') = ?",
            (shadow_owner,)).fetchone()[0])
        for kind, n in conn.execute(
                "SELECT kind, COUNT(*) FROM graph_shadow_edges GROUP BY kind"):
            out["shadow_kinds"][str(kind)] = int(n)
    except Exception:
        pass
    return out


def to_text(rep, plan=None, cov=None):
    out = ["== A4 共现证据层(n 元,不落 pair 边)=="]
    out.append("① 证据行 %d 行:%s"
               % (rep["rows"], json.dumps(rep["by_scope"], ensure_ascii=False)))
    out.append("② 视图 `v_cooc_pairs` 现派生 %d 条 pair(**不落库**)" % rep["derived_pairs"])
    out.append("③ 影子表仍 %d 行(%s)—— 冻结,不再增长"
               % (rep["shadow_rows"], json.dumps(rep["shadow_kinds"], ensure_ascii=False)))
    if plan is not None:
        out.append("④ 迁入计划:%d 行(同记忆 %d / 同日 %d);影子 pair %d 条;跳过 %d 条 %s"
                   % (len(plan["items"]), plan["scopes"].get(SCOPE_SAME_MEMORY, 0),
                      plan["scopes"].get(SCOPE_SAME_DAY, 0), len(plan["shadow_pairs"]),
                      len(plan["skipped"]),
                      json.dumps(plan["skipped"][:3], ensure_ascii=False) if plan["skipped"] else ""))
        for it in plan["items"][:10]:
            label = ("记忆 #%d" % it["memory_id"]) if it["scope_kind"] == SCOPE_SAME_MEMORY \
                else ("日桶 %s" % it["day_key"])
            out.append("   %-12s n=%d p=%d w=%.0f  %s"
                       % (label, it["node_count"], it["pair_count"], it["weight"],
                          it["node_ids"][:64]))
    if cov is not None:
        out.append("⑤ 覆盖[%s]:影子 %d 条 pair(distinct),派生行 %d / 去重 %d;缺 %d 条 %s;"
                   "派生多出 %d 个键(闸门放行的其它组合)"
                   % ("实测" if cov.get("mode") == "verified" else "预计",
                      cov["shadow_pairs"], cov["derived_rows"], cov["derived_keys"],
                      len(cov["missing"]), cov["missing"][:3], cov["extra_keys"]))
    return "\n".join(out)


def main(argv=None):
    ap = argparse.ArgumentParser(description="A4 共现证据层(默认只演)")
    ap.add_argument("--db", default=None)
    ap.add_argument("--apply", action="store_true")
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--report", default=None)
    args = ap.parse_args(argv)

    path = args.db or os.path.join(os.path.expanduser("~"), ".dsh", "echo", "echo.db")
    conn = db_mod.connect(path)
    try:
        plan = build_plan(conn)
        projected = projected_coverage(plan)
        written = apply_plan(conn, plan) if args.apply else None
        cov = coverage(conn, plan) if args.apply else projected
        rep = report(conn)
        payload = {"db": path, "plan": {k: v for k, v in plan.items() if k != "items"},
                   "coverage": cov, "projected": projected, "report": rep,
                   "written": written}
        text = to_text(rep, plan, cov)
        if args.report:
            with open(args.report, "w", encoding="utf-8") as fh:
                fh.write("# A4 共现证据层 · 报告\n\n库:`%s`\n\n%s\n" % (path, text))
        if args.json:
            print(json.dumps(payload, ensure_ascii=False, indent=2))
        else:
            print("库 %s\n%s" % (path, text))
            if written:
                print("\n已写:%s" % json.dumps(written, ensure_ascii=False))
            else:
                print("\n下一步:核对后 --apply(幂等:同一 (owner, scope, 桶) 只留一行)")
        return 0
    finally:
        try:
            conn.close()
        except Exception:
            pass


if __name__ == "__main__":
    sys.exit(main())
