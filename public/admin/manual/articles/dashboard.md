---
title: Dashboard
summary: KPIs, ChatGPT quota lanes, Claude usage, host shortcuts, and how the charts are fed.
sources: api/src/routes/admin/overview/index.ts, api/src/services/chatgpt-usage.ts, api/src/services/claude-usage.ts, api/src/services/usage-scaling.ts, api/src/services/dashboard-stats.ts
---

# Dashboard

The dashboard combines host health, token usage, ChatGPT quota windows, Claude usage, runner state, and version status.

## Data sources

- **Overview** — `GET /admin/overview` (in `api/src/routes/admin/overview/index.ts`) returns host totals, token aggregates, versions, quota settings, and cached ChatGPT/Claude summaries.
- **ChatGPT quota** — `ChatgptUsageService` (`api/src/services/chatgpt-usage.ts`) reads canonical Codex auth and stores quota snapshots for normal and Spark lanes.
- **Claude usage** — `ClaudeUsageService` (`api/src/services/claude-usage.ts`) groups Claude token rows by model and time window.
- **Graph stats** — `DashboardStatsService` (`api/src/services/dashboard-stats.ts`) keeps compact usage/quota history separate from verbose raw logs.

## Usage cards

Token cards show today, week, and month totals where available. Client usage rows come from `token_usage` and `/usage` ingest audits come from `token_usage_ingests`.

## Refresh

The dashboard has a soft `[r]` shortcut that calls the same data-load path the initial render uses. ChatGPT quota refreshes are explicit because they hit the upstream usage page; most other reads are local-table lookups.

## Hosts

`New Host` keeps the full hostname and guardrail form. `Quick VM` creates an insecure temporary `tmp-*` host, asks only for the engine set, and copies the installer immediately (routed through `POST /admin/hosts/quick-register`).

## Useful source files

- api/src/routes/admin/overview/index.ts
- api/src/routes/admin/hosts/index.ts
- api/src/services/chatgpt-usage.ts
- api/src/services/claude-usage.ts
- api/src/services/dashboard-stats.ts
- api/src/db/schema.ts (token_usage, token_usage_ingests, dashboard_graph_stats)
