# -*- coding: utf-8 -*-
"""F4:整固/换代时幸存者必须继承 `layer` 与 `intrinsic_value`。

现场(2026-09-27 取证):
* `layer='reflection'` 共 92 条,**92 条 iv=0(100%)**,41 条 hl=0。
  根因:`reflection.py` 的 INSERT 硬编码 `layer='reflection'`,列清单里
  根本没有 intrinsic_value / half_life ⇒ 走 DDL 默认(0/0)。
  而 `:216` 的 merge 分支正是把 **L0 源**退役进这一行 ⇒ L0 层被系统性
  抽干,只剩 #125(风又音理)一条,而 L0 是每轮强制注入的。
* 幸存者 `#169`/`#171` 是 layer='reflection' 且 iv=0.0。
"""

import os
import sqlite3
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from engine import db as dbmod      # noqa: E402
from engine import episodic         # noqa: E402


def _read(*parts):
    with open(os.path.join(os.path.dirname(__file__), *parts), encoding="utf-8") as fh:
        return fh.read()


class SlotSuccessionInheritsTest(unittest.TestCase):
    """槽位换代(同 memory_key)不许把身份记忆降级成碎片。"""

    def setUp(self):
        self.conn = dbmod.connect(os.path.join(tempfile.mkdtemp(), "t.db"))

    def tearDown(self):
        self.conn.close()

    def test_inherits_l0_when_caller_gives_no_layer(self):
        old = episodic.insert_memory(
            self.conn, "master", "[]",
            "阿岚喜欢吃章鱼小丸子。", 9, now=100.0,
            memory_key="food", layer="L0", intrinsic_value=95.0)
        new = episodic.insert_memory(
            self.conn, "master", "[]",
            "阿岚还是喜欢吃章鱼小丸子，只是现在会自己做。", 9, now=200.0,
            memory_key="food", layer="", intrinsic_value=0.0)
        self.conn.commit()

        row = self.conn.execute(
            "SELECT layer, intrinsic_value FROM episodic_memory WHERE memory_id = ?",
            (new,)).fetchone()
        self.assertEqual(row[0], "L0", "换代把 L0 丢了 —— L0 层会被抽干")
        self.assertGreaterEqual(float(row[1]), 95.0, "换代把 I 降级了")

    def test_explicit_layer_still_wins(self):
        """调用方明确指定了层(真的降级)时不许被继承覆盖。"""
        old = episodic.insert_memory(
            self.conn, "master", "[]", "阿岚喜欢吃章鱼小丸子。", 9, now=100.0,
            memory_key="food", layer="L0", intrinsic_value=95.0)
        new = episodic.insert_memory(
            self.conn, "master", "[]", "阿岚现在不太吃章鱼小丸子了。", 9, now=200.0,
            memory_key="food", layer="L2", intrinsic_value=40.0)
        self.conn.commit()
        self.assertNotEqual(old, new)
        self.assertEqual(self.conn.execute(
            "SELECT layer FROM episodic_memory WHERE memory_id = ?",
            (new,)).fetchone()[0], "L2", "显式指定的层不该被继承覆盖")
        # 但 I 仍取最大(不许把值往下压)
        self.assertGreaterEqual(self.conn.execute(
            "SELECT intrinsic_value FROM episodic_memory WHERE memory_id = ?",
            (new,)).fetchone()[0], 95.0)

    def test_half_life_follows_inherited_i(self):
        """继承来的 I 更大时,半衰期要跟着走 —— 否则"记得更牢"只是名义上的。"""
        episodic.insert_memory(
            self.conn, "master", "[]", "用户是大学生。", 1, now=100.0,
            memory_key="edu", layer="L0", intrinsic_value=95.0)
        new = episodic.insert_memory(
            self.conn, "master", "[]", "用户是大学生，新工科的。", 1, now=200.0,
            memory_key="edu", layer="", intrinsic_value=0.0)
        self.conn.commit()
        hl = float(self.conn.execute(
            "SELECT half_life FROM episodic_memory WHERE memory_id = ?",
            (new,)).fetchone()[0])
        self.assertGreater(hl, 0.0, "half_life=0 ⇒ 这条记忆的 R 恒为 0,检索永远吃不到")


class ReflectionInsertTest(unittest.TestCase):
    """reflection 的整固写入不许写残废行(iv=0 / hl=0),merge 要继承 L0。"""

    def test_insert_sets_iv_and_half_life(self):
        src = _read("..", "engine", "reflection.py")
        # 列清单里必须有 intrinsic_value / half_life
        block = src[src.index("INSERT INTO episodic_memory (user_id, keywords, summary,"):]
        block = block[:block.index(")")]
        self.assertIn("intrinsic_value", block,
                      "reflection INSERT 漏了 intrinsic_value ⇒ 写出来全是 iv=0")
        self.assertIn("half_life", block,
                      "reflection INSERT 漏了 half_life ⇒ hl=0 让 R 恒为 0")
        self.assertIn("last_recalled", block)
        self.assertIn("learned_at", block)

    def test_merge_inherits_l0(self):
        src = _read("..", "engine", "reflection.py")
        self.assertIn('new_layer = "L0" if (kind == "merge" and any_l0) else "reflection"',
                      src, "merge 退役 L0 源却不让幸存者继承 L0 ⇒ L0 层被抽干")
        self.assertIn("src_iv", src)

    def test_merge_retires_l0_sources_into_an_l0_survivor(self):
        """端到端:两条 L0 源合并 ⇒ 幸存者仍是 L0,I 没丢,引用可解析。"""
        from engine import reflection as refl
        conn = dbmod.connect(os.path.join(tempfile.mkdtemp(), "t2.db"))
        try:
            a = episodic.insert_memory(
                conn, "master", "[]", "用户是西安电子科技大学学生。", 9, now=100.0,
                layer="L0", intrinsic_value=95.9)
            b = episodic.insert_memory(
                conn, "master", "[]", "用户就读于西电。", 9, now=101.0,
                layer="L0", intrinsic_value=93.5)
            conn.commit()
            summary = "用户是西电的学生,新工科大类的。"   # ≤80 字
            out = refl.commit(
                conn, "master",
                [{"kind": "merge", "summary": summary, "evidence_ids": [a, b]}],
                {"candidateIds": [a, b], "candidateScores": {a: 9, b: 9},
                 "lastMemoryId": b},
                now=200.0)
            self.assertEqual(out["written"], 1, "整固没落库: %r" % (out,))
            self.assertEqual(out["merged"], 2, "两条 L0 源该被退役")

            surv = conn.execute(
                "SELECT memory_id, layer, intrinsic_value, half_life FROM episodic_memory"
                " WHERE layer = 'L0' AND is_active = 1 AND memory_id NOT IN (?, ?)",
                (a, b)).fetchall()
            self.assertEqual(len(surv), 1, "没有产生 L0 幸存者(L0 层正在被抽干)")
            self.assertGreaterEqual(float(surv[0][2]), 93.5, "幸存者丢了 I")
            self.assertGreater(float(surv[0][3]), 0.0, "幸存者 half_life=0 ⇒ R 恒为 0")
            for mid in (a, b):
                r = conn.execute(
                    "SELECT is_active, superseded_by FROM episodic_memory WHERE memory_id = ?",
                    (mid,)).fetchone()
                self.assertEqual(r[0], 0, "L0 源该被退役")
                self.assertEqual(r[1], surv[0][0], "引用该指向真实幸存者")

            # 反证:旧行为下幸存者会是 layer='reflection' 且 iv=0
            self.assertNotEqual(
                conn.execute("SELECT layer FROM episodic_memory WHERE memory_id = ?",
                             (surv[0][0],)).fetchone()[0], "reflection")
        finally:
            conn.close()

    def test_insight_does_not_steal_l0(self):
        """insight 是新推理不是替代品 —— 不许把别人的 L0 层抢过来。"""
        from engine import reflection as refl
        conn = dbmod.connect(os.path.join(tempfile.mkdtemp(), "t3.db"))
        try:
            a = episodic.insert_memory(
                conn, "master", "[]", "用户是大学生。", 9, now=100.0,
                layer="L0", intrinsic_value=95.0)
            conn.commit()
            out = refl.commit(
                conn, "master",
                [{"kind": "insight", "summary": "他大概不太喜欢被反复问同一件事。",
                  "evidence_ids": [a]}],
                {"candidateIds": [a], "candidateScores": {a: 9}, "lastMemoryId": a},
                now=200.0)
            self.assertEqual(out["written"], 1)
            new = conn.execute(
                "SELECT layer FROM episodic_memory WHERE source = 'reflection'"
                " ORDER BY memory_id DESC LIMIT 1").fetchone()
            self.assertEqual(new[0], "reflection", "insight 不该变成 L0")
            # 但 I 与 hl 要有真值(这次修的主要是"残废写入")
            r = conn.execute(
                "SELECT intrinsic_value, half_life FROM episodic_memory"
                " WHERE source = 'reflection' ORDER BY memory_id DESC LIMIT 1").fetchone()
            self.assertGreater(float(r[0]), 0.0, "仍在写 iv=0 的残废行")
            self.assertGreater(float(r[1]), 0.0, "仍在写 hl=0 的残废行")
            # insight 不退役源
            self.assertEqual(conn.execute(
                "SELECT is_active FROM episodic_memory WHERE memory_id = ?",
                (a,)).fetchone()[0], 1)
        finally:
            conn.close()


class StoreBaselineTest(unittest.TestCase):
    """JS 基线的换代也要继承层与 I。"""

    def test_store_insert_inherits(self):
        src = _read("..", "..", "lib", "store.js")
        self.assertIn("prevLayer", src)
        self.assertIn("prevIv", src)
        self.assertIn("inheritLayer", src)
        # prev 查询要把这两列取出来
        seg = src[src.index("SELECT memory_id, summary, half_life, last_recalled, layer, intrinsic_value"):]
        self.assertTrue(seg.startswith("SELECT memory_id, summary, half_life, last_recalled, layer"),
                        "store.js 的槽位查询没取 layer/intrinsic_value")


if __name__ == "__main__":
    unittest.main()
