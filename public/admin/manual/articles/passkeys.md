---
title: Passkeys and passwords
section: Admin access and identity
verified: 2026-04-19
sources: src/Services/AdminPasskeyService.php, src/Services/AdminAuthService.php, src/Http/Controllers/AdminAuthController.php, src/Repositories/AdminPasskeyRepository.php, src/Repositories/AdminWebAuthnChallengeRepository.php, public/admin/assets/passkeys.js, public/admin/assets/login.js, public/admin/index.html
---

Passkeys (WebAuthn) are the preferred way to sign in. Password auth exists but is second-class: there is no self-service reset, passwords enforce a minimum length, and any user with a registered passkey is locked out of password login.

## The account page

Signed-in admins manage their credentials at `/admin/account` (password tab) and `/admin/account/passkeys`. Both are served by `AdminPageController::account()` and rendered by `public/admin/assets/account.js` + `public/admin/assets/passkeys.js`. The same left-rail disclosure hides these links from unauthenticated sessions (`data-nav="account"` toggled by the bootstrap).

## Registering a passkey

1. The page calls `POST /admin/auth/passkey/register/options` (`AdminAuthController::passkeyRegisterOptions`).
2. The server delegates to `AdminPasskeyService::beginRegistration()`, which stores a challenge in `admin_webauthn_challenges` (via `AdminWebAuthnChallengeRepository`) and returns `PublicKeyCredentialCreationOptions`.
3. The browser runs the WebAuthn ceremony and POSTs the attestation to `/admin/auth/passkey/register`.
4. `AdminPasskeyService::completeRegistration()` verifies the attestation, stores the credential in `admin_passkeys`, and returns the new row.

The relying-party metadata comes from `AdminSessionHelper::adminWebAuthnRpId/rpName/origin`, which prefer the explicit `ADMIN_WEBAUTHN_RP_ID` / `ADMIN_WEBAUTHN_RP_NAME` / `ADMIN_WEBAUTHN_ORIGIN` config, then fall back to parsing `PUBLIC_BASE_URL`, then to the incoming `Host` header. If you are seeing "invalid origin" errors, set these explicitly.

## Logging in with a passkey

1. User types their username; the login form calls `POST /admin/auth/login/method` which returns `"passkey"` when `requiresPasskey()` is true.
2. The client calls `POST /admin/auth/passkey/login/options`; `AdminPasskeyService::beginAuthentication()` returns a `PublicKeyCredentialRequestOptions` and stores a challenge.
3. Browser produces an assertion; client POSTs it to `/admin/auth/passkey/login`.
4. `AdminPasskeyService::completeAuthentication()` verifies the assertion (signature, challenge, counter), then delegates to `AdminAuthService::createSessionForUser()` which sets the session cookie.

If the user has *any* registered passkey, password login is refused with HTTP 403. If they have none, password login is allowed — but the account page shows a large "Add a passkey" nudge.

## Managing passkeys

Three endpoints are wired into the account UI:

- `GET /admin/passkeys` (`AdminAuthController::passkeyList`) — list the current user's credentials. Each entry carries `id`, friendly name, created-at, last-used-at, AAGUID, and the transports reported at registration.
- `POST /admin/passkeys/{id}/name` — rename a passkey (`AdminPasskeyService::updatePasskeyName`).
- `DELETE /admin/passkeys/{id}` — delete a passkey (`AdminPasskeyService::deletePasskey`).

All three require an active session and use the session user implicitly; you cannot touch another admin's passkeys through these endpoints.

## Passwords

The minimum length is controlled by `ADMIN_PASSWORD_MIN_LENGTH` (default 12, clamped 8–128, see `AdminAuthService::passwordMinLength`). Hashes use PHP's `PASSWORD_DEFAULT`; `password_needs_rehash` is checked on every successful login and rehashes transparently.

Change the current user's password:

- `POST /admin/auth/password/change` with `{ current_password, new_password }`. Validation failures throw `ValidationException`, which the admin UI surfaces as form errors.

Password reset (request + confirm):

- `POST /admin/auth/password/request` creates a reset token if and only if a `Mailer` implementation is configured and the user is not passkey-only. Out of the box there is no SMTP, so this endpoint is effectively disabled.
- `POST /admin/auth/password/reset` consumes a reset token. Tokens live in `admin_password_resets`.

If the reset flow is disabled, the recovery path is: another admin opens *Settings → Users*, sets a temporary password, the target admin logs in with it, and then changes it immediately.

## Counter drift and cloned authenticators

WebAuthn credentials carry a monotonically increasing signature counter. `completeAuthentication` compares the incoming counter to the stored one; a decrease means the credential has been cloned or the authenticator is misbehaving, and the login fails. This is standard WebAuthn defence-in-depth; users with non-compliant hardware may occasionally need their passkey removed and re-registered.

## Source references

- src/Services/AdminPasskeyService.php (registration, authentication, management)
- src/Services/AdminAuthService.php (session creation, password rehash, requiresPasskey)
- src/Http/Controllers/AdminAuthController.php (REST surface)
- src/Repositories/AdminPasskeyRepository.php
- src/Repositories/AdminWebAuthnChallengeRepository.php
- src/Repositories/AdminPasswordResetRepository.php
- public/admin/assets/passkeys.js, public/admin/assets/login.js
- public/admin/assets/account.js, public/admin/index.html (account panel)
