# Engine maintenance — 2026-10-28

Run `michelle-44031d5a` executes [the maintenance contract](prompts/engine-maintenance.md) together with
the [feedback sweep](prompts/feedback-sweep.md). Research and implementation ran per engine in separate
subagents, one branch and worktree per issue; the parent integrated them on
`sweep-integration-44031d5a`. The operator explicitly asked for merge, push and deployment, which
supersedes the contract's source-only default. Native probes used disposable homes and never logged in
or ran inference. The research reports are scratch data and are not committed; their findings and
evidence are summarised here.

## Sources and versions

All retrievals occurred on **2026-10-28**.

| Engine | Upstream latest stable | Previous evidenced state | Fleet runner pin (before → after) | Fleet host target |
| --- | --- | --- | --- | --- |
| Codex | 0.165.0 (`rust-v0.165.0`, published 2026-10-27, commit `360319d8dee6`) | 0.164.0 | 0.164.0 → **0.165.0** | follows GitHub `releases/latest` (already 0.165.0) |
| Claude Code | 2.1.312 npm `latest` (`stable` channel still 2.1.308) | 2.1.310 | 2.1.310 → **2.1.312** | operator/server preference, not queried |
| Grok Build | 1.0.70 (stable pointer and npm `latest`); alpha 1.0.73 is not a target | 1.0.70 | 1.0.70 (unchanged) | **1.0.50** (`GROK_MIN_CLIENT_VERSION` fallback; see CGX-6) |

Codex: versioned schema SHA-256 `bc14a890a74c7f9a4eb83d772550fe8813c7f389f44c1f18499f0ce24a8e4a60`
(103 root fields, byte-identical to the hosted schema); bundled model catalog SHA-256
`1384625c0b6b3e67d3c60da29becea2b017f2c283fc1e2d05b8edafb4698eb10`. `codex-rs/cli/src/main.rs` and
`exec/src/cli.rs` are identical between 0.164.0 and 0.165.0, so the root grammar did not change.

Claude: root CLI flags are identical between 2.1.310 and 2.1.312. 2.1.311/2.1.312 fix `claude -p`
problems the runner exercises (transcript ordering, retries the API marked non-retryable, an invalid
command name leaving `claude -p` without output).

Grok: the 1.0.70 binary prints `grok 1.0.70 (f50904eaee6c)` in a clean home and reports
`"channel":"unknown"`. This **corrects the 2026-10-26 record**, which called the 1.0.70 build "alpha":
a channel suffix comes from local install/config state. The 2026-10-26 "final source pin 1.0.70" wording
concerns the **runner only**; the version hosts install is still the 1.0.50 baseline default.

Server-stored global and host version pins were not queried (no admin credential was used).

## Configuration coverage

| Engine | Result |
| --- | --- |
| Codex | Registry audited against the 0.165.0 schema: new `guardianv3` (bool or `{enabled}`), `guardian_recorded_items`, `prediction_preserve_parent_tools`, `tui_multi_backend`, `auto_review.timeout_ms` and the built-in Vertex provider (`model_provider = "gcp"`) are accepted and raise the host native floor to 0.165.0 at root and profile level (CDX-1). Reserved provider IDs and field overrides Codex refuses to load are rejected (CDX-2). |
| Claude | Settings index, enums, root grammar, effort and catalog values re-verified against 2.1.312; "verified" labels moved from 2.1.296/2.1.310 (CLX-8). `advisorModel` validated (CLX-5); `minimumVersion` reserved (CLX-6). |
| Grok | Registry audited against the 1.0.70 reference. Update-policy and inert keys rejected (CGX-5, CGX-8); the private runtime carries native home state (CGX-1). |

## Models, effort and tiers

- **Catalogs.** No model is added, retired or re-defaulted by this run beyond CLX-1: every retired Sonnet ID
  (`claude-3-5-sonnet-*`, `claude-sonnet-4-20250514`, `claude-3-sonnet-20240229`, …) now migrates to
  `claude-sonnet-5-5` as the vendor lists it, instead of some to `claude-sonnet-5`. Stored
  `claude-sonnet-5` values stay untouched.
- **Minimum CLI versions (CLX-2).** Fable 5.1 2.1.257, Opus 5.5 2.1.280, Sonnet 5.5 2.1.284, Haiku 5.5
  2.1.293 are now enforced the way Terra 0.159.0 already was for Codex.
- **Tier proposals.** The three research reports proposed *no* tier change. The operator's separate
  five-tier ruling (Tier 5 Astra/Fable, Tier 4 Opus, Tier 3 Sonnet/Sol, Tier 2 Terra/Grok 4.6/4.7/4.7 Fast,
  Tier 1 Haiku/Luna/Grok 4.5) arrived from a peer session and is merged unchanged; it supersedes the
  stale-Grok-tier documentation finding (CDX-6).
- **Open (U-1).** Astra default effort: repo `medium` vs bundled 0.165.0 `low`. Unresolved; the account
  catalog the CLI uses at runtime was not read.

## Feature decisions

- Codex `features.async_compaction` is still "under development" in 0.165.0 and stays off by default. It
  was made default-on on 2026-10-16 and withdrawn the same day. Native auto-compaction is already on and
  `model_auto_compact_token_limit` is unset by default. The Engines editor already has the
  "Async compaction" switch. Turning it on fleet-wide needs an operator decision.
- No new Claude or Grok feature is enabled by default. Alpha-only Grok features stay on the watch list.

## Issues and fixes

| ID | Engine | Result | Commit |
| --- | --- | --- | --- |
| CDX-1 | Codex | 0.165 schema vendored, gates and version floor | `01eaa1870` |
| CDX-2 | Codex | provider-override rejection (input, profile sidecars, rendered document) | `01eaa1870` |
| CDX-3 | Codex | `exec resume|fork -i` single-value image | `eb86f68f4` |
| CDX-4 | Codex | `memories_v2_1.sqlite` housekeeping | `e90dffafd` |
| CDX-5 | Codex | native value table complete (+ corpus pin `523728ea4`) | `eb86f68f4` |
| CDX-6 | Codex | Grok tier docs: superseded by the five-tier ruling | `3948798ec` |
| CDX-7 | Codex | `SUPPORTED_MODELS` comment corrected | `01eaa1870` |
| CDX-8 | Codex | runner pin 0.165.0 | `01eaa1870` |
| CLX-1 | Claude | retired Sonnet IDs → `claude-sonnet-5-5` | `40daa4b66` |
| CLX-2 | Claude | per-model minimum CLI versions enforced (+ docs `829415057`) | `77328dbf8` |
| CLX-3 | Claude | `/anthropic/v1` accepts `anthropic-version: 2026-10-21` | `2c02ee808` |
| CLX-4 | Claude | `doctor` no longer warns about Haiku 5.5 auto mode | `e90dffafd` |
| CLX-5 | Claude | `advisorModel` validation | `624deae60` |
| CLX-6 | Claude | native `minimumVersion` reserved | `624deae60` |
| CLX-7 | Claude | `/anthropic/v1/models` carries `line` | `2c02ee808` |
| CLX-8 | Claude | runner pin 2.1.312, labels | `d3fb8eb20` |
| CGX-1 | Grok | private runtime carries native home state | `3e5330c93` |
| CGX-2 | Grok | `grok leader worker` refused | `39504e36b` |
| CGX-3 | Grok | `grok update --version` no longer bypasses the update refusal | `39504e36b` |
| CGX-4 | Grok | `grok setup` and native sign-in flags refused | `39504e36b` |
| CGX-5 | Grok | fleet-owned update keys rejected | `624deae60` |
| CGX-6 | Grok | production target still 1.0.50 — **operator decision**, not code | — |
| CGX-7 | Grok | docs corrected (this report; `docs/interface-cgx.md`) | this merge |
| CGX-8 | Grok | inert `compat.<vendor>.sessions` rejected; `features.zdr_access_enabled` gated per host (1.0.64+), not rejected | `624deae60` |

Feedback-queue items fixed on the same branch are listed in `CHANGELOG.md` (2026-10-28) with their ids.
Migration 0115 removes stored Grok update/compat-session keys and Claude `minimumVersion`, keeping
siblings, other engines and body/sha256 snapshots.

## Verification

- `npx tsc --noEmit` clean; `npx vitest run test/unit` passed on the integrated tree (5788 passed,
  9 skipped before the final merge, 5842 passed with the coordination tests afterwards). One timing test
  (`relay-long-poll`) timed out once under load and passes alone.
- `go build ./...`, `go vet ./...`, `go test -count=1 ./...` clean with `XDG_RUNTIME_DIR` as a 0700 directory
  (a 0755 directory makes 5 communicator-root tests fail on a clean tree).
- Native probes in disposable homes: Codex 0.165.0 and Grok 1.0.70 help/oracle tests pass; Grok 1.0.50 still
  fails the 1.0.70-only `--add-dir` oracle case, as before.
- Database tier and frontend: see the delivery notes in the commit and the run's final report.

## Open limits

- CGX-6: operator decided on 2026-10-28 to unpin and follow the latest Grok Build (code default `latest`,
  1.0.50 stays the floor). A production `client_version_grok` or `client_version_lock_grok` row still wins
  until Settings → Grok version is set to Latest.
- U-1 (Astra effort): operator decided `low` on 2026-10-28 (code default; stored fleet/host values are
  untouched). The stored-config scan for provider overrides that 0.165 will not load needs
  production database access; CDX-2 only blocks new input and rendering.
- The live-session proof of the Grok hook move (hooks in the private `managed_config.toml`) is pending;
  it was proven with `inspect --json` against 1.0.50 and 1.0.70 only.
- A Grok 1.0.70 sandbox profile that denies writes refuses a linked `bundled/` cache; the runtime copies
  it in that case (handled, but costs disk).
- Hosts reporting no (or an old) `claude_client_version` lose gated Claude models from the signed menu
  and cannot save an override for them until `clx update` or `clx cron run` reports a version.
