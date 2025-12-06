# Codex Auth Central API

Base URL: `https://codex-auth.example.com` (all examples omit the host). Responses are JSON unless noted; request bodies are `application/json`.

## Auth & Transport
- **Host auth**: supply the per-host API key via `X-API-Key` or `Authorization: Bearer <key>`. Admin endpoints also accept `X-Admin-Key`/Bearer when `DASHBOARD_ADMIN_KEY` is set.
- **Admin TLS**: `/admin/*` requires mTLS while `ADMIN_REQUIRE_MTLS=1` (default). With `ADMIN_REQUIRE_MTLS=0`, secure the path via VPN/firewall and/or `DASHBOARD_ADMIN_KEY`.
- **IP binding**: first successful `/auth` (or wrapper fetch) pins the caller IP; later calls from another IP return `403` unless `allow_roaming_ips` is enabled or `DELETE /auth?force=1` is used. Runner calls may bypass IP binding when `AUTH_RUNNER_IP_BYPASS=1` and the runner IP is inside `AUTH_RUNNER_BYPASS_SUBNETS`.
- **Host security modes**: hosts default to `secure=true`. Setting `secure=false` (via admin register/secure toggle) marks the host as “insecure”; `/auth` is allowed only while its **insecure window** is open. A new insecure host gets a 30‑minute provisioning window; admins can reopen a 2–60 minute sliding window (default 10, set via dashboard slider or `duration_minutes`) with `POST /admin/hosts/{id}/insecure/enable`. Disabling the window blocks `retrieve` immediately with `403 insecure_api_disabled` but starts a 60‑minute grace period during which `store` calls remain allowed so hosts can finish uploading changes.
- **Kill switch**: `POST /admin/api/state` sets a persistent `api_disabled` flag. When enabled, every non-`/admin/api/state` route (including `/auth`) returns HTTP 503.
- **Rate limits** (non-admin paths only):
  - Global bucket: `RATE_LIMIT_GLOBAL_PER_MINUTE` (default 120) over `RATE_LIMIT_GLOBAL_WINDOW` seconds (default 60). Exceeding returns `429` with `{bucket:"global", reset_at, limit}`.
  - Auth-fail bucket: missing/invalid API keys count toward `RATE_LIMIT_AUTH_FAIL_COUNT` (default 20) over `RATE_LIMIT_AUTH_FAIL_WINDOW` seconds (600); tripping the bucket blocks for `RATE_LIMIT_AUTH_FAIL_BLOCK` seconds (1800) and returns `429 Too many failed authentication attempts` with `reset_at` + `bucket`.
- **Pruning**: hosts inactive for `INACTIVITY_WINDOW_DAYS` (default 30; set to `0` to disable), or never-provisioned hosts older than 30 minutes, are deleted during auth/register/admin host listings (logs `host.pruned`).

## Host Endpoints

### `POST /auth`
Unified retrieve/store. Auth required; IP binding enforced; blocked when insecure window is closed.

**Body**
- `command`: `retrieve` (default) or `store`.
- `client_version` / `wrapper_version`: optional strings (also accepted as `client_version`/`cdx_version`/`wrapper_version` query params).
- `retrieve` requires `digest` (64‑hex; accepts `digest`|`auth_digest`|`auth_sha`) and `last_refresh` (RFC3339, ≥2000-01-01, ≤now+300s).
- `store` requires `auth` (or top-level fields) with `last_refresh` and `auths`. If `auths` is missing/empty but `tokens.access_token` or `OPENAI_API_KEY` exists, the server synthesizes `auths = {"api.openai.com": {token, token_type:"bearer"}}`.
- `installation_id` (optional): when present, must match the server’s `INSTALLATION_ID` (baked into new `cdx`); a mismatch returns `403 installation_mismatch`. Older clients without this field continue to work.
- Tokens are rejected if too short (default `TOKEN_MIN_LENGTH=24`), contain whitespace, placeholders, or low entropy.

**Statuses**
- Retrieve: `valid`, `upload_required` (client claims newer), `outdated` (server newer), `missing`.
- Store: `updated` (newer or different), `unchanged`, `outdated` (server newer; canonical returned).

**Response fields (varies by status)**
- `auth` (when server copy is newer or after store), `canonical_last_refresh`, `canonical_digest`.
- `host`: fqdn/status/versions/api_calls/allow_roaming_ips/secure/`vip`/insecure window timestamps/`insecure_window_minutes`.
- `api_calls`, `token_usage_month` (per-host month-to-date sums), `quota_hard_fail` flag, `quota_limit_percent`.
- `versions`: `client_version` (+source/checked_at), `wrapper_version`/`sha256`/`url`, `reported_client_version`, `quota_hard_fail`, `quota_limit_percent`, `runner_enabled`, `runner_state`, `runner_last_ok`, `runner_last_fail`, `runner_last_check`, `installation_id`.
- `runner_applied` boolean plus optional `validation` when the auth runner ran during `store`.
- `chatgpt_usage`: latest window summary if a snapshot exists (primary/secondary window percentages, limits, reset timing, status, plan_type, next_eligible_at).

### `DELETE /auth`
Deregisters the calling host; IP binding enforced unless `?force=1`. Logs `host.delete` and removes host + digests.

### `POST /usage`
Token-usage ingest. Body may be a single entry or `usages` array; each entry may include `line`, `total`, `input`, `output`, `cached`, `reasoning`, `model` (at least one numeric field or `line` required). Numbers accept commas; must be non-negative. `line` is sanitized (ANSI/control stripped, length capped). Every request is also captured in `token_usage_ingests` (aggregated totals, normalized payload, client IP) for audit; the per-row `token_usages.ingest_id` links entries back to that ingest. Per-entry and aggregate `cost` values are calculated from the latest pricing (env fallbacks `GPT51_*`/`PRICING_CURRENCY` when `PRICING_URL` is absent) and stored with the rows. Response echoes `recorded` count, per-entry echoes (including `cost`), `host_id`, ingest `cost`, and `ingest_id`. Internal failures return `recorded:false` with a reason but HTTP 200.

### `POST /host/users`
Records the current `username` and optional `hostname` for the calling host, returning all known users with `first_seen`/`last_seen`. Auth + IP binding required.

### Slash commands
- `GET /slash-commands` — list commands (`filename`, `sha256`, `description`, `argument_hint`, `updated_at`, optional `deleted_at`). Auth required.
- `POST /slash-commands/retrieve` — body: `filename` (required), optional `sha256`. Returns `status` `missing` | `deleted` | `unchanged` | `updated` (with `prompt` when updated).
- `POST /slash-commands/store` — body: `filename`, `prompt` (or `content`), optional `description`/`argument_hint`/`sha256`. Returns `status` `created` | `updated` | `unchanged` plus canonical `sha256`.

### MCP memories
- `POST /mcp/memories/store` — body: `content` (required, ≤32k chars), optional `id`/`memory_id`/`key` (slug/UUID; generated when missing), optional `metadata` (object), optional `tags` (array of up to 32 strings, each ≤64 chars). Returns `status` `created` | `updated` | `unchanged` and `memory` (`id`, `content`, `metadata`, `tags`, timestamps).
- `POST /mcp/memories/retrieve` — body: `id`|`memory_id`|`key` (required). Returns `status:found|missing` and `memory` when found.
- `POST /mcp/memories/search` — body: `query`/`q` (string; empty lists recent), optional `limit` (1–100, default 20), optional `tags` (must all match). Results include `matches` ordered by MySQL full-text score (when query provided) with `score` + `memory` payloads.

### Wrapper
- `GET /wrapper` — metadata for the baked `cdx` wrapper for this host (`version`, `sha256` per-host, `size_bytes`, `updated_at`, `url`). Auth required.
- `GET /wrapper/download` — downloads the baked wrapper; headers include `X-SHA256` and `ETag` with the per-host hash. Auth required.

## Provisioning & Installer
- `POST /admin/hosts/register` — create or rotate a host. Body: `fqdn` (required), optional `secure` (default `true`), optional `vip` (default `false`). Returns host payload (with API key) and a single-use installer token/command. For insecure hosts, opens a 30‑minute initial window for `/auth`. Base URL resolution now prefers `PUBLIC_BASE_URL`, otherwise uses `X-Forwarded-Host`/`Host` + `X-Forwarded-Proto` (validated); call fails with 500 if it cannot be resolved. Tokens older than TTL are pruned.
- `GET /install/{token}` — public, single-use installer (TTL `INSTALL_TOKEN_TTL_SECONDS`, default 1800). Marks token used before emitting. Script downloads `/wrapper/download` baked with API key/FQDN/base URL and installs Codex CLI from GitHub; falls back to version `0.63.0` when no cached client version. Errors return a short shell snippet and non-zero exit.

## Observability
- `GET /versions` — same versions block returned by `/auth`; useful for dashboards or health checks.
- `POST /admin/versions/check` — forces a fresh GitHub release lookup (bypassing 3h cache) and returns `{available_client, versions}`.

## Admin Endpoints (mTLS + optional admin key)
- `GET /admin/overview` — host count, avg refresh age, latest log time, `versions`, `has_canonical_auth`, `seed_required` reasons, `tokens` totals, `tokens_day` (UTC day), `tokens_week` (aligned to ChatGPT weekly limit window when available, otherwise last 7 days), `tokens_month` (month to date), GPT‑5.1 pricing snapshot, `pricing_day_cost`, `pricing_week_cost`, `pricing_month_cost`, ChatGPT usage snapshot (cached ≤5m), `quota_hard_fail`, `quota_limit_percent`, and mTLS metadata.
- `GET /admin/hosts` — list hosts with canonical digest, recent digests, versions, API calls, IP, roaming flag, `secure`, `vip`, insecure window fields (`insecure_enabled_until`, `insecure_grace_until`, `insecure_window_minutes`), latest token usage, and recorded users.
- `GET /admin/hosts/{id}/auth` — canonical digest/last_refresh and recent digests; optional `auth` body with `?include_body=1`.
- `POST /admin/hosts/{id}/roaming` — toggle `allow_roaming_ips` (`allow` boolean).
- `POST /admin/hosts/{id}/secure` — toggle secure vs insecure mode.
- `POST /admin/hosts/{id}/vip` — toggle VIP status; VIP hosts never hard-fail on quota (warn-only regardless of global policy).
- `POST /admin/hosts/{id}/insecure/enable` — insecure hosts only; opens/extends a sliding allow window. Optional JSON body `duration_minutes` (integer 2–60) controls the window length (defaults to the last stored value or 10). Each `/auth` call extends the window by the configured duration.
- `POST /admin/hosts/{id}/insecure/disable` — closes the window immediately and starts a 60‑minute grace period during which `/auth` `store` calls are still allowed (retrieves remain blocked).
- `POST /admin/hosts/{id}/clear` — clear canonical auth state (resets digest/last_refresh, deletes host→payload pointer, prunes digests).
- `DELETE /admin/hosts/{id}` — delete host + digests.
- `POST /admin/auth/upload` — admin upload/seed canonical `auth.json` (body JSON or `file`). `host_id` optional; omitted/`0`/`system` stores an unscoped payload. Skips runner.
- `GET /admin/api/state` / `POST /admin/api/state` — read/set `api_disabled` kill switch (only path left available when disabled).
- `GET /admin/quota-mode` / `POST /admin/quota-mode` — read/set `quota_hard_fail` and `limit_percent` (50–100). When false, clients warn once the configured percent is used but still launch Codex; when true, they stop once the limit is reached.
- Runner: `GET /admin/runner` (config/telemetry, last validations, counts, state, timeouts, boot id); `POST /admin/runner/run` forces a runner validation and applies returned `updated_auth` when newer.
- Logs/usage: `GET /admin/logs?limit=50`, `GET /admin/usage?limit=50`, `GET /admin/usage/ingests?limit=50` (includes aggregate `cost` + `currency`), `GET /admin/tokens?limit=50`.
- Cost history: `GET /admin/usage/cost-history?days=60` — daily input/output/cached cost totals (plus overall) for up to 180 days, using the latest pricing snapshot and anchored to the first recorded token usage when it is newer than the lookback window.
- ChatGPT usage: `GET /admin/chatgpt/usage[?force=1]` (latest snapshot with 5‑minute cooldown unless `force`), `GET /admin/chatgpt/usage/history?days=60` (up to 180 days), `POST /admin/chatgpt/usage/refresh` (force refresh).
- Slash commands: `GET /admin/slash-commands`, `GET /admin/slash-commands/{filename}`, `POST /admin/slash-commands/store`, `DELETE /admin/slash-commands/{filename}`.

## Runner & Versions
- First non-admin request after ~8 hours (or after a boot) triggers a **scheduled preflight** (interval configurable via `AUTH_RUNNER_PREFLIGHT_SECONDS`, default 28800s): refreshes the cached GitHub client version and runs a single auth-runner validation against canonical auth (when configured). Runner outcomes update `runner_state` (`ok`|`fail`) and timestamps; failures never block serving auth. Manual `POST /admin/runner/run` bypasses the guard. Runner can also revalidate when marked failing (backoff 60s/15m) and may update canonical auth when it returns `updated_auth`.

## Housekeeping & Storage
- Canonical auth payloads are stored compacted in `auth_payloads` with per-target rows in `auth_entries`; the last 3 digests per host live in `host_auth_digests`; `host_auth_states` records the last payload served to a host.
- Every auth/register/runner/usage event is logged in `logs`. Token usage rows record totals/input/output/cached/reasoning tokens and model name when provided; `/usage` also creates an audit row in `token_usage_ingests` with the normalized payload and aggregates linked via `ingest_id`.
