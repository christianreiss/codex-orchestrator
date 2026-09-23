---
title: Hosts — secure, insecure, unprovisioned
section: Fleet operations
verified: 2026-09-09
sources: api/src/routes/admin/hosts/index.ts, api/src/routes/admin/overview/index.ts, api/src/routes/admin/settings/index.ts, api/src/services/host-management.ts, api/src/services/host-auth.ts, api/src/services/insecure-window.ts, api/src/services/insecure-window-admin.ts, api/src/services/insecure-fleet-window.ts, api/src/ops/insecure-fleet-window-worker.ts, api/src/security/route-capabilities.ts, api/src/db/schema.ts, frontend/src/routes/hosts/+page.svelte, frontend/src/routes/hosts/[id]/+page.svelte, frontend/src/lib/components/hosts/FilterChips.svelte, frontend/src/lib/components/hosts/InsecureApprovalsDialog.svelte, frontend/src/lib/components/hosts/InsecureApprovalsAutoPopup.svelte, frontend/src/lib/stores/insecure-resolutions.ts, frontend/src/lib/api/hosts.ts
---

# Hosts — secure, insecure, unprovisioned

A *host* is any machine running `cdx` or `clx` under your orchestrator. The Hosts page at `/hosts` shows the full fleet and provides filter chips to narrow the view. Detail pages live at `/hosts/[id]`. The list and detail JSON are served by `api/src/routes/admin/overview/index.ts` (`GET /admin/hosts`, `GET /admin/hosts/{id}/detail`); host mutations (register, toggles, overrides, insecure windows, approvals) are handled by `api/src/routes/admin/hosts/index.ts`.

## The filter chips

The host list page offers eight client-side filter chips — no separate backend queries back each one. All filtering runs client-side over a single result set from `GET /admin/hosts` (the dedicated fleet-listing endpoint; `GET /admin/overview` is a separate endpoint that feeds the Dashboard page, not this list):

- **All** — the full fleet, unfiltered.
- **Online** — hosts whose computed status is "online" (see *Online status* below).
- **Offline** — hosts whose computed status is "offline".
- **Secure** — hosts where `secure = true`.
- **Insecure** — hosts where `secure = false`.
- **Unprovisioned** — hosts missing the required canonical auth digest for their configured engine(s) (`hostHasRequiredAuth()` returns false). Usually a host that registered but never completed its first sync — but a host whose auth was cleared also lands here until it re-syncs.
- **VIP** — hosts with the VIP flag set (bypass quota).
- **Roaming** — hosts with IP re-binding enabled.

A debounced search box (searches `fqdn`, Codex/Claude version including overrides, and status) sits alongside the chips. Filtering is entirely client-side.

> Note: `GET /admin/hosts/insecure` is a separate endpoint used exclusively by the insecure approvals panel — it is not the backing query for the Insecure filter chip.

## Header buttons

The host list page header carries:

- **Insecure access** — shown only while at least one insecure window is open; an amber badge carries the count. It opens the insecure access dialog (see *The insecure approval queue* below), which also opens automatically when the URL contains `?insecure=1` and when a new request arrives over the live feed.
- **More ▾** — a menu with **Seed canonical auth** (the shared `SeedAuthPanel`; the one-time command is copied automatically when generated) and **Review insecure access** (the same dialog, reachable even when no window is open).
- **Quick VM** — opens the *Quick VM* dialog for a minimal-input registration. The installer command is copied automatically after provisioning.
- **New host** — opens the *New Host* slide-in sheet for full registration (also bound to the `n` shortcut). The installer command is copied automatically after registration.

There are no chord keyboard shortcuts for host navigation. Keyboard access is through the Cmd-K command palette and single-key shortcuts (`?`, `/`, `n`, Escape) only.

## Registering a host

`POST /admin/hosts/register` creates the host row and returns an install token. It carries the `hosts.security_transition` capability — owner and admin only — because reusing an FQDN rotates the host key and generation-fences live Agent Messaging work. `POST /admin/hosts/quick-register` is the abbreviated form used by *Quick VM* and needs only `hosts.manage`, which a `fleet_operator` also holds.

Full registration inputs (`POST /admin/hosts/register`):

- `fqdn` — the canonical hostname to assign.
- `secure` — `true` for a normal host; `false` to open it insecure-by-default with a grace window.
- `vip` — mark host as VIP on creation.
- `temporary` — flag the host as temporary.
- `curl_insecure` — enable curl-insecure probe on creation.
- `reverse_dns_mode` — initial reverse-DNS mode.
- `engines` — array of `codex` / `claude` the host will run. Defaults come from `DEFAULT_HOST_ENGINES`.
- `duration_minutes` — if insecure on registration, the length of the grace window in minutes (clamped to MIN=0 / MAX=480).

Quick registration inputs (`POST /admin/hosts/quick-register`): `engines` and `duration_minutes` only.

Both responses contain an install URL. Until the host completes its first sync it appears under the *Unprovisioned* filter chip.

## Online status

Online status is computed entirely in the frontend by `hostStatusKind()` — there is no backend field that drives it. The logic:

1. If `host.status` is `'offline'`, `'stale'`, or `'disabled'` → **Offline**.
2. If required engine digests are absent or `authed === false` → **Auth missing**.
3. If `auth_outdated === true` → **Outdated auth**.
4. If `max(updated_at, last_refresh, claude_last_refresh)` is within the last 24 hours (`HOST_ONLINE_WINDOW_MS = 24 h`) → **Online**.
5. Otherwise → **Offline**.

## Host detail page

Visiting `/hosts/[id]` loads the detail view. Page data is fetched from `GET /admin/hosts/{id}/detail`. A separate `GET /admin/hosts/{id}/auth` endpoint also exists (`engine` and `include_body` query params) for pulling a host's canonical digest/auth view directly, but the detail page itself does not call it.

### Status pills

At the top of the page, pills show at a glance:

- **Auth state**: Secure / Insecure / Insecure (closed)
- **Liveness**: Online / Auth missing / Outdated auth / Offline
- Optional badges: VIP, Roaming, BrowserOS, Auto-update, and engine badges

### Stats card

Shows runtime metrics for the host:

- **Last contact** — derived from `max(last_refresh, claude_last_refresh)`.
- **Last cron check** — timestamp of the most recent scheduled check.
- **API calls (recent)** — recent call count.
- **Insecure window countdown** — time remaining if an insecure window is active.

### Action items card

Displays warnings that require attention:

- Codex version drift vs. fleet baseline.
- Claude version drift vs. fleet baseline.
- Host not authenticated.
- Auth payload stale.
- Active insecure window information.

### Technical context card

Read-only fields showing the host's configuration:

Host ID, FQDN, IPv4/IPv6, Codex version (override or reported), Claude version, Wrapper (Codex) version, Wrapper (Claude) version, Model override, Reasoning override, Claude model override, Binary digest, VIP, Auto-update, Insecure state, Roaming, Lane preference, Reverse DNS (inline tri-state segmented control: Inherit / Force on / Force off), Agents doc override. Next to the bound addresses, **Release IP binding** clears both `ip4` and `ip6` (`POST /admin/hosts/{id}/release-ip-binding`) so the next successful auth re-binds; it is a clearing action, not an editable address field.

### Controls card

Toggle switches: **Secure**, **Auto-update**, **VIP**, **Roaming**, **Scaling exempt**, **Curl insecure**, **BrowserOS MCP**, and per-engine **Codex**/**Claude** switches (each disabled when it's the host's only remaining engine, via `POST /admin/hosts/{id}/engines`).

Buttons depend on host state:

- **Extend insecure window** / **Close insecure window** (shown when a window is active) or **Open insecure window** (shown when host is insecure and no window is active).
- **Codex version** and **Codex model override** (when the Codex engine is configured) or **Add Codex** (when it is not).
- **Claude version** and **Claude model override** (when the Claude engine is configured) or **Add Claude** (when it is not).
- **Agents version** — pin the AGENTS.md version.
- **Mint installer** — generates a new installer via `POST /admin/hosts/{id}/installer`; the current **Curl insecure** toggle value is included so the auto-copied command reflects the visible setting.
- **Delete host** — removes the host via `DELETE /admin/hosts/{id}`.

Every mutation names a capability. Deleting a host, toggling its engines, and flipping **Secure** are `hosts.security_transition` (owner/admin); the insecure-window buttons are `hosts.activate_insecure` (owner, admin, fleet operator, trusted user); everything else on this page is `hosts.manage` (owner, admin, fleet operator). Controls a role does not hold are disabled with a tooltip naming the missing capability.

### Full mutations reference

| Action | Endpoint |
|--------|----------|
| Delete host | `DELETE /admin/hosts/{id}` |
| Clear baked auth (endpoint only; no button on the page) | `POST /admin/hosts/{id}/clear` |
| Release IP binding | `POST /admin/hosts/{id}/release-ip-binding` |
| Toggle roaming | `POST /admin/hosts/{id}/roaming` |
| Mark secure / insecure | `POST /admin/hosts/{id}/secure` |
| Toggle VIP | `POST /admin/hosts/{id}/vip` |
| Toggle scaling exempt | `POST /admin/hosts/{id}/scaling-exempt` |
| Override auto-update | `POST /admin/hosts/{id}/auto-update` |
| Enable insecure window | `POST /admin/hosts/{id}/insecure/enable` |
| Disable insecure window | `POST /admin/hosts/{id}/insecure/disable` |
| Set per-host model | `POST /admin/hosts/{id}/model` |
| Pin Codex version | `POST /admin/hosts/{id}/codex-version` |
| Pin Claude version | `POST /admin/hosts/{id}/claude-version` |
| Pin AGENTS.md version | `POST /admin/hosts/{id}/agents-version` |
| Set reverse-DNS mode | `POST /admin/hosts/{id}/reverse-dns` |
| Toggle engine (codex/claude) | `POST /admin/hosts/{id}/engines` |
| Toggle BrowserOS MCP | `POST /admin/hosts/{id}/browseros-mcp` |
| Toggle curl-insecure probe | `POST /admin/hosts/{id}/curl-insecure` |
| Mint installer | `POST /admin/hosts/{id}/installer` |

## The insecure approval queue

When an insecure host is outside its grace window and tries to pull auth, `host-auth.ts` withholds the payload and creates a row in `insecure_auth_requests`, recording the caller's IP. An interactive `cdx`/`clx` then parks on its approval box and re-polls every five seconds; each poll is a heartbeat that stamps the row's `updated_at`. The queue is visible in the **Insecure access** dialog (`InsecureApprovalsDialog`), opened from the host list header, from *More → Review insecure access*, from the amber **Insecure approvals** item at the top of the left-hand navigation (shown on every page while approvals are pending), or automatically. `InsecureApprovalsAutoPopup` opens it on its own only for requests someone is waiting on (`live`: the host polled again after asking), so a one-shot headless call never pops it; it then plays a short synthesized beep (880 Hz, at most once per two seconds; browser autoplay rules still apply) and — if you enabled browser notifications from the link inside the dialog — fires a desktop notification so a background tab still hears the request. The pending list itself is `GET /admin/insecure-approvals/pending`, polled every 10 seconds while anything is pending (30 seconds otherwise), also in a background tab, re-fetched on focus and on every insecure WebSocket event.

The dialog has two views. The one that opens itself is the **request view**: one card per host with a live dot (green while the wrapper is waiting), the IP, how long ago it asked, a countdown and a draining bar to the automatic deny, and **Approve for 8 hours**, **Allow \*.domain** (a popover with the duration and a **Never expires** switch), and **Deny**. With exactly one request on screen, `Enter` approves and `D` denies; with several, **Approve all** approves each in turn. **Manage access** switches to the full view; the host-list buttons open that full view directly, with **Requests**, **Windows** (the fleet-wide window controls described below, then every open host window with **Extend** and **Close**, plus **Extend all** / **Disable all**), and **Domains** (each allow with a countdown or *Never expires*, and **Revoke**) tabs.

Requests that no longer need a decision are retired server-side — when the queue is read, when the host polls, and every 10 seconds by the insecure worker: after five minutes unanswered (`denied`, reason `timeout`, starts the 60-second deny cooldown), after 30 seconds without a heartbeat (`expired`, reason `abandoned`, no cooldown — a rerun simply opens a fresh request), or when the host was deleted, made secure, or already let in (`expired`, reason `superseded`). Resolving a row is visible: an approved, denied, domain-allowed, auto-allowed, timed-out, abandoned, or superseded row fades to a labelled shadow for 1.6 seconds and slides out, whether the resolution came from your click, another operator's tab, a domain sweep, the fleet window, or the server. A row past its deadline greys out locally even before the refetch lands, and approving one the server already settled shows *No longer pending* rather than an error. A dialog that opened itself closes again only once the last shadow has cleared and nobody is waiting; one you opened, or switched to the full view, stays open.

Review endpoints:

- `GET /admin/insecure-approvals/pending` — list pending approvals.
- `POST /admin/insecure-approvals/{id}/approve` — approve and release auth. Optional `duration_minutes`; the default is **480 (8h)**, the same grant the fleet window hands out, not the host's 10-minute sliding default. The chosen length is also written to `insecure_window_minutes`, so later slides in `enforce()` keep it.
- `POST /admin/insecure-approvals/{id}/deny` — deny and log.
- `POST /admin/insecure-approvals/{id}/allow-domain` — add the requester's domain to the trusted list. Also resolves **every other pending request whose host falls under that domain** (returned as `cleared_request_ids`), because `enforce()` would now admit them without a prompt. Optional `duration_minutes` (default 480), or `permanent: true` for an allow with no expiry that survives a restart — still cleared by *Disable all*.
- `POST /admin/insecure-domain-allows/{id}/revoke` — reverse a previous domain allow.
- `POST /admin/hosts/insecure/extend` — re-extend the active window for every currently-open insecure host by its stored `insecure_window_minutes` (falls back to 60 if unset, clamped to 5–1440).
- `POST /admin/hosts/insecure/disable-all` — close every insecure window at once. Also expires active domain allows and retracts the fleet window, since either one would otherwise re-open the hosts on their next poll.
- `POST /admin/hosts/insecure/window` — open the fleet-wide window ("work hours"): optional `duration_minutes` (5–1440, default 480). Every insecure host is auto-allowed until the deadline, and the pending approval queue is resolved as approved. Re-opening replaces the deadline rather than extending it.
- `POST /admin/hosts/insecure/window/close` — close it. Closing — by this route, by *Disable all*, or when the deadline passes — clears every insecure host's window and grace and pulls active domain allows back to now (the rows survive unrevoked, so they can be re-armed).

## Pruning stale hosts

`POST /admin/prune-policy` (in the settings routes) sets `inactivity_window_days` (clamped 0–60, default 30; `0` disables it), configurable under *Policies → Host lifecycle*. The routine that would act on it — `HostAuthService.pruneInactiveHosts()` in `host-auth.ts`, which deletes host rows whose `updated_at` is older than the window and publishes `host.pruned` — exists but is not wired to any scheduler or route in this codebase, so the stored policy is not currently enforced automatically.

## Source references

- `api/src/routes/admin/hosts/index.ts` — every `/admin/hosts/*` mutation, insecure approvals
- `api/src/routes/admin/overview/index.ts` — `GET /admin/hosts` (fleet list), `GET /admin/hosts/{id}/detail`, `GET /admin/hosts/insecure`, `POST /admin/hosts/insecure/extend`, `POST /admin/hosts/insecure/disable-all`
- `api/src/services/insecure-fleet-window.ts` — the fleet-wide window: its `versions` key, the stamp, and the close sweep
- `api/src/ops/insecure-fleet-window-worker.ts` — closes the fleet window when its deadline passes
- `api/src/routes/admin/settings/index.ts` — `POST /admin/prune-policy`
- `api/src/services/host-auth.ts` — `authenticate`, IP binding, `pruneInactiveHosts`
- `api/src/services/host-management.ts` — registration, mutations, insecure-window clamps
- `api/src/services/insecure-window-admin.ts` — approval helpers, the 480-minute approval grant, the five-minute pending TTL, the domain sweep
- `api/src/security/route-capabilities.ts` — which capability each host route carries
- `api/src/db/schema.ts` — `hosts`, `insecure_auth_requests`, `insecure_domain_allows`
- `frontend/src/routes/hosts/+page.svelte`, `frontend/src/lib/components/hosts/FilterChips.svelte` — list page, header actions, filter chips
- `frontend/src/routes/hosts/[id]/+page.svelte`, `frontend/src/lib/api/hosts.ts` — detail page controls and their mutations
- `frontend/src/lib/components/hosts/InsecureApprovalsDialog.svelte`, `frontend/src/lib/components/hosts/InsecureApprovalsAutoPopup.svelte`, `frontend/src/lib/stores/insecure-resolutions.ts` — the insecure access dialog, its auto-open/beep/notification behaviour, and the resolved-row shadows
