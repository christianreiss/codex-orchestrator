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
Release 0.9.123 is prepared; publication and installed-host verification are
recorded separately after rollout.
