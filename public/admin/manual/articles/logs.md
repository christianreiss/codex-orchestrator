---
title: Activity — admin changes and tool calls
section: Admin workspace
verified: 2026-10-17
sources: api/src/db/schema.ts, api/src/services/admin-events.ts, api/src/services/dashboard-stats.ts, api/src/services/mcp-access-log.ts, api/src/services/admin-auth.ts, api/src/services/host-registration.ts, api/src/routes/admin/overview/index.ts, api/src/routes/admin/config/index.ts, api/src/routes/admin/settings/index.ts, api/src/ops/boot-checks.ts, api/src/ws/server.ts, api/src/ws/publisher.ts, frontend/src/lib/api/logs.ts, frontend/src/routes/(activity)/activity/+page.svelte, frontend/src/lib/components/logs/ChangesPanel.svelte, frontend/src/lib/components/logs/ToolCallsPanel.svelte
---

Two log streams live in the admin UI on the **Activity** page (`/activity`, in the Operate group; the old `/logs/events` and `/logs/mcp` URLs redirect to it). A type filter switches between them: **Admin changes** (`/activity?type=changes`) and **Tool calls** (`/activity?type=tools`). Each has its own retention window (see *Retention* below). They differ in what writes to them and how often.

## The two streams

- **MCP** (shown as **Tool calls**). Every tool call against the MCP server. Backed by `mcp_access_logs`.
- **Events** (shown as **Admin changes**). Host- and settings-scoped admin audit trail (host deletes, insecure approvals, config/quota/theme/retention changes, quick-VM registration, and MCP coordinator tool calls such as `project.*`/`skill.*`/`memory.*`). Backed by the raw `logs` table, read through `GET /admin/logs` — **not** the `admin_events` table, despite the name. See "Two audit tables" below for why that distinction matters.

Switch between them with the **Activity type** control at the top of the page. **Refresh** in the header reloads both. Both feeds show 50 rows per page.

## Tool calls (MCP)

Calls `GET /admin/mcp/logs?limit=200` and returns `mcp_access_logs` rows as-is.

**Columns:** When, Host, Tool (tool name with method as a sub-label), Result (OK or Failed, derived from the `success` boolean on the row, with error code and error message where present).

The Host column reads `host_fqdn` off each row. The `/admin/mcp/logs` handler (`api/src/routes/admin/config/index.ts`) left-joins `mcp_access_logs.host_id` to `hosts` to fill it, so a row whose host has since been pruned — or a call that was never bound to a host — renders "—" while every other row shows the FQDN.

**Toolbar controls:**
- Free-text search (*Search tool calls*) — matches host, tool name, or method.
- Host filter — All hosts or one host.
- Tool filter — All tools or one tool name, with a count each.
- Result filter — Any result / Succeeded / Failed only.
- Time window — All time / Last 5 minutes / Last hour / Last 24 hours / Last 7 days.
- **Clear filters** while any filter is active.

All filtering is client-side after the initial fetch. The fetch is fixed at 200 rows (`mcpLogsQuery(200)`), shown as "N of 200 recent calls" and paged 50 at a time.

**Expandable rows:** clicking a row reveals client IP, method, error message (if any), and a JSON viewer of the call parameters (`params`). Use this when debugging "why did my agent's call fail?" — the error rows carry the full error detail.

## Admin changes (Events)

Calls `GET /admin/logs?limit=500`. `DashboardStatsService.recentLogs()` (`api/src/services/dashboard-stats.ts`) reads this from the **`logs`** table (columns: `id`, `host_id`, `action`, `details`, `created_at`, `engine`) — **not** `admin_events`, despite the naming similarity. See "Two audit tables" below.

**Columns:** When, Host (FQDN, or "System" for rows with no associated host), Action (monospace badge), Details (truncated JSON preview).

**Toolbar controls:**
- Free-text search (*Search changes*) — matches against action, host, or details.
- Host filter — All hosts / System (no host) / individual hosts.
- Action filter — All actions or one action prefix, with a count each.
- Time window — All time / Last 5 minutes / Last hour / Last 24 hours / Last 7 days.
- **Clear filters** while any filter is active.

All filtering is client-side after fetching the latest 500 rows, shown as "N of 500 recent changes" and paged 50 at a time. Clicking a row expands it to the complete audit event as JSON, with a **Copy JSON** button that copies the payload to the clipboard.

Action strings actually written to `logs` (and therefore visible here) are mostly host- and settings-scoped, written by local `recordLog()`/`writeLog()` helpers scattered across the services that own each feature:

- `admin.host.*` — one action per host-level toggle: `admin.host.delete`, `admin.host.secure`, `admin.host.vip`, `admin.host.roaming`, `admin.host.insecure_enable`/`insecure_disable`/`insecure_extend`, `admin.host.quick_register`, `admin.host.client_version_override`, `admin.host.claude_client_version_override`, `admin.host.engines`, and others.
- Settings changes: `admin.quota_mode`, `admin.scaling`, `admin.theme`, `admin.log_retention`, `admin.reverse_dns`, `admin.auto_update`, `admin.cdx_silent`, `admin.prune_policy`, `admin.claude_settings`, `admin.codex_version`, `admin.claude_version`, `admin.claude_api.state`, `admin.openai_api.state`, `admin.api.state`, `admin.grok_api.state`, `admin.grok_settings`, `admin.grok_version`.
- Grok gateway and auth: `grok.key.create`, `grok.key.toggle`, `grok.key.delete`, `grok.model.toggle`, and the server-owned refresh trail `grok.auth.refresh.started`, `grok.auth.refresh.candidate`, `grok.auth.refresh.accepted`, `grok.auth.refresh.transient`, `grok.auth.refresh.uncertain`, `grok.auth.refresh.failed` (see [Grok Build](cgx)). These rows, plus `admin.grok_api.state` and `admin.grok_settings`, carry `engine = grok`; `admin.grok_version` does not set the column.
- Insecure-window approvals: `admin.insecure.approval`, `admin.insecure.denied`, `admin.insecure.domain_allow`, `admin.insecure.domain_revoke`.
- `admin.install_token.create`, `admin.toast`, `host.created`, `host.rotated`.
- MCP coordinator tool calls recorded per host: `project.*`, `skill.*`, `memory.*`, `agents.retrieve`, `config.retrieve`, `claude_settings.retrieve`, `claude_artifact.*`.

If the system is doing something you did not ask it to do to a **host** or a **setting**, the Admin changes feed is where you find the ghost. Logins, logouts, password changes, passkeys, and user CRUD do **not** land here — see the next section.

## Two audit tables

Despite the article title, there are two separate append-only audit tables, and only one of them is visible in the admin UI:

- **`logs`** — read by the Admin changes feed (above).
- **`admin_events`** — written by `AdminEventsService` (`api/src/services/admin-events.ts`) for admin session login/logout (`admin.auth.login`, `admin.auth.logout`), password flows (`admin.auth.password.change`/`.request`/`.reset`), user CRUD (`user.created`, `user.updated`, `user.deleted`, `admin.user.wipe`), passkeys (`passkey.registered`, `passkey.deleted`), and toasts (`toast`). Host registration (`host.created`, `host.rotated`, in `api/src/services/host-registration.ts`) writes to **both** tables.

`admin_events` rows are never listed anywhere in the admin UI today. The table exists to (a) drive the live WebSocket broadcast — `wsPublisher.publish(type, payload)` fires on every insert — and (b) give reconnecting WS clients a resume point via `AdminEventsService.latestEventId()`, surfaced as `last_event_id` on `GET /admin/ws/info`. To audit a login, password change, or user-management action today you need the live WS feed or direct database access; the Admin changes feed will not show it.

## Retention

*Settings → Data retention → Remove old logs automatically* (`/settings#retention`) stores four independent windows, each clamped to 1–365 days:

- `GET /admin/log-retention` — returns `enabled`, `days_logs` (default 90), `days_mcp` (default 90), `days_events` (default 30), `days_graph_stats` (default 180).
- `POST /admin/log-retention` — updates them; records `admin.log_retention` to the `logs` table.

These windows are configuration only today. Nothing in this repository — not the boot-time preflight (`api/src/ops/boot-checks.ts`, which only refreshes runner health and wrapper versions), not a scheduled job, nothing else — deletes rows from `logs`, `mcp_access_logs`, `admin_events`, or `dashboard_graph_quota_snapshots` based on these settings. Enabling `log_retention_enabled` and tightening the windows does not currently prune anything, despite what the Settings page copy implies — treat this as a reserved/unenforced setting until an enforcement job ships.

## Live streaming

When `ADMIN_WS_ENABLED=true`, the admin UI opens a WebSocket to `/admin/ws` (URL discovered via `GET /admin/ws/info`). The WebSocket runs in-process inside the Node API (`api/src/ws/server.ts`); there is no separate daemon. Services publish events through `wsPublisher.publish(type, payload)` (`api/src/ws/publisher.ts`) and the WS handler fans them out to every connected admin. On close or error the SPA falls back to the existing timed refresh. Note that WS event `type` strings (e.g. `host.updated`, `settings.changed`, `mcp.invoked`, `chatgpt.usage.updated`) are their own namespace — they don't map one-to-one onto either `logs.action` or `admin_events.type`.

## Source references

- api/src/db/schema.ts (`logs`, `admin_events`, `mcp_access_logs` tables)
- api/src/services/dashboard-stats.ts (`recentLogs()` — backs `GET /admin/logs`)
- api/src/services/admin-events.ts (`admin_events` writer, WS broadcast, `latestEventId()`)
- api/src/services/mcp-access-log.ts (MCP access log writes)
- api/src/services/admin-auth.ts (login/logout events into `admin_events`)
- api/src/services/host-registration.ts (dual-writes `logs` + `admin_events` on host create/rotate)
- api/src/routes/admin/overview/index.ts (`/admin/logs`, `/admin/ws/info`)
- api/src/routes/admin/config/index.ts (`/admin/mcp/logs`, left-joined to `hosts` for `host_fqdn`)
- api/src/routes/admin/settings/index.ts (log retention endpoints, `admin.grok_version`)
- api/src/routes/admin/grok/index.ts (`grok.key.*`, `grok.model.toggle`, `admin.grok_api.state`, `admin.grok_settings`)
- api/src/services/grok-auth-owner.ts, api/src/services/canonical-auth-store.ts (`grok.auth.refresh.*`)
- api/src/ops/boot-checks.ts (boot-time preflight — no log-retention enforcement present)
- api/src/ws/server.ts, api/src/ws/publisher.ts (live event stream)
- frontend/src/lib/api/logs.ts (query builders for both feeds)
- frontend/src/routes/(activity)/activity/+page.svelte (the Activity page and its type filter)
- frontend/src/lib/components/logs/ChangesPanel.svelte, frontend/src/lib/components/logs/ToolCallsPanel.svelte (the two feeds, their filters and expandable rows)
