# Agents & Responsibilities

Source of truth docs: keep `docs/interface-api.md`, `docs/interface-db.md`, and `docs/interface-cdx.md` aligned with code. Use them when auditing or extending behavior.

This project is small, but each class has a clear role in the orchestration pipeline that keeps Codex `auth.json` files synchronized between servers. Use this guide when extending or debugging the service.

## Process & Ops Rules

- Before any task, run `git pull`.
- When changes require a server restart or touch `cdx`, rebuild and restart the Docker services.
- For every set of changes, always `git commit` and push.

## Operational Checklist (humans)

- When a host misbehaves, run `CODEX_DEBUG=1 cdx --version` to see the baked base URL and masked API key.
- Before letting Codex start, open `~/.codex/auth.json` and confirm it has `last_refresh` plus either a non-empty `auths` map (each with `token`) or a `tokens.access_token`; the server hashes the reconstructed auth.json (normalized `auths` + preserved extras) so missing top-level fields will cause digest mismatches. Fallbacks: if `auths` is empty but `tokens.access_token` or `OPENAI_API_KEY` exists, the API will synthesize `auths = {"api.openai.com": {...}}` during validation.
- Admin API toggle (`/admin/api/state`) currently only stores a flag; `/auth` does not read it yet. Add a guard if you need a real kill-switch.
- Dashboard URL (mTLS required): https://codex.example.com/admin/
- Inactivity pruning: every authenticate/register call deletes hosts inactive for 30 days (`host.pruned` logs). Re-register to restore.
- The admin “clear” endpoint resets a host’s canonical auth state (`auth_digest`/`last_refresh` + host auth state + digests) without deleting the host.

## Request Flow

1. **`public/index.php` (HTTP Router)**
   - Bootstraps env, runs migrations, seeds the wrapper from `bin/cdx` if missing, and (optionally) wires the auth runner (`AUTH_RUNNER_URL`, `AUTH_RUNNER_CODEX_BASE_URL`, `AUTH_RUNNER_TIMEOUT`).
   - Declares routes in `src/Http/Router.php`: host endpoints (`/auth`, `DELETE /auth`, `/usage`, `/wrapper`, `/wrapper/download`), installer (`/install/{token}`), versions (`/versions`), and admin endpoints (runner status/run, auth upload, API flag, hosts CRUD, roaming toggle, overview, logs, usage, tokens).
   - Resolves API keys from `X-API-Key` or `Authorization: Bearer`; admin keys from `X-Admin-Key`/Bearer/query; installer tokens are separate.
   - Emits JSON via `App\Http\Response`; installer responses are shell scripts with `text/x-shellscript`.

2. **`App\Services\AuthService` (Coordinator)**
   - Issues per-host API keys (random 64-hex) and normalizes host payloads for admin-driven provisioning; prunes hosts inactive for 30 days.
   - Auth/IP binding: first auth call stores caller IP; later calls from a different IP 403 unless `allow_roaming_ips` (set via admin) or `?force=1` on `DELETE /auth`. Stores IP and logs `auth.bind_ip` / `auth.roaming_ip` / `auth.force_ip_override`.
   - `/auth` flow:
     - `retrieve` statuses: `valid`, `upload_required` (client `last_refresh` is newer), `outdated` (server newer), `missing` (no canonical). Always includes versions and API call counts.
     - `store` statuses: `updated` (incoming newer or different digest), `unchanged`, `outdated` (server newer). Canonicalizes auths (sorted, token quality enforced, fallback from tokens/OPENAI_API_KEY) and stores compact JSON plus per-target entries.
     - Validations: RFC3339 `last_refresh` (>= 2000-01-01, <= now+300s), `digest` must be 64-hex, tokens checked for entropy/min length (`TOKEN_MIN_LENGTH`, default 24).
   - Canonical state: persists canonical payload (`auth_payloads` + `auth_entries`), records last-seen per host (`host_auth_states`), keeps up to 3 recent digests per host (`host_auth_digests`), and updates host `last_refresh`/`auth_digest`/versions/API call counters.
   - Versions block (per response): client version comes from GitHub latest (cached 3h with stale fallback); wrapper version is always read from the baked wrapper on the server (client-reported/admin-supplied wrapper versions are ignored). Wrapper metadata comes from `WrapperService`.
   - Runner integration (optional): once per UTC day (or on manual trigger) runs the auth runner against canonical auth before responding; applies runner-returned `updated_auth` when newer/different and logs `auth.runner_store`. Every store also logs `auth.validate` result. Manual trigger: `POST /admin/runner/run`.
  - Token usage: `recordTokenUsage()` logs `token.usage` and writes per-entry rows (totals/input/output/cached/reasoning) to `token_usages`; aggregates are surfaced in admin endpoints.
   - Host deletion: `deleteHost()` removes host row + digests; uninstall flow uses `DELETE /auth`.

3. **`App\Repositories\HostRepository` (Persistence)**
   - CRUD operations on the `hosts` table (find by fqdn/api_key, create, update auth).
   - Maintains metadata fields like `updated_at`, `status`, IP bindings, canonical auth digest, client versions, and optional wrapper versions.
   - `incrementApiCalls()` bumps per-host counters on every `/auth`.
   - `/admin/hosts/{id}/clear` resets canonical auth metadata for a host and deletes digests without removing the host record.

4. **`App\Repositories\HostAuthStateRepository` (Per-host canonical pointer)**
   - Stores the last canonical payload ID/digest/seen_at per host for admin inspection.

5. **`App\Repositories\AuthPayloadRepository` & `AuthEntryRepository` (Canonical auth storage)**
   - Saves canonical `auth.json` (compact body JSON in `auth_payloads.body`) plus per-target entries in `auth_entries`.
   - `findByIdWithEntries()`/`latest()` return payload with entries for validation/hydration.

6. **`App\Repositories\HostAuthDigestRepository` (Digest cache)**
   - Persists up to three recent auth digests per host (`host_auth_digests` table) and prunes older entries.

7. **`App\Repositories\LogRepository` (Auditing)**
   - Inserts rows into the `logs` table with lightweight JSON details.
   - Keeps a chronological record of who did what and when.

8. **`App\Repositories\TokenUsageRepository` (Usage metrics)**
   - Writes token usage rows (`token_usages`) and exposes aggregates/top hosts for admin views.

9. **`App\Support\Timestamp` (Comparer)**
   - Compares RFC3339 strings (with or without fractional seconds) reliably.
   - Ensures `2025-11-19T09:27:43.373506211Z` style values sort correctly.

10. **`App\Services\WrapperService` (Wrapper distribution)**
    - Seeds stored wrapper from `bin/cdx` on boot if missing or changed; stores version in `versions.wrapper`.
    - `metadata()` returns version/sha/size/updated_at; `bakedForHost()` injects base URL, API key, FQDN, CA file, and wrapper version, returning content + per-host sha256/size.
    - `replaceFromUpload()` is legacy; `/wrapper` uploads have been removed from the API. Wrapper changes come from the baked script at boot.

11. **`App\Services\RunnerVerifier` (Auth validator)**
    - POSTs auth payloads to `AUTH_RUNNER_URL` with base URL override and optional host telemetry; returns status/latency/reason and optional `updated_auth`.

12. **`App\Database` (Infrastructure)**
   - Opens the MySQL connection (configured via `DB_*`), enforces foreign keys, and runs migrations.
   - Creates tables:
     - `hosts`: fqdn, api_key, status, last_refresh, auth_digest, timestamps.
      - Additional columns track `ip` (first sync source), `client_version` (reported Codex build), `wrapper_version` (legacy; now ignored/NULL), and `api_calls`.
   - `auth_payloads`: last_refresh, sha256, source_host_id, created_at, **body (compact canonical auth.json as uploaded)**.
   - `auth_entries`: per-target token rows for each payload.
   - `host_auth_digests`: host_id, digest, last_seen, created_at (pruned to 3 per host).
   - `host_auth_states`: host_id → payload_id/digest/seen_at (last canonical served to that host).
   - `logs`: host_id, action, details, created_at.
  - `versions`: cached client version from GitHub, wrapper version, canonical pointer, runner metadata, and flags with updated_at.
  - `token_usages`: per-host token usage rows (including reasoning tokens) for dashboard aggregates.

## CLI & Ops Scripts (`bin/`)

- `cdx` (local wrapper/launcher) — Baked per host with API key + base URL at download time; pulls/downstreams auth via `/auth`, writes `~/.codex/auth.json`, and refuses to start Codex if auth pull fails. Autodetects + installs curl/unzip, checks remote target versions (API then GitHub), updates the Codex binary (or npm `codex-cli`) and self-updates the wrapper. After running Codex, pushes auth if it changed and ships token-usage metrics to `/usage`. `cdx --uninstall` removes Codex binaries/config, legacy env/auth files, npm `codex-cli`, and sends `DELETE /auth`.
- Wrapper publishing: the API seeds the wrapper from the bundled `bin/cdx` only once; to change it, rebuild the image (or replace the stored file before boot). `/wrapper` uploads have been removed.
- Any change to the wrapper script (`bin/cdx`) must bump `WRAPPER_VERSION` so hosts refresh; new builds push the updated script into `storage/wrapper/cdx`.
- `migrate-sqlite-to-mysql.php` (one-time migration) — Copies SQLite data to MySQL using `App\Database::migrate()` for schema, backs up the SQLite file, truncates target tables when `--force`, and migrates hosts/logs/digests/versions while skipping orphaned references.

## Extension Tips

- Add new endpoints by expanding `public/index.php` and delegating to `AuthService` or a new service class.
- Additional background tasks (cleanup, retention) should live in their own service but reuse the repositories.
- When adding new columns, extend `Database::migrate()` and keep repositories in sync.
- Wire new admin toggles into `AuthService` or request guards; `api_disabled` is currently persisted but not enforced—if you need the kill-switch, add a guard around `/auth`.
