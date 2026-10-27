# @codex-orchestrator/api

Node 22 + Fastify 5 + Drizzle + TypeScript backend for the Codex Orchestrator.

Serves the fleet API, SvelteKit admin SPA and inference gateway surfaces for
Codex (`cdx`), Claude (`clx`) and Grok (`cgx`). The active contracts are
[API](../docs/interface-api.md), [database](../docs/interface-db.md) and
[MCP](../docs/MCP.md). Historical PHP compatibility is retained only where those
contracts describe it.

## Layout

- `src/server.ts` — acquires storage/database ownership, hydrates current state, composes services, registers Fastify plugins/routes and starts maintenance.
- `src/control-plane/` — sole API owner, command serialization, receipts/outbox, connection presence, bounded current state and protected response completion.
- `src/ops/` — boot/migrations, owner maintenance obligations, provider usage, retention and shutdown. Quota refresh runs in the API owner; the standalone quota writer is retired.
- `src/db/schema.ts` — Drizzle mirror of the current schema; idempotent SQL under `src/db/migrations/` is applied by the migration runner, not `drizzle:push`. See [database operations](src/db/README.md).
- `src/security/` — secret-box (libsodium, `sbox:v1` compat), password (bcrypt/phpass/argon2), keyring.
- `src/http/envelope/` — three envelope formatters (standard / openai / anthropic).
- `src/http/plugins/` — auth preflights, request-id, CORS.
- `src/routes/` — resource-group routes mounted by `src/routes/index.ts`.
- `src/services/` — domain facades and cohesive service slices, including engine accounts/auth, policy/config, messaging, workflows, projects, secrets and wrapper delivery.
- `src/ws/` — admin WebSocket server (`/admin/ws`) + event publisher.

Current state is hydrated under a database-specific MySQL named lock and a
shared-storage kernel lock. Durable commands commit before publishing state or
acknowledging results; ownership loss fences the process. Read
[owner architecture](../docs/control-plane-owner.md) and
[cutover/recovery](../docs/owner-cutover.md) before changing persistence or rollout.

## Local dev

```sh
cd api
npm install
node --env-file=../.env --import tsx --watch src/server.ts
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

The server validates `process.env` in `src/env.ts`; it does not load `.env`
itself. Docker Compose injects configuration; the local command above explicitly
loads the parent `.env`. `npm run dev` uses the already supplied environment.
Provide the `DB_*` connection values and `ENCRYPTION_ACTIVE_KEY` (or the legacy
`AUTH_ENCRYPTION_KEY` alias). Keep the encryption key consistent with stored data.
`LISTEN_PORT` defaults to 8080 and `LISTEN_HOST` to `0.0.0.0`; `LOG_LEVEL`,
`LOG_PRETTY` and `STATIC_ROOT` control logging and the admin asset directory
(default `public/admin` under the repository root). See
[installation configuration](../docs/INSTALL.md) for the full environment setup.
