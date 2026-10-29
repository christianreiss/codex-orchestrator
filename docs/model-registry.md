# Model registry

Every engine model the fleet knows (Codex, Claude, Grok) is defined once, in
`api/src/services/model-registry/data.ts`. Everything that lists, validates,
tiers, upgrades or offers a model derives from it. Adding or changing a model is
an edit to that file plus `npm run models:generate` (from `api/`) and the
registry snapshot (`npx vitest run test/unit/services/model-registry.test.ts -u`).

## Inventory (2026-10-29, before the registry)

`grep -rIl -E "gpt-6-luna|gpt-6\.1-terra|gpt-6\.1-sol"` hit ~60 files. Classified:

**(a) Registry data, hand-maintained in several places**

| Where | What |
| --- | --- |
| `api/src/services/config-normalizer.ts` | `SUPPORTED_MODELS` (Codex list and order) |
| `api/src/services/codex-model-capabilities.ts` | Codex persisted efforts, native default efforts, CLI floors |
| `api/src/services/codex-model-upgrades.ts` | fleet default model/effort, retired-id upgrade map |
| `api/src/services/claude-models.ts` | Claude list, retired/alias upgrades, display names, token limits, API `line`, efforts, defaults, CLI floors |
| `api/src/services/claude-effort.ts` | Claude session-only `max` set, legacy top-level `effortLevel` set |
| `api/src/services/config-normalizer.ts` | Claude advisor ranks and native advisor aliases |
| `api/src/services/grok-models.ts` | Grok list, efforts, defaults |
| `api/src/services/model-tiers.ts` | Codex/Claude family tiers, Grok per-id tiers |
| `frontend/src/lib/constants/models.ts` | picker labels and ids for all three engines (comment "keep in lock-step") |
| `frontend/.../HostExceptions.svelte` | Terra `0.159.0` floor and Grok 4.5 effort fallbacks |
| `wrappers/cxx/internal/config/model_version.go` | Terra and Claude CLI floors |
| `docs/model-tiers.md` | tier table |

**(b) Derived views (already computed from (a), now computed from the registry)**

`model-defaults.ts` (admin catalog, signed `model_catalog` via `modelLaunchCatalog`),
`model-policy.ts` (latest-family policy), `openai-models.ts` (`/v1/models`),
`host-agents.ts` / `advisor.ts` / `managed-agents-features.ts` (Model Class Check
table), `codex-model-support.ts` (floor checks), `wrapper-config.ts` (signed config),
the launchpad menu (`wrappers/cxx/internal/launchpad`, reads the signed catalog).

**(c) Legitimate fixtures and history (left as they are)**

API/Go/e2e tests that pin concrete ids, `wrappers/testdata/host-*.json`
(regenerated, never hand-edited), `docs/evidence/*`, `docs/archive/*`,
CHANGELOG, the runner's Codex pin notes (`runner/*`, `docs/auth-runner.md`),
`api/scripts/verify-gateway-matrix.ts` (a probe target), and dated prose in
`docs/interface-cdx.md` / `docs/OVERVIEW.md` / `docs/model-tiers.md`.

**Deliberately outside the registry**

| Where | Why |
| --- | --- |
| `wrappers/cxx/internal/claude/user_settings.go` (5.5 models ignore top-level `effortLevel`) | wrapper-local read of native settings; mirrors registry `legacyUserEffort`. Outside this change's Go scope. |
| `wrappers/cxx/internal/codex/lane.go` (`normal` lane → `gpt-6-astra`) | lane fallback; outside scope |
| `wrappers/cxx/internal/app/grok/startup.go` (Grok default model/effort) | boot-card display fallback when no config names a model; outside scope |
| `wrappers/cxx/internal/config/model_version.go` legacy floors | frozen fallback for signed configs that predate `model_catalog.min_cli_versions`; new floors travel only in the signed config |
| `wrappers/cxx/cmd/terminal-preview` | dev tool with an illustrative menu, not a catalog |
| `api/src/services/git-director.ts` `GIT_DIRECTOR_DEFAULT_MODEL` | a feature setting default, not catalog data |
| Grok context windows (`grok-models.ts`) | engine-wide, not per model |

Grok is not runtime-dynamic in this repository: `GROK_SUPPORTED_MODELS` was a
static list verified against the native subscription catalog. It is registered
like the others; the `grok_default_model` gateway setting is unchanged.

## Design

- `model-registry/data.ts` — plain typed data, one array per engine, in canonical
  (picker) order, plus the fleet defaults and the Claude advisor alias targets.
  Entry: `id`, `label`, `family`, `tier` (1-5, `docs/model-tiers.md`), `efforts`,
  `defaultEffort`, `status` (`active` | `deprecated` | `retired`), optional
  `minCliVersion`, `upgradesFrom` (retired ids that heal to this one), `aliases`
  (active spellings that canonicalize without changing model), and capability
  flags that used to be special-cased by name: `sessionEfforts` (Claude `max`),
  `legacyUserEffort`, `advisorRank`, `api` (Claude gateway limits) and
  `liveCatalogRequired`.
- `model-registry/index.ts` — read-only queries (`registryModels`, `acceptedModelIds`,
  `offeredModelIds`, `upgradeMap`, `familyTiers`, `claudeAdvisorRanks`, …);
  `render.ts` renders the out-of-process views. The old modules keep their exported names
  (`SUPPORTED_MODELS`, `MODEL_REASONING_EFFORTS`, `LEGACY_MODEL_UPGRADES`, …) as
  derived views, so call sites did not move.
- `status`: `active` is offered everywhere; `deprecated` is still accepted
  (normalization, efforts) but no longer offered; `retired` ids are not accepted
  and must be some successor's `upgradesFrom`.
- `liveCatalogRequired`: a model whose provider id is not yet verified against an
  account catalog. It is accepted for explicit authoring, but it is not a
  family-latest target (latest-only policy never rewrites to it), not in
  `/v1/models`, not in the Model Class Check table (which lists the policy's
  `latest_models`), and not in the signed `model_catalog.models`. The admin
  catalog marks it `live_catalog_required: true` and the pickers label it
  "(unverified)". It travels in the additive `model_catalog.live_catalog_models`,
  which older wrappers ignore; the launchpad offers it only when the local native
  catalog (`$CODEX_HOME/models_cache.json`) lists the id, and hides it when that
  cache is missing or unreadable. Removing the flag after verification is the
  whole promotion.
- Signed config: `model_catalog.min_cli_versions` (additive) carries every known
  floor, including models the server omitted for an old native CLI, so the
  wrapper no longer needs model names to explain an unavailable selection. The
  Go literals remain only as the fallback for configs without that map.
- Frontend: **generated**, not fetched. `frontend/src/lib/constants/models.generated.ts`
  is written by `api/scripts/generate-model-views.ts` (`npm run models:generate`);
  `models.ts` re-exports it and keeps the sentinels and non-model lists (hooks,
  permission modes, colors, the effort vocabulary). Serving the catalog through an
  API was declined: a dozen components and the e2e
  specs use the lists synchronously at module scope, the host-detail and
  quick-defaults pickers need them before (and without) a query resolving, and
  `GET /admin/model-defaults/:engine` already serves per-model efforts and floors
  where a live answer matters. The contract test
  `api/test/unit/contract/frontend-model-registry.test.ts` fails on drift.
- `docs/model-tiers.md` tier table is rendered by the same script between
  markers; the test fails on drift.

## How to add a model

1. Add an entry to the engine's array in `api/src/services/model-registry/data.ts`
   at its picker position, with the evidence (catalog, version, date) in a comment.
   Copy efforts and default from the native catalog, not from the provider API.
2. If its id is not yet seen in a real account catalog, set
   `liveCatalogRequired: true`. Remove it once verified.
3. If it replaces retired ids, list them in its `upgradesFrom` (this rewrites stored
   selections fleet-wide on next render; say so in the changelog). A new verified
   member of a family also becomes that family's latest-only target: with
   latest-only on, older members resolve to it.
4. `cd api && npm run models:generate` (frontend constants + tier table), then
   `npx vitest run test/unit/services/model-registry.test.ts -u`, review the
   snapshot diff, and regenerate the signed fixtures:
   `UPDATE_GOLDEN=1 npx vitest run test/unit/contract/wrapper-config-golden.test.ts`,
   then adjust the catalog expectations in `assertGoldenCatalog`
   (`wrappers/cxx/internal/config/golden_test.go`) if the signed shape changed.
5. Run the API unit tier, `frontend` `npm run check`, and the Go tests.
