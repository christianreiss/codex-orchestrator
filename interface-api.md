You are a coding agent (Codex) working **inside the project source tree**.

- Your working directory is the repository root.
- You are allowed to read and modify files in this repo, but you must keep changes focused, consistent and justified.
- Before changing anything, **read the existing docs**: `README.md`, `API.md`, `AGENTS.md`, `.env.example`, `docker-compose.yml`, and the relevant PHP/CLI files in `public/`, `src/`, and `bin/`.

Coordination rules with other agents:

- **Single source of truth**: Prefer *actual behavior in code* over outdated docs. If docs are wrong, fix the docs, don’t silently “fix” the behavior.
- **Assumptions are explicit**: Whenever you have to guess something, add an `## Assumptions` section to your Markdown output and list them clearly.
- **No unilateral breaking changes**: Do not change public HTTP routes, DB schema, or CLI flags/env names unless the task explicitly tells you to propose a change. If you see a mismatch, document it under `## Mismatches & Proposed Fixes`.
- **Contracts over prose**: Your primary deliverable is a precise machine‑or‑human‑readable contract (Markdown with tables, JSON examples, schemas, etc.), plus minimal code/test changes necessary to enforce or verify that contract.

Style rules:

- Be precise: list field names, types, nullability, allowed values, invariants, and edge‑case behavior.
- Add concrete examples (SQL snippets, HTTP examples, CLI examples) wherever they clarify the contract.
- Prefer incremental commits / local changes over massive refactors.

# Interface API Specification

> Source of truth: this document describes **actual behavior in the codebase as of 2025-11-23** (see `public/index.php`, `src/Services/AuthService.php`, repositories under `src/Repositories`). Where code and previous docs differ, **code wins** and discrepancies are flagged explicitly.

## Overview

- **Base URLs**
  - Default compose: `http://localhost:8488` (see `docker-compose.yml`).
  - Production example used in scripts: `https://codex-auth.uggs.io`.
- **Environment** (`.env` / container env)
  - `INVITATION_KEY` (required to register).
  - `DB_*` for MySQL connection (defaults align with compose).
  - `VERSION_ADMIN_KEY` (enables publishing wrapper/client versions and wrapper uploads).
  - `AUTH_RUNNER_URL` (optional; when set, `/auth` store calls this runner to validate tokens; default in compose: `http://auth-runner:8080/verify`).
  - `AUTH_RUNNER_CODEX_BASE_URL` (base URL sent to runner for `CODEX_SYNC_BASE_URL`; default `http://api` in compose).
  - `AUTH_RUNNER_TIMEOUT` (seconds, float; default `8`).
  - Optional: `DASHBOARD_ADMIN_KEY` (protects admin routes), `TOKEN_MIN_LENGTH` (token quality floor, default 24), `WRAPPER_STORAGE_PATH`, `WRAPPER_SEED_PATH`.
- **Auth mechanisms**
  - Invitation key (body field) gates `POST /register`.
  - Per-host API key for `POST /auth`, `DELETE /auth`, `POST /usage`, `GET /wrapper*`.
  - Admin key for `POST /versions` and `POST /wrapper` (header or bearer or `admin_key` query).
  - Admin endpoints under `/admin/*` require mTLS (`X-mTLS-Present` header set by proxy) and optionally `DASHBOARD_ADMIN_KEY`.
- **IP binding**
  - First successful `/auth` (or any endpoint that calls `authenticate`) stores the caller IP. Later calls from a different IP are rejected with `403` unless the host flag `allow_roaming_ips` is true or the caller uses the explicit bypass in `DELETE /auth` (`force=1` or header `X-CODEX-SELF-DESTRUCT: 1`).
- **API disable switch**
  - When versions table flag `api_disabled` is `1`, `POST /auth` returns `503 API disabled by administrator`. Other endpoints continue to work.
- **Host pruning**
  - Hosts whose `updated_at` is older than 30 days are deleted on every `register` and `authenticate` call; logs record `host.pruned` entries.
- **Response envelope**
  - Success: `{"status":"ok", ...}`.
  - Errors: `{ "status": "error", "message": "...", "details": {<field>: ["..."]}? }` with appropriate HTTP status.

## Authentication & Headers

- **API key** (all non-public, non-admin routes):
  - `X-API-Key: <64-hex>` **or** `Authorization: Bearer <key>`.
- **Admin key** (`POST /versions`, `POST /wrapper`, `/admin/*` when `DASHBOARD_ADMIN_KEY` set):
  - `X-Admin-Key: <secret>` **or** `Authorization: Bearer <secret>` **or** query `?admin_key=<secret>`.
- **Client IP detection**: uses `X-Forwarded-For` (first value) then `X-Real-IP`, else `REMOTE_ADDR`.
- **Content type**: JSON expected for all POST bodies except `POST /wrapper` (multipart/form-data). Invalid JSON body → `400 Invalid JSON payload` before routing.

## Endpoint Catalogue

For each endpoint, fields are **required unless noted**. Timestamps are RFC3339. Digests are lowercase hex SHA-256 of the exact canonical JSON body.

### POST /register

- **Auth**: invitation key only.
- **Body**: `{ fqdn: string, invitation_key: string }` (non-empty).
- **Responses**
  - `200 ok` → `{ status: "ok", host: { fqdn, status, last_refresh, updated_at, client_version, wrapper_version, api_calls, allow_roaming_ips, api_key } }`
  - `401 Invalid invitation key` when key mismatch.
  - `422 Validation failed` with `details` map for missing fields.
- **Behavior**: re-registering an existing FQDN rotates `api_key` immediately (old key invalid). Prunes inactive hosts before creating/rotating.
- **DB**: inserts/updates `hosts`; logs `register` action.

### POST /auth (unified retrieve/store)

- **Auth**: API key (+ IP binding).
- **Query aliases**: `client_version` or `cdx_version`; `wrapper_version` or `cdx_wrapper_version`.
- **Common side effects**: increments `hosts.api_calls`, updates `client_version` (normalized, default `"unknown"`) and optional `wrapper_version`, records IP binding/roaming decision.
- **Payload selector**: `command` defaults to `retrieve`; must be `retrieve` or `store`.

#### Retrieve branch (`command` omitted or `retrieve`)
- **Body**
  - `digest`: string, 64-hex. Also accepted keys: `auth_digest`, `auth_sha`.
  - `last_refresh`: RFC3339, must be ≥ 2000-01-01T00:00:00Z and not more than 5 minutes in the future.
  - Optional: `client_version`, `wrapper_version` (same validation as store).
- **Responses**
  - `200 ok` + `status: valid` when `digest` matches canonical: returns `canonical_last_refresh`, `canonical_digest`, `api_calls`, `versions`; no auth body.
  - `200 ok` + `status: upload_required` when the client’s `last_refresh` is newer than canonical (canonical digest different or missing): returns `canonical_*`, `api_calls`, `versions`, `action: store`; caller should resend with `command: "store"` and full auth payload.
  - `200 ok` + `status: missing` when no canonical exists: returns `canonical_*` null, `action: store`, `api_calls`, `versions`.
  - `200 ok` + `status: outdated` when canonical exists and server copy is newer or digests differ without client being newer: returns `host` summary, canonical `auth`, `canonical_last_refresh`, `canonical_digest`, `api_calls`, `versions`.
- **Notes**
  - Recent digests cache is maintained (up to 3 per host) but only affects bookkeeping, not response selection.

#### Store branch (`command: store`)
- **Body**
  - `auth`: object **or** inline fields (legacy) containing:
    - `last_refresh`: required RFC3339 (same bounds as above).
    - `auths`: object keyed by target hostname; each entry requires `token` (min length `TOKEN_MIN_LENGTH`, no whitespace, not low-entropy). Optional per-entry fields: `token_type|type`, `organization|org|default_organization|default_org`, `project|default_project`, `api_base|base_url`, plus any scalar metadata keys preserved under `meta`.
    - **Fallbacks:** if `auths` is missing/empty but `tokens.access_token` or `OPENAI_API_KEY` is present, the server synthesizes `auths = { "api.openai.com": { "token": <access_token> } }`.
    - Any other top-level fields (e.g., `tokens`, `OPENAI_API_KEY`, custom metadata) are preserved verbatim; only `auths` is normalized/sorted.
  - Optional `client_version`, `wrapper_version`.
- **Responses**
  - `status: updated` when canonical is empty or incoming `last_refresh` is newer: returns canonical `auth`, `canonical_last_refresh`, `canonical_digest`, `host`, `api_calls`, `versions`.
  - `status: unchanged` when timestamps are equal: returns `canonical_last_refresh`, `canonical_digest`, `api_calls`, `versions` (no auth body).
  - `status: outdated` when server already has a newer `last_refresh`: returns canonical `auth`, `canonical_last_refresh`, `canonical_digest`, `host`, `api_calls`, `versions`.
  - When `AUTH_RUNNER_URL` is configured, responses include `validation` with runner output `{ status: "ok|fail", reason?, latency_ms?, wrapper_version?, updated_auth? }` for every `store` call (best-effort; failures do not block store). If the runner returns `updated_auth` (e.g., Codex refreshed credentials during the probe) and its `last_refresh` is newer or the digest differs, the API persists that updated auth as the new canonical and mirrors it in the response; `runner_applied: true` is added when this happens.
  - Daily preflight: on the first API request each UTC day, if a canonical auth exists and `AUTH_RUNNER_URL` is set, the server runs the current canonical auth through the runner before responding. If the runner returns `updated_auth` that is newer/different, the server immediately stores and serves that updated auth (logged as `auth.runner_store` with `trigger: daily_preflight`). Failures are logged but do not block responses; the daily check is attempted once per UTC day.
- **Errors**
  - Validation `422` with field-specific `details` for missing digest/last_refresh/auths, bad tokens, future/ancient timestamps, or malformed command.
- **DB**: writes `auth_payloads` (with normalized auth JSON in `body`), `auth_entries`, `host_auth_states`, `host_auth_digests`; updates `hosts` sync fields; logs `auth.retrieve` or `auth.store`.

### DELETE /auth (self-deregister)

- **Auth**: API key (+ IP binding). If IP mismatches, caller can bypass by `?force=1` or header `X-CODEX-SELF-DESTRUCT: 1` (overwrites stored IP and proceeds).
- **Response**: `200 ok` → `{ status: "ok", data: { deleted: <fqdn> } }`.
- **Errors**: `401` invalid key; `403` disabled host; `403` IP mismatch (unless bypass); `404` if host missing.
- **DB**: deletes host row (cascade removes auth states/digests), logs `host.delete`.

### POST /usage (token usage logging)

- **Auth**: API key (+ IP binding).
- **Body**: at least one of `line` (string) or numeric fields.
  - `line` (string, optional).
  - `total`, `input`, `output`, `cached` (integers ≥ 0; `cached` is optional and ignored if non-numeric).
  - `model` (string, optional).
- **Responses**: `200 ok` → `{ status: "ok", data: { host_id, recorded_at, line?, total?, input?, output?, cached?, model? } }`.
- **Errors**: `422` when all fields empty or non-numeric; standard auth/IP errors.
- **DB**: inserts `token_usages`, logs `token.usage` with provided fields.

### GET /versions

- **Auth**: none.
- **Response**: `200 ok` → `{ status: "ok", data: { client_version, client_version_checked_at, client_version_source, wrapper_version, wrapper_sha256, wrapper_url, reported_client_version, reported_wrapper_version } }`.
- **Behavior**: if no admin-published client version exists, the server may fetch GitHub `openai/codex` latest release when the cached value is older than 3h. Wrapper version is the max of stored wrapper metadata, admin-published wrapper, or latest reported wrapper from hosts; SHA/URL come from stored wrapper file if present.

### POST /versions (admin)

- **Auth**: `VERSION_ADMIN_KEY` via admin header/bearer/query.
- **Body**: JSON with optional `client_version`, `wrapper_version` (at least one required; strings are trimmed, client normalized by stripping leading `v`/`codex-cli`).
- **Responses**
  - `200 ok` → same payload as `GET /versions`.
  - `401 Admin key required` when key missing/mismatch.
  - `422 At least one of client_version or wrapper_version is required`.
- **DB**: sets `versions.client` and/or `versions.wrapper`; logs `version.publish`.

### GET /wrapper

- **Auth**: API key (+ IP binding).
- **Response**: `200 ok` → `{ status: "ok", data: { version, sha256, size_bytes, updated_at, url } }` when a wrapper file exists and `version` is known.
- **Errors**: `404 Wrapper not available` if no file or version unset; auth/IP errors otherwise.

### GET /wrapper/download

- **Auth**: API key (+ IP binding).
- **Behavior**: streams current wrapper file with headers `Content-Type: text/x-shellscript`, `Content-Disposition: attachment; filename="cdx-<version>.sh"`; adds `X-SHA256` and `ETag` when hash exists; `Content-Length` when size known.
- **Errors**: `404 Wrapper not available` if file missing or version unknown; auth/IP errors.

### POST /wrapper (admin upload)

- **Auth**: `VERSION_ADMIN_KEY` via admin header/bearer/query.
- **Body**: `multipart/form-data` with fields `file` (required), `version` (required), `sha256` (optional expected hash).
- **Responses**
  - `200 ok` → `{ status: "ok", data: { version, sha256, size_bytes, updated_at, url } }` after storing file to `WRAPPER_STORAGE_PATH` and updating `versions.wrapper`.
  - `401 Admin key required` when key missing/mismatch.
  - `422 file is required (multipart/form-data)` or `version is required` or `sha256 mismatch for uploaded file`.

### Admin (mTLS-required) endpoints

> All routes below call `requireMtls()` which rejects requests when header `X-mTLS-Present` is empty. If `DASHBOARD_ADMIN_KEY` is set, the same admin-key rules as above apply; otherwise only mTLS is required.

- **GET /admin/overview**
  - Returns hosts count, active count, average `last_refresh` age (days), latest log timestamp, version snapshot, token totals (sum + top host), and mTLS context (subject/issuer/serial/fingerprint from headers).
- **POST /admin/versions/check**
  - Forces a GitHub fetch for the available client version (ignores cache), then returns `{ available, versions }` where `available.version` may be null on failure.
- **GET /admin/hosts**
  - Returns all hosts with status, last/updated timestamps, versions, api_calls, IP, roaming flag, canonical digest (from host state or host row), boolean `authed`, up to 3 recent digests, and aggregated token usage per host.
- **POST /admin/hosts/register**
  - Body `{ fqdn }`; uses configured `INVITATION_KEY` to register the host (rotates if existing). Response `{ status: "ok", data: { host } }`.
- **GET /admin/runner**
  - Returns runner configuration and recent activity when `AUTH_RUNNER_URL` is set: `{ enabled, runner_url, base_url, timeout_seconds, last_daily_check, counts: { validations_24h, runner_store_24h }, latest_validation?, latest_runner_store? }`.
  - `latest_validation`/`latest_runner_store` include host (id/fqdn), status/reason/latency (validation), and incoming digest/last_refresh when the runner applied or attempted to apply an update.
- **GET /admin/api/state** / **POST /admin/api/state**
  - GET returns `{ disabled: bool }` from `versions.api_disabled` flag.
  - POST body `{ disabled: bool }`; sets the flag. Validation error `422` if value not boolean-ish.
- **GET /admin/hosts/{id}/auth**
  - Query `include_body=1` optionally includes reconstructed auth JSON.
  - Returns host metadata, `canonical_last_refresh`, `canonical_digest`, `recent_digests`, `auth` (when requested), `api_calls`.
  - Payload selection now prefers the host’s last-seen payload (`host_auth_states.payload_id`) and falls back to the latest canonical if unavailable.
- **DELETE /admin/hosts/{id}**
  - Deletes host by id after logging `admin.host.delete`; returns `{ deleted: id }`.
- **POST /admin/hosts/{id}/clear**
  - Clears stored IP and digest cache for the host; logs `admin.host.clear`; returns `{ cleared: id }`.
- **POST /admin/hosts/{id}/roaming**
  - Body `{ allow: bool }` or `{ allow_roaming_ips: bool }`; toggles roaming flag and logs `admin.host.roaming`; returns updated host id, fqdn, allow_roaming_ips.
- **GET /admin/logs?limit=50&host_id=**
  - Returns recent log rows (id, host_id, action, details decoded when JSON, created_at); `limit` capped 500.

### Fallback

- Any unmatched route → `404 { status: "error", message: "Not found" }`.

## Behavioral Contracts

- **Digest & canonicalization**
  - Canonical auth is the normalized auth JSON: `last_refresh` + sorted `auths` entries, plus any extra top-level keys exactly as submitted. Stored in `auth_payloads.body`; SHA-256 over that exact JSON is stored as `sha256` and compared on retrieve.
- **Timestamp handling**
  - `Timestamp::compare` parses fractional seconds and normalizes missing micros. If parsing fails, falls back to string comparison.
  - Validation rejects timestamps older than 2000-01-01T00:00:00Z or more than 300s in the future.
- **Version snapshot semantics**
  - `client_version`: admin-published (`versions.client`) overrides everything; otherwise fetched from GitHub with 3h cache (`versions.client_available`), else null with `source` hint. Normalized by stripping `v`, `codex-cli`, `codex`, `rust-` prefixes.
  - `wrapper_version`: max of stored wrapper metadata, admin-published wrapper, and highest wrapper reported by any host. If no published wrapper exists but hosts have reported one, the first reported value seeds `versions.wrapper` with a `version.seed` log.
  - `reported_*` are maxima across all hosts’ reported versions.
- **IP binding**
  - First authenticated call saves IP; later mismatches → 403 unless `allow_roaming_ips` true or force bypass during `DELETE /auth`. When a new IP is accepted (roaming or bypass) the stored IP is updated and event logged.
- **Pruning**
  - Hosts with `updated_at` older than 30 days are deleted automatically on register/authenticate; cascades remove auth states/digests.
- **API disable flag**
  - Only affects `/auth`; returns HTTP 503 with message `API disabled by administrator` when set.

## API ↔ DB Mapping (refer to `interface-db.md`)

- `hosts`: touched by register/authenticate/usage/delete/admin host routes; stores `api_key`, status, IP binding, versions, API call count, sync timestamps/digest, roaming flag.
- `auth_payloads` + `auth_entries`: created on `/auth` store; the latest row (or id from `versions.canonical_payload_id`) is treated as canonical.
- `host_auth_states`: per-host record of last seen canonical payload/digest.
- `host_auth_digests`: up to 3 recent digests per host (updated on retrieve/store and when canonical changes).
- `logs`: records register/auth/store/delete/version/admin actions and token usage events.
- `token_usages`: appended via `POST /usage`; aggregated in admin views.
- `versions`: stores published versions, cached available client version, `wrapper` version, `canonical_payload_id`, and `api_disabled` flag.

## Tests & Compatibility Harness

- See `tests/api-checklist.md` for ready-to-run `curl` invocations that exercise each endpoint (success + error cases) against a local `http://localhost:8488` stack.
- Minimal smoke test set should cover:
  - register with wrong/right invitation key;
  - auth retrieve valid/outdated/missing branches;
  - auth store updated/unchanged/outdated branches;
  - API-disabled guard; IP binding and roaming toggle; delete with/without force;
  - wrapper metadata/download when file exists/missing;
  - admin mTLS/header enforcement paths; admin version publish/check;
  - usage validation and logging.

## Code vs Docs: Discrepancies

- API disable flag only blocks `/auth`, not `/usage` or wrapper endpoints.
