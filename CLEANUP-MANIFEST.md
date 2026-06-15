# CLEANUP-MANIFEST.md

Once-in-a-lifetime cleanup of `codex-orchestrator`. Source of truth for this effort.
Driven via `/goal`. **Never push.** Per-item: code → test → scoped commit. Keep
`CLAUDE_MODELS` ↔ `CLAUDE_SUPPORTED_MODELS` lock-step. Never hand-edit `public/admin/**`.

## Definition of Done (user-set, 2026-06-15)

> Zero tool-proven dead code; every unfinished stub finalized or explicitly
> documented-as-intentional; every model/version picker driven by one shared
> `<ModelSelect>` bound to the central model constants — with the full
> typecheck · test · build · check · vet matrix green across `api/`, `frontend/`,
> and both wrappers, the docs in lock-step, `CHANGELOG.md` updated.

## Baseline (2026-06-15, before any change) — ALL GREEN

| Tree | typecheck | test | check | vet | build |
|---|---|---|---|---|---|
| api | ✓ tsc 0 | ✓ 649 pass / 1 skip | — | — | (defer) |
| frontend | — | — | ✓ 0 err 0 warn | — | (defer) |
| wrappers/cdx | — | ✓ go test ok | — | ✓ | n/a |
| wrappers/clx | — | ✓ go test ok | — | ✓ | n/a |

## PROTECTED — never remove / never "finalize" (verbatim from mission)

1. **embeddings 501s** — `v1/index.ts:161-172`, `anthropic-v1/index.ts:244-256`. Intentional 501, documented `interface-api.md:21,28`.
2. **legacy `/wrapper/download`** — `services/wrapper-transition.ts` (`legacyWrapperDownloadUrl`), mounted `wrapper-v2/index.ts:195`.
3. **`sbox:v1` back-compat** — `security/secret-box.ts:13-47`.
4. **release-gated `TODO.md` drops** — entire file; still references pre-rewrite PHP symbols. Out of scope.

Also keep (engine-parity, documented intentional deltas — AGENTS.md:27-39):
`/v1/responses` & `/anthropic/v1/responses` `stream:true`→400; clx `ReasoningEffort` (auth.go:61, no-op wire field); clx `Lane` (informational); clx unwired quota subsystem (`quota.go`, parts of `ansi.go`/`format.go`) — parity stub, NOT dead.

---

## DECISIONS (resolved 2026-06-15)

- **D1 — AI-draft endpoints → FINALIZE THE WIRING.** Add `runner`/`runnerValidation`
  to `RouteContext` (`routes/index.ts:28-32`), instantiate `RunnerClient` +
  `RunnerValidationService` in `server.ts`, thread into `ProjectDraftsService`
  (`admin/projects/index.ts:53`) + `SkillDraftsService` (`admin/config/index.ts:66`).
  Restores the documented feature (`docs/API.md:368`). Runner methods + sidecar built.
- **D2 — `<ModelSelect>` scope → MODELS ONLY.** Version pickers (latest/exact + semver
  + live query, no central constant) stay as their own control, untouched.

## DECIDED DEFAULTS (proceeding without asking; reversible/low-risk)

- **Model-list drift fix** (3-way): frontend `models.ts` (`opus-4-6`) vs
  `claude-models.ts` `CLAUDE_SUPPORTED_MODELS` (`opus-4-7`, **the runtime 400 gate**)
  vs `config-normalizer.ts` (`opus-4-6`). → Align frontend + `config-normalizer`
  to **`claude-models.ts` (the gate)**; do NOT touch the gate/`/models` contract;
  do NOT invent `claude-opus-4-8` (advertising a new model = contract change → follow-up).
  This achieves the lock-step guardrail without changing the accepted-model set.
- **Free-text override/default fields** (per-host Claude/Codex override, fleet
  `default_model`): convert to `<ModelSelect allowCustom>` (combobox) — preserves
  the intentional "pass-through so wrappers self-test newer models" capability.
- **Advisor picker**: fold into `<ModelSelect variant="advisor">` (tier-alias list).
- **Engine selectors** (`NewKeyDialog`, `SeedAuthDialog`): out of scope, leave.
- **Codex default-model field** missing from `OpenAIEngineSection`: parity gap, not
  consolidation → note only, don't add.
- **Dead-code judgment items**: remove unless concrete evidence of intentional API
  surface (documented / public entry / referenced in docs); decide per-item, record.

---

## PILLAR 1 — Stubs (finalize OR document-as-intentional)

- [ ] **D1 cluster** *(opus)* — pending D1. If finalize: add `runner`+`runnerValidation`
      to `RouteContext` (`routes/index.ts:28`), instantiate in `server.ts:64`, thread
      into the two draft factories. If document: doc-note + align `docs/API.md:368`.
- [ ] **501/503 comment nit** *(sonnet)* — `project-drafts.ts:5` & `skill-drafts.ts:7`
      say "501" but code throws 503. One-word doc fix (do with D1).
- [x] INTENTIONAL (all already documented, no action): responses-stream×2, clx
      `ReasoningEffort`, clx `Lane`. Verified.

## PILLAR 2 — Dead code (tool-proven) — **EXECUTE LAST**

> Sequencing: stubs + UX land first (they change the dead set), THEN re-run
> `knip`/`deadcode`, remove, loop until dry. Inventory below is provisional.
> Rule: remove only flagged-AND-grep-confirmed-zero-reference. Remove cascades together.

### api — files *(opus: dev-utils & test seam)*
- [ ] `scripts/boot-listen.ts`, `scripts/smoke.ts` — manual dev utils, unwired. Judge keep/remove.
- [ ] `test/helpers/seed.ts` + `test/helpers/factories/index.ts` + 13 factory files
      (`admin-sessions, admin-users, agents-documents, auth-payloads, cli-auth-requests,
      client-config-documents, coord-projects, hosts, insecure-requests, mcp-memories,
      openai-api-keys, skills, versions`) — orphaned cluster (vitest config has no
      setupFiles). Cascade: `resetDbRaw` (`test-db.ts:146`) dies with it.

### api — deps
- [ ] `uuid` *(sonnet)*, `pino-http` *(sonnet)*, `smol-toml` *(opus: confirm no runtime TOML parse)*
- [ ] **package.json hygiene** *(sonnet)*: add unlisted-but-used `fastify-plugin`,
      `@eslint/js`, `@simplewebauthn/types`. Keep `pino-pretty` (string transport),
      `libsodium`/`@types/*` (transitive backers).

### api — unused exports *(sonnet unless noted)*
- [ ] `getFormatter` (envelope/select.ts:43), `RATE_DEFAULTS` (rate-limit.ts:117),
      `pingEvent` (anthropic-sse.ts:141), `constantTimeEqualHex/Bytes`+`randomBase64Url`
      (security/hash.ts), `isConfigured` (runner-openai.ts:112), `AGENTS_BACKUP_LIMIT_DEFAULT`
      (agents.ts:25), `isArtifactKind`+`listKeysForKind` (claude-frontmatter.ts),
      `assertSha256` (config-normalizer.ts:418), `agentsDocumentName` (engine.ts:14),
      `createLogger` (log.ts:36), `nowIsoMillis` (timestamp.ts:10),
      `SkillEventType/MemoryEventType/ApiKeyEventType` (ws-bridge.ts:20-22),
      db-fake.ts:108 re-export line, test-db.ts seams `skipUnlessDb/useTestDbLifecycle/guardTestDb/test` *(opus)*.
- [ ] *(opus judgment)* `fail` (reply.ts:24, sibling of `ok`), `clampInsecureWindow`
      (insecure-window.ts:187, wrapper over `clampWindow`), `publishUserEvent/ProjectEvent/SettingsChanged/Event`
      (ws-bridge.ts:47-81, verified no dynamic dispatch).

### frontend — files / deps *(sonnet)*
- [ ] `components/projects/ProjectStatStrip.svelte`; `components/ui/scroll-area/{index.ts,scroll-area.svelte}`
- [ ] deps: `@tanstack/svelte-table`, `svelte-chartjs`; `sveltekit-superforms` *(opus: confirm no lazy load)*

### frontend — unused exports
- [ ] *(opus, cascades)* `createAuthStatusQuery` (api/users.ts:62 → `AUTH_STATUS_QUERY_KEY`+`fetchAuthStatus`),
      `claudeVersionQuery` (api/usage.ts:121 → `usageKeys.claudeVersion`+`ClaudeVersionResponse`).
- [ ] *(opus: possible extension API — eyeball)* `registerCommandSource`+`collectCommands`
      (command-palette/commands.ts:91,489); `extendInvalidations` (ws/events.ts:188).
- [ ] *(sonnet)* `themeStore`/`resolvedMode` (stores/theme.ts:83,107), `optionalPasswordSchema`
      (userSchema.ts:28), unused types in api/types.ts (`LogEntry, ApiKey, UsageSnapshot,
      OkEnvelope, ErrorEnvelope, OpenAIErrorEnvelope, AnthropicErrorEnvelope, ClaudeArtifactKind,
      ClaudeVersionValue`), `CreateUserInput/EditUserInput` (userSchema.ts), `HookEvent` (models.ts:72).

### wrappers (Go) — dead in BOTH cdx & clx *(sonnet)*
- [ ] `PadLeft` (ui/ansi.go), `Row` (ui/banner.go), `DurationLong`+`plural` (ui/format.go),
      `RelativeIso` (ui/format.go), `SecondsSinceIso` (ui/format.go).
- [ ] *(opus)* cdx-only: `LatestVersion` (codex/installer.go:344 — update path), `nowStamp`
      var (ui/screen.go:203 — claims test seam but no test uses it).
- Out of scope (live-code lint smells, not dead): clx `digest` SA4006, ST1008 in run.go.

### knip config (durable) *(opus)*
- [ ] Commit `api/knip.json` + `frontend/knip.json` (entry points + `ignoreExportsUsedInFile`)
      so the dead set is reproducible. Collapses the ~86 "used-internally over-export"
      and the ~140 shadcn namespace-barrel false positives.

## PILLAR 3 — UX: shared `<ModelSelect>`

- [ ] *(opus)* Resolve model-list drift per DECIDED DEFAULT (align frontend +
      config-normalizer to `claude-models.ts`); fix the misleading lock-step comment;
      add frontend `CODEX_MODELS` mirroring backend `SUPPORTED_MODELS` (for engine="codex").
- [ ] *(opus)* Build `frontend/src/lib/components/ui/model-select/` — props:
      `value, onValueChange, engine?, variant?(model|advisor), options?, allowCustom?,
      inheritSentinel?, id?, label!(a11y), placeholder?, disabled?`. Thin wrapper over
      `ui/select`. **Never emit ""** (keep non-empty `inherit`/`off` sentinels — bits-ui bug).
- [ ] *(sonnet)* Roll out the 4 constant-bound dropdowns: `authoring/settings:178`(model),
      `authoring/settings:200`(advisor), `authoring/subagents/[name]:163`, `authoring/commands/[name]:164`.
- [ ] *(opus)* Convert free-text sites (allowCustom): `hosts/[id]:568`(claude),
      `hosts/[id]:558`(codex), `settings/ClaudeEngineSection:97`(fleet default) — pending D2.
- Version pickers (`ClaudeVersionSection`, `CodexVersionSection`, per-host version
  `InputDialog`s): out of scope unless D2 says otherwise.

## PILLAR 4 — Docs + CHANGELOG (lock-step, per change)

- [ ] Update `docs/interface-*.md` / `docs/API.md` / dashboard copy as behavior changes.
- [ ] `CHANGELOG.md` newest-date-first for every human-visible change.
- [ ] Reconcile model-list lock-step comment in `models.ts`.

## VERIFY (final)

`cd api && npm run typecheck && npm test && npm run build` ·
`cd frontend && npm run check && npm run build` ·
`go vet ./... && go test ./...` in each wrapper.
