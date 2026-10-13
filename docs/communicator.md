# CoCo Communicator

cxx 0.9.72 introduces one local communicator per OS user and orchestrator base URL.
It is started lazily by a managed request and shared by Codex, Claude and Grok.
Provider inference still uses each native client's original network path.

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

`cxx communicator status` reports protocol, version, PID, connected clients,
forwarded/coalesced requests, last sync and connection error. `doctor` returns
nonzero when an enabled communicator is absent. The host's Operations tab shows
live server connections and their users, versions and sync timestamps.

The Unix socket lives in a mode-0700 directory below `XDG_RUNTIME_DIR`. When a
launcher drops that variable (Codex MCP servers, cron), the user's logind
`/run/user/<uid>` directory is used if present, otherwise a private
`/tmp/cxx-<uid>` directory, so every process elects the same owner. A runtime root
deep enough to exceed the platform's socket-path limit (kept under 100 bytes) falls
back to `/tmp/cxx-<uid>`, while an unsafe root is refused. The owner's startup errors
go to `serve.log` in that directory and are included in the error a managed command
prints. Socket mode is 0600. A filesystem lock elects
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
method, relative path, permitted headers, status and base64 body. Account lease
acquisition and heartbeat/release (`/auth/sessions` and its two lifecycle routes)
use the same transport and retain their engine/session identities. The dispatcher
runs requests through the existing Fastify routes and hooks with the verified
remote address. It rejects admin/provider routes, path traversal, recursive
transports, forwarding headers, cookies and replacement host credentials.
Path checks use the pathname the router dispatches, so a trailing slash cannot
reach a denied stream or skip MCP credential pinning. A malformed or disallowed
request frame gets its own `400 communicator_invalid_request` reply; only an
authorization failure closes the shared connection. A `host.*` event that
names a numeric `id` or `host_id` invalidates only that host's connection.
Events with no host id still reach every connection. A reply above 11 MiB
returns `502 communicator_response_too_large` for that request. From cxx
0.9.75 the local owner retries an idempotent read once on its HTTPS transfer
and leaves writes such as `POST /auth` on the 502. The local allow-list strips
trailing slashes the same way the API router does.

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
or reached, `GET` of the signed `/wrapper/v2/config` (signature-verified) and of
wrapper metadata/downloads (digest-verified) use direct HTTPS, so a broken owner
can still learn a capability rollback and install a fixed release. HTTPS
transfers never wait for the control connection to reconnect.

The reconnect delay grows from one to thirty seconds with jitter. While the connection
is down, local requests wait for it only as long as is useful: up to 20 s for the first
connect, 1.5 s after one failed attempt, and not at all from the second consecutive
failure, when they receive `503 communicator_unavailable` immediately (a definitive
"not sent", never "outcome unknown"). That keeps an outage as cheap as direct HTTPS and
leaves no pending-auth marker behind. Pending writes
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

Local `status`/`doctor` and the host Operations panel show content failures and
per-scope auth progress. Server confirmation, local writes and native adoption are
separate: a local write reports native adoption as pending. Model-facing notices
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
