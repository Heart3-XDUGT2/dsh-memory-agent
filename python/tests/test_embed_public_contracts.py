"""Five public synthetic embedding contracts; no real models or dependencies."""
import math
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from engine import embed
from public_embed_fakes import SyntheticEmbeddingBackend


class PublicSyntheticEmbedding(unittest.TestCase):
    """Run production code with only ORT/tokenizer/numpy import adapters replaced."""

    def setUp(self):
        directory = tempfile.TemporaryDirectory(prefix="echo-public-embed-contract-")
        self.addCleanup(directory.cleanup)
        self.directory = Path(directory.name).resolve()
        self.model = self.directory / "models" / "public-synthetic-model"
        self.model.mkdir(parents=True)
        (self.model / "model.onnx").write_bytes(
            b"synthetic model bytes; not an ONNX artifact\n")
        (self.model / "tokenizer.json").write_text(
            '{"adapter":"synthetic"}\n', encoding="utf-8")
        config = self.directory / "public-config.json"
        config.write_text('{"embedWarmup":false}\n', encoding="utf-8")
        synthetic_home = self.directory / "synthetic-home"
        synthetic_home.mkdir()
        self.environment = {
            "ECHO_EMBED_MODEL_DIR": str(self.model),
            "ECHO_EMBED_WARMUP_CONFIG": str(config),
            "DSH_HOME": str(synthetic_home),
        }
        self.backend = SyntheticEmbeddingBackend()
        patches = [
            mock.patch.dict(sys.modules, self.backend.modules()),
            mock.patch.object(embed, "_state",
                              {"warmed": False, "reason": "synthetic cold start",
                               "ms": None, "detail": {}}),
            mock.patch.object(embed, "_sess", None),
            mock.patch.object(embed, "_tok", None),
        ]
        for patch in patches:
            patch.start()
            self.addCleanup(patch.stop)
        self.availability = embed.available(
            str(self.directory / "public-synthetic.db"), self.environment)
        self.warmup = embed.warmup(
            str(self.directory / "public-synthetic.db"), self.environment)
        self.assertTrue(self.warmup["ok"], self.warmup)

    def test_warmup_executes_synthetic_inference_and_reports_state(self):
        self.assertTrue(self.availability["ok"], self.availability)
        self.assertEqual(self.availability["deps"],
                         {"onnxruntime": True, "numpy": True, "tokenizers": True})
        self.assertEqual(self.availability["missing"], [])
        self.assertEqual(self.warmup["reason"], "ok")
        self.assertIsInstance(self.warmup["ms"], float)
        self.assertGreaterEqual(self.warmup["ms"], 0.0)
        state = embed.state()
        self.assertEqual(set(state), {"warmed", "reason", "ms", "detail"})
        self.assertTrue(state["warmed"])
        self.assertEqual(state["detail"]["dim"], 512)
        self.assertEqual(state["detail"]["probe_tokens"], 3)
        self.assertEqual(state["detail"]["model_dir"], str(self.model))
        self.assertEqual(state["detail"]["providers"], ["CPUExecutionProvider"])
        self.assertEqual(len(self.backend.sessions), 1)
        self.assertEqual(self.backend.sessions[0].path, str(self.model / "model.onnx"))
        self.assertEqual(self.backend.options[0].intra_op_num_threads, 1)
        self.assertEqual(self.backend.options[0].graph_optimization_level, "synthetic-all")
        self.assertEqual(self.backend.tokenizer_paths, [str(self.model / "tokenizer.json")])
        self.assertEqual(self.backend.truncation_lengths, [512])
        self.assertEqual(len(self.backend.runs), 1, "warmup must execute a model run")
        self.assertEqual(self.backend.runs[0]["output_shape"], (1, 3, 512))

    def test_selfcheck_runs_production_numeric_checks(self):
        before = len(self.backend.runs)
        result = embed.selfcheck(
            str(self.directory / "public-synthetic.db"), self.environment)
        self.assertTrue(result["ok"], result)
        self.assertEqual(result["reason"], "ok")
        self.assertEqual(len(result["checks"]), 4)
        for name, passed, note in result["checks"]:
            self.assertTrue(passed, "%s: %s" % (name, note))
        self.assertEqual(len(self.backend.runs) - before, 2)
        self.assertEqual([run["output_shape"][0] for run in self.backend.runs[before:]], [2, 1])

    def test_cls_pooling_normalization_and_padded_batches(self):
        before = len(self.backend.runs)
        vectors = embed.embed(["fixture-alpha", "fixture-beta", "fixture-alpha"], batch=2)
        self.assertEqual(vectors.shape, (3, 512))
        self.assertEqual(vectors.dtype, "float32")
        rows = vectors.tolist()
        # L2([3,4])=5 and L2([0,5,12])=13, independent of the adapter's norm().
        self.assertAlmostEqual(rows[0][0], 0.6, places=12)
        self.assertAlmostEqual(rows[0][1], 0.8, places=12)
        self.assertEqual(rows[0][2:], [0.0] * 510)
        self.assertEqual(rows[1][0], 0.0)
        self.assertAlmostEqual(rows[1][1], 5.0 / 13.0, places=12)
        self.assertAlmostEqual(rows[1][2], 12.0 / 13.0, places=12)
        self.assertEqual(rows[1][3:], [0.0] * 509)
        self.assertEqual(rows[2], rows[0])
        for row in rows:
            self.assertAlmostEqual(math.fsum(value * value for value in row), 1.0, places=12)
        runs = self.backend.runs[before:]
        self.assertEqual([run["output_shape"] for run in runs], [(2, 4, 512), (1, 3, 512)])
        self.assertEqual(runs[0]["feeds"]["input_ids"][0].tolist(), [11, 101, 102, 0])
        self.assertEqual(runs[0]["feeds"]["attention_mask"][0].tolist(), [1, 1, 1, 0])

    def test_embeddings_are_deterministic_across_batching_and_order(self):
        first = embed.embed(["fixture-alpha", "fixture-beta"], batch=1).tolist()
        second = embed.embed(["fixture-alpha", "fixture-beta"], batch=2).tolist()
        reversed_rows = embed.embed(["fixture-beta", "fixture-alpha"], batch=2).tolist()
        self.assertEqual(first, second)
        self.assertEqual(first, list(reversed(reversed_rows)))
        self.assertNotEqual(first[0], first[1])
        self.assertAlmostEqual(first[0][0], 0.6, places=12)
        self.assertAlmostEqual(first[1][2], 12.0 / 13.0, places=12)

    def test_empty_inputs_return_empty_matrix_without_inference(self):
        runs_before = len(self.backend.runs)
        batches_before = len(self.backend.batch_texts)
        for texts in ([], (), iter(())):
            vectors = embed.embed(texts)
            self.assertEqual(vectors.shape, (0, 512))
            self.assertEqual(vectors.dtype, "float32")
            self.assertEqual(vectors.tolist(), [])
        self.assertEqual(len(self.backend.runs), runs_before)
        self.assertEqual(len(self.backend.batch_texts), batches_before)
