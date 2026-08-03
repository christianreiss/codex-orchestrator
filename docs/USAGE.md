# Usage Guide (Provisioning + Running Codex)

This doc is the “day 2” guide: how to provision hosts and how to actually run Codex via the baked `cdx` wrapper.

- **Installing the service stack** (Docker, TLS, `.env`, runner sidecars): see `docs/INSTALL.md`.
- **Day 0** — a brand-new installation is walked by `bin/install.sh` and then by the first-run wizard at `/admin/setup`, which covers everything in the "Provision a host" section below in guided form. Use this guide when the wizard is already done, when you skipped a step, or when you are automating.
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

- First-run wizard: the **Credentials** step at `/admin/setup?step=auth`.
- Afterwards: **Hosts → More → Seed canonical auth**. Both open the same panel — paste the credential, pick the file, or mint a one-time `curl | bash` seed command for a machine you cannot paste from.

Notes:

- This service keeps **one canonical auth** for the fleet. Hosts sync from it via `/auth`.
- If you rotate credentials later, upload a new canonical `auth.json` the same way.
- Every candidate is verified against the live provider before it is stored. `pending` and `failed` outcomes are reported as such, and the setup checklist counts only **verified** credentials — a stored-but-unverified value leaves the step open.

### 1) Create a host + mint an installer token

Use the admin dashboard:

- **Hosts** → **New Host**
- Set the host **FQDN** and toggles (secure/insecure, roaming IPs, VIP, IPv4-only).
- The installer command is copied to the clipboard automatically when minted (it looks like `curl …/install/<token> | bash`). Depending on the selected host engines, that one command installs Codex, Claude, or both.

Operational reality:

- Installer tokens are **single-use**, expire after a TTL fixed at 1800 seconds in the API (there is no env knob for it), and capture the baked base URL (`Host`/`X-Forwarded-Proto` or `PUBLIC_BASE_URL`).
- Re-registering the same host rotates its API key; older wrappers/tokens keep the old key and then fail authenticated API calls.
- Existing hosts can mint a fresh installer from the host detail page with **Mint installer**. That keeps the current API key, replaces any pending installer token for that host, and copies the new command automatically.

#### Optional: mint an installer token via the admin API (automation)

If you prefer provisioning via API (CI, inventory tooling), the admin endpoint is:

- `POST /admin/hosts/register` with JSON body: `{"fqdn":"host1.example.com","secure":true,"vip":false,"engines":["codex","claude"]}`

Use admin login + session cookie: that is the only admin check the API itself makes, whatever `ADMIN_ACCESS_MODE` says (it is read only by the `/cli/auth/verify` CLI-approval page).

The admin session is the whole check — this server does not issue or verify client certificates, and the bundled `caddy` profile does not request them. If you front it with a proxy that enforces mTLS, add whatever client credentials that proxy wants to the calls below; the API still requires the session cookie either way:

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
Without that proxy in front, drop the `--cert`/`--key`/`--cacert` flags: log in via `/admin` and reuse the session cookie for API automation (see `LOGIN.md`).

For an already registered host, prefer the non-rotating mint endpoint:

```bash
BASE_URL="https://codex-auth.example.com"
HOST_ID="42"

curl --fail-with-body -sS \
  --cert ./client-admin.crt \
  --key ./client-admin.key \
  --cacert ./ca.crt \
  -X POST \
  "$BASE_URL/admin/hosts/$HOST_ID/installer"
```

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

If your fleet is intentionally running with self-signed TLS and you need `cdx` itself to skip verification for `/auth` + sync endpoints, enable “Allow insecure curl (-k)” before issuing or re-minting the host installer. The generated installer command then includes the `curl -k` / `CODEX_INSTALL_CURL_INSECURE=1` form automatically, and the host's signed wrapper config carries `allow_insecure: true` so future sync skips verification too. This is a last resort — trusting the correct CA is strongly preferred.

What the installer does:
- Downloads each enabled signed host config from `/wrapper/v2/config` first and
  stops if their common wrapper version/SHA metadata differs.
- Downloads one platform `cxx`, verifies SHA-256, then installs relative
  `cdx -> cxx` and/or `clx -> cxx` aliases. Existing regular wrapper files at
  those alias paths are replaced atomically during migration.
- Installs system-wide into `/usr/local/bin` by default, using root or
  passwordless `sudo`. Set `BIN_DIR` explicitly for a per-user/custom prefix.
- For Claude-capable hosts, ensures Node.js and npm first. The installer asks
  the OS package manager for the small Node runtime, prefers a managed pinned
  Corepack npm 10.9.2 shim, and uses the OS npm package only as a fallback.
- Invokes `cxx cron install` and `cxx cron run --minimal` once each. The one
  shared schedule runs every enabled engine tick exactly once, bootstrapping
  Codex and/or Claude Code at the server-selected versions. For a privileged
  system schedule, migration discovers every actual owner in the standard
  cron spools. Strictly validated spool filenames remain eligible when static
  Go `os/user` cannot resolve an NSS/SSSD-only owner; the added
  config-owner/sudo/current/root safeguards still require lookup validation.
  Migration removes only lines ending in an exact managed marker and restores
  every changed crontab plus the new system entry if cleanup cannot complete.
- Prints compact progress and installed versions. A final `READY` with exit 0
  is the success signal; `INCOMPLETE` is non-zero and includes direct retry
  commands. The installer does not open an interactive engine session.

If the installer reports a conflicting wrapper path, put the selected
`BIN_DIR` first on `PATH` or open a new shell. For an explicit per-user prefix,
for example:

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
- Syncs effective `CODEX_HOME/config.toml` and `CODEX_HOME/AGENTS.md` via `/sync/status` + `/sync/bootstrap` (with fallback to per-surface endpoints). Skills are read through cdx/MCP `skill://{slug}` resources, and the wrapper removes legacy local skill mirrors on upgrade.
- Enforces the server’s quota policy and kill switch.
- Self-updates the wrapper and Codex CLI as needed (when the host can write install locations).

Common commands:

```bash
# Interactive Codex (uses the fleet config defaults)
cdx

# Run with a named profile (shorthand for `--profile <name>`)
cdx ultra

# Show the effective lane
cdx lane

# Select and persist the Spark lane for this host
cdx lane spark

# Shortcut for spark lane
cdx ls

# Select and persist the normal lane (`--persist` is accepted but redundant)
cdx lane normal --persist

# Clear persisted lane preference (host follows inherited/default lane)
cdx lane clear --persist

# Upload a freshly renewed local auth.json after running codex login
cdx auth-upload

# Claude uses the same guarded lifecycle around its native credentials
clx auth-upload

# One-shot, script-friendly execution (managed auth/resource sync still runs;
# Codex itself runs headless with a read-only sandbox)
cdx --execute "explain what this repo does in 5 bullets"

# Force IPv4 for wrapper network calls (sync/update/download)
cdx -4

# Wrapper diagnostics
cdx status
cdx doctor

# Wrapper-owned command reference (`--help` remains upstream Codex help)
cdx --wrapper-help

# Stable ANSI-free status for logs and narrow terminals
cdx status --minimal
```

Passing flags through to Codex works the same way you’d pass them to `codex`; `cdx` forwards your args to the Codex CLI.
Known Codex subcommands (`exec`, `review`, `login`, `logout`, `mcp`, `mcp-server`, `app-server`, `completion`, `sandbox`, `debug`, `apply`, `resume`, `fork`, `cloud`, `features`, `help`) are reserved by the wrapper and always treated as commands. If a profile uses one of those names, run it explicitly with `cdx --profile <name> ...`.

`resume` is additionally wrapper-owned: `cdx resume` runs through the full startup lifecycle (auth sync, boot screen, lane model) rather than bypassing it, and `cdx --resume <session>` is an alias for it — upstream `codex` has no `--resume` flag of its own.

### Where files land

`cdx` manages a few host-local files:

- `${CODEX_HOME:-~/.codex}/auth.json` — pulled from the server. A native login
  without `last_refresh` is stabilized once; concurrent requests cannot
  overwrite a newer usable login with a late response unless the API
  definitively rejected that exact candidate and explicitly serves an older
  verified canonical as recovery. Concurrent verified canonical responses
  converge by `last_refresh` instant, with a bounded
  `.cdx-canonical-auth-generations.json` digest ledger distinguishing canonical
  writes from native/local writes. Distinct canonical digests at the same
  instant preserve the first response but fail the invocation as an ambiguous
  ordering conflict.
- `${CODEX_HOME:-~/.codex}/config.toml` — synced from server startup sync (`/sync/status` + `/sync/bootstrap`; fallback `/config/retrieve`).
- `${CODEX_HOME:-~/.codex}/AGENTS.md` — synced from server startup sync (`/sync/status` + `/sync/bootstrap`; fallback `/agents/retrieve`).
- Legacy `${CODEX_HOME:-~/.codex}/prompts/` and `.prompt-baseline.json` state is removed automatically by current wrappers.
- No local Skill mirror is maintained. `cdx` reads Skills through MCP `skill://{slug}` and prunes stale `~/.agents/skills` plus `${CODEX_HOME:-~/.codex}/skills` leftovers during upgrade.

For Claude, `~/.claude/.credentials.json` is the only authoritative local auth
file. `~/.clx/auth/credentials.json`, when already present, is a compatibility
write mirror and is never used to recover a missing native file. clx keeps the
stable generation timestamp in `~/.clx/auth/generation.json`.

`cdx login` / `clx auth login` upload their successful native generation.
`cdx login status` is read-only and cannot acknowledge an old logout marker.
Explicit logout writes durable local intent before native removal, so the next
wrapper start does not silently restore fleet credentials. If another wrapper
session already selected auth, native removal is deferred until the final peer
exits. A changed usable login remains on disk but supersedes intent only after
the server accepts its exact auth+marker snapshot.
All returned server auth is compare-and-swapped against the generation used by
the request. Logout intent clears only after the server accepts the exact auth
generation and exact marker bytes observed before that store; a logout created
while a bounded store/bundle candidate request is in flight blocks at the local
transaction boundary and orders after it. This applies to normal, status,
auth-upload, and concurrent runs.

Every wrapper-launched Codex/Claude child holds a separate shared active-child
lease across `Start`/`Wait`. Native children also inherit duplicate session and
active-child descriptors (including help), so wrapper SIGKILL does not open an
uninstall/logout/write race while the child survives. Canonical writes wait or
skip at the commit boundary; a skip is safe only for a genuinely changed usable
generation, not an unchanged file blocked by an active child.
This protection cannot cover a separately invoked raw `codex` or `claude`
process, so use `cdx`/`clx` consistently on fleet-managed auth homes.

## Secure vs insecure hosts (and why it matters)

- **Secure host**:
  - `cdx`/`clx` keep their native auth files on disk between runs.
  - Recommended for most real machines (servers, workstations with proper disk controls).
- **Insecure host**:
  - Every auth-aware cdx/clx process takes a shared session lease keyed to its
    effective auth home. Live API `host.secure` metadata updates only that
    process's durable purge request; requests from concurrent insecure sessions
    remain sticky. `insecure` / `insecure-denied` status without a host block is
    also authoritative. Only the last exiting process purges native credentials,
    regardless of session exit order; an active engine child defers cleanup and
    logout intent is retained. New sessions fail fast while exclusive uninstall
    or logout maintenance is active.
  - Insecure-window policy is enforced on retrieve/sync APIs. `store` candidates
    remain allowed even after both the window and grace close, do not extend the
    window, and still pass all authentication, token, and runner gates.
- New insecure hosts open with a 30-minute provisioning window. After that, access follows the stored sliding window (`insecure_window_minutes`, default 10, clamped 0–480).

If you see failures about an insecure window being closed, that’s not something you fix on the host — an operator needs to open the window in the dashboard.

## Updating and rotating

### Update the wrapper / Codex CLI on a host

`cdx` auto-updates the shared wrapper in normal operation when it can manage
the install location. The registered versioned route is
`/wrapper/v2/bin/{artifact}/{platform}/v{version}/{binary}`; new releases use
`artifact=cxx` and `binary=cxx`. The compatible per-engine URL and
`/wrapper/v2/download` resolve to the same bytes for a new common release.
`/wrapper/download` is not part of that path: it serves the legacy transition
launcher used by date-versioned shell wrappers. You can force an update
check/run:

```bash
cdx --update
```

That forced path checks both the wrapper and Codex. If the wrapper has to replace itself first, it restarts once and then finishes the Codex update check before exiting.

If SSH launches misbehave, run `cdx doctor`. The wrapper reports SSH terminal/session hints, API reachability, local Codex version, and whether the host is using the direct TTY path or the older inline fallback.

### Rotate canonical auth (operator)

1. Refresh/sign in on a trusted machine so `~/.codex/auth.json` is updated.
2. Upload the new file from **Hosts → More → Seed canonical auth**.
3. Hosts pick up the new digest on their next `cdx` run.

## Uninstall / decommission a host

On the host:

```bash
cdx --uninstall
```

This removes Codex-local artifacts and calls
`DELETE /auth?force=1&engine=codex`. On a dual-engine host, `clx` uses
`engine=claude`; an authoritative partial response removes only the selected
alias and engine state, leaving the other alias, `cxx`, and the shared cron in
place. An authoritative last-engine response decommissions the host and removes
the shared layout. Offline, non-2xx, or malformed delete responses preserve all
shared artifacts. `force=1` bypasses IP binding for the uninstall call.
Uninstall first takes an exclusive maintenance lease for that effective auth
home and refuses while another wrapper process is using it, so it cannot remove
files or registration beneath an active run. Operators can also delete the
whole host from the dashboard.

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
- **TLS/CA failures**: if you’re on an internal CA, ensure the host trusts it (or that the wrapper was baked with the correct CA path). The per-host “Allow insecure curl (-k)” toggle exists as an emergency lever but should not be the steady state; when it is on, the signed wrapper config carries `allow_insecure: true` and sync/wrapper-update HTTPS calls bypass TLS verification.

### What to collect for an operator

From the host:

```bash
cdx --version
CODEX_DEBUG=1 cdx --version
```

From the service:

- Admin **Logs** page for recent `auth.*`, `install.*`, and `rate_limit.*` events.
- Host row in **Hosts** for pinned IP, roaming flag, insecure window state, and runner state.
