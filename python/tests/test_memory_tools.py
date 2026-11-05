# -*- coding: utf-8 -*-
"""M3-b 记忆工具族测试:用户直教(remember)/ 遗忘(forget)/ 翻查(search)。

帧级往返走真实 worker 子进程(同 test_worker 契约);关键词派生与
遗忘不强化语义走引擎单测。设计要点:直教 = explicit/user_explicit
(Judge 信任权重最高档 —— 谁为这句话负责?用户自己);遗忘匹配绝不
强化目标(查到要忘的事不该让它活得更久)。
"""
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from engine import db, episodic, retrieve  # noqa: E402
from test_worker import WorkerHarness, hello_frame  # noqa: E402


class DeriveKeywords(unittest.TestCase):
    """确定性关键词派生:字母词 + CJK 二元滑窗(无 LLM 可问)。"""

    def test_mixed_text(self):
        kws = episodic.derive_keywords("我下周三有算法面试,要复习图论")
        # CJK 二元组:短查询「面试」靠它吃 hit_score 第一档
        self.assertIn("面试", kws)
        self.assertIn("图论", kws)
        self.assertIn("算法", kws)
        # 字母词整体保留
        kws2 = episodic.derive_keywords("他用 DeepSeek 写代码")
        self.assertIn("DeepSeek", kws2)
        # 去重 + 上限
        kws3 = episodic.derive_keywords("啊啊啊啊啊啊啊啊啊啊啊啊")
        self.assertEqual(len(kws3), len(set(kws3)))
        self.assertLessEqual(len(kws3), 12)
        # 空串安全
        self.assertEqual(episodic.derive_keywords(""), [])
        self.assertEqual(episodic.derive_keywords(None), [])


class RetrieveReadOnly(unittest.TestCase):
    """reinforce=False:遗忘前的匹配绝不能强化目标。"""

    def test_no_reinforce_no_write(self):
        with tempfile.TemporaryDirectory() as tmp:
            from engine import db as edb
            conn = edb.connect(str(Path(tmp) / "echo.db"))
            try:
                episodic.insert_memory(
                    conn, "master", '["面试"]', "他说下周有面试", 5,
                    intrinsic_value=50.0, layer="L2")
                before = conn.execute(
                    "SELECT recall_count, last_recalled, half_life"
                    " FROM episodic_memory").fetchone()
                items, reinforced = retrieve.retrieve(
                    conn, "master", "面试", 6, reinforce=False)
                self.assertEqual(len(items), 1)
                self.assertEqual(reinforced, 0)  # 关键:没写回
                after = conn.execute(
                    "SELECT recall_count, last_recalled, half_life"
                    " FROM episodic_memory").fetchone()
                self.assertEqual(before, after)
                # 对照:默认路径(翻记忆=想起)确实强化
                _, reinforced2 = retrieve.retrieve(conn, "master", "面试", 6)
                self.assertEqual(reinforced2, 1)
            finally:
                conn.close()


class MemoryToolFrames(unittest.TestCase):
    """帧级往返:教 → 翻 → 忘 → 再翻想不起。"""

    def _ready_worker(self, tmp):
        db_path = str(Path(tmp) / "echo.db")
        sqlite3.connect(db_path).close()  # 壳侧建库(worker 只验不建)
        w = WorkerHarness()
        ready = w.roundtrip(hello_frame(db_path=db_path))
        self.assertTrue(ready["db"]["ok"])
        return w, db_path

    def test_teach_search_forget_roundtrip(self):
        with tempfile.TemporaryDirectory() as tmp:
            w, db_path = self._ready_worker(tmp)
            try:
                add = w.roundtrip({"reqId": 2, "type": "memory_add",
                                   "userId": "master",
                                   "text": "我下周三有算法面试,要复习图论"})
                self.assertEqual(add["type"], "memory_add_result")
                self.assertGreater(add["memoryId"], 0)
                self.assertEqual(add["layer"], "L2")
                # 直教 = stability 稳定 → tier 1.0(AstrBot 权重表原语义:
                # 稳定事实=身份级)。I≈88:教过的记很久 —— 用户肯亲口
                # 教,就该比推断碎片(≈3)重一个数量级。
                self.assertGreater(add["I"], 60)
                self.assertIn("面试", add["keywords"])

                search = w.roundtrip({"reqId": 3, "type": "memory_search",
                                      "userId": "master", "query": "面试"})
                self.assertEqual(search["type"], "memory_search_result")
                self.assertEqual(len(search["items"]), 1)
                self.assertIn("算法面试", search["items"][0]["summary"])
                self.assertGreater(search["reinforced"], 0)  # 翻=想起=强化

                forget = w.roundtrip({"reqId": 4, "type": "memory_forget",
                                      "userId": "master", "query": "面试"})
                self.assertEqual(forget["type"], "memory_forget_result")
                self.assertTrue(forget["ok"])
                self.assertEqual(len(forget["forgotten"]), 1)

                search2 = w.roundtrip({"reqId": 5, "type": "memory_search",
                                       "userId": "master", "query": "面试"})
                self.assertEqual(len(search2["items"]), 0)  # 想不起了
                # 行留档不销毁:is_active=0(死历史,审计可查)
                conn = sqlite3.connect(db_path)
                try:
                    row = conn.execute(
                        "SELECT is_active FROM episodic_memory").fetchone()
                    self.assertEqual(row[0], 0)
                finally:
                    conn.close()
            finally:
                w.close()

    def test_core_layer_and_slot_supersede(self):
        with tempfile.TemporaryDirectory() as tmp:
            w, db_path = self._ready_worker(tmp)
            try:
                add1 = w.roundtrip({"reqId": 2, "type": "memory_add",
                                    "userId": "master", "slot": "fav_lang",
                                    "text": "我最喜欢的语言是 Python"})
                add2 = w.roundtrip({"reqId": 3, "type": "memory_add",
                                    "userId": "master", "slot": "fav_lang",
                                    "layer": "L0",
                                    "text": "我最喜欢的语言是 Rust"})
                self.assertEqual(add2["layer"], "L0")
                # L0 参照值 ≈ 88:身份级事实即使说得平淡也最重要
                self.assertGreater(add2["I"], 60)
                # 同 slot 换代:旧版本 is_active=0 + superseded_by 指新
                conn = sqlite3.connect(db_path)
                try:
                    old = conn.execute(
                        "SELECT is_active, superseded_by FROM episodic_memory"
                        " WHERE memory_id = ?", (add1["memoryId"],)).fetchone()
                    self.assertEqual(old[0], 0)
                    self.assertEqual(old[1], add2["memoryId"])
                finally:
                    conn.close()
                # 检索只见新版本(L0 强制占位)
                search = w.roundtrip({"reqId": 4, "type": "memory_search",
                                      "userId": "master", "query": "喜欢的语言"})
                self.assertEqual(len(search["items"]), 1)
                self.assertIn("Rust", search["items"][0]["summary"])
            finally:
                w.close()

    def test_forget_too_broad_refused(self):
        """匹配 >10 拒绝:防「忘掉一切」式误伤,要求说具体点。"""
        with tempfile.TemporaryDirectory() as tmp:
            w, db_path = self._ready_worker(tmp)
            conn = None
            try:
                # 直接铺 11 条同主题记忆(绕过帧,快)
                from engine import db as edb
                conn = edb.connect(db_path)
                for i in range(11):
                    episodic.insert_memory(
                        conn, "master", '["猫"]', f"用户说他的第{i}只猫很可爱", 5,
                        intrinsic_value=30.0, layer="L2")
                conn.close()
                conn = None
                forget = w.roundtrip({"reqId": 2, "type": "memory_forget",
                                      "userId": "master", "query": "猫"})
                self.assertEqual(forget["type"], "memory_forget_result")
                self.assertFalse(forget["ok"])
                self.assertEqual(forget["reason"], "too_broad")
                self.assertEqual(forget["matched"], 11)
            finally:
                if conn is not None:
                    conn.close()
                w.close()

    def test_missing_params_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            w, _ = self._ready_worker(tmp)
            try:
                r1 = w.roundtrip({"reqId": 2, "type": "memory_add",
                                  "userId": "master"})
                self.assertEqual(r1["type"], "error")
                r2 = w.roundtrip({"reqId": 3, "type": "memory_forget",
                                  "userId": "master", "query": "  "})
                self.assertEqual(r2["type"], "error")
                r3 = w.roundtrip({"reqId": 4, "type": "memory_search",
                                  "userId": "", "query": "x"})
                self.assertEqual(r3["type"], "error")
            finally:
                w.close()


class CleanupStale(unittest.TestCase):
    """v0.14.5 S9 记忆治理:超 TTL 且情感分 <6 软删;3×TTL 死行物理清。

    逐条对齐 A `echo_memory_engine._cleanup_stale_memories:1239-1257`。
    高分记忆**免死**是这个设计里最要紧的一条:情感分就是内在价值,
    「她最记得的事」不该因为放久了先被扔掉。
    """

    NOW = 1800000000.0  # 钉住时钟,别让测试随真实时间漂
    DAY = 86400.0

    def _conn(self, tmp):
        db_path = str(Path(tmp) / "echo.db")
        conn = sqlite3.connect(db_path)
        conn.executescript(
            """
            CREATE TABLE episodic_memory (
                memory_id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id TEXT NOT NULL, keywords TEXT NOT NULL, summary TEXT NOT NULL,
                emotion_score INTEGER NOT NULL, timestamp REAL NOT NULL,
                is_active INTEGER NOT NULL DEFAULT 1, source TEXT NOT NULL DEFAULT 'private',
                source_label TEXT DEFAULT '', actor TEXT DEFAULT '', speaker_id TEXT DEFAULT '',
                is_master INTEGER NOT NULL DEFAULT 1, intrinsic_value REAL DEFAULT 0.0,
                half_life REAL DEFAULT 0.0, recall_count INTEGER DEFAULT 0,
                last_recalled REAL DEFAULT 0.0, occurred_at REAL DEFAULT 0.0,
                learned_at REAL DEFAULT 0.0, temporal_status TEXT DEFAULT '',
                memory_key TEXT DEFAULT '', superseded_by INTEGER DEFAULT 0,
                layer TEXT DEFAULT '', status TEXT DEFAULT 'active', evidence TEXT DEFAULT ''
            );
            """
        )
        return conn, db_path

    def _add(self, conn, summary, score, age_days, active=1, user_id="master"):
        conn.execute(
            "INSERT INTO episodic_memory (user_id, keywords, summary, emotion_score,"
            " timestamp, is_active) VALUES (?, '[]', ?, ?, ?, ?)",
            (user_id, summary, score, self.NOW - age_days * self.DAY, active),
        )
        conn.commit()

    def test_ttl_semantics(self):
        with tempfile.TemporaryDirectory() as tmp:
            conn, _ = self._conn(tmp)
            try:
                self._add(conn, "过期的低分噪声", 3, age_days=31)      # 软删
                self._add(conn, "过期的低分噪声2", 5, age_days=100)     # 软删(且已死)
                self._add(conn, "过期但情感分高", 9, age_days=31)       # 免死
                self._add(conn, "旧但情感分刚好6", 6, age_days=31)      # 边界:不低于 6 → 免死
                self._add(conn, "昨天刚记的", 2, age_days=1)            # 未过期
                self._add(conn, "别人家的记忆", 1, age_days=99, user_id="other")
                # 一条早就死掉、且老过 3×TTL 的行(物理删)
                self._add(conn, "陈年死行", 1, age_days=120, active=0)

                removed = episodic.cleanup_stale(conn, "master", 30, now=self.NOW)
                self.assertEqual(removed, 2)  # 只数软删

                rows = {
                    r[0]: (r[1], r[2])
                    for r in conn.execute(
                        "SELECT summary, is_active, emotion_score FROM episodic_memory"
                    ).fetchall()
                }
                self.assertEqual(rows["过期的低分噪声"][0], 0)
                self.assertEqual(rows["过期但情感分高"][0], 1)
                self.assertEqual(rows["旧但情感分刚好6"][0], 1)
                self.assertEqual(rows["昨天刚记的"][0], 1)
                self.assertEqual(rows["别人家的记忆"][0], 1)  # 不越界删别人的
                # 软删行留档:31 天还没到 3×30=90 天的硬删线
                self.assertIn("过期的低分噪声", rows)
                # 120 天的死行被物理清掉了
                self.assertNotIn("陈年死行", rows)

                # 幂等:再扫一遍不会重复计数(该软删的已经 is_active=0)
                self.assertEqual(episodic.cleanup_stale(conn, "master", 30, now=self.NOW), 0)

                # 再过 60 天:上一轮软删的行越过 3×TTL → 物理清
                later = self.NOW + 61 * self.DAY
                episodic.cleanup_stale(conn, "master", 30, now=later)
                left = [r[0] for r in conn.execute("SELECT summary FROM episodic_memory")]
                self.assertNotIn("过期的低分噪声", left)
                self.assertIn("过期但情感分高", left)  # 高分记忆永远活着
            finally:
                conn.close()

    def test_ttl_protects_high_intrinsic_value(self):
        """F7:内在价值 ≥ 50 的记忆,TTL 也不许动(与 lib/cleanup-guard.js 同一条)。"""
        with tempfile.TemporaryDirectory() as tmp:
            conn, _ = self._conn(tmp)
            try:
                self._add(conn, "低分噪声", 3, age_days=31)
                # 同一把尺子的另一侧:iv 高、情感分低 —— 旧逻辑会把它清掉
                conn.execute(
                    "INSERT INTO episodic_memory (user_id, keywords, summary,"
                    " emotion_score, timestamp, is_active, intrinsic_value)"
                    " VALUES ('master', '[]', ?, ?, ?, 1, ?)",
                    ("高价值低情感", 2, self.NOW - 31 * self.DAY, 70.0),
                )
                # 边界:刚好 50 → 豁免(不低于)
                conn.execute(
                    "INSERT INTO episodic_memory (user_id, keywords, summary,"
                    " emotion_score, timestamp, is_active, intrinsic_value)"
                    " VALUES ('master', '[]', ?, ?, ?, 1, ?)",
                    ("刚好50", 2, self.NOW - 31 * self.DAY, 50.0),
                )
                conn.commit()

                removed = episodic.cleanup_stale(conn, "master", 30, now=self.NOW)
                self.assertEqual(removed, 1, "只该清掉那条低分噪声")
                rows = {r[0]: r[1] for r in conn.execute(
                    "SELECT summary, is_active FROM episodic_memory").fetchall()}
                self.assertEqual(rows["低分噪声"], 0)
                self.assertEqual(rows["高价值低情感"], 1, "iv≥50 是价值,不该被 TTL 抹掉")
                self.assertEqual(rows["刚好50"], 1)
            finally:
                conn.close()

    def test_ttl_floor_and_frame(self):
        with tempfile.TemporaryDirectory() as tmp:
            conn, db_path = self._conn(tmp)
            try:
                # ttl_days 脏值 → 下界 1 天(A 的 max(1, ...)),不是「一律清空」
                self._add(conn, "两小时前", 1, age_days=0.1)
                self.assertEqual(episodic.cleanup_stale(conn, "master", 0, now=self.NOW), 0)
                self.assertEqual(episodic.cleanup_stale(conn, "master", None, now=self.NOW), 0)
            finally:
                conn.close()

            # 帧级往返:壳侧每 cleanup_every 次写入叫一次
            w = WorkerHarness()
            try:
                ready = w.roundtrip(hello_frame(db_path=db_path))
                self.assertTrue(ready["db"]["ok"])
                r = w.roundtrip({"reqId": 2, "type": "episodic_cleanup",
                                 "userId": "master", "ttlDays": 30,
                                 "now": self.NOW})
                self.assertEqual(r["type"], "episodic_cleanup_result")
                self.assertEqual(r["removed"], 0)
                self.assertEqual(r["ttlDays"], 30)
                err = w.roundtrip({"reqId": 3, "type": "episodic_cleanup", "userId": ""})
                self.assertEqual(err["type"], "error")
            finally:
                w.close()


class ClearAllAndThreadActions(unittest.TestCase):
    """v0.15.1:G14 整库清空 + G15 人工话题动作(done / add)。

    A 的 `_clear_all:1273-1296` 只清情景记忆与画像 —— **别的一概不动**。
    这条边界必须被测试钉住:如果哪天有人「顺手」把图谱/话题也删了,
    那是一次没有确认过的额外破坏。
    """

    def _conn(self, tmp):
        db_path = str(Path(tmp) / "echo.db")
        conn = sqlite3.connect(db_path)
        conn.executescript(
            """
            CREATE TABLE episodic_memory (
                memory_id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id TEXT NOT NULL, keywords TEXT NOT NULL, summary TEXT NOT NULL,
                emotion_score INTEGER NOT NULL, timestamp REAL NOT NULL,
                is_active INTEGER NOT NULL DEFAULT 1, source TEXT NOT NULL DEFAULT 'private',
                source_label TEXT DEFAULT '', actor TEXT DEFAULT '', speaker_id TEXT DEFAULT '',
                is_master INTEGER NOT NULL DEFAULT 1, intrinsic_value REAL DEFAULT 0.0,
                half_life REAL DEFAULT 0.0, recall_count INTEGER DEFAULT 0,
                last_recalled REAL DEFAULT 0.0, occurred_at REAL DEFAULT 0.0,
                learned_at REAL DEFAULT 0.0, temporal_status TEXT DEFAULT '',
                memory_key TEXT DEFAULT '', superseded_by INTEGER DEFAULT 0,
                layer TEXT DEFAULT '', status TEXT DEFAULT 'active', evidence TEXT DEFAULT ''
            );
            CREATE TABLE user_profile (
                user_id TEXT NOT NULL, field_key TEXT NOT NULL, field_value TEXT DEFAULT '',
                confidence REAL DEFAULT 0.5, updated_at REAL DEFAULT 0,
                PRIMARY KEY (user_id, field_key)
            );
            CREATE TABLE pending_threads (
                thread_id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id TEXT NOT NULL, content TEXT NOT NULL, status TEXT DEFAULT 'open',
                follow_up_after REAL DEFAULT 0, source_memory_id INTEGER DEFAULT 0,
                session_id TEXT DEFAULT '', last_mentioned_at REAL DEFAULT 0,
                created_at REAL NOT NULL, updated_at REAL NOT NULL
            );
            CREATE TABLE audit_logs (
                trace_id TEXT PRIMARY KEY, session_id TEXT,
                user_input TEXT, timestamp REAL
            );
            """
        )
        return conn, db_path

    def _query(self, db_path, sql):
        """读一眼库(用完就关 —— Windows 上不关会让临时目录删不掉)。"""
        conn = sqlite3.connect(db_path)
        try:
            return conn.execute(sql).fetchall()
        finally:
            conn.close()

    def test_clear_all_scope(self):
        with tempfile.TemporaryDirectory() as tmp:
            conn, _ = self._conn(tmp)
            try:
                for i in range(3):
                    conn.execute(
                        "INSERT INTO episodic_memory (user_id, keywords, summary,"
                        " emotion_score, timestamp) VALUES ('master','[]',?,5,1.0)",
                        ("记忆" + str(i),),
                    )
                conn.execute(
                    "INSERT INTO episodic_memory (user_id, keywords, summary,"
                    " emotion_score, timestamp) VALUES ('other','[]','别人的',5,1.0)"
                )
                conn.execute(
                    "INSERT INTO user_profile (user_id, field_key, field_value)"
                    " VALUES ('master','name','阿岚')"
                )
                conn.execute(
                    "INSERT INTO user_profile (user_id, field_key, field_value)"
                    " VALUES ('other','name','别人')"
                )
                conn.execute(
                    "INSERT INTO pending_threads (user_id, content, created_at, updated_at)"
                    " VALUES ('master','面试',1.0,1.0)"
                )
                conn.execute("INSERT INTO audit_logs (trace_id, user_input) VALUES ('t1','x')")
                conn.commit()

                stats = episodic.clear_all(conn, "master")
                self.assertEqual(stats, {"episodic": 3, "profile": 1})
                left = [
                    r[0] for r in conn.execute(
                        "SELECT summary FROM episodic_memory").fetchall()
                ]
                self.assertEqual(left, ["别人的"], "只清自己那份,不碰别人的")
                self.assertEqual(
                    conn.execute("SELECT COUNT(*) FROM user_profile WHERE user_id='master'")
                    .fetchone()[0], 0)
                # 图谱/话题/审计不在这一步的范围内(A 同):清库不许偷偷扩大
                self.assertEqual(
                    conn.execute("SELECT COUNT(*) FROM pending_threads").fetchone()[0], 1)
                self.assertEqual(
                    conn.execute("SELECT COUNT(*) FROM audit_logs").fetchone()[0], 1)

                # 空 user_id → 什么都不做(绝不当成「删全部」)
                self.assertEqual(episodic.clear_all(conn, ""), {"episodic": 0, "profile": 0})
                # (v0.29.0:include_members「连群友隔离空间一起清」随群聊退役 ——
                #  单用户形态下它本来就是同一次清理,参数删掉了。)
            finally:
                conn.close()

    def test_clear_and_thread_frames(self):
        with tempfile.TemporaryDirectory() as tmp:
            conn, db_path = self._conn(tmp)
            try:
                conn.execute(
                    "INSERT INTO user_profile (user_id, field_key, field_value)"
                    " VALUES ('master','name','阿岚')")
                conn.commit()
            finally:
                conn.close()

            w = WorkerHarness()
            try:
                ready = w.roundtrip(hello_frame(db_path=db_path))
                self.assertTrue(ready["db"]["ok"])

                # G14 没有 confirm 一律拒收(确认是两层里的一道,不许省)
                err = w.roundtrip({"reqId": 2, "type": "episodic_clear", "userId": "master"})
                self.assertEqual(err["type"], "error")
                self.assertIn("confirm", err["error"])
                r = w.roundtrip({"reqId": 3, "type": "episodic_clear",
                                 "userId": "master", "confirm": True})
                self.assertEqual(r["type"], "episodic_clear_result", str(r))
                self.assertEqual(r["profile"], 1)
                # (v0.29.0:includeMembers 回执字段随群聊退役,帧上不再有)

                # G15 登记:手工加的不带时间(follow_up_after=0 → 永不主动提)
                a = w.roundtrip({"reqId": 4, "type": "threads_add",
                                 "userId": "master", "content": "下个月去看樱花"})
                self.assertEqual(a["type"], "threads_add_result")
                self.assertTrue(a["threadId"] > 0)
                self.assertTrue(a["created"])
                row = self._query(db_path,
                                  "SELECT content, follow_up_after FROM pending_threads")[0]
                self.assertEqual(row[0], "下个月去看樱花")
                self.assertEqual(row[1], 0)

                # G15 结掉:同一把尺子(双向子串),没匹配上就如实回 0
                d = w.roundtrip({"reqId": 5, "type": "threads_done",
                                 "userId": "master", "query": "樱花"})
                self.assertEqual(d["type"], "threads_done_result")
                self.assertEqual(d["threadId"], a["threadId"])
                miss = w.roundtrip({"reqId": 6, "type": "threads_done",
                                    "userId": "master", "query": "完全不相关的事"})
                self.assertIsNone(miss["threadId"])
                self.assertEqual(
                    self._query(db_path, "SELECT status FROM pending_threads")[0][0],
                    "resolved")
                # 缺 userId 的两条都拒收
                self.assertEqual(
                    w.roundtrip({"reqId": 7, "type": "threads_add", "content": "x"})["type"],
                    "error")
                self.assertEqual(
                    w.roundtrip({"reqId": 8, "type": "threads_done", "query": "x"})["type"],
                    "error")
            finally:
                w.close()


class BackfillLegacyColumns(unittest.TestCase):
    """v0.15.1 G20:老库回填(A `echo_schema.py:277-301`)。

    本仓**只回填 learned_at**(用 timestamp:写入时间就是得知时间)。
    layer 那条刻意收窄:空 layer 在 DSH 不等于老行(JS 基线写记忆默认
    留空),常开会让新写的高 I 记忆被误升 L0 —— L0 是每轮强制注入的
    核心记忆,那等于把普通碎片抬成「她永远记得的事」(实测踩到)。
    layer 回填搬去了导入器(按 source='qq' 圈定本次导入的行)。
    """

    def test_backfill_learned_at_only(self):
        with tempfile.TemporaryDirectory() as tmp:
            db_path = str(Path(tmp) / "legacy.db")
            conn = sqlite3.connect(db_path)
            conn.executescript(
                """
                CREATE TABLE episodic_memory (
                    memory_id INTEGER PRIMARY KEY AUTOINCREMENT,
                    user_id TEXT NOT NULL, keywords TEXT NOT NULL, summary TEXT NOT NULL,
                    emotion_score INTEGER NOT NULL, timestamp REAL NOT NULL,
                    is_active INTEGER NOT NULL DEFAULT 1, intrinsic_value REAL DEFAULT 0.0,
                    learned_at REAL DEFAULT 0.0, layer TEXT DEFAULT ''
                );
                INSERT INTO episodic_memory
                    (user_id, keywords, summary, emotion_score, timestamp, intrinsic_value, learned_at, layer)
                VALUES ('master','[]','高分无层',9,1000.0,88.6,0,''),
                       ('master','[]','已有得知时间',3,2000.0,20.0,1500.0,'L1'),
                       ('master','[]','零时间戳',3,0,20.0,0,'');
                """
            )
            conn.commit()
            conn.close()

            # 引擎 connect() = schema 就绪(含回填)
            conn = db.connect(db_path, must_exist=True)
            try:
                rows = {
                    r[0]: (r[1], r[2]) for r in conn.execute(
                        "SELECT summary, learned_at, layer FROM episodic_memory")
                }
                self.assertEqual(rows["高分无层"], (1000.0, ""),
                                 "layer 不许被猜成 L0 —— 这条回填只在导入器里做")
                self.assertEqual(rows["已有得知时间"], (1500.0, "L1"), "已有值不覆盖")
                self.assertEqual(rows["零时间戳"][0], 0.0, "timestamp=0 不回填")
                # 幂等:再连一次结果不变
                conn.close()
                conn = db.connect(db_path, must_exist=True)
                again = {
                    r[0]: (r[1], r[2]) for r in conn.execute(
                        "SELECT summary, learned_at, layer FROM episodic_memory")
                }
                self.assertEqual(again, rows)
                # 索引建齐(缺列的会被带保护的建索引跳过,见下一条测试)
                names = {r[0] for r in conn.execute(
                    "SELECT name FROM sqlite_master WHERE type='index'")}
                for idx in ("idx_graph_edge_src", "idx_graph_edge_slot",
                            "idx_graph_edge_owner"):
                    self.assertIn(idx, names)
            finally:
                conn.close()


if __name__ == "__main__":
    unittest.main()
