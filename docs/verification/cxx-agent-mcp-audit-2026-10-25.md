# cxx-agent MCP audit — 2026-10-25

## Scope and verified boundary

Stephanie audited the native cxx-agent adapter from biest.eulie.de at source
`20d120202c6d71cb413276359f4f8cb1c5d0cebd`, coordinated with Rosa-Maria
(API dispatch/auth/owner integration) and Jasmin (cdx tools and server Skills).
Quota was fresh at 2% of the weekly account window before the work.

The installed adapter and the source test export both advertise exactly **82**
tools, with no missing or extra names. This session's already running adapter
was cxx 0.9.128; the server had published 0.9.129. The source-only audit additions
below change tests, not a production wrapper protocol.

**35 distinct tools have additional live evidence:** 31 successful probes, two
correct `roles_disabled` refusals and two reproducible API failures. All 82 tools
also passed isolated success/error dispatch fixtures. A passing fake-broker
call does not prove the production domain operation, native CLI behavior or
a paid provider path. The matrix preserves those limits.

No production reboot, native-agent stop, remote helper start, watchdog recovery,
persistent Wake, insecure window, foreign checkout mutation or operator
notification was performed. `schedule_*` is not in this 82-tool cxx-agent
catalogue; its cdx/server coverage belongs to the other workstream.

## Findings needing API repair

1. `agent_translate` with this agent's canonical address returned
   `server_error`. Docker01 request `4222f4ff825ceab5`, timestamp
   `1792928987518`, failed with
   `Owner database boundary: transaction requires an owner transaction or explicit cold read`;
   stack identified `AgentMessagingService.translate`.
   Feedback: `a0345b31-5765-4e15-83c0-2a6dfc263abe`.
2. `agent_workflow_run_current({})` returned the same error. Request
   `b42bd4b9b11bb514`, timestamp `1792928987761`, identified
   `AgentMessagingService.coordinationTransaction`.
   Feedback: `546969d2-c0a3-4b0f-bed4-99bf95e2abec`.

Both were sent to Rosa-Maria with correlated evidence. This report records the
observed pre-repair state, not an unverified live fix. Role current/proposal
reads were correctly refused because the fleet has roles disabled; the audit
does not enable that feature.

## Checks and fixture legend

- Complete Go suite: **63 packages passed**, 4 packages had no tests;
  **4,790 successful test/subtest events**, 11 skip events, no failures.
  Counts include parent test events and are not 4,790 independent end-to-end cases.
- Focused added contracts and full catalogue under the race detector:
  **106 successful test/subtest events**, two packages passed, no failures.
- `go build ./...`, `go vet ./...` and `git diff --check` passed.
- Before adding tests, the two full adapter packages passed 831 test/subtest
  events; `TestGrokNativeLeaderCanary` is opt-in and
  `TestResidentCombinedProcessHelper` is a subprocess-only helper.
- The first package command included nonexistent `./internal/hostdaemon`
  and exited 1 at setup. Host-daemon code is in `internal/agentbus`; the
  corrected two-package command and complete suite both passed.
- Tests ran without inherited `CXX_AGENT_PORTAL_SOCKET`,
  `CXX_AGENT_PORTAL_SESSION_ID`, `CXX_AGENT_PORTAL_ENGINE` and
  `CXX_MCP_BEARER`, keeping fixture traffic separate from this native session.
- API/MySQL/frontend suites are Rosa-Maria's separate integration scope; they
  were not run or claimed by this wrapper workstream. No real provider
  inference, physical reboot or all-host rollout acceptance is claimed.

Fixture codes:

| Code | Evidence and actual assertion |
| --- | --- |
| C | `agentbus/mcp_catalog_compatibility_test.go:TestMCPCatalogCompatibility/<tool>`: all 82 advertised handlers reach a fake broker and preserve MCP success/error envelopes; reboot adapter is stubbed and attachment files are temporary. This is not a domain-state lifecycle test. |
| R | New `agentbus/coordination_roles_contract_test.go:TestCoordinationAndRoleToolsPreserveSessionRequestsAndFences/<tool>`: 18 explicitly mapped routes, exact session URL/payload preservation, typed 409 owner fences and no mutation replay. |
| W | `agentbus/workflows_test.go`: all 13 workflow bridge paths preserve request identity, propagate conflicts and advertise distinct closed action schemas. |
| P | `agentbus/publications_test.go`: publication routes, stable idempotency UUIDs and rejection of invalid topics/slugs before broker dispatch. |
| A | `agentbus/agent_chat_test.go`: resumed/chunked upload, checksum download, room-bound routes and normal versus attention portal semantics. |
| H | `agentbus/watchdog_cli_test.go`, `watchdog_event_test.go`: current bridge/version fencing and lifecycle hooks across engines; no production recovery. |
| N | `agentbus/reboot_test.go`, `reboot_tmux_test.go`: same-transcript continuation, missing-transcript refusal, consumed handoff and disposable process/terminal fixtures; no OS reboot. |
| D | `agentbus/daemon_test.go`, `daemon_process_test.go`: private journals, engine/directory rejection, resumable adapters and only fixture-owned process groups. Does not prove a remote production spawn. |
| T | `agentbus/agentbus_test.go`, `receiver_test.go`, `receiver_owner_test.go`, `recovery_test.go`: acceptance/result correlation, receiver ownership, cancellation, lost/uncertain receipts and no fresh-session fallback. |
| F | `agentbus/mcp_conf_dispatch_test.go`: conference ETA is preserved; other conference rows have only the catalogue dispatch proof unless marked live. |

Additionally, `agentportal/managed_mcp_test.go` now exercises **Codex, Claude and
Grok**: the private broker replaces spoofed session/bridge/engine headers,
preserves host authorization, request bytes and JSON-RPC ID
`9007199254740993`, and returns exact response bytes. Existing
`TestIdentityGateAndProviderContextAcrossEngines` and
`TestNativeControlRoundTripForEveryEngine` passed for all three engines using
isolated endpoints and owned dummy processes. Live native MCP environment
reloading still requires a new launch; an already running adapter is not proof
that the new signed configuration was adopted.

## Live test resources and cleanup

- Group `audit-20261025-3b3c0e43-ecb8-4392-9dfc-8bec712e66d3`:
  create, subscribe, members (exactly this agent), publish (zero recipients;
  sender skipped), unsubscribe, delete. A fresh list confirmed absence.
- Private path claim `01d6e0de-faf2-4616-899f-b503a5264bff`:
  acquire, active read, release; released state confirmed. No filesystem or
  host mutation was associated with the probe.
- Message `d6a6e498-5a8e-4327-982c-9686a5ac5582` to Rosa-Maria in its own
  conversation `38d1e4fb-7b75-4ba0-ac00-07a0b1500578`: send and cancel before
  acceptance; reread showed canceled, zero ambiguous messages/deliveries.
  The actual audit conversation was not canceled.
- Audit-owned source claim and Git registration are released after the
  commit/push handoff. No unrelated claim, membership or schedule is removed.

## Complete tool matrix

“Not run live” means the isolated fixture ran, but the production operation was
deliberately not executed. No row is silently omitted or labeled domain-green
solely because HTTP dispatch succeeded.

| Tool | Live result | Isolated evidence | Limit |
| --- | --- | --- | --- |
| `advisor_ask` | Not run live | C | No extra paid advisor work started for this audit |
| `advisor_close` | Not run live | C | No extra paid advisor work started for this audit |
| `advisor_status` | PASS | C | Current native session read/no-op or audit coordination |
| `agent_attachment_get` | Not run live | C, A | Chunk/checksum/local-file fixtures; no persistent server upload |
| `agent_attachment_upload` | Not run live | C, A | Chunk/checksum/local-file fixtures; no persistent server upload |
| `agent_cancel` | PASS | C | Only isolated sender-owned test conversation canceled |
| `agent_chat_list` | PASS | C, R | Current native session read/no-op or audit coordination |
| `agent_chat_read` | Not run live | C, R | No shared run chat exists for this session; route/payload fixtures |
| `agent_chat_send` | Not run live | C, R | No shared run chat exists for this session; route/payload fixtures |
| `agent_conf_adjourn` | Not run live | C | No real conference or participant task created |
| `agent_conf_dispatch` | Not run live | C, F | No real conference or participant task created |
| `agent_conf_invite` | Not run live | C | No real conference or participant task created |
| `agent_conf_join` | Not run live | C | No real conference or participant task created |
| `agent_conf_list` | PASS | C | Current native session read/no-op or audit coordination |
| `agent_conf_open` | Not run live | C | No real conference or participant task created |
| `agent_conf_roster` | Not run live | C | No real conference or participant task created |
| `agent_conf_say` | Not run live | C | No real conference or participant task created |
| `agent_context_get` | PASS | C, R | Current native session read/no-op or audit coordination |
| `agent_context_update` | PASS | C, R | Current native session read/no-op or audit coordination |
| `agent_digest_get` | PASS | C | Current native session read/no-op or audit coordination |
| `agent_git_remote` | Not run live | C, R | Fake broker only; no foreign checkout or lease changed |
| `agent_group_create` | PASS | C, P | Current native session read/no-op or audit coordination |
| `agent_group_delete` | PASS | C, P | Self-owned reversible audit resource |
| `agent_group_list` | PASS | C, P | Current native session read/no-op or audit coordination |
| `agent_group_members` | PASS | C, P | Self-owned reversible audit resource |
| `agent_list` | PASS | C | Current native session read/no-op or audit coordination |
| `agent_listen` | Not run live | C, T | Lifecycle fixtures; final real listen occurs after report delivery |
| `agent_message_get` | PASS | C | Current native session read/no-op or audit coordination |
| `agent_portal_ask` | Not run live | C, A | No user notification/elicitation emitted as a test |
| `agent_portal_notify` | Not run live | C, A | No user notification/elicitation emitted as a test |
| `agent_portal_resolve` | Not run live | C, A | No user notification/elicitation emitted as a test |
| `agent_portal_say` | Not run live | C, A | No user notification/elicitation emitted as a test |
| `agent_publish` | PASS | C, P | Self-owned reversible audit resource |
| `agent_reboot` | Not run live | C, N | No host reboot; mocked/local recovery and transcript fences |
| `agent_reboot_status` | PASS | C, N | Current native session read/no-op or audit coordination |
| `agent_receiver_reply` | Not run live | C, T | Local receiver/portal claim fixtures; no operator receipt consumed |
| `agent_receiver_status` | Not run live | C, T | Local receiver/portal claim fixtures; no operator receipt consumed |
| `agent_reply` | PASS | C, T | Current native session read/no-op or audit coordination |
| `agent_request` | Not run live | C, T | Accepted-work/retry fixtures; no synthetic work launch |
| `agent_role_activate` | Not run live | C, R | Roles disabled; mutations not activated to test |
| `agent_role_current` | Expected rejection: roles_disabled | C, R | Roles disabled; mutations not activated to test |
| `agent_role_proposals` | Expected rejection: roles_disabled | C, R | Roles disabled; mutations not activated to test |
| `agent_role_propose` | Not run live | C, R | Roles disabled; mutations not activated to test |
| `agent_role_release` | Not run live | C, R | Roles disabled; mutations not activated to test |
| `agent_role_review` | Not run live | C, R | Roles disabled; mutations not activated to test |
| `agent_room_list` | PASS | C, R | Current native session read/no-op or audit coordination |
| `agent_room_read` | PASS | C, R | Current native session read/no-op or audit coordination |
| `agent_room_send` | Not run live | C, R | No scope-room broadcast test to other members |
| `agent_self` | PASS | C | Current native session read/no-op or audit coordination |
| `agent_send` | PASS | C, T | Current native session read/no-op or audit coordination |
| `agent_session_name` | PASS | C | Current native session read/no-op or audit coordination |
| `agent_spawn` | Not run live | C, D | No live helper launch/stop; only owned fixture processes |
| `agent_spawn_status` | PASS | C, D | Current native session read/no-op or audit coordination |
| `agent_stop` | Not run live | C, D | No live helper launch/stop; only owned fixture processes |
| `agent_subscribe` | PASS | C, P | Self-owned reversible audit resource |
| `agent_subscriptions` | PASS | C, P | Current native session read/no-op or audit coordination |
| `agent_task_result` | Not run live | C, T | Accepted-work/retry fixtures; no synthetic work launch |
| `agent_translate` | FAIL: server_error | C | Own canonical address; owner transaction error, API follow-up |
| `agent_unsubscribe` | PASS | C, P | Self-owned reversible audit resource |
| `agent_wait` | PASS | C, T | Current native session read/no-op or audit coordination |
| `agent_workflow_archive` | Not run live | C, W | No production workflow/run mutated; bridge/action-schema fixtures |
| `agent_workflow_create` | Not run live | C, W | No production workflow/run mutated; bridge/action-schema fixtures |
| `agent_workflow_invite` | Not run live | C, W | No production workflow/run mutated; bridge/action-schema fixtures |
| `agent_workflow_membership` | Not run live | C, W | No production workflow/run mutated; bridge/action-schema fixtures |
| `agent_workflow_revise` | Not run live | C, W | No production workflow/run mutated; bridge/action-schema fixtures |
| `agent_workflow_run_control` | Not run live | C, W | No production workflow/run mutated; bridge/action-schema fixtures |
| `agent_workflow_run_create` | Not run live | C, W | No production workflow/run mutated; bridge/action-schema fixtures |
| `agent_workflow_run_current` | FAIL: server_error | C, W | Empty arguments; owner transaction error, API follow-up |
| `agent_workflow_run_evaluate` | Not run live | C, W | No production workflow/run mutated; bridge/action-schema fixtures |
| `agent_workflow_run_finish` | Not run live | C, W | No production workflow/run mutated; bridge/action-schema fixtures |
| `agent_workflow_run_note` | Not run live | C, W | No production workflow/run mutated; bridge/action-schema fixtures |
| `agent_workflow_task_claim` | Not run live | C, W | No production workflow/run mutated; bridge/action-schema fixtures |
| `agent_workflow_task_update` | Not run live | C, W | No production workflow/run mutated; bridge/action-schema fixtures |
| `host_insecure_enable` | Not run live | C | No access-window/authentication weakening |
| `quota_get` | PASS | C | Current native session read/no-op or audit coordination |
| `resource_claim_acquire` | PASS | C, R | Self-owned reversible audit resource |
| `resource_claim_release` | PASS | C, R | Self-owned reversible audit resource |
| `resource_claim_status` | PASS | C, R | Current native session read/no-op or audit coordination |
| `watchdog_disable` | Not run live | C, H | No production recovery enabled/disabled |
| `watchdog_enable` | Not run live | C, H | No production recovery enabled/disabled |
| `watchdog_finish` | Not run live | C, H | No production recovery enabled/disabled |
| `watchdog_get` | PASS | C, H | Current native session read/no-op or audit coordination |
