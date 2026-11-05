# -*- coding: utf-8 -*-
"""钉住向量臂模块的**契约**（Step A）。

分两层:
  * `EmbedContract` —— **不需要任何第三方依赖**,在系统 python 上就跑得起来。
    它钉的是这个模块最要紧的性质:**fail-soft**(预热失败不许抛)与
    **响亮失败**(没预热时 `embed()` 必须抛,不许返回零向量)。
  * 真实模型的五条控制在 `python/manual/verify_embed.py`，须显式提供模型目录。
    它们不属于默认公共发现，也不计为基线通过或跳过。

为什么 fail-soft 与响亮失败要同时钉住:
  2026-10-12 的事故是"拿不到向量 ⇒ 静默记 0 分 ⇒ 读数只是'变差了',没人查得出原因"。
  与之对称的另一半是:模型加载失败**不能让 worker 起不来**。
  两件事方向相反,所以两条都要有测试 —— 只钉一条,另一条迟早被顺手改掉。
"""
import os
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]          # dsh-echo/python
sys.path.insert(0, str(ROOT))

from engine import embed  # noqa: E402



class EmbedContract(unittest.TestCase):
    """不需要第三方依赖 —— 系统 python 上也必须全过。"""

    # The three model_dir tests only exercise path arithmetic; no filesystem I/O.
    def test_model_dir_env_override_wins(self):
        d = embed.model_dir(None, {"ECHO_EMBED_MODEL_DIR": "X:/somewhere/models"})
        self.assertEqual(d, "X:/somewhere/models")

    def test_model_dir_falls_back_to_db_dir(self):
        d = embed.model_dir("D:/data/echo.db", {})
        self.assertTrue(d.replace("\\", "/").endswith("/data/models/bge-small-zh-v1.5"),
                        "库旁边的 models/ 优先于 ~/.dsh:" + d)

    def test_model_dir_falls_back_to_dsh_home(self):
        d = embed.model_dir(None, {"DSH_HOME": "Y:/dshhome"})
        self.assertEqual(d.replace("\\", "/"), "Y:/dshhome/echo/models/bge-small-zh-v1.5")

    def test_available_is_readonly_and_never_raises(self):
        """`available()` 只报告,不许抛 —— 面板与状态面都要能安全调它。"""
        with tempfile.TemporaryDirectory() as directory:
            missing_model = os.path.join(directory, "not-created", "models", "synthetic")
            r = embed.available(None, {"ECHO_EMBED_MODEL_DIR": missing_model})
        self.assertIn("ok", r)
        self.assertFalse(r["ok"])
        self.assertIn("model.onnx", r["missing"])
        self.assertIn("tokenizer.json", r["missing"])
        self.assertEqual(set(r["deps"]), {"onnxruntime", "numpy", "tokenizers"})

    def test_available_missing_deps_is_reported_not_raised(self):
        """依赖缺失要**报出来**,不是抛异常(没装的机器上插件照常跑)。"""
        with tempfile.TemporaryDirectory() as directory:
            missing_model = os.path.join(directory, "not-created", "models", "synthetic")
            r = embed.available(None, {"ECHO_EMBED_MODEL_DIR": missing_model})
        self.assertFalse(r["ok"])
        self.assertTrue(r["reason"].startswith("依赖没装齐") or r["reason"].startswith("模型文件缺"))

    def test_warmup_never_raises_even_on_garbage(self):
        """**核心契约**:预热失败绝不许抛 —— worker 不能因为向量臂起不来。"""
        with tempfile.TemporaryDirectory() as directory:
            missing_model = os.path.join(directory, "not-created", "models", "synthetic")
            r = embed.warmup(None, {"ECHO_EMBED_MODEL_DIR": missing_model})
        self.assertFalse(r["ok"])
        self.assertFalse(r["warmed"])
        self.assertIsInstance(r["reason"], str)
        self.assertTrue(r["reason"])

    def test_embed_raises_loudly_when_not_warmed(self):
        """没预热 ⇒ 抛 `EmbedUnavailable`,**不许返回零向量**。

        与测台 `DenseNotEncoded` 同一立场:静默给零 = 读数只是"变差了"。
        """
        embed._state = {"warmed": False, "reason": "测试置空", "ms": None, "detail": {}}
        embed._sess = None
        embed._tok = None
        with self.assertRaises(embed.EmbedUnavailable):
            embed.embed(["随便一句"])

    def test_selfcheck_without_warmup_is_reported_not_raised(self):
        embed._state = {"warmed": False, "reason": "测试置空", "ms": None, "detail": {}}
        r = embed.selfcheck()
        self.assertFalse(r["ok"])
        self.assertIn("还没预热成功", r["reason"])

    def test_state_snapshot_shape(self):
        s = embed.state()
        self.assertEqual(set(s), {"warmed", "reason", "ms", "detail"})

    def test_constants_match_the_experiment(self):
        """口径常量必须与实验一致 —— 改了它就是换了模型,不是优化。"""
        self.assertEqual(embed.EMBED_DIM, 512)
        self.assertEqual(embed.MAX_LEN, 512)
        self.assertGreaterEqual(embed.WARMUP_TIMEOUT_S, 10.0,
                                "CPU 首次加载 1~3 秒,预热上限给小了会误判成失败")




class WarmupGate(unittest.TestCase):
    """Step B:预热开关。口径**照抄** `graph_gate`(env 优先 + 配置回落 + 报来源)。

    这些测试**不需要第三方依赖** —— 门控是纯逻辑,系统 python 上就该全过。
    """

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.config_path = os.path.join(self.temporary.name, "not-created-config.json")

    def test_default_is_off(self):
        self.assertFalse(embed.warmup_wanted({}, self.config_path))
        self.assertEqual(embed.warmup_source({}, self.config_path)["source"], "off")

    def test_env_truthy_values(self):
        for v in ("1", "true", "TRUE", "on", "Yes", " yes "):
            self.assertTrue(embed.warmup_wanted({embed.SWITCH_ENV: v}, self.config_path), repr(v))

    def test_env_falsy_values(self):
        for v in ("", "0", "false", "no", "off", "x"):
            self.assertFalse(embed.warmup_wanted({embed.SWITCH_ENV: v}, self.config_path), repr(v))

    def test_env_reports_source_env(self):
        s = embed.warmup_source({embed.SWITCH_ENV: "1"}, self.config_path)
        self.assertTrue(s["on"])
        self.assertEqual(s["source"], "env")
        self.assertIn(embed.SWITCH_ENV, s["detail"])

    def test_config_top_level_true_enables(self):
        import json as _json
        import tempfile
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, "config.json")
            with open(p, "w", encoding="utf-8") as fh:
                _json.dump({embed.SWITCH_CONFIG_KEY: True}, fh)
            self.assertTrue(embed.warmup_wanted({}, p))
            self.assertEqual(embed.warmup_source({}, p)["source"], "config")

    def test_config_strict_true_only(self):
        """`"true"` 字符串 / 1 / 缺键 一律按**关** —— 与壳侧 `=== true` 同一口径。"""
        import json as _json
        import tempfile
        for val in ("true", 1, None, False):
            with tempfile.TemporaryDirectory() as d:
                p = os.path.join(d, "config.json")
                with open(p, "w", encoding="utf-8") as fh:
                    _json.dump({embed.SWITCH_CONFIG_KEY: val}, fh)
                self.assertFalse(embed.warmup_wanted({}, p), repr(val))

    def test_config_missing_or_broken_is_off_not_raise(self):
        import tempfile
        self.assertFalse(embed.warmup_wanted({}, self.config_path))
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, "config.json")
            with open(p, "w", encoding="utf-8") as fh:
                fh.write("{ 这不是 json")
            self.assertFalse(embed.warmup_wanted({}, p))

    def test_env_falsy_falls_back_to_config(self):
        import json as _json
        import tempfile
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, "config.json")
            with open(p, "w", encoding="utf-8") as fh:
                _json.dump({embed.SWITCH_CONFIG_KEY: True}, fh)
            # env 给了个非真值 ⇒ 回落到配置那一路(两路 OR 的第二路)
            s = embed.warmup_source({embed.SWITCH_ENV: "0"}, p)
            self.assertTrue(s["on"])
            self.assertEqual(s["source"], "config")


class EmbedStateFile(unittest.TestCase):
    """Step B:worker 主动上报的状态文件(壳侧状态面读它)。"""

    def test_state_path_sits_next_to_db(self):
        p = embed.state_path(r"D:\data\echo.db", {})
        self.assertEqual(os.path.basename(p), "embed-state.json")
        self.assertTrue(p.replace("\\", "/").startswith("D:/data/"), p)

    def test_publish_then_read_roundtrip(self):
        import tempfile
        with tempfile.TemporaryDirectory() as d:
            db = os.path.join(d, "echo.db")
            env = {"ECHO_EMBED_MODEL_DIR": os.path.join(d, "models", "bge-small-zh-v1.5"),
                   embed.SWITCH_CONFIG_PATH_ENV: os.path.join(d, "not-created-config.json")}
            embed._state = {"warmed": True, "reason": "ok", "ms": 123.4, "detail": {}}
            r = embed.publish(db, env)
            self.assertTrue(r["ok"], r)
            got = embed.read_state_file(db, env)
            self.assertIsNotNone(got)
            self.assertEqual(got["schema"], "echo.embed.state.v1")
            self.assertTrue(got["warmed"])
            self.assertEqual(got["reason"], "ok")
            self.assertAlmostEqual(got["ms"], 123.4, places=1)
            self.assertIn("at", got)
            self.assertIn("source", got)

    def test_publish_never_raises_on_bad_dir(self):
        """写不了状态文件不该影响任何事 —— 契约与 warmup 一致:不抛。"""
        with tempfile.TemporaryDirectory() as directory:
            blocked_parent = Path(directory) / "blocked-parent"
            blocked_parent.write_text("synthetic parent blocker", encoding="utf-8")
            env = {"ECHO_EMBED_MODEL_DIR": str(blocked_parent / "models" / "synthetic"),
                   embed.SWITCH_CONFIG_PATH_ENV: os.path.join(directory, "not-created-config.json")}
            r = embed.publish(None, env)
        self.assertIn("ok", r)

    def test_read_missing_returns_none(self):
        import tempfile
        with tempfile.TemporaryDirectory() as directory:
            missing_model = os.path.join(directory, "not-created", "models", "synthetic")
            self.assertIsNone(embed.read_state_file(None, {"ECHO_EMBED_MODEL_DIR": missing_model}))

    def test_rss_mb_is_plausible_or_none(self):
        """能测就给个像样的数(几十 MB 量级),测不到就 None —— 但不许抛。"""
        v = embed.rss_mb()
        self.assertTrue(v is None or v > 1.0, "RSS 读数不像话: %r" % v)


if __name__ == "__main__":
    unittest.main()
