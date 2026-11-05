"""Public reconciliation contracts over a small, entirely invented snapshot.

The expected pair inventories are handwritten in fixtures/public-contracts/README.md.
These tests do not reproduce, open, or depend on a historical/private snapshot.
"""
import hashlib
from pathlib import Path
import sqlite3
import sys
import tempfile
import time
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from engine import graph_gate as gate, graph_mine as mine


SYNTHETIC_NAMES = {
    "speakers": ["Speaker-Synthetic"],
    "personNames": ["Speaker-Synthetic"],
}


def _fixture_timestamp(day, hour):
    """Use midday local dates so the inventory is independent of host timezone."""
    return time.mktime((2024, 2, day, hour, 0, 0, 0, 0, -1))


def _seed_public_snapshot(path):
    """Create only the documented read interface, inside the caller's temp dir."""
    conn = sqlite3.connect(str(path))
    try:
        conn.executescript("""
            CREATE TABLE graph_nodes (
                node_id TEXT PRIMARY KEY, name TEXT NOT NULL, node_type TEXT NOT NULL
            );
            CREATE TABLE graph_aliases (alias TEXT, canonical_name TEXT);
            CREATE TABLE episodic_memory (
                memory_id INTEGER PRIMARY KEY, summary TEXT, timestamp REAL,
                occurred_at REAL, is_active INTEGER, status TEXT
            );
            CREATE TABLE graph_edges (
                source_id TEXT, target_id TEXT, relation TEXT,
                owner_key TEXT, is_active INTEGER, kind TEXT
            );
        """)
        conn.executemany("INSERT INTO graph_nodes VALUES (?, ?, ?)", [
            ("a-speaker", "Speaker-Synthetic", "concept"),
            ("b-alpha", "Quartz-Alpha", "concept"),
            ("c-beta", "Quartz-Beta", "concept"),
            ("d-gamma", "Quartz-Gamma", "concept"),
            ("e-alias", "Alias-Alpha", "concept"),
            ("f-episode", "EpisodeOnly", "episode"),
        ])
        conn.execute("INSERT INTO graph_aliases VALUES (?, ?)",
                     ("Alias-Alpha", "Quartz-Alpha"))
        conn.executemany("INSERT INTO episodic_memory VALUES (?, ?, ?, ?, ?, ?)", [
            (11, "Speaker-Synthetic Quartz-Alpha Quartz-Beta",
             _fixture_timestamp(4, 10), 101.0, 1, "active"),
            (12, "Quartz-Gamma", _fixture_timestamp(4, 11), 102.0, 1, "active"),
            (13, "Alias-Alpha EpisodeOnly",
             _fixture_timestamp(4, 12), 103.0, 1, "active"),
            (21, "Quartz-Alpha", _fixture_timestamp(5, 10), 201.0, 1, "active"),
            (22, "Quartz-Beta Quartz-Gamma",
             _fixture_timestamp(5, 11), 202.0, 1, "active"),
            (31, "Speaker-Synthetic Quartz-Alpha Quartz-Beta Quartz-Gamma",
             _fixture_timestamp(6, 10), 301.0, 0, "active"),
            (32, "Speaker-Synthetic Quartz-Alpha Quartz-Beta Quartz-Gamma",
             _fixture_timestamp(6, 11), 302.0, 1, "archived"),
            (33, None, _fixture_timestamp(6, 12), 303.0, 1, "active"),
            (34, "", _fixture_timestamp(6, 13), 304.0, 1, "active"),
        ])
        conn.executemany("INSERT INTO graph_edges VALUES (?, ?, ?, ?, ?, ?)", [
            ("a-speaker", "b-alpha", "fixture-speaks-to", "public-owner", 1, "fact"),
            ("b-alpha", "c-beta", "同日共现", "", 1, "cooccur_same_day"),
            ("c-beta", "d-gamma", "fixture-related", "", 1, "fact"),
            ("a-speaker", "d-gamma", "fixture-inactive", "", 0, "fact"),
        ])
        conn.commit()
    finally:
        conn.close()


class PublicGraphReconciliation(unittest.TestCase):
    """Five new synthetic cases; the manual historical controls stay separate."""

    def setUp(self):
        directory = tempfile.TemporaryDirectory(prefix="echo-public-graph-contract-")
        self.addCleanup(directory.cleanup)
        self.directory = Path(directory.name).resolve()
        self.path = self.directory / "public-synthetic-snapshot.db"
        _seed_public_snapshot(self.path)

    def _report(self, kind, names=SYNTHETIC_NAMES):
        return mine.dry_run(str(self.path), kinds=(kind,), names=names)

    def _candidates_and_context(self, kind):
        connection = sqlite3.connect(self.path.as_uri() + "?mode=ro", uri=True)
        try:
            candidates = mine.candidates_for_history(connection, kinds=(kind,))
            context = gate.build_context_from_db(
                connection, speakers=SYNTHETIC_NAMES["speakers"],
                person_names=SYNTHETIC_NAMES["personNames"])
            return candidates, context
        finally:
            connection.close()

    def test_same_day_fixture_counts_and_kind_aware_r2(self):
        # Day 4 has S/A/B/C: SA, SB, SC, AB, AC, BC. Day 5 repeats AB/AC/BC.
        report = self._report(mine.KIND_SAME_DAY)
        self.assertEqual(report["candidates"], 6)
        self.assertEqual(report["candidates_by_kind"], {"cooccur_same_day": 6})
        self.assertEqual(report["speaker_node_excluded_contract_flag"], 3)
        self.assertEqual(report["r1_excluded"], 3)
        self.assertEqual(report["counters"]["reasons"], {"speaker-node": 3})
        self.assertEqual(report["would_write"], 3)
        self.assertEqual(report["r2_checked"], 3)
        self.assertEqual(report["r2_hit_zero_overlap_dropped"], 0)
        self.assertEqual(report["lenient_same_day"]["would_write"], 3)
        # Three active edges, two without S; AB already occupies the same-day slot.
        merged = report["merged_view"]
        self.assertEqual(merged["active_edges_before"], 3)
        self.assertEqual(merged["active_edges_without_speaker_before"], 2)
        self.assertEqual(merged["active_edges_after"], 5)
        self.assertEqual(merged["active_edges_without_speaker_after"], 4)
        self.assertEqual(merged["slot_row_collisions_with_existing"], 1)

        candidates, context = self._candidates_and_context(mine.KIND_SAME_DAY)
        self.assertEqual(
            {(item["source_id"], item["target_id"]) for item in candidates},
            {("a-speaker", "b-alpha"), ("a-speaker", "c-beta"),
             ("a-speaker", "d-gamma"), ("b-alpha", "c-beta"),
             ("b-alpha", "d-gamma"), ("c-beta", "d-gamma")})
        cross_memory = next(item for item in candidates
                            if (item["source_id"], item["target_id"])
                            == ("b-alpha", "d-gamma"))
        self.assertEqual(cross_memory["source_memory_ids"], [11, 21])
        self.assertEqual(cross_memory["target_memory_ids"], [12, 22])
        self.assertEqual(cross_memory["count"], 2)
        self.assertEqual(cross_memory["day"], "2024-02-05")
        self.assertTrue(gate.gate_edge(cross_memory, context, enabled=True)["accepted"])
        empty_side = dict(cross_memory, target_memory_ids=[])
        verdict = gate.gate_edge(empty_side, context, enabled=True)
        self.assertEqual((verdict["action"], verdict["reason"]), ("drop", "zero-overlap"))

    def test_same_memory_fixture_exclusion_and_strict_r2(self):
        # Memory 11 contributes SA/SB/AB; memory 22 contributes BC, all distinct.
        report = self._report(mine.KIND_SAME_MEMORY)
        self.assertEqual(report["candidates"], 4)
        self.assertEqual(report["speaker_node_excluded_contract_flag"], 2)
        self.assertEqual(report["r1_excluded"], 2)
        self.assertEqual(report["counters"]["reasons"], {"speaker-node": 2})
        self.assertEqual(report["would_write"], 2)
        self.assertEqual(report["would_write_by_kind"], {"cooccur_same_memory": 2})
        self.assertEqual(report["r2_self_test"],
                         {"ran": True, "dropped": True, "reason": "zero-overlap"})
        candidates, context = self._candidates_and_context(mine.KIND_SAME_MEMORY)
        self.assertEqual(
            {(item["source_id"], item["target_id"]) for item in candidates},
            {("a-speaker", "b-alpha"), ("a-speaker", "c-beta"),
             ("b-alpha", "c-beta"), ("c-beta", "d-gamma")})
        alpha_beta = next(item for item in candidates
                          if (item["source_id"], item["target_id"])
                          == ("b-alpha", "c-beta"))
        self.assertEqual(alpha_beta["evidence_memory_id"], [11])
        disjoint = dict(alpha_beta, target_memory_ids=[88])
        verdict = gate.gate_edge(disjoint, context, enabled=True)
        self.assertEqual((verdict["action"], verdict["reason"]), ("drop", "zero-overlap"))
        # Existing AB is same-day, so it does not collide with a same-memory pair.
        self.assertEqual(report["merged_view"]["active_edges_after"], 5)
        self.assertEqual(report["merged_view"]["slot_row_collisions_with_existing"], 0)

    def test_speaker_names_are_explicit_and_absent_names_are_neutral(self):
        named = self._report(mine.KIND_SAME_MEMORY)
        explicit_none = self._report(mine.KIND_SAME_MEMORY, names=None)
        absent = mine.dry_run(str(self.path), kinds=(mine.KIND_SAME_MEMORY,))
        self.assertEqual(named["r1_excluded"], 2)
        self.assertEqual(named["would_write"], 2)
        for neutral in (explicit_none, absent):
            self.assertEqual(neutral["candidates"], 4)
            self.assertEqual(neutral["speaker_node_excluded_contract_flag"], 0)
            self.assertEqual(neutral["r1_excluded"], 0)
            self.assertEqual(neutral["would_write"], 4)
            self.assertEqual(neutral["counters"]["reasons"], {})

    def test_bad_name_shapes_and_list_comma_equivalence(self):
        for bad in (None, 5, "not-an-object", {"speakers": 7},
                    {"personNames": []}, {"speakers": [], "personNames": 7}):
            with self.subTest(names=bad):
                neutral = self._report(mine.KIND_SAME_MEMORY, names=bad)
                self.assertEqual(neutral["candidates"], 4)
                self.assertEqual(neutral["r1_excluded"], 0)
                self.assertEqual(neutral["would_write"], 4)
        # A malformed personNames half does not discard the valid speakers half.
        partial = self._report(
            mine.KIND_SAME_MEMORY,
            names={"speakers": ["Speaker-Synthetic"], "personNames": None})
        self.assertEqual(partial["r1_excluded"], 2)
        self.assertEqual(partial["would_write"], 2)
        listed = self._report(mine.KIND_SAME_MEMORY)
        comma = self._report(
            mine.KIND_SAME_MEMORY,
            names={"speakers": " Speaker-Synthetic, ",
                   "personNames": "Speaker-Synthetic"})
        self.assertEqual(comma, listed)

    def test_nonempty_snapshot_bytes_and_rows_are_preserved(self):
        before = {path.name: path.read_bytes() for path in self.directory.iterdir()}
        digest = hashlib.sha256(before[self.path.name]).hexdigest()
        report = mine.dry_run(str(self.path), names=SYNTHETIC_NAMES)
        self.assertEqual(report["candidates"], 10)  # Four same-memory + six same-day.
        self.assertEqual(report["r1_excluded"], 5)  # Two + three speaker pairs.
        self.assertEqual(report["would_write"], 5)
        self.assertEqual(report["merged_view"]["active_edges_after"], 7)
        self.assertEqual(report["merged_view"]["active_edges_without_speaker_after"], 6)
        after = {path.name: path.read_bytes() for path in self.directory.iterdir()}
        self.assertEqual(after, before, "dry-run changed bytes or created a sidecar")
        self.assertEqual(hashlib.sha256(self.path.read_bytes()).hexdigest(), digest)
        connection = sqlite3.connect(self.path.as_uri() + "?mode=ro", uri=True)
        try:
            self.assertEqual(connection.execute("SELECT COUNT(*) FROM graph_nodes").fetchone()[0], 6)
            self.assertEqual(connection.execute("SELECT COUNT(*) FROM graph_edges").fetchone()[0], 4)
            self.assertEqual(connection.execute(
                "SELECT COUNT(*) FROM episodic_memory").fetchone()[0], 9)
        finally:
            connection.close()
