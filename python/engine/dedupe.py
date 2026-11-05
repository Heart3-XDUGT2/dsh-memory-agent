"""记忆近重复判定(M3)· 权威实现
============================================================
写入闸在引擎侧(她落库那一刻就要判),所以**这里是权威**;
`lib/memory-dedupe.js` 是逐字镜像,只服务离线脚本(不启动 worker 也能体检/清理)。
两份必须同参同式,`python/tests/test_dedupe.py` 与 `tests/dedupe.test.js`
用**同一组夹具**钉住。

为什么需要它(2026-09-25 活库实测):去重键 = ``slot or field``
(`judge.py:memory_key_of`),而 L2 没有 field、slot 由模型自由命名
(同一件事写成 food_preference 与 preferred_food),导入行与反思行
**键全空** ⇒ 活库 7 条 L0 在说同一件事。

判据(保守):同层 + (关键词 Jaccard ≥ 0.6 或 摘要双字重合 ≥ 0.7)。
阈值为 0 即关闭该判据(两个都 0 = 回到「同键同句才算想起」)。
"""

import json
import re

DEDUPE_DEFAULTS = {
    "kwThreshold": 0.6,
    "summaryThreshold": 0.7,
    # 关键词一致时还要求的**摘要下限**:单靠关键词一致不够 ——
    # 实测夹具 11 条「用户说他的第 N 只猫很可爱」关键词完全相同。
    "summaryFloor": 0.35,
}

_PUNCT = re.compile(
    "[·・.,,、。:：;；!！?？'\"“”‘’()（）\\[\\]【】{}｛｝<>《》\\-_/\\\\|+*&#@~^$%]"
)


def norm_text(text) -> str:
    """判重专用归一:去空白标点 + 小写。(去掉全角/半角差异靠 strip 后比较)"""
    s = str(text or "")
    s = s.replace("\u3000", " ")
    s = re.sub(r"\s+", "", s)
    s = _PUNCT.sub("", s)
    return s.lower()


def keyword_list(raw):
    """关键词:接受 JSON 字符串或列表,归一后去重去空(顺序保留)。"""
    arr = raw
    if isinstance(raw, str):
        try:
            parsed = json.loads(raw)
            arr = parsed if isinstance(parsed, list) else [raw]
        except (ValueError, TypeError):
            arr = re.split(r"[,，、\s]+", raw)
    if not isinstance(arr, (list, tuple)):
        arr = []
    out = []
    seen = set()
    for item in arr:
        k = str(item or "").strip().lower()
        if not k or k in seen:
            continue
        seen.add(k)
        out.append(k)
    return out


def jaccard(a, b) -> float:
    A = set(a or ())
    B = set(b or ())
    if not A or not B:
        return 0.0
    inter = len(A & B)
    return inter / (len(A) + len(B) - inter)


def bigrams(text):
    """双字滑窗字符集:中文摘要「换说法讲同一件事」的判据。"""
    s = norm_text(text)
    if len(s) < 2:
        return {s} if s else set()
    return {s[i:i + 2] for i in range(len(s) - 1)}


def summary_overlap(a, b) -> float:
    return jaccard(bigrams(a), bigrams(b))


def normalize_layer(layer) -> str:
    """读侧层归一:**空层当作 L2**。

    为什么(2026-10-10):judge 的降级路径此前没给 `insert_memory` 传 layer
    ⇒ 吃默认 `layer=""` ⇒ 活库积了 47 行空层(source='private')。写入侧已修
    (`judge.py` 降级路径补传 `layer="L2"`),**不再增长**;但历史数据**不动**
    —— 于是读侧把 '' 与 'L2' 视为同层,让那 47 行重新能被去重/换代命中。

    为什么等价:`''` 与 `'L2'` 在三处判据里行为完全一致 ——
      · `dmae.py:129-134` 同落 else 分支(tier=0.15)
      · `lib/retrieve.js:103` 只豁免 `'L0'`
      · `store.js:845` 等只查 `= 'L0'`
    ⇒ 归一**不改变任何已有判定结果**,只是把本来就等价的值对齐。

    ⚠️ 只把空/None 归到 `'L2'`;`'L0'` / `'L1'` 原样保留 ——
    空层**不是**「任意层」,不能拿它去撞 L0。
    """
    s = str(layer or "").strip().upper()
    return s if s else "L2"


# SQL 侧的同一归一(列在库里,没法走 Python 函数)—— 供 episodic 的去重/换代
# 查询使用,口径与 `normalize_layer` 逐字对齐(空 ⇒ 'L2',大小写不敏感)。
LAYER_SQL = ("(CASE WHEN UPPER(COALESCE(layer, '')) = '' THEN 'L2'"
             " ELSE UPPER(COALESCE(layer, '')) END)")


def _layer_of(row) -> str:
    return normalize_layer((row or {}).get("layer"))


def _digit_sig(text) -> str:
    """把数字统一成 # 后的签名 —— 用来识别「只在数字上不同」的句子。"""
    return re.sub(r"\d+", "#", norm_text(text))


def is_near_duplicate(a, b, kw_threshold=None, summary_threshold=None,
                      summary_floor=None) -> bool:
    """近重复判定。**同层**是硬前提 —— L0(身份画像)与 L2(片段)永不同判。

    status 也必须相同(隔离候选不与正式行互判:隔离就是隔离)。

    判据(故意保守,宁可漏合不可错合):
      ① 只在数字上不同 → **不是**重复(「第1只猫」与「第2只猫」是两件事)
      ② 摘要双字重合 ≥ summaryThreshold(默认 0.7)→ 是(换说法讲同一件事)
      ③ 关键词 Jaccard ≥ kwThreshold **且** 摘要重合 ≥ summaryFloor
         (默认 0.35)→ 是;单靠关键词一致不够 —— 实测夹具里 11 条
         「他的第 N 只猫」关键词完全相同,不设摘要下限会把它们合成一条。
    阈值为 0 = 关闭该判据;两个阈值都为 0 = 完全关闭。
    """
    kw_t = DEDUPE_DEFAULTS["kwThreshold"] if kw_threshold is None else float(kw_threshold)
    sum_t = (DEDUPE_DEFAULTS["summaryThreshold"]
             if summary_threshold is None else float(summary_threshold))
    floor = (DEDUPE_DEFAULTS["summaryFloor"]
             if summary_floor is None else float(summary_floor))
    if kw_t <= 0 and sum_t <= 0:
        return False
    if _layer_of(a) != _layer_of(b):
        return False
    if str(a.get("status") or "active") != str(b.get("status") or "active"):
        return False
    sa, sb = a.get("summary"), b.get("summary")
    na, nb = norm_text(sa), norm_text(sb)
    if na and nb and na != nb and _digit_sig(sa) == _digit_sig(sb):
        return False
    overlap = summary_overlap(sa, sb)
    if sum_t > 0 and overlap >= sum_t:
        return True
    kw_hit = kw_t > 0 and jaccard(
        keyword_list(a.get("keywords")), keyword_list(b.get("keywords"))) >= kw_t
    return bool(kw_hit and overlap >= floor)
