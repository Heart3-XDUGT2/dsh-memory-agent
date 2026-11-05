# -*- coding: utf-8 -*-
"""引擎共享数据库层。

建表基线与 JS store.js 的 DDL 逐列同构(IF NOT EXISTS,与既有表共存不撞);
引擎自有的扩展列由本层幂等迁移补齐(ALTER TABLE ADD COLUMN,先查
PRAGMA table_info 再加,永不重复、永不破坏)。

单一写者分工:库文件与基表由 JS 壳(store.js openStore)负责创建;
worker 永不建库文件(must_exist 守卫),但对自有引擎列享有迁移权 ——
这是 M2-b2 的显式决策(规格书 §10)。

搬家数据修复:import-astrbot.mjs 搬运图谱时没写 slot 列(全部空串),
v8.4 槽位取代机制对旧边会失明(新宾语顶不掉旧宾语)。本层在连接时
做一次性幂等回填 slot = source_id || '|' || relation。
"""

import sqlite3
import sys
from pathlib import Path

from . import integrity

_DDL = """
CREATE TABLE IF NOT EXISTS pending_threads (
    thread_id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    content TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open',
    follow_up_after REAL NOT NULL DEFAULT 0,
    source_memory_id INTEGER DEFAULT 0,
    session_id TEXT DEFAULT '',
    last_mentioned_at REAL DEFAULT 0,
    created_at REAL,
    updated_at REAL,
    -- 2026-09-30 P2:话题打分器的结果缓存。**共有表** —— 与 lib/store.js 的
    -- DDL 逐列同源(test_ddl_parity 的 test_shared_tables_engine_is_superset
    -- 要求"引擎列 ⊇ JS 列":JS 加了这里不加,灯就红)。
    score REAL DEFAULT 0,
    score_at REAL DEFAULT 0,
    -- 2026-10-06 D1(悬置话题完整机制,设计文档 §7.1):生命周期四列。
    -- 同样是**共有表** —— 与 lib/store.js 的 DDL 逐列同源,老库走
    -- `_migrate_pending_threads` 幂等补列。D1 阶段**只写不读**(影子期)。
    kind TEXT DEFAULT '',
    cooling_at REAL DEFAULT 0,
    archived_at REAL DEFAULT 0,
    superseded_by INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_pending_threads_user
    ON pending_threads(user_id, status, follow_up_after);
CREATE TABLE IF NOT EXISTS episodic_memory (
    memory_id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT,
    keywords TEXT,
    summary TEXT,
    emotion_score INTEGER,
    timestamp TIMESTAMP,
    is_active INTEGER DEFAULT 1,
    source TEXT DEFAULT 'private',
    source_label TEXT DEFAULT '',
    actor TEXT DEFAULT '',
    speaker_id TEXT DEFAULT '',
    is_master INTEGER DEFAULT 1,
    intrinsic_value REAL DEFAULT 0,
    half_life REAL DEFAULT 0,
    recall_count INTEGER DEFAULT 0,
    last_recalled REAL DEFAULT 0,
    occurred_at REAL DEFAULT 0,
    learned_at REAL DEFAULT 0,
    temporal_status TEXT DEFAULT 'time_unknown',
    memory_key TEXT DEFAULT '',
    superseded_by INTEGER DEFAULT 0,
    layer TEXT DEFAULT '',
    evidence TEXT DEFAULT '',
    status TEXT DEFAULT 'active',
    -- 2026-09-30 写入侧"说法键":JSON 数组字符串(「以后他可能怎么问这件事」的说法)。
    -- 检索时与 summary/keywords 一起进打分正文(`lexical.doc_text`);空 = 不加字面。
    aug_keys TEXT,
    -- 2026-10-12 类型列(接住 Judge 已经输出的 field / stability)。
    -- 与 lib/store.js 同步;空 = 旧行为(老行留空,不回填)。**不参与任何判断**。
    memory_type TEXT DEFAULT '',
    memory_stability TEXT DEFAULT ''
    -- (v0.29.0 个人机器人裁剪:channel / channel_chat 两列随群聊拒收
    --  一起退役。老库里已建出的列原样留着(全空,不引用不迁移);新库
    --  不再创建。)
);
CREATE INDEX IF NOT EXISTS idx_episodic_user
    ON episodic_memory(user_id, is_active, timestamp DESC);
CREATE TABLE IF NOT EXISTS reflection_state (
    user_id TEXT PRIMARY KEY,
    last_memory_id INTEGER DEFAULT 0,
    last_at REAL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS her_agenda (
    item_id INTEGER PRIMARY KEY AUTOINCREMENT,
    content TEXT NOT NULL,
    origin TEXT DEFAULT 'persona',
    source_ids TEXT DEFAULT '',
    weight REAL DEFAULT 1.0,
    created_at REAL NOT NULL,
    last_used_at REAL DEFAULT 0,
    is_active INTEGER DEFAULT 1
);
CREATE TABLE IF NOT EXISTS agent_state (
    session_id TEXT PRIMARY KEY,
    mood_intensity INTEGER DEFAULT 3,
    prev_mood_intensity INTEGER DEFAULT 3,
    user_emotion TEXT DEFAULT 'neutral',
    mood_reason TEXT DEFAULT '',
    current_topic TEXT DEFAULT '',
    emotion_vector TEXT DEFAULT '',
    previous_emotion_vector TEXT DEFAULT '',
    updated_at TIMESTAMP
);
CREATE TABLE IF NOT EXISTS audit_logs (
    trace_id TEXT PRIMARY KEY,
    session_id TEXT,
    user_key TEXT,
    sender_id TEXT,
    is_master INTEGER,
    user_input TEXT,
    injected_profile TEXT,
    injected_memories TEXT,
    emotion_pack TEXT,
    -- 第三批(2026-10-05)情绪空间融合:`emotion_pack_structured`(联合空间结构化读数)。
    -- **共有表 superset 不变量**(tests/test_ddl_parity.py:test_shared_tables_engine_is_superset):
    -- 壳侧 DDL 有的列,引擎侧必须也有。写入端只有壳侧(影子模式),引擎侧不读这一列,
    -- 所以这里**只补 DDL**、不另加迁移函数(老引擎库缺列也不影响引擎自己的查询)。
    emotion_pack_structured TEXT DEFAULT '',
    agent_state TEXT,
    llm_reply TEXT,
    latency REAL,
    mood_intensity INTEGER,
    prev_mood_intensity INTEGER,
    say_again INTEGER,
    extra_reply TEXT,
    emotion_vector TEXT DEFAULT '',
    emotion_delta TEXT DEFAULT '',
    tool_call TEXT DEFAULT '',
    timestamp TIMESTAMP,
    -- 期 0(2026-10-09):阶段与步序。共有表 superset 不变量 —— 壳侧有的列引擎侧必须有,
    -- 所以这里同步补 DDL(同 emotion_pack_structured 的先例:只补 DDL,不另加迁移)。
    stage TEXT DEFAULT '',
    step INTEGER DEFAULT 0,
    stage_detail TEXT DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_audit_session ON audit_logs(session_id, timestamp DESC);
CREATE TABLE IF NOT EXISTS longing_state (
    user_id TEXT PRIMARY KEY,
    value REAL NOT NULL DEFAULT 0,
    anchor_at REAL NOT NULL DEFAULT 0,
    updated_at REAL NOT NULL DEFAULT 0,
    kicked INTEGER NOT NULL DEFAULT 0,
    last_user_msg_at REAL NOT NULL DEFAULT 0,
    last_care_at REAL NOT NULL DEFAULT 0,
    care_count INTEGER NOT NULL DEFAULT 0,
    session_id TEXT DEFAULT ''
);
CREATE TABLE IF NOT EXISTS graph_nodes (
    node_id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    node_type TEXT DEFAULT 'concept',
    is_protected INTEGER DEFAULT 0,
    properties TEXT DEFAULT '{}',
    last_accessed REAL DEFAULT 0,
    activation REAL DEFAULT 0,
    user_silence INTEGER DEFAULT 0,
    model_silence INTEGER DEFAULT 0,
    intrinsic_value REAL DEFAULT 10.0,
    half_life REAL DEFAULT 0,
    recall_count INTEGER DEFAULT 0,
    occurred_at REAL DEFAULT 0,
    learned_at REAL DEFAULT 0,
    temporal_status TEXT DEFAULT 'time_unknown',
    owner_key TEXT,
    -- v0.16.0 M2:归一墓碑(见 _migrate_graph_nodes 的说明)
    is_active INTEGER DEFAULT 1,
    superseded_by TEXT DEFAULT ''
);
CREATE TABLE IF NOT EXISTS graph_edges (
    edge_id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_id TEXT,
    target_id TEXT,
    relation TEXT DEFAULT '相关',
    weight REAL DEFAULT 1.0,
    last_accessed REAL DEFAULT 0,
    owner_key TEXT,
    half_life REAL DEFAULT 0,
    recall_count INTEGER DEFAULT 0,
    occurred_at REAL DEFAULT 0,
    learned_at REAL DEFAULT 0,
    temporal_status TEXT DEFAULT 'time_unknown',
    UNIQUE(source_id, target_id, relation, owner_key)
);
CREATE INDEX IF NOT EXISTS idx_graph_edge_src ON graph_edges(source_id, weight DESC);
CREATE TABLE IF NOT EXISTS graph_aliases (
    alias TEXT PRIMARY KEY,
    canonical_name TEXT NOT NULL,
    canonical_node_id TEXT DEFAULT '',
    created_at REAL DEFAULT 0,
    source TEXT DEFAULT 'auto'
);
-- v0.17.0 R2:传话桥三张表(权威形状在 JS lib/store.js,这里逐列镜像)。
-- 引擎不写这三张表 —— 建它们只是为了「两边 DDL 同源」这条不变量成立:
-- 任何一个进程先连上库,库的形状都必须一样(测试库/新装机尤其明显)。
CREATE TABLE IF NOT EXISTS relay_channels (
    platform     TEXT NOT NULL,
    chat_id      TEXT NOT NULL,
    chat_type    TEXT DEFAULT 'private',
    chat_title   TEXT DEFAULT '',
    session_id   TEXT NOT NULL,
    label        TEXT DEFAULT '',
    proactive    INTEGER DEFAULT 1,
    is_primary   INTEGER DEFAULT 0,
    enabled      INTEGER DEFAULT 1,
    last_in_at   REAL DEFAULT 0,
    last_out_at  REAL DEFAULT 0,
    last_error   TEXT DEFAULT '',
    created_at   REAL NOT NULL,
    PRIMARY KEY (platform, chat_id)
);
CREATE TABLE IF NOT EXISTS relay_outbox (
    out_id       INTEGER PRIMARY KEY AUTOINCREMENT,
    platform     TEXT NOT NULL,
    chat_id      TEXT NOT NULL,
    session_id   TEXT NOT NULL,
    turn_id      TEXT NOT NULL,
    kind         TEXT DEFAULT 'reply',
    text         TEXT NOT NULL,
    created_at   REAL NOT NULL,
    expires_at   REAL DEFAULT 0,
    leased_until REAL DEFAULT 0,
    acked_at     REAL DEFAULT 0,
    dropped_at   REAL DEFAULT 0,
    -- v0.18.0 气泡分条(A 侧 split_bubbles 移植)。引擎这一侧不发送,只是
    -- **列表子集纪律**:镜像表不能比 JS 侧少列(引擎可以有扩展列)——
    -- `test_ddl_parity` 就是为此存在,少一列它就红。
    not_before   REAL DEFAULT 0,
    group_id     TEXT DEFAULT '',
    seq          INTEGER DEFAULT 0,
    canceled_at  REAL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_relay_outbox_lease
    ON relay_outbox(platform, acked_at, dropped_at, leased_until, out_id);
CREATE TABLE IF NOT EXISTS relay_inbox_seen (
    platform   TEXT NOT NULL,
    msg_id     TEXT NOT NULL,
    state      TEXT DEFAULT 'pending',
    session_id TEXT DEFAULT '',
    seen_at    REAL NOT NULL,
    PRIMARY KEY (platform, msg_id)
);
CREATE INDEX IF NOT EXISTS idx_relay_inbox_seen ON relay_inbox_seen(seen_at);
"""

# 引擎扩展列:AstrBot 图引擎需要、JS 基线 DDL 没有的。
# (列名, 类型+默认值) —— 默认值与 AstrBot 代码语义一致:
# 新边出生即 Active(is_active=1)、I 缺省 10(保守值,防 H0 被压到最小)。
#
# 共管表说明:episodic_memory 的权威形状在 JS store.js(壳负责建库建表,
# insertMemory 写入);本层逐列镜像是为了让引擎在「壳尚未跑过」的库上
# 也能检索(测试库/新装机)。两边必须列级一致 —— 改一处必改另一处,
# M1 基线已冻结,以 store.js 为准。
_GRAPH_EDGE_ENGINE_COLUMNS = [
    ("intrinsic_value", "REAL DEFAULT 10.0"),
    ("activation", "REAL DEFAULT 0"),
    ("slot", "TEXT DEFAULT ''"),
    # v2-A1(2026-10-01):槽位**旧值留档**列。`slot` 升为三元组身份
    # (`源|关系|目标`),老值原样抄进 `slot_v1` —— 回退就靠它一句 UPDATE 反灌。
    ("slot_v1", "TEXT DEFAULT ''"),
    # v2-A2(2026-10-01):谓词的**原文留档**列。`relation` 存规范写法,
    # `relation_raw` 存模型/现场给的原话 —— 回退一句 UPDATE 反灌,也是审计依据。
    ("relation_raw", "TEXT DEFAULT ''"),
    ("is_active", "INTEGER DEFAULT 1"),
    ("superseded_by", "INTEGER DEFAULT 0"),
    ("layer", "TEXT DEFAULT ''"),
    # v0.16.0 M1:边的「依据」(本轮写这条边的 memory_id,「183、182」写法)。
    # 没有它,图与记忆两表之间一根线都没有 —— 面板点不回原文。
    ("evidence", "TEXT DEFAULT ''"),
    # 2026-10-01 阶段 1a(PLAN_MEMORY_GRAPH_ACTION §2③ / §3a):边的「维度」列。
    # 默认 `''` = **既有 23 条活跃边的语义逐位不变**(空串 = 事实边,与老库根本
    # 没有这一列时读到的东西等价);影子边取 `cooccur_same_memory` /
    # `cooccur_same_day` / `temporal`,与空串不相交 ⇒ 事实边槽位
    # (`slot = source_id||'|'||relation`)不受影响,也不会触发
    # `graph.py:404-410` 的让位。只 ADD COLUMN,不改既有列、不重建表。
    ("kind", "TEXT DEFAULT ''"),
]


#: 迁移账本:每个**只应跑一次**的数据改写在这里留名(幂等纪律的补强)。
#: 为什么需要它:纯 `ALTER TABLE` 天然幂等(先查列),但**数据改写**不一定 ——
#: v2-A1 的槽位改写要往 `slot_v1` 抄老值,反复跑会把留档覆盖掉。
_MIGRATION_STATE_DDL = """
CREATE TABLE IF NOT EXISTS schema_migrations (
    name        TEXT PRIMARY KEY,
    applied_at  REAL DEFAULT 0
);
"""


def _migration_applied(conn, name):
    conn.executescript(_MIGRATION_STATE_DDL)
    return conn.execute(
        "SELECT 1 FROM schema_migrations WHERE name = ?", (name,)
    ).fetchone() is not None


def _mark_migration(conn, name, *, now=None):
    import time as _time
    conn.executescript(_MIGRATION_STATE_DDL)
    conn.execute(
        "INSERT OR REPLACE INTO schema_migrations (name, applied_at) VALUES (?, ?)",
        (name, float(now or _time.time())),
    )


def _migrate_graph_edges(conn):
    """幂等迁移:补引擎列 + 槽位升为三元组身份(v2-A1)。"""
    existing = {
        row[1] for row in conn.execute("PRAGMA table_info(graph_edges)").fetchall()
    }
    for column, decl in _GRAPH_EDGE_ENGINE_COLUMNS:
        if column not in existing:
            conn.execute(f"ALTER TABLE graph_edges ADD COLUMN {column} {decl}")
    # v2-A1(2026-10-01):槽位 `源|关系` → `源|关系|目标`,老值抄进 `slot_v1`。
    # 一次性(账本留名):`slot_v1` 是**回退留档**,反复跑会把它覆盖掉。
    # 它同时接替了老版「slot 为空 → 回填 源|关系」那一步(搬家数据修复):
    # 空槽位的行现在直接得到三元组形态,`slot_v1` 留空表示"以前确实没有槽位"。
    if not _migration_applied(conn, "a1_slot_three_keys"):
        conn.execute(
            "UPDATE graph_edges SET slot_v1 = slot,"
            " slot = source_id || '|' || relation || '|' || target_id"
        )
        _mark_migration(conn, "a1_slot_three_keys")
    # 槽位自愈(幂等,随时跑):见 `sync_slots`。
    sync_slots(conn)


def sync_slots(conn):
    """把 `slot` 对齐成三元组派生身份串(幂等)。

    `slot` 只是 (源, 关系, 目标) 的**派生**串,权威始终是那三列。谓词归一(A2)、
    节点合并会把 `relation` 改掉却不改 `slot`(改名的调用点不止一处),于是槽位
    会漂。与其在每个改名点各补一次,不如每次开库对齐一遍,并让改名工具随手调它。

    `slot_v1` 是 A1 的回退留档,**这里绝不碰**(它不是派生值)。
    """
    conn.execute(
        "UPDATE graph_edges SET slot = source_id || '|' || relation || '|' || target_id"
        " WHERE COALESCE(slot, '') <> source_id || '|' || relation || '|' || target_id"
    )


def _migrate_graph_nodes(conn):
    """v0.16.0 M2:节点墓碑列(幂等)。

    为什么节点也要 `is_active/superseded_by`:`graph_edges` 上有
    `UNIQUE(source_id, target_id, relation, owner_key)`,合并时把一条边
    改指到 canonical 上,若那条三元组已存在就**撞唯一约束**——所以旧边
    只能留档(is_active=0)且仍指着旧节点。让旧节点物理消失会把那条留档
    边变成悬空引用。因此节点也走「让位」而不是删除:面板与 BFS 只看
    is_active=1,旧节点作为墓碑保留(别名表 + 备份是回滚依据)。
    """
    existing = {
        row[1] for row in conn.execute("PRAGMA table_info(graph_nodes)").fetchall()
    }
    for column, decl in (("is_active", "INTEGER DEFAULT 1"),
                         ("superseded_by", "TEXT DEFAULT ''")):
        if column not in existing:
            conn.execute(f"ALTER TABLE graph_nodes ADD COLUMN {column} {decl}")
    conn.execute(
        "UPDATE graph_nodes SET is_active = 1 WHERE is_active IS NULL"
    )
    conn.commit()


def _migrate_episodic_status(conn):
    """M2-h status 列迁移(幂等):is_active=0 是「被取代的死历史」,
    quarantined 是「待确认的活候选」—— 语义不同必须分列。旧库
    (v0.4.x 建的表没有 status)连接时补列并回填 'active';新库由
    DDL 默认值直接带上。检索/反思/合并全部只认 status='active'。

    (v0.29.0:channel / channel_chat 的补列迁移随群聊退役 —— 老库里
    已建出的列原样留着,不再被任何代码引用。)
    """
    cols = {r[1] for r in conn.execute("PRAGMA table_info(episodic_memory)")}
    if "status" not in cols:
        conn.execute(
            "ALTER TABLE episodic_memory ADD COLUMN status TEXT DEFAULT 'active'")
    # 2026-09-30:写入侧的"说法键"(JSON 数组字符串)。老库补列 ⇒ 老行是 NULL,
    # 检索侧读到空就是不加字面(逐位等于老行为)。新库由 DDL 直接带上。
    if "aug_keys" not in cols:
        conn.execute("ALTER TABLE episodic_memory ADD COLUMN aug_keys TEXT")
    # 2026-10-12 类型列(接住 Judge 已经输出的 field / stability)。
    # 老库补列 ⇒ 老行是 ''(旧行为,不强行回填 —— 我们**不知道**老记忆是什么类型,
    # 猜一个比留空更坏);新库由 DDL 直接带上。这两列**不参与任何判断**。
    if "memory_type" not in cols:
        conn.execute(
            "ALTER TABLE episodic_memory ADD COLUMN memory_type TEXT DEFAULT ''")
    if "memory_stability" not in cols:
        conn.execute(
            "ALTER TABLE episodic_memory ADD COLUMN memory_stability TEXT DEFAULT ''")
    conn.execute(
        "UPDATE episodic_memory SET status = 'active'"
        " WHERE status IS NULL OR status = ''")
    conn.commit()


def _migrate_pending_threads(conn):
    """pending_threads 的幂等补列(两批:打分缓存 + 生命周期四列)。

    这是 **JS/引擎共有表**:两边的 `_DDL` 都已带上这些列(新库由 DDL 直出),
    老库(建表时还没有它们)在这里幂等补上 —— 与 `_migrate_episodic_status`
    同一套纪律:先 `PRAGMA table_info` 再看,`ALTER TABLE ADD COLUMN` 只加不删,
    表不存在(纯引擎库,没被 JS 壳建过)就跳过 —— 引擎的 must_exist 守卫本来就
    假定"基表由壳建",少一张表不是这一趟该报的错。

    2026-09-30 P2:`score` / `score_at`(话题打分器缓存)。
    2026-10-06 D1:`kind` / `cooling_at` / `archived_at` / `superseded_by`
    (悬置话题完整机制,设计文档 §7.1;D1/D2 **只写不读**,影子期)。
    """
    try:
        cols = {r[1] for r in conn.execute("PRAGMA table_info(pending_threads)")}
    except sqlite3.DatabaseError:
        return
    if not cols:
        return
    for column, decl in (
        ("score", "REAL DEFAULT 0"),
        ("score_at", "REAL DEFAULT 0"),
        ("kind", "TEXT DEFAULT ''"),
        ("cooling_at", "REAL DEFAULT 0"),
        ("archived_at", "REAL DEFAULT 0"),
        ("superseded_by", "INTEGER DEFAULT 0"),
    ):
        if column not in cols:
            conn.execute(f"ALTER TABLE pending_threads ADD COLUMN {column} {decl}")
    conn.commit()


def _backfill_legacy_columns(conn):
    """旧行回填(v0.15.1 G20;A `core/echo_schema.py:277-301`)。

    **只回填 learned_at,不回填 layer** —— 这一条是本仓对 A 的刻意收窄,
    理由是实测出来的:空 layer 在 DSH **不等于**老行(JS 基线
    `insertMemory` 默认 layer=''),在 connect 上常开会让新写的高 I 记忆
    被误升 L0,而 L0 是每轮强制注入的核心记忆 —— 一条普通碎片就此变成
    「她永远记得的事」(实测:一条 I=80 的降级记忆被抬成 L0 后,任何
    检索都会带上它,连无关问题都注入)。
    A 的 layer 回填是**一次性老库迁移**,DSH 里"老库"只发生在
    `scripts/import-astrbot.mjs`,所以那条搬到了导入器里(按 source='qq'
    圈定范围)。这里保留 learned_at:

      * `learned_at` 空 → 「我们何时得知」这一维丢了,时间纪律算不出来。
        `timestamp` 在情景记忆里就是写入时间(= 得知时间,从不被改写:
        `_retrieve` 只动 half_life/recall_count/last_recalled),所以它是
        可信的 learned_at。**不回填 `occurred_at`** —— 旧数据「事情何时
        发生」是真的不知道,必须留 0 并保持 time_unknown(A 的原话)。

    幂等、非破坏(只补空列),缺列时跳过 —— 记忆库连不上比少补一列严重得多。
    实测活库:无事可做(`learned_at` 无 0 值),所以这次启动对现网数据**零改动**。
    """
    try:
        conn.execute(
            "UPDATE episodic_memory SET learned_at = timestamp"
            " WHERE (learned_at IS NULL OR learned_at = 0) AND timestamp > 0"
        )
    except sqlite3.Error:
        pass
    conn.commit()


def _migrate_graph_edge_receipts(conn):
    """阶段 1b 裁决①:写入侧闸门的**真值回执**表(纯增新表,幂等)。

    为什么是新表(不是 `audit_logs`、不是 JSONL):

    * **不污染主记忆**:回执只在 `graph_edge_receipts` 里,不进
      `episodic_memory` / `graph_nodes` / `graph_edges` / L0;
    * **可 SQL 查**才叫可审计 —— 落 JSONL 事后查不了,往 `audit_logs.tool_call`
      文本里塞等于把结构化审计降级成字符串;
    * **纯增**:`CREATE TABLE IF NOT EXISTS` + 一个索引,不改既有列 / 约束 / 索引。

    写入侧只在开关(`ECHO_GRAPH_GATE`)开、且真有裁决(丢边 / 改边 / 表外放行)时
    才写这张表;关掉时这张表**只建不写**(空表)。建表职权在这里(迁移),写入侧
    (`graph_gate.write_receipts`)遇到缺表只跳过、不越权建表。
    """
    conn.executescript("""
CREATE TABLE IF NOT EXISTS graph_edge_receipts (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id              TEXT DEFAULT '',
    created_at          REAL DEFAULT 0,
    kind                TEXT DEFAULT '',
    source_kind         TEXT DEFAULT '',
    target_kind         TEXT DEFAULT '',
    source_id           TEXT DEFAULT '',
    target_id           TEXT DEFAULT '',
    action              TEXT DEFAULT '',
    reason              TEXT DEFAULT '',
    rule_id             TEXT DEFAULT '',
    occurred_at         REAL DEFAULT 0,
    occurred_at_source  TEXT DEFAULT '',
    evidence_memory_id  TEXT DEFAULT '[]',
    evidence_scope      TEXT DEFAULT '',
    route               TEXT DEFAULT '',
    note                TEXT DEFAULT '',
    payload             TEXT DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_graph_edge_receipt_run
    ON graph_edge_receipts(run_id, id);
""")
    # 阶段 3a 第二步(2026-10-01):`evidence_scope` 让"这条共现边是按哪种'同一处'判的"
    # 可 SQL 查。表刚建时上面那条 DDL 已带它;对**已经建过表**的库按同一套幂等纪律补列。
    cols = {row[1] for row in conn.execute(
        "PRAGMA table_info(graph_edge_receipts)").fetchall()}
    if "evidence_scope" not in cols:
        conn.execute(
            "ALTER TABLE graph_edge_receipts ADD COLUMN evidence_scope TEXT DEFAULT ''")
    # 阶段 3a 路线 2(2026-10-01 人类裁决):影子边**另立一张表** ⇒ 回执表多一列
    # `route`(这条回执是"哪条路线"写的:'shadow-table' / 旧路线留空),便于新旧对账。
    # 纯 ADD COLUMN,幂等;不删不改既有列。
    if "route" not in cols:
        conn.execute(
            "ALTER TABLE graph_edge_receipts ADD COLUMN route TEXT DEFAULT ''")
    conn.commit()


def _migrate_graph_shadow_edges(conn):
    """阶段 3a **路线 2**(2026-10-01 人类裁决):影子边另立一张表(纯增,幂等)。

    为什么另立表(而不是继续在 `graph_edges` 里靠 `owner_key`/`kind` 区分):

    * `graph_edges` 的**每一个**读口都只按 `owner_key` 过滤(实测 19 处读点里
      13 处如此)⇒ 影子边与事实边同表时,任何"忘了加 kind 过滤"的新读口都会
      泄漏(2026-10-01 真写库时 `top_nodes()` 与 `store.topEntityNames(20)`
      当场被抓到:`音理` 第 7 → 第 2)。换表 ⇒ **现有读路径一个字不改就零泄漏**;
    * 影子边**天然不老化**:所以这张表**不放** `activation / half_life /
      recall_count / last_accessed` —— DMAE 那套状态列在结构上就不在它身上;

    纪律:纯增 —— `CREATE TABLE IF NOT EXISTS` + 两个索引,**`graph_edges` 的
    任何列 / 约束 / 索引一律不动**(`graph_edges.kind` 那两处引擎侧过滤保留,
    当"将来若还有人往 `graph_edges` 塞 kind"的保险)。
    """
    conn.executescript("""
CREATE TABLE IF NOT EXISTS graph_shadow_edges (
    edge_id             INTEGER PRIMARY KEY AUTOINCREMENT,
    source_id           TEXT NOT NULL,
    target_id           TEXT NOT NULL,
    relation            TEXT NOT NULL,
    weight              REAL DEFAULT 1,
    kind                TEXT NOT NULL,
    owner_key           TEXT DEFAULT '__shadow__',
    evidence            TEXT DEFAULT '',
    evidence_scope      TEXT DEFAULT '',
    occurred_at         REAL DEFAULT 0,
    occurred_at_source  TEXT DEFAULT '',
    is_active           INTEGER DEFAULT 1,
    created_at          REAL DEFAULT 0,
    UNIQUE(source_id, target_id, relation, owner_key)
);
CREATE INDEX IF NOT EXISTS idx_shadow_edge_src
    ON graph_shadow_edges(source_id, weight DESC);
CREATE INDEX IF NOT EXISTS idx_shadow_edge_slot
    ON graph_shadow_edges(owner_key, relation, is_active);
""")
    conn.commit()


def _migrate_graph_cooc_evidence(conn):
    """v2-A4:共现**证据层**(纯增表 + 只读视图,幂等)。

    为什么不是"pair 边表":一份 2026-10-01 的机制调查(16 个来源,见
    `docs/ASSOC_GRAPH_SURVEY.md`)里,共现这一层的一致做法是**超边/证据指针** ——
    记「**哪条记忆里同时出现了哪些概念**」,把「概念↔概念的边」留给查询期按需派生。
    在盘上把共现铺成两两 pair 边,等于把一个 n 元事实拆成 n² 个弱事实,噪声与
    存储都放大,而且每个新读口都得自己记得"这不是事实边"。

    所以这张表一行 = **一条证据**(一条记忆 / 一天),列 `node_ids` 是 n 元内容,
    `pairs` 是闸门(R1–R6)当时**放行**的那几对(原样保留判据,**不在盘上铺边**);
    `v_cooc_pairs` 是**只读视图**,按需把它们展开成 pair 行。

    ⚠️ 纪律:`graph_shadow_edges` 那 48 条 pair 行**冻结不动**(留作审计),本表由
    `python/engine/cooc.py` 从它们**一次性**迁入;此后(下一期)新共现直接写本表。
    """
    conn.executescript("""
CREATE TABLE IF NOT EXISTS graph_cooc_evidence (
    evidence_id INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_key   TEXT DEFAULT '__cooc__',
    scope_kind  TEXT NOT NULL,
    memory_id   INTEGER DEFAULT 0,
    day_key     TEXT DEFAULT '',
    node_ids    TEXT NOT NULL DEFAULT '',
    pairs       TEXT NOT NULL DEFAULT '',
    node_count  INTEGER DEFAULT 0,
    pair_count  INTEGER DEFAULT 0,
    weight      REAL DEFAULT 1,
    source_kind TEXT DEFAULT '',
    created_at  REAL DEFAULT 0,
    UNIQUE(owner_key, scope_kind, memory_id, day_key)
);
CREATE INDEX IF NOT EXISTS idx_cooc_evidence_scope
    ON graph_cooc_evidence(owner_key, scope_kind, day_key);
CREATE VIEW IF NOT EXISTS v_cooc_pairs AS
WITH RECURSIVE exp(evidence_id, rest, item) AS (
    SELECT evidence_id, pairs || ',', '' FROM graph_cooc_evidence
    UNION ALL
    SELECT evidence_id, substr(rest, instr(rest, ',') + 1),
           substr(rest, 1, instr(rest, ',') - 1)
    FROM exp WHERE rest <> ''
)
SELECT e.evidence_id, e.owner_key, e.scope_kind, e.memory_id, e.day_key,
       x.item AS pair_key,
       substr(x.item, 1, instr(x.item, '|') - 1) AS source_id,
       substr(x.item, instr(x.item, '|') + 1) AS target_id,
       e.weight AS weight, e.created_at AS created_at
FROM exp x JOIN graph_cooc_evidence e ON e.evidence_id = x.evidence_id
WHERE x.item <> '';
""")
    conn.commit()


def _migrate_graph_topic_view(conn):
    """v2-A5:主题簇**视图**(纯增两张表,幂等)。

    一层一句话:把 A4 证据层上算出来的"主题簇"存成**视图产物**,不是一个新本体 ——
    簇是算法给的、可重算、**软归属**(一个概念可属多簇),而且**不进检索**。

    * `graph_topic_clusters` 一行 = 一簇(算法 + 参数 + 算的时间 + 那一批的批号);
      `is_active` 支持**整批换代**:重算 = 旧批置 0、新批写入(`batch_key` 便于整批回退)。
    * `graph_topic_members` 一行 = 一个成员(默认 `member_kind='node'`,存概念节点),
      `weight` = 隶属强度(primary 恒 1.0,软归属 = 与该簇主要成员的共现记忆占比),
      `is_primary` 标出它的**硬归属**哪个是本体给的那个。

    ⚠️ 纪律:这两张表**只被面板/报表读**,检索与人格注入不碰(有 grep 级守卫测试);
    簇**不许**写成 `graph_edges` 的边(那就成了手写本体 —— 见 `docs/§9 不做清单`)。
    """
    conn.executescript("""
CREATE TABLE IF NOT EXISTS graph_topic_clusters (
    cluster_id   INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_key    TEXT DEFAULT '__topic__',
    level        TEXT DEFAULT 'concept',
    label        TEXT DEFAULT '',
    summary      TEXT DEFAULT '',
    algorithm    TEXT DEFAULT '',
    params       TEXT DEFAULT '',
    member_count INTEGER DEFAULT 0,
    batch_key    TEXT DEFAULT '',
    computed_at  REAL DEFAULT 0,
    is_active    INTEGER DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_topic_clusters_active
    ON graph_topic_clusters(owner_key, is_active, batch_key);
CREATE TABLE IF NOT EXISTS graph_topic_members (
    cluster_id  INTEGER NOT NULL,
    member_kind TEXT DEFAULT 'node',
    member_id   TEXT NOT NULL,
    weight      REAL DEFAULT 1,
    is_primary  INTEGER DEFAULT 0,
    owner_key   TEXT DEFAULT '__topic__',
    UNIQUE(cluster_id, member_kind, member_id)
);
CREATE INDEX IF NOT EXISTS idx_topic_members_member
    ON graph_topic_members(member_kind, member_id, owner_key);
""")
    conn.commit()


def _ensure_indexes(conn):
    """A 的三个索引(v0.15.1 G20;`echo_schema.py:66,507,510`)。

    为什么**必须**在迁移之后再建:本仓的 `graph_edges.slot` 是引擎扩展列
    (`_migrate_graph_edges` ALTER 加的),基表 DDL 里没有它 —— 把
    `idx_graph_edge_slot` 写进 `_DDL` 会在**新库**上直接炸
    (`no such column: slot`),而新库恰恰是最该顺利建起来的那种。
    `idx_episodic_speaker` 的列基表本来就有,放这里只是为了三处一起看。

    槽位索引是给**槽位取代链**用的(`WHERE owner_key=? AND slot=?`):
    没有它,图谱每写一条都要扫全表(A `:507` 的注释也是这个意思)。
    逐条 try/except:缺列的库跳过这一条,不让 connect 崩。
    """
    for stmt in (
        "CREATE INDEX IF NOT EXISTS idx_episodic_speaker"
        " ON episodic_memory(speaker_id, is_active, timestamp DESC)",
        "CREATE INDEX IF NOT EXISTS idx_graph_edge_slot"
        " ON graph_edges(owner_key, slot, is_active)",
        "CREATE INDEX IF NOT EXISTS idx_graph_edge_owner"
        " ON graph_edges(owner_key, source_id, weight DESC)",
        # v2-A1:换代判据查 `(owner_key, source_id, relation)`(不再用槽位唯一性),
        # 没这条索引会退化成扫表。
        "CREATE INDEX IF NOT EXISTS idx_graph_edge_src_rel"
        " ON graph_edges(owner_key, source_id, relation, is_active)",
    ):
        try:
            conn.execute(stmt)
        except sqlite3.Error:
            pass
    conn.commit()


def connect(db_path, must_exist=False):
    """打开库并确保引擎 schema 就绪。

    must_exist=True:库文件必须已存在(JS 壳负责建库;worker 永不建库 ——
    文件中途消失是异常,报错而不是悄悄重建空库让记忆「静默失忆」)。
    busy_timeout=5000:JS 基线读库与引擎写库可能短暂争锁,等而不是炸。
    """
    if must_exist and db_path != ":memory:" and not Path(db_path).exists():
        raise FileNotFoundError("db not found: " + str(db_path))
    conn = sqlite3.connect(db_path)
    conn.execute("PRAGMA busy_timeout = 5000")
    conn.executescript(_DDL)
    _migrate_graph_edges(conn)
    _migrate_graph_nodes(conn)
    _migrate_episodic_status(conn)
    _migrate_pending_threads(conn)
    _migrate_graph_edge_receipts(conn)
    _migrate_graph_shadow_edges(conn)
    _migrate_graph_cooc_evidence(conn)
    _migrate_graph_topic_view(conn)
    _ensure_indexes(conn)
    _backfill_legacy_columns(conn)
    _repair_dangling_superseded(conn)
    conn.commit()
    return conn


def _repair_dangling_superseded(conn):
    """F3(2026-09-27):清掉指向不存在行的 `superseded_by` —— 幂等,随 connect 跑。

    现场:全库 50 行有 `superseded_by`,16 行指向空气。根因是两个 A 侧导入器
    (`scripts/import-astrbot.mjs:103`、`scripts/merge-astrbot.mjs:410`)把 A 侧的
    `superseded_by` 原样照抄,没做旧 id → 新 id 重映射;A 侧 id 到了 445,迁移只
    搬 256 行。详见 `integrity` 模块 docstring。

    为什么放在 connect:这是**数据修复**而不是写入拦截(F1 拦的是新写入),
    修一次就够,幂等所以每次连库跑一遍也不亏 —— 而且这样它走的是插件自己的
    代码路径,不需要谁去手改 `echo.db`。

    只清引用、**不动 `is_active`**:那 16 行本来就是留档(被取代的死历史),
    把它们复活是另一件事(要判断"有没有真的替代品"),不在这一步里偷偷做。
    """
    fixed = integrity.repair_dangling_superseded(
        conn, "episodic_memory", "memory_id", commit=False)
    fixed += integrity.repair_dangling_superseded(
        conn, "graph_edges", "edge_id", commit=False)
    fixed += integrity.repair_dangling_superseded(
        conn, "graph_nodes", "node_id", commit=False)
    if fixed:
        # 引擎侧没有 logger(worker 用 stdout 协议帧),修复是低频事件,
        # 走 stderr 不污染协议流。
        print("echo-engine: 修复了 %d 条悬空 superseded_by 引用" % fixed,
              file=sys.stderr)
    return fixed
