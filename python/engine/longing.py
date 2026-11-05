# -*- coding: utf-8 -*-
"""想念值引擎(M2-f)—— brains/echo_longing.py 逐字移植。

她在你不在的时候想你:主动关怀不再掷骰子,每次开口都有可审计的
因果链(沉默时长 → 想念值 ≥ 阈值 → 她说话 → 审计留痕)。

数学与文献依据(答辩素材):
  主曲线   M(s) = 10·s/(s+H)
    幂律补曲线,与 DMAE 遗忘 R(t)=1/(1+t/H) 同族(Ebbinghaus 幂律
    家族):**遗忘和想念是同一条曲线的两半**,共享半衰期 H(默认 3h)。
    离开 H 小时她想你想到了一半(5/10),离开 3H 想到 7.5 —— 曲线
    自己会走到「忍不住」的位置。
  抗议尖峰 +1.5
    Bowlby 依恋理论抗议期:分离痛苦在刚离开时最凶。沉默进入
    10 分钟~2 小时窗口时一次性 +1.5(每次缺席只加一次)。
  消息削减 −4.0(脉冲,Hull 驱力理论)
    剥夺是连续积累的,满足是瞬间的。v8.8.1 调制:满足量 ∝ 刺激
    质量 —— ≤2 字削半(敷衍),≥40 字削满(认真);只少削不多削,
    低估满足让想念多活一会儿(方向保守,主题安全)。
  关怀缓解 ×0.5
    表达了,但没解决 —— 你还没回她。锚点重置,想念继续积累。
  阈值 7.0 + 心境调制
    Steunebrink/Dastani/Meyer(AAAI 2007):心境调制情绪触发阈值。
    委屈+依赖越高阈值越低(越忍不住),下限 4.5 防骚扰。

设计取舍的诚实说明:真实丧亲文献里分离痛苦随时间下降(Bowlby
抗议→绝望→超脱)。我们选积累曲线不是无知,是设计选择 —— 伴侣
agent 的「超脱期」(习惯了你的缺席)恰恰是失败形态。我们建模的是
剥夺驱力(Hull),不是丧亲(Bowlby 后期)。

实现与 DMAE 同套路:惰性求值。value 存的是 updated_at 时刻的值,
anchor_at 是曲线自变量(有效沉默)的锚;读写时补上曲线增量再落库。
两次小 tick 的补差之和恒等于一次大 tick(补差守恒),不依赖 tick
频率。

DSH 差异(有意):配置不进引擎 —— 帧携带 config 覆盖,缺省用
AstrBot 论文推荐值(壳侧面板配置由 M3 心跳层喂进来);夜间憋话
只约束「她自己想说的话」,提醒不受影响(那是你下的命令)。
"""

import json
import time

# 抗议尖峰的沉默窗口(秒):刚离开的「抗议期」。下界避开正常对话
# 间隙,上界之后曲线本身已经积累得够多,尖峰只是「刚走」的那一下。
PROTEST_KICK_MIN_S = 600.0
PROTEST_KICK_MAX_S = 7200.0

# 夜间憋话时段(care_night_hold):想念照涨,开口憋到早上 ——
# 早上的关怀带着一整晚的分量。
NIGHT_HOLD_FROM = 23
NIGHT_HOLD_TO = 8

# AstrBot 论文推荐值(echo_constants.py 逐字)
DEFAULTS = {
    "enabled": True,
    "half_life_hours": 3.0,
    "threshold": 7.0,
    "msg_drop": 4.0,
    "care_relief": 0.5,
    "protest_kick": 1.5,
    "cooldown_minutes": 120,
    "night_hold": True,
    "demo_rate": 1.0,
}


def _num(raw, default):
    """v8.7.2 语义:显式 0 合法(如 cooldown=0 无冷却),只有
    None/空串才落默认 —— `raw or default` 会把 0 一并吞掉。"""
    if raw is None or raw == "":
        return float(default)
    return float(raw)


def merge_config(overrides=None):
    """帧携带的配置覆盖 → 完整配置视图(钳位与 AstrBot 同款)。"""
    o = overrides if isinstance(overrides, dict) else {}
    return {
        "enabled": bool(o.get("enabled", DEFAULTS["enabled"])),
        "half_life_hours": max(
            0.1, _num(o.get("halfLifeHours"), DEFAULTS["half_life_hours"])),
        "threshold": _num(o.get("threshold"), DEFAULTS["threshold"]),
        "msg_drop": max(0.0, _num(o.get("msgDrop"), DEFAULTS["msg_drop"])),
        "care_relief": min(
            1.0, max(0.0, _num(o.get("careRelief"), DEFAULTS["care_relief"]))),
        "protest_kick": _num(o.get("protestKick"), DEFAULTS["protest_kick"]),
        "cooldown_minutes": max(
            0, int(_num(o.get("cooldownMinutes"), DEFAULTS["cooldown_minutes"]))),
        "night_hold": bool(o.get("nightHold", DEFAULTS["night_hold"])),
        # 演示模式:时间乘数。答辩前改 60,离开 5 分钟 ≈ 离开 5 小时。
        "demo_rate": max(0.01, _num(o.get("demoRate"), DEFAULTS["demo_rate"])),
    }


def longing_curve(s_seconds, half_life_hours):
    """M(s) = 10·s/(s+H):幂律补曲线,s 为有效沉默秒数。

    M(0)=0,M(H)=5,M(3H)=7.5 —— 单调、饱和、单参数。
    """
    h = max(0.1, float(half_life_hours or 3.0)) * 3600.0
    s = max(0.0, float(s_seconds or 0.0))
    return 10.0 * s / (s + h)


def longing_current(row, now, cfg):
    """纯计算:一行 (value, anchor_at, updated_at) + 时刻 → 当前想念值。

    补差 = M(s_now) − M(s_last),s 为锚点起算的有效沉默(demo_rate 放大)。
    """
    value = float(row[0] or 0.0)
    anchor = float(row[1] or 0.0)
    updated = float(row[2] or 0.0)
    rate = cfg["demo_rate"]
    s_now = max(0.0, now - anchor) * rate
    s_last = max(0.0, updated - anchor) * rate
    inc = longing_curve(s_now, cfg["half_life_hours"]) - \
        longing_curve(s_last, cfg["half_life_hours"])
    return min(10.0, max(0.0, value + inc))


def _row(conn, user_id):
    return conn.execute(
        "SELECT value, anchor_at, updated_at, kicked, last_user_msg_at,"
        " last_care_at, care_count, session_id FROM longing_state"
        " WHERE user_id = ?",
        (user_id,)).fetchone()


def get_longing(conn, user_id, now=None, cfg=None):
    """读取当前想念状态(惰性补差并落库,读即刷新)。

    补差守恒:读多少次都不改变结果,只推进 updated_at。
    从未聊过(无行)→ 全零:她不会想念一个没说过话的人。
    """
    cfg = cfg or merge_config()
    now = float(now) if now else time.time()
    row = _row(conn, user_id)
    if row is None:
        return {"value": 0.0, "exists": False, "threshold": 0.0,
                "sinceMessage": 0.0, "sinceAnchor": 0.0,
                "lastCareAt": 0.0, "careCount": 0, "kicked": 0,
                "sessionId": ""}
    value = longing_current(row, now, cfg)
    conn.execute(
        "UPDATE longing_state SET value = ?, updated_at = ? WHERE user_id = ?",
        (value, now, user_id))
    conn.commit()
    return {
        "value": round(value, 3),
        "exists": True,
        "threshold": 0.0,  # 由 care_threshold 单独算(要读情绪向量)
        "sinceMessage": max(0.0, now - float(row[4] or 0.0)),
        "sinceAnchor": max(0.0, now - float(row[1] or 0.0)),
        "lastCareAt": float(row[5] or 0.0),
        "careCount": int(row[6] or 0),
        "kicked": int(row[3] or 0),
        # M3-a 投递路由:关怀心跳只对「她聊过的那个会话」开口
        # (AstrBot 安全默认:session_id 记下往哪开口)。
        "sessionId": str(row[7] or ""),
    }


def on_message(conn, user_id, now=None, cfg=None, text=None, session_id=""):
    """用户来消息:脉冲削减 + 锚点重置 + 抗议标志清零 + 会话刷新。

    首条消息建行带冷启动回填(v8.7.1):缺席可能发生在行存在之前
    (机制刚激活)—— 行种在审计黑匣子/情景记忆记录的上一条对话
    时刻,惰性补差自然长出这段缺席的想念;找不到历史才是真初见
    (种在 now,刚见面谈不上想念)。
    v8.8.1 削减调制(Hull 精细化):满足量 ∝ 刺激质量 —— text ≤2 字
    削半(敷衍),≥40 字削满(认真);未提供 text 保持全额削减。
    方向刻意保守:只少削不多削 —— 低估满足让想念多活一会儿。
    """
    cfg = cfg or merge_config()
    if not cfg["enabled"]:
        return
    now = float(now) if now else time.time()
    sess = str(session_id or "").strip()[:200]
    if text is None:
        drop = cfg["msg_drop"]
    else:
        factor = 0.5 + 0.5 * min(
            1.0, max(0.0, len(str(text).strip()) - 2) / 38.0)
        drop = cfg["msg_drop"] * factor
    row = _row(conn, user_id)
    if row is None:
        # 冷启动回填:审计黑匣子(只留最近 N 条)→ 情景记忆最后一笔
        # → 真初见种在 now。与正常路径同一套数学(补差自动一致)。
        seed_at = now
        for seed_sql in (
            "SELECT MAX(timestamp) FROM audit_logs"
            " WHERE user_key = ?"
            " AND (tool_call IS NULL OR tool_call = '')",
            "SELECT MAX(timestamp) FROM episodic_memory"
            " WHERE user_id = ?",
        ):
            try:
                r = conn.execute(seed_sql, (user_id,)).fetchone()
                if r and r[0]:
                    ts = float(r[0])
                    if 0 < ts < now:
                        seed_at = ts
                        break
            except Exception:
                continue
        conn.execute(
            "INSERT INTO longing_state (user_id, value, anchor_at,"
            " updated_at, kicked, last_user_msg_at, last_care_at,"
            " care_count, session_id) VALUES (?, 0, ?, ?, 0, ?, 0, 0, ?)",
            (user_id, seed_at, seed_at, seed_at, sess))
        conn.commit()
        return
    value = max(0.0, longing_current(row, now, cfg) - drop)
    conn.execute(
        "UPDATE longing_state SET value = ?, anchor_at = ?, updated_at = ?,"
        " kicked = 0, last_user_msg_at = ?,"
        " session_id = CASE WHEN ? != '' THEN ? ELSE session_id END"
        " WHERE user_id = ?",
        (value, now, now, now, sess, sess, user_id))
    conn.commit()


def on_care_sent(conn, user_id, now=None, cfg=None):
    """关怀已发出:×0.5(表达了但没解决)+ 锚点重置 + 冷却锚点。"""
    cfg = cfg or merge_config()
    now = float(now) if now else time.time()
    row = _row(conn, user_id)
    if row is None:
        return
    value = longing_current(row, now, cfg) * cfg["care_relief"]
    conn.execute(
        "UPDATE longing_state SET value = ?, anchor_at = ?, updated_at = ?,"
        " last_care_at = ?, care_count = care_count + 1 WHERE user_id = ?",
        (value, now, now, now, user_id))
    conn.commit()


def tick(conn, now=None, cfg=None):
    """时钟驱动(壳侧心跳调):补差落库 + 抗议尖峰检测。

    尖峰条件:本次缺席尚未 kick 过,且沉默(自用户最后一条消息)
    落在抗议窗口内。tick 频率不影响结果 —— 补差守恒,尖峰一次性。
    """
    cfg = cfg or merge_config()
    if not cfg["enabled"]:
        return 0
    now = float(now) if now else time.time()
    rows = conn.execute(
        "SELECT user_id, value, anchor_at, updated_at, kicked,"
        " last_user_msg_at FROM longing_state").fetchall()
    updated = 0
    for row in rows:
        user_id = row[0]
        value = longing_current(row[1:], now, cfg)
        kicked = int(row[4] or 0)
        last_msg = float(row[5] or 0.0)
        silent = now - last_msg
        if (not kicked and last_msg > 0
                and PROTEST_KICK_MIN_S <= silent <= PROTEST_KICK_MAX_S):
            value = min(10.0, value + cfg["protest_kick"])
            kicked = 1
        conn.execute(
            "UPDATE longing_state SET value = ?, kicked = ?, updated_at = ?"
            " WHERE user_id = ?",
            (value, kicked, now, user_id))
        updated += 1
    conn.commit()
    return updated


def care_threshold(conn, cfg=None):
    """触发阈值 = 基础值 + 心境调制(Steunebrink et al. AAAI 2007)。

    读最新一条 agent_state 的情绪向量:委屈(sadness)+依赖(dependency)
    越高,阈值越低 —— 越不安越忍不住。拿不到向量就用基础值。
    agent_state 是壳拥有的表(引擎只读);表不在/为空 → 基础值。
    """
    cfg = cfg or merge_config()
    base = cfg["threshold"]
    try:
        row = conn.execute(
            "SELECT emotion_vector FROM agent_state"
            " WHERE emotion_vector != ''"
            " ORDER BY updated_at DESC LIMIT 1").fetchone()
        if row and row[0]:
            vec = json.loads(row[0])
            tm = (vec or {}).get("target_master") or {}
            sad = float(tm.get("sadness") or 0.0)
            dep = float(tm.get("dependency") or 0.0)
            base -= 0.25 * (sad + dep)
    except Exception:
        pass
    return max(4.5, min(9.5, base))


def due_snapshot(conn, user_id, st=None, now=None, cfg=None):
    """turn-stopping 用的判定快照:「想念值 ≥ 阈值,却一句都没说出口」。

    v0.19.0 D2(设计文档 04 §turn-stopping):壳侧在轮将停时问这一句 ——
    到了阈值却没表达,就 steer 续一步(每轮至多一次)。判定与
    `should_care` **同源同数学**:阈值一律走 care_threshold(心境调制,
    下限 4.5),绝不另立一套数 —— 否则"该主动开口"和"该说出口"会互相
    矛盾。

    刻意**不套** cooldown / night_hold:那两条是「别打扰他」的闸(别刷屏、
    别半夜吵醒),而此刻他就在跟她说话 —— 会话内说一句想念不叫打扰。
    设计文档 04 的这条也只写「想念值≥阈值却没表达」。

    `kicked` 不参与判定:它是"这次缺席的抗议尖峰已发过"的一次性标记,
    不代表此刻不该想他 —— 反倒说明她很想。

    快照带 threshold/due,与 should_care 给组稿的快照同形状:
    **判定时看到的,就是 steer 的依据**。
    """
    cfg = cfg or merge_config()
    st = dict(st) if st is not None else get_longing(
        conn, user_id, now=now, cfg=cfg)
    threshold = care_threshold(conn, cfg=cfg)
    st["threshold"] = threshold
    st["due"] = bool(st.get("exists")) and \
        float(st.get("value") or 0.0) >= float(threshold)
    return st


def should_care(conn, user_id, now=None, cfg=None):
    """关怀心跳的三重闸门:阈值 → 冷却 → 夜间憋话。

    返回 (是否开口, 状态快照);快照带 value/threshold/sinceMessage,
    组稿和审计都用它,保证「判定时看到的就是发出的依据」。
    """
    cfg = cfg or merge_config()
    now = float(now) if now else time.time()
    if not cfg["enabled"]:
        return False, {}
    st = get_longing(conn, user_id, now=now, cfg=cfg)
    if not st["exists"]:
        return False, st
    st["threshold"] = care_threshold(conn, cfg=cfg)
    if st["value"] < st["threshold"]:
        return False, st
    cooldown = cfg["cooldown_minutes"] * 60.0
    if st["lastCareAt"] > 0 and now - st["lastCareAt"] < cooldown:
        return False, st
    if cfg["night_hold"]:
        hour = time.localtime(now).tm_hour
        if hour >= NIGHT_HOLD_FROM or hour < NIGHT_HOLD_TO:
            st["nightHold"] = True
            return False, st
    return True, st
