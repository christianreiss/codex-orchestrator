# Communicator cache verification — 2026-10-23

The protocol-2 implementation starts at `091dc6c1`. This record distinguishes
local/isolated proof from production deployment.

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

## Production checkpoint, 11:25 UTC

Production on `docker01.uggs.io` remains at
`1807eb5f0d08e4b0bcb0bd86bf5b2a2b5ac16f1b`; the API health check is green.
No new wrapper release has been published and no production service restarted.

Prepared rollback material:

- API image `codex-orchestrator-api:rollback-20261023-pre091dc6c1`, image digest
  `sha256:369f7ce91bccb72bb0e8c2f60c095de850248a7ebe99514741b7fe267df3a9a7`.
- Private database backup on docker01:
  `/var/docker_data/codex-auth.uggs.io/app/backups/communicator-cache-pre-20261023-26652ff0.sql.gz`
  (77,964,123 bytes). The encryption key and existing environment were not changed.

The verified commit is staged in a separate server worktree. Git Director
refuses its merge because an SSH-only registration has no live local agent
binding and cannot attribute the originating agent's cross-host resource claims
(`agent_address_bound=false`, `resource_claim_conflict`). The production branch
has not been advanced. Permission for a short-lived managed deployment agent is
pending; the reservations have not been bypassed.

Fleet feedback: `5f7dcb37-ecfa-4482-8db2-95f13173f19d` requests an authenticated
cross-host Git/claim handoff. Deployment and production observation remain open.
