# -*- coding: utf-8 -*-
"""取消令牌与 worker 取消路径(0.45.0)。

分三层测,因为「取消」这个功能的正确性由三件互相独立的事组成:

  1. **令牌语义**(纯函数,确定)—— begin/end/mark/checkpoint 的边界。
     错了会导致「取消不生效」或「取消误伤下一个请求」。
  2. **跨线程置位**(真线程)—— 读线程在业务线程忙的时候能不能及时置位。
     这是整个功能的存在理由:主循环跑在长循环里时不读 stdin。
  3. **在线协议**(真子进程)—— cancel 帧 → cancelled 应答 → 进程存活,
     且不污染同一条连接上的后续请求。

第 3 层刻意用「取消先到、请求后到」的顺序:这不只是模拟壳发完立刻 abort
的竞态,也是唯一能让 ping 这种没有长循环的帧也可取消的路径(靠 main() 里
那个开局检查点)。
"""

import os
import sys
import threading
import time
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from engine import cancel  # noqa: E402
from test_worker import WorkerHarness, hello_frame  # noqa: E402


class TokenSemantics(unittest.TestCase):
    """令牌的纯函数语义。"""

    def setUp(self):
        cancel.reset()

    def tearDown(self):
        cancel.reset()

    def test_mark_then_checkpoint_raises(self):
        cancel.begin(7)
        self.assertTrue(cancel.mark(7))
        with self.assertRaises(cancel.RequestCancelled):
            cancel.checkpoint()

    def test_checkpoint_is_silent_without_cancel(self):
        cancel.begin(7)
        cancel.checkpoint()   # 不该抛
        cancel.checkpoint()   # 幂等

    def test_checkpoint_is_silent_when_idle(self):
        """current is None ⇒ 直接返回。

        这条是给测试与直接调用引擎模块的场景兜底的:引擎函数被单独调用时
        没有 begin(),检查点必须是空操作而不是炸掉。
        """
        cancel.mark(7)
        cancel.checkpoint()
        cancel.end(7)

    def test_cancel_arrives_before_begin(self):
        """取消先于 begin(请求还在队列里)—— 仍然要能拦住。"""
        cancel.mark(9)
        cancel.begin(9)
        with self.assertRaises(cancel.RequestCancelled):
            cancel.checkpoint()

    def test_end_clears_the_token(self):
        cancel.begin(3)
        cancel.mark(3)
        cancel.end(3)
        cancel.begin(3)
        cancel.checkpoint()   # 上一轮的取消不该跟着这个 id 回来

    def test_cancel_does_not_leak_to_next_request(self):
        cancel.begin(1)
        cancel.mark(1)
        cancel.end(1)
        cancel.begin(2)
        cancel.checkpoint()   # 1 号的取消不该影响 2 号

    def test_begin_prunes_older_ids(self):
        """reqId 单调递增:比当前小的永远不会再被处理,该剪掉(否则集合只涨不消)。"""
        cancel.mark(1)
        cancel.mark(2)
        cancel.begin(5)
        self.assertEqual(cancel.snapshot()["cancelled"], [])

    def test_mark_rejects_bad_ids(self):
        for bad in (None, "7", 7.0, True, {}, [], object()):
            self.assertFalse(cancel.mark(bad), repr(bad))
        self.assertEqual(cancel.snapshot()["cancelled"], [])

    def test_snapshot_reports_current(self):
        cancel.begin(4)
        self.assertEqual(cancel.snapshot()["current"], 4)
        cancel.end(4)
        self.assertIsNone(cancel.snapshot()["current"])


class CrossThreadMark(unittest.TestCase):
    """带外取消的核心:业务线程忙着,读线程照样能置位。"""

    def setUp(self):
        cancel.reset()

    def tearDown(self):
        cancel.reset()

    def test_mark_from_another_thread_interrupts_a_running_loop(self):
        cancel.begin(1)
        outcome = []

        def busy():
            try:
                for _ in range(500):
                    cancel.checkpoint()
                    time.sleep(0.002)
                outcome.append("finished")
            except cancel.RequestCancelled:
                outcome.append("cancelled")

        worker = threading.Thread(target=busy)
        worker.start()
        time.sleep(0.03)          # 确保循环真的跑起来了
        cancel.mark(1)            # ← 读线程会做的动作
        worker.join(timeout=5)
        self.assertFalse(worker.is_alive(), "检查点没有把它停下来")
        self.assertEqual(outcome, ["cancelled"])


class WorkerCancelProtocol(unittest.TestCase):
    """真子进程:取消帧的在线行为。"""

    def test_cancel_before_request_yields_cancelled(self):
        w = WorkerHarness()
        try:
            self.assertEqual(w.roundtrip(hello_frame())["type"], "ready")
            # 取消先到、请求后到 —— 真读线程保证顺序(FIFO 同一根管道)
            w.send_raw('{"type":"cancel","targetReqId":7}')
            reply = w.roundtrip({"reqId": 7, "type": "ping"})
            self.assertEqual(reply["type"], "cancelled")
            self.assertEqual(reply["reqId"], 7)
        finally:
            w.close()

    def test_worker_survives_a_cancel(self):
        """取消是正常控制流,不是崩溃:进程必须继续服务。"""
        w = WorkerHarness()
        try:
            w.roundtrip(hello_frame())
            w.send_raw('{"type":"cancel","targetReqId":7}')
            self.assertEqual(w.roundtrip({"reqId": 7, "type": "ping"})["type"], "cancelled")
            pong = w.roundtrip({"reqId": 8, "type": "ping"})
            self.assertEqual(pong["type"], "pong")
            self.assertEqual(pong["reqId"], 8)
            bye = w.roundtrip({"reqId": 9, "type": "shutdown"})
            self.assertEqual(bye["type"], "bye")
            self.assertEqual(w.wait(), 0)   # 退出码 0:不是被击杀的
        finally:
            w.close()

    def test_cancel_does_not_poison_later_requests(self):
        w = WorkerHarness()
        try:
            w.roundtrip(hello_frame())
            w.send_raw('{"type":"cancel","targetReqId":7}')
            self.assertEqual(w.roundtrip({"reqId": 7, "type": "ping"})["type"], "cancelled")
            for rid in (8, 9, 10):
                self.assertEqual(w.roundtrip({"reqId": rid, "type": "ping"})["type"], "pong")
        finally:
            w.close()

    def test_cancel_for_unknown_id_is_ignored(self):
        """取消一个不存在(或早已结束)的 reqId:非致命,不影响任何请求。"""
        w = WorkerHarness()
        try:
            w.roundtrip(hello_frame())
            w.send_raw('{"type":"cancel","targetReqId":999}')
            self.assertEqual(w.roundtrip({"reqId": 4, "type": "ping"})["type"], "pong")
        finally:
            w.close()

    def test_cancel_with_bad_target_is_ignored(self):
        """targetReqId 形状不对:吞掉,不回帧、不崩、不影响后续。"""
        w = WorkerHarness()
        try:
            w.roundtrip(hello_frame())
            for bad in ('"abc"', "null", "{}", "[]", "true", "1.5"):
                w.send_raw('{"type":"cancel","targetReqId":%s}' % bad)
            self.assertEqual(w.roundtrip({"reqId": 4, "type": "ping"})["type"], "pong")
        finally:
            w.close()

    def test_cancel_frame_needs_no_hello(self):
        """cancel 是协议级控制帧,不要求先握手 —— 否则「握手卡住时取消」
        这条最重要的逃生路径就没有了。

        注意 targetReqId 刻意用一个和后面 ping 不同的号:取消是**按 reqId
        精确匹配**的,不能误伤别的请求(这条顺带把那个性质也钉住了)。
        """
        w = WorkerHarness()
        try:
            w.send_raw('{"type":"cancel","targetReqId":99}')
            # 未握手仍然照常拒业务帧,但进程必须活着
            err = w.roundtrip({"reqId": 1, "type": "ping"})
            self.assertEqual(err["type"], "error")
            self.assertFalse(err.get("fatal", False))
            self.assertEqual(w.roundtrip(hello_frame(req_id=2))["type"], "ready")
        finally:
            w.close()

    def test_cancel_targets_one_request_only(self):
        """取消按 reqId 精确匹配:取消 7 不能顺带把 8 也取消掉。"""
        w = WorkerHarness()
        try:
            w.roundtrip(hello_frame())
            w.send_raw('{"type":"cancel","targetReqId":7}')
            self.assertEqual(w.roundtrip({"reqId": 7, "type": "ping"})["type"], "cancelled")
            self.assertEqual(w.roundtrip({"reqId": 8, "type": "ping"})["type"], "pong")
        finally:
            w.close()


if __name__ == "__main__":
    unittest.main()
