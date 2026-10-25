# Stateful orchestrator redesign

Status: implemented, pushed and deployed; quiet-path production verification passed.
Outstanding external prerequisite: Grok subscription re-login, pre-existing since 2026-10-24.
Decision date: 2026-10-25. Target: the existing docker01.uggs.io stack and its managed wrappers.

## Product goal

Keep every existing function. Remove the machinery that manufactures work when
nobody requested anything. Auth, Skills, Knowledge, configuration, updates,
WebUI, agent communication, remote execution, Wake/Cron, projects, Git Director
and workflows remain supported for Codex, Claude and Grok.

The ordinary read path is:

```text
Agent -> Communicator RAM -> only when necessary, server RAM
```

The server is already the sole application writer. Its current in-memory state
must therefore be the runtime authority. MySQL supplies startup state and durable
storage; it is not another participant that must confirm each decision.

The operator's floppy-disk, Raspberry Pi and two-second startup examples express
proportionality, not literal capacity or timing requirements. Likewise,
"survive without SQL" describes how little normal runtime work should need SQL.
It does not authorize a second database, filesystem journal, offline-write queue,
failover service or a new multi-day DB-outage availability project.

Silence must remain silence. A cache hit must avoid a network request, not merely
reduce the bytes in a request that still happens.

## Evidence behind the redesign

The 2026-10-25 investigation measured 82.43% of one CPU core for MySQL over a
30-second production sample. One recurring scope-retention query had accumulated
about 1.3 billion examined rows over 183 executions, averaging about 7.9 seconds.
Those figures describe that sample and statement history, not a permanent load.

Source inspection also found:

- Cache protocol 2 confirms every cached read with `POST /sync/cache`.
- A resident communicator requests `/host/daemon/config` every five seconds.
- Contact observations and receiver connect/disconnect activity produce durable
  transactions and command receipts.
- Small current document bodies are repeatedly fetched through SQL even though
  their canonical identities are already known in RAM.
- Changes to unrelated state can reopen guarded retention work that deletes
  nothing.

The measured current Auth, stored Skills/files, configuration and AGENTS bodies
were roughly 446 KiB together. This excludes Knowledge, host metadata and CLI
binaries; it is not a complete database-size claim.

A preliminary SQL-materialization patch was withdrawn without deployment. This
work replaces the underlying runtime behavior rather than tuning that query.

## 1. One owner state, three execution paths

| Operation | Runtime behavior | Persistence |
| --- | --- | --- |
| Read current content or metadata | Authorize and answer from current owner RAM | None |
| Observe transport presence or activity | Serialized volatile RAM update | No SQL or durable receipt |
| Make a genuine durable change | Validate, persist, publish, acknowledge | Explicit transaction |

### Runtime state

- Load current Auth payloads, Skills, Knowledge, configuration, rights and required
  work metadata at startup. Historical versions, completed logs and CLI binaries
  remain outside the current-document working set.
- Keep current document bytes privately within the same owner state. Credential
  bytes must not become public metadata or leak through state broadcasts.
- Update content, metadata and derived indexes together. A successful content
  mutation must not require a subsequent SQL read to discover what was written.
- Unknown resources are answered from the complete current catalogue. A normal
  miss does not trigger a speculative SQL lookup.
- Reuse unchanged immutable state and indexes. Do not clone, hash or scan the
  entire application state on a heartbeat or cache hit.
- Account for private content in the existing state budget. Do not silently
  discard unresolved work or weaken integrity checks to fit a limit.

### Volatile observations

Presence, ordinary contact timestamps, receiver attachment state, activity
indicators and unchanged daemon observations are volatile. They neither create
receipts nor advance the persistent commit counter. Identical observations are
no-ops. Volatile publication and durable commit revisions are separate.

Actual native-identity changes, accepted work, delivery outcomes, auth changes
and security-relevant transitions remain durable. A transport disconnect or an
elapsed heartbeat is never proof that a native process exited.

After restart, volatile presence is reconstructed by reconnecting communicators.
Never manufacture a confirmed exit, delivery result or accurate last-contact
observation from missing transport evidence. Absolute security deadlines retain
their existing meaning.

### Durable changes

- Retain commit-before-publication and commit-before-acknowledgement.
- Preserve stable request IDs, digest conflicts, uncertain outcomes and external
  side-effect fencing for real retryable mutations.
- Remove the unconditional receipt SELECT before a new mutation. Use existing
  RAM knowledge and the durable uniqueness constraint; reconstruct a stored
  result only on an actual duplicate/recovery path.
- Do not execute external effects before their durable acceptance. A lost ACK
  must not cause a second execution.
- Unchanged content and updates with no durable change produce no transaction.

### SQL boundary

SQL is explicitly attributable to startup/migration, a durable mutation,
requested historical content, duplicate-result reconstruction or real
maintenance. Ordinary current reads, cached reads, health checks and presence
observations have no automatic SQL fallback.

The generic database handle must cease to be an implicit dependency of runtime
decisions. Current-state reading and durable/history storage are distinct
interfaces. Regression checks must catch unclassified SQL, rather than accepting
a quiet-looking average hiding an expensive periodic query.

## 2. Event-driven work and retention

- Maintain active, paused and unresolved references in RAM. The metadata required
  to protect work must be complete even when its historical body is cold.
- Decide eligibility from this state. Replace nested SQL protection scans with
  bounded deletion of already identified rows.
- Protected history rests until a relevant reference changes or a genuine
  eligibility deadline arrives. Unrelated contacts and metadata changes do not
  reopen it.
- Wake a worker only for new work, a relevant state change or its next known
  deadline. No work means no application polling timer.
- Provider refresh, necessary authorization renewal and quota collection are
  explicit special cases, scheduled from actual demand and deadlines. Repeated
  unchanged results or freshness timestamps alone are not durable changes.
- Preserve the effective retention policies: 14 days audit, 24 hours inactive
  history, seven days optional quota history; existing protected-state
  exceptions and host-specific housekeeping overrides remain.
- Preserve safe batch limits, canonical heads, paused schedules, active native
  sessions and ambiguous work. Retention must never resolve uncertainty by
  deleting it.

## 3. Communicator cache protocol 3

Use the existing authenticated communicator connection and change stream, not a
second coherence service.

1. Connect and perform one authenticated state/version-manifest exchange.
2. Fetch missing content and retain the permitted current versions locally.
3. Answer valid local content hits without contacting the server.
4. Deliver actual relevant changes as targeted push updates or invalidations.
5. After reconnect, epoch change or detected revision gap, reconcile once and
   fetch only what is missing or changed.

Cache identity includes server, host, OS user, engine, account where applicable,
permission context and resource revision. Do not share private state across
identities. Resource versions change for content or authorization changes, not
for unrelated global activity.

Skills, configuration and eligible Knowledge reads are content operations.
New agent admission, mutation, secret disclosure and external execution remain
real server actions. Cached content must never replay an admission or action
result. Correlation/RPC IDs are reconstructed for the current local caller.

Replace per-hit confirmation, five-second resident-config polling and unchanged
metadata broadcasts. Keep only minimal transport keepalive with zero SQL,
receipt, invalidation or maintenance side effects. Do not substitute another
short periodic cache-validation timer.

On connection loss, already loaded Skills and configuration stay available.
New starts and privileged actions wait for an authenticated resynchronization.
Running native processes are not terminated. Real credential expiry remains
binding; Grok refresh ownership and access-only runtime projections remain
unchanged.

Protocol 2 remains a transition adapter for already running clients. Its incoming
observations must also use the new volatile server path. Bump the wrapper release
and build/sign the existing Linux amd64/arm64 and Darwin amd64/arm64 matrix.

## 4. Verification gates

The tests must demonstrate preserved behavior and absent unnecessary work.

- **Quiet matrix:** 1/20/200 communicators, all three engines and 0/1/5 open admin
  tabs. Once initialized, no repeated business requests, application SQL or new
  bookkeeping rows without a genuine cause. Transport keepalive is separately
  counted.
- **Warm cache:** 10,000 content reads remain local. A change affects only the
  appropriate resources and authorized communicators. Test deletion, revocation,
  scope isolation, reconnect, epoch change and missed revisions.
- **Admission/security:** a new launch receives one central admission. Check host
  and account separation, real expiry, API/engine switches, secret access and
  Grok's sole refresher.
- **Execution/restart:** preserve accepted, paused and uncertain work through
  server restart, disconnect and communicator handoff. Lost ACKs do not replay
  effects. Native processes, including unmanaged but active ones, are protected.
- **Retention:** eligibility is decided in RAM; protected history does not cause
  recurring SQL scans. Actual deletion preserves effective policy and overrides.
- **Build/compatibility:** Node 22 typecheck, lint, API tests, full isolated MySQL
  integration, production build, Go tests/build/vet, four-platform wrapper build,
  frontend checks and affected browser scenarios. Exercise mixed installed DB
  collations and old/new client combinations.

Measure CPU, memory, application SQL by reason, business network frames and
actual pending work together. Distinguish controlled idle tests from production
samples containing real activity. Startup time is reported, not compared against
the operator's illustrative two-second estimate. Do not claim physical Raspberry
Pi verification without testing one.

Unclassified SQL, recurring empty sweeps, remaining idle pollers or broken
functional tests prevent acceptance. Do not redefine success as merely being
better than the previous 100%-CPU incident.

## 5. Delivery, deployment and follow-through

1. Record source/image, current load, active native bindings, open/uncertain work
   and protected settings. Preserve pre-existing changes and keys.
2. Implement and validate the complete new path in an isolated stack. No further
   production rollout of an isolated query-tuning workaround.
3. Update the API/DB/wrapper contracts, architecture documentation, changelog and
   any affected WebUI behavior. Keep schema migrations additive and idempotent.
4. Integrate verified task-owned changes into `main`, push and verify the remote
   SHA. Boot the exact production image with its normal command before cutover.
5. Deploy API and wrapper artifacts through the supported quiescent deployment
   path with `--no-backup`. Create no SQL dumps or storage archives. Preserve auth
   encryption and signing keys.
6. Use the existing safe owner handoff only when the owner is verified quiet.
   Busy legacy owners drain without killing native sessions. Identify remaining
   legacy owners explicitly; no idle old poller may be hidden in a success claim.
7. Verify deployed source parity, health/readiness, `cdx/clx/cgx` auth and native
   startup, Skills/Knowledge, targeted invalidation and one complete work
   lifecycle. Startup tests need no paid inference prompt.
8. Replay the original load case and the warm-cache checks against the deployed
   system. Attribute any remaining SQL/network activity to actual work, fix
   unexplained activity and repeat the relevant checks.
9. Deliver `/root/orchestrator-quiet-check.sh` and a secret-free results receipt
   containing SHAs, measurements and any open transition items. This is a
   repeatable diagnostic, not another cron, watchdog or monitoring service.
10. Finish only after the required functional and quiet-path gates pass. There
    is no 24/72-hour waiting phase. Preserve accepted work during recovery: use a
    proven-compatible image or repair forward; never roll production data back
    over newly accepted requests or results.

## Implementation status

This section records scope, not an acceptance claim.

- [x] Complete volatile/durable separation and remove bookkeeping writes.
- [x] Keep current content and Knowledge reads in owner RAM.
- [x] Replace SQL-based protection discovery with maintained RAM state.
- [x] Implement communicator-local cache hits and targeted protocol-3 updates.
- [x] Remove default polling and broad/no-op invalidation chains.
- [x] Pass functional, security, restart, quiet and compatibility checks; four-platform publication is verified during the rollout.
- [x] Push, deploy, verify and deliver the repeatable quiet-check/report.
- [ ] Confirm Grok live admission after the operator completes its pre-existing required subscription re-login.

The existing `.env.pre-advisor-20261017` is unrelated pre-existing data and must
remain untouched and uncommitted. No new redesign code has been deployed at the
time this plan was first documented.

Verification evidence is recorded in [docs/redesign-verification-2026-10-25.md](docs/redesign-verification-2026-10-25.md).
