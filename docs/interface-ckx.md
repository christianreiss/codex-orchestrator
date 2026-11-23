# ckx — Kimi Code fleet wrapper

From cxx 0.9.183, the shared model selector offers `d` to save the Kimi model and reasoning effort together as its central fleet default without leaving the selector. Models with no effort send explicit `null`; the existing context-window setting is preserved. Any active Kimi-assigned host may save; host overrides retain precedence. See `docs/interface-cdx.md` for save states and offline behavior.

From cxx 0.9.180, `cxx doctor` checks the local PATH commands without loading
signed config, contacting the API or starting background services. Its report
states that scope and points to the installed `cdx`/`clx`/`cgx`/`ckx doctor`
(all four when none is on PATH) for API reachability, TLS trust and sync, which
the engine-neutral check does not cover. Use
`cxx doctor --fix` to repair recognized legacy transition scripts when a stale
`cdx`, `clx`, `cgx` or `ckx` fails with HTTP 401 despite a current `cxx`.
Both historical `INSTALL_MODE=shim` and `INSTALL_CONTEXT=transition` formats
are recognized. Update, cron and startup alias reconciliation publish `cxx`
before migrating scripts, including when the binary is already current.
Repair replaces a recognized script only when its sibling `cxx` targets the
running installation; custom launchers and other installations are preserved.
The full engine doctor includes a Launchers row and suggests the local repair.
Run `cxx codex|claude|grok|kimi doctor` for full engine diagnostics.

Kimi is the fourth engine (`kimi`). The wrapper persona is `ckx` (relative
alias of the one `cxx` binary, like `cdx`, `clx` and `cgx`); the managed native
command is `kimi`. The supported CLI is **Kimi Code CLI** (MoonshotAI
`kimi-code`, TypeScript, shipped as a native binary). The archived Python
`kimi-cli` (PyPI, `~/.kimi`) is not supported and is never installed.

Grok (`docs/interface-cgx.md`) is the structural template: Kimi uses the same
server-owned subscription refresh with access-only host projections, native
on-disk Skills, a private managed home and server-polled usage. The
differences are listed under *Intentional deltas*.

## Contract (verified against merged code 2026-11-12)

### Identity

| Item | Value |
|---|---|
| Engine id / constant | `kimi` / `ENGINE_KIMI` (`api/src/util/engine.ts`), `config.EngineKimi` (Go) |
| Label | `Kimi Code` |
| Wrapper persona / alias | `ckx` (versioned `ckx-x.y.z`); `cxx kimi …` |
| Native command / PATH shim | `kimi` → `~/.cxx/native-bin/kimi` → `cxx native kimi -- …` |
| Gateway key prefix | `sk-ckx-` |
| Gateway surface | `/kimi/v1` (OpenAI-shaped). `versions.kimi_api_disabled` is seeded `1` (off): Kimi's terms for subscription-backed third-party gateways are unclear, so the operator opts in |
| Agents document state id | `4` (codex 1, claude 2, grok 3) |
| Receiver protocol id | `kimi-hooks-v1` |
| Activity source | `kimi-hooks` |
| Wrapper config file / env | `ckx.json`, `CKX_CONFIG_PATH`; env prefix `CKX_`; binary override `CKX_KIMI_BIN` |
| Terminal theme colour | amber (`#f59e0b` family); frontend token `--persona-kimi` |

### Native model capabilities (verified 2026-11-17)

The fleet registry owns explicit `kimiCapabilities` and effort metadata; the
renderer transports them into each managed native model entry. Kimi 2.6.2/2.6.3
otherwise resolves missing capabilities as no thinking or media support, so a
configured `max` effort alone can silently become `off`.

Per the [official model table](https://www.kimi.com/code/docs/en/kimi-code/models.html),
both K3.1 Pro models require thinking; the other models allow it to be disabled.
All six accept images, while `k3-256k` alone lacks video input. Coding Highspeed
supports thinking without adjustable effort: its fleet effort list is empty,
its default is null, and obsolete low/high/max settings are removed from rendered
native defaults. The other five retain their existing fleet effort defaults and
all model tiers remain unchanged. These declarations do not verify account or
plan entitlement, nor raise the fleet's configured context limits.

**Open operator decision (recorded 2026-11-20, unchanged):** the official model
table and its effort-mapping section name the provider default effort `high` for
K3.1 Pro, K3.1 Pro Highspeed, K3 and K3 256K, and `max` for `kimi-for-coding`
(K2.8 Preview). The fleet registry, which is rendered as native `default_effort`,
keeps the inverse (`max` and `high`). The table also lists up to 1,048,576
context tokens for `kimi-for-coding`, while the fleet caps it at 262,144. Neither
value was changed without an account catalog or an operator ruling. See
[the 2026-11-20 audit](reports/engine-maintenance.md#kimi-code).

New writes through both generic config preview/store and model defaults reject
unsupported efforts with 422. Structured `reasoning_effort` accepts the selected
model's adjustable levels. Native `thinking.effort` accepts those levels plus
`on`/`off`, which are transported unchanged; `thinking.enabled` is preserved.
Pro's native thinking-only rule still prevents disabling thinking. Conflicting
structured/native effort controls are rejected on new writes. The defaults API
replaces an earlier native effort when explicitly editing the structured control.
Without an explicit host effort, host rendering preserves native defaults.

Stored reads heal only known obsolete Highspeed levels and retain historical
structured precedence for old conflicting controls in the projection. Other
invalid effort values remain visible for correction with `validation_error`;
historical body, hash and authored JSON are never rewritten by a read.

Custom aliases and explicit native `models.<alias>.overrides` survive rendering.
Overrides retain native precedence, including capability and effort overrides.
Offline tests execute the pinned upstream catalog/thinking functions against
rendered model records, covering real effort resolution and media flags; source
digests and license are recorded in `api/test/fixtures/kimi-native-2.6/`.

### Database (migration `0130_kimi_engine.sql`, baseline and `schema.ts` in the same commit)

- `hosts`: `kimi_client_version VARCHAR(64)`, `kimi_client_version_override VARCHAR(64)`,
  `kimi_wrapper_version VARCHAR(64)`, `kimi_auth_digest VARCHAR(128)`,
  `kimi_model_override VARCHAR(128)`, `kimi_reasoning_effort_override VARCHAR(32)`,
  `kimi_last_refresh VARCHAR(100)` — all NULL, same shape as the `grok_*` columns.
- `kimi_auth_refresh_state`: identical columns to `grok_auth_refresh_state`.
- `kimi_usage_snapshots` (PK `account_id`): `plan_name VARCHAR(128)`,
  `plan_fetched_at`, `plan_error_code VARCHAR(48)`,
  `five_hour_used_percent DOUBLE`, `five_hour_resets_at`,
  `weekly_used_percent DOUBLE`, `weekly_resets_at`,
  `month_total_used_percent DOUBLE`, `month_total_resets_at`,
  `month_code_used_percent DOUBLE`, `month_code_resets_at`,
  `extra_usage_json TEXT`, `fetched_at`, `checked_at NOT NULL`,
  `error_code VARCHAR(48)` (timestamps `VARCHAR(100)`).
- `versions` seed rows: `api_surface_backend_kimi = kimi`, `kimi_api_disabled = 1`.
- Code-created `versions` keys: `kimi_engine_disabled`, `kimi_models_disabled`,
  `kimi_default_model`, `client_version_kimi`, `client_version_lock_kimi`,
  `wrapper_version_kimi`, `wrapper_sha256_kimi`, `wrapper_url_kimi`, runner state
  `*_kimi`, `kimi_engine_destroy`, `owner_engine_actor_kimi`.

### Canonical auth payload (server-side, secretbox-encrypted)

```json
{
  "kimi_code": {
    "access_token": "…", "refresh_token": "…",
    "expires_at": 1762950000, "expires_in": 900,
    "scope": "kimi-code", "token_type": "Bearer"
  },
  "device_id": "<as minted in the seeding login's KIMI_CODE_HOME/device_id>",
  "oauth_host": "https://auth.kimi.com",
  "base_url": "https://api.kimi.com/coding/v1",
  "last_refresh": "RFC3339"
}
```

- Both official regions are supported: `auth.kimi.com` + `api.kimi.com/coding/v1`
  (default) and `auth.kimi.ai` + `api.kimi.ai/coding/v1` (global). Any other
  endpoint pair is rejected with `kimi_endpoint_unsupported`. kimi-code derives
  a scoped credential key for every endpoint except the default one
  (`resolveKimiCodeRuntimeAuth`: `oauth/kimi-code-env-<sha256(JSON.stringify({oauthHost,baseUrl}))[:16]>`),
  so for the global region the wrapper and runner write the identical
  access-only projection both as `credentials/kimi-code.json` and under the
  scoped key, and the provider's `oauth.key` names the scoped key. For the
  supported `.ai` pair it is exactly
  `oauth/kimi-code-env-0e4f99c69cc27850`, stored as
  `credentials/kimi-code-env-0e4f99c69cc27850.json`.
- `device_id` is stored as minted by kimi-code (`identity.ts`, a UUID); refresh
  sends `X-Msh-Platform: kimi_code_cli`.
- Seeding always uses a dedicated device login in a throwaway `KIMI_CODE_HOME`
  (`ckx login` / seed script), then uploads `credentials/kimi-code.json` plus
  `device_id`. The seeding home is deleted afterwards so exactly one refresher
  (the server) holds the refresh token.
- Refresh (server only, `kimi-auth-owner`): `POST {oauth_host}/api/oauth/token`,
  form `client_id=17e5f671-d194-4dfb-9706-5516cb48c098&grant_type=refresh_token&refresh_token=…`,
  headers `X-Msh-Platform: kimi_code_cli`, `X-Msh-Version`, `X-Msh-Device-Id: <device_id>`,
  `X-Msh-Device-Name`, `X-Msh-Device-Model`, `X-Msh-Os-Version`. The response
  rotates the refresh token (a response without `refresh_token` is an error).
  The owner refreshes when fewer than `max(300 s, expires_in/2)` remain, fenced
  by `kimi_auth_refresh_state` exactly like Grok.
- Host projection (served by `/auth` retrieve and the communicator) drops the
  refresh token and pins expiry to zero:
  `{"access_token":"…","refresh_token":"","expires_at":0,"expires_in":0,"scope":"kimi-code","token_type":"Bearer"}`
  plus `device_id`. Verified against kimi-code 2.5.3 source and binary:
  `expires_at == 0` means the CLI never refreshes on its own and re-reads the
  file on every request; on a 401 it fails with "has no refresh_token;
  re-login required" without tombstoning the file. The wrapper rewrites
  `credentials/kimi-code.json` whenever the canonical access token changes.

### Host files (private managed home, `KIMI_CODE_HOME`)

| File | Owner | Content |
|---|---|---|
| `config.toml` | fleet-owned paths, user keys preserved | `default_model`, `default_permission_mode` (`manual`/`yolo`/`auto`), `telemetry=false`, `auto_session_title=false`, `disable_feedback_survey=true`, `[providers."managed:kimi-code"]` (`type="kimi"`, `base_url`, `oauth={storage="file",key="oauth/kimi-code"}`), `[models."kimi-code/<id>"]`, `[thinking] effort`, `[[hooks]]` for the receiver |
| `credentials/kimi-code.json` (0600) | wrapper | access-only projection above |
| `device_id` (0600) | wrapper | canonical `device_id` |
| `AGENTS.md` | wrapper | private per-launch copy of fleet instructions plus the current launch identity (digest in `~/.ckx/state`, the Kimi state dir mirroring Grok's `~/.cgx/state`) |
| `skills/` | wrapper (`skillstore`) | native fleet Skills (`kimi_skills` bundle field, `/skills?engine=kimi`) |
| `mcp.json` | wrapper | `{"mcpServers":{…}}` with the fleet MCP and `cxx-agent` |

Process environment for every managed start: `KIMI_CODE_HOME=<private home>`,
`KIMI_DISABLE_TELEMETRY=1`, `KIMI_CODE_NO_AUTO_UPDATE=1`.

### Host config (signed `/wrapper/v2/config`)

- Engine enums gain `kimi`; options gain `kimi_model_override` and
  `kimi_reasoning_effort_override` (`low|high|max` for models with adjustable
  effort; Coding Highspeed has none).
- Sync bundle field `kimi_skills` (same item shape as `grok_skills`).

### CLI installation

`https://code.kimi.com/kimi-code/binaries/<version>/manifest.json` →
`platforms["<os>-<arch>"]` (`linux-x64`, `linux-arm64`, `darwin-x64`,
`darwin-arm64`) `.filename` and `.checksum` (sha256 hex). Download
`…/binaries/<version>/<filename>` (bare binary; the host redirects to
`cdn.kimi.com`), verify sha256, install to `~/.cxx/engines/kimi/<version>/kimi`,
probe `kimi --version`, prune with `enginestore`. Latest pointer:
`https://code.kimi.com/kimi-code/latest` (plain text); it returned `2.7.2` on
2026-11-20. Unlocked hosts (`client_version_kimi=latest`) resolve the target
through that pointer (`client-versions.ts`), so they install the current stable
release on the next `ckx update`. The `2.5.3` constants (`PinnedVersion` in the
wrapper, `KIMI_MIN_CLIENT_VERSION` in `kimi-auth.ts`) are only the first-launch
install version and the wrapper/API floor, not the version fleet hosts run; the
API constant also doubles as the `X-Msh-Version` header, so it deliberately
stays. No Node runtime is required.

During `ckx update` and scheduled maintenance, `/cron/check` can omit
the native target when it returns `no_update`. The wrapper retains a supported
installed version and uses its minimum only to repair a missing or unsupported
CLI. An explicit `update` needs a concrete target. A lower supported version
can be selected by an exact pin. A disabled update or an operator-supplied
binary path skips native installation.

### Usage and quota

Server-side, per account: `GET {base_url}/usages` with
`Authorization: Bearer <canonical access token>`. Response
`{usages:{limit_5h,limit_7d,limit_month_total,limit_month_code:{used_ratio,reset_time}}, …}`
(`limit_7d` exists only on legacy plans). The 5 h window is the short quota
window and the 7 d window the long one, so Kimi takes part in quota
observation, `quota_get`, warnings and hard-fail like Codex and Claude.

### Native argument boundaries (verified against 2.7.2)

The wrapper keeps values opaque at the scope where the native parser reads them,
including `provider catalog list --filter/--url` and `provider catalog add
--api-key/--default-model/--base-url/--url`. Command- or flag-shaped values do not
become a managed sign-in, resume, help, model or permission instruction.
Hidden native `-r`/`--resume [id]` aliases select a session, and `-C` means
continue, not change directory. Native `--yes` and `--auto-approve` alias
Ask When Needed (`--yolo`), not Never Ask (`--auto`).

Kimi 2.7.x hides the `server` command (absent from root help) but keeps the full
`web` option set on it (`--port`, optional `--host [host]`, variadic
`--allowed-host <host...>`, `--log-level`, `--web-title`, `--rc/--remote-control`,
`--open`, `--json`, ...) with children `rotate-token`, `kill` and the hidden
internal `ensure-daemon [--probe]`; `web` gained `--json`; `install-app` is a
hidden command. The scoped tables follow those arities, so values spelled like a
command or flag (`-p server`, `--web-title server`, `server --web-title kill`)
stay values. `server`, `web`, `rc`/`remote` and `app` stay refused by command
name.

Native `exec-server` (including `--listen stdio`), remote environment selection
with `--environment`/`--environment-cwd`, and the native-only
`__plugin_run_node`/`__update_download` helper processes are refused before
configuration or account admission. These independent processes do not inherit
the proven managed auth, receiver and teardown lifecycle. Native `--help`
remains available; recognized helpers are never started as managed sessions.
Ordinary native `upgrade`/`update` remains owned by `ckx update`. Kimi Code 2.5.3
and 2.7.2 report bare `setup` and `install` as unknown commands. The wrapper
passes those words through, including when they are values for `--prompt`.

The checked-in help snapshot records actual 2.7.2 output (binary SHA-256
`7f82148d26467874400d19ee8d23ead13cece9cd0c17648a5622cae480a5a596`, verified
against the CDN manifest 2026-11-20) plus separately labeled hidden option and
command evidence (`hidden_source_options`, `hidden_source_commands`) from tag
`56145f849caa305d42acd09b67fb65d11146f887`.
`NATIVE_KIMI_ORACLE` enables a safe live-help comparison in the Go suite; neither
the snapshot nor that probe proves a live account's model entitlement.

### Non-interactive use (runner, host daemon, Wake)

`kimi -p "<prompt>" --output-format stream-json [-m <alias>] [-S <session>]`.
Prompt mode already runs in Never Ask mode: 2.5.3 rejects `-p` combined with
`--auto` (`Cannot combine --prompt with --auto.`), so headless starts never pass
`--auto`/`--yolo`. The prompt travels as argv (no prompt-file option). Its ceiling is **100000
UTF-8 bytes**, not characters: the server (`assertHeadlessPrompt`, daemon/Wake
admission), wrapper worker/daemon (`validateKimiPrompt`) and gateway adapter
(`assertRunnerPrompt`) reject over-limit content before native execution.
A 25000-emoji prompt is exactly 100000 bytes; 25001 is rejected. Kimi 2.5.3 also rejects `-p` with `--plan`. The server returns
`422 permission_mode_engine_unsupported` for daemon plan starts; wrappers reject
stored Kimi plan operations before execution, never dropping the constraint.

Native session ids have the form `session_<UUID>` (keep the prefix everywhere:
resume `-S session_<UUID>`, transcript checks, server native-id validation).
Store layout: `$KIMI_CODE_HOME/sessions/wd_<cwd-slug>_<sha12>/session_<UUID>/state.json`
plus `agents/main/wire.jsonl`. The final stream-json `meta` event
`session.resume_hint` carries `session_id` and the resume command. stream-json
reports no token usage and no stop reason. Hook stdin `prompt` is an array of
content parts (`[{"type":"text","text":"…"}]`), not a string. (Verified with
2.5.3 against a mock provider, 2026-11-12.)
Exit 1 with a one-line `error:` on stderr on failure. stdout begins with
`{"role":"meta","type":"system.version","version":"…"}`.

### Per-launch identity

`agentportal.AppendKimiIdentityArgs` writes the current launch identity into
`AGENTS.md` inside the **private per-launch `KIMI_CODE_HOME`**. It replaces only
the delimited `cxx:launch-identity` block, preserving the copied fleet document;
argv stays unchanged. It works for new and resumed sessions. `--agent-file`
binds an agent at session creation and cannot be combined with `-S`, so it is
not the identity transport. The durable base-home instructions are never
replaced by another session's identity.

### Receiver (`kimi-hooks-v1`)

Kimi has no idle-session injection channel (no MCP Channels, no App Server
queue, ACP is client-driven). Delivery uses native hooks that the wrapper
writes into `config.toml`:

- `UserPromptSubmit`: stdout is appended to the turn's context. Payload carries
  `session_id`, `cwd`, `prompt`; fires in TUI and `-p` mode.
- `Stop` (blockable): when queued peer messages exist the hook blocks the stop
  and returns them as the continuation message, so the model handles them
  before ending the turn.
- Model-initiated `agent_listen` stays available.

Full managed hook table (`internal/kimi/runtime.go`, `[[hooks]]`, each
`timeout = 30`; executable is the running cxx binary, shell-quoted):

| Event | Command suffix | Purpose |
|---|---|---|
| `UserPromptSubmit` | `agent poll --hook UserPromptSubmit --dialect kimi` | Peer/portal ring and turn activity |
| `Stop` | `agent poll --hook Stop --dialect kimi` | Block to continue pending peer/portal work, otherwise idle |
| `SessionStart` | `agent native-session` | Bind the native `session_<UUID>` to this launch |
| `TurnStarted` | `agent activity-event` | Working |
| `PreToolUse` | `agent activity-event` | Working/tool activity |
| `PostToolUse` | `agent activity-event` | Working/tool completion |
| `PostToolUseFailure` | `agent activity-event` | Working/tool failure |
| `PermissionRequest` | `agent activity-event` | Waiting for approval |
| `PermissionResult` | `agent activity-event` | Working after approval result |
| `StopFailure` | `agent activity-event` | Idle after stop failure |
| `Interrupt` | `agent activity-event` | Idle after interruption |
| `SessionEnd` | `agent activity-event` | Idle at session end |

The two poll commands are:
`cxx agent poll --hook UserPromptSubmit --dialect kimi` and
`cxx agent poll --hook Stop --dialect kimi`. The `kimi` dialect maps the
existing Claude ring onto Kimi's hook protocol: `UserPromptSubmit` prints the
pending-message notice as plain text on stdout and exits 0; `Stop` with pending
deliveries prints the continuation text on stderr and exits 2 (block);
nothing pending, or any error, is an empty exit 0 (Kimi hooks fail open).

The same ring includes operator portal deliveries via mailbox entries with
`source: "portal"`, independently of peer messages. `agent_listen` reads the
original through `agent_receiver_*` and acknowledges presentation; a ring is
not an acceptance or completion receipt. Poll hooks fail open on errors, and
an already announced portal delivery does not repeatedly block Stop.

From cxx 0.9.199 the Kimi receiver sends activity reports only when its
registration grants `capabilities.activity_v1`. With peer messaging enabled and
the Operator Portal disabled, the peer mailbox and orderly session finish remain
available. A prompt or Stop ring reads pending message IDs. The message stays
queued until a receiver claims it. Durable acceptance and an explicit task result
have separate protocol steps.

From cxx 0.9.200 a connection-owned receiver attaches its own `receiver` state
stream for the registered generation before reporting ready. The separate
session stream authenticates the launch. Losing the receiver stream ends its
readiness and triggers registration for a new generation. Older servers that
only support heartbeat leases retain the 15-second renewal path. Kimi advertises
a waiting native turn with no idle delivery capacity. Queued messages stay in
the mailbox until the model listens, even across receiver state updates.

### Gateway (`/kimi/v1`)

The OpenAI-shaped surface (`/models`, `/chat/completions`, `/responses`) uses
Kimi-scoped `sk-ckx-` keys and the surface/backend routing contract. It starts
disabled (`kimi_api_disabled=1`) pending operator opt-in because subscription
gateway terms are unclear. It never silently selects Grok/Claude/Codex when
Kimi was selected. The runner writes a dedicated inference-only agent file
with `tools: []` and the supplied system text, then starts `-p` with
`--agent-file`; gateway calls do not resume an existing session. Native
stream-json provides no usage or stop reason: adapters preserve unknown usage
and reject controls requiring exact telemetry instead of inventing values.

### Admin API and dashboard shapes

- `/admin/kimi/*` mirrors `/admin/grok/*` (keys, state, settings, models,
  config, version and lock) with `kimi` substituted; `/admin/hosts/:id/kimi-version`
  mirrors the Grok route.
- Account usage for `engine = "kimi"` (Accounts, Dashboard, `/quota`):
  `{"plan_name": string|null, "windows": [{"kind": "five_hour"|"weekly"|"month_total"|"month_code", "used_percent": number, "resets_at": string|null}], "fetched_at": string|null, "checked_at": string, "error_code": string|null}`.
  `five_hour` maps to the short quota window and `weekly` to the long one.

## Intentional deltas

- No idle push: a message to an idle interactive Kimi session waits until the
  next prompt or turn end (shown as delivery timing `after_turn`).
- No OS sandbox exists in Kimi; posture projects only `default_permission_mode`
  and `[[permission.rules]]`.
- Gateway surface disabled by default (see Identity); no native stream-json usage or stop reason.
- The server is the single refresher; local canonical auth reconciliation is explicitly refused.
- Live verification of device login, refresh and `/usages` requires a Kimi Code
  subscription credential, which the fleet secret store did not hold on
  2026-11-12; those paths are built from the 2.5.3 source and covered by mocks.

## CLI surface

| Command | Behavior |
|---|---|
| `run` (default) | Sync and launch Kimi with its leased access-only private runtime after the shared [startup update recovery](interface-cdx.md#startup-update-recovery) check. |
| `resume` | Resume the native `session_<UUID>` with `-S`. |
| `sync` / `auth-sync` | Sync signed config, instructions and native Skills. |
| `status` | Report installation, API and auth readiness. |
| `doctor` | Diagnose config, binary, runtime and auth readiness. |
| `update` | Update shared cxx and the pinned verified Kimi binary, then sync. |
| `cron` | Shared host maintenance schedule. |
| `uninstall` | Remove managed Kimi content and installation with session fencing. A missing private installation counts as removed. An active private executable, held installer lock, redirected store path or filesystem error is reported. |
| `login` | Dedicated throwaway device login and canonical server seed. |
| `logout` | End the managed auth binding. |
| `auth-upload-auto` | Accepted no-op; hosts own no canonical refresh token. |
| `auth-reconcile` | Explicitly refused: the server owns canonical refresh. |
| `help` | Wrapper help without launching or authenticating. |

### Emergency mode

`ckx emergency [--] [native arguments]` (cxx 0.9.184) and
`cxx emergency kimi [--] [native arguments]` run the native Kimi CLI directly.
They use the same [signed secure-host check](interface-cdx.md#emergency-mode-cxx-09141)
and require a native login in `$KIMI_CODE_HOME` (default `~/.kimi-code`).
Binary lookup checks `CKX_KIMI_BIN`, the read-only `~/.ckx/state/kimi-bin` cache,
and the native `kimi` on `PATH`.

## Parity exemptions

Every tracked file that mentions Grok but not Kimi must be corrected or carry a reviewed
exemption. The exemption table and its audit notes live in
[`scripts/engine-parity-exemptions.md`](../scripts/engine-parity-exemptions.md), the data file of
`scripts/check-engine-parity.py` (enforced by `api/test/unit/contract/engine-parity.test.ts`).
Exemptions are scoped to the stated reason, not permission for a new engine enumeration to omit Kimi.

## Native speech input policy

`GET /admin/speech-input` reads the global default and all four engine overrides.
`POST /admin/speech-input/:target` accepts `{ "enabled": true|false }` for `global`; engine targets also accept `null` to inherit. Global defaults to on. Engine overrides win. Settings require settings.read/settings.manage. Changes apply after sync to new launches and never begin recording.

Claude 2.1.92+ projects `voice.enabled` while preserving other voice settings; it requires a Claude.ai account and a local microphone. Grok 1.0.75+ projects `ui.voice_keybind_enabled`; disabling the shortcut does not disable `/voice`. Codex supports `/voice` conversations but has no verified central toggle in 0.167.2; removed flags are not written. Kimi has no verified native speech support. Unsupported control is reported separately from requested policy.

## Native configuration maintenance (2026-11-17)

The Engines editor validates user `config.toml` defaults against the source-tagged
[Kimi Code 2.7.2 configuration sections](https://github.com/MoonshotAI/kimi-code/tree/56145f849caa305d42acd09b67fb65d11146f887/packages/agent-core-v2/src)
(reviewed 2026-11-20; 2.6.2 was the previous baseline, and the only section
added since is `[hosts]`, see below).
Fixed root and nested keys reject unknown settings, wrong types and ignored
retirements. Map names (provider/model aliases, headers, environment variables,
secondary-model aliases) remain literal, including dots; validation executes no
hook, helper, provider request, remote launcher or optional service. It preserves
explicit false/zero values and does not insert native defaults. Integer fields
also require lossless JavaScript integers (at most 9,007,199,254,740,991), matching
the native TOML parser; unsafe historical numbers remain visible for correction.

The inventory covers default model/provider, permission/plan defaults, skill and
agent paths, telemetry/session-title/survey flags, providers/models and model
overrides, model catalog refresh, thinking, loop control, token counting,
task/background, subagent/swarm timeouts, MCP timeouts, identity, tool selection,
read/image limits, database/search/watch, workspace trust requirement,
experimental flags, the two built-in service configurations, permission rules,
remote declarations and lifecycle hooks. Separate native `tui.toml`, projects
registry/trust records, private authentication and remote-runtime provisioning
are not distributed by this editor. Authoring a declaration/reference does not
install or activate its remote environment or credential.

| Values | Validation |
| --- | --- |
| `default_plan_mode`, `thinking.enabled`, catalog `refresh_on_start` and other switches | Actual booleans; strings are rejected |
| `loop_control.max_steps_per_turn`, `max_attempts_per_step`, `reserved_context_size` | Nonnegative integers; zero is retained |
| `max_ralph_iterations`, `compaction_trigger_ratio`, `compaction_max_attempts` | Integer ≥ −1; number 0.5–0.99; integer ≥ 1 respectively |
| `task` / legacy `background` | Nonnegative integer timeouts/grace periods; positive `print_wait_ceiling_s` / `print_max_turns`; `print_background_mode = exit|drain|steer` |
| Subagent/swarm timeouts | Nonnegative integer milliseconds, including zero |
| MCP timeout/reconnect fields | Integer milliseconds 1–2,147,483,647 |
| Model context/input/output and read/image limits | Positive integers, including model `overrides`; identity/routing fields are rejected in model overrides |
| Permission rules | `allow|deny|ask`, nonempty native pattern, persistent `user|project` scope; transient turn/session scopes are ignored by the user consumer and rejected here |
| Hooks | Native event enum, nonempty command, optional string matcher, integer timeout 1–600 seconds; unsupported hook fields rejected |
| Services | Only `moonshot_search` / `moonshot_fetch`; unsupported service names cannot be silently ignored |

`default_provider` and `model_catalog` (including `refresh_on_start = false`) are
real settings already present in the source-audited **2.5.3** baseline. That
recovery/default floor remains unchanged. Provider `search_url` / `feedback_url`
and a literal `secondary_model.models.primary` pool entry require an observed
**2.6.2+** client (conservative source-audited gate): 2.5.3 lacks those provider
fields and reserves the pool name `primary`. Provider/header names that merely
contain those strings do not trigger a gate. Admin authoring/preview remains
independent of installed hosts; delivery of these additions to an old or
unreported host fails with the required version and `ckx update` instruction.
A provider with `type = "bedrock"` (new in 2.7.0) requires an observed **2.7.0+**
client in the same way (`kimiNativeMinimum` returns `2.7.0`, also when a
`search_url` is present). The gate matches the exact type string on any provider
entry; a provider or model that is merely named `bedrock` or has an empty or
other `type` does not trigger it. AWS credentials come from the host's shell
credential chain, not from this configuration.

New input rejects `loop_control.max_retries_per_step` and
`max_steps_per_run` with their `max_attempts_per_step` / `max_steps_per_turn`
replacements. Stored reads and idempotent migration **0134** rename only valid
nonnegative integer values; an explicitly present successor always wins.
Invalid old values and unknown siblings remain available for correction.
The same migration removes exact obsolete `secondary_model.force` and removed
secondary tuning fields (`max_context_size`, `max_input_size`, `max_output_size`,
`capabilities`, `display_name`, `reasoning_key`, `adaptive_thinking`,
`support_efforts`, `off_effort`). Configure tuning on the referenced model entry;
`default_effort`, `default_model` and pool entries survive. It also removes
`task.max_running_tasks` / `background.max_running_tasks`, which 2.5.3 supported
but 2.6.2 removed without a replacement. This removes those historical
concurrency limits from generated settings, including on baseline hosts.
Other engines, literal map names, sibling settings and historical TOML body/hash
snapshots are preserved. New input cannot reintroduce removed keys.
Internal environment-bound `cron` controls and `thinking.forced_effort` are not
persistent user settings; the latter uses `KIMI_MODEL_THINKING_EFFORT`, while
`thinking.effort` remains the user default. The `[hosts."<name>"]` section
(2.7.0+: `host`, `name`, `enabled`, `identity_file`, `remote_bin`) is refused with
its own reason: it is consumed only by Kimi's web/desktop server SSH-host
bridge, which is outside the managed `ckx` lifecycle. Other unknown keys keep the
generic "unsupported user setting" error.

Verification used official SHA-256-verified Linux x64 binaries: 2.5.3
`fba921820696dfa3ed5951c26e6d5cb307cd3929bf8b76215caf510fa8265090`
and 2.6.2 `c2070d77947b000016d1bc9c189f2e258c51f29d5f9eb537388cc44fa61c5856`.
Isolated `doctor config` accepted rendered positive fixtures and rejected wrong
plan/thinking types, negative attempts and unknown hook event/invalid timeout;
validation did not execute marker hooks. Generated configs retain the existing
fleet privacy defaults (`telemetry = false`, `auto_session_title = false`,
`disable_feedback_survey = true`). Doctor warns that the last two top-level
keys are ignored by its v2-core inventory. That warning is not proof that these
client-wide settings are ineffective: `app/config/toml.ts` maps snake_case to
camelCase; `ConfigRegistry.validate` preserves unregistered domains,
`ConfigService.buildValidated/getAll` retains them, and
`packages/node-sdk/src/v2/config-mapper.ts` explicitly projects
`autoSessionTitle` and `disableFeedbackSurvey`. The TUI's
`maybeAutoGenerateSessionTitle` reads `harness.getConfig().autoSessionTitle`,
`utils/survey-setting.ts` reads/migrates `disableFeedbackSurvey`, and
`packages/product/src/session-rating/node/session-rating-host.ts` checks that
same setting. SDK tests round-trip both TOML fields. The 2.5.3 tag has the same mapper
entries and TUI/product consumers; its core config service/TOML mapping is
byte-identical to 2.6.2. These are source-inspected
consumer contracts; the doctor warning is a diagnostic scope limitation, not a
retirement. Removing the flags could re-enable title/survey behavior. Native
oracle tests allow precisely those two known warnings and reject unexpected
ignored top-level fields.

Doctor also accepts ignored obsolete
fields, so doctor success alone does not prove consumer support: the source
inventory establishes removals and version gates. No authenticated inference,
remote execution or real optional-service activation was performed.

Regular 2.6.3 appeared during this audit (2026-11-17T15:15:21Z). Its source has
no configuration-schema/event-enum change relative to 2.6.2; its binary manifest
was unavailable during the release freeze. The `AgentExternalHooksService` diff
moves blocking `Stop` hooks from step completion to a serialized completed-turn
queue with a separate abort controller, tracks hook continuations and adds turn,
step and usage facts. `UserPromptSubmit` and the managed hook's
`session_id`/`hook_event_name` inputs and stderr/block result contract stay
compatible. This is source-inspected timing/continuation behavior, not a proven
managed regression or an end-to-end receiver acceptance result.

### Reviewed baseline moved to 2.7.2 (2026-11-20)

Stable 2.7.2 (tag commit `56145f849caa305d42acd09b67fb65d11146f887`,
2026-11-20T09:06Z) is what `/latest` serves. Against 2.6.2 its upstream
`config-manifest.toml` differs by exactly one new section, `hosts`; type and
range checks are unchanged, and no option was removed or deprecated. The central
schema, the Bedrock gate and the `[hosts]` refusal above cover that delta. 2.7.1
and 2.7.2 only fix Web-UI effort/composer behaviour. Native `doctor` on 2.7.2
accepted a managed-style config and one with a Bedrock provider plus `[hosts]`;
as before, doctor success does not prove consumer support. From 2.7 a
`permission` or `[environments]` section that fails native validation falls back
to defaults or the last-known-good value with diagnostics only, so central
validation remains the gate.

The model-consumer fixture (`api/test/fixtures/kimi-native-2.6/`, directory name
kept) now executes the 2.7.2 `packages/core/src/llm/thinking.ts` and
`catalog-runtime.ts` with recorded SHA-256 digests. The consumers moved to the
nested `LlmModelSpec` shape; the semantics for rendered metadata (always-thinking
K3.1 Pro, image-but-not-video `k3-256k`, Highspeed without adjustable efforts)
are unchanged.

### Native hook acceptance (2026-11-21)

The opt-in `TestKimiNativeHooksCanary` ran the official Linux x64 Kimi 2.7.2
binary with `-p probe --output-format stream-json`, an isolated home and a
loopback provider. The provider received the `UserPromptSubmit` marker and a
subsequent request carrying the blocking `Stop` hook's stderr marker. All three
hook events (`SessionStart`, `UserPromptSubmit`, `Stop`) carried the stream's
session ID, working directory and client type. The CLI wrote its transcript.
Use a canonical absolute temporary directory for this check.

Repeated headless runs showed that the process can exit before consuming a
blocking Stop notification. Nine of twelve serial runs with Kimi 2.7.2 and the
same loopback provider sent the second request. In a separate twelve-run set
with hook event recording, three sent a second request, seven exited after the
Stop hook wrote its marker, and two exited before a Stop invocation was
recorded. A callback marker and process exit provide no delivery acknowledgement.
A new unit of work still needs its ordinary durable claim and explicit result.
On 2.6.2 the earlier probe
observed no `Stop` invocation in print mode.

A separate 2.7.2 check launched the native interactive CLI on a Linux PTY
with a disposable home and a loopback streaming provider. After a typed prompt,
the first request contained the `UserPromptSubmit` hook output. The next request
contained the blocking `Stop` hook's stderr. All three hooks reported one native
session with client type `kimi_code_cli`. Both checks use synthetic inference.
Live subscription entitlement and end-to-end fleet delivery still require
provider and receiver acceptance.

## Explicit task-title and result reconciliation

`agent_session_name(name, replace?)` preserves an existing title by default.
For a new task after `/clear` or a continuation, `replace: true` explicitly
replaces the fleet task title. It does not rename the agent identity or overwrite
an operator's native session name; subsequent native title changes still sync.

`agent_reply` and `agent_task_result` accept an optional `claim_id` containing
the **original accepted delivery claim**. The elected receiver injects it only
from the matching `message_id`; an explicitly conflicting claim is rejected.
When local receipt state is absent, the explicit original claim can reconcile a
result through normal server ownership, binding and lease checks. It neither
accepts new work nor renews or reconstructs a lost lease. `agent_task_result`
retries the same result tuple; explicit terminal replies use a stable
message/claim reconciliation identity. This does not recover the random reply
identity from a different, lost local tracker; reconcile that stored work result
with `agent_task_result`. Lost responses never trigger work replay.

Replacement of an ordinary delivery with a missing transcript requires the signed-in admin action or `agent_fresh_start_approve` with the MCP operator bearer plus a host credential. A peer or wake cannot grant a replacement.

Receiver health distinguishes transport `ready` from `immediate_admission`:
`available` means budget remains (other native and receipt gates still apply),
`budget_exhausted` means the conservative busy-spell slot is spent or awaits a
proven idle boundary, `unsupported` means no negotiated native insertion, and
`after_turn_only` describes Kimi's hook lane. Check `immediate_next_action`.
During active work, `agent_wait(conversation_id)` reads known-conversation
coordination without finishing the accepted task. Otherwise yield at a natural
safe boundary, retaining the original work claim. An MCP tool boundary, listen,
or reconnect does not reset the immediate-delivery budget.

## Boot card contents (cxx 0.9.185)

`ckx` follows the unified boot card described in `docs/interface-cdx.md`:
provider account, confirmed session name, model-policy rewrite, host daemon and
communicator state render inside the card instead of as separate startup lines.

Kimi uses the shared Portal messaging contract. Send `important: true` on `agent_portal_say` or `agent_receiver_reply` for a red inline highlight. See [Agent chat](agent-chat.md).
