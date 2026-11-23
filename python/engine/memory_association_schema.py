"""Read-only S4c2 profile dependencies. No association writer or preparation API."""
from .memory_strength_events import TABLES as STRENGTH_TABLES, inspect_memory_strength_prepared, rows
from .memory_body_transactions import TABLE as BODY_TABLE, COLUMNS as BODY_COLUMNS

ASSOCIATION_COLUMNS = [
    ("round_id", "TEXT", 1, 0), ("protocol", "TEXT", 0, 1), ("epoch", "TEXT", 0, 1),
    ("request_hash", "TEXT", 0, 1), ("result_json", "TEXT", 0, 1), ("result_hash", "TEXT", 0, 1),
]
USE_COLUMNS = {
    "memory_association_use_receipts": [
        ("round_id", "TEXT", 1, 0), ("payload_hash", "TEXT", 0, 1), ("evidence_status", "TEXT", 0, 1),
        ("channel", "TEXT", 0, 1), ("used_at_ms", "REAL", 0, 1),
        ("memory_count", "INTEGER", 0, 1), ("unit_count", "INTEGER", 0, 1)],
    "memory_association_use_events": [
        ("round_id", "TEXT", 1, 1), ("unit_kind", "TEXT", 2, 1), ("unit_id", "TEXT", 3, 1)],
    "memory_association_use_state": [
        ("unit_kind", "TEXT", 1, 1), ("unit_id", "TEXT", 2, 1), ("use_count", "INTEGER", 0, 1),
        ("last_used_ms", "REAL", 0, 1), ("half_life_hours", "REAL", 0, 0)],
    "memory_association_use_failures": [
        ("failure_id", "INTEGER", 1, 0), ("round_id", "TEXT", 0, 0),
        ("reason", "TEXT", 0, 1), ("failed_at_ms", "REAL", 0, 1)],
    "memory_association_traffic_strength": [
        ("link_id", "TEXT", 1, 0), ("intrinsic_value", "REAL", 0, 1), ("weight", "REAL", 0, 1),
        ("model_started_ms", "REAL", 0, 1), ("initialization", "TEXT", 0, 1)],
}
SOURCE_COLUMNS = {
    "episodic_memory": [
        "memory_id", "user_id", "summary", "is_active", "status", "superseded_by", "intrinsic_value",
        "half_life", "recall_count", "last_recalled", "learned_at", "timestamp", "occurred_at",
        "temporal_status", "source", "source_label", "actor", "speaker_id", "is_master"],
    "memory_consolidation_graph_nodes": ["node_id", "canonical_name", "status", "superseded_by"],
    "memory_consolidation_memory_links": ["memory_id", "node_id", "link_id"],
    "memory_consolidation_traffic_links": ["link_id", "from_node_id", "to_node_id", "relation"],
    "memory_consolidation_meta": ["graph_version"],
    "memory_consolidation_receipts": ["batch_id"],
}
LOOKUPS = [
    ("memory_consolidation_traffic_links", "from_node_id", "echo_p3_lookup_traffic_from"),
    ("memory_consolidation_traffic_links", "to_node_id", "echo_p3_lookup_traffic_to"),
    ("memory_consolidation_memory_links", "node_id", "echo_p3_lookup_memory_node"),
]


def quote(value):
    return '"' + value.replace('"', '""') + '"'


def table_columns(db, table):
    objects = rows(db, "SELECT type FROM sqlite_master WHERE name=?", (table,))
    if len(objects) != 1 or objects[0]["type"] != "table":
        raise ValueError("association_schema_incompatible")
    return rows(db, f"PRAGMA table_xinfo({quote(table)})")


def strict_table(db, table, columns):
    actual = table_columns(db, table)
    if len(actual) != len(columns) or any(
            (r["name"], r["type"].upper(), r["pk"], r["notnull"]) != c
            or r["dflt_value"] is not None or r["hidden"] != 0 for r, c in zip(actual, columns)):
        raise ValueError("association_schema_incompatible")
    for column, typ, _, _ in columns:
        if typ == "TEXT":
            eq = [r for r in rows(db, f"EXPLAIN SELECT {quote(column)}=? FROM {quote(table)} LIMIT 1",
                                 ("association-probe",)) if r["opcode"] == "Eq"]
            if len(eq) != 1 or eq[0]["p4"] != "BINARY-8":
                raise ValueError("association_schema_incompatible")
    primary = sorted((c for c in columns if c[2]), key=lambda c: c[2])
    indexes = rows(db, f"PRAGMA index_list({quote(table)})")
    if len(primary) == 1 and primary[0][1] == "INTEGER":
        if any(index["origin"] == "pk" for index in indexes):
            raise ValueError("association_schema_incompatible")
        return
    for index in indexes:
        if index["origin"] != "pk" or index["partial"]:
            continue
        keys = [r for r in rows(db, f'PRAGMA index_xinfo({quote(index["name"])})') if r["key"] == 1]
        if len(keys) == len(primary) and all(
                key["name"] == column[0] and key["coll"] == "BINARY" for key, column in zip(keys, primary)):
            return
    raise ValueError("association_schema_incompatible")


def binary_leading(db, index, column):
    return not index["partial"] and any(
        r["seqno"] == 0 and r["key"] == 1 and r["name"] == column and r["coll"] == "BINARY"
        for r in rows(db, f'PRAGMA index_xinfo({quote(index["name"])})'))


def inspect_memory_association_prepared(db):
    strength = inspect_memory_strength_prepared(db)
    if strength["status"] != "ready":
        return {"status": "unavailable", "reason": "association_schema_unprepared"}
    try:
        # Existing old-profile inspectors use table_info; the new profile also rejects generated columns.
        for table, (_, columns) in STRENGTH_TABLES.items():
            strict_table(db, table, columns)
        strict_table(db, BODY_TABLE, BODY_COLUMNS)
        strict_table(db, "memory_association_strength_receipts", ASSOCIATION_COLUMNS)
        for table, columns in USE_COLUMNS.items():
            strict_table(db, table, columns)
        for table, columns in SOURCE_COLUMNS.items():
            actual = {r["name"] for r in table_columns(db, table) if r["hidden"] == 0}
            if not set(columns) <= actual:
                raise ValueError("association_schema_incompatible")
        for table, column, name in LOOKUPS:
            indexes = rows(db, f"PRAGMA index_list({quote(table)})")
            named = rows(db, "SELECT tbl_name FROM sqlite_master WHERE type='index' AND name=?", (name,))
            if named and (named[0]["tbl_name"] != table or not any(
                    i["name"] == name and binary_leading(db, i, column) for i in indexes)):
                raise ValueError("association_schema_incompatible")
            if not any(binary_leading(db, i, column) for i in indexes):
                raise ValueError("association_schema_incompatible")
        return {"status": "ready", "epoch": strength["epoch"], "reason": None}
    except ValueError:
        return {"status": "incompatible", "reason": "association_schema_incompatible"}
    except Exception:
        return {"status": "unavailable", "reason": "association_schema_unavailable"}
