---

title: Architecture at a glance
section: Orientation
verified: 2026-07-01
sources: api/src/server.ts, api/src/routes/index.ts, api/src/routes/admin/pages/static.ts, api/src/services/host-auth.ts, api/src/services/host-management.ts, api/src/services/wrapper-config.ts, api/src/services/wrapper-signing-key.ts, api/src/services/runner-validation.ts, api/src/services/runner-client.ts, api/src/services/canonical-auth-store.ts, api/src/services/runner-proxy.ts, api/src/ops/auth-verification-worker.ts, api/src/services/mcp-server.ts, api/src/ws/server.ts, api/src/ws/publisher.ts, api/src/db/schema.ts, api/src/env.ts, docker-compose.yml, runner/app.py, wrappers/cdx, wrappers/clx, scripts/wrapper-v2-init-keys.sh
---

Orchestrator is a Node 22 + Fastify 5 + TypeScript HTTP service backed by MySQL 8.4 through Drizzle ORM. The HTTP entry point is `api/src/server.ts`; routes live under `api/src/routes/<group>/*.ts` and are mounted by `api/src/routes/index.ts`. Domain logic lives in plain TypeScript services under `api/src/services/`. A Python FastAPI auth-runner sidecar talks to OpenAI / Anthropic on the orchestrator's behalf, and two Go wrappers (`cdx`, `clx`) run on every host.

## Request lifecycle

1. TLS termination is optional. Caddy is included in the compose file but is guarded by `profiles: ["caddy"]` and is **not** started by a plain `docker compose up`. If `ADMIN_ACCESS_MODE=mtls`, the terminating proxy forwards `X-MTLS-Fingerprint` (and friends) to the API.
2. Every request enters Fastify in `api/src/server.ts`. The plugin order is fixed:
   1. `cookie` (`@fastify/cookie`, `onRequest` hook)
   2. `corsPlugin`
   3. `multipart` (`@fastify/multipart`, 16 MB file-size limit)
   4. `requestIdPlugin`
   5. `makeClientIpPlugin`
   6. `authMtlsPlugin`
   7. `makeAuthHostPlugin`
   8. `makeAuthAdminPlugin`
   9. `makeRateLimitPlugin`
   10. `envelopePlugin` (registered last — catches errors from all plugins above)

   Plugins live in `api/src/http/plugins/`. `db`, `env`, `keyring`, and `rateLimiter` are decorated onto the Fastify instance during boot.
3. `registerAllRoutes` in `api/src/routes/index.ts` wires the host-facing API, MCP, wrapper-v2, OpenAI- and Anthropic-compatible APIs, and the full admin surface. Each route group registers its handlers; admin routes attach `app.requireAdmin` as a preHandler.
4. Admin HTML page navigations (`/admin/*` with `Accept: text/html`) are caught by `adminSpaHtmlPreHandler` in `api/src/routes/admin/pages/static.ts`, which returns the SvelteKit `index.html` shell. The SPA then hydrates by calling `GET /admin/auth/status`; there is no server-rendered session bootstrap.

## Layers

- **Routes** — `api/src/routes/<group>/*.ts`. Thin Fastify handlers that parse input, call services, and reply. The envelope plugin shapes errors based on URL prefix (`/anthropic/v1/*` Anthropic-style, `/v1/*` OpenAI-style, everything else the canonical `{ "status": "error", "message": … }` shape).
- **Services** — `api/src/services/*.ts`. Where business rules live: `host-auth.ts` (auth distribution + handshake), `host-management.ts` (registration, mutations, insecure windows), `runner-client.ts` (low-level HTTP transport to the auth-runner sidecar), `runner-validation.ts` (resolves + validates the canonical auth payload for an engine), `canonical-auth-store.ts` (stores candidate auth and decides whether the served payload is still verified), `runner-proxy.ts` (admin-triggered runner actions: run a prompt on demand, mint seed commands), `wrapper-config.ts` + `wrapper-signing-key.ts` (signed per-host wrapper config), `mcp-server.ts` + `mcp-tools.ts` (MCP JSON-RPC + tool registry), `admin-auth.ts` + `admin-passkey.ts` (admin login + WebAuthn), `chatgpt-usage.ts` (dashboard ChatGPT usage — the `CLAUDE_*` pricing env vars are parsed by `env.ts` but no equivalent Claude usage-tracking service consumes them yet), `skills.ts` / `agents.ts` / `memories.ts` (canonical content), `mailer.ts`, `cli-auth.ts`, and so on.
- **Database** — Drizzle queries against a single schema in `api/src/db/schema.ts`. Services receive a `Database` handle (`api/src/db/client.ts`) and write SQL through Drizzle's typed query builder. No repository layer; tables are queried where they're used.
- **MCP** — `api/src/services/mcp-server.ts`, `mcp-tools.ts`, `mcp-resources.ts`, `mcp-fs.ts`. The HTTP entry point is `/mcp` (routes in `api/src/routes/mcp/index.ts`); auth uses either a per-host API key or an `MCP_OPERATOR_TOKEN` bearer (operator capability). MCP routes use a fourth preflight based on `mcp_session_tokens` bearer tokens.
- **Security primitives** — `api/src/security/`. `secret-box.ts` (libsodium XSalsa20-Poly1305, `sbox:v1` envelope, compatible with legacy PHP), `keyring.ts` (encryption key set + rotation), `password.ts` (argon2id with legacy bcrypt/phpass verification + transparent rehash on login), `mtls.ts` (proxy-forwarded mTLS header parsing), and `hash.ts` (sha256 helpers).

## The runner sidecar

The `runner/` directory contains a small FastAPI service (`runner/app.py`) that actually talks to OpenAI and Anthropic. The orchestrator itself never calls those APIs; it delegates to the runner over a shared-secret HTTP channel. In the compose stack the runner runs as the service named `auth-runner`. `AUTH_RUNNER_URL` has no default in `api/src/env.ts` (it's optional there); `docker-compose.yml` sets it to `http://auth-runner:8080/verify` for the shipped stack — pointing directly at the `/verify` endpoint, not a generic base URL. `AUTH_RUNNER_SHARED_SECRET` authenticates the calls.

Verification no longer happens on the request/boot path. `runner-client.ts` is the low-level HTTP client (`/verify`, `/verify-claude`, plus a few AI-assist endpoints); `runner-validation.ts` resolves and validates the canonical auth payload for an engine; `canonical-auth-store.ts` ties the two together (`ensureServedVerification`) to decide whether the currently-served payload is still good. A background worker — `startAuthVerificationWorker` in `api/src/ops/auth-verification-worker.ts`, started from `server.ts` after routes are registered — re-checks each engine on an interval set by `AUTH_RUNNER_VERIFY_WORKER_INTERVAL_SECONDS` (default 300 s) and refreshes the stored verdict once it's older than `AUTH_RUNNER_VERIFY_TTL_SECONDS` (default 900 s); hosts fetching auth just read the stored verdict instead of waiting on a live probe. Running a prompt on demand is a separate, admin-triggered operation — `RunnerProxyService.run()` in `runner-proxy.ts`, behind `POST /admin/runner/run` / `run-claude`. Keeping the runner split from the orchestrator lets you upgrade its SDK versions without touching the orchestrator.

## The wrappers

`cdx` and `clx` are static Go binaries built from `wrappers/cdx/` and `wrappers/clx/` (one Go module per engine, a shared `wrappers/go.work`). When you onboard a host, the orchestrator emits a small POSIX `sh` bootstrap transition launcher plus a typed signed JSON config produced by `wrapper-config.ts` (signed with Ed25519, key generated by `scripts/wrapper-v2-init-keys.sh` and persisted in the `wrapper_signing_keys` table). The transition launcher fetches the config + the right binary for the host's platform, verifies SHA256, and `exec`s the binary. The binary does three things on every run:

1. Verifies the Ed25519 signature on its config against the public key it embeds at build time.
2. Hits `/auth`, `/agents/retrieve`, `/config/retrieve` to refresh local state (best-effort, never blocks).
3. Execs the upstream `codex` / `claude` CLI with the prepared env.

The binary self-updates if `wrapper.auto_update` is true in its config: when the server-side SHA256 differs from the local copy, the bootstrap transition launcher downloads the new binary, verifies its hash, and atomically replaces it.

## Admin websocket

Live admin events stream over `/admin/ws` using `@fastify/websocket` (see `api/src/ws/server.ts`). The websocket runs in-process — no separate daemon — and requires the same admin session cookie used elsewhere. Services publish events through the singleton `wsPublisher` in `api/src/ws/publisher.ts` (`wsPublisher.publish(type, payload)`); the WS handler fans them out to every connected client. The admin UI discovers the URL via `GET /admin/ws/info`. `ADMIN_WS_ENABLED` defaults to `false` in `api/src/env.ts`, but the shipped `docker-compose.yml` overrides it to `1`, so the websocket is on by default in a standard compose deployment; set it to `0` to disable, in which case the UI falls back to polling.

## Database

Schema is MySQL 8.4, defined as Drizzle table builders in `api/src/db/schema.ts` — that file is the single source of truth. The compose service is named `mysql` and uses the `mysql:8.4` image; there is no MariaDB image in the stack. Schema changes are hand-written SQL in `api/src/db/migrations/`, applied by the runner in `api/src/db/migrator.ts`: automatically at API boot (`RUN_MIGRATIONS_ON_BOOT`, default `true`, via `api/src/ops/boot-migrations.ts`), explicitly by `scripts/deploy.sh`, and on demand through `node dist/migrate.js`. Applied versions live in `schema_migrations`. `RUN_BACKFILLS_ON_BOOT` is still declared but unread. Do not use `drizzle:push` against a live database. Tables you will care about most:

- `hosts` — one row per registered host; state like `api_key_hash`, `secure`, `insecure_enabled_until`, per-engine version strings, and the IP binding fields `ip4`, `ip6`, `allow_roaming_ips`, `reverse_dns_mode` (there is no single `ip_binding` column).
- `auth_entries` / `auth_payloads` — the encrypted canonical auth, versioned.
- `host_auth_digests` — per-host snapshots so sync-status can say "nothing changed" cheaply.
- `admin_users`, `admin_sessions`, `admin_passkeys`, `admin_password_resets` — the admin identity stack.
- `coord_projects`, `coord_project_notes`, `coord_project_todos`, `coord_project_files`, `coord_project_feedback`, `coord_project_events` — the Projects module (all `coord_`-prefixed).
- `chatgpt_usage_snapshots` — ChatGPT quota snapshots.
- `mcp_session_tokens`, `mcp_access_logs`, `mcp_memories` — MCP identity, access log, and memory store.
- `wrapper_signing_keys` — Ed25519 signing keys used by `wrapper-signing-key.ts`.

The MySQL container lives next to the app in `docker-compose.yml`; backups are your responsibility.

## Engine support

Everything that can vary by engine takes an `Engine` value from `api/src/util/engine.ts` — `ENGINE_CODEX` or `ENGINE_CLAUDE`. A single host can run either, both, or neither; the wrappers report their capabilities back on register. The dashboard, config builder, and the sync flow all branch on engine where needed.

## Source references

- api/src/server.ts (Fastify boot, plugin order, lifecycle)
- api/src/routes/index.ts (route mounting tree)
- api/src/routes/admin/pages/static.ts (SPA shell + adminSpaHtmlPreHandler)
- api/src/services/host-auth.ts (auth distribution, host lifecycle)
- api/src/services/host-management.ts (registration, mutations)
- api/src/services/wrapper-config.ts, api/src/services/wrapper-signing-key.ts (signed per-host config + Ed25519 keys)
- api/src/services/runner-validation.ts (resolves + validates canonical auth payloads)
- api/src/services/runner-client.ts (low-level HTTP client to the auth-runner)
- api/src/services/canonical-auth-store.ts (ties validation + runner verify + digests together)
- api/src/services/runner-proxy.ts (admin-triggered run / seed-command actions)
- api/src/ops/auth-verification-worker.ts (background re-verification loop, replaces startup-path checks)
- api/src/services/mcp-server.ts (JSON-RPC dispatch)
- api/src/ws/server.ts, api/src/ws/publisher.ts (admin WS + event bus)
- api/src/db/schema.ts (Drizzle schema, single source of truth)
- api/src/env.ts (env var defaults, incl. ADMIN_WS_ENABLED, AUTH_RUNNER_VERIFY_* )
- docker-compose.yml (compose-level env var overrides, e.g. ADMIN_WS_ENABLED, AUTH_RUNNER_URL)
- runner/app.py (FastAPI verify / exec endpoints)
- wrappers/cdx, wrappers/clx (Go modules — host wrappers)
- scripts/wrapper-v2-init-keys.sh (Ed25519 keypair bootstrap)
