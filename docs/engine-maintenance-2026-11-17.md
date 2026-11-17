# Engine maintenance — 2026-11-17

Run: `3325c500`; coordinator Adelina. Research and source verification complete.
The paired feedback records carry the subsequent operational release evidence.

The operator requested both maintenance prompts, with commit, push and deployment
at the end. Research and implementation use separate native subagents; fixes use
individual branches/worktrees. The integration checkout was clean and unoccupied
on `main` at `8364a2874a18f15fa67f10251f47bd96547fe494`, tracking `origin/main`.
Remote: `ssh://git@git.alpha-labs.net:2222/eulotorium/codex-orchestrator.git`.

## Issue ledger

| ID | Engine | Evidence / intended outcome | Research | Implementation | Status |
| --- | --- | --- | --- | --- | --- |
| CDX-SCHEMA | Codex | Update 0.167 schema to official 0.169; retire ineffective controls, preserve ownership and gate new fields | research_codex | fix_codex_settings | Integrated d0fa3d41; migration 0132 |
| NATIVE-ARGS / CDX | Codex | Native 0.169 help oracle rejects missing value options | research_codex | fix_native_grammar | Integrated 6b28d52e |
| CLX-SETTINGS | Claude | 2.1.323 removed subagentStatusLine; Desktop policy scope diagnostic | research_claude | fix_claude_settings | Integrated 8bc97dab; migration 0133 |
| CGX-SETTINGS | Grok | 1.0.88 adds native fields absent from registry | research_grok | fix_grok_settings | Integrated d335e94c |
| RUNNER-PINS | All | Refresh independently verified native versions and artifact integrity | All researchers | fix_runner_pins | Integrated 532369ad; actual image, 269 tests and readiness controls passed |
| CKX-SETTINGS | Kimi | Native 2.6.2 rejects invalid types accepted centrally; missing real user sections and obsolete fields | research_kimi | fix_kimi_settings | Integrated e462b772; migration 0134 |
| NATIVE-ARGS / CKX | Kimi | Remote exec-server and nested provider options absent from grammar/refusal | research_kimi | fix_native_grammar | Integrated 6b28d52e; shared parser issue |
| CKX-MODELMETADATA | Kimi | Rendered models omit capabilities used by native thinking/media consumers | research_kimi | fix_kimi_model_metadata | Integrated 8e652307 + 39645379; independent follow-up review accepted |
| CDX-GATEWAY | Codex | Native requires gateway_oauth provider base_url and semantic auth/header constraints not enforced by JSON schema | fix_codex_settings probe | fix_codex_gateway_semantics | Integrated 5cc97779; 47 actual native probes |
| DOCS-CONTRACT | Shared | Exact retired Codex feature list and reviewed Grok-only native fixture exemption | Full integrated unit suite | fix_codex_settings, existing isolated issue worktree | Integrated b93c0868; 16 focused contract tests passed |
| DB-FIXTURE-NAMES | Shared tests | Actual producer cleanup leaves own name leases/pointers; preserve foreign assignments | Bounded MySQL causal regression | fix_server_feedback, isolated db-fixtures worktree | Integrated ee99cddb; RED → GREEN and 119 tests passed; no global hygiene claim |
| DB-ROOM-ROSTER | Shared tests | Four-engine presence assertion invited only three conference members | Independent source comparison and fresh baseline/current MySQL | fix_server_feedback, separate room-fixture worktree | Integrated 4da84af1; same isolated RED on 8364/e698 → GREEN; assertions and production rules unchanged |

## Integrated verification evidence

All heavy work after the memory-pressure incident was serialized under phase
allocations from Angelina, with cgroup memory/CPU/swap limits and a separate
pressure/deadline guard. Restic continued and no VM was stopped.

- Integrated full API units before the final test-only fixture changes:
  **485 files, 7,505 passed, one intentional skip**, 410.53 seconds.
  The skipped Docker-installer test would back up a real database; it was not
  enabled. The final post-merge repeat passed **485 files, 7,489 tests**, with
  **17 skips**, in 394.82 seconds: the same backup-installer skip plus 16 native
  opt-ins whose API environment variables were absent. Those real native
  probes had already passed in the preceding complete run; the final Go run
  separately enabled the actual native help oracles.
- Final production-source Go build and vet passed. Full uncached Go suite on
  `f858a9d86cb2defa90762eeb63a626762c5075d9`: **6,058 tests passed** across
  **82 packages** (78 passed, four contain no tests), 16 opt-in/platform skips.
  Actual Codex 0.169, Grok 1.0.88 and Kimi 2.6.2 help oracles were enabled;
  authenticated fleet/inference and optional daemon canaries were not.
- Final API typecheck on that source: **passed**, 2,512 files, 27.29 seconds,
  compiler memory 2,342,964 KiB. Full API ESLint: **zero errors, 237 warnings**;
  this is not a claim that warnings were eliminated.
- Fresh MySQL 8.4.13 focused acceptance: **150 tests in 28 files passed**,
  including data migrations 0132–0134, admin settings, real secrets routes and
  native Kimi 2.5.3/2.6.2 doctor probes.
- The broad fresh-DB run stopped at its first error after **1,300 passing
  tests in 37 files**, plus one skip. The retained-room assertion failed because
  the test omitted Kimi from the conference roster. The exact case independently
  failed on clean original `8364a287` and integrated `e698407c`, each with a new
  database; it passed after 4da84af1 (one passed, nine filtered, 2.80 seconds).
  The remaining broad DB files were not run. Its postmortem also found 605 pool
  assignments and 632 orphan name leases from the preceding fixtures; the two
  verified producer fixes do not establish complete suite-wide cleanup.
- Name cleanup causal regression: precisely three own residual leases and
  pointers failed before ee99cddb; the same regression and all 119 affected
  tests passed afterwards. The excluded foreign host assignment stayed intact.
- Runner acceptance used the real rebuilt amd64 image: **269 tests passed**,
  Ruff passed, non-root/read-only/network-none execution and all four pinned
  native versions passed readiness. Four deliberate pin mismatches failed as
  expected. Arm64 artifacts were integrity-checked, not executed.
- Final frontend acceptance: **1,101 tests passed**, Svelte-check zero errors
  and one existing accessibility warning, Slop grep clean. Canonical production
  build passed. The three affected browser specs passed **23/23**, one worker,
  no retries, in 49.7 seconds; light/dark phone and desktop evidence was captured.
  An initial bounded attempt stopped at a stale Claude 2.1.322 link expectation;
  correcting it to the actual 2.1.326 label passed without a product change.
  The temporary screenshot hook was removed before staging. The earlier
  unrestricted full browser run was aborted during memory pressure; neither
  full browser-suite nor cross-browser acceptance is claimed.

Early typecheck attempts with 1/2 GiB Node heaps exited 134 from V8 allocation
failure; the measured 4 GiB heap run passed. No kernel OOM occurred. One early
cleanup watchdog was too constrained and required targeted removal of its own
test payload; its replacement was subsequently proved twice with successful
automatic cleanup, inactive slices and absent containers. No unrelated process
was killed. The final bounded UI run peaked at 1,916,260,352 bytes with no memory
events; its browser/preview processes were gone and port 4173 was free. Runtime
acceptance and full served Slop/Advisor review remain separate delivery gates.

## Baseline and test isolation

- API typecheck: passed. Unit suite reproduces the five existing
  `managed-agents-features.test.ts` failures from feedback
  `37f6bc21-873d-4192-8ae0-319f3ee8c65f`; no task changes existed at invocation.
- Frontend check: zero errors, one existing Svelte accessibility warning;
  1,101 tests pass; slop grep passes.
- Runner: `PYTEST_DISABLE_PLUGIN_AUTOLOAD=1 pytest -q`: 267 passed, 2 skipped.
- Go build and vet: passed. Complete tests: 6,032 passed in 82 packages.
- Runner `ruff check .`: six pre-existing E702 errors in Kimi tests; separate
  repair required. No production runner failure was inferred from test formatting.
- Disposable rootless Podman MySQL: `maintenance-mysql-3325c500`, ID
  `4a28a7f49c5afad6d524339f67cd597471409624725b920371943548430891e5`,
  image digest `sha256:a81d043930e51745522bd5c430961cf8286f0a23f0a9a2a6e0108f7ea71b0902`,
  loopback `127.0.0.1:40107`, database `codex_test`. Supported
  `npm run migrate -- --init-schema` applied baseline and all 128 migrations.
  DB characterization exited 1; the output contains 44 failures, including
  repeated `No free launch name` errors in planned-reboot tests. The full output
  exceeded the terminal capture; exact summary and all causes require a retained
  log in the final run. This is not evidence of a production pool failure.
  It began on the original source but overlaps
  integration after 15:18 UTC, so it is not an immutable baseline. A child used
  only an independent temporary table/procedure from 15:13:24–15:13:31 UTC and
  removed both; no fixture tables or migration ledger were changed. Final DB
  verification must use fresh data and the completed integrated source.
  No production database is used for tests.

## Research evidence (all fetched 2026-11-17)

### Codex

Official [0.169.0 release](https://github.com/openai/codex/releases/tag/rust-v0.169.0),
tag commit `d32063f96c2dff1dc96af839b3952abb6acfeda4`, agrees with npm latest.
Managed launch target is
`~/.cxx/engines/codex/0.169.0-2007884179/bin/codex`, actual 0.169.0,
SHA-256 `b452ca20f838a8855a88a41050ee4a694033fff4ea3ecdad5633e6e0e8d13f2b`.
Runner/schema remain 0.167.0 at baseline. Current official
[schema](https://raw.githubusercontent.com/openai/codex/rust-v0.169.0/codex-rs/core/config.schema.json)
has 103 root fields, SHA-256
`f515f420927460250181097af8dc72b80a6be4f01f4324a0efef816e46cc9c86`.
All definitions were compared. New TUI/Guardian/search/provider fields and
features need current schema, precise floors and retirement of ineffective
controls. `incremental_tools_legacy` disappears in 0.168 and returns in 0.169;
the conservative new floor is 0.169, not a misleading monotonic 0.167 floor.
Researcher ran six suites with the real 0.169 parser: 282 passed. Native help
oracle independently failed on the missing exec-server value option.

Versioned [models.json](https://raw.githubusercontent.com/openai/codex/rust-v0.169.0/codex-rs/models-manager/models.json)
is unchanged, SHA-256
`1384625c0b6b3e67d3c60da29becea2b017f2c283fc1e2d05b8edafb4698eb10`.
Eight supported subscription models/efforts remain unchanged; non-Luna supports
low/medium/high/xhigh/max/ultra, Luna excludes ultra. Operator Astra default low
is preserved. GPT-6.1 Luna remains live-catalog-gated. Tiering unchanged:
Astra 5, Sol 3, Terra 2, Luna 1. API deprecations are not subscription retirements.

### Claude Code

[npm metadata](https://registry.npmjs.org/@anthropic-ai/claude-code) reports
latest/next 2.1.326, published 2026-11-16; the conservative stable tag is 2.1.311.
Managed native target is 2.1.326, SHA-256
`b6b3647d981130dc44fc670846ae97b6cde531ffb667cf9c4d17cfcafb38cb37`;
separate system/npm binary is 2.1.263. Runner baseline is 2.1.322.
[Official changelog](https://github.com/anthropics/claude-code/blob/bc1e8a88cb447f43697e848d991efed6cac2a64c/CHANGELOG.md)
and all 306 headings in the current settings reference were checked against
139 root/60 nested rules and explicit scope exclusions. Removal of
`subagentStatusLine` in 2.1.323 requires targeted healing; Desktop Managed
`disableRemotePreviewScripts` requires an accurate user-scope rejection.

Models/efforts and tiering unchanged: Fable 5, Opus 4, Sonnet 3, Haiku 1.
Fable 5.2 is already supported; deprecated Sonnet 4.5 is already excluded.
Restricted Mythos is not advertised as generally available. Persistent effort
is model-specific low/medium/high/xhigh; max remains session-only. Actual 2.1.326
help was compared with value-option tables, with no confirmed grammar gap.
Experimental Code Mode is already opt-in via the generic env editor; no
authenticated receiver/resume acceptance is claimed or automatic activation made.

### Grok Build

[Official npm metadata](https://registry.npmjs.org/@xai-official/grok) reports
latest=alpha 1.0.88, published 2026-11-16. The public changelog remains at 1.0.77;
the published artifact is the current configuration evidence. Native probe reports
`1.0.88 (2fe3608f7398)`, SHA-256
`a33013fe73ea63d2f18df636f90f84060a88712f9932b77cda0447dd83b4bfe5`.
Complete bundled reference: 121,331 bytes, SHA-256
`a74c01b5c3e99834d0005d4a3985f3d4867f209ee8dfadd71e51e24e72c79466`,
474 table rows including admin-only sections. Thirty-six new user field patterns
need support or explicit lifecycle exclusion. Native inspect accepts positive
fixtures and warns on an unknown-key control; it does not prove external consumer
execution. Five suites with the real parser: 271 passed.

No Grok installation/launch target exists on biest. Runner baseline is 1.0.77;
wrapper 1.0.50 is a recovery floor, not a release pin. Secret-store discovery found
no subscription credential; no fresh authenticated model entitlement is claimed.
Public model evidence establishes no new retirement or model. Tiering unchanged:
4.5 Tier 1, 4.6/4.7/4.7 Build Fast Tier 2. Existing efforts and high default remain
pending account-catalog confirmation. Model API image retirement is a separate
surface and does not justify removing subscription IDs.

### Kimi Code

Official [2.6.2 release](https://github.com/MoonshotAI/kimi-code/releases/tag/%40moonshot-ai/kimi-code%402.6.2),
published 2026-11-13, tag commit `6a8493df3e1d796a63f7c7ca0de76c1e690cd943`.
[CDN manifest](https://cdn.kimi.com/kimi-code/binaries/2.6.2/manifest.json)
SHA-256 `1445fe2a48cd895f863910a3448f0ac4495cc3e93aec290c66dfaf832393f896`;
Linux-x64 binary SHA-256
`c2070d77947b000016d1bc9c189f2e258c51f29d5f9eb537388cc44fa61c5856`.
The installer's official latest endpoint still returns 2.5.3; this conflicting
metadata is explicitly recorded. Runner/recovery baseline is 2.5.3; no managed
Kimi installation on biest. Safe memfd native 2.6.2 version/help/doctor probes
confirm the reported parser and configuration differences without installation.

The complete tagged configuration source/reference was checked. Invalid types
accepted centrally are rejected by native doctor, supported model_catalog is
missing centrally, and obsolete loop/secondary-model controls need precise
migration. Rendered model capabilities are missing despite actual native consumers
requiring them for thinking/media. This is a consumer-code finding, not a claim
of authenticated inference. Native exec-server/remote environments remain outside
the proven managed lifecycle and need an explicit pre-admission refusal.

Tiering unchanged: k3.1-pro/highspeed Tier 3; k3, k3-256k,
kimi-for-coding/highspeed Tier 2. No verified new subscription model or retirement.
Fresh account catalog and inference were not performed. The model-metadata fix
now carries the verified native consumer capabilities: Pro is always-thinking;
the 256k model accepts images, not video; Highspeed supports native thinking
on/off, with no adjustable effort list or invented default. Generic new authoring
rejects unsupported efforts and conflicts with full setting paths. Known old
low/high/max values heal out on projection; unknown invalid values retain the
historical body/hash and a visible validation error. Native on/off and host
overrides remain effective. An explicit model-defaults save removes only the
duplicate native effort, preserving enabled/keep siblings. This normalization
uses the verified native default; it does not claim to preserve an old numeric
value's thinking intent. Six causal RED cases, 25 final metadata/HTTP tests and
159 adjacent configuration/model tests support the follow-up; the independent
Kimi researcher accepted the final patch.

Migration 0134 deliberately also removes `task.max_running_tasks` and
`background.max_running_tasks` from documents used by old 2.5.3 clients, where
those limits were effective. There is no equivalent replacement in the new
contract. Renamed loop values migrate to their successors only when valid and
without overwriting explicit successors; invalid old values stay visible.
Rollback is an earlier code deployment plus explicit re-entry of any desired
legacy limits, not automatic restoration of deleted settings.

During this run, GitHub published regular **2.6.3** at 15:15:21 UTC (not draft or
prerelease). At the runner build cutoff, 15:30 UTC, its normal CDN manifest still
returned 404. The runner therefore uses verified **2.6.2** through the existing
installer instead of adding a new artifact fallback. The installer latest pointer
remains a separate observation (2.5.3). The 2.6.2→2.6.3 configuration registrations,
model catalog and thinking consumers have no contract delta; 2.6.3 changes the
Stop-hook timing and continuation lifecycle. Our hook reader uses unchanged
`session_id`/`hook_event_name` fields. No authenticated native-turn verification
was run, so neither a managed regression in 2.6.2 nor completed 2.6.3 runtime
acceptance is claimed.

## Shared scope and lifecycle decisions

Existing generic editors feed engine-specific validators, revision-guarded store,
normalization/host overrides, native JSON/TOML, exact ownership and wrapper sync.
Literal dotted names must retain JSON-path ownership. Add/change/remove and
concurrent saves remain required acceptance checks. New native syntax does not
authorize optional feature activation or credential-helper execution.

User defaults do not enforce project trust, enterprise requirements/MDM, native
local preference/state, referenced host files or remote services. Provider auth,
canonical refresh, managed MCP and updates retain their existing owners.
Independent service/worker/remote modes stay excluded until their native auth,
receiver and teardown contracts are actually integrated. Wrapper-local locks do
not prove universal cooperation with native foreign writers; documented race
boundaries remain explicit.

## Delivery

Implementation commits are integrated on `maintenance-20261117-3325c500`;
the source checks above are complete. The release targets `main` on `origin`,
with unified cxx **0.9.182** and sixteen engine/platform compatibility entries
from four platform builds. Runtime acceptance must verify the exact served
release commit, applied migrations, healthy API/runner/worker containers and a
completed Advisor review. Source/parser evidence alone is not fleet adoption.
The paired feedback records retain the post-rollout deployment reference and
saved final outcomes without predicting this audit's own Git commit.

Initial production read-only observation before rollout:
`docker01.uggs.io`, clean checkout `/var/docker_data/codex-auth.uggs.io/app`
at `b388a131694cbb32eb026f69b09183e0e7616552`; API and runner healthy.
Advisor container TLS verification fails against the current API while host
verification succeeds. Its mounted CA file predates the current host bundle;
the feedback sweep handles cause and diagnostics. This is a pre-rollout
observation, not a claim about the subsequently deployed artifact. Rollback
redeploys `b388a131694cbb32eb026f69b09183e0e7616552`; values removed by data
migrations require explicit re-entry where older clients need them.
