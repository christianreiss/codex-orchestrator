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
- Canonical `auth.json` payloads and per-target tokens are stored encrypted-at-rest with libsodium `secretbox`; the symmetric key is auto-generated into `.env` on first boot.
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
- Edit `.env` and set `DB_*` (or use the defaults from `docker-compose.yml`). The container auto-seeds the wrapper from `bin/cdx` only on first boot; to roll a new wrapper, rebuild the image or replace the baked script in storage before start-up.
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
   - Configure the MySQL credentials via `DB_HOST/DB_PORT/DB_DATABASE/DB_USERNAME/DB_PASSWORD` (defaults line up with `docker-compose.yml`). `AUTH_ENCRYPTION_KEY` is optional; a new secretbox key will be written into `.env` automatically when missing.
   - Optionally set `DASHBOARD_ADMIN_KEY` for an extra header check on admin routes.

2. **Docker**
  - `docker compose up --build`
  - Services: `api` (PHP) and `mysql` (MySQL 8). Both join the `codex_auth` network.
  - API listens on `http://localhost:8488`.
- MySQL data persists in `/var/docker_data/codex-auth.example.com/mysql_data` (bind-mounted one level above the repo); SQL exports and the SQLite migration backups live under `storage/sql` on your mounted storage path.
  - Optional runner sidecar is enabled by default (`AUTH_RUNNER_URL=http://auth-runner:8080/verify`); disable by clearing that env or removing the service from compose.
  - Admin dashboard routes live at `/admin/*`; they require mTLS (`X-mTLS-Present` header is set by your proxy) and optionally `DASHBOARD_ADMIN_KEY`.

3. **Local (optional)**
   - `composer install`
   - `php -S localhost:8080 -t public`
   - Ensure `storage/` is writable by PHP.

## API Reference

> Full, code-accurate contracts live in `docs/interface-api.md`, `docs/interface-db.md`, and `docs/interface-cdx.md`. Highlights below stay in sync with those specs.

### Host provisioning (admin)

- `POST /admin/hosts/register` (mTLS + optional `DASHBOARD_ADMIN_KEY`) creates or rotates a host, returns its API key, and mints a single-use installer token.
- `GET /install/{token}` is public but the token is one-time and expires (controlled by `INSTALL_TOKEN_TTL_SECONDS`, default 1800s). Response is a bash script that installs `cdx`, downloads Codex, and writes `~/.codex/sync.env` with the baked API key, FQDN, and base URL. Tokens are marked used immediately after download.

### `POST /auth`

Single-call endpoint for both checking and updating auth. Every response includes the current versions block, so clients do not need to call `/versions`.

Body fields:
- `command`: `retrieve` (default) or `store`.
- `client_version`: optional but recommended (JSON or `client_version`/`cdx_version` query param); when omitted, the server records `unknown`.
- `digest`: required for `retrieve`; the client’s current SHA-256 auth digest (hash of the exact JSON).
- `last_refresh`: required for `retrieve`.
- `auth`: required for `store`; must include `last_refresh`. The server preserves every top-level field (e.g., `tokens`, `OPENAI_API_KEY`, custom metadata), normalizes only the `auths` map, and stores the resulting compact JSON blob; responses return that same canonical JSON.
- `wrapper_version` values sent by clients are ignored; the server always reports the version baked into its own wrapper.

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

Token-usage reporting endpoint. The `cdx` wrapper automatically parses **all** Codex “Token usage: …” lines (including reasoning tokens when present) after each run and posts them to the API for the current host.

Body options (at least one of `line` or a numeric field per usage is required):
- `usages`: array of usage entries to record in one call.
- Single-entry compatibility: `line`, `total`, `input`, `output`, `cached`, `reasoning`, `model` at the top level.
- Usage entry fields: `line` (raw usage line), numeric `total`/`input`/`output`, optional `cached`, optional `reasoning`, optional `model`.

Responses include `recorded` (count) and an array of recorded usages with timestamps and `host_id`, which feed the token-usage aggregates shown in the admin dashboard.

### `DELETE /auth`

Self-service deregistration for the calling host (identified by API key + IP binding). Removes the host row and its cached digests, returning `{ "deleted": "<fqdn>" }`.

### `GET /wrapper` and `GET /wrapper/download`

Both require the same API key + IP binding as `/auth`. `/wrapper` returns metadata (version, sha256, size, download URL); `/wrapper/download` streams the latest cdx wrapper script with `X-SHA256` and `ETag` headers. Only the latest wrapper copy is retained. Admin wrapper uploads are removed—update the wrapper by rebuilding the image (or swapping the stored file before boot).

### `GET /versions`

Optional (primarily for ops). Returns the cached Codex CLI version (fetched from GitHub when stale) and the wrapper version derived from the baked script on the server. `/auth` already embeds the same structure in its responses.

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
    "wrapper_version": "2025.11.24-9",
    "wrapper_sha256": "…",
    "wrapper_url": "/wrapper/download",
    "reported_client_version": "0.60.1"
  }
}
```

Notes:
- The server refreshes `client_version` from the GitHub “latest release” endpoint when the cache is older than **3 hours**, falling back to the last cached value on failure.
- The `wrapper_version` is read directly from the server’s baked wrapper script; client-reported values and admin overrides are ignored.

### Admin (mTLS-only)

- `/admin/*` routes require an mTLS client certificate; requests without one are rejected (Caddy forwards `X-mTLS-Present`).
- If `DASHBOARD_ADMIN_KEY` is set, the admin key must also be provided on admin routes.
- Endpoints:
  - `GET /admin/overview`: versions, host counts, average refresh age, latest log timestamp, token totals, mTLS metadata.
  - `GET /admin/hosts`: list hosts with canonical digest, recent digests, client/wrapper versions, API call counts, IP, roaming flag, latest token usage.
  - `POST /admin/hosts/register`: create or rotate a host and mint a single-use installer token (used by the dashboard “New Host” button).
  - `GET /admin/hosts/{id}/auth`: canonical digest/last_refresh (optionally include auth body with `?include_body=1`), recent digests, last-seen timestamp.
  - `DELETE /admin/hosts/{id}`: remove a host and its digests.
  - `POST /admin/hosts/{id}/clear`: clears canonical auth state for the host (nulls `last_refresh`/`auth_digest`, deletes `host_auth_states`, prunes recent digests) without deleting the host.
  - `POST /admin/hosts/{id}/roaming`: toggle whether a host is allowed to roam across IPs without being blocked.
  - `POST /admin/auth/upload`: upload a canonical auth JSON (body or `file`); omit `host_id` (or set `0`/`"system"`) to keep it un-attributed, or provide a host id to tag it.
  - `GET /admin/api/state` / `POST /admin/api/state`: read/set `api_disabled` flag (persisted only; `/auth` does not check it yet).
  - `GET /admin/runner`: runner config + recent validation/runner_store logs.
  - `POST /admin/runner/run`: force a runner validation against current canonical auth; applies runner-updated auth when newer.
  - `GET /admin/logs?limit=50&host_id=`: recent audit entries.
  - `GET /admin/usage?limit=50` and `GET /admin/tokens?limit=50`: recent usage rows and token aggregates.
- A basic dashboard lives at `/admin/` (served by this container); it calls the endpoints above and will only work when mTLS is presented.
  - `GET /admin/chatgpt/usage[?force=1]` and `POST /admin/chatgpt/usage/refresh`: fetch/cache the account-level ChatGPT `/wham/usage` snapshot (plan, rate windows, credits) using the canonical `auth.json` token; 5-minute cooldown unless forced.

## Data & Logging

- **hosts**: FQDN, API key, status, last refresh time, canonical digest, IP binding, latest `client_version`, roaming flag, and API call counts. `wrapper_version` is no longer recorded from clients and will generally be `NULL`.
- **auth_payloads** / **auth_entries**: canonical `auth.json` snapshots plus per-target token entries; the canonical payload is what `/auth` uses for digests and hydration.
- **host_auth_states** / **host_auth_digests**: last-seen canonical payload per host and up to three recent digests for quick matching.
- **token_usages**: per-host token usage rows created by `/usage`, used for aggregates in the admin views.
- **chatgpt_usage_snapshots**: host-agnostic ChatGPT usage snapshots (plan, rate-limit windows, credits, raw body) refreshed at most every 5 minutes.
- **pricing_snapshots**: pricing for GPT-5.1 (input/output/cached per 1k, currency, source URL/raw, timestamps) refreshed daily.
- **logs**: registration/auth/usage/version/admin events with timestamps and a JSON details blob.
- All data is stored in MySQL (configured via `DB_*`). The default compose file runs a `mysql` service with data under `/var/docker_data/codex-auth.example.com/mysql_data`; use `storage/sql` for exports/backups or one-off imports during migrations.

Access logs manually with `docker compose exec mysql mysql -u"$DB_USERNAME" -p"$DB_PASSWORD" "$DB_DATABASE" -e "SELECT * FROM logs ORDER BY created_at DESC LIMIT 10;"`.

## Host Status Report

The legacy `host-status.txt` export has been removed; use the admin dashboard (`/admin/overview` and `/admin/hosts`) for current status.

## Notes

- Host-facing APIs require a valid API key; installer downloads are guarded by single-use tokens minted from the dashboard and bake the API key into `cdx`.
- Hosts that have not checked in for 30 days are automatically pruned and must be re-created.
- Uninstallers should call `DELETE /auth` (handled automatically by `cdx --uninstall`) to remove the host record cleanly.
- The server normalizes timestamps with fractional seconds, so Codex-style values such as `2025-11-19T09:27:43.373506211Z` compare correctly.
- API keys are IP-bound after the first successful authenticated call; use `POST /admin/hosts/{id}/roaming` or mint a new host/API key to move a host cleanly.
- Auth payload validation synthesizes `auths` from `tokens.access_token` / `OPENAI_API_KEY` when missing, then sorts them; tokens must pass quality checks (`TOKEN_MIN_LENGTH` env, no whitespace/placeholder/low-entropy values).
- `/admin/api/state` only stores a flag today; `/auth` does not enforce it. Add a guard if you need a kill-switch.
- Extendable: add admin/reporting endpoints by introducing more routes in `public/index.php` and new repository methods.
- Refer to `AGENTS.md` when you need a walkthrough of how each class collaborates within the request pipeline.
