# Agents & Responsibilities

Source-of-truth references live in `docs/interface-api.md`, `docs/interface-db.md`, `docs/interface-cdx.md`, and `docs/interface-clx.md`. Keep them in lock-step with code. This service keeps one canonical auth store per engine (Codex `auth.json` and Claude credentials) for the whole fleet, so every change needs a paper trail.

## Backend stack (post BACKEND-redo)

The HTTP layer is a **Node 22 + Fastify 5 + Drizzle + TypeScript** server rooted at `api/`. The legacy PHP under `src/` and `public/index.php` is retained for one release as a reference; the next release deletes it.

- Entrypoint: `api/src/server.ts` (Fastify boot, plugin registration, `LISTEN_PORT`/`LISTEN_HOST`).
- Schema: `api/src/db/schema.ts` (Drizzle mirror of every MySQL table; the existing DB is the source of truth — Drizzle Kit generates a no-op initial migration).
- Crypto: `api/src/security/secret-box.ts` reads/writes the legacy `sbox:v1[:kid=…]:<b64>` envelope via `libsodium-wrappers`. Password verifier (`api/src/security/password.ts`) accepts bcrypt + phpass + argon2id and transparently rehashes to argon2id on next login.
- Response envelopes: three formatters (`standard` / `openai` / `anthropic`) wired by `api/src/http/envelope/select.ts`; one `onSend` hook reshapes any handler's return value into the right shape based on URL prefix.
- Routes live under `api/src/routes/<group>/` and are mounted by `api/src/routes/index.ts`. Services live under `api/src/services/` — no god services.
- WebSocket admin events are native (`/admin/ws` via `@fastify/websocket`). Services publish via `wsPublisher.publish(type, payload)`.
- Tests: `vitest` with `light-my-request` for in-process integration. The contract suite under `api/test/contract/` replays recorded golden responses captured from the legacy PHP by `tests/contract/record.sh`.

## Multi-Engine Architecture

The orchestrator supports two engines: **Codex** (OpenAI) and **Claude** (Anthropic). A host can have one or both.
- `cdx` wrapper manages Codex; `clx` wrapper manages Claude Code.
- Skills, `AGENTS.md` / `CLAUDE.md`, and MCP are shared across both engines by default (per-engine filename via `Engine::agentsDocument`).
- Auth, config, and CLI binaries are engine-specific.
- The `engine` column/parameter appears throughout the API for routing.
- `Engine::CODEX = 'codex'`, `Engine::CLAUDE = 'claude'` (see `src/Support/Engine.php`).
- Runner state, canonical auth payloads, runner refresh triggers, admin API-disable toggles, key-service listings, and installer scripts are all engine-scoped. When adding a feature that touches any of those, branch per engine instead of silently defaulting to Codex.

## Dual-engine parity (kept current)

Treat Codex (`cdx`) as canonical and Claude (`clx`) as parity target. Before landing any engine-agnostic feature, add both paths. Intentional deltas (documented, not implemented for Claude) are:
- ChatGPT quota lanes / Spark lane / `--lane` / `POST /host/lane` — Codex/ChatGPT-only concept.
- `reasoning_effort` override — no such parameter in Anthropic's API.
- Device-code CLI login (`/cli/auth/*`) — Claude Code accepts `ANTHROPIC_API_KEY` directly; the wrapper syncs credentials.
- GitHub-release CLI download — Claude CLI is npm-only; `clx --update` uses `npm install -g @anthropic-ai/claude-code` (with a sudo fallback).
- SSH alt-screen suppression — Claude CLI handles its own terminal state.
- OpenAI auth is `Bearer`-only (matches OpenAI's public API); the Anthropic-compatible API accepts Bearer / `x-api-key` / raw token (matches Anthropic's public API).

## Voice & Contact Rules

- First contact: be friendly and land a dry joke if it fits. No slapstick, no memes.
- Tone: two senior engineers pairing. Direct, opinionated, honest about ambiguity; state assumptions when you make them.
- Default to Linux-fluent answers. Assume the reader already knows SSH/systemd/curl basics.
- Avoid fake cheerleading or filler apologies. Highlight trade-offs and edge cases instead.

## Process & Ops Guardrails

- Run `git pull` before touching anything.
- For each task: code → test → `git commit` → push.
- Do not push to `github` unless the user explicitly says so. Default remote for pushes is `origin`.
- Update `CHANGELOG.md` (newest date first, grouped under `# YYYY-MM-DD` headers with items listed below each date) for any behavior visible to humans.
- If a change requires Docker services or the baked `cdx`, rebuild + restart the stack.
- Never lose `AUTH_ENCRYPTION_KEY`; secretbox protects API keys + auth payloads. Bootstrapped into `.env` if missing.
- API kill switch (`/admin/api/state`) blocks every route except `/admin/api/state`.
- Rate limits: per-IP `global` bucket for every non-admin route and `auth-fail` for repeated bad API keys. Respect `bucket`/`reset_at` metadata.
- When AGENTS/cdx/clx behavior changes, also update `docs/interface-*.md`, dashboard copy, and wrapper fragments as needed.
- Quota tracking supports both ChatGPT (Codex) and Claude usage quotas. The admin dashboard shows per-engine usage breakdowns.

## Repo Snapshot

- `public/index.php` is the entrypoint/router: boots env + migrations, runs one-time auth encryption backfills, wires services/repositories/rate limits, seeds wrapper metadata, and registers all HTTP routes.
- `App\Services\AuthService` owns `/auth`, host registration, IP binding + roaming, insecure host windows (0–480 min, default stored window 10 min; initial provisioning window 30 min), digest caching, canonicalization (RFC3339 timestamps, sha256 digests, fallback from `tokens.access_token`/`OPENAI_API_KEY`), runner preflight/recovery, token usage logging, and pruning.
- `RunnerVerifier` probes `AUTH_RUNNER_URL`, validates uploaded canonical auth before `/auth` store persists it, and can return `updated_auth`. Runner failures set `runner_state=fail`; `/auth` retrieve still serves, but `/auth` store is blocked when runner is unreachable or returns non-OK.
- `WrapperService` seeds/stores the baked `bin/cdx`, tracks wrapper version/sha, and renders host-baked wrapper content for `/wrapper` + `/wrapper/download`.
- `SkillService`, `AgentsService`, `ClientConfigService`, and `MemoryService` back skill, AGENTS, config, and MCP-memory sync APIs/tables.
- `App\Security\RateLimiter` + `IpRateLimitRepository` enforce the `global` bucket (defaults 120/min) and `auth-fail` bucket (defaults 20 misses / 10 min with 30 min block).
- MySQL schema is codified in `Database::migrate()`; encrypted rows use libsodium secretbox (`sbox:v1`). Current core tables include hosts/auth payloads & entries/state/digests, host users, install + auth-seed tokens, skills, agents docs/state, client config docs, MCP memories + access logs, token usage + ingests, chatgpt snapshots, versions, logs/admin events/users/sessions/password resets, insecure auth requests/domain allows, and ip rate limits.

## Request Flow & Behavior Cheatsheet

1. **Provision → install → seed**
   - `POST /admin/hosts/register` creates/rotates API keys, sets host flags (`secure`, `vip`, `temporary`, `curl_insecure`, `reverse_dns_mode`), and issues an installer token.
   - `GET /install/{token}` emits the `cdx` installer script (single-use token, base URL from `PUBLIC_BASE_URL` or forwarded host/proto). Missing/expired tokens return `text/x-shellscript` errors.
   - `GET /seed/auth/{token}` emits an auth-seed script; `POST /seed/auth/{token}` ingests auth JSON directly into canonical store (`skipRunner=true`), then invalidates the token.

2. **`/auth` retrieve/store**
   - Requires API key header and passes through `global` + `auth-fail` limits, host/IP policy, insecure host windows, and the kill switch.
   - Retrieve path (`command=retrieve`, default) validates client digest/timestamp and returns status (`valid`, `outdated`, `upload_required`, `missing`) plus metadata: `versions` (client/wrapper/runner/quota/cdx_silent/installation), host payload, API call count, and current-month token totals. `/auth` response appends `chatgpt_usage`.
   - Store path (`command=store`) enforces RFC3339 `last_refresh` bounds (`>= 2000-01-01`, `<= now+300s`), token quality, canonical sort/digest, and secretbox persistence to `auth_payloads` + `auth_entries`.
   - Runner validation runs before store writes (unless explicit admin/seed skip path). Runner `updated_auth` can replace uploads when it is same/newer; runner unreachability or non-OK status blocks store.
   - Host uninstall uses `DELETE /auth` (IP binding enforced unless `?force=1`).

3. **Runner + preflight**
   - First non-admin request after the preflight interval (`AUTH_RUNNER_PREFLIGHT_SECONDS`, default 8h), excluding `/versions` and `/mcp`, refreshes GitHub client version cache and runs runner preflight.
   - Failure recovery uses backoffs (60s short backoff, 15m retry window, stale-OK threshold 6h, boot-change retry).
   - Runner IP bypass requires `AUTH_RUNNER_IP_BYPASS` enabled and matching CIDRs in `AUTH_RUNNER_BYPASS_SUBNETS`.

4. **Telemetry + sync extras**
   - `/usage` accepts `line` and/or numeric fields (`total`, `input`, `output`, `cached`, `reasoning`; commas allowed), stores per-entry + ingest rows, and returns HTTP 200 with `recorded:false` if ingestion throws.
   - `/host/users` records username/hostname combos for uninstall cleanup and returns known users.
   - `/skills` lists/retrieves/stores canonical skill manifests by slug/sha.
   - `/agents/retrieve` syncs canonical AGENTS doc; `/config/retrieve` syncs rendered client config.
   - `/host/lane` gets/sets lane preference (`normal`, `spark`, `null`) with insecure-window enforcement.
   - `/wrapper` returns host-baked wrapper metadata; `/wrapper/download` streams host-baked wrapper script with sha/etag headers.
   - `/mcp/memories/*` manages host-scoped memory records; `/mcp` serves JSON-RPC MCP tools/resources (GET probe advertises POST-only, with origin allowlist checks).
   - `/versions` is unauthenticated and returns version snapshot metadata when kill switch is off.

5. **Admin panel (mTLS default)**
   - Admin access mode defaults to `mtls` (`ADMIN_ACCESS_MODE`); admin session/capability checks gate mutating routes.
   - `/admin/api/state` is the only reachable route when API kill switch is on.
   - `/admin/hosts/*` manages secure/insecure/roaming/IPv4/curl/reverse-DNS, lane/model/version overrides, VIP, insecure approvals/domain allows, auth clear/delete, and temporary expiry.
   - `/admin/quota-mode` manages `quota_hard_fail`, `quota_limit_percent` (clamped 50–100), and `quota_week_partition` (`off|5|7`); `/admin/hosts/{id}/vip` forces warn-only behavior for VIP hosts.
   - `/admin/usage*`, `/admin/chatgpt/usage*`, `/admin/config*`, `/admin/agents*`, `/admin/skills*`, `/admin/mcp/*`, `/admin/logs`, `/admin/tokens`, and `/admin/ws/info` back dashboard operations.

## Operational Checkpoints

- Troubleshoot hosts with `CODEX_DEBUG=1 cdx --version`; shows baked base URL + masked API key.
- Validate local `~/.codex/auth.json`: must include `last_refresh` + either `auths` entries or `tokens.access_token`. Server synthesizes `auths = {"api.openai.com": ...}` when only tokens exist.
- Insecure hosts auto-open on register for 30 minutes unless `duration_minutes` overrides it; stored sliding window is clamped 0–480 minutes (default 10). Insecure retrieve/MCP/lane calls extend the active window.
- Pruning runs on register/auth flows and admin stale-host passes: removes expired hosts, inactive hosts (`inactivity_window_days`, default 30, max 60, 0 disables inactivity pruning), and never-provisioned hosts older than 30 minutes; logs `host.pruned`.
- ChatGPT snapshots use `ChatGptUsageService` with 5-minute minimum refresh cadence; errors/success log under `chatgpt.usage`.

## cdx Wrapper & Scripts

- Wrapper source is `bin/cdx` assembled from `bin/cdx.d/*.sh` via `scripts/build-cdx.sh`. Do not edit `bin/cdx` directly; edit fragments and rebuild.
- `cdx` workflow:
  - Acquires a run lock (unless `--allow-concurrent-sync`), pulls auth, prunes legacy prompt state, then syncs skills/AGENTS.md/config before launch.
  - Treat `cdx`/MCP as the Skill interface: read Skills through MCP `resource_read` on `skill://{slug}`.
  - Uses local-auth freshness windows of 24h (`MAX_LOCAL_AUTH_AGE_SECONDS`) and secure-host fallback up to 7 days (`MAX_LOCAL_AUTH_RECENT_SECONDS`) during API outages.
  - Reports host users, handles lane preference sync via `/host/lane`, parses Codex token output, and POSTs `/usage`.
  - Honors `/auth` quota controls (`quota_hard_fail`, `quota_limit_percent`, `quota_week_partition`) and displays ChatGPT usage windows + runner state.
  - Purges `~/.codex/auth.json` after run when host is insecure and no concurrent-run guard blocks cleanup.
- Wrapper CLI surface includes: `-4`, `--allow-concurrent-sync`, `lane`, `--wrapper-version|-W`, `status|--status`, `doctor|--doctor`, `--update|-U`, `--uninstall`, `--execute "<prompt>"`, `--debug|--verbose`, and `cdx <profile>` shorthand when profile exists in synced `config.toml`.
- Legacy SQLite migration helper: Unknown / not found in code (`migrate-sqlite-to-mysql.php` is not present in this repository).

## Extension Playbook

- Respect existing patterns; route registration lives in `public/index.php`, while business logic should stay in services/repositories.
- Keep schema migrations + repositories aligned whenever adding columns/tables.
- Document API/request/CLI changes in `docs/OVERVIEW.md` plus relevant `docs/interface-*.md` files, and add/update tests in `tests/`.
- For cdx changes, edit `bin/cdx.d/`, rebuild via `scripts/build-cdx.sh`, bump `WRAPPER_VERSION`, and rebuild Docker images so `storage/wrapper/cdx` seeds correctly.
- Behavioral changes that affect hosts/operators require matching dashboard updates and a `CHANGELOG.md` entry.

## Admin WebUI

- Source: `frontend/` (Svelte 5 + SvelteKit + Tailwind CSS + shadcn-svelte / bits-ui + lucide-svelte + svelte-sonner + @tanstack/svelte-query + mode-watcher). Built with Vite to a static SPA.
- Build output: `public/admin/` (committed). The PHP gateway `public/admin/index.php` enforces mTLS + session, injects `window.__adminBootstrap`, and serves the SPA's `index.html` for any admin route. `public/admin/manual/` ships article content consumed by the in-app help system.
- Develop with `cd frontend && npm install && npm run dev`; produce the deploy artifacts with `npm run build` (output is copied into `public/admin/` by `scripts/copy-build.mjs`). `npm run check` runs `svelte-check`.
- Routing uses `paths.base = '/admin'`. Routes live under `frontend/src/routes/` (`dashboard`, `hosts`, `projects`, `api-keys`, `authoring`, `logs`, `users`, `integrations`, `settings`, `account`, `manual`, `cli-auth/verify`, `login`).
- Server state: `@tanstack/svelte-query` everywhere. WebSocket events invalidate query keys via `frontend/src/lib/ws/events.ts` — feature additions append to `DEFAULT_INVALIDATIONS`, views never wire their own listeners.
- Cmd-K command palette + `?` shortcuts modal in `frontend/src/lib/components/{command-palette,shortcuts}/`. Multi-key chord shortcuts from the legacy UI have been removed in favor of the palette.
