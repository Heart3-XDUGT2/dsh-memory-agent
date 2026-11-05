# -*- coding: utf-8 -*-
"""时间意图解析单测(时间臂的入口)。

纪律:每个"该产窗口"的用例旁边都要有"**不该产窗口**"的负控 —— 猜出来的窗口
比没有窗口更坏(它会把不相关的记忆救进候选)。
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from engine import timeintent  # noqa: E402

# 锚:2026-09-25 当晚(库里中秋/拍月亮那批记忆就在这天)
NOW = None


def setUpModule():
    global NOW
    import time as _t
    NOW = _t.mktime((2026, 9, 25, 20, 0, 0, 0, 0, -1))


def windows_of(q):
    return timeintent.parse_time_intent(q, NOW)["windows"]


class TestTimeIntent(unittest.TestCase):
    # ---------------- 该产窗口
    def test_today(self):
        w = windows_of("他今天说了什么")
        self.assertTrue(len(w) >= 1)
        self.assertTrue(timeintent.in_windows(NOW, w))

    def test_yesterday(self):
        w = windows_of("他昨天说了什么")
        self.assertTrue(len(w) >= 1)
        self.assertFalse(timeintent.in_windows(NOW, w))         # 今天不在"昨天"窗口里
        self.assertTrue(timeintent.in_windows(NOW - 86400.0, w))

    def test_holiday_midautumn(self):
        w = windows_of("中秋那天他说了什么")
        self.assertTrue(len(w) >= 1)
        self.assertTrue(timeintent.in_windows(NOW, w))          # 2026-09-25 就是中秋

    def test_recent_is_seven_days(self):
        w = windows_of("他最近几点还在跟你聊天")
        self.assertTrue(len(w) >= 1)
        self.assertTrue(timeintent.in_windows(NOW - 3 * 86400.0, w))
        self.assertFalse(timeintent.in_windows(NOW - 30 * 86400.0, w))

    def test_last_week_excludes_today(self):
        w = windows_of("他上周说了什么")
        self.assertFalse(timeintent.in_windows(NOW, w))
        self.assertTrue(timeintent.in_windows(NOW - 8 * 86400.0, w))

    def test_clock_with_hour_narrows(self):
        w = windows_of("中秋那天凌晨一点他想干嘛")
        self.assertTrue(len(w) >= 1)
        import time as _t
        one_am = _t.mktime((2026, 9, 25, 1, 0, 0, 0, 0, -1))
        three_pm = _t.mktime((2026, 9, 25, 15, 0, 0, 0, 0, -1))
        self.assertTrue(timeintent.in_windows(one_am, w))
        self.assertFalse(timeintent.in_windows(three_pm, w))    # 收窄到凌晨,不覆盖下午

    def test_band_word_alone(self):
        w = windows_of("他晚上说的话")
        import time as _t
        eight_pm = _t.mktime((2026, 9, 25, 20, 0, 0, 0, 0, -1))
        self.assertTrue(timeintent.in_windows(eight_pm, w))

    # ---------------- 不该产窗口(负控)
    def test_no_cue_no_window(self):
        for q in ("他最喜欢吃什么", "他为什么非要自己做这个东西",
                  "他到底有没有逃课", "他那个项目还有谁在弄"):
            self.assertEqual(windows_of(q), [], q)

    def test_vague_cue_no_window(self):
        """「那天/上次/当时」没有锚点 —— 只记录,不产窗口。"""
        ti = timeintent.parse_time_intent("上次他说了什么", NOW)
        self.assertEqual(ti["windows"], [])
        self.assertTrue(ti["vague"])

    def test_bare_hour_no_window(self):
        """光一个「三点」不知道是凌晨还是下午 ⇒ 不产窗口。"""
        self.assertEqual(windows_of("他三点在干嘛"), [])

    def test_question_word_no_window(self):
        """「几点」是疑问词,不是线索。"""
        self.assertEqual(windows_of("他几点睡的"), [])

    # ---------------- 接口不变量
    def test_empty_and_none_query(self):
        for q in ("", None):
            self.assertEqual(timeintent.parse_time_intent(q, NOW)["windows"], [])

    def test_in_windows_boundaries_half_open(self):
        lo, hi = NOW, NOW + 3600.0
        w = [(lo, hi, "t")]
        self.assertTrue(timeintent.in_windows(lo, w))
        self.assertFalse(timeintent.in_windows(hi, w))          # 左闭右开
        self.assertFalse(timeintent.in_windows(0, w))           # 没有时间的记忆不算

    def test_in_windows_empty(self):
        self.assertFalse(timeintent.in_windows(NOW, []))


if __name__ == "__main__":
    unittest.main()
