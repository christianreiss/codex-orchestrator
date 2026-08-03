---
title: Admin login and access
section: Admin access and identity
verified: 2026-07-01
sources: api/src/http/plugins/auth-admin.ts, api/src/http/plugins/auth-mtls.ts, api/src/security/mtls.ts, api/src/http/plugins/client-ip.ts, api/src/services/admin-auth.ts, api/src/services/admin-passkey.ts, api/src/services/admin-password.ts, api/src/services/mailer.ts, api/src/routes/admin/auth/index.ts, api/src/routes/admin/pages/static.ts, api/src/routes/cli-auth/index.ts, api/src/env.ts, caddy/Caddyfile, frontend/src/routes/login/+page.svelte
---

The admin surface has one gate: a session cookie, enforced once at least one admin user exists. Transport security is whatever your proxy provides. This server does not issue, request or verify client certificates.

## Access modes

`ADMIN_ACCESS_MODE` is parsed by `api/src/env.ts` (enum `cookie` | `open`, default `cookie`). It gates exactly one thing: whether `GET /cli/auth/verify` (the CLI device-approval HTML page) requires an admin session — any value other than `open` requires one (`api/src/routes/cli-auth/index.ts`). It does **not** change what `app.requireAdmin`/`resolveAdmin` (`api/src/http/plugins/auth-admin.ts`) check — those are mode-unaware. The `mtls` value was removed when this server stopped issuing certificates; on that one route it had always meant the same as `cookie`.

## Client certificates

The bundled `caddy` profile terminates TLS and reverse-proxies every path to the API with one rule. It does not request client certificates, and there is no `/admin*` certificate gate any more — the previous one lived in a separate Caddy fragment, generated its own CA and client certificate at install time, and enforced nothing the admin session did not already enforce.

A proxy *you* run may still terminate mTLS. If it forwards `X-MTLS-Fingerprint`, `X-MTLS-Subject` or `X-MTLS-Issuer`, `parseMtls` (`api/src/security/mtls.ts`) records them on `req.mtls` — but only when the connecting peer falls inside `TRUSTED_PROXY_CIDRS` with `TRUST_X_FORWARDED=1` (`api/src/http/plugins/client-ip.ts`). Anything arriving from another peer is discarded, because a direct caller can type those headers as easily as a proxy can. Both settings default to off, so an unconfigured server records nothing. No route consults `req.mtls` for an authorization decision.

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
- TTL: `ADMIN_SESSION_TTL_MINUTES`, default 43200 (30 days). The cookie's `expires` attribute is set once, at login, from `AdminAuthService.sessionTtlSeconds()` (`api/src/services/admin-auth.ts`), which clamps the configured minutes to between 5 minutes and 7 days — so with the default config the cookie the browser receives expires 7 days after login. `applySessionCookie` is only called from the login routes, so the cookie is never reissued afterward.
- Stored as `sha256(token)` in `admin_sessions`. The plain token lives only in the user's cookie and never hits the database.
- Every request that passes through `requireAdmin`/`resolveAdmin` touches `lastSeenAt` and pushes the **database row's** `expires_at` forward, using a separate clamp defined in `api/src/http/plugins/auth-admin.ts` (5 minutes to 30 days). This extends the stored row but not the browser's cookie, so for the shipped SPA the 7-day cookie lifetime set at login is the effective session limit in practice. If the row is past `expires_at`, the row is filtered out and the request is treated as unauthenticated — this normally only matters if a caller replays the raw token outside the cookie the browser already expired.

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

When the login page loads, if the browser supports `PublicKeyCredential` and the user is not already signed in and the username field is empty, the page immediately calls `submitPasskey(true)`. This sends an empty-username `POST /admin/auth/passkey/login/options`. Server-side, `AdminPasskeyService.beginAuthentication` (`api/src/services/admin-passkey.ts`) treats a blank username as "the only active admin user": it succeeds only when exactly one active row exists in `admin_users`, and builds `allowCredentials` from that user's registered passkeys. This is a normal, non-resident WebAuthn ceremony scoped server-side to one account — passkeys are registered with `authenticatorSelection.residentKey: 'discouraged'`, not as discoverable/username-less credentials. Once a second admin user is active, the blank-username lookup always fails and the page silently reverts to the `username` phase with no error shown; the same silent revert happens if the browser prompt is dismissed or the ceremony fails for any other reason. In practice, this means users are often authenticated before typing anything only on installs with a single active admin account.

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

`/admin/auth/password/request` and `/admin/auth/password/reset` exist, but delivering the email needs `SMTP_HOST` set (`api/src/services/mailer.ts`); `SMTP_PORT`/`SMTP_USERNAME`/`SMTP_PASSWORD`/`SMTP_FROM` are optional with fallbacks. Without `SMTP_HOST`, `createMailer` returns a `NoopMailer` that never contacts a server — but `AdminPasswordService.requestReset` still creates and stores a 1-hour reset token in `admin_password_resets` and the endpoint always reports `{ delivered: true }` regardless; the token only surfaces in the API's warn-level logs. So the flow isn't truly disabled without SMTP, there's just no email for the end user to click. Use passkeys.

## Failure modes you will see

- **401 Admin session required** — session cookie missing or expired, and the route is gated by `requireAdmin`. Note that `/admin/auth/logout` is also gated; calling it without a valid session returns 401.
- **403 Passkey login required for this user** — the user has at least one registered passkey and cannot fall back to password. Remove the passkey from *Account → Passkeys* if you need to restore password access.

## Source references

- api/src/http/plugins/auth-admin.ts (requireAdmin decorator, resolveAdmin, cookie validation, session-row rolling clamp)
- api/src/http/plugins/auth-mtls.ts, api/src/security/mtls.ts, api/src/http/plugins/client-ip.ts (proxy-forwarded mTLS claims into req.mtls, gated on TRUSTED_PROXY_CIDRS; not itself an authorization check)
- api/src/services/admin-auth.ts (login, sessions, session-cookie TTL clamp, password verification + rehash)
- api/src/services/admin-passkey.ts (WebAuthn registration + assertion, residentKey: 'discouraged', single-active-user lookup)
- api/src/services/admin-password.ts (password reset token lifecycle)
- api/src/services/mailer.ts (NoopMailer vs SmtpMailer, SMTP_HOST-gated delivery)
- api/src/routes/admin/auth/index.ts (every /admin/auth/* route)
- api/src/routes/admin/pages/static.ts (SPA shell preHandler)
- api/src/routes/cli-auth/index.ts (the only route that reads ADMIN_ACCESS_MODE)
- api/src/env.ts (ADMIN_ACCESS_MODE, ADMIN_SESSION_TTL_MINUTES defaults)
- caddy/Caddyfile (TLS termination and reverse proxy; no client-certificate gate)
- frontend/src/routes/login/+page.svelte (login page state machine, auto-passkey, phase transitions)
