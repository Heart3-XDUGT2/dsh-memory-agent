# -*- coding: utf-8 -*-
"""写入侧去噪闸门(R1–R6)单测 —— 阶段 1a(规则本体)+ 阶段 1b(接线/回执)。

覆盖(每条规则至少一条 + 硬验收):
  RuleR1SpeakerEndpoint   —— R1:说话人 / 人格节点不得做共现端点
  RuleR2ZeroOverlap       —— R2:零重合不得注入(含**负控**)
  RuleR3Alias             —— R3:别名归一 / 规范名不存在 ⇒ 丢边(写入侧宽松口径)
  RuleR4TypeDirection     —— R4:端点类型非法 ⇒ 丢;方向违约 ⇒ 自动改正
  RuleR5SlotIsolation     —— R5:槽位隔离(不挤事实边槽位、不触发让位)
  RuleR6NoOccurredAt      —— R6:无 occurred_at 不建时间边
  RuleTableMiss           —— 1b 裁决④:表外放行可审计(计数 + 回执留痕)
  SingleSourceOfTruth     —— 1b 裁决③⑤:reason 枚举单一出处、`belief` 在取值域
  WiringSwitchOn          —— 1b:开关开时只吃影子边、只增不改、回执落表
  GateInternalError       —— 1b 裁决④:闸门自身出错也留痕(回执优先 / stderr 全量兜底)
  Idempotency             —— 幂等:复跑计数一致 + 落库/回执改动数 = 0
  DefaultOffInvariance    —— **开关关 = 零行为变化**(不读库 / 活库读数不变)
  MigrationShape          —— 迁移只 ADD COLUMN / CREATE TABLE IF NOT EXISTS
  NamesFromData(P1c)      —— 名字改由数据下发:引擎零名单 / 帧解析 never-throw /
                            空名单 = 空集口径 / speakers ⊆ person_set

P1c 夹具(2026-10-05):说话人 / 人名集合搬进 `<数据目录>/names.json` 后,本模块的
`CTX` 与每条自建上下文都用 `LEGACY_SPEAKERS` / `LEGACY_PERSON_NAMES`(逐字照抄旧的
内置值)显式喂名字 —— 名字是数据,测试就把那份数据喂回去。

口径:`docs/PLAN_MEMORY_GRAPH_ACTION.md` §2 的「开工检查表(阶段 1)」+ 1b 裁决 1–5。
"""
import contextlib
import io
import os
import sqlite3
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from engine import db, graph, graph_gate as gate, judge, l0_tier  # noqa: E402

REPO = Path(__file__).resolve().parents[2]

# ── 测试期的**环境闸**:把"插件设置文件"那一路指到一个不存在的路径 ──────────────
# 背景(2026-10-01,踩到的坑):`gate_enabled()` 的第三路是**开发机上的真文件**
# `$DSH_HOME/echo/config.json`,而那个文件**可能正被面板拨着开**(实测:就被拨开过)。
# 不隔离 ⇒ "默认关"这类断言读的是开发机的活配置,同一份 commit 在不同机器上结论不同
# (实测:两条 DefaultOffInvariance 因此变红,而代码一个字没改)。
# `ECHO_GRAPH_GATE_CONFIG` 就是为这种场合留的覆盖口:指到临时不存在的路径 ⇒ 文件那一路
# 恒关。本模块在**导入时**打闸(unittest 先把所有测试模块导入完、再跑,所以同进程的
# 其它模块也一起被隔离了);要"文件那一路"的测试自己用 `config_path=` / env 显式打开。
os.environ[gate.SWITCH_CONFIG_PATH_ENV] = str(
    Path(tempfile.gettempdir()) / "echo-stage4-tests-no-such-config.json")

# ---- 夹具:一张小节点表快照(名字/类型都取自活库真实形状) ----
OWNER = "test-owner"
NODES = [
    {"node_id": "n_user", "name": "用户", "node_type": "concept"},
    {"node_id": "n_gege", "name": "阿岚", "node_type": "concept"},
    {"node_id": "n_ta", "name": "她", "node_type": "concept"},
    {"node_id": "n_echo", "name": "Echo", "node_type": "concept"},
    {"node_id": "n_xdu", "name": "西安电子科技大学", "node_type": "concept"},
    {"node_id": "n_xd", "name": "西电", "node_type": "concept"},
    {"node_id": "n_run", "name": "校园跑", "node_type": "concept"},
    {"node_id": "n_tako", "name": "章鱼小丸子", "node_type": "concept"},
    {"node_id": "n_mem", "name": "mem:701", "node_type": "episode"},
]
ALIASES = {"西电": "西安电子科技大学", "助手": "Echo"}

# ---- P1c:名字改由数据下发(`names.json` 经帧),引擎里**不留真名** ----
# 下面这组夹具 = P1c 之前引擎里那份硬编码,逐字照抄;测试靠它复现旧行为,
# 也靠它证明"名单是数据":把名字喂进去 ⇒ 与被替换掉的硬编码逐位一致。
LEGACY_SPEAKERS = ("用户", "阿岚", "她", "Echo", "助手")
LEGACY_PERSON_EXTRA = ("阿乙", "阿岚")
LEGACY_PERSON_NAMES = LEGACY_SPEAKERS + LEGACY_PERSON_EXTRA
#: 帧里的名字对象(壳侧 `names.json` 下发的形状)
LEGACY_FRAME_NAMES = {"speakers": list(LEGACY_SPEAKERS),
                      "personNames": list(LEGACY_PERSON_EXTRA)}

CTX = gate.build_context(NODES, ALIASES, speakers=LEGACY_SPEAKERS,
                         person_names=LEGACY_PERSON_NAMES)


def candidate(**kw):
    """一条 judge 候选(形状照 `python/tests/test_judge.py` 的同名夹具)。"""
    base = {"layer": "L2", "summary": "用户说他喜欢猫", "confidence": 0.9,
            "certainty": "explicit", "attribution": "user_explicit",
            "stability": "stable", "shouldWrite": True,
            "evidenceQuotes": ["我喜欢猫"], "temporal_status": "enduring"}
    base.update(kw)
    return base


def cooccur(source_id=None, target_id=None, *, source_name=None, target_name=None,
            relation="共现", evidence=(701, 702), **extra):
    """一条共现候选边(graph-baseline 契约形状)。"""
    edge = {"kind": "cooccur_same_memory", "source_kind": "node", "target_kind": "node",
            "endpoint_kind": "node", "source_id": source_id, "target_id": target_id,
            "evidence_memory_id": list(evidence), "weight": len(evidence),
            "count": len(evidence), "relation": relation, "speaker_node_excluded": False,
            "occurred_at": None, "occurred_at_source": None}
    if source_name is not None:
        edge["source_name"] = source_name
    if target_name is not None:
        edge["target_name"] = target_name
    edge.update(extra)
    return edge


def temporal(source_id="701", target_id="702", *, relation="时间相邻",
             occurred_at=1759000000.0, source="episodic_memory", **extra):
    edge = {"kind": "temporal", "source_kind": "memory", "target_kind": "memory",
            "endpoint_kind": "memory", "source_id": source_id, "target_id": target_id,
            "evidence_memory_id": [int(source_id), int(target_id)], "weight": 1, "count": 1,
            "relation": relation, "speaker_node_excluded": False,
            "occurred_at": occurred_at, "occurred_at_source": source}
    edge.update(extra)
    return edge


def fact(source_id, target_id, relation, **extra):
    edge = {"kind": "fact", "source_kind": "node", "target_kind": "node",
            "endpoint_kind": "node", "source_id": source_id, "target_id": target_id,
            "evidence_memory_id": [701], "weight": 1, "count": 1, "relation": relation,
            "speaker_node_excluded": False, "occurred_at": 0.0, "occurred_at_source": None}
    edge.update(extra)
    return edge


def _cooccur_named(conn, source_name, target_name):
    """按**真库里的节点 id**造一条共现候选(要跟 `graph.add_edge` 落在同一个键位上时用)。"""
    ids = {str(r[1]): str(r[0]) for r in conn.execute(
        "SELECT node_id, name FROM graph_nodes")}
    return cooccur(ids[source_name], ids[target_name],
                   source_name=source_name, target_name=target_name)


def fresh_conn():
    """临时库 + 走真实迁移(与引擎同一条路)。"""
    tmp = tempfile.TemporaryDirectory()
    conn = db.connect(str(Path(tmp.name) / "echo.db"))
    return tmp, conn


def _seed_migration_source(database, *, include_kind):
    """Nonempty synthetic input; never discovers or copies a user database.

    The legacy case has the old active flag but no kind column. The current
    case has explicit kind values and existing receipt/shadow rows, so the
    disabled-gate test cannot pass by comparing empty tables.
    """
    database = Path(database)
    temporary_root = Path(tempfile.gettempdir()).resolve()
    if temporary_root not in database.resolve().parents:
        raise AssertionError("synthetic_database_must_be_inside_test_temp")
    conn = db.connect(str(database)) if include_kind else sqlite3.connect(str(database))
    try:
        if not include_kind:
            conn.executescript(db._DDL)
            conn.execute("ALTER TABLE graph_edges ADD COLUMN is_active INTEGER DEFAULT 1")
        conn.executemany(
            "INSERT INTO graph_nodes (node_id, name, node_type) VALUES (?, ?, ?)",
            [("synthetic-node-a", "合成节点甲", "concept"),
             ("synthetic-node-b", "合成节点乙", "concept"),
             ("synthetic-node-c", "合成节点丙", "concept")])
        rows = [("synthetic-node-a", "synthetic-node-b", "相关", 1.5, OWNER),
                ("synthetic-node-b", "synthetic-node-c", "相关", 2.5, OWNER),
                ("synthetic-node-c", "synthetic-node-a", "相关", 3.5, OWNER)]
        if include_kind:
            conn.executemany(
                "INSERT INTO graph_edges (source_id, target_id, relation, weight, owner_key, kind)"
                " VALUES (?, ?, ?, ?, ?, ?)",
                [row + (kind,) for row, kind in zip(
                    rows, ("", "cooccur_same_memory", "cooccur_same_day"))])
            conn.executemany(
                "INSERT INTO graph_edge_receipts (run_id, kind, source_id, target_id, action, note)"
                " VALUES (?, ?, ?, ?, ?, ?)",
                [("synthetic-history-1", "cooccur_same_memory", "synthetic-node-a", "synthetic-node-b", "accept", "synthetic before"),
                 ("synthetic-history-2", "cooccur_same_day", "synthetic-node-b", "synthetic-node-c", "drop", "synthetic before")])
            conn.executemany(
                "INSERT INTO graph_shadow_edges (source_id, target_id, relation, kind, owner_key)"
                " VALUES (?, ?, ?, ?, ?)",
                [("synthetic-node-a", "synthetic-node-b", "合成共现", "cooccur_same_memory", gate.SHADOW_OWNER),
                 ("synthetic-node-b", "synthetic-node-c", "合成同天", "cooccur_same_day", gate.SHADOW_OWNER)])
        else:
            conn.executemany(
                "INSERT INTO graph_edges (source_id, target_id, relation, weight, owner_key)"
                " VALUES (?, ?, ?, ?, ?)", rows)
        conn.execute("UPDATE graph_edges SET is_active = 0 WHERE source_id = ?",
                     ("synthetic-node-c",))
        conn.commit()
        if conn.execute("SELECT COUNT(*) FROM graph_nodes").fetchone()[0] != 3:
            raise AssertionError("synthetic_source_nodes_not_seeded")
        if conn.execute("SELECT COUNT(*) FROM graph_edges").fetchone()[0] != 3:
            raise AssertionError("synthetic_source_edges_not_seeded")
        if include_kind:
            for table in ("graph_edge_receipts", gate.SHADOW_TABLE):
                if conn.execute("SELECT COUNT(*) FROM " + table).fetchone()[0] != 2:
                    raise AssertionError("synthetic_history_not_seeded")
    finally:
        conn.close()
    return database


# ---- 路线 2(2026-10-01 人类裁决):影子边住在**自己的表**里,@graph_edges 一行不碰 ----
SHADOW = gate.SHADOW_TABLE          # "graph_shadow_edges"


def shadow_rows(conn, owner=gate.SHADOW_OWNER, cols="*"):
    """影子边自己表里的行(测试读口;生产读口是 `gate.shadow_stats`)。"""
    return conn.execute(
        "SELECT " + cols + " FROM " + SHADOW + " WHERE owner_key = ? ORDER BY edge_id",
        (owner,)).fetchall()


def shadow_count(conn, owner=gate.SHADOW_OWNER):
    return int(conn.execute("SELECT COUNT(*) FROM " + SHADOW +
                            " WHERE owner_key = ?", (owner,)).fetchone()[0])


# ---- v2-A4(2026-10-01):共现的落点 = **证据层**(n 元,不铺 pair 边)----
# 影子表 `graph_shadow_edges` 从此**冻结**(3a 的历史 48 行只读、不再增长);
# 新写落在 `graph_cooc_evidence`,一行 = 一条证据(一条记忆 / 一天),
# pair 由只读视图 `v_cooc_pairs` 按需派生。下面四个是证据层自己的读口
# (生产侧的对应物是 `gate.shadow_stats`)。
EVIDENCE = gate.EVIDENCE_TABLE       # "graph_cooc_evidence"


def cooc_rows(conn, cols="*", owner=gate.EVIDENCE_OWNER):
    return conn.execute("SELECT " + cols + " FROM " + EVIDENCE +
                        " WHERE owner_key = ? ORDER BY evidence_id", (owner,)).fetchall()


def cooc_count(conn, owner=gate.EVIDENCE_OWNER):
    return int(conn.execute("SELECT COUNT(*) FROM " + EVIDENCE +
                            " WHERE owner_key = ?", (owner,)).fetchone()[0])


def cooc_dump(conn):
    return [tuple(str(c) for c in r) for r in conn.execute(
        "SELECT * FROM " + EVIDENCE + " ORDER BY evidence_id")]


def cooc_pair_rows(conn, owner=gate.EVIDENCE_OWNER):
    """视图**按需派生**出来的 pair 行数(证据层不铺 pair 边)。"""
    return int(conn.execute("SELECT COUNT(*) FROM v_cooc_pairs WHERE owner_key = ?",
                            (owner,)).fetchone()[0])


def cooc_pairs(conn, owner=gate.EVIDENCE_OWNER):
    return {str(r[0]) for r in conn.execute(
        "SELECT pair_key FROM v_cooc_pairs WHERE owner_key = ?", (owner,))}


def fact_rows(conn, owner=OWNER):
    return conn.execute(
        "SELECT edge_id, slot, is_active, superseded_by FROM graph_edges"
        " WHERE owner_key = ? ORDER BY edge_id", (owner,)).fetchall()


def edges_dump(conn):
    """`graph_edges` 全表逐位快照(零泄漏的核心证据:写影子边前后一模一样)。"""
    return [tuple(str(c) for c in r) for r in conn.execute(
        "SELECT * FROM graph_edges ORDER BY edge_id")]


def shadow_dump(conn):
    return [tuple(str(c) for c in r) for r in conn.execute(
        "SELECT * FROM " + SHADOW + " ORDER BY edge_id")]


def load_fingerprint(conn, owner):
    """`load(owner)` 的逐位指纹(与 `ShadowOwnerIsolation._fingerprint` 同口径)。"""
    by_id, _by_name, edges = graph.load(conn, owner)
    payload = (sorted(by_id), sorted((k, v["name"]) for k, v in by_id.items()),
               sorted([tuple(str(e[k]) for k in (
                   "edge_id", "source_id", "target_id", "relation", "weight",
                   "slot", "is_active", "layer", "occurred_at")) for e in edges]))
    return hash(repr(payload)), payload


class RuleR1SpeakerEndpoint(unittest.TestCase):
    """R1:说话人 / 人格节点(`用户`/`阿岚`/`她`/`Echo`/`助手`)不得做共现端点。

    P1c 起这五个名字**不在代码里**了:本模块用 `LEGACY_*` 夹具(照抄旧内置值)喂进
    `build_context(..., speakers=, person_names=)` —— 行为与被替换掉的硬编码逐位一致。
    """

    def test_speaker_endpoint_is_dropped(self):
        v = gate.gate_edge(cooccur("n_user", "n_xdu"), CTX, enabled=True)
        self.assertFalse(v["accepted"])
        self.assertEqual(v["action"], "drop")
        self.assertEqual(v["reason"], "speaker-node")
        self.assertIsNone(v["edge"])

    def test_speaker_endpoint_by_name_is_dropped(self):
        v = gate.gate_edge(cooccur(source_name="她", target_name="校园跑",
                                   source_id=None, target_id="n_run"),
                           CTX, enabled=True)
        self.assertEqual((v["action"], v["reason"]), ("drop", "speaker-node"))

    def test_exported_speaker_flag_is_honoured(self):
        """graph-baseline 导出时已置位 `speaker_node_excluded` ⇒ 直接采信。"""
        v = gate.gate_edge(cooccur("n_xdu", "n_run", speaker_node_excluded=True),
                           CTX, enabled=True)
        self.assertEqual((v["action"], v["reason"]), ("drop", "speaker-node"))

    def test_alias_to_speaker_node_is_caught_r3_then_r1(self):
        """`助手` 先被 R3 归一到 `Echo`,再被 R1 判说话人 —— 顺序即规格。"""
        v = gate.gate_edge(cooccur(source_name="助手", target_name="校园跑",
                                   source_id=None, target_id="n_run"),
                           CTX, enabled=True)
        self.assertEqual((v["action"], v["reason"]), ("drop", "speaker-node"))

    def test_r1_only_guards_cooccur_edges(self):
        """事实边的端点本来就该是说话人节点 —— R1 不许砍核事实。"""
        v = gate.gate_edge(fact("n_user", "n_xdu", "就读于"), CTX, enabled=True)
        self.assertTrue(v["accepted"], v)
        self.assertEqual(v["action"], "accept")
        v2 = gate.gate_edge(temporal(), CTX, enabled=True)
        self.assertTrue(v2["accepted"], v2)

    def test_no_speaker_leakage_on_constructed_batch(self):
        """§2 的核心验收:**0 条泄漏**。

        构造一批候选边,每条都让**一个说话人 / 人格节点**当端点
        (`用户`/`阿岚`/`她`/`Echo` 走节点表;`助手` 走别名表 → `Echo`)。
        """
        speakers = ["用户", "阿岚", "她", "Echo", "助手"]
        others = ["西安电子科技大学", "校园跑", "章鱼小丸子"]
        batch = []
        for name in speakers:
            for other in others:
                batch.append(cooccur(source_name=name, target_name=other,
                                     source_id=None, target_id=None,
                                     evidence=(701, 702)))
        self.assertEqual(len(batch), 15)

        result = gate.gate_edges(batch, CTX, enabled=True)
        counters = result["counters"]

        self.assertEqual(counters["drop"], 15, "含说话人节点的边必须全丢")
        self.assertEqual(counters["accept"], 0)
        self.assertEqual(set(counters["reasons"]), {"speaker-node"})
        self.assertEqual(counters["rules"], {"R3": 3, "R1": 15})

        # 0 泄漏:通过的边里,任何一个端点都不许是说话人节点
        speaker_folded = {s.casefold() for s in speakers}
        leaked = []
        for edge in result["accepted"]:
            for side in ("source", "target"):
                name = str(edge.get(side + "_name") or "").casefold()
                if name in speaker_folded:
                    leaked.append(edge)
        self.assertEqual(leaked, [], "说话人节点泄漏进图了")

        receipts = result["receipts"]
        self.assertEqual(len(receipts), 15, "每次丢边都要留一行回执")
        self.assertEqual({r["reason"] for r in receipts}, {"speaker-node"})
        print("[0-leak 证据] 构造 %d 条含说话人节点的候选 → drop=%d accept=%d "
              "泄漏=%d reasons=%s" % (len(batch), counters["drop"], counters["accept"],
                                      len(leaked), counters["reasons"]))


class RuleR2ZeroOverlap(unittest.TestCase):
    """R2:与另一端点零重合(没在任何一处一起出现过)的边不得注入。"""

    def test_disjoint_mention_sets_dropped(self):
        v = gate.gate_edge(cooccur("n_run", "n_tako", source_memory_ids=[1, 2],
                                   target_memory_ids=[3, 4]), CTX, enabled=True)
        self.assertEqual((v["action"], v["reason"]), ("drop", "zero-overlap"))

    def test_empty_evidence_dropped(self):
        v = gate.gate_edge(cooccur("n_run", "n_tako", evidence=()), CTX, enabled=True)
        self.assertEqual((v["action"], v["reason"]), ("drop", "zero-overlap"))

    def test_overlapping_mentions_accepted(self):
        v = gate.gate_edge(cooccur("n_run", "n_tako", source_memory_ids=[1, 2, 3],
                                   target_memory_ids=[3, 4]), CTX, enabled=True)
        self.assertTrue(v["accepted"], v)

    def test_negative_control_zero_overlap_never_injected(self):
        """负控:三条零重合输入,一条都不许进(而且不许做成检索层阈值 —— C10)。"""
        batch = [cooccur("n_run", "n_tako", source_memory_ids=[i], target_memory_ids=[i + 10])
                 for i in range(3)]
        result = gate.gate_edges(batch, CTX, enabled=True)
        self.assertEqual(result["accepted"], [])
        self.assertEqual(result["counters"]["drop"], 3)
        self.assertEqual(result["counters"]["reasons"], {"zero-overlap": 3})


class RuleR3Alias(unittest.TestCase):
    """R3:端点先过 `graph_aliases`;能归一则 rewrite,规范名不存在则丢边。"""

    def test_alias_rewritten_to_canonical(self):
        v = gate.gate_edge(cooccur(source_name="西电", source_id=None,
                                   target_name="校园跑", target_id="n_run"),
                           CTX, enabled=True)
        self.assertTrue(v["accepted"], v)
        self.assertEqual(v["action"], "rewrite")
        self.assertEqual(v["edge"]["source_name"], "西安电子科技大学")
        self.assertEqual(v["edge"]["source_id"], "n_xdu")

    def test_alias_key_node_id_rewritten(self):
        """按 id 传进来的 `西电` 节点(活库里真有这个节点)也要被归一到规范名。"""
        v = gate.gate_edge(cooccur("n_xd", "n_run"), CTX, enabled=True)
        self.assertEqual(v["action"], "rewrite")
        self.assertEqual(v["edge"]["source_id"], "n_xdu")

    def test_alias_missing_canonical_dropped(self):
        ctx = gate.build_context(NODES, dict(ALIASES, **{"某别名": "不存在的规范名"}),
                                 speakers=LEGACY_SPEAKERS,
                                 person_names=LEGACY_PERSON_NAMES)
        v = gate.gate_edge(cooccur(source_name="某别名", source_id=None,
                                   target_name="校园跑", target_id="n_run"),
                           ctx, enabled=True)
        self.assertEqual((v["action"], v["reason"]), ("drop", "alias-missing-canonical"))

    def test_unresolved_endpoint_allowed_by_default_write_side(self):
        """1b 裁决②:写入侧默认非严格 —— **真正的新概念名放行**(它正要被建出来)。"""
        self.assertFalse(CTX["strict_node_resolution"], "写入侧默认必须是宽松口径")
        v = gate.gate_edge(cooccur("n_还不存在", "n_run"), CTX, enabled=True)
        self.assertTrue(v["accepted"], v)

    def test_unresolved_endpoint_dropped_in_strict_offline_mode(self):
        """严格口径(离线测算,graph-baseline 同款)才把解析不到的端点丢掉。"""
        ctx = gate.build_context(NODES, ALIASES, strict_node_resolution=True,
                                 speakers=LEGACY_SPEAKERS,
                                 person_names=LEGACY_PERSON_NAMES)
        v = gate.gate_edge(cooccur("n_不存在", "n_run"), ctx, enabled=True)
        self.assertEqual((v["action"], v["reason"]), ("drop", "alias-missing-canonical"))


class RuleR4TypeDirection(unittest.TestCase):
    """R4:端点类型非法 ⇒ 丢边;方向违约 ⇒ 自动改正(改不了则丢)。"""

    def test_cooccur_with_episode_endpoint_dropped(self):
        result = gate.gate_edges([cooccur("n_mem", "n_run")], CTX, enabled=True)
        self.assertEqual(result["accepted"], [])
        self.assertEqual(result["counters"]["drop"], 1)          # 计数 +1
        self.assertEqual(result["counters"]["reasons"], {"bad-endpoint-type": 1})

    def test_fact_with_episode_endpoint_dropped(self):
        v = gate.gate_edge(fact("n_mem", "n_run", "相关"), CTX, enabled=True)
        self.assertEqual((v["action"], v["reason"]), ("drop", "bad-endpoint-type"))

    def test_direction_violation_rewritten(self):
        """`就读于` 的方向是 person → concept;反着写 ⇒ 自动交换两端。"""
        v = gate.gate_edge(fact("n_xdu", "n_user", "就读于"), CTX, enabled=True)
        self.assertTrue(v["accepted"], v)
        self.assertEqual(v["action"], "rewrite")
        self.assertEqual(v["reason"], "bad-direction")
        self.assertEqual(v["edge"]["source_id"], "n_user")
        self.assertEqual(v["edge"]["target_id"], "n_xdu")

    def test_unfixable_direction_dropped(self):
        v = gate.gate_edge(fact("n_xdu", "n_run", "就读于"), CTX, enabled=True)
        self.assertEqual((v["action"], v["reason"]), ("drop", "bad-endpoint-type"))

    def test_unknown_kind_dropped(self):
        v = gate.gate_edge(cooccur("n_run", "n_tako", kind="made_up_kind"), CTX, enabled=True)
        self.assertEqual((v["action"], v["reason"]), ("drop", "bad-endpoint-type"))

    def test_predicate_outside_table_passes(self):
        v = gate.gate_edge(fact("n_run", "n_tako", "觉得不错"), CTX, enabled=True)
        self.assertTrue(v["accepted"], v)


class RuleR5SlotIsolation(unittest.TestCase):
    """R5:新边不得挤 `slot = source_id||'|'||relation`,必须走独立 kind 维度。"""

    def test_shadow_relation_normalised_to_reserved(self):
        v = gate.gate_edge(cooccur("n_run", "n_tako", relation="相关"), CTX, enabled=True)
        self.assertEqual(v["action"], "rewrite")
        self.assertEqual(v["reason"], "slot-conflict")
        self.assertEqual(v["edge"]["relation"], "共现")

    def test_shadow_edge_never_lands_in_fact_slot(self):
        ctx = gate.build_context(NODES, ALIASES, existing_fact_slots={"n_xdu|就读于"},
                                 speakers=LEGACY_SPEAKERS,
                                 person_names=LEGACY_PERSON_NAMES)
        v = gate.gate_edge(cooccur("n_xdu", "n_run", relation="就读于"), ctx, enabled=True)
        self.assertTrue(v["accepted"], v)
        self.assertEqual(v["edge"]["relation"], "共现")
        slot = "%s|%s" % (v["edge"]["source_id"], v["edge"]["relation"])
        self.assertNotIn(slot, ctx["existing_fact_slots"])

    def test_fact_edge_with_reserved_relation_dropped(self):
        v = gate.gate_edge(fact("n_run", "n_tako", "共现"), CTX, enabled=True)
        self.assertEqual((v["action"], v["reason"]), ("drop", "slot-conflict"))

    def test_reserved_slot_already_taken_dropped(self):
        ctx = gate.build_context(NODES, ALIASES, existing_fact_slots={"n_run|共现"},
                                 speakers=LEGACY_SPEAKERS,
                                 person_names=LEGACY_PERSON_NAMES)
        v = gate.gate_edge(cooccur("n_run", "n_tako"), ctx, enabled=True)
        self.assertEqual((v["action"], v["reason"]), ("drop", "slot-conflict"))

    def test_writer_does_not_trigger_slot_yield(self):
        """端到端:写影子边**不会**让既有事实边让位(`graph.py:404-410` 不被触发)。

        路线 2 的强版本:影子边落在**另一张表** ⇒ `graph_edges` 连行数都不变。
        """
        tmp, conn = fresh_conn()
        self.addCleanup(tmp.cleanup)
        self.addCleanup(conn.close)
        graph.add_edge(conn, "用户", "就读于", "西安电子科技大学", OWNER)
        before = fact_rows(conn)
        self.assertEqual(len(before), 1)
        self.assertEqual(before[0][2], 1, "事实边出生即现役")

        accepted = gate.gate_edges([cooccur("n_xdu", "n_run", relation="就读于")],
                                   CTX, enabled=True)["accepted"]
        written = gate.write_accepted_edges(conn, accepted, OWNER)
        # 一对 × 两条证据记忆(夹具默认 `evidence=(701, 702)`)⇒ **两条证据行**,
        # 但只有**一个** pair(它被两条记忆作证)。这正是 n 元形状:证据多了,边不多。
        self.assertEqual((written["inserted"], written["updated"], written["warnings"]),
                         (2, 0, 0))
        self.assertEqual(written["pairs"], 2, "1 个 pair × 2 条证据行 = 2 个 pair 引用")
        self.assertEqual(written["shadow_rows_before"], written["shadow_rows_after"],
                         "写口碰了影子表(它已冻结)")

        self.assertEqual(fact_rows(conn), before, "graph_edges 被影子边碰了")
        rows = cooc_rows(conn, "scope_kind, memory_id, node_ids, pairs")
        self.assertEqual(len(rows), 2, "两条证据:记忆 701 / 702 各一行")
        self.assertEqual({int(r[1]) for r in rows}, {701, 702})
        self.assertEqual({str(r[0]) for r in rows}, {"same_memory"})
        self.assertEqual(shadow_count(conn, owner=OWNER), 0,
                         "影子表冻结:写口一行都不许再新增")

    def test_writer_is_idempotent(self):
        tmp, conn = fresh_conn()
        self.addCleanup(tmp.cleanup)
        self.addCleanup(conn.close)
        accepted = gate.gate_edges([cooccur("n_xdu", "n_run"), cooccur("n_run", "n_tako")],
                                   CTX, enabled=True)["accepted"]
        first = gate.write_accepted_edges(conn, accepted, OWNER)
        second = gate.write_accepted_edges(conn, accepted, OWNER)
        # 两个 pair × 两条证据记忆 ⇒ 2 条证据行 / 4 个 pair 引用(桶内并集)
        self.assertEqual((first["inserted"], first["updated"], first["skipped"]), (2, 0, 0))
        self.assertEqual(first["pairs"], 4)
        # 第二跑:并集不变、max 不变 ⇒ 既不新增也不更新(落库改动数 = 0)
        self.assertEqual((second["inserted"], second["updated"], second["skipped"]),
                         (0, 0, 2))
        self.assertEqual(cooc_count(conn), 2)
        self.assertEqual(cooc_pair_rows(conn), 4, "两个 pair × 两条证据")
        self.assertEqual(len(cooc_pairs(conn)), 2, "去重后还是两个 pair")
        self.assertEqual(edges_dump(conn), [], "影子边一条都不许落进 graph_edges")
        self.assertEqual(shadow_count(conn, owner=OWNER), 0, "影子表冻结")


class RuleR2KindAwareScope(unittest.TestCase):
    """裁决①(2026-10-01):R2 **按谓词取判据** —— 同记忆看交集、同天看"两端各自非空"。

    要点:**R2 得活着**。不许用"不带两端 ids"把判据悄悄拔掉(那会让 R2 退化成
    "证据非空即过");正确做法是换**对的谓词**去判。
    """

    def _same_day(self, left, right, **over):
        cand = {
            "kind": gate.KIND_COOCCUR_SAME_DAY,
            "evidence_scope": gate.EVIDENCE_SCOPE_SAME_DAY,
            "source_id": "n_run", "target_id": "n_tako",
            "source_name": "校园跑", "target_name": "章鱼小丸子",
            "source_kind": "node", "target_kind": "node",
            "relation": "同日共现",
            "source_memory_ids": left, "target_memory_ids": right,
            "evidence_memory_id": (left or []) + (right or []),
            "weight": 1.0, "count": 1,
        }
        cand.update(over)
        return cand

    def test_same_day_cross_memory_pair_passes(self):
        """跨记忆的同天对(交集为空、两端各自非空)现在**必须过** —— 这就是那 42 条。"""
        v = gate.gate_edge(self._same_day([1], [2]), CTX, enabled=True)
        self.assertTrue(v["accepted"], v)

    def test_same_day_both_sides_required(self):
        """两端各自都要有依据:任何一端为空 ⇒ 没有"同一处" ⇒ 仍丢(判据没被拔掉)。"""
        for left, right in (([], [2]), ([1], []), ([], [])):
            with self.subTest(left=left, right=right):
                v = gate.gate_edge(self._same_day(left, right), CTX, enabled=True)
                self.assertEqual((v["action"], v["reason"]), ("drop", "zero-overlap"))

    def test_same_memory_still_guarded_by_intersection(self):
        """同记忆边**保持交集判据**:两端各自非空但不相交 ⇒ 仍丢。"""
        cand = cooccur("n_run", "n_tako", source_memory_ids=[1], target_memory_ids=[2])
        v = gate.gate_edge(cand, CTX, enabled=True)
        self.assertEqual((v["action"], v["reason"]), ("drop", "zero-overlap"))

    def test_scope_defaults_by_kind_when_absent(self):
        """老候选/手工候选不带 `evidence_scope` 时,按 kind 推口径(不猜第三种)。"""
        cand = self._same_day([1], [2])
        cand.pop("evidence_scope")
        self.assertTrue(gate.gate_edge(cand, CTX, enabled=True)["accepted"])
        self.assertEqual(gate._default_evidence_scope(gate.KIND_COOCCUR_SAME_DAY),
                         gate.EVIDENCE_SCOPE_SAME_DAY)
        self.assertEqual(gate._default_evidence_scope(gate.KIND_COOCCUR_SAME_MEMORY),
                         gate.EVIDENCE_SCOPE_SAME_MEMORY)

    def test_receipt_carries_evidence_scope(self):
        dropped = gate.gate_edges([self._same_day([], [2])], CTX, enabled=True)["receipts"]
        self.assertEqual(dropped[0]["evidence_scope"], "same_day")
        dropped2 = gate.gate_edges([cooccur("n_user", "n_xdu")], CTX,
                                   enabled=True)["receipts"]
        self.assertEqual(dropped2[0]["evidence_scope"], "same_memory")

    def test_receipt_table_has_evidence_scope_column(self):
        tmp, conn = fresh_conn()
        self.addCleanup(tmp.cleanup)
        self.addCleanup(conn.close)
        cols = {r[1] for r in conn.execute(
            "PRAGMA table_info(graph_edge_receipts)").fetchall()}
        self.assertIn("evidence_scope", cols)

    def test_scope_persisted_into_receipts_table(self):
        tmp, conn = fresh_conn()
        self.addCleanup(tmp.cleanup)
        self.addCleanup(conn.close)
        gated = gate.gate_edges([self._same_day([], [2])], CTX, enabled=True)
        gate.write_receipts(conn, gated["receipts"], run_id="scope-run")
        row = conn.execute(
            "SELECT evidence_scope, reason FROM graph_edge_receipts WHERE run_id = ?",
            ("scope-run",)).fetchone()
        self.assertEqual(tuple(row), ("same_day", "zero-overlap"))


class ShadowAccumulation(unittest.TestCase):
    """裁决②(S1):同一处的再表述 = **累加**,不是"被槽位吞掉"、更不是"新开一条边"。

    路线 2(2026-10-01):累加语义落在 `graph_shadow_edges`;
    **v2-A4(2026-10-01)**:落点换成 n 元证据层 `graph_cooc_evidence` ——
    每次再表述**在对应的证据行内并集累加**(每条记忆 / 每天各一行),
    每条用例额外钉一句"`graph_edges` 一个字节没动 + 影子表冻结"。
    """

    def _write(self, conn, cands):
        gated = gate.gate_edges(cands, CTX, enabled=True)
        return gated, gate.write_accepted_edges(conn, gated["accepted"], OWNER)

    def test_restatement_accumulates_evidence_and_count(self):
        tmp, conn = fresh_conn()
        self.addCleanup(tmp.cleanup)
        self.addCleanup(conn.close)
        _, first = self._write(conn, [cooccur("n_run", "n_tako",
                                             source_memory_ids=[1], target_memory_ids=[1],
                                             evidence_memory_id=[1], count=1, weight=1.0)])
        self.assertEqual((first["inserted"], first["updated"]), (1, 0))
        # 第二次表述:同一对,证据多了一条记忆(记忆 2 也作证)⇒ 记忆 1 那行走更新、
        # 记忆 2 那条是**新证据**(n 元形状:证据是"哪条记忆里同时出现",不是边的属性)
        _, second = self._write(conn, [cooccur("n_run", "n_tako",
                                              source_memory_ids=[1, 2], target_memory_ids=[1, 2],
                                              evidence_memory_id=[1, 2], count=2, weight=2.0)])
        self.assertEqual((second["inserted"], second["updated"], second["skipped"]), (1, 1, 0),
                         "记忆 1 那行走更新、记忆 2 新开一条证据行")
        rows = cooc_rows(conn, "memory_id, pairs, weight")
        self.assertEqual(len(rows), 2, "两条证据(每条记忆一行)")
        self.assertEqual({int(r[0]) for r in rows}, {1, 2})
        self.assertEqual(max(float(r[2]) for r in rows), 2.0, "weight 必须累加到 2")
        self.assertEqual(len(cooc_pairs(conn)), 1, "还是一对(pair 不再单独立行)")
        self.assertEqual(shadow_count(conn, owner=OWNER), 0, "影子表冻结")
        self.assertEqual(edges_dump(conn), [], "graph_edges 一行都不许有")

    def test_repeat_is_idempotent_zero_changes(self):
        tmp, conn = fresh_conn()
        self.addCleanup(tmp.cleanup)
        self.addCleanup(conn.close)
        cand = cooccur("n_run", "n_tako", source_memory_ids=[1], target_memory_ids=[1],
                       evidence_memory_id=[1], count=1, weight=1.0)
        self._write(conn, [cand])
        dump = shadow_dump(conn)
        _, again = self._write(conn, [cand])
        self.assertEqual((again["inserted"], again["updated"], again["skipped"]), (0, 0, 1))
        self.assertEqual(shadow_dump(conn), dump, "复跑改了行内容(不幂等)")

    def test_dmae_state_is_never_touched(self):
        """影子边不是"被想起":DMAE 那套状态列**结构上就不在它身上**。

        路线 2 的强版本:不是"我们不去动那些列",而是**那张表根本没有**这些列
        (`last_accessed / half_life / recall_count / activation`)—— 少一列就红。
        """
        tmp, conn = fresh_conn()
        self.addCleanup(tmp.cleanup)
        self.addCleanup(conn.close)
        for table in (SHADOW, EVIDENCE):
            cols = {r[1] for r in conn.execute("PRAGMA table_info(" + table + ")")}
            for banned in ("activation", "half_life", "recall_count", "last_accessed",
                           "layer", "superseded_by", "intrinsic_value", "slot"):
                self.assertNotIn(banned, cols,
                                 table + " 不该有 DMAE/检索状态列:" + banned)
        self._write(conn, [cooccur("n_run", "n_tako", source_memory_ids=[1],
                                   target_memory_ids=[1], evidence_memory_id=[1])])
        # 再表述只许动 pairs / pair_count / weight 这组**可累加**字段;
        # 行身份(哪条记忆 / 哪一天 / 什么时候记下的)一个字节都不许动。
        stable = ("evidence_id", "owner_key", "scope_kind", "memory_id", "day_key",
                  "node_ids", "source_kind", "created_at")
        query = "SELECT " + ", ".join(stable) + " FROM " + EVIDENCE + " ORDER BY evidence_id"
        before_stable = [tuple(str(c) for c in r) for r in conn.execute(query)]
        self._write(conn, [cooccur("n_run", "n_tako", source_memory_ids=[1, 5],
                                   target_memory_ids=[1, 5], evidence_memory_id=[1, 5],
                                   count=2, weight=2.0)])
        after_stable = [tuple(str(c) for c in r) for r in conn.execute(query)]
        self.assertEqual(after_stable[0], before_stable[0],
                         "已存在的那条证据行,身份字段被动了:" + repr(stable))
        self.assertEqual(len(after_stable), 2, "记忆 1 / 记忆 5 各一条证据")

    def test_occurred_at_takes_max(self):
        """同日边:桶键 = **那一天**;再写更早的一天只会**新开一行**,绝不把旧桶往回拨。

        (路线 2 里这条测的是"同一对的 occurred_at 取 max";n 元形状下时间不再是
        边的属性,而是**桶键本身** —— 所以要证的不变量变成"桶不会被改写/回拨"。)
        """
        tmp, conn = fresh_conn()
        self.addCleanup(tmp.cleanup)
        self.addCleanup(conn.close)
        day = dict(kind="cooccur_same_day", evidence_scope="same_day",
                   occurred_at_source="same_day_group")
        self._write(conn, [cooccur("n_run", "n_tako", occurred_at=300.0, **day)])
        self._write(conn, [cooccur("n_run", "n_tako", occurred_at=50.0, **day)])
        rows = cooc_rows(conn, "scope_kind, day_key")
        self.assertEqual({(str(r[0]), str(r[1])) for r in rows},
                         {("same_day", "300"), ("same_day", "50")},
                         "两天各一桶;旧桶的时间不许被往回拨")
        self.assertEqual(cooc_pair_rows(conn), 2, "同一对在两天里各作证一次")
        self.assertEqual(len(cooc_pairs(conn)), 1, "去重后还是一对")
        self.assertEqual(edges_dump(conn), [])

    def test_fact_edge_on_shadow_slot_warns_and_is_left_alone(self):
        """⚠️ 留痕/告警:保留谓词槽位被 `graph_edges` 占着 ⇒ 不动它、计 warnings、打一行 stderr。"""
        tmp, conn = fresh_conn()
        self.addCleanup(tmp.cleanup)
        self.addCleanup(conn.close)
        graph.add_edge(conn, "校园跑", "共现", "章鱼小丸子", OWNER)
        before = edges_dump(conn)
        gated = gate.gate_edges([_cooccur_named(conn, "校园跑", "章鱼小丸子")],
                                CTX, enabled=True)["accepted"]
        buf = io.StringIO()
        with contextlib.redirect_stderr(buf):
            result = gate.write_accepted_edges(conn, gated, OWNER)
        self.assertEqual(result["warnings"], 1)
        self.assertEqual((result["inserted"], result["updated"]), (0, 0))
        self.assertIn("保留谓词槽位", buf.getvalue())
        self.assertEqual(edges_dump(conn), before, "事实边一个字节都不许动")
        self.assertEqual(shadow_count(conn, owner=OWNER), 0, "不许为它新开一条")

    def test_fact_kind_input_is_not_our_channel(self):
        """闸门的写口只吃影子边:事实边形状的输入进来一律跳过、**不告警**(不是它的活儿)。"""
        tmp, conn = fresh_conn()
        self.addCleanup(tmp.cleanup)
        self.addCleanup(conn.close)
        result = gate.write_accepted_edges(conn, [fact("n_user", "n_xdu", "就读于")], OWNER)
        self.assertEqual((result["inserted"], result["updated"], result["warnings"]),
                         (0, 0, 0))
        self.assertEqual(edges_dump(conn), [], "graph_edges 不该被写")
        self.assertEqual(shadow_count(conn, owner=OWNER), 0)

    def test_slot_deactivation_hazard_is_gone_by_construction(self):
        """路线 2 让"槽位让位"这条老风险**结构上消失**:两张表,谁也停用不了谁。

        留痕:若真有事实边用保留谓词(`共现`)落进 `graph_edges` 的同槽位,
        `add_edge` 只会停用 `graph_edges` 里的旧行 —— 影子行在**另一张表**,不受影响;
        同时闸门的写口会**告警**(保留谓词槽位被占用)。
        """
        tmp, conn = fresh_conn()
        self.addCleanup(tmp.cleanup)
        self.addCleanup(conn.close)
        graph.get_or_create_node(conn, "校园跑")
        graph.get_or_create_node(conn, "章鱼小丸子")
        gated = gate.gate_edges([_cooccur_named(conn, "校园跑", "章鱼小丸子")],
                                CTX, enabled=True)["accepted"]
        gate.write_accepted_edges(conn, gated, OWNER)
        before_ev = cooc_rows(conn, "memory_id, node_ids, pairs")
        self.assertEqual(len(before_ev), 2, "两条证据(夹具默认 evidence=(701,702))")
        # 同一对换宾语的事实边(谓词恰好是保留名"共现")
        graph.get_or_create_node(conn, "音理")
        graph.add_edge(conn, "校园跑", "共现", "音理", OWNER)
        self.assertEqual(cooc_rows(conn, "memory_id, node_ids, pairs"), before_ev,
                         "共现证据被事实边的槽位让位动了?证据层没有槽位,这不可能")
        # 而事实边自己按老规矩留在 graph_edges 里(它的事)
        self.assertEqual(len(fact_rows(conn, owner=OWNER)), 1)
        self.assertEqual(shadow_count(conn, owner=OWNER), 0, "影子表冻结")


class ShadowOwnerIsolation(unittest.TestCase):
    """卡口 1 · 方案 A + 路线 2:影子边用独立归属键,**并且另住一张表**。"""

    def _fingerprint(self, conn, owner):
        return load_fingerprint(conn, owner)

    def test_shadow_owner_constant_is_single_source(self):
        self.assertEqual(gate.SHADOW_OWNER, "__shadow__")
        self.assertEqual(gate.SHADOW_TABLE, "graph_shadow_edges")
        worker_src = (REPO / "python" / "worker.py").read_text(encoding="utf-8")
        self.assertIn("graph_gate.SHADOW_OWNER", worker_src, "worker 没传影子归属键")
        self.assertNotIn("maybe_gate_shadow_edges(conn, owner", worker_src,
                         "worker 还在用事实边的 owner 传影子边")

    def test_shadow_write_keeps_master_load_bit_identical(self):
        tmp, conn = fresh_conn()
        self.addCleanup(tmp.cleanup)
        self.addCleanup(conn.close)
        graph.add_edge(conn, "校园跑", "喜欢", "章鱼小丸子", "master")
        graph.get_or_create_node(conn, "音理")
        edges_before = edges_dump(conn)
        before, _ = self._fingerprint(conn, "master")
        gated = gate.gate_edges([_cooccur_named(conn, "校园跑", "章鱼小丸子"),
                                 _cooccur_named(conn, "校园跑", "音理")],
                                CTX, enabled=True)["accepted"]
        written = gate.write_accepted_edges(conn, gated, gate.SHADOW_OWNER)
        # 两条候选 × 两条证据记忆(夹具默认)= **两个桶**,每桶里两对
        self.assertEqual(written["inserted"], 2, str(written))
        self.assertEqual(written["pairs"], 4)
        after, payload_after = self._fingerprint(conn, "master")
        self.assertEqual(before, after, "load('master') 指纹变了 —— 共现漏进检索了")
        self.assertEqual(len(payload_after[2]), 1, "master 名下只该有那条事实边")
        self.assertEqual(edges_dump(conn), edges_before,
                         "graph_edges 全表被共现改动了")
        self.assertEqual(shadow_count(conn), 0, "影子表冻结(写口不再往它加行)")
        # 共现层自己的读口(阶段 4 用):显式调用,不经检索路径
        stats = gate.shadow_stats(conn)
        self.assertEqual(stats["active_shadow_edges"], 0, "冻结的影子表 = 0")
        self.assertEqual(stats["cooc_evidence_rows"], 2, "两条证据行")
        self.assertEqual(stats["cooc_nodes"], 3, "校园跑/章鱼小丸子/音理")
        self.assertEqual(stats["cooc_pair_rows"], 4, "视图按需派生 4 行 pair")
        self.assertEqual(stats["cooc_pairs_with_fact_edge"], 1,
                         "校园跑–章鱼小丸子已经有事实边了")

    def test_other_owner_scoped_readers_see_nothing(self):
        """检索(load)/ L0 治理 / 谓词归并三条 owner 读口都看不见影子边。"""
        tmp, conn = fresh_conn()
        self.addCleanup(tmp.cleanup)
        self.addCleanup(conn.close)
        graph.add_edge(conn, "校园跑", "喜欢", "章鱼小丸子", "master")

        def snap():
            return sorted([tuple(str(x) for x in r) for r in conn.execute(
                "SELECT edge_id, source_id, target_id, relation, weight, layer, is_active"
                " FROM graph_edges WHERE owner_key = ? ORDER BY edge_id",
                ("master",)).fetchall()])

        before_master = snap()
        before_l0 = conn.execute(
            "SELECT COUNT(*) FROM graph_edges WHERE owner_key = ? AND layer = 'L0'",
            ("master",)).fetchone()[0]
        gated = gate.gate_edges([cooccur("n_run", "n_tako")], CTX, enabled=True)["accepted"]
        gate.write_accepted_edges(conn, gated, gate.SHADOW_OWNER)
        graph.merge_relation_variants(conn, "master")
        l0_tier.migrate(conn, "master")
        self.assertEqual(snap(), before_master, "谓词归并/L0 治理之后 master 的边行变了")
        self.assertEqual(conn.execute(
            "SELECT COUNT(*) FROM graph_edges WHERE owner_key = ? AND layer = 'L0'",
            ("master",)).fetchone()[0], before_l0)
        # 影子边连 owner 都不在 graph_edges 里 ⇒ L0 那一列它根本没有
        self.assertEqual(conn.execute(
            "SELECT COUNT(*) FROM graph_edges WHERE owner_key = ?",
            (gate.SHADOW_OWNER,)).fetchone()[0], 0, "影子边漏进 graph_edges 了")
        self.assertNotIn("layer", {r[1] for r in conn.execute(
            "PRAGMA table_info(" + SHADOW + ")")}, "影子表不该有 layer 列")


class DmaeExcludesShadowEdges(unittest.TestCase):
    """裁决②·DMAE 治本:物化/剪枝只看事实边(既有事实边零变化)。

    路线 2:`graph_edges` 里**根本没有**影子行 ⇒ `kind` 过滤是"将来保险";
    这里的核心断言换成"影子表在 DMAE 前后逐位不变 + 事实边行为与无影子时一致"。
    """

    FUTURE = 1_800_000_000.0
    BUCKETS = {"last_materialize_bucket": -1, "last_prune_bucket": -1}

    def _shadow_state(self, conn):
        return shadow_dump(conn)

    def _cooc_state(self, conn):
        return cooc_dump(conn)

    def _fact_state(self, conn):
        return sorted([tuple(str(x) for x in r) for r in conn.execute(
            "SELECT edge_id, activation, half_life, recall_count, last_accessed, weight"
            " FROM graph_edges WHERE COALESCE(kind,'') = '' ORDER BY edge_id").fetchall()])

    def _seed(self, conn, with_shadow=True):
        graph.add_edge(conn, "校园跑", "喜欢", "章鱼小丸子", "master")
        graph.add_edge(conn, "西安电子科技大学", "位于", "西安", "master")
        if with_shadow:
            gated = gate.gate_edges([_cooccur_named(conn, "校园跑", "章鱼小丸子"),
                                     _cooccur_named(conn, "西安电子科技大学", "校园跑")],
                                    CTX, enabled=True)["accepted"]
            gate.write_accepted_edges(conn, gated, gate.SHADOW_OWNER)

    def test_prune_never_deletes_shadow_edges(self):
        tmp, conn = fresh_conn()
        self.addCleanup(tmp.cleanup)
        self.addCleanup(conn.close)
        self._seed(conn)
        shadow_before = self._shadow_state(conn)
        cooc_before = self._cooc_state(conn)
        self.assertEqual(len(cooc_before), 2, "两条证据行(n 元)")
        self.assertEqual(len(shadow_before), 0, "影子表冻结:一行都没有")
        graph.update_and_persist(conn, [], self.FUTURE, buckets=dict(self.BUCKETS))
        self.assertEqual(self._cooc_state(conn), cooc_before,
                         "共现证据被 DMAE 动了 / 被删了")
        self.assertEqual(self._shadow_state(conn), shadow_before, "影子表被动了")
        self.assertEqual(conn.execute(
            "SELECT COUNT(*) FROM graph_edges WHERE COALESCE(kind,'') != ''").fetchone()[0], 0,
            "graph_edges 里不该有影子行")

    def test_materialize_does_not_write_shadow_activation(self):
        tmp, conn = fresh_conn()
        self.addCleanup(tmp.cleanup)
        self.addCleanup(conn.close)
        self._seed(conn)
        shadow_before = self._shadow_state(conn)
        cooc_before = self._cooc_state(conn)
        graph.update_and_persist(conn, [], self.FUTURE, buckets=dict(self.BUCKETS))
        self.assertEqual(self._shadow_state(conn), shadow_before)
        self.assertEqual(self._cooc_state(conn), cooc_before,
                         "DMAE 动了共现证据(= 那成了检索层的输入)")
        self.assertNotIn("activation", {r[1] for r in conn.execute(
            "PRAGMA table_info(" + SHADOW + ")")}, "影子表结构上就没有 activation")
        self.assertNotIn("activation", {r[1] for r in conn.execute(
            "PRAGMA table_info(" + EVIDENCE + ")")}, "证据表结构上就没有 activation")

    def test_fact_edge_dmae_behaviour_unchanged(self):
        """影子边在场与否,不改变事实边的 DMAE 结果(前后逐位)。"""
        tmp_a, conn_a = fresh_conn()
        tmp_b, conn_b = fresh_conn()
        self.addCleanup(tmp_a.cleanup)
        self.addCleanup(tmp_b.cleanup)
        self.addCleanup(conn_a.close)
        self.addCleanup(conn_b.close)
        self._seed(conn_a, with_shadow=True)
        self._seed(conn_b, with_shadow=False)
        step_a = graph.update_and_persist(conn_a, [], self.FUTURE, buckets=dict(self.BUCKETS))
        step_b = graph.update_and_persist(conn_b, [], self.FUTURE, buckets=dict(self.BUCKETS))
        self.assertEqual(self._fact_state(conn_a), self._fact_state(conn_b),
                         "事实边的 DMAE 行为被影子边带偏了")
        self.assertEqual(step_a["pruned"], step_b["pruned"])
        self.assertEqual(step_a["edges"], step_b["edges"], "喂给 DMAE 的边数该只算事实边")

    def test_kind_less_db_is_tolerated(self):
        """老库还没有 `kind` 列时退回不过滤(那时也不存在影子边)。"""
        raw = sqlite3.connect(":memory:")
        self.addCleanup(raw.close)
        raw.executescript(
            "CREATE TABLE graph_edges (edge_id INTEGER PRIMARY KEY, source_id TEXT,"
            " target_id TEXT, relation TEXT, activation REAL DEFAULT 0,"
            " intrinsic_value REAL DEFAULT 0, half_life REAL DEFAULT 0,"
            " recall_count INTEGER DEFAULT 0, last_accessed REAL DEFAULT 0,"
            " weight REAL DEFAULT 1);"
            "CREATE TABLE graph_nodes (node_id TEXT PRIMARY KEY, name TEXT,"
            " node_type TEXT, is_protected INTEGER DEFAULT 0, owner_key TEXT);"
            "INSERT INTO graph_edges (source_id, target_id, relation) VALUES ('a','b','r');")
        step = graph.update_and_persist(raw, [], self.FUTURE, buckets=dict(self.BUCKETS))
        self.assertEqual(step["edges"], 1, "没有 kind 列的老库应当照旧全量喂进去")


class ShadowTableZeroLeak(unittest.TestCase):
    """中心承诺:**共现写多少条,现有读路径一个字都不变**。

    夹具:一张有节点、有事实边的小库 → 记下所有**生产读口**的读数 → 往共现层灌
    47 对 → 所有读数**逐位一致**;同时共现层自己的读口(`shadow_stats`)从 0 变成
    47(证明确实写进去了)。影子表**冻结**(写口不再往它加行)。
    """

    PEERS = ("校园跑", "章鱼小丸子", "舞萌", "Echo", "用户", "西安电子科技大学",
             "软件工程", "老乡鸡", "麦当劳", "时间管理")

    def _nodes(self, conn):
        ids = {"音理": graph.get_or_create_node(conn, "音理", "concept", "master")}
        for name in self.PEERS:
            ids[name] = graph.get_or_create_node(conn, name, "concept", "master")
        conn.commit()
        return ids

    def _seed(self, conn):
        graph.add_edge(conn, "校园跑", "相关", "章鱼小丸子", "master")
        graph.add_edge(conn, "音理", "在意", "Echo", "master")
        conn.commit()

    def _readings(self, conn):
        return {
            "load_master": load_fingerprint(conn, "master"),
            "top_nodes": graph.top_nodes(conn, "master", limit=20),
            "graph_edges": edges_dump(conn),
            "graph_nodes": [tuple(str(c) for c in r) for r in conn.execute(
                "SELECT * FROM graph_nodes ORDER BY node_id")],
            "l0_demoted": l0_tier.migrate(conn, "master"),
        }

    def _flood(self, conn, ids, n=47):
        """47 条**不同对**的影子边,直接喂闸门写口(存储层测试,不绕 R 规则)。"""
        anchor = ids["音理"]
        peers = [nid for name, nid in ids.items() if name != "音理"]
        pairs = [(anchor, nid) for nid in peers]
        pairs += [(a, b) for i, a in enumerate(peers) for b in peers[i + 1:]]
        self.assertGreaterEqual(len(pairs), n, "夹具节点不够,凑不出 n 条不重复的对")
        accepted = [{
            "kind": gate.KIND_COOCCUR_SAME_DAY,
            "source_kind": "node", "target_kind": "node", "endpoint_kind": "node",
            "source_id": src, "target_id": tgt, "relation": "同日共现",
            "evidence_memory_id": [700 + k], "weight": 1.0, "count": 1,
            "occurred_at": 1759276800.0, "occurred_at_source": "same_day_group",
            "evidence_scope": gate.EVIDENCE_SCOPE_SAME_DAY,
        } for k, (src, tgt) in enumerate(pairs[:n])]
        return gate.write_accepted_edges(conn, accepted, gate.SHADOW_OWNER)

    def test_47_shadow_edges_change_no_existing_reading(self):
        """47 对共现 → 证据层里是**一行 47 对的 n 元证据**,读数逐位一致。

        (路线 2 里这 47 对进影子表是 47 行;v2-A4 起它们落在**同一天那一桶** ——
        47 行 pair 变成 1 行证据 + 47 个 pair 引用。这正是"不铺 pair 边"的现场。)
        """
        tmp, conn = fresh_conn()
        self.addCleanup(tmp.cleanup)
        self.addCleanup(conn.close)
        self._seed(conn)
        ids = self._nodes(conn)
        before = self._readings(conn)
        self.assertEqual(gate.shadow_stats(conn)["active_shadow_edges"], 0)
        self.assertEqual(gate.shadow_stats(conn)["cooc_evidence_rows"], 0)

        written = self._flood(conn, ids)
        self.assertEqual((written["inserted"], written["updated"],
                          written["table_missing"]), (1, 0, False), str(written))
        self.assertEqual(written["pairs"], 47, "47 个 pair 引用一个不能少")
        self.assertEqual(written["shadow_rows_before"], written["shadow_rows_after"],
                         "写口碰了影子表(它已冻结)")
        after = self._readings(conn)

        for key in ("load_master", "top_nodes", "graph_edges", "graph_nodes", "l0_demoted"):
            with self.subTest(reading=key):
                self.assertEqual(before[key], after[key],
                                 "读口 %s 被共现影响了" % key)
        self.assertEqual(conn.execute(
            "SELECT COUNT(*) FROM graph_edges WHERE COALESCE(kind, '') <> ''").fetchone()[0], 0,
            "graph_edges 里出现了影子行")
        stats = gate.shadow_stats(conn)
        self.assertEqual(stats["active_shadow_edges"], 0, "影子表冻结在 0(本轮不再写它)")
        self.assertEqual(stats["cooc_evidence_rows"], 1, "一天一桶 ⇒ 一行证据")
        self.assertEqual(stats["cooc_nodes"], 11)
        self.assertEqual(stats["cooc_pair_rows"], 47, "视图按需派生 47 行")
        self.assertGreaterEqual(stats["cooc_pairs_with_fact_edge"], 1,
                                "夹具里 校园跑–章鱼小丸子 有事实边")
        # 共现层自己的读口:写口不碰 master 的 load,只在新表里成一套
        self.assertEqual(conn.execute(
            "SELECT COUNT(*) FROM graph_edges WHERE owner_key = ?",
            (gate.SHADOW_OWNER,)).fetchone()[0], 0)
        self.assertEqual(conn.execute(
            "SELECT COUNT(*) FROM " + SHADOW).fetchone()[0], 0, "影子表一行都没新增")

    def _orphan_case(self, with_shadow):
        """同一个夹具,开/关影子边各跑一遍 DMAE(含孤儿回收),返回可比读数。"""
        tmp, conn = fresh_conn()
        self.addCleanup(tmp.cleanup)
        self.addCleanup(conn.close)
        keeper = graph.get_or_create_node(conn, "校园跑", "concept", "master")
        loner = graph.get_or_create_node(conn, "只靠影子的节点", "concept", "master")
        graph.add_edge(conn, "校园跑", "相关", "章鱼小丸子", "master")
        conn.commit()
        if with_shadow:
            written = gate.write_accepted_edges(conn, [{
                "kind": gate.KIND_COOCCUR_SAME_DAY, "source_id": keeper,
                "target_id": loner, "relation": "同日共现",
                "evidence_memory_id": [701], "weight": 1.0,
                "occurred_at": 1759276800.0, "occurred_at_source": "same_day_group",
                "evidence_scope": gate.EVIDENCE_SCOPE_SAME_DAY,
            }], gate.SHADOW_OWNER)
            self.assertEqual((written["inserted"], written["table_missing"]), (1, False))
        graph.update_and_persist(conn, [], DmaeExcludesShadowEdges.FUTURE,
                                 buckets=dict(DmaeExcludesShadowEdges.BUCKETS))
        return {"nodes": sorted(str(r[0]) for r in conn.execute(
                    "SELECT name FROM graph_nodes")),
                "edges": sorted(str(r[0]) for r in conn.execute(
                    "SELECT relation FROM graph_edges")),
                "shadow": shadow_dump(conn),
                "cooc": cooc_dump(conn)}

    def test_orphan_node_is_not_exempted_by_a_shadow_edge(self):
        """#8 孤儿回收:只被**影子边**连着的节点照旧被 DMAE 收走(换表后不豁免)。

        证据口径(差量,不写"必须等于 N"):同一个夹具开/关影子边各跑一次,
        DMAE 之后的 `graph_nodes` **集合**与 `graph_edges` **关系集合**逐位一致;
        影子行本身留档(它不接检索)。
        """
        with_shadow = self._orphan_case(with_shadow=True)
        without = self._orphan_case(with_shadow=False)
        self.assertEqual(with_shadow["nodes"], without["nodes"],
                         "影子边改变了孤儿回收的结果 ⇒ 有节点被豁免了")
        self.assertEqual(with_shadow["edges"], without["edges"],
                         "影子边改变了事实边的 DMAE 结果")
        self.assertNotIn("只靠影子的节点", without["nodes"],
                         "夹具失效:那个只被影子边连着的节点本该被回收")
        self.assertEqual(len(with_shadow["shadow"]), 0, "影子表冻结:写口不再往它加行")
        self.assertEqual(len(with_shadow["cooc"]), 1, "共现证据不该被 DMAE 删")


class TopNodesFactOnly(unittest.TestCase):
    """卡口 2(2026-10-01):`top_nodes()` 的 `LEFT JOIN graph_edges` 只看事实边。

    现场:这段 JOIN 原来只过滤**节点** owner、不过滤**边** owner ⇒ 影子边灌度数,
    把 `音理` 从第 7 名顶到第 2 名 —— 而这张名单正是喂 `extract_prompt` 的
    「已有实体」。修法:`AND COALESCE(e.kind,'')=''` 追加在 **`ON` 子句**里
    (老库无 `kind` 列时退回)。**别写进 `WHERE`**:有影子边的节点会被 `LEFT JOIN`
    匹配上再被 `WHERE` 打掉,整条从榜单消失(实测 12 → 3)。
    """

    PEERS = ("校园跑", "章鱼小丸子", "舞萌", "计算机大类", "做章鱼小丸子", "新工科大学",
             "西安电子科技大学", "聊天", "大一学生", "浪费时间", "网站后端架构")

    def _nodes(self, conn, node_owner="master"):
        """`音理` + 11 个同伴节点(真实形状:id 是随机 16 位十六进制)。"""
        ids = {"音理": graph.get_or_create_node(conn, "音理", "concept", node_owner)}
        for name in self.PEERS:
            ids[name] = graph.get_or_create_node(conn, name, "concept", node_owner)
        conn.commit()
        return ids

    def _seed(self, conn, node_owner="master"):
        """节点 + 两条**事实边**(带 degree 差)。"""
        ids = self._nodes(conn, node_owner)
        graph.add_edge(conn, "校园跑", "相关", "计算机大类", owner_key=OWNER)
        graph.add_edge(conn, "舞萌", "相关", "计算机大类", owner_key=OWNER)
        conn.commit()
        return ids

    def _shadow_flood(self, conn, ids, n=47):
        """47 条形状的影子边:锚点是 `音理`(复刻活库那一次),每对只插一行。"""
        anchor = ids["音理"]
        peers = [nid for name, nid in ids.items() if name != "音理"]
        pairs = [(anchor, nid) for nid in peers]
        pairs += [(a, b) for i, a in enumerate(peers) for b in peers[i + 1:]]
        self.assertGreaterEqual(len(pairs), n, "夹具节点不够,凑不出 n 条不重复的对")
        for k, (src, tgt) in enumerate(pairs[:n]):
            conn.execute(
                "INSERT INTO graph_edges (edge_id, source_id, target_id, relation,"
                " weight, slot, is_active, owner_key, kind, intrinsic_value,"
                " activation, half_life, recall_count, last_accessed)"
                " VALUES (?, ?, ?, '共现', 1, ?, 1, ?, 'cooccur_same_day', 10.0,"
                " 0, 0, 0, 0)",
                (9000 + k, src, tgt, "slot-%d" % k, gate.SHADOW_OWNER))
        conn.commit()
        return len(pairs[:n])

    def test_shadow_edges_do_not_enter_top_nodes(self):
        tmp, conn = fresh_conn()
        self.addCleanup(tmp.cleanup)
        self.addCleanup(conn.close)
        ids = self._seed(conn)
        before = graph.top_nodes(conn, "master", 20)
        self.assertEqual(self._shadow_flood(conn, ids), 47)
        after = graph.top_nodes(conn, "master", 20)
        self.assertEqual(before, after, "影子边不许改榜单")
        self.assertNotEqual(before, [], "榜单不能是空的(否则这条测试等于没跑)")
        self.assertIn("音理", before, "夹具节点得真在榜上")
        # 回归:过滤写在 WHERE 里时,只挂影子边的节点会**整条消失**(实测 12 节点 → 3)
        for name in ("浪费时间", "网站后端架构"):
            self.assertIn(name, after, "只挂影子边的节点不该从榜单里消失:%s" % name)

    def test_all_three_owner_branches_are_guarded(self):
        """`WHERE (owner = ? OR owner IS NULL OR owner = '')` 三条支路都要挡住影子边。

        这是**防 SQL 优先级坑**的回归测试:`AND` 比 `OR` 结合得紧,那个 `OR` 串不
        加括号时会被解析成 `owner = ? OR owner IS NULL OR (owner = '' AND kind...)`
        ⇒ 前两支路上的节点照样灌影子边度数(2026-10-01 实测:`音理` 仍被顶到第 2)。
        """
        for node_owner in ("master", None, ""):
            with self.subTest(node_owner=node_owner):
                tmp, conn = fresh_conn()
                try:
                    ids = {}
                    for name in ("音理",) + self.PEERS:
                        nid = graph.get_or_create_node(conn, name, "concept", "placeholder")
                        conn.execute("UPDATE graph_nodes SET owner_key = ? WHERE node_id = ?",
                                     (node_owner, nid))
                        ids[name] = nid
                    graph.add_edge(conn, "校园跑", "相关", "舞萌", owner_key=OWNER)
                    conn.commit()
                    before = graph.top_nodes(conn, "master", 20)   # 三支路都命中这次查询
                    self.assertNotEqual(before, [], "支路 %r:榜单空了,夹具失效" % node_owner)
                    self._shadow_flood(conn, ids)
                    self.assertEqual(graph.top_nodes(conn, "master", 20), before,
                                     "支路 %r:影子边改动了榜单" % node_owner)
                finally:
                    conn.close()
                    tmp.cleanup()

    def test_fact_edge_still_moves_the_ranking(self):
        """决定性对照的另一半:事实边**照旧**进榜单(证明这条查询没被冻住)。"""
        tmp, conn = fresh_conn()
        self.addCleanup(tmp.cleanup)
        self.addCleanup(conn.close)
        self._seed(conn)
        before = graph.top_nodes(conn, "master", 20)
        # 三条**不同谓词**的事实边(同谓词会走槽位让位,只留一条)
        for rel, tgt in (("相关", "校园跑"), ("同现", "舞萌"), ("一起", "做章鱼小丸子")):
            graph.add_edge(conn, "音理", rel, tgt, owner_key=OWNER)
            conn.commit()
        after = graph.top_nodes(conn, "master", 20)
        self.assertNotEqual(before, after, "事实边进榜才说明查询是活的")
        self.assertEqual(after[0], "音理", "被事实边灌了度数的节点该排到前面")

    def test_fact_edges_only_bit_identical(self):
        """既有数据逐位零变化:既有事实边(`kind=''`)的榜单一个都不动。"""
        tmp, conn = fresh_conn()
        self.addCleanup(tmp.cleanup)
        self.addCleanup(conn.close)
        self._seed(conn)
        raw = conn.execute("SELECT COUNT(*) FROM graph_edges WHERE COALESCE(kind,'')=''"
                          ).fetchone()[0]
        unfiltered = [str(r[0]) for r in conn.execute(
            "SELECT n.name FROM graph_nodes n LEFT JOIN graph_edges e"
            " ON (e.source_id = n.node_id OR e.target_id = n.node_id)"
            " WHERE n.owner_key = ? GROUP BY n.node_id"
            " ORDER BY COUNT(e.edge_id) DESC, n.recall_count DESC LIMIT 20", ("master",)
        ).fetchall()]
        self.assertGreater(raw, 0)
        self.assertEqual(graph.top_nodes(conn, "master", 20), unfiltered,
                         "事实边全是空 kind ⇒ 加过滤后与不加过滤逐位一致")

    def test_kind_less_db_still_returns_names(self):
        """老库没有 `kind` 列时:**退回不过滤**,不能因为 `sqlite3.Error` 变成空榜。"""
        raw = sqlite3.connect(":memory:")
        self.addCleanup(raw.close)
        raw.executescript(
            "CREATE TABLE graph_nodes (node_id TEXT PRIMARY KEY, name TEXT,"
            " node_type TEXT, is_protected INTEGER DEFAULT 0, recall_count INTEGER DEFAULT 0,"
            " owner_key TEXT);"
            "CREATE TABLE graph_edges (edge_id INTEGER PRIMARY KEY, source_id TEXT,"
            " target_id TEXT, relation TEXT, is_active INTEGER DEFAULT 1);"
            "INSERT INTO graph_nodes (node_id, name, owner_key) VALUES ('a','甲','master');"
            "INSERT INTO graph_nodes (node_id, name, owner_key) VALUES ('b','乙','master');"
            "INSERT INTO graph_edges (source_id, target_id, relation) VALUES ('a','b','相关');")
        self.assertEqual(graph.top_nodes(raw, "master", 20), ["甲", "乙"])


class RuleR6NoOccurredAt(unittest.TestCase):
    """R6:无 `occurred_at` 不建时间边;时间来源只认白名单(裁决 C 起含同天来源)。"""

    def test_missing_occurred_at_dropped(self):
        v = gate.gate_edge(temporal(occurred_at=None, source=None), CTX, enabled=True)
        self.assertEqual((v["action"], v["reason"]), ("drop", "no-occurred-at"))

    def test_zero_occurred_at_dropped(self):
        v = gate.gate_edge(temporal(occurred_at=0.0), CTX, enabled=True)
        self.assertEqual((v["action"], v["reason"]), ("drop", "no-occurred-at"))

    def test_fallback_source_dropped(self):
        """`fallback_learned_at` 不是"事情何时发生" ⇒ 同样不认(不猜、不取默认值)。"""
        v = gate.gate_edge(temporal(source="fallback_learned_at"), CTX, enabled=True)
        self.assertEqual((v["action"], v["reason"]), ("drop", "no-occurred-at"))

    def test_memory_side_occurred_at_accepted(self):
        v = gate.gate_edge(temporal(), CTX, enabled=True)
        self.assertTrue(v["accepted"], v)

    def test_r6_only_guards_temporal_edges(self):
        v = gate.gate_edge(cooccur("n_run", "n_tako", occurred_at=None), CTX, enabled=True)
        self.assertTrue(v["accepted"], v)

    def test_same_day_source_now_allowed(self):
        """裁决 C:`same_day_group`(同天边的"那一天")进白名单,不再被当"无时间"丢。"""
        v = gate.gate_edge(temporal(source=gate.TIME_SOURCE_SAME_DAY), CTX, enabled=True)
        self.assertTrue(v["accepted"], v)
        self.assertIn(gate.TIME_SOURCE_SAME_DAY, gate.TIME_SOURCES_ALLOWED)
        self.assertIn(gate.TIME_SOURCE_EPISODIC, gate.TIME_SOURCES_ALLOWED)

    def test_fallback_and_unknown_sources_stay_out(self):
        """白名单是**闭集**:`fallback_learned_at`(导出侧兜底标注)与表外值仍不认。"""
        self.assertNotIn("fallback_learned_at", gate.TIME_SOURCES_ALLOWED)
        self.assertNotIn("", gate.TIME_SOURCES_ALLOWED)
        for source in ("fallback_learned_at", "made_up_source", ""):
            with self.subTest(source=source):
                v = gate.gate_edge(temporal(source=source or None), CTX, enabled=True)
                self.assertEqual((v["action"], v["reason"]), ("drop", "no-occurred-at"))


class Idempotency(unittest.TestCase):
    """幂等:同一批输入跑两次,裁决计数一致,且落库改动数 = 0。"""

    BATCH = None

    @classmethod
    def setUpClass(cls):
        cls.BATCH = [
            cooccur("n_user", "n_xdu"),                       # R1 drop
            cooccur("n_run", "n_tako", relation="就读于"),      # R5 rewrite
            cooccur("n_xd", "n_run"),                          # R3 rewrite
            cooccur("n_run", "n_tako", source_memory_ids=[1], target_memory_ids=[9]),  # R2 drop
            temporal(occurred_at=None, source=None),           # R6 drop
            fact("n_xdu", "n_user", "就读于"),                  # R4 rewrite(方向)
        ]

    def test_gate_rerun_counters_identical(self):
        first = gate.gate_edges(self.BATCH, CTX, enabled=True)
        second = gate.gate_edges(self.BATCH, CTX, enabled=True)
        self.assertEqual(first["counters"], second["counters"])
        self.assertEqual(len(first["dropped"]), len(second["dropped"]))
        self.assertEqual(len(first["rewritten"]), len(second["rewritten"]))
        self.assertEqual([e["relation"] for e in first["accepted"]],
                         [e["relation"] for e in second["accepted"]])

    def test_write_rerun_changes_zero(self):
        tmp, conn = fresh_conn()
        self.addCleanup(tmp.cleanup)
        self.addCleanup(conn.close)
        accepted = gate.gate_edges(self.BATCH, CTX, enabled=True)["accepted"]
        first = gate.write_accepted_edges(conn, accepted, OWNER)
        rows_after_first = conn.execute(
            "SELECT COUNT(*) FROM graph_edges").fetchone()[0]
        second = gate.write_accepted_edges(conn, accepted, OWNER)
        rows_after_second = conn.execute(
            "SELECT COUNT(*) FROM graph_edges").fetchone()[0]
        self.assertGreater(first["inserted"], 0)
        self.assertEqual(second["inserted"], 0, "第二跑改动数必须为 0")
        self.assertEqual(second["updated"], 0, "第二跑不该有更新(并集/max 都不变)")
        self.assertEqual(rows_after_first, rows_after_second)


class DefaultOffInvariance(unittest.TestCase):
    """**默认关 = 零行为变化**(1b 的硬验收)。

    ⚠️ 纪律(2026-10-01,活库真被启用一次之后补的):**活库会迁移、会增长、会有
    历史留痕** ⇒ 任何拿活库**绝对状态**做断言的测试都是脆的(实测:`kind` 列已经
    在活库上了 / 回执行从 0 变成了 77,两条老断言立刻红)。只许断言:
      ① **不变量**(列形状、既有行的值不被迁移改动、幂等);
      ② **差量**(跑前 COUNT → 跑一次 → COUNT 不变)。
    绝不再写"表必须 0 行 / 列必须不存在 / 行数必须等于 N"。
    """

    def test_default_off_is_noop(self):
        batch = [cooccur("n_user", "n_xdu"), cooccur("n_run", "n_tako", relation="就读于"),
                 temporal(occurred_at=None, source=None), fact("n_xdu", "n_user", "就读于")]
        result = gate.gate_edges(batch, CTX)                      # 不给 enabled
        self.assertEqual(result["counters"]["drop"], 0)
        self.assertEqual(result["counters"]["rewrite"], 0)
        self.assertEqual(result["counters"]["accept"], len(batch))
        self.assertEqual(result["accepted"], batch)               # 逐位一致,连改正都不做
        self.assertEqual(result["receipts"], [])                  # 没有改动 ⇒ 没有回执
        self.assertFalse(gate.DEFAULT_ENABLED)
        one = batch[0]
        v = gate.gate_edge(one, CTX)
        self.assertIs(v["edge"], one)
        self.assertEqual((v["action"], v["reason"]), ("accept", None))

    def test_gate_wired_at_exactly_one_place(self):
        """1b 接线纪律:**只有一处**调用口,且事实边路径(`graph.py`)不许碰它。

        P1c 补记(2026-10-05):名字改由壳侧 `names.json` 经帧下发 ⇒ 调用点前面多了一句
        `graph_gate.names_from_frame(frame)`(帧名字解析),`graph_gate` 的出现次数因此
        由 4 变 5。**调用口仍然只有一处** —— 下面第一条断言(数
        `maybe_gate_shadow_edges(`)才是"接线只许一处"的守卫,它一个字没动;
        这里只是把"允许出现的第 5 处"逐一点名,免得这条扫描退化成"随它涨"。
        """
        worker = (REPO / "python" / "worker.py").read_text(encoding="utf-8")
        self.assertEqual(worker.count("maybe_gate_shadow_edges("), 1,
                         "接线口只许一处")
        self.assertEqual(worker.count("graph_gate"), 6,
                         "worker.py 里的 graph_gate 应恰好六处(import + 开关读取 +"
                         " 帧名字解析 names_from_frame + 一处调用 + 影子归属键 SHADOW_OWNER"
                         " + P3-a 的 data_from_frame)")
        self.assertIn("ECHO_GRAPH_GATE", worker, "开关名字要写在调用点上(可追溯)")
        self.assertNotIn("graph_gate", (REPO / "python" / "engine" / "graph.py")
                         .read_text(encoding="utf-8"),
                         "graph.py(事实边写路径)不许提闸门模块")
        self.assertNotIn("graph_gate", (REPO / "lib" / "index.js").read_text(encoding="utf-8"))

    def test_switch_defaults_to_off_and_reads_env(self):
        tmp, conn = fresh_conn()
        self.addCleanup(tmp.cleanup)
        self.addCleanup(conn.close)
        self.assertFalse(gate.gate_enabled({}, config={}), "开关默认必须是关(两路都空)")
        self.assertTrue(gate.gate_enabled({"ECHO_GRAPH_GATE": "1"}))
        self.assertTrue(gate.gate_enabled({"ECHO_GRAPH_GATE": "On"}))
        self.assertFalse(gate.gate_enabled({"ECHO_GRAPH_GATE": "0"}, config={}))
        self.assertFalse(gate.gate_enabled({"ECHO_GRAPH_GATE": ""}, config={}))

        class _NoTouchConn:
            """开关关时,闸门**连库都不许读** —— 任何 execute 都是失败。"""
            def execute(self, *args, **kwargs):
                raise AssertionError("开关关时闸门读了库")

            def commit(self):
                raise AssertionError("开关关时闸门写了库")

        result = gate.maybe_gate_shadow_edges(
            _NoTouchConn(), OWNER, candidates=[cooccur("n_run", "n_tako")],
            enabled=False)
        self.assertEqual(result["enabled"], False)
        self.assertEqual(result["considered"], 0)
        self.assertIsNone(result["counters"])
        self.assertIsNone(result["written"])
        self.assertIsNone(result["receipts"])

        off = gate.maybe_gate_shadow_edges(conn, OWNER,
                                           candidates=[cooccur("n_run", "n_tako")],
                                           enabled=False)
        self.assertEqual(off["enabled"], False)
        self.assertEqual(conn.execute("SELECT COUNT(*) FROM graph_edges").fetchone()[0], 0)

    def test_switch_off_env_leaves_db_untouched(self):
        """环境变量口径下(默认无 ECHO_GRAPH_GATE)开一次 = 什么都不发生。"""
        tmp, conn = fresh_conn()
        self.addCleanup(tmp.cleanup)
        self.addCleanup(conn.close)
        graph.add_edge(conn, "用户", "就读于", "西安电子科技大学", OWNER)
        before = self._dump_all(conn)
        # `enabled=False` 显式给:这条量的是"关"那一个分支,不许受开发机环境/活配置影响
        gate.maybe_gate_shadow_edges(conn, OWNER, candidates=[cooccur("n_run", "n_tako")],
                                     enabled=False)
        self.assertEqual(self._dump_all(conn), before)

    def test_switch_second_route_is_the_panel_config_file(self):
        """阶段 4:第二路 = 插件设置文件里的 `graphShadowEdges`(**严格 True** 才算开)。

        面板拨的就是这个键;引擎**每帧现读该文件** ⇒ 拨一下下一帧生效。
        """
        tmpfile = tempfile.TemporaryDirectory()
        self.addCleanup(tmpfile.cleanup)
        cfg = Path(tmpfile.name) / "config.json"
        empty = {"ECHO_GRAPH_GATE": "", gate.SWITCH_CONFIG_PATH_ENV: str(cfg)}

        self.assertFalse(gate.gate_enabled(empty), "文件不存在 ⇒ 关")
        cfg.write_text("{}", encoding="utf-8")
        self.assertFalse(gate.gate_enabled(empty), "没这个键 ⇒ 关")
        for bad in ("false", '"true"', "1", '"1"', "null", "[]"):
            cfg.write_text('{"graphShadowEdges": ' + bad + "}", encoding="utf-8")
            self.assertFalse(gate.gate_enabled(empty),
                             "非严格布尔被当成了开:" + bad)
        cfg.write_text("{ 这不是 JSON", encoding="utf-8")
        self.assertFalse(gate.gate_enabled(empty), "坏 JSON ⇒ 关(never-throw)")

        cfg.write_text('{"graphShadowEdges": true}', encoding="utf-8")
        self.assertTrue(gate.gate_enabled(empty), "面板那一路开了 ⇒ 引擎该开")
        # 键名/常量两侧同字(壳侧是单一出处,这边是镜像)
        self.assertEqual(gate.SWITCH_CONFIG_KEY, "graphShadowEdges")
        self.assertEqual(gate.SWITCH_ENV, "ECHO_GRAPH_GATE")

    def test_env_wins_and_file_is_not_even_read(self):
        """env 优先:env 为真时**连文件都不读**(不许被配置层顶掉,也不许多一次 IO)。"""
        with mock.patch.object(gate, "config_flag_enabled",
                               side_effect=AssertionError("env 开着还去读文件")):
            self.assertTrue(gate.gate_enabled({"ECHO_GRAPH_GATE": "1"}))
        # 反例:env 关着时**必须**读文件(否则面板那一路就成了摆设)
        with mock.patch.object(gate, "config_flag_enabled", return_value=True) as m:
            self.assertTrue(gate.gate_enabled({"ECHO_GRAPH_GATE": "0"}))
            self.assertEqual(m.call_count, 1)

    def test_switch_config_path_follows_dsh_home(self):
        """路径推法必须与壳侧 `lib/persona.js` 同一份,否则"同一个文件"成了两回事。"""
        self.assertTrue(gate.switch_config_path({"DSH_HOME": r"C:\tmp\home"})
                        .endswith(os.path.join("echo", "config.json")))
        self.assertIn("home", gate.switch_config_path({"DSH_HOME": r"C:\tmp\home"}))
        self.assertTrue(gate.switch_config_path({}).endswith(
            os.path.join(".dsh", "echo", "config.json")))
        self.assertEqual(gate.switch_config_path(
            {gate.SWITCH_CONFIG_PATH_ENV: r"C:\x\y.json"}), r"C:\x\y.json")

    def test_gate_source_report_shape(self):
        """读数报表与壳侧 `graphGateSourceReport` 同形(判据仍只有 `gate_enabled` 一处)。"""
        self.assertEqual(gate.gate_source({}, config={}),
                         {"on": False, "source": "off", "env": False, "config": False})
        self.assertEqual(gate.gate_source({"ECHO_GRAPH_GATE": "1"}, config={})["source"],
                         "env:" + gate.SWITCH_ENV)
        self.assertEqual(gate.gate_source({"ECHO_GRAPH_GATE": "1"}, config={})["on"], True)
        rep = gate.gate_source({}, config={gate.SWITCH_CONFIG_KEY: True})
        self.assertEqual((rep["on"], rep["source"], rep["env"], rep["config"]),
                         (True, "settings:" + gate.SWITCH_CONFIG_KEY, False, True))
        # 报表的 on 必须与判定函数逐字一致(含脏值)
        for parts in ({"ECHO_GRAPH_GATE": "0"}, {"ECHO_GRAPH_GATE": "on"}, {}):
            self.assertEqual(gate.gate_source(parts, config={})["on"],
                             gate.gate_enabled(parts, config={}))

    def test_switch_off_via_config_file_leaves_db_untouched(self):
        """阶段 4 纪律 ①:**两路都关**跑一轮 ⇒ 三张表差量全 0(与现状逐位一致)。

        同一夹具再给"面板那一路= true",同一批候选就写进去了 —— 证明这条测试
        量的不是"闸门坏了",而是"开关真的在管着它"。
        """
        tmpfile = tempfile.TemporaryDirectory()
        self.addCleanup(tmpfile.cleanup)
        cfg = Path(tmpfile.name) / "config.json"
        cfg.write_text('{"graphShadowEdges": false}', encoding="utf-8")
        env = {"ECHO_GRAPH_GATE": "", gate.SWITCH_CONFIG_PATH_ENV: str(cfg)}

        tmp, conn = fresh_conn()
        self.addCleanup(tmp.cleanup)
        self.addCleanup(conn.close)
        graph.add_edge(conn, "校园跑", "相关", "章鱼小丸子", OWNER)
        before = self._dump_all(conn)
        with mock.patch.dict(os.environ, env, clear=False):
            os.environ.pop(gate.SWITCH_ENV, None)
            off = gate.maybe_gate_shadow_edges(conn, OWNER, candidates=self._cands(conn))
        self.assertEqual(off["enabled"], False)
        self.assertEqual(self._dump_all(conn), before, "关着还动了库")
        self.assertEqual(off["written"], None, "关着连写口都不该进")

        cfg.write_text('{"graphShadowEdges": true}', encoding="utf-8")
        with mock.patch.dict(os.environ, env, clear=False):
            os.environ.pop(gate.SWITCH_ENV, None)
            on = gate.maybe_gate_shadow_edges(conn, OWNER, candidates=self._cands(conn))
        self.assertEqual(on["enabled"], True, "面板那一路开着,引擎必须开")
        self.assertGreater(on["written"]["inserted"], 0, "开着却一条没写 ⇒ 这条测试没在量东西")

    def _nodes_for_gate(self, conn):
        return {"校园跑": graph.get_or_create_node(conn, "校园跑"),
                "章鱼小丸子": graph.get_or_create_node(conn, "章鱼小丸子")}

    def _cands(self, conn):
        """一条**会被接受**的影子边候选(谓词让 R5 改写成保留名 ⇒ accept)。"""
        ids = self._nodes_for_gate(conn)
        conn.commit()
        return [cooccur(ids["校园跑"], ids["章鱼小丸子"], relation="相关")]

    def test_kind_column_added_and_default_keeps_old_semantics(self):
        """纯增列:既有边(没写 kind)读出来是 `''` = 事实边语义,逐位不变。"""
        tmp, conn = fresh_conn()
        self.addCleanup(tmp.cleanup)
        self.addCleanup(conn.close)
        cols = {r[1] for r in conn.execute("PRAGMA table_info(graph_edges)")}
        self.assertIn("kind", cols)
        graph.add_edge(conn, "用户", "就读于", "西安电子科技大学", OWNER)
        row = conn.execute(
            "SELECT slot, is_active, kind, source_id, target_id FROM graph_edges").fetchone()
        self.assertEqual(str(row[2]), "", "既有写边路径不写 kind ⇒ 默认空串")
        self.assertEqual(int(row[1]), 1)
        # v2-A1:槽位升为三元组身份 `源|关系|目标`
        self.assertEqual(str(row[0]), "%s|就读于|%s" % (row[3], row[4]),
                         "槽位口径(v2-A1 起)= 三元组身份")

    def test_node_type_written_for_new_nodes(self):
        """C:`get_or_create_node` 对新节点**显式写入** node_type;既有节点不回填。"""
        tmp, conn = fresh_conn()
        self.addCleanup(tmp.cleanup)
        self.addCleanup(conn.close)
        nid = graph.get_or_create_node(conn, "阶段1新节点", "episode")
        ntype = conn.execute("SELECT node_type FROM graph_nodes WHERE node_id = ?",
                             (nid,)).fetchone()[0]
        self.assertEqual(ntype, "episode")
        nid2 = graph.get_or_create_node(conn, "阶段1普通节点")
        ntype2 = conn.execute("SELECT node_type FROM graph_nodes WHERE node_id = ?",
                              (nid2,)).fetchone()[0]
        self.assertEqual(ntype2, "concept")          # 缺省 = 与既有行为一致
        self.assertEqual(conn.execute(
            "SELECT COUNT(*) FROM graph_nodes WHERE node_type <> 'concept'"
        ).fetchone()[0], 1)

    def test_migration_is_idempotent_pure_add(self):
        """迁移幂等:连跑两次,列存在、数据不变(第二跑 0 改动)。"""
        tmp, conn = fresh_conn()
        self.addCleanup(tmp.cleanup)
        graph.add_edge(conn, "校园跑", "相关", "章鱼小丸子", OWNER)
        conn.close()
        path = str(Path(tmp.name) / "echo.db")
        conn1 = db.connect(path)
        first = self._dump(conn1)
        conn1.close()
        conn2 = db.connect(path)
        second = self._dump(conn2)
        conn2.close()
        self.assertEqual(first, second, "第二跑迁移改了数据(不幂等)")

    def test_synthetic_db_readings_unchanged_by_migration(self):
        """非空合成旧库上:迁移**幂等** + 既有 kind 值不变。

        只读合成源 → `sqlite3.backup()` 备一份副本 → 在副本上走真实 `db.connect`
        (该加的列会加上)→ 读数与迁移前一致、**既有边的既有值逐位不变**;
        再连一次,`graph_edges` 全表 dump 一模一样(幂等)。

        这条测试对**两种前态都成立**:副本还没有 `kind` 列(老库)、或者已经有了
        (活库迁移过)。所以既不写"列必须不存在",也不写"行数必须等于 N"。
        """
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        dst = Path(tmp.name) / "echo.db"
        source = _seed_migration_source(Path(tmp.name) / "synthetic-source.db", include_kind=False)
        src = sqlite3.connect("file:%s?mode=ro" % source.as_posix(), uri=True)
        src.execute("PRAGMA busy_timeout = 5000")
        dst_conn = sqlite3.connect(str(dst))
        with dst_conn:
            src.backup(dst_conn)
        before = self._readings(dst_conn)
        cols_before = {r[1] for r in dst_conn.execute("PRAGMA table_info(graph_edges)")}
        # 前态:每一条既有边的 kind(列不存在时记 None)
        if "kind" in cols_before:
            pre_kind = {str(r[0]): (str(r[1]) if r[1] is not None else "")
                        for r in dst_conn.execute("SELECT edge_id, kind FROM graph_edges")}
        else:
            pre_kind = {str(r[0]): None
                        for r in dst_conn.execute("SELECT edge_id FROM graph_edges")}
        dst_conn.close()
        src.close()

        conn1 = db.connect(str(dst))
        readings1 = self._readings(conn1)
        dump1 = self._dump(conn1)
        cols1 = {r[1] for r in conn1.execute("PRAGMA table_info(graph_edges)")}
        kind1 = {str(r[0]): (str(r[1]) if r[1] is not None else "")
                 for r in conn1.execute("SELECT edge_id, kind FROM graph_edges")}
        conn1.close()

        conn2 = db.connect(str(dst))
        readings2 = self._readings(conn2)
        dump2 = self._dump(conn2)
        conn2.close()

        self.assertEqual(before, readings1, "迁移改了活库读数")
        self.assertEqual(readings1, readings2)
        self.assertEqual(dump1, dump2, "第二跑迁移改了数据(不幂等)")
        # 不变量:每一条**既有**边迁移后值不变(没列 = None,该补的空串 = "")
        for edge_id, was in pre_kind.items():
            self.assertEqual(kind1.get(edge_id, was if was is not None else ""),
                             was if was is not None else "",
                             "迁移动了既有边 %s 的 kind" % edge_id)
        self.assertIn("kind", cols1 | cols_before, "连一次库之后该有 kind 列")

    def test_synthetic_db_switch_off_adds_no_rows(self):
        """非空合成现库上:① 回执表存在;② 开关关时**零新增**。

        **不**断言"回执表必须空":活库已经有历史留痕(实测 77 行)——
        这里只断言"跑一次开关关的闸门,行数不变、表内容逐位不变"。
        """
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        dst = Path(tmp.name) / "echo.db"
        source = _seed_migration_source(Path(tmp.name) / "synthetic-source.db", include_kind=True)
        src = sqlite3.connect("file:%s?mode=ro" % source.as_posix(), uri=True)
        src.execute("PRAGMA busy_timeout = 5000")
        dst_conn = sqlite3.connect(str(dst))
        with dst_conn:
            src.backup(dst_conn)
        dst_conn.close()
        src.close()

        conn = db.connect(str(dst))
        self.addCleanup(conn.close)
        self.assertTrue(conn.execute(          # 不变量:迁移建表(存在性,不是"空")
            "SELECT name FROM sqlite_master WHERE type='table'"
            " AND name='graph_edge_receipts'").fetchone(), "回执表没被建出来")
        self.assertTrue(conn.execute(          # 路线 2 的新表同样只断言"存在"
            "SELECT name FROM sqlite_master WHERE type='table'"
            " AND name='" + SHADOW + "'").fetchone(), "影子表没被建出来")
        receipts_before = conn.execute(
            "SELECT COUNT(*) FROM graph_edge_receipts").fetchone()[0]
        edges_before = conn.execute("SELECT COUNT(*) FROM graph_edges").fetchone()[0]
        shadow_before = shadow_count(conn)
        before_dump = self._dump_all(conn)
        gate.maybe_gate_shadow_edges(conn, "master", enabled=False,
                                     candidates=[cooccur("a", "b"),
                                                 temporal()])
        self.assertEqual(conn.execute(
            "SELECT COUNT(*) FROM graph_edge_receipts").fetchone()[0], receipts_before,
            "开关关时回执零新增")
        self.assertEqual(conn.execute(
            "SELECT COUNT(*) FROM graph_edges").fetchone()[0], edges_before,
            "开关关时边表零新增")
        self.assertEqual(shadow_count(conn), shadow_before, "开关关时影子表零新增")
        self.assertEqual(self._dump_all(conn), before_dump, "开关关时活库副本被改动了")

    # ---- 工具 ----
    @staticmethod
    def _readings(conn):
        nodes = conn.execute("SELECT COUNT(*) FROM graph_nodes").fetchone()[0]
        edges = conn.execute("SELECT COUNT(*) FROM graph_edges").fetchone()[0]
        active = conn.execute(
            "SELECT COUNT(*) FROM graph_edges WHERE COALESCE(is_active, 1) = 1").fetchone()[0]
        return (int(nodes), int(edges), int(active))

    @staticmethod
    def _dump(conn):
        cols = [r[1] for r in conn.execute("PRAGMA table_info(graph_edges)")]
        rows = conn.execute("SELECT * FROM graph_edges ORDER BY edge_id").fetchall()
        return (tuple(cols), [tuple(str(c) for c in row) for row in rows])

    @classmethod
    def _dump_all(cls, conn):
        """`graph_edges` + `graph_shadow_edges` + `graph_edge_receipts` 全表快照
        (负控 / "开关关"逐位比对用;**三张表都要在**,少一张就漏了泄漏面)。"""
        out = [cls._dump(conn)]
        for table in (gate.SHADOW_TABLE, "graph_edge_receipts"):
            try:
                rows = conn.execute(
                    "SELECT * FROM " + table + " ORDER BY 1").fetchall()
                out.append([tuple(str(c) for c in row) for row in rows])
            except sqlite3.Error:
                out.append("no-table:" + table)
        return out


class RuleTableMiss(unittest.TestCase):
    """1b 裁决④:R4 表外谓词"不猜、放行"要**可审计**(计数 + 回执留痕)。"""

    def test_table_miss_counted_and_receipted(self):
        batch = [fact("n_run", "n_tako", "觉得不错"),          # 表外 ⇒ 放行 + 计数
                 fact("n_user", "n_xdu", "就读于")]            # 表内 ⇒ 普通 accept
        result = gate.gate_edges(batch, CTX, enabled=True)
        self.assertEqual(result["counters"]["accept"], 2)
        self.assertEqual(result["counters"]["rule_table_miss"], 1)
        self.assertEqual(result["counters"]["reasons"], {})
        self.assertEqual(len(result["receipts"]), 1, "表外放行要留一行痕")
        receipt = result["receipts"][0]
        self.assertEqual(receipt["action"], "accept")
        self.assertIsNone(receipt["reason"])
        self.assertEqual(receipt["note"], gate.NOTE_RULE_TABLE_MISS)
        self.assertEqual(receipt["rule_id"], "R4")

    def test_table_miss_not_counted_for_shadow_kinds(self):
        """影子边不吃谓词表(谓词由 R5 钉成保留名)⇒ 不计表外放行。"""
        result = gate.gate_edges([cooccur("n_run", "n_tako")], CTX, enabled=True)
        self.assertEqual(result["counters"]["rule_table_miss"], 0)
        self.assertEqual(result["receipts"], [])


class SingleSourceOfTruth(unittest.TestCase):
    """1b 裁决③/⑤:reason 枚举单一出处;`belief` 在 `node_type` 取值域里。"""

    def test_reason_enum_is_single_source(self):
        self.assertEqual(gate.REASONS, gate.REASON_ENUM)
        self.assertEqual(set(gate.REASON_ENUM), {
            "speaker-node", "zero-overlap", "alias-missing-canonical",
            "bad-endpoint-type", "bad-direction", "no-occurred-at",
            "slot-conflict", "internal-error",
            "restore", "multivalue-slot-collision"})
        # 规则表登记的 reason 必须是枚举子集(加规则忘了登记 ⇒ 红灯)
        for rule in gate.RULES:
            with self.subTest(rule=rule["rule_id"]):
                self.assertIn(rule["reason"], gate.REASON_ENUM)

    def test_every_reason_the_gate_can_emit_is_registered(self):
        batch = [cooccur(" n_user", "n_xdu"),                        # R1
                 cooccur("n_run", "n_tako", source_memory_ids=[1],
                         target_memory_ids=[2]),                      # R2
                 cooccur(source_name="某别名", source_id=None,
                         target_name="校园跑", target_id="n_run"),     # R3(drop)
                 cooccur("n_mem", "n_run"),                           # R4
                 fact("n_run", "n_tako", "共现"),                     # R5
                 temporal(occurred_at=None, source=None),             # R6
                 cooccur("n_run", "n_tako", kind="made_up")]          # 未知 kind(R4 层)
        ctx = gate.build_context(NODES, dict(ALIASES, **{"某别名": "不存在"}),
                                 speakers=LEGACY_SPEAKERS,
                                 person_names=LEGACY_PERSON_NAMES)
        result = gate.gate_edges(batch, ctx, enabled=True)
        emitted = set(result["counters"]["reasons"])
        self.assertTrue(emitted, "一条都没丢?夹具失效")
        self.assertTrue(emitted.issubset(set(gate.REASON_ENUM)), emitted)

    def test_belief_in_node_type_domain(self):
        self.assertIn("belief", gate.NODE_TYPES)
        self.assertEqual(gate.NODE_TYPE_BELIEF, "belief")
        self.assertIn("episode", gate.NODE_TYPES)
        # 取值域与活库默认值一致(缺省仍是 concept ⇒ 既有行为不变)
        self.assertEqual(gate.DEFAULT_NODE_TYPE, "concept")


class WiringSwitchOn(unittest.TestCase):
    """开关开时的实际行为:只吃影子边、只增不改、回执落表。"""

    def _prepare(self):
        tmp, conn = fresh_conn()
        self.addCleanup(tmp.cleanup)
        self.addCleanup(conn.close)
        # 既有事实边(模拟 graph.learn 的产物)
        graph.add_edge(conn, "用户", "就读于", "西安电子科技大学", OWNER)
        graph.add_edge(conn, "校园跑", "相关", "章鱼小丸子", OWNER)
        self.facts = self._facts(conn)
        # 影子边端点节点(3a 的挖边逻辑会先建节点)
        self.run_id_node = graph.get_or_create_node(conn, "校园跑")
        self.tako_node = graph.get_or_create_node(conn, "章鱼小丸子")
        self.user_node = graph.get_or_create_node(conn, "用户")
        return conn

    @staticmethod
    def _facts(conn):
        return [tuple(str(c) for c in row) for row in conn.execute(
            "SELECT * FROM graph_edges WHERE COALESCE(kind, '') = '' ORDER BY edge_id")]

    def _candidates(self):
        return [
            # ① 影子边:R5 把谓词钉成保留名 ⇒ accept
            cooccur(self.run_id_node, self.tako_node, relation="相关"),
            # ② 说话人端点 ⇒ R1 drop(留回执)
            cooccur(self.user_node, self.run_id_node),
            # ③ 时间边:occurred_at 来自 episodic_memory ⇒ accept
            temporal("701", "702"),
            # ④ 事实边候选:闸门**不看**(只计数,不裁不写)
            fact("n_xdu", "n_run", "就读于"),
        ]

    def test_switch_on_only_gates_shadow_kinds(self):
        conn = self._prepare()
        result = gate.maybe_gate_shadow_edges(conn, OWNER,
                                              candidates=self._candidates(),
                                              run_id="run-1", enabled=True,
                                              speakers=LEGACY_SPEAKERS,
                                              person_names=LEGACY_PERSON_NAMES)
        self.assertTrue(result["enabled"])
        self.assertEqual(result["considered"], 3, "只有 3 条影子边候选进了闸门")
        self.assertEqual(result["skipped_non_shadow"], 1, "事实边候选被忽略")
        counters = result["counters"]
        self.assertEqual(counters["accept"], 1)
        self.assertEqual(counters["rewrite"], 1, "R5 把影子边谓词钉成保留名")
        self.assertEqual(counters["drop"], 1)
        self.assertEqual(counters["reasons"], {"speaker-node": 1, "slot-conflict": 1})
        self.assertEqual(counters["rule_table_miss"], 0, "接线口不吃事实边 ⇒ 恒 0")
        self.assertEqual(result["written"]["inserted"], 2,
                         "同记忆共现候选 ⇒ 两条证据行(记忆 701 / 702 各一)")
        self.assertEqual(result["written"]["skipped"], 1,
                         "时间边不进证据层(时间邻近属于 A6,不混进概念共现)")
        print("[开关开] 构造输入计数: accept=%d rewrite=%d drop=%d reasons=%s "
              "落边=%d 回执=%d 非影子跳过=%d"
              % (counters["accept"], counters["rewrite"], counters["drop"],
                 counters["reasons"], result["written"]["inserted"],
                 result["receipts"]["inserted"], result["skipped_non_shadow"]))

        # 事实边一个字段都没被动过
        self.assertEqual(self._facts(conn), self.facts, "既有事实边被闸门动了")
        # 共现确实落库(证据层),n 元形状对:两条证据行、每行一对
        rows = cooc_rows(conn, "scope_kind, memory_id, node_ids, pairs")
        self.assertEqual(len(rows), 2, "两条证据行")
        self.assertEqual({str(r[0]) for r in rows}, {"same_memory"})
        self.assertEqual({int(r[1]) for r in rows}, {701, 702})
        self.assertEqual(shadow_count(conn, owner=OWNER), 0, "影子表冻结(一行都不新增)")
        self.assertEqual(conn.execute(
            "SELECT COUNT(*) FROM graph_edges WHERE COALESCE(kind,'') <> ''").fetchone()[0], 0,
            "graph_edges 里不许有影子行(路线 2 的核心承诺)")
        # 回执落表(改边 + 丢边各一行;accept 不留痕),并带上 route 标记
        self.assertFalse(result["receipts"]["table_missing"])
        rows = conn.execute(
            "SELECT run_id, action, reason, rule_id, kind, route FROM graph_edge_receipts"
            " ORDER BY id").fetchall()
        self.assertEqual(len(rows), 2, "改边 + 丢边各留一行")
        self.assertEqual({str(r[1]) for r in rows}, {"rewrite", "drop"})
        self.assertEqual({str(r[2]) for r in rows}, {"slot-conflict", "speaker-node"})
        self.assertEqual({str(r[0]) for r in rows}, {"run-1"})
        self.assertEqual({str(r[5]) for r in rows}, {gate.WRITE_ROUTE},
                         "回执的 route 标记没写上")

    def test_rerun_same_run_id_changes_zero(self):
        conn = self._prepare()
        first = gate.maybe_gate_shadow_edges(conn, OWNER, candidates=self._candidates(),
                                             run_id="run-2", enabled=True,
                                             speakers=LEGACY_SPEAKERS,
                                             person_names=LEGACY_PERSON_NAMES)
        dump_after_first = DefaultOffInvariance._dump_all(conn)
        second = gate.maybe_gate_shadow_edges(conn, OWNER, candidates=self._candidates(),
                                              run_id="run-2", enabled=True,
                                              speakers=LEGACY_SPEAKERS,
                                              person_names=LEGACY_PERSON_NAMES)
        self.assertEqual(first["written"]["inserted"], 2)
        self.assertEqual(second["written"]["inserted"], 0, "第二跑落库改动数必须为 0")
        self.assertEqual(first["receipts"]["inserted"], 2)
        self.assertEqual(second["receipts"]["inserted"], 0, "回执也不许重复写")
        self.assertEqual(DefaultOffInvariance._dump_all(conn), dump_after_first)
        self.assertEqual(conn.execute(
            "SELECT COUNT(*) FROM graph_edge_receipts").fetchone()[0], 2)

    def test_env_switch_makes_it_live_without_wiring_change(self):
        """开着的方式就是环境变量(不改 config、不重启 host 语义之外无副作用)。"""
        import os as _os
        conn = self._prepare()
        old = _os.environ.get(gate.SWITCH_ENV)
        _os.environ[gate.SWITCH_ENV] = "1"
        try:
            result = gate.maybe_gate_shadow_edges(conn, OWNER,
                                                  candidates=self._candidates(),
                                                  speakers=LEGACY_SPEAKERS,
                                                  person_names=LEGACY_PERSON_NAMES)
        finally:
            if old is None:
                _os.environ.pop(gate.SWITCH_ENV, None)
            else:
                _os.environ[gate.SWITCH_ENV] = old
        self.assertTrue(result["enabled"])
        self.assertEqual(result["written"]["inserted"], 2)


class MigrationShape(unittest.TestCase):
    """DB 迁移的硬形状:只 ADD COLUMN / CREATE TABLE IF NOT EXISTS、不重建表。"""

    def test_only_add_column_in_engine_migration(self):
        text = (REPO / "python" / "engine" / "db.py").read_text(encoding="utf-8")
        self.assertIn('("kind", "TEXT DEFAULT \'\'")', text)
        self.assertNotIn("DROP COLUMN", text)
        self.assertNotIn("RENAME TO", text)
        self.assertNotIn("DROP TABLE", text)

    def test_receipts_table_created_idempotently(self):
        """回执表:`CREATE TABLE IF NOT EXISTS` + 只增不改;连连三次表形状不变。"""
        tmp, conn = fresh_conn()
        self.addCleanup(tmp.cleanup)
        self.addCleanup(conn.close)
        path = str(Path(tmp.name) / "echo.db")
        self.assertIn("graph_edge_receipts", {
            str(r[0]) for r in conn.execute(
                "SELECT name FROM sqlite_master WHERE type = 'table'")})
        conn.close()
        raw = sqlite3.connect(path)
        cols1 = [tuple(r) for r in raw.execute("PRAGMA table_info(graph_edge_receipts)")]
        raw.close()
        shapes = {tuple(r[1] for r in cols1)}
        for _ in range(2):
            c = db.connect(path)
            shapes.add(tuple(r[1] for r in c.execute(
                "PRAGMA table_info(graph_edge_receipts)")))
            self.assertEqual(c.execute(
                "SELECT COUNT(*) FROM graph_edge_receipts").fetchone()[0], 0)
            c.close()
        self.assertEqual(len(shapes), 1, "回执表形状漂了(迁移不幂等)")

    def test_graph_nodes_already_has_node_type(self):
        tmp, conn = fresh_conn()
        self.addCleanup(tmp.cleanup)
        self.addCleanup(conn.close)
        cols = {r[1] for r in conn.execute("PRAGMA table_info(graph_nodes)")}
        self.assertIn("node_type", cols)

    def test_shadow_table_created_pure_add(self):
        """路线 2 新表:`CREATE TABLE IF NOT EXISTS`、列形状对、连跑三次形状不变。"""
        tmp, conn = fresh_conn()
        self.addCleanup(tmp.cleanup)
        self.addCleanup(conn.close)
        path = str(Path(tmp.name) / "echo.db")
        self.assertIn(SHADOW, {str(r[0]) for r in conn.execute(
            "SELECT name FROM sqlite_master WHERE type = 'table'")})
        want = {"edge_id", "source_id", "target_id", "relation", "weight", "kind",
                "owner_key", "evidence", "evidence_scope", "occurred_at",
                "occurred_at_source", "is_active", "created_at"}
        cols1 = {r[1] for r in conn.execute("PRAGMA table_info(" + SHADOW + ")")}
        self.assertEqual(cols1, want, "影子表列形状漂了")
        for banned in ("activation", "half_life", "recall_count", "last_accessed",
                       "layer", "slot", "intrinsic_value", "superseded_by",
                       "temporal_status", "learned_at"):
            self.assertNotIn(banned, cols1, "影子表混进了状态列:" + banned)
        conn.close()
        shapes = {tuple(sorted(cols1))}
        for _ in range(2):
            c = db.connect(path)
            shapes.add(tuple(sorted(str(r[1]) for r in c.execute(
                "PRAGMA table_info(" + SHADOW + ")"))))
            self.assertEqual(c.execute("SELECT COUNT(*) FROM " + SHADOW).fetchone()[0], 0)
            c.close()
        self.assertEqual(len(shapes), 1, "影子表形状漂了(迁移不幂等)")

    def test_write_path_only_touches_shadow_table(self):
        """静态口径:闸门写口**只写新表** —— 影子行不许再回 `graph_edges`。

        `graph_gate.py` 里允许**读** `graph_edges`(R5 要认事实槽位、写口要查保留槽位
        占用),但**不许**出现 `INSERT INTO graph_edges` / `UPDATE graph_edges`。
        """
        text = (REPO / "python" / "engine" / "graph_gate.py").read_text(encoding="utf-8")
        self.assertNotIn("INSERT INTO graph_edges", text, "影子边又往老表写了")
        self.assertNotIn("UPDATE graph_edges", text, "影子边又改老表了")
        self.assertNotIn("DELETE FROM graph_edges", text, "闸门不许删事实边")
        self.assertIn('SHADOW_TABLE = "graph_shadow_edges"', text)
        self.assertIn('EVIDENCE_TABLE = cooc_mod.EVIDENCE_TABLE', text)
        self.assertIn('WRITE_ROUTE = "cooc-evidence"', text)
        self.assertIn('WRITE_ROUTE_HISTORICAL = "shadow-table"', text)
        # 冻结:写入路径里不许再有碰影子表的 DML(它只剩"读"与"冻结计数")
        for sql in ("INSERT INTO " + gate.SHADOW_TABLE, "UPDATE " + gate.SHADOW_TABLE,
                    "DELETE FROM " + gate.SHADOW_TABLE):
            self.assertNotIn(sql, text, "写口又碰影子表了:" + sql)

    def test_receipts_route_column_added(self):
        """回执表加 `route` 标记(纯 ADD COLUMN,幂等)。"""
        tmp, conn = fresh_conn()
        self.addCleanup(tmp.cleanup)
        self.addCleanup(conn.close)
        cols = {r[1] for r in conn.execute("PRAGMA table_info(graph_edge_receipts)")}
        self.assertIn("route", cols)
        db_text = (REPO / "python" / "engine" / "db.py").read_text(encoding="utf-8")
        self.assertIn('ADD COLUMN route TEXT', db_text)
        self.assertIn("graph_shadow_edges", db_text, "建表职权应当在 db.py 迁移里")


class GateInternalError(unittest.TestCase):
    """1b 裁决④:闸门**自身**出错是"最需要留痕"的事 —— 回执优先,stderr 全量兜底。"""

    def _prepare(self):
        tmp, conn = fresh_conn()
        self.addCleanup(tmp.cleanup)
        self.addCleanup(conn.close)
        graph.add_edge(conn, "用户", "就读于", "西安电子科技大学", OWNER)
        run_node = graph.get_or_create_node(conn, "校园跑")
        tako_node = graph.get_or_create_node(conn, "章鱼小丸子")
        return conn, [cooccur(run_node, tako_node, relation="相关")]

    def test_receipt_written_when_edge_write_fails(self):
        """落边路径炸了 ⇒ 仍要在回执表留下一行 `internal-error`(不静默)。"""
        conn, candidates = self._prepare()
        with mock.patch.object(gate, "write_accepted_edges",
                               side_effect=RuntimeError("boom-on-write")):
            with contextlib.redirect_stderr(io.StringIO()) as err:
                result = gate.maybe_gate_shadow_edges(conn, OWNER, candidates=candidates,
                                                      run_id="ie-1", enabled=True)
        self.assertIsNotNone(result["error"], "闸门出错了却没记下来")
        self.assertEqual(result["error"]["type"], "RuntimeError")
        self.assertTrue(result["error"]["receipt_written"],
                        "回执表可用时,internal-error 必须落表")
        self.assertFalse(result["error"]["stderr"], "回执落了表就不该再往 stderr 倒回溯")
        self.assertEqual(err.getvalue(), "")
        rows = conn.execute(
            "SELECT action, reason, rule_id, note FROM graph_edge_receipts").fetchall()
        self.assertEqual(len(rows), 1)
        self.assertEqual((str(rows[0][0]), str(rows[0][1])), ("drop", "internal-error"))
        self.assertEqual(str(rows[0][2]), "")
        self.assertIn("gate-internal-error:RuntimeError", str(rows[0][3]))
        # 闸门出错 ⇒ 那批边一条都没落(宁缺勿错):两张表都得干净
        self.assertEqual(conn.execute(
            "SELECT COUNT(*) FROM graph_edges WHERE COALESCE(kind,'')<>''").fetchone()[0], 0)
        self.assertEqual(shadow_count(conn, owner=OWNER), 0)
        self.assertIsNone(result["written"])

    def test_degrades_to_untruncated_stderr_when_table_unusable(self):
        """回执表写不进(库坏了)⇒ 退化 stderr,且**完整回溯**(不许截断)。"""
        class _OneTable:
            def fetchone(self):
                return (1,)

        class _BrokenConn:
            """表"在"(`sqlite_master` 查得到,所以不走进"表缺失"那条软路),
            但一切真读写都炸 —— 模拟库坏了。"""

            def execute(self, sql, *args, **kwargs):
                if "sqlite_master" in sql:
                    return _OneTable()
                raise sqlite3.OperationalError("db is gone")

            def commit(self):
                raise sqlite3.OperationalError("db is gone")

        with mock.patch.object(gate, "write_accepted_edges",
                               side_effect=sqlite3.OperationalError("db is gone")):
            with contextlib.redirect_stderr(io.StringIO()) as err:
                result = gate.maybe_gate_shadow_edges(
                    _BrokenConn(), OWNER, candidates=[cooccur("a", "b")],
                    run_id="ie-2", enabled=True)
        text = err.getvalue()
        self.assertIsNotNone(result["error"])
        self.assertFalse(result["error"]["receipt_written"])
        self.assertTrue(result["error"]["stderr"])
        self.assertIn("Traceback (most recent call last)", text)   # 完整回溯,没被截成一行
        self.assertIn("OperationalError: db is gone", text)        # 异常本体也在
        self.assertIn("internal-error", text)
        # 不抛异常:写入主流程绝不被图挂住
        self.assertTrue(issubclass(RuntimeError, Exception))

    def test_helper_receipt_shape_and_idempotency(self):
        """`report_internal_error` 直接调用:回执形状 + 同 run_id 复写不重复。"""
        tmp, conn = fresh_conn()
        self.addCleanup(tmp.cleanup)
        self.addCleanup(conn.close)
        first = gate.report_internal_error(conn, ValueError("x"), run_id="ie-3")
        second = gate.report_internal_error(conn, ValueError("x"), run_id="ie-3")
        self.assertTrue(first["receipt_written"] and second["receipt_written"])
        self.assertEqual(first["receipt_written"], second["receipt_written"])
        self.assertEqual(conn.execute(
            "SELECT COUNT(*) FROM graph_edge_receipts WHERE run_id = 'ie-3'").fetchone()[0], 1,
            "同一 run_id 的 internal-error 回执也必须幂等")
        self.assertEqual(str(conn.execute(
            "SELECT reason FROM graph_edge_receipts").fetchone()[0]), "internal-error")

    def test_gate_edges_per_candidate_error_is_receipted(self):
        """逐条裁决内部异常已由 `gate_edges` 降级成 drop + internal-error(照常留回执)。

        注意 `_decide` 第一步就把候选**拷成普通 dict**(脏候选进不去),所以这里只能
        替换规则函数来制造真异常 —— 这也说明"脏候选"本身不是可达的炸点。
        """
        conn, _ = self._prepare()

        def _boom(*args, **kwargs):
            raise RuntimeError("boom-rule")

        with mock.patch.dict(gate._RULE_FUNCS, {"R1": _boom}):
            gated = gate.gate_edges([cooccur("a", "b")], gate.EMPTY_CONTEXT, enabled=True)
        self.assertEqual(gated["counters"]["reasons"], {"internal-error": 1})
        self.assertEqual(len(gated["receipts"]), 1)
        self.assertEqual(gated["receipts"][0]["reason"], "internal-error")
        written = gate.write_receipts(conn, gated["receipts"], run_id="ie-4")
        self.assertEqual(written["inserted"], 1)

    def test_safe_receipt_degrades_on_unreadable_candidate(self):
        """候选脏到连"造回执"都读不动 ⇒ 退化回执(记降级原因),整批裁决不被掀翻。"""
        class _Boom(dict):
            def get(self, *args, **kwargs):
                raise RuntimeError("bad candidate")

        boom = _Boom(kind="cooccur_same_memory", source_id="a", target_id="b")
        receipt = gate._safe_receipt(
            {"action": "drop", "reason": "internal-error"}, boom, "R1")
        self.assertIn("receipt-degraded:RuntimeError", receipt["note"])
        self.assertEqual((receipt["action"], receipt["reason"]), ("drop", "internal-error"))
        self.assertEqual((receipt["rule_id"], receipt["kind"]), ("R1", ""))


class WritePathHook(unittest.TestCase):
    """阶段 4 尾:`judge.commit`(真实写边路径)上的挖边钩子。

    四条纪律,一条一测:
      * 接线**只有一处**(`judge.py` 里一句 `graph_gate.mine_after_memory_write(...)`),
        事实边模块 `graph.py` 仍然不碰闸门;
      * **关掉时连库都不读**(`_NoTouchConn` 一碰就炸)⇒ 主流程逐位不变的最强形式;
      * 开着时**只挖给的那几条记忆**(同记忆类),不扫全库;
      * 钩子**自己出错也绝不掀翻主流程**:吞掉 + 留 `internal-error` 痕。
    """

    def _fixture(self, db_path, names=("校园跑", "章鱼小丸子")):
        conn = db.connect(str(db_path))
        self.addCleanup(conn.close)
        for name in names:
            graph.get_or_create_node(conn, name)
        conn.commit()
        return conn

    @staticmethod
    def _structured(summaries, triples=()):
        return {"keywords": ["测试"], "summary": "他聊了测试的事",
                "emotion_score": 3, "emotion_state": "neutral",
                "mood_intensity": 3, "mood_reason": "",
                "emotion_vector": {"global": {}, "target_master": {}},
                "candidates": [candidate(summary=s, slot=s[:8] or "x", confidence=0.9)
                               for s in summaries],
                "triples": list(triples)}

    @staticmethod
    def _dumps(conn):
        out = []
        for table in ("graph_edges", gate.EVIDENCE_TABLE, gate.SHADOW_TABLE,
                      "graph_edge_receipts"):
            rows = conn.execute("SELECT * FROM " + table + " ORDER BY 1").fetchall()
            out.append((table, [tuple(str(c) for c in r) for r in rows]))
        return out

    # ── ① 接线 ───────────────────────────────────────────────────────────
    def test_hook_is_wired_once_on_the_real_write_path(self):
        """真写边路径上**恰好一句**钩子,而且挂在 `graph.learn(...)` **之后**。"""
        src = (REPO / "python" / "engine" / "judge.py").read_text(encoding="utf-8")
        self.assertEqual(src.count("mine_after_memory_write("), 1, "钩子只许一处")
        self.assertLess(src.index("graph.learn("), src.index("mine_after_memory_write("),
                        "钩子必须在事实边写完**之后**才跑")
        # 钩子不许改主流程的返回字典(关掉时"逐位不变"的前提)
        self.assertNotIn('"mined"', src)
        self.assertNotIn('"shadowEdges"', src)
        # 事实边模块仍然不碰闸门(阶段 1b 的老纪律)
        self.assertNotIn("graph_gate", (REPO / "python" / "engine" / "graph.py")
                         .read_text(encoding="utf-8"))
        # 而 worker 那条帧路径照旧(接线口现在**两处**,各自一处)
        worker = (REPO / "python" / "worker.py").read_text(encoding="utf-8")
        self.assertEqual(worker.count("maybe_gate_shadow_edges("), 1)

    # ── ② 关掉时:连库都不读 ──────────────────────────────────────────────
    def test_hook_off_never_touches_the_db(self):
        """关着时:先判开关、**一个 SQL 都不发** —— 比"差量为 0"更强的证据。"""
        class _NoTouchConn:
            def execute(self, *args, **kwargs):
                raise AssertionError("开关关时钩子读了库")

            def commit(self):
                raise AssertionError("开关关时钩子写了库")

        out = gate.mine_after_memory_write(_NoTouchConn(), [1, 2, 3], enabled=False)
        self.assertEqual(out["enabled"], False)
        self.assertEqual(out["memories"], 0)
        self.assertIsNone(out["written"])
        self.assertIsNone(out["receipts"])
        # 环境隔离下(本模块导入时已把文件那一路指到不存在的路径)默认判据同样是关
        self.assertFalse(gate.gate_enabled())

    # ── ③ 开着时:只挖给的那条记忆 ────────────────────────────────────────
    def test_hook_on_mines_only_the_given_memories(self):
        """给两条记忆、只让钩子挖第一条:第二条的那对**一个字都不许进表**。"""
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        conn = self._fixture(Path(tmp.name) / "echo.db", ("校园跑", "章鱼小丸子", "舞萌", "音理"))
        ack_a = judge.commit(conn, "master", self._structured(["今天聊到校园跑和章鱼小丸子"]),
                             "测试A", now=1.0)
        ack_b = judge.commit(conn, "master", self._structured(["今天聊到舞萌和音理"]),
                             "测试B", now=2.0)
        mid_a = ack_a["written"][0]["memoryId"]
        mid_b = ack_b["written"][0]["memoryId"]

        out = gate.mine_after_memory_write(conn, [mid_a], enabled=True)
        self.assertEqual(out["enabled"], True)
        self.assertEqual(out["memories"], 1)
        self.assertGreaterEqual(out["written"]["inserted"], 1, "开着却一条共现证据都没写")
        self.assertIsNone(out["error"], "正常路径不该有 internal-error:%s" % (out["error"],))

        rows = conn.execute("SELECT node_ids, memory_id FROM " + gate.EVIDENCE_TABLE
                            ).fetchall()
        names = set()
        for ids_text, memory_id in rows:
            self.assertEqual(int(memory_id), mid_a, "挖了没让它挖的那条记忆")
            for nid in str(ids_text or "").split("、"):
                nid = nid.strip()
                if not nid:
                    continue
                got = conn.execute("SELECT name FROM graph_nodes WHERE node_id = ?",
                                   (nid,)).fetchone()
                names.add(str(got[0]) if got else nid)
        self.assertIn("校园跑", names)
        self.assertNotIn("舞萌", names, "钩子挖了没让它挖的那条记忆(B 的节点进了表)")
        self.assertNotIn("音理", names)
        self.assertTrue(mid_b > 0)
        # 只挖一次幂等:同一批(同一条记忆)再跑一遍,不新增行
        again = gate.mine_after_memory_write(conn, [mid_a], enabled=True)
        self.assertEqual(again["written"]["inserted"], 0, "同一条记忆挖两次长出了重复边")
        self.assertGreaterEqual(again["written"]["skipped"], 1)

    # ── ④ 钩子自己出错:吞掉 + 留痕 ──────────────────────────────────────
    def test_hook_swallows_mining_errors_and_leaves_receipt(self):
        """挖边抛错 ⇒ 钩子**不抛**、留一条 internal-error 痕,且没写影子边。"""
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        conn = self._fixture(Path(tmp.name) / "echo.db")

        def _boom(*args, **kwargs):
            raise RuntimeError("mine-boom")

        out = gate.mine_after_memory_write(conn, [7], enabled=True, mine=_boom)
        self.assertEqual(out["error"]["type"], "RuntimeError")
        self.assertTrue(out["error"]["receipt_written"], "钩子出错没留痕")
        self.assertFalse(out["error"]["stderr"], "能落表就别往 stderr 倒回溯")
        rows = conn.execute("SELECT reason, note FROM graph_edge_receipts").fetchall()
        self.assertEqual([str(r[0]) for r in rows], ["internal-error"])
        self.assertIn("judge.commit hook", str(rows[0][1]))
        self.assertEqual(conn.execute("SELECT COUNT(*) FROM " + gate.SHADOW_TABLE)
                         .fetchone()[0], 0, "出错了还写了影子边")
        # 脏 memory_id 不许把钩子弄炸
        self.assertEqual(gate.mine_after_memory_write(conn, [None, "x", -1, 0],
                                                      enabled=True)["memories"], 0)

    # ── ⑤ 端到端:开关关 vs 开,主流程返回值**逐位一致** ──────────────────
    def test_commit_return_is_bit_identical_while_evidence_grows(self):
        """同一份夹具、同一次 `judge.commit`:开关关 / 开 —— `ack` **逐位相同**,
        只有共现证据层(+ 回执)长了。这就是"钩子不干扰主流程"的正面证据。
        """
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        base = Path(tmp.name) / "base.db"
        self._fixture(base, ("校园跑", "章鱼小丸子", "用户")).close()
        # 记忆里同时点名两个概念节点 + 一个**说话人**节点:一对进影子表(accept 不留回执),
        # 两对因 R1 被丢(丢边**留回执**)⇒ 这次能同时量"影子边长了"和"回执长了"。
        payload = self._structured(["今天聊到校园跑、章鱼小丸子,还有用户在旁边"])

        def run(switch_on):
            dst = Path(tmp.name) / ("on.db" if switch_on else "off.db")
            src = sqlite3.connect("file:%s?mode=ro" % base.as_posix(), uri=True)
            d = sqlite3.connect(str(dst))
            with d:
                src.backup(d)
            d.close()
            src.close()
            conn = db.connect(str(dst))
            try:
                # "拨开关"= 让判据返回 True(与面板/env 走的是**同一个** `gate_enabled`)
                with mock.patch.object(gate, "gate_enabled", return_value=switch_on):
                    # P1c:名单是数据 —— 帧里那份 `names` 要喂进 `commit`,否则 R1 不认
                    # 「用户」是说话人,那两对就不会被丢 ⇒ 回执不会长(这条测试就量不到东西)。
                    ack = judge.commit(conn, "master", payload, "测试", now=1.0,
                                       names=LEGACY_FRAME_NAMES)
                return ack, self._dumps(conn)
            finally:
                conn.close()

        ack_off, dump_off = run(False)
        ack_on, dump_on = run(True)

        self.assertEqual(ack_on, ack_off, "开关开着时主流程的返回值变了")
        self.assertEqual(dump_on[0], dump_off[0], "共现写进了 graph_edges(v2-A4 的承诺)")
        self.assertGreater(len(dump_on[1][1]), len(dump_off[1][1]), "开着却没长共现证据")
        self.assertEqual(len(dump_on[2][1]), len(dump_off[2][1]), "影子表不许长(已冻结)")
        self.assertEqual(len(dump_off[1][1]), 0, "关着时证据层该是空的")
        self.assertGreater(len(dump_on[3][1]), len(dump_off[3][1]), "开着却没留回执")
        print("[钩子纪律] 同一次 commit:关 %d 证据 / 开 %d 证据 + %d 回执 | ack 逐位一致"
              % (len(dump_off[1][1]), len(dump_on[1][1]), len(dump_on[3][1])))

    def test_commit_off_is_identical_to_not_calling_the_hook_at_all(self):
        """**基线对照**:关着时的那次调用 ≡ 根本不调它(`ack` 逐位相同、耗时无差)。

        这是"改动前 vs 改动后"能做到的最硬口径 —— 把钩子换成空实现,结果必须一模一样。
        """
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        base = Path(tmp.name) / "base.db"
        self._fixture(base).close()
        payload = self._structured(["今天聊到校园跑和章鱼小丸子"])

        def run(patch_hook):
            dst = Path(tmp.name) / ("baseline.db" if patch_hook else "hooked.db")
            src = sqlite3.connect("file:%s?mode=ro" % base.as_posix(), uri=True)
            d = sqlite3.connect(str(dst))
            with d:
                src.backup(d)
            d.close()
            src.close()
            conn = db.connect(str(dst))
            try:
                started = time.time()
                if patch_hook:
                    with mock.patch.object(gate, "mine_after_memory_write",
                                           return_value={"enabled": False}):
                        ack = judge.commit(conn, "master", payload, "测试", now=1.0)
                else:
                    ack = judge.commit(conn, "master", payload, "测试", now=1.0)
                return ack, self._dumps(conn), time.time() - started
            finally:
                conn.close()

        ack_base, dump_base, t_base = run(True)
        ack_now, dump_now, t_now = run(False)
        self.assertEqual(ack_base, ack_now, "关掉时的返回值变了")
        self.assertEqual(dump_base, dump_now, "关掉时库被动过")
        self.assertLess(t_now - t_base, 0.5,
                        "关掉时那次调用让主流程慢了(%.4fs vs %.4fs)" % (t_now, t_base))
        print("[钩子纪律] 空实现基线 %.4fs / 真实钩子(关)%.4fs | ack 逐位一致、三表逐位一致"
              % (t_base, t_now))


class NamesFromData(unittest.TestCase):
    """P1c:说话人 / 人名集合改由数据下发(`names.json` 经帧),引擎里不再留真名。

    三条判据(与实现改动一一对应):
      ① `names_from_frame` 正常解析、坏形状 ⇒ `([], [])` 且不抛;
      ② 帧里 names 为空 ⇒ `build_context()` 的 `speakers` / `person_names` 都是空集且不抛
         (**不回落**内置真名);
      ③ `person_names` 给了值时 **speakers ⊆ person_set**(不变量)。
    """

    def test_engine_keeps_no_builtin_names(self):
        """代码里零名单:默认池是空的,缺省上下文的中性口径是空集。"""
        self.assertEqual(gate.SPEAKER_NODES, frozenset(), "引擎里不许再留内置名单")
        ctx = gate.build_context(NODES, ALIASES)
        self.assertEqual(ctx["speakers"], frozenset())
        self.assertEqual(ctx["person_names"], frozenset())

    def test_names_from_frame_parses_and_never_throws(self):
        speakers, person_names = gate.names_from_frame(
            {"names": {"speakers": ["用户", " 阿岚 ", ""], "personNames": ["阿乙"]}})
        self.assertEqual(sorted(speakers), ["用户", "阿岚"], "去空白、丢空串(码点序:用 29992 < 阿 38463)")
        self.assertEqual(list(person_names), ["阿乙"])
        # 坏形状 / 缺字段 / 不是对象 ⇒ 两边都空,而且**不抛**(never-throw)
        for bad in ({}, {"names": {}}, {"names": None}, {"names": "不是对象"},
                    {"names": {"speakers": {"不是": "数组"}}}, None, "坏形状", 3):
            with self.subTest(bad=bad):
                self.assertEqual(gate.names_from_frame(bad), ([], []))

    def test_empty_frame_names_are_neutral_not_builtin(self):
        """帧里 names 空 ⇒ 空集口径(不回落真名):谁也不当说话人。"""
        speakers, person_names = gate.names_from_frame({"names": {}})
        self.assertEqual((speakers, person_names), ([], []))
        ctx = gate.build_context(NODES, ALIASES, speakers=speakers,
                                 person_names=person_names)
        self.assertEqual(ctx["speakers"], frozenset())
        self.assertEqual(ctx["person_names"], frozenset())
        # 中性口径的直接后果:说话人端点**不再**被 R1 拦(名单没喂进来就是没喂)
        v = gate.gate_edge(cooccur("n_user", "n_xdu"), ctx, enabled=True)
        self.assertTrue(v["accepted"], v)
        # 同一批候选喂上帧名单 ⇒ R1 立刻拦下(证明上面那条量的真是"名单是数据")
        fed = gate.build_context(NODES, ALIASES, speakers=LEGACY_SPEAKERS,
                                 person_names=LEGACY_PERSON_NAMES)
        v2 = gate.gate_edge(cooccur("n_user", "n_xdu"), fed, enabled=True)
        self.assertEqual((v2["action"], v2["reason"]), ("drop", "speaker-node"))

    def test_person_names_superset_of_speakers(self):
        """不变量:**说话人一定算人**(person ⊇ speakers),显式给值时也成立。"""
        ctx = gate.build_context(NODES, ALIASES, speakers=["甲", "乙"], person_names=["丙"])
        self.assertLessEqual(ctx["speakers"], ctx["person_names"],
                             "speakers 必须 ⊆ person_set")
        self.assertEqual(ctx["person_names"], frozenset({"甲", "乙", "丙"}))
        # 帧那一路同口径(照旧内置值喂进去 ⇒ 与被替换掉的硬编码逐字一致)
        speakers, person_names = gate.names_from_frame(
            {"names": {"speakers": list(LEGACY_SPEAKERS),
                       "personNames": list(LEGACY_PERSON_EXTRA)}})
        ctx2 = gate.build_context(NODES, ALIASES, speakers=speakers,
                                  person_names=person_names)
        self.assertLessEqual(ctx2["speakers"], ctx2["person_names"])
        self.assertEqual(ctx2["speakers"], frozenset(LEGACY_SPEAKERS))
        self.assertEqual(ctx2["person_names"], frozenset(LEGACY_PERSON_NAMES))


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
