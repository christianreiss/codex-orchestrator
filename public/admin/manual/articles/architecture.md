---
title: Architecture at a glance
section: Orientation
verified: 2026-05-16
sources: public/index.php, src/Http/Router.php, src/Http/Controllers/AdminPageController.php, src/Services/AuthService.php, runner/app.py, scripts/admin-ws.php, wrappers/cdx, wrappers/clx, src/Mcp/McpServer.php
---

Orchestrator is a single-process PHP application with a small Python sidecar and a pair of shell wrappers that run on your hosts. There is no framework: `public/index.php` is the front controller, `src/Http/Router.php` is a regex dispatcher, and domain logic lives as plain PHP classes under `src/`.

## Request lifecycle

1. The reverse proxy (Caddy in the default compose stack) terminates TLS and, if `ADMIN_ACCESS_MODE` is `mtls`, forwards the client cert fingerprint.
2. Every request lands in `public/index.php`. That file creates a `Router` (`src/Http/Router.php`), instantiates every repository / service / controller up top, then registers routes near the bottom. `$router->add(method, regex, callable)` and `$router->dispatch(method, path)` are the only two public methods.
3. The router finds the first matching handler for the HTTP method and path, capturing regex groups as handler arguments. Error handling branches by URL prefix: `/anthropic/v1/` gets Anthropic-style error envelopes, `/v1/` gets OpenAI-style, everything else returns the `{ "status": "error", "message": … }` shape.
4. Admin HTML pages (every `/admin/...` route in `AdminPageController`) share a single handler that simply `require`s `public/admin/index.php`. That bootstrap does the session check, injects `window.__adminBootstrap`, and returns the compiled SPA shell; the client-side router (see `public/admin/index.html`'s inline `parseAdminRoute`) then activates the correct panel.

## Layers

- **Controllers** — `src/Http/Controllers/*Controller.php`. Thin dispatchers that parse input, call services or repositories, and emit JSON via `App\Http\Response::json()` or `AnthropicResponse` / `OpenAiResponse` for the API-compat routes.
- **Services** — `src/Services/*Service.php`. Where business rules live: `AuthService` (auth distribution and host lifecycle), `AdminAuthService` (admin login, sessions, role matrix), `WrapperService` (a thin adapter over the v2 bakery, exposing the per-engine version manifest to other services), `AgentsService`, `SkillService`, `ProjectCoordinationService`, `StartupSyncService`, and the usage services behind the dashboard. The wrapper bakery itself lives in `src/Services/Wrapper/V2/` (`ConfigBaker`, `BakeCache`, `BinaryRegistry`, `BootstrapShimBuilder`, …).
- **Repositories** — `src/Repositories/*Repository.php`. All SQL lives here. No ORM; these classes take a `PDO` and return arrays. Schema evolution is handled by `src/DatabaseMigrator.php` at boot.
- **MCP** — `src/Mcp/`. `McpServer` implements the JSON-RPC dispatch and exposes the tools defined in `McpToolDefinitions`. The HTTP entry point is `/mcp` (handled by `McpRouteController`); auth uses either a per-host API key or an MCP session token from `McpSessionTokenRepository`.
- **Security primitives** — `src/Security/`. `SecretBox` (libsodium authenticated encryption), `EncryptionKeyManager` (keyring rotation), and `RateLimiter`. Auth payloads are stored encrypted at rest using this primitive stack.

## The runner sidecar

The `runner/` directory contains a small FastAPI service (`runner/app.py`) that actually talks to OpenAI and Anthropic. The orchestrator itself never calls the API; it delegates to the runner over a shared-secret HTTP channel. `AUTH_RUNNER_URL` points at the runner, `AUTH_RUNNER_SHARED_SECRET` authenticates the calls, and `RunnerVerifier` / `RunnerValidationService` wrap the two main operations: validate (did this auth.json actually get us a valid completion?) and execute (run a Claude prompt or verify a Codex key on demand). Keeping this split lets you upgrade the runner's SDK versions without touching the PHP code.

## The wrappers

`cdx` and `clx` are static Go binaries built from `wrappers/cdx/` and `wrappers/clx/`. When you onboard a host, the orchestrator emits a ~50-line POSIX `sh` bootstrap shim (`BootstrapShimBuilder::build`) and a typed signed JSON config (`ConfigBaker::bakeForHost`). The shim fetches the config + the right binary for the host's platform, verifies SHA256, and `exec`s the binary. The binary does three things on every run:

1. Verifies the Ed25519 signature on its config against the public key it embeds at build time.
2. Hits `/auth`, `/agents/retrieve`, `/config/retrieve` to refresh local state (best-effort, never blocks).
3. Execs the upstream `codex` / `claude` CLI with the prepared env, then reports token usage to `/usage`.

The binary self-updates if `wrapper.auto_update` is true in its config: when the server-side SHA256 differs from the local copy, the bootstrap shim downloads the new binary, verifies its hash, and atomically replaces it.

## Admin websocket (admin-ws)

`scripts/admin-ws.php` is a long-running PHP process that the admin UI connects to (see `public/admin/assets/admin-ws.js`). It relays admin events (`AdminEventRepository`) and live state changes to the open dashboard sessions. The admin UI calls `GET /admin/ws/info` (`AdminOverviewController::wsInfo`) to discover its URL. Without admin-ws the UI still works; it just falls back to polling.

## Database

Schema is MySQL / MariaDB. Migrations are embedded in `src/DatabaseMigrator.php` and run automatically at every boot. Tables you will care about most:

- `hosts` — one row per registered host; state like `api_key_hash`, `ip_binding`, `secure`, `insecure_enabled_until`, version strings, and IP binding metadata.
- `auth_entries` / `auth_payloads` — the encrypted canonical auth, versioned.
- `host_auth_digests` — per-host snapshots so sync-status can say "nothing changed" cheaply.
- `admin_users`, `admin_sessions`, `admin_passkeys`, `admin_password_resets` — the admin identity stack.
- `projects`, `project_notes`, `project_todos`, `project_files`, `project_feedback`, `project_events` — the Projects module.
- `token_usage`, `token_usage_ingests`, `chatgpt_usage`, `dashboard_graph_stats` — usage telemetry.
- `mcp_session_tokens`, `mcp_access_log`, `memories` — MCP identity and memory store.

The MariaDB container lives next to the app in `docker-compose.yml`; backups are your responsibility.

## Engine support

Everything that can vary by engine takes an `App\Support\Engine` constant — `Engine::CODEX` or `Engine::CLAUDE`. A single host can run either, both, or neither; the wrappers report their capabilities back on register. The dashboard, config builder, and the sync flow all branch on engine where needed. Use this rule of thumb: anywhere you see `$engine = Engine::DEFAULT`, the code is engine-aware and `CODEX` is being treated as the canonical default.

## Source references

- public/index.php (router wiring, controller graph)
- src/Http/Router.php (Router::add, Router::dispatch)
- src/Http/Controllers/AdminPageController.php (SPA shell handlers)
- src/Services/AuthService.php (auth distribution, host lifecycle)
- src/Services/StartupSyncService.php (`/sync/status` collect)
- src/Services/Wrapper/V2/ConfigBaker.php (signed per-host config bakery)
- src/Services/Wrapper/V2/BootstrapShimBuilder.php (POSIX shim emission)
- src/Services/Wrapper/V2/BinaryRegistry.php (per-platform binary inventory)
- src/Services/RunnerVerifier.php, src/Services/RunnerValidationService.php
- runner/app.py (FastAPI verify / exec endpoints)
- wrappers/cdx, wrappers/clx (Go modules — host wrappers)
- scripts/admin-ws.php (websocket relay)
- src/Mcp/McpServer.php (JSON-RPC dispatch)
- src/DatabaseMigrator.php (schema evolution)
