# cgx — Grok Build fleet wrapper

## Workflow protocol v1 (cxx 0.9.111)

The shared wrapper advertises `workflow_protocol_version: 1` and exposes the
session-bound `agent_workflow_*` tools on `cxx-agent` for all three engines.
Catalog reads remain on the central MCP. The managed `workflows` and `invite`
Skills explain task claims, autonomous invitations, evaluation and report links.
Read `agent_self` and `agent_workflow_run_current` after resume before continuing
work. A claim is tied to the current session binding; expiry requires
reconciliation and never authorizes an automatic retry or fresh transcript.

Each mutation uses a stable `client_request_id`; retry an uncertain acknowledgement
with the same UUID and body. Completing a workflow does not replace the separate
accepted-work `agent_task_result`. See [Workflows and shared runs](workflows.md)
for states, collaboration, module draining and recovery.

## Smart queue delivery v1 (cxx 0.9.87)

Native receivers negotiate an opt-in catch-up digest and a coordination lane
while accepted work remains held. Send/reply accept explicit `delivery_class`,
`coalesce_key`, and `related_work_id`; `agent_digest_get` retrieves paginated
originals. Calls, conferences, task results and operator messages remain full.
Work IDs and auth/admission fences are preserved. The server flag defaults off;
see [Smart queue](smart-queue.md) for limits, canary setup and rollback.

The legacy `/go` magic-link webchat is removed. Active Clients and Android
continue using the existing session/receiver contracts and `cxx portal` commands;
operator access requires a dashboard account or its paired device. Session
settings and remote-session controls are available in Active Clients.

## Native shutdown

Native launches and help forward SIGINT, SIGTERM and SIGHUP as catchable
signals, allowing ten seconds for cleanup before forced termination. Exit
status uses the shell convention `128 + signal`. Headless children, the Codex
app-server receiver and the Grok private leader own process groups whose
remaining members are terminated on completion. Interactive children retain
the terminal foreground group; forced escalation targets their direct child.
User stops finish as `user_stop`, while genuine crashes and an already reported
hang or capacity failure keep their own recovery classification.

## Fleet commit preferences

Managed AGENTS.md carries the fleet's short/long commit preference and AI attribution setting from the Git Director page, independently of Director, MCP and Skills activation. Defaults: a subject-only message and no automatic AI markers/co-authors. Long adds change/reason and relevant verification; attribution adds one `AI-Assisted-By: Grok` trailer after a blank line, also in short mode. Git author/committer and commit/push authorization remain unchanged; explicit operator instructions take precedence. The next content sync/launch refreshes the document hash; active sessions may retain previous guidance, and explicit blank generation mode suppresses managed rules. API contract: [Fleet commit preferences](interface-api.md#fleet-commit-preferences).

## Private leader diagnostics (cxx 0.9.31)

Managed interactive starts write background leader stderr to a unique mode-0600 file under `~/.cgx/state/leader-logs/`, instead of sharing the native TUI terminal. Each file holds at most 1 MiB; overflow starts a new chunk, and files remain available after runtime cleanup. `cgx doctor` prints the directory; startup failures and observed unexpected leader failures name the specific file. Old log files may be removed when no longer needed. Native tool results, foreground stderr, custom leaders and headless output are unaffected. Existing processes need a normal exit/resume through the updated wrapper.

For the 2026-10-08 `read_file` / `task_ids exceeds maximum of 20 entries` incident, the exact native tool call contained only `target_file` and `limit`; its ACP result was `ReadFile.FileNotFound`. Treat the structured tool result as the evidence for this call, rather than interpreting a raw trace fragment drawn over the terminal as a task batch failure. The wrapper corrects background output routing, not the closed-source provider tool implementation; see [investigation and live checks](archive/grok-tool-diagnostics-2026-10-08.md).

## Native names in Android (cxx 0.9.32)

The automatic receiver reads Grok `sessions/*/<bound native ID>/summary.json` naming metadata (`title`, then `generated_title`), with a matching `info.id`; custom `GROK_HOME` is honored. Changes are sent as encrypted, idempotent `session_named` events on its 15-second heartbeat. Failed reports retry the original ID/payload and do not disable reception. The metadata reader does not derive titles from transcript text. On its first turn, before its first response (including question-only or do-not-act-yet turns), fleet guidance tells the AI to call the session-bound `agent_session_name` tool with a concise name in the operator’s language; its atomic set-if-missing mode preserves known native or AI names. Android 0.4.6 displays the latest name above host and working directory; the API exposes it only with transcript permission. Update the API before wrappers/APK; older builds remain compatible.

## Managed native starts (cxx 0.9.24)

Fleet installation, update/sync and successful managed launches prepare the native
`codex`, `claude` and `grok` command names for assigned engines. Per-user scripts
under `~/.cxx/native-bin` invoke `cxx native <engine> -- <native arguments>`;
managed Bash, Zsh and Fish PATH blocks activate them in new shells. Bash login
shells (`su -l`, ssh) get the same guarded block in the login file bash reads
(the first existing `~/.bash_profile`, `~/.bash_login`, `~/.profile`; `~/.profile`
is created only when none exists) and in an existing `~/.profile`; the PATH
test keeps a profile that also sources `~/.bashrc` from duplicating the entry.
`native-entry status` reports that file as `login_profile` and whether it holds
the block as `login_profile_active`. Existing
shell aliases/functions and cached commands can take precedence: open a new
shell and inspect `cxx native-entry status`. Provider binaries are not replaced.

Native arguments use the provider grammar: `status`, `--config`, `-p` and other
options are not interpreted as wrapper commands or profile shorthand. Use
`cdx`, `clx`, `cgx` or explicit `cxx <engine>` for wrapper operations. Provider
login/logout retains the existing central auth protections; native Claude/Grok
install/update/upgrade is refused so the fleet pin cannot be bypassed, and
`clx update` / `cgx update` remains the managed update path.

Native and wrapper starts share account leases, auth lifecycle, session-bound
MCP tools and one local connection runtime. Interactive delivery uses Codex App
Server queues, Claude MCP Channels or Grok ACP. Tools-only headless runs and
unsupported/custom native endpoints never advertise an inbound receiver merely
because MCP is configured. Existing Engine/Fleet switches and native permissions
remain authoritative; queue admission and successful work results are separate.

`cxx native-entry install` repairs entries from locally verified signed configs;
`cxx native-entry remove` removes managed entries and shell blocks for rollback.
Both refuse, and the automatic post-command reconciliation skips, a home
directory owned by another user (for example `sudo env HOME=/home/user cxx
daemon install`), so privileged maintenance never leaves root-owned entries or
shell files there. Uninstall run that way stops with the same error; run it as
the owning user.
Normal later sync/update prepares them again. Uninstall removes only the selected
engine's entry after confirmed server removal, preserving other engines. No new
server endpoint or database migration is required.


`cgx` is the Grok persona of the shared signed `cxx` binary. Installations may
enable any nonempty subset of Codex, Claude, and Grok. `cdx`, `clx`, and `cgx`
are relative aliases to the same binary; explicit invocation is `cxx grok …`.
The wrapper maintains engine-specific auth, config, versions, locks, and leases.
Grok uses the shared Skills, instruction, MCP, project, memory, secrets, and
messaging surfaces with `engine=grok` / `X-Engine: grok`.

Working secrets are shared across Codex, Claude and Grok. `X-Engine` remains
part of the secret read audit and creation provenance, but never restricts
visibility. Migration 0044 removes the obsolete scope column without changing
credential values. See [MCP verification](archive/grok-mcp-verification.md).

## CLI surface

| Subcommand | Purpose |
|---|---|
| `run` (default) | One Grok session: managed sync, `/auth` (with the insecure-host approval box when interactive), a leased subscription account, an isolated private runtime and leader. A held sync lock pauses content sync for this launch instead of refusing it. A missing native CLI is installed in the foreground first. |
| `resume [UUID or title]` | `run --resume …`; native history lives in the shared sessions root. |
| `sync` / `auth-sync` | Converge `~/.grok/AGENTS.md`, owned `config.toml` paths, native skills under `~/.grok/skills`, host users and peer engine configs without launching. Exit 1 on a failed managed write or an unreachable server. |
| `status` / `--status` | Installation, version, API and subscription-auth health. Exit 1 when the result is red. An answered auth error (for example `grok_login_required`) keeps `api=ok`. |
| `doctor` / `--doctor` | The status card plus a doctor report: paths, native CLI vs fleet target, `config.toml` parse and owned keys, managed `AGENTS.md`, native skill drift, auth, `/auth` latency, disk, cron and session environment. Never reads or changes credentials; exit 1 on any failed check. |
| `login [retry]` | Native subscription device login in a throwaway home, uploaded to the central owner; `retry` re-sends a protected pending login within 24 hours. |
| `logout` | Erase pending login material. |
| `update` / `--update` / `-U` | Wrapper self-update (downgrade- and loop-guarded), then the server's target Grok CLI, shell alias, content sync and version report. The CLI is reinstalled only when its version differs from the target. |
| `cron [install\|remove\|run]` / `--cron …` | Manage or run the host-wide `cxx cron` schedule. The coordinator's per-engine Grok tick runs the same maintenance as `update` without forcing a CLI reinstall, reports versions even when content sync fails, and prints one `cron: …` result line. |
| `uninstall` / `--uninstall` | Refuse a multi-user host without root or passwordless sudo; best-effort server delete; then remove fleet skills, owned config keys, the managed `AGENTS.md` (only if unchanged), pending login, signed config and the private Grok installs. Shared cxx aliases and cron are removed only on a confirmed server result. Native history and unwrapped credentials stay. |
| `auth-upload-auto` | Accepted no-op for shared callers: managed Grok runtimes hold no canonical refresh token to upload. |
| `auth-reconcile` | Refused before configuration or network work: Grok credentials are server-owned; explicit local recovery is supported only by Codex and Claude. |
| `help` / `--wrapper-help` | Wrapper help. Native help (`cgx --help`, `cgx help`, `cgx mcp --help`) goes straight to the native CLI without a lease or sync. |

Flags: `-W`/`--wrapper-version` (the shared version block with the signing-key line),
`--config FILE`, `--skip-boot`/`--silent`/`--no-banner`, `--minimal-output`,
`--allow-concurrent-sync` (write managed content even while another cgx lifecycle
holds the lock, like cdx), `-4`, `--debug`/`--verbose`, `--execute PROMPT`.
Launches refuse when the baked host FQDN does not match the hostname
(`GROK_ALLOW_FQDN_MISMATCH=1` overrides). A launch whose `/auth` host engine set differs from the
baked one requests background maintenance immediately, so an engine an operator
enabled or disabled is provisioned on this launch (cdx parity). Maintenance appends `alias grok='cgx'` to
existing `~/.bashrc`/`~/.zshrc`, as cdx and clx do for their engines.

### Native argument boundaries (Grok Build 1.0.60)

Managed native dispatch recognizes global options before subcommands, including
`--debug login` / `--debug-file FILE update`; authentication remains centrally
owned and install/update/upgrade remain fleet-managed. Command-looking option
values stay values. Dispatch, headless detection, identity rules, startup
preferences and workspace capture share required/optional value boundaries,
short/long aliases, attached/equal forms and `--`. In particular `-p`, `--single`
and `--print` take a prompt, while `-r` / `--resume` and `-w` / `--worktree` have
optional values. Comma-separated permission/tool lists take one argv value.
An explicit resume UUID may follow global options; a title, picker or fork does
not prove continuity with an existing native session. Native help and version
requests bypass signed config, account leasing, sync and private-runtime starts.

Before central auth routing removes root session options, native login/logout
checks structural option names/value boundaries and the command's trailing
arguments. Unknown leading flags and unsupported logout arguments are refused,
so invalid native argv cannot clear a pending login. Supported global diagnostic
options are retained; a native version request never routes into auth cleanup.
The native CLI retains semantic config/provider validation.

Public `cursor-worker`, `agent serve`, `agent leader`, `agent headless` commands
and explicit external `--leader-socket` targets are refused before configuration/auth work. A persistent Cursor worker or an
existing external leader/relay cannot inherit this launch's private leased-account
broker, session identity and teardown. Native `--help` remains available;
normal managed sessions retain their wrapper-owned private leader. No public
worker registration or background service is enabled by this support boundary.

## Bare `cxx` launchpad (cxx 0.9.65)

From cxx 0.9.70 the shared picker uses the Obsidian compass with dark cards,
segmented effort controls and responsive small-terminal layouts. The same
`CXX_REDUCED_MOTION=1`, `NO_COLOR` and minimal-output behavior applies to all
engines; see the presentation contract in `docs/interface-cdx.md`.

On an attended terminal, `cxx` with no arguments opens the engine/model/effort
picker described in `docs/interface-cdx.md` ("Bare `cxx` launchpad"). Grok sits
below the centre when three engines are present. From wrapper 0.9.68, selecting
that slot opens its model grid below a downward stem; with two engines it uses
the direction of its assigned compass slot. Its launch is
`cgx run --model M --reasoning-effort E`, so the boot card stays, and `c` adds
`--continue`. Grok has no interactive session picker, because its bare `--resume`
takes the latest session, so `r` is not offered.
The weekly usage notice shows `week --` for Grok: the wrapper has no weekly
quota observation (cxx 0.9.68). This does not change server-side subscription usage.

## Native CLI and installation

The supported baseline is official Grok Build **1.0.50** (verified 2026-10-12 against
`https://x.ai/cli/stable` and `@xai-official/grok@1.0.50`). Linux and macOS on
amd64 and arm64 use exact-version official npm native packages
`@xai-official/grok-{linux-x64,linux-arm64,darwin-x64,darwin-arm64}`. The installer
verifies sha512 `dist.integrity` before extracting only `package/bin/grok.br` and
decoding Brotli. It does not run npm lifecycle scripts. A verified private CLI
lives below `~/.cxx/engines/grok`; updates retain the previous installation.
Grok's native self-updater is disabled for managed processes.

Version 1.0.50 is the native settings floor (`ui.timestamps` requires it).
Stored older fleet targets, global locks and host pins remain available as
historical preferences, but API snapshots and the wrapper installer resolve
their effective target to at least 1.0.50. The version settings page displays
this minimum. A launch with an already installed older binary fails before
config sync or account leasing and names `cgx update` (or a supported
`CGX_GROK_BIN`) as the remedy. Update policy and explicit binary overrides
remain respected; diagnostics such as native `--version` still work.

On API startup, the verified four-platform `cxx` matrix publishes the same
wrapper version, Linux checksum, and download URL for all three engines.
Runner health is recorded independently for Grok, so a failure in another
engine does not mark a healthy Grok runner unavailable.

`cgx update` checks for offered wrapper releases through the shared verified
binary updater. Wrappers 0.9.9–0.9.12 have a Grok-only logger panic in that
branch. When Codex or Claude is also installed, use `cxx update` to recover to
0.9.13 or later through that engine. Grok-only hosts should run a newly issued
installer for their existing host. Recovery preserves the host's API key,
enabled engines, and native auth.

`CGX_CONFIG_PATH` selects the signed wrapper JSON config. Native CLI configuration
uses `~/.grok/config.toml`: `[models].default` and
`[models].default_reasoning_effort`, `[model."<id>"].context_window`,
`[ui].permission_mode`, plus
`[mcp_servers.cgx]`. The subscription catalog (live `/v1/models`, re-verified
2026-10-03) defaults to `grok-4.7` / `high`; `grok-4.7`, `grok-4.7-build-fast` and
`grok-4.6` support `low`, `medium`, `high`, `xhigh`, and `grok-4.5` supports `low`,
`medium`, `high`. All offer 256,000- and 500,000-token windows, with 256,000
as the provider default (confirmed in the native subscription model cache dated
2026-10-03). This catalog describes native
supported IDs; subscription entitlement still depends on the provider. Codex
lane/profile settings and Claude artifact settings do not apply.

The Engines page's Model defaults tab saves the context window immediately through
`/admin/model-defaults/grok`. The canonical `context_window` setting renders
only the effective model's native `context_window` field, after host model
overrides. The existing model catalog and all other native model fields remain
intact. Wrapper 0.9.18 treats the dotted model ID as one key in `owned_paths`,
so switching the default model prunes only the unchanged, previously managed
window; user-authored sibling fields and subsequent local edits are preserved.
The default applies to new sessions after the next sync; `/context-window`
continues to select a session-local size. The native field is documented in
[xAI's settings reference](https://docs.x.ai/build/settings/reference#modelid);
Grok Build 1.0.46's bundled model guide confirms that a `context_window` override
selects the default from `context_windows`.

The fleet security posture projects onto Grok the way it projects onto Claude:
the autonomy axis selects `[ui].permission_mode` (`default` for levels 0–2,
`auto` for Standard, `always-approve` at the top of the scale, capped while any
axis is restrictive), rendered as an owned path so a user-authored mode returns
when the posture stops claiming it. Grok's kernel sandbox (`[sandbox].profile`)
is deliberately not derived: its interplay with the isolated managed runtime is
unverified and Grok runs unsandboxed when a profile cannot be applied; the
enforcement report lists it under `not_enforced`.

## Native configuration maintenance (2026-10-16)

The config API accepts `settings.native_settings`, a JSON object with the native
`config.toml` table shape. The Grok validator preserves documented fields through
save, read, host rendering and wrapper sync. This includes tool settings,
subagents, plugins, goals, memory, native command/HTTP hooks, notification hooks,
and built-in or command status lines. Features are configured only when an
operator supplies them; support does not turn experimental features on.

The field/type registry is audited against Grok Build **1.0.60 stable** and the
[official complete reference](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager/docs/user-guide/26-config-reference.md),
supplemented by the matching configuration, hooks and status-line guides and
[current settings reference](https://docs.x.ai/build/settings/reference).
The existing native floor remains Grok Build 1.0.50, including the
`ui.timestamps` setting. `pager.toml`, custom
`sandbox.toml` profiles and enterprise `requirements.toml` are separate files;
this interface edits the user `config.toml` partial only.

Unknown keys, wrong types/enums, deprecated per-model `reasoning_effort` and
`supports_reasoning_effort`, `ui.approval_mode`, `ui.ui_theme`, and
`ui.show_timestamps` produce a 422 with the offending setting path. The message
names the current replacement. The shell inheritance enum is `core|all|none`;
model notices require string `text`, optional string `label`, and
`severity=info|warning|critical`. Status lines require a `type`; command rows also
require a nonempty command, and built-in rows validate segment names and reject
command-only refresh timers. Native disabled aliases `off|none|hidden` are accepted.

Grok 1.0.51 removed `memory.embedding`, `initial_injection`, `search`, `session`
and `watcher`, plus `memory_v2.automatic_dream_enabled`, `capture_enabled`,
`capture_status_enabled`, `file_writes_enabled`, `manual_dream_enabled` and `rollout`.
New input rejects those exact paths with a 422 and points to `memory.enabled`.
Migration 0072 removes them from stored Grok native settings and conditional
version layers, preserving other memory-v2 tuning fields and unrelated values.
It also removes proven invalid shell-inheritance values, known invalid status-line
shapes, and malformed notices. Invalid built-in segments are removed in order;
empty lists are omitted to restore native defaults. Exact inert
`model.<id>.6.api_key` leaves are removed and only empty `6` tables are pruned.
Unknown custom siblings stay visible as validation errors instead of being
silently removed. Valid aliases and absent native defaults are preserved.
The saved `content`/`sha256` remain the historical snapshot until the next normal
save; host rendering and validation previews use the migrated settings immediately.
The accidental `model.<id>.6.api_key` registry path is also rejected; documented
`model.<id>.api_key` remains supported. `features.tool_search` is not accepted:
the current web reference and stable 1.0.60 consumer disagree.

Omit absent values; TOML has no `null`.

Model and effort belong to the structured controls: native `models.default` and
`models.default_reasoning_effort` are rejected with the corresponding control
path. An explicit structured context window takes precedence over the selected
model's native window; otherwise that native value or the catalog default is
used during rendering. Native windows and `ui.permission_mode` are never copied
into persisted structured settings, so later native edits and deletions remain
effective. Host overrides and security posture take precedence; other per-model
fields survive. The subscription model catalog validates the effective default.
Native MCP definitions join the normal managed injection path, including
`bearer_token_file`, OAuth configuration and per-tool timeouts; fleet entries
replace conflicting names. The runtime's subscription auth provider, private
leader, update policy and disabled cross-engine MCP imports remain owned by the
fleet; incompatible native settings are rejected instead of silently ignored.

Native `version_overrides` accept validated version bounds and ordinary native
patches. Conditional model, posture and MCP changes are rejected because those
layers would bypass the corresponding fleet controls.

`owned_paths` remains a string array. Existing paths keep their dotted encoding;
ambiguous nested paths use `json:["model","grok-4.7","extra_headers","X.Team"]`.
This encoding requires **cxx 0.9.66**; host rendering rejects it for older or
unreported wrapper versions with an update-first message. Sync prunes only an
unchanged previously owned value and preserves user-authored siblings.

## Skills

Grok Build loads `~/.grok/skills/<name>/SKILL.md` natively, with the same
frontmatter Claude Code uses. `/sync/bootstrap` for `engine=grok` returns
`grok_skills`, the complete live set of shared and Grok-scoped Skills, and cgx
installs it exactly like clx installs native fallback `claude_skills`: every bundle is verified
against its advertised digest (including auxiliary files), staged and swapped in
atomically; ownership is recorded in `~/.cgx/state/skills.json`; only
manifest-owned directories are pruned, stripped or replaced; a directory the
manifest does not own is the user's and is never adopted; drift withholds the
digest so the next sync restores the bundle. Skill failures warn on the startup
card and never block a launch. The served Grok instructions point at the native
directory and at the `skill-manager` Skill for Skill management, so agents use
the orchestrator MCP Skill tools rather than native `/create-skill`. On hosts
that also run clx, Grok's Claude compatibility scan sees `~/.claude/skills` too;
both carry the same names, so Grok deduplicates them.

Explicit Grok host provisioning creates these fleet defaults when no Grok
client-config row exists, activating the managed MCP feature context. Concurrent
provisioning and config saves serialize before creating a row; an existing
operator-authored policy is preserved. Reading defaults remains read-only.

## Subscription usage in the dashboard

Dashboard and Accounts show the official Grok Build billing reading per account:
percentage used, provider-defined weekly/monthly period and reset, shared-pool
scope, and the reading time. The API worker polls `/v1/billing?format=credits`
on `cli-chat-proxy.grok.com` every five minutes via the existing fenced auth
owner. Migration 0040 persists the latest reading and attempt status. Paused,
removed, merged, and fleet-disabled accounts are not polled.

A failed request keeps the last reading and marks it stale; missing data stays
unknown, never 0%. Monthly or untyped periods are not labelled weekly. cgx
startup, status, and doctor print that stored reading when `grok_usage.resets_at`
is still in the future, as the same bar-and-reset row cdx and clx use
(`weekly  38%  ━━━━──────  reset 20 days`; plain output `quota | weekly=38% |
reset=20 days`). A day or more is whole days; under a day the row keeps hours and
minutes. A missing percent falls back to the text note (`weekly; resets in 20
days`) instead of printing 0%. A missing,
unparseable, or already passed reset keeps `Subscription quota usage is
unavailable.` This does not enable quota hard-fail, account balancing by Grok
quota, automatic purchasing, or an extra provider call from the wrapper. The
provider-owned billing endpoint may change; source
contract: [official CLI billing handler](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-shell/src/extensions/billing.rs).

## Startup and checks

`cgx` prints the shared startup card before the native UI, with the effective
model/effort, installed and target versions, API/auth/runner health, measured
content-sync outcomes, and the server's fleet sync activity. Actual native
model and effort options override the displayed settings. Grok quota usage
shows the stored billing-period reset when that reset is still in the future,
and stays unavailable otherwise. MCP connectivity remains unknown until probed;
an MCP configuration does not prove a healthy connection. Concurrent content
sync remains visibly paused rather than reporting success.

`status` and `doctor` show the same installation/auth metadata without claiming
that they synchronized skills or config. `--minimal` remains a native option
and also selects compact wrapper output; `status --minimal` and
`doctor --minimal-output` request compact checks. Silent/`--skip-boot` launches
retain banner/footer suppression. The configured terminal theme is respected.

Visible interactive launches use native `--no-alt-screen` so the startup card
remains in terminal scrollback instead of being hidden by the native alternate
screen. Native `--minimal` is passed through unchanged, while `--fullscreen`
still selects the native fullscreen layout within the inline terminal.
Headless and silent launches retain their existing terminal policy. The exit
footer uses the final session/auth outcome after private-runtime cleanup.

## Fleet engine suspension (cxx 0.9.16)

An engine switched off fleet-wide (Admin → Engines → Engine master switches; server contract in
[interface-api.md → Engine master switches](interface-api.md#engine-master-switches)) is
*suspended*, never removed:

- `/auth` answers `403 engine_disabled` with `scope:"fleet"`; the wrapper refuses to launch with
  `Grok is disabled fleet-wide by the administrator.` (exit non-zero) and never falls back to
  cached credentials for it. A host-level removal (`scope:"host"`, or no scope from an older
  server) keeps its old handling and says `Grok is disabled for this host by the administrator.`
- The signed config still arrives (200) with `host.fleet_disabled_engines`; the coordinator keeps
  the config and the `cgx` alias, skips this engine's maintenance tick (no CLI update, no managed
  sync, no peer install) and runs no receiver or relay for it. Local credentials and the installed
  CLI are left alone, so sessions already running run out on their own.
- With the server unreachable, a locally suspended config refuses with the fleet message. When
  `/auth` answers 200 again (switched back on), the launch proceeds and requests immediate
  maintenance so the coordinator re-bakes the config instead of waiting for the next maintenance run.
- `status` / `doctor` report `suspended (fleet)`.
- `cgx` now also honours the API kill switch (`versions.api_disabled`), refusing with
  `Auth API disabled by administrator.` like `cdx`/`clx`. The heartbeat of a lease it already holds
  keeps working but returns `refresh_state:"suspended"`: the server no longer refreshes the Grok
  grant, so a running session ends when its access token expires.


## Subscription auth and canonical ownership

Only modern xAI subscription OAuth is supported. `grok login --device-auth`
creates a native scope map in `~/.grok/auth.json`. The selected scope is
`https://auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828`; its credential contains
`auth_mode: "oidc"`, `key`, `refresh_token`, `create_time`, `expires_at`,
`oidc_issuer`, and `oidc_client_id`, with provider identity/profile metadata.
The native root is a scope map: adding `last_refresh` at that root breaks it.
A secure host retains a failed, newly created login seed in
`~/.cgx/state/pending-login.json` (mode `0600`) for at most 24 hours;
`cgx login retry` retries that explicit upload. Acceptance, logout, and uninstall
erase it, and background maintenance never uploads it. Insecure hosts erase
failed login seeds and require another `cgx login`. These seeds are distinct
from canonical refresh credentials and managed access-only sessions.

Legacy `web_login` credentials and metered xAI API keys require replacement with
a modern subscription login.

xAI rotates the refresh token on every refresh, so a login can have exactly one
refresher. The canonical login must therefore be a dedicated one the
orchestrator alone refreshes: `cgx login` and the admin seed command both run
`grok login --device-auth` in a throwaway `GROK_HOME` and erase it after upload.
Uploading an operator's live `~/.grok/auth.json` (a pasted admin upload, or the
seed command with `GROK_SEED_AUTH_PATH`) leaves two refreshers on one chain:
whichever refreshes second receives `invalid_grant`, and if that is the server
the account enters `login_required` fleet-wide. Only upload a login nothing else
will use.

The standalone seed script requires Python 3 before starting login. A detached
cleanup helper is ready before private credentials are created and waits until
login/upload users exit, including after the launching process is killed. The
`GROK_SEED_AUTH_PATH` override remains caller-owned and is never removed.

The encrypted canonical envelope contains `last_refresh`, the complete
`grok_auth` scope map, `grok_scope`, and a derived `auths` bearer entry for
`cli-chat-proxy.grok.com`. Unknown native fields and unselected scopes survive
canonical storage. Runtime projections remove refresh tokens from every scope
and unselected bearer keys; the selected runtime credential uses `external`
mode. Runtime projections and native enrichment are never canonical uploads.

The server owns refresh for managed Grok accounts. A per-account MySQL
connection lock serializes owners; a durable `grok_auth_refresh_state` fence
records intent before the token request. A successful raw response is encrypted
immediately, and the replacement is staged in the auth ledger before static
verification and compare-and-swap promotion. Retryable verification rechecks the
staged replacement, never resends the original refresh token. Ambiguous spends
remain `uncertain`; invalid grants require login. A verified distinct login can
recover the account. OAuth discovery is constrained to `https://auth.x.ai`;
uploaded issuer URLs cannot redirect credentials to another endpoint.

Startup, `status` and `doctor` use `/auth` with `metadata_only: true` to inspect
local canonical metadata without refreshing provider credentials or allocating an
account lease. A missing/default account cannot block the subsequent account-pool
selection; the actual runtime grant is obtained through `/auth/sessions`.
`status` and `doctor` treat auth as healthy when the account-less head reports
`status:"available"` with `verification_state:"verified"`, or when
`pool_verified_accounts` is positive (a launch would lease one of those accounts).
Otherwise they fail; servers that omit the count keep the head-only verdict.

Ordinary credential retrieval through `/auth` returns the access-only envelope with `canonical_generation`,
`access_token_digest`, `expires_at`, and refresh-state metadata.
The shared `host` block includes `grok_last_refresh`, `grok_client_version`,
`grok_client_version_override`, `grok_wrapper_version`, `grok_auth_digest`,
`grok_model_override`, and `grok_reasoning_effort_override`; unknown values are
`null`. Reactive refresh supplies `refresh_if_generation` with the exact active
leased account/session.
An already-advanced head returns its successor; otherwise one owner refreshes
that generation. Pending/ambiguous renewal returns a typed error, never the same
failed generation. Host startup needs 600 seconds of lifetime; runner/gateway
execution needs its timeout plus the native 300-second buffer (maximum 900).

## Isolated managed lifecycle

A managed launch uses a private runtime `GROK_HOME`, auth path, and leader socket.
This isolation is required because the native auth reloader reads
`GROK_HOME/auth.json` directly, even when `GROK_AUTH_PATH` points elsewhere.
Sharing the operator's original home could silently switch managed accounts.

The original home remains the logical account-guard scope. Sessions share the
original **sessions root** so UUID/title resume, `--continue`, transcripts, and
prompt history remain available. Recognized user config, rules, skills, commands,
personas, agents, plugins, and hooks are preserved by an explicit asset allowlist;
auth files, auth locks, and MCP credentials are never shared into the managed
runtime. Fleet hooks live in a real owned hooks directory with user hooks copied
alongside them. Direct credential overrides and metered-key fallbacks are removed
from managed subprocess environments.

Managed runtimes disable Grok's implicit Claude and Cursor MCP imports through
their private config and process environment. This prevents another engine's
fleet headers or obsolete local MCP endpoints from entering Grok. Explicit
Grok and project MCP entries and other compatibility features are preserved;
BrowserOS or Playwright must be configured explicitly for Grok. Native 1.0.46's
all-server `mcp doctor` deliberately inspects vendor imports even when runtime
imports are disabled. Use named checks such as `cgx mcp doctor cgx --json` and
`cgx mcp doctor cxx-agent --json` to check the actual managed servers.

Active runtimes hold the original home's shared session guard. Owned native
children inherit it, so an orphaned leader or TUI still prevents uninstall from
removing local or remote state until those processes exit.

The native external-auth command is internal `cxx grok-auth`. It returns only
`{access_token, expires_in, issuer:"https://auth.x.ai"}` and completes within the
native seven-second timeout. It bypasses normal wrapper sync/lease acquisition
and never takes the native auth-file lock: native refresh already holds it.

From cxx 0.9.92 every command the wrapper renders into native configuration (the `cxx-agent` MCP server, lifecycle hooks, the `grok-auth` provider) names the resolved common `cxx` executable, never the `cgx` alias: the native CLI spawns it with argv[0] equal to that path, cxx selects its persona from the basename, and macOS `os.Executable` keeps the invoked alias symlink. A legacy regular `cgx` binary without a `cxx` sibling keeps its own path.

The bridge tracks current/previous issued token digests and generations so a
heartbeat's newer fetched head cannot misidentify the bearer actually held by
the native process. `GROK_AUTH_EXPIRED=1` triggers generation-aware renewal.

## Native receiver and worker

Cxx 0.9.25 decodes the native SessionStart `sessionId` after reading the hook JSON
and also accepts `session_id`. The shared MCP tools preserve send/request/call
retry IDs and expose a saved send receipt when only its subsequent wait failed.
Automatic `agent_listen` releases finished informational delivery, checks health and yields;
held accepted work is never released by it (`status: "work_held"`; see `interface-clx.md`);
background workers retain their accepted lease through result storage. See
[delivery reliability](interface-api.md#delivery-reliability-cxx-0926) and the
[2026-10-08 lifecycle audit](archive/agent-messaging-audit-2026-10-08.md).

From cxx 0.9.64 the automatic receiver also releases a read informational
delivery when the model ends its turn without `agent_reply` or `agent_listen`.
Codex and Grok submit only while the thread is idle, so the next busy spell is the
turn that consumes the message; once the thread has then stayed idle for ten
seconds, the receiver completes held informational deliveries submitted before
that spell, exactly as `agent_listen` would, and claims the next message.
Without this, a model that answered with `agent_send` and stopped left every
later message and schedule wake queued until a human typed. Accepted work and
open Portal instructions are never released this way. Claude uses its
`Stop`/`UserPromptSubmit` hooks for the same release (see `interface-clx.md`).

From cxx 0.9.91 the Claude ringer (`cxx agent poll --hook Stop|UserPromptSubmit`)
prints nothing inside a Grok lifecycle (`CXX_AGENT_PORTAL_ENGINE=grok`). On hosts
that also run clx, Grok's Claude compatibility layer imports those hooks from
`~/.claude/settings.json`; a blocking `Stop` kept the Grok thread `working`, so the
automatic receiver's `claim_gate` stayed `thread_working` and the ring told the
model to call `agent_listen`, which cannot force a claim. A clean yield now lets
the thread go idle, and the receiver submits the next message itself. Deliveries
that arrive during a long tool turn still wait for that idle boundary, as on
Codex. User-authored Claude hooks and `compat.claude.hooks` are untouched.

From cxx 0.9.20, Grok exposes the same group/subscription MCP tools as
Codex and Claude: `agent_group_list`, `agent_group_create`, `agent_group_members`,
`agent_group_delete` (cxx 0.9.91),
`agent_subscribe`, `agent_unsubscribe`, `agent_subscriptions` and `agent_publish`.
Explicit publications follow the native ACP admission and durable completion
path; private messages, calls and conferences are never copied to followers.
Informational publications need no acknowledgement reply. See
[Scoped publications](interface-api.md#scoped-publications-migration-0041-cxx-0920).

Managed interactive sessions have an invocation-owned private leader, started
with `--relay-on-demand --no-auto-update`, and a passive `stdio` ACP receiver.
Frames are a four-byte big-endian length followed by JSON. The receiver binds
the exact native UUID observed through the `SessionStart` hook (`sessionId`),
checks the leader session roster/activity, and queues messages with stable
delivery IDs through `session/prompt` metadata. Queue-state events prove
admission; the prompt RPC's eventual turn-completion response is not admission.
Existing durable acceptance, ambiguous-delivery fencing, generation fencing,
deduplication, and reconnect behavior apply. Admission is not an agent reply.

From cxx 0.9.29, `cxx agent send|request|reply` accept an optional
`--client-message-id <uuid>`; uncertain sends report the generated retry ID.
Retry with the same routing and content. A request whose send committed but
whose wait failed returns `sent`, `wait_error` and recovery guidance; continue
with `cxx agent wait` instead of sending the work again. One-shot
`cxx agent listen` consumes only informational messages and leaves work queued
for native MCP or a persistent worker, preserving FIFO. Its API requires the
new `informational_only` claim field, so deploy the API before wrapper 0.9.29.
The native MCP receiver continues to accept, renew and finish work normally.

From cxx 0.9.26, reconnecting the native transport within the same MCP process
retains outstanding work for the same native identity without resubmission.
Peer renewal continues; uncertain peer/Portal result receipts keep the original
payload, and concurrent completion tools serialize. Process loss and revoked
leases keep their existing ambiguous-outcome handling. See the
[shared reliability contract](interface-api.md#delivery-reliability-cxx-0926).
From cxx 0.9.27, conference join/say release only that room's informational
delivery, preserving held tasks and other rooms' messages. A progress update is
not a task outcome. Automatic listen requires the peer source; healthy Portal
transport alone returns `receiver_unavailable` with `peer_source_unavailable`.
Explicit unmanaged `--no-leader` or custom socket launches report receiver
unavailability honestly. The receiver never answers native permission requests.

From cxx 0.9.33, fleet guidance and native/relay prefixes recognize authenticated
fleet peers and direct recipients to handle collaboration and delegated work
within existing operator authorization. A chair may coordinate and delegate work;
messages cannot override higher-priority instructions or expand permissions.
Claims and supplied artifacts still need evidence. Replies and publications remain
informational by default, and scheduled wakes retain the schedule creator's
existing authorization. Server-feed publications are identified as an authenticated
fleet source. Host authentication and allowed-window checks are unchanged.

Operator replies use `agent_receiver_reply(message_id, content, summary?)`.
From cxx 0.9.19, shared native peer-delivery guidance treats a received reply as
informational by default. Answer questions, requested work and substantive active
call turns with `agent_reply`; complete closing acknowledgements through
`agent_listen` once and yield without another peer message. Never acknowledge an
acknowledgement. This is model guidance, not server-side content filtering;
running receiver processes require a wrapper update and session restart.
Supply one plain sentence in the response language, at most 160 characters,
stating the latest result or decision needed for companion cards and push.
`cxx portal say` and `ask` also accept `--summary TEXT`; older callers remain
compatible without it. Grok shares the same event payload and summary rules as
Codex and Claude.

## HTTP inference gateway

The OpenAI-shaped subscription gateway is **`/grok/v1`**, isolated from Codex
`/v1` and Claude `/anthropic/v1`. Engine-scoped `sk-cgx-` client keys are managed
at `/admin/grok/keys`; these are orchestrator gateway keys, not xAI provider keys.
`grok_api_disabled` is the independent administrative gateway switch. The shared `AUTH_RUNNER_URL` must point to the three-engine runner; the gateway and static credential probe use the same configured runner.

Supported endpoints are chat completions, responses, legacy completions, and
model list/retrieve. Embeddings are unsupported. The CLI transport accepts text,
model selection, and system instructions. Streaming, tools, sampling, stop
sequences, output-token caps, and image inputs are rejected with explicit 400
errors. Native `text`, `stopReason`, and optional `usage` are parsed; `end_turn`
maps to `stop`, `max_tokens` to `length`, and `refusal` to `content_filter`.
Responses cut short by the native token limit report `status:incomplete`; cache and reasoning details are returned only when native accounting supplies them. Missing or incomplete usage remains unknown; unavailable subscription quota
does not become a zero-usage or healthy quota display.

## Sources verified 2026-10-01

- Installed native `grok 1.0.46 (2765805b9442) [stable]`, its help, and an isolated
  access-only Grok 4.6 completion validated the execution/JSON contract.
- [Official native CLI source](https://github.com/xai-org/grok-build) provided
  auth, external-helper, leader ACP, home-reloader, model, and hook contracts.
  The inspected public source revision is newer than the installed release;
  live checks are required for the release-specific runtime contract.
- [Official Linux native package](https://www.npmjs.com/package/@xai-official/grok-linux-x64)
  supplies the versioned Brotli binary and sha512 package integrity.

## Wake / Cron and explicit persistent recovery

The shared `wake-cron` Skill and `schedule_*` MCP tools support scheduled prompts and explicitly requested persistent native-session recovery. cxx 0.9.21 uses the per-user background worker, original cwd and engine-specific native resume adapter; from cxx 0.9.82 that worker runs only on a persistent host, and the API refuses persistent schedules for agents elsewhere (`schedule_host_not_persistent`, see [host runtime policy](host-runtime-policy.md)). A missing native transcript blocks recovery, without a fresh-session fallback. Linux supervision may terminate only its own child after a configured progress timeout and fresh policy/binding checks; active child tools and open operator prompts are protected. See [scheduling contract](interface-api.md#agent-wake--cron-schedules).

### Work outcomes and recovery (execution contract v2)

Wrapper 0.9.22 advertises `execution_contract_version: 2`. Newly queued requests,
conference TASK dispatches and wakes wait for a compatible adapter; informational
traffic and already accepted legacy executions remain compatible. The worker and
live/listen adapters confirm durable acceptance before exposing work. Missing native
transcripts stop ordinary jobs too: replacement requires an explicit operator request,
then `agent_fresh_start_approve(message_id, version, reason)` or the admin fresh-start
operation. Grants are bound to the message and target binding, consumed once on acceptance,
and forbidden for schedules. Ordinary ambiguous executions are never automatically rerun.

`agent_task_result(message_id, task_result)` completes accepted work; `agent_reply` may
include the same result and completes work atomically with the reply. A claimed reply
with `delivery_class: progress` and no `task_result` is a non-terminal status update:
the work stays `accepted` and held, so later progress and the real result still succeed
(the wrapper sends `progress` even without negotiated `queue_delivery_v1`). Any other
reply without `task_result` finishes the work as `unknown`. A result contains
`status` (`succeeded|failed|blocked|unknown`), `summary` (4096 UTF-8 bytes maximum) and
optional `evidence` (up to 20 `{description, reference}` objects). Bodies are encrypted;
metadata lists only the status. Per-claim writes are idempotent; a different result conflicts.
Native background final output is one JSON object with `content` and `task_result`.
Missing/invalid reports, listening and successful process exit never imply task success.
These are agent-reported outcomes, not independent verification.

Persistent schedules optionally accept `max_recovery_attempts` (null: unlimited).
Retries double from the base interval, cap at max(base, 1h), add 0–20% positive jitter
and honor later provider reset times. Three failed recovery attempts raise a warning;
exhausting the limit pauses the entire schedule with `pause_reason: recovery_limit_reached`.
Explicit re-enabling starts a new run and counter; history remains. Domain failure alone
never starts recovery. Pause/delete prevents pending attempts while accepted work continues.
The canonical fleet AGENTS guidance and shared Wake / Cron Skill describe these rules.

A result-only peer completion also queues one correlated reply containing its summary in the same transaction; wakes produce no peer reply. Retrying the same result never queues a second summary.

Account launch reservations retry transient HTTP 502/503/504 responses up to four times (1, 2, 4, 8 seconds), using the same session ID and preserving the account used by active local processes. Other failures still abort launch.

Git Director requires absolute directory facts. Re-register the correct clone when `git_director_worktree_ambiguous` is returned; a live lease on an old mapping must be released before reassignment. This contract is shared across all engines.

Fresh native conversations receive a new messaging address even in the same
working directory. Exact transcript resumes retain their mailbox, including
picker/continue resumes after the native identity report. A native identity
change switches mailboxes; old mail and subscriptions remain on the old address.
Informational mail without native continuity cannot spawn a replacement agent.

## German launch names and translation

With Agent Messaging enabled, each new managed Codex, Claude or Grok launch
gets a random free German female given name from the server's pre-filled pool
of 664 names (including Claudia, Tanja, Jessica and Paula). Allocation is
transactional and idempotent for a launch ID. The session title is
`(Claudia) Task title`; the task title is preserved separately.

New conversations receive a name; resuming the same native transcript restores
its original recorded name and UUID, including picker/continue resumes discovered
by the receiver. Same-launch bridge recovery preserves its confirmed name. Exit
or bridge expiry starts a 24-hour quarantine; offline presence alone does not.
A resume can reclaim its own name during quarantine or after expiry while free.
If another identity owns the name or its quarantine, registration returns HTTP 409
`agent_resume_name_conflict` with `name`, `uuid` and `address`; no replacement name
is allocated. Direct resumes stop before provider startup; late receiver binding
is refused without activating delivery. Retry once the name is free. Names remain
reusable after 24 hours, so keep UUIDs for durable references. Existing renamed
identities restore their earliest surviving name on their next native resume.
From cxx 0.9.37, messaging-enabled launches require a confirmed name before
starting the native provider. Registration advertises `launch_identity_version: 1`;
an exhausted pool returns `agent_name_pool_exhausted` and rolls back allocation.
Older wrappers can still receive `name: null`; names are never duplicated.
Legacy records remain unnamed until launch registration.

`cxx agent translate Claudia` prints the canonical UUID;
`cxx agent translate <uuid>` (also `agent:<uuid>`) prints the current/latest
name. Add `--json` for name, UUID, address, launch ID, active/ended status and
quarantine timestamps. Outside a managed launch it uses the installed signed
host configuration without registering a launch. Inside one it uses the
private session broker. MCP exposes `agent_translate` with `{value: string}`.
Names are case-insensitive; German umlauts accept their `ae`/`oe`/`ue` spellings.

Message/request recipients and conference invitation recipients accept names
directly. Accepted messages and invitations persist the resolved UUID and
historical names, including receipt retries after reuse. An expired unassigned
name returns `agent_name_not_found`; UUID lookup still returns its latest
historical assignment. Manual aliases cannot claim pool names; pre-existing
alias collisions keep the affected name out of allocation.


### Confirmed launch identity (cxx 0.9.37)

Before any messaging-enabled provider starts, the wrapper confirms its name,
engine, launch ID and canonical address with the authenticated session-bound
`POST /host/agent-sessions/:id/agent-messaging/self` (`{}` body, bridge token).
The response contains `identity_version: 1`, `name`, `uuid`, `address`,
`session_id`, nullable `native_session_id`, `engine`, `binding_generation`,
`previous_names` for this address and nullable `task_title` for the current binding.
MCP exposes the same read-only lookup as `agent_self` without arguments.
Ended, expired, disabled or stale bindings cannot read another launch's identity.
Update the API before installing wrapper 0.9.37; a missing endpoint, API outage,
empty name or mismatched confirmation refuses the native launch. Signed
messaging-disabled local launches retain their previous behavior.

The confirmed name and launch ID are passed per launch through Codex
`developer_instructions`, Claude `--append-system-prompt`, or Grok `--rules`.
Existing developer/append instructions are preserved; shared AGENTS/config files
never contain a launch identity. Claude resumes use `--system-prompt-snapshot off`
so the prior launch's stored identity is not replayed as the current system prompt.
The context does not state the agent address. It is fixed before the provider
starts, and a later native binding (a picker/continue resume, `/clear`, or another
reported native identity) can rebind the launch to another address while keeping
the launch name and launch ID, so `agent_self` is the only source of the address.
The agent is instructed to read `agent_self` at startup and after resume/recovery.
Delivery of context does not prove that a model obeys instructions.

Server and Android session labels remain `(Name) Task title`. With automatic
reception, naming synchronization also updates the exactly bound native title
through Codex `thread/name/set`, Grok `_x.ai/session/rename`, or Claude's
append-only `custom-title` metadata. Claude new launches also use `--name`.
Historical names for the same address are removed from existing prefixes on resume;
the bare task title remains separate. Naming errors retry without disabling message
reception. Headless or receiver-disabled launches retain server/Android labels
and model context, without a guarantee of native title synchronization.


## Native memory reminders (cxx 0.9.35)

The Grok reminder is maintained in `GROK_HOME/memory/MEMORY.md`,
`GROK_HOME/memory-v2/global/MEMORY.md`, and existing legacy/v2 workspace indices.
A dedicated `memory-v2/global/topics/cxx-memory-routing.md` keeps the reminder as
source material for regenerated v2 indices. Existing runtime directory links expose
both memory trees inside the access-only session home. No authentication material or
memory facts are added to these files; neither native memory switch is enabled.

The additive bootstrap contract, marker ownership, cleanup and failure behavior are
documented in [interface-api.md](interface-api.md#native-memory-reminders-cxx-0935).

## Watchdog — cxx 0.9.36

From cxx 0.9.45, a clean exit or user interrupt carries `user_stop` in the
retried session-finish receipt. The server atomically stops the bound Watchdog
and pending internal recovery, while preserving accepted work and ordinary
Wake/Cron schedules. Worker completion retains its durable task-outcome contract.
An undelivered finish receipt remains indistinguishable from connection loss.

`cxx watchdog` also works through this engine's wrapper alias. In a managed session,
`watchdog status`, `watchdog on --task-key KEY --stdin` and
`watchdog off --id UUID --version N` use the private session bridge. Outside a session,
activation requires `--target agent:UUID` and a signed fleet host configuration;
status supports `--id`/`--target`. Continuation text is read from stdin, never argv.
Options: `--duration 2h`, `--progress-timeout 10m`, `--version N` for an update.
AI uses the managed `#watchdog` Skill and four local MCP tools (get/enable/disable/finish).
Defaults are 2 hours lifetime, 10 minutes progress timeout, server keep-alives every
15 seconds. Recovery pins native identity/cwd/engine and uses the schedule execution
contract with 5-minute exponential backoff and provider reset hints. STOP/off/result
or deadline ends future recovery; expiry leaves accepted work running. Active tools,
open user questions and fresh authorization fence local termination. Three missed
keep-alives suspend termination and reconnect. Agent Messaging in Admin controls the
same records; Portal status is read-only. See `docs/interface-api.md` for the wire contract.

Grok observation hooks accept camelCase payloads for `StopFailure`, `StopCancelled`,
and `SessionEnd`: rate limits/capacity recover, no-progress cancellation is a hang,
user interruption stops recovery, permanent errors block. Subagents are ignored.
Hook payload contract: [Grok hooks guide](https://raw.githubusercontent.com/xai-org/grok-build/main/crates/codegen/xai-grok-pager/docs/user-guide/10-hooks.md).

### Host update output (cxx 0.9.40)

`cxx update [--minimal]` first refreshes the signed host engine assignments
(wrapper 0.9.68), adding configs and aliases for newly assigned engines and
removing them for engines explicitly unassigned by the server. It then checks
the shared wrapper once, updating and restarting it first when needed. From
wrapper 0.9.69, native Codex, Claude and Grok checks and installations run in
parallel (at most three engine workers); credential guards remain sequential,
and managed content/auth sync and version reports follow in Codex, Claude,
Grok order after all installs finish. Every assigned engine gets a result,
including newly added, unchanged or suspended engines. Fleet suspension keeps
configs, aliases and installed CLIs; uncertain assignment probes preserve the
existing layout and fail the update. Removal preserves provider binaries and
user session data.
Equal wrapper versions mean up to date: no artifact download, replacement or
restart. New wrapper releases are SHA256-verified and atomically installed,
then the new binary continues the engine phases without repeating the wrapper
receipt. Downgrades and unverifiable wrapper versions are refused.

Update runs use compact engine-colored rows instead of startup dashboards:
animated checks and installation stages, plus download bars with actual byte
counts and percentages when the server supplies a length. Unknown lengths and
npm installation use indeterminate animation. Parallel engines share one
fixed progress block: transfer labels distinguish the CLI and companion,
finished installs show waiting for sync, and completed rows remain visible.
Each component leaves one final result; only the shared renderer writes while
the block is active. Cancellation stops and joins workers before restoring
the cursor, and an engine failure leaves the other workers running. Narrow
terminals fit the row; pipes, `TERM=dumb` and `--minimal` emit
plain completion lines without cursor controls. Output goes to stderr.

Fleet/host binary-update policy, fleet engine suspensions, version targets and
explicit native binary overrides are retained. Existing native sessions keep
their staged executable. Managed sync respects session locks; a pause is shown
separately from a successful binary update and returns nonzero. An engine failure
does not prevent later engines from running. Credential-preservation failure
skips that engine's sync; wrapper installation or restart failure stops remaining
work and reports skipped engines. Version-report failures also return nonzero.
Direct `cdx update` and `clx update` skip equal-version wrapper installation and
continue their own sync; `cgx update` already skips equal wrapper versions.

### Peer discovery and send diagnostics

From cxx 0.9.59, `agent_list` also accepts `scope: fleet|directory|project`
(default `fleet`). Directory matches canonical cwd on this host; project adds
Git subdirectories, linked worktrees and clones sharing normalized origin across
hosts. Registration automatically captures session workspace facts, independently
of Git Director. Non-Git or legacy sessions use directory matching; inspect
`effective_scope` and `coverage.limited` for missing metadata. Results add task
titles and match reasons while retaining presence and pagination.

From cxx 0.9.86, identity confirmation and advisory peer discovery run in
parallel through the registered bridge. Identity confirmation still gates native
exec; discovery retains its two-second bound and unavailable result.

After identity confirmation, each new managed launch or resume receives up to ten
online project peers in its private native context, with observation time and
remaining count. A two-second timeout or lookup failure reports unavailable and
does not block launch. Peer titles are quoted data, not instructions. Refresh
with `agent_list(scope:"project", online:true)` or
`cxx agent list --scope project --online`; page with `--limit` and `--offset`.

Outside a managed lifecycle (an ops or root shell), `cxx agent list` no longer
fails with "available only inside a managed cdx/clx/cgx lifecycle": it reads
this host's signed config and calls `POST /host/agent-messaging/list` with the
host key, printing a read-only host-scope inventory (`scope: "host"`) with
presence, resumable session ids and live/accepted work counts. `--scope host`
forces that path inside a lifecycle too. Only `--engine` and `--online` apply;
`--scope fleet|directory|checkout|project`, `--host`, `--limit` and `--offset`
are refused outside a lifecycle rather than silently dropped. Nothing is sent or
claimed. When no signed config with messaging enabled is found the error names
every searched path (under `sudo`, HOME/XDG_CONFIG_HOME select the install).
`cxx agent status` outside a lifecycle stays local and adds
`host_config_available` and a `hint` pointing at the host inventory; the other
session-only commands' refusal carries the same hint.

From wrapper 0.9.39, `agent_list` excludes your own agent and accepts `name`
(a literal case-insensitive substring of name, alias or address), `limit` (1–50,
default 50) and `offset` (default 0). If `truncated` is true, pass `next_offset`
as `offset` for the next page; `total` counts filtered peers. Live ranking can
change between pages. `online: true` returns only live peers. Messaging
`client_message_id` values must be UUIDs. Permanent request rejections no longer
recommend retrying the unchanged payload; uncertain transport/server failures
and HTTP 408/429 retain the original-UUID retry hint.

Managed Grok starts with a private leader (`CXX_GROK_SOCKET`) select automatic
reception even if an old project MCP entry runs `cxx agent mcp` without `--auto`.
This avoids a project config replacing the runtime entry and silently switching
to manual listening, including launches from the real home directory. The
managed bridge is still required; a Grok process without the private leader
retains manual mode. Existing MCP subprocesses need a restart to use this fix.

### Recipient status and return notices (cxx 0.9.41)

`agent_send`, `agent_request` (inside its send receipt), and `agent_reply`
report `recipient_presence`, `observed_at` and `delivery_hint`. `queued` means
stored by the server, not accepted or read; `resumable` means currently offline (resumed automatically only on a persistent host; elsewhere mail waits for a human restart and expires after its TTL).
When a recipient becomes receive-ready again, manual or automatic, still-online
senders with waiting mail receive one bundled `presence_notice` from Server.
The notice belongs to the sender's current session and never wakes a later one.
It is informational: finish with `agent_listen` once, without a reply.


## Optional host execution daemon

Hosts opt in under Remote-Sessions; the default is disabled. Linux/systemd is
required. `cxx daemon install|status|start|stop|uninstall|run` manages a separate
`cxx-daemon.service`; its account defaults to root and may be an existing user.
Installation requires root. `cxx update`, wrapper sync/cron and managed
Codex/Claude/Grok launches reconcile an enabled service before native execution;
unprivileged runs report `sudo cxx daemon install` as the pending step only while the
system unit is absent (from cxx 0.9.67; an installed unit stays silent). Accepted
daemon operations and peer deliveries do not reconcile their parent service.
From cxx 0.9.48, successful service reconciliation prints an enabled/start
confirmation; this confirms systemd startup, while connection health is shown
in `cxx daemon status` and the WebUI. The daemon WebSocket uses the same IPv4
preference and CA trust as relay HTTP calls, with a cancellable 35-second
connection/handshake timeout.
Agent Messaging uses the fleet switch and the current host access policy; the
retired per-host messaging flag is ignored. The account must have usable
managed engine configs and installed provider CLIs. Existing `cxx-agent`
message/auth workers remain separate. No incoming host port is opened.

The daemon authenticates an outbound WebSocket using the existing host key and
uses generation fencing and a private local journal. Starts are durable and
idempotent; losing an acceptance or result response never authorizes a second
execution. After ambiguous process loss the result is unknown, not success.
Eight remote turns may work concurrently by default; additional starts wait
at most ten minutes. Only one turn writes a native transcript at once. Idle
sessions close after 60 minutes, pending questions after 24 hours; host
settings override both. Heartbeats do not count as activity. Explicit resume
requires the same existing native transcript. Automatic recovery is separate.
From cxx 0.9.47, a daemon resume child recognizes the writer lock held by its
parent for that exact native ID. Other wrappers and native identity changes
still acquire their own lock.

MCP tools: `agent_spawn` takes `host_id`, `engine`, optional absolute `cwd`,
`title`, `prompt`, and stable UUID `client_message_id`. It returns
`operation_id` and logical `session_id`. `agent_spawn_status` reads that session
and its eventual agent address. Use existing messaging/calls for conversation.
`agent_stop` stops only helpers created by the calling agent; operators may
stop any remote session. Stop is cooperative, followed after 30 seconds by
SIGTERM and ten seconds later by SIGKILL to the owned process group. Offline
stops stay pending until the host reports exit. Host disable rejects new work,
drains accepted turns, closes idle sessions and stops the optional daemon.

Fleet Advisor tools (cxx 0.9.98; `engine`/`model` from 0.9.100: two different trees were both
versioned 0.9.99): `advisor_ask` (`question`, `kind`
verify|tier_check|classify|general, optional `transfer_ids`, optional `engine`/`model`
(default: strongest available; see `advisor_status`), optional
`advisor_session_id` for a follow-up, stable UUID `client_message_id`),
`advisor_close` (`advisor_session_id`; the caller's done confirmation) and
`advisor_status`. They post to `advisor/ask|close|status` under the session's
agent-messaging routes. Each advisor is a daemon session in the stack's hidden
`advisor` container; its answers arrive as ordinary peer messages headed `ADVISOR/1`.
The tools are served by the `cxx-agent` stdio server, not by the
orchestrator MCP. The managed `## Fleet Advisor` block is withheld while the installed cxx
or an executing host daemon's private copy is older than 0.9.100.
See [interface-api.md](interface-api.md#fleet-advisor).

Hosts show the daemon indicator only when enabled. Green means connected and
ready with capacity; yellow means pending installation, reconnect, partial
engine readiness or full capacity; red means unavailable or blocked. Heartbeats
are sent every 15 seconds, stale at 45 seconds and expired at 90 seconds. Initial
installation gets five minutes before becoming red. Browser disconnection
never leaves a stale green indicator. Tooltip/text exposes reason, last contact
and occupied/max slots. Engine readiness dots retain their separate meaning.

### Portal message receipts (cxx 0.9.43)

`agent_receiver_status(message_id, status)` records an explicit AI report for an
owned operator delivery: `read` confirms reading, `working` confirms handling has
started. The injected instruction requests this before handling. Transport acceptance
alone does not mark a message read. Status calls use stable event IDs, can be retried,
and do not release the delivery; `agent_receiver_reply` sends the correlated answer.
Web Chat and Android distinguish queued, delivered, read, working and replied.
Ongoing work requires a fresh matching active turn; older wrappers still show delivery
and correlated replies without inventing read receipts.

## Shared receiver ownership (cxx 0.9.44)

Native subagents can inherit the same launch MCP configuration. All automatic
MCP instances of that launch elect one receiver owner through a private Unix
socket and file lease beside the existing broker. Other instances forward tool
calls to that owner, sharing peer claims, Portal receipts and `agent_listen`
health. They never independently register a receiver generation. This prevents
`receiver_unavailable` and Portal ownership errors caused by a different MCP
instance answering a delivery. The contract is shared by Codex, Claude and Grok.
No additional network endpoint is opened.

Restart the launch's MCP instances together after updating; mixed old/new
instances do not share ownership. An owner exit releases its local lease and a
surviving instance may take over. Already accepted work is never automatically
replayed, and a lost process-local receipt still requires inspection of retained
server state. Server `ready` remains transport evidence, not proof of delivery
or a model reply.

### Daemon working directory

Remote starts use an explicitly supplied `cwd`, then the host daemon's configured
`default_cwd`. When both are empty or omitted, wrapper 0.9.51 resolves the home
of the daemon service user on that host. The systemd service also starts in that
user's home. Explicit paths must remain absolute and exist on the remote host;
an invalid explicit path fails rather than falling back. Registration retains
the resolved native working directory for subsequent resumptions. This applies
to WebUI, companion and agent starts for Codex, Claude and Grok.

### Persistent daemon on insecure hosts

The daemon stays connected outside an insecure access window and reports
`access: {allowed, reason, secure, enabled_until}` separately from transport
health. A connected, locked daemon is yellow (Online · Zugriff gesperrt).
Only status, heartbeat, stop and existing acceptance/result receipts are
allowed outside the window; new starts, offers, acceptance and resume require
an open window. Provider credential distribution retains its existing gate.

WebUI uses the existing host-window activation. Authenticated agents on any
active secure host may use `host_insecure_enable(host_id, duration_minutes?)`
through cxx-agent, for Codex, Claude and Grok alike. Duration defaults to the
target's stored value and is bounded to 0–480 minutes. Source host, agent,
session, target and duration are audited. Insecure callers cannot activate.

A fresh daemon heartbeat renews an already-open window to at least now plus
the stored host duration only for accepted, reported active execution or a
retained native conversation within its idle/question timeout. Queue entries,
unknown transcripts, stale generations and an idle daemon do not renew it.
Heartbeat renewal does not reset session activity or its timeout. Once the
last session ends, the remaining window expires normally. Manual Disable
fences renewal until an explicit enable/approval; accepted work may finish.
Natural fleet-window expiry preserves a later renewed host grant; explicit
fleet closure removes it. No automatic provider session or credential sync is
kept alive merely because the daemon is online.

## Session housekeeping

`cgx housekeeping status`, `cgx housekeeping run --dry-run`, and `cgx housekeeping run` inspect or remove local native sessions using the centrally signed/current effective policy. `--json` returns structured results; `--engine` selects an engine when using `cxx`. `cgx housekeeping pin UUID` and `unpin UUID` manage local protection. Automatic upkeep uses the existing cxx coordinator, at most daily after success; active engines retry on later maintenance ticks.

Default: enabled, 30 days inactivity, 5 GiB session files per engine/local user, with budget removal only after 7 days. Parent/subagent bundles share their newest activity and protection. Native pins, open goals/queued work, incomplete metadata and fleet resume/wake/recovery bindings are retained. Unknown database versions or schemas and unavailable protection skip deletion. An unknown native database layout is reported as `skipped (unsupported_native_database: <file>/<table>: missing <columns>)` in cron.log and to the central housekeeping report, and does not fail the maintenance run; an older Codex database left beside its newer supported version (e.g. `logs_1.sqlite` next to `logs_2.sqlite`) is ignored and never modified. Supported current native layouts are Codex state_5/thread_history_1/goals_1/queue_1/logs_2/memories_1 SQLite databases, Claude project transcripts/subagent artifacts/session indexes, and Grok native session directories plus external-content FTS search. General logs, provider auth/config and project memory files are not removed.

Removal uses an exclusive native-home guard and a host/engine reservation. A journal under the original native home's `.cxx-housekeeping` records quarantine paths and session IDs. Recovery resumes this cleanup, never native work; run `cgx housekeeping run` to finish it. Reservations do not expire automatically while native data may be inconsistent. The budget can remain exceeded by protected or young sessions; results state this instead of removing them.

## Planned reboot resume (cxx 0.9.54)

Read the shared code-managed `reboot-safe` Skill before preparing a reboot. Its
procedure includes recovery exclusion, exact transcript continuation and ownership
reconciliation; the Skill grants no additional authority.

From 0.9.56 the private Grok runtime exports `CXX_GROK_BASE_HOME` so reboot
checkpoints restore the durable native home. Disposable auth projections and
sockets are recreated normally, never restored from the previous launch.

`cxx reboot --request-id UUID --reason TEXT --stdin` and `agent_reboot` prepare
one Linux host reboot and resume the exact Grok native transcript once.
`agent_reboot_status`, `cxx reboot status [--id UUID]` and
`cxx reboot disarm --id UUID` inspect or remove an unconsumed hook. Requires
root/passwordless sudo and active cron. Consumption precedes cron removal and
native startup; no native retry or fresh session fallback. Accepted work retains
its original IDs. Watchdog/persistent Wake recovery conflicts are rejected.
From cxx 0.9.56, an early-boot IP-binding mismatch waits within the five-minute
readiness deadline for the bound network route; native startup is still one-use.
From cxx 0.9.64, an installed tmux in the original user's restored PATH runs the
continuation as a detached interactive session. `cxx reboot status --id UUID`
reports `execution_mode`, `tmux_session` and the `attach_command` (including its
request-specific `-L` socket label). The initial checkpoint is submitted once;
detach preserves the running CLI. Without tmux the existing headless path remains.
Startup failure never retries native execution. Interactive work results require
explicit receipts; terminal output and exit zero are not task-success evidence.

See [the full reboot contract](reboot-resume.md) for state, failures and recovery.
## System Spawn and daemon deadlines

Server MCP exposes `host_spawn_prepare` / `host_spawn_status` to provision new systems from active VIP hosts when the fleet System Spawn switch is on. See [System Spawn](interface-api.md#system-spawn-new-system-provisioning) for setup and retry contracts. All engines use the same installer and optional system daemon. Wrapper 0.9.53 records timed daemon deadlines locally, fences new work after expiry and drains accepted work/results before exiting; reconnects and reboots do not renew the deadline. Provisioning itself never launches an agent task.

Wrapper 0.9.55 renders the optional Linux daemon service with `WorkingDirectory=~`, so systemd resolves the configured service user's home directly (including homes containing spaces).

## Rich operator agent chat (cxx 0.9.57)

All three engines share five local MCP tools in managed lifecycles: `agent_portal_ask`, `agent_portal_notify`, `agent_portal_resolve`, `agent_attachment_upload` and `agent_attachment_get`. Reply tools also accept `attachments`, `reply_to`, `severity` and `notice_id`. The scope is the existing operator agent conversation; see [Agent chat](agent-chat.md).

`cxx portal ask --question "Deploy this release?" --summary "Choose the release" --answer-mode buttons --choices '[{"label":"Approve","value":"approve"},{"label":"Cancel","value":"cancel"}]'` creates a normal question. Use `--answer-mode text` or `both` for free text. `--attachments '["UUID"]'` accepts already sealed attachments. `cxx portal notify --severity blocker --notice-id UUID --summary "Waiting for the release decision"` creates explicit Needs you. `cxx portal resolve --notice-id UUID --summary "Release reviewed"` clears only that notice. MCP operations require stable caller-generated event/prompt/notice/upload UUIDs retained on retries. The CLI retains its existing invocation behavior.

`agent_attachment_get` returns a protected local path plus metadata/processing state. Read original images with native image tools; fetch `transcript.json` for local ASR and `frame-NN.jpg` for video inspection. Originals survive preparation failure. Update the wrapper and start/resume a managed lifecycle to load the new tool catalog; existing running older wrappers continue with their old catalog.

### Native chat activity (cxx 0.9.60)

Grok uses a second passive stdio registration with the private leader and reads `_x.ai/sessions/list` for the exact bound resident session every two seconds. Native `working`, `idle` and `needs_input` map to Working, Idle and Waiting for input. Dormant, dead, unloaded and unfamiliar values map to Unknown; an unspecified input wait is not labelled as a proven approval. This connection never submits prompts or responds to approval requests.

Activity reporting requires an automatic receiver and the server `activity_v1` capability. Disabled/unsupported adapters remain Unknown. Transitions are reported immediately after observation and refreshed every 15 seconds; network failures do not stop reception or the engine. Evidence expires after 45 seconds. Activity is independent of transport readiness, portal delivery receipts and watchdog/work outcomes. Upgrade the API first; see `interface-api.md` for the additive contract.

## Sync and cleanup recovery (cxx 0.9.61)

Housekeeping launch guards are inherited by native children, including help and
Codex's app-server, so wrapper SIGKILL does not free an active child's fence.
Process scans preserve executable paths containing spaces and recognize native
shell/env/node launchers. Activity is checked again after reservation and during
recovery. Raw unwrapped CLIs do not honor the flock; process scans reduce the race
but cannot atomically prevent a new unwrapped launch.

Version-2 cleanup journals mark the indexing boundary durably. If an interrupted
move finds a changed original before indexing, recovery restores missing originals
without replacing reappeared files, keeps conflicting copies in quarantine with
a recovery receipt, and releases the launch fence. Once indexing may have begun,
ambiguous state stays fenced for manual recovery; transcripts are not blindly
overwritten or discarded.

Skill directory replacement uses atomic directory exchange on Linux and macOS,
with synced staged content. A filesystem without exchange support returns an
error while preserving the existing directory; it does not use a two-rename gap.

The Grok skill store records a synced publication intent before exposing a new
bundle and commits its ownership before beginning another. Recovery recognizes
only the directory inode originally staged by that operation; an identical-content
user directory does not grant ownership. Interrupted first installs therefore
recover without abandoning an unrecorded live skill.

Managed Grok config updates serialize config and ownership publication with a
hash-only pending journal. Recovery recognizes the old or proposed value by its
digest while preserving intervening user edits; it never stores a second copy of
MCP credentials in the journal.

Private runtime and login directories have an independent cleanup process ready
before credential publication. It retains inherited session guards and waits for
private-directory holders before removal. On Linux, matching private-home process
environment also protects native children that close inherited descriptors. A
later maintenance sweep only removes marked directories whose locks and process
checks are idle. This does not claim cleanup while the host is powered off.

Managed content sync takes an exclusive lock, then each parallel native runtime
holds its own shared lease through native exit. `--allow-concurrent-sync` permits
writes despite these leases and is forwarded through sync, update and cron.
Maintenance respects native-download disable and `CGX_GROK_BIN`; old managed
prefixes are reclaimed only on a later idle tick. Explicit trust loss removes
recorded fleet skills, unchanged owned config and unchanged managed AGENTS while
preserving user edits. Ordinary network failure retains the last synced content.

## Orchestrator Feedback

With Skills enabled, managed Skills guidance automatically invokes the shared stored
`fleet-reflect` Skill once before each final work response or managed work-result
delivery, including failed or blocked work. Progress messages, acknowledgements and
result retries do not repeat the review. Codex and MCP-enabled Claude load it through MCP;
Claude without usable MCP and Grok use their native synced Skill files. The Skill reviews observed orchestrator/tool
experience, searches reports across statuses, appends materially new evidence or
submits an actionable bug, feature or usability report. No finding means no report
or extra final-response paragraph. Disabled/unavailable feedback leaves useful
findings pending without bypassing the setting or delaying the original result;
reflection does not authorize fixes or deployments. The manifest is published via
`skill_store` (review copy: `docs/skills/fleet-reflect.SKILL.md`); the automatic trigger
requires the API change and the host's next instructions sync. This is agent guidance,
not a runtime completion hook or a background schedule.

**Model Class Check.** The fleet switch `model_tier_check_enabled` (default on; `GET`/`POST /admin/model-tier-check`, Settings → Agents) appends a final `model_tiers` section to managed AGENTS.md/CLAUDE.md/Grok AGENTS.md for Codex, Claude and Grok. It names the host's configured model and tier (host override, then fleet config, then engine default; Claude reports none when unpinned) and a tier table of the latest, non-disabled models of the host's active engines (`activeHostEngines`, so fleet-suspended engines are never recommended). Tiers live in `api/src/services/model-tiers.ts`: 1 Haiku/Luna/Grok 4.6, 4.5, 4.7-build-fast; 2 Sonnet/Terra/Grok 4.7; 3 Opus/Sol; 4 Fable/Astra. An agent one tier below the task states `Underclassed: …` with a recommended model and proceeds; two or more tiers below, it stops before starting, reports that line and finishes accepted work as `blocked` unless the operator explicitly asked this model to proceed. Classify the whole assignment before task-specific scouting or planning: whole-stack cleanup assessment, including “scout and prepare”, is Tier 4. All four task definitions remain visible even when a host has no model at that tier. An override must explicitly acknowledge the identified mismatch; model selection or the original task request does not count. Tier 3/4 work states task tier, model tier and a reason. This is agent guidance, not runtime admission enforcement. Only a concrete session model overrides the configured model; a generic “GPT-6” label does not make configured Luna unknown. An unknown model never aborts. Changes apply on the next sync.

The independent central inbox provides `feedback_submit`, `feedback_list`, `feedback_get`, `feedback_claim` and `feedback_update` across Codex, Claude and Grok. The fleet switch `feedback_enabled` defaults off, hides tools during discovery and blocks calls while disabled. Enable it under Feedback in the WebUI (`/admin/feedback/state`); managed AGENTS.md/CLAUDE.md/Grok AGENTS.md dynamically gain the workflow on the next sync only when usable managed MCP configuration exists. Disabling removes that section on sync without changing canonical authored rules or deleting reports.

Claims are exclusive, token-fenced and renewable for 30 minutes. Updates check the item version and append history. Resolved requires a fix reference and verification evidence; deployment is recorded separately. Host/engine attribution is authenticated; optional agent UUIDs are descriptive. Admin routes use `feedback.read`/`feedback.manage`. No agent is started and no merge or deployment is implied. See [MCP workflow](MCP.md#orchestrator-feedback-workflow) for request/response contracts.

## Automatic repository delivery (cxx 0.9.62)

With Git Director enabled, agents check `git_list` then
`agent_list(scope:"checkout", online:true)` before edits. Checkout scope counts
other active sessions sharing the same host and Git root, including subdirectories
but excluding linked worktrees. Incomplete coverage or a mismatched `checkout_root`
is unknown occupancy. Occupied/unknown checkouts use a private task worktree;
verified task changes are always committed, then merged back under a Director
lease into the original clean branch. Failed or deferred integration retains the
result; ancestry proof gates cleanup and prevents duplicate merges on retry.
Read-only and explicit restrictions take precedence; push/deploy are separate.
This is agent-executed guidance shared by all three engines, adopted on the next
sync/launch, not wrapper-enforced automation. See
[Automatic repository delivery](interface-api.md#automatic-repository-delivery).

## Configuration scope and client compatibility

See [native configuration scopes](NATIVE_CONFIG_SCOPES.md) for the exact central
authoring boundary, native version requirements and the Codex profile editor.


## Shared CoCo communicator (cxx 0.9.72)

The optional signed `orchestrator.communicator_protocol: 1` capability routes managed
CoCo traffic through a per-user Unix socket and one multiplexed server WebSocket.
Provider traffic, session identities and account/refresh ownership retain their existing
contracts. See [communicator protocol, lifecycle and rollout](communicator.md).

Grok binds its verified selected config before creating control clients, including
after expiry recovery or custom `--config` selection. The cxx 0.9.78 startup
regressions verify this boundary alongside the matching Codex/Claude behavior.

From cxx 0.9.74, managed MCP errors preserve the original request ID and bounded
`code`, `http_status` and `outcome_unknown` data. Unknown or invalid replies require
result verification before retrying with the original work identifiers. The stdio
adapter never replays a call. From cxx 0.9.91 the data also carries `retryable`, true
only for a local `503 communicator_unavailable` (the request provably never reached the
orchestrator, e.g. while the control connection redials), so the caller may simply retry.


### Communicator sync ownership

From cxx 0.9.73, signed `orchestrator.communicator_sync_protocol: 1` enables
central scheduling of finite startup/content operations and active-session auth
convergence. Enable `CXX_COMMUNICATOR_SYNC_ENABLED` alongside the existing transport
flag. Native login, account assignment, refresh ownership and session lifetimes
retain their engine-specific contracts. Broad session-lifetime sync pauses are
replaced by short native-home fences; local credential changes and server auth
invalidations converge through the existing validated writers. Local materialization
is reported separately from native adoption. Signed rollback drains auth work and
hands polling back to the existing wrapper without restarting the native CLI.
See [Communicator ownership and rollout](communicator.md#central-sync-ownership-cxx-0973).
From cxx 0.9.96 a content pass that changes `~/.grok/AGENTS.md`, the native
Skill manifest or `config.toml` while a session runs produces a per-session
content-change notice at the next agent MCP tool result; see
[Content-change notices](communicator.md#content-change-notices-cxx-0996).

## Resident communicator workstream

The independent, default-off signed `communicator_runtime_protocol: 1` prepares
`cxx communicator run` as the persistent owner for transport, content sync and
the existing remote execution controller. Residence and remote starts have
separate settings; native auth/account locks and engine-specific refresh ownership
remain in their existing lifecycles. See [runtime, migration and acceptance](communicator-resident-runtime.md).

### Native process stop (cxx 0.9.85)

Managed native launches expose a launch-scoped stop capability only after their owned child starts. Live Topology can request TERM followed by KILL after five seconds. The wrapper signals only its own child or owned process group, never an inherited terminal process group, and reports exit only after Wait. The same channel works during a model turn. Old servers disable this optional polling with 404; old wrappers offer no native capability. See [native control endpoints](interface-api.md#live-topology-endpoints) for identity, recovery and receipt semantics.

## Direct agent conversations

From cxx 0.9.88, two-agent exchanges use `agent_send`, `agent_request`, and
`agent_reply` with a peer name or address. The call rendezvous tools and CLI
commands are removed for all engines. Conferences retain their room PINs and
chair-managed task lifecycle.


## Current model policy

Engines → **Current models → Only current models** is an independent switch for
each engine, off by default. It keeps the highest numeric version of each family
in the maintained fleet catalog. Codex Sol, Astra, Luna and Terra remain separate;
Claude Fable, Opus, Sonnet and Haiku remain separate; Grok standard and Build Fast
remain separate variants. A family stays available even when another family has
a newer generation.

WebUI model choices, gateway catalogs and signed launchpad menus use the same
policy. New managed CLI starts and inference requests upgrade old known IDs to
their family successor, including defaults, host overrides, profiles and explicit
model arguments. Saved preferences are not migrated; disabling the switch exposes
them again. Unsupported effort falls back to the successor's default; valid
session-only effort remains available. Unknown model IDs are refused when enabled.
Manual model disables apply to successors; no older-generation fallback is used.

The signed `engine_options.model_policy` contains `engine`, `latest_only`,
`latest_models`, `replacements` and optional `disabled_models`; the accompanying
`model_catalog` lists current available launch choices. Enforcement requires
cxx 0.9.94 or newer and the next successful configuration sync. Offline starts
use the last valid signed configuration. Running sessions, their native model
changes and direct provider binaries outside managed entrypoints are unchanged.

## Binary file transfer (cxx 0.9.93)

The shared `cxx transfer put FILE` / `get ID --output FILE` commands use this
engine via its alias or `--engine`. Bytes stream through the orchestrator with
`--resume`, SHA-256 verification and optional limits defaulting to unlimited.
See [file-transfers.md](file-transfers.md) for CLI, HTTP, journal and rollout contracts.

Managed portal shutdown closes the local broker, then sends the terminal report
with one four-second remote budget shared by retries. The terminal report also
closes the relay; there is no preceding close-heartbeat request. An explicit
`agent_session_finished` response means the session already ended remotely and
needs no warning. Other conflicts and transport failures remain errors. Error
codes are read from both top-level and nested API envelopes.

SessionEnd watchdog observations are collected locally and carried by the
supervisor's terminal report rather than making an API call from the exit hook.

### macOS background worker domain (cxx 0.9.102)

The shared cxx worker installs new LaunchAgents in `user/<uid>` with `LimitLoadToSessionType` including `Background` and `Aqua`. This permits SSH-only operation without a GUI login. An existing loaded GUI job is retained for upgrades, status and removal; an existing user-domain job takes precedence. Routine ensures do not kill an unchanged running job. Changed deployments wait up to 15 seconds for bootout to deregister the previous job before bootstrap.

## Session scope coordination (protocol 1)

See [Session scopes, rooms and resource claims](agent-coordination.md) for the
automatic host/project check-in, room APIs, claim lifecycle, engine parity, grouped
agent graph, migration 0078 and rollout/rollback contract. cxx 0.9.103 introduces
`agent_context_get/update`, `agent_room_list/read/send`, and
`resource_claim_acquire/status/release` on the session-bound cxx-agent MCP server.
The feature starts disabled and never grants permission for the reserved action.

### Shared room chat (cxx 0.9.104)

`agent_chat_list`, `agent_chat_read` and `agent_chat_send` expose the same member-authorized shared groups, conferences and project/host conversations for all three engines. Keep `client_request_id` stable on retries; `reply_to` is the shared event UUID. Agent contributions do not wake peers. Only explicit operator recipient requests start answer rounds. Room file upload/get accepts `room_id`; unsent uploads remain author-private. See [Shared conversations](agent-chat.md#shared-conversations-in-agents--chats) for lifecycle, permission and delivery semantics.

## Agent roles (cxx 0.9.108)

Contract: [agent-roles.md](agent-roles.md). The module switch `roles_enabled` (default off) and cxx ≥ 0.9.108 gate the `roles` Skill and the short `## Agent Roles` block in the managed Grok AGENTS.md. Catalog and content come from the orchestrator MCP (`role_list`, `role://`); `agent_role_activate`, `_current`, `_release`, `_propose`, `_proposals` and `_review` are `cxx-agent` tools that forward to `/host/agent-sessions/:id/agent-messaging/roles/*` through the broker. A role grants no permission and changes no Grok sandbox, approval or tool setting.

- **Identity and pinning.** The assignment hangs on the agent address, so `cgx resume` of the same transcript keeps role and version; a fresh launch has none; a rebind with `continuity = reset` ends it.
- **Session title.** The receiver's session-name reporter writes the native title as `(Name) (Label) task` and reports `(Label) task` to the server; a switch or release strips the old label.
- **After compaction or resume.** Grok's SessionStart payload (`sessionId`) gets no anchor until its hook output is verified to inject context; the managed guidance (`agent_self`, then `agent_role_current {include_core:true}`) is the path, as on Codex. The `roles` Skill is synced natively to `~/.grok/skills/roles` while the module is on.

### Peer backlog presentations (cxx 0.9.110)

Receivers advertise `capabilities.peer_batch_v1: true` alongside `queue_delivery_v1`.
With `CXX_PEER_BATCH_V1_ENABLED=true` (default), this negotiates full-content batching
independently of the opt-in preview digest flag and its host allowlist. Older receivers
retain their previous behavior. Set the new flag to `false` and recreate the API to
roll back this presentation policy.

When at least two untouched non-work messages wait and the oldest is at least 60 seconds
old, the receiver claims one `kind: digest` presentation with
`content.presentation: peer_batch_v1`. It owns the complete waiting backlog and initially carries up to 20 complete originals
within 12,000 UTF-8 JSON bytes, including sender, original message/conversation/reply IDs,
creation time, delivery class and full content. A non-null `next_after` requires reading the remaining originals through paginated
`agent_digest_get` in the same turn, including oversized entries; no content is truncated. This groups transport turns; it does not infer that a status is obsolete,
truncate answers, or silently acknowledge already-inspected messages. Advisor answers
are coordination and participate with every answer/turn intact. `advisor_status`,
`agent_wait` and message reads remain read-only.

Questions and coordination in a batch still require handling. Reply to the original
message ID, never the presentation. Call `agent_listen` once after handling all entries;
it releases only the presentation and leaves accepted work held. Work requests, wakes,
tasks, and replies to work (progress or results) retain individual delivery. Coordination
priority and FIFO position use the earliest original at that priority's dispatch order. Retained originals
are `batched` then `digested` on presentation acceptance, with no fabricated completion
or delivery attempts; `agent_message_get` and `agent_digest_get` retain full audit access.
Unpresented canceled/expired presentations or policy rollback restore eligible originals;
accepted or uncertain presentations never replay them. A receiver already running an
older wrapper must reconnect with cxx 0.9.110 to negotiate this behavior. Browser/OS
notification totals remain client-specific; the bound is on peer continuation deliveries.

## Account quota lifecycle (cxx 0.9.112)

`quota_get` on cxx-agent reports the current lifecycle's bound provider account, short/long usage, reset, freshness and effective quota policy. Check before heavy workloads and large delegations. Start a new managed lifecycle through the updated wrapper to supply the verified provider lease binding; older sessions return unavailable. Engine defaults and complete account overrides configure warnings and short/long auto-resume independently. PayG/unlimited suppresses quota actions, including existing startup blocks. A quota warning only requests a checkpoint. Confirmed quota interruptions use existing Watchdog recovery for the same native transcript on persistent hosts, with bounded retries and no fresh-session fallback. Native subagent restoration depends on the native parent's resume implementation; no independent helpers are spawned. See [API contract](interface-api.md#account-quota-warnings-and-reset-recovery-cxx-09112).

## Workflow clarification (cxx 0.9.114)

cgx advertises `workflow_protocol_version: 2` through the shared native bridge.
New runs remain pending for freely defined input questions and optional follow-ups.
The coordinator presents a saved summary, records explicit user approval of its
revision (or observes web approval), then starts execution. Answer changes invalidate
approval; recovery never bypasses it. Existing protocol-1 agents may still finish
historical runs with `preparation: null`. See [workflow contracts](workflows.md).
