# Engine maintenance — 2026-10-12

This audit compares the fleet's native CLI integrations with current official
provider documentation and installed native binaries. Provider API model lists
are not interchangeable with subscription CLI catalogs. This run changes source
and build artifacts; it does not deploy or modify fleet runtime configuration.

## Baseline and sources

Repository baseline: `195db6bc3667cccedd4a8e363f7e2902c9a8d787` (`main`).
Sources below were retrieved on 2026-10-12.

| Engine | Native version inspected | Stable upstream | Primary references |
| --- | --- | --- | --- |
| Codex | 0.162.1 (managed private binary) | 0.162.1 | [Config reference](https://learn.chatgpt.com/docs/config-file/config-reference), [JSON schema](https://learn.chatgpt.com/docs/config-schema.json), [models](https://learn.chatgpt.com/docs/models), [CLI](https://learn.chatgpt.com/docs/cli/reference) |
| Claude Code | 2.1.296 (managed private binary) | 2.1.296 | [Settings reference](https://code.claude.com/docs/en/settings-reference), [model configuration](https://code.claude.com/docs/en/model-config), [CLI](https://code.claude.com/docs/en/cli-reference) |
| Grok Build | 1.0.46 | 1.0.50 | [Settings](https://docs.x.ai/build/settings/reference), [changelog](https://x.ai/changelog/build), [stable channel](https://x.ai/cli/stable) |

The system-wide Codex binary is older than the managed private binary; the
managed version is the relevant launch target. Grok's alpha channel is excluded.
A native command accepting a value or exiting successfully is not proof that it
uses that setting: native schemas and effective configuration are required.

## Findings and delivery ledger

Every implementation finding was assigned to a subagent in its own linked Git
worktree. Related native command findings share one isolated dispatch fix.
The parent reviews, integrates and verifies the combined result.

| ID | Finding | Delivery |
| --- | --- | --- |
| CDX-1 | Fixed config whitelist loses current native settings and structured values; deprecated options remain accepted | Integrated `83b19837` |
| CDX-2 | Deprecated GPT-5.5 remains in active fleet selections | Integrated `ac44cf13` |
| CDX-3 | Native subcommand map retains removed `mcp-server` and omits current aliases | Integrated `33bc13ae`; usage reference synchronized in `28a8773c` |
| CLX-1 | Claude catalog omits current models and retains an obsolete auth probe model | Integrated `4f5cfe6d` |
| CLX-2 | Top-level user `effortLevel` is ineffective for newer models requiring `modelSettings` | Integrated `5fbcf399`; signed catalog fixtures refreshed in `93d12168` |
| CLX-3 | Native user settings are lost by the config whitelist; deprecated settings are not consistently handled | Integrated `5a938b6f` |
| CLX-4 | Native command/option tables lag the supported Claude CLI | Integrated `33bc13ae`; usage reference synchronized in `28a8773c` |
| CGX-1 | Native Grok settings are lost and ownership cannot represent every native path | Integrated `3f3abc5e` and `43ce2256`; native context/posture values remain editable and removable without stale normalized copies |
| CGX-2 | Grok runner installer remains pinned below the current stable release | Integrated `ae355f79`; actual amd64 and arm64 package integrity verified |
| UI-1 | Current engine configuration has no general native settings editor; structured saves can discard unrelated settings | Integrated `8194d0e0`; route contract coverage completed in `04573bfa` |
| CFG-3 | Profile authoring is missing, inheritance is unstable, and native extensions can reach incompatible CLIs | Integrated `07c48f2f`; profile editor and previews, version gates and report-before-sync recovery |
| CFG-2 | Rendered content hashes cannot protect settings-only edits, first creation or concurrent writes | Integrated `1381bda2`; exact revisions and transactions. Empty-config fixture corrected in `c2ffafb3`, with 200 repeated concurrency cases passing |

## Models and thinking effort

- Codex: the authenticated native cache refreshed at 12:29:11 UTC by CLI
  0.162.1 confirms seven active models. Its SHA-256 was
  `7502f58e0fdaa94d653777e0ffed8dceb8c3cd1bb9d430c192b22f035229aeb6`.
  GPT-5.5 is hidden and has an upgrade to GPT-6.1 Sol; the announced retirement
  is 2026-10-14. It is removed now under the no-deprecated-models requirement.
  Existing valid effort is retained; otherwise the replacement defaults to low.
- Claude: the official [lifecycle table](https://platform.claude.com/docs/en/about-claude/model-deprecations)
  and native 2.1.296 catalog establish Haiku 5.5 plus still-active Opus 4.6/4.5.
  Deprecated Sonnet 4.5 and retired aliases migrate. Native CLI effort differs
  from API effort: Opus 4.5 and Haiku 4.5 have no native effort control.
  Opus/Sonnet 4.6 persist low/medium/high and accept max only per session.
  Opus/Sonnet/Haiku 5.5 persist per-model preferences and default to medium;
  ultracode remains a separate boolean, never an effort level.
- Grok: the fresh subscription catalog agrees with all four existing model and
  effort entries; no speculative model additions or removals were needed.
- Catalogs describe publicly supported subscription CLI choices, not entitlement
  for every account. Restricted-access models are not general fleet options.
  Known retired IDs migrate in supported configuration reference fields;
  unknown custom-provider IDs are preserved where native settings allow them.

## New feature decisions

| Engine | Capability assessed | Decision and implementation |
| --- | --- | --- |
| Codex | Current structured features, rollout budgets, agents/memories, hooks, UI, MCP attributes and profile sidecars | Support through schema-validated native JSON and native TOML rendering. Enabled rollout budgets also require their native semantic limits. Existing fleet model/posture/MCP ownership wins at render time. |
| Codex | Current command aliases and remote-auth/additional-directory flags | Refresh dispatch grammar; remove obsolete `mcp-server` classification. Values that resemble commands remain values. |
| Claude | Per-model effort, advisor/fallback settings, model picker, ultracode, workflows/hooks, plugins, UI/accessibility and native user settings | Support the documented user-settings fields through the general JSON editor; preserve values not represented by the older structured form. Native nested validation covers common structures, enums and model effort, not every constraint in Anthropic's internal schema. |
| Claude | Native daemon, remote-control and self-hosted runner services | Defer service integration: these entry points do not inherit the managed settings/auth/session lifecycle. Refuse managed invocation with a specific explanation; safe help remains available. |
| Grok | Stable 1.0.50 config, model tables, UI/tools/hooks, memory, MCP and version overrides | Support the reviewed native config field registry with TOML types and exact leaf ownership. Pin verified stable packages; alpha releases remain excluded. |
| All | Engine-wide configuration editing and concurrent authoring | Add JSON editing with server preview and exact revision checks; retain dedicated model controls and do not activate optional capabilities by default. |

## Scope and evidence limits

The [scope matrix](../NATIVE_CONFIG_SCOPES.md) gives exact destinations, native
precedence, version requirements and profile authoring examples.

- Native settings must retain their own engine's names, types and scope. Fleet
  model defaults, host posture, managed MCP and authentication still have explicit
  ownership. Unsupported scopes must fail visibly rather than be silently saved.
- Coverage is for the managed native user configuration plane. Codex enterprise
  requirements/MDM/cloud policy, Claude global preferences in `~/.claude.json`
  and system-managed policy, and Grok pager/custom sandbox/requirements files
  remain native-owned external planes. Central authoring of these planes is not
  implemented; wrong-scope fields are rejected with guidance. Existing native
  policy still applies. This is not a claim that every provider configuration
  file can now be authored centrally.
- Authentication, canonical refresh ownership, managed update controls and
  reserved fleet model/MCP/posture paths keep their established owners.
  Native user settings do not override those lifecycle contracts.
- A fresh authenticated read of Grok's subscription `/v1/models` returned HTTP 200
  using an existing unexpired access-only projection, without refresh or inference.
  It confirms `grok-4.7`, `grok-4.7-build-fast` and `grok-4.6` with
  low/medium/high/xhigh, plus `grok-4.5` with low/medium/high. All default to high
  and expose 256,000/500,000-token windows with a 256,000-token default. These
  agree with the repository. No credentials are retained in this report.
- New stable native capabilities are assessed for their fleet use case; supporting
  an option does not turn it on by default. Experimental functionality stays opt-in.

## Verification

Before changes, API typecheck and 4,397 tests passed (611 database-dependent tests
skipped), all Go tests passed, and frontend check plus 890 tests passed. Database
checks use a dedicated disposable MySQL 8.4 instance, never the operator database.
Its baseline setup and all 62 migrations succeeded; the complete integration tier
then passed all 1,369 tests across 106 files.
Final commands use Node 22.22.2 and Go 1.26.8. Runner checks use the host's
Python 3.14 and installed dependencies, rather than the production Python 3.12
image. `ruff check .` passes; `PYTEST_DISABLE_PLUGIN_AUTOLOAD=1 pytest -q`
passes all 210 tests. Disabling auto-load excludes an unrelated host-installed
Home Assistant pytest plugin that broke the first runner invocation.

The final integration gates are API typecheck/lint/tests/build, the full MySQL
integration suite, frontend check/build and Playwright suite, Go build/vet,
wrapper tests with and without tracing, release helper tests and terminal UI
checks. The deployable `public/admin` artifacts are rebuilt from this source.
No production deployment, auth refresh or model inference is part of this run.

Integrated Go verification passed: `go build ./...`, `go vet ./...`,
`make test`, `make test-traced`, `make test-terminal` and `make build`.
The terminal suite covers 451 cases across three engines, seven widths and
five degraded modes. The wrapper build uses version 0.9.66.

Frontend check passed with zero Svelte errors/warnings and 902 unit tests.
The rebuilt SPA passed 152 of 160 browser cases initially. All eight failures
had Chromium `ERR_NETWORK_CHANGED` while fetching local assets; all eight
passed a separate single-worker rerun, including the unchanged affected pages.
The six native-settings/profile browser cases passed in the full run.
API lint has zero errors and 128 existing warnings.

Final API suite: 4,568 passed, 621 skipped in the non-DB tier, across
364 passing files. Typecheck and build passed. The corrected usage reference
also passes the complete 126-test API contract directory.

Final MySQL integration suite: all 1,382 tests across 108 files passed.
The empty-range concurrency fixture supplies an explicit model because its
synthetic engine key deliberately has no defaults; the first full run correctly
rejected its otherwise empty configuration before reaching the race. The fixed
case preserves one-winner/409 assertions and verifies the stored winner revision.
It also passed 20 repetitions (200 revision cases) and 53 related DB checks.

All 16 isolated implementation/follow-up commits are ancestors of the reviewed
integration branch. Delivery targets the original `main` branch and `origin`;
Git merge/push receipts are reported by the completing maintenance run.
