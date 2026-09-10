---
title: Roles and capabilities
section: Admin access and identity
verified: 2026-09-09
sources: api/src/services/admin-auth.ts, api/src/services/admin-users.ts, api/src/http/plugins/auth-admin.ts, api/src/http/plugins/capabilities.ts, api/src/security/capabilities.ts, api/src/security/route-capabilities.ts, api/src/security/authorization-mode.ts, api/src/routes/admin/auth/index.ts, api/src/routes/admin/users/index.ts, api/src/routes/admin/settings/index.ts, api/src/db/migrations/0022_set_authorization_mode.sql, frontend/src/lib/auth/capabilities.ts, frontend/src/lib/components/users/UsersPage.svelte, frontend/src/lib/components/users/userSchema.ts, frontend/src/lib/components/settings/AuthorizationSection.svelte, frontend/src/lib/api/types.ts
---

Authorization is a **default-deny capability layer**, not a session check. `app.requireAdmin` (`api/src/http/plugins/auth-admin.ts`) only *authenticates*: it resolves the session cookie and requires an active `admin_users` row. What decides whether the caller may proceed is `api/src/security/route-capabilities.ts`, which assigns exactly one capability to every route under `/admin/*` (and the session-guarded `/cli/auth/*` routes), and `api/src/http/plugins/capabilities.ts`, which attaches the matching guard as each route is registered. A route missing from that inventory is a **startup failure** — the plugin collects every governed route it cannot find and throws at `onReady`, so a new endpoint cannot ship session-only by omission.

## Role labels

Constants declared in `api/src/services/admin-auth.ts`; `VALID_ACCESS_LEVELS` is the whitelist and any other string fails validation on create/update:

- `ROLE_OWNER = 'owner'` — holds every capability. The first-run claim at `/admin/setup/owner` always creates one of these.
- `ROLE_ADMIN = 'admin'` — also holds every capability. Owner and admin differ only in the ownership invariants enforced by `AdminUserService.guardLastAdmin` (`api/src/services/admin-users.ts`): the last active owner-like account cannot be demoted, deactivated, or deleted. Those are properties of the *target* row, so no capability of the caller can express them.
- `ROLE_FLEET = 'fleet_operator'` — runs the fleet: hosts, insecure windows, global settings, canonical credentials, Git Director arbitration, and the file-transfer pool. Holds no account management and no reveal of any kind.
- `ROLE_TRUSTED = 'trusted_user'` — the reads plus `hosts.activate_insecure`, and nothing else.
- `ROLE_VIEWER = 'viewer'` and the legacy `ROLE_USER = 'user'` — read-only.

## The role → capability matrix

`api/src/security/capabilities.ts` is the only place a role name is compared against anything; no route or component re-derives policy from `access_level`. The same table is generated into `docs/ADMIN.md` and checked by `api/test/unit/security/capability-docs.test.ts`.

| Capability | `owner` | `admin` | `fleet_operator` | `trusted_user` | `viewer` / `user` |
|---|---|---|---|---|---|
| `admin.read`, `account.self_manage`, `users.read`, `hosts.read`, `settings.read`, `auth.read_metadata`, `content.read`, `memory.read`, `projects.read`, `secrets.read_metadata`, `agent_portal.read`, `agent_messaging.read`, `git_director.read`, `transfers.read`, `audit.read` | yes | yes | yes | yes | yes |
| `hosts.activate_insecure` | yes | yes | yes | yes | — |
| `hosts.manage`, `settings.manage`, `auth.manage`, `git_director.manage`, `transfers.manage` | yes | yes | yes | — | — |
| `users.manage`, `hosts.security_transition`, `security.manage_authorization`, `auth.reveal_credential`, `keys.manage`, `content.manage`, `memory.write`, `projects.manage`, `secrets.reveal`, `secrets.manage`, `agent_portal.reveal_link`, `agent_portal.reveal_transcript`, `agent_portal.manage`, `agent_messaging.reveal_content`, `agent_messaging.manage`, `transfers.download` | yes | yes | — | — | — |

Points worth knowing:

- `hosts.security_transition` covers exactly four routes — `POST /admin/hosts/register`, `DELETE /admin/hosts/{id}`, `POST /admin/hosts/{id}/engines`, and `POST /admin/hosts/{id}/secure` — because each can atomically revoke or generation-fence live Agent Messaging work. Registering a host is therefore owner/admin even though `hosts.manage` (installer re-mint, toggles, overrides, `POST /admin/hosts/quick-register`) is a fleet-operator action.
- Reveals are separate from reads because each returns bearer material or private content: `secrets.reveal` (a plaintext credential), `agent_portal.reveal_link` (a reusable permanent portal link), `agent_portal.reveal_transcript` (session message bodies), `agent_messaging.reveal_content` (a decrypted message body), `auth.reveal_credential` (the canonical credential the fleet distributes), and `transfers.download` (the bytes an agent uploaded). A `fleet_operator` may replace the fleet credential or empty the transfer pool but never read either back out.
- `auth.reveal_credential` is the one capability a route raises *itself*: `GET /admin/hosts/{id}/auth` is `auth.read_metadata` until `include_body=1`, at which point the handler calls `app.assertCapability(req, 'auth.reveal_credential')`.
- `account.self_manage` is held by every role: signing out, changing your own password, and managing your own passkeys must not depend on a grant an operator can lose.
- Login enforcement (`AdminAuthService.isEnforced()`) counts active `owner` and `admin` rows only, so a roster made entirely of viewers never switches login on.

## What a denial looks like

1. No session → `401` with code `admin_required`.
2. Session for an inactive user → `403` with code `admin_disabled`.
3. Session whose role lacks the route's capability → `403` with code `admin_role_required` and a `required_capability` field naming what was missing.

`GET /admin/auth/status` returns the caller's row of the matrix as `capabilities` (plus the fleet's `authorization_mode`). The console reads it through `frontend/src/lib/auth/capabilities.ts` and the `can()` helper on `authStore` to disable the controls a `403` would meet; the tooltip names the missing capability. That is presentation only — the server re-checks every request.

## Enforcement modes: compatible and strict

Before this layer, every admin route not covered by one of six hand-written gates was open to any authenticated, active user. Enforcing the matrix on accounts created in that world would lock operators out, so enforcement has a mode (`api/src/security/authorization-mode.ts`):

| Mode | Who may do what |
|---|---|
| `compatible` | Exactly the pre-matrix rules: `owner` and `admin` may do everything; every other role is refused only the routes in `LEGACY_OWNER_ADMIN_ROUTES` and admitted to the rest. |
| `strict` | The matrix above. |

Migration `0022_set_authorization_mode.sql` writes `compatible` on an installation that already had users and `strict` on a fresh one (`DEFAULT_AUTHORIZATION_MODE` is `strict`), so an upgrade changes nobody's access and a new install is secure from first boot. Four capabilities are enforced under **both** modes (`ALWAYS_ENFORCED`): `auth.reveal_credential`, `security.manage_authorization`, `agent_portal.reveal_transcript`, and `agent_portal.manage`.

While a fleet runs in `compatible`, every request the matrix *would* have refused is recorded. **Policies → Access control** (`AuthorizationSection`) reads `GET /admin/authorization` and lists those distinct role / capability / route triples with their last-seen time, so "what breaks if I switch" is answered by your own traffic. **Switch to strict** and **Revert to compatible** post `{ mode }` to `POST /admin/authorization`; both buttons need `security.manage_authorization` (owner and admin only). Instances cache the mode for up to 30 seconds, so a multi-instance deployment converges within that window without a restart.

## First-run path

`AdminAuthService.isEnforced()` returns false until at least one active `owner` or `admin` exists. While `admin_users` is empty, `/admin/setup/owner` and the legacy `POST /admin/users` bootstrap path enter the same serialized zero-user claim: it locks the installation bootstrap point, rechecks inside the lock, creates a fixed active `owner`, and rejects every concurrent or later unauthenticated claim. A successful `/admin/setup/owner` claim immediately issues the normal session cookie.

## Managing users in the UI

The roster lives at **Admin Users** (`/users`). Any role may open it (`users.read`); the **Add user** button, the per-row edit and delete controls, and the **Wipe** button render only when the caller holds `users.manage`, so a viewer sees a read-only table rather than buttons that would `403`.

The page provides:

- A debounced search box matching name, username, email, and role.
- A sortable table (username ascending by default). Sorting by role uses the API's own privilege order — `owner`, `admin`, `viewer`, `fleet_operator`, `trusted_user`, `user` (`USER_ROLES` in `frontend/src/lib/api/types.ts`) — with unknown values last.
- **Add user** — opens `UserFormDialog` in create mode.
- Per-row **edit** — opens `UserFormDialog` in edit mode.
- Per-row **delete** — opens `ConfirmDeleteDialog`.
- **Wipe** — opens `WipeUsersDialog` for bulk removal.

### Creating or editing a user

`UserFormDialog` accepts username, password, role, and active status. `ROLE_OPTIONS` (`frontend/src/lib/components/users/userSchema.ts`) offers all six roles — Owner, Admin, Viewer, Fleet Operator, Trusted User, User. The frontend enforces a stricter password policy than the backend: minimum 12 characters and at least two character classes (lowercase, uppercase, digit, symbol); the backend checks length only (`PASSWORD_MIN_LENGTH = 12`).

Submitting calls `POST /admin/users` (create) or `POST /admin/users/{id}` (update), both `users.manage`. `AdminUserService.update` validates the role against `VALID_ACCESS_LEVELS` and refuses any change that would leave zero active `owner`/`admin` rows.

### Deleting a single user

`ConfirmDeleteDialog` calls `DELETE /admin/users/{id}` (`users.manage`). `guardLastAdmin` prevents deleting the last active owner or admin.

## The wipe path

`POST /admin/users/wipe` (`users.manage`) deletes every user **except the currently authenticated caller**; the caller's identity comes from `req.admin.user.id` and there is no option to include it. The body must be `{ confirm: 'WIPE' }`. Afterwards every other session is invalidated and an `admin.user.wipe` event is written. Because the caller is preserved, `isEnforced()` stays true and the bootstrap path does not reopen.

## Source references

- api/src/security/capabilities.ts (the closed capability vocabulary and `ROLE_CAPABILITIES`)
- api/src/security/route-capabilities.ts (one capability per admin route)
- api/src/http/plugins/capabilities.ts (guard attachment, `admin_role_required`, startup failure on a missing route)
- api/src/security/authorization-mode.ts (`compatible`/`strict`, `LEGACY_OWNER_ADMIN_ROUTES`, `ALWAYS_ENFORCED`)
- api/src/db/migrations/0022_set_authorization_mode.sql (upgrade lands in `compatible`, fresh installs in `strict`)
- api/src/services/admin-auth.ts (role constants, `VALID_ACCESS_LEVELS`, `isEnforced`)
- api/src/services/admin-users.ts (create/update/delete/wipe, `guardLastAdmin`)
- api/src/http/plugins/auth-admin.ts (`requireAdmin` — authentication only)
- api/src/routes/admin/auth/index.ts (`capabilities` and `authorization_mode` on `/admin/auth/status`)
- api/src/routes/admin/users/index.ts (user CRUD, zero-user bootstrap)
- api/src/routes/admin/settings/index.ts (`GET`/`POST /admin/authorization`)
- frontend/src/lib/auth/capabilities.ts (mirrored capability names, `can()` predicate, tooltip reason)
- frontend/src/lib/components/users/UsersPage.svelte (role sort order; controls hidden without `users.manage`)
- frontend/src/lib/components/users/userSchema.ts (`ROLE_OPTIONS`, password character-mix rule)
- frontend/src/lib/components/settings/AuthorizationSection.svelte (Policies → Access control)
- frontend/src/lib/api/types.ts (`USER_ROLES`)
