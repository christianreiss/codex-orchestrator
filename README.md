# Codex Auth Central API

Welcome! If you were searching for a "Codex auth.json sync server / Codex wrapper backend / multi-host auth.json manager," you landed in the right place. This is a small PHP service that keeps one canonical Codex `auth.json` for your fleet, so hosts either pull the official copy or publish a newer one in a single API call.

## Use case (start here)

- You run Codex across multiple hosts and want a single source of truth for `auth.json`.
- Hosts should self-enroll with an invite key, pick up the canonical file, or contribute an update when theirs is fresher.
- You want lightweight auditing (who registered, who synced, which versions) without babysitting machines.
- You are fine with a containerized PHP + MySQL service and a couple of helper scripts to wire it up.

**Search terms:** codex auth.json sync, codex wrapper server, codex central auth backend, php codex auth api, multi-host auth.json manager.

## Why teams use it

- One `/auth` flow: register once, then a unified retrieve/store call that decides whether to accept the client's auth or return the canonical copy (with versions attached).
- Invitation-key gating issues per-host API keys; hosts can self-deregister via `DELETE /auth` when decommissioned.
- Captures host metadata (IP, client version, optional wrapper version) so you know which machines are on which build.
- MySQL-backed persistence and audit logs out of the box; storage lives in the compose volume by default.
- Bin helpers ship with the container: `bin/codex-install` handles registration + sync, while `bin/codex-uninstall` calls `DELETE /auth` before tearing down local files.
- Token-usage lines from Codex runs can be posted to `/usage` for per-host auditing.
- Runs in `php:8.2-apache` with automatic migrations; every endpoint except registration enforces API-key auth (`X-API-Key` or `Authorization: Bearer`).
- Stores the canonical `auth.json` as a compact JSON blob (sha256 over that exact text); only the `auths` map is normalized, everything else is preserved verbatim.

## How it works (big picture)

- This container exposes a small PHP API + MySQL database that act as the "auth.json registry" for all of your Codex hosts.
- A companion installer script (`bin/codex-install`) SSHes into a host, installs or updates the Codex CLI + `cdx` wrapper, registers the host with this API using an invitation key, and uploads your `auth.json`.
- Each host keeps a tiny sync env file (for example `/usr/local/etc/codex-sync.env` or `~/.codex/sync.env`) that tells the wrapper how to reach this API; from then on, the host no longer needs manual `codex login` runs.

## From manual logins to central sync

Think of a very common starting point:

- You have several servers (or laptops, CI runners, etc.).
- On each one, you log into Codex by hand and end up with a separate `~/.codex/auth.json`.
- When a token rotates, you have to remember which machines to fix.

With this project in place:

1. **Run the auth server once.** Bring up the Docker stack (see "Quick Start") and choose an `INVITATION_KEY` in `.env`.
2. **Log into Codex on one trusted machine.** Use the normal Codex CLI sign-in so you get a local `~/.codex/auth.json`. This will become your starting canonical auth.
3. **Enroll each host with `bin/codex-install`.**

   From this repo (or any clone that has `bin/codex-install`), on your trusted machine:

   ```bash
   # Point the installer at your auth server
   export CODEX_SYNC_BASE_URL="https://codex-auth.example.com"   # or http://localhost:8488 during testing
   export CODEX_SYNC_INVITE_KEY="<INVITATION_KEY from the server .env>"

   # Install Codex + wrapper + sync on a host
   ./bin/codex-install my-server-01.example.com
   ```

   What this does behind the scenes:

   - SSHes into `my-server-01.example.com` (default user is `root`, override with `-u ubuntu`).
   - Installs or upgrades the Codex CLI and the `cdx` wrapper.
   - Registers the host with this API using the invitation key and gets a per-host API key.
   - Uploads your local `~/.codex/auth.json` and makes it the canonical `auth.json` for that host.
   - Writes a small sync config so future Codex runs talk to this server automatically.

   To tweak SSH details:

   ```bash
   ./bin/codex-install -u ubuntu -p 2222 my-server-02.example.com
   ```

   To keep the wrapper auto-updated on the host, add:

   ```bash
   ./bin/codex-install --install-systemd-timer my-server-03.example.com
   ```

4. **Repeat for all your machines.** Every call to `codex-install` enrolls another host with the same central auth service; you no longer have to log in interactively on each box.
5. **Clean up when a host is retired.**

   ```bash
   ./bin/codex-uninstall my-server-01.example.com
   ```

   This removes Codex binaries/configs on the target host and calls `DELETE /auth` using the stored sync config so the host disappears from the registry.

## Commands you'll actually type

On the **auth server host**:

- `cp .env.example .env`
- Edit `.env` and set `INVITATION_KEY` and `DB_*` (or use the defaults from `docker-compose.yml`).
- `docker compose up --build`

On your **laptop or admin box** (the one where you already use Codex):

- `codex login` (or whichever flow creates `~/.codex/auth.json`).
- `export CODEX_SYNC_BASE_URL="https://codex-auth.example.com"` (or `http://localhost:8488`).
- `export CODEX_SYNC_INVITE_KEY="<INVITATION_KEY from the server .env>"`.
- `./bin/codex-install my-server-01.example.com` to enroll a host.
- `./bin/codex-uninstall my-server-01.example.com` to remove a host and deregister it from the auth server.
- `./bin/local-bootstrap full` to prep the current workstation without SSH (installs `cdx`, registers using the `.env` invitation key, and writes the sync env locally).

## FAQ

- **Do I still need to log into Codex on every host?** No. Log in once on a trusted machine to create `~/.codex/auth.json`, then use `bin/codex-install` to enroll other hosts; they will pull the canonical auth automatically.
- **How do I rotate tokens or update `auth.json`?** Log in again on the trusted machine to refresh `~/.codex/auth.json`, then rerun `./bin/codex-install <an-enrolled-host>` (optionally with `--sync-api-key <existing-key>` to skip re-registration). That push updates the canonical auth; other hosts pull it on their next `/auth` call.
- **What if my auth server uses a private CA or self-signed cert?** Pass `--sync-ca-file /path/to/ca.pem` (or set `CODEX_SYNC_CA_FILE`) when running `codex-install` so the host trusts your TLS.
- **How do I remove a host cleanly?** Run `./bin/codex-uninstall <host>`; it deletes Codex bits on the target and calls `DELETE /auth` using the stored sync config.
- **Where is the host-side sync config stored?** Global installs use `/usr/local/etc/codex-sync.env`; user installs use `~/.codex/sync.env`. They contain only the sync base URL, API key, and optional CA path.

### Local bootstrap helper (`bin/local-bootstrap`)

Use `bin/local-bootstrap` when you want to configure this machine directly:

- `./bin/local-bootstrap full` installs/updates `/usr/local/bin/cdx`, registers the host via `/register` using the `INVITATION_KEY` from `.env`, and writes `/usr/local/etc/codex-sync.env` (use `--local-env` to target `~/.codex/sync.env`).
- `./bin/local-bootstrap cdx` refreshes the wrapper only (no API calls).
- `./bin/local-bootstrap register --invite-key <key>` rotates just the API key and rewrites the sync env.

The script accepts the same environment variables as the Codex wrapper (`CODEX_SYNC_BASE_URL`, `CODEX_SYNC_INVITE_KEY`, etc.), reads `INVITATION_KEY` from `.env` by default (falling back to `--invite-key` only when you override it), auto-detects the key from `API.md` when `.env` is missing, and ensures the generated env file is owned by the invoking user so `cdx` can read it without sudo.

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
   - MySQL data persists in `/var/docker_data/codex-auth.uggs.io/mysql_data` (bind-mounted one level above the repo); SQL exports and the SQLite migration backups live under `storage/sql` on your mounted storage path.

3. **Local (optional)**
   - `composer install`
   - `php -S localhost:8080 -t public`
   - Ensure `storage/` is writable by PHP.

## API Reference

> Full, code-accurate contracts live in `interface-api.md`, `interface-db.md`, and `interface-cdx.md`. Highlights below stay in sync with those specs.

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
- `auth`: required for `store`; must include `last_refresh`. The server preserves every top-level field (e.g., `tokens`, `OPENAI_API_KEY`, custom metadata), normalizes only the `auths` map, and stores the resulting compact JSON blob; responses return that same canonical JSON.

Retrieve responses:
- `valid` → canonical digest matches the supplied digest; returns canonical digest + versions only.
- `upload_required` → client `last_refresh` is newer than canonical; caller should resend with `command: "store"` and full auth.
- `outdated` → server has newer or mismatched auth; returns canonical auth + digest + versions.
- `missing` → server has no canonical payload yet.

Store responses:
- `updated` → new canonical stored; returns canonical auth + digest + versions.
- `unchanged` → timestamps match; returns canonical digest + versions.
- `outdated` → server already has newer auth; returns canonical auth + digest + versions.

Auth payload fallbacks: if `auths` is missing/empty but `tokens.access_token` or `OPENAI_API_KEY` exists, the server synthesizes `auths = {"api.openai.com": {"token": <access_token>}}` before validation (still enforces token quality and timestamp rules).

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
- The server refreshes `client_version` by calling the GitHub “latest release” endpoint when `/versions` is requested and the cached value is older than **3 hours**. Fetch failures fall back to the last cached value.
- The `wrapper_version` is chosen as the highest of the stored wrapper metadata, any operator-published value, or the highest wrapper reported by a host (the first report seeds `versions.wrapper` when none exists). You can still override it via `POST /versions` when `VERSION_ADMIN_KEY` is set.

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

- **hosts**: FQDN, API key, status, last refresh time, canonical digest, IP binding, latest `client_version`, and optional `wrapper_version`.
- **logs**: Each registration and sync operation records host, action, timestamps, and a JSON blob summarizing the decision (`updated` vs `unchanged`).
- All data is stored in MySQL (configured via `DB_*`). The default compose file runs a `mysql` service with data under `/var/docker_data/codex-auth.uggs.io/mysql_data`; use `storage/sql` for exports/backups or one-off imports during migrations.

Access logs manually with `docker compose exec mysql mysql -u"$DB_USERNAME" -p"$DB_PASSWORD" "$DB_DATABASE" -e "SELECT * FROM logs ORDER BY created_at DESC LIMIT 10;"`.

## Host Status Report

The legacy `host-status.txt` export has been removed; use the admin dashboard (`/admin/overview` and `/admin/hosts`) for current status.

## Notes

- Every API call except `/register` requires a valid API key.
- Set a strong `INVITATION_KEY`; without it, registration is blocked.
- Hosts that have not checked in (no sync or register) for 30 days are automatically pruned and must re-register.
- Uninstallers should call `DELETE /auth` (handled automatically by `bin/codex-uninstall` when a sync config is present) to remove the host record cleanly.
- The server normalizes timestamps with fractional seconds, so Codex-style values such as `2025-11-19T09:27:43.373506211Z` compare correctly.
- Extendable: add admin/reporting endpoints by introducing more routes in `public/index.php` and new repository methods.
- Refer to `AGENTS.md` when you need a walkthrough of how each class collaborates within the request pipeline.
