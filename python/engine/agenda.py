# -*- coding: utf-8 -*-
"""她的议程簿(M2-b6)—— main.py:_pick_agenda/_mark_agenda_used 逐字移植。

动机(用户裁决原话):「我希望主动回复提出的话题是 agent 想提的,
而不是完全按照用户来。」—— 话题从**她的欲望**里长(Desire-driven
Autonomy),不从用户话头残渣里捡。会话策略层标准形式是 ESConv 的
Self-disclosure:支持者主动分享自己的事。

供给三层(设计稿 05 §3.3,按接地强度):
  persona      配置 her_interests(逗号分隔)—— 读配置不落库,改配置
               即生效,无同步问题;代价是没有用过降权(诚实边界)。
  reflection   Reflection 的 ongoing 洞察(b5 已接)—— 带证据链接。
  curiosity    对话里没接上话的追问 —— 设计稿标注「可后置」,本版不做。

消费(效用排序 top-1):
  效用 = weight × 新鲜度(1/(1+天数)) × 想念匹配
  天数从 max(created_at, last_used_at) 起算 —— 用过又冷却完的议题
  比新议题更不新鲜(提过一次了,别当新闻讲)。
  想念匹配 v1:委屈/依赖 ≥6 时 reflection 来源效用 ×1.5 —— 她心里
  憋着事的时候,开口更可能是惦记他,不是安利。
  用过即 last_used_at(48h 冷却,防复读机);**发送成功才算用过**
  (组稿失败/发送失败都不降权:她没说出口就不算提过 —— 调用方纪律)。
"""

import time

COOLDOWN_SECONDS = 48 * 3600   # 用过冷却:同议题两天内不重复提
MOODY_THRESHOLD = 6.0          # 委屈/依赖过此线 → 惦记型议题加权
WEIGHT_FLOOR = 0.2             # 权重下限(防负/零权重议题永远沉底)


def pick(conn, vec=None, now=None, interests=None):
    """效用排序取 top-1。返回 (item_id|None, content)。

    item_id 为 None 表示选中 persona 议题(配置侧,无落库行,
    无从降权)。无任何可用议题 → (None, "")。
    """
    now = float(now) if now else time.time()
    items = []  # (utility, item_id, content)

    # ---- persona 层:配置直读,恒新鲜(utility=1.0)----
    # v0.22.0 审查修正:壳侧发的是**数组**(`toggle.js` 的 `listOf(herInterests)`,
    # 测试里也是 `['写代码','看番']`),以前一律 `str(...)` 再按逗号切 ——
    # 议题文本会带着 `['`、`']` 一起进她的开场。两种形状都得认。
    if isinstance(interests, (list, tuple)):
        parts = [str(x) for x in interests]
    else:
        parts = str(interests or "").replace("，", ",").replace("、", ",").split(",")
    for part in parts:
        t = part.strip().strip("[]'\"").strip()
        if t:
            items.append((1.0, None, t))

    # ---- reflection 层:冷却外的活跃议题 ----
    rows = []
    try:
        cutoff = now - COOLDOWN_SECONDS
        rows = conn.execute(
            "SELECT item_id, content, origin, weight, created_at,"
            " last_used_at FROM her_agenda"
            " WHERE is_active = 1"
            "   AND (last_used_at IS NULL OR last_used_at = 0"
            "        OR last_used_at < ?)",
            (cutoff,),
        ).fetchall()
    except Exception:
        rows = []

    # 想念匹配:委屈/依赖高 → 惦记型(reflection 来源)加权
    moody = False
    if isinstance(vec, dict):
        tm = vec.get("target_master") or {}
        try:
            moody = (float(tm.get("sadness") or 0) >= MOODY_THRESHOLD
                     or float(tm.get("dependency") or 0) >= MOODY_THRESHOLD)
        except (TypeError, ValueError):
            moody = False

    for r in rows:
        content = str(r[1] or "").strip()
        if not content:
            continue
        origin = str(r[2] or "")
        try:
            weight = max(WEIGHT_FLOOR, float(r[3] or 1.0))
        except (TypeError, ValueError):
            weight = 1.0
        base = max(float(r[4] or now), float(r[5] or 0))
        days = max(0.0, (now - base) / 86400.0)
        utility = weight * (1.0 / (1.0 + days))
        if moody and origin == "reflection":
            utility *= 1.5
        items.append((utility, int(r[0]), content))

    if not items:
        return None, ""
    items.sort(key=lambda x: x[0], reverse=True)
    return items[0][1], items[0][2]


def mark_used(conn, item_id, now=None):
    """用过降权的写侧(48h 冷却)。调用方纪律:发送成功才调。"""
    if not item_id:
        return False
    now = float(now) if now else time.time()
    conn.execute(
        "UPDATE her_agenda SET last_used_at = ?"
        " WHERE item_id = ? AND is_active = 1",
        (now, int(item_id)),
    )
    conn.commit()
    return True
