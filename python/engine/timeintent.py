# -*- coding: utf-8 -*-
"""时间意图解析 —— 时间臂的入口。

**为什么有这个东西**:LongMemEval(arXiv 2410.10813,ICLR 2025)对"时间推理"给的
唯一优化是 **time-aware query expansion:用时间线索把检索范围收窄/引导**。
我们的量台读数与此对得上:N3 时间推理 2/4、N4 知识更新 1/3,是两个最差的档,
而生产检索链里**只有"越新越加权"(`W_REC * r_now`),没有任何时间意图**。

**这里只做解析**,召回与打分在 `retrieve.rank_memories` 里
(命中窗口 ⇒ ①把被覆盖率门槛挡掉的窗口内记忆**救回候选**;②窗口内加权)。

设计纪律(与量台一致):
  * **纯函数**:输入 `(query, now)` 出窗口 —— 不碰库、不调模型 ⇒ 可单测、可复现;
  * **宁缺勿滥**:没抓到**确定**线索就返回空窗口(⇒ 时间臂不生效),绝不猜;
  * **模糊线索不产窗口**:「那天 / 上次 / 当时 / 那时候」没有锚点,猜就是编 —— 只记进 `vague`;
  * 节日走**小表 + 最近年份**,不引农历库(表里 9-25 就是库里中秋的实际日期);
  * 窗口**只会加候选、只加权,永不删除** ⇒ 最坏情况是 no-op,不会掉召回。
"""

import re
import time

# ---------------------------------------------------------------- 线索表
# 单日相对线索:短语 → 相对 now 的天偏移(本地日)
_DAY_CUES = {
    "今天": 0, "今日": 0, "这天": 0,
    "昨天": -1, "昨日": -1, "昨晚": -1,
    "前天": -2,
    "明天": 1, "明日": 1, "后天": 2,
}

# 时段线索:短语 → (起点偏移天, 终点偏移天, 左闭右开)
_SPAN_CUES = {
    "最近": (7, 0), "近来": (7, 0), "近期": (7, 0),
    "这几天": (7, 0), "这两天": (3, 0), "这段时间": (7, 0),
    "这周": (7, 0), "本周": (7, 0),
    "上周": (14, 7),
    "这个月": (30, 0), "本月": (30, 0),
    "上个月": (60, 30),
    "今年": (365, 0), "去年": (730, 365),
}
_SPAN_SECONDS_CUES = {"刚才": 3600, "刚刚": 3600}        # now 前 N 秒

# 时钟线索:短语 → [起始小时, 结束小时)
_CLOCK_CUES = {
    "凌晨": (0, 5), "半夜": (0, 5), "深夜": (0, 5), "后半夜": (0, 5),
    "一大早": (5, 9), "清晨": (5, 9), "早晨": (5, 9), "早上": (5, 9),
    "上午": (9, 12), "中午": (11, 13),
    "下午": (12, 18), "傍晚": (17, 19), "晚上": (18, 24), "夜里": (18, 24),
    "今晚": (18, 24), "昨晚": (18, 24),
}

# 节日(公历)小表:短语 → (月, 日)。春节等农历节日**故意不收**(要农历库,宁可没有)
_HOLIDAYS = {
    "中秋": (9, 25), "国庆": (10, 1), "元旦": (1, 1),
    "圣诞": (12, 25), "儿童节": (6, 1), "情人节": (2, 14),
}

# 模糊线索:只记录,不产窗口
_VAGUE_CUES = ("那天", "那天晚上", "那次", "上次", "当时", "那时候", "有一回", "前几天")

_CN_DIGITS = {"零": 0, "一": 1, "二": 2, "两": 2, "三": 3, "四": 4,
              "五": 5, "六": 6, "七": 7, "八": 8, "九": 9, "十": 10,
              "十一": 11, "十二": 12}
_HOUR_RE = re.compile(r"(凌晨|早上|上午|下午|晚上|半夜|深夜|傍晚|中午)?\s*"
                      r"([0-9]{1,2}|[一二两三四五六七八九十]{1,3})\s*点")


# ---------------------------------------------------------------- 数据覆盖(P3-a)
#: 帧里下发的词表覆盖(`lexicon.json.timeWords`,形状见
#: `python/engine/graph_gate.py::data_from_frame`)。键名对齐上面 6 张表:
#: `day / span / spanSeconds / clock / holidays / vague`。
#: **空 / 缺 / 坏 ⇒ 各表回落内置表(= 迁移前逐位一致的行为)**,这是 P3 的等价性要求。
_OVERRIDE = {}


def configure_from_data(data):
    """用帧里的数据块覆盖 6 张线索表。**never-throw**:形状不对就当没给。

    形状:`data["lexicon"]["timeWords"] = {"day": {"今天": 0}, "span": {"最近": [7, 0]}, …}`。
    只认"字符串键 + 数字/二元数组值";脏行丢掉,全脏 ⇒ 该表回落内置。
    """
    global _OVERRIDE
    out = {}
    if isinstance(data, dict) and isinstance(data.get("data"), dict):
        data = data["data"]        # 也认"整帧"(防呆:`frame` 与 `frame["data"]` 都收)
    if isinstance(data, dict):
        lex = data.get("lexicon")
        words = lex.get("timeWords") if isinstance(lex, dict) else None
        if isinstance(words, dict):
            for key in ("day", "span", "spanSeconds", "clock", "holidays"):
                raw = words.get(key)
                if not isinstance(raw, dict):
                    continue
                clean = {}
                for k, v in raw.items():
                    ks = str(k or "").strip()
                    if not ks or isinstance(v, bool):
                        continue
                    if isinstance(v, (int, float)):
                        clean[ks] = v
                    elif isinstance(v, (list, tuple)) and len(v) == 2 and all(
                            isinstance(x, (int, float)) and not isinstance(x, bool) for x in v):
                        clean[ks] = tuple(v)
                if clean:
                    out[key] = clean
            vague = words.get("vague")
            if isinstance(vague, list):
                vs = [str(x).strip() for x in vague if str(x).strip()]
                if vs:
                    out["vague"] = tuple(vs)
    _OVERRIDE = out


def _cues(name):
    """当前生效的那张表(数据覆盖优先,空 ⇒ 内置)。"""
    if name in _OVERRIDE:
        return _OVERRIDE[name]
    return {"day": _DAY_CUES, "span": _SPAN_CUES, "spanSeconds": _SPAN_SECONDS_CUES,
            "clock": _CLOCK_CUES, "holidays": _HOLIDAYS, "vague": _VAGUE_CUES}[name]


def _local_day_bounds(now, offset_days=0):
    """[起, 止) —— 本地日的 00:00 到次日 00:00,位移 offset_days 天。"""
    lt = time.localtime(now + offset_days * 86400.0)
    start = time.mktime((lt.tm_year, lt.tm_mon, lt.tm_mday, 0, 0, 0, 0, 0, -1))
    return start, start + 86400.0


def _nearest_year_date(now, month, day):
    """节日:取离 now 最近的那一年的该公历日,返回 [起, 止)。"""
    y0 = time.localtime(now).tm_year
    best = None
    for y in (y0 - 1, y0, y0 + 1):
        try:
            start = time.mktime((y, month, day, 0, 0, 0, 0, 0, -1))
        except (ValueError, OverflowError):
            continue
        center = start + 43200.0
        if best is None or abs(center - now) < abs(best[0] + 43200.0 - now):
            best = (start, start + 86400.0)
    return best


def _clock_window(now, h_lo, h_hi):
    """时钟窗口:落在 `now` **所在地那一天**的 [h_lo, h_hi) 时。

    ⚠️ 时钟线索**必须带一个日期锚**:单独一个「凌晨一点」不指向任何一天。
    所以这里锚在 now 当天 —— 与"最近"这类时段线索叠加时会自然收窄。
    """
    day = time.localtime(now)
    start = time.mktime((day.tm_year, day.tm_mon, day.tm_mday, 0, 0, 0, 0, 0, -1))
    return start + h_lo * 3600.0, start + h_hi * 3600.0


def _parse_hour(text):
    if text.isdigit():
        h = int(text)
    else:
        h = _CN_DIGITS.get(text)
    if h is None or not (0 <= h <= 23):
        return None
    return h


def parse_time_intent(query, now):
    """查询 → 时间意图。

    返回 dict:
      * `windows`: [(起, 止, 标签)] —— **左闭右开**;为空 ⇒ 时间臂不生效;
      * `cues`   : 命中的确定线索(短语),给日志/量台看;
      * `vague`  : 命中的模糊线索(不产窗口,只记录)。
    """
    q = str(query or "")
    now = float(now)
    days, spans, clocks, holidays, cues, vague = [], [], [], [], [], []
    for p in _cues("vague"):
        if p in q:
            vague.append(p)
    for p, off in _cues("day").items():
        if p in q:
            days.append((p, off))
            cues.append(p)
    for p, (back, fwd) in _cues("span").items():
        if p in q:
            spans.append((p, back, fwd))
            cues.append(p)
    for p, secs in _cues("spanSeconds").items():
        if p in q:
            spans.append((p, secs, 0))
            cues.append(p)
    # 时钟:「下午三点」= 时段词 ∩ 该小时 ⇒ 收窄到 [15,16);
    # 光秃秃一个「三点」**不产窗口**(3 点还是 15 点,猜就是编);
    # 「几点」不匹配(`几` 不在数字表里)—— 那是疑问词,不是线索。
    clocks, used_prefixes, hour_labels = [], set(), set()
    for m in _HOUR_RE.finditer(q):
        pref, htxt = m.group(1), m.group(2)
        h = _parse_hour(htxt)
        if h is None or not pref:
            continue
        blo, bhi = _cues("clock").get(pref, (0, 24))
        lo, hi = max(blo, h), min(bhi, h + 1)
        if lo < hi:
            lab = "%s%s点" % (pref, htxt)
            clocks.append((lab, lo, hi))
            hour_labels.add(lab)
            used_prefixes.add(pref)
            if pref not in cues:
                cues.append(pref)
    for p, band in _cues("clock").items():
        if p in q and p not in used_prefixes and p not in cues:
            clocks.append((p, band[0], band[1]))
            cues.append(p)
    for p, (mo, dy) in _cues("holidays").items():
        if p in q:
            holidays.append((p, mo, dy))
            cues.append(p)

    # 组装:
    #   * `anchor`(精确)= 某一天(今天/昨天/中秋…) 与 带小时的时钟线索 ⇒ **可收窄范围**;
    #   * `span`(粗)  = 最近/这几天/上个月/今年 ⇒ 一个窗口能装 100+ 条,**只配加权**;
    #   * 精确锚 × 时钟 ⇒ 交集(「中秋那天凌晨一点」);
    #   * 交集为空 ⇒ 退回锚(宁可宽,不可丢)。
    anchors = []
    for p, off in days:
        lo, hi = _local_day_bounds(now, off)
        anchors.append((lo, hi, p))
    for p, mo, dy in holidays:
        w = _nearest_year_date(now, mo, dy)
        if w:
            anchors.append((w[0], w[1], p))
    spans_w = []
    for p, back, fwd in spans:
        if p in _cues("spanSeconds"):
            spans_w.append((now - float(back), now, p))
        else:
            hi = _local_day_bounds(now, -fwd)[1] if fwd else now
            lo = _local_day_bounds(now, -back)[0]
            spans_w.append((lo, hi, p))

    anchor_clocks = [(p, h_lo, h_hi) for p, h_lo, h_hi in clocks if p in hour_labels]
    band_clocks = [(p, h_lo, h_hi) for p, h_lo, h_hi in clocks if p not in hour_labels]
    clock_w = [(lo, hi, p) for p, h_lo, h_hi in anchor_clocks
               for lo, hi in [_clock_window(now, h_lo, h_hi)]]
    band_w = [(lo, hi, p) for p, h_lo, h_hi in band_clocks
              for lo, hi in [_clock_window(now, h_lo, h_hi)]]

    precise = []
    if anchors and clock_w:
        for dlo, dhi, dlab in anchors:
            for clo, chi, clab in clock_w:
                lo, hi = max(dlo, clo), min(dhi, chi)
                if lo < hi:
                    precise.append((lo, hi, "%s+%s" % (dlab, clab)))
        if not precise:
            precise = list(anchors)
    elif anchors:
        precise = list(anchors)
    elif clock_w:
        precise = list(clock_w)

    windows = precise + band_w + spans_w

    # 「昨晚」既在 _DAY_CUES 又在 _CLOCK_CUES —— cues 去重已保证不出现两次
    def _uniq(ws):
        seen, out = set(), []
        for lo, hi, lab in ws:
            if (lo, hi) in seen:
                continue
            seen.add((lo, hi))
            out.append((lo, hi, lab))
        return out

    return {"windows": _uniq(windows), "precise": _uniq(precise),
            "cues": cues, "vague": vague}


def in_windows(ts, windows):
    """`ts` 是否落在任一窗口内(**左闭右开**)。空窗口 ⇒ False。"""
    if not windows:
        return False
    t = float(ts or 0.0)
    if t <= 0:
        return False
    for lo, hi, _lab in windows:
        if lo <= t < hi:
            return True
    return False
