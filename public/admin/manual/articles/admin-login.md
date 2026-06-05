---
title: Admin login and mTLS
section: Admin access and identity
verified: 2026-06-05
sources: api/src/http/plugins/auth-admin.ts, api/src/http/plugins/auth-mtls.ts, api/src/security/mtls.ts, api/src/services/admin-auth.ts, api/src/services/admin-passkey.ts, api/src/routes/admin/auth/index.ts, api/src/routes/admin/pages/static.ts, frontend/src/routes/login/+page.svelte
---

The admin surface has two independent gates. **Transport** is enforced at the reverse proxy and re-read in the API; **identity** is enforced by a session cookie once at least one admin user exists.

## Access modes

`ADMIN_ACCESS_MODE` is parsed by `api/src/env.ts` and accepts:

- `mtls` — the default. The proxy must forward a valid client-certificate fingerprint via `X-MTLS-Fingerprint`; the `auth-mtls` plugin decorates every request with `req.mtls` (see `api/src/security/mtls.ts`).
- `cookie` — sessions are still required, but the transport-level mTLS check is skipped.
- `open` — no transport gate; useful for local development.

The proxy headers consumed are `X-MTLS-Fingerprint`, `X-MTLS-Subject`, `X-MTLS-Issuer`. If mTLS is required and the fingerprint is missing, requests are rejected before any session lookup happens.

## When session gating is active

`AdminAuthService.isEnforced()` returns true the moment `countAdmins(true)` is greater than zero. Until then you are on the first-run path: the admin UI lets you create the initial admin without a session. After that, every gated admin endpoint requires a valid session cookie.

The enforcement lives in the Fastify decorator `app.requireAdmin` (added by `api/src/http/plugins/auth-admin.ts`). Routes that do not attach `requireAdmin` are explicitly public — typically the auth endpoints themselves:

- `GET /admin/auth/status`
- `POST /admin/auth/login`
- `POST /admin/auth/login/method`
- `POST /admin/auth/password/request`
- `POST /admin/auth/password/reset`
- `POST /admin/auth/passkey/login/options`
- `POST /admin/auth/passkey/login`

Plus the CLI-auth device-code entry points (`/cli/auth/start`, `/cli/auth/poll/*`). Everything else under `/admin/*` demands a session via `requireAdmin`, including:

- `POST /admin/auth/logout`
- `POST /admin/auth/password/change`
- `POST /admin/auth/passkey/register/options`
- `POST /admin/auth/passkey/register`
- `GET /admin/passkeys`
- `POST /admin/passkeys/:id/name`
- `DELETE /admin/passkeys/:id`

## The session cookie

- Name: `ADMIN_SESSION_COOKIE`, default `codex_admin_session`.
- TTL: `ADMIN_SESSION_TTL_MINUTES`, default 720 (12 h), clamped to 5 min – 7 days (`AdminAuthService.sessionTtlSeconds`).
- Stored as `sha256(token)` in `admin_sessions`. The plain token lives only in the user's cookie and never hits the database.
- Sessions are touched on every resolve (`lastSeenAt`) so active sessions do not expire during use. If the row is past `expires_at`, the row is filtered out and the request is treated as unauthenticated.

## The SPA bootstrap

The API serves the SvelteKit SPA's HTML shell via `adminSpaHtmlPreHandler` (`api/src/routes/admin/pages/static.ts`) for any `/admin/*` GET that advertises `Accept: text/html`. Once the page is loaded, the client hydrates by calling `GET /admin/auth/status`; that endpoint returns:

```json
{
  "enforced": <bool>,
  "authenticated": <bool>,
  "user": { "id": …, "username": …, "name": …, "access_level": … } | null,
  "has_users": <bool>,
  "admin_count": <number>,
  "passkeys_registered": <number>,
  "passkey_login_available": <bool>
}
```

- `has_users` — whether any admin accounts exist yet (used to gate the first-run flow).
- `admin_count` — total number of admin accounts.
- `passkeys_registered` — number of passkeys registered to the currently authenticated user.
- `passkey_login_available` — true if any passkey is registered across all users.

The SvelteKit router then decides what to render. There is no server-rendered `window.__adminBootstrap` blob anymore.

## The login flow (passkey first)

The login page is a three-phase state machine: `username` → `password` or `passkey`.

### Auto-passkey on mount

When the login page loads, if the browser supports `PublicKeyCredential` and the user is not already signed in and the username field is empty, the page immediately calls `submitPasskey(true)`. This sends an empty-username `POST /admin/auth/passkey/login/options` and starts a discoverable-credential (resident-key) ceremony. If the browser prompt is dismissed or the attempt fails for any reason, the page silently reverts to the `username` phase with no error shown. This means users with a device-bound passkey are often authenticated before they type anything.

### Phase: username

Shows a username input and a **Continue** button. On submit, `POST /admin/auth/login/method` is called. The server returns `{ method: "password"|"passkey" }`. The client reads `res.methods` (array) first and falls back to `res.method` (scalar) for forward compatibility. The phase then transitions to `password` or `passkey` accordingly.

### Phase: password

Shows a password input, a **Sign in** button, and a **Use a different username** back-link. If the browser supports passkeys, an additional **Use a passkey instead** outline button is also rendered; clicking it switches directly to the `passkey` phase without re-querying the server.

On successful sign-in, `POST /admin/auth/login` is called with `{ username, password }`. The server verifies the password using `api/src/security/password.ts`, which understands argon2, bcrypt, and legacy phpass hashes; if a legacy hash verifies, it is silently rehashed to argon2 on the same login. On success the server returns `{ user, expires_at }` and sets the session token as a cookie via `applySessionCookie`. **The token is not present in the response body.** The audit event written is `admin.auth.login`.

### Phase: passkey

Shows descriptive text identifying the user and an **Authenticate with passkey** button (fingerprint icon). The client requests WebAuthn options from `POST /admin/auth/passkey/login/options`, performs the assertion ceremony in the browser, then submits the result to `POST /admin/auth/passkey/login`. On success the server returns `{ user, expires_at }` and sets the session cookie. **The token is not present in the response body.** The audit event written is `admin.auth.passkey.login`. After the ceremony the frontend calls `authActions.refresh()` (re-fetches `/admin/auth/status`) rather than the standard login action used by the password path.

## Password change

Authenticated admins can change their own password via `POST /admin/auth/password/change` (requires a valid session). The request body is `{ current_password, new_password, confirm_password }`. The endpoint delegates to `AdminPasswordService.changePassword` and returns `{ user }` on success.

## Sign-out

`POST /admin/auth/logout` (`AdminAuthService.logoutByToken`) requires a valid session (the route attaches `requireAdmin`). It deletes the session row by token hash and clears the cookie. The client-side handler is wired to the **Logout** button in the account menu.

## Password reset

Password reset is **self-disabled by default**. `/admin/auth/password/request` and `/admin/auth/password/reset` exist but require the `Mailer` service to be configured with SMTP credentials (`SMTP_HOST`, `SMTP_PORT`, `SMTP_USERNAME`, `SMTP_PASSWORD`, `SMTP_FROM`). Without SMTP, the request endpoint short-circuits without sending. Use passkeys.

## Failure modes you will see

- **403 Client certificate required** — `ADMIN_ACCESS_MODE=mtls` but the proxy is not forwarding the fingerprint header. Check the Caddy config.
- **401 Admin session required** — session cookie missing or expired, and the route is gated by `requireAdmin`. Note that `/admin/auth/logout` is also gated; calling it without a valid session returns 401.
- **403 Passkey login required for this user** — the user has at least one registered passkey and cannot fall back to password. Remove the passkey from *Account → Passkeys* if you need to restore password access.

## Source references

- api/src/http/plugins/auth-admin.ts (requireAdmin decorator, resolveAdmin, cookie validation)
- api/src/http/plugins/auth-mtls.ts, api/src/security/mtls.ts (mTLS header parsing)
- api/src/services/admin-auth.ts (login, sessions, password verification + rehash)
- api/src/services/admin-passkey.ts (WebAuthn registration + assertion)
- api/src/routes/admin/auth/index.ts (every /admin/auth/* route)
- api/src/routes/admin/pages/static.ts (SPA shell preHandler)
- frontend/src/routes/login/+page.svelte (login page state machine, auto-passkey, phase transitions)
