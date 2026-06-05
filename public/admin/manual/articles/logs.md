---
title: Logs — API, MCP, and Events
section: Admin workspace
verified: 2026-06-05
sources: api/src/db/schema.ts, api/src/services/admin-events.ts, api/src/services/mcp-access-log.ts, api/src/routes/admin/overview/index.ts, api/src/routes/admin/config/index.ts, api/src/routes/admin/settings/index.ts, api/src/ws/server.ts
---

Three log streams live in the admin UI under `/logs/*`. Each has its own tab and its own retention knob. They differ in what writes to them and how often.

## The three streams

- **API** — `/logs/api`. Token-usage ingest records: one row per host request that reports token consumption. Backed by the `token_usage_ingests` table.
- **MCP** — `/logs/mcp`. Every tool call against the MCP server. Backed by `mcp_access_logs`.
- **Events** — `/logs/events`. Administrative audit trail: logins, role changes, config stores, agent reverts, host deletes, insecure approvals. Backed by `admin_events`.

Open any of the three via the tab bar at the top of the Logs area.

## API tab

Calls `GET /admin/usage/ingests` and returns paginated rows from `token_usage_ingests`.

**Columns:** Timestamp, FQDN, Client IP, Input (tokens), Output (tokens), Cached (tokens), Reasoning (tokens).

**Toolbar controls:**
- Free-text search — matches against FQDN, client IP, or row ID.
- Page-size selector — 10 / 25 / 50 / 100 / 250 rows.
- Refresh button.

All columns support server-side sort; previous/next pagination controls appear below the table. Rows are not expandable. There is no action filter and no time-window filter on this tab.

## MCP tab

Calls `GET /admin/mcp/logs?limit=200` and returns `mcp_access_logs` rows.

**Columns:** Timestamp, Host (FQDN), Tool/Method (tool name with method as a sub-label), Status (OK or Failed, derived from the `success` boolean on the row, with error code and error message where present).

**Toolbar controls:**
- Free-text search — matches host or tool name.
- Status filter — All / OK only / Failed only.
- Refresh button.

All filtering is client-side after the initial fetch.

**Expandable rows:** clicking a row reveals client IP, method, error message (if any), and a JSON viewer of the call parameters (`params`). Use this when debugging "why did my agent's call fail?" — the error rows carry the full error detail.

## Events tab

Calls `GET /admin/logs?limit=N` and returns `admin_events` rows.

**Columns:** Timestamp, Host (FQDN, or "System" for rows with no associated host), Action (monospace badge), Details (truncated JSON preview), Copy button (copies the full JSON payload to the clipboard).

**Toolbar controls:**
- Free-text search — matches against action, host, or details.
- Action-prefix input — narrows to rows whose action string starts with the typed prefix.
- Host dropdown — All hosts / System (no host) / individual host entries.
- Time-window dropdown — All time / Last 5 m / Last hour / Last 24 h / Last 7 d.
- Row-limit selector — 50 / 100 / 250 / 500 rows fetched.
- Refresh button.

All filtering is client-side after fetching the selected row limit. Rows are not expandable, but each row has a **Copy** button that copies the complete audit event as JSON to the clipboard.

Common action strings you will see:

- `admin.auth.login`, `admin.auth.logout`, `admin.auth.password.change`
- `admin.user.create`, `admin.user.update`, `admin.user.delete`, `admin.user.wipe`
- `admin.agents.store`, `admin.agents.serve`, `admin.agents.revert`
- `admin.skill.store`, `admin.skill.delete`
- `admin.host.register`, `admin.host.delete`, `admin.host.roaming.toggle`
- `admin.insecure.approve`, `admin.insecure.deny`, `admin.insecure.disable_all`
- `admin.runner.probe`
- `admin.quota_mode`

If the system is doing something you did not ask it to do, the Events stream is where you find the ghost.

## Retention

Logs do not live forever. *Settings → General → Log retention*:

- `GET /admin/log-retention` — current windows in days.
- `POST /admin/log-retention` — update them.

The enforcement deletes rows older than the configured retention, scheduled periodically by the boot-time preflight (see `api/src/ops/`).

## Live streaming

When `ADMIN_WS_ENABLED=true`, the admin UI opens a WebSocket to `/admin/ws` (URL discovered via `GET /admin/ws/info`). The WebSocket runs in-process inside the Node API (`api/src/ws/server.ts`); there is no separate daemon. Services publish events through `wsPublisher.publish(type, payload)` (`api/src/ws/publisher.ts`) and the WS handler fans them out to every connected admin. On close or error the SPA falls back to the existing timed refresh.

## Source references

- api/src/db/schema.ts (token_usage_ingests, admin_events, mcp_access_logs tables)
- api/src/services/admin-events.ts (event recording helper)
- api/src/services/mcp-access-log.ts (MCP access log writes)
- api/src/routes/admin/overview/index.ts (/admin/logs)
- api/src/routes/admin/usage/index.ts (/admin/usage/ingests)
- api/src/routes/admin/config/index.ts (/admin/mcp/logs)
- api/src/routes/admin/settings/index.ts (log retention endpoints)
- api/src/ws/server.ts, api/src/ws/publisher.ts (live event stream)
