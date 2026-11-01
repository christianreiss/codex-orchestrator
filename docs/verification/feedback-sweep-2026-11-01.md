# Feedback sweep — 2026-11-01

The operator authorized fixes for all eleven open Orchestrator feedbacks, parallel
implementation, merge, push and production deployment. The original trigger was
seven distinct Portal recovery-deadline warnings from old native sessions.

## Scope

- `fa6b27fa`: stale automatic supervisor work and abandoned-session recovery.
- `e2a033eb`: direct operator work-state reports; current live call and isolated
  MySQL persistence both succeed. Add regression coverage instead of guessing at
  an unavailable historical server error.
- `08c677d0`: preserve the explicit workspace on native reconnect.
- `52666f68`: explain the native ownership boundary for content-only Desktop/SDK
  callers and the supported managed terminal launch.
- `05f97d95`: remote claims for canonical IP literals and single-label hosts.
- `41d15d57`: bound large missing-claim diagnostics.
- `2736b5cf`: local-file project uploads through the managed CLI.
- `25911120`: distinguish transport leases from deduplicated native sessions.
- `0b3ad0fa`: recover version reporting during gated bootstrap.
- `4a70ab57`: reconcile uncertain idempotent terminal finish requests.
- `ad74e798`: reverify the previously deployed performance fix. A fresh 300-request
  direct `/versions` sample on docker01 had mean 3.98 ms, p99 23.54 ms and maximum
  41.70 ms, with no sample above 200 ms. This is a bounded server sample, not a
  fleet-wide latency claim. The prior fix remains in `048034339` and `d50f94c8d`.

## Verification and rollout

Verification uses an isolated local MySQL 8.4 instance, never production test DDL.
API typecheck, lint and build passed (lint reports 233 warnings, zero errors).
The complete database-free suite passed 7,159 tests. The MySQL suite passed 2,094
tests; its two remaining retention-collation failures were stale test captures of
a legitimate housekeeping DELETE. After correcting that seam, both collation
variants and all three supervisor integration tests passed. The migration check
reports 117 applied, zero pending and zero drifted; two DB cases remain
skipped. Wrapper `go test ./...`, `go build ./...`, `go vet ./...` and focused race
tests passed. Frontend check passed with zero Svelte diagnostics and 1,016 tests.

The browser suite exposed two incomplete API fixtures and a keyboard-inaccessible
settings table scroller. Fixtures now return their actual response contracts and
the scroll region has a label and keyboard focus. The production secret scanner
also distinguishes the exact documented public development endpoint from custom
URLs and secret values; those negative cases remain covered. The complete browser
run passed 401 scenarios; the two 320-pixel Axe failures exposed the corrected
scroll region. A rebuilt-SPA recheck passed both all-page 320-pixel theme sweeps
and all four current/legacy communicator-count scenarios (six tests). Final
deployed source/artifact identity is recorded in delivery receipts.

The host-detail count labels follow DESIGN `INT-6/7`: missing native-session data
is unavailable, and a transport lease is never presented as a unique client.
Existing components and styles are retained (`VIS-1`); the Settings table uses a
named, keyboard-focusable scroll region (`ACC-1/3/4`). Browser assertions cover
current and legacy count payloads. No design exception is introduced. Manual
screen-reader and independent usability review are not claimed.

Rollback images on docker01 retain the tag
`rollback-20261101-feedback-d50f94c8-c2db` for the API and media worker; the prior
served wrapper version is 0.9.148.
No database schema change is required by this sweep.
