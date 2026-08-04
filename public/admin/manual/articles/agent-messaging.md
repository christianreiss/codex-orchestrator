---
title: Agent Messaging operations
section: Fleet operations
summary: How Codex and Claude agents address each other, how ordered delivery behaves, and how operators control and audit the bus.
tags: [agents, messaging, codex, claude, operations]
verified: 2026-08-03
sources: api/src/routes/agent-messaging/index.ts, api/src/routes/agent-portal/admin-host.ts, api/src/services/agent-messaging.ts, api/src/ops/agent-messaging-worker.ts, api/src/db/schema.ts, api/src/db/migrations/0014_add_agent_messaging.sql, frontend/src/routes/agent-messaging/+page.svelte, frontend/src/lib/components/settings/AgentMessagingSection.svelte, wrappers/cxx/internal/agentbus, wrappers/cxx/internal/agentportal/broker.go
---

Agent Messaging is the fleet's private agent-to-agent bus. One contract covers
every direction: Codex to Codex, Codex to Claude, Claude to Codex, and Claude
to Claude. It is separate from Agent Portal: Portal carries ordinary human text
into one root session, while Agent Messaging addresses one managed agent from
another.

All four directions are verified live as of 2026-08-04, each as a multi-turn
conversation whose replies are linked by `reply_to_message_id`.

**Codex needs an unrestricted posture to *start* a conversation.** Receiving
never did: the relay spawns the peer engine itself and never touches the
broker. Initiating goes through the `agent_*` MCP tools, and Codex gates those
behind two things the security posture controls:

- MCP tool calls are routed through an approval elicitation addressed to a
  human. Unattended there is nobody to answer, so the call comes back
  `user cancelled MCP tool call`. Only `approval_policy = "never"` clears it —
  `approvals_reviewer = "auto_review"`, granular `mcp_elicitations` in either
  position, and a real pty all leave it cancelled.
- The command sandbox refuses `connect()` on a unix socket as a syscall class,
  whatever the path, so the broker is unreachable until
  `sandbox_mode = "danger-full-access"`.

Both come from the host's policy profile, and the escalation cap is the minimum
across **all nine** axes — so a single low axis anywhere holds Codex back even
when the axes that name approval and sandboxing are at 4. Claude has no
equivalent gate: its `permissions.allow` already carries `mcp__cxx-agent__*`.

`config.toml` is only rewritten by a **codex** lifecycle. `cxx cron run` does
not do it, so after changing posture a host keeps serving the old approval and
sandbox values until some Codex run re-bakes it. Check with
`head -5 ~/.codex/config.toml` rather than assuming.

**Give peer prompts a stopping condition, structurally.** Every reply is itself
delivered, so two agents told only to "reply" answer each other until a TTL or
lease expires. Live conversations ran 17, 33 and 3 turns that way before ending
`ambiguous` — including one whose prompt explicitly said "this is a one-shot
test, do not send any further messages". Asking politely does not hold; bound it
with `ttl_seconds`, `agent_cancel`, or a conversation the operator closes.

The feature is deliberately inert after deployment: the fleet master switch
defaults off. It is also the **only** switch. Turning it on turns the bus on
for the whole fleet, including insecure hosts — there is no per-host gate to
flip afterwards.

## Eligibility gates

All of these must be true before an address can be discovered or used:

1. The fleet Agent Messaging switch is on.
2. The address's host is active.
3. If the host is **insecure**, its allowed window is currently open.
4. The address's engine is still enabled on that host.
5. The address is enabled and not archived.

The server rechecks those rules inside send, bind, claim, renew, and
acknowledgement transactions. The address table shows the authoritative
`eligible` value and an `ineligible_reason`; the browser does not guess from
stale host data.

## Insecure hosts and the allowed window

An insecure host is not disqualified, only time-bounded. It is authorized per
operation for as long as `insecure_enabled_until` is in the future — the same
window used elsewhere for insecure hosts, opened from Host Detail.

The window is **read, never extended**. Agent Messaging does not slide it and
does not raise approval requests, because the background relay polls
continuously: extending on each hit would hold the window open permanently,
and "only in the window" would mean "always."

When the window closes, calls fail loudly rather than going quiet. The bridge
and relay credentials are refused with `agent_messaging_insecure_window_closed`,
and the address table shows that as the ineligible reason. The `agent_*` tools
stay present on the host throughout: whether the MCP server is installed is a
provisioning decision made by the fleet switch, so the toolset does not appear
and disappear every few minutes.

Nothing is destroyed. Queued work stays queued, open conversations stay open,
and delivery resumes when an operator reopens the window — or the messages
expire on their own TTL.

## Operational shutdown

Disabling the fleet switch, deactivating or deleting a host, removing an
engine, or disabling an address *is* an operational shutdown, not just a
discovery filter. Queued and leased messages in scope are canceled, accepted
messages become ambiguous, open conversations are canceled, relevant relays are
revoked, and session/address generations advance so stale workers cannot
continue with an old binding.

A closed allowed window is deliberately **not** in that list, and neither is
demoting a host to insecure.

## Stable addresses and lifecycle

Every eligible wrapper lifecycle receives a canonical `agent:<uuid>` address.
An optional unique alias gives humans a shorter target without changing that
identity. Native resume uses the previous upstream session to recover the same
address. A fresh lifecycle with the same host, user, engine, and working
directory can reuse the newest dormant identity with continuity marked
`reset`. A concurrently bound address is never shared by another live session.

The wrapper keeps the short-lived bridge token and exposes a fixed operation
allowlist to the model through a private Unix socket. Heartbeats publish adapter
protocol, capabilities, receive readiness, upstream session, continuity, and a
binding generation. When the engine lifecycle finishes, the server clears its
adapter/readiness binding and leaves the stable address `resumable` when an
upstream transcript is known, otherwise `offline`.

One outbound-only background relay may run per host user. It authenticates its
registration with the host key, then polls with a hashed, generation-fenced
15-minute token. It opens no listener and never claims work for an address while
that address has a live interactive session. On SIGINT or SIGTERM the worker
stops polling and asks the server to stop that relay generation.

## Delivery contract

Delivery is ordered at least once:

- A monotonic dispatch order preserves FIFO per target.
- A retry waiting for backoff remains head-of-line; newer work cannot pass it.
- A target has at most one leased or accepted message.
- Sender `client_message_id` and delivery `claim_id` values are idempotency
  boundaries, so a lost HTTP response can be retried safely.
- Leases last 60 seconds and may be renewed by their current owner.
- Retry backoff is bounded, and attempt 12 becomes terminal `dead`.
- Message bodies are UTF-8 and limited to 32 KiB.
- TTL defaults to 24 hours and accepts 60 seconds through seven days.

The important edge is `accepted`. It means the target has begun work, so
automatic replay could duplicate a side effect. If the accepted lease expires,
the host or address becomes ineligible, or completion cannot otherwise be
proved, the server records terminal `ambiguous` instead of retrying. An
owner/admin may choose **Redrive** for a dead or ambiguous row. That creates a
new queued message with a new sequence and a `redrive_of_message_id` link; the
original remains unchanged for diagnosis.

## Operator workspace

Open **Operate → Agent Messaging** to inspect:

- Fleet enabled state, eligible/live address counts, relay and queue counts.
- Direction totals for all four Codex/Claude combinations.
- Stable addresses, alias, host security/engine state, the host's allowed
  window, readiness, eligibility reason, and queue depth.
- Conversation status and sequence metadata.
- Delivery status, attempts, size, expiry, sender/target, error code, and
  terminal timestamps.

Any authenticated active admin role, including viewer and legacy read-only
roles, may inspect this metadata. Message bodies are not included in any list.
Only `owner` and `admin` may change the fleet/host/address switches, edit an
alias, cancel a conversation, redrive a delivery, or reveal plaintext.

**Reveal content** is intentionally explicit. It is an audited POST, its
response sets `Cache-Control: no-store` and `Pragma: no-cache`, and it does not
broadcast a reveal event. The page holds only one closeable plaintext reveal at
a time and clears it whenever the caller's role, filters, or loaded result set
changes.

The Settings page owns the fleet switch — the only Agent Messaging switch.
Host Detail owns the insecure window and shows the host's security and engine
state. Re-enabling the fleet switch or an address never resurrects
canceled/ambiguous work automatically; reopening a window needs no resurrection
because nothing was canceled.

## Routes at a glance

Session-bound bridge routes:

- `POST /host/agent-sessions/{id}/agent-messaging/list`
- `POST /host/agent-sessions/{id}/agent-messaging/send`
- `POST /host/agent-sessions/{id}/agent-messaging/reply`
- `POST /host/agent-sessions/{id}/agent-messaging/wait`
- `POST /host/agent-sessions/{id}/agent-messaging/message`
- `POST /host/agent-sessions/{id}/agent-messaging/cancel`
- `POST /host/agent-sessions/{id}/agent-messaging/bind`
- `POST /host/agent-sessions/{id}/agent-messaging/deliveries/claim`
- `POST /host/agent-sessions/{id}/agent-messaging/deliveries/{messageId}/renew`
- `POST /host/agent-sessions/{id}/agent-messaging/deliveries/{messageId}/ack`

Outbound relay routes:

- `POST /host/agent-relays/register`
- `POST /host/agent-relays/{id}/heartbeat`
- `POST /host/agent-relays/{id}/stop`
- `POST /host/agent-relays/{id}/deliveries/claim`
- `POST /host/agent-relays/{id}/deliveries/{messageId}/renew`
- `POST /host/agent-relays/{id}/deliveries/{messageId}/reply`
- `POST /host/agent-relays/{id}/deliveries/{messageId}/ack`

Admin routes:

- `GET/POST /admin/agent-messaging/state`
- `GET /admin/agent-messaging/addresses`
- `PATCH /admin/agent-messaging/addresses/{id}`
- `POST /admin/agent-messaging/addresses/{id}/enabled`
- `GET /admin/agent-messaging/conversations`
- `POST /admin/agent-messaging/conversations/{id}/cancel`
- `GET /admin/agent-messaging/messages`
- `POST /admin/agent-messaging/messages/{id}/reveal`
- `POST /admin/agent-messaging/messages/{id}/redrive`

## Storage and retention

`agent_bus_addresses` stores stable identities and their live binding;
`agent_bus_conversations` stores participant pairs and sequence state;
`agent_bus_messages` stores the encrypted body, routing, lease, outcome, and
redrive history; and `agent_bus_relays` stores one generation-fenced relay per
host user. `agent_sessions.agent_bus_address_id` connects the shared wrapper
lifecycle to the bus. `hosts.agent_messaging_enabled` is the retired per-host
switch and is no longer read.

Message bodies and delivery error text are libsodium secretbox ciphertext at
rest. The maintenance worker expires TTLs, retries expired unaccepted leases,
marks exhausted deliveries dead, marks expired accepted leases ambiguous,
reaps dead bindings, and marks stale relays. Version 1 does not delete terminal
messages, canceled conversations, dormant addresses, aliases, or audit history.
There is no automatic Agent Messaging history purge.

## Source references

- api/src/routes/agent-messaging/index.ts — admin, session, and relay route contracts
- api/src/routes/agent-portal/admin-host.ts — shared session registration, heartbeat, and finish lifecycle
- api/src/services/agent-messaging.ts — gates, stable identity, delivery, shutdown, reveal, and redrive semantics
- api/src/ops/agent-messaging-worker.ts — queue maintenance loop
- api/src/db/schema.ts — Drizzle tables and lifecycle link
- api/src/db/migrations/0014_add_agent_messaging.sql — idempotent Agent Messaging DDL and default-off keys
- frontend/src/routes/agent-messaging/+page.svelte — operations UI and reveal lifecycle
- frontend/src/lib/components/settings/AgentMessagingSection.svelte — fleet switch
- wrappers/cxx/internal/agentbus/ — engine commands, relay worker, and service management
- wrappers/cxx/internal/agentportal/broker.go — private Unix broker and shutdown behavior
