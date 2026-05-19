---
title: Roles and capabilities
section: Admin access and identity
verified: 2026-04-19
sources: src/Services/AdminAuthService.php, src/Http/AdminSessionHelper.php, src/Http/helpers.php, src/Http/Controllers/AdminUserController.php, src/Http/Controllers/AdminOverviewController.php, src/Http/Controllers/AdminSettingsController.php, src/Http/Controllers/AdminHostController.php, src/Http/Controllers/AdminConfigController.php, src/Http/Controllers/AdminProjectController.php, src/Http/Controllers/CliAuthController.php
---

Four roles and four capabilities. The mapping is defined in `AdminAuthService::roleAllows()` and enforced at every controller method that needs it via `requireAdminCapability()`.

## Roles

Constants declared on `AdminAuthService`:

- `ROLE_ADMIN = 'admin'` — full access. The role check short-circuits to true for every capability.
- `ROLE_FLEET = 'fleet_operator'` — fleet-wide operator.
- `ROLE_TRUSTED = 'trusted_user'` — can approve insecure activations but cannot rewrite config.
- `ROLE_USER = 'user'` — no capabilities. They can sign in and read their own account page, but every admin endpoint behind a capability check returns `403 Forbidden`.

Display labels live in `AdminAuthService::ROLE_LABELS` (*Admin*, *Fleet Operator*, *Trusted User*, *User*) and are surfaced in *Settings → Users*.

## Capabilities

Also constants on `AdminAuthService`:

- `CAP_SETTINGS = 'settings.manage'` — change any global configuration (quota, auto-update, agents, skills, profiles, OpenAI/Claude state, API keys, runner trigger, auth upload).
- `CAP_HOSTS_MANAGE = 'hosts.manage'` — register, mutate, delete hosts; change their per-host knobs.
- `CAP_HOSTS_ACTIVATE = 'hosts.activate'` — approve/deny insecure auth requests, approve CLI device-code authentications.
- `CAP_USERS_MANAGE = 'users.manage'` — create, edit, delete admin users and wipe all users.

## The matrix

| Capability | admin | fleet_operator | trusted_user | user |
|------------|:-:|:-:|:-:|:-:|
| `users.manage` | ✓ | — | — | — |
| `settings.manage` | ✓ | ✓ | — | — |
| `hosts.manage` | ✓ | ✓ | — | — |
| `hosts.activate` | ✓ | ✓ | ✓ | — |

`admin` is always allowed (the `if ($role === self::ROLE_ADMIN) return true;` early return in `roleAllows`). Every other row is the literal matrix in `src/Services/AdminAuthService.php:236–240`.

`fleet_operator` deliberately has no `users.manage`; fleet operators can run the whole operational surface but cannot add, remove, or re-role other admins.

## Where each capability gates

Exhaustive grep over `src/Http/Controllers/*.php` for `requireAdminCapability`:

- **settings.manage** — all of `AdminSettingsController` (general toggles, quota, logs retention, scaling, Claude settings, OpenAI/Claude state); all of `AdminConfigController` (agents, skills, memories, profile/config render, config store); `AdminOverviewController::authUpload`, `seedCommand`, `runnerRun`, `runnerRunClaude`.
- **hosts.manage** — every mutating route in `AdminHostController` (delete, clear, roaming, secure, vip, scaling-exempt, auto-update, curl-insecure, reverse-dns, model, codex-version, agents-version, register).
- **hosts.activate** — insecure approval routes (`AdminOverviewController::hostsInsecureExtend`, `hostsInsecureDisableAll`, and the `AdminHostController::insecureApproval*` endpoints), plus CLI device-code approval (`CliAuthController::approve`, `deny`).
- **users.manage** — every route in `AdminUserController` (create, update, delete, wipe).

Read-only endpoints (dashboard overview, logs, host listings) require only a valid session; they do not check a capability. This is why a `user` role can still sign in and see the dashboard but cannot do anything mutating.

## How the check is implemented

`requireAdminCapability(string $capability)` is a thin global wrapper (`src/Http/helpers.php:215`) over `AdminSessionHelper::requireAdminCapability`. That helper:

1. Bails out silently if `AdminAuthService::isEnforced()` is false (first-run mode).
2. Resolves the current session via `AdminSessionHelper::resolveAdminSession`.
3. Calls `AdminAuthService::enforceCapability($user, $capability)`, which throws:
   - `401 Authentication required` if `$user === null` under enforcement;
   - `403 Forbidden` if `roleAllows($role, $capability)` returns false.

Both exceptions are converted to JSON error envelopes by `Response::json`.

## Changing a user's role

- *Settings → Users* lists every admin. Inline edit updates `access_level`.
- The server side is `POST /admin/users/{id}` (`AdminUserController::update`), which requires `users.manage`. You cannot demote the last admin: `AdminUserService` enforces a guard so the app never ends up with zero admin-role users.

## Roles and the first-run path

While `isEnforced()` is false (zero admins), capability checks no-op. This is intentional — someone has to be able to click *Settings → Users → Create admin* on the first boot. The moment the first active admin row exists, enforcement flips on and the rules above apply.

## Source references

- src/Services/AdminAuthService.php (role constants, capability constants, roleAllows matrix)
- src/Http/AdminSessionHelper.php (requireAdminCapability)
- src/Http/helpers.php (global wrappers)
- src/Http/Controllers/AdminUserController.php (users.manage gates)
- src/Http/Controllers/AdminOverviewController.php (settings.manage + hosts.activate gates)
- src/Http/Controllers/AdminSettingsController.php (settings.manage gates)
- src/Http/Controllers/AdminHostController.php (hosts.manage + hosts.activate gates)
- src/Http/Controllers/AdminConfigController.php (settings.manage gates)
- src/Http/Controllers/AdminProjectController.php (settings.manage gates)
- src/Http/Controllers/CliAuthController.php (hosts.activate gate)
