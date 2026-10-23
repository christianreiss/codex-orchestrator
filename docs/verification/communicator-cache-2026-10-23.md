# Communicator cache verification — 2026-10-23

Protocol 2 is deployed on `docker01.uggs.io` with cxx **0.9.122**. The production
source is `7f9818cea6bb9cdc42f0a57393d46eb3a74660b8`, including implementation
`091dc6c1` and the bootstrap auth-outcome correction `7f9818ce`.

## Verified

- API suite: `npm test -- --maxWorkers=4 --minWorkers=1` — 5,406 passed,
  1,025 skipped (including tests requiring a live database).
- `go test -race ./...` — 63 packages passed, no failures.
- `go build ./...`, `go vet ./...`, API typecheck, lint and build passed.
- Targeted real MySQL 8.4 / Node 22 tests: 2 passed with the DB read cache enabled.
  An out-of-process write remains stale in the normal cache, is immediately
  visible to authoritative reads, and cannot break a consistent transaction's
  snapshot. The real config renderer confirms unchanged bytes, then refuses a
  host revoked outside the API process despite a warm manifest.
- `TestValidatedCacheRealNativeLaunchAndOfflineRefusal` builds the real cxx
  executable with a temporary signing key. Cold and warm launches execute the
  native stub, the warm launch records RAM hits, and a subsequent failed
  confirmation produces no native-exec marker. This is a fixture API and native
  stub, not live provider inference or fleet adoption proof.
- Targeted regressions cover lost push, hash corruption, missing bytes, expiry
  in flight, wrong correlation, late responses, account/engine/home separation,
  large numeric RPC IDs, concurrent cold misses and cancellation. Concurrent
  misses fetch content bytes once while each read obtains its own confirmation.
- The bootstrap merge retains auth outcomes and reasons in both standard
  envelope projections; credentials are offered only to the auth phase.

The full database coverage suite and live provider inference were not run.

## Production proof

The approved temporary deployment agent fast-forwarded production `main` from
`1807eb5f` to `7f9818ce` under Git Director coordination. No remote push was made.
The running API embeds that full commit; its build identity has `dirty: true`
because production already contains untracked environment-backup and backup
paths. The tracked source diff is clean.

- API image: `sha256:259226f4bb7d86b6b2a12c01aa5dfe385ab0270d7ac20b5bd604c5fc9e5249e8`.
- Container: `codex-orchestrator-api-1`, running and healthy since
  `2026-10-23T11:46:35.101Z`.
- At `12:04:41 UTC`, public `/healthz` and `/versions` returned HTTP 200;
  `wrapper_version` was `0.9.122` and `runner_state` was `ok`.
- Signed configuration gives protocol 2 to caller `0.9.122`, while caller
  `0.9.121` retains protocol 1. Full-fleet client adoption was not measured.

All four published 0.9.122 manifests in the served storage mount were verified:

| Platform | SHA-256 |
| --- | --- |
| linux-amd64 | `c5102b23974f5e8638edf7727182575e64de0224db018ec3a16273e3a4cd4be9` |
| linux-arm64 | `89267454434c25fd61f02a65dc467183121ecb0dff1d65726d039b5d9c121748` |
| darwin-amd64 | `deccf03ca9ece19e71e4043b481fb88f26ec33a8117a02349c64e900b46fb361` |
| darwin-arm64 | `17440166ac6ac6d556a8c143b62d7c8a592bedf50bf8a92ee54c4ccf09da8099` |

An isolated live canary used the actual published linux-amd64 binary, a freshly
signed config, private HOME/runtime paths and the production Skill MCP route.
Two `skill_retrieve` reads produced identical results with distinct preserved
RPC IDs. Owner status showed **1 miss, 1 hit, 2 server confirmations**, one RAM
entry and 5,440 cached bytes. Both `/sync/cache` responses were HTTP 200. The
private owner was terminated and its temporary credentials/runtime removed.

Each protocol-2 use requires a new correlated server confirmation. The cache
does not authorize offline native starts or serve expired entries. Push is a
prewarming hint. These checks prove payload reuse and freshness refusal; they
do not establish a CPU/SQL reduction or live provider-inference result.

## Rollout interruption and observation

The first wrapper build failed with ENOSPC while the old API stayed healthy.
Only unused Docker build cache was removed: `until=24h` reclaimed 0 B, then
`until=1h` reclaimed 11.77 GB. Images, volumes and backups were preserved; root
subsequently had about 12 GiB available.

The second run built/published wrappers and rebuilt the API. During Compose
recreation, the helper transcript ended with `reason: interrupted`; the old
container stopped at `11:43:13.591 UTC`, and the replacement remained Created.
The interruption's trigger is unproven. The parent verified the exact new image
and unchanged encryption environment, then started that prepared container at
`11:46:35.101 UTC`: about 3 minutes 22 seconds between old stop and new start.
Ambiguous helper work was not replayed.

After closing the helper and checking its operation had ended, the abandoned
reservation was released through the audited admin resolve endpoint. The parent
removed only the stopped old container and renamed the healthy replacement to
the canonical Compose name without another restart. The clean, merged temporary
server worktree and branch were removed.

Observation through `12:04 UTC` showed a healthy API and successful cache reads.
Other logs were not entirely green: the already reported portal-retention
collation mismatch recurred eight times at startup, persistent-host relay guards
returned 503, and one unrelated agent-address query deadlocked. No cache-route
error was observed. Retention evidence was added to existing feedback
`4c6c509e-b0e6-4881-8fee-b7f566317a02`; this rollout does not fix that issue.

Follow-up records:

- `e1e6cd5e-c26f-44c9-905d-658654d233fd`: self-deploy interruption left the API
  replacement Created; recovery is complete, interruption root cause remains open.
- `5f7dcb37-ecfa-4482-8db2-95f13173f19d`: authenticated cross-host Git/claim
  handoff; the SSH-only binding restriction was honored by using the approved
  managed deployment agent.

## Rollback retained

- API image `codex-orchestrator-api:rollback-20261023-pre091dc6c1`, image digest
  `sha256:369f7ce91bccb72bb0e8c2f60c095de850248a7ebe99514741b7fe267df3a9a7`.
- Private database backup on docker01:
  `/var/docker_data/codex-auth.uggs.io/app/backups/communicator-cache-pre-20261023-26652ff0.sql.gz`
  (77,964,123 bytes). The encryption key and existing environment were not changed.

Recreate the API from the retained rollback image using the existing instance
environment to return to the preceding protocol-1 server behavior. The previous
wrapper release remains available. No schema migration was introduced, so this
feature rollback does not require restoring the database or overwriting newer
production data. Removed build cache is regenerated by future builds; the removed
stopped container can be recreated from the retained image and existing volumes.
