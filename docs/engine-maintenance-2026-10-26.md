# Engine maintenance — 2026-10-26

Run `annika-21958441` executes [the maintenance contract](prompts/engine-maintenance.md).
Status: **source integration verified; delivery follows this commit**. The operator explicitly authorized
completion, merge-or-discard cleanup, push and deployment on 2026-10-26. This supersedes
the original source-only delivery restriction. Native probes use disposable homes
and do not log in or run inference.

## Baseline and ownership

Original checkout: `/home/chris/Documents/codex-orchestrator`, `main`,
`3bb370b6f62c7bf0b709a1e96310ef6c6ec9c5fa`, initially clean index and worktree.
The initial remote-tracking ref was one commit behind; `git fetch --prune origin`
confirmed remote `main` already contained this baseline. The pre-existing commit
is not attributed to this maintenance run.
Remote: `origin`, `ssh://git@git.alpha-labs.net:2222/eulotorium/codex-orchestrator.git`.
The unrelated `github` remote is not a delivery target.

All task-owned source and temporary tests run on host `biest.eulie.de`.

Parent integration branch `task/engine-maintenance-21958441` lives at
`/home/chris/Documents/codex-orchestrator-wt-maintenance-21958441`.
Git Director and resource claims coordinate integration and each issue worktree.
Checkout discovery returned no other online session with complete checkout coverage;
an unrelated disconnected Android worktree remains preserved. The parent selected
isolation anyway for the delegated integration chain. Native children share the
parent fleet UUID `21958441-42e2-46da-98f5-df949e43a210`; their task names below
identify transcripts, not separate fleet identities.

The assignment is Tier 4; the host-configured model is Tier 3 `gpt-6.1-sol`,
with no more specific runtime model exposed. The one-tier-above rule permits
proceeding after disclosure. Fleet Advisor independently agreed with Tier 4.

## Current sources and native installations

All retrievals below occurred on **2026-10-26**. The supported engines were
rediscovered in `api/src/util/engine.ts`: Codex, Claude, Grok.

| Engine | Managed cached launch | Other native installation | Stable maintenance target | Baseline runner pin |
| --- | --- | --- | --- | --- |
| Codex | Private 0.164.0, SHA256 `b93f6811d3f653f0fb83be4050d857fb9abbb111dfa2ce160563327daff7f306` | `/usr/local/bin/codex` 0.153.4; PATH entry is managed shim | 0.164.0 | 0.163.0 |
| Claude Code | Private 2.1.310, SHA256 `b73676430af12f97316a798b8371f81d640f90a58bdcb8f3ce56a835bb47df56` | npm PATH 2.1.263; `/usr/local/bin` 2.1.220 | Latest normal 2.1.310; vendor conservative stable channel 2.1.308 | 2.1.301 |
| Grok Build | Private 1.0.50, build `c58f321264ba` reports alpha | PATH vendor 1.0.46, build `2765805b9442` stable | Stable/npm latest 1.0.70, build `f50904eaee6c` | 1.0.60 |

The cached launch pointer is distinct from a system executable, account entitlement,
server-stored version preference or a currently running process. No managed engine
installation is updated by the research. Server-stored global/host pins were not
queried through an administrative credentials channel.

Codex sources: [release 0.164.0](https://github.com/openai/codex/releases/tag/rust-v0.164.0),
commit `6aaac694803004a63c6f393d153c96d22521a6b9`;
[versioned schema](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/core/config.schema.json),
[current schema](https://learn.chatgpt.com/docs/config-schema.json),
[models](https://learn.chatgpt.com/docs/models),
[CLI reference](https://learn.chatgpt.com/docs/cli/reference).
Schema SHA256 `ea611ee3f12a6df314b3e49585015ec6e2ebc7c3f072ccbf63c21306a4cdb5dc`:
103 root fields, 202 definitions, 191 feature entries and 28 embedded profile fields.
This versioned schema supplies the complete types/enums/defaults/structures inventory.
Product model Markdown SHA256
`87a2915f285b10cafd7e5bc8875edd640d273fe63a4ec0cd13a62866e75828fb`.

Claude sources: [settings reference](https://code.claude.com/docs/en/settings-reference),
[scope precedence](https://code.claude.com/docs/en/settings),
[model configuration](https://code.claude.com/docs/en/model-config),
[lifecycle](https://platform.claude.com/docs/en/about-claude/model-deprecations),
[CLI grammar](https://code.claude.com/docs/en/cli-reference),
[changelog](https://github.com/anthropics/claude-code/blob/b70dc4113ad72e0ee44f7b1b95afaf510b53ee98/CHANGELOG.md).
The complete settings reference has 247 root/nested entries; HTML SHA256
`14bb39ba6f2f6a30c07a3d0d44e3240ec403bd19eea60f7d467a25165eaa917c`.
Changelog SHA256 `27d7a0e1d5c1b98cce5153a4c9e467e8a361550c4cfe9d0aa471f46b8dc0ed83`.
Latest release published `2026-10-23T21:20:46.540Z`.

Grok sources: [stable pointer](https://x.ai/cli/stable),
[npm registry](https://registry.npmjs.org/@xai-official/grok),
[settings](https://docs.x.ai/build/settings/reference),
[changelog](https://x.ai/changelog/build),
[current model guide](https://docs.x.ai/developers/grok-4-7),
[model announcement](https://x.ai/news/grok-4-7).
Public source remains at `2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8`; the
SHA512-verified 1.0.70 artifact's bundled manual is newer. Its complete
`26-config-reference.md` SHA256 is
`ebd97fec98bb00bfdfa37befddf31dd8a14e3f277db887c7b643888867865db7`.
405 reference rows were compared with 424 existing registry patterns and supplemented
by its configuration/hooks/status-line manuals. The official stable distribution selection reports an embedded `[alpha]` build label;
this is recorded separately rather than relabeling the binary. Linux x64 archive SHA256
`2190ea4a29e0c931b34a3f8f1e2a71cb6ce1137181790e1ba9569f2dbcf3022f`;
extracted binary `22d281c5964c5444147328096ba2a221f3f0874c6858e27c825656a80f6e58e9`.

## Research, configuration and feature decisions

Separate research transcripts: `research_codex`, `research_claude`, `research_grok`.
Each read the full audit scope and delivered current-source inventories, runtime
probes, implementation findings, acceptance criteria and limitations. Separate issue
agents implement the confirmed changes; the parent reviews and integrates.

All three authoring paths were traced: Engines generic editor → preview/API validation
→ revision-checked storage → normalization/fleet and host overrides → native JSON/TOML
→ wrapper ownership/sync → native consumer. Parsing alone is not runtime-effect proof.
Authentication, refresh, posture, managed MCP and updates keep their existing owners.

Codex: support 0.164 presets, request hooks, plugin provisioning, OAuth, MITM v2 and
new opt-in feature settings. Remove proven retired realtime/worktree/environment flags.
Preset byte limits and OAuth cross-field requirements need semantic checks beyond
the JSON schema. New fields need exact version gates without gating opaque map IDs.
Native inline model/permission menus, image preview and ordinary native bug fixes
need no additional fleet feature. Independent servers remain outside the integrated
receiver lifecycle. New `migrate-nfs-db` requires coordinated multi-host SQLite
quiescence; help can remain available while execution receives a concrete refusal.

Claude: the 247-entry comparison finds the missing `sandbox.allowNestedUserNamespaces`
boolean, Desktop-only `sshHostCommands`, and already rejected retired
`taskOutputMaxChars`. Nested namespaces remain opt-in, default false; the native
security consequence is disclosed. Desktop SSH commands are excluded with a scope
explanation because the CLI accepts but does not consume them. Existing compaction,
plugin/artifact, monitor and workflow settings remain native opt-ins. New background
flags, gateway and dispatch services need lifecycle protection.

Grok: refresh registry/types and migrate proven retired UI/memory controls, preserving
canonical values and unrelated siblings through version patches. New `experiments`
patches are a separate rollout plane; raw passthrough could bypass fleet ownership.
Worker configuration requires the independent lifecycle exclusion. Custom/BYOK context
windows must not inherit subscription-only enum limits. Native `inspect` warning
alone is not removal evidence: separate loaders consume hooks and notifications.

Revalidated scope exclusions: enterprise/cloud policy and enforced requirements have
different authority from user defaults; repository/local settings belong to their
repository; global sign-in/trust state and host-specific referenced files remain
native-owned. See [the scope matrix](NATIVE_CONFIG_SCOPES.md). No optional feature is
enabled merely because central authoring becomes supported.

## Models, effort and tiers

Codex initially retained seven models with native capability evidence. The public
`gpt-6.1-terra` entry was temporarily blocked: the 18:14 cache and versioned
[bundled data](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/models-manager/models.json)
omitted it. Bundled SHA256
`943ca7fe1d19ed019054158303f0dbbd80b3bef43b3aa425a71aa7cb3fb52c2b`.
The native unknown-slug fallback and separate API docs did not justify inventing
CLI efforts. Later the running 0.164.0 client's naturally refreshed cache at
**2026-10-26T18:39:04.477022144Z** contained the public list entry, default **low**,
efforts **low/medium/high/xhigh/max/ultra**, context 500,000 and maximum context
872,000. Parent independently read that cache; SHA256
`40449d8835e351509f4af2dbe1484d86f515d9ce30b37179253c551677e2408c`.
This resolves EM-CODEX-002. No login, forced credential refresh or inference was
used to obtain it. Implementation is delegated separately after the shared model
capability foundation; API-only effort defaults remain a different contract.

Known `gpt-5.4`/mini migration successors and compatible-effort preservation need
correction. Already migrated ordinary Astra values cannot be reverse-inferred to have
legacy provenance and must remain untouched. Unknown custom IDs retain their identity.
No new deprecation of the seven retained public models was established. Astra's
account default medium differs from bundled low; fleet default is a separate policy.

Claude: all 13 retained models match current lifecycle information; no additions or
removals required. Sonnet 4.5 is already migrated; Opus/Haiku 4.5 remain Active.
Persistent efforts and per-model defaults remain unchanged. `max` remains session-only;
ultracode remains a separate mode. Restricted Mythos is not a public picker model.

Grok: retain the four established subscription IDs and efforts. No current authenticated
subscription catalog was available after credential-store discovery; no real refresh
chain was touched. Public API `xhigh` for 4.5 is not subscription evidence. Tier review
is separate from effort/entitlement; final decisions and exact rationale follow below.

## Issue ledger

Every implementation owner has its own `task/em-<suffix>-21958441` branch and
`/home/chris/Documents/codex-orchestrator-wt-em-<suffix>-21958441` worktree.

| Stable ID | Engine / finding | Research | Implementation owner / suffix | Fix SHA / integration |
| --- | --- | --- | --- | --- |
| EM-CODEX-001 | 0.164 native schema, semantics, gates and retired fields | research_codex | fix_codex_001 / codex-001 | `e2e77ae26`, integrated |
| EM-CODEX-002 | Missing public Terra native effort metadata | research_codex | fix_codex_002 / codex-002 | `b1f28dc74`, integrated; native minimum separately tracked below |
| EM-CODEX-004 | Known legacy successors and compatible effort preservation | research_codex | fix_codex_004 / codex-004 | `8be0ef6a7`, integrated |
| EM-CODEX-005 | Terra minimum CLI across managed model selectors and recovery | fix_codex_002 review | fix_codex_005 / codex-005 | Implemented in final integration; verification below |
| EM-CODEX-006 | Confidential OAuth/EMA parse and actual-use constraints | research_codex review | fix_codex_006 / codex-006 | Implemented in final integration; verification below |
| EM-CODEX-007 | MITM semantic constraints beyond emitted JSON schema | research_codex review | fix_codex_007 / codex-007 | Implemented in final integration; verification below |
| EM-CLAUDE-001 | Nested namespaces and explicit Desktop scope | research_claude | fix_claude_001 / claude-001 | `afece31b7`, integrated |
| EM-GROK-001 | 1.0.70 config registry, migrations and field gates | research_grok | fix_grok_001 / grok-001 | `d3dafe619`, integrated |
| EM-GROK-003 | Custom model context window validation | research_grok | fix_grok_003 / grok-003 | `8eb6152e6`, integrated |
| EM-CLI-001 | New command/flag grammar and independent service boundaries | All three | fix_cli_001 / cli-001 | `8d2f9d57c`, integrated |
| EM-RUNNER-001 | All three source pins lag audited stable versions | All three | fix_runner_001 / runner-001 | `eac1884ea`, integrated |
| EM-GROK-004 | Observed version must be reported before gated sync | fix_grok_001 review | fix_grok_004 / grok-004 | `4e7f75206`, integrated |
| EM-CONFIG-001 | Invalid saved native settings block corrective admin reads | fix_grok_001 review | fix_config_001 / config-001 | `879dcbee0`, integrated |
| EM-TEST-001 | Current MySQL schema missing in isolated fixtures | Parent baseline | fix_test_001 / test-001 | `ff7f73d29`, integrated |
| EM-TIERS-001 | Cross-engine capability-tier evidence review | All three | fix_tiers_001 / tiers-001 | `fe5a72973`, integrated |

EM-CLI-001 consolidates CODEX-003, CLAUDE-002 and GROK-002 because the shared cause
is incomplete native grammar/lifecycle classification. Runner findings similarly
have one common owner. Repeated aliases are not extra issues.

## Verification and environment

Commands derive from CI, package scripts and `wrappers/Makefile`. Toolchain:
Node 22.22.2, Go 1.26.9, Python 3.14.8 (runner CI uses 3.12).
Dependencies use the existing locked installation; runner tests use a task-local
venv with pinned requirements. Docker's default socket is absent. Disposable
standalone MySQL **8.4.10**, UUID `19b61d09-d169-11f1-9565-90e2ba389b56`, binds only
`127.0.0.1:13379`; datadir `/tmp/engine-maintenance-20261026-21958441/mysql`, socket
in the same task directory. Baseline database `maintenance_baseline_21958441`.
Production data and auth are never test targets.

| Baseline check | Actual result |
| --- | --- |
| API typecheck / lint / build | Passed; 0 errors / 229 existing warnings |
| API suite | 6,393 passed; 1,117 DB-gated skipped; 486 passing files |
| Frontend check / unit | 0 errors/warnings; 999 passed |
| Go build / vet / suite | Passed (exit 0) |
| Runner ruff / pytest | Passed; 215 tests, two dependency deprecation warnings |
| Built browser suite | 364 passed; one Retry-loading timeout; isolated policy block rerun 11/11 passed |
| Real-MySQL suite | 1,989 passed / 4 failed / 2 skipped; four fixture failures fixed by EM-TEST-001 |

The first database invocation used an empty root password: the test helper replaces
empty `DB_PASSWORD` with its fixture default, yielding MySQL access-denied errors and
skipped setup. A second overlapping attempt was stopped immediately; both task-owned
process trees were terminated. A fresh database and explicit `TEST_DATABASE_URL` with
nonempty disposable credentials remove the ambiguity. Aborted attempts are not passes.
Some complete-owner tests also require the URL directly rather than only DB variables.

The baseline browser build changes existing committed artifacts, proving initial
source/artifact drift. The final combined build will regenerate only `public/admin`;
this is source artifact generation, not publication. Full usability, screen-reader,
physical arm64 execution and real provider inference are not inferred from these checks.

## Integration, delivery and cleanup

Final integration uses `task/maintenance-final-21958441`. OAuth commit
`36f3ee1e0` is included once; its duplicate staged patch is discarded. Reviewed
uncommitted Terra minimum-version and MITM work is retained. Old SPA builds and
dependency scratch are discarded and rebuilt from the combined sources.
All 16 old task worktrees are removed only after integration and verification.
Final task-owned source changes can be rolled back by reverting the recorded commits;
JSON migration cleanup is destructive to retired keys, so restoring those historical
preferences would require a pre-migration database backup. Production migration execution is now authorized as part of the verified deployment.

WebKit initially exited before tests because ICU74/jpeg8 were missing. Ubuntu24.04
packages were downloaded and extracted in the task scratch directory using a disposable
Podman container, without host package installation. Preloading those exact libraries
allows the unmodified native WebKit binary to launch. Final browser runs record this
process-scoped environment workaround; the initial failed launch is not a product failure.

Runner artifact verification covered Codex, Claude and Grok Linux amd64/arm64;
all published digests matched and all three amd64 version probes ran. No arm64
execution or complete runner image build is claimed. Final source pins are
Codex 0.164.0, Claude 2.1.310 and Grok 1.0.70.

## Independent review and tier decisions

The original Claude researcher accepted the integrated coverage at `631e7cee5`:
155 independently rerun API tests plus native help, app and namespace-merge tests
passed. The original Grok researcher accepted config/CLI/recovery/pins/tiers after
173 focused integrated tests; the subsequent custom-window issue now has its own
verified commit. The Codex researcher accepted the original findings at `9cdd6eeed`
but found real OAuth/EMA and MITM semantic omissions; EM-CODEX-006/007 are implemented in the final integration; native-parser
regressions cover OAuth and hook-selected MITM action constraints. EM-CODEX-005 covers the documented Terra 0.159
minimum through managed choices without raising a blanket floor for other models.

| Model | Previous tier → new tier | Evidence and reason |
| --- | --- | --- |
| Grok 4.7 | 2 → 3 | Current engineering and longer-task positioning; mixed results support conservative cross-cutting engineering class, not universal superiority. |
| Grok 4.7 Build Fast | 1 → 3 | Exact native subscription identity matches current provider same-model/faster-serving statement. Serving speed does not reduce capability. |
| Grok 4.6 | 1 → 2 | Codebase/application implementation positioning and current comparative engineering results exceed mechanical-only work. |
| Grok 4.5 | 1 → 2 | Original engineering and complete-application evaluations support feature work; age alone does not justify a lower class. |
| GPT-6.1 Terra | New entry → 2 | Existing Terra family classification, confirmed by current efficient everyday-work positioning. |

Codex and Claude family tiering otherwise unchanged. Exact sources, benchmark
conditions and variant identity evidence are in [model-tiers.md](model-tiers.md).
Tiering is the fleet's routing judgment, separate from account entitlement,
effort and provider API capability. The tier issue reproduced nine old expectations
and passed 250 model/policy/advisor/guidance/actual-Agents-preview checks.

## Source-only verification limits

No real provider inference, confidential OAuth registration, secret-file read,
MITM proxy connection, actual namespace escape or live account refresh is used
as a test. Native parser probes and released consumer source checks establish
specific contracts; they do not claim successful external service use. Native
hook consumption was verified with good/bad argument forms, with folder trust
disabled only in the disposable scratch home and no hook execution.
Manual screen-reader, text zoom and independent human usability acceptance remain
unrun; existing shared primitives, keyboard/Axe/browser assertions are separate
evidence rather than a WCAG/usability certification. Final automated checks follow.

## Finalization after operator instruction

The operator explicitly selected merge or discard of all old maintenance branches,
followed by a concrete next plan. All reviewed source changes are retained; no
independent feature branch remains as a substitute for delivery. Duplicate source
patches and generated artifacts are discarded only after replacement is verified.

Validation logs and branch-to-original-SHA cleanup inventory are retained at
`/home/chris/Documents/codex-maintenance-evidence-21958441`. The disposable MySQL
8.4.10 instance uses loopback port 13381 and UUID
`be9fedac-d179-11f1-99e8-90e2ba389b56`, separate from production. Its migrations
0109 and 0110 passed the canonical runner before the integration suite.

Runtime deployment proof follows this source commit through the existing detached
deploy supervisor and its `result.json`; a successful source build alone is not
deployment acceptance. The deployment publishes cxx 0.9.137 and rebuilds the API
and auth-runner. Removed retired preference keys cannot be restored by an image
rollback alone; restore their prior values from the existing Bareos backup if needed.

## Final integrated checks

- API: typecheck, lint (0 errors; 229 existing warnings), build; 6,613 tests
  passed, 1,128 database-gated cases skipped in the database-free tier.
- Real MySQL 8.4.10: the full integration run passed 1,998 cases; three fixtures
  exceeded their original DDL/setup/cleanup time budgets (one failing test and
  setup/cleanup suite failures). Scoped setup/cleanup/DDL budgets are now 120s;
  all six cases in the affected three files passed on rerun. Two separately
  gated cases remain skipped (idle observation and a binary-transfer case).
  Both new migration regressions exercise idempotency against actual MySQL.
- Frontend: svelte-check and 999 unit tests passed; freshly rebuilt committed
  SPA passed all 374 Chromium browser cases at the canonical port 4173.
- Wrapper: gofmt clean; go build and go vet passed; complete `make test`
  including release metadata passed; all 451 real-PTY terminal cases passed.
- Runner: ruff passed and final full pytest run passed all 215 tests. One
  initial process-group timeout test failed under concurrent workload; its
  15-case suite and the subsequent full suite passed without a code change.
- Native precedence review found and fixed two real Terra-version bypasses:
  explicit `--model` wins independently of `-c` order, and ignored legacy
  profile overrides cannot hide a profile-v2 sidecar selection.

Environment corrections were not product fixes: the first alternate-port
browser run conflicted with hard-coded fixture expectations; long or symlinked
TMPDIR paths broke Unix sockets and realpath-sensitive tests. Final API tests
used the real evidence directory; final Go tests used the short real `/var/tmp`.
Full race/traced-mode, staticcheck, govulncheck, cross-browser and real provider
inference were not rerun as part of this finalization. No successful external
OAuth/MITM/account operation is inferred from parser/source/mock checks.

The next separately scoped implementation plan is
[host resource admission](resource-admission-plan.md), including the operator's
required fleet on/off switch and host `fleet`/`on`/`off` override.
