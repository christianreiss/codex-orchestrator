# Engine maintenance — 2026-11-10

Run ID: `em-20261110-1bd44a7e`. Parent: Christa, agent
`1bd44a7e-8c64-4055-862a-dbcb7b642585`, Codex (`gpt-6.1-sol`, Tier 3). Task Tier 3: cross-engine contracts and
concurrent settings writers. Research, implementation and integration were separate.

## Starting point and delivery boundary

- Host: `biest.eulie.de`; original checkout
  `/home/chris/Documents/Projects/AI/codex-orchestrator`, clean `main`,
  `1654653544f63f1165a244c6b02b5f07f2294276`.
- `origin`: `ssh://git@git.alpha-labs.net:2222/eulotorium/codex-orchestrator.git`.
  Fresh `git fetch --prune origin` confirmed zero divergence.
- Checkout occupancy query returned complete checkout coverage, zero peers.
  Integration nevertheless uses an explicitly task-authorized linked worktree:
  `/tmp/engine-maintenance-20261110-1bd44a7e`, branch
  `maint/engines-20261110-1bd44a7e`. Every implementation issue has its own
  branch/worktree and an implementation agent distinct from its researcher.
- Engines rediscovered from `api/src/util/engine.ts`: Codex, Claude, Grok.
- Authorized delivery includes commit, integration, push to `origin`, and cleanup.
  Production deployment, migrations and restarts are outside this run.
- No managed login, provider-account assignment, production config or active
  session is changed for testing. Native probes use isolated temporary homes.

## Research and issue ownership

| ID | Engine | Finding | Research | Implementation | Status / commit |
| --- | --- | --- | --- | --- | --- |
| CDX-AUDIT | Codex | Current schema, catalog and argument grammar already supported | `research_codex` | None needed | Audit complete, no artificial fix |
| CGX-PERM-1 | Grok | Invalid nested permission rules accepted, then skipped natively | `research_grok` | `fix_cgx_permission`, `maint/cgx-perm-1bd44a7e` | Integrated `508a7c4b699cf01cdc8de53a578db74487a6aa03` |
| CGX-NESTED-1 | Grok | Fixed nested tables and valid effort/window forms | `research_grok` | `fix_cgx_nested`, `maint/cgx-nested-1bd44a7e` | Integrated `e514dbaef6387896e0002feb5e9cf6954d34604b` |
| CLX-MODEL | Claude | Fable 5.2/catalog/tier and native effort | `research_claude` | `fix_clx_model`, `maint/clx-model-1bd44a7e` | Integrated `08bd39bd31fd4a886abe34e74e0616c6035be40d`; sole cross-engine catalog/tier owner |
| CLX-SETTINGS | Claude | Optional unattended permission setting | `research_claude` | `fix_clx_settings`, `maint/clx-settings-1bd44a7e` | Integrated `561fcdebb36f30a01503cd1be88c3aad0f235cad` |
| CLX-RUNNER | Claude | Runner still pins 2.1.318 | `research_claude` | `fix_clx_runner`, `maint/clx-runner-1bd44a7e` | Integrated `641ca707836f2961a3e2f53bfea0941f63882d42` |
| CLX-CONCURRENCY | Claude | Native plugin save lost during global MCP-lock wait | `research_claude` | `fix_clx_concurrency`, `maint/clx-concurrency-1bd44a7e` | Integrated `cf2dc22adcbb0ef14bfb7526e1eee09f3beaa4b8` |
| RUNNER-DOC-1 | Shared | Root build command uses wrong context | Parent patch review | `fix_runner_doc`, `maint/runner-doc-1bd44a7e` | Integrated `77f18608b14dfabff0f3859054d30318350e0ead` |
| BROWSER-INVENTORY | Shared UI | Connectors missing from 42-route design inventory/fixtures | Full browser baseline | `fix_ui_inventory`, `maint/ui-inventory-1bd44a7e` | Integrated `02451c931f663204a16b67fe53ccf9a000ab1d66` |
| BROWSER-TOAST | Shared UI | Visible success notification fails normal-text contrast | Full browser baseline / Axe | `fix_ui_toast`, `maint/ui-toast-1bd44a7e` | Integrated `7d64348bd367faa5fd1b2a516bf2d14a93422208` |

Issue worktrees are `/tmp/em-<slug>-1bd44a7e`, with slugs `cgx-perm`,
`cgx-nested`, `clx-model`, `clx-settings`, `clx-runner`, `clx-concurrency`,
`runner-doc`, `ui-inventory`, and `ui-toast`, matching the branches above.
The parent reviewed every patch, resolved only integration conflicts (retaining
all CHANGELOG/OVERVIEW entries), and integrated the original issue commits.
Technical engine and UI fixes stayed with their issue agents.

## Sources and versions

All current-source checks below were performed on 2026-11-10. Installed launch
targets, system binaries, runner pins and upstream tags are distinct evidence.

### Codex

- npm `@openai/codex/latest` and GitHub latest release both name **0.167.0**,
  released 2026-11-06T01:40:00Z. `rust-v0.167.0` resolves to commit
  `086ccc833bc9cf01024ad2dd6af7dbd421b6bf9a`.
- Managed cache points to
  `/home/chris/.cxx/engines/codex/0.167.0-3362764336/codex`, which reports
  0.167.0; binary SHA-256
  `cdcb45aaa01d0f14e298985e09465aebccd47f64ecd298aea44814af7b62bbda`.
  System `/usr/local/bin/codex` and `/usr/local/sbin/codex` remain 0.153.4,
  but are not the managed launch target. A private 0.166 installation also exists.
- Runner already pins 0.167.0 with both platform digests. Vendored schema is
  byte-identical to upstream, SHA-256
  `66ed795352d32f2464778acd2e332b7fafe644246d540cdceec4663c56cfbc16`.
  It defines 103 root options including their types, nested schemas and defaults.
- Bundled model catalog SHA-256
  `1384625c0b6b3e67d3c60da29becea2b017f2c283fc1e2d05b8edafb4698eb10`.
  Existing native account cache fetched at 2026-11-10T10:36:38.903869188Z
  by client 0.167.0 has SHA-256
  `57cefad28f21c89cabcdc957369456abd86442b4d5ec46fdce2cb39948bf4c2e`.
- [Official changelog](https://learn.chatgpt.com/docs/changelog),
  [configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference),
  [models and retirements](https://learn.chatgpt.com/docs/models),
  [versioned schema](https://raw.githubusercontent.com/openai/codex/rust-v0.167.0/codex-rs/core/config.schema.json),
  [versioned model catalog](https://raw.githubusercontent.com/openai/codex/rust-v0.167.0/codex-rs/models-manager/models.json),
  [API deprecations](https://developers.openai.com/api/docs/deprecations).

## Configuration, models and feature decisions

### Claude research and accepted scope

npm `latest` and `next` both name **2.1.322**, published
2026-11-10T01:58:41.811Z; the provider's conservative `stable` tag is 2.1.311.
The fleet follows `latest`, not this separately named conservative channel.
Managed launch pointer selects
`/home/chris/.cxx/engines/claude/2.1.322-553255908/node_modules/@anthropic-ai/claude-code/bin/claude.exe`,
SHA-256 `bfb3703ad5380242328459bc62ada4bde8ae7ba57c6e1eeadb9c00e08874c478`.
System npm binary separately reports 2.1.263. Runner began at 2.1.318.
Package integrity is
`sha512-oP7oW4vM5DREWfL1jn4JSGlmLcrJ5QmppgADrVNJBUPiC1mQ5YvRrke0on+YZ/3QhKIaCJtdr6jPvehcAQIHLQ==`.
Official changelog revision:
`6e1e44f6433bfa17d198e932bff53373aa229eea`, body SHA-256
`a074556107911c423a449df2f0b1dbbabb51aaa66383b81c3ba4fea1c52679cf`.

The researcher compared every current settings-reference heading with accepted,
reserved, deprecated and scope-specific settings. The only new supported leaf
missing was `permissions.denyInsteadOfPrompting`, optional boolean since 2.1.319.
Its conditional floor must apply to false as well as true, without inserting a
default. The generic JSON editor remains its editable home.

Public Fable 5.2 requires CLI 2.1.321. Its native persistent efforts are
low/medium/high/xhigh with default **medium**; max is session-only. API default
high is a separate surface. Native metadata supplies advisor rank 10,
1,000,000 context and 128,000 maximum output; the ignored legacy top-level user
effort must not override per-model preferences. **New tier: Fable 5.2, absent →
Tier 5**, following provider positioning for demanding reasoning and extended
autonomous work. Existing classes remain unchanged. Fable 5 and 5.1 stay active;
no deprecation migration, removal or unsolicited fleet-default change. Tier
metadata lives in the unified registry; `model-tiers.ts` derives it rather than
keeping a second list. Optional
latest-family policy and Fable advisor alias should resolve to 5.2. Restricted
Mythos 5.2 stays outside the general catalog.

The wrapper's frozen pre-registry minimum table is deliberately unchanged:
new floors travel in the signed catalog, including its minimum map for omitted
models. Fast mode requires native Fable-specific opt-in consent; configuration
alone must not synthesize it. Current native CLI help has no confirmed grammar
gap. Independent background agents, gateways and Remote Control still lack the
managed process/auth/session lifecycle and remain outside the product. New MCP
background and feature-fetch controls use existing opt-in settings/env paths.
Global trust/auth state, project settings, enterprise policy and Desktop-only
settings retain their separate ownership.

Sources fetched 2026-11-10:
[native models](https://code.claude.com/docs/en/model-config),
[Fable 5.2](https://platform.claude.com/docs/en/models/fable-5-2/overview),
[lifecycle](https://platform.claude.com/docs/en/about-claude/model-deprecations),
[settings reference](https://code.claude.com/docs/en/settings-reference),
[settings scopes](https://code.claude.com/docs/en/settings),
[versioned changelog](https://github.com/anthropics/claude-code/blob/6e1e44f6433bfa17d198e932bff53373aa229eea/CHANGELOG.md),
[fast mode](https://code.claude.com/docs/en/fast-mode).

### Grok research and accepted scope

npm `latest` and official changelog remain **1.0.77** (2026-11-05); npm alpha
is 1.0.80, and published 1.0.78/79 are not stable targets. Managed launch target
is `/home/chris/.cxx/engines/grok/1.0.77-271265595/grok`, reporting build
`50ca579fa996`, SHA-256
`b702950aa5827d855e493278ab6215a4e0f5bceb5bba6c6243a9f55cdd143b0a`.
Its displayed alpha suffix is separate from npm distribution-tag evidence.
Unmanaged `~/.grok/bin/grok` is 1.0.46. Runner already pins 1.0.77;
the wrapper's 1.0.50 remains a recovery/settings floor, not a stable-version pin.
Bundled complete config reference: 99,146 bytes, SHA-256
`76b4fe09ce2e52e8fa89aaac0df44e3c75cec6b312d22bb7431b16bc486cdaa1`.

The reference has 410 table entries; repository registry initially had 457
patterns including nested fields. Every user field was compared. Missing worker
and custom update-channel controls remain deliberately refused for lifecycle
and updater ownership. The 24 table/table-array patterns were then inspected
for nested semantics. Fixed structures behind permission rules, BYOK auth/model
providers, marketplace sources, reasoning efforts, MCP setup, S3 video settings
and worktree GC require explicit validation; map names inside those structures
remain open only where native defines a map. Native inspect confirms invalid
inputs can be skipped, clamped, or prevent configuration loading. It also proves
valid string/mixed reasoning-effort arrays and custom `context_windows` lists,
which the original registry rejected. Separate issue CGX-NESTED-1 addresses this
shared modeling cause after CGX-PERM-1; native defaults must remain absent until
authored. Validation never executes providers, MCP, GC, downloads or video.

Revision-protected store, dotted-key ownership and serialized wrapper
read/modify/publish remain in use. Enterprise requirements, project config,
pager customization and local sandbox files remain separate native-owned
surfaces. Native usage display does not replace server billing; independent
worker/remote services still bypass managed lifecycle. Stable features since
the previous 1.0.77 audit are unchanged. No new model retirement was found.
**Tiering unchanged:** Grok 4.5 at 1; 4.6, 4.7 and 4.7 Build Fast at 2.

Sources fetched 2026-11-10:
[npm metadata](https://registry.npmjs.org/@xai-official/grok),
[changelog](https://x.ai/changelog/build),
[settings](https://docs.x.ai/build/settings),
[settings reference](https://docs.x.ai/build/settings/reference),
[CLI](https://docs.x.ai/build/cli/reference),
[models](https://docs.x.ai/developers/models),
[Grok 4.7 positioning](https://x.ai/news/grok-4-7).
Nested contracts come from official source commit
`2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8` and current 1.0.77 native probes:
`xai-grok-config-types/src/{permission,auth_provider}.rs`,
`xai-grok-shell/src/agent/model_providers.rs`,
`xai-grok-plugin-marketplace/src/config.rs`,
`xai-grok-sampling-types/src/types.rs`,
`xai-grok-config/src/{mcp_server_config,remote_settings}.rs`,
`xai-grok-tools/src/implementations/grok_build/video_gen/mod.rs`,
`xai-fast-worktree/src/auto_gc.rs` and `src/db/mod.rs`, all beneath
[`crates/codegen/`](https://github.com/xai-org/grok-build/tree/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen).

Fresh Subscription account catalog remains **unverified**: secret store was
checked first, existing model cache is from 2026-10-03, and the existing
access-only credential had expired. One read-only model-catalog GET returned
HTTP 401. No refresh, login or session lease was attempted. Public model docs
are not claimed to establish current account entitlement.

### Codex audit closure

The unchanged 0.167.0 schema and native feature list match the current validator.
The generic JSON editor and separate profile editor expose the schema-backed
user settings. Validation, normalization, revision-guarded persistence, host
overlays, TOML, sidecars and wrapper sync retain their existing coverage.
Conditional CLI floors include explicit false/empty values and profile settings;
literal provider/plugin names do not trigger false gates.

All eight verified current native models and their efforts match the registry.
Sol 6.1, Terra 6.1 and Sol 5.6 default to low; Sol 6 and Terra 5.6 to medium;
Luna 6 and Luna 5.6 to medium. Non-Luna models support
low/medium/high/xhigh/max/ultra, Luna supports low/medium/high/xhigh/max.
Astra's account-cache default is medium while the bundled default and explicitly
chosen fleet default are low; the operator-selected fleet value is preserved.
GPT-6.1 Luna remains absent from both verified catalogs and correctly gated on
live native availability. No new public model or deprecation migration is needed.
GPT-5.6 upgrade nudges do not establish retirement. Existing retired IDs and
ChatGPT-versus-API distinctions remain documented and preserved.
**Tiering unchanged:** Astra 5, Sol 3, Terra 2, Luna 1.

Native TUI improvements need no Fleet switch. Independent `agents`/app-server/
exec-server/remote-control services still bypass the managed broker/receiver and
remain refused; help remains available. Native login and GCP sign-in remain
wrapper-owned. Optional proxy/features remain opt-in. Enterprise requirements,
MDM, cloud policy and repository settings are separate native authority planes,
not centrally enforced user defaults. Custom provider model IDs stay opaque.

Research verification: nine API suites, 295 passed/5 skipped; five suites repeated
with the real native parser, 224 passed/0 skipped. Native-help option oracle
passed against actual 0.167.0. No authenticated inference or external
enterprise/IdP/proxy runtime behavior was inferred from parsing alone.

## Verification ledger

Baseline at original HEAD:

- API typecheck passed; lint has zero errors and 234 pre-existing warnings.
- `npm test`: 555 files passed, 132 skipped; 7,800 tests passed, 1,198 skipped.
- Wrapper `go build ./...`, `go vet ./...`, `go test ./...`: passed.
- Frontend `npm run check`: passed, including 1,057 tests and slop grep.
- Runner `ruff check .`: passed. Plain host `pytest` loaded an unrelated
  Home Assistant plugin and produced 120 event-loop setup errors, 95 passes.
  With `PYTEST_DISABLE_PLUGIN_AUTOLOAD=1`, all 215 tests passed. Host Python is
  3.14; container verification uses the image's pinned Python 3.12 separately.
- Disposable DB: rootless Podman container `engine-maintenance-mysql-1bd44a7e`,
  ID `789b4b411eb9c5afc5dc5da64785c50aa8bfb84c49bb5c00b7f65320e8be0a53`,
  loopback `127.0.0.1:35921`, database `codex_test`, MySQL 8.4 image digest
  `sha256:72c368d898861f3b3a07af0e6d690400f44f048799ed46822783d9224cc2c86d`.
  The first throwaway container was discarded after baseline setup and migrations
  were accidentally started concurrently (table-exists failure). The replacement
  used the single supported `migrate --init-schema` operation successfully;
  126 migrations applied. No production database was used by the test suite.

## Implemented contracts and acceptance evidence

- **CLX-MODEL:** `api/src/services/model-registry/data.ts`, generated frontend catalog and Go-consumed signed
  fixtures, minimum-version fixtures, wrapper `internal/claude/user_settings.go`, and model
  interface/tier docs now agree. Fable 5.2 is public Tier 5, native default medium,
  minimum 2.1.321; persistent max remains refused. Signed catalog behavior,
  legacy-effort exclusion, aliases and existing-model compatibility pass. Built
  browser tests exercise the model controls. Actual registry-to-Agents-preview
  rendering contains `claude-fable-5-2` in Tier 5 and the configured-model line.
  This preview uses an isolated all-active-registry fixture, not live host/account
  availability; catalog membership alone is not entitlement.
- **CLX-SETTINGS:** `api/src/services/claude-native-settings-catalog.ts`, native-settings
  services/tests, existing `NativeSettingsEditor.svelte`, API and Claude interface
  docs cover add/change/remove, boolean type, exact leaf ownership, sibling
  preservation, minimum 2.1.319 for both booleans, and no synthesized default.
  Real 2.1.322 probes verify the accepted syntax and native scope interaction.
- **CLX-CONCURRENCY:** wrapper `internal/persona/claude/lifecycle/settings_transaction.go` and
  settings-sync tests reproduce a native `plugin disable research-test@research
  --scope user` save during a three-second global MCP-lock wait. Previously the
  stale pre-wait snapshot restored true. User settings are now read after that
  wait; cooperating apply/strip/legacy/mirror/state writers share a wrapper lock.
  Byte/inode/mode/mtime preconditions, unique staged files, three bounded retries
  with fresh merges, and deferral preserve detected foreign edits. A failed
  primary publish cannot advance mirror or ownership state. Full Go suites,
  42 targeted race tests and independent actual-native probes pass.
  **Bounded mitigation, not a native transaction:** native writers do not share
  the wrapper lock; the final check-to-rename interval remains, and native can
  later publish its own stale transform. Interface docs explicitly disclose both.
  Fleet Advisor reviewed this distinction; the accepted guarantee is limited to
  the detected races, not universal losslessness.
- **CGX-PERM-1:** `api/src/services/grok-native-settings.ts` validates
  required action (`allow|deny|ask`), optional tool/pattern, optional
  `pattern_mode` (`glob|domain`) and unknown fixed fields. Native aliases
  `agentmessage` and `websearch` work; absent optional values stay absent.
  Invalid historical input remains available for correction rather than silently
  disappearing. Validation/render/store/ownership/native probes pass.
- **CGX-NESTED-1:** `api/src/services/grok-native-structures.ts`, registry
  definitions and interface docs cover remaining fixed BYOK auth/model-provider,
  marketplace, mixed effort menus, positive integer context-window lists, MCP
  select/variables setup, S3 credential/fallback and actual worktree-GC fields.
  Native optional defaults, case variants, short TTL warnings and empty read-only
  fallback behavior are preserved. Parent and researcher independently checked
  native positive/negative controls. Research acceptance: 240 tests on 1.0.77,
  73 on unmanaged 1.0.46 (binary SHA-256
  `41626a53292324140b92556b9d42ff5542e3dcd04aff85eafb8689dd4adb44fc`).
  The newly accepted forms already work below the 1.0.50 settings floor, so no
  invented new-version gate was added. No provider/MCP/S3/GC consumer was run.
- **CLX-RUNNER / RUNNER-DOC-1:** `runner/Dockerfile` pins 2.1.322 with package
  integrity and unchanged Codex/Grok versions. `runner/README.md` root build
  context is corrected from `.` to `runner`. Disposable image ID
  `0939b4526307d6560ca00494c3f536e0bf8bb429b5119b6adbb92f628ee02e41`,
  manifest `sha256:a976231fbe8dad976b87fba039fdaf25fc54eeae621e718dccfc8dafa2ce4a9e`:
  all 215 tests pass on Python 3.12.14; native versions are exactly
  0.167.0/2.1.322/1.0.77. Health/readiness succeeds as nobody with networking off
  and read-only root; expecting stale Claude 2.1.318 correctly refuses startup,
  exit 1. SELinux denied a test-source bind mount; copying tests into disposable
  tmpfs avoided any host security change. Own image/container were removed.
- **Browser issues:** `frontend/e2e/design-routes.json`, design fixtures and
  `DESIGN.md` now inventory all 43 routes including default-off Connectors.
  Shared Sonner maps all four severity text/background/border variables to
  existing semantic tokens. Visible success-toast contrast is 6.77:1 light and
  9.21:1 dark; both-theme Axe checks report zero violations. No assertion was
  weakened. Sources and built output are included; wrapper version is 0.9.173.

### Integrated verification

Technical source HEAD: `235430e3caa6335050e2af3a6cbaee459e7f1645`.
The final documentation/build-artifact commit changes no additional engine code.

| Check | Final result |
| --- | --- |
| API typecheck / build | Passed |
| API lint | Zero errors; 234 pre-existing warnings |
| API complete suite, actual Codex/Grok parser binaries | 558 files passed, 132 skipped; 7,922 tests passed, 1,187 skipped |
| Go build / vet / complete tests, actual native oracle binaries | Passed, 73 packages |
| Targeted concurrent-writer race tests | 42 passed |
| Wrapper tracing build/vet/tests | Passed (`make test-traced`) |
| Release-platform compilation | Linux amd64/arm64 and Darwin amd64/arm64 passed; cross targets `CGO_ENABLED=0` |
| Wrapper terminal contract | 451 cases passed, three engines/seven widths/five degraded modes |
| Release-manifest / publisher tests | Passed |
| Frontend `npm run check` | Passed; 1,057 tests, slop grep clean; pre-existing Svelte warning retained |
| Built Chromium `npm run test:e2e` | 471 passed, 5.1 minutes |
| Built Firefox / WebKit `npm run test:e2e:cross-browser` | 232 passed, 6.0 minutes; zero failed |
| Fresh disposable MySQL suite | 211 files passed/1 skipped; 2,152 tests passed/2 skipped, 918.47s |
| Runner lint / disposable-image tests / native readiness | Passed; 215 tests, positive and negative readiness |

Final DB identity: `engine-maintenance-mysql-1bd44a7e`, container
`f20f95a0c36a7ca8b981786495d57dd2e24c5f9ad74e38872dfe9459a06ddc82`,
MySQL 8.4.13, same image digest and loopback port above, new `codex_test` data.
Supported `migrate --init-schema` applied all 126 migrations. Initial clean-image
startup returned ECONNRESET before readiness; retry after readiness succeeded.

The initial DB characterization completed with 211 files passed/1 skipped,
2,149 tests passed/2 skipped. It started at the baseline and overlapped the first
Grok integration, so it is not claimed as a strictly immutable baseline.
An attempted final run reusing that data found three state/count failures and
was stopped (143); the full final proof uses the newly initialized container.
The fresh run tests the unchanged API source against clean data. No fixture
assertions or production data were modified to hide the reused-state failure.

The first optional cross-browser invocation could not launch either engine
because the host's default Playwright cache only contained Chromium. Pinned
Firefox 153.0 (build 1538) and WebKit 26.5 (build 2336) were downloaded into this
run's `.run/browsers`. Playwright's Ubuntu 24.04 fallback required two host-missing
libraries, extracted into `.run/browser-deps` only. The first library-path retry
passed Firefox launch but WebKit's MiniBrowser launcher resets LD_LIBRARY_PATH.
Private symlinks in its owned `sys/lib` runtime directories resolve the extracted
libraries without overwriting bundled files. No system package or verification
setting changed; a standalone WebKit page/close probe then succeeded.
The library-path attempt passed all 116 Firefox cases; its 116 WebKit launches
failed before page use. The final combined repeat starts only after the private
runtime links are installed, so it does not mix those environments.
Official Ubuntu packages used:
[libicu74 74.2-1ubuntu3.1](https://archive.ubuntu.com/ubuntu/pool/main/i/icu/libicu74_74.2-1ubuntu3.1_amd64.deb),
SHA-256 `c9a70989678660eed9a1e904c74fa043da8bec8e2036856fc16e31ced79b04f8`;
[libjpeg-turbo8 2.1.5-2ubuntu2](https://archive.ubuntu.com/ubuntu/pool/main/libj/libjpeg-turbo/libjpeg-turbo8_2.1.5-2ubuntu2_amd64.deb),
SHA-256 `f68b5b23bc8a1688fb787d2aed7e2cdf895a73022f6a5025e183162dac4500b2`.

The first full browser attempt used port 4187: 463 passed, seven failed. Five
failures came from existing assertions that require canonical port 4173; the
other two exposed the separately fixed inventory/toast issues. The final suite
uses 4173 and preserves those assertions. Checks were not represented as passed
until the corrected full run completed.

### Failed attempts and environment corrections

| Command / scope | Exit and sanitized evidence | Correction |
| --- | --- | --- |
| Host runner `pytest` | 1; 120 unrelated Home Assistant event-loop setup errors | Disable third-party plugin autoload; 215 passed, then repeat inside pinned image |
| Disposable `migrate --init-schema` while another init ran | 1; table already exists | Discard own first instance; single supported initialization on a new instance |
| Fresh-image migration before DB readiness | 1; ECONNRESET | Wait for readiness, repeat idempotent supported initializer; all 126 migrations applied |
| `npm run test:db` on reused test data | Stopped 143 after three stale state/count failures | New disposable container/schema; full fresh run passes |
| `PLAYWRIGHT_PORT=4187 npm run test:e2e` | 1; seven failures (five canonical-port expectations, inventory and toast contrast) | Canonical 4173 plus separate reviewed fixes; 471 pass |
| `npm run test:e2e:cross-browser` before browser install | 1; `Executable doesn't exist` | Download pinned binaries into own run directory |
| Cross-browser retry with library path | 1; WebKit loader `libicudata.so.74` missing, Firefox 116 pass | Private runtime links for the launcher that resets that variable; standalone native launch succeeds |

No failure was turned into a skipped assertion or a claimed pass. These were
local disposable-test environments; the product fixes and their source/native
acceptance evidence are listed separately above.

### UI review

DESIGN.md was read before UI review; existing components and semantic tokens
were reused. Slop job `58f19079-1aec-4933-983d-9bf9d32966e8`, quick run
`4f86cae5-f19b-4665-982d-5616d23cea73` (slop 0.3.0), scanned five source files,
zero scan errors; the Markdown standard is an unsupported quick-scan extension.
Its one **review** finding, `2cd6403f07f338a4`, suggested removed focus at
NativeSettingsEditor line 150. Review disposition: **false positive**. The same
line supplies `focus-visible:ring-2 focus-visible:ring-ring`. Independent built
browser probes in both themes confirm `:focus-visible`, a computed 2px blue
ring (light RGB 10/84/205, dark 97/166/250), and solid outline. Focused desktop/
mobile screenshots and source were reviewed; no suppression or unnecessary
source change was made. No actionable finding remains. This source scan is not
browser or WCAG certification; actual browser/Axe checks are separate evidence.
Engine controls at 1440 light/390 dark have zero horizontal overflow. All-route
browser sweeps provide broader coverage; manual screen-reader use and arbitrary
zoom were not performed. Quick run 2 (`92d20967-5aa6-420f-97e5-217fc75c4120`) and run diff
confirm no new source finding, one unchanged review false positive. The job was
closed and all twelve own transfer objects retired after preserving this result.

### Explicit limits and delivery

- Fresh Grok Subscription account model entitlement remains unverified (401),
  independently of the validated public/current-native syntax and catalog.
- Concurrent non-cooperating native writers retain the two documented races.
- No authenticated inference, arm64 execution, enterprise/IdP/proxy end-to-end
  runtime, production upgrade or live account/session mutation was tested.
- No full cross-platform or screen-reader certification is claimed. API lint
  warnings and the pre-existing Svelte warning were not converted into unrelated
  maintenance refactors.
- No deployment, production migration/restart, manual backup, schedule or
  persistent recovery was created. Host changes are task-owned local build/test
  artifacts on `biest.eulie.de` only.
- Final delivery requires Director-authorized fast-forward into original clean
  `main`, ancestry checks for every issue SHA, push to `origin`, exact remote-head
  verification, and removal of only clean merged task worktrees/branches,
  own disposable services, volumes and transfer/review artifacts. Final target
  and remote SHA are reported with the operator result (the report cannot embed
  its own containing commit SHA).
- Restoration is a reviewed Git revert of these issue/integration commits plus
  rebuilding the committed SPA from the reverted sources; no manual backup or
  production change needs restoring in this run.
