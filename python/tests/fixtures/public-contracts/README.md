# Public synthetic contract fixtures

These are ten **new** public cases: five graph reconciliation cases and five
embedding adapter cases. They do not replay historical private data or an actual
embedding model. The original five historical and five actual-model controls
remain outside public discovery in `python/manual/`, with their original
assertions, and have not been run for this work.

The proposed public inventory is 753 existing public cases plus these 10 new
synthetic cases: 763. This arithmetic is an inventory proposal, not a test result.
Source review and policy approval must precede test execution.

## Graph snapshot

`test_graph_public_contracts.py` constructs a fresh database in its own
`TemporaryDirectory`. The database is closed before production
`graph_mine.dry_run()` opens it through the production read-only path. No fixture
database, user home, configuration, profile, or external snapshot is read.

Six invented nodes exist: speaker S (`Speaker-Synthetic`), concepts A/B/C
(`Quartz-Alpha`, `Quartz-Beta`, `Quartz-Gamma`), an alias-key concept
(`Alias-Alpha` -> A), and an episode node (`EpisodeOnly`). Alias-key and episode
nodes must not become concept endpoints.

Nine memory rows are inserted:

| ID | Local date | Text hits that can become endpoints | Active/status |
| --- | --- | --- | --- |
| 11 | 2024-02-04 | S, A, B | 1 / active |
| 12 | 2024-02-04 | C | 1 / active |
| 13 | 2024-02-04 | alias-key and episode only | 1 / active |
| 21 | 2024-02-05 | A | 1 / active |
| 22 | 2024-02-05 | B, C | 1 / active |
| 31 | 2024-02-06 | S, A, B, C | 0 / active |
| 32 | 2024-02-06 | S, A, B, C | 1 / archived |
| 33 | 2024-02-06 | null summary | 1 / active |
| 34 | 2024-02-06 | empty summary | 1 / active |

Dates are built with the standard library's local `mktime`, at daytime hours,
and production groups by the matching local dates. No fixed timezone is assumed.

Independent handwritten expectations:

| Scope | Explicit pair inventory | Speaker exclusions | Accepted |
| --- | --- | --- | --- |
| Same memory | SA, SB, AB from memory 11; BC from memory 22 | SA, SB: 2 | AB, BC: 2 |
| Same day | SA, SB, SC, AB, AC, BC on day 4; AB, AC, BC repeat on day 5 | SA, SB, SC: 3 | AB, AC, BC: 3 |
| Both kinds | Four plus six candidates, distinct relation namespaces | Two plus three: 5 | Two plus three: 5 |

Same-day AC has A evidence `[11,21]` and C evidence `[12,22]`. Both sides are
nonempty and disjoint, so a kind-aware same-day R2 accepts it; an empty side
still fails R2. Same-memory AB has evidence `[11]`; replacing its B evidence
with `[88]` must fail the same-memory intersection rule.

Four existing graph edges are inserted: active S->A fact, active same-day AB,
active B->C fact, and inactive S->C fact. Thus three edges are initially active,
two without S. The existing same-day AB is exactly one accepted-slot collision:

| Scope | Active after | Active without S after | Collision count |
| --- | --- | --- | --- |
| Same day | 3 existing + 2 fresh = 5 | 2 existing + 2 fresh = 4 | 1 |
| Same memory | 3 existing + 2 fresh = 5 | 2 existing + 2 fresh = 4 | 0 |
| Both kinds | 3 existing + 4 fresh = 7 | 2 existing + 4 fresh = 6 | 1 |

No expected number is calculated by reimplementing the production miner.
Additional assertions check explicit names versus no names, bad names shapes,
list/comma equivalence, unchanged file bytes and names (including no new sidecars),
and unchanged nonempty node/edge/memory counts.

## Embedding adapter

`test_embed_public_contracts.py` creates nonempty, clearly marked fake model bytes,
a fake tokenizer marker, an explicit config file and an empty synthetic home in
its own `TemporaryDirectory`. Every call receives explicit owned model/config/
database paths. No environment or true-home fallback is needed.

`public_embed_fakes.py` installs only three temporary `sys.modules` adapters:
`numpy`, `onnxruntime`, and `tokenizers`. Each has an explicit `ModuleSpec`, so
production dependency discovery succeeds without importing installed packages.
Patches and production session/tokenizer/state globals are restored after each
test. The helper supports only operations used by this module, and does not
attempt numerical-library, tokenizer, model-format, or semantic-quality coverage.

Production `available`, `warmup`, `state`, `selfcheck`, and `embed` execute.
The functions under test are never stubbed. The synthetic session supplies:

| Fixture token | CLS vector | Independently known normalized prefix |
| --- | --- | --- |
| alpha / production probe | `[3,4,0,...]` | `[0.6,0.8,0,...]`, norm 5 |
| beta / production weather sentence | `[0,5,12,0,...]` | `[0,5/13,12/13,0,...]`, norm 13 |

Every non-CLS token instead has `[1000,-1000,0,...]`, so taking another token or
averaging tokens cannot satisfy the expected vector assertions. Alpha and beta
have different token lengths to exercise padding and multiple batches. The
session declares only input IDs and attention mask, verifying production feed
filtering as well.

The five contracts cover successful inference during warmup and reported state,
production selfcheck, exact CLS plus L2 output/shape/padding, determinism across
batch sizes and order, and empty inputs without any additional inference.
All adapters use the Python standard library only. There are no network calls,
optional-library imports, package downloads, or actual model calls.
