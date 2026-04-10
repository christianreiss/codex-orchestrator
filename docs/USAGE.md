# Usage Guide (Provisioning + Running Codex)

This doc is the “day 2” guide: how to provision hosts and how to actually run Codex via the baked `cdx` wrapper.

- **Installing the service stack** (Docker, mTLS, `.env`, runner sidecars): see `docs/INSTALL.md`.
- **API contracts** (source of truth): see `docs/API.md` and `docs/interface-cdx.md`.

## Roles (who does what)

- **Operator / admin**: provisions hosts in the `/admin/` UI (or admin API), seeds canonical `auth.json`, manages secure/insecure windows, and handles quota / kill-switch policy.
- **Host user**: runs `cdx …` on a provisioned machine to sync auth/config/AGENTS and launch the Codex CLI.

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
- Copy the installer command (it looks like `curl …/install/<token> | bash`). Depending on the selected host engines, that one command installs Codex, Claude, or both.

Operational reality:

- Installer tokens are **single-use**, expire based on `INSTALL_TOKEN_TTL_SECONDS` (default 1800 seconds), and capture the baked base URL (`Host`/`X-Forwarded-Proto` or `PUBLIC_BASE_URL`).
- Re-registering the same host rotates its API key; older wrappers/tokens keep the old key and then fail authenticated API calls.

#### Optional: mint an installer token via the admin API (automation)

If you prefer provisioning via API (CI, inventory tooling), the admin endpoint is:

- `POST /admin/hosts/register` with JSON body: `{"fqdn":"host1.example.com","secure":true,"vip":false,"engines":["codex","claude"]}`

Preferred: use admin login + session cookie for `/admin/*` calls. mTLS is an advanced hardening layer; only required when `ADMIN_ACCESS_MODE=mtls`.

Example with mTLS (paths are placeholders; adapt to your CA/certs) when `ADMIN_ACCESS_MODE=mtls`:

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

The response includes `data.installer.url`, `data.installer.command`, and installer mode metadata (`data.installer.mode`, `data.installer.label`) so callers can tell whether the command installs Codex, Claude, or both.
If `ADMIN_ACCESS_MODE=none`, log in via `/admin` and reuse the session cookie for API automation (see `LOGIN.md`).

### 2) Run the installer on the target host

On the target machine (Linux), run the command from the dashboard, for example:

```bash
curl -fsSL "https://codex-auth.example.com/install/00000000-0000-0000-0000-000000000000" | bash
```

For self-signed TLS (or any time you intentionally bypass verification), run:

```bash
curl -k -fsSL "https://codex-auth.example.com/install/00000000-0000-0000-0000-000000000000" | CODEX_INSTALL_CURL_INSECURE=1 bash
```

The `CODEX_INSTALL_CURL_INSECURE=1` part tells the installer to reuse `curl -k` for the wrapper + Codex downloads, matching the `-k` you used to fetch the script itself.

If your fleet is intentionally running with self-signed TLS and you need `cdx` itself to skip verification for `/auth` + sync endpoints, enable “Allow insecure curl (-k)” when issuing the host installer (or export `CODEX_SYNC_ALLOW_INSECURE=1` before running `cdx`). This is a last resort — trusting the correct CA is strongly preferred.

What the installer does:
- Downloads the engine-appropriate wrapper(s) from `/wrapper/download?engine=...`
- Installs Codex CLI for `cdx` hosts, Claude Code CLI for `clx` hosts, or both for dual-engine hosts

- Downloads the **host-baked** `cdx` wrapper from the service (`/wrapper/download`).
- Installs `cdx` to `/usr/local/bin/cdx` when writable, otherwise to `$HOME/.local/bin/cdx`.
- Downloads the matching Codex CLI release from GitHub and installs `codex` similarly.
- Prints installed versions plus a compact `Next steps` quickstart (`cdx --version`, `cdx`, `cdx --execute ...`) and leaves `cdx` ready to run.

If it installed into `~/.local/bin`, make sure that’s on `PATH`:

```bash
export PATH="$HOME/.local/bin:$PATH"
```

### 3) Verify the host can sync and run

On the host:

```bash
cdx --version
cdx
```

The installer does not run `cdx` automatically; run it here to sync/auth or to retry after opening an insecure window. The install script prints versions and exits with non-zero status on failure.

## Running Codex (host user workflow)

### Use `cdx` (recommended)

The wrapper is the supported entrypoint because it:

- Pulls/pushes canonical `auth.json` via `/auth`.
- Syncs `~/.codex/config.toml` and `~/.codex/AGENTS.md` via `/sync/status` + `/sync/bootstrap` (with fallback to per-surface endpoints). Skills are read through cdx/MCP `skill://{slug}` resources, and the wrapper removes legacy local skill mirrors on upgrade.
- Enforces the server’s quota policy and kill switch.
- Self-updates the wrapper and Codex CLI as needed (when the host can write install locations).
- Reports token usage back to `/usage` on a best-effort basis. The wrapper first checks only the last ~256 KiB of the PTY capture for a final legacy `Token usage:` line, then falls back to session JSONL / full-log parsing only when needed. Slow or wedged `/usage` calls are capped to roughly a 3-second total budget so wrapper exit does not feel hung.

Common commands:

```bash
# Interactive Codex (uses the fleet config defaults)
cdx

# Run with a named profile (shorthand for `--profile <name>`)
cdx ultra

# Show current lane steering state (effective + persisted)
cdx lane

# One-shot lane switch for this run (maps to profile/model automatically)
cdx lane spark

# Shortcut for spark lane
cdx ls

# Persist lane preference on this host for future runs
cdx lane normal --persist

# Clear persisted lane preference (host follows inherited/default lane)
cdx lane clear --persist

# One-shot, script-friendly execution (prints only the final assistant reply;
# direct codex exec fast path, not the full wrapper sync lifecycle)
cdx --execute "explain what this repo does in 5 bullets"

# Force IPv4 for wrapper network calls (sync/usage/update/download)
cdx -4

# Wrapper diagnostics
cdx status
cdx doctor
```

Passing flags through to Codex works the same way you’d pass them to `codex`; `cdx` forwards your args to the Codex CLI.
Known Codex subcommands (`exec`, `review`, `login`, `logout`, `mcp`, `mcp-server`, `app-server`, `completion`, `sandbox`, `debug`, `apply`, `resume`, `fork`, `cloud`, `features`, `help`) are reserved by the wrapper and always treated as commands. If a profile uses one of those names, run it explicitly with `cdx --profile <name> ...`.

### Where files land

`cdx` manages a few host-local files:

- `~/.codex/auth.json` — pulled from the server; insecure hosts purge this after each run (except concurrent-run guarded sessions).
- `~/.codex/config.toml` — synced from server startup sync (`/sync/status` + `/sync/bootstrap`; fallback `/config/retrieve`).
- `~/.codex/AGENTS.md` — synced from server startup sync (`/sync/status` + `/sync/bootstrap`; fallback `/agents/retrieve`).
- Legacy `~/.codex/prompts/` and `.prompt-baseline.json` state is removed automatically by current wrappers.
- No local Skill mirror is maintained. `cdx` reads Skills through MCP `skill://{slug}` and prunes stale `~/.agents/skills` / `~/.codex/skills` leftovers during upgrade.

## Secure vs insecure hosts (and why it matters)

- **Secure host**:
  - `cdx` keeps `~/.codex/auth.json` on disk between runs.
  - Recommended for most real machines (servers, workstations with proper disk controls).
- **Insecure host**:
  - `cdx` deletes `~/.codex/auth.json` after each run.
  - Insecure-window policy is enforced on sync APIs; `store` also has server-side grace/post-run allowances.
- New insecure hosts open with a 30-minute provisioning window. After that, access follows the stored sliding window (`insecure_window_minutes`, default 10, clamped 0–480).

If you see failures about an insecure window being closed, that’s not something you fix on the host — an operator needs to open the window in the dashboard.

## Updating and rotating

### Update the wrapper / Codex CLI on a host

`cdx` auto-updates in normal operation (using `/wrapper/download` and the server-reported wrapper metadata) when it can manage install locations, but you can force an update check/run:

```bash
cdx --update
```

That forced path checks both the wrapper and Codex. If the wrapper has to replace itself first, it restarts once and then finishes the Codex update check before exiting.

If SSH launches misbehave, run `cdx doctor`. The wrapper reports SSH terminal/session hints, PTY state, API reachability, and local Codex version so you can see whether the host is launching through the normal PTY/direct paths or failing earlier.

### Rotate canonical auth (operator)

1. Refresh/sign in on a trusted machine so `~/.codex/auth.json` is updated.
2. Upload the new file via the admin dashboard (**Auth Upload**).
3. Hosts pick up the new digest on their next `cdx` run.

## Uninstall / decommission a host

On the host:

```bash
cdx --uninstall
```

This removes Codex artifacts and calls `DELETE /auth?force=1` to decommission (host-side uninstall bypasses IP-binding checks on that call; operators can also delete the host from the dashboard).

## Troubleshooting

### Quick debug mode

```bash
CODEX_DEBUG=1 cdx --version
```

This is the fastest way to confirm the baked base URL, wrapper version, and that you’re running the expected wrapper build.

### Common failure modes

- **HTTP 503 / “API disabled”**: the admin kill switch is on (`/admin/api/state`). Only an operator can clear it.
- **HTTP 401/403**: usually a bad API key (wrong wrapper) or an IP-binding mismatch. Operators can re-register the host (rotates API key) or enable roaming IPs.
- **HTTP 429**: you hit a rate limit bucket (global or auth-fail). Back off until the server-provided `reset_at`.
- **TLS/CA failures**: if you’re on an internal CA, ensure the host trusts it (or that the wrapper was baked with the correct CA path). `CODEX_SYNC_ALLOW_INSECURE=1` exists as an emergency lever but should not be the steady state; when set, sync/usage/wrapper-update HTTPS calls bypass TLS verification.

### What to collect for an operator

From the host:

```bash
cdx --version
CODEX_DEBUG=1 cdx --version
```

From the service:

- Admin **Logs** page for recent `auth.*`, `install.*`, and `rate_limit.*` events.
- Host row in **Hosts** for pinned IP, roaming flag, insecure window state, and runner state.
