---
title: The cdx and clx wrappers
section: Fleet operations
verified: 2026-05-20
sources: wrappers/cdx, wrappers/clx, api/src/services/wrapper-config.ts, api/src/services/wrapper-signing-key.ts, api/src/services/wrapper-bin-registry.ts, api/src/services/wrapper-meta.ts, api/src/services/wrapper-download.ts, api/src/routes/wrapper-v2/index.ts, api/src/routes/install/index.ts
---

`cdx` wraps the Codex CLI; `clx` wraps the Claude Code CLI. Each wrapper is a
**static Go binary** built from `wrappers/cdx/` and `wrappers/clx/` (one Go
module per engine, joined by `wrappers/go.work`). At install time the
orchestrator emits a small POSIX `sh` bootstrap transition launcher that fetches a signed
per-host JSON config and the right binary for the host's platform, then
`exec`s the binary.

## What lives where

- **Go sources** — `wrappers/cdx/cmd/cdx/main.go`, `wrappers/clx/cmd/clx/main.go`
  plus the `internal/...` packages (`config`, `lifecycle`, `orchestrator`,
  `codex`/`claude` exec, `update`, `signing`, `cron`, `ipc`, `ui`).
- **Per-host config** — a JSON blob matching `wrappers/schemas/host-config-v1.json`.
  `wrapper-config.ts` composes and signs it (Ed25519, key from the
  `wrapper_signing_keys` table via `wrapper-signing-key.ts`). Any host mutation
  that affects the bake bumps `hosts.config_version`, which is the cache key.
  Codex hosts can opt into BrowserOS MCP per host; enabled hosts get a local
  `browseros` MCP entry in their synced `config.toml` and a startup chip in `cdx`.
- **Binaries** — committed (or CI-uploaded) under
  `<DATA_ROOT>/wrapper/v2/bin/<engine>/<os>-<arch>/v<version>/<engine>` (or
  `storage/wrapper/v2/bin/...` relative to the repo when `DATA_ROOT` is unset).
  `wrapper-bin-registry.ts` discovers them via `manifest.json` files or a
  directory scan; SHA256 + size are recorded per build.
- **Bootstrap transition launcher** — emitted by `wrapper-download.ts`. The transition launcher is the only
  piece of shell; it does config fetch + sha-check + binary download + exec.

## Public endpoints

All under `api/src/routes/wrapper-v2/index.ts`, host-authenticated via
`app.requireHost`:

- `GET /wrapper/v2/meta` (alias `GET /wrapper`) — current per-engine binary
  manifest with signing key id.
- `GET /wrapper/v2/config[?sig=1]` — returns the signed per-host config JSON
  (or its detached signature file when `?sig=1`).
- `GET /wrapper/v2/download` (alias `GET /wrapper/download`) — returns the
  bootstrap transition launcher for the calling host.
- `GET /wrapper/v2/manifest/:engine` — full per-platform manifest for an engine.
- `GET /wrapper/v2/bin/{engine}/{os}-{arch}/v{version}/{binary}` — serves the
  static binary. The response is cacheable (ETag = SHA256).
- `GET /install/v2/{token}` / `GET /seed/v2/auth/{token}` /
  `POST /seed/v2/auth/{token}` — installer and seed-auth flows; the unversioned
  `/install/{token}` and `/seed/auth/{token}` routes alias here.

## Startup sequence inside the Go binary

Implemented in `wrappers/cdx/internal/lifecycle/` (mirrored for clx):

1. Acquire a per-user `flock` so concurrent invocations don't race.
2. Load `~/.config/codex-orchestrator/cdx.json` and verify its Ed25519 signature
   against the public key embedded in the binary at build time.
3. Best-effort auth sync via `POST /auth` (digest comparison; rewrite of
   `~/.codex/auth.json` if the server has a newer payload).
4. Best-effort `AGENTS.md` and `config.toml` (`settings.json` for Claude)
   refresh via `/agents/retrieve` and `/config/retrieve`.
5. `exec` the upstream `codex` (or `claude`) CLI with the prepared env,
   forwarding stdio and signals.
6. Report token counts to `/usage` after the child exits.

Subcommands available to the user: `run` (default), `status`, `doctor`,
`exec -- <cmd>`, `--version`, `--update`; plus `lane <normal|spark>` and
`profile <name>` on cdx only.

## Verifying a deployment

1. `cd wrappers && make all && make test` — builds local binaries and runs Go tests.
2. `scripts/wrapper-v2-init-keys.sh` followed by `cd wrappers && make pubkey` —
   one-time per environment to generate + persist the Ed25519 signing key and
   embed the public key into the binaries.

## Source references

- wrappers/cdx, wrappers/clx (Go modules — host wrappers)
- api/src/services/wrapper-config.ts (signed per-host config bakery)
- api/src/services/wrapper-signing-key.ts (Ed25519 key from wrapper_signing_keys)
- api/src/services/wrapper-bin-registry.ts (binary inventory, SHA256)
- api/src/services/wrapper-meta.ts, api/src/services/wrapper-download.ts (manifest + transition launcher)
- api/src/routes/wrapper-v2/index.ts (HTTP surface)
- api/src/routes/install/index.ts (installer + seed-auth tokens)
