---
title: Keyboard shortcuts and API reference
section: Integrations and reference
verified: 2026-11-20
sources: api/src/routes/v1/index.ts, api/src/routes/anthropic-v1/index.ts, api/src/routes/grok-v1/index.ts, api/src/routes/health.ts, api/src/routes/admin/keys/openai.ts, api/src/routes/admin/keys/claude.ts, api/src/services/api-surfaces.ts, api/src/services/gateway-backends.ts, api/src/services/openai-keys.ts, api/src/routes/admin/keys/gateway-keys.ts, frontend/src/lib/components/api-keys/ApiKeysSection.svelte, frontend/src/lib/components/api-keys/ExposedApisTable.svelte, frontend/src/routes/setup/+page.svelte, frontend/src/lib/utils/shortcuts.ts, frontend/src/routes/+layout.svelte, frontend/src/lib/components/shortcuts/ShortcutsModal.svelte, frontend/src/lib/components/command-palette/commands.ts, docs/API.md, docs/interface-api.md
---

Keyboard shortcuts, the API key controls, and a pointer to the full API route reference. Pulled from the code as of this manual's verified date.

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

The command palette groups results as Recent, Hosts, Navigation, Actions, Projects, Library, People, and Theme & session. It searches every sidebar destination, including Engines, Settings, Agent rules, and the coordination tools, plus Activity and Account deep links (searching Logs still finds Activity). Destination descriptions explain where each result leads; searching either **Codex** or **Claude** finds shared engine controls. Quick actions include New host, Quick VM, New project, New API key, Open shortcuts, Sign out, and theme switching.

Use the arrow keys to select a result, `Enter` to open it, and `Esc` to close. Fleet results load while navigation remains available. The footer reports when search is in progress or a source is unavailable; a query with no results offers suggestions for a new search.

## API Keys

### Overview

API keys grant programmatic access to the OpenAI-compatible, Anthropic-compatible, and Grok gateway endpoints. All four key types are stored in the single `openai_api_keys` database table; the `engine` column (`codex` for OpenAI-compat, `claude` for Anthropic-compat, `grok` for the Grok gateway) distinguishes them. The admin list endpoints filter by engine: `GET /admin/openai/keys` returns only `engine=codex` rows; `GET /admin/claude/keys` returns only `engine=claude` rows; `GET /admin/grok/keys` returns only `engine=grok` rows.

Key prefixes differ by engine:

| Engine | Prefix | Endpoints |
|--------|--------|-----------|
| OpenAI-compat (Codex) | `sk-cdx-` | `/v1/*` |
| Anthropic-compat (Claude) | `sk-ant-` | `/anthropic/v1/*` |
| Grok gateway (Grok) | `sk-cgx-` | `/grok/v1/*` |

`sk-cgx-` keys are orchestrator gateway keys, not xAI API keys; see [Grok Build](cgx).

> **Critical:** The plaintext key is returned **once only**, in the `{ key, record }` response body at creation time. It is never retrievable again. If you lose it, revoke the key and issue a new one.

### API keys (Access page)

Open **Access & Settings** in the admin sidebar (or jump there via the `Ctrl`/`Cmd`+`K` command palette) and go to the **API keys** tab (`/api-keys`; the old `/access#api-keys` URL redirects there). The keys toolbar has a search box, an API filter (**All**, **OpenAI**, **Anthropic**, **Grok**), compact endpoint rows with copy buttons and availability status, and a **New key** button. Choosing an API in the filter or an endpoint makes **New key** use that selection. Disabled APIs and disabled backends remain visible here.

Open **Configure** in the section header for *Service availability & routing*: routing, backend defaults and global API control. Existing setting links open Configure and expand the relevant backend automatically.

**All API traffic** (global API control) — the master switch for all API traffic (`/admin/api/state`), at the bottom of Configure.

**Routing** — one row per exposed API, backed by `GET/POST /admin/api/surfaces`:

| Column | Meaning |
|--------|---------|
| API | `OpenAI-compatible` (`/v1`), `Anthropic-compatible` (`/anthropic/v1`) or `Grok (OpenAI-compatible)` (`/grok/v1`), with its wire format |
| Base URL | `{origin}` + the base path, with a **Copy** button; derived from the browser origin |
| Default engine | Which engine answers keys without an assignment: **Codex**, **Claude**, **Grok** or **Kimi Code**. A **rerouted** badge marks an API not on its own engine. Changes apply to the next request — no restart. An engine switched off under **Engines → Engine master switches** cannot be picked, and a row whose default engine is off shows **backend off**. Unassigned keys answer `503 api_disabled` until it is enabled or the default changes; keys assigned to another enabled engine keep working |
| Enabled | The API's own kill switch (`openai_api_disabled`, `claude_api_disabled`, `grok_api_disabled`); off returns `503 api_disabled` on that API only |
| Keys | Active keys for that API; the link opens its keys in the list |

The backend decides whose subscription, model catalog and limits apply; the API keeps its URL, wire format, error shape and keys. Limits follow the backend: Grok refuses streaming, images and sampling controls on every API; on the Anthropic API, Codex receives `system` as a leading transcript line and Grok never receives `max_tokens`; Codex reports no token usage. `/models` lists the backend's models, and a request for a model id native to the API (e.g. `claude-*` on `/anthropic/v1`) that the backend does not serve runs on the backend's default model — the response's `model` field says which.

**Backend defaults** — collapsed Claude and Grok sections containing the Claude proxy defaults and the **Grok API gateway** controls (gateway default model and per-model switches), which apply on every API routed to that engine.

**API filter** — **OpenAI** (`/v1`), **Anthropic** (`/anthropic/v1`) and **Grok** (`/grok/v1`), next to **All**. Keys belong to the API, not the backend: rerouting an API never invalidates its keys, and a `sk-cdx-` key still only works on `/v1`. The active filter determines which API the **New key** button targets.

**Keys table**

Lists the keys for the selected API (or all) with columns: Name, API, Engine (assigned engine or Endpoint default), Active (toggle switch), Last used (relative time), Expires (date, "Never", or an "Expired" badge), and an actions menu with **Revoke key**. Choosing it shows a *Revoke API key?* confirmation before permanently deleting the key.

### Creating a key

Click **New key** (or run "New API key" from the command palette). The dialog form has:

- **API format** — OpenAI-compatible, Anthropic-compatible, or Grok (OpenAI-compatible), preselected from the active filter
- **Engine** — explicitly select Codex, Claude, Grok, or Kimi Code for this key; fleet-disabled engines cannot be selected. This assignment applies only to the new key and is independent of API format.
- **Name** — required text field
- **Expires** — toggle off for no expiry; toggle on to reveal a datetime picker

The connection preview shows the base URL and current availability before creation. On success, the wider dialog shows the full key, assigned engine, expiration and availability, with individual copy buttons for the key, SDK base URL, models URL and generation URLs. Expand the curl example and replace its model placeholder with an ID from the models endpoint. Long values wrap; only the body scrolls when needed on small screens. Save the key before closing — the full key is shown only once.

Existing keys and older API callers that omit `backend_engine` retain endpoint-default routing. New UI-created keys keep their assigned engine when the endpoint default changes. To change an assigned engine, create a replacement key. `POST /admin/{openai|claude|grok}/keys` accepts optional `backend_engine: codex|claude|grok|kimi`; creation and list records return its nullable value. Invalid assignments return 400 and disabled engines return 409.

## API routes

This page no longer carries a route table: a copy here drifted from the code. The route list lives in the repository documentation, where it is held to the registered routes by tests:

- `docs/API.md` is the route catalogue. It lists every registered route as `METHOD /path` with its auth, the capability it needs and a link to its specification, grouped by surface (health, host, wrapper and installer, MCP and connectors, inference gateways, external clients, host-facing agent routes, Android companion, and the admin routes by area).
- `docs/interface-api.md` is the source of truth for behaviour: request and response bodies, status codes, error envelopes and engine-specific rules.

All `/admin/*` JSON endpoints require an authenticated admin session and name a capability in `api/src/security/route-capabilities.ts`; the public admin routes (login, password reset, the static bundle) are listed there with their reason. See [Roles and capabilities](/admin/manual/roles).

`/healthz` is a pure unauthenticated liveness probe. `/readyz` is unauthenticated but returns `503` with secret-free per-check detail until migrations, the runner, encrypted signer, wrapper matrix, and Public Base URL are ready.

### OpenAI- and Anthropic-compatible APIs

`/v1/*` handlers live in `api/src/routes/v1/index.ts`; `routes/index.ts` registers them next to the admin OpenAI key routes. It supports `chat/completions`, `responses`, `completions`, `models` (list and `models/:model`), plus CORS `OPTIONS` (`embeddings` returns `400 unsupported_endpoint` — the runner backend has no embeddings support).

`/anthropic/v1/*` handlers live in `api/src/routes/anthropic-v1/index.ts`; `routes/index.ts` registers them next to the admin Claude key routes. It supports `messages`, `messages/count_tokens`, `completions` and `complete` (deprecated but supported), `models` (list and `models/:model_id`), `responses` (non-streaming only), plus CORS `OPTIONS` (`embeddings` returns `501` — Anthropic has no embeddings API). Note the Anthropic-compat surface uses `messages`, not `chat/completions` — the two proxies are not path-symmetric.

`/grok/v1/*` is mounted by `api/src/routes/grok-v1/index.ts`, which registers the same `api/src/routes/v1/index.ts` handlers under the `/grok` prefix as the `grok` surface; by default it is served by the Grok backend with its model catalog and server-owned Grok subscription auth. It supports `chat/completions`, `responses`, `completions`, and `models` (list and `models/:model`); embeddings are unsupported. Text, model selection, and system instructions are accepted; streaming, tools, sampling, stop sequences, output-token caps, and image inputs are rejected with explicit 400 errors. A model disabled under API Access is left out of `/grok/v1/models` and rejected with 403 `model_disabled`. Errors use the OpenAI envelope.

Authentication uses a bearer token: `sk-cdx-…` keys for the OpenAI-compat surface, `sk-ant-…` keys for the Anthropic-compat surface, and `sk-cgx-…` keys (`Authorization: Bearer` only) for `/grok/v1`. Requests proxy through the shared runner with quota accounting; Grok subscription usage is fetched server-side and shown in Overview and Accounts; wrapper quota enforcement remains unavailable.

Each of the three surfaces is served by a backend engine chosen in **Access → API keys → Configure → Routing** (`versions` rows `api_surface_backend_openai|anthropic|grok`, read per request). `api/src/services/api-surfaces.ts` defines the surfaces and the routing; `api/src/services/gateway-backends.ts` builds each engine's backend (credential snapshot, verification bookkeeping, model catalog) once and shares it between surfaces. Keys and kill switches stay with the surface.

## Source references

- api/src/routes/admin/**/*.ts (every admin route: auth, hosts, settings, overview, users, config, keys, projects, manual)
- api/src/routes/v1/index.ts, anthropic-v1/index.ts (actual OpenAI-compat and Anthropic-compat handlers)
- api/src/routes/grok-v1/index.ts (mounts the `/v1` handlers under `/grok` for the Grok gateway)
- api/src/routes/health.ts (liveness/readiness probes)
- api/src/services/openai-keys.ts, api/src/routes/admin/keys/gateway-keys.ts (key prefixes, validation and auth)
- frontend/src/lib/components/api-keys/ApiKeysSection.svelte, frontend/src/lib/components/api-keys/KeysList.svelte (API keys section of the Access page)
- frontend/src/lib/utils/shortcuts.ts (global single-key shortcut handler)
- frontend/src/routes/+layout.svelte (shortcut + Cmd-K wiring)
- frontend/src/lib/components/shortcuts/ShortcutsModal.svelte (shortcuts help modal)
- frontend/src/lib/components/command-palette/commands.ts (command palette registry)

## Kimi Code

Kimi Code has the OpenAI-shaped `/kimi/v1` surface and orchestrator keys prefixed `sk-ckx-`. It starts disabled; explicitly enable it under Routing after reviewing subscription gateway terms. Surface enablement and backend selection are independent of managed `ckx` launches. See [Kimi Code (ckx)](ckx) for login, quota and receiver details.
