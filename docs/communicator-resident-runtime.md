# Resident communicator implementation

cxx 0.9.80 includes the unified runtime behind an independent, default-off
signed capability. Source integration does not enable it or deploy it. Provider
and production migration acceptance remain separate activation gates.

## Settings and compatibility

Host daemon settings accept optional `resident_enabled`. It defaults to false
when read or first stored. An omitted value in a legacy settings PUT preserves
the stored value under the host/daemon transaction locks. Explicit false clears
residence without clearing remote execution. Existing `enabled` remains the
remote-execution switch. Residence alone never admits a remote session.

`CXX_COMMUNICATOR_RUNTIME_ENABLED=false` is the default. Enabling it includes
`orchestrator.communicator_runtime_protocol: 1` in signed wrapper configurations,
independently of the transport and sync capabilities. Do not enable the flag
before migration acceptance. Older wrappers ignore this optional field. Residence-only installation waits
for that signed support; it does not install an inactive legacy execution daemon.

The Operations panel saves residence separately from remote starts. A request
with runtime support disabled is pending, rather than proof of a running service.
Timed execution expiry preserves explicit residence without renewing the deadline.

## Runtime and commands

`cxx communicator run` hosts the local socket, control connection, sync scheduler
and an injected remote execution controller in one process. `install`, `start`,
`stop` and `uninstall` retain the existing `cxx-daemon.service` and protected
`/usr/local/lib/cxx-daemon/cxx` copy. The `cxx daemon` commands remain compatible;
`daemon run` selects the unified service only with the signed runtime capability.
`communicator status` and `doctor` report actual local mode, owner UUID, binary
SHA256, draining state, residence/execution policy and controller workload.

On-demand owners still idle out after five minutes without clients or finite
work. Managed residence keeps content-only scopes for configured, enabled Codex,
Claude and Grok engines. Account/session authentication is registered only by
existing native session lifecycles; residence never acquires provider leases,
logs in, refreshes canonical auth or changes Grok's server-owned refresh.
Transport-disabled residence uses direct HTTPS and the existing daemon WebSocket;
turning off transport does not enable it through the residency flag.

The execution controller uses the existing native launch grammar, durable claims,
operation journals, receipt retry, engine readiness and per-session writer locks.
Its fence blocks new permits without canceling accepted work. An unreadable local
receipt directory is unverified, never an empty queue. Remote owner termination
is refused while execution, receipts, finite sync/write work or dependent legacy
clients remain. The unified systemd unit uses `KillMode=process`; remote stop
preflight still requires accepted remote work to drain. Explicit systemd or legacy
daemon stop retains its existing interruption semantics.

## Namespace and adoption

Namespace identity includes UID, orchestrator URL and runtime root. Default logind
and XDG-unset clients share a coordination lock and a verified owner record;
explicit custom roots remain independent, including hashed long-path fallbacks.
Discovery checks directory/file ownership and modes, rejects symlinks and validates
the live socket's kernel UID/PID against its owner response. Records never authorize
signalling a PID or removing a socket. Stale discovery needs an existing safe,
unheld namespace lock; unavailable occupied namespaces defer.

A resident service can adopt a compatible idle on-demand owner. It stages the
actual source and candidate executable bytes, persists the transition identity,
asks the exact owner to prepare, records confirmed quiet/fenced readiness, and
commits that same request. Linux pidfds prove actual exit before exclusive new
ownership. A lost preparation response defers; a lost commit response is resolved
only by kernel exit evidence. Incompatible owners and pre-fix idle zombies cannot
receive this protocol and remain untouched.

## Service migration

The host-authenticated `POST /host/daemon/migration` accepts a UUID `request_id`
and `command: fence|status|release`. A migration fence serializes with durable
operation acceptance and peer admission. It preserves enablement, queues, accepted
results, resumable sessions and legacy settings updates. Another ID cannot remove
it. Readiness counts running sessions, accepted operations and leased/accepted peer
messages; local preparation independently checks receipts, workers and clients.

Compatible systemd updates retain immutable binary and unit artifacts and a root
journal. They verify the actual systemd MainPID, OS user, boot/start identity and
running executable hash, rather than assuming the installed path names the running
bytes. Migration proceeds through observed, staged, fenced, draining, handoff_ready,
replaced, verified and reopened. New owner identity, executable bytes and unit are
verified before admission release. Failures retain the same journal and fence;
retrying install reconciles a previously started target before any further start.
No fresh native work is replayed to repair an uncertain handoff.

Execution-only residence remains an install/retry intent while migration masks
effective execution, and expiry still applies. Existing lease clients advertise
runtime-aware reconnection only under the signed runtime capability; other leases
remain a legacy-client blocker for handoff.

The automatic service path defers incompatible/unresponsive predecessors and
custom systemd runtime namespaces instead of guessing their identity or rewriting
the namespace. `cxx communicator rollback` reverses a completed compatible transition with a separate durable ID, using the retained source binary and unit. Repeating rollback verifies the same restored target; it does not toggle versions. Keep the compatible runtime capability signed until that reverse handoff is verified. Incompatible legacy rollback targets and custom namespace changes remain deferred.
Do not treat a successful unit install or WebSocket close as a verified migration.

## Acceptance and integration

The implementation is integrated with the verified 0.9.79 audit source
`839c0a1b`, preserving startup, explicit credential recovery, native-entry
ownership guards and idle relay polling corrections.
The isolated systemd lab verified installation, compatible updates, rollback,
repeated rollback and recovery from failed admission release without restarting
the target. It used signed configurations with execution disabled and a stub API.
Separate composed-process race fixtures verify native continuation, writer
exclusion, busy stop refusal, receipt recovery without replay and actual quiet
exit for every engine, using provider executables as fixtures. Isolated MySQL
regressions verify real migration/acceptance ordering and peer lease fencing.
See [verification evidence](verification/communicator-residency-2026-10-14.md).
Negotiated dashboard owner metadata is implemented; its reporting/control
corrections passed Raffaela's source review. Broader migration activation and
any required real-provider acceptance remain pending. Production rollout is
a separate action.

## Unprivileged update handoff

With residence and the signed update capability, the resident updater cannot
replace the root-owned `/usr/local/lib/cxx-daemon/cxx` itself.
`cxx daemon install` (root) therefore also installs:
- `cxx-daemon-update.path` and `cxx-daemon-update.service`, a root oneshot
  with the service's `HOME` and signed config paths
- `/var/lib/cxx-daemon/requests/`, owned by the service user, mode 0700

After the quiet-gated `cxx update` has installed the user's binary, the
updater writes `update.json` (`request_id`, `version`, `sha256`, `source`).
The oneshot (`cxx daemon apply-update`) then:
- accepts the request only from the unit's `User=`
- requires an unexpired signed config naming exactly that version and digest
- requires a version newer than the running service; rollback stays
  `cxx communicator rollback`
- stages the bytes root-owned through `residency.StageBinary`, hashing the
  copy rather than the path
- runs the existing journaled `daemon install` migration from that copy

A failed or uncertain handoff keeps its journal and fence; nothing is
replayed. The oneshot runs the installed service binary, so every existing
resident host needs one `sudo cxx daemon install` with cxx 0.9.81 or newer
before handoffs become automatic: older services lack both the units and
`daemon apply-update`. The isolated systemd lab acceptance for this path is
still pending.

## Actual owner diagnostics

The negotiated `resident_runtime` control extension publishes a bounded
`resident_status` report after identity capabilities and on the existing
15-second heartbeat. The registry binds the report to the exact connection and
process UUID, orders it by per-connection sequence, and clears it on identity
change or unregister. Invalid and future diagnostic frames are ignored while
the existing heartbeat authorization, request relay and targeted stop remain
intact. Owner-wide sampling is coalesced outside the heartbeat loop; late
samples are omitted, and report writes are bounded to two seconds. Receipt
scanning runs outside the admission mutex with snapshot/permit revisions
preventing stale work from being declared verified idle. The live topology panel displays mode, running binary
SHA-256, residence/execution policy, draining/fenced controller state and retained
work, with independent 45-second freshness and explicit self-report wording.
Older servers receive no additional fields or frames. This projection never
participates in migration readiness, successor linking or exit proof.
