"""Read-only immutable SQLite export reader for isolated retrieval fixtures.

This module is deliberately not imported by the worker or formal retrieval.
The host owns receipt creation; this reader only verifies and reads an export.
"""
from __future__ import annotations

import hashlib
import json
import math
import sqlite3
import struct
from pathlib import Path
from urllib.parse import quote

PROTOCOL = "echo-memory-snapshot/v1"
KINDS = frozenset(("immutable_export", "backup_export"))
MAX_ROWS = 4096  # Whole-table receipt budget, not a retrieval or traversal limit.
MAX_BYTES = 64 * 1024 * 1024
MAX_LOGICAL_BYTES = 32 * 1024 * 1024
MAX_SCHEMA_OBJECTS = 512
MAX_SAFE_INTEGER = (1 << 53) - 1
RECEIPT_FIELDS = (
    "protocol", "kind", "tokenHash", "schemaHash", "contentHash",
    "ownerHash", "turnHash", "attemptHash",
)
TABLES = (
    "episodic_memory",
    "memory_consolidation_graph_nodes",
    "memory_consolidation_memory_links",
    "memory_consolidation_traffic_links",
    "memory_consolidation_meta",
)


class SnapshotExportError(Exception):
    """A source export cannot be trusted as an immutable read snapshot."""


def _fail(reason):
    raise SnapshotExportError(reason)


def _json(value):
    try:
        return json.dumps(value, ensure_ascii=False, separators=(",", ":"),
                          sort_keys=True, allow_nan=False)
    except (TypeError, ValueError, OverflowError):
        _fail("invalid_receipt")


def canonical_json_bytes(value):
    """Canonical UTF-8 JSON bytes shared by JS/Python receipt producers."""
    try:
        return json.dumps(value, ensure_ascii=False, separators=(",", ":"),
                          sort_keys=True, allow_nan=False).encode("utf-8")
    except (TypeError, ValueError, OverflowError):
        _fail("invalid_receipt")


def canonical_digest(value):
    return hashlib.sha256(canonical_json_bytes(value)).hexdigest()


def _sha_bytes(value):
    return hashlib.sha256(value).hexdigest()


def _sha_json(value):
    return hashlib.sha256(_json(value).encode("utf-8")).hexdigest()


def _hash(value, name):
    if not isinstance(value, str) or len(value) != 64:
        _fail("invalid_" + name)
    if value == "0" * 64:
        _fail("invalid_" + name)
    try:
        int(value, 16)
    except ValueError:
        _fail("invalid_" + name)
    return value


def _text(value, name, maximum=128):
    if not isinstance(value, str) or not value or len(value) > maximum:
        _fail("invalid_" + name)
    return value


def _validate_receipt(receipt):
    if not isinstance(receipt, dict):
        _fail("invalid_receipt")
    if set(receipt) != set(RECEIPT_FIELDS):
        _fail("invalid_receipt")
    if receipt["protocol"] != PROTOCOL or receipt["kind"] not in KINDS:
        _fail("invalid_receipt")
    return {
        "protocol": PROTOCOL,
        "kind": receipt["kind"],
        "tokenHash": _hash(receipt["tokenHash"], "token_hash"),
        "schemaHash": _hash(receipt["schemaHash"], "schema_hash"),
        "contentHash": _hash(receipt["contentHash"], "content_hash"),
        "ownerHash": _hash(receipt["ownerHash"], "owner_hash"),
        "turnHash": _hash(receipt["turnHash"], "turn_hash"),
        "attemptHash": _hash(receipt["attemptHash"], "attempt_hash"),
    }


def _sidecars(path):
    return [candidate for candidate in (
        Path(str(path) + "-wal"), Path(str(path) + "-shm"),
        Path(str(path) + "-journal"),
    ) if candidate.exists()]


def _schema_digest(conn):
    digest = hashlib.sha256(b"[")
    logical_bytes = 2
    names = set()
    for i, (kind, name, sql) in enumerate(conn.execute(
        "SELECT type,name,sql FROM sqlite_master "
        "WHERE type IN ('table','index','trigger','view') ORDER BY type,name LIMIT ?",
        (MAX_SCHEMA_OBJECTS + 1,),
    )):
        if i >= MAX_SCHEMA_OBJECTS:
            _fail("export_budget_exceeded")
        encoded = canonical_json_bytes({"type": kind, "name": name, "sql": sql})
        logical_bytes += len(encoded) + (1 if i else 0)
        if logical_bytes > MAX_LOGICAL_BYTES:
            _fail("export_budget_exceeded")
        if i:
            digest.update(b",")
        digest.update(encoded)
        if kind == "table":
            names.add(name)
    digest.update(b"]")
    return digest.hexdigest(), logical_bytes, names


def _table_rows(conn, table, limit=MAX_ROWS):
    if table not in TABLES:
        _fail("schema_mismatch")
    rows = conn.execute(
        f'SELECT * FROM "{table}" ORDER BY rowid LIMIT ?', (limit + 1,)
    )
    for i, row in enumerate(rows):
        if i >= limit:
            _fail("row_budget_exceeded")
        yield dict(row)


def _content_projection(conn, limits):
    return {
        table: list(_table_rows(conn, table, limits["rows"]))
        for table in TABLES
    }


def _encode_content_cell(value):
    if value is None or type(value) is str:
        return value
    if type(value) is int and abs(value) <= MAX_SAFE_INTEGER:
        return value
    if type(value) is float and math.isfinite(value):
        if (abs(value) <= MAX_SAFE_INTEGER and value.is_integer()
                and (value != 0 or math.copysign(1, value) > 0)):
            return int(value)
        return ["f64", struct.pack(">d", value).hex()]
    # Unsupported SQLite values (BLOB, non-finite REAL, unsafe INTEGER) fail closed.
    _fail("export_budget_exceeded")


def snapshot_content_digest(tables, *, schema_bytes=0):
    """Hash bounded (table, rows) pairs in TABLES order, matching the JS exporter."""
    digest = hashlib.sha256()
    logical_bytes = schema_bytes

    def append(fragment):
        nonlocal logical_bytes
        logical_bytes += len(fragment)
        if logical_bytes > MAX_LOGICAL_BYTES:
            _fail("export_budget_exceeded")
        digest.update(fragment)

    append(b"[")
    separator = b""
    for table, rows in tables:
        append(separator + b"[" + canonical_json_bytes(table) + b",[")
        for i, row in enumerate(rows):
            if i:
                append(b",")
            # Keep numeric-looking column names in the same UTF-16 order as JS.
            append(canonical_json_bytes([
                [key, _encode_content_cell(row[key])]
                for key in sorted(row, key=lambda key: key.encode("utf-16-be"))
            ]))
        append(b"]]")
        separator = b","
    append(b"]")
    return digest.hexdigest()


def _connect_immutable(path):
    uri = "file:" + quote(str(path.resolve()), safe="/:\\") + "?mode=ro&immutable=1"
    try:
        conn = sqlite3.connect(uri, uri=True)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA query_only=ON")
        if conn.execute("PRAGMA query_only").fetchone()[0] != 1:
            conn.close()
            _fail("query_only_unavailable")
        return conn
    except SnapshotExportError:
        raise
    except (OSError, sqlite3.Error):
        _fail("corrupt_export")


def open_snapshot_export(path, receipt, *, max_rows=MAX_ROWS):
    """Open and verify an immutable export, returning a private reader handle."""
    receipt = _validate_receipt(receipt)
    path = Path(path)
    if not path.is_file():
        _fail("export_missing")
    if path.stat().st_size <= 0 or path.stat().st_size > MAX_BYTES:
        _fail("export_budget")
    if _sidecars(path):
        _fail("sidecar_incomplete")
    try:
        raw = path.read_bytes()
    except OSError:
        _fail("export_unreadable")
    if _sha_bytes(raw) != receipt["tokenHash"]:
        _fail("token_mismatch")
    if not isinstance(max_rows, int) or max_rows < 1 or max_rows > MAX_ROWS:
        _fail("row_budget_exceeded")
    conn = _connect_immutable(path)
    try:
        try:
            integrity = conn.execute("PRAGMA integrity_check").fetchone()[0]
        except sqlite3.Error:
            _fail("corrupt_export")
        if integrity != "ok":
            _fail("corrupt_export")
        schema_hash, schema_bytes, names = _schema_digest(conn)
        if not set(TABLES).issubset(names):
            _fail("schema_mismatch")
        if schema_hash != receipt["schemaHash"]:
            _fail("schema_mismatch")
        limits = {"rows": max_rows}
        tables = ((table, _table_rows(conn, table, max_rows)) for table in TABLES)
        if snapshot_content_digest(tables, schema_bytes=schema_bytes) != receipt["contentHash"]:
            _fail("content_mismatch")
        return {
            "connection": conn,
            "receipt": receipt,
            "limits": limits,
            "status": "ready",
        }
    except Exception:
        conn.close()
        raise


def read_bounded_rows(handle):
    """Read only the fixed episodic/Traffic tables from a verified handle."""
    if not isinstance(handle, dict) or handle.get("status") != "ready":
        _fail("snapshot_not_ready")
    conn = handle.get("connection")
    limits = handle.get("limits")
    if not isinstance(conn, sqlite3.Connection) or not isinstance(limits, dict):
        _fail("snapshot_not_ready")
    return _content_projection(conn, limits)


def receipt_summary(handle):
    """Return an opaque public summary; no raw token, SQL, path, or rows."""
    if not isinstance(handle, dict) or handle.get("status") != "ready":
        return {
            "status": "no-go",
            "reason": "snapshot_not_ready",
            "kind": None,
            "tokenHash": None,
            "schemaHash": None,
            "contentHash": None,
            "ownerHash": None,
            "turnHash": None,
            "attemptHash": None,
        }
    receipt = handle["receipt"]
    return {
        "status": "ready",
        "reason": None,
        "kind": receipt["kind"],
        "tokenHash": receipt["tokenHash"],
        "schemaHash": receipt["schemaHash"],
        "contentHash": receipt["contentHash"],
        "ownerHash": receipt["ownerHash"],
        "turnHash": receipt["turnHash"],
        "attemptHash": receipt["attemptHash"],
    }


def close_snapshot_export(handle):
    conn = handle.get("connection") if isinstance(handle, dict) else None
    if isinstance(conn, sqlite3.Connection):
        conn.close()
