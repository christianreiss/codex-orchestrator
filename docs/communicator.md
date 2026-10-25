# CoCo Communicator

cxx 0.9.72 introduces one local communicator per OS user and orchestrator base URL.
It is started lazily by a managed request and shared by Codex, Claude and Grok.
Provider inference still uses each native client's original network path.

cxx 0.9.132 applies connection-owned receiver sources before deriving Portal
gates and claim budgets. Disabling Portal clears its local pending gate so an
enabled peer source can continue; enabling another source checks its existing
queue in the same state revision. Directory Remove/Rename events invalidate
local watch coverage, and unused watches are removed. Missing coverage retains
the existing bounded fallback until event watches are installed again.

A prepared resident handoff keeps its durable safety fence until journal
recovery commits that same handoff; it does not automatically reopen admission.
While fenced, overdue sync timers are disarmed rather than spinning. Refused
handoffs wake the scheduler after restoring its previous admission state.

An exact HTTP 401 `agent_bridge_expired` on the native MCP broker can occur
after a mutation as well as before dispatch. The broker repairs registration
for the next explicit request and returns the original response unchanged;
it never repeats that opaque MCP operation. Terminal authorization failures
and unknown outcomes do not trigger this recovery.

Ended or closing native sessions do not dispatch new broker requests. Terminal
renewal results fence later registrations, including concurrent callers, and
sibling request cancellation retains the terminal cause. Watcher overflow also
wakes local lease observers so a signed sync revocation can hand auth back.
An explicit `agent_messaging_relay_uncertain` refusal uses the existing
30-second, cancelable shut-door retry/reconnect delay. It never transfers or
releases the protected predecessor's accepted work.

cxx 0.9.130 advertises `cache.native_scope_protocol:1` and preserves the paired
`X-Agent-Session-Id` / `X-Agent-Bridge-Token` through cache proofs and scope keys.
Clients route native reads through the existing direct proof bridge before
dispatch when an older owner lacks that capability. Expanded shared-memory and
project reads likewise require the owner's protocol-3 selection capability;
cache protocol 2 alone does not advertise those operations. Missing receipts
after dispatch still fail as unknown outcomes and are never retried.

Native-scoped MCP reads obtain a fresh server identity decision for every read.
Protocol 3 remains a compatible fresh-reply carrier for existing clients, but
neither side grants local response reuse from a host-only content grant. This
preserves bridge expiry, binding and revocation checks. Host-only local content
hits retain their existing behavior; owner-mode authorization remains RAM-based.

For high local `cxx` CPU, inspect the command as well as the executable name:
`__cxx-grok-private-reaper` is a Grok private-directory cleanup helper, separate
from `communicator serve`. cxx 0.9.129 replaces its Linux 100 ms process scans
with kernel process-exit waits; an existing helper needs to exit before the
new implementation applies. Stopping only a verified helper preserves its
private directory and does not stop the native client or communicator.

cxx 0.9.127 sends `ownership_mode: "connection"` when signed configuration
requires a provider attachment. Older configurations retain timed provider
grants. Ordinary HTTP request frames omit unset `stream_id`; the API also
accepts the empty field emitted by cxx 0.9.125.
Server response authorization permits ordinary extensions of an already
admitted insecure-host window, while still rejecting shorter or closed windows
and changed host credentials or IP policy.

## Warm-cache launches (cxx 0.9.81)

### Local content RAM cache (cxx 0.9.128, protocol 3)

Signed configs select protocol 3 for reported cxx >=0.9.128, protocol 2 for
0.9.122–0.9.127, and protocol 1 for older releases. The new client checks the
owner's `local_content_protocol:3` capability; a busy protocol-2 owner keeps its
native processes and uses the compatibility confirmation path until safe handoff.

An authorized first content read uses `/sync/cache`. The owner verifies the
correlated reply, resource digests and real host/MCP-token expiry, then retains
the complete permitted response in the existing bounded RAM cache. Subsequent
identical valid reads return locally: **no HTTP request or server confirmation**.
The key retains engine, credentials, native home and render context; JSON-RPC
request IDs are rebound for each caller. Concurrent identical misses share a fill.

Public Skills, AGENTS and configuration may use already loaded bytes while
offline, within any actual authorization deadline. Private Knowledge and project
reads require the live coherent connection. New native launches, account grants,
auth uploads, secret disclosure and other privileged actions always require live
authorization. Warm launches can reuse materialized content while performing the
existing auth-only admission; an offline cache never authorizes a new launch.

The existing push stream invalidates affected `skills`, `agents`, `config`,
`knowledge`, `projects` or `policy` scopes. Reconnect and authority changes clear
local responses. An invalidation racing a fill rejects that fill. All response
and resource bytes share the existing 64 MiB / 256-scope budget; no disk cache or
second database is introduced. Owner status exposes `local_hits` alongside the
existing cache counters. Protocol 2 below remains a compatibility contract.

Owner-mode signed configs also select `communicator_state_protocol:1`; the API
honors actual authenticated attachments when an old cached config omitted the
capability declaration. It still refuses detached or wrong-generation execution.

Resident owners load policy once and wake on policy pushes, reconnect, genuine
authorization deadlines or actual queued work. They do not poll daemon config
every five seconds. Transport ping/pong, real provider refresh deadlines and
bounded error retry remain separate from business polling.

### Server-confirmed RAM cache (cxx 0.9.122, protocol 2)

Signed configs for reported cxx 0.9.122–0.9.127 select
`orchestrator.communicator_cache_protocol: 2`; older callers keep protocol 1.
The protocol-1 description below applies only to those older callers.

Protocol 2 never treats `primed`, a connected socket, a push UUID or a TTL as
permission to serve bytes. Each selected content/auth/Skill read sends
`POST /sync/cache` with a fresh UUID and its known resource revisions. The server
runs the original authorization and read paths, using the authoritative owner RAM snapshot. The legacy unowned test adapter
uses a repeatable-read database snapshot; production reads open no transaction. Credential
exchange and account admission retain their existing transactions and refresh
owners, outside the content snapshot. A bootstrap carries its auth candidate
only once; failure to deliver the subsequent result is an unknown outcome.

The response contains fresh status, quota, account metadata and RPC IDs, plus
resource paths, SHA-256 revisions, expiry bounds and only changed bytes. The
owner reconstructs the response from its private RAM only after verifying this
request's confirmation and every resource digest. Identical bytes do not imply
identical authorization: the server authorizes every read. Requests retain
their credential, engine, account, home and render-context boundaries.

Confirmations apply to one request, with a maximum 30-second processing budget;
they are never reused as read leases. Network time consumes that budget using
the client's monotonic clock, and explicitly expiring auth further shortens
it when those bytes are retained as resources. The deadline is checked again immediately before responding. OAuth bytes
need verified metadata and an explicit future access expiry; opaque/API-key
credentials travel fresh and are not retained. Insecure hosts retain no cached
resource bytes. A verified native refresh package with expired access is fresh
inline response data, never a cache resource. Its expired access timestamp does
not invalidate the live read/admission proof; the existing engine refresh owner
and auth writers still govern its use. Skill MCP caching is limited to `skill_list`, `skill_retrieve`,
`resource_read` of `skill://` URIs and native `resources/read` of those URIs;
arbitrary MCP results, writes and auth uploads are never replayed.

The RAM cache is bounded to 64 MiB and 256 request scopes, starts empty on owner
restart, and stores no new files. Existing native auth/content writers still
maintain their normal files. Push invalidations continue to schedule content
passes, but a lost push cannot authorize stale content. A late response cannot
replace the cache from a newer request. `/_comm/status.cache` reports protocol,
bytes, entries, hits, misses and confirmations without resource bodies.

New protocol-2 native launches refuse failed or skipped content/auth checks,
including the former offline-credential fallback. Existing native processes
are not terminated. An older owner cannot silently satisfy protocol 2: clients
require the owner's confirmation header on successful selected reads.

From cxx 0.9.123, clients inspect `/_comm/status.cache.protocol` before sending
a selected request. If the owner cannot advertise protocol 2, the client obtains
the same correlated proof directly over authenticated HTTPS and reconstructs
the reply with the same hash and expiry checks. This temporary path has its own
bounded, process-local RAM cache. It lets an old owner keep serving existing
native sessions until its normal safe retirement. Writes outside the selected
read set continue through that owner with their original bodies. Non-rewindable
request bodies are classified before dispatch too. A missing receipt after an
application request has already been dispatched is still refused and never
replayed through the direct path. On 0.9.122, an old owner instead needs the
existing owner-update lifecycle before a protocol-2 launch can succeed.

A reachable
HTTPS server may still confirm a read during a WebSocket outage; an unreachable
server cannot. Freshness means the server snapshot used for this request,
not a promise that no change can occur after the snapshot.

### Legacy protocol-1 warm cache

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

Primed is relative to the newest server invalidation (a pushed `invalidate`
frame or a reconnect, which includes the reconnect after every API deploy):
a scope answers primed only while its newest complete content pass started
after that invalidation. Invalidations re-run content only for scopes with a
live lease, so a scope nobody is attached to stays unprimed until the next
launch or explicit sync performs a full exchange. Explicit `cdx sync` /
`clx sync` (and the post-update pass) never ask: like `cgx sync`, they always
run a content exchange. (Fixed 2026-10-17; earlier owners kept a scope primed
for their whole lifetime, so a host without a live session of an engine kept
pre-deploy content until `CXX_COMMUNICATOR_SYNC=1 cdx sync`.)
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

## Launch round trips (cxx 0.9.86)

Each cdx/clx launch still obtains a fresh auth/usage snapshot and a verified
account lease. When the lease confirms the same account and canonical digest
as that launch's valid, verified snapshot, the wrapper reuses the snapshot and
applies quota controls from the newer lease. A changed account or digest,
incomplete metadata, rejected candidate or unverified response retains the
additional account-scoped `/auth` request. This reuse is confined to one launch;
it is independent of managed content caching and never caches auth across launches.

Grok initializes its private runtime from the access-only projection just issued
by `/auth/sessions` when generation, token digest and expiry are present. It uses
the same account, generation, scope, digest, expiry and verification checks as a
later `/auth` response, and records the issued generation before native exec.
Older responses without that metadata still retrieve `/auth`; inconsistent
projections refuse the launch. Refresh ownership remains server-side.

The API reuses version snapshots and wrapper projections within a bootstrap
request. Credential mutations and failed reads invalidate them; the next request
still performs its own refresh.

Identity confirmation and advisory peer discovery run concurrently after bridge
registration. Confirmation still gates native exec and an unavailable discovery
still produces an explicit unavailable snapshot.

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
   new binary. An update installed by anything else (root cron, a shared install
   reporting `requires_root`, an explicit `cxx update`) is caught by the owner's
   replaced-executable check described under the local lease lifecycle.

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
server carries `"error"` with the refusal instead of an empty `"socket"`, and `doctor` fails. Status
always prints at least one line: an owner that cannot be reached, answers non-200 or
returns no JSON gets `"running":false` with `"error"`, the searched `"runtime_dir"` and its
`"runtime_dir_source"` (`XDG_RUNTIME_DIR`, `logind` or `tmp`); with the `tmp` fallback (for
example `sudo` without `XDG_RUNTIME_DIR` and no `/run/user/<uid>`) a `"hint"` names the
`XDG_RUNTIME_DIR` to retry with. From cxx 0.9.107, when the owner's `version` is a release older
than the `cxx` running `status`/`doctor`, its line also carries `"stale_owner":
{"current_version", "remedy"}`: `sudo cxx daemon install` for a `resident` owner
(it refreshes `/usr/local/lib/cxx-daemon/cxx`), otherwise `kill <pid>` so the next
managed call starts the installed binary. This is a warning; it does not make
`doctor` fail. The host's Operations tab shows
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
A long-running client (a session's supervising wrapper and its agent broker, a
`communicator mcp` server) resolves the socket at start and re-resolves it whenever a
dial fails, the same way it first did (live owner record, then the runtime root above).
When a replacement owner binds in a different root, for example after `/run/user/<uid>`
appears or after a self-update moves an owner from `/tmp/cxx-<uid>`, the client follows
it on its next call. It also waits for an owner it starts itself at that fresh path. A
session started on 0.9.90 or earlier still keeps its original path and needs a restart.

Because a lease (agent worker, host daemon, native launch) blocks that idle exit,
an on-demand owner also watches its own executable. When any `cxx update` (cron,
explicit or the updater) renames a different file over the path the owner started
from, `status` reports `executable_replaced: true`. Once no request, shared call,
sync worker or scope pass is in flight and no native agent runs for the OS user
(the updater's quiet gate, probed at most every 30 s), the owner closes admission,
drains in-flight work for up to the terminate bound and exits. Lease holders redial
and start the installed binary; a request refused while draining is a definitive
"not sent". Residents are replaced by the root handoff instead.

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

### Content-change notices (cxx 0.9.96)

A running model loaded its instructions and Skill list at startup, so a pushed
content pass alone never reaches it. Every `bootstrap`, `content` and `skills`
worker therefore digests the files it may rewrite before and after the pass,
per kind:

| Kind | Codex | Claude | Grok |
|---|---|---|---|
| `instructions` | `$CODEX_HOME/AGENTS.md` | `~/.claude/CLAUDE.md` | `$GROK_HOME/AGENTS.md` |
| `skills` | `/skills` fingerprint (`skills-digest`) | `/skills` fingerprint (`clx-skills-digest`) + `~/.claude/skills` | `~/.cgx/state/skills.json` |
| `config` | `config.toml` | `settings.json`, `agents/`, `commands/`, `output-styles/` | `config.toml` |

When any digest moved, the worker publishes one opaque generation under
`~/.cache/codex-orchestrator/content-notices/<engine>-<scope>` (the
`authnotice` mechanism, without content). Claude content passes now also refresh
the `/skills` fingerprint, because MCP-served Skills leave no file behind.
`~/.claude.json` is not digested: Claude Code rewrites it on its own.

Delivery uses the same boundaries as credential notices: the next managed agent
MCP tool result for all engines, and the Claude `UserPromptSubmit` hook. Each
session gets a generation once. The notice includes the generation SHA-256 and
a short summary of the changed categories with each category's SHA-256. Its
ledger retains category fingerprints in a digest-only companion file while
keeping its generation file compatible with older consumers, so a later
settings-only change does not repeat advice for instructions or Skills the
session was already told about.
It is told to re-read the instructions file, to
call `skill_list` again (Grok: re-read `~/.grok/skills`), and that config changes
apply on the next launch. A session primes its ledger when its broker starts, so
content it launched with never triggers a notice. A newer generation that lands
before a session read the previous one keeps the earlier kinds. Notices expire
after 24 hours and never signal, restart or count as native adoption.

Idle hosts have no owner to receive the push once the on-demand owner idles out.
They converge at the next launch or nightly `cxx cron run --due`, unless the
resident runtime keeps content scopes alive (see
[communicator-resident-runtime.md](communicator-resident-runtime.md)).

## Protocol and failure handling

`GET /host/communicator/connect` upgrades to WebSocket protocol 1, authenticated
with the host key and the existing IP policy. Every frame still performs fresh
authorization. Its host row, API kill switch and inherited reverse-DNS default
come from one database admission snapshot; the latter is evaluated at that
snapshot rather than after any IP-binding write. Compiled query plans retain no
credentials or result rows, and the 15-second connection recheck remains active.
A `hello` identifies protocol,
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
also return a correlated unknown-outcome error. From cxx 0.9.91 the data also carries
`retryable`: true only for a local `503 communicator_unavailable`, which the owner
returns solely for a request that never reached the control channel (the connection
was down or redialling), with a message saying it was not sent. Every tool, including
`secret_*`, takes the same `POST /mcp` path, so a short redial window can fail one call
while neighbouring calls succeed; the caller retries, the adapter still does not. Error conversion never forwards
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
daemon launched, a daemon stop (`POST /admin/daemon-sessions/{id}/stop`). Managed native launches from cxx 0.9.85 also support the identity-bound native stop (`POST /admin/agent-sessions/{id}/stop`) described below.
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

### Topology workspace and native stops (0.9.85)

The topology inspector opens technical fields on demand. Chat and Spawn reuse the Clients workspace; filters and collapsing change only presentation and never infer a parent. Server edges use solid/dashed/dotted patterns for reported resident/on-demand/unknown mode; stale reports remain visibly stale. Color represents connection health independently of mode.

Native-session process stop is a separate session-bridge protocol, not a communicator terminate frame. It binds to the wrapper's random process instance and the session binding generation and uses the negotiated state stream independently of model turns (only captured legacy processes retain polling during drain). Only the process-owning supervisor signals the native child (TERM, then KILL after five seconds). A communicator restart cannot retarget a stop. The wrapper's exit receipt is distinct from a transport close or a server-side record close. See the API contract for receipt and recovery semantics.


### Coordinated owner cutover: active legacy processes

From cxx 0.9.126, relay registration advertises `control_state_protocol: 1`
when the signed communicator configuration enables it. Such relays require the
state stream and do not fall back to HTTP polling when the local endpoint fails.
Older detached relays can make authenticated empty waits, without discovering
or claiming work, so reconnect errors do not cause repeated registration writes.

A coordinated owner cutover preserves already running native processes. The new owner captures an explicit boot manifest of their existing session, native instance, receiver, and already accepted claim identities. Legacy heartbeats renew only volatile drain credentials for those captured identities. They do not create WebSocket presence, replace a native instance, accept an old unaccepted offer, or acquire new work. A receiver may reconnect only for the same captured native transcript and binding. Security policy, host credential, engine eligibility, fixed session expiry, explicit exit, and revocation continue to fence the drain. An expired bootstrap credential requires authenticated host recovery for that same lifecycle.

Pre-cutover timed provider account leases are a bounded compatibility exception: their old processes continue the existing durable expiry renewal until release or expiry. They are not silently upgraded, and historical expired rows are never revived. The owner drain diagnostic `legacy_timed_provider` counts the unexpired timed cohort; `legacy_sessions` and `legacy_relays` count captured lifecycle records. Report legacy traffic separately from the negotiated protocol cohort. Universal zero idle SQL cannot be claimed while timed legacy provider renewals remain; negotiated connection-owned Codex, Claude, and Grok idle traffic must independently produce zero SQL.

Managed host MCP calls use the session's private Unix broker to inject authenticated native session headers. Bridge credentials remain in the broker, never in model-visible tool arguments. The server validates the session against the authenticated host and engine before exposing the native principal to board/resource operations. Requests without native proof retain ordinary host tools but cannot claim native-owned work.


### Communicator-owned local stream liveness

With `communicator_state_liveness_v1` in `ready.control`, a communicator may send
`capabilities.state_liveness: "communicator"`. Only the server's
`state_liveness_ready` acknowledgement enables local handling. The server then
stops its per-stream ping loop. The communicator's existing 15-second transport
ticker sends local Unix-socket pings, consumes their pongs locally, and reports
only attachment closure upstream on failure. Native clients retain their
45-second read deadline, so a stalled communicator cannot preserve stale local
authority. The parent connection keeps its existing 45/50-second failure bounds;
security deadlines and revocation notifications remain independent.

Older communicators and standalone state streams retain server ping/pong.
The shared protocol applies equally to Codex, Claude, and Grok; transport
liveness does not prove task progress or successful execution.


### Communication acknowledgement ambiguity (0.9.133)

Peer acceptance and native exposure are separate phases. Unconfirmed acceptance
remains tracked under its original claim during reconnect; informational auto
release, `agent_listen` and work result handling cannot complete an unexposed
delivery. Exact acknowledgement reconciliation precedes the first native send.
Unknown native submission is never repeated. No additional idle network poll or
background SQL loop is introduced; reconciliation runs only for pending admission.
Process loss retains the server's unknown/ambiguous outcome rather than inventing
completion or resubmitting the work.
