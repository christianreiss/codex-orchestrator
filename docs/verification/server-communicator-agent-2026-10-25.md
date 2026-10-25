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

The production rollout and fresh native post-rollout observations are pending
at this source checkpoint; publication alone will not be recorded as E2E proof.

Production data was not copied into the synthetic MySQL instance. No locks,
accepted work or recovery records were cleared by this verification. Bareos was
not changed; rollout uses `--no-backup`.
