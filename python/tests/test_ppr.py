# -*- coding: utf-8 -*-
"""A6:只读 PPR + 时间邻近缓冲 —— 五条不变量。

1. **质量守恒**:转移矩阵每行和 = 1;`run_ppr` 的总质量 = 1(±1e-6)。
   (2026-10-01 第一版就在这儿栽过:字典推导的自由变量让每行所有值相等 —— 见 `_transition`。)
2. **确定性**:同输入两次跑,分数逐位一致。
3. **同域联想**:种子 KARDS ⇒ 德美跳/战地1 排在前面,而且**路径可解释**(经记忆行)。
4. **hub 降权真的发生**:`用户` 这种高度节点的质量占比在 `hub_beta>0` 时**明显下降**。
5. **只读**:跑完一个字节都不写;时间邻近只出候选(不落边);本模块不进检索侧文件。
"""

import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from engine import db, graph, ppr  # noqa: E402

REPO = Path(__file__).resolve().parents[2]

NAMES = {"a1": "KARDS", "a2": "德美跳", "a3": "战地1", "a4": "舞萌",
         "hub": "用户", "s1": "西安电子科技大学", "s2": "校园跑"}
FACTS = (("a1", "a2", 2.0), ("a2", "a3", 1.0), ("a4", "a1", 0.4))
#: hub 连到几乎所有东西(度大)—— 它就是 PPR 的黑洞来源。
HUB_EDGES = (("hub", "a1", 1.0), ("hub", "a2", 1.0), ("hub", "a3", 1.0),
             ("hub", "a4", 1.0), ("hub", "s1", 1.0), ("hub", "s2", 1.0))


def fresh_conn():
    tmp = tempfile.TemporaryDirectory()
    conn = db.connect(os.path.join(tmp.name, "echo.db"))
    return tmp, conn


def seed(conn):
    for nid, name in sorted(NAMES.items()):
        conn.execute("INSERT INTO graph_nodes (node_id, name) VALUES (?, ?)", (nid, name))
    for s, t, w in FACTS + HUB_EDGES:
        conn.execute(
            "INSERT INTO graph_edges (source_id, target_id, relation, owner_key, weight,"
            " is_active, kind, evidence) VALUES (?, ?, '关联', 'master', ?, 1, '', ?)",
            (s, t, float(w), "314、317"))
    # 两条记忆:一条把 KARDS/德美跳/战地1 串起来(经证据层),一条是时间邻近用的邻居
    conn.execute(
        "INSERT INTO graph_cooc_evidence (owner_key, scope_kind, memory_id, day_key, node_ids,"
        " pairs, node_count, pair_count, weight, source_kind, created_at)"
        " VALUES ('__cooc__', 'same_memory', 317, '', 'a1、a2、a3', 'a1|a2,a1|a3', 3, 2,"
        " 1.0, 'test', 0)")
    for mid, summary, ts in ((314, "KARDS 德美跳费卡组", 1790265600.0),
                             (315, "同一天聊的别的事", 1790265900.0),
                             (400, "隔了很久的事", 1790500000.0)):
        conn.execute(
            "INSERT INTO episodic_memory (memory_id, summary, keywords, timestamp,"
            " occurred_at, is_active) VALUES (?, ?, '', ?, ?, 1)",
            (mid, summary, ts, ts))
    conn.commit()


class MassAndDeterminism(unittest.TestCase):
    def setUp(self):
        self.tmp, self.conn = fresh_conn()
        self.addCleanup(self.tmp.cleanup)
        self.addCleanup(self.conn.close)
        seed(self.conn)
        self.g = ppr.build_graph(self.conn)
        self.deg = {u: sum(float(w) for w in self.g["adj"][u].values()) for u in self.g["adj"]}

    def test_transition_rows_are_stochastic(self):
        for beta in (0.0, 0.5, 1.0):
            T = ppr._transition(self.g["adj"], self.deg, beta)
            for u, row in T.items():
                self.assertAlmostEqual(sum(row.values()), 1.0, places=9,
                                       msg="beta=%s 的 %s 行和不是 1" % (beta, u))

    def test_total_mass_is_one(self):
        run = ppr.run_ppr(self.g, ["a1"])
        self.assertAlmostEqual(sum(run["scores"].values()), 1.0, places=6,
                               msg="PPR 不是分布了(质量不守恒)")
        self.assertAlmostEqual(run["mass"], 1.0, places=6)

    def test_two_runs_are_bit_identical(self):
        a = ppr.run_ppr(self.g, ["a1"])
        b = ppr.run_ppr(self.g, ["a1"])
        self.assertEqual(a["scores"], b["scores"])
        self.assertEqual(a["predecessor"], b["predecessor"])

    def test_no_seed_is_an_empty_run(self):
        run = ppr.run_ppr(self.g, ["不存在的节点"])
        self.assertEqual(run["scores"], {})
        self.assertEqual(run["iters"], 0)


class Association(unittest.TestCase):
    def setUp(self):
        self.tmp, self.conn = fresh_conn()
        self.addCleanup(self.tmp.cleanup)
        self.addCleanup(self.conn.close)
        seed(self.conn)

    def test_seed_finds_the_same_domain_and_explains_the_path(self):
        rep = ppr.report(self.conn, seeds=["KARDS"], top=6)
        names = [r["name"] for r in rep["ranking"]]
        self.assertIn("德美跳", names, str(names))
        self.assertLess(names.index("德美跳"), names.index("西安电子科技大学"),
                        "同域的不该排在无关的后面")
        self.assertTrue(rep["paths"], "没有可解释路径")
        labels = " → ".join(rep["paths"][0]["labels"])
        self.assertIn("KARDS", labels)
        self.assertTrue(any("记忆#" in x for p in rep["paths"] for x in p["labels"]),
                        "路径该经过记忆行(HippoRAG 的同图口径)")

    def test_hub_penalty_lowers_the_hub_share(self):
        rep = ppr.report(self.conn, seeds=["KARDS"], top=8)
        hub = [h for h in rep["hub"] if h["node"] == "用户"][0]
        self.assertLess(hub["share_with_penalty"], hub["share_plain"] * 0.9,
                        "hub 降权没生效:%s" % hub)

    def test_temporal_buffer_is_candidates_only(self):
        rep = ppr.report(self.conn, seeds=["KARDS"], top=6)
        self.assertTrue(rep["temporal"], "同一批记忆的时间邻居没被找出来")
        for c in rep["temporal"]:
            self.assertTrue(c["candidates_only"])
            self.assertIn(c["why"], ("same-day", "nearby"))
        # 而图里**没有**任何"记忆↔记忆"的边(缓冲不落边)
        kinds = ppr.build_graph(self.conn)["kinds"]
        for u, row in ppr.build_graph(self.conn)["adj"].items():
            if str(u).startswith(ppr.MEM_PREFIX):
                for v in row:
                    self.assertFalse(str(v).startswith(ppr.MEM_PREFIX),
                                     "时间邻近缓冲落成了记忆↔记忆的边:%s-%s" % (u, v))
        self.assertTrue(kinds)

    def test_report_writes_nothing(self):
        watched = ("graph_edges", "graph_nodes", "graph_cooc_evidence", "graph_shadow_edges",
                   "episodic_memory", "graph_edge_receipts", "audit_logs")
        before = {t: [tuple(str(c) for c in r) for r in self.conn.execute(
            "SELECT * FROM " + t + " ORDER BY 1")] for t in watched}
        ppr.report(self.conn, query="KARDS 那个卡组怎么搭", top=6)
        for t, rows in before.items():
            self.assertEqual([tuple(str(c) for c in r) for r in self.conn.execute(
                "SELECT * FROM " + t + " ORDER BY 1")], rows, t + " 被 PPR 动了")

    def test_load_output_is_unchanged(self):
        """验收③:本阶段不接 prompt ⇒ `graph.load()` 的输出一个字都不该变。"""
        before = graph.load(self.conn, "master")
        ppr.report(self.conn, query="KARDS 德美跳", top=6)
        after = graph.load(self.conn, "master")
        self.assertEqual(before, after)


class ReadSideQuarantine(unittest.TestCase):
    def test_retrieval_files_never_mention_ppr(self):
        for rel in ppr.READ_SIDE_FILES:
            text = (REPO / rel).read_text(encoding="utf-8")
            for name in ppr.FORBIDDEN_NAMES:
                self.assertNotIn(name, text, "%s 里出现了 %s(PPR 被接进在线路径了?)"
                                 % (rel, name))

    def test_guard_is_not_vacuous(self):
        """守卫不会永远全绿:名字确实写在**该写的地方**(模块 / 计划书 / 报表脚本)。"""
        self.assertIn("ppr.py", (REPO / "docs" / "PLAN_MEMORY_ARCH_V2.md").read_text(
            encoding="utf-8"))
        self.assertTrue((REPO / "python" / "engine" / "ppr.py").exists())
        for rel in ppr.READ_SIDE_FILES:
            self.assertTrue((REPO / rel).exists(), rel + " 不存在 —— 名单写错了")


if __name__ == "__main__":
    unittest.main()
