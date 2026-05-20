---
title: Roles and capabilities
section: Admin access and identity
verified: 2026-05-20
sources: api/src/services/admin-auth.ts, api/src/services/admin-users.ts, api/src/http/plugins/auth-admin.ts, api/src/routes/admin/auth/index.ts, api/src/routes/admin/users/index.ts
---

The current admin gate is single-tier: every protected admin route attaches `app.requireAdmin` (from `api/src/http/plugins/auth-admin.ts`), which requires an active session backed by an `admin_users` row with `active = 1`. A role string is stored on each user (`admin_users.access_level`) and surfaced in *Settings → Users*; it is the hook for finer-grained gating but is not currently used to differentiate request authorization.

## Role labels

Constants declared in `api/src/services/admin-auth.ts`:

- `ROLE_OWNER = 'owner'` — the canonical "full access" role; the first-ever user must be created with this or `ROLE_ADMIN`.
- `ROLE_ADMIN = 'admin'` — administrator, treated identically to `owner` for the "is there still an admin alive?" guards.
- `ROLE_VIEWER = 'viewer'` — read-leaning role surfaced in the UI; currently not enforced server-side.
- Legacy values still accepted on existing rows: `ROLE_FLEET = 'fleet_operator'`, `ROLE_TRUSTED = 'trusted_user'`, `ROLE_USER = 'user'`.

`VALID_ACCESS_LEVELS` is the full whitelist; updates that pass any other string fail validation.

## What the gates check today

Every gated admin endpoint has `preHandler: app.requireAdmin`. That decorator:

1. Reads the session cookie (`ADMIN_SESSION_COOKIE`).
2. Looks up the row in `admin_sessions` by `sha256(token)` and joins to `admin_users`.
3. Rejects with 401 (`admin_required`) when no row matches, with 403 (`admin_disabled`) when the user row is inactive.
4. On success, attaches `req.admin = { user, session }` for the route handler.

There is no further capability matrix between "has session" and "doesn't"; an authenticated admin can call any admin route. The legacy four-tier matrix (`settings.manage` / `hosts.manage` / `hosts.activate` / `users.manage`) is not currently enforced.

## First-run path

`AdminAuthService.isEnforced()` returns false until at least one active `owner` or `admin` exists. While it's false the bootstrap path lets you create the initial admin without a session — the create-user route uses a `requireAdminOrBootstrap` preHandler that allows the call when there are zero admins yet. The first user must be created with `access_level` set to `owner` or `admin` (`api/src/services/admin-users.ts` enforces this).

## Changing a user's role

- *Settings → Users* lists every admin. Inline edit calls `POST /admin/users/{id}`.
- The mutation is gated by `requireAdmin`. `AdminUserService.update` validates the new role against `VALID_ACCESS_LEVELS` and refuses changes that would leave zero active `owner`/`admin` rows (`countActiveAdminsExcluding`).

## The wipe path

`POST /admin/users/wipe` deletes every other admin (or every admin including the caller, depending on payload), invalidates active sessions, and writes an `admin.user.wipe` event. After a full wipe, `isEnforced()` flips false again and the first-run bootstrap re-opens.

## Source references

- api/src/services/admin-auth.ts (role constants, VALID_ACCESS_LEVELS, isEnforced)
- api/src/services/admin-users.ts (create/update/delete/wipe + "first user must be admin" + "at least one active admin")
- api/src/http/plugins/auth-admin.ts (requireAdmin decorator)
- api/src/routes/admin/auth/index.ts (auth endpoints)
- api/src/routes/admin/users/index.ts (user CRUD)
