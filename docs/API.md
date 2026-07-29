# Codex Auth Central API

Base URL: `https://codex-auth.example.com` (all examples omit the host). Responses are JSON unless noted; request bodies are `application/json`.

## Auth & Transport
- **Host auth**: supply the per-host API key via `X-API-Key` or `Authorization: Bearer <key>`.
- **Admin auth**: `/admin/*` is gated by the admin session cookie (`requireAdmin` in `api/src/http/plugins/auth-admin.ts`). The API performs no client-certificate check of its own: `auth-mtls` only parses `X-MTLS-*` into `req.mtls`, and no route reads it.
  - **Client certificates** are a proxy-layer control. The optional `caddy` compose profile (`docker compose --profile caddy up`) answers `/admin*` requests without a validated client certificate with `403 Client certificate required for /admin` and injects the `X-MTLS-*` headers on the ones it forwards. A plain `docker compose up` does not start it, so without that profile (or an equivalent proxy) `/admin/*` is reachable with a session cookie alone — put it behind VPN/firewall.
  - `ADMIN_ACCESS_MODE` (`mtls` default, `cookie`, `open`) is read in exactly one place, `/cli/auth/verify`: any value except `open` makes that CLI device-approval page require an admin session. It does not gate `/admin/*` and does not require a certificate.
  - Admin passkey login exists and issues the same session cookie; nothing in the API layers it behind a certificate check.
- **IP binding**: the first successful authenticated host request pins caller IP (`ip4`/`ip6`); later mismatches return `403` unless roaming is enabled (`allow_roaming_ips`), a dual-stack secondary bind is possible, or `DELETE /auth?force=1` is used. When reverse-DNS enforcement is active, `/auth` also requires forward A/AAAA + PTR match for caller IP. Forwarded headers are trusted only when `TRUST_X_FORWARDED=1` and the socket peer address matches `TRUSTED_PROXY_CIDRS`. Runner subnet bypass is possible when `AUTH_RUNNER_IP_BYPASS=1` and caller IP matches `AUTH_RUNNER_BYPASS_SUBNETS`.
- **Host security modes**: hosts default to `secure=true`. Setting `secure=false` marks the host insecure. New insecure hosts get a provisioning window (default 30 minutes, or `/admin/hosts/register` `duration_minutes`). Admins can open/extend a 0–480 minute sliding window with `POST /admin/hosts/{id}/insecure/enable` (default stored window 10). Window checks are enforced for `/auth` retrieve (non-`store`), `/host/lane`, and `/mcp`; `POST /auth` with `command=store` is currently not gated by the insecure window in code. Closed-window requests return `403 Insecure host API access disabled`, or `423 Insecure host approval pending` when insecure approvals are enabled and admin websocket presence is active.
- **Base URL policy**: in production, keep `PUBLIC_BASE_URL` set (`PUBLIC_BASE_URL_REQUIRED=1`) and optionally enforce host matching with `STRICT_HOST_VALIDATION=1`.
- **Kill switch**: `POST /admin/api/state` sets persistent `api_disabled`. When enabled, every non-`/admin/api/state` route returns HTTP 503.
- **Rate limits**:
  - Global bucket: `RATE_LIMIT_GLOBAL_PER_MINUTE` (default 120) over `RATE_LIMIT_GLOBAL_WINDOW` seconds (default 60). Applies to every non-OPTIONS request, `/admin/*` included; only `/healthz`, `/admin/ws`, `/admin/_app/`, `/admin/manual/articles/` and `/admin/favicon` bypass it. Exceeding returns `429` with `{bucket:"global", reset_at, limit}`.
  - Auth-fail bucket: missing/invalid API keys count toward `RATE_LIMIT_AUTH_FAIL_COUNT` (default 20) over `RATE_LIMIT_AUTH_FAIL_WINDOW` (default 600); once the count is exceeded further failures return `429 Too many failed authentication attempts` until that window expires.
- **Pruning**: hosts inactive for `inactivity_window_days` (default 30; `0` disables; max 60), never-provisioned hosts older than 30 minutes, or hosts with `expires_at` in the past are deleted during auth/register/admin-host flows (logs `host.pruned`). Temporary host `expires_at` is refreshed on successful authenticated contact (2-hour idle window).

## Host Endpoints

### OpenAI-compatible API
- `POST /v1/chat/completions` — OpenAI-compatible chat completion route. Requires `Authorization: Bearer <openai-api-key-record>` and `messages[]`. `messages[].content` may be a plain string or an OpenAI-style content-part array with text parts plus `image_url` / `input_image` parts. Non-streaming returns a `chat.completion` object; streaming emits `chat.completion.chunk` SSE frames with `choices[].delta.content` plus a final `[DONE]`, which is what the official OpenAI SDKs expect. `model` must be one of the supported Codex model ids returned by `/v1/models`; when omitted, the API uses the saved main config model and falls back to `versions.cdx_model`.
- `POST /v1/responses` — minimal non-streaming Responses API compatibility adapter. Accepts `input` as a string, a bare content-part array, or a message-style array plus optional `instructions`, reuses the backend chat flow, and returns a `response` object with assistant text under `output[0].content[0].text`. Text parts plus `image_url` / `input_image` parts are supported, including `data:` URLs. `stream:true` is currently rejected with `400 unsupported_stream`. `model` follows the same validation and default-resolution rules as chat completions.
- `POST /v1/completions` — legacy text completion route. Accepts `prompt`, optional `model`, and optional `stream`. `model` follows the same validation and default-resolution rules as chat completions.
- `GET /v1/models` — list the supported Codex model ids from the shared config/model allowlist.
- `GET /v1/models/{model}` — retrieve one model object. Legacy aliases resolve to their current id; an empty or unknown id returns `404 model_not_found`.
- `POST /v1/embeddings` — currently returns `501 not_implemented` for the bundled backend.
- `OPTIONS /v1/*` — CORS preflight catch-all for every OpenAI-compatible route; answered before the kill switch and key resolution.

### Anthropic-compatible API

Base URL: `/anthropic/v1/`. All Anthropic endpoints use the Anthropic error envelope and CORS headers (`Access-Control-Allow-Headers` includes `x-api-key` and `anthropic-version`).

**Authentication**: `Authorization: Bearer sk-claude-...` or `x-api-key: sk-claude-...` header. Keys are managed via `/admin/claude/keys` endpoints and use the `sk-claude-` prefix.

**Rate limiting**: per-key RPM using the `anthropic:{key_id}` bucket (default 60 RPM, configurable per key). Exceeding the limit returns HTTP 429 with a `Retry-After: 60` header. Every `/anthropic/v1/*` response (success or error) also carries `anthropic-ratelimit-requests-limit` / `-remaining` / `-reset` so SDK backoff logic has something to read before hitting a hard 429, plus a `request-id: req_<hex>` header (distinct from this gateway's own general-purpose `x-request-id`) for diagnostics.

**Protocol requirements**: `anthropic-version` header is required on every request (one of `2023-06-01`, `2023-01-01`); missing or unrecognized values return 400 `invalid_anthropic_version`.

**Supported models**: `claude-fable-5`, `claude-opus-4-8`, `claude-sonnet-5` (default), `claude-opus-4-7`, `claude-sonnet-4-6`, `claude-haiku-4-5-20251001`. Legacy model names (e.g. `claude-3-opus-20240229`, `claude-sonnet-4-20250514`) are silently upgraded to current catalog equivalents.

#### `POST /anthropic/v1/messages`

Anthropic-compatible Messages API.

**Request body:**

| Parameter | Type | Required | Description |
|---|---|---|---|
| `messages` | array | yes | Array of `{role, content}` objects. `role` must be `user` or `assistant`, alternating (a `system`-role entry is hoisted into `system` instead — see below); an empty conversation, a non-`user`/`assistant` role, or two consecutive same-role messages return 400 (`empty_messages` / `invalid_message_role` / `invalid_message_role_sequence`). |
| `model` | string | no | Model id. Defaults to admin-configured default (`claude-sonnet-5`). |
| `system` | string \| array | no | System prompt. Accepts a plain string or an Anthropic block array (`[{type:"text", text:"..."}]`); block arrays are flattened by joining with a blank line. Per-block `cache_control` is accepted and ignored — this gateway has no prompt cache. |
| `max_tokens` | integer | **yes** | Maximum tokens to generate, matching upstream. Missing → 400 `missing_max_tokens`; present but not an integer ≥ 1 → 400 `invalid_max_tokens`. Validated but **not enforced**: the Claude Code CLI this backend shells out to has no output-length flag, so an accepted value is not forwarded or bounded. |
| `temperature` | float | no | Sampling temperature (0-1). |
| `top_p` | float | no | Nucleus sampling (0-1). |
| `top_k` | integer | no | Top-k sampling. |
| `stop_sequences` | string[] | no | Stop sequences. |
| `stream` | boolean | no | Enable SSE streaming. |
| `tools` / `tool_choice` | array / object | no | **Not supported.** A non-empty `tools` array returns 400 `tools_not_supported` rather than silently generating a text-only reply — see "Known deviations" below. |

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
  "model": "claude-sonnet-5",
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

#### `POST /anthropic/v1/messages/count_tokens`

Token count estimate for a prospective request. Takes the same `messages` / `system` / `tools` shape as `/messages` but does **not** require `max_tokens`.

**Response:**
```json
{"input_tokens": 42}
```

The runner has no access to the real Anthropic tokenizer (it shells out to the `claude` CLI, not a raw model endpoint), so this is a character-based estimate (~4 chars/token) plus a small per-message/per-tool overhead — it will not match the exact count the real API returns.

#### `POST /anthropic/v1/completions`

Legacy text completion endpoint. `POST /anthropic/v1/complete` is the upstream spelling of the same route and shares its handler.

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
  "model": "claude-sonnet-5",
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
  "model": "claude-sonnet-5",
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

List available Claude models, in the Anthropic Models API shape (`type` / `display_name` / `created_at` per entry, `has_more` / `first_id` / `last_id` on the envelope) so `client.models.list()` in the official SDKs parses it.

**Response:**
```json
{
  "data": [
    {"type": "model", "id": "claude-fable-5", "display_name": "Claude Fable 5", "created_at": "2026-01-01T00:00:00.000Z", "max_input_tokens": 1000000, "max_tokens": 128000, "object": "model", "created": 1234567890, "owned_by": "anthropic"},
    {"type": "model", "id": "claude-opus-4-8", "display_name": "Claude Opus 4.8", "created_at": "2026-01-01T00:00:00.000Z", "max_input_tokens": 1000000, "max_tokens": 128000, "object": "model", "created": 1234567890, "owned_by": "anthropic"}
  ],
  "has_more": false,
  "first_id": "claude-fable-5",
  "last_id": "claude-haiku-4-5-20251001",
  "object": "list"
}
```

Full catalog: `claude-fable-5`, `claude-opus-4-8`, `claude-sonnet-5`, `claude-opus-4-7`, `claude-sonnet-4-6`, `claude-haiku-4-5-20251001` (admin-disabled models are omitted).

`object` (envelope and per entry), `created`, and `owned_by` are **deprecated** OpenAI-shaped aliases retained for older clients of this gateway; they are not part of the Anthropic wire format. `created_at` is a fixed placeholder (`2026-01-01T00:00:00.000Z`) — this gateway does not track vendor release dates, but the value is stable across polls. The upstream `capabilities` tree is **not** served (it would have to be fabricated), so a client that indexes into `model.capabilities[...]` will fail.

#### `GET /anthropic/v1/models/{model_id}`

Retrieve one model. Returns a single model object in the shape shown above. Legacy ids (e.g. `claude-sonnet-4-5`) resolve to their current-generation replacement. Unknown or admin-disabled ids return `404 not_found_error` / `403 permission_error` respectively.

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

`error.type` is always one of the eight types Anthropic documents (`invalid_request_error`, `authentication_error`, `permission_error`, `not_found_error`, `request_too_large`, `rate_limit_error`, `api_error`, `overloaded_error`) — the Anthropic envelope maps anything else onto the type matching the HTTP status. `code` is a gateway-specific extra.

| Status | Error type | When |
|---|---|---|
| 400 | `invalid_request_error` | Missing/invalid parameters, `unsupported_stream`, `invalid_max_tokens`, `missing_max_tokens`, `invalid_anthropic_version`, `empty_messages`, `invalid_message_role`, `invalid_message_role_sequence`, `tools_not_supported` |
| 401 | `authentication_error` | Missing or invalid API key |
| 403 | `permission_error` | Model disabled by administrator (`model_disabled`) |
| 404 | `not_found_error` | Unknown model id (`model_not_found`), unmatched route |
| 429 | `rate_limit_error` | Rate limit exceeded (includes `Retry-After` header) |
| 501 | `invalid_request_error` | `/embeddings` (not an Anthropic capability) |
| 502 | `api_error` | Backend/runner communication failure |
| 503 | `api_error` | Backend not configured or API disabled by administrator |

**Known deviations from upstream** (the runner backend shells out to the `claude` CLI rather than calling a raw model endpoint, which is the root constraint behind these): tool-use is not supported — a request with a non-empty `tools` array is rejected up front with 400 `tools_not_supported` rather than silently generating a tool-less text reply; `/messages/count_tokens` returns a character-based estimate, not an exact tokenizer count; model objects omit the `capabilities` tree; error bodies carry no top-level `request_id` field (though the `request-id` response header is set); streaming emits the full response as a single `content_block_delta` (the runner has no token-by-token stream). `max_tokens` and `anthropic-version` are now enforced as upstream requires — no longer a deviation.

#### CORS Preflight

Registered as the single catch-all `OPTIONS /anthropic/v1/*`, so `OPTIONS /anthropic/v1/messages`, `OPTIONS /anthropic/v1/models`, `OPTIONS /anthropic/v1/completions`, `OPTIONS /anthropic/v1/responses` and `OPTIONS /anthropic/v1/embeddings` all return 204 with headers:
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
- `retrieve` accepts optional `digest` (64-hex; accepts `digest`|`auth_digest`|`auth_sha`) and `last_refresh`; supplied values are validated (`last_refresh` must be RFC3339, `>=2000-01-01`, `<=now+300s`). Omitting them is the supported missing/fresh-install probe used by current wrappers.
- `store` requires `auth` (or a top-level auth object) with `last_refresh` and
  one usable native engine credential; the API derives the corresponding
  `auths` entry. Codex follows the CLI's persisted selection rules: an explicit
  `auth_mode:"chatgpt"` uses `tokens.access_token`, an explicit
  `auth_mode:"apikey"` uses top-level `OPENAI_API_KEY`, and without
  `auth_mode` a non-null top-level API key wins over ChatGPT tokens.
  Unsupported persisted modes fail closed. Accepted Codex payloads are
  normalized to exactly one of those native shapes. Claude prefers a complete
  `claudeAiOauth` object over API-key aliases, then top-level aliases over
  nested token aliases and a legacy derived `auths` API key. An
  `sk-ant-oat...` bearer is valid only as `claudeAiOauth.accessToken`; placing
  one in an API-key or derived-only field is rejected. Accepted Claude
  payloads retain only the selected native credential and its matching derived
  bearer. For both engines, unrelated `auths` targets are discarded before
  runner verification and are not persisted in `auth_entries`. A previously
  verified row is returned only when its stored bytes exactly equal the current
  canonical projection and its fingerprint metadata is complete and valid;
  the background worker live-verifies and reissues older rows that fail that
  distribution check.
- Store candidates serialize per engine and are runner-validated before
  persistence, then compare-and-swapped against canonical again. Admin
  `/admin/auth/upload`, `/seed/auth/{uuid}`, and `/sync/bootstrap` inline
  `auth_candidate` use the same path. Every source requires a configured live
  runner and a positive verdict before becoming canonical. A runnable runner
  `updated_auth` may become canonical only when it retains the submitted
  credential kind and any existing OAuth refresh token; an unusable, older, or
  downgraded rotated payload fails closed instead of blessing the pre-refresh
  token. Transport/timeouts, provider 5xx,
  quota/model errors, and unrecognized CLI failures are non-definitive 503
  outcomes; recognized provider authentication rejection with unchanged
  credentials is definitive 422. If the runner changed credentials first, the
  replacement may be retained as quarantined `pending`/`failed` history and the
  API returns the wrapper-recognized unsafe-refresh 503 instead. Quarantine
  never advances the canonical head or supplies auth to hosts/gateways. If the
  native file changed before a non-OK upload verdict for the same selected
  credential lineage, the same transaction marks that exact head failed if it
  is still selected because its access/refresh token may already have been
  consumed. An unrelated login or a different concurrently selected head is
  not invalidated.
- An insecure host may submit `command:"store"` even when its retrieve window
  and grace period are closed. The request still passes API-key, engine, IP,
  reverse-DNS, installation, token-quality, and runner checks; it does not open
  or extend the retrieve window.
- If the runner is not configured, every new candidate is rejected with 503
  and canonical auth remains unchanged.
- `installation_id` is optional; when present it must match server `INSTALLATION_ID` or request is rejected with HTTP 403 (`Installation ID mismatch`).
- Tokens are rejected when too short (`TOKEN_MIN_LENGTH`, default 24 with minimum floor 8), containing whitespace, placeholder values, or low entropy.

**Statuses**
- Retrieve: `valid`, `upload_required`, `outdated`, `missing`.
- Store: `updated`, `valid`, `outdated`. Successful outcomes return only a
  verified authoritative payload/digest for guarded client writeback.

**Response fields (varies by status)**
- `auth` (only when the selected canonical payload is `verified`),
  `canonical_last_refresh`, `canonical_digest`, plus `action:"store"` on
  retrieve paths that require upload. Pending, unknown, and failed bytes are
  never returned. A failed explicit head returns `status:"outdated"` without
  `auth`; the server does not resurrect older history behind it.
- `host`: `fqdn`, `status`, `last_refresh`, `claude_last_refresh`, `updated_at`, `expires_at`, `client_version`, `client_version_override`, `claude_client_version`, `claude_client_version_override`, `agents_document_id_override`, `wrapper_version`, `claude_wrapper_version`, `api_calls`, `allow_roaming_ips`, `secure`, `vip`, insecure window fields, `engines`, `engines_list`, optional `lane_preference` (`normal|spark`), optional `model_override` / `reasoning_effort_override`, and optional `claude_model_override` / `claude_reasoning_effort_override`.
- `api_calls`, `quota_hard_fail`, `quota_limit_percent`, `quota_week_partition`, `cdx_silent`.
- `versions`: `client_version` (+ source/checked timestamp), `wrapper_version`, `wrapper_sha256`, `wrapper_url`, `reported_client_version`, quota flags, `auto_update_enabled`, runner flags/timestamps, and `installation_id`.
- `runner_applied` boolean plus optional `validation` when runner validation executed.
- `chatgpt_usage`: latest usage window summary when available (`normal_window`, optional `spark_window`, `active_quota_lane`; legacy `primary_window`/`secondary_window` also present).

`POST /sync/bootstrap` nests this response under `auth`. When an inline
`auth_candidate` is deterministically malformed/unusable or receives a
definitive provider-auth rejection, bootstrap returns
`auth.candidate_credential_rejected:true`; the wrapper must stop using that
exact local generation even if no server replacement exists. The separate
`auth.candidate_rejected_definitive:true` replacement authority is returned
only together with `status:"outdated"`, `verification_state:"verified"`, and a
canonical `auth` object. Transient runner/provider failures omit both signals
and preserve the local generation for retry.
If the selected canonical head is already failed, bootstrap may also return
`candidate_matches_failed_canonical:true|false`, computed from credential kind
plus access/refresh identity rather than incomparable native/envelope digests.
Only explicit `false` can prove a runnable local candidate is distinct enough
to launch while its upload retries.

### `DELETE /auth`

`?engine=codex|claude` removes only that engine from a dual-engine host,
including its auth state/digests, version/model overrides, and pending installer
tokens. Removing the last engine deletes the host. A legacy request without
`engine` keeps whole-host deregistration. IP binding is enforced unless
`?force=1`; both paths are transactional and audit logged.

### `POST /host/users`
Records `username` and optional `hostname` for the calling host, returning known users with `first_seen`/`last_seen`. Auth + IP binding required.

### `GET /host/lane`
Returns lane metadata for the calling host. Auth + IP binding required; insecure-window checks apply. Response includes `lane_preference` (`normal|spark|null`) and `effective_lane`.

### `POST /host/lane`
Sets/clears host lane preference. Body: `{ "lane": "normal" | "spark" | null }` (`null` clears). Auth + IP binding required; insecure-window checks apply.

### Sync & cron
- `POST /sync/status` — periodic check-in. Records `username`/`hostname`, returns `status` (`ok` | `update`), `reasons[]`, `versions`, `host_users`, and — unless `include_auth:false` — the `/auth` retrieve result under `auth`. Auth + IP binding required; insecure-window checks apply.
- `POST /cron/check` — auto-update probe for the host cron entry. Optional `engine`, `client_version`, `wrapper_version`. Returns `action` (`update` | `no_update` | `disable`), `target_version` / `tag` / `enforce_exact` when the CLI is behind, and a `wrapper` block (`action`, `target_version`, `sha256`, `url`) resolved for the caller's platform. Updates `last_cron_check`; the insecure window is neither enforced nor rolled here.
- `POST /cron/report` — host reports its installed versions. Requires `client_version` or `wrapper_version`; optional `engine`.

### Claude artifacts
`{kind}` is `subagent`, `command`, or `output-style` (plural and alias spellings are accepted). Auth required.
- `GET /claude/{kind}` — list served artifacts of that kind: `slug`, `sha256`, `display_name`, `description`, `model`, `updated_at`, `engine`.
- `POST /claude/{kind}/retrieve` — body: `slug` (or legacy `filename`) + optional `sha256` (64-hex). Returns `status` `missing` | `deleted` | `unchanged` | `updated`, plus the artifact body when updated.

### Shared memories
Fleet-wide durable corpus (`shared://{slug}`), deliberately not host-filtered: every host reads and writes the same documents, and `engine` is recorded as provenance only. Auth required.
- `GET /shared-memories` — recency listing; query `limit` (1–200, default 50), `offset`, `prefix`, `tags`, `include_content`. Response reports `scanned_all` when the bounded scan was exhausted.
- `POST /shared-memories/list` — same listing with the parameters in the body.
- `POST /shared-memories/search` — body: `query`/`q` (empty lists by recency), optional `limit` (1–50, default 10), `tags`, and `mode` (`chunks` default, or `documents`).
- `POST /shared-memories/read` — body: `slug` (aliases `id`/`key`) plus optional windowing (`max_chars`, default 32000; `offset`; `chunk` / `from_chunk` / `to_chunk`). Returns `status:missing` when the slug is absent or soft-deleted.
- `GET /shared-memories/{slug}` — same read with the slug in the path and the window in the query string.
- `POST /shared-memories/write` — replaces the body of `slug`. Requires `content` (or `text`); optional `title`, `summary`, `tags`, `metadata`, and `expected_sha256` for compare-and-swap (mismatch returns `409 shared_memory_conflict`). Labels the caller omits are carried over from the stored document.
- `POST /shared-memories/append` — row-locked read-modify-write so concurrent appends cannot lose text. Requires `content` (or `text`); optional `heading`, `separator` (default blank line), `tags`, `metadata`.
- `POST /shared-memories/delete` — soft-deletes `slug` (aliases `id`/`key`); returns `status` `deleted` | `missing`.
- `DELETE /shared-memories/{slug}` — same soft delete with the slug in the path.

- `GET /skills` — list skills (`slug`, canonical `uri` as `skill://{slug}`, `sha256`, `display_name`, `description`, `updated_at`, optional `deleted_at`). Auth required. When the Projects module is enabled, the list also includes a managed `coco` skill published through MCP.
- `POST /skills/retrieve` — body: `slug` (or legacy `filename`) + optional `sha256`. Returns `status` `missing` | `deleted` | `unchanged` | `updated`, canonical `uri`, and `manifest` when updated.
- `POST /skills/store` — body: `slug`, `manifest` (or `content`; canonical `SKILL.md` markdown), optional `display_name`/`description`/`sha256`. Returns `status` `created` | `updated` | `unchanged` plus canonical `sha256`. The reserved slug `coco` is rejected while the Projects module is enabled.

### Agents
- `POST /agents/retrieve` — retrieve served AGENTS document. Optional `sha256` enables `status:unchanged` without content. Returns `status` (`updated` | `unchanged` | `missing`), `version_id`, `sha256`, `updated_at`, `size_bytes`, and `content` when updated.

### Config
- `POST /config/retrieve` — optional `sha256` (64-hex) plus optional `username`/`home` to append trusted project stanza (`[projects."<home>"] trust_level = "trusted"`) in baked config. Response: `status` (`updated` | `unchanged` | `missing`), baked `sha256`, `base_sha256`, `updated_at`, `size_bytes`, and `content` when updated. Fleet defaults from `/admin/model-defaults/codex` are canonical `model` / `model_reasoning_effort`; host `model_override` / `reasoning_effort_override` values take precedence in the baked copy. The baked config also injects managed MCP server config pointing to `/mcp`; secure hosts get the host API key, insecure hosts get a short-lived MCP bearer that is re-baked on each retrieve so stale cached config cannot strand them with an expired MCP token. `status:missing` means cdx should delete the effective `${CODEX_HOME:-~/.codex}/config.toml`.

### Projects module
All `/projects*` routes require normal host API-key auth + IP binding and return HTTP `404 Project coordination disabled` while the module is off.
- `GET /projects` — list projects with summary fields (`slug`, `title`, `name`, `description`, `about`, `latest_seq`, `created_at`, `updated_at`).
- `POST /projects` — body: `slug` (required), optional `about` object, optional `roster_markdown` or `agents_markdown`. Returns the full project detail payload.
- `GET /projects/{slug}` — full project state: `project`, `notes`, `todos`, `files`, `feedback`, `memories`, and `recent_changes`.
- `GET /projects/{slug}/bootstrap` — compact context payload with `about`, `roster_markdown`, `latest_seq`, `counts`, recent notes/todos/files/memories/changes, native `instructions`, `quickstart`, managed `skill` metadata (`slug`, canonical `uri`), and canonical project routes. `recent_memories` is capped at 8 previews (no full content). The embedded guidance is explicitly project-only for CoCo shared handoffs, pointing durable shared memory at `project_memory_*` and noting `memory://...` stays host-scoped.
- `POST /projects/{slug}/about` — body `{ about: {...} }` (or a raw object) updates the project metadata block.
- `POST /projects/{slug}/roster` — body `{ roster_markdown }` or `{ markdown }` updates the shared roster/brief markdown.
- `GET /projects/{slug}/changes` — optional `since` query/body value; returns `{ project, since, latest_seq, changes[] }`.
- Notes: `GET /projects/{slug}/notes`, `POST /projects/{slug}/notes`, `POST /projects/{slug}/notes/{id}`, `DELETE /projects/{slug}/notes/{id}`. Create/update bodies require `header` and `body`.
- Todos: `GET /projects/{slug}/todos`, `POST /projects/{slug}/todos`, `POST /projects/{slug}/todos/{id}`, `POST /projects/{slug}/todos/{id}/done`, `POST /projects/{slug}/todos/{id}/undone`, `DELETE /projects/{slug}/todos/{id}`. Create/update bodies require `title`; todo payloads include `done` and `done_at`.
- Files: `GET /projects/{slug}/files`, `POST /projects/{slug}/files`, `DELETE /projects/{slug}/files/{id}`. Upsert bodies require `stored_name` (or `name`) and `content`; optional `description` and `mime_type`. Responses include `content`, `content_sha256`, `size_bytes`, and timestamps.
- Feedback: `GET /projects/{slug}/feedback`, `POST /projects/{slug}/feedback`. Create bodies require `type` (`bug|feature|note`), `title`, and `body`; new entries start with `status:"open"`.
- Memories: `GET /projects/{slug}/memories`, `POST /projects/{slug}/memories`, `POST /projects/{slug}/memories/search`, `GET /projects/{slug}/memories/{key}`, `DELETE /projects/{slug}/memories/{key}`. Durable, project-scoped, visible from every host — the cross-host counterpart to the host-scoped store below. Upsert bodies require `key` and `content`; optional `tags` and `metadata`. Status is `created` | `updated` | `unchanged`. Listings return previews unless `include_content=true`; search takes an optional `query` (omit it to list by recency).

### MCP memories
- MCP memories remain host-scoped scratch storage. They are not shared across hosts and are not a valid CoCo cross-server handoff substrate — use the project memories above when context must outlive a single host, or be discoverable by an agent that does not already know the key.
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
- Origin checks are a single toggle, not an allowlist: with `MCP_ALLOW_REQUEST_HOST_ORIGIN` off (default `0`), any request carrying an `Origin` header returns 403; turning it on drops the check entirely.

### Wrapper
- `GET /wrapper` — compatibility alias for `/wrapper/v2/meta`. It returns the requested engine's projection of the common `cxx` platform matrix (`version`, `sha256`, `size_bytes`, `updated_at`, `url`). Auth required.
- `GET /wrapper/download` — serves the host-targeted POSIX transition launcher used by date-versioned shell wrappers. It is not a raw binary download. Auth required.
- `GET /wrapper/v2/meta` — engine-scoped view of the common wrapper version, sha256, and active signing key id. Engine comes from `?engine=`.
- `GET /wrapper/v2/config` — signed per-host wrapper config JSON (`{payload, signature}`); `?sig=1` returns the detached signature as `text/plain`.
- `GET /wrapper/v2/download` — streams the binary built for the calling host's platform; `GET /wrapper/download` instead serves the transition script date-versioned shell wrappers update through.
- `GET /wrapper/v2/manifest/{engine}` — per-platform manifest for `codex` or `claude`; an unknown engine returns `404 unknown_engine`.
- `GET /wrapper/v2/bin/{engine}/{platform}/v:version/{binary}` — versioned binary route. The canonical common shape is `cxx/{platform}/v:version/cxx`; `{platform}` is `os-arch` (for example `linux-amd64`) and the version segment is a literal `v` followed by the version. Historical `{engine}/.../{cdx|clx}` shapes remain readable: exact old artifacts are immutable, while a new version without a split artifact transparently streams the matching `cxx` bytes.
- Platform is taken from `X-Wrapper-Platform: os-arch` when present, else inferred from the user agent (default `linux-amd64`). All wrapper routes require host auth, and every one of them returns `503 wrapper_v2_unavailable` while no active wrapper signing key is configured.

### CLI device auth
- `POST /cli/auth/start` — wrapper begins a device-code login. Body: `fqdn`, optional `secure` (default `true`). Returns the request id, user code, and `verify_url`. Exempt from the API kill switch; rate-limited per IP.
- `POST /cli/auth/poll/{id}` — wrapper polls the 64-hex request id until approved or denied; an approved response also carries `base_url`. Unknown ids return `404`.
- `POST /cli/auth/lookup` — admin session required; `{user_code}` resolves a pending request (`404` when unknown or expired).
- `POST /cli/auth/approve` — admin session required; `{user_code}` approves the request and registers the host.
- `POST /cli/auth/deny` — admin session required; `{user_code}` denies the request.

## Provisioning & Installer
- `POST /admin/hosts/register` — create/rotate host. Body: `fqdn` (required), optional `secure` (default `true`), optional `vip` (default `false`), optional `temporary` (boolean; `true` enables sliding 2-hour idle expiry via `expires_at` refresh on authenticated contact), optional `curl_insecure` (boolean; bakes `allow_insecure: true` into the signed wrapper config, returns a `curl -k` installer command, and makes the installer reuse `curl -k` for its own downloads), optional `reverse_dns_mode` (`global` | `enabled` | `disabled`), optional `duration_minutes` (`0..480`, used when `secure=false` for initial + stored insecure window), and optional `engines` (`codex`, `claude`, or both). Returns host payload (with API key) and single-use installer metadata: `token`, `url`, `command`, `mode`, `label`, `expires_at`. If `duration_minutes` omitted for insecure hosts, initial window is 30 minutes with stored extension window 10 minutes. Base URL prefers `PUBLIC_BASE_URL`, else validated trusted forwarded host/proto; unresolved base URL returns 500. Existing-host installer mints can also include `curl_insecure` so the returned command reflects the Host Detail toggle state atomically.
- `POST /admin/hosts/quick-register` — create an insecure temporary throwaway host with an auto-generated short `tmp-YYYYMMDD-HHMMSS-xxxxxx` name, `secure=false`, `temporary=true`, `vip=false`, and a 2-hour host expiry. Body requires `engines` (`codex`, `claude`, or both) and accepts optional `duration_minutes` (`0..480`) for the initial insecure window. Returns the same host + installer metadata shape as `/admin/hosts/register`.
- `GET /install/{token}` — public single-use installer (TTL fixed at 1800s in the API; no env knob). Marks the token used before emit. It fetches all enabled signed configs before installation and requires the Codex/Claude wrapper version and SHA to match, then downloads one `cxx` and atomically installs relative `cdx`/`clx` aliases for enabled engines. Claude-capable installs prepare Node.js/npm (OS Node package, pinned Corepack npm 10.9.2 when available, OS npm fallback). The installer invokes the host-wide `cxx cron install` and `cxx cron run --minimal` coordinator once each; `READY` is gated on the common wrapper, every requested CLI, and the one shared cron setup. Any missing/failed component yields `INCOMPLETE` and a non-zero exit. Fetch/token errors also return shell-script output with non-zero exit.
- `GET /install/v2/{token}` — alias of `GET /install/{token}`; wrappers minted against the v2 URL keep working unchanged.
- `GET /seed/v2/auth/{uuid}` / `POST /seed/v2/auth/{uuid}` — aliases of the `/seed/auth/{uuid}` pair below.

## Observability
- `GET /healthz` — unauthenticated liveness probe: `{ok:true, ts}`. One of the paths that bypasses the global rate-limit bucket.
- `GET /readyz` — unauthenticated readiness probe with the same `{ok:true, ts}` body.
- `GET /versions` — same versions block as `/auth` (`status:ok`, `data:{...}`) when API kill switch is off.
- `POST /admin/versions/check` — force fresh GitHub release lookup (bypass cache) and return `{available_client, versions}`.
- `POST /admin/codex-version` — set fleet Codex version policy. Body `{ selection: "latest" | "auto" | "<x.y.z>" }`.

## Admin Endpoints (admin session cookie)
- `GET /admin/overview` — host totals, refresh stats, `versions`, ChatGPT usage snapshot/summary, quota flags, `cdx_silent`, `reverse_dns_enabled`, `insecure_approval_enabled`, `inactivity_window_days`, and optional client-version lock metadata.
- `GET /admin/ws/info` — websocket bootstrap (`enabled`, `url`, `last_event_id`, `heartbeat_seconds`, `backlog_limit`).
- Admin auth + users:
  - `GET /admin/auth/status` — auth status (`has_users`, `admin_count`, `enforced`, `authenticated`, `user`, `roles`).
  - `POST /admin/auth/login/method` — `{username}`; returns `{method:"passkey"|"password"}` for known active users.
  - `POST /admin/auth/login` — `{username, password}`; sets HTTP-only session cookie. Passkey-enabled users are rejected and must use WebAuthn instead.
  - `POST /admin/auth/logout` — clears session.
  - `POST /admin/auth/passkey/login/options` — `{username}`; returns passkey login options for that user.
  - `POST /admin/auth/passkey/login` — completes passkey login and sets the admin session cookie.
  - `POST /admin/auth/passkey/register/options` / `POST /admin/auth/passkey/register` — register a passkey for the authenticated admin user.
  - `GET /admin/login` — admin login HTML. Not an API route: the built admin SPA is mounted at `/admin/` and its HTML fallback answers browser navigations, so a request that prefers `application/json` gets `404 Route not found`.
  - `POST /admin/auth/password/change` — change the authenticated admin user's own password with `{current_password, new_password, confirm_password}`.
  - `POST /admin/auth/password/request` — request a one-hour reset link by username or email; response does not disclose whether an account matched.
  - `POST /admin/auth/password/reset` — consume a reset token with `{token, new_password, confirm_password}`.
  - `GET /admin/passkeys` / `POST /admin/passkeys/{id}/name` / `DELETE /admin/passkeys/{id}` — list, rename, and delete the authenticated admin user’s passkeys.
  - `GET /admin/users` — list admin users.
  - `POST /admin/users` — create admin user (first user must be admin).
  - `POST /admin/users/{id}` — update admin user.
  - `DELETE /admin/users/{id}` — delete admin user (blocked if last active admin).
  - `POST /admin/users/wipe` — wipe all admin users (requires confirmation `confirm:"WIPE"`).
- `POST /admin/toasts` — emit admin toast event (body: `message`, optional `title`, `level`, `timeout_ms`; aliases `body`/`text`, `tone`).
- `GET /admin/hosts` — list hosts with digest/history, versions, API calls, IPs, roaming flag, `secure`, `vip`, optional `expires_at`, insecure-window fields, `curl_insecure`, overrides (`client_version_override`, `claude_client_version_override`, `agents_document_id_override`, `lane_preference`, `model_override`, `reasoning_effort_override`, `claude_model_override`, `reverse_dns_mode`, `auto_update_override`), `auth_source`, recorded users, and derived auto-update status fields (`effective_auto_update_enabled`, `auto_update_state`, `auto_update_label`, `auto_update_emoji`, `auto_update_rank`, `auto_update_last_event_at`, `auto_update_target_version`).
- `GET /admin/hosts/insecure` — insecure-host view with `{count, active, hosts[], domains[], domains_active}`.
- `GET /admin/hosts/{id}/detail` — single-host detail card: the host row plus per-engine version summaries, available client versions, canonical auth metadata, and the global `auto_update_enabled` / `reverse_dns_enabled` / `inactivity_window_days` context. Unknown ids return `404 host_not_found`.
- `POST /admin/hosts/{id}/installer` — mint a fresh single-use installer for an existing host. Optional `engines` and `curl_insecure`; returns `{host, installer}` in the same shape as `/admin/hosts/register`.
- `POST /admin/hosts/{id}/engines` — set the host's enabled engines (`engines`, at least one of `codex` / `claude`).
- `POST /admin/hosts/{id}/release-ip-binding` — clear the pinned `ip4`/`ip6` so the next authenticated request re-pins.
- `POST /admin/hosts/{id}/scaling-exempt` — toggle `scaling_exempt` so the host is ignored by the scaling rules.
- `POST /admin/hosts/{id}/auto-update` — set the per-host auto-update override (`override`: `true` | `false` | `null` to follow the fleet setting).
- `POST /admin/hosts/{id}/browseros-mcp` — toggle the BrowserOS MCP server in the host's baked config (`browseros_mcp` boolean).
- `GET /admin/hosts/{id}/auth` — canonical digest/last_refresh and recent digests for the selected engine; optional auth body via `?include_body=1`. Engine can be supplied via body/query/header and defaults to `codex`; the response includes `engine` plus both Codex and Claude host-side fields.
- `POST /admin/hosts/{id}/roaming` — toggle `allow_roaming_ips` (`allow` boolean).
- `POST /admin/hosts/{id}/secure` — toggle secure/insecure mode.
- `POST /admin/hosts/{id}/vip` — toggle VIP (VIP hosts always behave warn-only for quota hard-fail).
- `POST /admin/hosts/{id}/curl-insecure` — toggle sync TLS verification bypass (`allow` boolean).
- `POST /admin/hosts/{id}/reverse-dns` — set per-host reverse DNS mode (`mode`: `global` | `enabled` | `disabled`).
- `POST /admin/hosts/{id}/model` — set per-host Codex `model_override` / `reasoning_effort_override` and Claude `claude_model_override` (null/empty clears). Codex supports `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`, `gpt-5.5`, `gpt-5.4`, `gpt-5.4-mini`, and `gpt-5.3-codex-spark`; effort must be valid for the selected model. Terra is the fleet default at `medium`; Sol/Terra support `low|medium|high|xhigh|max|ultra`, Luna stops at `max`, and GPT-5.5/GPT-5.4/GPT-5.4 mini/Spark support `low|medium|high|xhigh`. Stored retired Codex overrides are backfilled to Terra with the intentionally retained `high` migration effort.
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
- `POST /admin/auth/upload` — admin upload/seed canonical `auth.json` (JSON body or `file`); optional `host_id`; requires positive live runner validation.
- `POST /admin/auth/seed-command` — issue one-time `curl -fsSL ... | bash` seed command for `{engine:"codex"|"claude"}` (default Codex). Generated scripts read `~/.codex/auth.json` for Codex or `~/.claude/.credentials.json` for Claude, accept both API-key and Claude Code OAuth credential shapes, normalize plain credential files by adding `last_refresh` when missing, and print server validation errors on upload failure. TTL `AUTH_SEED_TOKEN_TTL_SECONDS` (default 900).
- `GET /seed/auth/{uuid}` — serve engine-specific seed shell script.
- `POST /seed/auth/{uuid}` — accept raw credential payload (or `{ "auth": ... }`), require positive live runner validation, store verified canonical auth for the token engine, and consume the token after a successful store. Malformed, definitively rejected, and ordinary transient failures release the reservation so the same unexpired token can be retried. Unsafe runner-refresh/readback failures keep the one-time token consumed because the submitted refresh token may already have rotated; any retained replacement remains quarantined.
- `GET /admin/api/state` / `POST /admin/api/state` — read/set API kill switch.
- `GET /admin/openai/state` / `POST /admin/openai/state` — read/set persisted `openai_api_disabled` flag (toggles OpenAI-compatible API independently).
- OpenAI-compatible API keys (Codex-scoped; Claude-scoped keys live under `/admin/claude/keys`):
  - `GET /admin/openai/keys` — list keys (`id`, `name`, `key_prefix`, `rate_limit_rpm`, `is_active`, `use_count`, `last_used_at`, `expires_at`, timestamps).
  - `POST /admin/openai/keys` — issue a key. Body: `{name, rate_limit_rpm? (default 60), expires_at?}`. Returns the full key once, alongside the record.
  - `POST /admin/openai/keys/{id}/toggle` — enable/disable a key (`active` boolean).
  - `DELETE /admin/openai/keys/{id}` — delete a key. Unknown ids return `404 not_found`.
- `GET /admin/model-defaults/{engine}` — read the `codex` or `claude` fleet CLI default. Returns `{status:"ok", engine, model, reasoning_effort, catalog:[{model, persistent_efforts, default_effort}]}`. It is read-only: when no engine config row exists it reports the catalog default without persisting it.
- `POST /admin/model-defaults/{engine}` — strict body `{model, reasoning_effort?: string|null}`. Omitted/null effort selects the model default; invalid engine/model/effort or extra fields return HTTP 422 `validation_failed`. Codex persists `model` / `model_reasoning_effort`; its model-specific effort sets/defaults match the per-host contract above. Claude persists `model` / `effortLevel`. Claude capabilities: Fable 5, Opus 4.8, and Sonnet 5 support persistent `low|medium|high|xhigh` (default `high`); Opus 4.7 supports the same set with default `xhigh`; Sonnet 4.6 supports `low|medium|high` (default `high`); Haiku 4.5 has no persistent effort (`null`). Claude Code documents `max` as session-only, so it is deliberately excluded from this fleet-persistent API.
- Claude admin endpoints:
  - `GET /admin/claude/keys` — list all Claude API keys (engine-filtered). Returns `{status, data: [{id, name, key_prefix, rate_limit_rpm, is_active, use_count, last_used_at, expires_at, engine, created_at, updated_at}]}`.
  - `POST /admin/claude/keys` — create a new Claude API key. Body: `{name, rate_limit_rpm? (default 60), expires_at?}`. Returns the full key (shown once) and the record. Keys use the `sk-claude-` prefix.
  - `POST /admin/claude/keys/{id}/toggle` — enable or disable a Claude API key. Body: `{active: bool}`.
  - `DELETE /admin/claude/keys/{id}` — revoke (delete) a Claude API key.
  - `GET /admin/claude/state` / `POST /admin/claude/state` — read/set persisted `claude_api_disabled` flag (toggles Anthropic-compatible API independently). Requires `settings` capability.
  - `GET /admin/claude/settings` — get the separate Anthropic-compatible API proxy defaults. Returns `{status, data: {default_model, max_tokens, disabled}}`; this does not control Claude Code's fleet `model` / `effortLevel`.
  - `GET /admin/claude/version` — Claude Code fleet version summary (same shape the Codex version card uses).
  - `POST /admin/claude/version` — set the fleet Claude Code version policy. Body `{ selection: "latest" | "auto" | "<x.y.z>" }`; `latest`/`auto` clear the lock and refresh from upstream.
  - `GET /admin/claude/config` — Claude `settings.json` builder state (stored sub-blocks plus the baked document).
  - `POST /admin/claude/config/render` — render `{settings}` to the baked `settings.json` without storing it.
  - `POST /admin/claude/config/store` — store `{settings}` (optional `sha256` for compare-and-swap) as the served Claude config.
  - `GET /admin/claude/{kind}` — list Claude artifacts of `kind` (`subagent` | `command` | `output-style`), deleted entries included.
  - `GET /admin/claude/{kind}/{slug}` — one artifact with its frontmatter and body.
  - `POST /admin/claude/{kind}/store` — create/update an artifact; the kind's required frontmatter keys (`name`/`description` for subagents, `description` for commands) are enforced.
  - `DELETE /admin/claude/{kind}/{slug}` — soft-delete an artifact so hosts retrieve `status:deleted`.
  - `POST /admin/claude/settings` — update the separate Anthropic-compatible API proxy defaults. Body: `{default_model?, max_tokens? (256-200000)}`. Requires `settings` capability. Supported models: `claude-fable-5`, `claude-opus-4-8`, `claude-sonnet-5` (default), `claude-opus-4-7`, `claude-sonnet-4-6`, `claude-haiku-4-5-20251001`.
- `GET /admin/quota-mode` / `POST /admin/quota-mode` — read/set `quota_hard_fail`, `limit_percent` (`50..100`), `week_partition` (`off|7|5`).
- `GET /admin/cdx-silent` / `POST /admin/cdx-silent` — read/set wrapper silent mode (`silent` boolean).
- `GET /admin/auto-update` / `POST /admin/auto-update` — read/set the fleet auto-update flag (`enabled` boolean); per-host overrides win over it.
- `GET /admin/theme` / `POST /admin/theme` — read/set the stored admin UI theme (`auto` default).
- `GET /admin/log-retention` / `POST /admin/log-retention` — read/set log pruning: `enabled` plus `days_logs` (default 90), `days_mcp` (90), `days_events` (30), `days_graph_stats` (180), each clamped to `1..365`.
- `GET /admin/scaling` / `POST /admin/scaling` — read the scaling status and store the scaling rules; invalid rules return `422 validation_failed` with per-rule errors. Hosts flagged `scaling_exempt` are excluded.
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
- Skills: `GET /admin/skills`, `GET /admin/skills/{slug}`, `POST /admin/skills/generate`, `POST /admin/skills/assist`, `POST /admin/skills/store`, `DELETE /admin/skills/{slug}`. `POST /admin/skills/assist` is the conversational variant of `generate`: body `{messages[], mode: "new"|"edit", skill?}` (an `edit` mode carries the current skill), and it returns `503 runner_unavailable` without a configured runner and canonical auth. `POST /admin/skills/generate` is an admin-only runner-backed draft helper that fills the skill editor but does not persist anything until `store` is called. When the Projects module is enabled, the list includes the managed `coco` skill and direct store/delete attempts against that slug are rejected.
- Projects module: `GET /admin/projects/state`, `POST /admin/projects/state`, `GET /admin/projects/feedback`, `GET /admin/projects`, `POST /admin/projects`, `DELETE /admin/projects/{slug}`, `GET /admin/projects/{slug}`, `POST /admin/projects/{slug}/about`, `POST /admin/projects/{slug}/roster`, `GET /admin/projects/{slug}/changes`, plus `POST /admin/projects/{slug}/assist` (runner-backed draft helper; `503 runner_unavailable` without a runner and canonical auth) and the note/todo/file/feedback subroutes mirroring the host `/projects` surface:
  - Notes: `GET /admin/projects/{slug}/notes`, `POST /admin/projects/{slug}/notes`, `POST /admin/projects/{slug}/notes/{id}`, `DELETE /admin/projects/{slug}/notes/{id}`.
  - Todos: `GET /admin/projects/{slug}/todos`, `POST /admin/projects/{slug}/todos`, `POST /admin/projects/{slug}/todos/{id}`, `POST /admin/projects/{slug}/todos/{id}/done`, `POST /admin/projects/{slug}/todos/{id}/undone`, `DELETE /admin/projects/{slug}/todos/{id}`.
  - Files: `GET /admin/projects/{slug}/files`, `POST /admin/projects/{slug}/files`, `DELETE /admin/projects/{slug}/files/{id}`.
  - Feedback: `GET /admin/projects/{slug}/feedback`, `POST /admin/projects/{slug}/feedback`.
- Agents: `GET /admin/agents`, `GET /admin/agents/versions/{id}`, `POST /admin/agents/store`, `POST /admin/agents/serve`, `POST /admin/agents/revert`, `POST /admin/agents/retention`, `DELETE /admin/agents/versions/{id}`. `revert` takes `{version_id, engine?}` and republishes that version; `retention` sets `{backup_limit}` (null clears the stored limit).
- MCP memories: `GET /admin/mcp/memories`, `DELETE /admin/mcp/memories/{id}` (numeric record id).
- Shared memories: `GET /admin/shared-memories` (recency listing; `q` switches to relevance search, plus `tags`, `prefix`, `limit`, `offset`), `GET /admin/shared-memories/{slug}`, `DELETE /admin/shared-memories/{slug}`. Fleet-wide, so there is no host filter.
- Memory lifecycle (`{scope}` is `host`, `project`, or `shared`; mutations require the owner or admin role and carry an `ETag`):
  - `GET /admin/memories/graph` — cross-scope memory graph.
  - `GET /admin/memories/audit` — memory audit trail.
  - `GET /admin/memories/{scope}/{recordId}` — one memory record.
  - `POST /admin/memories/{scope}` — create a record; responds `201`.
  - `POST /admin/memories/shared/{recordId}/append` — append to a shared memory; the body accepts `content` and nothing else.
  - `PATCH /admin/memories/{scope}/{recordId}` — update a record; `expected_etag` (or `If-Match`) guards the write.
  - `DELETE /admin/memories/{scope}/{recordId}` — delete a record; `expected_etag` may come from the body, query, or `If-Match`.
- Manual: `GET /admin/manual/manifest`, `GET /admin/manual/search?q=`, `GET /admin/manual/article/{slug}` — the admin UI's in-app manual (article set bundled under `STATIC_ROOT`). Unknown slugs return `404`.
- Config builder: `GET /admin/config`, `POST /admin/config/render`, `POST /admin/config/store`.

## Runner & Versions
- The auth-verification worker starts with the API and runs every `AUTH_RUNNER_VERIFY_WORKER_INTERVAL_SECONDS` (default 300s), refreshing stale Codex/Claude canonical auth according to `AUTH_RUNNER_VERIFY_TTL_SECONDS` (default 900s). It also bypasses that TTL when a nominally verified row is not safely distributable because its bytes need current canonical normalization or its fingerprint metadata needs reissue. Live probes update per-engine runner telemetry, so the admin runner card follows the background auth-readiness checks. Wrapper startup reads the stored verdict and does not run runner validation inline.
- Runner state is recorded in `runner_state` / `runner_state_claude` (`ok|fail`) with timestamps (`runner_last_ok`, `runner_last_fail`, `runner_last_check`, and Claude-suffixed equivalents).
- Runner failures do not block `/auth` retrieve. Failed worker/manual runner
  attempts still update runner last-check metadata. Store update candidates are
  blocked unless the runner produces a positive credential verdict. Only a
  recognized authentication rejection normally marks the current head failed.
  A probe that rotates credentials before definitively rejecting them retains
  the replacement as quarantined failed history; a successful probe that
  returns an unusable replacement, loses credential kind/refresh capability,
  or cannot persist the refresh fails the old lineage closed. In every case
  only a still-verified head is distributable.
  Manual `POST /admin/runner/run` and `POST /admin/runner/run-claude` bypass
  interval guards.
- Runner endpoint auth is available via `AUTH_RUNNER_SHARED_SECRET` (API) + `RUNNER_SHARED_SECRET` (runner), using header `X-Runner-Auth`.

## Housekeeping & Storage
- Canonical auth payloads live in `auth_payloads` and are engine-scoped (`codex` / `claude`), with exactly the selected engine-native target mirrored in `auth_entries`; recent host digests in `host_auth_digests` are retained per host per engine (3 each); `host_auth_states` tracks the last payload served to a host per engine.
- Auth/register/runner events are logged in `logs`.
