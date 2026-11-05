# -*- coding: utf-8 -*-
"""情景记忆写入(M2-b4)—— echo_memory_engine._insert_memory:647-761 逐字移植。

v6.0:情景记忆纳入半衰期模型 —— I 决定 H0,last_recalled 是衰减时钟锚点,
与图记忆同一把尺子。
v8.4:三种时间分开存(occurred_at / learned_at / timestamp)+ 槽位取代 ——
同 (user_id, memory_key) 只保留一条现役;旧版本 is_active=0 + superseded_by
留档,偏好改了是「换代」而不是「叠加成两条互相矛盾的记忆」。
v2-A1(2026-10-01):换代**只在非集合键上**发生 —— `longTermInterests` /
`preferred_food` 这类"可累加一串"的键(见 `relations.MULTIVALUE_MEMORY_KEYS`)
允许同键多条并存:「并列不是矛盾」。实测动机:memory 313(喜欢玩 KARDS)
被 315(战地1)顶下线 —— 两件事同时为真,不该互相顶。
同一句话再说第二遍 = 一次「想起」:按间隔效应延长半衰期,不塞重复行。
"""

import json
import re
import sqlite3
import time

from . import cancel
from . import dedupe as dedupe_mod
from . import dmae
from . import integrity
from . import relations as relations_mod

#: TTL 治理的内在价值豁免线(F7)。与 `lib/cleanup-guard.js:PROTECT_IV` 同值 ——
#: 两条清理路径不该对"什么算高价值"有两套说法。
CLEANUP_PROTECT_IV = 50.0


def _dedupe_threshold(dedupe_opts, key):
    """从壳给的 dedupe 配置里取阈值;缺省回落到 dedupe 的默认值。

    壳(JS)传 `{"kwThreshold": x, "summaryThreshold": y}`;`x=0` 即关闭。
    传 None/缺键 → 用权威默认(dedupe.DEDUPE_DEFAULTS)。
    """
    if not isinstance(dedupe_opts, dict):
        return float(dedupe_mod.DEDUPE_DEFAULTS[key])
    raw = dedupe_opts.get(key)
    if raw is None:
        return float(dedupe_mod.DEDUPE_DEFAULTS[key])
    try:
        return max(0.0, float(raw))
    except (TypeError, ValueError):
        return float(dedupe_mod.DEDUPE_DEFAULTS[key])


def derive_keywords(text, cap=12):
    """用户直教记忆的关键词派生(M3-b,确定性,无 LLM)。

    Judge 路径的关键词来自 LLM 的 evidenceQuotes;echo_remember 没有
    LLM 可问,用规则派生:字母/数字词(≥2 字符)+ CJK 二元滑窗。
    二元组是检索的主力 —— hit_score 第一档「kw in query」对短查询
    (「面试」)只有靠它才吃得到;摘要回退档位太弱(0.3),教过的
    事必须想得起来。
    """
    text = str(text or "").strip()
    if not text:
        return []
    kws = []
    seen = set()

    def _add(k):
        if k and k not in seen:
            seen.add(k)
            kws.append(k)

    for m in re.finditer(r"[0-9A-Za-z_\-]{2,}", text):
        _add(m.group(0))
    for run in re.findall(r"[\u4e00-\u9fff]+", text):
        for i in range(len(run) - 1):
            _add(run[i : i + 2])
    return kws[:cap]


def insert_memory(
    conn, user_id, keywords_json, summary, score, *,
    source="private", source_label="", actor="", speaker_id="",
    is_master=True, intrinsic_value=0.0, occurred_at=0.0,
    temporal_status="", memory_key="", layer="", now=None,
    status="active", dedupe=None, aug_keys=None,
    memory_type="", memory_stability="",
):
    """写入一条情景记忆,返回 memory_id。

    status(M2-h):'active' = 正式记忆(检索/反思可见);
    'quarantined' = 待观察候选(置信度 0.55~0.75,只落库不进检索)。
    同 slot 高置信候选后来居上时,槽位取代照常发生 —— 隔离候选
    被正式版本顶掉,这就是晋升路径。

    memory_type / memory_stability(2026-10-12):**接住 Judge 已经输出的
    `field` / `stability`**(见 `judge.py` 的 `L0_FIELDS`/`L1_FIELDS` 与
    `VALID_STABILITIES`)。在这之前它们落库时被丢掉 —— 4/6 个 field 与
    整个 stability 都留不下来,于是记忆侧没有"类型"可用。

    ⚠️ **这两列当前不参与任何判断**(检索/`layer`/图谱一个字不动),纯落库。
    空串 = 旧行为;老行留空、不回填(我们**不知道**老记忆是什么类型,
    猜一个比留空更坏)。

    dedupe(v0.16.0 M3):`{"kwThreshold": 0.6, "summaryThreshold": 0.7}`
    —— 槽位路径没命中时的**近重复兜底**。为什么需要:去重键 =
    `slot or field`,而 L2 没有 field、slot 由模型自由命名(同一件事写成
    food_preference 与 preferred_food),导入行与反思行键全空 ——
    实测 161 条现役记忆里有 43 条属于「换个说法讲同一件事」。
    阈值给 0 即关闭(回到「同键同句才算想起」的旧行为)。

    (v0.29.0 个人机器人裁剪:channel / channel_chat 渠道维度随群聊拒收
    一起退役 —— 只服务他一个人,记忆不再分渠道。)
    """
    now = float(now) if now else time.time()
    i_val = float(intrinsic_value or 0.0)
    # 2026-09-30:写入侧的"说法键"(fact-augmented keys,LongMemEval 里的 +9.4% 那一招)。
    # 存 JSON 数组;空 ⇒ NULL(老行为;检索侧读到空就是不加字面)。
    aug_json = None
    if isinstance(aug_keys, (list, tuple)):
        _ak = [str(k).strip() for k in aug_keys if str(k).strip()]
        if _ak:
            aug_json = json.dumps(_ak[:6], ensure_ascii=False)
    if i_val <= 0:
        # 降级路径(没有 Judge 字段可用)时按 emotion_score 粗估一个 I
        i_val = max(1.0, min(100.0, float(score or 0) * 10.0))
    h0 = dmae.initial_half_life(i_val, dmae.DMAE_DEFAULT)
    key = (memory_key or "").strip()[:64]
    # v2-A1:集合键(longTermInterests / preferred_food …)允许同键多条并存 ——
    # 「并列不是矛盾」。判断口径只在 relations.py 一处。
    collection_key = relations_mod.is_multi_value_memory_key(key)
    tstat = (temporal_status or "").strip() or "time_unknown"
    clean_summary = (summary or "").strip()
    my_status = "quarantined" if str(status or "").strip() == "quarantined" else "active"

    def _reinforce(row_id, old_h, last):
        old_h = float(old_h or 0.0) or h0
        last = float(last or now)
        new_h = dmae.reinforce_half_life(
            old_h,
            dmae.retrievability((now - last) / 3600.0, old_h),
            dmae.DMAE_DEFAULT,
        )
        conn.execute(
            "UPDATE episodic_memory SET half_life = ?,"
            " recall_count = recall_count + 1, last_recalled = ?,"
            " learned_at = CASE WHEN learned_at > 0 THEN learned_at ELSE ? END"
            " WHERE memory_id = ?",
            (new_h, now, now, int(row_id)),
        )
        conn.commit()
        return int(row_id)

    prev_id = 0
    if key:
        # 槽位查找状态感知(M2-h):强化/取代只在同状态内发生 ——
        # 隔离行不会被低置信重观测「强化」(它还没资格当记忆),
        # 正式行也不会被隔离候选「取代」(降级不是闸门的本意)。
        prev = conn.execute(
            "SELECT memory_id, summary, half_life, last_recalled"
            " FROM episodic_memory"
            " WHERE user_id = ? AND memory_key = ? AND is_active = 1"
            " AND status = ?"
            " ORDER BY memory_id DESC LIMIT 1",
            (user_id, key, my_status),
        ).fetchone()
        if prev is not None:
            if str(prev[1] or "").strip() == clean_summary:
                # 同一句话再说第二遍:这是一次「想起」,不是一条新记忆。
                return _reinforce(prev[0], prev[2], prev[3])
            # v2-A1:集合键**不换代**(并列);其余键照旧换代。
            prev_id = 0 if collection_key else int(prev[0])
        if my_status == "quarantined":
            # 降观察:正式行同句已在 → 这次弱重观测是佐证,强化正式行,
            # 不落重复的隔离行(已确立的事实不因低置信重测而降级)。
            act = conn.execute(
                "SELECT memory_id, summary, half_life, last_recalled"
                " FROM episodic_memory"
                " WHERE user_id = ? AND memory_key = ? AND is_active = 1"
                " AND status = 'active'"
                " ORDER BY memory_id DESC LIMIT 1",
                (user_id, key),
            ).fetchone()
            if act is not None and str(act[1] or "").strip() == clean_summary:
                return _reinforce(act[0], act[2], act[3])

    # ---- v0.16.0 M3 近重复兜底(槽位路径没命中时才扫)----
    # 判据在 dedupe.py(权威);同层 + 同 status 是硬前提。
    # v2-A1:集合键不走这条路 —— 近重复的"同键"内容在多值键下是**并列**,
    # 不该被当成换代候选(否则「喜欢玩KARDS」仍会被「喜欢玩KARDS里的德美跳费卡组」顶掉)。
    if not prev_id and clean_summary and not collection_key:
        kw_t = _dedupe_threshold(dedupe, "kwThreshold")
        sum_t = _dedupe_threshold(dedupe, "summaryThreshold")
        if kw_t > 0 or sum_t > 0:
            try:
                cands = conn.execute(
                    "SELECT memory_id, summary, keywords, half_life, last_recalled"
                    " FROM episodic_memory"
                    " WHERE user_id = ? AND is_active = 1 AND status = ?"
                    " AND " + dedupe_mod.LAYER_SQL + " = ?"
                    " ORDER BY memory_id DESC LIMIT 200",
                    (user_id, my_status, dedupe_mod.normalize_layer(layer)),
                ).fetchall()
            except sqlite3.Error:
                cands = []
            mine = {"keywords": keywords_json, "summary": clean_summary,
                    "layer": layer, "status": my_status}
            for row in cands:
                # 取消检查点:去重候选循环逐条算近重复(摘要 + 关键词两组
                # 阈值),库大时这段不短。轮首检查,提前 return 的路径不受影响。
                cancel.checkpoint()
                if str(row[1] or "").strip() == clean_summary:
                    # 同句(哪怕键不同)也算一次「想起」
                    return _reinforce(row[0], row[3], row[4])
                other = {"keywords": row[2], "summary": row[1],
                         "layer": layer, "status": my_status}
                if dedupe_mod.is_near_duplicate(
                        mine, other, kw_threshold=kw_t, summary_threshold=sum_t):
                    prev_id = int(row[0])
                    break

    # 2026-09-27 F4:换代继承 —— 旧行是 L0 而调用方没指定层 ⇒ 继承 L0;
    # I 取两者最大。现场:`layer='reflection'` 92 条全部 iv=0,整固幸存者
    # 丢层丢值 ⇒ L0 层被清空到只剩 1 条,而 L0 是每轮强制注入的。
    # 「偏好改了是换代不是降级」—— 一条身份记忆不该因为换了句话就变碎片。
    # (必须放在这里:prev_id 要等槽位查找 + 近重复兜底两处都跑完才知道。)
    if prev_id:
        prow = conn.execute(
            "SELECT layer, intrinsic_value FROM episodic_memory WHERE memory_id = ?",
            (prev_id,),
        ).fetchone()
        if prow is not None:
            if not str(layer or "").strip() and str(prow[0] or "").strip():
                layer = str(prow[0])
            merged_iv = max(i_val, float(prow[1] or 0.0))
            if merged_iv != i_val:
                i_val = merged_iv
                h0 = dmae.initial_half_life(i_val, dmae.DMAE_DEFAULT)

    cur = conn.execute(
        "INSERT INTO episodic_memory "
        "(user_id, keywords, summary, emotion_score, timestamp, is_active, "
        "source, source_label, actor, speaker_id, is_master, "
        "intrinsic_value, half_life, recall_count, last_recalled, "
        "occurred_at, learned_at, temporal_status, memory_key, superseded_by, "
        "layer, status, aug_keys, memory_type, memory_stability) "
        "VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)",
        (
            user_id, keywords_json, summary, score, now,
            source, source_label, actor, speaker_id,
            1 if is_master else 0,
            i_val, h0, now,
            float(occurred_at or 0.0), now, tstat, key,
            str(layer or "").strip()[:4],
            my_status,
            aug_json,
            # 2026-10-12:类型两列(接住 Judge 的 field / stability)。
            # ⚠️ 截 32 字而不是 16:`longTermInterests` 正好 17 字,16 会把它截成
            # `longTermInterest`(丢 s)—— 实测踩到过。32 对现有取值足够宽。
            str(memory_type or "").strip()[:32],
            str(memory_stability or "").strip()[:32],
        ),
    )
    mid = int(cur.lastrowid or 0)
    if prev_id and mid:
        # 旧版本让位:不删除,半衰期/想起次数一起留档,审计面板翻得出来
        # (「她以前以为…」仍可查)。
        # 2026-09-27 F1:走 integrity.mark_superseded —— 写引用前先校验 mid
        # 真的在表里(A 侧迁移残留过 16 条悬空引用,见 integrity 模块 docstring)。
        integrity.mark_superseded(
            conn, "episodic_memory", "memory_id", mid,
            "memory_id = ?", (prev_id,),
        )
    if key and my_status == "active" and mid:
        # 晋升收尾:正式版本落库,同 key 的隔离候选一并让位 ——
        # 悬案已定谳,待观察行不该再挂着。
        integrity.mark_superseded(
            conn, "episodic_memory", "memory_id", mid,
            "user_id = ? AND memory_key = ? AND is_active = 1"
            " AND status = 'quarantined'",
            (user_id, key),
        )
    conn.commit()
    return mid


def cleanup_stale(conn, user_id, ttl_days, *, now=None):
    """记忆治理(v0.14.5 S9):超 TTL 且情感分 < 6 的软删;过老的死行物理清。

    逐字移植 A 侧 `echo_memory_engine._cleanup_stale_memories:1239-1257`:

        UPDATE episodic_memory SET is_active = 0
         WHERE is_active = 1 AND timestamp < cutoff AND emotion_score < 6
        DELETE FROM episodic_memory WHERE is_active = 0 AND timestamp < hard_cutoff

    为什么高分记忆免死:**情感分是内在价值**。一次高情感事件(她第一次
    被认真夸、你生病那次)按 DMAE 的半衰期本来就该活得久 —— 时间到了
    就一律清掉,等于把「她最记得的事」先扔掉。低分噪声才是 TTL 的对象。

    2026-09-27 F7:再加一条 `intrinsic_value >= CLEANUP_PROTECT_IV` 的豁免。
    理由与上面那条一样,只是换了把尺子 —— 情感分是**事件当下**的强度,
    内在价值是 Judge 事后给的「这条对他有多重要」。两者都不该被 TTL 抹掉,
    而实测 92 条 reflection 行的 iv 全被整固 bug 写成 0(见 F4),所以这条
    现在多数时候不生效;一旦 F4 把 iv 修好,它就开始兜住真正高价值的那些。
    姊妹实现:`lib/cleanup-guard.js`(归档脚本侧,判据更严 —— 那条路是
    **追溯**施加文本判据,会把"他当前的项目"当脏记忆删掉)。

    硬删用 3×TTL:软删(换代/治理)的记录先留档,面板翻得出来「她以前
    以为…」;只有过老到没人会去翻的才真删,库不会无界增长。

    返回本轮软删条数(A 也是只回软删数)。
    """
    now = float(now) if now else time.time()
    days = max(1, int(ttl_days or 0) or 30)
    cutoff = now - days * 86400
    hard_cutoff = now - (days * 3) * 86400
    cur = conn.execute(
        "UPDATE episodic_memory SET is_active = 0"
        " WHERE user_id = ? AND is_active = 1 AND timestamp < ? AND emotion_score < 6"
        "   AND COALESCE(intrinsic_value, 0) < ?",
        (user_id, cutoff, CLEANUP_PROTECT_IV),
    )
    removed = int(cur.rowcount or 0)
    # 2026-09-27 F2:硬删不许删"被别人引用着"的行。删了就把留档链变成悬空引用
    # (面板上会写「被 #NNN 取代」而 #NNN 已经没了)。被引用的行一律豁免,
    # 它们本来就是留档,不该无界增长的是"没人翻的"那些。
    keep = integrity.referenced_ids(conn, "episodic_memory", "memory_id")
    if keep:
        ph = ",".join("?" for _ in keep)
        conn.execute(
            "DELETE FROM episodic_memory WHERE user_id = ? AND is_active = 0"
            " AND timestamp < ? AND CAST(memory_id AS TEXT) NOT IN (" + ph + ")",
            (user_id, hard_cutoff, *sorted(keep)),
        )
    else:
        conn.execute(
            "DELETE FROM episodic_memory WHERE user_id = ? AND is_active = 0 AND timestamp < ?",
            (user_id, hard_cutoff),
        )
    conn.commit()
    return removed


def clear_all(conn, user_id):
    """整库清空记忆与画像(v0.15.1 G14;A `_clear_all:1273-1296` 逐字)。

        DELETE FROM episodic_memory WHERE user_id = ?
        DELETE FROM user_profile    WHERE user_id = ?

    **这是唯一不可逆的入口**,所以语义上照抄 A:只清情景记忆与画像,
    别的一概不动 —— 图谱/悬置话题/审计/日记留着(A 也留着)。想连图谱
    一起重置是另一件事,不在这一步里偷偷做。

    (v0.29.0 个人机器人裁剪:A 的 `include_members`「连群友隔离空间
    (`member:` 桶)一起清」随群聊退役 —— DSH 单用户形态下它本来就是
    空操作上的同一句 SQL,参数删掉,不假装有这个桶。)

    返回 {'episodic': n, 'profile': n} 便于壳侧如实回话。
    """
    uid = str(user_id or "")
    if not uid:
        return {"episodic": 0, "profile": 0}
    cur = conn.execute(
        "DELETE FROM episodic_memory WHERE user_id = ?", (uid,))
    episodic_removed = int(cur.rowcount or 0)
    profile_removed = _delete_profile(conn, uid)
    conn.commit()
    return {"episodic": episodic_removed, "profile": profile_removed}


def _delete_profile(conn, uid):
    """删画像行 —— `user_profile` 是**壳拥有的表**,引擎自建的库没有它。

    2026-09-26 审查实测:引擎在自己的 DDL 上跑这里会
    `OperationalError: no such table: user_profile`(引擎侧全仓没有任何
    SELECT user_profile,`test_ddl_parity.py` 也把它列在 JS_ONLY_TABLES)。
    所以缺表就是"本来就没得删",按 0 处理;真库(壳建的)照删不误。
    """
    try:
        return int(conn.execute(
            "DELETE FROM user_profile WHERE user_id = ?", (uid,)).rowcount or 0)
    except sqlite3.OperationalError:
        return 0


# ═══════════════════════════════════════════════════════════════════════
# L0 降级(记忆侧)—— 对齐图侧 F11(`l0_tier.py:107-124`)
# ═══════════════════════════════════════════════════════════════════════

#: 记忆侧的"身份"类型名。与 `judge.FIELD_TO_MEMORY_TYPE` 里 `occupation` 的
#: 译名**同一个字符串** —— 那边是单一出处,这里是记忆侧的镜像常量。
IDENTITY_MEMORY_TYPE = "identity"


def demote_non_identity_l0_memories(conn, *, owner_key=None, use_summary=False,
                                    dry_run=False, commit=True):
    """把**非身份**的 L0 记忆降出 L0 —— 图侧 F11 的记忆侧同型件。

    为什么需要它:图侧有 F11(`l0_tier.py:107`)把非身份 L0 **边**降级,
    记忆侧**一直没有对应物** —— 于是「偏好占了 L0」这件事在记忆侧无闸可拦
    (L0 审计实测:13 条现役 L0 里只有 1 条是真身份)。

    ---- 判据(三条边界,互斥且穷尽)----

      * `memory_type == 'identity'`  → **不降**(它就该在 L0)
      * `memory_type == ''`(老数据)→ **不降**(不猜;见下)
      * 其余非空值(preference/interest/note/activity…)→ **降**

    ⚠️ **为什么空值不降**:老行没有类型信息,猜一个比留空更坏 —— 而且
    `layer='L0'` 里唯一那条真身份(#280)的 `memory_type` **也是空的**,
    一律降空值会把它一起降掉。这与 `l0_tier.py:70` 的「不猜:不显式给就
    只认角色槽(退化,宁少不错)」是同一条纪律。

    ---- 动作(对齐 F11 的留档语义)----

      * `layer` 从 `'L0'` 置为 `''` —— **不改成 `'L1'`**:L0/L1/L2 没有严格
        的层级语义(实测活库 `layer` 取值是 L0/L1/L2/reflection/空,而
        `reflection` 根本不是"层"),置空更干净,也与 F11 一致;
      * **不物理删、不动 `is_active`、不动 `intrinsic_value`** —— 它照常
        被检索、照常能被想起,只是不再进 L0 的强制占位;
      * 幂等:重复跑第二次,`demoted` 为 0。

    ---- 参数 ----

      `owner_key`:`user_id`。不给(None)⇒ **扫全表**(跨用户)。
      `use_summary`:留接口,**本步不做实现**。传 True ⇒ 抛
        `NotImplementedError` —— 绝不悄悄忽略(悄悄忽略会让调用方以为
        "老数据兜底过了",而其实一个字没兜)。
      `dry_run`:只统计不写库。
      `commit`:默认提交;批量调用方可传 False 自己控事务。

    返回 `{"checked", "demoted", "skipped_empty", "skipped_identity", "ids"}`。
    """
    if use_summary:
        raise NotImplementedError(
            "use_summary 只留接口,本步不做实现(2026-10-12 第二步)。"
            "要做的话:读 summary 对齐 l0_tier 的白名单口径,"
            "且必须保守 —— 盲目降所有空值会把唯一那条真身份(#280)也降掉。")

    sql = ("SELECT memory_id, memory_type FROM episodic_memory"
           " WHERE COALESCE(layer, '') = 'L0' AND is_active = 1")
    params = ()
    if owner_key is not None:
        sql += " AND user_id = ?"
        params = (str(owner_key),)

    rows = conn.execute(sql, params).fetchall()

    demoted, skipped_empty, skipped_identity = [], 0, 0
    for memory_id, mtype in rows:
        t = str(mtype or "").strip()
        if t == IDENTITY_MEMORY_TYPE:
            skipped_identity += 1
        elif not t:
            skipped_empty += 1
        else:
            demoted.append(int(memory_id))

    if demoted and not dry_run:
        conn.execute(
            "UPDATE episodic_memory SET layer = ''"
            " WHERE memory_id IN (" + ",".join("?" for _ in demoted) + ")",
            tuple(demoted),
        )
        if commit:
            conn.commit()

    return {"checked": len(rows), "demoted": len(demoted),
            "skipped_empty": skipped_empty, "skipped_identity": skipped_identity,
            "ids": demoted}
