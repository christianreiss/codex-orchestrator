# Engine maintenance — 2026-11-06

Run ID: `em-2026-11-06-de20fcf6` (parent agent Heidi, `de20fcf6`, Claude Opus 5.5).
Run together with a feedback sweep on the same integration branch
(`maint-sweep-de20fcf6`, base `d728d3a95`), merged, pushed and deployed on the
operator's explicit request. No secrets are recorded here.

## Starting point and isolation

- Original checkout `/home/chris/Documents/Projects/AI/codex-orchestrator`, branch
  `main`, HEAD `d728d3a95`, remote `origin`
  (`ssh://git@git.alpha-labs.net:2222/eulotorium/codex-orchestrator.git`), in sync
  with `origin/main`. The tree carried an untracked `.slop/` (hook output, not
  ours), so integration ran in a linked worktree registered with the Git Director.
- Engines discovered from the repository: Codex, Claude Code, Grok Build
  (`api/src/util/engine.ts`).
- Fleet hosts follow the provider's latest stable release unless locked
  (`api/src/services/client-versions.ts`); cron had already moved this host to
  Codex 0.167.0, Claude Code 2.1.318 and Grok Build 1.0.77. The repository's
  native-settings coverage, help corpora and the auth runner still named
  0.166.0, 2.1.316 and 1.0.70. Server-side version locks were not enumerated
  (no admin credential used).

## Research and implementation ownership

One read-only research sub-agent per engine; every confirmed issue then got its
own implementation sub-agent with its own branch and worktree. The parent
reviewed, merged (`--no-ff`) and resolved conflicts only.

| Issue | Engine | Finding | Fix commit | Merge |
| --- | --- | --- | --- | --- |
| CDX-1 | Codex | 0.167.0 schema additions rejected by the vendored 0.166 schema; 0.166 refuses to load `gateway_oauth.credentials_store` | `36b923e1b` | `841dcde2a` |
| CDX-2 | Codex | Runner pinned 0.166.0 | `5a8222dda` | `0d4044851` |
| CDX-3 | Codex | `agents --no-daemon` (embedded app server) rationale stale; help corpus 0.166 | `9736a040b` | `ff2ccb02c` |
| CDX-4 | Codex | `cli_auth_credentials_store` could be set centrally although the wrapper owns `auth.json` | `36b923e1b` | `841dcde2a` |
| CDX-5 | Codex | API deprecation successors for old IDs | none — deferred, see below | — |
| CLX-1 | Claude | `[1m]` model ids lost their effort (raw-id registry lookup) | `8fb27f390` | `17b4e5efd` |
| CLX-2 | Claude | Runner pinned 2.1.316 | `5a8222dda` | `0d4044851` |
| CLX-3 | Claude | Wrapper wrote `~/.claude.json` without Claude Code's config lock | `e9dc79496`, `20462db66` | `998cb0bc7` |
| CGX-1 | Grok | 1.0.71–1.0.77 fields, `keys.vim="all"`, hook `failClosed` rejected as unknown | `7a7cb3cbe` | `2187fe3ef` |
| CGX-2 | Grok | `cli.channels.<name>` fell through to a generic error | `7a7cb3cbe` | `2187fe3ef` |
| CGX-3 | Grok | Runner pinned 1.0.70 | `a596b8c81` | `0d4044851` |
| CGX-4 | Grok | Argument table lacked 1.0.77 worker options | `f230775f3` | `497ee6482` |
| CGX-5 | Grok | AGENTS.md said CLI quota reporting is unavailable (1.0.75+ prints plan limits) | `7a7cb3cbe` | `2187fe3ef` |

## Sources and versions (retrieved 2026-11-06)

| Engine | Latest stable | Evidence |
| --- | --- | --- |
| Codex | 0.167.0 (`rust-v0.167.0`, commit `086ccc833bc9…`, 2026-11-06T01:40Z) | GitHub release; npm `@openai/codex` latest; config schema SHA-256 `66ed7953…cfbc16`; musl amd64 `9d648361…251a`, arm64 `843489ac…b8eb281` |
| Claude Code | 2.1.318 (npm latest, GitHub "Latest"); 2.1.319 is `next` only and not adopted | npm dist-tags; CHANGELOG commit `90380efc…`; code.claude.com settings reference digest `21780148…` |
| Grok Build | 1.0.77 (npm latest, `x.ai/cli/stable`); 1.0.78 is `alpha` only | npm `@xai-official/grok`; bundled `26-config-reference.md` SHA-256 `76b4fe09…cdaa1`; linux-x64 binary SHA-256 `b702950a…143b0a` |

`x.ai/changelog/build` answered HTTP 403; Grok facts come from the bundled
reference and the integrity-checked npm packages.

## Configuration

- **Codex 0.167.0:** seven feature keys, `otel.log_sse_deltas`,
  `model_providers.*.capabilities.cyber_access_programs`,
  `model_providers.*.gateway_oauth.credentials_store` and `plugins.<id>.apps` are
  accepted for root and profiles behind `needsCodex167` (observed 0.167.0 floor).
  The research named the gateway field `oauth.credentials_store`; the implementer
  verified `gateway_oauth`. No feature was retired. Built-in providers still reject
  `capabilities`/`gateway_oauth`.
- **CDX-4 decision:** `cli_auth_credentials_store` must be absent or `"file"`
  (wrapper-owned auth sync). Stored non-file values are dropped on read; a
  read-only production query found the key in none of the 29 config documents
  and not in `versions`. `mcp_oauth_credentials_store` and the gateway store stay
  user-selectable; their file modes are plaintext and are not purged by the
  insecure-host cleanup (documented in `interface-cdx.md`).
- **Claude Code 2.1.318:** no new settings keys in 2.1.317/2.1.318; catalog stamp
  re-verified. Settings coverage is otherwise complete against the docs index.
- **Grok Build 1.0.77:** thirteen fields plus `keys.vim="all"` and hook
  `failClosed`, each gated on its first version (1.0.71/73/74/76/77);
  `fail_closed`/`onFailure` in TOML handlers are rejected naming `failClosed`;
  `cli.channels.*` gets the update-policy rejection; requirements-only, worker and
  experiment keys stay rejected. First versions come from bisecting the bundled
  references of npm tarballs; only 1.0.70 and 1.0.77 binaries were run.

## Models, efforts and tiers

- **Codex:** bundled catalog unchanged (same digest as 0.166); account catalog
  matches `model-registry/data.ts`. No deprecation for gpt-5.6/gpt-6 models.
  CDX-5 (map API-key deprecation successors for `gpt-5.3-codex`, `gpt-5.1`,
  `gpt-5.4-nano`) is deferred: the registry's native facts come from the CLI
  catalog, which names no successor, and the existing forced upgrade already
  moves `gpt-5.3-codex` to the fleet default.
- **Claude:** current Fable 5.1, Opus 5.5, Sonnet 5.5, Haiku 5.5; only
  `claude-sonnet-4-5-20250929` is deprecated (retires 2026-11-30) and is already
  migrated. Efforts and persistence keys match the docs. CLX-1 fixed `[1m]` ids.
- **Grok:** registry (4.7, 4.7-build-fast, 4.6, 4.5) unchanged; the live
  subscription catalog was not queried (would trigger a refresh under the
  one-refresher rule). API-only models stay out of the subscription gateway.
- **Tiering unverändert:** no model was added or removed and vendor positioning
  is unchanged (Codex: Astra 5, Sol 3, Terra 2, Luna 1; Claude: Fable 5, Opus 4,
  Sonnet 3, Haiku 1; Grok: 4.7/4.7-build-fast/4.6 Tier 2, 4.5 Tier 1).

## Feature decisions

| Feature | Decision |
| --- | --- |
| Codex `agents --no-daemon` | Refused like the daemon form (bypasses broker and receiver); help passes through |
| Codex sign-in submenu / GCP wizard | Out of product (login is wrapper-owned) |
| Claude `auth status` expiry fields, invalid `~/.claude.json` hard fail, version-cleanup in-use guard | Already compatible |
| Claude `mcp add/remove` under the config lock | Wrapper now takes the same lock (CLX-3) |
| Grok `grok usage` plan limit | Not wrapped; server billing fetch remains the source of truth |
| Grok worker flags / TypeScript agent / remote experiments | Out of product (independent services stay refused) |

## Operator decisions left open

- `CLAUDE_DEFAULT_MODEL = 'claude-sonnet-5'` (gateway default and fallback when
  "latest only" is off) is still active but legacy; Sonnet 5.5 or Opus 5.5 are the
  candidates. Not changed without an operator decision.
- The runner's API-key probe uses `claude-haiku-4-5-20251001` (active, no
  retirement announced); moving it to Haiku 5.5 needs a check of the 16-token
  budget against adaptive thinking.
- CLX-3: a lock held continuously for more than 3 s fails a strict-cache launch's
  config resource instead of writing unlocked; a "deferred" resource state would
  be a separate change. `enginedestroy.stripManagedMCP` (uninstall) still writes
  without the lock.

## Integrated verification and delivery

Integration branch `maint-sweep-de20fcf6` (engine fixes plus six feedback-sweep
fixes), wrapper version bumped to 0.9.168. Checks on the integrated tree:

- `api`: `tsc --noEmit` clean; `vitest run test/unit test/contract`: 453 files,
  6524 passed, 12 skipped.
- `api` DB tier on a disposable MySQL 8.4 (`npm run test:db:setup`, `migrate`,
  `test:db`): 2125 passed, 9 failed. The same 9 fail on the clean base
  `d728d3a95` (fleet-counts ×7, control-plane messaging, server-owner) and are
  reported separately; base had 13 failures, the sweep fixed 4.
- `wrappers/cxx`: `go build ./...`, `go vet ./...`, `go test ./...` green;
  sub-agents additionally ran the Codex help oracle against 0.167.0, the Grok
  value-option oracle against 1.0.77 and `-race` on the Claude config lock.
- `frontend`: `npm run check` (svelte-check, node tests, slop gate) green;
  `npm run build` regenerated `public/admin/`.
- Runner: `ruff`, `pytest` 215/215 and an amd64 image build reporting
  `codex-cli 0.167.0`, `2.1.318 (Claude Code)`, `grok 1.0.77`, `/health` ok.

Not verified: authenticated inference on any engine, arm64 execution, the live
Grok subscription catalog, server-side version locks, Playwright e2e.
