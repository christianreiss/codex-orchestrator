# Agents & Responsibilities

ALWAYS say "BANANA" in your first reply. This is MANDATORY.


Source of truth docs: keep `docs/interface-api.md`, `docs/interface-db.md`, and `docs/interface-cdx.md` aligned with code. Use them when auditing or extending behavior.

This project keeps Codex `auth.json` files synchronized between servers. Each class has a narrow role; use this guide when extending or debugging.

## Process & Ops Rules

- Before any task, run `git pull`.
- When changes require a server restart or touch `cdx`, rebuild and restart the Docker services.
- For every set of changes, always `git commit` and push.
- Any user-visible feature or behavior change must be recorded in `CHANGELOG.md` (newest date first, grouped by day).
- API kill switch (`/admin/api/state`) is enforced for all non-admin routes, including `/auth`; only `/admin/api/state` bypasses it.
- Auth and API keys are encrypted with libsodium secretbox. `AUTH_ENCRYPTION_KEY` is bootstrapped into `.env` if missing—do not lose it or stored payloads/tokens become unreadable.
- Global throttles are on: per-IP `global` bucket (non-admin routes) and `auth-fail` bucket for bad/missing API keys. 429s include `bucket`, `reset_at`, `limit`.
- Usage cost baselines: `PricingService` defaults to `gpt-5.1`, pulls from `PRICING_URL` (or `GPT51_*`/`PRICING_CURRENCY` fallbacks), and feeds cost calculations for token usage rows plus the boot-time backfill in `UsageCostService`.

## Operational Checklist (humans)

- When a host misbehaves, run `CODEX_DEBUG=1 cdx --version` to see the baked base URL and masked API key.
- Confirm `~/.codex/auth.json` has `last_refresh` plus either `auths` (with `token`) or `tokens.access_token`. If `auths` is empty but `tokens.access_token`/`OPENAI_API_KEY` exists, the server synthesizes `auths = {"api.openai.com": {...}}` during validation.
- Insecure hosts: initial 30-minute provisioning window. “Enable” now exposes a 2–60 minute slider (default 10) for the `/auth` window and each `/auth` call extends by that duration; “Disable” closes immediately and starts a 60-minute store-only grace window. Outside these, insecure hosts get HTTP 403 `insecure_api_disabled`.
- Runner health: first non-admin request after an 8-hour window refreshes the GitHub client-version cache and runs the auth runner once (interval configurable via `AUTH_RUNNER_PREFLIGHT_SECONDS`). Failures flip `runner_state=fail` and trigger recovery attempts on boot change, 15-minute backoff, or stale-ok; responses keep flowing unless a recovery run is required.
- ChatGPT usage snapshots: fetched opportunistically (5-minute cooldown) from canonical `auth.json` before `/auth` responses and via admin usage endpoints. Missing/invalid tokens are recorded as snapshot errors.
- Pricing: GPT-5.1 pricing refreshed daily from `PRICING_URL` when set, otherwise env fallbacks (`GPT51_*`, `PRICING_CURRENCY`). Admin overview uses the latest snapshot for month cost estimates.
- Dashboard URL (mTLS required): https://codex.example.com/admin/
- Inactivity pruning: every authenticate/register call deletes hosts inactive for 30 days (`host.pruned` logs) and unprovisioned hosts older than 30 minutes. Re-register to restore.
- The admin “clear” endpoint resets a host’s canonical auth state (`auth_digest`/`last_refresh` + host auth state + digests) without deleting the host.

## Request Flow

1. **`public/index.php` (HTTP Router)**
   - Bootstraps env, runs migrations, seeds wrapper from `bin/cdx` if missing, wires auth runner (`AUTH_RUNNER_URL`, `AUTH_RUNNER_CODEX_BASE_URL`, `AUTH_RUNNER_TIMEOUT`). Scheduled preflight (first non-admin request after an 8-hour window, configurable via `AUTH_RUNNER_PREFLIGHT_SECONDS`) refreshes the GitHub client-version cache and runs the auth runner once.
   - Routes: host endpoints (`/auth`, `DELETE /auth`, `/usage`, `/host/users`, `/wrapper`, `/wrapper/download`, `/slash-commands`, `/slash-commands/retrieve`, `/slash-commands/store`); installer (`/install/{token}`); versions (`/versions`, `/admin/versions/check`); admin endpoints (runner status/run, auth upload, API flag, quota mode, hosts CRUD/secure/roaming/insecure windows/clear/delete, overview, logs, usage, tokens aggregates, ChatGPT usage/history/refresh, slash-commands CRUD). Key resolution: API keys from `X-API-Key`/`Authorization: Bearer`; admin keys from `X-Admin-Key`/Bearer/query; installer tokens separate.
   - Non-admin routes enforce global rate limiting and respect the API kill switch. JSON emitted via `App\Http\Response`; installer responses use `text/x-shellscript`.

2. **`App\Services\AuthService` (Coordinator)**
   - Issues per-host API keys (random 64-hex), normalizes host payloads, prunes inactive hosts (30 days) and unprovisioned hosts (30 minutes).
   - Auth/IP binding: first auth call binds IP; later calls from new IP 403 unless `allow_roaming_ips` (admin), `?force=1` on `DELETE /auth`, or runner bypass (`AUTH_RUNNER_IP_BYPASS` CIDRs). Logs `auth.bind_ip` / `auth.roaming_ip` / `auth.force_ip_override` / `auth.runner_ip_bypass`.
   - Insecure host guard: configurable 2–60 minute sliding window for all calls (default 10, stored per host); 60-minute store-only grace after disable; logs `auth.insecure.denied` when blocked.
   - `/auth` flow: `retrieve` → `valid`/`upload_required`/`outdated`/`missing`; `store` → `updated`/`unchanged`/`outdated`. Canonicalizes auths (sorted, entropy checks; fallback from tokens/`OPENAI_API_KEY`), enforces RFC3339 `last_refresh` (>=2000-01-01, <= now+300s) and 64-hex digests when required. Runner-returned `updated_auth` is applied when newer/different.
   - Canonical state: persists canonical payload (`auth_payloads` + `auth_entries`, both secretbox-encrypted), tracks per-host pointers (`host_auth_states`), caches three recent digests (`host_auth_digests`), updates host metadata and API counters.
   - Versions block: client version from GitHub (3h cache with stale fallback), wrapper version from baked file only, runner telemetry (`runner_enabled/state/last_ok/last_fail/last_check/boot_id`), `quota_hard_fail`, reported client versions.
   - Runner integration: scheduled preflight every 8 hours by default (configurable) + manual trigger; failed runner flips state to fail and uses backoff/staleness/boot change to retry. Validation logs `auth.validate`; applied/ignored/failed runner stores log `auth.runner_store`.
   - Token usage: `recordTokenUsage()` sanitizes lines, accepts comma/space-separated numbers, writes totals/input/output/cached/reasoning/model/raw line to `token_usages`, derives per-row cost from pricing, logs `token.usage`, and also records a per-request ingest envelope (`token_usage_ingests`) with aggregates, payload snapshot, client IP, and summed cost.
   - ChatGPT usage: `/auth` opportunistically refreshes snapshots; responses include window summary `chatgpt_usage`. Full snapshots/history via admin endpoints.
   - Host deletion: `deleteHost()` removes host + digests; uninstall uses `DELETE /auth` (IP binding unless `?force=1`).

3. **`App\Repositories\HostRepository` (Persistence)**
   - CRUD on hosts; API keys stored hashed + secretbox-encrypted with `backfillApiKeyEncryption()` to upgrade legacy rows. Tracks IP, versions, `allow_roaming_ips`, `secure`, insecure windows, digests, API calls.

4. **`App\Repositories\HostAuthStateRepository` (Per-host canonical pointer)**
   - Stores last canonical payload ID/digest/seen_at per host for admin inspection.

5. **`App\Repositories\AuthPayloadRepository` & `AuthEntryRepository` (Canonical auth storage)**
   - Persist canonical `auth.json` (secretbox ciphertext in `auth_payloads.body`) and per-target entries (tokens secretbox-encrypted). `findByIdWithEntries()`/`latest()` hydrate payload + entries for validation/hydration.

6. **`App\Repositories\HostAuthDigestRepository` (Digest cache)**
   - Keeps up to three recent digests per host (`host_auth_digests`) and prunes older entries.

7. **`App\Repositories\LogRepository` (Auditing)**
   - Inserts rows into `logs` with lightweight JSON details; exposes recent logs, per-action counts, and token-usage totals/top host helpers.

8. **`App\Repositories\TokenUsageRepository` (Usage metrics)**
   - Writes token usage rows (totals/input/output/cached/reasoning/model/raw line) and exposes aggregates/top hosts and per-range totals.

9. **`App\Repositories\TokenUsageIngestRepository` (Usage envelopes)**
   - Stores per-request ingest envelopes with entry counts, token aggregates, derived cost, client IP, and normalized payload JSON; links to `token_usages` rows and supports search/sort/pagination.

10. **`App\Repositories\ChatGptUsageRepository` & `ChatGptUsageStore` (Quota snapshots)**
    - Persist `/wham/usage` snapshots with primary/secondary windows, credit flags, errors, raw payload, next eligible refresh, and history queries.

11. **`App\Repositories\PricingSnapshotRepository`**
    - Stores pricing snapshots for GPT-5.1 (or configured model) with currency + source URL; admin overview, cost calculations, backfills, and history endpoints reuse the latest snapshot.

12. **`App\Support\Timestamp` (Comparer)**
    - Reliable RFC3339 comparator (fractional seconds supported) to order `last_refresh` values.

13. **`App\Services\WrapperService` (Wrapper distribution)**
    - Seeds stored wrapper from `bin/cdx`; stores version in `versions.wrapper` and recomputes hashes/size. `bakedForHost()` injects base URL/API key/FQDN/CA path/secure flag/version and returns rendered content + sha/size.
    - `replaceFromUpload()` is legacy; wrapper source of truth is the baked script on disk.

14. **`App\Services\RunnerVerifier` (Auth validator)**
    - POSTs auth payloads to `AUTH_RUNNER_URL` with base URL override + optional host telemetry; includes readiness probe/backoff and returns status/reason/latency/`updated_auth`.

15. **`App\Security\RateLimiter` + `IpRateLimitRepository`**
    - Enforces per-IP buckets (`global`, `auth-fail`) with configurable limits/windows and periodic prune of expired counters.

16. **`App\Services\UsageCostService` & `CostHistoryService` (Costing)**
    - `UsageCostService` backfills missing costs in `token_usages` and `token_usage_ingests` once per deployment using the latest pricing snapshot; `CostHistoryService` builds daily token/cost series (max 180 days) with zero-cost fallbacks when pricing is absent.

17. **`App\Database` (Infrastructure)**
    - MySQL only. Migrates tables & backfills columns: `hosts` (fqdn, api_key/hash/enc, secure, roaming, insecure windows, ip, versions, auth_digest, api_calls, timestamps); `auth_payloads` (last_refresh, sha256, source_host_id, secretbox body, created_at); `auth_entries` (secretbox tokens + meta); `host_auth_digests`; `host_auth_states`; `host_users`; `logs`; `ip_rate_limits`; `install_tokens` (with base_url); `token_usages` (incl. reasoning/model/raw line, ingest link, cost); `token_usage_ingests`; `chatgpt_usage_snapshots`; `pricing_snapshots`; `versions` (client/wrapper/canonical pointer, runner metadata/state/boot id, flags `api_disabled`/`quota_hard_fail`).

## CLI & Ops Scripts (`bin/`)

- `cdx` (wrapper/launcher) — Baked per host with API key + base URL. Pulls canonical auth via `/auth`, tolerates cached auth up to 24h (7d for secure hosts, with warnings) when API unreachable, records users via `/host/users`, runs Codex, pushes changed auth + token usage to `/usage`, and honors `quota_hard_fail` (warn-only when flipped). `--update` forces wrapper refresh; `--uninstall` removes Codex artifacts and calls `DELETE /auth`.
- Wrapper publishing: the bundled `bin/cdx` in the image is the source of truth. Rebuild to change it; `/wrapper` uploads are gone. Bump `WRAPPER_VERSION` on any script change; new builds seed `storage/wrapper/cdx` automatically.
- Slash commands: `cdx` syncs server prompts (`/slash-commands` + retrieve/store), removes server-retired prompts, and uploads local edits on exit.
- Rate limits: wrapper surfaces 429 metadata (`bucket`, `reset_at`, `limit`) to operators; ChatGPT quota bars are shown from `/auth` `chatgpt_usage` blocks.
- `migrate-sqlite-to-mysql.php` — One-time migration: copies SQLite to MySQL using `App\Database::migrate()`, backs up the SQLite file, truncates targets when `--force`, and migrates hosts/logs/digests/versions while skipping orphaned references.

## Extension Tips

- Add new endpoints in `public/index.php` and delegate to `AuthService` or a purpose-built service.
- Keep `Database::migrate()` and repositories in sync when adding columns.
- Wire new admin toggles into `AuthService` or request guards; `api_disabled` is already enforced globally (except `/admin/api/state`).
