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
  // orchestrator / host / wrapper blocks are identical to cdx; host includes
  // engines / engines_list for peer reconciliation
}
```

## Peer engine reconciliation

After a successful startup sync, `clx` reads the host `engines_list`. If Codex is
enabled, `clx` fetches the signed `cdx` config from
`/wrapper/v2/config?engine=codex`, writes `cdx.json{,.sig}`, verifies the served
SHA256, and installs/updates the `cdx` binary beside the running wrapper. If
Codex is disabled, `clx` performs local-only full Codex cleanup (wrapper
binary/config/cron, managed `~/.codex` state, `/opt/codex`, and the npm global
`codex-cli` package when detected) without deleting the host row.

## Distribution surfaces

Identical to cdx with engine swapped:

| Method | Path |
|---|---|
| GET | `/wrapper/v2/bin/clx/<os>-<arch>/v<ver>/clx` |
| GET | `/wrapper/v2/manifest/claude` |

Config, download, and cron-check calls send `X-Wrapper-Platform: <os>-<arch>`
(`linux-amd64`, `linux-arm64`, `darwin-arm64`, or `darwin-amd64`) so the
orchestrator can bake the matching `binary_url` / SHA256 for this host.

## Startup sequence

Mirrors the cdx lifecycle (see `docs/interface-cdx.md`) — single-instance
flock, bundle (`/sync/bootstrap` with `include_auth=true`; resource envelopes
are unwrapped before `CLAUDE.md` / `settings.json` writes), typed auth decision
matrix including approval-pending polling, FQDN runtime guard, Claude CLI
version reconciliation, post-run credential re-upload on sha change, JSONL-based
token usage extraction, and best-effort `/usage` batch POST. Engine-specific
details:

- Credentials are read from the newest structurally usable file across
  `~/.claude/.credentials.json` and `~/.clx/auth/credentials.json`, with
  `~/.claude/.credentials.json` winning ties because upstream Claude Code writes
  there. Server-accepted credentials are always written to `~/.claude` and are
  mirrored to `~/.clx/auth/credentials.json` when that sidecar already exists.
- **Auth model is native account-login, 1:1 with cdx/`auth.json`.** The fleet
  keeps the host's `.credentials.json` current and Claude Code reads its
  `claudeAiOauth` account login from it directly. clx deliberately does **not**
  set `ANTHROPIC_API_KEY`/`ANTHROPIC_BASE_URL`, and `preexec` only exports a
  genuine API key (`sk-ant-api…`), never an OAuth token (`sk-ant-oat…`) — an
  injected key pops Claude Code's "detected custom API key" prompt and overrides
  the OAuth login. The orchestrator stores+serves the native `claudeAiOauth`
  object (not just a derived `auths` bearer), so the refresh token/expiry survive
  the round-trip. The `/anthropic/v1` proxy is a separate gateway for issued
  `sk-claude-*` keys and is not part of the host launch path.
- `clx auth-upload`, missing/upload-required pre-run upload, and post-run
  changed-credential upload backfill `last_refresh` only in the uploaded copy.
  When the server returns canonical auth (including runner-refreshed auth), the
  wrapper writes that accepted payload back locally.
- Settings file mirrored to `~/.clx/config/settings.json` after the canonical
  `~/.claude/settings.json` is written.
- `CLAUDE_MD` env exported to the synced AGENTS path so the upstream CLI
  picks up the orchestrator-managed `CLAUDE.md`.
- **Skills are synced ON-DISK** as native `~/.claude/skills/<slug>/SKILL.md`
  (one directory per skill). Unlike Codex — which reads skills live over MCP
  (`resource_read skill://<slug>`) — Claude Code cannot consume skills over MCP,
  so the bundle returns `claude_skills` (complete live set of `engine`
  null/`claude` skills; `content` omitted on rendered-sha match) and the wrapper
  writes them with a dedicated `~/.clx/state/collections/skills.json` manifest.
  The server **coerces the SKILL.md `name:` to the slug** (Claude Code's native
  loader requires it). Prune/strip/uninstall remove only manifest-recorded skill
  dirs — user-authored skill dirs are never touched. Legacy bash-era caches still
  purged one-shot: `~/.agents/skills`, `~/.clx/skills`. **`~/.claude/skills` is no
  longer purged** — it is the fleet-managed store.
- No quota bars — Claude has no orchestrator-side quota concept; the
  ChatGPT-style headless QuotaWarn emission is therefore a no-op on clx.

## Claude-native collections (subagents / commands / output-styles)

Claude Code reads several artifact *collections* off disk that Codex has no
analogue for. The orchestrator manages them as first-class fleet artifacts
(table `claude_artifacts`, one row per item, discriminated by `kind`):

| Kind | On-disk target | Frontmatter (required) |
|---|---|---|
| `subagent` | `~/.claude/agents/<slug>.md` | `name`, `description` |
| `command` | `~/.claude/commands/<slug>.md` | `description` |
| `output-style` | `~/.claude/output-styles/<slug>.md` | — |

- The bundle (`/sync/bootstrap`, `engine=claude` only) returns
  `claude_artifacts: { subagent:[…], command:[…], "output-style":[…] }`. Each
  list is the **complete live set**; an item carries `content` only when its
  sha differs from the digest the wrapper advertised under the request's
  `artifacts` map (If-None-Match). Per-artifact `model` is baked into the file's
  frontmatter once at store time so the sha is identical fleet-wide.
- The wrapper writes `<slug>.md` and tracks exactly the files it wrote in
  `~/.clx/state/collections/<dir>.json`. Pruning removes only manifest-recorded
  files absent from the live set — **user-authored files in those dirs are never
  touched** (the deliberate opposite of the legacy whole-dir skill purge).
  `sanitizeSlug` blocks path-traversal slugs.
- Admin: `GET /admin/claude/:kind`, `GET /admin/claude/:kind/:slug`,
  `POST /admin/claude/:kind/store`, `DELETE /admin/claude/:kind/:slug`. Host
  surface is read-only: `GET /claude/:kind`, `POST /claude/:kind/retrieve`
  (these artifacts are admin-authored fleet-wide). `:kind` accepts singular or
  plural spellings.

## Settings.json sub-blocks (deep-merge, non-clobbering)

`~/.claude/settings.json` is **deep-merged**, not overwritten. The bundle returns
`claude_settings: { sha256, partial, owned_paths }` where `partial` holds only
the fleet-managed keys (`model`, `mcpServers.<name>`, `env.<VAR>`, `statusLine`,
`hooks.<Event>`, `permissions.{allow,ask,deny}`, `advisorModel`) and `owned_paths`
are the leaf-granular dot-paths the fleet owns this run.

- `advisorModel` enables Claude Code's experimental advisor tool (routes the full
  transcript to a stronger reviewer model). Restricted to the tier aliases
  `opus` / `sonnet` / `haiku`; any other value is treated as off and the key is
  omitted (and removed on the host via the stale-path cleanup).

- The server renders the partial **only** from the Claude-engine `client_config`
  (or per-host `claude_model_override`) — it never falls back to the Codex config.
  A greenfield Claude host with no authored Claude settings therefore receives an
  empty partial **plus** the managed `mcpServers.clx` block, and no `model` key:
  the Codex `model` (e.g. `gpt-5.5`) must never leak into `settings.json`.
- **`mcpServers.<name>` is the one exception to the settings.json destination:**
  Claude Code reads user-scope MCP servers from the **top level of
  `~/.claude.json`**, not from `settings.json`. The wrapper splits the
  `mcpServers.*` owned paths out of the partial and merges them into
  `~/.claude.json` (managed names tracked in `~/.clx/state/managed-mcp.json`;
  user-authored servers and all other `.claude.json` keys survive; an
  unparseable file is never overwritten). Because the split removes
  `mcpServers.*` from the settings.json owned set, the stale-path cleanup
  removes the inert block older wrapper versions wrote there.
- The wrapper merges `partial` over the user's file, preserving every key the
  fleet does not own. It persists `owned_paths` to `~/.clx/state/managed-keys.json`;
  paths in the sidecar but no longer owned are removed next run (that is how a
  retired hook / env var gets cleaned up). The server stays stateless.
- `permissions.{allow,ask,deny}` arrays union the user's rules with the fleet's
  (previously-injected fleet rules are stripped first, then re-added — no
  duplicates). All other owned paths are leaf set/delete so user siblings survive.
- Legacy clx wrappers (no `claude_settings` support) still receive the wholesale
  `config` body and overwrite as before; new wrappers prefer the merge.
- On an explicit server refusal (`disabled` / `invalid` / `insecure-denied`) the
  wrapper surgically strips fleet-owned settings keys and collection files so a
  host that lost trust no longer carries fleet hooks/permissions/subagents. It
  never strips on a transient `offline` status.
- Per-host model: `host.claude_model_override` flows into the rendered partial's
  `model` key. `ANTHROPIC_MODEL` (env) still wins at runtime, so the env export
  remains authoritative; subagent-level model lives in each file's frontmatter.

## Adding fields

Follow the same pattern as cdx but edit `wrappers/clx/...`. The schema and
the Go config struct are deliberately kept identical between the two binaries
to make cross-cutting changes mechanically diffable.
