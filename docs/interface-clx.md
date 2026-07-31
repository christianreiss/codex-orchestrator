# `clx` Wrapper Interface

Source-of-truth contract for the `clx` wrapper (Claude Code fleet wrapper).
Mirrors `docs/interface-cdx.md` with engine-specific deltas called out explicitly.

## At a glance

| | `cdx` (Codex) | `clx` (Claude) |
|---|---|---|
| Wrapper binary | `cdx -> cxx` Codex persona; legacy `cdx-<major>.<minor>.<patch>` is compatible | `clx -> cxx` Claude persona; legacy `clx-<major>.<minor>.<patch>` is compatible |
| Built by | `cd wrappers && make cxx` | same common build |
| CLI under the hood | `codex` (Rust) | `claude` or `claude-code` (Node, `@anthropic-ai/claude-code`) |
| Auth file | effective `CODEX_HOME/auth.json` (default `~/.codex/auth.json`) | `~/.claude/.credentials.json` |
| Config file | effective `CODEX_HOME/config.toml` (default `~/.codex/config.toml`) | `~/.claude/settings.json` (JSON) |
| Agents document | `AGENTS.md` | `CLAUDE.md` |
| API key prefix | `sk-codex-` | `sk-claude-` |
| Admin API endpoints | `/v1/*` + `/admin/openai/*` | `/anthropic/v1/*` + `/admin/claude/*` |
| Engine in config | `engine: "codex"` | `engine: "claude"` |

## Build + Publish

- `clx` is the Claude persona of the static `cxx` Go binary built from `wrappers/cxx/cmd/cxx`; the installed `clx` path is a relative `clx -> cxx` symlink. During legacy self-update migration, a `clx-<major>.<minor>.<patch>` filename selects the same persona.
- The current source version, including complete directory-backed Skill sync
  and the scoped agent-portal lifecycle, is **cxx 0.7.6**.
- Build locally with `cd wrappers && make cxx`; `cd wrappers && make release` only stages the complete cross-platform matrix under `wrappers/bin/release`.
- Publish that staged matrix explicitly with `cd wrappers && make publish-release`; set `OUTROOT` for an extracted CI release fragment and `PUBLISH_ROOT` for a non-default served store. Publication validates the complete incoming matrix before its first served payload write.
- New publication writes only `storage/wrapper/v2/bin/cxx/<os>-<arch>/v<version>/cxx`. On compatible old per-engine URLs, exact historical split bytes win when present; otherwise the URL may stream the matching published `cxx` bytes for pre-migration clients.

## CLI surface

| Subcommand | Purpose |
|---|---|
| `run` (default) | One Claude session; runs the full startup sequence first |
| `status` / `--status` | Responsive local config + `/auth` round-trip (API, auth, and reported runner health) on stdout. Returned canonical credentials can seed/repair the local file but replace a fresher usable local login only when that exact candidate was definitively rejected and the canonical is verified; unreadable config/marker state and failed health return a structured non-zero report. |
| `doctor` / `--doctor` | Responsive self-diagnostic (config, paths, CLI, usable credentials, parsed settings/MCP state, HTTP reachability, latency, disk, cron) on stdout; an unreadable signed config is rendered as a blocked diagnostic instead of bypassing the terminal UI |
| `auth-upload` | Stabilize and POST native `~/.claude/.credentials.json`; apply the authoritative response only if that native generation is still current |
| `auth ...` | Passed through to upstream Claude under the active-child/session leases. `auth login` uploads the resulting generation and applies guarded canonical writeback; `auth logout` journals durable intent before destructive native mutation; `auth status` remains read-only passthrough. The top-level `login`/`logout` aliases follow the same rules. |
| `exec -- <cmd...>` | Bypass startup sync; run a single Claude command |
| `--continue` | Passed straight through to the upstream `claude` binary |
| `resume [<session>] [<prompt>]` | Reopen a previous Claude session through the normal startup lifecycle. With no session id, the upstream picker is shown |
| `--resume[=<session>]` / `-r` | Alias for the `resume` subcommand above — the session is optional, and a following option is never consumed as its value |
| `execute` / `--execute "<prompt>"` | Headless one-shot via `claude -p`; the boot screen is suppressed but auth + resource sync still run. `--execute` is the spelling that carries the prompt; the bare `execute` token dispatches the same path with an empty prompt and its own trailing arguments appended |
| `--dangerously-skip-permissions` | Passed straight through to the upstream `claude` binary for this run only; lights an explicit warning badge (`warning` row in `--minimal`) without misreporting the launch as failed. Not persisted — the fleet-managed `permissions.defaultMode` in `settings.json` is unaffected. For a durable fleet-wide bypass use `permissions.defaultMode: bypassPermissions` via `/admin/claude/config` instead |
| `--help` / `-h` / `help` | Passed straight through to the upstream `claude` binary without running auth/sync/boot. It skips the managed run lock but keeps a neutral auth session plus the native-auth active-child lease until the help child exits, so another insecure invocation's final purge cannot be stranded. A bare leading `help` token is normalized to `--help` first, because upstream `claude help` treats `help` as a prompt and opens an interactive session instead of printing help. Wrapper-only `--minimal`/`--minimal-output` is consumed rather than forwarded as an unsupported Claude flag. |
| `--wrapper-help` | Render the wrapper-owned commands and flags without loading config; never intercepts tokens after `--` |
| `cron [install\|remove\|run]` / `--cron [install\|remove\|run]` | Forward to the host-wide `cxx cron` coordinator. It owns one schedule (`# cxx-managed-cron`, system fallback `/etc/cron.d/cxx-managed`), removes historical persona schedules, validates each signed config's host/engine membership, and runs each enabled engine tick exactly once. Config wrapper metadata may differ during rolling refresh and is not a coordinator gate. The first upgraded legacy cron tick migrates itself to the shared schedule. Privileged system install/remove discovers every actual owner represented in the standard cron spools. A strictly validated spool filename remains authoritative when the static wrapper's Go `os/user` lookup cannot resolve an NSS/SSSD-only account; config-owner/sudo/current/root safeguards remain lookup-validated. The coordinator snapshots each crontab, removes only lines ending in an exact cxx/cdx/clx managed marker, and restores every changed crontab if cross-user or legacy-system cleanup fails; install also removes its new system entry. Explicit minimal mode stays ASCII throughout. |
| `--version` / `-V` / `--wrapper-version` / `-W` | Print version + commit + embedded pubkey status |
| `update` / `--update` | Self-update now (verifies SHA256 before swapping) |
| `uninstall` / `--uninstall` | Take the native-auth exclusive maintenance lease, remove Claude-local credentials/state, and request engine-scoped server deletion. An authoritative response with Codex remaining removes only `clx` and retains `cxx`, `cdx`, and the shared cron; confirmed last-engine removal deletes both aliases, `cxx`, and the cron. Offline, non-2xx, or malformed responses preserve every shared artifact. Refuses while another clx auth session is active, on a known multi-user host without sudo, or when user lookup fails without root/passwordless-sudo fallback. |

No `lane`/`profile` subcommands — Claude has neither in this orchestrator.

Interactive terminals at least 40 columns wide use the same responsive outcome,
context, version, and semantic-health card as cdx, with a violet CLX identity.
Redirects, dumb/narrow terminals, and `--minimal` use deterministic ANSI-free
ASCII with local-to-target versions. The measured exit footer uses the real
process exit, duration, Claude version, and auth-upload result; an auth failure
cannot hide under a green exit-zero headline. Dynamic values are terminal-
control stripped and width-bounded. Boot/status result text is capped at three
rendered lines, and narrow update rows retain the outcome before version
metadata. Explicit `--minimal` applies consistently to wrapper help, status,
doctor, cron/peer-update output, startup, and the exit footer. For upstream help
passthrough, the wrapper consumes that presentation flag before executing
Claude's supported help argv.

Health markers are evidence-based: a successful unchanged resource check is
green, an actual local write adds the updated marker, a failed best-effort
skills/config check warns, and an unperformed check is dim. Resource-sync
failure remains non-fatal but changes the overall result to attention. In a
concurrent launch, neutral `SYNC PAUSED` replaces the misleading read-only
headline; normal contention needs no operator action and warning colour is
reserved for actionable conditions. Managed content/update writes pause, auth
freshness remains active, and the API/auth/runner health markers stay visible. The pause explanation appears
once in SYSTEM; a distinct result/error still receives the normal footer.

The context line shows the effective Claude model and effort. A signed
`claude_model_override` wins; an inherited `ANTHROPIC_MODEL` is the runtime
fallback, followed by response/local settings when neither supplies a model.
Any missing field falls back independently to `model` or `effortLevel` in
`~/.claude/settings.json`, and an effort-only value is still shown. When
`/sync/bootstrap` supplies its compatibility `sessions` object, the `ACTIVITY`
section matches cdx: `local procs` is the same-UID `clx` wrapper process count,
`hosts 30m` is distinct hosts with an `agents.retrieve` event in the prior 30
minutes, and `syncs UTC day` / `syncs UTC month` are event totals from those UTC
boundaries. They are not launch/concurrency counts; older servers omit the
section without a misleading zero-only block.

`clx doctor` parses `settings.json` and `.claude.json` rather than accepting
matching text, requires the exact non-empty `mcpServers.clx` object, and rejects
credential files with no usable Claude token. Only an HTTP 2xx API response is
healthy; unreachable requests also fail the latency row instead of displaying
a green dash.

The wrapper strips any inherited `CLAUDE_CONFIG_DIR` so a foreign account cannot
override the verified native credential, but it does not re-export the variable
or put it into its temporary auth settings overlay. Claude's normal
`~/.claude` location remains authoritative for credentials and interactive
state, preventing an otherwise valid synchronized login from reopening the
first-run theme or login flow.

On normal startup, managed hosts install the server-advertised `clx` wrapper
artifact first, finalize that invocation's auth session (including any final
insecure purge), re-exec the original argv after a successful swap, then repair a
stale Claude Code CLI; an already matching Claude Code version is a no-op even
when the fleet policy is an exact pin. Root-owned wrapper installs use the same verified
temp-file plus `sudo -n install` fallback as explicit `--update` and cron runs.
Update activity for the wrapper, Claude CLI, and peer `cdx` install uses the
compact `↻` / `✓` / `✗` status line; it is coloured only on interactive
terminals, stays escape-free with `NO_COLOR`, and uses width-bounded ASCII when
redirected, on `TERM=dumb`, or under explicit `--minimal` (including an update
initiated while reconciling the peer wrapper). After `npm install -g`, `clx`
verifies that the Claude executable is runnable. If npm left the package's
postinstall fallback stub in place, `clx` runs the package's documented
`install.cjs` recovery hook and fails the update if no usable CLI results.

## Environment variables

Every `CLX_*` / `CDX_*` variable the `clx` binary reads. The list is enforced
against the wrapper sources by
`api/test/unit/contract/wrapper-env-surface.test.ts`; a knob the binary reads
but this table omits fails the API suite.

| Variable | Effect |
|---|---|
| `CLX_CONFIG_PATH` | Absolute path of the signed host config, ahead of `$XDG_CONFIG_HOME/codex-orchestrator/clx.json` and the `~/.config/...` default. The detached signature is still read from `<path>.sig` |
| `CLX_CLAUDE_BIN` | Absolute path of the upstream `claude` CLI, used ahead of the path cache and the `claude` / `claude-code` `PATH` lookup. An inaccessible value is an error, not a fallback |
| `CLX_SKIP_BANNER` | `1` forces the compact ASCII boot screen even on a rich interactive terminal |
| `CDX_CONFIG_PATH` | Peer reconciliation reads the same override as `cdx` when deciding where to write the peer's signed `cdx.json` |

There is no `CLX_CLAUDE_INSTALL_DIR` counterpart to cdx's
`CDX_CODEX_INSTALL_DIR`: Claude Code is installed through `npm install -g`, so
its location follows the npm prefix. Other variables affecting a run are
engine-level rather than wrapper-owned: `CLAUDE_ALLOW_FQDN_MISMATCH`,
`CLAUDE_FORCE_IPV4` / `CODEX_FORCE_IPV4`, `ANTHROPIC_MODEL` (runtime model
fallback), the inherited `CLAUDE_CONFIG_DIR` the wrapper strips,
`CODEX_ORCH_PEER_SPAWN`, and the usual `NO_COLOR` / `TERM` / `COLUMNS`
presentation variables.

The shared cron coordinator sets `CXX_CRON_COORDINATED` and
`CXX_CRON_ENGINE_ONLY` only on its own persona children to prevent recursive
coordination. They are internal protocol markers; operators must not set them.

## Per-host config (typed, signed)

Same schema as cdx (`wrappers/schemas/host-config-v1.json`), with
`engine: "claude"` and a Claude-shaped `engine_options` block:

```jsonc
{
  "schema_version": 1,
  "engine": "claude",
  "engine_options": {
    "silent": false,
    "claude_model_override": "claude-sonnet-5",
    "admin_theme_hint": "auto"
  }
  // orchestrator / host / wrapper blocks are identical to cdx; host includes
  // engines / engines_list for peer reconciliation
}
```

## Peer engine reconciliation

For initial Claude-only or dual-engine provisioning, the host installer first
ensures Node.js and npm, preferring the OS Node package plus a managed pinned
Corepack npm 10.9.2 shim over the often much larger OS npm dependency tree. It
then invokes the common `cxx cron install` and `cxx cron run --minimal`
coordinator once each; `READY` is printed only after the shared wrapper,
schedule, and every requested CLI verify.

After a successful startup sync, `clx` reads the host `engines_list`. If Codex is
enabled, `clx` fetches the signed `cdx` config from
`/wrapper/v2/config?engine=codex`, verifies its detached signature and
host/engine identity, writes `cdx.json{,.sig}`, then verifies the server's fresh
target bytes by SHA while converging the same `cxx` binary plus relative `cdx`
/ `clx` aliases. A stale peer config target does not block reconciliation. If Codex is disabled, `clx`
performs local-only Codex cleanup (the `cdx` alias/config, managed `~/.codex`
state, `/opt/codex`, and the npm global `codex-cli` package when detected)
without deleting the host row; the shared schedule stays in place for Claude.
`clx --cron run` forwards to the common coordinator unless it is already an
engine-only child. The coordinator verifies signed config host/engine
membership and runs Codex then Claude once without recursion; it does not
compare possibly stale per-config wrapper targets.

## Distribution surfaces

The canonical binary is engine-neutral; the engine manifest and old URLs remain
compatibility surfaces:

| Method | Path |
|---|---|
| GET | `/wrapper/v2/bin/cxx/<os>-<arch>/v<ver>/cxx` |
| GET | `/wrapper/v2/manifest/claude` |

`/wrapper/v2/bin/clx/.../clx` preserves exact immutable historical split bytes
when present and otherwise may stream the matching published `cxx` bytes. New
artifacts are still published only through the `cxx` store and canonical path.

Config, download, and cron-check calls send `X-Wrapper-Platform: <os>-<arch>`
(`linux-amd64`, `linux-arm64`, `darwin-arm64`, or `darwin-amd64`) so the
orchestrator can bake the matching `binary_url` / SHA256 for this host.

## Managed CLAUDE.md feature guidance

The admin editor and version history store only canonical base Markdown. During
`/agents/retrieve` or bundled startup sync, the server derives the effective
Claude/host feature state and appends at most one
`<!-- cxx:managed-features:start -->` … `<!-- cxx:managed-features:end -->`
block. Existing orchestrator-owned blocks are replaced so repeated renders are
idempotent.

The Claude block points Skill discovery at the native managed
`~/.claude/skills/<slug>/SKILL.md` directories, never at Codex's MCP Skill
transport. With orchestrator MCP enabled it routes durable fleet, workstream,
and host facts through `shared_memory_*`, `project_memory_*`, and `memory_*`
instead of Claude's local `~/.claude/projects/.../memory/` / `MEMORY.md`; enabled
Projects add the `#coco` / `project_*` hint. BrowserOS remains Codex-only. The
block never inventories individual Skills, memories, or projects, and feature
changes alter the served/managed hashes without changing the canonical base
hash.

## Startup sequence

Mirrors the cdx lifecycle (see `docs/interface-cdx.md`) — runtime FQDN guard,
single-instance flock on `$XDG_RUNTIME_DIR/clx.lock` (or
`/tmp/clx-<uid>.lock`), bundle
(`/sync/bootstrap` with `include_auth=true`; resource envelopes are unwrapped
before `CLAUDE.md` / `settings.json` writes), typed auth decision matrix
including approval-pending polling, Claude CLI version
reconciliation, and post-run generation reconciliation. A changed usable
native generation is uploaded with compare-and-swap writeback; a native file
that is now genuinely gone records logout intent, matching how Claude Code's
own `/logout` behaves (it deletes the file rather than leaving damaged bytes
behind). A native file that still exists but is structurally unusable
(corruption, a partial write, external interference) is never recorded as a
logout — it is left for the next run's ordinary canonical-repair path, which
overwrites it with the server's verified canonical credential. Conflating the
two would let incidental credential loss on one host become a durable,
`clx auth login`-only lockout indistinguishable from an intentional sign-out.
Upload, writeback, marker, or last-session insecure-purge failures make an
otherwise successful run non-zero.
The `clx`
lock is deliberately independent from `cdx.lock`, so active Codex and Claude
sessions can run side by side without pausing each other's managed sync. The
FQDN mismatch check runs before acquiring the lock or making any orchestrator
request, so a cloned/mis-deployed host cannot paint green sync state first;
`PreExec` repeats the check immediately before spawning Claude as
defense-in-depth. `CLAUDE_ALLOW_FQDN_MISMATCH=1` remains the explicit override.
Startup does not wait on live runner verification; `/auth` and
`/sync/bootstrap` return only a stored, verified canonical credential.
Pending/unknown/failed bytes are never distributable. A failed canonical does
not override a distinct runnable local login: clx attempts to upload it, keeps
using it through transient runner infrastructure failures, and enters login
recovery only when no runnable local or verified server credential remains.
Bootstrap `candidate_credential_rejected:true` makes the exact submitted local
generation unusable and triggers login when no replacement exists. The
stronger `candidate_rejected_definitive:true` overwrite authority is honored
only with `status:outdated`, `verification_state:verified`, and an auth object.
Invalid native JSON is submitted as digest/state without raw candidate bytes so
verified canonical auth can repair it. On 404/405/501, legacy fallback preserves a newer
usable native generation and attempts store; only validation-shaped 400/422
permits applying the already-retrieved verified canonical. Transient,
security/policy, and rate failures preserve local auth, while unsafe runner
rotation (`runner_updated_auth_invalid`, including a refresh saved as pending
retry) fails closed on initial and concurrent bundle paths instead of using the
pre-refresh local token as an offline fallback.
The runner applies the same native-file boundary as clx itself: before invoking
Claude Code it projects the canonical envelope onto the `claudeAiOauth`-only
`.credentials.json` shape, then compares post-probe readback against that native
projection. Server-only `last_refresh`/`auths` fields can therefore neither make
Claude rewrite the temporary credential file nor masquerade as a token rotation.
When Claude explicitly reports that its OAuth session expired and could not be
refreshed, a cleared temporary credential file is classified as a definitive
rejection rather than a replacement generation. Bootstrap can then repair from
a different verified canonical or send an interactive clx run into its native
login flow; ambiguous/non-definitive readbacks remain fail-closed.
Against a failed server head, clx preserves local auth only when bootstrap
explicitly returns `candidate_matches_failed_canonical:false`; the server makes
that comparison from credential kind plus access/refresh identity. `true` or
omission is fail-closed, so a raw native digest can never be mistaken for a
distinct canonical envelope.
An IP-binding denial (`ip_mismatch`) wrapped by `/sync/bootstrap` as an offline
response is instead treated as a reachable hard policy denial: `clx` states
that the current IP is not bound and directs the operator to **Admin → Host
Detail → Release IP binding** for the controlled IP move. Cached credentials
are never used for this condition.
When the `clx` lock is already held, the secondary run pauses writes for
managed `CLAUDE.md`, settings, collections, skills, wrapper/CLI updates, and
peer reconciliation, but auth still follows the full replacement gate: never
write non-verified auth, preserve newer usable native auth unless the API
definitively rejects that candidate and serves a verified canonical, then
require generation CAS plus the active-child writer lease. A blocked required
write fails when no usable local credential remains, and the exact local
generation named by `candidate_rejected_definitive` is treated as unusable even
when its JSON still contains a token. An absent or structurally unusable native
credential suppresses its cached digest and candidate, forcing canonical repair
even during a sync-paused run; auth repair and login recovery do not pause merely
because the managed-content lock is held. Only the server's security policy may
block that repair. `--allow-concurrent-sync` is the explicit
escape hatch: it allows normal managed writes without the lock and announces
that choice before startup. The boot card says `SYNC PAUSED` and keeps the
probed health markers visible. Approval polling only repaints an interactive,
non-dumb stderr at least 40 columns wide; other contexts fail immediately with
Admin → Host Detail guidance instead of hanging or writing cursor controls.
The boot summary uses the same client-version policy as the updater:
non-exact latest/current targets only show an arrow when the resolved target is
newer than the local Claude CLI.
### Auth generation, logout, and insecure cleanup

`~/.claude/.credentials.json` is the sole read authority because it is the file
Claude Code actually consumes. `~/.clx/auth/credentials.json` is only an
optional write-through compatibility mirror and can never green-light a missing
native file or resurrect logout. Wrapper-owned
`~/.clx/auth/generation.json` binds a stable RFC3339 `last_refresh` to the
native content digest without injecting wrapper fields into Claude's file.
Concurrent readers of identical native bytes therefore upload the same
generation. Version 1 of the sidecar is a monotonic logical clock: a trusted
deployed unversioned canonical binding migrates on read, accepted X survives a
host clock rollback, and a raw old-mtime Y advances strictly after X. After
`/login` writes Y and clx closes normally, post-run upload accepts Y; an
immediately started clx reuses that exact generation without restamping or
restoring X.

Auth-file locks normally cover only coherent reads, compare-and-swap writes,
and fsynced renames. Every request carrying Claude candidate bytes is the
deliberate exception: bundle bootstrap, pre-run/legacy recovery, explicit
login/auth-upload, and post-run upload keep one atomic auth+logout-intent
snapshot locked through the bounded network call (normally 10–15 seconds).
An overlapping explicit logout therefore orders wholly before or after the
upload. A separate shared lease beside native
credentials spans every wrapper-launched Claude `Start`/`Wait` interval.
Duplicate session and active-child lease descriptors are inherited by the
native child, including help, so a wrapper `SIGKILL` cannot make uninstall or
purge race an orphaned Claude process. Destructive or unconditional writers
acquire the exclusive side before rename/removal. Server/runner conditional
writeback may proceed beside an active child: it holds the auth-file lock and
commits only if the exact pre-request native generation is unchanged, with the native
file as the final commit point after generation metadata and any existing
compatibility mirror. Competing responses for the same request generation use
the persisted canonical `last_refresh`: a strictly newer response can advance a
prior wrapper-materialized response, an older response cannot roll it back, and
equal-stamp/different-content responses fail closed as an ambiguous rotation.
A raw newer login or logout marker is never overwritten. An active child alone
does not block a generation-guarded canonical replacement; its later native
refresh becomes a new candidate and is arbitrated by the server ledger. A newer
usable local login otherwise wins every response-order race unless that exact
candidate was definitively rejected and an older verified canonical is
explicitly authorized. If an older logout marker exists, however,
that login is pending rather than immediately authoritative: only server
acceptance of the exact uploaded generation permits an exact-marker CAS. A
normal launch never clears intent merely because logout was deferred and stale
native bytes still exist: those exact bytes are unusable for launch/upload. It
may restore a verified canonical only when that canonical is a different
credential generation; otherwise it starts login recovery. A blocked write
fails closed when native auth is missing/unusable.
Explicit `clx logout` / `clx auth logout`, plus logout detected inside a managed
session, records nonce-bearing durable intent before native removal. A
standalone wrapper-owned logout runs the upstream command only while it owns an
exclusive auth session and active-child writer. If any peer auth session exists
(even between sync and child start), intent is journaled and destructive native
logout is deferred; the last peer exit completes removal automatically. A later explicit usable login is acknowledged only after
the server accepts the exact auth generation and exact marker bytes observed
before that store; ordinary canonical retrieve cannot clear intent.

All config-backed commands and managed runs share a portable session lease
keyed beside native credentials. Each API `host.secure` response updates only
that session's persisted purge request; concurrent insecure requests remain
sticky. Only the last exiting process in either exit order obtains the
exclusive cleanup lease and purges native/mirror/generation credentials; an
active child defers cleanup. Re-exec explicitly finalizes its session because Go
defers do not survive `exec`. Uninstall fails closed when `/host/users` cannot be
checked unless root/passwordless sudo provides the safe fallback, and is
non-zero if any required local state removal fails. The logout marker is
deliberately retained.
Upload, required materialization, marker, or purge errors make an otherwise
successful clx invocation non-zero. A raw `claude` process launched outside clx
cannot participate in these leases and is the explicit coordination boundary.

Engine-specific details:

- Credentials are read only from `~/.claude/.credentials.json`. Server-accepted
  credentials are written there atomically and mirrored to
  `~/.clx/auth/credentials.json` only when that legacy sidecar already exists;
  the sidecar is never a fallback source. Before commit, the normalized native
  bytes are parsed again and must contain either a non-empty Claude OAuth access
  token or a genuine `sk-ant-api...` key. Empty OAuth plus a derived
  `sk-ant-oat...` bearer is not runnable and is rejected.
- **Auth model is native account-login, 1:1 with cdx/`auth.json`.** The fleet
  keeps the host's `.credentials.json` current and Claude Code reads its
  `claudeAiOauth` account login from it directly. clx exports
  `ANTHROPIC_API_KEY` only for a selected genuine API key (`sk-ant-api…`), never
  for an OAuth token (`sk-ant-oat…`) — an injected OAuth token triggers Claude
  Code's custom-key path and overrides native OAuth. Custom base URLs are
  removed and the protected runtime overlay pins the official Anthropic
  endpoint. The orchestrator stores+serves the native `claudeAiOauth` object
  (not just a derived `auths` bearer), so the refresh token/expiry survive the
  round-trip. The `/anthropic/v1` proxy is a separate gateway for issued
  `sk-claude-*` keys and is not part of the host launch path.
- The selected credential remains authoritative at exec time. Before reading or
  copying auth, clx acquires the shared active-child lease; explicit logout
  therefore cannot race a key already copied into the child environment. clx
  removes inherited credential, provider, endpoint, file-descriptor, and
  token-file selectors, forces `CLAUDE_CONFIG_DIR=~/.claude`, and appends a
  mode-0600 per-run settings overlay that disables `apiKeyHelper`, neutralizes
  the same selectors from user/project settings, and pins the official
  Anthropic endpoint. The overlay is deleted after Claude exits; stale crash
  remnants are pruned. Native API-key mode exposes only the selected verified
  key, while OAuth stays exclusively in `.credentials.json`. Because upstream
  `--bare` ignores subscription OAuth, clx translates it to `--safe-mode` for
  OAuth launches and reports the substitution. Enterprise managed settings are
  an upstream higher-precedence policy boundary; a conflicting managed policy
  must be corrected by the host administrator.
- `clx auth-upload`, missing/upload-required pre-run upload, and post-run
  changed-credential upload reuse the digest-bound `last_refresh` stored in
  wrapper generation metadata. When the server returns canonical auth
  (including runner-refreshed auth), the wrapper writes that accepted payload
  back only if the native generation used by the request is still current.
  `updated` and `valid` acknowledge the uploaded candidate. An `outdated`
  response carrying authoritative auth is a successful arbitration outcome, but
  explicitly does not acknowledge that candidate or clear logout intent.
  Explicit login/auth-upload converges to that canonical when no logout marker
  is pending, but exits non-zero instead of claiming that the submitted login
  was accepted.
  `runner_updated_auth_invalid` is a hard failure even
  if old local bytes look usable. On legacy fallback, only validation-shaped
  400/422 plus an already-retrieved verified canonical authorizes older
  replacement; transient, security/policy, and rate failures preserve local
  auth. Writeback or logout-marker failure exits non-zero.
- Interactive `clx run` can recover missing or live-verification-failed
  credentials: when neither runnable local auth nor verified runnable server
  auth exists, it directly runs `claude auth login`, uploads the resulting
  native credentials through `/auth command=store`, and re-runs the startup
  auth check. There is no extra wrapper-owned `[y/N]` prompt. Headless runs do
  not open a browser flow; they fail with the actionable instruction to run
  `clx auth login` interactively.
- Settings file mirrored to `~/.clx/config/settings.json` after the canonical
  `~/.claude/settings.json` is written.
- `CLAUDE_MD` env exported to the synced AGENTS path so the upstream CLI
  picks up the orchestrator-managed `CLAUDE.md`.
- **Skills are synced ON-DISK** as native
  `~/.claude/skills/<slug>/SKILL.md` directories. Unlike Codex — which reads
  skills live over MCP (`resource_read skill://<slug>`) — Claude Code cannot
  consume skills over MCP, so `/sync/bootstrap` returns `claude_skills`, the
  complete live set of `engine` null/`claude` skills. Manifest-only Skills carry
  `content`; source-owned Skills carry `content` plus the complete auxiliary
  `files[]` tree, including `LICENSE.mattpocock` for the optional MIT-licensed
  Matt Pocock source. The item SHA is the complete bundle digest and
  `content`/`files` are omitted together when the wrapper already has it.
- Claude agents can call MCP `skill_store` / `skill_delete` to mutate the same
  shared manifest-only fleet Skills. The canonical API state changes immediately,
  but Claude's native directory is refreshed on the next unlocked wrapper
  bootstrap, not live inside the running session. The managed `skill-manager`
  runbook is delivered through that same native Skill bundle.
- **cxx 0.7.3 installs a Skill directory atomically.** It validates every
  slash-separated relative path, rejects traversal/duplicates/backslashes,
  verifies the manifest and each file SHA-256, recomputes the canonical complete
  bundle digest, writes a sibling staging directory, and swaps the complete
  directory into place. Missing/invalid content, an aggregate mismatch, or any
  write failure leaves the previous native directory and ownership record
  intact. The wrapper never executes a bundled script; it only installs the
  upstream text/files for Claude Code to interpret under its normal permission
  policy.
- `~/.clx/state/collections/skills.json` records `SKILL.md`, the bundle digest,
  and every auxiliary path plus content SHA-256 the fleet owns. Before cxx
  advertises a cached digest it verifies the directory is real (not a symlink),
  its exact file/directory tree contains no extra entry, every owned file is
  regular, and all bytes still match; drift withholds the digest so the next
  bootstrap restores the complete canonical bundle. A manifest record whose
  filename does not canonically belong to its slug is retained but quarantined:
  it cannot authorize overwrite, prune, strip, or digest advertisement for
  another Skill. The
  server coerces locally authored `SKILL.md` `name:` to the slug (Claude Code's
  native loader requires it), while source imports validate that upstream name
  already matches and preserve the file byte-for-byte. Both paths preserve
  `disable-model-invocation: true`, so an upstream explicit-only Skill stays
  explicit-only. Prune/strip/uninstall remove only
  manifest-recorded Skill directories; user-authored directories are never
  touched. Legacy bash-era caches are still purged one-shot:
  `~/.agents/skills`, `~/.clx/skills`. **`~/.claude/skills` is no longer
  wholesale-purged** — it is the native fleet-managed store. Failed pruning
  remains tracked so the next sync retries it.
- The Matt Pocock source is an admin opt-in and is off by default; this contract
  does not mean it is enabled on a given fleet. When enabled, only the upstream
  plugin allowlist at a validated immutable SHA enters `claude_skills`. Turning
  it off soft-deletes those source rows from served inventory, so the next
  complete bootstrap prunes only their fleet-owned directories. Cached
  last-known-good rows/files stay on the server, and unrelated fleet/user
  Skills remain untouched.
- No quota bars — Claude has no orchestrator-side quota concept; the
  ChatGPT-style headless QuotaWarn emission is therefore a no-op on clx.

Skills and the combined CLAUDE/settings/collection resource marker carry a
checked outcome, not just an "updated this run" boolean. Applying bundled
`claude_skills` contributes to the skills marker rather than the config marker;
successful unchanged checks are green, successful writes get the updated
marker, local/network failures warn, and concurrent/skipped checks are dim
rather than claiming health that was not measured.

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
  `sanitizeSlug` blocks path-traversal slugs. Missing changed content, write
  failure, or prune failure preserves the last-good manifest entry and file so
  a best-effort sync cannot turn a transient error into destructive cleanup.
- Admin: `GET /admin/claude/:kind`, `GET /admin/claude/:kind/:slug`,
  `POST /admin/claude/:kind/store`, `DELETE /admin/claude/:kind/:slug`. Host
  surface is read-only: `GET /claude/:kind`, `POST /claude/:kind/retrieve`
  (these artifacts are admin-authored fleet-wide). `:kind` accepts singular or
  plural spellings.

## Settings.json sub-blocks (deep-merge, non-clobbering)

`~/.claude/settings.json` is **deep-merged**, not overwritten. The bundle returns
`claude_settings: { sha256, partial, owned_paths }` where `partial` holds only
the fleet-managed keys (`model`, `effortLevel`, `mcpServers.<name>`, `env.<VAR>`, `statusLine`,
`hooks.<Event>`, `permissions.{allow,ask,deny}`, `permissions.defaultMode`,
`advisorModel`) and `owned_paths` are the leaf-granular dot-paths the fleet owns
this run.

- Settings → Claude and `GET/POST /admin/model-defaults/claude` own the fleet
  `model` / `effortLevel` pair. POST accepts strict
  `{model, reasoning_effort?: string|null}` but translates that common API field
  to Claude Code's native `effortLevel` key on disk. Fable 5, Opus 5, Opus 4.8,
  and Sonnet 5 persist `low|medium|high|xhigh` and default to `high`; Opus 4.7
  persists the same set and defaults to `xhigh`; Sonnet 4.6 persists
  `low|medium|high` and defaults to `high`; Haiku 4.5 has no effort control, so
  selecting it removes `effortLevel`. This follows Claude Code's documented
  persistence model: `low`, `medium`, `high`, and `xhigh` can live in
  `settings.json`, while `max` is session-only and is deliberately excluded.
  These are Claude Code CLI defaults. The Anthropic-compatible proxy's
  `/admin/claude/settings` `default_model` / `max_tokens` are separate.

- `permissions.defaultMode` is the startup permission mode every managed Claude
  host runs in. It is **always** emitted: when the fleet settings pin no value it
  defaults to `auto` (Claude Code auto-approves tool calls with its background
  safety checks). Accepted values are exactly the upstream `claude
  --permission-mode` choices — `default`, `acceptEdits`, `plan`, `auto`,
  `dontAsk`, `bypassPermissions`; anything else falls back to the `auto` default.
  Claude Code ignores a top-level `permissionMode` key, so the wrapper writes the
  nested `permissions.defaultMode` form (a plain scalar leaf — it rides the
  generic dotted merge, not the allow/ask/deny union special-case).

- `advisorModel` enables Claude Code's experimental advisor tool (routes the full
  transcript to a stronger reviewer model). Restricted to the tier aliases
  `opus` / `sonnet` / `haiku`; any other value is treated as off and the key is
  omitted (and removed on the host via the stale-path cleanup).

- The server renders the partial **only** from the Claude-engine `client_config`
  (or per-host `claude_model_override`) — it never falls back to the Codex config.
  On a greenfield database, the model-defaults GET reports Sonnet 5 at `high`
  but remains read-only; until an operator saves, a host receives neither key and
  inherits Claude Code's own defaults. The first POST creates the canonical row
  and subsequent syncs explicitly bake both keys. The Codex `model` (for example
  `gpt-5.6-terra`) and `model_reasoning_effort` must never leak into
  `settings.json`.
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
  never strips on a transient `offline` status. A failed removal does not erase
  its ownership proof: the relevant settings/MCP sidecar or collection/skill
  manifest entry remains until cleanup succeeds, allowing the next run to retry.
- Per-host model: `host.claude_model_override` flows into the rendered partial's
  `model` key. The signed wrapper config exports this value as
  `ANTHROPIC_MODEL` after inheriting the environment, so the signed override
  wins; an existing `ANTHROPIC_MODEL` is only the fallback when the signed
  override is absent. Subagent-level model lives in each file's frontmatter.

## Adding fields

Follow the same pattern as cdx under `wrappers/cxx/`. Shared config and layout
belong in common packages; Claude-only behavior stays under the Claude persona
packages. There is one build artifact, while the signed config and runtime
behavior remain engine-specific.

## Agent portal lifecycle (cxx 0.7.6)

Claude has parity with Codex for the permanent `/go` portal. When the persistent
master switch is on, interactive and human-started execute/resume root sessions
register with the host API key before launch. The wrapper retains the
short-lived bridge bearer and gives the Claude child only a private Unix-socket
path plus session/engine metadata; inherited portal capability variables are
scrubbed. Cron, auth/preflight, maintenance, and wrapper-only operations are
excluded. Heartbeats and the terminal completed/failed transition are
best-effort and cannot block a local Claude run.

The shared `cxx portal status|notify|wait|accept|say|ask|leave` helper is the
sole relay surface. `notify` opens the relay before queuing the notice. `wait`
leases the oldest message without acknowledging it; `accept` commits receipt
after the message reaches the root agent, so an unacknowledged lease is safely
redelivered. Ambiguous claims reuse one claim UUID, and claim/event/accept/
terminal retries get fresh bounded deadlines without changing their idempotency
identity. `say` and `ask` publish only explicit user-facing content. The
private socket uses a fixed operation allowlist and bounded bodies, but remains
inside the same-Unix-user trust boundary; there is no PTY injection, remote
approval path, hidden reasoning stream, or portal-bearer exposure. The managed
`#afk` Skill cooperatively drives this loop; attention and lifecycle notices are
recorded in the portal, which the user reaches through their own permanent
bookmarked link, and are not pushed out. It cannot wake a
Claude process or model turn that has already stopped, and `relay_ready` ages
false when active polling ceases. The relay, socket capability, and environment
are torn down immediately when the Claude child exits, before post-run updater
or auth work begins.
