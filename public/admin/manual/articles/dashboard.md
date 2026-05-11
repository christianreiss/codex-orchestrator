---
title: Dashboard
summary: KPIs, ChatGPT quota lanes, Claude usage, host shortcuts, and how the charts are fed.
sources: src/Http/Controllers/AdminOverviewController.php, src/Http/Controllers/AdminHostController.php, src/Services/ChatGptUsageService.php, src/Services/ClaudeUsageService.php, src/Services/UsageScalingService.php, src/Services/DashboardGraphStatsService.php, src/Repositories/TokenUsageRepository.php, public/admin/assets/dashboard.js
---

# Dashboard

The dashboard combines host health, token usage, ChatGPT quota windows, Claude usage, runner state, and version status.

## Data sources

- **Overview** — `AdminOverviewController::overview()` returns host totals, token aggregates, versions, quota settings, and cached ChatGPT/Claude summaries.
- **ChatGPT quota** — `ChatGptUsageService` reads canonical Codex auth and stores quota snapshots for normal and Spark lanes.
- **Claude usage** — `ClaudeUsageService` groups Claude token rows by model and time window.
- **Graph stats** — `DashboardGraphStatsService` keeps compact usage/quota history separate from verbose raw logs.

## Usage Cards

Token cards show today, week, and month totals where available. Client usage rows come from `token_usages` and `/usage` ingest audits come from `token_usage_ingests`.

## Refresh

The dashboard has a soft `[r]` shortcut that calls the same data-load path the initial render uses. ChatGPT quota refreshes are explicit because they hit the upstream usage page; most other reads are local-table lookups.

## Hosts

`New Host` keeps the full hostname and guardrail form. `Quick VM` creates an insecure temporary `tmp-*` host, asks only for the engine set, and copies the installer immediately.

## Useful Source Files

- src/Http/Controllers/AdminOverviewController.php
- src/Http/Controllers/AdminHostController.php
- src/Services/ChatGptUsageService.php
- src/Services/ClaudeUsageService.php
- src/Services/DashboardGraphStatsService.php
- src/Repositories/TokenUsageRepository.php
- public/admin/assets/dashboard.js
