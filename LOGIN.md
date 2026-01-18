# Login & Users/Roles Plan

Date: 2026-01-18
Owner: Codex (assistant)
Status: Implemented

## Bootstrap Policy (confirmed)
- If no users are configured: system behaves exactly as it does today (no login, no role enforcement).
- "Add user" button opens modal; first user must be Admin.
- Once active Admin count > 0: enforce login + role checks for admin UI/API.
- "Wipe all users" (with confirmation modal) resets to userless mode (system as-is now).

## Decisions (locked)
1) Access model: mTLS runs alongside login (both enforced when enabled).
2) Bootstrap: when no admins exist, admin UI behaves as-is (no login enforcement). Creating the first admin enables login enforcement.
3) Roles: Admin (all), Fleet Operator (hosts + settings), Trusted User (activate insecure hosts), User (read-only).
4) Password recovery: email-based reset via `ADMIN_PASSWORD_RESET_FROM` with token-based reset; admins can set passwords in the Users panel.
5) Password policy: minimum length default 12 (configurable via `ADMIN_PASSWORD_MIN_LENGTH`).
6) Sessions: HTTP-only cookie, default TTL 8h (configurable via `ADMIN_SESSION_TTL_SECONDS`).

## Implementation Notes
- Tables: `admin_users`, `admin_sessions`, `admin_password_resets` added to DB migrations.
- Services: `AdminAuthService` + `AdminUserService`.
- Admin endpoints: auth/status/login/logout/password reset + users CRUD/wipe.
- UI: login overlay, password recovery modal, Users tab CRUD + wipe.
- Docs + changelog updated.
