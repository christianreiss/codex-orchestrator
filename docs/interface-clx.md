# `clx` Wrapper Interface

Source-of-truth contract for the `clx` wrapper (Claude Code fleet wrapper).
Mirrors `docs/interface-cdx.md` with engine-specific deltas called out explicitly.

## At a glance

| | `cdx` (Codex) | `clx` (Claude) |
|---|---|---|
| Wrapper binary | `cdx` | `clx` |
| Generated from | `bin/cdx.d/` | `bin/clx.d/` |
| CLI under the hood | `codex` (Rust) | `claude` or `claude-code` (Node, `@anthropic-ai/claude-code`) |
| Auth file | `~/.codex/auth.json` | `~/.clx/auth/credentials.json` (also exports `ANTHROPIC_API_KEY` into Claude CLI) |
| Config file | `~/.codex/config.toml` (TOML) | `~/.clx/config/settings.json` + mirrored to `~/.claude/settings.json` (JSON) |
| Agents document | `AGENTS.md` | `CLAUDE.md` |
| API key prefix | `sk-codex-` | `sk-claude-` |
| Admin API endpoints | `/v1/*` + `/admin/openai/*` | `/anthropic/v1/*` + `/admin/claude/*` |

## CLI surface

```
clx                       Launch Claude Code interactively
clx <prompt>              Run Claude Code with a prompt
clx --execute "<cmd>"     One-shot execution
clx --continue            Continue last conversation
clx --resume <session>    Resume a specific session
clx status                Show CLX status summary
clx doctor                Diagnose CLX setup
clx auth-upload           Normalize and upload current Claude credentials
clx --update              Update CLX wrapper + Claude CLI
clx --cron                Run cron auto-update check
clx --cron install        Install cron auto-update job
clx --cron remove         Remove cron auto-update job
clx --uninstall           Decommission this host
clx --version             Show version
clx --help                Show this help
```

### Environment variables

| Name | Purpose |
|---|---|
| `CLAUDE_MODEL` | Override the model (e.g. `claude-sonnet-4-6`). |
| `CLAUDE_DEBUG=1` | Enable debug output. |
| `CLAUDE_SILENT=1` | Suppress CLX output (pass-through only). |
| `CLAUDE_FORCE_IPV4=1` | Force IPv4 proxy for Claude traffic. |
| `CLAUDE_CONCURRENT_SYNC_OVERRIDE=1` | Take the run lock even when another CLX is detected (normally we defer to the active run). |
| `CLX_USE_STARTUP_BUNDLE=1` | Opt into the atomic `/sync/bootstrap` call (default off until the endpoint is proven for Claude). |
| `CLX_AUTO_UPDATE_ENABLED` | `1` (default) lets the wrapper self-update when the server advertises a newer version with `auto_update_enabled=true`. |
| `CLAUDE_WRAPPER_RESTART_DEPTH` | Internal: depth guard against update loops. Never set manually. |
| `ANTHROPIC_API_KEY` | Exported at exec time from the synced auth. Picked up by Claude Code CLI. |
| `CLAUDE_MD` | Exported to point Claude Code at the synced `CLAUDE.md`. |

## Boot sequence

1. `clx_acquire_lock` — takes `$CLX_DATA_DIR/.clx.lock`; non-blocking, logs if another clx is running.
2. `ensure_deps` — verifies `curl` and `jq` (both hard), detects `claude` or `claude-code` binary.
3. Auth / agents / config sync — either via one atomic `/sync/bootstrap` call (if `CLX_USE_STARTUP_BUNDLE=1`) or via the three legacy endpoints (`/auth`, `/agents/retrieve`, `/config/retrieve`).
4. Skills sync — `GET /skills?engine=claude`.
5. Model override application — if `CLAUDE_HOST_MODEL` is baked in, exports `CLAUDE_MODEL`.
6. Non-blocking wrapper update check — `GET /wrapper?engine=claude`.
7. Entry gating — auth status drives whether the CLI can launch (ok / offline / invalid / disabled / insecure / concurrent / skip / fail).
8. Claude CLI exec — with `ANTHROPIC_API_KEY`, `CLAUDE_MD`, and the IPv4 proxy if forced.
9. Usage recording — `POST /usage` with engine `claude`.

## Sync contract

| Endpoint | Direction | Engine payload | Notes |
|---|---|---|---|
| `POST /auth` | clx → api | `{command: "retrieve"\|"store", digest, engine: "claude", auth?}` | Returns `status: valid\|outdated\|updated\|upload_required\|missing\|disabled\|invalid\|insecure\|insecure-denied\|concurrent`. |
| `DELETE /auth?engine=claude` | clx → api | n/a (query param) | Decommission host. |
| `POST /agents/retrieve` | clx → api | `{sha256, engine: "claude"}` | Returns `CLAUDE.md` body or `status=unchanged`. |
| `POST /config/retrieve` | clx → api | `{sha256, engine: "claude"}` | Returns JSON `settings.json` body. |
| `GET /skills?engine=claude` | clx → api | n/a | Returns skill list for this engine. |
| `POST /sync/bootstrap` | clx → api | `{engine: "claude", include_auth, agents, config, auth_digest}` | Atomic three-in-one. Optional, gated by `CLX_USE_STARTUP_BUNDLE`. |
| `POST /usage` | clx → api | `{engine: "claude", fqdn, entries}` | Token usage entries extracted from Claude session JSONL. |
| `POST /cron/check` | clx → api | `{client_version, wrapper_version, engine: "claude"}` | Invoked by the cron auto-update job. |
| `GET /wrapper?engine=claude` | clx → api | n/a | Metadata (`version`, `sha256`, `auto_update_enabled`). |
| `GET /wrapper/download?engine=claude` | clx → api | n/a | Returns the clx shell script. SHA256 verified against the metadata response. |

## Config bake rules

`WrapperService::bakedForHost()` templates the generated `bin/clx` with these placeholders:

| Placeholder | Source | Meaning |
|---|---|---|
| `__CLAUDE_SYNC_BASE_URL__` | `$baseUrl` | Public orchestrator base URL. |
| `__CLAUDE_SYNC_API_KEY__` | `hosts.api_key_plain` | Per-host API key for `/auth`, `/agents`, `/config`, `/wrapper`, `/usage`. |
| `__CLAUDE_SYNC_FQDN__` | `hosts.fqdn` | Operator-facing host identity. |
| `__CLAUDE_SYNC_CA_FILE__` | `$caFile` | Optional CA bundle path. |
| `__CLAUDE_HOST_SECURE__` | `hosts.secure` | `1` or `0`. |
| `__CLAUDE_INSTALLATION_ID__` | installation UUID | Steady identifier for the orchestrator installation. |
| `__WRAPPER_VERSION__` | `WrapperService::metadata()` | The version the operator sees with `clx --version`. |
| `__CLAUDE_SILENT__` | `versions.clx_silent \|\| versions.cdx_silent` | Fleet-wide silent default. |
| `__CLAUDE_SYNC_ALLOW_INSECURE__` | `hosts.curl_insecure` | `1` or `0`; adds `-k` to curl. |
| `__CLAUDE_HOST_MODEL__` | `hosts.claude_model_override` | Applied as `CLAUDE_MODEL` env at exec time. Omitted when the override is empty. |

Host-baked string values are shell-escaped before download so malformed or operator-entered host labels cannot break wrapper parsing.

## Auth upload

`clx auth-upload` mirrors `cdx auth-upload`: it prepares the current Claude credentials, adds `last_refresh` when needed, stores them through `/auth` with `command=store` and `engine=claude`, then exits without launching Claude Code. The upload source is `~/.clx/auth/credentials.json` when present, otherwise `~/.claude/.credentials.json` from `claude login`. Accepted credential shapes are `auths["api.anthropic.com"].token`, `api_key`, `anthropic_api_key`, and `ANTHROPIC_API_KEY`; the server canonicalizes these into the Anthropic auth target.

## Intentional deltas vs `cdx`

- **No quota lanes / Spark lane.** ChatGPT-specific. Claude's quota is a monthly spend cap + per-minute RPM; see `ClaudeUsageService`.
- **No `--lane` command.** Absence of lanes → absence of lane-selection UI. Operators configure `claude_model_override` per host instead.
- **No `reasoning_effort` override.** Anthropic's API has no such parameter.
- **No device-code CLI login.** Claude Code CLI accepts `ANTHROPIC_API_KEY` directly; the wrapper syncs credentials.json and exports the key at exec time.
- **No GitHub-release CLI download.** Claude CLI is npm-only. `clx --update` runs `npm install -g @anthropic-ai/claude-code` with a sudo fallback.
- **No SSH alt-screen override.** Claude Code CLI handles its own terminal state.
- **`/v1/completions` vs `/anthropic/v1/completions`** — both exist. Claude's completions wraps the Messages API internally.
- **Auth header.** The Anthropic-compatible API accepts `Authorization: Bearer …`, `x-api-key: …`, and raw token in the `Authorization` header; the OpenAI-compatible API only accepts `Authorization: Bearer …` to match OpenAI's public API.

## `clx doctor` checks

Covers:

- `claude` / `claude-code` binary presence and version.
- `curl`, `jq`, `python3` availability (python3 is optional but needed for auth validation and future startup-bundle helpers).
- Auth file presence and freshness (fresh / stale-within-fallback / stale).
- Config / CLAUDE.md presence.
- Sync URL reachability + latency.
- Claude runner verification (if orchestrator reports one).

## Host install modes

Install tokens carry an `engine` field that maps to an `InstallerMode`:

- `codex` → installs Codex CLI + `cdx` wrapper.
- `claude` → installs Claude CLI (via npm) + `clx` wrapper.
- `both` → installs both.

The admin UI radios at `#seedEngineCodex` / `#seedEngineClaude` set the seed engine for canonical-auth uploads; the host-create form's engine checkboxes (`engineCodexToggle`, `engineClaudeToggle`) set the host's `engines` list.

## Generated artifact

Never edit `bin/clx` directly. Always edit fragments under `bin/clx.d/` and run `bash scripts/build-clx.sh` (or the Codex equivalent which rebuilds both).

## See also

- `docs/interface-cdx.md` — Codex wrapper interface.
- `docs/API.md` — HTTP API for both engines.
- `docs/OVERVIEW.md` — overall orchestrator architecture.
- `runner/README.md` — runner sidecar including `/verify-claude`.
