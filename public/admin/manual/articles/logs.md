---
title: Activity — configuration and system changes
section: Admin workspace
summary: Audit history and the SQL data it represents.
verified: 2026-10-24
sources: frontend/src/routes/(activity)/activity/+page.svelte, frontend/src/lib/components/logs/ChangesPanel.svelte, api/src/routes/admin/overview/index.ts, api/src/routes/admin/settings/index.ts, api/src/services/secrets.ts
---

# Activity

Activity (`/admin/activity`) shows configuration and system changes from `logs`, through `GET /admin/logs?limit=500`. Search by action, host or details; filter by host, action prefix and time window. Results are limited to the latest 500 changes and paged 50 at a time. Expand a row for its complete JSON record and Copy JSON.

Generic MCP call recording and its Tool calls view have been removed. Discovery, resource reads and ordinary tool calls do not create `mcp_access_logs` rows. Old `/logs/mcp` links open Activity. An error is returned directly to the caller.

## Data with a purpose

- `logs` supplies this change history. It also supports host provisioning grace periods, session counts, engine-change attribution, and memory-change history.
- `admin_events` records administrative/security actions and durable Git notification delivery. Secret reads are recorded here before a value is returned; no credential value is logged.
- Agent, room, workflow, feedback, transfer and project events are functional histories. They support chat timelines, cursors, idempotency, delivery and review; they are not generic request logs.

## Cleanup

The former log-retention settings had no cleanup worker. Their controls have been removed. `GET/POST /admin/log-retention` remains a compatibility endpoint returning `enabled:false`, `supported:false`, `reason:retired_no_worker`; old submitted windows are ignored. This does not change the separate host and agent-session lifecycle cleanup.

## Live updates

The console receives change notifications through `/admin/ws`. The event feed retains its filters when refreshed. Generic `mcp.invoked` notifications are no longer emitted.
