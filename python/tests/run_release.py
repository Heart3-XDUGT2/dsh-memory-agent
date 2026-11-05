#!/usr/bin/env python3
"""Strict public Python baseline: synthetic storage, explicit nonbaseline tests.

Invoke through scripts/test-python.mjs. This does not run optional model or
private-snapshot controls, and does not count those controls as skipped/passed.
"""
from __future__ import annotations

import argparse
import ast
import hashlib
import json
import os
from pathlib import Path
import re
import runpy
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from urllib.parse import unquote, urlsplit

EXPECTED_ORIGINAL_PUBLIC = 753
EXPECTED_PUBLIC_CONTRACTS = {
    "test_graph_public_contracts": 5,
    "test_embed_public_contracts": 5,
}
EXPECTED_BASELINE = EXPECTED_ORIGINAL_PUBLIC + sum(EXPECTED_PUBLIC_CONTRACTS.values())
EXPECTED_MANUAL = 10
REJECTION_REASONS = frozenset({
    "nonlocal_sqlite_uri_forbidden", "empty_filesystem_path_forbidden",
    "invalid_release_path", "sqlite_outside_sandbox_forbidden",
    "runtime_file_read_outside_sandbox_forbidden", "source_metadata_read_forbidden",
    "file_read_outside_public_source_runtime_and_sandbox_forbidden",
    "file_write_outside_sandbox_forbidden", "filesystem_mutation_outside_sandbox_forbidden",
    "python_network_forbidden", "unguarded_process_forbidden", "shell_process_forbidden",
    "worker_environment_override_forbidden", "unexpected_child_process_forbidden",
})


class ReleaseIsolationError(PermissionError):
    """A rejected path is never opened or included in the error text."""


def parsed_path(value):
    if isinstance(value, int):
        return None
    value = os.fsdecode(value)
    if value == ":memory:":
        return None
    if value.startswith("file:"):
        parsed = urlsplit(value)
        if parsed.netloc not in ("", "localhost"):
            raise ReleaseIsolationError("nonlocal_sqlite_uri_forbidden")
        value = unquote(parsed.path)
        if os.name == "nt" and re.match(r"^/[A-Za-z]:", value):
            value = value[1:]
        if value == ":memory:":
            return None
    if not value:
        raise ReleaseIsolationError("empty_filesystem_path_forbidden")
    return Path(value).resolve(strict=False)


def install_guard(root, sandbox, runner):
    allowed = sandbox.resolve(strict=True)
    root = root.resolve(strict=True)
    original_connect = sqlite3.connect
    original_popen = subprocess.Popen
    counts = {"sqliteConnections": 0, "workerProcesses": 0, "blocked": 0, "localBlocked": 0}
    journal = allowed / "python-release-guard-violations.jsonl"
    runtime_roots = {Path(value).resolve() for value in (sys.base_prefix, sys.prefix, sys.exec_prefix)}

    def inside(target):
        return target == allowed or allowed in target.parents

    def reject(reason):
        if reason not in REJECTION_REASONS:
            raise RuntimeError("unknown_guard_violation_reason")
        counts["localBlocked"] += 1
        counts["blocked"] += 1
        record = (json.dumps({"pid": os.getpid(), "reason": reason}, sort_keys=True) + "\n").encode("ascii")
        # A single append writes each fixed symbolic record. This shared owned
        # journal survives caught exceptions and workers terminated by tests.
        descriptor = os.open(journal, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
        try:
            if os.write(descriptor, record) != len(record):
                raise RuntimeError("guard_violation_journal_write_incomplete")
        finally:
            os.close(descriptor)
        raise ReleaseIsolationError(reason)

    def guarded_path(value):
        try:
            return parsed_path(value)
        except ReleaseIsolationError as error:
            reject(str(error))
        except (ValueError, OSError, TypeError):
            reject("invalid_release_path")

    def require_inside(value, reason):
        target = guarded_path(value)
        if target is not None and not inside(target):
            reject(reason)
        return target

    def connect(database, *args, **kwargs):
        require_inside(database, "sqlite_outside_sandbox_forbidden")
        counts["sqliteConnections"] += 1
        return original_connect(database, *args, **kwargs)

    def runtime_file(target):
        name = target.name.lower()
        return (
            re.search(r"\.(?:db|sqlite(?:3)?)(?:-.*)?$", name) is not None
            or name in {
                "config.json", "profile.json", "persona.json", "names.json",
                "aliases.json", "graph.json", "lexicon.json", "state-defaults.json",
                "data-rev.json", "embed-state.json", "credentials.json", "tokens.json",
            }
            or name.startswith(".env")
        )

    def readable(value):
        target = guarded_path(value)
        if target is None:
            return
        if inside(target):
            return
        if target == Path(os.devnull).resolve():
            return
        if runtime_file(target):
            reject("runtime_file_read_outside_sandbox_forbidden")
        if target == runner:
            return
        if root == target or root in target.parents:
            if {part.lower() for part in target.relative_to(root).parts} & {
                ".git", "node_modules", ".scratch", ".dev-host",
            }:
                reject("source_metadata_read_forbidden")
            return
        if any(base == target or base in target.parents for base in runtime_roots):
            return
        reject("file_read_outside_public_source_runtime_and_sandbox_forbidden")

    def audit(event, args):
        if event == "sqlite3.connect":
            require_inside(args[0], "sqlite_outside_sandbox_forbidden")
        elif event == "open":
            filename, mode, flags = args
            if isinstance(filename, int):
                return
            target = guarded_path(filename)
            if target is None:
                return
            writes = bool(
                isinstance(mode, str) and any(part in mode for part in "wax+")
                or isinstance(flags, int) and flags & (
                    os.O_WRONLY | os.O_RDWR | os.O_CREAT | os.O_TRUNC | os.O_APPEND
                )
            )
            if not inside(target) and writes:
                reject("file_write_outside_sandbox_forbidden")
            if not writes:
                readable(filename)
        elif event in {"os.listdir", "os.scandir"}:
            if args and args[0] is not None:
                readable(args[0])
        elif event in {"os.remove", "os.rmdir", "os.mkdir", "os.chmod", "os.utime"}:
            require_inside(args[0], "filesystem_mutation_outside_sandbox_forbidden")
        elif event in {"os.rename", "os.link", "os.symlink"}:
            require_inside(args[0], "filesystem_mutation_outside_sandbox_forbidden")
            require_inside(args[1], "filesystem_mutation_outside_sandbox_forbidden")
        elif event in {"socket.connect", "socket.bind", "socket.getaddrinfo"}:
            reject("python_network_forbidden")
        elif event in {"os.system", "os.exec", "os.posix_spawn"}:
            reject("unguarded_process_forbidden")
        elif event == "subprocess.Popen":
            executable, command, cwd, environment = args
            expected = [
                sys.executable, "-I", "-S", "-B", str(runner), "--guard-child",
                "--root", str(root), "--sandbox", str(allowed),
            ]
            # Windows audits after converting argv through list2cmdline; POSIX
            # audits the argv list. Both representations must match in full.
            if os.name == "nt":
                command_matches = isinstance(command, str) and command == subprocess.list2cmdline(expected)
            else:
                command_matches = isinstance(command, (list, tuple)) and list(command) == expected
            if (
                not command_matches or executable not in (None, sys.executable)
                or cwd is None or environment is not None
            ):
                reject("unguarded_process_forbidden")
            if guarded_path(cwd) != allowed:
                reject("unguarded_process_forbidden")

    class GuardedPopen(original_popen):
        # Keep the class shape: asyncio.windows_utils subclasses Popen on import.
        def __init__(self, command, *args, **kwargs):
            self._child_created = False
            worker = root / "python" / "worker.py"
            if (
                isinstance(command, (list, tuple))
                and len(command) == 2
                and Path(command[0]).resolve() == Path(sys.executable).resolve()
                and Path(command[1]).resolve() == worker
            ):
                if kwargs.get("shell"):
                    reject("shell_process_forbidden")
                if kwargs.get("env") is not None:
                    reject("worker_environment_override_forbidden")
                kwargs["cwd"] = str(allowed)
                counts["workerProcesses"] += 1
                command = [
                    sys.executable, "-I", "-S", "-B", str(runner), "--guard-child",
                    "--root", str(root), "--sandbox", str(allowed),
                ]
            else:
                reject("unexpected_child_process_forbidden")
            super().__init__(command, *args, **kwargs)

    sqlite3.connect = connect
    subprocess.Popen = GuardedPopen
    sys.addaudithook(audit)

    def synchronize_counts():
        records = []
        if journal.exists():
            for line in journal.read_bytes().splitlines():
                record = json.loads(line)
                if (
                    not isinstance(record, dict) or set(record) != {"pid", "reason"}
                    or not isinstance(record["pid"], int) or record["pid"] <= 0
                    or record["reason"] not in REJECTION_REASONS
                ):
                    raise RuntimeError("guard_violation_journal_invalid")
                records.append(record)
        if sum(record["pid"] == os.getpid() for record in records) != counts["localBlocked"]:
            raise RuntimeError("guard_violation_journal_missing_records")
        counts["blocked"] = len(records)
        counts["processesWithViolations"] = len({record["pid"] for record in records})
        return records

    return counts, original_connect, synchronize_counts


def flatten(suite):
    for item in suite:
        if isinstance(item, unittest.TestSuite):
            yield from flatten(item)
        else:
            yield item


def call_name(node):
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        return call_name(node.value) + "." + node.attr
    if isinstance(node, ast.Call):
        return call_name(node.func) + "()"
    return "<expression>"


class ModuleEffects(ast.NodeVisitor):
    """Class bodies/defaults/decorators execute at import; function bodies do not."""
    def __init__(self, file):
        self.file = file
        self.calls = []
        self.imports = []
        self.effects = []

    def visit_Call(self, node):
        function = call_name(node.func)
        category = "module-call"
        if function.endswith((".read_text", ".read_bytes")) or function in ("open", "io.open"):
            category = "filesystem-read"
        if function.endswith((".write_text", ".write_bytes", ".mkdir", ".unlink", ".rename", ".replace")):
            category = "filesystem-mutation"
        if function.endswith((".connect", ".backup")):
            category = "database-or-network"
        if function in ("subprocess.Popen", "subprocess.run", "os.system"):
            category = "process-start"
        self.calls.append({"file": self.file, "line": node.lineno, "function": function, "category": category})
        self.generic_visit(node)

    def visit_Import(self, node):
        for alias in node.names:
            self.imports.append({"file": self.file, "line": node.lineno, "module": alias.name})

    def visit_ImportFrom(self, node):
        self.imports.append({"file": self.file, "line": node.lineno, "module": "." * node.level + (node.module or "")})

    def visit_FunctionDef(self, node):
        for item in node.decorator_list + node.args.defaults + [value for value in node.args.kw_defaults if value is not None]:
            self.visit(item)

    visit_AsyncFunctionDef = visit_FunctionDef

    def visit_Assign(self, node):
        for target in node.targets:
            if isinstance(target, ast.Subscript) and call_name(target.value) == "os.environ":
                self.effects.append({"file": self.file, "line": node.lineno, "effect": "environment-write"})
        self.generic_visit(node)


def source_audit(root):
    sources, calls, imports, effects = [], [], [], []
    python = root / "python"
    # test_retrieval_bench_dense imports this real script via exec_module at
    # module scope. It is part of the source-review closure, not a CLI run.
    extra = [root / "scripts" / "retrieval-bench.py"]
    for file in sorted([*python.rglob("*.py"), *extra]):
        relative = file.relative_to(root).as_posix()
        if "__pycache__" in file.parts:
            continue
        if file.is_symlink() or root not in file.resolve().parents:
            raise RuntimeError("linked_python_source_forbidden")
        data = file.read_bytes()
        tree = ast.parse(data.decode("utf-8"), filename=relative)
        visitor = ModuleEffects(relative)
        visitor.visit(tree)
        sources.append({"file": relative, "sha256": hashlib.sha256(data).hexdigest(),
                        "scope": "manual-not-imported" if relative.startswith("python/manual/") else "public-baseline"})
        calls.extend(visitor.calls)
        imports.extend(visitor.imports)
        effects.extend(visitor.effects)
    value = {"sources": sources, "moduleCalls": calls, "moduleImports": imports, "moduleEffects": effects}
    serialized = json.dumps(value, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return {**value, "auditSha256": hashlib.sha256(serialized).hexdigest(), "executed": 0}


def manual_inventory(root):
    manifest = root / "python" / "manual" / "INVENTORY.json"
    value = json.loads(manifest.read_text(encoding="utf-8"))
    tests = value.get("tests")
    if not isinstance(tests, list) or len(tests) != EXPECTED_MANUAL:
        raise RuntimeError("manual_inventory_changed")
    if len({item.get("id") for item in tests}) != EXPECTED_MANUAL:
        raise RuntimeError("manual_inventory_duplicate")
    for item in tests:
        if not isinstance(item.get("id"), str) or not isinstance(item.get("reason"), str) or not item["reason"]:
            raise RuntimeError("manual_inventory_invalid")
        module = item.get("module")
        if not isinstance(module, str):
            raise RuntimeError("manual_inventory_module_missing")
        source = (root / module).resolve(strict=True)
        if source.suffix != ".py" or root / "python" / "manual" not in source.parents:
            raise RuntimeError("manual_inventory_module_invalid")
        tree = ast.parse(source.read_text(encoding="utf-8"), filename=module)
        identity = item["id"].split(".")
        if len(identity) != 3:
            raise RuntimeError("manual_inventory_id_invalid")
        _, classname, method = identity
        declarations = [
            function.name
            for cls in tree.body if isinstance(cls, ast.ClassDef) and cls.name == classname
            for function in cls.body if isinstance(function, ast.FunctionDef)
        ]
        if method not in declarations or not method.startswith("test_"):
            raise RuntimeError("manual_inventory_method_missing")
    return [{**item, "status": "NOT_RUN_MANUAL"} for item in tests]


def guard_controls(root, sandbox, outside, original_connect, counts, synchronize_counts):
    """Synthetic negative controls; forbidden targets are not real home paths."""
    import hashlib
    import importlib.util
    import socket
    checks = []
    worker_proof = {}

    def check(name, call, denied=False):
        try:
            call()
        except ReleaseIsolationError:
            if not denied:
                raise
        else:
            if denied:
                raise AssertionError("guard_negative_control_failed")
        checks.append(name)

    # The Node parent owns existing synthetic sentinels outside this sandbox.
    # The Python child must refuse access before opening any of them.
    check("sqlite absolute outside refused", lambda: sqlite3.connect(str(outside / "echo.db")), True)
    check("sqlite readonly URI outside refused", lambda: sqlite3.connect((outside / "echo.db").as_uri() + "?mode=ro", uri=True), True)
    check("native sqlite audit path outside refused", lambda: original_connect(str(outside / "echo.db")), True)
    check("runtime file outside refused", lambda: open(outside / "config.json", "rb"), True)
    check("ordinary readonly text outside refused", lambda: open(outside / "ordinary.txt", "rb"), True)
    check("model binary outside refused", lambda: open(outside / "model.onnx", "rb"), True)
    check("ordinary write outside refused", lambda: open(outside / "ordinary.txt", "wb"), True)
    check("ordinary mkdir outside refused", lambda: os.mkdir(outside / "created"), True)
    check("unexpected child process refused", lambda: subprocess.Popen([sys.executable, "-c", "pass"]), True)
    check("in-memory SQLite allowed", lambda: sqlite3.connect(":memory:").close())
    local = sandbox / "guard-control.db"
    check("owned SQLite allowed", lambda: sqlite3.connect(str(local)).close())
    local_text = sandbox / "guard-control.txt"
    check("owned file write allowed", lambda: local_text.write_text("synthetic", encoding="utf-8"))
    if hashlib.sha256(local_text.read_bytes()).hexdigest() != hashlib.sha256(b"synthetic").hexdigest():
        raise AssertionError("guard_owned_file_changed")

    # Execute a synthetic module exactly as an import loader would. The outside
    # target is injected in memory; neither paths nor sentinel data enter source
    # text or the emitted proof.
    import_source = sandbox / "guard-import-outside.py"
    import_source.write_text(
        "before_open = True\n"
        "with open(control_target, 'rb') as control_stream:\n"
        "    control_payload = control_stream.read()\n"
        "after_read = True\n",
        encoding="utf-8",
    )
    import_spec = importlib.util.spec_from_file_location("_echo_guard_import_control", import_source)
    if import_spec is None or import_spec.loader is None:
        raise RuntimeError("guard_import_control_loader_missing")
    import_module = importlib.util.module_from_spec(import_spec)
    import_module.control_target = outside / "ordinary.txt"
    check("import-time outside readonly access refused", lambda: import_spec.loader.exec_module(import_module), True)
    if getattr(import_module, "before_open", False) is not True or hasattr(import_module, "after_read"):
        raise RuntimeError("guard_import_control_reached_read")

    # AI_NUMERICHOST guarantees that this audited network API cannot issue DNS
    # or other network traffic even if a future regression removed the guard.
    check(
        "network address lookup refused before resolution",
        lambda: socket.getaddrinfo("127.0.0.1", 0, flags=socket.AI_NUMERICHOST),
        True,
    )

    backup_steps = {"sourceConnected": False, "backupInvoked": False}
    destination = sqlite3.connect(":memory:")
    try:
        def outside_readonly_backup():
            source = original_connect((outside / "echo.db").as_uri() + "?mode=ro", uri=True)
            backup_steps["sourceConnected"] = True
            try:
                backup_steps["backupInvoked"] = True
                source.backup(destination)
            finally:
                source.close()

        check("readonly outside source backup refused before source open", outside_readonly_backup, True)
        destination_empty = destination.execute("SELECT COUNT(*) FROM sqlite_master").fetchone()[0] == 0
        if any(backup_steps.values()) or not destination_empty:
            raise RuntimeError("guard_backup_control_reached_source")
    finally:
        destination.close()

    def caught_worker_violation():
        # Spawn the one allowed production worker through GuardedPopen. Its
        # verify_db catches the denial; pong proves that the worker continued.
        # Embed state publication is redirected into this same owned sandbox.
        off_config = sandbox / "guard-worker-off-config.json"
        off_config.write_text('{"embedWarmup":false}\n', encoding="utf-8")
        owned_model = sandbox / "models" / "synthetic"
        owned_model.mkdir(parents=True, exist_ok=True)
        overrides = {
            "ECHO_EMBED_WARMUP": "0",
            "ECHO_EMBED_WARMUP_CONFIG": str(off_config),
            "ECHO_EMBED_MODEL_DIR": str(owned_model),
        }
        previous = {key: os.environ.get(key) for key in overrides}
        records_before = synchronize_counts()
        child = None
        try:
            os.environ.update(overrides)
            child = subprocess.Popen(
                [sys.executable, str(root / "python" / "worker.py")],
                stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                text=True, encoding="utf-8",
            )
            frames = [
                {"reqId": 1, "type": "hello", "protocol": "echo_wire_v1", "dbPath": str(outside / "echo.db")},
                {"reqId": 2, "type": "ping"},
                {"reqId": 3, "type": "shutdown"},
            ]
            try:
                protocol_output, diagnostic_output = child.communicate(
                    "".join(json.dumps(frame) + "\n" for frame in frames), timeout=10,
                )
            except subprocess.TimeoutExpired:
                child.kill()
                child.communicate(timeout=5)
                raise RuntimeError("guard_worker_control_timeout") from None
            try:
                responses = [json.loads(line) for line in protocol_output.splitlines() if line.strip()]
            except (ValueError, TypeError):
                raise RuntimeError("guard_worker_control_protocol_invalid") from None
            # Do not expose frames: ready includes the synthetic outside path.
            if (
                len(responses) != 3
                or not all(isinstance(response, dict) for response in responses)
                or responses[0].get("type") != "ready" or responses[0].get("reqId") != 1
                or responses[0].get("db", {}).get("ok") is not False
                or responses[0].get("db", {}).get("error") != "sqlite_outside_sandbox_forbidden"
                or responses[1].get("type") != "pong" or responses[1].get("reqId") != 2
                or responses[2].get("type") != "bye" or responses[2].get("reqId") != 3
                or child.returncode == 0
            ):
                raise RuntimeError("guard_worker_control_caught_violation_missing")
            child_guard_failure = False
            for line in diagnostic_output.splitlines():
                try:
                    diagnostic = json.loads(line)
                except ValueError:
                    continue
                if isinstance(diagnostic, dict) and diagnostic.get("error") == "guard_child_violation_recorded":
                    child_guard_failure = diagnostic.get("passed") is False
            records_after = synchronize_counts()
            child_records = [record for record in records_after if record["pid"] == child.pid]
            if (
                not child_guard_failure or len(records_after) != len(records_before) + 1
                or len(child_records) != 1 or child_records[0]["reason"] != "sqlite_outside_sandbox_forbidden"
            ):
                raise RuntimeError("guard_worker_control_shared_journal_missing")
            worker_proof.update({
                "caughtOutsideSqlite": True, "continuedWithPong": True,
                "childExitNonzero": True, "sharedJournalPersisted": True,
                "protocolParsedAndDiscarded": True,
            })
        finally:
            try:
                if child is not None and child.poll() is None:
                    child.kill()
                    child.communicate(timeout=5)
            finally:
                for key, value in previous.items():
                    if value is None:
                        os.environ.pop(key, None)
                    else:
                        os.environ[key] = value
        if any(os.environ.get(key) != value for key, value in previous.items()):
            raise RuntimeError("guard_worker_control_environment_not_restored")
        worker_proof["environmentRestored"] = True

    check("allowed worker caught outside denial and shared journal persisted", caught_worker_violation)
    return {
        "passed": True, "checks": len(checks), "names": checks, "blocked": counts["blocked"],
        "localBlocked": counts["localBlocked"], "workerProcesses": counts["workerProcesses"],
        "importReadRefusedBeforeOpen": True, "networkCallRefusedBeforeResolution": True,
        "readonlyBackupRefusedBeforeSourceOpen": True, "workerProof": worker_proof,
    }


def main():
    # Node decodes captured output as UTF-8 on every Windows locale.
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", required=True)
    parser.add_argument("--sandbox", required=True)
    parser.add_argument("--list", action="store_true")
    parser.add_argument("--audit-only", action="store_true")
    parser.add_argument("--guard-selftest", action="store_true")
    parser.add_argument("--guard-child", action="store_true")
    parser.add_argument("--outside-control")
    options = parser.parse_args()
    root = Path(options.root).resolve(strict=True)
    sandbox = Path(options.sandbox).resolve(strict=True)
    runner = Path(__file__).resolve(strict=True)
    if sandbox == root or root in sandbox.parents or sandbox in root.parents:
        raise RuntimeError("sandbox_must_be_separate_from_source")
    outside = None
    if options.guard_selftest:
        if not options.outside_control or options.guard_child:
            raise RuntimeError("guard_selftest_requires_parent_outside_control")
        try:
            outside = Path(options.outside_control)
            if not outside.is_absolute():
                raise RuntimeError("guard_outside_control_invalid")
            outside = outside.resolve(strict=True)
            if not outside.is_dir() or any(
                outside == base or outside in base.parents or base in outside.parents
                for base in (root, sandbox)
            ):
                raise RuntimeError("guard_outside_control_invalid")
        except (OSError, ValueError):
            raise RuntimeError("guard_outside_control_invalid") from None
    elif options.outside_control is not None:
        raise RuntimeError("outside_control_selftest_only")
    if Path.cwd().resolve() != sandbox:
        raise RuntimeError("python_cwd_must_be_owned_sandbox")
    if not sys.flags.isolated or not sys.flags.no_site or not sys.flags.dont_write_bytecode:
        raise RuntimeError("python_requires_isolated_no_site_no_bytecode_flags")
    if sys.version_info[:2] != (3, 14):
        raise RuntimeError("python_release_baseline_requires_3_14")
    for key in ("DSH_HOME", "DSH_DATA_DIR", "HOME", "USERPROFILE", "TEMP", "TMP", "TMPDIR"):
        target = Path(os.environ[key]).resolve(strict=True)
        if target != sandbox and sandbox not in target.parents:
            raise RuntimeError("python_environment_escaped_sandbox")
    combined_home = Path(os.environ["HOMEDRIVE"] + os.environ["HOMEPATH"]).resolve(strict=True)
    if combined_home != sandbox and sandbox not in combined_home.parents:
        raise RuntimeError("python_combined_home_escaped_sandbox")
    tempfile.tempdir = str(sandbox)
    sys.path[:0] = [str(root / "python"), str(root / "python" / "tests")]
    counts, original_connect, synchronize_counts = install_guard(root, sandbox, runner)
    if options.guard_child:
        try:
            sys.argv = [str(root / "python" / "worker.py")]
            runpy.run_path(sys.argv[0], run_name="__main__")
        finally:
            if counts["localBlocked"]:
                raise ReleaseIsolationError("guard_child_violation_recorded")
        return 0
    if options.guard_selftest:
        controls = guard_controls(root, sandbox, outside, original_connect, counts, synchronize_counts)
        synchronize_counts()
        if (
            controls["checks"] != 16 or counts["blocked"] != 13
            or counts["localBlocked"] != 12 or counts["workerProcesses"] != 1
            or counts["processesWithViolations"] != 2 or counts["blocked"] != controls["blocked"]
        ):
            raise RuntimeError("guard_selftest_journal_count_mismatch")
        print(json.dumps({
            **controls, "journalRecords": counts["blocked"],
            "journalProcesses": counts["processesWithViolations"],
        }, sort_keys=True))
        return 0
    audit = source_audit(root)
    (sandbox / "python-source-audit.json").write_text(json.dumps(audit, indent=2) + "\n", encoding="utf-8")
    if options.audit_only:
        print(json.dumps({
            "mode": "AST_PREFLIGHT_ONLY", "executed": 0, "auditSha256": audit["auditSha256"],
            "sourceFiles": len(audit["sources"]), "moduleCalls": len(audit["moduleCalls"]),
            "moduleImports": len(audit["moduleImports"]), "moduleEffects": len(audit["moduleEffects"]),
        }, sort_keys=True))
        return 0
    policy = json.loads((root / "python" / "tests" / "release-ast-policy.json").read_text(encoding="utf-8"))
    if policy.get("auditSha256") != audit["auditSha256"]:
        raise RuntimeError("python_source_audit_not_reviewed")
    not_run = manual_inventory(root)
    loader = unittest.TestLoader()
    suite = loader.discover(str(root / "python" / "tests"), pattern="test_*.py")
    tests = list(flatten(suite))
    synchronize_counts()
    if counts["blocked"]:
        raise RuntimeError("python_guard_violation_recorded")
    public_contract_counts = {
        module: sum(case.id().split(".")[0] == module for case in tests)
        for module in EXPECTED_PUBLIC_CONTRACTS
    }
    original_public_count = len(tests) - sum(public_contract_counts.values())
    if len(tests) != EXPECTED_BASELINE or any(
        marker in case.id() for case in tests for marker in ("EmbedWithDeps", "ContractReconcile")
    ) or loader.errors or public_contract_counts != EXPECTED_PUBLIC_CONTRACTS or original_public_count != EXPECTED_ORIGINAL_PUBLIC:
        (sandbox / "python-inventory-error.json").write_text(json.dumps({
            "ids": [case.id() for case in tests], "loaderErrors": loader.errors,
            "totalDiscovered": len(tests), "executed": 0, "guard": counts,
        }, indent=2) + "\n", encoding="utf-8")
        raise RuntimeError("public_python_inventory_changed")
    baseline = tests
    report = {
        "schema": 1, "totalDiscovered": len(tests), "baselineSelected": len(baseline),
        "baselineComposition": {
            "originalPublic": original_public_count, "newSyntheticContracts": public_contract_counts,
            "manualControlsReintroduced": 0,
        },
        "notRun": not_run, "notRunCount": len(not_run), "baselineIds": [case.id() for case in baseline],
        "privateSnapshotControlsReplayed": False, "actualModelTestsExecuted": False,
        "guardInstalledBeforeDiscovery": True, "sourceMutationsAllowed": False,
        "guard": counts, "sourceAuditSha256": audit["auditSha256"],
    }
    if options.list:
        report.update({"mode": "list-only", "executed": 0, "passed": False})
    else:
        result = unittest.TextTestRunner(verbosity=2).run(unittest.TestSuite(baseline))
        synchronize_counts()
        passed = (
            result.wasSuccessful() and not result.skipped
            and not result.expectedFailures and not result.unexpectedSuccesses
            and result.testsRun == EXPECTED_BASELINE and counts["blocked"] == 0
        )
        report.update({
            "mode": "public-baseline", "executed": result.testsRun,
            "failures": len(result.failures), "errors": len(result.errors),
            "skipped": len(result.skipped), "expectedFailures": len(result.expectedFailures),
            "unexpectedSuccesses": len(result.unexpectedSuccesses), "passed": passed,
        })
    (sandbox / "python-release-result.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    summary = {key: value for key, value in report.items() if key not in ("baselineIds", "notRun")}
    print(json.dumps(summary, sort_keys=True))
    for item in not_run:
        print("NOT_RUN_MANUAL " + item["id"] + " :: " + item["reason"])
    return 0 if options.list or report["passed"] else 1


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (ReleaseIsolationError, RuntimeError) as error:
        # Fixed symbolic reasons only; do not echo external paths or file data.
        print(json.dumps({"passed": False, "error": str(error)}), file=sys.stderr)
        raise SystemExit(1)
