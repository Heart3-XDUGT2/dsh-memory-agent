# -*- coding: utf-8 -*-
"""worker.py 协议骨架冒烟(M2-a 验收:假帧往返)。

全部经真实子进程 + 管道驱动,不 import worker 模块 —— 测的就是
「spawn 起来能不能说人话」,这正是 M2-c sidecar-client 将要干的事。
"""
import json
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

WORKER = Path(__file__).resolve().parent.parent / "worker.py"
REPO_PKG = json.loads(
    (Path(__file__).resolve().parents[2] / "package.json").read_text(encoding="utf-8")
)


class WorkerHarness:
    """spawn worker.py,喂帧、收帧。"""

    def __init__(self):
        self.proc = subprocess.Popen(
            [sys.executable, str(WORKER)],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
        )

    def send_raw(self, line):
        self.proc.stdin.write(line + "\n")
        self.proc.stdin.flush()

    def send(self, frame):
        self.send_raw(json.dumps(frame, ensure_ascii=False))

    def recv(self):
        line = self.proc.stdout.readline()
        if not line:
            return None
        return json.loads(line)

    def roundtrip(self, frame):
        self.send(frame)
        return self.recv()

    def wait(self, timeout=5):
        return self.proc.wait(timeout=timeout)

    def close(self):
        """测试兜底清理:关 stdin、等退出、超时击杀、关管道防警告。"""
        if self.proc.poll() is None:
            try:
                self.proc.stdin.close()
            except Exception:
                pass
            try:
                self.proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.proc.kill()
                self.proc.wait(timeout=5)
        for stream in (self.proc.stdout, self.proc.stderr):
            try:
                stream.close()
            except Exception:
                pass


def hello_frame(req_id=1, db_path=":memory:"):
    return {"reqId": req_id, "type": "hello",
            "protocol": "echo_wire_v1", "dbPath": db_path}


class HandshakeLifecycle(unittest.TestCase):
    """hello→ready / ping→pong / shutdown→bye / EOF 的生命周期。"""

    def test_handshake_ping_shutdown(self):
        w = WorkerHarness()
        try:
            ready = w.roundtrip(hello_frame())
            self.assertEqual(ready["type"], "ready")
            self.assertEqual(ready["protocol"], "echo_wire_v1")
            self.assertEqual(ready["engine"], "python")
            self.assertEqual(ready["version"], REPO_PKG["version"])
            self.assertTrue(ready["db"]["ok"])
            pong = w.roundtrip({"reqId": 2, "type": "ping"})
            self.assertEqual(pong["type"], "pong")
            self.assertEqual(pong["reqId"], 2)
            bye = w.roundtrip({"reqId": 3, "type": "shutdown"})
            self.assertEqual(bye["type"], "bye")
            self.assertEqual(bye["reqId"], 3)
            self.assertGreaterEqual(bye["uptimeMs"], 0)
            self.assertEqual(w.wait(), 0)
        finally:
            w.close()

    def test_protocol_mismatch_fast_fail(self):
        """协议不认识 → 致命错误帧 + 非零退出(快速失败,不空转)。"""
        w = WorkerHarness()
        try:
            err = w.roundtrip({"reqId": 1, "type": "hello",
                               "protocol": "someone_elses_v9", "dbPath": ":memory:"})
            self.assertEqual(err["type"], "error")
            self.assertTrue(err["fatal"])
            self.assertNotEqual(w.wait(), 0)
        finally:
            w.close()

    def test_hello_required_before_business_frames(self):
        """未握手就问业务 → 非致命错误,worker 存活,补 hello 后恢复。"""
        w = WorkerHarness()
        try:
            err = w.roundtrip({"reqId": 1, "type": "retrieve", "query": "x"})
            self.assertEqual(err["type"], "error")
            self.assertFalse(err.get("fatal", False))
            ready = w.roundtrip(hello_frame(req_id=2))
            self.assertEqual(ready["type"], "ready")
            pong = w.roundtrip({"reqId": 3, "type": "ping"})
            self.assertEqual(pong["type"], "pong")
        finally:
            w.close()

    def test_rehello_idempotent(self):
        """重复 hello 不炸:壳侧断线重连场景允许重新握手。"""
        w = WorkerHarness()
        try:
            first = w.roundtrip(hello_frame(req_id=1))
            second = w.roundtrip(hello_frame(req_id=2))
            self.assertEqual(first["type"], "ready")
            self.assertEqual(second["type"], "ready")
            self.assertEqual(second["reqId"], 2)
        finally:
            w.close()

    def test_eof_quiet_exit(self):
        """stdin 关闭(壳崩了)→ 安静退出,退出码 0。"""
        w = WorkerHarness()
        w.roundtrip(hello_frame())
        w.proc.stdin.close()
        self.assertEqual(w.wait(), 0)


class FrameRobustness(unittest.TestCase):
    """脏输入与预算纪律。"""

    def test_bad_json_survives(self):
        """坏 JSON 行:丢帧报错,worker 存活。"""
        w = WorkerHarness()
        try:
            w.roundtrip(hello_frame())
            w.send_raw("{not json at all")
            err = w.recv()
            self.assertEqual(err["type"], "error")
            pong = w.roundtrip({"reqId": 9, "type": "ping"})
            self.assertEqual(pong["type"], "pong")
        finally:
            w.close()

    def test_non_object_frame_rejected(self):
        w = WorkerHarness()
        try:
            w.roundtrip(hello_frame())
            w.send_raw("[1, 2, 3]")
            err = w.recv()
            self.assertEqual(err["type"], "error")
        finally:
            w.close()

    def test_unknown_frame_nonfatal(self):
        """已知协议内的未知帧:报错不断线(前向兼容)。"""
        w = WorkerHarness()
        try:
            w.roundtrip(hello_frame())
            err = w.roundtrip({"reqId": 5, "type": "teleport"})
            self.assertEqual(err["type"], "error")
            self.assertFalse(err.get("fatal", False))
            pong = w.roundtrip({"reqId": 6, "type": "ping"})
            self.assertEqual(pong["type"], "pong")
        finally:
            w.close()

    def test_stderr_budget_64_lines(self):
        """stderr 预算:灌 100 条坏行,诊断不超过 64 行。"""
        w = WorkerHarness()
        try:
            w.roundtrip(hello_frame())
            for _ in range(100):
                w.send_raw("{bad")
            # 100 条错误帧排在 bye 前面:先排干队列,再收 shutdown 应答
            for _ in range(100):
                err = w.recv()
                self.assertEqual(err["type"], "error")
            bye = w.roundtrip({"reqId": 99, "type": "shutdown"})
            self.assertEqual(bye["type"], "bye")
            w.wait()
            stderr_lines = [ln for ln in w.proc.stderr.read().splitlines() if ln.strip()]
            self.assertGreaterEqual(len(stderr_lines), 1)
            self.assertLessEqual(len(stderr_lines), 64)
        finally:
            w.close()

    def test_oversized_frame_fatal(self):
        """超 1MiB 的帧:致命错误(防病态输入撑爆内存)。"""
        w = WorkerHarness()
        try:
            w.roundtrip(hello_frame())
            w.send_raw('{"reqId":1,"type":"ping","pad":"' + "x" * (1024 * 1024 + 64) + '"}')
            err = w.recv()
            self.assertEqual(err["type"], "error")
            self.assertTrue(err["fatal"])
            self.assertNotEqual(w.wait(), 0)
        finally:
            w.close()


class EngineStubs(unittest.TestCase):
    """M2 的引擎帧:retrieve 已在 b3 转真;其余 stub 标记待 b4+。"""

    def test_retrieve_real_empty(self):
        w = WorkerHarness()
        try:
            w.roundtrip(hello_frame())
            r = w.roundtrip({"reqId": 7, "type": "retrieve", "userId": "master",
                             "query": "还记得面试的事吗", "topK": 6})
            self.assertEqual(r["type"], "retrieve_result")
            self.assertEqual(r["items"], [])
            self.assertEqual(r["text"], "")
            self.assertEqual(r["reinforced"], 0)
            self.assertIsNone(r["state"])
            self.assertIsNone(r["profile"])
            self.assertNotIn("stub", r)          # 真引擎不再带桩标记
            self.assertEqual(r["reqId"], 7)
        finally:
            w.close()

    def test_extract_prompt_and_commit_real(self):
        w = WorkerHarness()
        try:
            w.roundtrip(hello_frame())
            p = w.roundtrip({"reqId": 1, "type": "extract_prompt"})
            self.assertEqual(p["type"], "extract_prompt_result")
            self.assertNotIn("stub", p)
            self.assertIn("candidates", p["prompt"])     # 合并版:记忆载荷在场
            self.assertIn("emotion_vector", p["prompt"]) # 情绪载荷也在场
            self.assertEqual(p["schema"]["type"], "object")
            a = w.roundtrip({"reqId": 2, "type": "extract_commit",
                             "userId": "master", "structured": {}, "text": ""})
            self.assertEqual(a["type"], "extract_ack")
            self.assertEqual(a["written"], [])           # 空载荷:什么都不写
            self.assertEqual(a["learned"], 0)
            self.assertNotIn("stub", a)
        finally:
            w.close()

    def test_longing_message_carries_due_for_turn_stopping(self):
        """v0.19.0 D2:longing_message 的 pre 带 threshold/due。

        壳侧轮末硬保证(agent/turn-stopping)只读这两个字段 —— 所以它们是
        帧契约的一部分:空库上 exists=false ⇒ due=false,但阈值仍是基础值
        7.0(不是 0:0 会让任何值都"到阈值")。
        """
        w = WorkerHarness()
        try:
            w.roundtrip(hello_frame())
            r = w.roundtrip({"reqId": 9, "type": "longing_message",
                             "userId": "master", "text": "我回来了"})
            self.assertEqual(r["type"], "longing_message_result")
            self.assertIsInstance(r["pre"], dict)
            self.assertIn("threshold", r["pre"])
            self.assertIn("due", r["pre"])
            self.assertAlmostEqual(r["pre"]["threshold"], 7.0)
            self.assertFalse(r["pre"]["due"])
            # post 仍是从前那个形状(post 不带判定,判定只对"他开口之前"有意义)
            self.assertIsInstance(r["post"], dict)
        finally:
            w.close()

    def test_stats_stub_and_longing_real(self):
        w = WorkerHarness()
        try:
            w.roundtrip(hello_frame())
            s = w.roundtrip({"reqId": 1, "type": "stats"})
            self.assertEqual(s["type"], "stats_result")
            self.assertTrue(s["stub"])
            # M2-f 起 longing_check 是真引擎帧:缺 userId 报错,
            # 带 userId 在空库上如实回「从未聊过」(exists=false)。
            l = w.roundtrip({"reqId": 2, "type": "longing_check"})
            self.assertEqual(l["type"], "error")
            l = w.roundtrip({"reqId": 3, "type": "longing_check",
                             "userId": "master"})
            self.assertEqual(l["type"], "longing_result")
            self.assertFalse(l["exists"])
            self.assertEqual(l["value"], 0.0)
            self.assertFalse(l["shouldCare"])
            self.assertNotIn("stub", l)
        finally:
            w.close()


class DbVerification(unittest.TestCase):
    """hello 验库:只验不建。"""

    def test_real_file_db(self):
        """库文件已存在:ok=true,tables 计数如实。"""
        with tempfile.TemporaryDirectory() as tmp:
            db_path = str(Path(tmp) / "echo.db")
            sqlite3.connect(db_path).close()  # 壳侧建库(worker 只验不建)
            w = WorkerHarness()
            try:
                ready = w.roundtrip(hello_frame(db_path=db_path))
                self.assertTrue(ready["db"]["ok"])
                self.assertEqual(ready["db"]["tables"], 0)
            finally:
                w.close()

    def test_missing_file_not_created(self):
        """M2-c 差分抓获的语义修正:路径不存在 → 拒绝,绝不静默建空库。

        裸 connect 会把「打错路径」变成「静默失忆到一个新空库」——
        旧版测试把这个 bug 供成了规范,JS 客户端握手剧本当场翻案。
        """
        with tempfile.TemporaryDirectory() as tmp:
            db_path = str(Path(tmp) / "nope.db")
            w = WorkerHarness()
            try:
                ready = w.roundtrip(hello_frame(db_path=db_path))
                self.assertEqual(ready["type"], "ready")
                self.assertFalse(ready["db"]["ok"])
                self.assertIn("not found", ready["db"]["error"])
                self.assertFalse(Path(db_path).exists())  # 关键:没建
            finally:
                w.close()

    def test_bad_db_path_reported_not_crashed(self):
        """库打不开:ok=false 带错误信息,worker 不崩(应答即诊断)。"""
        w = WorkerHarness()
        try:
            ready = w.roundtrip(hello_frame(db_path="Z:\\no\\such\\dir\\echo.db"))
            self.assertEqual(ready["type"], "ready")
            self.assertFalse(ready["db"]["ok"])
            self.assertIn("error", ready["db"])
            pong = w.roundtrip({"reqId": 2, "type": "ping"})
            self.assertEqual(pong["type"], "pong")
        finally:
            w.close()

    def test_missing_db_path_rejected(self):
        w = WorkerHarness()
        try:
            ready = w.roundtrip(hello_frame(db_path=""))
            self.assertEqual(ready["type"], "ready")
            self.assertFalse(ready["db"]["ok"])
        finally:
            w.close()


class BadNumericFrame(unittest.TestCase):
    """坏数值字段不许把 worker 打死(v0.42.0 全仓审计修复 P1)。

    原来每个 handler 各自 `int(frame.get("topK") or 6)` / `float(frame.get("now"))`
    —— 一个 "abc" 就是 ValueError,而 `main()` 里**没有** try/except:进程带
    traceback 退出,壳那边看到 EOF(被误判成"引擎崩了"),这次请求的错因也丢了。
    现在两层:入口 `_coerce_numeric` 归一(坏值走默认)+ `main()` 兜底(异常 ⇒ error 帧)。
    这条用例钉的是**进程活着** —— 它比"这一帧答得对不对"重要得多。
    """

    def test_bad_numeric_fields_fall_back_and_worker_survives(self):
        w = WorkerHarness()
        try:
            self.assertEqual(w.roundtrip(hello_frame())["type"], "ready")
            got = w.roundtrip({"reqId": 2, "type": "retrieve", "userId": "1",
                               "query": "咖啡", "topK": "abc", "now": "not-a-number"})
            self.assertEqual(got["type"], "retrieve_result", "坏值该按默认值处理,而不是崩或 error")
            self.assertEqual(w.roundtrip({"reqId": 3, "type": "ping"})["type"], "pong",
                             "坏帧之后进程必须还活着")
            got2 = w.roundtrip({"reqId": 4, "type": "memory_search", "userId": "1",
                                "query": "咖啡", "limit": []})
            self.assertEqual(got2["type"], "memory_search_result")
            self.assertEqual(w.roundtrip({"reqId": 5, "type": "ping"})["type"], "pong")
        finally:
            w.close()

    def test_null_numeric_field_falls_back_to_default(self):
        """null / 空串也是坏值的一种(它们原来会走 `or 默认值`,现在走归一,结果一样)。"""
        w = WorkerHarness()
        try:
            self.assertEqual(w.roundtrip(hello_frame())["type"], "ready")
            got = w.roundtrip({"reqId": 2, "type": "graph_query", "userId": "1",
                               "text": "咖啡", "topK": None})
            self.assertIn(got["type"], ("graph_query_result", "error"))
            self.assertEqual(w.roundtrip({"reqId": 3, "type": "ping"})["type"], "pong")
        finally:
            w.close()


if __name__ == "__main__":
    unittest.main()
