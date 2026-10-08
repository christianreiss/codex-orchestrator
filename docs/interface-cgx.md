# cgx — Grok Build fleet wrapper

## Managed native starts (cxx 0.9.24)

Fleet installation, update/sync and successful managed launches prepare the native
`codex`, `claude` and `grok` command names for assigned engines. Per-user scripts
under `~/.cxx/native-bin` invoke `cxx native <engine> -- <native arguments>`;
managed Bash, Zsh and Fish PATH blocks activate them in new shells. Existing
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
credential values. See [MCP verification](grok-mcp-verification.md).

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

## Native CLI and installation

The supported baseline is official Grok Build **1.0.46**. Linux and macOS on
amd64 and arm64 use exact-version official npm native packages
`@xai-official/grok-{linux-x64,linux-arm64,darwin-x64,darwin-arm64}`. The installer
verifies sha512 `dist.integrity` before extracting only `package/bin/grok.br` and
decoding Brotli. It does not run npm lifecycle scripts. A verified private CLI
lives below `~/.cxx/engines/grok`; updates retain the previous installation.
Grok's native self-updater is disabled for managed processes.

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

Quick Settings saves the context window immediately through
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

## Skills

Grok Build loads `~/.grok/skills/<name>/SKILL.md` natively, with the same
frontmatter Claude Code uses. `/sync/bootstrap` for `engine=grok` returns
`grok_skills`, the complete live set of shared and Grok-scoped Skills, and cgx
installs it exactly like clx installs `claude_skills`: every bundle is verified
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
unknown, never 0%. Monthly or untyped periods are not labelled weekly. This
does not introduce wrapper quota reporting, account balancing by Grok quota, or
automatic purchasing. The provider-owned billing endpoint may change; source
contract: [official CLI billing handler](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-shell/src/extensions/billing.rs).

## Startup and checks

`cgx` prints the shared startup card before the native UI, with the effective
model/effort, installed and target versions, API/auth/runner health, measured
content-sync outcomes, and the server's fleet sync activity. Actual native
model and effort options override the displayed settings. Grok quota usage is
shown as unavailable, and MCP connectivity remains unknown until probed;
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
  maintenance so the coordinator re-bakes the config instead of waiting for the 15-minute tick.
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

`/auth` returns the access-only envelope with `canonical_generation`,
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
The bridge tracks current/previous issued token digests and generations so a
heartbeat's newer fetched head cannot misidentify the bearer actually held by
the native process. `GROK_AUTH_EXPIRED=1` triggers generation-aware renewal.

## Native receiver and worker

Cxx 0.9.25 decodes the native SessionStart `sessionId` after reading the hook JSON
and also accepts `session_id`. The shared MCP tools preserve send/request/call
retry IDs and expose a saved send receipt when only its subsequent wait failed.
Automatic `agent_listen` releases finished delivery, checks health and yields;
background workers retain their accepted lease through result storage. See
[delivery reliability](interface-api.md#delivery-reliability-cxx-0926) and the
[2026-10-08 lifecycle audit](agent-messaging-audit-2026-10-08.md).

From cxx 0.9.20, Grok exposes the same seven group/subscription MCP tools as
Codex and Claude: `agent_group_list`, `agent_group_create`, `agent_group_members`,
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
From cxx 0.9.26, reconnecting the native transport within the same MCP process
retains outstanding work for the same native identity without resubmission.
Peer renewal continues; uncertain peer/Portal result receipts keep the original
payload, and concurrent completion tools serialize. Process loss and revoked
leases keep their existing ambiguous-outcome handling. See the
[shared reliability contract](interface-api.md#delivery-reliability-cxx-0926).
Explicit unmanaged `--no-leader` or custom socket launches report receiver
unavailability honestly. The receiver never answers native permission requests.

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

The shared `wake-cron` Skill and `schedule_*` MCP tools support scheduled prompts and explicitly requested persistent native-session recovery. cxx 0.9.21 uses the existing per-user background worker, original cwd and engine-specific native resume adapter. A missing native transcript blocks recovery, without a fresh-session fallback. Linux supervision may terminate only its own child after a configured progress timeout and fresh policy/binding checks; active child tools and open operator prompts are protected. See [scheduling contract](interface-api.md#agent-wake--cron-schedules).

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
include the same result and completes work atomically with the reply. A result contains
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
