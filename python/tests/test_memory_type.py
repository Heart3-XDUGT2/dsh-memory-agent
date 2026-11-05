# -*- coding: utf-8 -*-
"""记忆表类型列(2026-10-12 第一步):接住 Judge 已经输出的 field / stability。

钉三件事:
  1. **两处 DDL 同源**(27 列,顺序一致)—— `test_ddl_parity` 只管"引擎⊇JS",
     这里额外钉"末两列是它们",免得哪天被人挪到中间去;
  2. **老库补列幂等**,且**老行留空**(`''` = 旧行为,不猜);
  3. **映射正确**:`field` → `memory_type`、`stability` → `memory_stability`,
     认不出的值一律空串(**不编**)。

⚠️ 这组测试**不碰活库**:全部在 `tempfile` 里建库。
"""
import os
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]      # dsh-echo/python
sys.path.insert(0, str(ROOT))

from engine import db, episodic, judge  # noqa: E402

REPO = Path(__file__).resolve().parents[2]
STORE_JS = REPO / "lib" / "store.js"
TYPE_COLS = ("memory_type", "memory_stability")


def js_ddl_text():
    text = STORE_JS.read_text(encoding="utf-8")
    marker = "const DDL = `"
    start = text.index(marker) + len(marker)
    return text[start:text.index("`", start)]


def cols_of(conn, table="episodic_memory"):
    return [r[1] for r in conn.execute("PRAGMA table_info(%s)" % table)]


class DdlHasTypeColumns(unittest.TestCase):
    """两处 DDL 都要有这两列,而且**排在最后**(老库补列也补在最后 ⇒ 顺序一致)。"""

    def test_js_and_engine_agree(self):
        with tempfile.TemporaryDirectory() as d:
            js = sqlite3.connect(os.path.join(d, "js.db"))
            js.executescript(js_ddl_text())
            eng = db.connect(os.path.join(d, "eng.db"))
            eng.commit()
            a, b = cols_of(js), cols_of(eng)
            self.assertEqual(len(a), len(b), "两边列数不一致")
            self.assertEqual(a[-2:], list(TYPE_COLS), "JS 侧末两列不对")
            self.assertEqual(b[-2:], list(TYPE_COLS), "引擎侧末两列不对")
            self.assertEqual([c for c in b if c in set(a)], a, "共有列顺序漂了")
            js.close()
            eng.close()

    def test_defaults_are_empty_string(self):
        """默认值必须是 `''`(不是 NULL)—— 检索侧读到 NULL 与读到 '' 行为要一致。"""
        with tempfile.TemporaryDirectory() as d:
            conn = db.connect(os.path.join(d, "t.db"))
            conn.commit()
            conn.execute("INSERT INTO episodic_memory (user_id, summary) VALUES ('m','x')")
            row = conn.execute(
                "SELECT memory_type, memory_stability FROM episodic_memory").fetchone()
            self.assertEqual(tuple(row), ("", ""))
            conn.close()


class OldDbMigration(unittest.TestCase):
    """老库(没有这两列)连上来要补列;老行留空,不猜类型。"""

    def test_adds_columns_idempotently_and_leaves_old_rows_empty(self):
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "old.db")
            # 真实老库形态 = 当前 DDL 去掉这两列(其余一模一样)
            old_ddl = js_ddl_text()
            for frag in ("    memory_type TEXT DEFAULT '',\n",
                         "    memory_stability TEXT DEFAULT ''\n"):
                old_ddl = old_ddl.replace(frag, "")
            old_ddl = old_ddl.replace("    aug_keys TEXT,\n", "    aug_keys TEXT\n")
            seed = sqlite3.connect(path)
            seed.executescript(old_ddl)
            seed.execute(
                "INSERT INTO episodic_memory (user_id, summary) VALUES ('m','老行')")
            seed.commit()
            self.assertNotIn("memory_type", cols_of(seed))
            seed.close()

            for round_no in (1, 2):      # 幂等:连两次都不该炸、不该重复加
                conn = db.connect(path)
                conn.commit()
                self.assertIn("memory_type", cols_of(conn), "第 %d 次没补上" % round_no)
                row = conn.execute(
                    "SELECT memory_type, memory_stability FROM episodic_memory"
                    " WHERE summary='老行'").fetchone()
                self.assertEqual(tuple(row), ("", ""), "老行被猜了类型")
                conn.close()


class FieldToMemoryType(unittest.TestCase):
    """`field` → `memory_type` 的映射(judge.py 的 FIELD_TO_MEMORY_TYPE)。"""

    CASES = {
        "occupation": "identity",
        "longTermInterests": "interest",
        "permanentNote": "note",
        "recentGoals": "preference",
        "recentPreferences": "preference",
        "currentProject": "activity",
    }

    def test_every_mapped_field(self):
        for field, want in self.CASES.items():
            self.assertEqual(judge.memory_type_of({"field": field}), want, field)

    def test_unmapped_or_junk_is_empty(self):
        """认不出 ⇒ 空串。**不编**:`preferredName`/`language` 进画像,不是记忆类型。"""
        for field in ("preferredName", "language", "", None, "bogus", "occupation_x"):
            self.assertEqual(judge.memory_type_of({"field": field}), "", repr(field))

    def test_not_a_dict_is_empty(self):
        for bad in (None, "occupation", 3, []):
            self.assertEqual(judge.memory_type_of(bad), "")

    def test_stability_whitelist_only(self):
        for st in ("one_off", "situational", "stable"):
            self.assertEqual(judge.memory_stability_of({"stability": st}), st)
        for st in ("bogus", "", None, "STABLE", 3):
            self.assertEqual(judge.memory_stability_of({"stability": st}), "", repr(st))

    def test_mapping_values_are_plain_lowercase(self):
        """取值要能被 `[:32]` 截断而不丢字(实测踩过 `longTermInterests` 17 字被截成 16)。"""
        for v in list(judge.FIELD_TO_MEMORY_TYPE.values()) + ["one_off", "situational", "stable"]:
            self.assertLessEqual(len(v), 32, "%s 太长会被截" % v)
            self.assertEqual(v, v.lower())


class RoundTripIntoMemoryRow(unittest.TestCase):
    """真正落库:传什么类型,读出来就是什么(截断不许丢字)。"""

    def _insert(self, conn, **kw):
        mid = episodic.insert_memory(
            conn, "master", '["k"]', "落库测试", 6, memory_key="mk1", **kw)
        return conn.execute(
            "SELECT memory_type, memory_stability FROM episodic_memory WHERE memory_id=?",
            (mid,)).fetchone()

    def test_all_types_survive_the_round_trip(self):
        with tempfile.TemporaryDirectory() as d:
            conn = db.connect(os.path.join(d, "t.db"))
            conn.commit()
            for field, want in FieldToMemoryType.CASES.items():
                conn.execute("DELETE FROM episodic_memory")
                got = self._insert(
                    conn, memory_type=judge.memory_type_of({"field": field}),
                    memory_stability="stable")
                self.assertEqual(got[0], want, "field=%s 落库丢了" % field)
                self.assertEqual(got[1], "stable")
            conn.close()

    def test_longest_real_value_is_not_truncated(self):
        """`longTermInterests` 是 17 字 —— 若截 16 会变成 `longTermInterest`。"""
        with tempfile.TemporaryDirectory() as d:
            conn = db.connect(os.path.join(d, "t.db"))
            conn.commit()
            got = self._insert(conn, memory_type="longTermInterests")
            self.assertEqual(got[0], "longTermInterests", "被截断了")
            conn.close()

    def test_default_is_empty(self):
        with tempfile.TemporaryDirectory() as d:
            conn = db.connect(os.path.join(d, "t.db"))
            conn.commit()
            self.assertEqual(tuple(self._insert(conn)), ("", ""))
            conn.close()


if __name__ == "__main__":
    unittest.main()
