# Grok tool diagnostics investigation — 2026-10-08

## Finding

The reported terminal fragment occurred at `12:50:27.569Z`, native session
`01a11b8e-79b9-7532-8d39-5afc03d0c03f`, tool call
`call-1be7e992-cb35-4d82-8cc8-87ecb7d65ab0-38`.
The native `chat_history.jsonl` records a `read_file` invocation with
`target_file="internal/protocol/alarm.go"` and `limit=120`. There is no
`task_ids` argument. Its `updates.jsonl` records status `failed` and
`rawOutput.type=ReadFile`, with `FileNotFound` naming that missing file and
suggesting `alarm_control.go` and `alarm_control_test.go`.
The model received the same file-not-found result. The adjacent successful read
has a different call ID ending in `-37`.

This proves a missing-file tool failure, not an oversized task batch. It does
not prove why the screenshot also contains a `task_ids` error string.
The installed and running official Grok binary is 1.0.46; the official npm
latest endpoint also returned 1.0.46 during this investigation.

## Reproduction and correction

An isolated access-only native canary (no refresh credential) used the official
Grok binary, Grok 4.7 and a deliberately missing file. Headless and private-leader
ACP runs both delivered the correct `ReadFile.FileNotFound` result. A real PTY
interactive run additionally emitted `ERROR tool_error: tool_output_error` on
**leader stderr**, while the TUI showed the actual missing-file failure. That
reproduction did not emit the screenshot's `task_ids` text.

Previously the managed background leader inherited the TUI's stderr, letting
raw Rust tracing write into its terminal independently of the renderer.
Wrapper **0.9.31** gives each managed interactive leader a private mode-0600
log, capped at 1 MiB per file by starting a new chunk on overflow. Logs survive
runtime cleanup, `cgx doctor` locates their directory, and failure messages name
the relevant file. Native tool results and foreground stderr remain intact.
No provider binary is patched and no tool error is suppressed in the model's
transcript. Existing native sessions need an ordinary exit/resume to pick up
the wrapper change; this release does not interrupt them.

The initial 0.9.30-grok.1 publication exposed an existing updater limitation:
client version comparison ignores prerelease suffixes. The final release is
therefore stable 0.9.31, which older wrappers can reach from either 0.9.29 or
0.9.30-grok.1. The concurrently prepared feature release is reserved as 0.9.32;
only its pending version labels were adjusted, without committing its changes.

## Verification

- Targeted Go suites cover private per-run files, concurrent separation,
  preservation of raw diagnostics, terminal separation, size bounds/recent
  output, and visible file-open failure.
- Live reproduction artifacts: `/tmp/grok-read-file-20261008/` on `biest.eulie.de`;
  ephemeral native auth homes were removed after each run.
- `make test`, `make test-traced`, `go build ./...`, `go vet ./...`, and targeted
  Grok runtime/application race tests passed in a clean exported source snapshot.
- Corrected-path native PTY canary: session `01a11bad-900a-7243-90d3-43b67ac41211`
  showed a failed read in the TUI, preserved the actual missing-file tool result
  in the native transcript, and wrote the raw trace only to its mode-0600 file;
  captured terminal/leader stderr contained no raw trace. The PTY was stopped
  after observing tool delivery, without requiring a final model answer.
- The initial test assertion expected expanded error text in the collapsed TUI
  row; it was corrected to check the visible failed-read status and exact native
  transcript result. No product code changed to accommodate that assertion.
- Final production receipt follows.

## Limits

The native provider implementation is closed source in the installed package.
This fixes our background-output routing; it does not claim an upstream tool
formatter fix. Custom externally managed leaders and tools-only headless runs
retain their native output contract. Log files are private and bounded
individually; operators can remove old files after diagnosis.

## Production receipt — 2026-10-08 13:34 UTC

- Fix commit `1f6c89be`; final stable release commit `51608192`, pushed to
  `origin/main`. `scripts/deploy.sh` rebuilt and restarted API/quota-cron on
  `docker01.uggs.io` and published all four wrapper platforms as **0.9.31**.
- All manifest checksums matched their actual files; Linux amd64 embeds commit
  `51608192`, built `2026-10-08T13:28:46Z`. SHA-256:
  `ea1ba0884add80220317b61309165c380fa1f7cdf322522ccb038c52f96997f4`.
- API and auth runner checks passed; MySQL reports 44 migrations applied, zero
  pending and zero drifted. Public HTTPS and local API health checks passed.
- `cgx update` on `biest.eulie.de` installed that exact binary and reported the
  version successfully; `cgx doctor --minimal` passed all checks and displayed
  the new leader-log location.
- Full managed native PTY canary, session `01a11bb7-d7e2-7833-ba21-12cfc77348b7`: Grok 4.7
  called the missing-file tool, received the correct error and completed its
  answer. The terminal contained no raw tool trace; the private leader log did.
  Normal native quit and wrapper cleanup returned exit **0**. The earlier
  harness sent only the first of Grok's two quit confirmations, so its forced
  teardown returned 255; the corrected harness confirmed normal termination.
- Rollback: API image `codex-orchestrator-api:rollback-grok-diagnostics-20261008`;
  prior commit and four manifests are in
  `/var/docker_data/codex-auth.uggs.io/app/backups/grok-diagnostics-20261008/`;
  database backup `backups/codex-orchestrator-20261008T132431Z.sql` (238199650
  bytes). No schema change was needed. Restore the prior manifests and recreate
  the API to change the offered release; hosts already updated require an
  explicit atomic reinstall of retained 0.9.29 to roll back their binary.
