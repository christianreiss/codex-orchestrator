# Codex Auth Central API

Base URL: `https://codex-auth.uggs.io`

All responses are JSON unless noted. Request bodies must be `application/json` unless otherwise stated.
The front controller (`public/index.php`) dispatches requests via a small route table (`src/Http/Router.php`), so each path below maps to a single handler.

## Authentication

- Hosts are provisioned via the admin dashboard: `POST /admin/hosts/register` (mTLS + optional `DASHBOARD_ADMIN_KEY`) returns a host API key and a single-use installer token.
- Host endpoints (`/auth`, `/usage`, `/wrapper*`, `DELETE /auth`) require the per-host API key via either:
  - `X-API-Key: <key>`
  - `Authorization: Bearer <key>`
- IP binding: the first successful auth stores the caller IP. Later calls from a different IP return `403` unless the host has `allow_roaming_ips` (admin toggle) or `DELETE /auth?force=1` is used during uninstall. The stored IP is updated (and logged) on allowed moves.
- Wrapper metadata/downloads use the same API key + IP binding; the installer script is the only public artifact and is guarded by a one-time token.
- Admin API toggle (`/admin/api/state`) persists a flag but is not currently enforced by `/auth`—add a guard if you need a kill-switch.

Errors return:

```json
{ "status": "error", "message": "Invalid API key" }
```

## Endpoints

### Host provisioning (admin)

- `POST /admin/hosts/register` (mTLS + optional `DASHBOARD_ADMIN_KEY`) creates or rotates a host, returning its API key and a single-use installer token. Expired/used tokens are pruned on each call. Base URL comes from request headers or `PUBLIC_BASE_URL`; call fails if a usable base cannot be determined.
- `GET /install/{token}` is public but token-gated and expires after `INSTALL_TOKEN_TTL_SECONDS` (default 1800s). The handler marks the token used before emitting the script. The bash installer:
  - Downloads the latest stored `cdx` wrapper (`/wrapper/download`) baked with the host’s API key, base URL, FQDN, and wrapper version.
  - Detects arch, fetches Codex CLI from GitHub (falls back to `0.63.0` when server has no published version), and installs to `/usr/local/bin` or `$HOME/.local/bin`.
  - Prints progress and exits non-zero on failure. Tokens cannot be reused.

### `POST /auth` (single-call sync)

Unified endpoint for both checking and updating auth. Each response includes the versions block, so no separate `/versions` request is needed.

**Required auth**: API key header.

**Body fields**

- `command`: `retrieve` (default) or `store`.
- `client_version`: optional (JSON or query param `client_version`/`cdx_version`); when omitted the server records `unknown`.
- `wrapper_version`: optional (JSON or query param `wrapper_version`/`cdx_wrapper_version`).
- `digest`: required for `retrieve`; the client’s current auth SHA-256 (digest of the exact JSON sent to Codex).
- `last_refresh`: required when `command` is `retrieve`; must be RFC3339, not in the future (>300s skew), and not before `2000-01-01T00:00:00Z`.
- `auth`: required when `command` is `store`; must include `last_refresh` (same rules). `auths` must contain at least one entry; if missing/empty but `tokens.access_token` or `OPENAI_API_KEY` is present, the server synthesizes `auths = {"api.openai.com": {"token": <access_token>}}` before validation. Tokens are rejected when too short (`TOKEN_MIN_LENGTH`, default 24), low-entropy, placeholder, or containing whitespace.
  - All other top-level fields inside `auth` (for example `tokens`, `OPENAI_API_KEY`, or custom metadata) are preserved verbatim; only the `auths` map is normalized/sorted for consistency.

The service stores the canonical auth JSON plus an `auth_digest` and keeps the last 3 canonical digests per host (`host_auth_digests`).

**Retrieve statuses**

- `valid`: submitted digest matches canonical; no auth JSON returned.
- `outdated`: server has newer auth; response includes `auth`, canonical digest, and versions.
- `upload_required`: client claims a newer payload (`last_refresh` later than canonical); caller should resend with `command: "store"` and include `auth`.
- `missing`: server does not yet have a canonical payload; caller should send `command: "store"`.

**Store responses**

- `updated`: incoming `last_refresh` is newer (or canonical missing/different digest); server stores the payload and returns canonical `auth`, digest, versions, and host metadata.
- `unchanged`: timestamps match; returns canonical digest and versions only.
- `outdated`: server already has a newer copy; returns canonical `auth`, digest, and versions so the client can hydrate.

**Runner validation**

When `AUTH_RUNNER_URL` is configured, the server:
- Runs the runner once per UTC day during `retrieve` to validate the current canonical auth (logs `auth.validate`).
- Runs it again after `store`; if the runner returns `updated_auth` with a newer/different digest, the server saves that payload and sets `runner_applied: true` in the response.
- Manual run: `POST /admin/runner/run`.

### `POST /usage` (token usage reporting)

Allows a host to send the Codex CLI token-usage line after a run. Uses the same API key + IP binding as `/auth`.

**Required auth**: API key header.

**Body fields**

- `line` (optional string): raw usage line (e.g., `Token usage: total=985 input=969 (+ 6,912 cached) output=16`).
- `total`, `input`, `output` (optional integers): parsed token counts.
- `cached` (optional integer): cached tokens count when present.
- `model` (optional string): Codex model name, if available.

At least one of `line` or a numeric field must be provided. The payload is stored as a log entry (`token.usage`) for the calling host.

**Example**

```http
POST /usage HTTP/1.1
X-API-Key: 8a63...f0
Content-Type: application/json

{
  "line": "Token usage: total=985 input=969 (+ 6,912 cached) output=16",
  "total": 985,
  "input": 969,
  "cached": 6912,
  "output": 16
}
```

**Response**

```json
{
  "status": "ok",
  "data": {
    "host_id": 12,
    "recorded_at": "2025-11-20T20:40:00Z",
    "line": "Token usage: total=985 input=969 (+ 6,912 cached) output=16",
    "total": 985,
    "input": 969,
    "cached": 6912,
    "output": 16
  }
}
```

### `DELETE /auth` (deregister host)

Removes the calling host (identified by its API key) from the orchestrator. Intended for uninstall flows.

**Required auth**: API key header. IP binding is enforced (same behavior as `/auth`).

**Success**

```json
{ "status": "ok", "data": { "deleted": "ci01.example.net" } }
```

If the host record does not exist or the API key is invalid, the response is `401 Invalid API key` or `403 Host is disabled`.

### `GET /install/{token}` (one-time installer)

Public, single-use endpoint that returns a self-contained bash installer for a pre-registered host. Tokens are minted by operators (see `/admin/hosts/register`), expire after `INSTALL_TOKEN_TTL_SECONDS` (default: 1800 seconds), and are invalidated on first download.

```
curl -fsSL https://codex-auth.uggs.io/install/3b1a8c21-fa4e-4191-9670-f508eeb0b292 | bash
```

Response: `text/plain` shell script that bakes `BASE_URL`, `API_KEY`, and `FQDN` into the downloaded wrapper and installs the wrapper + Codex binary. Errors emit a short shell snippet that prints the failure and exits non-zero.

### `GET /wrapper`

Returns metadata about the latest cdx wrapper, baked for the calling host (per-host hash). Requires the per-host API key; IP binding enforced.

```json
{
  "status": "ok",
  "data": {
    "version": "2025.11.19-4",
    "sha256": "…",
    "size_bytes": 12345,
    "updated_at": "2025-11-20T10:00:00Z",
    "url": "/wrapper/download"
  }
}
```

### `GET /wrapper/download`

Downloads the current cdx wrapper script already baked with the caller's API key, base URL, and FQDN. Requires the per-host API key; IP binding enforced. Response headers include `X-SHA256` and `ETag` for hash verification (per-host hash).

### `POST /wrapper` (admin)

Publishes/replaces the wrapper without rebuilding the image. Requires `VERSION_ADMIN_KEY` and `multipart/form-data`:

- `file` (required): wrapper script.
- `version` (required): version string to publish.
- `sha256` (optional): hash to verify before accepting.

Only the latest wrapper is kept; this updates metadata used by `/auth` and `/versions`.

### `GET /versions` (optional)

Provided for observability; clients do not need it because `/auth` responses already include the same block. `client_version` prefers the published override (`versions.client`); otherwise it uses the cached GitHub “latest release” value (3h TTL), falling back to a stale cache if GitHub is unreachable. `wrapper_version` is chosen as the highest of the stored wrapper metadata, any operator-published value, or the highest wrapper reported by a host (the first report seeds `versions.wrapper` when none exists).

```json
{
  "status": "ok",
  "data": {
    "client_version": "0.60.1",
    "client_version_checked_at": "2025-11-20T09:00:00Z",
    "client_version_source": "published",
    "wrapper_version": "2025.11.19-4",
    "wrapper_sha256": "…",
    "wrapper_url": "/wrapper/download",
    "reported_client_version": "0.60.1",
    "reported_wrapper_version": "2025.11.19-4"
  }
}
```

### `POST /versions` (admin)

Publishes operator versions. Requires `VERSION_ADMIN_KEY` (via `X-Admin-Key`, `Authorization: Bearer`, or `admin_key` query). Body accepts `client_version` and/or `wrapper_version`. Response mirrors `GET /versions`.

## Logs & Housekeeping

- Every `register`, `auth` retrieve/store, runner validation, token usage, and version publish is logged in `logs` (JSON details).
- Canonical auth is stored as a compact body in `auth_payloads.body` plus per-target rows in `auth_entries`; `host_auth_states` tracks the last canonical payload per host; `host_auth_digests` keeps the last 3 digests per host.
- Hosts inactive for 30 days are pruned during auth/register (logged as `host.pruned`).

## Admin (mTLS-only)

- `/admin/*` requires an mTLS client certificate (Caddy forwards `X-mTLS-Present`; requests without it are rejected).
- If `DASHBOARD_ADMIN_KEY` is set, include it via `X-Admin-Key`/Bearer/query (same as `/versions`).
- Endpoints:
  - `GET /admin/overview`: versions, host counts, avg refresh age, latest log timestamp, mTLS metadata, token aggregates.
  - `GET /admin/hosts`: hosts with canonical digest, recent digests, client/wrapper versions, API call counts, IP, roaming flag, and latest token usage.
  - `POST /admin/hosts/register`: mint a host + single-use installer token for a given FQDN. Response includes `installer.url`, `installer.command` (`curl …/install/{token} | bash`), and `installer.expires_at` (TTL default 1800s).
  - `GET /admin/hosts/{id}/auth`: canonical digest/last_refresh (optionally include `auth` body with `?include_body=1`), recent digests, last seen timestamp.
  - `DELETE /admin/hosts/{id}`: remove a host and its digests.
  - `POST /admin/hosts/{id}/clear`: intended to clear digests + host auth, but currently 500s because `HostRepository::clearHostAuth()` is missing.
  - `POST /admin/hosts/{id}/roaming`: toggle whether the host can roam across IPs without being blocked.
  - `POST /admin/auth/upload`: admin-upload a canonical auth JSON (body or `file`) and attribute it to a host (first host when `host_id` omitted).
  - `GET /admin/api/state` / `POST /admin/api/state`: read/set `api_disabled` flag (persisted only; not enforced by `/auth`).
  - `GET /admin/runner`: runner configuration/telemetry (last validations, counts, configured URL, timeouts, last daily check).
  - `POST /admin/runner/run`: force a runner validation against current canonical auth; applies runner-updated auth when newer.
  - `GET /admin/logs?limit=50&host_id=`: recent audit entries.
  - `GET /admin/usage?limit=50`: recent token usage rows.
  - `GET /admin/tokens?limit=50`: token usage totals per token line.
- Hosts with no contact for 30 days are pruned automatically (`host.pruned` log entries); re-register to resume.
- Legacy `host-status.txt` exports have been removed; use admin endpoints instead.
