"""Caller-owned request, stage and complete-ACK receipts for A1-S4d."""

import hashlib
import json
import math
import re
import sqlite3

from . import graph, threads
from .memory_extract_schema import (
    EXTRACT_ACK_TABLE, EXTRACT_PROTOCOL, EXTRACT_REQUEST_TABLE, EXTRACT_STATUSES,
    EXTRACT_STAGE_TABLE, STAGE_STATUSES, require_extract_schema, validate_identity,
)
from .memory_body_transactions import (
    MEMORY_BODY_PROTOCOL, apply_memory_body_transactions, compact as body_compact,
    normalize as normalize_body,
)

MAX_SAFE = 9007199254740991
REQUIRED_ENTRIES = ("memory_add", "memory_retrieve", "memory_search",
                    "memory_association", "memory_extract")
STAGES = ("body", "graph", "threads", "js_ack")
ACTION_RE = re.compile(r"^[A-Za-z0-9:_-]{1,128}$")
ACK_KEYS = ("extract", "written", "quarantined", "rejected", "triplesRejected",
            "learned", "graphError", "threadsRegistered", "threadsResolved",
            "name", "profileUpdate", "stats", "stageStatuses")
ACK_OPTIONAL_KEYS = ("hostVersion",)
EXTRACT_ORIGIN_KEYS = ("sourceKind", "sourceIdentity", "occurredAtMs",
                       "resultAdmissionIdentity", "sessionId", "startSeq",
                       "endSeq", "turn", "endReason")
HOST_VERSION_KEYS = ("sessionId", "turn", "endSeq", "occurredAtMs", "sourceIdentity")


class ExtractError(Exception):
    pass


def fail(reason):
    raise ExtractError(reason)


def compact(value):
    try:
        return json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
    except (TypeError, ValueError, OverflowError):
        fail("extract_invalid_input")


def sha(value):
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _integer(value, minimum=0):
    return type(value) is int and minimum <= value <= MAX_SAFE


def _exact(value, required, optional=()):
    if type(value) is not dict or not set(required) <= value.keys() \
            or value.keys() - set((*required, *optional)):
        fail("extract_invalid_input")


def normalize_request(request):
    _exact(request, ("protocol", "epoch", "generation", "sourceIdentity",
                     "payload", "createdAtMs"))
    if request["protocol"] != EXTRACT_PROTOCOL:
        fail("extract_protocol_mismatch")
    try:
        epoch = validate_identity(request["epoch"])
        source = validate_identity(request["sourceIdentity"])
    except ValueError as error:
        raise ExtractError(str(error)) from error
    if not _integer(request["generation"], 1) or not _integer(request["createdAtMs"], 1):
        fail("extract_invalid_input")
    payload_json = compact(request["payload"])
    normalized = {
        "protocol": EXTRACT_PROTOCOL,
        "epoch": epoch,
        "generation": request["generation"],
        "sourceIdentity": source,
        "createdAtMs": request["createdAtMs"],
        "payload": request["payload"],
    }
    request_hash = sha(compact([
        EXTRACT_PROTOCOL, epoch, str(request["generation"]), source,
        str(request["createdAtMs"]), payload_json,
    ]))
    return normalized, request_hash, sha(payload_json)


def validate_extract_origin(origin):
    if type(origin) is not dict or set(origin) != set(EXTRACT_ORIGIN_KEYS):
        fail("extract_origin_invalid")
    session = origin.get("sessionId")
    source = origin.get("sourceIdentity")
    occurred = origin.get("occurredAtMs")
    start_seq, end_seq, turn = origin.get("startSeq"), origin.get("endSeq"), origin.get("turn")
    try:
        validate_identity(session)
        validate_identity(source)
        validate_identity(origin.get("resultAdmissionIdentity"))
    except ValueError as error:
        raise ExtractError("extract_origin_invalid") from error
    if origin.get("sourceKind") != "extract" or origin.get("endReason") != "completed" \
            or not _integer(occurred, 1) or not _integer(start_seq) \
            or not _integer(end_seq, 1) or end_seq <= start_seq \
            or not _integer(turn, 1):
        fail("extract_origin_invalid")
    identity = sha(compact([
        "echo-memory-strength-origin/v1", "extract", session, str(start_seq),
        str(turn), str(end_seq), str(occurred), "completed",
    ]))
    admission = "extract-admission:" + sha(compact(["extract-admission/v1", identity]))
    if source != identity or origin["resultAdmissionIdentity"] != admission:
        fail("extract_origin_invalid")
    return {"sessionId": session, "turn": turn, "endSeq": end_seq,
            "occurredAtMs": occurred, "sourceIdentity": source}


def validate_host_version(version):
    if type(version) is not dict or set(version) != set(HOST_VERSION_KEYS):
        fail("extract_host_version_invalid")
    try:
        validate_identity(version["sessionId"])
        validate_identity(version["sourceIdentity"])
    except (KeyError, ValueError, ExtractError) as error:
        raise ExtractError("extract_host_version_invalid") from error
    if not _integer(version.get("turn"), 1) or not _integer(version.get("endSeq"), 1) \
            or not _integer(version.get("occurredAtMs"), 1):
        fail("extract_host_version_invalid")
    return {key: version[key] for key in HOST_VERSION_KEYS}


def compare_extract_host_version(db, version, request_hash):
    """Compare against the latest committed, non-stale host ACK for this session."""
    current = validate_host_version(version)
    binding = db.execute(
        f"SELECT source_identity FROM {EXTRACT_REQUEST_TABLE} WHERE request_hash=?",
        (request_hash,)).fetchone()
    if not binding or binding[0] != current["sourceIdentity"]:
        fail("extract_host_version_conflict")
    rows = db.execute(
        f"SELECT r.request_hash,a.ack_json,r.source_identity FROM {EXTRACT_ACK_TABLE} a "
        f"JOIN {EXTRACT_REQUEST_TABLE} r USING(request_hash) "
        "WHERE a.status IN ('partial','committed','unknown') AND a.stale_skipped=0 "
        "AND json_extract(a.ack_json,'$.hostVersion.sessionId')=? AND r.request_hash<>?",
        (current["sessionId"], request_hash)).fetchall()
    latest = None
    for row in rows:
        try:
            prior_ack = json.loads(row[1])
            prior = validate_host_version(prior_ack.get("hostVersion"))
        except (TypeError, ValueError, KeyError, ExtractError) as error:
            raise ExtractError("extract_host_version_invalid") from error
        if prior["sourceIdentity"] != row[2]:
            fail("extract_host_version_invalid")
        if latest is None or (prior["turn"], prior["endSeq"]) > (latest["turn"], latest["endSeq"]):
            latest = prior
        elif (prior["turn"], prior["endSeq"]) == (latest["turn"], latest["endSeq"]):
            if prior["sourceIdentity"] != latest["sourceIdentity"] \
                    or prior["occurredAtMs"] != latest["occurredAtMs"]:
                fail("extract_host_version_conflict")

    if latest is None:
        return {"status": "current", "latest": None}
    pair = (current["turn"], current["endSeq"])
    prior_pair = (latest["turn"], latest["endSeq"])
    if pair == prior_pair:
        if current == latest:
            return {"status": "replay", "latest": latest}
        fail("extract_host_version_conflict")
    if current["turn"] == latest["turn"]:
        return {"status": "stale", "latest": latest} if current["endSeq"] < latest["endSeq"] else {"status": "current", "latest": latest}
    if current["turn"] < latest["turn"] and current["endSeq"] < latest["endSeq"]:
        return {"status": "stale", "latest": latest}
    if current["turn"] > latest["turn"] and current["endSeq"] > latest["endSeq"]:
        return {"status": "current", "latest": latest}
    fail("extract_host_version_conflict")


def mark_extract_stale_skipped(db, request_hash, ack=None, *, applied_at_ms):
    if not db.in_transaction:
        fail("extract_transaction_required")
    if not _integer(applied_at_ms, 1):
        fail("extract_invalid_input")
    binding = _binding(db, request_hash)
    row = db.execute(
        f"SELECT status,ack_json,stale_skipped FROM {EXTRACT_ACK_TABLE} "
        "WHERE request_hash=?", (request_hash,)).fetchone()
    if row and row[0] == "committed":
        if row[2] == 0:
            changed = db.execute(
                f"UPDATE {EXTRACT_ACK_TABLE} SET stale_skipped=1 "
                "WHERE request_hash=? AND status='committed' AND stale_skipped=0",
                (request_hash,)).rowcount
            if changed != 1:
                fail("extract_ack_conflict")
        return {"status": "committed", "staleSkipped": True}
    if row:
        changed = db.execute(
            f"UPDATE {EXTRACT_ACK_TABLE} SET stale_skipped=1 "
            "WHERE request_hash=? AND status=? AND stale_skipped=0",
            (request_hash, row[0])).rowcount
        if changed != 1 and row[2] != 1:
            fail("extract_ack_conflict")
        return {"status": row[0], "staleSkipped": True}
    if ack is None:
        fail("extract_ack_missing")
    summary = {stage: "pending" for stage in STAGES}
    stale_ack = dict(ack)
    stale_ack["stageStatuses"] = summary
    record_ack(db, request_hash, stale_ack, summary, "partial",
               applied_at_ms=applied_at_ms, stale_skipped=1)
    return {"status": "partial", "staleSkipped": True}


def _check_authority(authority, epoch, generation, required_entries):
    if not isinstance(authority, dict) or authority.get("status") != "active" \
            or authority.get("protocol") != "echo-memory-authority/v1" \
            or authority.get("epoch") != epoch or authority.get("generation") != generation \
            or tuple(authority.get("entries") or ()) != tuple(required_entries):
        fail("extract_authority_changed")


def begin_extract_request(db, request, *, authorityOf=None, requiredEntries=None,
                          active=False):
    """Insert immutable request binding inside the caller's transaction."""
    if not db.in_transaction:
        fail("extract_transaction_required")
    require_extract_schema(db)
    normalized, request_hash, payload_hash = normalize_request(request)
    if active and (not callable(authorityOf) or tuple(requiredEntries or ()) != REQUIRED_ENTRIES):
        fail("extract_authority_required")
    if authorityOf is not None or requiredEntries is not None:
        if not callable(authorityOf) or tuple(requiredEntries or ()) != REQUIRED_ENTRIES:
            fail("extract_authority_changed")
        _check_authority(authorityOf(db), normalized["epoch"], normalized["generation"],
                         requiredEntries)
    prior = db.execute(
        f"SELECT protocol,epoch,generation,source_identity,payload_hash,status "
        f"FROM {EXTRACT_REQUEST_TABLE} WHERE request_hash=?", (request_hash,)).fetchone()
    if prior:
        if tuple(prior[:5]) != (
                EXTRACT_PROTOCOL, normalized["epoch"], normalized["generation"],
                normalized["sourceIdentity"], payload_hash):
            fail("extract_request_conflict")
        return {"status": "duplicate", "requestHash": request_hash,
                "payloadHash": payload_hash, "request": normalized,
                "priorStatus": prior[5]}
    conflict = db.execute(
        f"SELECT epoch,generation,payload_hash FROM {EXTRACT_REQUEST_TABLE}"
        " WHERE source_identity=? LIMIT 1",
        (normalized["sourceIdentity"],)).fetchone()
    if conflict and (conflict[0] != normalized["epoch"]
                     or conflict[1] != normalized["generation"]
                     or conflict[2] != payload_hash):
        fail("extract_request_conflict")
    db.execute(
        f"INSERT INTO {EXTRACT_REQUEST_TABLE} "
        "(request_hash,protocol,epoch,generation,source_identity,payload_hash,status,created_at_ms,result_hash)"
        " VALUES (?,?,?,?,?,?,?,?,NULL)",
        (request_hash, EXTRACT_PROTOCOL, normalized["epoch"], normalized["generation"],
         normalized["sourceIdentity"], payload_hash, "started", normalized["createdAtMs"]))
    return {"status": "started", "requestHash": request_hash,
            "payloadHash": payload_hash, "request": normalized}


def _binding(db, request_hash):
    row = db.execute(
        f"SELECT epoch,generation,payload_hash,status,source_identity FROM {EXTRACT_REQUEST_TABLE}"
        " WHERE request_hash=?", (request_hash,)).fetchone()
    if not row:
        fail("extract_request_missing")
    return row


def apply_extract_body_stage(db, request_hash, body_request, *,
                             action_key="extract-body", now_ms=None):
    """Apply extract body/S1 and its stage receipt in one caller transaction."""
    if not db.in_transaction:
        fail("extract_transaction_required")
    binding = _binding(db, request_hash)
    if binding[3] in ("committed", "failed"):
        fail("extract_request_status_invalid")
    if type(body_request) is not dict or body_request.get("protocol") != MEMORY_BODY_PROTOCOL \
            or body_request.get("sourceKind") != "extract":
        fail("extract_body_invalid")
    if body_request.get("epoch") != binding[0] \
            or body_request.get("sourceIdentity") != binding[4]:
        fail("extract_body_binding_conflict")
    try:
        payload = json.loads(body_request.get("payloadJson", ""))
    except (TypeError, ValueError):
        fail("extract_body_invalid")
    if type(payload) is not dict or set(payload) != {"items"} \
            or type(payload["items"]) is not list:
        fail("extract_body_invalid")
    if len(payload["items"]) == 0:
        result = {"status": "applied", "written": []}
    else:
        result = apply_memory_body_transactions(db, body_request, now_ms=now_ms)
    if result["status"] == "duplicate":
        existing = db.execute(
            f"SELECT payload_hash,status FROM {EXTRACT_STAGE_TABLE}"
            " WHERE request_hash=? AND stage='body' AND action_key=?",
            (request_hash, action_key)).fetchone()
        if existing:
            return {"status": "duplicate", "payloadHash": existing[0],
                    "written": result.get("written", [])}
    stage_result = {"body": result.get("written", []), "bodyStatus": result["status"]}
    receipt = record_stage(db, request_hash, "body", action_key, stage_result,
                           "committed", applied_at_ms=body_request["occurredAtMs"])
    return {**receipt, "written": result.get("written", []),
            "bodyStatus": result["status"]}


def apply_prepared_extract_body(db, prepared, *, authorityOf=None,
                                requiredEntries=None, now_ms=None):
    """Apply one pure Judge result through body/S1; graph/threads remain pending."""
    request = prepared.get("request") if isinstance(prepared, dict) else None
    body_items = prepared.get("bodyItems") if isinstance(prepared, dict) else None
    ack = prepared.get("ack") if isinstance(prepared, dict) else None
    if not isinstance(request, dict) or not isinstance(body_items, list) \
            or not isinstance(ack, dict):
        fail("extract_prepare_invalid")
    if not db.in_transaction:
        fail("extract_transaction_required")
    binding = begin_extract_request(
        db, request, authorityOf=authorityOf, requiredEntries=requiredEntries,
        active=authorityOf is not None or requiredEntries is not None)
    if binding["status"] == "duplicate":
        prior = db.execute(
            f"SELECT status,ack_json FROM {EXTRACT_ACK_TABLE}"
            " WHERE request_hash=?", (binding["requestHash"],)).fetchone()
        if prior:
            return {"status": "duplicate", "requestHash": binding["requestHash"],
                    "ack": json.loads(prior[1]), "receiptStatus": prior[0]}
    body_request = {
        "protocol": MEMORY_BODY_PROTOCOL, "epoch": request["epoch"],
        "sourceKind": "extract", "sourceIdentity": request["sourceIdentity"],
        "occurredAtMs": request["createdAtMs"],
        "payloadJson": body_compact({"items": [
            {"ordinal": index, "input": item}
            for index, item in enumerate(body_items)
        ]}),
    }
    body = apply_extract_body_stage(
        db, binding["requestHash"], body_request, now_ms=now_ms)
    ack = dict(ack)
    ack["written"] = body.get("body", body.get("written", []))
    ack["stageStatuses"] = {
        "body": "committed" if body["status"] != "duplicate" else "duplicate",
        "graph": "pending", "threads": "pending", "js_ack": "pending"}
    summary = dict(ack["stageStatuses"])
    receipt = record_ack(
        db, binding["requestHash"], ack, summary, "partial",
        applied_at_ms=request["createdAtMs"])
    return {"status": receipt["status"], "requestHash": binding["requestHash"],
            "ack": ack, "receiptStatus": "partial"}


def apply_extract_graph_stage(db, request_hash, triples, *,
                              owner_key="master", evidence_ids=None,
                              emotion=5.0, run_identity="",
                              applied_at_ms=None):
    """Apply triples one at a time with savepoints and stable stage receipts."""
    if not db.in_transaction:
        fail("extract_transaction_required")
    if not _integer(applied_at_ms, 1):
        fail("extract_clock_invalid")
    binding = _binding(db, request_hash)
    outcomes = []
    evidence_ids = evidence_ids or []
    if not triples:
        receipt = record_stage(db, request_hash, "graph", "none", {"triples": []},
                               "committed", applied_at_ms=applied_at_ms)
        return [{"ordinal": None, "status": receipt["status"], "actionKey": "none"}]
    for ordinal, triple in enumerate(triples or []):
        action_key = f"triple:{ordinal}"
        payload = {"triple": triple, "evidence": evidence_ids or []}
        payload_hash = sha(compact(payload))
        prior = db.execute(
            f"SELECT payload_hash,status,result_json FROM {EXTRACT_STAGE_TABLE}"
            " WHERE request_hash=? AND stage='graph' AND action_key=?",
            (request_hash, action_key)).fetchone()
        if prior:
            if prior[0] != payload_hash:
                fail("extract_stage_conflict")
            if prior[1] == "committed":
                outcomes.append({"ordinal": ordinal, "status": "duplicate",
                                 "actionKey": action_key})
                continue
        savepoint = f"extract_graph_{ordinal}"
        db.execute(f"SAVEPOINT {savepoint}")
        try:
            applied = graph.apply_triple_caller_owned(
                db, triple, owner_key, evidence=evidence_ids, emotion=emotion)
            receipt = record_stage(
                db, request_hash, "graph", action_key,
                payload,
                "committed", applied_at_ms=applied_at_ms)
            db.execute(f"RELEASE SAVEPOINT {savepoint}")
            outcomes.append({"ordinal": ordinal, "status": "committed",
                             "actionKey": action_key})
        except sqlite3.Error:
            db.execute(f"ROLLBACK TO SAVEPOINT {savepoint}")
            db.execute(f"RELEASE SAVEPOINT {savepoint}")
            raise
        except Exception as error:
            db.execute(f"ROLLBACK TO SAVEPOINT {savepoint}")
            db.execute(f"RELEASE SAVEPOINT {savepoint}")
            receipt = record_stage(
                db, request_hash, "graph", action_key,
                {"triple": triple, "applied": False},
                "failed", applied_at_ms=applied_at_ms, error_code=str(error)[:80])
            outcomes.append({"ordinal": ordinal, "status": "failed",
                             "actionKey": action_key, "errorCode": str(error)[:80]})
    return outcomes


def apply_extract_threads_stage(db, request_hash, owner, text,
                                pending_items, *, session_id="",
                                applied_at_ms=None, now_ms=None):
    """Resolve first, then register each pending thread with action receipts."""
    if not db.in_transaction:
        fail("extract_transaction_required")
    binding = _binding(db, request_hash)
    applied_at_ms = applied_at_ms if applied_at_ms is not None else now_ms
    items = pending_items or []
    if not _integer(applied_at_ms, 1):
        fail("extract_clock_invalid")
    resolve_payload = {"text": text}
    resolve_hash = sha(compact(resolve_payload))
    prior = db.execute(
        f"SELECT payload_hash,status,result_json FROM {EXTRACT_STAGE_TABLE}"
        " WHERE request_hash=? AND stage='threads' AND action_key='resolve'",
        (request_hash,)).fetchone()
    if prior:
        if prior[0] != resolve_hash:
            fail("extract_stage_conflict")
        resolved = json.loads(prior[2]).get("resolved")
    else:
        resolved = threads.resolve_pending_thread_caller_owned(db, owner, text) if text else None
        record_stage(db, request_hash, "threads", "resolve",
                     resolve_payload, "committed",
                     applied_at_ms=applied_at_ms)
    outcomes = []
    if resolved is None and text:
        # Resolution absence is a valid no-op; actual errors would have raised.
        pass
    for ordinal, item in enumerate(items[:3]):
        action_key = f"thread:{ordinal}"
        payload = {"content": item.get("content"), "follow_up_after": item.get("follow_up_after", 0),
                   "kind": item.get("kind", ""), "sessionId": session_id}
        payload_hash = sha(compact(payload))
        prior = db.execute(
            f"SELECT payload_hash,status,result_json FROM {EXTRACT_STAGE_TABLE}"
            " WHERE request_hash=? AND stage='threads' AND action_key=?",
            (request_hash, action_key)).fetchone()
        if prior:
            if prior[0] != payload_hash:
                fail("extract_stage_conflict")
            if prior[1] == "committed":
                outcomes.append({"ordinal": ordinal, "status": "duplicate",
                                 "actionKey": action_key})
                continue
        try:
            thread_id, created = threads.remember_pending_thread_caller_owned(
                db, owner, item.get("content"), item.get("follow_up_after", 0),
                item.get("source_memory_id", 0), session_id, 120.0,
                item.get("kind", ""))
            receipt = record_stage(
                db, request_hash, "threads", action_key,
                payload,
                "committed", applied_at_ms=applied_at_ms)
            outcomes.append({"ordinal": ordinal, "status": "committed",
                             "actionKey": action_key})
        except sqlite3.Error:
            raise
        except Exception as error:
            receipt = record_stage(
                db, request_hash, "threads", action_key,
                payload, "failed", applied_at_ms=applied_at_ms,
                error_code=str(error)[:80])
            outcomes.append({"ordinal": ordinal, "status": "failed",
                             "actionKey": action_key, "errorCode": str(error)[:80]})
    return outcomes


def record_stage(db, request_hash, stage, action_key, payload, status,
                 *, applied_at_ms, error_code=None):
    if not db.in_transaction:
        fail("extract_transaction_required")
    if not isinstance(request_hash, str) or len(request_hash) != 64 \
            or not isinstance(stage, str) or not stage \
            or stage not in STAGES or not isinstance(action_key, str) \
            or not ACTION_RE.fullmatch(action_key) or status not in STAGE_STATUSES \
            or not _integer(applied_at_ms, 1):
        fail("extract_invalid_input")
    payload_json = compact(payload)
    payload_hash = sha(payload_json)
    row = db.execute(
        f"SELECT payload_hash,status,result_json,error_code FROM {EXTRACT_STAGE_TABLE}"
        " WHERE request_hash=? AND stage=? AND action_key=?",
        (request_hash, stage, action_key)).fetchone()
    if row:
        if row[0] != payload_hash:
            fail("extract_stage_conflict")
        if row[1] == status and row[2] == payload_json and row[3] == error_code:
            return {"status": "duplicate", "payloadHash": payload_hash}
        allowed = {("pending", "committed"), ("pending", "failed"),
                   ("pending", "unknown"), ("unknown", "committed")}
        if (row[1], status) in allowed:
            changed = db.execute(
                f"UPDATE {EXTRACT_STAGE_TABLE} SET status=?,result_json=?,error_code=?,"
                "applied_at_ms=? WHERE request_hash=? AND stage=? AND action_key=? AND status=?",
                (status, payload_json, error_code, applied_at_ms,
                 request_hash, stage, action_key, row[1])).rowcount
            if changed != 1:
                fail("extract_stage_transition_invalid")
            return {"status": "committed", "payloadHash": payload_hash}
        if row[1] == "committed" and status == "failed":
            fail("extract_stage_transition_invalid")
        fail("extract_stage_receipt_invalid")
    binding = _binding(db, request_hash)
    if binding[3] == "committed":
        fail("extract_request_already_committed")
    if binding[3] == "failed":
        fail("extract_request_failed")
    db.execute(
        f"INSERT INTO {EXTRACT_STAGE_TABLE}"
        " (request_hash,stage,action_key,payload_hash,status,result_json,error_code,applied_at_ms)"
        " VALUES (?,?,?,?,?,?,?,?)",
        (request_hash, stage, action_key, payload_hash, status, payload_json,
         error_code, applied_at_ms))
    return {"status": "committed", "payloadHash": payload_hash}


def aggregate_stage_statuses(rows):
    """Reduce every persisted action in each stage to one order-independent status."""
    grouped = {stage: [] for stage in STAGES}
    for stage, status in rows:
        if stage not in grouped or (status not in STAGE_STATUSES and status != "duplicate"):
            fail("extract_ack_stage_mismatch")
        grouped[stage].append(status)
    summary = {}
    for stage, statuses in grouped.items():
        if not statuses:
            summary[stage] = "pending"
        elif "unknown" in statuses:
            summary[stage] = "unknown"
        elif "failed" in statuses:
            summary[stage] = "failed"
        elif "partial" in statuses:
            summary[stage] = "partial"
        elif "pending" in statuses:
            summary[stage] = "pending"
        else:
            summary[stage] = "committed"
    return summary


def record_ack(db, request_hash, result, stage_summary, status,
               *, applied_at_ms, stale_skipped=0):
    if not db.in_transaction:
        fail("extract_transaction_required")
    binding = _binding(db, request_hash)
    if status not in EXTRACT_STATUSES or not _integer(applied_at_ms, 1) \
            or stale_skipped not in (0, 1):
        fail("extract_invalid_input")
    if status == "committed" and binding[3] not in ("partial", "started", "unknown"):
        if binding[3] == "committed":
            pass
        else:
            fail("extract_request_status_invalid")
    if status == "failed" and binding[3] != "started":
        fail("extract_request_status_invalid")
    if type(result) is not dict or set(result) not in (set(ACK_KEYS), set((*ACK_KEYS, *ACK_OPTIONAL_KEYS))):
        fail("extract_ack_invalid")
    if "hostVersion" in result:
        validate_host_version(result["hostVersion"])
    if type(stage_summary) is not dict or set(stage_summary) != set(STAGES):
        fail("extract_stage_summary_invalid")
    for stage, stage_status in stage_summary.items():
        if stage_status not in ("pending", "committed", "duplicate", "failed", "unknown", "partial"):
            fail("extract_stage_summary_invalid")
    rows = db.execute(
        f"SELECT stage,status FROM {EXTRACT_STAGE_TABLE} WHERE request_hash=?",
        (request_hash,)).fetchall()
    actual = aggregate_stage_statuses(rows)
    canonical_summary = {
        stage: "committed" if stage_status == "duplicate" else stage_status
        for stage, stage_status in stage_summary.items()
    }
    result_summary = result["stageStatuses"]
    if type(result_summary) is not dict or set(result_summary) != set(STAGES):
        fail("extract_stage_summary_invalid")
    canonical_result_summary = {
        stage: "committed" if stage_status == "duplicate" else stage_status
        for stage, stage_status in result_summary.items()
    }
    if canonical_summary != actual or canonical_result_summary != actual:
        fail("extract_ack_stage_mismatch")
    actual_complete = all(actual[stage] == "committed" for stage in STAGES)
    if status in ("committed", "duplicate") and not actual_complete:
        fail("extract_ack_stage_mismatch")
    if status in ("partial", "unknown") and actual_complete:
        fail("extract_ack_stage_mismatch")
    canonical_result = dict(result)
    canonical_result["stageStatuses"] = actual
    ack_json = compact(canonical_result)
    summary_json = compact(actual)
    result_hash = sha(ack_json)
    row = db.execute(
        f"SELECT result_hash,status,ack_json,stage_summary_json,stale_skipped "
        f"FROM {EXTRACT_ACK_TABLE} WHERE request_hash=?", (request_hash,)).fetchone()
    if row:
        if row[0] == result_hash and row[2] == ack_json and row[3] == summary_json:
            return {"status": "duplicate", "resultHash": result_hash,
                    "staleSkipped": row[4]}
        if row[1] in ("started", "partial", "unknown") \
                and status in ("partial", "committed", "unknown") \
                and (status != "committed" or actual_complete):
            db.execute(
                f"UPDATE {EXTRACT_ACK_TABLE} SET result_hash=?,status=?,ack_json=?,"
                "stage_summary_json=?,applied_at_ms=?,stale_skipped=? "
                "WHERE request_hash=? AND status=?",
                (result_hash, status, ack_json, summary_json, applied_at_ms,
                 stale_skipped, request_hash, row[1]))
            db.execute(
                f"UPDATE {EXTRACT_REQUEST_TABLE} SET status=?,result_hash=? "
                "WHERE request_hash=? AND status=?",
                (status, result_hash, request_hash, row[1]))
            return {"status": status, "resultHash": result_hash,
                    "staleSkipped": stale_skipped}
        fail("extract_ack_conflict")
    db.execute(
        f"INSERT INTO {EXTRACT_ACK_TABLE}"
        " (request_hash,result_hash,status,ack_json,stage_summary_json,applied_at_ms,stale_skipped)"
        " VALUES (?,?,?,?,?,?,?)",
        (request_hash, result_hash, status, ack_json, summary_json,
         applied_at_ms, stale_skipped))
    updated = db.execute(
        f"UPDATE {EXTRACT_REQUEST_TABLE} SET status=?,result_hash=? "
        "WHERE request_hash=? AND status IN ('started','partial','unknown')",
        (status, result_hash, request_hash)).rowcount
    if not updated:
        fail("extract_request_status_invalid")
    return {"status": status, "resultHash": result_hash,
            "staleSkipped": stale_skipped}
