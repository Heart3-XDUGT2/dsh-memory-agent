# -*- coding: utf-8 -*-
"""记忆侧 L0 降级(2026-10-12 第二步)—— 对齐图侧 F11。

钉的是**判据的三条边界**与**动作的留档语义**:

  边界:`identity` 不降 · 空值不降(不猜)· 其余非空值降
  动作:只把 `layer` 置空,**不物理删、不动 `is_active`、不动 `intrinsic_value`**

⚠️ **全部在 tempfile 里建沙箱库,绝不碰活库**。
"""
import os
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]      # dsh-echo/python
sys.path.insert(0, str(ROOT))

from engine import db, episodic  # noqa: E402


def seed(conn, rows):
    """造沙箱数据:`rows` = [(summary, layer, memory_type, is_active, iv)]。"""
    ids = []
    for summary, layer, mtype, active, iv in rows:
        cur = conn.execute(
            "INSERT INTO episodic_memory"
            " (user_id, summary, layer, memory_type, is_active, intrinsic_value)"
            " VALUES ('master', ?, ?, ?, ?, ?)",
            (summary, layer, mtype, active, iv))
        ids.append(int(cur.lastrowid))
    conn.commit()
    return ids


class DemoteCriteria(unittest.TestCase):
    """三条边界。"""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.conn = db.connect(os.path.join(self.tmp.name, "t.db"))
        self.conn.commit()

    def tearDown(self):
        self.conn.close()
        self.tmp.cleanup()

    def _layer(self, mid):
        return self.conn.execute(
            "SELECT layer FROM episodic_memory WHERE memory_id=?", (mid,)).fetchone()[0]

    def test_identity_l0_is_kept(self):
        (mid,) = seed(self.conn, [("就读于西电", "L0", "identity", 1, 91.0)])
        r = episodic.demote_non_identity_l0_memories(self.conn)
        self.assertEqual(r["demoted"], 0)
        self.assertEqual(r["skipped_identity"], 1)
        self.assertEqual(self._layer(mid), "L0", "身份记忆被降了")

    def test_non_identity_l0_is_demoted(self):
        for mtype in ("preference", "interest", "note", "activity", "bogus"):
            with self.subTest(mtype=mtype):
                self.conn.execute("DELETE FROM episodic_memory")
                (mid,) = seed(self.conn, [("喜欢玩某游戏", "L0", mtype, 1, 95.0)])
                r = episodic.demote_non_identity_l0_memories(self.conn)
                self.assertEqual(r["demoted"], 1, mtype)
                self.assertEqual(self._layer(mid), "", mtype)

    def test_empty_type_is_kept_not_guessed(self):
        """老数据不猜 —— 而且盲目降空值会把唯一真身份(#280)一起降掉。"""
        (mid,) = seed(self.conn, [("老行,类型未知", "L0", "", 1, 88.0)])
        r = episodic.demote_non_identity_l0_memories(self.conn)
        self.assertEqual(r["demoted"], 0)
        self.assertEqual(r["skipped_empty"], 1)
        self.assertEqual(self._layer(mid), "L0")

    def test_null_type_is_treated_as_empty(self):
        mid = seed(self.conn, [("x", "L0", "identity", 1, 1.0)])[0]
        self.conn.execute("UPDATE episodic_memory SET memory_type=NULL WHERE memory_id=?", (mid,))
        self.conn.commit()
        r = episodic.demote_non_identity_l0_memories(self.conn)
        self.assertEqual(r["demoted"], 0)
        self.assertEqual(r["skipped_empty"], 1)

    def test_non_l0_layers_are_untouched(self):
        ids = seed(self.conn, [
            ("L1 偏好", "L1", "preference", 1, 10.0),
            ("L2 偏好", "L2", "preference", 1, 10.0),
            ("reflection 偏好", "reflection", "preference", 1, 10.0),
            ("空层偏好", "", "preference", 1, 10.0),
        ])
        r = episodic.demote_non_identity_l0_memories(self.conn)
        self.assertEqual(r["checked"], 0, "非 L0 层不该进候选")
        self.assertEqual(r["demoted"], 0)
        for mid, want in zip(ids, ("L1", "L2", "reflection", "")):
            self.assertEqual(self._layer(mid), want)

    def test_inactive_l0_is_not_a_candidate(self):
        """已退役的行不该被动 —— 它本来就不参与注入。"""
        (mid,) = seed(self.conn, [("退役的偏好", "L0", "preference", 0, 95.0)])
        r = episodic.demote_non_identity_l0_memories(self.conn)
        self.assertEqual(r["checked"], 0)
        self.assertEqual(self._layer(mid), "L0")


class DemoteAction(unittest.TestCase):
    """动作语义:保留什么、改什么。"""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.conn = db.connect(os.path.join(self.tmp.name, "t.db"))
        self.conn.commit()
        self.mid = seed(self.conn, [("喜欢玩KARDS", "L0", "preference", 1, 95.917)])[0]
        self.recall_before = self.conn.execute(
            "SELECT recall_count, half_life, last_recalled FROM episodic_memory"
            " WHERE memory_id=?", (self.mid,)).fetchone()

    def tearDown(self):
        self.conn.close()
        self.tmp.cleanup()

    def test_only_layer_changes(self):
        episodic.demote_non_identity_l0_memories(self.conn)
        row = self.conn.execute(
            "SELECT layer, is_active, intrinsic_value, recall_count, half_life,"
            " last_recalled, summary, memory_type FROM episodic_memory WHERE memory_id=?",
            (self.mid,)).fetchone()
        self.assertEqual(row[0], "", "layer 该置空")
        self.assertEqual(row[1], 1, "is_active 被动过")
        self.assertEqual(row[2], 95.917, "intrinsic_value 被动过")
        self.assertEqual((row[3], row[4], row[5]), tuple(self.recall_before), "半衰期/想起次数被动过")
        self.assertEqual(row[6], "喜欢玩KARDS", "summary 被动过")
        self.assertEqual(row[7], "preference", "memory_type 被动过")

    def test_row_is_not_deleted(self):
        episodic.demote_non_identity_l0_memories(self.conn)
        n = self.conn.execute("SELECT COUNT(*) FROM episodic_memory").fetchone()[0]
        self.assertEqual(n, 1, "行被物理删了")

    def test_idempotent(self):
        r1 = episodic.demote_non_identity_l0_memories(self.conn)
        r2 = episodic.demote_non_identity_l0_memories(self.conn)
        self.assertEqual(r1["demoted"], 1)
        self.assertEqual(r2["checked"], 0, "第二次不该再有 L0 候选")
        self.assertEqual(r2["demoted"], 0)

    def test_dry_run_writes_nothing(self):
        r = episodic.demote_non_identity_l0_memories(self.conn, dry_run=True)
        self.assertEqual(r["demoted"], 1, "dry_run 仍应报'会降几条'")
        self.assertEqual(r["ids"], [self.mid])
        got = self.conn.execute(
            "SELECT layer FROM episodic_memory WHERE memory_id=?", (self.mid,)).fetchone()[0]
        self.assertEqual(got, "L0", "dry_run 写库了")

    def test_owner_key_filters(self):
        other = self.conn.execute(
            "INSERT INTO episodic_memory (user_id, summary, layer, memory_type, is_active)"
            " VALUES ('someone','别人的偏好','L0','preference',1)").lastrowid
        self.conn.commit()
        r = episodic.demote_non_identity_l0_memories(self.conn, owner_key="master")
        self.assertEqual(r["demoted"], 1, "owner_key 没起作用")
        self.assertEqual(r["ids"], [self.mid])
        kept = self.conn.execute(
            "SELECT layer FROM episodic_memory WHERE memory_id=?", (other,)).fetchone()[0]
        self.assertEqual(kept, "L0", "别人的行被降了")


class UseSummaryIsLoud(unittest.TestCase):
    """`use_summary` 只留接口 —— 传了必须**响亮地拒绝**,不许悄悄忽略。"""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.conn = db.connect(os.path.join(self.tmp.name, "t.db"))
        self.conn.commit()

    def tearDown(self):
        self.conn.close()
        self.tmp.cleanup()

    def test_raises_not_implemented(self):
        with self.assertRaises(NotImplementedError):
            episodic.demote_non_identity_l0_memories(self.conn, use_summary=True)

    def test_raises_before_touching_anything(self):
        (mid,) = seed(self.conn, [("喜欢玩", "L0", "preference", 1, 95.0)])
        with self.assertRaises(NotImplementedError):
            episodic.demote_non_identity_l0_memories(self.conn, use_summary=True)
        got = self.conn.execute(
            "SELECT layer FROM episodic_memory WHERE memory_id=?", (mid,)).fetchone()[0]
        self.assertEqual(got, "L0", "抛之前就把库改了")

    def test_default_is_off(self):
        """不传 ⇒ 不抛(接口默认关)。"""
        r = episodic.demote_non_identity_l0_memories(self.conn)
        self.assertEqual(r["checked"], 0)


class ReturnShape(unittest.TestCase):
    def test_keys_and_counts(self):
        with tempfile.TemporaryDirectory() as d:
            conn = db.connect(os.path.join(d, "t.db"))
            conn.commit()
            ids = seed(conn, [
                ("身份", "L0", "identity", 1, 90.0),
                ("偏好", "L0", "preference", 1, 95.0),
                ("活动", "L0", "activity", 1, 93.0),
                ("老行A", "L0", "", 1, 88.0),
                ("老行B", "L0", "", 1, 86.0),
            ])
            r = episodic.demote_non_identity_l0_memories(conn)
            self.assertEqual(set(r), {"checked", "demoted", "skipped_empty",
                                      "skipped_identity", "ids"})
            self.assertEqual(r["checked"], 5, "checked = 候选总数")
            self.assertEqual(r["demoted"], 2)
            self.assertEqual(r["skipped_empty"], 2)
            self.assertEqual(r["skipped_identity"], 1)
            self.assertEqual(sorted(r["ids"]), sorted([ids[1], ids[2]]))
            self.assertEqual(r["checked"],
                             r["demoted"] + r["skipped_empty"] + r["skipped_identity"],
                             "三个计数必须把 checked 分完")
            conn.close()


if __name__ == "__main__":
    unittest.main()
