---
title: Hosts — secure, insecure, unprovisioned
section: Fleet operations
verified: 2026-07-01
sources: api/src/routes/admin/hosts/index.ts, api/src/routes/admin/overview/index.ts, api/src/routes/admin/settings/index.ts, api/src/services/host-management.ts, api/src/services/host-auth.ts, api/src/services/insecure-window.ts, api/src/services/insecure-window-admin.ts, api/src/db/schema.ts
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

The host list page header contains four action buttons:

- **Insecure** — opens the insecure approvals panel. An amber badge shows the count of active insecure windows when any are open. The panel also opens automatically when the URL contains `?insecure=1`.
- **Seed auth** — opens the *Seed Auth* dialog to pre-seed credentials across the fleet.
- **Quick VM** — opens the *Quick VM* dialog for a minimal-input registration.
- **New host** — opens the *New Host* slide-in sheet for full registration.

There are no chord keyboard shortcuts for host navigation. Keyboard access is through the Cmd-K command palette and single-key shortcuts (`?`, `/`, Escape) only.

## Registering a host

`POST /admin/hosts/register` creates the host row and returns an install token. `POST /admin/hosts/quick-register` is the abbreviated form used by *Quick VM*. Both are gated by `app.requireAdmin`.

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

Host ID, FQDN, IPv4/IPv6, Codex version (override or reported), Claude version, Wrapper (Codex) version, Wrapper (Claude) version, Model override, Reasoning override, Claude model override, Binary digest, VIP, Auto-update, Insecure state, Roaming, Lane preference, Reverse DNS (inline tri-state segmented control: Inherit / Force on / Force off), Agents doc override.

### Controls card

Toggle switches: **Secure**, **Auto-update**, **VIP**, **Roaming**, **Scaling exempt**, **Curl insecure**, **BrowserOS MCP**, and per-engine **Codex**/**Claude** switches (each disabled when it's the host's only remaining engine, via `POST /admin/hosts/{id}/engines`).

Buttons depend on host state:

- **Extend insecure window** / **Close insecure window** (shown when a window is active) or **Open insecure window** (shown when host is insecure and no window is active).
- **Codex version** and **Codex model override** (when the Codex engine is configured) or **Add Codex** (when it is not).
- **Claude version** and **Claude model override** (when the Claude engine is configured) or **Add Claude** (when it is not).
- **Agents version** — pin the AGENTS.md version.
- **Mint installer** — generates a new installer via `POST /admin/hosts/{id}/installer`.
- **Seed auth** — opens the Seed Auth dialog scoped to this host.
- **Clear auth** — clears baked auth via `POST /admin/hosts/{id}/clear`.
- **Delete host** — removes the host via `DELETE /admin/hosts/{id}`.

All mutations require an authenticated admin session.

### Full mutations reference

| Action | Endpoint |
|--------|----------|
| Delete host | `DELETE /admin/hosts/{id}` |
| Clear baked auth | `POST /admin/hosts/{id}/clear` |
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

When an insecure host is outside its grace window and tries to pull auth, `host-auth.ts` withholds the payload and creates a row in `insecure_auth_requests`. The queue is visible in the approvals panel (opened via the **Insecure** button in the host list header).

Review endpoints:

- `GET /admin/insecure-approvals/pending` — list pending approvals.
- `POST /admin/insecure-approvals/{id}/approve` — approve and release auth.
- `POST /admin/insecure-approvals/{id}/deny` — deny and log.
- `POST /admin/insecure-approvals/{id}/allow-domain` — add the requester's domain to the trusted list.
- `POST /admin/insecure-domain-allows/{id}/revoke` — reverse a previous domain allow.
- `POST /admin/hosts/insecure/extend` — re-extend the active window for every currently-open insecure host by its stored `insecure_window_minutes` (falls back to 60 if unset, clamped to 5–1440).
- `POST /admin/hosts/insecure/disable-all` — close every insecure window at once.

## Pruning stale hosts

`POST /admin/prune-policy` (in the settings routes) sets `inactivity_window_days` (clamped 0–60, default 30; `0` disables it), configurable in *Settings → General*. The routine that would act on it — `HostAuthService.pruneInactiveHosts()` in `host-auth.ts`, which deletes host rows whose `updated_at` is older than the window and publishes `host.pruned` — exists but is not wired to any scheduler or route in this codebase, so the stored policy is not currently enforced automatically.

## Source references

- `api/src/routes/admin/hosts/index.ts` — every `/admin/hosts/*` mutation, insecure approvals
- `api/src/routes/admin/overview/index.ts` — `GET /admin/hosts` (fleet list), `GET /admin/hosts/{id}/detail`, `GET /admin/hosts/insecure`, `POST /admin/hosts/insecure/{extend,disable-all}`
- `api/src/routes/admin/settings/index.ts` — `POST /admin/prune-policy`
- `api/src/services/host-auth.ts` — `authenticate`, IP binding, `pruneInactiveHosts`
- `api/src/services/host-management.ts` — registration, mutations, insecure-window clamps
- `api/src/services/insecure-window-admin.ts` — approval helpers
- `api/src/db/schema.ts` — `hosts`, `insecure_auth_requests`, `insecure_domain_allows`
