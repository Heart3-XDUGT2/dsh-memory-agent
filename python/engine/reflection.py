# -*- coding: utf-8 -*-
"""Reflection 记忆整固(M2-b5)—— main.py:_run_reflection@1910 逐字移植。

Park et al. 2023 反思机制 + 睡眠依赖整固(Rasch & Born 2013):她夜里
把白天的事想一遍,早上的关怀带着整固后的认识开口。

与 EXTRACT 的分工:EXTRACT 记录单轮(是什么),Reflection 跨轮归纳
(意味着什么)。

防失真三件套(逐条对应 Bartlett 1932 / Nature 2024 的递归失真风险):
  ① 只吃原始记忆不吃上轮反思(候选查询按 layer 排除,递归深度=1);
  ② evidence_ids 必须全部命中候选集,没证据的条目一律丢弃;
  ③ summary 长度守卫(≤80)+ 与既有反思行同文去重。
合并工单只退役 L0 源 —— 普通层记忆各有独立证据,合并会丢语境。

游标语义(代码即真相):LLM 返回非空 items 列表 → 游标推进到本轮
窗口末条(即使所有条目被守卫丢弃 —— 没证据的条目是噪声,跳过是
刻意的);items 为空/坏 → 游标不动,下轮重试。

DSH 帧拆分:AstrBot 在一个函数里做「读窗口→判触发→跑 LLM→落库」;
DSH 把 LLM 挪到壳侧跑 —— reflection_prompt 帧做触发判定+组装提示词
(候选窗口存 worker state),reflection_commit 帧做守卫落库+推游标。
reflection_enabled 开关是壳侧策略(要不要调),引擎不重复设门。
"""

import time

from . import dmae
from . import integrity

IMPORTANCE_THRESHOLD = 30.0   # 候选情感分累计阈值(AstrBot 默认)
MAX_INPUTS = 50               # 单轮窗口上限(max(5, cfg) 的默认值)
NIGHT_START_HOUR = 23         # 夜间整固窗口:23:00~08:00
NIGHT_END_HOUR = 8
NIGHT_GAP_SECONDS = 12 * 3600  # 夜间窗口还要求距上次整固 >12h

SYSTEM_PROMPT = """你是记忆整固模块(Reflection)。给你一批刚写入的情景记忆(带编号),做两件事:
1. 合并(kind=merge):找出说的是**同一件事**的重复条目(通常是同义转述),输出一条合并后的演化信念,evidence_ids 列出**全部**被合并条目的编号。
2. 洞察(kind=insight):跨多条记忆提炼更高层的认识(进行中的事/规律/情绪主线),evidence_ids 列出支撑该认识的条目编号。进行中/未完结的事(还没出结果的故事,如秋招准备、比赛报名)额外加 "ongoing": true —— 那会进她的议程簿,成为她主动开口时想聊的事。
纪律:
- 只归纳已经说过的,禁止推断、预测、补全没发生的事
- summary 不超过 60 字,第三人称陈述(如"他在准备秋招")
- evidence_ids 必须非空,且只能用给你的编号 —— 没有证据的条目一律丢弃
- 没有可合并的重复、也没有值得提炼的认识,就输出空列表,不要硬凑
输出 JSON(禁止任何其他文字):
{"items": [{"kind": "merge", "summary": "...", "evidence_ids": [1, 2], "keywords": "大学,大一"}, {"kind": "insight", "summary": "...", "evidence_ids": [3], "keywords": "秋招", "ongoing": true}]}"""

USER_TEMPLATE = """[待整固的记忆](编号|层次|情感分|摘要):
{memories}

请输出整固结果 JSON。"""


def _read_state(conn, owner):
    row = conn.execute(
        "SELECT last_memory_id, last_at FROM reflection_state"
        " WHERE user_id = ?", (owner,)).fetchone()
    if not row:
        return 0, 0.0
    return int(row[0] or 0), float(row[1] or 0.0)


def _read_window(conn, owner, last_id, limit):
    """候选窗口:游标之后的活跃非反思记忆(防失真①:不吃上轮反思;
    M2-h:隔离候选不算 —— 反思总结的是她已确信的事,不总结悬案)。"""
    return conn.execute(
        "SELECT memory_id, summary, keywords, emotion_score, layer"
        " FROM episodic_memory"
        " WHERE user_id = ? AND memory_id > ? AND is_active = 1"
        "   AND (status IS NULL OR status = 'active')"
        "   AND (layer IS NULL OR layer = ''"
        "        OR layer != 'reflection')"
        " ORDER BY memory_id LIMIT ?",
        (owner, last_id, limit),
    ).fetchall()


def check(conn, owner, now=None, importance_threshold=None, max_inputs=None):
    """读游标 → 读窗口 → 判触发 → 组装提示词。

    返回 dict。triggered=True 时 caller(壳)拿 systemPrompt/userPrompt
    去跑 LLM,再把 items 发回 reflection_commit。

    v0.22.0:两个旋钮可由面板覆盖(A `main.py:1926-1927` 逐字 ——
    阈值默认 30.0,窗口 `max(5, cfg)` 默认 50)。传 None = 引擎默认,
    所以不带 config 的老调用行为完全不变。
    """
    now = float(now) if now else time.time()
    try:
        threshold = float(importance_threshold) if importance_threshold is not None else IMPORTANCE_THRESHOLD
    except (TypeError, ValueError):
        threshold = IMPORTANCE_THRESHOLD
    try:
        window = max(5, int(max_inputs)) if max_inputs is not None else MAX_INPUTS
    except (TypeError, ValueError):
        window = MAX_INPUTS
    last_id, last_at = _read_state(conn, owner)
    rows = _read_window(conn, owner, last_id, window)
    if not rows:
        return {"triggered": False, "reason": "no_candidates",
                "lastMemoryId": last_id}
    importance = sum(max(0, int(r[3] or 0)) for r in rows)
    hour = time.localtime(now).tm_hour
    night = hour >= NIGHT_START_HOUR or hour < NIGHT_END_HOUR
    if not (importance >= threshold
            or (night and now - last_at > NIGHT_GAP_SECONDS)):
        return {"triggered": False, "reason": "below_threshold",
                "importance": importance, "night": night,
                "threshold": threshold,
                "lastMemoryId": last_id}
    mem_lines = []
    for r in rows:
        mem_lines.append(
            f"#{int(r[0])}|{(r[4] or '普通')}|情感{r[3]}|{(r[1] or '')[:60]}"
        )
    user_prompt = USER_TEMPLATE.replace("{memories}", "\n".join(mem_lines))
    return {
        "triggered": True,
        "systemPrompt": SYSTEM_PROMPT,
        "userPrompt": user_prompt,
        "candidateIds": [int(r[0]) for r in rows],
        # commit 侧算 src_score 用(证据条目的最高情感分)
        "candidateScores": {int(r[0]): int(r[3] or 0) for r in rows},
        "lastMemoryId": int(rows[-1][0]),
        "importance": importance,
        "night": night,
    }


def commit(conn, owner, items, round_state, now=None):
    """守卫落库 + 推游标。round_state = check 返回的候选窗口信息。

    游标语义:items 非空列表 → 推进到窗口末条;空/坏 → 不动,下轮重试。
    """
    now = float(now) if now else time.time()
    if not isinstance(items, list) or not items:
        # 与关怀的「沉默纪律」同款(绝不硬写)—— 但游标不动,下轮重试。
        return {"written": 0, "merged": 0, "agenda": 0, "dropped": [],
                "cursorAdvanced": False, "reason": "no_items"}
    id_set = set(round_state.get("candidateIds") or [])
    scores = round_state.get("candidateScores") or {}
    last_memory_id = int(round_state.get("lastMemoryId") or 0)

    written = 0
    merged = 0
    agenda = 0
    dropped = []
    summaries = []
    for it in items:
        if not isinstance(it, dict):
            continue
        kind = str(it.get("kind") or "").strip()
        summary = str(it.get("summary") or "").strip()
        ev_ids = []
        if isinstance(it.get("evidence_ids"), list):
            for x in it["evidence_ids"]:
                try:
                    xi = int(x)
                except (TypeError, ValueError):
                    continue
                if xi in id_set and xi not in ev_ids:
                    ev_ids.append(xi)
        if kind not in ("merge", "insight"):
            dropped.append({"summary": summary[:40], "reason": "坏kind"})
            continue
        if not summary or len(summary) > 80 or not ev_ids:
            # 守卫:没证据/超长/坏 kind 一律丢弃(防失真②③)
            dropped.append({"summary": summary[:40],
                            "reason": "无证据或超长" if summary else "空摘要"})
            continue
        dup = conn.execute(
            "SELECT COUNT(*) FROM episodic_memory"
            " WHERE user_id = ? AND layer = 'reflection'"
            "   AND is_active = 1 AND summary = ?",
            (owner, summary),
        ).fetchone()[0]
        if dup:
            dropped.append({"summary": summary[:40], "reason": "同文去重"})
            continue
        src_score = 0
        for eid in ev_ids:
            src_score = max(src_score, int(scores.get(eid, 0)))
        kw = str(it.get("keywords") or "").strip() or summary[:20]
        # 2026-09-27 F4:整固幸存者必须**继承来源的层与内在价值**。
        # 现场:这条 INSERT 硬编码 layer='reflection',列清单里根本没有
        # intrinsic_value / half_life ⇒ 走 DDL 默认(iv=0 / hl=0)。
        # 实测后果:`layer='reflection'` 共 92 条,**92 条 iv=0(100%)**,
        # 41 条 hl=0。更致命的是 :216 的 merge 分支正是把 **L0 源**退役进
        # 这一行 —— L0 层于是被系统性抽干,只剩 #125 一条(风又音理),
        # 而 L0 是每轮强制注入的。
        # 规则(只对 kind='merge' 继承 L0 —— 只有它退役 L0 源;insight 是
        # 新推理,不是替代品,层不动):
        #   * 任一来源是 L0 ⇒ 幸存者 L0
        #   * iv = max(来源 iv, 来源情感分 × 10) —— 与 episodic.py 的降级
        #     估算同一把尺子(那里也是 score×10 夹在 1~100)
        #   * h0 由 iv 推(dmae.initial_half_life),别再留 0 —— hl=0 会让
        #     这条记忆的 R 恒为 0,任何检索都吃不到它
        src_rows = []
        if ev_ids:
            ph = ",".join("?" for _ in ev_ids)
            src_rows = conn.execute(
                "SELECT layer, intrinsic_value FROM episodic_memory"
                " WHERE memory_id IN (" + ph + ")",
                tuple(ev_ids),
            ).fetchall()
        any_l0 = any(str(r[0] or "") == "L0" for r in src_rows)
        src_iv = max([float(r[1] or 0.0) for r in src_rows] + [0.0])
        i_val = max(src_iv, max(1.0, min(100.0, float(src_score) * 10.0)))
        h0 = dmae.initial_half_life(i_val, dmae.DMAE_DEFAULT)
        new_layer = "L0" if (kind == "merge" and any_l0) else "reflection"
        cur = conn.execute(
            "INSERT INTO episodic_memory (user_id, keywords, summary,"
            " emotion_score, timestamp, is_active, source, speaker_id,"
            " is_master, intrinsic_value, half_life, recall_count,"
            " last_recalled, learned_at, layer, evidence)"
            " VALUES (?, ?, ?, ?, ?, 1, 'reflection', '', 1,"
            " ?, ?, 0, ?, ?, ?, ?)",
            (owner, kw, summary, src_score, now,
             i_val, h0, now, now, new_layer,
             "依据:记忆" + "、".join(str(i) for i in ev_ids)),
        )
        new_id = int(getattr(cur, "lastrowid", 0) or 0)
        written += 1
        summaries.append(summary)
        # 进行中的洞察进她的议程簿(b6 消费):主动开口的话题从她的
        # 欲望里长,不从用户话头残渣里捡。同文已在议程上就不重复登记。
        if kind == "insight" and it.get("ongoing"):
            on_agenda = conn.execute(
                "SELECT COUNT(*) FROM her_agenda"
                " WHERE is_active = 1 AND content = ?",
                (summary,),
            ).fetchone()[0]
            if not on_agenda:
                conn.execute(
                    "INSERT INTO her_agenda (content, origin,"
                    " source_ids, weight, created_at,"
                    " last_used_at, is_active)"
                    " VALUES (?, 'reflection', ?, ?, ?, 0, 1)",
                    (summary,
                     "记忆" + "、".join(str(i) for i in ev_ids),
                     1.0 + 0.1 * src_score, now),
                )
                agenda += 1
        if kind == "merge" and new_id:
            # 只退役 L0 源 —— 普通层记忆各有独立证据,合并会丢语境。
            # 隔离中的 L0 不退役:悬案没定谳,反思无权处置待观察候选。
            # 2026-09-27 F1:走 integrity.mark_superseded —— new_id 解析不到
            # 就只退役、不写骗人的引用(见 integrity 模块 docstring)。
            ph = ",".join("?" for _ in ev_ids)
            cur = integrity.mark_superseded(
                conn, "episodic_memory", "memory_id", new_id,
                "memory_id IN (" + ph + ")"
                "   AND layer = 'L0' AND is_active = 1"
                "   AND (status IS NULL OR status = 'active')",
                tuple(ev_ids),
            )
            # AstrBot 原版这里无条件 +1(工单数,不是退役数)—— 实测
            # 普通层源一条没退役时 ack 也报 1,审计在撒谎。DSH 的 ack
            # 契约要求诚实:按实际退役行数计(存储语义不变)。
            # (F1 后 cur 是 mark_superseded 返回的**行数**,不再是 cursor。)
            merged += int(cur or 0)
    # 游标推进:items 非空即推进(即使全部被守卫丢弃 —— 没证据的
    # 条目是噪声,跳过是刻意的)。
    conn.execute(
        "INSERT INTO reflection_state (user_id, last_memory_id,"
        " last_at) VALUES (?, ?, ?)"
        " ON CONFLICT(user_id) DO UPDATE SET"
        " last_memory_id = excluded.last_memory_id,"
        " last_at = excluded.last_at",
        (owner, last_memory_id, now),
    )
    conn.commit()
    return {"written": written, "merged": merged, "agenda": agenda,
            "dropped": dropped, "cursorAdvanced": True,
            "cursor": last_memory_id,
            "summaries": [s[:80] for s in summaries]}
