---
title: clx — the Claude Code wrapper
section: Fleet operations
verified: 2026-07-01
sources: wrappers/clx, api/src/routes/wrapper-v2/index.ts, api/src/routes/install/index.ts, api/src/routes/auth/index.ts, api/src/routes/host/index.ts, api/src/routes/cli-auth/index.ts, api/src/services/claude-artifacts.ts, api/src/services/client-config.ts, wrappers/schemas/host-config-v1.json
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
| `host.id` | Host numeric ID (integer, not a UUID) |
| `host.fqdn` | Host fully qualified domain name |
| `host.secure` | Whether the host is approved (secure mode) |
| `host.engines` / `host.engines_list` | Comma string / array of enabled engine tokens (`codex`, `claude`) used for peer-wrapper reconciliation — see [wrappers](/admin/manual/wrappers) |
| `engine_options.silent` | Suppress wrapper output |
| `engine_options.claude_model_override` | Force a specific Claude model |
| `engine_options.admin_theme_hint` | UI theme hint for boot screen |
| `wrapper.version` | Current wrapper version |
| `wrapper.track` | Update track (`stable`, etc.) |
| `wrapper.auto_update` | Enable automatic self-update |
| `wrapper.binary_url` | Download URL for self-update |
| `wrapper.binary_sha256` | SHA256 of the wrapper binary |

`host.engines`/`host.engines_list` are populated by `wrapper-config.ts` and
read by the Go `Config.Host` struct, but `wrappers/schemas/host-config-v1.json`
itself does not declare them (`host` has `additionalProperties: false`) and
nothing validates the served payload against that schema at runtime — treat
the JSON Schema file as stale reference, not an enforced contract.

## CLI subcommands and flags

### Subcommands

| Subcommand | Description |
|---|---|
| `run` (default) | Full startup sequence, then launch a Claude session |
| `status` | Local config summary + a `POST /auth` round-trip (not `/sync/status`); works even when config is unloadable (prints version + error); on a fresh install it also seeds credentials if the server returns auth while local status is `outdated`/`updated`/`missing` |
| `doctor` | Self-diagnostic: config, CLI presence, credentials, reachability |
| `auth-upload` | POST `~/.claude/.credentials.json` to the orchestrator |
| `exec -- <cmd...>` | Bypass startup sync; run a single Claude command directly |

Reserved upstream subcommands (`auth`, `login`, `logout`, `mcp`, `config`,
`doctor`, `sessions`, `resume`, `help`) route their `--help`/`-h` invocations
straight through to the real `claude` binary. `doctor` is listed here too, but
that only affects help passthrough (`clx doctor --help`) — a bare `clx doctor`
always hits the wrapper's own self-diagnostic, since the wrapper-owned
subcommand switch is checked first.

### Flags

| Flag | Description |
|---|---|
| `--continue` / `-c` | Forwarded to the upstream `claude` binary |
| `--resume <session>` | Forwarded to the upstream `claude` binary (no `-r` short form) |
| `--dangerously-skip-permissions` | Forwarded to the upstream `claude` binary for this run only; lights a red `⚠ bypass permissions` boot-screen badge (`Warn` row in `--minimal`). Per-run, not persisted — for a fleet-wide default use `permissions.defaultMode: bypassPermissions` on the Claude settings page instead |
| `--help` / `-h` / `help` | Full passthrough to upstream `claude`; skips all wrapper side effects (no lock, no sync, no boot screen) |
| `--cron [install\|remove\|run]` | Manage host auto-update crontab entry |
| `--version` / `-V` (also `--wrapper-version`) | Print version, commit, build date, OS/arch, pubkey status |
| `--update` / `-U` | Self-update (SHA256-verified) |
| `--uninstall` | Remove credentials, local state, and cron entry |
| `--execute <prompt>` | Run a one-shot headless prompt (skips boot screen) |
| `--silent` | Suppress wrapper output |
| `--debug` / `--verbose` | Verbose logging |
| `--minimal` / `--minimal-output` | Minimal boot screen |
| `--skip-boot` / `--no-banner` | Skip boot screen entirely |
| `-4` / `--ipv4` | Force IPv4 |
| `--allow-concurrent-sync` | Parsed but currently has no effect (dead flag) |

## Startup sequence

Implemented in `wrappers/clx/internal/lifecycle/` as `lifecycle.Run`:

1. **Acquire IPC flock** (`"clx"`). If already held by a concurrent invocation,
   enter read-only mode for managed `CLAUDE.md`, settings, collections, skills,
   the wrapper/Claude-CLI update, and peer reconciliation — but the run still
   submits the local auth digest and atomically writes server-returned
   canonical credentials on `outdated`/`updated`/`missing`, so a secondary run
   never launches against a stale local `.credentials.json`.

2. **POST `/sync/bootstrap`** with a `BundleRequest` carrying: `engine=claude`,
   `include_auth=true`, auth digest, auth candidate, agents digest, config
   digest, `home`, `username`, and artifact digests for subagents, commands,
   output-styles, and skills. Falls back to legacy separate `POST /auth`,
   `POST /agents/retrieve`, and `POST /config/retrieve` calls if the server
   returns 404, 501, or 405.

3. **Apply bundle response**:
   - Write `~/.claude/.credentials.json` when status is `outdated`, `updated`,
     or `missing`.
   - Write `~/.claude/CLAUDE.md` (agents/fleet instructions).
   - Deep-merge `~/.claude/settings.json` (fleet partial, preserving user keys;
     see [Settings merge](#settings-deep-merge) below).
   - Split `mcpServers.*` out of `settings.json` and into `~/.claude.json`
     (user-scope MCP; tracked in `~/.clx/state/managed-mcp.json`).
   - Write `~/.claude/agents/<slug>.md`, `commands/<slug>.md`,
     `output-styles/<slug>.md` from `claude_artifacts` (see
     [Claude-native collections](#claude-native-collections) below).
   - Write `~/.claude/skills/<slug>/SKILL.md` from `claude_skills`.
   - All writes are manifest-tracked; only manifest-recorded files are pruned
     on removal.

4. **Auth decision** (`orchestrator.Decide`). A few conditions are hard stops
   ahead of the status table below: the server's `versions.api_disabled` kill
   switch, an `installation_id` mismatch, a reverse-DNS mismatch, the host's
   Claude engine being disabled, and a `verification_state=failed` response
   (the background runner reached Anthropic and the canonical token did not
   authenticate) — the last one refuses with a re-login message. Otherwise,
   possible statuses:

   | Status | Meaning |
   |---|---|
   | `current` / `ok` | Credentials are valid and up to date |
   | `outdated` | Server has a newer credential; refreshed in step 3 |
   | `missing` | No credentials on host; written from server payload |
   | `upload_required` | Host has credentials the server doesn't; `auth-upload` needed |
   | `disabled` | Host is disabled; fleet settings + skills stripped |
   | `invalid` | Credential invalid; fleet settings + skills stripped |
   | `offline` | Orchestrator unreachable; falls back to a cached credential within 24h (7d on secure hosts) |
   | `error` | Server-side processing error; same cached-credential fallback as `offline` |
   | `insecure` (HTTP 423 maps here) | Awaiting admin approval; polls `PollApproval` every 5 s |
   | `insecure-denied` (HTTP 403) | Admin denied; fleet settings + skills stripped |

5. **Interactive credential recovery** — when the live-verification hard stop
   fires, or `missing`/`upload_required` has no usable local credential (or
   the uploaded candidate was rejected), an interactive `clx run` prompts to
   launch `claude auth login`, uploads the resulting credentials, and
   re-checks with the server. Non-interactive runs (cron, `--execute`) fail
   closed instead of opening the prompt.

6. **Install target Claude CLI version** if allowed and `auto_update` is
   enabled (`claude.EnsureClaude`), then — unless this is a concurrent
   (read-only) run — **reconcile the peer `cdx` wrapper** (`peer.Reconcile`):
   installs/updates or removes the Codex wrapper and CLI on this host per the
   server's `engines_list`. See [wrappers](/admin/manual/wrappers) for the
   shared peer-reconciliation mechanics (Ed25519-verified peer config bundle,
   guarded `--cron run` peer tick, etc.).

7. **Print boot screen** (or minimal screen with `--minimal`) to stderr, then
   `exec claude`. Immediately before the exec, `PreExec` re-checks the runtime
   hostname against the FQDN baked into the config and refuses unless
   `CLAUDE_ALLOW_FQDN_MISMATCH=1` — clx runs this guard at exec time, later in
   the sequence than cdx (which checks it right after acquiring the lock; see
   [wrappers](/admin/manual/wrappers)).

8. **Post-run**: if `~/.claude/.credentials.json` hash changed, upload to
   orchestrator (`AuthStore`). Print exit footer.

## Authentication model

`clx` does **not unconditionally** set `ANTHROPIC_API_KEY`, and never sets
`ANTHROPIC_BASE_URL`. The fleet keeps `~/.claude/.credentials.json` populated
with the native `claudeAiOauth` object (refresh token + expiry intact); the
orchestrator stores and serves this object verbatim.

The `PreExec` hook (`wrappers/clx/internal/claude/preexec.go`) conditionally
exports `ANTHROPIC_API_KEY` — only when `.credentials.json` holds a genuine
`sk-ant-api…` key — and never bridges an OAuth token (`sk-ant-oat…`), because
an injected OAuth token would trigger Claude Code's "detected custom API key"
prompt and override the native OAuth login.

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
`POST /cron/check`.

`clx --cron run` (Tick):

1. Calls `POST /cron/check` to ask the orchestrator whether a new wrapper
   version is available (a server response of `action: "disable"` — driven by
   the host's `auto_update_enabled` being off — removes the cron entry and
   stops here).
2. If a wrapper update is offered: verifies SHA256, downloads, self-replaces
   via atomic rename + re-exec (`CLAUDE_WRAPPER_RESTART_DEPTH` env var, capped
   at 2).
3. Ensures the `claude` CLI version matches the server-declared target
   (`claude.EnsureClaude`).
4. Reconciles the peer `cdx` wrapper/CLI on dual-engine hosts
   (`peer.EnsureForCron`, guarded by `CODEX_ORCH_PEER_SPAWN=1` against
   recursion — see [wrappers](/admin/manual/wrappers)).
5. Reports the installed `claude` version to `POST /cron/report` (a **separate**
   endpoint from the `/cron/check` probe in step 1), retrying once on failure.

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
- `advisorModel` is only written for tier aliases (`opus`, `sonnet`, `haiku`);
  any other value is treated as off and the key is omitted (and cleaned up via
  the stale-path removal on a later run).
- `permissions.defaultMode` is **always** emitted by the server — when no
  fleet setting pins a value it defaults to `"auto"`
  (`DEFAULT_CLAUDE_PERMISSION_MODE` in `config-normalizer.ts`). It rides the
  generic dotted-leaf merge (not the allow/ask/deny union special-case), since
  Claude Code only reads the nested `permissions.defaultMode` form, not a
  top-level `permissionMode` key.

## Claude-native collections

Claude Code reads several artifact *collections* off disk that Codex has no
analogue for: subagents, commands, and output-styles. The orchestrator manages
them as first-class fleet artifacts (table `claude_artifacts`, one row per
item, discriminated by `kind`), synced via the same `/sync/bootstrap` bundle
(step 3 above) as `claude_artifacts: { subagent:[…], command:[…],
"output-style":[…] }`:

| Kind | On-disk target |
|---|---|
| `subagent` | `~/.claude/agents/<slug>.md` |
| `command` | `~/.claude/commands/<slug>.md` |
| `output-style` | `~/.claude/output-styles/<slug>.md` |

`wrappers/clx/internal/lifecycle/collections.go` writes each `<slug>.md` and
tracks exactly the files it wrote per directory; pruning removes only
manifest-recorded files that dropped out of the live set, so user-authored
files in those directories are never touched. Admin CRUD lives at
`GET /admin/claude/:kind`, `GET /admin/claude/:kind/:slug`,
`POST /admin/claude/:kind/store`, and `DELETE /admin/claude/:kind/:slug`
(backed by `api/src/services/claude-artifacts.ts`); the host-facing surface is
read-only (`GET /claude/:kind`, `POST /claude/:kind/retrieve`).

## Source references

- `wrappers/clx` — Go module (wrapper binary, incl. `internal/peer` peer-wrapper
  reconciliation and `internal/lifecycle/collections.go` artifact sync)
- `api/src/routes/wrapper-v2/index.ts` — binary + config + manifest endpoints
- `api/src/routes/install/index.ts` — installer and seed-auth tokens
- `api/src/routes/auth/index.ts` — `/sync/bootstrap`, `/sync/status`
- `api/src/routes/host/index.ts` — `/cron/check`, `/cron/report`
- `api/src/routes/cli-auth/index.ts` — device-code registration flow
- `api/src/services/claude-artifacts.ts` — subagent/command/output-style fleet artifacts
- `api/src/services/client-config.ts` — renders the `claude_settings` partial (incl. `permissions.defaultMode`)
- `wrappers/schemas/host-config-v1.json` — config schema (partial — `host.engines`/`host.engines_list` are not declared here)
