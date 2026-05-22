# `clx` Wrapper Interface

Source-of-truth contract for the `clx` wrapper (Claude Code fleet wrapper).
Mirrors `docs/interface-cdx.md` with engine-specific deltas called out explicitly.

## At a glance

| | `cdx` (Codex) | `clx` (Claude) |
|---|---|---|
| Wrapper binary | static Go binary (`wrappers/cdx/`) | static Go binary (`wrappers/clx/`) |
| Built by | `cd wrappers && make cdx` | `cd wrappers && make clx` |
| CLI under the hood | `codex` (Rust) | `claude` or `claude-code` (Node, `@anthropic-ai/claude-code`) |
| Auth file | `~/.codex/auth.json` | `~/.claude/.credentials.json` |
| Config file | `~/.codex/config.toml` (TOML) | `~/.claude/settings.json` (JSON) |
| Agents document | `AGENTS.md` | `CLAUDE.md` |
| API key prefix | `sk-codex-` | `sk-claude-` |
| Admin API endpoints | `/v1/*` + `/admin/openai/*` | `/anthropic/v1/*` + `/admin/claude/*` |
| Engine in config | `engine: "codex"` | `engine: "claude"` |

## CLI surface

| Subcommand | Purpose |
|---|---|
| `run` (default) | One Claude session; runs the full startup sequence first |
| `status` | Local config summary + `/sync/status` ping |
| `doctor` | Self-diagnostic (config, CLI present, credentials, reachability) |
| `auth-upload` | POST the local credentials file to canonical store |
| `exec -- <cmd...>` | Bypass startup sync; run a single Claude command |
| `--continue` | Passed straight through to the upstream `claude` binary |
| `--resume <session>` | Passed straight through to the upstream `claude` binary |
| `--help` / `-h` / `help` | Passed straight through to the upstream `claude` binary without running auth/sync/boot |
| `--cron [install\|remove\|run]` | Manage the host's auto-update crontab entry; cron ticks bootstrap `/usr/local/bin` into `PATH` before probing/updating Claude Code |
| `--version` | Print version + commit + embedded pubkey status |
| `--update` | Self-update now (verifies SHA256 before swapping) |
| `--uninstall` | Remove credentials + local state + cron entry; refuses on multi-user hosts without sudo |

No `lane`/`profile` subcommands — Claude has neither in this orchestrator.

## Per-host config (typed, signed)

Same schema as cdx (`wrappers/schemas/host-config-v1.json`), with
`engine: "claude"` and a Claude-shaped `engine_options` block:

```jsonc
{
  "schema_version": 1,
  "engine": "claude",
  "engine_options": {
    "silent": false,
    "claude_model_override": "claude-sonnet-4-6",
    "admin_theme_hint": "auto"
  }
  // orchestrator / host / wrapper blocks are identical to cdx
}
```

## Distribution surfaces

Identical to cdx with engine swapped:

| Method | Path |
|---|---|
| GET | `/wrapper/v2/bin/clx/<os>-<arch>/v<ver>/clx` |
| GET | `/wrapper/v2/manifest/claude` |

## Startup sequence

Mirrors the cdx lifecycle (see `docs/interface-cdx.md`) — single-instance
flock, bundle (`/sync/bootstrap` with `include_auth=true`; resource envelopes
are unwrapped before `CLAUDE.md` / `settings.json` writes), typed auth decision
matrix including approval-pending polling, FQDN runtime guard, Claude CLI
version reconciliation, post-run credential re-upload on sha change, JSONL-based
token usage extraction, and best-effort `/usage` batch POST. Engine-specific
details:

- Credentials read precedence: `~/.clx/auth/credentials.json` first, then
  `~/.claude/.credentials.json`; writes go to both so the upstream CLI sees
  them whichever path it consults.
- Settings file mirrored to `~/.clx/config/settings.json` after the canonical
  `~/.claude/settings.json` is written.
- `CLAUDE_MD` env exported to the synced AGENTS path so the upstream CLI
  picks up the orchestrator-managed `CLAUDE.md`.
- Skills probe uses `GET /skills?engine=claude` so the response excludes
  Codex-only skills. Legacy on-disk caches purged: `~/.agents/skills`,
  `~/.clx/skills`, `~/.claude/skills` (one-shot per wrapper version).
- No quota bars — Claude has no orchestrator-side quota concept; the
  ChatGPT-style headless QuotaWarn emission is therefore a no-op on clx.

## Adding fields

Follow the same pattern as cdx but edit `wrappers/clx/...`. The schema and
the Go config struct are deliberately kept identical between the two binaries
to make cross-cutting changes mechanically diffable.
