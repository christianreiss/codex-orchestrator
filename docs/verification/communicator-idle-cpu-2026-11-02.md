# Communicator idle CPU diagnosis — 2026-11-02

Feedback: `a8302acb-e76b-4ddc-a453-5fcf72a552de`.
Baseline source: `9369fa9262b736cfe2ccf9a497e337516a8a4388`.
Fix version: cxx 0.9.155.

## Live observations on biest.eulie.de

- Initial communicator PID 3970260: loaded cxx 0.9.148, installed 0.9.154,
  replaced executable; 111% CPU in a five-second `/proc` sample.
- A five-second syscall summary counted 144,477 `newfstatat` and 9,725 `openat`
  calls. A separate two-second pathname-only trace counted 54,682 stat/open
  calls, repeatedly checking native homes, all three signed engine configs,
  and Codex/Claude auth files.
- An inotify read sample had only 11 reads of the sync watch FD in two seconds,
  compared with 8,349 regular-file reads: the scan rate was not explained by
  incoming watch events.
- During follow-up the owner had independently changed to PID 1696095.
  `/proc/1696095/exe --wrapper-version` identified cxx 0.9.154, commit 9369fa926.
  A three-second CPU sample measured 110.3%; a two-second pathname-only trace
  counted 53,542 stat/open calls. An installed-version mismatch was therefore
  not the cause of the continuing symptom.
- Both owners reported a healthy connection/MCP and no running sync. Grok had
  a shared home/content state plus a checked private-broker auth state.
  The shared content-only state's pending auth marker alone is not an auth
  failure. Transport leases are not native-agent counts.

Tracing captured syscall counts and paths, not auth/config contents. Short
`timeout -s INT` trace windows intentionally end the tracer, never the target.
This task did not stop, restart, replace or install any live process or service.

## Root cause and minimal reproduction

`syncLoop` deduplicated leases by native source/broker, sorted those scope keys,
and chose one content owner per home. `nextSyncWake` instead sorted the raw
lease hashes and chose the first lease per home. A private Grok auth lease can
sort first by hash while the shared home wins the dispatcher's election.
That private state's unused `nextContent` stays zero. After initial grace,
the timer fires immediately on every iteration, but the dispatcher never runs
content for that state and never advances its deadline. Each iteration still
canonicalizes paths, verifies signed config and checks auth-file generations
for the other engines sharing the owner.

Before changing production code, this command failed three times identically:

```sh
cd wrappers/cxx
go test ./internal/communicator \
  -run '^TestSync(WakeIgnoresPrivateGrokContentDeadline|LoopDoesNotRescanIdleGrokLeases)$' \
  -count=3
```

The deadline test reported `delay=0s scheduled=true` despite all runnable
deadlines being one hour ahead. The actual-loop test observed rescans in
10/10 idle windows, with no file events, network work or due deadlines.

The fix extracts the dispatcher's existing deterministic plan and uses it for
both deadline calculation and execution. It changes neither provider refresh
ownership nor authentication checks. Timer and actual-loop regressions pass;
verbose repeated runs report 0/10 idle rescan windows. Additional cases cover
multiple private broker auth deadlines, content-owner removal/re-election,
Codex/Claude/Grok deadlines, initial-content grace, missing states, missing-watch
fallback, running/suspended states, disconnection and draining fences.

## Verification

Passed on biest.eulie.de, with broad Go runs limited to `GOMAXPROCS=4`:

- `go build ./...` and `go vet ./...` in `wrappers/cxx`.
- `make test` in `wrappers`, including release-manifest/publication tests.
- `go test -race ./...` in `wrappers/cxx`.
- `make test-traced` (tagged vet and full tests).
- `make test-terminal`: 451 terminal cases passed across three engines.
- `make cxx`: staged local Linux binary builds as version 0.9.155.
- Targeted scheduler regressions passed ten repetitions, then twenty with the
  race detector; final verbose runs reported 0/10 idle rescan windows.
- `git diff --check` and formatting checks.

At the initial source-verification boundary, not run: staticcheck/govulncheck (not installed), cross-platform release builds,
API/database/frontend suites (those implementations are unchanged), and live
rollout acceptance. No temporary production instrumentation was added.

## Delivery boundary

The source fix and wrapper version bump do not update a loaded owner. Production
CPU improvement remained unverified until an explicitly authorized installation
and coordinated retirement/handoff load the corrected binary. Keep live native
sessions and accepted work intact. No API/database/frontend changes are required.

## Authorized rollout acceptance

On 2026-11-02, `d278484bfd0d0d520b62fb73c03a2addef4d3752` was pushed to
origin/main and deployed on docker01.uggs.io by detached deployment
`54aef828-f790-4209-a0a8-880f9d5deb9f` (exit 0; 08:24:09–08:29:59 UTC).
All four wrapper platforms were built and published. Migration status: 120
applied, zero pending, zero drifted. API and media worker were recreated; the
loaded API build identity matches the clean source commit. No extra database or
store backup was created, following the deployment runbook. Previous API image:
`codex-orchestrator-api:rollback-20261102-pred278484bf`.

On biest.eulie.de, the signed minimal update and daemon installation loaded cxx
0.9.155. Acknowledged administrative termination retired owner PID 1696095
(0.9.154) without signaling its native children. Replacement owner PID 1791237
reported instance `0cbb9450-baed-4ed1-9da1-0c2ac7e5f2ad`, seven managed sessions
and four sync scopes. All 15 native processes retained their PID and start ticks.
Installed binary, daemon copy, loaded owner and worker all matched served SHA-256
`4c4869594cccdbd58099dd30e179ab223d8be28295f98f1b041ea49c4db38c3c`.

Post-restart CPU samples were 3.20%, 3.00%, 3.20% over five seconds each, versus
110.3% on the old owner. `stat`/`open` calls fell from 53,542 to 890 over two
seconds. Active native file events remain real work; this is not a zero-CPU claim.
The public versions endpoint advertised 0.9.155 with the matching hash. Existing
native sessions reconnected; no crash/recovery or fresh transcript was needed.
