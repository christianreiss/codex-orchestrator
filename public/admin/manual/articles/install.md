---
title: Installing and bootstrapping
section: Orientation
verified: 2026-05-20
sources: README.md, docker-compose.yml, api/src/server.ts, api/src/db/schema.ts, api/src/routes/install/index.ts, api/src/services/wrapper-config.ts, api/src/services/wrapper-signing-key.ts, scripts/wrapper-v2-init-keys.sh
---

Orchestrator ships as a Docker Compose stack: the Node API, MariaDB, the auth runner, Caddy as the TLS/reverse proxy, and optionally the in-process websocket. `bin/setup.sh` walks you through first-time configuration and brings up the stack.

## First boot

1. **Clone and run setup.** `bin/setup.sh` prompts for `.env` values (public base URL, admin access mode, runner secret, TLS material), writes `.env` in the repo root, and calls `docker compose up -d`.
2. **Schema.** The Drizzle schema in `api/src/db/schema.ts` is the single source of truth. Migrations are applied via `drizzle-kit` outside the running app (the boot path can apply them in place when `RUN_MIGRATIONS_ON_BOOT=true`, otherwise it expects the schema to already be current).
3. **No admins, no gating.** While `AdminAuthService.isEnforced()` returns false (i.e. `admin_users` is empty), the admin UI serves the first-run screens that let you create the initial admin. The moment you create one, session enforcement flips on for everyone.
4. **Wrapper signing key.** Run `scripts/wrapper-v2-init-keys.sh` once per environment to generate the Ed25519 keypair used to sign per-host wrapper configs. The keypair is stored in the `wrapper_signing_keys` table by `wrapper-signing-key.ts`. Then `cd wrappers && make pubkey` embeds the public key into the Go binaries at build time.

## Environment variables the app reads

These are the variables consumed by `api/src/env.ts` that control first boot:

- `PUBLIC_BASE_URL` — canonical base URL the installer script embeds in the bootstrap shim.
- `ADMIN_ACCESS_MODE` — `mtls` (default), `cookie`, or `open`.
- `ADMIN_SESSION_COOKIE` — default `codex_admin_session`.
- `ADMIN_SESSION_TTL_MINUTES` — default 720 (12 h), clamped to 5 min – 7 days.
- `ADMIN_WEBAUTHN_RP_ID`, `ADMIN_WEBAUTHN_ORIGIN`, `ADMIN_WEBAUTHN_RP_NAME` — passkey relying-party metadata. When `RP_ID` is set, `ORIGIN` is required.
- `ADMIN_WS_ENABLED`, `ADMIN_WS_PUBLIC_URL`, `ADMIN_WS_HEARTBEAT_SECONDS`, `ADMIN_WS_BACKLOG_LIMIT` — websocket feature flag and tuning.
- `AUTH_RUNNER_URL`, `AUTH_RUNNER_SHARED_SECRET` — how the API reaches the Python runner. The secret is required when the URL is set.
- `ENCRYPTION_ACTIVE_KEY`, `ENCRYPTION_KEYS`, `ENCRYPTION_ACTIVE_KID` (legacy `AUTH_ENCRYPTION_*` accepted) — key material used by `api/src/security/keyring.ts`. Back these up carefully; losing them destroys the encrypted auth payloads.
- `DATA_ROOT` — overrides the default storage layout. Wrapper binaries live under `<DATA_ROOT>/wrapper/v2/bin/...` (or `storage/wrapper/v2/bin/...` relative to the repo root when unset).
- `MCP_OPERATOR_TOKEN`, `MCP_FS_ROOT`, `MCP_FS_MAX_*` — MCP operator bearer + filesystem tool root (see [mcp](/admin/manual/mcp)).
- `DEFAULT_HOST_ENGINES` — `codex`, `claude`, or `codex,claude`; default when registering.
- `SMTP_HOST`, `SMTP_PORT`, `SMTP_USERNAME`, `SMTP_PASSWORD`, `SMTP_FROM`, `SMTP_SECURE` — optional mailer; password reset flows are inert without these.

Check the `.env.example` in the repo for the full, current list.

## Seeding the canonical auth

Hosts cannot fetch auth until the orchestrator has its own copy. Two paths:

- **Admin UI upload.** Sign in as the first admin, use *Admin → Upload auth*. The route is `POST /admin/auth/upload` (in `api/src/routes/admin/overview/index.ts`). This is the normal path once you are running.
- **Seed auth token.** `POST /admin/auth/seed-command` mints a single-use token, backed by an `auth_seed_tokens` row. The admin runs the printed `curl | bash` snippet on the machine that currently holds the canonical `~/.codex/auth.json`. The seed endpoint is `POST /seed/auth/{token}` (aliased to `/seed/v2/auth/{token}`). Tokens are UUIDs.

The GET twin at `/seed/auth/{token}` returns an executable shell script that reads your local `auth.json` and POSTs it back. Tokens consume on success.

## Registering a host

`POST /admin/hosts/register` creates a host row and returns a one-shot installer token. The token is stored in `install_tokens` and consumed by `GET /install/{token}` (aliased to `/install/v2/{token}`). The install endpoint emits the per-host installation script — a compact script that writes the bootstrap shim under `~/.local/bin/cdx` (or `clx`). The admin sees a `curl … | bash` command under *Hosts → New Host*.

What the installer actually does on the target machine:

1. Writes the bootstrap shim to `~/.local/bin/{cdx|clx}`.
2. Hints at installing the upstream engine CLI (`codex` / `claude`) if absent.
3. Runs the shim once, which fetches the signed config + platform-specific binary.
4. Subsequent `cdx run` invocations exec the binary directly; the shim only re-fetches if the config SHA changes.

## Wrapper distribution

Canonical wrapper sources are the Go modules under `wrappers/cdx/` and `wrappers/clx/`. CI cross-compiles per platform and writes results to `<DATA_ROOT>/wrapper/v2/bin/<engine>/<os>-<arch>/`, with a `manifest.json` per platform listing builds and their SHA256s; `wrapper-bin-registry.ts` discovers them. `GET /wrapper` (aliased to `/wrapper/v2/meta`) returns the per-platform manifest; `GET /wrapper/download` returns the bootstrap shim for the calling host. Hosts use these endpoints to self-update between runs.

## Post-install smoke test

- From the admin UI, visit *Dashboard*. New hosts appear under *Hosts → Unprovisioned* until they complete a successful sync; after that they move to *Secure* (or *Insecure*, if you activated insecure mode on registration).
- Click into any host to see its per-host baked config version, last auth digest, and IP binding state.
- Trigger *Settings → Runner → Run probe* to verify the runner is reachable; the endpoint is `POST /admin/runner/run` (or `/admin/runner/run-claude` for the Claude side).

## Backups

There is no built-in backup job. Back up:

1. The MariaDB volume (`docker-compose.yml` names the data volume for you).
2. The encryption keyring referenced by `Keyring` (the values in `ENCRYPTION_KEYS` / `AUTH_ENCRYPTION_KEYS`).
3. The wrapper signing key — held in the `wrapper_signing_keys` table. Rotating it requires every host to self-update; losing it requires re-issuing the key and re-deploying binaries.

Without the encryption keys you cannot decrypt `auth_payloads`. The app will still run, but every host will fail sync until a fresh canonical auth is re-uploaded.

## Source references

- README.md (quick start)
- docker-compose.yml (stack definition)
- api/src/server.ts (Fastify boot)
- api/src/db/schema.ts (Drizzle schema — single source of truth)
- api/src/routes/install/index.ts (install / seed endpoints)
- api/src/services/wrapper-config.ts (signed per-host config bakery)
- api/src/services/wrapper-signing-key.ts (Ed25519 keypair from wrapper_signing_keys)
- api/src/services/wrapper-bin-registry.ts (per-platform binary inventory)
- api/src/routes/admin/overview/index.ts (authUpload, seedCommand, runner probes)
- api/src/routes/admin/hosts/index.ts (register, quick-register)
- api/src/security/keyring.ts (encryption keyring)
- scripts/wrapper-v2-init-keys.sh (Ed25519 keypair bootstrap)
