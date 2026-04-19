---
title: Installing and bootstrapping
section: Orientation
verified: 2026-04-19
sources: README.md, bin/setup.sh, docker-compose.yml, src/DatabaseMigrator.php, src/Http/Controllers/InstallController.php, src/Support/InstallerScriptBuilder.php, src/Repositories/InstallTokenRepository.php, src/Repositories/AuthSeedTokenRepository.php, src/Services/WrapperService.php, public/index.php
---

Orchestrator ships as a Docker Compose stack: the PHP app, MariaDB, the auth runner, Caddy as the TLS/reverse proxy, and optionally admin-ws. `bin/setup.sh` walks you through first-time configuration and brings up the stack.

## First boot

1. **Clone and run setup.** `bin/setup.sh` prompts for `.env` values (public base URL, admin access mode, runner secret, TLS material), writes `.env` in the repo root, and calls `docker compose up -d`.
2. **Migrations run automatically.** On every start of the PHP container, `public/index.php` instantiates `DatabaseMigrator` (`src/DatabaseMigrator.php`) which creates or upgrades tables in place. There is no manual `migrate` command — if the app starts, the schema is current.
3. **No admins, no gating.** While `AdminAuthService::isEnforced()` returns false (i.e. `admin_users` is empty), the admin UI serves the first-run screens that let you create the initial admin. The moment you create one, session enforcement flips on for everyone.

## Environment variables the app reads

These are the variables read via `App\Config::get()` that control first boot — defaults are shown when present:

- `PUBLIC_BASE_URL` — canonical base URL the installer script will embed in wrappers.
- `ADMIN_ACCESS_MODE` — `mtls` (default) or `none`. Anything else is treated as `mtls`.
- `ADMIN_SESSION_COOKIE` — default `codex_admin_session`.
- `ADMIN_SESSION_TTL_SECONDS` — default 28800 (8 h), clamped to 300–604800.
- `ADMIN_PASSWORD_MIN_LENGTH` — default 12, clamped to 8–128.
- `ADMIN_WEBAUTHN_RP_ID`, `ADMIN_WEBAUTHN_RP_NAME`, `ADMIN_WEBAUTHN_ORIGIN` — passkey relying-party metadata; inferred from `PUBLIC_BASE_URL` when unset.
- `AUTH_RUNNER_URL`, `AUTH_RUNNER_SHARED_SECRET` — how the PHP app reaches the Python runner.
- `OPENAI_API_TIMEOUT` — default 30 seconds for upstream calls.
- `ENCRYPTION_*` — key material used by `EncryptionKeyManager`. Back these up carefully; losing them destroys the encrypted auth payloads.

Check `docs/INSTALL.md` for the full, current list as configured in your stack.

## Seeding the canonical auth

Hosts cannot fetch auth until the orchestrator has its own copy. Two paths:

- **Admin UI upload.** Sign in as the first admin, use *Admin → Upload auth* (handled by `AdminOverviewController::authUpload`). This is the normal path once you are running.
- **Seed auth token.** `POST /admin/auth/seed-command` (`AdminOverviewController::seedCommand`) mints a single-use token, backed by `AuthSeedTokenRepository`. The admin runs the printed `curl | bash` snippet on the machine that currently holds the canonical `~/.codex/auth.json`. The seed endpoint is `POST /seed/auth/{token}` (`InstallController::seedAuthStore`). Tokens are UUIDs; the route regex is `^/seed/auth/[a-f0-9\-]{36}$`.

The GET twin at `/seed/auth/{token}` (`InstallController::seedAuthScript`) returns an executable shell script that reads your local `auth.json` and POSTs it back. Tokens consume on success.

## Registering a host

`POST /admin/hosts/register` (`AdminHostController::register`) creates a host row and returns a one-shot installer token. The token is stored in `install_tokens` (also UUIDs, regex `^/install/[a-f0-9\-]{36}$`). The install endpoint is `GET /install/{token}` (`InstallController::install`) which calls `InstallerScriptBuilder` to emit the per-host installation script. The admin sees a `curl … | bash` command under *Hosts → New Host*.

What the installer actually does on the target machine:

1. Installs `cdx` and/or `clx` into a location on `PATH`.
2. Bakes the host-specific API key into the wrapper (`WrapperService::bakedForHost()`).
3. Runs the wrapper once in sync mode to pull initial auth and config.
4. Reports its capabilities back (which engines it can run).

## Wrapper distribution

Canonical wrapper sources live at `bin/cdx` and `bin/clx`. `WrapperService::ensureSeeded()` checksums the on-disk script against `client_versions` and refreshes if drift is detected. `GET /wrapper` (`WrapperController::meta`) returns version metadata (hash, semver, published-at); `GET /wrapper/download` returns the canonical script. Hosts use these endpoints to self-update between runs.

## Post-install smoke test

- From the admin UI, visit *Dashboard*. New hosts appear under *Hosts → Unprovisioned* until they complete a successful sync; after that they move to *Secure* (or *Insecure*, if you activated insecure mode on registration).
- Click into any host to see its per-host baked wrapper fingerprint, last auth digest, and IP binding state.
- Trigger *Settings → Runner → Run probe* to verify the runner is reachable; see `AdminOverviewController::runnerRun` / `runnerRunClaude` for exactly what gets pinged.

## Backups

There is no built-in backup job. Back up two things:

1. The MariaDB volume (`docker-compose.yml` names the data volume for you).
2. The encryption keyring referenced by `EncryptionKeyManager`.

Without both you cannot decrypt `auth_payloads`. The app will still run, but every host will fail sync until a fresh canonical auth is re-uploaded.

## Source references

- README.md (quick start)
- bin/setup.sh (interactive installer)
- docker-compose.yml (stack definition)
- src/DatabaseMigrator.php (auto-migration on boot)
- src/Http/Controllers/InstallController.php (install / seed endpoints)
- src/Support/InstallerScriptBuilder.php (per-host script emission)
- src/Repositories/InstallTokenRepository.php
- src/Repositories/AuthSeedTokenRepository.php
- src/Services/WrapperService.php (ensureSeeded, bakedForHost)
- src/Http/Controllers/AdminOverviewController.php (authUpload, seedCommand)
- src/Http/Controllers/AdminHostController.php (register)
- public/index.php (all route regexes)
- src/Security/EncryptionKeyManager.php (keyring)
