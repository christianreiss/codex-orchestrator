# Fleet-count database acceptance, 2026-10-13

Elvira's isolated change starts from `ae946f1c3606c035ec31dbb0f606c59f15381454`.
It addresses `HostSessionsService.fleetCounts` only. No production database,
shared harness, fleet credentials, enable flags or bootstrap renderer ordering
was changed during this test.

## Change and correctness

Migration `0063_logs_activity_index.sql` adds the non-unique covering index
`idx_logs_action_created_host(action, created_at, host_id)`, using guarded
`ALTER TABLE ... ALGORITHM=INPLACE, LOCK=NONE`. The schema mirror and generated
baseline index match. Existing host/time indexes remain available.

The service sends one statement containing three scalar aggregate subqueries.
Each subquery keeps its original action and timestamp predicates. This requires
one database round trip and one pool connection rather than three concurrent
queries; the database also evaluates all three counters in one statement snapshot.
No result caching, cutoff widening, upper timestamp limit, engine filter or auth
policy was added.

The recent counter still counts distinct non-null hosts, including hosts whose
only recent retrieval was in the previous month. Day/month counters count rows,
including null host IDs and retries. The real-MySQL tests compare the old SQL
with the new service at ordinary, UTC midnight, month, year and leap-year
boundaries, plus a non-UTC input offset. They also check inclusive cutoffs,
second flooring, all three engines, exact action selection, empty results,
future timestamps and a fresh insert between calls.

## Reproduction and plans

A private MySQL 8.4.11 instance used a 128 MiB InnoDB buffer pool and a disk-backed
data directory. The fixture generated 2,000,000 rows over 40 days ending at
2026-10-13 12:00 UTC: 10% `agents.retrieve`, mixed other actions, three engines,
211 repeating host IDs, occasional null hosts, and 204-byte audit details.
This is generated representative data, not a production copy.

At that clock the counters are `{now:104,today:2500,month:62500}`. Before the
index, the monthly query's `EXPLAIN` uses `ALL` (estimated 1,960,245 rows);
`EXPLAIN ANALYZE` confirms a table scan of **2,000,000 rows**, taking **970 ms**.
Afterwards all three scalar subqueries use covering range scans on the new
index (`Using index`). Actual range rows are **104**, **2,500** and **62,500**.
No audit payload rows are fetched for these counts.

Seven repetitions per layout, on the same generated database:

| Layout | Median | Observed range |
| --- | ---: | ---: |
| Original three parallel queries, old indexes | 957.67 ms | 914.78–1231.53 ms |
| Same queries, covering index | 17.88 ms | 17.29–21.87 ms |
| Three scalar subqueries in one statement, covering index | 18.26 ms | 17.43–20.19 ms |
| One conditional aggregate over the month, covering index | 29.31 ms | 27.63–32.09 ms |
| Final service through Drizzle, covering index | 18.69 ms | 18.45–21.67 ms |

The actual service issued **8 statements for 8 calls**, including its first
warm-up call; every result matched the original counts. The conditional layout
was rejected because it fed the whole month's range into the distinct-host
aggregate. The selected layout is about **51 times faster in this fixture**
than the original implementation. This is not a measured end-to-end native
startup or production latency improvement.

The index build took **8.04 s** on the populated fixture and used **9,087 16-KiB
pages** (about **142 MiB**). The added index therefore has a storage/write cost;
`LOCK=NONE` permits concurrent DML during the build, while normal metadata-lock
acquisition still applies. Production rollout must apply the normal migration
runner; no manual production SQL was issued here.

## Evidence and checks

Artifacts are retained at
`/home/chris/Downloads/comm-fleetcounts-elvira-ca1fb4ad/`.
`benchmark.cjs` generates the rows and compares layouts; `benchmark-seed.json`,
`benchmark-index.json` and `source-benchmark.json` retain timings and SQL plans.
Run `node benchmark.cjs seed` against a new private database, then
`node benchmark.cjs index`; the script reads the task's private `db.json` and
must never target a shared or production database. Credentials are not archived.

Validation from `api/`:

- `vitest run test/unit/services/host-sessions.test.ts test/unit/db/schema-baseline-drift.test.ts test/unit/db/migration-schema-drift.test.ts test/integration/host-api/sync-bootstrap.test.ts`: 42 passed.
- Disposable MySQL, canonical baseline and migration runner: 9 migration-runner tests passed; the new index upgrade/replay test passed, including two applications after dropping the new index.
- Disposable MySQL fleet-count service suite: 8 passed. Each test rolls back its fixture transaction.
- Final combined affected run with the real database enabled: 6 files, 51 tests passed, zero skipped. API typecheck, build and lint for changed TypeScript paths passed.

The initial tmpfs fixture hit its container memory limit and was discarded before
collecting usable measurements. An initial temporary-table correctness fixture
was replaced after MySQL rejected that setup; the final tests use the real
baseline table inside rolled-back transactions. Neither failed setup is used as
acceptance evidence.
