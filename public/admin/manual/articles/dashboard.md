---
title: Dashboard metrics
section: Admin workspace
verified: 2026-04-19
sources: src/Http/Controllers/AdminOverviewController.php, src/Services/ChatGptUsageService.php, src/Services/ClaudeUsageService.php, src/Services/PricingService.php, src/Services/CostHistoryService.php, src/Services/UsageCostService.php, src/Services/UsageScalingService.php, src/Services/DashboardGraphStatsService.php, src/Repositories/TokenUsageRepository.php, public/admin/assets/dashboard.js, public/admin/assets/chart.umd.min.js
---

The dashboard at `/admin/dashboard` is fed by a single heavy endpoint — `GET /admin/overview` — plus a handful of follow-up calls for time-series and quota data. The JS side lives in `public/admin/assets/dashboard.js` and uses Chart.js (vendored as `chart.umd.min.js`).

## The overview endpoint

`AdminOverviewController::overview()` (`src/Http/Controllers/AdminOverviewController.php:368`) returns a single big JSON object that the dashboard binds to its cards. Notable blocks:

- **Fleet counts** — `count_hosts`, insecure-queue length, hosts pending provisioning.
- **Token totals** — `token_usage.totals` comes from `TokenUsageRepository::totals()`. The controller also computes *day*, *week*, and *month* ranges via `TokenUsageRepository::totalsForRange()`. The week range is special: if we have a ChatGPT snapshot with `secondary_limit_seconds`, the window is sized to the ChatGPT-reported rolling window; otherwise it's the last 6 days.
- **Top host** — `TokenUsageRepository::topHost()`.
- **Pricing** — `PricingService::latestPricing()` + `calculateCost()`. Pricing snapshots live in `pricing_snapshots` (`PricingSnapshotRepository`); the active snapshot is chosen by model and freshness.
- **ChatGPT quota** — `ChatGptUsageService::fetchLatest(false)` returns the cached snapshot unless you force-refresh. `secondary_limit_seconds` and `secondary_reset_after_seconds` drive the "rolling window usage" gauge.
- **Claude usage** — parallel to ChatGPT, via `ClaudeUsageService` (`AdminOverviewController::overview` merges both). Model pricing for Claude lives in `ClaudeModelService`.
- **Average last refresh** — average age (in days) of each host's `last_refresh`. Used for the fleet freshness chip.
- **Seed reasons** — a short list like `["missing_auth"]` that tells the UI whether to show the big "upload your auth" call-to-action.

## The cost card

*Dashboard → cost history* is driven by `GET /admin/usage/cost-history` (`usageCostHistory`) which returns daily cost rollups for a chosen window. Data comes from `CostHistoryService` which combines `token_usage` rows with the active pricing snapshot. The chart supports zoom (`chartjs-plugin-zoom.min.js`) and the time axis is built client-side from the returned series.

## The ChatGPT usage card

Two endpoints back it:

- `GET /admin/chatgpt/usage` (`chatgptUsage`) — most recent snapshot, including GPT-5 / 5-Pro / legacy quota lanes if reported.
- `GET /admin/chatgpt/usage/history` (`chatgptUsageHistory`) — a time-series you can pan over.
- `POST /admin/chatgpt/usage/refresh` (`chatgptUsageRefresh`) — forces a fresh call against the runner; surfaces whatever the upstream quota endpoint returned, including errors, so you can tell when the upstream is rate-limiting you.

Each lane ("primary" / "secondary" / per-model) renders its own meter. Meter colours use the `--meter-*` tokens from `theme.css`.

## The Claude usage card

`AdminSettingsController::getClaudeUsageHistory` returns Claude-side usage (token input / output / cache / total) per period. The dashboard's Claude card reuses the same Chart.js setup with different tokens.

## Tokens card

`GET /admin/tokens` (`AdminOverviewController::tokens`) returns just the totals without the heavier ChatGPT / Claude mix. This is what the "total tokens" chip reads when the big overview hasn't finished loading yet.

## Scaling

Orchestrator can impose an operator-side quota on aggressive hosts. `UsageScalingService` computes scaling tiers from a host's recent usage and surfaces a *Scaling* badge on the dashboard. The default chain now steps from `gpt-5.4` / `high` to `gpt-5.4-mini` / `high` before dropping to older Codex models. Toggle the feature at `POST /admin/scaling` (`AdminSettingsController::postScaling`); exempt specific hosts with `POST /admin/hosts/{id}/scaling-exempt`. VIP hosts (`POST /admin/hosts/{id}/vip`) bypass scaling entirely.

## Graph stats

Longer-horizon trend data is aggregated in the background and persisted by `DashboardGraphStatsService` into `dashboard_graph_stats`. The dashboard reads this through `GET /admin/overview` (the slow aggregates are computed once a day, not on each dashboard load).

## admin-ws live updates

When admin-ws is running, the dashboard receives live toast-ish events (new host sync, auth upload, insecure approval queued) without polling. The URL the UI connects to comes from `GET /admin/ws/info` (`wsInfo`). If admin-ws is unreachable the dashboard silently falls back to the same refresh interval the static cards use.

## Refresh semantics

The dashboard has a soft `[r]` shortcut that calls the same data-load path the initial render uses. A few endpoints (the ChatGPT quota refresh) must be invoked explicitly because they cost a network round-trip; the rest are cheap reads against local tables.

## Source references

- src/Http/Controllers/AdminOverviewController.php (overview, tokens, usage, cost-history, chatgpt, ws-info)
- src/Services/ChatGptUsageService.php (snapshot fetch, secondary window decoding)
- src/Services/ClaudeUsageService.php (Claude-side usage rollup)
- src/Services/PricingService.php (latestPricing, calculateCost)
- src/Services/CostHistoryService.php (daily cost series)
- src/Services/UsageCostService.php (per-host cost expansions)
- src/Services/UsageScalingService.php (scaling tiers)
- src/Services/DashboardGraphStatsService.php (trend aggregates)
- src/Repositories/TokenUsageRepository.php (totals, topHost, totalsForRange)
- src/Repositories/PricingSnapshotRepository.php (active pricing row)
- public/admin/assets/dashboard.js (chart init, view layout, refresh)
- public/admin/assets/chart.umd.min.js, chartjs-plugin-zoom.min.js
