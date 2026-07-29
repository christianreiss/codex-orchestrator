---
title: Settings reference
section: Admin workspace
verified: 2026-07-29
sources: frontend/src/routes/settings/+page.svelte, frontend/src/routes/authoring/+page.svelte, frontend/src/routes/authoring/settings/+page.ts, frontend/src/lib/components/authoring/MattPocockSkillsSource.svelte, frontend/src/lib/api/skillSources.ts, frontend/src/lib/components/settings/ModelDefaultsSection.svelte, frontend/src/lib/components/settings/ClaudeFleetSettings.svelte, frontend/src/lib/components/command-palette/commands.ts, api/src/routes/admin/settings/index.ts, api/src/routes/admin/config/index.ts, api/src/routes/admin/skill-sources/index.ts, api/src/services/mattpocock-skills.ts, api/src/ops/mattpocock-skills-worker.ts, api/src/services/model-defaults.ts, api/src/services/agents.ts, api/src/services/skills.ts, api/src/services/skill-provenance.ts, api/src/services/mcp-resources.ts, api/src/services/memories.ts, api/src/services/client-config.ts, api/src/services/config-normalizer.ts, api/src/services/client-versions.ts, api/src/services/host-auth.ts, api/src/db/migrations/0007_add_skill_provenance.sql, wrappers/cxx/internal/persona/claude/lifecycle/collections.go
---

Configuration in Codex Orchestrator is spread across several distinct routes. This article covers the **Settings page** (`/settings`) and distinguishes it from the separate admin routes that handle users, agents, skills, memories, and projects. A final section documents environment variables that can only be set at deployment time and are not accessible through the admin UI.

All write operations require an authenticated admin session (`app.requireAdmin`). Settings-service mutations publish a `settings.changed` WebSocket event and log an `admin.*` audit row. Saving the Claude fleet editor goes through `ClientConfigService`, publishes the same event for actual config changes, and uses sha256 conflict detection.

---

## The /settings page

The Settings page is split into three URL-addressable tabs:

| Tab | URL | Contents |
|---|---|---|
| **General** | `/settings?tab=general` | API state, auto-update, reverse DNS, insecure approval, prune policy, and log retention. |
| **Codex** | `/settings?tab=codex` | Codex engine, fleet model and effort, Codex version, silent mode, quotas, and usage scaling. |
| **Claude** | `/settings?tab=claude` | Claude engine, fleet model and effort, API proxy defaults, Claude Code version, and the fleet `settings.json` editor. |

A missing or invalid `tab` value opens **General**. The active tab follows browser history, and the panes remain mounted during tab changes so unsaved form input is preserved. Existing section hashes such as `#codex-version` select the matching tab before scrolling. The command palette exposes direct entries for Settings / General, Codex, and Claude.

On wide screens, related settings cards are arranged in two columns; narrow screens keep a single-column flow. Save status appears only while saving or after a save, so idle cards do not reserve an empty status row.

The former `/authoring/settings` route permanently redirects to `/settings?tab=claude#claude-fleet-settings`; it is retained only as a compatibility path for old bookmarks.

### General

#### API state

`GET /admin/api/state`, `POST /admin/api/state` — global API kill-switch. The GET is not gated by the kill-switch itself, so the current state is always readable.

#### Auto-update

`GET /admin/auto-update`, `POST /admin/auto-update` — boolean flag. Fleet default for wrapper and CLI self-update. Individual host rows can override this.

#### Reverse DNS

`GET /admin/reverse-dns`, `POST /admin/reverse-dns` — boolean flag. Controls global reverse-DNS strictness; individual hosts can override via `POST /admin/hosts/{id}/reverse-dns`.

#### Insecure approval

`GET /admin/insecure-approval`, `POST /admin/insecure-approval` — boolean flag. Controls how strictly the insecure activation queue is enforced.

#### Prune policy

`POST /admin/prune-policy` — sets `inactivity_days` (integer 0–60), stored as `inactivity_window_days`. There is no paired GET for this endpoint. The deletion logic for hosts inactive longer than this threshold lives in `HostAuthService.pruneInactiveHosts` (`api/src/services/host-auth.ts`), but as of this verification it is not invoked by any scheduled job or cron — the setting is stored and echoed back on the fleet overview, but nothing currently calls the pruning method automatically. Treat this as a stored policy value rather than an active enforcement mechanism until a caller is wired up.

#### Log retention

`GET /admin/log-retention`, `POST /admin/log-retention` — one boolean and four day-window integers:

| Field | Description |
|---|---|
| `enabled` | Master switch for retention pruning. |
| `days_logs` | Retention window for log rows. |
| `days_mcp` | Retention window for MCP rows. |
| `days_events` | Retention window for event rows. |
| `days_graph_stats` | Retention window for graph-stats rows. |

### Codex

#### Codex engine

`GET /admin/openai/state`, `POST /admin/openai/state` — enable or disable the Codex/OpenAI engine fleet-wide. The API retains its historical `openai` path; the dashboard label is **Codex engine**.

#### Fleet model and effort

`GET /admin/model-defaults/{engine}`, `POST /admin/model-defaults/{engine}` with `engine=codex` — read or set the fleet-wide Codex CLI model together with its model-dependent persistent effort. POST accepts strict `{ model, reasoning_effort? }`; leaving effort unset selects the model default. The canonical config uses Codex's native `model` and `model_reasoning_effort` keys. The default is `gpt-5.6-terra` at `medium`; the endpoint's returned `catalog` supplies the allowed efforts for every model.

| Model | Persistent effort choices | Default |
|---|---|---|
| GPT-5.6 Sol | `low`, `medium`, `high`, `xhigh`, `max`, `ultra` | `medium` |
| GPT-5.6 Terra | `low`, `medium`, `high`, `xhigh`, `max`, `ultra` | `medium` |
| GPT-5.6 Luna | `low`, `medium`, `high`, `xhigh`, `max` | `medium` |
| GPT-5.5, GPT-5.4, GPT-5.4 mini | `low`, `medium`, `high`, `xhigh` | `medium` |
| GPT-5.3 Codex Spark | `low`, `medium`, `high`, `xhigh` | `high` |

#### Codex version

`POST /admin/codex-version` — pin the fleet-wide Codex CLI version to a semver string or `'latest'`. There is no paired GET for this endpoint.

`POST /admin/versions/check` — poll upstream for newer CLI versions (write-only, no GET).

#### Codex silent mode

`GET /admin/cdx-silent`, `POST /admin/cdx-silent` — boolean flag. Baked into the wrapper config so hosts go quiet on next sync.

#### Quotas

`GET /admin/quota-mode`, `POST /admin/quota-mode` — three fields:

| Field | Type | Description |
|---|---|---|
| `week_partition` | string: `'off'` \| `'5'` \| `'7'` | Rolling window length (off, 5-day, or 7-day). |
| `hard_fail` | boolean | Whether exceeding the quota hard-blocks the host. |
| `limit_percent` | integer 50–100 (default 95) | Percentage of the quota ceiling that triggers enforcement. |

#### Scaling

`GET /admin/scaling`, `POST /admin/scaling` — configures `UsageScalingService` rules (`api/src/services/usage-scaling.ts`).

### Claude

#### Claude engine

`GET /admin/claude/state`, `POST /admin/claude/state` — enable or disable the Claude engine fleet-wide.

#### Fleet model and effort

`GET /admin/model-defaults/{engine}`, `POST /admin/model-defaults/{engine}` with `engine=claude` — read or set the fleet-wide Claude Code model and persistent effort. The shared request field is named `reasoning_effort`, but the canonical Claude `settings.json` partial uses the native `model` and `effortLevel` keys.

| Model | Persistent effort choices | Default |
|---|---|---|
| Fable 5 | `low`, `medium`, `high`, `xhigh` | `high` |
| Opus 5 | `low`, `medium`, `high`, `xhigh` | `high` |
| Opus 4.8 | `low`, `medium`, `high`, `xhigh` | `high` |
| Sonnet 5 | `low`, `medium`, `high`, `xhigh` | `high` |
| Opus 4.7 | `low`, `medium`, `high`, `xhigh` | `xhigh` |
| Sonnet 4.6 | `low`, `medium`, `high` | `high` |
| Haiku 4.5 | none | none; `effortLevel` is omitted |

Claude Code documents `low`, `medium`, `high`, and `xhigh` as persistent `settings.json` values; `max` is session-only and is therefore not offered by this fleet control. Unsupported model/effort combinations are rejected rather than silently stored.

On a new installation, GET displays the effective Sonnet 5 / `high` default without writing a config row. The first Save persists the pair; until then Claude hosts inherit Claude Code's own defaults.

#### Claude API defaults

Claude API proxy defaults (default model and max tokens used when proxying Claude API calls) are controlled by a separate endpoint: `GET /admin/claude/settings`, `POST /admin/claude/settings`. Fields:

| Field | Type | Constraints |
|---|---|---|
| `default_model` | string | Must be a supported Claude model; default `claude-sonnet-5`. |
| `max_tokens` | integer | 256–200 000, default 8 192. |

Supported proxy models are `claude-fable-5`, `claude-opus-5`, `claude-opus-4-8`, `claude-sonnet-5`, `claude-opus-4-7`, `claude-sonnet-4-6`, and `claude-haiku-4-5-20251001`.

This endpoint controls only API proxy behaviour. It is independent from the fleet Claude Code `model` / `effortLevel` directly above and does not change managed CLI sessions.

#### Claude version

`GET /admin/claude/version`, `POST /admin/claude/version` — set the fleet-wide pinned Claude CLI version. The POST body is `{ selection }`: either a semver string (e.g. `2.1.170`) or `'latest'`/`'auto'` to clear the pin. There is no separate `locked` boolean in the request; the response reports the resulting `locked_version` and `locked_at`.

#### Fleet settings.json

The editor at `/settings?tab=claude#claude-fleet-settings` builds and publishes the `settings.json` partial delivered to all Claude Code hosts. It is separate from the Claude API proxy defaults above.

**Endpoints:** `GET /admin/claude/config` (read current config) and `POST /admin/claude/config/store` (write). Writes are tracked by sha256 for conflict detection.

**Editable fields:**

| Field | Notes |
|---|---|
| `advisorModel` | Dropdown; marked experimental. Sets `advisorModel` in the delivered settings.json. |
| `env` | Key-value pairs written to the `env` block. |
| `permissionMode` | Dropdown of `CLAUDE_PERMISSION_MODES`; writes `permissions.defaultMode` in the delivered settings.json. Fleet default is `'auto'` (`DEFAULT_CLAUDE_PERMISSION_MODE`) — every managed host auto-approves tool calls unless pinned to `'default'` or another mode. |
| `permissions` | Allow, ask, and deny lists. |
| `statusLine.command` | String; type is fixed to `'command'`. |
| `hooks` | Event → `[{matcher, commands[]}]` map, edited via `HooksEditor`. |

A live read-only preview of the rendered `settings.json` is shown alongside the editor. Saving this editor re-reads and preserves the canonical fleet `model` / `effortLevel`, so an older open form cannot overwrite a model-default change.

---

## Separate admin routes (not part of /settings)

The following areas each live at their own route and are not sub-sections of the Settings page.

### /users — User management

Full CRUD for admin accounts (`api/src/routes/admin/users/index.ts`):

- `GET /admin/users` — list all users.
- `POST /admin/users` — create. Body: `{ username, password, access_level, name, email }`. Minimum password length (12) is enforced by `AdminAuthService.validatePasswordOrThrow`.
- `POST /admin/users/{id}` — update.
- `DELETE /admin/users/{id}` — delete (refuses if this would leave zero active `owner`/`admin` accounts).
- `POST /admin/users/wipe` — delete all users and reopen the first-run flow.

### /authoring/agents — Canonical AGENTS.md

Served to hosts via `POST /agents/retrieve`. Endpoints in `api/src/routes/admin/config/index.ts`:

- `GET /admin/agents` — current active version + version history.
- `GET /admin/agents/versions/{id}` — body of a specific version.
- `POST /admin/agents/store` — save a new version.
- `POST /admin/agents/serve` — pick which version to serve (latest / pinned / none).
- `POST /admin/agents/revert` — revert to an earlier version.
- `POST /admin/agents/retention` — how many old versions to keep.
- `DELETE /admin/agents/versions/{id}` — delete one version.

`AgentsService` (`api/src/services/agents.ts`) reconciles serve mode, latest version, and canonical content hash.

### /authoring/skills — Skills library

Skills are the canonical command library, served over MCP as `skill://{slug}` resources. Endpoints in `api/src/routes/admin/config/index.ts`:

- `GET /admin/skills` — list.
- `GET /admin/skills/{slug}` — skill detail.
- `POST /admin/skills/generate` — request a new draft from the runner.
- `POST /admin/skills/assist` — request targeted edits from the runner.
- `POST /admin/skills/store` — save.
- `DELETE /admin/skills/{slug}` — delete.

#### Optional Matt Pocock source

The source card above the Skills library can import
`https://github.com/mattpocock/skills` through the same canonical Skill system.
It is **off by default** and performs no outbound request while off. This is an
external instruction supply chain: review the linked repository before enabling
it, especially before allowing later upstream changes to reach the fleet.

- **Include in fleet** controls the subscription. Fresh source state defaults
  **Auto-update** on; a preference set while disabled is preserved when the
  source is enabled.
- Re-enabling first validates the retained server cache. A complete cached
  revision is restored without contacting GitHub; a missing, incomplete, or
  damaged cache is fetched again from the immutable upstream SHA.
- **Auto-update** checks every six hours while both switches are on. Turn it off
  to pin the current last-known-good revision.
- **Check now** forces a refresh for an enabled source even when auto-update is
  off.
- The card reports `disabled`, `ok`, or `error`, the upstream plugin version,
  immutable revision, Skill/file counts, check/sync times, and the last error.

The admin API is exact and source-specific:

- `GET /admin/skill-sources/mattpocock` is readable by every authenticated admin
  role and returns
  `{source,repository,ref,enabled,auto_update,status,revision,upstream_version,skill_count,file_count,last_checked_at,last_synced_at,last_error}`.
- `POST /admin/skill-sources/mattpocock` requires owner/admin, accepts a
  non-empty body containing one or both strict booleans
  `{enabled?,auto_update?}`, and returns the same state.
- `POST /admin/skill-sources/mattpocock/refresh` requires owner/admin, accepts
  no body, runs the manual check, and returns the same state on success.

A refresh resolves `main` to an immutable commit SHA, admits exactly the paths
declared by upstream `.claude-plugin/plugin.json` under its two safe Skill roots,
and advances only after every manifest, support file, digest, and the MIT license
notice validate. Failure leaves the previous last-known-good revision served.
Imported detail rows show their source and are read-only in the ordinary editor;
their provenance is `source_type: github:mattpocock/skills`, repository/path/SHA,
and `source_license: MIT`. Each complete bundle includes the upstream root notice
as `LICENSE.mattpocock` (MIT License, Copyright (c) 2026 Matt Pocock).

Codex reads imported manifests at `skill://<slug>` and support files at
`skill://<slug>/<path>`; Skills with upstream
`disable-model-invocation: true` are labelled **Explicit user invocation only**.
Claude receives a native, atomically replaced
`~/.claude/skills/<slug>/` directory through cxx 0.7.3. Before advertising a
cached bundle digest, cxx verifies the exact managed directory tree and every
owned file; missing, modified, symlinked, or unexpected entries withhold the
digest so the next bootstrap self-heals from the canonical bundle. Incoming
content is installed only after manifest, per-file, and recomputed complete
bundle digests match. Invalid cross-slug ownership records are quarantined and
cannot authorize overwrite or pruning. Turning inclusion off immediately
removes the source from the served Codex catalogue and makes Claude prune only
those fleet-owned directories at its next bootstrap. The cached server
rows/files and last-known-good metadata remain for re-enable; unrelated Skills
are untouched.

### /authoring/memories — MCP memories

MCP memories stored by hosts. `GET /admin/mcp/memories` lists everything across the fleet; `DELETE /admin/mcp/memories/{id}` drops a row by id. The read/write surface for hosts is the MCP `memory_*` tools (see [mcp](/admin/manual/mcp)).

### /projects — Projects module

`GET /admin/projects/state` and `POST /admin/projects/state` (`api/src/routes/admin/projects/index.ts`) flip the Projects module on/off. See [projects](/admin/manual/projects) for the full surface.

### Codex config.toml document

The Codex `config.toml` builder. Endpoints in `api/src/routes/admin/config/index.ts`:

- `GET /admin/config` — current canonical config + per-host overrides.
- `POST /admin/config/render` — render a TOML body from a structured form.
- `POST /admin/config/store` — commit a new canonical version served via `POST /config/retrieve`.

`api/src/services/config-normalizer.ts` enforces valid model/reasoning-effort/personality shapes; `ClientConfigService` (`api/src/services/client-config.ts`) materialises the TOML a given host should receive given its overrides.

---

## Environment variables (deployment-time only)

The following variables are read from the process environment at startup. They cannot be changed at runtime through the admin UI. Set them in the deployment environment (Docker env, systemd unit, `.env` file, etc.).

| Variable | Description |
|---|---|
| `ADMIN_ACCESS_MODE` | `'mtls'` \| `'cookie'` \| `'open'` — how admin sessions are authenticated. |
| `ENCRYPTION_ACTIVE_KEY` | Required. Active encryption key for at-rest data. |
| `ENCRYPTION_KEYS`, `ENCRYPTION_ACTIVE_KID` | Key rotation support. |
| `AUTH_RUNNER_URL` + `AUTH_RUNNER_SHARED_SECRET` | Runner integration. |
| `MCP_OPERATOR_TOKEN` | Grants operator capability to MCP callers. |
| `MCP_FS_ROOT` | Enables `fs_*` MCP tools, confined to this directory. |
| `TRUST_X_FORWARDED` | Trust `X-Forwarded-*` headers from a reverse proxy. |
| `TRUSTED_PROXY_CIDRS` | CIDRs allowed to set forwarded headers. |
| `STRICT_HOST_VALIDATION` | Enforce strict hostname validation. |
| `DEFAULT_HOST_ENGINES` | Default engine set for new hosts (default: `'codex'`). |
| `SMTP_*` | Email delivery configuration. |
| `GPT51_*_PER_1K`, `CLAUDE_*_PER_1K` | Per-token pricing overrides for usage accounting. |
| `PRICING_URL`, `PRICING_CURRENCY` | External pricing source and currency. |
| `ADMIN_WEBAUTHN_RP_ID`, `ADMIN_WEBAUTHN_ORIGIN` | WebAuthn passkey login configuration. |
| `PUBLIC_BASE_URL`, `CODEX_SYNC_BASE_URL` | Public-facing URL roots. |
| `INSTALLATION_ID`, `DATA_ROOT` | Instance identity and data directory. |

---

## Source references

- `frontend/src/routes/settings/+page.svelte` — tab routing, section placement, hash compatibility
- `frontend/src/routes/authoring/settings/+page.ts` — legacy redirect to the Claude fleet editor
- `frontend/src/lib/components/settings/ClaudeFleetSettings.svelte` — fleet `settings.json` editor
- `frontend/src/lib/components/command-palette/commands.ts` — direct Settings tab commands
- `api/src/routes/admin/settings/index.ts` — all /settings page endpoints
- `api/src/services/model-defaults.ts` — engine catalogs and model/effort persistence
- `api/src/routes/admin/config/index.ts` — agents, skills, memories, profile builder, fleet Claude config
- `api/src/routes/admin/users/index.ts`
- `api/src/routes/admin/projects/index.ts`
- `api/src/services/agents.ts`
- `api/src/services/skills.ts`, `api/src/services/skill-drafts.ts`, `api/src/services/skill-manifest.ts`
- `api/src/services/memories.ts`, `api/src/services/mcp-memories.ts`
- `api/src/services/client-config.ts`, `api/src/services/config-normalizer.ts`
- `api/src/services/client-versions.ts` — version lock read/write shape (no `locked` request field)
- `api/src/services/host-auth.ts` — `pruneInactiveHosts`; confirms the prune-policy setting has no scheduled caller
- `api/src/services/usage-scaling.ts`
