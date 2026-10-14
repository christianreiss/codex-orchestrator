# CoCo Communicator

cxx 0.9.72 introduces one local communicator per OS user and orchestrator base URL.
It is started lazily by a managed request and shared by Codex, Claude and Grok.
Provider inference still uses each native client's original network path.

## Warm-cache launches (cxx 0.9.81)

Warm-cache launches have no switch of their own: whenever the transport and
central sync are on, the signed config carries
`orchestrator.communicator_cache_protocol: 1`. (`CXX_COMMUNICATOR_CACHE_ENABLED`
was removed on 2026-10-14; a leftover line in `.env` is ignored.) A launch
loads only what it cannot start without; everything else follows from the
owner. A running owner is current
by construction: pushed invalidations, reconnect resyncs and the five-minute
pass keep each scope's managed content up to date. Only a fresh owner, or a
scope that owner has never synchronized, needs a blocking exchange.

The owner marks a scope (engine + canonical native home, shared by every
session, account and Grok runtime broker on that home) as **primed** once it
completes a content pass. A launch asks with the local `primed` sync
operation, which answers from memory without a worker or gate.
- **Primed:** cdx/clx run an auth-only bootstrap (`skip_content`, sent as
  `include_content:false`) and apply no content; cgx sends no content exchange
  at all.
- **Not primed, older owner, or a failed probe:** the launch runs today's full
  bootstrap.

Insecure hosts never use the cache, because their rendered config embeds an
MCP bearer that expires on a timer, not on an event. `status` shows `primed`
per scope.

Content and credential work now use separate scope gates and worker locks
(`sync-<scope>.lock`, `auth-<scope>.lock`). An auth-only bootstrap holds only
the auth lock, so it never waits behind a background content pass. Full
auth-bearing bootstraps and `auth` operations take both, in content-then-auth
order. Grok brokers sharing a home now schedule a single content pass.

The server half keeps "always current" true: every input to the content
renderers emits an event the invalidation filter accepts. This release adds
the missing `agents.stored` when serve mode returns to `latest`, and a
content-relevant `host.updated` when `/cron/report` changes a host's stored
CLI version. Routine reports stay excluded so they cannot loop.

## Push-triggered updater (cxx 0.9.81)

`CXX_COMMUNICATOR_UPDATE_ENABLED=true` adds the signed
`orchestrator.communicator_update_protocol: 1` (requires transport). The
server then lists `wrapper_update` in `ready.control` and sends a
payload-free `{type:"update_available"}` on `version.*` events,
`settings.changed` and this host's `host.updated`. A watcher publishes
`version.wrapper_published` when any platform manifest's `current` cxx
release changes. Rollout tooling can publish its own `version.*` event, such
as `version.wrapper_rollout_advanced`. Owners also check on every
(re)connect and on a six-hour backstop.

The frame is only a trigger. The owner's updater takes the target from
`/cron/check`, which applies auto-update, fleet locks and host or rollout
policy. It accepts the target only if the freshly fetched signed config names
the same version and SHA-256, and it refuses downgrades.

1. It prefetches the verified artifact into `~/.cxx/staging/` (0700) right away.
2. It waits until **no agent is running** for the OS user. Every managed
   native launch (local, remote-daemon or legacy) holds its engine's shared
   housekeeping lock for the native child's whole life; the owner's finite
   workers and resident execution workload count too.
3. It then applies through the ordinary `cxx update`, which installs from the
   staged copy, updates the provider CLIs and syncs.
4. An on-demand owner retires afterwards, so the next managed call starts the
   new binary.

A shared or root-owned install is left to root and reports `requires_root`.
A transient apply failure, such as the cron coordinator holding the
maintenance lease, keeps the staged target and retries after two minutes. The
target is dropped after five consecutive failures. The updater checks
through the owner's anchor engine, so if that engine is fleet-suspended it
reports `idle` (`check_failed`) until the next trigger.
With the capability signed, scheduled cron ticks defer the wrapper swap and
provider pointer switch while agents run; explicit `cxx update` is never
deferred.

`status` reports `update.state`: `current`, `idle` (with a reason), `staged`,
`waiting_for_quiet` (with an `agents` count), `applying`, `applied`,
`handoff_requested`, `requires_root` or `failed`. `doctor` fails on `failed`.
Resident replacement is described in
[runtime, migration and acceptance](communicator-resident-runtime.md#unprivileged-update-handoff).

## Resident owner reporting (cxx 0.9.80)

With the default-off signed `orchestrator.communicator_runtime_protocol: 1`,
the owner sends diagnostics only to a server advertising `resident_runtime`
alongside `terminate` and `owner_identity` in `ready.control`. Its existing
`capabilities` frame stays unchanged and precedes the new `resident_status`
frame. Old servers receive their exact legacy frames. Reports are scheduled
after the existing 15-second heartbeat, which continues rechecking host
authorization. Reports add no separate authorization/database read.

Reports carry the exact `owner_instance_id`, a per-connection increasing
`sequence`, mode (`on_demand` or `resident`), service management, requested
residence, effective execution policy, the running executable's SHA-256,
draining, local request/legacy-client counts and bounded controller workload.
They omit errors, credentials, paths and native session contents. An unreadable
executable digest suppresses reporting; it never changes execution policy.

Malformed, unknown-version or mismatched diagnostic reports are ignored
without publishing or closing the shared control connection. Heartbeats,
request relay and targeted terminate remain available. The registry accepts a
report only after that connection announced the same process instance. Earlier sequences cannot replace a newer report even if
processing or future asynchronous work completes out of order. Identity changes and unregister
clear the report; reconnect requires a new report and never inherits one by
host, username or runtime namespace. These fields do not link successors or
prove safe handoff, account admission, native-child survival or process exit.
`/_comm/status` remains available during draining.

Diagnostic collection runs outside the heartbeat loop, coalesced to one
outstanding sample per owner even across reconnects. Samples taking longer
than two seconds are omitted, so stalled I/O cannot continually refresh old
state. Report writes have a two-second deadline. Receipt scanning releases the
controller admission mutex; snapshot rebinds or permit changes invalidate an
in-flight sample, and observed permits remain conservative until the next
stable scan. Migration readiness still requires fresh verified quiet state.

Live topology shows the latest report with its server receipt time, marks it
stale after 45 seconds independently of unrelated connection traffic, and keeps
termination evidence explicitly separate. Residence can be requested while
remote starts are disabled, or execution can remain running/fenced to drain
accepted work after policy disables new starts.

## Operation

Enable `CXX_COMMUNICATOR_ENABLED=true` in the API environment and recreate the API.
The signed wrapper config then includes `orchestrator.communicator_protocol: 1`.
Old wrappers ignore this optional field. Managed MCP rendering changes to
`cxx communicator mcp <engine>` only once that engine reports a cxx release
version of 0.9.71 or newer. The reported string has to match a bakery release
(optional leading `v`, optional prerelease or build). A date-versioned shell
wrapper such as `2025.11.03` or `2025.11.3`, `dev`, and any other non-release
stay on the HTTPS MCP endpoint. `v0.1.0` is a real version and stays on HTTPS
because it is older than 0.9.71. Existing tool names, arguments, results and engine-specific MCP credentials
remain intact. With the capability off, the stdio adapter uses the ordinary HTTPS
MCP endpoint.

Every config-backed engine command binds its verified selected config before
creating control clients, including commands outside the native lifecycle.
From cxx 0.9.78 this also covers Codex and Claude after expired-config recovery
or custom `--config` selection; Grok already binds at that boundary. The one
signed-config repair read can run before an owner exists, but subsequent auth
and control requests use the communicator whenever the recovered config enables it.

`cxx communicator status` reports protocol, version, PID, connected clients,
forwarded/coalesced requests, last sync and connection error. `doctor` returns
nonzero when an enabled communicator is absent. When the wrapper refuses the local socket
(for example a leaked `XDG_RUNTIME_DIR=/run/user/0` that is not private to the user), the line for that
server carries `"error"` with the refusal instead of an empty `"socket"`, and `doctor` fails. The host's Operations tab shows
live server connections and their users, versions and sync timestamps.

The Unix socket lives in a mode-0700 directory below `XDG_RUNTIME_DIR`. When a
launcher drops that variable (Codex MCP servers, cron), the user's logind
`/run/user/<uid>` directory is used if present, otherwise a private
`/tmp/cxx-<uid>` directory, so every process elects the same owner. A runtime root
deep enough that the socket would exceed the platform's own `sun_path` limit (107 bytes on
Linux, 103 on macOS and the BSDs) falls back to `/tmp/cxx-<uid>`, independent of `TMPDIR`;
that fallback directory is keyed by the resolved scope as well as the server, so two
distinct deep scopes (isolated runs, harnesses) never share an owner, fence or credentials,
and one scope always maps to one path. An unsafe root is refused. The owner's startup
errors go to `serve.log` in that directory; the part written during the failed attempt is
shown, bounded to 400 printable characters on one line, in the error a managed command
prints. Socket mode is 0600. A filesystem lock elects
one owner; only that owner removes a stale socket. No TCP listener is exposed.
Each process holds a local streaming lease; a surviving client restarts a crashed
owner. The last lease starts a five-minute idle period, after which the owner
closes its socket and exits (the next managed call starts a new one). Status checks do not
extend it. A connected persistent host daemon holds a lease too.

From cxx 0.9.77, reconnect and owner replacement are independent of the engine
whose config first started the owner. If that file is missing, invalid, suspended
or disables the transport, another signed config from active sync scopes or the
user's Codex/Claude/Grok config paths can supply transport policy. Candidates must
match the original host ID, FQDN and server URL. HTTPS transfers use the selected
policy as well. Only an explicit verified rollback permits HTTPS fallback; missing
files and foreign configs do not.

A symlinked, missing or non-0700 logind directory is never trusted. An explicit
custom `XDG_RUNTIME_DIR` is a deliberately separate namespace (isolated tests,
containers) with its own owner and fences. Upgrading from a release before 0.9.75 does
not move an existing owner: a `/tmp/cxx-<uid>` owner started by an older Codex
MCP adapter keeps serving the processes already attached to it. Owners before
0.9.75 also never exit when idle, so that stray owner outlives its last client.
After installing 0.9.75, end or restart the Codex sessions started before the
update, then stop the leftover owner: `ss -xlp | grep "/tmp/cxx-$(id -u)/cxx-comm"`
names its PID, and with no clients attached it holds no work. Afterwards only the
`/run/user/<uid>` socket should remain listening.

## Data and auth ownership

Session brokers still bind requests to their existing agent/session capabilities.
The communicator does not combine identities, account assignments, delivery claims
or native process ownership. Existing auth generation locks, logout intent,
account leases, runner validation and per-engine refresh rules remain in force.
Grok retains centrally refreshed auth and access-only runtime projections.

Read coalescing only joins concurrent byte-identical content requests, including
their credentials, engine and home. It never caches arbitrary MCP results or
replays auth uploads. Account/session admission and freshness checks remain
individual operations where their authorization requires it.

Managed content sync runs once per registered engine/home scope after push
invalidation, after reconnect, when a lease registers a scope that is new to
the owner, and every five minutes while clients are attached. An additional
lease on an already-registered scope does not force a pass. A scheduled pass is
skipped when a complete bootstrap or content worker for that scope started after
the newest server invalidation (a pushed `invalidate` frame or a reconnect,
stamped on arrival) and less than five minutes ago, so a launch's own bootstrap
satisfies the scope's initial pass instead of being followed by an identical
exchange. A first connection is not an invalidation, a new scope's first
scheduled pass waits 1.5 s so the session that opened it runs first, and explicit
syncs, `auth` operations and bootstraps that carry auth always run.
It invokes the existing headless sync machinery with concurrent sync explicitly
enabled, preserving each scope's environment and signed config path. Scope
registrations are removed when their last client lease closes. Files update
atomically using the existing writers. Native settings that are only read at
startup become effective on the next launch.

## Protocol and failure handling

`GET /host/communicator/connect` upgrades to WebSocket protocol 1, authenticated
with the host key and the existing IP policy. A `hello` identifies protocol,
username and cxx version. UUID-correlated `request`/response frames preserve HTTP
method, relative path, permitted headers, status and base64 body. Account lease
acquisition and heartbeat/release (`/auth/sessions` and its two lifecycle routes)
use the same transport and retain their engine/session identities. The dispatcher
runs requests through the existing Fastify routes and hooks with the verified
remote address. It rejects admin/provider routes, path traversal, recursive
transports, forwarding headers, cookies and replacement host credentials.
The server also refuses, before dispatch, every route the owner sends over its own HTTPS
stream (wrapper artifacts under `/wrapper/v2/bin/`, `/wrapper/v2/download*`,
`/wrapper/download*`, any `/download` or `/attachments/` path, watchdog and connect
paths) on every equivalent path form, so the router never buffers a binary or attachment
for a control frame. One frame is answered rather than refused: cxx 0.9.71–0.9.74 owners
route only paths containing `/download` or `/attachments/` (or ending in `/stream`) to HTTPS,
so their self-update `GET /wrapper/v2/bin/{artifact}/{os-arch}/v{version}/{binary}` arrives
as a frame, and those owners have no fallback for a refusal. The server answers exactly that
`GET` (no query, strict segments) with a 307 to the relative
`../../../../download/{artifact}/{os-arch}/v{version}/{binary}`, which resolves on the same
origin and base-URL prefix to the exact-version `/wrapper/v2/download/...` alias. The updater
follows it through the same owner (keeping `X-API-Key`, since the host is unchanged), the
owner fetches it over direct HTTPS, and the updater's SHA-256 check against the cron-supplied
digest is unchanged, so the redirect cannot substitute a different binary. Path checks use the pathname the router dispatches, so a trailing slash cannot
reach a denied stream or skip MCP credential pinning. A malformed or disallowed
request frame gets its own `400 communicator_invalid_request` reply; only an
authorization failure closes the shared connection. A `host.*` event that
names a numeric `id` or `host_id` invalidates only that host's connection.
Events with no host id still reach every connection. A reply above 11 MiB, or
whose whole encoded frame (base64 body, headers, JSON) exceeds 15 MiB in UTF-8 wire bytes, is answered for
that request only and the socket stays open: `502 communicator_response_too_large` for a
repeatable read, `409 communicator_outcome_unknown` for anything that may have changed
state, since the operation has already run. The same rule covers a fault after the
request was handed to the router (a write is reported as unknown, never as a retryable
5xx) and topology bookkeeping can no longer replace the reply of a request that already
ran. From cxx 0.9.75 the local owner retries an idempotent read once on its HTTPS transfer.
POST bootstrap qualifies only with explicit `include_auth:false`, no auth candidate
and no session admission. Completed operations that cannot safely be repeated,
including auth stores and MCP calls, return `409 communicator_outcome_unknown`
to prevent existing client retry loops from replaying them. The local allow-list strips
trailing slashes the same way the API router does.

From cxx 0.9.78, the MCP stdio adapter accepts a correlated response only when
exactly one of `result` and `error` is present. A lone `result: null` is valid.
An error must be an object with an integer `code` and a string `message`;
null errors, missing fields, and contradictory envelopes return the existing unknown-outcome error with the
original request ID instead of forwarding an ambiguous result.
The stdio writer also preserves JSON numbers without passing them through
`float64`, so large integer IDs stay correlated in single and batch replies.

Remote control of the owner process is negotiated, so old servers and old owners
never meet a frame or a field they do not know. A server that can stop an owner
lists `control: ["terminate", "owner_identity"]` in its `ready` frame:
`terminate` offers the stop, `owner_identity` says the server accepts the owner's
process identity and aims a stop at exactly one process. An owner that sees
`terminate` alone (a server that predates owner identity, whose `capabilities`
schema rejects unknown fields) sends only the legacy fields (`type`, `terminate`,
`pid`, `started_at`), says `terminate: false`, and ignores `terminate` frames from
that server, so the console offers no stop for it and disconnect keeps working. An
owner that sees neither token sends nothing. Only with both tokens does the owner send one
`capabilities` frame (`terminate`, `pid`, `started_at`, `instance_id`, `runtime_id`), and only then does it honour
`{type: "terminate", request_id, reason, owner_instance_id}`. The command is aimed at
one process: `owner_instance_id` must equal the `instance_id` that owner announced, and
a command for any other process is answered `terminate_ack` with `accepted: false,
reason: "owner_mismatch"` and acted on by no one. The server likewise refuses an
acknowledgement whose `instance_id` is not the process it addressed, and does not offer
the control to an owner that announced no `instance_id`. An accepted command is answered
`terminate_ack` (`request_id`, `instance_id`, `accepted`, `reason`, `pid`) within a
bounded write (two seconds), a repeat of the same `request_id` is answered again but
acted on once, and from that moment the owner admits no new local work (new requests
get `503`; `/_comm/status` keeps answering). In-flight local requests are given up to
three seconds to finish, the acknowledgement is allowed to leave the socket, and the
owner ends through the same path as an idle exit (HTTP server, lock and socket closed). The
`pid` and start time are the owner's own account; the server cannot observe them.
`instance_id` is a UUID the owner generates at start, so the same value on a later
connection proves the same process dialled again. `runtime_id` is a hash of the owner's
local socket path, so the same value means the same local namespace is served: a
different process announcing the runtime of a disconnected owner is its replacement,
while owners in separate runtime roots (which can coexist for one OS user) differ.
Heartbeats report local client count and last successful synchronization every
15 seconds. Server content invalidations contain only an event ID, never admin
payloads or credentials. A multiplexed `daemon` channel reuses the existing
host-daemon protocol and durable work semantics. A stalled daemon stream detaches
independently; admission of its replacement waits until the previous remote
disconnect has been sent. Delayed cleanup cannot detach a replacement, and other
engines continue using the control connection during the handoff.
Downloads, large attachments and long-lived watchdog streams
use separate HTTPS transfers owned by the communicator. Cron checks and sync
status use the shared control connection. Signed wrapper config
refresh also remains available over HTTPS for capability rollback.

From cxx 0.9.74, independent HTTPS transfers and signed fallback enforce the
same managed route inventory and host-key binding as control frames. Watchdog
streams remain supported. Cookies, forwarding headers and caller replacement
host keys are removed; engine and session credentials are retained. Large MCP
uploads carry `X-Cxx-Communicator: 1`; the MCP endpoint checks the bearer against
the accompanying host key and rejects foreign hosts or operator credentials.
Reconnect also replaces the owner's transfer configuration with the verified
signed head, so rotated host keys and TLS policy apply to HTTPS transfers.
An enabled signed capability also fails closed when local socket setup is
unsafe or unavailable; a runtime-directory error never enables direct HTTPS.
The only exception is the self-repair path: when no local owner can be started
or reached, `GET` of the signed `/wrapper/v2/config` (signature-verified) and of wrapper
binary downloads, including the bakery's `/wrapper/v2/bin/...` URLs
(digest-verified), use direct HTTPS, so a broken owner
can still learn a capability rollback and install a fixed release. HTTPS
transfers never wait for the control connection to reconnect.

When the server refuses the WebSocket upgrade, the owner asks once more outside the
WebSocket library and records the server's own verdict in `last_error` (for example
`communicator handshake rejected: HTTP 401 ip_mismatch (API key not allowed from this
IP)`), and local `503 communicator_unavailable` replies carry that text in `message`, so a
wrapper prints the same actionable diagnosis it would over direct HTTPS (an IP binding
to release, a revoked key, the capability switched off) instead of "API offline".

A refusal that is a verdict on the host's own credentials keeps its status: `401`
(`missing_api_key`, `invalid_api_key`, `ip_mismatch`, `reverse_dns_failed`, `host_expired`) and
`403 host_<status>` are returned for a request that never reached the control channel with the
server's own status and body, as direct HTTPS answered every route. The wrappers' clients return a
4xx at once (no retry) and classify it as a verdict (a Grok session whose refresh gets a `401`
ends, exactly as before the communicator); a `503` they retry for about a second and bridge with
cached auth. Everything that is the channel being unavailable stays the retryable
`503 communicator_unavailable`: `403 communicator_disabled`, the `api_disabled` kill switch, 5xx,
a timeout, a dropped connection. The verdict describes only the last connection attempt; the next
attempt that succeeds or fails for another reason clears it, and an unknown outcome (`409`) is
never rewritten into a credential verdict. The local reply carries `X-Cxx-Communicator-Refusal:
handshake`. The host-daemon channel is unaffected in behaviour: its WebSocket client reports every
refused upgrade as "bad status" whatever the code, and the daemon retries with backoff either way
(as it did over direct HTTPS), so there the verdict only reaches diagnostics.

The reconnect delay grows from one to thirty seconds with jitter. A request that finds the
connection down never sits through that backoff: it asks the connect loop to redial at
once and waits for that one attempt: at most 10 s for the very first connect of a cold owner
and 3 s for a redial after the connection was lost. Both end inside the 15 s deadline of the
credential sync worker (a worker killed while its request still waits would never learn that
nothing was sent) and are shared by all requests during one attempt, so against a hung API
only the first call of a command pays the budget and the next ones fail at once. A request
whose connection already ended before it was written is also answered `503` (provably
not sent), and a worker whose request never left cleans up its write-ahead credential marker
(only a delivered, unanswered upload keeps it); a frame that was written and then lost stays `409` outcome unknown. A refused
connection fails in milliseconds, so during an outage the request gets
`503 communicator_unavailable` promptly (a definitive "not sent", never "outcome
unknown"), exactly as direct HTTPS would refuse, and the first request after the server
returns reconnects immediately instead of failing out the rest of the backoff. A failure
from the last second is reported without redialling, so a command's many calls do not each
dial. No pending-auth marker is left behind. Pending writes
whose replies are lost return `communicator_outcome_unknown` with HTTP 409 so
existing retry loops do not repeat them. Durable message claim IDs and explicit
work outcomes keep their existing retry contracts. A failed connection alone
never enables transport downgrade: HTTPS fallback requires a verified signed
config disabling the capability. Native clients survive connection/owner loss.

From cxx 0.9.74, the MCP stdio adapter retains this distinction in JSON-RPC
error data (`code`, `http_status`, `outcome_unknown`) and keeps the original request
ID. Unknown outcomes instruct the caller to verify the result before retrying with
the original idempotency or claim identifiers. Incomplete or miscorrelated replies
also return a correlated unknown-outcome error. Error conversion never forwards
upstream bodies or credentials, and the adapter never replays a failed call.
An oversized reply rejected after dispatch also carries `outcome_unknown: true`:
the route may already have committed its effects before the frame limit was
checked. The bounded `communicator_response_too_large` code remains available
for diagnosis.

The adapter forwards JSON-RPC batches (MCP 2025-03-26, which the API advertises)
as one request and writes the server's array reply. Notifications in a batch get
no reply, and an all-notification batch writes nothing. If the reply is lost,
malformed or misses a request, each request gets its own unknown-outcome error.
An unparsable line gets `-32700` with id null, and a JSON value that is neither
an object nor a non-empty array gets `-32600`; neither ends the session. Input
the API answers with an id null `-32600` (invalid batch members, objects without
`jsonrpc` or `method`) gets that answer even when nothing else in the line
expects a reply; valid notifications stay silent. On SIGTERM or interrupt the adapter stops reading stdin even if the
native client keeps it open, reports any in-flight request as an unknown
outcome, releases its owner lease and exits. It waits at most three seconds for
those replies, so a client that has stopped reading stdout cannot keep it alive;
a signal after stdin has closed gets the same bound. Replies are relayed as
compacted raw JSON, never re-encoded, so request IDs keep their exact value.

Request correlation compares JSON ID values rather than serialized spellings,
including escaped strings and equivalent numbers. Distinct large integer IDs
remain separate. Grok readiness treats a transport's unknown-outcome 409 as
retryable uncertainty, preserving the native process; authoritative auth and
account-session revocations retain their existing termination behavior.

`GET /admin/communicators` is admin-session gated and returns the live connections
for the API process. This deployment uses one API instance; its connection view
and invalidation bus are process-local. Restart recovery re-fetches authoritative
content and reuses the existing durable message queues.

## Live topology and control

The console's **Live Topology** page (`GET /admin/topology`) draws the server, the
communicators connected to it and the agent sessions each one carries. The view is
the connection set of the API process that answers, never a fleet-wide inference.
Communicator labels show the full FQDN, without a username prefix or hostname
shortening, and retain any runtime suffix used to distinguish connections.
Node fill and icon color show the fresh reported owner mode: blue for persistent
(`resident`), purple for spawned (`on_demand`), neutral gray when missing or stale.
The ring and connection line continue to show health. List and detail views name
the mode; requested residence and attached daemon channels do not classify it.

Connection lines keep their screen width while zooming: 4 px from server to
communicator, 3 px to carried agents and 2.5 px to direct agents. Selecting a path
adds 1 px of emphasis; status colors and dashed patterns distinguish link states.

A session is shown under a communicator only on evidence: the API answered a
`/host/agent-sessions/<id>/…` request for it (or its registration) below status 400
over that socket, which proves the session's bridge token authenticated on that
host's key through that connection. Evidence older than the presence window (45 s by
default) marks the link quiet, and a session with none hangs off the server as
direct. Host, OS user and engine are never used to pick a parent, because one user
may run several communicators in separate runtime roots and a session may talk to the
server directly. After a communicator reconnects, its sessions are re-attributed as
each next speaks to the server (their heartbeats run every 15 s).

`POST /admin/communicators/{id}/disconnect` closes exactly one connection (WebSocket
close code 4001) and answers `closed` once the socket's close handler has run, or
`requested` when nothing has confirmed it. It is a transport reset, not a process
kill: the owner keeps running and redials within 1–30 s, requests in flight on that
socket finish as `communicator_outcome_unknown`, and no session is stopped or
replayed. Sessions are stopped through their own contracts: cooperative close
(`POST /admin/agent-sessions/{id}/close`), ending the server-side record
(`…/close/force`, which does not signal the process) and, only for sessions a host
daemon launched, a daemon stop (`POST /admin/daemon-sessions/{id}/stop`).
`POST /admin/communicators/{id}/terminate` asks the owner *process* to stop, for an owner that
announced the capability above, and says only what the server observed: `acknowledged_closed`
(the addressed process acknowledged, then its connection closed), `acknowledged` (acknowledged,
connection still open when the wait ended), `refused` (declined, or the acknowledgement came from
another process) and `unacknowledged` (nothing answered; the connection is left alone). None of
these is a process exit: the server has no way to observe the process, and the console says so.
Exit is verified where the process runs (the owner's lock and socket are released and its pid is
gone). One `client_message_id` runs once even when two requests arrive together; the second
receives the first's outcome with `replayed: true`. A surviving client restarts a new owner, which
describes itself with a different pid and `instance_id`.

The page links a disconnected connection to a later one only on that identity: `same_process`
(the same `instance_id` dialled again) or `same_runtime` (a different process announcing the
same `runtime_id`, with the same host and OS user). A connection from the same host and user
without a matching identity is listed as an unverified candidate, never as a successor,
because separate runtime roots can host distinct owners for one user; an owner that predates
the identity fields can only ever produce candidates. Every
control requires `agent_portal.manage` (or `agent_messaging.manage` for the daemon
stop), which stay enforced under `compatible` authorization.

## Rollout and checks

Which cxx release a host's signed config and `/cron/check` name is subject to the
staged cxx rollout when `CXX_WRAPPER_ROLLOUT_ENABLED` is on: a host joins a new
release at its canary or wave stage, not at publish time. See
[wrapper-v2-architecture.md](wrapper-v2-architecture.md#staged-rollout-canary-and-waves).

Keep the server capability off while deploying the compatible server and wrapper.
Then enable it, sync clients and validate mixed-engine concurrency, server
reconnect, local crash recovery, auth isolation and push propagation. Existing
sessions keep their original transport until their supervising wrapper restarts.
Disable the flag and refresh signed configs to roll back the transport; retain
the previous API image and wrapper release for a full rollback.

Tests cover route/header isolation and policy revocation, concurrent request
routing, identical-read coalescing, unknown write outcomes, signed engine
selection, and six real MCP processes across all three engines reconnecting after
both remote disconnect and local owner crash.

## Central sync ownership (cxx 0.9.73)

`CXX_COMMUNICATOR_SYNC_ENABLED=true`, together with the transport flag, adds the
signed `orchestrator.communicator_sync_protocol: 1` capability. Roll out the
compatible API and wrapper before enabling it. An older owner keeps new clients on the legacy sync lifecycle until it is
replaced with the new communicator; native sessions are not restarted. Older wrappers retain their existing lifecycle.

Startup bootstrap, explicit sync, skill probes and pushed content converge through
finite `communicator-worker` operations. These reuse the existing per-engine
writers without entering persona startup, installers, cron or service setup.
Content refresh also fetches and verifies the signed wrapper configuration over
the shared transport and persists it under the existing config lock. The
worker holds a short native-home fence; identical concurrent content operations
share their result, while different homes and engines can progress independently.
The broad session-lifetime content gate no longer applies to managed sync.
`--allow-concurrent-sync` remains accepted for legacy compatibility.

Each active auth scope registers its existing account and session identifiers.
The communicator watches native credential directories (including atomic rename),
with a two-second rescan and a thirty-second server reconciliation backstop. One
live session supplies the account binding for a shared credential source. Native
changes use existing upload/runner validation and generation arbitration; verified
server changes use existing compare-and-write guards. Missing files, partial
writes, explicit logout, account binding and insecure-host cleanup retain their
previous meaning. Finalization and legacy fallback take the same short worker
fence. No automatic login, provider refresh owner transfer or native restart is
introduced.

Grok keeps its private runtime and request-time external auth accessor. The
communicator schedules the existing broker's readiness check; fetching a newer
head does not rewrite the native access cache or claim that the native process
has used it. Canonical refresh remains server-owned, and native runtime credentials
are never uploaded as a new login.

Canonical head changes emit metadata after commit. Connections learn account
subscriptions from successful authorized auth responses; otherwise an opaque auth
invalidation requests reconciliation. Credentials still travel through the existing
authorized auth routes. Auth events do not schedule unrelated content synchronization.
The event bus remains process-local; reconnect and periodic reconciliation repair
missed events.

Worker auth transactions keep a mode-0600 digest-only pending marker in the native
home. A crashed worker or unknown write outcome requires verified readback before
reoffering that generation. An exact verified credential pair can be acknowledged
without replay; unresolved outcomes remain visible and preserve local credentials.
The marker contains no credential bytes. A new native generation is independent.
A verified readback of the exact credential pair acknowledges the interrupted upload.
If that readback instead supplies a strictly newer verified head for the same account
and engine, Codex and Claude adopt it through their existing exact-generation session
writer. A concurrent native change, logout or deletion wins; recovery never retries the
upload. The result is reported as adoption, not upload acknowledgement. The pending
marker is removed only after successful reconciliation and only while it still names
the interrupted generation. A crash before marker cleanup can be reconciled again.
An older or equal-but-different head, missing verification, or a changed account/session
remains unresolved and refuses launch with the marker's explicit diagnostic. Timestamp
comparison alone never authorizes re-offering a local credential or deleting its marker.
The launch diagnostic says the same: it never reads "compare, then delete the marker". It
names the marker, explains that differing digests or timestamps do not settle an upload that may
have been committed and replaced since, and offers re-authentication (`cdx login` / `clx login`,
which replaces the local credential through the normal flow) or an explicit operator decision after
verifying that the credential kept is the intended one for the account, without printing
credentials. There is no force-clear command. A stale marker with a differing server head still
needs that operator decision; the clearer message is not automatic recovery.

For an unresolved conflict, `cdx auth-reconcile` and `clx auth-reconcile` perform
an explicit direct account-scoped readback (using the signed config's existing
API key and TLS/CA policy) and print metadata only: server, engine, local and
pending SHA256 generations, account/session binding, verified canonical digest
and generation, and the conflict reason. The command has a 15-second network
and lock deadline. It does not start an owner or run startup content sync, maintenance, upload,
provider refresh or account-lease acquisition. Without an active native child,
an inherited session ID is omitted, so an expired lease does not prevent the
same account's readback. An active invalid session binding is reported precisely;
no replacement account is silently reserved.
Readback and local native files are limited to 1 MiB. An oversized response is
rejected in full; a valid JSON prefix cannot be accepted by truncating its tail.

`auth-reconcile --accept-server` is an explicit choice to adopt that account's
verified server credentials, including an older or equal-but-different head.
It requires a stable positive account binding, an existing pending marker and
local auth generation, no logout intent, and no active native child. A unique
0600 copy of the exact observed native bytes is saved and synced beneath the
native auth directory's private `auth-recovery-backups/` directory before the
existing guarded writer is called. A native change/deletion/logout during the
readback or after backup wins. A changed marker is retained: cleanup compares its
exact bytes after a successful write, while holding the same transaction fence
as background workers. Success says **adopted server credentials**, never that
the interrupted upload was acknowledged. Backups remain available for deliberate
local recovery; restoring one is not permission to replay the interrupted upload.

Credential adoption with a persistent backup is limited to secure hosts. An
insecure signed config or a readback reporting an insecure host refuses retention;
inspection still works. Unverified or missing server credentials, changed or
absent account binding, missing local credentials and logout intent remain fenced
with diagnostics. There is no cross-account switch or implicit logout recovery.
Grok rejects this command explicitly: subscription credentials are server-owned.

Malformed pending markers, including valid JSON without a lower-case SHA256
generation, remain fenced rather than looking absent. The fence survives a
signed rollback to legacy transport; changing transport does not prove the
previous store failed. A verified identical Claude readback also supports an
older API's `digest` field when `canonical_digest` is absent.
Automatic idle uploads also take the recovery transaction fence and check the
pending marker before any store, including after a signed transport rollback.
An unresolved candidate is never reoffered by `auth-upload-auto`.

Local `status`/`doctor` and the host Operations panel show content failures and
per-scope auth progress. Server confirmation, local writes and native adoption are
separate: a local write reports native adoption as unconfirmed. Native processes
do not provide an adoption acknowledgement, so this is an observation limit,
not a pending job or a failed sync. Older owners' `pending` reports are displayed
with the same explanation. Model-facing notices
are informational and never count as technical adoption acknowledgements. Detailed
worker errors remain on the protected local socket; heartbeats carry bounded
metadata only. `doctor` fails for a disconnected owner or failed synchronization.

For rollback, disable the sync capability and refresh the signed engine configs.
The communicator stops scheduling that auth scope, drains accepted work and sends
an explicit local handoff. Its supervising wrapper resumes the existing auth
watcher without restarting the native process. Short file fences also protect a
new legacy invocation during the transition. Content workers remain side-effect
limited, and transport rollback keeps its independent signed-capability rule.

Regression coverage includes real daemon/worker processes, thirty concurrent
content callers, ten auth consumers per source, native atomic rotation, server
push, signed handoff, lost-acknowledgement readback, logout/CAS preservation and
Grok readiness without token issuance or refresh ownership changes. All process
fixtures use isolated HOME and runtime directories.

### First-sync capabilities

Starting with cxx 0.9.79, Codex, Claude and Grok HTTP clients send
`X-Wrapper-Version` from the running binary, including finite workers. The API
uses it only for the selected engine's config-rendering capabilities, so a fresh
installation can receive the stdio MCP adapter before its first version report.
The signed config's target version does not stand in for the running version.
Older clients without the header retain the stored-version behavior; old and
non-release callers still fail the existing communicator version gate.

## Resident communicator workstream

From cxx 0.9.80 the independent, default-off signed `communicator_runtime_protocol: 1` provides
`cxx communicator run` as the persistent owner for transport, content sync and
the existing remote execution controller. Residence and remote starts have
separate settings; native auth/account locks and engine-specific refresh ownership
remain in their existing lifecycles. See [runtime, migration and acceptance](communicator-resident-runtime.md).
