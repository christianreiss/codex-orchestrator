# Usage Guide (Provisioning + Running Codex)

This doc is the “day 2” guide: how to provision hosts and how to actually run Codex via the baked `cdx` wrapper.

- **Installing the service stack** (Docker, mTLS, `.env`, runner sidecars): see `docs/INSTALL.md`.
- **API contracts** (source of truth): see `docs/interface-api.md` and `docs/interface-cdx.md`.

## Roles (who does what)

- **Operator / admin**: provisions hosts in the `/admin/` UI (or admin API), seeds canonical `auth.json`, manages secure/insecure windows, and handles quota / kill-switch policy.
- **Host user**: runs `cdx …` on a provisioned machine to sync auth/config/prompts and launch the Codex CLI.

## Preconditions

Before onboarding hosts:

1. The service is reachable from hosts at the public base URL (the same URL shown in installer commands).
2. You can access the admin dashboard (`/admin/`) or have an equivalent admin API workflow.
3. You have a **canonical** Codex `~/.codex/auth.json` seeded on the server.

## Provision a host (operator workflow)

### 0) Seed canonical `auth.json` (one-time, then repeat only to rotate)

On a trusted machine, sign in to Codex once so `~/.codex/auth.json` exists. Then upload it to the server:

- Admin dashboard: **Auth Upload** → upload your local `~/.codex/auth.json`.

Notes:

- This service keeps **one canonical auth** for the fleet. Hosts sync from it via `/auth`.
- If you rotate credentials later, upload a new canonical `auth.json` the same way.

### 1) Create a host + mint an installer token

Use the admin dashboard:

- **Hosts** → **New Host**
- Set the host **FQDN** and toggles (secure/insecure, roaming IPs, VIP, IPv4-only).
- Copy the installer command (it looks like `curl …/install/<token> | bash`).

Operational reality:

- Installer tokens are **single-use** and expire (see `INSTALL_TOKEN_TTL_SECONDS` in the config/env).
- Generating a new installer token for the same host rotates the API key and invalidates older tokens.

#### Optional: mint an installer token via the admin API (automation)

If you prefer provisioning via API (CI, inventory tooling), the admin endpoint is:

- `POST /admin/hosts/register` with JSON body: `{"fqdn":"host1.example.com","secure":true,"vip":false}`

When `ADMIN_ACCESS_MODE=mtls` (the default), you must present a valid client certificate for `/admin/*` routes.

Example with mTLS (paths are placeholders; adapt to your CA/certs):

```bash
BASE_URL="https://codex-auth.example.com"

curl --fail-with-body -sS \
  --cert ./client-admin.crt \
  --key ./client-admin.key \
  --cacert ./ca.crt \
  -H 'Content-Type: application/json' \
  -d '{"fqdn":"host1.example.com","secure":true,"vip":false}' \
  "$BASE_URL/admin/hosts/register"
```

The response includes `data.installer.url` and a copy/paste-friendly `data.installer.command` (the `curl …/install/<token> | bash` line).

### 2) Run the installer on the target host

On the target machine (Linux), run the command from the dashboard, for example:

```bash
curl -fsSL "https://codex-auth.example.com/install/00000000-0000-0000-0000-000000000000" | bash
```

What the installer does:

- Downloads the **host-baked** `cdx` wrapper from the service (`/wrapper/download`).
- Installs `cdx` to `/usr/local/bin/cdx` when writable, otherwise to `$HOME/.local/bin/cdx`.
- Downloads the matching Codex CLI release from GitHub and installs `codex` similarly.

If it installed into `~/.local/bin`, make sure that’s on `PATH`:

```bash
export PATH="$HOME/.local/bin:$PATH"
```

### 3) Verify the host can sync and run

On the host:

```bash
cdx --version
cdx shell
```

If the host is marked **insecure**, make sure its insecure window is currently open (see “Secure vs insecure hosts” below).

## Running Codex (host user workflow)

### Use `cdx` (recommended)

The wrapper is the supported entrypoint because it:

- Pulls/pushes canonical `auth.json` via `/auth`.
- Syncs `~/.codex/config.toml`, `~/.codex/AGENTS.md`, and slash command prompts.
- Enforces the server’s quota policy and kill switch.
- Self-updates the wrapper and Codex CLI as needed.
- Reports token usage back to `/usage`.

Common commands:

```bash
# Interactive Codex shell (forces the codex shell model)
cdx shell

# Code-focused mode (forces the codex-max model)
cdx code

# One-shot, script-friendly execution (prints only the final assistant reply)
cdx --execute "explain what this repo does in 5 bullets"
```

Passing flags through to Codex works the same way you’d pass them to `codex`; `cdx` forwards arguments after `shell` / `code`.

### Where files land

`cdx` manages a few host-local files:

- `~/.codex/auth.json` — pulled from the server; **insecure hosts purge this after each run**.
- `~/.codex/config.toml` — baked/synced from the server (`/config/retrieve`).
- `~/.codex/AGENTS.md` — synced from the server (`/agents/retrieve`).
- `~/.codex/prompts/` — slash commands synced from `/slash-commands`.

## Secure vs insecure hosts (and why it matters)

- **Secure host**:
  - `cdx` keeps `~/.codex/auth.json` on disk between runs.
  - Recommended for most real machines (servers, workstations with proper disk controls).
- **Insecure host**:
  - `cdx` deletes `~/.codex/auth.json` after each run.
  - `/auth` calls are only allowed while an **insecure window** is open.
  - New insecure hosts usually start with a short provisioning window; after that, operators must re-enable it (2–60 minute sliding window) before hosts can sync.

If you see failures about an insecure window being closed, that’s not something you fix on the host — an operator needs to open the window in the dashboard.

## Updating and rotating

### Update the wrapper / Codex CLI on a host

`cdx` auto-updates in normal operation, but you can force it:

```bash
cdx --update
```

### Rotate canonical auth (operator)

1. Refresh/sign in on a trusted machine so `~/.codex/auth.json` is updated.
2. Upload the new file via the admin dashboard (**Auth Upload**).
3. Hosts pick up the new digest on their next `cdx` run.

## Uninstall / decommission a host

On the host:

```bash
cdx --uninstall
```

This removes Codex artifacts and calls `DELETE /auth` to decommission (subject to the server’s IP-binding rules; operators can also delete the host from the dashboard).

## Troubleshooting

### Quick debug mode

```bash
CODEX_DEBUG=1 cdx --version
```

This is the fastest way to confirm the baked base URL and that you’re running the expected wrapper build.

### Common failure modes

- **HTTP 503 / “API disabled”**: the admin kill switch is on (`/admin/api/state`). Only an operator can clear it.
- **HTTP 401/403**: usually a bad API key (wrong wrapper) or an IP-binding mismatch. Operators can re-register the host (rotates API key) or enable roaming IPs.
- **HTTP 429**: you hit a rate limit bucket. Back off until the server-provided `reset_at`.
- **TLS/CA failures**: if you’re on an internal CA, ensure the host trusts it (or that the wrapper was baked with the correct CA path). `CODEX_SYNC_ALLOW_INSECURE=1` exists as an emergency lever but should not be the steady state.

### What to collect for an operator

From the host:

```bash
cdx --version
CODEX_DEBUG=1 cdx --version
```

From the service:

- Admin **Logs** page for recent `auth.*`, `install.*`, and `rate_limit.*` events.
- Host row in **Hosts** for pinned IP, roaming flag, insecure window state, and runner state.
