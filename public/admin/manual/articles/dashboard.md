---
title: Dashboard
summary: KPIs, ChatGPT quota windows, runner state, and how the charts are fed.
section: Admin workspace
verified: 2026-08-03
sources: api/src/routes/admin/overview/index.ts, api/src/routes/admin/setup/index.ts, api/src/services/setup-status.ts, api/src/services/setup-wizard.ts, api/src/services/chatgpt-usage.ts, api/src/services/dashboard-stats.ts, api/src/services/usage-scaling.ts, api/src/db/schema.ts, frontend/src/routes/dashboard/+page.svelte, frontend/src/routes/dashboard/OnboardingCard.svelte, frontend/src/lib/api/setup.ts, frontend/src/routes/dashboard/StatCard.svelte, frontend/src/routes/dashboard/ChatGptUsageCard.svelte, frontend/src/routes/dashboard/DashboardAlerts.svelte, frontend/src/lib/components/dashboard/RunnerCard.svelte, frontend/src/lib/api/overview.ts, frontend/src/lib/api/runner.ts
---

# Dashboard

The dashboard combines host health, ChatGPT quota windows, runner state, and version status.

## Data sources

- **Overview** — `GET /admin/overview` (registered in `api/src/routes/admin/overview/index.ts`, alongside `/admin/logs`, `/admin/chatgpt/usage*`, `/admin/runner/*`, and `/admin/toasts` — other admin route groups such as hosts, settings, config, auth, and users are registered from sibling files under `api/src/routes/admin/`) returns host totals, versions, quota settings, and the cached ChatGPT summary.
- **ChatGPT quota** — `ChatGptUsageService` (`api/src/services/chatgpt-usage.ts`) reads canonical Codex auth and stores quota snapshots. The dashboard card surfaces `primary_window` and `secondary_window` from the unified summary.
- **Graph stats** — `dashboard_graph_quota_snapshots` is a compact quota-history table, kept separate from the verbose raw `logs` table. `ChatGptUsageService` writes a row to it on every quota fetch (`recordGraphSnapshot()`). `DashboardStatsService` (`api/src/services/dashboard-stats.ts`) exposes a `quotaSnapshots()` reader over the same table, but nothing in the current API or frontend calls it — the "View history" chart in the ChatGPT usage card reads `chatgpt_usage_snapshots` directly via `ChatGptUsageService.history()` instead.

## Overview endpoint

`GET /admin/overview` returns: host count (`totals.hosts`), the reported-install buckets under `version_distribution.install`, `last_refresh`, `avg_refresh_age_days`, version summaries for both codex and claude engines, a `chatgpt_usage` snapshot and `chatgpt_usage_summary`, and a full set of settings flags (quota thresholds, scaling status, theme, retention policy, client version lock, and others).

## Setup resume card

`OnboardingCard` is the first thing on the dashboard while first-run setup is unfinished. It reads `GET /admin/setup/status` (via `setupStatusQuery()`, polled every 30 s) and renders only when **both** conditions hold:

- the wizard is neither completed nor dismissed (`wizard.completed_at` and `wizard.dismissed_at` are both null), **and**
- at least one `next_actions` entry is still incomplete.

It lists the open actions, titles itself *Resume setup* once `wizard.last_step` exists (*Finish setting up* before that), and links to `/setup?step=<last_step>` so you land where you stopped. **Dismiss** posts `{dismissed: true}` to `POST /admin/setup/wizard` and hides the card for good — half the wizard is opt-ins, and declining every optional module is a finished answer, not an unfinished checklist.

Note that `setup_complete` on the same response is only `criticalComplete && ownerCreated`, so it is true from step two of nine; it is not what this card keys on.

## Stat cards

The dashboard renders three stat cards sourced from a single `overviewQuery()` call against `GET /admin/overview`:

| Card | Field | Notes |
|---|---|---|
| Hosts | `totals.hosts`, `version_distribution.install` | Shows total hosts plus a compact Codex/Claude split. Engine counts mean hosts that reported the corresponding installed CLI version; a dual-engine host counts once in each engine total. |
| Codex latest | `versions.cdx_version_available` | Latest upstream Codex CLI version (GitHub releases) — **not** the installed version. |
| Claude latest | `versions.claude_version_available` | Latest upstream Claude Code CLI version (npm) — **not** the installed version. |

The Hosts card displays a relative-time hint derived from `last_refresh` (e.g. "no refreshes yet", "<1h since last refresh"). Its Codex count is `both + codex_only`; its Claude count is `both + claude_only`. If install telemetry is absent, the split shows `—` instead of inventing zero installs. The two "latest" cards show a "checked Xm/h/d ago" hint derived from `versions.cdx_version_checked_at` / `versions.claude_version_checked_at` (both are 1-hour-cached upstream lookups refreshed as a side effect of loading `/admin/overview`). Concrete installed client versions come from the host-reported `version_distribution`; policy aliases such as `latest` are never presented as installed versions.

## Alerts

`DashboardAlerts` renders between the stat cards and the usage cards. Up to three banners are shown conditionally:

- **Insecure approvals** (warning) — `insecureApprovalsPendingQuery()` counts hosts awaiting insecure-window approval. When the count is non-zero a warning banner lists the count and links to `/hosts?insecure=1` ("Review").
- **Could not check insecure approvals** (destructive) — shown instead of the warning banner when that query itself errors, with a "Retry" button.

Codex CLI updates do not produce a dashboard alert: managed hosts update automatically, so an older reported version is normally rollout telemetry rather than an operator action.

## ChatGPT usage card

`ChatGptUsageCard` calls `chatgptUsageQuery()` (`GET /admin/chatgpt/usage`) and `chatgptHistoryQuery(60)` (`GET /admin/chatgpt/usage/history?days=60&interval=day`) for the history series. It renders:

- One `UsageMeter` progress bar per quota window the snapshot actually reports, built by `chatgptQuotaRows()` in `frontend/src/lib/api/usage.ts`. A window carrying no `used_percent` gets no bar — the card never renders a meter for a slot the provider left empty. A window at exactly `0` is reported and does get a bar.
- Each bar is labeled from its own `limit_seconds` ("5-hour window", "Weekly window", or a generic "N-day"/"N-hour window"), never from its `primary`/`secondary` position; the positional name is only a fallback for a window that reports no duration. Spark-lane bars are prefixed `Spark · `.
- An inline `Sparkline` of recent usage, drawn from the highest-ranked history series that has points: the normal lane outranks Spark, and within a lane the longer window wins.
- "cached" appended to the card description (next to the plan type) when the response was served from cache — this is plain text, not a separate badge component.
- A "Rate limit reached" warning alert when `rate_limit_reached` is true, showing the next-eligible time when known.
- A "View history" button that opens a modal containing a full `TrendChart`. Series with no points are left out of the chart, and each remaining series is labeled from its own window length.
- An explicit refresh button that posts to `POST /admin/chatgpt/usage/refresh`.
- "No quota windows reported in the latest snapshot." when a snapshot exists but every window is empty — distinct from the "No usage recorded yet" state, which means no snapshot at all.

Both lanes are rendered when the provider reports both. What chatgpt.com returns is not fixed: on 2026-07-11 it dropped the normal lane's 5-hour window and moved the weekly one into `primary_window`, leaving `secondary_window` null. That is why nothing here is keyed to a slot's usual meaning.

## Runner

The Runner state card polls `GET /admin/runner` every 15 seconds — there are no WebSocket events for runner state changes today, so polling is the only refresh trigger. It reads `runner.engines.codex` and `runner.engines.claude` and renders one row per engine showing only the current per-engine status badge (`idle` / `OK` / `fail` / `not configured`; `running` is a defined-but-unused state because `POST /admin/runner/run` and `POST /admin/runner/run-claude` are synchronous calls that only resolve once the sidecar verification finishes) and a "Run verification" button. A separate overall badge in the card header (`idle` / `ready` / `fail` / `not configured`) summarizes `runner.configured` / `runner.ready`. The Codex row triggers `POST /admin/runner/run`; the Claude row triggers `POST /admin/runner/run-claude`. Triggering one engine also disables the other engine's button while that mutation is in flight. After a trigger the query is explicitly invalidated to reflect the updated state.

## Refresh

There is no keyboard shortcut for refreshing the dashboard. ChatGPT quota refreshes are explicit (the refresh button posts to `/admin/chatgpt/usage/refresh`) because they hit the upstream usage page; most other reads are local-table lookups that re-run on the normal query lifecycle.

## Host management

**New Host** and **Quick VM** are not on the dashboard. Both controls live on the Hosts page (`/hosts`). Quick VM creates an insecure temporary `tmp-*` host via `POST /admin/hosts/quick-register`.

## Source references

- api/src/routes/admin/overview/index.ts (`/admin/overview`, `/admin/logs`, `/admin/chatgpt/usage*`, `/admin/runner/*`, `/admin/toasts`)
- api/src/services/chatgpt-usage.ts (quota fetch/cache/history, graph-snapshot write)
- api/src/services/dashboard-stats.ts (recent/latest `logs` rows; unused `dashboard_graph_quota_snapshots` reader)
- api/src/services/usage-scaling.ts (`scaling` field on `/admin/overview`; not rendered on the dashboard today)
- api/src/db/schema.ts (`dashboard_graph_quota_snapshots`, `chatgpt_usage_snapshots`, `logs`)
- frontend/src/routes/dashboard/+page.svelte (stat cards, layout)
- frontend/src/routes/dashboard/OnboardingCard.svelte (setup resume card)
- frontend/src/lib/api/setup.ts (`setupStatusQuery`, wizard mutation, `invalidateSetup`)
- api/src/services/setup-status.ts, api/src/services/setup-wizard.ts (checks, next actions, progress blob)
- frontend/src/routes/dashboard/ChatGptUsageCard.svelte
- frontend/src/routes/dashboard/DashboardAlerts.svelte
- frontend/src/lib/components/dashboard/RunnerCard.svelte
- frontend/src/lib/api/overview.ts, frontend/src/lib/api/runner.ts (query/mutation builders + response shapes)
