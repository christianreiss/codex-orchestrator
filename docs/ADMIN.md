# Admin Dashboard

Code-truth operator map for `/admin/*`. Source of truth is runtime code (`api/src/server.ts`, `api/src/routes/admin/*`, `api/src/services/*`).

## Access & Auth
- UI shell served by `adminSpaHtmlPreHandler` in `api/src/routes/admin/pages/static.ts`: `/admin/`, `/admin/login`, `/admin/hosts/{id}`. Admin session state is hydrated client-side via `/admin/auth/status`.
- Every guarded `/admin/*` route is gated by the admin session cookie through `requireAdmin` (`api/src/http/plugins/auth-admin.ts`). No admin route checks a client certificate.
- `ADMIN_ACCESS_MODE` accepts `mtls` (default), `cookie`, or `open`, and `api/src/routes/cli-auth/index.ts` is the only file that reads it: any value except `open` makes `/cli/auth/verify` require an admin session. It has no effect on `/admin/*`.
- The client-certificate gate is proxy-layer, in the optional `caddy` compose profile (`caddy/Caddyfile`): it answers `/admin*` without a validated cert with `403 Client certificate required for /admin` and injects `X-MTLS-*` on what it forwards. A plain `docker compose up` does not start that profile.
- `authMtlsPlugin` (`api/src/http/plugins/auth-mtls.ts`) parses those headers into `req.mtls` — `present` is just a non-empty `X-MTLS-Fingerprint`, `X-MTLS-Present` is not read at all — and nothing else in `api/src` consults `req.mtls`.
- Admin login enforcement starts only after at least one active admin exists (`countAdmins(true) > 0`).
- If login is enforced:
  - `/admin/` redirects to `/admin/login` when no valid session.
  - `/admin/login` redirects to `/admin/` when already authenticated.
  - API endpoints require session except `/admin/auth/status`, `/admin/auth/login`, `/admin/auth/login/method`, `/admin/auth/logout`, `/admin/auth/password/request`, `/admin/auth/password/reset`, `/admin/auth/passkey/login/options`, and `/admin/auth/passkey/login`.
- While no admin user exists at all (fresh/userless install), `POST /admin/users` accepts an unauthenticated request so the first admin can be created. That is the only bootstrap bypass; every other admin API route still requires a session.
- Passkey login is implemented and issues the same session cookie as password login; the API adds no certificate check around it, though a deployment running the bundled Caddy reaches the login page through that proxy's cert gate. The login UI is username-first: passkey users must complete WebAuthn and are not offered password login.
- Session cookie:
  - Name: `ADMIN_SESSION_COOKIE` (default `codex_admin_session`).
  - TTL: `ADMIN_SESSION_TTL_MINUTES` (default `43200`), converted to seconds and clamped to `300..604800`, so the default lands on the seven-day cap.
  - Cookie flags: `HttpOnly`, `SameSite=Strict`, `Secure` when request is HTTPS.
- Password recovery is available from `/admin/login`: the request endpoint accepts a username or email without disclosing whether it matched, sends a one-hour single-use link to `/admin/password/reset`, and the reset endpoint rotates the password while expiring existing sessions and outstanding reset tokens.
- WebAuthn settings:
  - `ADMIN_WEBAUTHN_RP_ID` overrides the relying-party ID; otherwise the app prefers the `PUBLIC_BASE_URL` host before falling back to the trusted request host. Setting it also requires `ADMIN_WEBAUTHN_ORIGIN`: the env schema rejects the RP ID on its own, so the API fails to start.
  - `ADMIN_WEBAUTHN_RP_NAME` overrides the relying-party name.
  - `ADMIN_WEBAUTHN_ORIGIN` overrides the exact ceremony origin; otherwise the app prefers `PUBLIC_BASE_URL` before deriving it from the trusted request scheme/host.

## Navigation & Presentation
- One registry (`frontend/src/lib/nav.ts`) drives navigation, mobile Menu, the
  command palette, title, breadcrumb, and active state. Its direct groups are
  **Monitor** (Overview, Activity), **Fleet** (Hosts, Engines, Policies),
  **Coordinate** (Projects, Agent Messaging, Agent Portal), **Knowledge**
  (Skills, Fleet Instructions, Memories, Subagents, Commands, Output Styles),
  and **Access** (API Access, Secrets, Admin Users). Manual and Account stay in
  the sidebar footer. There is no generic Settings or Authoring destination.
- Legacy Settings and Authoring URLs issue 308 client redirects to the direct
  owner route. Mapping lives in `frontend/src/lib/legacy-admin-routes.ts`.
- Memories opens **Memory Atlas** at `/admin/memories`. The default graph and equivalent paginated list
  cover host, project, and shared memory in one filterable workspace; selecting
  a memory opens its Overview, Content, Metadata, and Activity inspector. The
  canvas shows the newest 150 memories from the loaded page and refuses optional
  relationship layers above its density guard; the list retains the complete
  loaded page. Host, project, and tag filter choices are capped to the top 200
  values and disclose when that cap is active.
- Desktop uses grouped sidebar navigation. Mobile keeps Overview, Hosts,
  Projects, and Activity in the persistent bottom bar; its Menu sheet contains
  all remaining workspace, help, appearance, password, passkey, and sign-out
  actions, so no capability depends on a desktop-only control.
- Route-aware breadcrumbs and browser titles come from `frontend/src/lib/nav.ts`.
  Shared components use the theme tokens in `frontend/src/app.css`, including
  keyboard focus, reduced-motion, increased-contrast, and light/dark behavior.

## Roles & Role Gates
- Accepted `access_level` values are `VALID_ACCESS_LEVELS` in
  `api/src/services/admin-auth.ts`: `owner`, `admin`, `viewer`, plus the legacy
  values `fleet_operator`, `trusted_user`, and `user`, which are still accepted
  so existing rows keep loading. Anything else is rejected on create/update.
- There is no capability system in the Node API, and no per-route capability
  names. `requireAdmin` (`api/src/http/plugins/auth-admin.ts`) resolves the
  session cookie and requires the user row to be active — it never reads the
  role. Everything below marked as admin-authenticated is therefore open to any
  authenticated, active user regardless of role unless it appears in the six
  role-gated families below; insecure windows, canonical auth upload, and
  ungated global settings remain session-only.
- The whole route tree contains exactly six role gates, all of which allow
  `owner` and `admin` only and answer other roles with `403` and code
  `admin_role_required`:
  - Memory Atlas writes: create, update, delete, and shared append
    (`api/src/routes/admin/memories/index.ts`).
  - Admin user management: create, update, delete, and wipe
    (`api/src/routes/admin/users/index.ts`).
  - External Skill source inclusion, auto-update, and manual refresh
    (`api/src/routes/admin/skill-sources/index.ts`).
  - Agent Portal global/user mutations, plus the permanent-link reveal — the only
    gated read, since the link is reusable bearer material
    (`api/src/routes/agent-portal/admin-host.ts`).
  - Agent Messaging global/per-host/address switches, address aliases,
    conversation cancellation, content reveal, explicit redrive, and the host
    registration/key-rotation, CLI approval, delete, engine, and security
    transitions that can atomically revoke or generation-fence messaging work
    (`api/src/routes/agent-messaging/index.ts` and
    `api/src/routes/admin/hosts/index.ts` plus
    `api/src/routes/cli-auth/index.ts`). The two additional endpoints are
    `POST /admin/hosts/register` and `POST /cli/auth/approve`. Lists expose
    metadata only; content reveal is a role-gated, audited `POST`.
  - Fleet secrets create, update, soft-delete, value reveal, and the
    `secrets_module_enabled` switch (`api/src/routes/admin/secrets/index.ts`).
    Listing and per-secret metadata reads are session-only like the rest of the
    tree; only the plaintext reveal and the mutations are gated. The direct
    `/admin/secrets` workspace exposes the same lifecycle without ever putting
    plaintext into a list response.
- Every authenticated role may read Memory Atlas and the user roster. Memory
  reads carry a per-record `capabilities` object (`read`, `create`, `update`,
  `delete`, `append`) that mirrors the same `owner`/`admin` check for the UI.
- Login enforcement counts active `owner` and `admin` rows only, so a fleet of
  `viewer` accounts never switches login on.

## Agent Messaging Operations

- Agent Messaging is the default-off agent-to-agent bus for Codex and Claude,
  including both same-engine paths and both cross-engine paths. Turning on the
  fleet switch is necessary but not sufficient: each address also requires an
  active secure host, that host's Agent Messaging switch, its own engine still
  enabled on the host, and its own address switch. The address table reports
  the authoritative eligibility result and reason rather than asking the UI to
  infer it.
- Agent Messaging controls the fleet switch. Host Detail exposes the
  per-host switch alongside the host engine/security controls. The dedicated
  `/admin/agent-messaging` operations page shows fleet/direction counts, stable
  canonical `agent:<uuid>` addresses and aliases, host/engine/readiness state,
  queue depth, conversations, and delivery metadata.
- Any authenticated active admin role may inspect that metadata. Address alias
  and enable changes, global/host switches, conversation cancellation, redrive,
  and reveal require `owner` or `admin`. Message rows never include content.
  **Reveal content** is an explicit audited POST whose response is `no-store`
  and `no-cache`; the page keeps one closeable plaintext reveal at a time and
  clears it when the caller's role, filters, or loaded result set changes.
- Delivery is ordered at least once and per-target FIFO. One target has at most
  one leased/accepted delivery, a delayed retry blocks later rows, attempts stop
  at 12, UTF-8 content is capped at 32 KiB, and TTL defaults to 24 hours (range
  60 seconds to seven days). `accepted` is the uncertainty boundary: if
  completion cannot be proven, the row becomes `ambiguous` rather than replaying
  automatically. **Redrive** is an explicit owner/admin action for dead or
  ambiguous rows and creates a new linked sequence; it never mutates the
  retained original.
- Disabling the fleet, host, address, host engine, or host security/status
  cancels queued/leased work, marks accepted work ambiguous, cancels affected
  conversations, revokes relays where applicable, and generation-fences live
  bindings. A graceful agent exit unbinds but preserves its stable address as
  resumable/offline; a graceful relay shutdown stops the server generation.
- Version 1 has no automatic history purge. Terminal messages, canceled
  conversations, dormant addresses, aliases, and audit history remain visible
  for diagnosis.

Admin routes:

- State: `GET /admin/agent-messaging/state`,
  `POST /admin/agent-messaging/state`.
- Addresses: `GET /admin/agent-messaging`,
  `GET /admin/agent-messaging/addresses`,
  `PATCH /admin/agent-messaging/addresses/{id}`,
  `POST /admin/agent-messaging/addresses/{id}/enabled`.
- Conversations: `GET /admin/agent-messaging/conversations`,
  `POST /admin/agent-messaging/conversations/{id}/cancel`.
- Deliveries: `GET /admin/agent-messaging/messages`,
  `POST /admin/agent-messaging/messages/{id}/reveal`,
  `POST /admin/agent-messaging/messages/{id}/redrive`.
- No per-host gate. The fleet switch is the only switch; an insecure host is
  authorized per operation while its allowed window is open, which is managed
  from Host Detail like every other insecure-window decision.

## Agent Portal Operations

- The persistent master switch is intentionally seeded off. Creating a portal
  user defaults that user on, but no link exchange, message, or relay is active
  until an owner/admin enables the master switch. `PUBLIC_BASE_URL` is the only
  configuration the portal needs.
- Agent Portal lets an owner/admin create a user, read that user's
  permanent link back with **Show link**, enable/disable the user, rotate the
  link, or delete the user. Read-only roles can inspect portal health but cannot
  mutate it and cannot read a link.
- The portal is pull-only: nothing is pushed to a user. Each user opens their own
  permanent link — bookmarked on desktop, or added to the home screen on mobile —
  and finds whatever the agents recorded while they were away.
- **Show link** (`GET /admin/agent-portal/users/{id}/link`) re-renders the stored
  link without rotating it, so an operator can re-bookmark on a new device. It is
  owner/admin only and writes an `agent_portal.user.link_revealed` admin event;
  the link is bearer material and never appears on the unrestricted
  `GET /admin/agent-portal/users` listing. Rotation is the only operation that
  invalidates an existing bookmark.
- Disabling either layer revokes browser sessions and cancels queued or leased
  undelivered commands. Re-enabling never replays them.
- `relay_ready` is the operator-visible truth for writability: it requires a
  live wrapper heartbeat and fresh cooperative `#afk` polling. A registered
  process without that poll loop remains visible but cannot accept commands.

## API Kill Switch
- `POST /admin/api/state` stores `api_disabled` in `versions`.
- Guard runs before route dispatch: when enabled, every path returns `503` except exact path `/admin/api/state`.
- Practical effect: UI/API routes, `/auth`, `/versions`, `/mcp`, installer/seed routes are all blocked until `/admin/api/state` is toggled back.

## Live Updates (WebSocket)
- `GET /admin/ws/info` (admin-auth protected) returns:
  - `enabled` from `ADMIN_WS_ENABLED`.
  - `url` from `ADMIN_WS_PUBLIC_URL` or derived from base URL as `/admin/ws`.
  - `last_event_id`, `heartbeat_seconds` (`ADMIN_WS_HEARTBEAT_SECONDS`, min `5`), `backlog_limit` (`ADMIN_WS_BACKLOG_LIMIT`, clamped `1..500`).
- WebSocket server: in-process Fastify plugin (`api/src/ws/server.ts`) registered at `/admin/ws`.
  - Toggle: `ADMIN_WS_ENABLED`.
  - Requires an admin session: both the upgrade and `/admin/ws/info` call `resolveAdmin`, and neither looks at a certificate.
  - Presence is in-process only (`api/src/ws/server.ts` holds the sockets and nothing else); it is not written to the `versions` table, so no other process can see who is connected.
- Besides push events, the socket now supports targeted request/response hydration for slow host-detail metadata. Current request: `host-detail-support`, returning compact `runner` plus full AGENTS admin metadata for the active host page.
- Dashboard consumes `log.created` events for targeted data refresh and `toast` events for notifications.
- Host, project, and shared memory mutations invalidate the shared `memories`
  query root, so both Atlas views and an open inspector refresh together.
- WebSocket events invalidate only the owning workspace query keys instead of
  forcing a dashboard-wide reload. The retained advanced config API uses its
  documented SHA guard for concurrent updates; it is not represented by a
  generic Config or Profiles tab in the SPA.

## Page-by-Page (Code-Backed)
- **Theme**: neutral System/Light/Dark modes only. The client maps legacy
  `auto-pink`, `bright-pink`, and `dark-pink` preferences to System, Light, and
  Dark and clears `localStorage["codex.theme.palette"]`; the backend continues
  accepting those historical values for compatibility.
- **Overview** (`GET /admin/overview`): host totals, refresh metrics, canonical-auth status, token totals/day/week/month, ChatGPT usage snapshot/summary, quota flags, prune window, reverse-DNS flag, insecure-approval flag, codex lock metadata.
- **Log retention** now has four buckets: API logs, MCP logs, admin events, and set-aside graph stats. The graph-stats bucket controls the compact dashboard quota and usage history store rather than raw verbose logs.
- **Hosts**:
  - List: `GET /admin/hosts`.
  - Host auth view: `GET /admin/hosts/{id}/auth` (`include_body=true` adds canonical auth body; `engine` can be supplied via body/query/header and defaults to `codex`).
  - Register/rotate host key + installer token: `POST /admin/hosts/register`.
    - Required: `fqdn`.
    - Optional: `secure` (default `true`), `vip` (default `false`), `temporary`, `curl_insecure`, `reverse_dns_mode` (`global|enabled|disabled`), `duration_minutes` (`0..480`).
  - Re-mint installer for existing host key: `POST /admin/hosts/{id}/installer`.
  - Quick throwaway host + installer token: `POST /admin/hosts/quick-register`.
    - Required: `engines` (`codex`, `claude`, or both).
    - Always creates an insecure temporary `tmp-*` host with a 2-hour host expiry.
  - Host actions:
    - Mint existing-key installer: `POST /admin/hosts/{id}/installer` (replaces pending installer tokens for that host).
    - Delete host: `DELETE /admin/hosts/{id}`.
    - Clear host auth state/digests: `POST /admin/hosts/{id}/clear` (clears both Codex and Claude host auth linkage/digests for that host).
    - Toggle roaming: `POST /admin/hosts/{id}/roaming` (`allow` bool).
    - Toggle secure flag: `POST /admin/hosts/{id}/secure` (`secure` bool).
    - Toggle VIP: `POST /admin/hosts/{id}/vip` (`vip` bool).
    - Toggle IPv4-only wrapper behavior: `POST /admin/hosts/{id}/ipv4` (`force` bool, clears pinned IPs).
    - Toggle curl insecure wrapper behavior: `POST /admin/hosts/{id}/curl-insecure` (`allow` bool).
    - Per-host reverse DNS mode: `POST /admin/hosts/{id}/reverse-dns` (`mode`).
    - Per-host model/reasoning override: `POST /admin/hosts/{id}/model` (Codex model/reasoning plus Claude model override when the host supports Claude).
    - Per-host codex version override: `POST /admin/hosts/{id}/codex-version`.
    - Per-host Claude Code version override: `POST /admin/hosts/{id}/claude-version`.
    - Per-host AGENTS version override: `POST /admin/hosts/{id}/agents-version`.
- **Insecure Windows & Approval**:
  - Enable/disable per-host window: `POST /admin/hosts/{id}/insecure/enable|disable`.
  - List insecure hosts + domain auto-allows: `GET /admin/hosts/insecure`.
  - Bulk extend active insecure windows: `POST /admin/hosts/insecure/extend`.
  - Bulk disable active insecure windows: `POST /admin/hosts/insecure/disable-all`.
  - Approval queue actions:
    - Approve/deny: `POST /admin/insecure-approvals/{id}/approve|deny`.
    - Approve + allow parent domain: `POST /admin/insecure-approvals/{id}/allow-domain`.
    - Revoke domain allow: `POST /admin/insecure-domain-allows/{id}/revoke`.
- **Users**:
  - List/create/update/delete: `/admin/users`, `/admin/users/{id}`.
  - Wipe all users: `POST /admin/users/wipe` with `{"confirm":"WIPE"}`.
  - Create/update/delete/wipe require `owner` or `admin` once any users exist; every other role may still read the roster.
- **Passkeys**:
  - Passkey login endpoints: `POST /admin/auth/passkey/login/options` with `{username}` (or `{}` for the unambiguous single-user shortcut) and `POST /admin/auth/passkey/login`.
  - Registration endpoints (session required): `POST /admin/auth/passkey/register/options` and `POST /admin/auth/passkey/register`.
  - Management endpoints (session required): `GET /admin/passkeys`, `POST /admin/passkeys/{id}/name`, `DELETE /admin/passkeys/{id}`.
  - Login requires WebAuthn user verification. Normal login uses the entered username to scope `allowCredentials`; when exactly one active user exists and has passkeys, the login page can open that user's passkey prompt directly.
- **Auth Upload & Seed**:
  - Upload canonical auth (requires a configured, reachable runner and a positive live verdict): `POST /admin/auth/upload`.
  - Generate one-time seed command: `POST /admin/auth/seed-command`; body `engine` selects Codex `~/.codex/auth.json` or Claude `~/.claude/.credentials.json`, and generated scripts normalize plain credential files and print server validation errors on upload failure.
  - Seed token TTL: `AUTH_SEED_TOKEN_TTL_SECONDS` (default `900`, fallback if invalid/<=0).
- **Fleet configuration endpoints** (the UI has no generic Settings hub):
  - **Engines** owns cdx silent: `GET/POST /admin/cdx-silent`, quota mode,
    and the Codex/Claude fleet version locks.
  - **Policies** owns the reverse-DNS global flag: `GET/POST /admin/reverse-dns`,
    the insecure-approval global flag: `GET/POST /admin/insecure-approval`,
    pruning, and retention.
  - Projects module: `GET/POST /admin/projects/state`. Enabling it also publishes the managed `coco` skill with embedded toolkit/help through MCP `skill://coco`; disabling it withdraws that managed skill from the MCP resource list.
  - Quota mode: `GET/POST /admin/quota-mode`.
    - `hard_fail` boolean.
    - `limit_percent` normalized to `50..100` (default `100`).
    - `week_partition` one of `off|5|7` (stored as `0|5|7`, default `0`).
  - Prune policy: `POST /admin/prune-policy` (`inactivity_days` clamped `0..60`).
  - Fleet codex version lock: `POST /admin/codex-version` (`latest|auto` clears lock, or strict `x.y.z`).
  - Version refresh: `POST /admin/versions/check`.
- **Runner**:
  - Status: `GET /admin/runner` (enabled/url/base/timeout, last check/ok/fail, state, boot id, 24h counts, last validation/store log, canonical auth metadata).
  - Manual Codex run: `POST /admin/runner/run`.
  - Manual Claude run: `POST /admin/runner/run-claude`.
- **ChatGPT, Logs**:
  - ChatGPT usage snapshot: `GET /admin/chatgpt/usage` (`force` optional, cooldown is 300s unless forced).
  - ChatGPT usage history: `GET /admin/chatgpt/usage/history` (`days`, `from`, `until`, `interval=raw|hour|day`, `lane=normal|spark|both`, `window=primary|secondary|both`).
  - Force ChatGPT refresh: `POST /admin/chatgpt/usage/refresh`.
  - Audit logs: `GET /admin/logs` (`limit`, repository clamps to `1..500`).
  - MCP logs: `GET /admin/mcp/logs` (`limit`, repository clamps to `1..500`).
- **Content Sync Surfaces**:
  - Skills: `GET /admin/skills`, `GET /admin/skills/{slug}`, `POST /admin/skills/generate`, `POST /admin/skills/store`, `DELETE /admin/skills/{slug}`. `POST /admin/skills/generate` uses the runner plus canonical auth to draft a skill into the admin modal, but it never persists anything until `store` runs. When Projects is enabled, the managed `coco` skill appears here as read-only and cannot be overwritten/deleted directly.
  - Projects: `GET /admin/projects`, `POST /admin/projects`, `DELETE /admin/projects/{slug}`, `GET /admin/projects/feedback`, `GET /admin/projects/{slug}`, `POST /admin/projects/{slug}/about`, `POST /admin/projects/{slug}/roster`, `GET /admin/projects/{slug}/changes`, note/todo/file/feedback subroutes, and `GET/POST /admin/projects/state`.
  - AGENTS docs: `GET /admin/agents`, `POST /admin/agents/store`, `POST /admin/agents/serve`, `DELETE /admin/agents/versions/{id}`.
  - Config builder: `GET /admin/config`, `POST /admin/config/render`, `POST /admin/config/store`.
  - Memory Atlas graph: `GET /admin/memories/graph` with scope/search/tag/host/project/engine filters plus filter-bound opaque cursor pagination (500 records by default, 2,000 maximum). It omits full bodies and returns stable nodes, explicit relationship edges, facets, totals, and truncation metadata.
  - Unified memory lifecycle: `GET /admin/memories/{scope}/{recordId}`, `POST /admin/memories/{scope}`, `PATCH|DELETE /admin/memories/{scope}/{recordId}`, and `POST /admin/memories/shared/{recordId}/append`, where `scope` is `host`, `project`, or `shared`. Detail returns the full-state ETag in JSON and the HTTP `ETag` header; PATCH and DELETE accept `expected_etag` (or `If-Match`) and return `409 memory_conflict` with `current_etag` when stale. Keys/slugs and host/project ownership cannot be changed after creation.
  - Memory activity: `GET /admin/memories/audit?node_id=...` normalizes body-free admin logs, project events, and shared revision metadata. It is retention-bound operational history, not immutable compliance history and not a restore source.
  - Deprecated compatibility reads/deletes remain unchanged under `/admin/mcp/memories` and `/admin/shared-memories`; they do not inherit the unified ETag/role/response contract, and new UI code uses `/admin/memories/*`.
- **Toasts**:
  - Manual toast endpoint: `POST /admin/toasts` (admin-auth protected, no role gate).
  - Automatic auth toasts are emitted from log actions:
    - `auth.retrieve` => `CDX authorized` (success).
    - `auth.denied` / `auth.insecure.denied` => `CDX refused` (warn/error).

## Common Workflows
- **Onboard host**: `POST /admin/hosts/register` -> run returned installer command. For disposable VMs, use `POST /admin/hosts/quick-register` or the WebUI `Quick VM` button.
- **Rotate canonical auth**: `POST /admin/auth/upload` (requires positive live runner validation).
- **Seed canonical auth from local machine**: `POST /admin/auth/seed-command` with `engine` (`codex` or `claude`) -> execute generated `curl | bash`.
- **Recover a locked-out admin who lost all passkeys**: no equivalent currently shipped — passkey rows must be removed manually from the `admin_passkeys` table.
- **Enable shared project coordination**: `POST /admin/projects/state` with `{"enabled":true}`.
- **Create a shared project**: `POST /admin/projects` with `slug`, optional `about`, and optional `roster_markdown`.
- **Open insecure window**: `POST /admin/hosts/{id}/insecure/enable` with `duration_minutes`.
- **Force runner validation now**: `POST /admin/runner/run` for Codex, `POST /admin/runner/run-claude` for Claude.
- **Freeze/unfreeze fleet codex version**: `POST /admin/codex-version` with `selection` (`latest` or pinned semver).
- **Manage memory lifecycle**: Memories → choose Atlas or Inventory,
  create in the intended scope, then inspect/edit/append/delete from the detail
  panel. Shared append is the concurrency-safe operation for adding content;
  PATCH/DELETE conflicts require reloading the latest ETag before retrying.

## Notes & Gotchas
- Installer tokens are single-use and expire after a TTL fixed at `1800` seconds in `api/src/services/host-management.ts`; it is a constant, not an env knob.
- Insecure host registration opens an initial window:
  - Initial open window defaults to `30` minutes.
  - Stored sliding window defaults to `10` minutes unless `duration_minutes` is provided.
- Insecure window refresh is applied on non-store checks (`/auth` retrieve path, `/mcp`, `/host/lane`), not on plain `/auth` store.
- Insecure approval queue is not gated on websocket presence; there is no such heartbeat window. The `insecure_approval_enabled` flag is a settings toggle reported by `GET /admin/overview`, and `GET /admin/insecure-approvals/pending` lists the queue to any admin regardless of it.
- The dashboard now rehydrates the insecure approval queue from `GET /admin/insecure-approvals/pending` on load and websocket reconnect, so pending requests still show up even if the original live event was missed.
- A live `auth.insecure.pending` event now rings a short synthesized bell in the admin dashboard when a genuinely new insecure approval request arrives. Browser autoplay/user-gesture policy still applies, so the sound is best-effort rather than guaranteed on a never-interacted tab.
- The Projects module is deliberately native to codex-orchestrator: the direct
  `/admin/projects` workspace owns its module toggle and compact index, while
  each project opens on its own `/admin/projects/<slug>` workspace page. The
  managed `coco` skill is derived from module state instead of being edited like
  a normal Skill row, doubles as the operator-facing CoCo toolkit/help document,
  and now tells operators to keep shared CoCo handoffs in Projects rather than
  host-scoped MCP memories.
- Project creation remains API-driven for now; the admin UI intentionally focuses on browsing, opening, and deleting existing projects.
- Memory Atlas delete is a hard, permanent delete in every scope. There is no
  trash, restore, revision-body diff, or rollback action; the confirmation
  dialog is the final safety boundary.
- Global rate limit bucket (`global`) is skipped for `/admin/*` routes but still applies to non-admin routes.
- Auth-fail limiter (`auth-fail`) is enforced for bad `/auth` API-key attempts (defaults: `20` per `600s`, `1800s` block; configurable).
