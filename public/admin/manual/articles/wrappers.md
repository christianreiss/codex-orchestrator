---
title: The cdx and clx wrappers
section: Fleet operations
verified: 2026-04-19
sources: bin/cdx, bin/clx, src/Services/WrapperService.php, src/Services/StartupSyncService.php, src/Http/Controllers/WrapperController.php, src/Http/Controllers/AuthController.php, src/Support/Engine.php
---

`cdx` wraps the Codex CLI; `clx` wraps the Claude Code CLI. Each wrapper is a shell script with placeholders (`__CDX_SYNC_BASE_URL__`, `__CDX_SYNC_API_KEY__`, …) that `WrapperService::bakedForHost()` substitutes at install time. The resulting script is written to the host's PATH during install and refreshed on every run if the server has a newer copy.

## What lives where

- **Canonical templates** — `bin/cdx`, `bin/clx` in this repository. These are the *templates*; they contain the placeholders.
- **Baking** — `WrapperService::bakedForHost()` (`src/Services/WrapperService.php:125`) loads a template, replaces the placeholders for one host, and returns the rendered script in-memory. The placeholder list differs per engine:
  - Codex: `__CDX_SYNC_BASE_URL__`, `__CDX_SYNC_API_KEY__`, `__CDX_SYNC_FQDN__`, `__CDX_SYNC_CA_FILE__`, `__CDX_HOST_SECURE__`, `__WRAPPER_VERSION__`, `__CDX_SYNC_ALLOW_INSECURE__`, `__INSTALLATION_ID__`, …
  - Claude: `__CLAUDE_SYNC_BASE_URL__`, `__CLAUDE_SYNC_API_KEY__`, `__CLAUDE_SYNC_FQDN__`, `__CLAUDE_SYNC_CA_FILE__`, `__CLAUDE_HOST_SECURE__`, `__CLAUDE_HOST_MODEL__` (optional), `__CLAUDE_INSTALLATION_ID__`, `__WRAPPER_VERSION__`, `__CLAUDE_SILENT__`, `__CLAUDE_SYNC_ALLOW_INSECURE__`.
- **Version tracking** — `VersionRepository` stores `wrapper` and `wrapper_claude` keys which hold the latest template version string (a content-derived hash). `WrapperService::ensureSeeded()` recomputes and writes this on every boot.
- **Per-host storage** — the baked plaintext is not stored on the server; it is rendered on demand. What is stored is the host's API key (encrypted at rest via `SecretBox` if `api_key_enc` is set, or the `api_key_plain` column for simple deployments).

## Public download endpoint

- `GET /wrapper` (`WrapperController::meta`) — returns `{engine, version, sha256, size_bytes, updated_at, url}` for the current template. Accepts `?engine=codex|claude`.
- `GET /wrapper/download` — returns the (un-baked) template body. This is used by a running wrapper to self-update once it already has credentials baked in; the remote SHA is compared against the locally stored one before overwriting.

## Startup sync contract

Every wrapper run begins with a startup sync. The client side (inside `bin/cdx` / `bin/clx`) composes a payload with its current auth digest, config hash, AGENTS.md hash, skills manifest hash, and wrapper version, and POSTs it to `/sync/status`. The server side is `StartupSyncService::collect()` (`src/Services/StartupSyncService.php:24`). The return tells the wrapper what is stale:

- If the auth digest mismatches the server's latest → fetch via `/auth`.
- If the AGENTS.md hash mismatches → fetch via `/agents/retrieve` (`ConfigApiController`).
- If config hash mismatches → fetch via `/config/retrieve`.
- If the skills manifest hash mismatches → fetch individual skills from `/skills/retrieve`.
- If the wrapper version mismatches → fetch template from `/wrapper/download` and re-self-bake; next run uses the new version.

For large deltas the wrapper uses `POST /sync/bootstrap` which returns everything it needs in one round-trip rather than N separate calls.

## Reporting back

When a wrapped CLI exits, the wrapper sends a usage report to `POST /usage` (`HostApiController::recordUsage`) with token counts. `HostApiController::recordUsers` reports the set of OS users observed during the run. These feed the usage charts on the dashboard.

On successful first sync after registration, the wrapper reports its capability set — which engines it can actually run — so the admin UI can hide irrelevant settings per host (e.g. Claude model select on a Codex-only host).

## Silent mode

Two global flags on `VersionRepository` control console chatter:

- `cdx_silent` — Codex wrapper goes quiet.
- `clx_silent` — Claude wrapper goes quiet.

Toggled from *Settings → General*. The flags are baked into the wrapper as `__CDX_SILENT__` / `__CLAUDE_SILENT__` and inspected on every run.

## Auto-update behaviour

Fleet-wide auto-update (on `VersionRepository` as `auto_update`) affects both the wrapper's self-update check and the wrapped CLI's update check. Per-host override at `POST /admin/hosts/{id}/auto-update` lets you pin a single host while the rest keep rolling. The same flag controls whether Codex / Claude binaries get refreshed via their own CLIs during the wrapper run.

## Anatomy of a run

```text
cdx "prompt text"
 ├─ POST /sync/status → response says "all up to date"
 │    (or) fetch new auth / agents / skills / wrapper
 ├─ exec codex "prompt text" (real OpenAI CLI, now authenticated from ~/.codex/auth.json)
 └─ POST /usage    → server records token counts
```

`clx` is the same shape but `exec`s Claude instead.

## Insecure hosts

On an insecure host, the wrapper purges `~/.codex/auth.json` after each exec (or keeps it within the approved window). It never writes any key to disk outside the controlled window. See [auth-pipeline](/admin/manual/auth-pipeline) for the window / grace maths.

## When a wrapper goes wrong

- **`403 insecure window closed`** — this host is insecure and its window has expired. Approve from the *Insecure* tab.
- **`401 api key mismatch`** — the key baked into the wrapper has been rotated or the host was deleted. Re-install via a new install token.
- **`Invalid auth response`** — the runner probe failed. Check *Settings → Runner → Run probe* for the upstream status.
- **`Wrapper SHA mismatch, refusing to overwrite`** — someone has hand-edited the wrapper on disk. Re-run the installer or delete the local copy before the next auto-update.

## Source references

- bin/cdx, bin/clx (templates)
- src/Services/WrapperService.php (ensureSeeded, metadata, bakedForHost)
- src/Services/StartupSyncService.php (sync/status + sync/bootstrap contract)
- src/Http/Controllers/WrapperController.php (meta, download)
- src/Http/Controllers/AuthController.php (auth, sync endpoints)
- src/Http/Controllers/HostApiController.php (usage reporting)
- src/Support/Engine.php (engine constants and wrapper naming)
- src/Repositories/VersionRepository.php (version keys, silent flags)
