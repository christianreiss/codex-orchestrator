# Agents & Responsibilities

This project is small, but each class has a clear role in the orchestration pipeline that keeps Codex `auth.json` files synchronized between servers. Use this guide when extending or debugging the service.

## Operational Checklist (humans)

- When a host misbehaves, run `CODEX_DEBUG=1 cdx --version` to see the loaded sync env, masked API key, and base URL. The user-level `~/.codex/sync.env` now overrides system paths.
- Before letting Codex start, open `~/.codex/auth.json` and confirm it has `last_refresh` plus either a non-empty `auths` map (each with `token`) or a `tokens.access_token`; the server hashes the reconstructed auth.json (normalized `auths` + preserved extras) so missing top-level fields will cause digest mismatches.
- If the API is in emergency stop mode, `/auth` returns `503 API disabled by administrator` and cdx will refuse to start. Toggle it in the dashboard.
- Dashboard URL (mTLS required): https://codex.uggs.io/admin/

## Request Flow

1. **`public/index.php` (HTTP Router)**
   - Bootstraps the environment, loads `.env`, and runs MySQL migrations.
   - Parses incoming JSON and matches routes: `/register`, `/auth` (retrieve/store), `DELETE /auth` (self-deregister), `/versions` (read + admin).
   - Resolves API keys from `X-API-Key` or `Authorization: Bearer` headers.
   - Returns JSON responses using `App\Http\Response`.

2. **`App\Services\AuthService` (Coordinator)**
   - Validates registration requests against the configured invitation key.
   - Issues per-host API keys (random 64-hex chars) and normalizes host payloads.
   - Handles unified `/auth` commands: `retrieve` (digest check + versions) and `store` (canonical update) while merging `/versions` data into the response.
   - Supports host self-removal via `deleteHost()` (wired to `DELETE /auth`), clearing recent digests and regenerating the status report.
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

- `cdx` (local wrapper/launcher) — Loads sync env from `/etc`→`/usr/local/etc`→`~/.codex`; pulls/downstreams auth via `/auth`, writes `~/.codex/auth.json`, and refuses to start Codex if auth pull fails. Autodetects + installs curl/unzip, checks remote target versions (API then GitHub), updates the Codex binary (or npm `codex-cli`) and self-updates the wrapper. After running Codex, pushes auth if it changed and ships token-usage metrics to `/usage`.
- `codex-install` (remote installer) — SSHes to a host, ensures curl/tar/python, optionally registers the host via `/register` (invitation key discovery from env or repo `.env`/API doc), writes remote `codex-sync.env`/CA, installs `cdx` (and optional systemd timer) globally or per-user (sudo aware), then port-forwards 1455 to run Codex login and capture the auth URL sentinel. Local auth validation now accepts either `auths.*.token` or `tokens.access_token` so auth.json files that follow the ChatGPT layout work.
- `codex-uninstall` (remote remover) — SSH cleanup that DELETEs the host from the API when sync creds exist, removes cdx/codex binaries, `/opt/codex`, sync env/CA files, and per-user `~/.codex` auth (root/chris/current user). Optional sudo; dedupes multiple targets.
- `codex-clean` (local nuke) — Optionally DELETEs `/auth?force=1`, then removes local `~/.codex/{auth.json,sync.env}`, system-level sync env files, and `/usr/local/bin/{cdx,codex}`. Prompted unless `--yes`; `--no-api` skips deregistration.
- `local-bootstrap` (local setup) — Modes: `full` (install cdx + register), `cdx` (wrapper only), `register` (write env). Picks invitation key from env, repo `.env`, or API.md; registers via `/register` when needed; writes `codex-sync.env` to `/usr/local/etc` or `~/.codex`; supports custom CA and wrapper target path.
- `force-push-auth` (emergency canonicalizer) — Ensures an API key (or registers with invitation key) and force-POSTs the local `auth.json` to `/auth` as the canonical store, preserving tokens and last_refresh.
- `push-wrapper` (admin publish) — Uploads the current `cdx` script to `/wrapper` with SHA-256 and version using `VERSION_ADMIN_KEY`; can also POST `/versions` to bump published Codex client or wrapper version.
- `migrate-sqlite-to-mysql.php` (one-time migration) — Copies SQLite data to MySQL using `App\Database::migrate()` for schema, backs up the SQLite file, truncates target tables when `--force`, and migrates hosts/logs/digests/versions while skipping orphaned references.

## Extension Tips

- Add new endpoints by expanding `public/index.php` and delegating to `AuthService` or a new service class.
- Additional background tasks (cleanup, retention) should live in their own service but reuse the repositories.
- When adding new columns, extend `Database::migrate()` and keep repositories in sync.
