"""Manual controls: explicit input only, never imported by public discovery."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import sys
import tempfile
import unittest
from urllib.parse import unquote, urlsplit, parse_qs
from unittest import mock

PYTHON_ROOT = Path(__file__).resolve().parents[1]


def _manual_environment():
    sandbox = Path(tempfile.mkdtemp(prefix="echo-manual-controls-")).resolve()
    home = sandbox / "synthetic-home"
    home.mkdir()
    for key in list(os.environ):
        low = key.lower()
        if low.startswith(("echo_", "python")) or low in {
            "home", "userprofile", "appdata", "localappdata", "dsh_home",
            "dsh_data_dir", "tmp", "temp", "tmpdir", "xdg_config_home",
            "xdg_data_home"
        }:
            del os.environ[key]
    for key in ("HOME", "USERPROFILE", "DSH_HOME", "DSH_DATA_DIR",
                "APPDATA", "LOCALAPPDATA", "XDG_CONFIG_HOME", "XDG_DATA_HOME"):
        os.environ[key] = str(home)
    for key in ("TMP", "TEMP", "TMPDIR"):
        os.environ[key] = str(sandbox)
    tempfile.tempdir = str(sandbox)
    os.chdir(sandbox)
    sys.path.insert(0, str(PYTHON_ROOT))
    return sandbox


def _install_manual_guard(sandbox, snapshot=None):
    def check_sqlite(value):
        value = os.fsdecode(value)
        if value == ":memory:" or value.startswith("file::memory:"):
            return
        uri = urlsplit(value) if value.startswith("file:") else None
        raw = unquote(uri.path) if uri else value
        if os.name == "nt" and raw.startswith("/") and len(raw) > 2 and raw[2] == ":":
            raw = raw[1:]
        target = Path(raw).resolve()
        if snapshot is not None and target == snapshot:
            if uri is None or parse_qs(uri.query).get("mode") != ["ro"]:
                raise PermissionError("manual_snapshot_requires_readonly_uri")
            return
        if target != sandbox and sandbox not in target.parents:
            raise PermissionError("manual_sqlite_outside_sandbox")

    def audit(event, args):
        if event == "sqlite3.connect":
            check_sqlite(args[0])
        elif event == "open":
            name, mode, flags = args
            if isinstance(name, int):
                return
            target = Path(os.fsdecode(name)).resolve()
            write = (isinstance(mode, str) and any(letter in mode for letter in "wax+")
                     or isinstance(flags, int) and flags & (
                         os.O_WRONLY | os.O_RDWR | os.O_CREAT | os.O_TRUNC | os.O_APPEND))
            if write and target != sandbox and sandbox not in target.parents:
                raise PermissionError("manual_write_outside_sandbox")
        elif event in {"socket.connect", "socket.getaddrinfo"}:
            raise PermissionError("manual_network_forbidden")
    sys.addaudithook(audit)


def _run_manual(case):
    result = unittest.TextTestRunner(verbosity=2).run(
        unittest.defaultTestLoader.loadTestsFromTestCase(case))
    print(json.dumps({"manual": True, "tests": result.testsRun,
                      "failures": len(result.failures), "errors": len(result.errors),
                      "skipped": len(result.skipped),
                      "passed": result.wasSuccessful() and not result.skipped}))
    return 0 if result.wasSuccessful() and not result.skipped else 1


SNAPSHOT = None
mine = None

LEGACY_SPEAKERS = ("用户", "阿岚", "她", "Echo", "助手")

LEGACY_PERSON_NAMES = LEGACY_SPEAKERS + ("阿乙", "阿岚")

LEGACY_FRAME_NAMES = {"speakers": list(LEGACY_SPEAKERS),
                      "personNames": list(LEGACY_PERSON_NAMES)}

class ContractReconcile(unittest.TestCase):
    """钉住的活库快照上,复现契约 v1.1 的两条基线:同记忆 30→5、同天 94→42(R1 后)。"""

    def test_pinned_snapshot_reproduces_same_day_numbers(self):
        if not SNAPSHOT.exists():
            self.skipTest("快照不在:%s" % SNAPSHOT)
        # P1 收口(拍板 3):名单从**入参**来(不再靠改模块全局)—— 基线数字要"喂上名单"才算得出来
        report = mine.dry_run(str(SNAPSHOT), max_memory_id=306, kinds=(mine.KIND_SAME_DAY,),
                              names=LEGACY_FRAME_NAMES)
        self.assertEqual(report["candidates"], 94, "同天候选与契约基线(94)不一致")
        self.assertEqual(report["r1_excluded"], 52, "同天 R1 排除与契约基线(52)不一致")
        self.assertEqual(report["would_write"], 42,
                         "裁决①(kind-aware R2)之后,同天应写入 42 条(= R1 之后的全量)")
        self.assertEqual(report["lenient_same_day"]["would_write"], 42,
                         "对照口径(同天不带两端 ids)也应是 42 —— 两条路一致,且 R2 没被拔掉")
        self.assertEqual(report["r2_hit_zero_overlap_dropped"], 0,
                         "同天边不该再被判零重合")
        self.assertEqual(report["merged_view"]["active_edges_before"], 23)
        self.assertEqual(report["merged_view"]["active_edges_without_speaker_before"], 1)
        self.assertEqual(report["merged_view"]["active_edges_after"], 65)
        self.assertEqual(report["merged_view"]["active_edges_without_speaker_after"], 43)

    def test_pinned_snapshot_reproduces_contract_numbers(self):
        if not SNAPSHOT.exists():
            self.skipTest("快照不在(需要先跑 .scratch/stage3a-snapshot.py):%s" % SNAPSHOT)
        # P1 收口(拍板 3):同上 —— 名单从入参来
        report = mine.dry_run(str(SNAPSHOT), max_memory_id=306,
                              kinds=(mine.KIND_SAME_MEMORY,),
                              names=LEGACY_FRAME_NAMES)
        self.assertEqual(report["candidates"], 30, "候选数与契约基线(30)不一致")
        self.assertEqual(report["speaker_node_excluded_contract_flag"], 25,
                         "契约口径的 speaker_node_excluded 条数与基线(25)不一致")
        self.assertEqual(report["r1_excluded"], 25)
        self.assertEqual(report["would_write"], 5, "去说话人后应剩 5 条(契约基线)")
        self.assertEqual(report["counters"]["reasons"], {"speaker-node": 25})

    def test_contract_numbers_need_the_names_fed_in(self):
        """P1c 的正面证据:**不喂名字**,同一份快照的契约口径 R1 排除就是 0 ——
        基线数字不是"代码里天生知道谁是他",而是"名单喂进去"才算得出来的。"""
        if not SNAPSHOT.exists():
            self.skipTest("快照不在(需要先跑 .scratch/stage3a-snapshot.py):%s" % SNAPSHOT)
        report = mine.dry_run(str(SNAPSHOT), max_memory_id=306,
                              kinds=(mine.KIND_SAME_MEMORY,))
        self.assertEqual(report["speaker_node_excluded_contract_flag"], 0,
                         "代码里还留着内置名单?P1c 之后这里必然是 0")
        self.assertEqual(report["r1_excluded"], 0)
        self.assertEqual(report["would_write"], report["candidates"],
                         "中性口径下 R1 不拦任何人 ⇒ 候选全过")

    def test_dry_run_names_shapes_never_throw(self):
        """P1 收口:names 口子认帧形状(list / 逗号串),坏形状 ⇒ 中性退化、不抛。"""
        if not SNAPSHOT.exists():
            self.skipTest("快照不在(需要先跑 .scratch/stage3a-snapshot.py):%s" % SNAPSHOT)
        for bad in [None, 5, "不是对象", {"speakers": 7}, {"speakers": ["用户"], "personNames": None},
                    {"personNames": []}]:
            report = mine.dry_run(str(SNAPSHOT), max_memory_id=306,
                                  kinds=(mine.KIND_SAME_MEMORY,), names=bad)
            self.assertIsInstance(report["candidates"], int, "坏 names 不许把 dry-run 带崩")
        # 逗号串也认(手写配置的常见形态)—— 与列表等价
        report = mine.dry_run(str(SNAPSHOT), max_memory_id=306,
                              kinds=(mine.KIND_SAME_MEMORY,),
                              names={"speakers": "用户,阿岚,她,Echo,助手",
                                     "personNames": "用户,阿岚,她,Echo,助手,阿乙,阿岚"})
        self.assertEqual(report["speaker_node_excluded_contract_flag"], 25,
                         "逗号串喂的名字要与列表等价(25 条契约口径)")
        self.assertEqual(report["r1_excluded"], 25)

    def test_dry_run_on_snapshot_is_read_only(self):
        if not SNAPSHOT.exists():
            self.skipTest("快照不在:%s" % SNAPSHOT)
        before = hashlib.sha256(SNAPSHOT.read_bytes()).hexdigest()
        mine.dry_run(str(SNAPSHOT))
        self.assertEqual(hashlib.sha256(SNAPSHOT.read_bytes()).hexdigest(), before)


def main():
    parser = argparse.ArgumentParser(description="Explicit historical private-snapshot controls, outside the public baseline")
    parser.add_argument("--snapshot", required=True,
                        help="Historical input explicitly supplied by the operator; no default path")
    parser.add_argument("--accept-private-historical-input", action="store_true", required=True,
                        help="Acknowledge that this manual command reads the explicitly supplied private snapshot")
    options = parser.parse_args()
    snapshot = Path(options.snapshot).resolve(strict=True)
    if not snapshot.is_file():
        parser.error("snapshot must be an existing file")
    sandbox = _manual_environment()
    _install_manual_guard(sandbox, snapshot)
    global mine, SNAPSHOT
    from engine import graph_mine as mine
    SNAPSHOT = snapshot
    return _run_manual(ContractReconcile)


if __name__ == "__main__":
    sys.exit(main())
