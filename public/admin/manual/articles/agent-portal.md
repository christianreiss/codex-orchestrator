---
title: Agent Portal and Active Clients
section: Admin workspace
summary: The portal master switch and permanent links, the Active Clients directory, presence states, the Needs-you banner, and instructing or closing a running agent.
tags: [portal, clients, sessions, afk]
verified: 2026-09-09
sources: api/src/routes/agent-portal/admin-host.ts, api/src/routes/agent-portal/public.ts, api/src/routes/admin/agent-sessions/index.ts, api/src/services/agent-portal.ts, api/src/env.ts, api/src/security/capabilities.ts, api/src/security/authorization-mode.ts, frontend/src/routes/agent-portal/+page.svelte, frontend/src/routes/settings/agent-portal/+page.svelte, frontend/src/routes/clients/+page.svelte, frontend/src/lib/api/agentSessions.ts, frontend/src/lib/api/session-write.ts, frontend/src/lib/portal/presence.ts, frontend/src/lib/portal/clients.ts, frontend/src/lib/portal/client-events.ts, frontend/src/lib/components/portal/AttentionCard.svelte, wrappers/cxx/internal/agentportal/command.go
---

Two console pages share one session model. **Agent Portal** (`/agent-portal`, under *Coordinate*) is the master switch and the permanent links that let someone without a console account reach running agents from a phone at `/go`. **Active Clients** (`/clients`, under *Monitor*) is the same view over the admin session cookie: every wrapper the fleet knows about, what it is working on, and — for owners and admins — a composer to instruct it.

## Agent Portal

The persistent master switch (`GET`/`POST /admin/agent-portal/state`, `agent_portal.manage`) is seeded **off**. `PUBLIC_BASE_URL` is the only configuration the portal needs; the switch is disabled until it is set. Disabling the switch cancels every queued instruction and revokes active portal browser sessions, but does not stop the local wrappers — they simply stop registering, which is why Active Clients is empty while the portal is off and says so.

Below the switch, **Add user** (`POST /admin/agent-portal/users` with a display name) creates a portal user and shows the permanent link once. Per user:

- **Show link** / **Hide link** — `GET /admin/agent-portal/users/{id}/link` re-renders the stored link without rotating it, so an operator can re-bookmark on a new device. It needs `agent_portal.reveal_link` (owner/admin), separate from managing the account, because the URL is reusable bearer material; the listing (`GET /admin/agent-portal/users`) never includes it.
- **Enable** / **Disable** — `POST /admin/agent-portal/users/{id}/enabled`.
- **Rotate link** — `POST /admin/agent-portal/users/{id}/rotate`, after a confirmation. Rotation is the only operation that invalidates an existing bookmark.
- **Delete** — `DELETE /admin/agent-portal/users/{id}`.

Every mutation writes an `agent_portal.*` admin event with the acting user's id, and `agent_portal.user.link_revealed` records each reveal.

The portal is **pull-only**: nothing is pushed to a user. Each person opens their own permanent link — bookmarked on desktop, or added to the home screen on a phone — and finds whatever the agents recorded while they were away. The `/go` surface (`GET /go`, `GET /go/u/{publicId}`, and the `/go/api/*` routes in `api/src/routes/agent-portal/public.ts`) accepts either the portal cookie from a magic-link exchange or a console session, so an operator with a console account reaches it without a link; a valid portal cookie still wins.

## What the wrappers report

A wrapper registers a session (`POST /host/agent-sessions`), heartbeats it, appends events, long-polls for instructions (`POST /host/agent-sessions/{id}/commands/claim`, up to 25 seconds per poll), acknowledges them, and finishes it — all authenticated by the host API key plus a per-session bridge token that lives `AGENT_PORTAL_BRIDGE_TTL_SECONDS` (default 900). Agents talk to the portal through `cxx portal`: `status`, `notify --summary` (raise a *Needs you* notice), `resolve --summary` (withdraw one — the timeline, the relay, current work, and any unanswered question are kept), `say --text`, `ask --question [--options]`, `wait`, `accept`, and `leave`. Opening `#afk` starts listening quietly rather than raising a notice; attention is reserved for an action a person actually needs to take.

Timings come from `api/src/env.ts`: a heartbeat is fresh for `AGENT_PORTAL_HEARTBEAT_FRESH_SECONDS` (45), a relay for `AGENT_PORTAL_RELAY_FRESH_SECONDS` (60), a working turn for ten times the relay window, and an ended session stays readable for `AGENT_PORTAL_RETENTION_HOURS` (24). Portal browser sessions last `AGENT_PORTAL_SESSION_TTL_HOURS` (24), and the portal worker purges expired sessions and bridges every `AGENT_PORTAL_PURGE_INTERVAL_SECONDS` (300). An instruction is retried at most 12 times on 30-second leases before it is marked dead. Delivery re-reads the author as an agent reaches for a message and cancels it when that account has since been disabled or deleted.

## Active Clients

`GET /admin/agent-sessions` (`agent_portal.read`, polled every 15 seconds) returns `enabled`, the server's `generated_at`, its timing windows, and one row per session enriched with the Git Director task and Agent Messaging address for the worktree it sits in. The summary cards count **Online**, **Needs attention**, **Offline**, and **Recently ended**; below them, filter by engine (Codex / Claude) and state (active, online, attention, working, listening, idle, offline, ended), sort by status, recency, or host, and search host, user, task, branch, or working directory — all client-side over the last snapshot.

Presence is derived on the client from the server snapshot and the server's clock, never from the browser's:

- **Ended** — the session finished or was force-closed; readable until its retention expires.
- **Offline** — the heartbeat is older than the heartbeat window. Current work is unconfirmed; the local engine has not necessarily stopped.
- **Listening** — the instruction relay is open and fresh: the agent will receive what you send.
- **Working** — it accepted an instruction and the turn is still within its window.
- **Idle** — online, but the relay is closed (a local CLI running without `#afk`) or has gone stale.

**Needs attention** is independent of presence: a row with an outstanding notice or an unanswered question. The **Needs you** banner above the composer shows exactly that and disappears once the snapshot confirms nothing is outstanding; resolving a notice does not answer a question. Historical attention and resolution events remain in the stored record but no longer clutter the conversation.

Selecting a client opens the detail pane: heartbeat and last-activity times, the relay heartbeat, reported work and session details, and the timeline. The timeline (`GET /admin/agent-sessions/{id}/events`, at most 500 events per page) streams live over server-sent events (`GET /admin/agent-sessions/events?session_id=…`) with a heartbeat frame every 15 seconds; a stream that goes silent for 45 seconds reconnects with exponential backoff, browser wake reconnects a stale socket, and polling every 15 seconds is the fallback. Reconnection catches up from a fresh snapshot and preserves your scroll position when you are reading older messages. Only the current version of a question has active answer buttons.

The composer sends an instruction (`POST /admin/agent-sessions/{id}/messages`) or answers the open prompt (`POST /admin/agent-sessions/{id}/prompts/{promptId}/answer`). **Ask to close** (`POST …/close`) is queued for the agent to honour and needs an open relay; **Force close** (`POST …/close/force`) writes an event and a terminal state and no queue row, which is why it still works once the agent has gone offline — it does not kill the remote native process, and a second force on an ended session is a no-op. Every write carries a 10-second deadline and one retry under the same request identity, so a lost response cannot become a duplicate instruction; a draft and its original question context survive the failure. A failed refresh keeps the last rows and drafts, labels them as last known, and disables the actions until status recovers.

## Roles

`agent_portal.read` (every role) covers the Agent Portal page's health view and the Active Clients directory with its counts and presence. Three further capabilities are owner/admin only: `agent_portal.reveal_link` (Show link), `agent_portal.reveal_transcript` (the timeline and the event stream — a viewer who may see that the fleet is busy has not thereby been granted every conversation it is having; without it the pane says the timeline is hidden), and `agent_portal.manage` (the switch, portal users, the composer, and both close actions). A fleet operator can run Git Director but cannot instruct or read an agent here. `agent_portal.manage` and `agent_portal.reveal_transcript` are on the always-enforced list in `api/src/security/authorization-mode.ts`, so `compatible` mode does not relax them, and the `/go/api/*` routes assert the same two when a console session rather than a portal cookie is used.

## Live updates

`agent_portal.state` and the `agent_portal.user.*` events refresh the Agent Portal page. Active Clients gets exactly one push, `agent_portal.session.force_closed` — nothing publishes on register, heartbeat, or event append, which is why the directory polls and the timeline streams — plus `agent_portal.sessions.changed` and a resample on every WebSocket reconnect.

## Source references

- api/src/routes/agent-portal/admin-host.ts (`/admin/agent-portal/*` and the wrapper-side `/host/agent-sessions*` routes)
- api/src/routes/agent-portal/public.ts (the `/go` portal and `/go/api/*`, console session or portal cookie)
- api/src/routes/admin/agent-sessions/index.ts (the Active Clients list, SSE stream, messages, prompt answers, close and force close)
- api/src/services/agent-portal.ts (presence windows, delivery attempts, attention-clearing events, `setEnabled` cancelling queued work)
- api/src/env.ts (`AGENT_PORTAL_*` windows and TTLs)
- api/src/security/capabilities.ts, api/src/security/authorization-mode.ts (`agent_portal.*` capabilities; two of them always enforced)
- frontend/src/routes/agent-portal/+page.svelte, frontend/src/routes/settings/agent-portal/+page.svelte (switch, users, Show link, rotate, delete)
- frontend/src/routes/clients/+page.svelte (directory, filters, detail pane, composer)
- frontend/src/lib/api/agentSessions.ts, frontend/src/lib/api/session-write.ts (15-second polling, 10-second bounded writes with stable request identity)
- frontend/src/lib/portal/presence.ts, frontend/src/lib/portal/clients.ts, frontend/src/lib/portal/client-events.ts (derived presence, counts, SSE reconnection)
- frontend/src/lib/components/portal/AttentionCard.svelte (the *Needs you* banner)
- wrappers/cxx/internal/agentportal/command.go (`cxx portal status|notify|resolve|say|ask|wait|accept|leave`)
