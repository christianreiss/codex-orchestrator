# Codex Orchestrator

Codex Orchestrator is a small PHP/MySQL service that keeps one canonical Codex auth, config, prompts, and usage log for every host in your fleet. It bakes per-host installers, syncs everything every time someone runs `cdx`, and gives you dashboards for usage, quotas, and versions.

![Host-specific installer baking and sync flow](docs/img/cdx.png)

## Why would I need this?
- You run Codex on more than one machine and do not want to copy tokens by hand.
- You want per-host API keys with IP binding and the option to treat some machines as insecure (no auth left on disk).
- You prefer a single place to manage fleet config, slash commands, Skills, and AGENTS.md.
- You need usage/cost reporting and a quota or kill switch you can enforce centrally.
- You want auto-updated wrappers and Codex versions with the ability to pin or roll back.

If you only use Codex on one laptop, this is probably overkill.

## How it works (one minute)
1) Seed the canonical `~/.codex/auth.json` in the admin UI (or via `/auth` store).
2) Add a host in `/admin` to mint a per-host API key and one-time installer token.
3) Run the installer on the host: `curl .../install/<token> | bash`. It installs Codex plus a host-baked `cdx` wrapper.
4) Every `cdx` run syncs auth, config, prompts, Skills, and AGENTS, enforces quota policy, self-updates, and posts usage back.

## What you get
- Central auth vault: encrypted canonical auth.json plus per-target tokens; runner sidecar validates uploads and can auto-accept newer auth from Codex.
- Host installer and wrapper: per-host API keys baked into the `cdx` script; offline-tolerant with secure vs insecure host modes.
- Fleet config builder: admin UI renders `config.toml` and injects host-specific MCP headers; delivered to `~/.codex/config.toml`.
- Prompt and Skill distribution: slash commands and Skills live in MySQL and sync to `~/.codex/prompts/` and `~/.codex/skills/`; AGENTS.md is canonical too.
- Usage, cost, and quotas: `/usage` ingest with GPT-5.1 pricing, per-host token totals, ChatGPT quota snapshots, VIP hosts, global warn/hard-fail slider, and an API kill switch.
- Version control: pin Codex version fleet-wide or per host; wrapper self-updates from server-controlled binaries.
- Dashboards and API: mTLS-protected admin UI for hosts, usage, config, and AGENTS; HTTP API for automation.
- MCP server: native HTTP MCP endpoint with memory store/retrieve/search and filesystem helpers; baked into managed `config.toml` entries.

## See it in action
![Admin dashboard overview](docs/img/dashboard_1.png)
![Per-host digests and validation logs](docs/img/dashboard_2.png)
![Token usage aggregates and recent activity](docs/img/dashboard_3.png)

## Quick start (Docker)
Prerequisites: Docker and Docker Compose.

```bash
bin/setup.sh                 # writes .env, builds, and starts the stack by default
# headless dev without Caddy/mTLS:
# bin/setup.sh --non-interactive --no-caddy --mtls-optional --codex-url http://localhost:8488 --data-root ./storage/docker_data
# if you skipped build/up with --no-build/--no-up/--prepare-only:
# docker compose up --build    # add --profile caddy if you enabled the proxy
```

Defaults: requires mTLS on `/admin/`, enables the bundled Caddy profile when left on, and binds data under `/var/docker_data/...` unless you override `--data-root`. First run pulls `mysql:8.0` and `php:8.2-apache`, so allow extra time. Open `http://localhost:8488/admin/` (or your TLS host) to finish setup.

## Onboard a host
1) Ensure the canonical `~/.codex/auth.json` is uploaded (Admin → Auth Upload).
2) Admin → Hosts → New Host → copy the installer command (`curl .../install/<token> | bash`).
3) Run that command on the target machine. It installs Codex and the baked `cdx` wrapper.

You can also automate provisioning with `POST /admin/hosts/register` (requires admin mTLS by default).

## Run Codex on a provisioned host
```bash
cdx                 # sync and launch with fleet defaults
cdx myprofile       # use a named profile baked into config.toml
cdx --execute "show me open PRs"  # one-shot output
```
Secure hosts keep `~/.codex/auth.json` on disk; insecure hosts delete it after each run and require an open insecure window.

## Security guardrails
- Per-IP binding with optional roaming; insecure windows for hosts that must not keep auth on disk.
- Secretbox encryption for API keys and auth payloads; API kill switch for emergencies.
- Rate limits for all non-admin routes plus an auth-fail bucket for repeated bad keys.
- Runner validation and hash-checked wrapper downloads.

## Documentation
- Installation: `docs/INSTALL.md`
- Host and user workflow: `docs/USAGE.md`
- System overview and flow: `docs/OVERVIEW.md`
- API surface: `docs/API.md` and `docs/interface-api.md`
- MCP details: `docs/MCP.md`
- Config builder: `docs/CONFIG_BUILDER.md`
- Admin dashboard: `docs/ADMIN.md`
- DB/contracts: `docs/interface-db.md`, `docs/interface-cdx.md`

License: see `LICENSE`.
