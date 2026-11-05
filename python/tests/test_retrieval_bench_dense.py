# -*- coding: utf-8 -*-
"""钉住「查询没有向量时必须响亮地失败」这条行为。

事故背景(2026-10-12):Step 5 扩样新增了 29 条查询(2 逐字 + 27 补题),但没有重跑
编码脚本 ⇒ `dense_rank()` 静默返回 `[]`,测台把空返回记成"未命中" ⇒ Dense 的读数
从 **87.2% 掉到 51.5%**,而**全程没有任何报错**。

本电池钉的就是"不许再这样":缺向量 = 抛错(不是记 0 分),报错要能定位,
起飞前要一次报全。**故意不依赖 numpy** —— 查表路径与 numpy 无关,
所以在零依赖的解释器里也跑得起来(与"测台本体零第三方依赖"同一条纪律)。
"""
import importlib.util
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
BENCH_PATH = ROOT / "scripts" / "retrieval-bench.py"


def _load_bench():
    spec = importlib.util.spec_from_file_location("retrieval_bench_under_test", BENCH_PATH)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


BENCH = _load_bench()

#: 报错里必须交代的上下文(哪张表、什么时候编的)
META = {"model": "BAAI/bge-small-zh-v1.5",
        "encoded_at": "2026-10-11 21:04:46",
        "queries": 2}


def _fake_dense(keys):
    """只造「索引」—— 查表路径不需要 numpy,也不需要真向量。"""
    return {"index": {BENCH._norm_q(k): i for i, k in enumerate(keys)},
            "meta": META, "dim": 512}


class DenseMissingVectorIsLoud(unittest.TestCase):
    """挂了向量臂、但某条查询没有向量 ⇒ 必须抛错。"""

    def setUp(self):
        self._saved = BENCH.DENSE
        BENCH.DENSE = _fake_dense(["已编码的问句", "另一条"])

    def tearDown(self):
        BENCH.DENSE = self._saved

    def test_missing_query_raises_not_empty(self):
        with self.assertRaises(BENCH.DenseNotEncoded):
            BENCH._dense_index_of("从没编码过的问句")

    def test_error_carries_query_time_and_count(self):
        """报错必须交代:哪条查询 / 什么时候编码的 / 表里多少条 / 怎么修。"""
        with self.assertRaises(BENCH.DenseNotEncoded) as ctx:
            BENCH._dense_index_of("从没编码过的问句")
        msg = str(ctx.exception)
        self.assertIn("从没编码过的问句", msg, "报错要含查询原文")
        self.assertIn("2026-10-11 21:04:46", msg, "报错要含编码时间")
        self.assertIn("BAAI/bge-small-zh-v1.5", msg, "报错要含模型名")
        self.assertIn("2 条查询", msg, "报错要含向量表条数")
        self.assertIn("encode_dense.py", msg, "报错要给出修法")

    def test_dense_rank_raises_not_empty(self):
        """R9 对缺向量的查询抛错(而不是返回 [])。"""
        with self.assertRaises(BENCH.DenseNotEncoded):
            BENCH.dense_rank("从没编码过的问句")

    def test_dense_pairs_raises_not_empty(self):
        """R10 的那一路同样抛错 —— 不许退化成纯 BM25 还不留痕。"""
        with self.assertRaises(BENCH.DenseNotEncoded):
            BENCH.dense_pairs("从没编码过的问句")

    def test_known_query_passes_the_guard(self):
        """已编码的查询要正常过闸(不能一律抛)。"""
        self.assertEqual(BENCH._dense_index_of("已编码的问句"), 0)
        self.assertEqual(BENCH._dense_index_of("另一条"), 1)

    def test_whitespace_is_normalized(self):
        """查表口径与测台一致(`_norm_q` 折叠空白)。"""
        self.assertEqual(BENCH._dense_index_of("  已编码的问句  "), 0)


class NotMountedIsStillAllowed(unittest.TestCase):
    """**没挂**向量臂(`DENSE is None`)时返回 [] 是合法的 ——
    那是"没有这一路",与"挂了但查不到"是两件事,不能混。"""

    def setUp(self):
        self._saved = BENCH.DENSE
        BENCH.DENSE = None

    def tearDown(self):
        BENCH.DENSE = self._saved

    def test_none_returns_empty(self):
        self.assertEqual(BENCH.dense_rank("任意"), [])
        self.assertEqual(BENCH.dense_pairs("任意"), [])


class PreflightListsEveryMissing(unittest.TestCase):
    """起飞前自检:一次报**全**,不是撞到第一条就崩(那样只能一条一条修)。"""

    def test_lists_all_missing_not_just_first(self):
        d = _fake_dense(["有向量的"])
        golden = [
            {"tier": "N1 单会话事实", "source": "补题", "query": "有向量的", "accept": {1}},
            {"tier": "N2 多会话", "source": "补题", "query": "缺A", "accept": {2}},
            {"tier": "N3 时间推理", "source": "逐字", "query": "缺B", "accept": {3}},
        ]
        miss = BENCH.check_dense_covers(golden, d)
        self.assertEqual([m[2] for m in miss], ["缺A", "缺B"])
        self.assertEqual(miss[0][:2], ("N2 多会话", "补题"), "要带档位与来源,便于定位")

    def test_all_covered_returns_empty(self):
        d = _fake_dense(["有向量的"])
        self.assertEqual(BENCH.check_dense_covers(
            [{"tier": "N1 单会话事实", "source": "补题", "query": "有向量的", "accept": {1}}], d), [])

    def test_none_dense_skips_check(self):
        """没挂向量臂 ⇒ 自检不适用,返回空(不误报)。"""
        self.assertEqual(BENCH.check_dense_covers(
            [{"tier": "N1 单会话事实", "source": "补题", "query": "x", "accept": {1}}], None), [])


class ReachabilityPassMustSkipVectorArms(unittest.TestCase):
    """可达率那一段的"查询"是**运行时从语料现推的弱线索**(`weak_clues`),
    语料一变线索就变 ⇒ 结构上不可能预先编码。

    ⇒ 那一段必须能 `dense_ok=False` 跳过向量臂,并在表里印「—(未测)」,
    **不许**静默记 0.0%(2026-10-12 那次事故的形状),也不许把整跑炸掉。
    """

    def setUp(self):
        self._saved = BENCH.DENSE
        # 故意只编一条别的查询 —— 任何真去查向量的调用都会撞 DenseNotEncoded
        BENCH.DENSE = _fake_dense(["某条金标查询"])
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.missing_db = str(Path(self.temporary.name) / "not-created-graph.sqlite")
        self.rows = [{
            "memory_id": 1, "keywords": ["测试"], "summary": "测试记忆一条",
            "emotion_score": 3, "timestamp": 1.0, "layer": "L2",
            "intrinsic_value": 20.0, "half_life": 10.0, "recall_count": 0,
            "last_recalled": 1.0, "occurred_at": 0.0, "learned_at": 0.0,
            "temporal_status": "time_unknown",
        }]
        self.bm = BENCH.BM25(self.rows)
        self.fts = BENCH.build_fts5(self.rows)

    def tearDown(self):
        BENCH.DENSE = self._saved

    def _run(self, q, dense_ok):
        return BENCH.rank_all_methods(q, self.rows, {1: self.rows[0]}, self.bm,
                                      self.fts, self.missing_db, 1.0,
                                      dense_ok=dense_ok)

    def test_default_still_guards(self):
        """默认(dense_ok=True)对缺向量的查询仍然抛错 —— 守卫没被削弱。"""
        with self.assertRaises(BENCH.DenseNotEncoded):
            self._run("从没编码过的问句", True)

    def test_dense_ok_false_skips_them(self):
        """dense_ok=False 时向量两臂不跑(不抛错),返回空列表。"""
        out, _times, _extra, _pool = self._run("从没编码过的问句", False)
        self.assertEqual(out["R9Dense"], [])
        self.assertEqual(out["R10DenseBM25"], [])
        # 词法臂照常出结果 —— 跳过的只是向量那两路
        self.assertIn("R1BM25", out)

    def test_dense_ok_false_leaves_lexical_arms_intact(self):
        """跳过向量臂不许影响词法臂的读数(同一问、同一语料)。

        对照做法:把 DENSE 摘掉跑一次(等于"没挂向量臂"的老路),
        与 dense_ok=False 跑一次比 —— 词法各臂必须逐位相同。
        """
        skip, _, _, _ = self._run("测试记忆一条", False)
        BENCH.DENSE = None
        try:
            novec, _, _, _ = self._run("测试记忆一条", True)
        finally:
            BENCH.DENSE = _fake_dense(["某条金标查询"])
        for arm in ("R0现状", "R1BM25", "R2FTS5", "R3RRF同族", "R5R1去冗余"):
            self.assertEqual(skip[arm], novec[arm], "%s 在跳过向量臂时被改动了" % arm)


class ReachabilityTableMarksUnmeasured(unittest.TestCase):
    """表里印「—(未测)」而不是 0.0% —— 「没跑」与「跑了但没找回」不是一回事。"""

    def test_source_marks_unmeasured(self):
        src = BENCH_PATH.read_text(encoding="utf-8")
        self.assertIn("—(未测)", src, "可达率表要显式标未测")
        self.assertIn("dense_ok=False", src, "可达率那一段要显式跳过向量臂")
        self.assertIn("_reach_unmeasured", src, "要有'哪几臂未测'的显式集合")


if __name__ == "__main__":
    unittest.main()
