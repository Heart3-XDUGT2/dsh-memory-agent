"""Private worker-lifetime registry for verified immutable snapshot readers."""
from __future__ import annotations

import hashlib
import re

from .memory_snapshot_export import (
    SnapshotExportError, close_snapshot_export, open_snapshot_export,
    receipt_summary,
)

MAX_HANDLES = 8
MAX_CLOSED = 64
MAX_HANDLE_LENGTH = 128
HASH_FIELDS = ("ownerHash", "turnHash", "attemptHash", "tokenHash",
               "schemaHash", "contentHash")


class SnapshotRegistryError(Exception):
    pass


def _fail(reason):
    raise SnapshotRegistryError(reason)


def _hash(value, name):
    if (not isinstance(value, str) or re.fullmatch(r"[a-f0-9]{64}", value) is None
            or value == "0" * 64):
        _fail("snapshot_" + name + "_invalid")
    return value


def _handle_hash(value):
    if not isinstance(value, str) or not value or len(value) > MAX_HANDLE_LENGTH:
        _fail("snapshot_handle_invalid")
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


class SnapshotHandleRegistry:
    def __init__(self, max_handles=MAX_HANDLES):
        self._handles = {}
        self._closed = {}
        self._max = max_handles if isinstance(max_handles, int) and 1 <= max_handles <= MAX_HANDLES else MAX_HANDLES

    def _summary(self, status, reason, handle_hash, receipt=None):
        return {
            "status": status,
            "reason": reason,
            "handleHash": handle_hash,
            "receipt": receipt if receipt is not None else {
                "status": "no-go", "reason": reason, "kind": None,
                "tokenHash": None, "schemaHash": None, "contentHash": None,
                "ownerHash": None, "turnHash": None, "attemptHash": None,
            },
        }

    def install(self, frame):
        if not isinstance(frame, dict):
            return self._summary("no-go", "snapshot_handle_invalid", None)
        try:
            handle = frame.get("handle")
            handle_hash = _handle_hash(handle)
            if handle_hash in self._closed:
                return self._summary("no-go", "snapshot_handle_closed", handle_hash)
            receipt = frame.get("receipt")
            path = frame.get("path")
            if not isinstance(path, str) or not path or len(path) > 1024 or re.search(r"[\x00-\x1f\x7f]", path):
                return self._summary("no-go", "snapshot_path_invalid", handle_hash)
            if not isinstance(receipt, dict):
                return self._summary("no-go", "snapshot_receipt_invalid", handle_hash)
            for field in HASH_FIELDS:
                _hash(receipt.get(field), field)
                if receipt[field] != frame.get(field):
                    return self._summary("no-go", "snapshot_scope_mismatch", handle_hash)
            existing = self._handles.get(handle)
            if existing is not None:
                if existing.get("closing") or existing["path"] != path or existing["receipt"] != receipt:
                    return self._summary("no-go", "snapshot_handle_conflict", handle_hash)
                return self._summary("duplicate", "snapshot_handle_duplicate", handle_hash,
                                     receipt_summary(existing["reader"]))
            elif len(self._handles) >= self._max:
                return self._summary("no-go", "snapshot_handle_capacity", handle_hash)
            try:
                reader = open_snapshot_export(path, receipt)
            except SnapshotExportError as error:
                return self._summary("no-go", str(error), handle_hash)
            self._handles[handle] = {
                "reader": reader, "handleHash": handle_hash,
                "path": path, "receipt": receipt,
                "bindings": {field: receipt[field] for field in HASH_FIELDS},
            }
            return self._summary("ready", None, handle_hash, receipt_summary(reader))
        except SnapshotRegistryError as error:
            return self._summary("no-go", str(error), None)
        except (OSError, TypeError, ValueError):
            return self._summary("no-go", "snapshot_install_failed", None)

    def close(self, frame):
        try:
            handle = frame.get("handle") if isinstance(frame, dict) else None
            handle_hash = _handle_hash(handle)
        except SnapshotRegistryError as error:
            return self._summary("no-go", str(error), None)
        item = self._handles.get(handle)
        if item is None:
            return self._summary("closed", "snapshot_handle_already_closed", handle_hash)
        item["closing"] = True
        close_snapshot_export(item["reader"])
        del self._handles[handle]
        self._closed[handle_hash] = None
        if len(self._closed) > MAX_CLOSED:
            del self._closed[next(iter(self._closed))]
        return self._summary("closed", None, handle_hash)

    def get(self, handle, bindings=None):
        try:
            _handle_hash(handle)
        except SnapshotRegistryError as error:
            return None, str(error)
        item = self._handles.get(handle)
        if item is None or item.get("closing"):
            return None, "snapshot_handle_invalid"
        supplied = bindings if isinstance(bindings, dict) else {}
        for field in HASH_FIELDS[:3]:
            if supplied.get(field) != item["bindings"][field]:
                return None, "snapshot_scope_mismatch"
        return item, None

    def close_all(self):
        for item in self._handles.values():
            close_snapshot_export(item["reader"])
        self._handles.clear()
        self._closed.clear()

    def __len__(self):
        return len(self._handles)
