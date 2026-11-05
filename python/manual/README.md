# Manual controls outside the public baseline

The public `python/tests/test_*.py` inventory contains 753 existing safe tests
plus ten new synthetic contract cases, for 763 public cases. An inventory is
not a test result. The ten original controls listed in `INVENTORY.json` are
outside discovery and are **NOT RUN** by the public command. They are not
counted as passes or unittest skips.

These files preserve the original five actual-model tests and five historical
snapshot tests, including their original assertions. No historical snapshot is
distributed or reconstructed. The historical `94 → 42` and `30 → 5` checks have
not been replaced by synthetic numbers.

Only an operator who possesses the required input can choose to execute them:

```text
python -I -B python/manual/verify_embed.py --model-dir <explicit-existing-model-directory>
python -I -B python/manual/verify_snapshot.py --snapshot <explicit-historical-snapshot> --accept-private-historical-input
```

Neither command has a model, database or user-home default. Missing arguments
fail before loading engine code; missing inputs or dependencies fail rather
than silently passing. Any unittest skip makes the manual command fail.

The model command uses actual ONNX dependencies and model files. Only the
checkpoint destination is redirected to the command's synthetic temporary
directory. The snapshot command permits SQLite reads of the explicitly
supplied file only through a read-only URI. Other SQLite paths and all writes
must remain in its own temporary directory; network access is disabled.

Do not upload private models, snapshots, database fragments or output containing
personal data to issues or source control. The release work did not execute
either manual verifier.
