# Codex Auth Central API

🔒 Keep one canonical Codex `auth.json` for your whole fleet. 🚀 Mint per-host API keys from the dashboard, bake them into the `cdx` wrapper, and let hosts pull/push auth + usage with a single call.

![cdx wrapper baking a host-specific installer and syncing auth](docs/img/cdx.png)

## Why you might like it

- 🌐 One `/auth` flow to keep every host in sync (retrieve/store with version metadata).
- 🗝️ Per-host API keys, IP-bound on first contact; single-use installer tokens bake config into `cdx`.
- 📊 Auditing and usage: token usage, versions, IPs, and runner validation logs.
- 🔒 Canonical auth + tokens encrypted at rest (libsodium).
- 🧠 Extras: slash-command distribution, ChatGPT quota snapshots, and daily pricing pulls for cost dashboards.

## See it in action

- **Dashboard overview** — track host health, latest digests, versions, and API usage at a glance.
- **Host detail** — inspect canonical auth digests, recent validations, and roaming status per host.
- **Token usage** — visualize per-host token consumption (total/input/output/cached/reasoning) for billing or investigations.

![Admin dashboard overview screen](docs/img/dashboard_1.png)

![Per-host digests and validation logs](docs/img/dashboard_2.png)

![Token usage aggregates and recent activity](docs/img/dashboard_3.png)

## Get going fast

```bash
cp .env.example .env          # set DB_* creds (match docker-compose)
docker compose up --build     # API on http://localhost:8488 with MySQL sidecar
```

No external proxy? Enable the bundled Caddy TLS/mTLS frontend (serves 443, optional LE or custom cert): `docker compose --profile caddy up --build -d` after setting the `CADDY_*` vars. Details: `docs/INSTALL.md`.

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

- `POST /admin/hosts/register` (mTLS on by default; optional `DASHBOARD_ADMIN_KEY`) creates or rotates a host, returns its API key, and mints a single-use installer token. Set `ADMIN_REQUIRE_MTLS=0` if another gate protects `/admin`.
- `GET /install/{token}` is public but the token is one-time and expires (controlled by `INSTALL_TOKEN_TTL_SECONDS`, default 1800s). Response is a bash script that installs `cdx`, downloads Codex, and bakes the API key/FQDN/base URL directly into the wrapper. Tokens are marked used immediately after download.

### `POST /auth`

Single-call endpoint for both checking and updating auth. Responses always include:
- `versions` (cached GitHub client version, baked wrapper version + sha, runner telemetry).
- Host stats (`api_calls`, `token_usage_month`) and `quota_hard_fail`.
- Latest `chatgpt_usage` window summary when a canonical token is available.

Body fields:
- `command`: `retrieve` (default) or `store`.
- `client_version`: optional but recommended (JSON or `client_version`/`cdx_version` query param); when omitted, the server records `unknown`.
- `wrapper_version`: ignored; the server always reports the baked wrapper version.
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

IP binding + roaming: the first successful call locks the host to that source IP; future calls from another IP 403 unless `allow_roaming_ips` is enabled or `DELETE /auth?force=1` is used.  
Insecure hosts (`secure = false`) are blocked by default; an admin must open a 10‑minute sliding allow window (`/admin/hosts/{id}/insecure/enable`). Each call extends the window; a 60‑minute grace period allows final `store` uploads after disabling.

Auth payload fallbacks: if `auths` is missing/empty but `tokens.access_token` or `OPENAI_API_KEY` exists, the server synthesizes `auths = {"api.openai.com": {"token": <access_token>}}` before validation (still enforces token quality and timestamp rules). Global + auth-failure rate limits are enforced for non-admin routes (`RATE_LIMIT_GLOBAL_*`, `RATE_LIMIT_AUTH_FAIL_*`).

### `POST /usage`

Token-usage reporting endpoint. The `cdx` wrapper automatically parses **all** Codex “Token usage: …” lines (including reasoning tokens when present) after each run and posts them to the API for the current host.

Body options (at least one of `line` or a numeric field per usage is required):
- `usages`: array of usage entries to record in one call.
- Single-entry compatibility: `line`, `total`, `input`, `output`, `cached`, `reasoning`, `model` at the top level.
- Usage entry fields: `line` (raw usage line), numeric `total`/`input`/`output`, optional `cached`, optional `reasoning`, optional `model`.

Responses include `recorded` (count) and an array of recorded usages with timestamps and `host_id`, which feed the token-usage aggregates shown in the admin dashboard.

### Slash commands (hosts)

- `GET /slash-commands` — list server-published slash command prompts (filenames, sha256, description, argument hint, deleted marker).
- `POST /slash-commands/retrieve` — body: `filename` and optional `sha256`; returns `status` (`missing` | `deleted` | `unchanged` | `updated`) plus prompt when changed.
- `POST /slash-commands/store` — hosts can publish/update prompts (body: `filename`, `prompt` or `content`, optional `description`/`argument_hint`/`sha256`).

### Host user telemetry

- `POST /host/users` — record the current system user + hostname to surface active users per host in the admin dashboard.

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

### Admin (mTLS when enabled)

- `/admin/*` routes require an mTLS client certificate (Caddy forwards `X-mTLS-Present`) while `ADMIN_REQUIRE_MTLS=1` (default). Set `ADMIN_REQUIRE_MTLS=0` to rely on another control such as VPN/firewall and/or `DASHBOARD_ADMIN_KEY`.
- If `DASHBOARD_ADMIN_KEY` is set, the admin key must also be provided on admin routes.
- Endpoints:
  - `GET /admin/overview`: versions, host counts, average refresh age, latest log timestamp, token totals, mTLS metadata.
  - `GET /admin/hosts`: list hosts with canonical digest, recent digests, client versions, API call counts, IP, roaming/secure flags, latest token usage, users.
  - `POST /admin/hosts/register`: create or rotate a host and mint a single-use installer token (used by the dashboard “New Host” button).
  - `GET /admin/hosts/{id}/auth`: canonical digest/last_refresh (optionally include auth body with `?include_body=1`), recent digests, last-seen timestamp.
  - `DELETE /admin/hosts/{id}` / `POST /admin/hosts/{id}/clear`: delete a host or just reset its canonical auth state.
  - `POST /admin/hosts/{id}/roaming`: toggle roaming IPs. `POST /admin/hosts/{id}/secure` flips secure/insecure mode; `POST /admin/hosts/{id}/insecure/enable|disable` controls the 10‑minute insecure window (with 60‑minute store-only grace).
  - `POST /admin/auth/upload`: upload a canonical auth JSON (body or `file`); omit `host_id` (or set `0`/`"system"`) to keep it un-attributed, or provide a host id to tag it.
  - `GET /admin/api/state` / `POST /admin/api/state`: read/set `api_disabled` flag (503 kill switch except for this endpoint).
  - `GET /admin/quota-mode` / `POST /admin/quota-mode`: toggle `hard_fail` behavior when ChatGPT quota is exhausted.
  - `GET /admin/runner` / `POST /admin/runner/run`: runner config, recent validation/runner_store logs, and manual refresh trigger.
  - `POST /admin/versions/check`: refresh cached GitHub client version on demand.
  - `GET /admin/chatgpt/usage[?force=1]`, `GET /admin/chatgpt/usage/history?days=60`, `POST /admin/chatgpt/usage/refresh`: fetch/cache ChatGPT `/wham/usage` snapshot and history (5-minute cooldown unless forced).
  - `GET /admin/slash-commands`, `GET /admin/slash-commands/{filename}`, `POST /admin/slash-commands/store`, `DELETE /admin/slash-commands/{filename}`: manage shared slash-command prompts.
  - `GET /admin/logs?limit=50&host_id=`: recent audit entries.
  - `GET /admin/usage?limit=50` and `GET /admin/tokens?limit=50`: recent usage rows and token aggregates.
- A basic dashboard lives at `/admin/` (served by this container); it calls the endpoints above and shows mTLS status. Keep mTLS enabled or protect the path another way when you disable it.

## Data & Logging

- **hosts** / **install_tokens**: per-host metadata (secure/roaming flags, IP binding, API calls, versions) plus single-use installer tokens and their expiry/base URL.
- **auth_payloads** / **auth_entries**: canonical `auth.json` snapshots plus per-target token entries; the canonical payload is what `/auth` uses for digests and hydration.
- **host_auth_states** / **host_auth_digests**: last-seen canonical payload per host and up to three recent digests for quick matching.
- **slash_commands**: shared prompt bodies with metadata (description, argument hint, deleted flag, source host).
- **host_users**: last-seen usernames/hostnames reported by `/host/users` for per-host user lists.
- **token_usages**: per-host token usage rows created by `/usage`, including reasoning tokens, used for aggregates in the admin views.
- **chatgpt_usage_snapshots**: host-agnostic ChatGPT usage snapshots (plan, rate-limit windows, credits, raw body) refreshed at most every 5 minutes.
- **pricing_snapshots**: pricing for GPT-5.1 (input/output/cached per 1k, currency, source URL/raw, timestamps) refreshed daily.
- **ip_rate_limits**: rolling counters for global/auth-fail rate limiting.
- **logs** / **versions**: audit trail plus cached version/flag metadata (runner state, api_disabled, quota_hard_fail, canonical payload pointer).
- All data is stored in MySQL (configured via `DB_*`). The default compose file runs a `mysql` service with data under `/var/docker_data/codex-auth.example.com/mysql_data`; use `storage/sql` for exports/backups or one-off imports during migrations.
- A `quota-cron` sidecar in `docker-compose.yml` runs `scripts/refresh-chatgpt-usage.php` on a timer (default hourly) to keep ChatGPT quota snapshots warm even when no hosts are calling `/auth`; set `CHATGPT_USAGE_CRON_INTERVAL` (seconds) to adjust the cadence.

Access logs manually with `docker compose exec mysql mysql -u"$DB_USERNAME" -p"$DB_PASSWORD" "$DB_DATABASE" -e "SELECT * FROM logs ORDER BY created_at DESC LIMIT 10;"`.

## Host Status Report

The legacy `host-status.txt` export has been removed; use the admin dashboard (`/admin/overview` and `/admin/hosts`) for current status.

## Notes

- Host-facing APIs require a valid API key; installer downloads are guarded by single-use tokens minted from the dashboard and bake the API key into `cdx`.
- Hosts that have not checked in for 30 days are automatically pruned and must be re-created.
- Uninstallers should call `DELETE /auth` (handled automatically by `cdx --uninstall`) to remove the host record cleanly.
- The server normalizes timestamps with fractional seconds, so Codex-style values such as `2025-11-19T09:27:43.373506211Z` compare correctly.
- API keys are IP-bound after the first successful authenticated call; use `POST /admin/hosts/{id}/roaming` or mint a new host/API key to move a host cleanly. Global and auth-fail rate limits are configurable (`RATE_LIMIT_GLOBAL_*`, `RATE_LIMIT_AUTH_FAIL_*`); admin routes are exempt.
- Insecure hosts are blocked until an admin opens the 10-minute allow window; each call extends it, and a 60-minute grace period allows final `store` uploads after disabling.
- Auth payload validation synthesizes `auths` from `tokens.access_token` / `OPENAI_API_KEY` when missing, then sorts them; tokens must pass quality checks (`TOKEN_MIN_LENGTH` env, no whitespace/placeholder/low-entropy values).
- `/admin/api/state` stores a global kill-switch flag; when enabled the API returns HTTP 503 for all routes except `/admin/api/state` (so it can be cleared). Runner and GitHub version refresh run once per UTC day (or on demand), with backoff/recovery if the runner is failing.
- Extendable: add admin/reporting endpoints by introducing more routes in `public/index.php` and new repository methods.
- Refer to `AGENTS.md` when you need a walkthrough of how each class collaborates within the request pipeline.
