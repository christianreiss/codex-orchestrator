---
title: The cdx and clx wrappers
section: Fleet operations
verified: 2026-05-16
sources: wrappers/cdx, wrappers/clx, src/Services/Wrapper/V2/ConfigBaker.php, src/Services/Wrapper/V2/BakeCache.php, src/Http/Controllers/WrapperV2Controller.php, src/Http/Controllers/InstallV2Controller.php, docs/wrapper-v2-architecture.md
---

`cdx` wraps the Codex CLI; `clx` wraps the Claude Code CLI. As of the v2 bakery,
each wrapper is a **static Go binary** built from `wrappers/cdx/` and `wrappers/clx/`
(one Go module per engine). At install time the orchestrator emits a ~50-line
POSIX `sh` bootstrap shim that fetches a signed per-host JSON config and the
right binary for the host's platform, then `exec`s the binary.

## What lives where

- **Go sources** — `wrappers/cdx/cmd/cdx/main.go`, `wrappers/clx/cmd/clx/main.go`
  plus the `internal/...` packages (config, lifecycle, orchestrator client,
  codex/claude exec, update). One Go workspace, two fully independent modules.
- **Per-host config** — a JSON blob matching `wrappers/schemas/host-config-v1.json`.
  `App\Services\Wrapper\V2\ConfigBaker::bakeForHost` composes + signs it
  (Ed25519, key under `storage/wrapper/v2/keys/signing.ed25519`) and writes
  the result into `storage/wrapper/v2/cache/<host_id>/<engine>/<config_version>/`.
  Any host mutation that affects the bake bumps `hosts.config_version`, which
  is the cache key.
- **Binaries** — committed (or CI-uploaded) under
  `storage/wrapper/v2/bin/<engine>/<os>-<arch>/v<version>/<engine>` and served
  as static files (long-cached, ETag = SHA256). `BinaryRegistry` discovers them.
- **Bootstrap shim** — emitted by `BootstrapShimBuilder::build`. The shim is the
  only piece of bash; it does config fetch + sha-check + binary download + exec.

## Public endpoints

- `GET /wrapper/v2/meta` (`WrapperV2Controller::meta`) — current per-engine binary
  manifest. Aliased by the legacy `/wrapper` route.
- `GET /wrapper/v2/config[?sig=1]` — returns the signed per-host config JSON
  (or its detached signature file when `?sig=1`).
- `GET /wrapper/v2/download` — returns the bootstrap shim for this host. Aliased
  by `/wrapper/download`.
- `GET /wrapper/v2/bin/{engine}/{os}-{arch}/v{version}/{binary}` — serves the
  static binary. ETag is the SHA256 from `BinaryRegistry`.
- `GET /install/v2/{token}` / `GET /seed/v2/auth/{token}` / `POST /seed/v2/auth/{token}` —
  v2 installer and seed-auth flows; the legacy `/install/{token}` and
  `/seed/auth/{token}` routes alias here.

## Startup sequence inside the Go binary

Implemented in `wrappers/cdx/internal/lifecycle/run.go` (mirrored for clx):

1. Acquire a per-user `flock` so concurrent invocations don't race.
2. Load `~/.config/codex-orchestrator/cdx.json` and verify its Ed25519 signature
   against the public key embedded in the binary at build time.
3. Best-effort auth sync via `POST /auth` (digest comparison; rewrite of
   `~/.codex/auth.json` if the server has a newer payload).
4. Best-effort `AGENTS.md` and `config.toml` (`settings.json` for Claude) refresh
   via `/agents/retrieve` and `/config/retrieve`.
5. `exec` the upstream `codex` (or `claude`) CLI with the prepared env, forwarding
   stdio and signals.
6. Report token counts to `/usage` after the child exits.

Subcommands available to the user: `run` (default), `status`, `doctor`,
`exec -- <cmd>`, `--version`, `--update`; plus `lane <normal|spark>` and
`profile <name>` on cdx only.

## Verifying a deployment

1. `cd wrappers && make all && make test` — builds local binaries and runs Go tests.
2. `scripts/wrapper-v2-init-keys.sh` followed by `cd wrappers && make pubkey` —
   one-time per environment.
3. `vendor/bin/phpunit -c phpunit.xml.dist tests/WrapperV2*.php` — PHP smoke
   tests for the bakery / installer / seed-auth builders.

## Why v2 replaced the bash bakery

The v1 setup concatenated 51 bash fragments into a 351 KB monolith, baked
plaintext placeholders into it on every `/wrapper/download`, and re-ran SHA256
on every request. v2 swaps all of that for: typed signed JSON; a precomputed
binary inventory; ~3 k LOC of Go instead of 16 k LOC of bash. See
`docs/wrapper-v2-architecture.md` for the full rationale.
