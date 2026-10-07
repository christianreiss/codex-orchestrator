---
title: Keyboard shortcuts and API reference
section: Integrations and reference
verified: 2026-09-09
sources: api/src/routes/index.ts, api/src/routes/host-api/index.ts, api/src/routes/projects-mcp/index.ts, api/src/routes/agent-portal/index.ts, api/src/routes/agent-portal/admin-host.ts, api/src/routes/agent-portal/public.ts, api/src/routes/agent-messaging/index.ts, api/src/routes/admin/memories/index.ts, api/src/routes/admin/secrets/index.ts, api/src/routes/admin/git-director/index.ts, api/src/routes/admin/transfers/index.ts, api/src/routes/admin/agent-sessions/index.ts, api/src/routes/admin/project-board/index.ts, api/src/routes/admin/skill-sources/index.ts, api/src/routes/admin-auth-users/index.ts, api/src/routes/admin-overview-settings/index.ts, api/src/routes/admin-content/index.ts, api/src/routes/openai-compat/index.ts, api/src/routes/anthropic-compat/index.ts, api/src/routes/admin/auth/index.ts, api/src/routes/admin/setup/index.ts, api/src/routes/admin/hosts/index.ts, api/src/routes/admin/settings/index.ts, api/src/routes/admin/overview/index.ts, api/src/routes/admin/users/index.ts, api/src/routes/admin/config/index.ts, api/src/routes/admin/keys/openai.ts, api/src/routes/admin/keys/claude.ts, api/src/routes/admin/projects/index.ts, api/src/routes/admin/manual/index.ts, api/src/routes/auth/index.ts, api/src/routes/host/index.ts, api/src/routes/cli-auth/index.ts, api/src/routes/install/index.ts, api/src/routes/wrapper-v2/index.ts, api/src/routes/mcp/index.ts, api/src/routes/v1/index.ts, api/src/routes/anthropic-v1/index.ts, api/src/routes/grok-v1/index.ts, api/src/services/api-surfaces.ts, api/src/services/gateway-backends.ts, api/src/routes/projects-client/index.ts, api/src/routes/health.ts, api/src/ws/server.ts, api/src/services/openai-keys.ts, api/src/services/claude-keys.ts, api/src/services/claude-frontmatter.ts, api/src/db/schema.ts, frontend/src/routes/api-keys/+page.svelte, frontend/src/lib/components/api-keys/ExposedApisTable.svelte, frontend/src/routes/setup/+page.svelte, frontend/src/lib/utils/shortcuts.ts, frontend/src/routes/+layout.svelte, frontend/src/lib/components/shortcuts/ShortcutsModal.svelte, frontend/src/lib/components/command-palette/commands.ts
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

The command palette groups results as Recent, Hosts, Navigation, Actions, Projects, Skills, Users, and Theme & session. It searches every sidebar destination, including Engines, Policies, Fleet Instructions, and the collaboration tools, plus Logs and Account deep links (searching Activity still finds Logs). Destination descriptions explain where each result leads; searching either **Codex** or **Claude** finds shared engine controls. Quick actions include New host, Quick VM, New project, New API key, Open shortcuts, Sign out, and theme switching.

Use the arrow keys to select a result, `Enter` to open it, and `Esc` to close. Fleet results load while navigation remains available. The footer reports when search is in progress or a source is unavailable; a query with no results offers suggestions for a new search.

## API Keys

### Overview

API keys grant programmatic access to the OpenAI-compatible, Anthropic-compatible, and Grok gateway endpoints. All three key types are stored in the single `openai_api_keys` database table; the `engine` column (`codex` for OpenAI-compat, `claude` for Anthropic-compat, `grok` for the Grok gateway) distinguishes them. The admin list endpoints filter by engine: `GET /admin/openai/keys` returns only `engine=codex` rows; `GET /admin/claude/keys` returns only `engine=claude` rows; `GET /admin/grok/keys` returns only `engine=grok` rows.

Key prefixes differ by engine:

| Engine | Prefix | Endpoints |
|--------|--------|-----------|
| OpenAI-compat (Codex) | `sk-cdx-` | `/v1/*` |
| Anthropic-compat (Claude) | `sk-ant-` | `/anthropic/v1/*` |
| Grok gateway (Grok) | `sk-cgx-` | `/grok/v1/*` |

`sk-cgx-` keys are orchestrator gateway keys, not xAI API keys; see [Grok Build](cgx).

> **Critical:** The plaintext key is returned **once only**, in the `{ key, record }` response body at creation time. It is never retrievable again. If you lose it, revoke the key and issue a new one.

### /api-keys admin page

Navigate to **API Access** in the admin sidebar (or jump there via the `Ctrl`/`Cmd`+`K` command palette). The header has a **New key** button in the top-right corner. The default view shows compact endpoint rows with copy buttons and availability status, followed immediately by the API key tabs and search. Click an endpoint name to select its keys; **New key** uses that selection. Disabled APIs and disabled backends remain visible here.

Open **Configuration** for routing, backend defaults and global API control; **Back to keys** preserves the selected API. Existing setting links open Configuration and expand the relevant backend automatically.

**Global API control** — the master switch for all API traffic (`/admin/api/state`), at the bottom of Configuration.

**Routing & availability** — one row per exposed API, backed by `GET/POST /admin/api/surfaces`:

| Column | Meaning |
|--------|---------|
| API | `OpenAI-compatible` (`/v1`), `Anthropic-compatible` (`/anthropic/v1`) or `Grok (OpenAI-compatible)` (`/grok/v1`), with its wire format |
| Base URL | `{origin}` + the base path, with a **Copy** button; derived from the browser origin |
| Backend | Which engine answers: **Codex**, **Claude** or **Grok**. A **rerouted** badge marks an API not on its own engine. Changes apply to the next request — no restart. An engine switched off under **Engines → Engine master switches** cannot be picked, and a row whose backend is off shows **backend off** and answers `503 api_disabled` until the engine is back on or the API is rerouted |
| Enabled | The API's own kill switch (`openai_api_disabled`, `claude_api_disabled`, `grok_api_disabled`); off returns `503 api_disabled` on that API only |
| Keys | Active keys for that API; the link opens its key tab |

The backend decides whose subscription, model catalog and limits apply; the API keeps its URL, wire format, error shape and keys. Limits follow the backend: Grok refuses streaming, images and sampling controls on every API; on the Anthropic API, Codex receives `system` as a leading transcript line and Grok never receives `max_tokens`; Codex reports no token usage. `/models` lists the backend's models, and a request for a model id native to the API (e.g. `claude-*` on `/anthropic/v1`) that the backend does not serve runs on the backend's default model — the response's `model` field says which.

**Backend defaults** — collapsed Claude and Grok sections containing the Claude proxy defaults and the **Grok API gateway** controls (gateway default model and per-model switches), which apply on every API routed to that engine.

**Key tabs** — **OpenAI** (`/v1`), **Anthropic** (`/anthropic/v1`) and **Grok** (`/grok/v1`). Keys belong to the API, not the backend: rerouting an API never invalidates its keys, and a `sk-cdx-` key still only works on `/v1`. The active tab determines which API the **New key** button targets.

**Keys table**

Lists all keys for the API with columns: Name, Key prefix (first 16 chars followed by `...`), Active (toggle switch), Uses (request count), Last used (relative time), Expires (date, "Never", or an "Expired" badge), and Actions (enable/disable power icon and a trash/revoke icon). Clicking the revoke icon shows a confirmation dialog before permanently deleting the key.

### Creating a key

Click **New key** (or run "New API key" from the command palette). The dialog form has:

- **Engine** — select "OpenAI (Codex)", "Claude (Anthropic)", or "Grok subscription gateway"
- **Name** — required text field
- **Expires** — toggle off for no expiry; toggle on to reveal a datetime picker

On success the dialog switches to a reveal screen showing the full plaintext key with a copy button and the warning: "We don't store the plaintext key. If you lose it, you'll need to issue a new one." Close the dialog after copying — the key cannot be retrieved again.

## Admin HTTP routes

`registerAllRoutes()` in `api/src/routes/index.ts` mounts everything by delegating to per-domain barrel modules — `host-api` (auth/host/install/cli-auth), `projects-mcp` (host-facing projects/memories/skills plus `/mcp`), `wrapper-v2`, `agent-portal`, `agent-messaging`, `openai-compat` (`/v1/*` + OpenAI key admin), `anthropic-compat` (`/anthropic/v1/*` + Claude key admin), `grok-v1` (`/grok/v1/*`), `admin/grok` (Grok gateway admin + Grok keys), `admin-auth-users`, `admin/hosts`, `admin-overview-settings`, `admin-content` (config/agents/skills/projects/skill sources), `admin/memories`, `admin/secrets`, `admin/git-director`, `admin/transfers`, `admin/agent-sessions`, `admin/project-board`, and `admin/manual` — each of which registers the individual route files below. Tables list method + path + the file that actually defines the handler. All `/admin/*` JSON endpoints require an authenticated admin session (`app.requireAdmin`) unless explicitly noted, and every one of them additionally names a capability in `api/src/security/route-capabilities.ts` — see [Roles and capabilities](/admin/manual/roles).

### Admin auth + passkeys

| Method | Route | Source |
|--------|-------|--------|
| GET | `/admin/auth/status` | api/src/routes/admin/auth/index.ts |
| GET | `/admin/setup/status` | api/src/routes/admin/setup/index.ts |
| POST | `/admin/setup/owner` | api/src/routes/admin/setup/index.ts |
| GET | `/admin/setup/wizard` | api/src/routes/admin/setup/index.ts |
| POST | `/admin/setup/wizard` | api/src/routes/admin/setup/index.ts |
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

The four `/admin/setup/*` routes are the noted exception to the session rule: they sit behind `requireAdminAfterSetup`, which is public only while `admin_users` is empty and session-gated afterwards. `/admin/setup/wizard` carries first-run wizard position and completion (`last_step`, `engines`, `completed`, `dismissed`); every answer the wizard collects is written through the endpoint that owns it.

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
| POST | `/admin/hosts/:id/release-ip-binding` | api/src/routes/admin/hosts/index.ts |
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
| POST | `/admin/hosts/:id/grok-version` | api/src/routes/admin/hosts/index.ts |
| POST | `/admin/hosts/:id/agents-version` | api/src/routes/admin/hosts/index.ts |
| POST | `/admin/hosts/insecure/extend` | api/src/routes/admin/overview/index.ts |
| POST | `/admin/hosts/insecure/disable-all` | api/src/routes/admin/overview/index.ts |
| POST | `/admin/hosts/insecure/window` | api/src/routes/admin/hosts/index.ts |
| POST | `/admin/hosts/insecure/window/close` | api/src/routes/admin/hosts/index.ts |
| GET | `/admin/insecure-approvals/pending` | api/src/routes/admin/hosts/index.ts |
| POST | `/admin/insecure-approvals/:id/allow-domain` | api/src/routes/admin/hosts/index.ts |
| POST | `/admin/insecure-approvals/:id/approve` | api/src/routes/admin/hosts/index.ts |
| POST | `/admin/insecure-approvals/:id/deny` | api/src/routes/admin/hosts/index.ts |
| POST | `/admin/insecure-domain-allows/:id/revoke` | api/src/routes/admin/hosts/index.ts |

### Admin settings

| Method | Route | Source |
|--------|-------|--------|
| GET/POST | `/admin/api/state` | api/src/routes/admin/settings/index.ts |
| GET | `/admin/api/surfaces` | api/src/routes/admin/settings/index.ts |
| POST | `/admin/api/surfaces/:surface` | api/src/routes/admin/settings/index.ts |
| GET | `/admin/engines/state` | api/src/routes/admin/engines/index.ts |
| POST | `/admin/engines/:engine/state` | api/src/routes/admin/engines/index.ts |
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
| GET/POST | `/admin/grok/version` | api/src/routes/admin/settings/index.ts |
| GET | `/admin/grok/version/lock` | api/src/routes/admin/settings/index.ts |
| POST | `/admin/codex-version` | api/src/routes/admin/settings/index.ts |
| POST | `/admin/versions/check` | api/src/routes/admin/settings/index.ts |
| GET/POST | `/admin/model-defaults/:engine` | api/src/routes/admin/settings/index.ts |
| GET/POST | `/admin/agents-generation-mode` | api/src/routes/admin/settings/index.ts |
| GET/POST | `/admin/api-keys-in-chat` | api/src/routes/admin/settings/index.ts |
| GET/POST | `/admin/response-verbosity` | api/src/routes/admin/settings/index.ts |
| GET/POST | `/admin/authorization` | api/src/routes/admin/settings/index.ts |

`GET/POST /admin/openai/state` and `GET/POST /admin/claude/state` are the engine kill-switches; `GET/POST /admin/grok/state` (in *Admin Grok gateway* below) is the Grok gateway's. A POST with `{ disabled: true }` halts all requests authenticated by keys of that engine. See the kill-switch card description above for the UI equivalent.

### Admin overview / dashboard

| Method | Route | Source |
|--------|-------|--------|
| GET | `/admin/overview` | api/src/routes/admin/overview/index.ts |
| GET | `/admin/ws/info` | api/src/routes/admin/overview/index.ts |
| POST | `/admin/toasts` | api/src/routes/admin/overview/index.ts |
| GET | `/admin/chatgpt/usage` | api/src/routes/admin/overview/index.ts |
| GET | `/admin/chatgpt/usage/history` | api/src/routes/admin/overview/index.ts |
| POST | `/admin/chatgpt/usage/refresh` | api/src/routes/admin/overview/index.ts |
| GET | `/admin/claude/usage` | api/src/routes/admin/overview/index.ts |
| GET | `/admin/claude/usage/history` | api/src/routes/admin/overview/index.ts |
| GET | `/admin/runner` | api/src/routes/admin/overview/index.ts |
| POST | `/admin/runner/run` | api/src/routes/admin/overview/index.ts |
| POST | `/admin/runner/run-claude` | api/src/routes/admin/overview/index.ts |
| POST | `/admin/runner/run-grok` | api/src/routes/admin/overview/index.ts |
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
| POST | `/admin/agents/compose` | api/src/routes/admin/config/index.ts |
| GET/POST | `/admin/agents/render` | api/src/routes/admin/config/index.ts |
| POST | `/admin/agents/serve` | api/src/routes/admin/config/index.ts |
| POST | `/admin/agents/revert` | api/src/routes/admin/config/index.ts |
| POST | `/admin/agents/retention` | api/src/routes/admin/config/index.ts |
| DELETE | `/admin/agents/versions/:id` | api/src/routes/admin/config/index.ts |
| GET | `/admin/agent-policy-profiles` | api/src/routes/admin/config/index.ts |
| POST | `/admin/agent-policy-profiles` | api/src/routes/admin/config/index.ts |
| POST | `/admin/agent-policy-profiles/:id` | api/src/routes/admin/config/index.ts |
| DELETE | `/admin/agent-policy-profiles/:id` | api/src/routes/admin/config/index.ts |
| POST | `/admin/agent-policy-profiles/:id/default` | api/src/routes/admin/config/index.ts |
| POST | `/admin/agent-policy-profiles/assign` | api/src/routes/admin/config/index.ts |
| GET | `/admin/agent-policy-profiles/enforcement` | api/src/routes/admin/config/index.ts |
| GET | `/admin/mcp/memories` | api/src/routes/admin/config/index.ts |
| DELETE | `/admin/mcp/memories/:id` | api/src/routes/admin/config/index.ts |
| GET | `/admin/shared-memories` | api/src/routes/admin/config/index.ts |
| GET | `/admin/shared-memories/:slug` | api/src/routes/admin/config/index.ts |
| DELETE | `/admin/shared-memories/:slug` | api/src/routes/admin/config/index.ts |
| GET | `/admin/skills` | api/src/routes/admin/config/index.ts |
| GET | `/admin/skills/:slug` | api/src/routes/admin/config/index.ts |
| POST | `/admin/skills/generate` | api/src/routes/admin/config/index.ts |
| POST | `/admin/skills/assist` | api/src/routes/admin/config/index.ts |
| POST | `/admin/skills/store` | api/src/routes/admin/config/index.ts |
| DELETE | `/admin/skills/:slug` | api/src/routes/admin/config/index.ts |
| GET | `/admin/skill-sources/mattpocock` | api/src/routes/admin/skill-sources/index.ts |
| POST | `/admin/skill-sources/mattpocock` | api/src/routes/admin/skill-sources/index.ts |
| POST | `/admin/skill-sources/mattpocock/refresh` | api/src/routes/admin/skill-sources/index.ts |

`/admin/mcp/memories` and `/admin/shared-memories` are the deprecated per-scope reads and deletes; the console uses the unified `/admin/memories/*` surface below.

### Admin memories (Memory Atlas)

| Method | Route | Source |
|--------|-------|--------|
| GET | `/admin/memories/graph` | api/src/routes/admin/memories/index.ts |
| GET | `/admin/memories/audit` | api/src/routes/admin/memories/index.ts |
| POST | `/admin/memories/:scope` | api/src/routes/admin/memories/index.ts |
| GET | `/admin/memories/:scope/:recordId` | api/src/routes/admin/memories/index.ts |
| PATCH | `/admin/memories/:scope/:recordId` | api/src/routes/admin/memories/index.ts |
| DELETE | `/admin/memories/:scope/:recordId` | api/src/routes/admin/memories/index.ts |
| POST | `/admin/memories/shared/:recordId/append` | api/src/routes/admin/memories/index.ts |

`:scope` is `host`, `project`, or `shared`. Detail responses carry an ETag; `PATCH` and `DELETE` accept `expected_etag` (or `If-Match`) and answer `409 memory_conflict` when stale. See [memories](/admin/manual/memories).

### Admin secrets

| Method | Route | Source |
|--------|-------|--------|
| GET/POST | `/admin/secrets/state` | api/src/routes/admin/secrets/index.ts |
| GET | `/admin/secrets` | api/src/routes/admin/secrets/index.ts |
| POST | `/admin/secrets` | api/src/routes/admin/secrets/index.ts |
| GET | `/admin/secrets/:id` | api/src/routes/admin/secrets/index.ts |
| PATCH | `/admin/secrets/:id` | api/src/routes/admin/secrets/index.ts |
| DELETE | `/admin/secrets/:id` | api/src/routes/admin/secrets/index.ts |
| POST | `/admin/secrets/:id/reveal` | api/src/routes/admin/secrets/index.ts |

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
| GET | `/admin/grok/keys` | api/src/routes/admin/grok/index.ts |
| POST | `/admin/grok/keys` | api/src/routes/admin/grok/index.ts |
| POST | `/admin/grok/keys/:id/toggle` | api/src/routes/admin/grok/index.ts |
| DELETE | `/admin/grok/keys/:id` | api/src/routes/admin/grok/index.ts |

`POST /admin/openai/keys`, `POST /admin/claude/keys`, and `POST /admin/grok/keys` accept `{ name, expires_at? }` and return `{ key, record }`. The `key` field contains the full plaintext key and is only present in this response — it is never returned again. All mutations publish WebSocket events (`apikey.created`, `apikey.toggled`, `apikey.deleted`) so connected admin clients invalidate their cache automatically.

### Admin Grok gateway

| Method | Route | Source |
|--------|-------|--------|
| GET/POST | `/admin/grok/state` | api/src/routes/admin/grok/index.ts |
| GET/POST | `/admin/grok/settings` | api/src/routes/admin/grok/index.ts |
| GET | `/admin/grok/models` | api/src/routes/admin/grok/index.ts |
| POST | `/admin/grok/models/:model/toggle` | api/src/routes/admin/grok/index.ts |
| GET | `/admin/grok/config` | api/src/routes/admin/grok/index.ts |
| GET | `/admin/grok/config/retrieve` | api/src/routes/admin/grok/index.ts |
| POST | `/admin/grok/config/render` | api/src/routes/admin/grok/index.ts |
| POST | `/admin/grok/config/store` | api/src/routes/admin/grok/index.ts |

`/admin/grok/state` is the independent `grok_api_disabled` gateway switch, `/admin/grok/settings` holds the gateway default model, and `/admin/grok/models/:model/toggle` takes `{ enabled }`. The `/admin/grok/config*` routes read, render, and store the Grok client config document (`~/.grok/config.toml`). See [Engines, Policies, and API Access](/admin/manual/settings).

### Admin Agent Messaging

| Method | Route | Source |
|--------|-------|--------|
| GET/POST | `/admin/agent-messaging/state` | api/src/routes/agent-messaging/index.ts |
| GET | `/admin/agent-messaging` | api/src/routes/agent-messaging/index.ts |
| GET | `/admin/agent-messaging/addresses` | api/src/routes/agent-messaging/index.ts |
| PATCH | `/admin/agent-messaging/addresses/:id` | api/src/routes/agent-messaging/index.ts |
| POST | `/admin/agent-messaging/addresses/:id/enabled` | api/src/routes/agent-messaging/index.ts |
| GET | `/admin/agent-messaging/conversations` | api/src/routes/agent-messaging/index.ts |
| POST | `/admin/agent-messaging/conversations/:id/cancel` | api/src/routes/agent-messaging/index.ts |
| GET | `/admin/agent-messaging/messages` | api/src/routes/agent-messaging/index.ts |
| POST | `/admin/agent-messaging/messages/:id/reveal` | api/src/routes/agent-messaging/index.ts |
| POST | `/admin/agent-messaging/messages/:id/redrive` | api/src/routes/agent-messaging/index.ts |

The host-facing relay and session bus routes (`/host/agent-relays/*`, `/host/agent-sessions/:id/agent-messaging/*`) live in the same file. See [agent-messaging](/admin/manual/agent-messaging).

### Admin Agent Portal and Active Clients

| Method | Route | Source |
|--------|-------|--------|
| GET/POST | `/admin/agent-portal/state` | api/src/routes/agent-portal/admin-host.ts |
| GET | `/admin/agent-portal/users` | api/src/routes/agent-portal/admin-host.ts |
| POST | `/admin/agent-portal/users` | api/src/routes/agent-portal/admin-host.ts |
| POST | `/admin/agent-portal/users/:id` | api/src/routes/agent-portal/admin-host.ts |
| POST | `/admin/agent-portal/users/:id/enabled` | api/src/routes/agent-portal/admin-host.ts |
| POST | `/admin/agent-portal/users/:id/rotate` | api/src/routes/agent-portal/admin-host.ts |
| GET | `/admin/agent-portal/users/:id/link` | api/src/routes/agent-portal/admin-host.ts |
| DELETE | `/admin/agent-portal/users/:id` | api/src/routes/agent-portal/admin-host.ts |
| GET | `/admin/agent-sessions` | api/src/routes/admin/agent-sessions/index.ts |
| GET | `/admin/agent-sessions/events` | api/src/routes/admin/agent-sessions/index.ts |
| GET | `/admin/agent-sessions/:id/events` | api/src/routes/admin/agent-sessions/index.ts |
| POST | `/admin/agent-sessions/:id/messages` | api/src/routes/admin/agent-sessions/index.ts |
| POST | `/admin/agent-sessions/:id/prompts/:promptId/answer` | api/src/routes/admin/agent-sessions/index.ts |
| POST | `/admin/agent-sessions/:id/close` | api/src/routes/admin/agent-sessions/index.ts |
| POST | `/admin/agent-sessions/:id/close/force` | api/src/routes/admin/agent-sessions/index.ts |

`GET /admin/agent-sessions/events` is a server-sent-event stream. The wrapper-side registration, heartbeat, event and command-claim routes (`/host/agent-sessions*`, `/host/agent-commands/:messageId/ack`, `GET /host/agent-portal/state`) and the phone portal (`GET /go`, `GET /go/u/:publicId`, `/go/api/*`) are in `api/src/routes/agent-portal/admin-host.ts` and `public.ts`. See [agent-portal](/admin/manual/agent-portal).

### Admin Git Director

| Method | Route | Source |
|--------|-------|--------|
| GET/POST | `/admin/git-director/state` | api/src/routes/admin/git-director/index.ts |
| GET | `/admin/git-director` | api/src/routes/admin/git-director/index.ts |
| POST | `/admin/git-director/requests/:id/decide` | api/src/routes/admin/git-director/index.ts |
| POST | `/admin/git-director/worktrees/:id/release` | api/src/routes/admin/git-director/index.ts |

### Admin File Transfer

| Method | Route | Source |
|--------|-------|--------|
| GET/POST | `/admin/transfers/state` | api/src/routes/admin/transfers/index.ts |
| POST | `/admin/transfers/limits` | api/src/routes/admin/transfers/index.ts |
| GET | `/admin/transfers` | api/src/routes/admin/transfers/index.ts |
| GET | `/admin/transfers/:id/events` | api/src/routes/admin/transfers/index.ts |
| GET | `/admin/transfers/:id/content` | api/src/routes/admin/transfers/index.ts |
| DELETE | `/admin/transfers/:id` | api/src/routes/admin/transfers/index.ts |

`/content` streams the file itself rather than the JSON envelope and requires `transfers.download`. Agents reach the pool through the `transfer_*` MCP tools, not HTTP. See [transfers](/admin/manual/transfers).

### Admin projects

Every project endpoint lives in `api/src/routes/admin/projects/index.ts` and mirrors the host-facing `/projects/*` surface in `api/src/routes/projects-client/index.ts` (registered by the `projects-mcp` barrel alongside `api/src/routes/mcp/index.ts`). See [projects](/admin/manual/projects) for the full shape — the host-facing `/projects/*` routes aren't re-listed in the tables above for that reason. The project board (`GET/POST /admin/project-board/state`, `GET /admin/projects/:slug/board`, and the `/admin/projects/:slug/board/cards*` and `/columns/:id` mutations) is registered separately from `api/src/routes/admin/project-board/index.ts`.

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
| POST | `/claude/usage/report` | api/src/routes/auth/index.ts |
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
| POST | `/agents/retrieve` | api/src/routes/projects-client/index.ts |
| POST | `/config/retrieve` | api/src/routes/projects-client/index.ts |
| GET | `/claude/:kind` | api/src/routes/projects-client/index.ts |
| POST | `/claude/:kind/retrieve` | api/src/routes/projects-client/index.ts |
| GET | `/skills` | api/src/routes/projects-client/index.ts |
| POST | `/skills/retrieve` | api/src/routes/projects-client/index.ts |
| POST | `/skills/store` | api/src/routes/projects-client/index.ts |
| POST | `/mcp/memories/store` | api/src/routes/projects-client/index.ts |
| POST | `/mcp/memories/retrieve` | api/src/routes/projects-client/index.ts |
| POST | `/mcp/memories/search` | api/src/routes/projects-client/index.ts |
| POST | `/mcp/memories/delete` | api/src/routes/projects-client/index.ts |
| DELETE | `/mcp/memories/:id` | api/src/routes/projects-client/index.ts |
| GET | `/shared-memories` | api/src/routes/projects-client/index.ts |
| GET | `/shared-memories/:slug` | api/src/routes/projects-client/index.ts |
| DELETE | `/shared-memories/:slug` | api/src/routes/projects-client/index.ts |
| POST | `/shared-memories/list` | api/src/routes/projects-client/index.ts |
| POST | `/shared-memories/read` | api/src/routes/projects-client/index.ts |
| POST | `/shared-memories/search` | api/src/routes/projects-client/index.ts |
| POST | `/shared-memories/write` | api/src/routes/projects-client/index.ts |
| POST | `/shared-memories/append` | api/src/routes/projects-client/index.ts |
| POST | `/shared-memories/delete` | api/src/routes/projects-client/index.ts |
| GET | `/healthz` | api/src/routes/health.ts |
| GET | `/readyz` | api/src/routes/health.ts |

`/healthz` is a pure unauthenticated liveness probe. `/readyz` is unauthenticated but returns `503` with secret-free per-check detail until migrations, the runner, encrypted signer, wrapper matrix, and Public Base URL are ready.

### OpenAI- and Anthropic-compatible APIs

`/v1/*` handlers live in `api/src/routes/v1/index.ts`; the `api/src/routes/openai-compat/index.ts` barrel wires them up alongside the admin OpenAI key routes. It supports `chat/completions`, `responses`, `completions`, `models` (list and `models/:model`), plus CORS `OPTIONS` (`embeddings` returns `400 unsupported_endpoint` — the runner backend has no embeddings support).

`/anthropic/v1/*` handlers live in `api/src/routes/anthropic-v1/index.ts`; the `api/src/routes/anthropic-compat/index.ts` barrel wires them up alongside the admin Claude key routes. It supports `messages`, `messages/count_tokens`, `completions` and `complete` (deprecated but supported), `models` (list and `models/:model_id`), `responses` (non-streaming only), plus CORS `OPTIONS` (`embeddings` returns `501` — Anthropic has no embeddings API). Note the Anthropic-compat surface uses `messages`, not `chat/completions` — the two proxies are not path-symmetric.

`/grok/v1/*` is mounted by `api/src/routes/grok-v1/index.ts`, which registers the same `api/src/routes/v1/index.ts` handlers under the `/grok` prefix as the `grok` surface; by default it is served by the Grok backend with its model catalog and server-owned Grok subscription auth. It supports `chat/completions`, `responses`, `completions`, and `models` (list and `models/:model`); embeddings are unsupported. Text, model selection, and system instructions are accepted; streaming, tools, sampling, stop sequences, output-token caps, and image inputs are rejected with explicit 400 errors. A model disabled under API Access is left out of `/grok/v1/models` and rejected with 403 `model_disabled`. Errors use the OpenAI envelope.

Authentication uses a bearer token: `sk-cdx-…` keys for the OpenAI-compat surface, `sk-ant-…` keys for the Anthropic-compat surface, and `sk-cgx-…` keys (`Authorization: Bearer` only) for `/grok/v1`. Requests proxy through the shared runner with quota accounting; Grok subscription quota is not tracked.

Each of the three surfaces is served by a backend engine chosen in **API Access → Configuration → Routing & availability** (`versions` rows `api_surface_backend_openai|anthropic|grok`, read per request). `api/src/services/api-surfaces.ts` defines the surfaces and the routing; `api/src/services/gateway-backends.ts` builds each engine's backend (credential snapshot, verification bookkeeping, model catalog) once and shares it between surfaces. Keys and kill switches stay with the surface.

## Source references

- api/src/routes/index.ts (top-level route mounting via `registerAllRoutes`)
- api/src/routes/host-api/index.ts, admin-auth-users/index.ts, admin-overview-settings/index.ts, admin-content/index.ts (barrel modules that group the route files below)
- api/src/routes/openai-compat/index.ts, anthropic-compat/index.ts (barrels wiring `/v1/*` and `/anthropic/v1/*` up with their admin key routes)
- api/src/routes/admin/memories/index.ts, admin/secrets/index.ts, admin/git-director/index.ts, admin/transfers/index.ts, admin/agent-sessions/index.ts, admin/project-board/index.ts, admin/skill-sources/index.ts (the direct-mounted admin route files)
- api/src/routes/agent-messaging/index.ts, agent-portal/admin-host.ts, agent-portal/public.ts (Agent Messaging, Agent Portal admin/host, and the `/go` portal)
- api/src/routes/admin/**/*.ts (every admin route: auth, hosts, settings, overview, users, config, keys, projects, manual)
- api/src/routes/auth/index.ts, host/index.ts, cli-auth/index.ts, install/index.ts (host-facing surface)
- api/src/routes/wrapper-v2/index.ts (wrapper bakery v2 endpoints)
- api/src/routes/v1/index.ts, anthropic-v1/index.ts (actual OpenAI-compat and Anthropic-compat handlers)
- api/src/routes/grok-v1/index.ts (mounts the `/v1` handlers under `/grok` for the Grok gateway)
- api/src/routes/admin/grok/index.ts (Grok keys, gateway state, default model, model toggles, client config)
- api/src/services/grok-models.ts (Grok catalog and per-model gateway switches)
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
