# Communicator cache transition regression — 2026-10-23

## Operator failure and immediate recovery

The 0.9.122 client on biest received a signed protocol-2 configuration while
the shared on-demand owner was still 0.9.111. Its executable had been replaced,
but 44 leases and running native agents kept its normal retirement gate closed.
`cdx` failed on `/auth` and `/skills` with HTTP 409 and the missing protocol-2
confirmation message. The original isolated release canary had started a new
owner and therefore missed this upgrade transition.

The parent verified PID 871925, its UID, owner command/config and deleted old
executable, then sent SIGTERM through a pidfd to that communicator only. The
installed 0.9.122 successor, PID 2974688, connected and the 44 leases reconnected.
No native agent process was signaled. Both real `cdx sync --minimal` and
`clx sync --minimal` then returned exit 0. Codex reported API/auth/skills/runner
OK; Claude reported API/skills/runner OK with stale quota telemetry warnings.

## Automatic transition fix, release 0.9.123

Selected protocol-2 requests check the owner's advertised capability before
application dispatch. An old or unavailable capability report selects a direct
authenticated `/sync/cache` exchange through the existing proof validator.
The client holds bounded process-local RAM bytes and confirms every use. It
does not stop the owner, accept an expired proof, or replay already dispatched
admission/auth operations. Non-selected writes preserve their route and body.

## Verification

- The regression was first reproduced in tests: the old code sent application
  work through the legacy owner, and even accepted unconfirmed auth replies
  for bodies without `GetBody`.
- All new regressions passed under `-race`: Codex/Claude/Grok each send zero
  application requests to a legacy owner and obtain two fresh server proofs
  for two reads, reusing one known manifest. Other checks cover revoked hosts
  after a warm read, corrupted and lost admission replies without replay,
  redirect refusal, unchanged write bodies/routes, and a falsely capable
  owner's missing receipt without a direct retry.
- Full `go test -race ./...`, `go build ./...` and `go vet ./...` passed.
- A private live canary ran the actual released 0.9.111 owner with a held
  private native housekeeping guard and real signed biest configs. Installed
  0.9.122 reproduced exit 1 with a missing confirmation and no native marker.
  Atomically replacing the owner's start path with the patched executable let
  both Codex and Claude complete their launch paths (exit 0, approximately
  2.05 s and 1.27 s) while the same old owner PID/version remained alive.
  Each native adapter executed the real provider binary with `--version`;
  no provider inference or interactive UI acceptance was performed. All signed
  canary configs still selected cache protocol 2 after the test.

API source and schema are unchanged by this fix; the API suite was not rerun.
The original cache release's API and isolated MySQL checks remain recorded in
[the main verification record](communicator-cache-2026-10-23.md).

Fleet feedback: `2a4f9ba8-eeec-4602-b847-8a9463d162db`.

## Published and installed

The approved short-lived helper fast-forwarded docker01 `main` from `7f9818ce`
to `c5e537fa5ca3b4c27666617efb65595e3963fcec` under a bound Director lease, then
released its claims and ended. The parent deployed through a detached systemd
supervisor, keeping the deployment independent of the native helper/control
plane. An initial supervisor syntax error exited before running deploy.sh;
the corrected supervisor completed at `2026-10-23T13:09:14.754Z` with exit 0.

- API container `codex-orchestrator-api-1` started at `13:09:07.193 UTC` and is
  healthy, image `sha256:1fb03840c17e802fcb71ecc5ad2d05ee596a54caf8187cef7f760c81f96ee1fa`.
- Public `/healthz` and `/versions` returned 200, wrapper `0.9.123`, runner `ok`.
- Migration check: 91 applied, 0 pending, 0 drifted. No schema change introduced.
- The normal `cdx update --minimal` installed 0.9.123 on biest and completed its
  sync with API/auth/skills/config/runner OK. `clx --minimal --status` also
  returned exit 0 with API/auth/runner OK; quota telemetry warnings remain.
- Biest's installed `/usr/local/bin/cxx` has the published linux-amd64 SHA below.
  Its existing 0.9.122 owner stays connected with protocol 2, 53 leases and
  successful fresh cache confirmations; no additional owner restart was needed.

| Platform | Published and independently checked SHA-256 |
| --- | --- |
| linux-amd64 | `f177b16fdfd5a9334048d5904cc073d3917a178cfa1d657bc8877efe5ee59c09` |
| linux-arm64 | `0421fd8291611957be897e2efb9bc9ee7bd039e64f0675469c9277f674aba180` |
| darwin-amd64 | `f2e5d8e4dbaacba4754474bf6a1e46c0b988f9b80c10ea9bc7225eb802b95fc2` |
| darwin-arm64 | `281d3552b156b42edb9a26c754125a9522ddc5867c8f768ebbf356f7aee279f3` |

Build provenance limitation: the detached systemd environment omitted HOME.
Git then refused the differently owned checkout without root's existing
safe-directory configuration, and the deploy helpers suppressed that metadata
read failure. The source checkout, bundle, source-stable deployment log and
artifact digests are verified, but baked commit metadata reports `unknown`.
Do not describe the baked commit as independently verified. Future detached
deploys must retain the established HOME/Git context; no global Git trust or
other verification setting was weakened to work around this run.

Rollback image `codex-orchestrator-api:rollback-20261023-pre0.9.123` retains
the preceding image `sha256:259226f4bb7d86b6b2a12c01aa5dfe385ab0270d7ac20b5bd604c5fc9e5249e8`.
Previous wrapper artifacts and the original private database backup remain.
The API environment and encryption key were not changed; this wrapper-only
feature rollback requires no database restore.

The private deployment log and supervisor result are retained on docker01 in
`/var/docker_data/codex-auth.uggs.io/app/backups/` as
`communicator-cache123-20261023-26652ff0-deploy.log` and
`communicator-cache123-20261023-26652ff0-result.json` (mode 0600).

## Separate Fax merge-block recovery

The operator also identified Fax on biest as merge-blocked. All merge leases
were already expired or released; the blocker was historical resource claim
`9c3c4439-6ee0-4fec-aecc-08b74df4cff6`, uncertain since
`2026-10-22T08:45:08Z`, reserving the Fax checkout and old
`work/wirefax-bootstrap` branch. The owner had no current session, no matching
native/Git process remained, no Git operation/lock marker existed, and the old
branch was gone. Reflog/ancestry proved fast-forward `2df1d81` at
`2026-10-22T08:46:46Z` was already in main.

The parent canceled only that ended reservation through the audited
`POST /admin/agent-messaging/scopes/resolve` route. A fresh admin query found
no active or uncertain Fax-checkout blockers. No Fax file, branch or commit
was changed. Evidence was appended to existing feedback
`bceefc2f-1da0-4c8d-bbfa-4caa45ff991e`. Merge leases already depend on fresh
agent presence and TTL; a general automatic release of uncertain operation
claims was not introduced. Owner identity/recovery guidance and reconciliation
for returning agent bindings remain the separate open feature.
