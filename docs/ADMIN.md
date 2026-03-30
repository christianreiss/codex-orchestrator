# Admin Dashboard

Code-truth operator map for `/admin/*`. Source of truth is runtime code (`public/index.php`, `public/admin/*`, `src/Services/*`, `src/Repositories/*`).

## Access & Auth
- UI routes served by `public/admin/index.php`: `/admin/`, `/admin/login`, `/admin/hosts/{id}`.
- `ADMIN_ACCESS_MODE` defaults to `mtls`. Any value except `none` is treated as `mtls`.
- mTLS is considered present only when `X-MTLS-Fingerprint` (or `X-MTLS-Present`) contains at least 64 hex chars.
- Admin login enforcement starts only after at least one active admin exists (`countAdmins(true) > 0`).
- If login is enforced:
  - `/admin/` redirects to `/admin/login` when no valid session.
  - `/admin/login` redirects to `/admin/` when already authenticated.
  - API endpoints require session except `/admin/auth/status`, `/admin/auth/login`, `/admin/auth/login/method`, `/admin/auth/logout`, `/admin/auth/password/request`, `/admin/auth/password/reset`, `/admin/auth/passkey/login/options`, and `/admin/auth/passkey/login`.
- If login is not enforced (fresh/userless install), auth/capability checks are bypassed so first admin can be created.
- Passkey login is implemented, but with `ADMIN_ACCESS_MODE=mtls` (default) it still sits behind the client-certificate gate. The login UI is username-first: passkey users must complete WebAuthn and are not offered password login.
- Session cookie:
  - Name: `ADMIN_SESSION_COOKIE` (default `codex_admin_session`).
  - TTL: `ADMIN_SESSION_TTL_SECONDS` (default `28800`, clamped to `300..604800`).
  - Cookie flags: `HttpOnly`, `SameSite=Strict`, `Secure` when request is HTTPS.
- Password reset endpoints are hard-disabled: `POST /admin/auth/password/request` and `POST /admin/auth/password/reset` always return `410`.
- WebAuthn settings:
  - `ADMIN_WEBAUTHN_RP_ID` overrides the relying-party ID; otherwise the app prefers the `PUBLIC_BASE_URL` host before falling back to the trusted request host.
  - `ADMIN_WEBAUTHN_RP_NAME` overrides the relying-party name.
  - `ADMIN_WEBAUTHN_ORIGIN` overrides the exact ceremony origin; otherwise the app prefers `PUBLIC_BASE_URL` before deriving it from the trusted request scheme/host.

## Roles & Capabilities
- Roles: `admin`, `fleet_operator`, `trusted_user`, `user`.
- Capability matrix:
  - `admin`: all capabilities.
  - `fleet_operator`: `settings.manage`, `hosts.manage`, `hosts.activate`.
  - `trusted_user`: `hosts.activate`.
  - `user`: none.
- Capability checks are only active when login enforcement is active.

## API Kill Switch
- `POST /admin/api/state` stores `api_disabled` in `versions`.
- Guard runs before route dispatch: when enabled, every path returns `503` except exact path `/admin/api/state`.
- Practical effect: UI/API routes, `/auth`, `/versions`, `/mcp`, installer/seed routes are all blocked until `/admin/api/state` is toggled back.

## Live Updates (WebSocket)
- `GET /admin/ws/info` (admin-auth protected) returns:
  - `enabled` from `ADMIN_WS_ENABLED`.
  - `url` from `ADMIN_WS_PUBLIC_URL` or derived from base URL as `/admin/ws`.
  - `last_event_id`, `heartbeat_seconds` (`ADMIN_WS_PING_INTERVAL`, min `5`), `backlog_limit` (`ADMIN_WS_BACKLOG_LIMIT`, clamped `1..500`).
- WebSocket server: `scripts/admin-ws.php` (also in compose service `admin-ws`).
  - Bind: `ADMIN_WS_BIND` (default `0.0.0.0:8091`).
  - Poll interval: `ADMIN_WS_POLL_INTERVAL` (min `0.2`).
  - Enforces mTLS unless `ADMIN_ACCESS_MODE=none`.
  - Tracks admin client presence in `versions.admin_ws_connections` for insecure-approval gating.
- Besides push events, the socket now supports targeted request/response hydration for slow host-detail metadata. Current request: `host-detail-support`, returning compact `runner` plus full AGENTS admin metadata for the active host page.
- Dashboard consumes `log.created` events for targeted data refresh and `toast` events for notifications.
- Config and profiles tabs do not auto-overwrite dirty local edits; they show `Remote update available (unsaved edits)`.

## Page-by-Page (Code-Backed)
- **Theme**: Auto/Light/Dark/Bright Pink/Dark Pink cycle stored in `localStorage.adminTheme` and mirrored to the server-side `versions.admin_theme` setting so `cdx` can match pink wrapper branding on the next auth pull.
- **Overview** (`GET /admin/overview`): host totals, refresh metrics, canonical-auth status, token totals/day/week/month, pricing snapshot/costs, ChatGPT usage snapshot/summary, mTLS metadata, quota flags, prune window, reverse-DNS flag, insecure-approval flag, codex lock metadata.
- **Log retention** now has four buckets: API logs, MCP logs, admin events, and set-aside graph stats. The graph-stats bucket controls the compact dashboard quota/cost history store rather than raw verbose logs.
- **Hosts**:
  - List: `GET /admin/hosts`.
  - Host auth view: `GET /admin/hosts/{id}/auth` (`include_body=true` adds canonical auth body).
  - Register/rotate host key + installer token: `POST /admin/hosts/register` (`hosts.manage`).
    - Required: `fqdn`.
    - Optional: `secure` (default `true`), `vip` (default `false`), `temporary`, `curl_insecure`, `reverse_dns_mode` (`global|enabled|disabled`), `duration_minutes` (`0..480`).
  - Host actions:
    - Delete host: `DELETE /admin/hosts/{id}` (`hosts.manage`).
    - Clear host auth state/digests: `POST /admin/hosts/{id}/clear` (`hosts.manage`).
    - Toggle roaming: `POST /admin/hosts/{id}/roaming` (`allow` bool, `hosts.manage`).
    - Toggle secure flag: `POST /admin/hosts/{id}/secure` (`secure` bool, `hosts.manage`).
    - Toggle VIP: `POST /admin/hosts/{id}/vip` (`vip` bool, `hosts.manage`).
    - Toggle IPv4-only wrapper behavior: `POST /admin/hosts/{id}/ipv4` (`force` bool, clears pinned IPs, `hosts.manage`).
    - Toggle curl insecure wrapper behavior: `POST /admin/hosts/{id}/curl-insecure` (`allow` bool, `hosts.manage`).
    - Per-host reverse DNS mode: `POST /admin/hosts/{id}/reverse-dns` (`mode`, `hosts.manage`).
    - Per-host model/reasoning override: `POST /admin/hosts/{id}/model` (`hosts.manage`).
    - Per-host codex version override: `POST /admin/hosts/{id}/codex-version` (`hosts.manage`).
    - Per-host AGENTS version override: `POST /admin/hosts/{id}/agents-version` (`hosts.manage`).
- **Insecure Windows & Approval**:
  - Enable/disable per-host window: `POST /admin/hosts/{id}/insecure/enable|disable` (`hosts.activate`).
  - List insecure hosts + domain auto-allows: `GET /admin/hosts/insecure`.
  - Bulk extend active insecure windows: `POST /admin/hosts/insecure/extend` (`hosts.activate`).
  - Bulk disable active insecure windows: `POST /admin/hosts/insecure/disable-all` (`hosts.activate`).
  - Approval queue actions:
    - Approve/deny: `POST /admin/insecure-approvals/{id}/approve|deny` (`hosts.activate`).
    - Approve + allow parent domain: `POST /admin/insecure-approvals/{id}/allow-domain` (`settings.manage`).
    - Revoke domain allow: `POST /admin/insecure-domain-allows/{id}/revoke` (`settings.manage`).
- **Users**:
  - List/create/update/delete: `/admin/users`, `/admin/users/{id}`.
  - Wipe all users: `POST /admin/users/wipe` with `{"confirm":"WIPE"}`.
  - `users.manage` required once any users exist.
- **Passkeys**:
  - Username-bound login endpoints: `POST /admin/auth/passkey/login/options` with `{username}` and `POST /admin/auth/passkey/login`.
  - Registration endpoints (session required): `POST /admin/auth/passkey/register/options` and `POST /admin/auth/passkey/register`.
  - Management endpoints (session required): `GET /admin/passkeys`, `POST /admin/passkeys/{id}/name`, `DELETE /admin/passkeys/{id}`.
  - Login requires WebAuthn user verification and uses the entered username to scope `allowCredentials`; it is not username-less.
- **Auth Upload & Seed**:
  - Upload canonical auth (runner skipped): `POST /admin/auth/upload` (`settings.manage`).
  - Generate one-time seed command: `POST /admin/auth/seed-command` (`settings.manage`).
  - Seed token TTL: `AUTH_SEED_TOKEN_TTL_SECONDS` (default `900`, fallback if invalid/<=0).
- **Global Settings**:
  - cdx silent: `GET/POST /admin/cdx-silent` (`settings.manage` for POST).
  - Reverse DNS global flag: `GET/POST /admin/reverse-dns` (`settings.manage` for POST).
  - Insecure-approval global flag: `GET/POST /admin/insecure-approval` (`settings.manage` for POST).
  - Projects module: `GET/POST /admin/projects/state` (`settings.manage` for POST). Enabling it also publishes the managed `coco` skill with embedded toolkit/help through MCP `skill://coco`; disabling it withdraws that managed skill from the MCP resource list.
  - Quota mode: `GET/POST /admin/quota-mode` (`settings.manage` for POST).
    - `hard_fail` boolean.
    - `limit_percent` normalized to `50..100` (default `100`).
    - `week_partition` one of `off|5|7` (stored as `0|5|7`, default `0`).
  - Prune policy: `POST /admin/prune-policy` (`inactivity_days` clamped `0..60`, `settings.manage`).
  - Fleet codex version lock: `POST /admin/codex-version` (`latest|auto` clears lock, or strict `x.y.z`, `settings.manage`).
  - Version refresh: `POST /admin/versions/check` (`settings.manage`).
- **Runner**:
  - Status: `GET /admin/runner` (enabled/url/base/timeout, last check/ok/fail, state, boot id, 24h counts, last validation/store log, canonical auth metadata).
  - Manual run: `POST /admin/runner/run` (`settings.manage`).
- **Usage, Cost, ChatGPT, Logs**:
  - Usage rows: `GET /admin/usage` (`limit`, repository clamps to `1..500`).
  - Usage ingests: `GET /admin/usage/ingests` (`page`, `per_page<=200`, `host_id`, `q`, `sort`, `direction`).
  - Cost history: `GET /admin/usage/cost-history` (`days`, `from`, `until`, `interval=day|week`, `group_by=component|total`, `include_tokens`).
  - ChatGPT usage snapshot: `GET /admin/chatgpt/usage` (`force` optional, cooldown is 300s unless forced).
  - ChatGPT usage history: `GET /admin/chatgpt/usage/history` (`days`, `from`, `until`, `interval=raw|hour|day`, `lane=normal|spark|both`, `window=primary|secondary|both`).
  - Force ChatGPT refresh: `POST /admin/chatgpt/usage/refresh` (`settings.manage`).
  - Token line aggregates: `GET /admin/tokens` (`limit`, repository clamps to `1..200`).
  - Audit logs: `GET /admin/logs` (`limit`, repository clamps to `1..500`).
  - MCP logs: `GET /admin/mcp/logs` (`limit`, repository clamps to `1..500`).
- **Content Sync Surfaces**:
  - Skills: `GET /admin/skills`, `GET /admin/skills/{slug}`, `POST /admin/skills/generate`, `POST /admin/skills/store`, `DELETE /admin/skills/{slug}`. `POST /admin/skills/generate` uses the runner plus canonical auth to draft a skill into the admin modal, but it never persists anything until `store` runs. When Projects is enabled, the managed `coco` skill appears here as read-only and cannot be overwritten/deleted directly.
  - Projects: `GET /admin/projects`, `POST /admin/projects`, `DELETE /admin/projects/{slug}`, `GET /admin/projects/feedback`, `GET /admin/projects/{slug}`, `POST /admin/projects/{slug}/about`, `POST /admin/projects/{slug}/roster`, `GET /admin/projects/{slug}/changes`, note/todo/file/feedback subroutes, and `GET/POST /admin/projects/state`.
  - AGENTS docs: `GET /admin/agents`, `POST /admin/agents/store`, `POST /admin/agents/serve`, `DELETE /admin/agents/versions/{id}`.
  - Config builder: `GET /admin/config`, `POST /admin/config/render`, `POST /admin/config/store`.
  - MCP memories: `GET /admin/mcp/memories` (`limit` clamped `1..200`), `DELETE /admin/mcp/memories/{id}`.
- **Toasts**:
  - Manual toast endpoint: `POST /admin/toasts` (admin-auth protected, no extra capability gate).
  - Automatic auth toasts are emitted from log actions:
    - `auth.retrieve` => `CDX authorized` (success).
    - `auth.denied` / `auth.insecure.denied` => `CDX refused` (warn/error).

## Common Workflows
- **Onboard host**: `POST /admin/hosts/register` -> run returned installer command.
- **Rotate canonical auth**: `POST /admin/auth/upload` (runner bypassed).
- **Seed canonical auth from local machine**: `POST /admin/auth/seed-command` -> execute generated `curl | bash`.
- **Recover a locked-out admin who lost all passkeys**: `docker compose exec api php /var/www/html/scripts/admin-passkeys.php delete-user --username <admin> [--force]`.
- **Enable shared project coordination**: `POST /admin/projects/state` with `{"enabled":true}`.
- **Create a shared project**: `POST /admin/projects` with `slug`, optional `about`, and optional `roster_markdown`.
- **Open insecure window**: `POST /admin/hosts/{id}/insecure/enable` with `duration_minutes`.
- **Force runner validation now**: `POST /admin/runner/run`.
- **Freeze/unfreeze fleet codex version**: `POST /admin/codex-version` with `selection` (`latest` or pinned semver).

## Notes & Gotchas
- Installer tokens are single-use and expire (`INSTALL_TOKEN_TTL_SECONDS`, default `1800`, fallback to `1800` if invalid).
- Insecure host registration opens an initial window:
  - Initial open window defaults to `30` minutes.
  - Stored sliding window defaults to `10` minutes unless `duration_minutes` is provided.
- Insecure window refresh is applied on non-store checks (`/auth` retrieve path, `/mcp`, `/host/lane`), not on plain `/auth` store.
- Insecure approval queue is only offered when both conditions are true:
  - `insecure_approval_enabled` flag is on.
  - WebSocket presence is fresh (`admin_ws_connections` heartbeat window).
- The dashboard now rehydrates the insecure approval queue from `GET /admin/insecure-approvals/pending` on load and websocket reconnect, so pending requests still show up even if the original live event was missed.
- A live `auth.insecure.pending` event now rings a short synthesized bell in the admin dashboard when a genuinely new insecure approval request arrives. Browser autoplay/user-gesture policy still applies, so the sound is best-effort rather than guaranteed on a never-interacted tab.
- The Projects module is deliberately native to codex-orchestrator: Settings → Projects is now a compact index plus module toggle, while each project opens on its own `/admin/projects/<slug>` workspace page. The managed `coco` skill is derived from module state instead of being edited like a normal Skill row, doubles as the operator-facing CoCo toolkit/help document, and now tells operators to keep shared CoCo handoffs in Projects rather than host-scoped MCP memories.
- Project creation remains API-driven for now; the admin UI intentionally focuses on browsing, opening, and deleting existing projects.
- Global rate limit bucket (`global`) is skipped for `/admin/*` routes but still applies to non-admin routes.
- Auth-fail limiter (`auth-fail`) is enforced for bad `/auth` API-key attempts (defaults: `20` per `600s`, `1800s` block; configurable).
- Pricing fallback path when remote pricing is unavailable: prefer `GPT54_INPUT_PER_1K`, `GPT54_OUTPUT_PER_1K`, `GPT54_CACHED_PER_1K`, `PRICING_CURRENCY`; legacy `GPT51_*` vars are still accepted when the new ones are unset.
