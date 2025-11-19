# Agents & Responsibilities

This project is small, but each class has a clear role in the orchestration pipeline that keeps Codex `auth.json` files synchronized between servers. Use this guide when extending or debugging the service.

## Request Flow

1. **`public/index.php` (HTTP Router)**
   - Bootstraps the environment, loads `.env`, and runs SQLite migrations.
   - Parses incoming JSON and matches routes: `/register` and `/auth/sync`.
   - Resolves API keys from `X-API-Key` or `Authorization: Bearer` headers.
   - Returns JSON responses using `App\Http\Response`.

2. **`App\Services\AuthService` (Coordinator)**
   - Validates registration requests against the configured invitation key.
   - Issues per-host API keys (random 64-hex chars) and normalizes host payloads.
   - Performs auth.json sync decisions by comparing `last_refresh` timestamps.
   - Logs every register/sync action through `LogRepository`.

3. **`App\Repositories\HostRepository` (Persistence)**
   - CRUD operations on the `hosts` table (find by fqdn/api_key, create, update auth).
   - Maintains metadata fields like `updated_at`, `status`, IP bindings, client versions, and optional wrapper versions.

4. **`App\Repositories\LogRepository` (Auditing)**
   - Inserts rows into the `logs` table with lightweight JSON details.
   - Keeps a chronological record of who did what and when.

5. **`App\Support\Timestamp` (Comparer)**
   - Compares RFC3339 strings (with or without fractional seconds) reliably.
   - Ensures `2025-11-19T09:27:43.373506211Z` style values sort correctly.

6. **`App\Database` (Infrastructure)**
   - Opens the SQLite connection, enforces foreign keys, and runs migrations.
   - Creates tables:
     - `hosts`: fqdn, api_key, status, last_refresh, auth_json, timestamps.
       - Additional columns track `ip` (first sync source), `client_version` (reported Codex build), and `wrapper_version` (cdx wrapper build when supplied).
     - `logs`: host_id, action, details, created_at.

## Extension Tips

- Add new endpoints by expanding `public/index.php` and delegating to `AuthService` or a new service class.
- Additional background tasks (cleanup, retention) should live in their own service but reuse the repositories.
- When adding new columns, extend `Database::migrate()` and keep repositories in sync.
