# Codex Auth Central API

A lightweight PHP API that centralizes Codex `auth.json` files. Clients register themselves with an invitation key, upload their current `auth.json`, and receive either their own submission (if newer) or the canonical copy maintained by the service. All write/read operations are logged, and host metadata is persisted for auditing. See `AGENTS.md` for a deeper look at each component.

## Highlights

- Register hosts with a fixed invitation key and issue per-host API keys.
- Push/sync Codex `auth.json` documents; server decides whether to adopt the new payload or return the canonical version based on `last_refresh` while capturing the client's Codex version for fleet audits.
- MySQL persistence (containerized) for hosts + request logs.
- Hosts can self-deregister via `DELETE /auth`, which removes their record and digest cache.
- Token-usage lines from Codex runs can be posted to `/usage` (auto-sent by the wrapper) for per-host auditing.
- Shipping bin tooling: `bin/codex-install` registers + syncs via the API, and `bin/codex-uninstall` now calls `DELETE /auth` (using stored sync env) before wiping local files—no registry file required.
- Dockerized runtime via `php:8.2-apache` with automatic migrations.
- Authentication enforced for every endpoint except registration (`X-API-Key` or `Authorization: Bearer` headers).

## Quick Start

```bash
cp .env.example .env          # set INVITATION_KEY and DB_* creds (match docker-compose)
docker compose up --build     # runs API on http://localhost:8488 with a mysql sidecar
```

### CLI helpers (bin/)

- `bin/codex-install`: registers the host (or re-rotates the API key), pushes `auth.json` via `/auth`, and installs the wrapper; supports overriding invite/API/base URL via flags or env.
- `bin/codex-uninstall`: uses any existing sync config (`/usr/local/etc/codex-sync.env` or `~/.codex/sync.env`) to call `DELETE /auth`, then removes Codex binaries/configs. The legacy registry file is no longer used or updated.

## Project Structure

```
public/           # Single entrypoint (index.php)
src/              # Core classes: database, repositories, services, support
storage/          # Mounted volume for host status/wrapper assets and SQL backups (storage/sql)
Dockerfile        # Production image
docker-compose.yml
```

## Getting Started

1. **Environment**
   - Copy `.env.example` to `.env`.
   - Set a strong `INVITATION_KEY`.
   - Configure the MySQL credentials via `DB_HOST/DB_PORT/DB_DATABASE/DB_USERNAME/DB_PASSWORD` (defaults line up with `docker-compose.yml`).
   - Optionally set `VERSION_ADMIN_KEY` to authorize `POST /versions` publishes.

2. **Docker**
   - `docker compose up --build`
   - Services: `api` (PHP) and `mysql` (MySQL 8). Both join the `codex_auth` network.
   - API listens on `http://localhost:8488`.
   - MySQL data persists in the `mysql_data` volume; SQL exports and the SQLite migration backups live under `storage/sql` on your mounted storage path.

3. **Local (optional)**
   - `composer install`
   - `php -S localhost:8080 -t public`
   - Ensure `storage/` is writable by PHP.

## API Reference

### `POST /register`

Registers a new host when provided with the correct invitation key. Re-registering a known FQDN rotates the API key immediately, invalidating the previous one.

```json
{
  "fqdn": "host.example.com",
  "invitation_key": "<shared-secret>"
}
```

**Response**

```json
{
  "status": "ok",
  "host": {
    "fqdn": "host.example.com",
    "status": "active",
    "last_refresh": null,
    "updated_at": "2024-05-01T12:00:00Z",
    "api_key": "<copy-me>"
  }
}
```

### `POST /auth`

Single-call endpoint for both checking and updating auth. Every response includes the current versions block, so clients do not need to call `/versions`.

Body fields:
- `command`: `retrieve` (default) or `store`.
- `client_version`: required (JSON or `client_version`/`cdx_version` query param).
- `wrapper_version`: optional (JSON or `wrapper_version`/`cdx_wrapper_version` query param).
- `digest`: required for `retrieve`; the client’s current SHA-256 auth digest (hash of the exact JSON).
- `last_refresh`: required for `retrieve`.
- `auth`: required for `store`; must include `last_refresh`.

Retrieve responses:
- `valid` → canonical digest matches the supplied digest; returns canonical digest + versions only.
- `outdated` → server has newer auth; returns canonical auth + digest + versions.
- `upload_required` → client claims a newer payload; caller should resend with `command: "store"`.
- `missing` → server has no canonical payload yet.

Store responses:
- `updated` → new canonical stored; returns canonical auth + digest + versions.
- `unchanged` → timestamps match; returns canonical digest + versions.
- `outdated` → server already has newer auth; returns canonical auth + digest + versions.

### `DELETE /auth`

Self-service deregistration for the calling host (identified by API key + IP binding). Removes the host row and its cached digests, returning `{ "deleted": "<fqdn>" }`.

### `GET /wrapper` and `GET /wrapper/download`

Both require the same API key + IP binding as `/auth`. `/wrapper` returns metadata (version, sha256, size, download URL); `/wrapper/download` streams the latest cdx wrapper script with `X-SHA256` and `ETag` headers. Only the latest wrapper copy is retained.

### `POST /wrapper` (admin)

Authenticated with `VERSION_ADMIN_KEY`; accepts `multipart/form-data` (`file`, `version`, optional `sha256`) to replace the wrapper without rebuilding the image. Metadata feeds `/auth` and `/versions`.

### `GET /versions`

Optional (primarily for ops). Returns the cached Codex CLI version (fetched from GitHub when stale), published wrapper version, and the highest values reported by any host. `/auth` already embeds the same structure in its responses.

```http
GET /versions HTTP/1.1
Host: localhost:8080
```

**Response**

```json
{
  "status": "ok",
  "data": {
    "client_version": "0.60.1",
    "client_version_checked_at": "2025-11-20T09:00:00Z",
    "wrapper_version": "2025.11.19-4",
    "wrapper_sha256": "…",
    "wrapper_url": "/wrapper/download",
    "reported_client_version": "0.60.1",
    "reported_wrapper_version": "2025.11.19-4"
  }
}
```

### `POST /versions` (admin)

Allows an operator to publish the authoritative Codex CLI and/or cdx wrapper versions. Protect this endpoint with `VERSION_ADMIN_KEY` (sent via `X-Admin-Key`, `Authorization: Bearer`, or `admin_key` query param).

```http
POST /versions HTTP/1.1
Host: localhost:8080
X-Admin-Key: <admin-secret>
Content-Type: application/json

{ "client_version": "0.60.1", "wrapper_version": "2025.11.19-4" }
```

Response mirrors `GET /versions`.

Notes:
- The server refreshes `client_version` by calling the GitHub “latest release” endpoint when `/versions` is requested and the cached value is older than 2 hours. Fetch failures fall back to the last cached value.
- The `wrapper_version` is auto-seeded from the first reported host if no operator value has been published yet; you can still override it via `POST /versions` when `VERSION_ADMIN_KEY` is set.

### Admin (mTLS-only)

- `/admin/*` routes require an mTLS client certificate; requests without one are rejected (Caddy forwards `X-mTLS-Present`).
- If `DASHBOARD_ADMIN_KEY` is set, the admin key must also be provided (same header rules as `/versions`).
- Endpoints:
  - `GET /admin/overview`: versions, host counts, latest log timestamp, mTLS metadata.
  - `GET /admin/hosts`: list hosts with canonical digest and recent digests.
  - `GET /admin/hosts/{id}/auth`: canonical digest/last_refresh (optionally include auth body with `?include_body=1`).
  - `GET /admin/logs?limit=50&host_id=`: recent audit entries.
- A basic dashboard lives at `/admin/` (served by this container); it calls the endpoints above and will only work when mTLS is presented.

## Data & Logging

- **hosts**: FQDN, API key, status, stored `auth_json`, last refresh time, IP binding, latest `client_version`, and optional `wrapper_version`.
- **logs**: Each registration and sync operation records host, action, timestamps, and a JSON blob summarizing the decision (`updated` vs `unchanged`).
- All data is stored in MySQL (configured via `DB_*`). The default compose file runs a `mysql` service with data in the `mysql_data` volume; use `storage/sql` for exports/backups or one-off imports during migrations.

Access logs manually with `docker compose exec mysql mysql -u"$DB_USERNAME" -p"$DB_PASSWORD" "$DB_DATABASE" -e "SELECT * FROM logs ORDER BY created_at DESC LIMIT 10;"`.

## Migrating from SQLite

If you are upgrading from the old SQLite-backed container:

- Place the legacy SQLite file where the API container can read it (e.g., mount the old `storage/database.sqlite` to `/var/www/html/storage/database.sqlite`).
- Run the migration helper to seed MySQL (truncates existing MySQL tables when `--force` is set):
  - `docker compose run --rm api php bin/migrate-sqlite-to-mysql.php --sqlite /var/www/html/storage/database.sqlite --force`
- The script copies the SQLite file to `storage/sql/sqlite-backup-<timestamp>.db` before writing to MySQL.
- Start the stack normally (`docker compose up -d`); the API will continue using MySQL going forward.
- Once MySQL is verified, archive or remove the old SQLite file from your mounted storage to avoid confusion (a timestamped backup already lives in `storage/sql`).

## Host Status Report

The service regenerates a report (`storage/host-status.txt`) after every register/sync/prune event so operators always have a current snapshot. Override the output path with `STATUS_REPORT_PATH`.

The header now includes aggregated "auth refresh age" metrics (min/avg/max days since each host last delivered a newer `auth.json`) to help you gauge how frequently clients push fresh credentials and tune any cache TTLs accordingly.

Trigger a manual refresh any time (e.g., after offline DB edits):

```bash
docker compose exec api php /var/www/html/bin/export-status.php
cat /var/docker_data/codex-auth.uggs.io/store/host-status.txt
```

The script writes the same aligned table plus per-host details, making it easy to share the current deployment state even if the API is offline.

## Notes

- Every API call except `/register` requires a valid API key.
- Set a strong `INVITATION_KEY`; without it, registration is blocked.
- Hosts that have not checked in (no sync or register) for 30 days are automatically pruned and must re-register.
- Uninstallers should call `DELETE /auth` (handled automatically by `bin/codex-uninstall` when a sync config is present) to remove the host record cleanly.
- The server normalizes timestamps with fractional seconds, so Codex-style values such as `2025-11-19T09:27:43.373506211Z` compare correctly.
- Extendable: add admin/reporting endpoints by introducing more routes in `public/index.php` and new repository methods.
- Refer to `AGENTS.md` when you need a walkthrough of how each class collaborates within the request pipeline.
