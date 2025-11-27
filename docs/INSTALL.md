# Installation Guide

This doc walks through setting up the Codex Auth stack with Docker, mTLS, and a baked-in `cdx` wrapper.

## Prerequisites

- Docker + docker compose.
- TLS/mTLS termination:
  - Preferred: your own reverse proxy/ingress that terminates TLS **and** forwards mTLS headers (`X-mTLS-Present`, `X-MTLS-FINGERPRINT`, `X-MTLS-SUBJECT`, `X-MTLS-ISSUER`) plus accurate `X-Forwarded-For`/`X-Real-IP`.
  - Alternate: enable the bundled Caddy profile in `docker-compose.yml` (disabled by default) to serve 443 with ACME **or** supplied certs and enforce admin mTLS there.
- MySQL 8 (the compose file runs a MySQL sidecar).
- Host paths for persistent data (default in `docker-compose.yml`):
  - `/var/docker_data/codex-auth.example.com/mysql_data`
  - `/var/docker_data/codex-auth.example.com/store` (wrapper, storage/sql exports)
  - When using the bundled Caddy frontend: `/var/docker_data/codex-auth.example.com/caddy/tls` for custom cert/key, `/var/docker_data/codex-auth.example.com/caddy/mtls` for the admin CA, plus named volumes `caddy_data` and `caddy_config` (ACME + Caddy state).

## Environment

1. Copy `.env.example` to `.env`.
2. Configure secrets/paths:
   - `DB_HOST/DB_PORT/DB_DATABASE/DB_USERNAME/DB_PASSWORD/DB_ROOT_PASSWORD`
   - `AUTH_ENCRYPTION_KEY` (leave empty to auto-generate on first boot).
   - `DATA_ROOT` if you want a different bind-mount root.
   - Optional: `DASHBOARD_ADMIN_KEY` (second factor for admin APIs).
   - Optional: `CHATGPT_USAGE_CRON_INTERVAL` (seconds between background ChatGPT quota refreshes; default 3600).
3. Ensure `.env` is kept out of git and treated as a secret.

## Build and Run

```bash
docker compose up --build
```

- API defaults to `http://localhost:8488`.
- Admin dashboard: `/admin/` (requires mTLS + optional `DASHBOARD_ADMIN_KEY`).
- Runner sidecar is enabled by default (`AUTH_RUNNER_URL=http://auth-runner:8080/verify`); clear that env to disable.
- A `quota-cron` sidecar refreshes ChatGPT quota snapshots on a timer (default hourly) by running `scripts/refresh-chatgpt-usage.php`; tune with `CHATGPT_USAGE_CRON_INTERVAL` (seconds).

## Optional: bundled Caddy frontend (no existing proxy)

1. Populate the `CADDY_*` env vars in `.env` (domain, ACME email, TLS fragment, cert/key paths). Defaults point at `/var/docker_data/codex-auth.example.com/caddy/*`.
2. Place your admin mTLS CA at `${CADDY_MTLS_DIR}/ca.crt` (or adjust `CADDY_MTLS_CA_FILE`). Caddy requests client certs for all requests and blocks `/admin*` unless a validated certificate is present; it forwards `X-MTLS-*` headers for the app.
3. Pick a cert source:
   - **Let's Encrypt/ZeroSSL**: keep `CADDY_TLS_FRAGMENT=/etc/caddy/tls-acme.caddy`, set `CADDY_DOMAIN` + `CADDY_ACME_EMAIL`, and ensure ports 80/443 reach this host.
   - **Custom cert**: set `CADDY_TLS_FRAGMENT=/etc/caddy/tls-custom.caddy` and drop `tls.crt` / `tls.key` (or update `CADDY_TLS_CERT_FILE`/`CADDY_TLS_KEY_FILE`) into `${CADDY_TLS_DIR}`.
4. Start the stack with Caddy: `docker compose --profile caddy up --build -d`. External clients should use `https://<CADDY_DOMAIN>`; the API is still reachable on `8488` inside the compose network.

## First-Time Flow

1. Log into Codex on a trusted machine to create `~/.codex/auth.json`.
2. Open the admin dashboard (with mTLS) and click **New Host** to mint an API key + one-time installer.
3. Upload your `~/.codex/auth.json` via the dashboard (“Seed auth.json”).
4. Run the installer command on each target host (fresh token per host). The wrapper is baked with base URL + API key; no `sync.env` is written.

## Uninstalling a Host

- Run `cdx --uninstall` on the host; it removes Codex bits/config and calls `DELETE /auth`.

## Security Notes

- Treat `.env`, `storage/`, and MySQL volumes as secrets (contain API/encryption keys and auth payloads).
- Do not expose `/admin/` without mTLS; prefer setting `DASHBOARD_ADMIN_KEY` too.
- IP binding relies on `X-Forwarded-For`/`X-Real-IP`; ensure your proxy sets and sanitizes them.
