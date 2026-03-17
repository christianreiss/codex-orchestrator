# Admin Login & Roles

## Summary
- Admin login uses a dedicated route at `/admin/login`.
- Login/session enforcement starts when at least one **active** admin user exists (`access_level=admin`, `active=1`).
- When no active admins exist, admin routes run in bootstrap mode (no login/session enforcement).
- Login uses an HTTP-only session cookie with a configurable TTL.
- Admin passkey login is implemented and is username-bound: the login page uses the entered username before prompting for a passkey.
- With `ADMIN_ACCESS_MODE=mtls` (default), passkey login still sits inside the mTLS gate; it does not replace the outer client-cert boundary.
- Password reset is disabled (UI and API).
- Roles control which admin features each user can access.

## Bootstrap & Enforcement
- Enforcement check is `AdminAuthService::isEnforced()` (`countAdmins(true) > 0`).
- When `admin_users` has no active admins: session/capability checks are bypassed for admin API routes, and dashboard routes do not require a session.
- Creating the first active admin user enables login enforcement for `/admin/*` in addition to any mTLS checks.
- Wiping all users via the Users panel (`WIPE` confirmation) deletes every admin user and returns the system to userless mode (login no longer enforced until a new admin is created).
- Redirect flow when login is enforced:
  - Visiting dashboard routes (`/admin/`, `/admin/hosts/{id}`) without a valid session redirects to `/admin/login`.
  - Visiting `/admin/login` with an active session redirects to `/admin/`.
  - Visiting `/admin/login` while login is not enforced also redirects to `/admin/`.

## Access Model
- `ADMIN_ACCESS_MODE` controls mTLS:
  - `mtls` (default): mTLS is required for `/admin/*` and login sits behind that TLS gate.
  - `none`: mTLS headers are optional; protect `/admin/` using another control (VPN/firewall) and rely on admin login for user-level access.
  - Any value other than `none` is treated as `mtls`.
- WebAuthn/passkey settings:
  - `ADMIN_WEBAUTHN_RP_ID` overrides the relying-party ID.
  - `ADMIN_WEBAUTHN_RP_NAME` overrides the relying-party name (default `Codex Orchestrator`).
  - `ADMIN_WEBAUTHN_ORIGIN` overrides the exact origin used for ceremony validation; when unset, origin is derived from the trusted request scheme/host.
- Admin API endpoints:
  - `GET /admin/auth/status` — returns `has_users`, `admin_count` (active admins), `enforced`, `authenticated`, `user`, and role labels.
  - `POST /admin/auth/login` — `{username, password}`; on success issues an HTTP-only session cookie and returns the sanitized user plus `expires_at`.
  - `POST /admin/auth/logout` — clears the current session and expires the cookie.
  - `POST /admin/auth/passkey/login/options` — `{username}`; returns WebAuthn request options for that user’s registered passkeys only.
  - `POST /admin/auth/passkey/login` — completes passkey login and issues the same admin session cookie as password login.
  - `POST /admin/auth/password/request` — disabled (`410 Gone`).
  - `POST /admin/auth/password/reset` — disabled (`410 Gone`).

## Passkeys
- Registration is available to authenticated admins through the dashboard and stores multiple passkeys per user.
- Registration requires WebAuthn user verification (`UV`) and does not force platform-only authenticators.
- Login also requires WebAuthn user verification and is not username-less: the entered username determines the `allowCredentials` list returned by the server.
- Passkey management endpoints:
  - `POST /admin/auth/passkey/register/options`
  - `POST /admin/auth/passkey/register`
  - `GET /admin/passkeys`
  - `POST /admin/passkeys/{id}/name`
  - `DELETE /admin/passkeys/{id}`
- Recovery for lost passkeys is operator-driven in Docker deployments:
  - `docker compose exec api php /var/www/html/scripts/admin-passkeys.php delete-user --username <admin> [--force]`
  - This deletes all stored passkeys for the named active admin user and logs `admin.passkey.recovery.delete`.

## Sessions
- Cookie name: `ADMIN_SESSION_COOKIE` (default `codex_admin_session`).
- Cookie flags: `HttpOnly`, `SameSite=Strict`, `Secure` when the request is HTTPS, path `/`.
- Session TTL seconds (`ADMIN_SESSION_TTL_SECONDS`):
  - Default: `28800` (8 hours).
  - Minimum: 300 seconds.
  - Maximum: 604800 seconds (7 days).
- Sessions are stored in `admin_sessions` with `user_id`, `token_hash`, optional `ip`/`user_agent`, `created_at`, `last_seen_at`, and `expires_at`.
- Session tokens are 64-hex random values; only `sha256(token)` is stored in `admin_sessions.token_hash`.
- `resolveSession()` updates `last_seen_at` and deletes expired/invalid sessions.

## Roles & Capabilities
- Role values:
  - `admin` — full access, including user management and wipe.
  - `fleet_operator` — `settings.manage`, `hosts.manage`, `hosts.activate`.
  - `trusted_user` — `hosts.activate`.
  - `user` — no capabilities.
- Capabilities checked in code:
  - `users.manage` — manage admin users (create/update/delete/wipe).
  - `settings.manage` — change admin settings.
  - `hosts.manage` — add/remove hosts and change host properties.
  - `hosts.activate` — open/close insecure host windows.
- Enforcement:
  - When `isEnforced()` is false (no active admins): capabilities are not enforced.
  - When enforced and no authenticated user: requests that require a capability fail with `401 Authentication required`.
  - When enforced and the user’s role lacks the capability: requests fail with `403 Forbidden`.
- Some admin routes are session-only (no capability check), including many read endpoints and `POST /admin/toasts`.

## Users & Bootstrap Flows
- Admin users are stored in `admin_users` with: `name`, `username` (unique), `email` (unique), `password_hash`, `access_level`, `active`, `last_login_at`, `created_at`, `updated_at`.
- User management endpoints (all require admin access and, once users exist, the `users.manage` capability):
  - `GET /admin/users` — list admin users.
  - `POST /admin/users` — create a user from the provided body.
  - `POST /admin/users/{id}` — update user by id.
  - `DELETE /admin/users/{id}` — delete user by id.
  - `POST /admin/users/wipe` — body must include `{"confirm": "WIPE"}`; on success deletes all users and disables login enforcement.
- Bootstrap/user constraints from code:
  - First created user must be `access_level=admin` and `active=true`.
  - Username is normalized to lowercase and must match `^[a-z0-9._-]{3,64}$`.
  - Email is normalized to lowercase and must be a valid email format.
  - Last active admin cannot be demoted, deactivated, or deleted (except via `/admin/users/wipe`).
- The admin UI shows an empty-state notice when no users exist and prompts you to create the first admin.

## Password Policy
- Password minimum length: `ADMIN_PASSWORD_MIN_LENGTH` (default `12`), clamped between 8 and 128 characters.
- Password validation is enforced on:
  - New user creation (via admin UI/API).
  - User password updates (`POST /admin/users/{id}` with `password`).

## UI Behavior
- Dedicated login page:
  - `/admin/login` serves a standalone login page.
  - Failed login attempts surface a generic error: `Login failed. Check your credentials.`
  - Passkey login reuses the username field and surfaces API errors such as “No passkeys registered for user.”
- Header user display:
  - When authenticated, the top nav shows the current user and a logout button.

## Unknown / Not Found in Code
- Public admin user self-signup flows (e.g., invite links) — Unknown / not found in code.
- TOTP or other non-WebAuthn MFA for admin login — Unknown / not found in code.
