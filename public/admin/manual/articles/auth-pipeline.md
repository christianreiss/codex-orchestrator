---
title: The auth distribution pipeline
section: Fleet operations
verified: 2026-06-05
sources: api/src/routes/auth/index.ts, api/src/services/host-auth.ts, api/src/services/insecure-window.ts, api/src/services/runner-client.ts, api/src/services/reverse-dns.ts, api/src/security/keyring.ts, api/src/security/secret-box.ts, api/src/db/schema.ts
---

Every host gets its credentials by asking the orchestrator; the orchestrator is the single writer of canonical auth payloads. The pipeline is built around three requirements: **encrypt at rest**, **authenticate the caller**, and **refuse to hand out anything a compromised host should not have**.

## The public endpoints

- `POST /auth` — the main host-facing auth endpoint. Accepts a `command` field: `retrieve` (default) or `store`. Both paths authenticate the caller via API key extracted from HTTP **headers**.
- `POST /sync/status` / `POST /sync/bootstrap` — sync endpoints the wrappers hit on every run. Both inline a full auth retrieve (unless `include_auth=false`) and embed the result in the response.
- `DELETE /auth` — self-uninstall. The host sends its API key; the route deletes the `host_auth_digests` and `hosts` rows, logs `host.delete`, and publishes a WebSocket event.

API keys are read from HTTP **headers** in all cases via `extractApiKey(req.headers)` in `host-auth.ts`. There is no body-based API key flavor.

## `POST /auth` — the two command paths

### Retrieve (`command=retrieve`, default)

`handleRetrieve` is called. Steps in order:

1. **Authenticate** — API key extracted from headers, hashed, matched against `hosts.api_key_hash` (fallback to plaintext `hosts.api_key` for legacy rows).
2. **Check the insecure window** — `maybeEnforceInsecure` tests whether the host may receive auth. If outside both window and grace, and no `insecure_domain_allows` match exists, an `insecure_auth_requests` row is inserted and the caller sees a 423.
3. **Resolve the canonical payload** — looks up the `auth_payloads` row for the host's engine (preferred: `verificationState='verified'`, fallback: any row). Decryption happens in `validateCanonicalPayload` / `decodePayloadBody` via `decryptOrNull`.
4. **Compare digests** — the host-submitted `digest`/`auth_digest`/`auth_sha` is compared against the canonical digest. Returns one of:
   - `status: 'valid'` — digests match, host is current.
   - `status: 'outdated'` — host is behind; response includes the decrypted auth blob.
   - `status: 'upload_required'` — host has a newer timestamp; tells the host to store.
   - `status: 'missing'` — no canonical payload exists yet.
5. **No runner call** — the runner is never called on the retrieve path.

The retrieve response includes `versions`, `canonical_digest`, `canonical_last_refresh`, `host`, `quota_hard_fail`, `quota_limit_percent`, and (when `status: 'outdated'`) the `auth` blob. Skills manifests and AGENTS.md hashes are part of `/sync/bootstrap`, not `/auth`.

### Store (`command=store`)

`handleStore` is called. Steps in order:

1. **Authenticate** — same header-based key check as retrieve.
2. **Check the insecure window** — same `maybeEnforceInsecure` call.
3. **Accept and canonicalize the auth blob** — the `auth` body field (with `last_refresh`) is normalized and canonicalized. The `claudeAiOauth` object is preserved so hosts receive the full OAuth credentials shape needed for token refresh.
4. **Runner verification** — if `AUTH_RUNNER_URL` is configured, calls `runner.verify` (Codex engine) or `runner.verifyClaude` (Claude engine) from `runner-client.ts`. These POST to `/verify` or `/verify-claude` respectively, authenticated via the `x-runner-auth` header carrying `AUTH_RUNNER_SHARED_SECRET` as-is (not derived). If the runner returns `ok: false`, the store is **refused** with `ServiceUnavailableError`. There is no bypass for a failed runner; the upload is simply rejected.
5. **Persist** — if the runner returns an `updated_auth`, that refreshed payload is stored instead of the submitted one. The body is encrypted via the active keyring and inserted into `auth_payloads`, `auth_entries` (per-`auths{}` entry), and `host_auth_digests`. Returns `status: 'updated'`.

## Authentication in host-auth.ts

`hostAuth.authenticate(req)` extracts the API key from HTTP headers. It hashes the key and looks up `hosts.api_key_hash`; falls back to plaintext `hosts.api_key` for legacy rows.

**IP binding** uses separate `ip4` and `ip6` columns per address family — not a single `first_seen_ip` column. Enforcement:

- First successful auth from a given address family binds that column.
- Subsequent requests must match the bound address unless `allowRoamingIps=1` or the insecure window is active.
- Addresses in `AUTH_RUNNER_BYPASS_SUBNETS` bypass IP binding entirely (for runner/admin calls).

Toggle per-host roaming at `POST /admin/hosts/{id}/roaming`. Toggle reverse-DNS enforcement at `POST /admin/hosts/{id}/reverse-dns` or the fleet-wide default at `POST /admin/reverse-dns`.

## Insecure windows

An insecure host is one where the machine is not fully trusted to hold credentials at rest. Constants are defined in `insecure-window.ts`:

- `DEFAULT_WINDOW = 10` minutes
- `MAX_WINDOW = 480` minutes
- `PROVISIONING_WINDOW_MINUTES = 30`
- `APPROVAL_DENY_COOLDOWN_SECONDS = 60`

The window slides on each hit while active. After the window closes, `store` is still permitted during the grace tail (`graceUntil`). When neither window nor grace is active, the insecure-window service checks the `insecure_domain_allows` table for a matching domain — a match **auto-opens a new window**. If no domain match exists, an `insecure_auth_requests` row is inserted (status=pending) and the caller sees a 423. A recent `denied` row within `APPROVAL_DENY_COOLDOWN_SECONDS` causes a 403 instead.

## Sync routes

Both `/sync/status` and `/sync/bootstrap`:

1. Call `hostAuth.authenticate`.
2. Call `maybeEnforceInsecure`.
3. Call `syncService.collect`.
4. Inline a full `handleRetrieve` call (unless `include_auth=false`) and embed the result in `out.auth`.

`/sync/bootstrap` additionally fetches agents, config, `claude_artifacts`, `claude_settings`, `claude_skills` (Claude engine only), and session counts. `status: ok` vs `update` is determined by whether `out.reasons` is empty.

The `host_auth_digests` table is written on store/retrieve, but the sync routes do not short-circuit via a digest lookup — they always inline a fresh `handleRetrieve` call.

## Encryption

Payloads are encrypted with libsodium's `crypto_secretbox` via `api/src/security/secret-box.ts`. The `Keyring` (`api/src/security/keyring.ts`) reads:

- `ENCRYPTION_KEYS` (or legacy `AUTH_ENCRYPTION_KEYS`) as `kid:base64,...` pairs.
- `ENCRYPTION_ACTIVE_KEY` (or `AUTH_ENCRYPTION_KEY`) as the single active key.
- `ENCRYPTION_ACTIVE_KID` (or `AUTH_ENCRYPTION_ACTIVE_KID`) to identify the active key.

The active KID encrypts all new writes. Decryption selects the key by stored KID. Adding a new key and rotating the active KID is the supported rotation path.

Lose all keys and the encrypted rows are unreadable. Back up the keyring.

## The runner contract

`runner-client.ts` exposes the routes the API uses:

- `POST /verify` — Codex engine verification. Takes the auth blob, returns `ok` + optionally `updated_auth`.
- `POST /verify-claude` — Claude engine verification. Same contract.
- `/skills/generate`, `/skills/assist`, `/projects/assist` — feature endpoints derived from the base URL.

There is no `/exec` endpoint in this client. All runner calls use the `x-runner-auth` header with `AUTH_RUNNER_SHARED_SECRET` sent as-is.

## Credentials file on the host

The `clx` auth writer writes credentials to `~/.clx/auth/credentials.json` if that path exists, otherwise to `~/.claude/.credentials.json` (the upstream Claude CLI location). The write is atomic (temp file + rename) with 0600 permissions. The file is named `credentials.json`, not `auth.json`.

## Killing the pipeline in an emergency

- **Fleet kill-switch**: `assertApiNotDisabled` checks a single `api_disabled` flag in the `versions` table. Flipping it refuses auth for all engines. The `/auth` endpoint itself is not disabled, but hosts see refusal responses.
- **Delete a host**: `DELETE /admin/hosts/{id}`. The host's API key is invalidated; future `/auth` calls fail authentication.
- **Host self-uninstall**: `DELETE /auth`. The host deletes its own registration. Logged and broadcast via WebSocket.
- **Purge insecure creds immediately**: `POST /admin/hosts/{id}/insecure/disable` — closes the window, forcing the host back into the approval queue.

## Source references

- api/src/routes/auth/index.ts (POST /auth retrieve+store, DELETE /auth, /sync/status, /sync/bootstrap)
- api/src/services/host-auth.ts (authenticate, IP binding, refusal codes)
- api/src/services/insecure-window.ts, api/src/services/insecure-window-admin.ts (window/grace math, domain allows, approvals)
- api/src/services/runner-client.ts (verify, verifyClaude, feature endpoints)
- api/src/services/reverse-dns.ts
- api/src/security/secret-box.ts, api/src/security/keyring.ts
- api/src/db/schema.ts (auth_entries, auth_payloads, host_auth_digests, insecure_auth_requests, insecure_domain_allows)
