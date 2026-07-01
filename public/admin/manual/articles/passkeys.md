---
title: Passkeys and passwords
section: Admin access and identity
verified: 2026-07-01
sources: api/src/services/admin-passkey.ts, api/src/services/admin-auth.ts, api/src/services/admin-password.ts, api/src/services/mailer.ts, api/src/routes/admin/auth/index.ts, api/src/db/schema.ts, api/src/security/password.ts, frontend/src/routes/account/password/+page.svelte, frontend/src/lib/components/users/userSchema.ts
---

Passkeys (WebAuthn) are the preferred way to sign in. Password auth exists but is second-class: there is no self-service reset by default, passwords enforce minimum requirements, and any user with a registered passkey is locked out of password login.

## The account section

Signed-in admins manage their credentials under `/account/*`. A side-navigation bar (AccountSideNav) links to three pages:

- `/account/password` — change password and request a password reset email
- `/account/passkeys` — register and manage WebAuthn credentials
- `/account/theme` — appearance settings

Both credential pages are served by the SvelteKit SPA; the back end is the `/admin/auth/*` and `/admin/passkeys/*` routes registered in `api/src/routes/admin/auth/index.ts`.

## Registering a passkey

1. The `/account/passkeys` page calls `POST /admin/auth/passkey/register/options`.
2. The server delegates to `AdminPasskeyService.beginRegistration` (`api/src/services/admin-passkey.ts`), which stores a challenge in `admin_webauthn_challenges` and returns `PublicKeyCredentialCreationOptions`.
3. The browser runs the WebAuthn ceremony and POSTs the attestation to `POST /admin/auth/passkey/register`.
4. `AdminPasskeyService.completeRegistration` verifies the attestation, stores the credential in `admin_passkeys`, and returns the new row.
5. The browser immediately prompts the user to name the new passkey via a PasskeyNameDialog; if the dialog is cancelled the passkey persists unnamed.

If WebAuthn is not supported by the browser, the page shows a warning alert and the "Register passkey" button is unavailable.

The relying-party metadata comes from `ADMIN_WEBAUTHN_RP_ID`, `ADMIN_WEBAUTHN_ORIGIN`, and `ADMIN_WEBAUTHN_RP_NAME` (env-validated in `api/src/env.ts` — `RP_ID` set without `ORIGIN` fails fast). If you are seeing "invalid origin" errors, set these explicitly.

## Logging in with a passkey

1. User types their username; the login form calls `POST /admin/auth/login/method` which returns `"passkey"` when `AdminAuthService.resolveLoginMethod` finds a registered credential.
2. The client calls `POST /admin/auth/passkey/login/options`; `beginAuthentication` returns a `PublicKeyCredentialRequestOptions` and stores a challenge.
3. Browser produces an assertion; client POSTs it to `POST /admin/auth/passkey/login`.
4. `completeAuthentication` verifies the assertion (signature, challenge, counter), then delegates to `AdminAuthService.createSession` which sets the session cookie.

If the user has *any* registered passkey, password login is refused with HTTP 403 (`passkey_required`). If they have none, password login is allowed.

## Managing passkeys

The `/account/passkeys` page renders a "Registered credentials" card with a table showing four columns: **Name**, **Created**, **Last used**, and **Actions**. Created and Last used display relative time with an absolute timestamp tooltip.

- The Name cell has an inline edit control: clicking the pencil icon opens an inline input with save and cancel buttons.
- The Actions column has a delete (trash) icon button that opens a confirmation dialog before calling `DELETE /admin/passkeys/{id}`.

When no passkeys are registered, an empty-state card with a Fingerprint icon and a **Register your first passkey** button is shown in place of the table.

Three endpoints are wired into this UI:

- `GET /admin/passkeys` — list the current user's credentials (id, name, created-at, last-used-at).
- `POST /admin/passkeys/{id}/name` — rename a passkey; body: `{ name }`.
- `DELETE /admin/passkeys/{id}` — delete a passkey.

All three require an active session and operate on the session user implicitly; you cannot touch another admin's passkeys through these endpoints.

## Passwords

Password requirements differ between the backend and the two frontend forms that create/change one:

- The backend (`AdminAuthService.validatePasswordOrThrow`) enforces only a minimum length, `PASSWORD_MIN_LENGTH = 12` — no digit, symbol, or character-class check. This is the only rule applied to `POST /admin/auth/password/change`, `POST /admin/auth/password/reset`, and `POST /admin/users` (create/update).
- The `/account/password` page's zod schema is stricter: 12+ characters, and must contain a digit, and must contain a symbol (non-alphanumeric character) — both are mandatory, not "at least one of."
- The `Settings → Users` create/edit form uses a third rule (`passwordCharacterMix` in `frontend/src/lib/components/users/userSchema.ts`): 12+ characters plus at least two of {lowercase, uppercase, digit, symbol} — see [Roles and capabilities](/admin/manual/roles).

The `/account/password` page displays a live rule checklist that updates as the user types. Hashes are argon2 (via `api/src/security/password.ts`); legacy bcrypt and phpass hashes verify transparently and are rehashed to argon2 on the next successful login.

### Changing your password

The **Change password** card at `/account/password` has a form with three fields:

- Current password
- New password
- Confirm new password

Submit calls `POST /admin/auth/password/change` with body `{ current_password, new_password, confirm_password }`. Validation failures return HTTP 422 with a structured error that the SPA surfaces as inline form errors.

### Resetting a password by email

The **Reset by email** card has a **Send reset email** button. Clicking it opens a confirmation dialog; on confirm the page calls `POST /admin/auth/password/request` using the current signed-in username automatically — no email input is shown. The endpoint's schema accepts either `{ username }` or `{ email }` as identifier, but `AdminPasswordService.requestReset` only ever looks the user up by username internally — passing `email` never resolves a real account (it falls through to the equivalent-cost "unknown user" path) unless it happens to also be that user's username. The shipped UI is unaffected since it always sends `{ username }`.

Delivering the email needs `SMTP_HOST` set (`api/src/services/mailer.ts`); the other `SMTP_*` vars are optional with fallbacks. Without `SMTP_HOST`, no email goes out, but a 1-hour reset token is still created in `admin_password_resets` and the endpoint always reports success.

`POST /admin/auth/password/reset` consumes the reset token. Tokens live in `admin_password_resets`.

If SMTP isn't configured, the recovery path is: another admin opens *Settings → Users*, sets a temporary password, the target admin logs in with it, and then changes it immediately.

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
- frontend/src/routes/account/password/+page.svelte (self-service password-change zod schema: length + digit + symbol)
- frontend/src/lib/components/users/userSchema.ts (Settings → Users form password schema: length + 2-of-4 classes)
