# -*- coding: utf-8 -*-
"""A3:边的类型层与证据层 —— 三条不变量 + 一套术语。

为什么值得一组测试钉住:

1. **空 `kind` = 事实边**是承重约定(`top_nodes()` 的「已有实体」与剪枝都按它
   过滤)。一旦有人往 `graph_edges` 写非空 kind,那两处会把事实边当影子边漏掉,
   而且是**静默**的 —— 所以要有"写入点拒收 + 真库恒为 0"两道门。
2. **空 `evidence` 不是错误**(诚实留空)。所以这里测的是"能数出来",不是"必须填"。
3. **类型层不许进渲染口**:`load()` / `render_paths()` 里出现 `kind`/`evidence`
   就是越界(进 prompt 要单独裁决)—— 源码级守卫,防将来顺手加一行。
"""

import inspect
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from engine import db, evidence as ev, graph  # noqa: E402
from engine import evidence_debt  # noqa: E402


def fresh_conn():
    tmp = tempfile.TemporaryDirectory()
    conn = db.connect(os.path.join(tmp.name, "echo.db"))
    return tmp, conn


class EdgeKindInvariant(unittest.TestCase):
    def setUp(self):
        self.tmp, self.conn = fresh_conn()
        self.addCleanup(self.tmp.cleanup)
        self.addCleanup(self.conn.close)

    def _kinds(self):
        return [str(r[0] or "") for r in self.conn.execute(
            "SELECT COALESCE(kind, '') FROM graph_edges")]

    def test_written_edges_are_fact_kind(self):
        graph.add_edge(self.conn, "用户", "喜欢玩", "KARDS", "master")
        self.assertEqual(self._kinds(), [""], "空 kind = 事实边(承重约定)")

    def test_explicit_fact_is_normalized_to_empty(self):
        graph.add_edge(self.conn, "用户", "喜欢玩", "KARDS", "master", kind="fact")
        self.assertEqual(self._kinds(), [""],
                         "存 'fact' 会被 top_nodes()/剪枝当影子边漏掉 ⇒ 必须归一")

    def test_nonfact_kind_is_rejected_loudly(self):
        for bad in ("cooccur_same_memory", "temporal", "made_up"):
            with self.assertRaises(ValueError, msg=bad):
                graph.add_edge(self.conn, "用户", "喜欢玩", "KARDS", "master", kind=bad)
        self.assertEqual(self._kinds(), [], "抛错时不该留下半条边")

    def test_kind_helpers(self):
        self.assertTrue(ev.is_fact_kind(""))
        self.assertTrue(ev.is_fact_kind("fact"))
        self.assertFalse(ev.is_fact_kind("cooccur_same_day"))
        self.assertEqual(ev.normalize_kind(""), "")
        self.assertEqual(ev.normalize_kind("FACT"), "")
        self.assertEqual(ev.normalize_kind("   "), "", "空白 = 没填 = 事实边")

    def test_read_ports_never_read_the_type_layer(self):
        for fn in (graph.load, graph.render_paths):
            src = inspect.getsource(fn)
            for word in ("kind", "evidence"):
                self.assertNotIn(word, src,
                                 "%s() 不该读类型层(`%s`)—— 进 prompt 要单独裁决"
                                 % (fn.__name__, word))
        # 反向保险:load() 吐出来的边字典里也不许出现这两个键
        graph.add_edge(self.conn, "用户", "喜欢玩", "KARDS", "master")
        _by_id, _by_name, edges = graph.load(self.conn, "master")
        self.assertTrue(edges)
        for e in edges:
            self.assertNotIn("kind", e)
            self.assertNotIn("evidence", e)


class EvidenceVocabulary(unittest.TestCase):
    """依据串的术语:真编号 / 推定 / 混合 / 无 —— 两种既有写法都要认。"""

    def test_forms(self):
        cases = [
            ("169、99", "real", [169, 99]),
            ("140、40、38(推定)", "mixed", [140, 40, 38]),   # 后缀贴在最后一个 id 上
            ("169、99、(推定)", "mixed", [169, 99]),          # 后缀自成一段
            ("(推定)", "inferred", []),
            ("", "none", []),
            ("   ", "none", []),
        ]
        for raw, want_strength, want_ids in cases:
            self.assertEqual(ev.strength(raw), want_strength, raw)
            self.assertEqual(ev.evidence_ids(raw), want_ids, raw)

    def test_tolerant_separators_and_dedupe(self):
        self.assertEqual(ev.split_evidence("169,99，169、99"), ["169", "99"])
        self.assertEqual(ev.evidence_ids("1,2，3"), [1, 2, 3])

    def test_inferred_marker_matches_the_js_rule(self):
        # `scripts/graph-merge.mjs` 用的是 `/推定/.test(...)` —— 判据必须一致
        for raw in ("(推定)", "38(推定)", "1、推定"):
            self.assertTrue(ev.has_inferred(raw), raw)
        self.assertFalse(ev.has_inferred("169、99"))

    def test_join_keeps_marks_but_numbers_clean(self):
        self.assertEqual(ev.join_evidence([169, "99"]), "169、99")
        self.assertEqual(ev.join_evidence(["(推定)"]), "(推定)")
        self.assertEqual(ev.join_evidence("1,2"), "1、2")

    def test_describe_is_human(self):
        self.assertEqual(ev.describe(""), "无依据")
        self.assertEqual(ev.describe("(推定)"), "仅推定")
        self.assertEqual(ev.describe("1、2"), "真编号 2 个")
        self.assertEqual(ev.describe("1(推定)"), "真编号 1 个 + 推定")


class LearnDiagnostics(unittest.TestCase):
    def setUp(self):
        self.tmp, self.conn = fresh_conn()
        self.addCleanup(self.tmp.cleanup)
        self.addCleanup(self.conn.close)

    def test_counts_without_changing_writes(self):
        diag = {}
        n = graph.learn(self.conn, [["用户", "喜欢玩", "KARDS"]], "master",
                        evidence_ids=[169, 99], diag=diag)
        self.assertEqual((n, diag), (1, {"written": 1, "real_evidence": 1}))
        graph.learn(self.conn, [["用户", "喜欢玩", "德美跳"]], "master",
                    evidence_ids=["(推定)"], diag=diag)
        graph.learn(self.conn, [["用户", "喜欢玩", "战地1"]], "master",
                    evidence_ids=None, diag=diag)
        self.assertEqual(diag, {"written": 3, "real_evidence": 1,
                                "evidence_dropped": 1, "no_evidence": 1},
                         "非编号段会被 _merge_evidence 丢掉 ⇒ 记 dropped,不记「有依据」")
        # 三条边都**照常写**(diag 只是计数,不是门槛)
        self.assertEqual(self.conn.execute(
            "SELECT COUNT(*) FROM graph_edges").fetchone()[0], 3)
        # 落库形态照实:`_merge_evidence` 是「新在前」⇒ [169, 99] 存成 '99、169';
        # 非编号段进不去 ⇒ 那两条是空串。
        self.assertEqual(self.conn.execute(
            "SELECT COALESCE(evidence,'') FROM graph_edges WHERE relation='喜欢玩'"
            " ORDER BY edge_id").fetchall(), [("99、169",), ("",), ("",)])

    def test_legacy_call_without_diag_still_works(self):
        self.assertEqual(graph.learn(self.conn, [["用户", "喜欢", "音理"]], "master"), 1)


class EvidenceDebtReport(unittest.TestCase):
    def setUp(self):
        self.tmp, self.conn = fresh_conn()
        self.addCleanup(self.tmp.cleanup)
        self.addCleanup(self.conn.close)

    def test_counts_and_kind_guard(self):
        graph.add_edge(self.conn, "用户", "喜欢玩", "KARDS", "master")
        graph.add_edge(self.conn, "用户", "喜欢玩", "德美跳", "master")
        graph.add_edge(self.conn, "用户", "喜欢玩", "战地1", "master")
        graph.learn(self.conn, [["用户", "想念", "音理"]], "master", evidence_ids=[7])
        self.conn.execute("UPDATE graph_edges SET evidence = '5、6(推定)'"
                          " WHERE relation = '想念'")
        self.conn.execute("UPDATE graph_edges SET is_active = 0 WHERE relation = '喜欢玩'"
                          " AND target_id = (SELECT node_id FROM graph_nodes WHERE name='德美跳')")
        self.conn.commit()

        sv = evidence_debt.survey(self.conn, "master")
        self.assertEqual(sv["all"]["edges"], 4)
        self.assertEqual((sv["all"]["none"], sv["all"]["mixed"]), (3, 1))
        self.assertEqual(sv["active"]["edges"], 3, "德美跳那条已归档,不算活跃")
        self.assertEqual(sv["nonfact_kind_rows"], 0)
        self.assertEqual([w["relation"] for w in sv["weak_active"]],
                         ["喜欢玩", "喜欢玩"],
                         "弱依据只含 none/inferred;那条 mixed 不算弱,归档的也不算")
        text = evidence_debt.to_text(sv)
        self.assertIn("非空 `kind` = **0**", text)
        self.assertIn("弱依据的活跃边", text)


if __name__ == "__main__":
    unittest.main()
