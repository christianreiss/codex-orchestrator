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
| `exec -- <cmd...>` | Bypass startup sync; run a single Claude command |
| `--version` | Print version + commit + embedded pubkey status |
| `--update` | Self-update now |

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

Same five-step lifecycle as cdx, but invoking the `claude` CLI and writing
auth to `~/.claude/.credentials.json` / settings to `~/.claude/settings.json`.

## Adding fields

Follow the same pattern as cdx but edit `wrappers/clx/...`. The schema and
the Go config struct are deliberately kept identical between the two binaries
to make cross-cutting changes mechanically diffable.
