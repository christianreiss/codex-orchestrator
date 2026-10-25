# MCP runtime repairs — 2026-10-25

Base: `b619779f1aa72e0575f699ce0d24759c90edb4d4`. Intended wrapper: **0.9.130**.
Prepared in an isolated clean archive because the originating native Git binding
expired (`agent_bridge_expired` / `git_remote_binding_stale`). The original checkout
was left clean. This report proves local fixtures, not a live deployment.
Rosa-Maria owns integration, production deployment and live revalidation.

## Changes and evidence

- `agent_translate` resolves names and UUIDs from the Owner snapshot while preserving
  native bridge authentication and target eligibility. No forbidden SQL transaction
  is opened in Owner mode.
- `agent_workflow_run_current` delegates to the existing authenticated Owner read;
  the route no longer opens an unsupported coordination transaction first.
- Both paired native identity headers survive the Go cache carrier and API forwarder.
  Cache keys distinguish sessions. Native MCP content always receives a fresh server
  check and cannot reuse host-only local content grants.
- New owners advertise `native_scope_protocol: 1`. Before dispatch, clients route
  selected reads around owners lacking the required native/expanded-read capability
  through the existing authenticated cache proof bridge. No uncertain dispatch is replayed.
- Protocol-3 receipts remain valid fresh carriers for older clients; the server denies
  a local grant to native requests. The outer cache response retains native binding,
  expiry, host and engine validation through delivery, beyond the nested MCP response.

The Owner regressions first reproduced both 500 failures, then passed after repair.
Tests cover Codex, Claude and Grok, disabled messaging/engine/targets, expired bridge,
changed binding, old wrapper, paired credentials and late outer-response revalidation.
Communicator tests cover paired identity preservation, per-session keys, repeated fresh
checks despite a local grant, old owner selection, valid receipts and missing receipts.

## Validation

- API focused Owner/cache/response suite: **29 files, 223 tests passed**.
- API `npm run typecheck`: passed. ESLint on all seven changed TypeScript files: passed.
- API full suite before the final outer-response guard: **469 files passed, 104 skipped;
  5771 tests passed, 1081 skipped, 3 failed** in unchanged `ops/instance-cli.test.ts`.
  All three are non-root Python `os.fchown` permission failures when fixtures request
  uid/gid 10001. Running that same file on unmodified base reproduces all three.
  The final guard was verified by the focused 223-test suite; the full suite was not
  repeated after that final change. Root-capable integration remains with Rosa-Maria.
- Go full communicator `-race`: passed (151 seconds).
- Go `go test ./...`, `go build ./...`, `go vet ./...`: passed.
- No production reboot, recovery, process termination, state clearing or deploy was
  performed for these runtime repairs. Database-backed integration and post-deploy
  native broker verification remain pending with the integrator.

Feedback: `a0345b31-5765-4e15-83c0-2a6dfc263abe` (translate),
`546969d2-c0a3-4b0f-bed4-99bf95e2abec` (workflow read), and cache recurrence
`2a4f9ba8-eeec-4602-b847-8a9463d162db`.
