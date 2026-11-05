# -*- coding: utf-8 -*-
"""想念值引擎测试(M2-f)。

曲线数学 / 补差守恒 / 脉冲削减调制 / 冷启动回填 / 抗议尖峰 /
关怀缓解与冷却 / 心境调制阈值 / 夜间憋话 / 演示倍率 / 帧往返。
"""
import json
import shutil
import sys
import tempfile
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from engine import db, longing  # noqa: E402
from test_worker import WorkerHarness, hello_frame  # noqa: E402

NOW = time.mktime((2026, 9, 23, 12, 0, 0, 0, 0, -1))
H = 3600.0
DAY = 86400.0


def conn_with_tables():
    """临时目录里建新库(mkstemp 在 Windows 上攥句柄,unlink 会炸)。"""
    d = tempfile.mkdtemp(prefix="echo-lng-")
    path = str(Path(d) / "t.db")
    return db.connect(path, must_exist=False), d


def cleanup_conn(conn, d):
    try:
        conn.close()
    finally:
        shutil.rmtree(d, ignore_errors=True)


def seed_row(conn, user_id="master", *, value=0.0, anchor=NOW,
             updated=NOW, kicked=0, last_msg=NOW, last_care=0.0,
             care_count=0, sess=""):
    conn.execute(
        "INSERT INTO longing_state (user_id, value, anchor_at, updated_at,"
        " kicked, last_user_msg_at, last_care_at, care_count, session_id)"
        " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (user_id, value, anchor, updated, kicked, last_msg,
         last_care, care_count, sess))
    conn.commit()


class CurveMath(unittest.TestCase):
    """M(s) = 10·s/(s+H):M(0)=0,M(H)=5,M(3H)=7.5 —— 单调、饱和、单参数。"""

    def test_anchor_points(self):
        self.assertEqual(longing.longing_curve(0, 3.0), 0.0)
        self.assertAlmostEqual(longing.longing_curve(3 * H, 3.0), 5.0)
        self.assertAlmostEqual(longing.longing_curve(9 * H, 3.0), 7.5)

    def test_guards(self):
        self.assertEqual(longing.longing_curve(-100, 3.0), 0.0)
        # 半衰期钳位:0.05h → 0.1h(360s)。曲线里 `or 3.0` 只在配置
        # 缺席时兜底 —— 配置侧已钳到 ≥0.1,0 到不了这里(AstrBot 同款)。
        self.assertAlmostEqual(longing.longing_curve(1000, 0.05),
                               10.0 * 1000 / 1360.0, places=6)


class ConfigMerge(unittest.TestCase):
    """帧携带配置:显式 0 合法(v8.7.2 语义),缺省用论文推荐值。"""

    def test_defaults(self):
        cfg = longing.merge_config(None)
        self.assertEqual(cfg["threshold"], 7.0)
        self.assertEqual(cfg["cooldown_minutes"], 120)
        self.assertTrue(cfg["night_hold"])

    def test_overrides_and_zero(self):
        cfg = longing.merge_config({"cooldownMinutes": 0, "demoRate": 60,
                                    "nightHold": False})
        self.assertEqual(cfg["cooldown_minutes"], 0)  # 0 不被吞成默认
        self.assertEqual(cfg["demo_rate"], 60.0)
        self.assertFalse(cfg["night_hold"])


class LazyCatchup(unittest.TestCase):
    """惰性补差:两次小读之和恒等于一次大读(补差守恒)。"""

    def test_conservation(self):
        conn, d = conn_with_tables()
        try:
            seed_row(conn, value=0.0, anchor=NOW, updated=NOW)
            # 路径 A:一次读到 +4h
            big = longing.get_longing(conn, "master", now=NOW + 4 * H)
            # 路径 B(新库同种子):先读 +2h 再读 +4h
            conn.execute("DELETE FROM longing_state")
            seed_row(conn, value=0.0, anchor=NOW, updated=NOW)
            longing.get_longing(conn, "master", now=NOW + 2 * H)
            small = longing.get_longing(conn, "master", now=NOW + 4 * H)
            self.assertAlmostEqual(big["value"], small["value"], places=6)
            # 读即刷新:再读一次值不变(守恒)
            again = longing.get_longing(conn, "master", now=NOW + 4 * H)
            self.assertAlmostEqual(small["value"], again["value"], places=6)
        finally:
            cleanup_conn(conn, d)

    def test_never_chatted(self):
        conn, d = conn_with_tables()
        try:
            st = longing.get_longing(conn, "stranger", now=NOW)
            self.assertFalse(st["exists"])
            self.assertEqual(st["value"], 0.0)
        finally:
            cleanup_conn(conn, d)

    def test_demo_rate(self):
        """演示倍率:rate=60 时离开 5 分钟 ≈ 离开 5 小时(答辩现场可看)。"""
        conn, d = conn_with_tables()
        try:
            seed_row(conn, value=0.0, anchor=NOW, updated=NOW)
            cfg = longing.merge_config({"demoRate": 60})
            st = longing.get_longing(conn, "master", now=NOW + 300, cfg=cfg)
            # 300s×60=18000s=5h → M=10·18000/(18000+10800)≈6.25
            self.assertAlmostEqual(st["value"], 6.25, places=2)
        finally:
            cleanup_conn(conn, d)


class MessagePulse(unittest.TestCase):
    """消息削减:Hull 脉冲 + v8.8.1 刺激质量调制(只少削不多削)。"""

    def test_session_id_routing_field(self):
        # M3-a 投递路由:get_longing/should_care 带回 sessionId ——
        # 关怀心跳只对「她聊过的那个会话」开口(AstrBot 安全默认)。
        conn, d = conn_with_tables()
        try:
            seed_row(conn, value=6.0, anchor=NOW, updated=NOW, sess="sess-1")
            st = longing.get_longing(conn, "master", now=NOW + 60)
            self.assertEqual(st["sessionId"], "sess-1")
            ok2, st2 = longing.should_care(conn, "master", now=NOW + 120)
            self.assertEqual(st2["sessionId"], "sess-1")
            # 无行(从未聊过)→ 空串:她不会想念没说过话的人,
            # 也不会对不知道往哪开口的会话硬开口。
            st3 = longing.get_longing(conn, "stranger", now=NOW + 60)
            self.assertEqual(st3["sessionId"], "")
        finally:
            cleanup_conn(conn, d)

    def test_full_drop_and_reset(self):
        conn, d = conn_with_tables()
        try:
            seed_row(conn, value=6.0, anchor=NOW, updated=NOW, kicked=1,
                     sess="old")
            longing.on_message(conn, "master", now=NOW + H, text=None,
                               session_id="s-new")
            row = conn.execute(
                "SELECT value, anchor_at, kicked, session_id"
                " FROM longing_state WHERE user_id = 'master'").fetchone()
            # 先补差再削减(AstrBot 语义):这一小时她攒了 M(1h)=2.5,
            # 你的消息再削 4 → 6+2.5−4=4.5。锚点重置、抗议清零。
            self.assertAlmostEqual(row[0], 4.5)
            self.assertAlmostEqual(row[1], NOW + H)  # 锚点重置
            self.assertEqual(row[2], 0)  # 抗议标志清零
            self.assertEqual(row[3], "s-new")
        finally:
            cleanup_conn(conn, d)

    def test_quality_modulation(self):
        conn, d = conn_with_tables()
        try:
            # 敷衍("嗯"≤2 字):削半 → 6−2=4
            seed_row(conn, value=6.0, anchor=NOW, updated=NOW)
            longing.on_message(conn, "master", now=NOW, text="嗯")
            v = conn.execute(
                "SELECT value FROM longing_state"
                " WHERE user_id = 'master'").fetchone()[0]
            self.assertAlmostEqual(v, 4.0)
            # 认真(≥40 字):削满 → 6−4=2(now=anchor,无补差噪声)
            conn.execute("DELETE FROM longing_state")
            seed_row(conn, value=6.0, anchor=NOW, updated=NOW)
            longing.on_message(conn, "master", now=NOW,
                               text="今天校园跑跑完了三公里,虽然很累但是坚持下来了" * 2)
            v = conn.execute(
                "SELECT value FROM longing_state"
                " WHERE user_id = 'master'").fetchone()[0]
            self.assertAlmostEqual(v, 2.0)
        finally:
            cleanup_conn(conn, d)

    def test_drop_saturates_so_clipping_is_neutral(self):
        """v0.18.2 C6:满足量系数 40 字就饱和 ⇒ 壳侧按 400 字截断送帧是**数学中性**的。

        背景:壳侧曾经卡 `text.length <= 2000` 才发这一帧(贴长文就把想念削减
        整条绕过去)。去掉那条闸以后改成截前 400 字送 —— 这个用例证明
        "截断"与"全文"削得一模一样(40/400/5000 字三档同值),所以那次修
        不会悄悄改变想念的数学。
        """
        def drop_for(text):
            conn, d = conn_with_tables()
            try:
                seed_row(conn, value=6.0, anchor=NOW, updated=NOW)
                longing.on_message(conn, "master", now=NOW, text=text)
                return conn.execute(
                    "SELECT value FROM longing_state"
                    " WHERE user_id = 'master'").fetchone()[0]
            finally:
                cleanup_conn(conn, d)

        v40 = drop_for("刚" * 40)
        v400 = drop_for("刚" * 400)
        v5000 = drop_for("刚" * 5000)
        self.assertAlmostEqual(v40, v400)
        self.assertAlmostEqual(v400, v5000)
        # 与"削满"的绝对值对上:6 − 4 = 2(削满是系数 1.0)
        self.assertAlmostEqual(v5000, 2.0)


class ColdStartBackfill(unittest.TestCase):
    """v8.7.1 冷启动回填:缺席发生在行存在之前,也要长出想念。"""

    def test_seed_from_audit(self):
        conn, d = conn_with_tables()
        try:
            conn.execute(
                "INSERT INTO audit_logs (trace_id, user_key, tool_call,"
                " timestamp) VALUES ('t1', 'master', '', ?)", (NOW - DAY,))
            conn.commit()
            longing.on_message(conn, "master", now=NOW)  # 首条消息建行
            row = conn.execute(
                "SELECT anchor_at FROM longing_state"
                " WHERE user_id = 'master'").fetchone()
            self.assertAlmostEqual(row[0], NOW - DAY)  # 种在上一轮对话
            # 缺席一整天的想念自然长出(与正常路径同一套数学)
            st = longing.get_longing(conn, "master", now=NOW + H)
            self.assertAlmostEqual(st["value"], 10.0 * (DAY + H)
                                   / (DAY + H + 3 * H), places=3)
        finally:
            cleanup_conn(conn, d)

    def test_seed_fallback_episodic(self):
        """审计黑匣子裁剪后(v8.7.2)退而求情景记忆最后一笔。"""
        conn, d = conn_with_tables()
        try:
            conn.execute(
                "INSERT INTO episodic_memory (user_id, summary, keywords,"
                " emotion_score, source, timestamp, is_active)"
                " VALUES ('master', '旧时光', '旧', 5, 'dsh', ?, 1)",
                (NOW - 2 * DAY,))
            conn.commit()
            longing.on_message(conn, "master", now=NOW)
            row = conn.execute(
                "SELECT anchor_at FROM longing_state"
                " WHERE user_id = 'master'").fetchone()
            self.assertAlmostEqual(row[0], NOW - 2 * DAY)
        finally:
            cleanup_conn(conn, d)

    def test_true_first_meeting(self):
        """无历史才是真初见:种在 now,刚见面谈不上想念。"""
        conn, d = conn_with_tables()
        try:
            longing.on_message(conn, "master", now=NOW)
            st = longing.get_longing(conn, "master", now=NOW)
            self.assertAlmostEqual(st["value"], 0.0)
        finally:
            cleanup_conn(conn, d)


class ProtestKick(unittest.TestCase):
    """Bowlby 抗议期:沉默 10 分钟~2 小时窗口内一次性 +1.5。"""

    def test_kick_once(self):
        conn, d = conn_with_tables()
        try:
            # anchor=updated=now:无补差噪声,只看尖峰本身
            seed_row(conn, value=5.0, anchor=NOW, updated=NOW,
                     last_msg=NOW - 1800)  # 沉默 30 分钟,在窗口内
            longing.tick(conn, now=NOW)
            row = conn.execute(
                "SELECT value, kicked FROM longing_state"
                " WHERE user_id = 'master'").fetchone()
            self.assertAlmostEqual(row[0], 6.5, places=3)
            self.assertEqual(row[1], 1)
            # 再 tick 不重复加(每次缺席只加一次);两次 tick 之间照常补差
            longing.tick(conn, now=NOW + 60)
            row = conn.execute(
                "SELECT value, kicked FROM longing_state"
                " WHERE user_id = 'master'").fetchone()
            self.assertAlmostEqual(
                row[0], 6.5 + longing.longing_curve(60, 3.0), places=3)
        finally:
            cleanup_conn(conn, d)

    def test_out_of_window(self):
        conn, d = conn_with_tables()
        try:
            # 沉默 3 小时:超出抗议窗口,曲线本身已积累得够多
            seed_row(conn, value=5.0, anchor=NOW, updated=NOW,
                     last_msg=NOW - 3 * H)
            longing.tick(conn, now=NOW)
            row = conn.execute(
                "SELECT value, kicked FROM longing_state"
                " WHERE user_id = 'master'").fetchone()
            self.assertEqual(row[1], 0)
            self.assertAlmostEqual(row[0], 5.0, places=3)  # 只有补差,无尖峰
        finally:
            cleanup_conn(conn, d)


class CareGate(unittest.TestCase):
    """三重闸门:阈值 → 冷却 → 夜间憋话;关怀缓解 ×0.5。"""

    def test_relief_and_cooldown(self):
        conn, d = conn_with_tables()
        try:
            seed_row(conn, value=8.0, anchor=NOW, updated=NOW)
            longing.on_care_sent(conn, "master", now=NOW)
            row = conn.execute(
                "SELECT value, last_care_at, care_count FROM longing_state"
                " WHERE user_id = 'master'").fetchone()
            self.assertAlmostEqual(row[0], 4.0)  # ×0.5:表达了但没解决
            self.assertAlmostEqual(row[1], NOW)
            self.assertEqual(row[2], 1)
            # 冷却期内(默认 120 分钟)即使想念回涨也不开口
            ok, st = longing.should_care(conn, "master", now=NOW + 30 * 60)
            self.assertFalse(ok)
            # 过了冷却且想念回涨过阈值 → 开口
            ok, st = longing.should_care(conn, "master", now=NOW + 3 * H)
            self.assertTrue(ok)
            self.assertAlmostEqual(st["threshold"], 7.0)
        finally:
            cleanup_conn(conn, d)

    def test_below_threshold(self):
        conn, d = conn_with_tables()
        try:
            seed_row(conn, value=3.0, anchor=NOW, updated=NOW)
            ok, st = longing.should_care(conn, "master", now=NOW)
            self.assertFalse(ok)
            self.assertAlmostEqual(st["value"], 3.0)
        finally:
            cleanup_conn(conn, d)

    def test_night_hold(self):
        """夜间憋话:想念照涨,开口憋到早上(23:00~08:00 本地时)。"""
        conn, d = conn_with_tables()
        try:
            night = time.mktime((2026, 9, 23, 23, 30, 0, 0, 0, -1))
            seed_row(conn, value=9.0, anchor=night, updated=night)
            ok, st = longing.should_care(conn, "master", now=night)
            self.assertFalse(ok)
            self.assertTrue(st.get("nightHold"))
            # 配置关掉夜间憋话 → 同一时刻开口
            conn.execute("DELETE FROM longing_state")
            seed_row(conn, value=9.0, anchor=night, updated=night)
            cfg = longing.merge_config({"nightHold": False})
            ok, st = longing.should_care(conn, "master", now=night, cfg=cfg)
            self.assertTrue(ok)
        finally:
            cleanup_conn(conn, d)

    def test_mood_modulated_threshold(self):
        """Steunebrink AAAI 2007:委屈+依赖越高阈值越低,下限 4.5。"""
        conn, d = conn_with_tables()
        try:
            self.assertAlmostEqual(
                longing.care_threshold(conn), 7.0)  # 无向量 → 基础值
            conn.execute(
                "INSERT INTO agent_state (session_id, emotion_vector,"
                " updated_at) VALUES ('s', ?, ?)",
                (json.dumps({"target_master": {"sadness": 6.0,
                                                "dependency": 6.0}}), NOW))
            conn.commit()
            # 7.0 − 0.25×12 = 4.0 → 钳到下限 4.5(防骚扰)
            self.assertAlmostEqual(longing.care_threshold(conn), 4.5)
        finally:
            cleanup_conn(conn, d)


class DueSnapshot(unittest.TestCase):
    """v0.19.0 D2:turn-stopping 的判定快照(「想念值≥阈值却没说出口」)。

    这是「想念必须表达」硬保证的证据面:壳侧只读 due/threshold,
    一切数学都在这儿。所以这里既要验"到阈值就打标",也要验
    "阈值与 should_care 同源"和"判定本身不落账"。
    """

    def test_below_threshold_not_due(self):
        conn, d = conn_with_tables()
        try:
            # 2026-09-27 live 的真值:4.23 —— 离 7.0 还远,不该催她说话
            seed_row(conn, value=4.233, anchor=NOW, updated=NOW)
            st = longing.due_snapshot(conn, "master", now=NOW)
            self.assertTrue(st["exists"])
            self.assertFalse(st["due"])
            self.assertAlmostEqual(st["threshold"], 7.0)
            self.assertAlmostEqual(st["value"], 4.233)
        finally:
            cleanup_conn(conn, d)

    def test_at_threshold_is_due(self):
        conn, d = conn_with_tables()
        try:
            seed_row(conn, value=7.0, anchor=NOW, updated=NOW)
            st = longing.due_snapshot(conn, "master", now=NOW)
            self.assertTrue(st["due"])  # 恰好等于也算到(≥)
            seed_row(conn, user_id="m2", value=7.6, anchor=NOW, updated=NOW)
            st2 = longing.due_snapshot(conn, "m2", now=NOW)
            self.assertTrue(st2["due"])
        finally:
            cleanup_conn(conn, d)

    def test_never_talked_not_due(self):
        """没聊过的人不该"想念"—— 库里没行 ⇒ exists=false,due=false。"""
        conn, d = conn_with_tables()
        try:
            st = longing.due_snapshot(conn, "master", now=NOW)
            self.assertFalse(st["exists"])
            self.assertFalse(st["due"])
        finally:
            cleanup_conn(conn, d)

    def test_threshold_same_math_as_care_gate(self):
        """阈值必须与 should_care 的判定一致(心境调制 + 4.5 下限)——
        「该主动开口」和「该说出口」不许是两套数。"""
        conn, d = conn_with_tables()
        try:
            seed_row(conn, value=5.2, anchor=NOW, updated=NOW)
            conn.execute(
                "INSERT INTO agent_state (session_id, emotion_vector,"
                " updated_at) VALUES ('s', ?, ?)",
                (json.dumps({"target_master": {"sadness": 6.0,
                                                "dependency": 6.0}}), NOW))
            conn.commit()
            st = longing.due_snapshot(conn, "master", now=NOW)
            self.assertAlmostEqual(st["threshold"], longing.care_threshold(conn))
            self.assertAlmostEqual(st["threshold"], 4.5)  # 7.0−0.25×12 → 钳下限
            self.assertTrue(st["due"])                     # 5.2 ≥ 4.5
        finally:
            cleanup_conn(conn, d)

    def test_decision_does_not_touch_care_bookkeeping(self):
        """判定不落账:care_count / last_care_at / anchor 一个都不许动
        (判定时看到的,就是 steer 的依据 —— 判一次不该改变什么)。"""
        conn, d = conn_with_tables()
        try:
            seed_row(conn, value=8.0, anchor=NOW, updated=NOW,
                     last_care=NOW - 600, care_count=3)
            st = longing.due_snapshot(conn, "master", now=NOW)
            self.assertTrue(st["due"])
            row = conn.execute(
                "SELECT care_count, last_care_at, anchor_at, kicked"
                " FROM longing_state WHERE user_id = 'master'").fetchone()
            self.assertEqual(int(row[0]), 3)
            self.assertAlmostEqual(float(row[1]), NOW - 600)
            self.assertAlmostEqual(float(row[2]), NOW)
            self.assertEqual(int(row[3]), 0)
            self.assertEqual(int(st["careCount"]), 3)
        finally:
            cleanup_conn(conn, d)

    def test_kicked_does_not_block_expression(self):
        """`kicked` 是"这次缺席的抗议尖峰已发过"的一次性标记,不是"别想他"
        —— 判定不拿它当闸(反倒说明她很想)。"""
        conn, d = conn_with_tables()
        try:
            seed_row(conn, value=8.0, anchor=NOW, updated=NOW, kicked=1)
            st = longing.due_snapshot(conn, "master", now=NOW)
            self.assertTrue(st["due"])
            self.assertEqual(int(st["kicked"]), 1)
        finally:
            cleanup_conn(conn, d)


class LongingFrames(unittest.TestCase):
    """帧往返:check/message/care/tick + 配置经帧携带。"""

    def test_frame_lifecycle(self):
        # 文件库::memory: 每帧一条新连接 = 一个新空库,跨帧状态不持久
        # (worker 每帧开/关连接,文件库才共享状态 —— 与生产同构)。
        d = tempfile.mkdtemp(prefix="echo-lng-frame-")
        db_path = str(Path(d) / "echo.db")
        Path(db_path).touch()  # 壳建库(worker 只验不建),空文件即合法空库
        h = WorkerHarness()
        try:
            ready = h.roundtrip(hello_frame(db_path=db_path))
            self.assertEqual(ready["type"], "ready")
            # 未聊过:全零,不开口
            r = h.roundtrip({"reqId": 2, "type": "longing_check",
                             "userId": "master"})
            self.assertEqual(r["type"], "longing_result")
            self.assertFalse(r["exists"])
            self.assertFalse(r["shouldCare"])
            # 首条消息建行(真初见:种在 now)
            r = h.roundtrip({"reqId": 3, "type": "longing_message",
                             "userId": "master", "text": "在吗",
                             "sessionId": "s1", "now": NOW})
            self.assertEqual(r["type"], "longing_message_result")
            self.assertTrue(r["ok"])
            # 沉默 8 小时:M(8h)=10·8/(8+3)=7.27 ≥ 7.0 → 该开口
            # (关夜间憋话保确定性;M(4h) 只有 5.71,过阈值要 ≥7h)
            r = h.roundtrip({"reqId": 4, "type": "longing_check",
                             "userId": "master", "now": NOW + 8 * H,
                             "config": {"nightHold": False}})
            self.assertTrue(r["exists"])
            self.assertGreaterEqual(r["value"], 7.0)
            self.assertTrue(r["shouldCare"])
            # 关怀已发出:×0.5,进入冷却
            r = h.roundtrip({"reqId": 5, "type": "longing_care",
                             "userId": "master", "now": NOW + 8 * H})
            self.assertEqual(r["type"], "longing_care_result")
            r = h.roundtrip({"reqId": 6, "type": "longing_check",
                             "userId": "master", "now": NOW + 8 * H + 60,
                             "config": {"nightHold": False}})
            self.assertFalse(r["shouldCare"])  # 值减半 + 冷却双闸
            # 新消息重置沉默 → 30 分钟后落在抗议窗口内,tick 补尖峰
            r = h.roundtrip({"reqId": 7, "type": "longing_message",
                             "userId": "master", "text": "我回来啦",
                             "now": NOW + 8 * H + 60})
            self.assertTrue(r["ok"])
            r = h.roundtrip({"reqId": 8, "type": "longing_tick",
                             "now": NOW + 8 * H + 60 + 1800})
            self.assertEqual(r["type"], "longing_tick_result")
            self.assertEqual(r["updated"], 1)
            r = h.roundtrip({"reqId": 9, "type": "longing_check",
                             "userId": "master",
                             "now": NOW + 8 * H + 60 + 1800,
                             "config": {"nightHold": False}})
            self.assertEqual(r["kicked"], 1)
        finally:
            h.close()
            shutil.rmtree(d, ignore_errors=True)

    def test_frame_message_pre_post(self):
        """v0.6.0 先读后削:longing_message 帧带回削减前后双值 ——
        pre = 她等你时攒下的想念(壳侧注入【想念】行用),post = 削减后。
        削减是值扣减不是清零(Hull:走心削满、敷衍削半,余温还在):
        「我回来啦」4 字 → factor=0.5+0.5·2/38,drop=msgDrop·factor。"""
        d = tempfile.mkdtemp(prefix="echo-lng-pre-")
        db_path = str(Path(d) / "echo.db")
        Path(db_path).touch()
        h = WorkerHarness()
        try:
            ready = h.roundtrip(hello_frame(db_path=db_path))
            self.assertEqual(ready["type"], "ready")
            # 首条消息建行(真初见:种在 now)
            r = h.roundtrip({"reqId": 2, "type": "longing_message",
                             "userId": "master", "text": "在吗",
                             "sessionId": "s1", "now": NOW})
            self.assertTrue(r["ok"])
            # 沉默 5 小时后回来:M(5h)=10·5/(5+3)=6.25;削减量全确定
            # (msgDrop 显式 4.0,4 字消息 factor=0.5+0.5·2/38)
            r = h.roundtrip({"reqId": 3, "type": "longing_message",
                             "userId": "master", "text": "我回来啦",
                             "now": NOW + 5 * H,
                             "config": {"msgDrop": 4.0}})
            self.assertEqual(r["type"], "longing_message_result")
            self.assertTrue(r["ok"])
            self.assertTrue(r["pre"]["exists"])
            self.assertTrue(r["post"]["exists"])
            # pre = 削减前:曲线在 5h 沉默给 6.25,沉默时长如实
            self.assertAlmostEqual(r["pre"]["value"], 6.25, delta=0.01)
            self.assertGreaterEqual(r["pre"]["sinceMessage"], 5 * H - 1)
            # post = 削减后:6.25 − 4.0·(0.5+0.5·2/38) ≈ 4.145
            drop = 4.0 * (0.5 + 0.5 * 2.0 / 38.0)
            self.assertAlmostEqual(r["post"]["value"], 6.25 - drop,
                                   delta=0.01)
            self.assertLess(r["post"]["value"], r["pre"]["value"])
        finally:
            h.close()
            shutil.rmtree(d, ignore_errors=True)

    def test_frame_validation(self):
        h = WorkerHarness()
        try:
            h.roundtrip(hello_frame(db_path=":memory:"))
            r = h.roundtrip({"reqId": 2, "type": "longing_check"})
            self.assertEqual(r["type"], "error")
            r = h.roundtrip({"reqId": 3, "type": "longing_message"})
            self.assertEqual(r["type"], "error")
        finally:
            h.close()


if __name__ == "__main__":
    unittest.main()
