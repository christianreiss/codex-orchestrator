# Authoritative control-plane owner

The API owns current orchestration state for one MySQL database. MySQL stores
committed changes and cold history; it is not polled to discover changes the API
itself made. This refactor is under integration validation; the production
cutover and full fleet idle acceptance matrix have not yet been completed.

## Ownership and commands

A dedicated connection holds a database-specific MySQL named lock. The API
migrates and hydrates a bounded, typed metadata snapshot before accepting
requests. Every durable command uses that same connection. Losing it fences the
owner: reconnecting a pool connection cannot give old RAM authority again.

Normal API startup also acquires a kernel lock in the shared storage directory.
The API retains that file descriptor after the lock helper exits, including after
database ownership is lost. Another API using the same storage cannot start until
the old process drains its filesystem effects and closes, or exits. The lock file
is never unlinked. Runtime images include `flock`; an unavailable storage lock
fails startup before database migration or effect admission.

Commands serialize authorization, prepared metadata, explicit SQL writes, audit,
receipt and outbox intent. COMMIT precedes RAM publication, notification and
acknowledgement. An uncertain commit or failed publication fences the process.
A stable principal/request ID replays its committed result only after current
authorization succeeds. Background deadlines run outside the triggering HTTP
request's authorization and action context.

Bodies, encrypted credentials, attachments and retained history stay out of the
public metadata snapshot. Explicit content/history reads may access storage.
Active signing KeyObjects live in an owner-scoped private registry populated at
startup. Readiness checks use the verified migration ledger, current ownership,
and observed runner state, rather than querying or probing on each request.

## Runtime metadata budget

The hydrated store carries its configured limits into command validation:
100,000 rows per table, 500,000 total rows, and 256 MiB of projected metadata by
default. New and changed rows are projected first, including credential-proof
invalidation, then measured in serialized UTF-8 bytes. Immutable unchanged rows
reuse their measured size; validation reads cached table counts and sizes.
Derived messaging aggregate rows count toward the total and byte budgets.
Embedded metadata contributes its bytes. Boot additionally bounds the temporary
rows read to build derived indexes, so boot admission can be stricter than a
running store's row count. These are metadata limits, not an exact process-RSS cap.

Oversized prepared state is refused before COMMIT, including when generated IDs
finalize the draft after SQL writes; the transaction rolls back and publication
remains unchanged. The store never evicts uncertain work or leases to make room.
Removal or smaller replacement metadata restores capacity through an ordinary
command. Raising a configured limit requires a deliberate capacity decision.

## Connections and deadlines

`control_state_v1` binds authenticated communicator connections to server epoch,
native instance and binding generation. Local communicator sockets carry client
presence and state changes. Transport ping/pong has no SQL side effect.
Connection loss, token expiry and session ending do not prove native process
exit; offered and accepted execution identities remain excluded until their
explicit outcome or supported reconciliation.

Provider leases with host ID zero belong to the API's own inference tasks.
After obtaining exclusive storage and database ownership, startup removes only
their connection-owned leases from the previous API. This releases obsolete
account load and permits pending account removal. Remote native leases and
legacy timed leases keep their existing recovery rules; no work is re-executed
by this cleanup.

Old running processes have an explicitly captured drain manifest. Its exact
credential, instance, generation and native identity may be renewed in volatile
memory. Legacy observations have their existing freshness deadlines and notify
the same maintenance scheduler when they change or expire. They never enter the
new WebSocket presence registry or authorize new connection grants.

Workers maintain known obligations and their next actual deadlines. No work
means no timer. Wrapper publication and media-job discovery use filesystem
events; media retries have finite individual retry deadlines. Event-stream
failure is surfaced instead of silently falling back to directory polling.

Retention wakes on eligibility changes and actual age deadlines. Contact-only
updates do not repeatedly reopen already protected history. Messaging maintenance
uses status indexes for actionable work rather than traversing retained messages.
An authenticated detached legacy relay can wait for an empty response, with
identity and authorization rechecked before delivery. It cannot discover or claim
new work through that compatibility path; modern relays still require attachment.

## Buffered telemetry and files

Gateway API-key usage counters coalesce for 30 seconds and flush during orderly
shutdown. There is no flush timer without dirty usage. A crash can lose the
unflushed approximate counters; authorization, key revocation, delivery and
receipts are never buffered. User/hostname registration persists actual changes;
repeated sync observations update volatile last-seen data without SQL.

Upload chunks are compared against existing bytes on retry and fsynced before
metadata publication. Sealing commits the media-job outbox intent with the
attachment digest. Job publication is idempotent for that attachment and digest;
it can replay after a lost ACK. Other external effects remain uncertain after an
ambiguous dispatch unless their receiver contract explicitly permits replay.
Attachment retirement commits before physical deletion.

## Maintenance and rollout

Provider quota collection runs within the API owner. The standalone quota-cron
service is retired. Signing-key import/rotation and mutating migration commands
require exclusive ownership with the API stopped; their writes use the lock
connection. Read-only key listing and migration checks may coexist.

Deployment builds first, stops the old API and retired quota writer, migrates,
and starts the replacement. Installation imports the signing key before the
API starts. A production rollout must retain its previous image and a
quiescent database backup. Before new work is admitted, rollback can restore
that pair. After admission, preserve new durable receipts and work; use forward
repair rather than restoring a stale backup over live execution history.

See [Owner cutover and recovery](owner-cutover.md) for the private backup bundle,
pre-start restore commands and the mandatory forward-repair boundary.

## Protected response completion

A successful protected HTTP read revalidates the current owner and captured
principal immediately before sending, after any SQL or file await. Binary streams
revalidate each chunk at the actual response write, including chunks buffered before
backpressure; raw event streams use the same transport guard. Final serialized
payloads are checked after all response hooks and again before headers and bytes
are handed to the transport. Revocation before headers returns a safe error; after
headers it closes the response without handing over further content. Bytes already
handed to the transport cannot be recalled. Admin role
or session changes, host key/policy changes, bridge binding changes and absolute
security deadlines therefore cannot turn an earlier admission into permission to
send stale protected content. Request proofs also participate in command enqueue
and pre-COMMIT validation.

A durable self-authority action may explicitly declare `responseAuthorization:
'commit'`. Its HTTP route must separately declare `ownerResponse:
'committed-action'`; only successful COMMIT allows that action result to be sent
after its old credential/session becomes invalid. Unrelated later commits do not
invalidate the receipt. Audit observations and automatic session renewals never
opt in. This contract is for the action result, not arbitrary subsequent reads.
MCP isolates each JSON-RPC item and matches its final result by position and exact
serialized value. Revoked read results become authentication errors without
withholding a sibling's committed replacement credential. Each new RPC item
reauthorizes before dispatch, so a self-revoking mutation cannot authorize later
filesystem or tool work in the same batch.

## Dashboard and Companion metadata

Admin host lists, installer status and connection presence read owned metadata.
The latest audit timestamp is hydrated once and advances with the same command
that inserts the audit through `persistAuditLog`; rollbacks cannot publish it.
Audit bodies stay cold. Retired `agents.retrieve` activity counters remain zero
compatibility fields and no longer query the removed signal.

Companion retains per-session event heads, total assistant replies and the latest
256 assistant event IDs, including retained ended sessions. Aliases combine these
physical-session indexes. Current/recent unread cursors are exact in RAM; an older
partial cursor performs an explicitly requested historical count. Requested preview
text remains encrypted cold content and is never put in shared public artifacts.

Legacy auth rows without an explicit canonical head receive a body-validation
proof during bounded boot reads, using the original credential validator. The
proof retains no credentials and binds the digest, engine, refresh timestamp and
ciphertext hash. Canonical inserts derive the same proof; changed bytes or identity
invalidate it. RAM selection rechecks verification/account state and the moving
future timestamp limit. Explicit canonical heads keep their existing authority;
these derived proofs never promote a database head.

Version summaries, API surface routing, active key counts and surface kill switches
read committed owner metadata directly. Setting and key changes apply immediately;
owner mode has no routing TTL or database-error fail-open. Command receipt lookups
revalidate volatile authorization after I/O before replaying a stored result.

Admin AGENTS previews use current host metadata and explicitly read only the
credential fields needed to preserve recoverability-dependent feature rendering.
They reject a host change during that read; credential bodies never enter shared
metadata. This requested content read is separate from routine metadata reads.

## Acceptance

Required acceptance includes the full canonical and database suites, restart,
revocation, duplicate/lost ACK and uncertain-commit interleavings, plus a real
10-minute idle matrix at 1/20/200 communicators, all three engines and 0/1/5
admin tabs. Measure application SQL separately from measurement queries and
MySQL administration. The target is exactly zero idle application statements,
API CPU at most 1% of one core and incremental database CPU at most 0.5%.
Short service loops and simulated-clock tests do not establish that acceptance.
