# Grok private-reaper CPU regression — 2026-10-25

## Observed cause and immediate recovery

On biest.eulie.de, PID 205173 was `cxx __cxx-grok-private-reaper`, with
20:39:19 accumulated CPU time and 29.5% lifetime-average CPU. Three other
reapers had accumulated 02:30:06, 01:29:19 and 01:43:04 CPU time. The actual
communicator owner, PID 4186749, used about 0.5% lifetime-average CPU.

After its inherited directory lease is released, the old reaper checks every
100 ms whether any process environment still names that private home. On Linux
each check scans `/proc/*/environ`; an orphan Grok leader can keep this loop
alive indefinitely. Two detached native Grok leaders remained observable.

The operator explicitly authorized stopping the reapers. Four verified same-UID
PIDs (205173, 3660145, 4006229, 4117424) received SIGTERM through pidfds. All
four subsequently disappeared. No native process or communicator was signaled,
and no private runtime directory was manually removed.

## Fix and regression proof

cxx 0.9.129 discovers a matching process, opens its Linux pidfd, rechecks its
private-home environment and blocks on kernel process exit. Every wake rescans
for surviving users before cleanup. Unsupported pidfds retain a one-second
fallback; an unreadable process catalogue delays retry by 30 seconds. Other
platforms retain their existing process fence with a one-second retry.

The new Linux regression starts two real holders, verifies an open pidfd while
waiting, preserves the fence after one exits, and verifies wakeup after the last
holder exits. A sibling directory does not count as a holder. Existing tests
cover a SIGKILLed launcher, inherited/closed child descriptors, maintenance-lock
retention, failed exec and guarded directory sweeping.

A controlled real-helper probe compared the installed 0.9.128 executable with
the patched Go test executable's actual reaper entrypoint. Both used an isolated
0700 temporary directory, a real inherited lease and a real `sleep` process
whose environment named the private home. No provider credentials or inference
were used. CPU came from `/proc/<helper>/stat` deltas over three seconds after
startup, expressed as percent of one core:

| Helper | CPU | Protected while holder lived | Cleaned after exit | Exit |
| --- | --- | --- | --- | --- |
| Installed 0.9.128 | 37.0% | yes | yes | 0 |
| Patched | 0.0% at clock-tick resolution | yes | yes | 0 |

This short probe proves the observed hot loop is removed on this Linux host;
it is not a long-duration or all-platform CPU benchmark.

Targeted directory tests passed with and without the race detector. `go build
./...` and `go vet ./...` passed. The initial full Go run inherited the managed
session's portal socket into MCP subprocess fixtures and failed with
`communicator_mcp_host_mismatch`; repeat the suite without
`CXX_AGENT_PORTAL_SOCKET`, `CXX_AGENT_PORTAL_SESSION_ID`,
`CXX_AGENT_PORTAL_ENGINE` and `CXX_MCP_BEARER` to isolate fixture traffic.
The complete repeated `go test ./...` run with those variables removed passed.
API and frontend suites were not rerun for this wrapper-only change.

## Rollout boundary

No API implementation or database schema change is needed. Wrapper publication
and deployment must be coordinated with Rosa-Maria's concurrent Git/claims
repair on docker01.uggs.io. Existing helpers do not change when a new executable
is installed; they require their ordinary exit or an explicitly authorized stop.
The runtime protection and credential refresh ownership remain unchanged.
