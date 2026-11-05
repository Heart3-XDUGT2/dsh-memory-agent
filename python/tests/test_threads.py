# -*- coding: utf-8 -*-
"""悬置话题引擎测试(M2-b1)。

两层:
  EngineSemantics —— 直接调 engine/threads.py,逐条验证 AstrBot 语义保真;
  WireRoundTrips  —— 子进程经 echo_wire_v1 帧往返,验证接线与两种
                     「提过」语义(注入即归零 vs 发送成功才归零)。
"""
import sys
import tempfile
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from engine import threads  # noqa: E402
from test_worker import WorkerHarness, hello_frame  # noqa: E402


class EngineSemantics(unittest.TestCase):
    """AstrBot echo_memory_engine.py:766-946 语义逐条保真。"""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.db = str(Path(self.tmp.name) / "echo.db")
        self.conn = threads.connect(self.db)
        self.now = time.time()

    def tearDown(self):
        self.conn.close()
        self.tmp.cleanup()

    def test_register_new_then_merge(self):
        tid1, created1 = threads.remember_pending_thread(
            self.conn, "master", "明天要告诉我面试的结果")
        self.assertTrue(created1)
        tid2, created2 = threads.remember_pending_thread(
            self.conn, "master", "明天要告诉我面试的结果")
        self.assertEqual(tid1, tid2)
        self.assertFalse(created2)
        self.assertEqual(len(threads.list_open_pending_threads(self.conn, "master")), 1)

    def test_bidirectional_substring_dedup(self):
        """≥6 字的包含关系命中合并:长话登记后,短的核心重提不新建。"""
        tid1, _ = threads.remember_pending_thread(
            self.conn, "master", "明天要告诉你面试的结果怎么样")
        tid2, created = threads.remember_pending_thread(
            self.conn, "master", "面试的结果怎么样")
        self.assertFalse(created)
        self.assertEqual(tid1, tid2)

    def test_short_substring_no_merge(self):
        """<6 字的子串不算重提(「面试」太短,只认全等)。"""
        _, c1 = threads.remember_pending_thread(self.conn, "master", "面试结果如何")
        _, c2 = threads.remember_pending_thread(self.conn, "master", "面试")
        self.assertTrue(c1)
        self.assertTrue(c2)  # 新建,不合并
        self.assertEqual(len(threads.list_open_pending_threads(self.conn, "master")), 2)

    def test_empty_content_noop(self):
        tid, created = threads.remember_pending_thread(self.conn, "master", "   ")
        self.assertEqual(tid, 0)
        self.assertFalse(created)
        self.assertEqual(len(threads.list_open_pending_threads(self.conn, "master")), 0)

    def test_normalization_whitespace_and_cap(self):
        threads.remember_pending_thread(self.conn, "master", "  多   空白\t换\n行  ")
        threads.remember_pending_thread(self.conn, "master", "长" * 500)
        rows = threads.list_open_pending_threads(self.conn, "master")
        by_content = {r["content"]: r for r in rows}
        self.assertIn("多 空白 换 行", by_content)
        long_row = next(r for r in rows if r["content"].startswith("长"))
        self.assertEqual(len(long_row["content"]), 300)

    def test_due_window_merges_two_wordingings_of_one_appointment(self):
        """v0.18.2 C4:±120s 到期防重(A 侧 main.py:2088-2094)。

        同一场约定常有两种说法:命令式提醒「面试结果」与 Judge 的
        「复盘那天面试」。**两条措辞互不为子串**(故意这么选:否则会被
        ①那条措辞去重命中,测不到到期窗口),只有比对到期时间才能合并 ——
        不比对就会留两条、他收到两次催办。
        """
        t1, c1 = threads.remember_pending_thread(
            self.conn, "master", "面试结果",
            follow_up_after=self.now + 3600, due_window_sec=120.0)
        self.assertTrue(c1)
        t2, c2 = threads.remember_pending_thread(
            self.conn, "master", "复盘那天面试",
            follow_up_after=self.now + 3600 + 30, due_window_sec=120.0)
        self.assertEqual(t2, t1, "到期只差 30 秒 ⇒ 同一场约定,并成一条")
        self.assertFalse(c2, "第二条是合并,不是新建")
        self.assertEqual(len(threads.list_open_pending_threads(self.conn, "master")), 1)

    def test_due_window_outside_range_stays_two(self):
        """相差 200 秒 ⇒ 两条不同的事,不许并(窗口是 120 秒)。"""
        threads.remember_pending_thread(
            self.conn, "master", "开会",
            follow_up_after=self.now + 3600, due_window_sec=120.0)
        _, created = threads.remember_pending_thread(
            self.conn, "master", "吃药",
            follow_up_after=self.now + 3600 + 200, due_window_sec=120.0)
        self.assertTrue(created)
        self.assertEqual(len(threads.list_open_pending_threads(self.conn, "master")), 2)

    def test_due_window_off_by_default(self):
        """不传窗(默认 0)= 老行为:只按措辞去重 —— 别的调用点不受影响。"""
        threads.remember_pending_thread(
            self.conn, "master", "开会", follow_up_after=self.now + 3600)
        _, created = threads.remember_pending_thread(
            self.conn, "master", "吃药", follow_up_after=self.now + 3600)
        self.assertTrue(created, "没开窗就不该因为时间相同而合并")

    def test_due_window_ignores_untimed(self):
        """不定时(fu=0)不参与到期比对 —— 没有时间的约定谈不上"同一场"。"""
        threads.remember_pending_thread(
            self.conn, "master", "有空聊聊", follow_up_after=0.0, due_window_sec=120.0)
        _, created = threads.remember_pending_thread(
            self.conn, "master", "另一个不定时", follow_up_after=0.0, due_window_sec=120.0)
        self.assertTrue(created)

    def test_merge_updates_time_and_session(self):
        """重提补时间/会话:fu=0 的旧话题被带时间的重提命中后获得时间。"""
        tid, _ = threads.remember_pending_thread(
            self.conn, "master", "跑步计划", follow_up_after=0.0, session_id="")
        threads.remember_pending_thread(
            self.conn, "master", "跑步计划",
            follow_up_after=self.now + 3600, session_id="sess-1")
        row = threads.list_open_pending_threads(self.conn, "master")[0]
        self.assertEqual(row["thread_id"], tid)
        self.assertAlmostEqual(row["follow_up_after"], self.now + 3600, delta=1)
        due = threads.list_due_pending_threads(self.conn, "master", now_ts=self.now)
        self.assertEqual(len(due), 0)  # 时间在未来,未到期

    def test_untimed_never_due_never_remindable(self):
        """fu=0 = 不定时:永远不进 due/remindable —— 跟进与待办的分界线。"""
        threads.remember_pending_thread(
            self.conn, "master", "有空聊聊", follow_up_after=0.0, session_id="s")
        self.assertEqual(threads.list_due_pending_threads(self.conn, "master", now_ts=self.now), [])
        self.assertEqual(threads.list_remindable_threads(conn=self.conn, now_ts=self.now), [])

    def test_due_requires_past_time(self):
        threads.remember_pending_thread(
            self.conn, "master", "到期话题", follow_up_after=self.now - 100)
        threads.remember_pending_thread(
            self.conn, "master", "未来话题", follow_up_after=self.now + 100)
        due = threads.list_due_pending_threads(self.conn, "master", now_ts=self.now)
        self.assertEqual([r["content"] for r in due], ["到期话题"])

    def test_remindable_global_and_needs_session(self):
        """主动提醒:全局查(跨用户),且必须有 session 才知道往哪发。"""
        threads.remember_pending_thread(
            self.conn, "master", "带会话", follow_up_after=self.now - 1, session_id="sess-1")
        threads.remember_pending_thread(
            self.conn, "master", "无会话", follow_up_after=self.now - 1, session_id="")
        got = threads.list_remindable_threads(conn=self.conn, now_ts=self.now)
        self.assertEqual([r["content"] for r in got], ["带会话"])
        self.assertEqual(got[0]["session_id"], "sess-1")
        self.assertEqual(got[0]["user_id"], "master")

    def test_mark_zeroes_and_no_repeat(self):
        tid, _ = threads.remember_pending_thread(
            self.conn, "master", "提一次就好", follow_up_after=self.now - 1)
        threads.mark_pending_thread_mentioned(self.conn, tid)
        row = threads.list_open_pending_threads(self.conn, "master")[0]
        self.assertEqual(row["follow_up_after"], 0)
        self.assertGreater(row["last_mentioned_at"], 0)
        self.assertEqual(threads.list_due_pending_threads(self.conn, "master", now_ts=self.now), [])

    def test_resolve_bidirectional(self):
        """用户原话含话题内容(或反向)即结案;resolved 不再出现在任何列表。"""
        tid, _ = threads.remember_pending_thread(self.conn, "master", "面试的结果")
        got = threads.resolve_pending_thread(self.conn, "master", "面试的结果出来了,过了!")
        self.assertEqual(got, tid)
        self.assertEqual(threads.list_open_pending_threads(self.conn, "master"), [])
        self.assertEqual(threads.list_due_pending_threads(self.conn, "master", now_ts=self.now), [])

    def test_resolve_no_match_returns_none(self):
        threads.remember_pending_thread(self.conn, "master", "跑步计划")
        self.assertIsNone(threads.resolve_pending_thread(self.conn, "master", "完全无关的话"))

    def test_list_ordering_timed_first(self):
        threads.remember_pending_thread(self.conn, "master", "不定时", follow_up_after=0.0)
        threads.remember_pending_thread(self.conn, "master", "晚到期", follow_up_after=self.now + 500)
        threads.remember_pending_thread(self.conn, "master", "早到期", follow_up_after=self.now + 100)
        got = [r["content"] for r in threads.list_open_pending_threads(self.conn, "master")]
        self.assertEqual(got, ["早到期", "晚到期", "不定时"])

    def test_must_exist_guard(self):
        """worker 永不建库:must_exist=True 时缺文件报错,不悄悄重建空库。"""
        with self.assertRaises(FileNotFoundError):
            threads.connect(str(Path(self.tmp.name) / "nope.db"), must_exist=True)


class WireRoundTrips(unittest.TestCase):
    """echo_wire_v1 帧往返:接线正确性 + 两种「提过」语义。"""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.db = str(Path(self.tmp.name) / "echo.db")
        threads.connect(self.db).close()  # 预建库:JS 壳的职责,worker 只认现成库
        self.w = WorkerHarness()
        ready = self.w.roundtrip(hello_frame(db_path=self.db))
        self.assertEqual(ready["type"], "ready")
        self.now = time.time()

    def tearDown(self):
        self.w.close()
        self.tmp.cleanup()

    def test_due_fetch_marks_injection_semantics(self):
        """注入即提过:threads_due 取走即归零,第二次取为空(不追问两次)。"""
        r = self.w.roundtrip({"reqId": 1, "type": "threads_ingest",
                              "userId": "master", "sessionId": "s1", "text": "",
                              "items": [{"content": "到期话题", "followUpAfter": self.now - 50}]})
        self.assertEqual(r["type"], "threads_ingest_result")
        self.assertTrue(r["threads"][0]["created"])
        due = self.w.roundtrip({"reqId": 2, "type": "threads_due",
                                "userId": "master", "now": self.now})
        self.assertEqual(len(due["items"]), 1)
        self.assertEqual(due["items"][0]["content"], "到期话题")
        again = self.w.roundtrip({"reqId": 3, "type": "threads_due",
                                  "userId": "master", "now": self.now})
        self.assertEqual(again["items"], [])

    def test_ingest_resolves_before_register(self):
        """顺序纪律:先消解后登记 —— 新话题不会被同轮原话立刻关掉。"""
        r1 = self.w.roundtrip({"reqId": 1, "type": "threads_ingest",
                               "userId": "master", "sessionId": "s1", "text": "",
                               "items": [{"content": "面试的结果", "followUpAfter": 0}]})
        old_tid = r1["threads"][0]["threadId"]
        r2 = self.w.roundtrip({"reqId": 2, "type": "threads_ingest",
                               "userId": "master", "sessionId": "s1",
                               "text": "面试的结果出来了,过了!",
                               "items": [{"content": "跑步计划", "followUpAfter": 0}]})
        self.assertEqual(r2["resolved"], old_tid)
        self.assertTrue(r2["threads"][0]["created"])
        lst = self.w.roundtrip({"reqId": 3, "type": "threads_list", "userId": "master"})
        self.assertEqual([i["content"] for i in lst["items"]], ["跑步计划"])
        self.assertIn("now", lst)

    def test_explicit_reminder_relative_text_resolved_engine_side(self):
        """v0.14.1 F4:壳只交原话,时间解析留在引擎(timeutil 单一事实源)。

        「提醒我两分钟后去洗澡」是**命令**:壳侧正则认出它、原话交回,
        引擎换算成 now+120s 再登记 —— 换算不出就不登记(A 侧纪律)。
        """
        r = self.w.roundtrip({"reqId": 1, "type": "threads_ingest",
                              "userId": "master", "sessionId": "s-f4",
                              "text": "echo,提醒我两分钟后去洗澡",
                              "items": [{"content": "洗澡",
                                         "followUpAfterText": "echo,提醒我两分钟后去洗澡",
                                         "requireTime": True}]})
        self.assertEqual(r["type"], "threads_ingest_result")
        self.assertEqual(len(r["threads"]), 1)
        self.assertTrue(r["threads"][0]["created"])
        early = self.w.roundtrip({"reqId": 2, "type": "threads_due",
                                  "userId": "master", "now": self.now})
        self.assertEqual(early["items"], [])  # 没到点,不吵
        late = self.w.roundtrip({"reqId": 3, "type": "threads_due",
                                 "userId": "master", "now": self.now + 130})
        self.assertEqual([i["content"] for i in late["items"]], ["洗澡"])

    def test_reminder_without_resolvable_time_dropped(self):
        """换算不出时间就不登记(requireTime):「到点喊我去跑步」没有
        可用锚点 —— 归被动提及管,不归主动提醒。永不响的约定比没有
        更糟:她答应过,却不会响。"""
        r = self.w.roundtrip({"reqId": 1, "type": "threads_ingest",
                              "userId": "master", "sessionId": "s-f4",
                              "text": "到点喊我去跑步",
                              "items": [{"content": "跑步",
                                         "followUpAfterText": "到点喊我去跑步",
                                         "requireTime": True}]})
        self.assertEqual(r["threads"], [])
        lst = self.w.roundtrip({"reqId": 2, "type": "threads_list", "userId": "master"})
        self.assertEqual(lst["items"], [])

    def test_command_then_judge_same_deal_merges(self):
        """命令式先登记、Judge 稍后登记同一件事 → 合并而非两条。

        命令走确定性登记(v8.5.2),Judge 走概率,时序上命令先到;
        去重靠 remember_pending_thread 的包含规则(≥6 字的互相包含
        才算同一条)—— 这条测试同时把这个边界钉住。
        """
        r1 = self.w.roundtrip({"reqId": 1, "type": "threads_ingest",
                               "userId": "master", "sessionId": "s-f4",
                               "text": "提醒我两分钟后去洗澡然后早点睡",
                               "items": [{"content": "去洗澡然后早点睡",
                                          "followUpAfterText": "提醒我两分钟后去洗澡然后早点睡",
                                          "requireTime": True}]})
        self.assertTrue(r1["threads"][0]["created"])
        r2 = self.w.roundtrip({"reqId": 2, "type": "threads_ingest",
                               "userId": "master", "sessionId": "s-f4", "text": "",
                               "items": [{"content": "洗澡然后早点睡",
                                          "followUpAfter": self.now + 121}]})
        self.assertFalse(r2["threads"][0]["created"])  # 没新建
        self.assertEqual(r2["threads"][0]["threadId"], r1["threads"][0]["threadId"])
        lst = self.w.roundtrip({"reqId": 3, "type": "threads_list", "userId": "master"})
        self.assertEqual(len(lst["items"]), 1)

    def test_remindable_pure_read_then_mark(self):
        """发送成功才归零:remindable 纯读可重复取,mark 之后才清空。"""
        self.w.roundtrip({"reqId": 1, "type": "threads_ingest",
                          "userId": "master", "sessionId": "sess-9", "text": "",
                          "items": [{"content": "主动提醒话题", "followUpAfter": self.now - 5}]})
        first = self.w.roundtrip({"reqId": 2, "type": "threads_remindable", "now": self.now})
        self.assertEqual(len(first["items"]), 1)
        self.assertEqual(first["items"][0]["session_id"], "sess-9")
        second = self.w.roundtrip({"reqId": 3, "type": "threads_remindable", "now": self.now})
        self.assertEqual(len(second["items"]), 1)  # 纯读:没归零,发送失败可重试
        tid = first["items"][0]["thread_id"]
        mark = self.w.roundtrip({"reqId": 4, "type": "threads_mark", "threadId": tid})
        self.assertEqual(mark["type"], "threads_mark_result")
        third = self.w.roundtrip({"reqId": 5, "type": "threads_remindable", "now": self.now})
        self.assertEqual(third["items"], [])

    def test_missing_user_id_is_nonfatal_error(self):
        err = self.w.roundtrip({"reqId": 1, "type": "threads_due"})
        self.assertEqual(err["type"], "error")
        self.assertFalse(err.get("fatal", False))
        pong = self.w.roundtrip({"reqId": 2, "type": "ping"})
        self.assertEqual(pong["type"], "pong")

    def test_user_isolation(self):
        """按人隔离:master 的话题不进别人的 due 列表。"""
        self.w.roundtrip({"reqId": 1, "type": "threads_ingest",
                          "userId": "master", "sessionId": "s", "text": "",
                          "items": [{"content": "主人的话题", "followUpAfter": self.now - 5}]})
        other = self.w.roundtrip({"reqId": 2, "type": "threads_due",
                                  "userId": "someone-else", "now": self.now})
        self.assertEqual(other["items"], [])


    def test_threads_lifecycle_frame(self):
        """D2 帧:影子期只盖两列 —— 空清单也照答,不炸(dryRun 一个字节都不写)。"""
        r = self.w.roundtrip({"reqId": 1, "type": "threads_lifecycle",
                              "now": self.now, "dryRun": True})
        self.assertEqual(r["type"], "threads_lifecycle_result")
        self.assertEqual(r["cooled"], [])
        self.assertEqual(r["archived"], [])
        self.assertIn("scanned", r)
        self.assertTrue(r["dryRun"])


class ThreadKinds(unittest.TestCase):
    """D1(2026-10-06):悬置话题的类别 —— 规则优先 → LLM 兜底 → 认不出留 ''(不猜)。

    ⚠️ 这张夹具表与 `tests/thread-kinds.test.js` 的 FIXTURES **逐行相同**
    (JS 那条电池会反过来核对本文件里出现过同样的输入)。
    """

    FIXTURES = (
        ("提醒我两分钟后洗衣服", "", "reminder"),
        ("用户要求2分钟后提醒他睡觉", "", "reminder"),
        ("用户坐今晚10点的火车回家,预计明天早上八点到站", "", "schedule"),
        ("用户把车票退了,改成10月7日当天出发", "", "schedule"),
        ("明天中午12点到达合肥,可在那之后问候是否顺利到达", "", "care"),
        ("用户计划明天开始学习数据结构", "", "promise"),
        ("用户今天的三公里跑没有完成,说先欠着,之后需要补跑", "", "promise"),
        ("大类分流后专业确定,说好回来汇报最终专业", "topic", "topic"),
        ("车票的事", "schedule", "schedule"),
        ("大类分流后专业确定,说好回来汇报最终专业", "meeting", ""),
        ("随手记一句", "", ""),
        ("提醒我两分钟后洗衣服", "care", "reminder"),
        ("明天要去面试", "", "schedule"),
        ("回家路上顺便买了本书", "", ""),
        ("", "", ""),
    )

    def test_rules_first_then_llm_then_empty(self):
        for content, llm, want in self.FIXTURES:
            with self.subTest(content=content, llm=llm):
                self.assertEqual(threads.resolve_thread_kind(content, llm), want)

    def test_whitelist_is_these_five(self):
        self.assertEqual(
            list(threads.THREAD_KINDS),
            ["promise", "schedule", "reminder", "care", "topic"],
        )

    def test_schedule_needs_a_time_anchor(self):
        self.assertEqual(threads.resolve_thread_kind("回家"), "")
        self.assertEqual(threads.resolve_thread_kind("明天回家"), "schedule")

    def test_junk_never_raises_and_never_guesses(self):
        for bad in (None, "", "   ", 42, [], {}, True):
            got = threads.resolve_thread_kind(bad)
            self.assertEqual(got, "", repr(bad))
            self.assertIn(threads.resolve_thread_kind(bad, bad), ("",) + threads.THREAD_KINDS)


class ThreadKindPersistence(unittest.TestCase):
    """D1:类别真的落库;老行(空格)只补不覆盖;四列在 connect 之后存在。"""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.db = str(Path(self.tmp.name) / "echo.db")
        self.conn = threads.connect(self.db)

    def tearDown(self):
        self.conn.close()
        self.tmp.cleanup()

    def _kind(self, tid):
        row = self.conn.execute(
            "SELECT kind FROM pending_threads WHERE thread_id = ?", (tid,)).fetchone()
        return row[0]

    def test_lifecycle_columns_exist_after_connect(self):
        cols = {r[1] for r in self.conn.execute("PRAGMA table_info(pending_threads)")}
        for col in ("kind", "cooling_at", "archived_at", "superseded_by"):
            self.assertIn(col, cols)

    def test_insert_stores_kind_from_rules(self):
        tid, created = threads.remember_pending_thread(
            self.conn, "master", "提醒我两分钟后洗衣服")
        self.assertTrue(created)
        self.assertEqual(self._kind(tid), "reminder")

    def test_llm_kind_used_when_rules_miss(self):
        tid, _ = threads.remember_pending_thread(
            self.conn, "master", "专业分流的结果要问一句", kind="topic")
        self.assertEqual(self._kind(tid), "topic")

    def test_unknown_llm_kind_stays_empty(self):
        tid, _ = threads.remember_pending_thread(
            self.conn, "master", "专业分流的结果要问一句", kind="meeting")
        self.assertEqual(self._kind(tid), "")

    def test_dedupe_hit_fills_empty_but_never_overwrites(self):
        tid, _ = threads.remember_pending_thread(
            self.conn, "master", "专业分流的结果要问一句")
        self.assertEqual(self._kind(tid), "")
        same, created = threads.remember_pending_thread(
            self.conn, "master", "专业分流的结果要问一句", kind="topic")
        self.assertEqual(same, tid)
        self.assertFalse(created)
        self.assertEqual(self._kind(tid), "topic")
        # 已有类别不被后来的覆盖(哪怕这次 LLM 说了别的)
        threads.remember_pending_thread(
            self.conn, "master", "专业分流的结果要问一句", kind="care")
        self.assertEqual(self._kind(tid), "topic")


class ThreadLifecycle(unittest.TestCase):
    """D2(2026-10-06):冷却 / 归档判定 —— **影子期只盖两列**。

    钉三件事:
      ① 每类的冷却边界(设计 §3.2 的数值);
      ② 归档两条路(冷却满 7 天 / resolved 满 7 天);
      ③ 影子期纪律:不动 `status`、不推 `updated_at`、一次性、没该动的行就一条
         UPDATE 都不发(dry_run 更是只算不写)。
    """

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.db = str(Path(self.tmp.name) / "echo.db")
        self.conn = threads.connect(self.db)
        self.now = time.time()

    def tearDown(self):
        self.conn.close()
        self.tmp.cleanup()

    def _add(self, kind="", age_days=0.0, fu=0.0, mentioned=False, status="open",
             cooling_at=0.0, updated_age_days=None):
        created = self.now - age_days * 86400
        updated = self.now - (age_days if updated_age_days is None else updated_age_days) * 86400
        cur = self.conn.execute(
            "INSERT INTO pending_threads (user_id, content, status, follow_up_after,"
            " source_memory_id, session_id, last_mentioned_at, created_at, updated_at,"
            " kind, cooling_at) VALUES ('master', ?, ?, ?, 0, 's', ?, ?, ?, ?, ?)",
            ("样本 " + str(kind) + " " + str(age_days), status, fu,
             self.now if mentioned else 0.0, created, updated, kind, cooling_at))
        self.conn.commit()
        return int(cur.lastrowid)

    def _snapshot(self):
        return {r[0]: (r[1], r[2], r[3]) for r in self.conn.execute(
            "SELECT thread_id, cooling_at, archived_at, updated_at FROM pending_threads")}

    def test_cool_rules_per_kind(self):
        cases = (
            ("schedule", 0.0, self.now - 7 * 3600, False, True),
            ("schedule", 0.0, self.now - 5 * 3600, False, False),
            ("schedule", 7 * 3600 / 86400.0, 0.0, False, True),  # 无事件时刻 ⇒ 退回创建时刻
            ("reminder", 0.0, 0.0, True, True),                  # 提过即冷却
            ("reminder", 0.0, self.now - 13 * 3600, False, True),
            ("reminder", 0.0, self.now - 11 * 3600, False, False),
            ("care", 4.0, 0.0, False, True),
            ("care", 2.0, 0.0, False, False),
            ("promise", 15.0, 0.0, False, True),
            ("promise", 15.0, 0.0, True, False),                 # 提过的承诺不进冷却
            ("promise", 10.0, 0.0, False, False),
            ("topic", 31.0, 0.0, False, True),
            ("topic", 29.0, 0.0, False, False),
            ("", 8.0, 0.0, False, True),
            ("", 6.0, 0.0, False, False),
        )
        for kind, age, fu, mentioned, want in cases:
            with self.subTest(kind=kind, age=age, mentioned=mentioned):
                tid = self._add(kind=kind, age_days=age, fu=fu, mentioned=mentioned)
                plan = threads.cool_then_archive(self.conn, now=self.now, dry_run=True)
                self.assertEqual(tid in plan["cooled"], want, "kind=" + str(kind))
                self.conn.execute("DELETE FROM pending_threads WHERE thread_id = ?", (tid,))
                self.conn.commit()

    def test_archive_paths(self):
        old_cool = self._add(kind="care", cooling_at=self.now - 8 * 86400)
        fresh_cool = self._add(kind="care", cooling_at=self.now - 6 * 86400)
        resolved_old = self._add(status="resolved", age_days=8.0, updated_age_days=8.0)
        resolved_new = self._add(status="resolved", age_days=2.0, updated_age_days=2.0)
        plan = threads.cool_then_archive(self.conn, now=self.now, dry_run=True)
        self.assertIn(old_cool, plan["archived"])
        self.assertNotIn(fresh_cool, plan["archived"])
        self.assertIn(resolved_old, plan["archived"])
        self.assertNotIn(resolved_new, plan["archived"])
        # 已归档的行不再进任何清单
        done = self._add(kind="care", cooling_at=self.now - 9 * 86400)
        threads.cool_then_archive(self.conn, now=self.now)
        again = threads.cool_then_archive(self.conn, now=self.now, dry_run=True)
        self.assertNotIn(done, again["archived"])

    def test_one_shot_and_no_write_when_nothing_changes(self):
        tid = self._add(kind="care", age_days=4.0)
        before = self._snapshot()
        first = threads.cool_then_archive(self.conn, now=self.now)
        self.assertIn(tid, first["cooled"])
        mid = self._snapshot()
        self.assertGreater(mid[tid][0], 0)                 # cooling_at 盖上了
        self.assertEqual(mid[tid][2], before[tid][2], "updated_at 不许被 tick 推着走")
        second = threads.cool_then_archive(self.conn, now=self.now)
        self.assertEqual(second["cooled"], [])
        self.assertEqual(second["archived"], [])
        self.assertEqual(self._snapshot(), mid, "没该动的行 ⇒ 一个字节都不写")

    def test_dry_run_writes_nothing(self):
        self._add(kind="care", age_days=4.0)
        self._add(kind="topic", age_days=40.0)
        before = self._snapshot()
        plan = threads.cool_then_archive(self.conn, now=self.now, dry_run=True)
        self.assertEqual(len(plan["cooled"]), 2)
        self.assertEqual(self._snapshot(), before)

    def test_status_is_untouched_in_shadow_phase(self):
        tid = self._add(kind="care", age_days=4.0)
        threads.cool_then_archive(self.conn, now=self.now)
        row = self.conn.execute(
            "SELECT status FROM pending_threads WHERE thread_id = ?", (tid,)).fetchone()
        self.assertEqual(row[0], "open", "影子期不许改 status(读出侧全靠它)")


class ThreadReadGates(unittest.TestCase):
    """D3(2026-10-06):进 prompt / 主动开口的两条路排除冷却与归档行。

    · `list_due_pending_threads`(轮末顺带提,进 prompt)与
      `list_remindable_threads`(她主动开口)都要排除 `cooling_at>0` / `archived_at>0`;
    · `list_open_pending_threads`(面板/工具)**刻意不排除** —— 面板的五档就是
      靠这两列切出来的,它只多带字段。
    """

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.db = str(Path(self.tmp.name) / "echo.db")
        self.conn = threads.connect(self.db)
        self.now = time.time()

    def tearDown(self):
        self.conn.close()
        self.tmp.cleanup()

    def _row(self, content, *, kind="promise", status="open", fu=0.0,
             cooling=0.0, archived=0.0, mentioned=0.0, session="s1"):
        cur = self.conn.execute(
            "INSERT INTO pending_threads (user_id, content, status, follow_up_after,"
            " source_memory_id, session_id, kind, last_mentioned_at, created_at,"
            " updated_at, cooling_at, archived_at)"
            " VALUES ('master', ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?)",
            (content, status, fu, session, kind, mentioned, self.now, self.now, cooling, archived))
        self.conn.commit()
        return int(cur.lastrowid)

    def test_due_skips_cooling_and_archived(self):
        self._row("到期-活跃", fu=self.now - 10, kind="reminder")
        self._row("到期-冷却", fu=self.now - 10, kind="reminder", cooling=self.now - 100)
        self._row("到期-归档", fu=self.now - 10, kind="reminder", archived=self.now - 100)
        got = [r["content"] for r in
               threads.list_due_pending_threads(self.conn, "master", now_ts=self.now)]
        self.assertEqual(got, ["到期-活跃"])

    def test_remindable_skips_cooling_and_archived(self):
        self._row("提醒-活跃", fu=self.now - 10, kind="reminder")
        self._row("提醒-冷却", fu=self.now - 10, kind="reminder", cooling=self.now - 100)
        self._row("提醒-归档", fu=self.now - 10, kind="reminder", archived=self.now - 100)
        got = [r["content"] for r in
               threads.list_remindable_threads(conn=self.conn, now_ts=self.now)]
        self.assertEqual(got, ["提醒-活跃"])

    def test_list_open_still_shows_cooling_but_with_fields(self):
        tid = self._row("冷却了但面板要看得见", kind="care", cooling=self.now - 100)
        rows = {r["thread_id"]: r for r in threads.list_open_pending_threads(self.conn, "master")}
        row = rows[tid]
        self.assertGreater(row["cooling_at"], 0)
        self.assertEqual(row["kind"], "care")
        self.assertEqual(row["archived_at"], 0.0)
        self.assertIn("superseded_by", row)
        self.assertIn("updated_at", row)


class ThreadSemanticDedupe(unittest.TestCase):
    """D4(2026-10-06):语义去重(写入路径)+ 留档取代(存量合并)。

    阈值是**拿数据标定出来的**,不是拍脑袋:现网 6 组近重复离线回放,最高的
    数据结构组 0.714 并得掉,其余 5 组 0.111~0.412 并不掉,不该并的对照
    "上周/这周面试" 0.60 也并不掉 ⇒ 取 **0.70**。数字与理由都写在
    `python/engine/threads.py` 的注释里;下面是它们的**回归钉子**。
    """

    # (两段正文, 期望相似度(±0.01), 期望"同 kind 48h 内会不会并")
    REPLAY = (
        ("用户计划明天开始学习数据结构", "用户计划明天学习数据结构。", 0.714, True),
        ("写西电的oj作业", "他要去写西电的OJ作业,两分钟后提醒他", 0.412, False),
        ("上周的面试", "这周的面试", 0.600, False),
        ("用户大类分流后专业确定,说好回来汇报最终专业。", "用户分流专业确定后告知结果", 0.192, False),
    )

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.db = str(Path(self.tmp.name) / "echo.db")
        self.conn = threads.connect(self.db)
        self.now = time.time()

    def tearDown(self):
        self.conn.close()
        self.tmp.cleanup()

    def _add(self, content, kind="promise", created=None, fu=0.0, session="s1"):
        created = self.now if created is None else float(created)
        cur = self.conn.execute(
            "INSERT INTO pending_threads (user_id, content, status, follow_up_after,"
            " source_memory_id, session_id, kind, last_mentioned_at, created_at, updated_at)"
            " VALUES ('master', ?, 'open', ?, 0, ?, ?, 0, ?, ?)",
            (content, fu, session, kind, created, created))
        self.conn.commit()
        return int(cur.lastrowid)

    def test_similarity_calibration(self):
        for a, b, sim, same in self.REPLAY:
            with self.subTest(a=a):
                got = threads.thread_similarity(a, b)
                self.assertAlmostEqual(got, sim, delta=0.011)
                self.assertEqual(
                    threads._semantic_same("promise", "promise", 0.0, 0.0, got), same)

    def test_write_path_merges_semantic_duplicate(self):
        tid1, created1 = threads.remember_pending_thread(
            self.conn, "master", "用户计划明天开始学习数据结构")
        tid2, created2 = threads.remember_pending_thread(
            self.conn, "master", "用户计划明天学习数据结构。")
        self.assertTrue(created1)
        self.assertFalse(created2, "语义命中 ⇒ 不新建")
        self.assertEqual(tid1, tid2)

    def test_write_path_does_not_merge_across_kind(self):
        tid1, _ = threads.remember_pending_thread(
            self.conn, "master", "上周的面试", kind="schedule")
        tid2, created2 = threads.remember_pending_thread(
            self.conn, "master", "这周的面试", kind="promise")
        self.assertTrue(created2)
        self.assertNotEqual(tid1, tid2, "跨 kind / 相似度不足 ⇒ 各留一条")

    def test_merge_existing_group_keeps_earliest_and_archives_the_rest(self):
        ids = [
            self._add("用户计划明天开始学习数据结构", created=self.now - 3 * 3600),
            self._add("用户计划明天学习数据结构。", created=self.now - 2 * 3600),
            self._add("用户计划学习数据结构。", created=self.now - 3600),
            self._add("完全无关的另一件事", kind="care", created=self.now - 100),
        ]
        plan = threads.merge_thread_duplicates(self.conn, now=self.now)
        self.assertEqual(plan["merged"], 1)
        group = plan["groups"][0]
        self.assertEqual(group["survivor"], ids[0], "幸存者 = thread_id 最小")
        self.assertEqual(group["losers"], [ids[1]])
        # 第三条 0.667 < 0.70 ⇒ 并进来(宁可不并),如实
        survivor = self.conn.execute(
            "SELECT content, created_at FROM pending_threads WHERE thread_id = ?",
            (ids[0],)).fetchone()
        self.assertEqual(survivor[0], "用户计划明天开始学习数据结构", "content 取更长")
        self.assertAlmostEqual(float(survivor[1]), self.now - 3 * 3600, delta=1)
        loser = self.conn.execute(
            "SELECT status, superseded_by, archived_at FROM pending_threads WHERE thread_id = ?",
            (ids[1],)).fetchone()
        self.assertEqual(loser[0], "archived")
        self.assertEqual(int(loser[1]), ids[0])
        self.assertGreater(float(loser[2]), 0)
        # 不删行 + 一次性
        total = self.conn.execute("SELECT COUNT(*) FROM pending_threads").fetchone()[0]
        self.assertEqual(total, 4)
        again = threads.merge_thread_duplicates(self.conn, now=self.now)
        self.assertEqual(again["merged"], 0)
        self.assertEqual(again["groups"], [])

    def test_merge_dry_run_writes_nothing(self):
        self._add("用户计划明天开始学习数据结构", created=self.now - 3 * 3600)
        self._add("用户计划明天学习数据结构。", created=self.now - 2 * 3600)
        before = {r[0]: (r[1], r[2]) for r in self.conn.execute(
            "SELECT thread_id, content, archived_at FROM pending_threads")}
        plan = threads.merge_thread_duplicates(self.conn, now=self.now, dry_run=True)
        self.assertEqual(plan["merged"], 1)
        after = {r[0]: (r[1], r[2]) for r in self.conn.execute(
            "SELECT thread_id, content, archived_at FROM pending_threads")}
        self.assertEqual(after, before)


class ThreadRestore(unittest.TestCase):
    """D5(2026-10-06):人工"恢复" —— 只把**冷却中**的话题拉回活跃。"""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.db = str(Path(self.tmp.name) / "echo.db")
        self.conn = threads.connect(self.db)
        self.now = time.time()

    def tearDown(self):
        self.conn.close()
        self.tmp.cleanup()

    def _row(self, content, *, kind="care", status="open", cooling=0.0, archived=0.0,
             superseded_by=0):
        cur = self.conn.execute(
            "INSERT INTO pending_threads (user_id, content, status, follow_up_after,"
            " source_memory_id, session_id, kind, last_mentioned_at, created_at,"
            " updated_at, cooling_at, archived_at, superseded_by)"
            " VALUES ('master', ?, ?, 0, 0, 's1', ?, 0, ?, ?, ?, ?, ?)",
            (content, status, kind, self.now, self.now, cooling, archived, superseded_by))
        self.conn.commit()
        return int(cur.lastrowid)

    def test_restore_pulls_cooling_back_to_active_only(self):
        cool = self._row("冷却的那条", cooling=self.now - 100)
        archived = self._row("归档的那条", cooling=self.now - 100, archived=self.now - 50)
        superseded = self._row("被取代的那条", cooling=self.now - 100, superseded_by=1)
        resolved = self._row("已了结的那条", status="resolved")
        self.assertTrue(threads.restore_pending_thread(self.conn, cool))
        back = self.conn.execute(
            "SELECT cooling_at FROM pending_threads WHERE thread_id = ?", (cool,)).fetchone()
        self.assertEqual(float(back[0]), 0.0)
        self.assertFalse(threads.restore_pending_thread(self.conn, archived))
        self.assertFalse(threads.restore_pending_thread(self.conn, superseded))
        self.assertFalse(threads.restore_pending_thread(self.conn, resolved))
        self.assertFalse(threads.restore_pending_thread(self.conn, 0))


if __name__ == "__main__":
    unittest.main()
