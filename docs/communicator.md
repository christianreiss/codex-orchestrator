# CoCo Communicator

cxx 0.9.72 introduces one local communicator per OS user and orchestrator base URL.
It is started lazily by a managed request and shared by Codex, Claude and Grok.
Provider inference still uses each native client's original network path.

## Operation

Enable `CXX_COMMUNICATOR_ENABLED=true` in the API environment and recreate the API.
The signed wrapper config then includes `orchestrator.communicator_protocol: 1`.
Old wrappers ignore this optional field. Managed MCP rendering changes to
`cxx communicator mcp <engine>` only once that engine reports wrapper 0.9.71 or
newer. Existing tool names, arguments, results and engine-specific MCP credentials
remain intact. With the capability off, the stdio adapter uses the ordinary HTTPS
MCP endpoint.

`cxx communicator status` reports protocol, version, PID, connected clients,
forwarded/coalesced requests, last sync and connection error. `doctor` returns
nonzero when an enabled communicator is absent. The host's Operations tab shows
live server connections and their users, versions and sync timestamps.

The Unix socket lives in a mode-0700 directory below `XDG_RUNTIME_DIR` (or a
private `/tmp/cxx-<uid>` directory). Socket mode is 0600. A filesystem lock elects
one owner; only that owner removes a stale socket. No TCP listener is exposed.
Each process holds a local streaming lease; a surviving client restarts a crashed
owner. The last lease starts a five-minute idle period. Status checks do not
extend it. A connected persistent host daemon holds a lease too.

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
invalidation, after reconnect, and every five minutes while clients are attached.
It invokes the existing headless sync machinery with concurrent sync explicitly
enabled, preserving each scope's environment and signed config path. Scope
registrations are removed when their last client lease closes. Files update
atomically using the existing writers. Native settings that are only read at
startup become effective on the next launch.

## Protocol and failure handling

`GET /host/communicator/connect` upgrades to WebSocket protocol 1, authenticated
with the host key and the existing IP policy. A `hello` identifies protocol,
username and cxx version. UUID-correlated `request`/response frames preserve HTTP
method, relative path, permitted headers, status and base64 body. The dispatcher
runs requests through the existing Fastify routes and hooks with the verified
remote address. It rejects admin/provider routes, path traversal, recursive
transports, forwarding headers, cookies and replacement host credentials.

Heartbeats report local client count and last successful synchronization every
15 seconds. Server content invalidations contain only an event ID, never admin
payloads or credentials. A multiplexed `daemon` channel reuses the existing
host-daemon protocol and durable work semantics. Downloads, large attachments and long-lived watchdog streams
use separate HTTPS transfers owned by the communicator. Cron checks and sync
status use the shared control connection. Signed wrapper config
refresh also remains available over HTTPS for capability rollback.

The reconnect delay grows from one to thirty seconds with jitter. Pending writes
whose replies are lost return `communicator_outcome_unknown` with HTTP 409 so
existing retry loops do not repeat them. Durable message claim IDs and explicit
work outcomes keep their existing retry contracts. A failed connection alone
never enables transport downgrade: HTTPS fallback requires a verified signed
config disabling the capability. Native clients survive connection/owner loss.

`GET /admin/communicators` is admin-session gated and returns the live connections
for the API process. This deployment uses one API instance; its connection view
and invalidation bus are process-local. Restart recovery re-fetches authoritative
content and reuses the existing durable message queues.

## Rollout and checks

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
