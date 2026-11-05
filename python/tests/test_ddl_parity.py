"""两边 DDL 必须同源 —— 这条不变量的自动化守卫(v0.17.1 补)。

`docs/CORE_IN_DSH_PLAN.md` 与 `docs/RELAY_PLAN.md` 都把它写成硬规矩:
**任何一个进程先连上库,库的形状都必须一样**(测试库、新装机尤其明显)。
在此之前它只是两处注释里的君子协定 —— 传话桥三张表是 R2 新加的,最容易被改一边
忘一边。这个测试把「同源」变成会红的灯:

- 传话三表(**纯镜像**):列名/类型/非空/主键/默认值**逐项相等**,多一列少一列都算漂;
- 其余共有的表:JS 那一列必须是引擎列的子集(引擎有「扩展列」是**设计**,
  见 `db.py` 的 `_ensure_indexes`/`_migrate_*`;JS 有而引擎没有才是漂);
- JS DDL 建的表与索引,引擎库里必须都在(反过来允许:引擎有 AstrBot 侧的历史表)。

跑法:`C:\\Python314\\python.exe -B -m unittest discover -s python\\tests -p "test_*.py"`
"""

from __future__ import annotations

import re
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from engine import db  # noqa: E402

REPO = Path(__file__).resolve().parents[2]
STORE_JS = REPO / "lib" / "store.js"
# 传话桥三张表:引擎不读写它们,建它们**只为**这条不变量成立 ⇒ 必须逐列相等
MIRROR_TABLES = ("relay_channels", "relay_outbox", "relay_inbox_seen")
# 只有壳侧创建的表(设计如此:`db.py` 开头写着「库文件与基表由 JS 壳负责创建;
# worker 永不建库文件(must_exist 守卫)」)。`user_profile` 引擎会**读**
# (judge 取称呼、episodic 的 /mem_clear 删行),但它由壳建 —— 所以这里列成
# 精确集合:哪天有人新增一张 JS-only 表却忘了进这个名单,灯就红。
JS_ONLY_TABLES = {"conversation_log", "diary", "user_profile", "care_beats", "echo_wakes"}
# ↑ 2026-09-28 夜补(P2 的账本与闹钟):`care_beats`(她主动开口的台账)与
#   `echo_wakes`(她自己排的闹钟)**只活在壳侧**,引擎不该碰 —— 这两张表存在的
#   意义就是"引擎不在也照常记账、到点照响"(P2 设计);引擎去读写它们,反而会把
#   "她主动开口"这条链重新绑回引擎。加进来是有意的,不是漏。


def js_ddl_text() -> str:
    """从 `lib/store.js` 里抠出 `const DDL = \\`…\\`` 那段(该模板无插值)。"""
    text = STORE_JS.read_text(encoding="utf-8")
    marker = "const DDL = `"
    start = text.index(marker) + len(marker)
    end = text.index("`", start)
    return text[start:end]


def columns_of(conn: sqlite3.Connection, table: str) -> list[tuple]:
    """(列名, 类型, 非空, 默认值, 主键位次) —— 默认值去掉引号比,免得 '1' 与 1 假红。"""
    rows = conn.execute(f'PRAGMA table_info("{table}")').fetchall()
    out = []
    for _cid, name, ctype, notnull, dflt, pk in rows:
        norm = "" if dflt is None else str(dflt).strip().strip("'\"")
        out.append((str(name), str(ctype or "").upper(), int(notnull or 0), norm, int(pk or 0)))
    return out


def names_of(conn: sqlite3.Connection, kind: str) -> set[str]:
    rows = conn.execute(
        "SELECT name FROM sqlite_master WHERE type = ? AND name NOT LIKE 'sqlite_%'", (kind,)
    ).fetchall()
    return {str(r[0]) for r in rows}


class DdlParityTest(unittest.TestCase):
    """JS DDL 与引擎 DDL 同源(传话三表逐列相等)。"""

    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        root = Path(cls.tmp.name)
        # ① 引擎侧:走它真实的 connect(建表 + 迁移 + 索引)
        cls.engine_path = root / "engine.db"
        conn = db.connect(str(cls.engine_path))
        conn.commit()
        conn.close()
        cls.engine = sqlite3.connect(str(cls.engine_path))
        # ② JS 侧:把 store.js 的 DDL 原样喂给 sqlite
        cls.js_path = root / "js.db"
        js = sqlite3.connect(str(cls.js_path))
        js.executescript(js_ddl_text())
        js.commit()
        cls.js = js
        cls.js_tables = names_of(cls.js, "table")
        cls.engine_tables = names_of(cls.engine, "table")

    @classmethod
    def tearDownClass(cls):
        cls.js.close()
        cls.engine.close()
        cls.tmp.cleanup()

    def test_js_ddl_is_real(self):
        # 防「正则抠空了所以全绿」这种假通过
        self.assertGreaterEqual(len(self.js_tables), 10, "store.js 的 DDL 没抠出来?")
        self.assertIn("episodic_memory", self.js_tables)

    def test_engine_covers_every_js_table_and_index(self):
        """引擎可以少建「壳侧专属」的表,但必须是**这份名单**,不许悄悄多一张。"""
        js_only = self.js_tables - self.engine_tables
        self.assertEqual(
            sorted(js_only), sorted(JS_ONLY_TABLES),
            "壳侧专属表的名单变了:要么补进 JS_ONLY_TABLES(并说明为什么引擎不需要它),"
            "要么把它加进 engine/db.py 的 _DDL"
        )
        js_indexes = names_of(self.js, "index")
        engine_indexes = names_of(self.engine, "index")
        missing = []
        for name in sorted(js_indexes - engine_indexes):
            row = self.js.execute(
                "SELECT tbl_name FROM sqlite_master WHERE type = 'index' AND name = ?", (name,)
            ).fetchone()
            table = str(row[0]) if row else ""
            # 建在壳侧专属表上的索引,跟着那张表一起豁免(见 JS_ONLY_TABLES)
            if table in JS_ONLY_TABLES:
                continue
            missing.append((name, table))
        self.assertEqual(missing, [], "引擎缺索引(非壳侧专属表):" + repr(missing))

    def test_mirror_tables_are_column_identical(self):
        for table in MIRROR_TABLES:
            with self.subTest(table=table):
                self.assertIn(table, self.js_tables, f"{table} 不在 store.js 的 DDL 里")
                self.assertIn(table, self.engine_tables, f"{table} 不在 engine/db.py 的 _DDL 里")
                js_cols = columns_of(self.js, table)
                engine_cols = columns_of(self.engine, table)
                self.assertEqual(
                    js_cols, engine_cols,
                    f"{table} 两边列不一致\n  js     = {js_cols}\n  engine = {engine_cols}"
                )

    def test_shared_tables_engine_is_superset(self):
        """引擎可以有扩展列(设计如此),但**不能少** JS 的列。"""
        for table in sorted(self.js_tables & self.engine_tables):
            with self.subTest(table=table):
                js_names = {c[0] for c in columns_of(self.js, table)}
                engine_names = {c[0] for c in columns_of(self.engine, table)}
                self.assertEqual(
                    sorted(js_names - engine_names), [],
                    f"{table}: 引擎少了 JS 的列(引擎可以有扩展列,不能少列)"
                )

    def test_mirror_tables_have_expected_columns(self):
        """钉住 R2 的三张表形状本身(改 DDL 时必须**同时**改这里,即「有意变更」)。"""
        expected = {
            "relay_channels": [
                "platform", "chat_id", "chat_type", "chat_title", "session_id", "label",
                "proactive", "is_primary", "enabled", "last_in_at", "last_out_at",
                "last_error", "created_at",
            ],
            "relay_outbox": [
                "out_id", "platform", "chat_id", "session_id", "turn_id", "kind", "text",
                "created_at", "expires_at", "leased_until", "acked_at", "dropped_at",
                # v0.18.0 气泡分条(A 侧 split_bubbles 移植):这四列是**有意变更**,
                # 与 lib/store.js 的 DDL 和 db.py 一起改的。
                "not_before", "group_id", "seq", "canceled_at",
            ],
            "relay_inbox_seen": ["platform", "msg_id", "state", "session_id", "seen_at"],
        }
        for table, cols in expected.items():
            with self.subTest(table=table):
                self.assertEqual([c[0] for c in columns_of(self.js, table)], cols)
                self.assertEqual([c[0] for c in columns_of(self.engine, table)], cols)

    def test_pending_threads_lifecycle_columns(self):
        """D1(2026-10-06):悬置话题的生命周期四列 —— **有意变更**,两侧必须都有。

        (这条是"改 DDL 时必须同时改这里"的那种钉子;真正的同源判定在上面的
        `test_shared_tables_engine_is_superset` —— JS 加了引擎不加,那盏灯就红。)
        """
        want = ["kind", "cooling_at", "archived_at", "superseded_by"]
        for conn, label in ((self.js, "js(store.js)"), (self.engine, "engine(db.py)")):
            cols = [c[0] for c in columns_of(conn, "pending_threads")]
            for name in want:
                self.assertIn(name, cols, label + " 的 pending_threads 少了 " + name)

    def test_comparator_catches_drift(self):
        """先证明这盏灯会亮:故意抠掉一列,比较必须发现 —— 只会全绿的守卫等于没有。"""
        tampered = sqlite3.connect(":memory:")
        # 抠一列但不能抠到索引上(dropped_at 在 idx_relay_outbox_lease 里)——
        # 这里拿 expires_at 开刀:它不被任何索引引用。
        ddl = re.sub(r"\n\s*expires_at\s+REAL DEFAULT 0[^\n]*", "", js_ddl_text(), count=1)
        self.assertNotEqual(ddl, js_ddl_text(), "夹具没改到东西,这条测试本身失效了")
        tampered.executescript(ddl)
        self.assertNotEqual(
            columns_of(tampered, "relay_outbox"), columns_of(self.engine, "relay_outbox"),
            "少了一列居然比出来相等 —— 比较函数坏了"
        )
        tampered.close()

    def test_busy_timeout_pragma_is_documented_in_both(self):
        """两边的 busy_timeout 承诺必须一致(共享灵魂库靠它多进程并发安全)。

        只断言「有且是 5000」,不打印整份源码 —— assertIn 失败会把 60KB 的
        文件内容全吐出来,排障反而变难。
        """
        store_text = STORE_JS.read_text(encoding="utf-8")
        engine_text = (REPO / "python" / "engine" / "db.py").read_text(encoding="utf-8")
        pattern = re.compile(r"busy_timeout\s*=\s*5000")
        self.assertTrue(pattern.search(store_text), "store.js 里没有 busy_timeout = 5000")
        self.assertTrue(pattern.search(engine_text), "db.py 里没有 busy_timeout = 5000")


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
