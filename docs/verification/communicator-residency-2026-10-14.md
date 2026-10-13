# Private resident-runtime verification, 2026-10-14

Source worktree: `task/communicator-resident-b50a538a`, based on verified audit
`dc92e547178fb8a5207665ebe9c54db19da0f39d`. No release version allocated,
shared branch moved, production host updated, or fleet capability enabled.

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

## Remaining acceptance

Real provider acceptance where needed, independent migration/reporting review,
updated audit dependencies and Director integration
remain outstanding. Incompatible/unresponsive legacy owners and custom systemd
namespace changes intentionally defer. None of these results is a production
rollout receipt.
