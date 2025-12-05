# Agents & Responsibilities

**BANANA** must appear in your first reply. Non-negotiable.

Source-of-truth references live in `docs/interface-api.md`, `docs/interface-db.md`, and `docs/interface-cdx.md`. Keep them in lock-step with code. This service keeps one canonical Codex `auth.json` for the whole fleet, so every change needs a paper trail.

## Voice & Contact Rules

- First contact: be friendly and land a dry joke if it fits. No slapstick, no memes.
- Tone: two senior engineers pairing. Direct, opinionated, honest about ambiguity; state assumptions when you make them.
- Default to Linux-fluent answers. Assume the reader already knows SSH/systemd/curl basics.
- Avoid fake cheerleading or filler apologies. Highlight trade-offs and edge cases instead.

## Process & Ops Guardrails

- Run `git pull` before touching anything.
- For each task: code → test → `git commit` → push.
- Update `CHANGELOG.md` (newest date first) for any behavior visible to humans.
- If a change requires Docker services or the baked `cdx`, rebuild + restart the stack.
- Never lose `AUTH_ENCRYPTION_KEY`; secretbox protects API keys + auth payloads. Bootstrapped into `.env` if missing.
- API kill switch (`/admin/api/state`) blocks every non-admin route, `/auth` included. Only `/admin/api/state` bypasses it.
- Rate limits are always on: per-IP `global` bucket for every non-admin route and `auth-fail` for repeated bad API keys. Respect `bucket`/`reset_at` metadata.
- Pricing defaults to GPT-5.1 from `PRICING_URL` (or `GPT51_*`/`PRICING_CURRENCY`). `UsageCostService` backfills token rows + ingests on boot.
- When AGENTS/cdx behavior changes, also update `docs/interface-*.md`, dashboard copy, and wrapper fragments as needed.

## Repo Snapshot

- `public/index.php` is the entrypoint/router: boots env + migrations, wires encryption (`SecretBox`), repositories, services, rate limits, wrapper seeding, usage cost backfill, and routes (host, admin, installer, slash commands, AGENTS, versions).
- `App\Services\AuthService` owns `/auth`, host registration, IP binding + roaming, insecure host windows (2–60 min sliders, stored per host), digest caching, canonicalization (RFC3339 timestamps, sha256 digests, fallback from `tokens.access_token`/`OPENAI_API_KEY`), runner preflight (default 8h with backoffs), token usage logging, ChatGPT snapshots, API kill switch enforcement, and pruning (inactive ≥30d or never-provisioned >30m).
- `WrapperService` seeds/stores the baked `bin/cdx`, tracks wrapper version/sha, bakes per-host scripts, and is the only source of truth for wrapper publishing.
- `RunnerVerifier` posts canonical auth to `AUTH_RUNNER_URL`, tracks readiness, and applies runner-returned `updated_auth`. Runner failures flip `runner_state=fail` but don’t block `/auth`.
- `SlashCommandService` and `AgentsService` back their respective MySQL tables (`slash_commands`, `agents_documents`) so every host syncs prompts and AGENTS.md during wrapper runs.
- `RateLimiter` + `IpRateLimitRepository` enforce the `global` bucket (defaults 120/min) and `auth-fail` bucket (20 misses per 10 min → 30 min block).
- `PricingService`, `UsageCostService`, and `CostHistoryService` pull GPT-5.1 pricing daily, compute per-entry and aggregate costs for `/usage`, and expose ≥180-day cost charts.
- MySQL schema is codified in `Database::migrate()`; encrypted rows use libsodium secretbox (`sbox:v1`). See `docs/interface-db.md` for columns (hosts, auth_payloads/entries, host_auth_states/digests, host_users, token usage + ingests, slash commands, agents, chatgpt snapshots, pricing, install tokens, versions, logs, ip_rate_limits).

## Request Flow & Behavior Cheatsheet

1. **Provision → install**
   - `POST /admin/hosts/register` mints/rotates API keys, hashes + secretbox-encrypts them, issues one pending installer token, and opens a 30-minute provisioning window if `secure=false`.
   - `GET /install/{token}` emits the `cdx` installer (single-use token, base URL baked from `PUBLIC_BASE_URL` or forwarded Host/proto). Missing/expired tokens return `text/x-shellscript` errors.

2. **`/auth` retrieve/store**
   - Requires API key header and passes through `global` + `auth-fail` buckets, IP binding, insecure host windows, and the API kill switch.
   - Retrieve path returns canonical auth when digests differ plus metadata: versions (GitHub cache w/ stale fallback, wrapper sha/url, runner telemetry, `quota_hard_fail`, `quota_limit_percent`, `installation_id`), host stats (API calls, current-month tokens), VIP flag, insecure window timestamps, ChatGPT quota snapshot (`chatgpt_usage`), and up to three recent digests.
   - Store path enforces RFC3339 `last_refresh` bounds (>= 2000-01-01, <= now+300s), token entropy, canonical sorting, hashed digests, and secretbox persistence to `auth_payloads` + `auth_entries`. Runner validations run opportunistically after stores; `updated_auth` from the runner replaces client uploads when newer.
   - Host uninstall uses `DELETE /auth` (respects IP binding unless `?force=1`).

3. **Runner + daily preflight**
   - First non-admin hit after ~8h (configurable via `AUTH_RUNNER_PREFLIGHT_SECONDS`) refreshes GitHub client version cache, seeds wrapper metadata, and runs the runner once. Backoff path: 60s pause after failure, 15m retry window, immediate retry on boot change or stale OK (>6h).
   - `AUTH_RUNNER_IP_BYPASS` CIDRs allow runner-originated validations without rebinding host IPs.

4. **Telemetry + extras**
   - `/usage` sanitizes numeric totals/input/output/cached/reasoning (commas allowed) or raw `line`, writes per-entry rows + ingest envelope with aggregates, computed `cost`, payload snapshot, and optional client IP. HTTP 200 + `recorded:false` when ingest persistence fails.
   - `/host/users` records username/hostname combos for uninstall cleanup and returns the set for `cdx`.
   - `/slash-commands` list/retrieve/store/delete prompts; clients sync by sha and push local edits on exit.
   - `/agents/retrieve` syncs canonical AGENTS.md. Hosts delete their local copy when the API returns `status:missing`.
   - `/versions` exposes client/wrapper versions, runner metadata, kill switch flags, and wrapper download URL without auth (good for smoke tests).

5. **Admin panel (mTLS default)**
   - `/admin/overview` surfaces hosts, digests, versions, quotas, pricing, and install guidance.
   - `/admin/hosts/*` toggles secure/insecure/roaming/IPv4-only, sets sliding windows, clears canonical state, and deletes hosts.
   - `/admin/api/state` is the only route reachable when the kill switch is active.
   - `/admin/quota-mode` toggles ChatGPT hard-fail vs warn-only **and** sets the warn/kill threshold (`limit_percent`, dashboard slider under Operations & Settings). `/admin/hosts/{id}/vip` promotes/demotes a host-specific VIP flag that forces warn-only behavior regardless of the global setting. Both values propagate via `/auth`.
   - `/admin/usage*` covers per-row tokens, ingests, and cost history (≤180 days).
   - `/admin/chatgpt/usage*` exposes snapshots/history with a 5-minute cooldown (unless forced).
   - `/admin/agents` pulls/pushes AGENTS.md including sha + content for the dashboard editor.

## Operational Checkpoints

- Troubleshoot hosts with `CODEX_DEBUG=1 cdx --version`; shows baked base URL + masked API key.
- Validate local `~/.codex/auth.json`: must include `last_refresh` + either `auths` tokens or `tokens.access_token`. Server synthesizes `auths = {"api.openai.com": ...}` when only tokens exist.
- Insecure hosts auto-open 30m on register; afterwards “Enable” on the dashboard sets a 2–60 min sliding window (default 10). Each `/auth` call extends by the stored duration. “Disable” closes instantly (no write grace).
- Pruning: every register/auth call deletes inactive hosts (≥30d since last activity) or never-provisioned hosts older than 30m. Events log `host.pruned`.
- ChatGPT snapshots refresh before `/auth` responses when the cooldown (5m) allows; errors log `chatgpt.snapshot_error` and surface in admin UI.
- Pricing snapshot refresh: daily background pull from `PRICING_URL`, fallback to env constants. Admin overview uses the freshest values for month estimates; cost history falls back to zero cost when no pricing exists.

## cdx Wrapper & Scripts

- Wrapper source is `bin/cdx` assembled from `bin/cdx.d/*.sh` via `scripts/build-cdx.sh`. Never edit the built file directly; bump `WRAPPER_VERSION` on every wrapper change so hosts refresh.
- `cdx` workflow:
  - Pull canonical auth via `/auth`, obey kill switch, insecure windows, and offline caching rules (24h for insecure hosts, 7d for secure hosts with warnings).
  - Report host users, sync slash commands + AGENTS.md (delete local file when API says `missing`), parse Codex stdout token lines, POST `/usage`, and display ChatGPT quota bars (`chatgpt_usage`) plus runner state.
  - Honor `quota_hard_fail` + `quota_limit_percent` from `/auth`. VIP hosts always see `quota_hard_fail=false` so they keep launching but warn when usage meets the configured percent; non-VIP hosts stop once the threshold is hit when hard-fail mode is enabled.
  - Purge `~/.codex/auth.json` after each run when the host is insecure/baked as insecure.
  - `--update` forces wrapper download; `--uninstall` cleans Codex artifacts and calls `DELETE /auth`; `--execute` runs a one-off Codex command with sandbox defaults; `shell`/`code` subcommands coerce GPT-5.1 Codex models.
- `migrate-sqlite-to-mysql.php` exists for legacy migrations: copies SQLite into MySQL, truncates when `--force`, and skips orphaned rows.

## Extension Playbook

- Respect existing patterns; new endpoints go into `public/index.php`, but business logic lives in services/repos.
- Keep migrations + repositories in sync whenever adding columns or tables.
- Document any API/request/CLI change in `docs/OVERVIEW.md` plus the relevant interface doc(s). Add or update tests in `tests/` for new behavior.
- For cdx changes, edit `bin/cdx.d/`, rebuild with `scripts/build-cdx.sh`, bump `WRAPPER_VERSION`, and rebuild Docker images so `storage/wrapper/cdx` seeds correctly.
- Behavioral changes that affect hosts/operators need matching dashboard adjustments (HTML/JS under `public/admin/`) and, when user-visible, a `CHANGELOG.md` entry.
