# Engine maintenance — 2026-11-01

Run `betty-961eff1d` follows [the complete maintenance contract](prompts/engine-maintenance.md).
All confirmed maintenance findings and final integrated checks are closed; delivery details follow below.
The operator explicitly accepted the Tier 5 task / Tier 3 Sol mismatch before task execution.
Deployment, production migrations and service restarts are outside this run.

## Starting point and isolation

- Host: `biest.eulie.de`; original checkout `/home/chris/Documents/Projects/AI/codex-orchestrator`.
- Target `main`, upstream `origin/main`, clean initial HEAD `a7580e8de50b4a5794a8abe0332b8289e2130582`.
- Remote `origin`: `ssh://git@git.alpha-labs.net:2222/eulotorium/codex-orchestrator.git`; fetched with pruning.
- Integration branch/worktree: `engine-maintenance-961eff1d` in the adjacent directory of that name.
- Existing quota-emulation and Grok-refresh work belongs to Gloria and Augusta in separate worktrees.
  Their changes are neither copied nor overwritten; target advancement is reconciled before delivery.
- Supported engines re-read from `api/src/util/engine.ts`: Codex, Claude Code, Grok Build.
- Evidence scratch: `/var/tmp/em-961eff1d`; no production authentication or data is a test target.

## Research and implementation ownership

Read-only research is delegated to separate native agents `research_codex`,
`research_claude` and `research_grok`. Confirmed problems receive separate
implementation agents and isolated issue branches/worktrees. The parent reviews
and integrates; shared grammar and runner changes have one owner each.

| ID | Engines | Confirmed finding | Owner / branch-worktree | Fix / integration / focused checks |
| --- | --- | --- | --- | --- |
| EM-CDX-001 | Codex | 0.166 schema and provider/MITM semantics exceed 0.165 registry | `fix_cdx001` / `em-cdx001-961eff1d` | `6cf07fc3e5fd3aa9ecdc82a84fa3e6088e5cc460` integrated; 442 API tests, native reject probes, built editor 18/18. Followfix `2d593ee838b20d4d09581d029120d939ad6c869a` integrated; 499 tests including 55 real native grammar probes. Independent closing review approved after 148 tests and root/profile store roundtrips. |
| EM-CDX-002 | Codex | Removed description-first flag and ignored Guardian mode remain accepted | `fix_cdx002` / `em-cdx002-961eff1d` | `d1638ae98ab5d322c301e4a7c65efc1f5a3f0849` integrated; 406 tests, native parser and repeat MySQL migration. Checkpoint `61a9bb532dc33150336d215aed36dd353b7a24e8` and serialized dependency merge preserved; contract follow-up `2ecaabead76340e4d6f6fce46a1e65e0778fb5a5` aligns the exhaustive config-builder list (154 focused tests). |
| EM-CLX-001 | Claude | New write-boundary boolean rejected | `fix_clx001` / `em-clx001-961eff1d` | `47416377c745bc2e1091b21106bdc79ac4f1670e` integrated; 158 API tests and native doctor type probes; independent review 180 tests. |
| EM-CLX-002 | Claude | Deprecated Opus 4.8 fast-mode combination remains authorable | `fix_clx002` / `em-clx002-961eff1d` | `4c0a341db842a79ccb79b23db7e9930032284828` integrated; 262 units+2 MySQL tests. Followfixes `4c6afc8f3c0e5e4d32c25930b1f38eaebbea079b` and `11a231580cf397c347779960b667029fb75a75e2` integrated; authored env/legacy/family/hybrid selection covered by a 43-case API/MySQL matrix. Independent closing review approved. |
| EM-CGX-001 | Grok | Wrapper promotes native-filtered process overlay to active disk settings | `fix_cgx001` / `em-cgx001-961eff1d` | `c597690dcfad78a1a6698544df339ea766c20e95` integrated; actual native inspect differentials, build/vet/tests. Followfix `ba860d864bfa1ffe43ca0614cb919e4aeda00595` integrated in `9f7f0df1f2051a8b8f3273c9df8ff46b673ad824`; model/effort snapshot preserves startup and policy selection. Independent research review approved with 139 API tests plus real inspect/help oracles and four Go package suites. Doc-consumer follow-up `f3ccbf6bcccdc59769243242d82e03ab94431116` pins both real environment reads (3 tests). |
| EM-CGX-003 | Grok | Authoring accepts numeric values native silently clamps | `fix_cgx003` / `em-cgx003-961eff1d` | `7bf476839c269d2f9210a37b7b5b8e8d5683e928` integrated; 272 API tests, typecheck/lint. |
| EM-CLI-001 | All three | Command/value grammar and independent daemon lifecycle gaps | `fix_cli001` / `em-cli001-961eff1d` | `3d4189677945c40d54dbacdd172e56827400dfa5` integrated; version follow-up `933f442dec9add53dec471ecb4a46233fec3f0f3` advances maintenance to 0.9.151 after the already-landed quota release; five Go package suites, build/vet, actual help-only oracles; 84 Grok pages / 371 value declarations. |
| EM-RUNNER-001 | Codex, Claude | Runner pins lag stable managed clients | `fix_runner001` / `em-runner001-961eff1d` | `f30a05a9aa70f973d08dd93e2150ab0da25f639b` integrated; 215 runner tests, Ruff, checksums/integrity, full image build/health. |
| EM-VERIFY-001 | Codex, Claude | Semantic diagnostic fixtures inherit width and fail on legitimate wrapping | `fix_verify001` / `em-verify001-961eff1d` | `abb7d09126955e70445be54a87a0000e60fa860f` integrated; exact assertions unchanged, each fixture 100 repetitions, all three app suites. |
| EM-VERIFY-002 | Shared wrapper | Five pre-existing field alignments fail canonical gofmt | `fix_verify002` / `em-verify002-961eff1d` | `24615797413c9bb0175e050afa7cf7073492d1f7` integrated; whitespace-insensitive diff empty, formatter/config tests/build/vet passed. |
| EM-VERIFY-003 | Browser fixture | Owner resnapshot can recover a failed read before manual Retry is clicked | `fix_verify003` / `em-verify003-961eff1d` | `7e820dccbe7fb729ad0ee6a00c5856bb527b392b` integrated; deterministic original race, 24 repeated recovery cases and 11 policy tests; runtime source unchanged. |

All issue worktrees are adjacent to the original checkout. Same-cause findings
from review stay with the responsible owner in that issue's isolated worktree;
they are not counted as additional issues. Shared normalizer edits are serialized
through committed dependencies. No implementation agent changes shared `main`.

## Issue evidence, acceptance and affected paths

- **EM-CDX-001:** official versioned schema plus provider/MITM/keymap consumers and actual native reject probes show gaps beyond JSON types. Acceptance is centrally editable root/profile values, strict native semantics, exact introduction gates, safe credential references, preserved spellings and successful native parsing. Paths: `api/src/services/codex-{config-schema.json,native-settings.ts,native-capabilities.ts,native-mitm.ts,native-keymap.ts}`, `native-config-support.ts`, API tests and the shared `NativeSettingsEditor.svelte` reference. The keymap parser source digest is `be7f6c274ef9cc5343ac584884c2807d262f3219873753f9e4c825494c85b8cd`; `ctrl+s` must fail before save, while aliases/chords/alternatives/`[]` survive roundtrips.
- **EM-CDX-002:** versioned features source marks description-first removed; the retained Guardian schema explicitly documents its ignored mode. Acceptance separates corrective new-authoring rejection from exact-path stored healing without mutating historical bodies/hashes, profile order or custom names. Paths: Codex native settings, `config-normalizer.ts`, migration `0121` and real-MySQL/unit tests.
- **EM-CLX-001:**2.1.314 release and native doctor accept the new boolean. Acceptance is true/false support, conditional 2.1.314 floor, preview/store/removal and literal segment ownership preserving local siblings/read restrictions. Paths: Claude settings catalog, native-version support, shared editor and API/browser tests.
- **EM-CLX-002:**2.1.316 release deprecates only the Opus 4.8 fast-mode combination. Official model-priority docs and the exact installed default-model parser establish authored-env and known alias precedence. Acceptance rejects new known combinations, disables historical/effective host combinations with explicit owned false, covers both hybrid phases and 1m suffixes, and preserves other/custom IDs and snapshots. Paths: `claude-fast-mode.ts`, `config-normalizer.ts`, `client-config.ts`, migration `0122` and shared 43-case API/MySQL fixtures. Dynamic account-dependent `best` and external process/session overrides remain outside this deterministic classification.
- **EM-CGX-001:** native 1.0.70 inspect differentials prove that process-overlay discovery/hook/trust/env-injection tables are filtered instead of authored disk configuration. Acceptance preserves native filtering and malformed fallback, managed auth/MCP ownership, CLI/signed/overlay/disk model-effort precedence, and one stable preference snapshot for actual startup/policy callers. Paths: Grok runtime/overlay, app startup, shared opt-in model-policy adapter and Go/native regressions.
- **EM-CGX-003:** the complete pinned native reference specifies the nine bounded values. Acceptance rejects out-of-range authoring at roots and version layers, including opaque custom-model names, with an exact field/range; historical invalid rows remain readable for explicit correction and retain body/hash. Paths: `grok-native-settings.ts` and existing admin recovery/range tests.
- **EM-CLI-001:** current Codex source calls the shared daemon helper for all four refused utilities; 84-page Grok help audit contains 371 value declarations. Acceptance preserves required/optional/variadic values and context aliases before auth/session interpretation, refuses incompatible real service calls before config/auth, and preserves help. Paths: `wrappers/cxx/internal/nativeargs`, Codex main, per-engine app tests and `wrappers/Makefile`. Claude grammar is independently checked and unchanged.
- **EM-RUNNER-001:** exact official package/release metadata differs from the prior pins. Acceptance is checksum/integrity-verified Codex 0.166 and Claude 2.1.316, unchanged Grok 1.0.70, successful full image/version health and runner tests. Paths: `runner/Dockerfile`, runner defaults/tests and runner interface documentation. Native arm64 execution and authenticated inference are not inferred from package verification.
- **EM-VERIFY-001:** a final full Go run failed when a random-length temp path legitimately wrapped `clx doctor`; inherited 20-column repro also fails the existing Codex fixture. Acceptance keeps every content/sanitization assertion unchanged under deliberate 240-column semantic fixtures; explicit 39-column and terminal matrix checks retain narrow coverage. Paths: only Codex/Claude `main_test.go`.
- **EM-VERIFY-002:** the original checkout has the same five spacing failures under canonical gofmt. Acceptance is zero formatter output and an empty whitespace-insensitive source diff. Path: only `wrappers/cxx/internal/config/config.go`; config tests/build/vet verify this necessary baseline repair without runtime changes.

- **EM-VERIFY-003:** trace and controlled owner invalidation show two 503 reads followed by a 200 recovery while the original retry click waits on a disappearing button. Acceptance preserves all manual retry/no-write/disabled assertions, observes its successful GET, and explicitly verifies independent owner-stream recovery. Path: only `frontend/e2e/admin-policies.spec.ts`.

## Baseline and disposable test environment

Commands are derived from `.github/workflows/{api,frontend,runner,wrappers}.yml`,
package scripts and `wrappers/Makefile`. Node 22.22.2, Go 1.26.10, Python 3.14.8;
runner CI uses Python 3.12. Locked npm dependencies and an isolated Python venv
are installed inside task-owned locations.

Disposable MySQL 8.4.10 UUID `d916a7ee-d61d-11f1-9882-90e2ba389b56`,
datadir `/var/tmp/em-961eff1d/mysql`, socket in the same scratch directory,
binds only `127.0.0.1:13491`, with database `maintenance_baseline_961eff1d`.
The canonical baseline applied 346 statements and the migration runner applied
117 migrations successfully. This instance contains no production data.

| Baseline check | Result |
| --- | --- |
| API typecheck | Passed |
| API lint | Passed, 233 existing warnings and no errors |
| Frontend check and units | Passed, 1016 tests |
| Runner ruff / pytest | Passed, 215 tests; two dependency deprecation warnings |
| API full suite / build | Passed: 7159 tests, 1156 expected skips; build passed |
| Go build / vet / suite | Passed |
| MySQL integration | Initial 2085 passed, 10 failed, 3 skipped; all 9 affected files pass on corrected environment (11 tests) |
| Built Chromium browser suite | Initial 402 passed / 1 failed; affected dialog file passes 3/3 on isolated rerun |

The disposable MySQL user initially had rights only on the named baseline
database. Nine integration files create independent temporary databases or
triggers; their permission failures were environmental. Granting the disposable
user instance-wide rights on this isolated instance made all eleven affected
cases pass, without a source change. The initial Git commit dialog browser
assertion failed under the broad concurrent baseline; all three dialog tests
pass unchanged on isolated rerun. Neither initial red run is counted as a pass.

Cross-browser baseline Firefox passed 109/109; WebKit initially could not load Ubuntu ICU74
and jpeg8 on this host. The task extracts those two packages into scratch from
Ubuntu 24.04 and preloads their exact libraries for child browser processes;
the unmodified WebKit binary then launches as version 26.5. No host package,
global loader configuration or browser binary is changed. Final browser results
below distinguish that environment workaround from product fixes. The remediated
WebKit suite passed 109/109. An initial retry encountered the previous test
server still owning 4173; it was rerun after that process exited.

## Sources, configuration, models, efforts and feature decisions

All sources below were retrieved on **2026-11-01**. The three researchers read
the complete audit contract, relevant implementation and prior audits, then
checked current official docs, release notes, native help and safe native probes.

| Engine | Current distribution / managed local launch | Other installation | Runner source before → after |
| --- | --- | --- | --- |
| Codex | 0.166.0 stable, `rust-v0.166.0`, release 2026-10-29; private `~/.cxx/engines/codex/0.166.0-3547502667/codex` | `/usr/local/bin/codex` and `/usr/local/sbin/codex` 0.153.4; PATH command is a managed shim | 0.165.0 → 0.166.0 |
| Claude Code | npm latest/next 2.1.316, normal release 2026-10-31; private `~/.cxx/engines/claude/2.1.316-925085957/node_modules/@anthropic-ai/claude-code/bin/claude.exe` | PATH global npm installation is separate; conservative npm stable is 2.1.309 | 2.1.312 → 2.1.316 |
| Grok Build | Official stable pointer/npm latest 1.0.70; private `~/.cxx/engines/grok/1.0.70-2165417554/grok`, build `f50904eaee6c` | PATH vendor download is 1.0.46, distinct from managed launch | 1.0.70 unchanged |

Native binary SHA256, in the same order: Codex
`b8a11fedf24b2dfb59a70c9e52b030f9a508dcd49cd2dd0d41956f4c785156b8`,
Claude `fd13c70000fec3f2116dfbcbb6121210b4a29328bf0e46210a59dd594a67d824`,
Grok `22d281c5964c5444147328096ba2a221f3f0874c6858e27c825656a80f6e58e9`.
These observations prove local installed targets; they do not establish current
server-stored version locks, every fleet host's installation or session adoption.
No matching admin credential was found in the live fleet secrets store, so
server-stored global/host version overrides were not enumerated.

### Codex

Official [release](https://github.com/openai/codex/releases/tag/rust-v0.166.0),
commit `6ff1e1ca3b30fc8b914720681fcf5fe62e95f856`, and exact
[schema](https://raw.githubusercontent.com/openai/codex/rust-v0.166.0/codex-rs/core/config.schema.json)
(SHA256 `211bec2282459fcd70e4905af948721177b6ec7a03e0df84cd8b7c131006a6ca`)
anchor 103 root options and 796 property definitions, including nested types,
defaults, enums and profile applicability. The researcher compared the complete
schema, versioned provider/features/MITM consumers and native help, rather than
only release-note highlights. Current
[configuration](https://learn.chatgpt.com/docs/config-file/config-reference),
[models](https://learn.chatgpt.com/docs/models) and changelog were rechecked.

Support work covers eight new feature switches (`critical_path_timing`,
`guardian_native_multi_agent_history`, `mcp_connection_sharing`,
`omit_skill_descriptions`, `plugin_discovery_prefetch`,
`simplified_selection_hints`, `skill_catalog_deltas`, `untrusted_as_tool_output`),
rollout-budget enforcement, memory consolidation service tier, transcript
selection binding, provider project/location/credential path fields and scoped
MITM signing/body substitution. Native semantic checks matter alongside schema
parsing: OpenAI catalog routing has an HTTPS host allowlist and ignores other
overrides; GCP requires an absolute credential path and restricts builtin
overrides; operation-only MITM actions require the proper version and selection
constraints. Referenced credentials remain host-local paths, never uploaded or
resolved by the editor. Exact conditional version gates cover root and profiles,
including explicit false, without interpreting opaque dotted map names.

The removed `code_mode_tool_description_first` feature and ignored
`guardianv2.async_classifier_mode` require separate authoring rejection and a
targeted historical-settings migration. The new `queue --resume` daemon path is
a separate lifecycle finding. Source review confirms queue, archive, unarchive
and delete all call the shared native daemon startup helper; all four now refuse
before config/auth until a persistent managed adapter exists, while native help
remains available. No native daemon or queued inference was launched for tests.
Optional features retain native defaults; this audit does not enable them.

Bundled model catalog SHA256
`1384625c0b6b3e67d3c60da29becea2b017f2c283fc1e2d05b8edafb4698eb10`
is unchanged from 0.165.0. A current local account catalog refreshed by the CLI
at 17:57 UTC corroborates all eight confirmed public subscription models and
their efforts. GPT-6.1 Luna remains absent and keeps its live-catalog gate;
hidden/reserved/preview models are not promoted. Astra's account default medium
differs from the bundled low and the operator's explicit fleet low decision;
the operator's chosen default is retained. Known subscription retirements and
successors are already migrated; unknown custom-provider IDs remain opaque.
**Tiering unverändert:** Astra 5, Sol 3, Terra 2, Luna 1.

### Claude Code

Official [2.1.316 release](https://github.com/anthropics/claude-code/releases/tag/v2.1.316),
[2.1.314 addition](https://github.com/anthropics/claude-code/releases/tag/v2.1.314),
[settings reference](https://code.claude.com/docs/en/settings-reference),
[model configuration](https://code.claude.com/docs/en/model-config) and
[model lifecycle](https://platform.claude.com/docs/en/about-claude/model-deprecations)
were rechecked. The full settings index has 247 paths and 186 root names;
its fetched Markdown SHA256 is
`44038f95f9386502a05b3b4e6178c6978c19b5700fb8fe734f88c7b02a849505`.
Every root absent from the user-default registry has an explicit separate
scope, retired status or reserved owner. The new write-boundary boolean is
release/native-proven although the live index has not added it yet.

EM-CLX-001 adds `permissions.blockWritesOutsideWorkingDirectories` to the
existing generic editor/validation/render/ownership path; true and false require
observed CLI 2.1.314. Unset remains unset. Native doctor parses both booleans
and diagnoses a string; its exit code alone would not establish validity.
Existing read restrictions and unrelated local siblings survive removal.
New 2.1.316 environment switches are already representable by the existing env
editor; no additional mode or effort is invented or enabled.

No public model addition, retirement migration or effort change is indicated.
Restricted Mythos access does not become general fleet availability. Persisted
effort and session-only max stay separate; modern per-model effort ownership
remains intact. **Tiering unverändert:** Fable 5, Opus 4, Sonnet 3, Haiku 1.
Fast mode on Opus 4.8 was deprecated on October 30 and is removed November 30;
the model itself and fast mode on other models remain active. Its precise
combination handling is tracked separately from the model catalog, including
managed model-selection environment precedence discovered in independent review.

### Grok Build

Official [stable pointer](https://x.ai/cli/stable),
[npm metadata](https://registry.npmjs.org/@xai-official/grok/latest),
[release notes](https://x.ai/changelog/build),
[settings](https://docs.x.ai/build/settings) and actual stable help were read.
The exact binary's bundled complete config reference SHA256
`ebd97fec98bb00bfdfa37befddf31dd8a14e3f277db887c7b643888867865db7`
matches the previous reference pin; the fresh complete inventory was compared
with all 445 registry field paths. Experiments and independent workers remain
explicitly unsupported lifecycle scopes, not unexplained omissions.

EM-CGX-001 keeps inline/JSON/TOML process overlays in Grok's native allowlisted
soft-settings layer. They no longer become disk settings that can activate
MCP discovery, hooks, auth routing or trust. Explicit wrapper-owned auth/MCP
projection and model/effort precedence remain separate. Native `inspect`
differentials verify discovery without executing any listed command.
EM-CGX-003 rejects settings outside proven native bounds rather than previewing
values Grok silently clamps. The shared CLI issue covers missing subcommand
value options and context-dependent aliases such as root/MCP `-s`.

The public [Grok 4.7 guide](https://docs.x.ai/developers/grok-4-7) and
[models](https://docs.x.ai/developers/models) give no evidence to deprecate the
four existing subscription IDs. API IDs do not establish CLI entitlement.
An anonymous subscription-catalog request returns 401; authenticated current
account coverage remains unverified. No unsupported successor is guessed.
**Tiering unverändert:** 4.7/4.7 Fast/4.6 tier 2; 4.5 tier 1, retaining the
operator's five-tier ruling.

### Relevant feature decisions

| Engine | Feature group | Decision and reason |
| --- | --- | --- |
| Codex | Transcript key binding, eight flags, memory/rollout metadata, GCP/catalog/MITM fields | Supported through existing JSON editor and exact native semantic/version validation; optional features keep native defaults. |
| Codex | Resume/fork permission retention and accounting fixes | Adopt upstream fixes through the audited runner pin; do not reinterpret native session state. |
| Codex | `doctor --network-only` and current root grammar | Native boolean/help passes through; wrapper `doctor` keeps its separate established command. |
| Codex | queue/archive/unarchive/delete, app/exec server, remote control, agents, NFS migration | Clear lifecycle/quiescence refusal until a persistent managed adapter exists; help remains usable. |
| Claude | Write boundary and new 2.1.316 environment controls | Boolean now supported; env controls already centrally editable and remain opt-in. Subagent effort env is not an additional effort level. |
| Claude | Background, daemon, gateway, remote control, self-hosted runner, attach/respawn/dispatch | Existing refusal remains justified by finite account/receiver/auth ownership. Enterprise gateway budgets/policy layering belong to gateway deployment, not CLI user defaults. Read-only `agents --json` remains supported. |
| Grok | Vim/hooks/diagnostics/status/context/compaction/vision/daily-memory options | Full current 1.0.70 inventory already centrally represented; bounds and native overlay semantics corrected by this run. |
| Grok | ACP stdio versus headless/serve/leader/worker services, setup/OAuth and experiments | ACP stdio stays supported. Independent workers and late machine rollout state need separate lifecycle/rollout contracts; setup/update and one-refresher auth retain their existing fleet owners. |

### End-to-end coverage and deliberate scope boundaries

The three researchers inspected Admin JSON editing → API rejection/preview/store
→ canonical revision checks → normalization/overrides/posture → native formats
→ wrapper ownership merge/removal → actual native parsing. Existing generic
editors expose the supported native values centrally. Adding backend fields
alone is not treated as product support. Central saves retain revisions even
for profile-only changes; literal dotted names retain segment-based ownership.
Real-MySQL and browser suites test central concurrent edits, correction, adding,
changing and withdrawing settings; native probes test representative actual
parsers. Universal concurrent external native-writer safety is not inferred.

Fleet user defaults deliberately do not author repository policy, MDM/signed
requirements or general enterprise managed-policy scopes. Claude global state
also contains auth/trust and remains native-owned; Desktop-only settings do not
become CLI defaults. Grok pager/custom sandbox artifacts and credential paths
remain host-provisioned. Existing narrow managed-policy/MCP/lifecycle channels
keep their established owners. Background/remote daemon modes still require a
managed persistent auth/session adapter; new CLI availability alone does not
justify forwarding them. See [scope contract](NATIVE_CONFIG_SCOPES.md).

Runner pin validation includes official Codex amd64/arm64 SHA256, Claude wrapper
and both Linux platform packages' npm integrity, direct amd64 version probes,
215 runner tests and Ruff. Full rootless image
`840864cca66c3b43271c48ff30def98a5000eb2150b745245081df93a23e52f9`
built successfully; a network-disabled real FastAPI `/health` probe returned
200 with all three expected versions ready. Its task image and intermediate
chain were removed. This is build/health evidence, not deployed adoption or
successful authenticated provider inference.

## Integrated verification and delivery

Original `main` advanced during verification to Gloria's already-landed quota
commit `f22d07b4f9831638d95f666522c588243676e98f`. It was privately merged with
full ancestry, both documentation entries and a fresh combined SPA build. Its
release remains 0.9.150; this maintenance batch is 0.9.151. No quota feature was
invented or independently enabled by this audit. The existing quota work remains
attributable to its own commit and [verification](verification/quota-emulation-2026-11-01.md).

The combined runtime source is `933f442dec9add53dec471ecb4a46233fec3f0f3`.
Later `7e820dcc...`, `2ecaabe...`, `f3ccbf6...` and their integration commit
`5d3264822e4c915886c487598922605fcf5e69c1` change only test fixtures or docs.
The final parent commit adds the completed audit; it does not change runtime code.

Fresh final database `maintenance_release_961eff1d` uses the same isolated
MySQL UUID/socket/port recorded above. Canonical setup applies 347 baseline
statements, followed by 120 migrations including the pre-existing quota 0120
and maintenance 0121/0122. The prior fresh combined database also verified a
second migration run is a no-op. Extended 120-second hook/test limits accommodate
this full serial V8/MySQL run on the shared development host.

| Final check | Result |
| --- | --- |
| API typecheck / lint / build | Passed; 233 existing lint warnings, 0 errors |
| Full API V8 coverage + real MySQL | Passed: 658 files, 8622 tests; 1 file/3 explicitly gated tests skipped. Coverage statements/lines 85.19%, branches 81.53%, functions 88.92%; all CI floors passed |
| Frontend Svelte check / unit tests | 0 errors, 1 pre-existing warning; 1016 tests passed |
| Built combined Chromium | 409/409 passed after isolated retry-fixture repair |
| Built combined Firefox / WebKit | 218/218 passed (109 per browser), same temporary WebKit libraries |
| Native Codex / Claude / Grok probes | Passed as detailed per issue; no authenticated inference |
| Go formatter / build / vet / make test | Passed, including both Python release-metadata scripts |
| Full Go race / tracing-tag vet+tests | Passed |
| Staticcheck 2025.1.1 | Passed |
| Govulncheck normal / tracing tags | 0 called vulnerabilities; two pre-existing module-only findings, below |
| Real terminal matrix | 451 cases passed across three engines, seven widths and five degraded modes |
| Wrapper local build matrix | Linux/macOS amd64+arm64 all built; SHA256 manifests verified; Linux binary reports 0.9.151 |
| Runner Ruff / pytest / image health | Passed: 215 tests, full built image health 200/all engines ready |

The two earlier serial coverage attempts stopped with 143 for final review fixes
and the advanced target; neither is a passed suite. The next full combined run
completed with 8620 passes and two documentation-contract failures. Both were
repaired by their original issue owners, preserving the assertions and adding
explicit real-consumer proof; the final complete rerun is recorded above.
The initial combined Chromium run had 408 passes and the owner-stream/test race;
EM-VERIFY-003 repairs the fixture and preserves both recovery behaviors.

The four local wrapper artifacts were built from runtime commit 933f442de at
2026-11-01T19:02:33Z; they were not published into the served wrapper store.

| Platform | Verified SHA256 |
| --- | --- |
| Linux amd64 | `09b1d428a04201f15cc76fd7ccd71f7c55e21596478acb42cccad5fc0a6cceaa` |
| Linux arm64 | `525deba071d4d23ad495036dc70dd8cfd9c2313f5d9f38d0021f13f0934fe504` |
| macOS amd64 | `77abd8a26079e66b72ae5aaaf86ae9f3947e11f0154c3719e9c54ef147a6a08e` |
| macOS arm64 | `cc0ab62323c736d5702441ee90aee449966de5adc0936034e2ac43a91ecee5ad` |

Nonblocking diagnostics are 233 pre-existing ESLint warnings, the existing Svelte
scroll-region tabindex warning, old Browserslist metadata, and two runner
dependency deprecation warnings under host Python 3.14. Govulncheck reports
[GO-2026-6866](https://pkg.go.dev/vuln/GO-2026-6866) and
[GO-2026-6860](https://pkg.go.dev/vuln/GO-2026-6860) only in a required
`golang.org/x/net` module, with no affected imported package or called symbol.
Both scans exit 0; no unrequested dependency upgrade is folded into maintenance.

The canonical API command intentionally skips the opt-in Docker instance test
(`TEST_INSTANCE_DOCKER`), wall-clock owner observation (`OWNER_IDLE_SECONDS`)
and multi-GiB transfer stress (`TEST_BINARY_TRANSFER_LARGE`). These are not
counted as passed. Linux amd64 runtime probes and four-platform compilation do
not establish native arm64/macOS execution. Actual provider inference, auth
refresh/adoption, external enterprise pins, manual screen-reader/usability
acceptance and account-dependent `best`/Grok catalog access remain unverified.
The shared editor uses existing design components/rules NAV-1, VIS-1, INT-2/3/5,
ACC-1; no new layout exception is introduced. Existing sources and native
consumers support the intended wiring; parser success alone is not presented
as production feature acceptance.

Commits preserve the configured author and use exactly one Codex assistance
trailer. The local graphical GPG signer hung, so task commits use a per-command
`commit.gpgsign=false` override and are unsigned; global Git settings were not
changed. No production migration, service restart or deployment ran.

Delivery targets the original clean `main` and recorded `origin` remote, using
separate Director merge/push grants and verified task ancestry. Only clean
integrated task worktrees/branches and task test resources are removed. The exact
final commit/target/remote SHA and cleanup outcome are in the operator result.

Rollback source is the retained quota target `f22d07b4f...`, not a reset to the
older initial checkout: revert only maintenance changes on a new branch while
preserving quota work and later commits. The new data repairs have not run in
production. If deployed later, restore intentional config from normal backups
or historical body/hash snapshots rather than guessing removed settings.

The required [fleet-reflect](skill://fleet-reflect) review reported observed
repeated advisor-policy conflicts as feedback
`97a3a1d3-3b35-4745-b4fe-e893205c311e`; unrelated versions-table contention is
only a suspected cause. Independent engine research reviews supplied the second
opinion instead. No infrastructure change or additional recovery schedule was
created by this maintenance task.
