# Independent server–communicator–agent verification — 2026-10-25

Hosts: docker01.uggs.io (production API and root communicator) and biest.eulie.de
(remote Codex/Sigrid and Claude/Thea). Three fresh, independent native review
agents inspected server, communicator and agent lifecycle without inheriting
the earlier audit conclusions. Cross-review then checked the resulting patches.

## Findings and repairs

- The current root session's ordinary Skill and memory calls really failed
  with HTTP 401. Its installed binary was 0.9.130 but the shared on-demand
  owner still ran 0.9.128. After a quiet-sync check, SIGTERM targeted only PID
  1409800. Its replacement PID 2613383 ran 0.9.130 with native-scope support.
  Ordinary single native MCP calls succeeded without batch framing or manual
  credentials. Native identity, binding generation and active claims survived.
- Receiver source changes now precede Portal gating and claim budgets. Two
  Unix-state-WebSocket regressions reproduced stranded peer/Portal work before
  repair and passed afterward (`ebf16aea`).
- Replaced auth directories regain file watches; unused watches are removed.
  Fenced handoffs retain their safety fence while disarming overdue timers;
  refused handoffs wake scheduling again (`ed9a8bd5`).
- Opaque MCP expiry repairs registration for the next explicit request without
  replaying an operation that might already have committed (`ed9a8bd5`).
- Cross-review found terminal renewal results were not retained and watcher
  overflow did not wake local leases. Final Go testing also reproduced terminal
  errors being hidden by sibling cancellation. These have deterministic tests;
  terminal registration is fenced, causes are retained, and overflow wakes
  local observers without forcing network work (`a6983c07`).
- Unrelated publications no longer rebuild every stream projection or rescan
  credentials. Relevant work, global revocations and absolute deadlines remain
  live. Command identity, callbacks and immutable payloads are captured before
  queueing (`33bd4697`).
- Cora's internal-refusal repair (`96cf2164`, documentation `469a3e11`) skips
  receipt recovery only for fresh internal IDs; stable external replay remains
  authorized and idempotent. The sampler counts both digest and binary prepared
  executions, including unattributed prepared executions.
- Explicit uncertain-relay registration/reconnect refusals now wait 30 rather
  than three seconds, preserving the predecessor's protected accepted work
  (`782b05f0`). This changes the refusing worker only when that binary runs.

## Live delivery evidence before rollout

Both remote native sessions performed separate ordinary `agent_self`,
`skill_list`, `shared_memory_search` and `agent_context_get` calls successfully.
The requests arrived without operator typing. Their loaded session binaries
were 0.9.130; biest also retained a 0.9.127 shared owner and 0.9.128 daemon.
Installed version is explicitly not evidence of a running process's version.

| Check | Codex durable request | Claude durable request | Observed result |
| --- | --- | --- | --- |
| Same UUID sent twice | `dfa57ee1-8136-4a74-aa21-0c81ce83f726` | `8384249c-7a81-4b19-88d5-0acf85a7b4dd` | Same message returned with `created:false`; one native execution each; both durable results succeeded |
| Busy request | `2f5bb6e1-6599-4da6-b070-798d27a1d86e` | `a71028fd-77d5-4954-917b-f4ac89ec0f9b` | Passive 30-second sleep, succeeded |
| Request sent during busy work | `99a29d33-7a5f-4490-b6ee-80c8aa425b25` | `494888aa-4d7d-4ec0-918a-8cd842f71dc2` | Accepted after previous work completed, normal MCP probes succeeded once, durable result succeeded |

Codex busy work ended at 16:02:55 UTC; queued work was accepted at 16:03:07.
Claude busy work ended at 16:02:53.047 UTC; queued work was accepted at 16:02:57.
Both queued requests were created at 16:02:41–42, during the sleep.

## SQL and CPU measurements

The initial production mixed-load window lasted 120.894 seconds: API 8.917%
and MySQL 1.498% of one core. It included actual claims, context updates and
remote verification traffic. Binary prepared executions totalled 82, including
43 receipt SELECTs. These SELECTs are not all avoidable; external replay needs
its duplicate fences. This is neither controlled idle nor a causal A/B claim.

After the server fixes, an isolated real HTTP server with 200 simulated TCP
communicators/native sessions across Codex, Claude and Grok remained quiet for
120.003 seconds: zero application SQL and zero business frames. Only transport
liveness frames remained. Node server plus simulated clients used 2.199% of
one core; the exclusive synthetic MySQL cgroup used 0.638%. No browser tabs or
provider accounts were present. This is not a measurement of 200 real CLIs.

The RAM fanout diagnostic with 100 streams and 100 unrelated publications
reduced session authorization calls from 20,000 to zero (approximately 6.23 s
to 0.49 s). Timings are diagnostic, not production acceptance or an absolute
CPU minimum. Conservative host-table invalidations still exist.

## Checks

- Combined API suite: 471 files / 6,046 tests passed; 106 files / 1,084 tests
  skipped by their database/opt-in gates. Run with `ENV_FILE=/dev/null`.
- Combined focused command/quiet/stream/credential checks: 61 passed.
- TypeScript and changed implementation ESLint passed; sampler's three Python
  accounting regressions passed.
- Independent receiver tests, communicator/agentportal suites, targeted races,
  build and vet passed in their isolated worktrees before integration.
- Real-MySQL core SQL/restart/replay plus coordination checks: 15 tests passed.
  A second 14-test lock/Git/claim selection passed, including real-MySQL lock
  transfer, audit failure rollback and retired merge permission checks.
- Final combined `go test ./...`: all 63 test-bearing packages passed;
  `go build ./...` and `go vet ./...` passed. The disposable toolchain mounted
  the repository's sibling `wrappers/testdata` and installed `sudo` only inside
  that container for the existing layout test. Initial logs retain those
  environment failures and the real terminal-heartbeat race; the race was
  reproduced deterministically and repaired before the successful full run.
- Final relay-backoff selection passed ten repetitions; critical terminal
  cases passed 100 race repetitions and the agentportal race suite passed.

## Rollout

Deployed source: `ef2d21fbdf71daabb3e9a25de3badbaa9d639d9f`. Production API
image: `sha256:707b635a22673fccac54c86f1de2300eee2942e62852d81e11509f6f3009a0f9`.
API, media worker and auth runner were healthy with zero container restarts.
Migration verification: 103 applied, zero pending/drifted. The five inspected
live source-map entries (commands, credentials, mutation runtime, stream
provider, native lock continuation) exactly matched the checkout.

cxx 0.9.132 was published and independently hashed on all four platforms.
Root's normal update replaced the installed 0.9.130 binary and its refusing
background worker. A quiet-sync-checked pidfd SIGTERM replaced only root's old
on-demand owner; successor PID 2827318 and worker PID 2825322 both ran 0.9.132.
The attended native session retained its original identity and binding 1;
its explicit resource claim remained active after both API and owner exchanges.
Ordinary Skill/memory calls succeeded without the earlier batch workaround.

Fresh real Codex and Claude processes on biest loaded 0.9.132, each performed
the four separate MCP reads, exited zero and were independently confirmed
`completed`/ended with terminal binding 2 in server state. Existing attended
sessions continued to work; their loaded 0.9.130 supervisors, biest's old
0.9.127 owner and 0.9.128 daemon were deliberately preserved. Those versions
are compatibility evidence, not a claim that every old process was upgraded.

### Fresh headless ownership canaries

The documented `native_session_id` field is nullable for tools-only headless
starts. Codex's JSONL `thread.started` is not attached to the provider transcript
by this path; Claude's headless path does not install the attended SessionStart
hook. Current ownership instead uses the wrapper's exact live native-instance
attachment. No authority check was weakened to accommodate null provider IDs.

Both engines then ran a second, disposable repository canary through **normal
native MCP tools**: context binding, atomic path/Git claim, register, join,
claim status, deregister and completed release all passed. No application
repository, remote, merge, push or foreign work was changed.

| Engine | Fresh managed session | Claim independently confirmed released | Git registration independently confirmed released |
| --- | --- | --- | --- |
| Codex | `52edf7e7-ae0c-4cb6-a05e-ebc5acad194f` | `5e66d7fa-fb84-4caa-a46d-5500795950f1` | `6c5ef9fe-25f3-4fdb-a7f8-431af1acc53d` |
| Claude | `3c777067-e7c5-4826-8555-825000caf627` | `646cb1d9-6958-4f14-a7a1-4c48919412ee` | `ddeeffe1-3f3b-4d6a-bc2f-3ba4be7749b7` |

Both registrations returned `agent_address_bound:true` and connection ownership.
The server independently confirmed both sessions completed, with no remaining
active fixture claim or registration. Peers removed the private clean fixtures.
These headless canaries prove tool/owner authority, not attended inbound
delivery or provider transcript recovery; the earlier attended delivery cases
cover the former. A separate safe RAM check rejected detached and mismatched
bindings for both engines while accepting null provider IDs with a live exact
native-instance attachment.

### Production load and retained uncertainty

A 120.913-second post-rollout window containing updates/native canaries measured
API 5.279% and MySQL 1.520% of one core. It had 64 prepared executions, only
one a receipt SELECT. A separate 180.927-second Git-canary window measured API
11.610% and MySQL 1.715%, with 354 prepared and 970 non-prepared statements
during actual fixture/claim/session mutations. Neither is called idle or a
causal CPU A/B comparison. Every prepared execution was attributed.

Root's 0.9.132 owner plus refusing worker used 0.900% and 0.083% of one core
over a 120-second active verification interval. The final quiet window is
recorded in the accompanying JSON after measurement.

The first 180.932-second window without synthetic test jobs **failed the SQL
acceptance gate**: API 4.852%, MySQL 1.711%, 1,322 digest statements plus 726
binary prepared executions. It exposed 216 repeated audit clock/sweep passes
but only five log DELETEs. Legacy whole/short-fraction UTC VARCHAR timestamps
can be lexically future at a canonical millisecond cutoff while already due
under `Date.parse`; the returned deadline immediately rearmed an empty sweep.
Real MySQL also showed JavaScript string ordering is not a safe substitute for
the two database collations. Follow-up report `31b1674b` tracks the narrow
clock repair; its fix and post-deploy SQL acceptance are pending at this
checkpoint. No production timestamp rewrite or retention-policy relaxation is
part of that repair.

The legacy accepted delivery `901c51e1-84fd-4f15-9f06-e39f89549e15` remains
protected under its original relay owner; its outcome was not invented or
cleared. The new refusing worker's last three-minute log window contained six
`agent_messaging_relay_uncertain` responses, spaced 30.007–30.009 seconds apart.
This verifies live backoff, not successful recovery of that historical task.

No production native crash, host reboot, provider outage or arbitrary lost-ACK
chaos experiment was forced. Fault-specific guarantees above come from explicit
isolated/race/MySQL regressions. Browser/mobile and external Skill side effects
were not rerun as part of this transport verification. An absolute fleet-wide
CPU minimum or zero SQL during real durable work is not claimed.

### Cleanup and feedback

The synthetic MySQL container/tmpfs, four clean merged review worktrees and
1.3 GiB of disposable test cache were removed. Both verified cutover metadata
directories and four rollback tags were removed per the operator's backup
instruction; running images were preserved. Source is retained in origin/main;
old images can be rebuilt from Git, and Bareos remains the operator's data
recovery system. No Bareos restore drill was performed here. The old custom
backup timer remains disabled. Cleanup receipt:
`/var/tmp/codex-zk-cleanup-20261025.json`.

Eight deduplicated fleet reports were resolved with source/test/deployment
evidence: `bdb0eb8b`, `420a872e`, `da2d0e2f`, `885d620f`, `2126a2e3`,
`8b5a1526`, `28b769b8`, `61cc9d18`. Legacy-owner runtime evidence was appended
to existing report `2a4f9ba8`; its earlier status was not reopened speculatively.

Production data was not copied into the synthetic MySQL instance. No locks,
accepted work or recovery records were cleared by this verification. Bareos was
not changed; rollout uses `--no-backup`.
