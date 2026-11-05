# -*- coding: utf-8 -*-
"""量台「修尺子」的负控 —— 第 2 步:逐行比对两次输出,**老读数必须一字不差**。

忽略项(两次跑天然不同的):单次耗时 `x.xx ms`、算力合计、活库副本临时路径。
另:`--drop-new-block` 会从「改后」输出里摘掉新报表段(它的头部行固定是
`  顺序敏感 + 白盒支撑(上一版`),否则新老输出条数不同、必然 diff。

用法:
    python scripts/bench-cmp.py <neutered.txt> <after.txt> [--drop-new-block]
返回:相同 = exit 0;有差异 = exit 1 并打印前若干行 unified diff。
"""
import difflib
import io
import re
import sys

SKIP = re.compile(r"(\d+\.\d+ ms|算力:|活库副本)")
NEW_HEAD = "  顺序敏感 + 白盒支撑(上一版"
NEW_TAIL = "负控/闲聊档"


def load(path, drop_new_block):
    with open(path, "rb") as f:
        raw = f.read()
    try:                                  # python 自己写的:UTF-8
        text = raw.decode("utf-8")
    except UnicodeDecodeError:            # PowerShell 的 `>`:UTF-16LE
        text = raw.decode("utf-16")
    out, skipping = [], False
    for ln in text.splitlines():
        if drop_new_block and ln.startswith(NEW_HEAD):
            skipping = True
            continue
        if skipping and NEW_TAIL in ln:
            skipping = False
        if skipping or SKIP.search(ln):
            continue
        out.append(ln)
    return out


def main():
    if len(sys.argv) < 3:
        raise SystemExit(__doc__)
    a = load(sys.argv[1], False)
    b = load(sys.argv[2], "--drop-new-block" in sys.argv)
    print("neutered=%d lines | after(old sections only)=%d lines" % (len(a), len(b)))
    diff = list(difflib.unified_diff(a, b, "neutered", "after", lineterm="", n=1))
    if diff:
        print("DIFF %d lines:" % len(diff))
        for d in diff[:60]:
            print(d)
        raise SystemExit(1)
    print("IDENTICAL ✓ 负控通过:摘掉新块后,老读数一字不差")


if __name__ == "__main__":
    main()
