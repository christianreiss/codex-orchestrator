---
title: Admin login and mTLS
section: Admin access and identity
verified: 2026-05-20
sources: api/src/http/plugins/auth-admin.ts, api/src/http/plugins/auth-mtls.ts, api/src/security/mtls.ts, api/src/services/admin-auth.ts, api/src/services/admin-passkey.ts, api/src/routes/admin/auth/index.ts, api/src/routes/admin/pages/static.ts
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

- `/admin/auth/status`
- `/admin/auth/login`
- `/admin/auth/login/method`
- `/admin/auth/logout`
- `/admin/auth/password/request`
- `/admin/auth/password/reset`
- `/admin/auth/passkey/login/options`
- `/admin/auth/passkey/login`

Plus the CLI-auth device-code entry points (`/cli/auth/start`, `/cli/auth/poll/*`). Everything else under `/admin/*` demands a session via `requireAdmin`.

## The session cookie

- Name: `ADMIN_SESSION_COOKIE`, default `codex_admin_session`.
- TTL: `ADMIN_SESSION_TTL_MINUTES`, default 720 (12 h), clamped to 5 min – 7 days (`AdminAuthService.sessionTtlSeconds`).
- Stored as `sha256(token)` in `admin_sessions`. The plain token lives only in the user's cookie and never hits the database.
- Sessions are touched on every resolve (`lastSeenAt`) so active sessions do not expire during use. If the row is past `expires_at`, the row is filtered out and the request is treated as unauthenticated.

## The SPA bootstrap

The API serves the SvelteKit SPA's HTML shell via `adminSpaHtmlPreHandler` (`api/src/routes/admin/pages/static.ts`) for any `/admin/*` GET that advertises `Accept: text/html`. Once the page is loaded, the client hydrates by calling `GET /admin/auth/status`; that endpoint returns:

```
{
  "enforced": <bool>,
  "authenticated": <bool>,
  "user": { "id": …, "username": …, "name": …, "access_level": … } | null
}
```

The SvelteKit router then decides what to render. There is no server-rendered `window.__adminBootstrap` blob anymore.

## The login flow (passkey first)

The login page calls `POST /admin/auth/login/method` (`AdminAuthService.resolveLoginMethod`). The server returns either `"passkey"` or `"password"` based on whether the user has any registered credentials.

- **Passkey path.** The client requests WebAuthn options from `POST /admin/auth/passkey/login/options`, performs the ceremony in the browser, then submits the assertion to `POST /admin/auth/passkey/login`. On success the server calls `createSession()` which sets the cookie and writes an `admin.auth.login` event row.
- **Password path.** `POST /admin/auth/login` with JSON `{ username, password }`. Verification uses `api/src/security/password.ts`, which understands argon2, bcrypt, and the legacy phpass hashes; if a legacy hash verifies, it is silently rehashed to argon2 on the same login.

Both paths return the same envelope: `{ token, expires_at, user }`. The token is set as the session cookie by `applySessionCookie` and the browser persists it.

## Sign-out

`POST /admin/auth/logout` (`AdminAuthService.logoutByToken`) deletes the session row by token hash and clears the cookie. The client-side handler is wired to the Logout button in the account menu.

## Password reset

Password reset is **self-disabled by default**. `/admin/auth/password/request` and `/admin/auth/password/reset` exist but require the `Mailer` service to be configured with SMTP credentials (`SMTP_HOST`, `SMTP_PORT`, `SMTP_USERNAME`, `SMTP_PASSWORD`, `SMTP_FROM`). Without SMTP, the request endpoint short-circuits without sending. Use passkeys.

## Failure modes you will see

- **403 Client certificate required** — `ADMIN_ACCESS_MODE=mtls` but the proxy is not forwarding the fingerprint header. Check the Caddy config.
- **401 Admin session required** — session cookie missing or expired, and the route is gated by `requireAdmin`.
- **403 Passkey login required for this user** — the user has at least one registered passkey and cannot fall back to password. Remove the passkey from *Account → Passkeys* if you need to restore password access.

## Source references

- api/src/http/plugins/auth-admin.ts (requireAdmin decorator, resolveAdmin, cookie validation)
- api/src/http/plugins/auth-mtls.ts, api/src/security/mtls.ts (mTLS header parsing)
- api/src/services/admin-auth.ts (login, sessions, password verification + rehash)
- api/src/services/admin-passkey.ts (WebAuthn registration + assertion)
- api/src/routes/admin/auth/index.ts (every /admin/auth/* route)
- api/src/routes/admin/pages/static.ts (SPA shell preHandler)
