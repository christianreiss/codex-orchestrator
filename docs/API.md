# Codex Auth Central API

Base URL: `https://codex-auth.example.com` (all examples omit the host). Responses are JSON unless noted; request bodies are `application/json`.

## Auth & Transport
- **Host auth**: supply the per-host API key via `X-API-Key` or `Authorization: Bearer <key>`.
- **Admin TLS**: `/admin/*` requires mTLS while `ADMIN_ACCESS_MODE=mtls` (default). With `ADMIN_ACCESS_MODE=none`, secure the path via VPN/firewall.
- **IP binding**: the first successful authenticated host request pins caller IP (`ip4`/`ip6`); later mismatches return `403` unless roaming is enabled (`allow_roaming_ips`), a dual-stack secondary bind is possible, or `DELETE /auth?force=1` is used. When reverse-DNS enforcement is active, `/auth` also requires forward A/AAAA + PTR match for caller IP. Forwarded headers are trusted only when `TRUST_X_FORWARDED=1` and `REMOTE_ADDR` matches `TRUSTED_PROXY_CIDRS`. Runner subnet bypass is possible when `AUTH_RUNNER_IP_BYPASS=1` and caller IP matches `AUTH_RUNNER_BYPASS_SUBNETS`.
- **Host security modes**: hosts default to `secure=true`. Setting `secure=false` marks the host insecure. New insecure hosts get a provisioning window (default 30 minutes, or `/admin/hosts/register` `duration_minutes`). Admins can open/extend a 0–480 minute sliding window with `POST /admin/hosts/{id}/insecure/enable` (default stored window 10). Window checks are enforced for `/auth` retrieve (non-`store`), `/host/lane`, and `/mcp`; `POST /auth` with `command=store` is currently not gated by the insecure window in code. Closed-window requests return `403 Insecure host API access disabled`, or `423 Insecure host approval pending` when insecure approvals are enabled and admin websocket presence is active.
- **Base URL policy**: in production, keep `PUBLIC_BASE_URL` set (`PUBLIC_BASE_URL_REQUIRED=1`) and optionally enforce host matching with `STRICT_HOST_VALIDATION=1`.
- **Kill switch**: `POST /admin/api/state` sets persistent `api_disabled`. When enabled, every non-`/admin/api/state` route returns HTTP 503.
- **Rate limits** (non-admin paths only):
  - Global bucket: `RATE_LIMIT_GLOBAL_PER_MINUTE` (default 120) over `RATE_LIMIT_GLOBAL_WINDOW` seconds (default 60). Exceeding returns `429` with `{bucket:"global", reset_at, limit}`.
  - Auth-fail bucket: missing/invalid API keys count toward `RATE_LIMIT_AUTH_FAIL_COUNT` (default 20) over `RATE_LIMIT_AUTH_FAIL_WINDOW` (default 600); tripping the bucket blocks for `RATE_LIMIT_AUTH_FAIL_BLOCK` (default 1800) and returns `429 Too many failed authentication attempts`.
- **Pruning**: hosts inactive for `inactivity_window_days` (default 30; `0` disables; max 60), never-provisioned hosts older than 30 minutes, or hosts with `expires_at` in the past are deleted during auth/register/admin-host flows (logs `host.pruned`). Temporary host `expires_at` is refreshed on successful authenticated contact (2-hour idle window).

## Host Endpoints

### `POST /auth`
Unified retrieve/store. Auth required; IP binding enforced.

**Body**
- `command`: `retrieve` (default) or `store`.
- `client_version` / `wrapper_version`: optional strings (also accepted from query params `client_version`/`cdx_version`/`wrapper_version`).
- `retrieve` requires `digest` (64-hex; accepts `digest`|`auth_digest`|`auth_sha`) and `last_refresh` (RFC3339, `>=2000-01-01`, `<=now+300s`).
- `store` requires `auth` (or top-level auth object) with `last_refresh` and `auths`. If `auths` is missing/empty but `tokens.access_token` or `OPENAI_API_KEY` exists, server synthesizes `auths = {"api.openai.com": {token, token_type:"bearer"}}`.
- Store update candidates are runner-validated before persistence; non-OK/unreachable runner rejects the update. Admin `/admin/auth/upload` and `/seed/auth/{uuid}` skip runner.
- If runner is not configured, update-candidate `store` requests fail (`503 Auth runner required`).
- `installation_id` is optional; when present it must match server `INSTALLATION_ID` or request is rejected with HTTP 403 (`Installation ID mismatch`).
- Tokens are rejected when too short (`TOKEN_MIN_LENGTH`, default 24 with minimum floor 8), containing whitespace, placeholder values, or low entropy.

**Statuses**
- Retrieve: `valid`, `upload_required`, `outdated`, `missing`.
- Store: `updated`, `unchanged`, `outdated`.

**Response fields (varies by status)**
- `auth` (when server copy is newer or after store), `canonical_last_refresh`, `canonical_digest`, plus `action:"store"` on retrieve paths that require upload.
- `host`: `fqdn`, `status`, `last_refresh`, `updated_at`, `expires_at`, `client_version`, `client_version_override`, `agents_document_id_override`, `wrapper_version`, `api_calls`, `allow_roaming_ips`, `secure`, `vip`, insecure window fields, `force_ipv4`, optional `lane_preference` (`normal|spark`), optional `model_override` / `reasoning_effort_override`.
- `api_calls`, `token_usage_month` (month-to-date totals including `cached`/`reasoning`/`cost`/`events`), `quota_hard_fail`, `quota_limit_percent`, `quota_week_partition`, `cdx_silent`.
- `versions`: `client_version` (+ source/checked timestamp), `wrapper_version`, `wrapper_sha256`, `wrapper_url`, `reported_client_version`, quota flags, runner flags/timestamps, and `installation_id`.
- `runner_applied` boolean plus optional `validation` when runner validation executed.
- `chatgpt_usage`: latest usage window summary when available (`normal_window`, optional `spark_window`, `active_quota_lane`; legacy `primary_window`/`secondary_window` also present).

### `DELETE /auth`
Deregisters the calling host; IP binding enforced unless `?force=1`. Logs `host.delete` and removes host + digests.

### `POST /usage`
Token-usage ingest. Body may be a single entry or `usages` array; each entry may include `line`, `total`, `input`, `output`, `cached`, `reasoning`, `model` (at least one numeric field or `line` required). Numbers accept commas/underscores/whitespace separators and must be non-negative. `line` is sanitized (ANSI/escape/control stripped, backslashes collapsed, non-ASCII removed, length capped). Each request writes `token_usage_ingests` (aggregates + normalized payload + optional client IP) and `token_usages` rows linked by `ingest_id`. Per-entry and aggregate `cost` use latest pricing (`PRICING_URL` or preferred `GPT54_*` + `PRICING_CURRENCY` fallback, with legacy `GPT51_*` still accepted when the new vars are unset). Response includes `recorded`, per-entry echoes, `host_id`, ingest `cost`, and `ingest_id`. Internal ingestion failures return HTTP 200 with `recorded:false`.

### `POST /host/users`
Records `username` and optional `hostname` for the calling host, returning known users with `first_seen`/`last_seen`. Auth + IP binding required.

### `GET /host/lane`
Returns lane metadata for the calling host. Auth + IP binding required; insecure-window checks apply. Response includes `lane_preference` (`normal|spark|null`) and `effective_lane`.

### `POST /host/lane`
Sets/clears host lane preference. Body: `{ "lane": "normal" | "spark" | null }` (`null` clears). Auth + IP binding required; insecure-window checks apply.

### Slash commands
- `GET /slash-commands` — list commands (`filename`, `sha256`, `description`, `argument_hint`, `updated_at`, optional `deleted_at`). Auth required.
- `POST /slash-commands/retrieve` — body: `filename` (required), optional `sha256`. Returns `status` `missing` | `unchanged` | `updated` (with `prompt` when updated).
- `POST /slash-commands/store` — body: `filename`, `prompt` (or `content`), optional `description`/`argument_hint`/`sha256`. Returns `status` `created` | `updated` | `unchanged` plus canonical `sha256`.
- `GET /skills` — list skills (`slug`, `sha256`, `display_name`, `description`, `updated_at`, optional `deleted_at`). Auth required. When the Projects module is enabled, the list also includes a managed `coco` skill that syncs to clients through the normal Skills path.
- `POST /skills/retrieve` — body: `slug` (or legacy `filename`) + optional `sha256`. Returns `status` `missing` | `deleted` | `unchanged` | `updated` (with `manifest` when updated).
- `POST /skills/store` — body: `slug`, `manifest` (or `content`; canonical `SKILL.md` markdown), optional `display_name`/`description`/`sha256`. Returns `status` `created` | `updated` | `unchanged` plus canonical `sha256`. The reserved slug `coco` is rejected while the Projects module is enabled.

### Agents
- `POST /agents/retrieve` — retrieve served AGENTS document. Optional `sha256` enables `status:unchanged` without content. Returns `status` (`updated` | `unchanged` | `missing`), `version_id`, `sha256`, `updated_at`, `size_bytes`, and `content` when updated.

### Config
- `POST /config/retrieve` — optional `sha256` (64-hex) plus optional `username`/`home` to append trusted project stanza (`[projects."<home>"] trust_level = "trusted"`) in baked config. Response: `status` (`updated` | `unchanged` | `missing`), baked `sha256`, `base_sha256`, `updated_at`, `size_bytes`, and `content` when updated. Host model overrides (`model_override`, `reasoning_effort_override`) are applied to baked `model` / `model_reasoning_effort`. The baked config also injects managed MCP server config pointing to `/mcp`; secure hosts get the host API key, insecure hosts get a short-lived MCP bearer. `status:missing` means client should delete local `~/.codex/config.toml`.

### Projects module
All `/projects*` routes require normal host API-key auth + IP binding and return HTTP `404 Project coordination disabled` while the module is off.
- `GET /projects` — list projects with summary fields (`slug`, `title`, `name`, `description`, `about`, `latest_seq`, `created_at`, `updated_at`).
- `POST /projects` — body: `slug` (required), optional `about` object, optional `roster_markdown` or `agents_markdown`. Returns the full project detail payload.
- `GET /projects/{slug}` — full project state: `project`, `notes`, `todos`, `files`, `feedback`, and `recent_changes`.
- `GET /projects/{slug}/bootstrap` — compact context payload with `about`, `roster_markdown`, `latest_seq`, `counts`, recent notes/todos/files/changes, and canonical project routes.
- `POST /projects/{slug}/about` — body `{ about: {...} }` (or a raw object) updates the project metadata block.
- `POST /projects/{slug}/roster` — body `{ roster_markdown }` or `{ markdown }` updates the shared roster/brief markdown.
- `GET /projects/{slug}/changes` — optional `since` query/body value; returns `{ project, since, latest_seq, changes[] }`.
- Notes: `GET /projects/{slug}/notes`, `POST /projects/{slug}/notes`, `POST /projects/{slug}/notes/{id}`, `DELETE /projects/{slug}/notes/{id}`. Create/update bodies require `header` and `body`.
- Todos: `GET /projects/{slug}/todos`, `POST /projects/{slug}/todos`, `POST /projects/{slug}/todos/{id}`, `POST /projects/{slug}/todos/{id}/done`, `POST /projects/{slug}/todos/{id}/undone`, `DELETE /projects/{slug}/todos/{id}`. Create/update bodies require `title`; todo payloads include `done` and `done_at`.
- Files: `GET /projects/{slug}/files`, `POST /projects/{slug}/files`, `DELETE /projects/{slug}/files/{id}`. Upsert bodies require `stored_name` (or `name`) and `content`; optional `description` and `mime_type`. Responses include `content`, `content_sha256`, `size_bytes`, and timestamps.
- Feedback: `GET /projects/{slug}/feedback`, `POST /projects/{slug}/feedback`. Create bodies require `type` (`bug|feature|note`), `title`, and `body`; new entries start with `status:"open"`.

### MCP memories
- `POST /mcp/memories/store` — body: `content` (or `text`) required (`<=32000` chars), optional `id`/`memory_id`/`key`, optional `metadata` object, optional `tags` (max 32, each `<=64` chars). Returns `status` `created` | `updated` | `unchanged` and `memory` payload.
- `POST /mcp/memories/retrieve` — body: `id`|`memory_id`|`key` (required). Returns `status:found|missing` and `memory` when found.
- `POST /mcp/memories/search` — body: `query`/`q` (empty lists recent), optional `limit` (`1..100`, default 20), optional `tags` (AND-match). Returns ranked `matches`.
- `POST /mcp/memories/delete` — body: `id`|`memory_id`|`key` (required). Returns `status:deleted|missing`.
- `DELETE /mcp/memories/{id}` — deletes by memory key (URL decoded); response matches `POST /mcp/memories/delete`.

### MCP stream endpoint
- `GET /mcp` — probe endpoint; returns 405 (`Allow: POST`).
- `POST /mcp` — JSON-RPC 2.0 endpoint (single or batch). Methods include `initialize`, `tools/list`, `tools/call`, `resources/templates/list`, `resources/list`, `resources/read`, `resources/create`, `resources/update`, `resources/delete`, and aliases (`tools.list`, `resources.list`, etc.).
- When the Projects module is enabled, `tools/list` also advertises `project_list`, `project_detail`, `project_bootstrap`, `project_changes`, `project_note_upsert`, `project_todo_create`, `project_todo_update`, `project_todo_done`, `project_todo_undone`, `project_file_upsert`, and `project_feedback_create`; resources add `project://{slug}` templates plus concrete project resources.
- Origin checks apply via `MCP_ALLOWED_ORIGINS` and `PUBLIC_BASE_URL`; optional request-host auto-allow is controlled by `MCP_ALLOW_REQUEST_HOST_ORIGIN` (default `0`). Disallowed origins return 403.

### Wrapper
- `GET /wrapper` — metadata for baked `cdx` wrapper for this host (`version`, per-host `sha256`, `size_bytes`, `updated_at`, `url`). Auth required.
- `GET /wrapper/download` — downloads baked wrapper; includes `X-SHA256` and `ETag` when available. Auth required.

## Provisioning & Installer
- `POST /admin/hosts/register` — create/rotate host. Body: `fqdn` (required), optional `secure` (default `true`), optional `vip` (default `false`), optional `temporary` (boolean; `true` enables sliding 2-hour idle expiry via `expires_at` refresh on authenticated contact), optional `curl_insecure` (boolean; bakes `CODEX_SYNC_ALLOW_INSECURE=1`), optional `reverse_dns_mode` (`global` | `enabled` | `disabled`), optional `duration_minutes` (`0..480`, used when `secure=false` for initial + stored insecure window). Returns host payload (with API key) and single-use installer token/command. If `duration_minutes` omitted for insecure hosts, initial window is 30 minutes with stored extension window 10 minutes. Base URL prefers `PUBLIC_BASE_URL`, else validated trusted forwarded host/proto; unresolved base URL returns 500.
- `GET /install/{token}` — public single-use installer (TTL `INSTALL_TOKEN_TTL_SECONDS`, default 1800). Marks token used before emit. Script downloads `/wrapper/download`, installs Codex CLI from GitHub releases, and falls back to version `0.63.0` when no cached client version exists. Errors return shell-script output with non-zero exit.

## Observability
- `GET /versions` — same versions block as `/auth` (`status:ok`, `data:{...}`) when API kill switch is off.
- `POST /admin/versions/check` — force fresh GitHub release lookup (bypass cache) and return `{available_client, versions}`.
- `POST /admin/codex-version` — set fleet Codex version policy. Body `{ selection: "latest" | "auto" | "<x.y.z>" }`.

## Admin Endpoints (mTLS)
- `GET /admin/overview` — host totals, refresh stats, `versions`, canonical-auth/seed status, token totals (`tokens_day`/`tokens_week`/`tokens_month`), pricing snapshot + cost totals, subscription plan pricing, ChatGPT usage snapshot/summary, quota flags, `cdx_silent`, `reverse_dns_enabled`, `insecure_approval_enabled`, `inactivity_window_days`, optional client-version lock metadata, and mTLS metadata.
- `GET /admin/ws/info` — websocket bootstrap (`enabled`, `url`, `last_event_id`, `heartbeat_seconds`, `backlog_limit`).
- Admin auth + users:
  - `GET /admin/auth/status` — auth status (`has_users`, `admin_count`, `enforced`, `authenticated`, `user`, `roles`).
  - `POST /admin/auth/login` — `{username, password}`; sets HTTP-only session cookie.
  - `POST /admin/auth/logout` — clears session.
  - `GET /admin/login` — admin login HTML.
  - `POST /admin/auth/password/request` — disabled (`410 Gone`).
  - `POST /admin/auth/password/reset` — disabled (`410 Gone`).
  - `GET /admin/users` — list admin users.
  - `POST /admin/users` — create admin user (first user must be admin).
  - `POST /admin/users/{id}` — update admin user.
  - `DELETE /admin/users/{id}` — delete admin user (blocked if last active admin).
  - `POST /admin/users/wipe` — wipe all admin users (requires confirmation `confirm:"WIPE"`).
- `POST /admin/toasts` — emit admin toast event (body: `message`, optional `title`, `level`, `timeout_ms`; aliases `body`/`text`, `tone`).
- `GET /admin/hosts` — list hosts with digest/history, versions, API calls, IPs, roaming flag, `secure`, `vip`, optional `expires_at`, insecure-window fields, `force_ipv4`, `curl_insecure`, overrides (`client_version_override`, `agents_document_id_override`, `lane_preference`, `model_override`, `reasoning_effort_override`, `reverse_dns_mode`), latest token usage, `auth_source`, and recorded users.
- `GET /admin/hosts/insecure` — insecure-host view with `{count, active, hosts[], domains[], domains_active}`.
- `GET /admin/hosts/{id}/auth` — canonical digest/last_refresh and recent digests; optional auth body via `?include_body=1`.
- `POST /admin/hosts/{id}/roaming` — toggle `allow_roaming_ips` (`allow` boolean).
- `POST /admin/hosts/{id}/secure` — toggle secure/insecure mode.
- `POST /admin/hosts/{id}/vip` — toggle VIP (VIP hosts always behave warn-only for quota hard-fail).
- `POST /admin/hosts/{id}/ipv4` — toggle IPv4-only wrapper behavior (`force` boolean; clears stored IPs).
- `POST /admin/hosts/{id}/curl-insecure` — toggle sync TLS verification bypass (`allow` boolean).
- `POST /admin/hosts/{id}/reverse-dns` — set per-host reverse DNS mode (`mode`: `global` | `enabled` | `disabled`).
- `POST /admin/hosts/{id}/model` — set per-host `model_override` / `reasoning_effort_override` (null/empty clears). Supported models: `gpt-5.4`, `gpt-5.3-codex`, `gpt-5.3-codex-spark`, `gpt-5.2-codex`, `gpt-5.2`, `gpt-5.1-codex-max`, `gpt-5.1-codex-mini`; effort must be valid for selected model.
- `POST /admin/hosts/{id}/codex-version` — set per-host Codex version override (`selection: "global"|"fleet"|"default"|"<x.y.z>"`).
- `POST /admin/hosts/{id}/agents-version` — set per-host AGENTS document override (`selection: "global"|"fleet"|"default"|<version_id>`).
- `POST /admin/hosts/{id}/insecure/enable` — insecure hosts only; opens/extends window. Optional `duration_minutes` (`0..480`); if omitted uses stored/default 10.
- `POST /admin/hosts/{id}/insecure/disable` — closes window immediately and clears grace.
- `POST /admin/hosts/insecure/extend` — for active insecure hosts, resets each active window to `now + insecure_window_minutes` (with grace recalculated).
- `POST /admin/hosts/insecure/disable-all` — closes all active insecure windows.
- `GET /admin/insecure-approval` / `POST /admin/insecure-approval` — read/set insecure approval gate (`enabled` boolean).
- `POST /admin/insecure-approvals/{id}/allow-domain` — approve pending request and add/update parent-domain auto-allow; optional `duration_minutes`.
- `POST /admin/insecure-approvals/{id}/approve` — approve pending request and open host window; optional `duration_minutes`.
- `POST /admin/insecure-approvals/{id}/deny` — deny pending request.
- `POST /admin/insecure-domain-allows/{id}/revoke` — revoke domain auto-allow.
- `POST /admin/hosts/{id}/clear` — clear host canonical auth linkage/digests.
- `DELETE /admin/hosts/{id}` — delete host + digests.
- `POST /admin/auth/upload` — admin upload/seed canonical `auth.json` (JSON body or `file`); optional `host_id`; runner skipped.
- `POST /admin/auth/seed-command` — issue one-time `curl -fsSL ... | bash` seed command for local `~/.codex/auth.json`; TTL `AUTH_SEED_TOKEN_TTL_SECONDS` (default 900).
- `GET /seed/auth/{uuid}` — serve seed shell script.
- `POST /seed/auth/{uuid}` — accept raw auth payload (or `{ "auth": ... }`), validate/store canonical auth, consume token, runner skipped.
- `GET /admin/api/state` / `POST /admin/api/state` — read/set API kill switch.
- `GET /admin/quota-mode` / `POST /admin/quota-mode` — read/set `quota_hard_fail`, `limit_percent` (`50..100`), `week_partition` (`off|7|5`).
- `GET /admin/cdx-silent` / `POST /admin/cdx-silent` — read/set wrapper silent mode (`silent` boolean).
- `GET /admin/reverse-dns` / `POST /admin/reverse-dns` — read/set global reverse DNS enforcement (`enabled` boolean).
- `POST /admin/prune-policy` — set inactivity prune days `{inactivity_days:0..60}`.
- Runner: `GET /admin/runner` (config/telemetry/state/timestamps/counts/canonical metadata), `POST /admin/runner/run` (force runner validation).
- Logs/usage:
  - `GET /admin/logs?limit=50`
  - `GET /admin/mcp/logs?limit=200`
  - `GET /admin/usage?limit=50`
  - `GET /admin/usage/ingests?page=&per_page=&q=&sort=&direction=&host_id=` (adds current pricing `currency`)
  - `GET /admin/tokens?limit=50`
- Cost history: `GET /admin/usage/cost-history?days=60[&from=&until=&interval=day|week&group_by=component|total&include_tokens=1|0]` (up to 180 days).
- ChatGPT usage:
  - `GET /admin/chatgpt/usage[?force=1]`
  - `GET /admin/chatgpt/usage/history?days=60[&from=&until=&interval=raw|hour|day&lane=normal|spark|both&window=primary|secondary|both]`
  - `POST /admin/chatgpt/usage/refresh`
- Slash commands: `GET /admin/slash-commands`, `GET /admin/slash-commands/{filename}`, `POST /admin/slash-commands/store`, `DELETE /admin/slash-commands/{filename}`.
- Skills: `GET /admin/skills`, `GET /admin/skills/{slug}`, `POST /admin/skills/store`, `DELETE /admin/skills/{slug}`. When the Projects module is enabled, the list includes the managed `coco` skill and direct store/delete attempts against that slug are rejected.
- Projects module: `GET /admin/projects/state`, `POST /admin/projects/state`, `GET /admin/projects/feedback`, `GET /admin/projects`, `POST /admin/projects`, `GET /admin/projects/{slug}`, `POST /admin/projects/{slug}/about`, `POST /admin/projects/{slug}/roster`, `GET /admin/projects/{slug}/changes`, note/todo/file/feedback subroutes mirroring the host `/projects` surface.
- Agents: `GET /admin/agents`, `POST /admin/agents/store`, `POST /admin/agents/serve`, `DELETE /admin/agents/versions/{id}`.
- MCP memories: `GET /admin/mcp/memories`, `DELETE /admin/mcp/memories/{id}` (numeric record id).
- Config builder: `GET /admin/config`, `POST /admin/config/render`, `POST /admin/config/store`.

## Runner & Versions
- Scheduled preflight runs on first non-admin request after interval (`AUTH_RUNNER_PREFLIGHT_SECONDS`, default 28800), excluding `/versions` and `/mcp`: refreshes cached GitHub client version and runs runner validation when configured.
- Runner state is recorded in `runner_state` (`ok|fail`) with timestamps (`runner_last_ok`, `runner_last_fail`, `runner_last_check`).
- Runner failures do not block `/auth` retrieve. Store update candidates are blocked when runner is unavailable/non-OK. Manual `POST /admin/runner/run` bypasses interval guard.
- Runner endpoint auth is available via `AUTH_RUNNER_SHARED_SECRET` (API) + `RUNNER_SHARED_SECRET` (runner), using header `X-Runner-Auth`.

## Housekeeping & Storage
- Canonical auth payloads live in `auth_payloads`, per-target entries in `auth_entries`; recent host digests in `host_auth_digests` (retained 3 per host); `host_auth_states` tracks last payload served to a host.
- Auth/register/runner/usage events are logged in `logs`. Token usage rows include total/input/output/cached/reasoning/model/cost; `/usage` also writes audit rows in `token_usage_ingests` linked by `ingest_id`.
