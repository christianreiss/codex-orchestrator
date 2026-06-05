---
title: clx — the Claude Code wrapper
section: Fleet operations
verified: 2026-06-05
sources: wrappers/clx, api/src/routes/wrapper-v2/index.ts, api/src/routes/install/index.ts, api/src/routes/sync/index.ts, api/src/routes/cli-auth/index.ts, wrappers/schemas/host-config-v1.json
---

`clx` is the **Claude Code fleet wrapper** — a static Go binary
(`wrappers/clx/`) that wraps the upstream `claude` / `claude-code` Node CLI for
hosts managed by Codex Orchestrator. The equivalent wrapper for the
Codex/OpenAI engine is `cdx`; the engine token for clx is `"claude"`.

## Installation and distribution

The orchestrator serves `clx` through the same wrapper-v2 endpoint used by
`cdx`:

```
GET /wrapper/v2/bin/clx/<os>-<arch>/v<version>/clx
```

Supported platforms (sent as the `X-Wrapper-Platform` header): `linux-amd64`,
`linux-arm64`, `darwin-amd64`, `darwin-arm64`.

An install script at `/install` fetches the binary and places it on the host.
On first boot `clx` downloads its per-host config from
`GET /wrapper/v2/config` and stores it at the path returned by
`config.DefaultPath()` (typically `~/.config/codex-orchestrator/clx.json`).

### Per-host config schema

The config is typed, Ed25519-signed JSON with the following top-level fields:

| Field | Description |
|---|---|
| `schema_version` | Config schema version |
| `engine` | Always `"claude"` for clx |
| `orchestrator.base_url` | Orchestrator API root |
| `orchestrator.api_key` | Host API key |
| `host.id` | Host UUID |
| `host.fqdn` | Host fully qualified domain name |
| `host.secure` | Whether the host is approved (secure mode) |
| `engine_options.silent` | Suppress wrapper output |
| `engine_options.claude_model_override` | Force a specific Claude model |
| `engine_options.admin_theme_hint` | UI theme hint for boot screen |
| `wrapper.version` | Current wrapper version |
| `wrapper.track` | Update track (`stable`, etc.) |
| `wrapper.auto_update` | Enable automatic self-update |
| `wrapper.binary_url` | Download URL for self-update |
| `wrapper.binary_sha256` | SHA256 of the wrapper binary |

## CLI subcommands and flags

### Subcommands

| Subcommand | Description |
|---|---|
| `run` (default) | Full startup sequence, then launch a Claude session |
| `status` | Local config summary + `/sync/status` ping; works even when config is unloadable (prints version + error) |
| `doctor` | Self-diagnostic: config, CLI presence, credentials, reachability |
| `auth-upload` | POST `~/.claude/.credentials.json` to the orchestrator |
| `exec -- <cmd...>` | Bypass startup sync; run a single Claude command directly |

Reserved upstream subcommands (`login`, `logout`, `mcp`, `config`, `doctor`,
`sessions`, `resume`, `help`) pass through to the real `claude` binary with the
API key preserved.

### Flags

| Flag | Description |
|---|---|
| `--continue` / `-c` | Forwarded to the upstream `claude` binary |
| `--resume <session>` | Forwarded to the upstream `claude` binary |
| `--help` / `-h` / `help` | Full passthrough to upstream `claude`; skips all wrapper side effects (no lock, no sync, no boot screen) |
| `--cron [install\|remove\|run]` | Manage host auto-update crontab entry |
| `--version` / `-V` | Print version, commit, build date, OS/arch, pubkey status |
| `--update` / `-U` | Self-update (SHA256-verified) |
| `--uninstall` | Remove credentials, local state, and cron entry |
| `--execute <prompt>` | Run a one-shot headless prompt (skips boot screen) |
| `--silent` | Suppress wrapper output |
| `--debug` / `--verbose` | Verbose logging |
| `--minimal` / `--minimal-output` | Minimal boot screen |
| `--skip-boot` / `--no-banner` | Skip boot screen entirely |
| `-4` / `--ipv4` | Force IPv4 |

## Startup sequence

Implemented in `wrappers/clx/internal/lifecycle/` as `lifecycle.Run`:

1. **Acquire IPC flock** (`"clx"`). If already held by a concurrent invocation,
   enter read-only mode — auth syncs and cron updates are skipped for that
   session.

2. **POST `/sync/bootstrap`** with a `BundleRequest` carrying: `engine=claude`,
   `include_auth=true`, auth digest, auth candidate, agents digest, config
   digest, `home`, `username`, and artifact digests for subagents, commands,
   output-styles, and skills. Falls back to legacy separate `/auth`, `/agents`,
   and `/settings` calls if the server returns 404, 501, or 405.

3. **Apply bundle response**:
   - Write `~/.claude/.credentials.json` when status is `outdated`, `updated`,
     or `missing`.
   - Write `~/.claude/CLAUDE.md` (agents/fleet instructions).
   - Deep-merge `~/.claude/settings.json` (fleet partial, preserving user keys;
     see [Settings merge](#settings-deep-merge) below).
   - Split `mcpServers.*` out of `settings.json` and into `~/.claude.json`
     (user-scope MCP; tracked in `~/.clx/state/managed-mcp.json`).
   - Write `~/.claude/agents/<slug>.md`, `commands/<slug>.md`,
     `output-styles/<slug>.md` from `claude_artifacts`.
   - Write `~/.claude/skills/<slug>/SKILL.md` from `claude_skills`.
   - All writes are manifest-tracked; only manifest-recorded files are pruned
     on removal.

4. **Auth decision** (`orchestrator.Decide`). Possible statuses:

   | Status | Meaning |
   |---|---|
   | `current` / `ok` | Credentials are valid and up to date |
   | `outdated` | Server has a newer credential; refreshed in step 3 |
   | `missing` | No credentials on host; written from server payload |
   | `upload_required` | Host has credentials the server doesn't; `auth-upload` needed |
   | `disabled` | Host is disabled; fleet settings + skills stripped |
   | `invalid` | Credential invalid; fleet settings + skills stripped |
   | `offline` | Orchestrator unreachable |
   | `insecure-pending` (HTTP 423) | Awaiting admin approval; polls `PollApproval` every 5 s |
   | `insecure-denied` (HTTP 403) | Admin denied; fleet settings + skills stripped |

5. **Install target Claude CLI version** if allowed and `auto_update` is
   enabled (`claude.EnsureClaude`).

6. **Print boot screen** (or minimal screen with `--minimal`) to stderr, then
   `exec claude`.

7. **Post-run**: if `~/.claude/.credentials.json` hash changed, upload to
   orchestrator (`AuthStore`). Report token usage via `/usage` batch POST
   (extracted from stdout capture or `~/.claude/projects` JSONL session files).
   Print exit footer.

## Authentication model

`clx` does **not** set `ANTHROPIC_API_KEY` or `ANTHROPIC_BASE_URL`. The fleet
keeps `~/.claude/.credentials.json` populated with the native
`claudeAiOauth` object (refresh token + expiry intact). The orchestrator stores
and serves this object verbatim.

The `preexec` hook only exports a genuine `sk-ant-api…` key, never an OAuth
token (`sk-ant-oat…`), because an injected OAuth token would trigger Claude
Code's "detected custom API key" prompt and override the OAuth login.

The `/anthropic/v1` proxy (for issued `sk-claude-*` keys) is a separate gateway
and is not part of the host launch path.

## New host registration (device-code flow)

When a host has no config yet, `clx` drives a device-code exchange:

1. POST `/cli/auth/start` with `{fqdn, secure}` → receives a **device code**
   (format: `ABCD-1234`, four uppercase letters, dash, four digits) and a
   `verify_url`.
2. Poll POST `/cli/auth/poll/:id` until approved or denied.

On the admin side an operator navigates to **Authorize CLI** (`/cli/auth/verify`,
requires an admin session unless `ADMIN_ACCESS_MODE=open`):

- **Step 1** — Enter the device code shown on the host terminal.
- **Step 2** — Confirm: review session details (FQDN shown), then click
  **Approve** or **Deny**.
  - Approve → POST `/cli/auth/approve` with `user_code`.
  - Deny → POST `/cli/auth/deny`.
- **Step 3** — Approved/denied result page.

On approval the poll response includes `base_url` so the wrapper can download
its signed config and proceed.

## Auto-update (cron)

`clx --cron install` writes a crontab entry (user crontab or
`/etc/cron.d/clx-managed`, marker `# clx-managed-cron`) and pings
`/cron/check`.

`clx --cron run` (Tick):

1. Checks the orchestrator for a new wrapper version.
2. Verifies SHA256, downloads, self-replaces via atomic rename + re-exec
   (`CLAUDE_WRAPPER_RESTART_DEPTH` env var, capped at 2).
3. Ensures the `claude` CLI version matches the server-declared target
   (`claude.EnsureClaude`).
4. Reports the installed `claude` version to `/cron/check`.
5. If the server sets `runner_state=disable`, removes the cron entry.

`clx --cron remove` removes the crontab entry.

## Settings deep-merge

The bootstrap bundle returns `claude_settings: {sha256, partial, owned_paths}`.

- The `partial` is merged over `~/.claude/settings.json`, preserving user-owned
  keys.
- Fleet-owned paths are persisted in `~/.clx/state/managed-keys.json`; paths
  that disappear from `owned_paths` are removed on the next run.
- `permissions.{allow,ask,deny}` are **union-merged**: previously injected fleet
  rules are stripped first to avoid duplicates.
- `mcpServers.*` owned paths are split out and merged into `~/.claude.json`
  (user-scope MCP); managed MCP names are tracked in
  `~/.clx/state/managed-mcp.json`.
- `advisorModel` is only written for tier aliases (`opus`, `sonnet`, `haiku`).

## Source references

- `wrappers/clx` — Go module (wrapper binary)
- `api/src/routes/wrapper-v2/index.ts` — binary + config + manifest endpoints
- `api/src/routes/install/index.ts` — installer and seed-auth tokens
- `api/src/routes/sync/index.ts` — `/sync/bootstrap`, `/sync/status`
- `api/src/routes/cli-auth/index.ts` — device-code registration flow
- `wrappers/schemas/host-config-v1.json` — config schema
