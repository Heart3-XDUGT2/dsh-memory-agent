# -*- coding: utf-8 -*-
"""写入侧去噪闸门(R1–R6)—— 阶段 1a 规则本体 + 阶段 1b 接线。

状态(2026-10-01)
--------------------------------------------------------------------------
* **1a(已完成)**：规则本体 = 纯函数：进候选边 + 上下文,出裁决。
* **1b(本文件)**：接线**只有一处** —— `python/worker.py` 的 `graph_learn`
  写边路径里一个**受开关保护**的调用(`maybe_gate_shadow_edges`)：
  * 开关 = **两路 OR**(**默认关**,见 `gate_enabled()`):① 环境变量
    `ECHO_GRAPH_GATE`(**优先**,但它改一次要重启宿主);② 插件设置文件
    `$DSH_HOME/echo/config.json` 顶层 `graphShadowEdges` —— **网页面板拨的那一路,
    每帧现读文件 ⇒ 拨一下下一帧就生效**(不重启、不热重载);
  * **只管影子边 kinds**(`cooccur_same_memory` / `cooccur_same_day` /
    `temporal`);非影子边候选一律**忽略**(只计数,不裁、不写)⇒ 事实边路径
    (`graph.learn` 直接写的那批三元组)**绝不经过闸门**;
  * 关掉时:`maybe_gate_shadow_edges` **连库都不读**,直接返回 ⇒ 与现状逐位一致。
* **真值回执**(1b 裁决:新表):落 `graph_edge_receipts`,表由 `db.py` 的迁移
  机制 `CREATE TABLE IF NOT EXISTS` 建(纯增)。每次丢边 / 改边 / 表外放行留一行,
  可 SQL 查(不落 JSONL、不改 `audit_logs`、不塞 `tool_call` 文本)。
* **失败策略(硬要求)**:能改则改、不能改则丢边、**绝不拒写入主流程**。
  本模块**不抛异常打断写入** —— 任何内部异常都降级成 `drop` + `reason`,
  调用方(写入路径)永远只拿到一个裁决字典。

候选边口径(与 `scripts/graph-baseline.mjs` 文件头的 14 字段契约同源)
--------------------------------------------------------------------------
必需/常见字段::

    kind                 'cooccur_same_memory' | 'cooccur_same_day' | 'temporal'
                         | 'fact'(空串 = 事实边,与既有 23 条活跃边同义)
    source_id/target_id  共现 = graph_nodes.node_id;时间 = memory_id(裸值)
    source_kind/target_kind  'node'(共现) | 'memory'(时间)
    source_name/target_name  **可选**:端点名(过 R3 别名归一要用;只给 id 也行)
    source_type/target_type  **可选**:端点类型(节点表快照里查不到时的兜底声明)
    evidence_memory_id   支撑该边的 memory_id 列表
    speaker_node_excluded 命中 R1 的标记(graph-baseline 导出时已置位 ⇒ 直接采信)
    occurred_at / occurred_at_source  时间值 / 来源('episodic_memory' 才算数,见 R6)
    relation             事实边的谓词;影子边的谓词由 R5 钉成保留名

上下文(`build_context()` 归一化后的形状):节点表快照(by_id / by_name)、
`graph_aliases`(alias → canonical)、说话人集合、既有活跃槽位集合
(`source_id||'|'||relation`)、person 名单、是否严格解析端点。

返回值(单条裁决,**恰好这四个键**)
--------------------------------------------------------------------------
``{"accepted": bool, "edge": <改正后的边|None>, "action": "accept"|"rewrite"|"drop",
   "reason": None|"speaker-node"|"zero-overlap"|"alias-missing-canonical"
             |"bad-endpoint-type"|"bad-direction"|"no-occurred-at"
             |"slot-conflict"|"internal-error"}``

`drop` 时 `edge = None`(照 `PLAN_MEMORY_GRAPH_ACTION.md` §2③ 的 `candidate|None`)。

**reason 枚举的单一出处 = `REASON_ENUM`**(1b 裁决③):任务给的最小六码
(`speaker-node` / `zero-overlap` / `alias-missing-canonical` / `bad-endpoint-type`
/ `bad-direction` / `no-occurred-at`)+ 两个**已批准的扩展码** `slot-conflict`
(R5 槽位隔离,§1③ 的报表字段里本来就有它)与 `internal-error`(异常降级码 ——
"异常一律视为 drop 并留 reason"需要它)。规则表里的 `reason` 必须是它的子集
(单测钉住:`test_reason_enum_is_single_source`)。
"""
from __future__ import annotations

import json
import os
import sys
import time
import traceback
import uuid

from . import cooc as cooc_mod
from . import relations as relations_mod  # P3-c:类型规则 / 默认谓词走它的数据覆盖读点

# ═══════════════════════════════════════════════════════════════════════
# 开关(1b:写入路径的调用受它保护,**默认关**)
# ═══════════════════════════════════════════════════════════════════════

#: 环境变量名。只有它为真值时写入侧的影子边闸门才生效 —— 不改 config、
#: 不重启 host(`os.environ` 每帧现读,开着才读库)。
#: ⚠️ 2026-10-01 阶段 4:它现在是**两路 OR 的第一路**(env 优先),第二路是
#: 插件设置文件里的 `graphShadowEdges`(见 `switch_config_path()`)。单靠 env
#: 仍然要重启宿主才改得动,所以面板那条路才是"拨了立即生效"的那条。
SWITCH_ENV = "ECHO_GRAPH_GATE"

#: 插件设置文件(`$DSH_HOME/echo/config.json`)里的键名。
#: **必须与 `lib/graph-gate.js` 的 `GRAPH_GATE_CONFIG_KEY` 同一个字符串**
#: (那边是单一出处,这边是引擎侧的镜像常量 —— 两侧各一份是语言边界,
#: 但字符串只此一种写法,单测两边都钉)。
SWITCH_CONFIG_KEY = "graphShadowEdges"

#: 把设置文件指到别处(夹具 / 单测用)。不设 ⇒ 按 `DSH_HOME` 推。
SWITCH_CONFIG_PATH_ENV = "ECHO_GRAPH_GATE_CONFIG"

#: 硬默认:关。`gate_edge()` 不带 `enabled=True` 时**原样放行**,
#: 连"改正"都不做 ⇒ 关掉时与现状**逐位一致**(零行为变化)。
DEFAULT_ENABLED = False


def _env_raw(env=None):
    """取开关读数:env 给映射就按映射,给裸值就用裸值,不给就读 `os.environ`。"""
    if env is None:
        return os.environ.get(SWITCH_ENV, "")
    if hasattr(env, "get"):
        return env.get(SWITCH_ENV, "")
    return env


def _truthy(raw) -> bool:
    """真值口径:`1` / `true` / `on` / `yes`(大小写无关)。"""
    return str(raw or "").strip().lower() in ("1", "true", "on", "yes")


def switch_config_path(env=None) -> str:
    """插件设置文件路径。

    推法与壳侧 `lib/persona.js:19` **同一份**:`$DSH_HOME ?? ~/.dsh` + `/echo/config.json`
    —— 面板(POST)与引擎(每帧判定)读的必须是**同一个文件**,否则"拨了立即生效"
    就成了两回事。`ECHO_GRAPH_GATE_CONFIG` 可以把路径钉到别处(单测/夹具用)。
    """
    mapping = os.environ if env is None else env
    if hasattr(mapping, "get"):
        override = str(mapping.get(SWITCH_CONFIG_PATH_ENV, "") or "").strip()
        if override:
            return override
        home = str(mapping.get("DSH_HOME", "") or "").strip()
    else:
        home = ""
    base = home if home else os.path.join(os.path.expanduser("~"), ".dsh")
    return os.path.join(base, "echo", "config.json")


def config_flag_enabled(env=None, *, path=None) -> bool:
    """插件设置文件读数:`graphShadowEdges` **严格等于 `True`** 才算开。

    never-throw:文件缺失 / 坏 JSON / 不是对象 / 值写成 `"true"` 字符串
    ⇒ 一律按**关**(与壳侧 `graphGateEnabledFromConfig` 的 `=== true` 同一口径;
    也保证"文件里写了点什么"和"它真的开着"不会读出两个答案)。
    """
    target = path or switch_config_path(env)
    try:
        with open(target, "r", encoding="utf-8") as fh:
            raw = json.load(fh)
    except Exception:
        return False
    if not isinstance(raw, dict):
        return False
    return raw.get(SWITCH_CONFIG_KEY) is True


def gate_enabled(env=None, *, config=None, config_path=None) -> bool:
    """写入侧闸门开不开。**默认关**:两路 OR —— `env ∨ 插件设置文件`。

    * **env 优先**,而且 env 为真时**连文件都不读**(`=1` 不可能被配置层顶掉);
    * env 没开才看文件(面板开关写在 `$DSH_HOME/echo/config.json`);
    * `config` 给了就用它(测试注入:映射 / 裸值),不给才去读文件;
    * 两路都缺 ⇒ 关(**与阶段 1b 的改动前逐位相同**)。

    ⚠️ 文件路径**不缓存**:每帧现读 ⇒ 面板拨一下,下一帧判定就是新的
    (这就是"立即生效"的全部机制,不靠重启、不靠热重载)。
    """
    if _truthy(_env_raw(env)):
        return True
    if config is None:
        return config_flag_enabled(env, path=config_path)
    if hasattr(config, "get"):
        return config.get(SWITCH_CONFIG_KEY) is True
    return config is True


def gate_source(env=None, *, config=None, config_path=None) -> dict:
    """面板/日志要的完整读数:`{on, source, env, config}`(判据仍只有 `gate_enabled` 一处)。

    `source` 只用于留痕,不参与判定 —— 与壳侧 `graphGateSourceReport` 逐字同形,
    人话映射在壳侧(那边要发给网页)。
    """
    env_on = _truthy(_env_raw(env))
    if config is None:
        cfg_on = config_flag_enabled(env, path=config_path)
    elif hasattr(config, "get"):
        cfg_on = config.get(SWITCH_CONFIG_KEY) is True
    else:
        cfg_on = config is True
    if env_on:
        source = "env:" + SWITCH_ENV
    elif cfg_on:
        source = "settings:" + SWITCH_CONFIG_KEY
    else:
        source = "off"
    return {"on": bool(env_on or cfg_on), "source": source,
            "env": bool(env_on), "config": bool(cfg_on)}

# ═══════════════════════════════════════════════════════════════════════
# R1:说话人 / 人格节点
# ═══════════════════════════════════════════════════════════════════════

#: 这几个名字节点"人人都在场",一旦做共现端点就把图灌满噪声
#: (本仓实测:同记忆共现 30 条 → 去掉说话人后只剩 5 条,噪声占 5/6)。
#:
#: ★ P1c(2026-10-05):名字**不在代码里**了。壳侧每帧现读 `<数据目录>/names.json`
#: 随帧下发 `frame["names"] = {"speakers": [...], "personNames": [...]}`,
#: 经 `names_from_frame()` 取出来传给 `build_context(speakers=…)`。
#: 帧里没有(老壳 / 离线 CLI / 新装空文件)⇒ **空集合 = 谁也不当说话人**
#: (设计文档 §5.2 第 8 项:"空 ⇒ `speakers=∅`")—— 一律**不回落**到内置真名。
SPEAKER_NODES = frozenset()


def names_from_frame(frame) -> tuple:
    """从引擎帧里取名字集合(壳侧 `names.json` 经帧下发)。返回 `(speakers, person_names)`。

    帧的形状 = `frame["names"] = {"speakers": [...], "personNames": [...]}`。
    解析口径见 `names_from_obj()`;帧里没有 ⇒ `([], [])`(空集合口径,不回落内置表)。
    """
    if not isinstance(frame, dict):
        return [], []
    return names_from_obj(frame.get("names"))


def names_from_obj(names) -> tuple:
    """从 `names.json` 形状的对象里取 `(speakers, person_names)`。

    never-throw:不是对象 / 字段不是列表 / 元素不是字符串 ⇒ 该半边为**空列表**
    ("没有名字"这个口径),绝不让一份坏配置把写入主流程带崩。
    逗号分隔的字符串也认(`"a,b"` ⇒ `["a","b"]`,手写配置的常见形态)。
    """
    if not isinstance(names, dict):
        return [], []

    def _list(*keys):
        for key in keys:
            raw = names.get(key)
            if isinstance(raw, list):
                return [_text(x) for x in raw if _text(x)]
            if isinstance(raw, str):
                return [_text(x) for x in raw.split(",") if _text(x)]
        return []

    return _list("speakers"), _list("personNames", "person_names")


def owner_names_from_obj(names) -> list:
    """从 `names.json` 形状的对象里取**自节点名**(`ownerNames`)——P1c 拍板新增的一份。

    它只喂 `l0_tier.OWNER_NODE_NAMES`(身份事实的主语只可能是他)。**不**复用
    `speakers`(含「她 / Echo / 助手」:她的自述边不该进他的 L0)或 `personNames`
    (含「妹妹 / 姐姐 / 弟弟 / 朋友 / NPC」:别人的身份事实不该进他的 L0)。
    空 / 缺 / 坏形状 ⇒ `[]`(engine 侧只剩角色槽「用户」兜着,宁少不错)。
    """
    return _owner_list(names)


def owner_names_from_frame(frame) -> list:
    """从引擎帧里取自节点名(帧形状 `frame["names"] = {…, "ownerNames": [...]}`)。"""
    if not isinstance(frame, dict):
        return []
    return _owner_list(frame.get("names"))


def _owner_list(names) -> list:
    """`names` 对象里的 `ownerNames`(数组或逗号串);不是对象 ⇒ `[]`。"""
    if not isinstance(names, dict):
        return []
    raw = names.get("ownerNames")
    if isinstance(raw, list):
        return [_text(x) for x in raw if _text(x)]
    if isinstance(raw, str):
        return [_text(x) for x in raw.split(",") if _text(x)]
    return []


def data_from_frame(frame) -> dict:
    """从引擎帧里取**数据块**(P3-a:壳侧 `lib/data-tables.js::frameData()` 经帧下发)。

    帧形状 = `frame["data"] = {"version": 1, "graph": {...}, "lexicon": {...},
    "stateDefaults": {...}}`;返回同一形状(只保留认得的三个段)。

    never-throw:不是 dict / 没有 `data` / 版本位不是整数 / 段不是对象 ⇒ 该段(或整块)
    **当成没给** —— 各消费点一律"没有 ⇒ 空/默认且不抛"(与 `names_from_frame` 同姿势,
    见 `python/tests/test_graph_gate.py:2278` 一带的既有风格)。壳/引擎版本错配时
    最坏结果是"这次引擎调用没带上配置",绝不让一份坏帧把写入主流程带崩。
    """
    if not isinstance(frame, dict):
        return {}
    raw = frame.get("data")
    if not isinstance(raw, dict):
        return {}
    ver = raw.get("version")
    if ver is not None and (isinstance(ver, bool) or not isinstance(ver, int)):
        return {}
    out = {"version": ver if isinstance(ver, int) else 0}
    for key in ("graph", "lexicon", "stateDefaults"):
        seg = raw.get(key)
        if isinstance(seg, dict):
            out[key] = seg
    return out

# ═══════════════════════════════════════════════════════════════════════
# kind 取值域(R5 的"独立维度")
# ═══════════════════════════════════════════════════════════════════════

KIND_FACT = "fact"
KIND_COOCCUR_SAME_MEMORY = "cooccur_same_memory"
KIND_COOCCUR_SAME_DAY = "cooccur_same_day"
KIND_TEMPORAL = "temporal"

#: 该用哪种"同一处"判据(阶段 3a 第二步裁决①):`same_memory` = 交集非空;
#: `same_day` = 两端各自证据非空(跨记忆同天对没有共同记忆)。
EVIDENCE_SCOPE_SAME_MEMORY = "same_memory"
EVIDENCE_SCOPE_SAME_DAY = "same_day"
EVIDENCE_SCOPES = (EVIDENCE_SCOPE_SAME_MEMORY, EVIDENCE_SCOPE_SAME_DAY)

#: **影子边的归属键**(阶段 3a 第二步裁决·卡口 1,**方案 A**)。单一出处,别散在字符串里。
#:
#: 为什么不用调用方的 `owner_key`:影子边与事实边同 owner 就会**进检索**
#: (`worker.py` 的 `graph_query` 走 `graph.load(conn, owner)` → `graph_activate` →
#: 人格注入)。实测(快照副本,47 条影子边):`load('master')` 边 42 → 89,
#: 指纹 `08316c3bebb597c8` → `334c7662812ccc70` —— 违反"影子边只写不接读"。
#: 换成本常量后:`load('master')` 指纹**逐位不变**,影子边在 `load('__shadow__')`
#: 名下自成一套(检索 / L0 治理 / 谓词归并都按 owner 走,天然看不见它)。
SHADOW_OWNER = "__shadow__"

#: 影子边(只写不接读),阶段 3a / 3b 的产物。
SHADOW_KINDS = (KIND_COOCCUR_SAME_MEMORY, KIND_COOCCUR_SAME_DAY, KIND_TEMPORAL)
COOCCUR_KINDS = (KIND_COOCCUR_SAME_MEMORY, KIND_COOCCUR_SAME_DAY)
KNOWN_KINDS = (KIND_FACT,) + SHADOW_KINDS

#: **影子边落在哪张表**(阶段 3a 路线 2,2026-10-01 人类裁决)。单一出处。
#:
#: 为什么另立表(不留在 `graph_edges` 靠 owner/kind 区分):`graph_edges` 的读口
#: **只按 owner_key 过滤**(实测 19 处读点里 13 处如此)⇒ 影子边与事实边同表时,
#: 任何"忘了加 kind 过滤"的新读口都泄漏(真写库时 `top_nodes()` 与
#: `store.topEntityNames(20)` 被抓个正着,`音理` 第 7 → 第 2)。
#: 换表之后**现有读路径一个字不改**就零泄漏 —— 泄漏面从"纪律"变成"结构"。
SHADOW_TABLE = "graph_shadow_edges"

#: v2-A4(2026-10-01):共现的落点从影子表**换成证据层**(一行 = 一条证据,不铺 pair 边)。
#: 表名/视图名的单一出处 = `engine/cooc.py`;这里只是转出来给读的人看。
EVIDENCE_TABLE = cooc_mod.EVIDENCE_TABLE
EVIDENCE_OWNER = cooc_mod.COOC_OWNER

#: 回执里记"这条路线"(便于新旧几版对账):
#: * **新写** = `cooc-evidence`(v2-A4 起:落进证据层);
#: * 历史留痕仍是 `shadow-table`(路线 2 那 77+ 行回执,别拿新版标记去认它们)。
#: 两个字符串都只此一种写法,单测两边都钉。
WRITE_ROUTE = "cooc-evidence"
WRITE_ROUTE_HISTORICAL = "shadow-table"

#: 写入侧认的**时间来源白名单**(阶段 1b 裁决 C,2026-10-01)。
#:
#: * `episodic_memory` —— 事情**发生**的时间,来自情景记忆(唯一"亲历"来源);
#: * `same_day_group`  —— 同天边的"**那一天**"(本地 00:00 的 epoch 秒):日粒度天然
#:   知道是哪天,契约 v1.1 明确同天边不取记忆时间戳、恒这个来源;
#: * **`fallback_learned_at` 不进** —— 那是**导出侧**"拿 learned_at 兜底"的标注
#:   (系统时间,语义是"我们得知的时间",不是发生时间);写入侧不许认它当发生时间。
#: * `null` / 表外值一律不认(不猜)。
TIME_SOURCE_EPISODIC = "episodic_memory"
TIME_SOURCE_SAME_DAY = "same_day_group"
TIME_SOURCES_ALLOWED = frozenset({TIME_SOURCE_EPISODIC, TIME_SOURCE_SAME_DAY})

# ═══════════════════════════════════════════════════════════════════════
# R5:槽位隔离
# ═══════════════════════════════════════════════════════════════════════
#
# 事实边的槽位是 `slot = source_id || '|' || relation`(`db.py:14` 的回填口径、
# `graph.py:331` 与 `:404-410` 的"让位"逻辑都认它)。新边要**不与既有边争槽位**,
# 只能换维度:影子边走**保留谓词名**(下表),它们的槽位天然落在事实边命名空间之外
# ⇒ 不会触发 `graph.py:404-410` 的让位,也不会撞
# `UNIQUE(source_id, target_id, relation, owner_key)`。

SHADOW_RELATIONS = {
    KIND_COOCCUR_SAME_MEMORY: "共现",
    KIND_COOCCUR_SAME_DAY: "同日共现",
    KIND_TEMPORAL: "时间相邻",
}
RESERVED_RELATIONS = frozenset(SHADOW_RELATIONS.values())

#: 与 `graph.add_edge` 的谓词兜底一致(`graph.py:315`)。
#:
#: ★ P3-c:本常量是**内置兜底**;`graph.json.relations.defaultRelation` 给了就用数据
#: (空 ⇒ 回它 = 迁移前行为)。取值只留一个口:`default_relation()`
#: (`graph.py:315` 那份同值副本不在本批名单内)。
FACT_DEFAULT_RELATION = "相关"

# ═══════════════════════════════════════════════════════════════════════
# R4:端点类型 / 方向约束表(**本模块自定**,思路参照 graph-memory
# `src/extractor/extract.ts:17-32` 的两张 Set + `correctEdgeType()` —— 只作参照,
# 不 vendor,也不跨语言搬代码)
# ═══════════════════════════════════════════════════════════════════════

NODE_TYPE_CONCEPT = "concept"
NODE_TYPE_PERSON = "person"
NODE_TYPE_EPISODE = "episode"
#: `belief`:1b 裁决⑤ 加进来的 —— `lib/soul-snapshot.js:38` 早就在查
#: `node_type = 'belief'`(活在查询里、却不在书写侧取值域里,等于 schema 又一处
#: "写了等于没写")。全仓读 `node_type` 的地方见报告 ⑤,实际取值集合 =
#: `concept`(默认)+ `person`(`graph.py:422`/`:980`)+ `belief`(`soul-snapshot.js:38`)
#: + 本模块写入用的 `episode`(3b 的端点)。
#: 与 `graph.get_or_create_node(node_type=...)` 手工对齐(**不互相 import**);
#: 未知取值一律落回 `concept`(保守,且与既有 28 节点的默认值一致)。
NODE_TYPE_BELIEF = "belief"
NODE_TYPES = (NODE_TYPE_CONCEPT, NODE_TYPE_PERSON, NODE_TYPE_EPISODE, NODE_TYPE_BELIEF)
DEFAULT_NODE_TYPE = NODE_TYPE_CONCEPT

#: 谓词 → 合法(源类型, 目标类型)**有序**组合表。表内谓词:
#:   · 目标顺序命中 ⇒ 放行;
#:   · 反序命中   ⇒ R4 自动改正(交换两端),`bad-direction`;
#:   · 两个方向都不命中 ⇒ 丢边,`bad-endpoint-type`。
#: 表外谓词 ⇒ **不猜**(白名单式放行),只受 kind 级类型约束。
#: `person` 的判定见 `_node_type_of`:既认 `node_type='person'`,也认"名字在
#: person 名单里"(既有 28 个节点的 `node_type` 全是 `concept`,但 `用户` 语义上
#: 就是 person —— 否则 `用户 -[就读于]-> 学校` 这条真边会被误判成非法)。
RELATION_TYPE_RULES = {
    "就读于": [("person", "concept")],
    "读于": [("person", "concept")],
    "参加": [("person", "concept")],
    "会学": [("person", "concept")],
    "在意": [("person", "concept")],
    "负责": [("person", "concept")],
    "希望打造": [("person", "concept")],
    "喜欢": [("person", "concept")],
    "想念": [("person", "concept")],
    "是老玩家": [("person", "concept")],
    "有校园跑要求": [("person", "concept")],
    "相关": [("concept", "concept"), ("person", "concept")],
}


def relation_type_rules():
    """当前生效的端点类型 / 方向约束表(数据优先,空 ⇒ 内置 `RELATION_TYPE_RULES`)。

    为什么经 `relations` 取:worker 每帧只对 `relations / timeintent / judge` 三个模块调
    `configure_from_data()`(`python/worker.py:136-141`)⇒ 帧里的
    `graph.json.relations.typeRules` 只有 `relations` 手里有。**解析只做一遍**
    (`relations._type_rules`),这里只接自己那张内置表兜底 —— 两边各写一份就又长出第二张表了。
    """
    return relations_mod.type_rules_data() or RELATION_TYPE_RULES


def default_relation():
    """事实边默认谓词(数据优先,空 ⇒ 内置 `FACT_DEFAULT_RELATION`)。同上,兜底在本模块。"""
    return relations_mod.default_relation_data() or FACT_DEFAULT_RELATION

# ═══════════════════════════════════════════════════════════════════════
# reason 枚举(**唯一出处** —— 丢了/改了都要能对账,禁止静默跳过)
# ═══════════════════════════════════════════════════════════════════════

REASON_SPEAKER_NODE = "speaker-node"
REASON_ZERO_OVERLAP = "zero-overlap"
REASON_ALIAS_MISSING_CANONICAL = "alias-missing-canonical"
REASON_BAD_ENDPOINT_TYPE = "bad-endpoint-type"
REASON_BAD_DIRECTION = "bad-direction"
REASON_NO_OCCURRED_AT = "no-occurred-at"
#: 扩展码(1b 裁决③ 已批准):R5 的槽位冲突 / 异常降级。
REASON_SLOT_CONFLICT = "slot-conflict"
REASON_INTERNAL_ERROR = "internal-error"
#: v2-A1 扩展码(2026-10-01 他批准):`restore` = 并列回补把边/记忆复位;
#: `multivalue-slot-collision` = 该回补的**成因**(多值关系下被同槽顶掉)。
REASON_RESTORE = "restore"
REASON_MULTIVALUE_SLOT_COLLISION = "multivalue-slot-collision"

#: **reason 的唯一出处**:任何地方要用 reason 码,都从这里取 / 往这里登记。
#: (`REASONS` 是历史别名,1b 起以 `REASON_ENUM` 为准。)
REASON_ENUM = (
    REASON_SPEAKER_NODE,
    REASON_ZERO_OVERLAP,
    REASON_ALIAS_MISSING_CANONICAL,
    REASON_BAD_ENDPOINT_TYPE,
    REASON_BAD_DIRECTION,
    REASON_NO_OCCURRED_AT,
    REASON_SLOT_CONFLICT,
    REASON_INTERNAL_ERROR,
    REASON_RESTORE,
    REASON_MULTIVALUE_SLOT_COLLISION,
)
REASONS = REASON_ENUM

#: 回执里的"留痕标记"(不是 reason —— 表外放行是 accept,不是丢边)。
NOTE_RULE_TABLE_MISS = "rule-table-miss"

ACTIONS = ("accept", "rewrite", "drop")

# ═══════════════════════════════════════════════════════════════════════
# 规则表(可追加的数据表 —— 加规则只加一行 + 一个函数,不改既有语义)
# ═══════════════════════════════════════════════════════════════════════
#
# 求值顺序 = `order` 升序。**R3 必须排在 R1/R4 前面**:别名归一之后端点名才是
# 规范名,拿别名串去判"是不是说话人节点/类型合不合法"会判错(R3 的定义就是这么
# 写的:"改写为规范名后再判 R1/R4")。

RULES = (
    {"rule_id": "R3", "order": 10, "action": "rewrite", "enabled": True,
     "reason": REASON_ALIAS_MISSING_CANONICAL,
     "what": "别名归一:端点先过 graph_aliases;规范名不存在 ⇒ 丢边"},
    {"rule_id": "R1", "order": 20, "action": "drop", "enabled": True,
     "reason": REASON_SPEAKER_NODE,
     "what": "说话人 / 人格节点不得成为共现边端点"},
    {"rule_id": "R4", "order": 30, "action": "drop", "enabled": True,
     "reason": REASON_BAD_ENDPOINT_TYPE,
     "what": "端点类型非法 ⇒ 丢边;方向违约 ⇒ 自动改正(改不了则丢)"},
    {"rule_id": "R5", "order": 40, "action": "rewrite", "enabled": True,
     "reason": REASON_SLOT_CONFLICT,
     "what": "槽位隔离:新边走独立 kind 维度 + 保留谓词名,不挤事实边槽位"},
    {"rule_id": "R2", "order": 50, "action": "drop", "enabled": True,
     "reason": REASON_ZERO_OVERLAP,
     "what": "零重合不得注入(不得做成检索层阈值拒答 —— C10)"},
    {"rule_id": "R6", "order": 60, "action": "drop", "enabled": True,
     "reason": REASON_NO_OCCURRED_AT,
     "what": "时间边必须有 occurred_at,且只认 episodic_memory 来源"},
)


# ═══════════════════════════════════════════════════════════════════════
# 工具
# ═══════════════════════════════════════════════════════════════════════

def _fold(value) -> str:
    """比较用的名字折叠(去空白 + casefold)。"""
    return str(value if value is not None else "").strip().casefold()


def _text(value) -> str:
    return str(value if value is not None else "").strip()


def is_speaker_name(name, speakers=None) -> bool:
    """是不是说话人 / 人格节点名(精确或大小写差异都算)。"""
    folded = _fold(name)
    if not folded:
        return False
    pool = SPEAKER_NODES if speakers is None else speakers
    return folded in {_fold(s) for s in pool}


def _iter_node_records(nodes):
    """把"节点表快照"的几种常见形状归一成 dict 流。

    接受:None / {name: 'concept'} / {name: {node_id, node_type}} /
    可迭代的 dict 或 sqlite 行(`node_id, name, node_type, ...` 位置口径)。
    """
    if not nodes:
        return
    if isinstance(nodes, dict):
        for name, value in nodes.items():
            if isinstance(value, dict):
                rec = dict(value)
                rec.setdefault("name", name)
                yield rec
            else:
                yield {"name": name, "node_type": value}
        return
    for item in nodes:
        if isinstance(item, dict):
            yield dict(item)
        elif isinstance(item, (list, tuple)) and len(item) >= 2:
            rec = {"node_id": item[0], "name": item[1]}
            if len(item) >= 3:
                rec["node_type"] = item[2]
            yield rec


def _iter_alias_pairs(aliases):
    if not aliases:
        return
    if isinstance(aliases, dict):
        for alias, canon in aliases.items():
            yield alias, canon
        return
    for item in aliases:
        if isinstance(item, (list, tuple)) and len(item) >= 2:
            yield item[0], item[1]


def build_context(nodes=None, aliases=None, *, speakers=None,
                  existing_fact_slots=(), person_names=None,
                  strict_node_resolution=False) -> dict:
    """归一化上下文(纯函数,不碰库)。

    :param nodes: 节点表快照(`SELECT node_id, name, node_type FROM graph_nodes`)
    :param aliases: `graph_aliases` 快照(`alias → canonical_name`)
    :param speakers: 说话人集合;缺省 = `SPEAKER_NODES`(P1c 起是**空集合**:名字只能由
        壳侧的 `names.json` 经帧下发传进来,代码里不留真名)
    :param existing_fact_slots: 既有**事实边**的 `source_id||'|'||relation`
    :param person_names: 语义上算 person 的名字(R4 的方向判定用);缺省 = 说话人 + 他的称呼
    :param strict_node_resolution: **写入侧口径(1b 裁决②)默认 False**:只有
        "**名字本身是别名键**、而它的 canonical 不在节点表里"才 drop(那是真·规范名
        缺失);**真正的新概念名允许放行**(它正要被建节点 —— 严格模式会把我们要建
        的东西先杀掉)。置 True 退回 `graph-baseline.mjs` 的测算口径(端点解析不到
        就 `alias-missing-canonical`),只给离线测算用。
    """
    by_name, by_id = {}, {}
    for rec in _iter_node_records(nodes):
        name = _text(rec.get("name"))
        node_id = _text(rec.get("node_id"))
        node_type = _text(rec.get("node_type")) or DEFAULT_NODE_TYPE
        item = {"node_id": node_id, "name": name, "node_type": node_type}
        if name:
            by_name[name] = item
        if node_id:
            by_id[node_id] = item
    alias_map = {}
    for alias, canon in _iter_alias_pairs(aliases):
        alias_key, canon_name = _text(alias), _text(canon)
        if alias_key and canon_name:
            alias_map[alias_key] = canon_name
    if speakers is None:
        speaker_set = frozenset(SPEAKER_NODES)
    else:
        speaker_set = frozenset(_text(s) for s in speakers if _text(s))
    if person_names is None:
        # P1c:不再内置真名。不变量:**说话人一定算人**(person ⊇ speakers),
        # 否则去掉说话人那一步就白做了(共现噪声会猛增)。
        person_set = frozenset(speaker_set)
    else:
        person_set = frozenset(speaker_set | {_text(p) for p in person_names if _text(p)})
    return {
        "by_name": by_name,
        "by_id": by_id,
        "aliases": alias_map,
        "speakers": speaker_set,
        "person_names": person_set,
        "existing_fact_slots": {_text(s) for s in existing_fact_slots if _text(s)},
        "strict_node_resolution": bool(strict_node_resolution),
    }


EMPTY_CONTEXT = build_context()


def _kind_of(edge) -> str:
    """空串 / 缺省 = 事实边(与既有 23 条活跃边同义)。"""
    raw = _text((edge or {}).get("kind"))
    return KIND_FACT if raw == "" else raw


def _endpoint(edge, side, ctx) -> dict:
    """解析一端:`{id, name, kind, type, resolved}`。"""
    node_id = _text(edge.get(side + "_id"))
    name = _text(edge.get(side + "_name"))
    declared_kind = _text(edge.get(side + "_kind")).lower() or _text(edge.get("endpoint_kind")).lower()
    item = ctx["by_id"].get(node_id) if node_id else None
    if item is not None and not name:
        name = item["name"]
    if item is None and name:
        item = ctx["by_name"].get(name)
    # 端点是"记忆"还是"节点":声明优先;没声明就按 kind 推(时间边端点是记忆)。
    default_kind = "memory" if _kind_of(edge) == KIND_TEMPORAL else "node"
    kind = declared_kind or default_kind
    if kind == "memory":
        return {"id": node_id, "name": name, "kind": "memory",
                "type": NODE_TYPE_EPISODE, "resolved": True}
    resolved = item is not None
    node_type = _text(edge.get(side + "_type")) or DEFAULT_NODE_TYPE
    if item is not None:
        node_type = item["node_type"]
    if is_speaker_name(name, ctx["speakers"]) or _fold(name) in {_fold(p) for p in ctx["person_names"]}:
        node_type = NODE_TYPE_PERSON
    return {"id": node_id, "name": name, "kind": "node",
            "type": node_type, "resolved": resolved}


def _swap_endpoints(edge) -> dict:
    """交换两端(R4 方向自动改正用)。`endpoint_kind` 两端同值,不用动。"""
    fixed = dict(edge)
    for left, right in (("source_id", "target_id"), ("source_name", "target_name"),
                        ("source_type", "target_type"), ("source_kind", "target_kind")):
        a, b = edge.get(left), edge.get(right)
        if b is None:
            fixed.pop(left, None)
        else:
            fixed[left] = b
        if a is None:
            fixed.pop(right, None)
        else:
            fixed[right] = a
    return fixed


def _evidence_ids(edge):
    raw = edge.get("evidence_memory_id")
    if raw is None or raw == "":
        return []
    if isinstance(raw, (list, tuple, set)):
        items = list(raw)
    else:
        items = [raw]
    return [_text(x) for x in items if _text(x)]


# ═══════════════════════════════════════════════════════════════════════
# R1–R6 本体(每个函数:入 (edge, ctx, kind),出 (action, edge|None, reason|None))
# ═══════════════════════════════════════════════════════════════════════

def _rule_r3(edge, ctx, kind):
    """R3 别名归一。能归一则 `rewrite`;规范名不存在 ⇒ `drop`。

    1b 裁决②(写入侧口径):**只有两种** drop 情形 ——
      ① 名字**本身是别名键**(`graph_aliases` 里有它),但它的 canonical 不在
         节点表里 ⇒ 规范名真缺失,`alias-missing-canonical`;
      ② `strict_node_resolution=True`(离线测算口径)下端点根本解析不到。
    **真正的新概念名**(不是别名键、也不在快照里)**放行** —— 那正是要建的新节点。
    """
    work = edge
    rewritten = False
    strict = ctx["strict_node_resolution"]
    for side in ("source", "target"):
        ep = _endpoint(work, side, ctx)
        if ep["kind"] == "memory":
            continue
        name = ep["name"]
        if not name:
            # 端点是"记忆"以外却没有名字:严格口径丢,写入侧放行(交给建节点)。
            if strict:
                return ("drop", None, REASON_ALIAS_MISSING_CANONICAL)
            continue
        canon = ctx["aliases"].get(name)
        if canon and canon != name:
            item = ctx["by_name"].get(canon)
            if item is None:
                # 别名键在,但规范名不在节点表里 —— 不硬造 node(graph-baseline 同口径)。
                return ("drop", None, REASON_ALIAS_MISSING_CANONICAL)
            if strict and item["node_id"] and item["node_id"] not in ctx["by_id"]:
                return ("drop", None, REASON_ALIAS_MISSING_CANONICAL)
            if not rewritten:
                work = dict(work)
            work[side + "_name"] = canon
            if item["node_id"]:
                work[side + "_id"] = item["node_id"]
            rewritten = True
        elif not ep["resolved"] and name in ctx["aliases"]:
            # 兜底:名字是别名键但归一后没变成规范名(表里指向自己)⇒ 规范名缺失。
            return ("drop", None, REASON_ALIAS_MISSING_CANONICAL)
        elif not ep["resolved"]:
            # 新概念名:写入侧放行(它正要被建出来);离线测算口径仍丢。
            if strict:
                return ("drop", None, REASON_ALIAS_MISSING_CANONICAL)
    if rewritten:
        return ("rewrite", work, None)
    return ("accept", work, None)


def _rule_r1(edge, ctx, kind):
    """R1 说话人 / 人格节点不得成为**共现边**端点。

    只管共现边(COOCCUR_KINDS):`用户 -[就读于]-> 学校` 这类**事实边**端点本来
    就该是说话人节点,拿 R1 去砍会把核事实全砍掉;时间边端点是记忆,R1 也不适用。
    """
    if kind not in COOCCUR_KINDS:
        return ("accept", edge, None)
    if bool(edge.get("speaker_node_excluded")):
        return ("drop", None, REASON_SPEAKER_NODE)
    for side in ("source", "target"):
        ep = _endpoint(edge, side, ctx)
        if ep["kind"] == "memory":
            continue
        if is_speaker_name(ep["name"], ctx["speakers"]):
            return ("drop", None, REASON_SPEAKER_NODE)
        if ep["id"]:
            item = ctx["by_id"].get(ep["id"])
            if item is not None and is_speaker_name(item["name"], ctx["speakers"]):
                return ("drop", None, REASON_SPEAKER_NODE)
    return ("accept", edge, None)


def _rule_r4(edge, ctx, kind):
    """R4 端点类型 / 方向约束表(表见 `relation_type_rules()`,数据优先)。"""
    src = _endpoint(edge, "source", ctx)
    tgt = _endpoint(edge, "target", ctx)

    if kind in COOCCUR_KINDS:
        # 共现边的两端都必须是概念节点(episode / person 端点落这儿就是类型非法)。
        for ep in (src, tgt):
            if ep["type"] != NODE_TYPE_CONCEPT:
                return ("drop", None, REASON_BAD_ENDPOINT_TYPE)
        return ("accept", edge, None)

    if kind == KIND_TEMPORAL:
        # 时间边两端必须是 episode(端点声明成 memory 时按 episode 算)。
        for ep in (src, tgt):
            if ep["kind"] != "memory" and ep["type"] != NODE_TYPE_EPISODE:
                return ("drop", None, REASON_BAD_ENDPOINT_TYPE)
        return ("accept", edge, None)

    # 事实边:episode 节点不得当事实端点(最小 episode 只作时间边端点)。
    if src["type"] == NODE_TYPE_EPISODE or tgt["type"] == NODE_TYPE_EPISODE:
        return ("drop", None, REASON_BAD_ENDPOINT_TYPE)

    rules = relation_type_rules().get(_text(edge.get("relation")))
    if not rules:
        return ("accept", edge, None)   # 表外谓词:不猜,放行
    pair = (src["type"], tgt["type"])
    if pair in rules:
        return ("accept", edge, None)
    if (pair[1], pair[0]) in rules:
        return ("rewrite", _swap_endpoints(edge), REASON_BAD_DIRECTION)
    return ("drop", None, REASON_BAD_ENDPOINT_TYPE)


def _rule_r5(edge, ctx, kind):
    """R5 槽位隔离:影子边走保留谓词名,事实边不许占用保留名。"""
    rel = _text(edge.get("relation"))
    if kind in SHADOW_KINDS:
        want = SHADOW_RELATIONS[kind]
        slot = "%s|%s" % (_text(edge.get("source_id")), want)
        if slot in ctx["existing_fact_slots"]:
            # 保留名已经被事实边占了(理论上不该发生)⇒ 不硬塞,丢边留痕。
            return ("drop", None, REASON_SLOT_CONFLICT)
        if rel != want:
            fixed = dict(edge)
            fixed["relation"] = want
            return ("rewrite", fixed, REASON_SLOT_CONFLICT)
        return ("accept", edge, None)
    if rel in RESERVED_RELATIONS:
        # 事实边占用影子边命名空间 ⇒ 会与影子边争槽位,丢。
        return ("drop", None, REASON_SLOT_CONFLICT)
    if not rel:
        fixed = dict(edge)
        fixed["relation"] = default_relation()
        return ("rewrite", fixed, REASON_SLOT_CONFLICT)
    return ("accept", edge, None)


def _rule_r2(edge, ctx, kind):
    """R2 零重合不得注入:**按谓词取判据**(阶段 3a 第二步裁决①,2026-10-01)。

    R2 必须活着:判据要**对得上"同一处"的定义**,而不是把判据拔掉。

    * `cooccur_same_memory` —— "同一处" = **同一条记忆** ⇒ 两端记忆集**交集非空**;
    * `cooccur_same_day`     —— "同一处" = **那一天** ⇒ 两端**各自的证据都非空**
      (跨记忆的同天对天然没有共同记忆,拿交集判它等于把同天口径整个抹掉);
    * 两端 ids 缺失(老输入 / 手工造的候选)—— 退化成"证据非空",这是**兼容路径**,
      不是设计路径;候选由 `graph_mine` 生产时两侧 ids 必定齐备。

    `evidence_scope` 缺失时按 kind 推(`same_memory` / `same_day`),便于老候选平滑。
    """
    if kind not in COOCCUR_KINDS:
        return ("accept", edge, None)
    scope = _text(edge.get("evidence_scope")) or _default_evidence_scope(kind)
    left = edge.get("source_memory_ids")
    right = edge.get("target_memory_ids")
    if left is not None and right is not None:
        a = {_text(x) for x in (left or []) if _text(x)}
        b = {_text(x) for x in (right or []) if _text(x)}
        if scope == EVIDENCE_SCOPE_SAME_DAY:
            # 同天:两端各自都要有"那天提到它的记忆";两端都空 ⇒ 没有"同一处"
            if not a or not b:
                return ("drop", None, REASON_ZERO_OVERLAP)
            return ("accept", edge, None)
        if not (a & b):
            return ("drop", None, REASON_ZERO_OVERLAP)
        return ("accept", edge, None)
    if not _evidence_ids(edge):
        return ("drop", None, REASON_ZERO_OVERLAP)
    return ("accept", edge, None)


def _default_evidence_scope(kind) -> str:
    """没带 `evidence_scope` 时按 kind 推默认口径(不猜第三种)。"""
    if kind == KIND_COOCCUR_SAME_DAY:
        return EVIDENCE_SCOPE_SAME_DAY
    return EVIDENCE_SCOPE_SAME_MEMORY


def _rule_r6(edge, ctx, kind):
    """R6 无 `occurred_at` 不建时间边;时间来源只认白名单(`TIME_SOURCES_ALLOWED`)。

    图侧 `occurred_at` 是死列(全 0)⇒ 来源不在白名单的一律不认,`fallback_learned_at`
    与 null 同样丢(不猜、不取默认值)。

    阶段 1b 裁决 C:`same_day_group` 加进白名单(同天边的"那一天")。
    ⚠️ 校准记录:R6 **只作用于时间边**(下面第一行就 return),所以共现/同天边本来
    就不经过这里 —— 裁决 C 不改同天边行为,它只是让"时间边若显式声明同天来源"不被误杀。
    """
    if kind != KIND_TEMPORAL:
        return ("accept", edge, None)
    try:
        occurred_at = float(edge.get("occurred_at") or 0.0)
    except (TypeError, ValueError):
        occurred_at = 0.0
    if occurred_at <= 0:
        return ("drop", None, REASON_NO_OCCURRED_AT)
    if _text(edge.get("occurred_at_source")) not in TIME_SOURCES_ALLOWED:
        return ("drop", None, REASON_NO_OCCURRED_AT)
    return ("accept", edge, None)


_RULE_FUNCS = {
    "R1": _rule_r1,
    "R2": _rule_r2,
    "R3": _rule_r3,
    "R4": _rule_r4,
    "R5": _rule_r5,
    "R6": _rule_r6,
}
_ORDERED_RULES = tuple(sorted(RULES, key=lambda r: r["order"]))


def _decide(candidate, ctx):
    """跑完整条规则链。内部形状多一个 `rules`(命中的规则号),对外不暴露。"""
    edge = dict(candidate) if isinstance(candidate, dict) else {}
    kind = _kind_of(edge)
    if kind not in KNOWN_KINDS:
        # 未知 kind 不进图(表驱动:不猜)。归在类型层 reason。
        return {"accepted": False, "edge": None, "action": "drop",
                "reason": REASON_BAD_ENDPOINT_TYPE, "rules": [], "table_miss": False}
    work = edge
    hits = []
    rewrite_reason = None
    for rule in _ORDERED_RULES:
        if not rule.get("enabled", True):
            continue
        action, new_edge, reason = _RULE_FUNCS[rule["rule_id"]](work, ctx, kind)
        if action == "drop":
            return {"accepted": False, "edge": None, "action": "drop",
                    "reason": reason, "rules": hits + [rule["rule_id"]],
                    "table_miss": False}
        if action == "rewrite":
            work = new_edge
            hits.append(rule["rule_id"])
            if rewrite_reason is None:
                rewrite_reason = reason
    # 1b 裁决④:表外谓词"不猜、放行"要**可审计** ——
    # 事实边的谓词不在 `relation_type_rules()` 里 ⇒ 这一次放行靠的是"表外",
    # 单独计数 + 回执留痕(将来才知道多少边是靠放行进来的)。口径随数据表走。
    table_miss = (kind == KIND_FACT
                  and _text(edge.get("relation")) not in relation_type_rules())
    return {"accepted": True, "edge": work,
            "action": "rewrite" if hits else "accept",
            "reason": rewrite_reason, "rules": hits, "table_miss": table_miss}


def _public(verdict) -> dict:
    """对外只给四个键(形状固定,1b 的调用方不必认识 `rules`)。"""
    return {"accepted": bool(verdict["accepted"]), "edge": verdict["edge"],
            "action": verdict["action"], "reason": verdict["reason"]}


# ═══════════════════════════════════════════════════════════════════════
# 对外:单条 / 批量
# ═══════════════════════════════════════════════════════════════════════

def gate_edge(candidate, ctx=None, *, enabled=None) -> dict:
    """裁一条候选边。**默认关**:`enabled` 不显式给 True 时原样放行。

    不抛异常:任何内部异常都降级成 `drop` + `internal-error`(失败必须可见,
    但绝不打断写入主流程)。
    """
    if not (DEFAULT_ENABLED if enabled is None else bool(enabled)):
        return {"accepted": True, "edge": candidate, "action": "accept", "reason": None}
    try:
        return _public(_decide(candidate, ctx if ctx is not None else EMPTY_CONTEXT))
    except Exception as exc:   # 闸门不许把写入主流程带崩
        return {"accepted": False, "edge": None, "action": "drop",
                "reason": REASON_INTERNAL_ERROR}


def gate_edges(candidates, ctx=None, *, enabled=None) -> dict:
    """批量裁决 + 计数 + 回执。

    返回::

        {"verdicts": [...],           # 逐条(四键形状)
         "accepted": [...],           # 通过(含改正后)的边
         "rewritten": [...], "dropped": [...],
         "counters": {"accept": n, "rewrite": n, "drop": n,
                      "reasons": {reason: n}, "rules": {rule_id: n},
                      "rule_table_miss": n},   # 表外放行的边数(1b 裁决④)
         "receipts": [...]}           # 丢边 / 改边 / 表外放行各留一行(默认关时为空)

    回执口径:丢边、改边**必然**留痕(禁静默跳过);`rule_table_miss` 的 accept
    也留一行(`note="rule-table-miss"`,action 仍是 `accept`)—— 否则"靠表外放行
    进来的边"事后无从追溯。纯 accept(表内命中且没改)不留痕,免得刷屏。
    """
    context = ctx if ctx is not None else EMPTY_CONTEXT
    on = DEFAULT_ENABLED if enabled is None else bool(enabled)
    verdicts, accepted, rewritten, dropped, receipts = [], [], [], [], []
    counters = {"accept": 0, "rewrite": 0, "drop": 0, "reasons": {}, "rules": {},
                "rule_table_miss": 0}
    for candidate in (candidates or []):
        if on:
            try:
                internal = _decide(candidate, context)
            except Exception:
                internal = {"accepted": False, "edge": None, "action": "drop",
                            "reason": REASON_INTERNAL_ERROR, "rules": [],
                            "table_miss": False}
        else:
            internal = {"accepted": True, "edge": candidate, "action": "accept",
                        "reason": None, "rules": [], "table_miss": False}
        verdict = _public(internal)
        verdicts.append(verdict)
        counters[verdict["action"]] += 1
        if verdict["reason"]:
            counters["reasons"][verdict["reason"]] = counters["reasons"].get(verdict["reason"], 0) + 1
        for rule_id in internal.get("rules") or []:
            counters["rules"][rule_id] = counters["rules"].get(rule_id, 0) + 1
        table_miss = bool(internal.get("table_miss"))
        if table_miss:
            counters["rule_table_miss"] += 1
        if verdict["accepted"]:
            accepted.append(verdict["edge"])
            if verdict["action"] == "rewrite":
                rewritten.append(verdict["edge"])
        else:
            dropped.append(verdict)
        if verdict["action"] in ("drop", "rewrite"):
            hits = internal.get("rules") or []
            receipts.append(_safe_receipt(verdict, candidate, hits[-1] if hits else None))
        elif table_miss:
            receipts.append(_safe_receipt(verdict, candidate, "R4", note=NOTE_RULE_TABLE_MISS))
    return {"verdicts": verdicts, "accepted": accepted, "rewritten": rewritten,
            "dropped": dropped, "counters": counters, "receipts": receipts}


def _safe_receipt(verdict, candidate, rule_id=None, note="") -> dict:
    """回执构造**不许把批量裁决带崩**(裁决④的同一条精神)。

    候选脏到连 `_kind_of` / 取字段都读不动时(正是最该留痕的场合),
    退化成只记裁决本身,并在 `note` 里标明降级原因 —— 宁可回执少几列,也不许
    让"造回执"这颗雷把整批裁决掀翻。
    """
    try:
        return _receipt(verdict, candidate, rule_id, note=note)
    except Exception as exc:
        receipt = _receipt({"action": verdict.get("action"),
                            "reason": verdict.get("reason"), "edge": None},
                           {}, rule_id, note=note)
        # kind 留空 = "这一条的 kind 没读出来"(不许硬认成事实边),note 记降级原因。
        receipt["kind"] = ""
        receipt["note"] = (receipt["note"] + " receipt-degraded:"
                           + type(exc).__name__).strip()
        return receipt


def _receipt(verdict, candidate, rule_id=None, note="") -> dict:
    """真值回执的形状(照 `PLAN_MEMORY_GRAPH_ACTION.md` §2③ + 1b 裁决①)。

    1b 起落 **`graph_edge_receipts`**(新表,`db.py` 迁移 `CREATE TABLE IF NOT EXISTS`),
    由 `write_receipts()` 写入。字段:见回执表 DDL。
    """
    edge = verdict.get("edge") or candidate or {}
    kind = _kind_of(edge)
    return {
        "ts": time.time(),
        "rule_id": rule_id,
        "action": verdict.get("action"),
        "reason": verdict.get("reason"),
        "kind": kind,
        "evidence_scope": _text(edge.get("evidence_scope")) or _default_evidence_scope(kind),
        "source_kind": _text(edge.get("source_kind")) or _text(edge.get("endpoint_kind")),
        "target_kind": _text(edge.get("target_kind")) or _text(edge.get("endpoint_kind")),
        "source_id": edge.get("source_id"),
        "target_id": edge.get("target_id"),
        "occurred_at": edge.get("occurred_at"),
        "occurred_at_source": edge.get("occurred_at_source"),
        "evidence_memory_id": _evidence_ids(edge),
        "note": note,
        "payload": {"edge": {k: v for k, v in edge.items() if not str(k).startswith("__")}},
    }


# ═══════════════════════════════════════════════════════════════════════
# 落库(**只在测试与显式调用下**;默认关状态下列表是空的,根本不会被调)
# ═══════════════════════════════════════════════════════════════════════

def write_accepted_edges(conn, edges, owner_key, *, commit=True) -> dict:
    """把裁决通过的共现写进**证据层** `graph_cooc_evidence`(v2-A4:一行 = 一条证据)。

    与路线 2(影子表)相比**只有落点变了**;四条纪律原样保留:

    * **不调用 `graph.add_edge`** —— 那条路带"强化 / 槽位让位"语义,新边一进去
      就会把既有槽位的现役版本顶掉(`graph.py:400-420`)。这里只做纯 INSERT/UPDATE;
    * **同桶再表述 = 并集累加(阶段 3a 第二步裁决②,S1)**:同一
      `(owner, scope, 桶键)` 已存在时,**不新增行**,改为 `pairs = 旧∪新`、
      `node_ids` 随之重算、`weight = max(旧,新)`。证据层**没有**
      `last_accessed / half_life / recall_count / activation` 这套状态列
      (证据不是"被想起" —— 状态列的缺失是结构性的);
    * **幂等** —— 同一批输入连写两次,第二跑 `inserted == 0` 且 `updated == 0`
      (并集不变、max 不变 ⇒ 改动数 0);
    * **不删任何东西**,只增/只合;**`graph_edges` 一行都不碰**,**`graph_shadow_edges`
      一行都不再新增**(那 48 条是审计,冻结)。

    ⚠️ **告警(留痕)**:若**事实边**占着共现的保留谓词槽位(`graph_edges` 里
    同 `(source, relation)` 且 `kind` 为空)⇒ 这是异常状态(保留名被事实边用了),
    此时**不动它**、计 `warnings`、往 stderr 打一行。风险≈0,但必须可见。

    桶键:**一条证据 = (scope, 桶键)**。`same_memory` 用**记忆 id** —— 一条候选的
    evidence 里可能有**多个**记忆 id(如 `'280、285'`),那就**每个记忆各一桶**:
    这正是"这一对同时被**两条**记忆作证"的诚实形状。`same_day` 用 `occurred_at` 那一天。

    证据行的 `owner_key` 一律 `cooc.COOC_OWNER`(与 A4 迁入的那 13 行**同一命名空间**);
    调用方传进来的 `owner_key` 只用于那个保留槽位告警检查。

    表不存在(还没迁移的老库)⇒ 返回 `table_missing=True`,**不越权建表**。

    返回 `{"inserted", "updated", "skipped", "warnings", "table_missing", "pairs",
    "evidence_rows", "shadow_rows_before", "shadow_rows_after"}`:
    `inserted/updated` 是**证据行**(桶)数;`skipped` = 没写进去的**候选**数
    (端点/谓词空、非共现 kind、保留槽位被占、该对已在桶里);`pairs` = 本跑**新增**的
    pair 引用数。最后两个键是**冻结的现场证据**:真库那 48 行影子边是 3a 的历史,
    本函数不再碰它 ⇒ `before == after`。
    """
    before = _shadow_row_count(conn)
    if not _table_exists(conn, cooc_mod.EVIDENCE_TABLE):
        return {"inserted": 0, "updated": 0, "skipped": len(edges or []),
                "warnings": 0, "table_missing": True, "pairs": 0, "evidence_rows": 0,
                "shadow_rows_before": before, "shadow_rows_after": before}
    buckets = {}          # (scope, 桶键) -> {"pairs": set, "weight": float, "memory_id", "day_key"}
    per_edge = []         # [(edge, [(桶键, pair), ...])] —— 算"这条候选到底写进去没有"
    skipped = warnings = 0
    for edge in (edges or []):
        source = _text(edge.get("source_id"))
        target = _text(edge.get("target_id"))
        relation = _text(edge.get("relation"))
        if not source or not target or not relation:
            skipped += 1
            continue
        kind = _kind_of(edge)
        if not _is_shadow_kind(kind):
            # 这个写口**只吃共现**:事实边不是它的活儿(事实边走 `graph.learn` /
            # `add_edge`)。静默跳过,不告警、不落库。
            skipped += 1
            continue
        # 保留谓词槽位被**事实边**占了吗?(读 `graph_edges` 只读不改)
        reserved_taken = conn.execute(
            "SELECT COALESCE(kind, '') FROM graph_edges"
            " WHERE source_id = ? AND relation = ? AND owner_key = ? LIMIT 1",
            (source, relation, owner_key),
        ).fetchone()
        if reserved_taken is not None:
            warnings += 1
            print("[echo-gate] 共现的保留谓词槽位被 graph_edges 占着"
                  "(不动它,仅告警,旧路线残留或事实边越界):"
                  " %s|%s rel=%s kind=%s" % (owner_key, source, relation,
                                             _text(reserved_taken[0]) or "(事实边)"),
                  file=sys.stderr)
            skipped += 1
            continue
        try:
            weight = float(edge.get("weight") or 1.0)
        except (TypeError, ValueError):
            weight = 1.0
        slots = []
        if kind == KIND_COOCCUR_SAME_MEMORY:
            memory_ids = [int(x) for x in (_evidence_ids(edge) or [])]
            if not memory_ids:
                skipped += 1
                continue
            for mid in memory_ids:
                slots.append(((cooc_mod.SCOPE_SAME_MEMORY, str(mid)),
                              {"memory_id": mid, "day_key": ""}))
        elif kind == KIND_COOCCUR_SAME_DAY:
            try:
                occurred_at = float(edge.get("occurred_at") or 0.0)
            except (TypeError, ValueError):
                occurred_at = 0.0
            day_key = str(int(occurred_at))
            slots.append(((cooc_mod.SCOPE_SAME_DAY, day_key),
                          {"memory_id": 0, "day_key": day_key}))
        else:
            # `temporal` 之类:不是共现 ⇒ 证据层不收(与挖掘侧口径一致)
            skipped += 1
            continue
        key_pair = cooc_mod.pair_key(source, target)
        refs = []
        for bucket_key, meta in slots:
            bucket = buckets.setdefault(bucket_key, {"pairs": set(), "weight": 0.0, **meta})
            bucket["pairs"].add(key_pair)
            bucket["weight"] = max(bucket["weight"], weight)
            refs.append((bucket_key, key_pair))
        per_edge.append((edge, refs))

    inserted, updated, added, now = 0, 0, set(), time.time()
    for bucket_key, bucket in sorted(buckets.items()):
        scope, _key = bucket_key
        row = conn.execute(
            "SELECT evidence_id, COALESCE(pairs, ''), COALESCE(weight, 1.0)"
            " FROM " + cooc_mod.EVIDENCE_TABLE +
            " WHERE owner_key = ? AND scope_kind = ? AND memory_id = ? AND day_key = ?",
            (cooc_mod.COOC_OWNER, scope, int(bucket["memory_id"]), bucket["day_key"]),
        ).fetchone()
        old_pairs = {p for p in str(row[1]).split(",") if p} if row else set()
        merged = old_pairs | bucket["pairs"]
        nodes_text = "、".join(sorted({n for p in merged for n in p.split("|")}))
        pairs_text = ",".join(sorted(merged))
        node_count = len([n for n in nodes_text.split("、") if n])
        weight = float(bucket["weight"])
        if row is None:
            conn.execute(
                "INSERT INTO " + cooc_mod.EVIDENCE_TABLE +
                " (owner_key, scope_kind, memory_id, day_key, node_ids, pairs,"
                "  node_count, pair_count, weight, source_kind, created_at)"
                " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'gate', ?)",
                (cooc_mod.COOC_OWNER, scope, int(bucket["memory_id"]), bucket["day_key"],
                 nodes_text, pairs_text, node_count, len(merged), weight, now))
            inserted += 1
            added |= {(bucket_key, p) for p in bucket["pairs"]}
        elif merged != old_pairs or float(row[2] or 1.0) < weight:
            conn.execute(
                "UPDATE " + cooc_mod.EVIDENCE_TABLE +
                " SET node_ids = ?, pairs = ?, node_count = ?, pair_count = ?, weight = ?"
                " WHERE evidence_id = ?",
                (nodes_text, pairs_text, node_count, len(merged), weight, int(row[0])))
            updated += 1
            added |= {(bucket_key, p) for p in (bucket["pairs"] - old_pairs)}
    for _edge, refs in per_edge:
        if not any(ref in added for ref in refs):
            skipped += 1
    if commit and (inserted or updated):
        conn.commit()
    return {"inserted": inserted, "updated": updated, "skipped": skipped,
            "warnings": warnings, "table_missing": False, "pairs": len(added),
            "evidence_rows": _evidence_row_count(conn),
            "shadow_rows_before": before, "shadow_rows_after": _shadow_row_count(conn)}


def _shadow_row_count(conn) -> int:
    """影子表总行数(冻结证据用:**写口跑前跑后必须一样**)。"""
    if not _table_exists(conn, SHADOW_TABLE):
        return 0
    return int(conn.execute("SELECT COUNT(*) FROM " + SHADOW_TABLE).fetchone()[0] or 0)


def _evidence_row_count(conn) -> int:
    if not _table_exists(conn, cooc_mod.EVIDENCE_TABLE):
        return 0
    return int(conn.execute(
        "SELECT COUNT(*) FROM " + cooc_mod.EVIDENCE_TABLE + " WHERE owner_key = ?",
        (cooc_mod.COOC_OWNER,)).fetchone()[0] or 0)


def shadow_stats(conn) -> dict:
    """**共现层自己的读口**(阶段 4 用;显式调用,不经检索 / 提示词路径)。

    两组数:

    * 影子表(`graph_shadow_edges`,**已冻结**的 3a 历史):`active_shadow_edges` /
      `shadow_nodes` / `pairs_with_fact_edge`;
    * 证据层(v2-A4 起的新落点):`cooc_evidence_rows`(证据行数)/ `cooc_nodes`
      (证据覆盖到的节点)/ `cooc_pair_rows`(视图**按需派生**的 pair 行)/
      `cooc_pairs_with_fact_edge`。

    后两组里的 `*_pairs_with_fact_edge` 是同一个问题的两个时点:"共现的那一对,
    有没有已经变成一条事实边" —— 3a 那 48 条 vs 现在这一层,**路网有没有变成事实**的指标
    (证据层那半边按**去重后的 pair** 数,因为一行证据里可能躺着同一个 pair)。

    表不存在 ⇒ 全 0(`table_missing=True`)。**只读**。
    """
    out = {"active_shadow_edges": 0, "shadow_nodes": 0,
           "pairs_with_fact_edge": 0, "table_missing": False,
           "cooc_evidence_rows": 0, "cooc_nodes": 0, "cooc_pair_rows": 0,
           "cooc_pairs_with_fact_edge": 0}
    for key in ("cooc_evidence_rows", "cooc_nodes", "cooc_pair_rows",
                "cooc_pairs_with_fact_edge"):
        out[key] = 0
    try:
        out["cooc_evidence_rows"] = int(conn.execute(
            "SELECT COUNT(*) FROM " + cooc_mod.EVIDENCE_TABLE + " WHERE owner_key = ?",
            (cooc_mod.COOC_OWNER,)).fetchone()[0] or 0)
        out["cooc_nodes"] = int(conn.execute(
            "SELECT COUNT(*) FROM (SELECT source_id AS n FROM " + cooc_mod.EVIDENCE_VIEW +
            " WHERE owner_key = ? UNION SELECT target_id FROM " + cooc_mod.EVIDENCE_VIEW +
            " WHERE owner_key = ?)",
            (cooc_mod.COOC_OWNER, cooc_mod.COOC_OWNER)).fetchone()[0] or 0)
        out["cooc_pair_rows"] = int(conn.execute(
            "SELECT COUNT(*) FROM " + cooc_mod.EVIDENCE_VIEW + " WHERE owner_key = ?",
            (cooc_mod.COOC_OWNER,)).fetchone()[0] or 0)
        out["cooc_pairs_with_fact_edge"] = int(conn.execute(
            "SELECT COUNT(DISTINCT c.pair_key) FROM " + cooc_mod.EVIDENCE_VIEW + " c"
            " WHERE c.owner_key = ? AND EXISTS (SELECT 1 FROM graph_edges e"
            "   WHERE COALESCE(e.kind, '') = '' AND COALESCE(e.is_active, 1) = 1"
            "   AND ((e.source_id = c.source_id AND e.target_id = c.target_id)"
            "     OR (e.source_id = c.target_id AND e.target_id = c.source_id)))",
            (cooc_mod.COOC_OWNER,)).fetchone()[0] or 0)
    except Exception:
        pass
    if not _table_exists(conn, SHADOW_TABLE):
        out["table_missing"] = True
        return out
    out["active_shadow_edges"] = int(conn.execute(
        "SELECT COUNT(*) FROM " + SHADOW_TABLE +
        " WHERE COALESCE(is_active, 1) = 1").fetchone()[0] or 0)
    out["shadow_nodes"] = int(conn.execute(
        "SELECT COUNT(*) FROM (SELECT source_id AS n FROM " + SHADOW_TABLE +
        " WHERE COALESCE(is_active, 1) = 1 UNION SELECT target_id FROM " + SHADOW_TABLE +
        " WHERE COALESCE(is_active, 1) = 1)").fetchone()[0] or 0)
    out["pairs_with_fact_edge"] = int(conn.execute(
        "SELECT COUNT(*) FROM " + SHADOW_TABLE + " s WHERE COALESCE(s.is_active, 1) = 1"
        " AND EXISTS (SELECT 1 FROM graph_edges e"
        "   WHERE COALESCE(e.kind, '') = '' AND COALESCE(e.is_active, 1) = 1"
        "   AND ((e.source_id = s.source_id AND e.target_id = s.target_id)"
        "     OR (e.source_id = s.target_id AND e.target_id = s.source_id)))"
    ).fetchone()[0] or 0)
    return out


def _is_shadow_kind(kind) -> bool:
    return _text(kind) in SHADOW_KINDS


# ⚠️ v2-A4(2026-10-01):`_parse_evidence_list` / `_merge_existing_shadow` /
# `_row_changed` / `EVIDENCE_MERGE_CAP` 四条**已随落点一起退役** —— 它们编码的语义
# ("按 (source, target, relation) 合并 evidence 列表、上限 16")是 **pair 边**形态的东西;
# n 元证据层的合并是**桶内 pair 并集**(见 `write_accepted_edges` 里的
# `merged = old_pairs | bucket["pairs"]`)与"没变化就不写"
# (`merged != old_pairs or 权重变大`)。
# 这里留一段说明而不是留一堆死代码:死代码最容易被下一次改动当成"还在用的约定"。


# ═══════════════════════════════════════════════════════════════════════
# 真值回执落库(1b 裁决①:新表 `graph_edge_receipts`,可 SQL 查)
# ═══════════════════════════════════════════════════════════════════════

#: 表名(DDL 在 `db.py` 的 `_migrate_graph_edge_receipts`,`CREATE TABLE IF NOT EXISTS`)。
RECEIPTS_TABLE = "graph_edge_receipts"

#: 幂等去重键(表里对应的列):同一次 `run_id` 下同一条边的同一个裁决只落一行。
RECEIPT_KEY_COLUMNS = ("run_id", "kind", "source_id", "target_id", "action",
                       "reason", "rule_id")


def _table_exists(conn, name) -> bool:
    try:
        row = conn.execute(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", (name,)
        ).fetchone()
    except Exception:
        return False
    return bool(row)


def write_receipts(conn, receipts, *, run_id="", route="", commit=True) -> dict:
    """把回执写进 `graph_edge_receipts`。**只在开关开且真有裁决时被调**。

    * 表不存在(纯引擎库 / 还没迁移的老库)⇒ 直接返回 `table_missing=True`,
      **不建表**(建表是 `db.py` 迁移的职权,写入侧不越权);
    * **幂等**:同一个 `run_id` 下同样的 (kind, source_id, target_id, action,
      reason, rule_id) 只落一行 ⇒ 同一批回执连写两次,第二跑 `inserted == 0`;
    * `route` = "这条回执是哪条路线写的"(路线 2 传 `WRITE_ROUTE`);列不存在
      (还没迁移的老库)时**照常写、不落 route** —— 回执比标记重要,不许因为
      少一列就丢审计;
    * `run_id` 为空时按调用生成一个(uuid12),流水账语义(每次运行各留一份)。

    返回 `{"inserted": n, "skipped": m, "table_missing": bool, "run_id": "..."}`。
    """
    run = _text(run_id) or uuid.uuid4().hex[:12]
    if not _table_exists(conn, RECEIPTS_TABLE):
        return {"inserted": 0, "skipped": len(receipts or []),
                "table_missing": True, "run_id": run}
    try:
        has_route = "route" in {r[1] for r in conn.execute(
            "PRAGMA table_info(" + RECEIPTS_TABLE + ")").fetchall()}
    except Exception:
        has_route = False
    inserted, skipped = 0, 0
    for receipt in (receipts or []):
        key = (run, _text(receipt.get("kind")) or KIND_FACT,
               _text(receipt.get("source_id")), _text(receipt.get("target_id")),
               _text(receipt.get("action")), _text(receipt.get("reason")),
               _text(receipt.get("rule_id")))
        row = conn.execute(
            "SELECT id FROM " + RECEIPTS_TABLE +
            " WHERE run_id = ? AND kind = ? AND source_id = ? AND target_id = ?"
            " AND action = ? AND reason = ? AND rule_id = ?", key).fetchone()
        if row:
            skipped += 1
            continue
        try:
            occurred_at = float(receipt.get("occurred_at") or 0.0)
        except (TypeError, ValueError):
            occurred_at = 0.0
        columns = ("run_id, created_at, kind, source_kind, target_kind, source_id,"
                   " target_id, action, reason, rule_id, occurred_at, occurred_at_source,"
                   " evidence_memory_id, evidence_scope, note, payload")
        values = [run, float(receipt.get("ts") or time.time()),
                  _text(receipt.get("kind")), _text(receipt.get("source_kind")),
                  _text(receipt.get("target_kind")), _text(receipt.get("source_id")),
                  _text(receipt.get("target_id")), _text(receipt.get("action")),
                  _text(receipt.get("reason")), _text(receipt.get("rule_id")),
                  occurred_at, _text(receipt.get("occurred_at_source")),
                  json.dumps(receipt.get("evidence_memory_id") or [], ensure_ascii=False),
                  _text(receipt.get("evidence_scope")),
                  _text(receipt.get("note")),
                  json.dumps(receipt.get("payload") or {}, ensure_ascii=False, default=str)]
        if has_route:
            columns += ", route"
            values.append(_text(receipt.get("route")) or _text(route))
        conn.execute(
            "INSERT INTO " + RECEIPTS_TABLE + " (" + columns + ")"
            " VALUES (" + ", ".join("?" for _ in values) + ")",
            tuple(values),
        )
        inserted += 1
    if commit and inserted:
        conn.commit()
    return {"inserted": inserted, "skipped": skipped, "table_missing": False,
            "run_id": run}


# ═══════════════════════════════════════════════════════════════════════
# 接线(1b):`worker.py` 的 `graph_learn` 写边路径只调这一个函数
# ═══════════════════════════════════════════════════════════════════════

def build_context_from_db(conn, *, owner_key=None, strict_node_resolution=False,
                          speakers=None, person_names=None) -> dict:
    """从活库读一张上下文快照(节点表 / 别名表 / 既有事实边槽位)。

    只 SELECT,不写。缺表(老库 / 测试库)时对应部分为空 —— 不抛异常:
    闸门的任何一环拿不到数据,都不该把写入主流程带崩。
    """
    nodes, aliases, slots = [], [], set()
    try:
        nodes = conn.execute(
            "SELECT node_id, name, node_type FROM graph_nodes").fetchall()
    except Exception:
        nodes = []
    try:
        aliases = conn.execute(
            "SELECT alias, canonical_name FROM graph_aliases").fetchall()
    except Exception:
        aliases = []
    try:
        for row in conn.execute(
                "SELECT source_id, relation FROM graph_edges"
                " WHERE COALESCE(is_active, 1) = 1"
                " AND COALESCE(kind, '') IN ('', 'fact')"):
            slots.add("%s|%s" % (_text(row[0]), _text(row[1])))
    except Exception:
        slots = set()
    return build_context(nodes, aliases, existing_fact_slots=slots,
                         strict_node_resolution=strict_node_resolution,
                         speakers=speakers, person_names=person_names)


def is_shadow_candidate(candidate) -> bool:
    """这条候选边是不是影子边(kind 在影子边取值域内)。"""
    return _kind_of(candidate or {}) in SHADOW_KINDS


def internal_error_receipt(exc, candidate=None, *, note="") -> dict:
    """闸门**自身**出错时的回执(1b 裁决④):`action='drop'` + `reason='internal-error'`。

    为什么要它:闸门自己出错是**最需要留痕**的事 —— 只留在 stderr 会随进程日志一起
    消失,事后查不了。所以哪怕裁决没做完,也要尽量在回执表留一行。
    """
    base = candidate if isinstance(candidate, dict) else {}
    receipt = _receipt({"action": "drop", "reason": REASON_INTERNAL_ERROR, "edge": None},
                       base, None)
    receipt["note"] = (note or "") + "gate-internal-error:" + type(exc).__name__
    return receipt


def report_internal_error(conn, exc, *, candidate=None, run_id="", note="") -> dict:
    """把 internal-error 回执写进表;**表不可用/写不进才退化 stderr,且不截断**。

    * 先试 `write_receipts`(回执表在 ⇒ 留痕成功,连重复 run_id 也算"已留痕");
    * 只有表缺失 / 写库异常(或本就写不进)时,才把**完整** traceback 打到 stderr ——
      **不走 `diag()`**(它有 64 行预算,会把最该看的回溯截掉)。

    返回 `{"receipt_written": bool, "stderr": bool, "traceback": str}`。
    """
    receipt = internal_error_receipt(exc, candidate, note=note)
    written = False
    try:
        outcome = write_receipts(conn, [receipt], run_id=run_id)
        written = not outcome.get("table_missing")
    except Exception:
        written = False
    text = traceback.format_exc()
    if not written:
        print("[echo-graph-gate] internal-error 回执未能落表(回执表不可用?);"
              "以下是完整回溯(故意不截断):\n" + text, file=sys.stderr)
    return {"receipt_written": written, "stderr": not written, "traceback": text}


def maybe_gate_shadow_edges(conn, owner_key, *, candidates=None, run_id="",
                            enabled=None, speakers=None, person_names=None) -> dict:
    """**接线口**(两处:① `worker.py:graph_learn` 帧;② `judge.commit` ③b 的真实写边
    路径,经 `mine_after_memory_write()` 转进来)。

    纪律:

    * **默认关**(开关 = `env ∨ 插件设置文件`,见 `gate_enabled()`)。关掉时**连库
      都不读**,直接返回 `{"enabled": False, ...}` ⇒ 与现状逐位一致;
    * **只管影子边**:非影子边候选一律忽略(只计入 `skipped_non_shadow`),
      **既不裁也不写** ⇒ 事实边绝不会被闸门拦住;
    * 开着时:读一张上下文快照 → `gate_edges` → 落通过的共现到**证据层**
      (`write_accepted_edges`,**v2-A4 起写 `graph_cooc_evidence`**;`graph_edges`
      一行不碰,`graph_shadow_edges` 也**一行都不再新增**)+ 落回执
      (`write_receipts`,带 `route` 标记);
    * **绝不改既有行**(不调 `graph.add_edge`,不动任何 slot / is_active);
    * 候选从哪来?**阶段 3a / 3b 的挖边逻辑负责给**(本函数不挖边,只做闸门);
      没给候选时开着也只是空转(`considered = 0`);
    * **自身出错也不静默**:逐条裁决内部的异常已被 `gate_edges` 降级成
      `drop` + `internal-error`(照常留回执);这里再兜一层"批量流程"级别的异常
      (上下文构建 / 落库 / 落回执),尽量留一条 `internal-error` 回执,表不可用才
      退化成 stderr 全量回溯。**本函数不抛异常**。

    返回:`{"enabled", "considered", "skipped_non_shadow", "counters", "written",
    "receipts", "run_id", "error"}`,`error` 正常时是 `None`。
    """
    on = gate_enabled() if enabled is None else bool(enabled)
    result = {"enabled": bool(on), "considered": 0, "skipped_non_shadow": 0,
              "counters": None, "written": None, "receipts": None,
              "run_id": _text(run_id), "error": None}
    if not on:
        return result
    shadow, non_shadow = [], 0
    for candidate in (candidates or []):
        if is_shadow_candidate(candidate):
            shadow.append(candidate)
        else:
            non_shadow += 1
    result["considered"] = len(shadow)
    result["skipped_non_shadow"] = non_shadow
    try:
        context = build_context_from_db(conn, owner_key=owner_key,
                                       speakers=speakers, person_names=person_names)
        gated = gate_edges(shadow, context, enabled=True)
        result["counters"] = gated["counters"]
        result["written"] = write_accepted_edges(conn, gated["accepted"], owner_key)
        receipts = write_receipts(conn, gated["receipts"], run_id=run_id,
                                  route=WRITE_ROUTE)
    except Exception as exc:                # 闸门自己出错 ⇒ 最需要留痕(裁决④)
        reported = report_internal_error(conn, exc, run_id=run_id)
        result["error"] = {"type": type(exc).__name__, "message": str(exc),
                           "receipt_written": reported["receipt_written"],
                           "stderr": reported["stderr"]}
        return result
    result["receipts"] = receipts
    result["run_id"] = receipts.get("run_id", "")
    return result


# ═══════════════════════════════════════════════════════════════════════
# 阶段 4 尾:真实写边点(judge.commit ③b)的挖边钩子
# ═══════════════════════════════════════════════════════════════════════

#: 一次写入最多为几条新记忆挖边(一轮通常 1~2 条;上限只是防病态轮次拖长主流程)
MAX_HOOK_MEMORIES = 8


def mine_after_memory_write(conn, memory_ids, *, owner_key=SHADOW_OWNER, run_id="",
                            enabled=None, mine=None, names=None) -> dict:
    """**真实写边路径的唯一钩子**(`judge.commit` 写完事实边后的 ③b)。

    它回答的是那句"每写一条新记忆就自动挖影子边"在**线上**到底怎么成立:

    * **同一个开关**:`gate_enabled()`(env ∨ 插件设置文件 `graphShadowEdges`),
      **默认关**。关掉时**连库都不读**(先判开关再碰 `conn`),返回 `{"enabled": False}`;
    * 开着时:对**这一轮刚写进去的那几条记忆**逐条 `candidates_for_latest_memory(...)`
      (运行时口径 = **只挖那条记忆本身**,同记忆类;同天类属于一次性历史回填,
      窗口反复挖被禁止 —— 与 `worker.py:graph_learn` 那条路**逐字同口径**),
      然后交给 `maybe_gate_shadow_edges()` 过 R1–R6、落 `graph_shadow_edges` + 回执;
    * **绝不干扰主流程**:本函数**不抛异常**。自身出错 ⇒ 吞掉 + `report_internal_error`
      留一条 `internal-error` 痕迹(表不可用才退化 stderr),主流程照常在返回字典里
      报它自己的结果(**钩子的产物不进 `commit()` 的返回值** ⇒ 关掉时逐位零行为变化);
    * **不扫全库**:候选只从 `memory_ids` 里那几条来;上限 `MAX_HOOK_MEMORIES`。

    `mine` 可注入(单测用假挖边器,或注入会抛错的实现来验"钩子异常不影响返回")。
    返回 `{"enabled", "memories", "considered", "written", "receipts", "error"}`。
    """
    on = gate_enabled() if enabled is None else bool(enabled)
    result = {"enabled": bool(on), "memories": 0, "considered": 0, "written": None,
              "receipts": None, "error": None}
    if not on:
        return result

    ids = []
    for raw in (memory_ids or []):
        try:
            value = int(raw)
        except (TypeError, ValueError):
            continue
        if value > 0:
            ids.append(value)
    ids = ids[:MAX_HOOK_MEMORIES]
    result["memories"] = len(ids)
    if not ids:
        return result

    # 延迟 import:`graph_mine` 在模块级 import 本模块(挖边用 NODE_TYPE_* / 规则常量),
    # 这里再在模块级反向 import 就成了循环。函数内 import 一次(首次之后走缓存)。
    miner = mine
    considered_total = 0
    written_total = {"inserted": 0, "updated": 0, "skipped": 0, "warnings": [],
                     "table_missing": False}
    receipts_total = {"inserted": 0, "skipped": 0, "table_missing": False, "run_id": ""}
    # P1c:名字集合随帧进来(`names` = 帧里的 `names` 对象);离线调用方不给 ⇒ 空集合口径。
    speakers, person_names = names_from_obj(names)
    for memory_id in ids:
        try:
            if miner is None:
                from . import graph_mine
                miner = graph_mine.candidates_for_latest_memory
            candidates = miner(conn, memory_id=memory_id)
            # 开关**只判一次**(本函数开头),这里把结论传下去:免得中途翻文件
            # 出现"挖了边才发现关了"的半截状态(也少读一次文件)。
            gated = maybe_gate_shadow_edges(conn, owner_key, candidates=candidates,
                                            run_id=run_id, enabled=on,
                                            speakers=speakers, person_names=person_names)
        except Exception as exc:            # 钩子自己出错 ⇒ 留痕,绝不掀翻主流程
            reported = report_internal_error(conn, exc, run_id=run_id,
                                             note="judge.commit hook: memory_id=%s"
                                                  % memory_id)
            result["error"] = {"type": type(exc).__name__, "message": str(exc),
                               "receipt_written": reported["receipt_written"],
                               "stderr": reported["stderr"]}
            continue
        considered_total += int(gated.get("considered") or 0)
        for key in ("inserted", "updated", "skipped"):
            if gated.get("written"):
                written_total[key] += int(gated["written"].get(key) or 0)
        if gated.get("written") and gated["written"].get("warnings"):
            written_total["warnings"].extend(gated["written"]["warnings"])
        if gated.get("written") and gated["written"].get("table_missing"):
            written_total["table_missing"] = True
        if gated.get("receipts"):
            receipts_total["inserted"] += int(gated["receipts"].get("inserted") or 0)
            receipts_total["skipped"] += int(gated["receipts"].get("skipped") or 0)
            if gated["receipts"].get("table_missing"):
                receipts_total["table_missing"] = True
            receipts_total["run_id"] = gated["receipts"].get("run_id", "")
    result["considered"] = considered_total
    result["written"] = written_total
    result["receipts"] = receipts_total
    return result
