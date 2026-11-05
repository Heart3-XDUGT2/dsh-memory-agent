"""引用完整性:`superseded_by` 链的写入校验与修复。

## 为什么有这个东西(2026-09-27 现场)

他让我自查审计,查出来:**全库 50 行有 `superseded_by`,其中 16 行指向不存在
的记忆**。而且日期全部落在 09-18 ~ 09-21 —— 之后(#126→127、#127→169、
#128→169、#130→171)全部能解析。

定位:`episodic_memory` 用 AUTOINCREMENT,`sqlite_sequence` = 256 = `max(memory_id)`,
而 AUTOINCREMENT 的序列**只增不减** ⇒ **id 257~445 在这张表里从未存在过**。
唯一能产生 431 这种引用的地方是**另一个库文件**:两个 A 侧导入器

    scripts/import-astrbot.mjs:103   Math.round(Number(r.superseded_by) || 0)
    scripts/merge-astrbot.mjs:410    pick(r, srcMemCols, 'superseded_by', 0)

把 A 侧的 `superseded_by` **原样照抄**,没做「旧 id → 新 id」重映射。A 侧 id 到了
445,迁移只搬 256 行 ⇒ 抄过来的引用全部指向空气。

## 为什么必须拦

`superseded_by` 是一条**跨行外键**,但 SQLite 不会替我们拦。指向空气的引用会让
「留档链」撒谎 —— 面板上写「被 #431 取代」,而 #431 谁都不知道是什么,**那条事实
等于被无声抹掉**,连"她以前以为…"都翻不出来。这正是 A 侧迁移后 L0 层被清空的
帮凶:16 条 L0 全被标了悬空引用,`is_active=0` 之后就再没活过来。

## 契约

* `target_ok`     —— 目标行真的存在吗(0 / '' / None 一律算"没有引用")。
* `mark_superseded` —— 「留档为被 new_id 取代」。**先校验再写**;校验不过就
  只留档、不编造引用(留 0)。绝不抛异常(写入链不许被脏数据带崩)。
* `repair_dangling_superseded` —— 幂等修复:把指向空气的引用归 0。
"""

import sqlite3


def _norm(value):
    """把引用值归一成字符串(0 / '' / None 都表示"没有引用")。"""
    if value is None:
        return ""
    s = str(value).strip()
    if s in ("", "0"):
        return ""
    return s


def target_ok(conn, table, pk_column, ref):
    """`ref` 是不是 `table.pk_column` 里真实存在的一行。

    不做 int() 强转:图侧节点主键(`graph_nodes.node_id`)是 TEXT,边主键是
    INTEGER,同一套判定要两边都能用。
    """
    s = _norm(ref)
    if s == "":
        return False
    try:
        return conn.execute(
            'SELECT 1 FROM "%s" WHERE "%s" = ? LIMIT 1' % (table, pk_column),
            (ref,),
        ).fetchone() is not None
    except sqlite3.Error:
        # 表/列不存在 ⇒ 无从判定,保守地当"解析不到"(宁可不写引用)
        return False


def mark_superseded(conn, table, pk_column, ref, where, params):
    """把 `where` 圈出的行留档为「被 `ref` 取代」。

    `ref` 解析不到(指向空气)时:**只置 is_active=0,不写 superseded_by** ——
    留档链宁可断在这里,也不许写一条骗人的引用。

    返回影响行数(与旧实现一致,调用方的 ack 计数不受影响)。不 commit,
    由调用方决定事务边界。
    """
    ok = target_ok(conn, table, pk_column, ref)
    if ok:
        sql = ('UPDATE "%s" SET is_active = 0, superseded_by = ? WHERE %s'
               % (table, where))
        return int(conn.execute(sql, (ref, *params)).rowcount or 0)
    sql = 'UPDATE "%s" SET is_active = 0 WHERE %s' % (table, where)
    return int(conn.execute(sql, tuple(params)).rowcount or 0)


def repair_dangling_superseded(conn, table, pk_column, *, commit=True):
    """幂等修复:把 `superseded_by` 指向不存在的行的引用清成 0。

    返回修了几行。表不存在时返回 0(引擎自建库没有图侧某些表,别炸)。
    """
    try:
        rows = conn.execute(
            'SELECT "%s", superseded_by FROM "%s"'
            " WHERE superseded_by IS NOT NULL"
            "   AND superseded_by <> 0"
            "   AND superseded_by <> ''" % (pk_column, table)
        ).fetchall()
    except sqlite3.Error:
        return 0
    fixed = 0
    for pk, ref in rows:
        if target_ok(conn, table, pk_column, ref):
            continue
        conn.execute(
            'UPDATE "%s" SET superseded_by = 0 WHERE "%s" = ?' % (table, pk_column),
            (pk,),
        )
        fixed += 1
    if fixed and commit:
        conn.commit()
    return fixed


def referenced_ids(conn, table, pk_column):
    """所有被当作 `superseded_by` 目标引用着的 id 集合 —— 硬删前的免责名单。

    F2:`cleanup_stale` 的 3×TTL 硬删不许把别人还指着的行删掉(删了就把留档链
    变成悬空引用)。删之前拿这个集合做排除。
    """
    try:
        rows = conn.execute(
            'SELECT DISTINCT superseded_by FROM "%s"'
            " WHERE superseded_by IS NOT NULL"
            "   AND superseded_by <> 0"
            "   AND superseded_by <> ''" % (table,)
        ).fetchall()
    except sqlite3.Error:
        return set()
    return {str(r[0]) for r in rows if _norm(r[0]) != ""}
