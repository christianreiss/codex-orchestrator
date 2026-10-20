# Workflow delivery acceptance — 2026-10-20

Initial release source: `f4febc6d43958176aaf87494f730f7edc6241538`; common cxx
`0.9.111`. Final live API: `99d5f20880679fe19a6a05c9c5f32be669f3afb1`
(no wrapper or SPA change). Scope and decisions: [PLAN.md](../PLAN.md). Domain implementation
was delegated to Astra, transport and UI to Sol. The integrating agent reviewed
the changes and ran independent acceptance before the authorized rollout.

## Automated evidence

| Check | Result / boundary |
| --- | --- |
| API typecheck and build | Passed |
| API lint | 0 errors, 147 warnings; not warning-free |
| API ordinary test command | 402 suites, 5,244 tests passed; DB suites deliberately opt-in |
| Full API coverage with fresh MySQL 8.4.10 | 471 suites, 6,139 passed, 5 optional tests skipped; coverage thresholds passed (87.67% lines, 83.54% branches, 90.65% functions) |
| Schema upgrade and replay | Pre-feature baseline upgraded through 0083; idempotent replay passed; final check 83 applied, 0 pending, 0 drifted |
| HTTP/MCP integration | Real TCP Fastify, real authentication and MySQL; Codex/Claude/Grok bridge identities plus outsider; no mocked domain service |
| Wrapper checks | Build, vet, race suite, `make test`, `make test-traced` passed; terminal suite 451 cases |
| Frontend check | Svelte 0 errors / 0 warnings; 989 unit tests passed |
| Chromium | Full suite 284 passed; final workflow/group slice 53 passed after availability changes |
| Firefox / WebKit | Full canonical cross-browser suite: 73 each, 146 total, including design sweep |
| Generated artifacts | Final SPA built and committed; source/catalog/inventory tests passed |

The HTTP test creates and independently hashes two temporary artifacts, exercises
A→B→C invitations, one managed group, claim contention, targeted question/reply,
idempotent result/finalization replay and mandatory automatic revision. Recreating
the API service preserves the pinned run and membership. A new run uses version 2
while the original retains version 1. This is service-restart evidence in one test
process, not a native multi-host receiver test or an OS-restart test.

Five API skips are explicit opt-ins: three native Codex parser/resolver tests
(`CODEX_NATIVE_TEST_BIN`), isolated Docker instance control
(`TEST_INSTANCE_DOCKER`), and multi-GiB binary transfer stress
(`TEST_BINARY_TRANSFER_LARGE`). None is counted as passed. Dependency lockfiles
were unchanged; `npm ci` was not repeated. Browser runtimes were already installed.
Linux WebKit needed temporary official ICU/JPEG libraries under
`/tmp/workflow-webkit-runtime`; no system package or library configuration changed.

An earlier run against a reused acceptance database encountered pre-existing
orphan messaging fixtures. The identical source passed the relevant suites on a
fresh database and then the complete coverage run. No product behavior was changed
to accommodate contaminated fixtures.

After the native run exposed recovery discovery and daemon relay registration
issues, the integrated follow-up passed TypeScript/build, focused lint (0 errors,
1 existing test warning) and **157 tests in eight suites on a new MySQL database**.
This includes workflow core/transport/HTTP, daemon relay registration and messaging
durability/schedules/names. A preliminary command omitted `TEST_USE_DB=1` and
skipped 41 DB tests; it is not acceptance evidence. Reusing the earlier full-suite
database reproduced three fixture-contamination failures; the new database passed
all 157 on the identical source. The full pre-follow-up coverage, Go and browser
runs above were not repeated for these API-only changes.

The subsequent real Portal-finish result regression is fixed in `99d5f208`.
Independent integrated verification passed **197 tests in nine suites on another
fresh MySQL database**, including Portal durability and 13 daemon relay cases.
The latter exercise normal finish before result publication for all three engines,
immutable result replay, ordinary relay ownership, and rejection after wrong
claim/relay/user, failed/admin-closed session, expired lease, unrelated session or
new binding. Typecheck and build passed; focused lint reported 0 errors and two
existing unused-helper warnings. No wrapper or frontend source changed.

## Design evidence and remaining limits

The five routes follow NAV-1..4, VIS-1..5, INT-1..8 and ACC-1..4. Automated coverage
includes empty/loading/error/denied/disabled/stale states, retained drafts and CAS
conflicts, direct links/reload/back, group access, long text, both themes/system,
responsive widths including 320px, keyboard/focus, coarse pointer, 200% text sizing
and Axe.
Representative light desktop and dark 320px report screenshots were independently
visually inspected by the integrating agent.

Fixtures prove UI behavior; they do not prove the deployed backend. Linux WebKit
is not native Safari. A manual 400% browser-zoom task, screen-reader use and field
performance distributions have not been measured. No full WCAG certification is
claimed; 320px reflow tests do not replace actual browser zoom.

## Production and native acceptance

`scripts/deploy.sh --backup --no-cleanup` completed with exit 0 on
`docker01.uggs.io` at approximately 10:09 UTC. The production checkout is
`/var/docker_data/codex-auth.uggs.io/app` at the release source above. The script
built/published all four cxx targets, applied additive migration 0083 and recreated
the API and quota service. API, auth-runner, media-worker, MySQL and quota service
reported healthy; the existing advisor remained running.

Backup:
`backups/codex-orchestrator-20261020T100327Z.sql` (306,447,051 bytes).
Post-deploy migration check: 83 applied, 0 pending, 0 drifted. `/healthz` returned
OK. The served HTML SHA-256 matched committed `public/admin/index.html`:
`613b9cd229e7684b28450c671934d175f817b0b27d7d8c10a6b377a8e236425c`.
Browser requests require `Accept: text/html`; a generic curl to a browser route
returns 404 by the existing API/browser distinction. Unauthenticated workflow
state API access returned 401.

Workflows was confirmed disabled after migration, then enabled through the
authenticated console switch. A fresh API read and checked switch confirmed the
change. The initial BrowserOS reference-clicks did not dispatch an interaction;
a DOM click on the same rendered switch exercised the UI handler successfully.

Updated cxx on `biest.eulie.de` from 0.9.110 and on `jadon.eulie.de` from 0.9.109
to 0.9.111 (embedded commit `f4febc6d`). Managed engine configuration synced;
native CLI versions remained unchanged. Authentication, TLS and sandbox settings
were not weakened.

The initial native create exposed a stale pinned daemon binary on both hosts:
updating `/usr/local/bin/cxx` had left `/usr/local/lib/cxx-daemon/cxx` at 0.9.109.
After confirming no active daemon operations, `cxx daemon install` updated and
restarted the existing daemon on each host. Both pinned binaries now report
0.9.111. Original native sessions were resumed through supported daemon turns;
their original agent and native-session UUIDs were independently verified.
Feedback `ae1a6ac8-2a79-4097-8de1-2b81cd068950` was resolved after the identical
create request succeeded and both hosts recorded successful tasks.

The native shared run completed successfully at 10:27:41 UTC:
[final report](https://codex-auth.uggs.io/admin/workflows/runs/f146e003-2094-40bc-a954-474d868ad49a).
Albinia (`ea376b3e-ac0c-4adc-b109-fe5527875e9b`, host 32) invited Anne-Katrin
(`95b7d016-a143-4ffb-b17a-635e60cbc7b7`, host 35). The second acceptance created
group `4d2e690e-a2e8-43db-b401-80d2a74bf225`. Both Codex sessions used
`gpt-6.1-sol`; no native Claude/Grok execution is claimed.

Alpha and beta succeeded, followed by the dependent verification task. The
coordinator retrieved beta through transfer `fd741315-cfe5-43a3-91ae-808d9bdaa2d5`
and independently read both files. The integrating agent also read the original
files on their respective hosts and the retrieved copy on biest:

- Alpha SHA-256: `1f102553f288c03ed436c641b117ae9ef346bdf9245b2d01b0a49666006f7aee`.
- Beta source and retrieved SHA-256: `ef7f67d72b5d0d8b80a700e0b48651f0f173f9e35e332bd7e9d6cfff03d90da3`.
- Verification JSON SHA-256: `c917260326704146552895be7297aaa00afde97a9eb2f3b0d450d8a7214b964e`.

Native question `d1316a4d-a1f5-4429-be51-d6a40012b989` has completed delivery
to the participant and exactly one reply
`8bc51850-db1e-46f4-a6df-141ed9066825`, with matching `reply_to` and no answer
recipients. The group is now closed with four retained events. Actual report,
task detail, group deep link and reload were inspected in the authenticated UI.
Final evaluation published version 2; independent reads prove the goal and
criteria unchanged and the original run still pinned to version 1.

The initial pass required explicit daemon turns and report-UI coordinator
recovery after the original session's binding changed; no new native transcript
or run was substituted. Recovery preserved successful tasks. A peer resume was
rejected with HTTP 409 `agent_messaging_lease_lost` before provider launch:
the server compared a daemon relay's `<user>:daemon` identity literally to its
native user's `<user>` identity. Feedback
`ab5d88ea-ba9b-4c6e-960f-d6069e62c8bb` tracks the targeted fix and subsequent
native resume verification. A separate read-only discovery improvement exposes
stale memberships/claims rather than hiding the required recovery.

The second deployment of `8245b4b8` completed around 10:36 UTC with backup
`backups/codex-orchestrator-20261020T103413Z.sql` (306,978,409 bytes), healthy
services and migration status 83/0/0. The completed report and evaluation survived
this real API container restart unchanged.

The next native read-only probe `5773bf14-2dd9-44ed-8aff-e7c1f1083798` automatically
resumed the original native transcript at 10:38:25 UTC and emitted a valid succeeded
result at 10:38:54. Publication then failed with `agent_messaging_binding_stale`:
Portal shutdown had released the child binding before its supervisor stored the
buffered result. Feedback `1434bee7-7503-4396-804f-7d52b0a45534` records this
separate finding. The message remains ambiguous after its lease expired; the
original transcript preserves its result. It was not rerun or retroactively
marked successful. The narrow API fix above preserves only the exact accepted
receipt across normal completion.

The final API deployment of `99d5f208` completed with exit 0 before 10:50 UTC,
with backup `backups/codex-orchestrator-20261020T104759Z.sql` (307,033,353 bytes).
Independent health at 10:50:01 UTC, healthy Compose services, 83 applied / 0
pending / 0 drifted migrations and the unchanged completed report were verified.
Published cxx remains 0.9.111 at `f4febc6d`; this follow-up changes neither wrapper
nor SPA. Authentication, TLS and execution restrictions remained intact.

After an explicit same-transcript idle recovery from the previous unknown state,
a **new, distinct** read-only health/version request
`a9886e00-57b9-45d6-be89-0ef43d692009` automatically resumed the coordinator.
It observed HTTP 200/healthy at 10:51:10.536 UTC and cxx 0.9.111, using the original
canonical agent and native transcript `01a158cb-5228-7730-833d-365b195cc32e`.
The server confirmed `completed` at 10:51:26 UTC, no error, and exactly one stored
`succeeded` task result with evidence. The daemon returned to idle at 10:51:28.
This proves actual result storage after native exit, beyond a successful final
message or process exit. Both relay findings are resolved and marked deployed;
the old ambiguous receipt remains historical evidence.

Both task-owned native helpers on biest and jadon were closed after acceptance.
The disposable local MySQL was shut down. All delegated worktrees were audited
clean with their changes integrated or patch-equivalent, then removed along with
their task branches. Original tips remain recoverable through
`refs/archive/workflows-20261020/{core,transport,ui,peer-result}`. No unrelated
worktree, production backup, native transcript or acceptance artifact was deleted.

## Evidence locations

Local reproducible test source:
`api/test/integration/workflow-http-e2e.test.ts`,
`api/test/integration/workflows.test.ts`,
`api/test/integration/workflow-transport.test.ts`,
`frontend/e2e/admin-workflows.spec.ts` and the managed-group messaging cases.

Diagnostic logs (temporary, not durable artifacts):
`/tmp/coco-workflow-acceptance-97d3ae01/`,
`/tmp/workflow-ui-cross-full-{firefox,webkit}.log`.
Browser captures/traces:
`/tmp/workflow-ui-evidence/`,
`/tmp/workflow-ui-canonical-{firefox,webkit}-evidence/`.

## Rollback

Disable new workflow work through the module switch and reconcile active external
work before a software rollback. Preserve additive tables and report history.
Restore an older workflow as a new revision rather than changing historical
versions. The production pre-release API image is tagged
`codex-orchestrator-api:pre-workflows-20261020`; the previous production source is
`f7877a6fc1e3fdc448ad41e0e71fa0a789ee2953`. A database restore is reserved for
actual database damage and must account for work recorded after the backup.
