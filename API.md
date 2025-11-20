# Codex Auth Central API

Base URL: `https://codex-auth.uggs.io`

All responses are JSON. Request bodies must be `application/json` unless otherwise stated.

## Authentication

- `POST /register` is public but guarded by a shared invitation key.
- Every other endpoint requires the per-host API key via either:
  - `X-API-Key: <key>`
  - `Authorization: Bearer <key>`
- API keys are IP-bound after the first auth call: the first successful `/auth` stores the caller's IP; later calls from a different IP return `403`. Re-register to rotate the key and reset the binding.

### Invitation Key

- Current onboarding key: `39e0975e1d8e82db7a9b39e0f518d59fc4e588ef9a08564fa499779c9536eacc`
- Rotate via the `INVITATION_KEY` environment variable.

Errors return:

```json
{ "status": "error", "message": "Invalid API key" }
```

## Endpoints

### `POST /register`

Registers a host with the invitation key. Re-registering the same FQDN rotates the API key immediately.

**Request**

```http
POST /register HTTP/1.1
Host: codex-auth.uggs.io
Content-Type: application/json

{ "fqdn": "ci01.example.net", "invitation_key": "<shared-secret>" }
```

**Success**

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

Errors: `422` for missing fields, `401` for wrong invitation key.

### `POST /auth` (single-call sync)

Unified endpoint for both checking and updating auth. Each response includes the versions block, so no separate `/versions` request is needed.

**Required auth**: API key header.

**Body fields**

- `command`: `retrieve` (default) or `store`.
- `client_version`: required (JSON or query param `client_version`/`cdx_version`).
- `wrapper_version`: optional (JSON or query param `wrapper_version`/`cdx_wrapper_version`).
- `digests`: optional array of up to 3 lowercase SHA-256 hex digests previously issued to this host.
- `last_refresh`: required when `command` is `retrieve`; timestamp of the client’s current payload.
- `auth`: required when `command` is `store`; payload identical to the previous `/auth/update` body and must include `last_refresh`.

The service stores the canonical auth JSON plus an `auth_digest` and keeps the last 3 digests per host (`host_auth_digests`) based on what callers submit.

**Retrieve example (valid)**

```http
POST /auth HTTP/1.1
X-API-Key: 8a63...f0
Content-Type: application/json

{
  "command": "retrieve",
  "last_refresh": "2025-11-19T09:27:43.373506211Z",
  "digests": ["b0b1b540ea35ac7cf806..."],
  "client_version": "0.60.1",
  "wrapper_version": "2025.11.19-4"
}
```

```json
{
  "status": "ok",
  "data": {
    "status": "valid",
    "canonical_last_refresh": "2025-11-19T09:27:43.373506211Z",
    "canonical_digest": "b0b1b540ea35ac7cf806...",
    "versions": {
      "client_version": "0.60.1",
      "client_version_checked_at": "2025-11-20T09:00:00Z",
      "wrapper_version": "2025.11.19-4",
      "reported_client_version": "0.60.1",
      "reported_wrapper_version": "2025.11.19-4"
    }
  }
}
```

**Retrieve responses**

- `valid`: submitted digest matches canonical; no auth JSON returned.
- `outdated`: server has newer auth; response includes `auth`, canonical digest, and versions.
- `upload_required`: client claims a newer payload (client `last_refresh` > server); caller should resend with `command: "store"` and include `auth`.
- `missing`: server does not yet have a canonical payload; caller should send `command: "store"`.

**Store example (update canonical)**

```http
POST /auth HTTP/1.1
X-API-Key: 8a63...f0
Content-Type: application/json

{
  "command": "store",
  "client_version": "0.60.1",
  "wrapper_version": "2025.11.19-4",
  "digests": ["b0b1b540ea35ac7cf806..."],  // optional; server records them
  "auth": {
    "last_refresh": "2025-11-20T09:27:43.373506211Z",
    "auths": { "api.codex.example.com": { "token": "..." } }
  }
}
```

**Store responses**

- `updated`: incoming `last_refresh` is newer or server had none; server stores the payload and returns canonical `auth`, digest, versions, and host metadata.
- `unchanged`: timestamps match; returns canonical digest and versions only.
- `outdated`: server already has a newer copy; returns canonical `auth`, digest, and versions so the client can hydrate.

### `GET /versions` (optional)

Provided for observability; clients do not need it because `/auth` responses already include the same block.

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

### `POST /versions` (admin)

Publishes operator versions. Requires `VERSION_ADMIN_KEY` (via `X-Admin-Key`, `Authorization: Bearer`, or `admin_key` query). Body accepts `client_version` and/or `wrapper_version`. Response mirrors `GET /versions`.

## Logs & Housekeeping

- Every `register`, `auth` retrieve/store, and version publish is logged in the `logs` table with JSON details.
- The service keeps the last 3 digests per host in `host_auth_digests` to recognize recent client states.
- Hosts with no contact for 30 days are pruned automatically (`host.pruned` log entries); re-register to resume.
- After register/store/prune events a status report is regenerated at `STATUS_REPORT_PATH` (defaults to `storage/host-status.txt`).
