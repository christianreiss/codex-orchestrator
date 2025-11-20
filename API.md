# Codex Auth Central API

Base URL: `https://codex-auth.uggs.io`

All responses are JSON. Unless otherwise noted, request bodies must be `application/json`.

## Authentication

- `POST /register` is public but guarded by a shared invitation key.
- Every other endpoint requires the per-host API key via either:
  - `X-API-Key: <key>`
  - `Authorization: Bearer <key>`
- API keys are IP-bound after the first sync: the first successful `/auth/sync` stores the caller's IP, and all subsequent syncs with that key must come from the same IP or a `403` is returned. (Re-register to rotate the key and reset the bound IP.)

### Invitation Key

- Current shared key for onboarding new hosts: `39e0975e1d8e82db7a9b39e0f518d59fc4e588ef9a08564fa499779c9536eacc`
- Update this value via the `INVITATION_KEY` environment variable when rotating secrets.

On failure, the API responds with:

```json
{
  "status": "error",
  "message": "Invalid API key"
}
```

## Endpoints

### `POST /register`

Registers a host using the shared invitation key. Re-registering the same FQDN rotates the API key and returns the new value.

**Request**

```http
POST /register HTTP/1.1
Host: codex-auth.uggs.io
Content-Type: application/json

{
  "fqdn": "ci01.example.net",
  "invitation_key": "<shared-secret>"
}
```

**Success Response**

```json
{
  "status": "ok",
  "host": {
    "fqdn": "ci01.example.net",
    "status": "active",
    "last_refresh": null,
    "updated_at": "2025-01-04T09:15:30Z",
    "client_version": null,
    "api_key": "8a63...f0"
  }
}
```

Errors:
- `422` when `fqdn` or `invitation_key` missing.
- `401` when `invitation_key` is wrong.

### `POST /auth/check`

Lightweight validation endpoint that lets a client confirm whether its cached `auth.json` matches the server without uploading the full document.

**Required fields**

- `last_refresh`: RFC3339 timestamp describing the client’s cached payload.
- `auth_sha`: lowercase hex SHA-256 digest of the cached payload (hash the exact JSON you would otherwise upload, e.g. `hash('sha256', json_encode($auth, JSON_UNESCAPED_SLASHES))`).
- `client_version`: provided via JSON or query string (`client_version`/`cdx_version`).

`wrapper_version` is optional and may be sent either via JSON or query string (`wrapper_version`/`cdx_wrapper_version`).

**Request**

```http
POST /auth/check?client_version=0.60.1 HTTP/1.1
Host: codex-auth.uggs.io
X-API-Key: 8a63...f0
Content-Type: application/json

{
  "last_refresh": "2025-11-19T09:27:43.373506211Z",
  "auth_sha": "b0b1b540ea35ac7cf806..."
}
```

**Responses**

```json
{
  "status": "ok",
  "data": {
    "status": "valid",
    "last_refresh": "2025-11-19T09:27:43.373506211Z",
    "auth_digest": "b0b1b540ea35ac7cf806..."
  }
}
```

- `valid`: client matches server (no payload returned).
- `outdated`: server holds a newer copy; response includes `auth` and host metadata so the client can hydrate immediately.
- `upload_required`: client reports a newer version; caller should upload via `/auth/update`.
- `missing`: server does not yet have a canonical payload; caller should upload.

Example `outdated` response snippet:

```json
{
  "status": "ok",
  "data": {
    "status": "outdated",
    "last_refresh": "2025-11-19T09:27:43.373506211Z",
    "auth_digest": "b0b1b540ea35ac7cf806...",
    "host": { "fqdn": "ci01.example.net", "status": "active", "last_refresh": "2025-11-19T09:27:43.373506211Z", "updated_at": "2025-11-19T09:28:01Z", "client_version": "0.60.1", "wrapper_version": "1.4.3" },
    "auth": { "last_refresh": "2025-11-19T09:27:43.373506211Z", "auths": { "api.codex.example.com": { "token": "..." } } }
  }
}
```

### `POST /auth/update`

Uploads the client’s current `auth.json` when it has a newer canonical copy. The server compares `last_refresh` and returns either the stored canonical version or the newly accepted payload. `/auth/sync` is still accepted as an alias for backward compatibility, but `/auth/update` is the preferred path.

`client_version` (string) is required and should match the Codex CLI release running on the host (e.g., `"0.60.1"`). Provide it either as a JSON field or as a query parameter (`client_version` or alias `cdx_version`).

`wrapper_version` (string, optional) may be supplied when a cdx wrapper/installer is fronting the CLI. Send it via JSON or a query parameter (`wrapper_version` or alias `cdx_wrapper_version`). When provided it is stored alongside the host metadata and surfaced in host payloads/status reports so operators can audit wrapper rollout separately from the CLI version.

**Request**

```http
POST /auth/update?client_version=0.60.1&wrapper_version=1.4.3 HTTP/1.1
Host: codex-auth.uggs.io
X-API-Key: 8a63...f0
Content-Type: application/json

{
  "auth": {
    "last_refresh": "2025-11-19T09:27:43.373506211Z",
    "auths": {
      "api.codex.example.com": {
        "token": "..."
      }
    }
  }
}
```

**Success Response**

```json
{
  "status": "ok",
  "data": {
    "result": "updated",
    "host": {
      "fqdn": "ci01.example.net",
      "status": "active",
      "last_refresh": "2025-11-19T09:27:43.373506211Z",
      "updated_at": "2025-11-19T09:28:01Z",
      "client_version": "0.60.1",
      "wrapper_version": "1.4.3"
    },
    "auth": {
      "last_refresh": "2025-11-19T09:27:43.373506211Z",
      "auths": {
        "api.codex.example.com": {
          "token": "..."
        }
      }
    },
    "last_refresh": "2025-11-19T09:27:43.373506211Z"
  }
}
```

Behavior:
- If the submitted `last_refresh` is newer than the stored value, the new payload becomes canonical and the response includes the full document with `result: "updated"`.
- If the submitted `last_refresh` is older than what the server holds, the server keeps its canonical copy and returns it so the client can hydrate:

```json
{
  "status": "ok",
  "data": {
    "result": "unchanged",
    "host": { "fqdn": "ci01.example.net", "status": "active", "last_refresh": "2025-11-19T09:27:43.373506211Z", "updated_at": "2025-11-19T09:28:01Z" },
    "auth": { "last_refresh": "2025-11-19T09:27:43.373506211Z", "auths": { "api.codex.example.com": { "token": "..." } } },
    "last_refresh": "2025-11-19T09:27:43.373506211Z"
  }
}
```

- If the payload timestamp matches the stored value, the response is trimmed to result + canonical timestamp:

```json
{
  "status": "ok",
  "data": {
    "result": "unchanged",
    "last_refresh": "2025-11-19T09:27:43.373506211Z"
  }
}
```

Errors:
- `401` missing/invalid API key.
- `422` missing `auth` body, `client_version`, or `last_refresh`.
- `500` unexpected server error.

---

## `GET /versions`

Returns the server-cached Codex CLI version (pulled from GitHub “latest release” when cache is older than 2 hours), the operator-published wrapper version, and the highest values reported by any host. Clients should prefer the top-level fields; `reported_*` are fallbacks/telemetry.

**Request**

```
GET /versions
```

**Response**

```json
{
  "status": "ok",
  "data": {
    "client_version": "0.60.1",
    "client_version_checked_at": "2025-11-20T09:00:00Z",
    "wrapper_version": "2025.11.19-4",
    "reported_client_version": "0.60.1",
    "reported_wrapper_version": "2025.11.19-4"
  }
}
```

## `POST /versions` (admin)

Sets the operator-published versions. Requires the admin key configured in `VERSION_ADMIN_KEY` (send via `X-Admin-Key`, `Authorization: Bearer`, or `admin_key` query parameter).

**Request**

```
POST /versions
```

Body (at least one field required):

```json
{ "client_version": "0.60.1", "wrapper_version": "2025.11.19-4" }
```

**Response**

Same shape as `GET /versions`.

Caching:
- The API caches the Codex CLI version for 2 hours (`client_version`/`client_version_checked_at`). Requests made while the cache is fresh avoid hitting GitHub; stale caches trigger a refresh. When GitHub is unreachable the previous cached value is returned.
- If no operator wrapper version is published, the API auto-seeds it from the first reported host wrapper version.

## Logs & Auditing

Each call records an entry in the `logs` table summarizing:
- host id (if authenticated),
- action (`register` or `auth.sync`),
- timestamp,
- JSON details (e.g., `result: updated` or `incoming_last_refresh`).
- After every register/sync/prune event the service regenerates the human-readable status file (`STATUS_REPORT_PATH`, defaults to `storage/host-status.txt`) so operators always have an up-to-date snapshot.

Access logs directly via `sqlite3 storage/database.sqlite 'SELECT * FROM logs ORDER BY created_at DESC;'` when running on-prem.

## Notes

- Service is API-only; any non-listed route returns `404`.
- Use HTTPS when deploying publicly (reverse proxy, load balancer, etc.).
- Rotate API keys by updating the `hosts` table or extending the service with a key-rotation endpoint.
- Hosts that have not contacted the service for 30 days are automatically removed and must re-register before syncing again.
