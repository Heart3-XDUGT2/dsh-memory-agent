"""RT11 第三刀 3a:`expand_groups` 的溯源单测(纯函数、离线、不碰 DB/tempfile)。

钉四件事(每一条都对应一个会静默出错的形态):
  ① 组里**必须含原词元自己** —— 否则"自己命中"这条最强的证据会被漏掉;
  ② 组 = 原词元 + 表里**一跳**邻居,**不做传递闭包**(`A~B~C` 不等于 C 是 A 的变体);
  ③ 没进表的词元自成一组 ⇒ 逐概念判定的分母恒等于**原概念数**(不会悄悄变小);
  ④ 与 `expand_terms` 同口径:每个组都是 `expand_terms([w])` 的子集
     (两把尺子量同一件事,口径不许分叉)。
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'engine'))
import synonyms as syn  # noqa: E402


class ExpandGroupsTest(unittest.TestCase):
    def setUp(self):
        self.t = syn.build_table([], extra_pairs=[('校园跑', '跑步'), ('西电', '西安电子科技大学')])

    def test_group_contains_self(self):
        g = syn.expand_groups(['校园跑', '面试'], self.t)
        self.assertIn('校园跑', g['校园跑'], '原词元必须在自己组里')
        self.assertEqual(g['面试'], {'面试'}, '没进表的词元自成一组')

    def test_group_has_table_neighbour(self):
        self.assertEqual(syn.expand_groups(['校园跑'], self.t)['校园跑'], {'校园跑', '跑步'})
        self.assertEqual(syn.expand_groups(['西电'], self.t)['西电'],
                         {'西电', '西安电子科技大学'})

    def test_one_hop_only(self):
        t = syn.build_table([], extra_pairs=[('A', 'B'), ('B', 'C')])
        self.assertEqual(syn.expand_groups(['A'], t)['A'], {'A', 'B'},
                         'C 只在 B 的组里,不许算成 A 的变体')

    def test_same_ruler_as_expand_terms(self):
        for w in ('校园跑', '西电', '没进表的词', ''):
            groups = syn.expand_groups([w], self.t)
            self.assertTrue(groups[w] <= syn.expand_terms([w], self.t),
                            '组的口径不许比 expand_terms 更宽')

    def test_empty_table_never_drops_a_concept(self):
        g = syn.expand_groups(['甲', '乙'], None)
        self.assertEqual(g, {'甲': {'甲'}, '乙': {'乙'}}, '没表也得保住分母(原概念数)')


if __name__ == '__main__':
    unittest.main()
