# Codex Auth Central API

- `POST /sync/cache` — communicator cache protocol 2 (cxx 0.9.122+). Authenticates each selected read and confirms resource hashes from authoritative server state; only changed bytes are returned. Content uses a consistent DB snapshot. Auth admission, quota and RPC IDs remain live. Expired or unconfirmed RAM contents cannot authorize a new launch. See [the protocol contract](interface-api.md#communicator-cache-protocol-2-cxx-09122).

- `POST /host/agent-sessions/{id}/agent-messaging/digest` — bridge-authenticated original retrieval for a negotiated smart-queue digest. Body: `digest_id`, optional `after` dispatch cursor and `limit` (1–20). Returns `messages` and `next_after`; grouping is never a read receipt. See [Smart queue](smart-queue.md).

Base URL: `https://codex-auth.example.com` (all examples omit the host). Responses are JSON unless noted; request bodies are `application/json`.

## Auth & Transport
- **Host auth**: supply the per-host API key via `X-API-Key` or `Authorization: Bearer <key>`.
- **Admin auth**: `/admin/*` is gated by the admin session cookie (`requireAdmin` in `api/src/http/plugins/auth-admin.ts`). The API performs no client-certificate check of its own: `auth-mtls` only parses `X-MTLS-*` into `req.mtls`, and no route reads it.
  - **Client certificates** are not part of this system. The bundled `caddy` profile terminates TLS and reverse-proxies without requesting them. A proxy you run may terminate mTLS and forward `X-MTLS-*`; the API records those claims from peers inside `TRUSTED_PROXY_CIDRS` and ignores them otherwise, but no route reads them. `/admin/*` is reachable with a session cookie alone — put it behind VPN/firewall if that is not enough.
  - `ADMIN_ACCESS_MODE` (`cookie` default, or `open`) is read in exactly one place, `/cli/auth/verify`: any value except `open` makes that CLI device-approval page require an admin session. It does not gate `/admin/*`.
  - Admin passkey login exists and issues the same session cookie; nothing in the API layers it behind a certificate check.
- **IP binding**: the first successful authenticated host request pins caller IP (`ip4`/`ip6`); later mismatches return `403` unless roaming is enabled (`allow_roaming_ips`), a dual-stack secondary bind is possible, or `DELETE /auth?force=1` is used. When reverse-DNS enforcement is active, `/auth` also requires forward A/AAAA + PTR match for caller IP. Forwarded headers are trusted only when `TRUST_X_FORWARDED=1` and the socket peer address matches `TRUSTED_PROXY_CIDRS`. Runner subnet bypass is possible when `AUTH_RUNNER_IP_BYPASS=1` and caller IP matches `AUTH_RUNNER_BYPASS_SUBNETS`.
- **Host security modes**: hosts default to `secure=true`. Setting `secure=false` marks the host insecure. New insecure hosts get a provisioning window (default 30 minutes, or `/admin/hosts/register` `duration_minutes`). Admins can open/extend a 0–480 minute sliding window with `POST /admin/hosts/{id}/insecure/enable` (default stored window 10). Window checks are enforced for `/auth` retrieve (non-`store`), `/sync/status`, `/sync/bootstrap`, `/host/lane`, and `/mcp`; `POST /auth` with `command=store` is currently not gated by the insecure window in code. `/sync/bootstrap` and `/sync/status` are gated only when the request actually asks for credentials — `include_auth:false` (what the unattended wrapper cron tick sends) is served without a window check, without sliding the window, and without opening an approval, like every other content route. Closed-window requests return `403 Insecure host API access disabled`, or `423 Insecure host approval pending` when insecure approvals are enabled and admin websocket presence is active.
- **Base URL policy**: in production, keep `PUBLIC_BASE_URL` set (`PUBLIC_BASE_URL_REQUIRED=1`) and optionally enforce host matching with `STRICT_HOST_VALIDATION=1`.
- **Kill switch**: `POST /admin/api/state` sets persistent `api_disabled`. It is read by `POST /auth`, `POST /sync/status`, `POST /sync/bootstrap`, `POST /claude/usage/report` and `GET /versions`, which answer `503 api_disabled` while it is set; nothing else reads it. The OpenAI-, Anthropic-, and Grok-compatible lanes have their own flags (`openai_api_disabled` via `/admin/openai/state`, `claude_api_disabled` via `/admin/claude/state`, `grok_api_disabled` via `/admin/grok/state`), and the remaining host routes (`/mcp`, `/skills`, `/agents/retrieve`, `/config/retrieve`, cron, wrapper, projects, shared memories) and `/admin/*` keep serving.
- **Request rates**: the orchestrator has no in-process request-rate limiter. Authentication and authorization still apply normally; traffic shaping belongs at the deployment edge.
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

Every `/anthropic/v1/*` response carries a `request-id: req_<hex>` header (distinct from this gateway's own general-purpose `x-request-id`) for diagnostics. The gateway does not add request-rate-limit headers or enforce a per-key RPM budget.

**Protocol requirements**: `anthropic-version` header is required on every request (one of `2026-10-21`, `2023-06-01`, `2023-01-01`); missing or unrecognized values return 400 `invalid_anthropic_version`. `2026-10-21` is what `@anthropic-ai/sdk` 1.0.0 and later (and the other official SDK majors released with it) send by default. Under `2026-10-21`, `POST /anthropic/v1/messages` and `POST /anthropic/v1/messages/count_tokens` apply the upstream removals ([versioning](https://platform.claude.com/docs/en/api/versioning), [migration guide](https://platform.claude.com/docs/en/api/migration-2026-10-21), checked 2026-10-28) and return 400 `invalid_request_error` with code `unsupported_in_api_version` for: any `temperature`, `top_p` or `top_k` (even at the default value; a JSON `null` counts as sent); a `document` block placed directly in an `assistant` message; a `text` block with a non-empty `citations` array in a `user` message, directly or inside a `search_result` block. Assistant citations and an empty `citations` array stay accepted. These checks run at the surface before any backend work, so they hold for whichever engine backs `/anthropic/v1`. `2023-06-01` and `2023-01-01` keep the previous behaviour. The legacy `/complete`, `/completions` and `/responses` shims are not Messages API endpoints and accept `2026-10-21` without these body rules.

**Supported models**: `claude-fable-5-1`, `claude-fable-5`, `claude-opus-5-5`, `claude-opus-5`, `claude-opus-4-8`, `claude-sonnet-5-5`, `claude-sonnet-5` (default), `claude-opus-4-7`, `claude-sonnet-4-6`, `claude-haiku-4-5-20251001`. Legacy model names (e.g. `claude-3-opus-20240229`, `claude-sonnet-4-20250514`) are silently upgraded to current catalog equivalents.

#### `POST /anthropic/v1/messages`

Anthropic-compatible Messages API.

**Request body:**

| Parameter | Type | Required | Description |
|---|---|---|---|
| `messages` | array | yes | Array of `{role, content}` objects. `role` must be `user` or `assistant`, alternating (a `system`-role entry is hoisted into `system` instead — see below); an empty conversation, a non-`user`/`assistant` role, or two consecutive same-role messages return 400 (`empty_messages` / `invalid_message_role` / `invalid_message_role_sequence`). |
| `model` | string | no | Model id. Defaults to admin-configured default (`claude-sonnet-5`). |
| `system` | string \| array | no | System prompt. Accepts a plain string or an Anthropic block array (`[{type:"text", text:"..."}]`); block arrays are flattened by joining with a blank line. Per-block `cache_control` is accepted and ignored — this gateway has no prompt cache. |
| `max_tokens` | integer | **yes** | Maximum tokens to generate, matching upstream. Missing → 400 `missing_max_tokens`; present but not an integer ≥ 1 → 400 `invalid_max_tokens`. Validated but **not enforced**: the Claude Code CLI this backend shells out to has no output-length flag, so an accepted value is not forwarded or bounded. |
| `temperature` | float | no | Sampling temperature (0-1). `anthropic-version` `2023-06-01`/`2023-01-01` only; removed in `2026-10-21` (400 `unsupported_in_api_version`). |
| `top_p` | float | no | Nucleus sampling (0-1). Same version rule as `temperature`. |
| `top_k` | integer | no | Top-k sampling. Same version rule as `temperature`. |
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
    {"type": "model", "id": "claude-fable-5", "display_name": "Claude Fable 5", "created_at": "2026-01-01T00:00:00.000Z", "max_input_tokens": 1000000, "max_tokens": 128000, "line": "fable", "object": "model", "created": 1234567890, "owned_by": "anthropic"},
    {"type": "model", "id": "claude-opus-5", "display_name": "Claude Opus 5", "created_at": "2026-01-01T00:00:00.000Z", "max_input_tokens": 1000000, "max_tokens": 128000, "line": "opus", "object": "model", "created": 1234567890, "owned_by": "anthropic"},
    {"type": "model", "id": "claude-opus-4-8", "display_name": "Claude Opus 4.8", "created_at": "2026-01-01T00:00:00.000Z", "max_input_tokens": 1000000, "max_tokens": 128000, "line": "opus", "object": "model", "created": 1234567890, "owned_by": "anthropic"}
  ],
  "has_more": false,
  "first_id": "claude-fable-5",
  "last_id": "claude-haiku-4-5-20251001",
  "object": "list"
}
```

Full catalog: `claude-fable-5-1`, `claude-fable-5`, `claude-opus-5-5`, `claude-opus-5`, `claude-opus-4-8`, `claude-sonnet-5-5`, `claude-sonnet-5`, `claude-opus-4-7`, `claude-sonnet-4-6`, `claude-haiku-4-5-20251001` (admin-disabled models are omitted).

`object` (envelope and per entry), `created`, and `owned_by` are **deprecated** OpenAI-shaped aliases retained for older clients of this gateway; they are not part of the Anthropic wire format. `created_at` is a fixed placeholder (`2026-01-01T00:00:00.000Z`) — this gateway does not track vendor release dates, but the value is stable across polls. The upstream `capabilities` tree is **not** served (it would have to be fabricated), so a client that indexes into `model.capabilities[...]` will fail. `line` follows the upstream `ModelLine or null` field (`haiku`, `sonnet`, `opus`, `fable`, `mythos`): Claude backend entries carry the line recorded for each model in the Claude catalog (`api/src/services/claude-models.ts`; never parsed from the id); when another backend engine serves `/anthropic/v1`, its models belong to no Anthropic line and carry `line: null`. `lifecycle`, `deprecated_at` and `retires_at` are not served.

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
| 400 | `invalid_request_error` | Missing/invalid parameters, `unsupported_stream`, `invalid_max_tokens`, `missing_max_tokens`, `invalid_anthropic_version`, `unsupported_in_api_version` (a construct removed in the requested `anthropic-version`), `empty_messages`, `invalid_message_role`, `invalid_message_role_sequence`, `tools_not_supported` |
| 401 | `authentication_error` | Missing or invalid API key |
| 403 | `permission_error` | Model disabled by administrator (`model_disabled`) |
| 404 | `not_found_error` | Unknown model id (`model_not_found`), unmatched route |
| 429 | `rate_limit_error` | Upstream provider quota pressure; not generated by the gateway |
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
- `engine`: optional `codex`, `claude`, or `grok`. May also be supplied via query `?engine=...` or `X-Engine`; wrapper user-agent fallback (`clx`, `cgx`) also selects Claude or Grok. Default is `codex`.
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
  bearer. For Codex and Claude, unrelated `auths` targets are discarded before
  runner verification and are not persisted in `auth_entries`. Grok accepts
  only a modern subscription OIDC scope map; its canonical envelope keeps the
  complete `grok_auth` map, and `/auth` retrieve returns an access-only
  projection (see [interface-cgx.md](interface-cgx.md)). A previously
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
- `host`: `fqdn`, `status`, `last_refresh`, `claude_last_refresh`, `updated_at`, `expires_at`, `client_version`, `client_version_override`, `claude_client_version`, `claude_client_version_override`, `agents_document_id_override`, `wrapper_version`, `claude_wrapper_version`, `api_calls`, `allow_roaming_ips`, `secure`, `vip`, insecure window fields, `engines`, `engines_list`, optional `lane_preference` (`normal` or `null`; a stored legacy `spark` is served as `null`), optional `model_override` / `reasoning_effort_override`, optional `claude_model_override` / `claude_reasoning_effort_override`, and the parallel `grok_*` fields listed in [interface-cgx.md](interface-cgx.md).
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

`?engine=codex|claude|grok` removes only that engine from a multi-engine host,
including its auth state/digests, version/model overrides, and pending installer
tokens. Removing the last engine deletes the host. A legacy request without
`engine` keeps whole-host deregistration. IP binding is enforced unless
`?force=1`; both paths are transactional and audit logged.

### `POST /host/users`
Records `username` and optional `hostname` for the calling host, returning known users with `first_seen`/`last_seen`. Auth + IP binding required.

### `GET /host/lane`
Returns lane metadata for the calling host. Auth + IP binding required; insecure-window checks apply. Response includes `lane_preference` (`normal|null`) and `effective_lane`.

### `POST /host/lane`
Sets/clears host lane preference. Body: `{ "lane": "normal" | null }` (`null` clears; the retired `"spark"` is accepted from wrapper <= 0.9.5 and stored as `null`). Auth + IP binding required; insecure-window checks apply.

### Sync & cron
- `POST /sync/status` — periodic check-in. Records `username`/`hostname`, returns `status` (`ok` | `update`), `reasons[]`, `versions`, `host_users`, and — unless `include_auth:false` — the `/auth` retrieve result under `auth`. Auth + IP binding required; insecure-window checks apply only when `include_auth` is not false. The same rule holds for `POST /sync/bootstrap`.
- `POST /cron/check` — auto-update probe for the host cron entry. Optional `engine`, `client_version`, `wrapper_version`. Returns `action` (`update` | `no_update` | `disable`), `target_version` / `tag` / `enforce_exact` when the CLI is behind, and a `wrapper` block (`action`, `target_version`, `sha256`, `url`) resolved for the caller's platform. Updates `last_cron_check`; the insecure window is neither enforced nor rolled here. During the wrapper's first privileged shared-cron migration, strictly validated standard-spool filenames are authoritative owner identities even when static Go `os/user` cannot resolve an NSS/SSSD account; non-spool safeguard identities remain lookup-validated. With `CXX_WRAPPER_ROLLOUT_ENABLED`, the `wrapper` target is gated per host by the staged cxx rollout (`services/wrapper-rollout.ts`): a host the rollout has not admitted yet, and that does not already run the new release, gets the release it was on (`from_version`, so `wrapper.action:"no_update"`). The signed `/wrapper/v2/config` `wrapper` block applies the same gate, and the communicator updater applies a release only when both agree.
- `POST /cron/report` — host reports its installed versions. Requires `client_version` or `wrapper_version`; optional `engine`.

### Claude artifacts
`{kind}` is `subagent`, `command`, or `output-style` (plural and alias spellings are accepted). Auth required.
- `GET /claude/{kind}` — list served artifacts of that kind: `slug`, `sha256`, `display_name`, `description`, `model`, `updated_at`, `engine`.
- `POST /claude/{kind}/retrieve` — body: `slug` (or legacy `filename`) + optional `sha256` (64-hex). Returns `status` `missing` | `deleted` | `unchanged` | `updated`, plus the artifact body when updated.

### Claude usage
- `POST /claude/usage/report` — host reports what Claude Code's own statusLine payload said for the current `rate_limits` reading. Body: optional `five_hour`/`seven_day` objects (`used_percent`, `resets_at`), optional `source` (defaults `statusline`). Pushed by the clx wrapper's fleet-owned statusLine command on a local throttle; the server never fetches this itself (see `GET /admin/claude/usage`). A report with neither window present is accepted (200 `{status:"ignored"}`) but stored nowhere. Auth required.

### Shared memories
Fleet-wide durable corpus (`shared://{slug}`), deliberately not host-filtered: every host reads and writes the same documents, and `engine` is recorded as provenance only. Auth required.
- `GET /shared-memories` — recency listing; query `limit` (1–200, default 50), `offset`, `prefix`, `tags`, `include_content`. Response reports `scanned_all` when the bounded scan was exhausted.
- `POST /shared-memories/list` — same listing with the parameters in the body.
- `POST /shared-memories/search` — body: `query`/`q` (empty lists by recency), optional `limit` (1–50, default 10), `tags`, and `mode` (`chunks` default, or `documents`).
- `POST /shared-memories/read` — body: `slug` (aliases `id`/`key`) plus optional windowing (`max_chars`, default 32000; `offset`; `chunk` / `from_chunk` / `to_chunk`). Returns `status:missing` when the slug is absent or soft-deleted. A caller preparing a whole-document replacement must start at offset 0 without chunk selectors, follow `next_offset` to `truncated:false`, and require the same `memory.sha256` on every window.
- `GET /shared-memories/{slug}` — same read with the slug in the path and the window in the query string.
- `POST /shared-memories/write` — replaces the entire body of `slug`. Requires `content` (or `text`); optional `title`, `summary`, `tags`, `metadata`, and `expected_sha256` for compare-and-swap (mismatch returns `409 shared_memory_conflict`). Never reconstruct a replacement from a search excerpt, preview, chunk, or partial read; preserve the complete unaffected body and use the stable digest from a complete read. Labels the caller omits are carried over from the stored document.
- `POST /shared-memories/append` — row-locked read-modify-write so concurrent appends cannot lose text. Requires `content` (or `text`); optional `heading`, `separator` (default blank line), `tags`, `metadata`.
- `POST /shared-memories/delete` — soft-deletes `slug` (aliases `id`/`key`); returns `status` `deleted` | `missing`.
- `DELETE /shared-memories/{slug}` — same soft delete with the slug in the path.

- `GET /skills` — list skills (`slug`, canonical `uri` as `skill://{slug}`, `sha256`, `display_name`, `description`, `updated_at`, optional `deleted_at`, `managed`, and source provenance). Auth required. For imported directory bundles, `sha256` is the complete bundle digest and the response also carries `manifest_sha256`; `source_type`, `source_repository`, `source_path`, `source_revision`, `source_license`, and `bundle_sha256` identify the immutable upstream input. The code-managed `afk`, `context`, and `skill-manager` Skills are always present; `coco` is additionally published while the Projects module is enabled.
- `POST /skills/retrieve` — body: `slug` (or legacy `filename`) + optional `sha256`. Returns `status` `missing` | `deleted` | `unchanged` | `updated`, canonical `uri`, provenance/managed metadata, and `manifest` when updated. Source-owned rows are read-only through the ordinary store/delete surfaces.
- `POST /skills/store` — body: `slug`, `manifest` (or `content`; canonical `SKILL.md` markdown), optional `display_name`/`description`/`sha256`. Returns `status` `created` | `updated` | `unchanged` plus canonical `sha256`. Code-managed slugs and any row with a non-blank `source_type` are rejected; only the source adapter may replace imported rows and their auxiliary files.

### Agents
- `POST /agents/retrieve` — retrieve the served engine document (`AGENTS.md` or `CLAUDE.md`). Optional `sha256` enables `status:unchanged` without content. Returns `status` (`updated` | `unchanged` | `missing`), `version_id`, final `sha256`, canonical `base_sha256`, combined `managed_sha256`, `policy_sha256`, nullable `features_sha256`, `sections`, `updated_at`, final `size_bytes`, and `content` when updated. A mandatory `cxx:managed-policy` prefix always identifies Codex Orchestrator fleet membership and supplies precedence/safety and Hard Stop Lines; the canonical versioned base follows; a `cxx:managed-features` suffix carries concise engine/host-specific Skills, Memory, Projects, BrowserOS, Secrets, API-keys-in-chat, Agent Messaging, Git Director, File Transfer, Git commit messages, Feedback and Model Class Check guidance, in that order (`sections` keys `skills`, `memories`/`memory_routing`, `projects`, `browseros`, `secrets`, `api_keys_in_chat`, `agent_messaging`, `git_director`, `file_transfer`, `git_commit_messages`, `feedback`, `model_tiers`; a capability that is off reports its section absent, while commit preferences are always present in managed generation mode). Neither managed block embeds inventories. Feature or policy changes affect the final/managed digests without changing `base_sha256`.

### Config
- `POST /config/retrieve` — optional `sha256` (64-hex) plus optional `username`/`home` to append trusted project stanza (`[projects."<home>"] trust_level = "trusted"`) in baked config. Response: `status` (`updated` | `unchanged` | `missing`), baked `sha256`, `base_sha256`, `updated_at`, `size_bytes`, and `content` when updated. Fleet defaults from `/admin/model-defaults/codex` are canonical `model` / `model_reasoning_effort`; host `model_override` / `reasoning_effort_override` values take precedence in the baked copy. The baked config also injects managed MCP server config pointing to `/mcp`; secure hosts get the host API key, insecure hosts get a short-lived MCP bearer that is re-baked on each retrieve so stale cached config cannot strand them with an expired MCP token. When that Codex MCP entry is successfully injected, the bake also adds a name-based `skills.config` rule disabling the built-in `skill-creator`; MCP-disabled/unavailable and Claude renders do not. `status:missing` means cdx should delete the effective `${CODEX_HOME:-~/.codex}/config.toml`. Codex hosts on 0.156.1+ also get `profiles: [{name, sha256, content}]` (one `<name>.config.toml` per profile, sent on `unchanged` too) instead of `[profiles.*]` tables; see `docs/interface-api.md`.

### Agent Messaging

Agent Messaging is a separate agent-to-agent bus for all nine directions
across Codex, Claude and Grok. Server/operator direct messages and responses
use Agent Portal, while Server publications use explicitly subscribed audiences. The
global `agent_messaging_enabled` setting is seeded off and is the only switch.
Discovery and delivery also require an active host — a secure one outright, an
insecure one only while its allowed window is open — the address engine in that
host's enabled engine set, and an enabled/unarchived address.
Each wrapper lifecycle receives or rebinds a stable `agent:<uuid>` address
through `POST /host/agent-sessions`; the existing heartbeat and finish routes
carry adapter readiness/generation state and unbind the stable address on exit.

Session operations use the short-lived bridge bearer in
`X-Agent-Bridge-Token`:

- `POST /host/agent-sessions/{id}/agent-messaging/groups/list` — list persistent groups and subscription limits.
- `POST /host/agent-sessions/{id}/agent-messaging/groups/create` — create `{slug,title,description?}` without joining automatically.
- `POST /host/agent-sessions/{id}/agent-messaging/groups/detail` — inspect one `{slug}` and its members.
- `POST /host/agent-sessions/{id}/agent-messaging/groups/delete` — creator-only deletion of `{slug}`; `409 agent_messaging_group_members_remain` while any other member is subscribed. Frees the slug for reuse.
- `POST /host/agent-sessions/{id}/agent-messaging/subscribe` — opt in to `{topic}` (`group:<slug>` or an individual `agent:<uuid>` feed).
- `POST /host/agent-sessions/{id}/agent-messaging/unsubscribe` — leave `{topic}`, affecting future publications.
- `POST /host/agent-sessions/{id}/agent-messaging/subscriptions` — list the caller's explicit subscriptions.
- `POST /host/agent-sessions/{id}/agent-messaging/publish` — atomically enqueue explicit publications for subscribed eligible members; `{topic,content,client_message_id,ttl_seconds?}`. Same-ID retries return immutable receipt snapshots; different payloads conflict. Private messages, calls and conferences are not forwarded. No wildcard audiences. Body limit 30 KiB UTF-8, 64 subscribers per topic, 64 subscriptions per agent, 30 publications/minute/sender.
- `GET /admin/agent-messaging/groups` — list group metadata (`agent_messaging.read`).
- `POST /admin/agent-messaging/groups` — create a group (`agent_messaging.manage`).
- `GET /admin/agent-messaging/groups/{slug}` — inspect group members (`agent_messaging.read`).
- `DELETE /admin/agent-messaging/groups/{slug}` — delete any empty group and free its slug; `409 agent_messaging_group_members_remain` while members remain (`agent_messaging.manage`, audited).
- `GET /admin/agent-messaging/subscriptions` — inspect subscription metadata (`agent_messaging.read`).
- `POST /admin/agent-messaging/groups/{slug}/publish` — publish as Server to the selected group (`agent_messaging.manage`).
- `POST /admin/agent-messaging/publish` — publish as Server to a group or the Server feed, `agent:00000000-0000-4000-8000-000000000001` (`agent_messaging.manage`). These routes do not force-subscribe agents.

- `POST /host/agent-sessions/{id}/agent-messaging/list` — discover eligible
  peers, optionally filtered by engine/host/offline state.
- `POST /host/agent-sessions/{id}/agent-messaging/send` — enqueue `content` for
  `to` with UUID `client_message_id`; optional `conversation_id`,
  `ttl_seconds`, and `kind` (`message|request`).
- `POST /host/agent-sessions/{id}/agent-messaging/reply` — reply to a message
  with a new sender idempotency UUID.
- `POST /host/agent-sessions/{id}/agent-messaging/wait` — sequence-cursor long
  poll for a conversation (maximum 25 seconds).
- `POST /host/agent-sessions/{id}/agent-messaging/message` — read one message
  visible to the participant.
- `POST /host/agent-sessions/{id}/agent-messaging/cancel` — cancel an open
  participant conversation.
- `POST /host/agent-sessions/{id}/agent-messaging/mailbox` — the ring: report
  what is queued for this session, plus messages that recently expired unanswered.
  Read-only — no lease, no status change — and usable before the session has
  ever bound receive-capable, which is the state it exists to rescue. Returns no
  message bodies: hearing the phone ring is not answering it.
- `POST /host/agent-sessions/{id}/agent-messaging/conf/open` — open a conference
  and become its chair. Mints a multi-use room PIN and returns the caller's own
  address. One open conference per owner; re-opening returns it with
  `reused: true`. `join_existing: true` (needs `topic`) makes it an atomic
  open-or-join: the caller joins the live room for that topic in its repository
  (`joined: true`, `role: "participant"`, no PIN) or opens it; see
  `docs/interface-api.md`.
- `POST /host/agent-sessions/{id}/agent-messaging/conf/list` — the caller's live
  rooms (chair, invited or member) with role, state, member count and budget.
  Membership-scoped; never returns a PIN.
- `POST /host/agent-sessions/{id}/agent-messaging/conf/invite` — chair only.
  Invite up to 8 addresses or aliases; the invite does not spend the invitee's budget. One result per address; a partial fan-out
  is reported, not rolled back.
- `POST /host/agent-sessions/{id}/agent-messaging/conf/join` — join by room PIN
  or by the `conference_id` from an invitation (exactly one). The room PIN is
  multi-use and is not consumed. The `conference_id` form requires an existing
  member row, so knowing a UUID is not an entry ticket.
- `POST /host/agent-sessions/{id}/agent-messaging/conf/roster` — list members
  with host, engine, role, declared purpose, delivery mode and floor state.
- `POST /host/agent-sessions/{id}/agent-messaging/conf/say` — chair broadcasts to
  seated members or one named member; a participant reaches only the chair.
- `POST /host/agent-sessions/{id}/agent-messaging/conf/dispatch` — chair only.
  Hand one member a task and take it off the floor until it reports. Optional
  `eta_seconds` (integer 0..14400, default 900) is sent unchanged as the TASK
  `eta`; the stuck-member grace (`grace_seconds`) is floored at 900.
- `POST /host/agent-sessions/{id}/agent-messaging/conf/adjourn` — chair only.
  Graceful by default: members still working finish first and the room reports
  `adjourning`. `force` cuts them off, killing any running task.
- `POST /host/agent-sessions/{id}/agent-messaging/bind` — publish native adapter
  protocol/capabilities, receive readiness, upstream continuity, and the
  expected binding generation.
- `POST /host/agent-sessions/{id}/agent-messaging/deliveries/claim` — claim one
  delivery with an idempotent claim UUID and optional long poll.
- `POST /host/agent-sessions/{id}/agent-messaging/deliveries/{messageId}/renew`
  — renew the owned 60-second lease.
- `POST /host/agent-sessions/{id}/agent-messaging/deliveries/{messageId}/ack` —
  acknowledge `accepted|completed|retry|dead|ambiguous`.

The outbound-only per-user relay registers with normal host authentication,
then uses the returned generation-fenced 15-minute bearer in
`X-Agent-Relay-Token`; it never opens a host listener and does not claim for an
address while a live interactive session is attached. A per-user (non-daemon)
relay is admitted only on a persistent host (host daemon `resident_enabled`, or
remote starts enabled and not expired); elsewhere register, heartbeat and claim
answer 503 `agent_messaging_relay_not_persistent`, while stop, renew, reply and
ack stay open so in-flight work can finish. See
[host runtime policy](host-runtime-policy.md):

- `POST /host/agent-relays/register` — register/replace the host-user relay.
- `POST /host/agent-relays/{id}/heartbeat` — refresh heartbeat and token expiry.
- `POST /host/agent-relays/{id}/stop` — stop the relay and erase its token.
- `POST /host/agent-relays/{id}/deliveries/claim` — claim one dormant-address
  delivery.
- `POST /host/agent-relays/{id}/deliveries/{messageId}/renew` — renew the
  relay-owned lease.
- `POST /host/agent-relays/{id}/deliveries/{messageId}/reply` — persist a reply
  for the owned delivery.
- `POST /host/agent-relays/{id}/deliveries/{messageId}/ack` — acknowledge the
  relay-owned delivery.

Delivery is per-target FIFO, ordered at least once, and limited to one
leased/accepted message per target. A delayed retry remains head-of-line.
Claims and sender `client_message_id` values are idempotent, retries back off,
and attempt 12 is terminal `dead`. UTF-8 content is limited to 32 KiB; TTL
defaults to 24 hours and may be 60 seconds through seven days. Once a delivery
is `accepted`, lost completion certainty becomes terminal `ambiguous` instead
of an automatic replay. Redrive is always explicit and creates a new row linked
to the retained terminal original.

Admin metadata reads require any active admin session. Mutations and plaintext
reveal require `owner` or `admin`:

- `GET /admin/agent-messaging/state` — global state, queue/address counts, and
  the four direction summaries.
- `POST /admin/agent-messaging/state` — set the global switch.
- `GET /admin/agent-messaging` — address inventory compatibility/SPA route.
- `GET /admin/agent-messaging/addresses` — stable addresses, host eligibility,
  readiness, and queue depth.
- `PATCH /admin/agent-messaging/addresses/{id}` — set/clear a unique alias.
- `POST /admin/agent-messaging/addresses/{id}/enabled` — set the address gate.
- `GET /admin/agent-messaging/conversations` — metadata listing (`status`,
  `limit` query filters).
- `POST /admin/agent-messaging/conversations/{id}/cancel` — cancel a
  conversation.
- `GET /admin/agent-messaging/messages` — metadata-only listing
  (`conversation_id`, `status`, `limit` query filters); content is omitted.
- `POST /admin/agent-messaging/messages/{id}/reveal` — owner/admin audited
  plaintext reveal with `Cache-Control: no-store` and `Pragma: no-cache`.
- `POST /admin/agent-messaging/messages/{id}/redrive` — create a fresh queued
  message from a `dead` or `ambiguous` original.
There is no per-host gate. Once the fleet switch is on, every active host is
eligible, including insecure ones; an insecure host's calls are authorized per
operation while `insecure_enabled_until` is in the future, and are otherwise
refused with `agent_messaging_insecure_window_closed`.

Turning off the fleet switch, deactivating a host, disabling an engine, or
disabling an address cancels queued/leased work, marks accepted work ambiguous,
cancels affected conversations, revokes relevant relays, and generation-fences
bindings. A closed allowed window does none of that: the queue is left intact
and drains when the window reopens. Graceful session finish keeps the stable address
dormant; graceful relay shutdown stops its server generation. Content and
delivery errors are Secretbox-encrypted. Terminal messages, canceled
conversations, dormant addresses, and audit history are retained: version 1
has no automatic Agent Messaging history purge.

### Projects module
All `/projects*` routes require normal host API-key auth + IP binding and return HTTP `404 Project coordination disabled` while the module is off.
- `GET /projects` — list projects with summary fields (`slug`, `title`, `name`, `description`, `about`, `latest_seq`, `created_at`, `updated_at`).
- `POST /projects` — body: `slug` (required), optional `about` object, optional `roster_markdown` or `agents_markdown`. Returns the full project detail payload.
- `GET /projects/{slug}` — full project state: `project`, `notes`, `todos`, `files`, `feedback`, `memories`, and `recent_changes`.
- `GET /projects/{slug}/summary` — the lean orientation payload and the one an agent should call first: `about`, `roster_markdown`, `latest_seq`, `counts` (including `files_bytes`, `feedback_by_type` and `feedback_by_status`), a compact `board` block, `files` as metadata only, note and event previews, plus the managed `skill`/`instructions`/`quickstart` and `routes`. Unlike `/bootstrap` it inlines no file bodies, so its size tracks how many things a project holds rather than how big they are.
- `GET /projects/{slug}/bootstrap` — compact context payload with `about`, `roster_markdown`, `latest_seq`, `counts`, recent notes/todos/files/memories/changes, native `instructions`, `quickstart`, managed `skill` metadata (`slug`, canonical `uri`), and canonical project routes. `recent_memories` is capped at 8 previews (no full content). The embedded guidance is explicitly project-only for CoCo shared handoffs, pointing durable shared memory at `project_memory_*` and noting `memory://...` stays host-scoped.
- `POST /projects/{slug}/about` — body `{ about: {...} }` (or a raw object) updates the project metadata block.
- `POST /projects/{slug}/archive` — closes the project: it drops out of `GET /projects` (pass `include_archived` to see it) and out of the MCP resource catalogue, but stays readable and writable by slug. Optional body `{ reason }`. `POST /projects/{slug}/unarchive` reopens it. Both are idempotent.
- `POST /projects/{slug}/roster` — body `{ roster_markdown }` or `{ markdown }` updates the shared roster/brief markdown.
- `GET /projects/{slug}/changes` — optional `since` query/body value; returns `{ project, since, latest_seq, changes[] }`.
- Notes: `GET /projects/{slug}/notes`, `POST /projects/{slug}/notes`, `POST /projects/{slug}/notes/{id}`, `DELETE /projects/{slug}/notes/{id}`. Create/update bodies require `header` and `body`.
- Todos: `GET /projects/{slug}/todos`, `POST /projects/{slug}/todos`, `POST /projects/{slug}/todos/{id}`, `POST /projects/{slug}/todos/{id}/done`, `POST /projects/{slug}/todos/{id}/undone`, `DELETE /projects/{slug}/todos/{id}`. Create/update bodies require `title`; todo payloads include `done` and `done_at`.
- Files: `GET /projects/{slug}/files`, `POST /projects/{slug}/files`, `DELETE /projects/{slug}/files/{id}`. Upsert bodies require `stored_name` (or `name`) and `content`; optional `description` and `mime_type`. Responses include `content`, `content_sha256`, `size_bytes`, and timestamps.
- `POST /projects` accepts `board_template` (`software` by default, or `migration`) to choose the lane set the project's board is provisioned with.
- Feedback: `GET /projects/{slug}/feedback`, `POST /projects/{slug}/feedback`, `POST /projects/{slug}/feedback/{id}`. Create bodies require `type` (`bug|feature|note|issue|test`), `title`, and `body`; new entries start with `status:"open"`. The `{id}` form triages an existing item — `status` moves through `open|acknowledged|resolved|dismissed`, and `type`, `title` and `body` can be corrected.
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
- MCP resources include host-scoped memories (`memory://{id}`), fleet-wide shared memories (`shared://{slug}`), canonical Skill manifests (`skill://{slug}`), imported Skill support files (`skill://{slug}/{path}`), and, when the Projects module is enabled, shared project bootstrap resources (`project://{slug}`). A bundled manifest is annotated with the support-file URI contract and a warning that scripts are reference text, not implicitly authorized execution. Resource listings prefix skills whose frontmatter sets `disable-model-invocation: true` with `[Explicit user invocation only]`. Resource create/update on an existing `shared://` document is a whole-body replacement and therefore requires a complete stable read plus `expected_sha256`; resource delete is reserved for a wholly invalid or superseded record. Shared CoCo state still belongs only in project resources.
- Host-authenticated `/mcp` advertises host-safe `memory_*`, `shared_memory_*`, `resource_*`, `project_*`, `secret_*`, `git_*`, `transfer_*`, and Skill tools; the complete catalog with per-tool arguments is `docs/MCP.md`. The `secret_*`, `git_*`, `transfer_*` and `project_board_list`/`project_card_*` families stay listed while their module is off and answer `status:"disabled"` (or refuse the mutation) rather than disappearing, so an agent can tell "off" from "empty". `skill_store` creates, fully replaces, or revives a shared `engine:null` manifest from `{slug, manifest, display_name?, description?}`; `skill_delete` soft-deletes by slug. These mutations are last-writer-wins, attributed to the host, and reject code-managed/source-owned Skills. The always-available managed `skill-manager` Skill documents the retrieve-before/write/verify-after flow. Coordinator filesystem helpers (`fs_*`) are not exposed to host callers.
- When the Projects module is enabled, `tools/list` also advertises the `project_*` family — `project_list`, `project_create`, `project_detail`, `project_bootstrap`, `project_changes`, the note (`project_note_create`/`project_note_upsert`), todo (`project_todo_create`/`update`/`done`/`undone`), file (`project_file_upsert`/`list`/`read`/`delete`), memory (`project_memory_upsert`/`get`/`list`/`search`/`delete`) and `project_feedback_create` tools, plus the board tools (`project_board_list`, `project_card_create`/`get`/`claim`/`move`/`release`/`update`) gated separately by `/admin/project-board/state`; resources add `project://{slug}` templates plus concrete project resources, and the managed `coco` skill carries the human-readable toolkit/help text directly.
- Origin checks are a single toggle, not an allowlist: with `MCP_ALLOW_REQUEST_HOST_ORIGIN` off (default `0`), any request carrying an `Origin` header returns 403; turning it on drops the check entirely.

### Wrapper
- `GET /wrapper` — compatibility alias for `/wrapper/v2/meta`. It returns the requested engine's projection of the common `cxx` platform matrix (`version`, `sha256`, `size_bytes`, `updated_at`, `url`). Auth required.
- `GET /wrapper/download` — serves the host-targeted POSIX transition launcher used by date-versioned shell wrappers. It is not a raw binary download. Auth required.
- `GET /wrapper/v2/meta` — engine-scoped view of the common wrapper version, sha256, and the primary signing key's `signing_kid` (its DB row id) plus `signing_fingerprint` (sha256 of the raw Ed25519 public key, lowercase hex). Engine comes from `?engine=`. The payload also carries the top-level integers `api_version` and `min_api` (communicator API level and its effective minimum; see `docs/interface-api.md`).
- `GET /wrapper/v2/config` — signed per-host wrapper config JSON (`{payload, signature, signatures}`); `?sig=1` returns the detached signature as `text/plain`. `signature` is always the primary (oldest active) key's and keeps the exact bytes it had before multi-sign, so deployed wrappers are unaffected; `signatures` additionally lists one `{algo, value, kid, fingerprint}` per active key, oldest first. `?sig=1&kid=<id>` or `?sig=1&fingerprint=<hex>` serves a named active key's signature instead of the primary's (`404 signing_key_not_found` if it is not active, `422` if a selector is used without `sig=1`). The `x-signature*` headers always describe the signature actually served.
- `GET /wrapper/v2/download` — streams the binary built for the calling host's platform; `GET /wrapper/download` instead serves the transition script date-versioned shell wrappers update through.
- `GET /wrapper/v2/manifest/{engine}` — per-platform manifest for `codex`, `claude`, or `grok`; an unknown engine returns `404 unknown_engine`.
- `GET /wrapper/v2/bin/{engine}/{platform}/v:version/{binary}` — versioned binary route. The canonical common shape is `cxx/{platform}/v:version/cxx`; `{platform}` is `os-arch` (for example `linux-amd64`) and the version segment is a literal `v` followed by the version. Historical `{engine}/.../{cdx|clx}` shapes remain readable: exact old artifacts are immutable, while a new version without a split artifact transparently streams the matching `cxx` bytes.
- `GET /wrapper/v2/download/{artifact}/{platform}/v:version/{binary}` — the same exact-version artifact under a `/download` path; the communicator 307s cxx 0.9.71–0.9.74 self-update frames here so those owners fetch it over direct HTTPS.
- Platform is taken from `X-Wrapper-Platform: os-arch` when present, else inferred from the user agent (default `linux-amd64`). All wrapper routes require host auth, and every one of them returns `503 wrapper_v2_unavailable` while no active wrapper signing key is configured.

### CLI device auth
- `POST /cli/auth/start` — wrapper begins a device-code login. Body: `fqdn`, optional `secure` (default `true`). Returns the request id, user code, and `verify_url`. Exempt from the API kill switch.
- `POST /cli/auth/poll/{id}` — wrapper polls the 64-hex request id until approved or denied; an approved response also carries `base_url`. Unknown ids return `404`.
- `POST /cli/auth/lookup` — admin session required; `{user_code}` resolves a pending request (`404` when unknown or expired).
- `POST /cli/auth/approve` — owner/admin role required; `{user_code}` approves the request and registers the host. Approval can rotate an existing host key, so it shares the Agent Messaging runtime-fencing gate.
- `POST /cli/auth/deny` — admin session required; `{user_code}` denies the request.

## Provisioning & Installer
- `POST /admin/hosts/register` — owner/admin role required. Create/rotate a host; rotating an existing key generation-fences that host's Agent Messaging runtime. Body: `fqdn` (required), optional `secure` (default `true`), optional `vip` (default `false`), optional `temporary` (boolean; `true` enables sliding 2-hour idle expiry via `expires_at` refresh on authenticated contact), optional `curl_insecure` (boolean; bakes `allow_insecure: true` into the signed wrapper config, returns a `curl -k` installer command, and makes the installer reuse `curl -k` for its own downloads), optional `reverse_dns_mode` (`global` | `enabled` | `disabled`), optional `duration_minutes` (`0..480`, used when `secure=false` for initial + stored insecure window), and optional `engines` (`codex`, `claude`, or both). Returns host payload (with API key) and single-use installer metadata: `token`, `url`, `command`, `mode`, `label`, `expires_at`. If `duration_minutes` omitted for insecure hosts, initial window is 30 minutes with stored extension window 10 minutes. Base URL prefers `PUBLIC_BASE_URL`, else validated trusted forwarded host/proto; unresolved base URL returns 500. Existing-host installer mints can also include `curl_insecure` so the returned command reflects the Host Detail toggle state atomically.
- `POST /admin/hosts/quick-register` — create an insecure temporary throwaway host with an auto-generated short `tmp-YYYYMMDD-HHMMSS-xxxxxx` name, `secure=false`, `temporary=true`, `vip=false`, and a 2-hour host expiry. Body requires `engines` (any nonempty combination of `codex`, `claude`, and `grok`) and accepts optional `duration_minutes` (`0..480`) for the initial insecure window. Returns the same host + installer metadata shape as `/admin/hosts/register`.
- `GET /install/{token}` — public, non-consuming preflight launcher: a credential-free script that checks `python3`, `curl` and a writable bin root and, only when they pass, claims the installer with `POST` to the same URL and runs it. A failed check leaves the token usable for a re-run.
- `POST /install/{token}` — public single-use installer claim (TTL fixed at 1800s in the API; no env knob). Marks the token used before emit. It fetches all enabled signed configs before installation and requires every enabled engine's wrapper version and SHA to match, then downloads one `cxx` and atomically installs relative `cdx`/`clx`/`cgx` aliases for enabled engines. Claude-capable installs prepare Node.js/npm (OS Node package, pinned Corepack npm 10.9.2 when available, OS npm fallback). The installer invokes the host-wide `cxx cron install` and `cxx cron run --minimal` coordinator once each; `READY` is gated on the common wrapper, every requested CLI, and the one shared cron setup. Any missing/failed component yields `INCOMPLETE` and a non-zero exit. A preflight for `python3`, `curl` and a writable bin root runs before any output card, and each enabled engine gets one non-fatal `--allow-concurrent-sync sync` after the CLI checks. Token errors are served as HTTP 200 with `X-Installer-Error: <code>` and a script that prints to stderr and exits 1, so `curl -fsSL … | sh` shows the reason (both methods); consuming a token (the `POST`) publishes `host.updated`.
  `cxx cron run` installs the per-user `cxx-agent` background
  worker only on a persistent host and retires it elsewhere; the maintenance
  crontab line is kept only on auto-update hosts (nightly), see
  [host runtime policy](host-runtime-policy.md). On Claude-capable hosts it uploads changed native credential
  generations independently of Agent Messaging.
- `GET /install/v2/{token}`, `POST /install/v2/{token}` — aliases of `GET /install/{token}` and `POST /install/{token}`; wrappers minted against the v2 URL keep working unchanged.
- `GET /seed/v2/auth/{uuid}` / `POST /seed/v2/auth/{uuid}` — aliases of the `/seed/auth/{uuid}` pair below.

## Observability
- `GET /healthz` — unauthenticated liveness probe: `{ok:true, ts}`.
- `GET /readyz` — unauthenticated derived readiness probe. Returns `200` only when migrations, runner health, one decryptable encrypted wrapper signer, the complete same-version four-platform wrapper matrix, and `PUBLIC_BASE_URL` are ready; otherwise returns `503` with safe per-check detail. `/healthz` remains pure liveness.
- `GET /versions` — same versions block as `/auth` (`status:ok`, `data:{...}`) when API kill switch is off.
- `POST /admin/versions/check` — force fresh GitHub release lookup (bypass cache) and return `{available_client, versions}`.
- `POST /admin/codex-version` — set fleet Codex version policy. Body `{ selection: "latest" | "auto" | "<x.y.z>" }`.

## Admin Endpoints (admin session cookie)
- `GET /admin/overview` — host totals, refresh stats, `versions`, ChatGPT usage snapshot/summary, quota flags, `cdx_silent`, `reverse_dns_enabled`, `insecure_approval_enabled`, `inactivity_window_days`, and optional client-version lock metadata.
- `GET /admin/ws/info` — websocket bootstrap (`enabled`, `url`, `last_event_id`, `heartbeat_seconds`, `backlog_limit`). The socket itself is served at `/admin/ws` behind the admin session: it sends `{type:"hello", ts}` on connect, re-resolves the session every `heartbeat_seconds` and sends `{type:"ping", ts}` (closing the socket when the session is gone), and pushes every published event as `{type, payload, ts}`. It reads nothing from the client. The event-type catalog is `api/src/ws/events.ts`, held in lock-step with the frontend router by `api/test/unit/ws/event-invalidation-coverage.test.ts`.
- Admin auth + users:
  - `GET /admin/auth/status` — auth status (`has_users`, `admin_count`, `enforced`, `authenticated`, `user`, `capabilities`, `authorization_mode`, `passkeys_registered`, `passkey_login_available`). `capabilities` is the session's effective set under the fleet's current `authorization_mode` (`compatible` | `strict`), so the console can hide what a 403 would meet; it is presentation only and every request is re-checked server-side.
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
  - `GET /admin/setup/status` — secret-free infrastructure checks (live `SELECT 1` database probe), `configured_engines`, `default_engines` (wizard answer, else configured), canonical-auth presence, host/sync counts, warnings, and recommended next actions. Public only while `admin_users` is empty; afterward requires an admin session.
  - `POST /admin/setup/owner` — one-time unauthenticated first-owner claim. Serializes the zero-user check, creates a fixed active `owner`, and immediately issues the normal admin session cookie; later claims return `409 first_owner_claimed`.
  - `GET /admin/setup/wizard` — first-run wizard progress: `{completed_at, dismissed_at, last_step, engines}`. Same visibility rule as `/admin/setup/status`, and mirrored on that response as `wizard` so the console needs only one request.
  - `POST /admin/setup/wizard` — merge-update of that blob with `{last_step?, engines?, completed?, dismissed?}`. Position and completion only: every question the wizard asks is answered against the endpoint that owns it (model defaults, module switches, host registration). `completed`/`dismissed` are booleans in and timestamps out.
  - `POST /admin/users` — create admin user. The legacy empty-install bootstrap path uses the same atomic fixed-owner claim.
  - `POST /admin/users/{id}` — update admin user.
  - `DELETE /admin/users/{id}` — delete admin user (blocked if last active admin).
  - `POST /admin/users/wipe` — wipe all admin users (requires confirmation `confirm:"WIPE"`).
- `POST /admin/toasts` — emit admin toast event (body: `message`, optional `title`, `level`, `timeout_ms`; aliases `body`/`text`, `tone`).
- `GET /admin/hosts` — list hosts with digest/history, versions, API calls, IPs, roaming flag, `secure`, `vip`, optional `expires_at`, insecure-window fields, `curl_insecure`, overrides (`client_version_override`, `claude_client_version_override`, `agents_document_id_override`, `lane_preference`, `model_override`, `reasoning_effort_override`, `claude_model_override`, `reverse_dns_mode`, `auto_update_override`), `auth_source`, recorded users, and derived auto-update status fields (`effective_auto_update_enabled`, `auto_update_state`, `auto_update_label`, `auto_update_emoji`, `auto_update_rank`, `auto_update_last_event_at`, `auto_update_target_version`).
- `GET /admin/hosts/insecure` — insecure-host view with `{count, active, hosts[], domains[], domains_active, fleet_window}`. `domains[]` lists only allows whose `enabled_until` lies in the future; a permanent allow (`enabled_until: null`, see `allow-domain` below) is currently omitted from this listing and its count.
- `GET /admin/hosts/{id}/detail` — single-host detail card: the host row plus per-engine version summaries, available client versions, canonical auth metadata, and the global `auto_update_enabled` / `reverse_dns_enabled` / `inactivity_window_days` context. Carries `installer_used_at` / `installer_expires_at` (latest install token, `null` when none). Unknown ids return `404 host_not_found`.
- `POST /admin/hosts/{id}/installer` — mint a fresh single-use installer for an existing host. Optional `engines` and `curl_insecure`; returns `{host, installer}` in the same shape as `/admin/hosts/register`.
- `POST /admin/hosts/{id}/engines` — set the host's enabled engines (`engines`, at least one of `codex` / `claude` / `grok`).
- `POST /admin/hosts/{id}/release-ip-binding` — clear the pinned `ip4`/`ip6` so the next authenticated request re-pins.
- `POST /admin/hosts/{id}/scaling-exempt` — toggle `scaling_exempt` so the host is ignored by the scaling rules.
- `POST /admin/hosts/{id}/auto-update` — set the per-host auto-update override (`override`: `true` | `false` | `null` to follow the fleet setting).
- `POST /admin/hosts/{id}/browseros-mcp` — toggle the BrowserOS MCP server in the host's baked config (`browseros_mcp` boolean).
- `GET /admin/hosts/{id}/auth` — canonical digest/last_refresh and recent digests for the selected engine; optional auth body via `?include_body=1`. Engine can be supplied via body/query/header and defaults to `codex`; the response includes `engine` plus the Codex, Claude, and Grok host-side fields.
- `POST /admin/hosts/{id}/roaming` — toggle `allow_roaming_ips` (`allow` boolean).
- `POST /admin/hosts/{id}/secure` — toggle secure/insecure mode.
- `GET /admin/wrapper/rollout` — staged cxx rollout status (`hosts.read`): `enabled`, configured `settings` (`stages`, `soak_minutes`), the current `rollout` (state plus `stage`, `next_stage`, `soak_ends_at`, `confirmed_host_ids`) or `null`, and every host's `canary` / `excluded` / `running` / `admitted`.
- `POST /admin/wrapper/rollout/:action` — `halt` (optional `reason`), `resume` (restarts the current stage's soak), `promote` (next stage now) or `complete` (release to every host now); `hosts.manage`. Returns the status body; `409` when no rollout is active or halted. Halting never reverts an updated host.
- `POST /admin/hosts/:id/wrapper-canary` — `{enabled: boolean}`; marks a host as a rollout canary (`hosts.manage`). A canary added during a rollout is admitted immediately.
- `POST /admin/hosts/{id}/vip` — toggle VIP (VIP hosts always behave warn-only for quota hard-fail).
- `POST /admin/hosts/{id}/curl-insecure` — toggle sync TLS verification bypass (`allow` boolean).
- `POST /admin/hosts/{id}/reverse-dns` — set per-host reverse DNS mode (`mode`: `global` | `enabled` | `disabled`).
- `POST /admin/hosts/{id}/model` — set per-host Codex `model_override` / `reasoning_effort_override`, Claude `claude_model_override`, and Grok `grok_model_override` / `grok_reasoning_effort_override` (null/empty clears). Codex supports `gpt-6.1-sol`, `gpt-6-astra`, `gpt-6-sol`, `gpt-6-luna`, `gpt-5.6-sol`, `gpt-5.6-terra`, and `gpt-5.6-luna`; effort must be valid for the selected model. Astra is the fleet default at `medium` and supports `low|medium|high|xhigh|max|ultra`; GPT-6.1 Sol (default effort `low`), both older Sols and Terra also support `ultra` (GPT-5.6 Sol's own default is `low`), both Lunas stop at `max`. Deprecated GPT-5.5 is no longer offered; stored selections migrate to GPT-6.1 Sol while preserving a valid effort (otherwise `low`). Stored retired Codex overrides are backfilled to Astra with the intentionally retained `high` migration effort — except `gpt-5.4-mini` (retired upstream 2026-08-31), which backfills to `gpt-5.6-luna`, the replacement the Codex model catalog names.
- `POST /admin/hosts/{id}/codex-version` — set per-host Codex version override (`selection: "global"|"fleet"|"default"|"<x.y.z>"`).
- `POST /admin/hosts/{id}/claude-version` — set per-host Claude Code version override (`selection: "global"|"fleet"|"default"|"<x.y.z>"`, or `claude_client_version_override`).
- `POST /admin/hosts/{id}/agents-version` — set per-host AGENTS document override (`selection: "global"|"fleet"|"default"|<version_id>`).
- `POST /admin/hosts/{id}/insecure/enable` — insecure hosts only; opens/extends window. Optional `duration_minutes` (`0..480`); if omitted uses stored/default 10.
- `POST /admin/hosts/{id}/insecure/disable` — closes window immediately and clears grace.
- `POST /admin/hosts/insecure/extend` — for active insecure hosts, resets each active window to `now + insecure_window_minutes` (with grace recalculated).
- `POST /admin/hosts/insecure/disable-all` — closes all active insecure windows, expires active domain auto-allows, and retracts the fleet window if one is open.
- `POST /admin/hosts/insecure/window` — open the fleet-wide insecure window. Optional `duration_minutes` (`5..1440`, default 480); re-opening replaces the deadline rather than extending it. Stamps every insecure host with the deadline, resolves all pending approval requests as approved, and returns `fleet_window` with `until`, `window_minutes`, `hosts_opened`, `approvals_resolved`.
- `POST /admin/hosts/insecure/window/close` — close the fleet window: clears every insecure host's window and grace, pulls active domain auto-allows back to now (rows survive unrevoked), and deletes the stored deadline. Returns `fleet_window` with `hosts_disabled` and `domains_expired`.
- `GET /admin/insecure-approval` / `POST /admin/insecure-approval` — read/set insecure approval gate (`enabled` boolean).
- `GET /admin/insecure-approvals/pending` — list unresolved insecure approval requests for the admin queue. Returns `requests[]` with `id`, `host_id`, `fqdn`, `request_ip`, `requested_at`, `updated_at`, and `status`.
- `POST /admin/insecure-approvals/{id}/allow-domain` — approve pending request and add/update a domain auto-allow. Body: optional `domain` (defaults to the host's parent domain; must be a proper suffix of the host FQDN), optional `duration_minutes` (`0..480`, default 480), optional `permanent` (writes `enabled_until: null`, an allow that never lapses; `window_minutes` still governs how long a matched host's own window stays open). Every other pending request under that domain is approved in the same call — the gate has already stopped asking for them — and the response carries `cleared_request_ids`, the `domain` row, and the host.
- `POST /admin/insecure-approvals/{id}/approve` — approve pending request and open host window. Optional `duration_minutes` (`0..480`); when omitted the grant is 480 minutes rather than the host's stored sliding window, and the granted length is stored as the host's `insecure_window_minutes` so the next request does not collapse it back to ten.
- `POST /admin/insecure-approvals/{id}/deny` — deny pending request.
- `POST /admin/insecure-domain-allows/{id}/revoke` — revoke domain auto-allow.
- `POST /admin/hosts/{id}/clear` — clear host canonical auth linkage/digests for Codex, Claude, and Grok.
- `DELETE /admin/hosts/{id}` — delete host + digests.
- `POST /admin/auth/upload` — admin upload/seed canonical `auth.json` (JSON body or `file`); optional `host_id`; requires positive live runner validation.
- `POST /admin/auth/seed-command` — issue one-time `curl -fsSL ... | bash` seed command for `{engine:"codex"|"claude"|"grok"}` (default Codex). Generated scripts read `~/.codex/auth.json` for Codex or `~/.claude/.credentials.json` for Claude, accept both API-key and Claude Code OAuth credential shapes, normalize plain credential files by adding `last_refresh` when missing, and print server validation errors on upload failure. The Grok script never reads a live `~/.grok/auth.json`: it runs a dedicated `grok login --device-auth` in a throwaway `GROK_HOME` and erases it after upload, because xAI rotates refresh tokens and a login must have exactly one refresher; `GROK_SEED_AUTH_PATH` explicitly opts into uploading an existing file nothing else will use. TTL `AUTH_SEED_TOKEN_TTL_SECONDS` (default 900).
- `GET /seed/auth/{uuid}` — serve engine-specific seed shell script. Missing/used/expired tokens return HTTP 200 with `X-Installer-Error` (`seed_not_found`, `seed_used`, `seed_expired`, …) and a script that prints the reason to stderr and exits 1.
- `POST /seed/auth/{uuid}` — accept raw credential payload (or `{ "auth": ... }`), require positive live runner validation, store verified canonical auth for the token engine, and consume the token after a successful store. Malformed, definitively rejected, and ordinary transient failures release the reservation so the same unexpired token can be retried. Unsafe runner-refresh/readback failures keep the one-time token consumed because the submitted refresh token may already have rotated; any retained replacement remains quarantined.
- `GET /admin/api/state` / `POST /admin/api/state` — read/set API kill switch.
- `GET /admin/api/surfaces` / `POST /admin/api/surfaces/{surface}` — list the exposed APIs (`openai` `/v1`, `anthropic` `/anthropic/v1`, `grok` `/grok/v1`) with backend engine, kill switch and active key count; set `{backend?, disabled?}`. Any surface may be served by any engine; keys and kill switches stay with the surface. See `docs/interface-api.md` → Exposed API routing.
- `GET /admin/engines/state` / `POST /admin/engines/{engine}/state` — fleet-wide engine master switches. GET returns `{engines:[{engine,label,enabled,updated_at,updated_by,assigned_hosts}]}`; POST `{enabled: boolean}` switches one engine on or off for the whole fleet and returns the row plus `previous` and `hosts_suspended`. Off suspends everything for that engine (host routes `403 engine_disabled` with `scope:"fleet"`, gateways routed to it `503 api_disabled`, provider-touching admin actions `409`) while keeping assignments, accounts and keys. See `docs/interface-api.md` → Engine master switches.
- `GET /admin/engines/{engine}/destroy` / `POST /admin/engines/{engine}/destroy` / `POST /admin/engines/{engine}/destroy/purge` / `DELETE /admin/engines/{engine}/destroy` — fleet-wide **destroy engine**: remove an engine completely from every host. POST `{confirm: "<engine>"}` opens a request (engine must already be suspended; `409 engine_not_suspended` otherwise) and re-bakes every host config with `host.destroy_engines`; GET returns `{engine, request, counts, hosts:[{host_id,fqdn,status,residue,reported_at}]}`; `purge` `{force?}` then drops the engine's stored credentials, accounts and host assignments (refused with `409 engine_destroy_incomplete` while hosts are unfinished unless `force`); DELETE cancels. Hosts report via `POST /host/engine-destroy/report`. Re-enabling the engine is refused (`409 engine_destroy_open`) until the request is cancelled. See `docs/interface-api.md` → Engine destroy.
- `GET /admin/openai/state` / `POST /admin/openai/state` — read/set persisted `openai_api_disabled` flag (toggles OpenAI-compatible API independently).
- OpenAI-compatible API keys (Codex-scoped; Claude-scoped keys live under `/admin/claude/keys`, Grok `sk-cgx-` keys under `/admin/grok/keys`):
  - `GET /admin/openai/keys` — list keys (`id`, `name`, `key_prefix`, `is_active`, `use_count`, `last_used_at`, `expires_at`, timestamps).
  - `POST /admin/openai/keys` — issue a key. Body: `{name, expires_at?}`. Returns the full key once, alongside the record.
  - `POST /admin/openai/keys/{id}/toggle` — enable/disable a key (`active` boolean).
  - `DELETE /admin/openai/keys/{id}` — delete a key. Unknown ids return `404 not_found`.
- `GET /admin/model-defaults/{engine}` — read the `codex`, `claude`, or `grok` fleet CLI default. Returns `{status:"ok", engine, model, reasoning_effort, catalog:[{model, persistent_efforts, default_effort}]}`. It is read-only: when no engine config row exists it reports the catalog default without persisting it.
- `POST /admin/model-defaults/{engine}` — strict body `{model, reasoning_effort?: string|null}`. Omitted/null effort selects the model default; invalid engine/model/effort or extra fields return HTTP 422 `validation_failed`. Codex persists `model` / `model_reasoning_effort`; its model-specific effort sets/defaults match the per-host contract above, with Sol using its provider-native `low` default. Claude persists `model` / `effortLevel`. Claude capabilities: Fable 5.1, Fable 5, Opus 5, Opus 4.8, and Sonnet 5 support persistent `low|medium|high|xhigh` (default `high`); Opus 4.7 supports the same set with default `xhigh`; Sonnet 4.6 supports `low|medium|high` (default `high`); Haiku 4.5 has no persistent effort (`null`). Claude Code documents `max` as session-only, so it is deliberately excluded from this fleet-persistent API.
- Claude admin endpoints:
  - `GET /admin/claude/keys` — list all Claude API keys (engine-filtered). Returns `{status, data: [{id, name, key_prefix, is_active, use_count, last_used_at, expires_at, engine, created_at, updated_at}]}`.
  - `POST /admin/claude/keys` — create a new Claude API key. Body: `{name, expires_at?}`. Returns the full key (shown once) and the record. Keys use the `sk-claude-` prefix.
  - `POST /admin/claude/keys/{id}/toggle` — enable or disable a Claude API key. Body: `{active: bool}`.
  - `DELETE /admin/claude/keys/{id}` — revoke (delete) a Claude API key.
  - `GET /admin/claude/state` / `POST /admin/claude/state` — read/set persisted `claude_api_disabled` flag (toggles Anthropic-compatible API independently). `settings.read` / `settings.manage`.
  - `GET /admin/claude/settings` — get the separate Anthropic-compatible API proxy defaults. Returns `{status, data: {default_model, max_tokens, disabled}}`; this does not control Claude Code's fleet `model` / `effortLevel`.
  - `GET /admin/claude/version` — Claude Code fleet version summary (same shape the Codex version card uses).
  - `POST /admin/claude/version` — set the fleet Claude Code version policy. Body `{ selection: "latest" | "auto" | "<x.y.z>" }`; `latest`/`auto` clear the lock and refresh from upstream.
  - `GET /admin/communicator/api-version` — communicator API level state: `{api_version, min_api, default_min_api, override_min_api, override_updated_at, clients}` with per-host and per-communicator tallies of clients below the minimum, below the current level and at it. Requires `settings.read`.
  - `POST /admin/communicator/api-version` — raise or clear the operator minimum. Body `{ min_api: <1..api_version> | null }`; anything else is a `422`. Requires `settings.manage`; audit-logged as `admin.communicator_min_api`.
  - `GET /admin/claude/config` — Claude `settings.json` builder state (stored sub-blocks plus the baked document).
  - `POST /admin/claude/config/render` — render `{settings}` to the baked `settings.json` without storing it.
  - `POST /admin/claude/config/store` — store `{settings}` (optional `sha256` for compare-and-swap) as the served Claude config.
  - `GET /admin/claude/{kind}` — list Claude artifacts of `kind` (`subagent` | `command` | `output-style`), deleted entries included.
  - `GET /admin/claude/{kind}/{slug}` — one artifact with its frontmatter and body.
  - `POST /admin/claude/{kind}/store` — create/update an artifact; the kind's required frontmatter keys (`name`/`description` for subagents, `description` for commands) are enforced.
  - `DELETE /admin/claude/{kind}/{slug}` — soft-delete an artifact so hosts retrieve `status:deleted`.
  - `POST /admin/claude/settings` — update the separate Anthropic-compatible API proxy defaults. Body: `{default_model?, max_tokens? (256-200000)}`. Gated as authored content (`content.manage`; the GET is `content.read`), not as a fleet setting. Supported models: `claude-fable-5-1`, `claude-fable-5`, `claude-opus-5-5`, `claude-opus-5`, `claude-opus-4-8`, `claude-sonnet-5-5`, `claude-sonnet-5` (default), `claude-opus-4-7`, `claude-sonnet-4-6`, `claude-haiku-4-5-20251001`.
- `GET /admin/quota-mode` / `POST /admin/quota-mode` — read/set `quota_hard_fail`, `limit_percent` (`50..100`), `week_partition` (`off|7|5`).
- `GET /admin/cdx-silent` / `POST /admin/cdx-silent` — read/set wrapper silent mode (`silent` boolean).
- `GET /admin/model-tier-check` / `POST /admin/model-tier-check` — read/set the default-on cross-engine Model Class Check (`enabled` boolean).
- `GET /admin/api-keys-in-chat` / `POST /admin/api-keys-in-chat` — read/set the default-off cross-engine instruction for operator-supplied API keys (`enabled` boolean).
- `GET /admin/agents-generation-mode` / `POST /admin/agents-generation-mode` — read/set the fleet-wide master switch for AGENTS.md/CLAUDE.md generation (`mode`: `managed` default, `manual`, or `off`). Applied at render time only; no position suppresses the mandatory policy block or the managed feature block.
- `GET /admin/auto-update` / `POST /admin/auto-update` — read/set the fleet auto-update flag (`enabled` boolean); per-host overrides win over it.
- `GET /admin/authorization` / `POST /admin/authorization` — read/set the authorization mode (`{mode: "compatible"|"strict"}`). GET also returns `would_deny`: what `strict` would have refused, from this installation's own traffic. Requires `security.manage_authorization`, enforced under both modes.
- `GET /admin/theme` / `POST /admin/theme` — read/set the stored admin UI theme (`auto` default).
- `GET /admin/log-retention` / `POST /admin/log-retention` — retired compatibility endpoint: always returns `{enabled:false,supported:false,reason:"retired_no_worker"}`. Old durations are ignored and no setting is persisted.
- `GET /admin/scaling` / `POST /admin/scaling` — read the scaling status and store the scaling rules; invalid rules return `422 validation_failed` with per-rule errors. Hosts flagged `scaling_exempt` are excluded.
- `GET /admin/reverse-dns` / `POST /admin/reverse-dns` — read/set global reverse DNS enforcement (`enabled` boolean).
- `GET /admin/response-verbosity` / `POST /admin/response-verbosity` — read/set the fleet-wide response-verbosity dial (`level`: `0..4`, `0` default/no-op). Projected into the served AGENTS.md/CLAUDE.md `## Default Response Shape` policy text, and (for `clx` hosts) into a `verbosity-*` Claude output style via `outputStyle` in settings.json.
- `POST /admin/prune-policy` — set inactivity prune days `{inactivity_days:0..60}`.
- Runner: `GET /admin/runner` (config/telemetry/state/timestamps/counts/canonical metadata), `POST /admin/runner/run` (force Codex runner validation), `POST /admin/runner/run-claude` (force Claude runner validation), `POST /admin/runner/run-grok` (read-only Grok subscription verification).
- Logs:
  - `GET /admin/logs?limit=50`
- ChatGPT usage:
  - `GET /admin/chatgpt/usage[?force=1]`
  - `GET /admin/chatgpt/usage/history?days=60[&from=&until=&interval=raw|hour|day&lane=normal|spark|both&window=primary|secondary|both]`
  - `POST /admin/chatgpt/usage/refresh`
- Claude usage (read-only — pushed by hosts via `POST /claude/usage/report`, so there is no refresh endpoint):
  - `GET /admin/claude/usage`
  - `GET /admin/claude/usage/history?days=60[&from=&until=]`
- Skills: `GET /admin/skills`, `GET /admin/skills/{slug}`, `POST /admin/skills/generate`, `POST /admin/skills/assist`, `POST /admin/skills/store`, `DELETE /admin/skills/{slug}`. `POST /admin/skills/assist` is the conversational variant of `generate`: body `{messages[], mode: "new"|"edit", skill?}` (an `edit` mode carries the current skill), and it returns `503 runner_unavailable` without a configured runner and canonical auth. `POST /admin/skills/generate` is an admin-only runner-backed draft helper that fills the skill editor but does not persist anything until `store` is called. Code-managed and source-owned skills are returned with `managed:true`; direct store/delete attempts are rejected.
- `GET /admin/skill-sources/mattpocock` — return the Matt Pocock source state: `{source, repository, ref, enabled, auto_update, status, revision, upstream_version, skill_count, file_count, last_checked_at, last_synced_at, last_error}`. `source` is `github:mattpocock/skills`, `repository` is `https://github.com/mattpocock/skills`, `ref` is `main`, and `status` is `disabled`, `ok`, or `error`. Any authenticated admin role may read it. Inclusion defaults off and causes no outbound traffic while off.
- `POST /admin/skill-sources/mattpocock` — owner/admin only. The non-empty body may contain either or both booleans `{enabled?, auto_update?}` and no other keys; returns the same source state. Fresh source state defaults auto-update on; a preference configured while disabled is preserved when inclusion is enabled. Disabling auto-update pins the last-known-good revision. Disabling inclusion soft-deletes the source-owned skills from served inventory but retains their rows, files, and last-known-good metadata. A later enable validates that complete cached revision and restores it without a GitHub request; a missing, incomplete, or damaged cache instead triggers a fresh import from the immutable upstream SHA.
- `POST /admin/skill-sources/mattpocock/refresh` — owner/admin only; accepts no request body. Force an immediate enabled-source check and return the same source state on success. The normal worker checks enabled sources with auto-update every six hours. Each check resolves `main` to an immutable commit SHA and atomically advances only after the complete allowlisted bundle and MIT notice validate; failure records `last_error`/`last_checked_at` without displacing the last-known-good revision.
- Projects module: `GET /admin/projects/state`, `POST /admin/projects/state`, `GET /admin/projects/feedback`, `GET /admin/projects`, `POST /admin/projects`, `DELETE /admin/projects/{slug}`, `GET /admin/projects/{slug}`, `GET /admin/projects/{slug}/summary` (counts and the about block without the project's contents — what the detail page's header and tiles read, since `GET /admin/projects/{slug}` carries every file body), `POST /admin/projects/{slug}/about`, `POST /admin/projects/{slug}/roster`, `POST /admin/projects/{slug}/archive`, `POST /admin/projects/{slug}/unarchive`, `GET /admin/projects/{slug}/changes`, `GET /admin/projects/{slug}/files/{id}`, `POST /admin/projects/{slug}/feedback/{id}`, plus `POST /admin/projects/{slug}/assist` (runner-backed draft helper; `503 runner_unavailable` without a runner and canonical auth) and the note/todo/file/feedback subroutes mirroring the host `/projects` surface:
  - Notes: `GET /admin/projects/{slug}/notes`, `POST /admin/projects/{slug}/notes`, `POST /admin/projects/{slug}/notes/{id}`, `DELETE /admin/projects/{slug}/notes/{id}`.
  - Todos: `GET /admin/projects/{slug}/todos`, `POST /admin/projects/{slug}/todos`, `POST /admin/projects/{slug}/todos/{id}`, `POST /admin/projects/{slug}/todos/{id}/done`, `POST /admin/projects/{slug}/todos/{id}/undone`, `DELETE /admin/projects/{slug}/todos/{id}`.
  - Files: `GET /admin/projects/{slug}/files`, `POST /admin/projects/{slug}/files`, `DELETE /admin/projects/{slug}/files/{id}`.
  - Feedback: `GET /admin/projects/{slug}/feedback`, `POST /admin/projects/{slug}/feedback`.
- Agents: `GET /admin/agents`, `GET /admin/agents/render?host_id={id}&engine=codex|claude|grok`, `POST /admin/agents/compose`, `POST /admin/agents/render`, `GET /admin/agents/versions/{id}`, `POST /admin/agents/store`, `POST /admin/agents/serve`, `POST /admin/agents/revert`, `POST /admin/agents/retention`, `DELETE /admin/agents/versions/{id}`. Admin views include the nullable `builder_state` and the current module catalog. `compose` validates and renders `{composition}` without persistence; POST `render` combines an unsaved `{composition}` or raw `{content}` with a selected host's live managed policy/features. Both return `provenance` — the document's highlightable blocks in order, so a console can link a setting to the text it produced — and POST `render` additionally returns `axis_sections`, the policy sections each security axis contributes to. Both are preview-only and never reach `/agents/retrieve`. `store` accepts the legacy raw body or a structured composition and always snapshots rendered base Markdown. GET `render` remains the saved-current preview. `revert` takes `{version_id, engine?}` and republishes the body plus builder provenance; `retention` sets `{backup_limit}` (null clears the stored limit).
- Agent policy profiles: `GET /admin/agent-policy-profiles`, `POST /admin/agent-policy-profiles`, `POST /admin/agent-policy-profiles/{id}`, `DELETE /admin/agent-policy-profiles/{id}`, `POST /admin/agent-policy-profiles/{id}/default`, `POST /admin/agent-policy-profiles/assign`, `GET /admin/agent-policy-profiles/enforcement?host_id={id}`. A profile is a named security-level vector, not a document: the canonical prose stays one fleet document so a wording fix reaches every profile, while posture varies per host. Assignment is orthogonal to `agents_document_id_override`, which pins which prose document a host receives. `assign` accepts `profile_id: null` to clear back to the fleet default; the default profile cannot be deleted. `enforcement` is a read-only projection onto engine config naming the axis governing each knob, plus the keys deliberately not enforced.
- MCP memories: `GET /admin/mcp/memories`, `DELETE /admin/mcp/memories/{id}` (numeric record id).
- Shared memories: `GET /admin/shared-memories` (recency listing; `q` switches to relevance search, plus `tags`, `prefix`, `limit`, `offset`), `GET /admin/shared-memories/{slug}`, `DELETE /admin/shared-memories/{slug}`. Fleet-wide, so there is no host filter.
- Memory lifecycle (`{scope}` is `host`, `project`, or `shared`; mutations require the owner or admin role and carry an `ETag`):
  - `GET /admin/memories/graph` — cross-scope memory graph.
  - `GET /admin/memories/audit` — memory audit trail.
  - `GET /admin/memories/{scope}/{recordId}` — one memory record.
  - `POST /admin/memories/{scope}` — create a record; responds `201`.
  - `POST /admin/memories/shared/{recordId}/append` — append to a shared memory; the body accepts `content` and nothing else.
  - `POST /admin/memories/shared/{recordId}/restore` — undo one replace: `{revision, expected_etag}` (or `If-Match`) writes back the body that revision overwrote, as a new revision, keeping title, summary and tags. Only the newest five replaces keep their earlier body (the audit's shared revision rows carry `restorable`); a stale ETag answers 409 `memory_conflict`; audited as `admin.memory.restored`. Requires `memory.write`.
  - `PATCH /admin/memories/{scope}/{recordId}` — update a record; `expected_etag` (or `If-Match`) guards the write.
  - `DELETE /admin/memories/{scope}/{recordId}` — delete a record; `expected_etag` may come from the body, query, or `If-Match`.
- Fleet secrets (working credentials for agents — GitHub tokens, database passwords, service tokens; *not* engine-boot auth, which lives under `/auth`. Every mutation, and the reveal, requires the owner or admin role):
  - `GET /admin/secrets/state` — module switch plus a live secret count.
  - `POST /admin/secrets/state` — `{enabled}` flips `secrets_module_enabled`. While it is off the `secret_*` MCP tools serve nothing; admin CRUD stays available so secrets can be staged before switch-on.
  - `GET /admin/secrets` — metadata listing; `include_deleted=1` includes soft-deleted rows. Never returns values.
  - `GET /admin/secrets/{id}` — one secret's metadata. Never returns the value.
  - `POST /admin/secrets` — create from `{slug, name, value, description?, engine?, tags?}`; responds `201`. `engine` is nullable and null means every engine. Creating against a soft-deleted slug revives and rotates it.
  - `PATCH /admin/secrets/{id}` — update `{name?, value?, description?, engine?, tags?}`. `slug` is immutable, since it is the key agents hold. The response carries `rotated`, true only when the value actually changed.
  - `DELETE /admin/secrets/{id}` — soft delete; takes effect on the next `secret_get` with no wrapper involvement.
  - `POST /admin/secrets/{id}/reveal` — the only endpoint that returns a plaintext value. A `POST` deliberately: a `GET` could be prefetched, cached by an intermediary, or replayed out of browser history.
- Project board (cards as the unit of coordinated work, with claim/lease semantics; reads need `projects.read`, everything else `projects.manage`):
  - `GET /admin/project-board/state` — module switch plus live board, card and held-claim counts. The switch lives here rather than under `/admin/projects/…` because that tree already routes `/admin/projects/{slug}` and a project called `board` would shadow it.
  - `POST /admin/project-board/state` — `{enabled}` flips `project_board_enabled`. While it is off the board's MCP tools are gone except `project_board_list`, which answers disabled status/capabilities so an agent can tell "off" from "empty". `project_todo_*` is deliberately unaffected: since migration 0026 todos are a view of the same cards, and switching a module off has never been a reason for an older API to start failing.
  - `GET /admin/projects/{slug}/board` — the board: its lanes with their WIP limits and role gates, the cards in each, who holds what and until when, and what was recently reclaimed with the reason. Shares its URL with the client route, so a `text/html` Accept serves the SPA instead.
  - `POST /admin/projects/{slug}/board/cards` — create from `{title, detail?, column?, labels?, priority?}`; without `column` it lands in the intake lane. Recorded against the operator rather than a host, because no host created it.
  - `POST /admin/projects/{slug}/board/cards/{id}` — update `{title?, detail?, labels?, priority?, blocked_reason?}` in place. Moves nothing and touches no claim.
  - `POST /admin/projects/{slug}/board/cards/{id}/move` — `{column, note?}`. Never refuses: a role mismatch or an exceeded WIP limit still moves the card and comes back in `advisories`, which are also written to the log.
  - `POST /admin/projects/{slug}/board/cards/{id}/release` — `{reason?}` takes a claim back on the operator's behalf. The escape hatch for a holder that is unreachable but not detectably dead — a wedged process, a sleeping laptop — which neither automatic reclaim signal catches.
  - `DELETE /admin/projects/{slug}/board/cards/{id}` — archive rather than delete, so the card's events keep a row to point at.
  - `POST /admin/projects/{slug}/board/columns/{id}` — reshape one lane: `{title?, wip_limit?, allowed_roles?, position?, default_next_column_id?}`. There is no create or delete; migration 0026 seeds the seven lanes, and deleting one would have to answer what becomes of the cards in it.
- Git Director (registry of which agent is working in which git clone, plus an advisory arbiter over merges into shared branches; forcing a verdict and the module switch require the owner, admin, or fleet role):
  - `GET /admin/git-director/state` — module switch, the model used for contended verdicts, and live clone/worktree counts.
  - `GET /admin/git-director/commit-settings` — fleet-wide `{message_style: "short" | "long", ai_attribution: boolean}`; requires `git_director.read`. Missing or invalid stored values default to short / false without inserting a row.
  - `POST /admin/git-director/commit-settings` — requires `git_director.manage` and both fields, rejects unknown fields/invalid types with 400, persists the pair as JSON in `versions.git_commit_settings`, and records/broadcasts `git_director.commit_settings_updated` with the operator id plus `settings.changed`. Managed Codex/Claude/Grok rules apply independently of Director, MCP and Skills activation; the next sync/launch adopts them. Short means subject-only, long adds change/reason and relevant verification; optional attribution adds one `AI-Assisted-By: Codex|Claude|Grok` trailer after a blank line. Git identities and commit/push authority are unchanged, and explicit operator instructions take precedence. Explicit blank AGENTS generation mode still suppresses guidance.
  - `POST /admin/git-director/state` — `{enabled}` flips `git_director_enabled`. While it is off the `git_*` MCP tools serve disabled status/capabilities and the managed Git Director section is not rendered; existing registrations are retained rather than dropped.
  - `GET /admin/git-director` — every live clone with its worktrees, the current lease and queue per branch, and recent verdicts with the reason each carried. Shares its URL with the client route, so a `text/html` Accept serves the SPA instead.
  - `POST /admin/git-director/requests/{id}/decide` — `{verdict, reason?}` forces `allow` or `deny` on one merge request, recorded as `decided_by: "operator"` so a human's call is never attributed to the model.
  - `POST /admin/git-director/worktrees/{id}/release` — evict a forgotten registration and withdraw everything it was holding, so a branch it was sitting on frees immediately instead of on the lease TTL. For the case the automatic reclaim cannot cover: a registration still technically alive that an operator already knows is finished.
- File transfer (a fleet-wide, TTL'd pool of arbitrary files agents hand each other through the `transfer_*` MCP tools; the switch, its bounds and clearing a file require the owner, admin, or fleet role, while downloading the bytes requires owner or admin). Bytes live under `DATA_ROOT/transfers/`, expiry is swept on every read and by a worker every `TRANSFERS_PURGE_INTERVAL_SECONDS` (default 300), and every change to the pool publishes `transfers.changed`:
  - `GET /admin/transfers/state` — module switch, the TTL band, the per-file and fleet-wide byte caps, plus bytes in use and how many files are live.
  - `POST /admin/transfers/state` — `{enabled}` flips `transfers_module_enabled`. While it is off `transfer_list` serves disabled status/capabilities, the mutating `transfer_*` tools refuse, and the managed AGENTS.md block is not rendered; files already held are retained and keep expiring on schedule.
  - `POST /admin/transfers/limits` — `{default_ttl_seconds?, max_ttl_seconds?, max_file_bytes?, quota_bytes?}`. The max TTL is the ceiling an agent's requested `ttl_seconds` is clamped to; the default seeds the console and is what the guidance recommends. Rejects an incoherent set (a default above the max, a quota below the per-file cap) rather than storing one.
  - `GET /admin/transfers` — every held file with its size, type, uploader, fetch count and deadline. Pass `include_retired=1` to see expired and deleted rows too, which is how an operator answers "what happened to that file". Shares its URL with the client route, so a `text/html` Accept serves the SPA instead.
  - `GET /admin/transfers/{id}/events` — the audit trail for one file: every upload, chunk, fetch and deletion, with who did it. The pool has no addressing, so this record of who actually took a copy is what stands in for access control.
  - `GET /admin/transfers/{id}/content` — the bytes, streamed, with `Content-Disposition` carrying the uploader's name. Its own capability rather than part of the listing, the same line `secrets.reveal` draws: an agent payload may hold anything the fleet was working on, so a fleet operator may empty the pool without reading what was in it. Recorded as an audit fact and deliberately not broadcast — an operator reading a file changes nothing the console shows.
  - `DELETE /admin/transfers/{id}` — retire a file now instead of at its deadline. The bytes go immediately; the row and its trail stay, so the console can still show that the file existed and who fetched it.
- Live agent sessions — the authenticated dashboard session directory and operator chat.
  - `GET /admin/agent-sessions` — every wrapper the fleet can see, with derived `presence` (`working`/`listening`/`idle`/`offline`/`ended`), current turn age, last event, outstanding attention and pending prompt, plus a `work` block carrying the Git Director task, branch and declared paths for the worktree the session's `cwd` sits in and the Agent Messaging address a peer would reach it on. Branch on `presence`, never `status`. The response also carries `enabled`, because an empty list means something different when the Agent Portal module is off: registration is discarded server-side, so no wrapper can appear however many are running.
  - `GET /admin/agent-sessions/{id}/events` — one session's timeline (`after`, `limit`, `tail`). These payloads contain message bodies, so the gate is `agent_portal.reveal_transcript`, not `agent_portal.read`.
  - `GET /admin/agent-sessions/events` — the fleet-wide event stream as SSE, with `Last-Event-ID` resume. Same capability as above.
  - `POST /admin/agent-sessions/{id}/messages` — `{client_message_id, content}` queues an instruction (`202`). Needs a live session and a ready relay, the same rules the portal enforces.
  - `POST /admin/agent-sessions/{id}/prompts/{promptId}/answer` — `{client_message_id, answer, version?}` answers an open prompt (`202`), which also clears the session's attention notice.
  - `POST /admin/agent-sessions/{id}/close` — `{client_message_id, note?}` queues a cooperative close for the agent to honour (`202`).
  - `POST /admin/agent-sessions/{id}/close/force` — `{client_message_id, note?}` ends a session immediately, including one that has gone offline and can no longer accept a cooperative close. A repeat answers `{forced:false, already_ended:true}` rather than erroring.
  - `POST /admin/agent-sessions/{id}/receiver/verify` — the **Reconnect receiver** action. Invalidates the session's receiver generation (fencing delayed claims and heartbeats), records failure `reconnect_requested`, clears native-receiver and relay heartbeats, and returns `{reconnect_requested: true, verification_requested: true}` (the second key is legacy). `409 receiver_missing` when the session has ended or has no receiver. Gate: `agent_portal.manage`, always enforced.
  - All four author as the signed-in admin: `agent_messages` carries a nullable `portal_user_id` and a nullable `admin_user_id`, exactly one set (migration `0027`). That pair is the idempotency identity too, so replaying a `client_message_id` as a different actor conflicts instead of silently succeeding, and delivery re-reads the author so a disabled or deleted account's queued instructions are cancelled rather than delivered.
- Manual: `GET /admin/manual/manifest`, `GET /admin/manual/search?q=`, `GET /admin/manual/article/{slug}` — the admin UI's in-app manual (article set bundled under `STATIC_ROOT`). Unknown slugs return `404`.
- Config builder: `GET /admin/config`, `POST /admin/config/render`, `POST /admin/config/store`.

## Runner & Versions
- The auth-verification worker starts with the API and wakes every `AUTH_RUNNER_VERIFY_WORKER_INTERVAL_SECONDS` (default 300s), re-probing Codex/Claude/Grok canonical auth (Grok through the metadata-only `/verify-grok` probe, never spending its refresh token) on a dynamic schedule between `AUTH_RUNNER_VERIFY_TTL_SECONDS` (default 900s, the minimum) and `AUTH_RUNNER_VERIFY_MAX_INTERVAL_SECONDS` (default 21600s): the interval grows with how long the credential has been proven good, and successful gateway execs count as proof. It also bypasses that TTL when a nominally verified row is not safely distributable because its bytes need current canonical normalization or its fingerprint metadata needs reissue. Live probes update per-engine runner telemetry, so the admin runner card follows the background auth-readiness checks. Wrapper startup reads the stored verdict and does not run runner validation inline.
- Runner state is recorded in `runner_state` / `runner_state_claude` / `runner_state_grok` (`ok|fail`) with timestamps (`runner_last_ok`, `runner_last_fail`, `runner_last_check`, and Claude- and Grok-suffixed equivalents).
- Runner failures do not block `/auth` retrieve. Failed worker/manual runner
  attempts still update runner last-check metadata. Store update candidates are
  blocked unless the runner produces a positive credential verdict. Only a
  recognized authentication rejection normally marks the current head failed.
  A probe that rotates credentials before definitively rejecting them retains
  the replacement as quarantined failed history; a successful probe that
  returns an unusable replacement, loses credential kind/refresh capability,
  or cannot persist the refresh fails the old lineage closed. In every case
  only a still-verified head is distributable.
  Manual `POST /admin/runner/run`, `POST /admin/runner/run-claude`, and
  `POST /admin/runner/run-grok` bypass interval guards.
- Runner endpoint auth is available via `AUTH_RUNNER_SHARED_SECRET` (API) + `RUNNER_SHARED_SECRET` (runner), using header `X-Runner-Auth`.

## Housekeeping & Storage
- Canonical auth payloads live in `auth_payloads` and are engine-scoped (`codex` / `claude` / `grok`), with exactly the selected engine-native target mirrored in `auth_entries`; recent host digests in `host_auth_digests` are retained per host per engine (3 each); `host_auth_states` tracks the last payload served to a host per engine.
- Auth/register/runner events are logged in `logs`.

## Agent sessions

Active Clients and paired Android devices provide operator chat. The legacy `/go`
magic-link webchat and portal-user APIs are removed. Shared `agent_portal.*`
capabilities, the saved switch and wrapper/Android contracts remain unchanged.
Active Clients provides Agent session settings and Remote sessions.

### Host registration and bridge

- `GET /host/agent-portal/state` — host-authenticated master-switch probe.
- `POST /host/agent-sessions` — host-authenticated registration for an eligible interactive or human-started execute session. The wrapper retains the short-lived bridge bearer and gives the engine only a private Unix-socket path/session ID; inherited portal variables are scrubbed.
- `POST /host/agent-sessions/{id}/activity` — bridge-authenticated native activity snapshot with receiver/native/binding generation and sequence fencing. Capability `activity_v1`; evidence expires after 45 seconds. See the native activity section of `interface-api.md`.
- `POST /host/agent-sessions/{id}/heartbeat` — scoped-bearer heartbeat/rolling expiry renewal. `relay_action=poll` opens/touches the instruction relay and `relay_action=close``relay_action=close` closes it and cancels undelivered session work, except a `close`-kind note the agent has already leased: `cxx portal leave` is how an agent acts on a close, so its own leave must not cancel the instruction it is obeying.
- `POST /host/agent-sessions/{id}/events` — scoped-bearer idempotent safe event publish. The server forces `source=engine` and accepts assistant/progress/waiting/terminal-block/attention types plus `message_read` and `message_processing` receipts for the current accepted `payload.message_id`; answerable waits require a stable prompt UUID.
- `POST /host/agent-sessions/{id}/finish` — idempotent, atomic completed/failed event + terminal transition + pending-work cancellation; makes the session read-only.
- `POST /host/agent-sessions/{id}/commands/claim` — strict FIFO long poll with `{wait_seconds?: 0..25, claim_id: UUID}` and a retryable 30-second lease; repeating the same `claim_id` while its lease is live returns the same item without incrementing attempts. Older leases/backoff always block newer work.
- `POST /host/agent-sessions/{id}/receiver/register` — automatic-receiver registration over `X-Agent-Bridge-Token`: strict `{generation: UUID, protocol: "codex-queue-v1"|"claude-channel-v1"|"grok-acp-v1", native_session_id}`. Returns public `receiver` evidence and the enabled `sources`; a live owner cannot be replaced, and a same-generation retry is idempotent.
- `POST /host/agent-sessions/{id}/receiver/heartbeat` — `{generation}` renews native receiver health, which expires after 45 seconds and cannot be revived; reconnect with a new generation.
- `POST /host/agent-sessions/{id}/receiver/stop` — `{generation, failure?}` stops the receiver.
- `POST /host/agent-sessions/{id}/receiver/ack` — deprecated compatibility endpoint for already-delivered legacy probes (`{generation, source, nonce}`); returns status without changing stored evidence or renewing health.
- `POST /host/agent-sessions/{id}/receiver/status` — returns `receiver` (state, generation, native session ID, protocol, last native heartbeat, failure, per-source transport state).
- `POST /host/agent-sessions/{id}/receiver/claim` — strict `{generation, source: "peer"|"portal", claim_id: UUID}` claims an existing queue `delivery` (peer) or `message` (portal), possibly null; the generation is re-checked before any lease.
- `POST /host/agent-commands/{messageId}/ack` — explicit acceptance/retry acknowledgement. `cxx portal wait` does not acknowledge: the model issues `portal accept` only after it has received the structured instruction, so an unaccepted lease is redelivered. Accepted state and the visible `message_accepted` event commit in one transaction.

Admin API:

All mutations below require an `owner` or `admin` role; authenticated viewers
may read state and users but cannot change rollout or identity state.

- `GET /admin/agent-portal/state` — switch, configuration, queue health, and dead-letter counts.
- `POST /admin/agent-portal/state` — toggle the global switch. Turning it off cancels queued/leased operator input without replay and closes relays.

### Conference inspector

The admin conference inspector is read-only. `GET /admin/agent-messaging/conferences`
lists the newest rooms (`status=open|adjourned`, omitted for all; `limit=1..500`,
default 100). Open includes adjourning rooms.
`GET /admin/agent-messaging/conferences/{id}` returns the room and its full roster,
including departed members and dispatch delivery metadata.
`GET /admin/agent-messaging/conferences/{id}/messages` merges the linked member
conversations in chronological dispatch order, including ordinary replies;
`limit=1..100` defaults to 100, with mutually exclusive `before` and `after` cursors.
The response includes `oldest_cursor`, `newest_cursor`, and `has_more`.

`POST /admin/agent-messaging/conferences/{id}/reveal` accepts
`{ "message_ids": ["uuid", ...] }` (1..100), refuses IDs outside the room, and
returns message bodies with no-store headers and an audit event containing IDs
and the actor only. GETs require `agent_messaging.read`; reveal requires
`agent_messaging.reveal_content`. No route joins, claims, acknowledges, sweeps,
or changes conference work. See `docs/interface-api.md` for the full contract.

## Provider accounts and launch reservations

ChatGPT (`codex`), Claude (`claude`), and Grok (`grok`) have independent account pools. Provider identity, or access/refresh credential lineage for opaque credentials, matches validated uploads to an account. A distinct login enrolls an additional account; replacing a known account can explicitly supply `account_id`. Identity conflicts are rejected. Existing runner validation, quarantine, generation/CAS, replay protection and secretbox encryption apply within each account.

- `GET /admin/accounts` — session-gated metadata list: `accounts[]` with `id`, `engine`, `label`, lifecycle state, verification verdict/reason/time, generation, normalized short/weekly quota percentages, reset times, observation time/staleness, and active host sessions. Never returns credential bytes or provider identity fingerprints. The same URL serves the Accounts SPA for HTML navigation.
- `POST /admin/accounts` — `{engine, payload, label?}`; `payload` is auth JSON text or a Claude API key. Live-validates enrollment and returns account ID and verdict metadata.
- `PATCH /admin/accounts/:id` — `{label?, state?: "enabled"|"paused"}`. Paused accounts accept same-account refreshes for existing sessions but receive no new scopes.
- `POST /admin/accounts/:id/credentials` — `{payload}`; validates replacement for the specified engine/account. Known different account identities cannot overwrite it.
- `POST /admin/accounts/:id/verify` — live runner verification; returns verdict metadata only.
- `DELETE /admin/accounts/:id` — stops new assignments immediately (`removing`); after live sessions drain or expire, clears encrypted payload bodies and auth entries and retains an identity tombstone (`removed`).
- `POST /auth/sessions` — host-key/IP/security gated `{engine, scope_id, session_id, account_id?}`. IDs are opaque strings of 16–64 characters; `scope_id` represents the native auth directory. Returns verified `auth`, `account_id`, `account_label`, `session_id`, `expires_at`, `canonical_digest`, `canonical_last_refresh` and existing quota controls. Retries with one session ID are idempotent. An optional account ID supports retaining an already active native child, rather than a user pin.
- `POST /auth/sessions/heartbeat` — `{engine, session_id}` extends a live, host-owned lease by five minutes; expired/foreign sessions are rejected with 404. Wrappers heartbeat every 30 s and answer a 404 (a host that slept past the TTL) by re-reserving the same `session_id` through `POST /auth/sessions` with their `scope_id` and bound `account_id`, discarding the returned auth; a lease landing on another account is released and retried on the next tick. Paused, unverified, or removed accounts refuse the re-reservation.
- `POST /auth/sessions/release` — `{engine, session_id}` idempotently releases that host's reservation and drains pending removal.

Admin mutations require `auth.manage`; listing requires `auth.metadata.read`. All host routes retain the API kill switch, engine membership, host/IP authentication and insecure credential-distribution window. `/auth` and `/sync/bootstrap` accept `account_id` and advertise `account_pool: true`; returned digests, generations, verdicts and quota readings belong to that account. `/claude/usage/report` accepts `account_id` and `session_id`, rejecting a mismatched binding.

Selection runs once per native CLI launch. It prefers verified enabled accounts with lower short/weekly utilization below the configured quota threshold; readings within five percentage points share assignments by active session count, then least recent selection. Unknown/reset accounts get bounded trials to obtain usage. Stale utilization stays conservative until its reset; reset windows become unknown rather than fabricated zero usage. Active sessions retain their account, including overlapping launches sharing native files. If all known quotas are exhausted, existing hard-fail/warn and VIP behavior still governs the selected account. There is no cross-engine fallback or manual host pinning.

## Grok endpoint inventory

- `OPTIONS /grok/v1/*` — CORS preflight, without gateway auth.
- `POST /grok/v1/chat/completions` — Grok subscription chat completion, scoped bearer required.
- `POST /grok/v1/responses` — Grok text response, scoped bearer required.
- `POST /grok/v1/completions` — Grok legacy text completion, scoped bearer required.
- `POST /grok/v1/embeddings` — Unsupported endpoint, explicit non-retriable400.
- `GET /grok/v1/models` — Enabled Grok native model catalog.
- `GET /grok/v1/models/:model` — Retrieve an enabled native model.
- `GET /admin/grok/keys` — List Grok gateway keys without credential bodies.
- `POST /admin/grok/keys` — Issue a scoped sk-cgx- gateway key, returned once.
- `POST /admin/grok/keys/:id/toggle` — Change a Grok gateway key active state.
- `DELETE /admin/grok/keys/:id` — Remove a Grok gateway key.
- `GET /admin/grok/state` — Read the independent Grok API switch.
- `POST /admin/grok/state` — Set the independent Grok API switch.
- `GET /admin/grok/settings` — Read gateway default_model and disabled.
- `POST /admin/grok/settings` — Change gateway default model/switch; unsupported parameters rejected.
- `GET /admin/grok/models` — List native catalog with enabled flags.
- `POST /admin/grok/models/:model/toggle` — Enable/disable a Grok gateway model.
- `GET /admin/grok/config` — Read engine-specific managed config metadata.
- `GET /admin/grok/config/retrieve` — Retrieve engine-specific managed config.
- `POST /admin/grok/config/render` — Preview native TOML config.
- `POST /admin/grok/config/store` — Save managed Grok config.
- `GET /admin/grok/version` — Read Grok CLI version metadata.
- `GET /admin/grok/version/lock` — Read the independent exact CLI pin.
- `POST /admin/grok/version` — Set/clear the independent exact CLI pin.
- `POST /admin/hosts/:id/grok-version` — Set/clear a host-specific Grok CLI pin.
- `POST /admin/runner/run-grok` — Run a read-only subscription verification with no credential bytes returned.

## Android companion

The native Kotlin app uses `/companion/v1` with a separate Bearer device credential;
admin cookies and browser Origins are not accepted there. It is paired from the
signed-in Account → Android devices screen. Each credential belongs to that admin
and receives only their current capabilities, enforced strictly on every request.
Device credentials expire after one year; pairing again creates a new device.

- `GET /admin/companion/devices` — own devices, timestamps and push configuration readiness; requires `account.self_manage`.
- `POST /admin/companion/pairings` — own single-use five-minute QR JSON (`version:1`, HTTPS `server`, random `token`); returns `{qr, expires_at, device_id}` with the UUID reserved for this exact exchange (not a credential), creates an audit entry and replaces outstanding codes for that user. The browser confirms pairing only when that UUID appears in its own devices snapshot, refreshed by existing `companion.devices.changed`/owner events or manual Check status; no polling or inferred scan/connection progress. Migration 0107 stores the nullable reserved UUID; pre-upgrade grants retain random UUID creation on exchange.
- `DELETE /admin/companion/devices/{id}` — revoke an owned device and clear its FCM token; audited, publishes `companion.devices.changed`.
- `POST /companion/v1/pair` — `{token,name}` exchanges a QR token once for `{device_id,token,firebase,capabilities}`; the token is never logged or stored in plaintext.
- `GET /companion/v1/hosts` — `admin.read`; daemon-enabled host cards with `host_id`, `fqdn`, `default_cwd`, ready `engines`, safe `health`, `free_slots` and `startable`. No credential/runtime payloads.
- `GET /companion/v1/quotas` — `admin.read` + `auth.read_metadata`; read-only Codex/Claude/Grok account quota snapshots without provider calls or credentials. See [Android engine quotas](interface-api.md#android-engine-quotas-059).
- `POST /companion/v1/daemon-sessions` — `{host_id,engine,client_message_id,task?,title?,cwd?}`; requires messaging management plus Portal read/manage/transcript permissions. Empty task establishes contact only. Returns 202 `{operation_id,session_id}`; UUID is retained across retries. Rechecks host/engine readiness and capacity under the daemon lock. Owned remote conversations are projected in `/agents` with their logical ID and `daemon_session:true`; existing events/messages/answers/follows routes span or resume their bound Portal launches. Missing transcripts and unknown outcomes never trigger a replacement start.
- `GET /companion/v1/me` — identity, current capabilities, public Firebase configuration, notification preference, and followed session IDs. Also `read_sync_protocol: 1`, `room_notifications_protocol: 1`, `room_delta_protocol: 1` and `actor: "admin:<id>"` (the operator's room actor key; room events with this `actor` are the operator's own).
- `PATCH /companion/v1/device` — optional `fcm_token` (nullable), `notifications` boolean, `visible_session_id` (nullable UUID; a room id while a room is on screen suppresses that room's pushes); updates last-seen time. Visible-session suppression expires after 45 seconds.
- `DELETE /companion/v1/device` — self-revoke on logout.
- `GET /companion/v1/agents` — portal snapshot (`agents`, `generated_at`, `timings`), using `agent_portal.read`. With transcript permission, includes per-agent `preview: {summary,cursor,created_at} | null`: one sentence of at most 160 Unicode characters, prioritizing the open question or attention notice, otherwise the latest reply. Independent `reply_cursor` is the latest `assistant_message` event ID (0 when none), including retained offline/finished conversations; without transcript permission both preview and reply cursor are null. The preview cursor is not a reply-read watermark.
- `POST /companion/v1/agents` — the same snapshot with `{read_cursors:{"session UUID":cursor}}`, at most 500 entries. Cursors accept safe nonnegative integers or decimal strings; malformed/unsafe/oversized maps return 400, unknown session IDs are ignored. With transcript permission, `unread_reply_count` counts only this session's `assistant_message` events after its supplied cursor; omitted markers and GET count from 0, and no replies yield 0. Without transcript permission the count is null. Without `sync_reads:true`, submitted markers remain a device-local overlay and the request stores no receipt. With that opt-in, valid assistant-event markers in the authorized projection advance account-wide watermarks monotonically; stale, unknown, foreign-conversation and future cursors cannot advance them. Every authorized card adds `read_cursor`. Opt-in responses also echo `processed_read_cursors` for bounded outbox acknowledgement (including ignored input); only `read_cursor` is the authoritative shared position. New APKs persist pending receipts and drain all advances in batches of 500, retrying failures on reconnect. Shared receipts are merged with local markers for counts. `/me` advertises `read_sync_protocol:1`; `PATCH /companion/v1/device` can register the same protocol for silent read pushes. Existing native live events refresh other apps; protocol-capable background devices receive a metadata-only `kind:read` push to remove stale reply badges. Migration 0108 adds `companion_reads` and the device protocol column. Global event-ID gaps, other sessions, user messages, progress and questions never increase a reply count.
- `GET /companion/v1/agents/{id}/events` — bounded timeline, `after` cursor and optional `tail=1`; requires `agent_portal.reveal_transcript`.
- `GET /companion/v1/ws` — native Bearer WebSocket for foreground live updates, independently of the admin WebSocket toggle. Sends `hello`, capability-filtered `changed` scopes (`me`, `agents`, `approvals`, `hosts`), and a `ping` every 15 seconds. The app refetches the corresponding REST views and resumes chat from its cursor. Revocation, current permissions and the API kill switch are rechecked; a shared five-second reconciliation catches expired approvals and lost agent readiness. No transcript bodies are broadcast.
- `GET /companion/v1/events` — legacy resumable foreground SSE using `after` and optional `session_id`; retained for older APKs. Rechecks device/account authorization and portal state each page, closes slow readers.
- `POST /companion/v1/agents/{id}/messages` — `{client_message_id,content}`, returns 202 and follows this conversation. Reuses the portal's UUID idempotency and live-receiver checks.
- `POST /companion/v1/agents/{id}/prompts/{promptId}/answer` — `{client_message_id,answer,version?}`, returns 202, preserves first-answer-wins and follows the conversation. Both writes require `agent_portal.manage`.
- `PUT /companion/v1/agents/{id}/follow` — `{followed}` changes reply notifications for this device; requires transcript access.
- `GET /companion/v1/approvals` — current host-access `requests` plus default/max duration, currently 480 minutes; requires `hosts.activate_insecure`. Also returns `active_windows: [{host_id,fqdn,enabled_until,domain_allow}]` for insecure hosts with future deadlines, sorted by FQDN/ID, independently of daemon/engine readiness. `domain_allow` is a matching active domain name or null; a domain grant may reopen a host after individual disable. `fleet_window: {open,enabled_until}` exposes the fleet state, with a null deadline when absent. Dates are UTC ISO strings; secure, closed and expired host windows are excluded. Window changes share the `approvals` WebSocket scope and five-second reconciliation.
- `POST /companion/v1/hosts/{hostId}/insecure/disable` — `hosts.activate_insecure`; no body required. Reuses single-host disable: clears grant/grace, blocks session renewal and returns `{host_id,enabled_until:null}`. Repeated close is safe. Missing host returns 404; an open fleet window returns 409 `insecure_fleet_window_open`. Independent domain grants retain their existing reopening behavior.
- `POST /companion/v1/insecure/window/close` — `hosts.activate_insecure`; no body required. Reuses manual fleet close, clearing all standing host grants and active domain allows, including permanent allows. Returns `{closed,hosts,domains}`; `closed:false` means no stored fleet window was removed or a concurrent reopen won, and clients must refresh. Both close operations audit the authenticated administrator and paired device as `actor:{admin_user_id,device_id}`. Android 0.4.17 confirms the fleet-wide effect before calling this route.
- `POST /companion/v1/approvals/{requestId}/approve` — optional `{duration_minutes}` in 0–480, defaults to 480. Rechecks expiry under the same lock as dashboard decisions; stale/conflicting decisions return 409.
- `POST /companion/v1/approvals/{requestId}/deny` — deny the current pending request; same capability and concurrency rules as approval.

Host access approves the existing insecure-host window; it does not grant agent
tool/command approvals. Finished conversations remain readable under portal
retention. Agent/engine switches and receiver readiness retain their existing
meaning; ordinary chats never wake engines; explicit remote starts and resumptions use the enabled host daemon and retain host assignments.

A durable per-device outbox scans committed portal events and live host requests
every five seconds. It notifies ordinary questions and replies for followed conversations, plus explicit
important/critical/blocker notices for eligible devices regardless of follow state, skips
routine activity, and sends opaque IDs plus the triggering event's short summary
through FCM for agent notifications. Agent payloads also include `event_cursor`
as a decimal string when the exact source event is available; approvals omit it.
Retries retain that event's cursor, enabling devices to ignore duplicate or late
reply pushes at or below their locally persisted read cursor. Snapshots reconcile
missed, suppressed or older pushes; read state stays on each device. Full replies stay in the authenticated app;
missing summaries use a neutral notice. Jobs have unique source
keys, expiring claims, up to eight attempts, and expiry capped at the request's
five-minute deadline or one hour for chat. Delivery is at least once; the app
deduplicates notification IDs. Invalid FCM registrations are removed. Every send
rechecks the device, administrator capabilities and source state. No browser
needs to remain connected. See [Android setup](android-companion.md).

Agent push data also carries `conversation_key` (`agent:<id>`), `agent_id`, `agent_name`, `sender_name`, `engine`, `event_id` and `ts`; a question (`waiting_input`) adds `prompt_id`, `answer_mode` when set, and `options`, a JSON string of at most six `{id,label}` answer buttons (answer with `answer` and `metadata.choice_value` set to the id). Room pushes (`kind:room`) follow the device's per-room mode: `default` for replies to the operator's messages and word-boundary mentions of the operator, `follow` for every message by someone else, `mute` for none; own messages, membership notes, events older than one hour and a room reported visible never notify. Enqueue and send require `agent_messaging.read` and `agent_messaging.reveal_content`. Room push data (strings): `room_id`, `target_id`, `event_id`, `conversation_key` (`room:<id>`), `room_title`, `sender_name`, `engine`, `reason` (`mention`|`reply`|`follow`; `request` reserved), `summary` (neutral text, at most 160 characters; never message content) and `ts`. The cursor is `companion_devices.room_change_cursor` into `agent_room_changes`; pairing starts it at the current head. `/companion/v1/ws` additionally sends ephemeral `{type:"room_activity",room_id,actors:[{address_id,name,state}],ttl_s:8}` frames to `agent_messaging.read` clients while a room member's native agent activity is `working`. They are renewed every four seconds and cleared with `actors:[]`/`ttl_s:0`; the server never persists them.

## Agent Wake / Cron schedules

- `GET /admin/schedules` — paginated definitions (`limit` 1..200, default 100; `after=next_cursor`), without prompts. Requires `agent_messaging.read`; an HTML request serves the SPA.
- `GET /admin/schedules/:id` — definition including prompt and latest 100 executions. Requires `agent_messaging.read`.
- `POST /admin/schedules` — create; requires `agent_messaging.manage`.
- `PATCH /admin/schedules/:id` — partial update with required current `version`; stale versions return `409 schedule_version_conflict`. Requires `agent_messaging.manage`.
- `DELETE /admin/schedules/:id` — soft-delete with JSON `{version}`; cancel queued work, retain accepted work and history. Requires `agent_messaging.manage`.
- `POST /host/agent-sessions/:id/schedule-policy` — bridge-authenticated current-session watchdog policy. Returns nullable `progress_timeout_seconds` and binding generation; requires a current unexpired bridge, eligible host/engine, enabled persistent schedule, active work and no open operator prompt. This never grants remote PID control.

MCP exposes `schedule_list`, `schedule_get`, `schedule_create`, `schedule_update`, `schedule_delete` to authenticated fleet hosts. Every eligible agent may manage all fleet schedules, with actor IDs in audit records. The managed `wake-cron` Skill is shared across Codex, Claude and Grok and ships with the API image.

Create fields: `name`, stable `target=agent:<uuid>`, `prompt` (max 30000 UTF-8 bytes), `kind=once|cron|interval`, exactly one corresponding timing field (`at` future RFC3339, `cron` five fields, `interval_minutes` positive integer), `timezone` (default Europe/Berlin), `enabled` (default true), `persistent` (default false), `progress_timeout_seconds` (60..604800, required only for persistent recovery). PATCH accepts changed fields plus version; switching timing kinds must clear obsolete timing fields. Invalid combinations fail validation.

Ordinary schedules await a live receiver; their messages can never be claimed by a headless relay. Explicit persistent schedules use the per-user cxx-agent worker and exact native-session resume adapters for all three engines; they exist only for agents on persistent hosts, and creating or enabling one for an agent on any other host is refused with 403 `schedule_host_not_persistent` ([host runtime policy](host-runtime-policy.md)). No transcript means blocked, never a fresh-session fallback. Work for an ended agent without a running host worker stays queued until its TTL (24 hours) and then expires. No host power-on is performed. Every interval wakes healthy idle sessions too; one unfinished execution per schedule coalesces downtime and busy intervals into one follow-up. Bus FIFO, process writer locks and binding/lease generations prevent concurrent native writers.

A durable ten-second scheduler serializes through DB locks. Payload and recovery policy are snapshotted per execution. Recovery after ambiguous crash may repeat external effects and is visibly counted. Capacity failures wait at least the configured interval (five minutes for cron/once); recognized structured provider retry/reset hints extend that wait. No implicit engine switch. Spring nonexistent fixed-hour Cron times are skipped; repeated autumn local times run once. Pause/delete cancels queued work and future recovery but leaves accepted work running.

Wrapper 0.9.21 observes native output and Linux process activity. Only the wrapper that created a process may stop it, after an explicit progress timeout and a fresh policy/binding check; TERM precedes KILL by ten seconds. Active child tools count as ongoing work, and a wrapper heartbeat does not count as progress. Idle sessions and open operator prompts are protected. Linux /proc is required for automatic hang termination; other platforms retain crash/capacity recovery without guessing process health. Fleet API/messaging/engine and host gates remain authoritative. The UI shows waiting, queued, leased, accepted, completed, recovering, capacity_wait, blocked and terminal error states; acceptance alone is not successful task completion.

- `POST /admin/agent-messaging/messages/:id/fresh-start` — requires agent_messaging.manage; closed body `{version, reason}`, authorizes one ordinary replacement session after native_transcript_missing. Wakes are rejected; version conflicts return 409; repeated identical approval is idempotent.
- Delivery ACK bodies additionally accept `task_result` only with `outcome: completed`. Session replies accept `claim_id` and `task_result`; relay replies accept `task_result`. Atomic result/reply/transport updates reject stale claims and binding generations. Reveal includes encrypted report history through the existing reveal-content capability.

### German launch-name translation

- `POST /host/agent-messaging/translate` — read-only host-authenticated name/UUID lookup with `{value: string}`; uses host/IP/window policy, the messaging master switch and engine eligibility. Does not register a launch.
- `POST /host/agent-sessions/:id/agent-messaging/translate` — the same lookup using a managed launch's bridge token.
- `POST /host/agent-sessions/:id/agent-messaging/self` — authenticated current launch name, UUID, native binding and task-title metadata; `{}` body and the session bridge token. See [confirmed launch identity](interface-api.md#confirmed-launch-identity-cxx-0937).
- `GET /admin/agent-messaging/translate` — the same lookup with `?value=Claudia`, admin session and `agent_messaging.read`.
- `POST /host/agent-messaging/list` — read-only host-scope inventory of this host's registered agents for operator shells (`cxx agent list` outside a lifecycle); host API key, closed body `{engine?, include_offline?}`, no scope/host/paging. Returns presence, resumability, receiver and per-address live/accepted queue counts. See [host-scope agent inventory](interface-api.md#host-scope-agent-inventory-read-only).

Returns `{name, uuid, address, session_id, status, started_at, ended_at, cooldown_until, direction}`. Names are pre-filled German female names and are reserved per launch until end/expiry plus 24 hours. UUIDs remain canonical; names may be reused. Native resume is a new launch. Direct message/request and conference invitation recipients accept names; committed deliveries and their retries retain the original target UUID. See `docs/interface-api.md` for the full naming contract.

## Watchdog

Current bridge routes use the session token; operator host routes use host auth and Admin routes require messaging capabilities. See `docs/interface-api.md` for payloads, deadlines and recovery contracts.

- `GET /admin/watchdogs`
- `GET /admin/watchdogs/:id`
- `POST /admin/watchdogs`
- `POST /admin/watchdogs/:id/disable`
- `POST /host/watchdogs/get`
- `POST /host/watchdogs/enable`
- `POST /host/watchdogs/disable`
- `GET /host/agent-sessions/:id/watchdog/stream`
- `POST /host/agent-sessions/:id/watchdog/activity`
- `POST /host/agent-sessions/:id/agent-messaging/watchdog/get`
- `POST /host/agent-sessions/:id/agent-messaging/watchdog/enable`
- `POST /host/agent-sessions/:id/agent-messaging/watchdog/disable`
- `POST /host/agent-sessions/:id/agent-messaging/watchdog/finish`

### Remote daemon route inventory

- `GET /admin/host-daemons`
- `GET /admin/hosts/:id/daemon`
- `PUT /admin/hosts/:id/daemon`
- `POST /admin/daemon-sessions`
- `GET /admin/daemon-sessions/:id`
- `POST /admin/daemon-sessions/:id/messages`
- `POST /admin/daemon-sessions/:id/stop`
- `POST /host/daemon/migration` — UUID-scoped fence, status and release for resident-runtime migration.
- `GET /host/daemon/config`
- `GET /host/daemon/connect`
- `POST /host/daemon/migration` — resident-service migration fence/status/release (host-authenticated).
- `POST /host/daemon/peer-finished`

See the optional host execution daemon contract in [interface-api.md](interface-api.md).

- `POST /host/agent-sessions/:sessionId/agent-messaging/spawn`
- `POST /host/agent-sessions/:sessionId/agent-messaging/spawn-status`
- `POST /host/agent-sessions/:sessionId/agent-messaging/stop`

### Fleet Advisor

A server-hosted second opinion served by the stack's hidden `advisor` container. See [interface-api.md](interface-api.md#fleet-advisor).

- `POST /host/agent-sessions/:sessionId/agent-messaging/advisor/ask`
- `POST /host/agent-sessions/:sessionId/agent-messaging/advisor/close`
- `POST /host/agent-sessions/:sessionId/agent-messaging/advisor/status`

## Chatty personal product assistant

Owner/Admin only through always-enforced `chatty.use`; settings require
`chatty.manage`. All endpoints use the current admin cookie and user ownership.
Chat content is encrypted and never broadcast on global admin WS.

| Endpoint | Contract |
| --- | --- |
| `GET /admin/chatty/status` | Visibility, actual provider/engine/model/runner readiness and knowledge digest. |
| `GET /admin/chatty/session` | Current generation, selection, last 100 events, active request; optional before cursor. |
| `PUT /admin/chatty/selection` | engine/model, each nullable; null engine selects automatically. |
| `POST /admin/chatty/messages` | client_message_id UUID, generation, text, optional typed page/entity context; deduplicated durable queue admission. |
| `POST /admin/chatty/runs/:id/answer` | generation and text; resumes the user's pending question. |
| `POST /admin/chatty/runs/:id/cancel` | Stops the user's request; completed changes remain. |
| `POST /admin/chatty/actions/:id/decision` | generation and approve boolean; applies only to the user's current unexpired action. |
| `POST /admin/chatty/proposals/verify` | proposal (opaque action-button token). Read-only re-check for the current admin session and conversation generation; returns `{available:false, reason, detail}` or `{available:true, action, risk, label, title, summary, confirm_label, confirm_text, target, plan, params, expires_at}`. Executes nothing. |
| `DELETE /admin/chatty/session` | Deletes content, cancels work and advances the generation across devices; content-free retry tombstones remain. |
| `GET /admin/chatty/events` | Cookie-authenticated personal SSE change notifications; reconnect fetches the canonical snapshot. |
| `GET /admin/chatty/sources/:id` | Authorized read of a source in the build's private knowledge corpus. |
| `GET /admin/chatty/settings` | Installation settings and limits. |
| `PUT /admin/chatty/settings` | enabled, engine_order (all three once), concurrency (1–2), queue_limit (1–100), steps (2–24), timeout_seconds (30–120). |

409 means stale generation, changed action target, expired decision or conflicting
request. 503 means no usable AI access. Queue admission has no success semantics:
only a committed action receipt proves a mutation. Detailed lifecycle, supported
tools, exclusions and rollout requirements: [Chatty](chatty.md).

- `POST /host/agent-sessions/:sessionId/agent-messaging/insecure-enable` — authenticated secure-host agent opens the target insecure window; `{host_id, duration_minutes?}`. See persistent daemon window contract in interface-api.md.

## Local session housekeeping

- `GET /admin/session-housekeeping` returns effective fleet rules for Codex, Claude and Grok.
- `POST /admin/session-housekeeping/:engine` saves a complete fleet rule (settings.manage).
- `GET /admin/hosts/:id/session-housekeeping` returns effective rules, fleet values, overrides and last reported run (hosts.read).
- `POST /admin/hosts/:id/session-housekeeping/:engine` saves a complete host rule or `{ "inherit": true }` to reset it (hosts.manage).
- `POST /host/session-housekeeping/inspect` returns the current effective policy and protected native IDs.
- `POST /host/session-housekeeping/reserve` reserves this host/engine with a durable UUID journal token and returns a fresh protection snapshot.
- `POST /host/session-housekeeping/release` releases only the matching token.
- `POST /host/session-housekeeping/report` records bounded counts and bytes without transcripts or paths.

Host requests use the host API key, host/IP policy and engine assignment/master switch. Host maintenance does not extend an insecure interactive window. Rules contain `enabled`, `retention_days` (1–3650), `max_bytes` (1 MiB–1 TiB), and `min_age_days` (1–retention_days). Defaults are enabled, 30 days, 5 GiB and 7 days, separately per engine/local user. Overrides replace the entire rule; disabling preserves its durations. API responses identify source (fleet/host) and return fleet and override values.

Wrapper configs carry the effective rule in optional `session_housekeeping`; absence disables automatic housekeeping for older servers. cxx executes locally, at most daily after a successful pass. Age uses the latest native metadata/artifact modification, retaining all files in parent/subagent bundles together. Age-expired sessions are removed first, then oldest eligible bundles until the session-file budget is met. Index/database sizes are excluded from the selection budget but corresponding rows and physical SQLite space are reclaimed.

Pins, incomplete session metadata, open native goals, queued native work, live sessions and the last native transcript of every known fleet address are protected. This includes paused schedules and later peer/Portal continuations. Protected or young sessions can exceed the budget. An active native process skips its engine; unavailable protection or an unsupported schema prevents deletion. Launch/resume guards and server reservations fence removal; a durable journal quarantines files before deleting associated indexes, then unlinks them. Interrupted operations recover using the same token without retrying native work. Unknown data formats are skipped instead of guessed.

### Planned host reboot (cxx 0.9.54)

The bridge exposes `POST /host/agent-sessions/:id/agent-messaging/reboot/prepare`,
`POST /host/agent-sessions/:id/agent-messaging/reboot/arm`,
`POST /host/agent-sessions/:id/agent-messaging/reboot/status`,
`POST /host/agent-sessions/:id/agent-messaging/reboot/restore` and
`POST /host/agent-sessions/:id/agent-messaging/reboot/disarm`.
The boot worker uses host authentication for `POST /host/reboot-handoffs/ready`,
`POST /host/reboot-handoffs/observe`, `POST /host/reboot-handoffs/disarm` and
`POST /host/reboot-handoffs/finish`. See [the protocol](reboot-resume.md) for
request fields, exact native-session binding and one-use execution semantics.
## System Spawn

`GET /admin/host-spawn/state` reads the global switch (off by default).
`POST /admin/host-spawn/state` with `{enabled:boolean}` requires settings.manage.
`POST /host/spawn/setup-complete` accepts the successful installer's authenticated target-host report.
See [System Spawn](interface-api.md#system-spawn-new-system-provisioning) for VIP-only MCP provisioning, installer retries and timed daemon behavior.


## Agent chat: attachments and explicit attention

Existing operator-to-agent chat accepts optional `metadata` with `attachments` (up to ten UUIDs), `reply_to` (a conversation event cursor) and `choice_value` (a stable question choice value). Agent events accept attachments and reply references directly. `waiting_input` supplies `answer_mode: buttons|text|both` plus `choices: [{label,value}]`; legacy `options` remain supported. Buttons send the stable value. The first queued answer wins and exact retries are idempotent.

`severity: important|critical|blocker` plus a stable `notice_id` classifies a message as Needs you. Ordinary questions do not imply urgency. Unresolved notices remain visible for offline/ended sessions and retain their existing conversation context until explicitly resolved. Opening a chat, answering a question or receiving another reply does not resolve these notices. Resolution names one notice. Push deduplicates per notice and severity; repeated identical notices do not create repeated alarms.

Attachment uploads use a caller-generated UUID, declared filename/MIME/size and optional SHA-256. Create, upload base64 chunks of at most 4 MiB at the returned offset, then seal. Exact chunk retries are accepted; different bytes/metadata under an existing ID are rejected. Only sealed attachments from the authenticated author and same conversation may be attached to an event. Defaults: ten files, 100 MiB/file, 250 MiB/message, 15 minutes/media. Limits endpoints report effective file/message limits. Original bytes and names are preserved; downloads require the conversation's existing authorization and support HTTP byte ranges. Pending uploads expire after 24 hours; linked files follow conversation retention.

- `GET /admin/agent-chat/limits` — Effective upload limits (admin session).
- `GET /companion/v1/agent-chat/limits` — Effective upload limits (paired device).
- `POST /admin/agent-sessions/:id/attachments` — Create/resume upload: {id,name,mime_type,size_bytes,sha256?}.
- `POST /admin/agent-sessions/:id/attachments/:attachmentId/chunks` — Upload {offset,content_b64}; returns persisted uploaded_bytes.
- `POST /admin/agent-sessions/:id/attachments/:attachmentId/seal` — Seal completed bytes after SHA-256 verification.
- `GET /admin/agent-sessions/:id/attachments/:attachmentId` — Return name, MIME, size, SHA-256, upload offset and processing status.
- `GET /admin/agent-sessions/:id/attachments/:attachmentId/content` — Stream original or ?variant=transcript.json|frame-NN.jpg; optional inline=1 for safe media.
- `DELETE /admin/agent-sessions/:id/attachments/:attachmentId` — Discard the authenticated author's unlinked upload.
- `POST /admin/agent-sessions/:id/notices/resolve` — Resolve {notice_id,client_event_id} explicitly; admin/device authorization.
- `POST /companion/v1/agents/:id/attachments` — Create/resume upload: {id,name,mime_type,size_bytes,sha256?}.
- `POST /companion/v1/agents/:id/attachments/:attachmentId/chunks` — Upload {offset,content_b64}; returns persisted uploaded_bytes.
- `POST /companion/v1/agents/:id/attachments/:attachmentId/seal` — Seal completed bytes after SHA-256 verification.
- `GET /companion/v1/agents/:id/attachments/:attachmentId` — Return name, MIME, size, SHA-256, upload offset and processing status.
- `GET /companion/v1/agents/:id/attachments/:attachmentId/content` — Stream original or ?variant=transcript.json|frame-NN.jpg; optional inline=1 for safe media.
- `DELETE /companion/v1/agents/:id/attachments/:attachmentId` — Discard the authenticated author's unlinked upload.
- `POST /companion/v1/agents/:id/notices/resolve` — Resolve {notice_id,client_event_id} explicitly; admin/device authorization.
- `POST /host/agent-sessions/:id/attachments` — Create/resume upload: {id,name,mime_type,size_bytes,sha256?}.
- `POST /host/agent-sessions/:id/attachments/:attachmentId/chunks` — Upload {offset,content_b64}; returns persisted uploaded_bytes.
- `POST /host/agent-sessions/:id/attachments/:attachmentId/seal` — Seal completed bytes after SHA-256 verification.
- `POST /host/agent-sessions/:id/attachments/get` — Host bridge chunk download: {attachment_id,variant?,offset?}; base64 bytes, next_offset, done.

Audio and video preparation runs locally in the isolated `media-worker` service with no network. The baked Whisper small model produces timestamped transcript JSON; video also produces up to twenty timestamped JPEG frames. Preparation failure leaves the original downloadable. Host bridge routes require the scoped bridge token, while admin and companion routes enforce transcript/manage capabilities even under compatible authorization.

### Feedback admin endpoints

- `GET /admin/feedback/configuration` — feedback mode, explicit runner engine/model, automatic-publication opt-in, revision and token presence; never token material.
- `POST /admin/feedback/configuration` — `{expected_revision, config:{mode,auto_publish,runner_enabled,engine,model}, token?, disconnect?}`. Revision-checked, audited settings; a supplied classic GitHub PAT is secretbox-encrypted. Existing installations retain `source_developer`; fresh baselines select `user`. Outbound reporting and runner use remain opt-in.
- `POST /admin/feedback/preflight` — `{title,component?}`; reads baked build identity and searches open/closed upstream issues. Does not publish or pass the gate.
- `POST /admin/feedback/:id/recheck` — `{expected_version}` queues a User-mode review of this local report, or reconciliation of an uncertain publication. Old developer reports require this explicit selection before entering the pipeline.
- `GET /admin/feedback/state` — activation state (default off).
- `GET /admin/feedback/summary` — `{open, in_progress, blocked}` counts for the console's top-bar indicator; expired claims are released first, so abandoned work counts as open.
- `POST /admin/feedback/state` — set `{enabled:boolean}`; dynamic agent guidance follows on sync.
- `GET /admin/feedback` — filtered, paginated inbox; HTML navigation serves the SPA.
- `POST /admin/feedback` — idempotent report submission.
- `GET /admin/feedback/:id` — original report, current claim/outcome and history.
- `POST /admin/feedback/:id` — version-checked triage/comment/outcome update.
- `POST /admin/feedback/:id/claim` — acquire/renew/release; administrative force_release requires reason.
- `DELETE /admin/feedback/:id` — permanently delete one closed (resolved/dismissed/duplicate) report with its history and its duplicates; 409 `feedback_not_closed` for open, blocked or claimed reports; audited as `feedback.deleted`.
- `POST /admin/feedback/purge` — bulk-delete closed reports `{statuses, older_than?}` in one transaction; returns `{deleted, events, cascaded_duplicates, by_status, ids}`; audited as `feedback.purged`.

Reads require `feedback.read`; writes require `feedback.manage`. Fields and lifecycle are documented in [MCP.md](MCP.md#orchestrator-feedback-workflow).

### Live topology endpoints

- `GET /admin/topology`: requires `hosts.read`; one snapshot of the live connection tree: the server (root), the communicator sockets connected to this API process, and the live agent sessions. A session's `association.parent_id` names a communicator only with `basis: "session_traffic"`, meaning the API answered a request for that session over that socket within the presence window (`attributed`; older is `stale`). Anything else is `unattributed` and hangs off the server — host, user and engine are never used to guess a parent. Sessions are omitted for a role without `agent_portal.read`.
- `POST /admin/communicators/{id}/disconnect`: requires `agent_portal.manage`; body `{client_message_id (uuid), expect?: {host_id, username}, note?}`. Closes that one communicator socket (close code 4001) and answers `{outcome: "closed"|"requested", reconnect_expected: true, affected: {agent_ids, leases_reported}}`. It does not stop the communicator process: the owner redials within 1-30 s. `404 communicator_not_connected` means it is already gone; `409 communicator_target_changed` means the selection no longer matches. A repeat with the same `client_message_id` replays the first answer. Audited as `communicator.disconnected`.
- `POST /admin/communicators/{id}/terminate`: requires `agent_portal.manage`; same body as disconnect. Asks the communicator owner *process* to stop, addressing the command to the `instance_id` that owner announced, and only for an owner that announced the capability and that identity (`409 communicator_terminate_unsupported` otherwise; `409 communicator_terminate_in_progress` while another stop for the same connection is running, and for 15 s after the owner accepted one, so a second key cannot send a second command to an owner that is draining). Answers what was observed, never what was sent and never a process exit, which the server cannot see: `acknowledged_closed` (the addressed process acknowledged, then its connection closed), `acknowledged` (acknowledged, connection still open when the wait ended), `refused` (declined, or acknowledged by a different process), or `unacknowledged` (nothing answered within 5 s; the connection is left alone). `process.pid` is the owner's own report. A `client_message_id` is reserved before the first await, so concurrent duplicate clicks dispatch once and share the outcome (`replayed: true`); a reserved key is never evicted while its operation is running, whatever else is in flight. Native sessions are not signalled; a surviving client starts a new owner on its next managed call. Audited as `communicator.terminated` (including `owner_instance_id`).

### Communicator transport endpoints

- `GET /host/communicator/connect`: host-key/IP-authenticated WebSocket protocol 1, enabled by the signed communicator capability. Multiplexes existing host routes, MCP and daemon frames with UUID-correlated replies and content invalidations.
- `POST /host/native-control/receipt`: host-key/IP-authenticated native-control result for `control_state_v1`. The body supplies `session_id`, `binding_generation`, `native_instance_id`, `request_id` and `result` (`accepted`, `exited` or `refused`). The current host and exact native binding are revalidated before the receipt commits; duplicate receipts replay safely. A disconnected socket alone never reports process exit.
- `GET /admin/communicators`: requires `hosts.read`; reports the API process's live communicator connections, users, versions, client counts and last sync.

See [CoCo Communicator](communicator.md) for the local socket, reconnect and rollout contract.

### Per-key inference engine

Key creation on `/admin/openai/keys`, `/admin/claude/keys` and `/admin/grok/keys`
accepts optional `backend_engine: "codex"|"claude"|"grok"`. Omission keeps the
endpoint default. Explicit invalid values return 400; disabled engines return
409. Creation and list records include nullable `backend_engine`. Assigned
keys keep their engine when endpoint defaults change; model discovery, fleet
availability and execution use that assignment. Endpoint switches still apply
to every key. See [Exposed API routing](interface-api.md#exposed-api-routing-any-to-any).

## Native session process controls

`POST /host/agent-sessions/{id}/native-control` registers/polls the cxx 0.9.85 process capability and reports stop receipts using the session bridge token. `POST /admin/agent-sessions/{id}/stop` requires `agent_portal.manage` and an expected process/binding identity; `GET /admin/agent-sessions/{id}/stop` requires `agent_portal.read` and returns the durable result. See [Live topology endpoints](interface-api.md#live-topology-endpoints) for complete bodies, statuses and recovery behavior.

## Binary file transfers

Host-authenticated requests require an explicit engine, enabled engine assignment,
managed MCP configuration and the transfer module. See [file-transfers.md](file-transfers.md)
for the full metadata, offset, quota, retry and SHA-256 contracts.

- `POST /host/transfers` — create or repeat an upload by stable UUID and declared size/hash/TTL; returns the transfer and binary request size.
- `GET /host/transfers/{id}` — read metadata and the confirmed upload offset.
- `PUT /host/transfers/{id}/content` — append raw binary bytes at the explicit `offset` query value with `Content-Length`.
- `POST /host/transfers/{id}/complete` — verify size/hash and make the file available; repeatable after a lost response.
- `GET /host/transfers/{id}/content` — stream a live file, with optional open-ended HTTP byte range.


### Agent role endpoints

Contract: [agent-roles.md](agent-roles.md). Module switch `roles_enabled` (default off). Admin reads need `content.read`, writes `content.manage`; every write is audited as `agent_roles.*`.

- `GET /admin/roles/state` — module switch `{enabled}`.
- `POST /admin/roles/state` — set `{enabled:boolean}`; the `roles` Skill and the Agent Roles guidance follow on sync.
- `GET /admin/roles` — roles with current version, policy, holder and open-proposal counts.
- `POST /admin/roles` — create `{slug, display_name, summary, policy?}`; `state` and `proposals` are reserved slugs.
- `GET /admin/roles/:slug` — role, published versions, draft and active holders.
- `PATCH /admin/roles/:slug` — `display_name`, `summary`, `status`, `policy` with `expected_version`.
- `GET /admin/roles/:slug/timeline` — versions and proposals with gates, judge and reviews.
- `GET /admin/roles/:slug/versions/:version` — one version's manifest and text files.
- `PUT /admin/roles/:slug/draft` — save the operator draft `{manifest, files, changelog?}`.
- `DELETE /admin/roles/:slug/draft` — discard the draft.
- `POST /admin/roles/:slug/publish` — publish the draft as the next immutable version; holders get `ROLE-UPDATE/1`.
- `POST /admin/roles/:slug/revert` — `{version, reason}` publishes a new version carrying an earlier one.
- `POST /admin/roles/:slug/versions/:version/withdraw` — `{reason}` blocks new activations of a faulty version.
- `GET /admin/roles/proposals/:id` — proposal with current and proposed bodies and its event trail.
- `POST /admin/roles/proposals/:id/decide` — `{verdict: accept|reject, reason, expected_version}`; reject on an applied proposal vetoes it by reverting.
- `POST /host/agent-sessions/:id/agent-messaging/roles/activate` — `agent_role_activate`; see [agent-roles.md](agent-roles.md).
- `POST /host/agent-sessions/:id/agent-messaging/roles/current` — `agent_role_current`.
- `POST /host/agent-sessions/:id/agent-messaging/roles/release` — `agent_role_release`.
- `POST /host/agent-sessions/:id/agent-messaging/roles/propose` — `agent_role_propose`.
- `POST /host/agent-sessions/:id/agent-messaging/roles/proposals` — `agent_role_proposals`.
- `POST /host/agent-sessions/:id/agent-messaging/roles/review` — `agent_role_review`.

### Scope coordination endpoints

- `POST /host/agent-sessions/:id/agent-messaging/context/get` — see [coordination contract](agent-coordination.md).
- `POST /host/agent-sessions/:id/agent-messaging/context/update` — see [coordination contract](agent-coordination.md).
- `POST /host/agent-sessions/:id/agent-messaging/rooms/list` — see [coordination contract](agent-coordination.md).
- `POST /host/agent-sessions/:id/agent-messaging/rooms/read` — see [coordination contract](agent-coordination.md).
- `POST /host/agent-sessions/:id/agent-messaging/rooms/send` — see [coordination contract](agent-coordination.md).
- `POST /host/agent-sessions/:id/agent-messaging/claims/acquire` — see [coordination contract](agent-coordination.md).
- `POST /host/agent-sessions/:id/agent-messaging/claims/status` — see [coordination contract](agent-coordination.md).
- `POST /host/agent-sessions/:id/agent-messaging/claims/release` — see [coordination contract](agent-coordination.md).
- `GET /admin/agent-messaging/scopes/state` — see [coordination contract](agent-coordination.md).
- `POST /admin/agent-messaging/scopes/state` — see [coordination contract](agent-coordination.md).
- `GET /admin/agent-messaging/scopes` — see [coordination contract](agent-coordination.md).
- `GET /admin/agent-messaging/scopes/:scopeId/members` — see [coordination contract](agent-coordination.md).
- `POST /admin/agent-messaging/scopes/read` — see [coordination contract](agent-coordination.md).
- `POST /admin/agent-messaging/scopes/send` — see [coordination contract](agent-coordination.md).
- `POST /admin/agent-messaging/scopes/resolve` — see [coordination contract](agent-coordination.md).

## Shared conversations

Shared room APIs use existing agent-messaging read/manage/reveal-content capabilities. Content reads and mutations are audited without plaintext.

- `GET /admin/agent-messaging/chats`
- `POST /admin/agent-messaging/chats/read`
- `POST /admin/agent-messaging/chats/seen`
- `POST /admin/agent-messaging/chats/send`
- `POST /admin/agent-messaging/chats/create`
- `POST /admin/agent-messaging/chats/manage`
- `POST /host/agent-sessions/:id/agent-messaging/chats/list`
- `POST /host/agent-sessions/:id/agent-messaging/chats/read`
- `POST /host/agent-sessions/:id/agent-messaging/chats/send`
- `POST /admin/agent-messaging/chats/:roomId/attachments`
- `POST /admin/agent-messaging/chats/:roomId/attachments/:attachmentId/chunks`
- `POST /admin/agent-messaging/chats/:roomId/attachments/:attachmentId/seal`
- `GET /admin/agent-messaging/chats/:roomId/attachments/:attachmentId`
- `GET /admin/agent-messaging/chats/:roomId/attachments/:attachmentId/content`
- `DELETE /admin/agent-messaging/chats/:roomId/attachments/:attachmentId`
- `POST /host/agent-sessions/:id/agent-messaging/chats/:roomId/attachments`
- `POST /host/agent-sessions/:id/agent-messaging/chats/:roomId/attachments/:attachmentId/chunks`
- `POST /host/agent-sessions/:id/agent-messaging/chats/:roomId/attachments/:attachmentId/seal`
- `POST /host/agent-sessions/:id/agent-messaging/chats/:roomId/attachments/get`

Create accepts client_request_id, kind (group/conference), title, description, members (address UUIDs) and duration_minutes (5–360; default 60). Read accepts room_id, optional opaque before cursor and limit (1–100). Send accepts room_id, client_request_id, content, attachments, optional reply_to event UUID, recipients (address UUIDs) or ask_all. Agents may post contributions but cannot request a new answer round. Seen accepts room_id and through (timestamp). Manage accepts room_id, client_request_id, action (invite/remove/close) and address_id for membership changes. Retries retain the exact payload and UUID. Operator conference ownership is an admin identity, not a fabricated native session.

### Model catalog policy

`GET /admin/model-policy/:engine` reads the engine's catalog filtering policy. `PUT /admin/model-policy/:engine` accepts only `{ "latest_only": boolean }`, records the setting and returns the effective policy. Both routes require an admin session; capability enforcement follows the route inventory. Engines are `codex`, `claude` and `grok`.

### Companion shared rooms (Android 0.5.0)

Native device bearer authentication only; cookie credentials and browser-origin
requests are rejected. Existing API-disable and device-revocation gates apply.
All results use the standard envelope and `Cache-Control: no-store`.

- `GET /companion/v1/rooms` — `agent_messaging.read`; `offset` pagination, returning `rooms`, `has_more`, `next_offset` and `enabled`.
- `GET /companion/v1/rooms/candidates` — `agent_messaging.manage`; existing safe address inventory for participant selection.
- `POST /companion/v1/rooms/read` — `agent_messaging.reveal_content`; `{room_id,before?,limit?}` returns `{room,events,next_before,next_after}`; `room` adds the operator's `read_at` and `unread`. With `{room_id,after}` (a previous `next_after`, number or decimal string; exclusive with `before`) it is a delta read returning `{room,resync:false,events,changes:[{seq,kind,ref_id}],next_after,has_more}` — `events` are new events plus parents whose receipts changed — or `{room_id,resync:true,next_after}` when the cursor predates change-log retention (read in full, then continue). Delta reads never move read positions. Reads are audited without message bodies. `room.members[].read_through` is the newest room event time that agent has been shown through `chats/read` (null if never); an agent's own read advances it, an operator's never does.
- `POST /companion/v1/rooms/seen` — `agent_messaging.reveal_content`; `{room_id,through}` advances the existing monotonic operator read timestamp, clamped to server time. `through` is the newest seen event's exact `created_at` (millisecond precision). An advance enqueues a silent `kind:room_read` push (`room_id`, `read_at`, `conversation_key`) to the operator's other devices with `read_sync_protocol:1`.
- `GET /companion/v1/rooms/changes` — `agent_messaging.read`; `?after=<seq>` returns `{enabled,rooms:[{room_id,seq}],next_after,resync,has_more}`: rooms with `agent_room_changes` rows after the cursor and each room's newest sequence.
- `GET /companion/v1/rooms/:roomId/notifications` — `agent_messaging.read`; returns `{room_id,mode}` for this device (`default` when unset). The room must be visible to the operator.
- `PUT /companion/v1/rooms/:roomId/notifications` — `agent_messaging.read`; `{mode:"follow"|"default"|"mute"}` stores this device's room push mode (`default` deletes the row) and returns `{room_id,mode}`.
- `POST /companion/v1/rooms/send` — `agent_messaging.manage` and `agent_messaging.reveal_content`; the shared room send contract (`room_id`, `client_request_id`, `content`, optional attachment IDs, `reply_to`, `recipients` or `ask_all`). Uses the paired operator identity and existing idempotency/delivery semantics.
- `POST /companion/v1/rooms/create` — the same two capabilities; shared group/conference creation contract and stable `client_request_id`.
- `POST /companion/v1/rooms/manage` — the same two capabilities; shared invite/remove/close contract. The server rechecks conference ownership/state and membership.
- `POST /companion/v1/rooms/:roomId/attachments` — both room capabilities; create an upload with `{id,name,mime_type,size_bytes,sha256}`.
- `POST /companion/v1/rooms/:roomId/attachments/:attachmentId/chunks` — both room capabilities; append `{offset,content_b64}` using the existing upload bounds.
- `POST /companion/v1/rooms/:roomId/attachments/:attachmentId/seal` — both room capabilities; finalize the verified upload.
- `GET /companion/v1/rooms/:roomId/attachments/:attachmentId` — reveal-content capability; room-access and unpublished-draft ownership checks precede metadata access.
- `GET /companion/v1/rooms/:roomId/attachments/:attachmentId/content` — same read gates; download with the existing variant and digest contract.
- `DELETE /companion/v1/rooms/:roomId/attachments/:attachmentId` — both room capabilities; discard only the author's eligible draft upload.

The foreground Companion socket adds the `rooms` invalidation scope, delivered
only with `agent_messaging.read`. It never sends room IDs, message bodies or
attachments. Existing clients ignore the additional scope. Android reads the
canonical room history after invalidation; no new database migration or room
push subscription is introduced.

## Workflows and shared runs

See [Workflows](workflows.md) for state transitions, recovery and delivery. All admin endpoints require an authenticated session. Reads require `workflows.read`; definition mutations and state changes require `workflows.manage`; run mutations require `workflows.run`, enforced in both compatible and strict modes. Report access does not grant chat-body access. JSON API namespaces deliberately differ from the SPA route `/admin/workflows`.

- `GET /admin/workflow-definitions/state` — Read module availability.
- `POST /admin/workflow-definitions/state` — Set enabled with a stable client_request_id.
- `GET /admin/workflow-definitions` — List definitions with bounded pagination.
- `POST /admin/workflow-definitions` — Create a validated document and initial immutable version.
- `GET /admin/workflow-definitions/:id` — Read current definition.
- `GET /admin/workflow-definitions/:id/versions` — List immutable versions.
- `GET /admin/workflow-definitions/:id/versions/:version` — Read one pinned document and diff.
- `POST /admin/workflow-definitions/:id/revise` — Publish document using expected_workflow_version.
- `POST /admin/workflow-definitions/:id/archive` — Archive using expected_workflow_version and expected_control_version.
- `POST /admin/workflow-definitions/:id/restore` — Restore archived definition with both expected revisions.
- `POST /admin/workflow-definitions/:id/revert` — Publish the selected version as a new version; requires expected_workflow_version.
- `GET /admin/workflow-runs` — List runs by workflow/status with bounded pagination.
- `POST /admin/workflow-runs` — Prepare a pending run with workflow_id, version (latest or number), title and inputs.
- `GET /admin/workflow-runs/:id` — Read durable state, membership and task summaries.
- `GET /admin/workflow-runs/:id/events` — Read ordered events using the sequence cursor and limit.
- `GET /admin/workflow-runs/:id/report` — Read the live or frozen final report.
- `GET /admin/workflow-runs/:id/tasks/:taskId` — Read task attempts and evidence.
- `POST /admin/workflow-runs/:id/control` — Configure a pending run, pause/resume/block, request cancellation or recover coordinator according to actor authority.
- `POST /admin/workflow-runs/:id/prepare-cancel` — Cancel an untouched preparation; preserves required evaluation state.

Bridge endpoints authenticate `x-agent-bridge-token` and derive address, host, engine and binding from the native session. Every operation except run-current requires a stable `client_request_id`; replay identical bodies after a lost response. Run controls require `expected_run_version`; coordinator writes also check `coordinator_generation`. Task writes use independent `expected_task_version`; claimed writes additionally require `claim_token` and `claim_generation`. Invalid documents fail validation; stale versions/bindings/claims return 409 without silently overwriting another actor. Full executable field schemas live in `api/src/services/workflows/contract.ts` and generate the native tool declarations.

- `POST /host/agent-sessions/:id/agent-messaging/workflows/create` — Create a definition.
- `POST /host/agent-sessions/:id/agent-messaging/workflows/revise` — Publish an instruction revision using compare-and-swap.
- `POST /host/agent-sessions/:id/agent-messaging/workflows/archive` — Archive or restore with instruction and control revisions.
- `POST /host/agent-sessions/:id/agent-messaging/workflows/run-create` — Create and start a pinned run with the caller as coordinator and member.
- `POST /host/agent-sessions/:id/agent-messaging/workflows/run-control` — Start a prepared run or control/renew/transfer/recover coordinator ownership.
- `POST /host/agent-sessions/:id/agent-messaging/workflows/invite` — Invite an active compatible target_address_id, with reason and optional task_ids.
- `POST /host/agent-sessions/:id/agent-messaging/workflows/membership` — Accept/decline/revoke an invitation, leave or remove a participant.
- `POST /host/agent-sessions/:id/agent-messaging/workflows/task-claim` — Acquire, renew, release or reconcile a task claim.
- `POST /host/agent-sessions/:id/agent-messaging/workflows/task-update` — Record an explicit attempt result, retry or justified skip.
- `POST /host/agent-sessions/:id/agent-messaging/workflows/run-note` — Append knowledge, an observation or an improvement suggestion.
- `POST /host/agent-sessions/:id/agent-messaging/workflows/run-finish` — Assess all goal criteria and enter mandatory evaluation.
- `POST /host/agent-sessions/:id/agent-messaging/workflows/run-evaluate` — Save or finalize evaluation; publish a validated improvement atomically.
- `POST /host/agent-sessions/:id/agent-messaging/workflows/run-current` — Recover current membership, invitations and pending evaluations for the authenticated binding; empty body.

Responses include canonical IDs, versions and an authenticated `report_url`; claims alone return the private claim token. Lists and task/event reads are bounded; follow returned pagination metadata. Evidence carries `id`, `description`, `type`, `time` and optional `uri`, `hash`, `execution_host`, `expires_at`; no arbitrary URI is fetched by the server. Definition changes publish `workflow.changed`, run progress publishes `workflow.run.changed`, and module changes publish `workflow.state.changed`; payloads invalidate query caches and do not carry private claim tokens or chat bodies.

## Account quota warnings and reset recovery (cxx 0.9.112)

- `GET /admin/quota-policy/:engine` and `PUT /admin/quota-policy/:engine` read/write engine defaults.
- `GET /admin/accounts/:id/quota-policy` and `PUT /admin/accounts/:id/quota-policy` read/write a complete account override. PUT accepts `{policy: {...}}`; `policy: null` restores inheritance. GET returns `defaults`, nullable `override` and `effective`.
- Policy fields: `unlimited` boolean; `short_warn_percent` and `long_warn_percent` (integer 1–100 or null to disable warnings); `short_auto_resume` and `long_auto_resume` booleans. Defaults: false, 85, 85, true, false respectively. PayG is an explicit account setting, not provider detection. Unlimited bypasses warnings, quota startup blocks and quota-triggered resume; provider billing remains separately configured.
- `POST /host/agent-sessions/:id/agent-messaging/quota/get` accepts `{}` and the session bridge token. The `cxx-agent` MCP tool `quota_get` uses this route without an account parameter. Account identity comes from `provider_session_id` supplied at lifecycle registration, validated against the authenticated host/engine's live provider lease. Older unbound sessions report `account_binding_unknown`.
- Readings include account, engine, policy, status, short/long windows with percentage, actual duration, source, observation timestamp and reset. Missing is not zero; readings older than ten minutes or past reset are stale. Codex/Grok refreshes retain existing throttles; Claude reads only native statusline reports. Grok can report weekly or monthly usage and has no fabricated short window.
- Fresh threshold crossings notify active sessions of the same account once per session/window/reset/severity. QUOTA/1 notices are informational, bound to the current lifecycle, and never wake an offline session.
- A native capacity failure plus a fresh exhausted quota window arms reset recovery when enabled. Overload alone and usage without a failed turn cannot arm it. A known long blocker takes precedence. Unknown scope is left for the operator.
- Recovery reuses the Watchdog schedule and native-session executor. It waits at least 60 seconds beyond all known blocking resets, rechecks effective policy and attempts, and stops on task completion, cancel, manual stop, changed native binding or missing transcript. PayG or a disabled policy cancels queued quota recovery. Initial attempt plus at most three retries (5, 15, 30 minutes when no newer reset exists); only persistent hosts start automatically. Stale post-reset readings permit a bounded probe. No replacement session or independent replacement subagent is created.
- `agent_watchdogs` exposes nullable `quota` metadata (account, window, reset, attempts and last attempt). Engine defaults live in Engines, account overrides in Accounts, and recovery state in the existing Watchdog panel. Warning thresholds do not force a pause. Managed instructions require quota_get before heavy work/delegation.

## Feedback sweep additions (2026-10-24)

- `POST /host/agent-sessions/:id/agent-messaging/git/remote` — bridge-authenticated `agent_git_remote`: `{target_host_id, claim_id, common_dir, branch, operation, args}`. Operations are `register|join|list|merge_request|merge_status|release`; `args.worktree_path` is required. Canonical absolute paths, the active originating binding and its remote path/branch claim are checked. `args.target_branch` must equal `branch`. Registration preserves the origin agent/session/generation; later operations cannot use a foreign registration or request. It records coordination only; the agent runs SSH and Git. Cross-host merge grants recheck live claim coverage after judging even if new coordination is disabled.
- MCP domain failures retain `isError:true`, JSON text `{error:{message,code,type,...safe_details}}` and matching `structuredContent`. Unknown exceptions retain their plain message; no stack or credential is added.
- `git_release` accepts `correction_id` (stable UUID) and `correction_reason` with a completed merged request and replacement full `target_head_sha`. This appends `git_director.outcome_correction` to the audit; the original report and ended lease remain unchanged. Corrections cannot deregister or release other work.
- `api_disabled` is admitted globally before authentication and handler work. Only the actual `/admin/api/state` route is exempt, including its supported trailing slash; SPA lookalikes remain disabled.
- `/auth` selects alternative quota advice from an enabled verified account of the correct engine (most recently selected first). Current-engine telemetry stays bound to its requested account; disabled/unlimited advice skips alternative history reads. No provider refresh or account lease is acquired for advice.

## Server retention

- `GET /admin/server-retention` — effective server-history policy, revision and bounded cleanup status.
- `POST /admin/server-retention` — save validated policy with expected revision (`settings.manage`).
- `POST /admin/server-retention/preview` — read-only saved-policy eligibility observation (`settings.read`).
- `POST /admin/server-retention/run` — request an idempotent guarded cleanup using a client UUID and expected revision.
- `GET /admin/server-retention/runs/:id` — current retained run status, or 404 after replacement.

Defaults: audit 14 days, inactive history 24 hours, optional quota history seven
days. Open work and necessary baselines stay protected. External command results
expire to compact duplicate-execution fences after 14 days. Explicit internal
receipts expire after seven days when unreferenced. See interface-api.md for
activation, compatibility, protection and no-backup offline maintenance.

## Fleet task supervisor

- `GET /admin/agent-supervisor` — read configured/effective state, work states, outstanding dependencies and incident budgets; optional `target=agent:UUID`. Requires `agent_messaging.read`.
- `POST /admin/agent-supervisor/state` — set `{enabled:boolean}`. Requires `agent_messaging.manage`; disabling stops supervisor-owned future recovery.
- `POST /admin/agent-supervisor/pause` — pause `{target,version}` with an optimistic work-state version. Requires `agent_messaging.manage`.
- `POST /host/agent-sessions/{id}/agent-messaging/work-state` — current bridge only: `{}` reads state; `{state,task_key?,message_id?,reason?,waiting_for?,coordinator?,version?}` reports current work (`task_key` or `message_id` required; the key derives as `message:<id>` when omitted). See [the supervisor contract](agent-supervisor.md).
