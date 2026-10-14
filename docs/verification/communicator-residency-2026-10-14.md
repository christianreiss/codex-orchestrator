# Resident-runtime verification, 2026-10-14

Initial implementation worktree: `task/communicator-resident-b50a538a`, based
on verified audit `dc92e547178fb8a5207665ebe9c54db19da0f39d`. The initial
private checks below preceded source integration. The 0.9.80 integration
evidence appears at the end; no production rollout or capability activation
is claimed.

## Source and UI checks

- Canonical normal Go suite and build passed; targeted resident, namespace,
  controller, migration and pinned-process tests passed with the race detector.
- API typecheck/build and lifecycle/spawn/signed-config unit tests passed.
- Frontend check passed with zero errors/warnings and 928 tests; production SPA
  build and the independent residence-settings Playwright test passed.
- Darwin CLI cross-build passed; systemd residence/migration remains Linux-only.
- The signed process fixture adopted an idle on-demand owner and verified source
  exit, successor PID/UUID and completed journal without any `/auth` request.

## Isolated real systemd lab

A task-owned rootless Podman container ran Fedora 43/systemd. Its base image ID
was `75126c04c57c`; the systemd image was
`7fc3e49b1bc846e1174b042109c2ce0d8761a3a94cce951d87453b239f5ad6b3`.
No host systemd unit, host daemon binary or production API was mounted into it.
The lab used three synthetic signed engine configurations, explicit residence,
disabled execution/transport/content sync, and a loopback HTTP stub for settings
and migration. This verifies real service/process behavior, not provider execution
or actual MySQL admission concurrency.

Fresh installation started a resident with zero local clients and HTTPS fallback.
The first update replaced source PID 195/owner
`f6c1314a-2aa4-46e5-9c30-fa5fbc02de8f` and reached `reopened` under transition
`f59e5a3c-e6ec-4ce0-a81d-f7e0fa43e205`. All API fence/status/release requests
used that same ID. Running source bytes were
`ee379bc48d6d2341d024e6674545628a443c360a25ac6c475e79452c97c33092`;
the target bytes were
`cf33d307e8c4b144781f557330f9369aefb06dac8a39efdcc8e438af9b750dfb`.

A second update and reverse rollback passed. Rollback transition
`959f06ad-cb97-4301-90c0-6a15df3dd490` restored the previous binary to PID 666,
owner `db30cdcc-ab89-4515-873d-3e21bee68a4f`. Repeating rollback returned success
without replacing that owner.

The stub then returned HTTP 503 for admission release. Update transition
`e7be6b27-0039-444d-a0c2-4f4c4720b56f` remained at `verified`. Removing that
failure and repeating install reached `reopened` with the same transition ID,
owner `97a08b47-3619-4471-b1ec-9eab876c883c` and PID 886. The retry did not
restart the verified target. Its executable hash was
`579e674122305d1c0e745431af4756b478642e46ccd807fd6f2e5ae4a471f70b`.

Both source and target unit artifacts had hash
`0d59d2923f7826592a0bb51e759c4d253696b044d05ca6df59a0889c1f5bb385`.
The binary changes alone therefore exercised actual running-byte detection.

## Combined execution and MySQL follow-up

The composed owner/controller runs a signed, isolated test process for Codex,
Claude and Grok. Both the driver and child are race-instrumented. Each test
continues one native session using a provider executable fixture, verifies the
native writer lock excludes another process, and holds accepted work open. Local
handoff and negotiated remote stop are refused while that work runs. Dropping the
first completion acknowledgement reconnects the same owner and resends the same
claim/result without starting the native process again. The recovered receipt is
removed, the writer lock is free, and quiet remote termination actually exits.
Two runs passed for all engines. No real provider account or native AI agent was
used. Ordinary native launches no longer hash their executable at package init;
only an owner's first runtime diagnostic computes and caches that hash.

The isolated MySQL lab uses cached image `6ea90827b110` (MySQL 8.4.11), a fresh
`unification_fixture` database and synthetic credentials on a loopback-only port.
The repository baseline and all 62 migrations were applied. A new negative test
reproduced stale offered-work acceptance after migration fencing in both the unit
harness and actual MySQL. The correction restores `daemonAccepting` for new
acceptance and follow-up admission; requested execution enablement is used only
when retaining already accepted results and peer-finish session state.

Database regressions cover queued work/claim preservation, accepted-work drainage,
legacy settings omission, peer leases on idle native sessions, rejection of peer
acceptance after fencing, and competing acceptance/fence transactions. The native
writer/process fixtures do not establish provider auth or quota acceptance.

Service intent regressions cover execution-only migration retry with admission
fenced, expired execution, explicit residence after expiry, unsigned residence
deferment and unchanged legacy execution support. Runtime-unaware lease clients
remain a handoff blocker instead of advertising unsupported reconnection.

## Negotiated owner reporting

Initial reporting candidate: `ac12f566`.

After Raffaela released the topology paths, the private candidate adds exact
instance-bound `resident_status` frames without changing legacy capabilities.
Five live Go WebSocket combinations cover old/no-control, terminate-only,
identity-only, unsigned runtime and negotiated reporting. Reports update mode,
sequence on the wire, omit sensitive errors and remain bounded; existing local
status/stop-refusal regressions still apply. Focused normal and traced race
checks pass (`/tmp/christel-owner-report-go-final.log` and
`/tmp/christel-owner-report-go-traced.log`).

The API validates exact-instance reports over real loopback WebSockets, rejects
missing/wrong identity, unknown fields, invalid counters/hashes and revoked
credentials, and forgets reports on reconnect. Registry/projection tests cover
identity changes, late sequences and report age independent of other traffic;
a composed route test projects the frame into `GET /admin/topology`. Across
eight targeted suites, 146 distinct tests pass. API typecheck/build pass.
Frontend check reports zero errors/warnings and 928 tests pass. The build and
all 12 topology Playwright tests pass, including stale report wording, retained
work, legacy owners and existing termination/successor evidence. Generated SPA
assets are included.

One initial full Go run failed the unchanged Claude post-run offline-auth
request-count assertion (seven instead of six). Five isolated reruns passed;
no auth source or test has been edited for this reporting slice. The final
canonical `go test ./...`, `go build ./...` and `go vet ./...` rerun passed
(`/tmp/christel-owner-report-go-all-final.log`, `-go-build-final.log`, and
`-go-vet-final.log`). The first failure is retained as a non-reproduced observation,
not silently classified as fixed or unrelated.

## Reporting review corrections

Raffaela reviewed the reporting/topology slice read-only and identified the
control-loss behavior on invalid diagnostics. The follow-up uses strict
`safeParse` and ignores invalid, future-version and wrong-instance reports
without publishing. Real loopback tests prove heartbeat, request relay and
exact-instance terminate remain available after every invalid report. A future
frame also leaves a previously accepted report and its freshness unchanged.
Reports no longer perform a separate authorization read; the existing
15-second heartbeat still closes revoked connections. The full targeted API
set now contains 149 passing tests, with typecheck/build passing.

Diagnostic sampling runs outside the heartbeat loop, with one outstanding
sample per owner across reconnects, omitted samples after two seconds and a
two-second report write deadline. Tests explicitly block a sample and prove
heartbeats and targeted control still work, repeated requests coalesce, late
samples do not freshen old state, and a token-only server never gets a report.
Receipt I/O also releases the admission mutex. Snapshot rebind and permit
revision checks plus conservative observed permit counts prevent a finishing
operation from producing a late receipt and being misreported as verified idle.
Blocked-I/O race tests cover admission, fence, permit release, rebind and the
receipt-producing completion interval. Focused normal/traced race checks and
traced composed native-adapter race fixtures pass for all three engines.
Frontend and generated SPA artifacts are unchanged from `ac12f566`; its 12
browser checks remain applicable. The final full `go test ./...`,
`go build ./...` and `go vet ./...` pass for this follow-up
(`/tmp/christel-report-review-go-all.log`, `-go-build.log`, and `-go-vet.log`).
Focused normal race checks and traced all-engine process checks are recorded in
`/tmp/christel-report-review-go-race-epochs.log` and
`/tmp/christel-report-review-go-traced-process.log`; the 149-test API result is
`/tmp/christel-report-review-api-all.log` with final diagnostic/no-publish
regressions in `/tmp/christel-report-review-api-diagnostic-final.log`.

## Integration with 0.9.79

The operator explicitly requested merge back, push and task cleanup on
2026-10-14. The complete private history (including mandatory admission and
reporting corrections) is combined with `839c0a1bc00665641875ed355fe6121c89d96693`.
The wrapper version becomes 0.9.80; the independent signed runtime capability
remains default-off. Startup and explicit auth-recovery corrections, the
foreign-HOME native-entry guard/defer wrapper and idle relay polling changes
are preserved. CLI status keeps upstream unsafe-runtime errors while using
verified resident socket discovery. Documentation keeps both interfaces and
generated SPA assets are rebuilt from combined sources.

Fresh combined-source checks pass:

- Full `go test ./...`, `go build ./...` and `go vet ./...`.
- Targeted traced race tests for residency, controllers, composed adapters,
  process/namespace identity, foreign-HOME protection and command dispatch.
- API typecheck/build, 199 targeted transport/topology/settings/capability
  tests and 37 additional host-spawn/daemon/insecure-host tests.
- Frontend check: zero errors/warnings, 928 tests; SPA build and 13 topology
  and residence-settings Playwright checks.
- Fresh isolated MySQL 8.4.11 fixture: repository baseline (293 statements)
  and all 63 migrations, then daemon lifecycle/migration fences plus upstream
  enable-flag admission and idle relay polling suites: 52 tests pass. This combines
  the real admission-fence proof with the audited polling optimization.

Logs: `/tmp/tina-resident-integration-go-all.log`, `-go-build.log`, `-go-vet.log`,
`-race.log`, `-api-tests.log`, `-spawn-final.log`, `-frontend-check.log`,
`-frontend-build.log`, `-browser.log`, and `-mysql-tests.log` (all with the same
`tina-resident-integration` prefix). The fixture database/container is removed
before delivery. No production database, daemon, systemd unit or native
provider account is changed by integration checks.

## Activation acceptance

Raffaela's second read-only review found no blockers in the reporting/control
corrections; it did not independently rerun tests or review the broader systemd
migration implementation. Real-provider and production migration acceptance
remain activation gates. Incompatible/unresponsive legacy owners and custom
systemd namespace changes intentionally defer; source merge does not override
that behavior or grant execution permission.
