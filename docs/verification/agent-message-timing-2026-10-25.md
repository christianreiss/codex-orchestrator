# Agent message timing verification — 2026-10-25

## Contract

Informational send/reply/publication accepts `delivery_timing` (`immediate` or
`after_turn`, the default). Immediate delivery preserves the running native turn
and its tools. Work admission remains separate. See [the contract](../agent-messaging-timing.md).

## Server and browser checks

- Broad API run: 6,372 passed, 1,112 skipped, five schema/documentation fixture
  failures. Migration 0105 intentionally adds one column. The corrections retain
  the frozen production baseline, project its exact migration, and independently
  compare migration additions against Drizzle. Focused schema/docs checks passed.
- Managed guidance and schema selection: 113 passed; all three document-column
  checks: seven passed. Another 34 timing/proof tests passed; their one additional
  docs-liveness failure was a quoted default misidentified as a column and was
  corrected and rerun successfully.
- Private MySQL 8.4: baseline plus 105 migrations applied. Timing, grouping,
  route and migration integration selection: 71 passed; a further causal-admission
  test passed. No production data was copied.
- Negative presentation path: six regressions first failed, then passed after
  consistent timing filters; all 15 tests in that file passed. Unsupported
  immediate messages trigger neither an owner command nor SQL presentation work.
- API TypeScript check passed. Changed TypeScript lint has zero errors and six
  existing unused-symbol warnings; final presentation-filter lint passed.
- Frontend check: zero Svelte errors/warnings, 999 unit tests passed. Broad browser
  run: 350 passed and four failed. The new timing selector label was corrected;
  all four failures passed with a fresh build and one worker. Other three cases
  required no source changes; their original transient failures remain recorded.

Go verification also exposed a pre-existing doctor assertion tied to random
temporary-path length: terminal wrapping could split the repair command. The
assertion now normalizes whitespace while retaining all content and sanitization
checks; production diagnostics are unchanged. The container must mount the full
repository because existing Grok/config fixtures live in `wrappers/testdata`.

Final canonical Go run passed all 63 test-bearing packages, followed by
`go build ./...` and `go vet ./...` (exit 0). Both wrapper manifest/publication
Python regression scripts also exited 0.

## Native protocol evidence

Codex 0.164.0, installed wrapper 0.9.133, isolated native TUI:

- Warmup completed before the long-tool turn.
- Original command `exec-33916688-cc89-47eb-b4c7-c55a1dfe1cfa` finished with exit 0
  and both start/end markers.
- Immediate marker appeared in the same turn
  `01a174f2-8193-7223-bbeb-7cb534b8fe81`.
- Deferred marker appeared only in successor
  `01a174f2-cfa9-79e3-a274-8999c8ea82df`, with no additional commands.
- This proves native primitives, not the complete candidate-134 server path.
  Evidence: `/tmp/rosa-native-timing-20261025/verified-summary.json`.
- Normal managed startup reconciled/restarted the docker01 host daemon to the
  already published wrapper 0.9.133. No existing native turn was targeted.

Remote biest probes independently recognized Codex `turn/steer` and Grok 1.0.50
`_x.ai/interject` through exact missing-required-field errors. No provider prompt
was submitted by those probes. Recognition alone does not prove tool continuity.

Claude 2.1.310 on biest uses blocking AF_UNIX socket stdout. Its original Go
`os.Stdout.SetWriteDeadline` returns `ErrNoDeadline`. The candidate wraps that
exclusive socket as a pollable connection and uses it for all MCP frames.
Actual exec-inherited socket tests prove valid NDJSON on success and hard deadline
plus permanent writer fencing after an uncertain partial write. Blocking inherited
pipes without deadline support remain unsupported. This does not replace a native
Claude model/tool continuity canary.

## Release gates

The server rollout is separate from publication of wrapper 0.9.134. Candidate receiver
canaries must be recorded before declaring the feature complete. Existing loaded receivers are not upgraded by replacing a binary.
Uncertain admission is never replayed or described as read/consumed.

## Native entry guard follow-up

Feedback `e0ec1f6f-1c9d-403b-b4d1-09eaa97f3a4c`: Grok 1.0.50 defaults bare
`agent` to headless, which bypassed the wrapper's explicit-headless refusal.
A passive driver consequently timed out before initialize and left only its own
idle probe processes. The original owner verified PID identity/cwd/start times,
stopped those two processes, and released its retained claim as canceled. No
provider prompt or shared/Natascha process was involved; no admin clear occurred.
Actual native help plus corrected managed stdio initialize/probe then passed and
exited normally. The guard now refuses the omitted mode without rewriting native
grammar. Regression first failed, then nativeargs/app-Grok race tests ×3 and
build/vet passed. No additional auth or refresh authority is introduced.

Live backend-only rollout: commit `f773f74958a91d9ec28789022841d1e926cb212a`,
API image `sha256:b76687942eaf6384914657c0f2aed5e8e4f28da858070df8bb2dfbb6000a0e33`,
healthy with zero restarts; 105 applied, zero pending/drifted migrations and all
544 embedded API sources match. Published wrapper remains 0.9.133 at this stage.
Actual candidate CLI → existing broker → new server capability test returned
requested immediate, effective null and receiver_capability_missing for an old
receiver. Its synthetic message was canceled: one canceled, zero ambiguous.

## Full receiver canaries and corrected Claude gates

Candidate134 Codex passed the complete CLI → parent broker → live server → fresh
receiver → native TUI path. Original60s tool exited0; immediate marker appeared
in original turn `01a1751a-2bd0-7f70-8d10-ab93d8d64515`, deferred marker only in
successor `01a1751b-852f-75f2-9ced-6308472ad188`. Both messages completed with
one attempt. One separately authorized administrative `agent_listen` closed the
deferred informational receipt after native consumption; it is outside timing
assertions. Fresh helper exited normally/auth unchanged and claims were released.
The root daemon was normally promoted to the staged candidate, with all six
pre-existing native PIDs preserved. Its managed Codex entry points to the candidate
until official release reconciliation; the candidate must not be removed first.

Candidate134 Grok likewise passed the full cross-engine sender/broker/server/
receiver pipeline on biest. Original prompt `7cf6dd2c-029a-4f4d-a635-3faca7ede622`
contained only base+immediate markers; the75s tool completed in75024ms, exit0,
no signal/timeout. Deferred message `4ca7bc4e-065e-4058-8a7e-41b0251e5a08`
ran only later and replied exactly the deferred marker. Both records completed;
one separately authorized administrative listen closed the immediate receipt.
The fresh helper exited0, its access-only runtime was removed, and its claim was
released. Existing Natascha, host daemon128 and canonical binary133 were preserved.

The first Claude full-pipeline canary correctly FAILED its deferred assertion.
Immediate notice was visible during a75s tool; that tool completed uninterrupted
and its original final contained the immediate marker. A6s synchronous hook delay
shifted the next tool start by6s and blocked it until hook completion. However,
the deferred row never reached presentation. Two concrete defects were fixed:

- The Go observer added a redundant top-level native instance field rejected by
  the strict API schema. Production change: remove that one field; retain nested
  proof. Actual captured Go bootstrap+fresh-idle payloads now pass the real TS
  schema, and restoring the old field is a negative control that fails.
- An actual provider/claim/presence regression reproduced claim-before-proof:
  null claim/no owner command, then valid server idle proof without a message
  change, but no receiver wake. Receiver work revision now includes only the
  authoritative Claude-idle boolean for capable receivers. True/false changes
  wake; unchanged proof/heartbeat/active state does not. No clocks, timers or SQL
  are added.36 focused tests, API typecheck and targeted lint pass.

The wire-fixed Go suite again passed all63 test-bearing packages, build and vet.
A fresh corrected Claude canary remains a publication gate; the earlier failure
must not be counted as a successful deferred-delivery test.

A30s mixed-canary production sample at22:08:17Z measured API3.589% of one core,
MySQL1.445%, and27 SQL questions (0.9/s, including measurement queries). It is not
an idle acceptance measurement. Unsupported readiness separately has zero-command/
zero-SQL regression coverage for all three engines.
