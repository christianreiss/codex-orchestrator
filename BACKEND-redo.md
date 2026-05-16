# Codex Orchestrator — Complete API Backend Rewrite

## Context

The current backend is a ~30,000-line PHP 8.2 monolith with no framework. `public/index.php` is a 1,042-line script that loads `.env`, instantiates ~50 repositories and ~45 services by hand, registers 241 routes against a regex router, and dispatches into three different response-envelope formats by URL-prefix sniffing. `AuthService` alone is over a thousand lines and bundles host registration, API-key validation, IP-roaming logic, rate limiting, insecure-mode approval, reverse-DNS validation, version snapshotting, wrapper callback, and token-usage tracking. Repositories speak raw SQL strings against PDO with no query builder or compile-time schema. Encryption uses libsodium `crypto_secretbox` via a hand-rolled `SecretBox` class with an `sbox:v1:[kid=…]:<b64>` envelope. The admin WebSocket uses an external server discovered via `ADMIN_WS_PUBLIC_URL`. There is essentially no automated test coverage of the HTTP layer.

It works, but every change costs: a new column means editing a repository, a migration, a service, two controllers, and praying nothing escapes the manual SQL. Adding a fifth provider integration means a new envelope class, a new dispatch branch in `public/index.php`, and N new methods on the adapter contract. Auth bugs hide in the AuthService haystack. There is no DI container, no structured logging, no request validation layer, no scheduled task framework.

The **HTTP API contract is preserved exactly** during this rewrite — every existing endpoint keeps its URL, method, request body, response shape, headers, error envelope, and status code. External clients (the new SvelteKit WebUI, the cdx/clx wrappers, OpenAI-SDK consumers hitting `/v1/*`, Anthropic-SDK consumers hitting `/anthropic/v1/*`, MCP clients) MUST not notice the cutover. The **database schema is preserved exactly** — all 40+ tables and their encrypted-at-rest columns are read by the new code without re-migration.

Outcome: a typed Fastify + Drizzle + Node 22 backend under `api/` that replaces every line of PHP under `src/`. The same MySQL schema. The same `sbox:v1` envelope (now decoded by `libsodium-wrappers`). One unified internal `Response` type that a route-level formatter renders into the right envelope. Structured logs via pino. Vitest contract suite that replays the existing OpenAI/Anthropic/admin/host API surface against the new server. A single deploy artifact (`node dist/server.js`) replacing PHP-FPM.

---

## Tech stack (resolved)

| Layer | Choice | Rationale |
|---|---|---|
| Runtime | **Node.js 22 LTS** | Long-term support, native `fetch`, `Worker`, performant ESM, mature ecosystem. |
| HTTP | **Fastify 5** | High-throughput Pino-integrated server. First-class TypeScript types, schema-driven validation, lifecycle hooks for envelope formatting, native WebSocket via `@fastify/websocket`. |
| Language | **TypeScript 5.7** (strict) | Catches the entire shape of every endpoint at compile time. |
| Database driver | **mysql2/promise** | Stable, fastest Node MySQL driver. Connection pooling. The orchestrator's MySQL schema is preserved verbatim. |
| Query builder | **Drizzle ORM 0.36** (used as typed query builder, not full ORM) | Schema-first TypeScript types; SQL-like API (`db.select().from(hosts).where(...)`); compile-time joins; no lazy loading, no hydration tricks. Drizzle Kit for new migrations going forward. |
| Validation | **zod 3.x** | Schema-driven validation, infer-able types, Fastify integrates natively. |
| Logging | **pino** + **pino-http** | Structured JSON logs, sub-µs overhead, request correlation, log levels via env. |
| Crypto | **libsodium-wrappers** | Pure-WASM libsodium. **Bit-compatible with PHP's `sodium_crypto_secretbox`** — same nonce + ciphertext layout — so the existing `sbox:v1` envelope is read by the new code without data migration. |
| Password hashing | **@node-rs/argon2** | Argon2id native binding. Replaces the existing phpass/bcrypt hashes on **next login**: read the stored hash, verify it (still works because the old hashes stay valid; we add an argon2 verifier alongside the legacy bcrypt verifier and rehash on successful login). |
| WebAuthn | **@simplewebauthn/server** | Server-side counterpart of the `@simplewebauthn/browser` already shipped in the new WebUI. Reads the existing `admin_passkeys.public_key` column verbatim. |
| WebSocket | **@fastify/websocket** | Native to Fastify. Replaces the external WS server referenced by `ADMIN_WS_PUBLIC_URL` — Node hosts it directly. |
| Rate limiting | **Custom (existing schema)** | Keep the `ip_rate_limits` table verbatim; reimplement the `hit(ip, bucket, limit, window, block)` algorithm. The rate limit data persists across PHP→Node cutover. |
| Cookies | **@fastify/cookie** | Reads/writes the existing `codex_admin_session` cookie shape. |
| CORS | **@fastify/cors** | Replaces the hand-rolled CORS helpers. Per-route overrides. |
| File uploads | **@fastify/multipart** | For `/admin/auth/upload` etc. |
| Static files | **@fastify/static** | Serves `public/admin/` (the built SvelteKit SPA) and `public/admin/manual/`. Replaces the PHP gateway entirely. |
| Tests | **Vitest 2** + **light-my-request** | Vitest for unit, Fastify's `inject()` for in-process HTTP integration tests, no need for a live server during tests. |
| Build | **tsx** for dev, **esbuild** for prod bundle | One `dist/server.js` artifact + a `package.json` for runtime deps. |
| Dev tools | **ESLint 9** flat config + **Prettier 3** | Standard config. |
| Migrations | **Drizzle Kit** (push + generate workflows) | New migrations go forward via Drizzle Kit. The 17 existing PHP migrations stay in `legacy-php-migrations.bak/` for one release as a reference, then are deleted. The Drizzle schema is the new source of truth. |
| Process | **systemd** unit (Docker too) | Single `node dist/server.js` invocation. PHP-FPM is removed. |

---

## What gets deleted

In commit 1 of the foundation worktree (`chore(api): delete PHP backend in preparation for Node rewrite`):

```
src/                                                # The entire PHP source tree
  Http/                                             # 18 controllers + helpers + envelope classes
  Services/                                         # 45+ services
  Repositories/                                     # 48 repositories
  Security/                                         # SecretBox, EncryptionKeyManager, RateLimiter
  Adapters/                                         # RunnerBackendAdapter, ClaudeBackendAdapter, NullBackendAdapter
  Mcp/                                              # MCP server implementation
  Contracts/                                        # PHP interfaces
  Exceptions/                                       # HttpException, ValidationException
  Support/                                          # Engine, Installation, Mailer, etc.
  Migrations/                                       # 17 PHP migration classes
  Config.php, Database.php, DatabaseMigrator.php

public/index.php                                    # 1,042-line router
public/admin/index.php                              # PHP gateway (the SPA gateway is replaced by Fastify)
public/admin/mtls-debug.php                         # If still present
public/admin/error.css                              # Tiny error stylesheet — Fastify renders errors itself

composer.json
composer.lock
vendor/
phpunit.xml.dist
phpstan.neon.dist
phpstan-baseline.neon
tests/                                              # All PHPUnit tests (replaced by Vitest under api/test/)

caddy/Caddyfile (the PHP-FPM directive lines)       # Modified in the same commit to reverse-proxy to Node
Dockerfile (the php-fpm stages)                     # Replaced with a node:22-alpine Dockerfile
docker-compose.yml (the php-fpm service)            # Replaced with a node service
```

Kept:
- `public/admin/_app/`, `public/admin/index.html`, `public/admin/favicon.svg`, `public/admin/manual/` — built SPA + content; served by Fastify static handler.
- `wrappers/` — Go workspace (CDX-redo target; orthogonal).
- `bin/cdx`, `bin/clx`, `bin/cdx.d/`, `bin/clx.d/`, `scripts/build-{cdx,clx}.sh` — legacy wrappers, owned by CDX-redo.
- `storage/` — runtime state (encryption keys, MySQL data outside the container, wrapper v2 binaries + cache).
- `docs/`, `README.md`, `AGENTS.md`, `DESIGN.md`, `CHANGELOG.md`, `LICENSE` — updated in Phase 3, not deleted.
- `.env`, `.env.example` — the env-var contract is preserved (see "Environment variables" below).
- `.github/workflows/`, `Makefile` — updated to drop PHP CI, add Node CI.

---

## What gets created

```
api/                                                # NEW: TypeScript project root
├── package.json                                    # Node 22 engine pin, scripts (dev, build, test, lint, migrate)
├── tsconfig.json                                   # strict, ES2024, NodeNext modules
├── drizzle.config.ts                               # MySQL driver, schema path, migration output dir
├── vitest.config.ts
├── eslint.config.js
├── .prettierrc
├── Dockerfile                                      # node:22-alpine, multi-stage build
├── README.md
├── src/
│   ├── server.ts                                   # Fastify bootstrap, plugin registration, listen()
│   ├── env.ts                                      # zod-validated process.env. Boot-time fail-fast for missing required vars.
│   ├── db/
│   │   ├── client.ts                               # mysql2 pool + Drizzle init
│   │   ├── schema.ts                               # Drizzle table definitions for every existing table
│   │   ├── migrations/                             # Drizzle-Kit migrations going forward (initial = no-op)
│   │   └── README.md                               # Notes the schema is mirror of the legacy PHP migrations
│   ├── http/
│   │   ├── envelope/
│   │   │   ├── standard.ts                         # { status: 'ok'|'error', data?, message?, errors? }
│   │   │   ├── openai.ts                           # { error: { message, type, code?, param? } }
│   │   │   ├── anthropic.ts                        # { type: 'error', error: { message, type, code? } }
│   │   │   └── select.ts                           # Picks envelope by route prefix
│   │   ├── errors.ts                               # ApiError, OpenAiApiError, AnthropicApiError classes
│   │   ├── reply.ts                                # ok(data), fail(message, code, status), stream(generator)
│   │   ├── plugins/
│   │   │   ├── envelope.ts                         # onSend hook that runs select(routeUrl) and rewrites payload
│   │   │   ├── auth-host.ts                        # Preflight: resolve Bearer/X-API-Key → host record on request.host
│   │   │   ├── auth-admin.ts                       # Preflight: resolve session cookie → admin user on request.admin
│   │   │   ├── auth-mtls.ts                        # Parses X-MTLS-* headers (when ADMIN_ACCESS_MODE=mtls)
│   │   │   ├── rate-limit.ts                       # Global rate limiter (preHandler)
│   │   │   ├── client-ip.ts                        # Resolves real client IP from X-Forwarded-*
│   │   │   ├── request-id.ts                       # Correlation ID propagation
│   │   │   └── cors.ts                             # Per-route CORS (open for /v1/*, /anthropic/v1/*; locked elsewhere)
│   │   └── stream/
│   │       ├── openai-sse.ts                       # chat.completion.chunk SSE emitter
│   │       └── anthropic-sse.ts                    # message_start / content_block_* / message_stop SSE
│   ├── routes/                                     # One sub-tree per resource group; each exports register(fastify)
│   │   ├── auth/                                   # /auth, /sync/{status,bootstrap}
│   │   ├── host/                                   # /host/{users,lane}, /usage, /versions, /cron/{check,report}
│   │   ├── install/                                # /install/:token, /seed/auth/:token (GET + POST)
│   │   ├── cli-auth/                               # /cli/auth/{start,poll,lookup,approve,deny,verify}
│   │   ├── wrapper-v2/                             # /wrapper, /wrapper/v2/{meta,config,download,manifest,bin/*}
│   │   ├── mcp/                                    # /mcp (GET probe, POST JSON-RPC), /mcp/memories/*
│   │   ├── v1/                                     # OpenAI-compat: /v1/chat/completions, /v1/responses, /v1/completions, /v1/embeddings, /v1/models
│   │   ├── anthropic-v1/                           # /anthropic/v1/{messages,completions,embeddings,responses,models}
│   │   ├── admin/
│   │   │   ├── auth/                               # /admin/auth/{login,logout,passkey/*,password/*}, /admin/passkeys/*
│   │   │   ├── users/                              # /admin/users/*, /admin/users/wipe
│   │   │   ├── hosts/                              # /admin/hosts/*, /admin/insecure-{approvals,domain-allows}/*
│   │   │   ├── overview/                           # /admin/overview, /admin/usage, /admin/tokens, /admin/runner/*, /admin/ws/info, /admin/logs, /admin/chatgpt/*, /admin/claude/{version,usage/history}
│   │   │   ├── settings/                           # 20+ endpoints (api/state, theme, reverse-dns, auto-update, insecure-approval, quota-mode, prune-policy, log-retention, scaling, cdx-silent, codex-version, claude/{state,version,settings}, openai/state, versions/check)
│   │   │   ├── config/                             # /admin/config/{render,store}, /admin/agents/*, /admin/skills/*, /admin/mcp/{memories,logs}
│   │   │   ├── projects/                           # /admin/projects/*
│   │   │   ├── keys/                               # /admin/openai/keys/*, /admin/claude/keys/*
│   │   │   ├── joplin/                             # /admin/joplin/{config,test,sync}
│   │   │   ├── manual/                             # /admin/manual/{manifest,search,article/:slug}
│   │   │   └── pages/                              # Static-file fallback for /admin and /admin/* (serves built SPA)
│   │   └── projects-client/                        # Host-facing /projects/*, /skills/*, /agents/retrieve, /config/retrieve (client view of the same data — separate auth context)
│   ├── services/                                   # Domain layer. Each owns one bounded thing. NO god-services.
│   │   ├── host-auth.ts                            # was AuthService — split into 5 services. This one is just "validate api key → host record"
│   │   ├── host-registration.ts                    # was AuthService::register, AuthService::handleAuth's store path
│   │   ├── host-sync.ts                            # was AuthService::syncStatus + syncBootstrap
│   │   ├── insecure-window.ts                      # InsecureHostWindowService verbatim, retyped
│   │   ├── version-snapshot.ts                     # was AuthService::versionSummary + availableClientVersion
│   │   ├── token-usage.ts                          # was TokenUsageTracker + AuthService::recordTokenUsage
│   │   ├── auth-failure-tracker.ts                 # Just the rate limiter bucket for auth_fail
│   │   ├── admin-auth.ts                           # Login / session lifecycle
│   │   ├── admin-passkey.ts                        # WebAuthn registration + login
│   │   ├── admin-password.ts                       # Change / reset / verification
│   │   ├── admin-events.ts                         # Audit log writer (was AdminEventRepository as a service)
│   │   ├── admin-users.ts                          # CRUD
│   │   ├── projects.ts                             # Projects + notes + todos + files + feedback (the existing ProjectCoordinationService split apart)
│   │   ├── project-drafts.ts                       # AI-assist for projects (runner client)
│   │   ├── skills.ts
│   │   ├── skill-drafts.ts
│   │   ├── skill-manifest.ts
│   │   ├── agents.ts
│   │   ├── memories.ts
│   │   ├── memory-drafts.ts
│   │   ├── client-config.ts                        # Wrapper-facing config generation
│   │   ├── config-normalizer.ts
│   │   ├── chatgpt-usage.ts                        # Fetch+cache from chatgpt.com
│   │   ├── claude-usage.ts
│   │   ├── usage-scaling.ts
│   │   ├── dashboard-stats.ts
│   │   ├── joplin-client.ts                        # HTTP client for Joplin
│   │   ├── joplin-cache.ts                         # DB-backed cache
│   │   ├── joplin-skills.ts
│   │   ├── runner-client.ts                        # ex-RunnerVerifier
│   │   ├── runner-validation.ts                    # ex-RunnerValidationService
│   │   ├── openai-keys.ts                          # API key issuance + validation
│   │   ├── reverse-dns.ts                          # PTR validator
│   │   ├── cli-auth.ts                             # Device-code flow
│   │   ├── insecure-domains.ts                     # Domain allow-list management
│   │   ├── mcp-server.ts                           # Port of src/Mcp/McpServer.php
│   │   ├── mcp-tools.ts                            # Tool registry + dispatch
│   │   ├── mcp-resources.ts                        # Resource URI routing
│   │   ├── wrapper-bin-registry.ts                 # Reads storage/wrapper/v2/bin/<engine>/<os>-<arch>/manifest.json
│   │   ├── bake-cache.ts                           # Bridges to ConfigBaker outputs from CDX-redo
│   │   ├── installation-id.ts                      # storage/installation_id read/write
│   │   ├── mailer.ts                               # SMTP via nodemailer
│   │   └── adapters/
│   │       ├── runner-openai.ts                    # POST to runner /exec for OpenAI-shaped completions
│   │       ├── runner-claude.ts                    # POST to runner /exec for Anthropic-shaped messages
│   │       └── null.ts                             # No-op for tests
│   ├── security/
│   │   ├── secret-box.ts                           # encrypt(plaintext, kid?) → 'sbox:v1:kid=…:<b64>'; decrypt('sbox:v1:…') → string
│   │   ├── keyring.ts                              # Reads ENCRYPTION_* env, loads active + legacy keys
│   │   ├── password.ts                             # verify(stored, candidate): supports bcrypt + phpass + argon2; rehashes to argon2 on success
│   │   ├── hash.ts                                 # sha256(string), constant-time compare
│   │   └── mtls.ts                                 # Parse X-MTLS-Fingerprint, X-MTLS-Subject from upstream proxy
│   ├── ws/
│   │   ├── server.ts                               # @fastify/websocket; per-client subscribe/unsubscribe
│   │   ├── publisher.ts                            # publish(eventType, payload) — called from any service after a mutation
│   │   ├── auth.ts                                 # Admin session cookie validation on WS upgrade
│   │   └── events.ts                               # Event type catalog (mirrors frontend's lib/ws/events.ts)
│   ├── util/
│   │   ├── log.ts                                  # pino instance, child loggers
│   │   ├── timestamp.ts                            # ISO 8601 + relative formatting
│   │   ├── engine.ts                               # Engine = 'codex' | 'claude'
│   │   ├── api-key-helpers.ts                      # generateKey(prefix), hashKey, parseBearer
│   │   ├── retry.ts                                # Exponential backoff
│   │   └── stream-helpers.ts                       # AsyncIterable utilities
│   └── ops/
│       ├── boot-checks.ts                          # On boot: ensure encryption key present, DB reachable, storage writable
│       └── shutdown.ts                             # Graceful drain (Fastify .close())
└── test/
    ├── helpers/
    │   ├── build-app.ts                            # Boot a Fastify instance for tests with mocked services
    │   ├── factories/                              # Type-safe factories for every table (uses Drizzle types)
    │   └── seed.ts                                 # Reset + seed test DB
    ├── unit/                                       # Pure unit tests of services
    ├── integration/                                # Vitest tests that hit Fastify via inject()
    └── contract/                                   # Reads tests/contract/*.json snapshots and validates response shapes match the old PHP backend
```

---

## Drizzle schema mirror

The schema lives at `api/src/db/schema.ts`. It mirrors every table from the legacy PHP `src/Migrations/` exactly — same names, columns, types, indexes, foreign keys. Drizzle Kit's `generate` command emits a no-op initial migration (the DB already matches). All future schema evolution goes through Drizzle Kit.

Sample (illustrative):

```ts
import { mysqlTable, bigint, varchar, text, tinyint, char, timestamp, longtext, index, uniqueIndex } from 'drizzle-orm/mysql-core';

export const hosts = mysqlTable('hosts', {
  id: bigint('id', { mode: 'number', unsigned: true }).primaryKey().autoincrement(),
  apiKey: char('api_key', { length: 64 }).notNull(),
  apiKeyHash: char('api_key_hash', { length: 64 }),
  apiKeyEnc: longtext('api_key_enc'),
  fqdn: varchar('fqdn', { length: 255 }).notNull(),
  status: varchar('status', { length: 32 }).notNull().default('active'),
  secure: tinyint('secure').notNull().default(1),
  vip: tinyint('vip').notNull().default(0),
  curlInsecure: tinyint('curl_insecure').notNull().default(0),
  allowRoamingIps: tinyint('allow_roaming_ips').notNull().default(0),
  scalingExempt: tinyint('scaling_exempt').notNull().default(0),
  autoUpdate: tinyint('auto_update').notNull().default(1),
  modelOverride: varchar('model_override', { length: 128 }),
  reasoningEffortOverride: varchar('reasoning_effort_override', { length: 32 }),
  claudeModelOverride: varchar('claude_model_override', { length: 128 }),
  lanePreference: varchar('lane_preference', { length: 32 }),
  wrapperVersion: varchar('wrapper_version', { length: 64 }),
  clientVersion: varchar('client_version', { length: 64 }),
  installationId: varchar('installation_id', { length: 64 }),
  configVersion: bigint('config_version', { mode: 'number', unsigned: true }).notNull().default(0),
  wrapperTrack: varchar('wrapper_track', { length: 16 }).notNull().default('legacy'),
  expiresAt: varchar('expires_at', { length: 40 }),
  lastSeen: varchar('last_seen', { length: 40 }),
  createdAt: varchar('created_at', { length: 40 }).notNull(),
  updatedAt: varchar('updated_at', { length: 40 }).notNull(),
}, (t) => ({
  fqdnUnique: uniqueIndex('hosts_fqdn_unique').on(t.fqdn),
  apiKeyHashIdx: index('hosts_api_key_hash_idx').on(t.apiKeyHash),
}));
```

Every other table follows the same pattern. Drizzle's `select` / `insert` / `update` / `delete` queries are fully typed and inferred from this schema. Joins are explicit (`leftJoin(...)`). No lazy-loaded relations; no entity hydration; no change tracking. The shape stays SQL-shaped.

---

## Crypto compatibility

The single hardest constraint in this rewrite is reading existing encrypted data. The PHP `SecretBox` uses `sodium_crypto_secretbox(plaintext, nonce, key)` (XSalsa20-Poly1305) and encodes:

- Legacy: `sbox:v1:<base64(nonce || ciphertext)>`
- Modern: `sbox:v1:kid=<url-encoded-kid>:<base64(nonce || ciphertext)>`

`api/src/security/secret-box.ts` reproduces this byte for byte using `libsodium-wrappers`:

```ts
import sodium from 'libsodium-wrappers';

await sodium.ready;
const NONCE_BYTES = sodium.crypto_secretbox_NONCEBYTES;     // 24
const KEY_BYTES = sodium.crypto_secretbox_KEYBYTES;         // 32

export function encrypt(plaintext: string, kid: string, key: Uint8Array): string {
  const nonce = sodium.randombytes_buf(NONCE_BYTES);
  const ct = sodium.crypto_secretbox_easy(sodium.from_string(plaintext), nonce, key);
  const payload = sodium.to_base64(concat(nonce, ct), sodium.base64_variants.ORIGINAL);
  return `sbox:v1:kid=${encodeURIComponent(kid)}:${payload}`;
}

export function decrypt(envelope: string, keyring: Keyring): string {
  const m = envelope.match(/^sbox:v1:(?:kid=([^:]+):)?(.+)$/);
  if (!m) throw new SecretBoxError('not_an_envelope');
  const kid = m[1] ? decodeURIComponent(m[1]) : 'legacy';
  const buf = sodium.from_base64(m[2], sodium.base64_variants.ORIGINAL);
  const nonce = buf.slice(0, NONCE_BYTES);
  const ct = buf.slice(NONCE_BYTES);
  for (const key of keyring.keysFor(kid)) {
    try { return sodium.to_string(sodium.crypto_secretbox_open_easy(ct, nonce, key)); }
    catch { /* try next key */ }
  }
  throw new SecretBoxError('decrypt_failed');
}
```

Tested with a small fixture of envelopes produced by the PHP code; the Node code MUST decrypt all of them. Round-trip tests verify the inverse.

Password hashing has three legacy formats in production: bcrypt (`$2y$…`), phpass (`$P$…`), and possibly plain (never — we reject). `api/src/security/password.ts` dispatches on prefix:

```ts
export async function verify(stored: string, candidate: string): Promise<{ ok: boolean; rehash?: string }> {
  if (stored.startsWith('$argon2id$')) {
    return { ok: await argon2.verify(stored, candidate) };
  }
  if (stored.startsWith('$2y$') || stored.startsWith('$2a$') || stored.startsWith('$2b$')) {
    const ok = await bcrypt.compare(candidate, stored);
    return ok ? { ok, rehash: await argon2.hash(candidate) } : { ok: false };
  }
  if (stored.startsWith('$P$') || stored.startsWith('$H$')) {
    const ok = phpass.check(candidate, stored);
    return ok ? { ok, rehash: await argon2.hash(candidate) } : { ok: false };
  }
  return { ok: false };
}
```

The login path: verify → if `rehash` returned, update the user row → user is now argon2.

---

## Response envelopes

Three envelope shapes are preserved verbatim from the existing API contract. Internally the codebase uses one type:

```ts
export type Response<T = unknown> =
  | { ok: true; data: T; status?: number; headers?: Record<string, string> }
  | { ok: false; error: ApiError };

export class ApiError extends Error {
  constructor(
    public message: string,
    public code: string = 'error',
    public status: number = 400,
    public type: string = 'api_error',
    public param?: string,
  ) { super(message); }
}
```

Handlers return `Response<T>` (or throw `ApiError` — same effect via the error hook). A Fastify `onSend` hook (`api/src/http/plugins/envelope.ts`) picks the right formatter based on `request.url`:

```ts
function selectFormatter(url: string): EnvelopeFormatter {
  if (url.startsWith('/anthropic/v1/')) return anthropicFormatter;
  if (url.startsWith('/v1/')) return openaiFormatter;
  return standardFormatter;
}
```

Each formatter knows how to render both success and error payloads in its shape:

- `standard`: `{ status: 'ok', data: <T> }` on success; `{ status: 'error', message: '…', code?: '…' }` on error.
- `openai`: raw `<T>` on success (OpenAI doesn't wrap success bodies); `{ error: { message, type, code?, param? } }` on error.
- `anthropic`: raw `<T>` on success; `{ type: 'error', error: { type, message, code? } }` on error.

Adding a fourth (e.g. Gemini) is one new file under `api/src/http/envelope/` and one branch in `select.ts`.

---

## Authentication plumbing

Three preflight plugins, all idempotent and composable:

1. **`auth-host`** — Reads `Authorization: Bearer <key>` (or legacy `X-API-Key`), hashes with SHA-256, looks up in `hosts.api_key_hash`. Sets `request.host` to the row. Throws 401 on miss. Checks insecure-window state via `insecure-window` service and either 423 (pending) or 200 (within window). Bumps `auth-failure-tracker` on failure.
2. **`auth-admin`** — Reads the session cookie (name from `ADMIN_SESSION_COOKIE`), looks up `admin_sessions` by token hash, joins `admin_users`. Sets `request.admin` to `{ user, roles, capabilities }`. Throws 401 if no session, 403 if session is expired.
3. **`auth-mtls`** — Parses `X-MTLS-Fingerprint`, `X-MTLS-Subject`, `X-MTLS-Issuer` (set by the upstream proxy). Sets `request.mtls = { present: true, fingerprint, subject, issuer }`. Does NOT throw — gates are per-route (`admin/auth/*` accepts session-or-mtls; `admin/users/*` is admin-only and may additionally require mtls when `ADMIN_ACCESS_MODE=mtls`).

Routes opt in via `preHandler`:

```ts
fastify.route({
  method: 'POST',
  url: '/host/lane',
  preHandler: [authHost],
  handler: async (req, reply) => {
    const lane = parseLane(req.body);
    await db.update(hosts).set({ lanePreference: lane }).where(eq(hosts.id, req.host.id));
    return ok({ lane_preference: lane });
  },
});
```

The MCP route uses a fourth preflight: bearer session token issued from the auth flow (the `mcp_session_tokens` table stays exactly as is).

---

## WebSocket admin events

Replaces the external WS server. Mounted at `/admin/ws`. Authenticates via the admin session cookie (sent in the upgrade handshake as `Cookie:`). Each connected client subscribes to the full event firehose; the publisher filters by capability.

Mutation paths emit events via `publisher.ts`:

```ts
// In services/admin-users.ts
await db.update(adminUsers).set({ active: false }).where(eq(adminUsers.id, id));
events.publish('user.updated', { id });
```

The frontend's `lib/ws/events.ts` already maps `user.updated` → invalidate `['users']`. The catalog of event types lives in `api/src/ws/events.ts` and is the source of truth; the frontend imports/copies the type list. Tracked: `log.created`, `host.{updated,created,deleted}`, `user.{updated,created,deleted}`, `project.{changed,note.*,todo.*,file.*,feedback.created}`, `skill.{stored,updated,deleted}`, `agents.stored`, `memory.{created,changed,deleted}`, `apikey.{created,toggled,deleted}`, `settings.changed`, `usage.{refresh,refreshed}`, `chatgpt.usage.updated`, `claude.usage.updated`, `insecure.{requested,approved,denied,approval.changed,domain.allowed,domain.revoked}`, `passkey.{registered,deleted}`, `joplin.synced`, `mcp.invoked`.

The legacy env vars `ADMIN_WS_ENABLED` / `ADMIN_WS_PUBLIC_URL` are reinterpreted: when `ADMIN_WS_ENABLED=true` the Node server hosts the WS endpoint at `/admin/ws` and `/admin/ws/info` returns `{ url: 'wss://…/admin/ws', heartbeat: 30, backlog: 1000 }`. No external WS server is needed.

---

## Environment variables

Every existing env var from the scout's "Environment Variables" section is preserved (same name, same default, same semantics). The single boot-time `env.ts` zod schema:

- **Required**: `ENCRYPTION_ACTIVE_KEY` (32 bytes base64), `DB_HOST`, `DB_DATABASE`, `DB_USERNAME`, `DB_PASSWORD`.
- **Required when `AUTH_RUNNER_URL` is set**: `AUTH_RUNNER_SHARED_SECRET`.
- **Required when `ADMIN_WEBAUTHN_RP_ID` is set**: `ADMIN_WEBAUTHN_ORIGIN`.
- All others default per the existing PHP code.

The boot script fails with a structured error listing every missing required var. No env-var sniffing scattered across services — one read at boot, one typed `Env` object passed through DI.

New env vars introduced:

- `LISTEN_PORT` (default 8080) — Fastify port. The reverse proxy targets this.
- `LISTEN_HOST` (default `0.0.0.0`) — bind address.
- `LOG_LEVEL` (default `info`) — pino level.
- `LOG_PRETTY` (default false in prod) — pino-pretty stream in dev.
- `STATIC_ROOT` (default `../public/admin`) — directory served by `@fastify/static` for `/admin/*`.

---

## Worktree-based execution plan

### Phase 1 — Foundation (sequential, single agent in worktree)

Branch: `api-redo/foundation`

1. Delete every file in the "What gets deleted" list — one commit, clean break.
2. Scaffold `api/` (TypeScript, Fastify, Drizzle, vitest, esbuild, ESLint, Prettier).
3. Mirror the full schema in `api/src/db/schema.ts` — every table, every column, every index. Drizzle Kit `generate` against a running MySQL produces a no-op initial migration (the DB already has the schema).
4. Implement `api/src/security/secret-box.ts` + `keyring.ts`. Add round-trip tests against fixtures produced by the legacy PHP `SecretBox` (commit fixture files at `api/test/fixtures/sbox/`).
5. Implement `api/src/security/password.ts` with bcrypt + phpass + argon2 dispatch.
6. Implement the three envelope formatters + the `select.ts` dispatcher + the Fastify plugin that wires them.
7. Implement the three preflight plugins (`auth-host`, `auth-admin`, `auth-mtls`) and the rate-limit plugin (consuming the existing `ip_rate_limits` table).
8. Implement `api/src/server.ts` that boots Fastify, registers all plugins, mounts the static handler at `/admin/*`, and the WS server at `/admin/ws`.
9. Wire `pino` logging with request correlation IDs.
10. Replace the Caddyfile/Dockerfile/docker-compose snippets that target PHP-FPM with snippets that target the new Node service at `LISTEN_PORT`.
11. Replace the PHP CI workflow with a Node CI workflow: `pnpm install --frozen-lockfile && pnpm typecheck && pnpm test && pnpm build`.
12. **Smoke test**: `pnpm dev` boots the server, `curl http://localhost:8080/admin/` returns the built SPA's `index.html`, `curl http://localhost:8080/healthz` returns `{ ok: true }` with the standard envelope.
13. Commit, merge to `main`.

### Phase 2 — Route worktrees (parallel, one agent per worktree)

Each agent branches from post-Phase-1 main. Each owns its route tree + the services those routes call. Shared service files (e.g. `services/host-auth.ts`) are written by the host-facing agent first; later agents `import` from it. To minimize blocking, the schema (Phase 1) is final before Phase 2 starts, so every agent can write its own queries independently.

| # | Branch | Scope |
|---|---|---|
| 1 | `api-redo/host-api` | `routes/auth`, `routes/host`, `routes/install`, `routes/cli-auth`. The wrapper-facing core: `/auth` retrieve/store, `/sync/{status,bootstrap}`, `/host/{users,lane}`, `/usage`, `/versions`, `/cron/{check,report}`, `/install/:token`, `/seed/auth/:token` (GET+POST), `/cli/auth/*`. Services it owns: `host-auth`, `host-registration`, `host-sync`, `insecure-window`, `version-snapshot`, `token-usage`, `auth-failure-tracker`, `cli-auth`. |
| 2 | `api-redo/admin-auth-users` | `routes/admin/auth`, `routes/admin/users`. Login, logout, passkey register/login, password change/reset, user CRUD, wipe. Services: `admin-auth`, `admin-passkey`, `admin-password`, `admin-users`, `admin-events`. |
| 3 | `api-redo/admin-hosts` | `routes/admin/hosts`. Host registration, detail, every toggle (secure/vip/roaming/auto-update/scaling-exempt/curl-insecure/reverse-dns), model/codex-version/claude-version/agents-version overrides, insecure approval flow, domain allow management. Reuses `host-registration` from #1 (imports it). |
| 4 | `api-redo/admin-overview-settings` | `routes/admin/overview`, `routes/admin/settings`. Dashboard, usage rollups, runner endpoints, ws/info, logs index, every setting endpoint. Services: `chatgpt-usage`, `claude-usage`, `dashboard-stats`, `usage-scaling`, `reverse-dns`, `client-config` (settings reader/writer parts). |
| 5 | `api-redo/admin-content` | `routes/admin/config`, `routes/admin/projects`. Skills, agents, memories, projects (admin side). Services: `projects`, `project-drafts`, `skills`, `skill-drafts`, `skill-manifest`, `agents`, `memories`, `memory-drafts`, `client-config` (config TOML rendering). |
| 6 | `api-redo/projects-client-mcp` | `routes/projects-client`, `routes/mcp`. The host-facing parts of projects + skills + agents + the MCP JSON-RPC endpoint. Services: `mcp-server`, `mcp-tools`, `mcp-resources` plus reuses from #5. |
| 7 | `api-redo/openai-compat` | `routes/v1`, `routes/admin/keys` (OpenAI side). `/v1/chat/completions`, `/v1/completions`, `/v1/responses`, `/v1/embeddings`, `/v1/models`. SSE streaming for `stream: true`. Services: `openai-keys`, `adapters/runner-openai`. |
| 8 | `api-redo/anthropic-compat` | `routes/anthropic-v1`, the Claude half of `routes/admin/keys`. `/anthropic/v1/messages` (with streaming), completions, responses, embeddings (501), models. Services: `adapters/runner-claude`. |
| 9 | `api-redo/joplin-manual-cli` | `routes/admin/joplin`, `routes/admin/manual`. Joplin config/test/sync, manual article serving. Services: `joplin-client`, `joplin-cache`, `joplin-skills`. Plus serves `public/admin/manual/articles/*.md` via `@fastify/static`. |
| 10 | `api-redo/wrapper-v2-bridge-ws` | `routes/wrapper-v2`, `ws/`. Reads from `storage/wrapper/v2/` (the directory shape defined in `CDX-redo.md`). Bridges the wrapper bake cache to HTTP responses. Implements the admin WebSocket server + event publisher. Services: `wrapper-bin-registry`, `bake-cache`, `ws/publisher`. |
| 11 | `api-redo/tests-contract` | Vitest contract suite: replay every endpoint from a recorded fixture set captured against the legacy PHP server (one run, before deletion, to record golden responses), then assert the new Node server produces the same shape. Factory + seed infrastructure for unit tests. Aims for ≥70% branch coverage across services. |

Each agent's brief includes: this plan file, the scout report's section for its routes/services, the Drizzle schema (already written in Phase 1), a list of helper modules it can import (envelope formatters, auth preflights, error classes), and the rule that two agents must not edit the same file. Shared service files are owned by the agent that *creates* them; later agents import only.

### Phase 3 — Integration (sequential)

Branch: `api-redo/integration`

1. Merge each Phase 2 branch sequentially into `integration`. Resolve trivial conflicts (mostly `api/src/server.ts` route registration, mostly mechanical).
2. Run `pnpm typecheck` — must pass.
3. Run `pnpm test` — must pass at the coverage threshold.
4. Run the **contract suite** against the legacy PHP fixtures (recorded once at the start of Phase 1). Every endpoint must produce a response with the same shape and status code as the recorded PHP response. Any drift is fixed at the integration step, not silently accepted.
5. Manual smoke: bring up a single host pointing at the new backend, run `cdx run`, verify `/auth`, `/sync/bootstrap`, `/usage` all light up. Repeat for a clean clx host.
6. End-to-end through the WebUI: log in, view hosts, register a new host, view logs, manage a project, change a setting. Each path must work.
7. Update `AGENTS.md` and `DESIGN.md` to describe the new backend in place of the PHP description.
8. Drop the legacy CHANGELOG bullet noting the rewrite.
9. Squash-merge `integration` to `main`.

---

## Best-practice cull (the "weed out ALL" mandate)

What today's backend does that the rewrite **stops doing**:

| Removed | Replaced with |
|---|---|
| 1,042-line hand-rolled router in `public/index.php` | Fastify route registration spread across feature trees |
| 50+ services instantiated eagerly at boot | Fastify plugin lazy loading + DI via Fastify decorators |
| 18 controllers acting as glue layers between HTTP and services | Route handlers that *are* the glue; services are pure domain |
| 1,000-line `AuthService` bundling 12 concerns | 7 focused services (`host-auth`, `host-registration`, `host-sync`, `insecure-window`, `version-snapshot`, `token-usage`, `auth-failure-tracker`) |
| 1,000-line `AdminAuthService` bundling login + session + password + passkey | 4 services (`admin-auth`, `admin-passkey`, `admin-password`, `admin-events`) |
| Raw SQL strings duplicated across 48 repositories | Drizzle's typed query builder, schema-driven |
| Three response envelope shapes dispatched via URL-prefix check in the router | One `onSend` hook + one formatter per shape |
| URL prefix check for "is this OpenAI or Anthropic" | Per-route plugin registration; the formatter is a property of the route group |
| Env vars read ad-hoc by each service | One zod-validated `env.ts` at boot |
| No request validation layer | zod schemas attached to every route's `body`/`query`/`params`/`response` |
| `error_log()` + PHP stderr for diagnostics | pino structured JSON logs + per-request correlation IDs |
| `isBrowserRequest()` content sniffing for HTML vs JSON | Each route is exactly one thing; HTML routes (legacy admin pages) are deleted with the gateway |
| Hand-rolled rate limiter scattered across services | One Fastify plugin reading/writing `ip_rate_limits` |
| Manual schema-fingerprint migration sentinel | Drizzle Kit's standard migration table |
| Boot-time data backfills running on every request (gated by version flags) | One-off scripts under `api/scripts/migrate-*.ts` invoked by operators, not the request path |
| 4 backfill flags + their guards | Same one-off scripts; once-and-done |
| PHP-FPM + Caddy → PHP boot per request | Single long-running Node process; ~50 MB RSS, sub-ms request handling |
| External WS server referenced by env var | Native Fastify WebSocket at `/admin/ws` |
| `phpunit.xml.dist` + ~0 HTTP test coverage | Vitest + light-my-request + ≥70% branch coverage target |
| Composer + vendor/ + ~3 production deps | pnpm workspaces, ~12 production deps |
| Mixed dependency versions (phpass, libsodium PHP binding) | One canonical implementation per concern |

---

## Verification

After every phase:

1. **Typecheck**: `cd api && pnpm typecheck` — must pass.
2. **Tests**: `cd api && pnpm test` — Vitest unit + integration must pass.
3. **Contract suite**: `cd api && pnpm test:contract` — replays the recorded PHP responses against the Node server. Diff = bug.
4. **Crypto round-trips**: `cd api && pnpm test:fixtures` — decrypts the committed `sbox:v1:…` fixtures (produced by the legacy PHP) and verifies the plaintext matches expectations. Tampered fixture → test fails.
5. **End-to-end smoke** (Phase 2/3 only): bring up the whole stack via `docker compose up`, register a host, run `cdx run "hello"`, hit the SvelteKit WebUI, change a setting, observe the WS event invalidating the query.
6. **Load smoke** (Phase 3 only): `wrk -t4 -c50 -d30s http://localhost:8080/admin/auth/status` — must sustain ≥10k RPS on a developer laptop without errors. The PHP-FPM baseline was ~2.5k RPS for the same endpoint.

---

## Files & references to consult during implementation

- **Scout report** (in this conversation thread) — full inventory of the legacy backend's routes, services, repositories, env vars, and pain points.
- **Legacy code** (deleted in Phase 1 but recoverable from git history for cross-reference): `src/` (entire tree).
- **Frontend WS event catalog**: `frontend/src/lib/ws/events.ts` — the new backend's `ws/events.ts` mirrors this list.
- **CDX-redo plan**: `CDX-redo.md` — defines the `storage/wrapper/v2/` layout that `wrapper-v2-bridge` reads from. The Node backend is the *server* that the Go binaries described in CDX-redo talk to.
- **Existing migrations** (deleted but referenced one final time during Phase 1 to author the Drizzle schema): `src/Migrations/*.php` from git history.
- **WebUI plan**: `/home/chris/.claude/plans/nifty-honking-turtle.md` — for the IA and the WS invalidation conventions the backend must publish events compatible with.
- **Test fixture recording**: `tests/contract/record.sh` (committed early in Phase 1, before deletion) captures golden responses from the legacy PHP backend by running the test suite against a live PHP-FPM instance. Output goes to `tests/contract/fixtures/<endpoint>/<scenario>.json`. The Node contract suite replays these.
