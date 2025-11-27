# Codex Auth Central API

🔒 Keep one canonical Codex `auth.json` for your whole fleet. 🚀 Mint per-host API keys from the dashboard, bake them into the `cdx` wrapper, and let hosts pull/push auth + usage with a single call.

## Why you might like it

- 🌐 One `/auth` flow to keep every host in sync (retrieve/store with version metadata).
- 🗝️ Per-host API keys, IP-bound on first contact; single-use installer tokens bake config into `cdx`.
- 📊 Auditing and usage: token usage, versions, IPs, and runner validation logs.
- 🔒 Canonical auth + tokens encrypted at rest (libsodium).

## Get going fast

```bash
cp .env.example .env          # set DB_* creds (match docker-compose)
docker compose up --build     # API on http://localhost:8488 with MySQL sidecar
```

📖 Full setup (mTLS/proxy, env, volumes): `docs/INSTALL.md`  
🧭 Deep dive / FAQs / flow: `docs/OVERVIEW.md`  
🛡️ Security policy: `docs/SECURITY.md`  
🧪 Interface contracts: `docs/interface-api.md`, `docs/interface-cdx.md`, `docs/interface-db.md`

## Contributing / local dev

- `composer install`
- `php -S localhost:8080 -t public`
- Ensure `storage/` is writable by PHP.

## API Reference

> Full, code-accurate contracts live in `docs/interface-api.md`, `docs/interface-db.md`, and `docs/interface-cdx.md`. Highlights below stay in sync with those specs.

### Host provisioning (admin)

- `POST /admin/hosts/register` (mTLS + optional `DASHBOARD_ADMIN_KEY`) creates or rotates a host, returns its API key, and mints a single-use installer token.
- `GET /install/{token}` is public but the token is one-time and expires (controlled by `INSTALL_TOKEN_TTL_SECONDS`, default 1800s). Response is a bash script that installs `cdx`, downloads Codex, and bakes the API key/FQDN/base URL directly into the wrapper. Tokens are marked used immediately after download.

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
  - `GET /admin/api/state` / `POST /admin/api/state`: read/set `api_disabled` flag (when true, all API routes return 503; `/admin/api/state` remains accessible so the flag can be cleared).
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
- `/admin/api/state` stores a global kill-switch flag; when enabled the API returns HTTP 503 for all routes except `/admin/api/state` (so it can be cleared).
- Extendable: add admin/reporting endpoints by introducing more routes in `public/index.php` and new repository methods.
- Refer to `AGENTS.md` when you need a walkthrough of how each class collaborates within the request pipeline.
