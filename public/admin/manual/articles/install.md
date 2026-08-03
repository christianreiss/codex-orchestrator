---
title: Installing and bootstrapping
section: Orientation
verified: 2026-08-01
sources: README.md, bin/setup.sh, docker-compose.yml, caddy/Caddyfile, api/src/env.ts, api/src/server.ts, api/src/db/schema.ts, api/src/routes/health.ts, api/src/routes/admin/setup/index.ts, api/src/services/setup-status.ts, api/src/services/admin-users.ts, api/src/services/wrapper-signing-key.ts, api/src/services/wrapper-bin-registry.ts, api/src/security/keyring.ts, api/src/ops/setup-signing-key.ts, wrappers/Makefile
---

Orchestrator ships as a Docker Compose stack: the Node API, MySQL 8.4, the auth runner, and Caddy as the TLS/reverse proxy. `bin/setup.sh` walks you through first-time configuration and brings up the stack.

## Stack overview

Four services are defined in `docker-compose.yml`:

| Service | Image | Notes |
|---|---|---|
| `api` | Node/Fastify | Listens on `127.0.0.1:8488` (host) → `8080` (container). Runs read-only with all capabilities dropped. |
| `mysql` | `mysql:8.4` | **MySQL 8.4**, not MariaDB. Data stored under `<DATA_ROOT>/mysql_data`. |
| `auth-runner` | Python sidecar | Receives `RUNNER_SHARED_SECRET` (separate from the API-side `AUTH_RUNNER_SHARED_SECRET`). |
| `caddy` | Caddy | **Profile-gated** (`profiles: ["caddy"]`). Not started by default. |

`DATA_ROOT` defaults to `/var/docker_data/codex-auth.example.com`. Change it in `.env` before first boot. The internal Docker network `codex_auth` uses subnet `172.30.250.0/24` by default; override with `CODEX_AUTH_SUBNET` and `CODEX_AUTH_GATEWAY`.

### Starting Caddy

Because Caddy is behind the `caddy` profile, it does **not** start with a plain `docker compose up -d`. To include it:

```bash
docker compose --profile caddy up -d
```

## First boot

1. **Clone and run setup.** `bin/setup.sh` prompts for `.env` values, generates all installation-owned secrets plus an installation-specific wrapper signing key, builds/publishes all four `cxx` platforms, imports the private key encrypted, starts the critical stack with bounded waiting, and probes both local and public readiness. Continue only when it prints `READY` and the exact `/admin/setup` URL; `INCOMPLETE` is always non-zero.
2. **Schema.** The Drizzle schema in `api/src/db/schema.ts` mirrors the database; the hand-written SQL in `api/src/db/migrations/` is what actually changes it. The API applies every pending migration on boot (`RUN_MIGRATIONS_ON_BOOT`, default on) and `scripts/deploy.sh` applies them explicitly before starting the stack, so a normal deploy needs no manual step. To drive it yourself: `docker compose run --rm -T api node migrate.js` (or `--list` / `--check` / `--dry-run`). Do **not** use `drizzle:push` against a real database — it reconciles the whole mirror and cannot express FULLTEXT indexes or foreign keys.
3. **Claim the first owner.** `/admin/setup` is the only console surface for an empty install. The claim is serialized, always creates one active owner, and signs it in immediately. Do not expose an unclaimed installation.
4. **Finish operational onboarding.** Provider auth and the first host do not block the console, but remain in `/admin/setup` and on the dashboard until verified canonical auth, host registration, and first sync are present.
5. **Wrapper signing lifecycle.** Setup injects the generated public key through Go linker data without modifying tracked `pubkey.pem`, imports the private PEM as a secretbox envelope, verifies DB read-back/signing, and only then removes plaintext. Existing installations are never auto-rotated; mismatches and mixed artifacts fail closed.

## Environment variables the app reads

These are the variables consumed by `api/src/env.ts`. The file is parsed with Zod; process environment always wins over any `.env` file.

### Hard requirements (fail-fast)

- **Either `ENCRYPTION_ACTIVE_KEY` or `AUTH_ENCRYPTION_KEY` must be set.** Both accept 32 raw bytes, base64-encoded. The app refuses to start if neither is present. Back these up carefully — losing them destroys all encrypted auth payloads.
- `AUTH_RUNNER_SHARED_SECRET` is required when `AUTH_RUNNER_URL` is set.
- `ADMIN_WEBAUTHN_ORIGIN` is required when `ADMIN_WEBAUTHN_RP_ID` is set.

### Core

- `PUBLIC_BASE_URL` — canonical base URL the installer script embeds in the bootstrap transition launcher.
- `PUBLIC_BASE_URL_REQUIRED` — bool, default `true`. Fails startup if `PUBLIC_BASE_URL` is missing.
- `ADMIN_ACCESS_MODE` — `mtls` (default), `cookie`, or `open`; setup also selects the matching Caddy admin fragment so cookie mode is reachable without a client certificate.
- `ADMIN_SESSION_COOKIE` — default `codex_admin_session`.
- `ADMIN_SESSION_TTL_MINUTES` — default `43200` (30 days) in `env.ts`. `AdminAuthService.sessionTtlSeconds()` clamps this to 5 min – 7 days at login, so a fresh session starts at 7 days; `auth-admin.ts`'s `resolveAdmin` then rolls `expiresAt` forward on every authenticated request using the same TTL clamped to 5 min – 30 days, so an actively used session keeps renewing out to 30 days.
- `ADMIN_WEBAUTHN_RP_ID`, `ADMIN_WEBAUTHN_ORIGIN`, `ADMIN_WEBAUTHN_RP_NAME` — passkey relying-party metadata.
- `ADMIN_WS_ENABLED` — defaults to `false` in env.ts, but **the compose file sets it to `1` (enabled) by default** when using the compose stack. Also: `ADMIN_WS_PUBLIC_URL`, `ADMIN_WS_HEARTBEAT_SECONDS`, `ADMIN_WS_BACKLOG_LIMIT`.
- `INSTALLATION_ID` — optional installation identifier.

### Auth runner

- `AUTH_RUNNER_URL`, `AUTH_RUNNER_SHARED_SECRET` — how the API reaches the Python runner. **Note:** the compose file passes `RUNNER_SHARED_SECRET` to the `auth-runner` container; `AUTH_RUNNER_SHARED_SECRET` is what the API reads. These are separate variables for different services.
- `AUTH_RUNNER_CODEX_BASE_URL` — Codex auth base URL for the runner.
- `AUTH_RUNNER_TIMEOUT` — default `8` (seconds). HTTP timeout used for calls to the runner (health checks, verify, exec).
- `AUTH_RUNNER_VERIFY_TTL_SECONDS` — default `900`. How stale a canonical auth's stored verification verdict may get before the background auth-verification worker re-checks it.
- `AUTH_RUNNER_VERIFY_WORKER_INTERVAL_SECONDS` — default `300`. Poll interval for the background worker (`api/src/ops/auth-verification-worker.ts`, started from `server.ts`) that replaced synchronous runner verification on the request/boot path.
- `AUTH_RUNNER_IP_BYPASS` — bool, default `false`. Bypass runner IP checks.
- `AUTH_RUNNER_BYPASS_SUBNETS` — subnets exempt from runner IP checks (used when `AUTH_RUNNER_IP_BYPASS` is true).
- `AUTH_RUNNER_PREFLIGHT_SECONDS` — still declared in `env.ts` (default `28800`) but no longer read anywhere in `api/src`; superseded by `AUTH_RUNNER_VERIFY_TTL_SECONDS` / `AUTH_RUNNER_VERIFY_WORKER_INTERVAL_SECONDS` above.

### Encryption / keyring

- `ENCRYPTION_ACTIVE_KEY`, `ENCRYPTION_KEYS`, `ENCRYPTION_ACTIVE_KID` — key material for `api/src/security/keyring.ts`. Legacy `AUTH_ENCRYPTION_*` variants are accepted.
- `AUTH_SEED_TOKEN_TTL_SECONDS` — default `900`. TTL for single-use seed tokens.

### Database

- `DB_CHARSET` — default `utf8mb4`.
- `DB_POOL_SIZE` — default `10`.

### Proxy / host validation

- `TRUST_X_FORWARDED` — trust the `X-Forwarded-*` headers from upstream proxies.
- `TRUSTED_PROXY_CIDRS` — CIDRs of trusted proxies.
- `STRICT_HOST_VALIDATION` — bool, default `true`.
- `MCP_ALLOW_REQUEST_HOST_ORIGIN` — bool, default `false`.
- `INSECURE_GRACE_MINUTES` — default `60`. Grace window for insecure hosts.

### Storage / sync

- `DATA_ROOT` — overrides the default storage layout. Wrapper binaries live under `<DATA_ROOT>/wrapper/v2/bin/...` (or `storage/wrapper/v2/bin/...` relative to the repo root when unset).
- `CODEX_SYNC_BASE_URL` — override sync base URL.

### Boot behaviour

- `RUN_MIGRATIONS_ON_BOOT` — bool, default `true`. Applies every pending file in `api/src/db/migrations/` before the listener opens (`api/src/ops/boot-migrations.ts`). Setting it to `0` does not disable the *check*: boot still fails when a migration is pending, so the API never serves against an unexpected schema.
- `MIGRATIONS_LOCK_TIMEOUT` — int seconds, default `120`. How long to wait for the `GET_LOCK` migration lock when several API instances boot at once.
- `MIGRATIONS_DIR` — optional path override for the migration directory. Empty means "next to the bundle" (`dist/migrations`), which is correct for the shipped image.
- `RUN_BACKFILLS_ON_BOOT` — bool, default `false`. Declared but not consumed anywhere in `api/src`; the auth-generation backfill in `ops/boot-checks.ts` runs unconditionally and is idempotent.

### MCP

- `MCP_OPERATOR_TOKEN`, `MCP_FS_ROOT`, `MCP_FS_MAX_*` — MCP operator bearer + filesystem tool root (see [mcp](/admin/manual/mcp)).

### Mailer

- `SMTP_HOST`, `SMTP_PORT`, `SMTP_USERNAME`, `SMTP_PASSWORD`, `SMTP_FROM`, `SMTP_SECURE` — optional mailer; password reset flows are inert without these.

### Misc

- `DEFAULT_HOST_ENGINES` — `codex`, `claude`, or `codex,claude`; default when registering.

### Pricing

- `GPT51_INPUT_PER_1K`, `GPT51_OUTPUT_PER_1K` (and other `GPT51_*` variants)
- `CHATGPT_PLUS_PLAN_COST`, `CHATGPT_PRO_PLAN_COST`
- `CHATGPT_USAGE_CRON_INTERVAL`, `CHATGPT_BASE_URL`, `CHATGPT_USAGE_TIMEOUT`
- `CLAUDE_OPUS_INPUT_PER_1K`, `CLAUDE_OPUS_OUTPUT_PER_1K`, `CLAUDE_SONNET_INPUT_PER_1K`, `CLAUDE_SONNET_OUTPUT_PER_1K`, `CLAUDE_HAIKU_INPUT_PER_1K`, `CLAUDE_HAIKU_OUTPUT_PER_1K`, `ANTHROPIC_API_KEY` — parsed by `env.ts`, but currently unused elsewhere in `api/src`; there is no `claude-usage.ts` service consuming them yet (only `chatgpt-usage.ts` is wired up).
- `PRICING_URL`, `PRICING_CURRENCY`

Check `.env.example` in the repo for the full, current list.

## Caddy configuration

Caddy is configured via `caddy/Caddyfile`. The domain is set with `$CADDY_DOMAIN`. TLS is imported from a fragment file selected by `$CADDY_TLS_FRAGMENT`:

- `tls-acme.caddy` — Let's Encrypt ACME
- `tls-custom.caddy` — custom certificate files (paths configured via `$CADDY_TLS_DIR`)

**mTLS is enforced at the Caddy layer**, not by the Node API alone. For `/admin*` paths, Caddy requires a valid client certificate before forwarding the request. Requests without a client cert receive a `403` response from Caddy directly. On successful cert verification, Caddy injects `X-MTLS-Present`, `X-MTLS-Fingerprint`, `X-MTLS-Subject`, and `X-MTLS-Issuer` headers upstream. The admin WebSocket at `/admin/ws` is behind the same mTLS gate. All other paths are plain reverse-proxied to the API.

Client certificates and CA material are configured via `$CADDY_MTLS_DIR`.

## Seeding the canonical auth

Hosts cannot fetch auth until the orchestrator has its own copy. Two paths:

- **Admin UI upload.** Sign in as the first admin, use *Admin → Upload auth*. The route is `POST /admin/auth/upload`. This is the normal path once you are running.
- **Seed auth token.** `POST /admin/auth/seed-command` mints a single-use token, backed by an `auth_seed_tokens` row. The generated `curl | bash` snippet is copied automatically; the admin runs it on the machine that currently holds the canonical `~/.codex/auth.json`. The seed endpoint is `POST /seed/auth/{token}` (aliased to `/seed/v2/auth/{token}`). Tokens are UUIDs and are consumed on success. Token TTL is controlled by `AUTH_SEED_TOKEN_TTL_SECONDS` (default 900 s).

The GET twin at `/seed/auth/{token}` returns an executable shell script that reads your local `auth.json` and POSTs it back.

## Registering a host

`POST /admin/hosts/register` creates a host row and returns a one-shot installer token. The token is stored in `install_tokens` and consumed by `GET /install/{token}` (aliased to `/install/v2/{token}`). The install endpoint emits the per-host POSIX shell installer. It installs one `cxx` plus relative `cdx -> cxx` and/or `clx -> cxx` aliases into `/usr/local/bin` by default (root/passwordless `sudo` required; `BIN_DIR` is the explicit custom-prefix override). The admin sees a `curl … | sh` command under *Hosts → New Host*.

What the installer actually does on the target machine:

1. Fetches every enabled signed per-host config first and refuses to continue
   unless their common wrapper version/SHA metadata agrees.
2. Downloads one platform-specific `cxx`, verifies SHA-256, and installs it
   with enabled relative aliases. Existing regular `cdx`/`clx` wrappers are
   atomically replaced by aliases during migration.
3. When Claude is requested, prepares Node.js/npm. It prefers the OS Node
   runtime plus a pinned Corepack npm shim and falls back to the OS npm package.
4. Invokes `cxx cron install` and `cxx cron run --minimal` once each. The
   coordinator installs one shared schedule and boots every enabled persona
   exactly once, installing Codex and/or Claude Code at the server-selected
   version. A privileged system-schedule migration discovers every actual
   owner in the standard cron spools. Strictly validated spool filenames stay
   eligible when static Go `os/user` cannot resolve an NSS/SSSD-only owner;
   config-owner/sudo/current/root safeguards still require lookup validation.
   It snapshots each crontab, removes only lines ending in an exact managed
   marker, and restores every changed crontab plus the new system entry if
   cleanup cannot complete.
5. Prints `READY` only after the common wrapper, every CLI, and cron setup verifies. Any
   partial failure prints `INCOMPLETE`, exits non-zero, and gives a direct retry;
   wrapper/config failures require minting a fresh single-use installer.

## Wrapper distribution

Canonical wrapper source is the Go module under `wrappers/cxx/`. CI
cross-compiles once per platform and publishes a single-version release
fragment. After extracting it to a stage root, operators run
`cd wrappers && make publish-release OUTROOT=<stage-root> PUBLISH_ROOT=<DATA_ROOT>/wrapper/v2/bin`.
That target validates the complete incoming matrix and existing rollback
payloads before mutation, publishes immutable version directories, and merges
each platform manifest atomically without dropping earlier builds. Exact
historical per-engine artifacts stay immutable, while compatible old URLs fall
back to the matching common bytes. `wrapper-bin-registry.ts` discovers the
published store. `GET /wrapper` (aliased to `/wrapper/v2/meta`) returns the
per-platform projection; `GET /wrapper/download` returns the bootstrap
transition launcher for the calling host. Hosts use these endpoints to
self-update between runs.

## Post-install smoke test

- From the admin UI, visit *Dashboard*. New hosts appear under *Hosts → Unprovisioned* until they complete a successful sync; after that they move to *Secure* (or *Insecure*, if you activated insecure mode on registration). Use the **Runner state** card's **Run verification** button (one per engine) to confirm the runner is reachable; it calls `POST /admin/runner/run` for Codex or `/admin/runner/run-claude` for Claude.
- Click into any host to see its per-host baked config version, last auth digest, and IP binding state.

## Backups

There is no built-in backup job. Back up:

1. The MySQL volume (`docker-compose.yml` names the data volume for you).
2. The encryption keyring referenced by `Keyring` (the values in `ENCRYPTION_KEYS` / `AUTH_ENCRYPTION_KEYS`).
3. The wrapper signing key — held in the `wrapper_signing_keys` table. Rotating it is additive and non-breaking: several keys may be active at once and all of them sign, so you add the replacement, roll the fleet onto binaries embedding it, and only then retire the old key. Losing it is the hard case — it requires re-issuing the key and re-deploying binaries before any host can verify its config again.

Without the encryption keys you cannot decrypt `auth_payloads`. The app will still run, but every host will fail sync until a fresh canonical auth is re-uploaded.

## Source references

- README.md (quick start)
- docker-compose.yml (stack definition)
- caddy/Caddyfile (TLS and mTLS proxy config)
- api/src/env.ts (all env var definitions and validation)
- api/src/server.ts (Fastify boot)
- api/src/db/schema.ts (Drizzle schema — single source of truth)
- api/src/routes/install/index.ts (install / seed endpoints)
- api/src/services/admin-auth.ts (login-time session TTL clamp, isEnforced/countAdmins)
- api/src/http/plugins/auth-admin.ts (rolling session TTL clamp on every request)
- api/src/services/wrapper-config.ts (signed per-host config bakery)
- api/src/services/wrapper-signing-key.ts (Ed25519 keypair from wrapper_signing_keys)
- api/src/services/wrapper-bin-registry.ts (per-platform binary inventory)
- api/src/routes/admin/overview/index.ts (authUpload, seedCommand, runner probes)
- api/src/routes/admin/hosts/index.ts (register, quick-register)
- api/src/security/keyring.ts (encryption keyring)
- bin/setup.sh and api/src/ops/setup-signing-key.ts (installation signing-key lifecycle)
