# -*- coding: utf-8 -*-
"""v2-A1:换代按基数 —— **并列不是矛盾**。

这一组测试钉住三件事:
  ① 单值关系(住在 / 就读于)照旧换代,旧边留档(superseded_by 回填);
  ② 多值关系(喜欢玩 / 喜欢)下新旧目标**并列**,谁也不顶谁 ——
     正是 `KARDS` 节点悬空的病根;
  ③ 集合记忆键(`longTermInterests`)同键多条并存,非集合键照旧换代;
  ④ 槽位升为三元组身份、老值进 `slot_v1`(可回退),且迁移只跑一次;
  ⑤ 回补工具只认「多值关系下被同槽顶掉」的边,先留回执再复位。
"""

import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from engine import db, episodic, graph, relations  # noqa: E402
from engine import repair_multivalue as repair  # noqa: E402


def fresh_conn():
    tmp = tempfile.TemporaryDirectory()
    conn = db.connect(os.path.join(tmp.name, "echo.db"))
    return tmp, conn


def edge_id_of(conn, s, rel, t):
    row = conn.execute(
        "SELECT e.edge_id FROM graph_edges e"
        " JOIN graph_nodes n1 ON e.source_id = n1.node_id"
        " JOIN graph_nodes n2 ON e.target_id = n2.node_id"
        " WHERE n1.name = ? AND e.relation = ? AND n2.name = ? AND e.owner_key = ?",
        (s, rel, t, "master")).fetchone()
    return int(row[0]) if row else None


class CardinalityTable(unittest.TestCase):
    """口径只在 relations.py 一处,默认方向:关系偏多值、记忆键偏单值。"""

    def test_whitelist_and_defaults(self):
        self.assertTrue(relations.is_single_value_relation("住在"))
        self.assertTrue(relations.is_single_value_relation("就读于"))
        self.assertFalse(relations.is_single_value_relation("喜欢玩"))
        self.assertFalse(relations.is_single_value_relation("从没见过的关系"))
        self.assertEqual(relations.cardinality_of_relation("喜欢"), "multi")
        self.assertEqual(relations.cardinality_of_relation("是"), "single")

    def test_memory_key_whitelist(self):
        self.assertTrue(relations.is_multi_value_memory_key("longTermInterests"))
        self.assertFalse(relations.is_multi_value_memory_key("identity_education"))
        self.assertFalse(relations.is_multi_value_memory_key(""))


class GraphCardinality(unittest.TestCase):
    def setUp(self):
        self.tmp, self.conn = fresh_conn()
        self.addCleanup(self.tmp.cleanup)
        self.addCleanup(self.conn.close)

    def test_slot_is_triple_identity(self):
        graph.add_edge(self.conn, "用户", "喜欢玩", "KARDS", "master")
        row = self.conn.execute(
            "SELECT slot, slot_v1, source_id, target_id FROM graph_edges").fetchone()
        self.assertEqual(row[0], "%s|喜欢玩|%s" % (row[2], row[3]))
        self.assertEqual(row[1], "")   # 新写入的行没有"老槽位"

    def test_multi_value_keeps_both_targets(self):
        """2026-10-01 的病根:KARDS 被德美跳顶下线 ⇒ 节点悬空。"""
        graph.add_edge(self.conn, "用户", "喜欢玩", "KARDS", "master")
        graph.add_edge(self.conn, "用户", "喜欢玩", "德美跳", "master")
        graph.add_edge(self.conn, "用户", "喜欢玩", "战地1", "master")
        rows = self.conn.execute(
            "SELECT is_active, superseded_by FROM graph_edges ORDER BY edge_id").fetchall()
        self.assertEqual([int(r[0]) for r in rows], [1, 1, 1])   # 三条全活
        self.assertEqual([int(r[1]) for r in rows], [0, 0, 0])   # 谁也不顶谁

    def test_single_value_still_supersedes_and_revives(self):
        graph.add_edge(self.conn, "用户", "住在", "西安", "master")
        old = edge_id_of(self.conn, "用户", "住在", "西安")
        graph.add_edge(self.conn, "用户", "住在", "北京", "master")
        new = edge_id_of(self.conn, "用户", "住在", "北京")
        rows = {int(r[0]): (int(r[1]), int(r[2])) for r in self.conn.execute(
            "SELECT edge_id, is_active, superseded_by FROM graph_edges")}
        self.assertEqual(rows[old], (0, new))    # 旧边留档,superseded_by 指新边
        self.assertEqual(rows[new], (1, 0))
        # 搬回西安:旧边复活,北京版本让位(单值关系仍走让位)
        graph.add_edge(self.conn, "用户", "住在", "西安", "master")
        rows = {int(r[0]): (int(r[1]), int(r[2])) for r in self.conn.execute(
            "SELECT edge_id, is_active, superseded_by FROM graph_edges")}
        self.assertEqual(rows[old], (1, 0))
        self.assertEqual(rows[new], (0, old))

    def test_multi_value_relation_never_touches_other_relations(self):
        """多值关系不动旁边的单值关系(换代查询按 (owner, source, relation) 收敛)。"""
        graph.add_edge(self.conn, "用户", "住在", "西安", "master")
        graph.add_edge(self.conn, "用户", "居住", "北京", "master")   # 另一个关系(多值默认)
        graph.add_edge(self.conn, "用户", "喜欢玩", "KARDS", "master")
        alive = self.conn.execute(
            "SELECT COUNT(*) FROM graph_edges WHERE is_active = 1").fetchone()[0]
        self.assertEqual(alive, 3)


class EpisodicCardinality(unittest.TestCase):
    def setUp(self):
        self.tmp, self.conn = fresh_conn()
        self.addCleanup(self.tmp.cleanup)
        self.addCleanup(self.conn.close)

    def _add(self, summary, key, layer="L0"):
        return episodic.insert_memory(
            self.conn, "master", "[]", summary, 5.0,
            memory_key=key, layer=layer)

    def test_collection_key_keeps_both(self):
        a = self._add("用户主动说自己喜欢玩KARDS这款二战题材的卡牌游戏。",
                      "longTermInterests")
        b = self._add("阿岚表示自己也喜欢玩战地1", "longTermInterests")
        rows = {int(r[0]): int(r[1]) for r in self.conn.execute(
            "SELECT memory_id, is_active FROM episodic_memory"
            " WHERE memory_key = 'longTermInterests'")}
        self.assertEqual((a in rows, b in rows), (True, True))
        self.assertEqual((rows[a], rows[b]), (1, 1), "集合键:并列,不换代")

    def test_non_collection_key_still_supersedes(self):
        a = self._add("用户在读大一", "identity_education")
        b = self._add("用户已经升到大二了", "identity_education")
        rows = {int(r[0]): (int(r[1]), int(r[2])) for r in self.conn.execute(
            "SELECT memory_id, is_active, superseded_by FROM episodic_memory"
            " WHERE memory_key = 'identity_education'")}
        self.assertEqual(rows[a][0], 0, "非集合键:旧版本让位")
        self.assertEqual(rows[a][1], b)
        self.assertEqual(rows[b][0], 1)


class RepairMultivalue(unittest.TestCase):
    """回补工具:只救「多值关系下被同槽顶掉」的边,先回执后改行。"""

    def setUp(self):
        self.tmp, self.conn = fresh_conn()
        self.addCleanup(self.tmp.cleanup)
        self.addCleanup(self.conn.close)

    def test_restores_false_kill_only(self):
        graph.add_edge(self.conn, "用户", "喜欢玩", "KARDS", "master")
        graph.add_edge(self.conn, "用户", "喜欢玩", "德美跳", "master")
        graph.add_edge(self.conn, "用户", "住在", "西安", "master")
        graph.add_edge(self.conn, "用户", "住在", "北京", "master")
        kards = edge_id_of(self.conn, "用户", "喜欢玩", "KARDS")
        demei = edge_id_of(self.conn, "用户", "喜欢玩", "德美跳")
        # 造出历史现场:多值关系下 KARDS 被德美跳顶掉(单值那条本来就是正常换代)
        self.conn.execute("UPDATE graph_edges SET is_active = 0, superseded_by = ?"
                          " WHERE edge_id = ?", (demei, kards))
        self.conn.commit()

        plan = repair.collect(self.conn)
        self.assertEqual([e["edge_id"] for e in plan["restore_edges"]], [kards])
        self.assertEqual(len(plan["single_value_supersessions"]), 1)  # 「住在」那条正常
        self.assertEqual(plan["restore_memories"], [])

        written = repair.apply_restores(self.conn, plan)
        self.assertEqual(written["restored_edges"], 1)
        row = self.conn.execute(
            "SELECT is_active, superseded_by FROM graph_edges WHERE edge_id = ?",
            (kards,)).fetchone()
        self.assertEqual((int(row[0]), int(row[1])), (1, 0))
        n = self.conn.execute(
            "SELECT COUNT(*) FROM graph_edge_receipts WHERE action = 'restore'"
            " AND reason = ?", (repair.REASON,)).fetchone()[0]
        self.assertEqual(n, 1, "回补必须逐条留回执")
        # 幂等:再跑一次,没有可救的了
        self.assertEqual(repair.collect(self.conn)["restore_edges"], [])

    def test_reports_multi_targets_without_touching_them(self):
        """单值关系下出现多个活跃目标 = **老代码**留下的毛病,只报告不擅动。"""
        graph.add_edge(self.conn, "用户", "就读于", "西安电子科技大学", "master")
        graph.add_edge(self.conn, "用户", "就读于", "某中学", "master")
        # 先验:v2-A1 的写入路径本身已收敛到 1 个活跃目标(单值换代生效)
        self.assertEqual(self.conn.execute(
            "SELECT COUNT(*) FROM graph_edges WHERE is_active = 1").fetchone()[0], 1)
        # 手工复现老库那种状态(活库 2026-10-01 实测:用户—就读于 挂着 2 个目标)
        self.conn.execute("UPDATE graph_edges SET is_active = 1, superseded_by = 0")
        self.conn.commit()
        plan = repair.collect(self.conn)
        self.assertEqual(plan["restore_edges"], [])
        self.assertEqual(len(plan["multi_targets"]), 1)
        alive = self.conn.execute(
            "SELECT COUNT(*) FROM graph_edges WHERE is_active = 1").fetchone()[0]
        self.assertEqual(alive, 2, "报告而已,一行都不许改")


class RelationNormalize(unittest.TestCase):
    """A2:谓词归一 —— 唯一出处、**只并同义**、原话留档、幂等。"""

    def setUp(self):
        self.tmp, self.conn = fresh_conn()
        self.addCleanup(self.tmp.cleanup)
        self.addCleanup(self.conn.close)

    def test_single_source_of_truth(self):
        from engine import graph, normalize_relations as norm  # noqa: F401
        self.assertIs(graph.RELATION_ALIASES, relations.CANONICAL_RELATION,
                      "两张表必须**是同一个对象**(防第二份表长出来)")
        self.assertEqual(graph.canonical_relation("读于"), "就读于")
        self.assertEqual(graph.canonical_relation("就读"), "就读于")

    def test_only_synonyms_are_merged(self):
        """上下位 / 拿不准的一律不并(并掉会丢粒度)。"""
        for keep in ("喜欢玩", "喜欢吃", "专业是", "觉得不错", "是老玩家",
                     "进行", "有校园跑要求", "想念", "在意", "参加"):
            self.assertEqual(relations.canonical_relation(keep), keep, keep)
        self.assertEqual(relations.canonical_relation("就读于"), "就读于")
        self.assertEqual(relations.canonical_relation(""), "")

    def test_pending_entries_are_not_in_the_map(self):
        for p in relations.RELATION_PENDING:
            for name in str(p["variant"]).replace("/", " ").split():
                if name.strip():
                    self.assertEqual(relations.canonical_relation(name.strip()), name.strip(),
                                     "待定项不许偷偷进合并表:" + name)

    def test_add_edge_keeps_the_raw_wording(self):
        graph.add_edge(self.conn, "用户", "就读", "某大学", "master")
        row = self.conn.execute(
            "SELECT relation, relation_raw FROM graph_edges").fetchone()
        self.assertEqual(row[0], "就读于", "写入侧就接地")
        self.assertEqual(row[1], "就读", "原话必须留档(回退/审计依据)")

    def test_cli_apply_then_idempotent(self):
        from engine import normalize_relations as norm
        # 直接造"老数据":写入侧现在会**就地归一**,所以要手写行来复现历史现场。
        # (在读于/在做 是变体;负责 是同目标的规范边;觉得不错 是待定项。)
        for i, (rel, tgt) in enumerate([("读于", "n_uni"), ("在做", "n_same"),
                                        ("负责", "n_same"), ("觉得不错", "n_mcd")], start=1):
            self.conn.execute(
                "INSERT INTO graph_edges (source_id, target_id, relation, weight,"
                " owner_key, is_active, slot) VALUES ('n_u', ?, ?, 1.0, 'master', 1, ?)",
                (tgt, rel, "n_u|%s|%s" % (rel, tgt)))
        self.conn.commit()

        sv = norm.survey(self.conn, "master")
        self.assertEqual((sv["distinct_all"], sv["distinct_active"]), (4, 4))
        self.assertEqual(sorted(m["variant"] for m in sv["merges"] if m["processable"]),
                         ["在做", "读于"])
        self.assertEqual(sv["active_after"], 2)
        self.assertTrue(any("觉得不错" in p["in_live"] for p in sv["pending"]))

        norm.apply_changes(self.conn, "master", sv)
        rows = {}
        for r in self.conn.execute(
                "SELECT relation, relation_raw, is_active FROM graph_edges"):
            rows.setdefault((str(r[0]), str(r[1] or "")), []).append(int(r[2]))
        self.assertEqual(rows[("就读于", "读于")], [1], "改名:原话留档、行还活着")
        self.assertEqual(rows[("在做", "在做")], [0],
                         "吸收留档:谓词**保持原话**(唯一键不允许改归档行的谓词)")
        self.assertEqual(rows[("负责", "")], [1], "幸存者还是现役")
        self.assertEqual(rows[("觉得不错", "")], [1], "待定项不许被并")
        # 账本留名
        self.assertEqual(self.conn.execute(
            "SELECT COUNT(*) FROM schema_migrations WHERE name = ?",
            (norm.MARKER,)).fetchone()[0], 1)
        # 幂等:第二次跑零改动,活跃侧词表也不再降
        again = norm.apply_changes(self.conn, "master", norm.survey(self.conn, "master"))
        self.assertEqual((again["renamed"], again["merged"]), ([], []))
        self.assertEqual(norm.survey(self.conn, "master")["distinct_active"], 3)


if __name__ == "__main__":
    unittest.main()
