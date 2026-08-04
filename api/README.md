# @codex-orchestrator/api

Node 22 + Fastify 5 + Drizzle + TypeScript backend for the Codex Orchestrator.

Replaces the prior PHP monolith under `../src/` and the `public/index.php` router.
The HTTP API contract and MySQL schema are preserved exactly so existing wrappers
(`cdx`, `clx`), the SvelteKit WebUI, and OpenAI/Anthropic-SDK consumers see no
behavior change.

## Layout

- `src/server.ts` — Fastify bootstrap and plugin registration.
- `src/db/schema.ts` — Drizzle schema mirroring every legacy PHP migration.
- `src/security/` — secret-box (libsodium, `sbox:v1` compat), password (bcrypt/phpass/argon2), keyring.
- `src/http/envelope/` — three envelope formatters (standard / openai / anthropic).
- `src/http/plugins/` — auth preflights, request-id, CORS.
- `src/routes/` — one sub-tree per resource group; each exports `register(app)`.
- `src/services/` — domain layer (no god-services; ~30 focused services).
- `src/ws/` — admin WebSocket server (`/admin/ws`) + event publisher.

## Local dev

```sh
cd api
npm install
npm run dev      # tsx watch
npm run test
npm run typecheck
npm run build    # esbuild -> dist/server.js
```

## Environment

Reads the parent project's `.env`. Required: `ENCRYPTION_ACTIVE_KEY`, `DB_*`.
New keys: `LISTEN_PORT` (default 8080), `LISTEN_HOST`, `LOG_LEVEL`,
`LOG_PRETTY`, `STATIC_ROOT` (defaults to `../public/admin`).
