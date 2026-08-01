---
title: Keyboard shortcuts and API reference
section: Integrations and reference
verified: 2026-07-02
sources: api/src/routes/index.ts, api/src/routes/host-api/index.ts, api/src/routes/admin-auth-users/index.ts, api/src/routes/admin-overview-settings/index.ts, api/src/routes/admin-content/index.ts, api/src/routes/openai-compat/index.ts, api/src/routes/anthropic-compat/index.ts, api/src/routes/admin/auth/index.ts, api/src/routes/admin/setup/index.ts, api/src/routes/admin/hosts/index.ts, api/src/routes/admin/settings/index.ts, api/src/routes/admin/overview/index.ts, api/src/routes/admin/users/index.ts, api/src/routes/admin/config/index.ts, api/src/routes/admin/keys/openai.ts, api/src/routes/admin/keys/claude.ts, api/src/routes/admin/projects/index.ts, api/src/routes/admin/manual/index.ts, api/src/routes/auth/index.ts, api/src/routes/host/index.ts, api/src/routes/cli-auth/index.ts, api/src/routes/install/index.ts, api/src/routes/wrapper-v2/index.ts, api/src/routes/mcp/index.ts, api/src/routes/v1/index.ts, api/src/routes/anthropic-v1/index.ts, api/src/routes/projects-client/index.ts, api/src/routes/health.ts, api/src/ws/server.ts, api/src/services/openai-keys.ts, api/src/services/claude-keys.ts, api/src/services/claude-frontmatter.ts, api/src/db/schema.ts, frontend/src/routes/api-keys/+page.svelte, frontend/src/routes/setup/+page.svelte, frontend/src/lib/utils/shortcuts.ts, frontend/src/routes/+layout.svelte, frontend/src/lib/components/shortcuts/ShortcutsModal.svelte, frontend/src/lib/components/command-palette/commands.ts
---

Two reference tables, pulled from the code as of this manual's verified date.

## Keyboard shortcuts

Shortcuts are bound globally in `frontend/src/routes/+layout.svelte` via `bindGlobalShortcuts()` (`frontend/src/lib/utils/shortcuts.ts`); the help overlay is `frontend/src/lib/components/shortcuts/ShortcutsModal.svelte`. The old chord/rail-group navigation (`h a`, `l c`, `s g`, …) is gone — a Cmd-K command palette replaced it.

Single-key shortcuts pause while typing in an editable target (`input`, `textarea`, `select`, or `contenteditable`) — except `Esc`, which always fires regardless of focus. `Ctrl`/`Cmd`+`K` is wired by a separate global listener and is **not** suppressed while typing.

| Key | Action |
|-----|--------|
| `Ctrl`/`Cmd` + `K` | Open/close the command palette |
| `/` | Open the search modal (fuzzy search over hosts, projects, skills, users) |
| `n` | New host — opens the "New host" sheet on `/hosts` |
| `?` | Show the keyboard-shortcuts help modal |
| `Esc` | Close the command palette (dialog-based overlays also close on `Esc` via their own handling) |

The command palette (`frontend/src/lib/components/command-palette/`) groups its results as Recent, Hosts, Navigation, Actions, Projects, Skills, Users, and Theme & session. It fuzzy-matches every top-level nav destination (Dashboard, Hosts, Projects, API Keys, Authoring, Logs, Settings) plus deep links (Logs/MCP, Logs/Events, Authoring/Agents, Account/Password, Account/Passkeys, Settings/General, Settings/Codex, Settings/Claude, Settings/Users, Manual), and exposes quick actions (New host, Quick VM, New project, New API key, Open shortcuts, Sign out) and theme switching — this is what replaced the old per-section chord shortcuts.

## API Keys

### Overview

API keys grant programmatic access to the OpenAI-compatible and Anthropic-compatible proxy endpoints. Both key types are stored in the single `openai_api_keys` database table; the `engine` column (`codex` for OpenAI-compat, `claude` for Anthropic-compat) distinguishes them. The admin list endpoints filter by engine: `GET /admin/openai/keys` returns only `engine=codex` rows; `GET /admin/claude/keys` returns only `engine=claude` rows.

Key prefixes differ by engine:

| Engine | Prefix | Endpoints |
|--------|--------|-----------|
| OpenAI-compat (Codex) | `sk-cdx-` | `/v1/*` |
| Anthropic-compat (Claude) | `sk-ant-` | `/anthropic/v1/*` |

> **Critical:** The plaintext key is returned **once only**, in the `{ key, record }` response body at creation time. It is never retrievable again. If you lose it, revoke the key and issue a new one.

### /api-keys admin page

Navigate to **API Keys** in the admin sidebar (or jump there via the `Ctrl`/`Cmd`+`K` command palette). The page header reads "API Keys" with subtitle "Issue and revoke programmatic access" and a **New key** button in the top-right corner.

The page is divided into two tabs: **OpenAI** and **Claude**. The active tab determines which engine the **New key** button targets.

Above the tabs, the **Proxy endpoints** panel shows the absolute base URLs for clients:

| Engine | Base URL |
|--------|----------|
| OpenAI-compatible | `{origin}/v1` |
| Anthropic-compatible | `{origin}/anthropic/v1` |

Each row has a **Copy** button. The URLs are derived from the current browser origin, so the same page works on production, staging, and local previews.

Each tab contains:

**Kill-switch card**

Shows whether the engine is currently enabled or disabled. A toggle switch labeled "Enabled" controls the state. When disabled, the card turns amber, displays a ShieldAlert icon, and shows the message "All requests using {engine} keys will be rejected." This calls `GET/POST /admin/openai/state` or `GET/POST /admin/claude/state` respectively. Disabling an engine rejects all incoming requests authenticated with keys of that engine, regardless of individual key active status.

**Keys table**

Lists all keys for the engine with columns: Name, Key prefix (first 16 chars followed by `...`), Rate limit (e.g. "60/min"), Active (toggle switch), Uses (request count), Last used (relative time), Expires (date, "Never", or an "Expired" badge), and Actions (enable/disable power icon and a trash/revoke icon). Clicking the revoke icon shows a confirmation dialog before permanently deleting the key.

### Creating a key

Click **New key** (or run "New API key" from the command palette). The dialog form has:

- **Engine** — select "OpenAI (Codex)" or "Claude (Anthropic)"
- **Name** — required text field
- **Rate limit** — requests per minute, default 60
- **Expires** — toggle off for no expiry; toggle on to reveal a datetime picker

On success the dialog switches to a reveal screen showing the full plaintext key with a copy button and the warning: "We don't store the plaintext key. If you lose it, you'll need to issue a new one." Close the dialog after copying — the key cannot be retrieved again.

## Admin HTTP routes

`registerAllRoutes()` in `api/src/routes/index.ts` mounts everything by delegating to per-domain barrel modules — `host-api` (auth/host/install/cli-auth), `openai-compat` (`/v1/*` + OpenAI key admin), `anthropic-compat` (`/anthropic/v1/*` + Claude key admin), `admin-auth-users`, `admin-overview-settings`, `admin-content` (config/agents/skills/projects), and `admin/manual` — each of which registers the individual route files below. Tables list method + path + the file that actually defines the handler. All `/admin/*` JSON endpoints require an authenticated admin session (`app.requireAdmin`) unless explicitly noted.

### Admin auth + passkeys

| Method | Route | Source |
|--------|-------|--------|
| GET | `/admin/auth/status` | api/src/routes/admin/auth/index.ts |
| GET | `/admin/setup/status` | api/src/routes/admin/setup/index.ts |
| POST | `/admin/setup/owner` | api/src/routes/admin/setup/index.ts |
| POST | `/admin/auth/login` | api/src/routes/admin/auth/index.ts |
| POST | `/admin/auth/login/method` | api/src/routes/admin/auth/index.ts |
| POST | `/admin/auth/logout` | api/src/routes/admin/auth/index.ts |
| POST | `/admin/auth/password/change` | api/src/routes/admin/auth/index.ts |
| POST | `/admin/auth/password/request` | api/src/routes/admin/auth/index.ts |
| POST | `/admin/auth/password/reset` | api/src/routes/admin/auth/index.ts |
| POST | `/admin/auth/passkey/login/options` | api/src/routes/admin/auth/index.ts |
| POST | `/admin/auth/passkey/login` | api/src/routes/admin/auth/index.ts |
| POST | `/admin/auth/passkey/register/options` | api/src/routes/admin/auth/index.ts |
| POST | `/admin/auth/passkey/register` | api/src/routes/admin/auth/index.ts |
| GET | `/admin/passkeys` | api/src/routes/admin/auth/index.ts |
| POST | `/admin/passkeys/:id/name` | api/src/routes/admin/auth/index.ts |
| DELETE | `/admin/passkeys/:id` | api/src/routes/admin/auth/index.ts |

### Admin users

| Method | Route | Source |
|--------|-------|--------|
| GET | `/admin/users` | api/src/routes/admin/users/index.ts |
| POST | `/admin/users` | api/src/routes/admin/users/index.ts |
| POST | `/admin/users/:id` | api/src/routes/admin/users/index.ts |
| DELETE | `/admin/users/:id` | api/src/routes/admin/users/index.ts |
| POST | `/admin/users/wipe` | api/src/routes/admin/users/index.ts |

### Admin hosts

| Method | Route | Source |
|--------|-------|--------|
| GET | `/admin/hosts` | api/src/routes/admin/overview/index.ts |
| GET | `/admin/hosts/insecure` | api/src/routes/admin/overview/index.ts |
| POST | `/admin/hosts/register` | api/src/routes/admin/hosts/index.ts |
| POST | `/admin/hosts/quick-register` | api/src/routes/admin/hosts/index.ts |
| GET | `/admin/hosts/:id/detail` | api/src/routes/admin/overview/index.ts |
| GET | `/admin/hosts/:id/auth` | api/src/routes/admin/hosts/index.ts |
| POST | `/admin/hosts/:id/installer` | api/src/routes/admin/hosts/index.ts |
| DELETE | `/admin/hosts/:id` | api/src/routes/admin/hosts/index.ts |
| POST | `/admin/hosts/:id/engines` | api/src/routes/admin/hosts/index.ts |
| POST | `/admin/hosts/:id/clear` | api/src/routes/admin/hosts/index.ts |
| POST | `/admin/hosts/:id/roaming` | api/src/routes/admin/hosts/index.ts |
| POST | `/admin/hosts/:id/secure` | api/src/routes/admin/hosts/index.ts |
| POST | `/admin/hosts/:id/vip` | api/src/routes/admin/hosts/index.ts |
| POST | `/admin/hosts/:id/scaling-exempt` | api/src/routes/admin/hosts/index.ts |
| POST | `/admin/hosts/:id/auto-update` | api/src/routes/admin/hosts/index.ts |
| POST | `/admin/hosts/:id/insecure/enable` | api/src/routes/admin/hosts/index.ts |
| POST | `/admin/hosts/:id/insecure/disable` | api/src/routes/admin/hosts/index.ts |
| POST | `/admin/hosts/:id/curl-insecure` | api/src/routes/admin/hosts/index.ts |
| POST | `/admin/hosts/:id/browseros-mcp` | api/src/routes/admin/hosts/index.ts |
| POST | `/admin/hosts/:id/reverse-dns` | api/src/routes/admin/hosts/index.ts |
| POST | `/admin/hosts/:id/model` | api/src/routes/admin/hosts/index.ts |
| POST | `/admin/hosts/:id/codex-version` | api/src/routes/admin/hosts/index.ts |
| POST | `/admin/hosts/:id/claude-version` | api/src/routes/admin/hosts/index.ts |
| POST | `/admin/hosts/:id/agents-version` | api/src/routes/admin/hosts/index.ts |
| POST | `/admin/hosts/insecure/extend` | api/src/routes/admin/overview/index.ts |
| POST | `/admin/hosts/insecure/disable-all` | api/src/routes/admin/overview/index.ts |
| GET | `/admin/insecure-approvals/pending` | api/src/routes/admin/hosts/index.ts |
| POST | `/admin/insecure-approvals/:id/allow-domain` | api/src/routes/admin/hosts/index.ts |
| POST | `/admin/insecure-approvals/:id/approve` | api/src/routes/admin/hosts/index.ts |
| POST | `/admin/insecure-approvals/:id/deny` | api/src/routes/admin/hosts/index.ts |
| POST | `/admin/insecure-domain-allows/:id/revoke` | api/src/routes/admin/hosts/index.ts |

### Admin settings

| Method | Route | Source |
|--------|-------|--------|
| GET/POST | `/admin/api/state` | api/src/routes/admin/settings/index.ts |
| GET/POST | `/admin/cdx-silent` | api/src/routes/admin/settings/index.ts |
| GET/POST | `/admin/theme` | api/src/routes/admin/settings/index.ts |
| GET/POST | `/admin/reverse-dns` | api/src/routes/admin/settings/index.ts |
| GET/POST | `/admin/auto-update` | api/src/routes/admin/settings/index.ts |
| GET/POST | `/admin/insecure-approval` | api/src/routes/admin/settings/index.ts |
| GET/POST | `/admin/quota-mode` | api/src/routes/admin/settings/index.ts |
| POST | `/admin/prune-policy` | api/src/routes/admin/settings/index.ts |
| GET/POST | `/admin/log-retention` | api/src/routes/admin/settings/index.ts |
| GET/POST | `/admin/scaling` | api/src/routes/admin/settings/index.ts |
| GET/POST | `/admin/openai/state` | api/src/routes/admin/settings/index.ts |
| GET/POST | `/admin/claude/state` | api/src/routes/admin/settings/index.ts |
| GET/POST | `/admin/claude/settings` | api/src/routes/admin/settings/index.ts |
| GET/POST | `/admin/claude/version` | api/src/routes/admin/settings/index.ts |
| POST | `/admin/codex-version` | api/src/routes/admin/settings/index.ts |
| POST | `/admin/versions/check` | api/src/routes/admin/settings/index.ts |

`GET/POST /admin/openai/state` and `GET/POST /admin/claude/state` are the engine kill-switches. A POST with `{ disabled: true }` halts all requests authenticated by keys of that engine. See the kill-switch card description above for the UI equivalent.

### Admin overview / dashboard

| Method | Route | Source |
|--------|-------|--------|
| GET | `/admin/overview` | api/src/routes/admin/overview/index.ts |
| GET | `/admin/ws/info` | api/src/routes/admin/overview/index.ts |
| POST | `/admin/toasts` | api/src/routes/admin/overview/index.ts |
| GET | `/admin/chatgpt/usage` | api/src/routes/admin/overview/index.ts |
| GET | `/admin/chatgpt/usage/history` | api/src/routes/admin/overview/index.ts |
| POST | `/admin/chatgpt/usage/refresh` | api/src/routes/admin/overview/index.ts |
| GET | `/admin/runner` | api/src/routes/admin/overview/index.ts |
| POST | `/admin/runner/run` | api/src/routes/admin/overview/index.ts |
| POST | `/admin/runner/run-claude` | api/src/routes/admin/overview/index.ts |
| POST | `/admin/auth/seed-command` | api/src/routes/admin/overview/index.ts |
| POST | `/admin/auth/upload` | api/src/routes/admin/overview/index.ts |
| GET | `/admin/logs` | api/src/routes/admin/overview/index.ts |
| GET | `/admin/mcp/logs` | api/src/routes/admin/config/index.ts |

### Admin config / agents / skills / memories

| Method | Route | Source |
|--------|-------|--------|
| GET | `/admin/config` | api/src/routes/admin/config/index.ts |
| POST | `/admin/config/render` | api/src/routes/admin/config/index.ts |
| POST | `/admin/config/store` | api/src/routes/admin/config/index.ts |
| GET | `/admin/agents` | api/src/routes/admin/config/index.ts |
| GET | `/admin/agents/versions/:id` | api/src/routes/admin/config/index.ts |
| POST | `/admin/agents/store` | api/src/routes/admin/config/index.ts |
| POST | `/admin/agents/serve` | api/src/routes/admin/config/index.ts |
| POST | `/admin/agents/revert` | api/src/routes/admin/config/index.ts |
| POST | `/admin/agents/retention` | api/src/routes/admin/config/index.ts |
| DELETE | `/admin/agents/versions/:id` | api/src/routes/admin/config/index.ts |
| GET | `/admin/mcp/memories` | api/src/routes/admin/config/index.ts |
| DELETE | `/admin/mcp/memories/:id` | api/src/routes/admin/config/index.ts |
| GET | `/admin/skills` | api/src/routes/admin/config/index.ts |
| GET | `/admin/skills/:slug` | api/src/routes/admin/config/index.ts |
| POST | `/admin/skills/generate` | api/src/routes/admin/config/index.ts |
| POST | `/admin/skills/assist` | api/src/routes/admin/config/index.ts |
| POST | `/admin/skills/store` | api/src/routes/admin/config/index.ts |
| DELETE | `/admin/skills/:slug` | api/src/routes/admin/config/index.ts |

### Admin Claude client config and artifacts

Mirrors `/admin/config`, `/admin/agents`, and `/admin/skills` above, but scoped to the Claude Code CLI client. This is distinct from `/admin/claude/settings` (in the settings table above), which configures the Anthropic-compat *proxy's* default model and max-tokens, not the CLI client config below.

| Method | Route | Source |
|--------|-------|--------|
| GET | `/admin/claude/config` | api/src/routes/admin/config/index.ts |
| POST | `/admin/claude/config/render` | api/src/routes/admin/config/index.ts |
| POST | `/admin/claude/config/store` | api/src/routes/admin/config/index.ts |
| GET | `/admin/claude/:kind` | api/src/routes/admin/config/index.ts |
| GET | `/admin/claude/:kind/:slug` | api/src/routes/admin/config/index.ts |
| POST | `/admin/claude/:kind/store` | api/src/routes/admin/config/index.ts |
| DELETE | `/admin/claude/:kind/:slug` | api/src/routes/admin/config/index.ts |

`:kind` normalizes (via `api/src/services/claude-frontmatter.ts`) to one of `subagent`, `command`, or `output-style` — accepting both singular and plural forms in the URL.

### Admin API keys

| Method | Route | Source |
|--------|-------|--------|
| GET | `/admin/openai/keys` | api/src/routes/admin/keys/openai.ts |
| POST | `/admin/openai/keys` | api/src/routes/admin/keys/openai.ts |
| POST | `/admin/openai/keys/:id/toggle` | api/src/routes/admin/keys/openai.ts |
| DELETE | `/admin/openai/keys/:id` | api/src/routes/admin/keys/openai.ts |
| GET | `/admin/claude/keys` | api/src/routes/admin/keys/claude.ts |
| POST | `/admin/claude/keys` | api/src/routes/admin/keys/claude.ts |
| POST | `/admin/claude/keys/:id/toggle` | api/src/routes/admin/keys/claude.ts |
| DELETE | `/admin/claude/keys/:id` | api/src/routes/admin/keys/claude.ts |

`POST /admin/openai/keys` and `POST /admin/claude/keys` accept `{ name, rate_limit_rpm?, expires_at? }` and return `{ key, record }`. The `key` field contains the full plaintext key and is only present in this response — it is never returned again. All mutations publish WebSocket events (`apikey.created`, `apikey.toggled`, `apikey.deleted`) so connected admin clients invalidate their cache automatically.

### Admin projects

Every project endpoint lives in `api/src/routes/admin/projects/index.ts` and mirrors the host-facing `/projects/*` surface in `api/src/routes/projects-client/index.ts` (registered by the `projects-mcp` barrel alongside `api/src/routes/mcp/index.ts`). See [projects](/admin/manual/projects) for the full shape — the host-facing `/projects/*` routes aren't re-listed in the tables above for that reason.

### Admin manual

| Method | Route | Source |
|--------|-------|--------|
| GET | `/admin/manual/manifest` | api/src/routes/admin/manual/index.ts |
| GET | `/admin/manual/search` | api/src/routes/admin/manual/index.ts |
| GET | `/admin/manual/article/:slug` | api/src/routes/admin/manual/index.ts |

### Admin websocket

| Method | Route | Source |
|--------|-------|--------|
| GET | `/admin/ws` (websocket upgrade) | api/src/ws/server.ts |

### Host-facing and public routes

| Method | Route | Source |
|--------|-------|--------|
| POST | `/auth` | api/src/routes/auth/index.ts |
| POST | `/sync/status` | api/src/routes/auth/index.ts |
| POST | `/sync/bootstrap` | api/src/routes/auth/index.ts |
| DELETE | `/auth` | api/src/routes/auth/index.ts |
| GET | `/versions` | api/src/routes/host/index.ts |
| POST | `/host/users` | api/src/routes/host/index.ts |
| GET/POST | `/host/lane` | api/src/routes/host/index.ts |
| POST | `/cron/check` | api/src/routes/host/index.ts |
| POST | `/cron/report` | api/src/routes/host/index.ts |
| GET | `/wrapper` (alias of `/wrapper/v2/meta`) | api/src/routes/wrapper-v2/index.ts |
| GET | `/wrapper/download` (alias of `/wrapper/v2/download`) | api/src/routes/wrapper-v2/index.ts |
| GET | `/wrapper/v2/meta` | api/src/routes/wrapper-v2/index.ts |
| GET | `/wrapper/v2/config[?sig=1]` | api/src/routes/wrapper-v2/index.ts |
| GET | `/wrapper/v2/download` | api/src/routes/wrapper-v2/index.ts |
| GET | `/wrapper/v2/manifest/:engine` | api/src/routes/wrapper-v2/index.ts |
| GET | `/wrapper/v2/bin/:engine/:plat/v:version/:binary` | api/src/routes/wrapper-v2/index.ts |
| GET | `/install/:token` (alias of `/install/v2/:token`) | api/src/routes/install/index.ts |
| GET | `/install/v2/:token` | api/src/routes/install/index.ts |
| GET | `/seed/auth/:token` (alias of `/seed/v2/auth/:token`) | api/src/routes/install/index.ts |
| POST | `/seed/auth/:token` | api/src/routes/install/index.ts |
| GET/POST | `/seed/v2/auth/:token` | api/src/routes/install/index.ts |
| POST | `/cli/auth/start` | api/src/routes/cli-auth/index.ts |
| POST | `/cli/auth/poll/:id` | api/src/routes/cli-auth/index.ts |
| GET | `/cli/auth/verify` | api/src/routes/cli-auth/index.ts |
| POST | `/cli/auth/lookup` | api/src/routes/cli-auth/index.ts |
| POST | `/cli/auth/approve` | api/src/routes/cli-auth/index.ts |
| POST | `/cli/auth/deny` | api/src/routes/cli-auth/index.ts |
| GET/POST | `/mcp` | api/src/routes/mcp/index.ts |
| GET | `/healthz` | api/src/routes/health.ts |
| GET | `/readyz` | api/src/routes/health.ts |

`/healthz` is a pure unauthenticated liveness probe. `/readyz` is unauthenticated but returns `503` with secret-free per-check detail until migrations, the runner, encrypted signer, wrapper matrix, and Public Base URL are ready.

### OpenAI- and Anthropic-compatible APIs

`/v1/*` handlers live in `api/src/routes/v1/index.ts`; the `api/src/routes/openai-compat/index.ts` barrel wires them up alongside the admin OpenAI key routes. It supports `chat/completions`, `responses`, `completions`, `models`, plus CORS `OPTIONS` (`embeddings` returns `501 feature_not_supported` — the runner backend has no embeddings support).

`/anthropic/v1/*` handlers live in `api/src/routes/anthropic-v1/index.ts`; the `api/src/routes/anthropic-compat/index.ts` barrel wires them up alongside the admin Claude key routes. It supports `messages`, `completions` (deprecated but supported), `models`, `responses` (non-streaming only), plus CORS `OPTIONS` (`embeddings` returns `501` — Anthropic has no embeddings API). Note the Anthropic-compat surface uses `messages`, not `chat/completions` — the two proxies are not path-symmetric.

Authentication uses a bearer token: `sk-cdx-…` keys for the OpenAI-compat surface and `sk-ant-…` keys for the Anthropic-compat surface. Requests proxy through the shared runner with quota accounting.

## Source references

- api/src/routes/index.ts (top-level route mounting via `registerAllRoutes`)
- api/src/routes/host-api/index.ts, admin-auth-users/index.ts, admin-overview-settings/index.ts, admin-content/index.ts (barrel modules that group the route files below)
- api/src/routes/openai-compat/index.ts, anthropic-compat/index.ts (barrels wiring `/v1/*` and `/anthropic/v1/*` up with their admin key routes)
- api/src/routes/admin/**/*.ts (every admin route: auth, hosts, settings, overview, users, config, keys, projects, manual)
- api/src/routes/auth/index.ts, host/index.ts, cli-auth/index.ts, install/index.ts (host-facing surface)
- api/src/routes/wrapper-v2/index.ts (wrapper bakery v2 endpoints)
- api/src/routes/v1/index.ts, anthropic-v1/index.ts (actual OpenAI-compat and Anthropic-compat handlers)
- api/src/routes/projects-client/index.ts (host-facing `/projects/*`, mirrored by the admin projects routes)
- api/src/routes/mcp/index.ts (MCP JSON-RPC)
- api/src/routes/health.ts (liveness/readiness probes)
- api/src/ws/server.ts (admin websocket)
- api/src/services/openai-keys.ts, api/src/services/claude-keys.ts (key prefixes and auth)
- api/src/services/claude-frontmatter.ts (`:kind` normalization for Claude artifacts)
- api/src/db/schema.ts (openai_api_keys table schema)
- frontend/src/routes/api-keys/+page.svelte (API Keys admin page)
- frontend/src/lib/utils/shortcuts.ts (global single-key shortcut handler)
- frontend/src/routes/+layout.svelte (shortcut + Cmd-K wiring)
- frontend/src/lib/components/shortcuts/ShortcutsModal.svelte (shortcuts help modal)
- frontend/src/lib/components/command-palette/commands.ts (command palette registry)
