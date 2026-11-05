# -*- coding: utf-8 -*-
"""引用完整性(F1/F2/F3)—— superseded_by 链的写入校验、硬删保护、悬空修复。

现场(2026-09-27 取证):全库 50 行有 superseded_by,16 行指向不存在的记忆;
根因是两个 A 侧导入器原样照抄 A 侧 id(AUTOINCREMENT 序列只增不减,
sqlite_sequence=256 而引用值到了 445 ⇒ 那些 id 在本表从未存在)。
"""

import os
import re
import sqlite3
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from engine import db as dbmod          # noqa: E402
from engine import episodic             # noqa: E402
from engine import integrity            # noqa: E402
from engine import reflection           # noqa: E402


def _read(*parts):
    with open(os.path.join(os.path.dirname(__file__), *parts), encoding="utf-8") as fh:
        return fh.read()


def _fresh():
    path = os.path.join(tempfile.mkdtemp(), "t.db")
    return dbmod.connect(path)


class TargetOkTest(unittest.TestCase):
    def setUp(self):
        self.conn = _fresh()

    def tearDown(self):
        self.conn.close()

    def test_zero_and_empty_mean_no_reference(self):
        """0 / '' / None 一律表示"没有引用" —— 不是"指向 0 号行"。"""
        for v in (0, "0", "", None):
            self.assertFalse(integrity.target_ok(
                self.conn, "episodic_memory", "memory_id", v),
                "%r 该被当作没有引用" % (v,))

    def test_existing_row_resolves(self):
        mid = episodic.insert_memory(
            self.conn, "master", "[]", "用户就读于西安电子科技大学。", 9,
            now=1000.0)
        self.assertTrue(integrity.target_ok(
            self.conn, "episodic_memory", "memory_id", mid))

    def test_missing_table_is_not_fatal(self):
        """引擎自建库里没有图侧某些表 —— 判定要保守返回 False,不许炸。"""
        self.assertFalse(integrity.target_ok(
            self.conn, "no_such_table", "id", 1))


class MarkSupersededTest(unittest.TestCase):
    """F1:引用写不进去时,宁可不写,也不许写一条解析不到的。"""

    def setUp(self):
        self.conn = _fresh()

    def tearDown(self):
        self.conn.close()

    def _mk(self, summary, key="", layer="", status="active"):
        return episodic.insert_memory(
            self.conn, "master", "[]", summary, 5, now=1000.0,
            memory_key=key, layer=layer, status=status)

    def test_valid_target_writes_reference(self):
        old = self._mk("用户是大学生。")
        new = self._mk("用户是大学生，就读于一所新工科大学。")
        n = integrity.mark_superseded(
            self.conn, "episodic_memory", "memory_id", new,
            "memory_id = ?", (old,))
        self.conn.commit()
        self.assertEqual(n, 1)
        row = self.conn.execute(
            "SELECT is_active, superseded_by FROM episodic_memory WHERE memory_id = ?",
            (old,)).fetchone()
        self.assertEqual(row[0], 0, "留档了")
        self.assertEqual(row[1], new, "引用指向真实的新行")

    def test_dangling_target_still_archives_but_no_reference(self):
        """★ 现场 bug 的核心:目标解析不到时,**只留档、不编造引用**。"""
        old = self._mk("用户当前在大学就读，学校是一所新工科大学。")
        ghost = 431                      # A 侧迁移残留那种:本表根本没有这一行
        self.assertFalse(integrity.target_ok(
            self.conn, "episodic_memory", "memory_id", ghost))
        n = integrity.mark_superseded(
            self.conn, "episodic_memory", "memory_id", ghost,
            "memory_id = ?", (old,))
        self.conn.commit()
        self.assertEqual(n, 1, "留档照做 —— 退役语义不变")
        row = self.conn.execute(
            "SELECT is_active, superseded_by FROM episodic_memory WHERE memory_id = ?",
            (old,)).fetchone()
        self.assertEqual(row[0], 0)
        self.assertFalse(
            row[1] and int(row[1]) != 0,
            "不许写悬空引用(拿到 %r)" % (row[1],))

    def test_reflection_merge_uses_the_guard(self):
        """reflection 的 merge 退役点也要走守卫(不能只改 episodic)。"""
        src = _read("..", "engine", "reflection.py")
        self.assertIn("integrity.mark_superseded", src,
                      "reflection.py 的 merge 退役点没走 F1 守卫")
        self.assertNotIn('"UPDATE episodic_memory SET is_active = 0,"\n'
                         '                " superseded_by = ?"', src)


class HardDeleteGuardTest(unittest.TestCase):
    """F2:3×TTL 硬删不许把别人还指着的行删掉。"""

    def setUp(self):
        self.conn = _fresh()

    def tearDown(self):
        self.conn.close()

    def test_referenced_rows_survive_hard_delete(self):
        """★ 真实危险场景:幸存者**后来又被人取代**,于是自己也变成 is_active=0,
        然后可能被 3×TTL 硬删 —— 而最早那条还指着它。删了就把留档链变成悬空。"""
        a = episodic.insert_memory(                       # 最早:指向 b
            self.conn, "master", "[]", "用户是大学生。", 1, now=100.0)
        b = episodic.insert_memory(                       # 幸存者:后来又被 c 取代
            self.conn, "master", "[]", "用户是大学生，就读于一所新工科大学。", 9,
            now=101.0)
        c = episodic.insert_memory(                       # 现役
            self.conn, "master", "[]", "用户是新工科大学大一学生。", 9, now=9000.0)
        integrity.mark_superseded(
            self.conn, "episodic_memory", "memory_id", b, "memory_id = ?", (a,))
        integrity.mark_superseded(
            self.conn, "episodic_memory", "memory_id", c, "memory_id = ?", (b,))
        self.conn.commit()

        episodic.cleanup_stale(self.conn, "master", 1, now=2_000_000.0)

        ids = {r[0] for r in self.conn.execute(
            "SELECT memory_id FROM episodic_memory")}
        self.assertIn(b, ids, "b 还被 a 指着,硬删它 ⇒ 留档链变悬空")
        self.assertIn(c, ids, "c 被 b 指着,同样不许删")
        self.assertNotIn(a, ids, "没人指向 a,它就该被硬删(库不许无界增长)")
        self.assertTrue(integrity.target_ok(
            self.conn, "episodic_memory", "memory_id", b),
            "a 的引用必须仍然解析得到")

    def test_referenced_ids_lists_targets(self):
        a = episodic.insert_memory(
            self.conn, "master", "[]", "用户是大学生。", 1, now=100.0)
        b = episodic.insert_memory(
            self.conn, "master", "[]", "用户是大学生，新工科的。", 9, now=200.0)
        integrity.mark_superseded(
            self.conn, "episodic_memory", "memory_id", b, "memory_id = ?", (a,))
        self.conn.commit()
        self.assertEqual(
            integrity.referenced_ids(self.conn, "episodic_memory", "memory_id"),
            {str(b)})


class RepairTest(unittest.TestCase):
    """F3:幂等修复 —— 把指向空气的引用清成 0。"""

    def setUp(self):
        self.conn = _fresh()

    def tearDown(self):
        self.conn.close()

    def test_repair_clears_ghost_references(self):
        a = episodic.insert_memory(
            self.conn, "master", "[]", "用户就读于西安电子科技大学（西电）。", 9,
            now=100.0)
        # 手工造一条悬空引用(模拟 A 侧迁移照抄)
        self.conn.execute(
            "UPDATE episodic_memory SET is_active = 0, superseded_by = 411"
            " WHERE memory_id = ?", (a,))
        self.conn.commit()

        fixed = integrity.repair_dangling_superseded(
            self.conn, "episodic_memory", "memory_id")
        self.assertEqual(fixed, 1)
        self.assertEqual(
            self.conn.execute(
                "SELECT superseded_by FROM episodic_memory WHERE memory_id = ?",
                (a,)).fetchone()[0], 0)
        # 幂等:再跑一次什么都不改
        self.assertEqual(integrity.repair_dangling_superseded(
            self.conn, "episodic_memory", "memory_id"), 0)
        # 只清引用,不动 is_active(复活那 16 条 L0 是另一件事)
        self.assertEqual(self.conn.execute(
            "SELECT is_active FROM episodic_memory WHERE memory_id = ?",
            (a,)).fetchone()[0], 0, "修复不许偷偷复活留档行")

    def test_repair_keeps_valid_references(self):
        a = episodic.insert_memory(
            self.conn, "master", "[]", "用户是大学生。", 1, now=100.0)
        b = episodic.insert_memory(
            self.conn, "master", "[]", "用户是大学生，新工科的。", 9, now=200.0)
        integrity.mark_superseded(
            self.conn, "episodic_memory", "memory_id", b, "memory_id = ?", (a,))
        self.conn.commit()
        self.assertEqual(integrity.repair_dangling_superseded(
            self.conn, "episodic_memory", "memory_id"), 0)
        self.assertEqual(self.conn.execute(
            "SELECT superseded_by FROM episodic_memory WHERE memory_id = ?",
            (a,)).fetchone()[0], b, "合法引用不许被清掉")

    def test_connect_runs_the_repair(self):
        """修复必须挂在 connect 上(走插件代码路径,不靠手改库)。"""
        src = _read("..", "engine", "db.py")
        self.assertIn("_repair_dangling_superseded(conn)", src)

        path = os.path.join(tempfile.mkdtemp(), "t2.db")
        conn = dbmod.connect(path)
        mid = episodic.insert_memory(
            conn, "master", "[]", "用户是大学生。", 1, now=100.0)
        conn.execute("UPDATE episodic_memory SET superseded_by = 445"
                     " WHERE memory_id = ?", (mid,))
        conn.commit()
        conn.close()
        conn = dbmod.connect(path)   # 重新连一次 = 启动
        self.assertEqual(conn.execute(
            "SELECT superseded_by FROM episodic_memory WHERE memory_id = ?",
            (mid,)).fetchone()[0], 0, "connect 没跑修复")
        conn.close()


class ImporterRemapTest(unittest.TestCase):
    """导入器不许原样照抄 A 侧 id —— 这两个文件正是悬空引用的写者。"""

    def _src(self, name):
        return _read("..", "..", "scripts", name)

    def test_import_astrbot_remaps(self):
        src = self._src("import-astrbot.mjs")
        self.assertIn("idMap", src)
        self.assertIn("pendingRefs", src)
        # 不许再把 A 的 superseded_by 直接当值塞进 INSERT
        self.assertNotIn("Math.round(Number(r.superseded_by) || 0),", src)

    def test_merge_astrbot_remaps(self):
        src = self._src("merge-astrbot.mjs")
        self.assertIn("memIdMap", src)
        self.assertIn("memRefPending", src)
        self.assertNotIn(
            "Math.round(Number(pick(r, srcMemCols, 'superseded_by', 0)) || 0),", src)


if __name__ == "__main__":
    unittest.main()
