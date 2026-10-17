---
title: Agents and agent sessions
section: Admin workspace
summary: Session settings, remote work, presence, Needs you, and instructing or closing an agent through the Agents page and Android.
tags: [clients, sessions, android, afk]
verified: 2026-10-17
sources: api/src/routes/agent-portal/admin-host.ts, api/src/routes/admin/agent-sessions/index.ts, api/src/services/agent-portal.ts, frontend/src/routes/(agents)/agents/+page.svelte, frontend/src/lib/components/portal/ClientsWorkspace.svelte, frontend/src/lib/components/portal/SessionControls.svelte, frontend/src/lib/components/portal/RemoteSessions.svelte, wrappers/cxx/internal/agentportal/command.go
---

The **Agents** page (`/agents`, in the Operate group; previously Active Clients) is the desktop directory and operator chat. Its **Live** view is described here; its **Graph** view (`/agents?view=graph`, previously Topology) is covered at the end.
The paired Android companion provides mobile chat, decisions and notifications.
The old `/go` webchat, magic links and portal-user management have been removed.

The compact directory has **Active** and **Online** filters, search and engine selection.
Active includes ongoing sessions and unresolved Needs you notices; affected chats are
highlighted and sorted first. Online shows sessions with fresh heartbeats. Avatar
icons show working, idle, waiting and connection states, with labels on hover.
Retained ended chats remain readable through existing session links.

## Agent session settings

The agent session settings (**Settings → Agents**, `/settings#agents`) control the existing shared master
switch and show queue health. The switch is seeded off and requires
`PUBLIC_BASE_URL`; disabling it cancels pending operator input and closes relays.
It does not stop the native local CLI. Setup calls this module **Agent sessions**.

## Remote sessions

On the Live view, switch the workspace toggle to **Remote sessions** (shown only with `agent_messaging.manage`) and use **Start remote session**: choose a configured host and engine, supply a title,
working directory and task, and start. The selected remote session supports
**Senden / Fortsetzen** and **Beenden**. Its history link opens the native session
in the Agents page. These controls require `agent_messaging.manage`; reading the
remote session output requires transcript access.

## What the wrappers report

A wrapper registers a session (`POST /host/agent-sessions`), heartbeats it, appends events, long-polls for instructions (`POST /host/agent-sessions/{id}/commands/claim`, up to 25 seconds per poll), acknowledges them, and finishes it — all authenticated by the host API key plus a per-session bridge token that lives `AGENT_PORTAL_BRIDGE_TTL_SECONDS` (default 900). Agents publish to the Agents page and Android through `cxx portal`: `status`, `notify --summary` (raise a *Needs you* notice), `resolve --summary` (withdraw one — the timeline, the relay, current work, and any unanswered question are kept), `say --text`, `ask --question [--options]`, `wait`, `accept`, and `leave`. Opening `#afk` starts listening quietly rather than raising a notice; attention is reserved for an action a person actually needs to take.

Timings come from `api/src/env.ts`: a heartbeat is fresh for `AGENT_PORTAL_HEARTBEAT_FRESH_SECONDS` (45), a relay for `AGENT_PORTAL_RELAY_FRESH_SECONDS` (60), a working turn for ten times the relay window, and an ended session stays readable for `AGENT_PORTAL_RETENTION_HOURS` (24). The session worker purges expired sessions and bridges every `AGENT_PORTAL_PURGE_INTERVAL_SECONDS` (300). An instruction is retried at most 12 times on 30-second leases before it is marked dead. Delivery re-reads the author as an agent reaches for a message and cancels it when that account has since been disabled or deleted.

## Active Clients

`GET /admin/agent-sessions` (`agent_portal.read`, polled every 15 seconds) returns `enabled`, the server's `generated_at`, its timing windows, and one row per session enriched with the Git Director task and Agent Messaging address for the worktree it sits in. The page is laid out like a messaging app: a conversation list on the left (status priority first, *Needs you* on top) and the selected session's thread on the right. Above the list, search host, user, task, branch, or working directory, pick an engine (All engines / Codex / Claude / Grok), and switch between the **Active** and **Online** views — all client-side over the last snapshot. Heartbeat, reported work, receiver evidence, and the close actions sit behind the thread header's **Session details** (ⓘ) button.

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
settings, messages, prompt answers and close actions. The console and Android
retain these shared contract names. Every operation rechecks current access.

## Live updates

Authoritative snapshots, scoped SSE, polling fallback and shared WebSocket
invalidations keep sessions current. Session settings invalidate on
`agent_portal.state`; client changes refresh on `agent_portal.sessions.changed`.

## Android companion

Install the Orchestrator APK (`io.uggs.orchestrator`, Android 8+). In the console,
open **Account → Android devices** (`/account#devices`) and choose **Pair Android device**, then scan the QR in the
app. Check the server address and connect; the code expires after five minutes
and works once. The phone receives its own revocable credential for your account.

The **Agents** tab supports text conversations and answers to agent questions.
Sending a message follows the conversation; toggle **Following** to stop ordinary question and reply
notifications. Explicit important/critical/blocker notices notify eligible devices
regardless of follow state, while
routine progress stays quiet. Firebase configuration is required for background
push, and Android must allow notifications.

The **Approvals** tab reviews existing host-access requests. Open a request to
check its hostname, IP, expiry, and access duration before approving or denying.
This grants host access, not tool/command approval inside an agent. A request
resolved on another device cannot be approved again. Your current console role
controls which operations are available.

Revoke a lost phone under **Account → Android devices** (`/account#devices`). Signing out on the phone
revokes that device too. If Firebase is not configured, the app still supports
chat and approval review while open. See the repository's
`docs/android-companion.md` for Firebase setup and signed APK builds.

## Work directly in Live Topology

Open the **Graph** view of the Agents page (`/agents?view=graph`; previously Live Topology) to select a session and use **Chat** without leaving its connection graph. The chat keeps its selected conversation when you inspect another node; press that node’s **Chat** button to switch conversations. Drafts stay with their original session.

**Start agent** on a communicator fills in its host; the toolbar action lets you choose any eligible host. A queued start appears as a pending remote session until the host actually starts it. Filters, collapsed branches, centering and fullscreen make larger fleets easier to navigate.

The server link is solid for reported **Persistent** runtime, dashed for **On demand**, and dotted when the mode is **Unknown**. Connection health is separate. Old reports are labeled as last reported rather than assumed current.

**Ask to close** is cooperative. **Stop the process** uses the owning wrapper when supported (cxx 0.9.85), sending TERM and escalating to KILL after five seconds. The dialog waits for the wrapper’s exit receipt; **unknown** means no recent receipt, not success. Recovery of the stopped execution is disabled. **End the session record**, under More actions, changes the server record without signaling the process. Communicator disconnect and communicator stop have their own separate effects and confirmation dialogs.
