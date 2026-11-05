# -*- coding: utf-8 -*-
"""P3-c:关系表的**数据覆盖读点**(`graph.json.relations.*`,七张子表)。

为什么单独一组:这七张子表的**消费点散在四个模块** —— `relations.py`(规范写法 /
单值关系 / 多值键 / 待定表)、`graph_gate.py`(类型规则 / 默认谓词)、`l0_tier.py`
(身份谓词)、`normalize_relations.py`(待定表报表)。而 worker 每帧只对
`relations / timeintent / judge` 调 `configure_from_data()`(`python/worker.py:136-141`),
所以帧**只解析一遍**(在 `relations`),其余模块经它的取值函数读。这组测试钉的就是这条链:

  * 空 / 缺 / 坏 ⇒ 七张子表**各回各的内置表**,行为与迁移前逐位一致(P3 硬验收);
  * 有数据 ⇒ 每个消费点都真的**改了行为**(不是"写了个哑字段");
  * 脏行 / 脏形状 ⇒ 丢掉该行或该表,再回内置,**绝不抛**。
"""
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from engine import db  # noqa: E402
from engine import graph  # noqa: E402
from engine import graph_gate as gate  # noqa: E402
from engine import l0_tier  # noqa: E402
from engine import normalize_relations as norm  # noqa: E402
from engine import relations  # noqa: E402

#: 壳侧 `lib/data-tables.js::frameData()` 下发的形状(值只是测试用的假值)
FULL_FRAME = {
    "data": {
        "version": 1,
        "graph": {"relations": {
            "singleValue": ["喜欢玩"],
            "multiValueKeys": ["current_project"],
            "identityRelations": ["喜欢玩"],
            "pending": [{"variant": "专业是", "candidate": "就读于", "why": "两可"}],
            "typeRules": [{"relation": "喜欢玩", "pairs": [["person", "concept"]]}],
            "defaultRelation": "有关",
        }},
    }
}

#: 端点类型表用的小节点快照(照 `test_graph_gate.py` 的夹具形状)
NODES = [
    {"node_id": "n_user", "name": "用户", "node_type": "person"},
    {"node_id": "n_kar", "name": "KARDS", "node_type": "concept"},
]
CTX = gate.build_context(NODES, {})


def fact(source_id, target_id, relation):
    """一条事实候选边(形状照 `test_graph_gate.py` 的同名夹具)。"""
    return {"kind": "", "source_id": source_id, "target_id": target_id,
            "relation": relation, "weight": 1}


def builtins():
    """七张子表的内置值(空数据时读点必须逐位回它们)。"""
    return {
        "single": relations.SINGLE_VALUE_RELATIONS,
        "multi": relations.MULTIVALUE_MEMORY_KEYS,
        "pending": relations.RELATION_PENDING,
        "typeRules": gate.RELATION_TYPE_RULES,
        "default": gate.FACT_DEFAULT_RELATION,
        "identity": frozenset(l0_tier.IDENTITY_RELATIONS),
    }


class OverrideChain(unittest.TestCase):
    """帧 → `relations` → 四个消费点。"""

    def setUp(self):
        # 模块级覆盖会残留:每条用例跑完都复原成"数据为空"。
        self.addCleanup(relations.configure_from_data, {})

    def assertAllBuiltin(self, msg=""):
        """七张子表全部等于内置值(等价性断言的统一出口)。"""
        b = builtins()
        self.assertEqual(relations.single_value_relations(), b["single"], msg)
        self.assertEqual(relations.multi_value_memory_keys(), b["multi"], msg)
        self.assertIs(relations.pending_relations(), b["pending"], msg)
        self.assertEqual(relations.type_rules_data(), None, msg)
        self.assertEqual(relations.default_relation_data(), None, msg)
        self.assertEqual(relations.identity_relations_data(), None, msg)
        self.assertEqual(gate.relation_type_rules(), b["typeRules"], msg)
        self.assertEqual(gate.default_relation(), b["default"], msg)
        self.assertEqual(l0_tier.identity_relations(), b["identity"], msg)

    def test_empty_or_bad_data_keeps_every_builtin_table(self):
        """空 / 缺 / 坏形状 ⇒ 七张子表各回各的内置表(迁移前行为,且不抛)。"""
        for bad in ({}, None, [], "x", {"graph": {}}, {"graph": []},
                    {"graph": {"relations": {}}}, {"graph": {"relations": []}}):
            relations.configure_from_data(bad)
            self.assertAllBuiltin(repr(bad))

    def test_empty_data_keeps_old_behaviour(self):
        """不只是"表相等":消费点的判定也得与迁移前一样。"""
        relations.configure_from_data({})
        self.assertFalse(relations.is_single_value_relation("喜欢玩"), "内置表里没有它")
        self.assertFalse(relations.is_multi_value_memory_key("current_project"))
        self.assertFalse(l0_tier.is_identity_relation("喜欢玩"))
        self.assertIsNone(gate.relation_type_rules().get("喜欢玩"), "表外谓词:不猜")
        v = gate.gate_edge(fact("n_user", "n_kar", ""), CTX, enabled=True)
        self.assertEqual(v["edge"]["relation"], "相关", "空谓词照旧补内置默认值")

    def test_data_replaces_every_table(self):
        """有数据 ⇒ 整表替换(内置里没被列到的**不再生效**)。"""
        relations.configure_from_data(FULL_FRAME)
        self.assertEqual(relations.single_value_relations(), frozenset({"喜欢玩"}))
        self.assertTrue(relations.is_single_value_relation("喜欢玩"))
        self.assertFalse(relations.is_single_value_relation("是"), "数据是整表 ⇒ 内置那 15 条不再生效")
        self.assertEqual(relations.multi_value_memory_keys(), frozenset({"current_project"}))
        self.assertTrue(relations.is_multi_value_memory_key("current_project"))
        self.assertFalse(relations.is_multi_value_memory_key("longTermInterests"))
        self.assertEqual([p["variant"] for p in relations.pending_relations()], ["专业是"])
        self.assertEqual(relations.pending_relations()[0]["why"], "两可")
        self.assertEqual(l0_tier.identity_relations(), frozenset({"喜欢玩"}))
        self.assertTrue(l0_tier.is_identity_relation("喜欢玩"))
        self.assertFalse(l0_tier.is_identity_relation("是"))
        self.assertEqual(gate.relation_type_rules(), {"喜欢玩": [("person", "concept")]})
        self.assertEqual(gate.default_relation(), "有关")

    def test_also_accepts_the_whole_frame(self):
        """防呆:`frame` 与 `frame["data"]` 两种形状都收(与 P3-a 的口径一致)。"""
        relations.configure_from_data({"type": "x", "data": FULL_FRAME["data"]})
        self.assertTrue(relations.is_single_value_relation("喜欢玩"))

    def test_gate_verdict_really_changes(self):
        """数据表要**真的改裁决**:类型规则 / 默认谓词 / 方向改正各一条。"""
        # ① 类型规则:内置 `就读于` = person → concept;数据改成 concept → concept ⇒
        #    「用户(person) -[就读于]-> KARDS」不再命中,丢边(内置口径会放行)。
        relations.configure_from_data({"graph": {"relations": {
            "typeRules": {"就读于": [["concept", "concept"]]}}}})
        v = gate.gate_edge(fact("n_user", "n_kar", "就读于"), CTX, enabled=True)
        self.assertEqual((v["accepted"], v["reason"]), (False, "bad-endpoint-type"))

        # ② 默认谓词:空谓词的事实边按数据补齐
        relations.configure_from_data({"graph": {"relations": {"defaultRelation": "有关"}}})
        v = gate.gate_edge(fact("n_user", "n_kar", ""), CTX, enabled=True)
        self.assertEqual(v["edge"]["relation"], "有关")

        # ③ 方向:数据新增一条 person → concept 的规则,反着写 ⇒ 自动交换两端
        relations.configure_from_data({"graph": {"relations": {
            "typeRules": {"喜欢玩": [["person", "concept"]]}}}})
        v = gate.gate_edge(fact("n_kar", "n_user", "喜欢玩"), CTX, enabled=True)
        self.assertEqual((v["action"], v["reason"]), ("rewrite", "bad-direction"))
        self.assertEqual((v["edge"]["source_id"], v["edge"]["target_id"]), ("n_user", "n_kar"))

    def test_pending_table_reaches_the_report(self):
        """待定表的消费点在 `normalize_relations.survey()`,不是只被读出来。"""
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        conn = db.connect(os.path.join(tmp.name, "echo.db"))
        self.addCleanup(conn.close)
        graph.add_edge(conn, "用户", "搞过", "某个项目", "master")

        relations.configure_from_data({})
        self.assertEqual(norm.survey(conn, "master")["pending"], [],
                         "内置待定表里没有「搞过」⇒ 报表不认它")
        relations.configure_from_data({"graph": {"relations": {
            "pending": [{"variant": "搞过", "candidate": "负责", "why": "数据说了算"}]}}})
        pend = norm.survey(conn, "master")["pending"]
        self.assertEqual([p["variant"] for p in pend], ["搞过"])
        self.assertEqual(pend[0]["candidate"], "负责")
        self.assertIn("搞过", pend[0]["in_live"])


class DirtyShapes(unittest.TestCase):
    """容错:**脏行丢掉、脏表回落**,一行都不许把这一帧带崩。"""

    def setUp(self):
        self.addCleanup(relations.configure_from_data, {})

    def test_dirty_shapes_fall_back_to_builtin(self):
        cases = [
            {"graph": {"relations": {"singleValue": []}}},
            {"graph": {"relations": {"singleValue": ["  ", 7, None]}}},
            {"graph": {"relations": {"multiValueKeys": "longTermInterests"}}},
            {"graph": {"relations": {"identityRelations": [{}]}}},
            {"graph": {"relations": {"pending": [{"candidate": "就读于"}, "x", []]}}},
            {"graph": {"relations": {"typeRules": "就读于"}}},
            {"graph": {"relations": {"typeRules": [{"relation": "就读于"}]}}},
            {"graph": {"relations": {"defaultRelation": "   "}}},
        ]
        for bad in cases:
            relations.configure_from_data(bad)
            b = builtins()
            self.assertEqual(relations.single_value_relations(), b["single"], repr(bad))
            self.assertEqual(relations.multi_value_memory_keys(), b["multi"], repr(bad))
            self.assertIs(relations.pending_relations(), b["pending"], repr(bad))
            self.assertEqual(relations.type_rules_data(), None, repr(bad))
            self.assertEqual(relations.default_relation_data(), None, repr(bad))
            self.assertEqual(relations.identity_relations_data(), None, repr(bad))

    def test_dirty_rows_are_dropped_row_by_row(self):
        """一半干净一半脏:干净的留下,脏的**只丢那一行**。"""
        relations.configure_from_data({"graph": {"relations": {
            "singleValue": ["", "住在", 5],
            "pending": [{"variant": "专业是", "candidate": 7, "why": None},
                        {"variant": "  "}, "整行坏"],
            "typeRules": [{"relation": "就读于",
                           "pairs": [["person", "concept"], ["猫", "狗"], ["person"]]},
                          {"relation": "坏的", "pairs": "不是列表"}],
            "defaultRelation": " 有关 ",
        }}})
        self.assertEqual(relations.single_value_relations(), frozenset({"住在"}))
        self.assertEqual(relations.pending_relations(),
                         ({"variant": "专业是", "candidate": "", "why": ""},),
                         "非字符串的 candidate / why 当空串,不是整行丢")
        self.assertEqual(gate.relation_type_rules(), {"就读于": [("person", "concept")]})
        self.assertEqual(gate.default_relation(), "有关")

    def test_type_rules_accepts_the_frozen_spec_shape(self):
        """`lib/data-schema.js:299` 把 typeRules 冻成 `string[]` ⇒ **名字数组必须认**。

        (设计 §2.1 #10 的主形状是对象数组,但那个形状现在过不了写入校验 ——
        面板写不进来。读点先认三种,形状拍板后不用再改。)
        """
        relations.configure_from_data({"graph": {"relations": {"typeRules": ["就读于", "", 5]}}})
        self.assertEqual(gate.relation_type_rules(), {"就读于": [("person", "concept")]})

        relations.configure_from_data({"graph": {"relations": {"typeRules": {
            "就读于": [["concept", "concept"]]}}}})
        self.assertEqual(gate.relation_type_rules(), {"就读于": [("concept", "concept")]},
                         "扁平对象(设计里的备选形状)也认")


if __name__ == "__main__":
    unittest.main()
