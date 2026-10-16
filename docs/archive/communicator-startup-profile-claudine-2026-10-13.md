# Communicator healthy-startup profile (2026-10-13)

Scope: where the wall time of a healthy managed launch goes, with fleet-shaped
content, per stage, on the same fixture for five builds. One client fix landed on
`comm` (`354dc391`, below); the API/database findings are recommendations.

Raw logs and scripts (ephemeral, on biest): `/tmp/claudine-startup-profile-82e5bd8c/`
(`raw/`, `run_matrix.sh`, `api-local-bench/`). Fixture:
`wrappers/cxx/internal/communicator/startup_profile_test.go`.

## Verdict

1. **Local work is not the cost.** With zero API latency a warm launch reaches the
   native exec in 33-40 ms (cold 85-105 ms) on HEAD, 30 ms on the pre-communicator
   build. Skill digesting/traversal, worker spawn, config verification and apply are
   inside the ~9 ms between a worker appearing and its first API frame.
2. **The cost is API round trips on the launch's critical path**, and one of them is
   huge: `POST /sync/bootstrap` takes **5.2-6.7 s** on the production API (warm,
   nothing changed, 35 KB response) and 10.1 s cold. A warm HEAD launch is
   bootstrap + `/host/agent-sessions` + `/auth` = 3 sequential frames.
3. **What the communicator added on top** was extra *serialized* work in front of the
   launch on the per-scope gate: a second content worker per launch (deployed
   0.9.73, fixed by `3f948bfc`+`a741adeb`) and, still on `f89fc864`, a second full
   bundle exchange when a launch opens a fresh scope (client fix below).
4. The production bootstrap latency is consistent with **~100-120 ms per sequential
   SQL statement** (see "API side"). That is the remaining dominant cost; the code
   issues ~50 statements per bootstrap. The production database shows why every
   round trip is slow: a **global row-lock convoy** on one `versions` row held by
   every agent-bus and portal transaction (see "Production database"). A
   pre-communicator build takes 13.8 s to the native exec on the current API
   (Elvira, `docs/archive/communicator-startup-native-elvira-2026-10-13.md`), so the API,
   not the communicator, sets the floor.

## Method

Real `cxx` binary per build, built with a throwaway signing key, driven through the
real `claude run --minimal` (native replaced by a script that records its start
time) in an isolated HOME / XDG_RUNTIME_DIR, against an in-process stub API that
serves HTTP and the communicator WebSocket. Stages come from the stub's per-frame
timeline plus a 2 ms `/proc` sampler of the owner's `communicator-worker` children;
no production code is instrumented.

* Content: 46 skills / 125 files / 320 KB generated, plus a 30 KB agents document.
  Shape taken from biest's fleet-managed manifest (`~/.clx/state/collections/skills.json`:
  46 skills, 125 files, 318 KB). `~/.claude/skills` is 5 MB only because of an
  unmanaged 227-file dir that the sync never touches.
* Latency: `CXX_STARTUP_PROFILE_LATENCY_MS` (per frame) or
  `CXX_STARTUP_PROFILE_LATENCY_MAP="/sync/bootstrap=5500,..."` (per route).
* Standing leases (`_LEASES`) and an invalidation storm (`_STORM_MS`) add background
  scheduler work. `_COMM=0` runs the legacy transport (pre-communicator build).
* Builds (`CXX_STARTUP_PROFILE_SRC`): precomm `fc048f2d` (0.9.70), deployed 0.9.73
  `44470511` (the binary installed on biest), `bacd9ac9` (before the lease fix),
  `a741adeb` (lease fix), `f89fc864` (comm HEAD), and HEAD plus the client fix (`354dc391`).

Reproduce: `CXX_STARTUP_PROFILE=1 go test ./internal/communicator -run 'TestStartupProfile$' -count=1 -v`
(see the header comment for the knobs).

## Results

Launch-to-native-exec, serial, warm unless noted (ms; frames = API calls per warm launch).

| build | 0 ms/frame warm / cold | 300 ms/frame warm / cold | production-latency map warm / cold | frames, workers |
|---|---|---|---|---|
| precomm `fc048f2d` | 30 / 58 | 932-1245 / 960-1266 | 8037 / 7062 | 3-4, 0 |
| deployed 0.9.73 `44470511` | 65 / 130 | 1267 (spikes 1877) / 1328 | 13067 (spike 19558) / 13128 | 5, 2 (up to 3) |
| `bacd9ac9` | 63 / 128 | 1268 / 1326 | - | 5, 2 |
| `a741adeb` | 40 / 102 | 941 / 1355 | 7041 / 13107 | 3, 1 |
| `f89fc864` (HEAD) | 35-40 / 125 | 941 (1268 once) / 1001-1003 | 7042 / 13128 | 3, 1-2 |
| HEAD + client fix (`354dc391`) | 33-45 / 102 | 940 / 1001 | 7042 / **7107** | 3, 1 |

Production-latency map = measured production per-route server time:
`/sync/bootstrap` 5500, `/wrapper/v2/config` 1000, `/auth` 1000 (not probed: it is a
credential exchange), `/cron/check` 900, `/host/agent-sessions` 500 ms.

Reading it:

* Deployed 0.9.73 pays a second worker per launch (`/wrapper/v2/config` +
  `/sync/bootstrap` serialized on the scope gate): +6 s typical, +12 s when it
  collides with the scheduler's own pass. The lease fix removes it (verified at
  production latency: 13.07 s -> 7.04 s).
* HEAD still repeats the exchange for a *fresh* scope: the launch's bootstrap
  (+43..5581 ms, 380 KB) runs first, then the scheduler's initial pass for the same
  scope (`/wrapper/v2/config` + second `/sync/bootstrap`, +5588..12099 ms, 5.9 KB
  "unchanged") holds the gate, and the launch's gated `/auth` waits for it: 13.1 s
  against 7.1 s. Sometimes the pass lands in the *next* launch instead (the 1268 ms
  row above).
* HEAD is faster than pre-communicator on a warm launch (one `/auth` fewer): 7.04 s vs 8.04 s.
* Invalidation storm (1500 ms interval, 24 leases, 300 ms/frame; a degraded
  scenario, not healthy-launch proof): launches 940 ms -> 1556-1580 typical,
  1811-2720 worst, on HEAD and 0.9.73 alike. Each background pass is a whole gate
  hold; scoped invalidation on the API side is what bounds this.

## Live production observations (deployed 0.9.73 owner, biest, 2026-10-13 ~21:00 local)

Passive `/proc` sampling of the main owner's children (no ptrace; `raw/live_workers_205846.jsonl`):

* 130 worker processes in 283 s (27/min); wall p50 6.4 s, p90 11.6 s, max 18.5 s;
  none under 1 s; average 2.95 concurrent (max 5).
* CPU 2.46 s total over all 130 (0.019 s/worker). Thread states: futex wait 80.8 %,
  epoll 18.2 %, fsync (`wait_log_commit`) 0.6 %. Workers are waiting on API replies.
* Owner: 36 leases, 7 scopes (5 Grok session scopes), 5 of 7 running at any instant,
  ~10 requests/s through one connection (not all of it sync).
* `clx sync --minimal` through that owner: 10.1 s and 14.0 s (Berenike: 8.7/16.2).

## API side (production, host key of biest, content-only, `raw/probe_*.py`)

Server time to first byte, sequential single requests, box load ~40-45 on 32 cores:

| route | ms |
|---|---|
| `GET /healthz`, 404 | 38-43 |
| authenticated `GET /skills?engine=claude` | 292-410 |
| `POST /config/retrieve` | 399-610 |
| `GET /versions` (no auth) | 247-460 |
| `GET /wrapper/v2/config?engine=claude` | 865-1094 |
| `POST /sync/status` | 951-1041 |
| `POST /agents/retrieve` | 780-1416 |
| `POST /cron/check` | 644-1883 |
| **`POST /sync/bootstrap`, digests current** | **5205-6726** (5 samples; 35 KB) |
| `POST /sync/bootstrap`, no digests | 10097 (795 KB) |

Twenty parallel `GET /versions` finish in ~800 ms (single: 250-460 ms; ten parallel:
~570 ms): two waves of the default 10-connection pool, each costing one single-request
time. That fits a fixed per-statement delay and does not fit a pool already saturated
by other traffic.

Local replica (`/sync/bootstrap` on a private MySQL 8.4 with the repo schema, 46
skills): **~50 SQL statements per call** (16 reads of the `versions` K/V table, 4
`logs` inserts, 3 `count` scans of `logs`, a host-contact transaction, ...).
Without added latency the call takes 26-37 ms. Behind a TCP proxy adding 100 ms
round trip it takes 4.5-4.7 s, i.e. production's number. With 2 M `logs` rows and no
latency it takes ~300 ms because the three `fleetCounts()` queries fall back to a
full scan (`EXPLAIN` type ALL, only `created_at` and `host_id` are indexed): the
scan is a real but smaller second effect, scaling with the month's log size.

What is **confirmed**: the statement count, the structure (sequential prefix of ~13
rounds, bundle blocks, tail), and that production route latencies fit
`rounds x ~110 ms`. What is **not** established: *why* a statement costs ~100 ms in
production (database round trip, proxy, storage commit latency); that needs
database-side data (slow log, `SHOW PROCESSLIST`, round trip from the API container).

## Production database (docker01, read-only, 2026-10-13)

Read-only inspection of `codex-orchestrator-mysql-1` (MySQL 8.4.11, uptime 20.4 days)
and its API container, authorized by the coordinator: `performance_schema` and
`information_schema` SELECTs plus `docker stats`. Nothing was written or changed;
no container was modified.

| statement (digest) | executions | avg | lock wait | max | total |
|---|---|---|---|---|---|
| `SELECT version FROM versions WHERE name=? LIMIT 1 FOR UPDATE` | 100,222,980 | 25.5 ms | 25.3 ms | 50 s | 709.8 h |
| `SELECT name,version,updated_at FROM versions WHERE name IN(...) ORDER BY name FOR UPDATE` | 136,063 | 100.4 ms | 100.2 ms | 10 s | 3.8 h |
| `SELECT COUNT(*) FROM logs WHERE action=? AND created_at>..` (`fleetCounts`) | 199,026 | 442 ms | 0 | 43 s | 24.5 h |
| agent-bus selects/updates, plain `versions` reads | 70-170 M each | 0.1-0.8 ms | 0 | | |

Server counters: `Innodb_row_lock_waits` 64.0 M (average 39 ms), `Slow_queries` 336,
`Connections` 176k, `Max_used_connections` 21. A live snapshot showed 10 open
transactions, 6 in LOCK WAIT (average 625 ms) on that statement, and
`data_locks` holding `X,REC_NOT_GAP` on `'agent_messaging_enabled'`.

The statement comes from `requireEnabledLocked()` (`api/src/services/agent-messaging.ts`)
and `portalEnabledLocked()` (`api/src/services/agent-portal.ts`): every agent-messaging
and portal transaction reads its enable flag `FOR UPDATE`, so all of them across the
fleet serialize on one row until commit (`innodb_flush_log_at_trx_commit=1` and
`sync_binlog=1`: two fsyncs per commit). Each waiting transaction holds one of the
API's pooled connections (`DB_POOL_SIZE` unset, so 10; 11 connections, 6 busy at the
snapshot), which leaves a request such as `/sync/bootstrap` queueing for a connection
between its ~50 sequential statements. That chain explains the per-statement delay,
the two-waves-of-ten behaviour of 20 parallel requests, and the 13.8 s pre-communicator
baseline. The lock convoy itself is measured; that it is *the* cause of the per-statement
delay is consistent with every measurement but not proven (a fresh-connection `SELECT 1`
from the API container, read-only, would show whether the database is sub-millisecond).

Other settings on the box: `innodb_buffer_pool_size` 128 MiB (default) on a 23 GiB host,
redo capacity 100 MiB, 114.8 M buffer-pool misses, 5.9 TB lifetime block reads from the
database container, API container at 110 % CPU.

## Fixes

| change | scope | effect | status |
|---|---|---|---|
| Client: a launch's bootstrap satisfies the scheduler's pending content pass | `sync.go`, `sync_client.go`, `server.go`, tests, CHANGELOG | cold launch 13.1 s -> 7.1 s at modeled production latency; real native cold start was +8.85 s over pre-communicator before it (Elvira) | **landed**, `354dc391` on `comm`; reviewed by Berenike |
| API: run the `/sync/bootstrap` bundle reads concurrently | `api/src/routes/auth/index.ts` | 4.5 s -> 2.9 s at 100 ms round trip | **withdrawn**: the renderer siblings mint MCP tokens and write logs, so a failing sibling leaves those mutations behind and changes error precedence (Valerie's review) |
| API: `FOR UPDATE` -> `FOR SHARE` (or a plain read) in `requireEnabledLocked` / `portalEnabledLocked` | `agent-messaging.ts`, `agent-portal.ts` | removes the convoy: readers stop excluding each other, the admin toggle still excludes them | recommended, not implemented |
| API: raise `DB_POOL_SIZE`; cache or index `fleetCounts()` (composite `(action, created_at)` or a counter); buffer pool 128 MiB -> >= 2 GiB | env, `host-sessions.ts`, database | fewer starved requests; 0.44 s x 3 scans per bootstrap; fewer disk reads | recommended, not implemented |
| API: read `versions` once per request, batch the managed-feature flags, one-statement host contact | services | fewer sequential rounds | recommended, not implemented |

How the client fix is bounded (checked in code and by tests):

* Only scheduler `content` passes can be skipped. `auth` operations and bootstraps that
  carry auth always run; explicit callers (Grok issues one) never share a coalescing key
  with a scheduler pass (`TestScheduledContentPassDoesNotCoalesceWithExplicitCaller`).
* Fresh means a complete worker result: no error, no resource error, not deferred, not
  reconcile-only, and its START time is later than the newest server invalidation.
  A pushed `invalidate` frame and every reconnect stamp `server.invalidatedAt` at arrival
  (`TestInvalidationAfterLaunchStillRefreshesContent`, `TestReconnectAfterLaunchStillRefreshesContent`;
  each fails when its stamp is removed). An owner's first connection only signals the
  scheduler: it has missed nothing, and a launch's bootstrap that started while the
  connection was still being made reads state only after it. A 400 ms connection delay
  reproduced the duplicate without this exemption.
* A new scope's first scheduled pass waits `initialContentGrace` (1.5 s) so the session
  that opened it takes the gate first (the race otherwise lost 2 of 60 runs under load;
  with the grace 0 of 120 over 40 runs of the three launch tests, 0 of 45 under `-race`).
* Freshness is per scope (engine + home, plus the broker for Grok auth), never across
  homes or engines. Grok broker scopes keep their own initial pass; keying freshness by
  engine + home is a follow-up with its own test.
* The measured gain is the Claude launch against a stub that replays measured production
  route times (`/auth` and `/host/agent-sessions` assumed): modeled production latency,
  not a production run, and not yet measured for Codex or Grok.

## Tests

* `TestFreshScopeLaunchSharesOneContentExchange`: red on `f89fc864` (2
  `/sync/bootstrap` frames), green with the client fix.
* `TestInvalidationAfterLaunchStillRefreshesContent`: guards the other direction
  (mutation that drops the invalidation stamp fails it).
* `go test ./internal/communicator -count=1` passes (17 s); sync-focused tests pass
  under `-race`. API: sync-bootstrap, skill-bundle, claude-artifacts, platform
  projection, fleet-switch and contract suites pass (68 tests, db-fake).

## Limits

Stub timings are not production timings (no database, fixed injected latency, one
engine scope; Codex and Grok scopes, Grok brokers and the real native CLI are not in
the fixture). The production-latency rows use measured per-route times but assume
`/auth` and `/host/agent-sessions`. The box was heavily loaded (load average 40-70)
during all runs; stub latency is sleep-based so the fixture rows are not CPU-bound,
the live and API probes are. The live sampler observed one owner for ~5 minutes.
