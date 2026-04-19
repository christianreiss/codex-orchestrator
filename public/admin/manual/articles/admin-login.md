---
title: Admin login and mTLS
section: Admin access and identity
verified: 2026-04-19
sources: public/admin/index.php, src/Http/AdminSessionHelper.php, src/Http/SecurityHelper.php, src/Services/AdminAuthService.php, src/Http/Controllers/AdminAuthController.php, public/admin/assets/admin-auth.js, public/admin/assets/login.js, public/admin/login.html
---

The admin surface has two independent gates. **Transport** is enforced at the reverse proxy and checked again in PHP; **identity** is enforced by a session cookie once at least one admin user exists.

## Access modes

`AdminSessionHelper::adminAccessMode()` reads `ADMIN_ACCESS_MODE` and normalises the value:

- `mtls` — the default. The proxy must forward a valid client-certificate fingerprint; `SecurityHelper::isMtlsSatisfied()` requires `X-MTLS-Fingerprint` to be present and at least 64 hex characters.
- `none` — skip the fingerprint check. Any other value is coerced to `mtls`, never to `none`.

If mTLS is required and fails, `requireAdminAccess()` responds with `403 Client certificate required for admin access` immediately; no session lookup happens.

## When session gating is active

`AdminAuthService::isEnforced()` returns true the moment `AdminUserRepository::countAdmins(true)` is greater than zero. Until then you are on the first-run path: the admin UI lets you create the initial admin without a session. After that, every admin endpoint requires a valid session cookie.

The enforcement lives in `AdminSessionHelper::requireAdminAccess()`. Its bypass list (where no session is required even when enforcement is active) is exactly:

```
/admin/auth/status
/admin/auth/login
/admin/auth/login/method
/admin/auth/logout
/admin/auth/password/request
/admin/auth/password/reset
/admin/auth/passkey/login/options
/admin/auth/passkey/login
```

Plus the CLI-auth device-code entry points (`/cli/auth/start`, `/cli/auth/poll/*`). Everything else under `/admin/*` demands a session.

## The session cookie

- Name: `ADMIN_SESSION_COOKIE`, default `codex_admin_session` (`AdminAuthService::sessionCookieName`).
- TTL: `ADMIN_SESSION_TTL_SECONDS`, default 28 800 s (8 h), clamped to 300–604 800 (`AdminAuthService::sessionTtlSeconds`).
- Stored as `hash('sha256', token)` in `admin_sessions`. The plain-text token lives only in the user's cookie and never hits the database.
- Sessions are touched on every resolve so active sessions do not expire during use. If the row is past `expires_at`, it is deleted and the request is treated as unauthenticated.

## The page bootstrap

`public/admin/index.php` is the shell PHP include for every admin HTML page. It runs the mTLS check, resolves the session via `AdminAuthService::resolveSession()`, and injects a small `window.__adminBootstrap` JSON into `index.html`:

```
{
  "enforced":   <bool>,
  "authenticated": <bool>,
  "user": { "id": …, "username": …, "display_name": …, "access_level": … }
}
```

It also decides between `index.html` (dashboard shell) and `login.html` based on whether the user is authenticated and which path was requested:

- Request to `/admin/login` while authenticated → redirect to `/admin/dashboard`.
- Request to any other `/admin/*` while unauthenticated (and enforcement is on) → redirect to `/admin/login`.

The redirect is implemented with a 302 plus a `Location:` header.

## The login flow (passkey first)

The login page (`public/admin/login.html` + `public/admin/assets/login.js`) asks for a username and then calls `POST /admin/auth/login/method` (`AdminAuthController::loginMethod`). The server returns either `"passkey"` or `"password"` based on whether the user has any registered credentials (`AdminAuthService::requiresPasskey()`).

- **Passkey path.** The client requests WebAuthn options from `POST /admin/auth/passkey/login/options`, performs the ceremony in the browser, then submits the assertion to `POST /admin/auth/passkey/login`. On success the server calls `createSessionForUser()` which sets the cookie and logs `admin.auth.login`.
- **Password path.** `POST /admin/auth/login` with JSON `{ username, password }`. Password verification uses `password_verify()`; if the stored hash needs upgrading, `password_hash()` is re-run transparently.

Both paths return the same envelope: `{ token, expires_at, user }`. The token is set as the session cookie by the browser.

## Sign-out

`POST /admin/auth/logout` (`AdminAuthController::logout`) deletes the session row by token hash and clears the cookie. The client-side handler is wired to the Logout button in the account menu (see `public/admin/assets/admin-auth.js`).

## Password reset

Password reset is **self-disabled by default**. `/admin/auth/password/request` and `/admin/auth/password/reset` exist but return an error unless you have wired up the `Mailer` support and configured SMTP. This is deliberate: without email delivery, a "forgot password" flow is a compromise in a dual-user security posture. Use passkeys.

## Failure modes you will see

- **403 Client certificate required** — `ADMIN_ACCESS_MODE=mtls` but the proxy is not forwarding the fingerprint header. Check the Caddy config.
- **401 Authentication required** — session cookie missing or expired, and the path is not in the bypass list above.
- **403 Passkey login required for this user** — the user has at least one registered passkey and cannot fall back to password. Remove the passkey from *Account → Passkeys* if you need to restore password access.

## Source references

- public/admin/index.php (bootstrap, redirect rules, window.__adminBootstrap)
- src/Http/AdminSessionHelper.php (requireAdminAccess, bypass list)
- src/Http/SecurityHelper.php (isMtlsSatisfied)
- src/Services/AdminAuthService.php (login, sessions, password hashing)
- src/Http/Controllers/AdminAuthController.php (login, logout, password endpoints)
- public/admin/assets/admin-auth.js, public/admin/assets/login.js, public/admin/login.html
