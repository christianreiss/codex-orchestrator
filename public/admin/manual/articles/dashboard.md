---
title: Dashboard
summary: Reported engine coverage, Codex and Claude usage, runner verification, and refresh recovery.
section: Admin workspace
verified: 2026-09-09
sources: api/src/routes/admin/overview/index.ts, api/src/routes/admin/setup/index.ts, api/src/services/setup-status.ts, api/src/services/setup-wizard.ts, api/src/services/chatgpt-usage.ts, api/src/services/dashboard-stats.ts, api/src/services/usage-scaling.ts, api/src/db/schema.ts, frontend/src/routes/dashboard/+page.svelte, frontend/src/routes/dashboard/OnboardingCard.svelte, frontend/src/lib/api/setup.ts, frontend/src/routes/dashboard/StatCard.svelte, frontend/src/routes/dashboard/ChatGptUsageCard.svelte, frontend/src/routes/dashboard/DashboardAlerts.svelte, frontend/src/lib/components/dashboard/RunnerCard.svelte, frontend/src/lib/api/overview.ts, frontend/src/lib/api/runner.ts
---

# Dashboard

The **Overview** page combines reported host installations, upstream CLI versions, Codex and Claude quota usage, and runner verification. Use **Refresh overview** to reload fleet counts and release information; each usage card has its own refresh control.

## Active Clients

**Active Clients** (`/clients`) is its own destination under *Monitor*; the full reference — presence states, the Agent Portal switch it depends on, roles, and the wrapper side — is in [Agent Portal and Active Clients](/admin/manual/agent-portal). In short: open it for the session directory across Codex and Claude. The
summary counts distinguish online clients, outstanding attention, offline
clients, and recently ended history. Search by host, user, task, branch, or
working directory, then filter by engine and state. Selecting a client opens
its work details, heartbeat and relay timestamps, and permitted timeline.

**Online** means the wrapper recently contacted the server. **Listening** means
its instruction relay is open; **Working** means it accepted an instruction.
**Not listening** means the local CLI is running with its remote relay closed;
run `#afk` in that local session before sending portal input. Offline means current work is unconfirmed, not
that the local engine has necessarily stopped. Revoked or expired credentials
and disabled engines also make a client unavailable.

Status checks run every 15 seconds and use the server's clock. During an outage,
the last known clients and per-session drafts stay visible, with a retry action;
refresh status before sending. Reconnected timelines catch up automatically and
preserve your position when you are reading older messages. The detail pane
shows whether its timeline stream is live or reconnecting. A send that cannot
be confirmed keeps its draft and original question; retry confirms that same
request rather than creating a duplicate. Only the current question has active
answer buttons. On a phone, **Clients** returns from the detail pane to the directory.

A prominent **Needs you** banner above the composer shows current attention and
unanswered questions, with reply controls while the client can receive them.
It disappears when the authoritative client snapshot confirms there is no
outstanding notice or question. Resolving a notice does not answer a question.
Historical attention and resolution events remain stored but no longer appear
as status strips in the conversation.

Sending and closing require the appropriate admin capability. **Ask to close**
needs a reachable relay; **Force close** ends the recorded session even when its
client is offline, but does not kill a remote native process. Completed history
remains readable until the configured retention period expires.

## Data sources

- **Overview** — `GET /admin/overview` (registered in `api/src/routes/admin/overview/index.ts`, alongside `/admin/logs`, `/admin/chatgpt/usage*`, `/admin/runner/*`, and `/admin/toasts` — other admin route groups such as hosts, settings, config, auth, and users are registered from sibling files under `api/src/routes/admin/`) returns host totals, versions, quota settings, and the cached ChatGPT summary.
- **ChatGPT quota** — `ChatGptUsageService` (`api/src/services/chatgpt-usage.ts`) reads canonical Codex auth and stores quota snapshots. The dashboard card surfaces `primary_window` and `secondary_window` from the unified summary.
- **Claude usage** — `GET /admin/claude/usage` returns the latest host report; Claude Code's statusline supplies new usage while the client runs. `GET /admin/claude/usage/history` provides its history.
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

**Engine coverage** shows four exclusive groups: Both engines, Codex only, Claude only, and No version reported. Counts and percentages come from reported CLI versions. They describe installation coverage, not host health, successful authentication, or current connectivity. **Configure engines** opens the fleet defaults and version controls.

## Alerts

`DashboardAlerts` renders below the stat cards. Its banners are conditional:

- **Insecure approvals** (warning) — `insecureApprovalsPendingQuery()` counts hosts awaiting insecure-window approval. When the count is non-zero a warning banner lists the count and links to `/hosts?insecure=1` ("Review"), which opens the insecure access dialog described in [Hosts](/admin/manual/hosts). A new request also opens that dialog on its own from any console page, with a short beep, when the `insecure.requested` event arrives over the live feed.
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

## Claude usage card

The Claude card shows only reported 5-hour and weekly quota windows; an absent window is omitted, while a reported zero remains visible. **History** opens the usage chart, excluding series with no points. **Refresh** reloads the latest stored host report and history; run `clx` to produce new reports. The last-report time helps distinguish older data from a fresh report.

## Runner

The **Runner state** card polls `GET /admin/runner` every 15 seconds and shows separate Codex and Claude panels. Each contains its verification status, last check, last successful verification, any reported failure detail, and a **Run verification** button. A missing success is shown as **No success recorded**; the latest attempt is not treated as proof of success. **Not checked** represents an idle engine. The overall badge describes the shared runner's configuration and readiness.

The Codex button calls `POST /admin/runner/run`; the Claude button calls `POST /admin/runner/run-claude`. While either request runs, its panel shows **Verifying…** and both buttons are disabled to prevent overlapping manual checks from this page. Completion refreshes runner state. If status cannot refresh, the last result stays visible with a stale warning and **Retry runner state**; verification buttons remain disabled until state can be read successfully.

## Refresh

**Refresh overview** reloads the fleet snapshot. ChatGPT's separate refresh button posts to `/admin/chatgpt/usage/refresh`; Claude's reloads the most recent host report. There is no global dashboard refresh shortcut.

Failed first loads show an error and a retry control rather than a successful zero reading. Failed background refreshes retain the last received overview, usage, or runner snapshot with a warning. Use the affected panel's **Retry** control to recover; **History** remains available after a history-load error and offers its own retry.

## Host management

**Register host** opens the new-host dialog on the Hosts page (`/hosts`). **Activity** opens the audit trail. **Quick VM** is available on Hosts and through the command palette; it creates an insecure temporary `tmp-*` host via `POST /admin/hosts/quick-register`.

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
- frontend/src/routes/dashboard/ClaudeUsageCard.svelte
- frontend/src/routes/dashboard/FleetCoverage.svelte
- frontend/src/routes/dashboard/DashboardAlerts.svelte
- frontend/src/lib/components/dashboard/RunnerCard.svelte
- frontend/src/lib/api/overview.ts, frontend/src/lib/api/runner.ts (query/mutation builders + response shapes)

## Claude login expiry

The Claude section of **Runner state** warns when the fleet login expires within three days and shows its exact UTC expiry. A successful verification can appear alongside this warning: the credential can work now while approaching expiry. The countdown remains available when the runner is unconfigured; missing expiry metadata is shown as unknown. After expiry the card says **Claude login expired**.

Run `/login` inside Claude launched through `clx`. Existing credential synchronization uploads and verifies the renewed login. The dashboard clears the warning on its next 15-second poll after renewal becomes canonical. The warning itself does not refresh credentials or block requests.
