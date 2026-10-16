# Agent Messaging review — 2026-10-07

This review covers Codex, Claude, Grok and the Server/operator path. The evidence
below was collected locally before the separately authorized commit, push and
production rollout. The verification phase did not restart existing fleet
sessions. Existing acknowledgement-loop changes in this checkout were retained.

## Resulting behavior

Direct messages and calls retain the durable, ordered peer queue. Conferences
remain chaired task conversations. Persistent groups and individual-agent
feeds add explicit opt-in publication audiences; they never copy private
messages, calls or conference traffic, and there is no fleet-wide wildcard.

The seven tools are `agent_group_list`, `agent_group_create`,
`agent_group_members`, `agent_subscribe`, `agent_unsubscribe`,
`agent_subscriptions` and `agent_publish`. Creating a group does not join it.
Group publishers must join first; only a feed's owner may publish to it.
Server publications have a reserved non-native identity and cannot be used to
impersonate a provider engine or create a native Server session. Generic native
alias/enable controls reject this identity; its availability follows the fleet
Agent Messaging switch.

For example, create `release.ops`, subscribe selected agents to
`group:release.ops`, and publish to that exact topic. Follow an individual
agent's publications with `agent:<address UUID>`. Follow Server publications
with `agent:00000000-0000-4000-8000-000000000001`.

The publication transaction snapshots eligible subscribers and atomically
stores encrypted deliveries plus immutable recipient receipts. Reusing the
same `client_message_id`, topic, body and TTL returns that original receipt;
changing the payload under the same ID is rejected. Unsubscribing stops future
snapshots; existing deliveries keep their lifecycle. Limits are 64 subscribers
per topic, 64 subscriptions per agent and 30 publications per sender per minute.
Publication bodies are at most 30 KiB of UTF-8, retaining the existing 32 KiB
delivery cap for the routing header. Offline eligible members retain their
queued delivery; suspended engines are reported as skipped.
The next successful subscription attempt reclaims capacity from permanently
retired subscribers and feed owners, including deleted hosts; disabled,
suspended and offline identities keep their opt-in memberships.

**Agent Messaging → Groups** now shows audiences and subscriptions and offers
a scoped Server composer with recipient/skipped receipts. Membership stays
an agent's choice. Direct Server/operator conversations use **Active Clients**
and the Portal reply path. The state view separates nine engine lanes from six
Server lanes; its counters report recorded traffic rather than inferred health.

## Receiver defects corrected

* Claude health pings use a fresh correlated ID per attempt and accept only a
  successful object result, preventing stale or error replies from renewing
  reception health. Startup health remains silent.
* Codex checks both the queue admission ID and the original client message ID.
  Missing or mismatched admission remains ambiguous rather than being counted
  as execution; the native TUI remains the sole queue scheduler.
* Live and persistent relay delivery guidance allows informational replies and
  publications to finish without sending another acknowledgement. The relay
  uses a delivery-scoped no-answer marker and completes its lease.
* Failed Claude/Codex native turns and exhausted Grok token/request limits are
  not treated as successful final replies. Codex string-ID reverse approval
  requests cannot disconnect reception; the terminal retains approval ownership.
* The private Unix broker permits the new publication operations only for its
  own session; Claude's tool allowlist shares the canonical MCP name catalog.

The adapter designs remain native: Codex app-server queue, Claude MCP channel,
and Grok leader/ACP. [Official OpenAI app-server documentation](https://learn.chatgpt.com/docs/app-server)
describes the supported app-server surface; the installed Codex 0.160.1 generated
schemas provide the exact experimental queue receipt contract used here.

## Verification

Fresh native fixture canaries exercise real models, not a mocked model. They
keep provider credentials inside the native CLI and use temporary brokers,
conversations and source nonces without messaging fleet peers.

| Engine | Managed CLI tested | Native evidence |
| --- | --- | --- |
| Codex | 0.160.1 | Peer and Portal input, correlated replies, same-conversation reconnect |
| Claude | 2.1.292 | Peer and Portal input, correlated replies, same-conversation reconnect |
| Grok | 1.0.46 | Peer and Portal input through ACP, correlated actual MCP replies, native identity and silent heartbeat |

All three canaries were repeated successfully on the final combined receiver
code, artifact SHA-256
`3ca23baeb92dfa47e54420d9f081ad142ccba58c9923ddc0531e1583feae11bd`.
This isolated canary executable carries `dev` version metadata; the separate
release build reports 0.9.20. Grok's final native run took 30.12 seconds; its
reconnect path has unit coverage rather than a real-model reconnect test.

The API is separately exercised against isolated MySQL 8.4. All nine engine
direction pairs are covered by durable admission, ownership/generation fencing,
claim and completion tests. All six Server↔engine lanes are covered by queued
operator instructions and correlated authenticated response events. Publication
tests cover engine fan-out, outsiders, privacy, feed ownership, subscribe/leave,
retry snapshots, suspended engines, offline delivery, Server claim/redrive,
limits and transaction rollback.

The UI is exercised in browser fixtures on desktop and mobile, including
recipient receipts, retry IDs after lost responses, changed drafts, grants,
master-switch gating and audience refresh failures. Accessibility checks reject
serious/critical findings. These fixtures prove UI behavior; real DB tests prove
its backend and native canaries prove adapter/model delivery independently.

| Final check | Result |
| --- | --- |
| API `npm test -- --maxWorkers=4 --minWorkers=4` | 330 files, 3,922 tests passed; 29 files/351 tests skipped by their configured integration/opt-in gates |
| Isolated MySQL messaging and Portal regression | 138 tests passed; later focused bus/Server regression 107 passed |
| Final MySQL publication lifecycle suite | 14 passed, including retired subscriber/feed capacity and reserved Server controls |
| Relevant HTTP, authorization, schema and WebSocket contracts | 42 passed |
| Fresh database installer plus reapply-all/group checks | All 41 migrations applied; 20 tests passed; migration ledger has 0 pending and 0 drifted |
| API typecheck and production build | Passed; changed-file ESLint has 0 errors and one pre-existing unused-helper warning |
| Frontend `npm run check` and production build | 915 unit tests passed; 0 Svelte errors/warnings |
| Production-bundle browser checks | 9 new group/subscription cases plus 2 existing messaging cases passed; desktop/mobile overflow, page errors and serious/critical accessibility checks passed |
| Go wrapper tests, race checks, build and vet | Passed; wrapper artifact reports 0.9.20 for Codex, Claude and Grok |

The default API suite's database skips are covered separately by the explicit
MySQL runs above. The existing Vite/esbuild `ES2024` warning remains non-fatal.
Detailed native CLI versions, artifact provenance and transport boundaries are
recorded in [Receiver verification](receiver-verification.md).

## Rollout and proof boundaries

Migration `0041_agent_publications.sql` and the Drizzle/baseline mirrors ship
together. The migration is idempotent and follows the authoritative address
table collation on fresh and legacy installations. Deploy the API/migration
before wrapper 0.9.20; existing native sessions need a new launch to load the
receiver and tool changes. No production schema or running fleet session was
changed during this review.

Software verification covers the real control plane and actual native model
receivers separately. It does not certify that every current production host
already runs this build or that every fleet policy permits every tool. A queue
receipt proves admission; it never substitutes for a model response or completed
operator task. Ambiguous accepted work remains fenced and is not silently retried.
