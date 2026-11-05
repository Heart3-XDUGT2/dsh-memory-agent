# -*- coding: utf-8 -*-
"""Memory Judge 合并版 EXTRACT(M2-b4)—— 写入链的供血者与组织者。

A5(v4 修正):AstrBot 每轮跑两次 LLM(EXTRACT 情绪 + Judge 记忆);
DSH 合并为**一次调用**同产情绪载荷 + candidates + triples +
pendingThreads,三层校验全部是纯代码住在本模块 —— 比原版省一次调用,
校验强度不降。壳只负责跑 LLM(prompt 由本模块供给,单一事实源)。

三层防线(brain_pipeline.py:1496-2071 逐字移植):
  第一层  提示词级硬约束(见 build_extract_prompt)
  第二层  Schema 校验(_validate_candidate / _validate_triple /
          _validate_pending_threads:枚举白名单、长度钳制、日历校验)
  第三层  代码级后过滤(_post_filter_candidates 四道门 /
          _post_filter_triples 五道门 —— 不可绕过的硬约束)

写入链顺序(main.py brain2 顺序保真):
  ① candidates 落情景库(I 由 Judge 字段合成;slot 槽位取代;
     occurred_at 只收绝对时间)
  ② 无候选时降级:轮级 summary 按 emotion_score 门卫(默认 4)写入
  ③ triples 落图(与候选同一套字段、同一个 I 公式 —— 图与情景
     终于共用同一把尺子)
  ④ 悬置话题:**先消解再登记**(顺序不能反 —— 登记用的 content 就是从
     这句话里抠出来的,先登记会被同一轮的消解立刻关掉)
  ⑤ preferredName/language 从 L0 候选提取,交壳落画像

置信度门控(M2-h,A5 预留的准入旋钮)是第四层:<0.55 拒收、
0.55~0.75 candidate 隔离(落库 status='quarantined',不进检索不进
反思 —— 她不把没把握的事当真事记)、≥0.75 落库。隔离候选同 slot
被高置信版本顶掉即晋升(episodic.insert_memory 状态感知槽位)。
"""

import json
import re

from . import dmae, episodic, graph, graph_gate, threads
from .timeutil import parse_abs_time, resolve_follow_up_time

# ---- 枚举与常量(brain_pipeline.py:1501-1517)----
ABSOLUTE_TERMS = frozenset(["只", "永远", "从不", "一定", "完全", "绝对", "以后都", "不再"])
VALID_LAYERS = frozenset(["L0", "L1", "L2"])
VALID_CERTAINTIES = frozenset(["explicit", "inferred", "uncertain"])
VALID_ATTRIBUTIONS = frozenset(["user_explicit", "assistant_inferred", "mixed"])
VALID_IMPORTANCES = frozenset(["low", "medium", "high"])
VALID_STABILITIES = frozenset(["one_off", "situational", "stable"])
VALID_TEMPORAL_STATUSES = frozenset(
    ["enduring", "current", "historical", "planned", "time_unknown"])

L0_FIELDS = {
    "preferredName": "用户希望被如何称呼、叫什么名字、昵称",
    "occupation": "用户的职业、身份、工作",
    "longTermInterests": "用户的长期兴趣爱好(稳定的,不是临时的)",
    "language": "用户常用的语言或地区习惯",
    "permanentNote": "其他不属于以上四类的稳定个人信息",
}
L1_FIELDS = frozenset(["recentGoals", "recentPreferences", "currentProject"])

#: 2026-10-12:`field` → `memory_type` 的归一映射(落库用,**不参与任何判断**)。
#:
#: 为什么要有它:模型早就在判「这是稳定信息还是局部偏好」(L0_FIELDS/L1_FIELDS),
#: 但落库时只有 `preferredName`/`language` 两个值进了画像,**其余 4 个与整个
#: `stability` 被丢掉** ⇒ 记忆侧没有"类型"可用。这张表就是"别丢"的桥。
#:
#: 取值与 `field` 一一对应,不新增语义;认不出的 field ⇒ 空串(旧行为)。
FIELD_TO_MEMORY_TYPE = {
    "occupation": "identity",            # 职业、身份、工作
    "longTermInterests": "interest",     # 长期兴趣(稳定的)
    "permanentNote": "note",             # 其他稳定个人信息
    "recentGoals": "preference",         # L1:近期目标
    "recentPreferences": "preference",   # L1:近期偏好
    "currentProject": "activity",        # L1:当前在做的事
}


def memory_type_of(candidate):
    """把候选的 `field` 译成 `memory_type`。认不出 ⇒ `""`(旧行为)。"""
    if not isinstance(candidate, dict):
        return ""
    return FIELD_TO_MEMORY_TYPE.get(str(candidate.get("field") or "").strip(), "")


def memory_stability_of(candidate):
    """把候选的 `stability` 原样带出来(只收白名单里的值)。认不出 ⇒ `""`。

    为什么只收白名单:这列是给将来用的**原始信号**,不该混进模型乱写的字符串。
    """
    if not isinstance(candidate, dict):
        return ""
    v = str(candidate.get("stability") or "").strip()
    return v if v in VALID_STABILITIES else ""


MIN_EMOTION_SCORE = 4  # 降级路径的情感分门卫(AstrBot 默认值)
EMOTION_STATES = ["happy", "sad", "angry", "neutral", "loving", "excited", "anxious"]

# 第四层:置信度准入闸(M2-h)。confidence 缺失按 0 处理 → 拒收:
# 提示词与 schema 都要求该字段,缺席即模型失职,硬闸不放行。
CONF_REJECT_BELOW = 0.55
CONF_QUARANTINE_BELOW = 0.75


# ═══════════════════════════════════════════════════════════════════════
# 第二层:Schema 校验
# ═══════════════════════════════════════════════════════════════════════

def norm_abs_time(value) -> str:
    """归一化为 'YYYY-MM-DD' 或 'YYYY-MM-DDTHH:MM';非绝对时间返回空串。

    v8.7.2 日历校验:「2025-02-31」旧版能通过(只查数值范围),编造的
    假日期会落进 occurred_at —— 与「绝不放行编造时间」的使命相悖。
    """
    text = str(value or "").strip()
    if not text:
        return ""
    m = re.match(r"(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ](\d{1,2}):(\d{2}))?", text)
    if not m:
        return ""
    year, month, day = int(m.group(1)), int(m.group(2)), int(m.group(3))
    import datetime
    try:
        datetime.date(year, month, day)
    except ValueError:
        return ""
    if m.group(4) is not None:
        hour, minute = int(m.group(4)), int(m.group(5))
        if 0 <= hour <= 23 and 0 <= minute <= 59:
            return f"{year:04d}-{month:02d}-{day:02d}T{hour:02d}:{minute:02d}"
    return f"{year:04d}-{month:02d}-{day:02d}"


def _has_unsupported_absolute(summary, evidence_quotes) -> bool:
    """summary 有绝对词但用户原话(evidence)没有 → LLM 自行推广,拦截。"""
    for term in ABSOLUTE_TERMS:
        if term in summary:
            if not any(term in q for q in evidence_quotes):
                return True
    return False


# ═══════════════════════════════════════════════════════════════════════
# 主题自指门(2026-09-26 他的裁决:「工程自指一律拒收」)
# ═══════════════════════════════════════════════════════════════════════
# 现场:活库 episodic_memory 249 条里 35 条(14%)是"我们在改这个插件"的
# 工作话;图谱节点里站着 `Echo记忆架构 / agent后端架构 / 网站后端架构`。
# A 侧干净是因为它的世界只有 QQ 上的人话 —— 我们这边得显式把工程元讨论
# 挡在记忆之外:那不是他的生活,是我们在干活。
#
# 判据取**主题自指**,不是宽泛的单词表 —— 宁可漏拒(少记一条工作话),
# 不许错拒(把他的生活当成工程噪音扔掉)。所以:
#   · 「代码/测试/页面/图谱」这类词单独出现**不算**(他可能真在讲他的课业);
#   · 只有和"这个插件/这套系统/我们正在改的东西"绑在一起才算。
_SELF_REFERENTIAL_PATTERNS = (
    re.compile(r"记忆图谱|图谱页面|记忆图里|记忆架构|审查台|关系图"),
    re.compile(r"插件|dsh[-_ ]?echo", re.IGNORECASE),
    re.compile(r"runtime context|snapshot supersedes|file policy|approval prompts", re.IGNORECASE),
    re.compile(r"agent后端|agent的架构|提示词|系统提示|人设段"),
    re.compile(r"(页面|界面|按钮|配色|字体|动画|布局|箭头样式|渲染|图谱)"),
    # 只留"工程动作"与"代码库自指";**裸的「前端/后端」不放这里** ——
    # 「他做后端的」是他的职业,不是噪音(第一版误拒过,电池当场抓住)。
    re.compile(r"(代码库|仓库|分支|提交|部署|编译|构建|单元测试|测试用例|报错|堆栈|pytest|npm run)"),
)
# B 层:要跟"这套东西"一起出现才算 —— 否则「做后端的」「我在学代码」会被误伤
_SELF_CONTEXT = re.compile(r"(前端|后端|代码|测试|节点|连线|夹角|斥力|调试|重构|接口|数据库|性能)")
_ARTIFACT = re.compile(r"(插件|echo|图谱|页面|界面|审查台|箭头|渲染|这个项目|这套|agent|提示词|记忆库)", re.IGNORECASE)


def is_self_referential(text) -> bool:
    """这段内容是不是在讲「这个插件/这套代码」自己?

    是 → 不收进她的记忆(他的裁决:一律拒收)。
    """
    t = str(text or "").strip()
    if not t:
        return False
    if any(p.search(t) for p in _SELF_REFERENTIAL_PATTERNS):
        return True
    return bool(_SELF_CONTEXT.search(t) and _ARTIFACT.search(t))


def validate_candidate(raw):
    """Schema 级校验:LLM 原始输出 → 合法候选;不合法返回 None。"""
    if not isinstance(raw, dict):
        return None
    layer = str(raw.get("layer") or "").strip()
    if layer not in VALID_LAYERS:
        return None
    content = str(raw.get("summary") or raw.get("content") or "").strip()
    if not content:
        return None
    try:
        confidence = float(raw.get("confidence") or 0)
    except (TypeError, ValueError):
        confidence = 0.0
    confidence = max(0.0, min(1.0, confidence))
    candidate = {
        "layer": layer,
        "summary": content[:200],
        "content": content[:200],
        "confidence": round(confidence, 2),
        "triggerText": str(raw.get("triggerText") or "")[:100],
        "certainty": str(raw.get("certainty") or "").strip(),
        "attribution": str(raw.get("attribution") or "").strip(),
        "importance": str(raw.get("importance") or "").strip(),
        "stability": str(raw.get("stability") or "").strip(),
        "shouldWrite": bool(raw.get("shouldWrite", False)),
        "reason": str(raw.get("reason") or "")[:100],
        "forbiddenOverclaims": [],
        "evidenceQuotes": [],
        "field": None,
        # occurred_at 只接受绝对日期;换不出来留空 → 上层落 time_unknown
        # (绝不拿写入时间冒充事件时间)。
        "occurred_at": norm_abs_time(raw.get("occurred_at")),
        "temporal_status": str(raw.get("temporal_status") or "").strip().lower(),
        # slot 是「同一件事的槽位键」。留空 = 不参与取代 —— 最坏退回
        # 旧行为,绝不会误合并两条无关记忆。
        "slot": str(raw.get("slot") or "").strip()[:64],
    }
    # 2026-09-30:说法键(fact-augmented keys)。清洗规则与模型产物一律同一条纪律:
    # ① 只收短词元(≤12 字)② 去重 ③ 最多 4 条 ④ **原文里已有的字面不算扩展**
    # (它本来就参与检索,重复加只会虚增这条的权重)。给不出就是空数组 ——
    # 空数组 = 检索侧一个字面都不加(逐位等于老行为)。
    _ak = raw.get("askKeys")
    aug = []
    if isinstance(_ak, list):
        for item in _ak:
            # 只收字符串 —— `str(None)` 会变成字面量 "None" 混进打分正文
            # (单测抓到的真事:那是脏字面,不是说法)。
            if not isinstance(item, str):
                continue
            t = item.strip()
            if not t or len(t) > 12:
                continue
            if t in content:
                continue
            if t in aug:
                continue
            aug.append(t)
            if len(aug) >= 4:
                break
    candidate["askKeys"] = aug
    if candidate["certainty"] not in VALID_CERTAINTIES:
        candidate["certainty"] = ""
    if candidate["attribution"] not in VALID_ATTRIBUTIONS:
        candidate["attribution"] = ""
    if candidate["importance"] not in VALID_IMPORTANCES:
        candidate["importance"] = ""
    if candidate["stability"] not in VALID_STABILITIES:
        candidate["stability"] = ""
    if candidate["temporal_status"] not in VALID_TEMPORAL_STATUSES:
        candidate["temporal_status"] = "time_unknown"
    # 不因「缺 occurred_at」抹掉 temporal_status:enduring 本来就没有发生
    # 时间;historical 缺日期时「过去事件」这个状态仍然正确,抹掉是丢信息。
    candidate["slot"] = re.sub(r"[^0-9A-Za-z_\u4e00-\u9fff]+", "_", candidate["slot"]).strip("_")
    field = str(raw.get("field") or "").strip()
    if layer == "L0" and field in L0_FIELDS:
        candidate["field"] = field
    elif layer == "L1" and field in L1_FIELDS:
        candidate["field"] = field
    fo = raw.get("forbiddenOverclaims")
    if isinstance(fo, list):
        candidate["forbiddenOverclaims"] = [str(x) for x in fo if str(x).strip()][:5]
    eq = raw.get("evidenceQuotes")
    if isinstance(eq, list):
        candidate["evidenceQuotes"] = [str(x).strip() for x in eq if str(x).strip()][:5]
    return candidate


def validate_triple(raw):
    """三元组 Schema 校验(与候选同一套字段与枚举 —— 图与情景共用准入)。"""
    if not isinstance(raw, dict):
        return None
    s = str(raw.get("s") or raw.get("source") or "").strip()[:32]
    rel = str(raw.get("relation") or "相关").strip()[:16] or "相关"
    t = str(raw.get("t") or raw.get("target") or "").strip()[:32]
    if not s or not t or s == t:
        return None
    layer = str(raw.get("layer") or "L2")
    if layer not in VALID_LAYERS:
        layer = "L2"

    def _enum(value, allowed):
        # 2026-10-17：加 `.lower()` 拆一个隐雷。
        # 现场与依据：模型完全可能给 "Explicit" / "USER_EXPLICIT"（大小写不一致），
        # 而这里原来只 `.strip()` ⇒ 值不在列表 ⇒ 被清成空串 ⇒ 下游 `:399`
        # 报「缺少certainty/attribution」—— **明明是给了值，却被说成没给**。
        # 枚举本身全小写（见文件头 VALID_* 常量），所以 lowercase 是**唯一安全的宽容**：
        # 它不会把任何非法值变成合法值，只会让"大小写写错的好值"被正确接住。
        v = str(value or "").strip().lower()
        return v if v in allowed else ""

    def _enum_tracked(value, allowed, raw_out, key):
        """同 `_enum`，但**把被拒的原值记下来**（诊断用，2026-10-17）。

        为什么要多这一份：`post_filter_triples` 原来把
        「模型压根没给这个字段」和「给了但值不被接受」**报成同一个 reason**
        （`缺少certainty/attribution`）—— 现场就踩了：
        真机 87 条里全是这句，而**手工用同一段 prompt 打模型时字段全给对了**，
        于是"到底是没给还是给了不认"从库里根本分不出来，只能靠猜。

        ⇒ 这里把原值挂到 `__enumRejected`（**下划线前缀 = 内部字段**），
          让下游能报出**两个不同的 reason**。不改变任何通过/拒绝的判定。
        """
        if key in raw_out:
            return
        raw_v = value
        if raw_v is None or str(raw_v).strip() == "":
            return                      # 真没给 ⇒ 不记，下游照旧报"缺少"
        if str(raw_v).strip().lower() in allowed:
            return                      # 给对了（大小写不同也算对）⇒ 不记
        raw_out[key] = str(raw_v)[:60]

    _rejected = {}
    _enum_tracked(raw.get("certainty"), VALID_CERTAINTIES, _rejected, "certainty")
    _enum_tracked(raw.get("attribution"), VALID_ATTRIBUTIONS, _rejected, "attribution")
    _enum_tracked(raw.get("stability"), VALID_STABILITIES, _rejected, "stability")

    quotes = raw.get("evidenceQuotes") or []
    if not isinstance(quotes, list):
        quotes = []
    _occ = norm_abs_time(raw.get("occurred_at"))
    _tstat = str(raw.get("temporal_status") or "").strip().lower()
    if _tstat not in VALID_TEMPORAL_STATUSES:
        _tstat = "time_unknown"
    out = {
        "s": s, "relation": rel, "t": t, "layer": layer,
        "certainty": _enum(raw.get("certainty"), VALID_CERTAINTIES),
        "attribution": _enum(raw.get("attribution"), VALID_ATTRIBUTIONS),
        "stability": _enum(raw.get("stability"), VALID_STABILITIES),
        "occurred_at": _occ,
        "temporal_status": _tstat,
        "evidenceQuotes": [str(q)[:100] for q in quotes][:5],
        "shouldWrite": bool(raw.get("shouldWrite", False)),
        "reason": str(raw.get("reason") or "")[:100],
    }
    # 2026-10-17：被 `_enum` 拒掉的原值（下划线前缀 = 内部字段，**不进库**）。
    # 只给 `post_filter_triples` 报 reason 用 —— 让"没给"和"给了不认"分得开。
    # ⚠️ **只在真有被拒值时挂**：空 dict 也挂上去的话，它会跟着通过的三元组
    #    一路流到 `graph_items`（那是给 `graph.learn` 的入参）。
    #    （这条是写测试时被自己的断言抓出来的：`__enumRejected: {}` 照样出现了。）
    if _rejected:
        out["__enumRejected"] = _rejected
    return out


# ═══════════════════════════════════════════════════════════════════════
# 样板值黑名单(2026-10-17)
# ═══════════════════════════════════════════════════════════════════════
# 现场:本地 3B 把 build_extract_prompt 里**样板 JSON 的字面值当成答案抄回来**。
#
#   · `pendingThreads.content` = **「要跟进的事」**（活库 #44，直接落库了）
#   · `reason`（情绪打分的触发点）= 「他说今天开会到十点」/「他说了今天开会到十点」
#     —— 最近 8 条里 4 条是它（另一个调用点，判据在 lib/emotion-score.js，同批修）
#
# 为什么在代码里挡而不是只改 prompt:
#   prompt 是"劝"，模型未必听 —— 这与 `is_self_referential`、绝对化词表
#   (`_has_unsupported_absolute`) 是同一套设计:**prompt 劝,代码墙**。
#
# 判据取"**整条就是样板**"(`fullmatch`),不是"包含样板字":
#   「要跟进的事：他明天答辩」这种真的写了内容的条目必须留下。
PENDING_CONTENT_PLACEHOLDERS = re.compile(
    r"(?:要跟进的事|跟进的事|待跟进的事|需要跟进的事|悬置话题)"
    # 只允许**括号包裹**的短说明(「要跟进的事（他明天答辩）」这种也当样板丢);
    # ⚠️ 不许放行冒号/破折号后面接内容的形式 —— 「要跟进的事：他明天答辩」
    #    是**真写了内容**的条目,必须留下(第一版这里写成 `[^）)]{0,12}` 就误丢了)。
    r"(?:[（(][^）)]{0,12}[）)])?"
    r"\s*[。.!！?？]?"
)


def validate_pending_threads(raw_items):
    """悬置话题 Schema 校验:比候选更严。

    content 必须能独立看懂 —— 纯指代(「那件事」)直接丢,否则跟进时
    模型只能瞎猜,「猜错话题」比「不跟进」更伤。
    follow_up_after 优先收绝对时间;相对表达原样透传 —— 登记口有
    确定性解析器(resolve_follow_up_time)换算,换不出才落不定时。
    """
    kept = []
    for raw in (raw_items or [])[:5]:
        if not isinstance(raw, dict):
            continue
        content = " ".join(str(raw.get("content") or "").split()).strip()[:300]
        if not content:
            continue
        # ★ 2026-10-17：样板值黑名单。
        #   现场：`#44` 落库内容是「要跟进的事」—— 那正是 build_extract_prompt 里
        #   样板 JSON 的字面值，本地 3B 把它当答案抄了回来。
        #   为什么必须在代码里挡（而不是只改 prompt）：提示词是"劝"，模型未必听
        #   —— 这与 `is_self_referential` / 绝对化词表同一套思路（prompt 劝，代码墙）。
        #   判据取"**整条就是样板/占位符**"而不是"包含样板字"，避免误伤
        #   像「要跟进的事：他明天答辩」这种真的写了内容的条目。
        # ⚠️ 必须 `.fullmatch` 而不是 `.match` —— `.match` 只锚开头，
        #    「要跟进的事：他明天答辩」会被当成样板整条丢掉（第一版就是这么错的，
        #    测试当场抓出来：10 个用例里 3 个误丢）。
        if PENDING_CONTENT_PLACEHOLDERS.fullmatch(content):
            continue
        if re.fullmatch(
            r"(?:这个|这件事|这些|它|那个|上面说的|刚才说的|那件事).{0,6}", content
        ):
            continue
        kept.append({
            "content": content,
            "follow_up_after": norm_abs_time(raw.get("follow_up_after"))
            or " ".join(str(raw.get("follow_up_after") or "").split())[:40],
            # 2026-10-06 D1:类别(设计 §1.3)。这里只做**白名单消毒** ——
            # 认不出的值一律当空;真正的判定在 threads.resolve_thread_kind
            # (规则优先 → 这个字段兜底 → 认不出留 ''),单一落点在写入口。
            "kind": (str(raw.get("kind") or "").strip().lower()
                     if str(raw.get("kind") or "").strip().lower() in threads.THREAD_KINDS else ""),
            "reason": str(raw.get("reason") or "")[:100],
        })
    return kept


# ═══════════════════════════════════════════════════════════════════════
# 第三层:代码级后过滤(不可绕过)
# ═══════════════════════════════════════════════════════════════════════

def post_filter_candidates(candidates):
    """五道门:shouldWrite / L0 双门控 / forbiddenOverclaims / 绝对化术语 /
    **主题自指(工程噪音)**。

    2026-09-26 现场(他问「为什么会出现那么多奇怪的记忆?A 侧可没有这个问题」)。
    他的裁决:「工程自指一律拒收」。实测脏源:开发会话在范围内 + 宿主
    runtime context 被当人话捕获 ⇒ 库里长出
    「用户提出记忆图谱布局要求…」「要求Echo去开源社区找参照」「箭头太丑」
    这类**关于这个插件自己**的"记忆",图上还站着
    `Echo记忆架构 / agent后端架构 / 网站后端架构` 这种节点。

    A 侧干净是因为它的世界只有 QQ 上的人话;我们这边得显式把
    「工程元讨论」挡在记忆之外 —— 那不是他的生活,是我们在干活。
    """
    filtered = []
    for item in candidates:
        if not item.get("shouldWrite"):
            continue
        layer = item.get("layer", "")
        if layer == "L0":
            if item.get("certainty") != "explicit" or item.get("attribution") != "user_explicit":
                continue
        if item.get("forbiddenOverclaims"):
            continue
        summary = item.get("summary") or item.get("content") or ""
        evidence = item.get("evidenceQuotes") or []
        if _has_unsupported_absolute(summary, evidence):
            continue
        if is_self_referential(summary) or any(is_self_referential(q) for q in evidence):
            continue
        filtered.append(item)
    return filtered


def post_filter_triples(triples):
    """六道门,返回 (kept, dropped)。

    ③ 归因硬门是血泪教训:正因为缺这道门,幻觉「用户-是->被我哥骂过
    的家伙」(inferred + assistant_inferred + 零证据)被当成事实写进了
    永久记忆。图记忆代表**用户确立的事实**,不是 AI 自己的推断。

    ⑥ 主题自指门(2026-09-26 他的裁决「一律拒收」):图谱节点里站着
    `Echo记忆架构 / agent后端架构 / 网站后端架构 / 一千美元` 这种
    "我们在改这个插件"的产物。它们不是他的世界。
    """
    kept = []
    dropped = []
    for it in triples:
        reason = ""
        attrib = str(it.get("attribution") or "")
        # 2026-10-17：把「没给」和「给了但不认」**分成两个 reason**。
        # 依据：原来两种情况都报 `缺少certainty/attribution` —— 现场 87 条全是这句，
        # 而手工用同一段 prompt 打模型时字段**全给对了**，
        # 于是"到底是没给还是给了不认"从库里分不出来，只能靠猜。
        # `validate_triple` 现在会把被拒的原值挂在 `__enumRejected` 上。
        rejected = it.get("__enumRejected") or {}
        if not it.get("shouldWrite"):
            reason = "shouldWrite=false"
        elif not it.get("certainty") or not attrib:
            if rejected:
                parts = ", ".join(f"{k}={v!r}" for k, v in sorted(rejected.items()))
                reason = f"certainty/attribution 值不被接受: {parts}"
            else:
                reason = "缺少certainty/attribution"
        elif attrib not in ("user_explicit", "mixed"):
            reason = f"不可归因于用户({attrib})"
        elif it.get("certainty") == "uncertain":
            reason = "certainty=uncertain"
        else:
            text = f"{it.get('s', '')}{it.get('relation', '')}{it.get('t', '')}"
            if _has_unsupported_absolute(text, it.get("evidenceQuotes") or []):
                reason = "绝对化术语"
            elif is_self_referential(text):
                reason = "主题自指(工程噪音)"
        if reason:
            dropped.append({
                "triple": f"{it.get('s')}-{it.get('relation')}->{it.get('t')}",
                "reason": reason,
            })
        else:
            kept.append(it)
    return kept, dropped


def reject_reasons(validated, filtered):
    """给被拦候选补上人能看懂的理由(审计用)。"""
    reasons = []
    kept_ids = {id(c) for c in filtered}
    for item in validated:
        if id(item) in kept_ids:
            continue
        reason = ""
        if not item.get("shouldWrite"):
            reason = "shouldWrite=false"
        elif item.get("forbiddenOverclaims"):
            reason = "forbiddenOverclaims"
        elif item.get("layer") == "L0" and (
            item.get("certainty") != "explicit"
            or item.get("attribution") != "user_explicit"
        ):
            reason = "L0双重门控"
        elif _has_unsupported_absolute(
            item.get("summary") or "", item.get("evidenceQuotes") or []
        ):
            reason = "绝对化术语"
        elif is_self_referential(item.get("summary") or ""):
            reason = "主题自指(工程噪音)"
        else:
            reason = "后处理过滤"
        reasons.append({
            "layer": item.get("layer", "?"),
            "summary": (item.get("summary") or "")[:40],
            "reason": reason,
        })
    return reasons


# ═══════════════════════════════════════════════════════════════════════
# 第一层:合并版系统提示词(A5:一次调用同产全部结构)
# ═══════════════════════════════════════════════════════════════════════

_PLACEHOLDER_NAMES = frozenset(
    ["null", "undefined", "none", "nil", "n/a", "无", "未提供", "不知道", "用户名"])


def _clean_name(value):
    """v0.16.0 M4:称呼清洗 —— 占位词一律当「没有称呼」。

    实测活库 `user_profile.name = 'null'`:提示词里写 `"name": null`,
    模型把那个 null 原样吐成**字符串** "null",壳侧 setName 照写。
    这类占位词进画像会一路污染注入信封(「称呼:null」),所以在交壳
    之前先挡一道。返回 str 或 None(与 commit 的 ack 契约一致)。
    """
    if not isinstance(value, str):
        return None
    s = value.strip()
    if not s or s.lower() in _PLACEHOLDER_NAMES:
        return None
    return s[:32]


def memory_key_of(candidate: dict) -> str:
    """v0.14.3 记忆键:slot 优先,退回 field。

    为什么退回 field:提示词对 L0/L1 候选**强制要求**填 field,而 field 的
    取值是固定英文名(recentGoals / recentPreferences / currentProject /
    L0_FIELDS)—— 天生就是稳定键。A 侧只用 slot,而模型给 slot 的命名会
    随轮次漂移(实测同一件事两次反思写成 food_preference 与
    preferred_food),L1「近况」于是每轮**叠加一条**而不是换代。今晚实测
    118 条活跃记忆里 109 条键为空 —— 空键等于没有去重可言。
    """
    return str(candidate.get("slot") or candidate.get("field") or "")


# ---------------------------------------------------------------- 数据覆盖(P3-a)
#: 状态初值覆盖(`state-defaults.json.moodIntensity`)。`None` ⇒ 用 **3**(= 迁移前行为)。
#: 只有"那个 3"是可配置的初值;钳位上下限 1/10 属形状,留在代码里。
_OVERRIDE_MOOD = None


def configure_from_data(data):
    """用帧里的数据块覆盖状态初值。**never-throw**:形状不对就当没给。

    `data` = 壳侧 `lib/data-tables.js::frameData()` 下的整块(见
    `python/engine/graph_gate.py::data_from_frame`);空 / 缺 / 坏 ⇒ 回落 3。
    """
    global _OVERRIDE_MOOD
    val = None
    if isinstance(data, dict) and isinstance(data.get("data"), dict):
        data = data["data"]        # 也认"整帧"(防呆:`frame` 与 `frame["data"]` 都收)
    if isinstance(data, dict):
        sd = data.get("stateDefaults")
        raw = sd.get("moodIntensity") if isinstance(sd, dict) else None
        if isinstance(raw, (int, float)) and not isinstance(raw, bool):
            val = raw
    _OVERRIDE_MOOD = val


def _mood_default():
    """`moodIntensity` 的兜底初值(数据优先;空 ⇒ 3)。"""
    return 3 if _OVERRIDE_MOOD is None else _OVERRIDE_MOOD


def build_extract_prompt(known_entities=None) -> str:
    """EXTRACT 吸收 Judge 职责后的合并系统提示词(单一事实源)。

    情绪载荷规则来自 M1 EXTRACT(已实测的人格纪律),记忆载荷规则
    来自 AstrBot Judge(保守判定三层防线的第一层)。

    v0.16.0 M2:`known_entities` = 图谱里度数最高的现有实体名(≤20)。
    实测碎片(「西电」与「西安电子科技大学」并存、三条「-想打造-> Echo」
    说法不同)主要来自模型每轮自己造词;递一张现成名单让它复用,
    比事后合并便宜且**保真**(合并永远有损)。
    """
    l0_fields_desc = "\n".join(f"  · {k}：{v}" for k, v in L0_FIELDS.items())
    entity_hint = []
    names = [str(x).strip() for x in (known_entities or []) if str(x).strip()]
    if names:
        entity_hint = [
            "",
            "── 已有实体(知识图谱里已经在用的名字)──",
            "、".join(names[:20]),
            "写 triples 时:**同一个东西必须复用上面的名字**,不要造近义词、"
            "简称或换个说法(「西电」已经被归一成「西安电子科技大学」)。"
            "只有确实是名单里没有的新实体,才写新名字。",
        ]
    return "\n".join([
        # ★ 2026-10-17：整体精简（7655 → ~2900 字符）。
        # 现场：本地 qwen2.5:3b 在 7655 字符的 prompt 上 **0/5 全空**（9 个键都出但四个载荷全空），
        #   而同样内容压到 ~2900 字符后 **5/5 全通**（triples/candidates/emotion_vector/pendingThreads
        #   全出、枚举全合法、延迟 2.96s）。阈值实测在 2883✅ ~ 3425❌ 之间，**断崖式**。
        # ⚠️ 3425 那版失败是**0.8 秒吐空模板**（放弃信号），不是"抽了但错"。
        #   元凶是那句"**不要记**「关于这个插件/这套代码/这个页面」的事" —— 全局否定被 3B
        #   听成"这轮什么都别记"。**这类全局否定一律不许再写进这个 prompt。**
        #   而那条裁决（他 2026-09-26「工程自指一律拒收」）在后处理层有硬兜底
        #   （`post_filter_candidates:409` 与 `post_filter_triples:453` 的 `is_self_referential`），
        #   **prompt 里根本不需要重复它**。
        # 其它被砍掉的规则与它们的兜底：
        #   · 绝对化表达 → `_has_unsupported_absolute`（`:407` candidates / `:451` triples，纯词表，完整兜）
        #   · inferred/uncertain 不进 L0 → L0 双门控（`:400-402` + `:445-448`，完整兜，有实证）
        #   · forbiddenOverclaims → `:403` / `:475`（**半兜底**：只在模型自填时生效，已知代价）
        # 保留的：9 个顶层键的完整样板、全部枚举值、L0/L1 field 可用值、triples 不串值警告、
        #        summary 禁英文双引号、动态段 l0_fields_desc 与 entity_hint。
        "你是记忆与情绪反思模块。分析用户(她的唯一主人)与 Echo 的最近一轮对话，输出一个 JSON，严格照下面形状，**每个字段都必须有**：",
        '{"keywords":["短词","短词"], "summary":"第三人称一句话,<=60字,只写用户说的事实",',
        ' "emotion_score":5, "emotion_state":"neutral", "name":null,',
        ' "mood_intensity":5, "mood_reason":"","say_again":0,"extra_reply":"",',
        ' "profile_update":{},',
        ' "emotion_vector":{"global":{"fatigue":0,"valence":0,"arousal":3},',
        '                   "target_master":{"affection":5,"playfulness":5,"sadness":0,"dependency":5}},',
        ' "candidates":[',
        '   {"layer":"L2","field":"","summary":"保守可追溯的候选摘要","confidence":0.9,',
        '    "triggerText":"用户原话短引文","importance":"medium",',
        '    "stability":"situational","certainty":"explicit","attribution":"user_explicit",',
        '    "evidenceQuotes":["用户原话短引文"],"shouldWrite":true,',
        '    "reason":"为什么值得记","occurred_at":"","temporal_status":"current",',
        '    "slot":"","askKeys":["以后他可能怎么问"],"forbiddenOverclaims":[]}',
        ' ],',
        ' "triples":[',
        '   {"s":"用户","relation":"参加","t":"校园跑","layer":"L2",',
        '    "certainty":"explicit","attribution":"user_explicit","stability":"situational",',
        '    "occurred_at":"","temporal_status":"current",',
        '    "evidenceQuotes":["校园跑3km"],"shouldWrite":true,"reason":"他明确说的近期安排"}',
        ' ],',
        ' "pendingThreads":[',
        # ★ 2026-10-17：样板值改成**字段说明体裁**（`〈…〉` 包起来），不再像"答案"。
        #   现场：3B 把 `"content":"要跟进的事"` 原样抄进活库（#44）。
        #   `〈〉` 是中文书名号，模型更不容易把它当成要填的内容；真正的兜底
        #   在后处理（`PENDING_CONTENT_PLACEHOLDERS`）—— prompt 只是减少触发率。
        '   {"content":"〈一句能独立看懂的话，别写代词〉","follow_up_after":"","kind":"topic","reason":"〈为什么需要跟进〉"}',
        ' ]}',
        "",
        "字段规则：",
        "- keywords：2~6 个短词，能锚定该事件。summary：第三人称，<=60 字，助手说的不算用户事实。",
        "- emotion_score：1~10（寒暄1~3/日常4~6/重要7~10）；用户明确表达偏好/习惯时至少 4。",
        "- emotion_state：happy / sad / angry / neutral / loving / excited / anxious 之一。",
        "- mood_intensity：1~10，Echo **自己**这轮的情绪强度（不是用户的）。mood_reason：<=15 字。",
        "- say_again：只填 0 或 1，仅当 Echo 情绪余波未平想补一句时给 1，日常一律 0。extra_reply：say_again=1 时 <=15 字口语补充，否则空串。",
        '- profile_update：只写身份锚点，键只能是 {"语言":…, "代词":…}，没有就 {}。',
        "- emotion_vector：数值 0~10（valence -10~10），单轮变化通常不超过 ±3。",
        "",
        "candidates（记忆候选）：",
        "- layer：L0(稳定身份) / L1(近期目标) / L2(具体事件)。L0/L1 必须填 field。",
        "- field 可用值（L0）：preferredName / occupation / longTermInterests / language / permanentNote；"
        "L1：recentGoals / recentPreferences / currentProject；L2 留空。",
        l0_fields_desc,
        "- **只抽最后一轮新出现的信息**，别重复记前面几轮。纯闲聊无信息量 ⇒ candidates 给 []。",
        "- 枚举值逐条列清：",
        "  · importance：low / medium / high",
        "  · stability：one_off / situational / stable",
        "  · certainty：explicit / inferred / uncertain",
        "  · attribution：user_explicit / assistant_inferred / mixed",
        "  · temporal_status：enduring / current / historical / planned / time_unknown",
        "- 他明说的话 ⇒ certainty=explicit、attribution=user_explicit。推断的 ⇒ inferred。",
        "- occurred_at：事情发生的时间，绝对日期 YYYY-MM-DD；换不出就留空。",
        "- slot：会变的同一件事填同一个稳定英文槽位名（如 current_project / sleep_schedule / identity_name），否则留空。",
        "",
        *entity_hint,
        "triples（关系型知识，s-关系-t）：",
        "- s / t 是短名词，relation 是 2~6 字。",
        "- **三个枚举字段各有各的值，不许串：**",
        "  · certainty 只能填 explicit / inferred / uncertain（**不许填 stable**，那是 stability 的值）",
        "  · attribution 只能填 user_explicit / assistant_inferred / mixed",
        "  · stability 只能填 one_off / situational / stable（**不许填 explicit**）",
        '- 只抽相对稳定的关系；一次性事件放 candidates。没有就 {"triples":[]}。',
        "",
        "pendingThreads（悬置话题）：",
        "- 只有两种情况才填：用户约定了时间；用户说了要做但还没做完。其余一律 []。",
        "- kind：promise / schedule / reminder / care / topic / other（判不出写 other）。",
        "",
        "summary 和 evidenceQuotes 里禁止出现英文双引号，用「」替代。",
    ])


def build_extract_schema() -> dict:
    """壳侧 subagents 的 outputSchema(结构由 schema 机械保证,校验仍归代码)。"""
    return {
        "type": "object",
        "additionalProperties": False,
        "required": [
            "keywords", "summary", "emotion_score", "emotion_state",
            "mood_intensity", "emotion_vector",
            "say_again", "extra_reply",
            "candidates", "triples", "pendingThreads",
        ],
        "properties": {
            "keywords": {"type": "array", "items": {"type": "string"}},
            "summary": {"type": "string"},
            "emotion_score": {"type": "number"},
            "emotion_state": {"type": "string", "enum": EMOTION_STATES},
            # 2026-10-11 修:提示词第 529 行写的是「没有称呼就填 null」,而这里
            # 只声明 `type: string` —— 模型照提示词吐出 `"name": null` 时,宿主
            # 的 outputSchema 校验把**整次调用**判非法
            # (`invalid arguments: "value.name" must be a string`),于是这一轮
            # 的情绪 / 候选 / 三元组**全部作废**。活库实测 2026-10-11 三次;
            # 成功那几次都是模型自己省略了 name(不在 required 里)。
            # ⇒ 必须与提示词对齐:字符串或 null。
            # (DSH 的 schema 子集不支持 `type: [...]` 数组,用 oneOf。)
            "name": {"oneOf": [{"type": "string"}, {"type": "null"}]},
            "mood_intensity": {"type": "number"},
            "mood_reason": {"type": "string"},
            "say_again": {"type": "number"},
            "extra_reply": {"type": "string"},
            # v0.22.0 M3:A 的 profile_update 是封闭两键;这里表达成"对象 +
            # 两个可选字符串键"(不能用 null —— 壳侧 schema 是封闭对象,
            # 所以 A 的 `null` 在这里写 `{}`,提示词里已说明)。
            "profile_update": {
                "type": "object",
                "additionalProperties": False,
                "properties": {
                    "语言": {"type": "string"},
                    "代词": {"type": "string"},
                },
            },
            "emotion_vector": {"type": "object", "additionalProperties": True},
            "candidates": {"type": "array", "items": {"type": "object", "additionalProperties": True}},
            "triples": {"type": "array", "items": {"type": "object", "additionalProperties": True}},
            "pendingThreads": {"type": "array", "items": {"type": "object", "additionalProperties": True}},
        },
    }


# ═══════════════════════════════════════════════════════════════════════
# 情绪载荷规整(M1 normalizeExtract 的移植,字段名保持壳侧兼容)
# ═══════════════════════════════════════════════════════════════════════

def normalize_extract(raw):
    """把 LLM 原始输出规整为安全值(钳位/兜底/类型修正)。"""
    src = raw if isinstance(raw, dict) else {}

    def clamp(v, lo, hi, dflt):
        try:
            n = round(float(v))
        except (TypeError, ValueError):
            return dflt
        return min(hi, max(lo, n))

    keywords = src.get("keywords")
    if not isinstance(keywords, list):
        keywords = []
    keywords = [k.strip() for k in keywords
                if isinstance(k, str) and k.strip()][:6]
    summary = str(src.get("summary") or "").strip()[:120]
    emotion_state = src.get("emotion_state") if src.get("emotion_state") in EMOTION_STATES else "neutral"
    name = src.get("name")
    name = name.strip()[:32] if isinstance(name, str) and name.strip() else None
    vec = src.get("emotion_vector")
    vec = vec if isinstance(vec, dict) else {}
    # v0.21.0 E5:情绪余波(A `main.py:965-967` 的同一套规整)。
    # 规则照抄 A:say_again 只认 1,其余一律 0;extra_reply 裁到 80 字;
    # **say_again=0 时 extra_reply 必须为空** —— 模型偶尔会两个都给,
    # 这时以 say_again 为准把台词清掉(不然壳里会出现"没说要补却在补")。
    try:
        say_again = 1 if int(float(src.get("say_again") or 0)) == 1 else 0
    except (TypeError, ValueError):
        say_again = 0
    extra_reply = str(src.get("extra_reply") or "").strip()[:80]
    if say_again == 0:
        extra_reply = ""
    # v0.22.0 M3:profile_update(A `main.py:934-955`)。白名单**在这也筛一遍**
    # (与 store.saveProfileTraits 双层防守:提示词可能被绕过,模型可能自己
    # 加键)。值裁到 60 字 —— A 记审计时就是 `str(v)[:60]`;真正的写入口
    # 还有更紧的 32 字上限,那边才是权威。
    profile_update = {}
    raw_profile = src.get("profile_update")
    if isinstance(raw_profile, dict):
        for k, v in raw_profile.items():
            key = str(k).strip()
            if key not in ("语言", "代词"):
                continue
            val = str(v or "").strip()[:60]
            if val:
                profile_update[key] = val
    return {
        "keywords": keywords,
        "summary": summary,
        "emotionScore": clamp(src.get("emotion_score"), 1, 10, 3),
        "emotionState": emotion_state,
        "name": name,
        "moodIntensity": clamp(src.get("mood_intensity"), 1, 10, _mood_default()),
        "moodReason": str(src.get("mood_reason") or "").strip()[:30],
        "emotionVector": vec,
        "sayAgain": say_again,
        "extraReply": extra_reply,
        "profileUpdate": profile_update,
    }


# ═══════════════════════════════════════════════════════════════════════
# 写入链编排(brain2 顺序保真)
# ═══════════════════════════════════════════════════════════════════════

def commit(conn, owner, structured, text, *, session_id="", now=None, dedupe=None,
           names=None):
    """三层校验 + 写入链。返回 ack dict(壳据此落画像/状态/审计)。

    structured:LLM 的合并输出(情绪载荷 + candidates + triples +
    pendingThreads,原始未规整)。
    text:用户本轮原话(悬置话题消解用)。
    dedupe(v0.16.0 M3):近重复闸阈值,透传给 episodic.insert_memory
    (`{"kwThreshold":0.6,"summaryThreshold":0.7}`,0 = 关闭)。
    (v0.29.0 个人机器人裁剪:channel / channel_chat 渠道维度随群聊
    拒收一起退役 —— 记忆不再分渠道。)
    """
    import time as _time
    now = float(now) if now else _time.time()
    extract = normalize_extract(structured)
    raw = structured if isinstance(structured, dict) else {}

    # ---- 第二层:Schema 校验 ----
    raw_candidates = raw.get("candidates")
    raw_candidates = raw_candidates if isinstance(raw_candidates, list) else []
    validated = []
    schema_rejected = 0
    for rc in raw_candidates:
        c = validate_candidate(rc)
        if c is not None:
            validated.append(c)
        else:
            schema_rejected += 1

    # ---- 第三层:代码级后过滤 ----
    filtered = post_filter_candidates(validated)
    rejected = reject_reasons(validated, filtered)

    # ---- 第四层:置信度准入闸(M2-h)----
    # <0.55 拒收 / 0.55~0.75 隔离 / ≥0.75 落库。闸在三层数字防御
    # 之后:先保证「合法」,再谈「确信」—— 非法候选不占闸的配额。
    admitted = []
    quarantined_candidates = []
    for c in filtered:
        conf = float(c.get("confidence") or 0.0)
        if conf < CONF_REJECT_BELOW:
            rejected.append({
                "layer": c.get("layer", "?"),
                "summary": (c.get("summary") or "")[:40],
                "reason": "置信度不足(<%.2f)" % CONF_REJECT_BELOW,
            })
        elif conf < CONF_QUARANTINE_BELOW:
            quarantined_candidates.append(c)
        else:
            admitted.append(c)

    raw_triples = raw.get("triples")
    raw_triples = raw_triples if isinstance(raw_triples, list) else []
    triples_valid = []
    triples_schema_rejected = 0
    for rt in raw_triples:
        it = validate_triple(rt)
        if it is not None:
            triples_valid.append(it)
        else:
            triples_schema_rejected += 1
    triples_kept, triples_dropped = post_filter_triples(triples_valid)

    raw_threads = raw.get("pendingThreads")
    raw_threads = raw_threads if isinstance(raw_threads, list) else []
    threads_kept = validate_pending_threads(raw_threads)

    # ---- ① 候选落情景库(≥0.75)----
    written = []
    mood = float(extract.get("moodIntensity") or 5)
    for candidate in admitted:
        layer = candidate.get("layer", "L2")
        c_summary = (candidate.get("summary") or "")[:120]
        c_keywords = candidate.get("evidenceQuotes") or [candidate.get("triggerText") or ""]
        c_score = int(candidate.get("confidence", 0.5) * 10)
        c_score = max(1, min(10, c_score))
        # I 由 Judge 多维字段合成 —— certainty/attribution/stability
        # 真正参与,而不是像旧版一样被丢弃(所有记忆同速消亡)。
        c_i = dmae.compute_intrinsic_value(
            layer=str(layer),
            certainty=str(candidate.get("certainty") or ""),
            attribution=str(candidate.get("attribution") or ""),
            stability=str(candidate.get("stability") or ""),
            emotion=mood,
            quote_count=len(c_keywords),
        )
        mid = episodic.insert_memory(
            conn, owner,
            json.dumps([str(k) for k in c_keywords][:6], ensure_ascii=False),
            c_summary, c_score,
            intrinsic_value=c_i,
            occurred_at=parse_abs_time(candidate.get("occurred_at")),
            temporal_status=str(candidate.get("temporal_status") or ""),
            memory_key=memory_key_of(candidate),
            layer=str(layer or ""),
            # 2026-09-30:说法键进库(检索引它扩大可撞字面;空数组 ⇒ 不加)
            aug_keys=candidate.get("askKeys") or None,
            # 2026-10-12:类型两列 —— 接住模型已经输出的 field / stability。
            # **纯落库,不参与任何判断**;认不出 ⇒ 空串(旧行为)。
            memory_type=memory_type_of(candidate),
            memory_stability=memory_stability_of(candidate),
            now=now,
            dedupe=dedupe,
        )
        written.append({
            "memoryId": mid, "layer": layer,
            "summary": c_summary[:80],
            "keywords": [str(k)[:30] for k in c_keywords][:4],
            "score": c_score, "field": candidate.get("field"),
            "I": round(c_i, 1),
            "occurredAt": str(candidate.get("occurred_at") or ""),
            "temporalStatus": str(candidate.get("temporal_status") or ""),
            "slot": str(candidate.get("slot") or ""),
        })

    # ---- ①' 隔离区(0.55~0.75):落库但 status='quarantined' ----
    # 不进检索、不进反思、不产三元组(三元组自带归因硬门,与候选
    # 置信度无关);同 slot 高置信版本后来居上时由槽位取代晋升。
    # I 照算:待观察也有自己的消亡速度,面板能翻出「她还在犹豫什么」。
    quarantined = []
    for candidate in quarantined_candidates:
        layer = candidate.get("layer", "L2")
        c_summary = (candidate.get("summary") or "")[:120]
        c_keywords = candidate.get("evidenceQuotes") or [candidate.get("triggerText") or ""]
        c_score = int(candidate.get("confidence", 0.5) * 10)
        c_score = max(1, min(10, c_score))
        c_i = dmae.compute_intrinsic_value(
            layer=str(layer),
            certainty=str(candidate.get("certainty") or ""),
            attribution=str(candidate.get("attribution") or ""),
            stability=str(candidate.get("stability") or ""),
            emotion=mood,
            quote_count=len(c_keywords),
        )
        mid = episodic.insert_memory(
            conn, owner,
            json.dumps([str(k) for k in c_keywords][:6], ensure_ascii=False),
            c_summary, c_score,
            intrinsic_value=c_i,
            occurred_at=parse_abs_time(candidate.get("occurred_at")),
            temporal_status=str(candidate.get("temporal_status") or ""),
            memory_key=memory_key_of(candidate),
            layer=str(layer or ""),
            # 2026-10-12:隔离行同样带类型(待观察也有自己的类型;纯落库)
            memory_type=memory_type_of(candidate),
            memory_stability=memory_stability_of(candidate),
            now=now,
            status="quarantined",
            dedupe=dedupe,
        )
        quarantined.append({
            "memoryId": mid, "layer": layer,
            "summary": c_summary[:80],
            "keywords": [str(k)[:30] for k in c_keywords][:4],
            "score": c_score, "field": candidate.get("field"),
            "I": round(c_i, 1),
            "confidence": float(candidate.get("confidence") or 0.0),
            "slot": str(candidate.get("slot") or ""),
        })

    # ---- ② 降级路径:无候选时按 emotion_score 门卫写轮级摘要 ----
    # 全隔离轮(written 空但 quarantined 非空)同样触发:情绪是真的,
    # 存疑的只是事实 —— 情绪痕迹照记,事实留在隔离区等确认。
    degraded = False
    if not written:
        if extract["keywords"] and extract["summary"] \
                and extract["emotionScore"] >= MIN_EMOTION_SCORE:
            mid = episodic.insert_memory(
                conn, owner,
                json.dumps(extract["keywords"], ensure_ascii=False),
                extract["summary"][:120], extract["emotionScore"],
                # 2026-10-10 修(真因):这里原来**没传 layer**,于是吃
                # `episodic.insert_memory` 的默认值 `layer=""` —— 空 layer 直接落库。
                # 活库实证那 47 行(source='private'、temporal_status='time_unknown'、
                # memory_key='')全部出自这条降级路径:
                #   · 每天都有(普通聊天轮没有候选时就走这里)⇒ 与同日带层行交错;
                #   · 不传 source ⇒ 吃默认 'private';不传 temporal_status ⇒ 吃
                #     'time_unknown';不传 memory_key ⇒ '' —— 四项特征逐一对上。
                # 危害:空 layer 在检索侧既不是 L0、也不被任何闸挡住
                # (`lib/retrieve.js:103` 只豁免 L0),于是按普通候选参与排序。
                # ⚠️ 下面回执里的 "L2(降级)" 是**只给面板看的来源标记**,与这一列
                # 不是一回事 —— 洞就是从这里活下来的(旧测试只钉了回执字符串,
                # 从没查过 DB 那一列)。
                layer="L2",
                now=now,
            )
            degraded = True
            written.append({
                "memoryId": mid, "layer": "L2(降级)",
                "summary": extract["summary"][:80],
                "keywords": [k[:30] for k in extract["keywords"][:4]],
                "score": extract["emotionScore"],
            })

    # ---- ③ 三元组落图(occurred_at 字符串 → epoch;与候选同一个 I 公式)----
    # v0.16.0 M1:边的依据 = 本轮落库的记忆 id。图与记忆两表之间
    # 从此有连线:图谱页点一条边能展开「她是从哪句话学会这件事的」。
    learned = 0
    graph_error = ""
    if triples_kept:
        try:
            graph_items = []
            for t in triples_kept:
                gi = dict(t)
                gi["occurredAt"] = parse_abs_time(t.get("occurred_at"))
                graph_items.append(gi)
            evidence_ids = [w["memoryId"] for w in written if w.get("memoryId")]
            learned = graph.learn(conn, graph_items, owner, emotion=mood,
                                  evidence_ids=evidence_ids)
        except Exception as exc:
            # 2026-10-11 修:这里原来是**裸的 `except Exception: learned = 0`** ——
            # 于是"图写失败"和"模型本来就没给三元组"在库里长得一模一样
            # (都是 learned=0、零新边、零日志),「知识图谱为什么不动」无法从
            # 任何一处查出来。现在把原因带回 ack,由壳落进审计行
            # (见 lib/engine.js 的 stageDetail)。
            learned = 0
            graph_error = str(exc)[:200]

    # ---- ③b 影子边挖边钩子(阶段 4 尾:真实写边点的那一跳)----
    # 到这一行为止,本轮"新记忆"已经落库(graph.learn 的事实边也写完了)。**每写一条
    # 新记忆就自动挖影子边**那句要在线成立,就得挂在这儿 —— 而不是只挂在
    # `worker.py:graph_learn` 那条壳侧从不发的帧上(见 4 尾的记账)。
    #
    # 纪律(与 worker 那条路同一套,由 `graph_gate.mine_after_memory_write` 负责):
    #   · 开关 = `gate_enabled()`(env ∨ loader-config ∨ 面板 `graphShadowEdges`),
    #     **默认关**;关掉时**连库都不读** ⇒ 本函数行为逐位不变;
    #   · 候选只来自**这几条刚写进去的记忆**(同记忆类),不扫全库;
    #   · 产物(L2 影子表 / 回执行)**不进下面的返回字典** ⇒ 关着时`ack` 逐位不变;
    #   · 钩子自己出错 ⇒ 吞掉 + `internal-error` 留痕,**绝不让记忆写入失败或变慢
    #     到可感知**(本函数本身不抛;外面这层 try 只是最后一道保险)。
    try:
        graph_gate.mine_after_memory_write(
            conn, [w.get("memoryId") for w in written if w.get("memoryId")],
            names=names)      # P1c:名字集合随帧进来(壳侧 names.json 下发)
    except Exception:
        pass

    # ---- ④ 悬置话题:先消解,再登记(顺序不能反)----
    threads_resolved = 0
    if text:
        resolved_id = threads.resolve_pending_thread(conn, owner, text)
        threads_resolved = 1 if resolved_id else 0
    threads_registered = 0
    for th in threads_kept[:3]:
        th_content = str(th.get("content") or "").strip()
        if not th_content:
            continue
        try:
            threads.remember_pending_thread(
                conn, owner, th_content,
                resolve_follow_up_time(th.get("follow_up_after"), now),
                session_id=session_id,
                # v0.18.2 C4:±120s 到期防重(A 侧 `main.py:2088-2094`)。
                # 命令式提醒(壳侧确定性解析)与 Judge 这条常常是同一场约定
                # 的两种说法,到期时间几乎相同;不比对就会留两条、催办两次。
                # 两侧都开这个窗,才能做到顺序无关(见 threads.py 的代价说明)。
                due_window_sec=120.0,
                # 2026-10-06 D1:类别。给的是 LLM 那一版,最终值由写入口
                # (resolve_thread_kind:规则优先)决定 —— 这里不重复判。
                kind=str(th.get("kind") or ""),
            )
            threads_registered += 1
        except Exception:
            continue

    # ---- ⑤ preferredName / language 交壳落画像(只认已采信候选)----
    # 隔离候选不采信:0.6 置信的称呼不该改她的画像 —— 隔离就是隔离。
    #
    # v0.22.0 M3:画像现在有**两个产出端** —— 模型显式写的 profile_update
    # (封闭两键)与这里从 L0 候选派生的一路。合并顺序照 A
    # (`main.py:952-955`:`profile_update.update(judge_profile)`,派生的覆盖
    # 模型给的):派生值来自"已采信候选",比模型自由发挥更硬。
    name = _clean_name(extract.get("name"))
    profile_update = dict(extract.get("profileUpdate") or {})
    derived = {}
    for c in admitted:
        if c.get("layer") != "L0" or not c.get("field"):
            continue
        field = str(c["field"])
        summary = c.get("summary") or ""
        if field == "preferredName":
            if not name:
                name = _clean_name(summary)
        elif field == "language":
            derived["语言"] = summary
        # occupation / longTermInterests / permanentNote 不进画像:
        # 它们已作为 L0 情景记忆落库,需要时会被检索出来。
    profile_update.update(derived)

    stats = {
        "rawCount": len(raw_candidates),
        "schemaValid": len(validated),
        "schemaRejected": schema_rejected,
        "written": len(written),
        "quarantined": len(quarantined),
        "rejected": len(rejected),
        "degraded": degraded,
        "triplesRaw": len(raw_triples),
        "triplesSchemaRejected": triples_schema_rejected,
        "triplesWritten": len(triples_kept),
        "triplesRejected": len(triples_dropped),
        "graphError": graph_error,
        "threadsRaw": len(raw_threads),
        "threadsKept": len(threads_kept),
        "threadsRegistered": threads_registered,
        "threadsResolved": threads_resolved,
    }
    return {
        "written": written,
        "quarantined": quarantined,
        "rejected": rejected,
        "triplesRejected": triples_dropped,
        "learned": learned,
        "graphError": graph_error,
        "threadsRegistered": threads_registered,
        "threadsResolved": threads_resolved,
        "name": name if isinstance(name, str) and name.strip() else None,
        "profileUpdate": profile_update,
        "extract": extract,
        "stats": stats,
    }
