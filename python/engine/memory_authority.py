"""Explicit A1 entry manifest. Inspection never initializes or activates it."""
import json
import re

from .memory_association_schema import inspect_memory_association_prepared
from .memory_extract_schema import inspect_memory_extract_schema
from .memory_body_transactions import inspect_memory_body_prepared
from .memory_retrieval_transactions import inspect_memory_retrieval_prepared
from .memory_strength_events import inspect_memory_strength_prepared, one, rows, text

MEMORY_AUTHORITY_PROTOCOL = "echo-memory-authority/v1"
SUPPORTED_ENTRIES = ["memory_add", "memory_retrieve", "memory_search", "memory_association", "memory_extract"]
ACTIVE_PROFILES = ['["memory_add"]', '["memory_add","memory_retrieve","memory_search"]',
                   '["memory_add","memory_retrieve","memory_search","memory_association"]',
                   '["memory_add","memory_retrieve","memory_search","memory_association","memory_extract"]']
TABLE = "memory_authority_control"
COLUMNS = [
    ("id", "INTEGER", 1, 0), ("protocol", "TEXT", 0, 1),
    ("strength_epoch", "TEXT", 0, 1), ("generation", "INTEGER", 0, 1),
    ("mode", "TEXT", 0, 1), ("enabled_entries", "TEXT", 0, 1),
    ("cutoff_at_ms", "INTEGER", 0, 1), ("archive_ref", "TEXT", 0, 1),
]
DDL = ("id INTEGER PRIMARY KEY CHECK(id=1),protocol TEXT NOT NULL,"
       "strength_epoch TEXT NOT NULL,generation INTEGER NOT NULL,mode TEXT NOT NULL,"
       "enabled_entries TEXT NOT NULL,cutoff_at_ms INTEGER NOT NULL,archive_ref TEXT NOT NULL")
MAX_SAFE = 9007199254740991


class AuthorityError(Exception):
    pass


def fail(reason):
    raise AuthorityError(reason)


def status(mode, *, epoch=None, generation=None, entries=None, cutoff=None, archive=None, reason=None):
    return {"status": mode, "protocol": MEMORY_AUTHORITY_PROTOCOL, "epoch": epoch,
            "generation": generation, "entries": entries or [], "cutoffAtMs": cutoff,
            "archiveRef": archive, "reason": reason}


def integer(value, minimum=0):
    return type(value) is int and minimum <= value <= MAX_SAFE


def inspect_memory_authority(db):
    try:
        objects = rows(db, "SELECT type FROM sqlite_master WHERE name=?", (TABLE,))
        if not objects:
            return status("legacy")
        if len(objects) != 1 or objects[0]["type"] != "table":
            fail("a1_authority_schema_invalid")
        actual = rows(db, f'PRAGMA table_info("{TABLE}")')
        if len(actual) != len(COLUMNS) or any(
                (r["name"], r["type"].upper(), r["pk"], r["notnull"]) != c
                or r["dflt_value"] is not None for r, c in zip(actual, COLUMNS)):
            fail("a1_authority_schema_invalid")
        # A descending INTEGER PK uses a separate index instead of the rowid alias.
        if any(r["origin"] == "pk" for r in rows(db, f'PRAGMA index_list("{TABLE}")')):
            fail("a1_authority_schema_invalid")
        for column, typ, _, _ in COLUMNS:
            if typ == "TEXT":
                comparisons = [r for r in rows(db, f'EXPLAIN SELECT "{column}"=? FROM "{TABLE}" LIMIT 1',
                                               ("authority-probe",)) if r["opcode"] == "Eq"]
                if len(comparisons) != 1 or comparisons[0]["p4"] != "BINARY-8":
                    fail("a1_authority_schema_invalid")
        records = rows(db, f"SELECT * FROM {TABLE} LIMIT 2")
        if len(records) != 1:
            fail("a1_authority_invalid")
        r = records[0]
        if (r["id"] != 1 or r["protocol"] != MEMORY_AUTHORITY_PROTOCOL
                or not integer(r["generation"], 1) or not integer(r["cutoff_at_ms"])):
            fail("a1_authority_invalid")
        try:
            text(r["strength_epoch"])
        except Exception:
            fail("a1_authority_invalid")
        if r["mode"] == "prepared":
            if r["enabled_entries"] != "[]" or r["cutoff_at_ms"] != 0 or r["archive_ref"] != "":
                fail("a1_authority_invalid")
            entries = []
        elif r["mode"] == "active":
            if (r["enabled_entries"] not in ACTIVE_PROFILES or not integer(r["cutoff_at_ms"], 1)
                    or type(r["archive_ref"]) is not str
                    or not re.fullmatch(r"[a-f0-9]{64}", r["archive_ref"])):
                fail("a1_authority_invalid")
            entries = json.loads(r["enabled_entries"])
        else:
            fail("a1_authority_invalid")
        for prepared in (inspect_memory_strength_prepared(db), inspect_memory_body_prepared(db)):
            if prepared["status"] != "ready":
                fail("a1_schema_unprepared")
            if prepared["epoch"] != r["strength_epoch"]:
                fail("a1_epoch_mismatch")
        if "memory_retrieve" in entries:
            prepared = inspect_memory_retrieval_prepared(db)
            if prepared["status"] != "ready":
                fail("a1_schema_unprepared")
            if prepared["epoch"] != r["strength_epoch"]:
                fail("a1_epoch_mismatch")
        if "memory_association" in entries:
            extended = rows(db, f'PRAGMA table_xinfo("{TABLE}")')
            if len(extended) != len(COLUMNS) or any(r["hidden"] != 0 for r in extended):
                fail("a1_authority_schema_invalid")
            prepared = inspect_memory_association_prepared(db)
            if prepared["status"] != "ready":
                fail("a1_schema_unprepared")
            if prepared["epoch"] != r["strength_epoch"]:
                fail("a1_epoch_mismatch")
        if "memory_extract" in entries:
            prepared = inspect_memory_extract_schema(db)
            if prepared["status"] != "ready":
                fail("a1_schema_unprepared")
        return status(r["mode"], epoch=r["strength_epoch"], generation=r["generation"],
                      entries=entries, cutoff=r["cutoff_at_ms"], archive=r["archive_ref"])
    except AuthorityError as error:
        return status("blocked", reason=str(error))
    except Exception:
        return status("blocked", reason="a1_authority_unavailable")


def prepare_memory_authority_schema(db, *, epoch):
    text(epoch)
    if db.in_transaction:
        fail("a1_transaction_already_open")
    db.execute("BEGIN IMMEDIATE")
    try:
        for prepared in (inspect_memory_strength_prepared(db), inspect_memory_body_prepared(db)):
            if prepared["status"] != "ready":
                fail("a1_schema_unprepared")
            if prepared["epoch"] != epoch:
                fail("a1_epoch_mismatch")
        current = inspect_memory_authority(db)
        if current["status"] == "legacy":
            db.execute(f'CREATE TABLE "{TABLE}" ({DDL})')
            db.execute(f"INSERT INTO {TABLE} VALUES (1,?,?,1,'prepared','[]',0,'')",
                       (MEMORY_AUTHORITY_PROTOCOL, epoch))
        elif current["status"] == "blocked":
            fail(current["reason"])
        elif current["epoch"] != epoch:
            fail("a1_epoch_mismatch")
        prepared = inspect_memory_authority(db)
        if prepared["status"] not in ("prepared", "active"):
            fail(prepared["reason"] or "a1_authority_invalid")
        db.execute("COMMIT")
        return prepared
    except Exception:
        db.execute("ROLLBACK")
        raise


def binding_matches(binding, authority):
    return (type(binding) is dict and set(binding) == {"protocol", "epoch", "generation"}
            and binding["protocol"] == MEMORY_AUTHORITY_PROTOCOL
            and binding["epoch"] == authority["epoch"]
            and integer(binding["generation"], 1) and binding["generation"] == authority["generation"])
