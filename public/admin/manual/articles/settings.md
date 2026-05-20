---
title: Settings reference
section: Admin workspace
verified: 2026-05-20
sources: api/src/routes/admin/settings/index.ts, api/src/routes/admin/config/index.ts, api/src/routes/admin/keys/openai.ts, api/src/routes/admin/keys/claude.ts, api/src/services/agents.ts, api/src/services/skills.ts, api/src/services/memories.ts, api/src/services/client-config.ts, api/src/services/config-normalizer.ts
---

Settings is grouped into rail sections (Admin, Authoring, Workspace). Each tab maps onto one or more API endpoints registered under `api/src/routes/admin/`. All write operations require an authenticated admin session (`app.requireAdmin`).

## Admin → General

Drives fleet-wide toggles backed by rows in `versions`. Endpoints (`api/src/routes/admin/settings/index.ts`):

- **Auto-update** — `GET /admin/auto-update`, `POST /admin/auto-update`. Fleet default for wrapper and CLI self-update. Hosts can override per row.
- **Reverse DNS** — `GET /admin/reverse-dns`, `POST /admin/reverse-dns`. Global strictness; individual hosts override via `POST /admin/hosts/{id}/reverse-dns`.
- **Theme** — `GET /admin/theme`, `POST /admin/theme`. One of `auto`, `light`, `dark`, `auto-pink`, `bright-pink`, `dark-pink`.
- **CDX silent** — `GET /admin/cdx-silent`, `POST /admin/cdx-silent`. Baked into the wrapper config so hosts go quiet on next sync.
- **Quota mode** — `GET /admin/quota-mode`, `POST /admin/quota-mode`. Picks one of the partition modes (off / 5-day / 7-day).
- **Insecure approval policy** — `GET /admin/insecure-approval`, `POST /admin/insecure-approval`. How strict the insecure activation queue is.
- **Prune policy** — `POST /admin/prune-policy`. How stale a host may get before the preflight deletes it.
- **Log retention** — `GET /admin/log-retention`, `POST /admin/log-retention`. Per-table retention windows.
- **Scaling** — `GET /admin/scaling`, `POST /admin/scaling`. Enables `UsageScalingService` (`api/src/services/usage-scaling.ts`).
- **Codex version** — `POST /admin/codex-version` pins the fleet-wide Codex CLI version.
- **Versions check** — `POST /admin/versions/check` polls upstream for newer CLI versions.

## Admin → Users

Handled by `api/src/routes/admin/users/index.ts`:

- `GET /admin/users` — list.
- `POST /admin/users` — create. Body: `{ username, password, access_level, name, email }`. The minimum password length (12) is enforced by `AdminAuthService.validatePasswordOrThrow`.
- `POST /admin/users/{id}` — update.
- `DELETE /admin/users/{id}` — delete (refuses if this would leave zero active `owner`/`admin`).
- `POST /admin/users/wipe` — delete everything. Nuclear. Re-opens the first-run flow.

## Admin → Agents

Canonical `AGENTS.md`, served to hosts via `POST /agents/retrieve`. Endpoints in `api/src/routes/admin/config/index.ts`:

- `GET /admin/agents` — current active version + version history.
- `GET /admin/agents/versions/{id}` — a specific version's body.
- `POST /admin/agents/store` — save a new version.
- `POST /admin/agents/serve` — pick which version to serve (latest / pinned / none).
- `POST /admin/agents/revert` — revert to an earlier version.
- `POST /admin/agents/retention` — how many old versions to keep.
- `DELETE /admin/agents/versions/{id}` — delete one version.

`AgentsService` (`api/src/services/agents.ts`) reconciles serve mode, latest, and canonical-content-hash.

## Admin → OpenAI

Controls the Codex-side API state:

- API enabled — `GET /admin/openai/state`, `POST /admin/openai/state` (and the shared `/admin/api/state` mirror in `api/src/routes/admin/settings/index.ts`).
- API keys — `api/src/routes/admin/keys/openai.ts` exposes `GET /admin/openai/keys`, `POST /admin/openai/keys`, `POST /admin/openai/keys/{id}/toggle`, `DELETE /admin/openai/keys/{id}`.

## Admin → Claude

- State — `GET /admin/claude/state`, `POST /admin/claude/state`.
- Settings — `GET /admin/claude/settings`, `POST /admin/claude/settings` (model default, fallback, `settings.json` defaults that ship to Claude hosts).
- Version — `GET /admin/claude/version`, `POST /admin/claude/version` sets the fleet-wide pinned Claude CLI version.
- API keys — `api/src/routes/admin/keys/claude.ts` mirrors the OpenAI key endpoints at `/admin/claude/keys`.
- Usage history — `GET /admin/claude/usage/history` feeds the dashboard card.

## Admin → API keys

The `sk-coco-*` keys third-party tools use to call the OpenAI- and Anthropic-compatible endpoints. Managed by the same OpenAI and Claude key controllers above (same CRUD shape). Generated keys are shown once at creation; the server stores only hashes afterwards.

## Authoring → Skills

Skills are the canonical command library, served over MCP as `skill://{slug}` resources. Endpoints in `api/src/routes/admin/config/index.ts`:

- `GET /admin/skills` — list.
- `GET /admin/skills/{slug}` — skill detail.
- `POST /admin/skills/generate` — ask the runner for a new draft.
- `POST /admin/skills/assist` — ask the runner for targeted edits.
- `POST /admin/skills/store` — save.
- `DELETE /admin/skills/{slug}` — delete.

The assist paths call the runner via `runner-client.ts` / `skill-drafts.ts`. Skill bodies are hashed so hosts only re-fetch the ones that changed.

## Authoring → Memories

MCP memories stored by hosts. `GET /admin/mcp/memories` lists everything across the fleet; `DELETE /admin/mcp/memories/{id}` drops a row by id. The read/write surface for hosts is the MCP `memory_*` tools (see [mcp](/admin/manual/mcp)).

## Workspace → Projects

`GET /admin/projects/state` and `POST /admin/projects/state` (`api/src/routes/admin/projects/index.ts`) flip the Projects module on/off. Managed entries then come from the same module. See [projects](/admin/manual/projects) for the full surface.

## Workspace → Profiles

The Codex `config.toml` builder. Endpoints in `api/src/routes/admin/config/index.ts`:

- `GET /admin/config` — current canonical config + per-host overrides.
- `POST /admin/config/render` — render a TOML body from a structured form.
- `POST /admin/config/store` — commit a new canonical version served via `POST /config/retrieve`.

`api/src/services/config-normalizer.ts` enforces valid model / reasoning-effort / personality shapes; `ClientConfigService` (`api/src/services/client-config.ts`) materialises the TOML a given host should receive given its overrides.

## Runner controls (Admin → General helpers)

- `POST /admin/runner/run` — probe the Codex runner.
- `POST /admin/runner/run-claude` — probe the Claude runner.
- `POST /admin/auth/upload` — upload a new canonical auth.
- `POST /admin/auth/seed-command` — mint a seed-auth token.

All four live in `api/src/routes/admin/overview/index.ts` and require `app.requireAdmin`.

## Source references

- api/src/routes/admin/settings/index.ts (general toggles, quota, retention, OpenAI/Claude state)
- api/src/routes/admin/config/index.ts (agents, skills, memories, profile builder)
- api/src/routes/admin/keys/openai.ts, api/src/routes/admin/keys/claude.ts
- api/src/services/agents.ts (serve mode, versions)
- api/src/services/skills.ts, api/src/services/skill-drafts.ts, api/src/services/skill-manifest.ts
- api/src/services/memories.ts, api/src/services/mcp-memories.ts
- api/src/services/client-config.ts, api/src/services/config-normalizer.ts
- api/src/services/usage-scaling.ts
