# Work delivery, workflows and shared content acceptance

On 21 November 2026 a synthetic receiver accepted and completed work with Messaging enabled and Portal disabled. A deliberately lost result response was recovered under the original claim. MySQL held one result. This previously failed on the native-control registration needed to claim work. The regression runs in the regular API database gate.

The acceptance ran on biest.eulie.de, Linux, Node 22.22.2, Vitest 2.1.9, MySQL 8.4.13, on the integration worktree at `39b3e8bc7245` plus the WA-002 changes described below. All listeners bound loopback. Database suites ran serially against a dedicated disposable server/schema with synthetic identities. The new wire test boots the full API twice on its own fresh UUID-named schema, temporary storage and encryption key. It supplies the wrapper's client protocol. It uses no installed user's home, native model, provider token or external OAuth client.

## Findings

| ID | Classification and user effect | Evidence, decision and verification |
| --- | --- | --- |
| WA-001 | Confirmed operations documentation conflict. The workflow rollback paragraph could send an operator to a DB restore after newer operator changes. | Corrected the last paragraph of [Workflows](../workflows.md) to preserve run history, drain and deploy a compatible Git commit. Checked against the owner cutover policy. Documentation check only. |
| WA-002 | Confirmed delivery defect. With Messaging enabled and Portal disabled, a genuine bridge registration returned 503 `agent_portal_disabled`. The receiver could not attach its native process or claim the queued request. | Fixed [the native-control handler](../../api/src/routes/agent-portal/admin-host.ts). A Messaging-authenticated registration poll returns the process binding and a null stop request. Bad bridge tokens fail. Admin stop and reports to this polling endpoint retain the Portal gate. A claim before the matching state stream opens still returns 409 `agent_messaging_lease_lost`. The post-fix authenticated stream receives its snapshot and can claim. See the [HTTP regression](../../api/test/integration/control-plane/work-product-http.test.ts) and [API contract](../interface-api.md). |

## What crossed a real boundary

| Workflow or data | Entry, effect and failure demonstrated | Verification boundary |
| --- | --- | --- |
| Setup, host, content and logout | One-time admin owner → session cookie → persisted model defaults → synthetic secure host and host key. The host retrieves the skill published over the browser WS, receives the exact operator rule through bootstrap, observes version two after owner restart and observes the deleted skill. Logout closes the open admin WS and the former cookie gets 401. | Full API/HTTP, real MySQL, signed-in WS and MCP. No browser UI, installed native CLI, passkey device or provider. |
| Projects, files and board | Enable projects/boards → create project and file via admin API → host reads identical text over MCP → operator creates a card visible on the board. File survives owner restart and deletion returns 404. | Full owner/HTTP/MCP and persisted data. Project board DB tests also exercise claim contention and optimistic edits. |
| Memory, secrets and transfers | Shared-memory revision/digest → compare-and-swap update → stale edit refused → persisted revised value → deletion. Host retrieves the synthetic secret while admin metadata omits the value. Revocation removes host access. Four-byte binary including NUL and non-UTF-8 bytes round-trips with matching digest. Revoked transfer cannot be fetched. | Full owner, HTTP, host MCP and MySQL. Captured admin WS frames also exclude the synthetic secret. Large-transfer measurements below use a fixture host-auth seam. |
| Connector authorization | Register client → PKCE browser authorization and CSRF-bound approval → exchange code once → authenticated MCP catalog. Repeated exchange returns 400. Access survives owner restart, revocation gives 401. | Real local issuer and HTTP requests. The test parses its redirect without contacting the callback or an external OAuth client. |
| Work request and response loss | Duplicate request ID returns the first delivery. Before process attachment, claim fails. Valid bridge and communicator state stream bind the matching generation and instance. After claim and durable acceptance, SQL shows `accepted`, no completion and no task outcome. The receiver then exclusively creates a local file and reports its checksum as result evidence. A local proxy consumes the owner's successful result response and closes the receiver socket. The identical retry succeeds, a changed terminal result conflicts, the queue is empty and SQL contains one succeeded result. | Real owner, host HTTP register/send/claim/ACK, communicator WS, SQL and file effect. The receiver is test code. Go tests separately verify actual wrapper result retry and missing-transcript policy with fixture endpoints/processes. |
| Workflow evaluation and versions | Read version one over MCP, prepare, present summary, confirm, execute, contend for task claims, deliver team reports and validate file evidence. Reopen HTTP service on the same DB, finish evaluation, apply version two exactly once and start a run pinned to the new version. | [Workflow HTTP test](../../api/test/integration/workflow-http-e2e.test.ts) uses TCP and MySQL, fixture registrations and bridge clients for engine roles. Evaluation is supplied by the fixture. Other workflow tests cover version conflicts, uncertain outcomes, and evaluation drafts. |
| Group, cancellation, wake, recovery and access | Immutable recipient snapshots on duplicate group send and membership change, canceled queued requests across four engine IDs, watchdog deadlines, ended/offline/busy recipients, acceptance/result idempotency, missing transcript and one-time operator grants. HTTP/service tests cover login/setup, role compatibility and denial of secret data. | MySQL service and route tests, including in-process Fastify injection. Deadlines and receiver presence use fixtures. Go exercises the shipped recovery decision; it never launches a real subscription session here. |

## Reproduction and counts

Set `TEST_USE_DB=1` and the `DB_HOST`, `DB_PORT`, `DB_USERNAME`, `DB_PASSWORD`, `DB_DATABASE` variables to an isolated MySQL fixture with schema creation privileges. Start from the repository root. Use a disk-backed `TMPDIR` with room for several GiB for the large-transfer case.

```bash
cd api
npm run test:db:setup
v=node_modules/.bin/vitest
"$v" run --no-file-parallelism test/integration/workflow*.test.ts \
  test/integration/security/{workflow-authorization,authorization-compatibility,capability-edges}.test.ts \
  test/integration/agent-messaging/{durability,receiver,cancel-request,groups,group-routes,schedules,supervisor,watchdogs,smart-queue,mailbox}.test.ts \
  test/integration/agent-portal/{abandoned-recovery,durability,lifecycle}.test.ts \
  test/integration/control-plane/{messaging,scheduled-owner,conference-open-or-join,portal}.test.ts \
  test/integration/{agent-coordination,project-board,projects-client,transfers,admin-content,admin-skill-sources,agent-policy,admin-memories,shared-memories,admin-secrets,secrets,connectors,mcp,admin-auth} \
  test/integration/host-api/{skill-bundle,sync-bootstrap}.test.ts
TEST_BINARY_TRANSFER_LARGE=1 "$v" run --no-file-parallelism test/integration/transfers/binary.test.ts -t 'transfers multiple GiB'
"$v" run --no-file-parallelism test/integration/control-plane/{work-product-http,messaging}.test.ts \
  test/integration/agent-portal/{abandoned-recovery,lifecycle}.test.ts test/integration/topology
npm run typecheck
npm run lint
cd ../wrappers/cxx
go test -count=1 -run '^Test(MissingTranscriptStopsWithoutFreshFallback|MissingTranscriptRecognizesCurrentClaudeOutput|DaemonNativeAdaptersProduceResumableResults|ListenRetriesAnExplicitWorkResult|AgentListenClaimsWithoutAcknowledging|ProgressReplyKeepsAcceptedWorkHeld|TaskResultAfterFinishingReplyNamesTheStoredOutcome|TaskResultAfterPlainReplyNamesUnknown|ClaudeChannelAcceptsThenCompletesOnlyAfterCorrelatedReply)$' -v ./internal/agentbus
```

- Initial 50-file sweep covered 43 workflow, 377 messaging/coordination/owner, 66 authorization and 285 content/connector/transfer cases. 770 passed in the sweep. The remaining large-transfer opt-in passed separately, for 771 distinct executed cases. Several route suites substitute individual services. The TCP paths above identify where the real services ran.
- The [Go transfer acceptance](../../api/test/integration/transfers/binary.test.ts) verified empty, 80 MiB and 3 GiB files over Fastify/TCP, actual disk and MySQL. The 3 GiB round trip took 38.84 s, 158.2 MiB/s aggregate for both directions. Peak client heap growth was 1.9 MiB; API RSS went from 184.1 to 229.3 MiB. These are single local measurements. The route's host-auth service uses a fixture identity.
- After the WA-002 fix, 47/47 tests in six files passed, including the complete two-owner wire scenario and portal/messaging/topology regressions. All nine named Go wrapper tests passed. TypeScript passed. API lint completed with zero errors and 226 warnings. No provider canary, browser rendering, hardware passkey flow or production cutover was part of this wave.
