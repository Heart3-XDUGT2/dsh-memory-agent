# -*- coding: utf-8 -*-
"""A4:共现的 n 元证据层 —— 三条不变量。

1. **pair 不落盘**:证据表一行 = 一条证据(记忆/日桶),`pairs` 只是那一行里的**文本**,
   pair 行由只读视图 `v_cooc_pairs` 按需派生。谁要是把 pair 又铺成表,这组测试会红。
2. **覆盖**:视图派生出的 pair 必须 ⊇ 影子表那 48 条覆盖的 pair(旧结论一条不丢)。
3. **只读隔离**:检索/渲染侧的文件里**不许出现**证据表/视图的名字(进 prompt 要单独裁决),
   并且这条 grep 守卫必须"能亮"——同一个测试里确认表名确实出现在 db.py / cooc.py。
"""

import inspect
import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from engine import cooc, db  # noqa: E402

REPO = Path(__file__).resolve().parents[2]


def fresh_conn():
    tmp = tempfile.TemporaryDirectory()
    conn = db.connect(os.path.join(tmp.name, "echo.db"))
    return tmp, conn


def shadow(conn, s, t, kind, evidence="", occurred_at=0.0, weight=1.0, active=1,
           owner=cooc.SHADOW_OWNER):
    conn.execute(
        "INSERT INTO graph_shadow_edges (source_id, target_id, relation, weight, kind,"
        " owner_key, evidence, evidence_scope, occurred_at, is_active, created_at)"
        " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (s, t, "共现" if kind == "cooccur_same_memory" else "同日共现", float(weight),
         kind, owner, evidence, "same_memory" if kind == "cooccur_same_memory" else "same_day",
         float(occurred_at), int(active), 1.0))
    conn.commit()


class EvidenceLayer(unittest.TestCase):
    def setUp(self):
        self.tmp, self.conn = fresh_conn()
        self.addCleanup(self.tmp.cleanup)
        self.addCleanup(self.conn.close)

    def _names(self, kind):
        return {str(r[0]) for r in self.conn.execute(
            "SELECT name FROM sqlite_master WHERE type = ?", (kind,))}

    def test_table_and_view_are_pure_additions(self):
        self.assertIn("graph_cooc_evidence", self._names("table"))
        self.assertIn("v_cooc_pairs", self._names("view"))
        # 视图不是表:盘上不该有 pair 行
        self.assertNotIn("v_cooc_pairs", self._names("table"))
        # 引擎专属(JS 侧不必声明,DDL parity 允许引擎多表)
        store = (REPO / "lib" / "store.js").read_text(encoding="utf-8")
        self.assertNotIn("graph_cooc_evidence", store)

    def test_view_derives_pairs_from_the_n_ary_row(self):
        self.conn.execute(
            "INSERT INTO graph_cooc_evidence (owner_key, scope_kind, memory_id, day_key,"
            " node_ids, pairs, node_count, pair_count, weight, source_kind, created_at)"
            " VALUES ('__cooc__', 'same_memory', 7, '', 'n1、n2、n3', 'n1|n2,n1|n3',"
            " 3, 2, 1.0, 'test', 0)")
        self.conn.commit()
        rows = self.conn.execute(
            "SELECT pair_key, source_id, target_id, scope_kind, memory_id"
            " FROM v_cooc_pairs ORDER BY pair_key").fetchall()
        self.assertEqual([tuple(r) for r in rows],
                         [("n1|n2", "n1", "n2", "same_memory", 7),
                          ("n1|n3", "n1", "n3", "same_memory", 7)])
        # 空 pairs 的行不该炸,也不该产出幽灵行
        self.conn.execute(
            "INSERT INTO graph_cooc_evidence (owner_key, scope_kind, memory_id, day_key,"
            " node_ids, pairs, node_count, pair_count, weight, source_kind, created_at)"
            " VALUES ('__cooc__', 'same_day', 0, '99', '', '', 0, 0, 1.0, 'test', 0)")
        self.conn.commit()
        self.assertEqual(self.conn.execute(
            "SELECT COUNT(*) FROM v_cooc_pairs").fetchone()[0], 2)

    def test_build_plan_groups_by_memory_and_by_day(self):
        shadow(self.conn, "n1", "n2", "cooccur_same_memory", evidence="280")
        shadow(self.conn, "n1", "n3", "cooccur_same_memory", evidence="280、285", weight=2.0)
        shadow(self.conn, "n4", "n5", "cooccur_same_day", evidence="176、207",
               occurred_at=1790265600.0)
        shadow(self.conn, "n6", "n7", "temporal", evidence="1")          # 不是共现类
        shadow(self.conn, "n8", "n9", "cooccur_same_memory", evidence="", active=0)  # 归档

        plan = cooc.build_plan(self.conn)
        self.assertEqual(len(plan["items"]), 3, "两个记忆桶 + 一个日桶")
        by = {(i["scope_kind"], i["memory_id"] or i["day_key"]): i for i in plan["items"]}
        m280 = by[("same_memory", 280)]
        self.assertEqual((m280["node_ids"], m280["pair_count"], m280["node_count"]),
                         ("n1、n2、n3", 2, 3), "n 元:一条证据里三个概念")
        self.assertEqual(m280["pairs"], "n1|n2,n1|n3")
        self.assertEqual(by[("same_memory", 285)]["pairs"], "n1|n3")
        self.assertEqual(by[("same_day", "1790265600")]["pairs"], "n4|n5")
        self.assertEqual(len(plan["shadow_pairs"]), 3)
        self.assertEqual(sorted(s["reason"] for s in plan["skipped"]),
                         ["archived", "kind-not-cooc"])

    def test_apply_is_idempotent_and_covers_every_shadow_pair(self):
        shadow(self.conn, "n1", "n2", "cooccur_same_memory", evidence="280")
        shadow(self.conn, "n1", "n3", "cooccur_same_memory", evidence="280、285", weight=2.0)
        shadow(self.conn, "n4", "n5", "cooccur_same_day", evidence="176、207",
               occurred_at=1790265600.0)
        plan = cooc.build_plan(self.conn)
        out1 = cooc.apply_plan(self.conn, plan)
        self.assertEqual(out1["written"], 3)
        cov = cooc.coverage(self.conn, plan)
        self.assertEqual(cov["missing"], [], "影子表覆盖的 pair 一条都不能丢")
        self.assertEqual((cov["derived_rows"], cov["derived_keys"]), (4, 3),
                         "n1|n3 被两条证据作证 ⇒ 行 4 / 去重 3")
        rep = cooc.report(self.conn)
        self.assertEqual(rep["rows"], 3)
        self.assertEqual(rep["shadow_rows"], 3, "影子表只读,行数不动")
        # 幂等:再跑一次,证据行数不变(同一个 (owner, scope, 桶) 只留一行)
        out2 = cooc.apply_plan(self.conn, plan)
        self.assertEqual((out2["written"], cooc.report(self.conn)["rows"]), (3, 3))
        # 账本留名
        self.assertEqual(self.conn.execute(
            "SELECT COUNT(*) FROM schema_migrations WHERE name = 'a4_cooc_evidence_v1'"
        ).fetchone()[0], 1)

    def test_report_text_is_honest_about_freeze(self):
        shadow(self.conn, "n1", "n2", "cooccur_same_memory", evidence="280")
        plan = cooc.build_plan(self.conn)
        cooc.apply_plan(self.conn, plan)
        text = cooc.to_text(cooc.report(self.conn), plan, cooc.coverage(self.conn, plan))
        self.assertIn("冻结,不再增长", text)
        self.assertIn("不落库", text)


class ReadSideQuarantine(unittest.TestCase):
    """证据层不许进检索/渲染;这条守卫必须能亮。"""

    def test_read_side_files_never_mention_the_evidence_layer(self):
        for rel in cooc.READ_SIDE_FILES:
            text = (REPO / rel).read_text(encoding="utf-8")
            for name in cooc.FORBIDDEN_NAMES:
                self.assertNotIn(name, text, "%s 里不该出现 %s" % (rel, name))

    def test_the_ghost_module_is_the_only_js_door(self):
        """JS 侧的幽灵层孤门(lib/graph-ghost.js)三条纪律,一条都不许松:
        名字只许在孤门里、孤门自带 inRetrieval: false、Python 读侧不知道孤门存在。"""
        ghost = (REPO / cooc.GHOST_MODULE).read_text(encoding="utf-8")
        for name in cooc.FORBIDDEN_NAMES:
            self.assertIn(name, ghost, "%s 是禁名在 JS 侧的唯一出口,里面该有 %s" % (cooc.GHOST_MODULE, name))
        self.assertIn("inRetrieval: false", ghost,
                      "孤门给出去的东西必须自带 inRetrieval: false(检索永远看不见)")
        # ① lib/ 里除孤门外谁都不许提禁名(比只盯读侧名单更紧 —— 展示代码也不许散落)。
        #    唯一例外 = `lib/index.js` 的**写入侧文案**(echo_graph_gate 的
        #    writesTo/rollback 帮助文本会提到落点表名)—— 照 graph_gate.py 的先例
        #    单盯:只许当文案提,不许和任何 SQL 执行同行。
        for p in sorted((REPO / "lib").glob("*.js")):
            if p.name == cooc.GHOST_MODULE.split("/")[-1]:
                continue
            text = p.read_text(encoding="utf-8")
            if p.name == "index.js":
                for line in text.splitlines():
                    if any(name in line for name in cooc.FORBIDDEN_NAMES):
                        for bad in (".prepare(", "SELECT ", ".all(", ".get(", ".run("):
                            self.assertNotIn(bad, line,
                                             "lib/index.js 只许把禁名当写入侧文案提(%r 不该和禁名同行)" % bad)
                continue
            for name in cooc.FORBIDDEN_NAMES:
                self.assertNotIn(name, text, "lib/%s 里不该出现 %s(禁名只有孤门能提)" % (p.name, name))
        # ② 检索/渲染侧(Python)连孤门的存在都不许知道
        for rel in cooc.READ_SIDE_FILES:
            if not rel.endswith(".py"):
                continue
            text = (REPO / rel).read_text(encoding="utf-8")
            self.assertNotIn("graph-ghost", text, "%s 不该知道孤门(lib/graph-ghost.js)" % rel)

    def test_the_gate_reader_does_not_read_it(self):
        from engine import graph_gate
        src = inspect.getsource(graph_gate.build_context_from_db)
        for name in cooc.FORBIDDEN_NAMES:
            self.assertNotIn(name, src, "闸门的读侧不该读证据层")

    def test_guard_is_not_vacuous(self):
        """同一个测试里确认表名**确实**写在了该写的地方 —— 免得 grep 守卫永远全绿。"""
        for rel in ("python/engine/db.py", "python/engine/cooc.py"):
            text = (REPO / rel).read_text(encoding="utf-8")
            self.assertIn("graph_cooc_evidence", text, rel)
        self.assertIn("v_cooc_pairs", (REPO / "python/engine/cooc.py").read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()
