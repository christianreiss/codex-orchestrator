# Fleet supervisor verification — 2026-10-27

Implemented on `biest.eulie.de`, starting from local main
`5454932086f2107396c20f57a30ea191e3232e09`. Wrapper source version: **0.9.139**.
No production services, fleet settings, installed wrappers or remote Git branches
were changed. The fleet switch remains disabled by default.

## Implemented behavior

The control-plane supervisor observes accepted work and workflow handoffs, records
explicit task/wait state, reminds missing senders, and creates durable operator
attention for unresolved handoffs, cycles and unsafe recovery. Existing native
watchdog/scheduler and writer ownership provide recovery; there is no second
execution lane. Recovery pins the launch model, preserves the native transcript
and working directory, and is limited to five admissions within a fixed two-hour
incident. A normal completion and user STOP stay terminal until proven new work.
Native children sharing a fleet binding leave global task state to their parent.

Unfinished, paused and unresolved supervisor work protects its session and dependency
identities from history cleanup. Referenced result metadata remains available after
an owner snapshot reload. State updates and notices share durable transactions.

## Checks actually run

| Layer | Command / coverage | Observed result |
| --- | --- | --- |
| API broad regression | `cd api && npm test -- --maxWorkers=4 --minWorkers=1` | 496 files passed, 119 skipped; 6,625 tests passed, 1,130 skipped. Database suites skip unless explicitly opted in. |
| Final supervisor/retention regressions | `npx vitest run test/control-plane-supervisor.test.ts test/unit/server-retention` | 54 passed, including 16 supervisor cases after the final safety additions. |
| Contract/guidance checks | API route and SQL column catalogues, schema/migration projections, auth compatibility, tool-name/query-key liveness, served guidance byte budget/digests | Passed. Guidance changes intentionally update the pinned digests; the 30,000-byte budget remains unchanged. |
| API static/package | `npm run typecheck`, `npm run build`, `npm run lint` | Passed. Lint has 0 errors and 229 warnings; the broad repository warning inventory was not reformatted or suppressed. |
| Real MySQL | Isolated MySQL 8.4.10 on loopback, dedicated test data directory and database; supervisor/watchdog/scheduler/quota plus owner/server retention suites | 87 passed across six files. Production credentials/database were not used. |
| Migration | Production migration runner, then repeat migration 0111 against the isolated database | Applied/reapplied; 0 pending or drifted migrations. Reapply preserves supervisor state in the integration test. |
| Wrapper | `cd wrappers/cxx && go test ./...`, `go build ./...`, `go vet ./...` | Passed. Later targeted schedulewatch/agentportal tests and build/vet also passed after explicit unconfirmed-exit reporting was added. |
| Frontend static | `cd frontend && npm run check` | Passed, including 999 unit tests. |
| Browser broad regression | `npm run test:e2e` | 396 passed. |
| Final browser slice | `PLAYWRIGHT_PORT=4186 npm run test:e2e -- admin-supervisor.spec.ts admin-topology.spec.ts` | 24 passed after the final narrow-screen layout change; light/dark 320px reflow, Axe, permission gates, ambiguous save, selected pause, keyboard/agent-inspector regressions. |
| Diff | `git diff --check` | Passed. Committed SPA files were regenerated from frontend source. |

The new supervisor tests exercise all three engines, early capacity before the first
scan, an immutable incident deadline, refusal of a sixth admission, foreign/stale
state writes, a three-agent cycle, parallel accepted handoffs, unanswered freeform
waits, paused retention protection, unconfirmed process termination and explicit
completion followed by a genuinely new native turn. Native-process tests use only
owned local disposable children; provider failures are simulated.

One final browser-server startup ended with exit 143 before assertions ran. Repeating
the same slice on its own port succeeded (24/24); no product workaround was introduced.
Docker was unavailable, so the database checks used the isolated local MySQL server.

## Evidence boundaries and rollout

No live provider outage was induced. No production deployment, migration, restart,
push or fleet activation occurred. Docker packaging and host-by-host rollout are
unverified. Full manual screen-reader/zoom and independent usability acceptance remain
pending; automated Axe and Chromium checks do not establish those outcomes. Applied
UI rules: NAV-1/3, INT-2/3/5/6/7/8 and ACC-1/3/4; no design exception was introduced.

For rollout, use the normal deployment/migration runner and wrapper distribution,
verify 0.9.139 capabilities on selected hosts, then explicitly enable supervision in
Settings. To stop the new behavior, disable supervision; accepted work continues.
The local source change can be reverted as one task commit; retain diagnostic tables
and avoid dropping them during rollback. See [the contract](../agent-supervisor.md).
