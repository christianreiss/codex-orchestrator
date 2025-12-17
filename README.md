# Codex Auth Central API

> **Is this for you?**
> - You run Codex on multiple hosts and want a central `~/.codex/auth.json`.
> - You’re comfortable with Docker and TLS/mTLS.
> - You’re okay storing tokens and usage logs in MySQL.

🔒 Keep one canonical Codex `auth.json` for your whole fleet. 🚀 Mint per-host API keys from the dashboard, bake them into the `cdx` wrapper, and let hosts sync auth/config/prompts automatically while reporting token usage back.

![cdx wrapper baking a host-specific installer and syncing auth](docs/img/cdx.png)

## The 60-second mental model

1. **Admin provisions a host** → mints a host API key + a single-use installer token.
2. **Host runs one command** (`curl …/install/<token> | bash`) → installs a baked `cdx` wrapper.
3. Every time someone runs `cdx …`, it:
   - syncs canonical auth (`/auth`)
   - syncs fleet `config.toml` + profiles (`/config/retrieve` → `~/.codex/config.toml`)
   - syncs slash commands (`/slash-commands` → `~/.codex/prompts/`)
   - syncs Skills (`/skills` → `~/.codex/skills/`)
   - syncs canonical AGENTS (`/agents/retrieve` → `~/.codex/AGENTS.md`)
   - self-updates Codex + the wrapper (and can enforce pinned versions)
   - posts token usage telemetry (`/usage`)

## Why you might like it

- 🌐 One `/auth` call to keep every host in sync (retrieve/store with version metadata).
- 🗝️ Per-host API keys, IP-bound on first contact; single-use installer tokens bake config into `cdx`.
- 🔁 Auto updates + version pinning: self-updating wrapper, automatic Codex updates, and fleet/per-host version pinning (upgrade *or* downgrade).
- 📊 Auditing and usage: token usage rows plus per-request ingests (client IP + normalized payload), cost estimates from GPT‑5.1 pricing, versions, IPs, and runner validation logs.
- 🔒 Canonical auth + tokens encrypted at rest (libsodium).
- 🧠 Extras: slash command + Skill management, canonical AGENTS.md distribution, MCP-compatible memories (store/retrieve/search across sessions), ChatGPT quota snapshots, and daily pricing pulls for cost dashboards.
- 🛠️ Fleet `config.toml` builder + distributor (profiles, approval policy, sandbox, MCP servers, OTEL), synced automatically to `~/.codex/config.toml` on every `cdx` run.

## MCP for Codex (native HTTP, no node shim)

- `/mcp` speaks the streamable HTTP MCP spec (2025‑03‑26) with host API keys; `cdx` bakes an entry automatically so Codex IDE/CLI can call it without extra wiring.
- Tools: `memory_store|memory_retrieve|memory_search`, resource browsing (`resources/templates/list`, `resources/list`, `resources/read` as `text/plain`), scoped notes (`memory_append|memory_query|memory_list`), and sandboxed filesystem helpers (`fs_read_file|fs_write_file|fs_list_dir|fs_stat|fs_search_in_files`).
- Admins get `/admin/mcp/memories` to search/browse stored notes (filter by host/tags/query) and can delete entries with `DELETE /admin/mcp/memories/{record_id}`.
- Quick taste:
```bash
curl -s "$BASE/mcp/memories/store" \
  -H "Authorization: Bearer $HOST_API_KEY" \
  -d '{"content":"recorded a fix for ticket-123","tags":["ticket-123","infra"]}'
```
- MCP resources are `memory://{id}`; recent ones are discoverable via `resources/list`, and create/update/delete/read are all exposed as MCP tools.

## Config builder (baked per host)

- `/admin/config.html` is a full-fidelity builder for `config.toml` (model defaults, approval policy, sandbox, notices, MCP servers, OTEL, custom blocks). Profiles are managed under **Settings → Profiles**.
- Profiles are first-class: per-profile overrides for CLI `--profile` (model/provider, approval policy, sandbox, reasoning knobs, etc.).
- `/config/retrieve` bakes that template per host, injecting the caller’s API key into the managed MCP entry and returning both the baked `sha256` and the base template hash so clients can skip unchanged files.
- `cdx` writes the baked file to `~/.codex/config.toml` on every run and deletes it when the server returns `status:missing`.
- Managed MCP uses native HTTP—no npm wrapper needed:
```toml
[mcp_servers.cdx]
url = "{base_url}/mcp"
http_headers = { Authorization = "Bearer {host_api_key}" }
```
- Toggle the managed entry off in the builder if you prefer your own MCP list; API keys are never stored server-side, only injected at bake time.

## Auto updates & version pinning (Codex + wrapper)

- **Codex updates**: `cdx` updates the Codex binary to the server-reported target when it has permission (Linux + root/passwordless sudo).
- **Fleet pinning**: admins can set the whole fleet to “Latest” or pin to an exact Codex release; pinned hosts get `client_version_source=locked` so `cdx` enforces the exact version.
- **Per-host overrides**: a single host can override the fleet pin (useful for phased rollouts / debugging).
- **Wrapper self-update**: `cdx` can replace itself from `/wrapper/download`, verifying hashes so hosts converge on a known wrapper build.

Host-side force update:
```bash
cdx --update
```

## Slash command management (prompts as fleet-owned artifacts)

- Server stores prompts in MySQL (sha256-addressed) and exposes them via `/slash-commands`. Skills live alongside prompts (`skills` table + `/skills*` endpoints) so every host keeps a canonical `~/.codex/skills/<slug>.json`.
- Admins can create/update/retire prompts from the dashboard; delete marks propagate to hosts on next sync.
- `cdx` keeps `~/.codex/prompts/` in sync:
  - pulls on start (hash mismatch → retrieve)
  - removes server-retired prompts locally
  - pushes changed/new prompts back on exit (so editing locally still works)

## Wrapper QoL (`cdx`)

- Offline-friendly: treats HTTP 5xx/network outages as “offline” and can proceed with cached auth (≤24h for insecure hosts, ≤7 days for secure hosts, with warnings).
- Convenience modes: `cdx <profile>` (alias for `--profile <profile>` when it exists in synced `config.toml`), `cdx --execute "<prompt>"`, and `cdx --uninstall`.

## See it in action

- **Dashboard overview** — track host health, latest digests, versions, and API usage at a glance.
- **Host detail** — inspect canonical auth digests, recent validations, and roaming status per host.
- **Token usage** — visualize per-host token consumption (total/input/output/cached/reasoning) for billing or investigations.

![Admin dashboard overview screen](docs/img/dashboard_1.png)

![Per-host digests and validation logs](docs/img/dashboard_2.png)

![Token usage aggregates and recent activity](docs/img/dashboard_3.png)

## Get going fast

Use the installer to generate `.env`, secrets, and compose overrides, then start the stack. Full options live in `docs/INSTALL.md`.

```bash
bin/setup.sh                  # interactive; generates .env and config
docker compose up --build     # API on http://localhost:8488 with MySQL sidecar
```

Need TLS/mTLS via the bundled Caddy frontend? `bin/setup.sh --caddy ...` or see `docs/INSTALL.md` for examples.

## Usage & cost telemetry

- Send a single line or `usages: [...]` array to `/usage`; the API normalizes/sanitizes lines, attaches model-aware cost from the latest pricing snapshot, and stores both per-row entries (`token_usages`) and a per-request ingest envelope (`token_usage_ingests`) with aggregates + client IP.
- Admins can explore token rows at `/admin/usage`, ingest envelopes at `/admin/usage/ingests`, and cost/time trends (up to 180 days, pricing optional) at `/admin/usage/cost-history`.
- Pricing defaults to GPT‑5.1 and refreshes daily from `PRICING_URL` (or `GPT51_*`/`PRICING_CURRENCY` env fallbacks); missing pricing zeroes cost but still records usage.

## Contributing / local dev

- `composer install`
- `php -S localhost:8080 -t public`
- Ensure `storage/` is writable by PHP.

## Documentation

- Installation and deployment (including `bin/setup.sh`, TLS/mTLS, and Docker profiles): `docs/INSTALL.md`
- Host provisioning and running Codex via the `cdx` wrapper: `docs/USAGE.md`
- System overview, request flow, and operational notes: `docs/OVERVIEW.md`
- Human-friendly API surface overview: `docs/API.md`
- MCP server usage and tools: `docs/MCP.md`
- Config builder workflow and per-host baking: `docs/CONFIG_BUILDER.md`
- Admin dashboard workflows (hosts, version pinning, quotas, kill switch, prompts, agents): `docs/ADMIN.md`
- Source-of-truth interface contracts: `docs/interface-api.md`, `docs/interface-cdx.md`, `docs/interface-db.md`
- Auth runner behavior and probes: `docs/auth-runner.md`
- Security policy and hardening checklist: `docs/SECURITY.md`

## Codex instructions

`AGENTS.md` (repo root) remains a useful template, but the server now owns the canonical copy. Update it from the dashboard’s **AGENTS.md** panel; the API stores one version and every host pulls it into `~/.codex/AGENTS.md` on each run (removing stale local copies if the server copy is cleared). See the [Custom instructions with AGENTS.md guide](https://developers.openai.com/codex/guides/agents-md) for authoring tips.
