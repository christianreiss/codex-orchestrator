# Agents & Responsibilities

This project is small, but each class has a clear role in the orchestration pipeline that keeps Codex `auth.json` files synchronized between servers. Use this guide when extending or debugging the service.

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
   - Tracks the canonical auth digest and remembers up to 3 digests per host for quick matching.
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
     - `hosts`: fqdn, api_key, status, last_refresh, auth_digest, auth_json, timestamps.
       - Additional columns track `ip` (first sync source), `client_version` (reported Codex build), `wrapper_version` (cdx wrapper build when supplied), and `api_calls`.
     - `host_auth_digests`: host_id, digest, last_seen, created_at (pruned to 3 per host).
     - `logs`: host_id, action, details, created_at.
     - `versions`: published/seen versions with updated_at.

## Extension Tips

- Add new endpoints by expanding `public/index.php` and delegating to `AuthService` or a new service class.
- Additional background tasks (cleanup, retention) should live in their own service but reuse the repositories.
- When adding new columns, extend `Database::migrate()` and keep repositories in sync.
