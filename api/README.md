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

## Tests and coverage

`npm test` is the fast database-free tier. Real-MySQL suites are collected but
skip unless `TEST_USE_DB=1` is set. CI runs typecheck, lint, this fast tier and
the build, then enforces coverage in a separate MySQL 8.4 job.

The suite needs only `api/` dependencies. Some tests read or import frontend
sources, but none require `frontend/node_modules` or a generated
`frontend/.svelte-kit/`: `vitest.config.ts` passes esbuild a fixed
`tsconfigRaw` (the esbuild-relevant fields of `api/tsconfig.json`), so Vite
never resolves `frontend/tsconfig.json` and its `./.svelte-kit/tsconfig.json`
base. No `svelte-kit sync` is needed in a clean checkout or in CI.

For the complete coverage gate, configure `DB_HOST`, `DB_PORT`, `DB_DATABASE`,
`DB_USERNAME`, `DB_PASSWORD` and `ENCRYPTION_ACTIVE_KEY` for an empty disposable
MySQL database, then run from `api/`:

```sh
npm run test:db:setup
npm run migrate
npm run test:coverage
```

`test:coverage` enables real-DB tests and runs every test file serially because
the migration tests share a database and deliberately change its schema. It
enforces the existing global floors: 65% lines/statements, 74% functions and
73% branches. Use `npm run test:db` for the integration tier alone. Never point
these commands at a production database. Fixtures prepare the current schema
through the migration runner; tests for historical migrations deliberately
construct their old schema and must restore the current schema afterward.

The TypeScript emit target is ES2022, matching the test transformer; the ES2024
library declarations remain available for the supported Node 22 runtime.

## Environment

Reads the parent project's `.env`. Required: `ENCRYPTION_ACTIVE_KEY`, `DB_*`.
New keys: `LISTEN_PORT` (default 8080), `LISTEN_HOST`, `LOG_LEVEL`,
`LOG_PRETTY`, `STATIC_ROOT` (defaults to `../public/admin`).
