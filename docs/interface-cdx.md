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
- `CODEX_INSTALLATION_ID`
- `CODEX_SILENT`
- `CODEX_SYNC_ALLOW_INSECURE`
- Optional host model defaults: `CODEX_HOST_MODEL`, `CODEX_HOST_REASONING_EFFORT`

Guardrails:
- Wrapper enforces baked FQDN at runtime. Override only with `CODEX_ALLOW_FQDN_MISMATCH=1`.
- `load_sync_config` uses baked config only; it does not read local sync env files.

## Startup Sequence
1. Resolve real `codex` binary (`/usr/local/bin/codex`, `/opt/codex/bin/codex`, or `PATH`); abort if none found.
2. Help-only Codex invocations are passed straight through to the real binary before any wrapper sync/update/MOTD/footer work. Supported passthrough forms are top-level `--help`, top-level `-h`, top-level `help`, and Codex subcommand help where a reserved Codex command is followed by `--help` or `-h`.
3. Acquire per-user run lock with `flock` (`/tmp` or `/var/tmp`) unless `--allow-concurrent-sync`.
4. Sync auth via `POST /auth`.
5. Startup bundle pull via `POST /sync/status` and (when needed) `POST /sync/bootstrap`.
6. If bundle pull fails, fallback pulls run: AGENTS, config.
7. Compute local auth freshness:
   - fresh window: `24h` (`MAX_LOCAL_AUTH_AGE_SECONDS`)
   - secure-host recent window: `7d` (`MAX_LOCAL_AUTH_RECENT_SECONDS`)
8. Check/update Codex + wrapper.
9. Render boot summary and enforce launch gates. Human-facing wrapper headers keep the `codex orchestrator` branding and currently include the tagline `Codex to Brrr!`. When the mirrored admin theme preference is `auto-pink`, `bright-pink`, or `dark-pink`, the ASCII banner switches from orange to pink. No-op helper paths must not abort launch here: empty OTel exports and unchanged logical/physical cwd trust writes both return success under `set -e`.
10. Launch Codex (unless status/doctor/lane-only path exits first).
11. Cleanup trap: auth push, usage push, insecure-host auth purge (when applicable), lock release.

Concurrent-run guard behavior (`active cdx run detected`):
- Skips pre-run mutating sync/update operations.
- Still performs read-only auth retrieve (`CODEX_SYNC_READ_ONLY=1`) for policy/quota metadata.
- Requires valid local auth to proceed.
- Still performs post-run auth/usage upload.
- Skips insecure-host post-run `auth.json` purge in this path.
- Surfaces in the compact `Concurrent` summary row instead of a separate pre-run warning line.
- Successful concurrent launches do not emit an extra pre-launch warning line.

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
  - approval pending returns 423; wrapper renders one framed terminal status box, tells the operator to open Admin and click `Enable window`, and refreshes that same box in place every 5 seconds with `last check` and `checks` metadata while waiting.
  - approval denied blocks launch.
- Installation ID mismatches block sync.

## CLI Surface
Help passthrough:
- `cdx --help`, `cdx -h`, `cdx help`, and Codex subcommand help invocations (for example `cdx exec --help`) are passed directly to the real Codex binary and print only upstream help text.
- In that path the wrapper skips run-lock acquisition, auth/config sync, update checks, MOTD/summary rendering, and the post-run footer.

| Command | Behavior |
| --- | --- |
| `cdx --wrapper-version` / `cdx -W` | Print wrapper version and exit. |
| `cdx status` / `cdx --status` | Run sync/update checks + summary, do not launch Codex. Exit `0` unless red/error state (`1`). |
| `cdx doctor` / `cdx --doctor` | Run status checks plus diagnostics (deps, auth freshness, sync states, `/versions` probe, SSH terminal hints). Exit non-zero on critical failures/red state. |
| `cdx --update` / `cdx -U` | Force wrapper update attempt from server and exit immediately after the attempt. |
| `cdx --uninstall` | Deregister host auth and remove Codex/wrapper artifacts. |
| `cdx -4` | Force IPv4 for wrapper-managed network calls and Codex child outbound traffic for this invocation. |
| `cdx --allow-concurrent-sync` | Bypass active-run lock for this invocation. |
| `cdx --debug` / `cdx --verbose` | Enable wrapper debug logs. |
| `cdx --execute "<prompt>" [codex args...]` | Run a one-shot non-interactive `codex exec` after the normal wrapper boot/sync/auth/update gates, with wrapper defaults (`--sandbox read-only`, `-a untrusted`) and normal lane/profile/model selector behavior. |
| `cdx ls [--persist] [-- <codex args...>]` | Shorthand for `cdx lane spark`; supports the same persistence and passthrough behavior. |

Lane subcommand:
- `cdx lane` prints effective lane/source/persisted preference and exits.
- `cdx lane normal|spark [--persist] [-- <codex args...>]` sets one-shot lane and launches Codex.
- `cdx ls [--persist] [-- <codex args...>]` is shorthand for `cdx lane spark`.
- `cdx lane clear --persist` clears persisted lane and exits (no passthrough args allowed).
- `--persist` writes lane preference through `POST /host/lane`.
- If lane profile exists in config (`[profiles.normal]`/`[profiles.spark]`), wrapper injects `--profile`.
- If lane profile is missing, wrapper injects model fallback:
  - `normal` -> `gpt-5.3-codex`
  - `spark` -> `gpt-5.3-codex-spark`
- When the effective model resolves to `gpt-5.3-codex-spark` (lane/host injection, explicit `--model`, selected `--profile` model, or top-level default `model` in `~/.codex/config.toml`), wrapper injects `--config model_reasoning_summary=none`; if an explicit profile is active it also injects `--config profiles.<profile>.model_reasoning_summary=none` so legacy profile-level summaries cannot leak through.
- `cdx lane spark -- --execute "<prompt>"` applies the same spark summary guards in execute mode; if profile `spark` exists it uses `--profile spark` plus both root/profile summary overrides, otherwise it falls back to `--model gpt-5.3-codex-spark`.
- Execute passthrough Spark selectors also force summary guards: `cdx --execute "<prompt>" --model gpt-5.3-codex-spark` injects `--config model_reasoning_summary=none`, and `--profile <name>` does the same when that profile resolves to Spark (including profiles that inherit a Spark root default model); profile-scoped summary keys are overridden via `profiles.<name>.model_reasoning_summary=none`.

Profile shorthand:
- `cdx <name> [args...]` maps to `--profile <name>` when `[profiles.<name>]` exists.
- Reserved commands are never treated as profile shorthand:
  - `exec`, `review`, `login`, `logout`, `mcp`, `mcp-server`, `app-server`, `completion`, `sandbox`, `debug`, `apply`, `resume`, `fork`, `cloud`, `features`, `help`.

## Synced Local State
| Resource | Pull | Push | Local path |
| --- | --- | --- | --- |
| Skills | MCP `resource_read` / `resources/read` | None | No synced local skill file; hosts read canonical manifests from `skill://{slug}` |
| AGENTS | `POST /agents/retrieve` | None | `~/.codex/AGENTS.md` (server auto-seeds canonical storage from the checked-in repo `AGENTS.md` on boot; served content may append managed Skills and Memories inventory blocks when MCP is enabled and host/runtime data exists, with missing memory summaries lazily backfilled on retrieval when the runner is available) |
| Config | `POST /config/retrieve` | None | `~/.codex/config.toml` |

Sync details:
- Startup bundle path (`/sync/status` + `/sync/bootstrap`) applies AGENTS and config in one pass.
- Wrapper falls back to per-resource AGENTS/config pulls if bundle path fails or endpoints are missing.
- Wrapper removes legacy prompt directories and prompt baselines on startup so stale local prompt state does not linger after the custom-prompt system was removed.
- Wrapper removes legacy local skill directories and baselines on upgrade so stale `~/.agents/skills` / `~/.codex/skills` trees stop shadowing MCP-first behavior.
- `status:missing` from AGENTS/config retrieval deletes local file.
- Wrapper includes `username` + `home` when retrieving config so server can bake per-user trusted project settings.
- Before launching Codex, wrapper also force-marks the current working directory (and `pwd -P` path when different) as `trust_level = "trusted"` in local `~/.codex/config.toml` to suppress interactive trust prompts.
- Pre-launch helpers are no-op safe: an empty OTel export set or an unchanged trust target must not terminate `cdx`.
- Atomic writes (temp + `fsync` + replace) are used for auth, AGENTS, and config files.

## Config Bake Rules (`/config/retrieve`)
- Response statuses: `updated`, `unchanged`, `missing`.
- Response includes `sha256` (baked), `base_sha256` (stored canonical), `updated_at`, `size_bytes`.
- `content` is returned only when status is `updated`.
- When status is `missing`, wrapper deletes local `~/.codex/config.toml`.
- Server applies host model overrides before baking config.
- Managed MCP auth stays as the host API key on secure hosts.
- Managed MCP auth is replaced with a short-lived bearer on insecure hosts, so `config.toml` does not keep a reusable coordinator credential on disk after the run.
- Supported override models:
  - `gpt-5.4`
  - `gpt-5.4-mini`
  - `gpt-5.3-codex`
  - `gpt-5.3-codex-spark`
  - `gpt-5.2-codex`
  - `gpt-5.2`
  - `gpt-5.1-codex-max`
  - `gpt-5.1-codex-mini`
- Supported reasoning effort values: `low|medium|high|xhigh`.
- `gpt-5.4` accepts `low|medium|high|xhigh`.
- `gpt-5.4-mini` accepts `low|medium|high|xhigh`.
- `gpt-5.1-codex-mini` accepts only `medium|high`.
- Root `personality` accepts `friendly|pragmatic|none` and defaults to `friendly`; profiles may optionally override it.
- Normalization defaults include `features.apps=true` and `features.multi_agent=true` when unset.
- Builder defaults keep `features.guardian_approval=false`, `features.js_repl=false`, `features.tui_app_server=false`, and `features.prevent_idle_sleep=false` unless explicitly enabled.
- `features.guardian_approval` enables automatic review of `on-request` approval prompts by a security reviewer subagent instead of blocking on direct user input.
- `features.js_repl` enables the persistent Node-backed JavaScript REPL and requires Node `>= v22.22.0` on the host.
- `features.tui_app_server` enables the app-server-backed TUI implementation.
- `features.prevent_idle_sleep` keeps the computer awake while Codex is running a thread.
- Normalization defaults include notice migration mappings `gpt-5.2-codex -> gpt-5.3-codex` and `gpt-5.3-codex -> gpt-5.4`.
- Feature flags are normalized against the current Codex feature registry; unknown/removed flags are dropped from rendered output.
- Removed legacy keys `steer`, `collaboration_modes`, `elevated_windows_sandbox`, `experimental_windows_sandbox`, `enable_experimental_windows_sandbox`, `remote_models`, `request_permissions`, `request_rule`, `responses_websockets`, `responses_websockets_v2`, `search_tool`, `sqlite`, and `use_linux_sandbox_bwrap` are accepted for ingest compatibility but dropped from rendered output.
- When `home` is provided, server appends trusted project stanza for that path.

## Quota, Lane, and Summary Rendering
Inputs consumed from auth/sync responses:
- `quota_hard_fail`, `quota_limit_percent`, `quota_week_partition`, `cdx_silent`, `admin_theme`
- `auto_update_enabled`
- `chatgpt_usage` windows and `active_quota_lane`
- Runner telemetry (`runner_state`, `runner_last_ok`, `runner_last_fail`, `runner_last_check`)
- Host usage (`api_calls`, monthly token totals)

Wrapper quota behavior:
- `QUOTA_LIMIT_PERCENT` is clamped to `50..100`.
- `QUOTA_WEEK_PARTITION` is normalized to `0|5|7`.
- Hard fail mode blocks launch at/above threshold.
- Warn mode logs warning but continues.
- Weekly quota rows keep the existing linear projection and, when that projection reaches `100%` before the weekly reset, append a parenthetical hit estimate in the note text: `(hits 100 in ~<duration>, before reset)`.

Summary layout:
- Sections: `Health`, `Versions`, `Usage`, `Quota`, `Result`.
- When Codex auto-update checks are skipped, the `Versions` section reports the concrete reason: `active cdx run`, `cron-managed updates`, `unsupported platform (...)`, or, for genuine privilege skips, `need root; uid ...` with the wrapper-detected UID to make namespace/user mismatches visible.
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

## Execution Behavior
- When stdin and stdout are TTYs, Codex is launched with direct terminal ownership (no intermediate PTY capture).
- When stdout is not a TTY (pipe mode), Codex output is captured via `tee` for token usage extraction.
- Non-TTY interactive launch (no args, no terminal) fails with guidance to use `--execute`.
- Interactive SSH sessions only force `--no-alt-screen` by default for older Codex builds. On `codex 0.117.0+`, alt-screen stays enabled unless you explicitly set `CODEX_SSH_ALT_SCREEN=1`; set `CODEX_SSH_ALT_SCREEN=0` to force fullscreen alt-screen mode on any version.
- `PROMPT_TOOLKIT_NO_CPR=1` is set automatically when stdin or stdout is not a TTY.
`--execute` behavior:
- `--execute` is parsed early but launched from the normal run path, so auth/config sync still runs before Codex starts.
- Runs:
  - `codex [lane/profile/model selectors + passthrough args] --sandbox read-only -a untrusted exec --skip-git-repo-check "<prompt>"`
- Streams normal Codex output (plus wrapper summary/footer behavior for that run).
- Forwards Codex exit code.

## Usage Reporting
- TTY sessions (direct exec) extract token usage from `~/.codex/sessions/.../*.jsonl` files, discovered by mtime and scoped to the current run's start time.
- Non-TTY (pipe) sessions first try the captured output log for a `Token usage:` line or `session id:` reference, then fall back to JSONL session discovery.
- Both paths parse structured `token_count` and `turn.completed` events for full breakdown (`total`, `input`, `output`, `cached`, `reasoning`).
- Posted to `POST /usage` as one payload (`usages` array).
- `/usage` upload is explicitly best effort: the wrapper keeps roughly a 3-second total request budget across SSL-context attempts, and only retries the stripped-line fallback for quick payload-shape failures instead of slow/time-out network failures.
- Each entry may contain: `line`, `total`, `input`, `output`, `cached`, `reasoning`, optional `model`.
- On retryable non-timeout `/usage` failures with `line` present, wrapper retries once with `line` stripped.
- Exit footer reports for non-empty runs:
  - `Run usage`
  - `Run cost` (uses response `data.cost` when present; remains unavailable when the client only reported total tokens without input/output/cached breakdown)
  - `Sync` (`usage` + `auth` push states)
- Empty runs with no captured token usage skip the exit footer entirely.

## Update + Install Behavior
Codex updates:
- Target version comes from `/auth` `versions.client_version`.
- If `/auth` returns `client_version_enforce_exact=true`, wrapper enforces the exact target version (upgrade or downgrade).
- If `client_version_enforce_exact=false`, wrapper treats `versions.client_version` as an upgrade floor only and never downgrades to meet it.
- If `/auth` returns `auto_update_enabled=true`, wrapper first ensures the managed `cdx --cron` job is installed for the current user. Once the cron job is in place, wrapper skips the normal per-run Codex update check because cron-managed auto-update is authoritative for that host. If cron installation fails, wrapper falls back to the normal startup Codex update probe instead of silently disabling updates.
- Update path:
  - npm global `codex-cli` update when detected, otherwise
  - GitHub release asset download/install for platform-specific binary.
- GitHub release-asset installs require a trusted SHA-256 digest from the GitHub release metadata and abort when the digest is missing or mismatched.
- Cron auto-update install/remove uses one managed crontab marker, shell-escaped wrapper/log paths, and escapes cron `%` semantics before writing the cron command.
- A fresh `cdx --cron install` immediately pings `POST /cron/check` once after writing the managed crontab entry so the server records an initial cron check-in without waiting for the first scheduled minute.
- Normal sync-capable wrapper runs reconcile cron state to match policy: enabled ensures the managed cron entry exists, disabled removes that managed entry.
- `cdx --cron remove` removes only the managed/current-wrapper cron entry instead of broad `cdx --cron` substring matches.
- Cron mode uses a non-blocking `flock` guard when available and degrades with a warning when `flock` is missing.
- Cron update checks call `POST /cron/check`; the response keeps the legacy top-level Codex action and adds a nested wrapper action block.
- When cron sees `wrapper.action:"update"`, it downloads `/wrapper/download`, verifies the reported SHA-256, installs the new wrapper over itself, and re-execs once back into `cdx --cron` before evaluating any Codex update.
- Successful cron-installed Codex updates report back through `POST /cron/report` with both the post-update Codex version and the current wrapper version.
- Cron HTTPS probes build the same relaxed SSL context chain as the other wrapper sync paths: optional baked CA, `VERIFY_X509_STRICT` fallback disable when available, and insecure mode only when the host was explicitly baked with `curl_insecure` / `CODEX_SYNC_ALLOW_INSECURE=1`.
- When a specific platform asset name is requested during release resolution, wrapper update paths fail closed if that exact asset is missing; generic `codex` fallback is only allowed when no explicit asset name was requested.
- After a checksum-verified cron update installs successfully, report submission is retried and a persistent report failure exits non-zero so operators can see the incomplete rollout.
- Linux prerequisite auto-install hard-requires `curl` and `unzip`; `bwrap`/Bubblewrap is best-effort only and never blocks launch because Codex can fall back to its vendored sandbox helper.
- `cdx --update` is treated as a recovery path: before self-update it requires only `curl`, so stale wrappers can still replace themselves even when optional prerequisites or package mappings are broken locally.
- macOS prerequisite auto-install uses Homebrew (`python3`, `curl`, `unzip`).
- `cdx doctor` reports SSH session/terminal env hints alongside the local Codex CLI version and SSH launch mode.

Installer behavior:
- Installer script downloads the server-targeted Codex version by default.
- SSH compatibility is handled at wrapper runtime; the installer does not pin or rewrite the requested Codex version.

Wrapper updates:
- Target metadata comes from `/auth` versions (`wrapper_version`, `wrapper_sha256`, `wrapper_url`) with `/wrapper/download` fallback URL.
- Download uses host API key and optional baked CA; respects IPv4 forcing and insecure curl mode.
- Self-update decision is mismatch-driven: the wrapper only treats the target as update-needed when version or baked SHA actually differ, and stays `current` when both already match.
- If sha is provided, downloaded script must match.
- When a wrapper version update is pending and the run will self-restart, Codex binary update is deferred to the restarted pass so one invocation does not install two different Codex versions back-to-back.
- Successful wrapper update triggers one re-exec (`CODEX_WRAPPER_RESTARTED=1`, `CODEX_SKIP_MOTD=1`) using the startup-snapshotted original argv/argc, with a no-arg fallback so Bash 4.2 / CentOS 7 `set -u` shells do not trip on empty-array expansion.
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
| `POST` | `/cron/check` | Cron auto-update action probe |
| `POST` | `/cron/report` | Cron auto-update success report |

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
  - `resource_*`
- MCP resource families exposed by `McpServer`:
  - `memory://{id}`
  - `skill://{slug}`
- When the Projects module is enabled, `McpServer` also exposes `project_*` tools plus the `project://{slug}` resource template/resource family used by the managed `coco` skill.
- Host-authenticated `/mcp` does not expose coordinator filesystem `fs_*` tools; those helpers remain internal/operator-only.
- Tool-name dot aliases are accepted (`name.with.dots` normalized to underscores).
- Host-authenticated REST memory endpoints also exist under `/mcp/memories/*`; stored memory payloads now carry an optional runner-generated `summary` used for the served AGENTS memory inventory. These memories remain host-scoped and reserved `coco*` ids are rejected so cross-server CoCo handoffs stay project-only.
- The wrapper does not have a separate project-state startup sync path; shared project context is fetched live through `/mcp` or `/projects*` when agents actually need it.

## Unknown / Not Found In Code
- Legacy helper `migrate-sqlite-to-mysql.php`: Unknown / not found in code.
- Startup bundle fields beyond prompt/skill/agents/config/auth structures consumed by wrapper: Unknown / not found in wrapper contract (ignored by current parser).
