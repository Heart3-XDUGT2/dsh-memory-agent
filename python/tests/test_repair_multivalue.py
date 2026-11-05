# -*- coding: utf-8 -*-
"""A1 的「同题重复」守卫(形态 E,2026-10-02 他选定)—— 四条不变量。

1. **守卫只看机械判据**:双字覆盖比(现役 ≥ 0.60 / 同伴 ≥ 0.85);理由逐条给(谁盖的、盖多少)。
2. **守卫只按住"同题重复",不碰真·多值**:不同题的两条一律留下。
3. **关掉守卫 = 形态 A1 全量**(5 条记忆全回);**把阈值调松 ≈ 形态 C**(再多按住一条)。
4. **写库只写留下的那些**:回执数 = 边数 + 留下的记忆数;被按住的仍 `is_active=0` 且
   `superseded_by` 原样 —— 没写回执,就没写库。
"""

import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from engine import db, repair_multivalue as rm  # noqa: E402

#: 夹具照实况(2026-10-02 链前副本):三条同题章鱼 + 两条真·多值;
#: 现役 #169 是"用户喜欢吃章鱼小丸子。"(reflection 层)。
MEM = [
    # (memory_id, layer, key, summary, is_active, superseded_by)
    (169, "reflection", "preferred_food", "用户喜欢吃章鱼小丸子。", 1, 0),
    # 现役 #99:与 #126 讲同一段"章鱼小丸子稀有/几年一次/打算学做"(只是主语不同)⇒ 覆盖 0.56
    (99, "reflection", "preferred_food",
     "用户说章鱼小丸子很稀有、几乎几年才吃一次，并打算以后学做。", 1, 0),
    (126, "L0", "preferred_food",
     "阿岚最喜欢吃章鱼小丸子；他说它很稀有、几乎几年才吃一次，打算以后学会自己做。", 0, 127),
    (127, "L0", "preferred_food", "用户明确表示喜欢吃章鱼小丸子", 0, 169),
    (128, "L0", "preferred_food", "阿岚喜欢吃章鱼小丸子", 0, 169),
    (291, "L0", "longTermInterests", "用户自称是舞萌的三年老玩家,长期在玩这款音游。", 0, 313),
    (313, "L0", "longTermInterests", "用户主动说自己喜欢玩KARDS这款二战题材的卡牌游戏。", 0, 315),
    # 顶掉 #313 的那条(现役),与 #313 是两件事 —— 守卫不许把它算成"同题"
    (315, "L0", "longTermInterests", "阿岚表示自己也喜欢玩战地1", 1, 0),
]
#: 边:一条被同槽顶掉的多值边(#3 章鱼小丸子 vs #41 老乡鸡)+ 一条单值换代(不该动)
EDGES = [
    (3, "用户", "喜欢", "章鱼小丸子", 0, 41),
    (41, "用户", "喜欢", "老乡鸡的梅菜扣肉", 1, 0),
    (9, "用户", "就读于", "新工科大学", 0, 17),      # 单值:正常换代,不动
    (17, "用户", "就读于", "西安电子科技大学", 1, 0),
]
NODES = {"用户": 1, "章鱼小丸子": 2, "老乡鸡的梅菜扣肉": 3, "新工科大学": 4,
         "西安电子科技大学": 5}


def fresh(seed=True):
    tmp = tempfile.TemporaryDirectory()
    conn = db.connect(os.path.join(tmp.name, "echo.db"))
    if seed:
        for name, nid in NODES.items():
            conn.execute("INSERT INTO graph_nodes (node_id, name, owner_key, is_active)"
                         " VALUES (?, ?, 'master', 1)", (nid, name))
        for eid, s, rel, t, act, sup in EDGES:
            conn.execute("INSERT INTO graph_edges (edge_id, source_id, target_id, relation,"
                         " owner_key, weight, is_active, kind, evidence, superseded_by)"
                         " VALUES (?, ?, ?, ?, 'master', 1.0, ?, '', '1、2', ?)",
                         (eid, NODES[s], NODES[t], rel, act, sup))
        for mid, layer, key, summary, act, sup in MEM:
            conn.execute("INSERT INTO episodic_memory (memory_id, user_id, memory_key, layer,"
                         " summary, is_active, superseded_by, occurred_at, learned_at)"
                         " VALUES (?, 'master', ?, ?, ?, ?, ?, 1, 1)",
                         (mid, key, layer, summary, act, sup))
        conn.commit()
    return tmp, conn


class GuardJudges(unittest.TestCase):
    def test_holds_exactly_the_repeats_and_gives_reasons(self):
        tmp, conn = fresh()
        self.addCleanup(tmp.cleanup)
        self.addCleanup(conn.close)
        plan = rm.collect(conn)
        kept = sorted(m["memory_id"] for m in plan["restore_memories"])
        held = sorted(h["memory_id"] for h in plan["held_repeats"])
        self.assertEqual(kept, [126, 291, 313], "留下的该是「阿岚侧最全的那条」+ 两条真·多值")
        self.assertEqual(held, [127, 128], "该按住的两条同题重复没按住")
        for h in plan["held_repeats"]:
            r = h["held_reason"]
            self.assertIn(r["by"], ("active", "sibling"))
            self.assertGreaterEqual(r["cover"], 0.6)
            self.assertIn("盖", r["note"] + "盖")

    def test_sibling_containment_keeps_the_richer_one(self):
        tmp, conn = fresh()
        self.addCleanup(tmp.cleanup)
        self.addCleanup(conn.close)
        plan = rm.collect(conn)
        by_id = {h["memory_id"]: h for h in plan["held_repeats"]}
        self.assertIn(128, by_id, "#128(短的那条)没被 #126 包含住")
        self.assertIn(126, [m["memory_id"] for m in plan["restore_memories"]],
                      "#126 是信息最全的那条,不该被按住")

    def test_distinct_facts_are_never_held(self):
        tmp, conn = fresh()
        self.addCleanup(tmp.cleanup)
        self.addCleanup(conn.close)
        kept = {m["memory_id"] for m in rm.collect(conn)["restore_memories"]}
        self.assertIn(291, kept, "舞萌那条与谁都不重复,却被按住了")
        self.assertIn(313, kept, "KARDS 那条与谁都不重复,却被按住了")

    def test_cover_ratio_is_mechanical(self):
        self.assertAlmostEqual(rm.cover_ratio("阿岚喜欢吃章鱼小丸子",
                                              "阿岚最喜欢吃章鱼小丸子；稀有…"), 0.89, places=1)
        self.assertLess(rm.cover_ratio("用户自称是舞萌的三年老玩家",
                                       "用户喜欢吃章鱼小丸子。"), 0.2)
        self.assertEqual(rm.cover_ratio("", "随便"), 0.0)

    def test_edges_are_never_held_by_the_guard(self):
        tmp, conn = fresh()
        self.addCleanup(tmp.cleanup)
        self.addCleanup(conn.close)
        plan = rm.collect(conn)
        self.assertEqual([e["edge_id"] for e in plan["restore_edges"]], [3],
                         "多值边该照回;单值换代的不许动")
        self.assertEqual([e["edge_id"] for e in plan["single_value_supersessions"]], [9])

    def test_guard_off_is_full_form(self):
        tmp, conn = fresh()
        self.addCleanup(tmp.cleanup)
        self.addCleanup(conn.close)
        plan = rm.collect(conn, repeat_guard=False)
        self.assertEqual(sorted(m["memory_id"] for m in plan["restore_memories"]),
                         [126, 127, 128, 291, 313], "关掉守卫就该是形态 A1 全量")
        self.assertEqual(plan["held_repeats"], [], "关掉守卫却还按住东西")

    def test_looser_threshold_is_form_c(self):
        tmp, conn = fresh()
        self.addCleanup(tmp.cleanup)
        self.addCleanup(conn.close)
        plan = rm.collect(conn, active_cover=0.40)
        kept = sorted(m["memory_id"] for m in plan["restore_memories"])
        self.assertEqual(kept, [291, 313], "阈值调松后该只剩两条真·多值(形态 C)")
        self.assertEqual(sorted(h["memory_id"] for h in plan["held_repeats"]), [126, 127, 128])


class WritesOnlyWhatsKept(unittest.TestCase):
    def test_receipts_equal_edges_plus_kept_memories(self):
        tmp, conn = fresh()
        self.addCleanup(tmp.cleanup)
        self.addCleanup(conn.close)
        plan = rm.collect(conn)
        n_kept = len(plan["restore_memories"])
        out = rm.apply_restores(conn, plan)
        self.assertEqual(out["receipts"], len(plan["restore_edges"]) + n_kept)
        rows = conn.execute("SELECT COUNT(*) FROM graph_edge_receipts").fetchone()[0]
        self.assertEqual(rows, out["receipts"])
        # 被按住的:一行都没动(还是退役 + 原 superseded_by)
        for mid, sup in ((127, 169), (128, 169)):
            r = conn.execute("SELECT is_active, superseded_by FROM episodic_memory"
                             " WHERE memory_id = ?", (mid,)).fetchone()
            self.assertEqual((int(r[0]), int(r[1])), (0, sup), "#%d 被写动了" % mid)
        # 留下的:真的活了
        for mid in (126, 291, 313):
            r = conn.execute("SELECT is_active, superseded_by FROM episodic_memory"
                             " WHERE memory_id = ?", (mid,)).fetchone()
            self.assertEqual((int(r[0]), int(r[1])), (1, 0), "#%d 没被唤回" % mid)

    def test_second_run_is_idempotent(self):
        tmp, conn = fresh()
        self.addCleanup(tmp.cleanup)
        self.addCleanup(conn.close)
        rm.apply_restores(conn, rm.collect(conn))
        again = rm.collect(conn)
        self.assertEqual(again["restore_edges"], [], "第二次还有可唤回的边?")
        self.assertEqual([m["memory_id"] for m in again["restore_memories"]], [],
                         "第二次还有可唤回的记忆?")


class ReportTellsTheTruth(unittest.TestCase):
    def test_cli_json_has_guard_block_and_held_list(self):
        import io
        import json
        from contextlib import redirect_stdout
        tmp, conn = fresh()
        self.addCleanup(tmp.cleanup)
        self.addCleanup(conn.close)
        path = conn.execute("PRAGMA database_list").fetchone()[2]
        conn.close()
        buf = io.StringIO()
        with redirect_stdout(buf):
            rm.main(["--db", path, "--json"])
        out = json.loads(buf.getvalue())
        self.assertIn("repeat_guard", out)
        self.assertTrue(out["repeat_guard"]["on"], "守卫该默认开着")
        self.assertEqual(out["restore_memories_held"], 2)
        self.assertEqual(sorted(h["memory_id"] for h in out["held"]), [127, 128])


if __name__ == "__main__":
    unittest.main()
