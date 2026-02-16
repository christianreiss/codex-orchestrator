# Overview

## What it is

Small PHP 8.2 + MySQL service that keeps one canonical Codex `auth.json` for every host in your fleet. Hosts talk to `/auth` (retrieve/store) with per-host API keys baked into their `cdx` wrapper. The same API also ships slash commands, Skills, token-usage telemetry, ChatGPT quota snapshots, and pricing data for dashboards.

## Primary use cases

- Centralize `auth.json` instead of managing per-host logins.
- Bake a one-time installer per host (API key + base URL) and keep hosts in sync automatically.
- Audit who synced/rotated auth, what versions they run, and how many tokens they burn.
- Run Codex in environments that require IP binding, mTLS, and rate limits.

## Why teams use it

- One `/auth` call decides whether to accept a client upload or return the canonical copy and always includes versions + quota metadata.
- Per-host API keys are hashed/encrypted at rest, IP-bound on first use, and rotated when a host is re-registered.
- Canonical auth + per-target tokens are encrypted with libsodium `secretbox`; the key is bootstrapped into `.env` on first boot and legacy plaintext rows are migrated automatically.
- Safety rails: global/auth-fail rate limits, API kill switch, token quality checks, RFC3339 timestamp bounds, optional IP roaming, and opt-in insecure-host gates.
- Runner sidecar validates canonical auth daily and after stores, auto-applies refreshed auth from Codex, and never blocks `/auth` **retrieve** when down (store uploads require a reachable runner; admin uploads bypass).
- Extras ride the same API: slash-command + Skill distribution, MCP memories (store/retrieve/search), token usage ingest (total/input/output/cached/reasoning), ChatGPT `/wham/usage` snapshots, and GPT‑5.1 pricing pulls for dashboard costs.

## Key components (code map)

- **`public/index.php` router** — boots env, migrations, key manager + secretbox, encryption migrator, repositories/services, scheduled preflight (8h), global rate limiting, and all routes (host/admin/installer/slash/skills/agents/config/MCP/usage/pricing/chatgpt/mcp/seed).
- **`App\Services\AuthService`** — orchestrates `/auth`, host registration, IP binding/roaming, insecure-host windows, digest caching, canonicalization (auths synthesized from `tokens.access_token`/`OPENAI_API_KEY` when missing), token quality checks, version snapshotting, host pruning (inactive 30d or never-provisioned >30m), and runner integration with recovery/backoff.
- **`RunnerVerifier`** — HTTP client to the auth-runner; probes readiness, posts canonical auth, and returns updated auth + telemetry.
- **`WrapperService`** — seeds `storage/wrapper/cdx` from bundled `bin/cdx`, derives `WRAPPER_VERSION`, and bakes per-host script with API key/base URL/FQDN/security flag/CA path; hash + size returned by `/wrapper`.
- **`SlashCommandService`** — CRUD for prompts stored in MySQL, hashed by sha256, with delete markers for retirements.
- **`AgentsService`** — stores versioned AGENTS.md editions, serves either the latest/pinned fleet version or a per-host pin, and feeds the admin editor + host sync.
- **`MemoryService`** — MCP memory storage per host (content, tags, optional metadata) with CRUD tooling (`memory_store`/`memory_retrieve`/`memory_search`) and an admin browser + delete panel.
- **`ClientConfigService`** — renders/stores canonical `config.toml` from structured settings (sha + TOML body + saved builder payload) for the admin config page and wrapper sync; `/config/retrieve` bakes a per-host copy using that host’s API key for the managed HTTP MCP entry (Authorization header, no npm).
- **`ChatGptUsageService` & `PricingService`** — use canonical auth to poll ChatGPT quotas (cooldown, cron-friendly), capture both normal and Spark (`additional_rate_limits`) quota lanes, and fetch GPT‑5.1 pricing (HTTP or env fallback) for cost calculations.
- **`UsageCostService` & `CostHistoryService`** — backfill missing costs in token usage rows/ingests on boot using the latest pricing snapshot, and expose up to 180 days of daily token + cost time series for dashboards.
- Admin dashboard charts use uPlot when available and fall back to inline SVG if the renderer fails.
- Admin dashboard supports login + role-based access once at least one active admin user exists; userless installs behave as before until the first admin is created. Login now uses a dedicated `/admin/login` page with server-side redirects (`/admin/` -> `/admin/login` when unauthenticated). Admin users and roles live in the Users panel; password reset endpoints are disabled.
- **Repositories + `SecretBox`** — MySQL storage with encrypted auth payload bodies and tokens; API keys stored as sha256 + secretbox ciphertext; `AuthEncryptionMigrator` upgrades legacy rows in batches at boot.
- **Admin websocket server (optional)** — `scripts/admin-ws.php` streams `admin_events` to connected `/admin` clients; `/admin/ws/info` advertises the public `ws/wss` URL and the latest event id.

## How the flow works

1) **Provision a host (admin)**
   - `POST /admin/hosts/register` creates or rotates a host, hashes + encrypts the API key, and mints a single-use installer token. Optional `vip=true` marks the host as VIP immediately (quota hard-fail disabled). Insecure hosts get a 30‑minute provisioning window; secure hosts expect long-lived local auth.
   - `GET /install/{token}` emits a bash script that downloads the baked wrapper, installs Codex from GitHub (Linux + macOS `apple-darwin` assets), prints versions, and leaves `cdx` ready to run. Tokens expire (`INSTALL_TOKEN_TTL_SECONDS`) and are marked used on first fetch.

2) **Every `/auth` call**
   - Scheduled preflight runs on the first non-admin request after an ~8-hour gap (or boot, configurable via `AUTH_RUNNER_PREFLIGHT_SECONDS`): refresh the GitHub client-version cache and, when configured, run one runner validation.
   - API key auth: resolves client IP, enforces per-IP binding unless `allow_roaming_ips` or `?force=1` on `DELETE /auth`; insecure hosts must be inside an enabled window.
   - Versions: reports GitHub latest (cached 3h with stale fallback), wrapper version/sha from server disk, runner state, quota policy (`quota_hard_fail`, `quota_limit_percent`, and optional `quota_week_partition` pacing), and the fleet-wide `cdx_silent` quiet flag. VIP hosts force warn-only (`quota_hard_fail=false`) regardless of the global policy.
   - Retrieve path: compares client `last_refresh`/`digest` to canonical. Returns `valid`, `upload_required`, `outdated`, or `missing`, plus host stats (API calls, monthly token totals) and recent digests (remembered per host).
   - Store path: validates RFC3339 `last_refresh` (>= 2000‑01‑01, <= now+300s), enforces token entropy/length, normalizes/sorts auths, synthesizes from tokens when needed, and **runs the auth runner before persisting** (non-OK runner results reject the upload; admin uploads bypass). On success, it hashes canonical JSON, stores encrypted body + per-target entries, updates the canonical pointer/host sync state/digest cache. Runner-provided `updated_auth` is stored when it is newer than the upload, and same-timestamp digest differences are accepted when runner validation passes.

3) **Runner validation**
   - Enabled when `AUTH_RUNNER_URL` is set (default in compose). Scheduled run every ~8h + on stores; recovery/backoff when the runner is failing; optional IP bypass CIDRs. Runner failures are logged (`auth.validate`/`auth.runner_store`), do not block `/auth` retrieve, but **do** block `/auth` store uploads (admin uploads/seed bypass the runner).

4) **Wrapper distribution**
   - `/wrapper` returns metadata; `/wrapper/download` returns the baked script with per-host hash/size headers. Wrapper content is the source of truth—rebuild the image or replace `storage/wrapper/cdx` to roll a new version (bump `WRAPPER_VERSION`).
   - On Linux hosts where wrapper-managed dependency installs are allowed (`root` or passwordless `sudo -n`), `cdx` auto-checks/installs `curl`, `unzip`, and `script` (util-linux) before update/sync work. On macOS it checks/installs `python3`, `curl`, and `unzip` via Homebrew when missing.
   - When a host has an already-active `cdx` run, concurrent guard still skips mutating sync/update work, but performs a read-only `/auth` retrieve to refresh quota/policy metadata for the compact boot summary (single concurrent-guard line + quota lines).

5) **Usage, prompts, and host telemetry**
- `/usage` ingests token lines (array or single) with optional cached/reasoning/model fields; sanitizes log lines, computes cost per entry from the latest pricing snapshot (env fallbacks when remote pricing is absent), stores per-row entries, and records a per-request ingest row (`token_usage_ingests`) with aggregates, payload snapshot, client IP, and total cost.
   - `/host/users` records current username/hostname for the host and returns the known list (used by `cdx --uninstall`).
   - `/slash-commands` list/retrieve/store/delete prompt files; delete marks propagate to hosts on next sync.
   - `/skills` list/retrieve/store/delete Skill manifests (mirrors slash commands, syncs `~/.codex/skills`).

6) **Quotas and pricing**
   - ChatGPT quota snapshots are pulled from `/wham/usage` using canonical tokens (cooldown 5m, also usable via the `quota-cron` sidecar). Results are cached and surfaced on `/auth` responses and admin dashboards with dual-lane metadata: normal + Spark windows and active-lane hints.
   - Pricing snapshots (default GPT‑5.1) are fetched at most daily from `PRICING_URL` or env defaults; `/admin/overview` shows monthly token totals + estimated cost.

## Safety rails

- **Rate limits** — Global per-IP bucket for non-admin paths (default 120/minute, tunable); auth-fail bucket throttles repeated missing/invalid API keys with a block window when tripped. Limits return 429 with reset metadata.
- **IP binding & roaming** — First successful call pins the API key to that IP (and a second IP if the host is dual-stack: one IPv4 + one IPv6); optional roaming flag updates the stored IP; reverse DNS enforcement (when enabled) requires the caller IP to appear in the host’s A/AAAA records and have a PTR back to the host FQDN; runner probes can bypass via CIDRs; `DELETE /auth?force=1` allows uninstall from a different IP.
- **Insecure hosts** — Require an active sliding window (0–480 minutes, default 10, set via the log-ish dashboard slider or `duration_minutes`) for `/auth`. Each `/auth` call extends the window by that duration. New insecure hosts start with a provisioning window; secure hosts keep auth on disk, insecure hosts purge `~/.codex/auth.json` after each run (handled in `cdx`). When insecure approvals are enabled and an admin websocket client is connected, closed-window requests return a pending response and `cdx` waits for approval; optional domain auto-allow rules can auto-open windows for matching subdomains while active.
- **Auth integrity** — Digest is sha256 over canonical JSON; stored digest mismatch triggers validation logging. Timestamps are clamped to reasonable bounds.
- **Encryption & secrets** — Secretbox protects API keys, payload bodies, and token entries; key is auto-generated/persisted in `.env` if absent. API keys also stored as sha256 hashes for lookup.
- **Kill switches** — Admin can disable the API (`/admin/api/state` 503s everything else) or set quota mode + limit slider (`/admin/quota-mode` exposes warn-only vs. hard-fail, `limit_percent`, and optional `week_partition` pacing for a daily allowance bar in `cdx`). Hosts can also be marked VIP (per-host toggle) to bypass the quota kill-switch entirely (always warn-only). Admin routes honor mTLS by default.

## Data retention & pruning

- Canonical auth lives in `auth_payloads` (encrypted body + sha256) with per-target `auth_entries` (encrypted tokens). `host_auth_states` tracks what each host last saw; `host_auth_digests` caches up to 3 recent digests per host.
- Hosts are pruned when inactive for `inactivity_window_days` (default 30; set to `0` to disable; configurable in Admin Settings → General), never provisioned within 30 minutes, or when `expires_at` is in the past (temporary hosts; refreshed on successful host contact for a 2-hour idle window); pruning logs `host.pruned` and cascades digests/state/users.
- Logs, token usages, slash commands, Skills, ChatGPT/pricing snapshots, and version flags all live in MySQL; storage is the compose volume.

## Fleet workflow at a glance

- Bring up the stack (`cp .env.example .env`, set DB/host vars, `docker compose up --build`; add `--profile caddy` for TLS/mTLS frontend). Runner + quota cron sidecars are on by default in compose.
- Log into Codex once on a trusted box; upload that `~/.codex/auth.json` via the dashboard, use the one-time `curl | bash` seed command, or call `/auth` with `command: "store"`.
- For each host: `New Host` → copy `curl …/install/{token} | bash` → run on the host. The wrapper bakes API key/FQDN/base URL and pulls canonical auth.
- Host-side usage (how to run Codex via `cdx`, what files it manages, troubleshooting): see `docs/USAGE.md`.
- Build/edit `config.toml` from `/admin/config.html`; saved output is synced by `cdx` to `~/.codex/config.toml` baked per host (HTTP MCP entry with bearer token env). `status:missing` deletes the local copy.
- Rotate tokens by updating the trusted machine’s `auth.json` and pushing again (dashboard upload or `/auth` store from any host with the new digest).
- Decommission with dashboard delete or `cdx --uninstall` (calls `DELETE /auth`).

## Operations

- Logs are stored in MySQL (`logs` table). For a quick peek in a default Docker setup you can run:  
  `docker compose exec mysql mysql -u"$DB_USERNAME" -p"$DB_PASSWORD" "$DB_DATABASE" -e "SELECT * FROM logs ORDER BY created_at DESC LIMIT 10;"`
- The legacy `host-status.txt` export has been removed; use the admin dashboard (`/admin/overview` and `/admin/hosts`) for current host status.
- Timestamp comparisons normalize RFC3339 strings including fractional seconds, so Codex-style values such as `2025-11-19T09:27:43.373506211Z` are supported.
