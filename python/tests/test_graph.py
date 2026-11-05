# -*- coding: utf-8 -*-
"""图谱引擎测试(M2-b2)。

三层:
  DmaeMath      —— 数学差分锚点(与 JS lib/dmae.js 同源同公式,同输入必同输出);
  GraphStorage  —— 存储三分支(强化/槽位取代/复活)+ 迁移;
  BfsAndPersist —— 三个「不带就死」的修复逐个验证 + LTP/双桶持久化;
  WireRoundTrips —— echo_wire_v1 全周期往返(learn → query → reinforce)。
"""
import sys
import tempfile
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from engine import db, dmae, graph  # noqa: E402
from test_worker import WorkerHarness, hello_frame  # noqa: E402

DAY = 86400.0


class DmaeMath(unittest.TestCase):
    """数学差分锚点 —— 数值即规格(与 AstrBot/JS 基线三方一致)。"""

    def test_retrievability(self):
        self.assertEqual(dmae.retrievability(0, 24), 1.0)
        self.assertEqual(dmae.retrievability(24, 24), 0.5)
        self.assertAlmostEqual(dmae.retrievability(240, 24), 0.0909, places=3)
        self.assertEqual(dmae.retrievability(100, 0), 0.0)
        self.assertEqual(dmae.retrievability(100, None), 0.0)

    def test_initial_half_life(self):
        p = dmae.DMAE_DEFAULT
        self.assertEqual(dmae.initial_half_life(10, p), 24.0)
        # I=88.6(L0 身份)≈ 13.7 天;I=1(碎片)被压到最小附近
        self.assertAlmostEqual(dmae.initial_half_life(88.6, p), 328.95, places=1)
        self.assertAlmostEqual(dmae.initial_half_life(1, p), 1.514, places=3)

    def test_reinforce_half_life(self):
        p = dmae.DMAE_DEFAULT
        self.assertAlmostEqual(dmae.reinforce_half_life(24, 0.5, p), 45.6, places=6)
        self.assertAlmostEqual(dmae.reinforce_half_life(24, 1.0, p), 24.0, places=6)
        self.assertAlmostEqual(dmae.reinforce_half_life(24, 0.0, p), 67.2, places=6)

    def test_derive_state(self):
        p = dmae.DMAE_DEFAULT
        self.assertEqual(dmae.derive_state(0.5, p), "Active")
        self.assertEqual(dmae.derive_state(0.49, p), "Dormant")
        self.assertEqual(dmae.derive_state(0.1, p), "Dormant")
        self.assertEqual(dmae.derive_state(0.099, p), "Archived")
        self.assertEqual(dmae.derive_state(0.0, p), "Archived")

    def test_compute_intrinsic_value(self):
        # L0 身份事实:tier 1.0, trust 1.0, salience=0.775^0.5
        self.assertAlmostEqual(
            dmae.compute_intrinsic_value(
                layer="L0", certainty="explicit", attribution="user_explicit",
                emotion=5.0, quote_count=0),
            88.034, places=2)
        # L1 近况:tier 0.45
        self.assertAlmostEqual(
            dmae.compute_intrinsic_value(
                layer="L1", certainty="explicit", attribution="user_explicit",
                emotion=5.0),
            39.615, places=2)
        # 推断碎片:tier 0.15, trust 0.55*0.40(字段缺失的保守权重)
        self.assertAlmostEqual(
            dmae.compute_intrinsic_value(layer="L2", emotion=5.0),
            2.905, places=2)
        # 引文数封顶:1 篇 +0.1,2 篇不叠加
        a = dmae.compute_intrinsic_value(layer="L0", certainty="explicit",
                                         attribution="user_explicit", quote_count=1)
        b = dmae.compute_intrinsic_value(layer="L0", certainty="explicit",
                                         attribution="user_explicit", quote_count=5)
        self.assertEqual(a, b)
        # 带一篇引文的 L0:salience = 0.55+0.225+0.1 = 0.875
        self.assertAlmostEqual(a, 93.541, places=2)

    def test_edge_r_and_prune(self):
        p = dmae.DMAE_DEFAULT
        now = time.time()
        edge = {"half_life": 24.0, "last_accessed": now - 24 * 3600,
                "recall_count": 0, "intrinsic_value": 10.0}
        self.assertEqual(dmae.dmae_edge_r(edge, now, p), 0.5)
        # H 缺失 → 按 I 现推 H0
        edge0 = {"half_life": 0, "last_accessed": now, "intrinsic_value": 10.0}
        self.assertEqual(dmae.dmae_edge_r(edge0, now, p), 1.0)
        # 剪枝四条件:想起过 → 永不删
        self.assertFalse(dmae.dmae_should_prune(
            {"recall_count": 1, "intrinsic_value": 5,
             "half_life": 0.001, "last_accessed": now - 100 * DAY}, now, p))
        # I 高 → 不删
        self.assertFalse(dmae.dmae_should_prune(
            {"recall_count": 0, "intrinsic_value": 20,
             "half_life": 0.001, "last_accessed": now - 100 * DAY}, now, p))
        # 还可回忆 → 不删
        self.assertFalse(dmae.dmae_should_prune(
            {"recall_count": 0, "intrinsic_value": 5,
             "half_life": 500.0, "last_accessed": now - 10 * DAY}, now, p))
        # 沉默不够久 → 不删
        self.assertFalse(dmae.dmae_should_prune(
            {"recall_count": 0, "intrinsic_value": 5,
             "half_life": 0.001, "last_accessed": now - 30 * DAY}, now, p))
        # 四条全中 → 删
        self.assertTrue(dmae.dmae_should_prune(
            {"recall_count": 0, "intrinsic_value": 5,
             "half_life": 0.001, "last_accessed": now - 100 * DAY}, now, p))


class GraphStorage(unittest.TestCase):
    """存储三分支 + 迁移。"""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.db = str(Path(self.tmp.name) / "echo.db")
        self.conn = db.connect(self.db)
        # 固定时钟(离 600s 桶边界 200s):桶节流断言不受真实时钟
        # 撞边界的影响 —— time.time() 版本在边界附近会偶发翻车。
        self.now = 1700000000.0

    def tearDown(self):
        self.conn.close()
        self.tmp.cleanup()

    def _edge(self, eid):
        return self.conn.execute(
            "SELECT activation, weight, half_life, recall_count, is_active,"
            " superseded_by, slot, layer, intrinsic_value FROM graph_edges"
            " WHERE edge_id = ?", (eid,)).fetchone()

    def _find(self, s, rel, t):
        row = self.conn.execute(
            "SELECT edge_id FROM graph_edges e"
            " JOIN graph_nodes n1 ON e.source_id = n1.node_id"
            " JOIN graph_nodes n2 ON e.target_id = n2.node_id"
            " WHERE n1.name = ? AND e.relation = ? AND n2.name = ?"
            " AND e.owner_key = ?", (s, rel, t, "master")).fetchone()
        return int(row[0]) if row else None

    def test_new_edge_born_active(self):
        """修复③:新边 activation=100 出生即 Active(不是「出生即死亡」)。"""
        graph.add_edge(self.conn, "用户", "就读于", "西电", "master")
        eid = self._find("用户", "就读于", "西电")
        row = self._edge(eid)
        self.assertEqual(row[0], 100.0)          # activation
        self.assertEqual(row[1], 1.0)            # weight
        self.assertEqual(row[2], 24.0)           # H0 = 24·(10/10)^1.2
        self.assertEqual(row[3], 0)              # recall_count
        self.assertEqual(row[4], 1)              # is_active
        # v2-A1:槽位 = 三元组身份 `源|关系|目标`
        shape = self.conn.execute(
            "SELECT slot, source_id, target_id FROM graph_edges WHERE edge_id = ?",
            (eid,)).fetchone()
        self.assertEqual(shape[0], "%s|就读于|%s" % (shape[1], shape[2]))

    def test_exact_reassert_is_recall(self):
        """重复断言 = 一次「想起」:权重+0.5、H 间隔效应延长、次数+1。"""
        graph.add_edge(self.conn, "用户", "就读于", "西电", "master")
        eid = self._find("用户", "就读于", "西电")
        time.sleep(0.01)
        graph.add_edge(self.conn, "用户", "就读于", "西电", "master")
        row = self._edge(eid)
        self.assertEqual(row[1], 1.5)            # weight 1.0 + 0.5
        self.assertEqual(row[3], 1)              # recall_count +1
        self.assertGreater(row[2], 24.0)         # H 增益(R<1 → 乘 >1)
        self.assertEqual(row[0], 100.0)

    def test_slot_supersede(self):
        """修复:v8.4 槽位取代 —— 新宾语顶掉旧宾语,旧边留档不删除。"""
        graph.add_edge(self.conn, "用户", "住在", "西安", "master")
        old = self._find("用户", "住在", "西安")
        graph.add_edge(self.conn, "用户", "住在", "北京", "master")
        new = self._find("用户", "住在", "北京")
        self.assertNotEqual(old, new)
        old_row = self._edge(old)
        self.assertEqual(old_row[4], 0)                    # 旧边退役
        self.assertEqual(old_row[5], new)                  # superseded_by 回填
        self.assertEqual(self._edge(new)[4], 1)            # 新边现役
        # 旧边仍在库里(DMAE 状态留档):「我以前住哪」翻得出来
        self.assertIsNotNone(old)

    def test_revival(self):
        """复活:回到旧值 → 旧边复活,槽位现役版本让位。"""
        graph.add_edge(self.conn, "用户", "住在", "西安", "master")
        old = self._find("用户", "住在", "西安")
        graph.add_edge(self.conn, "用户", "住在", "北京", "master")
        new = self._find("用户", "住在", "北京")
        graph.add_edge(self.conn, "用户", "住在", "西安", "master")  # 搬回西安
        self.assertEqual(self._edge(old)[4], 1)            # 旧边复活
        self.assertEqual(self._edge(new)[4], 0)            # 北京版本让位
        self.assertEqual(self._edge(new)[5], old)
        self.assertEqual(self._edge(old)[3], 1)            # 复活也是一次想起

    def test_self_loop_rejected(self):
        graph.add_edge(self.conn, "用户", "认识", "用户", "master")
        self.assertEqual(self.conn.execute(
            "SELECT COUNT(*) FROM graph_edges").fetchone()[0], 0)

    def test_person_node_protected(self):
        self.conn.execute(
            "INSERT INTO graph_nodes (node_id, name, node_type)"
            " VALUES ('pid1', '阿岚', 'person')")
        graph.add_edge(self.conn, "阿岚", "喜欢", "猫", "master")
        row = self.conn.execute(
            "SELECT is_protected FROM graph_nodes WHERE name = '阿岚'").fetchone()
        self.assertEqual(row[0], 1)

    def test_learn_with_judge_fields(self):
        """三元组与情景记忆共用同一个 I;layer/occurredAt 参与存储。"""
        graph.learn(self.conn, [{
            "s": "用户", "relation": "称呼", "t": "阿岚",
            "layer": "L0", "certainty": "explicit", "attribution": "user_explicit",
            "occurredAt": 1700000000, "temporalStatus": "enduring",
            "evidenceQuotes": ["叫我阿岚"],
        }], "master", emotion=5.0)
        eid = self._find("用户", "称呼", "阿岚")
        row = self._edge(eid)
        self.assertEqual(row[7], "L0")
        self.assertAlmostEqual(row[8], 93.541, places=2)   # I = L0 全信任 + 一篇引文
        occ = self.conn.execute(
            "SELECT occurred_at, temporal_status FROM graph_edges WHERE edge_id = ?",
            (eid,)).fetchone()
        self.assertEqual(occ[0], 1700000000)
        self.assertEqual(occ[1], "enduring")

    def test_slot_backfill_migration(self):
        """v2-A1 槽位迁移:空槽位 / 旧二键槽位 → 重连后升为三元组身份,老值进 `slot_v1`。"""
        graph.add_edge(self.conn, "用户", "住在", "西安", "master")
        # ① 老形态之一:搬家数据里 slot 全空
        self.conn.execute("UPDATE graph_edges SET slot = '', slot_v1 = ''")
        self.conn.execute(
            "DELETE FROM schema_migrations WHERE name = 'a1_slot_three_keys'")
        self.conn.commit()
        self.conn.close()
        self.conn = db.connect(self.db)          # 重连触发迁移
        row = self.conn.execute(
            "SELECT slot, slot_v1, source_id, target_id FROM graph_edges").fetchone()
        self.assertEqual(row[0], "%s|住在|%s" % (row[2], row[3]))
        self.assertEqual(row[1], "")             # 以前确实没有槽位
        # ② 老形态之二:二键槽位 → 抄进 slot_v1(回退依据)
        self.conn.execute(
            "UPDATE graph_edges SET slot = source_id || '|' || relation, slot_v1 = ''")
        self.conn.execute(
            "DELETE FROM schema_migrations WHERE name = 'a1_slot_three_keys'")
        self.conn.commit()
        self.conn.close()
        self.conn = db.connect(self.db)
        row = self.conn.execute(
            "SELECT slot, slot_v1, source_id, target_id FROM graph_edges").fetchone()
        self.assertEqual(row[0], "%s|住在|%s" % (row[2], row[3]))
        self.assertEqual(row[1], "%s|住在" % row[2])
        # ③ 幂等:再连一次,留档不被覆盖(靠 schema_migrations 账本)
        self.conn.close()
        self.conn = db.connect(self.db)
        again = self.conn.execute("SELECT slot_v1 FROM graph_edges").fetchone()
        self.assertEqual(again[0], row[1])


class BfsAndPersist(unittest.TestCase):
    """三个「不带就死」的修复 + LTP/双桶持久化。"""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.db = str(Path(self.tmp.name) / "echo.db")
        self.conn = db.connect(self.db)
        # 固定时钟(离 600s 桶边界 200s):桶节流断言不受真实时钟
        # 撞边界的影响 —— time.time() 版本在边界附近会偶发翻车。
        self.now = 1700000000.0

    def tearDown(self):
        self.conn.close()
        self.tmp.cleanup()

    def _load(self, owner="master"):
        return graph.load(self.conn, owner)

    def test_direct_seed_hits(self):
        """修复①的前置:节点名直扫,提到就命中(零损耗底座)。"""
        graph.add_edge(self.conn, "用户", "就读于", "西电", "master")
        graph.add_edge(self.conn, "用户", "修过", "Echo", "master")
        _, by_name, _ = self._load()
        self.assertEqual(graph.direct_seed_hits("我在西电上学", by_name), ["西电"])
        self.assertEqual(graph.direct_seed_hits("echo 修好了", by_name), ["Echo"])  # ASCII 不分大小写
        # 单字节点不参与直扫
        self.conn.execute(
            "INSERT INTO graph_nodes (node_id, name) VALUES ('x1', '猫')")
        _, by_name2, _ = self._load()
        self.assertEqual(graph.direct_seed_hits("猫在桌上", by_name2), [])

    def test_bidirectional_backward_arrow(self):
        """修复①:双向邻接 + 逆向箭头 —— 提到目标端有路可走,方向不失真。"""
        graph.add_edge(self.conn, "用户", "就读于", "西电", "master")
        by_id, by_name, edges = self._load()
        seeds = graph.direct_seed_hits("西电怎么样", by_name)
        self.assertEqual(seeds, ["西电"])
        paths, seed_ids = graph.graph_activate(
            seeds, by_id, by_name, edges, now_ts=self.now)
        self.assertEqual(len(paths), 1)
        self.assertEqual(paths[0]["path"], ["西电", "用户"])
        self.assertEqual(paths[0]["relations"], ["<-就读于"])
        text = graph.render_paths(paths)
        self.assertIn("西电 <-[就读于]- 用户", text)  # 读作:用户就读于西电

    def test_r_gate_blocks_relay_but_seed_wakes(self):
        """修复②:Archived 边不中继(无路径产出),但种子邻接边免闸 ——
        一提就记起(进 seed_edge_ids 得到强化,只是本轮不作为路径注入)。"""
        # 构造一条 Archived 边:H 极小 + 上次想起很久前 → R < 0.1
        graph.add_edge(self.conn, "用户", "讨厌", "水课", "master")
        self.conn.execute(
            "UPDATE graph_edges SET half_life = 0.001,"
            " last_accessed = ? WHERE relation = '讨厌'", (self.now - 30 * DAY,))
        self.conn.commit()
        by_id, by_name, edges = self._load()
        # 提到「水课」:它作为种子,邻接边(用户-讨厌->水课)免闸进 seed_edge_ids
        paths, seed_ids = graph.graph_activate(
            ["水课"], by_id, by_name, edges, now_ts=self.now)
        self.assertEqual(len(seed_ids), 1)      # 唤醒通道在
        self.assertEqual(len(paths), 0)         # 但 Archived 不中继:无路径产出
        # 对照:R 达标的边正常中继(新边出生即 Active,R=1)
        graph.add_edge(self.conn, "水课", "属于", "学分课", "master")
        by_id, by_name, edges = self._load()
        paths2, seed_ids2 = graph.graph_activate(
            ["水课"], by_id, by_name, edges, now_ts=self.now)
        # 水课 → 学分课 的中继走通了(用户-讨厌->水课 是 Archived 不中继)
        self.assertTrue(any(p["path"] == ["水课", "学分课"] for p in paths2))
        self.assertEqual(len(seed_ids2), 2)     # 两条邻接边都算「被提到」

    def test_pinned_l0(self):
        """L0 核心边强制注入:无种子也 pinned,score=0,[核心] 前缀。"""
        graph.add_edge(self.conn, "用户", "称呼", "阿岚", "master",
                       intrinsic_value=88.0, layer="L0")
        by_id, by_name, edges = self._load()
        paths, _ = graph.graph_activate(
            [], by_id, by_name, edges, now_ts=self.now)
        self.assertEqual(len(paths), 1)
        self.assertTrue(paths[0]["pinned"])
        self.assertEqual(paths[0]["score"], 0.0)
        self.assertIn("[核心] 用户-[称呼]-> 阿岚", graph.render_paths(paths))

    def test_ltp_and_reinforce(self):
        """LTP 只加权重不写时钟;recall_updates 写真实时钟与增益。"""
        graph.add_edge(self.conn, "用户", "就读于", "西电", "master")
        eid = self.conn.execute(
            "SELECT edge_id FROM graph_edges").fetchone()[0]
        # 铺时钟:上次想起在 24h 前 → R=0.5 → H 24→45.6(间隔效应)
        self.conn.execute(
            "UPDATE graph_edges SET last_accessed = ? WHERE edge_id = ?",
            (self.now - 24 * 3600, eid))
        self.conn.commit()
        before = self.conn.execute(
            "SELECT weight, last_accessed, recall_count, half_life"
            " FROM graph_edges WHERE edge_id = ?", (eid,)).fetchone()
        graph.apply_ltp(self.conn, [eid], is_master=True)
        after_ltp = self.conn.execute(
            "SELECT weight, last_accessed FROM graph_edges WHERE edge_id = ?",
            (eid,)).fetchone()
        self.assertEqual(after_ltp[0], 2.0)                    # 主人 +1.0
        self.assertEqual(after_ltp[1], before[1])              # 时钟没动(v8.7.2)
        result = graph.update_and_persist(
            self.conn, {eid}, self.now + 1, buckets={})
        after = self.conn.execute(
            "SELECT activation, recall_count, half_life, last_accessed"
            " FROM graph_edges WHERE edge_id = ?", (eid,)).fetchone()
        self.assertEqual(after[0], 100.0)                      # R 归 1
        self.assertEqual(after[1], before[2] + 1)              # recall_count +1
        self.assertAlmostEqual(after[2], 45.6, delta=0.1)      # 24*(1+1.8*0.5)
        self.assertAlmostEqual(after[3], self.now + 1, delta=1)
        self.assertEqual(len(result["changed"]), 1)

    def test_materialize_bucket_throttle(self):
        """10 分钟桶:同桶第二次不物化(节流)。"""
        graph.add_edge(self.conn, "用户", "就读于", "西电", "master")
        buckets = {}
        r1 = graph.update_and_persist(self.conn, set(), self.now, buckets=buckets)
        r2 = graph.update_and_persist(self.conn, set(), self.now + 60, buckets=buckets)
        self.assertTrue(r1["materialized"])
        self.assertFalse(r2["materialized"])

    def test_prune_noise_and_exempt_hits(self):
        """剪枝:只清四条件全中的噪声;本轮命中豁免;孤点清理保 person。"""
        # 噪声边:从未想起 + I 低 + R<0.02 + 沉默>60天
        graph.add_edge(self.conn, "用户", "路过", "东门", "master")
        noise = self.conn.execute(
            "SELECT edge_id FROM graph_edges WHERE relation = '路过'").fetchone()[0]
        self.conn.execute(
            "UPDATE graph_edges SET half_life = 0.0001, intrinsic_value = 5,"
            " last_accessed = ? WHERE edge_id = ?",
            (self.now - 100 * DAY, noise))
        # 健康边
        graph.add_edge(self.conn, "用户", "就读于", "西电", "master")
        keep = self.conn.execute(
            "SELECT edge_id FROM graph_edges WHERE relation = '就读于'").fetchone()[0]
        # 一条「首次被想起」的旧噪声(快照里还是噪声模样 → 必须豁免)
        graph.add_edge(self.conn, "用户", "怀念", "旧食堂", "master")
        waking = self.conn.execute(
            "SELECT edge_id FROM graph_edges WHERE relation = '怀念'").fetchone()[0]
        self.conn.execute(
            "UPDATE graph_edges SET half_life = 0.0001, intrinsic_value = 5,"
            " last_accessed = ? WHERE edge_id = ?",
            (self.now - 100 * DAY, waking))
        self.conn.commit()

        result = graph.update_and_persist(
            self.conn, {waking}, self.now, buckets={})
        self.assertEqual(result["pruned"], 1)                  # 只删了纯噪声
        remaining = {r[0] for r in self.conn.execute(
            "SELECT edge_id FROM graph_edges").fetchall()}
        self.assertNotIn(noise, remaining)
        self.assertIn(keep, remaining)
        self.assertIn(waking, remaining)                       # 本轮唤醒豁免

    def test_orphan_cleanup_keeps_person(self):
        """孤点清理:无边引用的非 person 未保护节点删除,person 保留。"""
        graph.add_edge(self.conn, "用户", "就读于", "西电", "master")
        self.conn.execute(
            "INSERT INTO graph_nodes (node_id, name, node_type)"
            " VALUES ('p9', '同桌', 'person')")
        self.conn.execute(
            "INSERT INTO graph_nodes (node_id, name) VALUES ('g9', '无关概念')")
        self.conn.commit()
        graph.update_and_persist(self.conn, set(), self.now, buckets={})
        names = {r[0] for r in self.conn.execute(
            "SELECT name FROM graph_nodes").fetchall()}
        self.assertNotIn("无关概念", names)
        self.assertIn("同桌", names)                           # person 幸存
        self.assertIn("西电", names)                           # 有边引用


class RelationMergeTest(unittest.TestCase):
    """F10 谓词归并。

    活库现状(35 条边):同一件事被不同说法各长了一条边 ——
      · 用户-[希望打造]->Echo:期望打造/想打造/希望塑造(4 条全现役)
      · 用户-[就读于]->新工科大学:读于/就读专业(3 条全现役)
      · 用户-[负责]->Echo记忆架构:在忙/正在搭建/在做/正在开发/搭建(6 条全归档)
    后果不只是"看着乱":BFS 会把同一事实**重复算进路径**,一起被想起、一起被强化。
    """

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.conn = db.connect(str(Path(self.tmp.name) / "echo.db"))

    def tearDown(self):
        self.conn.close()
        self.tmp.cleanup()

    def _edge(self, s, rel, t, iv=10.0, owner="master"):
        """走写入侧(会被 F10 接地成规范谓词)。"""
        graph.add_edge(self.conn, s, rel, t, owner, intrinsic_value=iv)
        self.conn.commit()
        return int(self.conn.execute(
            "SELECT max(edge_id) FROM graph_edges").fetchone()[0])

    def _variant(self, s, rel, t, iv=10.0, owner="master", active=1, rc=0, layer=""):
        """**直插**一条变体边,谓词原样不动 —— 模拟"闸之前就已经长出来的"那些。

        不能走 `add_edge`:它在写入侧就被接地了,变体根本插不进去(这正是 F10 的
        第一半)。活库那 15 条变体都是历史行,迁移要面对的是它们。
        """
        sid = graph.get_or_create_node(self.conn, s)
        tid = graph.get_or_create_node(self.conn, t)
        cur = self.conn.execute(
            "INSERT INTO graph_edges (source_id, target_id, relation, owner_key,"
            " intrinsic_value, recall_count, is_active, layer)"
            " VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (sid, tid, rel, owner, float(iv), int(rc), int(active), layer))
        self.conn.commit()
        return int(cur.lastrowid)

    def _state(self):
        return {int(r[0]): (str(r[1]), int(r[2]), int(r[3]), float(r[4]), int(r[5]), str(r[6] or ""))
                for r in self.conn.execute(
                    "SELECT edge_id, relation, is_active, COALESCE(superseded_by,0),"
                    " intrinsic_value, recall_count, layer FROM graph_edges").fetchall()}

    def test_canonical_relation_is_a_whitelist_not_a_guesser(self):
        for v, c in (("期望打造", "希望打造"), ("想打造", "希望打造"), ("希望塑造", "希望打造"),
                     ("在忙", "负责"), ("正在搭建", "负责"), ("在做", "负责"),
                     ("正在开发", "负责"), ("搭建", "负责"),
                     ("读于", "就读于"), ("就读专业", "就读于")):
            self.assertEqual(graph.canonical_relation(v), c, v)
        # 表外一律原样:宁可留着两根线,也不猜错把两件事并成一件
        for keep in ("喜欢", "喜欢吃", "习惯", "参加", "有预算", "可能转到", "是", "相关"):
            self.assertEqual(graph.canonical_relation(keep), keep, keep)

    def test_write_side_gates_new_edges(self):
        """写入侧就接地 —— 换说法不再各长一条。"""
        eid = self._edge("用户", "想打造", "Echo", iv=95.9)
        self.assertEqual(self._state()[eid][0], "希望打造")
        # 再写一次"期望打造":落到同一条边上(被当作一次"想起"),而不是长第二条
        graph.add_edge(self.conn, "用户", "期望打造", "Echo", "master", intrinsic_value=95.9)
        self.conn.commit()
        self.assertEqual(len(self._state()), 1, "同一事实不该长两条边")

    def test_renames_when_no_sibling(self):
        eid = self._variant("用户", "读于", "某大学")
        out = graph.merge_relation_variants(self.conn, "master")
        self.assertEqual(out["renamed"], [eid])
        self.assertEqual(out["merged"], [])
        self.assertEqual(self._state()[eid][0], "就读于")
        self.assertEqual(self._state()[eid][1], 1, "改名不是删除")

    def test_merges_into_existing_canonical_edge(self):
        v1 = self._variant("用户", "读于", "新工科大学", rc=74, iv=60.0)
        v2 = self._variant("用户", "就读专业", "新工科大学", rc=72)
        keep = self._edge("用户", "就读于", "新工科大学")
        self.conn.execute(
            "UPDATE graph_edges SET recall_count = 114 WHERE edge_id = ?", (keep,))
        self.conn.commit()

        out = graph.merge_relation_variants(self.conn, "master")
        self.assertEqual(sorted(e for e, _ in out["merged"]), sorted([v1, v2]))
        for e, surv in out["merged"]:
            self.assertEqual(surv, keep, "都该并到那条规范边上")
        st = self._state()
        self.assertEqual(st[v1][1], 0, "变体留档下线")
        self.assertEqual(st[v1][2], keep, "superseded_by 指向幸存者")
        self.assertEqual(st[v2][1], 0)
        self.assertEqual(st[keep][1], 1, "幸存者还是现役")
        self.assertEqual(st[keep][4], 114, "吸收 max(recall_count)")
        self.assertEqual(st[keep][3], 60.0, "吸收 max(intrinsic_value)")
        # 一条物理行都没少(留档,不销毁)
        self.assertEqual(len(st), 3)

    def test_layer_takes_the_stronger_one(self):
        v = self._variant("用户", "搭建", "Echo记忆架构", layer="L0")
        keep = self._edge("用户", "负责", "Echo记忆架构")
        self.assertEqual(self._state()[keep][5], "", "前提:幸存者本来没有层级")
        graph.merge_relation_variants(self.conn, "master")
        self.assertEqual(self._state()[keep][5], "L0", "并进来一条 L0,幸存者该升到 L0")
        self.assertEqual(self._state()[v][5], "L0", "变体自己的留档字段不动")

    def test_idempotent_and_dry_run(self):
        v = self._variant("用户", "想打造", "Echo")
        keep = self._edge("用户", "希望打造", "Echo")
        self.assertEqual(graph.merge_relation_variants(self.conn, "master", dry_run=True)["merged"],
                         [(v, keep)])
        self.assertEqual(self._state()[v][1], 1, "dry_run 不该写库")
        self.assertEqual(len(graph.merge_relation_variants(self.conn, "master")["merged"]), 1)
        again = graph.merge_relation_variants(self.conn, "master")
        self.assertEqual(again["merged"], [], "第二次跑必须零改动")
        self.assertEqual(again["renamed"], [])

    def test_owner_isolation(self):
        self._variant("用户", "读于", "新工科大学", owner="stranger")
        self.assertEqual(
            graph.merge_relation_variants(self.conn, "master"),
            {"renamed": [], "merged": []})

    def test_live_shape_collapses_to_one_edge_per_fact(self):
        """复刻活库那三组,并完之后每个事实只剩一条现役边。"""
        # ① 打造一族(#28-31,4 条全现役)
        self._variant("用户", "希望打造", "Echo", iv=95.917)
        self._variant("用户", "期望打造", "Echo", iv=44.205)
        self._variant("用户", "想打造", "Echo", iv=95.917)
        self._variant("用户", "希望塑造", "Echo", iv=93.541)
        # ② 学校一族(#13/14/20,3 条全现役)
        self._variant("用户", "就读于", "新工科大学", rc=114)
        self._variant("用户", "读于", "新工科大学", rc=74)
        self._variant("用户", "就读专业", "新工科大学", rc=72)
        # ③ 记忆架构一族(#5/6/7/12/15/19,6 条全归档)
        for rel in ("负责", "在忙", "正在搭建", "在做", "正在开发", "搭建"):
            self._variant("用户", rel, "Echo记忆架构", active=0)

        out = graph.merge_relation_variants(self.conn, "master")
        # 三组共 13 条边(打造 4 + 学校 3 + 记忆架构 6),其中 3 条本来就是
        # 规范写法(各组的天然幸存者),剩下 10 条全部并入幸存者。
        self.assertEqual((len(out["renamed"]), len(out["merged"])), (0, 10),
                         "活库那 10 条变体该并入幸存者")
        self.assertEqual(self.conn.execute(
            "SELECT count(*) FROM graph_edges").fetchone()[0], 13,
            "一条物理行都不许少(留档,不销毁)")
        live = self.conn.execute(
            "SELECT n2.name, e.relation, count(*) FROM graph_edges e"
            " JOIN graph_nodes n2 ON n2.node_id = e.target_id"
            " WHERE e.is_active = 1 GROUP BY n2.name, e.relation").fetchall()
        self.assertEqual(sorted((str(r[0]), str(r[1]), int(r[2])) for r in live),
                         [("Echo", "希望打造", 1), ("新工科大学", "就读于", 1)],
                         "每个事实只剩一条现役边")
        # 已归档的那一族仍然全归档(并归并**不**复活它们 —— 那是别的决定)
        self.assertEqual(self.conn.execute(
            "SELECT count(*) FROM graph_edges WHERE is_active = 1").fetchone()[0], 2)
        # BFS 看到的路径因此不再重复
        by_id, by_name, edges = graph.load(self.conn, "master")
        paths, _ = graph.graph_activate(["用户"], by_id, by_name, edges, now_ts=1790000000.0)
        reached = sorted(p["path"][-1] for p in paths)
        self.assertEqual(reached.count("Echo"), 1, "同一事实不许在路径里重复出现")

    def test_worker_graph_query_runs_the_merge(self):
        """接线:治理挂在插件自己的代码路径上(graph_query)。"""
        db_path = str(Path(self.tmp.name) / "wire.db")
        db.connect(db_path).close()
        c = db.connect(db_path)
        # 直插一条变体(模拟历史行),再走正规写入一条规范边
        sid = graph.get_or_create_node(c, "用户")
        tid = graph.get_or_create_node(c, "新工科大学")
        c.execute(
            "INSERT INTO graph_edges (source_id, target_id, relation, owner_key,"
            " intrinsic_value, is_active) VALUES (?, ?, '读于', 'master', 10.0, 1)",
            (sid, tid))
        graph.add_edge(c, "用户", "就读于", "新工科大学", "master")
        c.commit()
        c.close()
        w = WorkerHarness()
        try:
            ready = w.roundtrip(hello_frame(db_path=db_path))
            self.assertEqual(ready["type"], "ready")
            q = w.roundtrip({"reqId": 1, "type": "graph_query", "userId": "master",
                             "text": "随便聊聊", "now": 1790000000.0})
            self.assertEqual(q["type"], "graph_query_result")
            c = db.connect(db_path)
            try:
                rows = c.execute(
                    "SELECT relation, is_active FROM graph_edges ORDER BY edge_id").fetchall()
            finally:
                c.close()
            self.assertEqual([(str(r[0]), int(r[1])) for r in rows],
                             [("读于", 0), ("就读于", 1)],
                             "graph_query 该顺手把同义谓词并掉")
        finally:
            w.close()


class WireRoundTrips(unittest.TestCase):
    """echo_wire_v1 全周期:learn → query → reinforce。"""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.db = str(Path(self.tmp.name) / "echo.db")
        db.connect(self.db).close()
        self.w = WorkerHarness()
        ready = self.w.roundtrip(hello_frame(db_path=self.db))
        self.assertEqual(ready["type"], "ready")
        self.now = time.time()

    def tearDown(self):
        self.w.close()
        self.tmp.cleanup()

    def test_full_cycle(self):
        r1 = self.w.roundtrip({"reqId": 1, "type": "graph_learn", "userId": "master",
                               "triples": [{"s": "用户", "relation": "就读于", "t": "西电"}]})
        self.assertEqual(r1["type"], "graph_learn_result")
        self.assertEqual(r1["learned"], 1)
        q = self.w.roundtrip({"reqId": 2, "type": "graph_query", "userId": "master",
                              "text": "西电怎么样", "now": self.now})
        self.assertEqual(q["type"], "graph_query_result")
        self.assertIn("西电 <-[就读于]- 用户", q["pathsText"])
        self.assertEqual(q["seedNames"][0], "西电")            # 直扫打底,机械兜底词跟后
        self.assertEqual(len(q["hitEdgeIds"]), 1)
        self.assertEqual(q["hitEdgeIds"], q["ltpEdgeIds"])     # 无 pinned 时两者一致
        r2 = self.w.roundtrip({"reqId": 3, "type": "graph_reinforce",
                               "hitEdgeIds": q["hitEdgeIds"], "ltpEdgeIds": q["ltpEdgeIds"],
                               "now": self.now})
        self.assertEqual(r2["type"], "graph_reinforce_result")
        self.assertEqual(r2["reinforced"], 1)
        self.assertEqual(r2["ltp"], 1)
        # 落库验证:想起次数 +1,权重 +1.0(主人)
        conn = db.connect(self.db)
        try:
            row = conn.execute(
                "SELECT recall_count, weight FROM graph_edges").fetchone()
            self.assertEqual(row[0], 1)
            self.assertEqual(row[1], 2.0)
        finally:
            conn.close()

    def test_extra_seeds_llm_channel(self):
        """LLM 种子通道:文本没字面提到,靠 extraSeeds 实体链接命中。"""
        self.w.roundtrip({"reqId": 1, "type": "graph_learn", "userId": "master",
                          "triples": [{"s": "用户", "relation": "喜欢", "t": "章鱼小丸子"}]})
        q = self.w.roundtrip({"reqId": 2, "type": "graph_query", "userId": "master",
                              "text": "今天想吃点好的", "now": self.now,
                              "extraSeeds": ["章鱼小丸子"]})
        self.assertIn("章鱼小丸子", q["pathsText"])
        # 对照:无 extraSeeds 且文本无字面命中 → 只有机械种子兜底,匹配不上
        q2 = self.w.roundtrip({"reqId": 3, "type": "graph_query", "userId": "master",
                               "text": "今天想吃点好的", "now": self.now})
        self.assertEqual(q2["pathsText"], "")

    def test_pinned_excluded_from_hits(self):
        """pinned(L0)进注入但不进 hit/ltp —— 每轮注入≠每轮强化。"""
        self.w.roundtrip({"reqId": 1, "type": "graph_learn", "userId": "master",
                          "triples": [{"s": "用户", "relation": "称呼", "t": "阿岚",
                                       "layer": "L0", "certainty": "explicit",
                                       "attribution": "user_explicit"}]})
        q = self.w.roundtrip({"reqId": 2, "type": "graph_query", "userId": "master",
                              "text": "随便聊聊", "now": self.now})
        self.assertEqual(q["pinnedCount"], 1)
        self.assertIn("[核心] 用户-[称呼]-> 阿岚", q["pathsText"])
        self.assertEqual(q["hitEdgeIds"], [])                  # pinned 不算想起
        self.assertEqual(q["ltpEdgeIds"], [])
        # reinforce 空集合:不强化任何边
        r = self.w.roundtrip({"reqId": 3, "type": "graph_reinforce",
                              "hitEdgeIds": [], "ltpEdgeIds": [], "now": self.now})
        self.assertEqual(r["reinforced"], 0)

    def test_owner_isolation(self):
        """归属隔离:master 的边不进别人的子图。"""
        self.w.roundtrip({"reqId": 1, "type": "graph_learn", "userId": "master",
                          "triples": [{"s": "用户", "relation": "就读于", "t": "西电"}]})
        q = self.w.roundtrip({"reqId": 2, "type": "graph_query", "userId": "stranger",
                              "text": "西电怎么样", "now": self.now})
        self.assertEqual(q["pathsText"], "")

    def test_junk_seeds_never_reported_as_seeds(self):
        """★ F8 端到端:`seedNames` 是诊断信号,垃圾词不许冒充种子。

        现场:旧版 `match_seeds_to_graph` 末尾有"兜底保留原词",把没链接上的
        词原样返回,而 `worker.py:900` 把返回值当 `seedNames` 进帧 ⇒
        一次真实检索里 `seedNames` 会混进 'QQ' / '有什么想说的吗' / '——'。
        F6 的验收恰恰要靠 `seedNames` 判通道②是否接上 —— 它必须先诚实。
        """
        self.w.roundtrip({"reqId": 1, "type": "graph_learn", "userId": "master",
                          "triples": [{"s": "用户", "relation": "喜欢", "t": "章鱼小丸子"}]})
        junk = ["QQ", "有什么想说的吗", "——", "完全无关的词"]
        q = self.w.roundtrip({"reqId": 2, "type": "graph_query", "userId": "master",
                              "text": "今天想吃点好的", "now": self.now,
                              "extraSeeds": ["章鱼小丸子"] + junk})
        self.assertIn("章鱼小丸子", q["seedNames"])
        for j in junk:
            self.assertNotIn(j, q["seedNames"], "未匹配的词被当成种子报出去了: " + j)
        self.assertIn("章鱼小丸子", q["pathsText"])


class MatchSeedsToGraphTest(unittest.TestCase):
    """F8:`match_seeds_to_graph` 只返回**真的在图里的**节点名。"""

    def setUp(self):
        # 注意:这里刻意**不**把长名也建成节点 —— 要留出"种子是长名、
        # 节点是短名"的双向子串路径来测。
        self.by_name = {
            "西电": {"node_id": "n1"},
            "用户": {"node_id": "n2"},
            "章鱼小丸子": {"node_id": "n3"},
        }

    def test_exact_name(self):
        self.assertEqual(graph.match_seeds_to_graph(["西电"], self.by_name), ["西电"])

    def test_unmatched_is_dropped(self):
        """★ F8 核心:没链接上的词不许回来(旧版"兜底保留原词")。"""
        self.assertEqual(graph.match_seeds_to_graph(["完全无关的词"], self.by_name), [])
        self.assertEqual(graph.match_seeds_to_graph(["有什么想说的吗"], self.by_name), [])
        self.assertEqual(graph.match_seeds_to_graph(["QQ"], self.by_name), [])
        self.assertEqual(graph.match_seeds_to_graph(["——"], self.by_name), [])

    def test_mixed_keeps_only_matches(self):
        self.assertEqual(
            graph.match_seeds_to_graph(["章鱼小丸子", "QQ", "完全无关", "西电"], self.by_name),
            ["章鱼小丸子", "西电"])

    def test_both_directions(self):
        """双向子串:种子比节点名短、或比它长(含节点名)都要链接得上。

        注意「西电」与「西安电子科技大学」**不是**子串关系(它是缩写,中间
        隔着字),那种要靠别名表 —— 属 F10 的范围,这里不测。
        """
        self.assertEqual(
            graph.match_seeds_to_graph(["小丸子"], self.by_name), ["章鱼小丸子"])
        self.assertEqual(
            graph.match_seeds_to_graph(["章鱼小丸子很好吃"], self.by_name), ["章鱼小丸子"])

    def test_dedup_and_trim(self):
        self.assertEqual(
            graph.match_seeds_to_graph(["西电", "西电", " 西电 "], self.by_name), ["西电"])

    def test_cap(self):
        by_name = {"n%d" % i: {"node_id": str(i)} for i in range(20)}
        got = graph.match_seeds_to_graph(list(by_name.keys()), by_name, max_seeds=5)
        self.assertEqual(len(got), 5)

    def test_empty_inputs(self):
        self.assertEqual(graph.match_seeds_to_graph([], self.by_name), [])
        self.assertEqual(graph.match_seeds_to_graph(["西电"], {}), [])
        self.assertEqual(graph.match_seeds_to_graph(["", "   "], self.by_name), [])

    def test_no_fallback_pass_in_source(self):
        """静态守卫:旧版那趟「兜底保留原词」不许复活。

        结构判据(比扫文字可靠 —— 不受 docstring 影响):旧版有**两趟**
        `for seed in raw_seeds` 循环、**三处** `matched.append(`;
        现在只该有一趟、两处。
        """
        import os as _os
        p = _os.path.join(_os.path.dirname(__file__), "..", "engine", "graph.py")
        with open(p, encoding="utf-8") as fh:
            src = fh.read()
        body = src[src.index("def match_seeds_to_graph"):]
        body = body[:body.index("\ndef ", 10)]
        code = "\n".join(line.split("#", 1)[0] for line in body.splitlines())
        self.assertEqual(code.count("for seed in raw_seeds"), 1,
                         "多出一趟种子循环 ⇒ 又把未匹配的词塞回去了")
        self.assertEqual(code.count("matched.append("), 2,
                         "多出一处 append ⇒ 返回值里混进了非节点名")


if __name__ == "__main__":
    unittest.main()
