"""RT10 融合器单测(纯函数,不碰库)。

这些断言**钉的是口径**,不是实现细节:RFF 分怎么算、绝对阈值与滞回的先后、
配置写反了怎么办。数字一旦漂了,金标分档的对比就白做了。
"""
import unittest

from engine import fusion


def _items(rows):
    return [{"memory_id": mid, **rest} for mid, rest in rows]


class RrfTest(unittest.TestCase):
    def test_臂内排名决定分数_榜一拿得最多(self):
        items = _items([
            (1, {"hits": 0.9, "r_now": 0.1, "emotion_score": 0.0}),
            (2, {"hits": 0.5, "r_now": 0.9, "emotion_score": 0.0}),
        ])
        scores = fusion.rrf_fuse(items)
        # 情绪臂这一对是**平局**(都是 0.0)⇒ 按 id 稳定排序,小的排前面
        # (实测差异 2.6e-4:不是"应该相等",而是"平局也得有确定的规矩")
        self.assertGreater(scores[1], scores[2])
        self.assertAlmostEqual(scores[1] - scores[2], 1.0 / 61 - 1.0 / 62, places=12)
        self.assertAlmostEqual(scores[1], 2.0 / 61 + 1.0 / 62, places=12)

    def test_三臂全排第一的条目分数最高(self):
        items = _items([
            (1, {"hits": 0.9, "r_now": 0.9, "emotion_score": 0.9}),
            (2, {"hits": 0.1, "r_now": 0.1, "emotion_score": 0.1}),
        ])
        scores = fusion.rrf_fuse(items)
        self.assertGreater(scores[1], scores[2])
        self.assertAlmostEqual(scores[1], 3.0 / 61, places=12)
        self.assertAlmostEqual(fusion.max_possible(), 3.0 / 61, places=12)
        self.assertAlmostEqual(fusion.normalize(scores)[1], 1.0, places=12,
                               msg='归一化之后"三臂全第一"必须正好是 1.0 —— 阈值旋钮的刻度就靠这个')

    def test_融合不许扩大候选池(self):
        items = _items([(7, {"hits": 1.0}), (8, {"hits": 0.2})])
        scores = fusion.rrf_fuse(items)
        self.assertEqual(set(scores), {7, 8})

    def test_脏行跳过_不许把没有_id_的东西塞进榜(self):
        items = [{"hits": 1.0}, {"memory_id": None}, {"memory_id": "x"}, {"memory_id": 3}]
        scores = fusion.rrf_fuse(items)
        self.assertEqual(set(scores), {3})

    def test_k_变了分就变_所以k是口径不是细节(self):
        items = _items([(1, {"hits": 1.0})])
        # 只有一条候选 ⇒ 它在**三臂里都是第一** ⇒ 分 = 3/(k+1)(别忘了几臂)
        self.assertAlmostEqual(fusion.rrf_fuse(items, k=60)[1], 3 / 61, places=12)
        self.assertAlmostEqual(fusion.rrf_fuse(items, k=10)[1], 3 / 11, places=12)


class GateTest(unittest.TestCase):
    def test_绝对阈值_不是排名(self):
        scores = {1: 0.9, 2: 0.1}
        self.assertEqual(fusion.absolute_gate(scores, threshold=0.5), {1})
        # 分数全都低 ⇒ 谁都进不去(排名制在这里会硬塞一个榜一)
        self.assertEqual(fusion.absolute_gate({1: 0.05, 2: 0.04}, threshold=0.5), set())


class HysteresisTest(unittest.TestCase):
    def test_进去容易出来难(self):
        prev = {1}
        # 1 已进过,掉到 0.22(> exit 0.20)⇒ 留着;2 是新的,0.22 不够 enter 0.25 ⇒ 不进
        keep = fusion.hysteresis(prev, {1: 0.22, 2: 0.22}, enter=0.25, exit_=0.20)
        self.assertEqual(keep, {1})
        # 掉到 0.19(< exit)⇒ 出来
        self.assertEqual(fusion.hysteresis(prev, {1: 0.19, 2: 0.30}, enter=0.25, exit_=0.20), {2})

    def test_配置写反了按从严处理_宁可不进也不抖(self):
        keep = fusion.hysteresis({1}, {1: 0.30, 2: 0.30}, enter=0.25, exit_=0.90)
        # exit_ 被拉到 enter(0.25):1 留着、2 也够 ⇒ 两个都在,但绝不出现"出来容易进去难"
        self.assertEqual(keep, {1, 2})

    def test_空名单与空分都不崩(self):
        self.assertEqual(fusion.hysteresis(set(), {}), set())
        self.assertEqual(fusion.hysteresis({1}, {}), set())


class DecideTest(unittest.TestCase):
    def test_顺序按融合分_进不进按门槛与滞回_两件事分开(self):
        items = _items([
            (1, {"hits": 0.9, "r_now": 0.9, "emotion_score": 0.9}),
            (2, {"hits": 0.1, "r_now": 0.1, "emotion_score": 0.1}),
        ])
        # 顺序听 RRF:1 在前;门槛听覆盖率(带量纲):threshold 0.5 ⇒ 只有 cov 0.9 的 1 够格
        ordered, injected, scores, gate = fusion.decide(
            items, prev_in=set(), threshold=0.5, exit_=0.35)
        self.assertEqual(ordered, [1, 2])
        self.assertEqual(injected, {1}, "cov 0.1 < 0.5 ⇒ 2 不该进(绝对阈值不是排名制)")
        self.assertAlmostEqual(gate[1], 0.9, places=12)
        # 量出 RRF 分的**压缩**:两条候选时"全末位"那条归一化后仍 > 0.95 ——
        # 所以它当不了置信度(榜一 1.0 与末位 0.98 之间的差别,说明不了相关性差别)
        self.assertGreater(scores[2], 0.95, "RRF 只讲排名一致性,不讲相关性大小 ⇒ 不能拿它比阈值")

        # 滞回:2 上一轮在名单里、cov 0.1 高于 exit 0.05 ⇒ 留着(不必再够 enter)
        _, injected_prev, _, _ = fusion.decide(items, prev_in={2}, threshold=0.5, exit_=0.05)
        self.assertEqual(injected_prev, {1, 2}, "进去容易出来难:老名单里的条目按 exit 判")


if __name__ == "__main__":
    unittest.main()
