# Overview

## What it is

A tiny PHP + MySQL service that keeps one canonical Codex `auth.json` for your fleet. Hosts pull the official copy (or push a newer one) via `/auth`, and the per-host `cdx` wrapper is baked with its API key/base URL.

## Use case (start here)

- You run Codex across multiple hosts and want a single source of truth for `auth.json`.
- Hosts are created from the admin dashboard ("New Host"), then install via a one-time command that bakes in the issued API key.
- You want lightweight auditing (who registered, who synced, which versions) without babysitting machines.
- You are fine with a containerized PHP + MySQL service and a couple of helper scripts to wire it up.

## Why teams use it

- One `/auth` flow: register once, then a unified retrieve/store call that decides whether to accept the client's auth or return the canonical copy (with versions attached).
- Per-host API keys are minted from the admin dashboard (New Host) and IP-bound on first use; hosts can self-deregister via `DELETE /auth` when decommissioned.
- Captures host metadata (IP, client version, optional wrapper version) so you know which machines are on which build.
- MySQL-backed persistence and audit logs out of the box; storage lives in the compose volume by default.
- Canonical `auth.json` payloads and per-target tokens are stored encrypted-at-rest with libsodium `secretbox`; the symmetric key is auto-generated into `.env` on first boot.
- The dashboard "New Host" action generates a single-use installer token (`curl …/install/{token} | bash`) that bakes the API key into the downloaded `cdx`; `cdx --uninstall` handles clean removal.
- The `cdx` wrapper parses Codex “Token usage” lines and posts them to `/usage` for per-host usage tracking.
- Runs in `php:8.2-apache` with automatic migrations; host endpoints enforce API-key auth (`X-API-Key` or `Authorization: Bearer`), and installer downloads are guarded by single-use tokens created via the dashboard.
- Stores the canonical `auth.json` as a compact JSON blob (sha256 over that exact text); only the `auths` map is normalized, everything else is preserved verbatim.
- The “auth runner” sidecar (`auth-runner`, enabled by default in `docker-compose.yml`) validates canonical auth by dropping it into a fresh `~/.codex/auth.json` and running `codex exec …` in an isolated temp `$HOME` on every store and once per UTC day; if Codex refreshes tokens, the runner’s updated auth is auto-applied. Admin uploads bypass the runner (seed flow). Runner failures are logged and surfaced in the dashboard but no longer block `/auth`; operators can force a run via `POST /admin/runner/run`.

## How it works (big picture)

- This container exposes a small PHP API + MySQL database that act as the "auth.json registry" for all of your Codex hosts.
- The admin dashboard mints per-host API keys and one-time installer tokens; each token maps to `/install/{uuid}` which returns a self-contained bash script that installs/updates `cdx`, fetches Codex, and bakes the API key/base URL directly into the wrapper (no sync env file needed).
- Each host keeps only `~/.codex/auth.json`; connection details are embedded in its `cdx` wrapper.
- When `AUTH_RUNNER_URL` is configured (enabled by default in `docker-compose.yml`), the API calls a lightweight runner (`runner/app.py`) to probe the canonical `auth.json` by writing it to `~/.codex/auth.json` and running `codex`; if the runner reports a newer or changed `auth.json`, the API persists and serves that version automatically. Runner failures are recorded but do not block host sync; admin seed uploads skip the runner entirely.
- The `cdx` wrapper also syncs slash command prompts in `~/.codex/prompts` via `/slash-commands`, pulling new/updated prompts on launch and pushing local changes on exit.

## From manual logins to central sync

Think of a very common starting point:

- You have several servers (or laptops, CI runners, etc.).
- On each one, you log into Codex by hand and end up with a separate `~/.codex/auth.json`.
- When a token rotates, you have to remember which machines to fix.

With this project in place:

1. **Run the auth server once.** Bring up the Docker stack (see `docs/INSTALL.md`). No invitation key needed.
2. **Log into Codex on one trusted machine.** Use the normal Codex CLI sign-in so you get a local `~/.codex/auth.json`. This becomes your starting canonical auth.
3. **Mint an API key from the dashboard.** Open `/admin/` (mTLS) and click **New Host**. Copy the one-time installer command (`curl …/install/{token} | bash`) or the API key itself.
4. **Seed the canonical auth.** On the trusted machine, either run the installer command or use the dashboard "Upload auth.json" to push your existing `~/.codex/auth.json` to the server.
5. **Install on other hosts.** For each host, generate a fresh installer token in the dashboard and run the provided `curl …/install/{token} | bash` command on that host. It installs `cdx`, grabs Codex, and embeds the API key/base URL directly into the wrapper.
6. **Clean up when a host is retired.** Use the dashboard "Remove" button or run `cdx --uninstall` on the host to delete binaries/configs and call `DELETE /auth`.

## Commands you'll actually type

On the **auth server host**:

- `cp .env.example .env`
- Edit `.env` and set `DB_*` (or use the defaults from `docker-compose.yml`). The container auto-seeds the wrapper from `bin/cdx` only on first boot; to roll a new wrapper, rebuild the image or replace the baked script in storage before start-up.
- `docker compose up --build`

On your **laptop or admin box** (the one where you already use Codex):

- `codex login` (or whichever flow creates `~/.codex/auth.json`).
- Visit the admin dashboard (`/admin/`, mTLS) and click **New Host** to mint an API key + one-time installer command.
- Seed canonical auth from your trusted machine: use the dashboard "Upload auth.json" with your `~/.codex/auth.json`.
- Run the installer command on a target host (generate a fresh token per host).
- `cdx --uninstall` on a host to remove Codex bits and deregister it from the auth server (uses baked config).

## FAQ

- **Do I still need to log into Codex on every host?** No. Log in once on a trusted machine to create `~/.codex/auth.json`, then use the dashboard-generated installer commands for the rest of the fleet (and upload the canonical auth via the dashboard when it changes).
- **How do I rotate tokens or update `auth.json`?** Refresh `~/.codex/auth.json` on the trusted machine, then upload it through the dashboard (Upload auth.json) or let any host with a valid API key call `/auth` with `command: "store"` after the refresh.
- **What if my auth server uses a private CA or self-signed cert?** The CA path is baked into `cdx` when downloaded; ensure the dashboard upload is done from a host that trusts the CA or use your proxy to terminate TLS.
- **How do I remove a host cleanly?** Run `cdx --uninstall`; it deletes Codex bits on the target and calls `DELETE /auth` using the baked config.
- **Where is the host-side sync config stored?** Config is baked into the wrapper; env files are no longer written by the installer. Only legacy installs may still have `/usr/local/etc/codex-sync.env` or `~/.codex/sync.env`.
