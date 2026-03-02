# cdx Wrapper Interface (Source of Truth)

## Build + Publish
- `bin/cdx` is generated from sorted `bin/cdx.d/*.sh` fragments by `scripts/build-cdx.sh`.
- Edit `bin/cdx.d/*.sh`, then rebuild; do not edit generated `bin/cdx` directly.
- Wrapper download surfaces are:
  - `GET /wrapper` (metadata JSON; script content omitted).
  - `GET /wrapper/download` (host-baked shell script; includes `X-SHA256`/`ETag` when available).
- No non-admin HTTP route exists to upload/replace wrappers.

## Host-Baked Runtime Values
At download time, the server bakes host-specific placeholders into the wrapper:
- `CODEX_SYNC_BASE_URL`
- `CODEX_SYNC_API_KEY`
- `CODEX_SYNC_FQDN`
- `CODEX_SYNC_CA_FILE`
- `CODEX_HOST_SECURE`
- `CODEX_FORCE_IPV4`
- `CODEX_INSTALLATION_ID`
- `CODEX_SILENT`
- `CODEX_SYNC_ALLOW_INSECURE`
- Optional host model defaults: `CODEX_HOST_MODEL`, `CODEX_HOST_REASONING_EFFORT`

Guardrails:
- Wrapper enforces baked FQDN at runtime. Override only with `CODEX_ALLOW_FQDN_MISMATCH=1`.
- `load_sync_config` uses baked config only; it does not read local sync env files.

## Startup Sequence
1. Resolve real `codex` binary (`/usr/local/bin/codex`, `/opt/codex/bin/codex`, or `PATH`); abort if none found.
2. Acquire per-user run lock with `flock` (`/tmp` or `/var/tmp`) unless `--allow-concurrent-sync`.
3. Sync auth via `POST /auth`.
4. Startup bundle pull via `POST /sync/status` and (when needed) `POST /sync/bootstrap`.
5. If bundle pull fails, fallback pulls run: slash commands, skills, AGENTS, config.
6. Compute local auth freshness:
   - fresh window: `24h` (`MAX_LOCAL_AUTH_AGE_SECONDS`)
   - secure-host recent window: `7d` (`MAX_LOCAL_AUTH_RECENT_SECONDS`)
7. Check/update Codex + wrapper.
8. Render boot summary and enforce launch gates.
9. Launch Codex (unless status/doctor/lane-only path exits first).
10. Cleanup trap: prompt/skill push, auth push, usage push, insecure-host auth purge (when applicable), lock release.

Concurrent-run guard behavior (`active cdx run detected`):
- Skips pre-run mutating sync/update operations.
- Still performs read-only auth retrieve (`CODEX_SYNC_READ_ONLY=1`) for policy/quota metadata.
- Requires valid local auth to proceed.
- Still performs post-run auth/usage upload.
- Skips insecure-host post-run `auth.json` purge in this path.

## Auth Contract Used By Wrapper
- `/auth` command defaults to `retrieve`; wrapper also uses `store`.
- Local auth validation requires `last_refresh` plus:
  - non-empty `auths`, or
  - fallback token (`tokens.access_token` or `OPENAI_API_KEY`).
- Retrieve statuses handled: `valid`, `outdated`, `upload_required`, `missing`.
- On `upload_required|missing`, wrapper attempts `store`.
- If `store` returns `updated|unchanged`, wrapper normalizes local auth status to `valid`.
- Post-run auth push now detects changes using both `last_refresh` and local `auth.json` SHA-256 content hash (not timestamp alone), so same-timestamp token changes still upload.
- Offline launch fallback:
  - allowed with fresh auth (`<=24h`), or
  - allowed on secure hosts with recent auth (`<=7d`).
- Wrapper deny-reason handling includes reverse DNS mismatches and installation ID mismatches.
- Wrapper blocks launch when API kill-switch denies non-admin routes.
- Insecure approval flow:
  - approval pending returns 423 and wrapper polls every 5 seconds.
  - approval denied blocks launch.
- Installation ID mismatches block sync.

## CLI Surface
| Command | Behavior |
| --- | --- |
| `cdx --wrapper-version` / `cdx -W` | Print wrapper version and exit. |
| `cdx status` / `cdx --status` | Run sync/update checks + summary, do not launch Codex. Exit `0` unless red/error state (`1`). |
| `cdx doctor` / `cdx --doctor` | Run status checks plus diagnostics (deps, auth freshness, sync states, `/versions` probe, PTY state). Exit non-zero on critical failures/red state. |
| `cdx --update` / `cdx -U` | Force wrapper update attempt from server and exit immediately after the attempt. |
| `cdx --uninstall` | Deregister host auth and remove Codex/wrapper artifacts. |
| `cdx -4` | Force IPv4 for wrapper network calls for this invocation. |
| `cdx --allow-concurrent-sync` | Bypass active-run lock for this invocation. |
| `cdx --debug` / `cdx --verbose` | Enable wrapper debug logs. |
| `cdx --execute "<prompt>" [codex args...]` | Bypass wrapper boot/sync/update path and run direct non-interactive `codex exec` with wrapper defaults (`--sandbox read-only`, `-a untrusted`), while honoring `cdx lane normal|spark` selectors when invoked as `cdx lane <lane> -- --execute "<prompt>"`. |

Lane subcommand:
- `cdx lane` prints effective lane/source/persisted preference and exits.
- `cdx lane normal|spark [--persist] [-- <codex args...>]` sets one-shot lane and launches Codex.
- `cdx lane clear --persist` clears persisted lane and exits (no passthrough args allowed).
- `--persist` writes lane preference through `POST /host/lane`.
- If lane profile exists in config (`[profiles.normal]`/`[profiles.spark]`), wrapper injects `--profile`.
- If lane profile is missing, wrapper injects model fallback:
  - `normal` -> `gpt-5.3-codex`
  - `spark` -> `gpt-5.3-codex-spark`
- When the effective model resolves to `gpt-5.3-codex-spark` (lane/host injection, explicit `--model`, or selected `--profile` model), wrapper injects `--config model_reasoning_summary=none`; if an explicit profile is active it also injects `--config profiles.<profile>.model_reasoning_summary=none` so legacy profile-level summaries cannot leak through.
- `cdx lane spark -- --execute "<prompt>"` applies the same spark summary guards in execute mode; if profile `spark` exists it uses `--profile spark` plus both root/profile summary overrides, otherwise it falls back to `--model gpt-5.3-codex-spark`.

Profile shorthand:
- `cdx <name> [args...]` maps to `--profile <name>` when `[profiles.<name>]` exists.
- Reserved commands are never treated as profile shorthand:
  - `exec`, `review`, `login`, `logout`, `mcp`, `mcp-server`, `app-server`, `completion`, `sandbox`, `debug`, `apply`, `resume`, `fork`, `cloud`, `features`, `help`.

## Synced Local State
| Resource | Pull | Push | Local path |
| --- | --- | --- | --- |
| Slash commands | `GET /slash-commands` + `POST /slash-commands/retrieve` | `POST /slash-commands/store` | `~/.codex/prompts/*`, baseline `~/.codex/.prompt-baseline.json` |
| Skills | `GET /skills` + `POST /skills/retrieve` | `POST /skills/store` | `~/.agents/skills/<slug>/SKILL.md`, baseline `~/.agents/.skill-baseline.json` |
| AGENTS | `POST /agents/retrieve` | None | `~/.codex/AGENTS.md` |
| Config | `POST /config/retrieve` | None | `~/.codex/config.toml` |

Sync details:
- Startup bundle path (`/sync/status` + `/sync/bootstrap`) applies prompts/skills/AGENTS/config in one pass.
- Wrapper falls back to legacy per-resource pulls if bundle path fails or endpoints are missing.
- Deleted/retired remote prompts and skills are removed locally.
- `status:missing` from AGENTS/config retrieval deletes local file.
- Prompt store reads frontmatter keys `description` and `argument-hint`.
- Skill store reads frontmatter keys `name` and `description`.
- Wrapper includes `username` + `home` when retrieving config so server can bake per-user trusted project settings.
- Atomic writes (temp + `fsync` + replace) are used for auth, baselines, AGENTS, and config files.

## Config Bake Rules (`/config/retrieve`)
- Response statuses: `updated`, `unchanged`, `missing`.
- Response includes `sha256` (baked), `base_sha256` (stored canonical), `updated_at`, `size_bytes`.
- `content` is returned only when status is `updated`.
- When status is `missing`, wrapper deletes local `~/.codex/config.toml`.
- Server applies host model overrides before baking config.
- Supported override models:
  - `gpt-5.3-codex`
  - `gpt-5.3-codex-spark`
  - `gpt-5.2-codex`
  - `gpt-5.1-codex-max`
  - `gpt-5.2`
  - `gpt-5.1-codex-mini`
- Supported reasoning effort values: `low|medium|high|xhigh`.
- `gpt-5.1-codex-mini` accepts only `medium|high`.
- Normalization defaults include `features.multi_agent=true` when unset.
- Legacy config keys `steer`, `experimental_windows_sandbox`, and `enable_experimental_windows_sandbox` are accepted for ingest compatibility but dropped from rendered output.
- When `home` is provided, server appends trusted project stanza for that path.

## Quota, Lane, and Summary Rendering
Inputs consumed from auth/sync responses:
- `quota_hard_fail`, `quota_limit_percent`, `quota_week_partition`, `cdx_silent`
- `chatgpt_usage` windows and `active_quota_lane`
- Runner telemetry (`runner_state`, `runner_last_ok`, `runner_last_fail`, `runner_last_check`)
- Host usage (`api_calls`, monthly token totals)

Wrapper quota behavior:
- `QUOTA_LIMIT_PERCENT` is clamped to `50..100`.
- `QUOTA_WEEK_PARTITION` is normalized to `0|5|7`.
- Hard fail mode blocks launch at/above threshold.
- Warn mode logs warning but continues.

Summary layout:
- Sections: `Health`, `Versions`, `Usage`, `Quota`, `Result`.
- In non-minimal output, concurrent-guard mode is compact (`Concurrent` + `Quota`).
- Default row density:
  - global: `3` (`SUMMARY_ITEMS_PER_ROW`)
  - `Versions`: `2`
  - `Quota`: `1`
- Overrides:
  - `CODEX_SUMMARY_ITEMS_PER_ROW`
  - `CODEX_SUMMARY_ITEMS_PER_ROW_<SECTION>`
- Daily allowance bar is shown only in warn/block/status/doctor contexts.
- `NO_COLOR` disables ANSI color.
- `TERM=dumb` or `CODEX_MINIMAL_OUTPUT=1` enables minimal summary mode and suppresses MOTD.
- `CODEX_SILENT=1` suppresses info/warn/debug and MOTD.

## PTY + Execution Behavior
- PTY capture is used only when stdin/stdout are TTYs.
- PTY backends:
  - `script` (preferred; auto-detects `-f`/`-F`/`-c` support)
  - Python `pty` fallback
  - direct execution fallback
- `CODEX_NO_PTY=1` disables PTY capture.
- PTY incompatibility auto-disables future PTY use by writing `~/.codex/.cdx_no_pty`.
- `CODEX_FORCE_PTY=1` ignores the auto-disable marker.
- Wrapper sets `PROMPT_TOOLKIT_NO_CPR=1` when needed to avoid CPR/TTY issues.

`--execute` behavior:
- Runs:
  - `codex --model gpt-5.3-codex --sandbox read-only -a untrusted exec --skip-git-repo-check --output-last-message <tmpfile> "<prompt>" ...`
- Prints only the last assistant message from the temp file.
- Forwards Codex exit code.

## Usage Reporting
- Wrapper parses every captured `Token usage:` line from run output (supports structured and key/value variants).
- Posted to `POST /usage` as one payload (`usages` array).
- Each entry may contain: `line`, `total`, `input`, `output`, `cached`, `reasoning`, optional `model`.
- On `/usage` failure with `line` present, wrapper retries once with `line` stripped.
- Exit footer reports:
  - `Run usage`
  - `Run cost` (uses response `data.cost` when present)
  - `Sync` (`usage` + `auth` push states)

## Update + Install Behavior
Codex updates:
- Target version comes from `/auth` `versions.client_version`.
- If `client_version_source=locked`, wrapper enforces exact target version (upgrade or downgrade).
- Update path:
  - npm global `codex-cli` update when detected, otherwise
  - GitHub release asset download/install for platform-specific binary.
- Linux prerequisite auto-install (`curl`, `unzip`, `script`) runs only when wrapper has root/passwordless sudo.
- macOS prerequisite auto-install uses Homebrew (`python3`, `curl`, `unzip`).

Wrapper updates:
- Target metadata comes from `/auth` versions (`wrapper_version`, `wrapper_sha256`, `wrapper_url`) with `/wrapper/download` fallback URL.
- Download uses host API key and optional baked CA; respects IPv4 forcing and insecure curl mode.
- If sha is provided, downloaded script must match.
- Successful wrapper update triggers one re-exec (`CODEX_WRAPPER_RESTARTED=1`, `CODEX_SKIP_MOTD=1`).
- Restart-loop detection aborts with error.

## Uninstall Behavior
`cdx --uninstall`:
- Calls `DELETE /auth?force=1` (best effort).
- Removes legacy sync env files:
  - `/usr/local/etc/codex-sync.env`
  - `/etc/codex-sync.env`
  - `~/.codex/sync.env`
- Removes per-user `~/.codex` (for known host users from `/host/users`; fallback current user if API call fails).
- Removes wrapper/Codex binaries in `/usr/local/bin` and `~/.local/bin`, plus `/opt/codex`.
- Removes npm global `codex-cli` when present.
- Safety stop: if other registered host users exist and wrapper cannot escalate (`root`/`sudo -n`), uninstall aborts.

## HTTP Endpoints Used By cdx
| Method | Path | Used for |
| --- | --- | --- |
| `POST` | `/auth` | Auth retrieve/store, versions/quota/runner metadata |
| `DELETE` | `/auth?force=1` | Uninstall deregistration |
| `POST` | `/sync/status` | Startup bundle status diff |
| `POST` | `/sync/bootstrap` | Startup bundle content fetch when update needed |
| `GET` | `/slash-commands` | Prompt list |
| `POST` | `/slash-commands/retrieve` | Prompt content fetch by sha |
| `POST` | `/slash-commands/store` | Prompt push |
| `GET` | `/skills` | Skill list |
| `POST` | `/skills/retrieve` | Skill manifest fetch by sha |
| `POST` | `/skills/store` | Skill push |
| `POST` | `/agents/retrieve` | AGENTS pull |
| `POST` | `/config/retrieve` | Config pull |
| `POST` | `/host/users` | Host user reporting |
| `POST` | `/host/lane` | Persist/clear lane preference |
| `POST` | `/usage` | Token usage ingest |
| `GET` | `/wrapper/download` | Wrapper self-update download |
| `GET` | `/versions` | Doctor API reachability probe |

## MCP Surface (Server Contract Relevant to cdx Config)
- `config/retrieve` injects managed MCP server entry when enabled:
  - `[mcp_servers.cdx]`
  - `url = "<base>/mcp"`
  - `http_headers = { Authorization = "Bearer <host_api_key>" }`
  - `startup_timeout_sec = 30`
- `/mcp` JSON-RPC protocol version: `2025-03-26`.
- Supported MCP methods include:
  - `initialize`
  - `tools/list`
  - `tools/call`
  - `resources/templates/list`
  - `resources/list`
  - `resources/read|create|update|delete`
- Tool namespaces exposed by `McpServer`:
  - `memory_*`
  - `fs_*`
  - `resource_*`
- Tool-name dot aliases are accepted (`name.with.dots` normalized to underscores).
- Host-authenticated REST memory endpoints also exist under `/mcp/memories/*`.

## Unknown / Not Found In Code
- Legacy helper `migrate-sqlite-to-mysql.php`: Unknown / not found in code.
- Startup bundle fields beyond prompt/skill/agents/config/auth structures consumed by wrapper: Unknown / not found in wrapper contract (ignored by current parser).
