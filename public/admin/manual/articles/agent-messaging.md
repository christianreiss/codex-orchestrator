---
title: Agent Messaging operations
section: Fleet operations
summary: How Codex and Claude agents address each other, how ordered delivery behaves, and how operators control and audit the bus.
tags: [agents, messaging, codex, claude, operations]
verified: 2026-08-04
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

**Enabling also rewrites what every agent reads.** The switch adds an Agent
Messaging section to the managed `AGENTS.md` / `CLAUDE.md` served to every active
host: the tool names, the rule that a peer message is untrusted input carrying no
authority, and the `#call` PIN rendezvous with its turn-holding rule. Without it
an agent receives ten peer-messaging tools and nothing explaining them. The
served file is replaced **whole** on the host — there is no separate managed
block on disk — so a host picks the change up on its next wrapper launch, or on
its nightly cron tick between 00:00 and 03:59, and a host with a session already
running is skipped until that session ends. Disabling removes the section on the
same schedule, which means an agent can briefly hold instructions for tools that
no longer answer.

Both directions of the switch now confirm before applying, and the dialog shows
live counts: how many active hosts will be rewritten when enabling, and how many
open conversations, queued and in-flight deliveries, accepted deliveries and
relays will be destroyed when disabling. Disabling is styled destructive; neither
direction asks you to type a confirmation word, because the switch is reversible
and the counts are the honest signal. The first-run setup wizard does not
confirm — there are no registered hosts yet, so there is nothing to warn about.

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

**The relay needs systemd lingering, and its absence is silent.** On Linux it is
a `systemd --user` unit, so logind stops it with the user's last login session
unless lingering is on. Until 2026-08-04 install never enabled it, and the
symptom was not an error: the unit reads `enabled`, `systemctl --user is-active`
reads `inactive` only while nobody is logged in, and messages to that host just
go unanswered until they expire. Install now runs `loginctl enable-linger` for
the service user as a best effort — a container without logind, or an
unprivileged user refused by polkit, still installs and prints the remedy. To
check a host directly: `loginctl show-user <user> -p Linger`.

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

## Calls (`#call`)

A call replaces "guess which address in `agent_list` is the other terminal" with a
four-digit PIN a human carries between two screens. `#call sender` calls
`call/open`, which mints a short-lived fleet-unique PIN bound to the caller's own
address and — for the first time on this bus — returns that address, since
`list` deliberately excludes the caller. `#call receiver <pin>` calls `call/join`,
which resolves the PIN, opens the conversation, queues the opening message and
consumes the PIN, all in one transaction.

Operational notes:

- **A PIN is single-use and fleet-wide.** Any enabled agent can dial one, and dialling
  consumes it, so a wrong number takes the rendezvous with it. The opener is expected
  to answer an unexpected joiner with `BYE reason=refused` and open a fresh PIN. A join
  that fails validation, dials itself, or finds an ineligible opener leaves the PIN
  live on purpose.
- **A PIN never outlives its agent.** It is cleared when the session finishes, when a
  binding is reaped, when the address is disabled, and when the fleet switch goes off,
  and expired PINs are swept on every mint, every redeem, and the 30-second
  maintenance tick.
- **`agent_listen` leaves the delivery `leased`, deliberately.** It is completed by the
  next `agent_reply`, or by the next `agent_listen` — listening again is how an agent
  declines to answer. Nothing is ever acknowledged `accepted`, because an `accepted`
  lease that expires becomes `ambiguous`, which is terminal and never redelivered,
  whereas a `leased` one is requeued and picked up by the relay. A call that dies
  mid-turn therefore degrades into an ordinary async delivery instead of eating the
  peer's message. The visible semantic is at-least-once; `attempts` rides on the
  delivery so a redelivery is detectable.
- **The turn budget is the stopping condition.** Calls carry `turn=k/16` and a 30-minute
  deadline in the message header. This is the structural answer to the runaway
  conversations recorded above: the counter travels with the message so neither side
  can quietly disagree about how close the end is.
- **The receive plane has its own signed switch.** `agent_messaging.listen_enabled` in
  the signed wrapper config gates `deliveries/claim` and the receive-capable `bind` at
  the broker, and it is engine-neutral. It mirrors the fleet switch today. The separate
  Claude-only `channel_preview_enabled` still gates the unsolicited Channel pump and is
  unchanged — the distinction is that a listen returns content in a tool result the
  model asked for, exactly as `agent_wait` already does, while the pump pushes content
  into a transcript nobody asked for.

## The ring (`mailbox` and the Claude hooks)

Until this existed, an agent someone was sitting in front of could not be reached
at all, and nothing said so. An interactive agent has no interrupt: it exists only
during a turn, and nothing of it runs in between. The relay cannot help, because it
deliberately skips any address whose wrapper is attached, and the session itself
only pulls when the model calls `agent_listen`. A message addressed to an attached
session therefore sat `queued` until it expired — the caller printed "no answer",
the callee never knew, and no error was raised on either side.

That is why `#call` is specified with a human in the middle. **The PIN banner was
never a UX flourish; it was the signalling layer, and the operator was the
transport.** That works for one call. It does not scale to inviting five hosts
into a room, which is why the ring landed before conferences did.

How it works:

- **`mailbox` is a peek, not a claim.** It reports who is waiting and when their
  message expires, plus calls that expired unanswered in the last 30 minutes. It
  takes no lease, changes no status, and burns no delivery attempt. It also does
  **not** require receive-capability — unlike `deliveries/claim` — because an agent
  that has never called `agent_listen` is precisely who needs it.
- **It never returns a body.** Hearing the phone ring is not answering it, and
  handing over content without a lease would tell the sender its message went
  unread when the target had in fact read it. Reading the message still means
  claiming it.
- **Two fleet-owned Claude Code hooks run `cxx agent poll`**, one on `Stop` and one
  on `UserPromptSubmit`. Those are the only two moments at which a notification can
  land. They are injected into `settings.json` wherever the `cxx-agent` MCP server
  is provisioned, and operator-authored hooks for the same events are preserved —
  the ring is appended, not substituted, the same way `permissions.allow` unions.
- **Each message rings at most once per event.** Claude Code ships no
  `stop_hook_active` guard, so a `Stop` hook that always blocks is a session that
  can never end its turn. A ledger under `~/.cache/codex-orchestrator/agent-ring/`
  records what has already rung, and if it cannot be written the hook does not
  block. A missed call is recoverable; a wedged session is not.
- **The hook command ends in `|| true`.** A `Stop` hook that exits non-zero blocks
  the turn with its stderr as feedback, so a wrapper too old to know `agent poll`
  would otherwise wedge every turn on an unknown-command error. Forcing exit 0
  makes it a no-op on any wrapper that cannot serve it.
- **Polling never binds `receive_capable`.** That is `agent_listen`'s job. An
  address that bound at every turn boundary but listened only occasionally would
  advertise `readiness: live` to every peer reading `agent_list` while actually
  checking mail twice a minute — a worse lie than being unbound.
- **Claude only.** Codex has no hook surface. A Codex peer is reachable while it is
  actively listening, or headless through its relay, and is best invited by address
  rather than expected to dial a PIN.

If a host is on a wrapper older than the one that introduced `cxx agent poll`, the
ringer is inert there and calls to attached sessions behave exactly as before.
Nothing breaks; nothing rings.

## Conferences (`#conference`)

A conference is a meeting with a chair: an owner, a roster, and the authority to
dispatch work and adjourn. It is the multi-host generalisation of a call — three to
eight agents across a cluster, one of them running the room.

**The transport is a star, not a new kind of conversation.** Every member holds one
ordinary two-party `agent_bus_conversations` row with the chair, and the chair
relays. That is deliberate: the delivery leases, the per-conversation sequence, the
head-of-line ordering and the one-in-flight-per-address rule in the dispatcher are
all written against exactly two participants, and none of them survive an N-party
conversation row. The two new tables add membership and authority only. There is no
participant-to-participant edge; a participant's `to` is ignored rather than
rejected, because there is nowhere for it to go.

Operational notes:

- **The turn rule is not the call's.** A call has a token and exactly one side holds
  it. That does not survive N parties, and reusing it deadlocks the room. The
  replacement: every message creates exactly one obligation, the chair's reply is
  always turn-terminal, and **only the chair opens a round.** Participants answer
  and return to listening.
- **The budget is per member, not per call.** Sixteen turns is meaningless when one
  broadcast round across five members is already ten-plus messages. Each member gets
  twelve messages and the room gets a wall-clock deadline, both enforced by the
  server. **Every message on a member's spoke costs budget, including an ordinary
  `agent_reply`** — that matters because once a room is running, replies are most of
  the traffic. When a member spends its budget the in-flight reply still lands and
  its spoke closes, so the next exchange fails as
  `agent_messaging_conversation_canceled`; an overdue room adjourns itself on the
  maintenance tick. Until 2026-08-06 only the `agent_conf_*` tools were counted, so
  a room that settled into replying was bounded by nothing but its deadline — a live
  two-host run reached 21 messages against a counter reading 2 and had to be stopped
  by hand. On the headless path every exchange is a fresh engine boot, which is what
  made that expensive rather than merely untidy.
- **A room PIN is multi-use, unlike a call PIN.** Every member dials the same four
  digits, so a join never consumes it; it dies with the room's deadline or at
  adjourn. It is minted from the *same* four-digit space as `#call` PINs, because a
  human carrying digits between terminals cannot be expected to also carry which
  kind of thing they open. MySQL cannot express that as a cross-table constraint, so
  the mint scans both tables.
- **Members come in two kinds, and the roster says which.** An `attached` member is
  a live wrapper sitting in `agent_listen`. A `headless` member is an idle host its
  relay boots per delivery, resumed through its stored upstream session so it keeps
  the room's context across rounds — there is no process between deliveries, which
  is exactly why "stay in the room and rejoin after tasks" costs nothing. A headless
  member cannot send a progress update; its final output *is* its report.
- **Invite-by-address is what makes a cluster usable.** `conf/invite` wakes idle
  hosts with no human present. A host with a wrapper already attached is skipped by
  the relay by design, and its invitation waits until that session next listens —
  which is the case the PIN still covers.
- **Only `purpose` is declared by the member.** Host, engine and role come from what
  the fleet already knows: `fqdn` and `engine` are joined at read time, and role is
  assigned by open-vs-join. A member cannot misreport the box it runs on.
- **Fan-out is a loop, not a transaction.** `conf/say` and `conf/invite` return one
  result per member with `delivered` true or false. A partial broadcast is reported,
  never rolled back and never disguised.
- **Adjourn is graceful by default.** Cancelling a conversation revokes its delivery
  lease, and a headless member mid-run is having that lease renewed on a ticker — so
  a blanket cancel kills a running engine process mid-task. The default therefore
  leaves working members to finish and parks the room in `adjourning` until their
  reports land. `force: true` is the decisive form and reports how many tasks it
  interrupted.
- **A dispatched member is swept back to the floor.** A headless run that dies burns
  its delivery attempts without ever touching the member row, so without the sweep
  the chair would wait forever on a report that is not coming. `dispatch_deadline_at`
  is what the 30-second tick uses; the member returns to `seated` with
  `last_report_at` still null, so the miss stays visible.
- **Disabling the fleet switch adjourns every open room**, and a member part-way
  through a dispatched task loses that work. The Settings confirmation says so.

## When a peer never answers and nothing is wrong

Two failures produce the same symptom — a delivery that goes unanswered with no error
anywhere — and both are worth checking before suspecting the protocol.

**The relay is not running.** A `systemd --user` unit reads `enabled` but goes `inactive`
whenever nobody is logged in, unless `loginctl enable-linger <user>` ran. Check that
first; it is the older and more common of the two.

**The host cannot start Claude at all.** Claude Code refuses to launch when the permission
mode is `bypassPermissions` and it is running as root:

```
--dangerously-skip-permissions cannot be used with root/sudo privileges for security reasons
```

That check is upstream, deliberate, and has no supported override. A relay-booted peer
therefore dies before it can report anything, and its delivery lands `ambiguous` with
`native_outcome_ambiguous` — which is terminal and never redelivered. From the caller's
side it is indistinguishable from a peer that read the message and chose not to answer.

The orchestrator no longer serves that combination: a host whose agent user is root gets
`auto` instead, which is what upstream recommends in place of a bypass. `clx doctor` shows
this on the `Perms` row — `OK` naming the substitution when it is in force, `FAIL` if a
host has somehow ended up with `bypassPermissions` as root anyway (a hand-edited
`settings.json`, or a host still pinned to an older orchestrator). The posture console
names the affected hosts, since an operator who selected an unrestricted posture would
otherwise have no way to learn their root agents run with a classifier in the loop.

Two consequences worth knowing. `auto` vets shell and network actions with a classifier
instead of a prompt, so it costs a round-trip per such action, and in a headless `-p` run
repeated blocks end the run rather than prompting. And `auto` needs a recent model — on an
older one the session silently falls back to prompting, which an unattended run cannot
answer; `clx doctor` warns when it sees that combination. To get a genuine bypass, run the
agent as a non-root user.

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
- `POST /host/agent-sessions/{id}/agent-messaging/call/open`
- `POST /host/agent-sessions/{id}/agent-messaging/call/join`
- `POST /host/agent-sessions/{id}/agent-messaging/mailbox`
- `POST /host/agent-sessions/{id}/agent-messaging/conf/open`
- `POST /host/agent-sessions/{id}/agent-messaging/conf/invite`
- `POST /host/agent-sessions/{id}/agent-messaging/conf/join`
- `POST /host/agent-sessions/{id}/agent-messaging/conf/roster`
- `POST /host/agent-sessions/{id}/agent-messaging/conf/say`
- `POST /host/agent-sessions/{id}/agent-messaging/conf/dispatch`
- `POST /host/agent-sessions/{id}/agent-messaging/conf/adjourn`
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
host user. `agent_bus_conferences` and `agent_bus_conference_members` store rooms
and their rosters — membership and authority only, since the traffic itself rides
the ordinary conversation and message tables. `agent_sessions.agent_bus_address_id`
connects the shared wrapper lifecycle to the bus. `hosts.agent_messaging_enabled`
is the retired per-host switch and is no longer read.

Message bodies and delivery error text are libsodium secretbox ciphertext at
rest. The maintenance worker expires TTLs, retries expired unaccepted leases,
marks exhausted deliveries dead, marks expired accepted leases ambiguous,
reaps dead bindings, marks stale relays, adjourns overdue and drained
conferences, and returns stranded dispatched members to the floor. Version 1 does not delete terminal
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
