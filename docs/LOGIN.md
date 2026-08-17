# Admin Login & Roles

## Summary
- Admin login uses a dedicated route at `/admin/login`.
- Login/session enforcement starts when at least one **active** admin user exists (`access_level` of `owner` or `admin`, `active=1`).
- When no admin user exists at all, `POST /admin/users` runs in bootstrap mode (no session required) so the first admin can be created.
- Login uses an HTTP-only session cookie with a configurable TTL.
- Admin login is normally username-first: the page submits the entered username before deciding whether the user must complete passkey auth or may continue to password entry. When exactly one active user exists and has passkeys, it can open that user's passkey prompt directly.
- Passkey login issues the same session cookie as password login; the API wraps neither in a client-certificate check. Only the optional Caddy proxy in front of the app does that.
- Password recovery is available from the login screen and completes on the standalone `/admin/password/reset` page.
- Roles are stored per user. Six route families add an `owner`/`admin` gate:
  user management, Memory Atlas writes, external Skill-source changes, Agent
  Portal writes/link reveal, Agent Messaging mutations/content reveal, and
  fleet-secret writes/value reveal.

## Bootstrap & Enforcement
- Enforcement check is the `isEnforced()` helper in `api/src/services/admin-auth.ts` (`countAdmins(true) > 0`).
- When `admin_users` is empty: `POST /admin/users` accepts an unauthenticated request so the first admin can be created. No other admin API route has a bootstrap bypass; they still require a session.
- Creating the first active admin user enables login enforcement for `/admin/*`. That session check is the only admin gate the API applies; any certificate check is the proxy's.
- Wiping all users via the Users panel (`WIPE` confirmation) deletes every admin user and returns the system to userless mode (login no longer enforced until a new admin is created).
- Redirect flow when login is enforced:
  - Visiting dashboard routes (`/admin/`, `/admin/hosts/{id}`) without a valid session redirects to `/admin/login`.
  - Visiting `/admin/login` with an active session redirects to `/admin/`.
  - Visiting `/admin/login` while login is not enforced also redirects to `/admin/`.

## Access Model
- `/admin/*` is gated by the admin session cookie only (`requireAdmin` in `api/src/http/plugins/auth-admin.ts`). The API never inspects a client certificate: `auth-mtls` parses `X-MTLS-*` into `req.mtls` and no route reads it.
- Client certificates are no longer part of this system. If a proxy you run terminates mTLS it may forward `X-MTLS-*`, which the API records from peers inside `TRUSTED_PROXY_CIDRS` and ignores from anyone else — but no route reads it. Protect `/admin/` with a network control (VPN/firewall) if session auth alone is not enough, and rely on admin login for user-level access.
- `ADMIN_ACCESS_MODE` accepts `cookie` (default) or `open`. It configures neither TLS nor `/admin/*`: `api/src/routes/cli-auth/index.ts` is the only reader, and it uses the value to decide whether the `/cli/auth/verify` device-approval page demands an admin session (anything but `open` does).
- WebAuthn/passkey settings:
  - `ADMIN_WEBAUTHN_RP_ID` overrides the relying-party ID; otherwise the app prefers the `PUBLIC_BASE_URL` host before falling back to the trusted request host. Setting it also requires `ADMIN_WEBAUTHN_ORIGIN`: the env schema rejects the RP ID on its own, so the API fails to start.
  - `ADMIN_WEBAUTHN_RP_NAME` overrides the relying-party name (default `Codex Orchestrator`).
  - `ADMIN_WEBAUTHN_ORIGIN` overrides the exact origin used for ceremony validation; when unset, the app prefers `PUBLIC_BASE_URL` before deriving origin from the trusted request scheme/host.
- Admin API endpoints:
  - `GET /admin/auth/status` — returns `has_users`, `admin_count` (active owners/admins), `enforced`, `authenticated`, `passkeys_registered`, `passkey_login_available`, and `user`, whose `access_level` is the caller's role.
  - `POST /admin/auth/login/method` — `{username}`; returns the required next step for that active user (`passkey` or `password`).
  - `POST /admin/auth/login` — `{username, password}`; on success issues an HTTP-only session cookie and returns the sanitized user plus `expires_at`. Users with registered passkeys are rejected and must use passkey login.
  - `POST /admin/auth/logout` — clears the current session and expires the cookie.
  - `POST /admin/auth/passkey/login/options` — `{username}`; returns WebAuthn request options for that user’s registered passkeys only.
  - `POST /admin/auth/passkey/login` — completes passkey login and issues the same admin session cookie as password login.
  - `POST /admin/auth/password/change` — `{current_password, new_password, confirm_password}`; requires a session, verifies the caller's current password, applies password policy, then expires the caller's other sessions and any outstanding reset tokens.
  - `POST /admin/auth/password/request` — `{username}` or `{email}`; always returns the same success shape and sends a one-hour, single-use reset link when an active account matches.
  - `POST /admin/auth/password/reset` — `{token, new_password, confirm_password}`; consumes the token, applies password policy, expires existing sessions, and invalidates outstanding reset tokens.

Setup bootstrap uses `GET /admin/setup/status` (public only while there are no users, then session-gated) and `POST /admin/setup/owner` (atomic fixed-owner claim plus immediate login). Concurrent or later unauthenticated claims are rejected. `GET`/`POST /admin/setup/wizard` follow the same visibility rule and carry only first-run wizard position and completion — no credential material. Because the owner claim issues the session inline, the wizard never bounces a brand-new operator through `/admin/login`.

## Passkeys
- Registration is available to authenticated admins through the dashboard and stores multiple passkeys per user.
- Registration requires WebAuthn user verification (`UV`) and does not force platform-only authenticators.
- Login also requires WebAuthn user verification. The entered username normally determines the `allowCredentials` list; the single-active-user shortcut may omit it. If that user has a registered passkey, passkey becomes the only allowed login method until password recovery revokes the lost passkeys.
- Passkey management endpoints:
  - `POST /admin/auth/passkey/register/options`
  - `POST /admin/auth/passkey/register`
  - `GET /admin/passkeys`
  - `POST /admin/passkeys/{id}/name`
  - `DELETE /admin/passkeys/{id}`
- Recovery for lost passkeys uses the same email password-recovery flow; a successful password reset also removes the user's registered passkeys so password login is available again.

## Sessions
- Cookie name: `ADMIN_SESSION_COOKIE` (default `codex_admin_session`).
- Cookie flags: `HttpOnly`, `SameSite=Strict`, `Secure` when the request is HTTPS, path `/`.
- Session TTL minutes (`ADMIN_SESSION_TTL_MINUTES`):
  - Default: `43200` (30 days).
  - `adminSessionTtlSeconds()` in `api/src/services/admin-auth.ts` clamps the configured value to 300 seconds minimum and 604800 seconds (7 days) maximum, so the 30-day default issues 7-day sessions.
  - Login and the roll-forward in `api/src/http/plugins/auth-admin.ts` both use that clamped value, so a rolled session never outlives the cap it was issued under.
- Sessions are stored in `admin_sessions` with `user_id`, `token_hash`, optional `ip`/`user_agent`, `created_at`, `last_seen_at`, and `expires_at`.
- Session tokens are 64-hex random values; only `sha256(token)` is stored in `admin_sessions.token_hash`.
- Session resolution updates `last_seen_at` and deletes expired/invalid sessions.

## Roles & Capabilities
- Role values are `VALID_ACCESS_LEVELS` in `api/src/services/admin-auth.ts`:
  - `owner` — every capability; counts toward login enforcement.
  - `admin` — every capability; counts toward login enforcement. Differs from
    `owner` only in the ownership invariants in
    `api/src/services/admin-users.ts`, which protect the last active
    owner-like account and are properties of the target row, not of the caller.
  - `fleet_operator` — hosts, insecure windows, global settings, and fleet
    credentials. No account management, no reveal of any kind, and none of the
    four host security transitions.
  - `trusted_user` — the reads plus `hosts.activate_insecure`.
  - `viewer` and the legacy `user` — read-only.
- Authorization is a default-deny capability layer.
  `requireAdmin` (`api/src/http/plugins/auth-admin.ts`) authenticates only: it
  resolves the session cookie and requires an active user row, and never reads
  `access_level`. The decision to admit or refuse comes from one capability per
  route, assigned in `api/src/security/route-capabilities.ts` and enforced by
  `api/src/http/plugins/capabilities.ts` as each route registers. A route with
  no entry there is a startup failure, not a session-only route.
- The full role→capability matrix is generated into `docs/ADMIN.md` from
  `api/src/security/capabilities.ts`; that table is the authority, and a test
  fails when it drifts.
- **Enforcement has a mode, and the matrix above describes `strict`.** An
  installation that already had users when migration `0022` ran is in
  `compatible`, which reproduces the rules it had before the capability layer
  existed: `owner` and `admin` may do everything, and every other role is
  refused exactly the 33 routes the six old hand-written gates covered — no
  more. Upgrading is therefore a behavioral no-op; a fresh install gets
  `strict` and is default-deny from first boot. `GET`/`POST
  /admin/authorization` read and change it, and `GET` also returns what
  `strict` would have refused on this fleet's own traffic. Two capabilities are
  enforced under both modes: `auth.reveal_credential` and
  `security.manage_authorization`. See `api/src/security/authorization-mode.ts`
  and the route-by-route proof in
  `api/test/integration/security/authorization-compatibility.test.ts`.
- Four reads carry their own capability instead of the domain's `.read`,
  because each returns bearer material or private content:
  - `GET /admin/agent-portal/users/{id}/link` → `agent_portal.reveal_link`. The
    permanent portal link is a reusable credential.
  - `POST /admin/secrets/{id}/reveal` → `secrets.reveal`. A `POST` rather than a
    `GET` on purpose: it cannot be prefetched, cached by an intermediary, or
    replayed out of browser history.
  - `POST /admin/agent-messaging/messages/{id}/reveal` →
    `agent_messaging.reveal_content`. An explicit audited mutation whose
    plaintext response is `no-store` and `no-cache`.
  - `GET /admin/hosts/{id}/auth?include_body=1` → `auth.reveal_credential`. The
    response carries the canonical credential the fleet hands to its hosts.
    Without the flag the same route is metadata and every role may read it, so
    the requirement is raised by the handler rather than by the URL.
  Every listing beside them is metadata-only, so a `viewer` may inspect state,
  addresses, conversations, and message metadata without seeing content.
- Host registration and API-key rotation (`POST /admin/hosts/register`), device
  approval (`POST /cli/auth/approve`), deletion (`DELETE /admin/hosts/{id}`) and
  the engine/secure-state transitions (`POST /admin/hosts/{id}/engines`,
  `POST /admin/hosts/{id}/secure`) share `hosts.security_transition`, held by
  `owner` and `admin` alone, because each can atomically revoke or
  generation-fence Agent Messaging work — or, for `secure`, decide whether a
  host is authorized outright or only inside its allowed window. There is no
  per-host Agent Messaging gate: the fleet switch is the only switch.
- `account.self_manage` is held by every role. Signing out, changing your own
  password, and managing your own passkeys cannot depend on a grant an operator
  might lose.
- The pre-authentication surface is fixed and enumerated in
  `api/src/security/route-capabilities.ts`: login, login-method discovery,
  passkey assertion, password reset request and redemption, the auth status
  probe, the three device-code lanes, and the static admin bundle. Every other
  route under `/admin/*` and `/cli/auth/*` requires a session.
- Without a valid session, guarded routes fail with `401` and code
  `admin_required`; a disabled account fails with `403` and code
  `admin_disabled`. A session lacking the route's capability fails with `403`,
  code `admin_role_required`, and a `required_capability` field naming it.
## Users & Bootstrap Flows
- Admin users are stored in `admin_users` with: `name`, `username` (unique), `email` (unique), `password_hash`, `access_level`, `active`, `last_login_at`, `created_at`, `updated_at`.
- User management endpoints (all require a session; once users exist, the mutating ones additionally require `owner` or `admin`):
  - `GET /admin/users` — list admin users.
  - `POST /admin/users` — create a user from the provided body.
  - `POST /admin/users/{id}` — update user by id.
  - `DELETE /admin/users/{id}` — delete user by id.
  - `POST /admin/users/wipe` — body must include `{"confirm": "WIPE"}`; on success deletes all users and disables login enforcement.
- Bootstrap/user constraints from code:
  - First created user must have `access_level` of `owner` or `admin`, and `active=true`.
  - Username is normalized to lowercase and must match `^[a-z0-9._-]{3,64}$`.
  - Email is normalized to lowercase and must be a valid email format.
  - Last active `owner`/`admin` cannot be demoted, deactivated, or deleted (except via `/admin/users/wipe`).
- The admin UI shows an empty-state notice when no users exist and prompts you to create the first admin.

## Password Policy
- Password minimum length: 12 characters, the fixed `PASSWORD_MIN_LENGTH` constant in `api/src/services/admin-auth.ts` (read through `passwordMinLength()`). There is no environment override.
- Password validation is enforced on:
  - New user creation (via admin UI/API).
  - User password updates (`POST /admin/users/{id}` with `password`).

## UI Behavior
- Dedicated login page:
  - `/admin/login` serves a standalone login page.
  - The page starts with username only and a single `Login` button.
  - Submitting a known username with no passkeys reveals the password field.
  - Submitting a known username with passkeys starts the passkey ceremony; password is not offered.
  - Failed login attempts surface a generic error: `Login failed. Check your credentials.`
  - Passkey login uses the same username field and single-button flow.
- Header user display:
  - When authenticated, the top nav shows the current user and a logout button.

## Unknown / Not Found in Code
- Public admin user self-signup flows (e.g., invite links) — Unknown / not found in code.
- TOTP or other non-WebAuthn MFA for admin login — Unknown / not found in code.
