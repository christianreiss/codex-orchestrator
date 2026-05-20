---
title: The auth distribution pipeline
section: Fleet operations
verified: 2026-05-20
sources: api/src/services/host-auth.ts, api/src/services/insecure-window.ts, api/src/services/insecure-window-admin.ts, api/src/services/runner-validation.ts, api/src/services/reverse-dns.ts, api/src/routes/auth/index.ts, api/src/security/secret-box.ts, api/src/security/keyring.ts, runner/app.py
---

Every host gets its credentials by asking the orchestrator; the orchestrator is the single writer of canonical `auth.json`. The pipeline is built around three requirements: **encrypt at rest**, **authenticate the caller**, and **refuse to hand out anything a compromised host should not have**.

## The two public endpoints

- `POST /auth` — the host says "I am $api_key, my IP is $remote, here is my wrapper fingerprint" and receives either the decrypted auth payload or a structured refusal. Backed by `HostAuthService.handleAuth` in `api/src/services/host-auth.ts`.
- `POST /sync/status` / `POST /sync/bootstrap` — lighter sync endpoints the wrappers hit on every run, registered alongside `/auth` in `api/src/routes/auth/index.ts`. They use the per-host auth digest stored in `host_auth_digests` so "nothing changed" is cheap.

Both routes take the per-host API key in the body; there is no header-based flavor.

## `HostAuthService.handleAuth` in order

The method in `api/src/services/host-auth.ts` is long; the decision tree in plain English:

1. **Authenticate the API key.** The key is hashed and matched against `hosts.api_key_hash`, applying IP binding and reverse-DNS rules as configured. First-ever call from a given IP binds the key to that IP unless roaming is on.
2. **Check the insecure window.** `insecure-window.ts` tests whether the host is currently allowed to receive auth at all. If insecure and outside its grace window, an `insecure_auth_requests` row is created and the caller sees a refusal.
3. **Verify reverse DNS if required.** `reverse-dns.ts` resolves the PTR for the remote IP and matches it against the host's `fqdn` (strict mode) or accepts anything (off).
4. **Resolve the canonical payload.** The most recent `auth_payloads` row is decrypted using the active keyring (`api/src/security/keyring.ts`).
5. **Optionally call the runner.** For first-time delivery to a host, `runner-validation.ts` runs a cheap completion against the auth to make sure it still works before handing it out. If the runner is not configured (`AUTH_RUNNER_URL` unset) or the call fails, the host can still receive auth depending on the configured bypass behavior.
6. **Stamp the per-host digest.** The host's `host_auth_digests` row is updated so subsequent `/sync/status` calls can short-circuit when nothing has changed.
7. **Return the payload** and write a log row to `logs`.

Every branch that refuses auth records *why*; the refusal codes are what you see on the host detail page as "last auth status".

## Encryption

Payloads are encrypted with libsodium's `crypto_secretbox` through `api/src/security/secret-box.ts`. Active keys come from `Keyring` (`api/src/security/keyring.ts`), which supports multiple keys for rotation:

- The newest key encrypts all new writes.
- Decryption tries each known key in turn (selected by stored `kid`) until one works.
- Adding a new key and rotating the active KID is the supported rotation path. Configure via `ENCRYPTION_ACTIVE_KEY`, `ENCRYPTION_KEYS`, `ENCRYPTION_ACTIVE_KID` (legacy `AUTH_ENCRYPTION_*` names still accepted).

Lose all the keys and the encrypted rows are bricks. Back up the keyring.

## IP binding and roaming

Each row in `hosts` has `ip_binding`, `ip_binding_roaming`, and a `first_seen_ip` column. The auth path enforces:

- First successful auth sets `first_seen_ip`.
- Subsequent requests must come from `first_seen_ip` unless `ip_binding_roaming = 1`.
- Roaming allows the binding to migrate to the newest IP, but the move itself is logged.

Toggle per-host at `POST /admin/hosts/{id}/roaming`. Toggle reverse-DNS enforcement at `POST /admin/hosts/{id}/reverse-dns` (per-host override) or via `POST /admin/reverse-dns` for the fleet-wide default.

## Insecure windows

An insecure host is one where you do not trust the machine to hold credentials at rest. The insecure window service treats each "session" as a bounded window:

- `DEFAULT_INSECURE_WINDOW_MINUTES = 10`, clamped to 0..`MAX_INSECURE_WINDOW_MINUTES = 480` (see `api/src/services/host-management.ts`).
- `INSECURE_GRACE_MINUTES` (env, default 60) — how long after the window ends the host can still refresh without needing a fresh approval.
- The window opens during registration when the host is registered insecure; every subsequent *allow* on the approval queue opens a new window.

## The runner contract

`runner/app.py` exposes two HTTP endpoints the API uses:

- `POST /verify` — takes an `auth.json` blob, tries a tiny completion, returns `ok` + model info. Success means "this auth will work for the host".
- `POST /exec` — used by Claude admin helpers (e.g. skill generation, skill assists) to run a prompt with a specific auth.

Both are authenticated by a shared secret derived from `AUTH_RUNNER_SHARED_SECRET`. `runner-validation.ts` also pings `/verify` from the admin *Run probe* button to surface runner health in the dashboard.

## What a client sees

A successful handshake returns the decrypted `auth.json` body plus client-facing metadata (wrapper version, AGENTS.md hash, skills manifest) so the wrapper can decide whether it needs a follow-up `/sync/bootstrap`. The sync contract details are in [wrappers](/admin/manual/wrappers).

## Killing the pipeline in an emergency

- **Fleet kill-switch**: flip the API-disabled flag in *Settings → OpenAI* / *Settings → Claude*. These set the `openai_api_disabled` / `claude_api_disabled` rows in `versions` (read by `openai-kill-switch.ts` / `claude-kill-switch.ts`). The `/auth` endpoint itself is not disabled, but downstream `/v1/*` and `/anthropic/v1/*` traffic returns 503 and hosts see quota-exhausted errors.
- **Delete a host**: `DELETE /admin/hosts/{id}`. The host's API key is invalidated; future `/auth` calls fail authentication.
- **Purge insecure creds immediately**: `POST /admin/hosts/{id}/insecure/disable` — closes the window, forcing the host back into the approval queue.

## Source references

- api/src/services/host-auth.ts (handleAuth, authenticate, refusal codes)
- api/src/services/insecure-window.ts, api/src/services/insecure-window-admin.ts (window/grace math, approvals)
- api/src/services/runner-validation.ts (verify, verifyClaude)
- api/src/services/reverse-dns.ts
- api/src/routes/auth/index.ts (POST /auth, /sync/status, /sync/bootstrap)
- api/src/security/secret-box.ts, api/src/security/keyring.ts
- api/src/db/schema.ts (auth_entries, auth_payloads, host_auth_digests, insecure_auth_requests, insecure_domain_allows)
- runner/app.py
