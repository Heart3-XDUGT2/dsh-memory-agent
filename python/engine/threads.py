# -*- coding: utf-8 -*-
"""悬置话题引擎(M2-b1)。

AstrBot echo_memory_engine.py:766-946 的逐字移植(同步版:worker 单线程
串行处理帧,不需要 AstrBot 的 _db_lock)。

语义保真清单(改了就是另一个引擎):
  - 登记去重:最近 30 条 open 内双向子串比对(casefold,子串侧 ≥6 字),
    命中补时间/会话/来源而不新建 —— 同一件事说两遍不会变两行,
    也不会被追问两次;
  - follow_up_after=0 = 不定时:永远不进 due/remindable
    (「跟进」与「待办清单」的分界线);
  - 注入即提过:threads_due 取走即归零(放进 prompt 就算提过);
  - 主动提醒发送成功才归零:threads_remindable 纯读 + threads_mark 显式落账;
  - 先消解后登记:threads_ingest 原子封装,顺序纪律在引擎侧单点强制,
    不信任壳的调用顺序(顺序反了,新话题会被用户原话立刻关掉);
  - 消解匹配:用户原话与话题内容双向子串(casefold)。

与 AstrBot 的两处显式偏差(可观测性增强,不改变行为):
  - remember 返回 (thread_id, created) —— 壳侧审计能区分「新建」与「合并」;
  - 表由引擎确保存在(CREATE TABLE IF NOT EXISTS,与 JS store.js 建的表
    逐列同构,IF NOT EXISTS 与既有表共存不撞)—— 单一写者对自有表
    享有建表权。

线协议命名约定:请求字段 camelCase(JS 习惯),应答条目字段保持数据库
列名 snake_case(与 AstrBot 返回字典、JS 面板消费形状一致)。
"""

import re
import sqlite3
import time

from .db import connect  # noqa: F401 —— 共享数据库层(建表/迁移/连接)
from . import dedupe as dedupe_mod  # D4:相似度用**同一把尺子**(字符二元组 Jaccard)


# ---- 悬置话题的类别(2026-10-06 D1;设计文档《悬置话题机制设计》§1)----
# ⚠️ **两侧同源**:JS 镜像是 `lib/thread-kinds.js` 的 THREAD_KINDS / KIND_RULES /
# HAS_TIME_RE;`tests/thread-kinds.test.js` 会从**本文件**正则抠出下面三张表逐条
# 比对(照 `test_ddl_parity.py` 抠 store.js DDL 的先例)—— 改这里必须同改那边。
#
# 语义纪律(设计 §1.3):**确定性规则优先 → LLM 字段兜底 → 认不出回 ''(不猜)**。
# '' = 未分类:不参与注入(D3)、冷却期按 7 天(D2)。宁可不分类,也不要猜错。
THREAD_KINDS = ("promise", "schedule", "reminder", "care", "topic")

# 顺序即优先级。刻意**窄**(高精度低召回):宽规则会把"她自己的判断"顶掉,
# 而 LLM 那一层本来就产 kind —— 规则只负责拦最典型的那几类。
KIND_RULES = (
    ("reminder", "提醒我|提醒他|提醒她|分钟后|叫我|喊我|别忘"),
    ("schedule", "面试|考试|开会|火车|航班|飞机|车票|到站|出发|返回|回家|去上班|去上课"),
    ("care", "到了之后|顺利|好些|怎么样|问候|平安|注意身体|早点睡|有没有事|还好吗"),
    ("promise", "待会儿|还没|还没有|打算|计划|欠着|要补|补跑|准备|开始学"),
)

# 时间锚:schedule 必须**同时**命中它 + 上表里的动词,否则"去"字满篇都是日程。
HAS_TIME_RE = "今天|明天|后天|大后天|今晚|今早|上午|下午|中午|早上|晚上|凌晨|[0-9]{1,2}点|[0-9]{1,2}月|[0-9]{1,2}日|[0-9]{1,2}号|周[一二三四五六日天]|星期[一二三四五六日天]|下周|下个月"


# 语义去重(2026-10-06 D4;设计文档《悬置话题机制设计》§4.2 / §4.4)
#
# 字面层(全等 / ≥6 字子串 / ±120s 到期窗)拦不住"措辞不同的同一件事"——
# 实测:数据结构 ×3、火车 ×3、分流 ×2、重启 web ×2、OJ ×2、三公里跑 ×2。
# 补一层**保守**的语义判据(宁可漏并不误并):
#   同 kind ∧ |created_at 之差| < 48h ∧ 字符二元组 Jaccard ≥ 阈值
# 相似度用 `dedupe.summary_overlap`(与壳侧 `speech-guard.similarityOf`
# 同一把尺子:字符二元组 Jaccard)—— **一处实现,不许有两份**。
# ⚠️ 语义层**只用于合并,不用于消解**:消解放宽会"回一句『嗯/好』就把事误关"
# (docs/CODE_AUDIT_2026-09-26.md 的 B31)。
#
# 阈值标定(2026-10-06,拿现网 6 组近重复离线回放出来的,不是拍脑袋):
#   数据结构组 0.714 · OJ 0.412 · 三公里跑 0.25 · 分流 0.192 · 重启 web 0.156 · 火车 0.111
#   对照:上周面试/这周面试 0.60 · 跨 kind 0.071
#   ⇒ 0.80(设计稿的建议值)**一组都并不掉**(最高的 0.714 也过不去);
#     0.70 刚好并掉数据结构组,且与次高 0.412 之间留了 0.29 的余量、
#     与"上周/这周"那个不该并的对照(0.60)留了 0.10 ⇒ **取 0.70**。
#   剩下 5 组不是"相似度能治的":它们是**同一件事的不同面**(行程 vs 到站 vs 问候),
#   交给 D2/D3 的冷却与归档,而不是硬并。
THREAD_SEMANTIC_WINDOW_SEC = 48 * 3600
THREAD_SEMANTIC_SIMILARITY = 0.70


def _semantic_same(kind_a, kind_b, created_a, created_b, sim):
    """同 kind + 48h 窗 + 相似度过线(纯判据)。跨 kind 一律不并。"""
    if str(kind_a or "") != str(kind_b or ""):
        return False
    try:
        gap = abs(float(created_a or 0.0) - float(created_b or 0.0))
    except (TypeError, ValueError):
        return False
    if gap >= THREAD_SEMANTIC_WINDOW_SEC:
        return False
    return float(sim or 0.0) >= THREAD_SEMANTIC_SIMILARITY


def thread_similarity(a, b):
    """两条话题正文的相似度(唯一入口:壳侧镜像必须同口径)。"""
    return dedupe_mod.summary_overlap(a, b)


def resolve_thread_kind(content, llm_kind=""):
    """定一条悬置话题的类别(纯函数,永不抛)。

    规则优先(窄) ⇒ 时间锚单独成类(schedule) ⇒ LLM 字段(白名单内) ⇒ ''。
    """
    text = " ".join(str(content or "").split()).strip()
    llm = str(llm_kind or "").strip().lower()
    if text:
        for kind, pattern in KIND_RULES:
            if not re.search(pattern, text):
                continue
            if kind == "schedule" and not re.search(HAS_TIME_RE, text):
                # 有"回家/面试"这种词但没有时间锚 ⇒ 不当日程(交给 LLM/留空)
                continue
            return kind
        if re.search(HAS_TIME_RE, text):
            return "schedule"
    return llm if llm in THREAD_KINDS else ""


def _norm_content(content):
    """空白折叠 + 300 字硬顶(AstrBot 同款规整)。"""
    return " ".join(str(content or "").split()).strip()[:300]


def remember_pending_thread(conn, user_id, content, follow_up_after=0.0,
                            source_memory_id=0, session_id="", due_window_sec=0.0,
                            kind=""):
    """登记一条悬置话题(带去重)。返回 (thread_id, created)。

    空内容返回 (0, False);命中既有话题返回 (既有id, False) 并补
    时间/会话/来源;全新返回 (新id, True)。

    `kind`(2026-10-06 D1)由调用方给 LLM 判的那一版(可为空);
    **最终值走 `resolve_thread_kind(content, kind)`** —— 规则优先、认不出留 ''
    (单一落点:所有写入路径都经过这里,类别不会漏打)。

    两条去重路径(v0.18.2 补齐第二条):
      ① **措辞相同**:完全相等,或长度 ≥6 时互为子串(A 侧原语义)。
      ② **同一场约定的两种说法**:到期时间相差小于 `due_window_sec`
         (调用方传 120)。A 侧 `main.py:2088-2094` 就是为这件事写的 ——
         命令式提醒(确定性解析)与 Judge 登记(措辞不同,如「面试」vs
         「他下周的面试」)指的是同一场约定,不比对到期时间就会留两条,
         他会收到两次催办。

    代价说清楚(A 侧没有这一面,所以这里是有意放宽):A 只拿"这一轮 Judge
    的产出"比对命令式提醒,顺序固定(Judge 先)。B 的两条路是并发来的
    (命令式是微任务、Judge 要一次 LLM 往返),所以比对**所有 open 行**、
    双侧生效 —— 换来顺序无关。副作用:两条**不同**的约定若恰好相距不到
    两分钟,会被并成一条。这个面很窄(一次抽取里两件事差 2 分钟),而
    "同一件事提醒两遍"是 A 侧明确修过的现场问题,取舍偏后者。
    """
    normalized = _norm_content(content)
    if not normalized:
        return 0, False
    kind_final = resolve_thread_kind(normalized, kind)
    now = time.time()
    due = max(0.0, float(follow_up_after or 0.0))
    src_mid = int(source_memory_id or 0)
    sess = str(session_id or "").strip()[:200]
    window = max(0.0, float(due_window_sec or 0.0))
    rows = conn.execute(
        "SELECT thread_id, content, follow_up_after, kind, created_at"
        " FROM pending_threads"
        " WHERE user_id = ? AND status = 'open'"
        " ORDER BY updated_at DESC LIMIT 30",
        (user_id,),
    ).fetchall()
    low = normalized.casefold()
    for row in rows:
        cur_text = str(row[1] or "").casefold()
        cur_due = float(row[2] or 0.0)
        same_text = low == cur_text or (
            len(low) >= 6 and (low in cur_text or cur_text in low)
        )
        same_due = (window > 0.0 and due > 0.0 and cur_due > 0.0
                    and abs(cur_due - due) < window)
        # D4:语义层(同 kind + 48h + Jaccard ≥ 0.80)⇒ 合并,不新建。
        same_meaning = _semantic_same(
            kind_final, str(row[3] or ""), now, float(row[4] or 0.0),
            thread_similarity(normalized, str(row[1] or "")))
        if same_text or same_due or same_meaning:
            conn.execute(
                "UPDATE pending_threads SET"
                " session_id = CASE WHEN ? != '' THEN ? ELSE session_id END,"
                " follow_up_after = CASE WHEN ? > 0 THEN ? ELSE follow_up_after END,"
                " source_memory_id = CASE WHEN ? > 0 THEN ? ELSE source_memory_id END,"
                # D1:老行(未分类)被再次提到时,**只补不覆盖** —— 已有类别一律不动,
                # 只有空格才填。这不是"回溯补判"(拍板 ⑤ 不跑那件事),是这次写入
                # 自己的产物。`kind = ''` 的判据写在 SQL 里,读的人一眼看得出。
                " kind = CASE WHEN kind = '' AND ? != '' THEN ? ELSE kind END,"
                " updated_at = ? WHERE thread_id = ?",
                (sess, sess, due, due, src_mid, src_mid, kind_final, kind_final, now, int(row[0])),
            )
            conn.commit()
            return int(row[0]), False
    cur = conn.execute(
        "INSERT INTO pending_threads (user_id, content, status,"
        " follow_up_after, source_memory_id, session_id, last_mentioned_at,"
        " created_at, updated_at, kind) VALUES (?, ?, 'open', ?, ?, ?, 0, ?, ?, ?)",
        (user_id, normalized, due, src_mid, sess, now, now, kind_final),
    )
    conn.commit()
    return int(cur.lastrowid or 0), True


def list_due_pending_threads(conn, user_id, now_ts=None, limit=4):
    """已到期且明确约定了时间的悬置话题(按人查,被动注入用)。

    不定时(follow_up_after=0)一律不进来 —— 「跟进」与「待办清单」的分界线。
    2026-10-06 D3:冷却/归档的行也一律不进来(`cooling_at>0` / `archived_at>0`)
    —— 这条也是**进 prompt 的路**(worker.py 的 threads_due 帧),所以它跟
    `lib/soul-snapshot.js` 的与门同批上闸。
    """
    now = time.time() if now_ts is None else float(now_ts)
    rows = conn.execute(
        "SELECT thread_id, content, follow_up_after, source_memory_id,"
        " created_at FROM pending_threads"
        " WHERE user_id = ? AND status = 'open'"
        " AND COALESCE(cooling_at, 0) = 0 AND COALESCE(archived_at, 0) = 0"
        " AND follow_up_after > 0 AND follow_up_after <= ?"
        " ORDER BY follow_up_after ASC LIMIT ?",
        (user_id, now, max(1, int(limit))),
    ).fetchall()
    return [
        {
            "thread_id": int(r[0]),
            "content": str(r[1] or ""),
            "follow_up_after": float(r[2] or 0.0),
            "source_memory_id": int(r[3] or 0),
            "created_at": float(r[4] or 0.0),
        }
        for r in rows
    ]


def list_remindable_threads(conn, now_ts=None, limit=3):
    """主动提醒候选:全局已到期+带时间+带会话(纯读,不落账)。

    与 list_due 的分工:那是「用户开口时顺带提」(按人查),这是
    「用户沉默时主动问」(全局查,必须有 session_id 才知道往哪发)。
    发送成功后由调用方显式 threads_mark 归零 —— 发送失败留池重试。

    2026-10-06 D3:冷却/归档的行不进来(这条是**她主动开口**的路,
    已经"不再打算问"的事不该再由她发起)。
    """
    now = time.time() if now_ts is None else float(now_ts)
    rows = conn.execute(
        "SELECT thread_id, user_id, content, follow_up_after, session_id"
        " FROM pending_threads"
        " WHERE status = 'open'"
        " AND COALESCE(cooling_at, 0) = 0 AND COALESCE(archived_at, 0) = 0"
        " AND follow_up_after > 0"
        " AND follow_up_after <= ?"
        " AND session_id IS NOT NULL AND session_id != ''"
        " ORDER BY follow_up_after ASC LIMIT ?",
        (now, max(1, int(limit))),
    ).fetchall()
    return [
        {
            "thread_id": int(r[0]),
            "user_id": str(r[1] or ""),
            "content": str(r[2] or ""),
            "follow_up_after": float(r[3] or 0.0),
            "session_id": str(r[4] or ""),
        }
        for r in rows
    ]


def list_open_pending_threads(conn, user_id, limit=20):
    """全部 open 悬置话题(面板/工具用):定时的在前,不定时的垫底。

    2026-10-06 D3:**这里刻意不排除冷却/归档行** —— 面板要看得见它们
    (五档里的"冷却/归档"两档就是靠 `cooling_at` / `archived_at` 切出来的),
    所以只**多带字段**,过滤留给调用方按档位做。
    """
    rows = conn.execute(
        "SELECT thread_id, content, follow_up_after, status,"
        " last_mentioned_at, created_at, kind, cooling_at, archived_at,"
        " superseded_by, updated_at FROM pending_threads"
        " WHERE user_id = ? AND status = 'open'"
        " ORDER BY CASE WHEN follow_up_after = 0 THEN 1 ELSE 0 END,"
        " follow_up_after ASC, updated_at DESC LIMIT ?",
        (user_id, max(1, int(limit))),
    ).fetchall()
    return [
        {
            "thread_id": int(r[0]),
            "content": str(r[1] or ""),
            "follow_up_after": float(r[2] or 0.0),
            "status": str(r[3] or "open"),
            "last_mentioned_at": float(r[4] or 0.0),
            "created_at": float(r[5] or 0.0),
            "kind": str(r[6] or ""),
            "cooling_at": float(r[7] or 0.0),
            "archived_at": float(r[8] or 0.0),
            "superseded_by": int(r[9] or 0),
            "updated_at": float(r[10] or 0.0),
        }
        for r in rows
    ]


# ---- 生命周期(2026-10-06 D2;设计文档《悬置话题机制设计》§3.2 / §3.3)----
#
# **影子期纪律**:这里只盖两列(`cooling_at` / `archived_at`),不动 `status`、
# 不动 `updated_at`、不删行;读出侧(注入 SQL / 面板 / 导出 / 打分)这一阶段
# **一行都不引用**这两列(D3 才让注入侧按它过滤)。
#
# 为什么归档用 `cooling_at` 而不是 `updated_at` 当基准:冷却刚盖上的那一拍,
# `updated_at` 可能已经是十几天前的了 —— 拿它当基准会让"冷却满 7 天"当天就成立,
# 七天的冷却期等于没有。基准必须是自己盖的那个戳。
ARCHIVE_AFTER_SECONDS = 7 * 86400

# 类内冷却期限(创建时刻 + 这些秒数)。'' = 未分类(判不出类型,给最短窗口)。
COOL_AFTER_SECONDS = {
    "care": 3 * 86400,
    "promise": 14 * 86400,
    "topic": 30 * 86400,
    "": 7 * 86400,
}

# 带事件时刻的两类:事件过后再宽限这么久才冷却(提醒只有一次价值)。
COOL_GRACE_SECONDS = {"schedule": 6 * 3600, "reminder": 12 * 3600}


def _cool_due(kind, now, created_at, follow_up_after, mentioned):
    """这一行该不该进冷却(纯判据,无副作用;便于单测逐条钉边界)。

    通用加码(设计 §3.2):**没提过 且 类内期限没到 ⇒ 不冷却** —— 免得"刚记下、
    还没提过"的事被静默降级。下面每条判据本身就带期限,所以这条是**结构保证**,
    不需要额外分支(`reminder` 的"提过即冷却"是唯一的例外,它本身就是期限)。
    """
    kind = str(kind or "")
    created = float(created_at or 0.0)
    due = float(follow_up_after or 0.0)
    if kind == "reminder" and mentioned:
        return True  # 提醒只有一次价值:提过就冷却(不必等事件时刻)
    grace = COOL_GRACE_SECONDS.get(kind)
    if grace is not None:
        base = due if due > 0 else created  # 有事件时刻用它;没有就退回创建时刻
        return base > 0 and now > base + grace
    limit = COOL_AFTER_SECONDS.get(kind, COOL_AFTER_SECONDS[""])
    if created <= 0 or now - created <= limit:
        return False
    if kind == "promise" and mentioned:
        return False  # 提过的承诺算"已兑现过",走 resolved 那条路
    return True


def cool_then_archive(conn, now=None, dry_run=False):
    """把到期的悬置话题盖两列:冷却(`cooling_at`)/ 归档(`archived_at`)。

    规则(设计 §3.2/§3.3,逐条):
      · 冷却(只对 `status='open'` 且还没盖过的行)
        schedule  now > 事件时刻 + 6h      reminder 提过,或 now > 提醒时刻 + 12h
        care      now - created_at > 3d    promise  now - created_at > 14d 且没提过
        topic     now - created_at > 30d   ''(未分类) now - created_at > 7d
      · 归档 冷却满 7 天,或 `status='resolved'` 满 7 天(基准 `updated_at`)
      · **一次性**:盖过的行不再盖(不回填)
      · **没有该动的行 ⇒ 一条 UPDATE 都不发**(不推 `updated_at`,
        "多久没动"这个判据不会被 tick 自己吃掉)

    @returns {dict} `{cooled: [id], archived: [id], scanned: n, now, dryRun}`
    """
    ts = float(now) if now else time.time()
    cols = ("thread_id", "status", "kind", "created_at", "follow_up_after",
            "last_mentioned_at", "cooling_at", "archived_at", "updated_at")
    idx = {name: i for i, name in enumerate(cols)}
    rows = conn.execute("SELECT " + ", ".join(cols) + " FROM pending_threads").fetchall()
    cooled, archived = [], []
    for row in rows:
        status = str(row[idx["status"]] or "open")
        cooling_at = float(row[idx["cooling_at"]] or 0.0)
        archived_at = float(row[idx["archived_at"]] or 0.0)
        if archived_at > 0:
            continue
        # ① 归档:冷却满 7 天 / resolved 满 7 天
        if cooling_at > 0 and ts - cooling_at > ARCHIVE_AFTER_SECONDS:
            archived.append(int(row[idx["thread_id"]]))
            continue
        if status == "resolved":
            updated = float(row[idx["updated_at"]] or 0.0)
            if updated > 0 and ts - updated > ARCHIVE_AFTER_SECONDS:
                archived.append(int(row[idx["thread_id"]]))
            continue
        # ② 冷却:只对还在 open 且没盖过的行
        if status != "open" or cooling_at > 0:
            continue
        if _cool_due(row[idx["kind"]], ts, row[idx["created_at"]],
                     row[idx["follow_up_after"]], float(row[idx["last_mentioned_at"]] or 0.0) > 0):
            cooled.append(int(row[idx["thread_id"]]))
    if not dry_run:
        if cooled:
            conn.execute(
                "UPDATE pending_threads SET cooling_at = ? WHERE thread_id IN ("
                + ",".join("?" for _ in cooled) + ")", (ts, *cooled))
        if archived:
            conn.execute(
                "UPDATE pending_threads SET archived_at = ? WHERE thread_id IN ("
                + ",".join("?" for _ in archived) + ")", (ts, *archived))
        if cooled or archived:
            conn.commit()
    return {"cooled": cooled, "archived": archived, "scanned": len(rows),
            "now": ts, "dryRun": bool(dry_run)}


def merge_thread_duplicates(conn, now=None, dry_run=False):
    """把库里**已经并存**的语义重复组合并成一条(设计 §4.3 · D4)。

    幸存者 = `thread_id` **最小**那条(面板/工具/审计引用过的 id 不换手);
    被并者:`status='archived'` + `superseded_by=幸存者` + `archived_at`,**不删行**
    —— 照 `episodic_memory` 的"留档取代"(`integrity.mark_superseded` 同款)。

    ⚠️ 被并者**额外**翻 `status='archived'`(与冷却不同:冷却只用列表达,因为
    那只是"不再问";被取代是"这份账已经作废"⇒ 不许再被消解/提醒/注入碰到,
    所以给它一个老读者也认不出的状态)。
    字段合并:content 取更长 · created_at 取最早 · `follow_up_after` 取最早到期且>0
    · session/source 取非空 · kind 取非空 · `last_mentioned_at` 取较晚。

    引擎**不写 audit_logs**(那是壳的事)⇒ 返回 `groups` 让调用方留痕。
    """
    ts = float(now) if now else time.time()
    cols = ("thread_id", "content", "kind", "status", "follow_up_after",
            "session_id", "source_memory_id", "created_at", "last_mentioned_at")
    idx = {n: i for i, n in enumerate(cols)}
    rows = conn.execute(
        "SELECT " + ", ".join(cols) + " FROM pending_threads"
        " WHERE status = 'open' AND COALESCE(archived_at, 0) = 0"
        " ORDER BY thread_id").fetchall()
    keepers = []
    for row in rows:
        item = {
            "thread_id": int(row[idx["thread_id"]]),
            "content": str(row[idx["content"]] or ""),
            "kind": str(row[idx["kind"]] or ""),
            "follow_up_after": float(row[idx["follow_up_after"]] or 0.0),
            "session_id": str(row[idx["session_id"]] or ""),
            "source_memory_id": int(row[idx["source_memory_id"]] or 0),
            "created_at": float(row[idx["created_at"]] or 0.0),
            "last_mentioned_at": float(row[idx["last_mentioned_at"]] or 0.0),
            "losers": [],
            "members": [str(row[idx["content"]] or "")],
        }
        hit = None
        for keeper in keepers:
            # 与**组内任一成员**比(不是只跟幸存者比):同一组里长短说法混着时,
            # 只要与其中任意一条过线就并进来(实测数据结构组:1-2 0.714、
            # 2-3 0.667、1-3 0.571 ⇒ 只跟幸存者比会漏掉第三条)。
            if any(_semantic_same(item["kind"], keeper["kind"], item["created_at"],
                                  keeper["created_at"],
                                  thread_similarity(item["content"], m))
                   for m in keeper["members"]):
                hit = keeper
                break
        if hit is None:
            keepers.append(item)
            continue
        if len(item["content"]) > len(hit["content"]):
            hit["content"] = item["content"]
        hit["created_at"] = min(hit["created_at"] or item["created_at"], item["created_at"])
        if item["follow_up_after"] > 0 and (
                hit["follow_up_after"] == 0 or item["follow_up_after"] < hit["follow_up_after"]):
            hit["follow_up_after"] = item["follow_up_after"]
        if not hit["session_id"]:
            hit["session_id"] = item["session_id"]
        if hit["source_memory_id"] == 0:
            hit["source_memory_id"] = item["source_memory_id"]
        if not hit["kind"]:
            hit["kind"] = item["kind"]
        hit["last_mentioned_at"] = max(hit["last_mentioned_at"], item["last_mentioned_at"])
        hit["members"].append(item["content"])
        hit["losers"].append(item["thread_id"])
    groups = [k for k in keepers if k["losers"]]
    if not dry_run:
        for g in groups:
            conn.execute(
                "UPDATE pending_threads SET content = ?, follow_up_after = ?,"
                " session_id = ?, source_memory_id = ?, created_at = ?,"
                " last_mentioned_at = ?, kind = ?, updated_at = ? WHERE thread_id = ?",
                (g["content"], g["follow_up_after"], g["session_id"],
                 g["source_memory_id"], g["created_at"], g["last_mentioned_at"],
                 g["kind"], ts, g["thread_id"]))
            for lid in g["losers"]:
                conn.execute(
                    "UPDATE pending_threads SET status = 'archived', superseded_by = ?,"
                    " archived_at = ?, updated_at = ? WHERE thread_id = ?",
                    (g["thread_id"], ts, ts, lid))
        if groups:
            conn.commit()
    return {
        "groups": [{"survivor": g["thread_id"], "losers": g["losers"]} for g in groups],
        "merged": sum(len(g["losers"]) for g in groups),
        "scanned": len(rows), "now": ts, "dryRun": bool(dry_run),
    }


def restore_pending_thread(conn, thread_id):
    """把一条**冷却中**的话题拉回活跃(2026-10-06 D5 的人工"恢复")。

    只认"活跃但冷却"的行(`cooling_at>0` ∧ `archived_at=0` ∧ `superseded_by=0`
    ∧ `status='open'`)—— 清掉 `cooling_at` 就算回到活跃档(冷却/归档只用列表达,
    见 D2 的说明)。
    **不给恢复的**:已归档的(`archived_at>0`,退出所有通路是它的定义)、
    被取代的(`superseded_by>0`,那份账已作废)、已了结的(`status='resolved'`)。
    返回 True/False(有没有真改到一行)。
    """
    tid = int(thread_id or 0)
    if tid <= 0:
        return False
    cur = conn.execute(
        "UPDATE pending_threads SET cooling_at = 0, updated_at = ?"
        " WHERE thread_id = ? AND status = 'open' AND cooling_at > 0"
        " AND COALESCE(archived_at, 0) = 0 AND COALESCE(superseded_by, 0) = 0",
        (time.time(), tid))
    conn.commit()
    return int(cur.rowcount or 0) > 0


def mark_pending_thread_mentioned(conn, thread_id):
    """提过一次就把 follow_up_after 归零 —— 同一件事不会被追问第二次。"""
    now = time.time()
    conn.execute(
        "UPDATE pending_threads SET last_mentioned_at = ?,"
        " follow_up_after = 0, updated_at = ? WHERE thread_id = ?",
        (now, now, int(thread_id)),
    )
    conn.commit()


def resolve_pending_thread(conn, user_id, query):
    """按内容双向子串关闭一条悬置话题。

    <称呼>自己说「面试完了」就把它结掉;返回 thread_id 或 None。
    """
    normalized = " ".join(str(query or "").split()).strip().casefold()
    if not normalized:
        return None
    now = time.time()
    rows = conn.execute(
        "SELECT thread_id, content FROM pending_threads"
        " WHERE user_id = ? AND status = 'open'"
        " ORDER BY updated_at DESC LIMIT 30",
        (user_id,),
    ).fetchall()
    for row in rows:
        content = str(row[1] or "").casefold()
        if normalized in content or content in normalized:
            conn.execute(
                "UPDATE pending_threads SET status = 'resolved',"
                " follow_up_after = 0, updated_at = ? WHERE thread_id = ?",
                (now, int(row[0])),
            )
            conn.commit()
            return int(row[0])
    return None
