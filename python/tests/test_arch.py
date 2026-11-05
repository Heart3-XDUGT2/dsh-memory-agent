# -*- coding: utf-8 -*-
"""A7a:运维读口聚合 + 一键回退 —— 四条不变量。

1. **一格一个口径**:面板要的每样东西都在 `status()` 里一次算完;每格都带"算法产物 / 事实"的
   标注(验收③),面板不需要自己判断哪格能退。
2. **回退入口齐**:`status()["rollback"]` 覆盖 `ROLLBACK_ROUTES` 的每一条;能退的都给出
   会动几行 + 那句 SQL(验收①)。
3. **回退有据**:`rollback(apply=True)` 只动它说的那几行,并**写一条回执**(谁退的/退了多少);
   再退一次会明确 `refused`(不是静默 0 行)。
4. **shadow-table 没有回退这个动作**:它已冻结 ⇒ 必须明确拒绝,不许假装成功。
"""

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from engine import arch, cooc as cooc_mod, db, graph_gate as gate_mod, topics  # noqa: E402

REPO = Path(__file__).resolve().parents[2]
NAMES = {"a1": "KARDS", "a2": "德美跳", "a3": "战地1", "a4": "舞萌",
         "s1": "西安电子科技大学", "s2": "大一学生", "s3": "校园跑", "hub": "用户"}
FACTS = (("a1", "a2"), ("a2", "a3"), ("a3", "a4"), ("s1", "s2"), ("s2", "s3"))


def fresh_conn():
    tmp = tempfile.TemporaryDirectory()
    conn = db.connect(os.path.join(tmp.name, "echo.db"))
    return tmp, conn


def seed(conn):
    for nid, name in sorted(NAMES.items()):
        conn.execute("INSERT INTO graph_nodes (node_id, name) VALUES (?, ?)", (nid, name))
    for s, t in FACTS:
        conn.execute(
            "INSERT INTO graph_edges (source_id, target_id, relation, owner_key, weight,"
            " is_active, kind, evidence) VALUES (?, ?, '关联', 'master', 1.0, 1, '', '1、2')",
            (s, t))
    for mid, ids, pairs in ((1, "a1、a2、a3", "a1|a2,a1|a3,a2|a3"),
                            (2, "a3、a4", "a3|a4"),
                            (3, "s1、s2、s3", "s1|s2,s1|s3,s2|s3")):
        conn.execute(
            "INSERT INTO graph_cooc_evidence (owner_key, scope_kind, memory_id, day_key,"
            " node_ids, pairs, node_count, pair_count, weight, source_kind, created_at)"
            " VALUES ('__cooc__', 'same_memory', ?, '', ?, ?, ?, ?, 1.0, 'test', 111.0)",
            (mid, ids, pairs, len(ids.split("、")), len(pairs.split(","))))
    conn.commit()


class Status(unittest.TestCase):
    def setUp(self):
        self.tmp, self.conn = fresh_conn()
        self.addCleanup(self.tmp.cleanup)
        self.addCleanup(self.conn.close)
        seed(self.conn)

    def test_empty_view_is_reported_as_empty_not_as_error(self):
        st = arch.status(self.conn)
        self.assertEqual(st["topics"]["clusters"], [])
        self.assertEqual(st["topics"]["summaries"], 0)
        self.assertEqual(st["evidence"]["rows"], 3)
        self.assertEqual(st["graph"]["nodes"], 8)
        self.assertTrue(any("现行批次为空" in n or "还没建" in n for n in st["notes"]), st["notes"])

    def test_nature_marks_algorithm_vs_fact(self):
        st = arch.status(self.conn)
        self.assertIn("算法产物", st["nature"]["topics"])
        self.assertIn("事实", st["nature"]["graph"])
        self.assertIn("冻结", st["nature"]["shadow"])
        # 2026-10-02:凭据债是"给人看的账" —— 标注里必须写清它不进她的上下文
        self.assertIn("只给人看", st["nature"]["debt"])
        self.assertIn("不进她的上下文", st["nature"]["debt"])

    def test_debt_row_matches_the_debt_report(self):
        """面板上那一行必须与 `evidence_debt` 报表**同源**(面板不是第二个判定处)。"""
        from engine import evidence_debt  # noqa: E402
        # 夹具里那些边都带 `1、2`(真编号)⇒ 现在零债;再插一条空依据的,债就该现形
        self.conn.execute(
            "INSERT INTO graph_edges (source_id, target_id, relation, owner_key, weight,"
            " is_active, kind, evidence) VALUES ('s3', 'a4', '没依据的说法', 'master', 1.0, 1, '', '')")
        self.conn.commit()
        st = arch.status(self.conn)
        want = evidence_debt.survey(self.conn, arch.GRAPH_OWNER)
        d = st["debt"]
        self.assertTrue(d["present"])
        self.assertEqual(d["active"], want["active"], "面板的账与报表的账不是一个口径")
        self.assertEqual(d["weak_total"], 1)
        self.assertEqual([w["edge_id"] for w in d["weak"]], [want["weak_active"][0]["edge_id"]])
        self.assertEqual(d["nonfact_kind_rows"], 0)
        self.assertTrue(any("凭据债" in n for n in st["notes"]), st["notes"])

    def test_clusters_carry_algorithm_tag_and_staleness(self):
        topics.apply_plan(self.conn, topics.compute(self.conn), now=1000.0)
        st = arch.status(self.conn)
        self.assertEqual(len(st["topics"]["clusters"]), 2)
        for c in st["topics"]["clusters"]:
            self.assertEqual(c["nature"], "algorithm")
            self.assertIn("greedy-modularity", c["algorithm"])
            self.assertGreaterEqual(c["stale_days"], 0.0)

    def test_every_route_has_a_rollback_entry(self):
        st = arch.status(self.conn)
        self.assertEqual([r["route"] for r in st["rollback"]],
                         [r["route"] for r in arch.ROLLBACK_ROUTES])
        for r in st["rollback"]:
            self.assertIn("how", r)
            if r["available"]:
                self.assertTrue(r["sql"], "能退却没给 SQL:%s" % r)

    def test_receipts_tail_is_readable(self):
        gate_mod.write_receipts(self.conn, [{"kind": "cooc", "source_id": "a1",
                                             "target_id": "a2", "action": "accept",
                                             "reason": "r1", "ts": 5.0}],
                               run_id="run-x", route="cooc-evidence")
        st = arch.status(self.conn)
        self.assertGreaterEqual(st["receipts"]["total"], 1)
        self.assertEqual(st["receipts"]["recent"][0]["route"], "cooc-evidence")
        self.assertEqual(st["receipts"]["recent"][0]["run_id"], "run-x")


class Rollback(unittest.TestCase):
    def setUp(self):
        self.tmp, self.conn = fresh_conn()
        self.addCleanup(self.tmp.cleanup)
        self.addCleanup(self.conn.close)
        seed(self.conn)
        topics.apply_plan(self.conn, topics.compute(self.conn), now=1000.0)

    def _dump(self, tables):
        return {t: [tuple(str(c) for c in r) for r in self.conn.execute(
            "SELECT * FROM " + t + " ORDER BY 1")] for t in tables}

    def test_dry_run_touches_nothing(self):
        tables = (cooc_mod.EVIDENCE_TABLE, topics.CLUSTER_TABLE, topics.MEMBER_TABLE,
                  "graph_edges", gate_mod.RECEIPTS_TABLE)
        before = self._dump(tables)
        for route in ("cooc-evidence", "topic-view", "shadow-table"):
            res = arch.rollback(self.conn, route, apply=False)
            self.assertFalse(res["applied"])
            self.assertTrue(res["dry_run"])
        self.assertEqual(self._dump(tables), before)

    def test_cooc_rollback_lands_exactly_the_latest_batch(self):
        res = arch.rollback(self.conn, "cooc-evidence", apply=True, now=2000.0)
        self.assertTrue(res["applied"])
        self.assertEqual(res["rows"], 3)
        self.assertEqual(res["receipts"], 1, "回退自己也得留一条回执")
        left = self.conn.execute("SELECT COUNT(*) FROM " + cooc_mod.EVIDENCE_TABLE).fetchone()[0]
        self.assertEqual(int(left), 0)
        again = arch.rollback(self.conn, "cooc-evidence", apply=True, now=2001.0)
        self.assertFalse(again["applied"])
        self.assertIn("没有行可退", again["refused"])

    def test_topic_rollback_deactivates_but_keeps_rows(self):
        res = arch.rollback(self.conn, "topic-view", apply=True, now=2000.0)
        self.assertTrue(res["applied"])
        self.assertEqual(res["rows"], 2)
        rows = list(self.conn.execute("SELECT cluster_id, is_active FROM " +
                                      topics.CLUSTER_TABLE + " ORDER BY cluster_id"))
        self.assertEqual(len(rows), 2, "回退不许删行(审计还在)")
        self.assertEqual([int(r[1]) for r in rows], [0, 0])
        self.assertEqual(arch.status(self.conn)["topics"]["clusters"], [])

    def test_shadow_table_refuses_loudly(self):
        res = arch.rollback(self.conn, "shadow-table", apply=True)
        self.assertFalse(res["applied"])
        self.assertIn("没有这个回退动作", res["refused"])
        unknown = arch.rollback(self.conn, "不认识的路线", apply=True)
        self.assertFalse(unknown["applied"])

    def test_rollback_only_touches_its_own_rows(self):
        watched = ("graph_edges", "graph_nodes", "graph_shadow_edges", "audit_logs",
                   "episodic_memory")
        before = self._dump(watched)
        arch.rollback(self.conn, "topic-view", apply=True, now=2000.0)
        self.assertEqual(self._dump(watched), before)

    def test_deactivate_is_idempotent(self):
        first = topics.deactivate(self.conn, now=3000.0)
        second = topics.deactivate(self.conn, now=3001.0)
        self.assertEqual(first["deactivated"], 2)
        self.assertEqual(second["deactivated"], 0)


class PanelIsNotASecondDecider(unittest.TestCase):
    """面板只显示:判定口径只出现在引擎里(这里只钉"聚合器不自己算结论")。"""

    def test_arch_module_has_no_algorithm_of_its_own(self):
        text = (REPO / "python" / "engine" / "arch.py").read_text(encoding="utf-8")
        for forbidden in ("greedy", "modularity", "label_propagat", "def compute("):
            self.assertNotIn(forbidden, text, "arch.py 里出现了算法实现:%s" % forbidden)

    def test_arch_reads_only_via_the_layer_modules(self):
        text = (REPO / "python" / "engine" / "arch.py").read_text(encoding="utf-8")
        for mod in ("topics", "cooc", "graph_gate"):
            self.assertIn("from . import %s" % mod, text)
        self.assertIn("ROLLBACK_ROUTES", text)

    def test_arch_never_enters_the_prompt_path(self):
        """运维读口**不进** load()/render_paths()/检索/worker —— 它只在面板那边被调。"""
        for rel in ("python/engine/retrieve.py", "python/engine/graph.py", "python/worker.py",
                    "python/engine/ppr.py"):
            text = (REPO / rel).read_text(encoding="utf-8")
            for bad in ("engine.arch", "from . import arch", "import arch"):
                self.assertNotIn(bad, text, "%s 里出现了 %s(运维读口被接进在线路径了)" % (rel, bad))


if __name__ == "__main__":
    unittest.main()
