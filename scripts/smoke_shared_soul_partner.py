# -*- coding: utf-8 -*-
"""M8-b 共享灵魂库冒烟 —— python 侧伙伴(QQ 身体 / DSH 引擎)。

用法(由 smoke_shared_soul.mjs 编排,不单独跑):
  python scripts/smoke_shared_soul_partner.py --role qq  --db <path> --plugin <root> --tick-at <ms>
  python scripts/smoke_shared_soul_partner.py --role dsh --db <path> --tick-at <ms>

纪律(v0.9.1 教训:打真代码,不打假设):
  - QQ 侧导入插件本体的真 SchemaMixin(建表+补列机器)与真
    LongingMixin(_longing_tick),astrbot.api.logger 用 stub 注入
    (echo_schema 唯一的外部依赖);连接方式复刻 main.py 的
    WAL + busy_timeout=5000;
  - DSH 侧走真引擎:db.connect(busy_timeout 内置)+ 
    episodic.insert_memory + longing.on_message/tick;
  - 双 tick 幂等用解析期望值断言:v0 + M(沉默秒) —— 两侧
    tick 都是绝对值写回(从锚点算曲线,非增量累加),并发双写
    落同一个数;若出现增量式双算,期望值立刻对不上。
"""
import argparse
import asyncio
import importlib.util
import json
import sqlite3
import sys
import time
import types
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent

# 两侧对齐的想念配置(生产不变量:共享后两侧数学必须一致)
LONGING_CFG = {
    "longing_enabled": True,
    "longing_half_life_hours": 3.0,
    "longing_threshold": 7.0,
    "longing_msg_drop": 4.0,
    "longing_care_relief": 0.5,
    "longing_protest_kick": 1.5,
    "care_cooldown_minutes": 120,
    "care_night_hold": True,
    "longing_demo_rate": 1.0,
}


def install_astrbot_stub():
    """echo_schema 依赖 astrbot.api.logger —— 注入静默 stub 后即可独立导入真代码。"""
    if "astrbot" in sys.modules:
        return
    mod = types.ModuleType("astrbot")
    api = types.ModuleType("astrbot.api")

    class _Silent:
        def info(self, *a, **k): pass
        def warning(self, *a, **k): pass
        def error(self, *a, **k): pass
        def debug(self, *a, **k): pass

    api.logger = _Silent()
    mod.api = api
    sys.modules["astrbot"] = mod
    sys.modules["astrbot.api"] = api


class FakeCursor:
    """sqlite3 游标 → aiosqlite 形状(awaitable + async 上下文管理器)。"""

    def __init__(self, cur):
        self._cur = cur

    def __await__(self):
        async def _self():
            return self
        return _self().__await__()

    async def fetchall(self):
        return self._cur.fetchall()

    async def fetchone(self):
        return self._cur.fetchone()

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return None


class FakeAio:
    """sqlite3 连接 → aiosqlite 形状(execute 可 await 也可 async with)。"""

    def __init__(self, conn):
        self._conn = conn

    def execute(self, sql, params=()):
        return FakeCursor(self._conn.execute(sql, params))

    async def commit(self):
        self._conn.commit()

    async def rollback(self):
        self._conn.rollback()


def load_module(name, path):
    spec = importlib.util.spec_from_file_location(name, str(path))
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


def wait_until(epoch_ms):
    target = epoch_ms / 1000.0
    while True:
        remain = target - time.time()
        if remain <= 0:
            return
        time.sleep(min(remain, 0.05))


def run_qq(args, report):
    install_astrbot_stub()
    plugin = Path(args.plugin)
    sys.path.insert(0, str(plugin))
    schema_mod = load_module("echo_schema", plugin / "core" / "echo_schema.py")

    # 连接方式复刻 main.py:218-219(WAL + busy_timeout=5000)
    conn = sqlite3.connect(args.db)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA busy_timeout=5000")
    aio = FakeAio(conn)

    # ① 真 SchemaMixin 在 DSH 超集形状上建表/补列 —— 不炸即证明
    class SchemaHarness(schema_mod.SchemaMixin):
        def __init__(self, db):
            self._db = db

    async def ddl():
        h = SchemaHarness(aio)
        await h._create_tables()
        await h._create_graph_tables()

    asyncio.run(ddl())
    report["ddlOk"] = True

    # ② QQ 式插入(echo_schema 的 11 列集)+ 交错读
    for i in range(args.inserts):
        conn.execute(
            "INSERT INTO episodic_memory (user_id, keywords, summary, emotion_score,"
            " timestamp, is_active, source, source_label, actor, speaker_id, is_master)"
            " VALUES (?, ?, ?, ?, ?, 1, 'private', '', '', ?, 1)",
            ("master", "冒烟,qq" + str(i), "QQ渠道冒烟第" + str(i) + "条",
             5, time.time(), "<your-qq>"),
        )
        conn.commit()
        report["inserted"] += 1
        time.sleep(args.sleep_ms / 1000.0)

    # ③ 真 QQ tick(与 DSH 引擎 tick 同一时刻并发)
    longing_mod = load_module("echo_longing", plugin / "brains" / "echo_longing.py")

    class TickHarness(longing_mod.LongingMixin):
        def __init__(self, db, lock):
            self._db = db
            self._db_lock = lock

        def _cfg(self, key, cast=None):
            return LONGING_CFG.get(key)

    async def tick():
        await TickHarness(aio, asyncio.Lock())._longing_tick(now_ts=args.tick_at / 1000.0)

    wait_until(args.tick_at)
    asyncio.run(tick())
    report["tickOk"] = True

    # ④ 终数(此刻所有插入方都已收手)
    report["countAtEnd"] = conn.execute("SELECT COUNT(*) FROM episodic_memory").fetchone()[0]
    conn.close()


def run_dsh(args, report):
    sys.path.insert(0, str(REPO / "python"))
    from engine import db as edb, episodic, longing

    conn = edb.connect(args.db, must_exist=True)

    # ① 想念行播种:真 on_message 路径,锚点拨到 tick 前 300 秒
    #    (沉默 300s < 抗议窗下界 600s,尖峰不参与,期望值纯净)
    seed_now = args.tick_at / 1000.0 - 300.0
    cfg = longing.merge_config({
        "enabled": True, "halfLifeHours": 3.0, "threshold": 7.0, "msgDrop": 4.0,
        "careRelief": 0.5, "protestKick": 1.5, "cooldownMinutes": 120,
        "nightHold": True, "demoRate": 1.0,
    })
    longing.on_message(conn, "master", now=seed_now, cfg=cfg, text="dsh 伙伴播种", session_id="smoke-dsh")
    row = conn.execute(
        "SELECT value, anchor_at FROM longing_state WHERE user_id = 'master'"
    ).fetchone()
    report["v0"], report["anchor"] = float(row[0]), float(row[1])

    # ② 真引擎写入路径交错跑
    for i in range(args.inserts):
        episodic.insert_memory(
            conn, "master", json.dumps(["冒烟", "dsh" + str(i)]),
            "DSH引擎冒烟第" + str(i) + "条", 5, source="dsh-smoke",
        )
        report["inserted"] += 1
        time.sleep(args.sleep_ms / 1000.0)

    # ③ DSH 引擎 tick(与 QQ tick 同一时刻并发,now 显式对齐)
    wait_until(args.tick_at)
    longing.tick(conn, now=args.tick_at / 1000.0, cfg=cfg)
    report["tickOk"] = True

    # ④ 幂等断言:stored == v0 + M(300)(真曲线函数算期望)
    #    双 tick 都是绝对值写回 → 落同一个数;增量式双算 → 立刻对不上
    time.sleep(0.3)  # 让 QQ 侧 tick 的写也落库
    stored = float(conn.execute(
        "SELECT value FROM longing_state WHERE user_id = 'master'"
    ).fetchone()[0])
    expected = report["v0"] + longing.longing_curve(
        args.tick_at / 1000.0 - report["anchor"], cfg["half_life_hours"])
    report["storedValue"] = stored
    report["expectedValue"] = expected
    report["idempotentOk"] = abs(stored - expected) < 1e-6
    report["countAtEnd"] = conn.execute("SELECT COUNT(*) FROM episodic_memory").fetchone()[0]
    conn.close()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--role", choices=["qq", "dsh"], required=True)
    ap.add_argument("--db", required=True)
    ap.add_argument("--plugin", default="")
    ap.add_argument("--tick-at", type=int, required=True)
    ap.add_argument("--inserts", type=int, default=40)
    ap.add_argument("--sleep-ms", type=int, default=15)
    args = ap.parse_args()

    report = {"role": args.role, "errors": [], "inserted": 0}
    try:
        if args.role == "qq":
            run_qq(args, report)
        else:
            run_dsh(args, report)
    except Exception as exc:  # noqa: BLE001 —— 冒烟要把一切异常带出去
        report["errors"].append(type(exc).__name__ + ": " + str(exc))
    print("RESULT " + json.dumps(report, ensure_ascii=False))
    sys.exit(0 if not report["errors"] else 1)


if __name__ == "__main__":
    main()
