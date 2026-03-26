# Agents & Responsibilities

Source-of-truth references live in `docs/interface-api.md`, `docs/interface-db.md`, and `docs/interface-cdx.md`. Keep them in lock-step with code. This service keeps one canonical Codex `auth.json` for the whole fleet, so every change needs a paper trail.

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
- Pricing snapshots are for model `gpt-5.4` with 24h refresh (`PRICING_URL` when set, otherwise preferred `GPT54_*` + `PRICING_CURRENCY` env fallbacks with legacy `GPT51_*` compatibility). `UsageCostService` backfills missing token usage + ingest costs once on boot.
- When AGENTS/cdx behavior changes, also update `docs/interface-*.md`, dashboard copy, and wrapper fragments as needed.

## Repo Snapshot

- `public/index.php` is the entrypoint/router: boots env + migrations, runs one-time auth encryption backfills, wires services/repositories/rate limits, seeds wrapper metadata, backfills usage costs, and registers all HTTP routes.
- `App\Services\AuthService` owns `/auth`, host registration, IP binding + roaming, insecure host windows (0–480 min, default stored window 10 min; initial provisioning window 30 min), digest caching, canonicalization (RFC3339 timestamps, sha256 digests, fallback from `tokens.access_token`/`OPENAI_API_KEY`), runner preflight/recovery, token usage logging, and pruning.
- `RunnerVerifier` probes `AUTH_RUNNER_URL`, validates uploaded canonical auth before `/auth` store persists it, and can return `updated_auth`. Runner failures set `runner_state=fail`; `/auth` retrieve still serves, but `/auth` store is blocked when runner is unreachable or returns non-OK.
- `WrapperService` seeds/stores the baked `bin/cdx`, tracks wrapper version/sha, and renders host-baked wrapper content for `/wrapper` + `/wrapper/download`.
- `SlashCommandService`, `SkillService`, `AgentsService`, `ClientConfigService`, and `MemoryService` back slash-command, skill, AGENTS, config, and MCP-memory sync APIs/tables.
- `App\Security\RateLimiter` + `IpRateLimitRepository` enforce the `global` bucket (defaults 120/min) and `auth-fail` bucket (defaults 20 misses / 10 min with 30 min block).
- `PricingService`, `UsageCostService`, and `CostHistoryService` refresh pricing, compute per-entry/aggregate costs for `/usage`, and expose up-to-180-day cost history.
- MySQL schema is codified in `Database::migrate()`; encrypted rows use libsodium secretbox (`sbox:v1`). Current core tables include hosts/auth payloads & entries/state/digests, host users, install + auth-seed tokens, slash commands, skills, agents docs/state, client config docs, MCP memories + access logs, token usage + ingests, chatgpt snapshots, pricing snapshots, versions, logs/admin events/users/sessions/password resets, insecure auth requests/domain allows, and ip rate limits.

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
   - `/usage` accepts `line` and/or numeric fields (`total`, `input`, `output`, `cached`, `reasoning`; commas allowed), stores per-entry + ingest rows, computes `cost`, and returns HTTP 200 with `recorded:false` if ingestion throws.
   - `/host/users` records username/hostname combos for uninstall cleanup and returns known users.
   - `/slash-commands` + `/skills` list/retrieve/store prompt/skill documents by sha.
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
   - `/admin/usage*`, `/admin/chatgpt/usage*`, `/admin/config*`, `/admin/agents*`, `/admin/slash-commands*`, `/admin/skills*`, `/admin/mcp/*`, `/admin/logs`, `/admin/tokens`, and `/admin/ws/info` back dashboard operations.

## Operational Checkpoints

- Troubleshoot hosts with `CODEX_DEBUG=1 cdx --version`; shows baked base URL + masked API key.
- Validate local `~/.codex/auth.json`: must include `last_refresh` + either `auths` entries or `tokens.access_token`. Server synthesizes `auths = {"api.openai.com": ...}` when only tokens exist.
- Insecure hosts auto-open on register for 30 minutes unless `duration_minutes` overrides it; stored sliding window is clamped 0–480 minutes (default 10). Insecure retrieve/MCP/lane calls extend the active window.
- Pruning runs on register/auth flows and admin stale-host passes: removes expired hosts, inactive hosts (`inactivity_window_days`, default 30, max 60, 0 disables inactivity pruning), and never-provisioned hosts older than 30 minutes; logs `host.pruned`.
- ChatGPT snapshots use `ChatGptUsageService` with 5-minute minimum refresh cadence; errors/success log under `chatgpt.usage`.
- Pricing refresh cadence is daily (24h cache) with env fallback pricing when remote pricing is unavailable.

## cdx Wrapper & Scripts

- Wrapper source is `bin/cdx` assembled from `bin/cdx.d/*.sh` via `scripts/build-cdx.sh`. Do not edit `bin/cdx` directly; edit fragments and rebuild.
- `cdx` workflow:
  - Acquires a run lock (unless `--allow-concurrent-sync`), pulls auth, then syncs slash commands, AGENTS.md, and config before launch.
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
- Behavioral changes that affect hosts/operators require matching dashboard updates (`public/admin/`) and a `CHANGELOG.md` entry.
