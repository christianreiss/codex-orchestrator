# Actual native startup comparison — Elvira, 2026-10-13

Status: this comparison is complete; healthy-startup acceptance remains open.

## Scope and controls

This is a separate measurement from the earlier nine successful native smoke
sessions. It runs actual Codex, Claude and Grok executables against the live fleet
API on the same existing test2 user. It does not deploy the candidate API.

- VM identity: libvirt `test2`, MAC `52:54:00:24:7f:02`, 8 vCPUs, observed address
  `10.2.0.212`, hostname `test2.eulie.de`, fleet host ID 256.
- User: `comm-elvira-ca1fb4ad`, UID 999; private HOME
  `/opt/coco-comm-audit-elvira/home`. Root and peer namespaces are preserved.
- Baseline: pre-comm `fc048f2def112a4af72bcdfcc9cffa156233e0d4`, version 0.9.70.
- Candidate: immutable `2177faab15ca80cd53056fd7fabd256cc71129dc`, version 0.9.78.
  Later `comm` merges are not silently included in this measurement.
- Native installs: Codex 0.162.1, Claude 2.1.296, Grok 1.0.50.
- The existing signed configuration sources and verifier are retained; normal signed refresh remains active. All three advertise communicator protocol
  1 and sync protocol 1; the baseline predates and ignores these capabilities.
- Existing local account-binding metadata: Codex 2, Claude 1, Grok 7. No manual
  credential or account rotation, no copied provider credentials.
- `CXX_BACKGROUND_MAINTENANCE=0` for both builds prevents asynchronous binary or
  native updates during the comparison. This excludes update-worker contention;
  it does not skip launch auth/account validation or managed content sync.
- A cold run stops only this user's idle receiver service and communicator owner
  before launch. Warm runs follow on the same user state. Concurrent runs start
  one instance of each engine within milliseconds; there is no same-engine pair.
- Each prompt asks for exactly one `agent_self` call and an authenticated identity
  plus a unique marker, with no file changes, shell commands, messages or spawns.

The passive sampler records `time.monotonic_ns()` from wrapper command start and
polls `/proc` every 10 ms. Native-exec time means the first observed real provider
process (excluding `--version` probes); it includes the wrapper's required setup,
not the model response. First output and final exit are separate. Codex exposes an
`agent_self (completed)` event; Claude and Grok's buffered outputs only establish
MCP completion by the final response, not the precise instant MCP became ready.
These headless runs do not measure interactive terminal first-paint latency.

An initial baseline build used a different local public key and failed closed
with `config signature invalid` before any native process. It is excluded from
latency comparisons. Both measured artifacts were rebuilt with the same tracked
public key as the prior working candidate; no config signature was weakened.

## Artifacts

The private harness and immutable source archives are under
`/tmp/elvira-native-startup-ca1fb4ad` on biest. Raw per-phase `events.jsonl`,
`lines.jsonl`, engine logs and `summary.json` are under
`/opt/coco-comm-audit-elvira/startup-latency` on test2.

| Build | SHA-256 |
| --- | --- |
| Pre-comm 0.9.70 | `c778c6b3d1383ffb0fc6758bb1e65466570458b16183a3f419ece8b5a47db1ba` |
| Candidate 0.9.78 | `0f6856d403140b6476ec08ea0d9d50964478fa6be07b73c1e8140e7c96709882` |

The ordinary artifacts have no timing instrumentation added to their source.
Separate diagnostic builds, if used, are identified independently and do not
replace the ordinary-build comparison.

## Load and timing limits

Guest load was below 1 during the first serial samples, but the physical host had
load averages around 50. Low guest load alone does not establish absence of host
contention. Later harness runs also retain `/proc/stat` before/after counters,
including CPU steal time; the initial baseline samples do not have those counters.
The matrix is an initial controlled sample, not a percentile benchmark. API load,
provider latency and configuration/contact bookkeeping can vary between runs.

## Ordinary-build results

All 24 measured launches exited zero and returned their identity marker. Times below are seconds to actual native exec; there is one sample per cell.

| Engine | Serial cold, pre-comm / candidate | Serial warm, pre-comm / candidate | Concurrent cold, pre-comm / candidate | Concurrent warm, pre-comm / candidate |
| --- | --- | --- | --- | --- |
| Codex | 13.84 / 22.69 | 11.21 / 13.06 | 16.05 / 21.83 | 13.07 / 15.16 |
| Claude | 12.19 / 16.25 | 14.15 / 16.27 | 18.56 / 20.15 | 14.63 / 15.44 |
| Grok | 14.65 / 15.22 | 15.20 / 13.85 | 19.44 / 20.98 | 16.24 / 17.38 |

The largest first-matrix increase is cold Codex (+8.85 seconds serial, +5.78 seconds concurrent). Warm Grok was 1.35 seconds faster. This is evidence of a startup concern, not proof that every launch is slower or that all extra time has the same cause.

## Diagnostic stage traces and cold-owner finding

Separate builds add local-file function begin/end markers. Durations use Go's
monotonic clock; labels contain function names and allowlisted HTTP route names,
not request headers, bodies, auth material or model prompts. No exporter or new
network destination is enabled. These builds are explicitly distinct from the
ordinary artifacts above. Config/load, communicator ensure, foreground bootstrap,
scope gate, account selection, portal registration and native process entry are
observed; full receiver initialization and interactive UI first paint are not
individually instrumented.

| Stage, milliseconds | Pre-comm Codex | Candidate Codex | Pre-comm Claude | Candidate Claude | Pre-comm Grok | Candidate Grok |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Signed config LoadOrRecover | 0.63 | 0.20 | 0.59 | 0.15 | n/a | n/a |
| Foreground bootstrap/content | 5070.83 | 4616.99 | 6250.55 | 4482.48 | 4018.22 | 5924.84 |
| Account selection | 1249.63 | 1100.61 | 1069.94 | 2604.48 | 846.84 | 1875.02 |
| Portal StartConnection | 1501.17 | 963.04 | 991.51 | 2162.64 | 726.09 | 1274.29 |
| Native exec | 11323.08 | 13693.30 | 11304.37 | 15515.45 | 8883.30 | 17688.03 |

These are individual inclusive function durations, not an additive decomposition.
Grok uses its own config-load path. Cold owner `ensure` took about 31 ms; this is
local owner availability, not proof that the upstream WebSocket handshake had
finished. API timings vary significantly between repetitions, including baseline
Grok moving from 14.65 seconds to 8.88 seconds to native exec.

The unmodified candidate Codex trace shows two `/sync/bootstrap` requests taking
4548.95 and 3534.89 ms. The scheduled content operation waited 3896.82 ms for the
foreground bootstrap; the later foreground skills operation then waited 2371.69
ms behind that extra content operation.

Applying only Claudine's initial fix `55b79b62` did not remove the second exchange
on the live cold owner. A further diagnostic captured this exact ordering:

| Relative time, ms | Event |
| ---: | --- |
| 0.0 | Foreground bootstrap worker starts |
| 840.1 | First WebSocket connection becomes ready; local connectLoop invalidates |
| 840.1 | Scheduler records the invalidation |
| 5678.4 | Bootstrap completes and records its original worker start as fresh |
| 5678.5 | Scheduled pass rejects freshness because the connect invalidation is newer |
| 5678.5 | Second content worker starts |
| 11356.5 | Content completes; foreground skills can proceed |

There were **zero remote invalidate frames** during this reproduction. This
isolates the first-connection ordering gap from the separate old-server event
broadcast issue. The detailed diagnostic binary digest was
`1c902309106dc9b97c2bbd0f546b0c495ecf5637223efa59660ce14eea898957`.

Claudine's follow-ups `4492a56c` and `f4b8bff7` address distinct scheduled versus
explicit coalescing, initial scheduling order, invalidation arrival timestamps and
first-connection versus reconnect handling. Her `d41c7759` adds delayed-connect
and reconnect coverage. Their source integration remains with the existing fix
owners; this report's worktree changes documentation only.

The three delayed-connect, later-invalidation and reconnect tests pass with
`-race` against the combined private wrapper source (13.019 seconds):

```sh
go test -race ./internal/communicator \
  -run 'Test(FreshScopeLaunchSharesOneContentExchange|InvalidationAfterLaunchStillRefreshesContent|ReconnectAfterLaunchStillRefreshesContent)$' \
  -count=1 -timeout=120s
```

The private comparison applies `55b79b62`, `4492a56c` and `f4b8bff7` to the pinned
`2177faab` wrapper. The last patch needed a context adjustment around intervening
owner-control fields; those fields were preserved. The combined source patch is
`/tmp/elvira-native-startup-ca1fb4ad/combined-startup-fixes.patch`, SHA-256
`0bf404fabddf29237e083889e43c4e5d40dcce0ae6b5685923bf59919c0580a1`.
It does not include the proposed API concurrency change `5f77a1d7`.

## Updated wrapper-fix candidate

The combined ordinary binary SHA-256 is `5883c1577b127302efbe5f81f1a0f56a005d926189523943f4314bc573769d3d`. All 12 launches passed. Times are seconds to native exec, again one sample per cell.

| Engine | Serial cold | Serial warm | Concurrent cold | Concurrent warm |
| --- | ---: | ---: | ---: | ---: |
| Codex | 13.05 | 13.41 | 30.47 | 19.12 |
| Claude | 14.79 | 17.76 | 34.98 | 17.97 |
| Grok | 20.39 | 14.84 | 38.41 | 19.34 |

The cold Codex serial sample improves, but the overall healthy-startup acceptance remains **open**: other cases are slower, especially the later concurrent run. The three wrapper fixes cannot be called a complete live latency resolution from these results. The live API was not replaced with the combined branch; the effects of that server update and current API load remain separate open measurements.


## Final updated-fix diagnostic and receipt

A final actual Grok trace with all three wrapper fixes shows the initial scheduled
pass accepting the foreground content result: `satisfied=true`. Before native
exec there is one bootstrap (3425.5 ms) plus host-user reporting (1215.4 ms),
producing a 5006.6 ms foreground content stage. Later required `/auth` operations
consume 3262.1, 1568.0 and 1713.6 ms; the account-selection span includes the middle
request and must not be added to it. Portal startup consumes 1065.4 ms. Native exec
is at 14775.3 ms. A later background content exchange occurs after native exec.
This confirms the redundant initial pass was skipped in this run; it does not
justify removing authentication, account-lease or receiver checks.

Across this pass, **36 ordinary-build launches and 11 diagnostic launches**
completed successfully. Claude and Grok native transcript records independently
show exactly one `agent_self` call and its authenticated identity result in all
31 relevant sessions. Their sanitized receipts (name, UUID, engine, tool count,
marker and transcript path) are in `native-tool-receipts.json`. Codex logs expose
the completed MCP call directly for all 16 corresponding sessions. These are
functional and timing receipts, not a claim of interactive UI acceptance.

The last diagnostic uses binary digest
`48ab6fb7fd218b1f5f1401df741d7cb22ddcfe37c7c95dc27c924136909b6457`.
Test2's private user was restored to the ordinary `2177faab` / 0.9.78 artifact
(`0f6856d403140b6476ec08ea0d9d50964478fa6be07b73c1e8140e7c96709882`), with its
supported receiver service installed and active. Profile builds were not left
running. The fixed comparison artifacts remain private and were not published.
No root/peer services or fleet settings were changed. There were no manual signed-config edits or provider credential rotations; normal verified synchronization remained active. Account binding metadata remains Codex 2, Claude 1,
Grok 7. Source-fix integration and final combined API/client acceptance remain
with the group; no production rollout was performed.


Final `communicator doctor` after restoration exited zero: connected, no HTTPS
fallback, empty `last_error` and empty `local_errors` (owner PID 49500 at check).
The evidence archive on biest is
`/tmp/elvira-native-startup-ca1fb4ad/startup-evidence.tar.gz` (141115 bytes), SHA-256
`24f49ee77c53ad77533ef4ee4810c5727023fb3a3b57cbc1313ef9bbac367c2a`.
It contains timing samples, local stage traces, sanitized native identity receipts,
the private harness and the combined source patch. It contains no provider auth
files or signed host configs.
