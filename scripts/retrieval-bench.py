# -*- coding: utf-8 -*-
"""检索对照测台 v2 —— 六路机械算法同时算,用真实语料量出各自的账。

用法:
    python scripts/retrieval-bench.py                 # 自动拷一份活库出来跑
    python scripts/retrieval-bench.py --verbose       # 逐条打印查询 / 期望答案 / 各路返回
    python scripts/retrieval-bench.py --db <路径>     # 指定库(只读打开)

============================================================================
v2 改了什么:v1 的金标是「照答案出的题」—— 先看完库里所有记忆,再回头写查询,
结果题面词元 **69.8% 直接来自答案记忆**(本文件 LEGACY_GOLDEN 实测复现)。
这是方向性偏差:它专门偏向词面(字面)检索方法,把所有分数一起抬高了。
对照现实:用户真实说过的话在语料里平均只有约三成词面钩子。

v2 按「题目先于答案」(query-first)重建评测集,并把偏差本身变成要报的数。

数据集构造(v2 三条来源):
  1) **逐字档** —— 查询文本在运行时从 conversation_log.user_text **逐字取出**:
     去机器提示词噪声 → 去渠道前缀 → 2~40 字 → 去重。脚本里**没有一个字**
     是手写进查询的,所以「为了让某条查询能命中而改查询文本」在结构上不可能。
  2) **补题档** —— 按 LongMemEval / LoCoMo 的题型配额补「人话」问法
     (单会话事实 / 多会话 / 时间推理 / 知识更新 / 矛盾消解 / 偏好)。
     补题同样不许照答案写词面(不许把摘要里的词抄进查询)。
  3) **负控档** —— 逐字档里**指认不出答案**的查询自动落进这一档,答案是空集;
     另附 v1 的三条旧负控作对照。

硬性约束:每条正样本查询都必须能在库里指认出可接受的 memory_id 集合;
指认不出来的查询**不收进正样本**(它们只会进负控档)。

指标(v2 新增,分档报数):
  * recall@5        按档分别报,不只给一个总数 —— 否则分不清哪一档在退步
  * 可达率          对**每一条**现役记忆(分母=全部记忆,不受出题偏好影响),
                    用它自己的弱线索当查询,看能否在 top5 里找回它自己
  * 硬塞率          负控/闲聊档里,L0 强制占位记忆被当成「相关记忆」返回的比例
  * 偏差体检 M1    题面词元出自答案的比例(v1 = 69.8%)
  * 偏差体检 M2    真实问法在语料里的词面钩子率(v1 对照 = 30.7%)
  * 零命中率 / 冗余率 / 单次耗时(沿用 v1)
  * MRR@10 / NDCG@5 / 首答位次中位 / SEH@3 / 装下k中位
                   (2026-09-30 修的尺子:**顺序敏感 + 白盒支撑** —— 上一版只有
                    「集合覆盖」,对同一集合内换序无感,会漏掉「只重排、不动召回」
                    的正收益改动;SEH@3 取自 MemConflict 的白盒口径)
  * 失败分解        召回失败 / 排序失败 / 成功(把原来的「零命中率」拆成两类:
                    完全进不了池子 vs 进了池子但排不进 top5)

设计原则(与 v1 相同):
  * **只读**。默认把活库拷到临时目录再跑;FTS 索引建在独立内存库,原库全程零写入。
  * **零第三方依赖**。BM25 自己写,另一路走 SQLite 内置 FTS5(宿主自己也在用)。
  * **R0 直接调用生产代码** `engine.retrieve.rank_memories`,保证「基线」跑的
    就是线上那套,不是我以为的那套。

六路(v1 原样保留,一个字没动):
  R0 现状       字面包含 + hits*2 + R*2 + 情感*0.1(生产代码,含 L0 强制占位)
  R1 BM25正文   NFKC + CJK 二字组合 + Okapi BM25(idf / tf饱和 / 长度归一)
  R2 FTS5       同一套词元,候选扫描与排序交给 SQLite FTS5 + bm25()
  R3 RRF同族    融合 R0+R1 —— **两路都是字面匹配,信号高度相关**
  R4 RRF异族    融合 R1 + 图谱通道 —— 两个不同来源
  R5 R1+去冗余  R1 之后做近重复抑制,把 top5 还给不同的事实
"""

import argparse
import json
import math
import os
import re
import shutil
import sqlite3
import sys
import tempfile
import time
import unicodedata

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(ROOT, "python"))

from engine import retrieve as prod_retrieve  # noqa: E402  R0 用生产代码
from engine import fusion as fusion_mod  # noqa: E402  RT10
from engine import synonyms as synonyms_mod  # noqa: E402  RT11
SYNONYMS = None  # RT11:main() 里按 --synonyms 从 graph_aliases 建表
EXPANSIONS = {}  # RT11b:大模型给的查询扩展(问句 → 扩展词元),从 JSON 读
EXPAND_STAT = {}  # RT11b:扩展臂**决策层**计数(不是"进榜才算")
RESCUE_STAT = {"seen": 0, "rescued": 0, "rescued_top5": 0, "any": 0}  # RT11:这一跑到底捞回几条
FUSION = None  # RT10:main() 里按 --fusion 赋值;模块级默认"老路"
# BM25 vs Embedding 最小验证(2026-10-11):`--dense <npz>` 挂上纯余弦臂 R9Dense。
# 默认 None ⇒ 不挂这一路,`methods` 里也不会出现它 ⇒ 老读数逐位不变(负控)。
DENSE = None

TOP_K = 5
RRF_K = 60
K1 = 1.2
B = 0.75
SEG_RE = re.compile(r"[，。！？、；：\s\"'“”‘’（）《》,.!?;:()\[\]{}]+")

CJK_RE = re.compile(r"[\u3400-\u9fff\uf900-\ufaff]+")
LATIN_RE = re.compile(r"[a-z0-9._\-/+]+")

# ============================================================ 一、取题(query-first)
# ---------------------------------------------------------------- 1.1 逐字档
# 机器文本噪声:这些是宿主/子 agent/审查器/反思模块的提示词,被误记成「他说的话」。
# 必须排除 —— 它们不是用户真实说过的话,拿它们当查询等于自己给自己出送分题。
NOISE_MARKERS = [
    "你是一个严格的", "只读", "禁止修改任何文件", "Background subagent", "你分析用户",
    "你是只读", "你在为项目", "Almost Full Access", "Current runtime context",
    "## 背景", "你是", "没写字", "发来1张图",
]

# 渠道前缀:【QQ·私聊】阿岚说: / 【QQ·群聊】…: / 【QQ·私聊】…
CHANNEL_TAG_RE = re.compile(r"^\u3010[^\u3011]*\u3011")
SPEAKER_COLON_RE = re.compile(r"^[^:：\n]{0,12}[:：]")

VERBATIM_MIN = 2      # 查询长度下限(字)
VERBATIM_MAX = 40     # 查询长度上限(字)


def clean_verbatim(raw):
    """把一条 conversation_log.user_text 洗成「他原样说过的一句话」。

    只做减法,不做改写:去机器注记行 → 去渠道前缀 → 去说话人前缀。
    返回 None 表示这条不是「他真实说过的话」。
    """
    s = str(raw or "").strip()
    if not s:
        return None
    # 先去掉宿主/桥接插件加的注记行(例:「(他发来1张图 —— 图就在下面,你看得到)」),
    # 再判噪声 —— 否则「这是谁」这种真话会被它自己那行注记一起带走。
    lines = [ln for ln in s.split("\n") if not ln.strip().startswith("(他")]
    s = "\n".join(lines).strip()
    if not s:
        return None
    if any(m in s for m in NOISE_MARKERS):
        return None
    s = CHANNEL_TAG_RE.sub("", s).strip()          # 【QQ·私聊】
    m = SPEAKER_COLON_RE.match(s)                  # 阿岚说:
    if m:
        s = s[m.end():].strip()
    s = s.strip()
    if not (VERBATIM_MIN <= len(s) <= VERBATIM_MAX):
        return None
    return s


def extract_verbatim(conn):
    """从 conversation_log.user_text 逐字取题。**这里不写题,只挑题。**"""
    try:
        rows = conn.execute(
            "SELECT turn_id, user_text FROM conversation_log ORDER BY turn_id"
        ).fetchall()
    except sqlite3.Error:
        return []
    seen, out = set(), []
    for turn_id, raw in rows:
        q = clean_verbatim(raw)
        if not q or q in seen:
            continue
        seen.add(q)
        out.append((q, int(turn_id)))
    return out


# ---------------------------------------------------------------- 1.2 逐字档的答案指认
# **持久化存储**(2026-10-11 Step 2.5):指认不再硬编码在本文件里,改从
# `scripts/retrieval-gold.json` 读。
#
# 为什么改:原来键 = 查询原文,而 `conversation_log` 只保留最近 100 轮 ——
# 句子一滚掉,那条金标就**静默消失**(旧版只打一行 WARN)。2026-10-11 实测:
# 2026-09-29 那批 8 条指认全部因滚掉而失效。
#
# 持久化之后**问句原文随指认一起冻结** ⇒ 句子滚出日志也能复跑。实测那 8 条
# 涉及的 15 个 memory_id **全部仍在现役语料里**(is_active=1)⇒ 加
# `--gold-orphans` 即可把它们重新纳入判据(默认不加,见 build_golden)。
#
# ⚠️ 读不到存储 ⇒ **抛错**,绝不静默降级成"一条指认都没有" ——
# 那会把所有逐字档变成负控,而读数看起来只是"变差了",没人查得出原因。
GOLD_SCHEMA = "echo.retrieval.gold.v2"
GOLD_PATH = os.path.join(HERE, "retrieval-gold.json")


def _gold_entries(raw, key, path):
    """把一个列表段读成 [(档位, query, frozenset(ids), 依据)];形状不对 ⇒ 抛错。"""
    entries = raw.get(key)
    if not isinstance(entries, list) or not entries:
        raise ValueError("金标存储里没有 %s 条目: %s" % (key, path))
    out = []
    for idx, e in enumerate(entries):
        if not isinstance(e, dict):
            raise ValueError("金标存储 %s[%d] 不是对象: %s" % (key, idx, path))
        q = str(e.get("query") or "")
        tier = str(e.get("tier") or "")
        acc = e.get("accept")
        if q == "" or tier == "" or not isinstance(acc, list) or not acc:
            raise ValueError("金标存储 %s[%d] 缺 query/tier/accept: %s" % (key, idx, path))
        out.append((tier, q, frozenset(int(x) for x in acc), str(e.get("why") or "")))
    return out


def load_gold_store(path=None):
    """读持久化金标存储(v2)。

    返回 `{"verbatim": {查询原文: (档位, frozenset(ids), 依据)},
           "supplement": [(档位, 查询, frozenset(ids), 依据)]}`。

    v2 起**全部金标都在这一个文件里**:`verbatim`(逐字档,键=冻结的问句原文)
    与 `supplement`(补题档,手写问法)。测台只读它,不再有第二处硬编码。
    读不到 / schema 不符 / 条目形状不对 ⇒ 抛错(理由见上方注释)。
    """
    p = path if path else GOLD_PATH
    with open(p, encoding="utf-8") as fh:
        raw = json.load(fh)
    if not isinstance(raw, dict) or raw.get("schema") != GOLD_SCHEMA:
        raise ValueError("金标存储 schema 不符(期望 %s): %s" % (GOLD_SCHEMA, p))
    verbatim = {}
    for tier, q, acc, why in _gold_entries(raw, "verbatim", p):
        if q in verbatim:
            raise ValueError("金标存储 verbatim 里 query 重复: %r" % q)
        verbatim[q] = (tier, acc, why)
    supplement = _gold_entries(raw, "supplement", p)
    dup = set(verbatim) & {q for _, q, _, _ in supplement}
    if dup:
        raise ValueError("金标存储里 verbatim 与 supplement 撞了: %r" % sorted(dup)[:3])
    return {"verbatim": verbatim, "supplement": supplement}


# ---------------------------------------------------------------- 1.3 补题档(题型配额)
# 补题用「人话」问法,不照抄记忆里的词面。题型分类学借 LongMemEval / LoCoMo。
#
# 2026-10-11 扩样:**搬进持久化存储**(`retrieval-gold.json` 的 `supplement` 段)。
# 为什么搬:原来它硬编码在这里、而逐字档在存储里 ⇒ 判据的**唯一事实源不是一个文件**,
# 没法一次对账。v2 起测台只读存储,这里不再有第二处。

# ---------------------------------------------------------------- 1.4 负控/闲聊档
# 逐字档里「指认不出答案」的查询**自动**落进这一档(见 build_golden),
# 答案为空集 —— 这时正确行为是**不返回任何记忆**。
# 另附 v1 的三条旧负控,用于和「现状 3/3 全中」的硬塞率对照。
LEGACY_NEGATIVES = [
    ("N0 闲聊/负控", "量子纠缠", set(), "旧金标负控(v1)"),
    ("N0 闲聊/负控", "明天股价", set(), "旧金标负控(v1)"),
    ("N0 闲聊/负控", "他养的那只猫", set(), "旧金标负控(v1)"),
]

# ---------------------------------------------------------------- 1.5 v1 旧金标(仅作偏差对照)
# 保留的唯一目的是让读者在本机复现「v1 的 M1 = 69.8%」,证明 v2 的偏差体检口径
# 与 v1 是同一把尺子。**不作为 v2 的评测集使用。**
LEGACY_GOLDEN = [
    ("章鱼小丸子", {2, 3, 7, 99, 142, 143, 169}),
    ("校园跑", {21, 22, 23, 31, 33, 104, 110, 141, 153, 158, 175, 204}),
    ("耳朵疼", {41, 44, 48, 105, 154, 163}),
    ("风又音理", {97, 125, 176}),
    ("方便面", {15, 20, 101, 112, 147, 148}),
    ("软件工程", {89, 121, 177}),
    ("月饼", {181, 182, 183, 187, 188}),
    ("数据结构", {82, 168}),
    ("洗澡", {86, 123}),
    ("一千美元", {79, 83, 167, 198, 211}),
    ("3km", {31, 33, 104, 153, 158, 163, 175}),
    ("真白", {236, 242}),
    ("赏月", {210, 213, 220, 222, 226}),
    ("忙活五天", {11, 13, 16, 17, 101, 145, 148, 151, 159}),
    ("跑完", {54, 58, 59, 60, 62, 163}),
    ("技术力", {132, 134, 170, 174}),
    ("他上的什么学校", {107, 111, 121}),
    ("他为什么讨厌排队", {183, 184, 187, 188}),
    ("他把钱花哪了", {198, 203, 206, 208, 211}),
    ("他昨天几点睡的", {213, 228, 231}),
    ("他为什么说自己技术不行", {132, 134, 170, 174}),
    ("他是不是有点孤单", {47, 57, 111, 162}),
    ("西电那边怎么样", {107, 111, 121, 89, 177}),
    ("章鱼小丸子他会做吗", {3, 7, 99, 143, 169}),
    ("量子纠缠", set()),
    ("明天股价", set()),
    ("他养的那只猫", set()),
]

OLD_M1 = 69.8     # v1 金标的「题面词元出自答案」比例(本脚本可复现)
OLD_M2 = 30.7     # v1 记的「真实问法词面钩子率」;见报告里的口径说明

POSITIVE_TIERS = ["N1 单会话事实", "N2 多会话", "N3 时间推理",
                  "N4 知识更新", "N5 矛盾消解", "N6 偏好"]
NEGATIVE_TIER = "N0 闲聊/负控"
TIER_SHORT = {
    "N1 单会话事实": "N1事实", "N2 多会话": "N2多会话", "N3 时间推理": "N3时间",
    "N4 知识更新": "N4更新", "N5 矛盾消解": "N5矛盾", "N6 偏好": "N6偏好",
    NEGATIVE_TIER: "N0负控",
}


def build_golden(verbatim, store=None, include_orphans=False):
    """逐字取到的题 → 金标。

    * 有答案指认的 → 按指认进对应档(查询文本**原样**来自 conversation_log);
    * 没指认出来的 → 自动进负控档(答案空集)。
    结构性保证:不可能为了让某条查询命中而改查询文本 —— 这里根本没有写题的地方。

    2026-10-11 Step 2.5:指认改从**持久化存储**读(见 §1.2 的 `load_gold_store`);
    `store=None` 时现读存储。
    2026-10-11 扩样:v2 起**补题档也从存储的 `supplement` 段读**。

    `include_orphans`:
      * **False(默认)** —— 已滚出 `conversation_log` 的存档指认只进 `warn`
        (报"取不到"),**不进判据** ⇒ 与改造前**逐位一致**(负控就靠这条);
      * **True** —— 把它们也纳入判据(问句原文取自存储里的**冻结副本**,
        `turn=None` 且带 `archived: True` 标记)⇒ 判据规模会变大,那是**读数变化**。
    """
    if store is None:
        store = load_gold_store()
    answers = store["verbatim"]
    golden, used = [], set()
    warn = []
    for q, turn_id in verbatim:
        spec = answers.get(q)
        if spec:
            tier, accept, why = spec
            golden.append({"tier": tier, "query": q, "accept": set(accept),
                           "source": "逐字", "note": why, "turn": turn_id})
            used.add(q)
        else:
            golden.append({"tier": NEGATIVE_TIER, "query": q, "accept": set(),
                           "source": "逐字", "note": "逐字取到但指认不出答案 ⇒ 负控",
                           "turn": turn_id})
    orphans = [q for q in answers if q not in used]
    if include_orphans:
        for q in orphans:
            tier, accept, why = answers[q]
            golden.append({"tier": tier, "query": q, "accept": set(accept),
                           "source": "逐字", "note": why, "turn": None,
                           "archived": True})
    else:
        warn.extend(orphans)
    for tier, q, acc, why in store["supplement"]:
        golden.append({"tier": tier, "query": q, "accept": set(acc),
                       "source": "补题", "note": why, "turn": None})
    for tier, q, acc, why in LEGACY_NEGATIVES:
        golden.append({"tier": tier, "query": q, "accept": set(acc),
                       "source": "旧负控", "note": why, "turn": None})
    return golden, warn


# ============================================================ 二、词元(v1 原样)
def normalize(text):
    return unicodedata.normalize("NFKC", str(text or "")).lower()


STOPWORDS = set("""
什么 为什么 怎么 怎么样 怎样 是不是 有点 那边 这边 那里 这里 一下 一个 时候
吗 呢 的 了 他 她 我 你 它 您 我们 你们 他们 她们 和 与 及 在 是 有 没有 不 没 这 那
就 都 也 很 太 还 才 又 再 只 被 把 给 让 对 从 到 向 为 以 于 而 且 或 但 却 因 所
要 会 能 可以 应该 想 知道 觉得 说 说 觉得 如果 因为 所以 但是 而且 然后 现在 今天
明天 昨天 时候 一直 已经 正在 还是 就是 这个 那个 这些 那些 咱们 人家 自己 什么 哪里
为啥 干嘛 多少 几点 哪个 哪些 吗 吧 啊 呀 哦 嗯 哈 啦啦 诶 唉
""".split())


def tokenize(text):
    """NFKC + 小写 + CJK 连续段切二字组合(段内保留整串) + Latin/数字标识符。

    与参考实现(dsh-auto-memory `shadow-retrieval.js:186`)的两处一致:
      * **单字 CJK 丢弃** —— 只靠二字组合与整串,单字噪声大(「吗」「的」「了」)。
      * **停用词过滤** —— 实测教训:「他上的什么学校」里 `什么/为什/么学`
        这些疑问词会命中一堆无关记忆,不加停用词表时那条查询全军覆没。
    """
    t = normalize(text)
    out = []
    for run in CJK_RE.findall(t):
        for i in range(len(run) - 1):
            out.append(run[i:i + 2])
        if 2 <= len(run) <= 16:
            out.append(run)
    for m in LATIN_RE.findall(t):
        if len(m) > 1 or m.isdigit():
            out.append(m)
    return [x for x in out if x not in STOPWORDS]


def uniq_terms(text):
    out, seen = [], set()
    for t in tokenize(text):
        if t not in seen:
            seen.add(t)
            out.append(t)
    return out


# ============================================================ 三、语料
def load_rows(conn):
    rows = []
    for r in conn.execute(
        "SELECT memory_id, keywords, summary, emotion_score, timestamp, layer,"
        " intrinsic_value, half_life, recall_count, last_recalled,"
        " occurred_at, learned_at, temporal_status"
        " FROM episodic_memory WHERE is_active = 1"
    ):
        (mid, kw, summ, emo, ts, layer, iv, hl, rc, lr, oa, la, tst) = r
        try:
            kws = json.loads(kw) if kw else []
            if not isinstance(kws, list):
                kws = []
        except (TypeError, ValueError):
            # 反射层写的是逗号串 —— 与生产代码 parse_keywords 同规则
            kws = [s.strip() for s in re.split(r"[,，、]", str(kw or "")) if s.strip()]
        rows.append({
            "memory_id": mid, "keywords": kws, "summary": str(summ or ""),
            "emotion_score": emo or 0, "timestamp": ts or 0,
            "layer": layer or "", "intrinsic_value": iv or 0.0,
            "half_life": hl or 0.0, "recall_count": rc or 0,
            "last_recalled": lr or 0,
            "occurred_at": oa or 0.0, "learned_at": la or 0.0,
            "temporal_status": tst or "time_unknown",
        })
    return rows


def doc_text(row):
    """索引正文 = 摘要 + 关键词。这是本方案的核心主张:
    只索引抽取器写的 keywords 会漏,必须索引正文本身。"""
    return str(row.get("summary") or "") + " " + " ".join(
        str(k) for k in (row.get("keywords") or []))


# ============================================================ 四、BM25(v1 原样)
class BM25:
    def __init__(self, rows):
        self.rows = rows
        self.docs = [tokenize(doc_text(r)) for r in rows]
        self.tfs = []
        self.df = {}
        total = 0
        for toks in self.docs:
            tf = {}
            for t in toks:
                tf[t] = tf.get(t, 0) + 1
            self.tfs.append(tf)
            total += len(toks)
            for t in tf:
                self.df[t] = self.df.get(t, 0) + 1
        self.N = max(1, len(rows))
        self.avgdl = (total / self.N) or 1.0

    def idf(self, term):
        df = self.df.get(term, 0)
        return math.log(1 + (self.N - df + 0.5) / (df + 0.5))

    def rank(self, query):
        """idf 加权覆盖率(归一化到 [0,1]) —— 抄 auto-memory 的骨架。"""
        terms = uniq_terms(query)
        if not terms:
            return []
        total_idf = sum(self.idf(t) for t in terms) or 1.0
        scored = []
        for i, row in enumerate(self.rows):
            tf, dl = self.tfs[i], max(1, len(self.docs[i]))
            hit = 0.0
            for t in terms:
                f = tf.get(t, 0)
                if not f:
                    continue
                sat = (f * (K1 + 1)) / (f + K1 * (1 - B + B * dl / self.avgdl))
                hit += self.idf(t) * (sat / (K1 + 1))
            if hit <= 0:
                continue
            scored.append((hit / total_idf, row["memory_id"]))
        scored.sort(key=lambda p: (-p[0], p[1]))
        return scored


# ============================================================ 五、FTS5(v1 原样)
def build_fts5(rows):
    """在**独立内存库**里建 FTS5 索引 —— 源库在任何情况下都只读。"""
    conn = sqlite3.connect(":memory:")
    conn.execute("CREATE VIRTUAL TABLE f USING fts5(body, tokenize='unicode61')")
    conn.executemany(
        "INSERT INTO f(rowid, body) VALUES (?, ?)",
        [(r["memory_id"], " ".join(tokenize(doc_text(r)))) for r in rows],
    )
    conn.commit()
    return conn


def fts5_rank(conn, query):
    """同一套词元,但扫描+排序交给 SQLite FTS5(零依赖,宿主自己也在用)。"""
    terms = uniq_terms(query)
    if not terms:
        return []
    expr = " OR ".join('"%s"' % t.replace('"', '""') for t in terms)
    try:
        got = conn.execute(
            "SELECT rowid, bm25(f) FROM f WHERE f MATCH ? ORDER BY bm25(f) LIMIT ?",
            (expr, TOP_K * 4),
        ).fetchall()
    except sqlite3.OperationalError:
        return []
    return [(float(-score), int(rid)) for rid, score in got]


# ============================================================ 六、RRF(v1 原样)
def rrf(lists, weights=None):
    """Reciprocal Rank Fusion:分数不可比,只看名次。"""
    acc = {}
    for li, lst in enumerate(lists):
        w = 1.0 if not weights else weights[li]
        for rank, (_, mid) in enumerate(lst, start=1):
            acc[mid] = acc.get(mid, 0.0) + w / (RRF_K + rank)
    out = sorted(acc.items(), key=lambda p: (-p[1], p[0]))
    return [(s, mid) for mid, s in out]


# ============================================================ 七、图谱通道(v1 原样)
def graph_channel(db_path, query, bm):
    """查词命中图节点 ⇒ 邻居名进扩展词 ⇒ 用扩展词再检索一遍。

    接口形状(已核对 graph.py):`load` 返回 (by_id, by_name, edges),
    by_* 里存的是**节点字典**,`match_seeds_to_graph` 返回**名字列表**。
    """
    try:
        from engine import graph
    except Exception:
        return [], []
    conn = None
    try:
        conn = sqlite3.connect("file:%s?mode=ro" % db_path.replace("\\", "/"), uri=True)
        by_id, by_name, edges = graph.load(conn, "master")
        if not by_name:
            return [], []
        seeds = [s for s in SEG_RE.split(query) if s] + [query]
        hits = graph.match_seeds_to_graph(seeds, by_name)
        if not hits:
            return [], []
        seed_ids = {by_name[n]["node_id"] for n in hits if n in by_name}
        extra = []
        for e in edges:
            if int(e.get("is_active", 1)) != 1:
                continue          # 不沿已归档的边扩散
            for a, b in ((e.get("source_id"), e.get("target_id")),
                         (e.get("target_id"), e.get("source_id"))):
                if a in seed_ids:
                    nb = by_id.get(b)
                    nm = nb.get("name") if isinstance(nb, dict) else None
                    if nm and nm not in extra and nm not in hits:
                        extra.append(str(nm))
        if not extra:
            return [], hits
        return [mid for _, mid in bm.rank(query + " " + " ".join(extra[:8]))], extra
    except Exception as exc:
        print("    (图谱通道异常已忽略: %s)" % exc)
        return [], []
    finally:
        if conn:
            conn.close()


# ============================================================ 八、去冗余(v1 原样)
def near_dup(a, b, thresh=0.55):
    sa, sb = set(tokenize(a)), set(tokenize(b))
    if not sa or not sb:
        return False
    return len(sa & sb) / len(sa | sb) >= thresh


def dedup(rows_by_id, ranked, k):
    picked = []
    for _, mid in ranked:
        text = str(rows_by_id.get(mid, {}).get("summary") or "")
        if any(near_dup(text, str(rows_by_id.get(p, {}).get("summary") or ""))
               for p in picked):
            continue
        picked.append(mid)
        if len(picked) >= k:
            break
    return picked


def redundancy(rows_by_id, top_ids):
    picked, dup = [], 0
    for mid in top_ids:
        text = str(rows_by_id.get(mid, {}).get("summary") or "")
        if any(near_dup(text, str(rows_by_id.get(p, {}).get("summary") or ""))
               for p in picked):
            dup += 1
        picked.append(mid)
    return dup, len(top_ids)


# ============================================================ 九、新指标
def doc_terms(rows_by_id, mid):
    row = rows_by_id.get(mid)
    return set(tokenize(doc_text(row))) if row else set()


def corpus_terms(rows, mode="full"):
    """语料词元集合。mode=full(摘要+关键词) / summary(只摘要)。"""
    out = set()
    for r in rows:
        out |= set(tokenize(doc_text(r) if mode == "full" else r["summary"]))
    return out


def bias_m1(golden, rows_by_id):
    """M1 = 题面词元出自答案的比例。

    对每条正样本: |tokens(查询) ∩ tokens(期望答案的所有记忆)| / |tokens(查询)|,
    再对样本取平均。v1 的同一口径实测 = 69.8%(见 LEGACY_GOLDEN 的复现)。
    """
    vals = []
    for g in golden:
        if not g["accept"]:
            continue
        qt = uniq_terms(g["query"])
        if not qt:
            continue
        at = set()
        for mid in g["accept"]:
            at |= doc_terms(rows_by_id, mid)
        vals.append(sum(1 for t in qt if t in at) / len(qt))
    return (100.0 * sum(vals) / len(vals) if vals else 0.0), len(vals)


def bias_m2(queries, corpus):
    """M2 = 真实问法在语料里的词面钩子率(逐条取平均)+ 零钩子查询占比。"""
    vals = []
    for q in queries:
        qt = uniq_terms(q)
        vals.append(0.0 if not qt else
                    sum(1 for t in qt if t in corpus) / len(qt))
    if not vals:
        return 0.0, 0.0, 0
    zero = 100.0 * sum(1 for v in vals if v == 0.0) / len(vals)
    return 100.0 * sum(vals) / len(vals), zero, len(vals)


REACH_MAIN = ["前缀半句", "中段", "尾段"]      # 计入总可达率的三个口径
REACH_WEAK = "二字窗"                          # 最弱口径,单独一列,不混进总可达率


def weak_clues(row):
    """一条记忆自己的「弱线索」—— 故意只给一小片,考验方法能不能把它找回来。

    三个主口径(都只从摘要里取一小段,比整条记忆弱得多):
      前缀半句  摘要开头 8 字
      中段     摘要 1/3 处起 8 字
      尾段     摘要最后 8 字
    外加一个最弱口径,单独报:
      二字窗    摘要里第一个**不属于该条自身关键词**的二字组合(约等于随手一指)

    诚实声明:这几片都是被索引正文的**子串**,所以词面方法天然占便宜;
    总可达率量的其实是「自找回 + 近重复排序」,不是语义泛化(见文末局限)。
    """
    s = str(row.get("summary") or "").strip()
    if not s:
        return []
    out = [("前缀半句", s[:8]), ("中段", s[len(s) // 3:len(s) // 3 + 8]),
           ("尾段", s[-8:])]
    kw_terms = set()
    for k in (row.get("keywords") or []):
        kw_terms |= set(tokenize(str(k)))
    pick = ""
    for i in range(len(s) - 1):
        bg = s[i:i + 2]
        if not CJK_RE.fullmatch(bg) and not bg.strip():
            continue
        if bg not in kw_terms and bg.strip():
            pick = bg
            break
    out.append((REACH_WEAK, pick or s[:2]))
    return [(k, v) for k, v in out if len(v) >= 2]


# ============================================================ 十、主流程
def _norm_q(t):
    return " ".join(str(t).split())


def lookup_expansions(q):
    """RT11b:查扩展表 —— **先在两边都规整化,再做包含匹配**。

    起因:第一次查表 838 次命中 0,而表里明明有 `这是谁` 这种键 ⇒ 说明**两边的字符串
    不是逐字相同的**(行首/行尾空白、渠道前缀一类)。量尺不许因为空白就判成"没有子弹":
    规整化之后仍不命中,才算真的没有。
    """
    if not EXPANSIONS:
        return None
    k = _norm_q(q)
    if not k:
        return None
    for cand in (k, k.strip()):
        if cand in EXPANSIONS:
            return EXPANSIONS[cand]
    for key, val in EXPANSIONS.items():
        if key and (key in k or k in key):
            return val
    return None

POOL_K = 20

# RT11 第三刀:R6 自己的捞人计数 —— **与 EXPAND_STAT 分开**(共用会把 828 查表记账翻倍,
# 但不传就看不见 R6 到底有没有 fire;2026-09-29 就踩过这个坑)。
R6_STAT = {}

# 时间臂(R7,2026-09-30):自己的救回计数 —— 与 EXPAND_STAT/R6_STAT 分开,互不翻倍。
TIME_STAT = {}


class DenseNotEncoded(RuntimeError):
    """查询**没有向量** —— 不是"没命中",是"没编码"。

    2026-10-12 实测事故:Step 5 扩样新增了 29 条查询(2 逐字 + 27 补题),
    但没有重跑编码脚本 ⇒ `dense_rank()` 静默返回 `[]`,测台把空返回记成"未命中"。
    后果:Dense 的读数从 **87.2% 掉到 51.5%**(27/66 条是构造性 0 分),
    而**全程没有任何报错**。这是最贵的一类失败 —— 读数看起来只是"变差了",
    没人查得出原因。所以本类存在的唯一目的是:**让这件事响亮地失败**。
    """


def load_dense(path):
    """读 Step 1 的编码产物(.npz:doc_ids / doc_vecs / q_keys / q_vecs / meta)。

    numpy 是**惰性 import** —— 测台本体仍是零第三方依赖,R0..R8 不碰它。
    `meta` 一并读进来(模型名 / 编码时间 / 条数),供 `DenseNotEncoded` 报错时交代上下文。
    """
    import numpy as np
    z = np.load(path, allow_pickle=False)
    keys = [str(s) for s in z["q_keys"]]
    meta = {}
    if "meta" in z:
        try:
            raw = z["meta"]
            meta = json.loads(str(raw[0] if len(raw) else "{}"))
        except (TypeError, ValueError, IndexError):
            meta = {}
    return {
        "doc_ids": z["doc_ids"],
        "doc_vecs": z["doc_vecs"],
        "q_vecs": z["q_vecs"],
        "index": {k: i for i, k in enumerate(keys)},
        "dim": int(z["doc_vecs"].shape[1]),
        "meta": meta if isinstance(meta, dict) else {},
    }


def _dense_index_of(q):
    """查查询向量在表里的下标。**查不到 ⇒ 抛 `DenseNotEncoded`**,不静默返回空。

    报错内容必须够定位:哪条查询、向量表是什么、什么时候编码的、表里有多少条。
    """
    idx = DENSE["index"].get(_norm_q(q))
    if idx is None:
        meta = DENSE.get("meta") or {}
        raise DenseNotEncoded(
            "查询没有向量(不是「没命中」,是**没编码**):%r\n"
            "  向量表: %s  · 编码于 %s  · 表里 %d 条查询\n"
            "  修法: 重跑 .scratch/dense-bench/encode_dense.py"
            "(它按**当前金标**重新编码全部查询,然后重跑测台)"
            % (q, meta.get("model", "(未知模型)"), meta.get("encoded_at", "(未知时间)"),
               len(DENSE["index"])))
    return idx


def dense_rank(q):
    """R9Dense:**纯余弦**排序。

    与 R1BM25 **对称** —— 两者都是纯排序器,都没有别的信号:
      · 不含 L0 强制占位(那是 R0 的特性);
      · 不含 recency / emotion / intrinsic_value 加权;
      · 同一份 doc_text(summary + keywords)、同一 TOP_K / POOL_K。
    查询在表里查不到 ⇒ **抛错**(见 `DenseNotEncoded`),绝不静默返回空。

    ⚠️ 查表必须在 `import numpy` **之前** —— 这样"缺向量"的判定不依赖 numpy,
    在零依赖的解释器里也测得出、报得出(与"测台本体零第三方依赖"同一条纪律)。
    """
    if DENSE is None:
        return []
    idx = _dense_index_of(q)
    import numpy as np
    sims = DENSE["doc_vecs"] @ DENSE["q_vecs"][idx]
    order = np.argsort(-sims)[:POOL_K]
    return [int(x) for x in DENSE["doc_ids"][order]]


def dense_pairs(q):
    """R10 用:向量的**全量**排序 `[(相似度, memory_id)]`。

    RRF 只看名次、不看分数,但要参与融合就必须拿到**全量名次**
    —— 只给 top-K 会让"两路都排在 15 名"这种事永远看不见。
    查询在表里查不到 ⇒ **抛错**(同 `dense_rank`),绝不返回空。
    """
    if DENSE is None:
        return []
    idx = _dense_index_of(q)          # 同上:先查表,再碰 numpy
    import numpy as np
    sims = DENSE["doc_vecs"] @ DENSE["q_vecs"][idx]
    order = np.argsort(-sims)
    return [(float(sims[j]), int(DENSE["doc_ids"][j])) for j in order]


def check_dense_covers(golden, dense):
    """**起飞前自检**:金标里每一条查询都必须有向量。

    为什么放在跑之前而不是跑之中:一次报全(**所有**缺失的查询),
    而不是撞到第一条就崩 —— 那样只能一条一条修。
    返回缺失清单(空 = 通过)。
    """
    if dense is None:
        return []
    have = dense["index"]
    missing = []
    for g in golden:
        if _norm_q(g["query"]) not in have:
            missing.append((g["tier"], g["source"], g["query"]))
    return missing


def rank_all_methods(q, rows, rows_by_id, bm, fts_conn, db_path, now, dense_ok=True):
    """跑六路,返回 {路名: [memory_id,...]} 与耗时字典。

    2026-09-29:另外返回一份 **POOL_K 名宽的候选**(`pool`),只给"答案集覆盖"
    那条口径用 —— 判据(recall@5)仍只看前 TOP_K 名,历史数字不许漂。
    起因:覆盖@5/@10/@20 三档读数完全一样,暴露出各臂只往回给 5 个候选 ⇒
    仪器量不出"top5 塞不下"(N2 的答案集实测 2~12 条)。
    """
    times = {}
    t0 = time.perf_counter()
    EXPAND_STAT["lookups"] = EXPAND_STAT.get("lookups", 0) + 1
    if lookup_expansions(q) is not None:
        EXPAND_STAT["hits"] = EXPAND_STAT.get("hits", 0) + 1
    elif len(EXPAND_STAT.get("sample", [])) < 3:
        EXPAND_STAT.setdefault("sample", []).append(repr(q)[:60])
    # k 取 POOL_K(不是 TOP_K):一次拿到宽名单,判据仍由下面的 [:TOP_K] 切出来。
    # 这样只跑一趟,**RT11 的查表记账(828 次)不会被第二跑翻倍**。
    prod = prod_retrieve.rank_memories([dict(r) for r in rows], q, POOL_K, now, fusion=FUSION, synonyms=SYNONYMS,
                                      extra_terms=lookup_expansions(q), stats=EXPAND_STAT)
    p0 = [it["memory_id"] for it in prod[:POOL_K]]
    r0 = p0[:TOP_K]
    RESCUE_STAT["seen"] += 1
    RESCUE_STAT["rescued"] += sum(1 for it in prod[:TOP_K] if it.get("rescued"))
    RESCUE_STAT["rescued_top5"] += sum(1 for it in prod[:TOP_K] if it.get("rescued"))
    RESCUE_STAT["any"] += 1 if any(it.get("rescued") for it in prod) else 0
    t1 = time.perf_counter()
    rank1 = bm.rank(q)
    r1 = [mid for _, mid in rank1[:TOP_K]]
    p1 = [mid for _, mid in rank1[:POOL_K]]
    t2 = time.perf_counter()
    fts_all = fts5_rank(fts_conn, q)
    r2 = [mid for _, mid in fts_all[:TOP_K]]
    p2 = [mid for _, mid in fts_all[:POOL_K]]
    t3 = time.perf_counter()
    rrf_same = rrf([rank1, [(it["total"], it["memory_id"]) for it in prod]])
    r3 = [mid for _, mid in rrf_same[:TOP_K]]
    p3 = [mid for _, mid in rrf_same[:POOL_K]]
    t4 = time.perf_counter()
    gchan, extra = graph_channel(db_path, q, bm)
    rrf_other = rrf([rank1, [(1.0, m) for m in gchan]])
    r4 = [mid for _, mid in rrf_other[:TOP_K]]
    p4 = [mid for _, mid in rrf_other[:POOL_K]]
    t5 = time.perf_counter()
    r5 = dedup(rows_by_id, rank1, TOP_K)
    p5 = dedup(rows_by_id, rank1, POOL_K)
    t6 = time.perf_counter()
    # R6 逐概念(RT11 第三刀):与 R0 唯一的差别 = **分母固定为原概念数**
    # (`per_concept=True` + `expand_groups` 给的"概念→变体"溯源)。
    # 说明两条故意的选择:
    #   ① **只挂同义/别名表,不挂 extra_terms** —— 模型给的扁平扩展词没有溯源
    #      (见 `docs/RT11_THIRD_CUT.md` §4 的 B 案),硬算就是猜;先把"分母"这一刀
    #      单独量出来,别把两个变量混在一起量。
    #   ② 不传 `stats` —— 记账(RT11b 的 828)不能被这一路翻倍。
    # 表为空时 `expand_groups` 让每个词元自成一组 ⇒ R6 恒等于 R0(天然负控)。
    _q_terms = prod_retrieve.lexical.uniq_terms(q)
    r6_prod = prod_retrieve.rank_memories(
        [dict(r) for r in rows], q, POOL_K, now, fusion=FUSION, synonyms=SYNONYMS,
        per_concept=True, groups=synonyms_mod.expand_groups(_q_terms, SYNONYMS),
        stats=R6_STAT)
    # 累计值每问打一行(取最后一行即总计):R6 自己的"进语境次数 / 真捞回次数"。
    # 为什么单独立账:上面那两行 [RT11] 计数来自 R0 那条路;**R6 若共用 EXPAND_STAT,
    # 828 查表记账会被翻倍**(所以最初没传 stats)—— 但不传就看不见 R6 有没有 fire。
    print("[RT11-R6] 逐概念捞人:有扩展词元的候选 %d 次,真捞回 %d 次"
          % (R6_STAT.get("cands_tried", 0), R6_STAT.get("fired", 0)))
    p6 = [it["memory_id"] for it in r6_prod[:POOL_K]]
    r6 = p6[:TOP_K]
    t7 = time.perf_counter()
    # R7 时间臂(2026-09-30):与 R0 唯一的差别 = **开时间臂**(time_arm=True)。
    # 时间意图从查询里解析(今天/最近/中秋/凌晨一点…),命中窗口的记忆:救回 + 加权。
    # 抓不到线索时 windows 为空 ⇒ R7 恒等于 R0(天然负控)。
    r7_prod = prod_retrieve.rank_memories(
        [dict(r) for r in rows], q, POOL_K, now, fusion=FUSION, synonyms=SYNONYMS,
        extra_terms=lookup_expansions(q), time_arm=True, stats=TIME_STAT)
    print("[时间臂-R7] 窗口数 %d,线索 %s,救回 %d 条"
          % (TIME_STAT.get("time_windows", 0), TIME_STAT.get("time_cues", []),
             TIME_STAT.get("time_fired", 0)))
    p7 = [it["memory_id"] for it in r7_prod[:POOL_K]]
    r7 = p7[:TOP_K]
    t8 = time.perf_counter()
    # R8 时间臂·scoped(2026-09-30):与 R7 唯一的差别 = **精确时间锚硬分组**
    # R7(boost)实测在真金标上是 no-op ⇒ 这一路量的是文献那句「收窄检索范围」的字面实现。
    TIME_SCOPED_STAT = {}
    r8_prod = prod_retrieve.rank_memories(
        [dict(r) for r in rows], q, POOL_K, now, fusion=FUSION, synonyms=SYNONYMS,
        extra_terms=lookup_expansions(q), time_arm=True, time_mode="scoped",
        stats=TIME_SCOPED_STAT)
    print("[时间臂-R8] 精确锚 %d,提前 %d 条"
          % (TIME_SCOPED_STAT.get("time_precise", 0),
             TIME_SCOPED_STAT.get("time_scoped_head", 0)))
    p8 = [it["memory_id"] for it in r8_prod[:POOL_K]]
    r8 = p8[:TOP_K]
    t9 = time.perf_counter()
    # R9Dense(BM25 vs Embedding 最小验证):**纯余弦**,不挂 L0 占位、不挂任何加权
    # —— 与 R1BM25 对称。DENSE 为 None 时返回 [] 且不进 `methods`(负控)。
    #
    # ⚠️ `dense_ok=False` 时**整段不跑**(p9/r9/p10/r10 留空),给可达率那一段用:
    # 那一段的"查询"是 `weak_clues(row)` —— **运行时从当前语料现推的弱线索**,
    # 语料一变线索就变 ⇒ 结构上不可能预先编码。若照常调 dense_rank 会撞
    # DenseNotEncoded;而"静默记 0 分"正是 2026-10-12 那次事故。所以**显式不跑**,
    # 并在表里印「—(未测)」——不冒充 0.0%,也不假装跑过。
    if DENSE is not None and dense_ok:
        p9 = dense_rank(q)
        r9 = p9[:TOP_K]
    else:
        p9, r9 = [], []
    t10 = time.perf_counter()
    # R10DenseBM25(BM25 + 向量 的 RRF 融合,等权)。**这一条是新的**:
    # 历史上三次融合否决(RRF 同族/异族、RT10 三臂)参与的都是**词法臂**
    # (R0现状 / R1BM25 / R2FTS5 / R5去冗余),从未测过含 embedding 的组合。
    # 与 R3/R4 的唯一差别就在这里 —— 那两条是"同族/异族词法",这条是"跨族词法+语义"。
    #
    # ⚠️ 2026-10-12:向量路拿不到分时**必须炸**,不许退化成纯 BM25。
    # 退化了读数还"看起来正常"(等于 BM25),而这一路的价值就悄悄没了 ——
    # 与 DenseNotEncoded 同一个理由(那次事故的教训)。
    if DENSE is not None and dense_ok:
        _dp = dense_pairs(q)
        if not _dp:
            raise DenseNotEncoded(
                "融合臂拿不到向量名次,拒绝退化成纯 BM25:%r\n"
                "  这会让 R10 静默变成 R1(读数看起来正常,但这一路等于没测)。" % q)
        rrf_dm = rrf([rank1, _dp])
        p10 = [mid for _, mid in rrf_dm[:POOL_K]]
        r10 = p10[:TOP_K]
    else:
        p10, r10 = [], []
    t11 = time.perf_counter()
    out = {"R0现状": r0, "R1BM25": r1, "R2FTS5": r2,
           "R3RRF同族": r3, "R4RRF异族": r4, "R5R1去冗余": r5, "R6逐概念": r6,
           "R7时间臂": r7, "R8时间锚": r8, "R9Dense": r9,
           "R10DenseBM25": r10}
    pool = {"R0现状": p0, "R1BM25": p1, "R2FTS5": p2,
            "R3RRF同族": p3, "R4RRF异族": p4, "R5R1去冗余": p5, "R6逐概念": p6,
            "R7时间臂": p7, "R8时间锚": p8, "R9Dense": p9,
            "R10DenseBM25": p10}
    for m, dt in (("R0现状", t1 - t0), ("R1BM25", t2 - t1), ("R2FTS5", t3 - t2),
                  ("R3RRF同族", t4 - t3), ("R4RRF异族", t5 - t4),
                  ("R5R1去冗余", t6 - t5), ("R6逐概念", t7 - t6),
                  ("R7时间臂", t8 - t7), ("R8时间锚", t9 - t8),
                  ("R9Dense", t10 - t9), ("R10DenseBM25", t11 - t10)):
        times[m] = dt * 1000.0
    return out, times, extra, pool


def pct(a, b):
    return 100.0 * a / b if b else 0.0


def disp_width(s):
    """按终端显示宽度算:中日韩全角字符占 2 列。"""
    return sum(2 if unicodedata.east_asian_width(c) in ("W", "F") else 1
               for c in str(s))


def pad(s, width, right=False):
    s = str(s)
    d = max(0, width - disp_width(s))
    return (" " * d + s) if right else (s + " " * d)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", default=None)
    ap.add_argument("--verbose", action="store_true")
    ap.add_argument("--fusion", action="store_true",
                    help="RT10:排序走三臂 RRF + 绝对阈值 + 滞回(默认关)")
    ap.add_argument("--threshold", type=float, default=fusion_mod.DEFAULT_THRESHOLD)
    ap.add_argument("--exit", type=float, default=fusion_mod.DEFAULT_EXIT)
    ap.add_argument("--expansions", default=None,
                    help="RT11b:大模型查询扩展 JSON(问句→扩展词元);只进捞人通道")
    ap.add_argument("--synonyms", action="store_true",
                    help="RT11:同义词/别名臂(从 graph_aliases 建表,只捞人不重排)")
    ap.add_argument("--mode", default="both", choices=["reorder", "gate", "both"],
                    help="RT10:只重排 / 只过门槛 / 两件一起(拆开量用)")
    ap.add_argument("--dense", default=None,
                    help="BM25 vs Embedding:Step 1 的编码产物 npz;"
                         "给了才挂 R9Dense(纯余弦,与 R1BM25 对称)")
    ap.add_argument("--gold-orphans", action="store_true",
                    help="Step 2.5:把**已滚出 conversation_log** 的存档指认也纳入判据"
                         "(问句原文取自 retrieval-gold.json 的冻结副本)。"
                         "默认关 ⇒ 判据与改造前逐位一致;开了会改变判据规模(读数变化)")
    args = ap.parse_args()

    # RT10:两条路都传同一个 FUSION(None = 老路,逐位不变)。
    # ⚠️ 量台**必须**能开关同一个旋钮,否则"上了 RRF 分数变了没有"这件事无从谈起。
    global FUSION, SYNONYMS, DENSE
    if args.dense:
        # BM25 vs Embedding 最小验证:载入 Step 1 的向量。载入失败**明确报错**,
        # 不静默降级成"没有这一路"(那会把"没跑"伪装成"跑了但没用")。
        DENSE = load_dense(args.dense)
        print("[Dense] R9Dense ON: %s(dim=%d, 纯余弦, 不含 L0 占位/不含加权)"
              % (args.dense, DENSE["dim"]))
    if args.expansions:
        _raw = json.load(open(args.expansions, encoding="utf-8"))
        EXPANSIONS = {_norm_q(k): v for k, v in (_raw.get("expansions") or {}).items() if isinstance(v, list)}
        _miss = 0
        print("[RT11b] 模型扩展: %d 条问句有词元(共 %d 个词元)"
              % (len(EXPANSIONS), sum(len(v) for v in EXPANSIONS.values())))
    if args.synonyms:
        # RT11:同义词表现在**只从库里的 graph_aliases 建**(13 条真数据)。
        # 他手写的补充表还没有 —— 等他给,别我自己造一份假装是他的。
        _rows = []
        try:
            # 别名表读**活库**(只读)—— 它在快照拷贝之前就该建好,而且别名与
            # 快照无关(是图谱归一的结果,不是这一跑的数据)
            _live = os.path.join(
                os.environ.get("DSH_HOME", os.path.join(os.path.expanduser("~"), ".dsh")),
                "echo", "echo.db")
            _conn = sqlite3.connect("file:%s?mode=ro" % _live, uri=True)
            _rows = [dict(zip(("alias", "canonical_name"), r))
                     for r in _conn.execute("SELECT alias, canonical_name FROM graph_aliases")]
            _conn.close()
        except Exception as exc:  # 建不起来就**明确说**,不静默当没有
            print("[RT11] graph_aliases 读不到(%s)⇒ 这一跑等于没开语义臂" % exc)
        SYNONYMS = synonyms_mod.build_table(_rows)
        print("[RT11] synonyms ON: 表里 %d 个词元(来自 graph_aliases %d 行)"
              % (len(SYNONYMS), len(_rows)))
    FUSION = ({"enabled": True, "mode": args.mode, "threshold": args.threshold, "exit": args.exit}
              if args.fusion else None)
    if FUSION:
        print("[RT10] fusion ON: mode=%s RRF k=%d, 绝对阈值(cov) enter=%.2f exit=%.2f"
              % (args.mode,
                 fusion_mod.RRF_K, args.threshold, args.exit))

    tmpdir = None
    db_path = args.db
    if not db_path:
        live = os.path.join(
            os.environ.get("DSH_HOME", os.path.join(os.path.expanduser("~"), ".dsh")),
            "echo", "echo.db",
        )
        tmpdir = tempfile.mkdtemp(prefix="echo_bench_")
        db_path = os.path.join(tmpdir, "bench.db")
        # ⚠️ 只拷 `echo.db` 主文件是**不够**的:活库跑在 WAL 模式下,已提交但
        # 还没 checkpoint 的事务只存在于 `echo.db-wal` 里(2026-09-27 实测:
        # 主库 mtime 停在 20:50:58,而 `-wal` 4.1MB / mtime 20:57:17 —— 差
        # 了 6 分钟且还在长)。只拷主文件 ⇒ 测台读到的是**滞后快照**,语料会
        # 比活库旧。三个文件一起拷才是活库的当前状态。
        # 原库全程只读(`mode=ro` + 只读副本),绝不写回去。
        for suffix in ("", "-wal", "-shm"):
            src = live if not suffix else live + suffix
            if os.path.exists(src):
                shutil.copy2(src, db_path + suffix)
        print("  活库副本: %s (原库只读,未触碰;含 -wal/-shm)" % db_path)

    conn = sqlite3.connect("file:%s?mode=ro" % db_path.replace("\\", "/"), uri=True)
    rows = load_rows(conn)
    verbatim = extract_verbatim(conn)
    conn.close()

    fts_conn = build_fts5(rows)
    rows_by_id = {r["memory_id"]: r for r in rows}
    bm = BM25(rows)
    now = time.time()
    methods = ["R0现状", "R1BM25", "R2FTS5", "R3RRF同族", "R4RRF异族", "R5R1去冗余",
               "R6逐概念", "R7时间臂", "R8时间锚"]
    if DENSE is not None:
        # 只有在给了 --dense 时才多这两行 ⇒ 老调用(不给 --dense)的输出逐位不变。
        methods.append("R9Dense")
        methods.append("R10DenseBM25")

    # Step 2.5:指认从持久化存储读;--gold-orphans 决定是否纳入已滚出的存档指认。
    golden, warn = build_golden(verbatim, include_orphans=args.gold_orphans)

    # ---- 起飞前自检(2026-10-12):金标每条查询都必须有向量 ----
    # 事故背景:Step 5 扩样新增 29 条查询却没重编码 ⇒ Dense 静默记 0 分,
    # 读数从 87.2% 掉到 51.5%,全程无报错。这里把它变成**起飞前一次性拦住**。
    if DENSE is not None:
        _missing = check_dense_covers(golden, DENSE)
        if _missing:
            _meta = DENSE.get("meta") or {}
            print()
            print("  " + "!" * 74)
            print("  [!] 金标里有 %d 条查询**没有向量** —— 拒绝开跑。" % len(_missing))
            print("      向量表: %s · 编码于 %s · 表里 %d 条查询"
                  % (_meta.get("model", "(未知模型)"),
                     _meta.get("encoded_at", "(未知时间)"), len(DENSE["index"])))
            print("      缺向量的查询(前 20 条):")
            for _t, _s, _q in _missing[:20]:
                print("        [%s|%s] %r" % (_t, _s, _q))
            if len(_missing) > 20:
                print("        …… 另有 %d 条" % (len(_missing) - 20))
            print("      修法: 重跑 .scratch/dense-bench/encode_dense.py(按当前金标重新编码全部查询)")
            print("      为什么必须拦:不拦的话 Dense 会被记 0 分,读数只是「变差」,"
                  "没人查得出原因。")
            print("  " + "!" * 74)
            raise SystemExit(2)

    positive = [g for g in golden if g["accept"]]
    negative = [g for g in golden if not g["accept"]]
    l0_ids = {r["memory_id"] for r in rows if r["layer"] == "L0"}

    print()
    print("=" * 78)
    print("  检索对照测台 v2 —— 评测集:题目先于答案(query-first)")
    print("=" * 78)
    print("  语料: 现役记忆 %d 条(其中 L0 强制占位 %d 条: %s)"
          % (len(rows), len(l0_ids), sorted(l0_ids)))
    print("  取题: conversation_log 逐字取到 %d 条(去噪/去渠道前缀/2~%d 字/去重)"
          % (len(verbatim), VERBATIM_MAX))
    print("  金标: %d 条 = 正样本 %d(逐字 %d + 补题 %d) + 负控 %d(逐字 %d + 旧 %d)"
          % (len(golden), len(positive),
             sum(1 for g in positive if g["source"] == "逐字"),
             sum(1 for g in positive if g["source"] == "补题"),
             len(negative),
             sum(1 for g in negative if g["source"] == "逐字"),
             sum(1 for g in negative if g["source"] == "旧负控")))
    if warn:
        print("  [!] 这些逐字答案指认没在数据源里找到对应查询文本(已忽略): %s"
              % "、".join(warn))

    # ---- 答案指认的完整性自检:答案 id 必须都在现役语料里 ----
    missing = sorted({mid for g in golden for mid in g["accept"]
                      if mid not in rows_by_id})
    if missing:
        print("  [!] 金标里这些 memory_id 不在现役语料中(请修正指认): %s" % missing)
    else:
        print("  自检: 全部期望答案的 memory_id 都在现役语料里 ✓")
    print()

    # ---------------- 逐条跑 ----
    stats = {m: {"hit": 0, "zero": 0, "dups": 0, "slots": 0, "ms": 0.0,
                 "tier_hit": {}, "tier_n": {}, "tier_cover": {}} for m in methods}
    neg_stats = {m: {"empty": 0, "l0": 0} for m in methods}
    # 渲染层指标(只有 R0 有渲染层):漏洞②的修复面在**注入块**,不在检索层。
    # 检索层返回 L0 占位记忆是设计(F5:强制占位 ≠ 被想起),所以"硬塞率 100%"
    # 不代表漏没修 —— 得看"确实零主题命中的轮次里,标注出现没有"。
    render_stats = {"zero_topic": 0, "annotated": 0, "with_l0": 0}
    # ---- 修尺子(2026-09-30):顺序敏感 + 白盒支撑 + 失败分解 ----
    # 起因(两条都是文献读出来的,见 docs/RETRIEVAL_ARCH_NOTES.md §10.4/§11.1/§12.2):
    #   ① 上一版只有「答案集覆盖@k」—— 它量的是「答案在不在集合里」,**对同一集合内换序
    #      天生无感**;于是 ConvMemory v2 那种「召回保全、只重排前 10」的正收益改动
    #      (MRR 0.5824→0.6560,而 R@10 由构造不变)在我们这里会**显示为 0 效果**。
    #   ② 只有「命中/不命中」二值,分不出 MemConflict 那两类失败:
    #      **召回失败**(答案集完全进不了候选池)vs **排序失败**(进了池子但排不进 top5)。
    # 全部只做累计,不改任何既有口径 ⇒ 负控 = 老读数必须一字不变。
    ord_stats = {m: {"seq_n": 0, "mrr10": 0.0, "ndcg5": 0.0, "seh3": 0,
                     "first_ranks": [], "kfull": [], "kfull_none": 0,
                     "ok": 0, "fail_rank": 0, "fail_recall": 0,
                     "tier_fail": {}} for m in methods}

    for g in golden:
        q, accept = g["query"], g["accept"]
        ids_by_method, times, extra, pool_by_method = rank_all_methods(
            q, rows, rows_by_id, bm, fts_conn, db_path, now)
        for m in methods:
            ids = ids_by_method[m]
            s = stats[m]
            s["ms"] += times[m]
            d, slots = redundancy(rows_by_id, ids)
            s["dups"] += d
            s["slots"] += slots
            if accept:
                ok = bool(set(ids) & accept)
                s["hit"] += 1 if ok else 0
                s["zero"] += 0 if ok else 1
                s["tier_hit"][g["tier"]] = s["tier_hit"].get(g["tier"], 0) + (1 if ok else 0)
                s["tier_n"][g["tier"]] = s["tier_n"].get(g["tier"], 0) + 1
                # 多答案档的口径补充(2026-09-29):原来的判据只看「top5 里有没有命中」,
                # 而 N2 的答案集实测是 2~12 条 —— **12 条答案塞不进 5 个位置**,那个分数
                # 量的是「装不装得下」而不是「找不找得到」。这里同时记**命中比例**
                # 与 topK=5/10/20 的覆盖曲线,让"装不下"这件事自己浮出来。
                pool = pool_by_method[m]
                tc = s["tier_cover"].setdefault(g["tier"], [0.0, 0.0, 0.0])
                tc[0] += pct(len(set(pool[:5]) & accept), len(accept))
                tc[1] += pct(len(set(pool[:10]) & accept), len(accept))
                tc[2] += pct(len(set(pool[:20]) & accept), len(accept))
                # ---- 顺序敏感 + 白盒支撑(修尺子;全部只读既有 pool/ids,不改口径)----
                os_ = ord_stats[m]
                os_["seq_n"] += 1
                gold_ranks = [i + 1 for i, mid in enumerate(pool[:POOL_K])
                              if mid in accept]
                if gold_ranks:
                    first = min(gold_ranks)
                    os_["first_ranks"].append(first)
                    if first <= 10:
                        os_["mrr10"] += 1.0 / first              # MRR@10
                    if first <= 3:
                        os_["seh3"] += 1                          # SEH@3(支撑证据进前 3)
                    # NDCG@5:二值相关 + 位置折扣 1/log2(i+1);IDCG 按答案集大小截到 5
                    dcg = sum(1.0 / math.log2(i + 1)
                              for i in range(1, 6) if i in gold_ranks)
                    ideal = sum(1.0 / math.log2(i + 1)
                                for i in range(1, min(len(accept), 5) + 1))
                    os_["ndcg5"] += (dcg / ideal) if ideal else 0.0
                    # 「装下所需 k」:答案集全在池子里时,最远那条的位次 ——
                    # 直接量化「top5 装不下」到底要多少位(呈现/预算的尺子)。
                    if len(gold_ranks) == len(accept):
                        os_["kfull"].append(max(gold_ranks))
                    else:
                        os_["kfull_none"] += 1
                else:
                    os_["kfull_none"] += 1
                # ---- 失败分解:召回失败 / 排序失败 / 成功 ----
                in_pool = bool(set(pool[:POOL_K]) & accept)
                in_top = bool(set(ids) & accept)
                tf = os_["tier_fail"].setdefault(g["tier"], [0, 0, 0])
                if in_top:
                    os_["ok"] += 1
                    tf[2] += 1
                elif in_pool:
                    os_["fail_rank"] += 1
                    tf[1] += 1
                else:
                    os_["fail_recall"] += 1
                    tf[0] += 1
            else:
                if not ids:
                    neg_stats[m]["empty"] += 1
                if l0_ids & set(ids):
                    neg_stats[m]["l0"] += 1
        # 渲染层检查:负控档里"确实零主题命中"的轮次,注入块必须带标注。
        if not accept:
            r0items = prod_retrieve.rank_memories(
                [dict(r) for r in rows], q, TOP_K, now)
            if not any(it.get("matched") for it in r0items):
                render_stats["zero_topic"] += 1
                if "没有命中任何记忆" in prod_retrieve.render_episodic(r0items):
                    render_stats["annotated"] += 1
                if l0_ids & {it["memory_id"] for it in r0items}:
                    render_stats["with_l0"] += 1
            else:
                # 残余弱点:短寒暄查询只要有一个二字词元在语料里存在过,就
                # `matched=True`(短查询只剩一个词元时 cov 非 0 即 1,0.10 这个
                # 阈值退化),于是**标注不出现**。这里把它量化下来。
                top1 = max((float(it.get("hits") or 0) for it in r0items
                            if it.get("matched")), default=0.0)
                render_stats.setdefault("matched_neg", []).append((q, top1))
        if args.verbose:
            tag = ("期望 %s" % sorted(accept)) if accept else "期望 空(负控)"
            print("  [%s|%s] %s" % (g["tier"], g["source"], q))
            print("      %s" % tag)
            for m in methods:
                ids = ids_by_method[m]
                ok = ("✓" if (set(ids) & accept) else "✗") if accept \
                    else ("✓" if not ids else "✗")
                print("      %-11s %s %s" % (m, ok, ids))
            if extra:
                print("      图谱扩展: %s" % extra[:8])
            print()

    # ---------------- 偏差体检 ----
    m1_all, n1 = bias_m1(positive, rows_by_id)
    m1_verb, _ = bias_m1([g for g in positive if g["source"] == "逐字"], rows_by_id)
    m1_extra, _ = bias_m1([g for g in positive if g["source"] == "补题"], rows_by_id)
    m1_legacy, nl = bias_m1([{"query": q, "accept": a} for q, a in LEGACY_GOLDEN],
                            rows_by_id)
    # 「无选择偏差」口径:逐字档**全部**查询都算,指认不出答案的按 0 计 ——
    # 它回答的是「他真实说过的话里,平均有多少词元本来就长在答案记忆里」,
    # 不因为「我只留下了能指认答案的题」而自我美化。
    ans_by_q = {g["query"]: g["accept"] for g in golden if g["source"] == "逐字"}
    vv = []
    for q, _ in verbatim:
        qt = uniq_terms(q)
        if not qt:
            continue
        at = set()
        for mid in ans_by_q.get(q, set()):
            at |= doc_terms(rows_by_id, mid)
        vv.append(sum(1 for t in qt if t in at) / len(qt))
    m1_verb_all = 100.0 * sum(vv) / len(vv) if vv else 0.0
    nv = len(vv)
    m2_full, m2_zero_full, n2 = bias_m2([q for q, _ in verbatim], corpus_terms(rows))
    m2_sum, m2_zero_sum, _ = bias_m2([q for q, _ in verbatim],
                                     corpus_terms(rows, "summary"))

    print("  " + "-" * 74)
    print("  偏差体检(以后每份评测集都要报这两个数)")
    print("  " + "-" * 74)
    print("  M1 题面词元出自答案的比例(越低越不容易被词面方法白捡)")
    print("      %s %7s   %s" % (pad("v1 旧金标(同一把尺子实测)", 48),
                                "%.1f%%" % m1_legacy, "(%d 条)" % nl))
    print("      %s %7s   %s" % (pad("v2 新金标 · 全体正样本", 48),
                                "%.1f%%" % m1_all, "(%d 条)" % n1))
    print("      %s %7s   %s  ← 有选择偏差"
          % (pad("   · 逐字档(只算能指认答案的)", 48), "%.1f%%" % m1_verb,
             "(%d 条)" % (n1 - sum(1 for g in positive if g["source"] == "补题"))))
    print("      %s %7s   %s  ← 无选择偏差口径"
          % (pad("   · 逐字档(全部查询,指认不出按 0 计)", 48),
             "%.1f%%" % m1_verb_all, "(%d 条)" % nv))
    print("      %s %7s" % (pad("   · 补题档(我手写的人话问法)", 48),
                           "%.1f%%" % m1_extra))
    print("  M2 真实问法在语料里的词面钩子率(v1 记录 30.7%,一半为 0)")
    print("      %s %7s   零钩子 %3.0f%%   (%d 条真实问法)"
          % (pad("语料 = 摘要 + 关键词", 48), "%.1f%%" % m2_full,
             m2_zero_full, n2))
    print("      %s %7s   零钩子 %3.0f%%"
          % (pad("语料 = 只摘要(保守口径)", 48), "%.1f%%" % m2_sum, m2_zero_sum))
    print("      口径说明: 两个 M2 都按「真实问法的去停用词二元词元被语料覆盖的比例」"
          "逐条平均;")
    print("                旧值 30.7% 未能在当前 conversation_log(只留最近 100 轮)"
          "上精确复现,见文末局限。")
    print()

    # ---------------- 金标图例 ----------------
    print("  " + "-" * 74)
    print("  金标图例(每档的题从哪来、答案怎么指认 —— --verbose 可逐条看)")
    print("  " + "-" * 74)
    for t in POSITIVE_TIERS + [NEGATIVE_TIER]:
        gs = [g for g in golden if g["tier"] == t]
        if not gs:
            continue
        src = {}
        for g in gs:
            src[g["source"]] = src.get(g["source"], 0) + 1
        print("  %s %2d 条   来源: %s"
              % (pad(TIER_SHORT[t], 10), len(gs),
                 " / ".join("%s×%d" % (k, v) for k, v in sorted(src.items()))))
        if args.verbose:
            for g in gs:
                acc = sorted(g["accept"])
                print("      · %s → %s [%s]"
                      % (pad(g["query"], 62),
                         pad(acc if acc else "∅(空集)", 24), g["note"]))
    print("  指认规则: 逐字档的答案 = 「这条查询问的那件事」落在哪几条现役记忆上;")
    print("            指认不出答案的逐字查询**自动**进 N0 负控档(期望空集),不做主观挑选。")
    print()

    # ---------------- 分档 recall@5 ----
    print("  " + "-" * 74)
    print("  分档 recall@5 (正样本档;括号内为档内条数)")
    print("  " + "-" * 74)
    head = "  " + pad("路", 12)
    for t in POSITIVE_TIERS:
        n = sum(1 for g in positive if g["tier"] == t)
        head += pad("%s(%d)" % (TIER_SHORT[t], n), 14, right=True)
    head += pad("总分(%d)" % len(positive), 13, right=True)
    print(head)
    print("  " + "-" * (12 + 14 * len(POSITIVE_TIERS) + 13))
    for m in methods:
        s = stats[m]
        line = "  " + pad(m, 12)
        for t in POSITIVE_TIERS:
            n = s["tier_n"].get(t, 0)
            line += pad("%.1f%%" % pct(s["tier_hit"].get(t, 0), n), 14, right=True)
        line += pad("%.1f%%" % pct(s["hit"], len(positive)), 13, right=True)
        print(line)
    print()

    # ---------------- 答案集覆盖(多答案档的口径补充) ----------------
    # 为什么单列:上面的 recall@5 是「top5 里有没有命中答案集」,二值;
    # 而 N2/N4 的答案集是多条(实测 2~12 条)。12 条答案装不进 5 个位置,
    # 于是 60% 里混着"找不到"和"装不下"两种完全不同的病。这一节把它们分开:
    #   recall@5 低 + 覆盖@20 高  ⇒ 装不下(该动 topK/编排,不是动召回臂)
    #   recall@5 低 + 覆盖@20 也低 ⇒ 真找不到(这才是召回臂的问题)
    print("  " + "-" * 74)
    print("  答案集覆盖(逐条平均;每格 = 覆盖@5 / @10 / @20)")
    print("  " + "-" * 74)
    head = "  " + pad("路", 12)
    for t in POSITIVE_TIERS:
        n = sum(1 for g in positive if g["tier"] == t)
        head += pad("%s(%d)" % (TIER_SHORT[t], n), 14, right=True)
    print(head)
    for m in methods:
        s = stats[m]
        line = "  " + pad(m, 12)
        for t in POSITIVE_TIERS:
            n = s["tier_n"].get(t, 0)
            tc = s["tier_cover"].get(t)
            if not tc or not n:
                line += pad("—", 14, right=True)
                continue
            line += pad("%.0f/%.0f/%.0f" % (tc[0] / n, tc[1] / n, tc[2] / n), 14, right=True)
        print(line)
    print("      100/100/100 = 该档答案集全进了 top20。")
    print("      诊断用法(2026-09-29 起):**recall@5 低但覆盖@20 高 ⇒ 不是找不到,是 top5 塞不下**;")
    print("      两个都低才是召回臂的问题。改任何一条臂之前,先看这一行。")
    print()

    # ---------------- 顺序敏感 + 白盒支撑 + 失败分解(修尺子,2026-09-30) ----------------
    print("  " + "-" * 74)
    print("  顺序敏感 + 白盒支撑(上一版只有「覆盖」,对同一集合内换序天生无感)")
    print("  " + "-" * 74)
    print("  " + pad("路", 12) + pad("MRR@10", 10, right=True)
          + pad("NDCG@5", 10, right=True) + pad("首答位次中位", 16, right=True)
          + pad("SEH@3", 9, right=True) + pad("装下k中位", 12, right=True))
    print("  " + "-" * 74)
    for m in methods:
        os_ = ord_stats[m]
        n = os_["seq_n"] or 1
        fr = sorted(os_["first_ranks"])
        kf = sorted(os_["kfull"])
        print("  " + pad(m, 12)
              + pad("%.3f" % (os_["mrr10"] / n), 10, right=True)
              + pad("%.3f" % (os_["ndcg5"] / n), 10, right=True)
              + pad(("%d" % fr[len(fr) // 2]) if fr else "—", 16, right=True)
              + pad("%.1f%%" % pct(os_["seh3"], n), 9, right=True)
              + pad(("%d" % kf[len(kf) // 2]) if kf else "—", 12, right=True))
    print("      MRR@10 / NDCG@5 = **顺序敏感**读数(不看集合、只看排第几);")
    print("      SEH@3 = 支撑证据进 top3 的题占比(MemConflict 的白盒口径 SEH);")
    print("      首答位次中位 = 第一条答案在池中的位次中位数(越小越好);")
    print("      装下k中位 = 答案集**全部**进池时最远那条的位次 ⇒ 直接量「要几个位置才装得下」。")
    print("      用途:「重排 / 编排 / 呈现」这类**不动召回**的改动,看这几列;")
    print("            只改召回臂时,才看上一节的覆盖曲线。")
    print()
    print("  " + "-" * 74)
    print("  失败分解(正样本 %d 条)" % len(positive))
    print("      召回失败 = 答案集**完全进不了 top%d**;排序失败 = 进了 top%d 但排不进 top%d;"
          % (POOL_K, POOL_K, TOP_K))
    print("      成功 = top%d 命中。前两类混在同一个「零命中率」里,是上一版看不见的地方。"
          % TOP_K)
    print("  " + "-" * 74)
    print("  " + pad("路", 12) + pad("召回失败", 11, right=True)
          + pad("排序失败", 11, right=True) + pad("成功", 11, right=True))
    print("  " + "-" * 46)
    for m in methods:
        os_ = ord_stats[m]
        print("  " + pad(m, 12)
              + pad("%.1f%%" % pct(os_["fail_recall"], len(positive)), 11, right=True)
              + pad("%.1f%%" % pct(os_["fail_rank"], len(positive)), 11, right=True)
              + pad("%.1f%%" % pct(os_["ok"], len(positive)), 11, right=True))
    print("      按档(R0 现状;格式 = 召回失败 / 排序失败 / 成功):")
    for t in POSITIVE_TIERS:
        tf = ord_stats["R0现状"]["tier_fail"].get(t)
        if not tf:
            continue
        tot = sum(tf) or 1
        print("        " + pad(TIER_SHORT[t], 12)
              + "%2d / %2d / %2d   (=%.0f%% / %.0f%% / %.0f%%)"
              % (tf[0], tf[1], tf[2], pct(tf[0], tot), pct(tf[1], tot), pct(tf[2], tot)))
    print()

    # ---------------- 负控/闲聊档 ----
    N = len(negative)
    print("  " + "-" * 74)
    print("  负控/闲聊档 (%d 条;正确答案=空集)" % N)
    print("  " + "-" * 74)
    print("  " + pad("路", 12) + pad("空返回率", 16, right=True)
          + pad("硬塞率(L0被当相关)", 22, right=True))
    for m in methods:
        ns = neg_stats[m]
        print("  " + pad(m, 12) + pad("%.1f%%" % pct(ns["empty"], N), 16, right=True)
              + pad("%.1f%%" % pct(ns["l0"], N), 22, right=True))
    print()
    if render_stats["zero_topic"]:
        print("  渲染层(R0 注入块 —— **漏洞②的修复面在这里**,不在上面那行):")
        print("      确实零主题命中的负控 %d 条;其中注入块带「没有命中任何记忆」"
              "标注 %d 条 = %.1f%%"
              % (render_stats["zero_topic"], render_stats["annotated"],
                 pct(render_stats["annotated"], render_stats["zero_topic"])))
        print("      同一批里检索层仍返回 L0 占位记忆 %d 条 —— 那是**设计**"
              "(F5:强制占位 ≠ 被想起)," % render_stats["with_l0"])
        print("      所以「硬塞率 100%%」量的是层次不同,不是漏洞没修。")
        mn = render_stats.get("matched_neg") or []
        if mn:
            mn_sorted = sorted(mn, key=lambda x: x[1])
            print("      ⚠️ 残余弱点:另 %d 条负控被判 matched=True(标注因此**不出现**),"
                  % len(mn))
            print("         它们的 top1 覆盖率 最低 %.2f / 中位 %.2f / 最高 %.2f。"
                  % (mn_sorted[0][1], mn_sorted[len(mn_sorted) // 2][1],
                     mn_sorted[-1][1]))
            print("         举例:%s" % "; ".join(
                "%r→%.2f" % (q, c) for q, c in mn_sorted[:3]))
            print("         成因:短查询只剩一个词元时覆盖率非 0 即 1,"
                  "MIN_COVERAGE=0.10 这个阈值退化了。")
            print("         → 归入 RT0 的阈值扫(与去冗余阈值同一把尺子),"
                  "或四层通道那套重构。")
        print()

    # ---------------- 零命中 / 冗余 / 耗时 ----
    print("  " + "-" * 74)
    print("  总分项(零命中与冗余都只在正样本档上算)")
    print("  " + "-" * 74)
    print("  " + pad("路", 12) + pad("零命中率", 12, right=True)
          + pad("冗余率", 12, right=True) + pad("单次耗时", 14, right=True))
    print("  " + "-" * 52)
    for m in methods:
        s = stats[m]
        print("  " + pad(m, 12)
              + pad("%.1f%%" % pct(s["zero"], len(positive)), 12, right=True)
              + pad("%.1f%%" % pct(s["dups"], s["slots"]), 12, right=True)
              + pad("%.2f ms" % (s["ms"] / max(1, len(golden))), 14, right=True))
    total_all = sum(stats[m]["ms"] for m in methods)
    print("  算力: %d 条查询 × %d 路 = %d 次完整检索, 合计 %.1f ms"
          % (len(golden), len(methods), len(golden) * len(methods), total_all))
    print("        (全部机械脚本,零大模型调用;语料 %d 条)" % len(rows))
    print()

    # ---------------- 可达率 ----
    strategies = ["前缀半句", "中段", "尾段", REACH_WEAK]
    strat_hit = {m: {s: 0 for s in strategies} for m in methods}
    strat_n = {m: {s: 0 for s in strategies} for m in methods}
    total_hit = {m: 0 for m in methods}
    total_n = 0
    for r in rows:
        clues = weak_clues(r)
        if not clues:
            continue
        total_n += 1
        for sname, clue in clues:
            # ⚠️ `dense_ok=False`:这一段的"查询"是**运行时从语料现推的弱线索**
            # (`weak_clues`),语料一变线索就变 ⇒ 结构上不可能预先编码。
            # 所以向量两臂在这一段**显式不跑**,表里印「—(未测)」,
            # 而不是静默记 0.0%(那正是 2026-10-12 那次事故的形状)。
            ids_by_method, _, _, _ = rank_all_methods(
                clue, rows, rows_by_id, bm, fts_conn, db_path, now, dense_ok=False)
            for m in methods:
                hit = r["memory_id"] in ids_by_method[m][:TOP_K]
                strat_hit[m][sname] += 1 if hit else 0
                strat_n[m][sname] += 1
                if sname in REACH_MAIN:
                    total_hit[m] += 1 if hit else 0
    main_n = total_n * len(REACH_MAIN)
    print("  " + "-" * 74)
    print("  可达率 —— 每条现役记忆用**自己的弱线索**当查询,能否在 top%d 找回它自己" % TOP_K)
    print("  (分母 = 全部 %d 条现役记忆 × %d 个弱线索口径 = %d 次检索,"
          "不是我挑的题,不受出题偏好影响)" % (total_n, len(REACH_MAIN), main_n))
    print("  " + "-" * 74)
    print("  " + pad("路", 12) + pad("总可达率", 14, right=True)
          + pad("前缀半句", 14, right=True) + pad("中段", 12, right=True)
          + pad("尾段", 12, right=True) + pad("二字窗(最弱)", 16, right=True))
    # 向量两臂在这一段**未测**(弱线索是运行时现推的,无法预先编码)⇒ 印「—」,
    # 不印 0.0%。两者含义天差地别:"0%"是"跑了但一条没找回","—"是"没跑"。
    _reach_unmeasured = {"R9Dense", "R10DenseBM25"} if DENSE is not None else set()
    for m in methods:
        if m in _reach_unmeasured:
            print("  " + pad(m, 12)
                  + pad("—(未测)", 14, right=True) + pad("—", 14, right=True)
                  + pad("—", 12, right=True) + pad("—", 12, right=True)
                  + pad("—", 16, right=True))
            continue
        print("  " + pad(m, 12)
              + pad("%.1f%%" % pct(total_hit[m], main_n), 14, right=True)
              + pad("%.1f%%" % pct(strat_hit[m]["前缀半句"], strat_n[m]["前缀半句"]),
                    14, right=True)
              + pad("%.1f%%" % pct(strat_hit[m]["中段"], strat_n[m]["中段"]),
                    12, right=True)
              + pad("%.1f%%" % pct(strat_hit[m]["尾段"], strat_n[m]["尾段"]),
                    12, right=True)
              + pad("%.1f%%" % pct(strat_hit[m][REACH_WEAK], strat_n[m][REACH_WEAK]),
                    16, right=True))
    if _reach_unmeasured:
        print("  ⚠️ %s 在本段**未测**:弱线索是运行时从语料现推的(语料一变线索就变),"
              % "/".join(sorted(_reach_unmeasured)))
        print("     结构上无法预先编码。印「—」不印 0.0% —— 「没跑」与「跑了但没找回」不是一回事。")
    print("  例(R1 口径): 前缀半句 %d/%d 条,中段 %d/%d 条,尾段 %d/%d 条,二字窗 %d/%d 条"
          % (strat_hit["R1BM25"]["前缀半句"], strat_n["R1BM25"]["前缀半句"],
             strat_hit["R1BM25"]["中段"], strat_n["R1BM25"]["中段"],
             strat_hit["R1BM25"]["尾段"], strat_n["R1BM25"]["尾段"],
             strat_hit["R1BM25"][REACH_WEAK], strat_n["R1BM25"][REACH_WEAK]))
    print("  总可达率 = 前三个口径的合计(%d 条记忆里有几条被自己的弱线索找回);" % total_n)
    print("  二字窗是最弱口径,单列 —— 它太弱、噪声大,不混进总可达率,只用来量「随手一指」的下限。")
    print()
    print("  说明: 逐字档里指认不出答案的查询已自动归入负控档,不参与正样本 recall@5。")
    print()

    # ---------------- 这套评测集自己的局限(必须随每次输出一起报) ----------------
    print("  " + "-" * 74)
    print("  本评测集**自己**的局限(读数之前请先看完这一段)")
    print("  " + "-" * 74)
    print("  1) 残余选择偏差(最大的一条): 逐字档里「能指认答案」才进正样本,而能指认")
    print("     的恰恰是那些词面能钩住记忆的长句(记忆的 keywords 往往就是他原话的引文),")
    print("     所以逐字正样本的 M1 高达 %.1f%%;真正『一半零钩子』的短句(在吗/继续/"
          % m1_verb)
    print("     来聊聊天)全部落进负控档,不进 M1。逐字档的 M1 必须看『无选择偏差口径』")
    print("     那一行(%.1f%%),不要只看正样本那一行。" % m1_verb_all)
    print("  2) 样本量小: 正样本 %d 条、负控 %d 条。单档只有 3~10 条,一两条翻转就是"
          % (len(positive), len(negative)))
    print("     十几个百分点 —— 分档数字只能看趋势,不能当精确值。")
    print("  3) 真实问法天然短(2~40 字,中位数不到 10 字)、且多为寒暄,词面钩子本来就少;")
    print("     短查询的 recall 天然低,这是语料现实,不是方法好坏。")
    print("  4) 可达率的『弱线索』是我设计的(摘要前缀/中段/尾段),而且都是被索引正文的")
    print("     子串 —— 词面方法天然占便宜,它量的是「自找回 + 近重复排序」,不是语义泛化。")
    print("  5) 补题档的 21 条人话问法是我手写的,答案指认也带主观性;虽然我逐条核过库里")
    print("     现役记忆,但换个人指认可能给出不同的可接受集合。")
    print("  6) 逐字档只在 conversation_log 里留存,这张表只保留最近 100 轮 ——")
    print("     样本随现场滚动而漂移,不同时刻跑出的逐字档不完全是同一批题。")
    print("  7) 六路都是机械词面方法,全部不调大模型;『语义类』问法在这里只能被间接体现。")
    print()

    # ---------------- 标定 + 拒绝闸(τ 扫)----------------
    # 文献依据(见 docs/RETRIEVAL_ARCH_NOTES.md §10.3 / §12.1 / §12.2):
    #   * MemReranker:未标定的分数(BGE 类左偏堆在 0 附近)⇒ **阈值根本没法设**;
    #     正确顺序是「先相对化(标定),再定 τ」。
    #   * MemX:规则 `K=∅ ∧ max sim < τ(0.50) ⇒ ∅`;标定用 z-score + sigmoid。
    #   * CPP:低置信度过滤(取回段的**最大**相似度低于阈值 ⇒ 抑制结果,防止弱相关
    #     上下文误导模型),并把 abstention 单列一档。
    # 现场问题(量台自己早就记下的残余弱点):7 条负控里 **6 条**被判 matched=True,
    #   top1 覆盖率中位 **1.00** ⇒ `MIN_COVERAGE=0.10` 在短查询上退化成「非 0 即 1」。
    # 本节只做**离线测量**,不动生产代码;回答一句:「换一个标定过的分数 + 一道 τ 闸,
    #   能在不伤正样本的前提下把负控拒掉吗」。
    # 判据门不变:总分不退 / 逐档不退 / **N4 覆盖@20 94% 不许掉**。
    # 内建负控:τ = 0 那一行 = 「什么都不拒」,必须逐字复现上面未加闸的读数。
    _N_DOC = len(rows)
    _df = {}
    for r in rows:
        for t in set(doc_terms(rows_by_id, r["memory_id"])):
            _df[t] = _df.get(t, 0) + 1
    IDF = {t: math.log(1.0 + (_N_DOC - d + 0.5) / (d + 0.5)) for t, d in _df.items()}
    # ⚠️ 档名必须与 POSITIVE_TIERS 里的一致(是 "N4 知识更新",不是 "N4")。
    # 2026-09-30 我在这里写错过一次:红线(N4 覆盖@20)于是**整段静默跳过**,
    # 打印出 0.0% 还照样往下跑 —— 现在改成由常量推导,并在下面自检。
    N4_TIER = [t for t in POSITIVE_TIERS if t.startswith("N4")][0]
    # ⚠️ 分母必须固定成「金标里 N4 的条数」,不能只数**活下来的** N4 条目 ——
    # 闸会杀掉低覆盖的那条,分母跟着缩水,红线(N4 覆盖)反而"涨"到 100%,
    # 这是幸存者偏差,2026-09-30 第一版就踩了。
    N4_ALL = sum(1 for g in golden if g["accept"] and g["tier"] == N4_TIER)

    def idf_cov(q, mid):
        """IDF 加权覆盖率 = 命中词元的 IDF 之和 / 查询全部词元的 IDF 之和。

        与生产 `cov`(命中**个数**占比)的差别:短查询里「量子纠缠」这类词元 IDF 高,
        命中它说明**真的**撞上了;而「量子纠缠」只有 4 个字、词元少 ⇒ 覆盖率非 0 即 1,
        这正是 MIN_COVERAGE=0.10 退化的根源。
        """
        qt = uniq_terms(q)
        tot = sum(IDF.get(t, 0.0) for t in qt)
        if tot <= 0:
            return 0.0
        at = doc_terms(rows_by_id, mid)
        return sum(IDF.get(t, 0.0) for t in qt if t in at) / tot

    def _zsig(xs):
        if len(xs) < 2:
            return 0.0
        mu = sum(xs) / len(xs)
        sd = math.sqrt(sum((x - mu) ** 2 for x in xs) / len(xs))
        z = (max(xs) - mu) / sd if sd > 1e-9 else 0.0
        return 1.0 / (1.0 + math.exp(-z))

    SIGS = [("cov", "原始覆盖率 cov(现状相关分)"),
            ("total", "现状总分 total"),
            ("z_sig_cov", "z-score+sigmoid(cov)—— MemX 式标定"),
            ("idfcov", "IDF 加权覆盖率(未标定)"),
            ("z_sig_idfcov", "z-score+sigmoid(IDF 加权)—— 文献配方")]
    TAUS = [round(0.05 * k, 2) for k in range(0, 20)]        # 0.00 ~ 0.95
    gate = {s: {t: {"neg_rej": 0, "pos_kill": 0, "ok": 0, "cov20": 0.0,
                    "n4cov": 0.0, "n4n": 0} for t in TAUS} for s, _ in SIGS}
    for g in golden:
        q, accept = g["query"], g["accept"]
        # 这一跑只为拿分数:不传 stats ⇒ **不会把 EXPAND_STAT 的查表记账翻倍**。
        items = prod_retrieve.rank_memories([dict(r) for r in rows], q, POOL_K, now,
                                            fusion=FUSION, synonyms=SYNONYMS,
                                            extra_terms=lookup_expansions(q))
        cand = [it for it in items if str(it.get("layer") or "") != "L0"]
        covs = [float(it.get("hits") or 0.0) for it in cand]
        tots = [float(it.get("total") or 0.0) for it in cand]
        idfs = [idf_cov(q, it["memory_id"]) for it in cand]
        conf = {"cov": max(covs) if covs else 0.0,
                "total": max(tots) if tots else 0.0,
                "z_sig_cov": _zsig(covs),
                "idfcov": max(idfs) if idfs else 0.0,
                "z_sig_idfcov": _zsig(idfs)}
        pool20 = [it["memory_id"] for it in items[:POOL_K]]
        cov_after = pct(len(set(pool20) & accept), len(accept)) if accept else 0.0
        hit = bool(set(pool20[:TOP_K]) & accept) if accept else False
        for skey, _ in SIGS:
            c = conf[skey]
            for t in TAUS:
                if c < t:                      # 闸清空整池(MemX / CPP 的 all-or-nothing 口径)
                    if accept:
                        gate[skey][t]["pos_kill"] += 1
                    else:
                        gate[skey][t]["neg_rej"] += 1
                    continue
                if accept:
                    gate[skey][t]["ok"] += 1 if hit else 0
                    gate[skey][t]["cov20"] += cov_after
                    if g["tier"] == N4_TIER:
                        gate[skey][t]["n4cov"] += cov_after
                        gate[skey][t]["n4n"] += 1

    ok_base = stats["R0现状"]["hit"]
    cov20_base = sum(stats["R0现状"]["tier_cover"].get(t, [0.0, 0.0, 0.0])[2]
                     for t in POSITIVE_TIERS) / max(1, len(positive))
    n4_base = (stats["R0现状"]["tier_cover"].get(N4_TIER, [0.0, 0.0, 0.0])[2]
               / max(1, stats["R0现状"]["tier_n"].get(N4_TIER, 1)))
    if gate["cov"][0.0]["n4n"] != N4_ALL:
        raise SystemExit("闸的 N4 档记账 %d ≠ 金标 N4 条数 %d ⇒ 红线(N4 覆盖)没被正确检查,拒绝出数"
                         % (gate["cov"][0.0]["n4n"], N4_ALL))
    print("  " + "-" * 74)
    print("  表 D — 拒绝闸 τ 扫(离线;闸 = 「本查询最高置信度 < τ ⇒ 整池清空」)")
    print("  " + "-" * 74)
    print("  未加闸基准(R0 现状):成功 %d/%d = %.1f%%,覆盖@20 %.1f%%,N4 覆盖@20 %.1f%%"
          % (ok_base, len(positive), pct(ok_base, len(positive)),
             cov20_base, n4_base))
    print("  负控 %d 条(正确答案=空集):未加闸时 R0 的空返回率是 0.0%% —— 这道闸要动的就是它。"
          % len(negative))
    print()
    for skey, sname in SIGS:
        print("  · %s" % sname)
        last = None
        for t in TAUS:
            st = gate[skey][t]
            cur = (st["neg_rej"], st["pos_kill"])
            if t == 0.0 or cur != last:
                print("      τ=%.2f   负控拒答 %d/%d   误杀正样本 %d/%d   "
                      "加闸后成功 %d/%d   覆盖@20 %.1f%%   N4覆盖@20 %.1f%%"
                      % (t, st["neg_rej"], len(negative), st["pos_kill"], len(positive),
                         st["ok"], len(positive),
                         st["cov20"] / max(1, len(positive)),
                         (st["n4cov"] / max(1, N4_ALL))))
            last = cur
        print()
    # 负控:τ=0 必须逐字复现未加闸读数
    st0 = gate["cov"][0.0]
    ok0 = st0["ok"] == ok_base
    cov0 = abs(st0["cov20"] / max(1, len(positive)) - cov20_base) < 1e-9
    print("  [负控] τ=0(什么都不拒)⇒ 成功 %d/%d、覆盖@20 %.1f%% ⇒ %s"
          % (st0["ok"], len(positive), st0["cov20"] / max(1, len(positive)),
             "与未加闸读数逐字一致 ✓" if (ok0 and cov0) else "**对不上,闸的记账有 bug ✗**"))
    print()
    print("  [判据门自动选 τ] 条件:总分(覆盖@20)不退 且 N4 覆盖@20 不退 且 成功条数不退")
    for skey, sname in SIGS:
        best = None
        for t in TAUS:
            st = gate[skey][t]
            if (st["cov20"] / max(1, len(positive)) >= cov20_base - 1e-9
                    and (st["n4cov"] / max(1, N4_ALL)) >= n4_base - 1e-9
                    and st["ok"] >= ok_base):
                if best is None or st["neg_rej"] > gate[skey][best]["neg_rej"]:
                    best = t
        if best is None:
            print("      %-34s 无解(任何 τ 都会伤到正样本)" % sname)
        else:
            st = gate[skey][best]
            print("      %-34s τ=%.2f → 负控拒答 %d/%d,误杀 %d/%d,成功 %d/%d,"
                  "覆盖@20 %.1f%%,N4 %.1f%%"
                  % (sname, best, st["neg_rej"], len(negative), st["pos_kill"],
                     len(positive), st["ok"], len(positive),
                     st["cov20"] / max(1, len(positive)),
                     (st["n4cov"] / max(1, N4_ALL))))
    print()
    print("  说明:闸只改「检索层的 matched/空返回」这一层;生产里 L0 强制占位与"
          "渲染层标注是另外两层,不在这里动。")
    print("  样本量:负控 %d 条 ⇒ 一格 = 14.3%%,只能看趋势。" % len(negative))
    print()

    fts_conn.close()
    if tmpdir:
        shutil.rmtree(tmpdir, ignore_errors=True)


if __name__ == "__main__":
    try:
        main()
    finally:
        if EXPAND_STAT.get("lookups"):
            print("[RT11b] 查询扩展查表: %d 次里命中 %d 次;没命中的样子: %s"
                  % (EXPAND_STAT.get("lookups", 0), EXPAND_STAT.get("hits", 0), EXPAND_STAT.get("sample", [])))
        if EXPAND_STAT.get("cands_tried"):
            print("[RT11b] 扩展臂决策层:有扩展词元的候选 %d 次,**真捞回** %d 次"
                  % (EXPAND_STAT.get("cands_tried", 0), EXPAND_STAT.get("fired", 0)))
        if RESCUE_STAT["seen"]:
            print("")
            print("[RT11] 语义臂这一跑:问了 %d 条,被同义词捞回的条目共 %d 条(其中挤进 top5 的 %d 条),至少捞到东西的问数 %d"
                  % (RESCUE_STAT["seen"], RESCUE_STAT["rescued"], RESCUE_STAT["rescued_top5"], RESCUE_STAT["any"]))
            if RESCUE_STAT["rescued"] == 0:
                print("[RT11] ⇒ 一条都没捞到:量的是「这一臂有没有子弹」,不是「语义泛化有没有用」。表太小,不给结论。")

