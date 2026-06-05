---
title: Roles and capabilities
section: Admin access and identity
verified: 2026-06-05
sources: api/src/services/admin-auth.ts, api/src/services/admin-users.ts, api/src/http/plugins/auth-admin.ts, api/src/routes/admin/auth/index.ts, api/src/routes/admin/users/index.ts
---

The current admin gate is single-tier: every protected admin route attaches `app.requireAdmin` (from `api/src/http/plugins/auth-admin.ts`), which requires an active session backed by an `admin_users` row with `active = 1`. A role string is stored on each user (`admin_users.access_level`) and surfaced in *Settings → Users*; it is the hook for finer-grained gating but is not currently used to differentiate request authorization.

## Role labels

Constants declared in `api/src/services/admin-auth.ts`:

- `ROLE_OWNER = 'owner'` — the canonical "full access" role; the first-ever user must be created with this or `ROLE_ADMIN`. **Cannot be assigned via the UI form** (see below).
- `ROLE_ADMIN = 'admin'` — administrator, treated identically to `owner` for the "is there still an admin alive?" guards. Highest role available in the UI form.
- `ROLE_VIEWER = 'viewer'` — declared as a constant but **not available in the UI form**; cannot be assigned via create or edit dialogs.
- Legacy values still accepted on existing rows: `ROLE_FLEET = 'fleet_operator'`, `ROLE_TRUSTED = 'trusted_user'`, `ROLE_USER = 'user'`.

`VALID_ACCESS_LEVELS` is the full whitelist of all six values above; updates that pass any other string fail validation.

### Roles available in the UI form

The create/edit form (`UserFormDialog`) exposes only four selectable roles via `ROLE_OPTIONS`:

| Value | Label |
|---|---|
| `admin` | Admin |
| `fleet_operator` | Fleet Operator |
| `trusted_user` | Trusted User |
| `user` | User |

`owner` and `viewer` are not in `ROLE_OPTIONS` and not in the `USER_ROLES` frontend type — they cannot be assigned through the form. A user already holding the `owner` role (e.g. the bootstrap account) will display correctly via `RoleBadge`, but the role cannot be set or changed to `owner` through the UI.

### Role sort order in the users table

The table sorts users by role in this order: `admin` (highest) → `fleet_operator` → `trusted_user` → `user` → any other value (lowest, including `owner` and `viewer`).

## What the gates check today

Every gated admin endpoint has `preHandler: app.requireAdmin`. That decorator:

1. Reads the session cookie (`ADMIN_SESSION_COOKIE`).
2. Looks up the row in `admin_sessions` by `sha256(token)` and joins to `admin_users`.
3. Rejects with 401 (`admin_required`) when no row matches, with 403 (`admin_disabled`) when the user row is inactive.
4. On success, attaches `req.admin = { user, session }` for the route handler.

There is no further capability matrix between "has session" and "doesn't"; an authenticated admin can call any admin route. The legacy four-tier matrix (`settings.manage` / `hosts.manage` / `hosts.activate` / `users.manage`) is not currently enforced.

## First-run path

`AdminAuthService.isEnforced()` returns false until at least one active `owner` or `admin` exists. While it's false, the bootstrap path lets you create the initial admin without a session — the create-user route uses a `requireAdminOrBootstrap` preHandler that allows the call when there are zero admins yet. The first user must be created with `access_level` set to `owner` or `admin` (`api/src/services/admin-users.ts` enforces this).

## Managing users in the UI

The users management UI is at **Settings → Users** (`/settings/users`). The path `/users` immediately redirects (308) there.

The page provides:

- A search/filter input (debounced) above the users table.
- A sortable table listing all admin users.
- **Add user** button (plus icon) — opens `UserFormDialog` in create mode.
- Per-row **edit** button — opens `UserFormDialog` in edit mode.
- Per-row **delete** button — opens `ConfirmDeleteDialog` for single-user removal.
- **Wipe** button (trash icon) — opens `WipeUsersDialog` for bulk removal.

### Creating or editing a user

`UserFormDialog` accepts username, password, role (from `ROLE_OPTIONS`), and active status. The frontend enforces a stricter password policy than the backend: minimum 12 characters and at least two character classes (lowercase, uppercase, digit, symbol).

Submitting the form calls `POST /admin/users` (create) or `POST /admin/users/:id` (update). The mutation is gated by `requireAdmin`. `AdminUserService.update` validates the new role against `VALID_ACCESS_LEVELS` and refuses changes that would leave zero active `owner`/`admin` rows (`countActiveAdminsExcluding`).

### Deleting a single user

`ConfirmDeleteDialog` triggers `DELETE /admin/users/:id`. The same `guardLastAdmin` guard prevents deleting the last active owner or admin.

## The wipe path

`POST /admin/users/wipe` deletes all users **except the currently authenticated caller**. The caller's identity is taken from `req.admin.user.id` (set by `requireAdmin`) and is always excluded — there is no payload option to include the caller in the wipe. The endpoint requires `{ confirm: 'WIPE' }` in the request body.

After a wipe, all other users' sessions are invalidated and an `admin.user.wipe` event is written. Because the caller is preserved, `isEnforced()` remains true and the bootstrap path does not reopen.

## Source references

- api/src/services/admin-auth.ts (role constants, VALID_ACCESS_LEVELS, isEnforced)
- api/src/services/admin-users.ts (create/update/delete/wipe + "first user must be admin" + "at least one active admin")
- api/src/http/plugins/auth-admin.ts (requireAdmin decorator)
- api/src/routes/admin/auth/index.ts (auth endpoints)
- api/src/routes/admin/users/index.ts (user CRUD)
