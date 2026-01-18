# Login & Users/Roles Plan

Date: 2026-01-18
Owner: Codex (assistant)
Status: Draft plan (implementation not started)

## Bootstrap Policy (confirmed)
- If no users are configured: system behaves exactly as it does today (no login, no role enforcement).
- "Add user" button opens modal; first user must be Admin.
- Once Admin count > 0: enforce login + role checks for admin UI/API.
- "Wipe all users" (with confirmation modal) resets to userless mode (system as-is now).

## Open Decisions (need confirmation)
1) Access model with mTLS: enforce login in addition to mTLS, or allow login without mTLS when enabled?
2) Role permissions detail for Fleet Operator/Trusted User/User (exact endpoints/actions).
3) Password recovery: email-based reset vs admin manual reset only.
4) User lifecycle fields: active/disabled, last_login, failed_attempts/lockout?
5) Minimum password policy (length, complexity).
6) Session timeout + remember-me behavior.

## Work Plan
1) Recon
   - Review existing admin auth flow (`public/index.php`, admin JS, tests, docs).
   - Map admin endpoints and categorize by required role.

2) Data Model
   - Add tables via `Database::migrate()`:
     - `admin_users` (id, name, username, email, password_hash, access_level, active, last_login_at, created_at, updated_at).
     - `admin_password_resets` (id, user_id, token_hash, expires_at, used_at, created_at) if recovery is enabled.
     - Optional `admin_sessions` (if server-side sessions used).
   - Update `docs/interface-db.md`.

3) Auth + Sessions
   - Implement `AdminAuthService`:
     - Login (username + password) -> session/cookie.
     - Logout.
     - Role checks (RBAC gate).
     - Enforced mode only when Admin count > 0.
   - Decide session storage: PHP session vs DB-backed sessions.
   - Add middleware helpers: `requireAdminLogin()` and `requireAdminRole($min)`.

4) Admin Routes
   - Add `/admin/login`, `/admin/logout` endpoints.
   - Add `/admin/users` CRUD endpoints.
   - Add password reset endpoints (if enabled): request reset, confirm reset, update password.

5) UI
   - Add login screen (username + password) shown only when enforced.
   - Add users/roles management view (create/edit/delete, reset password).
   - Wire role-gated controls (hide/disable actions by role).
   - Add "wipe all users" modal gated to Admins.

6) Notifications / Email
   - Add SMTP config + email sender utility if recovery is email-based.
   - Generate reset tokens, send email, enforce expiry.

7) Tests
   - Unit tests for auth service (login, role checks, enforced mode, wipe).
   - Integration tests for admin endpoints and UI wiring.

8) Docs + Changelog
   - Update `docs/interface-api.md` for new endpoints.
   - Update `docs/interface-db.md`.
   - Update `docs/OVERVIEW.md` if user-visible.
   - Add `CHANGELOG.md` entry (newest date first).

9) Ops
   - If Docker is required, rebuild/restart stack.
   - Provide rollback notes (wipe users to return to userless mode).

