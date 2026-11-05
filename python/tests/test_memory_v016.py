# -*- coding: utf-8 -*-
"""v0.16.0 记忆修理的引擎侧测试(M1 回指 / M2 归一 / M3 去重)。

三条都是「图谱与记忆对不上」的病灶,测试按**症状**组织而不是按函数:
  1. 写完一轮之后,边能不能说出「我是从哪几条记忆学来的」(M1)
  2. 别名接地之后,同一个东西还会不会各长一坨(M2)
  3. 换个说法讲同一件事,还会不会堆成两条现役记忆(M3)
  外加两条**保守性**的钉子:只在数字上不同不许合并;阈值给 0 必须
  回到旧行为(零回归开关)。
"""
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from engine import db, dedupe, episodic, graph, judge  # noqa: E402

NOW = 1790121600.0


def candidate(**kw):
    base = {
        "layer": "L2", "summary": "用户说他喜欢猫", "confidence": 0.9,
        "certainty": "explicit", "attribution": "user_explicit",
        "stability": "stable", "shouldWrite": True,
        "evidenceQuotes": ["我喜欢猫"], "temporal_status": "enduring",
    }
    base.update(kw)
    return base


def triple(**kw):
    base = {
        "s": "用户", "relation": "喜欢", "t": "猫", "layer": "L2",
        "certainty": "explicit", "attribution": "user_explicit",
        "stability": "stable", "shouldWrite": True,
        "evidenceQuotes": ["我喜欢猫"], "temporal_status": "enduring",
    }
    base.update(kw)
    return base


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.conn = db.connect(str(Path(self.tmp.name) / "echo.db"))

    def tearDown(self):
        self.conn.close()
        self.tmp.cleanup()


# ═══════════════════════════════════════════════════════════════════
# M1 · 边的依据(回指)
# ═══════════════════════════════════════════════════════════════════

class Evidence(Base):
    def edge_evidence(self, relation):
        row = self.conn.execute(
            "SELECT evidence FROM graph_edges WHERE relation = ?", (relation,)
        ).fetchone()
        return "" if row is None else str(row[0] or "")

    def test_commit_writes_evidence_ids(self):
        """一轮对话落库后,新边带着本轮的 memory_id。"""
        structured = {
            "candidates": [candidate(summary="用户就读于西安电子科技大学")],
            "triples": [triple(s="用户", relation="就读于", t="西安电子科技大学")],
        }
        ack = judge.commit(self.conn, "master", structured, "我在西电", now=NOW)
        mid = ack["written"][0]["memoryId"]
        self.assertEqual(self.edge_evidence("就读于"), str(mid))

    def test_evidence_merges_and_caps(self):
        """同一条边被反复学到:依据去重、新在前、上限 8 条。"""
        for i in range(1, 12):
            graph.add_edge(self.conn, "用户", "喜欢", "猫", "master",
                           evidence=[i])
        got = self.edge_evidence("喜欢").split("、")
        self.assertEqual(len(got), 8)
        self.assertEqual(got[0], "11")          # 新在前
        self.assertEqual(len(set(got)), 8)      # 去重
        self.assertNotIn("1", got)              # 最老的被挤出上限

    def test_learn_passes_evidence(self):
        n = graph.learn(self.conn, [triple(t="章鱼小丸子")], "master",
                        evidence_ids=[7, 8])
        self.assertEqual(n, 1)
        self.assertEqual(self.edge_evidence("喜欢"), "8、7")


# ═══════════════════════════════════════════════════════════════════
# M2 · 实体归一(别名接地 + 写入侧预防)
# ═══════════════════════════════════════════════════════════════════

class AliasGrounding(Base):
    def test_alias_maps_to_canonical_node(self):
        """别名命中 → 复用 canonical 节点,不再各长一坨。"""
        canon = graph.get_or_create_node(self.conn, "西安电子科技大学")
        self.conn.execute(
            "INSERT INTO graph_aliases (alias, canonical_name, canonical_node_id,"
            " created_at, source) VALUES ('西电', '西安电子科技大学', ?, ?, 'merge')",
            (canon, NOW))
        self.conn.commit()
        again = graph.get_or_create_node(self.conn, "西电")
        self.assertEqual(again, canon)
        names = [r[0] for r in self.conn.execute(
            "SELECT name FROM graph_nodes").fetchall()]
        self.assertEqual(names, ["西安电子科技大学"])

    def test_alias_table_absent_is_safe(self):
        """表不存在也不许炸(老库/新库都能跑)。"""
        self.conn.execute("DROP TABLE IF EXISTS graph_aliases")
        node = graph.get_or_create_node(self.conn, "西电")
        self.assertTrue(node)

    def test_top_nodes_by_degree(self):
        graph.add_edge(self.conn, "用户", "参加", "校园跑", "master")
        graph.add_edge(self.conn, "校园跑", "要求", "3km速度限制", "master")
        names = graph.top_nodes(self.conn, "master", limit=3)
        self.assertEqual(names[0], "校园跑")     # 度最高
        self.assertIn("用户", names)

    def test_prompt_carries_known_entities(self):
        with_hint = judge.build_extract_prompt(known_entities=["西电", "校园跑"])
        self.assertIn("已有实体", with_hint)
        self.assertIn("西安电子科技大学", with_hint)   # 规则里的提醒话术
        self.assertIn("校园跑", with_hint)
        without = judge.build_extract_prompt()
        self.assertNotIn("已有实体", without)

    def test_placeholder_name_refused(self):
        """M4:模型把 "name": null 吐成字符串 "null" —— 不许进画像。"""
        self.assertIsNone(judge._clean_name("null"))
        self.assertIsNone(judge._clean_name("  "))
        self.assertIsNone(judge._clean_name(None))
        self.assertEqual(judge._clean_name("阿岚"), "阿岚")
        structured = {
            "name": "null",
            "candidates": [candidate(layer="L0", field="preferredName",
                                     summary="null")],
        }
        ack = judge.commit(self.conn, "master", structured, "叫我阿岚", now=NOW)
        self.assertIsNone(ack["name"])


# ═══════════════════════════════════════════════════════════════════
# M3 · 近重复闸(写入侧)
# ═══════════════════════════════════════════════════════════════════

class DedupeJudge(unittest.TestCase):
    """判据本身(与 JS 镜像 tests/dedupe.test.js 同一组夹具)。"""

    def test_paraphrase_is_duplicate(self):
        a = {"keywords": '["校园跑","3km"]', "summary": "用户参与校园跑，要求跑3km且有速度限制",
             "layer": "L2", "status": "active"}
        b = {"keywords": '["校园跑","3km"]', "summary": "用户提到校园跑有要求，需要跑3km且有速度限制",
             "layer": "L2", "status": "active"}
        self.assertTrue(dedupe.is_near_duplicate(a, b))

    def test_digits_only_difference_is_not_duplicate(self):
        """「他的第1只猫」与「他的第2只猫」是两件事 —— 不许合并。"""
        a = {"keywords": '["猫"]', "summary": "用户说他的第1只猫很可爱",
             "layer": "L2", "status": "active"}
        b = {"keywords": '["猫"]', "summary": "用户说他的第2只猫很可爱",
             "layer": "L2", "status": "active"}
        self.assertFalse(dedupe.is_near_duplicate(a, b))

    def test_layer_is_a_hard_gate(self):
        a = {"keywords": '["西电"]', "summary": "用户就读于西安电子科技大学",
             "layer": "L0", "status": "active"}
        b = {"keywords": '["西电"]', "summary": "用户就读于西安电子科技大学",
             "layer": "L2", "status": "active"}
        self.assertFalse(dedupe.is_near_duplicate(a, b))

    def test_keywords_alone_are_not_enough(self):
        """关键词一致但摘要八竿子打不着 → 不合并(保守)。"""
        a = {"keywords": '["猫"]', "summary": "用户说猫很可爱",
             "layer": "L2", "status": "active"}
        b = {"keywords": '["猫"]', "summary": "用户学校的猫舍下周要拆掉重建",
             "layer": "L2", "status": "active"}
        self.assertFalse(dedupe.is_near_duplicate(a, b))

    def test_thresholds_zero_means_off(self):
        a = {"keywords": '["猫"]', "summary": "用户说猫很可爱",
             "layer": "L2", "status": "active"}
        b = {"keywords": '["猫"]', "summary": "用户说猫很可爱",
             "layer": "L2", "status": "active"}
        self.assertFalse(dedupe.is_near_duplicate(
            a, b, kw_threshold=0, summary_threshold=0))

    # ---- 2026-10-10:空层读侧归一(不改历史数据) ----

    def test_normalize_layer_values(self):
        """归一:空/None/空白 ⇒ 'L2';具名层原样(大小写不敏感)。"""
        self.assertEqual(dedupe.normalize_layer(""), "L2")
        self.assertEqual(dedupe.normalize_layer(None), "L2")
        self.assertEqual(dedupe.normalize_layer("   "), "L2")
        self.assertEqual(dedupe.normalize_layer("L0"), "L0")
        self.assertEqual(dedupe.normalize_layer("l1"), "L1")
        self.assertEqual(dedupe.normalize_layer("L2"), "L2")

    def test_empty_layer_reads_as_l2(self):
        """空层与 L2 视为同层 ⇒ 历史 47 行空层重新能被去重命中。

        现场:judge 降级路径此前没传 layer ⇒ 落库 `layer=''`。写入侧已修
        (不再增长),历史数据**不动** ⇒ 靠读侧归一接回链路。
        """
        a = {"keywords": '["校园跑","3km"]',
             "summary": "用户参与校园跑，要求跑3km且有速度限制",
             "layer": "", "status": "active"}
        b = {"keywords": '["校园跑","3km"]',
             "summary": "用户提到校园跑有要求，需要跑3km且有速度限制",
             "layer": "L2", "status": "active"}
        self.assertTrue(dedupe.is_near_duplicate(a, b))
        self.assertTrue(dedupe.is_near_duplicate(b, a))

    def test_empty_layer_is_not_any_layer(self):
        """空层归一为 L2,**不是**「任意层」—— 空层撞 L0 / L1 仍是硬门。

        这条是防止把归一写成「空层跟谁都比得上」:那会让身份画像(L0)
        被 L2 碎片合并掉。
        """
        base = {"keywords": '["西电"]', "summary": "用户就读于西安电子科技大学",
                "status": "active"}
        empty = {**base, "layer": ""}
        for other in ("L0", "L1"):
            self.assertFalse(
                dedupe.is_near_duplicate(empty, {**base, "layer": other}),
                "空层不该跟 %s 混判" % other)


class DedupeWritePath(Base):
    def _rows(self):
        return self.conn.execute(
            "SELECT memory_id, is_active, superseded_by, summary"
            " FROM episodic_memory ORDER BY memory_id").fetchall()

    def test_paraphrase_supersedes(self):
        """换个说法讲同一件事 → 旧行让位(不删)。"""
        j1 = judge.commit(self.conn, "master", {
            "candidates": [candidate(summary="用户参与校园跑，要求跑3km且有速度限制",
                                     evidenceQuotes=["校园跑", "3km"])],
        }, "校园跑", now=NOW)
        j2 = judge.commit(self.conn, "master", {
            "candidates": [candidate(
                summary="用户提到校园跑有要求，需要跑3km且有速度限制",
                evidenceQuotes=["校园跑", "3km"])],
        }, "校园跑", now=NOW + 60)
        self.assertEqual(len(j1["written"]), 1)
        self.assertEqual(len(j2["written"]), 1)
        rows = self._rows()
        self.assertEqual(len(rows), 2)
        old, new = rows[0], rows[1]
        self.assertEqual(old[1], 0)                      # 旧行让位
        self.assertEqual(old[2], new[0])                 # 指向新行
        self.assertEqual(new[1], 1)

    def test_gate_off_keeps_two_rows(self):
        """阈值给 0 = 回到旧行为(零回归开关)。"""
        for text in ("用户参与校园跑，要求跑3km且有速度限制",
                     "用户提到校园跑有要求，需要跑3km且有速度限制"):
            judge.commit(self.conn, "master", {
                "candidates": [candidate(summary=text, evidenceQuotes=["校园跑"])],
            }, "校园跑", now=NOW,
                dedupe={"kwThreshold": 0, "summaryThreshold": 0})
        self.assertEqual([r[1] for r in self._rows()], [1, 1])

    def test_same_sentence_is_recall_not_new_row(self):
        """同句(哪怕键不同)算一次「想起」,不新增行。"""
        judge.commit(self.conn, "master", {
            "candidates": [candidate(summary="用户喜欢章鱼小丸子")],
        }, "章鱼小丸子", now=NOW)
        before = self._rows()[0]
        judge.commit(self.conn, "master", {
            "candidates": [candidate(summary="用户喜欢章鱼小丸子",
                                     evidenceQuotes=["章鱼小丸子"])],
        }, "章鱼小丸子", now=NOW + 60)
        rows = self._rows()
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0][0], before[0])
        recalled = self.conn.execute(
            "SELECT recall_count FROM episodic_memory WHERE memory_id = ?",
            (before[0],)).fetchone()[0]
        self.assertGreaterEqual(recalled, 1)

    def test_quarantined_does_not_merge_with_active(self):
        """隔离候选与正式行不互判(隔离就是隔离)。"""
        episodic.insert_memory(self.conn, "master", '["猫"]',
                               "用户说他养了一只叫年糕的猫", 5,
                               intrinsic_value=40.0, layer="L2",
                               now=NOW)
        mid = episodic.insert_memory(self.conn, "master", '["猫"]',
                                     "用户说他养了一只叫年糕的猫", 5,
                                     intrinsic_value=40.0, layer="L2",
                                     status="quarantined", now=NOW + 1)
        self.assertGreater(mid, 0)
        rows = self.conn.execute(
            "SELECT status, is_active FROM episodic_memory ORDER BY memory_id"
        ).fetchall()
        self.assertEqual([tuple(r) for r in rows],
                         [("active", 1), ("quarantined", 1)])

    def test_existing_empty_layer_row_can_be_superseded(self):
        """端到端:库里**已有**的空层行,能被新的 L2 写入按近重复命中。

        这是"读侧兼容"要救的那条链 —— 写入侧修好之后新行是 `L2`,
        若不归一,它和旧的 `''` 行就永远碰不上(去重查询按层相等过滤,
        见 `episodic.py` 的 `LAYER_SQL`)。
        """
        episodic.insert_memory(self.conn, "master", '["校园跑","3km"]',
                               "用户参与校园跑，要求跑3km且有速度限制", 5,
                               intrinsic_value=40.0, layer="", now=NOW)
        judge.commit(self.conn, "master", {
            "candidates": [candidate(
                layer="L2",
                summary="用户提到校园跑有要求，需要跑3km且有速度限制",
                evidenceQuotes=["校园跑", "3km"])],
        }, "校园跑", now=NOW + 60)
        rows = self._rows()
        self.assertEqual(len(rows), 2)
        self.assertEqual(rows[0][1], 0, "空层旧行应让位(读侧归一生效)")
        self.assertEqual(rows[0][2], rows[1][0])
        self.assertEqual(rows[1][1], 1)


if __name__ == "__main__":
    unittest.main()
