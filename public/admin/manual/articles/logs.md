---
title: Logs — MCP and Events
section: Admin workspace
verified: 2026-07-01
sources: api/src/db/schema.ts, api/src/services/admin-events.ts, api/src/services/dashboard-stats.ts, api/src/services/mcp-access-log.ts, api/src/services/admin-auth.ts, api/src/services/host-registration.ts, api/src/routes/admin/overview/index.ts, api/src/routes/admin/config/index.ts, api/src/routes/admin/settings/index.ts, api/src/ops/boot-checks.ts, api/src/ws/server.ts, api/src/ws/publisher.ts, frontend/src/lib/api/logs.ts
---

Two log streams live in the admin UI under `/logs/*`. Each has its own tab and its own retention knob. They differ in what writes to them and how often.

## The two streams

- **MCP** — `/logs/mcp`. Every tool call against the MCP server. Backed by `mcp_access_logs`.
- **Events** — `/logs/events`. Host- and settings-scoped admin audit trail (host deletes, insecure approvals, config/quota/theme/retention changes, quick-VM registration, and MCP coordinator tool calls such as `project.*`/`skill.*`/`memory.*`). Backed by the raw `logs` table, read through `GET /admin/logs` — **not** the `admin_events` table, despite the name. See "Two audit tables" below for why that distinction matters.

Open either via the tab bar at the top of the Logs area.

## MCP tab

Calls `GET /admin/mcp/logs?limit=200` and returns `mcp_access_logs` rows as-is.

**Columns:** Timestamp, Host, Tool/Method (tool name with method as a sub-label), Status (OK or Failed, derived from the `success` boolean on the row, with error code and error message where present).

The Host column reads `host_fqdn` off each row, but the `/admin/mcp/logs` handler (`api/src/routes/admin/config/index.ts`) selects straight from `mcp_access_logs` — which only stores `host_id` — with no join to `hosts`. `host_fqdn` is never populated, so this column currently renders as "—" for every row regardless of which host made the call.

**Toolbar controls:**
- Free-text search — matches host, tool name, or method.
- Status filter — All / OK only / Failed only.
- Refresh button.

All filtering is client-side after the initial fetch. The row count is fixed at 200 (`mcpLogsQuery(200)`); unlike the Events tab, there is no row-limit selector here.

**Expandable rows:** clicking a row reveals client IP, method, error message (if any), and a JSON viewer of the call parameters (`params`). Use this when debugging "why did my agent's call fail?" — the error rows carry the full error detail.

## Events tab

Calls `GET /admin/logs?limit=N`. `DashboardStatsService.recentLogs()` (`api/src/services/dashboard-stats.ts`) reads this from the **`logs`** table (columns: `id`, `host_id`, `action`, `details`, `created_at`) — **not** `admin_events`, despite the naming similarity. See "Two audit tables" below.

**Columns:** Timestamp, Host (FQDN, or "System" for rows with no associated host), Action (monospace badge), Details (truncated JSON preview), Copy button (copies the full JSON payload to the clipboard).

**Toolbar controls:**
- Free-text search — matches against action, host, or details.
- Action-prefix input — narrows to rows whose action string starts with the typed prefix.
- Host dropdown — All hosts / System (no host) / individual host entries.
- Time-window dropdown — All time / Last 5 m / Last hour / Last 24 h / Last 7 d.
- Row-limit selector — 50 / 100 / 250 / 500 rows fetched.
- Refresh button.

All filtering is client-side after fetching the selected row limit. Rows are not expandable, but each row has a **Copy** button that copies the complete audit event as JSON to the clipboard.

Action strings actually written to `logs` (and therefore visible here) are mostly host- and settings-scoped, written by local `recordLog()`/`writeLog()` helpers scattered across the services that own each feature:

- `admin.host.*` — one action per host-level toggle: `admin.host.delete`, `admin.host.secure`, `admin.host.vip`, `admin.host.roaming`, `admin.host.insecure_enable`/`insecure_disable`/`insecure_extend`, `admin.host.quick_register`, `admin.host.client_version_override`, `admin.host.claude_client_version_override`, `admin.host.engines`, and others.
- Settings changes: `admin.quota_mode`, `admin.scaling`, `admin.theme`, `admin.log_retention`, `admin.reverse_dns`, `admin.auto_update`, `admin.cdx_silent`, `admin.prune_policy`, `admin.claude_settings`, `admin.codex_version`, `admin.claude_version`, `admin.claude_api.state`, `admin.openai_api.state`, `admin.api.state`.
- Insecure-window approvals: `admin.insecure.approval`, `admin.insecure.denied`, `admin.insecure.domain_allow`, `admin.insecure.domain_revoke`.
- `admin.install_token.create`, `admin.toast`, `host.created`, `host.rotated`.
- MCP coordinator tool calls recorded per host: `project.*`, `skill.*`, `memory.*`, `agents.retrieve`, `config.retrieve`, `claude_settings.retrieve`, `claude_artifact.*`.

If the system is doing something you did not ask it to do to a **host** or a **setting**, the Events stream is where you find the ghost. Logins, logouts, password changes, passkeys, and user CRUD do **not** land here — see the next section.

## Two audit tables

Despite the article title, there are two separate append-only audit tables, and only one of them is visible in the admin UI:

- **`logs`** — read by the Events tab (above).
- **`admin_events`** — written by `AdminEventsService` (`api/src/services/admin-events.ts`) for admin session login/logout (`admin.auth.login`, `admin.auth.logout`), password flows (`admin.auth.password.change`/`.request`/`.reset`), user CRUD (`user.created`, `user.updated`, `user.deleted`, `admin.user.wipe`), passkeys (`passkey.registered`, `passkey.deleted`), and toasts (`toast`). Host registration (`host.created`, `host.rotated`, in `api/src/services/host-registration.ts`) writes to **both** tables.

`admin_events` rows are never listed anywhere in the admin UI today. The table exists to (a) drive the live WebSocket broadcast — `wsPublisher.publish(type, payload)` fires on every insert — and (b) give reconnecting WS clients a resume point via `AdminEventsService.latestEventId()`, surfaced as `last_event_id` on `GET /admin/ws/info`. To audit a login, password change, or user-management action today you need the live WS feed or direct database access; the Events tab will not show it.

## Retention

*Settings → Log retention* stores four independent windows, each clamped to 1–365 days:

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
- api/src/routes/admin/config/index.ts (`/admin/mcp/logs`)
- api/src/routes/admin/settings/index.ts (log retention endpoints)
- api/src/ops/boot-checks.ts (boot-time preflight — no log-retention enforcement present)
- api/src/ws/server.ts, api/src/ws/publisher.ts (live event stream)
- frontend/src/lib/api/logs.ts (query builders for both tabs)
