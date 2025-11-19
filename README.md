# Codex Auth Central API

A lightweight PHP API that centralizes Codex `auth.json` files. Clients register themselves with an invitation key, upload their current `auth.json`, and receive either their own submission (if newer) or the canonical copy maintained by the service. All write/read operations are logged, and host metadata is persisted for auditing. See `AGENTS.md` for a deeper look at each component.

## Highlights

- Register hosts with a fixed invitation key and issue per-host API keys.
- Push/sync Codex `auth.json` documents; server decides whether to adopt the new payload or return the canonical version based on `last_refresh` while capturing the client's Codex version for fleet audits.
- Simple SQLite persistence for hosts + request logs.
- Dockerized runtime via `php:8.2-apache` with automatic migrations.
- Authentication enforced for every endpoint except registration (`X-API-Key` or `Authorization: Bearer` headers).

## Quick Start

```bash
cp .env.example .env          # set INVITATION_KEY and optional DB_PATH
docker compose up --build     # runs API on http://localhost:8080
```

## Project Structure

```
public/           # Single entrypoint (index.php)
src/              # Core classes: database, repositories, services, support
storage/          # Mounted volume for the SQLite database
Dockerfile        # Production image
docker-compose.yml
```

## Getting Started

1. **Environment**
   - Copy `.env.example` to `.env`.
   - Set a strong `INVITATION_KEY`.
   - `DB_PATH` defaults to `storage/database.sqlite` inside the container.

2. **Docker**
   - `docker compose up --build`
   - Service listens on `http://localhost:8080`.
   - Named volume `auth_storage` persists the SQLite file.

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

### `POST /auth/check`

Lightweight validation call. The client submits only metadata about its cached `auth.json` so the server can respond with `valid`, `outdated`, or `upload_required` without transferring the full document.

Required body fields:
- `last_refresh`: RFC3339 timestamp tied to the cached payload.
- `auth_sha`: lowercase SHA-256 of the cached payload (hash the JSON string you would upload).

Include `client_version` (JSON or `client_version`/`cdx_version` query param). Optionally include `wrapper_version` (JSON or `wrapper_version`/`cdx_wrapper_version`).

```http
POST /auth/check?client_version=0.60.1 HTTP/1.1
Host: localhost:8080
X-API-Key: <host-api-key>
Content-Type: application/json

{
  "last_refresh": "2025-11-19T09:27:43.373506211Z",
  "auth_sha": "b0b1b540ea35ac7cf806..."
}
```

- `status: valid` → client matches server (response includes authoritative `last_refresh` + digest only).
- `status: outdated` → server sends back the canonical payload so the client can hydrate.
- `status: upload_required` or `status: missing` → server expects the client to call `/auth/update` with the full payload.

### `POST /auth/update` (alias: `/auth/sync`)

Push the current `auth.json` (either wrap it under an `auth` key or send the raw document). Requires the per-host API key via `X-API-Key` or `Authorization: Bearer <key>`.

Every update **must** include the Codex CLI version, sent either as a JSON field (`client_version`) or a query parameter (`client_version`/`cdx_version`). You may also include `wrapper_version` (JSON or query parameter, alias `cdx_wrapper_version`) if a cdx wrapper/installer is involved; it is optional but stored for auditing when supplied.

```http
POST /auth/update?client_version=0.60.1&wrapper_version=1.4.3 HTTP/1.1
Host: localhost:8080
X-API-Key: <host-api-key>
Content-Type: application/json

{
  "auth": {
    "last_refresh": "2025-11-19T09:27:43.373506211Z",
    "auths": { ... }
  }
}
```

**Response**

```json
{
  "status": "ok",
  "data": {
    "result": "updated",
    "host": {
      "fqdn": "host.example.com",
      "status": "active",
      "last_refresh": "2025-11-19T09:27:43.373506211Z",
      "updated_at": "2025-11-19T09:28:00Z",
      "client_version": "0.60.1",
      "wrapper_version": "1.4.3"
    },
    "auth": { ... canonical auth.json ... },
    "last_refresh": "2025-11-19T09:27:43.373506211Z"
  }
}
```

If the submitted `last_refresh` is newer than the stored value (per RFC3339 timestamps), the new payload becomes canonical. When the incoming payload is **unchanged or older**, the server responds with:

```json
{
  "status": "ok",
  "data": {
    "result": "unchanged",
    "last_refresh": "2025-11-19T09:27:43.373506211Z"
  }
}
```

No auth document is sent in the `unchanged` case so clients can skip rewriting their files.

## Data & Logging

- **hosts**: FQDN, API key, status, stored `auth_json`, last refresh time, IP binding, latest `client_version`, and optional `wrapper_version`.
- **logs**: Each registration and sync operation records host, action, timestamps, and a JSON blob summarizing the decision (`updated` vs `unchanged`).
- All data is stored in SQLite under `storage/database.sqlite` (or the path defined in `DB_PATH`). Mount or back up this directory to retain state outside of containers.

Access logs manually with `sqlite3 storage/database.sqlite 'SELECT * FROM logs ORDER BY created_at DESC LIMIT 10;'`.

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
- The server normalizes timestamps with fractional seconds, so Codex-style values such as `2025-11-19T09:27:43.373506211Z` compare correctly.
- Extendable: add admin/reporting endpoints by introducing more routes in `public/index.php` and new repository methods.
- Refer to `AGENTS.md` when you need a walkthrough of how each class collaborates within the request pipeline.
