---
title: The cdx and clx wrappers
section: Fleet operations
verified: 2026-07-18
sources: wrappers/cdx, wrappers/clx, api/src/services/wrapper-config.ts, api/src/services/wrapper-signing-key.ts, api/src/services/wrapper-bin-registry.ts, api/src/services/wrapper-meta.ts, api/src/services/wrapper-download.ts, api/src/services/wrapper-transition.ts, api/src/services/install-token.ts, api/src/routes/wrapper-v2/index.ts, api/src/routes/install/index.ts, wrappers/schemas/host-config-v1.json
---

`cdx` wraps the Codex CLI; `clx` wraps the Claude Code CLI. Each wrapper is a
**static Go binary** built from `wrappers/cdx/` and `wrappers/clx/` (one Go
module per engine, joined by `wrappers/go.work`). At install time the
orchestrator emits a POSIX `sh` installer script (`GET /install/{token}`) that
fetches a signed per-host JSON config plus the matching binary, installs it,
and bootstraps the engine CLI via `<name> --cron install` + `<name> --cron run`
— the installer does **not** itself `exec` the wrapper. A separate, shorter
**legacy transition launcher** (`GET /wrapper/download`) exists only for
pre-v2 shell-era hosts: it performs the same config-and-binary fetch, then
`exec`s the freshly installed binary with the original argv.

## What lives where

- **Go sources** — `wrappers/cdx/cmd/cdx/main.go`, `wrappers/clx/cmd/clx/main.go`
  plus the `internal/...` packages (`config`, `lifecycle`, `orchestrator`,
  `codex`/`claude` exec, `update`, `signing`, `cron`, `ipc`, `ui`).
- **Per-host config** — a JSON blob matching `wrappers/schemas/host-config-v1.json`.
  `wrapper-config.ts` composes and signs it (Ed25519, key from the
  `wrapper_signing_keys` table via `wrapper-signing-key.ts`), re-baking and
  re-signing on every `GET /wrapper/v2/config` fetch and unconditionally
  bumping `hosts.config_version` (and stamping `config_baked_at`) each time —
  it is a monotonic per-bake counter, not a content-change flag. Codex hosts
  can opt into BrowserOS MCP per host; enabled hosts get a local
  `browseros` MCP entry in their synced `config.toml` and a startup chip in `cdx`.
- **Config file location** — each wrapper checks `CDX_CONFIG_PATH` (or
  `CLX_CONFIG_PATH`) first, then falls back to
  `$XDG_CONFIG_HOME/codex-orchestrator/cdx.json` (or `clx.json`), and finally to
  `~/.config/codex-orchestrator/cdx.json` when `XDG_CONFIG_HOME` is unset. The
  path can also be overridden with `--config <path>`. Alongside the JSON file
  sits a detached Ed25519 signature file with the same name plus a `.sig`
  suffix (e.g. `cdx.json` and `cdx.json.sig`); both files must be present and
  consistent for the binary to start.
- **Binaries** — committed (or CI-uploaded) under
  `<DATA_ROOT>/wrapper/v2/bin/<engine>/<os>-<arch>/v<version>/<engine>` (or
  `storage/wrapper/v2/bin/...` relative to the repo when `DATA_ROOT` is unset).
  `wrapper-bin-registry.ts` discovers them via `manifest.json` files or a
  directory scan; SHA256 + size are recorded per build.
- **Shell scripts** — `wrapper-transition.ts` builds two distinct POSIX `sh`
  scripts (both shell out to `python3` for the JSON/sha256 work, an undocumented
  host dependency): `buildWrapperV2InstallerScript` — wrapped by
  `install-token.ts`'s `buildInstallerScript` and served at `GET /install/{token}`
  — is the real installer: config fetch, binary download + sha-check, then
  `<name> --cron install` + `<name> --cron run` to bootstrap the engine CLI; on
  a dual-engine host it appends a peer-install block that repeats the same
  dance for the other engine. `buildLegacyWrapperTransitionScript` — served at
  `GET /wrapper/download` — is the actual **transition launcher**: the same
  config-and-binary fetch, but it `exec`s the freshly installed binary with the
  original argv instead of bootstrapping cron. `isLegacyShellWrapperVersion`
  detects date-format versions (YYYY.MM.DD) from the v1 shell era;
  `withLegacyShellWrapperTransition` redirects those legacy hosts to
  `/wrapper/download?engine=<engine>` for the transition launcher rather than a
  versioned binary URL. `wrapper-download.ts` is unrelated to either script —
  it is a thin binary-stream facade backing `GET /wrapper/v2/download` and
  `GET /wrapper/v2/bin/:engine/:platform/v:version/:binary`.

## Public endpoints

All under `api/src/routes/wrapper-v2/index.ts`, host-authenticated via
`app.requireHost`:

- `GET /wrapper/v2/meta` (alias `GET /wrapper`) — current per-engine binary
  manifest with signing key id.
- `GET /wrapper/v2/config[?engine=<engine>][&sig=1]` — returns the signed
  per-host config JSON (or its detached `.sig` file when `sig=1`). `engine`
  defaults to `codex`; each wrapper's peer-reconciliation code fetches the
  *other* engine's config through this same endpoint with `?engine=<peer>`.
- `GET /wrapper/v2/download` — streams the raw wrapper binary for the calling
  host's detected platform (the same artifact as the versioned `/bin/...`
  route below).
- `GET /wrapper/download` — **not an alias of `/wrapper/v2/download`**: this is
  the legacy transition-launcher shell script for pre-v2 (date-versioned)
  hosts (see `buildLegacyWrapperTransitionScript` above).
- `GET /wrapper/v2/manifest/:engine` — full per-platform manifest for an engine.
- `GET /wrapper/v2/bin/:engine/:platform/v:version/:binary` — serves the static
  binary; `:platform` is `<os>-<arch>`. The response is cacheable
  (ETag = SHA256).
- `GET /install/{token}` (alias `GET /install/v2/{token}`) — emits the
  installer script.
- `GET /seed/auth/{token}` (alias `GET /seed/v2/auth/{token}`) /
  `POST /seed/auth/{token}` (alias `POST /seed/v2/auth/{token}`) — seed-auth
  flow.

## Startup sequence inside the Go binary

Implemented in `wrappers/cdx/internal/lifecycle/run.go` (mirrored closely for
clx; engine-specific deltas are called out in [clx](/admin/manual/clx)):

1. **Config load** — load and verify the host config JSON and its detached
   `.sig` file against the Ed25519 public key embedded in the binary at build
   time. `status` and `doctor` turn failures into structured blocked reports;
   path/cause text is stripped of terminal controls, bounded, and returns
   non-zero. Other commands fail with one concise sanitized error.
2. **FQDN guard + lock** — both wrappers compare the runtime hostname against
   the FQDN baked into the config before any network sync. `clx` performs the
   guard before even acquiring its lock; `cdx` acquires the lock first but
   still guards before bootstrap. Both repeat the check in `PreExec` as a final
   defense before spawning the engine. The override is
   `CODEX_ALLOW_FQDN_MISMATCH=1` / `CLAUDE_ALLOW_FQDN_MISMATCH=1`.
   A held lock enters sync-paused mode: auth freshness remains active, while
   agents/config/skills writes, wrapper/engine updates, and peer
   reconciliation are skipped. The boot card says `SYNC PAUSED` and keeps
   API/auth/runner health visible.
3. **Bundle sync** — call `POST /sync/bootstrap` with a bundle request
   containing: engine, auth digest + candidate bytes, agents digest,
   settings/config digest, username, and home dir. The server returns auth,
   agents content, config/settings content, and the compatibility `sessions`
   activity object in one response. If the server returns `404`, `501`, or
   `405` the wrapper falls back to sequential legacy calls: `POST /auth`,
   `POST /agents/retrieve`, `POST /config/retrieve`.
   Legacy auth convergence is two-way: a newer usable local generation is
   preserved and offered through `store`; only a validation-shaped 400/422
   rejection plus an already-retrieved verified canonical can authorize older
   replacement. Transient, policy/security, and rate failures preserve local
   auth; `runner_updated_auth_invalid` fails closed on initial and concurrent
   bundle paths, including when refreshed credentials were retained pending a
   conclusive provider retry.
4. **Atomic writes** — server auth is first filtered through the shared
   replacement policy: materialize only `verification_state=verified`, preserve
   newer usable local auth unless `candidate_rejected_definitive:true` arrives
   with an older verified canonical, then compare-and-swap against the exact
   local generation used by the request. A blocked native-child write is a safe
   skip only if usable local auth remains and that exact generation was not
   definitively rejected. The separate `candidate_credential_rejected:true`
   signal discards that exact generation without authorizing any overwrite.
   Then write the
   agents document (cdx: effective `CODEX_HOME/AGENTS.md`; clx:
   `~/.claude/CLAUDE.md`), and the engine config file (cdx:
   effective `CODEX_HOME/config.toml`; clx: `~/.claude/settings.json`, also mirrored to
   `~/.clx/config/settings.json`) atomically. On the legacy fallback path
   these come from the individual retrieve calls instead of bundle fields.
5. **Auth decision** — `orchestrator.Decide` evaluates the auth status. A few
   conditions are hard stops before the normal status switch: the server's
   `versions.api_disabled` kill switch, an `installation_id` mismatch, a
   reverse-DNS mismatch, the peer/host's engine being disabled, and a
   `verification_state=failed` response (the background runner reached the
   provider and the canonical token did not authenticate). clx still gives a
   distinct runnable local login the chance to replace a failed canonical; a
   transient upload failure uses that local auth rather than forcing login.
   Otherwise: `valid`/`current`/`ok`/`unchanged`/`updated`/`outdated` allow the
   launch; `missing`/`upload_required` allow it and push the local file as an
   auth candidate for re-bundling; `insecure` opens the approval-pending poll;
   `insecure-denied`, `disabled`, and `invalid` refuse; `offline`/`error` fall
   back to a cached `auth.json`/`.credentials.json` within 24h (7d on secure
   hosts) if one is fresh enough.
6. **Interactive auth recovery** — when no runnable local or verified server
   credential remains, an interactive run launches the engine login and then
   uploads/re-checks the resulting credentials. clx starts
   `claude auth login` directly, without an extra wrapper-owned `[y/N]`
   question. Headless clx callers do not open a browser flow and instead print
   the exact `clx auth login` action.
7. **Self-update, engine update, and peer reconciliation** — if
   `dec.Allowed`: `maybeEnsureWrapper` compares the running wrapper binary
   version to the server-declared target; if they differ it downloads the new
   binary and re-execs it before the engine CLI launches. cdx bridges its
   shared auth lease and purge-request IDs into the replacement process; clx
   finalizes its current auth session before re-exec. Then
   `maybeEnsureCodex` / `maybeEnsureClaude` auto-updates the upstream engine
   CLI to its server-declared target version. If not running in concurrent
   mode, `peer.Reconcile` then installs/updates or removes the *other*
   engine's wrapper + CLI on this host (see "Peer engine reconciliation"
   below). For cdx, a `QUOTA_HARD_FAIL=0` env override can also be checked
   here to bypass a hard ChatGPT-quota refusal.
8. **Skills fingerprint check** — `GET /skills?engine=<engine>`, compare the
   slug+SHA256 hash against
   `~/.cache/codex-orchestrator/skills-digest`. A successful unchanged check is
   green, a changed digest gets the updated marker, failures warn, and an
   intentionally skipped check is dim. The combined agents/config marker uses
   the same evidence-based states; bundled Claude-native skill application
   contributes to the skills marker, not config. On the first run of a new
   wrapper version, it performs a one-shot purge of legacy on-disk skill
   directories (`~/.agents/skills`, effective `CODEX_HOME/skills`, and effective
   `CODEX_HOME/prompts`).
9. **Boot screen** — render the shared responsive
    outcome/context/version/health card to stderr. Redirects, dumb/narrow
    terminals, and `--minimal` use stable width-bounded ANSI-free ASCII.
    Explicit minimal mode also applies to wrapper help, status, doctor,
    cron/peer-update progress, and the footer. Wrapper-only presentation flags
    are consumed before an upstream help passthrough. Boot/status results are
    sanitized and capped at three rendered lines; diagnostic causes/paths are
    bounded separately, and narrow update rows keep the outcome visible before
    version metadata.
10. **Exec** — launch the upstream `codex` (or `claude`) CLI with the prepared
    env, forwarding stdio and signals. A separate auth-path-keyed shared
    active-child lease is acquired before any credential is read or copied and
    spans `Start` through `Wait`; duplicate session and child-lease descriptors
    are inherited by the native process (including help), so a killed wrapper
    cannot release coordination under a surviving child. For clx, ambient and
    settings-sourced auth/provider overrides are neutralized by a protected
    per-run settings overlay, `CLAUDE_CONFIG_DIR` is forced to the managed
    `~/.claude`, and OAuth `--bare` is translated to `--safe-mode`. Stdout is
    captured for token extraction.
11. **Post-exec** — reconcile the native content generation: upload changed
    usable credentials with guarded writeback, or record logout intent when
    credentials were removed/unusable. As with bootstrap, pre-run, legacy,
    recovery, and explicit auth-upload/login candidates, the post-run store keeps
    an atomic auth+intent transaction through the bounded request so explicit
    logout is linearly ordered around it. Logout markers include a random nonce
    and are cleared only after an accepted store of the exact auth generation
    and exact marker bytes observed before the request. Competing CLX canonical
    responses advance only when their stable `last_refresh` is newer; older
    responses cannot roll back, equal-stamp/different-content rotations fail
    closed, and content-bound logical generation metadata preserves X→Y order
    across old mtimes or host clock rollback. A normal-close Claude `/login`
    upload and immediate next clx reuse exact Y. cdx retries one native
    replacement during explicit upload and otherwise fails visibly instead of
    acknowledging stale bytes. A peer child blocking writeback of an unchanged request
    generation is a visible failure. Then the last
    insecure-host session purges credential material; an active child defers
    cleanup. Any required upload/writeback, marker, or purge failure makes an
    otherwise successful invocation non-zero. Render the measured footer from
    that combined result.

When the bundle contains the historical `sessions` compatibility object, both
cards render an `ACTIVITY` section. `local procs` is the same-UID wrapper process
count; `hosts 30m` is the number of distinct hosts with an `agents.retrieve`
event in the prior 30 minutes; `syncs UTC day` and `syncs UTC month` are total
events from the UTC day/month boundaries. These values measure managed-agent
sync attempts, not launches or concurrency. An older server can omit the
optional block, in which case the card hides the section rather than
fabricating zeroes.

The context cards follow runtime configuration. cdx fills otherwise absent
model/effort fields from `${CODEX_HOME:-~/.codex}/config.toml`. For clx, a signed
`claude_model_override` wins over inherited `ANTHROPIC_MODEL`; the inherited
environment is a fallback, and response/`~/.claude/settings.json` values fill
fields still unset.

### Codex quota card

`cdx` derives each quota label from the provider's `limit_seconds`, so a
seven-day primary window is shown as `weekly` rather than the old hard-coded
`5h`. Real `0%` readings remain visible and quota warning/block copy explicitly
says `reset unknown` when no reset exists. Forecast text wraps to a
continuation line when needed and changes the overall outcome to attention
when the active lane approaches or crosses the configured threshold; forecasts
stay advisory and never become a hard block by themselves. Projection is held
back until at least five minutes and 1% of its quota window have elapsed.

The launch lane is host-effective: the host's lane preference wins, then the
response's `active_quota_lane`, with `normal` as the fallback. Only the active
lane can warn/block from current percentage or provider
`rate_allowed`/`rate_limit_reached` flags; the inactive normal/Spark rows remain
context. Provider error/unavailable status, malformed fetch timestamps, and
snapshots older than 30 minutes warn rather than presenting stale numbers as
healthy. Such snapshots remain last-known context but cannot forecast or gate
launch from their stored percentages/provider flags. If no readable snapshot
exists, `/auth` sends `chatgpt.status="unavailable"` instead of omitting quota
evidence. `/auth` supplies
`active_quota_lane:"spark"` only to a host whose
stored lane preference is Spark; all other hosts receive `normal`.

An explicitly stored host lane also controls the actual Codex argv. `normal` selects
`gpt-5.6-terra`; `spark` selects `gpt-5.3-codex-spark`, high effort, and no
reasoning summaries. Explicit per-run `--model`/`-m` or `--profile`/`-p` wins
over lane injection, and the card mirrors that launch choice. Clearing the lane
preserves the signed fleet/per-host model while quota policy and display fall
back to `normal`. If no explicit,
signed, or response override supplies model/effort, cdx reads the top-level
fields from `${CODEX_HOME:-~/.codex}/config.toml`; doctor validates the real TOML tree and its
managed MCP block.

Runner health follows launch policy: a stored transport failure is attention,
because retrieve/cached launch remains allowed, while an explicit stored
credential-verification failure is blocked. A store response reporting
`runner_updated_auth_invalid` is also a hard failure: the runner may have
consumed/rotated the submitted token, so usable-looking local bytes are not a
safe fallback. Doctors separately require a structurally usable local token and
an HTTP 2xx API response.

## Peer engine reconciliation

Since dual-engine host support, each wrapper can provision and keep its
*peer* wrapper current on the same host (`wrappers/cdx/internal/peer/`,
`wrappers/clx/internal/peer/`). On a successful launch (step 7 above) or a
cron tick, the wrapper reads the desired engine set from the auth response's
`host.engines_list` (falling back to the locally cached config):

- If the peer engine is enabled, it fetches `GET /wrapper/v2/config?engine=<peer>`,
  **verifies the bundle's detached Ed25519 signature against the embedded
  fleet key before trusting anything in it** — closing an MITM/RCE vector,
  since `binary_url`/`binary_sha256` ride in that same payload — writes
  `<peer>.json{,.sig}`, and installs/updates the peer binary beside the
  running wrapper's PATH location if the SHA256 differs. It then runs one
  guarded `<peer> --cron run` tick (guarded by `CODEX_ORCH_PEER_SPAWN=1` to
  stop the two wrappers from recursing into each other).
- If the peer engine is disabled, it performs local-only cleanup of the
  peer's wrapper binary, config, cron entry, managed state directory, and
  npm-installed CLI package — never touching the host row.
- Cron ticks (`--cron run`) always force this reconciliation
  (`EnsureForCron`); interactive `run` invocations only run it when the peer
  was just installed or its engine CLI binary is missing, to keep normal
  launches lightweight.

## Subcommands and flags

### cdx

Subcommands: `run` (default), `resume [<session>] [<prompt>]`, `status`,
`doctor`, `auth-upload`, `exec -- <cmd>`, `update`, `uninstall`,
`cron [install|remove|run]`, `execute` (headless one-shot),
`lane [normal|spark|clear] [--persist]`, `profile <name>`, `ls`
(legacy alias for `lane spark`).

Flags: `--wrapper-help`, `--version` (`-V`, `-W`, `--wrapper-version`), `--update` (`-U`),
`--uninstall`, `--status`, `--doctor`, `--silent`, `--debug` (`--verbose`),
`--minimal` (`--minimal-output`), `--skip-boot` (`--no-banner`), `-4`/`--ipv4`,
`--allow-concurrent-sync`, `--cron [install|remove|run]`, `--execute <prompt>`,
`--resume [<session>]` (alias for the `resume` subcommand — upstream `codex` has
no `--resume` flag), `--config <path>`.

### clx

Subcommands: `run` (default), `resume [<session>] [<prompt>]`, `status`,
`doctor`, `auth-upload`, `exec -- <cmd>`, `update`, `uninstall`,
`cron [install|remove|run]`, `execute` (headless one-shot).
**`clx` has no `lane`, `profile`, or `ls` subcommands.**

Flags: same set as cdx minus the lane/profile-specific ones; adds
`--continue`/`-c` and `--resume [<session>]`
(short form `-r`), which are forwarded to the Claude CLI, plus
`--dangerously-skip-permissions` for an explicit per-run permission bypass.
`--allow-concurrent-sync` is an explicit escape hatch on both wrappers: when
the run lock is held, it allows normal managed writes instead of sync-paused
fallback and prints that decision before startup.

### auth-upload

Both `cdx` and `clx` expose an `auth-upload` subcommand that lets an operator
manually push a locally-edited auth file to the orchestrator without waiting
for the next automatic sync. The request uses one stable, content-bound local
generation. Candidate-carrying network requests keep the atomic auth+logout
snapshot locked through their bounded store call; the returned canonical
payload is compare-and-swapped only if that generation is still current. An
overlapping explicit logout therefore orders wholly before or after the store.
For both engines, a different usable login after an older logout marker remains
pending until `updated`/`valid` accepts that exact candidate; an `outdated`
canonical-win response cannot clear the marker or be reported as upload
success. For clx, the exact stale native generation covered by a logout marker
is never relaunched or re-uploaded merely because deferred logout left the file
in place. A normal run can recover only from a different verified canonical or
from a new accepted login.

Every config-backed command plus managed run and standalone
status/login/logout/auth-upload participates in a portable shared auth-session
lease keyed to the effective auth home. This does not serialize sessions. Each
live API `host.secure` response updates only that session's durable purge
request; requests from concurrent insecure sessions remain sticky. Only the
last process to exit can obtain the exclusive lease and purge credentials,
independent of exit order, and an active native child defers cleanup. Explicit
logout takes an exclusive session when alone; with any peer it journals intent
without starting a destructive native logout, and final peer exit completes
removal. Uninstall requires the corresponding exclusive maintenance lease and
refuses while a session is active. A failed multi-user safety lookup also fails
closed unless root/passwordless sudo provides the fallback. cdx uses effective
`CODEX_HOME/auth.json`; clx reads only
Claude Code's native `~/.claude/.credentials.json` and treats the legacy clx
credential file as an optional write-only mirror. Credential upload, guarded
materialization, logout tracking, and insecure purge failures are non-zero
wrapper failures; required uninstall removal failures are non-zero too. Lease
FDs are inherited by wrapper-launched children, so coordination survives a
wrapper crash until the child exits. These leases cover wrapper-launched children only: a raw
`codex`/`claude` invocation outside cdx/clx is an unavoidable coordination
boundary.

### execute / --execute

Both wrappers support a headless one-shot mode (`execute` subcommand or
`--execute <prompt>` flag) that runs a single prompt via the upstream engine's
exec path. This is the entry point used by cron jobs and other automated
callers.

## Verifying a deployment

1. `cd wrappers && make all && make test` — builds local binaries and runs Go tests.
2. `scripts/wrapper-v2-init-keys.sh` followed by `cd wrappers && make pubkey` —
   one-time per environment to generate + persist the Ed25519 signing key and
   embed the public key into the binaries.

## Source references

- wrappers/cdx, wrappers/clx (Go modules — host wrappers, incl. `internal/peer`
  peer-engine reconciliation and `internal/orchestrator/auth_decide.go`
  launch-gate rules)
- api/src/services/wrapper-config.ts (signed per-host config bakery)
- api/src/services/wrapper-signing-key.ts (Ed25519 key from wrapper_signing_keys)
- api/src/services/wrapper-bin-registry.ts (binary inventory, SHA256)
- api/src/services/wrapper-meta.ts (per-engine/platform manifest), api/src/services/wrapper-download.ts (binary-stream facade)
- api/src/services/wrapper-transition.ts, api/src/services/install-token.ts (installer + legacy transition shell script generation, legacy version detection)
- api/src/routes/wrapper-v2/index.ts (HTTP surface)
- api/src/routes/install/index.ts (installer + seed-auth tokens)
- wrappers/schemas/host-config-v1.json (per-host config schema)
