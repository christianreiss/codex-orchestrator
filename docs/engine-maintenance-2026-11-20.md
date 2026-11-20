# Engine maintenance — 2026-11-20

Full four-engine maintenance run (Codex, Claude Code, Grok Build, Kimi Code),
commissioned by the operator. Coordinator: native child of the coordinating
session (shared fleet identity). Operator delivery change: integrate into this
run's own integration branch only. No merge into `main`, no push and no deploy;
the coordinating session merges and pushes, and deployment is a separate
instruction. Research and implementation used separate native subagents; every
fix ran in its own branch and git worktree.

## Baseline

- Integration worktree:
  `/home/chris/Documents/Projects/AI/codex-orchestrator/.claude/worktrees/agent-ad23cb6d4904bf074`,
  branch `worktree-agent-ad23cb6d4904bf074`, base `main` at
  `ba35fff02bbbdd338099ff2534dd9798a04952aa` (clean), remote
  `ssh://git@git.alpha-labs.net:2222/eulotorium/codex-orchestrator.git`.
- Git Director: `git_list` worked. `git_register` for the integration worktree
  was refused with `git_director_owner_required` (mismatched `worktree_path`;
  the shared native session is bound to the main checkout).
  `agent_context_update` would have moved the coordinator's shared binding, so it
  was not called. Delivery is a branch handed to the coordinator, not a merge on
  a shared branch, so no lease was requested.
- Engines in the repository (`api/src/util/engine.ts`): codex, claude, grok, kimi.
- Managed native installs on biest: Codex 0.171.0 (plus a 0.170.0 directory) and
  Claude Code 2.1.329 (plus 2.1.328); no managed Grok or Kimi install. The
  unmanaged system binaries `/usr/local/bin/codex` 0.153.4,
  `/usr/local/bin/claude` 2.1.220 and `~/.npm-global/bin/claude` 2.1.263 are not
  launch targets.
- Runner pins at base: Codex 0.169.0, Claude Code 2.1.326, Grok 1.0.88, Kimi 2.6.2.
- Hosts with `latest` resolve to Codex 0.171.0, Claude Code 2.1.329 (npm
  latest=next; conservative `stable` tag 2.1.311), Grok 1.0.89 (npm latest and
  `x.ai/cli/stable`) and Kimi 2.7.2 (`code.kimi.com/kimi-code/latest`).

Baseline checks at `ba35fff0`, before any change:

| Check | Result |
| --- | --- |
| API units `npx vitest run --maxWorkers=4` (`TEST_USE_DB` unset) | 585 files passed, 2 failed, 144 skipped; 8,794 tests passed, 2 failed, 1,331 skipped. Both failures: `docs/API.md` lacks `POST /rescue/v1/session` (`api-doc-route-coverage`, `docs-api-coverage`). Pre-existing and not engine-related |
| Frontend `npm run check` | svelte-check 0 errors, 1 existing warning (`CommunicatorApiSection` a11y); 1,102 tests passed; slop-grep clean |
| Go `go build ./...`, `go vet ./...` | passed |
| Go `go test ./...` (XDG_RUNTIME_DIR 0700) | 6,107 passed, 0 failed, 22 skipped |
| Runner `pytest -q` / `ruff check .` | 267 passed, 2 skipped / clean (the 11-17 E702 errors no longer reproduce) |

Disposable MySQL for this run: rootless Podman `cxo-test-mysql-engine`, ID
`64cc0a4e3550a33f21d9e785d92a32791db7f9a69fa51d465655c6334d40c8ce`, image
`docker.io/library/mysql:8.4` digest
`sha256:a81d043930e51745522bd5c430961cf8286f0a23f0a9a2a6e0108f7ea71b0902`,
`127.0.0.1:33062`, database `codex_test`, data on tmpfs. Schema from
`npm run test:db:setup` (357 statements) plus `npm run migrate` (132 migrations).

## Assignment

| Engine | Research subagent | Implementation subagents |
| --- | --- | --- |
| Codex | research_codex (read-only) | CDX-SCHEMA-171; NATIVE-ARGS (shared); RUNNER-PINS (shared) |
| Claude Code | research_claude (read-only) | CLX-MCPHOOK-ONFAILURE; CLX-AUTHSOURCE; NATIVE-ARGS (shared); RUNNER-PINS (shared) |
| Grok Build | research_grok (read-only) | CGX-SETTINGS-189; NATIVE-ARGS (shared); RUNNER-PINS (shared) |
| Kimi Code | research_kimi (read-only) | CKX-CONFIG-272; NATIVE-ARGS (shared); RUNNER-PINS (shared) |

NATIVE-ARGS and RUNNER-PINS are cross-engine findings with a single root cause
each. Each went to exactly one implementation subagent, with acceptance criteria
for every affected engine and one commit per engine where the files allowed it.
No tier change was proposed, so no tier subagent was needed.

## Issue ledger

| ID | Engine | Finding → expected behaviour | Branch / fix commits | Status |
| --- | --- | --- | --- | --- |
| CDX-SCHEMA-171 | Codex | Repo schema was the 0.169.0 copy; valid 0.170/0.171 settings were rejected and ungated, and `rollout_budget` required `limit_tokens`. Fix: adopt the official 0.171.0 schema, gate 0.170/0.171 paths per host and apply the upstream `limit_tokens`/`limit_budget` either-or rule. No removals, so no migration | `eng-cdx-schema-171` `4df2cc72e` | Integrated `d5ad6f349` (conflict in `native-config-support.ts` resolved) |
| CLX-MCPHOOK-ONFAILURE | Claude | 2.1.328 added `onFailure` on `mcp_tool` hooks; the strict schema rejected it. Fix: accept `continue`/`block` behind a 2.1.328 host gate, because older CLIs fail open | `eng-clx-mcphook-onfailure` `152de466f` | Integrated `f670c9a36` |
| CLX-AUTHSOURCE | Claude | Profile and federation selectors outrank the subscription login and were not neutralised under the managed launch. Fix: strip inherited copies and blank them in the overlay | `eng-clx-authsource` `cfe6c8a04` | Integrated `cba18e731` |
| CGX-SETTINGS-189 | Grok | Four 1.0.89 booleans were rejected as unknown. Fix: register them behind a 1.0.89 gate. Follow-up from the final test run: parity exemption | `eng-cgx-settings-189` `37c2215c5`, `2011eac36` | Integrated `e0da30083`, follow-up `3cb5d9158` |
| CKX-CONFIG-272 | Kimi | Baseline was still 2.6.2: no gate for the 2.7.0 Bedrock provider type, `[hosts]` refused only generically, and the consumer fixture and docs were stale. Fix: 2.7.0 gate, explicit refusal, 2.7.2 fixture with an `LlmModelSpec` adapter, dated docs | `eng-ckx-config-272` `cb3e83d20` | Integrated `547d359fc` |
| NATIVE-ARGS/CDX | Codex | `exec-server [forward] --tcp-upstream-proxy` was missing (the 0.171 oracle failed), plus a stale "TUI-only `--remote`" description. Fix: table entry, 0.171 snapshot covering 74 scopes, `exec --remote` refusal tests, docs | `eng-native-args` `def384df3` | Integrated `766e94fea` |
| NATIVE-ARGS/CKX | Kimi | 2.7.2 hidden `server` options and children, `web --json` and `install-app` were missing (the oracle failed). Fix: tables and a 2.7.2 snapshot | `eng-native-args` `5aff28dcf` | Integrated `766e94fea` |
| NATIVE-ARGS/CLX | Claude | Six hidden required-value root options were missing, so values could be read as subcommands. Fix: table entries and tests | `eng-native-args` `febb675a9` | Integrated `766e94fea` |
| NATIVE-ARGS/CGX | Grok | 1.0.91+ `-p [PROMPT]` is optional, and `--system-prompt-file` was missing. Fix: optional-value superset and the new option; the variadic prompt is deferred. Follow-up from the final test run: agentportal expectations and parity exemption | `eng-native-args` `7cf5b6bad`, `ad8700f4f` | Integrated `766e94fea`, follow-up `690305641` |
| RUNNER-PINS | All | Runner pinned 0.169.0 / 2.1.326 / 1.0.88 / 2.6.2. Fix: 0.171.0 / 2.1.329 / 1.0.89 / 2.7.2 with verified digests | `eng-runner-pins` `6e172b7e9` | Integrated `ffb596090` |
| CDX-ELASTIC-171 | Codex | Review finding from the integration. With `<side>_elastic_budgeting = true`, native 0.170/0.171 refuses Guardian elastic budgets that the central validator accepted, so they would fail at native load on every host. Fix: enforce the native rules at save and render (details below) | `eng-cdx-elastic-171` `aed80bca6` (based on `d9ff46495`) | Integrated `fbd1b732e` |

Shared files touched by several branches were resolved during integration:
`native-config-support.ts`, the interface documents and `docs/NATIVE_CONFIG_SCOPES.md`.
One agent (CDX-SCHEMA-171) owned the four-engine version stamps
(`NATIVE_CONFIG_SCOPES.md` coverage sentence, `NativeSettingsEditor.svelte`
references, e2e labels). The coordinator alone edited CHANGELOG, `wrappers/Makefile`
(cxx 0.9.189 → 0.9.190) and `public/admin`.

## Per-engine results

### Codex

Sources (fetched 2026-11-20):
- [rust-v0.171.0](https://github.com/openai/codex/releases/tag/rust-v0.171.0): commit
  `ccf9be8cc458bd6b8336fe84d68d8893f2691a5e`, published 2026-11-20. It is npm `latest`;
  npm `alpha` is 0.173.0-alpha.1.
- rust-v0.170.0: commit `29eb79e9866b3262a777fdf8195c1b9e63684c91`.
- `codex-rs/core/config.schema.json` SHA-256 per tag:
  - 0.169: `f515f420…c9c86`
  - 0.170: `424ede5c2e3d9183a92d0a1c361139bf3664b2ee95d03d730063463fe865dec5`
  - 0.171: `025625b51c9c7f51f87d89c5b5ec8a47acb6e4fe90737b95880fc1b3f9e52fdd`
- `models-manager/models.json` at 0.170/0.171: `d50b6749506d97e5f334dbabcb666eb1689f423cf3e88cfabdcf3c536b873068`.
- Managed binary 0.171.0: `b76a027d6b210f9a8da7aaf321dd235c700f0ef7a794d4a5314b9af6c134f0f0`.
- Runner musl assets 0.171.0, hashed from real downloads:
  - amd64 `01baa2e47809f8597be5b2f8abd4e4dfe3fb5bcb6e504c2fbaaad97056c15e8d`
  - arm64 `bcf50b836385e51bd2976ab2bbe92b1b08a1cbe37712eb8dbe378aa78d24871c`

Configuration: 0.169 → 0.171 only adds settings. `codex features list` (0.171)
matches the retired-feature set.
- 0.170 gate: `features.multi_environment_mcp`, `otel.headers_helper*` and sync
  Guardian `nested_tool_names`.
- 0.171 gate: everything else new, including `async_elastic_*`, which first
  appears in 0.171 and not 0.170 as the research report assumed.
- The editor reference URL moved to `learn.chatgpt.com/docs/config-file/config-reference`.

Models/effort: no change. The registry matches the bundled catalog and the account
cache, and the operator's Astra `low` default stays. `gpt-6.1-luna` is still absent
from every public and account source and stays live-catalog-gated. Bundled 6.2
`minimal_client_version` 0.166.0 is not an official floor and was not adopted.
API deprecations are not subscription retirements. **Tiering unchanged.**

Features:
- `codex exec --remote` is refused, and tests now cover it.
- In-TUI `/rc` and `/remote` configure an unmanaged local daemon that no argv
  guard can catch. This is a documented gap and deliberately out of product.
- `tui_workspace` turning on by default is native-owned.
- Statusline providers are authorable only, not enabled.

### Claude Code

Sources (fetched 2026-11-20):
- npm `@anthropic-ai/claude-code`: latest=next=2.1.329, published 2026-11-19;
  `stable` is 2.1.311.
- Managed binary 2.1.329: `30e2724e2aecb1bf5dc9f3130901afb71c5fa229051c190a6d7ad9aff6378d6d`.
- [CHANGELOG](https://github.com/anthropics/claude-code/blob/f9e4d1e5753ccffcffdd832f047d72be000396a6/CHANGELOG.md):
  commit `f9e4d1e5…`, SHA-256 `8e859505bf28af107f36a4193ecd3e3312707e5be68b3a2626c9f8315684483f`.
- code.claude.com settings-reference `9799f120…29f4` and hooks `d55a7aff…9727`.
- authentication `60939182…f1`, models overview `d5d0ec8a…a8e` and deprecations `83b08416…a2e8`.

Configuration: all 249 settings-reference keys are covered, including the
managed-only and global-config lists, the 33 hook events and the deprecated set.
The one gap was `mcp_tool` `onFailure`. Code Mode stays env-only, through the
generic `env` map.

Models/effort: no change. Native defaults, efforts (persistent low–xhigh, `max`
session-only) and advisor ranks 1–10 match the 2.1.329 catalog. Sonnet 4.5
(retires 2026-11-30) already upgrades to Sonnet 5.5. Opus 4.8 fast mode is
already refused. Mythos stays limited availability and is not offered.
**Tiering unchanged.**

Auth lifecycle (CLX-AUTHSOURCE):
- The native oracle against 2.1.329 used fabricated credentials only. It passed
  8/8 with the fix and failed 8/8 with the fix removed.
- Known gap: a *default* `oidc_federation` profile file under `~/.config/anthropic`
  still beats the login. Redirecting `ANTHROPIC_CONFIG_DIR` would also move the
  Console `/login` profile store and the `ant`/SDK configuration of session
  subprocesses, so it was not implemented.
- The blanked selectors reach Bash/hook subprocesses as empty values, as
  `ANTHROPIC_IDENTITY_TOKEN*` already do.

Existing, undocumented situation, unchanged here: the flag forms `--remote`,
`--teleport`, `--cloud`, `--remote-control` and `--environment` are not refused
(only their subcommand forms are). They have existed since at least 2.1.312, and
their managed auth/session lifecycle is unverified.

### Grok Build

Sources (fetched 2026-11-20):
- npm `@xai-official/grok`: latest 1.0.89 (2026-11-17) and alpha 1.0.92;
  `x.ai/cli/stable` 1.0.89.
- Decoded 1.0.89 binary: `a3dface51d9bdc71fd121e0481dd02d9b46a721f7a6b892f756480e9666eba1f`,
  build `28be5bb1bf65`. The coordinator re-verified it through `runner/install-grok.mjs`.
- Bundled reference 1.0.89: `18eb6e45fd09f381052a257415cc45244d18a0ba2540791221cf8af50733b23e`
  (1.0.92: `ff38e8d0…4387`).
- Public settings docs lag the artifact, and the changelog URL returns 404.

Configuration: four new 1.0.89 booleans were added. Deferred until promotion:
- 1.0.90–1.0.92 alpha fields (`auto_mode.*`, `supports_reasoning_text_replay`,
  `shared_daemon_keep_alive`, `wrap_image_relay`, `headless_retry_deadline_secs`).
- The 1.0.90 removal of `dashboard.grouping` and `features.workspace_dashboard`.

The help tree is unchanged 1.0.88 → 1.0.89 across 84 command paths.

Models/effort: no change. The offline `grok models` output is only the built-in
fallback, and no authenticated catalog was used. **Tiering unchanged.**

Features:
- No new auth, worker or remote mode.
- `agent`, `worker`, `leader` and `--leader-socket` stay refused.
- The 1.0.91+ variadic `[PROMPT]...` and command-word semantics are deferred.

### Kimi Code

Sources (fetched 2026-11-20):
- GitHub releases:
  - 2.6.3: `b0de2fbd…`
  - 2.7.0: `a5e355e2…`
  - 2.7.1: `6c765078…`
  - 2.7.2: `56145f849caa305d42acd09b67fb65d11146f887`, 2026-11-20
- CDN manifest 2.7.2: `a685369a0d4ce1f57c4fc7d4392d9bc6780a7f132cd41ddc24cd7cd8ef14aa76`;
  linux-x64 binary `7f82148d26467874400d19ee8d23ead13cece9cd0c17648a5622cae480a5a596`.
- `/latest` returns 2.7.2.
- Official [model table](https://www.kimi.com/code/docs/en/kimi-code/models.html):
  the HTML the coordinator fetched has SHA-256
  `27f54e145638c494de2f82f92085bc9c38a129cc1086ba7ad4f4cc2761126075`. The page
  changes between fetches.

Configuration: 2.6.2 → 2.7.2 adds only the `[hosts]` section, which now has an
explicit refusal, and the Bedrock provider type, which now has a 2.7.0 gate.
2.7 falls back to defaults on invalid config, so central validation stays the
gate. The 2.5.3 floor (`KIMI_MIN_CLIENT_VERSION`, also sent as `X-Msh-Version`)
and `PinnedVersion` deliberately stay.

Models/effort: the same six IDs, the same effort lists and capabilities, and
nothing retired. **Tiering unchanged.** Open operator decision, verified by the
coordinator in the table and in its effort-mapping section:
- The provider default effort is `high` for K3.1 Pro, K3.1 Pro Highspeed, K3 and
  K3 256K, and `max` for `kimi-for-coding` (K2.8 Preview).
- The registry, which is rendered as native `default_effort`, has the inverse
  (`max` and `high`). `docs/interface-ckx.md` records these as retained fleet
  defaults.
- The table lists up to 1,048,576 context for `kimi-for-coding`; the fleet caps
  it at 262,144.

No change was made without an account catalog or operator ruling.

Stop hook: dated probe recorded in `interface-ckx.md`. 2.6.2 `-p` never invoked
Stop. 2.7.2 `-p` invokes it but exits before the continuation turn. The
interactive TUI was not probed.

## Verification of the integrated state

| Check | Result |
| --- | --- |
| API units, full (`--maxWorkers=4`, `TEST_USE_DB` unset) | 587 files passed, 3 failed, 144 skipped; 8,891 passed, 3 failed, 1,332 skipped. 2 = baseline `POST /rescue/v1/session` docs coverage. 1 task-caused: `engine-parity` (two new Grok-only tests lacked parity exemptions) → follow-ups below |
| API typecheck `tsc --noEmit` | passed |
| Grok native-binary API tests (`GROK_NATIVE_TEST_BIN` = verified 1.0.89) | 4 files, 155 passed, 0 skipped |
| Focused MySQL tier (`admin-settings`, `admin-engines`, `engines`, settings migrations, config recovery, grok context) on `cxo-test-mysql-engine` | 30 files, 136 tests passed |
| Frontend `npm run check` / `npm run build` | 0 errors, 1 existing warning, 1,102 tests, slop clean / passed |
| Playwright `admin-native-settings.spec.ts` on the built SPA | 25/25 (one worker, no retries) |
| Go build / vet | passed |
| Go full suite with `NATIVE_CODEX_ORACLE` (0.171.0) and `NATIVE_CLAUDE_ORACLE` (2.1.329) | 6,150 passed, 4 failed, 18 skipped. The 4 failures are task-caused: `agentportal` tests pinning the old required Grok `-p`. Codex 0.171 oracles, Claude background-service and root-value oracles and the profile-selector oracle passed |
| Runner (branch) | pytest 267 passed / 2 skipped, ruff clean; real amd64 `podman build` with Dockerfile version assertions; in-image probes `codex-cli 0.171.0`, `2.1.329 (Claude Code)`, `grok 1.0.89 (28be5bb1bf65)`, `2.7.2` (non-root, network none, read-only) |

Follow-ups from the final run (each in the responsible issue worktree):
- CGX-SETTINGS-189 `2011eac36`: parity exemption for `grok-189-settings.test.ts`.
  Parity 0 untriaged/0 stale; engine-parity 7 passed.
- NATIVE-ARGS/CGX `ad8700f4f`: agentportal expectations (opaque data via `-p=`,
  positive cases for a flag after bare `-p`) plus a parity exemption for
  `maintenance_20261120_grok_test.go`. Branch: full `go test ./...` 78 packages
  ok, 0 failures. The merge also updated the exemption count prose (253).

Final re-run after both follow-ups (HEAD `690305641` plus docs):

| Check | Result |
| --- | --- |
| API units, full | 588 files passed, 2 failed, 144 skipped; 8,892 passed, 2 failed, 1,332 skipped. The failure set is identical to the baseline (`POST /rescue/v1/session` docs coverage) |
| `scripts/check-engine-parity.py` | 253 residual files, 253 exemptions, 0 untriaged, 0 stale |
| Go full suite with `NATIVE_CODEX_ORACLE` (0.171.0), `NATIVE_CLAUDE_ORACLE` (2.1.329), `NATIVE_GROK_ORACLE` (verified 1.0.89) | 6,156 passed, 0 failed, 16 skipped. Codex, Claude, Grok help oracles and the Claude profile-selector oracle passed. The Kimi 2.7.2 oracle was skipped (no binary on the integrated run; it passed on the NATIVE-ARGS branch against the digest-verified 2.7.2 binary) |
| Runner `pytest -q` / `ruff check .` | 267 passed, 2 skipped / clean |

Remaining CI workflow steps (`.github/workflows/{api,wrappers,frontend,runner}.yml`),
run on `d9ff46495`:

| Check | Result |
| --- | --- |
| api `npm run lint` / `npm run build` | 0 errors (237 warnings) / passed |
| api `test/unit/contract` + `test/unit/routes` after the docs commits | 64 files passed, 2 failed; both are the baseline `docs/API.md` rescue-route coverage failures |
| `gofmt -l` | changed Go files clean. Repo-wide, it flags only `internal/app/kimi/doctor.go` (import order), which this branch does not touch: pre-existing |
| `staticcheck` 2025.1.1 | 2 findings, both in files this branch does not touch: ST1013 `agentbus/receiver_restart_test.go:189`, U1000 `codex/installer.go:624` (`installBinary` unused). Pre-existing |
| `go vet -tags cxx_otel ./...` | passed |
| `go test -race` / `go test -tags cxx_otel` (the five changed packages) | all ok |
| `make test-terminal` | 595 terminal cases passed |
| Cross builds `linux/{amd64,arm64}`, `darwin/{amd64,arm64}`, `freebsd/amd64` (`CGO_ENABLED=0`) | all built |
| frontend `npm run build` again after the CHANGELOG/VERSION commit | no drift in `public/admin` |
| Commit hygiene `ba35fff0..HEAD` | every commit has exactly one `AI-Assisted-By: Claude` trailer, no co-author or "generated with" lines |

CDX-ELASTIC-171 was found while reviewing the integration (prompt §3: review
findings get their own subagent). It ran in its own worktree from `d9ff46495`.
- RED first:
  - Throwaway-home `features list` probes of the real 0.170.0 and 0.171.0
    binaries: 29 cases for sync and async on 0.171, and sync on 0.170.
  - Upstream source at rust-v0.171.0: `resolve_elastic_budget` and
    `guardian-context/src/budget.rs`.
- The native rules go beyond the three the earlier implementer reported. They
  apply only while `<side>_elastic_budgeting = true`, regardless of Guardian's own
  `enabled`.
  - The section map must be nonempty, with only the 14 sections or 8 aliases,
    each once.
  - Minimum and entry cap must be nonzero; the entry cap must be at most the
    minimum and at most 9000; an optional maximum must be at least the minimum.
  - `nested_tool_names` is allowed only on the sync-only
    `transcript_selected_exec_results`, where it must be nonempty and nonblank.
  - Minimums, counting native defaults for omitted sections, must sum to exactly
    128000.
  - Sync rules are identical in 0.170 and 0.171.
- The integrated tree was checked as follows:
  - `codex-native-171.test.ts` with `CODEX_NATIVE_TEST_BIN` = 0.171.0: 138/138,
    including the 34-case native oracle.
  - `tsc` clean.
  - Parity 253/253, 0 untriaged, 0 stale.
  - Full API units on merge `fbd1b732e`: 588 files passed, 2 failed, 144 skipped;
    8,964 passed, 2 failed, 1,333 skipped. The failures are the same as the
    baseline.

Research coverage check (prompt §3, read-only diff review by each research
subagent):
- Codex: all three findings covered, and the `async_elastic_*` 0.171 correction
  was confirmed.
- Claude: CLX-1, CLX-3 and CLX-4 covered; CLX-2 partially covered with the
  documented profile-file gap.
- Grok: all three findings covered.
- Kimi: all findings covered. One small table gap remains: the hidden `--socket`
  and `--managed-by` options of the refused `web`/`server`/`rc` commands are in no
  table. Those commands are refused by name before options are read, so this is
  a stale table only, not an exposure.

## Limits and open points

- Not run:
  - authenticated inference or account catalogs (all engines)
  - interactive Kimi TUI Stop-hook behaviour
  - arm64 execution (digests only)
  - the full MySQL integration tier (focused settings tier only)
  - the full browser suite and cross-browser runs
  - Slop/Advisor review
  - the Kimi 2.7.2 grammar oracle on the integrated tree (it passed on the
    NATIVE-ARGS branch; the integration added no Kimi grammar change)
  - full-module `go test -race ./...` and `make test-traced` (only the changed
    packages were run)
  - `govulncheck`
  - the MySQL `npm run test:coverage` tier in full
- Codex elastic budgets (CDX-ELASTIC-171, fixed in this run). Before deploying,
  check the stored Codex document (root and profiles) for
  `sync_elastic_budgeting = true`:
  - Sync budgets have been authorable since 0.168. Saved documents are not
    healed: a stored budget that breaks the rules stays editable, carries a
    `validation_error` and now makes rendering throw. That blocks the Codex config
    for every host until someone corrects it. The same pattern was used for the
    gateway fix on 2026-11-17.
  - Such a budget would already fail native load anyway.
  - Each profile sidecar is checked on its own. A profile that relies on the
    root's sections would be rejected even though the merged native config might
    load. This was inferred from the renderer and not probed.
- Codex: the `codex-native-keymap.ts` header still cites the 0.166 source; the
  0.171 keymap only adds actions, which the schema covers.
- Claude: the default profile-file gap and the unrefused cloud/remote flag
  forms (see above).
- Kimi: the default effort and context decision (see above), now also recorded
  in `interface-ckx.md`.
- Kimi: the option to raise the effective receiver floor to 2.6.3 (2.6.2 `-p`
  never runs the Stop hook) is a parent/operator decision. The 2.5.3 constants stay.
- Kimi: the hidden `--socket` and `--managed-by` options are not tabled (see the
  coverage check).
- Runner: no real-account smoke test was run for the new pins; Kimi 2.7.2 was
  compared only against a mock provider. The runner subagent removed its own
  test image and the `python:3.12-slim` base it reports having pulled for that build.
- Migrations: none were needed. The reserved numbers 0140–0143 are unused.
- Fleet feedback: `f1082111-8761-44e7-9bdd-88bdea1c55f5`. A native child cannot
  `git_register` its own linked worktree without moving the parent's shared binding.

## Delivery and cleanup

- All thirteen fix commits were merged into the integration branch with `--no-ff`
  merges, not cherry-picked, so every fix SHA is reachable from it. Coordinator
  commits:
  - CHANGELOG and wrapper `VERSION` 0.9.189 → 0.9.190
  - the rebuilt `public/admin`
  - this report with the Kimi open-decision note
  - a final commit with the CDX-ELASTIC-171 CHANGELOG sentence and these report
    updates
- `public/admin` needs no rebuild for CDX-ELASTIC-171, which changed no frontend code.
- Not merged into `main`, not pushed, not deployed, as instructed. A runner image
  rebuild, the cxx 0.9.190 publication and an API deployment are part of a
  separately commissioned rollout.
- The eight implementation worktrees and their branches (`eng-*`, plus the unused
  harness `worktree-agent-*` branches) were clean and fully integrated. They were
  removed with `git worktree remove` and `git branch -d`.
- The disposable MySQL container `cxo-test-mysql-engine` and the scratch Grok
  binary were removed. Research subagents worked read-only, without worktrees.

## Overlap with the clean-up stream (not changed here)

- `FORCE_UPGRADE_REASONING_EFFORT` (`codex-model-upgrades.ts`) is only used by tests.
- The `needsCodex163…171` ladder and the long `minimum` ternary in
  `native-config-support.ts` would fit a `{version, predicate}` table.
- `model-registry/data.ts` header comments still cite 0.164/0.165 evidence.
- `docs/interface-cdx.md` repeats the 0.169 scope text in two places.
- Claude argv grammar lives in `claude/runtime_auth.go`, separate from
  `internal/nativeargs`. A third copy of `--settings`/`--setting-sources`
  scanning sits in `memoryrouting/paths.go` and `persona/claude/lifecycle/memory_routing.go`.
- `claudeGlobalOptionsWithValue` keeps `--cwd`/`--config` deliberately for
  `agents`/`gateway`; the comment should say so.
- `grokChildren["mcp"]` still lists `get`. `grokCommands` carries legacy words
  (`cursor-worker`, `install`, `upgrade`), possibly needed for the 1.0.50 floor.
- `GROK_CONTEXT_WINDOWS` and `KIMI_CONTEXT_WINDOWS` carry stale
  "1.0.46, 2026-10-03" provenance comments. `KIMI_MODEL_CONTEXT_TOKENS` has no consumer.
- Kimi wrapper `Stop`/`UserPromptSubmit` comments still cite 2.5.3.
- Pre-existing CI lint, untouched by this run: `codex/installer.go` `installBinary`
  is dead (staticcheck U1000), and `internal/app/kimi/doctor.go` is not gofmt-clean.
