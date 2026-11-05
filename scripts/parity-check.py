# -*- coding: utf-8 -*-
"""跨语言等价核对(Python ↔ JS 检索打分)—— `python scripts/parity-check.py`

为什么要它:仓库里有两套检索实现(Python 是活路径,JS 是离线兜底),两边
各有一份"差分锚点"测试。但**两份测试各写各的期望值**时,一方改公式另一方
忘了跟,测试仍然会绿 —— 锚点就成了摆设。这个脚本是**真的把同一组输入喂给
两套实现**,逐字段比数字。

怎么比:同一份夹具(下面的 FIXTURE,12 行 × 8 条查询,覆盖
摘要独有词 / 单字查询 / 逗号串关键词 / L0 强制占位 / 近重复 / 半衰期缺失 /
零命中负控),分别走
  * Python:`engine.retrieve.rank_memories`(进程内)
  * JS:`node scripts/parity-runner.mjs`(子进程,生产 lib/retrieve.js)
比 `id 序列`(排序+成员)、`hits`、`r_now`、`total`、`matched`、`forced`。

已知会踩的坑(所以才有这个脚本):
  * 内置 `round()` 是"四舍六入五取偶",JS `Math.round` 是"五入" ——
    0.15625 这种平局会差 1e-4。两侧已统一成 `floor(x*10000+0.5)/10000`。
  * JS 侧字段是 camelCase,Python 侧是 snake_case。

退出码 0 = 逐字段完全一致;1 = 有分歧(打印每一处)。
"""
import json
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / 'python'))
from engine import retrieve  # noqa: E402

# 夹具用 snake_case(中性),两侧各自映射到自己那套命名。
FIXTURE = {
    "now": 1700000000,
    "topK": 6,
    "queries": ["章鱼小丸子", "猫", "新生", "校园跑", "zzz-量子纠缠-zzz",
                "还记得面试的事吗", "两只猫", "他上的什么学校"],
    "rows": [
        {"memory_id": 101, "keywords": ["章鱼小丸子"],
         "summary": "他说以后会学着做章鱼小丸子,并和Echo拉钩约定。",
         "emotion_score": 9, "timestamp": 1699900000, "intrinsic_value": 50,
         "half_life": 24, "recall_count": 3, "last_recalled": 1699950000,
         "layer": "", "temporal_status": "time_unknown",
         "occurred_at": 0, "learned_at": 1699900000},
        {"memory_id": 102, "keywords": [],
         "summary": "用户说章鱼小丸子很稀有、几乎几年才吃一次。",
         "emotion_score": 9, "timestamp": 1699800000, "intrinsic_value": 50,
         "half_life": 24, "recall_count": 0, "last_recalled": 0, "layer": "",
         "temporal_status": "time_unknown", "occurred_at": 0,
         "learned_at": 1699800000},
        {"memory_id": 103, "keywords": [],
         "summary": "他提到章鱼小丸子很难买到,几乎几年才能吃一次。",
         "emotion_score": 8, "timestamp": 1699700000, "intrinsic_value": 50,
         "half_life": 24, "recall_count": 0, "last_recalled": 0, "layer": "",
         "temporal_status": "time_unknown", "occurred_at": 0,
         "learned_at": 1699700000},
        {"memory_id": 104, "keywords": ["猫"], "summary": "他喜欢猫",
         "emotion_score": 7, "timestamp": 1699600000, "intrinsic_value": 40,
         "half_life": 12, "recall_count": 0, "last_recalled": 0, "layer": "",
         "temporal_status": "time_unknown", "occurred_at": 0,
         "learned_at": 1699600000},
        {"memory_id": 105, "keywords": ["大学"],
         "summary": "用户就读于一所新工科大学,是西电大一新生。",
         "emotion_score": 6, "timestamp": 1699500000, "intrinsic_value": 60,
         "half_life": 48, "recall_count": 1, "last_recalled": 1699550000,
         "layer": "L1", "temporal_status": "time_unknown", "occurred_at": 0,
         "learned_at": 1699500000},
        {"memory_id": 106, "keywords": ["称呼"], "summary": "他喜欢被叫<称呼>。",
         "emotion_score": 5, "timestamp": 1699400000, "intrinsic_value": 95,
         "half_life": 100, "recall_count": 0, "last_recalled": 0, "layer": "L0",
         "temporal_status": "time_unknown", "occurred_at": 0,
         "learned_at": 1699400000},
        {"memory_id": 107, "keywords": ["身份"],
         "summary": "他是一名软件工程专业的大学生。",
         "emotion_score": 5, "timestamp": 1699300000, "intrinsic_value": 90,
         "half_life": 100, "recall_count": 0, "last_recalled": 0, "layer": "L0",
         "temporal_status": "time_unknown", "occurred_at": 0,
         "learned_at": 1699300000},
        {"memory_id": 108, "keywords": ["身份"],
         "summary": "他在西安电子科技大学读大一。",
         "emotion_score": 5, "timestamp": 1699200000, "intrinsic_value": 40,
         "half_life": 100, "recall_count": 0, "last_recalled": 0, "layer": "L0",
         "temporal_status": "time_unknown", "occurred_at": 0,
         "learned_at": 1699200000},
        {"memory_id": 109, "keywords": ["校园跑", "3km"],
         "summary": "校园跑要求每次3km且有速度限制,不能太慢。",
         "emotion_score": 9, "timestamp": 1699100000, "intrinsic_value": 45,
         "half_life": 24, "recall_count": 2, "last_recalled": 1699150000,
         "layer": "", "temporal_status": "time_unknown", "occurred_at": 0,
         "learned_at": 1699100000},
        {"memory_id": 110, "keywords": "面试,网站建设,失败",
         "summary": "他参加学校网站建设部门面试未通过。",
         "emotion_score": 4, "timestamp": 1699000000, "intrinsic_value": 55,
         "half_life": 24, "recall_count": 0, "last_recalled": 0, "layer": "",
         "temporal_status": "time_unknown", "occurred_at": 0,
         "learned_at": 1699000000},
        {"memory_id": 111, "keywords": [], "summary": "他说他喜欢猫,养了两只。",
         "emotion_score": 6, "timestamp": 1698900000, "intrinsic_value": 35,
         "half_life": 0, "recall_count": 0, "last_recalled": 0, "layer": "",
         "temporal_status": "time_unknown", "occurred_at": 0,
         "learned_at": 1698900000},
        {"memory_id": 112, "keywords": [],
         "summary": "用户喜欢用中文交流,不介意用表情。",
         "emotion_score": 3, "timestamp": 1698800000, "intrinsic_value": 30,
         "half_life": 24, "recall_count": 0, "last_recalled": 0, "layer": "",
         "temporal_status": "time_unknown", "occurred_at": 0,
         "learned_at": 1698800000},
    ],
}


def py_side(fx):
    rows = [{**r} for r in fx["rows"]]
    for r in rows:
        r["keywords"] = retrieve.parse_keywords(r["keywords"])
    out = {}
    for q in fx["queries"]:
        top = retrieve.rank_memories(rows, q, fx["topK"], float(fx["now"]))
        out[q] = [{"id": it["memory_id"], "hits": it["hits"],
                   "matched": bool(it["matched"]), "r_now": it["r_now"],
                   "total": it["total"], "forced": bool(it["forced"])}
                  for it in top]
    return out


def js_side(fx_path):
    proc = subprocess.run(
        ["node", str(ROOT / "scripts" / "parity-runner.mjs"), str(fx_path)],
        capture_output=True, cwd=str(ROOT))
    if proc.returncode != 0:
        raise SystemExit("  JS 侧执行失败:\n"
                         + proc.stderr.decode("utf-8", "replace")[:2000])
    return json.loads(proc.stdout.decode("utf-8"))


def main():
    with tempfile.TemporaryDirectory() as td:
        p = Path(td) / "fixture.json"
        p.write_text(json.dumps(FIXTURE, ensure_ascii=False), encoding="utf-8")
        py = py_side(FIXTURE)
        js = js_side(p)

    bad = 0
    for q in FIXTURE["queries"]:
        a, b = py[q], js.get(q, [])
        if [x["id"] for x in a] != [x["id"] for x in b]:
            print("  [序/成员不一致] %r" % q)
            print("     py %s" % [x["id"] for x in a])
            print("     js %s" % [x["id"] for x in b])
            bad += 1
            continue
        for x, y in zip(a, b):
            for f in ("hits", "r_now", "total"):
                if abs(float(x[f]) - float(y[f])) > 1e-12:
                    print("  [数值不一致] q=%r id=%s %s: py=%r js=%r"
                          % (q, x["id"], f, x[f], y[f]))
                    bad += 1
            for f in ("matched", "forced"):
                if bool(x[f]) != bool(y[f]):
                    print("  [布尔不一致] q=%r id=%s %s: py=%r js=%r"
                          % (q, x["id"], f, x[f], y[f]))
                    bad += 1
    n = len(FIXTURE["queries"])
    print("  夹具 %d 行 × %d 条查询 = %d 次检索;逐字段分歧 %d 处"
          % (len(FIXTURE["rows"]), n, len(FIXTURE["rows"]) * n, bad))
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
