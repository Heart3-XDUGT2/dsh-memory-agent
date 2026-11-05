# -*- coding: utf-8 -*-
"""A5:主题簇**视图** —— 四条不变量。

1. **只是视图**:两张新表是纯增的;算的时候一个字节都不写;落库只写这两张表
   (`graph_edges` / 证据层 / 影子表 / 回执逐位不动)。
2. **确定性 / 可重算**:同参数两次 `compute()` 成员集合逐位一致;整批换代幂等
   (旧批 `is_active=0`,新批写入,成员集合不变)。
3. **软归属(B)**:一个概念可以同时属两簇 —— 本体的那个 `is_primary=1`,
   另一个是软归属且带强度。
4. **不进检索**:检索/渲染侧文件里不许出现两张表的名字(进 prompt 要单独裁决),
   而且这条 grep 守卫必须"能亮"。
"""

import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from engine import db, topics  # noqa: E402

REPO = Path(__file__).resolve().parents[2]

#: 夹具:游戏组(g1..g4)+ 学校组(s1..s3)+ 桥(b1)+ 孤对(z1,z2)。
NAMES = {"g1": "KARDS", "g2": "德美跳", "g3": "战地1", "g4": "舞萌",
         "s1": "西安电子科技大学", "s2": "大一学生", "s3": "校园跑",
         "b1": "他", "z1": "碎节点甲", "z2": "碎节点乙"}
EVIDENCE = (   # (memory_id, node_ids, pairs)
    (1, "g1、g2、g3、g4", "g1|g2,g1|g3,g2|g3,g3|g4"),
    (2, "s1、s2、s3", "s1|s2,s1|s3,s2|s3"),
    (3, "b1、g1", "b1|g1"),
    (4, "b1、s1", "b1|s1"),
    (5, "z1、z2", "z1|z2"),
)


def fresh_conn():
    tmp = tempfile.TemporaryDirectory()
    conn = db.connect(os.path.join(tmp.name, "echo.db"))
    return tmp, conn


def seed(conn):
    for nid, name in sorted(NAMES.items()):
        conn.execute("INSERT INTO graph_nodes (node_id, name) VALUES (?, ?)", (nid, name))
    for mid, ids, pairs in EVIDENCE:
        conn.execute(
            "INSERT INTO graph_cooc_evidence (owner_key, scope_kind, memory_id, day_key,"
            " node_ids, pairs, node_count, pair_count, weight, source_kind, created_at)"
            " VALUES ('__cooc__', 'same_memory', ?, '', ?, ?, ?, ?, 1.0, 'test', 0)",
            (int(mid), ids, pairs, len(ids.split(topics.SEP)), len(pairs.split(","))))
    conn.commit()


def member_map(conn):
    """`(簇 label, member_id) -> (weight, is_primary)`(跨批次可比:不用 cluster_id)。"""
    out = {}
    for label, mid, weight, prim in conn.execute(
            "SELECT c.label, m.member_id, m.weight, m.is_primary FROM " + topics.MEMBER_TABLE
            + " m JOIN " + topics.CLUSTER_TABLE + " c ON c.cluster_id = m.cluster_id"
            " WHERE COALESCE(c.is_active, 1) = 1"):
        out[(str(label), str(mid))] = (round(float(weight), 6), int(prim))
    return out


class TopicViewShape(unittest.TestCase):
    def setUp(self):
        self.tmp, self.conn = fresh_conn()
        self.addCleanup(self.tmp.cleanup)
        self.addCleanup(self.conn.close)

    def test_tables_are_pure_additions(self):
        names = {str(r[0]) for r in self.conn.execute(
            "SELECT name FROM sqlite_master WHERE type = 'table'")}
        self.assertIn(topics.CLUSTER_TABLE, names)
        self.assertIn(topics.MEMBER_TABLE, names)
        # 引擎专属(JS 侧不必声明;DDL parity 允许引擎多表)
        store = (REPO / "lib" / "store.js").read_text(encoding="utf-8")
        self.assertNotIn(topics.CLUSTER_TABLE, store)

    def test_reconnect_is_idempotent(self):
        path = self.conn.execute("PRAGMA database_list").fetchone()[2]
        self.conn.close()
        again = db.connect(path)
        self.addCleanup(again.close)
        self.assertEqual(int(again.execute(
            "SELECT COUNT(*) FROM " + topics.CLUSTER_TABLE).fetchone()[0]), 0)

    def test_compute_writes_nothing(self):
        seed(self.conn)
        before = {t: self._dump(t) for t in ("graph_edges", "graph_nodes",
                                             "graph_cooc_evidence", "graph_shadow_edges")}
        topics.compute(self.conn)
        for t, rows in before.items():
            self.assertEqual(self._dump(t), rows, t + " 被算的过程动了")

    def test_fact_edges_are_opt_in(self):
        """默认只跑证据图:事实边不掺(掺了会把 hub 当桥 —— 见模块头)。"""
        seed(self.conn)
        self.conn.execute(
            "INSERT INTO graph_edges (source_id, target_id, relation, owner_key,"
            " weight, is_active, kind) VALUES ('g1', 's1', '老乡', 'master', 1.0, 1, '')")
        self.conn.commit()
        plain = topics.compute(self.conn)
        self.assertEqual(plain["fact_edges"], 0, "默认不掺事实边")
        self.assertEqual(plain["cooc_pairs"], 10, "证据层派生出来的那 10 对")
        with_fact = topics.compute(self.conn, include_fact=True)
        self.assertEqual(with_fact["fact_edges"], 1)
        self.assertGreater(with_fact["edges"], plain["edges"], "掺了事实边,图该变大")

    def _dump(self, table):
        return [tuple(str(c) for c in r) for r in self.conn.execute(
            "SELECT * FROM " + table + " ORDER BY 1")]


class Clustering(unittest.TestCase):
    def setUp(self):
        self.tmp, self.conn = fresh_conn()
        self.addCleanup(self.tmp.cleanup)
        self.addCleanup(self.conn.close)
        seed(self.conn)

    def _groups(self, plan):
        return {c["key"]: set(m["node_id"] for m in c["members"]) for c in plan["clusters"]}

    def test_two_groups_with_a_bridge_and_a_dropped_pair(self):
        plan = topics.compute(self.conn)
        groups = self._groups(plan)
        self.assertEqual(len(groups), 2, str(groups))
        self.assertIn({"g1", "g2", "g3", "g4", "b1"}, list(groups.values()),
                      "游戏组 + 桥(本体落这边)")
        self.assertIn({"s1", "s2", "s3"}, list(groups.values()), "学校组三件套")
        # 软归属是**对称的**:桥跨过去、对面那个邻点也跨过来各带一份强度
        flat = {n for d in (plan["soft_shares"] or {}).values() for n in d}
        self.assertEqual(sorted(flat), ["b1", "s1"], "跨簇的是桥 + 它对面的邻点")
        with_b = [k for k, g in groups.items() if "b1" in g]
        soft_b = {k for k, d in (plan["soft_shares"] or {}).items() if "b1" in d}
        self.assertEqual((len(with_b), len(soft_b)), (1, 1), "本体一处 + 软归属一处")
        self.assertNotIn(with_b[0], soft_b)
        # 孤对(2 个成员)进不了簇,但**收在案上**(不是静默丢掉)
        self.assertEqual(sorted(plan["unclustered"]), ["z1", "z2"])
        for c in plan["clusters"]:
            self.assertTrue(c["label"], "簇名不能空")

    def test_soft_membership_is_multi(self):
        plan = topics.compute(self.conn)
        flat = {n: s for d in (plan.get("soft_shares") or {}).values()
                for n, s in d.items()}
        self.assertEqual(sorted(flat), ["b1", "s1"], "只有这两个跨簇")
        # 桥:两条边一半在游戏组 ⇒ 0.5;学校那侧的邻点:三条边里一条通向桥 ⇒ 1/3
        self.assertAlmostEqual(flat["b1"], 0.5, places=6)
        self.assertAlmostEqual(flat["s1"], 1.0 / 3.0, places=6)

    def test_same_params_twice_are_identical(self):
        a = topics.compute(self.conn)
        b = topics.compute(self.conn)
        self.assertEqual(a["labels"], b["labels"], "两次跑标签不一致(不确定了)")
        self.assertEqual([c["members"] for c in a["clusters"]],
                         [c["members"] for c in b["clusters"]])
        self.assertEqual(a["soft_shares"], b["soft_shares"])

    def test_apply_recomputes_as_a_batch(self):
        plan = topics.compute(self.conn)
        out1 = topics.apply_plan(self.conn, plan, now=1000.0)
        self.assertEqual((out1["clusters"], out1["members"], out1["soft_members"]),
                         (2, 8, 2), str(out1))
        first = member_map(self.conn)
        rep1 = topics.report(self.conn)
        self.assertEqual((rep1["active_clusters"], rep1["primary_members"],
                          rep1["soft_members"], rep1["summaries"]),
                         (2, 8, 2, 0), str(rep1))

        out2 = topics.apply_plan(self.conn, plan, now=2000.0)
        self.assertEqual(out2["deactivated"], 2, "旧批该被整批置 0")
        self.assertEqual(member_map(self.conn), first, "重算后成员集合必须一致")
        rep2 = topics.report(self.conn)
        self.assertEqual(rep2["active_clusters"], 2)
        self.assertEqual([b["batch_key"] for b in rep2["batches"][:1]], ["topic-2000"])
        batches = {b["batch_key"]: b for b in rep2["batches"]}
        self.assertEqual((batches["topic-1000"]["active"], batches["topic-2000"]["active"]),
                         (False, True), "批次该一旧一新")
        # 账本留名
        self.assertEqual(self.conn.execute(
            "SELECT COUNT(*) FROM schema_migrations WHERE name = 'a5_topic_view_v1'"
        ).fetchone()[0], 1)

    def test_apply_touches_only_the_view_tables(self):
        plan = topics.compute(self.conn)
        watched = ("graph_edges", "graph_nodes", "graph_cooc_evidence",
                   "graph_shadow_edges", "graph_edge_receipts", "episodic_memory")
        before = {t: [tuple(str(c) for c in r) for r in self.conn.execute(
            "SELECT * FROM " + t + " ORDER BY 1")] for t in watched}
        topics.apply_plan(self.conn, plan, now=1000.0)
        for t, rows in before.items():
            self.assertEqual([tuple(str(c) for c in r) for r in self.conn.execute(
                "SELECT * FROM " + t + " ORDER BY 1")], rows, t + " 被视图落库动了")

    def test_rollback_is_one_update(self):
        plan = topics.compute(self.conn)
        topics.apply_plan(self.conn, plan, now=1000.0)
        self.conn.execute("UPDATE " + topics.CLUSTER_TABLE + " SET is_active = 0")
        self.conn.commit()
        rep = topics.report(self.conn)
        self.assertEqual((rep["active_clusters"], rep["active_members"]), (0, 0))
        # 行还在(可审计),只是不现行
        self.assertEqual(int(self.conn.execute(
            "SELECT COUNT(*) FROM " + topics.CLUSTER_TABLE).fetchone()[0]), 2)

    def test_report_text_names_the_view_and_the_two_layers(self):
        plan = topics.compute(self.conn)
        topics.apply_plan(self.conn, plan, now=1000.0)
        text = topics.to_text(topics.report(self.conn), plan)
        self.assertIn("不进检索", text)
        self.assertIn("软归属", text)


class Summaries(unittest.TestCase):
    """A5b:摘要是**离线任务填回**的 —— 引擎只供提示词 + 只认形状,校验不合格就不写。"""

    def setUp(self):
        self.tmp, self.conn = fresh_conn()
        self.addCleanup(self.tmp.cleanup)
        self.addCleanup(self.conn.close)
        seed(self.conn)
        topics.apply_plan(self.conn, topics.compute(self.conn), now=1000.0)
        self.view = topics.active_view(self.conn)

    def test_active_view_carries_ids_and_members(self):
        self.assertEqual(len(self.view), 2)
        for c in self.view:
            self.assertGreater(c["cluster_id"], 0)
            self.assertTrue(c["members"], "簇里得有人")
            self.assertEqual(c["summary"], "")
            self.assertEqual(c["batch_key"], "topic-1000")

    def test_prompts_carry_members_and_the_hard_constraints(self):
        prompts = topics.build_prompts(self.view)
        self.assertEqual(len(prompts), 2)
        for p, c in zip(prompts, self.view):
            self.assertEqual(p["cluster_id"], c["cluster_id"])
            self.assertIn("算法产物", p["system"], "提示词必须写明'这是算法产物'")
            self.assertIn("不许编", p["system"])
            self.assertIn("%d 字" % topics.SUMMARY_MAX_CHARS, p["system"])
            for name in c["members"]:
                self.assertIn(name, p["user"], "材料里得列出成员")

    def test_apply_summaries_validates_every_item(self):
        cid = self.view[0]["cluster_id"]
        other = self.view[1]["cluster_id"]
        out = topics.apply_summaries(self.conn, {
            cid: "他常聊的二战卡牌游戏:KARDS、德美跳、战地1",
            other: "",                                  # 空 ⇒ 拒
            "999999": "不属于任何现行簇",                # 填错地方 ⇒ 拒
            "oops": "键不是数字",                        # 键坏 ⇒ 拒
        })
        self.assertEqual((out["written"], len(out["rejected"])), (1, 3), str(out))
        self.assertEqual(sorted(r["reason"] for r in out["rejected"]),
                         ["bad-key", "empty", "not-active-cluster"])
        self.assertEqual(topics.report(self.conn)["summaries"], 1)
        # 合格但超长/多行/元话 ⇒ 一律拒(绝不"净化后照写")
        long_one = "很长的" * 40
        out2 = topics.apply_summaries(self.conn, {cid: long_one, other: "第一行\n第二行"})
        self.assertEqual(sorted(r["reason"] for r in out2["rejected"]), ["not-one-line",
                                                                        "too-long"])
        # 幂等:同一句再填一次 ⇒ 不写
        again = topics.apply_summaries(self.conn, {
            cid: "他常聊的二战卡牌游戏:KARDS、德美跳、战地1"})
        self.assertEqual((again["written"], again["unchanged"]), (0, 1))

    def test_apply_summaries_touches_only_the_summary_column(self):
        cid = self.view[0]["cluster_id"]
        rows_before = [tuple(str(c) for c in r) for r in self.conn.execute(
            "SELECT cluster_id, owner_key, level, label, algorithm, params, member_count,"
            " batch_key, is_active FROM " + topics.CLUSTER_TABLE + " ORDER BY cluster_id")]
        edges_before = [tuple(str(c) for c in r) for r in self.conn.execute(
            "SELECT * FROM graph_edges ORDER BY 1")]
        topics.apply_summaries(self.conn, {cid: "他常聊的游戏"})
        self.assertEqual([tuple(str(c) for c in r) for r in self.conn.execute(
            "SELECT cluster_id, owner_key, level, label, algorithm, params, member_count,"
            " batch_key, is_active FROM " + topics.CLUSTER_TABLE + " ORDER BY cluster_id")],
            rows_before, "摘要以外的列被动了")
        self.assertEqual([tuple(str(c) for c in r) for r in self.conn.execute(
            "SELECT * FROM graph_edges ORDER BY 1")], edges_before)

    def test_summaries_do_not_attach_to_inactive_batches(self):
        cid = self.view[0]["cluster_id"]
        self.conn.execute("UPDATE " + topics.CLUSTER_TABLE + " SET is_active = 0")
        self.conn.commit()
        out = topics.apply_summaries(self.conn, {cid: "上一批的簇"})
        self.assertEqual(out["written"], 0)
        self.assertEqual(out["rejected"][0]["reason"], "not-active-cluster")


class ReadSideQuarantine(unittest.TestCase):
    """主题簇不许进检索/渲染;这条守卫必须能亮。"""

    def test_read_side_files_never_mention_the_topic_view(self):
        for rel in topics.READ_SIDE_FILES:
            text = (REPO / rel).read_text(encoding="utf-8")
            for name in topics.FORBIDDEN_NAMES:
                self.assertNotIn(name, text, "%s 里不该出现 %s" % (rel, name))

    def test_guard_is_not_vacuous(self):
        for rel in ("python/engine/db.py", "python/engine/topics.py"):
            text = (REPO / rel).read_text(encoding="utf-8")
            self.assertIn("graph_topic_clusters", text, rel)


if __name__ == "__main__":
    unittest.main()
