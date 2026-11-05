# -*- coding: utf-8 -*-
"""关系 / 记忆键的「基数表」(记忆架构 v2 · A1)—— 单一出处。

## 为什么要有它

老规则是 `slot = 源|关系`,一条新边落进**已有槽位**就把旧边 `is_active=0`
(换代)。这等于把「**唯一性**」当成了「**矛盾**」。实测代价(2026-10-01 基线):

* 45 条事实边里 21 条已死,其中 **19 条是被同类顶掉的**;
* 活跃节点 `KARDS`、`老乡鸡的梅菜扣肉` 在可见图上**度数归零**(悬空)——
  因为它那条「用户—喜欢玩—KARDS」被后来的「用户—喜欢玩—德美跳」顶下线;
* 情景层同款:`longTermInterests`(喜欢玩 KARDS)被后来的战地1 顶掉
  (memory_id 313 被 315 顶下线)。

## 取证结论(docs/ASSOC_GRAPH_SURVEY.md §7 共识 3)

* **Zep/Graphiti**(arXiv:2501.13956):只在「**语义相关且时间重叠的矛盾**」上
  把边置 `t_invalid`,失效不删除;
* **Mem0**(arXiv:2504.19413):每条新事实由 LLM 显式判
  ADD / UPDATE / DELETE / NOOP,只有矛盾才「以最新为准」;
* **MIRIX**(arXiv:2507.07957):语义条目「**除非被概念性覆盖**,否则长期保留」;
* **A-MEM**(arXiv:2502.12110)/ **RAPTOR**(arXiv:2401.18059):一条记忆
  可以同时属于多个 box / 多个簇(多归属是一等公民)。

⇒ 一句话:**换代只在矛盾时发生,并列不是矛盾。**

## 这一版怎么落地(不引入判断模型)

A1 的模型调用数 = **0**。改用**声明式基数**:

* **关系**:只有出现在 `SINGLE_VALUE_RELATIONS` 里的关系才换代;
  其余一律**并列**(默认多值 = 宁可并列,不可丢东西)。
* **记忆键**:只有出现在 `MULTIVALUE_MEMORY_KEYS` 里的键允许同键多条并存;
  其余沿用「同 key 换代」(情景层保持窄口径 —— 键是身份/事实类居多,
  默认放宽会让 L0 注入行数膨胀)。

两条默认值方向**故意不同**,理由写在各自注释里;要改只改这里。
"""

#: **单值关系白名单**:同 (源, 关系) 只留一个目标,新宾语顶掉旧宾语。
#:
#: 只放「确凿的单值事实关系」—— 身份 / 归属 / 住所 / 去向 / 唯一数值。
#: 拿不准的**千万别放**:放错的代价是「她记得的事被静默顶下线」;
#: 不放的代价只是「同一个关系下并列两条」,那是可修的。
#:
#: ★ P3-c:本表是**内置兜底**;`graph.json.relations.singleValue` 给了就用数据(整表替换)。
SINGLE_VALUE_RELATIONS = frozenset({
    # 身份与称呼
    "是", "称呼", "名字是", "身份是",
    # 学业 / 单位(单一归属)
    "就读于", "就读", "读于", "就读专业", "专业是", "班级是",
    # 住所 / 家乡(同一时刻只有一个)
    "住在", "家乡是", "户籍是",
    # 唯一数值 / 去向
    "有预算", "可能转到",
})

#: **多值记忆键白名单**:同 (user_id, memory_key) 允许**多条现役**并存。
#:
#: 证据驱动(2026-10-01 活库实测):这三类各自发生过「把并列事实顶掉」——
#: `longTermInterests` 3 行里 2 行被取代(喜欢玩 KARDS 被战地1 顶掉)。
#: 其余键(`current_project` / `identity_education` / `preferred_food` …)
#: 的换代大多是**真换代**(计划变了、专业变了),保持原行为。
#:
#: ★ P3-c:内置兜底;`graph.json.relations.multiValueKeys` 给了就用数据(整表替换)。
MULTIVALUE_MEMORY_KEYS = frozenset({
    "longTermInterests",   # 长期兴趣:喜欢的东西是可累加的一串,不是唯一值
    "preferred_food",      # 爱吃的东西同上
    "food_preference",     # 同上(历史键名,待 A2 归一)
})


def is_single_value_relation(rel):
    """这个关系是不是单值(单值 ⇒ 允许换代;多值 ⇒ 并列,永不互相顶)。

    判据走 `single_value_relations()`:数据(`graph.json.relations.singleValue`)给了
    就用数据,空 ⇒ 回上面那张内置表(P3 的等价性要求:空数据 = 迁移前行为)。
    """
    return str(rel or "").strip() in single_value_relations()


def is_multi_value_memory_key(key):
    """这个记忆键是不是可累加的集合(是 ⇒ 同键多条并存,不换代)。同上,数据优先。"""
    return str(key or "").strip() in multi_value_memory_keys()


def cardinality_of_relation(rel):
    """给报表用:``'single'`` / ``'multi'``。"""
    return "single" if is_single_value_relation(rel) else "multi"


# =====================================================================
# A2:谓词的规范写法(**同义**才并,不用近义猜)
# =====================================================================
#
# 现场(2026-10-01 活库实测):**45 条边用了 34 个不同的关系词**——
# "就读于 / 读于 / 就读 / 就读专业"是同一件事,"搭建 / 正在搭建 / 正在开发 /
# 期望打造 / 想打造 / 希望打造 / 希望塑造"也是。KAG(arXiv:2409.13731)把这
# 一类直接点名为图噪声的根因之一:**词粒度差异**(polysemy / synonyms /
# granularity)。
#
# 两条纪律(继承自既有 `RELATION_ALIASES` 的注释,现在搬到这里当唯一出处):
#
# 1. **只并同义,不并上下位。** 「喜欢玩 / 喜欢吃」是「喜欢」的**下位**
#    (更具体),并掉会丢粒度 ⇒ 一律不并,进 `RELATION_PENDING` 让人看。
# 2. **猜错的代价 > 多几根线。** 拿不准的一律留在 `RELATION_PENDING`,
#    等人工裁定 —— 本表是白名单,不是"近义猜测器"。
#
# 键 = 现场写法,值 = 规范写法;规范写法自己也在表里(自映射,`merge_relation_variants`
# 靠"值==键"把它当天然幸存者)。
CANONICAL_RELATION = {
    # —— 打造/筹备 Echo 一族:宾语都是 Echo,四种说法是一个意思 ——
    "希望打造": "希望打造",
    "期望打造": "希望打造",
    "想打造": "希望打造",
    "希望塑造": "希望打造",
    # —— 承担某个项目/活计一族 ——
    "负责": "负责",
    "搭建": "负责",
    "在做": "负责",
    "在忙": "负责",
    "正在搭建": "负责",
    "正在开发": "负责",
    # —— 在哪儿念书一族 ——
    "就读于": "就读于",
    "读于": "就读于",
    "就读": "就读于",          # A2 补:现场有它,老表漏了
    "就读专业": "就读于",
}

#: **待定表**:看着像同义、但拿不准的候选。**只有他能拍**(合并错 = 把两件事并成一件)。
#: 每条都写清"疑点",免得他看一串光秃秃的词。
RELATION_PENDING = (
    {"variant": "专业是", "candidate": "就读于",
     "why": "现场是「用户—专业是—?」与「用户—就读于—新工科大学」。若宾语分别是"
            "**专业**与**学校**,并掉会混两层;若都是学校,就该并。"},
    {"variant": "给AI升级大脑", "candidate": "负责",
     "why": "看着是项目一族的一次性说法,但宾语可能不是他负责的东西。"},
    {"variant": "进行", "candidate": "在做 / 负责",
     "why": "「进行」太泛(进行校园跑?),宾语不同意思就不同。"},
    {"variant": "有校园跑要求", "candidate": "要求",
     "why": "是「要求」的一个具体化,并掉会丢「校园跑」这个限定。"},
    {"variant": "觉得不错", "candidate": "喜欢",
     "why": "「觉得不错」是评价不是偏好强度,并成喜欢会把弱评价升级成偏好。"},
    {"variant": "是老玩家", "candidate": "喜欢玩",
     "why": "「老玩家」含资历(玩了多久),比「喜欢玩」多一层。"},
    {"variant": "想念 / 在意", "candidate": "（彼此）",
     "why": "两个都是情感,但方向不同(想念=想见,在意=放心上),并掉要他自己判断。"},
)


def canonical_relation(rel):
    """谓词的规范写法。表外的**原样返回**(白名单,不是"猜近义")。"""
    r = str(rel or "").strip()
    return _table().get(r, r)


def relation_merges():
    """要被并掉的变体(键 != 值)。给报表与守卫用。"""
    return {k: v for k, v in _table().items() if k != v}


# =====================================================================
# 数据覆盖(P3-a 起,P3-c 补全关系表这一块)
# =====================================================================
#
#: 帧里下发的覆盖表(`graph.json.relations.*`;形状真源 = `lib/data-schema.js:294-311`,
#: 经 `lib/data-tables.js` 的 `frameData()` → `python/engine/graph_gate.py::data_from_frame`)。
#:
#: **七个子表各自独立**:某张空 / 缺 / 坏 ⇒ 只有那张回落内置表;全空 = 迁移前行为
#: (逐位一致,这是 P3 的硬验收)。
#:
#: 为什么七张都挂在本模块:worker 每帧只对 `relations / timeintent / judge` 三个模块调
#: `configure_from_data()`(`python/worker.py:136-141`),而关系表的消费点散在四处 ——
#: 本模块(规范写法 + 两张基数表)、`graph_gate.py`(类型规则 `:762`/`:900`、默认谓词 `:792`)、
#: `l0_tier.py`(身份谓词 `:84`)、`normalize_relations.py`(待定表 `:80`)。
#: 帧**只在这里解析一遍**,其余模块经下面的取值函数读 —— 否则同一个文件被四个模块各解析
#: 一遍,四份口径照样会漂(而且 `graph_gate` / `l0_tier` 之间还互为反向依赖,绕不开)。
_OVERRIDE = None          #: 规范写法 map(canonical)
_SINGLE = None            #: 单值关系白名单(singleValue)
_MULTI = None             #: 多值记忆键白名单(multiValueKeys)
_IDENTITY = None          #: L0 身份谓词白名单(identityRelations)
_PENDING = None           #: 待定表(pending)
_TYPE_RULES = None        #: 端点类型 / 方向约束表(typeRules)
_DEFAULT_RELATION = None  #: 事实边默认谓词(defaultRelation)

#: 端点的合法取值(与 `graph_gate.NODE_TYPES` 同口径)。**故意不 import graph_gate**:
#: 那边反向要用本模块(类型规则 / 默认谓词),互相 import 会绕成环;而这份取值域本身是
#: 跨语言对账常量(`concept / person / episode / belief`),不是可配置的口味。
_TYPE_NAMES = ("concept", "person", "episode", "belief")

#: 只给了谓词名(`string[]`,SPEC 现在唯一能让写进来的形状)时的默认端点组合。
#: 为什么要有这一支、为什么是这个组合,见 `_type_rules()`。
_NAME_ONLY_PAIRS = (("person", "concept"),)


def _text(value):
    """取一个非空字符串(去空白;其余类型一律 `None`)。"""
    s = value.strip() if isinstance(value, str) else ""
    return s or None


def _str_list(raw):
    """`string[]` → 干净列表(丢非字符串 / 空串);不是数组 / 全脏 ⇒ `None`。"""
    if not isinstance(raw, (list, tuple)):
        return None
    out = [s for s in (_text(x) for x in raw) if s]
    return out or None


def _str_set(raw):
    """`string[]` → `frozenset`(`_str_list` 的集合版;空 ⇒ `None`)。"""
    items = _str_list(raw)
    return frozenset(items) if items else None


def _canonical(raw):
    """规范写法 map(`{现场写法: 规范写法}`);空 / 坏 ⇒ `None`。"""
    if not isinstance(raw, dict):
        return None
    clean = {}
    for k, v in raw.items():
        ks, vs = _text(k), _text(v)
        if ks and vs:
            clean[ks] = vs
    return clean or None


def _pending_rows(raw):
    """待定表 → `tuple[{variant, candidate, why}]`。**脏行丢掉**(不是对象 / `variant` 空),
    一行不剩 ⇒ `None`(回落内置)⇒ "容错"与"空即迁移前"两件事同时成立。"""
    if not isinstance(raw, (list, tuple)):
        return None
    out = []
    for row in raw:
        if not isinstance(row, dict):
            continue
        variant = _text(row.get("variant"))
        if not variant:
            continue
        out.append({"variant": variant,
                    "candidate": _text(row.get("candidate")) or "",
                    "why": _text(row.get("why")) or ""})
    return tuple(out) or None


def _pairs(raw):
    """`[[源类型, 目标类型], …]` → `[(源, 目标)]`;坏行丢掉;一条不剩 ⇒ `None`。"""
    if not isinstance(raw, (list, tuple)):
        return None
    out = []
    for pair in raw:
        if not isinstance(pair, (list, tuple)) or len(pair) != 2:
            continue
        src, dst = _text(pair[0]), _text(pair[1])
        if src in _TYPE_NAMES and dst in _TYPE_NAMES:
            out.append((src, dst))
    return out or None


def _type_rules(raw):
    """端点类型 / 方向约束表 → `{谓词: [(源, 目标), …]}`。认三种形状:

    ① **对象数组**(设计 §2.1 #10 的主形状):
       `[{"relation": "就读于", "pairs": [["person", "concept"]]}, …]`
       —— 注意 `lib/data-schema.js:299` 现在把 `typeRules` 冻成了 `string[]`,这个形状
       **过不了写入校验**(面板写不进来);读点先认它,形状拍板后不用再改这里;
    ② **扁平对象**(设计里的备选):`{"就读于": [["person", "concept"]], …}`;
    ③ **名字数组**(SPEC 现在唯一能让写进来的形状):`["就读于", …]` —— 只有名字,
       配不出 `相关` 那种"两个方向都合法"的组合 ⇒ 统一按 `_NAME_ONLY_PAIRS`
       (person → concept:内置表 12 条里 11 条正是这个;拿不到的粒度只能丢)。

    都不是 / 一行都不干净 ⇒ `None`(回落内置表)。
    """
    out = {}
    if isinstance(raw, dict):
        for k, v in raw.items():
            rel, pairs = _text(k), _pairs(v)
            if rel and pairs:
                out[rel] = pairs
        return out or None
    if isinstance(raw, (list, tuple)):
        for row in raw:
            if isinstance(row, dict):
                rel, pairs = _text(row.get("relation")), _pairs(row.get("pairs"))
            else:
                rel, pairs = _text(row), list(_NAME_ONLY_PAIRS)
            if rel and pairs:
                out[rel] = pairs
        return out or None
    return None


def configure_from_data(data):
    """用帧里的数据块覆盖内置表。**never-throw**:形状不对的子表就当没给。

    `data` = 壳侧 `lib/data-tables.js::frameData()` 下的整块(形状见
    `python/engine/graph_gate.py::data_from_frame`);空 / 缺 / 坏 ⇒ 七张子表**各回各的内置表**。

    认的子表(键名 = `graph.json.relations.*`):`canonical` / `singleValue` /
    `multiValueKeys` / `identityRelations` / `pending` / `typeRules` / `defaultRelation`。
    """
    global _OVERRIDE, _SINGLE, _MULTI, _IDENTITY, _PENDING, _TYPE_RULES, _DEFAULT_RELATION
    if isinstance(data, dict) and isinstance(data.get("data"), dict):
        data = data["data"]        # 也认"整帧"(防呆:`frame` 与 `frame["data"]` 都收)
    graph = data.get("graph") if isinstance(data, dict) else None
    rels = graph.get("relations") if isinstance(graph, dict) else None
    raw = rels if isinstance(rels, dict) else {}
    _OVERRIDE = _canonical(raw.get("canonical"))
    _SINGLE = _str_set(raw.get("singleValue"))
    _MULTI = _str_set(raw.get("multiValueKeys"))
    _IDENTITY = _str_set(raw.get("identityRelations"))
    _PENDING = _pending_rows(raw.get("pending"))
    _TYPE_RULES = _type_rules(raw.get("typeRules"))
    _DEFAULT_RELATION = _text(raw.get("defaultRelation"))


# ---------------------------------------------------------------- 子表取值
# 一律"数据优先,空 ⇒ 内置"。内置表住在哪个模块,哪张表就由哪个模块兜(fallback)——
# 本模块兜 canonical / singleValue / multiValueKeys / pending,另外三张给**数据本身**
# (没有 ⇒ `None`),由 graph_gate(类型规则 / 默认谓词)与 l0_tier(身份谓词)自己接兜底,
# 免得同一个内置表在两个模块各写一份。


def _table():
    """当前生效的规范表(数据覆盖优先,空 ⇒ 内置)。"""
    return _OVERRIDE if _OVERRIDE else CANONICAL_RELATION


def single_value_relations():
    """当前生效的单值关系白名单(`frozenset`;数据空 ⇒ 内置 `SINGLE_VALUE_RELATIONS`)。"""
    return _SINGLE if _SINGLE else SINGLE_VALUE_RELATIONS


def multi_value_memory_keys():
    """当前生效的多值记忆键白名单(`frozenset`;数据空 ⇒ 内置 `MULTIVALUE_MEMORY_KEYS`)。"""
    return _MULTI if _MULTI else MULTIVALUE_MEMORY_KEYS


def pending_relations():
    """当前生效的待定表(`tuple`;数据空 ⇒ 内置 `RELATION_PENDING`)。"""
    return _PENDING if _PENDING else RELATION_PENDING


def type_rules_data():
    """`graph.json.relations.typeRules` 解析结果(`{谓词: [(源, 目标)]}`)。**没有 ⇒ `None`**。

    内置表在 `graph_gate.RELATION_TYPE_RULES` ⇒ 兜底在那边(`graph_gate.relation_type_rules()`)。
    """
    return _TYPE_RULES


def default_relation_data():
    """`graph.json.relations.defaultRelation`(字符串)。**没有 ⇒ `None`**。

    内置值在 `graph_gate.FACT_DEFAULT_RELATION` ⇒ 兜底在那边(`graph_gate.default_relation()`)。
    """
    return _DEFAULT_RELATION


def identity_relations_data():
    """`graph.json.relations.identityRelations` 解析结果(`frozenset`)。**没有 ⇒ `None`**。

    内置表在 `l0_tier.IDENTITY_RELATIONS` ⇒ 兜底在那边(`l0_tier.identity_relations()`)。
    """
    return _IDENTITY
