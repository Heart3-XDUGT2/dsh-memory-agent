"""Strict, read-only schema gates for A1-S4d extract receipts."""

from .memory_strength_events import rows, text

EXTRACT_REQUEST_TABLE = "memory_extract_requests"
EXTRACT_STAGE_TABLE = "memory_extract_stage_receipts"
EXTRACT_ACK_TABLE = "memory_extract_ack_receipts"
EXTRACT_TABLES = {
    EXTRACT_REQUEST_TABLE: [
        ("request_hash", "TEXT", 1, 0),
        ("protocol", "TEXT", 0, 1),
        ("epoch", "TEXT", 0, 1),
        ("generation", "INTEGER", 0, 1),
        ("source_identity", "TEXT", 0, 1),
        ("payload_hash", "TEXT", 0, 1),
        ("status", "TEXT", 0, 1),
        ("created_at_ms", "INTEGER", 0, 1),
        ("result_hash", "TEXT", 0, 0),
    ],
    EXTRACT_STAGE_TABLE: [
        ("request_hash", "TEXT", 1, 1),
        ("stage", "TEXT", 2, 1),
        ("action_key", "TEXT", 3, 1),
        ("payload_hash", "TEXT", 0, 1),
        ("status", "TEXT", 0, 1),
        ("result_json", "TEXT", 0, 1),
        ("error_code", "TEXT", 0, 0),
        ("applied_at_ms", "INTEGER", 0, 1),
    ],
    EXTRACT_ACK_TABLE: [
        ("request_hash", "TEXT", 1, 0),
        ("result_hash", "TEXT", 0, 1),
        ("status", "TEXT", 0, 1),
        ("ack_json", "TEXT", 0, 1),
        ("stage_summary_json", "TEXT", 0, 1),
        ("applied_at_ms", "INTEGER", 0, 1),
        ("stale_skipped", "INTEGER", 0, 1),
    ],
}
EXTRACT_DDL = {
    EXTRACT_REQUEST_TABLE: (
        "request_hash TEXT PRIMARY KEY,protocol TEXT NOT NULL,epoch TEXT NOT NULL,"
        "generation INTEGER NOT NULL,source_identity TEXT NOT NULL,payload_hash TEXT NOT NULL,"
        "status TEXT NOT NULL,created_at_ms INTEGER NOT NULL,result_hash TEXT"),
    EXTRACT_STAGE_TABLE: (
        "request_hash TEXT NOT NULL,stage TEXT NOT NULL,action_key TEXT NOT NULL,"
        "payload_hash TEXT NOT NULL,status TEXT NOT NULL,result_json TEXT NOT NULL,"
        "error_code TEXT,applied_at_ms INTEGER NOT NULL,"
        "PRIMARY KEY(request_hash,stage,action_key)"),
    EXTRACT_ACK_TABLE: (
        "request_hash TEXT PRIMARY KEY,result_hash TEXT NOT NULL,status TEXT NOT NULL,"
        "ack_json TEXT NOT NULL,stage_summary_json TEXT NOT NULL,applied_at_ms INTEGER NOT NULL,"
        "stale_skipped INTEGER NOT NULL"),
}
EXTRACT_PROTOCOL = "echo-memory-extract/v1"
EXTRACT_STATUSES = frozenset(("started", "partial", "committed", "failed", "unknown"))
STAGE_STATUSES = frozenset(("pending", "committed", "duplicate", "failed", "unknown"))


def _quote(value):
    return '"' + value.replace('"', '""') + '"'


def _strict_table(db, table, columns):
    objects = rows(db, "SELECT type FROM sqlite_master WHERE name=?", (table,))
    if len(objects) != 1 or objects[0]["type"] != "table":
        return False
    actual = rows(db, f"PRAGMA table_xinfo({_quote(table)})")
    if len(actual) != len(columns):
        return False
    if any((row["name"], row["type"].upper(), row["pk"], row["notnull"]) != expected
           or row["dflt_value"] is not None or row["hidden"] != 0
           for row, expected in zip(actual, columns)):
        return False
    for column, typ, _, _ in columns:
        if typ != "TEXT":
            continue
        comparisons = [row for row in rows(
            db, f'EXPLAIN SELECT {_quote(column)}=? FROM {_quote(table)} LIMIT 1',
            ("extract-schema-probe",)) if row["opcode"] == "Eq"]
        if len(comparisons) != 1 or comparisons[0]["p4"] != "BINARY-8":
            return False
    primary = sorted((column for column in columns if column[2]), key=lambda value: value[2])
    for index in rows(db, f"PRAGMA index_list({_quote(table)})"):
        if index["origin"] != "pk" or index["partial"]:
            continue
        keys = [row for row in rows(
            db, f"PRAGMA index_xinfo({_quote(index['name'])})") if row["key"] == 1]
        if len(keys) == len(primary) and all(
                key["name"] == column[0] and key["coll"] == "BINARY"
                for key, column in zip(keys, primary)):
            return True
    return False


def inspect_memory_extract_schema(db):
    """Read-only exact schema check. Never creates or repairs tables."""
    try:
        for table, columns in EXTRACT_TABLES.items():
            if not _strict_table(db, table, columns):
                return {"status": "incompatible", "reason": "extract_schema_incompatible"}
        request_statuses = {row[0] for row in db.execute(
            f"SELECT status FROM {EXTRACT_REQUEST_TABLE}").fetchall()}
        if not request_statuses <= EXTRACT_STATUSES:
            return {"status": "incompatible", "reason": "extract_schema_invalid_status"}
        stage_statuses = {row[0] for row in db.execute(
            f"SELECT status FROM {EXTRACT_STAGE_TABLE}").fetchall()}
        if not stage_statuses <= STAGE_STATUSES:
            return {"status": "incompatible", "reason": "extract_schema_invalid_status"}
        if db.execute(
                f"SELECT 1 FROM {EXTRACT_ACK_TABLE} WHERE stale_skipped NOT IN (0,1) "
                "OR applied_at_ms < 1 LIMIT 1").fetchone():
            return {"status": "incompatible", "reason": "extract_schema_invalid_status"}
        return {"status": "ready", "reason": None}
    except Exception:
        return {"status": "unavailable", "reason": "extract_schema_unavailable"}


def prepare_memory_extract_schema(db):
    """Explicit bootstrap only; caller must not already hold a transaction."""
    if not getattr(db, "execute", None):
        raise ValueError("extract_db_required")
    if db.in_transaction:
        raise ValueError("extract_transaction_already_open")
    db.execute("BEGIN IMMEDIATE")
    try:
        for table, ddl in EXTRACT_DDL.items():
            db.execute(f"CREATE TABLE IF NOT EXISTS {_quote(table)} ({ddl})")
        ready = inspect_memory_extract_schema(db)
        if ready["status"] != "ready":
            raise ValueError(ready["reason"])
        db.execute("COMMIT")
    except Exception:
        db.execute("ROLLBACK")
        raise


def require_extract_schema(db):
    ready = inspect_memory_extract_schema(db)
    if ready["status"] != "ready":
        raise ValueError(ready["reason"])
    return ready


def validate_identity(value, reason="extract_invalid_input"):
    try:
        return text(value)
    except Exception as error:
        raise ValueError(reason) from error
