---
title: clx — the Claude Code wrapper
section: Fleet operations
verified: 2026-07-29
sources: wrappers/cxx, api/src/routes/wrapper-v2/index.ts, api/src/routes/install/index.ts, api/src/routes/auth/index.ts, api/src/routes/host/index.ts, api/src/routes/cli-auth/index.ts, api/src/services/claude-artifacts.ts, api/src/services/client-config.ts, wrappers/schemas/host-config-v1.json
---

`clx` is the **Claude Code fleet wrapper** — the Claude persona of the static
Go `cxx` binary under `wrappers/cxx/`, selected through the relative
`clx -> cxx` alias. It wraps the upstream `claude` / `claude-code` Node CLI for
hosts managed by Codex Orchestrator. The equivalent Codex/OpenAI persona is
`cdx`; the engine token for clx is `"claude"`.

## Installation and distribution

The canonical new-release route serves the common artifact directly:

```
GET /wrapper/v2/bin/cxx/<os>-<arch>/v<version>/cxx
```

The compatible historical shape still serves an exact old Claude artifact when
one exists and otherwise projects the matching common bytes:

```
GET /wrapper/v2/bin/claude/<os>-<arch>/v<version>/clx
```

An engine token of `clx` is rejected with `404 unknown_engine`.

Supported platforms (sent as the `X-Wrapper-Platform` header): `linux-amd64`,
`linux-arm64`, `darwin-amd64`, `darwin-arm64`.

An install script at `/install` fetches the signed config and common binary,
then installs `cxx` plus the relative `clx` alias. The config is stored at the
path returned by `config.DefaultPath()` (typically
`~/.config/codex-orchestrator/clx.json`) before the first coordinated boot.

### Per-host config schema

The config is typed, Ed25519-signed JSON with the following top-level fields:

| Field | Description |
|---|---|
| `schema_version` | Config schema version |
| `engine` | Always `"claude"` for clx |
| `orchestrator.base_url` | Orchestrator API root |
| `orchestrator.api_key` | Host API key |
| `host.id` | Host numeric ID (integer, not a UUID) |
| `host.fqdn` | Host fully qualified domain name |
| `host.secure` | Whether the host is approved (secure mode) |
| `host.engines` / `host.engines_list` | Comma string / array of enabled engine tokens (`codex`, `claude`) used for peer-wrapper reconciliation — see [wrappers](/admin/manual/wrappers) |
| `engine_options.silent` | Suppress wrapper output |
| `engine_options.claude_model_override` | Force a specific Claude model |
| `engine_options.admin_theme_hint` | Retained fleet theme hint; clx terminal cards use a fixed violet engine identity |
| `wrapper.version` | Current wrapper version |
| `wrapper.track` | Update track (`stable`, etc.) |
| `wrapper.auto_update` | Enable automatic self-update |
| `wrapper.binary_url` | Download URL for self-update |
| `wrapper.binary_sha256` | SHA256 of the wrapper binary |

`host.engines`/`host.engines_list` are populated by `wrapper-config.ts`, read by
the Go `Config.Host` struct and declared in `wrappers/schemas/host-config-v1.json`.
Nothing validates the served payload against that schema at runtime, but the API
suite does: `api/test/unit/contract/wrapper-config-schema.test.ts` bakes a payload
and fails on any key the schema's `additionalProperties: false` objects do not
declare, so a field added to the bake without a schema entry cannot ship.

## CLI subcommands and flags

### Subcommands

| Subcommand | Description |
|---|---|
| `run` (default) | Full startup sequence, then launch a Claude session |
| `resume [<session>] [<prompt>]` | Full startup sequence, then reopen a previous Claude session. With no session id the upstream picker is shown. Equivalent to `clx --resume`/`-r` |
| `status` | Responsive local config + `POST /auth` summary on stdout; unloadable config and failed health return a structured non-zero report. Redirected output is width-bounded ASCII. Returned canonical credentials can seed/repair the local file; a fresher usable login wins unless the API definitively rejects that exact candidate and returns verified canonical repair. |
| `doctor` | Responsive self-diagnostic: config, paths, Claude CLI, usable credentials, parsed settings/MCP state, HTTP reachability/latency, disk, and cron |
| `auth-upload` | Stabilize and POST native `~/.claude/.credentials.json`; keep a newer concurrent local login and return non-zero on upload/writeback failure. A canonical-win `outdated` response is materialized when safe, but remains non-zero because it did not accept the submitted login. |
| `exec -- <cmd...>` | Bypass startup sync; run a single Claude command directly |

Reserved upstream subcommands (`auth`, `login`, `logout`, `mcp`, `config`,
`doctor`, `resume`, `help`) route their `--help`/`-h` invocations
straight through to the real `claude` binary. `doctor` is listed here too, but
that only affects help passthrough (`clx doctor --help`) — a bare `clx doctor`
always hits the wrapper's own self-diagnostic, since the wrapper-owned
subcommand switch is checked first. `resume` is the same shape: only
`clx resume --help` passes through, while a bare `clx resume` is handled by the
wrapper (see below).

Outside help, `login`/`auth login` and `logout`/`auth logout` still run the
native command, but the wrapper owns their auth transaction: successful login
is uploaded with guarded canonical writeback, while logout is durably journaled
before native removal (or deferred when a peer session exists). `auth status`
is ordinary read-only passthrough and never enters that mutation path.

`sessions` is **not** reserved — upstream `claude` has no such subcommand, so
forwarding it made `clx sessions` hang on a literal `sessions` prompt. It now
fails fast as an unknown subcommand.

### Flags

| Flag | Description |
|---|---|
| `--continue` / `-c` | Forwarded to the upstream `claude` binary |
| `--resume [<session>]` / `-r` | Alias for the `resume` subcommand. Upstream `claude` spells resume as a flag, so the wrapper re-spells `clx resume …` to `claude --resume …`; a bare `resume` positional would otherwise be swallowed as a prompt and open a *new* session. With no session id the upstream picker is shown |
| `--dangerously-skip-permissions` | Forwarded to the upstream `claude` binary for this run only; lights an explicit warning badge (`warning` row in `--minimal`) without claiming the launch itself failed. Per-run, not persisted — for a fleet-wide default use `permissions.defaultMode: bypassPermissions` on the Claude settings page instead |
| `--help` / `-h` / `help` | Full passthrough to upstream `claude`; skips the managed run lock, sync, and boot screen, but keeps a neutral auth session and inherited active-child lease until Claude exits so pending insecure cleanup is not stranded; consumes wrapper-only `--minimal`/`--minimal-output` instead of forwarding it as an unsupported Claude flag |
| `--wrapper-help` | Wrapper-owned command/flag reference; does not need a loadable config |
| `--cron [install\|remove\|run]` | Forward to the one host-wide `cxx` auto-update coordinator; explicit minimal mode keeps output ASCII |
| `--version` / `-V` / `--wrapper-version` / `-W` | Print version, commit, build date, OS/arch, pubkey status |
| `--update` / `-U` | Self-update (SHA256-verified) |
| `--uninstall` | Remove Claude-local credentials/state under the exclusive auth-maintenance lease and request engine-scoped deletion. Server-confirmed Codex retention keeps `cxx`/`cdx`/cron; confirmed last-engine deletion removes all shared artifacts; uncertain server results preserve them. A failed multi-user lookup requires root/passwordless sudo. |
| `--execute <prompt>` | Run a one-shot headless prompt (skips boot screen) |
| `--silent` | Suppress wrapper output |
| `--debug` / `--verbose` | Verbose logging |
| `--minimal` / `--minimal-output` | Stable ANSI-free ASCII across wrapper help, status, doctor, cron/peer-update output, startup, and the exit footer; consumed before upstream help passthrough |
| `--skip-boot` / `--no-banner` | Skip boot screen entirely |
| `-4` / `--ipv4` | Force IPv4 |
| `--allow-concurrent-sync` | Explicitly allow managed writes while another clx session holds the run lock; visibly announced |

## Startup sequence

Implemented in `wrappers/cxx/internal/persona/claude/lifecycle/` as `lifecycle.Run`:

1. **Validate the signed config and runtime FQDN.** An unloadable config produces
   the same structured, sanitized, width-bounded status/doctor surface as a
   normal health failure. `claude.GuardFQDN` then rejects a cloned or
   mis-deployed host before acquiring the run lock or making any orchestrator
   request; `PreExec` repeats the check immediately before spawning Claude.

2. **Acquire IPC flock** (`"clx"`) plus a shared auth-session lease. If the run
   lock is already held, managed content/update work pauses, but auth remains
   generation-safe: the process submits the native generation and applies a
   server response only if `~/.claude/.credentials.json` is unchanged. The
   card says `SYNC PAUSED` while retaining API/auth/runner markers. The lease is
   keyed beside native credentials; each live API security response updates
   only this session's durable purge request. Concurrent insecure requests stay
   sticky, and only the last auth-aware process can obtain the exclusive
   cleanup lease and purge credentials.

3. **POST `/sync/bootstrap`** with a `BundleRequest` carrying: `engine=claude`,
   `include_auth=true`, auth digest, auth candidate, agents digest, config
   digest, `home`, `username`, and artifact digests for subagents, commands,
   output-styles, and skills. Falls back to legacy separate `POST /auth`,
   `POST /agents/retrieve`, and `POST /config/retrieve` calls if the server
   returns 404, 501, or 405. Legacy auth convergence preserves a newer usable
   local generation and attempts store; only a validation-shaped 400/422 plus
   an already-retrieved verified canonical permits older replacement.
   Transient, security/policy, and rate failures preserve local auth, while
   `runner_updated_auth_invalid` is a hard failure on both initial and
   concurrent bundle paths (including a refresh stored pending retry); the
   pre-refresh token is never used as an offline fallback. Bundle candidates,
   legacy/pre-run stores, explicit login/auth-upload, recovery, and post-run
   uploads keep their atomic auth+logout-marker snapshot locked through the
   bounded request, so explicit logout cannot interleave a candidate store.

4. **Apply bundle response**:
   - Consider `~/.claude/.credentials.json` only for distributable server auth:
     write only `verification_state=verified`; preserve a newer usable local
     generation unless `candidate_rejected_definitive:true` accompanies an
     older verified canonical; require request-generation CAS and the separate
     active-child writer lease. A blocked required write fails when no usable
     local credential remains or when a peer child leaves the original request
     generation unchanged. Competing canonical responses advance only by stable
     `last_refresh`; older responses cannot roll back newer materialization and
     equal-stamp/different-content rotations fail closed. The exact generation
     named by a definitive rejection is not accepted merely because it still
     parses. The legacy clx credentials path is an optional
     write-only mirror, never a read source. Before rename, the final normalized
     native JSON must contain non-empty Claude OAuth or a genuine
     `sk-ant-api...` key; empty OAuth plus a derived `sk-ant-oat...` entry is
     rejected as unrunnable.
     `candidate_credential_rejected:true` separately marks the exact submitted
     local generation unusable and starts recovery; it never grants overwrite
     authority without the verified-canonical tuple above.
     For a failed server head, only
     `candidate_matches_failed_canonical:false` proves that usable local auth is
     distinct enough to launch while upload retries. `true` or omission stays
     fail-closed.
   - Write `~/.claude/CLAUDE.md` (agents/fleet instructions).
   - Deep-merge `~/.claude/settings.json` (fleet partial, preserving user keys;
     see [Settings merge](#settings-deep-merge) below).
   - Split `mcpServers.*` out of `settings.json` and into `~/.claude.json`
     (user-scope MCP; tracked in `~/.clx/state/managed-mcp.json`).
   - Write `~/.claude/agents/<slug>.md`, `commands/<slug>.md`,
     `output-styles/<slug>.md` from `claude_artifacts` (see
     [Claude-native collections](#claude-native-collections) below).
   - Write `~/.claude/skills/<slug>/SKILL.md` from `claude_skills`.
   - All writes are manifest-tracked; only manifest-recorded files are pruned
     on removal. Missing changed skill content, write failures, and prune
     failures preserve the last-good file/manifest entry for retry.

5. **Auth decision** (`orchestrator.Decide`). A few conditions are hard stops
   ahead of the status table below: the server's `versions.api_disabled` kill
   switch, an `installation_id` mismatch, a reverse-DNS mismatch, the host's
   Claude engine being disabled, and an explicit host security-policy denial.
   A `verification_state=failed` canonical is not distributable, but a distinct
   runnable local login is still uploaded and may launch through a transient
   runner outage; login recovery starts only after the local candidate is
   definitively rejected or no runnable local credential exists. Otherwise,
   possible statuses:

   | Status | Meaning |
   |---|---|
   | `current` / `ok` | Credentials are valid and up to date |
   | `outdated` | Server has a newer credential; refreshed in step 4 |
   | `missing` | No credentials on host; written from server payload |
   | `upload_required` | Host has credentials the server doesn't; `auth-upload` needed |
   | `disabled` | Host is disabled; fleet settings + skills stripped |
   | `invalid` | Credential invalid; fleet settings + skills stripped |
   | `offline` | Orchestrator unreachable; falls back to a cached credential within 24h (7d on secure hosts) |
   | `error` | Server-side processing error; same cached-credential fallback as `offline` |
   | `insecure` (HTTP 423 maps here) | Awaiting admin approval; polls `PollApproval` every 5 s |
   | `insecure-denied` (HTTP 403) | Admin denied; fleet settings + skills stripped |

6. **Interactive credential recovery** — when neither a runnable local
   credential nor verified runnable server credential remains, an interactive
   `clx run` launches `claude auth login` directly, uploads the resulting
   credentials, and re-checks with the server. There is no extra wrapper-owned
   confirmation prompt. Non-interactive runs (cron, `--execute`) do not open a
   browser flow and instead direct the operator to run `clx auth login`
   interactively.

7. **Install target Claude CLI version** if allowed and `auto_update` is
   enabled (`claude.EnsureClaude`), then — unless this is a concurrent
   sync-paused run — reconcile the Codex persona (`peer.Reconcile`) from the
   server's `engines_list`. This fetches the signed peer config and converges
   the same `cxx` binary plus relative aliases; it does not install a second
   wrapper artifact. See [wrappers](/admin/manual/wrappers).

8. **Check resource outcomes and print the responsive outcome-first boot card.**
   A successful unchanged skills/config check is green, a real local write gets
   the updated marker, failures warn, and deliberately skipped checks are dim.
   Applying bundled `claude_skills` contributes to the skills marker, not the
   config marker. Resource failures are non-fatal but move the result to
   attention. Rich and compact output are width-bounded; boot/status result
   detail is sanitized and capped at three lines. Immediately before
   starting Claude, `PreExec` repeats the runtime FQDN check. A separate shared
   active-child lease spans `Start` through `Wait`. Duplicate session and child
   lease descriptors are inherited by native Claude (including help), so the
   guard remains live if the wrapper is killed while Claude survives. This
   prevents managed credential renames, purge, and uninstall while native
   Claude can refresh/login/logout;
   `CLAUDE_ALLOW_FQDN_MISMATCH=1` is the explicit override.

9. **Post-run**: upload a changed usable native generation with guarded
   writeback, or persist logout intent if native credentials disappeared or
   became unusable. Like every other candidate-carrying request, the changed-auth
   upload holds its atomic auth+intent snapshot through the bounded store call,
   so overlapping explicit logout is ordered before (upload aborts) or after
   (logout wins). A different usable login after an older marker remains pending
   until `updated`/`valid` accepts that exact upload; an `outdated` canonical-win
   response does not clear the marker. Wrapper-owned logout
   journals intent before mutation; if any peer auth session exists—even before
   its child starts—the destructive upstream logout is skipped and physical
   native removal is completed automatically by the last peer exit. Marker
   cleanup requires both the exact auth generation and exact marker bytes seen
   before an accepted store. Active children also defer insecure cleanup.
   A normal run treats the exact stale native generation named by a logout
   marker as unusable; it never clears the marker just to relaunch those bytes.
   Recovery requires a different verified canonical generation or a new login.
   Upload/writeback/marker/purge failures make an otherwise successful wrapper
   invocation non-zero and are reflected in the footer. Uninstall requires an
   exclusive maintenance lease and refuses while another clx session targets
   the same auth home. A failed `/host/users` safety lookup also refuses unless
   root/passwordless sudo provides the safe fallback; required local removal
   errors make uninstall non-zero. The shared `cxx`, both aliases, and cron are
   removed only when the API authoritatively confirms no engine remains.
   Offline, non-2xx, or malformed delete responses preserve all shared
   artifacts; a confirmed partial uninstall removes only `clx`.

   Generation metadata is versioned logical time rather than host wall time.
   If accepted X is followed by `/login` writing old-mtime Y after a clock
   rollback, normal close uploads Y and an immediately started clx reuses the
   same digest and `last_refresh`; it never restores X merely because Y's mtime
   looks older.

The active-child lease covers Claude processes launched through `clx`. A raw
`claude` process started separately cannot participate, so fleet-managed hosts
should consistently launch Claude through the wrapper.

### Doctor truth table

`clx doctor` does not infer health from file existence or matching text. It
requires a structurally usable Claude token, parses `settings.json` as a JSON
object, and parses `.claude.json` for the exact non-empty
`mcpServers.clx` object. Malformed/unreadable JSON is a failure. The API row is
green only for HTTP 2xx; HTTP errors remain failures, and a request that never
connected also fails the latency row instead of showing a green `-`.

The boot context mirrors runtime precedence: a signed
`claude_model_override` wins over inherited `ANTHROPIC_MODEL`; the environment
is only the fallback when the signed override is absent. Response/local
`model` and `effortLevel` values then fill fields still unset. The shared
`ACTIVITY` section uses the API's historical `sessions` compatibility object:
`local procs` is the same-UID `clx` wrapper process count, `hosts 30m` is distinct
hosts with an `agents.retrieve` event in the prior 30 minutes, and `syncs UTC
day` / `syncs UTC month` count those events from the UTC boundaries. They are
not launch or concurrency totals.

## Authentication model

`clx` sets `ANTHROPIC_API_KEY` only for the selected native API-key mode. The
fleet keeps `~/.claude/.credentials.json` populated with the native
`claudeAiOauth` object (refresh token + expiry intact); the orchestrator stores
and serves this object verbatim. Custom base URLs are removed and the protected
runtime overlay pins the official Anthropic endpoint.

The runtime environment builder exports `ANTHROPIC_API_KEY` only when
`.credentials.json` holds a genuine `sk-ant-api…` key, and never bridges an
OAuth token (`sk-ant-oat…`), because an injected OAuth token would trigger
Claude Code's custom-key path and override the native OAuth login.

At launch, clx first acquires the active-child lease, then removes inherited
credential/provider/endpoint selectors and forces `CLAUDE_CONFIG_DIR=~/.claude`.
A protected mode-0600 per-run settings overlay disables `apiKeyHelper`,
neutralizes the same selectors from user/project settings, and pins the official
Anthropic endpoint. It is removed after the child exits. API-key mode exposes
only the selected verified key; OAuth remains in `.credentials.json`. Since
upstream `--bare` ignores subscription OAuth, clx transparently uses
`--safe-mode` for OAuth launches and prints that substitution. Enterprise
managed settings remain Claude Code's higher-precedence policy boundary.

The `/anthropic/v1` proxy (for issued `sk-claude-*` keys) is a separate gateway
and is not part of the host launch path.

## New host registration (device-code flow)

When a host has no config yet, `clx` drives a device-code exchange:

1. POST `/cli/auth/start` with `{fqdn, secure}` → receives a **device code**
   (format: `ABCD-1234`, four uppercase letters, dash, four digits) and a
   `verify_url`.
2. Poll POST `/cli/auth/poll/:id` until approved or denied.

On the admin side an operator navigates to **Authorize CLI** (`/cli/auth/verify`,
requires an admin session unless `ADMIN_ACCESS_MODE=open`):

- **Step 1** — Enter the device code shown on the host terminal.
- **Step 2** — Confirm: review session details (FQDN shown), then click
  **Approve** or **Deny**.
  - Approve → POST `/cli/auth/approve` with `user_code`.
  - Deny → POST `/cli/auth/deny`.
- **Step 3** — Approved/denied result page.

On approval the poll response includes `base_url` so the wrapper can download
its signed config and proceed.

## Auto-update (cron)

`clx --cron install` forwards to `cxx cron install`. The coordinator writes one
host-wide entry (user crontab marker `# cxx-managed-cron`, or system fallback
`/etc/cron.d/cxx-managed`) and removes the historical cdx/clx schedules.

`clx --cron run` forwards to `cxx cron run` unless it is already the
coordinator's engine-only child. The coordinator verifies each signed config's
host/engine membership, but deliberately does not compare wrapper targets that
may differ during a rolling refresh. It then runs each enabled engine tick once
in deterministic order. The first upgraded legacy tick also replaces both old
persona schedules with this one shared schedule. The Claude tick:

1. Calls `POST /cron/check` to ask the orchestrator whether a new wrapper
   version is available (a server response of `action: "disable"` — driven by
   the host's `auto_update_enabled` being off — removes the cron entry and
   stops here).
2. If a wrapper update is offered: verifies SHA256, downloads, self-replaces,
   explicitly finalizes the current auth session/purge request, then re-execs
   via atomic rename + re-exec (`CLAUDE_WRAPPER_RESTART_DEPTH` env var, capped
   at 2).
3. Ensures the `claude` CLI version matches the server-declared target
   (`claude.EnsureClaude`).
4. Reconciles the common `cxx` layout and enabled aliases/CLIs on dual-engine
   hosts without spawning another coordinator.
5. Reports the installed `claude` version to `POST /cron/report` (a **separate**
   endpoint from the `/cron/check` probe in step 1), retrying once on failure.

`clx --cron remove` removes the shared host-wide entry and any historical
persona entries.

## Settings deep-merge

The bootstrap bundle returns `claude_settings: {sha256, partial, owned_paths}`.

- The `partial` is merged over `~/.claude/settings.json`, preserving user-owned
  keys.
- Fleet-owned paths are persisted in `~/.clx/state/managed-keys.json`; paths
  that disappear from `owned_paths` are removed on the next run.
- `permissions.{allow,ask,deny}` are **union-merged**: previously injected fleet
  rules are stripped first to avoid duplicates.
- `mcpServers.*` owned paths are split out and merged into `~/.claude.json`
  (user-scope MCP); managed MCP names are tracked in
  `~/.clx/state/managed-mcp.json`.
- `advisorModel` is only written for tier aliases (`opus`, `sonnet`, `haiku`);
  any other value is treated as off and the key is omitted (and cleaned up via
  the stale-path removal on a later run).
- `permissions.defaultMode` is **always** emitted by the server — when no
  fleet setting pins a value it defaults to `"auto"`
  (`DEFAULT_CLAUDE_PERMISSION_MODE` in `config-normalizer.ts`). It rides the
  generic dotted-leaf merge (not the allow/ask/deny union special-case), since
  Claude Code only reads the nested `permissions.defaultMode` form, not a
  top-level `permissionMode` key.
- On explicit trust loss (`disabled`, `invalid`, or `insecure-denied`), clx
  strips only fleet-owned settings, MCP servers, collections, and skills. If a
  removal fails, its ownership sidecar/manifest entry is retained so a later
  run retries it; transient `offline` status never triggers this cleanup.

## Claude-native collections

Claude Code reads several artifact *collections* off disk that Codex has no
analogue for: subagents, commands, and output-styles. The orchestrator manages
them as first-class fleet artifacts (table `claude_artifacts`, one row per
item, discriminated by `kind`), synced via the same `/sync/bootstrap` bundle
(step 4 above) as `claude_artifacts: { subagent:[…], command:[…],
"output-style":[…] }`:

| Kind | On-disk target |
|---|---|
| `subagent` | `~/.claude/agents/<slug>.md` |
| `command` | `~/.claude/commands/<slug>.md` |
| `output-style` | `~/.claude/output-styles/<slug>.md` |

`wrappers/cxx/internal/persona/claude/lifecycle/collections.go` writes each `<slug>.md` and
tracks exactly the files it wrote per directory; pruning removes only
manifest-recorded files that dropped out of the live set, so user-authored
files in those directories are never touched. A missing changed payload, write
failure, or prune failure keeps the last-good file and manifest entry for retry
instead of silently deleting working state. Admin CRUD lives at
`GET /admin/claude/:kind`, `GET /admin/claude/:kind/:slug`,
`POST /admin/claude/:kind/store`, and `DELETE /admin/claude/:kind/:slug`
(backed by `api/src/services/claude-artifacts.ts`); the host-facing surface is
read-only (`GET /claude/:kind`, `POST /claude/:kind/retrieve`).

## Source references

- `wrappers/cxx` — common Go module (Claude persona, including peer-engine
  reconciliation and `internal/lifecycle/collections.go` artifact sync)
- `api/src/routes/wrapper-v2/index.ts` — binary + config + manifest endpoints
- `api/src/routes/install/index.ts` — installer and seed-auth tokens
- `api/src/routes/auth/index.ts` — `/sync/bootstrap`, `/sync/status`
- `api/src/routes/host/index.ts` — `/cron/check`, `/cron/report`
- `api/src/routes/cli-auth/index.ts` — device-code registration flow
- `api/src/services/claude-artifacts.ts` — subagent/command/output-style fleet artifacts
- `api/src/services/client-config.ts` — renders the `claude_settings` partial (incl. `permissions.defaultMode`)
- `wrappers/schemas/host-config-v1.json` — config schema (enforced against the baked payload by `api/test/unit/contract/wrapper-config-schema.test.ts`)
