# 2026-03-18
- Admin UI: tightened the 2026 main navbar into one unified menu shell, grouped utility controls into a shared cluster, removed the remaining bubble/pill treatment from primary nav items and header actions, and refreshed the desktop/mobile drawer styling so the whole header reads as one polished system.
- Admin UI: redesigned the top navigation from a row of separate rounded buttons into one unified app menu bar — primary nav items now use bottom-indicator active states instead of pill backgrounds, utility/action controls are visually separated from primary navigation, and the header reads as one cohesive surface rather than a collection of floating controls. Added `aria-current="page"` for active route accessibility.
- MCP/runner security: host-authenticated `/mcp` now exposes only host-safe memory/resource/project tools and no longer advertises or dispatches coordinator filesystem `fs_*` helpers; runner verification payloads were trimmed to the fields the runner actually consumes, and the MCP/runner docs were tightened to match.
- Admin UI: refreshed the 2026 desktop nav into a tighter macOS-style command bar with dropdown menus for Hosts, Logs, and Settings, restored mobile tab fallbacks inside the drawer, and cache-bumped the dashboard stylesheet.
- Admin UI: switched the dashboard shell from hash fragments to real `/admin/...` paths (`/admin/dashboard`, `/admin/hosts/*`, `/admin/logs/*`, `/admin/settings/*`, `/admin/projects/{slug}`, `/admin/users`), updated the path bootstrap/init helpers, and cache-bumped the touched admin JS bundles so reloads and deep links stay in sync.
- cdx wrapper/auth contracts: `/auth` and `/versions` now expose `versions.auto_update_enabled`, and host-level `auto_update_override` now tells `cdx` to skip per-run update checks when cron-managed auto-update is already enabled. Wrapper bumped to `2026.03.18-03`.
- Admin hosts: fixed `/admin/hosts` so it also returns `last_cron_check`, which lets the dashboard host detail show real cron auto-update check-ins instead of falling back to `Never` after successful `cdx --cron` runs.
- cdx wrapper: fixed `cdx --cron` HTTPS verification to reuse the wrapper’s relaxed Python SSL-context setup (`VERIFY_X509_STRICT` fallback disable plus explicit insecure-mode fallback), so cron auto-update checks no longer fail on hosts whose internal CA chain is accepted by curl/OpenSSL but rejected by newer Python TLS validation. Wrapper bumped to `2026.03.18-02`.
- Skills/AGENTS: the server now auto-seeds canonical AGENTS storage from the checked-in repo `AGENTS.md` on boot, so fleet MCP-first skill guidance is actually served instead of drifting in MySQL. Skill/admin/startup-sync payloads now also expose canonical `skill://{slug}` metadata plus fallback paths for clients that need to render the correct preference order.
- cdx wrapper: hardened `cdx --cron` installs by quoting wrapper/log paths, escaping cron `%` semantics, narrowing remove/install matching to the managed/current wrapper entry, degrading cleanly when `flock` is unavailable, retrying `/cron/report`, and failing closed on mismatched platform release assets. Wrapper bumped to `2026.03.18-01`.
- Host pruning: `/cron/check` now records only `last_cron_check`, so stray cron pings no longer refresh host `updated_at` and keep inactive/decommissioned hosts alive.
- Ops: slimmed `scripts/refresh-chatgpt-usage.php` down to quota-refresh work only and switched `quota-cron` health from a DB probe to a heartbeat-driven success signal.

# 2026-03-17
- Admin passkeys: fixed WebAuthn RP ID/origin fallback so admin login now prefers the canonical `PUBLIC_BASE_URL` host/origin when explicit `ADMIN_WEBAUTHN_*` overrides are unset, avoiding request-host drift behind proxies after restarts.
- Admin UI: unified the login page, dashboard shell, and admin access/error screens behind one shared theme layer with local fonts, matching glass surfaces, and themed HTML responses for mTLS/UI load failures.
- Skills/docs/admin: switched fleet guidance to a `cdx`-first model so Skills are now documented as canonical via MCP `skill://{slug}`, with synced `~/.agents/skills/<slug>/SKILL.md` copies treated as fallback-only compatibility files.
- Admin login: switched `/admin/login` to a username-first single-button flow, added `/admin/auth/login/method`, and now require passkey-enabled admins to use passkeys instead of falling back to password login.
- Admin passkeys: hardened passkey login/registration error handling so malformed WebAuthn payloads now return explicit 4xx errors instead of falling through as HTTP 500 `Unexpected error` on the login page.
- Admin hosts: fixed `/admin/hosts` so it returns each host’s `auto_update_override`, which keeps the Cron auto-update toggle from snapping back to the fleet-default visual state right after a save.
- Ops: added `scripts/export_ai_bundle.sh` to export repo-scoped AI debugging bundles for the app, wrapper, and runner surfaces, with canonical docs/tests included and secrets/runtime noise excluded.
- Admin passkeys: hardened WebAuthn policy so registration/login now require user verification (`UV`), login is username-bound via `allowCredentials` instead of username-less discoverable credentials, and registration no longer forces platform-only authenticators.
- Admin passkeys: fixed sign-counter handling so regressions log `admin.auth.passkey.sign_count_regression`, never reduce the stored counter, and still update `last_used_at`.
- Admin passkeys: made WebAuthn challenge consumption transactional/atomic, added explicit `ADMIN_WEBAUTHN_ORIGIN` support, and refreshed admin/API/login/interface docs to match the implemented passkey surface and default mTLS boundary.
- Admin ops: added `scripts/admin-passkeys.php` for Docker/Compose recovery so operators can delete an admin user’s stored passkeys without manual database edits.

# 2026-03-16
- Projects/CoCo: fixed project coordination error handling so missing/disabled project paths return proper HTTP 404/500 responses instead of crashing on reversed `HttpException` arguments, and added MCP `project_create` so `#coco` can bootstrap fresh shared slugs without raw REST fallback.
- MCP skills: `/mcp` now exposes read-only `skill://{slug}` resources for synced Skill manifests, so remote Codex clients can read managed skills like `coco` without assuming a local `~/.agents/...` path.
- cdx wrapper: fixed macOS Bash 3.2 launch paths after the IPv4-proxy wrapper update by avoiding empty `cmd_prefix` / proxy argv array expansion under `set -u`, which previously crashed `cdx ls` and other Codex launches with `unbound variable` before Codex started. Wrapper bumped to `2026.03.16-01`.
- CoCo cleanup: removed the temporary server-side retirement hook for the old `CoCo Toolkit` record and deleted the already-retired legacy DB row, leaving only the managed project-native `coco` skill in code and storage.
- Projects/CoCo cleanup: removed the temporary legacy `/project/*`, `/bootstrap`, `/b/{slug}`, and `/p/{slug}` compatibility routes again so CoCo is once more strictly project-native on `/projects/*`.
- Skills cleanup: the server now auto-retires the old stored `skills.slug = "coco"` / `CoCo Toolkit` database document by signature, leaving the managed project-native `coco` skill as the only active CoCo skill surface.
- Docs/tests: removed the temporary legacy CoCo alias docs again and flipped the router coverage so the new project-native surface stays the only supported path.

# 2026-03-15
- cdx wrapper: extended `force_ipv4` / `cdx -4` so the wrapper now launches Codex behind a short-lived local IPv4-only proxy, making Codex-side `chatgpt.com` traffic honor IPv4-only hosts in addition to the wrapper’s own sync/update calls. Wrapper bumped to `2026.03.15-01`.

# 2026-03-14
- cdx wrapper: fixed `cdx ls` / `cdx lane` on macOS Bash 3.2 by avoiding empty-array argv reset under `set -u`, which previously crashed with `lane_passthrough[@]: unbound variable` before Codex launched. Wrapper bumped to `2026.03.14-01`.
- ChatGPT usage refresh: fixed `scripts/refresh-chatgpt-usage.php` to match the current `AuthService` wiring so the `quota-cron` worker boots cleanly after the Codex version-floor changes and can keep refreshing usage snapshots.

# 2026-03-13
- Codex version policy: added an internal minimum Codex CLI floor at `0.114.0`; fleet and host pins below that are coerced upward, `/auth` and `/versions` now expose `client_version_enforce_exact`, and `cdx` only downgrades when that flag is true for an above-floor exact pin. Wrapper bumped to `2026.03.13-03`.
- cdx wrapper: restored usage capture for Codex `0.114.0+` by resolving the emitted `session id` to `~/.codex/sessions/.../*.jsonl` and reading structured `token_count` usage rows, with fallback to the new `tokens used` footer and the older `Token usage:` line format. Wrapper bumped to `2026.03.13-01`.
- Usage API/docs/tests: `/usage` now leaves `cost=null` when clients only report total tokens without billable input/output/cached splits, preventing misleading `0.00$` run-cost displays while still recording usage totals.

# 2026-03-13
- Projects/CoCo cross-server guardrails: CoCo shared handoffs are now explicitly project-only in the managed `coco` skill, bootstrap payloads, API/admin copy, and MCP docs; host-scoped `memory://...` resources are no longer described as a valid fallback for shared CoCo state.
- MCP memories: reserved keys matching `^coco(?:$|[._:-])` are now rejected with a validation error so cross-host CoCo handoffs cannot be mis-modeled in `mcp_memories`, which remain host-scoped by design.
- cdx wrapper: skill pull sync now removes stale legacy managed copies under `~/.codex/skills/<slug>` so an old pre-project `coco` skill cannot shadow the managed `~/.agents/skills/coco/SKILL.md` rollout on upgraded clients. Wrapper bumped to `2026.03.13-02`.

# 2026-03-12
- Projects/CoCo module: the managed `coco` skill now embeds the native CoCo toolkit/help directly, and project bootstrap payloads now point agents to that skill instead of a separate help page.
- cdx wrapper: managed skills that disappear from the remote list are now pruned locally on sync, so disabling the Projects module removes the auto-managed `coco` skill from clients on their next pull. Wrapper bumped to `2026.03.12-02`.
- Projects/CoCo module: added a native shared-project coordination module with admin + host REST routes under `/admin/projects*` and `/projects*`, covering project creation, about/roster updates, shared notes, todos, files, feedback, and append-only activity history.
- MCP + client rollout: `/mcp` now exposes project-aware tools/resources (`project_*`, `project://{slug}`) when the module is enabled, and enabling the module auto-publishes a managed `coco` skill to Codex clients through the normal Skills sync path.
- cdx wrapper: managed project skills now keep `managed` metadata in the Skill baseline and are skipped during wrapper-side `/skills/store` pushback, so the auto-deployed `coco` skill stays read-only on clients without generating noisy sync errors. Wrapper bumped to `2026.03.12-01`.
- Admin/UI/docs/tests: compressed Settings → Projects into a compact index with Open/Delete actions, moved the full project editors onto a dedicated `#project-detail/<slug>` admin page, marked the managed `coco` skill read-only in the Skills UI, corrected Skill sync copy to `~/.agents/skills/<slug>/SKILL.md`, and refreshed API/admin/MCP/interface docs plus regression coverage.

# 2026-03-11
- Config builder/model default: switched new top-level config drafts and new profile drafts from `gpt-5.3-codex` to `gpt-5.4`, cache-bumped both admin builder assets, and refreshed the config-builder docs/example payloads.
- Config builder/default matrix: changed the fleet config defaults so only `apps` and `multi_agent` stay on by default, while `guardian_approval`, `js_repl`, `use_linux_sandbox_bwrap`, and `prevent_idle_sleep` now start off until explicitly enabled; cache-bumped the admin config builder asset and refreshed docs/tests.
- Config builder/prevent-idle-sleep: added a first-class `Prevent sleep while running` toggle and defaulted `[features].prevent_idle_sleep = true` in normalized/rendered `config.toml`, so Codex keeps the computer awake during active threads unless explicitly disabled; cache-bumped the admin config builder asset and refreshed docs/tests.
- Config builder/guardian approval: added the upstream `Automatic approval review` feature as a first-class toggle, added `guardian_approval` to the supported feature allowlist, and defaulted `[features].guardian_approval = true` in normalized/rendered `config.toml`, so `on-request` approval prompts can be routed through the security reviewer subagent by default; cache-bumped the admin config builder asset and refreshed docs/tests.
- Config builder/bubblewrap: added a first-class Bubblewrap sandbox toggle and defaulted `[features].use_linux_sandbox_bwrap = true` in normalized/rendered `config.toml`, so the new Linux bubblewrap sandbox is enabled fleet-wide unless explicitly disabled; cache-bumped the admin config builder asset and refreshed docs/tests.
- Config builder/js_repl: added a first-class JavaScript REPL toggle and defaulted `[features].js_repl = true` in normalized/rendered `config.toml`, so the persistent Node-backed JS REPL is enabled fleet-wide unless explicitly disabled; admin copy/docs now call out the Node `>= v22.22.0` requirement, and the config builder asset was cache-bumped with refreshed tests.
- Config builder/apps: added a first-class ChatGPT Apps toggle and defaulted `[features].apps = true` in normalized/rendered `config.toml`, so `$` App usage is enabled fleet-wide unless explicitly disabled; cache-bumped the admin config builder asset and refreshed docs/tests.
- cdx wrapper: fixed self-update restart on CentOS 7 / XCP-NG Bash 4.2 by snapshotting the original argc separately from argv, so no-arg wrapper re-execs and lock metadata formatting no longer trip `set -u` on empty-array expansion; wrapper bumped to `2026.03.11-02`.
- cdx wrapper: added `cdx ls` as shorthand for `cdx lane spark` (including `--persist` and passthrough args) so hosts can jump into the Spark lane with a shorter command. Wrapper bumped to `2026.03.11-01`.

# 2026-03-10
- cdx wrapper: interactive SSH sessions now bypass wrapper PTY capture and launch Codex directly unless `CODEX_FORCE_PTY=1`, avoiding stacked-PTY rendering/input issues on hosts like `lims`; `cdx doctor` now reports `ssh-launch=direct-tty|pty-forced`, and wrapper-side usage capture may be unavailable for those SSH runs. Wrapper bumped to `2026.03.10-10`.
- cdx wrapper: removed the interactive SSH keyboard compatibility bridge and the `CODEX_SSH_KEYBOARD_FILTER` toggle, returning SSH launches to the standard PTY/direct execution paths after the bridge caused more trouble than it solved. Wrapper bumped to `2026.03.10-09`.
- cdx wrapper: fixed the SSH keyboard bridge input parser so plain `Enter` bytes are normalized to carriage return and non-CSI-u escape sequences pass through instead of stalling in the pending-input buffer; this restores prompt submission over SSH while keeping arrow/paste-style sequences from wedging input. Wrapper bumped to `2026.03.10-08`.
- cdx wrapper: fixed the SSH Python PTY paths to copy the real terminal window size into child PTYs and forward `SIGWINCH`, preventing Codex from rendering one character per line after the bridge/fallback started the UI on SSH hosts. Wrapper bumped to `2026.03.10-07`.
- cdx wrapper: fixed the interactive SSH keyboard bridge to bind input from `/dev/tty` instead of the heredoc-backed `stdin`, and keep draining the child PTY even if wrapper input goes idle; this stops plain SSH launches from immediately dropping back to the shell on insecure hosts (and other bridge-enabled SSH sessions). Wrapper bumped to `2026.03.10-06`.
- cdx wrapper: fixed insecure-host one-shot runs by deferring `--execute` launch into the normal authenticated startup path (sync/auth/update/gates) instead of short-circuiting before `/auth`; this prevents immediate unauthenticated exits after post-run `auth.json` purge. Wrapper bumped to `2026.03.10-05`.
- cdx wrapper: when a wrapper version update is pending, Codex binary update now defers until the post-restart pass so one invocation no longer installs two different Codex versions back-to-back (for example `0.113.0` then `0.112.0`); wrapper bumped to `2026.03.10-04`.
- cdx wrapper: pre-launch now idempotently force-trusts the active working directory (plus `pwd -P` when it differs) in local `~/.codex/config.toml`, preventing repeated interactive "Do you trust this directory?" prompts after Codex `0.113.0`; wrapper bumped to `2026.03.10-03`.
- Config builder/personality: added root `personality = "friendly"|"pragmatic"|"none"` support to fleet-managed `config.toml`, defaulted new/existing configs to `friendly`, and added optional profile-level overrides that inherit the root value when unset.
- Admin/docs/tests: added a dedicated config-builder personality selector, profile override control, cache-bumped `config.js`/`profiles.js`, updated config/interface docs, and expanded `ClientConfigService` coverage for root/profile personality rendering.
- cdx wrapper: replaced the earlier SSH version pin with an interactive-SSH keyboard compatibility bridge that strips Codex kitty keyboard enable/disable sequences and normalizes CSI-u Enter/Ctrl keys before launch, so prompts submit again over SSH without changing the installed Codex version. `cdx doctor` now reports SSH terminal hints plus bridge state. Wrapper bumped to `2026.03.10-02`.
- Installer/docs/tests: installer no longer downgrades Codex on SSH; wrapper/interface docs were updated for the SSH keyboard bridge, and regression coverage now locks the bridge/doctor strings into the built wrapper and installer template.

# 2026-03-09
- Config retrieve/render fix: `notice.model_migrations` now merges saved maps with default migrations, so legacy stored configs that only had `gpt-5.2-codex -> gpt-5.3-codex` also receive `gpt-5.3-codex -> gpt-5.4` and stop surfacing the interactive GPT-5.4 upgrade chooser.
- Config builder/template defaults: added `notice.model_migrations` mapping `gpt-5.3-codex -> gpt-5.4` (alongside `gpt-5.2-codex -> gpt-5.3-codex`) so Codex `0.112.0+` upgrade prompts are auto-resolved from fleet-managed `config.toml`.
- Admin UI/docs/tests: updated config-builder defaults, cache-bumped `config.js`, refreshed config/interface docs, and expanded `ClientConfigService` assertions for the new migration mapping.
- Codex `0.112.0` compatibility audit: feature normalization now drops removed/unknown `features.*` keys and keeps only currently supported Codex feature flags (while still mapping deprecated `web_search_request`/`web_search_cached` into root `web_search`).
- Admin config UI/docs: replaced stale feature toggles with current valid defaults (`fast_mode`, `unified_exec`, `voice_transcription`, `multi_agent`) and updated feature docs/contracts accordingly.

# 2026-03-06
- Security/wrapper: insecure-host baked `config.toml` no longer persists a reusable managed MCP host API key; secure hosts still use the host API key, while insecure hosts now receive a short-lived MCP bearer token backed by the new `mcp_session_tokens` store.
- cdx wrapper: hardened GitHub release-asset Codex updates by requiring a trusted SHA-256 digest from release metadata before install; missing or mismatched digests now skip the binary update instead of installing unchecked content. Wrapper bumped to `2026.03.06-03`.
- cdx wrapper: fixed deleted-skill startup sync by importing `shutil` in the embedded Python used by `skill_sync_python()`.
- Docs/tests: updated API/config/db/wrapper docs plus regression coverage for insecure-host managed MCP baking, MCP bearer auth wiring, checksum-enforced Codex updates, the new MCP token table, and deleted-skill sync imports.
- Admin dashboard: fixed `/admin/overview` crashing with `HTTP 500 {"status":"error","message":"Unexpected error"}` by restoring the `$pricingModel` closure capture before pricing lookup; added regression coverage for the route signature.
- cdx wrapper: fixed concurrent/read-only quota hydration parsing so missing `chatgpt_usage` payloads no longer break metadata refresh and numeric-string quota fields are accepted, restoring quota bar rendering when usage metadata is returned as strings; wrapper bumped to `2026.03.06-02`.
- Model support: added `gpt-5.4` to the config builder and per-host override allowlists across the API, admin UI, and validation logic, with full `low|medium|high|xhigh` reasoning-effort support.
- Pricing defaults: cost snapshots/backfills/overview calculations now target `gpt-5.4` by default and prefer `GPT54_*` env fallbacks while still honoring legacy `GPT51_*` values for backward compatibility.
- Docs/tests: refreshed interface/install/admin/README notes for the new model and pricing defaults, and added coverage for `gpt-5.4` config validation plus pricing fallback precedence.
- cdx wrapper: help-only invocations now bypass wrapper MOTD/sync/quota/footer noise and pass straight through to the real Codex CLI, so `cdx --help`, `cdx -h`, `cdx help`, and Codex subcommand help (for example `cdx exec --help`) print only upstream help text; wrapper bumped to `2026.03.06-01`.
- Docs/tests: updated wrapper interface/overview docs and added regression coverage for the early help passthrough path.

# 2026-03-05
- cdx wrapper: spark reasoning-summary guard now resolves the effective model from top-level `config.toml` defaults (including explicit profiles that inherit the root model), and execute-mode passthrough selectors (`--model` or `--profile`) now resolve Spark models the same way and inject root/profile `model_reasoning_summary=none` overrides; this closes remaining `reasoning.summary` leaks on both normal and execute paths; wrapper bumped to `2026.03.05-01`.

# 2026-03-03
- Wrapper seeding hardening: `WrapperService` now serves bundled `bin/cdx` as a fallback when `storage/wrapper/cdx` drifts but cannot be overwritten (for example ownership/capability mismatches), and logs an explicit warning instead of silently serving stale wrapper content.
- Tests/docs: added `WrapperService` coverage for non-writable storage fallback and updated wrapper source semantics in `interface-api`/`OVERVIEW` docs.

# 2026-03-02
- cdx wrapper: `cdx lane spark -- --execute "<prompt>"` now honors lane selection in execute mode (profile-first, spark-model fallback) instead of hardcoding `gpt-5.3-codex`, and applies both root/profile spark summary guards to avoid `reasoning.summary` 400s; wrapper bumped to `2026.03.02-04`.
- cdx wrapper: spark summary safeguard now also overrides profile-scoped summary keys (`profiles.<name>.model_reasoning_summary=none`) when a spark model is selected via profile, preventing `reasoning.summary` leaks from legacy profile configs; wrapper bumped to `2026.03.02-03`.
- cdx wrapper: spark summary safeguard is now profile-aware; when `lane spark` (or explicit `--profile`) resolves to a profile whose model is `gpt-5.3-codex-spark`, wrapper injects `--config model_reasoning_summary=none` and avoids OpenAI 400 `unsupported_parameter` (`reasoning.summary`) failures; wrapper bumped to `2026.03.02-02`.
- cdx wrapper: hard-cut Skill sync local path from `~/.codex/skills` to `~/.agents/skills` (baseline moved from `~/.codex/.skill-baseline.json` to `~/.agents/.skill-baseline.json`), and removed flat-file Skill scanning fallbacks so local Skill discovery is directory-only (`<slug>/SKILL.md`); wrapper bumped to `2026.03.02-01`.
- Docs/contracts: updated README, usage/API docs, and wrapper interface docs to reflect `~/.agents/skills` storage and clarify that `/skills/store` persists canonical `SKILL.md` markdown content.
- Tests: expanded wrapper Skill-format assertions to lock `.agents/skills` usage and reject the legacy `.codex/skills` path.

# 2026-02-28
- cdx wrapper: post-run auth push change detection now compares both `last_refresh` and `auth.json` SHA-256 content, so same-timestamp auth/token updates still upload (including concurrent-guard runs) and fleet hosts do not get stranded on stale auth; wrapper bumped to `2026.02.28-02`.
- cdx wrapper: spark summary safeguard now also applies when users explicitly pass `--model gpt-5.3-codex-spark` (not only lane/host model injection), preventing OpenAI 400 `unsupported_parameter` errors for `reasoning.summary`; wrapper bumped to `2026.02.28-01`.
- Docs/tests: updated wrapper reasoning-summary coverage and `interface-cdx` model-summary behavior notes for explicit spark model selection.

# 2026-02-27
- Codex 0.105/0.106 compatibility: config normalization now maps legacy `features.web_search_cached` to root `web_search="cached"` and continues mapping `features.web_search_request` to `web_search="live"`.
- Config builder/runtime cleanup: obsolete feature keys (`steer`, `experimental_windows_sandbox`, `enable_experimental_windows_sandbox`) are now ingest-compatible but removed from normalized/rendered config output.
- Admin config UI: removed obsolete Steer and Windows sandbox switches, added `voice_transcription` feature toggle, and cache-bumped `config.js` to `v=2026-02-27-01`.
- cdx wrapper: when lane/host model injection selects `gpt-5.3-codex-spark`, wrapper now also injects `--config model_reasoning_summary=none` to match current Codex CLI/API behavior; wrapper bumped to `2026.02.27-01`.
- Tests/docs: updated config/wrapper coverage for spark summary handling + obsolete key dropping and refreshed config/wrapper/overview interface docs to match current behavior.

# 2026-02-23
- Security/network trust: added explicit forwarded-header trust gating via `TRUST_X_FORWARDED` + `TRUSTED_PROXY_CIDRS`; client IP and base-url/origin resolution now honors `X-Forwarded-*` only from trusted proxy source IPs.
- Security/host routing: added production-facing `PUBLIC_BASE_URL` policy controls (`PUBLIC_BASE_URL_REQUIRED`, `STRICT_HOST_VALIDATION`) and tightened MCP origin behavior with opt-in request-host auto-allow (`MCP_ALLOW_REQUEST_HOST_ORIGIN`).
- Runner hardening: added optional API->runner shared-secret authentication (`AUTH_RUNNER_SHARED_SECRET` / `RUNNER_SHARED_SECRET`) and hardened auth debug dumps so they require dual opt-in and are disabled in production.
- Crypto/key management: added staged key-rotation support for auth secretbox encryption (`AUTH_ENCRYPTION_KEYS`, `AUTH_ENCRYPTION_ACTIVE_KID`) with backward-compatible decrypt support for legacy ciphertext format.
- Startup/runtime behavior: added `scripts/migrate.php` and boot flags (`RUN_MIGRATIONS_ON_BOOT`, `RUN_BACKFILLS_ON_BOOT`) so schema/backfill work can be moved out of request-path in production.
- Container/deploy hardening: switched compose project naming to `codex-orchestrator`, reduced runtime image packages/extensions, and added compose hardening defaults (`read_only`, `tmpfs`, `cap_drop: [ALL]`, `no-new-privileges`) for API/runner sidecars.
- Admin/UI/docs polish: unified visible product naming on admin pages, self-hosted login fonts (no Google Fonts dependency), refreshed security/install/MCP/runner/interface docs, and expanded regression coverage for trusted-proxy IP resolution, runner shared-secret checks, and encryption key rotation.

# 2026-02-22
- Admin websocket hardening: dashboard live-refresh routing now uses explicit action/domain constants with a codified unknown-action fallback (`overview` + `hosts`), websocket client parsing now validates event envelopes and seeds reconnect cursors from `/admin/ws/info` `last_event_id`, admin dashboard HTML cache-bumped updated `dashboard.js`/`admin-ws.js` assets, and new regression tests now lock script wiring/order plus websocket client/route metadata contracts.
- Startup sync/API: added `POST /sync/status` and `POST /sync/bootstrap` plus `StartupSyncService` to batch startup pull diffs/payloads for prompts, Skills, AGENTS.md, and config; wrapper now attempts bundled startup pull first and falls back to legacy per-resource sync on older servers; added contract schemas/fixtures/tests for both endpoints; wrapper bumped to `2026.02.22-03`.
- cdx/CI: split wrapper monolith fragments (`bin/cdx.d/02-auth.sh`, `bin/cdx.d/05-main.sh`) into ordered concern-focused parts, added a built-wrapper ShellCheck gate (`shellcheck -S warning -e SC2034 bin/cdx`), and added `scripts/verify-wrapper-version-bump.sh` to require `WRAPPER_VERSION` bumps when `bin/cdx` changes; wrapper bumped to `2026.02.22-02`.
- API/docs/testing: added executable interface contracts for critical host responses (`docs/contracts/auth-retrieve.schema.json`, `auth-store.schema.json`, `versions.schema.json`, `usage-ingest.schema.json`) with fixture validation (`tests/ContractSchemasTest.php`), live `AuthService` contract coverage (`tests/AuthServiceContractResponsesTest.php`), auth deny reason contract checks (`tests/AuthReasonContractsTest.php`), and a docs drift gate (`scripts/verify-interface-contracts.php`) wired into CI.
- Installer: `curl .../install/<token> | bash` now ends with a compact post-install quickstart block (`cdx --version`, first `cdx` sync/auth run, and `cdx --execute` example) so hosts get immediate usage guidance at install completion.
- Host registration: insecure `POST /admin/hosts/register` now accepts optional `duration_minutes` (0–480) so newly created/rotated insecure hosts can immediately use the configured allow-window duration instead of always starting from the fixed 30-minute default; admin New Host now sends the current Insecure Host Window slider value and cache-bumps the dashboard asset version.
- cdx: run-lock scope now appends the caller UID (`<installation-or-api-scope>-u<uid>`) so stale root-owned files in `/tmp` do not disable concurrent-guard locking for non-root users on shared hosts; wrapper bumped to `2026.02.22-01`.

# 2026-02-21
- cdx: concurrent-guard runs now still push changed `auth.json` at exit and still report token usage to `/usage`; guard messaging now clarifies only pre-run sync/update mutations are skipped. Wrapper bumped to `2026.02.21-03`.
- Admin config builder: added a `Multi-agents` feature toggle and defaulted `[features].multi_agent = true` in rendered/normalized `config.toml`; cache-bumped `config.js` asset version.
- cdx/config: reserved Codex top-level subcommands from profile shorthand so `cdx cloud|features|...` always passes through to Codex (explicit `--profile <name>` still works for colliding profile names); wrapper bumped to `2026.02.21-02`.
- Config builder: removed deprecated `approval_policy=on-failure` from admin UI and added server-side normalization that auto-migrates stored/rendered root/profile approval policy values from `on-failure` to `on-request`.
- cdx: fixed wrapper self-update restart on macOS/legacy Linux by guarding empty original argv under `set -u` (preserves original args when present, falls back to no-arg re-exec when empty, and hardens lock metadata argv formatting); wrapper bumped to `2026.02.21-01`.

# 2026-02-20
- cdx: fixed run-footer column alignment by keeping the `Run cost` label ASCII-only and moving the Unicode `💰` marker into the cost value text; wrapper bumped to `2026.02.20-02`.
- Admin hosts/logs/settings: left-rail menus now use a nav-height-aware sticky top offset so they remain below the main header bar while scrolling.
- cdx: run-footer cost display now formats `/usage` `data.cost` as two decimals with a trailing dollar sign (for example `0.43$`) on the `Run cost` line; wrapper bumped to `2026.02.20-01`.

# 2026-02-19
- Admin hosts/logs: removed the same outer left/right content gutter as Settings so left rails sit flush to the viewport edge on both pages.
- Admin logs: replaced the old top `API/MCP/Events` selector with a left-rail view selector (matching the new hosts/settings rail pattern) and kept mobile on a sticky segmented selector.
- Admin hosts: replaced the old top `All/Secure/Insecure/Unprovisioned` selector with a left-rail filter box (matching settings rail styling) and kept mobile on a sticky segmented selector.
- Admin settings: normalized settings-panel spacing by removing per-panel top margin inside the settings content column, aligning the main table/panel start line with the left rail.
- Admin settings: aligned the left rail vertical start with page content by restoring a settings-specific sidebar top offset (`top: 16px`) while keeping the outer left gutter removed.
- Admin settings: removed the remaining outer gutter in the Settings view so the left rail aligns to the browser edge (settings-only override for `.app`/`.content` spacing).
- Admin settings: tightened left-rail spacing so the settings nav sits flush at the rail's top-left edge (removed sticky top offset, list gaps, and pill-style item insets).
- Admin settings: flattened the left sidebar menu to a single level (removed the `Advanced` subsection) and removed extra top/left inset spacing so nav items align flush with the rail.
- Admin settings: replaced the flat settings tab row with a cleaner IA (desktop left rail + mobile sticky segmented scroller), while preserving existing `#settings/<tab>` hash routes and panel behavior.
- Admin dashboard: removed the hero copy block (`2026 Mission Control` / `Fleet At A Glance`) from the top dashboard info box.
- Admin hosts: re-added the `🍪` marker in the `Authorized Hosts` list for the host that last submitted the current canonical `auth.json` (`auth_source=true`), restoring quick visual attribution.
- Admin dashboard: replaced the top menu bar with a scoped 2026 navigation layer (`data-nav-version="2026"`) featuring a cleaner desktop command bar, explicit `Overview` entry, and a mobile hamburger off-canvas drawer/backdrop flow while preserving existing nav IDs/actions (`New host`, theme toggle, logout) and hash-based panel routing.
- Admin websocket live updates: expanded push-driven refresh coverage across the full admin SPA (Overview, Hosts/Host Detail, Settings panels, Users, Config Builder, Profiles) using action-targeted `log.created` routing with debounced in-flight guards; dashboard now refreshes host-backed stats with live `/admin/hosts` data, config/profile editors hold unsaved local edits and show a remote-update notice, and settings mutations now emit explicit log actions (`admin.api.state`, `admin.cdx_silent`, `admin.reverse_dns`, `admin.insecure_approval`, `admin.codex_version`, `admin.quota_mode`, `admin.prune_policy`) so connected clients stay in sync via server push.
- Admin dashboard graphs: replaced uPlot modal-first charts with inline Chart.js panels on the main dashboard (quota + cost) including range presets (7/30/60/90/180), zoom/pan, previous-period compare overlays, line/stacked mode toggle, pinned keyboard selection, legend visibility persistence, CSV export, and backend queryable history endpoints (`from`/`until`, interval/group/lane/window filters).
- Auth API: `/auth` `command:"store"` submissions are now always evaluated as candidate auth payloads even when insecure-host windows are closed; retrieve/window gating behavior remains unchanged and store still enforces normal API-key/IP/reverse-DNS/installation plus runner validation checks.
- Admin dashboard: rebuilt the Overview layout for a calmer compact flow (mission strip first, ordered card matrix), consolidated conflicting dashboard CSS layers into one canonical rule set, and normalized equal-height card behavior across ChatGPT usage, KPI cards, and Ops Radar in both light/dark themes with tuned mobile stacking.
- cdx: redesigned end-of-run output into a compact footer (`Run usage`, `Run cost`, `Sync`), removed noisy raw `Usage push | ...` / `Auth push | ...` lines, and added a dedicated `💰` run-cost line populated from `/usage` `data.cost` (ASCII fallback label when Unicode is unavailable); wrapper bumped to `2026.02.19-01`.
- Admin hosts: fully redesigned the `Authorized Hosts` list for lower visual noise; rows now focus on hostname, status, last seen, Codex version, and a single insecure-window toggle (removed IP/added/auth-meta/wrapper clutter from list rows; details remain on host pages).
- Admin hosts: replaced the host detail modal with dedicated host detail pages at `/admin/hosts/{id}` and reorganized the content into visual sections (`Action Items`, `Features`, `Stats`, `Infos`) with deep-linkable URLs.
- Admin routing: added HTML dispatch for `GET /admin/hosts/{id}` through `public/admin/index.php` so direct host detail links resolve without falling through API routes.
- Docs/tests: updated host-detail interface references (`docs/OVERVIEW.md`, `docs/interface-api.md`, `docs/interface-cdx.md`) and added UI routing coverage for the dedicated host detail page shell.

# 2026-02-18
- Skills: added "Checkmk Deploy Verify" skill manifest with `#checkmk` trigger plus mandatory pre/post Checkmk agent verification and Dockerized git-copy workflow guidance.

# 2026-02-16
- cdx: auth summary now reflects successful `store` uploads as `valid` (instead of lingering `upload_required` from the pre-store retrieve result), so healthy hosts no longer look stuck in upload-required state; wrapper bumped to `2026.02.16-12`.
- cdx: Quota `Active lane` now marks Spark with a fastness hint (`spark ⚡` on UTF-8 terminals, `spark (fast)` fallback on non-Unicode terminals).
- cdx: removed the `| <n> day partition` suffix from the Daily allowance note in Quota output; it now shows only `allowance <n>%/day` to reduce line noise.
- cdx: summary packing defaults tuned for readability: Quota now prints one bar/metric per line (`SUMMARY_ITEMS_PER_ROW_QUOTA=1`), while Versions defaults to two entries per row (`SUMMARY_ITEMS_PER_ROW_VERSIONS=2`) to avoid overlong lines (e.g., keeps `AGENTS.md` with `config.toml`).
- cdx: add first-class lane steering via `cdx lane` (`normal|spark`, optional `--persist`, and `clear --persist`), plus host lane persistence endpoints (`GET/POST /host/lane`) and host-level `lane_preference`; wrapper now maps host/command-selected lanes to profile-first (`[profiles.normal|spark]`) with model fallbacks, and wrapper version bumped to `2026.02.16-11`.
- cdx: summary blocks now render aligned padded columns instead of raw tab joins, and Quota defaults to one metric per row (`SUMMARY_ITEMS_PER_ROW_QUOTA=1`) so quota bars line up cleanly across lines; wrapper bumped to `2026.02.16-10`.
- cdx: fixed summary rendering exit-on-start regression caused by tabbed row packing (`set -e` with `(( packed_count++ ))`), aligned quota graph labels, and added non-active lane (Spark/Normal) 5h + weekly bar rows in the Quota block; wrapper bumped to `2026.02.16-09`.
- cdx: compact summary blocks now pack up to three tab-separated entries per line across Health/Versions/Usage/Quota/Result sections (override with `CODEX_SUMMARY_ITEMS_PER_ROW`); wrapper bumped to `2026.02.16-08`.
- cdx: add Linux `yum` fallback support for RHEL-family prerequisite installs (including legacy CentOS 7/8/9 paths), map `script` to `util-linux` for `dnf`/`yum`, and add wrapper package-manager coverage tests; wrapper bumped to `2026.02.16-07`.
- cdx: redesigned the boot summary into human-readable `Health`/`Versions`/`Usage`/`Quota`/`Result` sections, improved quota bar presentation with Unicode+ASCII fallback, condensed non-active quota lane output into an `Other lane` line, and switched insecure clean-sync result text to `Synced on insecure host; auth refreshed.`; wrapper bumped to `2026.02.16-06`.
- Quotas: capture and normalize both ChatGPT quota lanes from `/wham/usage` (normal top-level `rate_limit` plus Spark from `additional_rate_limits`), persist Spark lane columns in `chatgpt_usage_snapshots`, and expose lane-aware payloads (`normal_window`, `spark_window`, `active_quota_lane`) while keeping legacy `primary_window`/`secondary_window` compatibility.
- cdx: quota enforcement is now active-lane aware (`normal` vs `spark`), summaries include lane context + other-lane snapshot, and wrapper auth sync now parses dual-lane quota payloads; wrapper bumped to `2026.02.16-02`.
- cdx: split alternate-lane quota summaries out of `Usage` into dedicated rows (`Quota (Spark@s)` / `Quota (Normal@s)`), so call/token usage stays isolated; wrapper bumped to `2026.02.16-04`.
- cdx: table-summary label width now auto-sizes per render so the `|` separators stay aligned across `Core`, `Usage`, and quota rows; wrapper bumped to `2026.02.16-05`.
- Admin dashboard: ChatGPT usage card and quota history now render both normal and Spark lanes (including Spark history points when available).
- Admin dashboard: restored the legacy two-card quota layout (`5-hour` + `weekly`) and now stacks Spark bars under normal bars inside each card.
- Admin auth UX: replaced dashboard login overlay with a dedicated `/admin/login` page (bright glass UI), added server-side redirects between `/admin/` and `/admin/login` based on session state, and removed password-reset UI/API paths (`/admin/auth/password/request|reset` now return `410 Gone`).
- Admin routing: fixed direct hits to `/admin/login` and `/admin/` that reached `public/index.php` by dispatching both routes through `public/admin/index.php`, preventing `Route not found`.
- Admin config/profiles/host overrides: add `gpt-5.3-codex-spark` with reasoning levels `low|medium|high|xhigh` (UI label: `xhigh (Extra high)`).
- Config/API: enforce strict model allowlist for fleet model fields and `/admin/hosts/{id}/model` overrides (`gpt-5.3-codex`, `gpt-5.3-codex-spark`, `gpt-5.2-codex`, `gpt-5.1-codex-max`, `gpt-5.2`, `gpt-5.1-codex-mini`); dead models are no longer accepted.
- cdx: `--execute` now launches with `--model gpt-5.3-codex` (removed dead `gpt-5.1` default for that path); wrapper bumped to `2026.02.16-01`.
- Ops: manually verified `codex --help` against local Codex `v0.101.0` and confirmed wrapper-injected flags still match the current CLI surface (no runtime flag audit added).

# 2026-02-14
- Config: managed `[mcp_servers.cdx]` entry now includes `startup_timeout_sec = 30` to reduce Codex MCP startup timeouts when the coordinator is slow to respond.
- API: reduce per-request overhead by running schema migrations once per deployed schema hash (sentinel under `storage/wrapper/`), gating legacy encryption/backfill routines behind `versions` flags, avoiding `daily_preflight` DB writes on requests where no preflight work was performed, and skipping runner preflight on `/versions` and `/mcp` (improves `/versions` healthcheck latency and host startup when runner is red).
- Runner: bump the auth-runner bundled Codex CLI to `rust-v0.101.0` and always run probes in a per-request temp `$HOME` (cleaned up after each run) to fix `mcp startup: no servers` probe failures and avoid persisting `~/.codex/auth.json` inside the runner container.

# 2026-02-13
- cdx: Linux prerequisite auto-install now checks/installs `script` (util-linux) alongside `curl`/`unzip` when wrapper-managed dependency installation is allowed, so PTY capture support is provisioned automatically; wrapper bumped to `2026.02.13-18`.
- cdx: concurrent-guard runs now do a read-only `/auth` retrieve (no auth store/local auth write) to keep Quota 5h/week/day lines fresh instead of showing `n/a` from stale local-only state; wrapper bumped to `2026.02.13-17`.
- cdx: when concurrent guard is active, boot summary output is now compacted to a single concurrent-guard line plus quota lines (suppresses Core/Versions/Result noise for that path); wrapper bumped to `2026.02.13-16`.
- Admin dashboard: removed forced desktop horizontal scrolling for table wrappers and tuned Fleet Skill registry column sizing (narrower Description cap + fixed Actions width) so per-skill `Edit`/`Delete` stay visible without horizontal scroll.
- Admin dashboard: hardened Skills/Prompts action-column visibility by making table wrappers horizontally scrollable at all desktop widths and rendering row actions inside a dedicated `.table-actions` container; cache-bumped dashboard CSS/mobile CSS/JS.
- cdx: non-TTY stdout launches no longer rewrite argv by forcing `exec`; wrapper now preserves user subcommands/args verbatim and fails fast with a hint to use `cdx --execute` when interactive no-arg launch is attempted without a TTY; wrapper bumped to `2026.02.13-15`.
- Admin dashboard: fixed Fleet Skill registry action visibility by styling shared `table-wrapper` containers like `table-wrap` (restoring horizontal overflow/layout on narrower screens) and labeling the final Skills column as `Actions` so Edit/Delete controls are discoverable.
- Admin dashboard: Mission Control year label now renders from the live calendar year, removed the embedded Fleet At A Glance subtitle + inline refresh/new-host buttons, and moved the Fleet At A Glance card below the primary dashboard grid.
- cdx: add a host-wide active-run guard to prevent concurrent wrapper mutation storms; secondary runs now skip auth/sync/update writes (and insecure-host auth purge), launch Codex with valid local auth, and support explicit override via `--allow-concurrent-sync`; wrapper bumped to `2026.02.13-14`.
- Admin dashboard: Fleet Skill registry now has a strict edit mode (existing entries open as `Edit skill`, slug is locked during edits to avoid accidental clone-via-rename, save action is labeled `Save changes`, and status feedback distinguishes no-op saves) plus explicit delete actions (`Delete` in table rows and a modal `Delete` button while editing).
- cdx: harden `--uninstall` for multi-user hosts; when additional registered host users exist and the wrapper cannot escalate (`root`/passwordless `sudo -n`), uninstall now fails fast instead of attempting partial cleanup; wrapper bumped to `2026.02.13-13`.
- cdx: honor `NO_COLOR` by disabling ANSI colors even on TTY output, and auto-enable a compact minimal output mode when `TERM=dumb` (suppresses MOTD and prints concise Core/Result summary); wrapper bumped to `2026.02.13-12`.
- cdx: expand Linux prerequisite auto-install package-manager detection to include `pacman`, `zypper`, and `apk` (in addition to `apt-get`/`dnf`), including package-name translation for `python3` on Arch-family hosts; wrapper bumped to `2026.02.13-11`.
- Admin dashboard: removed the Mission Pulse “Action needed” card, moved ChatGPT Account to the top of the dashboard flow ahead of the four KPI cards, and reformatted Ops Radar into a 3x2 desktop grid (with responsive collapse on smaller screens).
- cdx: add wrapper-only `cdx status` and `cdx doctor` commands (no Codex launch) with summary-only and extended diagnostics modes, plus actionable doctor hints and API `/versions` reachability probe; wrapper bumped to `2026.02.13-10`.
- cdx: add a shared embedded Python HTTP utility (`CODEX_PY_HTTP_UTIL`) and refactor auth/prompt/skill/AGENTS/config/usage sync snippets to reuse one force-IPv4 + TLS-context + JSON-request implementation, reducing duplicated network code and drift; wrapper bumped to `2026.02.13-09`.
- cdx: npm-based Codex updates now honor privilege context (`root` direct install, `sudo -n` when available, otherwise user install), aligning update behavior with uninstall handling on root-owned global npm prefixes; wrapper bumped to `2026.02.13-08`.
- cdx: portability hardening for mixed Linux/macOS hosts: replaced GNU-only `sort -V` comparisons with Python-backed version compare, switched ANSI stripping to runtime-detected `sed -r`/`-E`, and replaced direct `sha256sum` calls with a portable hash helper (`sha256sum`/`shasum -a 256`/`openssl`/`python3` fallback); wrapper bumped to `2026.02.13-07`.
- cdx: make local sync writes atomic for `auth.json`, `AGENTS.md`, `config.toml`, and prompt/skill baseline files (`.prompt-baseline.json`, `.skill-baseline.json`) using temp file + `fsync` + replace; wrapper bumped to `2026.02.13-06`.
- cdx: tighten PTY fallback retry guard so direct rerun only happens when the PTY launch failed *and* output matches known TTY-incompatible patterns; avoids accidental second runs on successful commands; wrapper bumped to `2026.02.13-05`.
- cdx: fix non-TTY command dispatch so explicit Codex subcommands are no longer rewritten as `exec ...` (prevents cases like `cdx exec ... | cat` becoming `codex exec exec ...`); wrapper bumped to `2026.02.13-04`.
- cdx: preserve interactive TTY behavior when PTY capture is disabled/fails (avoid `tee` pipe fallback that can trigger `stdout is not a terminal`), and auto-disable PTY capture on hosts where Codex reports TTY-incompatible PTY output (`~/.codex/.cdx_no_pty`, override with `CODEX_FORCE_PTY=1`).
- Admin dashboard: full 2026 visual overhaul for Overview (mission control hero, pulse score, ops radar, richer fleet/cost/runtime cards, and updated mobile layout).
- Admin new host modal: the “Run on the target host” copy button now shows inline feedback (`Copying…`, `Copied`, `Copy failed`).

# 2026-02-12
- Admin config: add `model_provider` and `local_provider` controls to the config.toml builder to match the current Codex CLI flags.
- cdx: refresh bootup summary styling (modern header + divider + wrapped rows) while keeping existing status content.

# 2026-02-11
- Config: add notice model migration defaults to map `gpt-5.2-codex` to `gpt-5.3-codex`.
- Config: add `[security] dangerously_bypass_approvals_and_sandbox` toggle (wired into `cdx` to add `--dangerously-bypass-approvals-and-sandbox` when enabled).

# 2026-02-09
- Fixed admin "Enable window" actions for insecure hosts (host enable/disable + approval approve/deny/allow-domain) returning HTTP 409 due to incorrect route parameter handling.

# 2026-02-06
- Admin config: default model switched to `gpt-5.3-codex` and model pickers now include `gpt-5.3`/`gpt-5.3-codex`.

# 2026-02-08
- Security: remove un-gated `public/admin/mtls-debug.php` endpoint that echoed request headers.
- Security: constrain outbound cURL redirects to HTTPS in pricing + ChatGPT usage fetchers.
- Maintenance: remove unused `src/Http/Router.php` (router isn’t used outside `public/index.php`).
- Admin UI: start visual refresh (new theme tokens for light/dark/auto, header polish, and a sectioned Config layout with search).
- Admin dashboard: add a Fleet Health header with quick actions (refresh, new host).
- Admin hosts: improve table scanability with clearer badges and grouped KPI rows.
- Admin hosts: host detail modal now highlights “Problems” at the top when something needs attention.

# 2026-02-02
- cdx: pick `script` flags per platform and only run PTY capture when stdin/stdout are TTYs (fixes macOS `script` errors).
- cdx: avoid `script -c` on macOS and guard wrapper restart args to prevent unbound variable crashes.
- cdx: avoid unbound `SCRIPT_SUPPORTS_C` by keeping script detection out of subshells.

# 2026-02-01
- cdx: macOS compatibility for installer + wrapper (apple-darwin assets, Homebrew auto-install for missing python3/curl/unzip, bash 3.2-safe wrapper).

# 2026-01-31
- Admin auth: rehash admin passwords on successful login when hashing params change.
- Admin auth: reject password-reset emails with suspicious header injection input.
- Admin dashboard: remove unused WebAuthn helper code paths.
- Admin config: replace `web_search_request` with `web_search` (live/cached/disabled), while keeping legacy mapping for existing configs.
- Admin config: render `web_search` at the top level (string enum) instead of under `[features]` to match current Codex config schema.

# 2026-01-30
- cdx: add `-4` flag to force IPv4 for all wrapper network calls (sync, usage, update/download).

# 2026-01-28
- Admin config: render `steer = true|false` under `[features]` in fleet config.toml.
- Config: bake a trusted-project stanza into per-host config.toml using the caller's username/home to suppress Codex trust warnings.

# 2026-01-26
- cdx: honor `force_ipv4` for Python-based sync/usage HTTPS calls so IPv4-only hosts don't stall on IPv6.
- Insecure hosts: allow long-running sessions to upload refreshed auth after the window closes (bounded by `INSECURE_SESSION_MAX_MINUTES`).
- Admin hosts: add a 🍪 badge for the host that last submitted the current auth.json.
- Admin config: add steer conversation toggle (default on) to render `steer = true` in fleet config.toml.
- Admin config: move the Steer conversation toggle into the Security & Features card.
- Admin dashboard: move the Estimated total trend control into a 📊 icon beside the currency label.
- Admin hosts: move the status pill into a Status column and swap the insecure toggle to an iPhone switch.
- Admin hosts: stop showing "Pruning soon" when host pruning is set to never.
- Admin hosts: show insecure enabled hosts as Can login/Outdated instead of Locked.
- Insecure domain auto-allow rules now auto-revoke once their window expires.
- Admin memories: add delete button alongside each memory row.
- Admin memories: reveal delete buttons on row hover or focus.

# 2026-01-25
- Admin hosts: allow per-host AGENTS.md version pinning in the host modal (default follows fleet setting).
- API: add per-host AGENTS.md override field and endpoint for host-specific pins.
- Admin agents: prompt for a replacement version when deleting AGENTS.md versions that are pinned by hosts.
- Admin agents: show how many hosts are pinned to each AGENTS.md version.
- Admin agents: replace “pin” wording with “default” in AGENTS.md editor copy.
- Admin host modal: swap Reverse DNS to an iPhone-style toggle and place it beside the Codex CLI version picker.
- Docs: emphasize admin login in install/usage guides and treat mTLS as an advanced topic.
- Admin hosts: hide the “Locked” health pill in the host table.
- Admin hosts: collapse host-table status chips to a single pill.
- Admin dashboard: center the summary cards and shorten the wrapper check timestamp text.
- Admin hosts: color the Outdated pill green when auth is current and orange when auth is stale.
- Admin hosts: fix host-tab active state contrast in dark mode.

# 2026-01-19
- Skills: added "Git Commit" skill manifest to the fleet registry.
- Skills: added "Checkmk Local Checks" skill manifest to the fleet registry.
- AGENTS.md: added versioned storage with pinned vs latest serving, plus delete controls in the admin editor and new admin endpoints.

# 2026-02-10
- Skills: added "SSH Login" skill manifest to the fleet registry.
- Admin new host modal: "Run on the target host" command box now follows theme toggle (light/dark/auto); cache-bumped dashboard.css.
- Admin UI: normalized settings, usage charts, and mobile cards to theme tokens so light/dark/auto stays consistent; cache-bumped dashboard.css/dashboard-mobile.css.

# 2026-01-18
- Admin dashboard: toast notifications now honor light/dark/auto theme colors; cache-bumped dashboard.css.
- Admin dashboard: 2026 polish pass (bullet meters + theme toggle w/ auto light/dark tokens + softer usage window sections + restored overpay note); cache-bumped dashboard.css/dashboard-mobile.css/dashboard.js.
- Admin dashboard: 2026 visual pass (calmer background, no outer mega-card, split Hosts/Version, consistent focus ring + typography); cache-bumped dashboard.css/dashboard-mobile.css/dashboard.js.
- Admin UI: switched admin pages to a ChatGPT-style dark theme.
- Admin dashboard: restyled the Estimated Total cost card for a cleaner plan/utilization layout.
- Admin dashboard: combined Hosts, Version, and Validation Service into one summary card.
- Admin header: show "Christian Reiss 🔐" in the header and make the lock icon the logout action.
- Admin settings: moved mTLS status to Settings → General and removed the header pill.
- Admin logs: fixed `#logs` deep link so only logs render (dashboard panel now stays hidden).
- Admin dashboard: merged input/output/cached tokens into a single summary box and removed the redundant total tokens card.
- Admin header: removed the Dashboard nav item; the Codex Coordinator logo now routes to the dashboard.
- Admin dashboard: unified visual overhaul (palette, typography balance, reimagined command bar, refreshed main dashboard layout, cards, tables, and modals); cache-bumped dashboard.css/dashboard-mobile.css.
- Admin header: display the logged-in user name next to mTLS status; cache-bumped admin-auth.js and dashboard.css.
- Admin users: show relative last login timestamps below the absolute date in the Users table; cache-bumped users.js and dashboard.css.
- Admin users/login: require password confirmation in reset and user password flows; cache-bumped admin-auth.js and users.js.
- Admin users: remove the add/edit user modal close button (use Cancel or backdrop instead).
- Admin users: hide the "Wipe users" button until at least one user exists.
- Admin users: switch the Active toggle in the user modal to the iPhone-style switch.
- Admin login: show password recovery panel under the login modal (no longer hidden behind the overlay); cache-bumped admin-auth.js and dashboard.css.
- Admin: add admin login, user management, roles, and password recovery (userless bootstrap when no admins exist).
- Admin: insecure approval modal now uses the current insecure window duration when enabling hosts.
- Admin dashboard: insecure hosts modal live-updates via websocket events and refreshes countdowns while open.
- Installer: stop auto-running `cdx` after curl | bash; users run it manually when ready.
- Admin UI: refined the dark palette to better match ChatGPT's dark theme (neutral backgrounds, subdued surfaces).
- Admin UI: reverted palette to the original colors while keeping the new layout.
- Admin dashboard: removed the "over/under plan" copy so Estimated Total is a straight plan comparison.
- Admin header: moved the logged-in name to the far-right slot in the menu bar.
- Admin dashboard: centered the Estimated Total amount in the cost card.
- Admin dashboard: shortened the Validation line in the summary card to a compact status/timestamp.

# 2026-01-15
- Admin dashboard: fallback to SVG rendering when uPlot fails so history charts still load.
- cdx wrapper: surface reverse DNS denial reason in auth sync output; wrapper bumped to 2026.01.15-01.
- Auth: add reverse DNS enforcement for `/auth` (global setting with per-host overrides); requests now require forward A/AAAA + PTR match when enabled.
- Admin dashboard: add Reverse DNS Enforcement toggle + per-host override selector; cache-bumped dashboard.js v=2026-01-15-01.
- Installer: Unknown / not found in code (current installer prints manual next-step `cdx` commands and does not auto-run `cdx`; superseded by 2026-01-18 installer behavior).
- Auth: add trailing insecure-host grace window for final auth/usage pushes after the window expires (configurable via `INSECURE_GRACE_MINUTES`, default 60); explicit disable clears grace.
- Admin dashboard: refine uPlot usage + cost charts with consistent tick splits and hide the default legend; cache-bumped dashboard.js v=2026-01-15-03 and dashboard-mobile.css v=2026-01-15-01.
- Hosts: rename stored IP columns to `ip4`/`ip6` (auto-migrated from legacy `ip`/`ip_alt`), and surface the new fields in admin API/UI.

# 2026-01-14
- Auth: allow secure dual-stack hosts to bind one IPv4 + one IPv6 without enabling roaming; admin UI now shows the secondary IP when present.
- Admin insecure approvals: allow domain auto-allow rules (modal action + toggler revoke) so matching subdomains can auto-open insecure windows.
- Admin dashboard: remove the ChatGPT Account refresh button (websocket/live refresh remains).
- Admin insecure approvals: clicking outside the approval modal or pressing Esc now cancels the request to avoid stuck pending approvals.

# 2026-01-13
- Admin dashboard: remove per-host Codex version row from the host detail modal (fleet always uses the latest wrapper).
- Admin dashboard: ChatGPT 5‑hour/weekly reset timers now tick locally between refreshes, keeping “Resets in …” and time meters live.
- Insecure hosts: optional admin approval gate (Settings → General) that prompts via websocket, exposes approve/deny endpoints, and lets cdx wait/poll for approval when the window is closed.
- cdx wrapper: wait/poll for insecure host approvals when enabled; wrapper bumped to 2026.01.13-02.
- Admin dashboard: filter “CDX refused” toasts to known hosts/fqdns to avoid noise from unknown keys.
- Admin dashboard: emit “CDX refused” toasts for denied `/auth` requests tied to known hosts (disabled host, IP mismatch, installation mismatch, insecure window closed).
- Admin dashboard: “CDX authorized” toasts now include relative time in the message.
- Admin dashboard: emit “CDX authorized” toasts on successful `/auth` retrieve (websocket test hook).
- Admin dashboard: add websocket-driven toast framework (auto-dismiss + manual close), new `/admin/toasts` endpoint, cache-bumped dashboard.js v=2026-01-13-03 and dashboard.css updated.
- Admin dashboard: Overview info cards live-update via websocket events (hosts, versions, tokens, cost, runner, ChatGPT); cache-bumped dashboard.js v=2026-01-13-02.
- Admin dashboard: ChatGPT 5-hour/weekly usage boxes live-update via websocket events; cache-bumped dashboard.js v=2026-01-13-01.
- Admin: add optional websocket event stream for live dashboard updates (`admin_events` table, `/admin/ws/info` bootstrap, `scripts/admin-ws.php`, admin-ws.js hook).
- Admin dashboard: remove hover lift on header nav buttons (menu bar, Toggler, New host); cache-bumped dashboard.css v=2026-01-13-03.
- Admin dashboard: remove button glow across all hover states; cache-bumped dashboard.css v=2026-01-13-02.
- cdx wrapper: disable prompt-toolkit cursor position reports under PTY capture unless the env is already set, avoiding interactive cursor errors on some terminals; wrapper bumped to 2026.01.13-01.
- cdx wrapper: compress the Result line on clean insecure-host runs to reduce repeated noise; wrapper bumped to 2026.01.13-03.
- Ops: add docker-compose `admin-ws` service and document enabling `ADMIN_WS_ENABLED` for live admin toasts/websocket updates.

# 2026-01-12
- cdx wrapper: enforce baked FQDN at runtime (override with `CODEX_ALLOW_FQDN_MISMATCH=1`), bumped wrapper to 2026.01.12-01.
- Admin hosts: add “Disable all” in Insecure hosts modal and hide bulk actions unless ≥2 active insecure hosts; cache-bumped dashboard.js v=2026-01-12-02.
- Admin hosts: fix the Insecure hosts “Extend all” button (binds reliably, shows how many hosts were extended) and cache-bump dashboard.js v=2026-01-12-01.
- Config builder: clamp verbosity to “medium” for gpt-5.1-codex-max (UI and server), avoiding unsupported text.verbosity values.
- Auth: insecure hosts now rebind their stored IP to the current client when the insecure window (or grace) is active, eliminating “IP bound” failures after toggling; logs emit `auth.insecure_ip_override`.

# 2026-01-08
- Admin dashboard: cost total stays neutral when API spend is below plan, and the overpay callout is shortened to "Overpaying by X%!"; cache-bumped dashboard.js v=2026-01-08-04.
- Admin dashboard: cost over‑plan callout uses neutral styling and explains the API-vs-plan mismatch; cache-bumped dashboard.js v=2026-01-08-03.
- Admin hosts: remove avg/last refresh subline from the Hosts header; cache-bumped dashboard.js v=2026-01-08-02.
- Admin auth: add a one-time seed command (curl | bash) that uploads local `~/.codex/auth.json` via `/seed/auth/{uuid}`; tokens expire after `AUTH_SEED_TOKEN_TTL_SECONDS` (default 900s) and invalidate on first POST; new `auth_seed_tokens` table + admin UI wiring; cache-bumped dashboard.js v=2026-01-08-01.

# 2026-01-07
- Admin hosts: insecure window duration now supports a log-ish 0–8h (0–480 min) range for enable actions; API clamping updated; cache-bumped dashboard.js v=2026-01-07-01.

# 2025-12-25
- Admin config builder: added background terminal experimental feature toggle; cache-bumped config.js v=2025-12-25-03.
- Admin hosts: pruning indicator now honors Settings → General inactivity window (0 disables) instead of hard-coded 30 days; cache-bumped dashboard.js v=2025-12-25-02.
- Admin config builder: added switches for Codex 0.77 experimental feature flags (unified exec, RMCP OAuth, sandbox assessment, ghost commit, Windows sandbox); cache-bumped config.js v=2025-12-25-01.

# 2025-12-19
- Admin config builder/profiles/host overrides: add `gpt-5.2-codex` as a selectable model with low/medium/high/xhigh reasoning; server now forces reasoning summaries to `detailed` for that series just like other codex-specific models.
- cdx wrapper: detect Codex versions that lack `--reasoning-effort`, skip passing the flag, and emit a warning instead of failing the launch; wrapper bumped to 2025.12.19-01.

# 2025-12-18
- cdx wrapper: remove the duplicate insecure-host bootstrap warning and collapse the insecure-host result summary to "Codex to brrrr (insecure host)"; wrapper bumped to 2025.12.18-06.
- cdx wrapper: preserve argv across wrapper self-update restart so `cdx resume` (and other non-flag first args) survive the re-exec; wrapper bumped to 2025.12.18-05.
- Installer: choose the musl (static) Codex release asset on older glibc (<2.39) so CentOS 7 / Debian 11-class hosts don’t require `libssl.so.3`.
- Admin hosts/installer: “Allow insecure curl (-k)” now persists as a per-host `curl_insecure` flag and bakes `CODEX_SYNC_ALLOW_INSECURE=1` into the `cdx` wrapper (disables TLS verification for sync when you intentionally run self-signed); installer still bakes `CODEX_INSTALL_CURL_INSECURE=1` into the piped `bash` so wrapper + Codex downloads reuse `curl -k`; cache-bumped dashboard.js v=2025-12-18-02.
- Installer: use `cdx --wrapper-version` during install so it doesn’t run a full sync/codex launch (avoids surprising SSL failures during bootstrap).
- cdx wrapper: guard the Usage summary `token_bits` join so runs under `set -u` don’t crash with `token_bits[@]` unbound (affects hosts before the first token usage sync), fix baked-placeholder sentinels so per-host overrides (`model_override`, `reasoning_effort_override`, `force_ipv4`, `secure`, `installation_id`, `cdx_silent`) don’t get reset after baking, and allow wrapper self-update to pass `curl -k` when `CODEX_SYNC_ALLOW_INSECURE=1`; wrapper bumped to 2025.12.18-04.

# 2025-12-17
- Admin settings: Skill modal now shows validation/saving status inline, so slug/manifest errors are visible instead of hiding underneath the Fleet Skill registry panel.
- Admin settings: Fix the Fleet Skill registry “New” button so it always opens the modal and surfaces an error when the manifest input is missing instead of silently doing nothing.
- Admin settings: Fleet Skill registry now lives under Settings → Skills (tab after Profiles); the standalone `#skills` hash redirects to `#settings/skills`, and dashboard.js is cache-bumped to v=2025-12-17-04.
- Skill system: new `/skills` endpoints + `skills` table mirror slash-command behaviors (list/retrieve/store/delete) with `SkillService`, admin dashboard gets a Skills tab + modal editor, `cdx` syncs `~/.codex/skills` (pull + push) with offline-safe baselines, docs/README updated, and wrapper bumped to 2025.12.17-01.

# 2025-12-15
- Config builder: clamp `model_reasoning_summary` to `detailed` for `gpt-5.1-codex*` (OpenAI only accepts `reasoning.summary=detailed`); cache-bumped config.js v=2025-12-15-20.
- Admin hosts: added “Temporary host” provisioning (`POST /admin/hosts/register` body `temporary=true`) with a sliding 2-hour idle expiry (pruned 2h after the last successful host contact), backed by `hosts.expires_at` and `host.pruned` reason `expired`; cache-bumped dashboard.js v=2025-12-15-20.
- cdx wrapper: fixed token-usage parsing crashing on Python 3.9 (AlmaLinux 9) due to Python 3.10-only type hints (`str | None`); wrapper bumped to 2025.12.15-03.
- cdx wrapper: fixed `cdx --uninstall` failing (cmd_uninstall was invoked before the wrapper had defined its helpers); wrapper bumped to 2025.12.15-02.
- Installer: fixed insecure host registration emitting install tokens without an API key (which could 500 on `curl .../install/<token> | bash`).
- cdx wrapper: suppress duplicate boot summary/compat lines when the wrapper self-updates and re-execs (you now only get one header); wrapper bumped to 2025.12.15-01.

# 2025-12-14
- Admin settings/memories: wired the delete action to the numeric memory `record_id` (UI buttons now work, show host/key metadata, and disable when missing), documented the admin delete endpoint/field, and cache-bumped dashboard.js v=2025-12-14-13 + dashboard.css v=2025-12-14-11.
- Admin settings/memories: fixed the Memories tab not rendering (bad JS wiring + missing DOM ref). Loader now targets the Settings → Memories panel, wires `memoriesTableWrap`, and host filter passes `host_id`; cache bump to dashboard.js v=2025-12-14-12.
- Admin settings: fixed Settings → config.toml (and other settings tabs) sticking around when navigating back to the dashboard (HTML nesting bug: Settings panel-set was closed early).
- Admin settings/profiles: profile rows are now collapsed by default (click to expand) and the per-profile feature toggles render in a 2×2 grid; cache bump to dashboard.css/profiles.js v=2025-12-14-10.
- Admin dashboard: Validation Service card now shows the host that last wrote the current canonical auth.json (source FQDN + stored time); cache bump to dashboard.js v=2025-12-14-07.
- cdx wrapper: boot summary now shows MCP status, shortens Runner to icon-only, and moves the week-partition indicator from Core → Quota day; wrapper bumped to 2025.12.14-03.
- Admin settings/hosts: Codex Version selectors now omit GitHub prereleases (alpha/beta) and only list full releases, while still including the currently targeted/pinned/in-use version for visibility; cache bump to dashboard.js v=2025-12-14-04.
- Admin hosts: removed all row background coloring in the Authorized Hosts table (rows are now transparent; no secure/insecure/unprovisioned shading); cache bump to dashboard.css/dashboard-mobile.css v=2025-12-14-08.
- Profiles: added a Settings → Profiles tab to add/edit/delete `config.toml` profiles (model, reasoning effort, approval policy, sandbox mode, plus stream/search/image/network toggles). Config builder no longer embeds profile editing; per-profile TOML now includes nested `[profiles.<name>.features]` + `[profiles.<name>.sandbox_workspace_write]`. `cdx <profile>` is now shorthand for `--profile <profile>` when the profile exists; removed the old `cdx shell`/`cdx code` model presets; wrapper bumped to 2025.12.14-03; cache bump to dashboard.js/config.js/profiles.js v=2025-12-14-06.

# 2025-12-13
- Admin hosts: added per-host Codex CLI version override (“Global” or pinned semver) that overrides the fleet policy; pinned hosts get `client_version_source=locked` so `cdx` enforces the exact version; cache bump to dashboard.js v=2025-12-13-09.
- Admin settings: added a Codex version selector (Latest/recent releases) that can pin the fleet to a specific Codex release; when pinned (`client_version_source=locked`) the `cdx` wrapper enforces the exact target version (upgrade or downgrade); wrapper bumped to 2025.12.13-02; cache bump to dashboard.js v=2025-12-13-08.
- Config builder: fixed `config.toml` generator settings “disappearing” when `client_config_documents` had non-canonical/legacy rows (prefer `id=1` when present, tolerate double-encoded JSON settings).
- Admin hosts: when a host is flagged “Outdated auth”, the “Can login” chip is now suppressed (no more contradictory status); cache bump to dashboard.js v=2025-12-13-04.
- Admin access: fixed `requireAdminAccess()` enforcing `ADMIN_ACCESS_MODE=mtls` (removed stale `mtls_only` check) so `/admin/*` is denied when mTLS headers are missing.
- Admin hosts: hosts table row backgrounds now use a single neutral zebra stripe (removed status-based row gradients); cache bump to dashboard.js v=2025-12-13-03.
- Config sync: `/config/retrieve` now applies per-host `model_override` + `reasoning_effort_override` to the baked `config.toml` (`model`, `model_reasoning_effort`) so `~/.codex/config.toml` matches the host’s effective defaults.
- Admin hosts: model/reasoning overrides now auto-save on select (no Save button) and are baked into the per-host `cdx` wrapper download; wrapper bumped to 2025.12.13-01; cache bump to dashboard.js v=2025-12-13-02.
- Admin hosts: fixed `/admin/#hosts` deep link scrolling the Authorized Hosts table to the top (hiding the All/Secure/Insecure tabs); cache bump to dashboard.css/dashboard.js v=2025-12-13-01.
- Admin insecure-hosts “Toggler” modal: fixed enabled hosts showing “Online: expired” by returning timezone-aware `insecure_enabled_until` timestamps from `/admin/hosts/insecure`.
- Admin settings: fixed Canonical AGENTS.md panel leaking onto the Dashboard after navigating away from Settings → Agents (HTML nesting bug).

# 2025-12-12
- Admin dashboard: Estimated Total now auto-selects Plus/Pro from the ChatGPT usage stats; removed the manual plan toggle buttons; savings badge is now inline (“X% Saved!”).
- Admin hosts: fixed the Insecure Hosts “Toggler” enable button requiring two clicks by using the server-provided active flag for toggle state.
- Ops/debug: `public/mtls-debug.php` now returns 404 unless `CODEX_DEBUG=1`.
- Auth runner: probe now uses `-s read-only` and no longer bypasses approvals/sandbox.
- Repo: filled GPLv3 appendix placeholders in `LICENSE` with 2025 + Christian Reiss.
- Admin settings: configurable inactive-host pruning window (0–60 days) now overrides `INACTIVITY_WINDOW_DAYS`.
- Admin logs: Client Reports cost column now rounds to 2 decimals; cache bump to logs.js v=2025-12-12-04.
- Admin hosts: VIP indicator is now a plain 👑 (no badge/pill) in the Authorized Hosts list and host detail modal; cache bump to v=2025-12-12-03.
- Admin dashboard: added Plus/Pro plan pricing (`CHATGPT_PLUS_PLAN_COST`, `CHATGPT_PRO_PLAN_COST`) and color-coded monthly “Estimated Total” vs plan with a “% saved this month” badge.
- Admin access: removed `ADMIN_REQUIRE_MTLS`/`DASHBOARD_ADMIN_KEY` and standardized on `ADMIN_ACCESS_MODE=mtls|none`.
- Admin access: accept colon/dash formatted mTLS fingerprints from proxies (normalize to hex before validating).
- Admin config builder: fixed “Save & Deploy” HTTP 422 sha mismatch when saving immediately after edits (stale preview SHA); the save flow now uses the *saved* sha for optimistic concurrency (instead of the preview hash), and admin assets are cache-busted so browsers actually pick up the fix.
- Admin insecure-hosts “Toggler” modal now shows remaining online time under enabled host FQDNs.
- Removed admin passkey/WebAuthn system: deleted passkey endpoints, DB table, dashboard UI, and related dependencies. Admin access is now enforced via mTLS only (`ADMIN_ACCESS_MODE=mtls`).
- Config builder UI now shows the actual save error (HTTP status + validation details) instead of only “Save failed”.
- Admin config builder: hide `codex-coordinator` from the “Configured MCP servers” list so only operator-added MCP servers are shown (managed entries remain injected per-host).
- cdx wrapper: when `[otel]` is present in `config.toml`, export `OTEL_*` env vars before launching `codex` so traces can be shipped via OTLP without per-host glue.
- Admin Agents: AGENTS.md now always renders the full file contents, and the Edit button opens a working editor modal (previously the modal markup was missing).
- Admin Agents: replaced the modal editor with inline click-to-edit and a dedicated Save button on `#settings/agents`.
- Admin hosts: add per-host `cdx` model + reasoning-effort overrides (defaults to the fleet-wide config when unset).

# 2025-12-10
- Passkey enrollment/auth now accepts base64url (no more "invalid character" errors) and tolerates http/https origins for the resolved host; client `id` serialization aligns with rawId.

# 2025-12-08
- Settings consolidated into a single tabbed page (Settings/Agents/Slash commands/Memories/config) via embedded subpages; header menu now links directly to Settings. Cache bump to dashboard.css v=2025-12-08-22.
- Settings tabs now inline real content (Agents/Prompts/Memories) instead of iframes; config builder still uses config.js but lives in-page. Header menu still flat. Cache bump to dashboard.css v=2025-12-08-29.
- Added hero/info boxes to Hosts and Settings to match Logs (title + subtitle, no extra controls).
- Settings tabs wired with embed-aware nav (nav.js cache bump to v=2025-12-08-06) so each tab loads its page without showing nested headers.
- Dashboard hero/info box removed; tightened spacing between nav, menu, cards, quota section, hosts and logs bottom padding; cache bump to dashboard.css v=2025-12-08-21.
- Logs dropdown removed (plain link), added on-page tabs for Client vs MCP logs, and cache bumped to dashboard.css v=2025-12-08-17.
- Hosts UI merged into a single page with on-page tabs (All/Secure/Insecure/Unprovisioned), hosts menu entry is now a simple link (no dropdown), and assets cache-bumped to v=2025-12-08-16 / dashboard.js v=2025-12-08-06.
- Header nav simplified to plain text (no pills, no hover fill, no underline), dropdown kept minimal, and lower menu hidden; cache bump to v=2025-12-08-15.
- Admin nav underline forced neutral (no shadows/gradients) and cache bumped to v=2025-12-08-13 to squash lingering green glow on Hosts/Logs/Settings dropdown triggers.
- Admin nav dropdown triggers stripped to plain text (appearance reset, no background image/shadow/filter) with another cache bump to purge lingering green glow on Hosts/Logs/Settings.
- Admin nav pill styles fully removed (no hover background/green glow); dropdown links now sit above content and use underline-only active state.
- Admin nav bar restyled to a flat, square, underline-only look (no neon pills/shadows), with neutral dropdowns and a fresh CSS cache buster so the new styles load immediately.
- Admin nav bar flattened to plain text links with square hover dropdowns (no gradients/shadows, dropdowns sit flush under the trigger) so Hosts/Logs/Settings stop looking like glowing bubbles.
- Added dedicated admin pages for Hosts, Memories, Settings (alongside existing Agents/Prompts/Logs) so every menu item opens a real subpage instead of query-driven views.
- Dashboard cost cards moved out of the ChatGPT section: input/output/cached token totals and estimated total USD now show as top-level info boxes alongside Hosts/Versions/Tokens (with cost trend button).
- Admin dashboard hero is back (Dashboard · Fleet overview) with a square, flush menu bar (`Overview/Hosts/Logs/Agents/Slash commands/Memories/Settings`) wired to the existing `?view=` routes; active highlighting now covers the new tabs.
- Admin dashboard: split AGENTS.md and Slash Commands into dedicated pages (`/admin/agents.html` and `/admin/prompts.html`) instead of embedding them on the dashboard/hosts views; navigation links now point to the standalone editors.
- cdx quota summary now lists 5h, day, and week in that order (aligning with the daily allowance view) and bumps wrapper to 2025.12.08-01.

# 2025-12-07
- Added Quota Policy week partition (Off/7d/5d) that splits the weekly ChatGPT window into a daily allowance; `/admin/quota-mode` + `/auth` now carry `quota_week_partition`, dashboard gets a selector, and `cdx` shows a third quota bar that obeys warn/deny policy.
- Admin MCP access log table now shows UTC timestamps as `dd.mm.yyyy, hh:mm:ss`, resolves host IDs to FQDNs, and opens a detail modal when you click a row so you can inspect request/error context without squinting at the list view.
- Admin config builder: fixed change detection so settings-only updates (e.g., toggling managed MCP injection) persist even when the rendered TOML hash stays the same; the UI now sends the rendered sha256 on save, keeps the blank reasoning-summary option truly blank, and hides the managed `cdx` MCP entry just like other reserved servers.
- MCP streamable HTTP now advertises underscore tool names (`memory_store|memory_retrieve|memory_search`) that satisfy the MCP/OpenAI tool regex (`^[a-zA-Z0-9_-]+$`); dot aliases remain accepted for calls, and coverage was added to guard the naming rules.
- MCP resource browsing/templates added: `/mcp` now implements `resources/templates/list`, `resources/list`, and `resources/read` for host memories (`memory://{id}` URIs, text/plain), so MCP clients can enumerate or fetch stored notes.
- MCP `memory_store` now accepts a bare string payload in MCP `tools/call` (`arguments: "note text"`), wrapping it as `content` for convenience; still validates full object bodies.
- MCP `memory_search` also accepts a bare string payload and maps it to `query`, so `arguments: "foo"` works alongside the object form.
- Added MCP method aliases `list_tools`/`call_tool` (and dot variants) plus capability flags (`tools.list`/`tools.call`) so clients using either naming scheme are supported.
- Added MCP aliases for resource templates: `list_resource_templates` and `resources.templates.list` now map to `resources/templates/list`.
- Added MCP resource creation (`resources/create`, aliases `resources.create` and `create_resource`) that writes `memory://{id}` URIs to the memory store from text content.
- Added MCP aliases for resource listing: `list_resources` and `resources.list` now map to `resources/list`.
- Added MCP aliases for resource reading: `read_resource` and `resources.read` now map to `resources/read`.
- Added MCP resource update (`resources/update`, aliases `resources.update` and `update_resource`) to overwrite a `memory://{id}` with new text content.
- Added MCP resource delete (`resources/delete`, aliases `resources.delete` and `delete_resource`) which overwrites the memory with empty content to mark deletion; true DB delete can follow later if desired.
- Added MCP tool `fs_read_file` (alias `fs.read_file`) to read text files rooted at the app directory; includes path normalization and outside-root guard.
- Added MCP tool `fs_write_file` (alias `fs.write_file`) to write text files under the app root with create/overwrite flags and path escape protections.
- Added MCP tool `fs_list_dir` (alias `fs.list_dir`) to list directory entries under the app root with optional glob filtering.
- Added MCP tools `fs_file_exists` / `fs_stat` (aliases `fs.file_exists`, `fs.stat`) to check existence and stat paths under the app root with size/mtime/type metadata.
- Added MCP tool `fs_search_in_files` (alias `fs.search_in_files`) to find string matches under a root with optional glob filters and capped results.
- Added MCP memory tools `memory_append` / `memory_query` / `memory_list` (dot aliases supported) for scoped note storage, querying, and listing with per-resource tagging.
- MCP memory tool responses are now returned as MCP `content` blocks (text payload) to satisfy clients expecting CallToolResult.content.
- Added MCP resource tools (`resource_read|create|update|delete|list`, dot aliases) that wrap the resource endpoints and return MCP content blocks.
- `fs_search_in_files` now matches glob filters against filenames and relative paths (e.g., `src/Database.php`).
- MCP reasoning summary now normalizes per model: `gpt-5.1-codex-max` is forced to `detailed`; other models accept `auto|concise|detailed`; invalid/`none` values are stripped.

# 2025-12-06
- Fixed the admin config builder to only emit valid `reasoning.summary` values (`auto|concise|detailed`), drop legacy `none`, and normalize previously stored configs so OpenAI no longer rejects uploads.
- Repaired `ClientConfigService::retrieve` (broken PHP parse, restored baked/base SHA logic + cache) and added coverage for reasoning summary normalization.
- Removed the Model Providers section (we only ship ChatGPT/OpenAI), so builder no longer accepts provider blocks and server drops `model_providers` entries when rendering config.toml.
- Defaults box now only asks for Model + Reasoning Effort + Reasoning Summary; default profile and model provider inputs were removed since we always target ChatGPT.
- Notices are now always hidden (gpt5 migration + rate-limit nags), with the toggles removed from the builder UI.
- Feature toggles now have human-readable labels while keeping their underlying config keys intact.
- Dropped the OTEL environment input from the MCP/Telemetry card; OTEL environment now defaults to blank.
- Managed MCP now uses native HTTP (no npm): baked config injects `[mcp_servers.cdx] url="{base}/mcp" http_headers = { Authorization = "Bearer {host_api_key}" }`, replacing the broken `npx codex-orchestrator-mcp` shim.
- `/config/retrieve` now bakes `config.toml` per host using that host’s API key for the managed MCP entry, returns both `baked sha256` and `base_sha256`, and only ships content when the baked hash changes (host API key rotation forces a refresh); docs/tests updated.
- Added a dedicated admin config builder page (`/admin/config.html`) that captures every known `config.toml` knob (model/provider/profile, approval policy, sandbox, features/notices, shell env policy, model providers/profiles, MCP servers, OTEL, custom blocks) with live server-side rendering + SHA/size preview and one-click deploy to hosts.
- Added an iPhone-style toggle in the config builder to prefill a managed `codex-memory` MCP server pointing at this coordinator (npx command + API base); hosts get it baked automatically unless disabled, with per-host API key injected at config sync time (no key stored server-side).
- Added canonical `config.toml` storage (`client_config_documents` table) with `/config/retrieve` for hosts and `/admin/config` + `/admin/config/render|store` for admins; docs (API/DB/cdx/overview/README) updated accordingly.
- `cdx` now syncs `~/.codex/config.toml` from the server (warns on offline/missing-config, deletes local files when the server reports `missing`); wrapper bumped to 2025.12.06-01.
- Covered the new ClientConfigService with unit tests.
- Rebranded the admin dashboard and logs page titles to “Codex-Coordinator” instead of “Codex-Auth” so the UI matches the product name.
- Added MCP-compatible memory storage for Codex: `/mcp/memories/store|retrieve|search` reuse host API keys, persist notes in MySQL with full-text search over content/tags, and support tagged filtering so Codex MCP clients can sync memories across sessions.
- Added an Admin dashboard Memories panel (filter by host/tags/query, limit results) to browse stored MCP memories without shell access.
- Documented the new memory API (API/DB/cdx source-of-truth docs, README) and covered MemoryService with unit tests.

# 2025-12-05
- Rebuilt the Quota Policy card into an Operations & Settings panel that now hosts the quota toggle, API kill switch, runner trigger, seed auth.json action, and version check instead of scattering those controls across the header; the entire panel is collapsible (hidden by default) to keep the dashboard compact.
- Moved the insecure-host enable window slider into the same Operations & Settings panel, persist the selection locally (2–60 minutes), and pass it along whenever an insecure host is re-enabled.
- Expanded the AGENTS.md editor modal with a wider layout and taller textarea so editing lengthy instructions isn’t cramped.
- Removed the AGENTS.md SHA display from the dashboard meta line to keep that info box focused on update time and size.
- Added a quota limit slider under Quota Policy (50–100%, default 100%) so admins can warn or hard-stop Codex runs before hitting 100% usage; `/admin/quota-mode` now persists both `hard_fail` and `limit_percent`, `/auth` responses include `quota_limit_percent`, and the logs page no longer shows the orphaned API toggle.
- Updated `cdx`/wrapper summary and quota logic to honor the new `quota_limit_percent` threshold (and new env override `CODEX_QUOTA_LIMIT_PERCENT`), raising warnings or blocking launches once the configured percent is used.
- Hosts can now be marked VIP via the dashboard or `/admin/hosts/{id}/vip`; VIP hosts always run in warn-only mode regardless of the global quota setting, carry a “VIP” chip in the UI, and the flag is included in `/auth` responses + docs.
- Fixed the wrapper’s quota summary logic so it no longer uses `local` outside a function (`bin/cdx`/`storage/wrapper/cdx`), preventing the `/usr/local/bin/cdx: line 3629: local: can only be used in a function` error when running on insecure hosts.
- Admins can now pick a 2–60 minute insecure-host window via the dashboard slider; `/admin/hosts/{id}/insecure/enable` accepts `duration_minutes`, the server persists `insecure_window_minutes`, `/auth` extends windows by that duration (default 10), and docs/UI/CHANGELOG were updated accordingly.
- Added canonical AGENTS.md storage on the server with `/agents/retrieve` for hosts and `/admin/agents` (+ dashboard modal) for admins; hosts replace `~/.codex/AGENTS.md` on every sync and delete stale copies when the server copy is cleared.
- Dashboard now shows an AGENTS.md panel with inline preview + edit modal so project instructions can be updated without shell access.
- cdx pulls AGENTS.md alongside slash commands (python required), handles offline/missing-config gracefully, and surfaces sync status in the boot summary; wrapper bumped to 2025.12.05-01.
- Updated source-of-truth docs (API/DB/cdx) and README to reflect server-managed AGENTS.md instead of the old manual sync script.

# 2025-12-04
- Reformatted ChatGPT quota reset labels to read naturally (e.g., “Resets in 5 days (Tuesday)” and richer sub-48h phrasing) instead of the old “5d 13h 54m to reset” timer text.
- Added `scripts/sync-agents.php` to sync the repo’s `AGENTS.md` into `~/.codex/AGENTS.md` (honors `CODEX_HOME`) so Codex always picks up the latest project instructions with a single command.
- Rebuilt the ChatGPT Estimated Total cost modal with hoverable tooltips, a detailed per-day panel, and a scrolling day-by-day table so you can see exact dates and values instead of guessing from the old coarse chart.
- Added a Slash Commands “New Command” button that opens the creation modal empty, so fresh prompts can be authored without editing an existing entry first.

# 2025-12-02
- Applied the grok.com neon black theme across the admin dashboard + Client Logs views (desktop + mobile) so both screens match the new Grok-branded look-and-feel.
- Rebuilt the Grok theme using the `/root/grok.html` charcoal + teal palette so every dashboard/logs surface (backgrounds, nav, cards, chips, logs, toggles, mobile) now matches grok.com with zero neon gradients left.
- Iterated on the admin styling twice: first with a charcoal/blue corporate pass, then all the way to a light, airy OpenAI-inspired look (white cards, soft shadows, subtle accents) and restored the OpenAI logo in both dashboard + logs headers, keeping desktop/mobile in sync.
- Reshaped the ChatGPT usage summary so the Input/Output/Cached cards mirror the Estimated Total box and now show Today/Week/Month token counts (no more per-card cost rows or USD heading).
- Estimated Total now reports actual ChatGPT costs (using pricing_day/week/month_cost + currency) with Today/Week/Month cost chips instead of duplicating token counts.
- Simplified the Authorized Hosts table headers so the sort controls look like standard clickable text (no chunky buttons) for easier scanning.
- Converted the Authorized Hosts column sorters to plain text links (with keyboard support) so the remaining “button bubble” chrome is gone across browsers.
- Updated table hover highlights to a light orange accent so row selection/hover states match the airy theme instead of the previous dark blue wash.
- Restyled the Authorized Hosts table to stick with the green accent palette (header gradient + green row fills/hover states) so the list feels cohesive with the rest of the admin look.
- Swapped all button hover states (nav + standard + “ghost” controls such as Logs/Seed/New Host) to the green accent gradient so the old blue dip is gone.
- Tweaked the cdx CLI (bin + seeded wrapper) so insecure hosts treat expected auth refreshes as normal: no more “updating auth / auth outdated” noise in the command/result/auth rows, and the auth status tone stays green unless there’s a real problem.
- cdx shell/code launchers: Unknown / not found in code (current wrapper does not implement `cdx shell` or `cdx code`; superseded by later profile shorthand + `--execute` flows).
- Boot summary rows are now deduplicated, sorted, and easier to read while keeping the quota bars untouched.
- Fixed `cdx --execute` so `--skip-git-repo-check` is passed after `exec`, matching Codex CLI expectations.
- Fixed cdx runner telemetry so the status line reflects the fresh verification time immediately after the runner is triggered.
- cdx now shows “auth runner just verified” when the runner completed within ~90 seconds, replacing “<1m ago”; wrapper version bumped to 2025.12.02-01.
- Admin dashboard adds a “Quick: Insecure hosts” menu action (only visible when insecure hosts exist) that opens a scrollable modal listing insecure hosts (FQDN + enable/disable) with active windows pinned to the top.
- Added `GET /admin/hosts/insecure` for a minimal insecure-hosts list suitable for quick UI actions.

# 2025-12-01
- Estimated Total card no longer repeats the month-to-date total in its header, relying on the breakdown chips below.
- cdx now treats `/auth` HTTP 5xx/network outages as offline, keeping cached auth usable and surfacing the offline reason instead of hard failures.
- Slash command sync reports API outages/HTTP 5xx as offline (warn) and the wrapper version is bumped to 2025.12.01-03.
- Token usage ingests now compute and persist per-entry/aggregate costs from configured pricing (with backfill for existing rows) and expose a Cost column + currency on the Client Logs page.
- Auth runner preflight now runs every ~8 hours (first non-admin request per window) instead of once per UTC day, still refreshing the cached GitHub client version; interval configurable via `AUTH_RUNNER_PREFLIGHT_SECONDS` (default 28800s).
- Restyled the ChatGPT month-to-date cost cards with balanced tokens/cost lines and a dedicated total header, replacing the squished four-box layout.
- Estimated Total graph now opens a dedicated 60-day cost trend (input/output/cached) instead of reusing the quota chart placeholder.
- Added a stats icon to the ChatGPT estimated total card to mirror the weekly limit affordance.
- ChatGPT estimated total icon now opens the quota trend chart, matching the weekly limit graph control.
- Authorized Hosts table headers are now clickable to sort (toggle ascending/descending) by host, last seen, client, wrapper, or IP.
- Refreshed the ChatGPT estimated total card with a highlighted primary figure and chips for Today/Week/Month breakdown.
- Admin overview now includes daily token/cost totals for the dashboard, and the ChatGPT cost card shows Today/Week/Month estimates without the previous “includes” blurb.
- Added bash 4.2-safe guard for wrapper release tag selection to prevent `candidate_tags[@]` nounset errors during Codex refresh, and bumped wrapper version to 2025.12.01-02.
- Installer now selects the extracted Codex binary (skipping the tarball) and tolerates empty user lists on bash 4.2 by guarding array expansion in cdx, preventing nounset crashes during install/version checks.
- Fixed installer curl invocation to avoid `curl_flags[@]` unbound variable errors on older bash releases (e.g., CloudLinux 7) when IPv4 forcing is unset.
- Fixed installation UUID bootstrap to reuse existing `.env` values and avoid chmods that broke web-user access, preventing API 500s when env files were unreadable.
- Added installation UUID enforcement (server + baked cdx) to prevent cross-instance mixups; `/auth` rejects mismatched `installation_id`, installers/cdx carry the UUID.
- Added persistent IPv4-only host toggle (admin API + dashboard) that clears IP binding and bakes wrappers/installers with `curl -4`; cdx fetches updates over IPv4 when set.
- Aligned Logs header button styling with other admin controls.
- Installation UUID now auto-generates at boot/migration via shared helper, ensuring `.env` is populated across entrypoints without manual edits.
- Dashboard now shows weekly and month-to-date cost estimates side-by-side (using pricing + token usage) instead of daily totals.
- ChatGPT usage cost card now renders separate lines: “X$ this Week” and “Y$ this Month” for clearer readability.
- Weekly cost now uses the ChatGPT weekly limit window start (when available) instead of a naive trailing 7-day slice for more accurate estimates.
- Backups: the `mysql-backup` sidecar now runs by default, writes to `${DATA_ROOT}/backups`, and replaces the host cron helper; `docker compose up` automatically schedules nightly dumps (tuned via `DB_BACKUP_*` env vars) and setup/docs were updated accordingly.
- cdx wrapper: pass per-host reasoning effort via `--config model_reasoning_effort=...` (current Codex CLI standard) instead of the legacy `--reasoning-effort` flag; wrapper bumped to 2025.12.29-01.
- cdx wrapper: accept token-only auth.json (tokens.access_token or OPENAI_API_KEY) during local validation so fresh `codex login` files aren’t deleted before sync; wrapper bumped to 2026.01.02-01.
- Auth: `/auth` store now runs the auth runner before persisting; runner failures/unreachable responses reject the upload (admin `/admin/auth/upload` still bypasses the runner).
- Auth: when `last_refresh` matches canonical but the digest differs, `/auth` retrieve now asks the host to upload and runner‑validated stores may update canonical on timestamp ties.
- Admin config builder: write/read `features.experimental_windows_sandbox` (Codex 0.79+), drop the deprecated `enable_experimental_windows_sandbox` key from generated configs; cache-bumped config.js v=2026-01-07-02.
- cdx wrapper: sync Skills as `~/.codex/skills/<slug>/SKILL.md` (directory format) with frontmatter metadata parsing; wrapper bumped to 2026.01.09-01.
