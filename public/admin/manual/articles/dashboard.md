---
title: Dashboard
summary: The Overview page and its Provider, Engines and Runner tabs, plus refresh recovery.
section: Admin workspace
verified: 2026-10-19
sources: api/src/routes/admin/overview/index.ts, api/src/routes/admin/setup/index.ts, api/src/services/setup-status.ts, api/src/services/setup-wizard.ts, api/src/services/chatgpt-usage.ts, api/src/services/dashboard-stats.ts, api/src/services/usage-scaling.ts, api/src/db/schema.ts, frontend/src/routes/dashboard/+page.svelte, frontend/src/lib/components/dashboard/OnboardingNotice.svelte, frontend/src/lib/api/setup.ts, frontend/src/lib/components/dashboard/UsageTable.svelte, frontend/src/lib/components/dashboard/EngineTable.svelte, frontend/src/lib/components/dashboard/RunnerStatus.svelte, frontend/src/lib/nav.ts, frontend/src/lib/api/overview.ts, frontend/src/lib/api/runner.ts
---

# Dashboard

The **Overview** page (`/dashboard`, the first entry of the sidebar) has three tabs: **Provider** (quota usage per account, the default), **Engines** (installed counts and the latest upstream version) and **Runner** (the sidecar that checks provider logins). Grok accounts show the stored billing-period usage and a relative reset (`in 6 days`, or hours when the reset is under a day). An absent reading stays unavailable and is never shown as 0% (see [Grok Build](cgx)). The header actions are **Refresh**, which reloads the overview, provider accounts and runner state together, and **Add host**. Host credential and version problems are not repeated here; they live on [Hosts](/admin/manual/hosts).

## Active Clients

The **Agents** page (`/agents`, previously Active Clients; its Live / Graph toggle also covers the old Topology page) is its own destination under *Operate*; the full reference — presence states, its agent-session switch, roles, and the wrapper side — is in [Agents and agent sessions](/admin/manual/agent-portal). In short: open its Live view for the session directory across Codex, Claude, and Grok. The
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
- **Provider usage** — the Provider usage table reads `GET /admin/accounts`, one row per provider account with its quota windows. `ChatGptUsageService` (`api/src/services/chatgpt-usage.ts`) reads canonical Codex auth and stores the ChatGPT quota snapshots behind those windows.
- **Claude usage** — Claude Code's statusline supplies new usage while the client runs. `GET /admin/claude/usage` returns the latest host report and `GET /admin/claude/usage/history` its history; the Overview no longer renders a separate Claude usage card.
- **Graph stats** — `dashboard_graph_quota_snapshots` is a compact quota-history table, kept separate from the verbose raw `logs` table. `ChatGptUsageService` writes a row to it on every quota fetch (`recordGraphSnapshot()`). `DashboardStatsService` (`api/src/services/dashboard-stats.ts`) exposes a `quotaSnapshots()` reader over the same table, but nothing in the current API or frontend calls it. The ChatGPT history endpoint (`GET /admin/chatgpt/usage/history`) reads `chatgpt_usage_snapshots` directly via `ChatGptUsageService.history()`; the Overview page no longer draws a history chart.

## Overview endpoint

`GET /admin/overview` returns: host count (`totals.hosts`), the reported-install buckets under `version_distribution.install`, `last_refresh`, `avg_refresh_age_days`, version summaries for the codex, claude, and grok engines, a `chatgpt_usage` snapshot and `chatgpt_usage_summary`, and a full set of settings flags (quota thresholds, scaling status, theme, retention policy, client version lock, and others).

## Setup resume card

`OnboardingNotice` is the first thing on the Overview page, above the tabs, while first-run setup is unfinished. It reads `GET /admin/setup/status` (via `setupStatusQuery()`, polled every 30 s) and renders when **both** of these hold:

- the wizard is neither completed nor dismissed (`wizard.completed_at` and `wizard.dismissed_at` are both null), **and**
- at least one `next_actions` entry is still incomplete.

It also renders whenever the `fleet_defaults` action is open, even after the wizard was dismissed or completed. Each open action links to its `href`. The notice titles itself *Resume setup* once `wizard.last_step` exists (*Finish setting up* before that); its button (**Resume setup**, or **Open the setup wizard** before the wizard was started) opens the first incomplete step. `next_actions` include `fleet_defaults` while no Codex `client_config_documents` row exists, so the notice cannot disappear with MCP still off. Separately, the layout sends a signed-in admin to `/setup` once per browser session while the same two conditions hold. **Dismiss** (shown only while the wizard is unfinished) posts `{dismissed: true}` to `POST /admin/setup/wizard` and hides the notice for good, unless `fleet_defaults` is still open — half the wizard is opt-ins, and declining every optional module is a finished answer, not an unfinished checklist.

Note that `setup_complete` on the same response is only `criticalComplete && ownerCreated`, so it is true from step two of nine; it is not what this notice keys on.

## Engines

The **Engines** table has one row per engine (Codex, Claude, Grok). **Hosts with it installed** is `N of M (pct%)` from `version_distribution.engine_counts` (a multi-engine host counts once in each engine); a response without it falls back to `both + codex_only` for Codex and `both + claude_only` for Claude, and a missing figure reads *No data* rather than an invented zero. **Latest version** is the latest upstream release (Codex from GitHub releases, Claude Code and Grok Build from npm; the Grok package is `@xai-official/grok`) with a "checked Xm/h/d ago" hint from `versions.cdx_version_checked_at` / `versions.claude_version_checked_at` / `versions.grok_version_checked_at` (1-hour-cached upstream lookups refreshed as a side effect of loading `/admin/overview`); a failing lookup reads "stale, checked …". It is **not** the installed version. **Status** is *On*, or *Disabled fleet-wide* (linking to Engines) when the engine's master switch is off. **Configure engines** opens the fleet defaults and version controls. Concrete installed client versions come from the host-reported `version_distribution`; policy aliases such as `latest` are never presented as installed versions.

The former separate *Engine coverage* card (exclusive groups per install combination, from `version_distribution.install_combinations`) is no longer rendered. The counts describe installation coverage, not host health, successful authentication, or current connectivity.

## Provider usage

**Provider usage** is one table with a row per provider account (**Manage accounts** opens `/accounts`). Columns: **Account** (label, provider and plan name, with "(last known)" when the plan is stale), **Status** (*Active*, *Login needed*, *Verification failed*, *Paused*, *Removing*, or *Not verified yet*, plus a *Disabled fleet-wide* tag when the engine is off, and the active session count), **Usage**, and **Updated**.

- **Usage** shows one `UsageMeter` per quota window the account actually reports, built by `accountQuotaRows()` in `frontend/src/lib/components/dashboard/account-usage.ts`. A window carrying no used percentage gets no meter; a window at exactly `0` is reported and does get one. Each meter is labeled from its own `limit_seconds` ("5-hour window", "Weekly window", or a generic "N-day"/"N-hour window"), never from its `primary`/`secondary` position, with a "Resets in …" line underneath.
- Grok accounts show a single *Monthly usage*, *Weekly usage* or *Current period* meter. An account without subscription quota reads "Subscription quota unavailable", and one with no reading yet reads "Waiting for usage data".
- *Last known reading* marks a stale reading; **Updated** is the relative time of the last fetch.
- With no provider accounts, the table shows "No provider accounts yet".

What chatgpt.com returns is not fixed: on 2026-07-11 it dropped the normal lane's 5-hour window and moved the weekly one into `primary_window`, leaving `secondary_window` null. That is why nothing here is keyed to a slot's usual meaning. The former separate ChatGPT and Claude usage cards, their sparklines and their "View history" charts are gone from this page; Claude windows come from the latest host report (run `clx` to produce new reports).

## Runner

The **Runner** tab (Verification runner) polls `GET /admin/runner` every 15 seconds and shows a row for each of Codex, Claude, and Grok; each engine's runner health is recorded independently. Each row contains its verification status, last check, last successful verification, any reported failure detail, and a **Run verification** button. A missing success is shown as **No success recorded**; the latest attempt is not treated as proof of success. **Not checked** represents an idle engine. The overall badge describes the shared runner's configuration and readiness.

The Codex button calls `POST /admin/runner/run`; the Claude button calls `POST /admin/runner/run-claude`; the Grok button calls `POST /admin/runner/run-grok`. While any of these requests runs, its row shows **Verifying…** and all three buttons are disabled to prevent overlapping manual checks from this page. Completion refreshes runner state. If status cannot refresh, the last result stays visible with a stale warning and **Retry runner state**; verification buttons remain disabled until state can be read successfully.

## Refresh

**Refresh** in the page header reloads the fleet snapshot, provider accounts and runner state together. There are no per-card refresh buttons any more, and no global dashboard refresh shortcut.

Failed first loads show an error and a retry control rather than a successful zero reading. Failed background refreshes retain the last received overview, accounts, or runner snapshot with a warning. Use the affected section's retry control (for example **Retry accounts** or **Retry runner state**) to recover.

## Host management

**Add host** in the Overview header opens the Add host form on the Hosts page (`/hosts`; the former *Register host* wording is gone and `/hosts/new` redirects to the form). The audit trail is under **Activity** (`/activity`). **Quick VM** is available on Hosts, beside Add host, and through the command palette; it creates an insecure (temporary-access) `tmp-*` host via `POST /admin/hosts/quick-register`.

## Source references

- api/src/routes/admin/overview/index.ts (`/admin/overview`, `/admin/logs`, `/admin/chatgpt/usage*`, `/admin/runner/*`, `/admin/toasts`)
- api/src/services/chatgpt-usage.ts (quota fetch/cache/history, graph-snapshot write)
- api/src/services/dashboard-stats.ts (recent/latest `logs` rows; unused `dashboard_graph_quota_snapshots` reader)
- api/src/services/usage-scaling.ts (`scaling` field on `/admin/overview`; not rendered on the dashboard today)
- api/src/db/schema.ts (`dashboard_graph_quota_snapshots`, `chatgpt_usage_snapshots`, `logs`)
- frontend/src/routes/dashboard/+page.svelte (Overview layout and tabs)
- frontend/src/lib/components/dashboard/OnboardingNotice.svelte (setup resume notice)
- frontend/src/lib/api/setup.ts (`setupStatusQuery`, wizard mutation, `invalidateSetup`)
- api/src/services/setup-status.ts, api/src/services/setup-wizard.ts (checks, next actions, progress blob)
- frontend/src/lib/components/dashboard/UsageTable.svelte, frontend/src/lib/components/dashboard/account-usage.ts (Provider usage)
- frontend/src/lib/components/dashboard/EngineTable.svelte (Engines table)
- frontend/src/lib/components/dashboard/RunnerStatus.svelte (Verification runner)
- frontend/src/lib/nav.ts (Overview entry in the sidebar)
- frontend/src/lib/api/overview.ts, frontend/src/lib/api/runner.ts (query/mutation builders + response shapes)

## Claude login expiry

The Claude row of the **Verification runner** section warns when the fleet login expires within three days and shows its exact UTC expiry. A successful verification can appear alongside this warning: the credential can work now while approaching expiry. The countdown remains available when the runner is unconfigured; missing expiry metadata is shown as unknown. After expiry the row says **Claude login expired**; the expiry is also visible on the Accounts page.

Run `/login` inside Claude launched through `clx`. Existing credential synchronization uploads and verifies the renewed login. The Overview clears the warning on its next 15-second poll after renewal becomes canonical. The warning itself does not refresh credentials or block requests.
