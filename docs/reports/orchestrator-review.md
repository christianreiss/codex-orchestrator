# Orchestrator engineering review, 21 November 2026

**Acceptance in progress.** Original checkout on biest.eulie.de, branch `main` at
`480a20e423fa8c38960c090e85c72c929a279960`. Clean worktree and index, one
linked checkout at discovery. Fetched `origin/main` at the same SHA. Git
Director and the checkout-scoped presence query reported zero other owners
with complete coverage. Integration branch `review/orchestrator-cc420cbc-8075-4068-b321-fed71a4580d5`.
Origin is `ssh://git@git.alpha-labs.net:2222/eulotorium/codex-orchestrator.git`.

## System map and working boundaries

The baseline contains 3,882 tracked files. The first-party surfaces include the
Fastify API, the four native launchers in one Go executable, the Svelte SPA,
Python inference runner, Android companion, Plasma widget, Advisor, media and
design-review workers, installers and deployment tooling. The API also owns
the external-client host and two independent authentication domains for admin
and managed hosts. An engine assignment, a gateway key namespace and the
actual provider backend are distinct inputs to request handling.

| Source | Actual entry and boundary |
| --- | --- |
| `api/src/server.ts`, `control-plane/`, `routes/index.ts` | Storage flock and MySQL named lock, migrations and hydration precede service composition. Commands and outbox carry durable effects. HTTP, WebSocket, SSE, the host daemon and MCP use these services. |
| `api/src/db/`, `api/scripts/` | Baseline for a fresh installation, numbered idempotent migrations, generator and maintenance commands. The running MySQL schema owns persisted facts. |
| `wrappers/cxx/cmd/cxx`, `wrappers/Makefile` | Multicall aliases, native PATH shims, embedded public key, configuration, account and update paths, communicator, hooks and private self-invocations. Build tags and five OS/architecture pairs are separate entry conditions. |
| `runner/`, `advisor/`, `media-worker/`, `slop-worker/` | HTTP inference and token probes, asynchronous native child processes, media transformation, and static/design reviews. The detector under `slop-worker/vendor/` is vendored. |
| `frontend/src/routes/`, `frontend/src/lib/`, `public/admin/` | SvelteKit navigation, shared components, TanStack Query and WS invalidation. Build copies immutable assets into the tracked SPA. Manual articles are authored content. |
| `mobile/android/`, `plasmoid/` | Native Gradle app and KDE Plasma client. Android CI builds APKs and runs lint and JVM unit tests. The instrumentation APK build alone does not exercise a device. |
| `bin/`, `scripts/`, `caddy/`, Dockerfiles, Compose, bakery storage, `.github/workflows/` | Installation, update and cutover, termination of former writers, TLS proxy, storage and artifact serving. Source discovery and a production rollout have separate authorization. |
| `docs/`, `DESIGN.md`, `README.md`, `CHANGELOG.md` | Operator and interface contracts, workflow prompts and historical evidence. Prior reports describe their measured revisions. |

## Findings ledger

IDs remain stable across implementation and review. Proof classified as *static*
is a source/registration observation. A test which replaces a subprocess,
provider or network transport establishes only the internal boundary it runs.

| ID / severity | Evidence, consequence and decision | Owner, changes and verification |
| --- | --- | --- |
| AC-001 / high | `bin/orchestrator update` backed up the entire env file and SQL independently of the deploy helper. This retained credentials and violated the operator recovery policy. The owner and overview documents prescribed a conflicting rollback. | Wanda. Remove automatic copy/dump; retain lock, clean-tree check, pinned Git ref, re-exec, deploy and readiness. Test rejects a dump command, checks both initial and repeat updates. Failed before fix; 22 instance CLI tests passed after, one Docker opt-in skipped. |
| AC-002 / high | `ControlPlaneOwnership.close` notified the same listener used for fatal loss. A slow regular shutdown could be killed after 250 ms. A listener registered after actual loss missed the signal. | architecture_control. Distinguish orderly teardown, delivered loss and late subscription. Three regression assertions failed before fix; 35 targeted tests passed including storage/command/outbox. |
| AC-003 / high, acceptance | Idle cohort used modulo three for a four-engine list and reported three native sessions for the single-communicator case. Results overstated engine coverage. | Wanda. Use production engine registry, record individual registrations and assert complete coverage. Wall-clock verification in progress. |
| AC-004 / high | An interrupted pristine-schema initialization can leave application tables without the remaining baseline. The next run classifies the database as populated. Numbered migrations require existing application tables. | Open. Must distinguish an interrupted pristine install from a supported existing deployment before allowing any replay. |
| UI-001 / high | A single QueryClient spanned successive browser identities, allowing cached state and late completions to cross user boundaries. Permission revocation could leave actions visibly enabled. | frontend_integration. Two real Chromium fixture scenarios failed on baseline and passed after the session change. Final asset and server review pending. |
| UI-002 / low | CI ran the frontend unit suite twice because `check` already invokes `test`. | frontend_integration. Remove duplicate CI invocation; keep the gate in `check`. |
| CX-001, CX-002 / high | A provider descendant could survive a completed Chatty turn; verification and draft helpers did not terminate owned process groups. | codex_research. Process-group termination and pipe-drain changes. Five regressions failed before fix. Python 3.12.12, Ruff and 271 pytest passes, two native Kimi opt-ins verified separately. |
| WR-001 / high | Both normal and traced govulncheck runs found reachable GO-2026-6888 in Brotli 1.2.6. | Wanda. Update to fixed 1.2.7 and bump the wrapper bakery version. Recheck both build modes. |
| AR-001 / low | Knip missed the signing and retention executable entry points and reported maintained native verification scripts as unused. Workflow document diff had two identical implementations. | Wanda. Add executable entries, reuse contract implementation. Keep signing and verification scripts with their real callers. |
| AR-002 / low | The only importer of `RepeatableRows.svelte` was `ScalingSection.svelte` removed in `6ecd3cdc7`. No runtime glob or exported component registry loads it. | Wanda. Remove orphaned internal component. No public URL, stored data, or external interface to migrate. |
| CL-001/002/003, GX-001, KI-001 | Engine research and implementation in progress. | See engine decisions and final gate record below as completed. |

## Checkpoint for continuation

Real MySQL 8.4, rootless Podman on loopback, disposable `codex_test` database.
The initial baseline fixture applied 357 statements and 133 numbered migrations.
A second dedicated MySQL instance is reserved for idle observations. The API
fast tier reported 8,946 passes and 1,326 skips in an early integration run.
Android lint, JVM tests, app and instrumentation APK builds passed. Terminal
matrix baseline passed 595 real PTY cases. Runtime, database coverage, final
asset comparison, browser checks and independent integration review must be
recorded against the delivered state. No production operation is part of these
measurements. Never replay a migration, work item or provider canary on a real
account to fill an evidence gap.
