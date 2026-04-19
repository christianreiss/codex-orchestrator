---
title: Logs — API, MCP, and Events
section: Admin workspace
verified: 2026-04-19
sources: src/Repositories/LogRepository.php, src/Repositories/AdminEventRepository.php, src/Repositories/McpAccessLogRepository.php, src/Http/Controllers/AdminOverviewController.php, src/Http/Controllers/AdminConfigController.php, src/Http/Controllers/AdminSettingsController.php, scripts/admin-ws.php, public/admin/assets/logs.js, public/admin/assets/admin-ws.js
---

Three log streams live in the admin UI. Each has its own rail shortcut and its own retention knob. They differ in what writes to them and how often.

## The three streams

- **API Logs** — `/admin/logs` (shortcut `[l][c]`). Every host-facing API interaction: `/auth`, `/sync/status`, `/sync/bootstrap`, `/usage`, the `/v1/*` and `/anthropic/v1/*` API-compat calls. Written by `LogRepository::log()` with a small set of canonical `action` strings.
- **MCP Logs** — `/admin/logs/mcp` (shortcut `[l][m]`). Every tool call and resource read against the MCP server. Written by `McpAccessLogRepository` from `McpServer::dispatch()`.
- **Events** — `/admin/logs/events` (shortcut `[l][e]`). Administrative audit trail: logins, role changes, config stores, agents reverts, host deletes, insecure approvals. Written by `AdminEventRepository`.

Open any of the three via the rail; the JS controller is `public/admin/assets/logs.js`, which calls the stream-specific endpoint and renders a paged list with filters.

## API log endpoint

`GET /admin/logs` (`AdminOverviewController::logs`) returns recent rows from `LogRepository::recent()`. Filters understood by the JS:

- action (text contains match against the canonical action string)
- host id
- time window

`LogRepository::recent()` is the canonical read path; there is also `recentByActions()` for narrower pulls, and `latestByHostAndActions()` for "when did this host last do X?" lookups. Common action strings you will see:

- `auth.retrieve`, `auth.refuse`, `auth.runner.verify_failed`
- `sync.status`, `sync.bootstrap`
- `usage.ingest`
- `install.token.consumed`
- `host.register`, `host.delete`, `host.rotate_key`

## MCP log endpoint

`GET /admin/mcp/logs` (`AdminConfigController::mcpLogs`) returns `McpAccessLogRepository` rows. Each entry has a timestamp, host, capability (`host` vs `operator`), tool name (or resource URI), and the outcome (ok / error / denied). Use this when debugging "why did my agent's call fail?" — the error rows carry the JSON-RPC error body.

## Events endpoint

Events come from `AdminEventRepository`. The JS calls into the same `/admin/logs` family but with a type filter. Events you will see:

- `admin.auth.login`, `admin.auth.logout`, `admin.auth.password.change`
- `admin.user.create`, `admin.user.update`, `admin.user.delete`
- `admin.agents.store`, `admin.agents.serve`, `admin.agents.revert`
- `admin.skill.store`, `admin.skill.delete`
- `admin.host.register`, `admin.host.delete`, `admin.host.roaming.toggle`
- `admin.insecure.approve`, `admin.insecure.deny`, `admin.insecure.disable_all`
- `admin.runner.probe`

If the system is doing something you did not ask it to do, the events stream is where you find the ghost.

## Retention

Logs do not live forever. *Settings → General → Log retention*:

- `GET /admin/log-retention` (`AdminSettingsController::getLogRetention`) — current windows in days.
- `POST /admin/log-retention` (`postLogRetention`) — update them.

The enforcement call is `LogRepository::deleteOlderThan(int $days)`, invoked periodically from the daily preflight (`AuthService::runDailyPreflight`). `AdminEventRepository` has the equivalent.

## Live streaming (admin-ws)

If you have `scripts/admin-ws.php` running, the admin UI opens a WebSocket to it (URL from `GET /admin/ws/info`, `AdminOverviewController::wsInfo`) and receives live events without polling. `public/admin/assets/admin-ws.js` is the browser half:

- On open, subscribes to the streams the current panel cares about.
- Dispatches `admin-ws:event` custom events; `logs.js` listens and prepends incoming rows to the list without scrolling past them.
- On close / error, falls back to the existing timed refresh.

The admin-ws process itself reads from the same repositories as the HTTP endpoints; it does not have its own storage.

## What to do when a log line is unclear

Every canonical action has `details` JSON attached at write time (`LogRepository::log(host, action, details)`). Expand the row to see it — that is where host IPs, refusal reasons, and runner error codes live. If the details are empty, check the row at the same timestamp on the *Events* stream; the admin-side of a request and the host-side often show up as a pair.

## Source references

- src/Repositories/LogRepository.php (log, recent, deleteOlderThan)
- src/Repositories/AdminEventRepository.php (events)
- src/Repositories/McpAccessLogRepository.php (MCP access log)
- src/Http/Controllers/AdminOverviewController.php (logs, wsInfo)
- src/Http/Controllers/AdminConfigController.php (mcpLogs)
- src/Http/Controllers/AdminSettingsController.php (getLogRetention, postLogRetention)
- scripts/admin-ws.php (websocket fan-out)
- public/admin/assets/logs.js, public/admin/assets/admin-ws.js
