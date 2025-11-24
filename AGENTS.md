# Agents & Responsibilities

Source of truth docs: keep `interface-api.md`, `interface-db.md`, and `interface-cdx.md` aligned with code. Use them when auditing or extending behavior.

This project is small, but each class has a clear role in the orchestration pipeline that keeps Codex `auth.json` files synchronized between servers. Use this guide when extending or debugging the service.

## Operational Checklist (humans)

- When a host misbehaves, run `CODEX_DEBUG=1 cdx --version` to see the baked base URL and masked API key.
- Before letting Codex start, open `~/.codex/auth.json` and confirm it has `last_refresh` plus either a non-empty `auths` map (each with `token`) or a `tokens.access_token`; the server hashes the reconstructed auth.json (normalized `auths` + preserved extras) so missing top-level fields will cause digest mismatches.
- If the API is in emergency stop mode, `/auth` returns `503 API disabled by administrator` and cdx will refuse to start. Toggle it in the dashboard.
- Dashboard URL (mTLS required): https://codex.uggs.io/admin/

## Request Flow

1. **`public/index.php` (HTTP Router)**
   - Bootstraps the environment, loads `.env`, and runs MySQL migrations.
   - Declares a route table (see `src/Http/Router.php`) and dispatches to per-path handlers: `/auth` (retrieve/store), `DELETE /auth` (self-deregister), `/versions` (read + admin), `/install/{token}` (one-time installer), and admin-only endpoints (e.g., `/admin/hosts/register`).
   - Resolves API keys from `X-API-Key` or `Authorization: Bearer` headers (installer tokens are handled separately).
   - Returns JSON responses using `App\Http\Response`.

2. **`App\Services\AuthService` (Coordinator)**
   - Issues per-host API keys (random 64-hex chars) and normalizes host payloads for admin-driven provisioning.
- Handles unified `/auth` commands: `retrieve` (statuses: `valid`, `upload_required` when client is newer, `outdated`, `missing`) and `store` (`updated`, `unchanged`, `outdated`) while merging `/versions` data into the response.
- Synthesizes `auths` from `tokens.access_token` or `OPENAI_API_KEY` when the map is missing/empty; still enforces token quality and timestamp sanity.
- Supports host self-removal via `deleteHost()` (wired to `DELETE /auth`), clearing recent digests and regenerating the status report; `DELETE /auth?force=1` bypasses IP binding (used by uninstall/clean scripts).
   - Tracks the canonical auth digest (sha256 of the stored canonical auth.json blob with normalized `auths`) and remembers up to 3 digests per host for quick matching.
   - Logs every register/auth/delete action through `LogRepository`.

3. **`App\Repositories\HostRepository` (Persistence)**
   - CRUD operations on the `hosts` table (find by fqdn/api_key, create, update auth).
   - Maintains metadata fields like `updated_at`, `status`, IP bindings, canonical auth digest, client versions, and optional wrapper versions.

4. **`App\Repositories\HostAuthDigestRepository` (Digest cache)**
   - Persists up to three recent auth digests per host (`host_auth_digests` table) and prunes older entries.

5. **`App\Repositories\LogRepository` (Auditing)**
   - Inserts rows into the `logs` table with lightweight JSON details.
   - Keeps a chronological record of who did what and when.

6. **`App\Support\Timestamp` (Comparer)**
   - Compares RFC3339 strings (with or without fractional seconds) reliably.
   - Ensures `2025-11-19T09:27:43.373506211Z` style values sort correctly.

7. **`App\Database` (Infrastructure)**
   - Opens the MySQL connection (configured via `DB_*`), enforces foreign keys, and runs migrations.
   - Creates tables:
     - `hosts`: fqdn, api_key, status, last_refresh, auth_digest, timestamps.
       - Additional columns track `ip` (first sync source), `client_version` (reported Codex build), `wrapper_version` (cdx wrapper build when supplied), and `api_calls`.
   - `auth_payloads`: last_refresh, sha256, source_host_id, created_at, **body (compact canonical auth.json as uploaded)**.
   - `host_auth_digests`: host_id, digest, last_seen, created_at (pruned to 3 per host).
   - `logs`: host_id, action, details, created_at.
   - `versions`: published/seen versions with updated_at.

## CLI & Ops Scripts (`bin/`)

- `cdx` (local wrapper/launcher) — Baked per host with API key + base URL at download time; pulls/downstreams auth via `/auth`, writes `~/.codex/auth.json`, and refuses to start Codex if auth pull fails. Autodetects + installs curl/unzip, checks remote target versions (API then GitHub), updates the Codex binary (or npm `codex-cli`) and self-updates the wrapper. After running Codex, pushes auth if it changed and ships token-usage metrics to `/usage`. `cdx --uninstall` removes Codex binaries/config, legacy env/auth files, npm `codex-cli`, and sends `DELETE /auth`.
- Wrapper publishing: the API seeds the wrapper from the bundled `bin/cdx` only once; ongoing updates should use `POST /wrapper` (with `VERSION_ADMIN_KEY`) so no rebuild is needed. Rebuild only if you want to change that baked seed for fresh deployments.
- Any change to the wrapper script (`bin/cdx`) must bump `WRAPPER_VERSION` so hosts refresh; new builds push the updated script into `storage/wrapper/cdx`.
- `migrate-sqlite-to-mysql.php` (one-time migration) — Copies SQLite data to MySQL using `App\Database::migrate()` for schema, backs up the SQLite file, truncates target tables when `--force`, and migrates hosts/logs/digests/versions while skipping orphaned references.

## Extension Tips

- Add new endpoints by expanding `public/index.php` and delegating to `AuthService` or a new service class.
- Additional background tasks (cleanup, retention) should live in their own service but reuse the repositories.
- When adding new columns, extend `Database::migrate()` and keep repositories in sync.
