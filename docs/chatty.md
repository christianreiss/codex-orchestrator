# Chatty

Chatty is the personal product assistant in the authenticated Admin WebUI.
The speech-bubble character opens a responsive conversation at the bottom right.
Owner and Admin may use it, including in compatible authorization mode. Other
roles cannot call its endpoints. Login, setup, the agent portal and Android do
not mount the widget.

## Availability and controls

The first appearance requires an enabled engine, an enabled provider account
with positively verified canonical auth, an enabled model and a reachable runner
advertising Chatty protocol 1. An issued gateway API key is not upstream access.
The quota hard-fail policy is checked both for availability and the leased account.
After first availability the character remains visible when unavailable.

Automatic selection uses the configured engine order (Codex, Claude, Grok by
default) and keeps the last successful engine within a request. Transport/provider
failures may fall back to the next usable engine; manual selection never silently
changes engine. Replies identify the engine and model. Grok refresh uses the
existing centralized owner; all runner homes contain access-only projections.

Engine selection, minimize, stop and clear live in the chat. Enter sends;
Shift+Enter inserts a newline. The settings card on `/admin/engines#chatty`
controls availability, engine priority and concurrency. Deactivation stops active
model calls. The API kill switch also suspends the worker.

One conversation belongs to each admin account across tabs, browsers, devices
and logins. Closing the panel does not stop work. Clear deletes the conversation
and pending actions everywhere, advances a generation fence and cancels work.
It does not undo completed administrative changes. Content-free request ID/hash
tombstones and ordinary domain audit records remain.

## Knowledge and tools

Builds generate `dist/chatty-knowledge.json` from maintained interface and product
documentation, shipped manual articles, current MCP tool definitions and the
Chatty tool registry. Docker copies these inputs into the build stage. The private
artifact has a corpus digest and per-source path, heading and digest; it is not
a public static asset. Runtime source reads require Chatty access. Development
can build the same corpus from the checkout.

Weighted term search discounts common terms and expands German product aliases.
There is no embedding service or external index. The model can search and read
sources; only source IDs actually retrieved during the run become citation cards.
Documentation describes contracts. Live domain tools provide installation state.
Page context contains only a route and optional typed entity identifier; the server
loads its state. No DOM, query strings, unsaved forms or browser storage are sent.

Tools expose strict argument schemas and call domain services directly. The
registry covers hosts, provider accounts, engine switches, models/configuration,
skills, fleet instructions, Claude artifacts, projects, notes, board cards, shared
memory, users, gateway-key state, metadata, schedules and watchdog suspension.
Credentials, identity verification, provider login, uploads and other operations
owned by an existing UI use an explicit interactive handoff. Such a link is not a
claim that Chatty executed the operation.

`api/src/services/chatty/surface-inventory.json` classifies every admin route as a
typed tool, interactive handoff or exclusion. Its CI check rejects new unclassified
routes and stale entries. Some tools deliberately narrow a route: schedule pause
can only set enabled=false; it cannot edit a prompt or reactivate work.

There is no generic HTTP, SQL, shell, agent-message or work-dispatch tool.
Chatty cannot start host tasks, create/reactivate schedules, enable recovery or
start daemon sessions. MCP descriptions in its knowledge are explanatory data,
not permission to invoke the full fleet MCP surface.

## Execution and confirmations

Ordinary clear instructions may execute directly. Ambiguous requests produce a
persisted question. Destructive, security, account and fleet configuration changes
produce a concrete action card containing the tool, arguments and target snapshot.
Decisions expire after 30 minutes. The action transaction locks the conversation
and target, checks the current user/session/capability and generation, compares the
target snapshot, executes the domain service and commits an encrypted receipt.
A changed target fails the old action. Database changes and the successful receipt
commit together; a failed transaction rolls them back together.

The worker uses durable claims rather than process-local ownership. An expired
claim becomes unknown and is never automatically replayed. Completed receipts
remain authoritative. A new request requires checking the affected target when
an interrupted operation has no known outcome.

The isolated runner accepts only a protocol-1 turn and returns one JSON answer,
question or proposed tool call. The API validates it and allows one format repair.
Native CLI tools/MCP/web/subagents are disabled by engine-specific command flags.
The runner bounds output, uses a new temporary home and an allowlisted environment,
and kills the subprocess group on timeout, disconnect or cancellation. Product
tools run only inside the API, with the current admin identity.

Defaults: one active request per user; two concurrent requests installation-wide;
twenty queued requests; five-minute queue wait; twelve model steps and at most
twenty-four tool calls; 120 seconds per native turn and ten active minutes per
request. A confirmation wait does not consume active time. Runner capacity is
separate from auth verification. Saturation is an explicit busy response.

Personal SSE notifications trigger canonical conversation reads. No conversation
content enters the global admin WebSocket bus. Reconnect fetches current state,
including clear-generation changes. This streams real completed steps and receipts;
it does not simulate provider token streaming. Bounded recent context includes
deterministic excerpts of older messages; history paging remains available.

## Delivery and verification

Migration 0050 creates the four Chatty tables and is idempotent. API schema and
fresh-install baseline are updated together. API and runner must be rolled out
together to enable inference. An older runner leaves Chatty unavailable.

Canonical checks are API typecheck/lint/tests, the real-MySQL migration and Chatty
lifecycle suites, runner unittest discovery, frontend check/build and the Chatty
Playwright tests (desktop/mobile and axe). The retrieval fixture contains 40 DE/EN
questions and requires supporting evidence in the top five for at least 90%.
Mocked provider output and real subprocess tests prove orchestration, not the
quality or compatibility of a live subscription/model. Each installed engine still
needs a deployment smoke test with its own managed provider account.

To disable without deleting history, turn Chatty off in the engine settings.
Rolling back API/runner binaries does not require dropping its additive tables.
Never rotate or discard the encryption key to roll back this feature.
