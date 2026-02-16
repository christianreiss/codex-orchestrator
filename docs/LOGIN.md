# Admin Login & Roles

## Summary
- Admin login uses a dedicated route at `/admin/login`.
- Admin login protects `/admin/` once at least one active admin user exists.
- Before any admins exist, the dashboard runs in userless mode (no login enforcement).
- Login uses an HTTP-only session cookie with a configurable TTL.
- Password reset is disabled (UI and API).
- Roles control which admin features each user can access.

## Bootstrap & Enforcement
- When `admin_users` has no active admins: `/admin/` behaves like the legacy dashboard (no login requirement), guarded only by `ADMIN_ACCESS_MODE` (mTLS or none).
- Creating the first active admin user enables login enforcement for `/admin/*` in addition to any mTLS checks.
- Wiping all users via the Users panel (`WIPE` confirmation) deletes every admin user and returns the system to userless mode (login no longer enforced until a new admin is created).
- Redirect flow when login is enforced:
  - Visiting `/admin/` without a valid session redirects to `/admin/login`.
  - Visiting `/admin/login` with an active session redirects to `/admin/`.

## Access Model
- `ADMIN_ACCESS_MODE` controls mTLS:
  - `mtls` (default): mTLS is required for `/admin/*` and login sits behind that TLS gate.
  - `none`: mTLS headers are optional; protect `/admin/` using another control (VPN/firewall) and rely on admin login for user-level access.
- Admin API endpoints:
  - `GET /admin/auth/status` — reports whether users exist, if login is enforced, current session user (if any), and available role labels.
  - `POST /admin/auth/login` — `{username, password}`; on success issues an HTTP-only session cookie and returns the sanitized user plus `expires_at`.
  - `POST /admin/auth/logout` — clears the current session and expires the cookie.
  - `POST /admin/auth/password/request` — disabled (`410 Gone`).
  - `POST /admin/auth/password/reset` — disabled (`410 Gone`).

## Sessions
- Cookie name: `ADMIN_SESSION_COOKIE` (default `codex_admin_session`).
- Cookie flags: `HttpOnly`, `SameSite=Strict`, `Secure` when the request is HTTPS, path `/`.
- Session TTL seconds (`ADMIN_SESSION_TTL_SECONDS`):
  - Default: `28800` (8 hours).
  - Minimum: 300 seconds.
  - Maximum: 604800 seconds (7 days).
- Sessions are stored in `admin_sessions` with `user_id`, `token_hash`, optional `ip`/`user_agent`, `created_at`, `last_seen_at`, and `expires_at`.

## Roles & Capabilities
- Role values:
  - `admin` — full access, including user management and wipe.
  - `fleet_operator` — can manage hosts and settings.
  - `trusted_user` — can activate insecure hosts.
  - `user` — read-only access.
- Capabilities checked in code:
  - `users.manage` — manage admin users (create/update/delete/wipe).
  - `settings.manage` — change admin settings.
  - `hosts.manage` — add/remove hosts and change host properties.
  - `hosts.activate` — open/close insecure host windows.
- Enforcement:
  - When `isEnforced()` is false (no active admins): capabilities are not enforced.
  - When enforced and no authenticated user: requests that require a capability fail with `401 Authentication required`.
  - When enforced and the user’s role lacks the capability: requests fail with `403 Forbidden`.

## Users & Bootstrap Flows
- Admin users are stored in `admin_users` with: `name`, `username` (unique), `email` (unique), `password_hash`, `access_level`, `active`, `last_login_at`, `created_at`, `updated_at`.
- User management endpoints (all require admin access and, once users exist, the `users.manage` capability):
  - `GET /admin/users` — list admin users.
  - `POST /admin/users` — create a user from the provided body.
  - `POST /admin/users/{id}` — update user by id.
  - `DELETE /admin/users/{id}` — delete user by id.
  - `POST /admin/users/wipe` — body must include `{"confirm": "WIPE"}`; on success deletes all users and disables login enforcement.
- The admin UI shows an empty-state notice when no users exist and prompts you to create the first admin.

## Password Policy
- Password minimum length: `ADMIN_PASSWORD_MIN_LENGTH` (default `12`), clamped between 8 and 128 characters.
- Password validation is enforced on:
  - New user creation (via admin UI/API).

## UI Behavior
- Dedicated login page:
  - `/admin/login` serves a standalone login page.
  - Failed login attempts surface a generic error: `Login failed. Check your credentials.`
- Header user display:
  - When authenticated, the top nav shows the current user and a logout button.

## Unknown / Not Found in Code
- Public admin user self-signup flows (e.g., invite links) — Unknown / not found in code.
- Multi-factor authentication (TOTP, WebAuthn/passkeys) — Unknown / not found in code; passkey/WebAuthn helpers have been removed.
