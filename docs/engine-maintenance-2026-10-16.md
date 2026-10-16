# Engine maintenance — 2026-10-16

Run `ava-a300faa7` follows `docs/prompts/engine-maintenance.md` for Codex,
Claude Code and Grok Build (`api/src/util/engine.ts`). The operator additionally
requested commit, push and production deployment. No schedule or persistent
recovery was created. This report distinguishes source verification from rollout.

## Starting point and isolation

Original checkout `/home/chris/Documents/codex-orchestrator`, branch `main`,
HEAD `4f8df723370aa980f57b7589c3689970cf026b9c`, clean tracked tree and index.
Delivery remote is `origin`,
`ssh://git@git.alpha-labs.net:2222/eulotorium/codex-orchestrator.git`.
Two other active sessions occupied the checkout, so the parent used isolated
branch `task/engine-maintenance-ava-a300faa7` and linked worktree. Concurrent
documentation cleanup and prompt clarification were incorporated at
`d6f842b1e4d6b1d8a56852bbada29dacce61ecfd` before implementation. Research
and implementation use separate agents; each confirmed issue has its own
branch and worktree. The parent reviews, integrates and runs combined checks.

Production was independently inspected on `root@docker01.uggs.io`, checkout
`/var/docker_data/codex-auth.uggs.io/app`: starting HEAD `4f8df723`, clean tree,
all five compose services healthy. Public `/healthz` and `/readyz` succeeded;
readiness reported 70 applied migrations and four wrapper platforms at 0.9.88.
Runner health reported Codex 0.162.1, Claude 2.1.296 and Grok 1.0.50, each
matching its baked pin. This is readiness evidence, not inference proof.

## Research sources and native versions

Sources were retrieved on **2026-10-16**. Native version/help/config probes used
temporary homes; no login, auth refresh, inference or existing session mutation
was used for testing. A system binary is not necessarily the managed launch target.

| Engine | Managed cached launch target | Other installation | Reviewed upstream target | Starting runner pin |
| --- | --- | --- | --- | --- |
| Codex | Private 0.163.0 | `/usr/local/bin/codex` 0.153.4 | 0.163.0, release 2026-10-15 21:30:38 UTC | 0.162.1 |
| Claude Code | Private 2.1.301 | npm PATH 2.1.263; `/usr/local/bin` 2.1.220 | Latest normal release 2.1.301; conservative vendor `stable` channel is 2.1.292 | 2.1.296 |
| Grok Build | Private 1.0.50 | Native PATH download 1.0.46 | Stable/npm latest 1.0.60, published 2026-10-15 03:01:22 UTC; alpha 1.0.61 excluded | 1.0.50 |

Codex primary references: [configuration](https://learn.chatgpt.com/docs/config-file/config-reference),
[schema](https://learn.chatgpt.com/docs/config-schema.json),
[CLI reference](https://learn.chatgpt.com/docs/cli/reference),
[models](https://learn.chatgpt.com/docs/models), and
[release 0.163.0](https://github.com/openai/codex/releases/tag/rust-v0.163.0).
The release commit is `83086188ae0614bd882818ff1aa23f3194962012`.
The current and [versioned schema](https://github.com/openai/codex/blob/rust-v0.163.0/codex-rs/core/config.schema.json)
match byte-for-byte, SHA-256
`e9dd16b9d1710e57b020e42da4af6d6606e8f44cb028a2e94196dee3890d9170`.
The native shared-option source establishes variadic image argument behavior.

Claude primary references: [settings](https://code.claude.com/docs/en/settings-reference),
[scope precedence](https://code.claude.com/docs/en/settings),
[model configuration](https://code.claude.com/docs/en/model-config),
[CLI reference](https://code.claude.com/docs/en/cli-reference),
[model lifecycle](https://platform.claude.com/docs/en/about-claude/model-deprecations),
and [versioned changelog](https://github.com/anthropics/claude-code/blob/03b5892ee77de289bcd5dfa39f541525ade74aff/CHANGELOG.md).
The complete settings Markdown digest is
`8ba90434d2801f9e7b3dc44e304bea0e3ca94c25d540cdcf9763369deeb355e4`;
native 2.1.301 binary SHA-256 is
`bc1aad9982c7b59c7d889ff92595d61cf46e0a6eae074cb551d932a989bcd222`.
Compiled native schema inspection corroborated fixed nested object shapes.
Latest release and the conservative `stable` channel are recorded separately;
the maintenance target follows the repository's latest normal release practice.

Grok primary references: [stable pointer](https://x.ai/cli/stable),
[npm metadata](https://registry.npmjs.org/@xai-official/grok),
[settings](https://docs.x.ai/build/settings/reference),
[modes and commands](https://docs.x.ai/build/modes-and-commands),
[changelog](https://x.ai/changelog/build), and
[versioned configuration reference](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager/docs/user-guide/26-config-reference.md).
Public source main remains at `2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8`;
the published changelog ends at 1.0.52 while the stable artifact is 1.0.60.
Neither source is assumed identical to the current binary. Native 1.0.60
reports build `01a8e1c591c0`; extracted amd64 SHA-256 is
`10e6af64b24724fc1074c373e906b9ad121110044dddcbd97ad43c3a25f96d5f`.
Native `inspect --json` was used with disposable configuration files.

Both Codex release tarballs and both Grok native npm archives were downloaded
and checked against their exact published digests, without npm lifecycle hooks.

| Artifact | SHA-256 |
| --- | --- |
| Codex 0.163.0 Linux amd64 musl | `beb339e8ecd9ba057a6bb2dc81ad8ca474812edfbf0fc5056ca818797648dde4` |
| Codex 0.163.0 Linux arm64 musl | `a7261e65f4a96d8f4ca65a069c6cf2dc2c33defc341e48078acefda9461fffe4` |
| Grok 1.0.60 Linux x64 npm archive | `17427fae1b6227c2ffef5c1fa67c688b4107b0375f12e96a4afb410de39b1c8f` |
| Grok 1.0.60 Linux arm64 npm archive | `dd19452ea0c4483ef85708ae846de58e214dca9698ff6f407665f2cab2735ee8` |

Arm64 integrity verification does not establish execution on arm64 hardware.

## Configuration coverage and feature decisions

All three engines were traced from the Engines JSON editor through preview,
route validation, exact saved revisions, normalization, fleet/host overrides,
native rendering, wrapper ownership and private native configuration. Structured
model, effort, posture, managed MCP, auth refresh and update controls keep their
existing owners. Generic native settings are user defaults, not enterprise policy.
The [scope matrix](NATIVE_CONFIG_SCOPES.md) records the separate native planes.

Codex's schema comparison covers root and profile options, including environment
context time, async compaction, current feature switches, multi-agent options,
plugin defaults, leader key bindings, selection behavior, Windows options and
voice enums. Removed `shell_zsh_fork` was still accepted by the old registry.
New options remain opt-in; native defaults are not changed by adding support.

Claude's complete public reference contains 245 root/nested headings. Existing
key coverage includes all except `idleCompaction`; deprecated `taskOutputMaxChars`
is correctly excluded. Idle compaction accepts a boolean, and false disables
the native behavior; true does not force-enable it. It was introduced in
2.1.290, below the existing native extension floor. Separate validation gaps
allowed typos such as `voice.enabld` or `permissions.additionalDirectory` that
native parsing discards. Map identifiers and literal dots need distinct handling
from closed object properties. Separate research review of 194 official examples
found a regression in the new closed validator: four documented `autoMode`
string arrays had no catalog entries. The same issue owner restored those and
the documented `permissions.disableAutoMode` alias. Final review accepted 190
examples, with four expected enterprise-policy rejections and no unexpected
failures. This is a public-example compatibility check, not exhaustive proof.

Grok's 435-entry registry was compared with current references and native
field probes. The 1.0.51 changelog and 1.0.60 diagnostics corroborate removal
of old memory tuning controls; `[memory].enabled` remains the supported switch.
Invalid enum/required-field shapes were also accepted centrally. Some documented
custom-parsed sections produce native unknown-field warnings, so those warnings
alone are not removal authority. `workflows.enabled` is already supported.
Web documentation lists `features.tool_search`, but stable 1.0.60 rejects it;
it is excluded until a usable native contract is established.

Independent daemon, remote-control, exec-server and Grok cursor-worker lifecycles
remain outside demonstrated fleet session/account/auth/receiver integration.
Direct Codex app-server/exec-server/remote-control/agents and external remote
socket starts, plus Grok external leaders, cursor workers and independent agent
services, receive explicit lifecycle refusals before auth/config work. Safe help
remains available. The wrapper's internal private app-server/leader remains its
managed receiver path. Ordinary Codex TUI native daemon defaults outside that
receiver path remain an unverified boundary; no causal auth defect or blanket
daemon control is claimed. Existing Claude service refusals remain; no optional
service is enabled by this audit.
System requirements/MDM, enterprise policy, project files, local trust/auth state,
Grok pager and host sandbox-profile files retain their separate ownership.

## Models and effort

No speculative model additions, removals or migrations are justified by this run.

- Codex: fresh 0.163.0 native cache at 05:15:24 UTC lists the same seven public
  models as the repository. Sol/Astra/Terra efforts include low through ultra;
  Luna ends at max. Defaults and native persistence agree. Restricted Daybreak,
  reserve and automatic-review choices are not general fleet models. Existing
  GPT-5.5 subscription migration remains appropriate after the documented
  2026-10-14 retirement; API-key availability is a separate contract.
- Claude: all 13 public entries and per-model native effort defaults agree with
  current lifecycle documentation. Haiku 4.5 remains Active; passage of its
  earliest possible retirement date is not deprecation. `max` remains session-only,
  newer user preferences use `modelSettings[model].effortLevel`, and ultracode
  remains a separate switch. Restricted Mythos models are excluded.
- Grok: retain the four established subscription IDs and effort/context metadata.
  No deprecation notice was found. A fresh authenticated subscription listing
  was unavailable: the credential store has no Grok entry and retained local
  access-only projections were expired. No refresh was attempted. The older
  cache is not presented as current entitlement proof.

## Issue and delivery ledger

Research agents: `audit_codex`, `audit_claude`, `audit_grok`. Each implementation
agent below owns a unique branch/worktree; commits and integration are recorded
after verification. Shared runner Docker edits are serialized during integration.

| ID | Engine / confirmed issue | Implementation owner | Fix / integration |
| --- | --- | --- | --- |
| EM-CODEX-001 | 0.163 schema support and removed-feature migration | `fix_codex_config` | `ba8ba1b3`, integrated |
| EM-CODEX-004 | Legacy structured feature values become null and disappear instead of failing validation | `fix_codex_feature_validation` | `6ebd2591`, integrated |
| EM-CLAUDE-001 | Missing idle compaction setting | `fix_claude_idle` | `604af7bf`, integrated |
| EM-CLAUDE-003 | Unknown nested fields accepted without native effect | `fix_claude_validation` | `41e99f20`, review follow-up `13274fe8`, lint follow-up `d8174ccc`, integrated |
| EM-GROK-001 | Removed memory controls and invalid native shapes | `fix_grok_config` | `d57ddd0a`, integrated |
| EM-RUNNER-001 | All three runner native pins lag the reviewed release targets | `fix_runner_pins` | `9c88604b`, integrated |
| EM-CLI-001 | Variadic images and global/valued options misclassified across native dispatch and identity | `fix_native_cli` | `cb71043b`, agents follow-up `957baae1`, auth guards `c654da2d` / `3490e332`, integrated |
| EM-SHARED-001 | Login-shell test confuses startup stderr with PATH | `fix_shell_test` | `a7b61aae`, integrated |

EM-RUNNER-001 consolidates research IDs EM-CODEX-002, EM-CLAUDE-002 and
EM-GROK-002. EM-CLI-001 consolidates EM-CODEX-003 and EM-GROK-003: these
findings share incomplete option grammar across consumers and need one owner
for shared helpers. The aliases remain stable references, not additional issues.

Parent reproduction for EM-CODEX-004: `ClientConfigService.render` accepted
`features.nonsense = "invalid"` and `features.async_compaction = "invalid"`,
normalized each to null, and omitted it from TOML. The legacy structured-only
render branch bypassed the native schema. Newly rejected removed keys are
separately covered by EM-CODEX-001.

Each issue branch is `task/em-<suffix>-a300faa7`; the corresponding worktree
is `/home/chris/Documents/codex-orchestrator-wt-em-<suffix>-a300faa7`:

| Issue | Branch/worktree suffix | Principal paths and verification |
| --- | --- | --- |
| EM-CODEX-001 | `codex-001` | Native schema, normalizer, version gates, 0071, editor reference; 141 focused tests including actual parser, 100 config tests, 11 MySQL migration/revision checks |
| EM-CODEX-004 | `codex-004` | Authoring/render validation, aliases, config docs; 3,200 service tests including native parser probes |
| EM-CLAUDE-001 | `claude-001` | Native key catalog, editor reference, lifecycle tests; 187 API tests, wrapper merge tests, frontend check |
| EM-CLAUDE-003 | `claude-003` | Native fixed-object grammar and catalog; normalize/store/render/ownership tests, source/example review, lint/typecheck |
| EM-GROK-001 | `grok-001` | Native registry/validation, 0072, editor reference; 171 unit tests, 13 MySQL migration tests, ten native probes |
| EM-RUNNER-001 | `runner-001` | Docker pins, Grok installer and docs; 215 runner tests, both-architecture artifact verification and amd64 versions |
| EM-CLI-001 | `cli-001` | Shared native argument grammar and affected dispatch/session consumers; focused Go packages and real safe native help oracles |
| EM-SHARED-001 | `shared-001` | Native entry tests only; package tests, race tests, build/vet, baseline failure reproduced |

All implementation worktrees were isolated from research and the parent.
Parent integration preserves original fix ancestry, combining conflicting
documentation references and both Claude store-test assertions. No assertion
was removed to resolve a conflict. The parent independently reran affected checks.

## Verification baseline

Toolchain: Node 22.22.2, Go 1.26.8, Python 3.14. Relevant commands come from
package scripts, Makefiles and `.github/workflows/{api,frontend,runner,wrappers}.yml`.
Dependency installs used the existing lockfiles in the isolated worktree.

| Baseline check | Result |
| --- | --- |
| API typecheck, build | Passed |
| API lint | Passed, 0 errors / 142 existing warnings |
| API test suite | 4,853 passed; 724 database-gated tests skipped, 381 passing files |
| Dedicated MySQL integration suite | 1,551 passed across 123 files |
| Frontend check including unit tests | 0 Svelte errors/warnings; 935 tests passed |
| Built frontend browser suite | 204 passed, two workers |
| Go build, vet | Passed |
| Go tests | Two pre-existing nativeentry test failures; all other packages passed |
| Runner ruff / pytest | Passed; 211 tests |

MySQL tests use a task-owned disposable **MySQL 8.4.10** process, bound only to
`127.0.0.1:33367`, database `maintenance_ava_a300faa7`, datadir
`/tmp/maintenance-ava-mysql-a300faa7/data`, socket
`/tmp/maintenance-ava-mysql-a300faa7/mysql.sock`. All 70 migrations were applied
to its baseline; the integrated source adds 0071 and 0072. No tests connect to
production. Local Docker daemon is absent;
the installed standalone MySQL provides the matching database tier.

Initial Go `go test ./...` exited 1 because two nativeentry tests used
`CombinedOutput` for a login shell: host startup emitted `tput` stderr before
the expected PATH. A `TERM=xterm-256color` rerun also exited 1 because each
test constructs its own environment without TERM. EM-SHARED-001 preserves
the actual PATH assertions while separating startup diagnostics from their value.
Runner pytest uses `PYTEST_DISABLE_PLUGIN_AUTOLOAD=1` to exclude unrelated
host-installed plugins, matching the previously documented local test boundary.

## Integrated verification and rollout

The integrated implementation head is
`57b0e1025c6111a16b8efe4925f380a0a4257456`; the delivery commit adds this
report, interface/changelog references, wrapper VERSION 0.9.89 and the tested
frontend build artifacts. All listed original issue commits are ancestors.
The final pushed/deployed delivery SHA is recorded in the production receipt.

| Final check | Result |
| --- | --- |
| API typecheck, lint, build | Passed; 0 lint errors / 142 existing warnings; 72 migration assets |
| API database-free suite with native parser opt-in | 5,048 passed; 727 database-gated tests skipped |
| Complete API/MySQL coverage suite, fresh database | 440 files passed; 5,796 tests passed / 1 environment-gated test skipped |
| API coverage | Statements/lines 87.17%, branches 83.85%, functions 90.36%; all canonical floors passed |
| Frontend check and unit tests | 0 Svelte errors/warnings; 935 passed |
| Built frontend browser suite | 204 passed with two workers |
| Runner pytest / ruff | 215 passed; lint passed |
| Wrapper make test, test-traced, vet; go build and full race suite | Passed, including release helper tests; final auth follow-up also reran affected package/race/vet checks |
| Wrapper terminal UI | 451 cases passed |
| Native probes and integration review | Pinned Codex parser, safe Codex/Grok help oracles, Grok config probes; independent Claude public-example review |

The single coverage skip is the opt-in real-Docker instance CLI test
(`TEST_INSTANCE_DOCKER` is unset; no local Docker daemon). Its mock-based
contracts pass, and production deployment is checked separately.

All eight issues are integrated, including the independent research reviews.
EM-CLAUDE-003's first integrated lint run exited 1 on the newly added control
character regex; the same issue owner replaced it with equivalent code-unit
validation and exhaustive control-character cases. The final lint result is
0 errors and the same 142 pre-existing warnings.

The first integrated coverage run reused the baseline/migration-test database.
Two messaging aggregate assertions failed because a prior fixture left one
orphan message unrelated to a current host. A read-only SQL group count
confirmed that extra row; that superseded run was stopped (exit 130). No
assertion was changed: the final coverage run
uses a newly created empty database `maintenance_ava_a300faa7_final` on the
same disposable instance, bootstrapped through the repository fixture.

Production authoring preflight passed for saved Claude and Grok settings.
Codex's historical structured profile has an empty feature array, so strict
new-input validation rejects that raw legacy shape; the actual persisted-read
compatibility path normalizes it and both canonical render and host render
pass. This distinguishes historical storage compatibility from new authoring.
No production settings were changed for that preflight.

The separate operator-authorized rollout uses
`scripts/deploy.sh --skip-git --backup --no-cleanup` on **docker01.uggs.io** after an independently checked,
clean, lease-protected fast-forward to the pushed source. `--skip-git` avoids
a second unleased pull; it does not bypass a dirty-checkout finding. The
checkout uses umask 022; only protected backups use umask 077. Docker-wide
pruning is disabled so unrelated images and rollback tags survive.

The production evidence directory for this run is
`/var/docker_data/codex-auth.uggs.io/backups/engine-maintenance-20261016-ava-a300faa7`.
It retains the previous HEAD, protected environment/compose copies, four old
wrapper manifests, the deployment's MySQL dump, deploy log and a runtime
receipt tying the pushed/deployed SHA to service images, health/readiness,
runner pins, wrapper binaries and public frontend hashes. Previous application
images have `rollback-20261016-ava-a300faa7` tags. Data repairs are idempotent,
but do remove the specifically identified stored controls; restoring the
pre-deployment database snapshot is the data rollback boundary and would also
revert later writes. No volume is deleted. Final delivery/rollout outcome is
reported separately from this source audit and in that receipt.

Remaining evidence limits: no live inference, provider login/refresh or active
session mutation was used as a test; no arm64 execution; no fresh authenticated
Grok catalog; ordinary Codex TUI daemon defaults remain unverified. These are
explicit boundaries, not successful runtime acceptance claims.
