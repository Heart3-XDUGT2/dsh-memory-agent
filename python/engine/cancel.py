# -*- coding: utf-8 -*-
"""取消令牌:worker(写入方)与各引擎模块(读取方)之间的单向闸。
============================================================
为什么单独一个模块 —— 和 JS 侧 `lib/interrupted.js` 是同一个理由:
worker.py 顶层 import 了所有引擎模块;引擎模块若反过来 import worker
就成环。这里只放「当前请求是谁」和「它被取消没有」,谁都能用,
谁也不依赖谁。

为什么需要带外取消:
worker 的主循环原本是 `for line in sys.stdin` —— 跑在 rank_memories /
BFS 里的时候**根本没在读 stdin**。壳发来的 cancel 帧要等当前请求
整个跑完才会被看见,那等于没有取消。所以 worker 拆出一个读线程专门
收 cancel 并调用本模块的 `mark()`(读线程不碰 stdout,`send()` 保持
单线程),业务线程在长循环里调 `checkpoint()` 协作式退出。

取消是**正常控制流,不是故障**:
- 不回 error 帧,回 `{"type": "cancelled"}`;
- 不走 client 侧的 `_kill`,也不计失败 —— 那是超时的语义
  (「挂着的引擎不可信」),取消不是。

检查点该放在哪:
选在**一轮迭代之后**而不是中间。取消的语义是「尽快停」而不是
「立刻停」—— 半途抛异常会让库/内存状态停在写了一半的地方。
"""

import threading

__all__ = ["RequestCancelled", "begin", "end", "mark", "checkpoint", "reset", "snapshot"]


class RequestCancelled(Exception):
    """当前请求被壳取消。

    worker.main 捕获它 → 回一帧 `{"reqId": ..., "type": "cancelled"}`
    → 继续处理下一帧。**绝不致命**。
    """


_lock = threading.Lock()
_current = None      # 业务线程当前正在处理的 reqId(None = 空闲)
_cancelled = set()   # 被取消的 reqId(可能先于 begin 到达)


def begin(req_id):
    """标记业务线程开始处理某个请求。

    顺手剪掉比它小的 id:reqId 单调递增,比当前小的永远不会再被处理,
    留着只会让集合慢慢涨(壳崩溃/重连时可能积压一批孤儿 cancel)。
    """
    global _current
    with _lock:
        _current = req_id
        if isinstance(req_id, int):
            for stale in [k for k in _cancelled if isinstance(k, int) and k < req_id]:
                _cancelled.discard(stale)


def end(req_id):
    """请求处理完毕(正常/异常/被取消都要调),清掉令牌。"""
    global _current
    with _lock:
        if _current == req_id:
            _current = None
        _cancelled.discard(req_id)


def mark(req_id):
    """读线程收到 cancel 帧时调用 —— **带外**,不等当前请求跑完。

    允许为一个尚未 begin 的 reqId 置位:它可能还堵在队列里等着被处理。
    这样的 id 会在 `begin()` 剪枝或 `end()` 时被清掉。
    返回 True 表示置位成功(reqId 形状合法)。
    """
    if not isinstance(req_id, int) or isinstance(req_id, bool):
        return False
    with _lock:
        _cancelled.add(req_id)
    return True


def checkpoint():
    """长循环里的协作式检查点。

    发现当前请求被取消就抛 `RequestCancelled`。空闲时(current is None)
    直接返回,所以引擎模块在测试里被直接调用也不会炸。

    调用开销刻意压到最小:一次全局读 + 一次带锁的集合查询。
    放在每轮迭代的**开头**,不要在循环体中间。
    """
    cur = _current
    if cur is None:
        return
    with _lock:
        hit = cur in _cancelled
    if hit:
        raise RequestCancelled()


def reset():
    """清空全部状态(测试用)。"""
    global _current
    with _lock:
        _current = None
        _cancelled.clear()


def snapshot():
    """诊断快照(测试与日志用)。"""
    with _lock:
        return {"current": _current, "cancelled": sorted(k for k in _cancelled if isinstance(k, int))}
