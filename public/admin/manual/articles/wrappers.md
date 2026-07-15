---
title: The cdx and clx wrappers
section: Fleet operations
verified: 2026-07-01
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
  `GET /wrapper/v2/bin/...`.

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
- `GET /wrapper/v2/bin/{engine}/{os}-{arch}/v{version}/{binary}` — serves the
  static binary. The response is cacheable (ETag = SHA256).
- `GET /install/{token}` (alias `GET /install/v2/{token}`) — emits the
  installer script.
- `GET /seed/auth/{token}` (alias `GET /seed/v2/auth/{token}`) /
  `POST /seed/auth/{token}` (alias `POST /seed/v2/auth/{token}`) — seed-auth
  flow.

## Startup sequence inside the Go binary

Implemented in `wrappers/cdx/internal/lifecycle/run.go` (mirrored closely for
clx; engine-specific deltas are called out in [clx](/admin/manual/clx)):

1. **Lock** — acquire a non-blocking `flock` (via `ipc.Acquire`). If already
   held, fall into concurrent/read-only mode: the run still submits the auth
   digest and atomically writes server-returned canonical auth on
   `outdated`/`updated`/`missing`, but skips agents/config/skills writes, the
   wrapper/engine update, and peer reconciliation below.
2. **FQDN guard (cdx)** — `codex.GuardFQDN` compares the runtime hostname
   against the FQDN baked into the config, before any network sync; refuses
   unless `CODEX_ALLOW_FQDN_MISMATCH=1`. (clx performs the equivalent check
   later, inside `PreExec` immediately before spawning `claude` — see
   [clx](/admin/manual/clx).)
3. **Config load** — load and verify the host config JSON and its detached
   `.sig` file against the Ed25519 public key embedded in the binary at build
   time.
4. **Bundle sync** — call `POST /sync/bootstrap` with a bundle request
   containing: engine, auth digest + candidate bytes, agents digest,
   settings/config digest, username, and home dir. The server returns auth,
   agents content, config/settings content, and fleet session counts in a
   single response. If the server returns `404`, `501`, or `405` the wrapper
   falls back to sequential legacy calls: `POST /auth`, `POST /agents/retrieve`,
   `POST /config/retrieve`.
5. **Atomic writes** — if the server returned updated content, write
   `auth.json`, `AGENTS.md` (cdx: `~/.codex/AGENTS.md`; clx:
   `~/.claude/AGENTS.md`), and the engine config file (cdx:
   `~/.codex/config.toml`; clx: `~/.claude/settings.json`, also mirrored to
   `~/.clx/config/settings.json`) atomically. On the legacy fallback path
   these come from the individual retrieve calls instead of bundle fields.
6. **Auth decision** — `orchestrator.Decide` evaluates the auth status. A few
   conditions are hard stops before the normal status switch: the server's
   `versions.api_disabled` kill switch, an `installation_id` mismatch, a
   reverse-DNS mismatch, the peer/host's engine being disabled, and a
   `verification_state=failed` response (the background runner reached the
   provider and the canonical token did not authenticate) — the last one sets
   a distinct `VerificationFailed` flag and refuses with a re-login message.
   Otherwise: `valid`/`current`/`ok`/`unchanged`/`updated`/`outdated` allow the
   launch; `missing`/`upload_required` allow it and push the local file as an
   auth candidate for re-bundling; `insecure` opens the approval-pending poll;
   `insecure-denied`, `disabled`, and `invalid` refuse; `offline`/`error` fall
   back to a cached `auth.json`/`.credentials.json` within 24h (7d on secure
   hosts) if one is fresh enough.
7. **Interactive auth recovery** — when the decision is `VerificationFailed`,
   or `missing`/`upload_required` with no usable local credential (or the
   candidate was rejected), an interactive `run` prompts to launch
   `codex login` / `claude auth login`, uploads the freshly minted
   credentials, and re-checks with the server. Headless callers (cron,
   `--execute`) fail closed instead of opening the prompt.
8. **Self-update, engine update, and peer reconciliation** — if
   `dec.Allowed`: `maybeEnsureWrapper` compares the running wrapper binary
   version to the server-declared target; if they differ it downloads the new
   binary and re-execs it before the engine CLI launches. Then
   `maybeEnsureCodex` / `maybeEnsureClaude` auto-updates the upstream engine
   CLI to its server-declared target version. If not running in concurrent
   mode, `peer.Reconcile` then installs/updates or removes the *other*
   engine's wrapper + CLI on this host (see "Peer engine reconciliation"
   below). For cdx, a `QUOTA_HARD_FAIL=0` env override can also be checked
   here to bypass a hard ChatGPT-quota refusal.
9. **Skills fingerprint check** — `GET /skills?engine=<engine>`, compare the
   slug+SHA256 hash against
   `~/.cache/codex-orchestrator/skills-digest`. Updates the boot-screen dot if
   changed. On the first run of a new wrapper version, performs a one-shot
   purge of legacy on-disk skill directories (`~/.agents/skills`,
   `~/.codex/skills`, `~/.codex/prompts`).
10. **Boot screen** — render the responsive outcome/context/version/health card
    to stderr. Redirects, dumb/narrow terminals, and `--minimal` use stable
    ANSI-free ASCII.
11. **Exec** — `exec` the upstream `codex` (or `claude`) CLI with the prepared
    env, forwarding stdio and signals. Stdout is captured for token extraction.
12. **Post-exec** — `maybePostRunAuthUpload` pushes a rotated `auth.json` back
    to the orchestrator if the SHA or `last_refresh` changed during the run.
    Render a measured exit footer from the real process exit, duration, engine
    version, and auth-upload outcome.

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
the run lock is held, it allows normal managed writes instead of read-only
fallback and prints that decision before startup.

### auth-upload

Both `cdx` and `clx` expose an `auth-upload` subcommand that lets an operator
manually push a locally-edited auth file to the orchestrator without waiting
for the next automatic sync.

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
