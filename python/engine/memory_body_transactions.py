"""Unbound A1-S3 body coordinator. HOST provenance must be established by its caller."""
import hashlib
import json
import math
import re
import sqlite3
import time

from .episodic import insert_memory_caller_owned
from .memory_strength_events import (
    MEMORY_STRENGTH_PROTOCOL, StrengthError, apply_memory_strength_events,
    inspect_memory_strength_prepared, one, rows, text,
)

MEMORY_BODY_PROTOCOL = "echo-memory-body/v1"
MEMORY_BODY_LIMITS = {"receipts": 1024, "inputBytes": 65536, "resultBytes": 16384, "items": 16}
MAX_SAFE = 9007199254740991
TABLE = "memory_body_receipts"
COLUMNS = [
    ("body_key", "TEXT", 1, 0), ("payload_hash", "TEXT", 0, 1),
    ("epoch", "TEXT", 0, 1), ("source_kind", "TEXT", 0, 1),
    ("source_identity", "TEXT", 0, 1), ("occurred_at_ms", "INTEGER", 0, 1),
    ("result_json", "TEXT", 0, 1), ("result_hash", "TEXT", 0, 1),
]
DDL = ("body_key TEXT PRIMARY KEY,payload_hash TEXT NOT NULL,epoch TEXT NOT NULL,"
       "source_kind TEXT NOT NULL,source_identity TEXT NOT NULL,occurred_at_ms INTEGER NOT NULL,"
       "result_json TEXT NOT NULL,result_hash TEXT NOT NULL")


class BodyError(Exception):
    pass


def fail(reason):
    raise BodyError(reason)


def number(value):
    if type(value) not in (int, float):
        return False
    try:
        return math.isfinite(value)
    except OverflowError:
        return False


def integer(value, minimum=0, maximum=MAX_SAFE):
    return number(value) and value == int(value) and minimum <= value <= maximum


def exact(value, required, optional=()):
    if type(value) is not dict or not set(required) <= value.keys() or value.keys() - set((*required, *optional)):
        fail("body_invalid_input")


def encoded(value):
    try:
        return value.encode("utf-8")
    except (AttributeError, UnicodeError):
        fail("body_invalid_input")


def compact(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False)


def sha(value):
    return hashlib.sha256(encoded(value)).hexdigest()


def identity(value):
    try:
        return text(value)
    except StrengthError:
        fail("body_invalid_input")


def parse(value):
    try:
        result = json.loads(value, parse_constant=lambda _: fail("body_invalid_input"))
    except (ValueError, RecursionError):
        fail("body_invalid_input")
    count = 0

    def check(item, depth=0):
        nonlocal count
        count += 1
        if count > 10000 or depth > 20:
            fail("body_invalid_input")
        if type(item) is str:
            encoded(item)
        elif item is None or type(item) is bool:
            pass
        elif type(item) in (int, float):
            if not number(item):
                fail("body_invalid_input")
        elif type(item) is list:
            for child in item:
                check(child, depth + 1)
        elif type(item) is dict:
            for key, child in item.items():
                encoded(key)
                check(child, depth + 1)
        else:
            fail("body_invalid_input")
    check(result)
    return result


def body_options(value):
    required = ("keywords", "summary", "emotionScore", "source")
    optional = ("intrinsicValue", "sourceLabel", "actor", "occurredAt", "temporalStatus",
                "memoryKey", "layer", "evidence", "augKeys", "speakerId", "isMaster",
                "status", "memoryType", "memoryStability", "dedupe")
    exact(value, required, optional)
    if (type(value["keywords"]) is not list or any(type(k) is not str or not k for k in value["keywords"])
            or type(value["summary"]) is not str or not value["summary"].strip()
            or not integer(value["emotionScore"], 1, 10)
            or type(value["source"]) is not str or not value["source"]):
        fail("body_invalid_input")
    for field in ("sourceLabel", "actor", "temporalStatus", "memoryKey", "layer",
                  "evidence", "speakerId", "status", "memoryType", "memoryStability"):
        if field in value and type(value[field]) is not str:
            fail("body_invalid_input")
    if value.get("evidence", ""):
        fail("body_unsupported_field")
    for field in ("intrinsicValue", "occurredAt"):
        if field in value and not number(value[field]):
            fail("body_invalid_input")
    if "intrinsicValue" in value and not 0 <= value["intrinsicValue"] <= 100:
        fail("body_invalid_input")
    if "isMaster" in value and type(value["isMaster"]) is not bool:
        fail("body_invalid_input")
    if "status" in value and value["status"] not in ("active", "quarantined"):
        fail("body_invalid_input")
    aug = value.get("augKeys")
    if aug is not None and (type(aug) is not list or any(type(k) is not str for k in aug)):
        fail("body_invalid_input")
    dedupe = value.get("dedupe")
    if dedupe is not None:
        exact(dedupe, (), ("kwThreshold", "summaryThreshold"))
        if any(v is not None and (not number(v) or v < 0) for v in dedupe.values()):
            fail("body_invalid_input")
    mapping = {
        "source": "source", "intrinsicValue": "intrinsic_value", "sourceLabel": "source_label",
        "actor": "actor", "occurredAt": "occurred_at", "temporalStatus": "temporal_status",
        "memoryKey": "memory_key", "layer": "layer", "augKeys": "aug_keys",
        "speakerId": "speaker_id", "isMaster": "is_master", "status": "status",
        "memoryType": "memory_type", "memoryStability": "memory_stability", "dedupe": "dedupe",
    }
    return {target: value[key] for key, target in mapping.items() if key in value}


def normalize(request):
    exact(request, ("protocol", "epoch", "sourceKind", "sourceIdentity", "occurredAtMs", "payloadJson"))
    if (request["protocol"] != MEMORY_BODY_PROTOCOL or request["sourceKind"] not in ("extract", "teach")
            or not integer(request["occurredAtMs"], 1) or type(request["payloadJson"]) is not str):
        fail("body_invalid_input")
    epoch, source = identity(request["epoch"]), identity(request["sourceIdentity"])
    payload_json = request["payloadJson"]
    if len(encoded(payload_json)) > MEMORY_BODY_LIMITS["inputBytes"]:
        fail("body_input_budget")
    payload = parse(payload_json)
    exact(payload, ("items",))
    items = payload["items"]
    if type(items) is not list or not 1 <= len(items) <= MEMORY_BODY_LIMITS["items"]:
        fail("body_invalid_input")
    if request["sourceKind"] == "teach" and len(items) != 1:
        fail("body_invalid_input")
    seen, normalized = set(), []
    for item in items:
        exact(item, ("ordinal", "input"))
        ordinal = item["ordinal"]
        if not integer(ordinal, 0, 63) or int(ordinal) in seen:
            fail("body_invalid_input")
        seen.add(int(ordinal))
        normalized.append((int(ordinal), item["input"], body_options(item["input"])))
    key_fields = [MEMORY_BODY_PROTOCOL, epoch, request["sourceKind"], source]
    return {"epoch": epoch, "kind": request["sourceKind"], "source": source,
            "time": int(request["occurredAtMs"]), "items": normalized,
            "key": sha(compact(key_fields)),
            "hash": sha(compact([*key_fields, str(int(request["occurredAtMs"])), payload_json]))}


def inspect_memory_body_prepared(db):
    prepared = inspect_memory_strength_prepared(db)
    if prepared["status"] != "ready":
        return {"status": "unavailable", "reason": prepared["reason"]}
    try:
        actual = rows(db, f'PRAGMA table_info("{TABLE}")')
        if not actual:
            return {"status": "unavailable", "reason": "body_schema_missing"}
        if len(actual) != len(COLUMNS) or any(
            (row["name"], row["type"].upper(), row["pk"], row["notnull"]) != expected
            or row["dflt_value"] is not None for row, expected in zip(actual, COLUMNS)
        ):
            fail("body_schema_incompatible")
        for column, typ, _, _ in COLUMNS:
            if typ == "TEXT":
                eq = [r for r in rows(db, f'EXPLAIN SELECT "{column}"=? FROM "{TABLE}" LIMIT 1', ("probe",))
                      if r["opcode"] == "Eq"]
                if len(eq) != 1 or eq[0]["p4"] != "BINARY-8":
                    fail("body_schema_incompatible")
        valid_pk = False
        for index in rows(db, f'PRAGMA index_list("{TABLE}")'):
            if index["origin"] != "pk" or index["partial"]:
                continue
            quoted = index["name"].replace('"', '""')
            keys = [r for r in rows(db, f'PRAGMA index_xinfo("{quoted}")') if r["key"] == 1]
            valid_pk |= len(keys) == 1 and keys[0]["name"] == "body_key" and keys[0]["coll"] == "BINARY"
        if not valid_pk:
            fail("body_schema_incompatible")
        return {"status": "ready", "reason": None, "epoch": prepared["epoch"]}
    except BodyError as error:
        return {"status": "incompatible", "reason": str(error)}
    except Exception:
        return {"status": "unavailable", "reason": "body_schema_unavailable"}


def prepare_memory_body_schema(db, *, epoch):
    identity(epoch)
    if db.in_transaction:
        fail("body_transaction_already_open")
    db.execute("BEGIN IMMEDIATE")
    try:
        strength = inspect_memory_strength_prepared(db)
        if strength["status"] != "ready":
            fail(strength["reason"])
        if strength["epoch"] != epoch:
            fail("body_epoch_mismatch")
        db.execute(f'CREATE TABLE IF NOT EXISTS "{TABLE}" ({DDL})')
        prepared = inspect_memory_body_prepared(db)
        if prepared["status"] != "ready":
            fail(prepared["reason"])
        db.execute("COMMIT")
    except Exception:
        db.execute("ROLLBACK")
        raise


def written_result(raw, items):
    if type(raw) is not str or len(encoded(raw)) > MEMORY_BODY_LIMITS["resultBytes"]:
        fail("body_receipt_invalid")
    try:
        values = parse(raw)
        if type(values) is not list or len(values) != len(items) or compact(values) != raw:
            fail("body_receipt_invalid")
        written = []
        for row, (ordinal, _, _) in zip(values, items):
            if (type(row) is not list or len(row) != 3 or row[0] != str(ordinal)
                    or type(row[1]) is not str or not re.fullmatch(r"[1-9][0-9]{0,15}", row[1])
                    or int(row[1]) > MAX_SAFE or row[2] not in ("initialized", "reinforced")):
                fail("body_receipt_invalid")
            written.append({"ordinal": ordinal, "memoryId": row[1], "action": row[2]})
        return written
    except (ValueError, BodyError):
        fail("body_receipt_invalid")


def apply_memory_body_transactions(db, request, *, now_ms=None):
    """Trusted caller owns the transaction and must roll back after any exception."""
    if not db.in_transaction:
        fail("body_transaction_required")
    body = normalize(request)
    prepared = inspect_memory_body_prepared(db)
    if prepared["status"] != "ready":
        fail(prepared["reason"])
    if prepared["epoch"] != body["epoch"]:
        fail("body_epoch_mismatch")
    prior = one(db, f"SELECT * FROM {TABLE} WHERE body_key=?", (body["key"],))
    if prior:
        if prior["payload_hash"] != body["hash"]:
            fail("body_payload_conflict")
        if (prior["epoch"] != body["epoch"] or prior["source_kind"] != body["kind"]
                or prior["source_identity"] != body["source"] or prior["occurred_at_ms"] != body["time"]
                or type(prior["result_json"]) is not str or sha(prior["result_json"]) != prior["result_hash"]):
            fail("body_receipt_invalid")
        return {"status": "duplicate", "written": written_result(prior["result_json"], body["items"])}
    if now_ms is not None and not callable(now_ms):
        fail("body_clock_invalid")
    at = now_ms() if now_ms is not None else int(time.time() * 1000)
    if not integer(at, 1):
        fail("body_clock_invalid")
    if body["time"] > at:
        fail("body_clock_invalid")
    size = one(db, f"SELECT COUNT(*) n FROM (SELECT body_key FROM {TABLE} LIMIT ?)",
               (MEMORY_BODY_LIMITS["receipts"] + 1,))["n"]
    if size >= MEMORY_BODY_LIMITS["receipts"]:
        fail("body_receipt_capacity")
    result = []
    for ordinal, value, options in body["items"]:
        decision = insert_memory_caller_owned(
            db, "master", compact(value["keywords"]), value["summary"], value["emotionScore"],
            now=body["time"] / 1000, **options)
        mid = decision["memoryId"]
        action = "initialized"
        if decision["strengthAction"] is not None:
            source = sha(compact([MEMORY_BODY_PROTOCOL, body["kind"], body["source"], str(ordinal)]))
            applied = apply_memory_strength_events(db, {
                "protocol": MEMORY_STRENGTH_PROTOCOL, "epoch": body["epoch"], "nowMs": int(at),
                "events": [{"kind": "teach", "sourceIdentity": source, "memoryId": str(mid),
                            "occurredAtMs": body["time"]}],
            })
            if (applied["status"] != "committed" or applied["appliedCount"] != 1
                    or applied["outcomes"][0]["status"] != "applied"):
                fail("body_strength_not_applied")
            action = "reinforced"
        result.append([str(ordinal), str(mid), action])
    raw = compact(result)
    written = written_result(raw, body["items"])
    db.execute(f"INSERT INTO {TABLE} VALUES (?,?,?,?,?,?,?,?)",
               (body["key"], body["hash"], body["epoch"], body["kind"], body["source"],
                body["time"], raw, sha(raw)))
    return {"status": "applied", "written": written}


class MemoryBodyTransactions:
    def __init__(self, *, db=None, enabled=False, now_ms=None):
        self.enabled = enabled is True
        self.db = db if self.enabled else None
        self.now_ms = now_ms

    def record(self, request):
        if not self.enabled:
            return {"status": "disabled", "accepted": False}
        if self.db is None:
            return {"status": "failed", "reason": "body_db_required", "accepted": False}
        if self.db.in_transaction:
            return {"status": "failed", "reason": "body_transaction_already_open", "accepted": False}
        transaction = False
        try:
            self.db.execute("BEGIN IMMEDIATE")
            transaction = True
            result = apply_memory_body_transactions(self.db, request, now_ms=self.now_ms)
            self.db.execute("COMMIT")
            transaction = False
            return {**result, "status": "committed" if result["status"] == "applied" else result["status"],
                    "accepted": True}
        except Exception as error:
            if transaction:
                try:
                    self.db.execute("ROLLBACK")
                except sqlite3.Error:
                    return {"status": "failed", "reason": "body_rollback_failed", "accepted": False}
            reason = str(error) if isinstance(error, (BodyError, StrengthError)) else (
                "body_write_busy" if getattr(error, "sqlite_errorcode", None) == 5 else "body_write_failed")
            return {"status": "failed", "reason": reason, "accepted": False}


def create_memory_body_transactions(*, db=None, enabled=False, now_ms=None):
    return MemoryBodyTransactions(db=db, enabled=enabled, now_ms=now_ms)
