---
title: Passkeys and passwords
section: Admin access and identity
verified: 2026-05-20
sources: api/src/services/admin-passkey.ts, api/src/services/admin-auth.ts, api/src/services/admin-password.ts, api/src/routes/admin/auth/index.ts, api/src/db/schema.ts, api/src/security/password.ts
---

Passkeys (WebAuthn) are the preferred way to sign in. Password auth exists but is second-class: there is no self-service reset by default, passwords enforce a minimum length, and any user with a registered passkey is locked out of password login.

## The account page

Signed-in admins manage their credentials at `/admin/account` (password tab) and `/admin/account/passkeys`. Both are served by the SvelteKit SPA; the back end is the `/admin/auth/*` and `/admin/passkeys/*` routes registered in `api/src/routes/admin/auth/index.ts`.

## Registering a passkey

1. The page calls `POST /admin/auth/passkey/register/options`.
2. The server delegates to `AdminPasskeyService.beginRegistration` (`api/src/services/admin-passkey.ts`), which stores a challenge in `admin_webauthn_challenges` and returns `PublicKeyCredentialCreationOptions`.
3. The browser runs the WebAuthn ceremony and POSTs the attestation to `POST /admin/auth/passkey/register`.
4. `AdminPasskeyService.completeRegistration` verifies the attestation, stores the credential in `admin_passkeys`, and returns the new row.

The relying-party metadata comes from `ADMIN_WEBAUTHN_RP_ID`, `ADMIN_WEBAUTHN_ORIGIN`, and `ADMIN_WEBAUTHN_RP_NAME` (env-validated in `api/src/env.ts` — `RP_ID` set without `ORIGIN` fails fast). If you are seeing "invalid origin" errors, set these explicitly.

## Logging in with a passkey

1. User types their username; the login form calls `POST /admin/auth/login/method` which returns `"passkey"` when `AdminAuthService.resolveLoginMethod` finds a registered credential.
2. The client calls `POST /admin/auth/passkey/login/options`; `beginAuthentication` returns a `PublicKeyCredentialRequestOptions` and stores a challenge.
3. Browser produces an assertion; client POSTs it to `POST /admin/auth/passkey/login`.
4. `completeAuthentication` verifies the assertion (signature, challenge, counter), then delegates to `AdminAuthService.createSession` which sets the session cookie.

If the user has *any* registered passkey, password login is refused with HTTP 403 (`passkey_required`). If they have none, password login is allowed — but the account page shows a large "Add a passkey" nudge.

## Managing passkeys

Three endpoints are wired into the account UI:

- `GET /admin/passkeys` — list the current user's credentials. Each entry carries `id`, friendly name, created-at, last-used-at, AAGUID, and the transports reported at registration.
- `POST /admin/passkeys/{id}/name` — rename a passkey.
- `DELETE /admin/passkeys/{id}` — delete a passkey.

All three require an active session and use the session user implicitly; you cannot touch another admin's passkeys through these endpoints.

## Passwords

The minimum length is `PASSWORD_MIN_LENGTH = 12` (constant in `api/src/services/admin-auth.ts`). Hashes are argon2 (via `api/src/security/password.ts`); legacy bcrypt and phpass hashes verify transparently and are rehashed to argon2 on the next successful login.

Change the current user's password:

- `POST /admin/auth/password/change` with `{ current_password, new_password }`. Validation failures throw 422 with a structured error the SPA surfaces as form errors.

Password reset (request + confirm):

- `POST /admin/auth/password/request` creates a reset token only when SMTP is configured (`SMTP_HOST`, `SMTP_PORT`, `SMTP_FROM`, etc.) and the user is not passkey-only.
- `POST /admin/auth/password/reset` consumes a reset token. Tokens live in `admin_password_resets`.

If the reset flow is disabled, the recovery path is: another admin opens *Settings → Users*, sets a temporary password, the target admin logs in with it, and then changes it immediately.

## Locked out of every passkey?

There is no shipped recovery CLI in the current stack. Recovery is done by an operator with direct database access — delete the affected row(s) from `admin_passkeys` and have the user re-enrol on next login. (If you are the last admin and have lost your only passkey, you will need the same DB access to either delete your row or re-set the password hash via SQL.)

## Counter drift and cloned authenticators

WebAuthn credentials carry a monotonically increasing signature counter. `completeAuthentication` compares the incoming counter to the stored one; a decrease means the credential has been cloned or the authenticator is misbehaving, and the login fails. This is standard WebAuthn defence-in-depth; users with non-compliant hardware may occasionally need their passkey removed and re-registered.

## Source references

- api/src/services/admin-passkey.ts (registration, authentication, management)
- api/src/services/admin-auth.ts (session creation, requiresPasskey, password length)
- api/src/services/admin-password.ts (password change + reset flows)
- api/src/security/password.ts (argon2 hashing + bcrypt/phpass legacy verify)
- api/src/routes/admin/auth/index.ts (every /admin/auth/* and /admin/passkeys/* route)
- api/src/db/schema.ts (admin_passkeys, admin_webauthn_challenges, admin_password_resets)
