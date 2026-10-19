---
title: Hosts — secure, insecure, unprovisioned
section: Fleet operations
verified: 2026-10-19
sources: api/src/routes/admin/hosts/index.ts, api/src/routes/admin/overview/index.ts, api/src/routes/admin/settings/index.ts, api/src/services/host-management.ts, api/src/services/host-auth.ts, api/src/services/insecure-window.ts, api/src/services/insecure-window-admin.ts, api/src/services/insecure-fleet-window.ts, api/src/ops/insecure-fleet-window-worker.ts, api/src/security/route-capabilities.ts, api/src/db/schema.ts, frontend/src/routes/hosts/+page.svelte, frontend/src/routes/hosts/[id]/+page.svelte, frontend/src/lib/components/hosts/HostsFilters.svelte, frontend/src/lib/components/hosts/hostsListState.svelte.ts, frontend/src/lib/components/hosts/HostsActions.svelte, frontend/src/lib/components/hosts/detail/HostAttention.svelte, frontend/src/lib/components/hosts/hostAttention.ts, frontend/src/lib/components/hosts/InsecureApprovalsDialog.svelte, frontend/src/lib/components/hosts/InsecureApprovalsAutoPopup.svelte, frontend/src/lib/stores/insecure-resolutions.ts, frontend/src/lib/api/hosts.ts
---

# Hosts — secure, insecure, unprovisioned

A *host* is any machine running `cdx`, `clx`, or `cgx` (see [Grok Build](cgx)) under your orchestrator. The Hosts page at `/hosts` shows the full fleet and provides a status filter plus attribute filters to narrow the view. Detail pages live at `/hosts/[id]`. The list and detail JSON are served by `api/src/routes/admin/overview/index.ts` (`GET /admin/hosts`, `GET /admin/hosts/{id}/detail`); host mutations (register, toggles, overrides, insecure windows, approvals) are handled by `api/src/routes/admin/hosts/index.ts`.

## The filter chips

The host list is narrowed by a segmented status filter and a **More filters** menu — no separate backend queries back them. All filtering runs client-side over a single result set from `GET /admin/hosts` (the dedicated fleet-listing endpoint; `GET /admin/overview` is a separate endpoint that feeds the Overview page, not this list). The status filter shows a count on each segment:

- **All hosts** — the full fleet, unfiltered.
- **Online** — hosts whose computed status is "online" (see *Online status* below).
- **Offline** — hosts whose computed status is "offline".
- **Needs attention** — hosts with at least one warning in their *Needs attention* list (see *Host detail page* below).

The **More filters** menu holds attribute filters that can be combined with each other and with the status filter (a host must match every ticked one); the menu shows how many are active:

- **Priority hosts** (`vip`) — hosts with the VIP flag set (bypass quota).
- **Allows IP changes** (`roaming`) — hosts with IP re-binding enabled.
- **Trusted hosts** (`secure`) — hosts where `secure = true`.
- **Untrusted hosts** (`insecure`) — hosts where `secure = false`.
- **Not signed in yet** (`unprovisioned`) — hosts missing the required canonical auth digest for their configured engine(s) (`hostHasRequiredAuth()` returns false). Usually a host that registered but never completed its first sync — but a host whose auth was cleared also lands here until it re-syncs.

A debounced search box (**Search hosts**; it matches hostname, host id, IP address, Codex/Claude/Grok version including overrides, and status) sits above the table. The table columns are **Name**, **Status**, **Needs attention**, **Engines**, and **Last contact**; Name, Needs attention, and Last contact sort. Filtering is entirely client-side, and the status, attribute, search, and sort choices are kept in the URL.

> Note: `GET /admin/hosts/insecure` is a separate endpoint used exclusively by the temporary-access (insecure access) approvals panel — it is not the backing query for the Untrusted hosts filter.

## Header buttons

The host list page header carries:

- **Add host** — the primary button; opens the *New host* slide-in sheet for full registration (also bound to the `n` shortcut and to `?add=1`). The installer command is copied automatically after registration. The old `/hosts/new` URL redirects to `/hosts?add=1`.
- **▾** next to Add host — a menu with **Add host** and **Quick VM**, which opens the *Quick VM* dialog for a minimal-input registration. The installer command is copied automatically after provisioning.
- **More** — a menu with **Seed canonical auth** (the shared `SeedAuthPanel`; the one-time command is copied automatically when generated) and **Review temporary access** (the insecure access dialog described under *The insecure approval queue* below, reachable whether or not a request is waiting). The dialog also opens automatically when the URL contains `?insecure=1` and when a new request arrives over the live feed, and a host with a waiting request shows a **Review** button in its Needs attention cell.

The old header **Insecure access** badge button is gone; open windows show as a countdown next to a host's status instead. There are no chord keyboard shortcuts for host navigation. Keyboard access is through the Cmd-K command palette and single-key shortcuts (`?`, `/`, `n`, Escape) only.

## Registering a host

`POST /admin/hosts/register` creates the host row and returns an install token. It carries the `hosts.security_transition` capability — owner and admin only — because reusing an FQDN rotates the host key and generation-fences live Agent Messaging work. `POST /admin/hosts/quick-register` is the abbreviated form used by *Quick VM* and needs only `hosts.manage`, which a `fleet_operator` also holds.

Full registration inputs (`POST /admin/hosts/register`):

- `fqdn` — the canonical hostname to assign.
- `secure` — `true` for a normal host; `false` to open it insecure-by-default with a grace window.
- `vip` — mark host as VIP (priority host) on creation.
- `temporary` — flag the host as temporary.
- `curl_insecure` — enable curl-insecure probe (Skip TLS check) on creation.
- `reverse_dns_mode` — initial reverse-DNS mode.
- `engines` — array of `codex` / `claude` / `grok` the host will run; any nonempty combination is accepted. Defaults come from `DEFAULT_HOST_ENGINES`.
- `duration_minutes` — if insecure on registration, the length of the grace window in minutes (clamped to MIN=0 / MAX=480).

In the *New host* sheet these appear as **Hostname (FQDN)**, an **Options** group (**Trusted**, **Skip TLS verification**, **Temporary**, **VIP**, **Persistent daemon**), and an **Engines** group (Codex, Claude, Grok).

Quick registration inputs (`POST /admin/hosts/quick-register`): `engines` and `duration_minutes` only.

Both responses contain an install URL. Until the host completes its first sync it appears under the *Not signed in yet* filter (More filters).

## Online status

Online means connected now: the API requires a communicator connection or an agent heartbeat less than **45 seconds** old. The browser ages that evidence between refreshes, including when it loses its connection to the API. A daily cron run, an administrative setting change or a provider token refresh does not make a host online.

**Last contact** is the last successful authenticated request from the host. It can be recent even when no communicator or agent is currently connected. Missing provider credentials are shown separately under **Needs attention** and **Not signed in yet**.

## Host detail page

Visiting `/hosts/[id]` (click a row) loads the detail view. Page data is fetched from `GET /admin/hosts/{id}/detail`. A separate `GET /admin/hosts/{id}/auth` endpoint also exists (`engine` and `include_body` query params) for pulling a host's canonical digest/auth view directly, but the detail page itself does not call it.

### Header and status

The page title is the hostname with `Host #id` below it. The header's primary action is **Get install command** (previously *Mint installer*): it generates a one-time installer via `POST /admin/hosts/{id}/installer` and shows the URL and command with copy buttons; **Create a new one** replaces it. The current **Skip TLS check** (`curl_insecure`) value is included so the copied command reflects the visible setting. Under the title a status pill shows the connection state (Online / Offline, see *Online status*) next to **Last contact**, from `last_contact_at`, the latest successful authenticated host request.

### Needs attention block

The first block on the page lists what is wrong with this host, each item with an inline button (warnings first; informational items follow). Items are derived client-side from fields already in the host payload. Only what stops the host from working is a warning:

- an access request is waiting (**Review** opens the temporary access dialog);
- no credentials received yet (**Fix** gets a fresh install command);
- informational, not counted: credentials older than the fleet's, some engines without credentials yet, a CLI or host agent (`cxx`) that is not at the target version or differs between engines (all of these repair themselves at the host's next run, so a stale host is not shown as a problem), temporary access is open (**Close** ends the window now), and an engine switched off fleet-wide (**Open Engines**).

With nothing to report it reads "Nothing needs attention." Only the warnings feed the *Needs attention* column and status filter of the host list.

### Engines, access, and advanced controls

Below that, two sections sit side by side.

**Engines** has an on/off switch per engine (Codex, Claude, Grok) with its installed version and any pin as a note (`POST /admin/hosts/{id}/engines`). A switch is disabled when it is the host's only remaining engine. An engine switched off fleet-wide (**Engines → Engine master switches**) cannot be added to a host — here, in the new-host form or Quick VM — and the server refuses it with `409 engine_disabled`; a host that already carries it keeps it, badged as disabled fleet-wide, and its wrapper refuses to launch that engine until it is switched back on. Changes apply on the host's next `cdx` / `clx` / `cgx` run or scheduled maintenance tick.

**Access** has the **Trusted host** switch (`secure`: a trusted host may fetch credentials at any time; an untrusted one only while temporary access is open). For an untrusted host or while a window is open, a **Temporary access** row (the insecure window) shows whether it is open or closed, with a countdown, **Extend** and **Close now** while open, or **Open temporary access** otherwise (each asks for a duration).

**Advanced** is collapsed by default and opens by itself when the host carries per-host exceptions. It contains:

- **Network and IP** — **Allow IP changes** (roaming), **Skip TLS check** (curl insecure), **Reverse DNS lookup** (a tri-state control: Fleet default / Always / Never), and **Release IP binding**, which clears both `ip4` and `ip6` (`POST /admin/hosts/{id}/release-ip-binding`) so the next successful auth re-binds; it is a clearing action, not an editable address field.
- **Per-host exceptions** (host overrides) — per-engine **Version**, **Model**, and **Reasoning effort** overrides (Claude has Version and Model), and an **Agent rules document** pin by id (empty follows the fleet default).
- **Fleet behaviour and integrations** — **Priority host** (VIP: usage limits only warn), **Always allowed (ignores usage limits)** (scaling exempt), **Update automatically** (auto-update), **Try new host-agent versions early** (the `cxx` rollout canary), and **BrowserOS MCP**.
- **Remote sessions** and **Connection** (the CoCo communicator) panels.

Below Advanced, **Delete host** removes the host via `DELETE /admin/hosts/{id}` after a confirmation.

Every mutation names a capability. Deleting a host, toggling its engines, and flipping **Trusted host** (`secure`) are `hosts.security_transition` (owner/admin); the temporary-access buttons are `hosts.activate_insecure` (owner, admin, fleet operator, trusted user); everything else on this page is `hosts.manage` (owner, admin, fleet operator). Controls a role does not hold are disabled with a tooltip naming the missing capability.

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
| Set per-host model (including `grok_model_override` / `grok_reasoning_effort_override`) | `POST /admin/hosts/{id}/model` |
| Pin Codex version | `POST /admin/hosts/{id}/codex-version` |
| Pin Claude version | `POST /admin/hosts/{id}/claude-version` |
| Pin Grok version | `POST /admin/hosts/{id}/grok-version` |
| Pin AGENTS.md version | `POST /admin/hosts/{id}/agents-version` |
| Set reverse-DNS mode | `POST /admin/hosts/{id}/reverse-dns` |
| Toggle engine (codex/claude/grok) | `POST /admin/hosts/{id}/engines` |
| Toggle BrowserOS MCP | `POST /admin/hosts/{id}/browseros-mcp` |
| Toggle curl-insecure probe | `POST /admin/hosts/{id}/curl-insecure` |
| Mint installer (Get install command) | `POST /admin/hosts/{id}/installer` |

## The insecure approval queue

When an insecure host is outside its grace window and tries to pull auth, `host-auth.ts` withholds the payload and creates a row in `insecure_auth_requests`, recording the caller's IP. An interactive `cdx`/`clx` then parks on its approval box and re-polls every five seconds; each poll is a heartbeat that stamps the row's `updated_at`. The queue is visible in the temporary access dialog (`InsecureApprovalsDialog`; it is titled *Access requests* or names the asking host in the request view, and *Insecure access* in the full view), opened from *More → Review temporary access* on the host list, from a host's **Review** button, from the amber alert at the top of the left-hand navigation (shown on every page while approvals are pending), from the Overview page's Needs attention list, or automatically. `InsecureApprovalsAutoPopup` opens it on its own only for requests someone is waiting on (`live`: the host polled again after asking), so a one-shot headless call never pops it; it then plays a short synthesized beep (880 Hz, at most once per two seconds; browser autoplay rules still apply) and — if you enabled browser notifications from the link inside the dialog — fires a desktop notification so a background tab still hears the request. The pending list itself is `GET /admin/insecure-approvals/pending`, polled every 10 seconds while anything is pending (30 seconds otherwise), also in a background tab, re-fetched on focus and on every insecure WebSocket event.

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

`POST /admin/prune-policy` sets `inactivity_window_days` (0–60, default 30) under *Settings → Hosts → Host lifecycle* (`/settings#hosts`). Successful host requests, registration and admin host listing enforce cleanup. `0` disables inactivity cleanup only: expired temporary hosts and records never provisioned after 30 minutes without activity still expire. Valid authenticated contacts renew temporary hosts for two hours; expired credentials cannot renew themselves. Cleanup rechecks each host under its row lock, revokes its installer tokens, removes host metadata and emits `host.pruned`. Canonical provider accounts remain intact.

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
- `frontend/src/routes/hosts/+page.svelte`, `frontend/src/lib/components/hosts/HostsFilters.svelte`, `frontend/src/lib/components/hosts/HostsActions.svelte`, `frontend/src/lib/components/hosts/hostsListState.svelte.ts` — list page, header actions, status and attribute filters
- `frontend/src/routes/hosts/[id]/+page.svelte`, `frontend/src/lib/components/hosts/detail/HostAttention.svelte`, `frontend/src/lib/components/hosts/hostAttention.ts`, `frontend/src/lib/api/hosts.ts` — detail page controls, the Needs attention block, and their mutations
- `frontend/src/lib/components/hosts/InsecureApprovalsDialog.svelte`, `frontend/src/lib/components/hosts/InsecureApprovalsAutoPopup.svelte`, `frontend/src/lib/stores/insecure-resolutions.ts` — the insecure access dialog, its auto-open/beep/notification behaviour, and the resolved-row shadows
