# -*- coding: utf-8 -*-
"""向量臂的模型加载 / 预热 / 自检 —— **独立模块,不接检索路径**(Step A)。

设计前提(三条,都是实测逼出来的):

1. **加载必须发生在启动阶段,不能落在检索路径里。**
   检索超时 `RETRIEVE_TIMEOUT_MS = 4000`,而超时的后果不是"这一轮没结果",是
   `_kill` 掉 worker + 记一次失败;**3 连败开熔断**,之后所有请求快速失败。
   模型首次加载在 CPU 上要 1~3 秒 —— 落在检索路径里就是拿熔断器赌。
   ⇒ 所以这里给的是 `warmup()`:启动时主动加载 + 跑一次真推理。

2. **预热失败绝不能让 worker 起不来。**
   所以本模块**所有对外函数都不抛** `warmup()` 只返回状态字典。
   worker 侧只要"记下来、继续跑"就行。向量臂不可用 ⇒ 插件其余部分照常。

3. **但 `embed()` 拿不到结果时必须抛,不能返回零向量。**
   这条是 2026-10-12 那次事故的教训:测台上"查不到向量 ⇒ 静默返回空 ⇒ 记 0 分",
   读数从 87.2% 掉到 51.5% 而**全程无报错**。零向量与"没编码"必须响亮地分开。

依赖(装在独立 venv 里,见 `scripts/embed-setup.mjs`):
    onnxruntime / numpy / tokenizers
三条都是**惰性 import** —— 没装它们的解释器照样能 import 本模块(只是 `available()` 报缺)。

用法(独立可跑,不需要 worker):
    <venv>/python.exe -m engine.embed --warmup     # 预热 + 自检,打印状态
    <venv>/python.exe -m engine.embed --check      # 只报告可得性
"""
from __future__ import annotations

import json
import os
import time

#: 与实验一致的口径(2026-10-11 实测):CLS 池化 + L2 归一,512 维。
EMBED_DIM = 512
MAX_LEN = 512
#: 预热上限。CPU 上首次加载 1~3 秒,给 30 秒是**宽裕到能容纳慢磁盘**的量级;
#: 它只影响"要不要放弃预热",不影响任何检索超时。
WARMUP_TIMEOUT_S = 30.0
#: 自检用的探针句与它应该最像的那条(取自实验语料,写死以免依赖现场数据)。
SELFCHECK_PROBE = "他最喜欢吃什么"

_sess = None            # onnxruntime InferenceSession
_tok = None             # tokenizers.Tokenizer
_state = {"warmed": False, "reason": "尚未预热", "ms": None, "detail": {}}


# ================================================================ 预热开关
# 口径**照抄** `engine/graph_gate.py` 的那一套(同一个仓库里已有的先例):
#   · 环境变量优先,但它改一次要重启宿主;
#   · 配置文件(`$DSH_HOME/echo/config.json`)的**顶层键**作第二路 ——
#     ⚠️ **刻意放顶层,不放进 `settings` 段**:那段是 125 项调参面,键集被
#     `tests/settings-fields.test.js` 三向对齐电池 + README 项数钉着,
#     塞进去就得同时改字段表/README/测试。顶层的 `graphShadowEdges` 正是这么做的。
#   · 默认**关** —— 关掉时 worker 连 import 都不做,与现状逐位一致。
SWITCH_ENV = "ECHO_EMBED_WARMUP"
#: 必须与壳侧常量同一个字符串(两边各一份是语言边界,但写法只此一种)。
SWITCH_CONFIG_KEY = "embedWarmup"
#: 把设置文件指到别处(夹具 / 单测用)。不设 ⇒ 按 DSH_HOME 推。
SWITCH_CONFIG_PATH_ENV = "ECHO_EMBED_WARMUP_CONFIG"
#: 硬默认:关。
DEFAULT_ENABLED = False


def _truthy(raw):
    """真值口径:`1` / `true` / `on` / `yes`(大小写无关)—— 与 graph_gate 同一套。"""
    return str(raw or "").strip().lower() in ("1", "true", "on", "yes")


def switch_config_path(env=None):
    """设置文件路径,推法与 `graph_gate.switch_config_path` 同一份。"""
    mapping = os.environ if env is None else env
    if hasattr(mapping, "get"):
        override = str(mapping.get(SWITCH_CONFIG_PATH_ENV, "") or "").strip()
        if override:
            return override
        home = str(mapping.get("DSH_HOME", "") or "").strip()
    else:
        home = ""
    base = home if home else os.path.join(os.path.expanduser("~"), ".dsh")
    return os.path.join(base, "echo", "config.json")


def config_flag_enabled(env=None, path=None):
    """设置文件读数:`embedWarmup` **严格等于 `True`** 才算开。

    never-throw:文件缺失 / 坏 JSON / 不是对象 / 写成 `"true"` 字符串 ⇒ 一律按**关**
    (与壳侧 `=== true` 同一口径,免得"文件里写了点什么"和"真的开着"读出两个答案)。
    """
    target = path or switch_config_path(env)
    try:
        with open(target, "r", encoding="utf-8") as fh:
            raw = json.load(fh)
    except Exception:
        return False
    if not isinstance(raw, dict):
        return False
    return raw.get(SWITCH_CONFIG_KEY) is True


def warmup_source(env=None, path=None):
    """开关读数 + **它从哪来**(env / config / 默认关)。

    为什么要报来源:两条路 OR 的时候,"面板显示关、引擎却在跑"是最坏的一种
    —— `graph_gate` 的注释里专门写过这条教训。报来源就不会读出两个答案。
    """
    mapping = os.environ if env is None else env
    raw = mapping.get(SWITCH_ENV, "") if hasattr(mapping, "get") else ""
    if _truthy(raw):
        return {"on": True, "source": "env", "detail": "%s=%s" % (SWITCH_ENV, raw)}
    if config_flag_enabled(env, path):
        return {"on": True, "source": "config", "detail": SWITCH_CONFIG_KEY}
    return {"on": False, "source": "off", "detail": "默认关(env 与 %s 都没开)" % SWITCH_CONFIG_KEY}


def warmup_wanted(env=None, path=None):
    """要不要在启动时预热。默认 **False** ⇒ 与今天逐位一致。"""
    return bool(warmup_source(env, path)["on"])



# ---------------------------------------------------------------- 路径

def model_dir(db_path=None, env=None):
    """模型目录的解析链:ECHO_EMBED_MODEL_DIR → <库所在目录>/models/... → ~/.dsh/echo/models/..."""
    e = env if env is not None else os.environ
    explicit = str(e.get("ECHO_EMBED_MODEL_DIR") or "").strip()
    if explicit:
        return explicit
    name = "bge-small-zh-v1.5"
    if db_path:
        return os.path.join(os.path.dirname(os.path.abspath(db_path)), "models", name)
    home = str(e.get("DSH_HOME") or "").strip() or os.path.join(os.path.expanduser("~"), ".dsh")
    return os.path.join(home, "echo", "models", name)


def _need_files(d):
    return {
        "model.onnx": os.path.join(d, "model.onnx"),
        "tokenizer.json": os.path.join(d, "tokenizer.json"),
    }


# ---------------------------------------------------------------- 可得性

def _dep_present(name):
    """依赖在不在 —— 用 `find_spec`(**只查,不执行模块**)。

    ⚠️ 2026-10-12 实测教训:这里原来写的是 `__import__(mod)`。那会让**每次**
    `available()` 都真去执行 onnxruntime/numpy/tokenizers 的 import ——
    实测在 venv 里单次 **610 ms**,在 worker 里首次更久(probe 帧 >25 s 才回)。
    一个"探针"绝不该干这种事:它挂在请求处理路径上,而壳侧请求超时是 4000 ms。
    换成 `find_spec` 之后是纯查表,微秒级,且**不产生任何 import 副作用**。
    """
    try:
        import importlib.util
        return importlib.util.find_spec(name) is not None
    except (ImportError, ValueError, AttributeError):
        return False


def available(db_path=None, env=None):
    """**只读**报告向量臂可不可用。不加载任何东西、不抛异常。

    返回 `{"ok": bool, "reason": str, "missing": [...], "deps": {...}, "model_dir": str}`。
    """
    d = model_dir(db_path, env)
    deps = {m: _dep_present(m) for m in ("onnxruntime", "numpy", "tokenizers")}
    missing = []
    for label, path in _need_files(d).items():
        if not (os.path.isfile(path) and os.path.getsize(path) > 0):
            missing.append(label)
    if not all(deps.values()):
        return {"ok": False, "reason": "依赖没装齐: " + ", ".join(k for k, v in deps.items() if not v),
                "missing": missing, "deps": deps, "model_dir": d}
    if missing:
        return {"ok": False, "reason": "模型文件缺: " + ", ".join(missing),
                "missing": missing, "deps": deps, "model_dir": d}
    return {"ok": True, "reason": "齐备(但尚未预热)", "missing": [], "deps": deps, "model_dir": d}


# ---------------------------------------------------------------- 预热

def warmup(db_path=None, env=None, timeout_s=WARMUP_TIMEOUT_S):
    """加载模型 + 跑一次真推理。**永不抛异常**,失败只写进返回值。

    为什么"真推理"而不只是"加载":ONNX 的首次 `run()` 会触发内存分配与算子图准备,
    只加载不跑的话,第一次检索照样会慢。

    返回 `{"ok": bool, "reason": str, "ms": float|None, "detail": {...}}`。
    """
    global _sess, _tok, _state
    t0 = time.perf_counter()
    av = available(db_path, env)
    if not av["ok"]:
        _state = {"warmed": False, "reason": av["reason"], "ms": None, "detail": av}
        return dict(_state, ok=False)
    try:
        import numpy as np
        import onnxruntime as ort
        from tokenizers import Tokenizer

        so = ort.SessionOptions()
        so.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
        # 单线程:intra_op 默认会按核数起线程池,对一个"每轮编 1 条查询"的负载是浪费,
        # 而且会把启动时的 CPU 打满。要提速应该走 GPU provider,不是加线程。
        so.intra_op_num_threads = 1
        sess = ort.InferenceSession(os.path.join(av["model_dir"], "model.onnx"),
                                    sess_options=so, providers=["CPUExecutionProvider"])
        tok = Tokenizer.from_file(os.path.join(av["model_dir"], "tokenizer.json"))
        tok.enable_truncation(max_length=MAX_LEN)

        # 真推理一次(顺带验输出形状)
        enc = tok.encode(SELFCHECK_PROBE)
        ids = np.asarray([enc.ids], dtype=np.int64)
        mask = np.asarray([enc.attention_mask], dtype=np.int64)
        types = np.asarray([enc.type_ids], dtype=np.int64)
        feeds = {"input_ids": ids, "attention_mask": mask, "token_type_ids": types}
        names = {i.name for i in sess.get_inputs()}
        last = sess.run(None, {k: v for k, v in feeds.items() if k in names})[0]
        if last.shape != (1, len(enc.ids), EMBED_DIM):
            raise RuntimeError("输出形状不对: %s(期望 (1, %d, %d))"
                               % (last.shape, len(enc.ids), EMBED_DIM))

        _sess, _tok = sess, tok
        ms = (time.perf_counter() - t0) * 1000.0
        _state = {"warmed": True, "reason": "ok", "ms": ms,
                  "detail": {"model_dir": av["model_dir"], "dim": EMBED_DIM,
                             "probe_tokens": len(enc.ids), "providers": sess.get_providers()}}
        return dict(_state, ok=True)
    except Exception as exc:                       # noqa: BLE001 —— 这里就是要吞掉一切
        ms = (time.perf_counter() - t0) * 1000.0
        _state = {"warmed": False, "reason": "预热失败: %s" % str(exc)[:200], "ms": ms,
                  "detail": av}
        return dict(_state, ok=False)


# ---------------------------------------------------------------- 自检

def selfcheck(db_path=None, env=None):
    """预热之后验"模型真的能用"。三项,全过才算 ok。

    为什么要有它:"加载成功"不等于"算出来的东西对"。实测过的坑包括池化取错维
    (mean 而不是 CLS)、归一化漏掉 —— 两种都能让向量看起来正常、但检索全废。
    所以这里查的是**数值性质**,不是"对象在不在"。
    """
    if not _state.get("warmed"):
        return {"ok": False, "reason": "还没预热成功: " + str(_state.get("reason")),
                "checks": []}
    checks = []
    try:
        import numpy as np
        vec = embed([SELFCHECK_PROBE, "今天天气不错"])
        norms = np.linalg.norm(vec, axis=1)
        checks.append(("形状", vec.shape == (2, EMBED_DIM), str(vec.shape)))
        checks.append(("L2 归一(≈1)", bool(np.allclose(norms, 1.0, atol=1e-4)),
                       "%.6f / %.6f" % (norms[0], norms[1])))
        checks.append(("不是零向量", bool(np.any(vec != 0)), "min|v|=%.4f" % float(np.abs(vec).min())))
        # 同一句两次编码必须逐位一致(确定性)
        again = embed([SELFCHECK_PROBE])
        checks.append(("确定性(同句两次同值)", bool(np.array_equal(vec[0], again[0])), ""))
    except Exception as exc:                       # noqa: BLE001
        return {"ok": False, "reason": "自检抛错: %s" % str(exc)[:200], "checks": checks}
    ok = all(c[1] for c in checks)
    return {"ok": ok, "reason": "ok" if ok else "有项没过", "checks": checks}


# ---------------------------------------------------------------- 编码

class EmbedUnavailable(RuntimeError):
    """向量臂不可用 —— **不是"没结果",是"没法算"**。

    与 `retrieval-bench.py` 的 `DenseNotEncoded` 同一个立场:拿不到向量时必须响亮地失败,
    绝不返回零向量 —— 那会让读数"看起来只是变差了",而没人查得出原因。
    """


def embed(texts, batch=32):
    """把文本编成 (n, 512) 的 L2 归一向量。**不可用 / 没预热 ⇒ 抛 `EmbedUnavailable`。**

    口径与实验完全一致(2026-10-12 实测:与 torch 版逐条余弦 = 1.000000,最大绝对差 1.8e-07):
    分词用模型自带的 `tokenizer.json`(含后处理,自动加 [CLS]/[SEP]),
    池化取 **CLS**(第 0 位),再 L2 归一。
    """
    if not _state.get("warmed") or _sess is None or _tok is None:
        raise EmbedUnavailable("向量臂不可用或尚未预热: " + str(_state.get("reason")))
    import numpy as np

    texts = [str(t) for t in texts]
    if not texts:
        return np.zeros((0, EMBED_DIM), dtype=np.float32)
    out = []
    names = {i.name for i in _sess.get_inputs()}
    for i in range(0, len(texts), batch):
        encs = _tok.encode_batch(texts[i:i + batch])
        width = max(len(e.ids) for e in encs)
        ids = np.zeros((len(encs), width), dtype=np.int64)
        mask = np.zeros((len(encs), width), dtype=np.int64)
        types = np.zeros((len(encs), width), dtype=np.int64)
        for r, e in enumerate(encs):
            ids[r, :len(e.ids)] = e.ids
            mask[r, :len(e.ids)] = e.attention_mask
            types[r, :len(e.ids)] = e.type_ids
        feeds = {"input_ids": ids, "attention_mask": mask, "token_type_ids": types}
        last = _sess.run(None, {k: v for k, v in feeds.items() if k in names})[0]
        cls = last[:, 0]                                     # ★ CLS 池化(不是 mean)
        n = np.linalg.norm(cls, axis=1, keepdims=True)       # ★ L2 归一
        out.append((cls / np.where(n == 0, 1.0, n)).astype(np.float32))
    return np.vstack(out)


def state():
    """给状态面/审计读的一份快照(纯只读)。"""
    return {"warmed": bool(_state.get("warmed")), "reason": _state.get("reason"),
            "ms": _state.get("ms"), "detail": _state.get("detail") or {}}


# ---------------------------------------------------------------- 状态文件
#: 壳侧状态面读的那份快照。放数据目录(与 config.json 同级)。
STATE_FILE = "embed-state.json"


def state_path(db_path=None, env=None):
    d = model_dir(db_path, env)
    # model_dir 是 <data>/models/<name> ⇒ 往上两级回到 <data>
    return os.path.join(os.path.dirname(os.path.dirname(d)), STATE_FILE)


def publish(db_path=None, env=None):
    """把当前状态写一份到 `<数据目录>/embed-state.json`。**never-throw**。

    为什么要这个文件(而不是壳主动问):壳侧唯一能发帧的地方是 `lib/engine.js`,
    而它**没有导出 `frame()`** ⇒ 在"本步不改 engine.js"的纪律下,壳没法主动发
    `embed_probe`。写文件是**worker 主动上报**的唯一一条不碰 engine.js 的路。

    附带的好处:worker 死了文件还在,状态面能看到"最后一次已知状态 + 时间",
    而不是一片空白 —— 前提是读的人自己判新鲜度(见下面的 `at` 字段)。
    """
    payload = dict(state())
    payload["schema"] = "echo.embed.state.v1"
    payload["at"] = time.time()
    payload["at_iso"] = time.strftime("%Y-%m-%dT%H:%M:%S")
    payload["source"] = warmup_source(env)
    payload["model_dir"] = model_dir(db_path, env)
    payload["rss_mb"] = rss_mb()
    payload["pid"] = os.getpid()
    try:
        target = state_path(db_path, env)
        parent = os.path.dirname(target)
        # ⚠️ **不建目录**:目标目录不存在 ⇒ 直接放弃。
        # 为什么:退化的 model_dir(比如 `ECHO_EMBED_MODEL_DIR=nul` 这种)推出来的
        # 父目录是空串,`join('', 'embed-state.json')` 就是**当前工作目录** ——
        # 实测在仓库根落过一个 `embed-state.json` 垃圾文件。
        # 生产里数据目录**总是存在**,所以这条不会挡住正常路径。
        if not os.path.isdir(parent):
            return {"ok": False, "path": target, "error": "父目录不存在,不写(避免落垃圾)"}
        tmp = target + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(payload, fh, ensure_ascii=False, indent=2)
        os.replace(tmp, target)          # 原子替换:读的人永远看不到半截文件
        return {"ok": True, "path": target}
    except Exception as exc:             # noqa: BLE001 —— 写不了状态文件不该影响任何事
        return {"ok": False, "path": None, "error": str(exc)[:200]}


def read_state_file(db_path=None, env=None):
    """读回状态文件(壳侧/测试用)。读不到 ⇒ None。"""
    try:
        with open(state_path(db_path, env), "r", encoding="utf-8") as fh:
            raw = json.load(fh)
        return raw if isinstance(raw, dict) else None
    except Exception:
        return None


def rss_mb():
    """本进程的常驻内存(MB)。量不到 ⇒ None(**绝不抛**)。

    为什么自己量而不是外部量:`venv\\Scripts\\python.exe` 在 Windows 上可能是个
    launcher,外部拿到的 PID 是那个小 stub(实测读出 4.1 MB 这种不可能的值)。
    从进程内部读自己的工作集才准。Windows 走 `GetProcessMemoryInfo`。
    """
    try:
        import ctypes
        import ctypes.wintypes as wt

        class PROCESS_MEMORY_COUNTERS(ctypes.Structure):
            _fields_ = [("cb", wt.DWORD), ("PageFaultCount", wt.DWORD),
                        ("PeakWorkingSetSize", ctypes.c_size_t),
                        ("WorkingSetSize", ctypes.c_size_t),
                        ("QuotaPeakPagedPoolUsage", ctypes.c_size_t),
                        ("QuotaPagedPoolUsage", ctypes.c_size_t),
                        ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t),
                        ("QuotaNonPagedPoolUsage", ctypes.c_size_t),
                        ("PagefileUsage", ctypes.c_size_t),
                        ("PeakPagefileUsage", ctypes.c_size_t)]

        c = PROCESS_MEMORY_COUNTERS()
        c.cb = ctypes.sizeof(c)
        k32 = ctypes.windll.kernel32
        psapi = ctypes.windll.psapi
        # ⚠️ **必须声明 argtypes**:不声明的话 ctypes 把 HANDLE 当 32 位 int 传,
        # 64 位下句柄被截断 ⇒ 调用失败、返回 None(实测踩过)。
        fn = getattr(psapi, "GetProcessMemoryInfo", None) or k32.K32GetProcessMemoryInfo
        fn.argtypes = [ctypes.c_void_p, ctypes.POINTER(PROCESS_MEMORY_COUNTERS), wt.DWORD]
        fn.restype = wt.BOOL
        k32.GetCurrentProcess.restype = ctypes.c_void_p
        handle = k32.GetCurrentProcess()
        if not fn(ctypes.c_void_p(handle), ctypes.byref(c), c.cb):
            return None
        return c.WorkingSetSize / 1024.0 / 1024.0
    except Exception:
        return None


# ---------------------------------------------------------------- CLI(独立可跑)

def _main(argv):
    db_path = None
    if "--db" in argv:
        db_path = argv[argv.index("--db") + 1]
    if "--check" in argv:
        print(json.dumps(available(db_path), ensure_ascii=False, indent=2))
        return 0
    r = warmup(db_path)
    print(json.dumps(r, ensure_ascii=False, indent=2))
    if r["ok"]:
        s = selfcheck(db_path)
        print(json.dumps(s, ensure_ascii=False, indent=2))
        return 0 if s["ok"] else 3
    return 2


if __name__ == "__main__":
    import sys
    raise SystemExit(_main(sys.argv[1:]))
