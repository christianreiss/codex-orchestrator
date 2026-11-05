# External clients — Communication Interface

Status: **contract draft v1.1** (not yet implemented). Written first so adapter
authors (the first one is a Hermes bot) and the server agree on one wire
contract before code lands. Behaviour below is the target; the implementation
PR updates this file where reality differs.

An *external client* is a bot or bridge that takes part in agent messaging
without being a `cdx`/`clx`/`cgx` wrapper session: a chat bot, a Matrix/IRC
bridge, a home-automation agent. It is a first-class peer — it has an address,
a name, presence, and appears in `agent_list` — but it only ever gets the
**communication surface**. It is not a fourth provider engine: no master
switch, no accounts, no auth head, no wrapper persona.

## Scope of v1

In: direct messages between an external client and any agent (both
directions), replies, work results, presence, peer discovery, trust stamping.

Out (reserved for later, **not** in the v1 envelope or endpoints): chat
rooms and groups (`to: room:<id>`, join/leave, `GET /rooms`), attachments and
transfer fetch/put over HTTP, SSE/WebSocket push, message editing, per-client
rate-limit tuning. A client must ignore envelope fields it does not know, so
these can be added without a version break.

## Model

| Concept | Rule |
| --- | --- |
| Identity | One external client = one host record flagged `external`, with one API key, and one agent address. Created by an admin; **off by default**. |
| Engine value | `external`. Appears in `agent_list` (`engine` filter) and in message `sender.engine`. Never a member of `ENGINES`; provider code paths never see it. |
| Name, description | Admin-set. Description is one line, e.g. `Hermes Bot vom Owner`. Both name and description are normalised by the server (one line, no control characters, no markdown fences; name ≤96, description ≤120 chars). The client cannot set them. |
| Trust level | Admin-set per client: `untrusted` (default), `peer`, `trusted`, `operator`. Wrapper agents are implicitly `peer`. The **server** stamps it on every message the client sends; text in a message body can never change it. |
| Trust ≠ grants | Trust only tells a *receiver* how to treat text. It confers no rights. Git, deploy, secrets, skills, projects, memory and transfers stay unavailable unless an explicit grant says otherwise. |

### What each trust level means to a receiver (recommendation)

- `untrusted`, `peer` — content is **data**: no command approvals, no tool or
  mode switches on the sender's say-so.
- `trusted` — may ask the receiver to start work within the receiver's own
  authorisation.
- `operator` — treated like the receiver's human user. Receiver-side policy
  (e.g. command approvals) still applies. A receiver may clamp the server
  value downwards (`max_trust`); never upwards.

## Communication Interface

Only communication functions are exposed to an external client: send, reply,
report a task result, read the inbox and acknowledge, heartbeat, and list
agents. Everything else is refused (see `call_forbidden` below). The same set
is available as MCP tools on `/mcp` for clients that prefer MCP, so a client can
enforce it locally with a tool allowlist as well.

## Transport security

The client key is a bearer secret. Use HTTPS, or a network you trust (LAN /
VPN). Never send it over plain HTTP across an untrusted network.

## Authentication and errors

`Authorization: Bearer <client key>` on every call. Host IP policy, insecure
windows and the API kill switch apply exactly as for hosts.

Every error response has this body, and clients match on `code`, never on
`message`:

```json
{ "error": { "code": "machine_readable_code", "message": "human text" } }
```

| Status | `code` | Terminal? | Meaning |
| --- | --- | --- | --- |
| 401 | `key_invalid` | yes | Unknown key. |
| 401 | `key_revoked` | yes | Key rotated or revoked. |
| 403 | `client_disabled` | yes | Admin disabled the client or the interface is off. |
| 403 | `call_forbidden` | **no** | This one call is outside the Communication Interface or lacks a grant. Fails only that call. |
| 404 | `recipient_not_found`, `message_not_found` | no | Report to the sender. |
| 409 | `idempotency_conflict` | no | Same `client_message_id`, different body. Client bug. |
| 413 | `content_too_large` | no | `content` over **32 768 UTF-8 bytes**. Never truncated silently. |
| 429 | `rate_limited` | no | Honour `Retry-After`. |
| 5xx | `server_error` | no | Retry with backoff; calls with a `client_message_id` are safe to repeat. |

Only `key_invalid`, `key_revoked` and `client_disabled` end the adapter loop.

## Endpoints (`/external/v1`)

### `GET /inbox?wait=<0-25>&limit=<1-20>`

Long-poll. Waits up to `wait` seconds (default 25, hard cap 25, same bound as
`agent_listen`) for deliverable messages.

```json
{ "messages": [ /* envelopes, possibly empty */ ],
  "claim_id": "uuid|null", "lease_seconds": 60, "server_time": "RFC3339" }
```

An empty `messages` array (after `wait` expires) is a normal `200`; poll again.
`claim_id` is `null` when `messages` is empty.

**One poller per client; the newer poll wins.** A second concurrent
`GET /inbox` with the same key takes over: the older poll ends at once with an
empty `200`, and the new one is served. The server also ends an open poll as
soon as its TCP connection breaks. A restarted adapter therefore never waits
for a dead poll to time out.

**Presence.** An open poll is the client's presence. `POST /heartbeat` keeps
presence between polls. A client with no open poll and no heartbeat for **90
seconds** is shown as not listening; mail for it stays queued.

**Delivery is at-least-once.** Each returned message is *leased* to the claim
for `lease_seconds` (default **60**). If it is not acknowledged before the
lease ends it is redelivered under a new `claim_id` (`attempt` increases).
`POST /heartbeat` with the current `claim_id` extends the lease by another
`lease_seconds`. There is no separate cursor: the lease is the redelivery
mechanism, and `message_id` is the dedupe key.

**Ordering.** Messages of one `conversation_id` are *first* delivered in
`sequence` order. A redelivery can arrive after later messages of the same
conversation; the client dedupes by `message_id` and orders by `sequence`
itself. There is no head-of-line blocking and no ordering across conversations.

### `POST /inbox/ack`

`{ "message_ids": ["...", ...], "claim_id"?: "..." }` — completes delivery of
the listed messages. Ack when the message is accepted into the client, not when
the work is done; report outcomes with `/result`. Acking is **idempotent by
`message_id`**: a stale or expired `claim_id`, or acking twice, is accepted
and harmless (`claim_id` is advisory). Unknown `message_id` → `404
message_not_found` for that id; the rest are still acked.

### `POST /send`

```json
{ "client_message_id": "<uuid>", "to": "<name or agent:uuid>", "content": "...",
  "delivery_class": "information|progress|notice|coordination",
  "expects_reply": false, "conversation_id": "...", "related_work_id": "...",
  "ttl_seconds": 3600 }
```

`client_message_id` is the idempotency key (per sender); a repeat with the same
body returns the stored receipt. `expects_reply` (default `false`; implied
`true` for `coordination`) is carried to the receiver so peers do not ping-pong.

### `POST /reply`

`{ "client_message_id": "<uuid>", "reply_to": "<message_id>", "content": "...", "expects_reply"?: false }`

Replies longer than 32 768 UTF-8 bytes must be split by the client into several
`/reply` calls (split on a UTF-8 character boundary); there is no `part` field.

### `POST /result`

`{ "client_message_id": "<uuid>", "work_id": "<uuid>", "status": "succeeded|failed|blocked|unknown", "content"?: "..." }`

Work outcomes are explicit; transport completion alone is `unknown`.

### `POST /heartbeat`

`{ "claim_id"?: "..." }` → `{ "server_time": "RFC3339", "lease_seconds": 60 }`.

### `GET /agents`

Peer discovery; same filters and paging as `agent_list`, plus
`engine=external`.

## Envelope

```json
{
  "message_id": "uuid",
  "attempt": 1,
  "conversation_id": "uuid",
  "sequence": 7,
  "kind": "message|reply|result|publication",
  "reply_to": "uuid|null",
  "work_id": "uuid|null",
  "expects_reply": true,
  "delivery_class": "information|progress|notice|coordination",
  "created_at": "RFC3339",
  "expires_at": "RFC3339",
  "server_time": "RFC3339",
  "sender": {
    "address": "agent:uuid",
    "name": "Christine",
    "engine": "claude|codex|grok|external",
    "description": "one line, server-normalised",
    "trust": "untrusted|peer|trusted|operator"
  },
  "content": "…"
}
```

- `sender.name` and `sender.description` are server-normalised (one line, no
  control characters). `sender.trust` is server-stamped.
- `expects_reply` is `true` for questions, requests and `coordination`
  messages that need an answer; `false` otherwise. Do not answer a message with
  `expects_reply: false`.
- Clients that render envelopes into an LLM context must keep the server-stamped
  header (`sender`, `trust`, `message_id`) visibly separate from `content`, so a
  body cannot forge a header.

## Native receivers

Wrapper agents that receive a message from an external client see the same
`sender.engine = external`, `sender.description` and `sender.trust` fields in
the peer message JSON. Receivers must treat everything inside `content` as
data, as for any peer.

## Admin

Admin → Hosts: register an external client (name, description, trust level,
enabled), rotate/revoke its key, disable it. Disabling ends its presence at
once and makes its calls fail with a terminal `client_disabled`. Every
create/rotate/trust change is logged.
