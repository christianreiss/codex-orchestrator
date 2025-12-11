# Installation Guide

This doc walks through setting up the Codex Auth stack with Docker, mTLS, and a baked-in `cdx` wrapper.

## Prerequisites

- Docker + docker compose.
- TLS/mTLS termination:
  - Preferred: your own reverse proxy/ingress that terminates TLS **and** forwards mTLS headers (`X-mTLS-Present`, `X-MTLS-FINGERPRINT`, `X-MTLS-SUBJECT`, `X-MTLS-ISSUER`) plus accurate `X-Forwarded-For`/`X-Real-IP`.
  - Alternate: enable the bundled Caddy profile in `docker-compose.yml` (disabled by default) to serve 443 with ACME **or** supplied certs and enforce admin mTLS there by default (`ADMIN_REQUIRE_MTLS=1`, toggle to `0` if you gate `/admin` another way).
- MySQL 8 (the compose file runs a MySQL sidecar).
- Host paths for persistent data (default in `docker-compose.yml`):
  - `/var/docker_data/codex-auth.example.com/mysql_data`
  - `/var/docker_data/codex-auth.example.com/store` (wrapper, storage/sql exports)
  - When using the bundled Caddy frontend: `/var/docker_data/codex-auth.example.com/caddy/tls` for custom cert/key, `/var/docker_data/codex-auth.example.com/caddy/mtls` for the admin CA, plus named volumes `caddy_data` and `caddy_config` (ACME + Caddy state).
 - Optional internet egress for helper services:
   - The auth runner pings Codex clients to validate auth.json (clear `AUTH_RUNNER_URL` to disable it).
   - The quota cron fetches ChatGPT usage; pricing lookups can pull from `PRICING_URL` when configured.

## Recommended: one-command setup

Run the guided installer to generate `.env`, create data dirs, wire TLS/mTLS, and optionally build/start the stack:

```bash
bin/setup.sh
```

What it does

- Verifies `docker` + Compose v2; on Linux it can install Docker via `get.docker.com` (asks first) and on macOS via Homebrew (`brew install --cask docker`).
- Copies `.env.example` to `.env` if missing, sets strict perms, and auto-fills secrets:
  - `AUTH_ENCRYPTION_KEY` (libsodium secretbox key) if empty.
  - Random `DB_USERNAME`, `DB_PASSWORD`, `DB_ROOT_PASSWORD` if defaults are still present.
- Prompts for `DATA_ROOT` (default `/var/docker_data/codex-auth.example.com`) and creates `store`, `store/sql`, `store/logs`, `mysql_data`, `caddy/tls`, `caddy/mtls` under it.
- Prompts for external URLs used by hosts/runner:
  - `CODEX_SYNC_BASE_URL` (API URL baked into installers/wrapper)
  - `AUTH_RUNNER_CODEX_BASE_URL` (runner’s Codex base URL; defaults to the same value)
- Seeds sensible runner defaults so the runner can bypass host IP pinning inside the compose network (`AUTH_RUNNER_IP_BYPASS=1`, `AUTH_RUNNER_BYPASS_SUBNETS=172.28.0.0/16,172.30.0.0/16`).
- Optional bundled Caddy frontend (reverse proxy on :80/:443):
  - Lets you keep or disable the mTLS requirement for `/admin` (`ADMIN_REQUIRE_MTLS`).
  - If enabled, asks for `CADDY_DOMAIN` and TLS mode:
    1. **ACME (Let’s Encrypt/ZeroSSL)** — sets `CADDY_ACME_EMAIL`, uses `tls-acme` fragment; requires public 80/443.
    2. **Custom cert** — sets `tls-custom` fragment and file names; can copy cert/key from `--tls-cert-path/--tls-key-path` into the data root.
    3. **Self-signed** — generates CA + server cert into `caddy/tls`, sets paths accordingly; you must trust the CA on clients.
  - mTLS for `/admin`:
    1. **Bring your own CA** — copies your CA into `caddy/mtls/ca.crt`.
    2. **Generate new** — creates a CA + `client-admin` cert/key in `caddy/mtls` for browser/API access.
  - Enables the `caddy` compose profile automatically when you leave Caddy on.
- Builds and/or starts the Docker stack (calls `docker compose [--profile caddy] build --pull` then `up -d`) unless you skip with flags.

Useful flags

- `--prepare-only` — write `.env` and create data dirs, skip build/up.
- `--no-build` / `--no-up` — control compose phases separately.
- `--non-interactive` — never prompt; combine with the flags below to supply values.
- `--data-root PATH` — set `DATA_ROOT` without prompting.
- `--codex-url URL` / `--runner-url URL` — set `CODEX_SYNC_BASE_URL` / `AUTH_RUNNER_CODEX_BASE_URL`.
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

You can rerun `bin/setup.sh` anytime; it keeps existing values unless you supply different answers/flags.

## Environment

Prefer the installer (`bin/setup.sh`) to generate `.env` and secrets. If you need to edit manually instead:

1. Copy `.env.example` to `.env`.
2. Configure secrets/paths:
   - `DB_HOST/DB_PORT/DB_DATABASE/DB_USERNAME/DB_PASSWORD/DB_ROOT_PASSWORD`
   - `AUTH_ENCRYPTION_KEY` (leave empty to auto-generate on first boot).
   - `DATA_ROOT` if you want a different bind-mount root.
  - Admin surface: `ADMIN_REQUIRE_MTLS` (default `1`).
   - Runner knobs: `AUTH_RUNNER_URL` (blank to disable), `AUTH_RUNNER_CODEX_BASE_URL`, `AUTH_RUNNER_TIMEOUT`, `AUTH_RUNNER_IP_BYPASS` + `AUTH_RUNNER_BYPASS_SUBNETS` (allow runner probes to bypass host IP pinning on internal CIDRs).
   - Rate limits: `RATE_LIMIT_GLOBAL_PER_MINUTE` and `RATE_LIMIT_GLOBAL_WINDOW` (per-IP global bucket; defaults 120 req / 60s for non-admin routes).
   - Usage/pricing telemetry: `CHATGPT_USAGE_CRON_INTERVAL`, `CHATGPT_BASE_URL`, `CHATGPT_USAGE_TIMEOUT`, `PRICING_URL`, `PRICING_CURRENCY`, and the static GPT-5.1 price hints (`GPT51_INPUT_PER_1K`, `GPT51_OUTPUT_PER_1K`, `GPT51_CACHED_PER_1K`).
   - Debug/ops: `CODEX_SYNC_BASE_URL` (baked into installers/wrapper), `CODEX_DEBUG` (echo runner base URL/API key), `ENV_FILE` if you keep `.env` elsewhere.
3. Ensure `.env` is kept out of git and treated as a secret.

## Build and Run

```bash
docker compose up --build
```

- Starts `api`, `quota-cron`, `auth-runner`, and `mysql`. Add `--profile caddy` for TLS proxy and `--profile backup` for nightly SQL dumps (`mysql-backup`).
- API defaults to `http://localhost:8488`.
- Admin dashboard: `/admin/` (mTLS required unless `ADMIN_REQUIRE_MTLS=0`).
- Runner sidecar is enabled by default (`AUTH_RUNNER_URL=http://auth-runner:8080/verify`); clear that env to disable. It writes the canonical auth to `~/.codex/auth.json` and runs `codex` for validation; admin seed uploads skip the runner. Runner probes can bypass host IP pinning when the IP is in `AUTH_RUNNER_BYPASS_SUBNETS` and `AUTH_RUNNER_IP_BYPASS=1`.
- A `quota-cron` sidecar refreshes ChatGPT quota snapshots on a timer (default hourly) by running `scripts/refresh-chatgpt-usage.php`; tune with `CHATGPT_USAGE_CRON_INTERVAL` (seconds).
- Global rate limit for non-admin routes defaults to 120 req/min/IP (`RATE_LIMIT_GLOBAL_PER_MINUTE` + `RATE_LIMIT_GLOBAL_WINDOW`).

## Optional: bundled Caddy frontend (no existing proxy)

1. Populate the `CADDY_*` env vars in `.env` (domain, ACME email, TLS fragment, cert/key paths). Defaults point at `/var/docker_data/codex-auth.example.com/caddy/*`.
2. Place your admin mTLS CA at `${CADDY_MTLS_DIR}/ca.crt` (or adjust `CADDY_MTLS_CA_FILE`). Caddy requests client certs for all requests and, when `ADMIN_REQUIRE_MTLS=1` (default), blocks `/admin*` unless a validated certificate is present; it forwards `X-MTLS-*` headers for the app.
3. Pick a cert source:
   - **Let's Encrypt/ZeroSSL**: keep `CADDY_TLS_FRAGMENT=/etc/caddy/tls-acme.caddy`, set `CADDY_DOMAIN` + `CADDY_ACME_EMAIL`, and ensure ports 80/443 reach this host.
   - **Custom cert**: set `CADDY_TLS_FRAGMENT=/etc/caddy/tls-custom.caddy` and drop `tls.crt` / `tls.key` (or update `CADDY_TLS_CERT_FILE`/`CADDY_TLS_KEY_FILE`) into `${CADDY_TLS_DIR}`.
4. Start the stack with Caddy: `docker compose --profile caddy up --build -d`. External clients should use `https://<CADDY_DOMAIN>`; the API is still reachable on `8488` inside the compose network.

## Optional: backups & cost visibility

- Enable nightly SQL dumps: `docker compose --profile backup up -d`. Defaults come from `DB_BACKUP_CRON` (cron spec) and `DB_BACKUP_MAX` (retained files); dumps land in `${DATA_ROOT}/store/sql`.
- Admin cost estimates read GPT-5.1 unit prices from env (`GPT51_*`, `PRICING_CURRENCY`) or, when `PRICING_URL` is set, from that JSON endpoint. This only affects dashboard calculations, not enforcement.

## First-Time Flow

1. Log into Codex on a trusted machine to create `~/.codex/auth.json`.
2. Open the admin dashboard (mTLS by default) and click **New Host** to mint an API key + one-time installer.
3. Upload your `~/.codex/auth.json` via the dashboard (“Seed auth.json”).
4. Run the installer command on each target host (fresh token per host). The wrapper is baked with base URL + API key; no `sync.env` is written.

## Uninstalling a Host

- Run `cdx --uninstall` on the host; it removes Codex bits/config and calls `DELETE /auth`.

## Security Notes

- Treat `.env`, `storage/`, and MySQL volumes as secrets (contain API/encryption keys and auth payloads).
- By default `/admin/` enforces mTLS. If you set `ADMIN_REQUIRE_MTLS=0`, lock it down via another control (VPN, firewall).
- IP binding relies on `X-Forwarded-For`/`X-Real-IP`; ensure your proxy sets and sanitizes them.
- If you keep `AUTH_RUNNER_IP_BYPASS=1`, scope `AUTH_RUNNER_BYPASS_SUBNETS` to internal CIDRs only.
- Global rate limiting is off for admin routes but on for everything else; tune or disable with `RATE_LIMIT_GLOBAL_PER_MINUTE`/`RATE_LIMIT_GLOBAL_WINDOW` if your proxy already rate-limits.
