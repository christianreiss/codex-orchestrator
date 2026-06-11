---

title: Dashboard
summary: KPIs, ChatGPT quota windows, runner state, and how the charts are fed.
sources: api/src/routes/admin/overview/index.ts, api/src/services/chatgpt-usage.ts, api/src/services/usage-scaling.ts, api/src/services/dashboard-stats.ts
---

# Dashboard

The dashboard combines host health, ChatGPT quota windows, runner state, and version status.

## Data sources

- **Overview** — `GET /admin/overview` (registered in `api/src/routes/admin/overview/index.ts`, which also registers all other core admin routes) returns host totals, versions, quota settings, and the cached ChatGPT summary.
- **ChatGPT quota** — `ChatgptUsageService` (`api/src/services/chatgpt-usage.ts`) reads canonical Codex auth and stores quota snapshots. The dashboard card surfaces `primary_window` and `secondary_window` from the unified summary.
- **Graph stats** — `DashboardStatsService` (`api/src/services/dashboard-stats.ts`) keeps compact quota history in `dashboard_graph_quota_snapshots`, separate from verbose raw logs.

## Overview endpoint

`GET /admin/overview` returns: host count (`totals.hosts`), `last_refresh`, `avg_refresh_age_days`, version summaries for both codex and claude engines, a `chatgpt_usage` snapshot and `chatgpt_usage_summary`, and a full set of settings flags (quota thresholds, scaling status, theme, retention policy, client version lock, and others).

## Stat cards

The dashboard renders three stat cards sourced from a single `overviewQuery()` call against `GET /admin/overview`:

| Card | Field | Notes |
|---|---|---|
| Hosts | `totals.hosts` | Always shows total host count. An active-only subset is not available from this endpoint without a separate round-trip; the card falls back to the total. |
| Codex version | `versions.client_version` | Installed Codex client version (falls back to `cdx_version`). |
| Claude version | `versions.claude_version` | Installed Claude client version. |

The Hosts card also displays a relative-time hint derived from `last_refresh` (e.g. "no refreshes yet", "<1h since last refresh").

## Alerts

`DashboardAlerts` renders between the stat cards and the usage cards. Two banners are shown conditionally:

- **Insecure approvals** (warning) — `insecureApprovalsPendingQuery()` counts hosts awaiting insecure-window approval. When the count is non-zero a warning banner lists the count and links to `/hosts?insecure=1` ("Review").
- **Update available** (info) — on mount, `versionsCheckMutation()` makes a one-shot network call to check the latest release and compares `available_client` against the installed `client_version` / `cdx_version`. When a newer version is detected an info banner appears with a "View" button that opens the `UpgradeModal` showing current and available versions.

## ChatGPT usage card

`ChatGptUsageCard` calls `chatgptUsageQuery()` (`GET /admin/chatgpt/usage`) and `chatgptHistoryQuery(60)` for the history series. It renders:

- `primary_window.used_percent` and `secondary_window.used_percent` as `UsageMeter` progress bars.
- An inline `Sparkline` of recent usage.
- A "cached" badge in the card description when the response was served from cache.
- A "View history" button that opens a modal containing a full `TrendChart`.
- An explicit refresh button that posts to `POST /admin/chatgpt/usage/refresh`.

There are no separate "normal lane" vs "Spark lane" meters in the rendered card — only `primary_window` and `secondary_window` from the unified summary are displayed.

## Runner

The Runner state card polls `GET /admin/runner` every 15 seconds. It reads `runner.engines.codex` and `runner.engines.claude` and renders one row per engine showing a status badge (idle / running / ready / fail / unconfigured), last-run / last-ok / last-fail timestamps, and a play button. The Codex row triggers `POST /admin/runner/run`; the Claude row triggers `POST /admin/runner/run-claude`. After a trigger the query is explicitly invalidated to reflect the updated state.

## Refresh

There is no keyboard shortcut for refreshing the dashboard. ChatGPT quota refreshes are explicit (the refresh button posts to `/admin/chatgpt/usage/refresh`) because they hit the upstream usage page; most other reads are local-table lookups that re-run on the normal query lifecycle.

## Host management

**New Host** and **Quick VM** are not on the dashboard. Both controls live on the Hosts page (`/hosts`). Quick VM creates an insecure temporary `tmp-*` host via `POST /admin/hosts/quick-register`.

## Useful source files

- `api/src/routes/admin/overview/index.ts` (overview + all core admin routes)
- `api/src/services/chatgpt-usage.ts`
- `api/src/services/dashboard-stats.ts`
- `api/src/db/schema.ts` (`dashboard_graph_quota_snapshots`)
- `src/routes/dashboard/+page.svelte`
