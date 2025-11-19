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
    "api_key": "8a63...f0"
  }
}
```

Errors:
- `422` when `fqdn` or `invitation_key` missing.
- `401` when `invitation_key` is wrong.

### `POST /auth/sync`

Uploads the client’s current `auth.json`. The server compares `last_refresh` and returns either the stored canonical version or the newly accepted payload. You can send the document either nested under `auth` or as the raw body.

**Request**

```http
POST /auth/sync HTTP/1.1
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
      "updated_at": "2025-11-19T09:28:01Z"
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
- `422` missing `auth` body or `last_refresh`.
- `500` unexpected server error.

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
