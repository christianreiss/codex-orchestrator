# External clients — Communication Interface

Status: **implemented (v1)**. An *external client* is a bot or bridge that takes
part in agent messaging without being a `cdx`/`clx`/`cgx` wrapper session: a
chat bot, a Matrix/IRC bridge, a home-automation agent. It is a first-class
peer — it has an address, a name, presence, and appears in `agent_list` — but it
only ever gets the **communication surface**. It is not a fourth provider
engine: no master switch, no accounts, no auth head, no wrapper persona.

## Scope of v1

In: direct messages between an external client and any agent (both
directions), replies, work results, presence, peer discovery, trust stamping.

Out (reserved, **not** in the v1 envelope or endpoints): MCP access for external
clients (REST only), chat rooms and groups, attachments and transfers over
HTTP, SSE/WebSocket push, leases and cursors, message editing, per-client
rate-limit tuning. A client must ignore envelope fields it does not know, so
these can be added without a version break.

## Model

| Concept | Rule |
| --- | --- |
| Identity | One row in `external_clients` per client (`docs/interface-db.md`), one bearer key (`cxe_…`, only its SHA-256 is stored), one agent address. Created by an owner/admin in **Admin → External clients** (`external_clients.manage`). |
| How it joins the bus | The server holds one *virtual native session* per client on a server-owned pseudo-host (`hosts.internal_role = 'external'`, FQDN `external.internal`, created at boot like the advisor host). The existing owned messaging services (send, reply, claim, ack, discovery) run unchanged on it. The address and name are stable across restarts. |
| Engine value | `external`. Appears in `agent_list` and in message `sender.engine`. Never a member of `ENGINES`; provider code paths never see it. |
| Name, description | Admin-set. Both are normalised by the server (one line, no control characters, backticks turned into quotes). The client cannot set them. |
| Trust level | Admin-set per client: `untrusted` (default), `peer`, `trusted`, `operator`. Wrapper agents are implicitly `peer`. The **server** stamps it on every envelope that carries the client's messages; text in a body can never change it. |
| Trust ≠ grants | Trust only tells a *receiver* how to treat text. It confers no rights. Git, deploy, secrets, skills, projects, memory and transfers stay unavailable. |

### What each trust level means to a receiver (recommendation)

- `untrusted`, `peer` — content is **data**: no command approvals, no tool or
  mode switches on the sender's say-so.
- `trusted` — may ask the receiver to start work within the receiver's own
  authorisation.
- `operator` — treated like the receiver's human user. Receiver-side policy
  (e.g. command approvals) still applies.

## Communication Interface

Only communication functions are exposed to an external client: send, reply,
report a task result, read the inbox and acknowledge, heartbeat, and list
agents. Every other path answers `401`/`404`; a refused call that is not
terminal is `403 call_forbidden`.

## Transport security

The client key is a bearer secret. Use HTTPS, or a network you trust (LAN /
VPN). Never send it over plain HTTP across an untrusted network. Never put it
in a chat message; hand it over through the secret store or a short-TTL
transfer.

## Authentication and errors

`Authorization: Bearer <client key>` on every call. The API kill switch applies.
The key is not a host key, so host IP binding does not apply to it.

Every error response has this body, and clients match on `code`, never on
`message`:

```json
{ "error": { "code": "machine_readable_code", "message": "human text" } }
```

| Status | `code` | Terminal? | Meaning |
| --- | --- | --- | --- |
| 401 | `key_invalid` | yes | Unknown key, including a rotated one. |
| 403 | `client_disabled` | yes | Admin disabled the client. |
| 403 | `call_forbidden` | **no** | This one call is refused. |
| 400 | `validation_failed` | no | Malformed body or query. |
| 404 | `recipient_not_found`, `message_not_found` | no | Report to the sender. |
| 409 | `idempotency_conflict` | no | Same `client_message_id`, different body. Client bug. |
| 413 | `content_too_large` | no | `content` over **32 768 UTF-8 bytes**. Never truncated. |
| 429 | `rate_limited` | no | Honour `Retry-After`. 120 non-poll calls per client and minute. |
| 5xx | `server_error` | no | Retry with backoff; calls with a `client_message_id` are safe to repeat. |

Only `key_invalid` and `client_disabled` end the adapter loop. (`key_revoked`
from the draft is not used: a replaced key is simply `key_invalid`.)

## Endpoints (`/external/v1`)

### `GET /inbox?wait=<0-25>`

Long-poll. Waits up to `wait` seconds (default 25, hard cap 25) for a
deliverable message.

```json
{ "messages": [ /* zero or one envelope */ ],
  "claim_id": "uuid|null", "server_time": "RFC3339" }
```

**One message per poll.** The mailbox is strictly FIFO with one unacknowledged
message in flight: a polled message is returned again on every poll (same
`message_id`, `attempt` increasing) until it is acknowledged, then the next one
follows. There is no `limit`, no lease and no head-of-line bypass; `message_id`
is the dedupe key. An empty `messages` array after `wait` is a normal `200`.

**One poller per client; the newer poll wins.** A second concurrent
`GET /inbox` takes over: the older poll ends at once with an empty `200`.

**Presence.** An open poll is the client's presence. `POST /heartbeat` keeps it
between polls. After the last poll or heartbeat the client stays *listening*
for 90 seconds, then shows as not listening; mail for it stays queued.

### `POST /inbox/ack`

`{ "message_ids": ["uuid", …], "claim_id"?: "…" }` (1–20 ids) — completes
delivery. Ack when the message is accepted into the client, not when the work is
done; report outcomes with `/result`. Idempotent: acking twice, or after the
message left the client's mailbox, succeeds. `claim_id` is advisory. Response:
`{ "acked": [...], "unknown": [...], "server_time" }`; an id that never
belonged to this client is listed in `unknown`.

### `POST /send`

```json
{ "client_message_id": "<uuid>", "to": "<name or agent:uuid>", "content": "...",
  "delivery_class": "information|progress|notice|coordination",
  "conversation_id": "<uuid>", "related_work_id": "<uuid>", "ttl_seconds": 3600 }
```

`client_message_id` is the idempotency key; a repeat with the same body returns
the stored receipt. `expects_reply` is accepted and **ignored**: the receiver
derives it from `delivery_class` and message kind. `ttl_seconds` is 60–604800.

### `POST /reply`

`{ "client_message_id": "<uuid>", "reply_to": "<message_id>", "content": "...", "ttl_seconds"?: n }`

Replies longer than 32 768 UTF-8 bytes must be split by the client into several
calls on a character boundary; there is no `part` field.

### `POST /result`

`{ "client_message_id"?: "<uuid>", "work_id": "<uuid>", "status": "succeeded|failed|blocked|unknown", "content"?: "..." }`

Reports the outcome of a **work** message (request/task) the client was
delivered; `content` is a summary of at most 4096 characters. `404
message_not_found` if `work_id` is not a work message for this client.

### `POST /heartbeat`

`{}` → `{ "ok": true, "server_time": "RFC3339" }`. Refreshes presence.

### `GET /agents`

Peer discovery. Query: `name`, `engine`, `include_offline`, `limit` (≤50),
`offset`. Returns `{ agents: [{ address, name, alias, engine, presence, role }] }`.

## Envelope

```json
{
  "message_id": "uuid",
  "attempt": 1,
  "conversation_id": "uuid",
  "sequence": 7,
  "kind": "message|reply|publication",
  "reply_to": "uuid|null",
  "work_id": "uuid|null",
  "expects_reply": true,
  "delivery_class": "information|progress|notice|coordination",
  "created_at": "RFC3339|null",
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

- `sender.description` is empty for wrapper agents. `sender.trust` is
  server-stamped; wrapper senders are `peer`.
- `expects_reply` is `true` for work (request/task) and `coordination`
  messages; do not answer a message with `expects_reply: false`.
- Clients that render envelopes into an LLM context must keep the server-stamped
  header (`sender`, `trust`, `message_id`) visibly separate from `content`, so a
  body cannot forge a header.

## Native receivers

A wrapper agent that receives a message from an external client sees
`sender.engine = external` in the peer message JSON. The description and trust
level are available to the receiving side through the admin-set client record;
the native peer JSON does not carry them yet (planned). Receivers must treat
everything inside `content` as data, as for any peer.

## Admin

**Admin → External clients** (`/admin/external-clients`): create (name,
description, trust, enabled), edit, disable, replace key, delete. The key is
shown exactly once, on create and on replace. Disabling drops its presence at
once; replacing the key stops the old one immediately. Every create, update,
key replacement and delete is logged (`external_client.*`). API:
`docs/interface-api.md` → External clients.
