# -*- coding: utf-8 -*-
"""A3 类型层与证据层的**唯一口径**。

两个词表,两处承重约定 —— 都写在这里,别在别处再长一份。

## 一、`kind`(边的类型)

**空串 = 事实边。这不是"没填",是编码。**

活库实测(2026-10-01):`graph_edges` 45 条边的 `kind` **全是空串**,而引擎侧有
两处过滤**按它认事实边**:

* `graph.py:294` `top_nodes()` —— 反射提示词的「已有实体」名单;
* `graph.py:968` 强化/物化/剪枝 —— 影子边不参与物化(实测:+61 天推演下 47 条
  影子边 → 0)。

影子/共现边后来**另立了 `graph_shadow_edges`**(`db.py:489`),理由写得明白:
同表混放时,任何"忘了加 kind 过滤"的新读口都会泄漏。⇒ 结论:

* `graph_edges` 里出现**非空 `kind`** 是**红灯**(不是"标得更清楚",是把事实边
  伪装成影子边,会让上面两处过滤把它漏掉);
* 所以 `add_edge` 收到 `"fact"` 时**归一成空串**(存 `'fact'` 会踩上面那个坑),
  收到别的 kind **直接抛错**;
* 真库的"非空 kind 条数"要**恒为 0**,有测试与报表盯着。

## 二、`evidence`(边的依据)

已有的写法就是「记忆 id 串」:`'169、99'`,分隔符 `、`(也容忍 `,`/`，`)。
**`(推定)` 后缀是既有惯例** —— `scripts/graph-evidence-backfill.mjs` 那次一次性
回填靠字面匹配推出依据,写进去的值带 `(推定)`,意思是"这是推的,不是当场听说的";
`scripts/graph-merge.mjs` 合并时保留这个标记。两种形态都出现过:
`'140、40、38(推定)'`(后缀贴在最后一个 id 上)与 `'169、99、(推定)'`(后缀自成一段)。

**空串 = 没有依据,这是诚实的**(`graph.learn` 的注释:"留空而不是瞎填")。
⇒ A3 **不回填、不伪造**:只把"强弱"**算出来、报出来**(`strength()`),
让"事实边有没有依据"从"看不出来"变成"一眼可数"。
"""

KIND_FACT = ""
#: 写进 `graph_edges` 的 kind 只允许这一个值(即空串)。`"fact"` 只在**读侧**
#: 宽容(老库/外部工具可能这么写),写侧一律归一成空串。
ALLOWED_KINDS_IN_GRAPH_EDGES = (KIND_FACT, "fact")

INFERRED_SUFFIX = "(推定)"
SEPARATOR = "、"


def is_fact_kind(kind) -> bool:
    """这条边的 kind 是不是"事实边"(空串,或读侧宽容的 `fact`)。"""
    return str(kind or "").strip().lower() in ALLOWED_KINDS_IN_GRAPH_EDGES


def normalize_kind(kind) -> str:
    """写侧把 kind 归一成**空串**;不认的 kind 直接抛(防影子边混进事实表)。

    存 `'fact'` 是不行的:`top_nodes()` 与剪枝都按 `COALESCE(kind,'')=''` 过滤,
    存了 `'fact'` 这条边就会被它们当成影子边漏掉 —— 宁可归一,不留两种写法。
    """
    k = str(kind or "").strip().lower()
    if k in ALLOWED_KINDS_IN_GRAPH_EDGES:
        return KIND_FACT
    raise ValueError(
        "graph_edges 只收事实边(kind 空串 = 事实;影子/共现走 graph_shadow_edges):"
        "收到 %r" % (kind,))


def split_evidence(raw) -> list:
    """拆依据串(容忍 `,` / `，` / `、`;保序去重;空串回 []。"""
    seq = []
    for chunk in str(raw or "").replace(",", SEPARATOR).replace("，", SEPARATOR).split(SEPARATOR):
        chunk = chunk.strip()
        if chunk and chunk not in seq:
            seq.append(chunk)
    return seq


def join_evidence(ids) -> str:
    """把 id 列表拼成依据串(容忍 `(推定)` 这类非编号段,原样保留)。

    ⚠️ 这是**诊断/口径**用的拼接,不是写入侧的合并 —— 写入侧归
    `graph._merge_evidence`(它只吸收能变 int 的项)。
    """
    if isinstance(ids, str):
        return SEPARATOR.join(split_evidence(ids))
    out = []
    for x in (ids or []):
        s = str(x).strip()
        if not s:
            continue
        try:
            out.append(str(int(x)))
        except (TypeError, ValueError):
            out.append(s)
    return SEPARATOR.join(out)


def evidence_ids(raw) -> list:
    """只取**能当编号用**的那几段(`(推定)` 这类标记不算)。

    注意既有数据的主形态是**后缀贴在最后一个编号上**:`'140、40、38(推定)'`
    ⇒ 解析前先把标记从每段里剥掉,否则 38 会被整段丢掉(实测踩过)。
    """
    out = []
    for chunk in split_evidence(raw):
        num = chunk
        for mark in (INFERRED_SUFFIX, "（推定）"):
            num = num.replace(mark, "")
        num = num.strip()
        try:
            out.append(int(num))
        except (TypeError, ValueError):
            continue
    return out


def has_inferred(raw) -> bool:
    """带没带「推定」标记(与 `scripts/graph-merge.mjs` 的判据一致:`/推定/`)。"""
    return "推定" in str(raw or "")


def strength(raw) -> str:
    """依据强弱 —— `none` / `inferred` / `mixed` / `real`。

    * `none`      :空串。**诚实**的"没依据",不是错误;
    * `inferred`  :只有 `(推定)`(那次字面匹配回填的),没有真编号;
    * `mixed`     :既有真编号又有推定标记;
    * `real`      :有真编号,没推定标记(写入时当面听见的依据)。
    """
    ids = evidence_ids(raw)
    inf = has_inferred(raw)
    if ids and inf:
        return "mixed"
    if ids:
        return "real"
    if inf:
        return "inferred"
    return "none"


def describe(raw) -> str:
    """人话(给他/面板看)。"""
    st = strength(raw)
    ids = evidence_ids(raw)
    return {
        "none": "无依据",
        "inferred": "仅推定",
        "mixed": "真编号 %d 个 + 推定" % len(ids),
        "real": "真编号 %d 个" % len(ids),
    }[st]


def count_into(diag: dict, ids) -> str:
    """把一条边的依据强弱计进 `diag`(**纯计数**,不改任何写库行为)。

    `graph.learn(diag=...)` 用它 —— 老调用点不传 diag 时,行为逐位不变。

    口径对齐**落库结果**(实测):`_merge_evidence` 只吸收**能变 int** 的项,且
    列表是**新在前**(`[169, 99]` → `'99、169'`)。所以:

    * `no_evidence`      :调用方什么都没给 ⇒ 落库是空(诚实);
    * `evidence_dropped` :调用方给的全是**非编号段**(如 `(推定)`)⇒ 合并会丢掉,
                          落库依然是空 —— 这是**写入侧该修的信号**,不是"有依据";
    * `mixed_evidence`   :既有编号又有非编号段;
    * `real_evidence`    :给了编号(落库就有依据)。
    """
    raw = ids if isinstance(ids, str) else join_evidence(ids)
    diag["written"] = diag.get("written", 0) + 1
    st = strength(raw)
    key = {"none": "no_evidence", "inferred": "evidence_dropped",
           "mixed": "mixed_evidence", "real": "real_evidence"}[st]
    diag[key] = diag.get(key, 0) + 1
    return st
