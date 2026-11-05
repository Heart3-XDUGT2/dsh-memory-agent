# -*- coding: utf-8 -*-
"""Judge 合并版 EXTRACT 测试(M2-b4 + M2-h)。

三层防线逐门验证 + 写入链编排端到端 + 第四层置信度准入闸
(<0.55 拒 / 0.55~0.75 隔离 / ≥0.75 落库 + 晋升/降观察)。
血泪教训门(归因硬门/L0 双门控/日历校验/绝对化术语)各有专测 ——
这些门每一条都对应一次真实事故。
"""
import json
import sys
import tempfile
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from engine import db, episodic, judge, reflection  # noqa: E402
from engine import retrieve  # noqa: E402
from engine.timeutil import parse_abs_time, resolve_follow_up_time  # noqa: E402
from test_worker import WorkerHarness, hello_frame  # noqa: E402

NOW = 1790121600.0  # 2026-09-23 00:00 UTC+8 附近,固定时钟


def candidate(**kw):
    base = {
        "layer": "L2", "summary": "用户说他喜欢猫", "confidence": 0.9,
        "certainty": "explicit", "attribution": "user_explicit",
        "stability": "stable", "shouldWrite": True,
        "evidenceQuotes": ["我喜欢猫"], "temporal_status": "enduring",
    }
    base.update(kw)
    return base


def triple(**kw):
    base = {
        "s": "用户", "relation": "喜欢", "t": "猫", "layer": "L2",
        "certainty": "explicit", "attribution": "user_explicit",
        "stability": "stable", "shouldWrite": True,
        "evidenceQuotes": ["我喜欢猫"], "temporal_status": "enduring",
    }
    base.update(kw)
    return base


class TimeUtil(unittest.TestCase):
    def test_parse_abs_time(self):
        self.assertGreater(parse_abs_time("2026-09-10"), 0)
        self.assertGreater(parse_abs_time("2026-09-10T20:00"), 0)
        self.assertEqual(parse_abs_time("明天"), 0.0)
        self.assertEqual(parse_abs_time(""), 0.0)
        self.assertEqual(parse_abs_time(None), 0.0)

    def test_resolve_follow_up_time(self):
        self.assertEqual(resolve_follow_up_time("两分钟后", NOW), NOW + 120)
        self.assertEqual(resolve_follow_up_time("半小时后", NOW), NOW + 1800)
        self.assertEqual(resolve_follow_up_time("3天以后", NOW), NOW + 3 * 86400)
        # 绝对时间优先
        self.assertEqual(resolve_follow_up_time("2026-09-19T20:00", NOW),
                         parse_abs_time("2026-09-19T20:00"))
        # 钟点:明晚8点 = 明天 20:00
        ts = resolve_follow_up_time("明晚8点", NOW)
        lt = time.localtime(ts)
        self.assertEqual((lt.tm_hour, lt.tm_min), (20, 0))
        # 时段词:晚上8点(v8.7.2 修复,不再静默差 12 小时)
        ts2 = resolve_follow_up_time("晚上8点", NOW)
        lt2 = time.localtime(ts2)
        self.assertEqual(lt2.tm_hour, 20)
        # 周几:换算到下一个该星期几
        ts3 = resolve_follow_up_time("周三", NOW)
        self.assertGreater(ts3, NOW)
        # 解析不出 → 0(不定时)
        self.assertEqual(resolve_follow_up_time("看情况", NOW), 0.0)


class ValidationGates(unittest.TestCase):
    """第二、三层防线 —— 每道门对应一次真实事故。"""

    def test_norm_abs_time_calendar(self):
        """v8.7.2 日历校验:编造的假日期必须被拒。"""
        self.assertEqual(judge.norm_abs_time("2025-02-31"), "")
        self.assertEqual(judge.norm_abs_time("2026-13-01"), "")
        self.assertEqual(judge.norm_abs_time("2026-09-10"), "2026-09-10")
        self.assertEqual(judge.norm_abs_time("2026-09-10T20:00"), "2026-09-10T20:00")
        self.assertEqual(judge.norm_abs_time("上周"), "")
        self.assertEqual(judge.norm_abs_time(""), "")

    def test_validate_candidate(self):
        c = judge.validate_candidate(candidate(layer="L0", field="preferredName"))
        self.assertIsNotNone(c)
        self.assertEqual(c["field"], "preferredName")
        self.assertIsNone(judge.validate_candidate({"layer": "L9"}))       # 非法层级
        self.assertIsNone(judge.validate_candidate({"layer": "L2"}))       # 空内容
        # 非法枚举清空;slot 只留安全字符
        c2 = judge.validate_candidate(candidate(
            certainty="很确定", slot="preferred reply style!"))
        self.assertEqual(c2["certainty"], "")
        self.assertEqual(c2["slot"], "preferred_reply_style")
        # L1 field 白名单:合法值放行,发明字段拒收
        c3 = judge.validate_candidate(candidate(layer="L1", field="recentGoals"))
        self.assertEqual(c3["field"], "recentGoals")
        c4 = judge.validate_candidate(candidate(layer="L1", field="发明字段"))
        self.assertIsNone(c4["field"])

    def test_post_filter_candidates(self):
        """四道门:shouldWrite / L0 双门控 / forbiddenOverclaims / 绝对化术语。"""
        ok = judge.validate_candidate(candidate())
        no_write = judge.validate_candidate(candidate(shouldWrite=False))
        l0_inferred = judge.validate_candidate(
            candidate(layer="L0", certainty="inferred"))
        overclaim = judge.validate_candidate(
            candidate(forbiddenOverclaims=["永远"]))
        absolute = judge.validate_candidate(
            candidate(summary="用户永远喜欢猫", evidenceQuotes=["我喜欢猫"]))
        absolute_ok = judge.validate_candidate(
            candidate(summary="用户永远喜欢猫", evidenceQuotes=["我永远喜欢猫"]))
        out = judge.post_filter_candidates(
            [ok, no_write, l0_inferred, overclaim, absolute, absolute_ok])
        self.assertEqual(len(out), 2)
        self.assertIn(ok, out)
        self.assertIn(absolute_ok, out)

    def test_triple_attribution_hard_gate(self):
        """归因硬门:幻觉「用户-是->被我哥骂过的家伙」那类事故的防线。"""
        ok = judge.validate_triple(triple())
        inferred = judge.validate_triple(triple(attribution="assistant_inferred"))
        uncertain = judge.validate_triple(triple(certainty="uncertain"))
        missing = judge.validate_triple(triple(certainty="", attribution=""))
        mixed = judge.validate_triple(triple(attribution="mixed"))
        kept, dropped = judge.post_filter_triples([ok, inferred, uncertain, missing, mixed])
        self.assertEqual(len(kept), 2)
        self.assertEqual({d["reason"] for d in dropped}, {
            "不可归因于用户(assistant_inferred)", "certainty=uncertain",
            "缺少certainty/attribution"})
        # s==t 直接 Schema 拒
        self.assertIsNone(judge.validate_triple(triple(t="用户")))

    def test_enum_accepts_any_case(self):
        """2026-10-17：`_enum` 加 lowercase —— 拆掉一个把「给了值」误报成「没给」的隐雷。

        依据：枚举常量全小写（`VALID_CERTAINTIES` / `VALID_ATTRIBUTIONS` /
        `VALID_STABILITIES`），而 `_enum` 原来只 `.strip()`。模型给 `"Explicit"`
        或 `"USER_EXPLICIT"` 时值不在列表里 ⇒ 被清成空串 ⇒ 下游 `post_filter_triples`
        报「缺少certainty/attribution」—— **明明是给了值，却被说成没给**。

        lowercase 是**唯一安全的宽容**：它不会让任何非法值变合法，
        只会让"大小写写错的好值"被正确接住。
        """
        for raw in ("explicit", "Explicit", "EXPLICIT", "  ExPliCit  "):
            got = judge.validate_triple(triple(certainty=raw))
            self.assertEqual(got["certainty"], "explicit", f"certainty={raw!r} 该被接受")
        for raw in ("user_explicit", "User_Explicit", "USER_EXPLICIT"):
            got = judge.validate_triple(triple(attribution=raw))
            self.assertEqual(got["attribution"], "user_explicit", f"attribution={raw!r} 该被接受")
        for raw in ("stable", "STABLE", "Stable"):
            got = judge.validate_triple(triple(stability=raw))
            self.assertEqual(got["stability"], "stable", f"stability={raw!r} 该被接受")
        # 反面：非法值照样被清空（lowercase 不许把垃圾变合法）
        self.assertEqual(judge.validate_triple(triple(certainty="maybe"))["certainty"], "")
        self.assertEqual(judge.validate_triple(triple(attribution="nobody"))["attribution"], "")
        # ⚠️ VALID_LAYERS 是**大写**的 ['L0','L1','L2']，但它**不走 _enum**
        #   （在 validate_triple 里单独判 `layer not in VALID_LAYERS`）。
        #   这条钉住"加 lowercase 没有顺手把 layer 弄坏"。
        self.assertEqual(judge.validate_triple(triple(layer="L2"))["layer"], "L2")
        self.assertEqual(judge.validate_triple(triple(layer="l2"))["layer"], "L2",
                         "layer 不认识小写 ⇒ 落回 L2 默认（不是被 lowercase 改写）")

    def test_post_filter_reports_missing_and_rejected_differently(self):
        """2026-10-17：拆诊断盲区 —— 「没给」和「给了但不认」必须报**两个**reason。

        现场：真机 87 条 `extract` 的 `dropReasons` 全是 `缺少certainty/attribution`，
        而手工用同一段 prompt 打本地模型时字段**全给对了** ——
        于是"到底是模型没给，还是给了值但被 `_enum` 清掉了"从库里**分不出来**，只能猜。

        ⇒ `validate_triple` 现在把被拒的原值挂在 `__enumRejected`；
          `post_filter_triples` 据此报两种 reason。这一组钉住两种情况都分得开。
        """
        # ① 真没给 ⇒ 还是老 reason（不许因为改动而变样）
        missing = judge.validate_triple(triple(certainty="", attribution=""))
        kept1, dropped1 = judge.post_filter_triples([missing])
        self.assertEqual(len(dropped1), 1)
        self.assertEqual(dropped1[0]["reason"], "缺少certainty/attribution")

        # ② 给了但不认 ⇒ **另一个** reason，而且带上原值
        bogus = judge.validate_triple(triple(certainty="probably", attribution="user_explicit"))
        kept2, dropped2 = judge.post_filter_triples([bogus])
        self.assertEqual(len(dropped2), 1)
        self.assertNotEqual(dropped2[0]["reason"], "缺少certainty/attribution",
                            "给了非法值不该和「没给」报同一句")
        self.assertIn("值不被接受", dropped2[0]["reason"])
        self.assertIn("probably", dropped2[0]["reason"], "原值要带出来，否则还是查不出模型给了什么")

        # ③ 大小写不一致（2026-10-17 已放宽）⇒ 该被接受，**不**落进 dropped
        cased = judge.validate_triple(triple(certainty="Explicit", attribution="USER_EXPLICIT"))
        kept3, dropped3 = judge.post_filter_triples([cased])
        self.assertEqual(len(kept3), 1)
        self.assertEqual(dropped3, [])

        # ④ 内部字段**不许**出现在通过的那条上（它会一路流到 graph_items）
        #     —— 这里只断言"通过的那份里没有它"；真要进库得靠 add_edge 显式挑字段，
        #     那条由 graph 侧的表结构保证（graph_edges 是列式表，没有这一列）。
        self.assertNotIn("__enumRejected", kept3[0],
                         "通过的三元组不该带着内部诊断字段往前走")

    def test_validate_pending_threads(self):
        """纯指代(「那件事」)直接丢 —— 猜错话题比不跟进更伤。"""
        items = [
            {"content": "那件事", "follow_up_after": "明天"},
            {"content": "用户约好明天面试完告诉他结果", "follow_up_after": "2026-09-24T10:00"},
            {"content": "提醒我两分钟后洗衣服", "follow_up_after": "两分钟后"},
        ]
        kept = judge.validate_pending_threads(items)
        self.assertEqual(len(kept), 2)
        self.assertEqual(kept[0]["follow_up_after"], "2026-09-24T10:00")
        self.assertEqual(kept[1]["follow_up_after"], "两分钟后")  # 相对表达透传

    def test_pending_thread_placeholders_are_dropped(self):
        """★ 2026-10-17：样板值黑名单 —— 不依赖模型自觉。

        现场：活库 `pending_threads` #44 的 content 落成了**「要跟进的事」**，
        那正是 `build_extract_prompt` 里样板 JSON 的字面值 ——
        本地 3B 把它当答案抄了回来。

        为什么必须在代码里挡：prompt 是"劝"，模型未必听。
        这与 `is_self_referential`、`_has_unsupported_absolute` 同一套设计
        （prompt 劝，代码是墙）。

        ⚠️ 判据是「**整条就是样板**」，不是"包含样板字" ——
        「要跟进的事：他明天答辩」这种**真写了内容**的必须留下。
        """
        # ① 整条就是样板的 ⇒ 丢弃
        for placeholder in ("要跟进的事", "要跟进的事。", "跟进的事", "悬置话题",
                            "要跟进的事（他明天答辩）"):
            kept = judge.validate_pending_threads([{"content": placeholder, "kind": "topic"}])
            self.assertEqual(kept, [], "样板值该被丢弃: " + placeholder)
        # ② 样板后面真接了内容的 ⇒ 保留（这是第一版用 `.match` 时误丢的）
        for real in ("要跟进的事：他明天答辩", "要跟进的事——他明天答辩",
                     "要跟进的事, 看看他答辩"):
            kept = judge.validate_pending_threads([{"content": real, "kind": "topic"}])
            self.assertEqual(len(kept), 1, "真写了内容的该保留: " + real)
        # ③ 正常内容完全不受影响
        for normal in ("询问面试通知时间", "用户已通过面试，记得告知 Echo",
                       "专业分流那事儿——定下来了吗？"):
            kept = judge.validate_pending_threads([{"content": normal, "kind": "topic"}])
            self.assertEqual(len(kept), 1, "正常内容不该被动: " + normal)


class InsertMemory(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.conn = db.connect(str(Path(self.tmp.name) / "echo.db"))

    def tearDown(self):
        self.conn.close()
        self.tmp.cleanup()

    def _row(self, mid):
        return self.conn.execute(
            "SELECT layer, memory_key, intrinsic_value, half_life, is_active,"
            " superseded_by, recall_count FROM episodic_memory WHERE memory_id = ?",
            (mid,)).fetchone()

    def test_new_and_supersede(self):
        mid1 = episodic.insert_memory(
            self.conn, "master", '["k"]', "他住在西安", 5,
            intrinsic_value=50, memory_key="identity_location", layer="L0", now=NOW)
        self.assertEqual(self._row(mid1)[0], "L0")
        self.assertEqual(self._row(mid1)[1], "identity_location")
        # 同 slot 不同内容 → 取代
        mid2 = episodic.insert_memory(
            self.conn, "master", '["k"]', "他搬到北京了", 5,
            intrinsic_value=50, memory_key="identity_location", layer="L0", now=NOW)
        self.assertNotEqual(mid1, mid2)
        self.assertEqual(self._row(mid1)[4], 0)            # 旧版本让位
        self.assertEqual(self._row(mid1)[5], mid2)
        self.assertEqual(self._row(mid2)[4], 1)
        # 同一句话再说一遍 → 一次想起,不塞重复行
        mid3 = episodic.insert_memory(
            self.conn, "master", '["k"]', "他搬到北京了", 5,
            intrinsic_value=50, memory_key="identity_location", layer="L0", now=NOW)
        self.assertEqual(mid3, mid2)
        self.assertEqual(self._row(mid2)[6], 1)            # recall_count +1

    def test_degraded_i(self):
        """降级路径:没有 Judge 字段时按 emotion_score 粗估 I(5 → 50)。"""
        mid = episodic.insert_memory(
            self.conn, "master", '["k"]', "日常", 5, now=NOW)
        row = self._row(mid)
        self.assertAlmostEqual(row[2], 50.0, places=3)


class CommitOrchestration(unittest.TestCase):
    """写入链端到端:三层校验 → 落库 → 降级 → 消解先于登记。"""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.db = str(Path(self.tmp.name) / "echo.db")
        self.conn = db.connect(self.db)

    def tearDown(self):
        self.conn.close()
        self.tmp.cleanup()

    def test_full_payload(self):
        structured = {
            "keywords": ["面试", "网站建设"], "summary": "他聊了面试的事",
            "emotion_score": 6, "emotion_state": "anxious",
            "mood_intensity": 4, "mood_reason": "担心他",
            "emotion_vector": {"global": {"valence": -1}, "target_master": {"affection": 8}},
            "candidates": [
                candidate(layer="L0", field="preferredName",
                          summary="他希望被叫阿岚", slot="identity_name"),
                candidate(layer="L2", summary="他参加网站部门面试未通过",
                          temporal_status="historical", occurred_at="2026-09-10"),
                candidate(shouldWrite=False, summary="不该写的"),
            ],
            "triples": [
                triple(s="用户", relation="称呼", t="阿岚", layer="L0"),
                triple(attribution="assistant_inferred"),
            ],
            "pendingThreads": [
                {"content": "他约好明天面试完告诉我结果",
                 "follow_up_after": "2026-09-24T10:00"},
            ],
        }
        ack = judge.commit(self.conn, "master", structured, "今天聊了面试",
                           session_id="s1", now=NOW)
        # 写入与拦截
        self.assertEqual(len(ack["written"]), 2)
        self.assertEqual(ack["rejected"][0]["reason"], "shouldWrite=false")
        self.assertEqual(ack["learned"], 1)
        self.assertEqual(len(ack["triplesRejected"]), 1)
        self.assertEqual(ack["triplesRejected"][0]["reason"],
                         "不可归因于用户(assistant_inferred)")
        # name 从 preferredName 候选提取
        self.assertEqual(ack["name"], "他希望被叫阿岚")
        # 情绪载荷规整(camelCase,壳侧兼容)
        self.assertEqual(ack["extract"]["emotionScore"], 6)
        self.assertEqual(ack["extract"]["emotionState"], "anxious")
        # 落库验证:情景 2 条(L0 带 slot;L2 带绝对时间)
        rows = self.conn.execute(
            "SELECT layer, memory_key, occurred_at, temporal_status"
            " FROM episodic_memory ORDER BY memory_id").fetchall()
        self.assertEqual(len(rows), 2)
        self.assertEqual(rows[0][0], "L0")
        self.assertEqual(rows[0][1], "identity_name")
        self.assertEqual(rows[1][0], "L2")
        self.assertGreater(rows[1][2], 0)                 # occurred_at = 绝对时间
        self.assertEqual(rows[1][3], "historical")
        # 图:1 条边(L0 称呼)
        self.assertEqual(self.conn.execute(
            "SELECT COUNT(*) FROM graph_edges").fetchone()[0], 1)
        # 悬置:1 条,绝对时间已解析
        th = self.conn.execute(
            "SELECT content, follow_up_after, session_id FROM pending_threads"
        ).fetchone()
        self.assertIn("面试完告诉我结果", th[0])
        self.assertEqual(th[1], parse_abs_time("2026-09-24T10:00"))
        self.assertEqual(th[2], "s1")
        # 统计口径
        self.assertEqual(ack["stats"]["written"], 2)
        self.assertEqual(ack["stats"]["threadsRegistered"], 1)

    def test_profile_update_only_language(self):
        """v0.18.3 M3:画像常驻区只收 语言/代词(A `echo_prompts.py:41`)。
        occupation / longTermInterests / permanentNote 是**记忆**的事 ——
        它们已作为 L0 情景记忆落库("需要时会被检索出来"),不进常驻画像;
        落进来就是每个 prompt 都在花钱背一份会过期的身份。
        """
        structured = {
            "keywords": ["中文"], "summary": "他说他平时说中文",
            "emotion_score": 3, "emotion_state": "neutral",
            "mood_intensity": 1, "mood_reason": "", "emotion_vector": {},
            "triples": [], "pendingThreads": [],
            "candidates": [
                candidate(layer="L0", field="language", summary="中文"),
                candidate(layer="L0", field="occupation", summary="做后端的"),
                candidate(layer="L0", field="longTermInterests", summary="爱打游戏"),
            ],
        }
        ack = judge.commit(self.conn, "master", structured, "我平时说中文",
                           session_id="s1", now=NOW)
        self.assertEqual(ack["profileUpdate"], {"语言": "中文"})
        self.assertEqual(len(ack["written"]), 3)  # 三条都照常进记忆层

    def test_extract_prompt_scopes_extraction_to_last_turn(self):
        """v0.14.3 抽取对象只限最后一轮,前几轮只作语境。

        F3 把信封开成 5 轮之后,模型会把历史轮里的事实**重新抽一遍**
        (实测同一件事连着记三条)。窗口本身不能关:指代、情绪来由、
        时间锚都要靠它 —— 要钉的是抽取对象。

        ★ 2026-10-17 改判据(从"prompt 必须有这句话"改成"行为兜底必须对"):

        背景:extract 提示词为了适配本地 3B 从 7655 字符压到 3146 字符
        (实测 7655 → 0/5 全空、3146 → 5/5 全通,阈值断崖在 2883~3425 之间)。
        压缩时**放弃**了在 prompt 里重复这些规则 —— 因为**写入链本来就有近重复闸**:
        `judge.commit(..., dedupe={kwThreshold, summaryThreshold})` 透传给
        `episodic.insert_memory`,活配置是 0.6 / 0.7(**不是 0,闸是开的**)。
        所以这条规则的**执行层在代码里**,prompt 那两句只是"劝"。

        这里改钉两件**真会生效**的事:
          ① prompt 仍保留 scope 段与语境能力(字段名还在,没被压没);
          ② 记忆写入真的接上了近重复闸(参数在、阈值非 0)。
        """
        prompt = judge.build_extract_prompt()
        # prompt 侧:语境能力没被压掉(L0/L1 的 field 名还在)
        self.assertIn("recentGoals", prompt)
        # 写入链侧:commit 签名收 dedupe,并把阈值透传下去(参数在 = 闸可开)
        import inspect
        sig = inspect.signature(judge.commit)
        self.assertIn("dedupe", sig.parameters,
                      "commit 必须收 dedupe —— 否则近重复闸无处可传")

    def test_memory_key_falls_back_to_field(self):
        """v0.14.3 L1「近况」按 field 换代,而不是每轮叠一条。

        现场(09-24 23:44~23:45):同一件事被记成三条 —— #133
        (slot=echo_persona_goal)、#135/#136(slot=current_project),
        因为模型给 slot 的命名逐轮漂移,而 L0/L1 的 field 是被提示词
        强制填的固定英文名。空键 = 没有去重可言:那一晚 118 条活跃
        记忆里 109 条键为空。
        """
        first = candidate(layer="L1", field="currentProject", slot="",
                          summary="用户希望把 Echo 打造成心目中的样子")
        ack = judge.commit(self.conn, "master",
                           {"keywords": [], "summary": "", "emotion_score": 5,
                            "emotion_state": "neutral", "candidates": [first],
                            "triples": [], "pendingThreads": []},
                           "我想把你打造成我心目中的样子", now=NOW)
        self.assertEqual(len(ack["written"]), 1)
        # 下一轮换个说法说同一件事(slot 仍空、field 同一个)
        second = candidate(layer="L1", field="currentProject", slot="",
                           summary="用户正在把 Echo 打造成心目中的样子")
        judge.commit(self.conn, "master",
                     {"keywords": [], "summary": "", "emotion_score": 5,
                      "emotion_state": "neutral", "candidates": [second],
                      "triples": [], "pendingThreads": []},
                     "重写你之前我都会先说一声", now=NOW + 60)
        rows = self.conn.execute(
            "SELECT memory_key, status, is_active, superseded_by"
            " FROM episodic_memory ORDER BY memory_id").fetchall()
        self.assertEqual([r[0] for r in rows], ["currentProject", "currentProject"],
                         "两条都该拿 field 当键")
        self.assertEqual([r[2] for r in rows], [0, 1], "旧的必须退役")
        self.assertEqual(rows[0][3], 2, "退役要留取代链(审计可查)")
        # 同一句话说第二遍 → 记成一次「想起」,不新增行
        judge.commit(self.conn, "master",
                     {"keywords": [], "summary": "", "emotion_score": 5,
                      "emotion_state": "neutral",
                      "candidates": [candidate(layer="L1", field="currentProject",
                                               slot="",
                                               summary="用户正在把 Echo 打造成心目中的样子")],
                      "triples": [], "pendingThreads": []},
                     "对,就是这样", now=NOW + 120)
        self.assertEqual(self.conn.execute(
            "SELECT COUNT(*) FROM episodic_memory").fetchone()[0], 2,
            "同句重述 = 一次想起,不是第三条记忆")

    def test_degraded_path(self):
        """无候选:emotion_score ≥ 4 门卫放行;< 4 有损丢弃。"""
        base = {"keywords": ["闲聊"], "summary": "日常闲聊", "emotion_state": "neutral"}
        ack = judge.commit(self.conn, "master",
                           {**base, "emotion_score": 5}, "", now=NOW)
        self.assertEqual(len(ack["written"]), 1)
        self.assertEqual(ack["written"][0]["layer"], "L2(降级)")
        self.assertTrue(ack["stats"]["degraded"])
        ack2 = judge.commit(self.conn, "master",
                            {**base, "emotion_score": 2}, "", now=NOW)
        self.assertEqual(ack2["written"], [])
        self.assertEqual(self.conn.execute(
            "SELECT COUNT(*) FROM episodic_memory").fetchone()[0], 1)

    def test_degraded_path_layer_not_empty(self):
        """2026-10-10 修:降级行落库必须是 L2,不能是空串。

        旧写法没给 `insert_memory` 传 layer ⇒ 吃默认 `layer=""` ⇒ 空 layer 落库。
        空 layer 在检索侧既不是 L0、也不被任何闸挡住(`lib/retrieve.js:103` 只豁免
        L0),于是按普通候选参与排序 —— 活库那 47 行就是这么来的:
        source='private' / temporal_status='time_unknown' / memory_key='' 四项全对上。

        ⚠️ 回执里的 "L2(降级)" 是**只给面板看的来源标记**,与 DB 那一列不是一回事。
        旧测试(上面那条)只钉了回执字符串、**从没查过 DB 这一列**,洞才活到今天 ——
        所以这条测试断言的是**列**,不是回执。
        """
        ack = judge.commit(self.conn, "master", {
            "keywords": ["闲聊"], "summary": "日常闲聊",
            "emotion_score": 5, "emotion_state": "neutral",
        }, "", now=NOW)
        self.assertTrue(ack["stats"]["degraded"])
        self.assertEqual(ack["written"][0]["layer"], "L2(降级)")   # 回执口径不变
        row = self.conn.execute(
            "SELECT layer, temporal_status, memory_key, source"
            " FROM episodic_memory").fetchone()
        self.assertEqual(row[0], "L2", "降级行落库必须是 L2,不能是空串")
        # 另三项正是这条路径的指纹(与活库那 47 行一致)
        self.assertEqual(row[1], "time_unknown")
        self.assertEqual(row[2], "")
        self.assertEqual(row[3], "private")
        # 全库不留空 layer
        self.assertEqual(self.conn.execute(
            "SELECT COUNT(*) FROM episodic_memory WHERE COALESCE(layer, '') = ''"
        ).fetchone()[0], 0)

    def test_threads_resolve_before_register(self):
        """顺序纪律:先消解(用户说完了)再登记新约定 —— 反了会被自己关掉。

        消解是整句双向子串:文本必须包含话题内容(或被包含)。
        """
        from engine import threads as th
        th.remember_pending_thread(self.conn, "master", "面试完告诉他结果",
                                   NOW + 86400, session_id="s1")
        structured = {
            "keywords": [], "summary": "", "emotion_score": 3,
            "emotion_state": "neutral", "mood_intensity": 3,
            "candidates": [],
            "triples": [],
            "pendingThreads": [
                {"content": "面试完告诉他结果",
                 "follow_up_after": "2026-09-24T10:00"},
            ],
        }
        ack = judge.commit(self.conn, "master", structured,
                           "面试完告诉他结果了,还不错",
                           session_id="s1", now=NOW)
        # 旧话题被这句话消解;新登记的同名话题保持 open
        self.assertEqual(ack["threadsResolved"], 1)
        self.assertEqual(ack["threadsRegistered"], 1)
        rows = self.conn.execute(
            "SELECT status FROM pending_threads ORDER BY thread_id").fetchall()
        self.assertEqual([r[0] for r in rows], ["resolved", "open"])

    def test_occurred_at_relative_rejected(self):
        """「上周」换不出绝对日期 → occurred_at=0,但 temporal_status 保留。"""
        structured = {
            "keywords": [], "summary": "", "emotion_score": 3,
            "emotion_state": "neutral", "mood_intensity": 3,
            "candidates": [candidate(summary="他上周发烧了",
                                     temporal_status="historical",
                                     occurred_at="上周")],
            "triples": [], "pendingThreads": [],
        }
        ack = judge.commit(self.conn, "master", structured, "", now=NOW)
        self.assertEqual(len(ack["written"]), 1)
        row = self.conn.execute(
            "SELECT occurred_at, temporal_status FROM episodic_memory").fetchone()
        self.assertEqual(row[0], 0.0)                     # 绝不拿写入时间冒充
        self.assertEqual(row[1], "historical")            # 状态保留(不丢信息)


class AskKeys(unittest.TestCase):
    """写入侧"说法键"(2026-09-30,fact-augmented keys)。

    它是给**检索**用的:他以后换种说法问起这件事时,靠这些字面还能把这条想起来。
    所以三件事必须成立:① 清洗严格(短、去重、不抄原文、≤4 条);
    ② 落库后**进打分正文**;③ 没有它时**逐位等于老行为**(负控)。
    """

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.db = str(Path(self.tmp.name) / "echo.db")
        self.conn = db.connect(self.db)

    def tearDown(self):
        self.conn.close()
        self.tmp.cleanup()

    def test_clean_rules(self):
        c = judge.validate_candidate(candidate(
            summary="用户把 Echo 打造成心目中的样子",
            askKeys=["亲手做", "亲手做", "自己动手", "用户把 Echo 打造成心目中的样子",
                     "想让它变成理想中的样子", "第五个要多出来的", "这个超过十二个字的说法应该被丢掉"]))
        self.assertEqual(c["askKeys"], ["亲手做", "自己动手", "想让它变成理想中的样子", "第五个要多出来的"])

    def test_missing_or_broken_is_empty(self):
        """没有/类型不对 ⇒ 空数组(空 = 检索侧一个字面都不加)。"""
        self.assertEqual(judge.validate_candidate(candidate())["askKeys"], [])
        self.assertEqual(judge.validate_candidate(candidate(askKeys="不是数组"))["askKeys"], [])
        self.assertEqual(judge.validate_candidate(candidate(askKeys=[1, "", None]))["askKeys"], [])

    def test_lands_in_db_and_scoring_text(self):
        ack = judge.commit(self.conn, "master", {
            "candidates": [candidate(summary="用户把 Echo 打造成心目中的样子",
                                     askKeys=["亲手做", "自己动手"])],
            "triples": [], "pendingThreads": [],
        }, "我要自己动手做", now=NOW)
        self.assertEqual(len(ack["written"]), 1)
        row = self.conn.execute("SELECT summary, aug_keys FROM episodic_memory").fetchone()
        self.assertEqual(json.loads(row[1]), ["亲手做", "自己动手"])
        text = retrieve.lexical.doc_text({"summary": row[0], "keywords": [], "aug_keys": row[1]})
        self.assertIn("亲手做", text)

    def test_only_the_key_makes_it_findable(self):
        """机制本身:问法里的字面在记忆里一个字都不出现,只有说法键撞得上。"""
        judge.commit(self.conn, "master", {
            "candidates": [candidate(summary="用户把 Echo 打造成心目中的样子",
                                     askKeys=["亲手做", "自己动手"])],
            "triples": [], "pendingThreads": [],
        }, "", now=NOW)
        rows = [dict(zip(("memory_id", "summary", "keywords", "aug_keys"), r))
                for r in self.conn.execute(
                    "SELECT memory_id, summary, keywords, aug_keys FROM episodic_memory")]
        q = "他为什么非要自己做这个东西"
        # 负控①(默认关 ⇒ 与老行为逐位一致):不显式打开 ⇒ 这条找不到
        self.assertEqual([it["memory_id"] for it in
                          retrieve.rank_memories([dict(r) for r in rows], q, 5, NOW)], [])
        # 负控②:打开但把键摘掉(逐字复刻老库:NULL)⇒ 同样找不到
        on = retrieve.rank_memories([dict(r, aug_keys=None) for r in rows], q, 5, NOW, aug_keys=True)
        self.assertEqual([it["memory_id"] for it in on], [])
        off = retrieve.rank_memories([dict(r) for r in rows], q, 5, NOW, aug_keys=True)
        self.assertTrue([it["memory_id"] for it in off], "打开+带着说法键就该能被想到")

    def test_no_ask_keys_is_old_behavior(self):
        """负控:整条链不产说法键 ⇒ 库里是 NULL、打分正文与老版一致。"""
        judge.commit(self.conn, "master", {
            "candidates": [candidate(summary="用户说他喜欢猫")],
            "triples": [], "pendingThreads": [],
        }, "", now=NOW)
        row = self.conn.execute("SELECT summary, keywords, aug_keys FROM episodic_memory").fetchone()
        self.assertIsNone(row[2])
        self.assertEqual(
            retrieve.lexical.doc_text({"summary": row[0], "keywords": json.loads(row[1])}),
            retrieve.lexical.doc_text({"summary": row[0], "keywords": json.loads(row[1]),
                                       "aug_keys": row[2]}))


class ConfidenceGate(unittest.TestCase):
    """M2-h 第四层准入闸:三段分流 + 隔离不可见 + 晋升/降观察。"""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.db = str(Path(self.tmp.name) / "echo.db")
        self.conn = db.connect(self.db)

    def tearDown(self):
        self.conn.close()
        self.tmp.cleanup()

    def _structured(self, candidates, **kw):
        # emotion_score 默认 3(降级门卫之下):闸门测试只看候选分流,
        # 不让降级行混进计数 —— 降级交互有专测 test_all_quarantined。
        payload = {
            "keywords": ["测试"], "summary": "他聊了测试的事",
            "emotion_score": 3, "emotion_state": "neutral",
            "mood_intensity": 3, "mood_reason": "",
            "emotion_vector": {"global": {}, "target_master": {}},
            "candidates": candidates,
        }
        payload.update(kw)
        return payload

    def test_three_bands(self):
        ack = judge.commit(self.conn, "master", self._structured([
            candidate(summary="低置信的传闻", confidence=0.4, slot="rumor"),
            candidate(summary="半信半疑的事", confidence=0.6, slot="maybe"),
            candidate(summary="确凿的事实", confidence=0.9, slot="fact"),
        ]), "测试", now=NOW)
        self.assertEqual(len(ack["written"]), 1)
        self.assertEqual(ack["written"][0]["summary"], "确凿的事实")
        self.assertEqual(len(ack["quarantined"]), 1)
        self.assertEqual(ack["quarantined"][0]["summary"], "半信半疑的事")
        self.assertEqual(ack["quarantined"][0]["confidence"], 0.6)
        self.assertEqual(len(ack["rejected"]), 1)
        self.assertIn("置信度", ack["rejected"][0]["reason"])
        self.assertEqual(ack["stats"]["quarantined"], 1)
        # 落库:written 1 行 active + quarantined 1 行待观察
        rows = self.conn.execute(
            "SELECT status, is_active, summary FROM episodic_memory"
        ).fetchall()
        self.assertEqual(len(rows), 2)
        by_status = {r[0]: r for r in rows}
        self.assertEqual(set(by_status), {"active", "quarantined"})
        self.assertTrue(all(r[1] == 1 for r in rows))  # 隔离行也是活的
        # 检索排除隔离行:她不把没把握的事当真事记
        hits, _ = retrieve.retrieve(self.conn, "master", "半信半疑", 6, now=NOW)
        self.assertEqual(len(hits), 0)
        hits, _ = retrieve.retrieve(self.conn, "master", "确凿的事实", 6, now=NOW)
        self.assertEqual(len(hits), 1)

    def test_missing_confidence_rejected(self):
        """confidence 缺席 = 模型失职(schema 要求该字段)→ 硬闸拒收。"""
        c = candidate(summary="没给置信度的", slot="noconf")
        c.pop("confidence")
        ack = judge.commit(self.conn, "master", self._structured([c]),
                           "测试", now=NOW)
        self.assertEqual(len(ack["written"]), 0)
        self.assertEqual(len(ack["quarantined"]), 0)
        self.assertEqual(len(ack["rejected"]), 1)
        self.assertIn("置信度", ack["rejected"][0]["reason"])

    def test_promotion_by_slot(self):
        """晋升:同 slot 高置信版本后来居上,隔离行让位。"""
        judge.commit(self.conn, "master", self._structured([
            candidate(summary="他好像在准备面试", confidence=0.6,
                      slot="prep_interview"),
        ]), "测试", now=NOW)
        row = self.conn.execute(
            "SELECT memory_id, status, is_active FROM episodic_memory"
        ).fetchone()
        self.assertEqual(row[1], "quarantined")
        judge.commit(self.conn, "master", self._structured([
            candidate(summary="他在准备面试", confidence=0.9,
                      slot="prep_interview"),
        ]), "测试", now=NOW)
        rows = self.conn.execute(
            "SELECT memory_id, status, is_active, superseded_by"
            " FROM episodic_memory ORDER BY memory_id").fetchall()
        self.assertEqual(len(rows), 2)
        self.assertEqual(rows[0][2], 0)             # 隔离行让位
        self.assertEqual(rows[0][3], rows[1][0])    # 指向正式行
        self.assertEqual(rows[1][2], 1)
        self.assertEqual(rows[1][1], "active")
        hits, _ = retrieve.retrieve(self.conn, "master", "准备面试", 6, now=NOW)
        self.assertEqual(len(hits), 1)

    def test_demote_guard(self):
        """降观察:正式行同句已在,弱重观测是佐证 → 强化正式行,
        不落重复隔离行(已确立的事实不因低置信重测而降级)。"""
        judge.commit(self.conn, "master", self._structured([
            candidate(summary="他喜欢章鱼小丸子", confidence=0.9,
                      slot="likes_tako"),
        ]), "测试", now=NOW)
        before = self.conn.execute(
            "SELECT memory_id, recall_count, status FROM episodic_memory"
        ).fetchone()
        judge.commit(self.conn, "master", self._structured([
            candidate(summary="他喜欢章鱼小丸子", confidence=0.6,
                      slot="likes_tako"),
        ]), "测试", now=NOW)
        after = self.conn.execute(
            "SELECT memory_id, recall_count, status FROM episodic_memory"
        ).fetchall()
        self.assertEqual(len(after), 1)              # 没有新行
        self.assertEqual(after[0][0], before[0])     # 还是那条正式行
        self.assertEqual(after[0][1], before[1] + 1)  # 被强化(recall+1)
        self.assertEqual(after[0][2], "active")      # 没被降级

    def test_all_quarantined_still_degrades(self):
        """全隔离轮:情绪是真的,存疑的只是事实 —— 降级路径照发。"""
        ack = judge.commit(self.conn, "master", self._structured([
            candidate(summary="半信半疑", confidence=0.6, slot="maybe"),
        ], emotion_score=6, summary="他聊了很开心的事"),
            "测试", now=NOW)
        self.assertEqual(len(ack["quarantined"]), 1)
        self.assertEqual(len(ack["written"]), 1)     # 降级行
        self.assertTrue(ack["stats"]["degraded"])
        self.assertIn("降级", ack["written"][0]["layer"])

    def test_l0_quarantined_no_name(self):
        """隔离的 L0 称呼不落画像:隔离就是隔离,0.6 置信不配改名。"""
        ack = judge.commit(self.conn, "master", self._structured([
            candidate(layer="L0", field="preferredName",
                      summary="他希望被叫大佬", slot="identity_name",
                      confidence=0.6),
        ]), "测试", now=NOW)
        self.assertEqual(len(ack["quarantined"]), 1)
        self.assertIsNone(ack["name"])

    def test_reflection_window_excludes_quarantined(self):
        """反思候选窗口不吃隔离行:反思总结她已确信的事,不总结悬案。"""
        judge.commit(self.conn, "master", self._structured([
            candidate(summary="半信半疑的事", confidence=0.6, slot="maybe"),
        ]), "测试", now=NOW)
        window = reflection._read_window(self.conn, "master", 0, 50)
        self.assertEqual(len(window), 0)

    def test_status_column_migration(self):
        """旧库(v0.4.x 建表无 status)连接时幂等补列并回填 'active'。"""
        self.conn.close()
        old_db = Path(self.db)
        old_db.unlink()
        import sqlite3
        raw = sqlite3.connect(self.db)
        # 逼真旧形状:v0.4.x 的表有 timestamp/keywords 等列,只缺 status
        raw.execute(
            "CREATE TABLE episodic_memory (memory_id INTEGER PRIMARY KEY"
            " AUTOINCREMENT, user_id TEXT, keywords TEXT, summary TEXT,"
            " emotion_score INTEGER, timestamp TIMESTAMP,"
            " is_active INTEGER DEFAULT 1, layer TEXT DEFAULT '')")
        raw.execute(
            "INSERT INTO episodic_memory (user_id, summary, is_active)"
            " VALUES ('master', '旧记忆', 1)")
        raw.commit()
        raw.close()
        conn = db.connect(self.db)
        try:
            cols = {r[1] for r in conn.execute(
                "PRAGMA table_info(episodic_memory)")}
            self.assertIn("status", cols)
            row = conn.execute(
                "SELECT status FROM episodic_memory WHERE summary = '旧记忆'"
            ).fetchone()
            self.assertEqual(row[0], "active")     # 回填,不是 NULL
            # 幂等:再连一次不炸不重复
            conn.close()
            conn = db.connect(self.db)
            self.assertIn("status", {r[1] for r in conn.execute(
                "PRAGMA table_info(episodic_memory)")})
        finally:
            conn.close()


class WireRoundTrip(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.db = str(Path(self.tmp.name) / "echo.db")
        db.connect(self.db).close()
        self.w = WorkerHarness()
        self.assertEqual(self.w.roundtrip(hello_frame(db_path=self.db))["type"], "ready")

    def tearDown(self):
        self.w.close()
        self.tmp.cleanup()

    def test_extract_prompt(self):
        """★ 2026-10-17 改判据:从"基调句必须在"改成"四道硬门必须在"。

        原来断言 prompt 里有「宁可漏记」这句基调。extract 提示词压到
        3146 字符(本地 3B 的边界)后这句被砍了 —— 但基调的**执行层**是
        `post_filter_*` 那几道硬门,不是那句话本身:
          shouldWrite(`:397`) / L0 双门控(`:400-402`) /
          绝对化(`:407`) / 主题自指(`:409`)。

        ⇒ 这里钉"墙在",不钉"劝在"(劝的话模型未必听,墙一定拦)。
        """
        r = self.w.roundtrip({"reqId": 1, "type": "extract_prompt"})
        self.assertEqual(r["type"], "extract_prompt_result")
        self.assertNotIn("stub", r)
        self.assertIn("candidates", r["prompt"])
        self.assertIn("emotion_vector", r["prompt"])
        self.assertEqual(r["schema"]["type"], "object")
        self.assertIn("pendingThreads", r["schema"]["required"])
        # 四道硬门在代码里(这才是"少记错、不多记住"的执行层)
        self.assertTrue(callable(judge.post_filter_candidates))
        self.assertTrue(callable(judge.post_filter_triples))
        self.assertTrue(callable(judge.is_self_referential))
        self.assertEqual(judge.post_filter_candidates([candidate(shouldWrite=False)]), [],
                         "shouldWrite=false 必须被挡")
        self.assertEqual(
            judge.post_filter_candidates([candidate(layer="L0", certainty="inferred")]), [],
            "L0 双门控:inferred 不许进画像")

    def test_extract_commit_cycle(self):
        structured = {
            "keywords": ["猫"], "summary": "他说他喜欢猫",
            "emotion_score": 6, "emotion_state": "happy",
            "mood_intensity": 5,
            "candidates": [candidate(summary="他喜欢猫", slot="likes_cats")],
            "triples": [triple(t="猫咪")],
            "pendingThreads": [],
        }
        r = self.w.roundtrip({"reqId": 2, "type": "extract_commit",
                              "userId": "master", "structured": structured,
                              "text": "我喜欢猫", "now": NOW})
        self.assertEqual(r["type"], "extract_ack")
        self.assertEqual(len(r["written"]), 1)
        self.assertEqual(r["learned"], 1)
        self.assertEqual(r["name"], None)
        # 检索闭环:b3 的 retrieve 能检回 b4 写进去的记忆
        q = self.w.roundtrip({"reqId": 3, "type": "retrieve",
                              "userId": "master", "query": "猫", "topK": 6,
                              "now": NOW})
        self.assertEqual(len(q["items"]), 1)
        self.assertIn("他喜欢猫", q["text"])
        # 图闭环:b2 的 graph_query 能走到 b4 写进去的边
        # (单字节点不参与直扫 —— 用双字节点名验证)
        g = self.w.roundtrip({"reqId": 4, "type": "graph_query",
                              "userId": "master", "text": "猫咪怎么样", "now": NOW})
        self.assertIn("猫咪 <-[喜欢]- 用户", g["pathsText"])

    def test_extract_commit_quarantine_wire(self):
        """M2-h 帧闭环:0.6 置信候选 → ack.quarantined,检索不可见。"""
        structured = {
            "keywords": ["猫"], "summary": "他好像养了猫",
            "emotion_score": 3, "emotion_state": "neutral",
            "mood_intensity": 3,
            "candidates": [candidate(summary="他可能养了猫",
                                     confidence=0.6, slot="maybe_cats")],
            "triples": [], "pendingThreads": [],
        }
        r = self.w.roundtrip({"reqId": 2, "type": "extract_commit",
                              "userId": "master", "structured": structured,
                              "text": "我好像养了猫", "now": NOW})
        self.assertEqual(r["type"], "extract_ack")
        self.assertEqual(len(r["written"]), 0)      # emotion_score<4 不降级
        self.assertEqual(len(r["quarantined"]), 1)
        self.assertEqual(r["stats"]["quarantined"], 1)
        q = self.w.roundtrip({"reqId": 3, "type": "retrieve",
                              "userId": "master", "query": "养猫", "topK": 6,
                              "now": NOW})
        self.assertEqual(len(q["items"]), 0)        # 隔离行检索不可见

    def test_missing_params_nonfatal(self):
        r = self.w.roundtrip({"reqId": 1, "type": "extract_commit",
                              "structured": {}})
        self.assertEqual(r["type"], "error")
        r2 = self.w.roundtrip({"reqId": 2, "type": "extract_commit",
                               "userId": "master"})
        self.assertEqual(r2["type"], "error")


class SayAgainPayload(unittest.TestCase):
    """v0.21.0 E5:情绪余波的两个字段(A `core/echo_prompts.py:45-46`)。

    A 的纪律:判据**很窄**(仅当助手自己情绪余波未平),`say_again=0` 时
    `extra_reply` 必须为空。模型偶尔两个都给 —— 这时以 say_again 为准把
    台词清掉,不能让壳里出现"没说要补却在补"。
    """

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.db = str(Path(self.tmp.name) / "echo.db")
        self.conn = db.connect(self.db)

    def tearDown(self):
        self.conn.close()
        self.tmp.cleanup()

    def _minimal(self, **extra):
        d = {"keywords": [], "summary": "", "emotion_score": 5,
             "emotion_state": "neutral", "candidates": [], "triples": [],
             "pendingThreads": []}
        d.update(extra)
        return d

    def test_prompt_states_both_rules(self):
        """★ 2026-10-17 改判据:从"prompt 必须写清规则"改成"normalize 必须强钳位"。

        原来断言 prompt 里有 `"say_again": 0` / `"extra_reply": ""` /
        「连续多轮都给 1 属于错误行为」/「15 字以内」这些原句。
        提示词压缩到 3146 字符后,这些**展开说明**被砍成一句
        「只填 0 或 1…日常一律 0」—— 但**执行层不受影响**:

          · `say_again` 只认 1,其余一律 0(强钳位,不是"建议");
          · `say_again=0` 时 `extra_reply` 被**强制清空**
            (注释原话:"模型偶尔会两个都给,这时以 say_again 为准把台词清掉")。

        ★ 关于长度:**这层是刻意不统一的,不是遗漏** ——
          · prompt 写「15 字以内」= **目标**(劝模型写短);
          · normalize 裁到 **80 字** = **兜底上限**(防模型吐一篇小作文把壳撑爆)。
          两层管的是不同的事:目标管"应该多长",上限管"再长也不许超过"。
          把它们焊成同一个数,会让"模型写 20 字"被无谓截断。
        """
        prompt = judge.build_extract_prompt()
        self.assertIn("say_again", prompt)     # 字段要让模型知道
        self.assertIn("extra_reply", prompt)

        # 真正生效的那一层:强钳位(不信模型,自己再判一遍)
        keep = judge.normalize_extract(self._minimal(say_again=1, extra_reply="还想赖着你一会儿"))
        self.assertEqual(keep["sayAgain"], 1)
        self.assertEqual(keep["extraReply"], "还想赖着你一会儿")
        # 只认 1:给 2/7 一律归 0
        for odd in (2, 7, 99):
            self.assertEqual(judge.normalize_extract(self._minimal(say_again=odd))["sayAgain"], 0,
                             "say_again 只认 1,别的值一律 0")
        # say_again=0 ⇒ extra_reply 必须被清空(模型两个都给时的兜底)
        both = judge.normalize_extract(self._minimal(say_again=0, extra_reply="不该出现的一句"))
        self.assertEqual(both["extraReply"], "",
                         "say_again=0 时 extra_reply 必须清空 —— 否则壳里会出现没说要补却在补")

    def test_schema_requires_both(self):
        schema = judge.build_extract_schema()
        self.assertIn("say_again", schema["required"])
        self.assertIn("extra_reply", schema["required"])
        self.assertEqual(schema["properties"]["say_again"]["type"], "number")
        self.assertEqual(schema["properties"]["extra_reply"]["type"], "string")

    def test_normalize_keeps_a_real_afterglow(self):
        ex = judge.normalize_extract(self._minimal(say_again=1, extra_reply="  还想赖着你一会儿  "))
        self.assertEqual(ex["sayAgain"], 1)
        self.assertEqual(ex["extraReply"], "还想赖着你一会儿")

    def test_normalize_clears_words_when_flag_zero(self):
        """模型两个都给 ⇒ 以 say_again 为准(不许"没说要补却在补")。"""
        ex = judge.normalize_extract(self._minimal(say_again=0, extra_reply="我没说这句"))
        self.assertEqual(ex["sayAgain"], 0)
        self.assertEqual(ex["extraReply"], "")

    def test_normalize_flag_accepts_only_one(self):
        for raw, want in [(1, 1), ("1", 1), (1.0, 1), (2, 0), (0, 0), ("yes", 0),
                          (None, 0), ("", 0), ([], 0)]:
            ex = judge.normalize_extract(self._minimal(say_again=raw, extra_reply="x"))
            self.assertEqual(ex["sayAgain"], want, "say_again=%r" % (raw,))

    def test_normalize_clips_long_line(self):
        ex = judge.normalize_extract(self._minimal(say_again=1, extra_reply="啊" * 200))
        self.assertEqual(len(ex["extraReply"]), 80)

    def test_ack_carries_both_fields_to_the_shell(self):
        """端到端:壳侧 read 的是 ack.extract.sayAgain / extraReply。"""
        ack = judge.commit(self.conn, "master",
                           self._minimal(say_again=1, extra_reply="别走太快"),
                           "我先去忙了", session_id="s1", now=NOW)
        self.assertEqual(ack["extract"]["sayAgain"], 1)
        self.assertEqual(ack["extract"]["extraReply"], "别走太快")

    def test_ack_omits_nothing_even_when_no_afterglow(self):
        ack = judge.commit(self.conn, "master", self._minimal(), "嗯", now=NOW)
        self.assertEqual(ack["extract"]["sayAgain"], 0)
        self.assertEqual(ack["extract"]["extraReply"], "")


class ProfileUpdateProducer(unittest.TestCase):
    """v0.22.0 M3:画像常驻锚点的**产出端**(A `main.py:934-955`)。

    以前 B 的 `代词` 没有任何产出端 —— 落地端(白名单/上限/渲染)早就能收,
    可判官从不给,于是那一格永远空着。现在判官按 A 的封闭两键输出,并且
    与"从 L0 候选派生"的一路**合并**(A 的顺序:派生的覆盖模型给的)。
    """

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.db = str(Path(self.tmp.name) / "echo.db")
        self.conn = db.connect(self.db)

    def tearDown(self):
        self.conn.close()
        self.tmp.cleanup()

    def _structured(self, **extra):
        d = {"keywords": [], "summary": "", "emotion_score": 5,
             "emotion_state": "neutral", "candidates": [], "triples": [],
             "pendingThreads": []}
        d.update(extra)
        return d

    def test_schema_is_a_closed_two_key_object(self):
        prop = judge.build_extract_schema()["properties"]["profile_update"]
        self.assertEqual(prop["type"], "object")
        self.assertFalse(prop["additionalProperties"])
        self.assertEqual(sorted(prop["properties"].keys()), ["代词", "语言"])

    def test_prompt_names_the_closed_keys(self):
        """★ 2026-10-17 改判据:从"prompt 必须列全"改成"白名单必须硬筛"。

        原来断言 prompt 里有「键是封闭的两个」「自称或被称呼方式」这些**解释性文字**。
        extract 提示词压缩到 3146 字符后这些文字被砍了 —— 但这**没有风险**:
        `normalize_extract` 在 `judge.py` 里对 `profile_update` **再筛一遍白名单**
        (`if key not in ("语言", "代词"): continue`),注释自己也写着
        「提示词可能被绕过,模型可能自己加键」。

        ⇒ prompt 只需要让模型知道**有这个字段**;真正挡垃圾的是这里。
        """
        prompt = judge.build_extract_prompt()
        self.assertIn("profile_update", prompt)   # 字段本身要让模型知道
        # 真正生效的那一层:白名单硬筛(下面那条测试已在验,这里钉住"它拦得住"):
        ex = judge.normalize_extract({"profile_update": {"语言": "中文", "职业": "学生"}})
        self.assertEqual(ex["profileUpdate"], {"语言": "中文"},
                         "非白名单键必须被 normalize 丢掉 —— 这是 prompt 压缩后的唯一防线")

    def test_normalize_keeps_only_the_two_keys(self):
        ex = judge.normalize_extract({"profile_update": {
            "语言": " 中文 ", "代词": "他让我叫他阿岚", "职业": "学生", "": "x"}})
        self.assertEqual(ex["profileUpdate"], {"语言": "中文", "代词": "他让我叫他阿岚"})

    def test_normalize_caps_value_and_drops_empties(self):
        ex = judge.normalize_extract({"profile_update": {"语言": "中" * 100, "代词": "   "}})
        self.assertEqual(len(ex["profileUpdate"]["语言"]), 60)
        self.assertNotIn("代词", ex["profileUpdate"])

    def test_normalize_tolerates_junk(self):
        for bad in (None, "语言=中文", [], 7):
            ex = judge.normalize_extract({"profile_update": bad})
            self.assertEqual(ex["profileUpdate"], {}, "profile_update=%r" % (bad,))

    def test_ack_carries_the_producers_output(self):
        ack = judge.commit(self.conn, "master",
                           self._structured(profile_update={"代词": "他让我叫他阿岚"}),
                           "他让我叫他阿岚", now=NOW)
        self.assertEqual(ack["profileUpdate"], {"代词": "他让我叫他阿岚"})

    def test_derived_language_merges_with_model_pronoun(self):
        ack = judge.commit(self.conn, "master", self._structured(
            profile_update={"代词": "本座"},
            candidates=[candidate(layer="L0", field="language", summary="中文")]),
            "我平时说中文,自称本座", now=NOW)
        self.assertEqual(ack["profileUpdate"], {"语言": "中文", "代词": "本座"})

    def test_derived_wins_on_conflict(self):
        """A 的顺序:`profile_update.update(judge_profile)` —— 派生值来自
        已采信候选,比模型自由发挥更硬。"""
        ack = judge.commit(self.conn, "master", self._structured(
            profile_update={"语言": "英文"},
            candidates=[candidate(layer="L0", field="language", summary="中文")]),
            "我平时说中文", now=NOW)
        self.assertEqual(ack["profileUpdate"]["语言"], "中文")

    def test_empty_when_nobody_produces(self):
        ack = judge.commit(self.conn, "master", self._structured(), "嗯", now=NOW)
        self.assertEqual(ack["profileUpdate"], {})


class SelfReferentialGate(unittest.TestCase):
    """2026-09-26 现场(他:「我说这个记忆图谱为什么会出现那么多奇怪的记忆?
    我之前在 astrbot 上面可没有这个问题啊,那个记忆图是非常干净的」)。

    他的裁决:**工程自指一律拒收**。实测脏源:开发会话在范围内 + 宿主
    runtime context 被当人话捕获 ⇒ 库里长出 35 条(14%)"我们在改这个
    插件"的工作话,图上站着 `Echo记忆架构 / agent后端架构 / 网站后端架构`。

    这条门的**误拒代价不对称**:拒错了会把他真实的职业/课业扔掉,所以
    「做后端的」「我在学前端」必须收下 —— 第一版判据就是在这里被电池抓住的。
    """

    def test_self_referential_is_rejected(self):
        for text in [
            "用户提出记忆图谱布局要求:节点连线夹角不能过锐",
            "要求Echo去开源社区找现成的记忆图谱实现",
            "阿岚觉得审查台不好看也不方便",
            "他对箭头样式不满意",
            "用户最近在忙 AI 记忆架构的开发,反复删改代码,觉得很难",
            "Current runtime context. This snapshot supersedes earlier",
        ]:
            self.assertTrue(judge.is_self_referential(text), text)

    def test_his_life_is_kept(self):
        """误拒代价不对称:这些**必须**收下,否则就是把他的生活当噪音扔掉。"""
        for text in [
            "他把长期在推的游戏推完了,结局是所有角色都死了",
            "用户最近在准备面试",
            "他喜欢吃章鱼小丸子",
            "用户是西安电子科技大学的学生",
            "做后端的",              # 他的职业 —— 第一版判据在这里误拒过
            "爱打游戏",
            "中文",
            "用户这个月要去面试",
            "他买了新箭头去射箭",     # 「箭头」但讲的是射箭,不是界面
            "用户说他在学前端",       # 他的课业,不是我们的工程
        ]:
            self.assertFalse(judge.is_self_referential(text), text)

    def test_candidates_gate_drops_self_referential(self):
        kept = judge.post_filter_candidates([
            candidate(summary="用户说他喜欢猫"),
            candidate(summary="用户提出记忆图谱布局要求:节点连线夹角不能过锐"),
        ])
        self.assertEqual(len(kept), 1)
        self.assertIn("喜欢猫", kept[0]["summary"])

    def test_triples_gate_drops_self_referential(self):
        kept, dropped = judge.post_filter_triples([
            triple(s="用户", relation="喜欢", t="猫"),
            triple(s="用户", relation="在改", t="记忆图谱"),
        ])
        self.assertEqual(len(kept), 1)
        self.assertEqual(kept[0]["t"], "猫")
        self.assertEqual(len(dropped), 1)
        self.assertIn("自指", dropped[0]["reason"])

    def test_reject_reasons_names_the_gate(self):
        """被拦的候选要能说出**为什么** —— 审计要看得懂。"""
        validated = [candidate(summary="阿岚觉得审查台不好看也不方便")]
        reasons = judge.reject_reasons(validated, [])
        self.assertEqual(len(reasons), 1)
        self.assertIn("自指", reasons[0]["reason"])

    def test_prompt_tells_the_model_not_to_write_them(self):
        """★ 2026-10-17 反转判据:prompt 里**故意不再写**这句话,靠后处理挡。

        原来是「产出端也要说清(提示词是劝,后处理是墙 —— 两道都要)」。
        实测推翻了"两道都要"这个前提:

          · extract 提示词压到 3146 字符时(本地 3B 的边界内) **5/5 全通**;
          · 一旦把这句「**不要记**『关于这个插件/这套代码/这个页面』的事」加回去
            (3425 字符),3B **0/5**,而且**0.8 秒就吐出空模板** ——
            全局否定被它听成「这轮什么都别记」,不是"抽了但抽错"。

        ⇒ 这类**全局否定**在 3B 上是负资产。而它本来也不必需:
          `post_filter_candidates` / `post_filter_triples` 里的
          `is_self_referential()` 是**代码墙**,不靠模型自觉。

        所以这条测试反过来钉:**prompt 里没有那句全局否定**(否则 3B 会放弃),
        且**后处理确实挡得住**(这才是真正生效的那道)。
        """
        prompt = judge.build_extract_prompt()
        # ① 全局否定必须不在 —— 它在 = 3B 放弃(实测 0.8s 空模板)
        self.assertNotIn("不要记「关于这个插件", prompt,
                         "这句全局否定会让 3B 整轮放弃(实测 0/5),不许写进 prompt")
        self.assertNotIn("不是他的生活", prompt)
        # ② 后处理墙仍然在,而且真的挡得住
        self.assertTrue(judge.is_self_referential("用户提出记忆图谱布局要求:节点连线夹角不能过锐"))
        kept = judge.post_filter_candidates([
            candidate(summary="用户说他喜欢猫"),
            candidate(summary="用户要求把这套代码的重构分支合并掉"),
        ])
        self.assertEqual(len(kept), 1, "工程自指必须被后处理挡掉")
        self.assertIn("喜欢猫", kept[0]["summary"])


class NullableNameAndGraphAccounting(unittest.TestCase):
    """2026-10-11:两条现场修复的回归钉子。

    ① `name` 的 schema 与提示词**互相矛盾** —— 提示词第 529 行写「没有称呼就
       填 null」,而 schema 只声明 `type: string`。模型照提示词吐
       `"name": null` 时,宿主的 outputSchema 校验把**整次调用**判非法
       (`invalid arguments: "value.name" must be a string`),于是这一轮的
       情绪 / 候选 / 三元组**全部作废**。活库实测 2026-10-11 三次。
    ② 图写失败的异常被吞成 `learned = 0`,与"模型本来就没给三元组"在库里
       长得一模一样 ⇒「知识图谱为什么不动」查不出来。
    """

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.db = str(Path(self.tmp.name) / "echo.db")
        self.conn = db.connect(self.db)

    def tearDown(self):
        self.conn.close()
        self.tmp.cleanup()

    def _structured(self, **extra):
        d = {"keywords": ["猫"], "summary": "用户说他喜欢猫",
             "emotion_score": 5, "emotion_state": "neutral",
             "candidates": [], "triples": [], "pendingThreads": []}
        d.update(extra)
        return d

    # ---- ① name 可空 ----

    def test_schema_name_accepts_string_or_null(self):
        prop = judge.build_extract_schema()["properties"]["name"]
        self.assertNotIn("type", prop,
                         "DSH 的 schema 子集禁止 type 与 oneOf 并用")
        self.assertIn("oneOf", prop)
        kinds = sorted(b.get("type") for b in prop["oneOf"])
        self.assertEqual(kinds, ["null", "string"],
                         "提示词让模型在没称呼时填 null ⇒ schema 必须收 null")

    def test_name_is_not_required(self):
        """省略 name 也必须合法 —— 成功那几次正是模型自己省略了它。"""
        self.assertNotIn("name", judge.build_extract_schema()["required"])

    def test_commit_survives_null_name(self):
        """端到端:模型照提示词给 null 时,这一轮照常落库(不再整轮作废)。"""
        ack = judge.commit(self.conn, "master",
                           self._structured(name=None, candidates=[candidate()]),
                           "我喜欢猫", now=NOW)
        self.assertIsNone(ack["name"])
        self.assertGreaterEqual(len(ack["written"]), 1,
                                "候选必须照常落库")

    # ---- ② 图账可查 ----

    def test_valid_triple_reports_learned(self):
        ack = judge.commit(self.conn, "master",
                           self._structured(triples=[triple()]),
                           "我喜欢猫", now=NOW)
        self.assertEqual(ack["stats"]["triplesWritten"], 1)
        self.assertEqual(ack["graphError"], "")
        self.assertEqual(ack["learned"], 1, "合格三元组必须真写进图")

    def test_graph_write_failure_is_reported_not_swallowed(self):
        from unittest import mock
        with mock.patch.object(judge.graph, "learn",
                               side_effect=RuntimeError("boom-ddl")):
            ack = judge.commit(self.conn, "master",
                               self._structured(triples=[triple()]),
                               "我喜欢猫", now=NOW)
        self.assertEqual(ack["learned"], 0)
        self.assertIn("boom-ddl", ack["graphError"],
                      "写边失败必须把原因带回壳侧(以前是静默 learned=0)")
        self.assertIn("boom-ddl", ack["stats"]["graphError"])

    def test_dropped_triples_carry_their_reason(self):
        """被过滤的三元组要带着理由回壳 —— 审计据此回答"图为什么没长"。"""
        ack = judge.commit(self.conn, "master",
                           self._structured(triples=[triple(shouldWrite=False)]),
                           "我喜欢猫", now=NOW)
        self.assertEqual(ack["stats"]["triplesWritten"], 0)
        self.assertEqual(len(ack["triplesRejected"]), 1)
        self.assertIn("shouldWrite", ack["triplesRejected"][0]["reason"])


if __name__ == "__main__":
    unittest.main()
