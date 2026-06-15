# Codex Auth Central API

Base URL: `https://codex-auth.example.com` (all examples omit the host). Responses are JSON unless noted; request bodies are `application/json`.

## Auth & Transport
- **Host auth**: supply the per-host API key via `X-API-Key` or `Authorization: Bearer <key>`.
- **Admin TLS**: `/admin/*` requires mTLS while `ADMIN_ACCESS_MODE=mtls` (default). With `ADMIN_ACCESS_MODE=none`, secure the path via VPN/firewall.
  - Admin passkey login exists, but in the default `mtls` mode it still sits behind the client-certificate boundary.
- **IP binding**: the first successful authenticated host request pins caller IP (`ip4`/`ip6`); later mismatches return `403` unless roaming is enabled (`allow_roaming_ips`), a dual-stack secondary bind is possible, or `DELETE /auth?force=1` is used. When reverse-DNS enforcement is active, `/auth` also requires forward A/AAAA + PTR match for caller IP. Forwarded headers are trusted only when `TRUST_X_FORWARDED=1` and `REMOTE_ADDR` matches `TRUSTED_PROXY_CIDRS`. Runner subnet bypass is possible when `AUTH_RUNNER_IP_BYPASS=1` and caller IP matches `AUTH_RUNNER_BYPASS_SUBNETS`.
- **Host security modes**: hosts default to `secure=true`. Setting `secure=false` marks the host insecure. New insecure hosts get a provisioning window (default 30 minutes, or `/admin/hosts/register` `duration_minutes`). Admins can open/extend a 0–480 minute sliding window with `POST /admin/hosts/{id}/insecure/enable` (default stored window 10). Window checks are enforced for `/auth` retrieve (non-`store`), `/host/lane`, and `/mcp`; `POST /auth` with `command=store` is currently not gated by the insecure window in code. Closed-window requests return `403 Insecure host API access disabled`, or `423 Insecure host approval pending` when insecure approvals are enabled and admin websocket presence is active.
- **Base URL policy**: in production, keep `PUBLIC_BASE_URL` set (`PUBLIC_BASE_URL_REQUIRED=1`) and optionally enforce host matching with `STRICT_HOST_VALIDATION=1`.
- **Kill switch**: `POST /admin/api/state` sets persistent `api_disabled`. When enabled, every non-`/admin/api/state` route returns HTTP 503.
- **Rate limits** (non-admin paths only):
  - Global bucket: `RATE_LIMIT_GLOBAL_PER_MINUTE` (default 120) over `RATE_LIMIT_GLOBAL_WINDOW` seconds (default 60). Exceeding returns `429` with `{bucket:"global", reset_at, limit}`.
  - Auth-fail bucket: missing/invalid API keys count toward `RATE_LIMIT_AUTH_FAIL_COUNT` (default 20) over `RATE_LIMIT_AUTH_FAIL_WINDOW` (default 600); tripping the bucket blocks for `RATE_LIMIT_AUTH_FAIL_BLOCK` (default 1800) and returns `429 Too many failed authentication attempts`.
- **Pruning**: hosts inactive for `inactivity_window_days` (default 30; `0` disables; max 60), never-provisioned hosts older than 30 minutes, or hosts with `expires_at` in the past are deleted during auth/register/admin-host flows (logs `host.pruned`). Temporary host `expires_at` is refreshed on successful authenticated contact (2-hour idle window).

## Host Endpoints

### OpenAI-compatible API
- `POST /v1/chat/completions` — OpenAI-compatible chat completion route. Requires `Authorization: Bearer <openai-api-key-record>` and `messages[]`. `messages[].content` may be a plain string or an OpenAI-style content-part array with text parts plus `image_url` / `input_image` parts. Non-streaming returns a `chat.completion` object; streaming emits `chat.completion.chunk` SSE frames with `choices[].delta.content` plus a final `[DONE]`, which is what the official OpenAI SDKs expect. `model` must be one of the supported Codex model ids returned by `/v1/models`; when omitted, the API uses the saved main config model and falls back to `versions.cdx_model`.
- `POST /v1/responses` — minimal non-streaming Responses API compatibility adapter. Accepts `input` as a string, a bare content-part array, or a message-style array plus optional `instructions`, reuses the backend chat flow, and returns a `response` object with assistant text under `output[0].content[0].text`. Text parts plus `image_url` / `input_image` parts are supported, including `data:` URLs. `stream:true` is currently rejected with `400 unsupported_stream`. `model` follows the same validation and default-resolution rules as chat completions.
- `POST /v1/completions` — legacy text completion route. Accepts `prompt`, optional `model`, and optional `stream`. `model` follows the same validation and default-resolution rules as chat completions.
- `GET /v1/models` — list the supported Codex model ids from the shared config/model allowlist.
- `POST /v1/embeddings` — currently returns `501 not_implemented` for the bundled backend.

### Anthropic-compatible API

Base URL: `/anthropic/v1/`. All Anthropic endpoints use the Anthropic error envelope and CORS headers (`Access-Control-Allow-Headers` includes `x-api-key` and `anthropic-version`).

**Authentication**: `Authorization: Bearer sk-claude-...` or `x-api-key: sk-claude-...` header. Keys are managed via `/admin/claude/keys` endpoints and use the `sk-claude-` prefix.

**Rate limiting**: per-key RPM using the `anthropic:{key_id}` bucket (default 60 RPM, configurable per key). Exceeding the limit returns HTTP 429 with a `Retry-After: 60` header.

**Supported models**: `claude-opus-4-7`, `claude-sonnet-4-6` (default), `claude-haiku-4-5-20251001`. Legacy model names (e.g. `claude-3-opus-20240229`, `claude-sonnet-4-20250514`) are silently upgraded to the current equivalents.

#### `POST /anthropic/v1/messages`

Anthropic-compatible Messages API.

**Request body:**

| Parameter | Type | Required | Description |
|---|---|---|---|
| `messages` | array | yes | Array of `{role, content}` objects. Roles: `user`, `assistant`, `system`. |
| `model` | string | no | Model id. Defaults to admin-configured default (`claude-sonnet-4-6`). |
| `max_tokens` | integer | no | Maximum tokens to generate. |
| `temperature` | float | no | Sampling temperature (0-1). |
| `top_p` | float | no | Nucleus sampling (0-1). |
| `top_k` | integer | no | Top-k sampling. |
| `stop_sequences` | string[] | no | Stop sequences. |
| `stream` | boolean | no | Enable SSE streaming. |

`messages[].content` may be a plain string or an array of content blocks:
- `{type: "text", text: "..."}` for text
- `{type: "image", source: {type: "base64", media_type: "image/png", data: "..."}}` for base64 images
- `{type: "image", source: {type: "url", url: "https://..."}}` for URL images

OpenAI-format image parts (`image_url`, `input_image`) are automatically converted to Anthropic `image` blocks. System messages in the `messages` array are extracted and concatenated into a single system prompt per Anthropic convention.

**Response (non-streaming):**
```json
{
  "id": "msg_<hex>",
  "type": "message",
  "role": "assistant",
  "content": [{"type": "text", "text": "..."}],
  "model": "claude-sonnet-4-6",
  "stop_reason": "end_turn",
  "stop_sequence": null,
  "usage": {
    "input_tokens": 25,
    "output_tokens": 100,
    "cache_creation_input_tokens": 0,
    "cache_read_input_tokens": 0
  }
}
```

**Response (streaming):** SSE with `Content-Type: text/event-stream`. Events are emitted in this sequence:

| Event | Description |
|---|---|
| `message_start` | Opening message envelope with `id`, `model`, `role`, initial `usage`. |
| `content_block_start` | Signals start of content block (index 0, type `text`). |
| `content_block_delta` | Text delta: `{type: "text_delta", text: "..."}`. |
| `content_block_stop` | Signals end of content block. |
| `message_delta` | Final `stop_reason` (`end_turn`) and output token count. |
| `message_stop` | Terminal event. |

Currently the full response is emitted in a single `content_block_delta` (not incremental from the runner).

#### `POST /anthropic/v1/completions`

Legacy text completion endpoint.

**Request body:**

| Parameter | Type | Required | Description |
|---|---|---|---|
| `prompt` | string | yes | The prompt text. |
| `model` | string | no | Model id. |

**Response:**
```json
{
  "id": "msg_<hex>",
  "type": "completion",
  "completion": "...",
  "model": "claude-sonnet-4-6",
  "stop_reason": "end_turn",
  "usage": {"input_tokens": 10, "output_tokens": 50}
}
```

#### `POST /anthropic/v1/responses`

Responses API compatibility adapter (non-streaming only).

**Request body:**

| Parameter | Type | Required | Description |
|---|---|---|---|
| `input` | string/array | yes | Plain string, content-part array, or message-style array. |
| `instructions` | string | no | Injected as a system message. |
| `model` | string | no | Model id. |
| `stream` | boolean | no | Must be `false` or omitted. `true` returns 400 `unsupported_stream`. |

**Response:**
```json
{
  "id": "resp_<hex>",
  "object": "response",
  "created_at": 1234567890,
  "status": "completed",
  "model": "claude-sonnet-4-6",
  "output": [{
    "id": "msg_<hex>",
    "type": "message",
    "status": "completed",
    "role": "assistant",
    "content": [{"type": "output_text", "text": "...", "annotations": [], "logprobs": []}]
  }],
  "usage": {"input_tokens": 10, "output_tokens": 50, "output_tokens_details": {"reasoning_tokens": 0}, "total_tokens": 60}
}
```

#### `GET /anthropic/v1/models`

List available Claude models.

**Response:**
```json
{
  "object": "list",
  "data": [
    {"id": "claude-opus-4-7", "object": "model", "created": 1234567890, "owned_by": "anthropic"},
    {"id": "claude-sonnet-4-6", "object": "model", "created": 1234567890, "owned_by": "anthropic"},
    {"id": "claude-haiku-4-5-20251001", "object": "model", "created": 1234567890, "owned_by": "anthropic"}
  ]
}
```

#### `POST /anthropic/v1/embeddings`

Placeholder. Anthropic does not support embeddings. Returns HTTP 501:
```json
{
  "type": "error",
  "error": {"type": "not_implemented", "message": "Embeddings are not supported by the Anthropic backend", "code": "not_implemented"}
}
```

#### Anthropic Error Format

All Anthropic endpoint errors use this envelope (distinct from the OpenAI `{"error":{...}}` format):
```json
{
  "type": "error",
  "error": {
    "type": "invalid_request_error",
    "message": "Missing required parameter: messages",
    "code": "optional_error_code"
  }
}
```

| Status | Error type | When |
|---|---|---|
| 400 | `invalid_request_error` | Missing/invalid parameters, `unsupported_stream` |
| 401 | `authentication_error` | Missing or invalid API key |
| 429 | `rate_limit_error` | Rate limit exceeded (includes `Retry-After` header) |
| 502 | `api_error` | Backend/runner communication failure |
| 503 | `api_error` | Backend not configured or API disabled by administrator |

#### CORS Preflight

`OPTIONS /anthropic/v1/messages`, `OPTIONS /anthropic/v1/models`, `OPTIONS /anthropic/v1/completions`, `OPTIONS /anthropic/v1/responses`, `OPTIONS /anthropic/v1/embeddings` -- returns 204 with headers:
```
Access-Control-Allow-Origin: *
Access-Control-Allow-Headers: Content-Type, Authorization, x-api-key, anthropic-version
Access-Control-Allow-Methods: GET, POST, OPTIONS
```

### `POST /auth`
Unified retrieve/store. Auth required; IP binding enforced.

**Body**
- `command`: `retrieve` (default) or `store`.
- `engine`: optional `codex` or `claude`. May also be supplied via query `?engine=...` or `X-Engine`; wrapper user-agent fallback (`clx`) also selects Claude. Default is `codex`.
- `client_version` / `wrapper_version`: optional strings (also accepted from query params `client_version`/`cdx_version`/`wrapper_version`).
- `retrieve` requires `digest` (64-hex; accepts `digest`|`auth_digest`|`auth_sha`) and `last_refresh` (RFC3339, `>=2000-01-01`, `<=now+300s`).
- `store` requires `auth` (or top-level auth object) with `last_refresh` and `auths`. If `auths` is missing/empty, Codex synthesizes `auths = {"api.openai.com": {token, token_type:"bearer"}}` from `tokens.access_token` or `OPENAI_API_KEY`; Claude synthesizes `auths = {"api.anthropic.com": {token, token_type:"bearer"}}` from `api_key`, `anthropic_api_key`, `ANTHROPIC_API_KEY`, or Claude Code OAuth credentials at `claudeAiOauth.accessToken`.
- Store update candidates are runner-validated before persistence; non-OK/unreachable runner rejects the update. Admin `/admin/auth/upload`, `/seed/auth/{uuid}`, and `/sync/bootstrap` inline `auth_candidate` use the same runner-validation/update path, so runner `updated_auth` can become canonical there too. Runner `updated_auth` is applied only when valid, usable, and same/newer than the upload; otherwise the verified upload is stored with a skipped reason.
- If runner is not configured, update-candidate `store` requests fail (`503 Auth runner required`).
- `installation_id` is optional; when present it must match server `INSTALLATION_ID` or request is rejected with HTTP 403 (`Installation ID mismatch`).
- Tokens are rejected when too short (`TOKEN_MIN_LENGTH`, default 24 with minimum floor 8), containing whitespace, placeholder values, or low entropy.

**Statuses**
- Retrieve: `valid`, `upload_required`, `outdated`, `missing`.
- Store: `updated`, `unchanged`, `outdated`.

**Response fields (varies by status)**
- `auth` (when server copy is newer or after store), `canonical_last_refresh`, `canonical_digest`, plus `action:"store"` on retrieve paths that require upload.
- `host`: `fqdn`, `status`, `last_refresh`, `claude_last_refresh`, `updated_at`, `expires_at`, `client_version`, `client_version_override`, `claude_client_version`, `claude_client_version_override`, `agents_document_id_override`, `wrapper_version`, `claude_wrapper_version`, `api_calls`, `allow_roaming_ips`, `secure`, `vip`, insecure window fields, `engines`, `engines_list`, optional `lane_preference` (`normal|spark`), optional `model_override` / `reasoning_effort_override`, and optional `claude_model_override` / `claude_reasoning_effort_override`.
- `api_calls`, `quota_hard_fail`, `quota_limit_percent`, `quota_week_partition`, `cdx_silent`.
- `versions`: `client_version` (+ source/checked timestamp), `wrapper_version`, `wrapper_sha256`, `wrapper_url`, `reported_client_version`, quota flags, `auto_update_enabled`, runner flags/timestamps, and `installation_id`.
- `runner_applied` boolean plus optional `validation` when runner validation executed.
- `chatgpt_usage`: latest usage window summary when available (`normal_window`, optional `spark_window`, `active_quota_lane`; legacy `primary_window`/`secondary_window` also present).

### `DELETE /auth`
Deregisters the calling host; IP binding enforced unless `?force=1`. Logs `host.delete` and removes host + digests.

### `POST /host/users`
Records `username` and optional `hostname` for the calling host, returning known users with `first_seen`/`last_seen`. Auth + IP binding required.

### `GET /host/lane`
Returns lane metadata for the calling host. Auth + IP binding required; insecure-window checks apply. Response includes `lane_preference` (`normal|spark|null`) and `effective_lane`.

### `POST /host/lane`
Sets/clears host lane preference. Body: `{ "lane": "normal" | "spark" | null }` (`null` clears). Auth + IP binding required; insecure-window checks apply.

- `GET /skills` — list skills (`slug`, canonical `uri` as `skill://{slug}`, `sha256`, `display_name`, `description`, `updated_at`, optional `deleted_at`). Auth required. When the Projects module is enabled, the list also includes a managed `coco` skill published through MCP.
- `POST /skills/retrieve` — body: `slug` (or legacy `filename`) + optional `sha256`. Returns `status` `missing` | `deleted` | `unchanged` | `updated`, canonical `uri`, and `manifest` when updated.
- `POST /skills/store` — body: `slug`, `manifest` (or `content`; canonical `SKILL.md` markdown), optional `display_name`/`description`/`sha256`. Returns `status` `created` | `updated` | `unchanged` plus canonical `sha256`. The reserved slug `coco` is rejected while the Projects module is enabled.

### Agents
- `POST /agents/retrieve` — retrieve served AGENTS document. Optional `sha256` enables `status:unchanged` without content. Returns `status` (`updated` | `unchanged` | `missing`), `version_id`, `sha256`, `updated_at`, `size_bytes`, and `content` when updated.

### Config
- `POST /config/retrieve` — optional `sha256` (64-hex) plus optional `username`/`home` to append trusted project stanza (`[projects."<home>"] trust_level = "trusted"`) in baked config. Response: `status` (`updated` | `unchanged` | `missing`), baked `sha256`, `base_sha256`, `updated_at`, `size_bytes`, and `content` when updated. Host model overrides (`model_override`, `reasoning_effort_override`) are applied to baked `model` / `model_reasoning_effort`. The baked config also injects managed MCP server config pointing to `/mcp`; secure hosts get the host API key, insecure hosts get a short-lived MCP bearer that is re-baked on each retrieve so stale cached config cannot strand them with an expired MCP token. `status:missing` means client should delete local `~/.codex/config.toml`.

### Projects module
All `/projects*` routes require normal host API-key auth + IP binding and return HTTP `404 Project coordination disabled` while the module is off.
- `GET /projects` — list projects with summary fields (`slug`, `title`, `name`, `description`, `about`, `latest_seq`, `created_at`, `updated_at`).
- `POST /projects` — body: `slug` (required), optional `about` object, optional `roster_markdown` or `agents_markdown`. Returns the full project detail payload.
- `GET /projects/{slug}` — full project state: `project`, `notes`, `todos`, `files`, `feedback`, and `recent_changes`.
- `GET /projects/{slug}/bootstrap` — compact context payload with `about`, `roster_markdown`, `latest_seq`, `counts`, recent notes/todos/files/changes, native `instructions`, `quickstart`, managed `skill` metadata (`slug`, canonical `uri`), and canonical project routes. The embedded guidance is explicitly project-only for CoCo shared handoffs and warns against host-scoped `memory://...` fallbacks.
- `POST /projects/{slug}/about` — body `{ about: {...} }` (or a raw object) updates the project metadata block.
- `POST /projects/{slug}/roster` — body `{ roster_markdown }` or `{ markdown }` updates the shared roster/brief markdown.
- `GET /projects/{slug}/changes` — optional `since` query/body value; returns `{ project, since, latest_seq, changes[] }`.
- Notes: `GET /projects/{slug}/notes`, `POST /projects/{slug}/notes`, `POST /projects/{slug}/notes/{id}`, `DELETE /projects/{slug}/notes/{id}`. Create/update bodies require `header` and `body`.
- Todos: `GET /projects/{slug}/todos`, `POST /projects/{slug}/todos`, `POST /projects/{slug}/todos/{id}`, `POST /projects/{slug}/todos/{id}/done`, `POST /projects/{slug}/todos/{id}/undone`, `DELETE /projects/{slug}/todos/{id}`. Create/update bodies require `title`; todo payloads include `done` and `done_at`.
- Files: `GET /projects/{slug}/files`, `POST /projects/{slug}/files`, `DELETE /projects/{slug}/files/{id}`. Upsert bodies require `stored_name` (or `name`) and `content`; optional `description` and `mime_type`. Responses include `content`, `content_sha256`, `size_bytes`, and timestamps.
- Feedback: `GET /projects/{slug}/feedback`, `POST /projects/{slug}/feedback`. Create bodies require `type` (`bug|feature|note`), `title`, and `body`; new entries start with `status:"open"`.

### MCP memories
- MCP memories remain host-scoped scratch storage. They are not shared across hosts and are not a valid CoCo cross-server handoff substrate.
- `POST /mcp/memories/store` — body: `content` (or `text`) required (`<=32000` chars), optional `id`/`memory_id`/`key`, optional `metadata` object, optional `tags` (max 32, each `<=64` chars). Returns `status` `created` | `updated` | `unchanged` and `memory` payload. Keys matching `^coco(?:$|[._:-])` are reserved and rejected so CoCo shared handoffs must go through Projects.
- `POST /mcp/memories/retrieve` — body: `id`|`memory_id`|`key` (required). Returns `status:found|missing` and `memory` when found. Reserved `coco*` keys are rejected for the same reason.
- `POST /mcp/memories/search` — body: `query`/`q` (empty lists recent), optional `limit` (`1..100`, default 20), optional `tags` (AND-match). Returns ranked `matches`.
- `POST /mcp/memories/delete` — body: `id`|`memory_id`|`key` (required). Returns `status:deleted|missing`. Reserved `coco*` keys are rejected.
- `DELETE /mcp/memories/{id}` — deletes by memory key (URL decoded); response matches `POST /mcp/memories/delete`.

### MCP stream endpoint
- `GET /mcp` — probe endpoint; returns 405 (`Allow: POST`).
- `POST /mcp` — JSON-RPC 2.0 endpoint (single or batch). Methods include `initialize`, `tools/list`, `tools/call`, `resources/templates/list`, `resources/list`, `resources/read`, `resources/create`, `resources/update`, `resources/delete`, and aliases (`tools.list`, `resources.list`, etc.).
- MCP resources include host-scoped memories (`memory://{id}`), canonical Skill manifests (`skill://{slug}`), and, when the Projects module is enabled, shared project bootstrap resources (`project://{slug}`). Clients should use `skill://{slug}` as the Skill read path, and shared CoCo state still belongs only in project resources.
- Host-authenticated `/mcp` advertises only host-safe tools (`memory_*`, `resource_*`, and optional `project_*`). Coordinator filesystem helpers (`fs_*`) are not exposed on that route.
- When the Projects module is enabled, `tools/list` also advertises `project_list`, `project_create`, `project_detail`, `project_bootstrap`, `project_changes`, `project_note_upsert`, `project_todo_create`, `project_todo_update`, `project_todo_done`, `project_todo_undone`, `project_file_upsert`, and `project_feedback_create`; resources add `project://{slug}` templates plus concrete project resources, and the managed `coco` skill carries the human-readable toolkit/help text directly.
- Origin checks apply via `MCP_ALLOWED_ORIGINS` and `PUBLIC_BASE_URL`; optional request-host auto-allow is controlled by `MCP_ALLOW_REQUEST_HOST_ORIGIN` (default `0`). Disallowed origins return 403.

### Wrapper
- `GET /wrapper` — metadata for baked `cdx` wrapper for this host (`version`, per-host `sha256`, `size_bytes`, `updated_at`, `url`). Auth required.
- `GET /wrapper/download` — downloads baked wrapper; includes `X-SHA256` and `ETag` when available. Auth required.

## Provisioning & Installer
- `POST /admin/hosts/register` — create/rotate host. Body: `fqdn` (required), optional `secure` (default `true`), optional `vip` (default `false`), optional `temporary` (boolean; `true` enables sliding 2-hour idle expiry via `expires_at` refresh on authenticated contact), optional `curl_insecure` (boolean; bakes `CODEX_SYNC_ALLOW_INSECURE=1`), optional `reverse_dns_mode` (`global` | `enabled` | `disabled`), optional `duration_minutes` (`0..480`, used when `secure=false` for initial + stored insecure window), and optional `engines` (`codex`, `claude`, or both). Returns host payload (with API key) and single-use installer metadata: `token`, `url`, `command`, `mode`, `label`, `expires_at`. If `duration_minutes` omitted for insecure hosts, initial window is 30 minutes with stored extension window 10 minutes. Base URL prefers `PUBLIC_BASE_URL`, else validated trusted forwarded host/proto; unresolved base URL returns 500.
- `POST /admin/hosts/quick-register` — create an insecure temporary throwaway host with an auto-generated short `tmp-YYYYMMDD-HHMMSS-xxxxxx` name, `secure=false`, `temporary=true`, `vip=false`, and a 2-hour host expiry. Body requires `engines` (`codex`, `claude`, or both) and accepts optional `duration_minutes` (`0..480`) for the initial insecure window. Returns the same host + installer metadata shape as `/admin/hosts/register`.
- `GET /install/{token}` — public single-use installer (TTL `INSTALL_TOKEN_TTL_SECONDS`, default 1800). Marks token used before emit. The emitted script is token-mode aware: Codex hosts install `cdx` + Codex CLI, Claude hosts install `clx` + Claude Code, and dual-engine hosts install both. Codex installs still resolve the effective fleet version before downloading from GitHub releases. Errors return shell-script output with non-zero exit.

## Observability
- `GET /versions` — same versions block as `/auth` (`status:ok`, `data:{...}`) when API kill switch is off.
- `POST /admin/versions/check` — force fresh GitHub release lookup (bypass cache) and return `{available_client, versions}`.
- `POST /admin/codex-version` — set fleet Codex version policy. Body `{ selection: "latest" | "auto" | "<x.y.z>" }`.

## Admin Endpoints (mTLS)
- `GET /admin/overview` — host totals, refresh stats, `versions`, canonical-auth/seed status, token totals (`tokens_day`/`tokens_week`/`tokens_month`), ChatGPT usage snapshot/summary, quota flags, `cdx_silent`, `reverse_dns_enabled`, `insecure_approval_enabled`, `inactivity_window_days`, optional client-version lock metadata, and mTLS metadata.
- `GET /admin/ws/info` — websocket bootstrap (`enabled`, `url`, `last_event_id`, `heartbeat_seconds`, `backlog_limit`).
- Admin auth + users:
  - `GET /admin/auth/status` — auth status (`has_users`, `admin_count`, `enforced`, `authenticated`, `user`, `roles`).
  - `POST /admin/auth/login/method` — `{username}`; returns `{method:"passkey"|"password"}` for known active users.
  - `POST /admin/auth/login` — `{username, password}`; sets HTTP-only session cookie. Passkey-enabled users are rejected and must use WebAuthn instead.
  - `POST /admin/auth/logout` — clears session.
  - `POST /admin/auth/passkey/login/options` — `{username}`; returns passkey login options for that user.
  - `POST /admin/auth/passkey/login` — completes passkey login and sets the admin session cookie.
  - `POST /admin/auth/passkey/register/options` / `POST /admin/auth/passkey/register` — register a passkey for the authenticated admin user.
  - `GET /admin/login` — admin login HTML.
  - `POST /admin/auth/password/request` — disabled (`410 Gone`).
  - `POST /admin/auth/password/reset` — disabled (`410 Gone`).
  - `GET /admin/passkeys` / `POST /admin/passkeys/{id}/name` / `DELETE /admin/passkeys/{id}` — list, rename, and delete the authenticated admin user’s passkeys.
  - `GET /admin/users` — list admin users.
  - `POST /admin/users` — create admin user (first user must be admin).
  - `POST /admin/users/{id}` — update admin user.
  - `DELETE /admin/users/{id}` — delete admin user (blocked if last active admin).
  - `POST /admin/users/wipe` — wipe all admin users (requires confirmation `confirm:"WIPE"`).
- `POST /admin/toasts` — emit admin toast event (body: `message`, optional `title`, `level`, `timeout_ms`; aliases `body`/`text`, `tone`).
- `GET /admin/hosts` — list hosts with digest/history, versions, API calls, IPs, roaming flag, `secure`, `vip`, optional `expires_at`, insecure-window fields, `curl_insecure`, overrides (`client_version_override`, `claude_client_version_override`, `agents_document_id_override`, `lane_preference`, `model_override`, `reasoning_effort_override`, `claude_model_override`, `reverse_dns_mode`, `auto_update_override`), `auth_source`, recorded users, and derived auto-update status fields (`effective_auto_update_enabled`, `auto_update_state`, `auto_update_label`, `auto_update_emoji`, `auto_update_rank`, `auto_update_last_event_at`, `auto_update_target_version`).
- `GET /admin/hosts/insecure` — insecure-host view with `{count, active, hosts[], domains[], domains_active}`.
- `GET /admin/hosts/{id}/auth` — canonical digest/last_refresh and recent digests for the selected engine; optional auth body via `?include_body=1`. Engine can be supplied via body/query/header and defaults to `codex`; the response includes `engine` plus both Codex and Claude host-side fields.
- `POST /admin/hosts/{id}/roaming` — toggle `allow_roaming_ips` (`allow` boolean).
- `POST /admin/hosts/{id}/secure` — toggle secure/insecure mode.
- `POST /admin/hosts/{id}/vip` — toggle VIP (VIP hosts always behave warn-only for quota hard-fail).
- `POST /admin/hosts/{id}/curl-insecure` — toggle sync TLS verification bypass (`allow` boolean).
- `POST /admin/hosts/{id}/reverse-dns` — set per-host reverse DNS mode (`mode`: `global` | `enabled` | `disabled`).
- `POST /admin/hosts/{id}/model` — set per-host Codex `model_override` / `reasoning_effort_override` and Claude `claude_model_override` (null/empty clears). Codex supported models: `gpt-5.5`, `gpt-5.4`, `gpt-5.4-mini`, `gpt-5.3-codex-spark`; effort must be valid for the selected model. Claude supported models: `claude-opus-4-7`, `claude-sonnet-4-6`, `claude-haiku-4-5-20251001`. Stored legacy Codex overrides on removed models are backfilled to `gpt-5.5` with `high` effort.
- `POST /admin/hosts/{id}/codex-version` — set per-host Codex version override (`selection: "global"|"fleet"|"default"|"<x.y.z>"`).
- `POST /admin/hosts/{id}/claude-version` — set per-host Claude Code version override (`selection: "global"|"fleet"|"default"|"<x.y.z>"`, or `claude_client_version_override`).
- `POST /admin/hosts/{id}/agents-version` — set per-host AGENTS document override (`selection: "global"|"fleet"|"default"|<version_id>`).
- `POST /admin/hosts/{id}/insecure/enable` — insecure hosts only; opens/extends window. Optional `duration_minutes` (`0..480`); if omitted uses stored/default 10.
- `POST /admin/hosts/{id}/insecure/disable` — closes window immediately and clears grace.
- `POST /admin/hosts/insecure/extend` — for active insecure hosts, resets each active window to `now + insecure_window_minutes` (with grace recalculated).
- `POST /admin/hosts/insecure/disable-all` — closes all active insecure windows.
- `GET /admin/insecure-approval` / `POST /admin/insecure-approval` — read/set insecure approval gate (`enabled` boolean).
- `GET /admin/insecure-approvals/pending` — list unresolved insecure approval requests for the admin queue. Returns `requests[]` with `id`, `host_id`, `fqdn`, `request_ip`, `requested_at`, `updated_at`, and `status`.
- `POST /admin/insecure-approvals/{id}/allow-domain` — approve pending request and add/update parent-domain auto-allow; optional `duration_minutes`.
- `POST /admin/insecure-approvals/{id}/approve` — approve pending request and open host window; optional `duration_minutes`.
- `POST /admin/insecure-approvals/{id}/deny` — deny pending request.
- `POST /admin/insecure-domain-allows/{id}/revoke` — revoke domain auto-allow.
- `POST /admin/hosts/{id}/clear` — clear host canonical auth linkage/digests for both Codex and Claude.
- `DELETE /admin/hosts/{id}` — delete host + digests.
- `POST /admin/auth/upload` — admin upload/seed canonical `auth.json` (JSON body or `file`); optional `host_id`; runner-validated when the runner is enabled.
- `POST /admin/auth/seed-command` — issue one-time `curl -fsSL ... | bash` seed command for `{engine:"codex"|"claude"}` (default Codex). Generated scripts read `~/.codex/auth.json` for Codex or `~/.claude/.credentials.json` for Claude, accept both API-key and Claude Code OAuth credential shapes, normalize plain credential files by adding `last_refresh` when missing, and print server validation errors on upload failure. TTL `AUTH_SEED_TOKEN_TTL_SECONDS` (default 900).
- `GET /seed/auth/{uuid}` — serve engine-specific seed shell script.
- `POST /seed/auth/{uuid}` — accept raw credential payload (or `{ "auth": ... }`), runner-validate/store canonical auth for the token engine when the runner is enabled, and consume the token after a successful store. Malformed JSON/object attempts are still consumed.
- `GET /admin/api/state` / `POST /admin/api/state` — read/set API kill switch.
- `GET /admin/openai/state` / `POST /admin/openai/state` — read/set persisted `openai_api_disabled` flag (toggles OpenAI-compatible API independently).
- Claude admin endpoints:
  - `GET /admin/claude/keys` — list all Claude API keys (engine-filtered). Returns `{status, data: [{id, name, key_prefix, rate_limit_rpm, is_active, use_count, last_used_at, expires_at, engine, created_at, updated_at}]}`.
  - `POST /admin/claude/keys` — create a new Claude API key. Body: `{name, rate_limit_rpm? (default 60), expires_at?}`. Returns the full key (shown once) and the record. Keys use the `sk-claude-` prefix.
  - `POST /admin/claude/keys/{id}/toggle` — enable or disable a Claude API key. Body: `{active: bool}`.
  - `DELETE /admin/claude/keys/{id}` — revoke (delete) a Claude API key.
  - `GET /admin/claude/state` / `POST /admin/claude/state` — read/set persisted `claude_api_disabled` flag (toggles Anthropic-compatible API independently). Requires `settings` capability.
  - `GET /admin/claude/settings` — get Claude fleet settings. Returns `{status, data: {default_model, max_tokens, disabled}}`.
  - `POST /admin/claude/settings` — update Claude fleet settings. Body: `{default_model?, max_tokens? (256-200000)}`. Requires `settings` capability. Supported models: `claude-opus-4-7`, `claude-sonnet-4-6` (default), `claude-haiku-4-5-20251001`.
- `GET /admin/quota-mode` / `POST /admin/quota-mode` — read/set `quota_hard_fail`, `limit_percent` (`50..100`), `week_partition` (`off|7|5`).
- `GET /admin/cdx-silent` / `POST /admin/cdx-silent` — read/set wrapper silent mode (`silent` boolean).
- `GET /admin/reverse-dns` / `POST /admin/reverse-dns` — read/set global reverse DNS enforcement (`enabled` boolean).
- `POST /admin/prune-policy` — set inactivity prune days `{inactivity_days:0..60}`.
- Runner: `GET /admin/runner` (config/telemetry/state/timestamps/counts/canonical metadata), `POST /admin/runner/run` (force Codex runner validation), `POST /admin/runner/run-claude` (force Claude runner validation).
- Logs:
  - `GET /admin/logs?limit=50`
  - `GET /admin/mcp/logs?limit=200`
- ChatGPT usage:
  - `GET /admin/chatgpt/usage[?force=1]`
  - `GET /admin/chatgpt/usage/history?days=60[&from=&until=&interval=raw|hour|day&lane=normal|spark|both&window=primary|secondary|both]`
  - `POST /admin/chatgpt/usage/refresh`
- Skills: `GET /admin/skills`, `GET /admin/skills/{slug}`, `POST /admin/skills/generate`, `POST /admin/skills/store`, `DELETE /admin/skills/{slug}`. `POST /admin/skills/generate` is an admin-only runner-backed draft helper that fills the skill editor but does not persist anything until `store` is called. When the Projects module is enabled, the list includes the managed `coco` skill and direct store/delete attempts against that slug are rejected.
- Projects module: `GET /admin/projects/state`, `POST /admin/projects/state`, `GET /admin/projects/feedback`, `GET /admin/projects`, `POST /admin/projects`, `DELETE /admin/projects/{slug}`, `GET /admin/projects/{slug}`, `POST /admin/projects/{slug}/about`, `POST /admin/projects/{slug}/roster`, `GET /admin/projects/{slug}/changes`, note/todo/file/feedback subroutes mirroring the host `/projects` surface.
- Agents: `GET /admin/agents`, `POST /admin/agents/store`, `POST /admin/agents/serve`, `DELETE /admin/agents/versions/{id}`.
- MCP memories: `GET /admin/mcp/memories`, `DELETE /admin/mcp/memories/{id}` (numeric record id).
- Config builder: `GET /admin/config`, `POST /admin/config/render`, `POST /admin/config/store`.

## Runner & Versions
- Scheduled preflight runs on first non-admin request after interval (`AUTH_RUNNER_PREFLIGHT_SECONDS`, default 28800), excluding `/versions` and `/mcp`: refreshes cached GitHub client version and runs runner validation when configured.
- Runner state is recorded in `runner_state` / `runner_state_claude` (`ok|fail`) with timestamps (`runner_last_ok`, `runner_last_fail`, `runner_last_check`, and Claude-suffixed equivalents).
- Runner failures do not block `/auth` retrieve. Failed runner attempts still update runner last-check metadata, and background preflight/recovery probes use a short timeout so startup sync can fall back to cached auth promptly. Store update candidates are blocked when runner is unavailable/non-OK. Manual `POST /admin/runner/run` and `POST /admin/runner/run-claude` bypass interval guards.
- Runner endpoint auth is available via `AUTH_RUNNER_SHARED_SECRET` (API) + `RUNNER_SHARED_SECRET` (runner), using header `X-Runner-Auth`.

## Housekeeping & Storage
- Canonical auth payloads live in `auth_payloads` and are engine-scoped (`codex` / `claude`), with per-target entries in `auth_entries`; recent host digests in `host_auth_digests` are retained per host per engine (3 each); `host_auth_states` tracks the last payload served to a host per engine.
- Auth/register/runner events are logged in `logs`.
