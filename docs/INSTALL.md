# Installation Guide

This doc walks through setting up the Codex Auth stack with Docker, mTLS, and a baked-in `cdx` wrapper.

## Prerequisites

- Docker + docker compose.
- Reverse proxy/ingress that terminates TLS **and** forwards mTLS headers to the app:
  - Set `X-mTLS-Present: 1` (and optionally `X-MTLS-FINGERPRINT`, `X-MTLS-SUBJECT`, `X-MTLS-ISSUER`) for authenticated admin clients.
  - Forward `X-Forwarded-For` and `X-Real-IP` accurately; strip untrusted versions.
- MySQL 8 (the compose file runs a MySQL sidecar).
- Host paths for persistent data (default in `docker-compose.yml`):
  - `/var/docker_data/codex-auth.example.com/mysql_data`
  - `/var/docker_data/codex-auth.example.com/store` (wrapper, storage/sql exports)

## Environment

1. Copy `.env.example` to `.env`.
2. Configure secrets/paths:
   - `DB_HOST/DB_PORT/DB_DATABASE/DB_USERNAME/DB_PASSWORD/DB_ROOT_PASSWORD`
   - `AUTH_ENCRYPTION_KEY` (leave empty to auto-generate on first boot).
   - `DATA_ROOT` if you want a different bind-mount root.
   - Optional: `DASHBOARD_ADMIN_KEY` (second factor for admin APIs).
3. Ensure `.env` is kept out of git and treated as a secret.

## Build and Run

```bash
docker compose up --build
```

- API defaults to `http://localhost:8488`.
- Admin dashboard: `/admin/` (requires mTLS + optional `DASHBOARD_ADMIN_KEY`).
- Runner sidecar is enabled by default (`AUTH_RUNNER_URL=http://auth-runner:8080/verify`); clear that env to disable.

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
