# -*- coding: utf-8 -*-
"""F11 / F12:L0 图位治理。

现场(2026-09-27 取证):全库 35 条图边里只有 **2 条** `layer='L0'`,两条都是
**偏好**(`用户-[喜欢]->章鱼小丸子` iv=91.1、`阿岚-[喜欢吃]->章鱼小丸子`
iv=95.9)。而 `graph.py:539-542` 的 L0 强注把它们无条件塞进每一轮注入 ——
实测 22/22 条审计行的注入里都有同样那两行。真正的身份事实边
(`用户-[就读于]->西安电子科技大学`、`用户-[是]->大一学生`)layer 全是空的。
**L0 图位被偏好占了,身份反而在外面。**

他的裁决:「降级为普通边 + 补真正的 L0 边」。
"""

import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from engine import db as dbmod      # noqa: E402
from engine import episodic         # noqa: E402
from engine import graph            # noqa: E402
from engine import l0_tier          # noqa: E402
from test_worker import WorkerHarness, hello_frame  # noqa: E402

# P1c:自节点名改由数据下发(`names.json` 的 `ownerNames`)。这组夹具 = 引擎里那份
# 被替换掉的硬编码,逐字照抄 —— 测试靠 `owner_node_names=` 把它喂回去。
LEGACY_OWNER_NODE_NAMES = ("用户", "阿岚")


class IdentityRelationTest(unittest.TestCase):
    def test_whitelist(self):
        for rel in ("是", "就读于", "就读专业", "负责", "属于", "称呼"):
            self.assertTrue(l0_tier.is_identity_relation(rel), rel)
        for rel in ("喜欢", "喜欢吃", "在做", "在忙", "搭建", "正在开发",
                    "参加", "不喜欢", "可能转到", "习惯", "有预算", ""):
            self.assertFalse(l0_tier.is_identity_relation(rel), rel)

    def test_owner_node_names(self):
        """P1c:自节点名也改由数据下发 —— 代码里只剩中性角色槽,他的称呼是数据。

        旧口径(「用户」+「主人」)不许再写进代码:要它,就由调用方喂
        `owner_node_names=`(见 `PromoteTest.test_owner_node_names_come_from_the_caller`)。
        """
        self.assertIn("用户", l0_tier.OWNER_NODE_NAMES)
        self.assertNotIn("阿岚", l0_tier.OWNER_NODE_NAMES,
                         "代码里不许再留他的称呼(名字改由数据下发)")


class _Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.conn = dbmod.connect(os.path.join(self.tmp.name, "echo.db"))

    def tearDown(self):
        self.conn.close()
        self.tmp.cleanup()

    def _layers(self):
        return {int(r[0]): str(r[1] or "")
                for r in self.conn.execute(
                    "SELECT edge_id, layer FROM graph_edges").fetchall()}

    def _raw_edge(self, s, rel, t, *, iv=10.0, owner="master", layer=""):
        """直插一条边,谓词与层级原样 —— 造"历史行"用。

        不走 `add_edge`:F10 之后它在写入侧就把谓词接地了,而且槽位
        (`src|rel`)语义会让同槽位的新宾语**淘汰旧现役**。活库里
        `用户|就读于` 槽位下 `#13`/`#17` 两条**并存现役**(它们是槽位列
        存在之前就有的行),所以测试也得这么造才像真库。
        """
        sid = graph.get_or_create_node(self.conn, s)
        tid = graph.get_or_create_node(self.conn, t)
        cur = self.conn.execute(
            "INSERT INTO graph_edges (source_id, target_id, relation, owner_key,"
            " intrinsic_value, is_active, layer) VALUES (?, ?, ?, ?, ?, 1, ?)",
            (sid, tid, rel, owner, float(iv), layer))
        self.conn.commit()
        return int(cur.lastrowid)

    def _pinned(self):
        """跑一次真 load + graph_activate,看哪些边进了 pinned(强注)。"""
        by_id, by_name, edges = graph.load(self.conn, "master")
        paths, _ = graph.graph_activate([], by_id, by_name, edges, now_ts=1700000000.0)
        return [p["path"] for p in paths if p.get("pinned")]


class DemoteTest(_Base):
    """F11:不是身份事实的 L0 边降级。"""

    def test_demotes_preference_l0_edge(self):
        graph.add_edge(self.conn, "用户", "喜欢", "章鱼小丸子", "master",
                       intrinsic_value=91.1, layer="L0")
        self.conn.commit()
        hit = l0_tier.demote_non_identity_l0_edges(self.conn, "master")
        self.assertEqual(len(hit), 1, "偏好边该被降级")
        self.assertEqual(self._layers()[hit[0]], "")
        # 留档语义不变:没删、还活着
        row = self.conn.execute(
            "SELECT is_active FROM graph_edges WHERE edge_id = ?", (hit[0],)).fetchone()
        self.assertEqual(row[0], 1, "降级不是删除 —— is_active 不许动")

    def test_keeps_identity_l0_edge(self):
        graph.add_edge(self.conn, "用户", "就读于", "西安电子科技大学", "master",
                       intrinsic_value=95.0, layer="L0")
        self.conn.commit()
        self.assertEqual(l0_tier.demote_non_identity_l0_edges(self.conn, "master"), [])
        self.assertEqual(list(self._layers().values()), ["L0"])

    def test_does_not_touch_plain_edges(self):
        graph.add_edge(self.conn, "用户", "喜欢", "章鱼小丸子", "master")
        self.conn.commit()
        self.assertEqual(l0_tier.demote_non_identity_l0_edges(self.conn, "master"), [])

    def test_idempotent_and_dry_run(self):
        graph.add_edge(self.conn, "用户", "喜欢吃", "章鱼小丸子", "master",
                       layer="L0")
        self.conn.commit()
        # dry_run 不改库
        self.assertEqual(
            len(l0_tier.demote_non_identity_l0_edges(self.conn, "master", dry_run=True)), 1)
        self.assertEqual(list(self._layers().values()), ["L0"])
        # 真跑一次
        self.assertEqual(
            len(l0_tier.demote_non_identity_l0_edges(self.conn, "master")), 1)
        # 再跑:零改动(幂等)
        self.assertEqual(l0_tier.demote_non_identity_l0_edges(self.conn, "master"), [])

    def test_owner_isolation(self):
        graph.add_edge(self.conn, "用户", "喜欢", "章鱼小丸子", "stranger",
                       layer="L0")
        self.conn.commit()
        self.assertEqual(l0_tier.demote_non_identity_l0_edges(self.conn, "master"), [])
        self.assertEqual(list(self._layers().values()), ["L0"])


class PromoteTest(_Base):
    """F12:按 L0 记忆把已存在的身份边提到 L0。"""

    def _seed(self):
        # 身份事实的边(learn 早写下的,layer 空)。直插 —— 见 `_raw_edge`。
        self._raw_edge("用户", "就读于", "西安电子科技大学", iv=95.0)
        self._raw_edge("用户", "就读专业", "新工科大学")
        self._raw_edge("用户", "是", "大一学生")
        # 活动边 —— 谓词不在白名单,不该被提
        self._raw_edge("用户", "搭建", "Echo记忆架构")

    def _l0_memory(self, text, layer="L0"):
        mid = episodic.insert_memory(
            self.conn, "master", "[]", text, 9, now=100.0,
            layer=layer, intrinsic_value=95.9)
        self.conn.commit()
        return mid

    def test_promotes_edges_the_l0_memory_names(self):
        self._seed()
        self._l0_memory("用户就读于西安电子科技大学（西电）。")
        self._l0_memory("用户是大学生，就读于一所新工科大学。")
        hit = l0_tier.promote_identity_edges_from_l0_memories(self.conn, "master")
        # 字面提到才提:西安电子科技大学(就读于)、新工科大学(就读专业)
        self.assertEqual(len(hit), 2, "该提到 L0 的边数不对: %r" % (hit,))
        layers = self._layers()
        for eid in hit:
            self.assertEqual(layers[eid], "L0")
        rels = {str(r[0]) for r in self.conn.execute(
            "SELECT relation FROM graph_edges WHERE COALESCE(layer,'')='L0'")}
        self.assertEqual(rels, {"就读于", "就读专业"})
        self.assertNotIn("搭建", rels, "活动不是身份,不许进 L0")

    def test_only_literal_node_names_count(self):
        """★ 纪律:只认记忆里**字面**出现的节点名(零幻觉,与 F6 同一把尺子)。

        代价说清楚:节点叫「大一学生」而记忆写「目前大一」—— **推不出来**。
        这是故意的宁缺毋滥:请模型来"理解这条记忆讲的是谁"就会编。
        """
        graph.add_edge(self.conn, "用户", "是", "大一学生", "master")
        graph.add_edge(self.conn, "用户", "是", "大学生", "master")
        self.conn.commit()
        self._l0_memory("用户是大学生，目前大一。")
        hit = l0_tier.promote_identity_edges_from_l0_memories(self.conn, "master")
        self.assertEqual(len(hit), 1, "只该提字面命中的那条: %r" % (hit,))
        names = {int(r[0]): str(r[1]) for r in self.conn.execute(
            "SELECT g.edge_id, n.name FROM graph_edges g"
            " JOIN graph_nodes n ON n.node_id = g.target_id")}
        self.assertEqual([names[e] for e in hit], ["大学生"])
        # 「大一学生」那条仍在普通层(字面没提到 ⇒ 不提)
        layers = self._layers()
        for eid, nm in names.items():
            if nm == "大一学生":
                self.assertEqual(layers[eid], "")

    def test_no_l0_memory_means_no_promotion(self):
        self._seed()
        self._l0_memory("用户就读于西安电子科技大学。", layer="reflection")
        self.assertEqual(
            l0_tier.promote_identity_edges_from_l0_memories(self.conn, "master"), [])

    def test_only_owner_side_edges(self):
        """别人的学校不是他的 L0 —— 一端必须是自节点。"""
        graph.add_edge(self.conn, "她", "就读于", "新工科大学", "master")
        self.conn.commit()
        self._l0_memory("用户就读于新工科大学。")
        self.assertEqual(
            l0_tier.promote_identity_edges_from_l0_memories(self.conn, "master"), [])

    def test_owner_node_names_come_from_the_caller(self):
        """P1c:「主人」算不算自节点**由调用方给**(`owner_node_names=`)—— 喂回去
        以后,行为与被替换掉的那份硬编码(「用户」+「主人」)逐字一致。"""
        self._raw_edge("阿岚", "就读于", "新工科大学")
        self._l0_memory("阿岚就读于新工科大学。")
        # 代码默认里没有「主人」⇒ 不给名单,这条提不上来
        self.assertEqual(
            l0_tier.promote_identity_edges_from_l0_memories(self.conn, "master"), [],
            "代码里还留着「主人」?名字改由数据下发之后这里必须是空的")
        hit = l0_tier.promote_identity_edges_from_l0_memories(
            self.conn, "master", owner_node_names=LEGACY_OWNER_NODE_NAMES)
        self.assertEqual(len(hit), 1, "喂了旧名单还是提不上来: %r" % (hit,))
        self.assertEqual(self._layers()[hit[0]], "L0")

    def test_idempotent_and_dry_run(self):
        self._seed()
        self._l0_memory("用户就读于西安电子科技大学。")
        self.assertEqual(len(l0_tier.promote_identity_edges_from_l0_memories(
            self.conn, "master", dry_run=True)), 1)
        self.assertNotIn("L0", self._layers().values(), "dry_run 不该写库")
        self.assertEqual(len(l0_tier.promote_identity_edges_from_l0_memories(
            self.conn, "master")), 1)
        # 已经是 L0 了 → 再跑不提
        self.assertEqual(
            l0_tier.promote_identity_edges_from_l0_memories(self.conn, "master"), [])

    def test_archived_l0_memories_still_count(self):
        """★ 12 条身份 L0 记忆被悬空引用那个 bug 归档了 —— 派生不许因此落空。

        这里踩过一次坑:第一版写成"现役为空才回退到全集",而现役恰好有 1 条
        ⇒ 回退永不触发 ⇒ 真库里提升 0 条。改成一律用全集。
        """
        self._seed()
        # 一条现役 L0(与身份无关,模拟 #125)+ 一条被归档的身份 L0
        self._l0_memory("Echo 的设计灵感来源于风又音理。")
        mid = self._l0_memory("用户就读于西安电子科技大学。")
        self.conn.execute(
            "UPDATE episodic_memory SET is_active = 0 WHERE memory_id = ?", (mid,))
        self.conn.commit()
        self.assertEqual(len(l0_tier.promote_identity_edges_from_l0_memories(
            self.conn, "master")), 1,
            "被 bug 归档的身份记忆必须仍然参与派生(现役那 1 条什么也说不出来)")


class MigrateEndToEndTest(_Base):
    """端到端:治理跑完,L0 强注从「章鱼小丸子」换成身份事实。"""

    def test_pinned_swaps_preference_for_identity(self):
        # 现状复刻:两条偏好霸占 L0 位
        graph.add_edge(self.conn, "用户", "喜欢", "章鱼小丸子", "master",
                       intrinsic_value=91.1, layer="L0")
        graph.add_edge(self.conn, "阿岚", "喜欢吃", "章鱼小丸子", "master",
                       intrinsic_value=95.917, layer="L0")
        # 身份事实边早就有了,只是没层标
        graph.add_edge(self.conn, "用户", "就读于", "西安电子科技大学", "master",
                       intrinsic_value=95.0)
        graph.add_edge(self.conn, "用户", "是", "大一学生", "master")
        self.conn.commit()
        episodic.insert_memory(
            self.conn, "master", "[]", "用户就读于西安电子科技大学（西电）。", 9,
            now=100.0, layer="L0", intrinsic_value=95.917)
        self.conn.commit()

        before = self._pinned()
        self.assertEqual(sorted(tuple(p) for p in before),
                         sorted([("用户", "章鱼小丸子"), ("阿岚", "章鱼小丸子")]),
                         "前提:治理前 pinned 就是那两条章鱼小丸子")

        out = l0_tier.migrate(self.conn, "master")
        self.assertEqual(len(out["demoted"]), 2, "两条偏好该被降级")
        # 只有「西安电子科技大学」在记忆里字面出现 ⇒ 提 1 条。
        # 「大一学生」推不出来(记忆写的是完整校名,没写这个属性名)——
        # 字面纪律的已知代价,见 PromoteTest.test_only_literal_node_names_count。
        self.assertEqual(len(out["promoted"]), 1)

        after = self._pinned()
        flat = ["%s|%s" % (p[0], p[1]) for p in after]
        self.assertNotIn("用户|章鱼小丸子", flat, "偏好还在霸占 L0 位")
        self.assertNotIn("阿岚|章鱼小丸子", flat, "偏好还在霸占 L0 位")
        self.assertIn("用户|西安电子科技大学", flat, "身份事实该进 L0 强注")

    def test_migrate_is_idempotent(self):
        graph.add_edge(self.conn, "用户", "喜欢", "章鱼小丸子", "master",
                       layer="L0")
        graph.add_edge(self.conn, "用户", "就读于", "西安电子科技大学", "master")
        self.conn.commit()
        episodic.insert_memory(
            self.conn, "master", "[]", "用户就读于西安电子科技大学。", 9,
            now=100.0, layer="L0")
        self.conn.commit()
        first = l0_tier.migrate(self.conn, "master")
        self.assertEqual((len(first["demoted"]), len(first["promoted"])), (1, 1))
        second = l0_tier.migrate(self.conn, "master")
        self.assertEqual((len(second["demoted"]), len(second["promoted"])), (0, 0))

    def test_migrate_takes_owner_names_from_the_caller(self):
        """P1c:`migrate()` 把自节点名一路透传给提升那一步(数据驱动的那一份)。"""
        graph.add_edge(self.conn, "阿岚", "就读于", "新工科大学", "master")
        self.conn.commit()
        episodic.insert_memory(
            self.conn, "master", "[]", "阿岚就读于新工科大学。", 9,
            now=100.0, layer="L0")
        self.conn.commit()
        self.assertEqual(len(l0_tier.migrate(self.conn, "master")["promoted"]), 0,
                         "不给名单:代码里已经没有他的称呼了")
        out = l0_tier.migrate(self.conn, "master",
                              owner_node_names=LEGACY_OWNER_NODE_NAMES)
        self.assertEqual(len(out["promoted"]), 1, "喂了名单该把这条身份边提到 L0")

    def test_after_relation_merge_only_one_identity_edge_per_fact(self):
        """F10 × F11/F12 联动:变体先并掉,层标判断因此只面对一条规范边。

        不并的话「就读于/读于/就读专业 → 新工科大学」三条会被一起提到 L0,
        面板上还是三根并排的线、BFS 里还是三条路径。
        """
        self._raw_edge("用户", "就读于", "新工科大学", iv=10.0)
        self._raw_edge("用户", "读于", "新工科大学", iv=10.0)
        self._raw_edge("用户", "就读专业", "新工科大学", iv=10.0)
        episodic.insert_memory(
            self.conn, "master", "[]", "用户就读于新工科大学。", 9,
            now=100.0, layer="L0", intrinsic_value=95.917)
        self.conn.commit()

        graph.merge_relation_variants(self.conn, "master")
        l0_tier.migrate(self.conn, "master")
        live = self.conn.execute(
            "SELECT count(*) FROM graph_edges WHERE is_active = 1").fetchone()[0]
        self.assertEqual(live, 1, "同一事实只该剩一条现役边")
        pinned = self._pinned()
        self.assertEqual(len(pinned), 1, "强注里也只该有一条")
        self.assertEqual(pinned[0][1], "新工科大学")

    def test_demote_runs_before_promote(self):
        """先降后升 —— 否则配额会被偏好挤掉(F11 之前那两条就在配额里)。"""
        import inspect
        src = inspect.getsource(l0_tier.migrate)
        self.assertLess(src.index("demoted = "), src.index("promoted = "),
                        "顺序反了:配额会被偏好占住")


class WorkerWiringTest(unittest.TestCase):
    """治理挂在插件自己的代码路径上(graph_query),不靠谁手改库。"""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.db = os.path.join(self.tmp.name, "echo.db")
        dbmod.connect(self.db).close()
        self.w = WorkerHarness()
        ready = self.w.roundtrip(hello_frame(db_path=self.db))
        self.assertEqual(ready["type"], "ready")

    def tearDown(self):
        self.w.close()
        self.tmp.cleanup()

    def _seed(self):
        conn = dbmod.connect(self.db)
        graph.add_edge(conn, "用户", "喜欢", "章鱼小丸子", "master",
                       intrinsic_value=91.1, layer="L0")
        graph.add_edge(conn, "用户", "就读于", "西安电子科技大学", "master",
                       intrinsic_value=95.0)
        episodic.insert_memory(
            conn, "master", "[]", "用户就读于西安电子科技大学（西电）。", 9,
            now=100.0, layer="L0", intrinsic_value=95.917)
        conn.commit()
        conn.close()

    def test_graph_query_runs_the_migration(self):
        self._seed()
        q = self.w.roundtrip({"reqId": 1, "type": "graph_query", "userId": "master",
                              "text": "随便聊聊", "now": 1700000000.0})
        self.assertEqual(q["type"], "graph_query_result")
        # 治理没跑的话 pinnedCount = 1 且是「用户-[喜欢]->章鱼小丸子」
        self.assertIn("西安电子科技大学", q["pathsText"],
                      "身份事实该进 L0 强注(治理没生效)")
        self.assertNotIn("章鱼小丸子", q["pathsText"],
                         "偏好还在霸占 L0 强注")
        self.assertEqual(q["pinnedCount"], 1)
        # 落库验证:偏好边 layer 被清空、身份边被提到 L0
        conn = dbmod.connect(self.db)
        try:
            got = {str(r[0]): str(r[1] or "") for r in conn.execute(
                "SELECT relation, layer FROM graph_edges").fetchall()}
            self.assertEqual(got["喜欢"], "", "偏好边该被降级")
            self.assertEqual(got["就读于"], "L0", "身份边该被提到 L0")
        finally:
            conn.close()

    def test_migration_is_idempotent_over_the_wire(self):
        self._seed()
        for i in (1, 2, 3):
            q = self.w.roundtrip({"reqId": i, "type": "graph_query",
                                  "userId": "master", "text": "随便聊聊",
                                  "now": 1700000000.0})
            self.assertEqual(q["pinnedCount"], 1)
        conn = dbmod.connect(self.db)
        try:
            n = conn.execute("SELECT count(*) FROM graph_edges"
                             " WHERE COALESCE(layer,'') = 'L0'").fetchone()[0]
            self.assertEqual(n, 1)
        finally:
            conn.close()

    def test_governance_failure_does_not_kill_graph_query(self):
        """治理炸了,图那段不许陪葬(尽力而为,写 stderr)。"""
        with open(os.path.join(os.path.dirname(__file__), "..", "worker.py"),
                  encoding="utf-8") as fh:
            src = fh.read()
        self.assertIn("L0 图位治理失败(已忽略)", src)
        self.assertIn("l0_tier.migrate(conn, owner)", src)


if __name__ == "__main__":
    unittest.main()
