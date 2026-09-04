# Admin Dashboard

Code-truth operator map for `/admin/*`. Source of truth is runtime code (`api/src/server.ts`, `api/src/routes/admin/*`, `api/src/services/*`).

## Access & Auth
- UI shell served by `adminSpaHtmlPreHandler` in `api/src/routes/admin/pages/static.ts`: `/admin/`, `/admin/login`, `/admin/hosts/{id}`. Admin session state is hydrated client-side via `/admin/auth/status`.
- Every guarded `/admin/*` route is gated by the admin session cookie through `requireAdmin` (`api/src/http/plugins/auth-admin.ts`). No admin route checks a client certificate.
- `ADMIN_ACCESS_MODE` accepts `cookie` (default) or `open`, and `api/src/routes/cli-auth/index.ts` is the only file that reads it: any value except `open` makes `/cli/auth/verify` require an admin session. It has no effect on `/admin/*`.
- There is no client-certificate gate here any more. The bundled `caddy` profile terminates TLS and reverse-proxies; it does not request client certificates, and this server neither issues nor verifies them.
- `authMtlsPlugin` (`api/src/http/plugins/auth-mtls.ts`) publishes the `X-MTLS-*` claims an upstream proxy may forward into `req.mtls` — `present` is just a non-empty `X-MTLS-Fingerprint` — and only when the connecting peer is inside `TRUSTED_PROXY_CIDRS`, because a direct caller can set those headers too. Nothing else in `api/src` consults `req.mtls`.
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

## First-Run Setup (`/admin/setup`)
- `/admin/setup` is the first-run wizard and the only console surface an unclaimed installation offers. `frontend/src/routes/setup/+page.svelte` renders it outside the app shell (it is in the layout's `STANDALONE` list), so it owns the viewport.
- `/admin` itself (`frontend/src/routes/+page.svelte`) waits for the auth store to settle and stands down when the installation is unclaimed, leaving the navigation to the layout gate. Redirecting immediately raced that gate and usually lost, so a brand-new install opened on a dashboard full of 401s.
- Four routes, all behind `requireAdminAfterSetup` (`api/src/routes/admin/setup/index.ts`): public only while `admin_users` is empty, session-gated afterwards.
  - `GET /admin/setup/status` — the six critical checks, configured engines, verified canonical-auth presence, host/sync counts, warnings, next actions, and the wizard blob mirrored inline as `wizard` so the console needs one request.
  - `POST /admin/setup/owner` — serialized one-time first-owner claim. Creates one fixed active `owner` and issues the normal admin session cookie inline, so the wizard never bounces through `/admin/login`. Later claims return `409 first_owner_claimed`.
  - `GET /admin/setup/wizard` / `POST /admin/setup/wizard` — the progress blob `{completed_at, dismissed_at, last_step, engines}`. Position and completion only: every answer the wizard collects is written by the endpoint that owns it (`/admin/model-defaults/:engine`, the module switches, `/admin/hosts/register`).
- The six critical checks (`api/src/services/setup-status.ts`) are `database`, `migrations`, `runner`, `signer`, `wrappers`, and `public_base_url`. `setup_complete` is `criticalComplete && ownerCreated` — it goes true at step two of nine and is not a "wizard finished" signal.
- Nine steps, defined by `api/src/services/setup-wizard.ts` and mirrored in `frontend/src/lib/api/setup.ts`:

  | Step | Writes through | Blocking |
  |---|---|---|
  | `infrastructure` | nothing — reports the six checks and the command that fixes each | **yes** |
  | `owner` | `POST /admin/setup/owner` | **yes** |
  | `engines` | wizard blob only (`engines`) | no |
  | `auth` | `POST /admin/auth/upload`, `POST /admin/auth/seed-command` | no |
  | `defaults` | `POST /admin/model-defaults/:engine` | no |
  | `policy` | `POST /admin/agents/store` (house rules appended to the seeded policy) | no |
  | `modules` | `POST /admin/projects/state`, `POST /admin/secrets/state`, optional `POST /admin/projects` | no |
  | `collaboration` | `POST /admin/agent-portal/state`, `POST /admin/agent-messaging/state`, optional `POST /admin/agent-portal/users` | no |
  | `host` | `POST /admin/hosts/register` | no |

- Only the first two block: infrastructure is not fixable from a browser, and nothing else can be written without the session the owner claim issues. Everything after has **Skip**, because "no" is a complete answer to most of it.
- The `auth` step drops out of the rail entirely when the engines answer is `[]`. An empty array is a real answer ("none"); `null` means "not asked yet".
- `setup_wizard_state` is one JSON blob in the `versions` K/V table — no new table, no migration. Progress writes pass `publish: false`, so they never emit `settings.changed`; anything that changes real state must invalidate `["setup","status"]` itself (`invalidateSetup` in `frontend/src/lib/api/setup.ts`).
- The dashboard resume card is `frontend/src/routes/dashboard/OnboardingCard.svelte`. It renders only while the wizard is unfinished (`completed_at` and `dismissed_at` both null) **and** at least one `next_actions` entry is incomplete, deep-links back to `?step=<last_step>`, and offers **Dismiss**, which hides it permanently.
- `next_actions` are `auth_<engine>` (one per engine in `DEFAULT_HOST_ENGINES`), `first_host`, and `first_sync`. The auth entries link to `/admin/setup?step=auth` — not `/admin/api-keys`, which manages proxy bearer keys and has never had canonical-auth UI. An auth entry counts as complete only for **verified** canonical auth.
- The credentials form is `frontend/src/lib/components/setup/SeedAuthPanel.svelte`, mounted by both the wizard and the Hosts → More → **Seed canonical auth** dialog, which keys it on `open` so each opening mounts a fresh panel. Between them they are the product's only canonical-auth UI. The panel reads `verification_state` from `POST /admin/auth/upload` and distinguishes verified / pending / failed rather than reporting unconditional success, and says up front when the auth runner is down instead of letting every attempt fail with an identical 503.

## Navigation & Presentation
- One registry (`frontend/src/lib/nav.ts`) drives navigation, mobile Menu, the
  command palette, title, breadcrumb, and active state. Its direct groups are
  **Monitor** (Overview, Active Clients, Activity), **Fleet** (Hosts, Engines, Policies),
  **Coordinate** (Projects, Agent Messaging, Agent Portal), **Knowledge**
  (Skills, Fleet Instructions, Memories, Subagents, Commands, Output Styles),
  and **Access** (API Access, Secrets, Admin Users). Manual and Account stay in
  the sidebar footer. There is no generic Settings or Authoring destination.
- Legacy Settings and Authoring URLs issue 308 client redirects to the direct
  owner route. Mapping lives in `frontend/src/lib/legacy-admin-routes.ts`.
- Fleet Instructions (`/admin/instructions`) opens with a **Generation** switch:
  *Generated* composes the policy modules and custom instructions, *Manual*
  swaps the builder for a raw Markdown editor, and *Disabled* stops serving the
  generated modules. It is fleet-wide, applies the moment it is picked, and
  saves no version — the stored module selection survives a trip through
  Disabled and comes back untouched. None of the three positions removes the
  mandatory fleet policy or the host capability guidance from what agents read.
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

## Roles & Capabilities
- Accepted `access_level` values are `VALID_ACCESS_LEVELS` in
  `api/src/services/admin-auth.ts`: `owner`, `admin`, `viewer`, `fleet_operator`,
  `trusted_user`, and the legacy `user`. Anything else is rejected on
  create/update.
- Authorization is a **default-deny capability layer**, not a session check.
  `requireAdmin` (`api/src/http/plugins/auth-admin.ts`) authenticates — it
  resolves the session cookie and requires an active user row — and that is all
  it has ever done. What decides whether the caller may proceed is
  `api/src/security/route-capabilities.ts`, which assigns one capability to
  every route under `/admin/*` and to the session-guarded `/cli/auth/*` routes,
  and `api/src/http/plugins/capabilities.ts`, which attaches the matching guard
  as each route is registered.
- **A route with no entry in that inventory is a startup failure.** The plugin
  collects every governed route it cannot find and throws at `onReady`, naming
  each one, so a new endpoint cannot ship session-only by omission.
  `api/test/unit/security/route-capability-coverage.test.ts` runs the same check
  in CI against the real route tree.
- Denials answer `403` with code `admin_role_required` and a
  `required_capability` field naming what was missing. Callers with no session
  still get `401` and `admin_required`.
- The role→capability matrix lives in `api/src/security/capabilities.ts`. The
  table below is generated from it by `npm run docs:capabilities`;
  `api/test/unit/security/capability-docs.test.ts` fails when the two disagree.

<!-- BEGIN GENERATED: capability-matrix -->

| Capability | `owner` | `admin` | `fleet_operator` | `trusted_user` | `viewer` | `user` |
| --- | --- | --- | --- | --- | --- | --- |
| `admin.read` | yes | yes | yes | yes | yes | yes |
| `account.self_manage` | yes | yes | yes | yes | yes | yes |
| `users.read` | yes | yes | yes | yes | yes | yes |
| `users.manage` | yes | yes | — | — | — | — |
| `hosts.read` | yes | yes | yes | yes | yes | yes |
| `hosts.manage` | yes | yes | yes | — | — | — |
| `hosts.security_transition` | yes | yes | — | — | — | — |
| `hosts.activate_insecure` | yes | yes | yes | yes | — | — |
| `settings.read` | yes | yes | yes | yes | yes | yes |
| `settings.manage` | yes | yes | yes | — | — | — |
| `security.manage_authorization` | yes | yes | — | — | — | — |
| `auth.read_metadata` | yes | yes | yes | yes | yes | yes |
| `auth.manage` | yes | yes | yes | — | — | — |
| `auth.reveal_credential` | yes | yes | — | — | — | — |
| `keys.manage` | yes | yes | — | — | — | — |
| `content.read` | yes | yes | yes | yes | yes | yes |
| `content.manage` | yes | yes | — | — | — | — |
| `memory.read` | yes | yes | yes | yes | yes | yes |
| `memory.write` | yes | yes | — | — | — | — |
| `projects.read` | yes | yes | yes | yes | yes | yes |
| `projects.manage` | yes | yes | — | — | — | — |
| `secrets.read_metadata` | yes | yes | yes | yes | yes | yes |
| `secrets.reveal` | yes | yes | — | — | — | — |
| `secrets.manage` | yes | yes | — | — | — | — |
| `agent_portal.read` | yes | yes | yes | yes | yes | yes |
| `agent_portal.reveal_link` | yes | yes | — | — | — | — |
| `agent_portal.reveal_transcript` | yes | yes | — | — | — | — |
| `agent_portal.manage` | yes | yes | — | — | — | — |
| `agent_messaging.read` | yes | yes | yes | yes | yes | yes |
| `agent_messaging.reveal_content` | yes | yes | — | — | — | — |
| `agent_messaging.manage` | yes | yes | — | — | — | — |
| `git_director.read` | yes | yes | yes | yes | yes | yes |
| `git_director.manage` | yes | yes | yes | — | — | — |
| `audit.read` | yes | yes | yes | yes | yes | yes |

<!-- END GENERATED: capability-matrix -->

- `owner` and `admin` hold every capability. They differ only in the ownership
  invariants enforced in `api/src/services/admin-users.ts` — the last active
  owner-like account cannot be demoted, deactivated, or deleted — which are
  properties of the *target* row and so cannot be expressed as a capability of
  the caller.
- `fleet_operator` runs the fleet: hosts, insecure windows, global settings, and
  fleet credentials. It holds no account management, no reveal of any kind, and
  none of `hosts.security_transition` — deleting or registering a host, changing
  its engines, or moving it between the secure and insecure lanes stays with
  `owner` and `admin`, because each can atomically revoke or generation-fence
  live Agent Messaging work.
- `trusted_user` holds the reads plus `hosts.activate_insecure`, and nothing
  else.
- `viewer` and the legacy `user` are read-only.
- Four reads are their own capability rather than part of the domain's `.read`,
  because each returns bearer material or private content:
  `secrets.reveal` (plaintext credential), `agent_portal.reveal_link` (a
  reusable permanent portal link), `agent_messaging.reveal_content` (a decrypted
  message body), and `auth.reveal_credential` (the canonical credential the
  fleet distributes to hosts). Every listing beside them is metadata-only.
- `auth.reveal_credential` is the one capability a route raises *itself*.
  `GET /admin/hosts/{id}/auth` is metadata — digests and refresh timestamps —
  until `include_body=1`, which adds the live credential body. The inventory
  gives the route `auth.read_metadata` as its floor; the handler calls
  `app.assertCapability(req, 'auth.reveal_credential')` when the flag is set. A
  `fleet_operator` holds `auth.manage` and may therefore replace the fleet's
  credential, but never read the current one back out.
- `account.self_manage` is held by every role: signing out, changing your own
  password, and managing your own passkeys must not depend on a grant an
  operator can lose.
- `GET /admin/auth/status` returns the caller's row of the matrix as
  `capabilities`. The admin console uses it to disable the controls a `403`
  would meet — `frontend/src/lib/auth/capabilities.ts` and the `can()` helper on
  `authStore`. That is presentation only: the server re-checks every request,
  and a console that lies to itself gains nothing.
- Memory reads still carry a per-record `capabilities` object (`read`, `create`,
  `update`, `delete`, `append`). It now derives from `memory.write` rather than
  from a second copy of the role check.
- Login enforcement counts active `owner` and `admin` rows only, so a fleet of
  `viewer` accounts never switches login on.

### Upgrading from a session-only installation
Before this layer, every admin route not covered by one of six hand-written
gates was open to any authenticated, active user — 181 of the 225 governed
routes. Enforcing the matrix under accounts created in that world would lock
operators out of their own installation, so **enforcement has a mode, and
upgrading does not change behavior.**

| Mode | Who may do what |
|---|---|
| `compatible` | Exactly the pre-matrix rules: `owner` and `admin` may do everything, every other role is refused exactly the 33 routes the old gates covered and admitted to the rest. |
| `strict` | The matrix above. |

Migration `0022` sets `compatible` on any installation that already had users
and `strict` on a fresh one, so **an upgrade is a behavioral no-op and a new
install is secure from first boot**. `authorization-compatibility.test.ts`
proves the no-op by exercising every role against every route rather than
asserting it.

Two capabilities are enforced under *both* modes: `auth.reveal_credential`
(reading a stored canonical credential body back out — a privilege escalation
with no caller in the console, the wrappers, or the runner) and
`security.manage_authorization` (the mode itself; a posture every account could
flip would not be one).

### Moving to strict

While a fleet runs in `compatible`, every request the matrix *would* have
refused is recorded. `GET /admin/authorization` returns that list — the
distinct role/capability/route triples, with first and last seen — so the
question "what breaks if I switch" is answered by your own traffic instead of by
auditing a roster. When the list holds only accounts you intend to restrict:

```bash
curl -X POST https://<host>/admin/authorization \
  -H 'content-type: application/json' \
  --cookie '<admin session>' \
  -d '{"mode":"strict"}'
```

The switch is reversible with `{"mode":"compatible"}`, and both directions
require `security.manage_authorization` — owner and admin only. Instances cache
the mode for up to 30 seconds, so a multi-instance deployment converges within
that window rather than instantly; no restart is needed.

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
- **Active Clients** (`/admin/clients`) is the same session view over the admin
  session cookie instead of a portal magic link, so an operator already signed
  in to the console does not need a second identity to see what the fleet is
  doing. It lists every wrapper with its derived presence, the age of the turn
  it is running, its outstanding attention notice, and the Git Director task and
  Agent Messaging address for the worktree it is sitting in. The page is empty
  whenever the master switch is off — registration is discarded server-side —
  and says so rather than showing a bare list.
- The console view is deliberately read-only apart from **Force close**.
  Messaging an agent and answering its prompts insert into `agent_messages`,
  whose `portal_user_id` is NOT NULL and also carries the message idempotency
  identity, so an admin account cannot author one; `/go` remains where a reply
  comes from. Force-close writes an event and a terminal state and no queue row,
  and it is the only close that still works once the agent has gone offline.
- Reading a session timeline needs `agent_portal.reveal_transcript`, separate
  from `agent_portal.read` because the events carry the message bodies rather
  than metadata about them. That capability and `agent_portal.manage` are both
  on the always-enforced list in `api/src/security/authorization-mode.ts`, so
  `compatible` mode does not relax either. Without that, every role would reach
  both: the legacy owner/admin route set in the same file is pinned to the gates
  as they stood before the capability layer and can never grow, which leaves
  every route added afterwards open under that mode.

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
  - Open the fleet-wide window ("work hours"): `POST /admin/hosts/insecure/window` with optional `duration_minutes` (5–1440, default 480).
  - Close it: `POST /admin/hosts/insecure/window/close`. Closing — by button or when the deadline passes — clears every insecure host's window and grace and expires active domain auto-allows.
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
  - Manual Codex run: `POST /admin/runner/run` (no body fields; runs the canonical verification pipeline and reports `verdict` / `applied` / digests).
  - Manual Claude run: `POST /admin/runner/run-claude` (same contract).
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
- **Bring up a new installation**: `bin/install.sh` on the Docker host until it prints `READY`, then open `/admin/setup` and walk the wizard. The two block-until-green steps are infrastructure and the owner claim; the rest can be skipped and resumed from the dashboard card.
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
- **A fresh install has no `client_config_documents` row, and that silently disables every managed feature.** With no row for the engine, `host-agents.ts` reports `config_missing` and resolves skills, memory, projects and secrets to disabled *before their own switches are read* — so enabling Projects on a brand-new install provably does nothing. (Codex is the strict case: a missing Codex row is `config_missing` outright, while Claude falls back to an empty settings object.) `POST /admin/model-defaults/:engine` is the only thing that creates that row, while the matching `GET` cheerfully returns a default that was never persisted, which is how a console can look configured while every managed feature is dark. The wizard's Fleet defaults step therefore saves codex defaults **unconditionally**, including on the "neither engine" path: it is MCP activation, not credentials. Outside the wizard, saving the **Codex** section in `/admin/engines` creates that row — `ModelDefaultsService.set(engine, …)` is per-engine, so saving only Claude defaults leaves Codex hosts in `config_missing`.
- `setup_complete` on `GET /admin/setup/status` means `criticalComplete && ownerCreated` only. It is true from step two of nine and says nothing about whether the operator finished the wizard; `wizard.completed_at` / `wizard.dismissed_at` are the flags for that.
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
- No in-process request-rate limiter is installed. Authentication and authorization failures are returned directly without a frequency bucket.
