# -*- coding: utf-8 -*-
"""阶段 3a 第一步(同记忆共现候选挖掘)单测。

覆盖:
  MatcherScope      —— 匹配池口径:剔除"名字本身是别名键"的重名节点;**不展开别名串**
  HitScope          —— 只认**既有概念节点**(concept/person),绝不建节点
  PairMining        —— 同记忆两两成对:count/evidence/weight 语义
  TwoSidedEvidence  —— 两端记忆集的不变式(交集 = 证据)+ **R2 为什么必须拿到它**
  TimeSource        —— occurred_at 只从 episodic_memory 取,取不到 ⇒ null
  DryRunAndCli      —— dry-run 只读(文件 sha 不变)、CLI 拒绝写、挖掘无写库 SQL
  历史快照的五条控制已移至 python/manual/verify_snapshot.py，默认不执行
"""
import contextlib
import hashlib
import json
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from engine import db, graph, graph_gate as gate, graph_mine as mine  # noqa: E402

REPO = Path(__file__).resolve().parents[2]
OWNER = "test-owner"

# ── P1 收口(拍板 3):离线 `dry_run(names=...)` 有了**入参口子**,形状与引擎帧一致。
# 契约基线是在"旧内置名单"下钉的 ⇒ 测试把那份名单**显式喂回去**,让数字与被替换掉的
# 那份硬编码逐字一致(不再靠改模块全局 `gate.SPEAKER_NODES`)。
LEGACY_SPEAKERS = ("用户", "阿岚", "她", "Echo", "助手")
LEGACY_PERSON_NAMES = LEGACY_SPEAKERS + ("阿乙", "阿岚")
LEGACY_FRAME_NAMES = {"speakers": list(LEGACY_SPEAKERS),
                      "personNames": list(LEGACY_PERSON_NAMES)}

NODES = [
    ("n_user", "用户", "concept"),
    ("n_echo", "Echo", "concept"),
    ("n_run", "校园跑", "concept"),
    ("n_tako", "章鱼小丸子", "concept"),
    ("n_xdu", "西安电子科技大学", "concept"),
    ("n_xd", "西电", "concept"),           # 名字本身是别名键 ⇒ 不进匹配池
    ("n_mem", "某条记忆", "episode"),       # 不是概念端点 ⇒ 不进候选
    ("n_belief", "某信念", "belief"),       # 同上
]
ALIASES = [("西电", "西安电子科技大学"), ("助手", "Echo")]


def mem(mid, summary, ts=1700000000, occurred_at=0.0):
    return (mid, summary, ts, occurred_at)


def _at(y, m, d, hh, mm=0):
    """本地时间 ⇒ epoch(测试要可控的「本地日期」)。"""
    import time as _t
    return _t.mktime((y, m, d, hh, mm, 0, 0, 0, -1))


class MatcherScope(unittest.TestCase):
    """匹配池:别名键剔除 + 不展开(数字必须与契约 v1.1 的基线口径对得上)。"""

    def test_alias_key_names_dropped_from_pool(self):
        matchers = mine.build_matchers(NODES, ALIASES)
        needles = {needle for needle, _ in matchers}
        self.assertNotIn("西电", needles, "别名键名不该进匹配池(由 canonical 代表)")
        self.assertIn("西安电子科技大学", needles)

    def test_aliases_are_not_expanded(self):
        """默认口径**不把**别名串展开成 canonical:summary 里写「西电」不该命中西电大。"""
        cands = mine.mine_same_memory_candidates(
            [mem(1, "今天去西电跑了校园跑")], NODES, ALIASES)
        names = {(c["source_name"], c["target_name"]) for c in cands}
        self.assertEqual(names, set(), "别名串被展开了(非默认口径):" + str(names))

    def test_alias_expansion_would_hit_if_enabled(self):
        """对照:若把别名当 needle,同一条记忆就会命中 canonical —— 说明上一条真在测口径。"""
        hit = mine.hit_nodes("今天去西电跑了校园跑", NODES, ALIASES)
        self.assertEqual([h["name"] for h in hit], ["校园跑"])


class HitScope(unittest.TestCase):
    """只认既有概念节点;非概念(episode/belief)与不存在的名字都不进候选。"""

    def test_non_concept_types_excluded(self):
        hit = mine.hit_nodes("某条记忆 与 某信念 与 校园跑", NODES, ALIASES)
        self.assertEqual([h["name"] for h in hit], ["校园跑"])

    def test_unknown_names_never_become_candidates(self):
        cands = mine.mine_same_memory_candidates(
            [mem(1, "他在新工科大学念书,也在西安电子科技大学")], NODES, ALIASES)
        self.assertEqual(cands, [])

    def test_duplicate_names_deduped_by_node_id(self):
        hit = mine.hit_nodes("Echo 说了话,Echo 又说了话", NODES, ALIASES)
        self.assertEqual(len(hit), 1)


class PairMining(unittest.TestCase):
    """同记忆两两成对:`count` = 共现记忆条数;证据 = 同时出现的那批记忆。"""

    def test_count_is_cooccurrence_memory_count(self):
        cands = mine.mine_same_memory_candidates([
            mem(1, "校园跑 和 章鱼小丸子"),
            mem(2, "又提到 校园跑 和 章鱼小丸子"),
            mem(3, "只提到 校园跑"),
        ], NODES, ALIASES)
        self.assertEqual(len(cands), 1)
        c = cands[0]
        self.assertEqual((c["source_name"], c["target_name"]), ("校园跑", "章鱼小丸子"))
        self.assertEqual(c["kind"], gate.KIND_COOCCUR_SAME_MEMORY)
        self.assertEqual(c["relation"], "共现")
        self.assertEqual((c["count"], c["weight"]), (2, 2.0))
        self.assertEqual(c["evidence_memory_id"], [1, 2])
        self.assertEqual((c["source_kind"], c["target_kind"], c["endpoint_kind"]),
                         ("node", "node", "node"))

    def test_pairs_are_unordered_and_deduped(self):
        cands = mine.mine_same_memory_candidates([
            mem(1, "校园跑 章鱼小丸子"),
            mem(2, "章鱼小丸子 校园跑"),
        ], NODES, ALIASES)
        self.assertEqual(len(cands), 1, "有向重复了:无序对应该合并成一条")
        self.assertEqual(cands[0]["count"], 2)

    def test_no_pairs_when_fewer_than_two_hits(self):
        self.assertEqual(mine.mine_same_memory_candidates(
            [mem(1, "只有 校园跑"), mem(2, "什么都没有")], NODES, ALIASES), [])

    def test_deterministic_output(self):
        rows = [mem(1, "校园跑 章鱼小丸子 西安电子科技大学"), mem(2, "校园跑 章鱼小丸子")]
        first = json.dumps(mine.mine_same_memory_candidates(rows, NODES, ALIASES),
                           ensure_ascii=False, sort_keys=True)
        second = json.dumps(mine.mine_same_memory_candidates(rows, NODES, ALIASES),
                            ensure_ascii=False, sort_keys=True)
        self.assertEqual(first, second)


class TwoSidedEvidence(unittest.TestCase):
    """两端 ids 的不变式 + **R2 为什么必须靠它**(1b 评审结论的回归钉子)。"""

    def _cands(self):
        return mine.mine_same_memory_candidates([
            mem(1, "校园跑 章鱼小丸子"),
            mem(2, "校园跑"),
            mem(3, "章鱼小丸子"),
        ], NODES, ALIASES)

    def test_intersection_equals_evidence(self):
        for c in self._cands():
            left = set(c["source_memory_ids"])
            right = set(c["target_memory_ids"])
            self.assertEqual(sorted(left & right), c["evidence_memory_id"])
            self.assertIn(c["evidence_memory_id"][0], left)

    def test_sides_are_per_endpoint_not_union(self):
        """两端集合**各自**含"只有自己出现"的记忆(1、2、3 都在两端里)。"""
        c = self._cands()[0]
        self.assertEqual(c["source_memory_ids"], [1, 2])
        self.assertEqual(c["target_memory_ids"], [1, 3])
        self.assertEqual(c["evidence_memory_id"], [1])

    def test_r2_has_teeth_only_with_two_sided_ids(self):
        """给互不相交的两端 ⇒ R2 丢;只给并集证据 ⇒ R2 退化成"非空即过"(评审结论)。"""
        c = dict(self._cands()[0])
        strict = dict(c, source_memory_ids=[900001], target_memory_ids=[900002],
                      evidence_memory_id=[900001, 900002])
        v = gate.gate_edge(strict, gate.build_context(NODES, ALIASES), enabled=True)
        self.assertEqual((v["action"], v["reason"]), ("drop", "zero-overlap"))

        degraded = dict(c)
        degraded.pop("source_memory_ids")
        degraded.pop("target_memory_ids")
        v2 = gate.gate_edge(degraded, gate.build_context(NODES, ALIASES), enabled=True)
        self.assertTrue(v2["accepted"], "退化口径下 R2 应当放行(这正是必须给两端 ids 的原因)")

    def test_dry_run_self_test_proves_r2_is_live(self):
        with tempfile.TemporaryDirectory() as tmp:
            seeded = _seed_db(Path(tmp) / "echo.db")
            try:
                report = mine.dry_run(str(Path(tmp) / "echo.db"))
            finally:
                seeded.close()
            self.assertTrue(report["r2_self_test"]["ran"])
            self.assertTrue(report["r2_self_test"]["dropped"])
            self.assertEqual(report["r2_self_test"]["reason"], "zero-overlap")


class TimeSource(unittest.TestCase):
    """时间只从 `episodic_memory` 取:证据里时间最晚且非零那条;取不到 ⇒ null。"""

    def test_takes_latest_nonzero_occurred_at(self):
        c = mine.mine_same_memory_candidates([
            mem(1, "校园跑 章鱼小丸子", occurred_at=100.0),
            mem(2, "校园跑 章鱼小丸子", occurred_at=300.0),
            mem(3, "校园跑 章鱼小丸子", occurred_at=0.0),
        ], NODES, ALIASES)[0]
        self.assertEqual(c["occurred_at"], 300.0)
        self.assertEqual(c["occurred_at_source"], "episodic_memory")

    def test_null_when_no_memory_has_occurred_at(self):
        c = mine.mine_same_memory_candidates([
            mem(1, "校园跑 章鱼小丸子", occurred_at=0.0),
        ], NODES, ALIASES)[0]
        self.assertIsNone(c["occurred_at"])
        self.assertIsNone(c["occurred_at_source"])
        # 共现边不吃 R6(只守时间边)⇒ 没有发生时间也照常通过
        v = gate.gate_edge(c, gate.build_context(NODES, ALIASES), enabled=True)
        self.assertTrue(v["accepted"])


class DryRunAndCli(unittest.TestCase):
    """dry-run 只读 + CLI 拒绝写 + 挖掘模块里没有写库 SQL。"""

    def test_dry_run_does_not_touch_the_db(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "echo.db"
            seeded = _seed_db(path)
            try:
                before = hashlib.sha256(path.read_bytes()).hexdigest()
                report = mine.dry_run(str(path))
            finally:
                seeded.close()
            self.assertGreater(report["candidates"], 0)
            self.assertEqual(hashlib.sha256(path.read_bytes()).hexdigest(), before,
                             "dry-run 改了库文件")
            conn = sqlite3.connect(str(path))
            try:
                self.assertEqual(conn.execute("SELECT COUNT(*) FROM graph_edges").fetchone()[0], 0,
                                 "dry-run 竟然落了边")
                self.assertEqual(conn.execute(
                    "SELECT COUNT(*) FROM graph_edge_receipts").fetchone()[0], 0)
            finally:
                conn.close()

    def test_cli_refuses_write_mode(self):
        self.assertEqual(mine.main(["--write", "--db", "whatever.db"]), 1)
        self.assertEqual(mine.main(["--apply", "--db", "whatever.db"]), 1)
        self.assertEqual(mine.main(["--help"]), 0)

    def test_miner_module_has_no_write_sql(self):
        src = (REPO / "python" / "engine" / "graph_mine.py").read_text(encoding="utf-8")
        for sql in ("INSERT INTO", "UPDATE graph", "DELETE FROM", "CREATE TABLE"):
            self.assertNotIn(sql, src, "挖掘模块里出现写库语句:" + sql)

    def test_mining_never_creates_nodes(self):
        """写侧落库只发生在闸门通过之后:`write_accepted_edges` 也不建节点。"""
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "echo.db"
            conn = _seed_db(path)
            try:
                nodes_before = conn.execute("SELECT COUNT(*) FROM graph_nodes").fetchone()[0]
                cands = mine.candidates_for_history(conn)
                gated = gate.gate_edges(cands, gate.build_context_from_db(conn), enabled=True)
                written = gate.write_accepted_edges(conn, gated["accepted"], OWNER)
                self.assertGreater(written["inserted"], 0)
                self.assertEqual(conn.execute(
                    "SELECT COUNT(*) FROM graph_nodes").fetchone()[0], nodes_before,
                    "落边竟然建了节点")
                # v2-A4(2026-10-01):共现落在**证据层**(一行 = 一条证据),`graph_edges`
                # 一行不许有;影子表**从此冻结** —— 写多少都不许往它加行。
                scopes = {str(r[0]) for r in conn.execute(
                    "SELECT DISTINCT scope_kind FROM " + gate.EVIDENCE_TABLE)}
                self.assertEqual(scopes, {"same_memory", "same_day"},
                                 "共现该按记忆 / 按天分桶")
                self.assertGreater(int(conn.execute(
                    "SELECT SUM(pair_count) FROM " + gate.EVIDENCE_TABLE).fetchone()[0] or 0), 0,
                    "证据行里一个 pair 都没有")
                self.assertEqual(conn.execute(
                    "SELECT COUNT(*) FROM " + gate.SHADOW_TABLE).fetchone()[0], 0,
                    "影子表冻结:一行都不许新增")
                self.assertEqual(conn.execute(
                    "SELECT COUNT(*) FROM graph_edges WHERE COALESCE(kind, '') <> ''"
                ).fetchone()[0], 0, "影子边漏进 graph_edges 了")
            finally:
                conn.close()


class SameDayMining(unittest.TestCase):
    """同天共现(3a 第二步):按本地日期分组、day/occurred_at 口径、天数计权、证据裁剪。"""

    def _cands(self, **kw):
        rows = [
            # 同一天:一对**跨记忆**(两条记忆各提到一端 ⇒ 同一条记忆里从不相遇)
            mem(1, "校园跑", ts=_at(2026, 9, 28, 9)),
            mem(2, "章鱼小丸子", ts=_at(2026, 9, 28, 20)),
            # 另一天:同一条记忆里两端都在(顺带跨日累加天数)
            mem(3, "校园跑 和 章鱼小丸子", ts=_at(2026, 9, 30, 12)),
        ]
        return mine.mine_same_day_candidates(rows, NODES, ALIASES, **kw)

    def test_day_and_time_source_are_local_midnight(self):
        c = [x for x in self._cands() if x["count"] == 2][0]
        self.assertEqual(c["kind"], gate.KIND_COOCCUR_SAME_DAY)
        self.assertEqual(c["day"], "2026-09-30", "锚定日期应取最近那一天")
        self.assertEqual(c["occurred_at"], mine.day_midnight_epoch("2026-09-30"))
        self.assertEqual(c["occurred_at_source"], gate.TIME_SOURCE_SAME_DAY)
        self.assertEqual(c["relation"], "同日共现")

    def test_count_is_days_covered_not_memories(self):
        c = [x for x in self._cands() if x["count"] == 2][0]
        self.assertEqual(c["count"], 2, "两条记忆但只有两天覆盖 ⇒ count 必须是 2")
        self.assertEqual(c["weight"], 2.0)

    def test_cross_memory_pair_is_present(self):
        """同天口径比同记忆口径大:跨记忆的两端也要成对。"""
        names = {(x["source_name"], x["target_name"]) for x in self._cands()}
        self.assertIn(("校园跑", "章鱼小丸子"), names)
        same_memory = mine.mine_same_memory_candidates(
            [mem(1, "校园跑", ts=_at(2026, 9, 28, 9)),
             mem(2, "章鱼小丸子", ts=_at(2026, 9, 28, 20))], NODES, ALIASES)
        self.assertEqual(same_memory, [], "同记忆口径下这对不该成对(对照)")

    def test_two_sided_ids_are_that_days_memories(self):
        c = [x for x in self._cands() if x["count"] == 2][0]
        self.assertEqual(c["source_memory_ids"], [1, 3])
        self.assertEqual(c["target_memory_ids"], [2, 3])

    def test_evidence_keeps_both_sides_and_marks_truncation(self):
        """证据 = 每天「提到各端的最晚一条」;超上限裁剪时最近一天的两条必须留。"""
        rows = []
        for d in range(1, 13):                      # 12 天 ⇒ 每天 2 条 ⇒ 24 条 > 上限 16
            rows.append(mem(100 + d * 2, "校园跑", ts=_at(2026, 9, d, 8)))
            rows.append(mem(101 + d * 2, "章鱼小丸子", ts=_at(2026, 9, d, 9)))
        c = mine.mine_same_day_candidates(rows, NODES, ALIASES)[0]
        self.assertTrue(c["evidence_truncated"], "24 条证据超过上限 16,应标 truncated")
        self.assertEqual(len(c["evidence_memory_id"]), 16)
        last = {c["source_memory_ids"][-1], c["target_memory_ids"][-1]}
        self.assertTrue(set(c["evidence_memory_id"]) & last,
                        "最近一天「两端各一条依据」被全裁掉了:" + str(c["evidence_memory_id"]))

    def test_exactly_one_day_two_nodes_makes_one_candidate(self):
        cands = mine.mine_same_day_candidates(
            [mem(1, "校园跑 章鱼小丸子", ts=_at(2026, 9, 28, 9))], NODES, ALIASES)
        self.assertEqual(len(cands), 1)
        self.assertEqual((cands[0]["day"], cands[0]["count"]), ("2026-09-28", 1))
        self.assertEqual(cands[0]["occurred_at"], mine.day_midnight_epoch("2026-09-28"))

    def test_same_day_excludes_non_concept_and_does_not_create_nodes(self):
        cands = mine.mine_same_day_candidates(
            [mem(1, "某条记忆 某信念 校园跑", ts=_at(2026, 9, 28, 9))], NODES, ALIASES)
        self.assertEqual(cands, [])

    def test_local_day_uses_local_timezone(self):
        self.assertEqual(mine.local_day(_at(2026, 9, 28, 0, 1)), "2026-09-28")
        self.assertEqual(mine.local_day(_at(2026, 9, 28, 23, 59)), "2026-09-28")
        self.assertNotEqual(mine.local_day(_at(2026, 9, 28, 23, 59)),
                            mine.local_day(_at(2026, 9, 29, 0, 1)))


class SameDayR2KindAware(unittest.TestCase):
    """裁决①落地后的同天边 R2:**跨记忆的同天对能过**,但两端各自必须真有依据。"""

    ROWS = [mem(1, "校园跑", ts=_at(2026, 9, 28, 9)),
            mem(2, "章鱼小丸子", ts=_at(2026, 9, 28, 20))]

    def test_cross_memory_same_day_edge_now_passes(self):
        c = mine.mine_same_day_candidates(self.ROWS, NODES, ALIASES)[0]
        self.assertEqual(sorted(set(c["source_memory_ids"]) & set(c["target_memory_ids"])), [],
                         "这对确实没有共同记忆(交集为空)——所以旧判据会误杀")
        self.assertEqual(c["evidence_scope"], gate.EVIDENCE_SCOPE_SAME_DAY)
        v = gate.gate_edge(c, gate.build_context(NODES, ALIASES), enabled=True)
        self.assertTrue(v["accepted"], v)

    def test_empty_side_still_dropped(self):
        c = dict(mine.mine_same_day_candidates(self.ROWS, NODES, ALIASES)[0])
        c["target_memory_ids"] = []
        v = gate.gate_edge(c, gate.build_context(NODES, ALIASES), enabled=True)
        self.assertEqual((v["action"], v["reason"]), ("drop", "zero-overlap"))

    def test_same_memory_edge_keeps_intersection_rule(self):
        """同记忆类**不放松**:两端各自非空但不相交 ⇒ 仍丢。"""
        c = mine.mine_same_memory_candidates(
            [mem(1, "校园跑 章鱼小丸子", ts=_at(2026, 9, 28, 9))], NODES, ALIASES)[0]
        c["target_memory_ids"] = [999]
        v = gate.gate_edge(c, gate.build_context(NODES, ALIASES), enabled=True)
        self.assertEqual((v["action"], v["reason"]), ("drop", "zero-overlap"))

    def test_same_memory_pair_within_the_day_still_passes(self):
        c = [x for x in mine.mine_same_day_candidates(
            [mem(1, "校园跑 章鱼小丸子", ts=_at(2026, 9, 28, 9))], NODES, ALIASES)][0]
        v = gate.gate_edge(c, gate.build_context(NODES, ALIASES), enabled=True)
        self.assertTrue(v["accepted"], "同一条记忆里相遇过的同天边,当然该过")


class MergedView(unittest.TestCase):
    """合并视图:两类全启用后活跃边/不含说话人节点的活跃边会变成多少。"""

    def test_two_kinds_take_two_rows_with_distinct_relations(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "echo.db"
            conn = _seed_db(path)
            try:
                cands = mine.candidates_for_history(conn)
                self.assertEqual({c["kind"] for c in cands},
                                 {gate.KIND_COOCCUR_SAME_MEMORY, gate.KIND_COOCCUR_SAME_DAY})
                ctx = gate.build_context_from_db(conn)
                gated = gate.gate_edges(cands, ctx, enabled=True)
                before = mine._read_active_edges(conn)
                mv = mine._edge_readings(before, gated["accepted"], ctx)
                self.assertEqual(mv["active_edges_before"], 0)
                self.assertEqual(mv["active_edges_after"], len(gated["accepted"]))
                self.assertEqual(mv["active_edges_without_speaker_after"],
                                 mv["active_edges_after"], "被接受的边都不该含说话人节点")
                rels = {c["relation"] for c in gated["accepted"]}
                self.assertEqual(rels, {"共现", "同日共现"},
                                 "两类必须落在不同谓词(槽位)上,否则会互相顶掉")
                self.assertEqual(mv["slot_row_collisions_with_existing"], 0)
            finally:
                conn.close()

    def test_dry_run_reports_merged_view_for_both_kinds(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "echo.db"
            seeded = _seed_db(path)
            try:
                report = mine.dry_run(str(path))
            finally:
                seeded.close()
        self.assertEqual(report["candidates_by_kind"].get(gate.KIND_COOCCUR_SAME_DAY), 1)
        self.assertTrue(report["lenient_same_day"]["ran"])
        self.assertEqual(report["merged_view"]["active_edges_before"], 0)
        self.assertGreater(report["merged_view"]["active_edges_after"], 0)


class CliKinds(unittest.TestCase):
    """CLI:`--kinds` 选类;不认的 kind 直接拒。**不提供**窗口口径。"""

    def test_bad_kind_rejected(self):
        self.assertEqual(mine.main(["--dry-run", "--kinds", "same_day+whatever"]), 1)

    def test_help_mentions_no_window_mode(self):
        import contextlib
        import io
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            self.assertEqual(mine.main(["--help"]), 0)
        text = buf.getvalue()
        self.assertIn("--kinds", text)
        self.assertIn("没有", text)

    def test_single_memory_scope_forces_same_memory_kind(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "echo.db"
            seeded = _seed_db(path)
            try:
                report = mine.dry_run(str(path), memory_id=1)
            finally:
                seeded.close()
        self.assertEqual(report["kinds"], [mine.KIND_SAME_MEMORY])


def _at(y, m, d, hh, mm=0):
    """本地时间 ⇒ epoch(测试要可控的「本地日期」)。"""
    import time as _t
    return _t.mktime((y, m, d, hh, mm, 0, 0, 0, -1))




def _seed_db(path):
    """造一个"有节点/别名/记忆"的小库(走真迁移,所以回执表也在)。"""
    conn = db.connect(str(path))
    graph.get_or_create_node(conn, "校园跑")
    graph.get_or_create_node(conn, "章鱼小丸子")
    conn.execute(
        "INSERT INTO graph_aliases (alias, canonical_name) VALUES (?, ?)",
        ("小丸子", "章鱼小丸子"))
    for mid, summary, occurred_at in ((1, "校园跑 章鱼小丸子", 100.0),
                                      (2, "校园跑 章鱼小丸子", 200.0),
                                      (3, "只提到 校园跑", 0.0)):
        conn.execute(
            "INSERT INTO episodic_memory (memory_id, summary, timestamp, is_active, status,"
            " occurred_at) VALUES (?, ?, ?, 1, 'active', ?)",
            (mid, summary, 1700000000 + mid, occurred_at))
    conn.commit()
    return conn


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
