# Codex Auth Central API

Welcome! If you were searching for a "Codex auth.json sync server / Codex wrapper backend / multi-host auth.json manager," you landed in the right place. This is a small PHP service that keeps one canonical Codex `auth.json` for your fleet, so hosts either pull the official copy or publish a newer one in a single API call.

## Use case (start here)

- You run Codex across multiple hosts and want a single source of truth for `auth.json`.
- Hosts are created from the admin dashboard ("New Host"), then install via a one-time command that bakes in the issued API key.
- You want lightweight auditing (who registered, who synced, which versions) without babysitting machines.
- You are fine with a containerized PHP + MySQL service and a couple of helper scripts to wire it up.

**Search terms:** codex auth.json sync, codex wrapper server, codex central auth backend, php codex auth api, multi-host auth.json manager.

## Why teams use it

- One `/auth` flow: register once, then a unified retrieve/store call that decides whether to accept the client's auth or return the canonical copy (with versions attached).
- Per-host API keys are minted from the admin dashboard (New Host) and IP-bound on first use; hosts can self-deregister via `DELETE /auth` when decommissioned.
- Captures host metadata (IP, client version, optional wrapper version) so you know which machines are on which build.
- MySQL-backed persistence and audit logs out of the box; storage lives in the compose volume by default.
- The dashboard "New Host" action generates a single-use installer token (`curl …/install/{token} | bash`) that bakes the API key into the downloaded `cdx`; `cdx --uninstall` handles clean removal.
- The `cdx` wrapper parses Codex “Token usage” lines and posts them to `/usage` for per-host usage tracking.
- Runs in `php:8.2-apache` with automatic migrations; host endpoints enforce API-key auth (`X-API-Key` or `Authorization: Bearer`), and installer downloads are guarded by single-use tokens created via the dashboard.
- Stores the canonical `auth.json` as a compact JSON blob (sha256 over that exact text); only the `auths` map is normalized, everything else is preserved verbatim.
- The “auth runner” sidecar (`auth-runner`, enabled by default in `docker-compose.yml`) validates canonical auth by running `cdx` in an isolated temp `$HOME` on every store and once per UTC day; if Codex refreshes tokens, the runner’s updated auth is auto-applied. Admins can also force a run via `POST /admin/runner/run`.

## How it works (big picture)

- This container exposes a small PHP API + MySQL database that act as the "auth.json registry" for all of your Codex hosts.
- The admin dashboard mints per-host API keys and one-time installer tokens; each token maps to `/install/{uuid}` which returns a self-contained bash script that installs/updates `cdx`, fetches Codex, and bakes the API key/base URL directly into the wrapper (no sync env file needed).
- Each host keeps only `~/.codex/auth.json`; connection details are embedded in its `cdx` wrapper.
- When `AUTH_RUNNER_URL` is configured (enabled by default in `docker-compose.yml`), the API calls a lightweight runner (`runner/app.py`) to probe the canonical `auth.json` with `cdx` on store and once per UTC day; if the runner reports a newer or changed `auth.json`, the API persists and serves that version automatically.

## From manual logins to central sync

Think of a very common starting point:

- You have several servers (or laptops, CI runners, etc.).
- On each one, you log into Codex by hand and end up with a separate `~/.codex/auth.json`.
- When a token rotates, you have to remember which machines to fix.

With this project in place:

1. **Run the auth server once.** Bring up the Docker stack (see "Quick Start"). No invitation key needed.
2. **Log into Codex on one trusted machine.** Use the normal Codex CLI sign-in so you get a local `~/.codex/auth.json`. This becomes your starting canonical auth.
3. **Mint an API key from the dashboard.** Open `/admin/` (mTLS) and click **New Host**. Copy the one-time installer command (`curl …/install/{token} | bash`) or the API key itself.
4. **Seed the canonical auth.** On the trusted machine, either run the installer command or use the dashboard "Upload auth.json" to push your existing `~/.codex/auth.json` to the server.
5. **Install on other hosts.** For each host, generate a fresh installer token in the dashboard and run the provided `curl …/install/{token} | bash` command on that host. It installs `cdx`, grabs Codex, and embeds the API key/base URL directly into the wrapper.
6. **Clean up when a host is retired.** Use the dashboard "Remove" button or run `cdx --uninstall` on the host to delete binaries/configs and call `DELETE /auth`.

## Commands you'll actually type

On the **auth server host**:

- `cp .env.example .env`
- Edit `.env` and set `DB_*` (or use the defaults from `docker-compose.yml`). The container auto-seeds the wrapper from `bin/cdx`; bump `WRAPPER_VERSION` in that file when you change it, then rebuild/redeploy. `VERSION_ADMIN_KEY` remains optional for admin uploads but isn’t needed for routine updates.
- `docker compose up --build`

On your **laptop or admin box** (the one where you already use Codex):

- `codex login` (or whichever flow creates `~/.codex/auth.json`).
- Visit the admin dashboard (`/admin/`, mTLS) and click **New Host** to mint an API key + one-time installer command.
- Seed canonical auth from your trusted machine: use the dashboard "Upload auth.json" with your `~/.codex/auth.json`.
- Run the installer command on a target host (generate a fresh token per host).
- `cdx --uninstall` on a host to remove Codex bits and deregister it from the auth server (uses baked config).

## FAQ

- **Do I still need to log into Codex on every host?** No. Log in once on a trusted machine to create `~/.codex/auth.json`, then use the dashboard-generated installer commands for the rest of the fleet (and upload the canonical auth via the dashboard when it changes).
- **How do I rotate tokens or update `auth.json`?** Refresh `~/.codex/auth.json` on the trusted machine, then upload it through the dashboard (Upload auth.json) or let any host with a valid API key call `/auth` with `command: "store"` after the refresh.
- **What if my auth server uses a private CA or self-signed cert?** The CA path is baked into `cdx` when downloaded; ensure the dashboard upload is done from a host that trusts the CA or use your proxy to terminate TLS.
- **How do I remove a host cleanly?** Run `cdx --uninstall`; it deletes Codex bits on the target and calls `DELETE /auth` using the baked config.
- **Where is the host-side sync config stored?** Global installs use `/usr/local/etc/codex-sync.env`; user installs use `~/.codex/sync.env`. They contain only the sync base URL, API key, and optional CA path.

## Quick Start

```bash
cp .env.example .env          # set DB_* creds (match docker-compose)
docker compose up --build     # runs API on http://localhost:8488 with a mysql sidecar
```

### CLI helpers (bin/)

- `cdx --uninstall`: removes Codex binaries/configs, legacy sync env/auth files, npm `codex-cli`, and calls `DELETE /auth` with the baked API key.

For details on the optional runner container that validates `auth.json` using `cdx`, see `runner/README.md`.

### Lifecycle smoke test

Run a full host lifecycle against a running stack (register → installer download → baked wrapper → `/auth` → cleanup):

```bash
BASE_URL=http://localhost:8488 \
ADMIN_KEY=... \  # optional; required if DASHBOARD_ADMIN_KEY is set
tests/e2e-agent-lifecycle.sh
```

The script creates a temporary host and deletes it (unless `KEEP_HOST=1`). No canonical auth is modified; it only exercises registration, installer issuance, wrapper baking, and `/auth` retrieve.

### Routing

`public/index.php` now wires endpoints through a tiny `Router` (`src/Http/Router.php`) with a route table, so each path is handled in an isolated closure. Add new endpoints by registering a route near the top of `public/index.php` rather than extending the old nested `if` chain.

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
   - Configure the MySQL credentials via `DB_HOST/DB_PORT/DB_DATABASE/DB_USERNAME/DB_PASSWORD` (defaults line up with `docker-compose.yml`).
   - Optionally set `VERSION_ADMIN_KEY` to authorize `POST /versions` publishes and `DASHBOARD_ADMIN_KEY` for an extra header check on admin routes.

2. **Docker**
  - `docker compose up --build`
  - Services: `api` (PHP) and `mysql` (MySQL 8). Both join the `codex_auth` network.
  - API listens on `http://localhost:8488`.
  - MySQL data persists in `/var/docker_data/codex-auth.uggs.io/mysql_data` (bind-mounted one level above the repo); SQL exports and the SQLite migration backups live under `storage/sql` on your mounted storage path.
  - Optional runner sidecar is enabled by default (`AUTH_RUNNER_URL=http://auth-runner:8080/verify`); disable by clearing that env or removing the service from compose.
  - Admin dashboard routes live at `/admin/*`; they require mTLS (`X-mTLS-Present` header is set by your proxy) and optionally `DASHBOARD_ADMIN_KEY`.

3. **Local (optional)**
   - `composer install`
   - `php -S localhost:8080 -t public`
   - Ensure `storage/` is writable by PHP.

## API Reference

> Full, code-accurate contracts live in `interface-api.md`, `interface-db.md`, and `interface-cdx.md`. Highlights below stay in sync with those specs.

### Host provisioning (admin)

- `POST /admin/hosts/register` (mTLS + optional `DASHBOARD_ADMIN_KEY`) creates or rotates a host, returns its API key, and mints a single-use installer token.
- `GET /install/{token}` is public but the token is one-time and expires (controlled by `INSTALL_TOKEN_TTL_SECONDS`, default 1800s). Response is a bash script that installs `cdx`, downloads Codex, and writes `~/.codex/sync.env` with the baked API key, FQDN, and base URL. Tokens are marked used immediately after download.

### `POST /auth`

Single-call endpoint for both checking and updating auth. Every response includes the current versions block, so clients do not need to call `/versions`.

Body fields:
- `command`: `retrieve` (default) or `store`.
- `client_version`: optional but recommended (JSON or `client_version`/`cdx_version` query param); when omitted, the server records `unknown`.
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

### `POST /usage`

Token-usage reporting endpoint. The `cdx` wrapper automatically parses Codex “Token usage: …” lines after each run and posts a compact summary here for the current host.

Body fields (all optional, but at least one of `line` or a numeric field is required):
- `line`: raw usage line from Codex (for example `Token usage: total=985 input=969 (+ 6,912 cached) output=16`).
- `total`, `input`, `output`: integer token counts.
- `cached`: integer count of cached tokens, when present.
- `model`: Codex model identifier, if available.

Responses return the recorded values plus a timestamp and `host_id`, which feed the token-usage aggregates shown in the admin dashboard.

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
  - `POST /admin/hosts/{id}/clear`: clear the stored IP and recent digests for a host so the next `/auth` call can re-bind cleanly.
  - `POST /admin/hosts/{id}/roaming`: toggle whether a host is allowed to roam across IPs without being blocked.
  - `POST /admin/hosts/register`: create or rotate a host and mint a single-use installer token (used by the dashboard “New Host” button).
  - `GET /admin/api/state`: read whether `/auth` is currently disabled.
  - `POST /admin/api/state`: toggle the `api_disabled` flag that makes `/auth` return `503 API disabled by administrator`.
  - `GET /admin/logs?limit=50&host_id=`: recent audit entries.
- A basic dashboard lives at `/admin/` (served by this container); it calls the endpoints above and will only work when mTLS is presented.

## Data & Logging

- **hosts**: FQDN, API key, status, last refresh time, canonical digest, IP binding, latest `client_version`, optional `wrapper_version`, roaming flag, and API call counts.
- **auth_payloads** / **auth_entries**: canonical `auth.json` snapshots plus per-target token entries; the canonical payload is what `/auth` uses for digests and hydration.
- **host_auth_states** / **host_auth_digests**: last-seen canonical payload per host and up to three recent digests for quick matching.
- **token_usages**: per-host token usage rows created by `/usage`, used for aggregates in the admin views.
- **logs**: registration/auth/usage/version/admin events with timestamps and a JSON details blob.
- All data is stored in MySQL (configured via `DB_*`). The default compose file runs a `mysql` service with data under `/var/docker_data/codex-auth.uggs.io/mysql_data`; use `storage/sql` for exports/backups or one-off imports during migrations.

Access logs manually with `docker compose exec mysql mysql -u"$DB_USERNAME" -p"$DB_PASSWORD" "$DB_DATABASE" -e "SELECT * FROM logs ORDER BY created_at DESC LIMIT 10;"`.

## Host Status Report

The legacy `host-status.txt` export has been removed; use the admin dashboard (`/admin/overview` and `/admin/hosts`) for current status.

## Notes

- Host-facing APIs require a valid API key; installer downloads are guarded by single-use tokens minted from the dashboard and bake the API key into `cdx`.
- Hosts that have not checked in for 30 days are automatically pruned and must be re-created.
- Uninstallers should call `DELETE /auth` (handled automatically by `cdx --uninstall`) to remove the host record cleanly.
- The server normalizes timestamps with fractional seconds, so Codex-style values such as `2025-11-19T09:27:43.373506211Z` compare correctly.
- API keys are IP-bound after the first successful authenticated call; use `POST /admin/hosts/{id}/roaming` or mint a new host/API key to move a host cleanly.
- When the admin toggle marks the API as disabled (`/admin/api/state`), `POST /auth` returns `503 API disabled by administrator` and the `cdx` wrapper refuses to start Codex until the flag is cleared.
- Extendable: add admin/reporting endpoints by introducing more routes in `public/index.php` and new repository methods.
- Refer to `AGENTS.md` when you need a walkthrough of how each class collaborates within the request pipeline.
