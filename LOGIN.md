# Admin Login & Roles

## Summary
- Admin login protects `/admin/` once at least one active admin user exists.
- Before any admins exist, the dashboard runs in userless mode (no login enforcement).
- Login uses an HTTP-only session cookie with a configurable TTL.
- Roles control which admin features each user can access.

## Bootstrap & Enforcement
- When `admin_users` has no active admins: `/admin/` behaves like the legacy dashboard (no login requirement), guarded only by `ADMIN_ACCESS_MODE` (mTLS or none).
- Creating the first active admin user enables login enforcement for `/admin/*` in addition to any mTLS checks.
- Wiping all users via the Users panel (`WIPE` confirmation) deletes every admin user and returns the system to userless mode (login no longer enforced until a new admin is created).

## Access Model
- `ADMIN_ACCESS_MODE` controls mTLS:
  - `mtls` (default): mTLS is required for `/admin/*` and login sits behind that TLS gate.
  - `none`: mTLS headers are optional; protect `/admin/` using another control (VPN/firewall) and rely on admin login for user-level access.
- Admin API endpoints:
  - `GET /admin/auth/status` — reports whether users exist, if login is enforced, current session user (if any), and available role labels.
  - `POST /admin/auth/login` — `{username, password}`; on success issues an HTTP-only session cookie and returns the sanitized user plus `expires_at`.
  - `POST /admin/auth/logout` — clears the current session and expires the cookie.

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

## Password Policy & Recovery
- Password minimum length: `ADMIN_PASSWORD_MIN_LENGTH` (default `12`), clamped between 8 and 128 characters.
- Password validation is enforced on:
  - New user creation (via admin UI/API).
  - Password resets.
- Password recovery:
  - Request endpoint: `POST /admin/auth/password/request` with `{identity}` where `identity` is a username or email.
  - Behavior:
    - Empty `identity` is ignored.
    - Unknown or inactive users are silently ignored.
    - `ADMIN_PASSWORD_RESET_FROM` must be set; optional `ADMIN_PASSWORD_RESET_FROM_NAME` and `ADMIN_PASSWORD_RESET_BASE_URL` may customize sender name and reset link base URL.
    - A reset token is generated and stored in `admin_password_resets`, expiring after `ADMIN_PASSWORD_RESET_TTL_SECONDS` (default 3600s; clamped between 300 and 86400 seconds).
    - Email body includes the token and, when a base URL is available, a link to `/admin/#reset?token=…`.
  - Reset endpoint: `POST /admin/auth/password/reset` with `{token, password}`.
    - Validates password against the current minimum length.
    - Rejects missing/invalid/expired tokens.
    - Updates the user’s password hash, marks the reset as used, and invalidates all existing sessions for that user.

## UI Behavior
- Login overlay:
  - When enforced and not authenticated, the admin UI displays a blocking login overlay and message: `Login required to access admin tools.`
  - Failed login attempts surface a generic error: `Login failed. Check your credentials.`
- Password recovery panel:
  - Accessible via "Forgot password" from the login overlay or via a `#reset?token=...` URL.
  - Shows feedback such as `If the account exists, a reset email was sent.` and `Password updated. You can log in now.`
- Header user display:
  - When authenticated, the top nav shows the current user and a logout button.

## Unknown / Not Found in Code
- Public admin user self-signup flows (e.g., invite links) — Unknown / not found in code.
- Multi-factor authentication (TOTP, WebAuthn/passkeys) — Unknown / not found in code; passkey/WebAuthn helpers have been removed.
