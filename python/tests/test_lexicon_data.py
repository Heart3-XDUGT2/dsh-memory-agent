# -*- coding: utf-8 -*-
"""P3 B1「词表」#5:引擎侧停用词的**数据覆盖读点**(`lexicon.json.stopwords`)。

为什么要这组测试:`lexicon.json.stopwords` 此前只喂了 JS 侧(`lib/lexical.js`),
`python/engine/lexical.py` 与 `python/engine/graph.py` 各有一份写死的表 ——
面板能写、引擎读不到(P3 迁移设计 §1.5 的"哑字段")。通路 = 帧里
`frame["data"]["lexicon"]["stopwords"]` → `configure_from_data()` → `_stopwords()`。

三条纪律各有一个负控(对齐 `python/tests/test_frame_data.py` 的风格):
  * 帧里没有 / 坏形状 ⇒ **回落内置表 = 迁移前行为**(且不抛);
  * 有数据 ⇒ 行为按数据变(整表覆盖);
  * `lexical` 的词元缓存必须跟着清 —— 否则"数据落盘即生效"是假的。
"""
import contextlib
import io
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import worker  # noqa: E402  —— 侧车在 python/ 下(不在 engine/ 包里)
from engine import graph  # noqa: E402
from engine import lexical  # noqa: E402


def reset():
    """把两个模块恢复成"数据为空"的状态(模块级覆盖会残留)。"""
    lexical.configure_from_data({})
    graph.configure_from_data({})


class LexicalStopwordsOverride(unittest.TestCase):
    def tearDown(self):
        reset()

    def test_empty_data_keeps_builtin_table(self):
        reset()
        self.assertNotIn("为什", lexical.tokenize("为什么"), "内置表照旧剔功能词")
        self.assertIn("火车", lexical.tokenize("坐火车"), "内置表里没有「火车」⇒ 留着")
        self.assertIs(lexical._stopwords(), lexical.STOPWORDS)

    def test_data_replaces_table(self):
        lexical.configure_from_data({"lexicon": {"stopwords": ["火车"]}})
        self.assertNotIn("火车", lexical.tokenize("坐火车"), "数据表生效")
        self.assertIn("为什", lexical.tokenize("为什么"),
                      "数据是**整表** ⇒ 内置表那条不再生效(迁移时要把整表搬过来)")

    def test_cache_is_cleared_when_table_changes(self):
        reset()
        self.assertIn("火车", lexical.tokenize("坐火车"))
        lexical.configure_from_data({"lexicon": {"stopwords": ["火车"]}})
        self.assertNotIn("火车", lexical.tokenize("坐火车"),
                         "词元表是按输入文本记忆化的 ⇒ 换表必须清缓存")

    def test_dirty_data_falls_back_and_never_throws(self):
        for bad in (None, [], "x", {}, {"lexicon": {}}, {"lexicon": {"stopwords": []}},
                    {"lexicon": {"stopwords": [7, "", "  "]}},
                    {"lexicon": {"stopwords": "火车"}}, {"lexicon": []}):
            lexical.configure_from_data(bad)
            self.assertIs(lexical._stopwords(), lexical.STOPWORDS,
                          "脏数据 ⇒ 回落内置表: %r" % (bad,))


class GraphStopwordsOverride(unittest.TestCase):
    def tearDown(self):
        reset()

    def test_empty_data_keeps_builtin_table(self):
        reset()
        self.assertEqual(graph.extract_seed_nodes("你好"), ["你好"])
        self.assertIs(graph._stopwords(), graph.STOPWORDS)

    def test_data_replaces_table(self):
        graph.configure_from_data({"lexicon": {"stopwords": ["你好"]}})
        self.assertEqual(graph.extract_seed_nodes("你好"), [], "数据表生效(种子被剔掉)")

    def test_dirty_data_falls_back_and_never_throws(self):
        for bad in (None, [], "x", {}, {"lexicon": {}}, {"lexicon": {"stopwords": []}},
                    {"lexicon": {"stopwords": [7, ""]}}, {"lexicon": {"stopwords": 5}}):
            graph.configure_from_data(bad)
            self.assertIs(graph._stopwords(), graph.STOPWORDS,
                          "脏数据 ⇒ 回落内置表: %r" % (bad,))


class WorkerDispatch(unittest.TestCase):
    """worker 每帧分发:帧里的词表必须真的到达 lexical / graph(只改分发白名单那一行)。"""

    def tearDown(self):
        reset()

    def test_frame_data_reaches_both_modules(self):
        reset()
        frame = {"type": "hello", "protocol": "nope",
                 "data": {"version": 1, "lexicon": {"stopwords": ["火车", "你好"]}}}
        with contextlib.redirect_stdout(io.StringIO()) as out:
            ret = worker.handle(frame, {})
        self.assertEqual(ret, "fatal", "协议不认识 ⇒ 照旧快速失败(与数据分发无关)")
        self.assertTrue(out.getvalue().strip().startswith("{"), "错误帧仍走 stdout 协议帧")
        self.assertNotIn("火车", lexical.tokenize("坐火车"), "帧里的数据分发到了 lexical")
        self.assertEqual(graph.extract_seed_nodes("你好"), [], "帧里的数据分发到了 graph")

    def test_frame_without_data_keeps_builtin_tables(self):
        reset()
        with contextlib.redirect_stdout(io.StringIO()):
            worker.handle({"type": "hello", "protocol": "nope"}, {})
        self.assertIs(lexical._stopwords(), lexical.STOPWORDS)
        self.assertIs(graph._stopwords(), graph.STOPWORDS)


if __name__ == "__main__":
    unittest.main()
