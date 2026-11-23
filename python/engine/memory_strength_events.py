"""Unbound A1-S1 synchronous events. Explicit prepare only; no native eligibility inference."""
import hashlib
import json
import math
import re
import sqlite3
import struct

from .dmae import DMAE_DEFAULT, initial_half_life, reinforce_half_life, retrievability

MEMORY_STRENGTH_PROTOCOL = "echo-memory-strength/v1"
MEMORY_STRENGTH_LIMITS = {"receipts": 1024, "batch": 8, "inputBytes": 16384, "idBytes": 128}
MAX_SAFE = 9007199254740991
TABLES = {
    "memory_strength_control": (
        "id INTEGER PRIMARY KEY CHECK(id=1),protocol TEXT NOT NULL,epoch TEXT NOT NULL,receipt_limit INTEGER NOT NULL",
        [("id", "INTEGER", 1, 0), ("protocol", "TEXT", 0, 1), ("epoch", "TEXT", 0, 1), ("receipt_limit", "INTEGER", 0, 1)]),
    "memory_strength_events": (
        "event_key TEXT PRIMARY KEY,payload_hash TEXT NOT NULL,epoch TEXT NOT NULL,kind TEXT NOT NULL,memory_id TEXT NOT NULL,"
        "occurred_at_ms INTEGER NOT NULL,admission_key TEXT NOT NULL,strength_applied INTEGER NOT NULL,"
        "half_life_after REAL NOT NULL,count_after INTEGER NOT NULL,last_after REAL NOT NULL,intrinsic_after REAL NOT NULL",
        [("event_key", "TEXT", 1, 0), ("payload_hash", "TEXT", 0, 1), ("epoch", "TEXT", 0, 1), ("kind", "TEXT", 0, 1),
         ("memory_id", "TEXT", 0, 1), ("occurred_at_ms", "INTEGER", 0, 1), ("admission_key", "TEXT", 0, 1),
         ("strength_applied", "INTEGER", 0, 1), ("half_life_after", "REAL", 0, 1), ("count_after", "INTEGER", 0, 1),
         ("last_after", "REAL", 0, 1), ("intrinsic_after", "REAL", 0, 1)]),
    "memory_strength_admissions": (
        "admission_key TEXT PRIMARY KEY,epoch TEXT NOT NULL,memory_id TEXT NOT NULL,applied_event_key TEXT NOT NULL",
        [("admission_key", "TEXT", 1, 0), ("epoch", "TEXT", 0, 1), ("memory_id", "TEXT", 0, 1), ("applied_event_key", "TEXT", 0, 1)])
}


class StrengthError(Exception):
    pass


def fail(reason):
    raise StrengthError(reason)


def finite(value):
    return type(value) in (int, float) and math.isfinite(value)


def clock(value):
    return finite(value) and value == int(value) and 0 <= value <= MAX_SAFE


def intrinsic(value):
    return finite(value) and 0 <= value <= 100


def text(value):
    if (type(value) is not str or not value
            or re.search(r"[\x00-\x20\x7f\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff\ud800-\udfff]", value)
            or len(value.encode("utf-8")) > MEMORY_STRENGTH_LIMITS["idBytes"]):
        fail("strength_invalid_input")
    return value


def shape(value, required, optional=()):
    if type(value) is not dict or any(k not in value for k in required) or any(k not in (*required, *optional) for k in value):
        fail("strength_invalid_input")


def digest(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8")).hexdigest()


def rows(db, sql, params=()):
    cursor = db.execute(sql, params)
    names = [column[0] for column in cursor.description]
    return [dict(zip(names, row)) for row in cursor.fetchall()]


def one(db, sql, params=()):
    values = rows(db, sql, params)
    return values[0] if values else None


def normalize(request):
    shape(request, ("protocol", "epoch", "nowMs", "events"))
    if (request["protocol"] != MEMORY_STRENGTH_PROTOCOL or not clock(request["nowMs"])
            or type(request["events"]) is not list or not 1 <= len(request["events"]) <= MEMORY_STRENGTH_LIMITS["batch"]):
        fail("strength_invalid_input")
    epoch = text(request["epoch"])
    events = []
    for event in request["events"]:
        shape(event, ("kind", "sourceIdentity", "memoryId", "occurredAtMs"), ("intrinsicValue", "admissionIdentity"))
        kind = event["kind"]
        if kind not in ("auto_context", "association", "search", "teach", "edit") or not clock(event["occurredAtMs"]):
            fail("strength_invalid_input")
        source = text(event["sourceIdentity"])
        raw_id = event["memoryId"]
        memory_id = str(int(raw_id)) if clock(raw_id) else raw_id
        if type(memory_id) is not str or not re.fullmatch(r"[1-9][0-9]*", memory_id) or len(memory_id) > 16 or int(memory_id) > MAX_SAFE:
            fail("strength_invalid_input")
        if (kind == "edit" and not intrinsic(event.get("intrinsicValue"))) or (kind != "edit" and "intrinsicValue" in event):
            fail("strength_invalid_input")
        admission = kind in ("auto_context", "association")
        if not admission and "admissionIdentity" in event:
            fail("strength_invalid_input")
        admission_identity = text(event.get("admissionIdentity")) if admission else ""
        identity = [MEMORY_STRENGTH_PROTOCOL, epoch, kind, source, memory_id]
        admission_key = digest([MEMORY_STRENGTH_PROTOCOL, epoch, admission_identity, memory_id]) if admission else ""
        value = event.get("intrinsicValue")
        if value == 0:
            value = 0.0
        wire = [kind, source, memory_id, str(int(event["occurredAtMs"])), admission_identity,
                struct.pack(">d", float(value)).hex() if kind == "edit" else ""]
        events.append({"kind": kind, "memoryId": memory_id, "occurredAtMs": int(event["occurredAtMs"]), "wire": wire,
                       "intrinsicValue": value, "admissionKey": admission_key, "eventKey": digest(identity),
                       "payloadHash": digest([*identity, str(int(event["occurredAtMs"])), admission_identity,
                                              struct.pack(">d", float(value)).hex() if kind == "edit" else ""])})
    try:
        size = len(json.dumps([MEMORY_STRENGTH_PROTOCOL, epoch, str(int(request["nowMs"])), [e["wire"] for e in events]],
                              ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8"))
    except (ValueError, UnicodeError):
        fail("strength_invalid_input")
    if size > MEMORY_STRENGTH_LIMITS["inputBytes"]:
        fail("strength_input_budget")
    return epoch, int(request["nowMs"]), sorted(events, key=lambda e: int(e["memoryId"]))


def inspect_memory_strength_prepared(db):
    try:
        for name, (_, columns) in TABLES.items():
            actual = rows(db, f'PRAGMA table_info("{name}")')
            if not actual:
                return {"status": "unavailable", "reason": "strength_schema_missing"}
            if len(actual) != len(columns) or [r["name"] for r in actual] != [c[0] for c in columns] or any(not any(
                    r["name"] == col and r["type"].upper() == typ and r["pk"] == pk and r["notnull"] == nn
                    and r["dflt_value"] is None for r in actual) for col, typ, pk, nn in columns):
                return {"status": "incompatible", "reason": "strength_schema_incompatible"}
            for column, typ, _, _ in columns:
                if typ != "TEXT":
                    continue
                eq = [r for r in rows(db, f'EXPLAIN SELECT "{column}"=? FROM "{name}" LIMIT 1', ("probe",)) if r["opcode"] == "Eq"]
                if len(eq) != 1 or eq[0]["p4"] != "BINARY-8":
                    return {"status": "incompatible", "reason": "strength_schema_incompatible"}
            if name != "memory_strength_control":
                primary = next(c[0] for c in columns if c[2] == 1)
                valid = False
                for index in rows(db, f'PRAGMA index_list("{name}")'):
                    if index["origin"] != "pk" or index["partial"]:
                        continue
                    quoted = index["name"].replace('"', '""')
                    keys = [r for r in rows(db, f'PRAGMA index_xinfo("{quoted}")') if r["key"] == 1]
                    valid |= len(keys) == 1 and keys[0]["name"] == primary and keys[0]["coll"] == "BINARY"
                if not valid:
                    return {"status": "incompatible", "reason": "strength_schema_incompatible"}
        rows(db, "SELECT memory_id,user_id,is_active,status,superseded_by,intrinsic_value,half_life,recall_count,last_recalled FROM episodic_memory LIMIT 0")
        memory_pk = [r for r in rows(db, "PRAGMA table_info(episodic_memory)") if r["pk"]]
        if len(memory_pk) != 1 or memory_pk[0]["name"] != "memory_id" or memory_pk[0]["type"].upper() != "INTEGER":
            return {"status": "incompatible", "reason": "strength_source_incompatible"}
        controls = rows(db, "SELECT id,protocol,epoch,receipt_limit FROM memory_strength_control LIMIT 2")
        if (len(controls) != 1 or controls[0]["id"] != 1 or controls[0]["protocol"] != MEMORY_STRENGTH_PROTOCOL
                or controls[0]["receipt_limit"] != MEMORY_STRENGTH_LIMITS["receipts"]):
            return {"status": "incompatible", "reason": "strength_control_incompatible"}
        text(controls[0]["epoch"])
        return {"status": "ready", "reason": None, "epoch": controls[0]["epoch"]}
    except Exception:
        return {"status": "unavailable", "reason": "strength_schema_unavailable"}


def prepare_memory_strength_schema(db, *, epoch):
    text(epoch)
    if db.in_transaction:
        fail("strength_transaction_already_open")
    db.execute("BEGIN IMMEDIATE")
    try:
        for name, (ddl, _) in TABLES.items():
            db.execute(f'CREATE TABLE IF NOT EXISTS "{name}" ({ddl})')
        if not one(db, "SELECT epoch FROM memory_strength_control WHERE id=1"):
            db.execute("INSERT INTO memory_strength_control VALUES (1,?,?,?)",
                       (MEMORY_STRENGTH_PROTOCOL, epoch, MEMORY_STRENGTH_LIMITS["receipts"]))
        prepared = inspect_memory_strength_prepared(db)
        if prepared["status"] != "ready":
            fail(prepared["reason"])
        if prepared["epoch"] != epoch:
            fail("strength_epoch_mismatch")
        db.execute("COMMIT")
    except Exception:
        db.execute("ROLLBACK")
        raise


def valid_receipt_result(row):
    return (row and type(row["event_key"]) is str and re.fullmatch(r"[a-f0-9]{64}", row["event_key"])
            and type(row["payload_hash"]) is str and re.fullmatch(r"[a-f0-9]{64}", row["payload_hash"])
            and clock(row["occurred_at_ms"]) and finite(row["half_life_after"]) and row["half_life_after"] > 0
            and clock(row["count_after"]) and finite(row["last_after"]) and row["last_after"] > 0
            and row["last_after"] * 1000 <= MAX_SAFE and intrinsic(row["intrinsic_after"]))


def checked_admission(db, event, epoch, prior=None):
    if not event["admissionKey"]:
        if prior and prior["strength_applied"] != 1:
            fail("strength_receipt_invalid")
        return None
    barrier = one(db, "SELECT * FROM memory_strength_admissions WHERE admission_key=?", (event["admissionKey"],))
    if not barrier:
        if prior or one(db, "SELECT 1 FROM memory_strength_events WHERE admission_key=? LIMIT 1", (event["admissionKey"],)):
            fail("strength_admission_invalid")
        return None
    anchor = one(db, "SELECT * FROM memory_strength_events WHERE event_key=?", (barrier["applied_event_key"],))
    if (barrier["epoch"] != epoch or barrier["memory_id"] != event["memoryId"] or not valid_receipt_result(anchor)
            or anchor["kind"] not in ("auto_context", "association") or anchor["strength_applied"] != 1
            or anchor["epoch"] != epoch or anchor["memory_id"] != event["memoryId"]
            or anchor["admission_key"] != event["admissionKey"] or anchor["count_after"] < 1
            or anchor["last_after"] * 1000 < anchor["occurred_at_ms"]
            or (prior and prior["strength_applied"] == 1 and barrier["applied_event_key"] != prior["event_key"])
            or (prior and prior["strength_applied"] == 0 and barrier["applied_event_key"] == prior["event_key"])):
        fail("strength_admission_invalid")
    return barrier


def apply_memory_strength_events(db, request):
    """Trusted caller owns rollback. No transaction commands, DDL, source proof or P3 side effects."""
    if not db.in_transaction:
        fail("strength_transaction_required")
    epoch, now_ms, events = normalize(request)
    prepared = inspect_memory_strength_prepared(db)
    if prepared["status"] != "ready":
        fail(prepared["reason"])
    if prepared["epoch"] != epoch:
        fail("strength_epoch_mismatch")
    outcomes = []
    for event in events:
        prior = one(db, "SELECT * FROM memory_strength_events WHERE event_key=?", (event["eventKey"],))
        if prior:
            if prior["payload_hash"] != event["payloadHash"] or prior["epoch"] != epoch:
                fail("strength_payload_conflict")
            if (prior["kind"] != event["kind"] or prior["memory_id"] != event["memoryId"]
                    or prior["occurred_at_ms"] != event["occurredAtMs"] or prior["admission_key"] != event["admissionKey"]
                    or prior["strength_applied"] not in (0, 1)
                    or not valid_receipt_result(prior)):
                fail("strength_receipt_invalid")
            checked_admission(db, event, epoch, prior)
            outcomes.append({"status": "duplicate", "memoryId": event["memoryId"], "eventKey": event["eventKey"],
                             "sourceReceiptNew": False, "associationStatisticsEligible": False, "halfLife": prior["half_life_after"],
                             "recallCount": prior["count_after"], "lastRecalled": prior["last_after"], "intrinsicValue": prior["intrinsic_after"]})
            continue
        admitted = checked_admission(db, event, epoch)
        size = one(db, "SELECT COUNT(*) n FROM (SELECT event_key FROM memory_strength_events LIMIT ?)",
                   (MEMORY_STRENGTH_LIMITS["receipts"] + 1,))["n"]
        if size >= MEMORY_STRENGTH_LIMITS["receipts"]:
            fail("strength_receipt_capacity")
        row = one(db, "SELECT memory_id,user_id,is_active,status,superseded_by,intrinsic_value,half_life,recall_count,last_recalled"
                  " FROM episodic_memory WHERE memory_id=?", (event["memoryId"],))
        if row is None:
            fail("strength_memory_missing")
        if (row["user_id"] != "master" or row["is_active"] != 1 or row["status"] not in (None, "active")
                or str(row["superseded_by"] or "") not in ("", "0")):
            fail("strength_memory_ineligible")
        if (not intrinsic(row["intrinsic_value"]) or not clock(row["recall_count"])
                or (row["half_life"] is not None and not finite(row["half_life"]))
                or (row["half_life"] is not None and row["half_life"] < 0)
                or not finite(row["last_recalled"]) or row["last_recalled"] <= 0):
            fail("strength_state_invalid")
        last_ms = row["last_recalled"] * 1000
        if not finite(last_ms) or last_ms > MAX_SAFE:
            fail("strength_state_invalid")
        if event["occurredAtMs"] > now_ms or last_ms > now_ms:
            fail("strength_clock_invalid")
        h = row["half_life"] if row["half_life"] is not None and row["half_life"] > 0 else initial_half_life(row["intrinsic_value"], DMAE_DEFAULT)
        i = event["intrinsicValue"] if event["kind"] == "edit" else row["intrinsic_value"]
        if admitted:
            half_life = h
        elif event["kind"] == "edit":
            half_life = initial_half_life(i, DMAE_DEFAULT)
        else:
            half_life = reinforce_half_life(h, retrievability(max(0, event["occurredAtMs"] - last_ms) / 3600000, h), DMAE_DEFAULT)
        count = row["recall_count"] if admitted or event["kind"] == "edit" else row["recall_count"] + 1
        last = row["last_recalled"] if admitted or event["kind"] == "edit" else max(row["last_recalled"], event["occurredAtMs"] / 1000)
        if not finite(half_life) or half_life <= 0 or not clock(count):
            fail("strength_state_invalid")
        if not admitted:
            db.execute("UPDATE episodic_memory SET half_life=?,recall_count=?,last_recalled=?,intrinsic_value=? WHERE memory_id=?",
                       (half_life, count, last, i, event["memoryId"]))
        db.execute("INSERT INTO memory_strength_events VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
                   (event["eventKey"], event["payloadHash"], epoch, event["kind"], event["memoryId"], event["occurredAtMs"],
                    event["admissionKey"], 0 if admitted else 1, half_life, count, last, i))
        if event["admissionKey"] and not admitted:
            db.execute("INSERT INTO memory_strength_admissions VALUES (?,?,?,?)", (event["admissionKey"], epoch, event["memoryId"], event["eventKey"]))
        outcomes.append({"status": "skipped_strength" if admitted else "applied", "memoryId": event["memoryId"],
                         "eventKey": event["eventKey"], "sourceReceiptNew": True, "associationStatisticsEligible": event["kind"] == "association",
                         "halfLife": half_life, "recallCount": count, "lastRecalled": last, "intrinsicValue": i})
    applied = sum(row["status"] == "applied" for row in outcomes)
    duplicates = sum(row["status"] == "duplicate" for row in outcomes)
    return {"status": "duplicate" if duplicates == len(outcomes) else "committed", "appliedCount": applied,
            "skippedCount": len(outcomes) - applied - duplicates, "duplicateCount": duplicates, "outcomes": outcomes}


class MemoryStrengthEvents:
    def __init__(self, *, db=None, enabled=False):
        self.db = db if enabled is True else None
        self.enabled = enabled is True

    def record(self, request):
        if not self.enabled:
            return {"status": "disabled", "accepted": False}
        if self.db is None:
            return {"status": "failed", "reason": "strength_db_required", "accepted": False}
        if self.db.in_transaction:
            return {"status": "failed", "reason": "strength_transaction_already_open", "accepted": False}
        transaction = False
        try:
            self.db.execute("BEGIN IMMEDIATE")
            transaction = True
            result = apply_memory_strength_events(self.db, request)
            self.db.execute("COMMIT")
            transaction = False
            return {**result, "accepted": True}
        except Exception as error:
            if transaction:
                try:
                    self.db.execute("ROLLBACK")
                except sqlite3.Error:
                    return {"status": "failed", "reason": "strength_rollback_failed", "accepted": False}
            reason = str(error) if isinstance(error, StrengthError) else (
                "strength_write_busy" if getattr(error, "sqlite_errorcode", None) == 5 else "strength_write_failed")
            return {"status": "failed", "reason": reason, "accepted": False}


def create_memory_strength_events(*, db=None, enabled=False):
    return MemoryStrengthEvents(db=db, enabled=enabled)
