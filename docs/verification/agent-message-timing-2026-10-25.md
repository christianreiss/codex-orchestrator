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
