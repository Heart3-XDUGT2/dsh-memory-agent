# -*- coding: utf-8 -*-
"""量台「修尺子」的负控 —— 第 1 步:生成一份**摘掉新块**的等价副本。

为什么需要它:往量台里加读数(accumulator / 报表)时,最大的风险不是新读数算错,
而是**顺手把老读数改了**。所以每次动尺子,都要能机械地回到「改前」再跑一遍,
逐行比对。

用法:
    python scripts/bench-neuter.py [输出路径]
    # 默认输出 .scratch/bench-neutered.py,然后:
    python scripts/retrieval-bench.py            > .scratch/bench-after.txt
    python .scratch/bench-neutered.py            > .scratch/bench-neutered.txt
    python scripts/bench-cmp.py .scratch/bench-neutered.txt .scratch/bench-after.txt

⚠️ MARKERS 是**针对某一次加尺**的。换一次加尺,请把这次的块边界填进来
(成对出现:块首标记 / 块尾标记;`keep_tail=True` 表示尾部标记本身要保留)。
"""
import io
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
SRC = os.path.join(HERE, "retrieval-bench.py")
DEFAULT_OUT = os.path.join(ROOT, ".scratch", "bench-neutered.py")

# 2026-09-30「修尺子」那次加的三块 + 文件头文档行
MARKERS = [
    ("    # ---- 修尺子(2026-09-30)", '"tier_fail": {}} for m in methods}', False),
    ("                # ---- 顺序敏感 + 白盒支撑(修尺子", "                    tf[0] += 1", False),
    ("    # ---------------- 顺序敏感 + 白盒支撑 + 失败分解(修尺子,2026-09-30) ----------------",
     "    # ---------------- 负控/闲聊档 ----", True),
]
DOC_BLOCK = ("  * MRR@10 / NDCG@5 / 首答位次中位 / SEH@3 / 装下k中位\n"
             "                   (2026-09-30 修的尺子:**顺序敏感 + 白盒支撑** —— 上一版只有\n"
             "                    「集合覆盖」,对同一集合内换序无感,会漏掉「只重排、不动召回」\n"
             "                    的正收益改动;SEH@3 取自 MemConflict 的白盒口径)\n"
             "  * 失败分解        召回失败 / 排序失败 / 成功(把原来的「零命中率」拆成两类:\n"
             "                    完全进不了池子 vs 进了池子但排不进 top5)\n")
SENTINELS = ("ord_stats", "顺序敏感")   # 摘干净的证据


def main():
    out = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_OUT
    s = io.open(SRC, encoding="utf-8").read()
    n0 = len(s)
    for start, end, keep_tail in MARKERS:
        i = s.find(start)
        if i < 0:
            raise SystemExit("start not found: %r" % start[:50])
        j = s.find(end, i)
        if j < 0:
            raise SystemExit("end not found: %r" % end[:50])
        s = s[:i] + s[j:] if keep_tail else s[:i] + s[j + len(end):]
    if DOC_BLOCK not in s:
        raise SystemExit("doc block not found")
    s = s.replace(DOC_BLOCK, "")
    for sent in SENTINELS:
        if sent in s:
            raise SystemExit("leftover sentinel: %s" % sent)
    d = os.path.dirname(out)
    if d and not os.path.isdir(d):
        os.makedirs(d)
    io.open(out, "w", encoding="utf-8").write(s)
    print("neutered: %d -> %d bytes (%+d) -> %s" % (n0, len(s), len(s) - n0, out))


if __name__ == "__main__":
    main()
