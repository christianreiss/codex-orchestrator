# Overview

## What it is

Small PHP 8.2 + MySQL service that keeps one canonical Codex `auth.json` for every host in your fleet. Hosts talk to `/auth` (retrieve/store) with per-host API keys baked into their `cdx` wrapper. The same API also ships slash commands, Skills, shared project coordination, token-usage telemetry, ChatGPT quota snapshots, and pricing data for dashboards.

## Primary use cases

- Centralize `auth.json` instead of managing per-host logins.
- Bake a one-time installer per host (API key + base URL) and keep hosts in sync automatically.
- Audit who synced/rotated auth, what versions they run, and how many tokens they burn.
- Run Codex in environments that require IP binding, mTLS, and rate limits.

## Contract guardrails

- Critical host-facing response contracts are machine-readable under `docs/contracts/`:
  - `auth-retrieve.schema.json`
  - `auth-store.schema.json`
  - `versions.schema.json`
  - `usage-ingest.schema.json`
  - `sync-status.schema.json`
  - `sync-bootstrap.schema.json`
- CI validates fixture coverage (`tests/ContractSchemasTest.php`), live `AuthService` response shapes (`tests/AuthServiceContractResponsesTest.php`), and schema/docs drift (`scripts/verify-interface-contracts.php`).

## Why teams use it

- One `/auth` call decides whether to accept a client upload or return the canonical copy and always includes versions + quota metadata.
- Per-host API keys are hashed/encrypted at rest, IP-bound on first use, and rotated when a host is re-registered.
- Canonical auth + per-target tokens are encrypted with libsodium `secretbox`; the key is bootstrapped into `.env` on first boot. Optional keyring mode (`AUTH_ENCRYPTION_KEYS` + `AUTH_ENCRYPTION_ACTIVE_KID`) supports rotation with `kid`-tagged ciphertext.
- Safety rails: global/auth-fail rate limits, API kill switch, token quality checks, RFC3339 timestamp bounds, optional IP roaming, and opt-in insecure-host gates.
- Runner sidecar validates canonical auth on scheduled preflight checks (default ~8h) and after stores, auto-applies refreshed auth from Codex, and never blocks `/auth` **retrieve** when down (store uploads require a reachable runner; admin uploads bypass).
- Extras ride the same API: slash-command + Skill distribution, native project coordination (notes/todos/files/feedback/activity), MCP memories, token usage ingest (total/input/output/cached/reasoning), ChatGPT `/wham/usage` snapshots, and pricing pulls for dashboard costs.

## Key components (code map)

- **`public/index.php` router** — boots env, key manager + secretbox, repositories/services, scheduled preflight (8h), global rate limiting, and all routes (host/admin/installer/seed/auth/sync/slash/skills/projects/agents/config/MCP/usage/pricing/chatgpt/versions). Production expects schema/backfills via `scripts/migrate.php`; request-path migration/backfill is controlled by `RUN_MIGRATIONS_ON_BOOT` / `RUN_BACKFILLS_ON_BOOT`.
- **`App\Services\AuthService`** — orchestrates `/auth`, host registration, IP binding/roaming, insecure-host windows, digest caching, canonicalization (auths synthesized from `tokens.access_token`/`OPENAI_API_KEY` when missing), token quality checks, version snapshotting, host pruning (inactive 30d or never-provisioned >30m), and runner integration with recovery/backoff.
- **`RunnerVerifier`** — HTTP client to the auth-runner; probes readiness, posts canonical auth, and returns updated auth + telemetry.
- **`WrapperService`** — seeds `storage/wrapper/cdx` from bundled `bin/cdx`, derives `WRAPPER_VERSION`, and bakes per-host script with API key/base URL/FQDN/security flag/CA path; hash + size returned by `/wrapper`. If storage drift is detected but `storage/wrapper/cdx` is not writable, it serves bundled `bin/cdx` directly and logs a warning so stale wrappers are not served.
- **`SlashCommandService`** — CRUD for prompts stored in MySQL, hashed by sha256, with delete markers for retirements.
- **`ProjectModuleService`** — tracks whether native shared-project coordination is enabled and derives the managed `coco` skill manifest that ships to clients through the ordinary Skills sync surface, with the CoCo toolkit/help embedded in the skill itself and explicitly constrained to project-only shared state.
- **`ProjectCoordinationService`** — owns `/projects*` and `/admin/projects*`: project creation, about/roster edits, shared notes/todos/files/feedback, project resource exports for MCP, and append-only event history.
- **`StartupSyncService`** — computes combined startup diffs/payloads for prompts, Skills, AGENTS.md, and config (`/sync/status`, `/sync/bootstrap`) so wrappers can reduce pre-run API fan-out.
- **`AgentsService`** — stores versioned AGENTS.md editions, serves either the latest/pinned fleet version or a per-host pin, and feeds the admin editor + host sync.
- **`MemoryService` + `McpServer`** — MCP memory storage per host (content, tags, optional metadata) with CRUD tooling (`memory_store`/`memory_retrieve`/`memory_search`), host-safe resource helpers, unconditional `skill://{slug}` read-only resources for synced Skill manifests, and optional project-aware MCP tools/resources (`project_*`, `project://{slug}`) when the Projects module is enabled. Coordinator filesystem helpers are retained for operator/internal use and are not exposed on the host-authenticated `/mcp` route.
- **`ClientConfigService`** — renders/stores canonical `config.toml` from structured settings (sha + TOML body + saved builder payload) for the admin config page and wrapper sync; `/config/retrieve` bakes a per-host copy using either the host API key (secure hosts) or a short-lived MCP bearer (insecure hosts) for the managed HTTP MCP entry.
- **`ChatGptUsageService` & `PricingService`** — use canonical auth to poll ChatGPT quotas (cooldown, cron-friendly), capture both normal and Spark (`additional_rate_limits`) quota lanes, and fetch GPT-5.4 pricing (HTTP or env fallback) for cost calculations.
- **`UsageCostService` & `CostHistoryService`** — backfill missing costs in token usage rows/ingests (boot-gated by `RUN_BACKFILLS_ON_BOOT`) using the latest pricing snapshot, and expose up to 180 days of daily token + cost time series for dashboards.
- Admin dashboard charts use local Chart.js assets (with zoom plugin) for inline quota/cost analytics on the main dashboard; history APIs now support richer range/interval filters for those graphs.
- Admin dashboard supports login + role-based access once at least one active admin user exists; userless installs behave as before until the first admin is created. Login now uses a dedicated `/admin/login` page with server-side redirects (`/admin/` -> `/admin/login` when unauthenticated) and a username-first flow that requires passkeys for passkey-enabled admins. Personal session controls now live under the navbar brand account menu: theme selection is always available, while authenticated users also get self-service password change (`/admin/account/password`), personal passkey management (`/admin/account/passkeys`), and logout. Admin users and roles stay in the Users panel; personal passkeys no longer live there, and password reset endpoints remain disabled.
- Host management now uses dedicated host detail pages at `/admin/hosts/{id}` (Action Items, Features, Stats, Infos) instead of the legacy host detail modal.
- **Repositories + `SecretBox`** — MySQL storage with encrypted auth payload bodies and tokens; API keys stored as sha256 + secretbox ciphertext; supports legacy `sbox:v1` plus key-id ciphertext for rotation.
- **Admin websocket server (optional)** — `scripts/admin-ws.php` streams `admin_events` to connected `/admin` clients; `/admin/ws/info` advertises the public `ws/wss` URL and the latest event id. The admin SPA maps `log.created` actions to targeted panel refreshes (overview/hosts/settings/prompts/skills/projects/agents/memories/users/config/profiles) and falls back to overview+hosts for unknown actions.

## How the flow works

1) **Provision a host (admin)**
   - `POST /admin/hosts/register` creates or rotates a host, hashes + encrypts the API key, and mints a single-use installer token. Optional `vip=true` marks the host as VIP immediately (quota hard-fail disabled). Insecure hosts get a provisioning window (default 30 minutes, or `duration_minutes` from register when provided); secure hosts expect long-lived local auth.
   - `GET /install/{token}` emits a bash script that downloads the baked wrapper, installs Codex from GitHub (Linux + macOS `apple-darwin` assets), prints versions plus a compact usage quickstart (`cdx --version`, `cdx`, `cdx --execute ...`), and leaves `cdx` ready to run. Tokens expire (`INSTALL_TOKEN_TTL_SECONDS`) and are marked used on first fetch.

2) **Every `/auth` call**
   - Scheduled preflight runs on the first non-admin request after an ~8-hour gap (or boot, configurable via `AUTH_RUNNER_PREFLIGHT_SECONDS`): refresh the GitHub client-version cache and, when configured, run one runner validation.
   - API key auth: resolves client IP, enforces per-IP binding unless `allow_roaming_ips` or `?force=1` on `DELETE /auth`; insecure-host window gating applies to `/auth` retrieve (and other window-gated routes), while `/auth` store submissions are still evaluated as candidates when the window is closed.
- Versions: reports the effective fleet Codex target (GitHub latest with stale fallback plus an internal minimum floor of `0.114.0`), `client_version_enforce_exact` downgrade policy, wrapper version/sha from server disk, runner state, quota policy (`quota_hard_fail`, `quota_limit_percent`, and optional `quota_week_partition` pacing), `auto_update_enabled` for cron-managed update hosts, and the fleet-wide `cdx_silent` quiet flag. When Codex self-management is skipped for privilege reasons, the summary note now includes the wrapper-detected UID to expose root/user-namespace mismatches directly in the output. VIP hosts force warn-only (`quota_hard_fail=false`) regardless of the global policy.
   - Retrieve path: compares client `last_refresh`/`digest` to canonical. Returns `valid`, `upload_required`, `outdated`, or `missing`, plus host stats (API calls, monthly token totals) and recent digests (remembered per host).
   - Store path: validates RFC3339 `last_refresh` (>= 2000‑01‑01, <= now+300s), enforces token entropy/length, normalizes/sorts auths, synthesizes from tokens when needed, and **runs the auth runner before persisting** (non-OK runner results reject the upload; admin uploads bypass). Store submissions are always treated as candidates regardless of insecure-window state, but still require normal API-key/IP/reverse-DNS/installation checks and runner validation. On success, it hashes canonical JSON, stores encrypted body + per-target entries, updates the canonical pointer/host sync state/digest cache. Runner-provided `updated_auth` is stored when it is newer than the upload, and same-timestamp digest differences are accepted when runner validation passes.

3) **Runner validation**
   - Enabled when `AUTH_RUNNER_URL` is set (default in compose). Scheduled run every ~8h + on stores; recovery/backoff when the runner is failing; optional IP bypass CIDRs. Runner failures are logged (`auth.validate`/`auth.runner_store`), do not block `/auth` retrieve, but **do** block `/auth` store uploads (admin uploads/seed bypass the runner).

4) **Wrapper distribution**
   - `/wrapper` returns metadata; `/wrapper/download` returns the baked script with per-host hash/size headers. Wrapper content is the source of truth—rebuild the image or replace `storage/wrapper/cdx` to roll a new version (bump `WRAPPER_VERSION`).
   - The wrapper exposes a short Spark-lane alias: `cdx ls` rewrites to `cdx lane spark` before normal lane/profile parsing, so it supports the same `--persist` and passthrough argument handling.
   - Help-only invocations (`cdx --help`, `cdx -h`, `cdx help`, and Codex subcommand help such as `cdx exec --help`) bypass wrapper startup noise and print only upstream Codex help text; the wrapper skips lock/sync/update/MOTD/footer work in that path.
- Wrapper startup pull sync is batched: it probes `POST /sync/status` and, when updates exist, pulls content via `POST /sync/bootstrap` (prompts/Skills/AGENTS/config in one flow). Older servers automatically fall back to legacy per-resource pull endpoints.
- Wrapper Codex updates now key off `/auth` `client_version_enforce_exact`: floor-only targets only trigger upgrades, while explicit above-floor pins can still downgrade to match.
  - When the Projects module is enabled, the managed `coco` skill is injected into that normal Skills sync flow; there is no separate wrapper-side project bootstrap pass. When the module turns off again, wrapper sync prunes the previously managed skill copy on clients, and it also removes stale legacy managed copies under `~/.codex/skills` so old CoCo docs cannot shadow the new project-only skill.
   - `POST /sync/bootstrap` can also process auth in the same request when `include_auth=true`: if auth is `missing`/`upload_required` and `auth_candidate` is provided, the server attempts an inline store and reports `auth_stored` (or `auth_*` reasons).
   - On Linux hosts where wrapper-managed dependency installs are allowed (`root` or passwordless `sudo -n`), `cdx` auto-checks/installs `curl`, `unzip`, and `script` (util-linux) before update/sync work using `apt-get`, `dnf`, `yum`, `pacman`, `zypper`, or `apk` (RHEL-family prefers `dnf` with `yum` fallback for legacy CentOS 7/8/9 compatibility). On macOS it checks/installs `python3`, `curl`, and `unzip` via Homebrew when missing.
   - SSH terminals now use the same standard wrapper launch paths as local terminals (`script` PTY when available, Python `pty` fallback, then direct execution); `cdx doctor` reports SSH env hints, PTY state, and local Codex version for troubleshooting.
   - When a host has an already-active `cdx` run, concurrent guard still skips mutating sync/update work, but performs a read-only `/auth` retrieve to refresh quota/policy metadata for the compact boot summary (single concurrent-guard section + quota lines).
   - Wrapper post-run auth upload now compares both `last_refresh` and local `auth.json` SHA-256; content changes with unchanged timestamps are still pushed so fleet hosts can consume updated auth promptly.
   - Wrapper self-update re-exec preserves original argv for subcommands (for example `cdx resume`) and snapshots original argc separately, so empty-argv restarts fall back cleanly without `set -u` empty-array crashes on older bash builds such as CentOS 7 / XCP-NG hosts.
   - The normal boot summary is now sectioned (`Health`, `Versions`, `Usage`, `Quota`, `Result`) with plain-language labels and grouped numbers for calls/tokens.
   - Post-run output now ends with a compact footer (`Run usage`, `Run cost`, `Sync`) that includes server-calculated run cost as `Run cost | 💰 <amount>` on UTF-8 terminals when `/usage` returns `data.cost` (ASCII fallback omits the icon); displayed cost is rounded to two decimals with a trailing `$` (example `0.43$`). Current Codex builds are read from the per-run session JSONL for structured token usage, and total-only `tokens used` fallbacks keep run cost unavailable.
   - Summary blocks are compacted into aligned columns (default up to three entries per row via `CODEX_SUMMARY_ITEMS_PER_ROW`), with Quota defaulting to one metric per row via `CODEX_SUMMARY_ITEMS_PER_ROW_QUOTA=1` and Versions defaulting to two entries per row via `CODEX_SUMMARY_ITEMS_PER_ROW_VERSIONS=2`.
   - Quota rendering aligns metric labels for graph rows and now includes non-active lane 5-hour/weekly bar rows (Spark or Normal) instead of a compact text-only lane summary.

5) **Usage, prompts, and host telemetry**
   - `/usage` ingests token lines (array or single) with optional cached/reasoning/model fields; sanitizes log lines, computes cost per entry from the latest pricing snapshot (env fallbacks when remote pricing is absent) when billable token splits are present, stores per-row entries, and records a per-request ingest row (`token_usage_ingests`) with aggregates, payload snapshot, client IP, and total cost.
   - `/host/users` records current username/hostname for the host and returns the known list (used by `cdx --uninstall`).
   - `/host/lane` exposes/stores host lane preference (`normal|spark|null`) so wrappers can persist lane steering without admin login.
   - Host sync uses `/slash-commands` list/retrieve/store; admin routes write delete markers that propagate to hosts on next sync.
   - Host sync uses `/skills` list/retrieve/store; admin routes write delete markers that propagate to hosts on next sync. When project coordination is enabled, this same path auto-ships the managed `coco` skill to clients.
   - Shared project state itself is served live through `/projects*` and project-aware MCP tools/resources rather than through startup sync payloads.

6) **Quotas and pricing**
   - ChatGPT quota snapshots are pulled from `/wham/usage` using canonical tokens (cooldown 5m, also usable via the `quota-cron` sidecar). Results are cached and surfaced on `/auth` responses and admin dashboards with dual-lane metadata: normal + Spark windows and active-lane hints.
   - Pricing snapshots (default GPT-5.4) are fetched at most daily from `PRICING_URL` or env defaults; `/admin/overview` shows monthly token totals + estimated cost.

## Safety rails

- **Rate limits** — Global per-IP bucket for non-admin paths (default 120/minute, tunable); auth-fail bucket throttles repeated missing/invalid API keys with a block window when tripped. Limits return 429 with reset metadata.
- **IP binding & roaming** — First successful call pins the API key to that IP (and a second IP if the host is dual-stack: one IPv4 + one IPv6); optional roaming flag updates the stored IP; reverse DNS enforcement (when enabled) requires the caller IP to appear in the host’s A/AAAA records and have a PTR back to the host FQDN; runner probes can bypass via CIDRs; `DELETE /auth?force=1` allows uninstall from a different IP.
- **Insecure hosts** — Require an active sliding window (0–480 minutes, default 10, set via the log-ish dashboard slider or `duration_minutes`) for `/auth` retrieve and other window-gated host routes. Each non-store `/auth` call extends the window by that duration. `/auth` store submissions are still accepted as candidates when the window is closed and then pass normal validation gates. New insecure hosts start with a provisioning window (default 30 minutes, overridable via register `duration_minutes`); secure hosts keep auth on disk, insecure hosts purge `~/.codex/auth.json` after each run (handled in `cdx`). When insecure approvals are enabled and an admin websocket client is connected, closed-window retrieve requests return a pending response and `cdx` waits for approval; optional domain auto-allow rules can auto-open windows for matching subdomains while active.
- **Auth integrity** — Digest is sha256 over canonical JSON; stored digest mismatch triggers validation logging. Timestamps are clamped to reasonable bounds.
- **Encryption & secrets** — Secretbox protects API keys, payload bodies, and token entries; key is auto-generated/persisted in `.env` if absent. API keys also stored as sha256 hashes for lookup.
- **Kill switches** — Admin can disable the API (`/admin/api/state` 503s everything else) or set quota mode + limit slider (`/admin/quota-mode` exposes warn-only vs. hard-fail, `limit_percent`, and optional `week_partition` pacing for a daily allowance bar in `cdx`). Hosts can also be marked VIP (per-host toggle) to bypass the quota kill-switch entirely (always warn-only). Admin routes honor mTLS by default.

## Data retention & pruning

- Canonical auth lives in `auth_payloads` (encrypted body + sha256) with per-target `auth_entries` (encrypted tokens). `host_auth_states` tracks what each host last saw; `host_auth_digests` caches up to 3 recent digests per host.
- Hosts are pruned when inactive for `inactivity_window_days` (default 30; set to `0` to disable; configurable in Admin Settings → General), never provisioned within 30 minutes, or when `expires_at` is in the past (temporary hosts; refreshed on successful host contact for a 2-hour idle window); pruning logs `host.pruned` and cascades digests/state/users.
- Logs, token usages, slash commands, Skills, project coordination tables, ChatGPT/pricing snapshots, and version flags all live in MySQL; storage is the compose volume.

## Fleet workflow at a glance

- Bring up the stack (`cp .env.example .env`, set DB/host vars, `docker compose up --build`; add `--profile caddy` for TLS/mTLS frontend). Runner + quota cron sidecars are on by default in compose.
- Log into Codex once on a trusted box; upload that `~/.codex/auth.json` via the dashboard, use the one-time `curl | bash` seed command, or call `/auth` with `command: "store"`.
- For each host: `New Host` → copy `curl …/install/{token} | bash` → run on the host. The wrapper bakes API key/FQDN/base URL and pulls canonical auth.
- Host-side usage (how to run Codex via `cdx`, what files it manages, troubleshooting): see `docs/USAGE.md`.
- Build/edit `config.toml` from `/admin/config.html`; saved output is synced by `cdx` to `~/.codex/config.toml` baked per host (managed HTTP MCP entry; secure hosts use the host API key, insecure hosts get a short-lived bearer). New builder drafts default to model `gpt-5.4`, `personality = "friendly"`, `[features].apps = true`, and `[features].multi_agent = true`; the admin builder keeps `guardian_approval`, `js_repl`, `prevent_idle_sleep`, and `use_linux_sandbox_bwrap` off until explicitly enabled. `status:missing` deletes the local copy. Legacy feature keys (`steer`, `experimental_windows_sandbox`, `enable_experimental_windows_sandbox`) remain ingest-compatible but are dropped from rendered output.
- Enable shared project coordination from Settings → Projects when you want multi-agent notes/todos/files/feedback; that toggle also publishes the managed `coco` skill through MCP `skill://coco` as the primary interface, includes that canonical `uri` in bootstrap/sync metadata, and still syncs a fallback copy to `~/.agents/skills/coco/SKILL.md` on clients. Disabling the module removes that managed skill on the next sync. Shared CoCo handoffs are project-only; host-scoped MCP memories are not a cross-server fallback. The Settings panel stays compact and opens each project on its own `/admin/projects/<slug>` workspace page.
- Rotate tokens by updating the trusted machine’s `auth.json` and pushing again (dashboard upload or `/auth` store from any host with the new digest).
- Decommission with dashboard delete or `cdx --uninstall` (calls `DELETE /auth`).

## Operations

- Logs are stored in MySQL (`logs` table). For a quick peek in a default Docker setup you can run:  
  `docker compose exec mysql mysql -u"$DB_USERNAME" -p"$DB_PASSWORD" "$DB_DATABASE" -e "SELECT * FROM logs ORDER BY created_at DESC LIMIT 10;"`
- The legacy `host-status.txt` export has been removed; use the admin dashboard (`/admin/overview` and `/admin/hosts`) for current host status.
- Timestamp comparisons normalize RFC3339 strings including fractional seconds, so Codex-style values such as `2025-11-19T09:27:43.373506211Z` are supported.
