"""A1 retrieval receipts and caller-owned S2/S1 coordination."""
import hashlib
import json
import re
import sqlite3
import time

from . import cancel, retrieve
from .memory_body_transactions import parse as parse_bounded, BodyError
from .memory_strength_events import (
    MEMORY_STRENGTH_PROTOCOL, StrengthError, apply_memory_strength_events,
    inspect_memory_strength_prepared, one, rows, text,
)

MEMORY_RETRIEVAL_PROTOCOL = "echo-memory-retrieval/v1"
MEMORY_RETRIEVAL_LIMITS = {"receipts": 1024, "requestBytes": 16384, "payloadBytes": 16384,
                           "resultBytes": 262144, "topK": 12, "items": 20}
TABLE = "memory_retrieval_receipts"
COLUMNS = [("request_key", "TEXT", 1, 0), ("request_hash", "TEXT", 0, 1),
           ("epoch", "TEXT", 0, 1), ("result_json", "TEXT", 0, 1), ("result_hash", "TEXT", 0, 1)]
DDL = ("request_key TEXT PRIMARY KEY,request_hash TEXT NOT NULL,epoch TEXT NOT NULL,"
       "result_json TEXT NOT NULL,result_hash TEXT NOT NULL")
MAX_SAFE = 9007199254740991


class RetrievalError(Exception):
    pass


def fail(reason):
    raise RetrievalError(reason)


def integer(value, minimum=0, maximum=MAX_SAFE):
    return type(value) is int and minimum <= value <= maximum


def compact(value):
    try:
        return json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
    except (ValueError, TypeError, OverflowError, RecursionError):
        fail("retrieval_invalid_input")


def encoded(value):
    try:
        return value.encode("utf-8")
    except (AttributeError, UnicodeError):
        fail("retrieval_invalid_input")


def sha(value):
    return hashlib.sha256(encoded(value)).hexdigest()


def identity(value):
    try:
        return text(value)
    except StrengthError:
        fail("retrieval_invalid_input")


def exact(value, required, optional=()):
    if type(value) is not dict or set(value) - set((*required, *optional)) or not set(required) <= value.keys():
        fail("retrieval_invalid_input")


def parse(value):
    try:
        return parse_bounded(value)
    except (BodyError, TypeError):
        fail("retrieval_invalid_input")


def inspect_memory_retrieval_prepared(db):
    prepared = inspect_memory_strength_prepared(db)
    if prepared["status"] != "ready":
        return {"status": "unavailable", "reason": "retrieval_schema_unprepared"}
    try:
        actual = rows(db, f'PRAGMA table_xinfo("{TABLE}")')
        if len(actual) != len(COLUMNS) or any(
                (r["name"], r["type"].upper(), r["pk"], r["notnull"]) != c
                or r["dflt_value"] is not None or r["hidden"] != 0
                for r, c in zip(actual, COLUMNS)):
            fail("retrieval_schema_incompatible")
        for column, _, _, _ in COLUMNS:
            comparisons = [r for r in rows(
                db, f'EXPLAIN SELECT "{column}"=? FROM "{TABLE}" LIMIT 1', ("probe",))
                if r["opcode"] == "Eq"]
            if len(comparisons) != 1 or comparisons[0]["p4"] != "BINARY-8":
                fail("retrieval_schema_incompatible")
        valid_pk = False
        for index in rows(db, f'PRAGMA index_list("{TABLE}")'):
            if index["origin"] == "pk" and not index["partial"]:
                name = index["name"].replace('"', '""')
                keys = [r for r in rows(db, f'PRAGMA index_xinfo("{name}")') if r["key"] == 1]
                valid_pk |= len(keys) == 1 and keys[0]["name"] == "request_key" and keys[0]["coll"] == "BINARY"
        if not valid_pk:
            fail("retrieval_schema_incompatible")
        return {"status": "ready", "epoch": prepared["epoch"], "reason": None}
    except RetrievalError as error:
        return {"status": "incompatible", "reason": str(error)}
    except Exception:
        return {"status": "unavailable", "reason": "retrieval_schema_unavailable"}


def prepare_memory_retrieval_schema(db, *, epoch):
    identity(epoch)
    if db.in_transaction:
        fail("retrieval_transaction_already_open")
    started = False
    try:
        db.execute("BEGIN IMMEDIATE")
        started = True
        prepared = inspect_memory_strength_prepared(db)
        if prepared["status"] != "ready":
            fail("retrieval_schema_unprepared")
        if prepared["epoch"] != epoch:
            fail("retrieval_epoch_mismatch")
        db.execute(f'CREATE TABLE IF NOT EXISTS "{TABLE}" ({DDL})')
        ready = inspect_memory_retrieval_prepared(db)
        if ready["status"] != "ready":
            fail(ready["reason"])
        db.execute("COMMIT")
    except Exception as error:
        if started and db.in_transaction:
            try:
                db.execute("ROLLBACK")
            except Exception:
                fail("retrieval_rollback_failed")
        if isinstance(error, RetrievalError):
            raise
        fail("retrieval_write_busy" if getattr(error, "sqlite_errorcode", None) == 5
             else "retrieval_write_failed")


OPTION_KEYS = ("dedupe", "coreBlock", "fusion", "timeArm", "timeMode",
               "expandTerms", "expandScore", "augKeys")


def validate_payload(payload, kind):
    exact(payload, ("userId", "query", "topK", "rankAtMs", "opts", "rankingData"))
    if (payload["userId"] != "master" or type(payload["query"]) is not str
            or not payload["query"].strip() or not integer(payload["topK"], 1, 12)
            or not integer(payload["rankAtMs"], 1)):
        fail("retrieval_invalid_input")
    ranking_data = payload["rankingData"]
    if kind == "search" and ranking_data is None:
        fail("retrieval_invalid_input")
    if ranking_data is not None:
        if kind == "auto_context":
            fail("retrieval_invalid_input")
        exact(ranking_data, ("lexicon",))
        exact(ranking_data["lexicon"], ("stopwords", "timeWords"))
        if (type(ranking_data["lexicon"]["stopwords"]) is not list
                or type(ranking_data["lexicon"]["timeWords"]) is not dict):
            fail("retrieval_invalid_input")
    opts = payload["opts"]
    exact(opts, OPTION_KEYS)
    if (any(type(opts[key]) is not bool for key in
            ("dedupe", "coreBlock", "timeArm", "expandScore", "augKeys"))
            or opts["timeMode"] != "boost"
            or (opts["fusion"] is not None and type(opts["fusion"]) is not dict)
            or (opts["expandTerms"] is not None and (
                type(opts["expandTerms"]) is not list
                or any(type(term) is not str for term in opts["expandTerms"])))
            or opts["dedupe"] != (kind == "auto_context")):
        fail("retrieval_invalid_input")
    if kind == "search" and (opts["coreBlock"] != retrieve.PROD_CORE_BLOCK
                             or opts["fusion"] is not None or opts["timeArm"]
                             or opts["expandTerms"] is not None or opts["expandScore"] or opts["augKeys"]):
        fail("retrieval_invalid_input")
    return payload


def normalize(request, generation):
    exact(request, ("protocol", "epoch", "kind", "sourceIdentity", "occurredAtMs", "payloadJson"),
          ("admissionIdentity",))
    kind = request["kind"]
    if (request["protocol"] != MEMORY_RETRIEVAL_PROTOCOL or kind not in ("auto_context", "search")
            or not integer(request["occurredAtMs"], 1) or not integer(generation, 1)
            or (kind == "auto_context") != ("admissionIdentity" in request)):
        fail("retrieval_invalid_input")
    epoch, source = identity(request["epoch"]), identity(request["sourceIdentity"])
    admission = identity(request["admissionIdentity"]) if kind == "auto_context" else ""
    raw = request["payloadJson"]
    if len(encoded(raw)) > MEMORY_RETRIEVAL_LIMITS["payloadBytes"]:
        fail("retrieval_input_budget")
    if len(encoded(compact(request))) > MEMORY_RETRIEVAL_LIMITS["requestBytes"]:
        fail("retrieval_input_budget")
    payload = validate_payload(parse(raw), kind)
    key_fields = [MEMORY_RETRIEVAL_PROTOCOL, epoch, kind, source]
    return {"epoch": epoch, "kind": kind, "source": source, "admission": admission,
            "time": request["occurredAtMs"], "payload": payload,
            "key": sha(compact(key_fields)),
            "hash": sha(compact([*key_fields, str(request["occurredAtMs"]), admission, raw, str(generation)]))}


def checked_result(raw, request):
    try:
        if type(raw) is not str or len(encoded(raw)) > MEMORY_RETRIEVAL_LIMITS["resultBytes"]:
            fail("retrieval_receipt_invalid")
        result = parse(raw)
        automatic = request["kind"] == "auto_context"
        fields = ("type", "items", "reinforced", "rankAtMs")
        exact(result, (*fields, "text", "now", "state", "profile") if automatic else fields)
        if (result["type"] != ("retrieve_result" if automatic else "memory_search_result")
                or result["rankAtMs"] != request["payload"]["rankAtMs"]
                or not integer(result["reinforced"], 0, 12)
                or type(result["items"]) is not list or len(result["items"]) > 20
                or result["reinforced"] > len(result["items"])
                or compact(result) != raw):
            fail("retrieval_receipt_invalid")
        if automatic and (type(result["text"]) is not str or result["state"] is not None
                          or result["profile"] is not None
                          or result["now"] != request["payload"]["rankAtMs"] / 1000):
            fail("retrieval_receipt_invalid")
        for item in result["items"]:
            if type(item) is not dict or not integer(item.get("memory_id" if automatic else "memoryId"), 1):
                fail("retrieval_receipt_invalid")
            if not automatic:
                exact(item, ("memoryId", "summary", "layer", "keywords", "hits", "ageDays", "emotionScore"))
            if (type(item.get("summary")) is not str or type(item.get("layer")) is not str
                    or type(item.get("keywords")) is not list
                    or any(type(word) is not str for word in item["keywords"])
                    or (automatic and type(item.get("forced")) is not bool)):
                fail("retrieval_receipt_invalid")
        return result
    except RetrievalError:
        fail("retrieval_receipt_invalid")


def _apply(db, request, *, generation, now_ms=None):
    if not db.in_transaction:
        fail("retrieval_transaction_required")
    operation = normalize(request, generation)
    prepared = inspect_memory_retrieval_prepared(db)
    if prepared["status"] != "ready":
        fail(prepared["reason"])
    if prepared["epoch"] != operation["epoch"]:
        fail("retrieval_epoch_mismatch")
    prior = one(db, f"SELECT * FROM {TABLE} WHERE request_key=?", (operation["key"],))
    if prior:
        if (prior["epoch"] != operation["epoch"] or any(
                type(prior[key]) is not str or not re.fullmatch("[a-f0-9]{64}", prior[key])
                for key in ("request_hash", "result_hash"))):
            fail("retrieval_receipt_invalid")
        if prior["request_hash"] != operation["hash"]:
            fail("retrieval_payload_conflict")
        if type(prior["result_json"]) is not str or sha(prior["result_json"]) != prior["result_hash"]:
            fail("retrieval_receipt_invalid")
        return {"status": "duplicate", "result": checked_result(prior["result_json"], operation)}
    if now_ms is not None and not callable(now_ms):
        fail("retrieval_clock_invalid")
    at = now_ms() if now_ms is not None else int(time.time() * 1000)
    if (not integer(at, 1) or operation["time"] > at
            or operation["payload"]["rankAtMs"] > at):
        fail("retrieval_clock_invalid")
    size = one(db, f"SELECT COUNT(*) n FROM (SELECT request_key FROM {TABLE} LIMIT ?)",
               (MEMORY_RETRIEVAL_LIMITS["receipts"] + 1,))["n"]
    if size >= MEMORY_RETRIEVAL_LIMITS["receipts"]:
        fail("retrieval_receipt_capacity")
    payload, opts = operation["payload"], operation["payload"]["opts"]
    retrieve.lexical.configure_from_data(payload["rankingData"])
    retrieve.timeintent.configure_from_data(payload["rankingData"])
    items, candidates = retrieve.retrieve_caller_owned(
        db, payload["userId"], payload["query"], payload["topK"], now=payload["rankAtMs"] / 1000,
        dedupe=opts["dedupe"], core_block=opts["coreBlock"], fusion=opts["fusion"],
        time_arm=opts["timeArm"], time_mode=opts["timeMode"], extra_terms=opts["expandTerms"],
        expand_score=opts["expandScore"], aug_keys=opts["augKeys"])
    if len(items) > 20 or len(candidates) > 12 or len(set(candidates)) != len(candidates):
        fail("retrieval_result_invalid")
    events = []
    for mid in candidates:
        event = {"kind": operation["kind"], "sourceIdentity": operation["source"],
                 "memoryId": str(mid), "occurredAtMs": operation["time"]}
        if operation["kind"] == "auto_context":
            event["admissionIdentity"] = operation["admission"]
        events.append(event)
    reinforced = 0
    for index in range(0, len(events), 8):
        applied = apply_memory_strength_events(db, {
            "protocol": MEMORY_STRENGTH_PROTOCOL, "epoch": operation["epoch"],
            "nowMs": at, "events": events[index:index + 8]})
        reinforced += applied["appliedCount"]
    result = {"type": "retrieve_result" if operation["kind"] == "auto_context" else "memory_search_result",
              "items": items, "reinforced": reinforced, "rankAtMs": payload["rankAtMs"]}
    if operation["kind"] == "auto_context":
        result.update(text=retrieve.render_episodic(items), now=payload["rankAtMs"] / 1000,
                      state=None, profile=None)
    else:
        result["items"] = [
            {"memoryId": it["memory_id"], "summary": str(it.get("summary") or "")[:120],
             "layer": str(it.get("layer") or ""), "keywords": it.get("keywords") or [],
             "hits": it.get("hits"), "ageDays": it.get("age_days"), "emotionScore": it.get("emotion_score")}
            for it in items]
    raw = compact(result)
    if len(encoded(raw)) > MEMORY_RETRIEVAL_LIMITS["resultBytes"]:
        fail("retrieval_result_budget")
    checked_result(raw, operation)
    db.execute(f"INSERT INTO {TABLE} VALUES (?,?,?,?,?)",
               (operation["key"], operation["hash"], operation["epoch"], raw, sha(raw)))
    return {"status": "committed", "result": result}


def apply_memory_retrieval_transactions(db, request, *, generation, now_ms=None):
    """Caller must roll back all S1 batches and the receipt on any failure."""
    try:
        return _apply(db, request, generation=generation, now_ms=now_ms)
    except (RetrievalError, StrengthError, cancel.RequestCancelled):
        raise
    except Exception as error:
        fail("retrieval_write_busy" if isinstance(error, sqlite3.Error)
             and getattr(error, "sqlite_errorcode", None) == 5 else "retrieval_write_failed")
    finally:
        retrieve.lexical.configure_from_data(None)
        retrieve.timeintent.configure_from_data(None)
