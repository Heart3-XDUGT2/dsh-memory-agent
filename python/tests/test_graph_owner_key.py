# -*- coding: utf-8 -*-
"""`get_or_create_node` 的归属写入单测 —— 阶段 2d(2026-10-01)。

背景:`python/engine/graph.py` 的 `get_or_create_node` 此前 INSERT 列表里
**没有 `owner_key`** ⇒ 引擎现场新建的每个节点 `owner_key` 都是 NULL
(实测活库 28 个节点里 5 个 NULL:`音理` / `舞萌` / `计算机大类` /
`老乡鸡的梅菜扣肉` / `麦当劳随心配1+1`)。老行的回填**不在本函数内**,
归 `scripts/graph-owner-key-backfill.mjs`(默认 dry-run)。

本文件只钉住四件事:
  1. 新建节点 `owner_key` **不是 NULL**,且缺省 = `"master"`;
  2. `owner_key` 是**显式入参** —— 传进去就写进去(与 `add_edge` 同风格);
  3. **既有调用点零变化** —— `add_edge(conn, s, rel, t, owner)` 不改一个字,
     建出来的节点照样有归属(走默认值),`add_edge` 自身行为逐位不变;
  4. **不改老行** —— 命中已有节点只刷新 `last_accessed`,`owner_key` 不动
     (回填是"改",必须显式批准)。

口径:`docs/PLAN_MEMORY_GRAPH_ACTION.md` §11-14。
全程**临时库**(`db.connect` 走真实迁移)。"没碰活库"这条**不靠活库的绝对状态**
(宿主一直往活库写 WAL,mtime 会随机变):改成记录本用例**打开过的库路径**,
断言其中不含 `LIVE_DB` —— 只断言不变量与差量(照 `test_graph_gate.py`)。
"""
import os
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from engine import db, graph  # noqa: E402

LIVE_DB = Path(os.path.expanduser("~")) / ".dsh" / "echo" / "echo.db"


def live_opened(opened, live=LIVE_DB):
    """`opened` 里指向活库的那些路径(空列表 = 干净)。

    只比**路径**(`realpath`),不读任何活库状态 ⇒ 宿主怎么在后台写都不会误报。
    """
    want = os.path.realpath(str(live))
    out = []
    for p in opened or ():
        try:
            got = os.path.realpath(str(p))
        except (TypeError, ValueError, OSError):
            continue
        if got == want:
            out.append(str(p))
    return out


def fresh_conn():
    """临时库 + 走真实迁移(与引擎同一条路)。"""
    tmp = tempfile.TemporaryDirectory()
    conn = db.connect(str(Path(tmp.name) / "echo.db"))
    return tmp, conn


def _owner_of(conn, node_id):
    return conn.execute(
        "SELECT owner_key FROM graph_nodes WHERE node_id = ?", (node_id,)
    ).fetchone()[0]


class NewNodeOwnerKey(unittest.TestCase):
    """新建节点必须带归属(不再留 NULL)。"""

    def setUp(self):
        self.tmp, self.conn = fresh_conn()
        self.addCleanup(self.tmp.cleanup)
        self.addCleanup(self.conn.close)

    def test_default_owner_key_is_master_not_null(self):
        nid = graph.get_or_create_node(self.conn, "阶段2d新节点")
        owner = _owner_of(self.conn, nid)
        self.assertIsNotNone(owner, "新建节点的 owner_key 不许是 NULL")
        self.assertEqual(str(owner), "master")

    def test_node_type_default_still_concept(self):
        """阶段 1a 的 node_type 缺省行为**不许被这次改动碰掉**。"""
        nid = graph.get_or_create_node(self.conn, "阶段2d普通节点")
        row = self.conn.execute(
            "SELECT node_type, owner_key FROM graph_nodes WHERE node_id = ?", (nid,)
        ).fetchone()
        self.assertEqual(str(row[0]), "concept")
        self.assertEqual(str(row[1]), "master")

    def test_owner_key_is_explicit_parameter(self):
        """显式入参 ⇒ 写进去(不吞、不回落到默认)。"""
        nid = graph.get_or_create_node(self.conn, "阶段2d影子端点", "concept",
                                       "__shadow__")
        self.assertEqual(str(_owner_of(self.conn, nid)), "__shadow__")

    def test_owner_key_keyword_and_positional(self):
        a = graph.get_or_create_node(self.conn, "位置参节点", "episode", "someone")
        b = graph.get_or_create_node(self.conn, "关键字节点", owner_key="someone2")
        self.assertEqual(str(_owner_of(self.conn, a)), "someone")
        self.assertEqual(str(_owner_of(self.conn, b)), "someone2")

    def test_alias_hit_path_also_writes_owner(self):
        """别名的规范名落地时同样带归属(走的还是同一条 INSERT)。"""
        self.conn.execute(
            "INSERT INTO graph_aliases (alias, canonical_name, source)"
            " VALUES ('西电', '西安电子科技大学', 'test')"
        )
        self.conn.commit()
        nid = graph.get_or_create_node(self.conn, "西电")
        row = self.conn.execute(
            "SELECT name, owner_key FROM graph_nodes WHERE node_id = ?", (nid,)
        ).fetchone()
        self.assertEqual(str(row[0]), "西安电子科技大学")
        self.assertEqual(str(row[1]), "master")

    def test_blank_owner_falls_back_to_master(self):
        """空串/None 不许写空 —— 否则等于换了个形状的 NULL。"""
        for name, o in (("空串节点", ""), ("None节点", None)):
            nid = graph.get_or_create_node(self.conn, name, "concept", o)
            self.assertEqual(str(_owner_of(self.conn, nid)), "master")

    def test_no_null_owner_rows_at_all(self):
        """本函数建完之后,库里一个 NULL 归属都不该有。"""
        for n in ("甲", "乙", "丙"):
            graph.get_or_create_node(self.conn, n)
        cnt = self.conn.execute(
            "SELECT COUNT(*) FROM graph_nodes"
            " WHERE owner_key IS NULL OR owner_key = ''"
        ).fetchone()[0]
        self.assertEqual(int(cnt), 0)


class ExistingCallsitesUnchanged(unittest.TestCase):
    """既有调用点零变化:不传新参 ⇒ 行为兼容。"""

    def setUp(self):
        self.tmp, self.conn = fresh_conn()
        self.addCleanup(self.tmp.cleanup)
        self.addCleanup(self.conn.close)

    def test_add_edge_two_arg_form_still_works(self):
        """`add_edge` 内那两处 `get_or_create_node(conn, s/t)` 一个字没改。"""
        graph.add_edge(self.conn, "校园跑", "相关", "章鱼小丸子", "master")
        rows = self.conn.execute(
            "SELECT n.name, n.owner_key FROM graph_nodes n ORDER BY n.name"
        ).fetchall()
        self.assertEqual(len(rows), 2)
        for name, owner in rows:
            self.assertIn(str(name), ("校园跑", "章鱼小丸子"))
            self.assertEqual(str(owner), "master",
                             "既有调用点不传新参 ⇒ 走默认 master,不是 NULL")
        self.assertEqual(self.conn.execute(
            "SELECT COUNT(*) FROM graph_edges"
        ).fetchone()[0], 1)

    def test_hit_path_does_not_backfill_owner(self):
        """命中已有节点 = 只刷新 last_accessed;`owner_key` **不动**(回填要单独批)。"""
        self.conn.execute(
            "INSERT INTO graph_nodes (node_id, name, node_type, last_accessed)"
            " VALUES ('legacy0000000001', '历史NULL节点', 'concept', 1.0)"
        )
        self.conn.commit()
        self.assertIsNone(_owner_of(self.conn, "legacy0000000001"))
        nid = graph.get_or_create_node(self.conn, "历史NULL节点", "concept", "master")
        self.assertEqual(nid, "legacy0000000001", "同名命中,不许另建")
        self.assertIsNone(_owner_of(self.conn, nid),
                          "命中路径不许顺手回填 —— 那是'改',归 backfill 脚本")
        self.assertEqual(self.conn.execute(
            "SELECT COUNT(*) FROM graph_nodes WHERE name = '历史NULL节点'"
        ).fetchone()[0], 1)


class TempDbOnly(unittest.TestCase):
    """本用例**打开过的库路径**里不许有活库 —— 断言不变量,不看活库绝对状态。

    为什么不用"活库 `st_mtime_ns` 前后不变":宿主进程一直往活库写(WAL),
    任何一次宿主写入都会让那条断言**随机转红**;而且它证明的其实是"本用例
    没写活库",不是"活库没变" —— 口径也错。
    这里改成**记录本用例打开过的库路径**再断言其中不含 `LIVE_DB`
    (照 `test_graph_gate.py` 的纪律:只许断言不变量与差量)。
    """

    def test_temp_db_only(self):
        opened = []
        real_connect = db.connect

        def spy(path, *a, **kw):
            opened.append(str(path))
            return real_connect(path, *a, **kw)

        with mock.patch.object(db, "connect", side_effect=spy):
            tmp, conn = fresh_conn()
            # LIFO:先登记的 cleanUp 后跑 ⇒ 先关连接、再删临时目录
            self.addCleanup(tmp.cleanup)
            self.addCleanup(conn.close)
            graph.get_or_create_node(conn, "隔离探针")
            self.assertEqual(str(_owner_of(conn, graph.get_or_create_node(
                conn, "隔离探针2"))), "master")
            # 顺带把既有写边路径也走一遍(它内部那两处 get_or_create_node 不传新参)
            graph.add_edge(conn, "隔离甲", "相关", "隔离乙", "master")
            row = conn.execute(
                "SELECT node_id, owner_key FROM graph_nodes WHERE name = '隔离乙'"
            ).fetchone()
            self.assertEqual(str(row[1]), "master")

        # ① 负控:钩子必须真的抓到调用 —— 抓到 0 个 ⇒ 这条用例什么都没证明
        self.assertTrue(opened, "钩子没抓到任何 db.connect 调用 ⇒ 负控失效")
        # ② 不变量:一个都不许指向活库
        self.assertEqual(live_opened(opened), [],
                         "本用例打开了活库: %r" % (live_opened(opened),))
        # ③ 差量:全部落在临时目录里(与活库的父目录不同)
        live_dir = os.path.realpath(str(LIVE_DB.parent))
        for p in opened:
            self.assertNotEqual(os.path.realpath(str(Path(p).parent)), live_dir,
                                "db.connect 拿到了活库目录下的路径: " + str(p))


class LivePathGuardHasTeeth(unittest.TestCase):
    """负控:`live_opened()` 真的认得出活库路径 —— 否则上面那条断言是空转。"""

    def test_detects_live_and_ignores_temp(self):
        # (a) 纯路径:活库路径必须被点名
        self.assertEqual(live_opened([str(LIVE_DB)], live=LIVE_DB), [str(LIVE_DB)])
        # (b) 等价性:把"活库"换成临时 decoy,机制照样认得出(不碰真活库)
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        decoy = Path(tmp.name) / "echo.db"
        conn = db.connect(str(decoy))          # 真连接,但落在临时目录
        conn.close()
        self.assertEqual(live_opened([str(decoy)], live=decoy), [str(decoy)])
        # (c) 反向:临时路径**不许**被误报(否则这条守卫会把好人抓进去)
        self.assertEqual(live_opened([str(decoy)], live=LIVE_DB), [])
        self.assertEqual(live_opened(["relative/echo.db"], live=LIVE_DB), [])


if __name__ == "__main__":
    unittest.main()
