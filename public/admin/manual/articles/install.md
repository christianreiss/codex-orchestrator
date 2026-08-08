---
title: Installing and bootstrapping
section: Orientation
verified: 2026-08-03
sources: README.md, bin/install.sh, docker-compose.yml, caddy/Caddyfile, api/src/env.ts, api/src/server.ts, api/src/db/schema.ts, api/src/db/baseline/schema.sql, api/src/routes/health.ts, api/src/routes/admin/setup/index.ts, api/src/services/setup-status.ts, api/src/services/setup-wizard.ts, api/src/services/admin-users.ts, api/src/services/wrapper-signing-key.ts, api/src/services/wrapper-bin-registry.ts, api/src/security/keyring.ts, api/src/ops/setup-signing-key.ts, frontend/src/routes/setup/+page.svelte, frontend/src/lib/components/setup/SeedAuthPanel.svelte, frontend/src/routes/dashboard/OnboardingCard.svelte, wrappers/Makefile
---

Orchestrator ships as a Docker Compose stack: the Node API, MySQL 8.4, the auth runner, and Caddy as the TLS/reverse proxy. `bin/install.sh` walks you through first-time configuration and brings up the stack.

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

1. **Clone and run the installer.** `bin/install.sh` prompts for `.env` values, generates all installation-owned secrets plus an installation-specific wrapper signing key, builds/publishes all four `cxx` platforms, provisions the schema, imports the private key encrypted, starts the critical stack with bounded waiting, and probes both local and public readiness. Continue only when it prints `READY` and the exact `/admin/setup` URL; `INCOMPLETE` is always non-zero.
2. **Schema.** The Drizzle schema in `api/src/db/schema.ts` mirrors the database; the hand-written SQL in `api/src/db/migrations/` is what actually changes it. Those migrations *extend* a schema rather than create one, so an empty database is bootstrapped from `api/src/db/baseline/schema.sql` by `migrate.js --init-schema` — which applies the baseline only when `information_schema` reports no application tables, then migrates on top, and is therefore safe to re-run against a populated database. The API applies every pending migration on boot (`RUN_MIGRATIONS_ON_BOOT`, default on) and `scripts/deploy.sh` applies them explicitly before starting the stack, so a normal deploy needs no manual step. To drive it yourself: `docker compose run --rm -T api node migrate.js` (or `--list` / `--check` / `--dry-run`). Do **not** use `drizzle:push` against a real database — it reconciles the whole mirror and cannot express FULLTEXT indexes or foreign keys.
3. **Claim the first owner.** `/admin/setup` is the only console surface for an empty install. The claim is serialized, always creates one active owner, and signs it in immediately. Do not expose an unclaimed installation.
4. **Finish operational onboarding.** The setup wizard continues past the owner claim through engines, credentials, fleet defaults, agent policy, modules, collaboration and an optional first host. None of those block the console, and everything unanswered stays on the dashboard's resume card until verified canonical auth, host registration, and first sync are present.
5. **Wrapper signing lifecycle.** Setup injects the generated public key through Go linker data without modifying tracked `pubkey.pem`, imports the private PEM as a secretbox envelope, verifies DB read-back/signing, and only then removes plaintext. Existing installations are never auto-rotated; mismatches and mixed artifacts fail closed.

## The installer

`bin/install.sh` takes an empty Docker host to a working console. Docker with the Compose v2 plugin, `curl`, `openssl` and coreutils are the only hard dependencies — a Go toolchain, `make` and `python3` are used when present and run in a purpose-built container when they are not. `bin/setup.sh` remains as a shim that execs this script.

Twelve steps run in order, each independently re-runnable: `prereqs`, `secrets`, `dataroot`, `urls`, `tls`, `wrappers`, `datatier`, `schema`, `apptier`, `signer`, `owner`, `verify`. The database and API start in separate steps deliberately — the API fails closed on a pending migration, so the schema has to exist before it opens a listener.

Three properties are load-bearing:

- **Every step is re-runnable.** Steps record themselves in a state file and skip when their work is already done, and each re-derives its own preconditions instead of trusting its predecessor, so an interrupted run resumes rather than restarting. Configuration steps re-apply (a changed URL or TLS choice takes effect); the expensive ones (`wrappers`, `schema`, `signer`, `owner`) skip.
- **Machine-drivable.** `--json` puts one object per step on stdout while the human terminal UI goes to stderr, so an agent and a person can read the same run. `--non-interactive` never prompts: missing input is one error naming everything missing, not a question loop. Passwords are passed as files (`--admin-pass-file`), never as flag values, because arguments are visible in the process list.
- **Fails closed.** `READY` is printed only after `/healthz`, all six critical `/readyz` checks, and the public URL pass. Anything less prints `INCOMPLETE` and exits non-zero. Existing secrets are preserved; mismatched keys, mixed wrapper versions, incomplete matrices and multiple active database signers fail rather than being rotated.

Selective runs: `--from <step>` redoes a step and everything after, `--only <step>` runs exactly one, and `--force wrappers` sets a partial or foreign-signed matrix aside and rebuilds — refusing, without touching anything, once the plaintext signing key has been removed, because replacing a signing key means rolling every deployed host in the same window.

Image building lives in `datatier`, not `apptier`. After editing the API or rebuilding the admin SPA, run `--only datatier` before `--only apptier`, or the container keeps serving the previous build.

Diagnosis: `bin/install.sh doctor` maps each failing check to the command that fixes it and works with the stack down — it reports the API as unreachable rather than crashing inside `compose exec`. `verify` re-runs the readiness checks; `print-env` prints the resolved configuration with secrets masked.

## The first-run setup wizard

`/admin/setup` is the console's front door on an unclaimed installation, and `/admin` stands down in its favour until the auth state has settled. Nine steps:

| Step | What it asks | Blocking |
|---|---|---|
| Infrastructure | Nothing — it reports the six critical checks (`database`, `migrations`, `runner`, `signer`, `wrappers`, `public_base_url`) and the command that fixes each. | **yes** |
| Owner | The one-time first-owner claim, which issues the session inline. | **yes** |
| Engines | Codex, Claude, both, or neither. Drives the next step. | no |
| Credentials | One canonical credential per selected engine. Disappears from the rail entirely when the answer was "neither". | no |
| Fleet defaults | Model and reasoning effort — **and the write that activates MCP**. | no |
| Agent policy | Shows the seeded fleet policy; optional house rules are appended to it. | no |
| Modules | Projects and Secrets, both off until enabled. | no |
| Collaboration | Agent portal and agent messaging, both off until enabled. | no |
| First host | Optional. Registers a host and prints its one-time installer command. | no |

Only the first two block: infrastructure is not fixable from a browser, and nothing else can be written without the session the owner claim issues. Everything after has **Skip**, because "no" is a complete answer to most of it.

Position and completion persist in a `setup_wizard_state` blob behind `GET`/`POST /admin/setup/wizard`, so an interrupted run resumes from the dashboard card and a finished or dismissed one stops nagging. That blob exists because neither existing notion can carry it: `setup_complete` is `criticalComplete && ownerCreated` and goes true at step two of nine, and a `next_action` can only ever be complete-when-done, which would leave anyone who declined every optional module staring at a permanently unfinished list.

**Fleet defaults is not cosmetic.** A fresh install has no `client_config_documents` row. Without one the managed feature context reports `config_missing` and resolves skills, memory, projects and secrets to disabled *before their own switches are read* — so enabling Projects on a brand-new install does nothing at all. `POST /admin/model-defaults/:engine` is the only thing that creates that row, while the matching `GET` returns a default that was never persisted, which is how a console can look configured while every managed feature is dark. The wizard therefore saves Codex defaults on that step unconditionally, including on the "neither engine" path: it is MCP activation, not credentials.

## Environment variables the app reads

These are the variables consumed by `api/src/env.ts`. The file is parsed with Zod; process environment always wins over any `.env` file.

### Hard requirements (fail-fast)

- **Either `ENCRYPTION_ACTIVE_KEY` or `AUTH_ENCRYPTION_KEY` must be set.** Both accept 32 raw bytes, base64-encoded. The app refuses to start if neither is present. Back these up carefully — losing them destroys all encrypted auth payloads.
- `AUTH_RUNNER_SHARED_SECRET` is required when `AUTH_RUNNER_URL` is set.
- `ADMIN_WEBAUTHN_ORIGIN` is required when `ADMIN_WEBAUTHN_RP_ID` is set.

### Core

- `PUBLIC_BASE_URL` — canonical base URL the installer script embeds in the bootstrap transition launcher.
- `PUBLIC_BASE_URL_REQUIRED` — bool, default `true`. Fails startup if `PUBLIC_BASE_URL` is missing.
- `ADMIN_ACCESS_MODE` — `cookie` (default) or `open`; it decides only whether `/cli/auth/verify` requires an admin session.
- `ADMIN_SESSION_COOKIE` — default `codex_admin_session`.
- `ADMIN_SESSION_TTL_MINUTES` — default `43200` (30 days) in `env.ts`. `AdminAuthService.sessionTtlSeconds()` clamps this to 5 min – 7 days at login, so a fresh session starts at 7 days; `auth-admin.ts`'s `resolveAdmin` then rolls `expiresAt` forward on every authenticated request using the same TTL clamped to 5 min – 30 days, so an actively used session keeps renewing out to 30 days.
- `ADMIN_WEBAUTHN_RP_ID`, `ADMIN_WEBAUTHN_ORIGIN`, `ADMIN_WEBAUTHN_RP_NAME` — passkey relying-party metadata.
- `ADMIN_WS_ENABLED` — defaults to `false` in env.ts, but **the compose file sets it to `1` (enabled) by default** when using the compose stack. Also: `ADMIN_WS_PUBLIC_URL`, `ADMIN_WS_HEARTBEAT_SECONDS`, `ADMIN_WS_BACKLOG_LIMIT`.
- `INSTALLATION_ID` — optional installation identifier.

### Auth runner

- `AUTH_RUNNER_URL`, `AUTH_RUNNER_SHARED_SECRET` — how the API reaches the Python runner. **Note:** the compose file passes `RUNNER_SHARED_SECRET` to the `auth-runner` container; `AUTH_RUNNER_SHARED_SECRET` is what the API reads. These are separate variables for different services.
- `AUTH_RUNNER_CODEX_BASE_URL` — Codex auth base URL for the runner.
- `AUTH_RUNNER_TIMEOUT` — default `8` (seconds). HTTP timeout used for calls to the runner (health checks, verify, exec).
- `AUTH_RUNNER_VERIFY_TTL_SECONDS` — default `900`. Minimum re-check interval for the background auth-verification worker's dynamic schedule.
- `AUTH_RUNNER_VERIFY_WORKER_INTERVAL_SECONDS` — default `300`. Wake-up interval for the background worker (`api/src/ops/auth-verification-worker.ts`, started from `server.ts`) that replaced synchronous runner verification on the request/boot path; a wake-up only probes when the schedule says a re-check is due.
- `AUTH_RUNNER_VERIFY_MAX_INTERVAL_SECONDS` — default `21600`. Ceiling for the dynamic schedule: the re-check interval grows with how long the credential has been proven good, and successful gateway traffic counts as proof (probes stay idle while real traffic flows).
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

**Caddy terminates TLS and reverse-proxies every path to the API**, including `/admin*` and the admin WebSocket at `/admin/ws`. It does not request client certificates; the admin console is protected by its session cookie.

If a proxy you run in front terminates mTLS, it may forward `X-MTLS-Fingerprint`, `X-MTLS-Subject` and `X-MTLS-Issuer`. The API records those on `req.mtls` when the peer is inside `TRUSTED_PROXY_CIDRS` and ignores them otherwise; no route authorizes on them.

## Seeding the canonical auth

Hosts cannot fetch auth until the orchestrator has its own copy. One form, reachable from two places: the wizard's **Credentials** step, and *Hosts → More → Seed canonical auth* afterwards. Both mount the same `SeedAuthPanel`, so the product's only canonical-auth UI cannot drift into two versions. It offers two paths:

- **Upload.** Paste the credential or pick the file. The route is `POST /admin/auth/upload`. This is the normal path once you are running.
- **Seed auth token.** `POST /admin/auth/seed-command` mints a single-use token, backed by an `auth_seed_tokens` row. The generated `curl | bash` snippet is copied automatically; the admin runs it on the machine that currently holds the canonical `~/.codex/auth.json` (or `~/.claude/.credentials.json`). The seed endpoint is `POST /seed/auth/{token}` (aliased to `/seed/v2/auth/{token}`). Tokens are UUIDs and are consumed on success. Token TTL is controlled by `AUTH_SEED_TOKEN_TTL_SECONDS` (default 900 s).

The GET twin at `/seed/auth/{token}` returns an executable shell script that reads your local credential file and POSTs it back.

Every candidate is verified against the live provider before it is stored, and the panel reports which of the three outcomes happened rather than a blanket success: `POST /admin/auth/upload` answers 200 even when the live runner probe leaves a candidate `pending` or `failed`, and the setup checklist counts only **verified** credentials — so a stored-but-unverified value keeps the step open. When the auth runner itself is down the panel says so up front instead of letting every attempt fail with an identical 503.

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

- The dashboard shows a **Resume setup** / **Finish setting up** card while the wizard is unfinished and at least one next action is still open. It deep-links back to the step you stopped on; **Dismiss** hides it permanently.
- From the admin UI, visit *Dashboard*. New hosts appear under *Hosts → Unprovisioned* until they complete a successful sync; after that they move to *Secure* (or *Insecure*, if you activated insecure mode on registration). Use the **Runner state** card's **Run verification** button (one per engine) to confirm the runner is reachable; it calls `POST /admin/runner/run` for Codex or `/admin/runner/run-claude` for Claude.
- Click into any host to see its per-host baked config version, last auth digest, and IP binding state.

## Backups

There is no built-in backup job. Back up:

1. The MySQL volume (`docker-compose.yml` names the data volume for you).
2. The encryption keyring referenced by `Keyring` (the values in `ENCRYPTION_KEYS` / `AUTH_ENCRYPTION_KEYS`).
3. The wrapper signing key — held in the `wrapper_signing_keys` table. Several keys may be active at once and all of them sign, so *adding* a replacement is non-breaking, but rotating still requires every host to self-update: a binary verifies with the one public key embedded in it, so retiring the old key breaks every host that is not yet on a binary embedding the new one. Follow the runbook in `docs/wrapper-v2-architecture.md`. Losing the key is the hard case — it requires re-issuing the key and re-deploying binaries before any host can verify its config again.

Without the encryption keys you cannot decrypt `auth_payloads`. The app will still run, but every host will fail sync until a fresh canonical auth is re-uploaded.

## Source references

- README.md (quick start)
- bin/install.sh (the twelve installer steps, `doctor`, `--json` / `--non-interactive`)
- api/src/db/baseline/schema.sql and `migrate.js --init-schema` (empty-database bootstrap)
- api/src/routes/admin/setup/index.ts (`/admin/setup/status`, `/owner`, `/wizard`)
- api/src/services/setup-status.ts (the six critical checks, next actions)
- api/src/services/setup-wizard.ts (`SETUP_WIZARD_STEPS`, `setup_wizard_state`)
- frontend/src/routes/setup/+page.svelte (wizard rail, blocking rules, `?step=`)
- frontend/src/lib/components/setup/SeedAuthPanel.svelte (the shared credential form)
- frontend/src/routes/dashboard/OnboardingCard.svelte (resume card)
- docker-compose.yml (stack definition)
- caddy/Caddyfile (TLS termination and reverse-proxy config)
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
- bin/install.sh and api/src/ops/setup-signing-key.ts (installation signing-key lifecycle)
