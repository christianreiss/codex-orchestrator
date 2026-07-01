---
title: The auth distribution pipeline
section: Fleet operations
verified: 2026-07-01
sources: api/src/routes/auth/index.ts, api/src/services/host-auth.ts, api/src/services/insecure-window.ts, api/src/services/canonical-auth-store.ts, api/src/services/runner-validation.ts, api/src/services/runner-client.ts, api/src/ops/auth-verification-worker.ts, api/src/services/reverse-dns.ts, api/src/security/keyring.ts, api/src/security/secret-box.ts, api/src/db/schema.ts, wrappers/clx/internal/claude/auth_writer.go
---

Every host gets its credentials by asking the orchestrator; the orchestrator is the single writer of canonical auth payloads. The pipeline is built around three requirements: **encrypt at rest**, **authenticate the caller**, and **refuse to hand out anything a compromised host should not have**.

## The public endpoints

- `POST /auth` — the main host-facing auth endpoint. Accepts a `command` field: `retrieve` (default) or `store`. Both paths authenticate the caller via API key extracted from HTTP **headers**.
- `POST /sync/status` / `POST /sync/bootstrap` — sync endpoints the wrappers hit on every run. Both inline an auth check (unless `include_auth=false`) and embed the result in the response — see *Sync routes* below for how the two differ.
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
5. **No live runner call** — retrieve never blocks on a live runner probe. It consults the latest stored verdict from the background auth-verification worker (see below) via `servedVerificationSnapshot`; if that verdict is `failed`, retrieve returns `status: 'outdated'` *without* the `auth` blob rather than serving known-bad credentials.

The retrieve response includes `versions`, `canonical_digest`, `canonical_last_refresh`, `host`, `api_calls`, `engine`, `quota_hard_fail`, `quota_limit_percent`, `verification_state` (`verified`/`failed`/`unknown`, plus `verification_reason` when `failed`), and (when `status: 'outdated'`) the `auth` blob. Codex retrieves also carry a `chatgpt` usage snapshot. Skills manifests and AGENTS.md hashes are part of `/sync/bootstrap`, not `/auth`.

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
4. Inline an auth check (unless `include_auth=false`) and embed the result in `out.auth`.

The auth step differs between the two routes. `/sync/status` always inlines a plain `handleRetrieve`. `/sync/bootstrap` inlines `handleBootstrapAuth`, which additionally accepts an `auth_candidate` body field: if the host posts one and its canonicalized digest already matches canonical, bootstrap returns `status: 'valid'` straight from the stored verification verdict (no `handleRetrieve` round trip); if the candidate is newer than canonical it is persisted via `storeCandidate` (live runner verification, same as `store`); otherwise (no candidate, or a stale one) it falls back to `handleRetrieve`.

`/sync/bootstrap` additionally fetches agents, config, `claude_artifacts`, `claude_settings`, `claude_skills` (Claude engine only), and session counts. `status: ok` vs `update` is determined by whether `out.reasons` is empty.

The `host_auth_digests` table is written on store/retrieve, but the sync routes do not short-circuit via a digest lookup — they always run the auth step described above.

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

There is no `/exec` endpoint in this client. All runner calls use the `x-runner-auth` header with `AUTH_RUNNER_SHARED_SECRET` sent as-is. Every response also carries `reachable` (`false` only on a transport/timeout error — the runner responding with `ok: false` still counts as reachable) and, on failure, `reason`.

## Background auth verification

Host startup never waits on a live runner probe. Instead `api/src/ops/auth-verification-worker.ts` starts an in-process worker (only when `AUTH_RUNNER_URL` is configured) that keeps the latest Codex and Claude canonical payloads verified in the background:

- The first tick fires ~1 second after boot; subsequent ticks run every `AUTH_RUNNER_VERIFY_WORKER_INTERVAL_SECONDS` (default 300s, floor 30s).
- Each tick calls `canonical-auth-store.ts`'s `ensureServedVerification` for both engines, TTL-bounded by `AUTH_RUNNER_VERIFY_TTL_SECONDS` (default 900s): a payload verified within the TTL is left alone; otherwise the worker probes the runner live.
- A `verified` verdict stamps `auth_payloads.verification_state` / `verification_checked_at`. A `failed` verdict (the runner reached the provider and the credentials don't work) also stamps `verification_reason` — this is what makes `/auth retrieve` refuse to serve that payload (`status: 'outdated'`, no `auth` blob).
- If the runner returns a refreshed `updated_auth` with a newer digest, the worker persists it as a new canonical payload via the same `storeCandidate` path a `store` upload uses.
- Concurrent probes for the same canonical row are collapsed in-process (the `verifyInflight` map in `canonical-auth-store.ts`), so a fleet of hosts hitting an expired token at the same moment doesn't spawn a refresh-token race.
- A transport failure (`reachable: false`) leaves the stored state untouched and is reported as `unknown`, not `failed` — an infrastructure blip does not lock hosts out.

`/auth retrieve` and `/sync/bootstrap`'s warm-launch path only ever read this stored verdict via `servedVerificationSnapshot` (synchronous, no I/O) — they never call `ensureServedVerification` themselves. `store` (both a direct upload and this worker's refresh path) is the only caller that performs a live runner call, via `storeCandidate`.

## Credentials file on the host

The `clx` auth writer (`WriteAuth` in `wrappers/clx/internal/claude/auth_writer.go`) always writes `~/.claude/.credentials.json` (the upstream Claude CLI location) first, then additionally mirrors the same write to `~/.clx/auth/credentials.json` *only if that path already exists*. Reads (`selectedAuthFile`) pick whichever of the two candidate files is structurally usable and has the newest mtime, preferring `~/.claude/.credentials.json` on a tie. Both writes are atomic (temp file + rename) with 0600 permissions, serialized by an advisory flock on a sibling `.lock` file. Note the differing filenames: `~/.claude/.credentials.json` (dot-prefixed, upstream convention) vs. `~/.clx/auth/credentials.json` (no leading dot) — neither is named `auth.json`.

## Killing the pipeline in an emergency

- **Fleet kill-switch**: `assertApiNotDisabled` checks a single `api_disabled` flag in the `versions` table. Flipping it refuses auth for all engines. The `/auth` endpoint itself is not disabled, but hosts see refusal responses.
- **Delete a host**: `DELETE /admin/hosts/{id}`. The host's API key is invalidated; future `/auth` calls fail authentication.
- **Host self-uninstall**: `DELETE /auth`. The host deletes its own registration. Logged and broadcast via WebSocket.
- **Purge insecure creds immediately**: `POST /admin/hosts/{id}/insecure/disable` — closes the window, forcing the host back into the approval queue.

## Source references

- api/src/routes/auth/index.ts (POST /auth retrieve+store, DELETE /auth, /sync/status, /sync/bootstrap)
- api/src/services/host-auth.ts (authenticate, IP binding, refusal codes)
- api/src/services/insecure-window.ts, api/src/services/insecure-window-admin.ts (window/grace math, domain allows, approvals)
- api/src/services/canonical-auth-store.ts (storeCandidate, servedVerificationSnapshot, ensureServedVerification)
- api/src/services/runner-validation.ts (canonical payload resolve/validate, digest, auths{} normalization)
- api/src/services/runner-client.ts (verify, verifyClaude, feature endpoints)
- api/src/ops/auth-verification-worker.ts (background verification loop)
- api/src/services/reverse-dns.ts
- api/src/security/secret-box.ts, api/src/security/keyring.ts
- api/src/db/schema.ts (auth_entries, auth_payloads, host_auth_digests, host_auth_states, insecure_auth_requests, insecure_domain_allows)
- wrappers/clx/internal/claude/auth_writer.go (host-side credentials file selection/write)
