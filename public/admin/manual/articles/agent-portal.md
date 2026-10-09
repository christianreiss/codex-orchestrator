---
title: Active Clients and agent sessions
section: Admin workspace
summary: Session settings, remote work, presence, Needs you, and instructing or closing an agent through Active Clients and Android.
tags: [clients, sessions, android, afk]
verified: 2026-10-09
sources: api/src/routes/agent-portal/admin-host.ts, api/src/routes/admin/agent-sessions/index.ts, api/src/services/agent-portal.ts, frontend/src/routes/clients/+page.svelte, frontend/src/lib/components/portal/SessionControls.svelte, frontend/src/lib/components/portal/RemoteSessions.svelte, wrappers/cxx/internal/agentportal/command.go
---

**Active Clients** (`/admin/clients`) is the desktop directory and operator chat.
The paired Android companion provides mobile chat, decisions and notifications.
The old `/go` webchat, magic links and portal-user management have been removed.

## Agent session settings

The expandable settings in Active Clients control the existing shared master
switch and show queue health. The switch is seeded off and requires
`PUBLIC_BASE_URL`; disabling it cancels pending operator input and closes relays.
It does not stop the native local CLI. Setup calls this module **Agent sessions**.

## Remote sessions

Open **Remote sessions**, choose a configured host and engine, supply a title,
working directory and task, and start. The selected remote session supports
**Senden / Fortsetzen** and **Beenden**. Its history link opens the native session
in Active Clients. These controls require `agent_messaging.manage`; reading the
remote session output requires transcript access.

## What the wrappers report

A wrapper registers a session (`POST /host/agent-sessions`), heartbeats it, appends events, long-polls for instructions (`POST /host/agent-sessions/{id}/commands/claim`, up to 25 seconds per poll), acknowledges them, and finishes it — all authenticated by the host API key plus a per-session bridge token that lives `AGENT_PORTAL_BRIDGE_TTL_SECONDS` (default 900). Agents publish to Active Clients and Android through `cxx portal`: `status`, `notify --summary` (raise a *Needs you* notice), `resolve --summary` (withdraw one — the timeline, the relay, current work, and any unanswered question are kept), `say --text`, `ask --question [--options]`, `wait`, `accept`, and `leave`. Opening `#afk` starts listening quietly rather than raising a notice; attention is reserved for an action a person actually needs to take.

Timings come from `api/src/env.ts`: a heartbeat is fresh for `AGENT_PORTAL_HEARTBEAT_FRESH_SECONDS` (45), a relay for `AGENT_PORTAL_RELAY_FRESH_SECONDS` (60), a working turn for ten times the relay window, and an ended session stays readable for `AGENT_PORTAL_RETENTION_HOURS` (24). The session worker purges expired sessions and bridges every `AGENT_PORTAL_PURGE_INTERVAL_SECONDS` (300). An instruction is retried at most 12 times on 30-second leases before it is marked dead. Delivery re-reads the author as an agent reaches for a message and cancels it when that account has since been disabled or deleted.

## Active Clients

`GET /admin/agent-sessions` (`agent_portal.read`, polled every 15 seconds) returns `enabled`, the server's `generated_at`, its timing windows, and one row per session enriched with the Git Director task and Agent Messaging address for the worktree it sits in. The page is laid out like a messaging app: a conversation list on the left (status priority first, *Needs you* on top) and the selected session's thread on the right. Above the list, search host, user, task, branch, or working directory, pick an engine (Codex / Claude), and narrow with the **Current**, **Needs you**, **Online**, **Ended**, and **All** chips (the chips carry the counts) — all client-side over the last snapshot. Heartbeat, reported work, receiver evidence, and the close actions sit behind the thread header's **Session details** (ⓘ) button.

Presence is derived on the client from the server snapshot and the server's clock, never from the browser's:

- **Ended** — the session finished or was force-closed; readable until its retention expires.
- **Offline** — the heartbeat is older than the heartbeat window. Current work is unconfirmed; the local engine has not necessarily stopped.
- **Listening** — the instruction relay is open and fresh: the agent will receive what you send.
- **Working** — it accepted an instruction and the turn is still within its window.
- **Idle** — online, but the relay is closed (a local CLI running without `#afk`) or has gone stale.

**Needs you** is independent of presence: a row with an outstanding notice or an unanswered question. The **Needs you** banner above the composer shows exactly that and disappears once the snapshot confirms nothing is outstanding; resolving a notice does not answer a question. Historical attention and resolution events remain in the stored record but no longer clutter the conversation.

Selecting a client opens the detail pane: heartbeat and last-activity times, the relay heartbeat, reported work and session details, and the timeline. The timeline (`GET /admin/agent-sessions/{id}/events`, at most 500 events per page) streams live over server-sent events (`GET /admin/agent-sessions/events?session_id=…`) with a heartbeat frame every 15 seconds; a stream that goes silent for 45 seconds reconnects with exponential backoff, browser wake reconnects a stale socket, and polling every 15 seconds is the fallback. Reconnection catches up from a fresh snapshot and preserves your scroll position when you are reading older messages. Only the current version of a question has active answer buttons.

The composer sends an instruction (`POST /admin/agent-sessions/{id}/messages`) or answers the open prompt (`POST /admin/agent-sessions/{id}/prompts/{promptId}/answer`). **Ask to close** (`POST …/close`) is queued for the agent to honour and needs an open relay; **Force close** (`POST …/close/force`) writes an event and a terminal state and no queue row, which is why it still works once the agent has gone offline — it does not kill the remote native process, and a second force on an ended session is a no-op. Every write carries a 10-second deadline and one retry under the same request identity, so a lost response cannot become a duplicate instruction; a draft and its original question context survive the failure. A failed refresh keeps the last rows and drafts, labels them as last known, and disables the actions until status recovers.

## Roles

`agent_portal.read` covers session metadata. `agent_portal.reveal_transcript`
covers message content and streaming, and `agent_portal.manage` covers session
settings, messages, prompt answers and close actions. Dashboard and Android
retain these shared contract names. Every operation rechecks current access.

## Live updates

Authoritative snapshots, scoped SSE, polling fallback and shared WebSocket
invalidations keep sessions current. Session settings invalidate on
`agent_portal.state`; client changes refresh on `agent_portal.sessions.changed`.

## Android companion

Install the Orchestrator APK (`io.uggs.orchestrator`, Android 8+). In the dashboard,
open **Account → Android devices → Pair Android device**, then scan the QR in the
app. Check the server address and connect; the code expires after five minutes
and works once. The phone receives its own revocable credential for your account.

The **Agents** tab supports text conversations and answers to agent questions.
Sending a message follows the conversation; toggle **Following** to stop reply
notifications. Questions and attention notices notify eligible devices, while
routine progress stays quiet. Firebase configuration is required for background
push, and Android must allow notifications.

The **Approvals** tab reviews existing host-access requests. Open a request to
check its hostname, IP, expiry, and access duration before approving or denying.
This grants host access, not tool/command approval inside an agent. A request
resolved on another device cannot be approved again. Your current dashboard role
controls which operations are available.

Revoke a lost phone under **Account → Android devices**. Signing out on the phone
revokes that device too. If Firebase is not configured, the app still supports
chat and approval review while open. See the repository's
`docs/android-companion.md` for Firebase setup and signed APK builds.
