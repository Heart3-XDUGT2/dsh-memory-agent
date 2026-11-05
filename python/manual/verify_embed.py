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


embed = None

class EmbedWithDeps(unittest.TestCase):
    """装好依赖之后:预热、自检、编码都要真的能用。"""

    @classmethod
    def setUpClass(cls):
        cls.r = embed.warmup()

    def test_warmup_ok_and_reports_ms(self):
        self.assertTrue(self.r["ok"], self.r["reason"])
        self.assertIsInstance(self.r["ms"], float)
        self.assertGreater(self.r["ms"], 0.0)

    def test_selfcheck_all_green(self):
        s = embed.selfcheck()
        self.assertTrue(s["ok"], s)
        for name, ok, note in s["checks"]:
            self.assertTrue(ok, "%s 没过: %s" % (name, note))

    def test_embed_shape_and_norm(self):
        import numpy as np
        v = embed.embed(["他最喜欢吃什么", "今天天气不错"])
        self.assertEqual(v.shape, (2, embed.EMBED_DIM))
        self.assertTrue(np.allclose(np.linalg.norm(v, axis=1), 1.0, atol=1e-4))

    def test_embed_is_deterministic(self):
        import numpy as np
        a = embed.embed(["同一句话"])
        b = embed.embed(["同一句话"])
        self.assertTrue(np.array_equal(a, b), "同句两次编码必须逐位一致")

    def test_embed_empty_returns_empty_matrix(self):
        v = embed.embed([])
        self.assertEqual(v.shape, (0, embed.EMBED_DIM))


def main():
    parser = argparse.ArgumentParser(description="Explicit actual-model controls, outside the public baseline")
    parser.add_argument("--model-dir", required=True,
                        help="Existing model directory explicitly supplied by the operator")
    options = parser.parse_args()
    model = Path(options.model_dir).resolve(strict=True)
    if not model.is_dir():
        parser.error("model directory is required")
    sandbox = _manual_environment()
    _install_manual_guard(sandbox)
    global embed
    from engine import embed
    os.environ["ECHO_EMBED_MODEL_DIR"] = str(model)
    available = embed.available(None, {"ECHO_EMBED_MODEL_DIR": str(model)})
    if not available["ok"]:
        raise RuntimeError("explicit_model_or_dependencies_unavailable")
    # Only the checkpoint destination is scoped to synthetic storage. Actual
    # model files, ONNX computation and the preserved test bodies stay real.
    with mock.patch.object(embed, "state_path", return_value=str(sandbox / "embed-state.json")):
        return _run_manual(EmbedWithDeps)


if __name__ == "__main__":
    sys.exit(main())
