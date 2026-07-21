# Installation Guide

This doc walks through setting up the Codex Auth stack with Docker, admin login, and a baked-in `cdx` wrapper.

## Prerequisites

- Docker + docker compose.
- TLS termination for public deployments:
  - Preferred: your own reverse proxy/ingress that terminates TLS and forwards accurate `X-Forwarded-*` headers.
  - Alternate: enable the bundled Caddy profile in `docker-compose.yml` (disabled by default) to serve 443 with ACME **or** supplied certs.
- MySQL 8 (the compose file runs a MySQL sidecar).
- Host paths for persistent data (default in `docker-compose.yml`):
  - `/var/docker_data/codex-auth.example.com/mysql_data`
  - `/var/docker_data/codex-auth.example.com/store` (wrapper, storage/sql exports)
  - When using the bundled Caddy frontend: `/var/docker_data/codex-auth.example.com/caddy/tls` for custom cert/key, `/var/docker_data/codex-auth.example.com/caddy/mtls` for the admin CA, plus named volumes `caddy_data` and `caddy_config` (ACME + Caddy state).
- Optional internet egress for helper services:
   - The auth runner pings Codex clients to validate auth.json (clear `AUTH_RUNNER_URL` to disable it).
   - The quota cron fetches ChatGPT usage.

## Recommended: one-command setup

Run the guided installer to generate `.env`, create data dirs, wire TLS, and optionally build/start the stack:

```bash
bin/setup.sh
```

What it does

- Verifies `docker` + Compose v2; on Linux it can install Docker via `get.docker.com` (asks first) and on macOS via Homebrew (`brew install --cask docker`).
- Copies `.env.example` to `.env` if missing, sets strict perms, and auto-fills secrets:
  - `AUTH_ENCRYPTION_KEY` (libsodium secretbox key) if empty.
  - `INSTALLATION_ID` if empty.
  - Random `DB_USERNAME`, `DB_PASSWORD`, `DB_ROOT_PASSWORD` if defaults are still present.
- Prompts for `DATA_ROOT` (default `/var/docker_data/codex-auth.example.com`) and creates `store`, `store/sql`, `store/logs`, `mysql_data`, `caddy/tls`, `caddy/mtls`, and `backups` under it.
- Prompts for external URLs used by hosts/runner:
  - `CODEX_SYNC_BASE_URL` (runner container base URL for Codex probes; defaults to the API URL in compose)
  - `AUTH_RUNNER_CODEX_BASE_URL` (legacy compatibility knob; retained in setup/env but no longer sent to the runner verifier payload)
  - Set `PUBLIC_BASE_URL` for production so installers/wrappers always bake the correct base URL.
- Optional bundled Caddy frontend (reverse proxy on :80/:443):
  - Prompts for app-level admin mode (`ADMIN_ACCESS_MODE=mtls|none`).
  - Bundled Caddy still requires a valid client cert for `/admin*` and forwards `X-MTLS-*` headers.
  - If enabled, asks for `CADDY_DOMAIN` and TLS mode:
    1. **ACME (Let’s Encrypt/ZeroSSL)** — sets `CADDY_ACME_EMAIL`, uses `tls-acme` fragment; requires public 80/443.
    2. **Custom cert** — sets `tls-custom` fragment and file names; can copy cert/key from `--tls-cert-path/--tls-key-path` into the data root.
    3. **Self-signed** — generates CA + server cert into `caddy/tls`, sets paths accordingly; you must trust the CA on clients.
- Admin client-certificate material:
  1. **Bring your own CA** — copies your CA into `caddy/mtls/ca.crt`.
  2. **Generate new** — creates a CA + `client-admin` cert/key in `caddy/mtls` for browser/API access.
  - Enables the `caddy` compose profile automatically when you leave Caddy on.
- Builds and/or starts the Docker stack (calls `docker compose [--profile caddy] build --pull` then `up -d`) unless you skip with flags.

Useful flags

- `--prepare-only` — write `.env` and create data dirs, skip build/up.
- `--no-build` / `--no-up` — control compose phases separately.
- `--non-interactive` — never prompt; combine with the flags below to supply values.
- `--data-root PATH` — set `DATA_ROOT` without prompting.
- `--codex-url URL` / `--runner-url URL` — set `CODEX_SYNC_BASE_URL` / `AUTH_RUNNER_CODEX_BASE_URL` (`--runner-url` is a legacy compatibility setting; `PUBLIC_BASE_URL` still controls host-facing installer/wrapper URLs).
- `--caddy` or `--no-caddy` — force enable/disable the bundled proxy.
- `--caddy-domain DOMAIN` — seed `CADDY_DOMAIN`.
- TLS options: `--tls-mode 1|2|3`, `--acme-email`, `--tls-cert-path`, `--tls-key-path`, `--tls-cert`, `--tls-key`, `--tls-sans`.
- mTLS options: `--mtls-mode 1|2`, `--mtls-ca-path`, `--mtls-ca-cn`, `--mtls-client-cn`, `--mtls-required` / `--mtls-optional`.
- Set `ENV_FILE=/path/to/custom.env` to write somewhere other than `.env`.

Examples

- **Default interactive** (recommended for first-time): `bin/setup.sh`
- **Non-interactive self-signed dev stack without auto-start:**
  ```bash
  bin/setup.sh --non-interactive --caddy --tls-mode 3 --tls-sans "localhost,127.0.0.1" \
    --mtls-mode 2 --data-root ./local-data --no-up
  ```
- **Prep only, no Docker yet:** `bin/setup.sh --prepare-only`

Heads-up for non-interactive runs

- Caddy stays enabled unless you pass `--no-caddy`.
- Default data root is `/var/docker_data/<domain>/...`; override with `--data-root` when running as non-root or keeping data inside the repo for throwaway VMs. Use a dedicated path for real deployments.
- First build pulls `mysql:8.0` and `php:8.2-apache`; initial download can take a few minutes.

You can rerun `bin/setup.sh` anytime; it keeps existing values unless you supply different answers/flags.

## Environment

Prefer the installer (`bin/setup.sh`) to generate `.env` and secrets. If you need to edit manually instead:

1. Copy `.env.example` to `.env`.
2. Configure secrets/paths:
   - `DB_HOST/DB_PORT/DB_DATABASE/DB_USERNAME/DB_PASSWORD/DB_ROOT_PASSWORD`
   - `AUTH_ENCRYPTION_KEY` (leave empty to auto-generate on first boot).
   - `INSTALLATION_ID` (UUID; auto-generated by `bin/setup.sh` and on first boot when missing).
   - `DATA_ROOT` if you want a different bind-mount root.
   - `CODEX_AUTH_SUBNET` / `CODEX_AUTH_GATEWAY` if the internal compose bridge conflicts with a local route. Defaults use `172.30.250.0/24`.
   - Admin surface: `ADMIN_ACCESS_MODE` (default `mtls`) controls app-level admin mTLS checks.
   - When using bundled Caddy, `/admin*` still requires a valid client certificate at the proxy layer.
   - Admin login (recommended):
    - `ADMIN_SESSION_COOKIE` (default `codex_admin_session`)
    - `ADMIN_SESSION_TTL_SECONDS` (default 28800)
    - `ADMIN_PASSWORD_MIN_LENGTH` (default 12)
    - Password recovery uses `PUBLIC_BASE_URL` for the emailed reset link and SMTP settings for delivery; reset tokens are single-use and expire after one hour.
   - Runner knobs: `AUTH_RUNNER_URL` (blank disables API-side runner verification), `AUTH_RUNNER_CODEX_BASE_URL` (legacy compatibility setting; no longer sent to the runner request body), `AUTH_RUNNER_TIMEOUT`, `AUTH_RUNNER_VERIFY_TTL_SECONDS`, `AUTH_RUNNER_VERIFY_WORKER_INTERVAL_SECONDS`, optional `AUTH_RUNNER_SHARED_SECRET`, optional `AUTH_RUNNER_SKILL_SUMMARY_URL`, optional `AUTH_RUNNER_MEMORY_SUMMARY_URL`, optional `AUTH_RUNNER_SKILL_GENERATE_URL`, and `AUTH_RUNNER_IP_BYPASS` + `AUTH_RUNNER_BYPASS_SUBNETS` (allow runner probes to bypass host IP pinning on internal CIDRs).
   - Proxy/origin hardening: `TRUST_X_FORWARDED`, `TRUSTED_PROXY_CIDRS`, `MCP_ALLOW_REQUEST_HOST_ORIGIN`.
   - Base-URL policy: `APP_ENV`, `PUBLIC_BASE_URL`, `PUBLIC_BASE_URL_REQUIRED`, `STRICT_HOST_VALIDATION`.
   - Schema changes: apply the reviewable SQL under `api/src/db/migrations/` explicitly before starting the matching API version. There is no boot migration runner.
   - Token TTLs: `INSTALL_TOKEN_TTL_SECONDS` (default 1800) and `AUTH_SEED_TOKEN_TTL_SECONDS` (default 900).
   - Rate limits: `RATE_LIMIT_GLOBAL_PER_MINUTE` and `RATE_LIMIT_GLOBAL_WINDOW` (per-IP global bucket; defaults 120 req / 60s for non-admin routes).
  - Usage telemetry: `quota-cron` is a default Compose service. It performs one refresh at boot and then polls on `CHATGPT_USAGE_CRON_INTERVAL` (default 900). Configure `CHATGPT_BASE_URL` and `CHATGPT_USAGE_TIMEOUT` as needed. Its healthcheck reads `CHATGPT_USAGE_HEALTH_PATH` and becomes unhealthy when no successful snapshot arrives within `CHATGPT_USAGE_CRON_INTERVAL + 300s`, unless `CHATGPT_USAGE_HEALTH_MAX_AGE_SECONDS` overrides that limit.
   - Debug/ops: `PUBLIC_BASE_URL` (explicit host-facing base URL for installers/wrapper), `CODEX_SYNC_BASE_URL` (runner probes), `CODEX_DEBUG` (runner/debug surfaces), `ENV_FILE` if you keep `.env` elsewhere.
3. Ensure `.env` is kept out of git and treated as a secret.

## Build and Run

```bash
# already done if you ran bin/setup.sh without --no-build/--no-up/--prepare-only
docker compose up --build
```

For an existing checkout, use the deploy helper:

```bash
scripts/deploy.sh --backup
```

It checks the git worktree, fast-forwards from the configured upstream, optionally writes a MySQL dump, builds the compose services, restarts with `--wait` when supported, verifies MySQL, `auth-runner`, and `/healthz`, scans fresh logs for critical failures, and prunes unused Docker build artifacts. Add `--caddy` when this checkout owns the bundled Caddy profile, `--service api` for an API-only restart, or `--skip-git` only when intentionally deploying a local uncommitted tree.

- Starts `api`, `auth-runner`, and `mysql`. Add `--profile caddy` for the TLS proxy (bin/setup.sh toggles this when you keep Caddy enabled).
- API defaults to `http://localhost:8488`.
- Admin dashboard: `/admin/` (login-first once admin users exist). With bundled Caddy, client certs are required for `/admin*`.
- Runner verification is enabled by default (`AUTH_RUNNER_URL=http://auth-runner:8080/verify`); clear that env to disable API-side runner checks. The API keeps canonical Codex/Claude auth fresh from a background worker (`AUTH_RUNNER_VERIFY_WORKER_INTERVAL_SECONDS`, default 300s) instead of blocking wrapper startup. Admin seed/admin upload paths still run through the same strict runner validation/update path as host `/auth` stores, so they require a reachable runner when enabled. Set `AUTH_RUNNER_SHARED_SECRET` and matching `RUNNER_SHARED_SECRET` to authenticate API->runner calls.
- Apply additive migrations before the matching deploy. For example: `docker compose exec -T mysql sh -lc 'mysql -u"$MYSQL_USER" -p"$MYSQL_PASSWORD" "$MYSQL_DATABASE"' < api/src/db/migrations/0004_add_claude_artifacts.sql`. API startup and the deploy helper fail closed if the required `claude_artifacts` table is absent.
- Global rate limit for non-admin routes defaults to 120 req/min/IP (`RATE_LIMIT_GLOBAL_PER_MINUTE` + `RATE_LIMIT_GLOBAL_WINDOW`).

## Optional: bundled Caddy frontend (no existing proxy)

1. Populate the `CADDY_*` env vars in `.env` (domain, ACME email, TLS fragment, cert/key paths). Defaults point at `/var/docker_data/codex-auth.example.com/caddy/*`.
2. Place your admin mTLS CA at `${CADDY_MTLS_DIR}/ca.crt` (or adjust `CADDY_MTLS_CA_FILE`). Bundled Caddy requests client certs for all requests, blocks `/admin*` unless a validated certificate is present, and forwards `X-MTLS-*` headers for the app.
3. Pick a cert source:
   - **Let's Encrypt/ZeroSSL**: keep `CADDY_TLS_FRAGMENT=/etc/caddy/tls-acme.caddy`, set `CADDY_DOMAIN` + `CADDY_ACME_EMAIL`, and ensure ports 80/443 reach this host.
   - **Custom cert**: set `CADDY_TLS_FRAGMENT=/etc/caddy/tls-custom.caddy` and drop `tls.crt` / `tls.key` (or update `CADDY_TLS_CERT_FILE`/`CADDY_TLS_KEY_FILE`) into `${CADDY_TLS_DIR}`.
4. Start the stack with Caddy: `docker compose --profile caddy up --build -d`. External clients should use `https://<CADDY_DOMAIN>`; the API remains on host loopback `127.0.0.1:8488`.

## Backups

- Use `scripts/deploy.sh --backup` before a rollout to write a one-off MySQL dump. Set `CODEX_DEPLOY_BACKUP_DIR` to choose a destination; the default is `./backups`.

## First-Time Flow

1. Log into Codex on a trusted machine to create `~/.codex/auth.json`.
2. Open the admin dashboard, log in (once admin users exist), and click **New Host** to mint an API key + one-time installer. If bundled Caddy is enabled, present a client cert to access `/admin`.
3. Upload your `~/.codex/auth.json` via the dashboard (“Seed auth.json”) or generate the one-time `curl | bash` seed command.
4. Run the installer command on each target host (fresh token per host). The wrapper is baked with base URL + API key; no `sync.env` is written.

## Uninstalling a Host

- Run `cdx --uninstall` on the host; it removes Codex bits/config and calls `DELETE /auth`.

## Security Notes

- Treat `.env`, `storage/`, and MySQL volumes as secrets (contain API/encryption keys and auth payloads).
- Admin login is the default operator workflow once users exist. If bundled Caddy is enabled, `/admin*` requires valid client certs.
- Forwarded headers are trusted only when `TRUST_X_FORWARDED=1` and caller IP matches `TRUSTED_PROXY_CIDRS`; scope those CIDRs tightly.
- In production, keep `PUBLIC_BASE_URL` set and `STRICT_HOST_VALIDATION=1`.
- If you enable `AUTH_RUNNER_IP_BYPASS`, scope `AUTH_RUNNER_BYPASS_SUBNETS` to internal CIDRs only.
- Global rate limiting is off for admin routes but on for everything else; tune or disable with `RATE_LIMIT_GLOBAL_PER_MINUTE`/`RATE_LIMIT_GLOBAL_WINDOW` if your proxy already rate-limits.
