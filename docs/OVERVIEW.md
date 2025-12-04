# Overview

## What it is

Small PHP 8.2 + MySQL service that keeps one canonical Codex `auth.json` for every host in your fleet. Hosts talk to `/auth` (retrieve/store) with per-host API keys baked into their `cdx` wrapper. The same API also ships slash commands, token-usage telemetry, ChatGPT quota snapshots, and pricing data for dashboards.

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
- Runner sidecar validates canonical auth daily and after stores, auto-applies refreshed auth from Codex, and never blocks `/auth` when down.
- Extras ride the same API: slash-command distribution, token usage ingest (total/input/output/cached/reasoning), ChatGPT `/wham/usage` snapshots, and GPT‑5.1 pricing pulls for dashboard costs.

## Key components (code map)

- **`public/index.php` router** — boots env, migrations, key manager + secretbox, encryption migrator, repositories/services, scheduled preflight (8h), global rate limiting, and all routes (host/admin/installer/slash/pricing/chatgpt).
- **`App\Services\AuthService`** — orchestrates `/auth`, host registration, IP binding/roaming, insecure-host windows, digest caching, canonicalization (auths synthesized from `tokens.access_token`/`OPENAI_API_KEY` when missing), token quality checks, version snapshotting, host pruning (inactive 30d or never-provisioned >30m), and runner integration with recovery/backoff.
- **`RunnerVerifier`** — HTTP client to the auth-runner; probes readiness, posts canonical auth, and returns updated auth + telemetry.
- **`WrapperService`** — seeds `storage/wrapper/cdx` from bundled `bin/cdx`, derives `WRAPPER_VERSION`, and bakes per-host script with API key/base URL/FQDN/security flag/CA path; hash + size returned by `/wrapper`.
- **`SlashCommandService`** — CRUD for prompts stored in MySQL, hashed by sha256, with delete markers for retirements.
- **`ChatGptUsageService` & `PricingService`** — use canonical auth to poll ChatGPT quotas (cooldown, cron-friendly) and fetch GPT‑5.1 pricing (HTTP or env fallback) for cost calculations.
- **`UsageCostService` & `CostHistoryService`** — backfill missing costs in token usage rows/ingests on boot using the latest pricing snapshot, and expose up to 180 days of daily token + cost time series for dashboards.
- **Repositories + `SecretBox`** — MySQL storage with encrypted auth payload bodies and tokens; API keys stored as sha256 + secretbox ciphertext; `AuthEncryptionMigrator` upgrades legacy rows in batches at boot.

## How the flow works

1) **Provision a host (admin)**
   - `POST /admin/hosts/register` creates or rotates a host, hashes + encrypts the API key, and mints a single-use installer token. Insecure hosts get a 30‑minute provisioning window; secure hosts expect long-lived local auth.
   - `GET /install/{token}` emits a bash script that downloads the baked wrapper, installs Codex from GitHub (latest tag the API knows about), and prints versions. Tokens expire (`INSTALL_TOKEN_TTL_SECONDS`) and are marked used on first fetch.

2) **Every `/auth` call**
   - Scheduled preflight runs on the first non-admin request after an ~8-hour gap (or boot, configurable via `AUTH_RUNNER_PREFLIGHT_SECONDS`): refresh the GitHub client-version cache and, when configured, run one runner validation.
   - API key auth: resolves client IP, enforces per-IP binding unless `allow_roaming_ips` or `?force=1` on `DELETE /auth`; insecure hosts must be inside an enabled window.
   - Versions: reports GitHub latest (cached 3h with stale fallback), wrapper version/sha from server disk, runner state, and quota mode (`quota_hard_fail`).
   - Retrieve path: compares client `last_refresh`/`digest` to canonical. Returns `valid`, `upload_required`, `outdated`, or `missing`, plus host stats (API calls, monthly token totals) and recent digests (remembered per host).
   - Store path: validates RFC3339 `last_refresh` (>= 2000‑01‑01, <= now+300s), enforces token entropy/length, normalizes/sorts auths, synthesizes from tokens when needed, hashes canonical JSON, stores encrypted body + per-target entries, updates canonical pointer, host sync state, and digest cache. Runner may revalidate and apply a fresher `updated_auth` from Codex.

3) **Runner validation**
   - Enabled when `AUTH_RUNNER_URL` is set (default in compose). Scheduled run every ~8h + on stores; recovery/backoff when the runner is failing; optional IP bypass CIDRs. Runner failures are logged (`auth.validate`/`auth.runner_store`) but do not block serving/accepting auth.

4) **Wrapper distribution**
   - `/wrapper` returns metadata; `/wrapper/download` returns the baked script with per-host hash/size headers. Wrapper content is the source of truth—rebuild the image or replace `storage/wrapper/cdx` to roll a new version (bump `WRAPPER_VERSION`).

5) **Usage, prompts, and host telemetry**
- `/usage` ingests token lines (array or single) with optional cached/reasoning/model fields; sanitizes log lines, computes cost per entry from the latest pricing snapshot (env fallbacks when remote pricing is absent), stores per-row entries, and records a per-request ingest row (`token_usage_ingests`) with aggregates, payload snapshot, client IP, and total cost.
   - `/host/users` records current username/hostname for the host and returns the known list (used by `cdx --uninstall`).
   - `/slash-commands` list/retrieve/store/delete prompt files; delete marks propagate to hosts on next sync.

6) **Quotas and pricing**
   - ChatGPT quota snapshots are pulled from `/wham/usage` using canonical tokens (cooldown 5m, also usable via the `quota-cron` sidecar). Results are cached and surfaced on `/auth` responses and admin dashboards.
   - Pricing snapshots (default GPT‑5.1) are fetched at most daily from `PRICING_URL` or env defaults; `/admin/overview` shows monthly token totals + estimated cost.

## Safety rails

- **Rate limits** — Global per-IP bucket for non-admin paths (default 120/minute, tunable); auth-fail bucket throttles repeated missing/invalid API keys with a block window when tripped. Limits return 429 with reset metadata.
- **IP binding & roaming** — First successful call pins the API key to that IP; optional roaming flag updates the stored IP; runner probes can bypass via CIDRs; `DELETE /auth?force=1` allows uninstall from a different IP.
- **Insecure hosts** — Require an active 10‑minute window for `/auth` (dashboard enable extends the sliding window). New insecure hosts start with a provisioning window; secure hosts keep auth on disk, insecure hosts purge `~/.codex/auth.json` after each run (handled in `cdx`).
- **Auth integrity** — Digest is sha256 over canonical JSON; stored digest mismatch triggers validation logging. Timestamps are clamped to reasonable bounds.
- **Encryption & secrets** — Secretbox protects API keys, payload bodies, and token entries; key is auto-generated/persisted in `.env` if absent. API keys also stored as sha256 hashes for lookup.
- **Kill switches** — Admin can disable the API (`/admin/api/state` 503s everything else) or set quota mode (`/admin/quota-mode` warn-only vs. hard-fail for ChatGPT limits). Admin routes honor mTLS by default and optional `DASHBOARD_ADMIN_KEY`.

## Data retention & pruning

- Canonical auth lives in `auth_payloads` (encrypted body + sha256) with per-target `auth_entries` (encrypted tokens). `host_auth_states` tracks what each host last saw; `host_auth_digests` caches up to 3 recent digests per host.
- Hosts are pruned when inactive for `INACTIVITY_WINDOW_DAYS` (default 30; set to `0` to disable) or never provisioned within 30 minutes; pruning logs `host.pruned` and cascades digests/state/users.
- Logs, token usages, slash commands, ChatGPT/pricing snapshots, and version flags all live in MySQL; storage is the compose volume.

## Fleet workflow at a glance

- Bring up the stack (`cp .env.example .env`, set DB/host vars, `docker compose up --build`; add `--profile caddy` for TLS/mTLS frontend). Runner + quota cron sidecars are on by default in compose.
- Log into Codex once on a trusted box; upload that `~/.codex/auth.json` via the dashboard or call `/auth` with `command: "store"`.
- For each host: `New Host` → copy `curl …/install/{token} | bash` → run on the host. The wrapper bakes API key/FQDN/base URL and pulls canonical auth.
- Rotate tokens by updating the trusted machine’s `auth.json` and pushing again (dashboard upload or `/auth` store from any host with the new digest).
- Decommission with dashboard delete or `cdx --uninstall` (calls `DELETE /auth`).

## Operations

- Logs are stored in MySQL (`logs` table). For a quick peek in a default Docker setup you can run:  
  `docker compose exec mysql mysql -u"$DB_USERNAME" -p"$DB_PASSWORD" "$DB_DATABASE" -e "SELECT * FROM logs ORDER BY created_at DESC LIMIT 10;"`
- The legacy `host-status.txt` export has been removed; use the admin dashboard (`/admin/overview` and `/admin/hosts`) for current host status.
- Timestamp comparisons normalize RFC3339 strings including fractional seconds, so Codex-style values such as `2025-11-19T09:27:43.373506211Z` are supported.
