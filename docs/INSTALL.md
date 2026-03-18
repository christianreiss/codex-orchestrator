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
   - The quota cron fetches ChatGPT usage; pricing lookups can pull from `PRICING_URL` when configured.

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
   - Admin surface: `ADMIN_ACCESS_MODE` (default `mtls`) controls app-level admin mTLS checks.
   - When using bundled Caddy, `/admin*` still requires a valid client certificate at the proxy layer.
   - Admin login (recommended):
    - `ADMIN_SESSION_COOKIE` (default `codex_admin_session`)
    - `ADMIN_SESSION_TTL_SECONDS` (default 28800)
    - `ADMIN_PASSWORD_MIN_LENGTH` (default 12)
    - Password-reset endpoints are intentionally disabled (`410 Gone`).
   - Runner knobs: `AUTH_RUNNER_URL` (blank disables API-side runner verification), `AUTH_RUNNER_CODEX_BASE_URL` (legacy compatibility setting; no longer sent to the runner request body), `AUTH_RUNNER_TIMEOUT`, optional `AUTH_RUNNER_SHARED_SECRET`, `AUTH_RUNNER_IP_BYPASS` + `AUTH_RUNNER_BYPASS_SUBNETS` (allow runner probes to bypass host IP pinning on internal CIDRs).
   - Proxy/origin hardening: `TRUST_X_FORWARDED`, `TRUSTED_PROXY_CIDRS`, `MCP_ALLOW_REQUEST_HOST_ORIGIN`.
   - Base-URL policy: `APP_ENV`, `PUBLIC_BASE_URL`, `PUBLIC_BASE_URL_REQUIRED`, `STRICT_HOST_VALIDATION`.
   - Startup behavior: `RUN_MIGRATIONS_ON_BOOT` and `RUN_BACKFILLS_ON_BOOT` (default off in production; use `scripts/migrate.php` for explicit schema/backfill runs).
   - Token TTLs: `INSTALL_TOKEN_TTL_SECONDS` (default 1800) and `AUTH_SEED_TOKEN_TTL_SECONDS` (default 900).
   - Rate limits: `RATE_LIMIT_GLOBAL_PER_MINUTE` and `RATE_LIMIT_GLOBAL_WINDOW` (per-IP global bucket; defaults 120 req / 60s for non-admin routes).
  - Usage/pricing telemetry: `CHATGPT_USAGE_CRON_INTERVAL`, `CHATGPT_BASE_URL`, `CHATGPT_USAGE_TIMEOUT`, `PRICING_URL`, `PRICING_CURRENCY`, and the static GPT-5.4 price hints (`GPT54_INPUT_PER_1K`, `GPT54_OUTPUT_PER_1K`, `GPT54_CACHED_PER_1K`; legacy `GPT51_*` is still accepted when unset). `quota-cron` health defaults to a worker heartbeat file at `CHATGPT_USAGE_HEALTH_PATH` and treats success as stale after `CHATGPT_USAGE_CRON_INTERVAL + 300s` unless `CHATGPT_USAGE_HEALTH_MAX_AGE_SECONDS` overrides it.
   - Debug/ops: `PUBLIC_BASE_URL` (explicit host-facing base URL for installers/wrapper), `CODEX_SYNC_BASE_URL` (runner probes), `CODEX_DEBUG` (runner/debug surfaces), `ENV_FILE` if you keep `.env` elsewhere.
3. Ensure `.env` is kept out of git and treated as a secret.

## Build and Run

```bash
# already done if you ran bin/setup.sh without --no-build/--no-up/--prepare-only
docker compose up --build
```

- Starts `api`, `admin-ws`, `quota-cron`, `auth-runner`, `mysql`, and `mysql-backup`. Add `--profile caddy` for the TLS proxy (bin/setup.sh toggles this when you keep Caddy enabled).
- API defaults to `http://localhost:8488`.
- Admin dashboard: `/admin/` (login-first once admin users exist). With bundled Caddy, client certs are required for `/admin*`.
- Runner verification is enabled by default (`AUTH_RUNNER_URL=http://auth-runner:8080/verify`); clear that env to disable API-side runner checks. Admin seed/admin upload paths skip runner validation. Set `AUTH_RUNNER_SHARED_SECRET` and matching `RUNNER_SHARED_SECRET` to authenticate API->runner calls.
- API container startup runs `php /var/www/html/scripts/migrate.php` before serving traffic (schema + encryption/api-key backfills). Runtime request-path migrations are disabled by default in production.
- A `quota-cron` sidecar refreshes ChatGPT quota snapshots on a timer (default hourly) by running `scripts/refresh-chatgpt-usage.php`; tune with `CHATGPT_USAGE_CRON_INTERVAL` (seconds). Its container health now follows a local worker heartbeat (`scripts/check-quota-cron-health.php`) instead of only checking MySQL reachability, so repeated refresh failures surface as unhealthy.
- `admin-ws` listens on `127.0.0.1:8091`; `/admin/ws/info` only advertises it when `ADMIN_WS_ENABLED=1`.
- Global rate limit for non-admin routes defaults to 120 req/min/IP (`RATE_LIMIT_GLOBAL_PER_MINUTE` + `RATE_LIMIT_GLOBAL_WINDOW`).

## Optional: bundled Caddy frontend (no existing proxy)

1. Populate the `CADDY_*` env vars in `.env` (domain, ACME email, TLS fragment, cert/key paths). Defaults point at `/var/docker_data/codex-auth.example.com/caddy/*`.
2. Place your admin mTLS CA at `${CADDY_MTLS_DIR}/ca.crt` (or adjust `CADDY_MTLS_CA_FILE`). Bundled Caddy requests client certs for all requests, blocks `/admin*` unless a validated certificate is present, and forwards `X-MTLS-*` headers for the app.
3. Pick a cert source:
   - **Let's Encrypt/ZeroSSL**: keep `CADDY_TLS_FRAGMENT=/etc/caddy/tls-acme.caddy`, set `CADDY_DOMAIN` + `CADDY_ACME_EMAIL`, and ensure ports 80/443 reach this host.
   - **Custom cert**: set `CADDY_TLS_FRAGMENT=/etc/caddy/tls-custom.caddy` and drop `tls.crt` / `tls.key` (or update `CADDY_TLS_CERT_FILE`/`CADDY_TLS_KEY_FILE`) into `${CADDY_TLS_DIR}`.
4. Start the stack with Caddy: `docker compose --profile caddy up --build -d`. External clients should use `https://<CADDY_DOMAIN>`; the API remains on host loopback `127.0.0.1:8488`.

## Backups & cost visibility

- Nightly SQL dumps run automatically via the `mysql-backup` sidecar. Tune `DB_BACKUP_CRON` (cron spec), `DB_BACKUP_MAX` (retained files), `DB_BACKUP_BEGIN`, and `DB_BACKUP_FREQUENCY`. Dumps land in `${DATA_ROOT}/backups`.
- Admin cost estimates read GPT-5.4 unit prices from env (`GPT54_*`, `PRICING_CURRENCY`, with legacy `GPT51_*` fallback) or, when `PRICING_URL` is set, from that JSON endpoint. This only affects dashboard calculations, not enforcement.

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
