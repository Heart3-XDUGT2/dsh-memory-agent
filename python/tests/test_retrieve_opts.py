# -*- coding: utf-8 -*-
"""2026-09-30 三项(常驻不占席 / 词法长尾臂 / 时间臂)的引擎侧单测。

纪律:**每一项都要有负控** ——
  · core_block=False ⇒ 与老行为逐位一致(证据席位被 L0 吃掉);
  · lexArm 不开 ⇒ 输出里**不出现** `fused_pool` 这个键(默认关是干净的);
  · time_arm 不开 ⇒ 输出里不出现 `in_time`(同上)。
"""
import os
import sys
import time
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from engine import retrieve as R  # noqa: E402

NOW = 1_800_000_000.0


def _row(mid, layer, summary, ts_off=0.0, iv=10.0, emo=0.0):
    return {
        "memory_id": mid, "layer": layer, "summary": summary,
        "timestamp": NOW + ts_off, "occurred_at": NOW + ts_off,
        "half_life": 24.0, "last_recalled": NOW + ts_off,
        "intrinsic_value": iv, "emotion_score": emo, "status": "active",
    }


class CoreBlockTest(unittest.TestCase):
    """常驻块:占席(老) vs 独立区块(新)。"""

    def setUp(self):
        # 1 条 L0 + 6 条常规;只有前 3 条常规与查询相关 ⇒ 老行为下证据席位被吃掉。
        self.rows = [
            _row(1, "L0", "他是谁:长期身份", ts_off=-86400.0, iv=90.0),
            _row(10, "L1", "面试 面试 面试 面试", ts_off=-3600.0),
            _row(11, "L1", "面试 面试 面试", ts_off=-7200.0),
            _row(12, "L1", "面试 面试", ts_off=-10800.0),
            _row(13, "L1", "无关 的事 一号", ts_off=-100.0),
            _row(14, "L1", "无关 的事 二号", ts_off=-200.0),
            _row(15, "L1", "无关 的事 三号", ts_off=-300.0),
        ]
        self.q = "面试"

    def test_core_block_off_keeps_old_shape(self):
        """负控:关着的时候 = 老行为(L0 占一席,证据只剩 top_k-1 条)。"""
        out = R.rank_memories([dict(r) for r in self.rows], self.q, 3, NOW,
                              core_block=False)
        self.assertEqual(len(out), 3)
        self.assertTrue(out[0].get("forced"), "老行为:L0 排在最前且被标 forced")
        self.assertEqual(len([it for it in out if it.get("forced")]), 1)

    def test_core_block_on_evidence_slots_not_eaten(self):
        """开着的时候:证据席位满 top_k,常驻块挂在**后面**、自己的名额。"""
        out = R.rank_memories([dict(r) for r in self.rows], self.q, 3, NOW,
                              core_block=True)
        evidence = [it for it in out if not it.get("forced")]
        block = [it for it in out if it.get("forced")]
        self.assertEqual(len(evidence), 3, "证据席位应满 top_k(不被常驻吃掉)")
        self.assertEqual(len(block), 1, "常驻块:这条 L0")
        self.assertEqual(out[-1].get("layer"), "L0", "常驻块挂在最后")
        self.assertTrue(all(it.get("layer") != "L0" for it in evidence))

    def test_core_block_off_is_byte_identical_across_calls(self):
        """幂等 + 默认值就是老行为:不传 core_block 与显式 False 一致。"""
        a = R.rank_memories([dict(r) for r in self.rows], self.q, 3, NOW)
        b = R.rank_memories([dict(r) for r in self.rows], self.q, 3, NOW,
                            core_block=False)
        self.assertEqual([it["memory_id"] for it in a], [it["memory_id"] for it in b])

    def test_core_block_total_items_grow_by_block_only(self):
        """token 账:多的条目**只有常驻块**那几条,不是又塞了一批相关记忆。"""
        off = R.rank_memories([dict(r) for r in self.rows], self.q, 3, NOW,
                              core_block=False)
        on = R.rank_memories([dict(r) for r in self.rows], self.q, 3, NOW,
                             core_block=True)
        self.assertEqual(len(on) - len(off), 1, "差的就是那 1 条常驻")


class LexArmTest(unittest.TestCase):
    """词法长尾臂:只有显式打开才动;不开时输出不带新键。"""

    def setUp(self):
        self.rows = [
            _row(1, "L0", "他是谁:长期身份", ts_off=-86400.0, iv=90.0),
            _row(20, "L1", "面试 面试 面试", ts_off=-3600.0),
            # 长尾:只撞一个词元 ⇒ 覆盖率低(过不了门槛那类),但词法名次在
            _row(21, "L1", "面试", ts_off=-90000.0),
            _row(22, "L1", "无关 的事", ts_off=-100.0),
        ]
        self.q = "面试"

    def test_lex_arm_off_no_new_keys(self):
        out = R.rank_memories([dict(r) for r in self.rows], self.q, 3, NOW,
                              core_block=False)
        for it in out:
            self.assertNotIn("fused_pool", it, "没开长尾臂 ⇒ 不许出现 fused_pool")

    def test_lex_arm_on_marks_promoted(self):
        out = R.rank_memories([dict(r) for r in self.rows], self.q, 3, NOW,
                              core_block=True,
                              fusion={"enabled": True, "mode": "reorder", "lexArm": True})
        self.assertTrue(any(it.get("fused_pool") for it in out),
                        "开了长尾臂就该有被捞上来的长尾(打 fused_pool 标记)")

    def test_lex_arm_only_when_fusion_enabled(self):
        """负控:只给 lexArm 不给 enabled ⇒ 不生效(不许蹭开关)。"""
        out = R.rank_memories([dict(r) for r in self.rows], self.q, 3, NOW,
                              core_block=True, fusion={"lexArm": True})
        for it in out:
            self.assertNotIn("fused_pool", it)


class TimeArmTest(unittest.TestCase):
    """时间臂:默认关 ⇒ 不带键(与旧输出逐位一致)。"""

    def setUp(self):
        self.rows = [_row(30, "L1", "中秋 那天 拍了 月亮", ts_off=-86400.0)]
        self.q = "中秋那天他说了什么"

    def test_time_arm_off_no_keys(self):
        out = R.rank_memories([dict(r) for r in self.rows], self.q, 3, NOW)
        for it in out:
            self.assertNotIn("in_time", it)
            self.assertNotIn("time_rescued", it)

    def test_time_arm_on_adds_keys(self):
        out = R.rank_memories([dict(r) for r in self.rows], self.q, 3, NOW,
                              time_arm=True)
        self.assertTrue(all("in_time" in it for it in out))

    def test_scoped_mode_adds_scope_key(self):
        out = R.rank_memories([dict(r) for r in self.rows], self.q, 3, NOW,
                              time_arm=True, time_mode="scoped")
        self.assertTrue(all("in_time_scoped" in it for it in out))


class ExpandScoreTest(unittest.TestCase):
    """查询扩展进主打分:默认关;开了才允许"只靠扩展词命中"的记忆进榜。"""

    def setUp(self):
        self.rows = [
            _row(40, "L1", "面试 面试 面试", ts_off=-3600.0),
            # 与问法**一个字都不重**;只与扩展词同字面
            _row(41, "L1", "深夜 熬夜 夜聊", ts_off=-7200.0),
            _row(42, "L1", "无关 的事", ts_off=-100.0),
        ]
        self.q = "他最近几点还没睡"
        self.ext = ["深夜", "凌晨", "熬夜", "夜聊"]

    def _ids(self, **kw):
        out = R.rank_memories([dict(r) for r in self.rows], self.q, 3, NOW, **kw)
        return [it["memory_id"] for it in out]

    def test_off_is_old_behavior(self):
        """负控:不开 ⇒ 扩展词一个都不进打分(有词没词读数一致)。"""
        self.assertEqual(self._ids(), self._ids(extra_terms=self.ext, expand_score=False))

    def test_on_pulls_expansion_only_memory(self):
        """开了 ⇒ 只靠扩展词命中的那条能进来(gi13 那条的机制)。"""
        off = self._ids(extra_terms=self.ext, expand_score=False)
        on = self._ids(extra_terms=self.ext, expand_score=True)
        self.assertNotIn(41, off, "不开时它是词面撞不上的(不该在榜)")
        self.assertIn(41, on, "开了就该靠扩展词进来")

    def test_no_terms_no_effect(self):
        """给了开关但没给词 ⇒ 与老行为一致(空手不能改读数)。"""
        self.assertEqual(self._ids(expand_score=True), self._ids())

    def test_terms_are_tokenized_like_query(self):
        """扩展词必须**按查询同一套词元规则切** —— 直接当整词递进去会漏(实测踩过)。"""
        one = self._ids(extra_terms=["深夜"], expand_score=True)
        self.assertIn(41, one)


class AugKeysTest(unittest.TestCase):
    """写入侧说法键进打分:默认关(量台/历史不动);开了才吃 aug_keys。"""

    def setUp(self):
        self.rows = [
            _row(50, "L1", "猫 猫 猫", ts_off=-3600.0),
            _row(51, "L1", "把 Echo 打造成心目中的样子", ts_off=-7200.0),
        ]
        self.rows[1]["aug_keys"] = '["亲手做", "自己动手"]'
        self.q = "他为什么非要自己做这个东西"

    def _ids(self, **kw):
        out = R.rank_memories([dict(r) for r in self.rows], self.q, 5, NOW, **kw)
        return [it["memory_id"] for it in out]

    def test_off_is_old_behavior(self):
        """负控:不开 ⇒ 库里有键也不参与(逐位等于老行为)。"""
        off = self._ids()
        self.assertEqual(off, [])
        # 把键摘掉再跑(不开)⇒ 同样读数:说明"没键/不开"是一回事
        stripped = [dict(r) for r in self.rows]
        stripped[1]["aug_keys"] = None
        self.assertEqual([it["memory_id"] for it in
                          R.rank_memories(stripped, self.q, 5, NOW)], off)

    def test_on_pulls_the_row(self):
        self.assertIn(51, self._ids(aug_keys=True))
        self.assertNotIn(50, self._ids(aug_keys=True))

    def test_dirty_or_missing_keys_are_ignored(self):
        """脏值(非 JSON/空)当空 —— 一行脏数据不许炸掉整轮。"""
        rows = [dict(r) for r in self.rows]
        for bad in ("不是 JSON", "", None, 123):
            rows[1]["aug_keys"] = bad
            self.assertEqual([it["memory_id"] for it in
                              R.rank_memories(rows, self.q, 5, NOW, aug_keys=True)], [])


if __name__ == "__main__":
    unittest.main(verbosity=2)
