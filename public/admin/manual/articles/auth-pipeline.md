---
title: The auth distribution pipeline
section: Fleet operations
verified: 2026-04-19
sources: src/Services/AuthService.php, src/Services/InsecureHostWindowService.php, src/Services/RunnerVerifier.php, src/Services/ReverseDnsValidator.php, src/Http/Controllers/AuthController.php, src/Security/SecretBox.php, src/Security/EncryptionKeyManager.php, src/Repositories/AuthPayloadRepository.php, src/Repositories/HostAuthDigestRepository.php, runner/app.py
---

Every host gets its credentials by asking the orchestrator; the orchestrator is the single writer of canonical `auth.json`. The pipeline is built around three requirements: **encrypt at rest**, **authenticate the caller**, and **refuse to hand out anything a compromised host should not have**.

## The two public endpoints

- `POST /auth` — the host says "I am $api_key, my IP is $remote, here is my wrapper fingerprint" and receives either the decrypted auth payload or a structured refusal. Handler: `AuthController::auth` → `AuthService::handleAuth()`.
- `POST /sync/status` / `POST /sync/bootstrap` — lighter sync endpoints the wrappers hit on every run, handled by the same controller. These use the per-host auth digest (`HostAuthDigestRepository`) so "nothing changed" is cheap.

Both routes take the per-host API key in the body; there is no header-based flavor.

## `AuthService::handleAuth()` in order

The actual method is `src/Services/AuthService.php:478` and is long; the decision tree in plain English:

1. **Authenticate the API key.** `authenticate()` (`AuthService:202`) resolves the key hash against `HostRepository`, applying IP binding and reverse-DNS rules as configured. First-ever call from a given IP binds the key to that IP unless roaming is on.
2. **Check the insecure window.** `InsecureHostWindowService::assertInsecureHostWindow()` tests whether the host is currently allowed to receive auth at all. If insecure and outside its grace window, an `InsecureAuthRequestRepository` row is created and the caller sees a refusal.
3. **Verify reverse DNS if required.** `ReverseDnsValidator` takes the remote IP plus the host's `fqdn` and either requires the PTR to match (strict mode) or accepts anything (off).
4. **Resolve the canonical payload.** `AuthPayloadRepository::latestDecrypted()` decrypts the most recent `auth_payloads` row under the current keyring (`EncryptionKeyManager`).
5. **Optionally call the runner.** For first-time delivery to a host, `RunnerVerifier::verify()` (`src/Services/RunnerVerifier.php:45`) runs a cheap completion against the auth to make sure it still works before handing it out. Same for Claude via `verifyClaude`. If the runner call fails or `AUTH_RUNNER_URL` is not set, `skipRunner=true` is honoured.
6. **Stamp the per-host digest.** The host's `HostAuthDigestRepository` row is updated so subsequent `/sync/status` calls can short-circuit when nothing has changed.
7. **Return the payload** and log a line to `LogRepository`.

Every branch that refuses auth records *why*; the refusal codes are what you see on the host detail page as "last auth status".

## Encryption

Payloads are encrypted with libsodium's `crypto_secretbox` through `App\Security\SecretBox`. The active key comes from `EncryptionKeyManager`, which supports multiple active keys for rotation:

- The newest key encrypts all new writes.
- Decryption tries each known key in order until one works.
- Adding a new key and letting `AuthEncryptionMigrator::runOnce()` re-encrypt existing rows is the supported rotation path.

Lose all the keys and the encrypted rows are bricks. Back up the keyring.

## IP binding and roaming

Each row in `hosts` has `ip_binding`, `ip_binding_roaming`, and (per-key) a `first_seen_ip` columns. `authenticate()` behaviour:

- First successful auth sets `first_seen_ip`.
- Subsequent requests must come from `first_seen_ip` unless `ip_binding_roaming = 1`.
- Roaming allows the binding to migrate to the newest IP, but the move itself is logged.

Toggle per-host at `POST /admin/hosts/{id}/roaming` (`AdminHostController::roaming`). Toggle reverse-DNS enforcement at `POST /admin/hosts/{id}/reverse-dns` (per-host override) or in *Settings → General* for the fleet-wide default.

## Insecure windows

An insecure host is one where you do not trust the machine to hold credentials at rest. `InsecureHostWindowService` treats each "session" as a bounded window:

- `DEFAULT_INSECURE_WINDOW_MINUTES = 10`, clamp `0..MAX_INSECURE_WINDOW_MINUTES = 480`.
- `DEFAULT_INSECURE_GRACE_MINUTES = 60` — how long after the window ends the host can still refresh without needing a fresh approval.
- `DEFAULT_INSECURE_SESSION_MAX_MINUTES = 480`, hard cap `MAX_INSECURE_SESSION_MAX_MINUTES = 1440`.

All four are `AuthService` constants (`AuthService:44–51`). `openInitialInsecureWindow()` is called during registration when the host is registered insecure; from there, every subsequent *allow* on the approval queue opens a new window.

## The runner contract

`runner/app.py` exposes two HTTP endpoints the PHP app uses:

- `POST /verify` — takes an `auth.json` blob, tries a tiny completion, returns `ok` + model info. Success means "this auth will work for the host".
- `POST /exec` — used by Claude admin helpers (e.g. skill generation, skill assists) to run a prompt with a specific auth.

Both are authenticated by a shared secret header derived from `AUTH_RUNNER_SHARED_SECRET`. `RunnerValidationService` also pings `/verify` from the admin *Run probe* button to surface runner health in the dashboard.

## What a client sees

A successful handshake returns the decrypted `auth.json` body plus client-facing metadata (wrapper version, AGENTS.md hash, skills manifest) so the wrapper can decide whether it needs a follow-up `/sync/bootstrap`. The sync contract details are in [wrappers](/admin/manual/wrappers).

## Killing the pipeline in an emergency

- **Fleet kill-switch**: flip the API-disabled flag in *Settings → OpenAI* (`openai_api_disabled` on `VersionRepository`). The `/auth` endpoint itself is not disabled, but all downstream API traffic returns 503 and hosts see quota-exhausted errors. For Claude: `claude_api_disabled`.
- **Delete a host**: `DELETE /admin/hosts/{id}`. The host's API key is invalidated; future `/auth` calls fail authentication.
- **Purge insecure creds immediately**: `POST /admin/hosts/{id}/insecure/disable` — closes the window, forcing the host back into the approval queue.

## Source references

- src/Services/AuthService.php (handleAuth, authenticate, registration, insecure constants)
- src/Services/InsecureHostWindowService.php (window/grace maths, approvals)
- src/Services/RunnerVerifier.php (verify, verifyClaude)
- src/Services/RunnerValidationService.php (admin probe)
- src/Services/ReverseDnsValidator.php
- src/Http/Controllers/AuthController.php (POST /auth, /sync/status, /sync/bootstrap)
- src/Security/SecretBox.php, src/Security/EncryptionKeyManager.php
- src/Services/AuthEncryptionMigrator.php (rotation)
- src/Repositories/AuthPayloadRepository.php, src/Repositories/HostAuthDigestRepository.php
- src/Repositories/InsecureAuthRequestRepository.php, src/Repositories/InsecureDomainAllowRepository.php
- runner/app.py
