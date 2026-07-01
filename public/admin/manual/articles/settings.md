---
title: Settings reference
section: Admin workspace
verified: 2026-07-01
sources: api/src/routes/admin/settings/index.ts, api/src/routes/admin/config/index.ts, api/src/services/agents.ts, api/src/services/skills.ts, api/src/services/memories.ts, api/src/services/client-config.ts, api/src/services/config-normalizer.ts, api/src/services/client-versions.ts, api/src/services/host-auth.ts
---

Configuration in Codex Orchestrator is spread across several distinct routes. This article covers the **Settings page** (`/settings`) and distinguishes it from the separate admin routes that handle users, agents, skills, memories, projects, and fleet Claude settings. A final section documents environment variables that can only be set at deployment time and are not accessible through the admin UI.

All write operations require an authenticated admin session (`app.requireAdmin`). Every write on the Settings page publishes a `settings.changed` WebSocket event and logs an `admin.*` audit row.

---

## The /settings page

The Settings page is a single flat page with a sticky table-of-contents sidebar (`SettingsTocNav`). There are no tabs or sub-sections; all controls are rendered inline in a fixed order. The page covers exactly the following sections.

### API state

`GET /admin/api/state`, `POST /admin/api/state` — global kill-switch for the Codex API. The GET is not gated by the kill-switch itself, so the current state is always readable.

### OpenAI engine

`GET /admin/openai/state`, `POST /admin/openai/state` — enable or disable the OpenAI engine fleet-wide.

### Claude engine

`GET /admin/claude/state`, `POST /admin/claude/state` — enable or disable the Claude engine fleet-wide.

### Reverse DNS

`GET /admin/reverse-dns`, `POST /admin/reverse-dns` — boolean flag. Controls global reverse-DNS strictness; individual hosts can override via `POST /admin/hosts/{id}/reverse-dns`.

### Auto-update

`GET /admin/auto-update`, `POST /admin/auto-update` — boolean flag. Fleet default for wrapper and CLI self-update. Individual host rows can override this.

### CDX silent mode

`GET /admin/cdx-silent`, `POST /admin/cdx-silent` — boolean flag. Baked into the wrapper config so hosts go quiet on next sync.

### Insecure approval

`GET /admin/insecure-approval`, `POST /admin/insecure-approval` — boolean flag. Controls how strictly the insecure activation queue is enforced.

### Quotas

`GET /admin/quota-mode`, `POST /admin/quota-mode` — three fields:

| Field | Type | Description |
|---|---|---|
| `week_partition` | string: `'off'` \| `'5'` \| `'7'` | Rolling window length (off, 5-day, or 7-day). |
| `hard_fail` | boolean | Whether exceeding the quota hard-blocks the host. |
| `limit_percent` | integer 50–100 (default 95) | Percentage of the quota ceiling that triggers enforcement. |

### Codex version

`POST /admin/codex-version` — pin the fleet-wide Codex CLI version to a semver string or `'latest'`. There is no paired GET for this endpoint.

`POST /admin/versions/check` — poll upstream for newer CLI versions (write-only, no GET).

### Claude version

`GET /admin/claude/version`, `POST /admin/claude/version` — set the fleet-wide pinned Claude CLI version. The POST body is `{ selection }`: either a semver string (e.g. `2.1.170`) or `'latest'`/`'auto'` to clear the pin. There is no separate `locked` boolean in the request; the response reports the resulting `locked_version` and `locked_at`.

Claude API proxy defaults (default model and max tokens used when proxying Claude API calls) are controlled by a separate endpoint: `GET /admin/claude/settings`, `POST /admin/claude/settings`. Fields:

| Field | Type | Constraints |
|---|---|---|
| `default_model` | string | Must match the `claude-*` regex. |
| `max_tokens` | integer | 256–200 000, default 8 192. |

Note: this endpoint controls only the API proxy behaviour. Fleet-wide Claude CLI settings (model, env, permissions, hooks, etc.) are managed on the separate Authoring → Settings route described below.

### Scaling

`GET /admin/scaling`, `POST /admin/scaling` — configures `UsageScalingService` rules (`api/src/services/usage-scaling.ts`).

### Prune policy

`POST /admin/prune-policy` — sets `inactivity_days` (integer 0–60), stored as `inactivity_window_days`. There is no paired GET for this endpoint. The deletion logic for hosts inactive longer than this threshold lives in `HostAuthService.pruneInactiveHosts` (`api/src/services/host-auth.ts`), but as of this verification it is not invoked by any scheduled job or cron — the setting is stored and echoed back on the fleet overview, but nothing currently calls the pruning method automatically. Treat this as a stored policy value rather than an active enforcement mechanism until a caller is wired up.

### Log retention

`GET /admin/log-retention`, `POST /admin/log-retention` — one boolean and four day-window integers:

| Field | Description |
|---|---|
| `enabled` | Master switch for retention pruning. |
| `days_logs` | Retention window for log rows. |
| `days_mcp` | Retention window for MCP rows. |
| `days_events` | Retention window for event rows. |
| `days_graph_stats` | Retention window for graph-stats rows. |

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

### /authoring/memories — MCP memories

MCP memories stored by hosts. `GET /admin/mcp/memories` lists everything across the fleet; `DELETE /admin/mcp/memories/{id}` drops a row by id. The read/write surface for hosts is the MCP `memory_*` tools (see [mcp](/admin/manual/mcp)).

### /projects — Projects module

`GET /admin/projects/state` and `POST /admin/projects/state` (`api/src/routes/admin/projects/index.ts`) flip the Projects module on/off. See [projects](/admin/manual/projects) for the full surface.

### /authoring/settings — Fleet Claude settings.json

This page builds and publishes the `settings.json` delivered to all Claude CLI hosts. It is entirely separate from the `/settings` page and from the `/admin/claude/settings` API proxy endpoint.

**Endpoints:** `GET /admin/claude/config` (read current config) and `POST /admin/claude/config/store` (write). Writes are tracked by sha256 for conflict detection.

**Editable fields:**

| Field | Notes |
|---|---|
| `model` | Dropdown from `CLAUDE_MODELS`; select `inherit` to leave unset. |
| `advisorModel` | Dropdown; marked experimental. Sets `advisorModel` in the delivered settings.json. |
| `env` | Key-value pairs written to the `env` block. |
| `permissionMode` | Dropdown of `CLAUDE_PERMISSION_MODES`; writes `permissions.defaultMode` in the delivered settings.json. Fleet default is `'auto'` (`DEFAULT_CLAUDE_PERMISSION_MODE`) — every managed host auto-approves tool calls unless pinned to `'default'` or another mode. |
| `permissions` | Allow, ask, and deny lists. |
| `statusLine.command` | String; type is fixed to `'command'`. |
| `hooks` | Event → `[{matcher, commands[]}]` map, edited via `HooksEditor`. |

A live read-only preview of the rendered `settings.json` is shown alongside the editor.

### Workspace → Profiles (/authoring/settings config.toml builder)

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

- `api/src/routes/admin/settings/index.ts` — all /settings page endpoints
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
