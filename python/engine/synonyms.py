"""RT11 零依赖语义臂(**第一步:同义词/别名,先量再上**)。

计划 §3.5 第 1 步:第三臂先用**现成**的语义信号 —— `graph_aliases`(他图谱合并出来的
别名,13 条真数据)+ 他手写的同义词表 —— 接进检索,**在金标上量 N2/N3 涨不涨**:
涨得动 ⇒ 缺的确实是"语义泛化",向量臂值得付模型的代价;涨不动 ⇒ **向量臂不做**。

⚠️ 与 RT10 的教训直接相关:RT10 量出来 RRF"重排"是负的(N5 矛盾 100→66.7),
因为**奖励"排名一致"会牺牲"最新那条"**。所以这一臂**不做排名投票者**,只做
**捞人**(rescuer):一条记忆若"直接命中不够、但被同义词捞得住",就把它**拉回候选**,
并按折扣分排在直接命中之后 —— 只救"该进来却没进来"的,不动已经进来了的顺序。

零依赖:只用标准库 + 库里的 `graph_aliases` 表,不引模型、不引 numpy。
"""

# 用同义词捞回来的条目,分按这个折扣算(排在直接命中之后)。
# 为什么打折:同义词只是"可能相关",直接命中才是"确实相关" —— 两者不该同权。
RESCUE_DISCOUNT = 0.6


def build_table(alias_rows, extra_pairs=None):
    """把 `graph_aliases` 的 (alias, canonical_name) 行 + 他手写的对子,做成**双向**表。

    双向的理由:库里记的是"别名 → 正名",但她说/他问的时候两种叫法都可能出现
    (`西电` 与 `西安电子科技大学` 都得能捞)。`extra_pairs` 是他手写的补充
    (形如 `[("校园跑", "跑步"), ...]`),库里没有的靠它补。
    """
    table = {}

    def link(a, b):
        a, b = str(a).strip(), str(b).strip()
        if a == "" or b == "" or a == b:
            return
        table.setdefault(a, set()).add(b)
        table.setdefault(b, set()).add(a)

    for row in alias_rows or ():
        try:
            link(row["alias"], row["canonical_name"])
        except (TypeError, KeyError, IndexError):
            continue
    for pair in extra_pairs or ():
        try:
            link(pair[0], pair[1])
        except (TypeError, IndexError):
            continue
    return {k: sorted(v) for k, v in table.items()}


def expand_terms(terms, table):
    """给一组查询词元补上它们的同义/别名(逐词元精确匹配,不做模糊 —— 宁可漏,不可错捞)。"""
    out = set(terms or ())
    if not table:
        return out
    for t in list(out):
        for other in table.get(str(t), ()):  # noqa: SIM118
            out.add(other)
    return out


def expand_groups(terms, table):
    """RT11 第三刀(3a):**带溯源**的扩展 —— `{原词元: {它自己能命中的变体…}}`。

    为什么需要它:第二刀死在"把扩展词元并进同一个词元集"(`retrieve.py:170`),
    分母被撑大 ⇒ 覆盖率被稀释 ⇒ 分档不动、捞回 0。**逐概念判定要求分母固定为原查询
    概念数**,分子按"这个概念被任一变体命中"算 —— 那就必须知道"哪个变体属于哪个概念",
    而 `expand_terms` 把这份溯源拍平成了一个 set(信息在那里就丢了)。

    规则(与 `expand_terms` 同口径:逐词元精确匹配,**宁可漏,不可错捞**):
      * 组里**含原词元自己** —— 它是自己最强的变体(否则"自己命中"会被漏掉);
      * 组 = 原词元 + 表里的**一跳**邻居,**不做传递闭包**(`A~B~C` 不等于 C 是 A 的
        变体,那是猜、不是证据);
      * 没进表的词元自成一组 ⇒ 逐概念判定的分母恒等于**原概念数**,不会悄悄变小。

    零依赖、纯函数、可离线测。
    """
    if not table:
        return {str(t): {str(t)} for t in (terms or ())}
    out = {}
    for t in terms or ():
        w = str(t)
        group = {w}
        for other in table.get(w, ()):  # noqa: SIM118
            s = str(other).strip()
            if s:
                group.add(s)
        out[w] = group
    return out


def known_terms(table):
    """表里认识的词元(量台/调试用:先看这一臂到底有几发子弹)。"""
    return sorted((table or {}).keys())
