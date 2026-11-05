# -*- coding: utf-8 -*-
"""取消剧本夹具:握手正常;业务帧**挂着等本 reqId 的 cancel**。

模仿真 worker 的行为链,只是把「长循环里的检查点」换成了「等 cancel 帧」:

    business frame → 挂起 → (收到本 reqId 的 cancel) → 回 cancelled → 继续下一帧

这一点很重要 —— 它在被取消后**会腾出来处理队列里的下一帧**,所以测试能
验证「取消之后连接仍然可用」。如果夹具永远挂着,那条性质就测不出来
(真 worker 同样会在检查点命中后继续跑下一帧)。

另外两件事:
  - 有一个和真 worker 同款的**读线程**,所以能在业务帧挂着的时候收到
    带外 cancel 帧,并把 targetReqId 追加到 `$CANCEL_MARKER` 指向的文件里
    —— 测试据此断言「cancel 帧真的发出去了」,而不是只断言「壳本地拒绝了」
    (那两件事可以互相独立地坏掉);
  - 不回 cancel 之外的任何东西。所以**不带 signal** 的请求会一直挂到壳的
    超时 —— 同一份夹具正好用来对照「取消」与「超时」是两条不同的路径。
"""
import json
import os
import queue
import sys
import threading
import time

try:
    sys.stdin.reconfigure(encoding="utf-8")
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

MARKER = os.environ.get("CANCEL_MARKER", "")
WAIT_SECONDS = 30.0

_send_lock = threading.Lock()
_state_lock = threading.Lock()
_pending_cancels = set()
_inbox = queue.Queue()
_EOF = object()


def send(frame):
    with _send_lock:
        sys.stdout.write(json.dumps(frame, ensure_ascii=False) + "\n")
        sys.stdout.flush()


def note_cancel(target):
    """把收到的 cancel 记到 marker 文件(测试据此确认帧真的到达了)。"""
    if MARKER == "":
        return
    try:
        with open(MARKER, "a", encoding="utf-8") as fh:
            fh.write(str(target) + "\n")
    except Exception:
        pass


def reader():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            frame = json.loads(line)
        except ValueError:
            continue
        if frame.get("type") == "cancel":
            note_cancel(frame.get("targetReqId"))
            with _state_lock:
                _pending_cancels.add(frame.get("targetReqId"))
            continue
        _inbox.put(frame)
    _inbox.put(_EOF)


threading.Thread(target=reader, daemon=True, name="fixture-stdin").start()

while True:
    item = _inbox.get()
    if item is _EOF:
        break
    req_id = item.get("reqId")
    if item.get("type") == "hello":
        send({
            "reqId": req_id, "type": "ready",
            "engine": "python", "version": "0-cancel-test",
            "protocol": "echo_wire_v1",
            "db": {"ok": True, "path": "", "tables": 0},
        })
        continue
    if item.get("type") == "shutdown":
        # 正常收尾:不然壳的 stop() 要等满 STOP_GRACE_MS 才强杀,
        # 每个用例白等 2 秒。
        send({"reqId": req_id, "type": "bye", "uptimeMs": 0})
        break
    if item.get("type") == "ping":
        # ping 立刻答:它是测试用的「连接还活着吗」探针,不该被挂起。
        # (真 worker 同理 —— 长请求挂着时 ping 排在它后面,请求一结束就答。)
        send({"reqId": req_id, "type": "pong"})
        continue
    # 其余业务帧:挂着等本 reqId 的 cancel(模拟长循环里的检查点窗口)。
    # 没有 cancel 就一直挂 —— 壳的超时路径会接手。
    deadline = time.time() + WAIT_SECONDS
    while time.time() < deadline:
        with _state_lock:
            hit = req_id in _pending_cancels
            if hit:
                _pending_cancels.discard(req_id)
        if hit:
            send({"reqId": req_id, "type": "cancelled"})
            break
        time.sleep(0.01)
