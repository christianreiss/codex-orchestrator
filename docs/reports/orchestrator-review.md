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

## Native evidence, 21 November 2026

| Engine | Distribution, launch and supported scope | Executed evidence |
| --- | --- | --- |
| Codex | Official stable 0.171.0. The host pointer resolved to a private 0.171.0 binary, SHA256 `b76a027d6b210f9a8da7aaf321dd235c700f0ef7a794d4a5314b9af6c134f0f0`. The runner's Linux amd64/arm64 artifacts have independent hashes. The upstream schema and models file matched repository fixtures. | Native version, help, exec/features/app-server grammar with synthetic HOME. No authenticated model entitlement inferred from catalogue. [Release](https://github.com/openai/codex/releases/tag/rust-v0.171.0), [schema](https://raw.githubusercontent.com/openai/codex/rust-v0.171.0/codex-rs/core/config.schema.json), [models](https://raw.githubusercontent.com/openai/codex/rust-v0.171.0/codex-rs/models-manager/models.json). |
| Claude Code | 2.1.330 latest normal, conservative stable 2.1.323. Private native AMD64 SHA256 `f390eaa0814e6a1bff74cbb47acb74cb9c89d30ced809fe0af5af00c7bfe8ebb`. The runner pin and platform artifact metadata are checked in the installer path. | Native client and actual FastAPI /exec against loopback Anthropic SSE confirmed end_turn, 11 input / 3 output / 5 cache-write / 7 cache-read and refusal with native failure. The provider and OAuth were fixtures. [Release](https://github.com/anthropics/claude-code/releases/tag/v2.1.330), [settings scopes](https://code.claude.com/docs/en/settings-reference), [stop reasons](https://platform.claude.com/docs/en/build-with-claude/handling-stop-reasons). |
| Grok Build | 1.0.92 at xAI stable and npm latest. Native Linux x64 SHA256 `add4d201dbf2c0bd6077a36feb55a76939de30bae48dbb06f16b2307d38ceacb`, arm64 `8c74f1dc6cdc1befff6b9faada06bec4cf6759d04f2a60cdc28ece5ff696b44f`. Eight new options, two removed. | Both installer digests checked, amd64 native inspect and help/argv exercised. Host-rendered TOML reached actual parser. Native warning makes interactive effect of legacy dashboard grouping uncertain. [Vendor stable pointer](https://x.ai/cli/stable), [interface decision](../interface-cgx.md). |
| Kimi Code | 2.7.2, wrapper compatibility floor 2.5.3. Six release platforms, manifest SHA256 `a685369a0d4ce1f57c4fc7d4392d9bc6780a7f132cd41ddc24cd7cd8ef14aa76`, test Linux binary `7f82148d26467874400d19ee8d23ead13cece9cd0c17648a5622cae480a5a596`. | Actual CLI against a loopback provider fixture, native argument oracle, hook at initial prompt and Stop, subsequent turn preserved transcript. No usage/stop reason synthesized. [Manifest](https://code.kimi.com/kimi-code/binaries/2.7.2/manifest.json), [release](https://github.com/MoonshotAI/kimi-code/releases/tag/%40moonshot-ai%2Fkimi-code%402.7.2), [models](https://www.kimi.com/code/docs/en/kimi-code/models.html). |

The first actual Dockerfile entrypoint test ran in rootless Podman with a dedicated MySQL 8.4 server, an application-owned storage mount and independent Ed25519 keys. Beginning unclaimed, an HTTP client created an owner, saved and read fleet defaults, completed the wizard, registered a four-engine host and signed out. The former cookie got 401. Offline signing key import and a task-keyed five-platform wrapper build supplied the signed configs for all four engines. Ed25519 verification succeeded with the independently imported public key. A model change altered the signed client document digest and version; authenticated sync/bootstrap returned the document. Provider identity tests use synthetic identities.

KI-002 (high). A rotated Kimi token was projected with the host's zero expiry before verification. The real sidecar requires numeric remaining lifetime. Both canonical validation and central renewal now use the access-only *runner* projection, preserving expiry and excluding refresh grants. Eighteen Kimi fencing/rotation tests passed against MySQL, synthetic grant and runner endpoints. The host projection keeps its existing ownership contract.
