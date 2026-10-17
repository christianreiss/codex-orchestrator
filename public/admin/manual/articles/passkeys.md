---
title: Passkeys and passwords
section: Admin access and identity
verified: 2026-10-17
sources: api/src/services/admin-passkey.ts, api/src/services/admin-auth.ts, api/src/services/admin-password.ts, api/src/services/mailer.ts, api/src/routes/admin/auth/index.ts, api/src/db/schema.ts, api/src/security/password.ts, frontend/src/routes/account/+page.svelte, frontend/src/lib/components/account/PasswordForm.svelte, frontend/src/lib/components/account/PasskeyList.svelte, frontend/src/lib/constants/password.ts, frontend/src/lib/components/users/userSchema.ts
---

Passkeys (WebAuthn) are the preferred way to sign in. Password auth exists but is second-class: there is no self-service reset by default, passwords enforce minimum requirements, and any user with a registered passkey is locked out of password login.

## The account section

Signed-in admins manage their credentials on one **Account** page (`/account`, in the sidebar footer; the old `/account/password`, `/account/passkeys`, `/account/theme` and `/account/devices` pages are now sections of it). It has four sections:

- **Profile**
- **Security** (`/account#security`) — **Password** (change password and request a password reset email) and **Passkeys** (register and manage WebAuthn credentials)
- **Appearance** (`/account#appearance`) — theme settings
- **Android devices** (`/account#devices`)

The user menu links straight to `#security`, `#appearance`, and `#devices`. The page is served by the SvelteKit SPA; the back end is the `/admin/auth/*` and `/admin/passkeys/*` routes registered in `api/src/routes/admin/auth/index.ts`.

## Registering a passkey

1. The **Add passkey** button in the Passkeys block of the Account page's Security section calls `POST /admin/auth/passkey/register/options`.
2. The server delegates to `AdminPasskeyService.beginRegistration` (`api/src/services/admin-passkey.ts`), which stores a challenge in `admin_webauthn_challenges` and returns `PublicKeyCredentialCreationOptions`.
3. The browser runs the WebAuthn ceremony and POSTs the attestation to `POST /admin/auth/passkey/register`.
4. `AdminPasskeyService.completeRegistration` verifies the attestation, stores the credential in `admin_passkeys`, and returns the new row.
5. The browser immediately prompts the user to name the new passkey via a PasskeyNameDialog; if the dialog is cancelled the passkey persists unnamed.

If WebAuthn is not supported by the browser, the page shows a warning alert and the **Add passkey** button is unavailable.

The relying-party metadata comes from `ADMIN_WEBAUTHN_RP_ID`, `ADMIN_WEBAUTHN_ORIGIN`, and `ADMIN_WEBAUTHN_RP_NAME` (env-validated in `api/src/env.ts` — `RP_ID` set without `ORIGIN` fails fast). If you are seeing "invalid origin" errors, set these explicitly.

## Logging in with a passkey

1. User types their username; the login form calls `POST /admin/auth/login/method` which returns `"passkey"` when `AdminAuthService.resolveLoginMethod` finds a registered credential.
2. The client calls `POST /admin/auth/passkey/login/options`; `beginAuthentication` returns a `PublicKeyCredentialRequestOptions` and stores a challenge.
3. Browser produces an assertion; client POSTs it to `POST /admin/auth/passkey/login`.
4. `completeAuthentication` verifies the assertion (signature, challenge, counter), then delegates to `AdminAuthService.createSession` which sets the session cookie.

If the user has *any* registered passkey, password login is refused with HTTP 403 (`passkey_required`). If they have none, password login is allowed.

## Managing passkeys

The Passkeys block of the Account page's Security section (`/account#security`) renders a table of registered passkeys with the columns **Name**, **Created**, and **Last used**, plus a per-row actions menu. Created and Last used display relative time with an absolute timestamp tooltip (Last used reads *Never* for an unused passkey).

- **Rename** in the row menu opens an inline input in the Name cell with save and cancel buttons.
- **Remove** in the row menu opens a confirmation dialog before calling `DELETE /admin/passkeys/{id}`.

When no passkeys are registered, an empty state reading *No passkeys registered* is shown in place of the table; **Add passkey** stays available above it.

Three endpoints are wired into this UI:

- `GET /admin/passkeys` — list the current user's credentials (id, name, created-at, last-used-at).
- `POST /admin/passkeys/{id}/name` — rename a passkey; body: `{ name }`.
- `DELETE /admin/passkeys/{id}` — delete a passkey.

All three require an active session and operate on the session user implicitly; you cannot touch another admin's passkeys through these endpoints.

## Passwords

Password requirements differ between the backend and the frontend forms that create/change one:

- The backend (`AdminAuthService.validatePasswordOrThrow`) enforces only a minimum length, `PASSWORD_MIN_LENGTH = 12` — no digit, symbol, or character-class check. This is the only rule applied to `POST /admin/auth/password/change`, `POST /admin/auth/password/reset`, and `POST /admin/users` (create/update).
- The frontend applies one shared client-side rule (`frontend/src/lib/constants/password.ts`) to both the Password form on the Account page and the **People** (admin users) create/edit form (`frontend/src/lib/components/users/userSchema.ts`): 12+ characters plus at least two of {lowercase, uppercase, digit, symbol} — see [Roles and capabilities](/admin/manual/roles). The earlier, stricter digit-and-symbol rule on the self-service page is gone.

The Password form on the Account page displays a live rule checklist that updates as the user types. Hashes are argon2 (via `api/src/security/password.ts`); legacy bcrypt and phpass hashes verify transparently and are rehashed to argon2 on the next successful login.

### Changing your password

The **Change password** form in the Password block of the Account page's Security section has three fields:

- Current password
- New password
- Confirm new password

Submit calls `POST /admin/auth/password/change` with body `{ current_password, new_password, confirm_password }`. Validation failures return HTTP 422 with a structured error that the SPA surfaces as inline form errors.

### Resetting a password by email

Under the form, **Lost access? Reset by email** opens a *Send password reset?* confirmation dialog with a **Send reset email** button; on confirm the page calls `POST /admin/auth/password/request` using the current signed-in username automatically — no email input is shown. The endpoint's schema accepts either `{ username }` or `{ email }` as identifier, but `AdminPasswordService.requestReset` only ever looks the user up by username internally — passing `email` never resolves a real account (it falls through to the equivalent-cost "unknown user" path) unless it happens to also be that user's username. The shipped UI is unaffected since it always sends `{ username }`.

Delivering the email needs `SMTP_HOST` set (`api/src/services/mailer.ts`); the other `SMTP_*` vars are optional with fallbacks. Without `SMTP_HOST`, no email goes out, but a 1-hour reset token is still created in `admin_password_resets` and the endpoint always reports success.

`POST /admin/auth/password/reset` consumes the reset token. Tokens live in `admin_password_resets`.

If SMTP isn't configured, the recovery path is: another owner or admin opens the **People** section of **Access** (`/access#people`), sets a temporary password, the target admin logs in with it, and then changes it immediately.

## Locked out of every passkey?

There is no shipped recovery CLI in the current stack. Recovery is done by an operator with direct database access — delete the affected row(s) from `admin_passkeys` and have the user re-enrol on next login. (If you are the last admin and have lost your only passkey, you will need the same DB access to either delete your row or re-set the password hash via SQL.)

## Counter drift and cloned authenticators

WebAuthn credentials carry a monotonically increasing signature counter. `@simplewebauthn/server`'s `verifyAuthenticationResponse` (called from `completeAuthentication`) rejects the assertion whenever the incoming counter is not strictly greater than the stored one (an exact repeat included, not just a decrease) — unless both are `0`, which signals an authenticator that doesn't support counters at all. A rejection here means the credential has likely been cloned or the authenticator is misbehaving. This is standard WebAuthn defence-in-depth; users with non-compliant hardware may occasionally need their passkey removed and re-registered.

## Source references

- api/src/services/admin-passkey.ts (registration, authentication, management, counter-drift check via @simplewebauthn/server)
- api/src/services/admin-auth.ts (session creation, requiresPasskey, backend password-length-only validation)
- api/src/services/admin-password.ts (password change + reset flows; requestReset only looks up by username)
- api/src/services/mailer.ts (NoopMailer vs SmtpMailer, SMTP_HOST-gated delivery)
- api/src/security/password.ts (argon2 hashing + bcrypt/phpass legacy verify)
- api/src/routes/admin/auth/index.ts (every /admin/auth/* and /admin/passkeys/* route)
- api/src/db/schema.ts (admin_passkeys, admin_webauthn_challenges, admin_password_resets)
- frontend/src/lib/components/account/PasswordForm.svelte, frontend/src/lib/components/account/PasskeyList.svelte (Account page Security section: password form, passkey table)
- frontend/src/lib/constants/password.ts (shared client password rule: length + 2-of-4 classes)
- frontend/src/lib/components/users/userSchema.ts (People form password schema)
