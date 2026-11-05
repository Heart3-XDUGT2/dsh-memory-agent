# -*- coding: utf-8 -*-
"""A1 一次性回补:把「被同类顶下线」的并列事实救回来(默认只演不写)。

用法(在 `python/` 目录下):
    python -m engine.repair_multivalue --db <path>              # 只演:列清单
    python -m engine.repair_multivalue --db <path> --json       # 结构化清单
    python -m engine.repair_multivalue --db <path> --apply      # 真写(逐条留回执)

判据(全部来自 `relations.py`,不在这里另立一套):

* **边**:`is_active=0` 且 `superseded_by` 指着一条**同 (owner, source, relation)、
  不同目标**的现役边,而该关系是**多值** ⇒ 这条是「并列被顶掉」,该复活。
* **记忆**:`is_active=0` 且 `superseded_by` 指着一条**同 (user, memory_key)**
  的现役行,而该键在 `MULTIVALUE_MEMORY_KEYS` 里、且两行摘要不同
  ⇒ 该复活。
* **只报告不动手**:单值关系下出现「多个活跃目标」的(例如 `用户—就读于`
  今天挂着 2 个目标)——那是另一个方向的毛病(该收不该放),要不要收由他裁定,
  本工具默认**不碰**。
* **同题重复守卫(A11 实测后为默认,2026-10-02)**:唤回一条记忆前,先看它是不是
  "已经有人在说" —— 现役里已有近似表达(双字覆盖 ≥ 0.60),或本次另一条把它包含
  (≥ 0.85)⇒ **按住**,理由逐条打印。`--no-repeat-guard` = 形态 A1 全量;
  `--active-cover 0.40` ≈ 形态 C。**边不受守卫影响**(5 条边照旧全回)。
  形态 E 实测:活跃 L0 5→8、R1BM25 mrr 0.694→0.671、SEH@3 **Δ0**(76.2%)。

写库纪律:每写一条**先留回执**(`graph_edge_receipts`,`action='restore'`,
`reason='multivalue-slot-collision'`),再改 `is_active/superseded_by`;
`slot_v1` 由 `db.connect()` 的迁移负责,这里不碰槽位。
"""

import argparse
import json
import sys
import time

from . import db as db_mod
from . import dedupe as dedupe_mod
from . import graph_gate
from . import relations as relations_mod

REASON = "multivalue-slot-collision"
RULE = "A1"

#: 「同题重复」守卫(A11 实测后定为**默认形态 E**,2026-10-02)。
#: 唤回一条记忆前先问一句"这条内容是不是已经有人在说了" —— 两条判据都是**双字覆盖比**
#: (机械,不看口味):
#:   ① 现役里已有某条盖住它 ≥ `REPEAT_ACTIVE_COVER`(0.60)⇒ 按住(同题重复表达);
#:   ② 本次一起唤回的另一条盖住它 ≥ `REPEAT_SIBLING_COVER`(0.85)⇒ 按住短的(留信息最全的)。
#: 为什么要有:检索台口径是"L0 强制占位"(L0 记忆无条件进**每一道题**的候选池),
#: 同题重复的 L0 会**挤别人的位置**。链前副本实测:不做守卫 → 活跃 L0 5→10、
#: R1BM25 mrr@10 0.694→0.659、SEH@3 76.2%→71.4%;守卫默认 → 5→8、mrr 0.671
#: 且 SEH@3 **完全回来**(76.2%)。
#: 分离度(同一份副本):#127 被现役 #169 盖 **0.62**、#128 被 #126 盖 **0.89**、
#: #126 被 #99 盖 0.56、#291 0.15、#313 0.32 ⇒ 0.60 干净地落在中间。
#: 调到 ~0.40 会把 #126 也按住(那是形态 C:词法零代价,但"<称呼>喜欢吃章鱼小丸子"
#: 那一侧暂不在现役)—— 这一格刻度就是 E 与 C 的全部差别。
#:
#: ⚠️ 与写入闸那位判官的分工:守卫**故意允许跨层比**(上面 #127 就是被一条 reflection 层
#: 的现役行盖住的)—— 因为这几条误退役**正是跨层 collapse 造成的**;但**只在"唤回"这个动作上比**,
#: `dedupe.is_near_duplicate`(写入闸,同层硬前提)与 `episodic.py` 的落库判重**一个字没改**。
REPEAT_ACTIVE_COVER = 0.60
REPEAT_SIBLING_COVER = 0.85


def _rows(conn, sql, params=()):
    cur = conn.execute(sql, params)
    cols = [d[0] for d in (cur.description or [])]
    return [dict(zip(cols, r)) for r in cur.fetchall()]


def collect(conn, *, repeat_guard=True, active_cover=REPEAT_ACTIVE_COVER,
            sibling_cover=REPEAT_SIBLING_COVER):
    """只读收集:可复活的边 / 记忆,以及「只报告」的观察项。

    `repeat_guard=False` = 形态 A1 全量(5 条记忆全回);默认 = 形态 E(同题重复按住)。
    """
    edges = _rows(conn, """
        SELECT e.edge_id, e.owner_key, e.relation, e.source_id, e.target_id,
               e.is_active, e.superseded_by, e.evidence,
               sn.name AS source_name, tn.name AS target_name,
               sp.name AS superseder_source_name, tp.name AS superseder_target_name
          FROM graph_edges e
          LEFT JOIN graph_nodes sn ON sn.node_id = e.source_id
          LEFT JOIN graph_nodes tn ON tn.node_id = e.target_id
          LEFT JOIN graph_edges s ON s.edge_id = e.superseded_by
          LEFT JOIN graph_nodes sp ON sp.node_id = s.source_id
          LEFT JOIN graph_nodes tp ON tp.node_id = s.target_id
         WHERE e.is_active = 0 AND COALESCE(e.superseded_by, 0) <> 0
         ORDER BY e.edge_id""")
    restore_edges, blocked_single = [], []
    for e in edges:
        if relations_mod.is_single_value_relation(e["relation"]):
            blocked_single.append(e)          # 单值换代:正常行为,不动
            continue
        sup = _rows(conn, "SELECT source_id, target_id, relation FROM graph_edges"
                          " WHERE edge_id = ?", (e["superseded_by"],))
        if not sup:
            continue                          # 悬空引用由 integrity 管,这里不越权
        s = sup[0]
        if s["source_id"] != e["source_id"] or s["relation"] != e["relation"]:
            continue                          # 不是「同槽顶替」,别乱救
        if s["target_id"] == e["target_id"]:
            continue                          # 同三元组:不可能(UNIQUE 挡着)
        restore_edges.append(e)

    mems = _rows(conn, """
        SELECT m.memory_id, m.user_id, m.memory_key, m.summary, m.layer,
               m.is_active, m.superseded_by, s.summary AS superseder_summary
          FROM episodic_memory m
          LEFT JOIN episodic_memory s ON s.memory_id = m.superseded_by
         WHERE m.is_active = 0 AND COALESCE(m.superseded_by, 0) <> 0
         ORDER BY m.memory_id""")
    restore_mems = []
    for m in mems:
        if not relations_mod.is_multi_value_memory_key(m["memory_key"]):
            continue
        if not m["superseder_summary"]:
            continue                          # 悬空引用:不碰
        if str(m["summary"] or "").strip() == str(m["superseder_summary"] or "").strip():
            continue                          # 同一句话:那是一次「想起」,不是并列
        restore_mems.append(m)

    kept, held = guard_repeats(conn, restore_mems, active_cover=active_cover,
                               sibling_cover=sibling_cover, enabled=repeat_guard)
    multi_targets = _rows(conn, """
        SELECT e.source_id, e.relation, sn.name AS source_name,
               COUNT(*) AS n_active,
               GROUP_CONCAT(tn.name, '、') AS targets
          FROM graph_edges e
          LEFT JOIN graph_nodes sn ON sn.node_id = e.source_id
          LEFT JOIN graph_nodes tn ON tn.node_id = e.target_id
         WHERE e.is_active = 1
         GROUP BY e.source_id, e.relation
        HAVING COUNT(*) > 1
         ORDER BY n_active DESC""")
    return {"restore_edges": restore_edges, "restore_memories": kept,
            "held_repeats": held,
            "single_value_supersessions": blocked_single, "multi_targets": multi_targets}


def cover_ratio(text, other):
    """本条的字符双字被对方覆盖的比例(0~1)。本条空文本 ⇒ 0(不判重复)。"""
    a, b = dedupe_mod.bigrams(text), dedupe_mod.bigrams(other)
    if not a:
        return 0.0
    return len(a & b) / len(a)


def guard_repeats(conn, restore_mems, *, active_cover=REPEAT_ACTIVE_COVER,
                  sibling_cover=REPEAT_SIBLING_COVER, enabled=True):
    """把「内容已经有人在说」的那些从唤回名单里按住。返回 `(留着, 按住+理由)`。

    理由逐条给(谁盖住它、盖了多少)—— 写进输出,他要能一眼复核,而不是信我一句话。
    """
    if not enabled:
        return list(restore_mems), []
    actives = _rows(conn, "SELECT memory_id, layer, summary FROM episodic_memory"
                          " WHERE is_active = 1")
    kept, held = [], []
    for m in restore_mems:
        why = None
        for a in actives:
            cov = cover_ratio(m["summary"], a["summary"])
            if cov >= float(active_cover):
                why = {"by": "active", "memory_id": a["memory_id"], "cover": round(cov, 3),
                       "note": "现役 #%s 已有近似表达" % a["memory_id"]}
                break
        if why is None:
            for o in restore_mems:
                if o is m or o["memory_id"] == m["memory_id"]:
                    continue
                cov = cover_ratio(m["summary"], o["summary"])
                if cov >= float(sibling_cover):
                    why = {"by": "sibling", "memory_id": o["memory_id"], "cover": round(cov, 3),
                           "note": "本次另一条 #%s 已包含它(留信息更全的)" % o["memory_id"]}
                    break
        if why is None:
            kept.append(m)
        else:
            held.append(dict(m, held_reason=why))
    return kept, held


def apply_restores(conn, plan, *, now=None):
    """真写:先回执后改行。返回写了几条。"""
    now = float(now or time.time())
    run_id = "a1-repair-%d" % int(now)
    n = 0
    for e in plan["restore_edges"]:
        payload = json.dumps({"was_superseded_by": e["superseded_by"],
                              "relation": e["relation"],
                              "source": e["source_name"], "target": e["target_name"]},
                             ensure_ascii=False)
        conn.execute(
            "INSERT INTO graph_edge_receipts (run_id, created_at, kind, source_kind,"
            " target_kind, source_id, target_id, action, reason, rule_id, note, payload)"
            " VALUES (?, ?, 'fact', 'node', 'node', ?, ?, 'restore', ?, ?, ?, ?)",
            (run_id, now, e["source_id"], e["target_id"], REASON, RULE,
             "A1 并列回补:多值关系下被同槽顶掉的边复位", payload))
        conn.execute("UPDATE graph_edges SET is_active = 1, superseded_by = 0"
                     " WHERE edge_id = ?", (e["edge_id"],))
        n += 1
    for m in plan["restore_memories"]:
        payload = json.dumps({"was_superseded_by": m["superseded_by"],
                              "memory_key": m["memory_key"], "layer": m["layer"],
                              "summary": m["summary"]}, ensure_ascii=False)
        conn.execute(
            "INSERT INTO graph_edge_receipts (run_id, created_at, kind, source_kind,"
            " target_kind, source_id, target_id, action, reason, rule_id, note,"
            " evidence_memory_id, payload)"
            " VALUES (?, ?, 'episodic', 'memory', 'memory', ?, ?, 'restore', ?, ?, ?, ?, ?)",
            (run_id, now, str(m["memory_id"]), str(m["superseded_by"]), REASON, RULE,
             "A1 并列回补:集合键下被同键顶掉的记忆复位(并列不是矛盾)",
             json.dumps([m["memory_id"]]), payload))
        conn.execute("UPDATE episodic_memory SET is_active = 1, superseded_by = 0"
                     " WHERE memory_id = ?", (m["memory_id"],))
        n += 1
    conn.commit()
    return {"restored_edges": len(plan["restore_edges"]),
            "restored_memories": len(plan["restore_memories"]),
            "receipts": n, "run_id": run_id}


def main(argv=None):
    ap = argparse.ArgumentParser(description="A1 并列回补(默认只演)")
    ap.add_argument("--db", default=None, help="库路径(默认 ~/.dsh/echo/echo.db)")
    ap.add_argument("--apply", action="store_true", help="真写(默认只演)")
    ap.add_argument("--json", action="store_true", help="结构化输出")
    ap.add_argument("--limit", type=int, default=0, help="清单最多打几条(0=全部)")
    ap.add_argument("--no-repeat-guard", dest="repeat_guard", action="store_false",
                    help="关掉「同题重复」守卫(= 形态 A1 全量:5 条记忆全回)")
    ap.add_argument("--active-cover", type=float, default=REPEAT_ACTIVE_COVER,
                    help="现役盖住多少就按住(默认 %.2f;调到 ~0.40 = 形态 C)" % REPEAT_ACTIVE_COVER)
    ap.add_argument("--sibling-cover", type=float, default=REPEAT_SIBLING_COVER,
                    help="本次另一条盖住多少就按住(默认 %.2f)" % REPEAT_SIBLING_COVER)
    args = ap.parse_args(argv)

    import os
    path = args.db or os.path.join(os.path.expanduser("~"), ".dsh", "echo", "echo.db")
    conn = db_mod.connect(path)
    try:
        plan = collect(conn, repeat_guard=bool(args.repeat_guard),
                       active_cover=args.active_cover, sibling_cover=args.sibling_cover)
        out = {"db": path, "apply": bool(args.apply),
               "restore_edges": len(plan["restore_edges"]),
               "restore_memories": len(plan["restore_memories"]),
               "restore_memories_held": len(plan.get("held_repeats") or []),
               "repeat_guard": {"on": bool(args.repeat_guard),
                                "active_cover": args.active_cover,
                                "sibling_cover": args.sibling_cover},
               "held": plan.get("held_repeats") or [],
               "single_value_supersessions": len(plan["single_value_supersessions"]),
               "multi_targets": len(plan["multi_targets"]),
               "edges": plan["restore_edges"], "memories": plan["restore_memories"],
               "observation_multi_targets": plan["multi_targets"]}
        if args.apply:
            out["written"] = apply_restores(conn, plan)
        if args.json:
            print(json.dumps(out, ensure_ascii=False, indent=2))
            return 0
        lim = args.limit or 10 ** 9
        print("== A1 并列回补清单(%s)==" % ("真写" if args.apply else "只演"))
        print("库   %s" % path)
        print("可复活边   %d 条" % out["restore_edges"])
        for e in plan["restore_edges"][:lim]:
            print("  #%d  %s -[%s]-> %s   (被 #%s(%s -[%s]-> %s) 顶掉)"
                  % (e["edge_id"], e["source_name"], e["relation"], e["target_name"],
                     e["superseded_by"], e["superseder_source_name"], e["relation"],
                     e["superseder_target_name"]))
        print("可复活记忆 %d 条" % out["restore_memories"])
        for m in plan["restore_memories"][:lim]:
            print("  #%d  [%s] %s" % (m["memory_id"], m["memory_key"], m["summary"]))
        held = plan.get("held_repeats") or []
        print("同题重复守卫 %s:按住 %d 条(双字覆盖 现役≥%.2f / 同伴≥%.2f)"
              % ("开" if args.repeat_guard else "**关**(形态 A1 全量)",
                 len(held), args.active_cover, args.sibling_cover))
        for h in held[:lim]:
            r = h["held_reason"]
            print("  #%d 按住 | %s 盖 %.3f | %s"
                  % (h["memory_id"], r["note"], r["cover"], (h["summary"] or "")[:34]))
        print("单值换代(正常,不动) %d 条" % out["single_value_supersessions"])
        print("观察项:单值关系下多个活跃目标 %d 组(默认不碰,要收由他裁定)"
              % out["multi_targets"])
        for g in plan["multi_targets"][:lim]:
            print("  %s -[%s]-> %s" % (g["source_name"], g["relation"], g["targets"]))
        if args.apply:
            print("已写:%s" % json.dumps(out["written"], ensure_ascii=False))
        else:
            print("下一步:核对无误后加 --apply(它会逐条留回执再改行)")
        return 0
    finally:
        try:
            conn.close()
        except Exception:
            pass


if __name__ == "__main__":
    sys.exit(main())
