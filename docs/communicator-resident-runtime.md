# Resident communicator implementation

The unified runtime is being prepared behind an independent signed capability.
This document describes the implemented preparation and the remaining integration
gate; it is not a fleet deployment receipt.

## Settings and compatibility

Host daemon settings accept optional `resident_enabled`. It defaults to false
when read or first stored. An omitted value in a legacy settings PUT preserves
the stored value under the host/daemon transaction locks. Explicit false clears
residence without clearing remote execution. Existing `enabled` remains the
remote-execution switch. Residence alone never admits a remote session.

`CXX_COMMUNICATOR_RUNTIME_ENABLED=false` is the default. Enabling it includes
`orchestrator.communicator_runtime_protocol: 1` in signed wrapper configurations,
independently of the transport and sync capabilities. Do not enable the flag
until the unified runtime and migration acceptance are complete. Existing
wrappers ignore the additional optional field.

The Operations panel stores residence separately from remote starts. A request
for residence with runtime support disabled is displayed as pending, rather than
as a running service. Timed execution expiry preserves explicit residence and
does not renew the existing execution deadline.

## Execution-controller preparation

The daemon loop accepts an injected framed stream and HTTP transport through
`ResidentController`; its legacy entrypoint uses the existing transport adapter.
Native launch grammar, journal/claim identifiers, receipt retry, per-session
writer locks and engine readiness remain in the existing execution machinery.
Fencing prevents new admission permits without cancelling existing work.
Peer claim requests count as outstanding work until processing finishes. Status
includes local operations and peer receipts; unreadable state is unverified,
never an empty queue. Transport injection does not confer account admission or
provider-refresh ownership.

## Migration primitives

The residency package distinguishes default logind/XDG-unset clients from
explicit custom roots. Namespace keys include UID, orchestrator URL and runtime
namespace. This is an identity primitive, not a change to canonical socket paths.

Migration proceeds through observed, staged, fenced, draining, handoff_ready,
replaced, verified and reopened. Readiness needs a verified workload with no
accepted execution, claims, children, receipts, writes, active requests or
dependent legacy clients. Replacement additionally needs proven source exit and
exclusive target ownership. Verification must precede admission reopening.

Protected journals retain a transition UUID, executable hashes, owner identities
and phase. Atomic compare-and-write preserves identity on lost acknowledgement
retries and refuses another transition. Immutable staging verifies source bytes
and uses digest-named artifacts without overwriting the running service binary.

## Remaining integration and acceptance

Dorothea controls the verified integration base, owner-control dependencies and
release allocation. Existing owner-control, topology, MCP and startup audit
changes must converge before runtime wiring. An acknowledgement or WebSocket
closure is not process-exit proof. Pre-fix zombies without a connect loop cannot
receive new termination control and defer automatic migration.

Still required: resident owner/service composition, cross-path exclusion and
rendezvous, persistent content scopes, admission fencing across server paths,
safe service handoff/recovery/rollback, actual owner status, all-engine systemd
acceptance, and canonical repository checks. Production rollout is separate.
