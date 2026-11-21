# Wrapper test isolation and native hook evidence

The test-home investigation started on cxx 0.9.198 (`b4139d8f37bc7d8de2fdec725d742916e933520d`). Test fixture and CI isolation landed in `4fa07ab1d70516decc38d503f0fff8a1afbebd96`. The subsequent receiver fixes shipped on the local integration branch in 0.9.199 (`1263e8ca5f415079d515a51e0404f07b3a53213b`) and 0.9.200 (`5b2fa6bf89363da180ffeaa8f308a4596f63c074`). Measurements ran on Linux amd64 with Go 1.26.10-X:nodwarf5.

## An inherited home allowed tests to write operator state

`internal/kimi.TestServerRendererMCPAndHooksGolden` gave the renderer a temporary native directory. Its ownership journal and file lock resolve via the operating-system home under `.ckx/state`. Parallel tests reported “another wrapper instance is running”. The outer profile on biest showed a modification time of 2026-11-21 20:40:15 UTC on the 420-byte `.ckx/state/managed-keys.json` during the unisolated suite. This is an observed metadata change with a reproduced writer. Attribution of the individual write and the earlier contents are unknown. The concurrent runs were stopped. No private contents were inspected or restored.

For a deterministic regression, hold a flock on `.ckx/state/managed-config.lock` in a synthetic caller home, then invoke the named test directly. It failed with the original fixture. With test-local isolation, five tagged Race repetitions passed while the caller continued to hold its lock.

| Evidence | Observation |
| --- | --- |
| Static Go AST scan | 109 top-level tests set a native home and lacked a visible OS-home setter through the inspected direct calls. This is a candidate count. |
| Full Go module, one fresh observable outer home per package | After correcting the Kimi renderer fixture, eight of 80 exercised packages still left wrapper-managed files. Isolating 1,103 top-level cases in these packages located 21 more writers. The standalone communicator process-name check needed the normal Go `.test` executable suffix and passed with it. |
| Direct `go test`, no package wrapper | All 22 identified tests passed with synthetic outer HOME, XDG and native directories, pre-existing sentinel files and a held Kimi journal lock. The caller's file list and SHA-256 hashes were identical before and after. |
| Full module after correction | All 80 package test executables passed. None left first-party files in its observed outer home. Six packages contained no test files. The normal run recorded 6,193 passing test/subtest events and 23 skips. |

The 21 additional tests were in `internal/agentportal` (10), `internal/agentbus` (2), `internal/claude` (3), `internal/kimi` (1), `internal/update` (1), `internal/persona/claude/update` (2), `internal/persona/codex/lifecycle` (1) and `internal/communicator` (1). They created delivery notices, release receipts, auth or install-space locks, or account sidecars. The shared `internal/testhome.Isolate` fixture confines the 22 confirmed direct cases. Make and CI additionally launch every Go package test executable with a private HOME and XDG runtime directory through `wrappers/scripts/go-test-home.sh`. The script clears inherited engine, configuration and socket overrides.

The acceptance reruns used a separate outer home, PID namespace and temporary filesystem. Opt-in native tests used an additional network namespace with loopback. Go module, build and analysis caches were reused. File inventories measure persistent writes after an observed test case. They cannot identify read access, files already removed or behavior in unexecuted platform/credential branches. Wall-clock waits and IPC used real timers, local processes and sockets.

From the checkout root the canonical Go gates are reproducible with:

```sh
make -C wrappers test
GOFLAGS=-count=1 make -C wrappers test-race
GOFLAGS='-count=1 -tags=cxx_otel' make -C wrappers test-race
GOFLAGS=-count=1 make -C wrappers test-traced
make -C wrappers test-terminal
```

Both full Race runs passed, with 6,193 normal and 6,202 tagged passing test/subtest events, 23 skips each. The tagged tests, builds, vet, gofmt and Staticcheck passed. Govulncheck found zero reachable vulnerabilities in either build. The 0.9.198 terminal preview passed 595 real PTY cases. Detailed commands, version output, skipped cases, file observations and sentinel comparisons are retained locally under `.review/dispatch198-gates/`.

## Native Kimi one-shot Stop continuation is intermittent

The 2.7.2 Linux x64 binary (SHA-256 `7f82148d26467874400d19ee8d23ead13cece9cd0c17648a5622cae48a5a596`) ran `-p probe --output-format stream-json` against an isolated synthetic streaming provider. The prompt hook reached the provider and the CLI returned a reply. In 12 identical serial executions of `internal/agentbus.TestKimiNativeHooksCanary`, only nine delivered the blocking Stop hook's stderr in a second provider request. Three exited first. This is the native entry mode used for `ckx --execute`.

A second set of 12 runs added diagnostic logging to the test through a Go overlay. Three recorded both provider requests. Of the nine with one request, seven recorded the Stop hook and its on-disk marker before native exit, and two had neither at exit. The timing differed under observation. Neither ratio estimates a production delivery rate. The real hook canary retains its requirement for an actual second request. The separate interactive PTY observation is documented in [the Kimi interface](../interface-ckx.md). Subscription reachability and fleet task completion require their own evidence.

To repeat this particular canary, set `CXX_KIMI_CANARY_BIN` to the absolute path to the verified native binary, use an isolated caller home and loopback namespace, and run `go test -count=12 -run '^TestKimiNativeHooksCanary$' ./internal/agentbus` from `wrappers/cxx`. The local raw observations are in `isolated-kimi-hooks.jsonl` and `kimi-hooks-diagnostic.jsonl` under the gate directory.

The supported 2.5.3 fallback (Linux x64 SHA-256 `fba921820696dfa3ed5951c26e6d5cb307cd3929bf8b76215caf510fa8265090`) delivered the prompt marker and the blocking Stop marker in two provider requests in eight of eight serial native probes. The same fixture exposed the intermittent headless behavior in 2.7.2.

## Receiver ownership and the first explicit listen

These internal integration tests used a new MySQL 8.4 schema and real API owner on each run, a synthetic registered host, peer sessions, the production per-launch Unix broker, the actual Go receiver, native Kimi with real cxx hooks, and a loopback streaming inference fixture. The harness drove the authenticated host WebSocket. In the 0.9.200 tests a local carrier transported the broker's receiver-state frames to the live owner. The owner performed admission, generations, state updates, claims and commits. Operator rights and native model entitlement have separate checks.

| Revision and setup | Observed outcome |
| --- | --- |
| 0.9.198, peer messaging on, Portal off | Three Kimi starts per native version. Receiver registration succeeded, then the ungranted activity report returned 503. The local bridge carried that terminal error into mailbox reads and session finish in all six cases. The request remained queued. |
| 0.9.199, peer messaging on, Portal off | Three starts per version. The broker returned the pending ID and SQL showed zero task-result rows. Kimi 2.7.2 exited after one inference request in all three. 2.5.3 sent the continuation in its second request in all three. Finishing each wrapper session preserved the queued request. |
| 0.9.199, live session stream, Portal on | Receiver registration returned 200. Activity returned 409 `agent_activity_binding_changed`. The first real 15-second heartbeat failed with 409 `receiver_expired`. The receiver became unavailable and the listen precondition failed. The session stream alone could not grant receiver authority. |
| 0.9.200, both Portal settings with peer messaging on | The distinct authenticated receiver stream opened with the registered generation. After 17 wall-clock seconds the receiver was ready. Activity returned 200 with the Portal enabled. The disabled run sent no activity report. The native 2.7.2 one-shot returned after one inference request. Read-only mailbox and SQL agreed on the pending ID, with null lease/claim, acceptance, completion and result. |
| Actual MCP handler, explicit read after the 17-second window | On both Portal settings the test caller invoked the production `agent_listen` handler. It returned the original work body, leased it to this session and recorded durable acceptance with the same claim ID. No completion or result row appeared. Ending a session holding that accepted work preserved the claim and changed its status to `ambiguous`. Ending a session after the ring alone preserved `queued`. No model tool invocation or task execution was inferred from hook output. |

Two equivalent 0.9.200 runs with Kimi 2.5.3, one per Portal setting, reached two inference requests. SQL still showed zero delivery attempts immediately after the ring. The subsequent explicit listen produced exactly one HTTP claim and one accepted ACK per run, both HTTP 200 with the same claim ID. SQL then showed one attempt, a recorded acceptance and zero result rows. The logs are `200-kimi253-mcp-{on,off}.log`. All four 17-second tests completed with the registered receiver still ready.

The original MCP code attempted a second legacy receive binding for the registered receiver. The live owner correctly refused it with 409 `receiver_owned`. Version 0.9.200 uses the registered receiver generation for the claim. The standalone listener still binds explicitly. The regular Go regressions use production receiver, Unix WebSocket and MCP code with a synthetic owner HTTP API. They check required and legacy streams, disconnect/cancel, lack of background claims, and separate listen/accept behavior. Against the 0.9.199 sources the new tests failed on the missing stream and competing bind. Reproduce from `wrappers/cxx` with `go test -race -count=5 -run 'TestKimiReceiver|TestReceiverCannotDowngradeNegotiatedState|TestKimiListen|TestAgentListen' ./internal/agentbus`; add `-tags=cxx_otel` for the tracing build. The full native/owner runs and SQL receipts are in the local gate directory (`199-kimi-owner-heartbeat-red.log`, `200-kimi-mcp-read-{on,off}.log`).
