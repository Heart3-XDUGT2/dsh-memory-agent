/**
 * 记忆存储层 —— node:sqlite(宿主 Node 24 自带,零原生依赖)。
 * 表结构从 AstrBot echo_schema.py 原样移植:v8.9 全列集一次建齐,
 * 不做 ALTER 补列舞蹈(全新库,没有旧库包袱)。
 *
 * DSH 世界的归属简化(与 AstrBot 的差异,有意为之):
 *   user_id   恒为 'master' —— DSH 是单主人陪伴,她只有一个<称呼>
 *   session_id 恒为 'global' —— 她的心情是"一个人"的状态,跨会话延续,
 *             不是每个聊天窗口一份人格(AstrBot 因 QQ 多会话才按会话隔离)
 * 图谱两表 M1 只建表+搬家(M2 接引擎);reflection_state/her_agenda/
 * pending_threads 同为 M2 预留。
 */

import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { rankMemories, CANDIDATE_LIMIT } from './retrieve.js'
// 2026-10-06:审计裁剪按"证据行/工具行"分预算 —— 判据(标记)从产地 import,
// 不在 SQL 里抄第二份字面量(工具审计行由 lib/tool-audit.js 写)。
import { TOOL_ROW_MARKER } from './tool-audit.js'
import { retrievability, reinforceHalfLife, initialHalfLife, deriveState, DMAE_DEFAULT } from './dmae.js'
import { isHumanUtterance } from './inbound-filter.js'
import { ghostLayers } from './graph-ghost.js'
import { loadNames } from './names.js'
// P3-a:状态初值可被 state-defaults.json 覆盖(空 ⇒ 与迁移前逐位一致的 3/neutral)。
import { stateDefaultsOf, numberField, objectField } from './data-tables.js'

export const MASTER_ID = 'master'
export const GLOBAL_SESSION = 'global'

/**
 * v0.14.5 S11:主动轮哨兵(A `core/echo_constants.py:12` 逐字)。
 *
 * 她主动开口(关怀/提醒)的那一轮**没有用户发言** —— 早期实现把用户侧
 * 记成空串,于是反思信封的最近 5 轮里出现一行空的「用户：」:模型可能
 * 把她自己说的话当成你说的,或者干脆把那一轮当噪声丢掉。A 的办法是
 * 记一个哨兵,渲染时特判(`brain_pipeline.py:1008-1011`
 * →「【你主动开口】你: …」),不伪造用户发言行。
 */
export const PROACTIVE_ROUND_MARKER = '(她主动开口)'

/**
 * v0.18.3 M3:画像"必须每轮都在场"的身份锚点 —— 封闭的两个键
 * (A `echo_memory_engine.py:52`)。称呼走 `name` 列,职业/兴趣等身份
 * 事实归记忆层检索,不进常驻区(A 的原话:它们是记忆系统的事)。
 * 只在本模块用(读侧 getProfile / 写侧 saveProfileTraits),**不导出**:
 * 白名单是一条实现纪律,不是给外面拼装用的开关。
 */
const PROFILE_ALWAYS_ON_KEYS = ['语言', '代词']
/** 常驻项硬上限(A `PROFILE_MAX_ITEMS = 5`,含"称呼")。 */
const PROFILE_MAX_ITEMS = 5

// v0.11.0 对话记录(M8-a):全局滚动窗口大小 —— 用户裁决 100 轮。
const CONVERSATION_KEEP = 100

const DDL = `
CREATE TABLE IF NOT EXISTS user_profile (
    user_id TEXT PRIMARY KEY,
    name TEXT,
    core_traits TEXT,
    affinity INTEGER DEFAULT 50,
    emotion_state TEXT DEFAULT 'neutral',
    last_updated TIMESTAMP
);
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
    -- 2026-09-30 说法键:JSON 数组字符串(「以后他可能怎么问这件事」的说法)。
    -- 与 python/engine/db.py 同步;检索打分正文里会带上它。
    aug_keys TEXT,
    -- 2026-10-12 类型列(接住 Judge 已经输出的 field / stability)。
    -- 为什么加:模型**早就在判**「稳定信息 vs 局部偏好」了(judge.py 的
    -- L0_FIELDS/L1_FIELDS + VALID_STABILITIES),但落库时 4/6 个 field 与
    -- 整个 stability 被丢掉 ⇒ 记忆侧没有"类型"可用。这两列只做**别丢**,
    -- **不参与任何判断**(检索/layer/图谱一个字不动)。
    -- 与 python/engine/db.py 同步;空 = 旧行为(老行留空,不回填)。
    memory_type TEXT DEFAULT '',
    memory_stability TEXT DEFAULT ''
    -- (v0.29.0 个人机器人裁剪:channel / channel_chat 两列随群聊拒收
    --  一起退役。老库里已建出的列原样留着(全空,不引用不迁移);新库
    --  不再创建。记忆不再分渠道 —— 只服务他一个人,没有「往哪儿渗」
    --  的问题。)
);
CREATE INDEX IF NOT EXISTS idx_episodic_user
    ON episodic_memory(user_id, is_active, timestamp DESC);
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
      -- 2026-10-09 期 0(审计仪表盘的数据契约):轮内阶段与步序。
      -- 「stage」回答这一轮走到哪一步;「step」回答同秒内的先后。
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
CREATE TABLE IF NOT EXISTS reflection_state (
    user_id TEXT PRIMARY KEY,
    last_memory_id INTEGER DEFAULT 0,
    last_at REAL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS diary (
    date TEXT PRIMARY KEY,
    content TEXT NOT NULL,
    mood INTEGER DEFAULT 3,
    longing_value REAL DEFAULT 0,
    created_at TIMESTAMP
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
    -- 2026-09-30 P2:打分结果缓存(施工图 §1.1-1)。**JS/引擎共有表** ——
    -- 加列必须同改 python/engine/db.py 的 _DDL,否则 test_ddl_parity 红。
    score REAL DEFAULT 0,
    score_at REAL DEFAULT 0,
    -- 2026-10-06 D1(悬置话题完整机制,设计文档 §7.1):生命周期四列。
    -- **JS/引擎共有表** —— 加列必须同改 python/engine/db.py 的 _DDL,
    -- 否则 test_ddl_parity 的"引擎 ⊇ JS"灯红。D1 阶段**只写不读**(影子期)。
    kind TEXT DEFAULT '',
    cooling_at REAL DEFAULT 0,
    archived_at REAL DEFAULT 0,
    superseded_by INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_pending_threads_user
    ON pending_threads(user_id, status, follow_up_after);
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
    -- v0.16.0 M2:归一墓碑(与 db.py 同款)。合并时节点走「让位」而不是
    -- 物理删除:graph_edges 有 UNIQUE(s,t,rel,owner),被让位的旧边仍
    -- 指着旧节点,删节点会留下悬空引用。面板与 BFS 只看 is_active=1。
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
    -- v0.13.0:对齐 python 引擎超集(QQ 同款 schema 也有这些列)——
    -- 动态图谱要 SELECT 它们;JS 独建的新库(测试 :memory:)此前缺列,
    -- graphData 富化后会炸。对已存在的表本 DDL 是 no-op,不迁移。
    intrinsic_value REAL DEFAULT 0,
    activation REAL DEFAULT 0,
    slot TEXT,
    is_active INTEGER DEFAULT 1,
    superseded_by INTEGER DEFAULT 0,
    layer TEXT,
    -- v0.16.0 M1:边的「依据」——本轮反思写这条边时落库的 memory_id 列表
    -- (「183、182」这种写法,与 her_agenda.evidence 同风格)。图谱页
    -- 据此点回记忆原文;没有它,图与记忆两表之间一根线都没有。
    evidence TEXT DEFAULT '',
    UNIQUE(source_id, target_id, relation, owner_key)
);
CREATE INDEX IF NOT EXISTS idx_graph_edge_src ON graph_edges(source_id, weight DESC);
-- v0.16.0 M2:实体别名接地表。写入时先查这里,合并结果会被后续写入
-- 自动沿用(否则合并完又长出来)。alias 精确匹配 name 原文。
CREATE TABLE IF NOT EXISTS graph_aliases (
    alias TEXT PRIMARY KEY,
    canonical_name TEXT NOT NULL,
    canonical_node_id TEXT DEFAULT '',
    created_at REAL DEFAULT 0,
    source TEXT DEFAULT 'auto'
);
CREATE TABLE IF NOT EXISTS conversation_log (
    turn_id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL DEFAULT '',
    channel TEXT DEFAULT '',
    user_text TEXT DEFAULT '',
    reply_text TEXT DEFAULT '',
    created_at REAL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_conversation_session ON conversation_log(session_id, turn_id DESC);
-- v0.17.0 R2:传话桥三张表(设计稿 docs/RELAY_PLAN.md §五)。
-- 它们**只属于 DSH 侧** —— 平台适配器是纯 HTTP 客户端,一个字段都不用碰。
-- 一个聊天(平台+聊天)→ 一个 DSH 会话。D1 定了「全平台全场合共用一个
-- 陪伴会话」,所以这张表是**路由表**而不是「一人一会话」:
--   session_id 通常都指向那一个陪伴会话,但它仍然逐聊天记着
--   「回哪儿、要不要主动推、最近收发」。
CREATE TABLE IF NOT EXISTS relay_channels (
    platform     TEXT NOT NULL,          -- 'qq' / 'telegram' / ...
    chat_id      TEXT NOT NULL,          -- 平台内聊天标识(适配器归一后)
    chat_type    TEXT DEFAULT 'private', -- private | group
    chat_title   TEXT DEFAULT '',        -- 群里显示用
    session_id   TEXT NOT NULL,
    label        TEXT DEFAULT '',        -- 回放里的渠道标签(如「QQ:群名」)
    proactive    INTEGER DEFAULT 1,      -- 主动开口是否推到这个聊天
    is_primary   INTEGER DEFAULT 0,      -- 想念/提醒的默认落点(每平台一个)
    enabled      INTEGER DEFAULT 1,
    last_in_at   REAL DEFAULT 0,
    last_out_at  REAL DEFAULT 0,
    last_error   TEXT DEFAULT '',
    created_at   REAL NOT NULL,
    PRIMARY KEY (platform, chat_id)
);
-- 出站队列(她的回复 / 主动话 / 提醒)。租约 + ack 防丢也防重发:
-- 取出即打 leased_until,适配器发成功才 ack;租约过期自动可再取。
CREATE TABLE IF NOT EXISTS relay_outbox (
    out_id       INTEGER PRIMARY KEY AUTOINCREMENT,
    platform     TEXT NOT NULL,
    chat_id      TEXT NOT NULL,
    session_id   TEXT NOT NULL,
    turn_id      TEXT NOT NULL,          -- 同一回合的多条合并成一条发(分泡时按 turn_id#seq 区分)
    kind         TEXT DEFAULT 'reply',   -- reply | proactive | reminder
    text         TEXT NOT NULL,
    created_at   REAL NOT NULL,
    expires_at   REAL DEFAULT 0,         -- >0 且过期 = 丢弃不补发(迟到的关怀不是关怀)
    leased_until REAL DEFAULT 0,         -- 0=可领;>now=租约中
    acked_at     REAL DEFAULT 0,
    dropped_at   REAL DEFAULT 0,
    -- v0.18.0 气泡分条(A 侧 split_bubbles 移植):一个回合的话被切成几泡,
    -- 每泡一行。not_before = 这泡的到期时刻(适配器按它发,才有人打字的节奏),
    -- group_id = 泡组(同一个 turn),seq = 第几泡(从 0 数)。
    not_before   REAL DEFAULT 0,
    group_id     TEXT DEFAULT '',
    seq          INTEGER DEFAULT 0,
    canceled_at  REAL DEFAULT 0          -- barge-in:他插话,这泡没发出去就作废
);
CREATE INDEX IF NOT EXISTS idx_relay_outbox_lease
    ON relay_outbox(platform, acked_at, dropped_at, leased_until, out_id);
-- 入站幂等(适配器重试不让她答两遍)。
-- state:pending(已受理未落定,可被重试接管)| accepted(答过了)。
CREATE TABLE IF NOT EXISTS relay_inbox_seen (
    platform   TEXT NOT NULL,
    msg_id     TEXT NOT NULL,
    state      TEXT DEFAULT 'pending',
    session_id TEXT DEFAULT '',
    seen_at    REAL NOT NULL,
    PRIMARY KEY (platform, msg_id)
);
CREATE INDEX IF NOT EXISTS idx_relay_inbox_seen ON relay_inbox_seen(seen_at);

-- v0.31.0 P2:「她为什么没开口」的账(2026-09-28 · 45 小时静默那次的根治)。
-- 纪律(**docs/DISCIPLINE.md**):reason 只许枚举(可 GROUP BY);全通过才静默、
-- 任一否定必留痕。status 里的 care.reason 是**瞬时字段**,翻不了历史 —— 这张表行。
-- 为什么单独一张表而不是塞进 audit_logs:审计是"她说了什么"的账(一人一行、很贵);
-- 这张是"她**没**说什么及为什么"的账(高频、便宜、只读)。混在一起两个都读不清。
CREATE TABLE IF NOT EXISTS care_beats (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    at           REAL NOT NULL,
    kind         TEXT NOT NULL,
    reason       TEXT NOT NULL,
    value        REAL DEFAULT 0,
    threshold    REAL DEFAULT 0,
    should_act   INTEGER DEFAULT 0,
    acted        INTEGER DEFAULT 0,
    session_id   TEXT DEFAULT '',
    -- 2026-09-29:这一拍**投到哪条会话**开口(= 她那一条陪伴会话)。
    -- 为什么必须有:session_id 记的是"她锚在哪条会话"(他最后说话的那条),
    -- 只记它的话,事后无法回答"她本该在哪开口、为什么没对上" —— v0.42.0 那次
    -- 连吃 70 拍 session-mismatch 潜伏 20 小时,就是被这个盲区掩护的。
    target_session_id TEXT DEFAULT '',
    -- 2026-09-30 P2(主动性 v2 话题打分器):这一拍**组了几个候选、最高分多少、
    -- 被哪一道判掉、那条候选是谁**。为什么要有:candidates/top_score 让"为什么
    -- 没开口"从一句理由变成可算的数;rejected_by 记**归因**(local = 本地分没过 /
    -- review = 复核没过);topic_id 记那条候选(thread:19 / mem:7 / diary:2026-09-30)。
    -- ⚠️ 老的 value/threshold 两列**语义不动**(想念值 × 引擎阈值),新分数另走
    -- top_score —— 同行双读数,不许混。
    candidates   INTEGER DEFAULT 0,
    top_score    REAL DEFAULT 0,
    rejected_by  TEXT DEFAULT '',
    topic_id     TEXT DEFAULT '',
    trace_id     TEXT DEFAULT '',
    payload_json TEXT DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_care_beats_at ON care_beats(at DESC);
CREATE INDEX IF NOT EXISTS idx_care_beats_reason ON care_beats(reason, at DESC);

-- v0.31.0 P2:她自己的闹钟(echo_wake 工具的落点)。
-- 为什么**不**复用 pending_threads:那条账的「到点主动提」由引擎判
-- (engine.js 的注释写着 follow_up_after=0 ⇒ 永不主动提),引擎不在时整条路是哑的 ——
-- 而 45 小时那次事故正是引擎/适配器不在。闹钟放**本地**:心跳直接读它,
-- 引擎在不在都能到点。这是"她的器官不依赖别的器官"那条边界的第一次落地。
CREATE TABLE IF NOT EXISTS echo_wakes (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    at          REAL NOT NULL,
    note        TEXT NOT NULL,
    why         TEXT DEFAULT '',
    session_id  TEXT DEFAULT '',
    created_at  REAL NOT NULL,
    fired_at    REAL DEFAULT 0,
    canceled_at REAL DEFAULT 0,
    fired_reason TEXT DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_echo_wakes_at ON echo_wakes(at, fired_at, canceled_at);
`

/**
 * 打开(并初始化)记忆库。dbPath 传 ':memory:' 用于测试。
 *
 * v0.14.5 S10:opts.auditKeep = 审计保留条数(A 侧 200,本仓定案 100),
 * 每次写审计后顺手裁剪。缺省 100;面板改配置后由 `setAuditKeep` 热更新。
 */
export function openStore (dbPath, opts = {}) {
  let auditKeep = clampAuditKeep(opts.auditKeep)
  if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true })
  const db = new DatabaseSync(dbPath)
  // v0.10.0 共享灵魂库(M8):与 AstrBot 插件同库多进程并发 —— 锁忙时
  // 等而不是炸(对齐 python 引擎 db.py 与 AstrBot main.py 的 5000ms);
  // 顺序在 WAL 之前:journal_mode 切换在竞争库上也可能短暂忙等。
  db.exec('PRAGMA busy_timeout = 5000')
  db.exec('PRAGMA journal_mode = WAL')
  db.exec(DDL)
  // v0.18.0 气泡分条的列迁移(幂等):老库的 relay_outbox 建表时还没有这四列。
  // 少一列会让分泡整条路静默降级成"一泡",所以宁可逐列试着补。
  for (const [col, decl] of [
    ['not_before', 'REAL DEFAULT 0'],
    ['group_id', "TEXT DEFAULT ''"],
    ['seq', 'INTEGER DEFAULT 0'],
    ['canceled_at', 'REAL DEFAULT 0']
  ]) {
    try { db.exec(`ALTER TABLE relay_outbox ADD COLUMN ${col} ${decl}`) } catch { /* 列已在:跳过 */ }
  }
  // M2-h status 列迁移(与 db.py 同款幂等):is_active=0 是「被取代的
  // 死历史」,quarantined 是「待确认的活候选」—— 语义不同必须分列。
  // 旧库(v0.4.x 建表无此列)打开时补列并回填 'active'。
  {
    const cols = db.prepare('PRAGMA table_info(episodic_memory)').all().map(r => r.name)
    if (!cols.includes('status')) {
      db.exec("ALTER TABLE episodic_memory ADD COLUMN status TEXT DEFAULT 'active'")
    }
    // 2026-09-30:写入侧"说法键"(JSON 数组字符串)。老库补列(老行为 = NULL =
    // 检索时一个字面都不加);新库由 DDL 带上。与 python/engine/db.py 同一步。
    if (!cols.includes('aug_keys')) {
      try { db.exec('ALTER TABLE episodic_memory ADD COLUMN aug_keys TEXT') } catch { /* 无表:跳过 */ }
    }
    db.exec("UPDATE episodic_memory SET status = 'active' WHERE status IS NULL OR status = ''")
  }
  // 2026-09-29:care_beats 补 `target_session_id`(这一拍投到哪条会话开口)。
  // 老库的拍没有这一列 ⇒ 补成空串("当时投到哪没记")。这张表是 JS 独建
  // (不在 python DDL 镜像里),所以只有这一侧要补。
  // 2026-09-30 P2:同一次幂等补列里再补话题打分器那四列(candidates / top_score /
  // rejected_by / topic_id)—— 老库只 `ALTER TABLE ADD COLUMN`(全部 DEFAULT),
  // **不删列、不重建表**(旧行读出来是 0 / 0 / '' / '' = "这一拍没有打分读数")。
  try {
    const bcols = db.prepare('PRAGMA table_info(care_beats)').all().map((r) => r.name)
    for (const [col, decl] of [
      ['target_session_id', "TEXT DEFAULT ''"],
      ['candidates', 'INTEGER DEFAULT 0'],
      ['top_score', 'REAL DEFAULT 0'],
      ['rejected_by', "TEXT DEFAULT ''"],
      ['topic_id', "TEXT DEFAULT ''"]
    ]) {
      if (!bcols.includes(col)) db.exec(`ALTER TABLE care_beats ADD COLUMN ${col} ${decl}`)
    }
  } catch { /* 无表:跳过 */ }
  // 2026-09-30 P2 + 2026-10-06 D1:pending_threads 的补列(老库没有的那些)。
  // ⚠️ 这是 **JS/引擎共有表** —— DDL 两侧都已带上,这里再补一次是给**老库**
  // (老库里那些列不存在)。引擎侧自己对自有扩展列也有幂等迁移;两边都补,
  // 谁先连上库都不会缺列(§3.1 的共有表漂移就是这么来的)。
  // D1 的四列(kind / cooling_at / archived_at / superseded_by)= 悬置话题完整机制,
  // 设计文档 §7.1;**只写不读**(影子期),读侧一律不引用。
  try {
    const tcols = db.prepare('PRAGMA table_info(pending_threads)').all().map((r) => r.name)
    for (const [col, decl] of [
      ['score', 'REAL DEFAULT 0'],
      ['score_at', 'REAL DEFAULT 0'],
      ['kind', "TEXT DEFAULT ''"],
      ['cooling_at', 'REAL DEFAULT 0'],
      ['archived_at', 'REAL DEFAULT 0'],
      ['superseded_by', 'INTEGER DEFAULT 0']
    ]) {
      if (!tcols.includes(col)) db.exec(`ALTER TABLE pending_threads ADD COLUMN ${col} ${decl}`)
    }
  } catch { /* 无表:跳过 */ }
  // 2026-10-05 第三批:audit_logs 补 `emotion_pack_structured`(联合空间结构化读数)。
  // 老库没有这一列 ⇒ 补成空串("当时没算")。这一列**只进审计、不进 prompt**
  // (影子模式,拍板 ⑤),所以 DDL 与这里都给了 `DEFAULT ''`,读出来空 = 没算过。
  try {
    const acols = db.prepare('PRAGMA table_info(audit_logs)').all().map((r) => r.name)
    // 期 0(2026-10-09):同款纯增迁移 —— 老库补两列;缺列只影响新面板,不影响旧代码。
    if (!acols.includes('stage')) db.exec("ALTER TABLE audit_logs ADD COLUMN stage TEXT DEFAULT ''")
    if (!acols.includes('step')) db.exec('ALTER TABLE audit_logs ADD COLUMN step INTEGER DEFAULT 0')
    if (!acols.includes('stage_detail')) db.exec("ALTER TABLE audit_logs ADD COLUMN stage_detail TEXT DEFAULT ''")
    if (!acols.includes('emotion_pack_structured')) {
      db.exec("ALTER TABLE audit_logs ADD COLUMN emotion_pack_structured TEXT DEFAULT ''")
    }
  } catch { /* 无表:跳过 */ }
  // v0.16.0 M4:画像脏值清理(幂等)。实测活库 `name='null'` 是**字面量
  // 字符串** —— 模型把提示词里的 `"name": null` 原样吐成了字符串 "null",
  // 一路写进画像,面板就显示「称呼:null」。清成 NULL 并从此在写入端
  // 拒收这些占位词(cleanName)。
  try {
    db.exec("UPDATE user_profile SET name = NULL WHERE lower(trim(name)) IN ('null','undefined','none','nil','n/a','无','未提供')")
  } catch { /* 无表:跳过 */ }
  // v0.16.0 M1/M2 列迁移(与 db.py 同款幂等):老库的 graph_edges 可能
  // 没有 v0.13.0 那批引擎列,更不会有 v0.16.0 的 evidence。
  // 逐条 try/catch —— 表都不存在时也只是跳过(体检脚本仍能跑)。
  // (v0.29.0:episodic_memory 的 channel/channel_chat 迁移随群聊退役 ——
  //  老库里已建出的列原样留着,不再被任何代码引用。)
  {
    const cols = db.prepare('PRAGMA table_info(graph_edges)').all().map(r => r.name)
    for (const [col, decl] of [
      ['intrinsic_value', 'REAL DEFAULT 0'],
      ['activation', 'REAL DEFAULT 0'],
      ['slot', "TEXT DEFAULT ''"],
      // v2-A1(与 db.py 同源):槽位旧值留档列(回退用)。
      ['slot_v1', "TEXT DEFAULT ''"],
      // v2-A2:谓词原文留档列(回退/审计用)。
      ['relation_raw', "TEXT DEFAULT ''"],
      ['is_active', 'INTEGER DEFAULT 1'],
      ['superseded_by', 'INTEGER DEFAULT 0'],
      ['layer', "TEXT DEFAULT ''"],
      ['evidence', "TEXT DEFAULT ''"]
    ]) {
      if (cols.includes(col)) continue
      try { db.exec(`ALTER TABLE graph_edges ADD COLUMN ${col} ${decl}`) } catch { /* 无表:跳过 */ }
    }
  }
  {
    const cols = db.prepare('PRAGMA table_info(graph_nodes)').all().map(r => r.name)
    for (const [col, decl] of [['is_active', 'INTEGER DEFAULT 1'], ['superseded_by', "TEXT DEFAULT ''"]]) {
      if (cols.includes(col)) continue
      try { db.exec(`ALTER TABLE graph_nodes ADD COLUMN ${col} ${decl}`) } catch { /* 无表:跳过 */ }
    }
  }
  // v0.15.1 G20:补齐 A 的三个索引(`echo_schema.py:66,507,510`)。
  // **必须逐条 try/catch,而且不能写进 DDL**:老库的表可能缺列
  // (v0.4.x 没有 speaker_id;更老的 graph_edges 没有 slot/owner_key),
  // 而 DDL 是整体 exec —— 一条索引失败会把**整个 openStore 掀掉**,
  // 记忆库直接打不开,比少一个索引严重得多。缺列就跳过,等那条列
  // 由迁移补上(引擎侧 db.py 用的是同一套策略)。
  for (const stmt of [
    'CREATE INDEX IF NOT EXISTS idx_episodic_speaker ON episodic_memory(speaker_id, is_active, timestamp DESC)',
    'CREATE INDEX IF NOT EXISTS idx_graph_edge_slot ON graph_edges(owner_key, slot, is_active)',
    'CREATE INDEX IF NOT EXISTS idx_graph_edge_owner ON graph_edges(owner_key, source_id, weight DESC)',
    // v2-A1:换代判据查 (owner_key, source_id, relation)
    'CREATE INDEX IF NOT EXISTS idx_graph_edge_src_rel ON graph_edges(owner_key, source_id, relation, is_active)'
  ]) {
    try { db.exec(stmt) } catch { /* 缺列的老库:跳过 */ }
  }

  const rowToMemory = (r) => ({
    memoryId: r.memory_id,
    userId: r.user_id,
    keywords: safeJsonArray(r.keywords),
    summary: r.summary || '',
    emotionScore: r.emotion_score || 0,
    timestamp: Number(r.timestamp) || 0,
    isActive: r.is_active,
    source: r.source || 'private',
    sourceLabel: r.source_label || '',
    actor: r.actor || '',
    intrinsicValue: Number(r.intrinsic_value) || 0,
    halfLife: Number(r.half_life) || 0,
    recallCount: r.recall_count || 0,
    lastRecalled: Number(r.last_recalled) || 0,
    occurredAt: Number(r.occurred_at) || 0,
    learnedAt: Number(r.learned_at) || 0,
    temporalStatus: r.temporal_status || 'time_unknown',
    memoryKey: r.memory_key || '',
    layer: r.layer || '',
    evidence: r.evidence || '',
    // v0.16.0 M1:依据气泡要说清「这条是隔离候选 / 已被 #n 取代」——
    // 少了这两列,回指只能显示半句话(面板侧已按 isActive 兜底显示
    // 「已被取代」,但指不到是谁取代的)。
    status: r.status || 'active',
    supersededBy: Number(r.superseded_by) || 0,
    // 2026-09-30:说法键 —— 打分正文要用它(`lexical.docText`),所以必须
    // 从行里带出来;库里是 JSON 字符串,这里解析成数组(脏值 ⇒ 空数组)。
    augKeys: safeJsonArray(r.aug_keys)
  })

  /** 写入一条情景记忆(移植 _insert_memory:I 决定 H0;同键同文=想起而非新记)。 */
  function insertMemory ({ keywords, summary, emotionScore, intrinsicValue = 0, source = 'dsh', sourceLabel = '', actor = '', occurredAt = 0, temporalStatus = '', memoryKey = '', layer = '', evidence = '', augKeys = null, timestamp = null }) {
    const now = timestamp ?? Date.now() / 1000
    let iVal = Number(intrinsicValue) || 0.0
    if (iVal <= 0) {
      // 降级路径(M1 无 Judge):按 emotion_score 粗估 I,与 Python 版一致
      iVal = Math.max(1.0, Math.min(100.0, (Number(emotionScore) || 0) * 10.0))
    }
    const h0 = initialHalfLife(iVal, DMAE_DEFAULT)
    const key = String(memoryKey || '').trim().slice(0, 64)
    const tstat = String(temporalStatus || '').trim() || 'time_unknown'
    const cleanSummary = String(summary || '').trim()
    if (!cleanSummary) return 0

    // F4:换代继承用 —— 旧行的层与内在价值(在下面槽位查询里取到)。
    let prevLayer = ''
    let prevIv = 0
    let prevId = 0 // 要被取代的旧行:下架动作挪到 INSERT 之后(见下面事务那段)
    if (key) {
      const prev = db.prepare(
        'SELECT memory_id, summary, half_life, last_recalled, layer, intrinsic_value' +
        ' FROM episodic_memory' +
        " WHERE user_id = ? AND memory_key = ? AND is_active = 1 AND (status IS NULL OR status = 'active')" +
        ' ORDER BY memory_id DESC LIMIT 1'
      ).get(MASTER_ID, key)
      if (prev !== undefined) {
        if (String(prev.summary || '').trim() === cleanSummary) {
          // 同一句话再说第二遍:这是一次"想起",按间隔效应延长半衰期
          const oldH = Number(prev.half_life) || h0
          const last = Number(prev.last_recalled) || now
          const newH = reinforceHalfLife(oldH, retrievability((now - last) / 3600.0, oldH), DMAE_DEFAULT)
          db.prepare(
            'UPDATE episodic_memory SET half_life = ?, recall_count = recall_count + 1,' +
            ' last_recalled = ?, learned_at = CASE WHEN learned_at > 0 THEN learned_at ELSE ? END' +
            ' WHERE memory_id = ?'
          ).run(newH, now, now, prev.memory_id)
          return prev.memory_id
        }
        prevLayer = String(prev.layer || '')
        prevIv = Number(prev.intrinsic_value) || 0
        // 槽位取代:旧版本留档,新版本接班 —— 偏好改了是"换代"不是"叠加"。
        //
        // v0.42.0 审计修复(P0:静默丢记忆):这里**只记下要被取代的旧行 id,
        // 不当场下架**。旧写法是先 `is_active=0, superseded_by=-1`(标"即将被
        // 取代"),等 INSERT 完再回填真 id —— 两条独立语句,中间任何异常或
        // SQLITE_BUSY 都留下「已下架、无后继」的行:那条记忆从召回里消失,
        // 而 `python/engine/db.py:_repair_dangling_superseded` 只清 -1 引用、
        // **不复活 is_active**(Python 侧自己写着「复活那 16 条 L0 是另一件事」)。
        // Python 侧本来就是对的(`engine/integrity.py:mark_superseded` 先校验、
        // 单条语句写完),这条 JS 降级路径是漏网的那一半 —— 现在对齐它:
        // 先插入新行拿到真 id,再用**一条**语句下架旧行(见下面事务那段)。
        prevId = Number(prev.memory_id) || 0
      }
    }
    // 列与值逐一对位(21 列,2026-09-30 加 aug_keys):user_id/keywords/summary/
    // emotion_score/timestamp/source/source_label/actor/speaker_id/is_master=1/
    // intrinsic_value/half_life/recall_count=0/last_recalled/occurred_at/learned_at/
    // temporal_status/memory_key/layer/evidence/aug_keys
    //
    // 2026-09-27 F4:换代时**继承旧行的层与内在价值**。现场:`layer='reflection'`
    // 92 条全部 iv=0,整固幸存者丢掉 L0 层 ⇒ L0 只剩 1 条。这里同样处理:
    // 旧行是 L0 而调用方没指定层 ⇒ 继承 L0;iv 取两者最大(换代不许把
    // 一条身份记忆降级成碎片)。`inherit` 是上面槽位查询拿到的旧行。
    const inheritLayer = String(layer || '') === '' && prevLayer !== ''
      ? prevLayer : String(layer || '')
    const useIv = Math.max(Number(iVal) || 0, prevIv)
    // h0 跟着最终的 I 走(继承来的 I 更大时半衰期也要跟上,否则"记得更牢"
    // 只是名义上的)。
    const useH0 = useIv === iVal ? h0 : initialHalfLife(useIv, DMAE_DEFAULT)
    // v0.42.0 审计修复(P0):写入新行 + 收复旧行 + 收尾让位 = **一次原子动作**。
    // 这是本文件第一条事务:此前全 store.js 零 BEGIN/COMMIT,而「换代」天生是
    // 跨两行的写 —— 不原子就会出现上面注释里那种「两头空」的行(记忆静默消失)。
    //
    // 为什么 IMMEDIATE 而不是 DEFERRED:第一条语句就是写,直接拿写锁,省掉
    // 「读锁→升写锁」那个死锁偏爱的中间态。拿不到锁不硬冲:退回无事务路径,
    // 而顺序已经修正过 —— 那时最坏结果是「新旧两行都 active」(可见、可恢复),
    // 不是丢记忆。代价不对称:宁可多一条重复,不可少一条记忆。
    let tx = false
    try { db.exec('BEGIN IMMEDIATE'); tx = true } catch { tx = false }
    try {
      const res = db.prepare(
        'INSERT INTO episodic_memory (user_id, keywords, summary, emotion_score, timestamp,' +
        ' source, source_label, actor, speaker_id, is_master, intrinsic_value, half_life,' +
        ' recall_count, last_recalled, occurred_at, learned_at, temporal_status, memory_key, layer, evidence, aug_keys,' +
        // 2026-10-12:类型两列。**JS 这条路没有类型信息**(它是 Python 不在时的
        // 降级镜像,不经 Judge)⇒ 一律落空串,与老行同形。类型只由 Python 侧写。
        ' memory_type, memory_stability)' +
        ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      ).run(
        MASTER_ID,
        JSON.stringify(Array.isArray(keywords) ? keywords.filter(k => typeof k === 'string' && k) : []),
        cleanSummary, Math.round(Number(emotionScore) || 0), now,
        String(source || 'dsh'), String(sourceLabel || ''), String(actor || ''),
        '', // speaker_id:DSH 单主人,没有别的发言者
        useIv, useH0, now, Number(occurredAt) || 0, now, tstat, key, inheritLayer, String(evidence || ''),
        // 2026-09-30:说法键(检索用)。空 ⇒ NULL,检索侧一个字面都不加(老行为)。
        (Array.isArray(augKeys) && augKeys.filter(k => typeof k === 'string' && k).length > 0)
          ? JSON.stringify(augKeys.filter(k => typeof k === 'string' && k).slice(0, 6))
          : null,
        '', ''
      )
      const newId = Number(res.lastInsertRowid)
      // 旧行下架 + 回填真 id:**一条**语句(旧写法是两条,中间留出窗口)
      if (prevId !== 0) {
        db.prepare('UPDATE episodic_memory SET is_active = 0, superseded_by = ? WHERE memory_id = ?')
          .run(newId, prevId)
      }
      if (key) {
        // 认领**历史遗留**的 -1 悬空行(老版本或别的写者留下的),顺手修掉
        const dangling = db.prepare(
          'SELECT memory_id FROM episodic_memory WHERE user_id = ? AND memory_key = ? AND is_active = 0 AND superseded_by = -1 ORDER BY memory_id DESC LIMIT 1'
        ).get(MASTER_ID, key)
        if (dangling !== undefined) {
          db.prepare('UPDATE episodic_memory SET superseded_by = ? WHERE memory_id = ?').run(newId, dangling.memory_id)
        }
        // 晋升收尾(与 Python 版同款):正式版本落库,同 key 的隔离候选
        // 一并让位 —— 悬案已定谳,待观察行不该再挂着。
        db.prepare(
          "UPDATE episodic_memory SET is_active = 0, superseded_by = ?" +
          " WHERE user_id = ? AND memory_key = ? AND is_active = 1 AND status = 'quarantined'"
        ).run(newId, MASTER_ID, key)
      }
      if (tx) db.exec('COMMIT')
      return newId
    } catch (err) {
      if (tx) { try { db.exec('ROLLBACK') } catch { /* 连接已不在事务里 */ } }
      throw err
    }
  }

  /** 检索 top_k(移植 _retrieve:打分纯函数化,命中即强化回写)。 */
  // (v0.29.0:渠道过滤随群聊拒收一起退役 —— 只服务他一个人,所有记忆
  //  对所有轮次可见,没有「往哪儿渗」的问题。)
  //
  // RT4(2026-09-27):这里显式传 `{ dedupe: true }` —— 本函数是**注入**用途
  // (engine.js 基线路径 / turn-snapshot),近重复只该占一个席位。反向的
  // **枚举**用途(memory_forget 的「>10 拒绝」、memory_search 的查全)在 JS 侧
  // 不存在:两者都走 `frame()` 递帧给 Python 引擎(`engine.js:memoryForget /
  // memorySearch`),由 Python 侧传 `dedupe=False`。所以这里没有第二处要改。
  function retrieve (query, topK, now = Date.now() / 1000, opts = null) {
    const rows = db.prepare(
      'SELECT * FROM episodic_memory WHERE user_id = ? AND is_active = 1' +
      " AND (status IS NULL OR status = 'active')" +
      ` ORDER BY timestamp DESC LIMIT ${CANDIDATE_LIMIT}`
    ).all(MASTER_ID)
    // 2026-09-30:opts 一路透到 rankMemories(基线只认 coreBlock,理由见 engine.js)
    const top = rankMemories(rows.map(rowToMemory), query, topK, now,
      { dedupe: true, ...(opts || {}) })
    // 被想起来就强化:按间隔效应延长半衰期(检索不再是纯只读)
    // F5(2026-09-27):纯靠强制占位进来的 L0 不算"被想起" —— 不写回强化,
    // 与图侧 pinned 对称。旧行为让 #125 每轮被强化,recall_count 涨到 2463、
    // R 被钉在 1(正反馈锁死)。靠分数真进 topK 的 L0 仍照常强化。
    // RT4:去冗余之后同一事实不再有多条同时被强化 —— 那是修好,不是副作用。
    for (const it of top) {
      if (it.forced === true) continue
      const newH = reinforceHalfLife(it.halfLife, it.rNow, DMAE_DEFAULT)
      db.prepare(
        'UPDATE episodic_memory SET half_life = ?, recall_count = recall_count + 1, last_recalled = ? WHERE memory_id = ?'
      ).run(newH, now, it.memoryId)
    }
    return top
  }

  /** 读取她的认知状态(单行 global;从未有过互动时给安全默认)。 */
  function getState () {
    const r = db.prepare('SELECT * FROM agent_state WHERE session_id = ?').get(GLOBAL_SESSION)
    if (r === undefined) {
      const d = stateDefaultsOf()
      const emo = (typeof d.userEmotion === 'string' && d.userEmotion.trim() !== '') ? d.userEmotion.trim() : 'neutral'
      return {
        moodIntensity: numberField(d, 'moodIntensity') ?? 3,
        prevMoodIntensity: numberField(d, 'prevMoodIntensity') ?? 3,
        userEmotion: emo,
        moodReason: '',
        currentTopic: '',
        emotionVector: objectField(d, 'emotionVector'),
        previousEmotionVector: null,
        updatedAt: 0
      }
    }
    return {
      moodIntensity: r.mood_intensity || 3,
      prevMoodIntensity: r.prev_mood_intensity || 3,
      userEmotion: r.user_emotion || 'neutral',
      moodReason: r.mood_reason || '',
      currentTopic: r.current_topic || '',
      emotionVector: safeJsonObject(r.emotion_vector),
      previousEmotionVector: safeJsonObject(r.previous_emotion_vector),
      updatedAt: Number(r.updated_at) || 0
    }
  }

  /**
   * 状态初值(`state-defaults.json` 的 moodIntensity / prevMoodIntensity /
   * userEmotion)的**通用兜底三件套**。
   *
   * 为什么收成一个:写侧(`saveState`,`lib/store.js:711` 一带)与读侧
   * (`emotionStates`,`lib/store.js:1253` 一带)都要在"这一格没有值"时回同一组默认,
   * 而代码里的出厂值只能有一份 —— 否则面板改 `state-defaults.json` 只改半边。
   * 空 / 坏 / 文件不在 ⇒ 逐位回到迁移前的字面值 3 / 3 / neutral
   * (P3 迁移设计 §1.3 row 15;`getState` 的初值块同源,由 A 步接好)。
   */
  function stateDefaultTriple () {
    const d = stateDefaultsOf()
    return {
      mood: numberField(d, 'moodIntensity') ?? 3,
      prev: numberField(d, 'prevMoodIntensity') ?? 3,
      emotion: (typeof d.userEmotion === 'string' && d.userEmotion.trim() !== '') ? d.userEmotion.trim() : 'neutral'
    }
  }

  function saveState (state) {
    const cur = getState()
    // P3-d:三个兜底值改读 state-defaults.json(空 ⇒ 与迁移前逐位一致)。
    const def = stateDefaultTriple()
    db.prepare(
      'INSERT INTO agent_state (session_id, mood_intensity, prev_mood_intensity, user_emotion,' +
      ' mood_reason, current_topic, emotion_vector, previous_emotion_vector, updated_at)' +
      ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)' +
      ' ON CONFLICT(session_id) DO UPDATE SET mood_intensity = excluded.mood_intensity,' +
      ' prev_mood_intensity = excluded.prev_mood_intensity, user_emotion = excluded.user_emotion,' +
      ' mood_reason = excluded.mood_reason, current_topic = excluded.current_topic,' +
      ' emotion_vector = excluded.emotion_vector,' +
      ' previous_emotion_vector = excluded.previous_emotion_vector, updated_at = excluded.updated_at'
    ).run(
      GLOBAL_SESSION,
      Math.round(Number(state.moodIntensity) || def.mood),
      Math.round(Number(state.prevMoodIntensity ?? cur.moodIntensity) || def.prev),
      String(state.userEmotion || def.emotion),
      String(state.moodReason || ''),
      String(state.currentTopic || ''),
      JSON.stringify(state.emotionVector ?? {}),
      JSON.stringify(state.previousEmotionVector ?? cur.emotionVector ?? {}),
      Date.now() / 1000
    )
  }

  /**
   * 只改情绪向量两列(v0.14.5 S8 衰减专用)。
   *
   * 为什么不用 saveState:那是**整行** UPSERT,缺省值会把 mood_intensity
   * 打回 3、current_topic 清空 —— 衰减不是一轮对话,绝不该顺手抹掉
   * 话题与心情(A 的衰减循环也是直接 UPDATE 向量列与 updated_at)。
   *
   * 刻意**只 UPDATE 不插入**:库刚建、还没聊过时没有 agent_state 行,
   * 也就没有可衰减的向量 —— 凭空造一行反而会让面板显示一份假状态。
   * 返回是否真的落库(0 行 = 这轮什么都没发生),调用方据此决定要不要
   * 记日志 —— 免得日志里出现「衰减了」但库没动。
   */
  function saveEmotionVector (vector, previous = undefined) {
    const cur = getState()
    const r = db.prepare(
      'UPDATE agent_state SET emotion_vector = ?, previous_emotion_vector = ?, updated_at = ?' +
      ' WHERE session_id = ?'
    ).run(
      JSON.stringify(vector ?? {}),
      JSON.stringify(previous === undefined ? (cur.emotionVector ?? {}) : previous),
      Date.now() / 1000,
      GLOBAL_SESSION
    )
    return Number(r?.changes ?? 0) > 0
  }

  /**
   * v0.18.3 M3:画像常驻锚点(A `echo_memory_engine.py:544-640`)。
   *
   * 返回 `{ name, emotionState, coreTraits, derivedFromL0 }`,其中
   * `coreTraits` 是 **`'语言:中文'` 这样的字符串数组**(A 的 parts 单位
   * 就是 `f"{k}:{v}"`),没有则 `null`(面板契约是 array|null)。
   *
   * 读侧白名单(A v8.1 的原话:即使库里还残留旧版写入的几十个键,
   * 也不会漏进 prompt —— 修复立刻生效,不依赖数据清理)。
   */
  function getProfile () {
    const r = db.prepare('SELECT * FROM user_profile WHERE user_id = ?').get(MASTER_ID)
    const base = r === undefined
      ? { name: '', emotionState: 'neutral' }
      : { name: cleanName(r.name), emotionState: r.emotion_state || 'neutral' }
    const traits = parseTraits(r === undefined ? null : r.core_traits)
    const parts = []
    for (const key of PROFILE_ALWAYS_ON_KEYS) {
      const v = String(traits[key] ?? '').trim()
      if (v !== '') parts.push(key + ':' + v)
    }
    base.coreTraits = parts.length > 0 ? parts : null
    // v0.16.0 M4:画像**不复制** L0 —— 只做只读投影。身份事实的真值
    // 在 episodic_memory 的 L0 行里(键 = judge.L0_FIELDS 的字段名),
    // 复制一份到 user_profile 就是第二真相源,迟早两边各说一套。
    // 面板把这段显示成「来自核心记忆」清单。
    base.derivedFromL0 = db.prepare(
      "SELECT memory_id, memory_key, summary FROM episodic_memory" +
      " WHERE user_id = ? AND is_active = 1 AND status = 'active' AND layer = 'L0'" +
      " AND memory_key IN ('preferredName','occupation','longTermInterests','language','permanentNote')" +
      ' ORDER BY memory_id DESC LIMIT 8'
    ).all(MASTER_ID).map((m) => ({
      memoryId: Number(m.memory_id), field: m.memory_key || '', summary: m.summary || ''
    }))
    return base
  }

  /**
   * 好感度初值(P3-d):`state-defaults.json.affinity`,空 / 坏 ⇒ `null`。
   *
   * `null` ⇒ 写行时**不带 affinity 这一列** —— 让 DDL 的 `DEFAULT 50` 原样兜底
   * (结构默认留 schema,见 P3 迁移设计 §1.3 row 16;那份 DDL 还得与
   * `python/engine/db.py` 同构,不许删)。所以数据为空 ⇒ 与迁移前逐位一致的 50,
   * 数据给了值 ⇒ 以数据为准 —— 代码里不再出现第二个 50。
   */
  function affinityDefault () {
    return numberField(stateDefaultsOf(), 'affinity')
  }

  /**
   * 建 / 改 `user_profile` 行的唯一 SQL 出口。
   *
   * 为什么收成一个:`setName` 与 `saveProfileTraits` 原来各自手写一条 UPSERT,
   * 好感度初值(P3-d)一接就变成"两处都要记得改" —— 收在这里,`affinity`
   * 只有这一份判据;两条写路的行为(建行 / 换行 / 更新 last_updated)也只剩一份。
   *
   * @param {string[]} cols 业务列(不含 user_id / affinity / last_updated)
   * @param {unknown[]} values 与 cols 一一对应的值
   * @param {string[]} updates ON CONFLICT 时要 SET 的赋值片段
   */
  function writeProfileRow (cols, values, updates) {
    const aff = affinityDefault()
    const allCols = ['user_id', ...cols]
    const allVals = [MASTER_ID, ...values]
    const allSets = [...updates]
    if (aff !== null) {
      allCols.push('affinity')
      allVals.push(aff)
      allSets.push('affinity = excluded.affinity')
    }
    allCols.push('last_updated')
    allVals.push(Date.now() / 1000)
    allSets.push('last_updated = excluded.last_updated')
    db.prepare(
      `INSERT INTO user_profile (${allCols.join(', ')}) VALUES (${allCols.map(() => '?').join(', ')})` +
      ` ON CONFLICT(user_id) DO UPDATE SET ${allSets.join(', ')}`
    ).run(...allVals)
  }

  /**
   * v0.18.3 M3:写画像常驻锚点(A `_apply_profile_update` 的纪律逐条)。
   *
   * A 侧 v8.1 两处收紧,这里同样:
   *   ① **白名单**:只有 `语言/代词` 能进 core_traits(称呼走 name 列)。
   *      以前这是 LLM 自由造键的开放口袋 —— A 实测长出 32 个键,单个事实
   *      占 8 个键,还混进过「记忆库问题: WAL未合并」这类无关内容。
   *      非白名单键**不静默丢弃**,记日志(A 也是)。
   *   ② **硬上限**:键 ≤24 字、值 ≤32 字、总数 ≤`PROFILE_MAX_ITEMS`,
   *      超出丢最早写入的键(A 的 `while ... pop(next(iter(...)))`)。
   * `null` 值 = 该特征失效,删除该键(A 的注释原话)。
   *
   * 一处有意的小偏离:A 会把空串照写(渲染出「语言:」这种废行),这里
   * 空串按删除处理 —— 落库的东西更干净,读侧白名单照样只认白名单键。
   */
  function saveProfileTraits (patch) {
    const out = { saved: [], removed: [], dropped: [] }
    if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) return out
    const traits = parseTraits(currentTraitsRaw())
    for (const [rawKey, rawVal] of Object.entries(patch)) {
      const key = String(rawKey).trim().slice(0, 24)
      if (key === '') continue
      if (!PROFILE_ALWAYS_ON_KEYS.includes(key)) { out.dropped.push(key); continue }
      if (rawVal === null || rawVal === undefined) {
        if (key in traits) { delete traits[key]; out.removed.push(key) }
        continue
      }
      const val = String(rawVal).trim().slice(0, 32)
      if (val === '') {
        if (key in traits) { delete traits[key]; out.removed.push(key) }
        continue
      }
      traits[key] = val
      out.saved.push(key)
    }
    while (Object.keys(traits).length > PROFILE_MAX_ITEMS) {
      delete traits[Object.keys(traits)[0]]
    }
    writeProfileRow(['core_traits'], [JSON.stringify(traits)], ['core_traits = excluded.core_traits'])
    return out
  }

  /** 库里现存的 core_traits 原文(给 saveProfileTraits 做读改写用)。 */
  function currentTraitsRaw () {
    const r = db.prepare('SELECT core_traits FROM user_profile WHERE user_id = ?').get(MASTER_ID)
    return r === undefined ? null : r.core_traits
  }

  /** 解析 core_traits JSON ⇒ 对象(坏数据/非对象一律当空)。 */
  function parseTraits (raw) {
    let parsed = null
    try {
      parsed = raw === null || raw === undefined ? null : JSON.parse(raw)
    } catch { parsed = null }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out = {}
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === 'string') out[String(k)] = v
    }
    return out
  }

  function setName (name) {
    const clean = cleanName(name)
    if (!clean) return
    writeProfileRow(['name'], [clean], ['name = excluded.name'])
  }

  /**
   * 写一行审计 + 顺手裁剪(v0.14.5 S10)。
   *
   * 补齐的六列(DDL 里一直有,写入端从不填 —— 面板上那几列永远空白):
   * `injected_profile`(本轮注入信封的快照)、`emotion_pack`(体感剧本
   * 文本)、`agent_state`(状态 JSON)、`latency`(这一轮多长)、
   * `emotion_delta`(差分短句,见 emotion.js)、`say_again`/`extra_reply`
   * (v0.21.0 E5 补上了抢话筒机制:这两列现在有真写入端 —— Judge 给值、
   * 投递/失败各写自己的行)。**老行仍是 NULL,不编 0**:那一版确实没这机制。
   */
  /**
   * 把「这一轮是谁」写进 `stage_detail.turnTrace` —— **一处注入，全场生效**。
   *
   * ★ 2026-10-18（面板数据缺失排查的结论）：
   *
   * 现场：`audit_logs` 一天 508 行，而**面板一行一行铺** ⇒ 每个行只显示自己有的字段
   * ⇒ 看 `echo_qq_say` 那行，`injected_memories` 是空的，就以为"记忆没注入"。
   * 实际数据都在，只是**散在 6~8 行里**（`inject` / `retrieve` / `relay_in` /
   * `echo_qq_say` / `relay_out` / `extract` / `same_turn_emotion`）。
   *
   * 归组的前提是有一个"轮"的键。`trace_id` **不能**当这个键 ——
   * 它是主键、走 `INSERT OR REPLACE`，两行共用就会**互相覆盖**
   * （`lib/index.js` 的 `auditArm` 注释早写明了，所以并行支才加 `#arm` 后缀）。
   *
   * ⇒ 用 `stage_detail.turnTrace`（一个普通 JSON 字段，不占主键）。
   *   实测填充率只有 **8%** —— 只有 `same_turn_emotion` 那类并行支写了它。
   *
   * 为什么在这里注入而不是改 30 个调用点：
   *   `turnTrace` 是 `lib/index.js:2310` 的**局部变量**，只有它内部能直接访问；
   *   而 `writeAudit` 的调用点分布在 9 个文件（`diary` / `engine` / `heartbeat` /
   *   `reflect` / `say-again` / `tool-audit` / `turn-stopping` / `index` / `store`）。
   *   逐个传参要改 5 个模块的函数签名，链太长。
   *   ⇒ 由 `index.js` 注册一个 resolver，这里按 `sessionId` 现问。
   *
   * ⚠️ 三条边界：
   *   ① **没有 sessionId 的行不碰**（日记/记忆编辑/会话收割…是系统事件，没有"轮"）；
   *   ② **已经写了 turnTrace 的行不覆盖**（并行支自己写的那份是权威）；
   *   ③ resolver 抛错/返回空 ⇒ 原样写，绝不因为补字段把审计写坏。
   */
  let turnTraceResolver = null

  /** 注册「按 sid 取当前轮 trace」的解析器（由 `lib/index.js` 调）。 */
  function setTurnTraceResolver (fn) {
    turnTraceResolver = typeof fn === 'function' ? fn : null
  }

  /**
   * 给 `stageDetail` 补 `turnTrace`（不改原对象；返回新的字符串）。
   * 补不上就原样返回。
   */
  function withTurnTrace (stageDetail, sessionId) {
    if (turnTraceResolver === null) return stageDetail
    const sid = String(sessionId ?? '')
    if (sid === '') return stageDetail
    let tt = ''
    try {
      tt = String(turnTraceResolver(sid) || '')
    } catch {
      return stageDetail   // 边界③：解析器坏了不连累审计
    }
    if (tt === '') return stageDetail

    const raw = String(stageDetail ?? '')
    let obj = null
    if (raw.trim() === '') {
      obj = {}
    } else {
      try {
        const parsed = JSON.parse(raw)
        if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) obj = parsed
      } catch {
        // 不是 JSON 对象 ⇒ 不去猜它的形状，原样留着（宁可少一个字段，不毁一条审计）
      }
    }
    if (obj === null) return raw
    // 边界②：已经有 turnTrace 的，以它为准
    if (typeof obj.turnTrace === 'string' && obj.turnTrace.trim() !== '') return raw
    obj.turnTrace = tt
    try {
      return JSON.stringify(obj)
    } catch {
      return raw
    }
  }

  function writeAudit (row) {
    const state = getState()
    // ★ 2026-10-18：把「这一轮」写进 stage_detail（见上面 withTurnTrace 的长注释）
    const stageDetailOut = row.turnTraceCaptured === true
      ? row.stageDetail
      : withTurnTrace(row.stageDetail, row.sessionId)
    db.prepare(
      'INSERT OR REPLACE INTO audit_logs (trace_id, session_id, user_key, sender_id, is_master,' +
      ' user_input, injected_profile, injected_memories, emotion_pack, emotion_pack_structured,' +
      ' agent_state, llm_reply,' +
      ' latency, mood_intensity, prev_mood_intensity, emotion_vector, emotion_delta, tool_call,' +
      ' say_again, extra_reply, timestamp, stage, step, stage_detail)' +
      ' VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(
      String(row.traceId), String(row.sessionId || GLOBAL_SESSION), MASTER_ID, MASTER_ID,
      clip(row.userInput, 2000), clip(row.injectedProfile ?? '', 4000),
      clip(row.injectedMemories, 4000), clip(row.emotionPack ?? '', 4000),
      clip(row.emotionPackStructured ?? '', 4000),
      clip(row.agentState ?? JSON.stringify({
        moodIntensity: state.moodIntensity,
        prevMoodIntensity: state.prevMoodIntensity,
        userEmotion: state.userEmotion,
        moodReason: state.moodReason,
        currentTopic: state.currentTopic,
        emotionVector: state.emotionVector ?? {}
      }), 2000),
      clip(row.llmReply, 2000),
      Number.isFinite(Number(row.latency)) ? Number(row.latency) : null,
      Math.round(Number(row.moodIntensity) || 0),
      Math.round(Number(row.prevMoodIntensity) || 0),
      JSON.stringify(row.emotionVector ?? {}), String(row.emotionDelta ?? ''),
      String(row.toolCall || ''),
      // 缺席 ⇒ NULL(SQLite 对 undefined 直接报错,所以显式判)
      row.sayAgain === undefined || row.sayAgain === null
        ? null : (Number(row.sayAgain) === 1 ? 1 : 0),
      row.extraReply === undefined || row.extraReply === null
        ? null : String(row.extraReply).slice(0, 200),
      Date.now() / 1000,
      clip(row.stage ?? '', 32), Math.round(Number(row.step) || 0), clip(stageDetailOut ?? '', 4000)
    )
    trimAudit()
  }

  /**
   * 审计裁剪(A `echo_audit.py:119-131` 的 `_trim_audit` 语义):只留最近
   * `keep` 条。不裁的话这张表会随每轮一行无限长,一天几百行,面板的
   * 「最近审计」查询与导出都会越来越慢。
   * 下界 20:裁剪配置写坏了也不至于把审计清成空表(审计是关怀日上限
   * 与面板的真相源)。
   *
   * ★ 2026-09-26 全仓审查修:`careCountSince` 数的是**当天**的 care 行,
   * 而这里曾经无差别裁到最近 keep 条 —— 活库实测 audit_logs 恰 100 行
   * (=keep)、**全部是当天**(02:41~19:11)⇒ 当天早些时候的关怀行被自己裁掉,
   * `heartbeat` 的 `CARE_DAILY_CAP=3` 越到晚上越数不准(静默失效)。
   * 现在多一个例外:**当天的 care 行永不裁**(每天最多 3 条,增长可忽略),
   * 其余仍按 keep 裁 —— 面板与导出的体量不变,真相源不再自毁。
   *
   * ★ 2026-10-06(记忆调用机制报告 §5.4 的现场):`injected_memories` 在活库
   * 160 行里**非空 0 行**,而 9-25 的备份里是有内容的。追下来两个原因,
   * 一个是真凶、一个是帮凶:
   *   ① 真凶不在裁剪 —— 注入块以前只在**轮末反思成功**那一行(`tool_call='extract'`)
   *      里落库 ⇒ 反思跳过/失败的轮次,"她读到了什么"根本没人记。修在写入端
   *      (组装完就写一行 `tool_call='inject'`,见 `lib/index.js` 的 `onInject`);
   *   ② 帮凶是这里:全量工具审计(v0.32.0 B1)之后,每个工具调用一行,一次
   *      编码会话一小时就能写几十行 —— 单预算裁剪下,**证据行会被工具行的洪水
   *      挤出保留窗**(实测:10-05 20 点那一小时 97 行里 93 行是工具行)。
   * 所以现在**分两个预算**:证据行(非工具行)留最近 keep 条,工具行也留最近
   * keep 条 ⇒ 表体量 ≤ 2·keep(默认 200 行,仍有界),两边各自的近期历史都不丢。
   * 判据用的是**产地导出的标记**(`TOOL_ROW_MARKER`),不在 SQL 里抄字面量。
   */
  function trimAudit (keep = auditKeep) {
    const n = clampAuditKeep(keep)
    try {
      const d = new Date()
      d.setHours(0, 0, 0, 0)
      const marker = TOOL_ROW_MARKER + '%'
      db.prepare(
        'DELETE FROM audit_logs WHERE trace_id NOT IN (' +
        " SELECT trace_id FROM audit_logs WHERE COALESCE(user_input, '') NOT LIKE ?" +
        ' ORDER BY timestamp DESC, rowid DESC LIMIT ?)' +
        ' AND trace_id NOT IN (' +
        " SELECT trace_id FROM audit_logs WHERE COALESCE(user_input, '') LIKE ?" +
        ' ORDER BY timestamp DESC, rowid DESC LIMIT ?)' +
        " AND NOT (tool_call = 'care' AND timestamp >= ?)"
      ).run(marker, n, marker, n, d.getTime() / 1000)
    } catch { /* 裁剪失败不影响本轮审计已经落库 */ }
  }

  /** 热更新保留条数(面板/配置改动后调用;默认 100)。 */
  function setAuditKeep (keep) {
    auditKeep = clampAuditKeep(keep)
    return auditKeep
  }

  /** 仪表盘统计。 */
  function memoryStats () {
    const active = db.prepare("SELECT COUNT(*) AS n FROM episodic_memory WHERE is_active = 1 AND (status IS NULL OR status = 'active')").get()
    const quarantined = db.prepare("SELECT COUNT(*) AS n FROM episodic_memory WHERE is_active = 1 AND status = 'quarantined'").get()
    const total = db.prepare('SELECT COUNT(*) AS n FROM episodic_memory').get()
    const l0 = db.prepare("SELECT COUNT(*) AS n FROM episodic_memory WHERE is_active = 1 AND layer = 'L0' AND (status IS NULL OR status = 'active')").get()
    const last = db.prepare('SELECT MAX(timestamp) AS t FROM episodic_memory').get()
    const nodes = db.prepare('SELECT COUNT(*) AS n FROM graph_nodes').get()
    const edges = db.prepare('SELECT COUNT(*) AS n FROM graph_edges').get()
    // v0.15.1 G22:统计总览缺的三项(A 的 dashboard「stats」面板有,
    // DSH 没有):审计行数(证据链长度)、被取代的记忆数(换代史)、
    // 画像字段数(她对你了解多少维)。
    const audit = db.prepare('SELECT COUNT(*) AS n FROM audit_logs').get()
    const superseded = db.prepare('SELECT COUNT(*) AS n FROM episodic_memory WHERE superseded_by > 0').get()
    // ★ 2026-09-26 审查:`user_profile` 是「一人一行、字段都塞在 core_traits
    // 这个 JSON 列里」的形状 ⇒ `COUNT(*)` 恒为 0/1(活库就是 1),面板上
    // 那句「画像字段 1 项」毫无意义。要数的是 **core_traits 的键数**。
    const profile = db.prepare('SELECT core_traits FROM user_profile LIMIT 1').get()
    let profileFieldCount = 0
    try {
      const traits = profile === undefined ? null : JSON.parse(String(profile.core_traits || '{}'))
      if (traits !== null && typeof traits === 'object' && !Array.isArray(traits)) {
        profileFieldCount = Object.keys(traits).length
      }
    } catch { profileFieldCount = 0 }
    const state = getState()
    return {
      episodicActive: Number(active.n) || 0,
      episodicTotal: Number(total.n) || 0,
      quarantined: Number(quarantined.n) || 0,
      l0: Number(l0.n) || 0,
      graphNodes: Number(nodes.n) || 0,
      graphEdges: Number(edges.n) || 0,
      lastMemoryAt: Number(last.t) || 0,
      auditRows: Number(audit.n) || 0,
      superseded: Number(superseded.n) || 0,
      profileFields: profileFieldCount,
      moodIntensity: state.moodIntensity,
      updatedAt: state.updatedAt
    }
  }

  // ---- v0.3.0 「仪表盘」:AstrBot echo_audit_dashboard 六面板的查询层 ----
  // 语义与 AstrBot 逐项对齐(audit/threads/longing/graph/emotion/stats);
  // 区别只有一处:AstrBot 的 DMAE 三态读 graph_edges 物化的 activation,
  // 我们用 episodic 的半衰期数据现场算 R(dmae.js 同一套数学)——
  // 没有"面板一套数学、引擎一套数学"的漂移,也不用等 M2-e 物化。

  /** 审计流:最近的"她记了什么/她当时什么状态"。 */
      // 2026-10-09(他实测:面板一开就卡、DSH 发不出消息;关掉面板立刻能发):
      // 面板每 10 秒拉 200 行 = 816 KB,把这几个**折叠窗口用不到**的胖子字段在 light 下裁到 600 字 ⇒ 约 200 KB。
      // 只改投影、不删数据、不动列、不改 DDL;默认 false ⇒ 导出 / 状态面等消费方一字不变。
  function listAudit (since = 0, limit = 50, light = false, sessionId = '') {
    // 旧三参数调用仍查全部会话；过滤先于 LIMIT，不能在全局截窗后再筛。
    const hasSession = typeof sessionId === 'string' && sessionId !== ''
    const requestedLimit = Number(limit)
    // 缺省/0/非有限值用 50；有限小数截整，再钳到 [1, 500]。
    const rowLimit = Number.isFinite(requestedLimit) && requestedLimit !== 0
      ? Math.max(1, Math.min(500, Math.trunc(requestedLimit))) : 50
    const args = [Number(since) || 0]
    if (hasSession) args.push(sessionId)
    args.push(rowLimit)
    const rows = db.prepare(
      'SELECT trace_id, session_id, user_input, injected_profile, injected_memories,' +
      ' emotion_pack, emotion_pack_structured, agent_state, llm_reply, latency,' +
      ' mood_intensity, prev_mood_intensity, emotion_vector, emotion_delta, tool_call,' +
      ' say_again, extra_reply, timestamp' +
        ', stage, step, stage_detail' +
      ' FROM audit_logs WHERE timestamp > ?' +
      (hasSession ? ' AND session_id = ?' : '') +
      ' ORDER BY timestamp DESC LIMIT ?'
    ).all(...args)
    return rows.map((r) => ({
      traceId: r.trace_id,
      sessionId: r.session_id || GLOBAL_SESSION,
      userInput: r.user_input || '',
      injectedProfile: light ? String(r.injected_profile || '').slice(0, 600) : (r.injected_profile || ''),
      // 2026-09-27 修:这一列存的是**注入块的渲染全文**(纯文本,实测
      // 1330~2230 字符),不是 JSON。此前拿 safeJsonObject 去解析 ⇒ 永远
      // null ⇒ `?? []` ⇒ 面板与复现包里的「本轮注入了什么」**全是空的**,
      // 而数据一直在库里(turn-snapshot.js:169 写的 capture.lastInjected)。
      // 写入侧从来就是字符串:index.js:1272 `injectedMemories: snap.lastInjected`。
      injectedMemories: r.injected_memories || '',
      emotionPack: light ? String(r.emotion_pack || '').slice(0, 600) : (r.emotion_pack || ''),
      emotionPackStructured: light ? String(r.emotion_pack_structured || '').slice(0, 600) : (r.emotion_pack_structured || ''),
      agentState: light ? safeJsonObject(String(r.agent_state || '').slice(0, 600)) : safeJsonObject(r.agent_state),  // ★ 保留 safeJsonObject:light 时截断可能解析失败 ⇒ null(折叠窗口不需要它)
      llmReply: r.llm_reply || '',
      latency: r.latency === null ? null : Number(r.latency),
      moodIntensity: r.mood_intensity || 0,
      prevMoodIntensity: r.prev_mood_intensity || 0,
      emotionVector: safeJsonObject(r.emotion_vector),
      // 差分是**短句**不是 JSON(A `format_emotion_delta` 的产物:
      // 「整体[疲惫-2]; 对主人[爱意+0.5]」),原样交出去给面板显示。
      emotionDelta: r.emotion_delta || '',
      toolCall: r.tool_call || '',
      // 2026-10-09:并发观测三列(纯增,不改现有列)
      stage: r.stage || '',
      step: Number(r.step) || 0,
      stageDetail: r.stage_detail || '',
      // v0.21.0 E5:情绪余波两列。**NULL 原样透出**(不是 0/'')——
      // 那一版确实没这机制,面板要能把"没有"和"说了 0"分开
      // (A 的面板也是 `if (a.say_again)` 才显示那一行)。
      sayAgain: r.say_again === null || r.say_again === undefined ? null : Number(r.say_again),
      extraReply: r.extra_reply === null || r.extra_reply === undefined ? null : String(r.extra_reply),
      timestamp: Number(r.timestamp) || 0
    }))
  }

  /**
   * 悬置话题看板(2026-10-06 D3:老四桶 **+ 冷却 / 已了结 / 归档** 三档)。
   *
   * 老四桶(`waiting`/`due`/`done`/`untimed`)是**活跃档内部的渲染子状态**,
   * 语义与位置都不变(面板在 D5 之前照旧读它们 —— 这一步是**纯增量**,不破坏谁)。
   * 新增三档由生命周期两列切出来:
   *   active(活跃)= `cooling_at=0` 且 `archived_at=0` 且 `status='open'`
   *   cooling      = `cooling_at>0` 且 `archived_at=0`
   *   resolved     = `status='resolved'` 且 `archived_at=0`
   *   archived     = `archived_at>0`(面板默认折叠)
   * 每行都带 `kind` / `coolingAt` / `archivedAt` / `supersededBy`(D5 的徽标与筛选要用)。
   */
  function listThreads (limit = 30) {
    const now = Date.now() / 1000
    const rows = db.prepare(
      'SELECT thread_id, user_id, content, status, follow_up_after, session_id, kind,' +
      ' last_mentioned_at, created_at, updated_at, cooling_at, archived_at, superseded_by' +
      ' FROM pending_threads ORDER BY (archived_at > 0) ASC, updated_at DESC LIMIT ?'
    ).all(Math.max(1, Number(limit) || 30) * 3)
    const buckets = {
      waiting: [], due: [], done: [], untimed: [],
      cooling: [], resolved: [], archived: []
    }
    for (const r of rows) {
      const d = {
        threadId: r.thread_id, content: r.content || '',
        kind: String(r.kind || ''),
        followUpAfter: Number(r.follow_up_after) || 0,
        lastMentionedAt: Number(r.last_mentioned_at) || 0,
        coolingAt: Number(r.cooling_at) || 0,
        archivedAt: Number(r.archived_at) || 0,
        supersededBy: Number(r.superseded_by) || 0,
        updatedAt: Number(r.updated_at) || 0
      }
      const mentioned = d.lastMentionedAt > 0
      const fu = d.followUpAfter
      if (mentioned) d.state = 'done'
      else if (fu > now) d.state = 'waiting'
      else if (fu > 0) d.state = 'due'
      else d.state = 'untimed'
      d.secondsLeft = fu > 0 ? Math.max(0, Math.round(fu - now)) : 0
      if (d.archivedAt > 0) buckets.archived.push(d)
      else if (String(r.status || '') === 'resolved') buckets.resolved.push(d)
      else if (d.coolingAt > 0) buckets.cooling.push(d)
      else buckets[d.state].push(d)
    }
    buckets.waiting.sort((a, b) => a.followUpAfter - b.followUpAfter)
    buckets.done.sort((a, b) => b.lastMentionedAt - a.lastMentionedAt)
    buckets.cooling.sort((a, b) => b.coolingAt - a.coolingAt)
    buckets.resolved.sort((a, b) => b.updatedAt - a.updatedAt)
    buckets.archived.sort((a, b) => b.archivedAt - a.archivedAt)
    return { ...buckets, now }
  }

  /**
   * 想念值面板(答辩主仪表):读 longing_state 并应用复刻公式补差
   * (AstrBot build_api_longing 的兜底数学:H=3h、阈值 7.0、s/(s+h) 幂律)。
   * M2-f 曲线引擎上线后由引擎写真值,此方法自然退化为纯读。
   */
  function longingRows () {
    const now = Date.now() / 1000
    const rows = db.prepare(
      'SELECT user_id, value, anchor_at, updated_at, kicked, last_user_msg_at,' +
      ' last_care_at, care_count, session_id FROM longing_state ORDER BY updated_at DESC LIMIT 20'
    ).all()
    const H = 3.0 * 3600.0
    return rows.map((r) => {
      const anchor = Number(r.anchor_at) || 0
      const updated = Number(r.updated_at) || 0
      const sNow = Math.max(0, now - anchor)
      const sLast = Math.max(0, updated - anchor)
      const inc = (10.0 * sNow) / (sNow + H) - (10.0 * sLast) / (sLast + H)
      return {
        userId: r.user_id,
        value: Math.round(Math.min(10, Math.max(0, (Number(r.value) || 0) + inc)) * 1000) / 1000,
        threshold: 7.0,
        kicked: Number(r.kicked) || 0,
        sinceMessage: Math.max(0, now - (Number(r.last_user_msg_at) || 0)),
        lastCareAt: Number(r.last_care_at) || 0,
        careCount: Number(r.care_count) || 0
      }
    })
  }

  /**
   * 记忆图谱:nodes(类型推断+度数权重)+ edges(关系标签)。
   * @param {{personNames?: string[]|null}} [opts] P1b:人名名单默认从 names.json 读
   *   (`lib/names.js`);显式给一份就用给的(测试/离线调用不必碰数据目录)。
   */
  function graphData ({ personNames = null } = {}) {
    // v0.13.0:节点/边带全引擎字段(activation/intrinsicValue/is_active/
    // supersededBy/layer/occurredAt/temporalStatus)—— 动态图谱的配色
    // (激活度三态)、tooltip 关系清单(半衰期/想起次数/时间态/取代链)
    // 全靠它们;python 引擎 schema 本就是超集,此前只是没 SELECT。
    //
    // v0.13.2 激活度现算:物化列在 DSH 从未被更新 —— 图谱检索帧
    // (graph_query/graph_reinforce)引擎侧完整、壳侧未接线,导入时序
    // 加迁移补列默认 0,活库 26 边 25 节点 activation 全 0,图谱页
    // 全「遗忘」。引擎哲学本来就是「真相只有 H/last_accessed/recall_count,
    // R 永远现算,物化只是快照」(dmae.py docstring)—— 显示层照做:
    // activation = R(Δt,H)×100,H 缺失按内在价值给初值;节点是结构
    // 实体没有半衰期,激活度取最清醒邻边的现算值。物化原值以
    // activationStored 透传(F1 接线后可对照「快照 vs 现算」)。
    const nowSec = Date.now() / 1000
    // v0.16.0 M2:只画现役节点 —— 被归一并让位的旧节点是墓碑
    // (is_active=0),列表与检索都不该再看见它(「西电」不该再出现)。
    const nodes = db.prepare(
      'SELECT node_id, name, node_type, is_protected, activation,' +
      ' intrinsic_value, half_life, recall_count, temporal_status FROM graph_nodes' +
      ' WHERE COALESCE(is_active, 1) = 1'
    ).all().map((r) => ({
      id: r.node_id, name: r.name || r.node_id,
      type: r.node_type || 'concept',
      isProtected: Number(r.is_protected) || 0,
      weight: 1,
      activation: Number(r.activation) || 0,
      activationStored: Number(r.activation) || 0,
      intrinsicValue: Number(r.intrinsic_value) || 0,
      halfLife: Number(r.half_life) || 0,
      recallCount: Number(r.recall_count) || 0,
      temporalStatus: r.temporal_status || 'time_unknown'
    }))
    const edges = db.prepare(
      'SELECT edge_id, source_id, target_id, relation, weight, half_life,' +
      ' recall_count, temporal_status, intrinsic_value, activation,' +
      ' occurred_at, layer, is_active, superseded_by, last_accessed, evidence FROM graph_edges'
    ).all().map((r) => {
      const h = Number(r.half_life) > 0
        ? Number(r.half_life)
        : initialHalfLife(Number(r.intrinsic_value) || 10)
      const dtH = Math.max(0, (nowSec - (Number(r.last_accessed) || 0)) / 3600)
      return {
        id: r.edge_id, source: r.source_id, target: r.target_id,
        relation: r.relation || '相关',
        weight: Number(r.weight) || 1,
        halfLife: Number(r.half_life) || 0,
        recallCount: Number(r.recall_count) || 0,
        temporalStatus: r.temporal_status || 'time_unknown',
        intrinsicValue: Number(r.intrinsic_value) || 0,
        activation: Math.round(retrievability(dtH, h) * 1000) / 10,
        activationStored: Number(r.activation) || 0,
        occurredAt: Number(r.occurred_at) || 0,
        layer: r.layer || '',
        isActive: Number(r.is_active ?? 1) === 1,
        supersededBy: Number(r.superseded_by) || 0,
        // v0.16.0 M1 回指:这条边是「听谁说的」——写入时落的本轮 memory_id。
        // 解析失败一律当空(面板容错,老行本来就没有)。
        evidenceIds: String(r.evidence || '')
          .split(/[、,，\s]+/)
          .map((s) => Number(s))
          .filter((x) => Number.isFinite(x) && x > 0)
      }
    })
    // 节点激活度 = max(物化值, 最清醒邻边现算值)
    const nodeAct = new Map()
    for (const e of edges) {
      if (!nodeAct.has(e.source) || e.activation > nodeAct.get(e.source)) nodeAct.set(e.source, e.activation)
      if (!nodeAct.has(e.target) || e.activation > nodeAct.get(e.target)) nodeAct.set(e.target, e.activation)
    }
    for (const n of nodes) {
      const derived = nodeAct.get(n.id)
      if (derived !== undefined && derived > n.activation) n.activation = derived
    }
    // AstrBot 的节点类型推断逐字移植(人物名单/习惯/偏好/事件)
    const edgeCount = {}
    const relations = {}
    for (const e of edges) {
      edgeCount[e.source] = (edgeCount[e.source] || 0) + 1
      edgeCount[e.target] = (edgeCount[e.target] || 0) + 1
      ;(relations[e.source] ??= new Set()).add(e.relation)
      ;(relations[e.target] ??= new Set()).add(e.relation)
    }
    // P1b(模块5):人名名单从 `<数据目录>/names.json` 读(原来 14 条硬编码在这里)。
    // 空 ⇒ **中性集合**:没有概念节点被改判成 person(设计文档 row 7)。
    const PERSON_NAMES = Array.isArray(personNames) ? personNames : loadNames().personNames
    for (const n of nodes) {
      n.weight = edgeCount[n.id] || 1
      if (n.type !== 'concept') continue
      const rels = relations[n.id] ?? new Set()
      if (PERSON_NAMES.includes(n.name)) n.type = 'person'
      else if (rels.has('习惯')) n.type = 'habit'
      else if (rels.has('喜欢') || rels.has('讨厌') || rels.has('偏好')) n.type = 'preference'
      else if (rels.has('导致') || rels.has('引起') || rels.has('触发')) n.type = 'event'
    }
    // v0.16.0 M2:端点已被归一隐藏(墓碑)的边不再返回 —— 否则页面会
    // 拿到指向不存在节点的悬空边,力导向图会画到不存在的位置。
    const liveIds = new Set(nodes.map((n) => n.id))
    // ---- 幽灵层(2026-10-02;他:「影子边为什么不在图谱里显示 + 加权重过滤工具」)----
    // 图谱上那两个**只给人看**的层,和事实图物理分开(细节与纪律都在
    // `lib/graph-ghost.js`:证据层的表名**只许出现在那一个文件**,检索侧
    // 名单一字不动 —— 见 python/engine/cooc.py 的 READ_SIDE_FILES 注释)。
    const layers = ghostLayers(db)
    return { nodes, edges: edges.filter((e) => liveIds.has(e.source) && liveIds.has(e.target)), layers }
  }

  /**
   * v0.16.0 M1:按 id 取记忆原文(回指用)。
   *
   * 图谱页点到一条边的「依据」时,要能展开那条记忆的原话 —— 这是
   * 「图谱与记忆对不上」最直接的解药。默认不过滤 is_active/status:
   * 被取代的旧行也是历史(「她以前以为…」),面板照实显示,只标出来。
   */
  function memoriesByIds (ids) {
    const list = (Array.isArray(ids) ? ids : [])
      .map((x) => Number(x))
      .filter((x) => Number.isFinite(x) && x > 0)
      .slice(0, 50)
    if (list.length === 0) return []
    const ph = list.map(() => '?').join(',')
    const rows = db.prepare(
      'SELECT * FROM episodic_memory WHERE memory_id IN (' + ph + ')'
    ).all(...list)
    const byId = new Map(rows.map((r) => [Number(r.memory_id), rowToMemory(r)]))
    // 按传入顺序返回,缺的丢掉(比如边指向一条已被物理清理的行)
    return list.map((id) => byId.get(id)).filter((x) => x !== undefined)
  }

  /**
   * v0.16.0 M2:度数最高的实体名(给反思提示词当「已有实体」表)。
   *
   * 为什么值这个 token:模型造近义词是图谱碎成一地的主因(实测
   * 「西电」与「西安电子科技大学」并存)。在提示词里递一张现成名单,
   * 比事后合并便宜得多,而且**保真**(合并不可能无损)。
   */
  function topEntityNames (limit = 20, owner = MASTER_ID) {
    const lim = Math.max(1, Math.min(60, Number(limit) || 20))
    const rows = db.prepare(
      'SELECT n.name AS name, COUNT(e.edge_id) AS degree FROM graph_nodes n' +
      ' LEFT JOIN graph_edges e ON (e.source_id = n.node_id OR e.target_id = n.node_id)' +
      ' WHERE (n.owner_key = ? OR n.owner_key IS NULL OR n.owner_key = ?)' +
      // 墓碑(被归一并让位的旧名)不进提示词 —— 否则模型又被教着写「西电」
      ' AND COALESCE(n.is_active, 1) = 1' +
      ' GROUP BY n.node_id ORDER BY degree DESC, n.recall_count DESC LIMIT ?'
    ).all(owner, '', lim)
    return rows.map((r) => String(r.name || '')).filter((s) => s !== '')
  }

  /** 情绪历史:最近 N 条认知状态。 */
  function emotionStates (limit = 5) {
    // P3-d:列里没有值(NULL / 0,老库或显式写空的行)时的兜底同样走
    // state-defaults.json —— 与 getState / saveState 是同一组初值。
    const def = stateDefaultTriple()
    return db.prepare(
      'SELECT session_id, mood_intensity, prev_mood_intensity, user_emotion, mood_reason,' +
      ' current_topic, emotion_vector, updated_at FROM agent_state ORDER BY updated_at DESC LIMIT ?'
    ).all(Math.max(1, Math.min(20, Number(limit) || 5))).map((r) => ({
      sessionId: r.session_id || '',
      moodIntensity: r.mood_intensity || def.mood,
      prevMoodIntensity: r.prev_mood_intensity || def.prev,
      userEmotion: r.user_emotion || def.emotion,
      moodReason: r.mood_reason || '',
      // v0.15.1 G22:话题也回传 —— A 的情绪面板有它,DSH 面板此前没有
      // (列在表里从没 SELECT 出来)。
      currentTopic: r.current_topic || '',
      emotionVector: safeJsonObject(r.emotion_vector),
      updatedAt: Number(r.updated_at) || 0
    }))
  }

  /** 记忆体检:DMAE 三态(现场算 R,不物化)+ 时间状态分布 + 悬置话题计数。 */
  function memoryHealth () {
    const now = Date.now() / 1000
    const rows = db.prepare(
      "SELECT half_life, last_recalled, temporal_status FROM episodic_memory" +
      " WHERE is_active = 1 AND (status IS NULL OR status = 'active')"
    ).all()
    let active = 0
    let dormant = 0
    let archived = 0
    let rSum = 0
    const temporal = {}
    for (const r of rows) {
      const h = Number(r.half_life) || 0
      const last = Number(r.last_recalled) || now
      const R = retrievability((now - last) / 3600.0, h)
      // deriveState 返回 Python 原版的大写三态,面板统一小写展示
      const st = deriveState(R).toLowerCase()
      if (st === 'active') active++
      else if (st === 'dormant') dormant++
      else archived++
      rSum += R
      const key = String(r.temporal_status || '').trim() || 'time_unknown'
      temporal[key] = (temporal[key] || 0) + 1
    }
    const temporalEdges = {}
    for (const r of db.prepare(
      "SELECT COALESCE(NULLIF(temporal_status, ''), 'time_unknown') AS s, COUNT(*) AS c" +
      ' FROM graph_edges GROUP BY s'
    ).all()) temporalEdges[r.s] = Number(r.c) || 0
    const threadOpen = db.prepare("SELECT COUNT(*) AS n FROM pending_threads WHERE status = 'open'").get()
    const threadDue = db.prepare(
      "SELECT COUNT(*) AS n FROM pending_threads WHERE status = 'open'" +
      ' AND follow_up_after > 0 AND follow_up_after <= ?'
    ).get(now)
    return {
      dmae: {
        active, dormant, archived,
        avgR: rows.length > 0 ? Math.round((rSum / rows.length) * 1000) / 1000 : 0,
        total: rows.length
      },
      temporal, temporalEdges,
      threads: { open: Number(threadOpen.n) || 0, due: Number(threadDue.n) || 0 }
    }
  }

  // ---- v0.31.0 P2:关怀账(+ 她自己的闹钟) ----------------------------------
  //
  // 为什么要有这张账(2026-09-28):45 小时里她一声不吭,而他(和我)只能靠推 ——
  // 判定理由当时只喊在宿主 stdout 上。铁律:**全通过才静默,任一否定必留痕**。
  // 所以这里不记"安静且没有任何一步否定"的拍(那才是真静默),只记有内容的那一拍。

  /** 一拍落账。`reason` 只许枚举(见 docs/DISCIPLINE.md);返回 rowid,失败 0。
   *
   *  2026-09-30 P2:新增四个可选读数(`candidates` / `topScore` / `rejectedBy` /
   *  `topicId`),默认 0/0/''/'' —— 不传就是"这一拍没有打分读数",与老拍同形。
   *  task 详情**不进** `audit_logs`(那是"她说了什么"的贵账),只落这里。 */
  function careBeatAdd ({ at, kind, reason, value = 0, threshold = 0, shouldAct = false, acted = false, sessionId = '', targetSessionId = '', traceId = '', payload = null, candidates = 0, topScore = 0, rejectedBy = '', topicId = '' }) {
    const r = db.prepare(`INSERT INTO care_beats
        (at, kind, reason, value, threshold, should_act, acted, session_id, target_session_id, trace_id, payload_json,
         candidates, top_score, rejected_by, topic_id)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      Number(at) || Date.now() / 1000,
      String(kind || 'quiet'),
      String(reason || 'idle'),
      Number(value) || 0,
      Number(threshold) || 0,
      shouldAct === true ? 1 : 0,
      acted === true ? 1 : 0,
      String(sessionId || ''),
      String(targetSessionId || ''),
      String(traceId || ''),
      (payload === null || payload === undefined) ? '' : JSON.stringify(payload),
      Math.max(0, Math.round(Number(candidates) || 0)),
      Number(topScore) || 0,
      String(rejectedBy || ''),
      String(topicId || '')
    )
    return Number(r?.lastInsertRowid) || 0
  }

  function mapBeat (r) {
    let payload = null
    const raw = String(r?.payload_json ?? '')
    if (raw !== '') { try { payload = JSON.parse(raw) } catch { payload = null } }
    return {
      id: Number(r?.id) || 0,
      at: Number(r?.at) || 0,
      kind: String(r?.kind || ''),
      reason: String(r?.reason || ''),
      value: Number(r?.value) || 0,
      threshold: Number(r?.threshold) || 0,
      shouldAct: Number(r?.should_act) === 1,
      acted: Number(r?.acted) === 1,
      sessionId: String(r?.session_id || ''),
      targetSessionId: String(r?.target_session_id || ''),
      // 2026-09-30 P2:话题打分器的四个读数(老拍是 0/0/''/'' = 没打分)
      candidates: Number(r?.candidates) || 0,
      topScore: Number(r?.top_score) || 0,
      rejectedBy: String(r?.rejected_by || ''),
      topicId: String(r?.topic_id || ''),
      traceId: String(r?.trace_id || ''),
      payload
    }
  }

  /** 读一段时间的拍(新的在前)。给 `scripts/echoq.mjs` 与面板用。 */
  function careBeatsSince (ts, limit = 200) {
    return db.prepare('SELECT * FROM care_beats WHERE at >= ? ORDER BY at DESC, id DESC LIMIT ?')
      .all(Number(ts) || 0, Math.max(1, Math.min(5000, Number(limit) || 200)))
      .map(mapBeat)
  }

  /** 关怀日上限的真相源(2026-09-29 起):今天(本地午夜起)她**真的开口**几次。
   *
   *  判据 = `care_beats` 里 `reason='sent'` 的拍 —— 她自己的表、只追加、
   *  不被别的会话的流量挤掉、可 GROUP BY 翻历史。
   *  (旧判据是数 `audit_logs` 的 care 行;那张表是全局 100 行滚动窗,
   *   实测会被挤出 ⇒ 上限既算不准、事后也复算不出来。见 `careCountSince` 注释。) */
  function careSentCountSince (ts) {
    return Number(db.prepare(
      "SELECT COUNT(*) AS n FROM care_beats WHERE reason = 'sent' AND at >= ?"
    ).get(Number(ts) || 0).n) || 0
  }
  /** 按 reason 汇总 —— "可 GROUP BY"就是这张表存在的理由。 */
  function careBeatSummary (ts) {
    return db.prepare(`SELECT reason, COUNT(*) AS n, SUM(acted) AS acted,
        MIN(at) AS first_at, MAX(at) AS last_at
      FROM care_beats WHERE at >= ? GROUP BY reason ORDER BY n DESC, reason ASC`)
      .all(Number(ts) || 0)
      .map((r) => ({
        reason: String(r.reason || ''),
        count: Number(r.n) || 0,
        acted: Number(r.acted) || 0,
        firstAt: Number(r.first_at) || 0,
        lastAt: Number(r.last_at) || 0
      }))
  }

  /**
   * v0.34.0 B5:这个会话最近有没有工具在跑(判"他正在干活")。返回最近一次的时间戳(秒),0 = 没有。
   *
   * 为什么用**审计表**而不是再记一份状态:工具调用本来就在审计里(自家工具由
   * auditToolCall 写、宿主工具由 lib/tool-audit.js 写),这题不需要第二本账 ——
   * 多一份状态就多一处会漂移的地方。
   */
  function recentToolCallAt (sessionId, sinceSec) {
    try {
      const r = db.prepare('SELECT MAX(timestamp) AS t FROM audit_logs'
        + " WHERE session_id = ? AND COALESCE(tool_call, '') != '' AND timestamp >= ?")
        .get(String(sessionId), Number(sinceSec))
      return Number(r?.t) || 0
    } catch { return 0 }
  }

  /**
   * 他**最后在会话里说话**是什么时候(epoch 秒;没有 → 0)。
   *
   * 口径(2026-09-29 修):读 `conversation_log` —— 每真轮一行,
   * `session_id` + `created_at`,正是"这条会话最近聊过什么"的账。
   *
   * 老实现读审计表(`tool_call='' AND user_input NOT LIKE '(%'`),而那个判据
   * 在活库里**命中 0 行**:他真正说的话记在 `tool_call='extract'` 那批行上
   * (见 `.scratch/diag/audit-shape.mjs` 的分布表),没有一行 tool_call 为空。
   * 于是这个读数**恒为 0**,两条判据一起静默失效:
   *   · v0.40.0 C5「他中间说过话 ⇒ 过期很久的约定作废」——那条前提从来没成立过
   *     (晚到的约定一律照发,旧约定永远不被作废);
   *   · 2026-09-29 裁定 A「QQ 跟着他正在用的那条会话」——挑不出任何窗口
   *     (实测:全库 0 命中 ⇒ 只能退回陪伴会话,他要的"一条对话线"不成立)。
   * 两处共用这一个读数(唯一一份判据),别再各读各的。
   */
  function recentUserTurnAt (sessionId, sinceSec) {
    try {
      const r = db.prepare('SELECT MAX(created_at) AS t FROM conversation_log'
        + ' WHERE session_id = ? AND created_at >= ?')
        .get(String(sessionId), Number(sinceSec))
      return Number(r?.t) || 0
    } catch { return 0 }
  }

  /** 她排一个闹钟(epoch 秒)。返回 id(0 = 没写进去)。 */
  function wakeAdd ({ at, note, why = '', sessionId = '' }) {
    const r = db.prepare(`INSERT INTO echo_wakes (at, note, why, session_id, created_at, fired_at, canceled_at, fired_reason)
      VALUES (?,?,?,?,?,0,0,'')`).run(
      Number(at) || 0,
      String(note || '').trim().slice(0, 200),
      String(why || '').trim().slice(0, 200),
      String(sessionId || ''),
      Date.now() / 1000
    )
    return Number(r?.lastInsertRowid) || 0
  }

  /** 到点的闹钟(升序;`sessionId` 为空串的闹钟对任何会话都算到点)。 */
  function wakesDue (now, sessionId = '', limit = 5) {
    return db.prepare(`SELECT * FROM echo_wakes
      WHERE fired_at = 0 AND canceled_at = 0 AND at <= ?
        AND (session_id = '' OR session_id = ?)
      ORDER BY at ASC LIMIT ?`)
      .all(Number(now) || Date.now() / 1000, String(sessionId || ''), Math.max(1, Math.min(20, Number(limit) || 5)))
      .map((r) => ({
        id: Number(r.id) || 0,
        at: Number(r.at) || 0,
        note: String(r.note || ''),
        why: String(r.why || ''),
        sessionId: String(r.session_id || ''),
        createdAt: Number(r.created_at) || 0
      }))
  }

  /** 闹钟响了(或没响成):落 `fired_at` 与理由,绝不静默丢掉。 */
  function wakeFired (id, at, reason = 'fired') {
    const r = db.prepare('UPDATE echo_wakes SET fired_at = ?, fired_reason = ? WHERE id = ? AND fired_at = 0')
      .run(Number(at) || Date.now() / 1000, String(reason || 'fired'), Number(id) || 0)
    return Number(r?.changes) || 0
  }

  /** 她/他撤销一个闹钟(canceled_at ≠ 0;留行不销毁 —— 审计可查)。 */
  function wakeCancel (id, at) {
    const r = db.prepare('UPDATE echo_wakes SET canceled_at = ? WHERE id = ? AND fired_at = 0 AND canceled_at = 0')
      .run(Number(at) || Date.now() / 1000, Number(id) || 0)
    return Number(r?.changes) || 0
  }

  /** 最近排的闹钟(面板/查询用;新的在前)。 */
  function wakeList (limit = 20) {
    return db.prepare('SELECT * FROM echo_wakes ORDER BY at DESC LIMIT ?')
      .all(Math.max(1, Math.min(200, Number(limit) || 20)))
      .map((r) => ({
        id: Number(r.id) || 0,
        at: Number(r.at) || 0,
        note: String(r.note || ''),
        why: String(r.why || ''),
        sessionId: String(r.session_id || ''),
        createdAt: Number(r.created_at) || 0,
        firedAt: Number(r.fired_at) || 0,
        canceledAt: Number(r.canceled_at) || 0,
        firedReason: String(r.fired_reason || '')
      }))
  }

  function close () { try { db.close() } catch { /* 已关闭 */ } }

  /** 审计口径的对照读数:今天(本地午夜起)审计里记了几行「主动关怀」。
   *
   *  ⚠️ 2026-09-29 起 **它不再是日上限的判据**(别再拿它当护栏用):
   *  审计只留 `auditKeep`(默认 100)行、且**所有会话共用** —— 他在编码会话里
   *  跑一趟工具,她当天的行就被挤出窗口(活库实测:窗口里 `tool_call='care'`
   *  的行数是 **0**,而当天她其实开口过)。日上限已改走 `careSentCountSince`
   *  (她自己的 care_beats 表,只追加、可 GROUP BY)。
   *  这个函数留着只为一件事:与 care_beats 口径**交叉核对**。 */
  function careCountSince (ts) {
    return Number(db.prepare(
      "SELECT COUNT(*) AS n FROM audit_logs WHERE tool_call = 'care' AND timestamp >= ?"
    ).get(Number(ts) || 0).n) || 0
  }

  // ---- 日记(M3-d):一天一页,壳拥有的表 ----

  function getDiaryDate (date) {
    const row = db.prepare('SELECT date, content, mood, longing_value, created_at FROM diary WHERE date = ?')
      .get(String(date || ''))
    if (row === undefined) return null
    return {
      date: row.date, content: row.content, mood: Number(row.mood) || 3,
      longingValue: Number(row.longing_value) || 0, createdAt: Number(row.created_at) || 0
    }
  }

  function latestDiaries (limit = 7) {
    return db.prepare('SELECT date, content, mood, longing_value, created_at FROM diary ORDER BY date DESC LIMIT ?')
      .all(Math.max(1, Math.min(90, Number(limit) || 7)))
      .map((row) => ({
        date: row.date, content: row.content, mood: Number(row.mood) || 3,
        longingValue: Number(row.longing_value) || 0, createdAt: Number(row.created_at) || 0
      }))
  }

  function insertDiary ({ date, content, mood = 3, longingValue = 0 }) {
    db.prepare('INSERT OR REPLACE INTO diary (date, content, mood, longing_value, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(String(date || ''), String(content || ''), Math.min(10, Math.max(1, Math.round(Number(mood) || 3))), Number(longingValue) || 0, Date.now() / 1000)
  }

  /** 记忆浏览器(M6-b):原始行分页 —— 审查记忆库的只读窗口。
   *  state: 'active'(默认,is_active=1 且 status='active')|
   *  'quarantined'(隔离待观察)| 'forgotten'(is_active=0,行留档
   *  可审计)| 'all';sort: 'recent'(时间倒序,默认)| 'value'
   *  (I 值倒序)。q 模糊匹配 summary 与 keywords。 */
  function listMemories ({ page = 1, limit = 50, layer = '', state = 'active', source = '', q = '', sort = 'recent' } = {}) {
    const where = []
    const params = []
    if (state === 'quarantined') where.push("is_active = 1 AND status = 'quarantined'")
    else if (state === 'forgotten') where.push('is_active = 0')
    else if (state !== 'all') where.push("is_active = 1 AND status = 'active'")
    if (layer !== '') { where.push('layer = ?'); params.push(String(layer)) }
    if (source !== '') { where.push('source = ?'); params.push(String(source)) }
    if (q !== '') {
      const like = '%' + String(q).slice(0, 100) + '%'
      where.push('(summary LIKE ? OR keywords LIKE ?)')
      params.push(like, like)
    }
    const whereSql = where.length > 0 ? ' WHERE ' + where.join(' AND ') : ''
    const total = Number(db.prepare('SELECT COUNT(*) AS n FROM episodic_memory' + whereSql).get(...params).n) || 0
    const lim = Math.max(1, Math.min(200, Number(limit) || 50))
    const maxPage = Math.max(1, Math.ceil(total / lim))
    const pg = Math.max(1, Math.min(maxPage, Number(page) || 1))
    const order = sort === 'value' ? 'intrinsic_value DESC, timestamp DESC' : 'timestamp DESC'
    const rows = db.prepare(
      'SELECT * FROM episodic_memory' + whereSql + ' ORDER BY ' + order + ' LIMIT ? OFFSET ?'
    ).all(...params, lim, (pg - 1) * lim)
    return {
      total, page: pg, limit: lim,
      rows: rows.map((r) => ({
        memoryId: r.memory_id,
        summary: r.summary || '',
        keywords: safeJsonObject(r.keywords) ?? [],
        emotionScore: r.emotion_score || 0,
        intrinsicValue: Number(r.intrinsic_value) || 0,
        halfLife: Number(r.half_life) || 0,
        recallCount: r.recall_count || 0,
        lastRecalled: Number(r.last_recalled) || 0,
        layer: r.layer || '',
        status: r.status || 'active',
        isActive: r.is_active === 1,
        source: r.source || '',
        sourceLabel: r.source_label || '',
        memoryKey: r.memory_key || '',
        supersededBy: r.superseded_by || 0,
        occurredAt: Number(r.occurred_at) || 0,
        learnedAt: Number(r.learned_at) || 0,
        temporalStatus: r.temporal_status || 'time_unknown',
        timestamp: Number(r.timestamp) || 0
      }))
    }
  }

  /** 手动编辑记忆(M6-d,用户裁决开闸面板写路径):
   *  改 summary/keywords/emotionScore;改情绪分按 DMAE 口径重算 I 与
   *  半衰期(与 insertMemory 同源公式)。审计行 toolCall='memory_edit'
   *  —— 审查台是审查席,但审查席有权修正,修正本身留痕。 */
  function editMemory ({ memoryId, summary, keywords, emotionScore }) {
    const id = Number(memoryId) || 0
    const row = db.prepare('SELECT memory_id, summary, keywords, emotion_score FROM episodic_memory WHERE memory_id = ?').get(id)
    if (row === undefined) return null
    const sets = []
    const params = []
    if (summary !== undefined) {
      const s = String(summary).trim().slice(0, 500)
      if (s === '') return { error: 'summary 不能为空' }
      sets.push('summary = ?'); params.push(s)
    }
    if (keywords !== undefined) {
      // 数组或分隔符字符串都收(面板输入是「、」分隔)
      const raw = Array.isArray(keywords) ? keywords : String(keywords).split(/[,，、;；\s]+/)
      const arr = raw.map((k) => String(k).trim()).filter(Boolean).slice(0, 12).map((k) => k.slice(0, 30))
      sets.push('keywords = ?'); params.push(JSON.stringify(arr))
    }
    if (emotionScore !== undefined) {
      const e = Math.min(10, Math.max(1, Math.round(Number(emotionScore) || 1)))
      const iVal = Math.max(1.0, Math.min(100.0, e * 10.0))
      const h0 = initialHalfLife(iVal, DMAE_DEFAULT)
      sets.push('emotion_score = ?'); params.push(e)
      sets.push('intrinsic_value = ?'); params.push(iVal)
      sets.push('half_life = ?'); params.push(h0)
    }
    if (sets.length === 0) return { error: '没有可改的字段' }
    params.push(id)
    db.prepare('UPDATE episodic_memory SET ' + sets.join(', ') + ' WHERE memory_id = ?').run(...params)
    writeAudit({
      traceId: manualTraceId(id),
      stage: 'manual',
      step: 90,
      userInput: '面板手动编辑记忆 #' + id,
      llmReply: String(summary ?? row.summary).slice(0, 80),
      toolCall: 'memory_edit'
    })
    return { ok: true, memoryId: id }
  }

  /** 记忆状态机(M6-d):隔离/转正/遗忘/恢复/置顶L0/取消L0。
   *  遗忘 = is_active=0 行留档(审计可查,绝不物理删除 —— echo_forget
   *  同款纪律);恢复被取代的行会清 superseded_by(人证优先于自动换代,
   *  与换代行并存时由人决定再遗忘哪条);L0 = 引擎零命中豁免 + 强制
   *  占位 + [核心] 标记(python 侧按行数据生效,无需引擎配合)。 */
  function setMemoryState ({ memoryId, action }) {
    const id = Number(memoryId) || 0
    const row = db.prepare('SELECT memory_id, is_active, status, layer, superseded_by FROM episodic_memory WHERE memory_id = ?').get(id)
    if (row === undefined) return null
    const act = String(action || '')
    if (act === 'quarantine') {
      db.prepare("UPDATE episodic_memory SET status = 'quarantined' WHERE memory_id = ?").run(id)
    } else if (act === 'activate') {
      db.prepare("UPDATE episodic_memory SET status = 'active' WHERE memory_id = ?").run(id)
    } else if (act === 'forget') {
      db.prepare('UPDATE episodic_memory SET is_active = 0 WHERE memory_id = ?').run(id)
    } else if (act === 'restore') {
      db.prepare('UPDATE episodic_memory SET is_active = 1, superseded_by = 0 WHERE memory_id = ?').run(id)
    } else if (act === 'l0') {
      db.prepare("UPDATE episodic_memory SET layer = 'L0' WHERE memory_id = ?").run(id)
    } else if (act === 'unl0') {
      db.prepare("UPDATE episodic_memory SET layer = '' WHERE memory_id = ?").run(id)
    } else {
      return { error: '未知 action:' + act }
    }
    writeAudit({
      traceId: manualTraceId(id),
      stage: 'manual',
      step: 90,
      userInput: '面板手动状态 ' + act + ' 记忆 #' + id,
      llmReply: String(row.summary || '').slice(0, 80),
      toolCall: 'memory_state'
    })
    return { ok: true, memoryId: id, action: act }
  }

  /** 会话预览(M7-a):audit_logs 里出现过的会话,带最新一条用户
   *  输入当辨认标签 —— 设置区范围名单不能只给一串看不懂的 id。 */
  function sessionPreviews (limit = 30) {
    const rows = db.prepare(
      "SELECT session_id, MAX(timestamp) AS latest, COUNT(*) AS turns" +
      " FROM audit_logs WHERE session_id IS NOT NULL AND session_id != ''" +
      ' GROUP BY session_id ORDER BY latest DESC LIMIT ?'
    ).all(Math.max(1, Math.min(100, Number(limit) || 30)))
    const preview = db.prepare(
      "SELECT user_input FROM audit_logs WHERE session_id = ? AND user_input != ''" +
      ' ORDER BY timestamp DESC LIMIT 1'
    )
    return rows.map((r) => {
      let label = ''
      try { label = String(preview.get(r.session_id)?.user_input || '') } catch { }
      return {
        sessionId: r.session_id,
        lastAt: Number(r.latest) || 0,
        turns: Number(r.turns) || 0,
        label: label.slice(0, 40)
      }
    })
  }

  /** 对话记录(M8-a):一轮一行,全局滚动窗口(用户裁决 100 轮 ——
   *  写时修剪,跨会话共用;channel = 来源标签写时快照,中继自注册
   *  「QQ」,直聊默认空)。只有范围内心仪会话的对话进日志 ——
   *  工作会话的纯 agent 回复是噪音,不记。 */
  function writeConversation ({ sessionId = '', channel = '', userText = '', replyText = '' }) {
    db.prepare(
      'INSERT INTO conversation_log (session_id, channel, user_text, reply_text, created_at)' +
      ' VALUES (?, ?, ?, ?, ?)'
    ).run(String(sessionId || ''), String(channel || ''), String(userText || ''),
      String(replyText || ''), Date.now() / 1000)
    // 全局滚动 100:老的让位(对话是回放用的近期窗,不是档案 ——
    // 档案归审计与记忆,这里只要「她最近说过什么」)
    db.prepare(
      'DELETE FROM conversation_log WHERE turn_id NOT IN' +
      ' (SELECT turn_id FROM conversation_log ORDER BY turn_id DESC LIMIT ?)'
    ).run(CONVERSATION_KEEP)
    return { ok: true }
  }

  /** 对话回放(M8-a):倒序取最近对话,可按渠道过滤。 */
  function listConversations ({ limit = 50, channel = '' } = {}) {
    const cap = Math.max(1, Math.min(100, Number(limit) || 50))
    const rows = channel
      ? db.prepare('SELECT * FROM conversation_log WHERE channel = ? ORDER BY turn_id DESC LIMIT ?').all(String(channel), cap)
      : db.prepare('SELECT * FROM conversation_log ORDER BY turn_id DESC LIMIT ?').all(cap)
    return rows.map((r) => ({
      turnId: r.turn_id,
      sessionId: r.session_id || '',
      channel: r.channel || '',
      userText: r.user_text || '',
      replyText: r.reply_text || '',
      createdAt: Number(r.created_at) || 0
    }))
  }

  /**
   * v0.14.1 F3:某会话最近 N 轮对话(**正序**,老→新)。
   * 反思提示词的「最近对话」段用它 —— A 侧 main.py:767-783 喂给 Judge
   * 的就是这个形状(recent_rounds 末 5 条)。当前轮已在日志里(轮末
   * 先写日志后起火),所以不额外补,避免同一个回合出现两遍。
   */
  function recentTurns (sessionId, limit = 5) {
    const cap = Math.max(1, Math.min(20, Number(limit) || 5))
    const rows = db.prepare(
      'SELECT user_text, reply_text FROM conversation_log WHERE session_id = ?' +
      ' ORDER BY turn_id DESC LIMIT ?'
    ).all(String(sessionId || ''), cap * 4)
    // 2026-09-26 现场:宿主注入的 runtime context 也被捕获进了这张表
    // (活库实测 44/100 行)。这里是反思信封的「最近 5 轮」—— 不过滤的话,
    // 模型会把那段当成"他前几轮说过的话",用来给指代与情绪找语境。
    // 与记忆层同一份判据 —— 但要**先多取一截再筛掉**,否则噪音占满
    // limit 时,真正该当语境的那几轮会被挤出窗口(信封里就只剩空行)。
    const clean = rows.filter((r) => isHumanUtterance(String(r.user_text || '')))
      .slice(0, cap)
    return clean.reverse().map((r) => ({
      user: r.user_text || '',
      assistant: r.reply_text || ''
    }))
  }

  /**
   * 这个会话**最后一行**对话记录(v0.18.1 认账条款要用)。
   *
   * A 侧 `_build_proactive_line` 走的是插件内存里的对话窗口
   * (`self._recent_rounds[session_id]`,末轮带 `(她主动开口)` 哨兵)—— 重载即丢,
   * 所以它还要查审计兜底。B 侧这一行是**落库的**(`conversation_log`),
   * 重载不丢,比 A 的内存窗口更结实:哨兵还在,就说明"她上一条是主动说的"。
   */
  function latestConversation (sessionId) {
    const sid = String(sessionId || '')
    if (sid === '') return null
    const r = db.prepare(
      'SELECT user_text, reply_text, channel, created_at FROM conversation_log' +
      ' WHERE session_id = ? ORDER BY turn_id DESC LIMIT 1'
    ).get(sid)
    if (!r) return null
    return {
      userText: r.user_text || '',
      replyText: r.reply_text || '',
      channel: r.channel || '',
      createdAt: Number(r.created_at) || 0
    }
  }

  /**
   * 最新一条反思信念(v0.18.1)。
   *
   * A 侧 `main.py:1800-1811`:关怀组稿的「上次聊到」话头行**优先取最新反思行**
   * (layer='reflection',带证据链接)—— 比单轮摘要残渣接地强;只有反思行比
   * 状态行新时才覆盖,正常对话轮的话题照旧。
   */
  function latestReflectionSummary () {
    try {
      const r = db.prepare(
        "SELECT summary, timestamp FROM episodic_memory" +
        " WHERE layer = 'reflection' AND is_active = 1" +
        ' ORDER BY memory_id DESC LIMIT 1'
      ).get()
      if (!r) return null
      return { summary: String(r.summary || ''), timestamp: Number(r.timestamp) || 0 }
    } catch {
      return null // 老库没这列/表:话头行退回状态行的 current_topic
    }
  }

  // ============================================================
  // v0.17.0 R2:传话桥的库面(纯 SQL,桥的业务逻辑在 lib/relay.js)
  // ============================================================

  /**
   * 入站重试的「接管年龄」(秒):**必须**大于她最长的一轮。
   *
   * 原来写死 60s(调用方不传就是它)—— 可她一轮长任务跑十分钟是正常状态
   * (本文件上面自己就这么写着),60 秒后适配器重试就会「接管」一条**正在被
   * 处理**的消息:同一个 msgId 注入两遍,他收到两条一样的回复。
   * 代价不对称:宁可让适配器多等(它本来就该按 msgId 幂等重试),也不能让她
   * 答两遍。300s 覆盖绝大多数一轮;更长的任务由适配器侧的重试节奏兜着。
   */
  const RELAY_INBOUND_STALE_SEC = 300

  /**
   * 入站受理(幂等 + 可重试)。返回 {token, duplicate, takenOver}:
   *   - 没见过的 msg_id → 落一条 pending,**必须**由调用方在注入成功后
   *     `relayCommitInbound`,失败(比如她正忙)则 `relayRollbackInbound`。
   *   - 已 accepted → duplicate(适配器重试到此为止,不让她答两遍)。
   *   - pending 但超过 staleSec(上一次尝试半路死了)→ 接管重来。
   * 为什么不「先插后判」一把梭:她的忙是**正常状态**(一个长任务跑十分钟),
   * 那会儿必须让适配器能重试;而重试又不能变成第二个她。
   */
  function relayBeginInbound ({ platform, msgId, sessionId = '', now = 0, staleSec = RELAY_INBOUND_STALE_SEC }) {
    const t = Number(now) || Date.now() / 1000
    const p = String(platform || '')
    const m = String(msgId || '')
    if (p === '' || m === '') return { token: '', duplicate: true, takenOver: false }
    const row = db.prepare(
      'SELECT state, seen_at FROM relay_inbox_seen WHERE platform = ? AND msg_id = ?'
    ).get(p, m)
    if (row === undefined) {
      db.prepare(
        'INSERT INTO relay_inbox_seen (platform, msg_id, state, session_id, seen_at)' +
        " VALUES (?, ?, 'pending', ?, ?)"
      ).run(p, m, String(sessionId || ''), t)
      return { token: p + '\u0001' + m, duplicate: false, takenOver: false }
    }
    if (String(row.state || '') === 'accepted') return { token: '', duplicate: true, takenOver: false }
    const seenAt = Number(row.seen_at) || 0
    // seen_at = 0 = 「没人在飞」(被回滚退回 pending 的那条):立刻可接管,
    // 不必等 staleSec —— 这正是旧代码用 DELETE 换来的那个效果,只是不再删行。
    if (seenAt > 0 && t - seenAt < Math.max(1, Number(staleSec) || RELAY_INBOUND_STALE_SEC)) {
      return { token: '', duplicate: true, takenOver: false } // 上一次还在飞
    }
    db.prepare('UPDATE relay_inbox_seen SET seen_at = ? WHERE platform = ? AND msg_id = ?').run(t, p, m)
    return { token: p + '\u0001' + m, duplicate: false, takenOver: true }
  }

  /** 注入成功:这条消息算答过了(后续重试一律 duplicate)。 */
  function relayCommitInbound ({ platform, msgId }) {
    try {
      const r = db.prepare(
        "UPDATE relay_inbox_seen SET state = 'accepted' WHERE platform = ? AND msg_id = ?"
      ).run(String(platform || ''), String(msgId || ''))
      // v0.42.0 审计修复(P1):原来无条件 return true —— 行没了(被别人接管、
      // 被回滚、被清理)也报成功,调用方就没机会知道「受理记录已经不在了」。
      return Number(r?.changes ?? 0) > 0
    } catch { return false }
  }

  /**
   * 注入失败(她忙/宿主没起来):让适配器能重试。
   *
   * v0.42.0 审计修复(P1:重复投递):原来是 **DELETE** 这行 —— 但如果另一次
   * 重试已经把它接管了,这一删就把**别人的**受理记录删掉:那次注入的 commit
   * 于是 0 行(旧代码还报成功),第三次重试看表里空空 → 再注入一遍 =
   * 他会收到两条一样的回复。现在改成「原地退回 pending + seen_at 归零」:
   * 行还在,谁也别删谁的;归零意味着下一次重试立刻可以接管 ——
   * 与旧的「删掉就能立刻重试」等效,却不波及已经接管的另一次尝试。
   *
   * 残留(留作讨论,不在本轮修):两次尝试都活着、并且都在 300s 之上时,
   * 迟到的回滚仍会把接管方的 seen_at 清零。要彻底解需要给每次尝试一个
   * token(= 往 relay_inbox_seen 加一列,commit/rollback 都带上它),而
   * 现在 store→relay 的调用签名里没有 token(relay.js 只传 platform/msgId)。
   */
  function relayRollbackInbound ({ platform, msgId }) {
    try {
      db.prepare(
        "UPDATE relay_inbox_seen SET state = 'pending', seen_at = 0 WHERE platform = ? AND msg_id = ?"
      ).run(String(platform || ''), String(msgId || ''))
      return true
    } catch { return false }
  }

  /**
   * 30 天清理:幂等表不该无限长。
   *
   * 只删**已落定**(accepted)的老行 —— pending 行是「重试台账」,行数上限是
   * 「没送成的消息数」(少见),留着比删掉安全:删错了就是重复投递。
   */
  function relayPruneInbox ({ now = 0, keepDays = 30 } = {}) {
    const t = Number(now) || Date.now() / 1000
    try {
      const r = db.prepare(
        "DELETE FROM relay_inbox_seen WHERE state = 'accepted' AND seen_at < ?"
      ).run(t - Math.max(1, Number(keepDays) || 30) * 86400)
      return Number(r?.changes ?? 0)
    } catch { return 0 }
  }

  /**
   * 30 天清理:`care_beats` 是**每拍一行**的心跳流水(v0.31.0 起落库,给 care-report
   * 做 GROUP BY)。2026-09-29 实测:10.3 小时就 153 行(≈15 行/时 ⇒ 一年十几万行),
   * 而全仓只有 INSERT 和 SELECT —— **一个 DELETE 都没有**。它是"能查"的凭据,不是
   * "永远留着"的档案:留 30 天足够复盘(与 relay 幂等表同档)。
   */
  function pruneCareBeats ({ now = 0, keepDays = 30 } = {}) {
    const t = Number(now) || Date.now() / 1000
    try {
      const r = db.prepare('DELETE FROM care_beats WHERE at < ?')
        .run(t - Math.max(1, Number(keepDays) || 30) * 86400)
      return Number(r?.changes ?? 0)
    } catch { return 0 }
  }

  /**
   * 30 天清理:出站队列里**已经落定**的老行(acked / dropped)。
   *
   * `acked_at = 0 且 dropped_at = 0` 的行是「还没送出去的话」—— **一条都不许删**:
   * 删了就是丢话。代价不对称 —— 多留一行只占几十字节,少一条是他永远收不到。
   */
  function pruneRelayOutbox ({ now = 0, keepDays = 30 } = {}) {
    const t = Number(now) || Date.now() / 1000
    const cut = t - Math.max(1, Number(keepDays) || 30) * 86400
    try {
      const r = db.prepare(
        'DELETE FROM relay_outbox WHERE (acked_at > 0 AND acked_at < ?)'
        + ' OR (dropped_at > 0 AND dropped_at < ?)'
      ).run(cut, cut)
      return Number(r?.changes ?? 0)
    } catch { return 0 }
  }

  /**
   * 登记/更新一个聊天(路由表)。session_id 变了(比如换陪伴会话)也照写。
   * proactive 只在**第一次**建行时由默认值给,之后以库里的为准(面板可改)。
   */
  function relayUpsertChannel ({
    platform, chatId, chatType = 'private', chatTitle = '', sessionId,
    label = '', proactive = null, now = 0
  }) {
    const t = Number(now) || Date.now() / 1000
    const p = String(platform || '')
    const c = String(chatId || '')
    if (p === '' || c === '') return null
    const existing = db.prepare(
      'SELECT * FROM relay_channels WHERE platform = ? AND chat_id = ?'
    ).get(p, c)
    if (existing === undefined) {
      db.prepare(
        'INSERT INTO relay_channels (platform, chat_id, chat_type, chat_title, session_id,' +
        ' label, proactive, is_primary, enabled, last_in_at, last_out_at, created_at)' +
        ' VALUES (?, ?, ?, ?, ?, ?, ?, 0, 1, ?, 0, ?)'
      ).run(p, c, String(chatType || 'private'), String(chatTitle || ''), String(sessionId || ''),
        String(label || ''), proactive === null ? 1 : (proactive ? 1 : 0), t, t)
    } else {
      db.prepare(
        'UPDATE relay_channels SET chat_type = ?, chat_title = ?, session_id = ?, label = ?,' +
        ' proactive = ?, last_in_at = ? WHERE platform = ? AND chat_id = ?'
      ).run(String(chatType || existing.chat_type || 'private'),
        String(chatTitle || existing.chat_title || ''), String(sessionId || existing.session_id || ''),
        String(label || existing.label || ''),
        proactive === null ? Number(existing.proactive) || 0 : (proactive ? 1 : 0), t, p, c)
    }
    return relayGetChannel({ platform: p, chatId: c })
  }

  function relayGetChannel ({ platform, chatId }) {
    const r = db.prepare(
      'SELECT * FROM relay_channels WHERE platform = ? AND chat_id = ?'
    ).get(String(platform || ''), String(chatId || ''))
    return r === undefined ? null : channelRow(r)
  }

  /** 某个会话绑着的所有聊天(出站投递用:一轮答复要回给哪个聊天)。 */
  function relayChannelsOfSession (sessionId) {
    return db.prepare(
      'SELECT * FROM relay_channels WHERE session_id = ? AND enabled = 1'
    ).all(String(sessionId || '')).map(channelRow)
  }

  function relayListChannels () {
    return db.prepare('SELECT * FROM relay_channels ORDER BY platform, chat_id').all().map(channelRow)
  }

  /** 面板改单个聊天的策略(只允许改那几个开关相关字段)。 */
  function relaySetChannel ({ platform, chatId, enabled = null, proactive = null, isPrimary = null }) {
    const sets = []
    const args = []
    if (typeof enabled === 'boolean') { sets.push('enabled = ?'); args.push(enabled ? 1 : 0) }
    if (typeof proactive === 'boolean') { sets.push('proactive = ?'); args.push(proactive ? 1 : 0) }
    if (typeof isPrimary === 'boolean') { sets.push('is_primary = ?'); args.push(isPrimary ? 1 : 0) }
    if (sets.length === 0) return { error: '没有可改的字段' }
    args.push(String(platform || ''), String(chatId || ''))
    db.prepare('UPDATE relay_channels SET ' + sets.join(', ') + ' WHERE platform = ? AND chat_id = ?').run(...args)
    return { ok: true }
  }

  function channelRow (r) {
    return {
      platform: r.platform || '',
      chatId: r.chat_id || '',
      chatType: r.chat_type || 'private',
      chatTitle: r.chat_title || '',
      sessionId: r.session_id || '',
      label: r.label || '',
      proactive: Number(r.proactive) || 0,
      isPrimary: Number(r.is_primary) || 0,
      enabled: Number(r.enabled) || 0,
      lastInAt: Number(r.last_in_at) || 0,
      lastOutAt: Number(r.last_out_at) || 0,
      lastError: r.last_error || '',
      createdAt: Number(r.created_at) || 0
    }
  }

  /**
   * 她的答复/主动话进队列。expiresAt>0 = 过期就丢,不补发。
   * notBefore>0 = 还没到点(气泡的泡间节奏,适配器按它发);groupId/seq = 泡组与序号。
   */
  function relayEnqueue ({
    platform, chatId, sessionId = '', turnId = '', kind = 'reply', text = '',
    expiresAt = 0, now = 0, notBefore = 0, groupId = '', seq = 0
  }) {
    const body = String(text || '')
    if (String(platform || '') === '' || String(chatId || '') === '' || body.trim() === '') {
      return { error: 'platform/chatId/text 必填' }
    }
    const t = Number(now) || Date.now() / 1000
    const r = db.prepare(
      'INSERT INTO relay_outbox (platform, chat_id, session_id, turn_id, kind, text,' +
      ' created_at, expires_at, leased_until, acked_at, dropped_at, not_before, group_id, seq, canceled_at)' +
      ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, ?, ?, ?, 0)'
    ).run(String(platform), String(chatId), String(sessionId || ''), String(turnId || ''),
      String(kind || 'reply'), body, t, Number(expiresAt) || 0,
      Number(notBefore) || 0, String(groupId || ''), Math.max(0, Number(seq) || 0))
    // 顺手把「最后发出时间」记在渠道行上(面板要看「这个聊天多久没说话了」)
    try {
      db.prepare('UPDATE relay_channels SET last_out_at = ? WHERE platform = ? AND chat_id = ?')
        .run(t, String(platform), String(chatId))
    } catch { /* 渠道行不在也不该让入队失败 */ }
    return { ok: true, outId: Number(r.lastInsertRowid) || 0 }
  }

  /**
   * 领取出站消息(适配器轮询)。**一个平台一次领一批**,按 id 升序(FIFO)。
   * 领走即打租约;过期的先清(并记为 dropped —— 迟到的关怀不是关怀)。
   * 已租给别人的不动(除非租约过期),这样适配器崩了最多重发一次。
   */
  function relayLeaseOutbox ({ platform, limit = 20, leaseSec = 30, now = 0 }) {
    const t = Number(now) || Date.now() / 1000
    const cap = Math.max(1, Math.min(100, Number(limit) || 20))
    const lease = Math.max(1, Number(leaseSec) || 30)
    // 2026-10-15 加群聊：这一泡要发到**群**还是**私聊**？
    // ⚠️ `relay_outbox` **没有 `chat_type` 列**，所以走**甲**方案：拿 `chat_id`
    //    去 `relay_channels` 查（群聊那行的 `chat_id` 就是群号，天然唯一）。
    //    查不到 / 老库没这列 ⇒ 落回 `'private'`（与改动前一字不差地对外发）。
    //    预编译一次，循环里复用；prepare 失败也退回「一律私聊」，不许拖垮发送。
    let chatTypeOf = null
    try {
      const stmt = db.prepare('SELECT chat_type FROM relay_channels WHERE platform = ? AND chat_id = ?')
      chatTypeOf = (platform, chatId) => {
        try {
          const row = stmt.get(String(platform || ''), String(chatId || ''))
          return String(row?.chat_type ?? '') === 'group' ? 'group' : 'private'
        } catch {
          return 'private'
        }
      }
    } catch {
      chatTypeOf = () => 'private'
    }
    let dropped = 0
    try {
      const d = db.prepare(
        'UPDATE relay_outbox SET dropped_at = ?' +
        ' WHERE platform = ? AND acked_at = 0 AND dropped_at = 0' +
        ' AND expires_at > 0 AND expires_at <= ?'
      ).run(t, String(platform || ''), t)
      dropped = Number(d?.changes ?? 0)
    } catch { /* 列缺失:老库还没迁移,跳过 */ }
    const rows = db.prepare(
      'SELECT * FROM relay_outbox WHERE platform = ? AND acked_at = 0 AND dropped_at = 0' +
      ' AND canceled_at = 0' +
      ' AND (leased_until = 0 OR leased_until <= ?)' +
      ' AND (not_before = 0 OR not_before <= ?)' +
      ' ORDER BY out_id ASC LIMIT ?'
    ).all(String(platform || ''), t, t, cap * 4)
    const items = []
    const groupsTaken = new Set()
    for (const r of rows) {
      if (items.length >= cap) break
      // 气泡组:一次只放**一泡**出去,其余留到下一轮。
      // 这是 barge-in 的前提 —— A 侧语义是「手里这泡发完就停」,所以同时最多
      // 只能有一泡在适配器手里;否则他一插话,已经领走的那几泡照样会发出去。
      const gid = String(r.group_id || '')
      if (gid !== '') {
        if (groupsTaken.has(gid)) continue
        groupsTaken.add(gid)
      }
      db.prepare('UPDATE relay_outbox SET leased_until = ? WHERE out_id = ?').run(t + lease, r.out_id)
      items.push({
        id: Number(r.out_id) || 0,
        chatId: r.chat_id || '',
        kind: r.kind || 'reply',
        text: r.text || '',
        turnId: r.turn_id || '',
        createdAt: Number(r.created_at) || 0,
        // 泡的到期时刻:适配器在发这一条之前等到这个点(没到点就先等,别提前发)
        notBefore: Number(r.not_before) || 0,
        groupId: gid,
        seq: Number(r.seq) || 0,
        // ★ 2026-10-15 加群聊（甲方案）：消费端据此决定发 `send_group_msg`
        //   还是 `send_private_msg`。查不到就 `'private'` —— 老消费端不看这个字段，
        //   新消费端认不出也落回 private，两边都不炸（契约的"单向宽容"）。
        chatType: chatTypeOf(platform, r.chat_id)
      })
    }
    // 下一泡什么时候到点:适配器靠它决定"这次轮询完,隔多久再来"。
    // 没有它的话节奏会被固定的 poll_interval_seconds 吃掉(2s 一拍,
    // A 侧的 1.2~2.3s 抖动就变成了呆板的 2s)。
    let nextDueAt = 0
    try {
      const nx = db.prepare(
        'SELECT MIN(not_before) AS nb FROM relay_outbox WHERE platform = ? AND acked_at = 0' +
        ' AND dropped_at = 0 AND canceled_at = 0 AND (leased_until = 0 OR leased_until <= ?)' +
        ' AND not_before > ?'
      ).get(String(platform || ''), t, t)
      nextDueAt = Number(nx?.nb) || 0
    } catch { /* 老库还没补列:退回固定轮询,不影响发送 */ }
    return { items, dropped, now: t, leaseUntil: t + lease, nextDueAt }
  }

  /**
   * barge-in:他插话了 —— 把**还没递到适配器手里**的气泡作废,并把残句交回来。
   *
   * A 侧出处 `main.py:650-660`:`_session_seq` 一变,就把 `"".join(bubbles[i:])`
   * 的残句存进 `_interrupted_tail[session_id][:120]` 并 break;已发出的泡不撤回
   * (「真人被插嘴,说出去的话也收不回」),记忆里存的仍是完整 reply。
   *
   * 这里的对应:只作废 `leased_until = 0` 的泡 —— 正在发的那一泡照发(手里这泡
   * 发完就停),所以残句比 A 侧少一泡:少掉的那泡他其实收到了,不该算"没说完"。
   */
  function relayCancelBubbles ({ sessionId = '', platform = '', chatId = '', now = 0, tailMax = 120 } = {}) {
    const t = Number(now) || Date.now() / 1000
    const sid = String(sessionId || '')
    const pf = String(platform || '')
    const cid = String(chatId || '')
    if (sid === '' && pf === '') return { rows: 0, tail: '' }
    const where = ['acked_at = 0', 'dropped_at = 0', 'canceled_at = 0', 'leased_until = 0',
      "group_id != ''", "kind = 'reply'"]
    const args = []
    if (sid !== '') { where.push('session_id = ?'); args.push(sid) }
    if (pf !== '') { where.push('platform = ?'); args.push(pf) }
    if (cid !== '') { where.push('chat_id = ?'); args.push(cid) }
    const rows = db.prepare(
      'SELECT out_id, text, seq FROM relay_outbox WHERE ' + where.join(' AND ') +
      ' ORDER BY seq ASC, out_id ASC'
    ).all(...args)
    if (rows.length === 0) return { rows: 0, tail: '' }
    const stmt = db.prepare('UPDATE relay_outbox SET canceled_at = ?, dropped_at = ? WHERE out_id = ?')
    for (const r of rows) stmt.run(t, t, r.out_id)
    const tail = rows.map((r) => String(r.text || '')).join('')
      .slice(0, Math.max(1, Number(tailMax) || 120))
    return { rows: rows.length, tail, seqs: rows.map((r) => Number(r.seq) || 0) }
  }

  /**
   * v0.40.0 C3:她**最近说过的话**(已送达的那些)—— 防重复检查的回看窗口。
   * 只读,只认她自己的出站气泡(`kind='reply'`),按时间倒序取 N 条再翻回来
   * (返回顺序 = 从旧到新,调用方不用再排)。
   */
  function relayRecentOutbound ({ sessionId = '', limit = 3 } = {}) {
    const sid = String(sessionId || '')
    if (sid === '') return []
    const n = Math.max(1, Math.min(20, Number(limit) || 3))
    try {
      const rows = db.prepare(
        "SELECT text FROM relay_outbox WHERE session_id = ? AND canceled_at = 0 AND dropped_at = 0 " +
        "ORDER BY out_id DESC LIMIT ?"
      ).all(sid, n)
      return rows.map((r) => String(r.text || '')).reverse()
    } catch { return [] } // 读不到 ⇒ 这一轮不做防重复检查(宁可漏一次,不许挡她说话)
  }

  function relayPendingBubbles ({ sessionId = '', now = 0 } = {}) {
    const sid = String(sessionId || '')
    const t = Number(now) || Date.now() / 1000
    if (sid === '') return { rows: 0, lastNotBefore: 0, currentNotBefore: 0, tail: '' }
    try {
      const rows = db.prepare(
        "SELECT text, seq, not_before FROM relay_outbox WHERE session_id = ? AND acked_at = 0 " +
        "AND dropped_at = 0 AND canceled_at = 0 AND kind = 'reply' ORDER BY seq ASC, out_id ASC"
      ).all(sid)
      if (rows.length === 0) return { rows: 0, lastNotBefore: 0, currentNotBefore: 0, tail: '' }
      const times = rows.map((r) => Number(r.not_before) || 0)
      const future = times.filter((x) => x > t)
      return {
        rows: rows.length,
        lastNotBefore: Math.max(...times),
        // "当前那一泡"= 还没到点、最先要发的那一个(F4 的 finish-soon 要排到它后面)
        currentNotBefore: future.length > 0 ? Math.min(...future) : Math.max(...times),
        tail: rows.map((r) => String(r.text || '')).join('').slice(0, 120)
      }
    } catch { return { rows: 0, lastNotBefore: 0, currentNotBefore: 0, tail: '' } }
  }

  /** 适配器确认送达(只有它说发成功了才销账)。 */
  function relayAckOutbox ({ ids = [], now = 0 }) {
    const t = Number(now) || Date.now() / 1000
    let acked = 0
    const rows = []
    for (const id of Array.isArray(ids) ? ids : []) {
      const n = Number(id) || 0
      if (n <= 0) continue
      // v0.18.1 C5:先认人再销账 —— "真送到了"这一刻要知道销的是**哪一条**
      // (哪个会话、哪种 kind)。A 侧纪律是发送成功才降权/才安抚
      // (`main.py:1836-1841`「她没说出口就不算提过」),B 侧的"发送成功"
      // 就是适配器这一声 ack,所以这一刻必须带得出身份。
      let row = null
      try {
        row = db.prepare(
          'SELECT out_id, session_id, kind, turn_id, group_id, seq, text FROM relay_outbox' +
          ' WHERE out_id = ? AND acked_at = 0'
        ).get(n)
      } catch { row = null }
      const r = db.prepare(
        'UPDATE relay_outbox SET acked_at = ?, leased_until = 0 WHERE out_id = ? AND acked_at = 0'
      ).run(t, n)
      const changed = Number(r?.changes ?? 0)
      acked += changed
      if (changed > 0 && row) {
        rows.push({
          id: Number(row.out_id) || n,
          sessionId: String(row.session_id || ''),
          kind: String(row.kind || 'reply'),
          turnId: String(row.turn_id || ''),
          groupId: String(row.group_id || ''),
          seq: Number(row.seq) || 0,
          text: String(row.text || '')
        })
      }
    }
    return { ok: true, acked, rows }
  }

  /** 队列健康(面板卡片 + 体检脚本)。 */
  function relayQueueStats ({ platform = '' } = {}) {
    const p = String(platform || '')
    const where = p === '' ? '' : ' AND platform = ?'
    const args = p === '' ? [] : [p]
    const one = (sql) => {
      try { return Number(db.prepare(sql + where).get(...args)?.n) || 0 } catch { return 0 }
    }
    return {
      queued: one('SELECT COUNT(*) AS n FROM relay_outbox WHERE acked_at = 0 AND dropped_at = 0'),
      leased: one('SELECT COUNT(*) AS n FROM relay_outbox WHERE acked_at = 0 AND dropped_at = 0 AND leased_until > 0'),
      sent: one('SELECT COUNT(*) AS n FROM relay_outbox WHERE acked_at > 0'),
      dropped: one('SELECT COUNT(*) AS n FROM relay_outbox WHERE dropped_at > 0'),
      channels: one('SELECT COUNT(*) AS n FROM relay_channels WHERE enabled = 1')
    }
  }

  return {
    db, insertMemory, retrieve, getState, saveState, saveEmotionVector, getProfile, setName, writeAudit,
    // ★ 2026-10-18：让「这一轮是谁」自动进 stage_detail.turnTrace（面板按轮归组的前提）
    setTurnTraceResolver,
    // v0.18.3 M3:画像常驻锚点的写口(A 的 `_apply_profile_update` 纪律)
    saveProfileTraits,
    trimAudit, setAuditKeep,
    memoryStats, listAudit, listThreads, longingRows, graphData, emotionStates, memoryHealth,
    memoriesByIds, topEntityNames,
    careCountSince, getDiaryDate, latestDiaries, insertDiary, listMemories, editMemory, setMemoryState,
    sessionPreviews, writeConversation, listConversations, recentTurns, close,
    // v0.18.1 关怀组稿层:认账条款与「上次聊到」话头行的读口
    latestConversation, latestReflectionSummary,
    // v0.17.0 R2 传话桥
    relayBeginInbound, relayCommitInbound, relayRollbackInbound, relayPruneInbox,
    pruneCareBeats, pruneRelayOutbox,
    relayUpsertChannel, relayGetChannel, relayChannelsOfSession, relayListChannels, relaySetChannel,
    relayEnqueue, relayLeaseOutbox, relayAckOutbox, relayQueueStats, relayCancelBubbles,
    relayRecentOutbound, relayPendingBubbles,
    // v0.31.0 P2:关怀账(reason 可 GROUP BY)+ 她自己的闹钟
    careBeatAdd, careBeatsSince, careBeatSummary, careSentCountSince, recentToolCallAt, recentUserTurnAt,
    wakeAdd, wakesDue, wakeFired, wakeCancel, wakeList
  }
}

/**
 * v0.16.0 M4:称呼清洗 —— 空/占位词一律当「没有称呼」。
 *
 * 为什么需要:`String(null)` 的坑实测落进了活库(`name='null'`)。
 * 模型输出的 JSON 里 null 被某些路径转成字符串 "null" 后一路写进画像。
 * 这里和 python 侧 `judge.commit` 各挡一道(写入端防御,不靠上游干净)。
 */
export function cleanName (name) {
  if (name === null || name === undefined) return ''
  const s = String(name).trim()
  if (s === '') return ''
  if (['null', 'undefined', 'none', 'nil', 'n/a', '无', '未提供'].includes(s.toLowerCase())) return ''
  return s.slice(0, 32)
}

function safeJsonArray (raw) {
  const s = String(raw ?? '').trim()
  if (s === '') return []
  try {
    const v = JSON.parse(s)
    if (Array.isArray(v)) return v.filter(k => typeof k === 'string' && k)
    return []
  } catch {
    // 兼容 AstrBot v5.x 旧格式(逗号拼接):Python 版 json.loads 失败时
    // 静默回落空数组,26 条老记忆的关键词就此丢失 —— DSH 侧修复此坑
    return s.split(/[,，、]/).map(k => k.trim()).filter(k => k.length > 0)
  }
}

function safeJsonObject (raw) {
  try {
    const v = JSON.parse(raw || '{}')
    return (v && typeof v === 'object' && !Array.isArray(v)) ? v : null
  } catch { return null }
}

/** 审计保留条数:钳到 [20, 5000](A 侧 200,本仓定案 100)。 */
function clampAuditKeep (keep) {
  const n = Math.round(Number(keep))
  if (!Number.isFinite(n)) return 100
  return Math.max(20, Math.min(5000, n))
}

/** 手动操作审计的 traceId 序号:audit_logs 的 trace_id 是主键且写入
 *  走 INSERT OR REPLACE —— 时间戳当 id 在同一毫秒内会撞车,后写
 *  覆盖前写(审计行静默丢失,v0.8.0 的真实 bug,测试时序运气掩盖
 *  过)。进程内单调序号保证唯一。 */
let manualAuditSeq = 0
function manualTraceId (id) {
  manualAuditSeq += 1
  return 'manual-' + id + '-' + manualAuditSeq.toString(36) + '-' + Date.now().toString(36)
}

function clip (text, max) {
  const s = String(text || '')
  return s.length > max ? s.slice(0, max) : s
}
