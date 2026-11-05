# -*- coding: utf-8 -*-
"""她的议程簿测试(M2-b6)。

效用排序 / 48h 冷却 / 想念匹配 / persona 恒新鲜 / 用过降权写侧。
"""
import sys
import tempfile
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from engine import agenda, db  # noqa: E402
from test_worker import WorkerHarness, hello_frame  # noqa: E402

NOW = time.mktime((2026, 9, 23, 12, 0, 0, 0, 0, -1))
DAY = 86400.0


def add_item(conn, content, *, origin="reflection", weight=1.0,
             created_at=NOW, last_used_at=0):
    cur = conn.execute(
        "INSERT INTO her_agenda (content, origin, source_ids, weight,"
        " created_at, last_used_at, is_active)"
        " VALUES (?, ?, '', ?, ?, ?, 1)",
        (content, origin, weight, created_at, last_used_at))
    conn.commit()
    return int(cur.lastrowid)


class Pick(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.conn = db.connect(str(Path(self.tmp.name) / "echo.db"))

    def tearDown(self):
        self.conn.close()
        self.tmp.cleanup()

    def test_empty(self):
        item_id, content = agenda.pick(self.conn, now=NOW)
        self.assertIsNone(item_id)
        self.assertEqual(content, "")

    def test_persona_only(self):
        """persona 层:配置直读,恒新鲜 1.0;同分稳定排序取首个。"""
        item_id, content = agenda.pick(self.conn, now=NOW,
                                       interests="猫娘游戏,机器人")
        self.assertIsNone(item_id)                       # 配置侧无落库行
        self.assertEqual(content, "猫娘游戏")

    def test_db_beats_persona_when_fresh(self):
        """新鲜反思议题(weight 1.9,0 天)效用 1.9 > persona 1.0。"""
        add_item(self.conn, "他秋招准备得怎么样了", weight=1.9)
        item_id, content = agenda.pick(self.conn, now=NOW,
                                       interests="猫娘游戏")
        self.assertIsNotNone(item_id)
        self.assertEqual(content, "他秋招准备得怎么样了")

    def test_freshness_decay(self):
        """旧议题新鲜度衰减:3 天前 weight 1.9 → 1.9/4 < 1.0,persona 胜。"""
        add_item(self.conn, "他秋招准备得怎么样了",
                 weight=1.9, created_at=NOW - 3 * DAY)
        item_id, content = agenda.pick(self.conn, now=NOW,
                                       interests="猫娘游戏")
        self.assertIsNone(item_id)
        self.assertEqual(content, "猫娘游戏")

    def test_cooldown_excludes_recently_used(self):
        """48h 冷却:昨天提过的议题今天不进候选(防复读机)。"""
        add_item(self.conn, "他秋招准备得怎么样了",
                 weight=1.9, last_used_at=NOW - DAY)
        item_id, content = agenda.pick(self.conn, now=NOW)
        self.assertIsNone(item_id)
        self.assertEqual(content, "")

    def test_used_base_makes_staler(self):
        """天数从 max(created_at, last_used_at) 起算:提过又冷却完的
        议题比新议题更不新鲜 —— 别当新闻讲。"""
        old_used = add_item(self.conn, "旧议题用过冷却完了",
                            weight=1.9, created_at=NOW - 5 * DAY,
                            last_used_at=NOW - 3 * DAY)  # 天数=3 → 1.9/4
        fresh = add_item(self.conn, "新议题", weight=1.0,
                         created_at=NOW)                 # 天数=0 → 1.0
        item_id, _ = agenda.pick(self.conn, now=NOW)
        self.assertEqual(item_id, fresh)
        self.assertNotEqual(item_id, old_used)

    def test_moody_boosts_reflection(self):
        """想念匹配:委屈/依赖 ≥6 → 惦记型(reflection)×1.5。"""
        persona_like = add_item(self.conn, "想安利的新游戏",
                                origin="persona", weight=1.0)
        care = add_item(self.conn, "他最近孤单,想多陪陪他",
                        origin="reflection", weight=1.0)
        # 不委屈:同分稳定排序 → 先插入的 persona 议题胜
        item_id, _ = agenda.pick(self.conn, now=NOW)
        self.assertEqual(item_id, persona_like)
        # 委屈( sadness=6 ):惦记型 ×1.5 反超
        vec = {"target_master": {"sadness": 6.0, "dependency": 3.0}}
        item_id2, _ = agenda.pick(self.conn, vec=vec, now=NOW)
        self.assertEqual(item_id2, care)

    def test_weight_floor(self):
        """权重下限 0.2:零/坏权重不至于永远沉底。"""
        add_item(self.conn, "坏权重议题", weight=0.0)
        row = self.conn.execute(
            "SELECT weight FROM her_agenda").fetchone()
        self.assertEqual(row[0], 0.0)                    # 库里原样
        item_id, content = agenda.pick(self.conn, now=NOW)
        self.assertIsNotNone(item_id)                    # 仍可被选中
        self.assertEqual(content, "坏权重议题")


class MarkUsed(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.conn = db.connect(str(Path(self.tmp.name) / "echo.db"))
        self.item_id = add_item(self.conn, "他秋招准备得怎么样了")

    def tearDown(self):
        self.conn.close()
        self.tmp.cleanup()

    def test_mark_then_cooldown(self):
        self.assertTrue(agenda.mark_used(self.conn, self.item_id, now=NOW))
        row = self.conn.execute(
            "SELECT last_used_at FROM her_agenda WHERE item_id = ?",
            (self.item_id,)).fetchone()
        self.assertEqual(row[0], NOW)
        # 用过 → 冷却内不可再选
        item_id, _ = agenda.pick(self.conn, now=NOW)
        self.assertIsNone(item_id)
        # 两天后冷却结束,但新鲜度已衰减(天数从 last_used_at 起算)
        item_id2, content = agenda.pick(self.conn, now=NOW + 49 * 3600)
        self.assertEqual(item_id2, self.item_id)
        self.assertEqual(content, "他秋招准备得怎么样了")

    def test_mark_none_is_noop(self):
        """persona 议题无 item_id —— 发送成功后调 mark(None) 是安全空操作。"""
        self.assertFalse(agenda.mark_used(self.conn, None, now=NOW))

    def test_mark_inactive_ignored(self):
        self.conn.execute(
            "UPDATE her_agenda SET is_active = 0 WHERE item_id = ?",
            (self.item_id,))
        self.conn.commit()
        self.assertTrue(agenda.mark_used(self.conn, self.item_id, now=NOW))
        row = self.conn.execute(
            "SELECT last_used_at FROM her_agenda WHERE item_id = ?",
            (self.item_id,)).fetchone()
        self.assertEqual(row[0], 0)                      # 未动


class WireRoundTrip(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.db = str(Path(self.tmp.name) / "echo.db")
        db.connect(self.db).close()
        self.w = WorkerHarness()
        self.assertEqual(self.w.roundtrip(hello_frame(db_path=self.db))["type"], "ready")
        conn = db.connect(self.db)
        cur = conn.execute(
            "INSERT INTO her_agenda (content, origin, source_ids, weight,"
            " created_at, last_used_at, is_active)"
            " VALUES ('他在忙开学的事', 'reflection', '记忆1', 1.9, ?, 0, 1)",
            (NOW,))
        self.item_id = int(cur.lastrowid)
        conn.commit()
        conn.close()

    def tearDown(self):
        self.w.close()
        self.tmp.cleanup()

    def test_pick_mark_cycle(self):
        p = self.w.roundtrip({"reqId": 1, "type": "agenda_pick",
                              "now": NOW, "interests": "猫娘游戏"})
        self.assertEqual(p["type"], "agenda_pick_result")
        self.assertEqual(p["itemId"], self.item_id)      # 1.9 > persona 1.0
        self.assertEqual(p["content"], "他在忙开学的事")
        # 发送成功才算用过 → mark
        m = self.w.roundtrip({"reqId": 2, "type": "agenda_mark",
                              "itemId": self.item_id, "now": NOW})
        self.assertEqual(m["type"], "agenda_mark_result")
        self.assertTrue(m["ok"])
        # 冷却内:只剩 persona 议题
        p2 = self.w.roundtrip({"reqId": 3, "type": "agenda_pick",
                               "now": NOW, "interests": "猫娘游戏"})
        self.assertIsNone(p2["itemId"])
        self.assertEqual(p2["content"], "猫娘游戏")

    def test_mark_missing_item_rejected(self):
        r = self.w.roundtrip({"reqId": 1, "type": "agenda_mark"})
        self.assertEqual(r["type"], "error")


if __name__ == "__main__":
    unittest.main()
