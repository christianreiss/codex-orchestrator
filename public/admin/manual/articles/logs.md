---
title: Logs — API, MCP, and Events
section: Admin workspace
verified: 2026-05-20
sources: api/src/db/schema.ts, api/src/services/admin-events.ts, api/src/services/mcp-access-log.ts, api/src/routes/admin/overview/index.ts, api/src/routes/admin/config/index.ts, api/src/routes/admin/settings/index.ts, api/src/ws/server.ts
---

Three log streams live in the admin UI. Each has its own rail shortcut and its own retention knob. They differ in what writes to them and how often.

## The three streams

- **API Logs** — `/admin/logs` (shortcut `[l][c]`). Every host-facing API interaction: `/auth`, `/sync/status`, `/sync/bootstrap`, `/usage`, the `/v1/*` and `/anthropic/v1/*` API-compat calls. Written to the `logs` table with a small set of canonical `action` strings.
- **MCP Logs** — `/admin/mcp/logs` (shortcut `[l][m]`). Every tool call and resource read against the MCP server. Written to `mcp_access_logs` by `mcp-access-log.ts` from inside `mcp-server.ts`.
- **Events** — surfaced at `/admin/logs/events` (shortcut `[l][e]`). Administrative audit trail: logins, role changes, config stores, agents reverts, host deletes, insecure approvals. Written to `admin_events` by `admin-events.ts` (helper `AdminEventsService.record`).

Open any of the three via the rail; the SPA calls the stream-specific endpoint and renders a paged list with filters.

## API log endpoint

`GET /admin/logs` (in `api/src/routes/admin/overview/index.ts`) returns recent rows from the `logs` table. Filters understood by the SPA:

- action (text contains match against the canonical action string)
- host id
- time window

Common action strings you will see:

- `auth.retrieve`, `auth.refuse`, `auth.runner.verify_failed`
- `sync.status`, `sync.bootstrap`
- `usage.ingest`
- `install.token.consumed`
- `host.register`, `host.delete`, `host.rotate_key`

## MCP log endpoint

`GET /admin/mcp/logs` (in `api/src/routes/admin/config/index.ts`) returns `mcp_access_logs` rows. Each entry has a timestamp, host, capability (`host` vs `operator`), tool name (or resource URI), and the outcome (ok / error / denied). Use this when debugging "why did my agent's call fail?" — the error rows carry the JSON-RPC error body.

## Events endpoint

Events come from `admin_events`. The SPA calls into the same `/admin/logs` family but with a type filter (or a dedicated events query, depending on the panel). Events you will see:

- `admin.auth.login`, `admin.auth.logout`, `admin.auth.password.change`
- `admin.user.create`, `admin.user.update`, `admin.user.delete`, `admin.user.wipe`
- `admin.agents.store`, `admin.agents.serve`, `admin.agents.revert`
- `admin.skill.store`, `admin.skill.delete`
- `admin.host.register`, `admin.host.delete`, `admin.host.roaming.toggle`
- `admin.insecure.approve`, `admin.insecure.deny`, `admin.insecure.disable_all`
- `admin.runner.probe`
- `admin.quota_mode`

If the system is doing something you did not ask it to do, the events stream is where you find the ghost.

## Retention

Logs do not live forever. *Settings → General → Log retention*:

- `GET /admin/log-retention` — current windows in days.
- `POST /admin/log-retention` — update them.

The enforcement deletes rows older than the configured retention, scheduled periodically by the boot-time preflight (see `api/src/ops/`).

## Live streaming

When `ADMIN_WS_ENABLED=true`, the admin UI opens a WebSocket to `/admin/ws` (URL discovered via `GET /admin/ws/info`). The websocket runs in-process inside the Node API (`api/src/ws/server.ts`); there is no separate daemon. Services publish events through `wsPublisher.publish(type, payload)` (`api/src/ws/publisher.ts`) and the WS handler fans them out to every connected admin. On close / error the SPA falls back to the existing timed refresh.

## What to do when a log line is unclear

`logs` rows carry a `details` JSON column at write time. Expand the row to see it — that is where host IPs, refusal reasons, and runner error codes live. If the details are empty, check the row at the same timestamp on the *Events* stream; the admin-side of a request and the host-side often show up as a pair.

## Source references

- api/src/db/schema.ts (logs, admin_events, mcp_access_logs tables)
- api/src/services/admin-events.ts (event recording helper)
- api/src/services/mcp-access-log.ts (MCP access log writes)
- api/src/routes/admin/overview/index.ts (/admin/logs)
- api/src/routes/admin/config/index.ts (/admin/mcp/logs)
- api/src/routes/admin/settings/index.ts (log retention endpoints)
- api/src/ws/server.ts, api/src/ws/publisher.ts (live event stream)
