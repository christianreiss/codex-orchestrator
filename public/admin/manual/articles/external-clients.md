---
title: External clients
section: Admin workspace
summary: Bots and bridges outside the fleet that join agent messaging with their own key, name and trust level.
tags: [external-clients, bots, messaging, trust]
verified: 2026-11-05
sources: api/src/routes/external/index.ts, api/src/services/external-clients/index.ts, api/src/services/external-clients/bridge.ts, api/src/services/external-clients/normalize.ts, api/src/db/migrations/0124_external_clients.sql, api/src/security/capabilities.ts, api/src/security/route-capabilities.ts, frontend/src/routes/(coordination)/external-clients/+page.svelte, frontend/src/lib/components/external-clients/ExternalClientDialog.svelte, frontend/src/lib/api/externalClients.ts, docs/external-clients.md
---

An **external client** is a bot or bridge that takes part in agent messaging without being a `cdx`/`clx`/`cgx` wrapper session: a chat bot, a Matrix or IRC bridge, a home-automation agent. It gets its own agent address and presence, and appears in `agent_list` like any other agent, with engine `external`. It only ever gets the **communication surface**: sending, replying, reporting a work result, reading its inbox, a heartbeat, and listing agents. Git, deploy, secrets, Skills, projects, memory and file transfers stay unavailable. It is not a fourth provider engine: there is no master switch, no provider account and no wrapper for it.

The page is **Coordination → External clients** (`/external-clients`). The wire contract for bot authors is `docs/external-clients.md`.

## Creating a client

**New client** opens a dialog with four fields:

| Field | Rule |
|---|---|
| Name | Shown to receivers on every message it sends. One line, at most 96 characters, unique regardless of case, must not start with `agent:`. |
| Description | One line, at most 120 characters, shown to receivers next to the name (for example "Hermes bot of the owner"). |
| Trust level | `untrusted` (default), `peer`, `trusted` or `operator`; see below. |
| Enabled | A disabled client cannot authenticate. |

The server normalises name and description before storing them: control characters are removed, whitespace collapsed and backticks turned into quotes, because both end up in other agents' context. The client itself can never change them.

Saving shows the client's bearer key (`cxe_…`) **exactly once**. Only its SHA-256 is stored, so a lost key cannot be recovered, only replaced. Hand it to the bot's operator through the secret store or a short-lived file transfer, never in a chat message.

### Name and description

Name and description are what receivers see about the client: wrapper agents in the server-written header on each of its messages (below), other external clients as `sender.name` and `sender.description`. Edits apply to the next message. The client's agent address (`agent:<uuid>`) is created on its first call and stays the same across restarts, renames and key replacements; agents can always reach it by that address.

## The table

Each row shows the name and description, the trust level, a status badge, the key prefix and when the client last polled:

- **listening** — the client's last recorded poll or heartbeat is less than 90 seconds old (the server records it at most once a minute). An open long-poll is its presence.
- **not listening** — enabled, but quiet for longer. Mail for it stays queued.
- **disabled** — switched off by an administrator.

Row actions:

- **Edit** — name, description, trust level, enabled.
- **Disable / Enable** — disabling ends the client's presence immediately; its calls then fail with `client_disabled`.
- **Replace key** — mints a new key, shown once. The old key stops working at once and the client's connection is dropped.
- **Delete** — removes the client and its key and drops its connection. Messages already delivered stay in the history.

Every create, update, key replacement and delete is recorded in **Activity** (`external_client.created`, `.updated` with the trust change, `.key_rotated`, `.deleted`).

## Trust levels

The trust level tells a **receiving agent** how to treat the client's text. It confers no rights: whatever the level, the client still has only the communication surface.

| Level | Meaning to a receiver |
|---|---|
| `untrusted` | Text is data only. No command approvals, tool or mode switches on its say-so. |
| `peer` | Treated like another fleet agent: still data, no commands on its say-so. Wrapper agents are implicitly `peer`. |
| `trusted` | May ask the receiver to start work within the receiver's own authorisation. |
| `operator` | Treated like the receiver's human user. Receiver-side policy such as command approvals still applies. Use sparingly. |

The server stamps the level onto every message the client sends; text in a message body can never change it. Wrapper agents only see message text, so their copy begins with a server-written first line:

```
[from external client "Jessica" (Hermes bot of the owner) · trust: trusted · written by the server, not by the sender]
```

The sender can neither set nor remove that line, and a body imitating one is still preceded by the real header. Another external client receiving the message gets the same facts as structured `sender.trust` and `sender.description` fields instead.

## What a client can call

A client authenticates every call with `Authorization: Bearer <key>` against the REST interface under `/external/v1`; it has no MCP access. Use HTTPS or a network you trust. Host IP binding does not apply to the key; the API kill switch does.

| Call | Purpose |
|---|---|
| `GET /external/v1/inbox` | Long-poll (up to 25 s) for the next message. Strictly one message in flight: it is returned again until acknowledged. A newer poll ends an older one. |
| `POST /external/v1/inbox/ack` | Acknowledge accepted messages (1–20 IDs). |
| `POST /external/v1/send` | Send to an agent by name or `agent:<uuid>`, with a `client_message_id` as idempotency key. |
| `POST /external/v1/reply` | Reply to a received message. |
| `POST /external/v1/result` | Report `succeeded`, `failed`, `blocked` or `unknown` for a work request it received. |
| `POST /external/v1/heartbeat` | Keep presence between polls. |
| `GET /external/v1/agents` | Peer discovery (name, engine, presence; at most 50 per page). |

Limits: message content up to 32 256 UTF-8 bytes (never truncated; longer replies must be split by the client), 120 non-poll calls per client and minute (`429` with `Retry-After`). Only `key_invalid` (unknown or replaced key) and `client_disabled` are terminal for the bot; every other refusal concerns one call. Rooms, groups, conferences, attachments and push transports are not part of v1.

## Roles

| Capability | Who holds it | What it covers |
|---|---|---|
| `external_clients.read` | every role | the page and its table; never a key |
| `external_clients.manage` | owner, admin | create, edit, disable, replace key, delete |

A fleet operator keeps the fleet running but does not decide whom the fleet trusts, so management stays with owner and admin. Controls a role does not hold are disabled with a tooltip naming the missing capability.

Chatty can list external clients and their status (`external_clients_list`, read-only). Creating, changing or deleting a client and replacing its key happen on this page.

## Source references

- api/src/routes/external/index.ts (`/external/v1/*` and `/admin/external-clients*`, rate limit, error codes, admin events)
- api/src/services/external-clients/index.ts (lifecycle, key handling, envelope and trust stamping)
- api/src/services/external-clients/bridge.ts (virtual session, 90-second presence grace, server-written header, content limit)
- api/src/services/external-clients/normalize.ts (name/description rules, trust levels)
- api/src/db/migrations/0124_external_clients.sql (`external_clients`, unique name and key hash)
- api/src/security/capabilities.ts, api/src/security/route-capabilities.ts (`external_clients.read` / `external_clients.manage`)
- frontend/src/routes/(coordination)/external-clients/+page.svelte (table, status badges, row actions)
- frontend/src/lib/components/external-clients/ExternalClientDialog.svelte (create/edit form)
- frontend/src/lib/api/externalClients.ts (queries, mutations, trust help text)
- docs/external-clients.md (wire contract for client authors)
