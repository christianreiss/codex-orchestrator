# Installation Guide

Setting up the Codex Auth stack with Docker, admin login, and the common `cxx`
wrapper exposed through the `cdx` / `clx` aliases.

## Prerequisites

- **Docker**, with the Compose v2 plugin. The legacy `docker-compose` binary will
  not do.
- **`curl`, `openssl`, and coreutils** — present on every mainstream distribution.
- That is the whole list. A Go toolchain, `make` and `python3` are used when they
  happen to be installed, and built in a container when they are not.
- Internet egress at build time. The auth-runner image pulls the Codex CLI from
  GitHub releases, Node from nodejs.org, and `@anthropic-ai/claude-code` from
  npm. An air-gapped install needs a mirror for all three.
- TLS termination for public deployments, either:
  - your own reverse proxy or ingress that terminates TLS and forwards accurate
    `X-Forwarded-*` headers (`--tls none`), or
  - the bundled Caddy profile, which serves :443 with ACME or supplied certs.
- Host paths for persistent data, all created under the data root you choose:
  `store` (wrapper artifacts, SQL exports, logs), `mysql_data`, `caddy/tls`,
  `backups`. ACME state lives in the `caddy_data` / `caddy_config` named volumes
  so certificates survive `docker compose down`.

## Install

```bash
bin/install.sh
```

That is the whole install. It takes an empty Docker host to a working console:
generates every secret, creates the data directories, wires TLS, builds this
installation's wrapper fleet, provisions the database schema, starts the stack,
creates the first owner, and verifies readiness — printing `READY` and the
console URL only when all of it passed.

`bin/setup.sh` still works; it is a shim that runs this.

### Steps

Twelve, in order, each independently re-runnable:

| Step | What it does |
|------|--------------|
| `prereqs` | Docker, Compose v2, curl, openssl. Reports whether wrapper builds will use the host toolchain or a container. |
| `secrets` | `.env` from `.env.example` at mode 0600; generates `AUTH_ENCRYPTION_KEY`, `INSTALLATION_ID`, database credentials, and one runner shared secret written to both names. |
| `dataroot` | Prompts for `DATA_ROOT` and creates the directory tree. |
| `urls` | `PUBLIC_BASE_URL`, `CODEX_SYNC_BASE_URL`, `AUTH_RUNNER_CODEX_BASE_URL`, `CADDY_DOMAIN`. |
| `tls` | `acme`, `file`, `selfsigned` or `none`; sets `TRUST_X_FORWARDED` + `TRUSTED_PROXY_CIDRS` to match. |
| `wrappers` | Generates this installation's Ed25519 keypair, then cross-compiles and publishes `cxx` for four platforms with that public key baked in. |
| `datatier` | Builds images, starts `mysql` and `auth-runner`, waits for both to be healthy. |
| `schema` | `migrate.js --init-schema` — creates the schema on an empty database, then migrates. |
| `apptier` | Starts `api` (and `caddy`), waits for health, starts `quota-cron` without waiting. Starts only — image building happens in `datatier`. |
| `signer` | Imports the private signing key encrypted into the database, then deletes the plaintext copy. |
| `owner` | Creates the first owner through the one-time claim and signs it in. |
| `verify` | `/healthz`, all six critical `/readyz` checks, and the public URL. |

The database and API start in separate steps on purpose: the API fails closed on
a pending migration, so the schema has to exist before it opens a listener.

### Re-running and resuming

Re-running is always safe. Configuration steps re-apply so a changed URL or TLS
choice takes effect; the expensive ones (`wrappers`, `schema`, `signer`, `owner`)
record themselves and skip.

```bash
bin/install.sh                          # resume where it stopped
bin/install.sh --from wrappers          # redo that step and everything after
bin/install.sh --only schema            # exactly one step
bin/install.sh --force wrappers         # repeat a recorded step, replacing artifacts
```

`--force wrappers` is the escape hatch for a partial or foreign-signed matrix: it
sets the old one aside and rebuilds. It refuses — without touching anything —
once the plaintext signing key has been removed, because replacing a signing key
means rolling every deployed host in the same window. See
`docs/wrapper-v2-architecture.md`.

**Picking up changed code**: image building lives in `datatier`, not `apptier`.
`--only apptier` restarts the API against the image it already has, so after
editing the API or rebuilding the admin SPA (`cd frontend && npm run build`) run
`--only datatier` first — otherwise the container keeps serving the previous
build and the change appears not to have worked.

### Non-interactive and scripted installs

```bash
bin/install.sh --json --non-interactive \
  --url https://codex.example.com \
  --tls acme --acme-email ops@example.com \
  --admin-name "Ada Lovelace" --admin-user ada --admin-email ada@example.com \
  --admin-pass-file /run/secrets/owner-password
```

`--json` puts one object per step on stdout while the human output stays on
stderr, so both can be consumed from the same run:

```json
{"step":"schema","ok":true,"detail":"schema present and migrations applied"}
```

`--non-interactive` never prompts. Missing values produce a single error naming
all of them at once rather than failing on the first. Passwords are passed as
files, never as flag values — arguments are visible in the process list.

Other useful flags: `--dry-run` (print every change, make none),
`--skip-public-ready` (staged rollouts where DNS is not cut over),
`--no-build`, `--skip-owner`, `--data-root`, `--proxy-cidrs`.
`bin/install.sh --help` has the full list.

### Diagnosing

```bash
bin/install.sh doctor       # what is broken, and the command that fixes it
bin/install.sh verify       # re-run the readiness checks
bin/install.sh print-env    # resolved configuration, secrets masked
```

`doctor` works with the stack down: it reports what it can reach and names the
API as unreachable rather than failing inside it.

### Notes

- The default data root is `/var/docker_data/codex-auth.example.com`. Override
  with `--data-root` when running as non-root or keeping data inside the repo for
  a throwaway VM; use a dedicated path for anything real.
- First build pulls `mysql:8.4`, `node:22-alpine`, `python:3.12-slim` and
  `caddy:2`. Expect a few minutes.
- Existing secrets are preserved. Mismatched keys, mixed wrapper versions,
  incomplete matrices and multiple active database signers all fail closed rather
  than being rotated or overwritten.
- Keep `AUTH_ENCRYPTION_KEY` backed up. Canonical auth is encrypted with it and
  cannot be recovered without it. It is generated at install time — nothing
  generates one at runtime, and the API container is read-only, so it could not
  persist one if it tried.

## Environment

Prefer `bin/install.sh` to generate `.env`. If you edit manually instead:

1. Copy `.env.example` to `.env` and keep it at mode 0600, out of git.
2. Configure:
   - `DB_HOST/DB_PORT/DB_DATABASE/DB_USERNAME/DB_PASSWORD/DB_ROOT_PASSWORD`
   - `AUTH_ENCRYPTION_KEY` — 32 raw bytes, base64. **Required**; the API refuses
     to boot without it.
   - `INSTALLATION_ID` — UUID. Written by the installer.
   - `DATA_ROOT` for the bind-mount root.
   - `CODEX_AUTH_SUBNET` / `CODEX_AUTH_GATEWAY` if the internal compose bridge
     collides with a local route. Defaults to `172.30.250.0/24`.
   - Admin surface: `/admin/*` is gated by the admin session cookie. The API runs
     no client-certificate check of its own — this server neither issues nor
     verifies certificates. `ADMIN_ACCESS_MODE` (`cookie` default, or `open`)
     decides only whether `/cli/auth/verify` requires an admin session.
   - Admin login:
     - `ADMIN_SESSION_COOKIE` (default `codex_admin_session`)
     - `ADMIN_SESSION_TTL_MINUTES` (default 43200; an issued session is clamped
       to 7 days regardless)
     - Admin passwords must be at least 12 characters. That floor is fixed in the
       API and has no env knob.
     - Password recovery uses `PUBLIC_BASE_URL` for the emailed reset link and
       SMTP settings for delivery; reset tokens are single-use and expire after
       one hour.
   - Runner knobs: `AUTH_RUNNER_URL` (blank leaves verification unavailable, so
     existing verified auth may still be served but every new canonical-auth
     store is blocked), `AUTH_RUNNER_CODEX_BASE_URL` (legacy compatibility
     setting; no longer sent to the runner request body), `AUTH_RUNNER_TIMEOUT`,
     `AUTH_RUNNER_VERIFY_TTL_SECONDS`,
     `AUTH_RUNNER_VERIFY_WORKER_INTERVAL_SECONDS`, `AUTH_RUNNER_SHARED_SECRET`
     (required whenever `AUTH_RUNNER_URL` is set, and must equal
     `RUNNER_SHARED_SECRET`), and `AUTH_RUNNER_IP_BYPASS` +
     `AUTH_RUNNER_BYPASS_SUBNETS`.
   - Proxy trust: `TRUST_X_FORWARDED` and `TRUSTED_PROXY_CIDRS`. Together they
     decide which peers may speak for the client — they gate `X-Forwarded-For`,
     `X-Real-IP`, and the `X-MTLS-Fingerprint` / `-Subject` / `-Issuer` claims a
     proxy that terminates mTLS may forward. Both default to off, so an
     unconfigured server believes no forwarded header at all. Scope the CIDRs
     tightly; anything inside them can claim to be any client.
   - Origin policy: `MCP_ALLOW_REQUEST_HOST_ORIGIN`, `APP_ENV`,
     `PUBLIC_BASE_URL`, `PUBLIC_BASE_URL_REQUIRED`, `STRICT_HOST_VALIDATION`.
   - Schema: `RUN_MIGRATIONS_ON_BOOT` (default on) applies every pending file
     under `api/src/db/migrations/` before the API opens a listener. Turning it
     off does not turn off the *check* — boot still fails while a migration is
     pending. `MIGRATIONS_LOCK_TIMEOUT` (default 120) bounds the advisory-lock
     wait when several instances boot at once, `MIGRATIONS_DIR` overrides the
     directory for a non-standard layout, and `RUN_BACKFILLS_ON_BOOT` (default
     off) runs the data backfills.
   - Token TTLs: `AUTH_SEED_TOKEN_TTL_SECONDS` (default 900). One-time installer
     tokens are fixed at 1800s in the API and have no env knob.
   - Traffic shaping: the API has no in-process request-rate limiter; configure one at the trusted edge if required.
   - Tracing: `OTEL_TRACES_ENABLED` (default off) turns on OpenTelemetry spans
     over the wrapper config bakery, and `OTEL_SERVICE_NAME` (default
     `codex-orchestrator-api`) names the service. Off means the SDK is never
     imported and no exporter connection exists. Endpoint, headers and sampling
     use the standard `OTEL_EXPORTER_OTLP_*` / `OTEL_TRACES_SAMPLER*` variables
     read by the SDK itself. See `docs/wrapper-v2-architecture.md`.
   - Usage telemetry: `quota-cron` is a default Compose service. It refreshes
     once at boot then polls on `CHATGPT_USAGE_CRON_INTERVAL` (default 900).
     Configure `CHATGPT_BASE_URL` and `CHATGPT_USAGE_TIMEOUT` as needed. Its
     healthcheck reads `CHATGPT_USAGE_HEALTH_PATH` and goes unhealthy when no
     successful snapshot arrives within `CHATGPT_USAGE_CRON_INTERVAL + 300s`,
     unless `CHATGPT_USAGE_HEALTH_MAX_AGE_SECONDS` overrides it. A fresh install
     is expected to sit unhealthy here until provider auth is seeded.
   - Debug/ops: `CODEX_SYNC_BASE_URL` (runner probes), `CODEX_DEBUG`, and
     `ENV_FILE` if you keep the env file elsewhere.

### A warning about `ENV_FILE`

Compose reads the env file twice, and only one of those honours `ENV_FILE`.
`env_file:` hands variables to the container, but every key also named under
`environment:` shadows it — and those `${VAR:-default}` expressions, along with
every `${VAR}` in a bind-mount source, interpolate from Compose's own
environment: the shell plus `./.env`, never `ENV_FILE`.

So a raw `ENV_FILE=./.env.local docker compose up` silently resolves
`AUTH_RUNNER_SHARED_SECRET` to empty and mounts the *default* `DATA_ROOT`, which
fails the `wrappers` readiness check with nothing obviously wrong.
`bin/install.sh` exports the whole file into Compose's environment so the two
agree. If you drive Compose by hand with a non-default env file, do the same.

## Build and Run

The installer does this. To do it yourself:

```bash
docker compose up -d --wait mysql auth-runner
docker compose run --rm -T api node migrate.js --init-schema
docker compose up -d --wait api
docker compose up -d quota-cron
```

For an existing checkout, use the deploy helper:

```bash
scripts/deploy.sh --backup
```

It checks the git worktree, fast-forwards from the configured upstream,
optionally writes a MySQL dump, builds the compose services, restarts with
`--wait` when supported, verifies MySQL, `auth-runner` and `/healthz`, scans
fresh logs for critical failures, and prunes unused Docker build artifacts. Add
`--caddy` when this checkout owns the bundled Caddy profile, `--service api` for
an API-only restart, or `--skip-git` only when intentionally deploying a local
uncommitted tree.

- Starts `api`, `auth-runner`, `mysql` and `quota-cron`. Add `--profile caddy`
  for the TLS proxy.
- API defaults to `http://localhost:8488`.
- Setup wizard: `/admin/setup`. Nine steps from a bare console to a configured
  fleet — infrastructure, owner, engines, credentials, fleet defaults, agent
  policy, modules, collaboration, first host. The first two block; everything
  after is skippable, and progress is saved so an interrupted run resumes from
  the dashboard card. See "The first-run wizard" below.
- Admin dashboard: `/admin/` — login-first once admin users exist.
- Runner verification is on by default (`AUTH_RUNNER_URL=http://auth-runner:8080/verify`).
  Leaving it blank keeps existing verified auth readable but blocks every
  canonical-changing store. The API keeps canonical Codex/Claude auth fresh from
  a background worker (`AUTH_RUNNER_VERIFY_WORKER_INTERVAL_SECONDS`, default
  300s) instead of blocking wrapper startup. Admin seed and admin upload paths
  run through the same strict runner validation as host `/auth` stores.
- Pending migrations are applied at boot, so deploying a version that adds schema
  needs no separate step. API startup fails closed if the required
  `claude_artifacts` table is absent.
- The API does not impose a local request-rate limit.

### Where the schema comes from

The migrations extend an existing schema — 0003 and 0006 carry foreign keys — so
they cannot build one from an empty database. `migrate.js --init-schema` applies
`api/src/db/baseline/schema.sql` first, but only when the database holds no
application tables, and then runs the migrations on top. Against a database that
already has them it reports `skipped` and migrates as usual, so it is safe on
every re-run and against an existing deployment. See `api/src/db/README.md`.

## Optional: bundled Caddy frontend (no existing proxy)

1. Populate the `CADDY_*` variables in `.env` — domain, ACME email, TLS fragment,
   cert/key paths. `bin/install.sh --tls acme|file|selfsigned` does this.
2. Pick a certificate source:
   - **Let's Encrypt / ZeroSSL**: keep `CADDY_TLS_FRAGMENT=/etc/caddy/tls-acme.caddy`,
     set `CADDY_DOMAIN` + `CADDY_ACME_EMAIL`, and make sure ports 80/443 reach
     this host.
   - **Custom cert**: set `CADDY_TLS_FRAGMENT=/etc/caddy/tls-custom.caddy` and put
     `tls.crt` / `tls.key` into `${CADDY_TLS_DIR}` (or point
     `CADDY_TLS_CERT_FILE` / `CADDY_TLS_KEY_FILE` elsewhere).
3. Start with the profile: `docker compose --profile caddy up --build -d`.
   External clients use `https://<CADDY_DOMAIN>`; the API stays on host loopback
   `127.0.0.1:8488`.

Caddy terminates TLS and reverse-proxies everything to the API. It does not
request client certificates. If you put your own proxy in front that does
terminate mTLS, it may forward `X-MTLS-Fingerprint` / `-Subject` / `-Issuer`; the
API reads those headers from peers inside `TRUSTED_PROXY_CIDRS` and ignores them
from anyone else. Nothing in the API authorizes on them today.

## Backups

- `scripts/deploy.sh --backup` writes a one-off MySQL dump before a rollout. Set
  `CODEX_DEPLOY_BACKUP_DIR` to choose a destination; the default is `./backups`.

## The first-run wizard

Opening the console for the first time lands on `/admin/setup`. Nine steps:

| Step | What it does | Blocking |
|------|--------------|----------|
| Infrastructure | The six readiness checks, each with the command that fixes it. | **yes** |
| Owner | The one-time first-owner claim; issues the session inline. | **yes** |
| Engines | Codex, Claude, both, or neither. Drives the next step. | no |
| Credentials | One canonical credential per selected engine. | no |
| Fleet defaults | Model and effort — **and the write that activates MCP**. | no |
| Agent policy | The seeded fleet policy, plus optional house rules. | no |
| Modules | Projects and Secrets. | no |
| Collaboration | Agent portal and agent messaging. | no |
| First host | Optional. Registers a host and prints its installer command. | no |

Everything after the owner has **Skip**, because "no" is a complete answer to
most of it. Position is saved server-side, so an interrupted run resumes from
the dashboard card; finishing or dismissing hides that card for good.

### Why "Fleet defaults" is not cosmetic

A fresh install has no fleet client-config row. Without one the managed feature
context reports `config_missing`, and skills, memory, projects and secrets all
resolve disabled *before their own switches are read* — so enabling Projects on
a brand-new install does nothing at all. `POST /admin/model-defaults/codex` is
the only thing that creates that row, and the GET happily returns a default that
was never persisted, which is how a console can look configured while every
managed feature is dark.

The wizard therefore saves codex defaults on that step **unconditionally**,
including when you answered "neither" on the engines step: it is about MCP
activation, not credentials.

### Seeding credentials by hand

The wizard's credentials step is also reachable afterwards from Hosts → More →
**Seed canonical auth**, which opens the same panel in a dialog. Either way:

1. Log into Codex on a trusted machine to create `~/.codex/auth.json`, or have
   an OpenAI / Anthropic API key ready.
2. Paste it, pick the file, or mint a one-time `curl | bash` seed command for a
   machine you cannot paste from.
3. Every candidate is verified against the live provider before it is stored.
   A `pending` or `failed` result is reported as such — the checklist counts only
   verified credentials, so a stored-but-unverified value keeps the step open.

## Uninstalling a Host

- Run `cdx --uninstall` on the host. It removes Codex bits and config and calls
  `DELETE /auth`.

## Security Notes

- Treat `.env`, `storage/` and the MySQL volume as secrets: they hold API keys,
  the encryption key and auth payloads. The installer keeps `.env` at mode 0600.
- Admin login is the operator workflow once users exist. There is no
  certificate-based bypass and no certificate-based gate.
- Forwarded headers — including any `X-MTLS-*` your proxy sets — are trusted only
  when `TRUST_X_FORWARDED=1` and the caller's IP matches `TRUSTED_PROXY_CIDRS`.
  Scope those CIDRs tightly.
- In production keep `PUBLIC_BASE_URL` set and `STRICT_HOST_VALIDATION=1`.
- If you enable `AUTH_RUNNER_IP_BYPASS`, scope `AUTH_RUNNER_BYPASS_SUBNETS` to
  internal CIDRs only.
- The API does not meter request rates. Put traffic shaping at the proxy when
  the deployment requires it.
