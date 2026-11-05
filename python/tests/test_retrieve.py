# -*- coding: utf-8 -*-
"""情景检索测试(M2-b3)。

差分锚点与 tests/retrieve.test.js 逐点镜像(NOW=1700000000 基准行):
同输入必同输出 —— JS 与 Python 两套实现共用同一组公式,任何一边
漂了,另一边的锚点就会喊出来。
"""
import sys
import tempfile
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from engine import db, retrieve  # noqa: E402
from test_worker import WorkerHarness, hello_frame  # noqa: E402

NOW = 1700000000
BASE = {
    "memory_id": 1, "keywords": [], "summary": "", "emotion_score": 5,
    "timestamp": NOW - 3600, "intrinsic_value": 50, "half_life": 24,
    "recall_count": 0, "last_recalled": 0, "layer": "",
    "occurred_at": 0, "learned_at": NOW, "temporal_status": "time_unknown",
    "source": "dsh", "source_label": "", "actor": "",
}


class HitCascade(unittest.TestCase):
    """相关性打分 + L0 语义 —— 与 JS 测试同名用例逐点对表。

    RT2(2026-09-27)换掉了旧的"五档命中分层":现在是
    **正文(摘要+关键词)上的 BM25 idf 加权覆盖率**(见 engine/lexical.py)。
    旧档位只索引 keywords 字段(漏洞①),分数离散、同档内无法分辨命中几个词。
    """

    def test_segment_query(self):
        segs = retrieve.segment_query("我喜欢写代码,也喜欢你")
        self.assertIn("我喜欢写代码", segs)
        self.assertIn("也喜欢你", segs)
        self.assertNotIn("我", segs)

    def test_body_is_indexed_not_just_keywords(self):
        """★ 漏洞①回归:摘要里的词必须能被搜到 —— 旧版只索引 keywords 字段。

        旧行为:抽取器没把「新生」写进 keywords ⇒ 这条记忆**永远搜不到**。
        这是"信息不在索引里",不是"算法不够好"(索引正文严格更有信息)。
        """
        row = {**BASE, "memory_id": 1, "keywords": ["大学"],
               "summary": "用户就读于一所新工科大学,是西电大一新生"}
        top = retrieve.rank_memories([row], "新生", 6, NOW)
        self.assertEqual(len(top), 1, "摘要里明明有「新生」却检不出来 = 漏洞①")
        self.assertGreater(top[0]["hits"], 0)
        self.assertTrue(top[0]["matched"])

    def test_relevance_is_continuous_not_tiered(self):
        """RT2:相关性是 [0,1] 的连续覆盖率,不再是离散档位。

        旧档位(1.0/0.7/0.5/0.3/0.4)同档内分不出"命中一个词"与"命中五个词"。
        """
        rows = [
            {**BASE, "memory_id": 1, "keywords": [], "summary": "章鱼小丸子"},
            {**BASE, "memory_id": 2, "keywords": [],
             "summary": "他提到章鱼小丸子很难买到,几乎几年才能吃一次"},
        ]
        top = retrieve.rank_memories(rows, "章鱼小丸子", 6, NOW)
        covs = {t["memory_id"]: t["hits"] for t in top}
        self.assertEqual(len(top), 2)
        # 短文档(命中面占全文比例更高)覆盖率更高 —— 长度归一在起作用
        self.assertGreater(covs[1], covs[2])
        self.assertLessEqual(covs[1], 1.0)

    def test_summary_only_term_is_retrievable(self):
        """漏洞①的另一种形态:keywords 全空、只有摘要能对上也要检得出来。"""
        row = {**BASE, "keywords": [], "summary": "他说他喜欢猫,养了两只"}
        top = retrieve.rank_memories([row], "两只猫", 6, NOW)
        self.assertEqual(len(top), 1, "只有摘要能对上就检不出来 = 漏洞①")

    def test_comma_format_keywords(self):
        """AstrBot v5.x 逗号串关键词(DSH 修复,与 JS safeJsonArray 对齐):
        解析成词表且照常参与命中 —— 漏掉它们 = 反思层记忆全部检不出。"""
        self.assertEqual(retrieve.parse_keywords("面试,网站建设,失败"),
                         ["面试", "网站建设", "失败"])
        self.assertEqual(retrieve.parse_keywords('["章鱼小丸子","学做"]'),
                         ["章鱼小丸子", "学做"])
        self.assertEqual(retrieve.parse_keywords("学做、约定"), ["学做", "约定"])
        self.assertEqual(retrieve.parse_keywords(""), [])
        self.assertEqual(retrieve.parse_keywords(None), [])
        # 逗号串照常命中(RT2 起走覆盖率,不再是离散档位)
        row = {**BASE, "memory_id": 1, "keywords": ["面试", "网站建设", "失败"],
               "summary": "他参加学校网站建设部门面试未通过"}
        top = retrieve.rank_memories([row], "还记得面试的事吗", 6, NOW)
        self.assertEqual(len(top), 1)
        self.assertGreater(top[0]["hits"], 0)

    def test_single_char_query_still_matches(self):
        """★ 漏洞①的边界:`echo_forget "猫"` 这类**单字查询**必须能匹配
        「他喜欢猫」这种正文。

        只产二字组合时,查询「猫」与文档「他喜欢猫」的边界二字(`猫吗`/`欢猫`)
        不同 ⇒ 0 命中,「>10 拒绝」保护直接失效。所以单字也要产
        (Lucene CJKAnalyzer 的 unigram+bigram 做法)。
        """
        row = {**BASE, "memory_id": 1, "keywords": [], "summary": "他喜欢猫"}
        top = retrieve.rank_memories([row], "猫", 6, NOW)
        self.assertEqual(len(top), 1, "单字查询被词元层丢掉了")

    def test_l0_exemption(self):
        """零命中:非 L0 出局,L0 豁免进池。"""
        rows = [
            {**BASE, "memory_id": 1, "keywords": ["完全无关"], "summary": "无关的事"},
            {**BASE, "memory_id": 2, "keywords": ["称呼"], "summary": "他喜欢被叫阿岚",
             "layer": "L0", "intrinsic_value": 90},
        ]
        top = retrieve.rank_memories(rows, "今天天气怎么样", 6, NOW)
        self.assertEqual(len(top), 1)
        self.assertEqual(top[0]["memory_id"], 2)

    def test_forced_seats_leave_two(self):
        """强制占位但给常规结果留 2 席 —— 与 JS 测试同构。"""
        rows = []
        for i in range(1, 9):
            rows.append({**BASE, "memory_id": i, "keywords": ["话题"],
                         "summary": "常规记忆" + str(i), "layer": "L0",
                         "intrinsic_value": i})
        # 常规行情感分更高:在「剩余席位」的竞争中稳赢未占位的 L0
        rows.append({**BASE, "memory_id": 11, "keywords": ["话题"],
                     "summary": "常规命中A", "emotion_score": 9})
        rows.append({**BASE, "memory_id": 12, "keywords": ["话题"],
                     "summary": "常规命中B", "emotion_score": 9})
        rows.append({**BASE, "memory_id": 13, "keywords": ["话题"],
                     "summary": "常规命中C", "emotion_score": 9})
        top = retrieve.rank_memories(rows, "话题", 6, NOW)
        self.assertEqual(len(top), 6)
        l0 = [t for t in top if t["layer"] == "L0"]
        self.assertEqual(len(l0), 4)              # min(8, 6-2) = 4
        self.assertEqual(len([t for t in top if t["layer"] != "L0"]), 2)

    def test_forced_seats_cap_eight(self):
        """上限 8 生效:topK=12 时 L0 占 min(8, 10)=8 席(AstrBot 真值)。"""
        rows = []
        for i in range(1, 11):
            rows.append({**BASE, "memory_id": i, "keywords": ["话题"],
                         "summary": "核心" + str(i), "layer": "L0",
                         "intrinsic_value": i})
        for i in range(1, 5):
            rows.append({**BASE, "memory_id": 20 + i, "keywords": ["话题"],
                         "summary": "常规" + str(i), "emotion_score": 9})
        top = retrieve.rank_memories(rows, "话题", 12, NOW)
        l0 = [t for t in top if t["layer"] == "L0"]
        self.assertEqual(len(l0), 8)              # min(8, 12-2) = 8
        self.assertEqual(len(top), 12)

    def test_score_formula(self):
        """总分 = 覆盖率×1.0 + R×0.15 + 情感×0.02 —— 相关性主导,情感只在
        相关性相当时把人**最在意**的那条顶上来(RT2 起 R 从 40% 降到 15%)。"""
        rows = [
            {**BASE, "memory_id": 1, "keywords": ["猫"], "summary": "他提到猫",
             "emotion_score": 2},
            {**BASE, "memory_id": 2, "keywords": ["猫"], "summary": "他为猫生病哭了",
             "emotion_score": 9},
        ]
        top = retrieve.rank_memories(rows, "猫", 2, NOW)
        self.assertEqual(top[0]["memory_id"], 2)

    def test_h0_fallback(self):
        """半衰期缺失时按内在价值现算 H0(降级路径)。

        RT2 附注:查询要能切出词元 —— 单个拉丁字母(旧版这里用 "x")在新词元
        层里被丢弃(长度 ≤1 且非数字,滤单字母噪声),所以换成汉字查询。
        """
        row = {**BASE, "memory_id": 1, "keywords": ["面"], "summary": "面试",
               "half_life": 0, "intrinsic_value": 100}
        top = retrieve.rank_memories([row], "面试", 1, NOW)
        self.assertGreater(top[0]["half_life"], 24 * 10)


class RetrieveAndRender(unittest.TestCase):
    """读库检索 + 召回即强化 + 渲染。"""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.db = str(Path(self.tmp.name) / "echo.db")
        self.conn = db.connect(self.db)
        self.now = time.time()

    def tearDown(self):
        self.conn.close()
        self.tmp.cleanup()

    def _insert(self, summary, keywords, *, layer="", emotion=5,
                intrinsic=50, half_life=24, ts=None):
        import json as _json
        cur = self.conn.execute(
            "INSERT INTO episodic_memory (user_id, keywords, summary,"
            " emotion_score, timestamp, intrinsic_value, half_life, layer,"
            " learned_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            ("master", _json.dumps(keywords, ensure_ascii=False), summary,
             emotion, ts or self.now, intrinsic, half_life, layer, self.now))
        return int(cur.lastrowid)

    def test_retrieve_reinforces(self):
        """召回即强化:recall_count+1、H 间隔效应延长、last_recalled 前移。

        插入 24h 前的记忆 → R=0.5 → H 24→45.6(间隔效应)。
        刚想起的再想起零增益(R=1)是正确行为,不在此断言 H 继续增长。

        F5(2026-09-27):这里用**非 L0** 记忆测「召回即强化」—— L0 只要被选进
        强制占位列表就不算被想起(零命中照样注入,强化它没有意义)。
        查询必须真命中:零命中的非 L0 在 rank_memories 就被丢出候选池了
        (:147),不会进 top,也就谈不上强化。
        """
        mid = self._insert("他喜欢被叫阿岚", ["称呼"], layer="reflection",
                           intrinsic=90, ts=self.now - 24 * 3600)
        items, reinforced = retrieve.retrieve(
            self.conn, "master", "你该称呼我什么", 6, now=self.now)
        self.assertEqual(reinforced, 1)
        self.assertFalse(items[0].get("forced"), "非 L0 不该被标成强制占位")
        row = self.conn.execute(
            "SELECT recall_count, half_life, last_recalled"
            " FROM episodic_memory WHERE memory_id = ?", (mid,)).fetchone()
        self.assertEqual(row[0], 1)
        self.assertAlmostEqual(row[1], 45.6, delta=0.1)   # 24*(1+1.8*0.5)
        self.assertAlmostEqual(row[2], self.now, delta=1)
        # 第二次检索:次数再 +1(H 不再增长 —— R 已归 1,零增益)
        retrieve.retrieve(self.conn, "master", "你该称呼我什么", 6, now=self.now)
        row = self.conn.execute(
            "SELECT recall_count, half_life FROM episodic_memory"
            " WHERE memory_id = ?", (mid,)).fetchone()
        self.assertEqual(row[0], 2)
        self.assertAlmostEqual(row[1], 45.6, delta=0.1)

    def test_merit_l0_still_reinforced(self):
        """没被选进强制列表的 L0 靠分数进榜 ⇒ 仍算被想起,照常强化。

        topK=6 ⇒ L0 配额 min(8, 4)=4。造 8 条高 I 的 L0(占满配额)+ 1 条
        低 I 但**切题**的 L0:切题那条不在强制名单里,只能靠分数进,该被强化。
        F5 不能把真正的召回一起豁免掉。
        """
        for i in range(8):
            self._insert("背景事实" + str(i), ["背景"], layer="L0",
                         intrinsic=99 - i, ts=self.now - 3600)
        hit = self._insert("用户校园跑要跑3km。", ["校园跑", "3km"],
                           layer="L0", intrinsic=20, ts=self.now - 3600)
        items, reinforced = retrieve.retrieve(
            self.conn, "master", "今天校园跑跑完了", 6, now=self.now)
        mine = [it for it in items if it["memory_id"] == hit][0]
        self.assertFalse(mine.get("forced"), "切题的 L0 没被强制占位,是靠自己进的")
        self.assertEqual(self.conn.execute(
            "SELECT recall_count FROM episodic_memory WHERE memory_id = ?",
            (hit,)).fetchone()[0], 1, "真召回的 L0 被 F5 误伤了")
        self.assertGreaterEqual(reinforced, 1)

    def test_forced_l0_is_not_reinforced(self):
        """★ F5:纯靠强制占位进来的 L0 **不算被想起** —— 不写回强化。

        现场:#125(风又音理)是全库唯一活着的 L0,每轮被强制占位 ⇒ 每轮被
        强化,recall_count 涨到 2463(第 2 名 784),half_life 440h、R 恒 0.999。
        图侧 pinned 早就豁免了这件事(graph.py:536),情景侧原来刻意不豁免。
        """
        # 零命中(查询与关键词/摘要都不搭)⇒ 只能靠强制占位进池
        mid = self._insert("她喜欢用中文思考。", ["中文"], layer="L0", intrinsic=90,
                           ts=self.now - 24 * 3600)
        items, reinforced = retrieve.retrieve(
            self.conn, "master", "zzz-完全无关-zzz", 6, now=self.now)
        self.assertEqual(len(items), 1, "L0 豁免该让它进池")
        self.assertTrue(items[0].get("forced"), "零命中的 L0 该被标成强制占位")
        self.assertEqual(reinforced, 0, "强制占位不该算被想起")
        row = self.conn.execute(
            "SELECT recall_count, half_life, last_recalled"
            " FROM episodic_memory WHERE memory_id = ?", (mid,)).fetchone()
        self.assertEqual(row[0], 0, "recall_count 被强制占位刷上去了")
        self.assertAlmostEqual(row[1], 24.0, delta=0.1, msg="half_life 被刷长了")
        self.assertEqual(row[2], 0, "last_recalled 被前移了")

    def test_forced_l0_does_not_starve_merit_slots(self):
        """强制占位不许把切题的常规记忆挤出常规席位(它只占自己的配额)。"""
        for i in range(9):
            self._insert("核心事实" + str(i), ["核心"], layer="L0",
                         intrinsic=95 - i, ts=self.now - 3600)
        rel = self._insert("用户校园跑要跑3km。", ["校园跑", "3km"],
                           layer="reflection", intrinsic=80, ts=self.now - 3600)
        items, reinforced = retrieve.retrieve(
            self.conn, "master", "今天校园跑跑完了", 6, now=self.now)
        ids = [it["memory_id"] for it in items]
        self.assertIn(rel, ids, "切题的常规记忆被 L0 挤掉了")
        # 切题那条必须被强化(它是真命中)
        self.assertEqual(self.conn.execute(
            "SELECT recall_count FROM episodic_memory WHERE memory_id = ?",
            (rel,)).fetchone()[0], 1)
        # 强制占位的 L0 一条都不许被强化(它们只是无条件注入的背景)
        forced = [it["memory_id"] for it in items if it.get("forced")]
        self.assertEqual(len(forced), 4, "top_k=6 ⇒ L0 配额 min(8, 6-2)=4")
        for f in forced:
            self.assertEqual(self.conn.execute(
                "SELECT recall_count FROM episodic_memory WHERE memory_id = ?",
                (f,)).fetchone()[0], 0, "强制占位的 L0 被强化了")
        self.assertGreaterEqual(reinforced, 1)

    def test_user_isolation(self):
        self._insert("主人的记忆", ["话题"])
        items, _ = retrieve.retrieve(
            self.conn, "stranger", "话题", 6, now=self.now)
        self.assertEqual(items, [])

    def test_render_episodic(self):
        """渲染:[核心] 前缀 + 年龄标签 + 情感分 + 时间注记。

        2026-09-26 现场(他让我分析模型输入的语言):关键词**不再**渲染进
        这一行 —— 它是检索打分用的(CJK 走二元滑窗),渲染给模型看就是乱码。
        """
        self._insert("他喜欢被叫阿岚", ["称呼"], layer="L0", intrinsic=90)
        items, _ = retrieve.retrieve(
            self.conn, "master", "叫我什么", 6, now=self.now)
        self.assertEqual(len(items), 1)           # L0 豁免零命中进池
        text = retrieve.render_episodic(items)
        self.assertIn("[核心] ", text)
        self.assertIn("[今天|情感5]", text)
        self.assertIn("他喜欢被叫阿岚", text)
        self.assertIn("时间未确认", text)          # temporal_status 默认
        self.assertNotIn("(称呼)", text)           # 关键词不再入场
        self.assertNotIn("称呼", text)             # 裸词也不许漏(它只在 keywords 里)

    def test_render_episodic_bigram_keywords_never_leak(self):
        """#125 那种记忆:keywords 是「的设/设计/计灵/灵感」滑窗,一个碎片都不许漏进注入。

        关键词刻意保留在库里(短查询「面试」只有靠二元组才吃得到那一档
        hit_score),但**不许**出现在她读到的那一行。判据用「半角括号」与
        「逗号连排」——不能用 `的设` 这种子串判:它本身就藏在摘要的
        「Echo **的设**计灵感」里,那样断言会假红(我第一版就这么写错了)。
        """
        self._insert("Echo 的设计灵感来源于风又音理",
                     ["Echo", "的设", "设计", "计灵", "灵感"],
                     layer="L0", intrinsic=80)
        items, _ = retrieve.retrieve(
            self.conn, "master", "设计灵感", 6, now=self.now)
        text = retrieve.render_episodic(items)
        self.assertIn("设计灵感", text)            # summary 照旧
        self.assertNotIn("(", text)                # 半角括号 = 那个关键词位
        self.assertNotIn("的设,设计", text)        # 逗号连排的滑窗串

    def test_hole2_zero_hit_is_labelled(self):
        """★ 漏洞②回归:整轮零命中时,注入块必须标明"这些不是本轮相关材料"。

        现场(2026-09-27 实测):问库里根本没有的东西(「量子纠缠」),旧版注入块
        里只有一条 L0 记忆,却**没有任何标记** —— 她因此"以为自己有"。
        三条负控 3/3 全中。
        """
        self._insert("她喜欢用中文思考。", ["中文"], layer="L0", intrinsic=90)
        items, _ = retrieve.retrieve(
            self.conn, "master", "zzz-量子纠缠-zzz", 6, now=self.now)
        self.assertEqual(len(items), 1, "L0 豁免该让它进池(设计不变)")
        self.assertFalse(items[0]["matched"], "零命中不该被标成命中")
        text = retrieve.render_episodic(items)
        self.assertIn("没有命中任何记忆", text, "零命中没标注 = 漏洞②还在")
        self.assertIn("不要拿它们回答眼前的问题", text)

    def test_hole2_topic_matched_has_no_label(self):
        """有命中时**不加块级标注** —— 标注本身是噪声,只在必要时出现。"""
        self._insert("用户校园跑要跑3km。", ["校园跑"], ts=self.now - 3600)
        items, _ = retrieve.retrieve(
            self.conn, "master", "今天校园跑跑完了", 6, now=self.now)
        self.assertTrue(any(it["matched"] for it in items))
        self.assertNotIn("没有命中任何记忆", retrieve.render_episodic(items))

    def test_hole2b_unmatched_always_on_is_marked_per_item(self):
        """★ 漏洞②-b:有命中时,那几条**没命中的常在场记忆**要逐条标出来。

        只靠块级横幅太脆:测台实测 19 条寒暄负控里 **17 条**仍被判
        `matched=True`(短查询只剩一个词元时覆盖率非 0 即 1,阈值退化),
        那 17 轮的 L0 就会混在"相关材料"里不作声。
        两级标注**不同时出现**:全未命中 → 块级横幅;有命中 → 逐条标。
        """
        self._insert("用户校园跑要跑3km。", ["校园跑"], ts=self.now - 3600)
        self._insert("她喜欢用中文思考。", ["中文"], layer="L0", intrinsic=90)
        items, _ = retrieve.retrieve(
            self.conn, "master", "今天校园跑跑完了", 6, now=self.now)
        self.assertTrue(any(it["matched"] for it in items), "前提:得有一条真命中")
        text = retrieve.render_episodic(items)
        self.assertNotIn("没有命中任何记忆", text, "有命中就不该出块级横幅")
        self.assertIn("(常在场,不是本轮相关)", text, "L0 没命中却没逐条标")

    def test_hole2b_legacy_rows_without_flag_are_not_all_marked(self):
        """不带 `matched` 字段的老调用方:不许把所有行都标上。"""
        text = retrieve.render_episodic(
            [{"summary": "她喜欢用中文思考。", "emotion_score": 3,
              "age_days": 0.2, "layer": "L0"}])
        self.assertNotIn("(常在场,不是本轮相关)", text)

    def test_hole3_near_dup_is_one_seat_for_injection(self):
        """★ 漏洞③回归:同一事实的两种说法不许一起占席位(注入用途)。

        ⚠️ 已知局限:阈值 0.55 只抓得住**措辞几乎相同**的那种。
        「很难买到,几年才能吃一次」vs「很稀有,几乎几年才吃一次」这种
        **换了说法**的 J 只有约 0.3,现在判不出来 —— 阈值要等 RT0 重建后的
        评测集扫出来才敢动(**宁可漏判,不许误吃**)。
        """
        a = self._insert("他提到章鱼小丸子很难买到,几乎几年才能吃一次。",
                         ["章鱼小丸子"])
        self._insert("他提到章鱼小丸子很难买到,几乎几年才能吃上一次。",
                     ["章鱼小丸子"])
        items, _ = retrieve.retrieve(
            self.conn, "master", "章鱼小丸子", 6, now=self.now)
        self.assertIn(a, [it["memory_id"] for it in items])
        self.assertEqual(len(items), 1, "近重复的同一事实占了两个席位 = 漏洞③")

    def test_hole3_enumeration_is_not_collapsed(self):
        """★ 去冗余**不许**碰枚举用途:`memory_forget` 的「>10 拒绝」是数匹配
        条数的,折叠近重复会让 11 条近似记忆变成 1 条、保护直接失效。

        这是实现期真实踩到的回归:去冗余一开始放进 rank_memories 无条件生效,
        `forget["ok"]` 从 False 翻成 True —— 他一句「忘掉猫」就能把 11 条一起抹掉。
        """
        ids = {self._insert("用户说他的第%d只猫很可爱" % i, ["猫"],
                            ts=self.now - 3600) for i in range(11)}
        enum, _ = retrieve.retrieve(
            self.conn, "master", "猫", 20, now=self.now, dedupe=False)
        self.assertEqual(len({it["memory_id"] for it in enum} & ids), 11,
                         "枚举用途被折叠了 = forget 的保护会失效")
        inj, _ = retrieve.retrieve(self.conn, "master", "猫", 20, now=self.now)
        self.assertLess(len(inj), 11, "注入用途没有折叠近重复 = 漏洞③还在")


class WireRoundTrip(unittest.TestCase):
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

    def test_retrieve_frame(self):
        conn = db.connect(self.db)
        import json as _json
        conn.execute(
            "INSERT INTO episodic_memory (user_id, keywords, summary,"
            " emotion_score, timestamp, intrinsic_value, half_life, layer,"
            " learned_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            ("master", _json.dumps(["称呼"], ensure_ascii=False),
             "他喜欢被叫阿岚", 5, self.now, 90, 24, "L0", self.now))
        conn.commit()
        conn.close()
        r = self.w.roundtrip({"reqId": 1, "type": "retrieve", "userId": "master",
                              "query": "叫我什么", "topK": 6, "now": self.now})
        self.assertEqual(r["type"], "retrieve_result")
        self.assertEqual(len(r["items"]), 1)
        # F5(2026-09-27):这条是 L0、零命中 ⇒ 纯强制占位 ⇒ **不算被想起**,
        # 不写回强化。旧断言是 reinforced=1(每轮注入=每轮强化,正是 #125
        # recall_count 涨到 2463 的机制)。注入照旧,只是不计账。
        self.assertEqual(r["reinforced"], 0, "强制占位不该计成召回")
        self.assertTrue(r["items"][0]["forced"])
        self.assertIn("[核心]", r["text"])
        self.assertIn("他喜欢被叫阿岚", r["text"])
        self.assertIsNone(r["state"])              # 后续 b 步填
        # 落库验证:没有强化发生
        conn = db.connect(self.db)
        try:
            row = conn.execute(
                "SELECT recall_count, half_life FROM episodic_memory").fetchone()
            self.assertEqual(row[0], 0, "强制占位被计账了")
            self.assertEqual(row[1], 24, "half_life 被强制占位刷长了")
        finally:
            conn.close()

    def test_missing_params_nonfatal(self):
        r = self.w.roundtrip({"reqId": 1, "type": "retrieve", "userId": "master"})
        self.assertEqual(r["type"], "error")
        r2 = self.w.roundtrip({"reqId": 2, "type": "retrieve", "query": "x"})
        self.assertEqual(r2["type"], "error")


class ChannelRetired(unittest.TestCase):
    """v0.29.0 个人机器人裁剪:渠道维度随群聊拒收一起退役。

    他的裁决:「彻底移除一切和群体相关的东西」。群消息在入站闸就被
    拒收,根本进不了记忆 —— 渠道过滤失去了要防的对象,整组退役。
    与 JS 侧 tests/store.test.js 的 v0.29.0 用例逐点对表(两套实现一条规则)。
    """

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.db = str(Path(self.tmp.name) / "echo.db")
        self.conn = db.connect(self.db)
        self.now = time.time()

    def tearDown(self):
        self.conn.close()
        self.tmp.cleanup()

    def test_new_db_has_no_channel_columns(self):
        """新库不再建 channel / channel_chat 列(老库里已建的留着不引用)。"""
        cols = {r[1] for r in self.conn.execute("PRAGMA table_info(episodic_memory)")}
        self.assertNotIn("channel", cols, "新库不该有 channel 列")
        self.assertNotIn("channel_chat", cols, "新库不该有 channel_chat 列")

    def test_retrieve_without_channel_filters(self):
        """检索不再按渠道过滤:所有记忆对所有轮次可见(只服务他一个人)。"""
        from engine import episodic
        import json as _json
        episodic.insert_memory(
            self.conn, "master", _json.dumps(["加班"], ensure_ascii=False),
            "他今晚要加班到十点", 6, now=self.now)
        items, _ = retrieve.retrieve(
            self.conn, "master", "今晚要加班吗", 6, now=self.now)
        self.assertEqual(len(items), 1)

    def test_frame_no_longer_carries_channel(self):
        """壳递帧 → 引擎检索:帧上没有渠道字段,整条线照走通。"""
        from engine import episodic
        import json as _json
        episodic.insert_memory(
            self.conn, "master", _json.dumps(["加班"], ensure_ascii=False),
            "他在群里说今晚要加班", 6, now=self.now)
        w = WorkerHarness()
        try:
            ready = w.roundtrip(hello_frame(db_path=self.db))
            self.assertEqual(ready["type"], "ready")
            r = w.roundtrip({"reqId": 1, "type": "retrieve", "userId": "master",
                             "query": "今晚要加班吗", "topK": 6, "now": self.now})
            self.assertEqual(len(r["items"]), 1)
        finally:
            w.close()


if __name__ == "__main__":
    unittest.main()
