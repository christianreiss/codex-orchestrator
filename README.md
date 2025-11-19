# Codex Auth Central API

A lightweight PHP API that centralizes Codex `auth.json` files. Clients register themselves with an invitation key, upload their current `auth.json`, and receive either their own submission (if newer) or the canonical copy maintained by the service. All write/read operations are logged, and host metadata is persisted for auditing. See `AGENTS.md` for a deeper look at each component.

## Highlights

- Register hosts with a fixed invitation key and issue per-host API keys.
- Push/sync Codex `auth.json` documents; server decides whether to adopt the new payload or return the canonical version based on `last_refresh`.
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

### `POST /auth/sync`

Push the current `auth.json` (either wrap it under an `auth` key or send the raw document). Requires the per-host API key via `X-API-Key` or `Authorization: Bearer <key>`.

```http
POST /auth/sync HTTP/1.1
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
    "host": {
      "fqdn": "host.example.com",
      "status": "active",
      "last_refresh": "2025-11-19T09:27:43.373506211Z",
      "updated_at": "2025-11-19T09:28:00Z"
    },
    "auth": { ... canonical auth.json ... },
    "last_refresh": "2025-11-19T09:27:43.373506211Z"
  }
}
```

If the submitted `last_refresh` is newer than the stored value (per RFC3339 timestamps), the new payload becomes canonical. Otherwise, the stored copy is returned unchanged.

## Data & Logging

- **hosts**: FQDN, API key, status, stored `auth_json`, and last refresh time.
- **logs**: Each registration and sync operation records host, action, timestamps, and a JSON blob summarizing the decision (`updated` vs `unchanged`).
- All data is stored in SQLite under `storage/database.sqlite` (or the path defined in `DB_PATH`). Mount or back up this directory to retain state outside of containers.

Access logs manually with `sqlite3 storage/database.sqlite 'SELECT * FROM logs ORDER BY created_at DESC LIMIT 10;'`.

## Host Status Report

The service regenerates a report (`storage/host-status.txt`) after every register/sync/prune event so operators always have a current snapshot. Override the output path with `STATUS_REPORT_PATH`.

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
