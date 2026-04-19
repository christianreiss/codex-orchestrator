---
title: Settings reference
section: Admin workspace
verified: 2026-04-19
sources: src/Http/Controllers/AdminSettingsController.php, src/Http/Controllers/AdminConfigController.php, src/Http/Controllers/AdminOpenAiKeyController.php, src/Http/Controllers/AdminClaudeKeyController.php, src/Http/Controllers/AdminJoplinController.php, src/Services/AgentsService.php, src/Services/SkillService.php, src/Services/MemoryService.php, src/Services/ProjectModuleService.php, src/Services/JoplinService.php, src/Services/ClientConfigService.php, src/Services/TomlRenderer.php, public/admin/index.html
---

Settings is grouped into four rail sections in `public/admin/index.html` (Admin, Authoring, Workspace, Integrations). Each tab maps onto one or more API endpoints registered in `public/index.php`. All write operations require `settings.manage`.

## Admin → General

Drives fleet-wide toggles on `VersionRepository`. The surface is spread across `AdminSettingsController`:

- **Auto-update** — `GET /admin/auto-update`, `POST /admin/auto-update` (`getAutoUpdate`, `postAutoUpdate`). Fleet default for wrapper and CLI self-update. Hosts can override per row.
- **Reverse DNS** — `GET /admin/reverse-dns`, `POST /admin/reverse-dns`. Global strictness; individual hosts can override via `AdminHostController::reverseDns`.
- **Theme** — `GET /admin/theme`, `POST /admin/theme` (`getTheme`, `postTheme`). One of `auto`, `light`, `dark`, `auto-pink`, `bright-pink`, `dark-pink`.
- **CDX / CLX silent** — `GET /admin/cdx-silent`, `POST /admin/cdx-silent` toggles. Baked into the wrapper templates so hosts go quiet on next sync.
- **Quota mode** — `GET /admin/quota-mode`, `POST /admin/quota-mode`. Picks one of the partition modes — off, 5-day, or 7-day — declared as constants on `AuthService` (`QUOTA_WEEK_PARTITION_OFF/_FIVE_DAY/_SEVEN_DAY`).
- **Insecure approval policy** — `GET /admin/insecure-approval`, `POST /admin/insecure-approval`. How strict the insecure activation queue is.
- **Prune policy** — `POST /admin/prune-policy` controls how stale a host may get before the preflight deletes it.
- **Log retention** — `GET /admin/log-retention`, `POST /admin/log-retention` controls per-table retention windows.
- **Scaling** — `GET /admin/scaling`, `POST /admin/scaling` enables `UsageScalingService`.

## Admin → Users

Handled by `AdminUserController` (requires `users.manage`):

- `GET /admin/users` — list.
- `POST /admin/users` — create. Body: `{username, password, access_level, display_name, email}`. `AdminAuthService::validatePassword()` enforces `ADMIN_PASSWORD_MIN_LENGTH`.
- `POST /admin/users/{id}` — update.
- `DELETE /admin/users/{id}` — delete (refuses if this would leave zero admins).
- `POST /admin/users/wipe` — delete everything. Nuclear. Re-opens the first-run flow.

## Admin → Agents

Canonical `AGENTS.md`, served to hosts via `POST /agents/retrieve`. Handled by `AdminConfigController`:

- `GET /admin/agents` (`agents`) — current active version + version history.
- `GET /admin/agents/versions/{id}` (`agentsVersion`) — a specific version's body.
- `POST /admin/agents/store` (`agentsStore`) — save a new version.
- `POST /admin/agents/serve` (`agentsServe`) — pick which version to serve (latest / pinned / none).
- `POST /admin/agents/revert` (`agentsRevert`) — revert to an earlier version.
- `POST /admin/agents/retention` (`agentsRetention`) — how many old versions to keep.
- `DELETE /admin/agents/versions/{id}` (`agentsDeleteVersion`) — delete one version.

`AgentsService::adminFetch()` is where the backend reconciles serve mode, latest, and canonical-content-hash.

## Admin → OpenAI

Controls the Codex-side API state:

- API enabled — `GET /admin/openai/state`, `POST /admin/openai/state` (handled in `AdminSettingsController`).
- API keys — `AdminOpenAiKeyController` exposes `GET /admin/openai/keys`, `POST /admin/openai/keys`, `POST /admin/openai/keys/{id}/toggle`, `DELETE /admin/openai/keys/{id}`.
- Claude API disabled flag mirrors in `AdminSettingsController::getApiState/postApiState` (the shared "API disabled" kill switches).

## Admin → Claude

- State — `GET /admin/claude/state`, `POST /admin/claude/state` (`getClaudeApiState`, `postClaudeApiState`).
- Settings — `GET /admin/claude/settings`, `POST /admin/claude/settings` (model default, fallback, `settings.json` defaults that ship to Claude hosts).
- Version — `GET /admin/claude/version`, `POST /admin/claude/version` sets the fleet-wide pinned Claude CLI version.
- API keys — `AdminClaudeKeyController` mirrors the OpenAI key endpoints at `/admin/claude/keys`.
- Usage history — `GET /admin/claude/usage/history` feeds the dashboard card.

## Admin → API keys

The `sk-coco-*` keys third-party tools use to call the OpenAI- and Anthropic-compatible endpoints. Managed by `AdminOpenAiKeyController` and `AdminClaudeKeyController` (same CRUD shape as above). Generated keys are shown once at creation; the server stores only hashes afterwards.

## Authoring → Skills

Skills are the canonical command library, served over MCP as `skill://{slug}` resources. Handled by `AdminConfigController`:

- `GET /admin/skills` — list.
- `GET /admin/skills/{slug}` — skill detail (browser gets the SPA; JSON gets the raw manifest).
- `POST /admin/skills/generate` (`skillGenerate`) — ask the runner for a new draft.
- `POST /admin/skills/assist` (`skillAssist`) — ask the runner for targeted edits.
- `POST /admin/skills/store` (`skillStore`) — save.
- `DELETE /admin/skills/{slug}` (`skillDelete`).

Under the hood the AI assist paths call `RunnerVerifier::generateSkillDraft()` / `assistSkillDraft()`. Skill bodies are hashed so hosts only re-fetch the ones that changed.

## Authoring → Memories

MCP memories stored by hosts. `AdminConfigController::memories` lists everything across the fleet; `memoriesDelete` drops a row by id. The read/write surface for hosts is `/mcp/memories/*` under `ProjectApiController` (see [mcp](/admin/manual/mcp)).

## Workspace → Projects

`AdminConfigController::projectsModuleState` / `projectsModuleToggle` (via `AdminProjectController::state/stateUpdate`) flips the Projects module on/off. Managed entries then come from `AdminProjectController`. See [projects](/admin/manual/projects) for the full surface.

## Workspace → Profiles

The Codex `config.toml` builder. Handled by `AdminConfigController`:

- `GET /admin/config` — current canonical config + per-host overrides.
- `POST /admin/config/render` (`configRender`) — render a TOML body from a structured form (uses `TomlRenderer`).
- `POST /admin/config/store` (`configStore`) — commit a new canonical version served via `POST /config/retrieve`.

`ConfigNormalizer` enforces valid shapes; `ClientConfigService` is what actually materialises the TOML a given host should get given its overrides.

## Integrations → Joplin

Optional Joplin integration for storing notes/skills. `AdminJoplinController`:

- `GET /admin/joplin/config`, `POST /admin/joplin/config` (`getConfig`, `postConfig`).
- `POST /admin/joplin/test` (`postTest`) — verify the token and endpoint.
- `POST /admin/joplin/sync` (`postSync`) — force a sync now.

When Joplin is enabled, the MCP server exposes `joplin_*` tools (see [mcp](/admin/manual/mcp)).

## Runner controls (Admin → General helpers)

- `POST /admin/runner/run` — probe the Codex runner.
- `POST /admin/runner/run-claude` — probe the Claude runner.
- `POST /admin/auth/upload` — upload a new canonical auth.
- `POST /admin/auth/seed-command` — mint a seed-auth token.

All of these are on `AdminOverviewController` and require `settings.manage`.

## Source references

- src/Http/Controllers/AdminSettingsController.php (general toggles, quota, retention, OpenAI/Claude state)
- src/Http/Controllers/AdminConfigController.php (agents, skills, memories, profile builder)
- src/Http/Controllers/AdminOpenAiKeyController.php, src/Http/Controllers/AdminClaudeKeyController.php
- src/Http/Controllers/AdminJoplinController.php
- src/Services/AgentsService.php (serve mode, versions)
- src/Services/SkillService.php, src/Services/SkillDraftService.php, src/Services/SkillManifestService.php
- src/Services/MemoryService.php
- src/Services/ProjectModuleService.php
- src/Services/JoplinService.php, src/Services/JoplinSkillService.php
- src/Services/ClientConfigService.php, src/Services/TomlRenderer.php, src/Services/ConfigNormalizer.php
- public/admin/index.html (rail sections for each settings tab)
