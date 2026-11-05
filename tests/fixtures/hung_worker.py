# -*- coding: utf-8 -*-
"""超时剧本夹具:完成握手,业务帧一律挂起(永不应答)。

模拟「引擎进程活着但卡死」—— 比崩溃更阴险的故障,sidecar 的
请求超时 + 击杀 + 记账路径专门防它。
"""
import json
import sys

try:
    sys.stdin.reconfigure(encoding="utf-8")
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    try:
        frame = json.loads(line)
    except ValueError:
        continue
    if frame.get("type") == "hello":
        print(json.dumps({
            "reqId": frame.get("reqId"), "type": "ready",
            "engine": "python", "version": "0-test",
            "protocol": "echo_wire_v1",
            "db": {"ok": True, "path": "", "tables": 0},
        }, ensure_ascii=False))
        sys.stdout.flush()
    # 其他帧:故意吞掉不应答
