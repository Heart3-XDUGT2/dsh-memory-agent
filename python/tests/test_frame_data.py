# -*- coding: utf-8 -*-
"""P3-a「通路先行」:引擎帧里的**数据块**(关系表 / 词表 / 状态初值)。

为什么要这组测试:数据文件(P3 要往里搬值)在引擎侧**一个读点都没有** ——
面板能写、引擎读不到。通路 = 壳侧 `lib/data-tables.js::frameData()` 下发
`frame["data"]`,引擎侧 `graph_gate.data_from_frame()` 解析,再由各模块
`configure_from_data()` 覆盖内置表。

三条纪律各有一个负控(对齐 `python/tests/test_graph_gate.py:2278` 的既有风格):
  * 帧里没有 / 坏形状 ⇒ **回落内置表 = 迁移前行为**(且不抛);
  * 有数据 ⇒ 行为按数据变;
  * 任何脏数据都不许把这一帧带崩。
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from engine import graph_gate  # noqa: E402
from engine import judge  # noqa: E402
from engine import relations  # noqa: E402
from engine import timeintent  # noqa: E402

#: 壳侧 `frameData()` 的形状(值只是测试用的假值)
GOOD_FRAME = {
    "data": {
        "version": 1,
        "graph": {"relations": {"canonical": {"读于": "念", "念": "念"}},
                  "display": {}, "windows": {}},
        "lexicon": {"timeWords": {"day": {"昨儿": -1},
                                  "clock": {"响午": [11, 13]}},
                    "stopwords": [], "topicStopwords": []},
        "stateDefaults": {"moodIntensity": 6},
    }
}


def reset():
    """把三个模块都恢复成"数据为空"的状态(模块级覆盖会残留)。"""
    for mod in (relations, timeintent, judge):
        mod.configure_from_data({})


class DataFromFrame(unittest.TestCase):
    def tearDown(self):
        reset()

    def test_parses_good_frame(self):
        d = graph_gate.data_from_frame(GOOD_FRAME)
        self.assertEqual(d["version"], 1)
        self.assertEqual(d["graph"]["relations"]["canonical"]["读于"], "念")
        self.assertEqual(d["lexicon"]["timeWords"]["day"], {"昨儿": -1})
        self.assertEqual(d["stateDefaults"]["moodIntensity"], 6)

    def test_bad_frame_is_empty_and_never_throws(self):
        for bad in (None, [], "x", 0, {}, {"data": None}, {"data": []},
                    {"data": {"version": "1"}}, {"data": {"version": True}},
                    {"data": {"graph": []}}, {"data": {"version": 1}}):
            self.assertIsInstance(graph_gate.data_from_frame(bad), dict)
        self.assertEqual(graph_gate.data_from_frame(None), {})
        self.assertEqual(graph_gate.data_from_frame({"data": {"version": "1"}}), {},
                         "版本位不是整数 ⇒ 整块忽略(壳/引擎错配兜底)")
        d = graph_gate.data_from_frame({"data": {"version": 1, "graph": [], "lexicon": {}}})
        self.assertNotIn("graph", d, "段不是对象 ⇒ 丢该段")
        self.assertEqual(d["lexicon"], {})


class RelationsOverride(unittest.TestCase):
    def tearDown(self):
        reset()

    def test_empty_data_keeps_builtin_table(self):
        reset()
        self.assertEqual(relations.canonical_relation("读于"), "就读于")
        self.assertIn(("搭建", "负责"), list(relations.relation_merges().items()))
        self.assertEqual(relations.canonical_relation("表外写法"), "表外写法")

    def test_data_replaces_table(self):
        relations.configure_from_data(GOOD_FRAME)
        self.assertEqual(relations.canonical_relation("读于"), "念", "数据表生效")
        self.assertEqual(relations.canonical_relation("念"), "念", "自映射(值==键)")
        self.assertEqual(relations.canonical_relation("就读"), "就读",
                         "数据是**整表** ⇒ 内置表里那条不再生效(迁移时要把整表搬过来)")
        self.assertEqual(relations.relation_merges(), {"读于": "念"})

    def test_dirty_data_falls_back(self):
        for bad in ({}, {"graph": {}}, {"graph": {"relations": {}}},
                    {"graph": {"relations": {"canonical": []}}},
                    {"graph": {"relations": {"canonical": {"  ": "  "}}}}):
            relations.configure_from_data(bad)
            self.assertEqual(relations.canonical_relation("读于"), "就读于")
        relations.configure_from_data(None)
        self.assertEqual(relations.canonical_relation("读于"), "就读于")


class TimeWordsOverride(unittest.TestCase):
    def tearDown(self):
        reset()

    def _windows(self, q):
        return timeintent.parse_time_intent(q, 1789000000.0)["windows"]

    def test_empty_data_keeps_builtin_tables(self):
        reset()
        self.assertTrue(self._windows("今天"), "内置「今天」照常产窗口")
        self.assertEqual(self._windows("昨儿"), [], "内置表里没有「昨儿」⇒ 不产窗口")

    def test_data_replaces_tables(self):
        timeintent.configure_from_data(GOOD_FRAME)
        self.assertTrue(self._windows("昨儿"), "数据里的自定义线索生效")
        self.assertEqual(self._windows("今天"), [],
                         "数据是整表 ⇒ 内置「今天」不再生效(迁移要整表搬)")

    def test_dirty_data_falls_back(self):
        for bad in ({}, {"lexicon": {}}, {"lexicon": {"timeWords": []}},
                    {"lexicon": {"timeWords": {"day": {"今天": "x"}}}},
                    {"lexicon": {"timeWords": {"day": {"": 0}, "span": {"最近": [1]}}}}):
            timeintent.configure_from_data(bad)
            self.assertTrue(self._windows("今天"), "脏数据 ⇒ 回落内置表")
        timeintent.configure_from_data({"lexicon": {"timeWords": {"day": {"今天": 0}}}})
        self.assertTrue(self._windows("今天"))


class StateDefaultsOverride(unittest.TestCase):
    def tearDown(self):
        reset()

    def test_default_is_three(self):
        reset()
        self.assertEqual(judge._mood_default(), 3, "空数据 ⇒ 迁移前的 3")

    def test_data_overrides_default(self):
        judge.configure_from_data(GOOD_FRAME)
        self.assertEqual(judge._mood_default(), 6)
        judge.configure_from_data({"stateDefaults": {"moodIntensity": "9"}})
        self.assertEqual(judge._mood_default(), 3, "字符串不算数 ⇒ 回落")
        judge.configure_from_data({"stateDefaults": {"moodIntensity": True}})
        self.assertEqual(judge._mood_default(), 3, "布尔不算数 ⇒ 回落")


if __name__ == "__main__":
    unittest.main()
