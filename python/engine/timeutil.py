# -*- coding: utf-8 -*-
"""时间解析(M2-b4)—— core/echo_utils.py:130-259 逐字移植。

时间三分的边界在这两个函数之间划清:
  parse_abs_time        过去的事(occurred_at)只收**绝对**时间 ——
                        「上周」到底是哪天,换算就是编造;收不到返回 0,
                        上层保留 time_unknown,绝不拿写入时间冒充事件时间。
  resolve_follow_up_time 未来的约定(follow_up_after)可以安全换算 ——
                        「两分钟后」在登记那一刻就是 now+120,是确定的
                        数学,不是猜测。绝对时间永远优先。
"""

import re
import time

_ABS_TIME_FORMATS = (
    "%Y-%m-%dT%H:%M:%S",
    "%Y-%m-%dT%H:%M",
    "%Y-%m-%d %H:%M:%S",
    "%Y-%m-%d %H:%M",
    "%Y-%m-%d",
)


def parse_abs_time(value) -> float:
    """把 Judge 给的绝对时间解析成 unix 时间戳;不是绝对时间返回 0。"""
    text = str(value or "").strip()
    if not text:
        return 0.0
    for fmt in _ABS_TIME_FORMATS:
        try:
            return time.mktime(time.strptime(text[:19], fmt))
        except ValueError:
            continue
    return 0.0


_CN_NUM = {
    "一": 1, "二": 2, "两": 2, "三": 3, "四": 4, "五": 5,
    "六": 6, "七": 7, "八": 8, "九": 9, "十": 10, "半": 0.5,
}


def _parse_count(text):
    text = str(text or "").strip()
    if text in _CN_NUM:
        return float(_CN_NUM[text])
    try:
        return float(text)
    except (TypeError, ValueError):
        return None


def resolve_follow_up_time(value, now=None) -> float:
    """悬置话题 follow_up_after → unix 时间戳;解析不出返回 0(不定时)。

    覆盖:N秒/分钟/小时/天后(含中文数字与「半小时」)> 今晚/明晚/明天/
    后天 + 钟点(可带上午/中午/下午/傍晚/晚上/凌晨/早上时段词)> 裸钟点
    (今天已过则顺延到明天)> 周几/下周几。其余一律 0。
    """
    abs_ts = parse_abs_time(value)
    if abs_ts > 0:
        return abs_ts
    text = " ".join(str(value or "").split())
    if not text:
        return 0.0
    now = time.time() if now is None else float(now)

    # ① 相对时长:「两分钟后」「半小时后」「3天以后」
    m = re.search(
        r"(半|一|二|两|三|四|五|六|七|八|九|十|\d+(?:\.\d+)?)\s*个?\s*"
        r"(秒|分钟|分|小时|时|天|日)\s*(?:钟)?\s*(?:以)?后",
        text,
    )
    if m:
        n = _parse_count(m.group(1))
        per = {"秒": 1, "分钟": 60, "分": 60,
               "小时": 3600, "时": 3600, "天": 86400, "日": 86400}
        if n and n > 0:
            return now + n * per[m.group(2)]

    # ② 钟点(可带 今晚/明晚/今天/明天/后天 + 时段词):「明晚8点」
    # 「明天9:30」「今晚十点半」「下午3点」「晚上8点」
    m = re.search(
        r"(今晚|明晚|今天|明天|后天)?\s*(上午|中午|下午|傍晚|晚上|凌晨|早上|早晨)?\s*"
        r"(半|一|二|两|三|四|五|六|七|八|九|十|\d{1,2})\s*[点时:：]\s*(半|\d{1,2})?",
        text,
    )
    if m:
        day_word, tod_word = m.group(1), m.group(2)
        hour, minute_raw = _parse_count(m.group(3)), m.group(4)
        if hour is not None and 0 <= hour <= 23:
            if minute_raw == "半":
                minute = 30
            elif minute_raw and str(minute_raw).isdigit():
                minute = int(minute_raw) if 0 <= int(minute_raw) <= 59 else 0
            else:
                minute = 0
            if day_word and "晚" in day_word and hour < 12:
                hour += 12  # 「晚8点」= 20点
            # v8.7.2:时段词补齐 —— 「晚上8点/下午3点/傍晚6点」以前落进
            # 裸钟点分支,静默差 12 小时(提醒会在错误时刻响起)。
            if tod_word in ("下午", "傍晚", "晚上") and hour < 12:
                hour += 12
            lt = time.localtime(now)
            offset = {"今天": 0, "今晚": 0, "明天": 1, "明晚": 1, "后天": 2}.get(day_word or "")
            if offset is None:
                # 裸钟点:今天已过则顺延到明天
                ts = time.mktime(
                    (lt.tm_year, lt.tm_mon, lt.tm_mday, int(hour), minute, 0, 0, 0, -1)
                )
                return ts if ts > now else ts + 86400
            return time.mktime(
                (lt.tm_year, lt.tm_mon, lt.tm_mday + offset, int(hour), minute, 0, 0, 0, -1)
            )

    # ③ 周几:「周三」「下周五」(换算到下一个该星期几)
    m = re.search(r"(下)?\s*(?:周|星期|礼拜)\s*(一|二|两|三|四|五|六|日|天|[1-7])", text)
    if m:
        cn_dow = {"一": 0, "二": 1, "两": 1, "三": 2,
                  "四": 3, "五": 4, "六": 5, "日": 6, "天": 6}
        raw = m.group(2)
        target = cn_dow.get(raw)
        if target is None and raw.isdigit():
            target = int(raw) - 1
        if target is not None and 0 <= target <= 6:
            lt = time.localtime(now)
            days_ahead = (target - lt.tm_wday) % 7 or 7
            if m.group(1):
                days_ahead += 7
            return now + days_ahead * 86400

    return 0.0
