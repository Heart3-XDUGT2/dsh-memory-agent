# -*- coding: utf-8 -*-
"""Reflection 整固测试(M2-b5)。

防失真三件套逐条验证 + 游标语义 + merge 只退役 L0 + 议程簿供给。
"""
import sys
import tempfile
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from engine import db, reflection  # noqa: E402
from test_worker import WorkerHarness, hello_frame  # noqa: E402

# 固定时钟:2026-09-23 12:00(白天,避开夜间窗口,触发只走重要性阈值)
NOW = time.mktime((2026, 9, 23, 12, 0, 0, 0, 0, -1))
NIGHT = time.mktime((2026, 9, 24, 2, 0, 0, 0, 0, -1))  # 凌晨 2 点


def seed_memories(conn, n, score=10, layer="", start_id=None):
    """插入 n 条普通记忆,返回 memory_id 列表。"""
    ids = []
    for i in range(n):
        cur = conn.execute(
            "INSERT INTO episodic_memory (user_id, keywords, summary,"
            " emotion_score, timestamp, is_active, layer)"
            " VALUES (?, ?, ?, ?, ?, 1, ?)",
            ("master", '["k%d"]' % i, "他做了第%d件事" % i,
             score, NOW - i, layer or ""))
        ids.append(int(cur.lastrowid))
    conn.commit()
    return ids


class TriggerCheck(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.conn = db.connect(str(Path(self.tmp.name) / "echo.db"))

    def tearDown(self):
        self.conn.close()
        self.tmp.cleanup()

    def test_no_candidates(self):
        r = reflection.check(self.conn, "master", now=NOW)
        self.assertFalse(r["triggered"])
        self.assertEqual(r["reason"], "no_candidates")

    def test_below_threshold(self):
        seed_memories(self.conn, 2, score=10)  # importance=20 < 30
        r = reflection.check(self.conn, "master", now=NOW)
        self.assertFalse(r["triggered"])
        self.assertEqual(r["reason"], "below_threshold")
        self.assertEqual(r["importance"], 20)

    def test_importance_trigger(self):
        ids = seed_memories(self.conn, 3, score=10)  # importance=30 ≥ 30
        r = reflection.check(self.conn, "master", now=NOW)
        self.assertTrue(r["triggered"])
        self.assertEqual(r["candidateIds"], ids)
        self.assertEqual(r["lastMemoryId"], ids[-1])
        self.assertIn("记忆整固模块", r["systemPrompt"])
        self.assertIn("#%d|普通|情感10|他做了第0件事" % ids[0], r["userPrompt"])
        self.assertFalse(r["night"])

    def test_night_window(self):
        """夜间窗口:阈值不够但凌晨 + 距上次整固>12h → 触发。"""
        seed_memories(self.conn, 1, score=5)  # importance=5 < 30
        r = reflection.check(self.conn, "master", now=NIGHT)
        self.assertTrue(r["triggered"])
        self.assertTrue(r["night"])
        # 夜间但距上次整固 <12h → 不触发
        self.conn.execute(
            "INSERT INTO reflection_state (user_id, last_memory_id, last_at)"
            " VALUES ('master', 0, ?)", (NIGHT - 3600,))
        self.conn.commit()
        r2 = reflection.check(self.conn, "master", now=NIGHT)
        self.assertFalse(r2["triggered"])

    def test_reflection_rows_excluded(self):
        """防失真①:反思行不进下轮候选(递归深度=1)。"""
        seed_memories(self.conn, 3, score=10)  # importance=30 触发
        self.conn.execute(
            "INSERT INTO episodic_memory (user_id, keywords, summary,"
            " emotion_score, timestamp, is_active, layer)"
            " VALUES ('master', 'x', '反思产物', 10, ?, 1, 'reflection')",
            (NOW,))
        self.conn.commit()
        r = reflection.check(self.conn, "master", now=NOW)
        self.assertTrue(r["triggered"])
        self.assertNotIn("反思产物", r["userPrompt"])
        self.assertEqual(len(r["candidateIds"]), 3)     # 反思行不在窗口里


class CommitGuards(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.conn = db.connect(str(Path(self.tmp.name) / "echo.db"))
        self.ids = seed_memories(self.conn, 3, score=10)  # importance=30
        self.round = reflection.check(self.conn, "master", now=NOW)
        self.assertTrue(self.round["triggered"])

    def tearDown(self):
        self.conn.close()
        self.tmp.cleanup()

    def _commit(self, items):
        return reflection.commit(self.conn, "master", items, self.round, now=NOW)

    def test_full_write(self):
        ack = self._commit([
            {"kind": "insight", "summary": "他在忙开学的事",
             "evidence_ids": self.ids, "keywords": "开学,忙", "ongoing": True},
        ])
        self.assertEqual(ack["written"], 1)
        self.assertEqual(ack["agenda"], 1)
        self.assertTrue(ack["cursorAdvanced"])
        self.assertEqual(ack["cursor"], self.ids[-1])
        row = self.conn.execute(
            "SELECT keywords, summary, emotion_score, source, layer, evidence"
            " FROM episodic_memory WHERE layer = 'reflection'").fetchone()
        self.assertEqual(row[0], "开学,忙")           # keywords 原样字符串
        self.assertEqual(row[1], "他在忙开学的事")
        self.assertEqual(row[2], 10)                   # 源条目最高情感分
        self.assertEqual(row[3], "reflection")
        self.assertEqual(row[5], "依据:记忆%d、%d、%d" % tuple(self.ids))
        ag = self.conn.execute(
            "SELECT content, origin, weight FROM her_agenda").fetchone()
        self.assertEqual(ag[0], "他在忙开学的事")
        self.assertEqual(ag[1], "reflection")
        self.assertAlmostEqual(ag[2], 1.0 + 0.1 * 10)  # 2.0

    def test_guards(self):
        """防失真②③:坏 kind / 超长 / 无证据 / 证据不在候选集 → 丢弃。"""
        ack = self._commit([
            {"kind": "predict", "summary": "他明天会赢",
             "evidence_ids": self.ids},                 # 坏 kind
            {"kind": "insight", "summary": "长" * 81,
             "evidence_ids": self.ids},                 # 超长(守卫 80)
            {"kind": "insight", "summary": "没证据的认识",
             "evidence_ids": []},                       # 空证据
            {"kind": "insight", "summary": "编造证据",
             "evidence_ids": [99999]},                  # 证据不在候选集
            {"kind": "insight", "summary": "部分有效证据",
             "evidence_ids": [self.ids[0], 99999]},     # 过滤后仍非空 → 写
        ])
        self.assertEqual(ack["written"], 1)             # 只有最后一条活下来
        self.assertEqual(len(ack["dropped"]), 4)
        # 游标照推(items 非空,噪声跳过是刻意的)
        self.assertTrue(ack["cursorAdvanced"])
        row = self.conn.execute(
            "SELECT summary, evidence FROM episodic_memory"
            " WHERE layer = 'reflection'").fetchone()
        self.assertEqual(row[0], "部分有效证据")
        self.assertEqual(row[1], "依据:记忆%d" % self.ids[0])

    def test_same_text_dedup(self):
        """防失真③:与既有反思行同文 → 不重复落。"""
        # 第一轮:写入 + 推游标
        round1 = reflection.check(self.conn, "master", now=NOW)
        reflection.commit(self.conn, "master", [
            {"kind": "insight", "summary": "他在忙开学的事",
             "evidence_ids": round1["candidateIds"]},
        ], round1, now=NOW)
        # 第二轮:新窗口里再产出同文 → 同文去重(证据用本轮窗口的 id)
        seed_memories(self.conn, 3, score=10)
        round2 = reflection.check(self.conn, "master", now=NOW)
        self.assertTrue(round2["triggered"])
        ack2 = reflection.commit(self.conn, "master", [
            {"kind": "insight", "summary": "他在忙开学的事",
             "evidence_ids": round2["candidateIds"]},
        ], round2, now=NOW)
        self.assertEqual(ack2["written"], 0)
        self.assertEqual(ack2["dropped"][0]["reason"], "同文去重")

    def test_merge_retires_only_l0(self):
        """merge 只退役 L0 源 —— 普通层各有独立证据,合并会丢语境。"""
        self.conn.execute(
            "UPDATE episodic_memory SET layer = 'L0' WHERE memory_id = ?",
            (self.ids[0],))
        self.conn.commit()
        ack = self._commit([
            {"kind": "merge", "summary": "他做了几件开学相关的事",
             "evidence_ids": self.ids},
        ])
        self.assertEqual(ack["written"], 1)
        self.assertEqual(ack["merged"], 1)
        rows = self.conn.execute(
            "SELECT memory_id, is_active, superseded_by FROM episodic_memory"
            " WHERE memory_id IN (%s) ORDER BY memory_id"
            % ",".join(str(i) for i in self.ids)).fetchall()
        self.assertEqual(rows[0][1], 0)                 # L0 源退役
        self.assertEqual(rows[1][1], 1)                 # 普通层不动
        self.assertEqual(rows[2][1], 1)
        # F4(2026-09-27):合并退役了 L0 源 ⇒ 幸存者必须**继承 L0**,且不许丢 I。
        # 这里原来断言 `layer='reflection'` —— 那条断言本身就是把 L0 层抽干的
        # 规则(实测:`layer='reflection'` 92 条全部 iv=0,L0 只剩 #125 一条)。
        new = self.conn.execute(
            "SELECT memory_id, layer, intrinsic_value, half_life"
            " FROM episodic_memory WHERE source = 'reflection'"
            " ORDER BY memory_id DESC LIMIT 1"
        ).fetchone()
        self.assertEqual(new[1], "L0", "退役 L0 源却不继承 L0 ⇒ L0 层被抽干")
        self.assertGreater(float(new[2]), 0.0, "幸存者丢了内在价值(iv=0)")
        self.assertGreater(float(new[3]), 0.0, "幸存者 half_life=0 ⇒ R 恒为 0")
        self.assertEqual(rows[0][2], new[0])            # superseded_by 回填

    def test_empty_items_cursor_stays(self):
        """游标语义:items 空 → 不推进,下轮重试同一窗口。"""
        ack = self._commit([])
        self.assertFalse(ack["cursorAdvanced"])
        self.assertEqual(ack["written"], 0)
        r = reflection.check(self.conn, "master", now=NOW)
        self.assertTrue(r["triggered"])
        self.assertEqual(r["candidateIds"], self.ids)   # 窗口原样


class WireRoundTrip(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.db = str(Path(self.tmp.name) / "echo.db")
        db.connect(self.db).close()
        self.w = WorkerHarness()
        self.assertEqual(self.w.roundtrip(hello_frame(db_path=self.db))["type"], "ready")
        conn = db.connect(self.db)
        for i in range(3):
            conn.execute(
                "INSERT INTO episodic_memory (user_id, keywords, summary,"
                " emotion_score, timestamp, is_active)"
                " VALUES ('master', ?, ?, 10, ?, 1)",
                ('["k%d"]' % i, "他做了第%d件事" % i, NOW - i))
        conn.commit()
        conn.close()

    def tearDown(self):
        self.w.close()
        self.tmp.cleanup()

    def test_full_cycle(self):
        p = self.w.roundtrip({"reqId": 1, "type": "reflection_prompt",
                              "userId": "master", "now": NOW})
        self.assertEqual(p["type"], "reflection_prompt_result")
        self.assertTrue(p["triggered"])
        self.assertEqual(len(p["candidateIds"]), 3)
        self.assertNotIn("candidateScores", p)          # 内部状态不上线
        c = self.w.roundtrip({"reqId": 2, "type": "reflection_commit",
                              "userId": "master", "now": NOW,
                              "items": [{"kind": "insight",
                                         "summary": "他最近在忙开学准备",
                                         "evidence_ids": p["candidateIds"],
                                         "ongoing": True}]})
        self.assertEqual(c["type"], "reflection_commit_result")
        self.assertEqual(c["written"], 1)
        self.assertEqual(c["agenda"], 1)
        # 游标推进后:下轮无候选
        p2 = self.w.roundtrip({"reqId": 3, "type": "reflection_prompt",
                               "userId": "master", "now": NOW})
        self.assertFalse(p2["triggered"])
        self.assertEqual(p2["reason"], "no_candidates")
        # b3 检索闭环:反思行可被检回(它是情景库的一员)
        q = self.w.roundtrip({"reqId": 4, "type": "retrieve",
                              "userId": "master", "query": "开学准备",
                              "topK": 6, "now": NOW})
        self.assertTrue(any("他最近在忙开学准备" in it["summary"]
                            for it in q["items"]))

    def test_commit_without_prompt_rejected(self):
        r = self.w.roundtrip({"reqId": 1, "type": "reflection_commit",
                              "userId": "master", "items": []})
        self.assertEqual(r["type"], "error")

    def test_round_consumed(self):
        """commit 消费掉本轮窗口:重复 commit 报错(防双写)。"""
        p = self.w.roundtrip({"reqId": 1, "type": "reflection_prompt",
                              "userId": "master", "now": NOW})
        self.assertTrue(p["triggered"])
        self.w.roundtrip({"reqId": 2, "type": "reflection_commit",
                          "userId": "master", "items": [], "now": NOW})
        r = self.w.roundtrip({"reqId": 3, "type": "reflection_commit",
                              "userId": "master", "items": [], "now": NOW})
        self.assertEqual(r["type"], "error")


class ReflectionKnobs(unittest.TestCase):
    """v0.22.0:整固的两只旋钮走**真路径**(A `main.py:1926-1927`)。

    这里不检查"配置读到了没有",而是让**行为**变:同一批记忆、同一个时刻,
    只因为阈值/窗口不同,触发与否、候选条数就不同 —— 那才叫接通了。
    """

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = str(Path(self.tmp.name) / "echo.db")
        self.conn = db.connect(self.path)

    def tearDown(self):
        self.conn.close()
        self.tmp.cleanup()

    def test_threshold_actually_moves_the_trigger(self):
        seed_memories(self.conn, 2, score=10)  # 累计 20
        self.assertFalse(reflection.check(self.conn, "master", now=NOW)["triggered"])
        # 阈值降到 20 ⇒ 同一批记忆现在该触发
        r = reflection.check(self.conn, "master", now=NOW, importance_threshold=20.0)
        self.assertTrue(r["triggered"], "阈值调低没生效 —— 旋钮是空转的")
        self.assertEqual(r["importance"], 20)
        # 反向:阈值抬高 ⇒ 更高分也不触发
        seed_memories(self.conn, 3, score=10)  # 累计 50
        self.assertTrue(reflection.check(self.conn, "master", now=NOW,
                                        importance_threshold=50.0)["triggered"])
        self.assertFalse(reflection.check(self.conn, "master", now=NOW,
                                         importance_threshold=60.0)["triggered"])

    def test_below_threshold_reports_the_threshold_used(self):
        """面板把阈值调高之后"怎么不整固了"要看得见 —— 回包里带上当时用的值。"""
        seed_memories(self.conn, 1, score=5)
        r = reflection.check(self.conn, "master", now=NOW, importance_threshold=44.0)
        self.assertEqual(r["reason"], "below_threshold")
        self.assertEqual(r["threshold"], 44.0)

    def test_window_caps_and_has_the_a_floor(self):
        ids = seed_memories(self.conn, 8, score=10)
        r = reflection.check(self.conn, "master", now=NOW, max_inputs=5)
        self.assertEqual(len(r["candidateIds"]), 5, "窗口上限没生效")
        self.assertEqual(r["candidateIds"], ids[:5])
        # A 的下限:给 1 也按 5 算(`max(5, cfg)`)
        r2 = reflection.check(self.conn, "master", now=NOW, max_inputs=1)
        self.assertEqual(len(r2["candidateIds"]), 5)

    def test_junk_values_fall_back_to_defaults(self):
        seed_memories(self.conn, 2, score=10)  # 累计 20
        r = reflection.check(self.conn, "master", now=NOW,
                             importance_threshold="abc", max_inputs=None)
        self.assertFalse(r["triggered"], "坏阈值该回默认 30,不该变成「总是触发」")

    def test_bad_config_does_not_kill_the_frame(self):
        """壳发来的 config 坏掉时,整固照跑(默认 30/50)—— 不许因为一个坏值把她整轮弄没。"""
        w = WorkerHarness()
        try:
            self.assertEqual(w.roundtrip(hello_frame(db_path=self.path))["type"], "ready")
            seed_memories(self.conn, 3, score=10)
            p = w.roundtrip({"reqId": 2, "type": "reflection_prompt",
                             "userId": "master", "now": NOW,
                             "config": {"importanceThreshold": "x", "maxInputs": "y"}})
            self.assertEqual(p["type"], "reflection_prompt_result")
            self.assertTrue(p["triggered"], "坏 config 之后应当回默认阈值(30)并触发")
        finally:
            w.close()


if __name__ == "__main__":
    unittest.main()
