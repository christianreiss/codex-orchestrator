# Codex API -- Design Document

Pure-PHP, zero-dependency REST API that exposes both an **OpenAI-compatible** interface
(`/v1/chat/completions`, `/v1/completions`, `/v1/embeddings`, `/v1/models`) and an
**Anthropic-compatible** interface (`/anthropic/v1/messages`, `/anthropic/v1/completions`,
`/anthropic/v1/models`, `/anthropic/v1/responses`, `/anthropic/v1/embeddings`), delegating
actual inference to pluggable **backend adapters**. Any OpenAI or Anthropic SDK client can
point at this server and work without code changes.

---

## 1. File Tree

```
codex-api/
  public/
    index.php                  # Entry point (autoloader + bootstrap)
  src/
    Router.php                 # Request dispatcher (auth, validation, routing)
    Contracts/
      BackendAdapter.php       # Interface: the methods every backend must implement
    Adapters/
      NullBackendAdapter.php   # Stub adapter (returns placeholder text, zero tokens)
      CdxBackendAdapter.php    # OpenAI adapter: shells out to local `cdx` binary
      ClaudeBackendAdapter.php # Anthropic adapter: delegates to runner with engine:"claude"
    Http/
      Request.php              # Parses $_SERVER, headers, JSON body
      JsonResponse.php         # Static helpers: send(), sendError(), stream()
      AnthropicCompat.php      # Message normalization & format conversion for Anthropic API
      AnthropicResponse.php    # Anthropic-format JSON/SSE/error response helpers
    Controllers/
      ClaudeApiController.php  # Routes for /anthropic/v1/* endpoints
      AdminClaudeKeyController.php  # Admin Claude API key CRUD
    Services/
      ClaudeModelService.php   # Model allowlist, legacy upgrades, default resolution
      ClaudeUsageService.php   # Token usage aggregation and dashboard summary
    Support/
      Engine.php               # Engine enum (codex/claude) with per-engine config maps
```

No Composer, no vendor directory, no external packages.

---

## 2. Bootstrap (`public/index.php`)

1. Registers a custom autoloader: namespace prefix `App\` maps to `src/`.
   - `App\Http\Request` -> `src/Http/Request.php`, etc.
2. Instantiates `Request`, `CdxBackendAdapter`, and `Router(backend)`.
3. Calls `$router->dispatch($request)` inside a top-level `try/catch`.
4. Any uncaught `\Throwable` returns a generic 500:
   ```json
   {"error":{"message":"An internal server error occurred.","type":"internal_server_error"}}
   ```

To swap backends, change the single `new CdxBackendAdapter()` line.

Run with: `php -S 0.0.0.0:8080 -t public`

---

## 3. Request Lifecycle

```
Client request
  |
  v
index.php  -->  Router::dispatch(Request)
                  |
                  +-- OPTIONS?  -->  204 + CORS headers, done
                  |
                  +-- Auth check (Bearer token in Authorization header)
                  |     fail -->  401  {"error":{"code":"invalid_api_key",...}}
                  |
                  +-- JSON validation (Content-Type + parse)
                  |     fail -->  400  invalid_request_error
                  |
                  +-- Route match:
                  |     POST /v1/chat/completions  -->  backend->chatCompletions()
                  |     POST /v1/completions       -->  backend->completions()
                  |     POST /v1/embeddings        -->  backend->embeddings()
                  |     GET  /v1/models            -->  backend->models()
                  |     *                           -->  404
                  |
                  +-- If request has "stream": true, wrap response in SSE
                  |     via JsonResponse::stream()
                  |   Otherwise:
                  |     JsonResponse::send()
```

---

## 4. HTTP Layer

### 4a. `Request` (src/Http/Request.php)

Constructed once from PHP superglobals. Immutable after construction.

| Method | Returns | Notes |
|---|---|---|
| `method()` | `string` | Uppercase, defaults `'GET'` |
| `path()` | `string` | Parsed from `REQUEST_URI`, trailing slash stripped, defaults `'/'` |
| `header(key, default)` | `mixed` | Case-insensitive lookup |
| `json(key?, default?)` | `mixed` | Key into parsed body; omit key to get full array |
| `jsonError()` | `bool` | `true` if body was present + JSON-typed but failed `json_decode` |
| `contentType()` | `?string` | Raw Content-Type value |
| `rawBody()` | `string` | Unparsed body from `php://input` |

**Header parsing:** iterates `$_SERVER`; keys starting with `HTTP_` are converted
(`HTTP_AUTHORIZATION` -> `AUTHORIZATION`; underscores become dashes). `CONTENT_TYPE`
and `CONTENT_LENGTH` are extracted separately (PHP doesn't prefix those with `HTTP_`).

**Body parsing:** only attempts `json_decode` when Content-Type is `application/json`
(or any `+json` suffix). Otherwise body array stays empty and `jsonError` stays false,
leaving it to the Router to reject the content type.

### 4b. `JsonResponse` (src/Http/JsonResponse.php)

All methods are **static**. Every response gets CORS headers first.

| Method | Behavior |
|---|---|
| `send(array, status=200)` | Sets `Content-Type: application/json`, echoes `json_encode` with `JSON_UNESCAPED_SLASHES \| JSON_UNESCAPED_UNICODE` |
| `sendError(message, type, status, param?, code?)` | Builds `{"error":{...}}` envelope, calls `send()`. `param` and `code` are omitted from payload when null. |
| `stream(array)` | Sets `Content-Type: text/event-stream`, `Cache-Control: no-cache`, `Connection: keep-alive`. Writes one SSE frame `data: <json>\n\n`, flushes, writes `data: [DONE]\n\n`, flushes again. |

**CORS headers** (on every response including errors):
```
Access-Control-Allow-Origin: *
Access-Control-Allow-Headers: Content-Type, Authorization, OpenAI-Organization
Access-Control-Allow-Methods: GET, POST, OPTIONS
```

---

## 5. Router (src/Router.php)

Constructor takes a `BackendAdapter`. Single public method: `dispatch(Request)`.

### Auth
Extracts `Authorization` header, regex-matches `/^Bearer\s+(.+)/i`. Accepts
**any** non-empty token (no secret validation). Returns 401 on failure:
```json
{"error":{"message":"Incorrect API key provided","type":"authentication_error","code":"invalid_api_key"}}
```

### JSON Validation
Two checks, in order:
1. If body is non-empty and Content-Type is not JSON -> 400 (`param: "Content-Type"`).
2. If `Request::jsonError()` is true -> 400 (`code: "invalid_json"`).

Content-Type is considered JSON if the media type (before `;`) equals
`application/json` or ends with `+json` (case-insensitive).

### Route Table

| Method | Path | Handler | Streaming? |
|---|---|---|---|
| `OPTIONS` | `*` | 204 empty | No |
| `POST` | `/v1/chat/completions` | `backend->chatCompletions(req)` | Yes, if `stream: true` |
| `POST` | `/v1/completions` | `backend->completions(req)` | Yes, if `stream: true` |
| `POST` | `/v1/embeddings` | `backend->embeddings(req)` | No |
| `GET` | `/v1/models` | `backend->models()` | No |
| `*` | `*` | 404 | No |

---

## 6. Backend Adapter Contract (src/Contracts/BackendAdapter.php)

```php
interface BackendAdapter
{
    public function chatCompletions(Request $request): array;
    public function completions(Request $request): array;
    public function embeddings(Request $request): array;
    public function models(): array;
}
```

Every method returns an associative array that is JSON-encoded verbatim as the
HTTP response body. The array **must** conform to the OpenAI response schemas
described below. The Router does not transform or validate the returned array.

---

## 7. Response Schemas (OpenAI-compatible)

### 7a. Chat Completion (`/v1/chat/completions`)

**Request body:**
```json
{
  "model": "string",
  "messages": [{"role": "user|assistant|system", "content": "string"}, ...],
  "stream": false
}
```

**Response:**
```json
{
  "id": "chatcmpl-<unique>",
  "object": "chat.completion",
  "created": 1234567890,
  "model": "string",
  "choices": [{
    "index": 0,
    "message": {"role": "assistant", "content": "string"},
    "finish_reason": "stop"
  }],
  "usage": {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0}
}
```

### 7b. Text Completion (`/v1/completions`)

**Request body:**
```json
{
  "model": "string",
  "prompt": "string",
  "stream": false
}
```

**Response:**
```json
{
  "id": "cmpl-<unique>",
  "object": "text_completion",
  "created": 1234567890,
  "model": "string",
  "choices": [{
    "text": "string",
    "index": 0,
    "logprobs": null,
    "finish_reason": "stop"
  }],
  "usage": {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0}
}
```

### 7c. Embeddings (`/v1/embeddings`)

**Request body:**
```json
{
  "model": "string",
  "input": "string" | ["string", ...]
}
```

**Response:**
```json
{
  "object": "list",
  "data": [{"object": "embedding", "index": 0, "embedding": [0.1, ...]}, ...],
  "model": "string",
  "usage": {"prompt_tokens": 0, "total_tokens": 0}
}
```

### 7d. Models (`/v1/models`)

**Response:**
```json
{
  "object": "list",
  "data": [{"id": "string", "object": "model", "created": 1234567890, "owned_by": "string"}, ...]
}
```

### 7e. Error Envelope (all error responses)

```json
{
  "error": {
    "message": "string",
    "type": "string",
    "param": "string|null (omitted when null)",
    "code": "string|null (omitted when null)"
  }
}
```

---

## 8. Adapter Implementations

### 8a. `NullBackendAdapter`

Returns hardcoded placeholder data for every endpoint. Chat and completion
responses contain `"Backend adapter not implemented yet."`. Embeddings returns
empty vectors. Models returns a single `placeholder-model` owned by `"you"`.
Useful for testing the HTTP/routing layer in isolation.

### 8b. `CdxBackendAdapter`

The production adapter. Shells out to a local **`cdx`** binary (default path
`/usr/local/bin/cdx`, overridable via constructor).

**Chat completions flow:**
1. Extract `messages` array from request body.
2. Flatten to plain text: each message becomes `"role: content"`, joined by `\n`.
3. Pass flattened string to `runPrompt()`.
4. Wrap stdout in OpenAI chat completion schema. Model is always `"cdx-lm-1"`.

**Text completions flow:**
1. Extract `prompt` string from request body.
2. Pass directly to `runPrompt()`.
3. Wrap stdout in OpenAI text completion schema.

**Embeddings:** Returns an error response (`"not_implemented"` type). Not supported.

**Models:** Returns single model `cdx-lm-1` owned by `"local"`.

**`runPrompt(prompt)` -- process execution:**
1. Empty prompt -> return empty string immediately.
2. Escape: `escapeshellarg(prompt)` for the argument, `escapeshellcmd(binary)` for the command.
3. Full command: `<binary> --execute <escaped_prompt>`
4. Execute via `proc_open()` with three pipes (stdin, stdout, stderr).
5. Close stdin immediately (not used).
6. Read stdout and stderr to completion.
7. Close pipes, then `proc_close()` to get exit code.
8. Exit 0 -> return trimmed stdout.
9. Non-zero exit -> return trimmed stderr (so the error message surfaces to the client as the completion text).
10. If `proc_open` fails entirely -> return empty string.

**Token counts:** Always zero. Not implemented.

### 8c. `ClaudeBackendAdapter`

The Anthropic/Claude production adapter. Implements `BackendAdapter` and delegates
inference to the shared runner with `engine: "claude"`, returning responses in
Anthropic message format.

**Constructor:** `($runnerExecUrl, $sharedSecret, $authService, $modelService, $timeout)`

Uses the same runner `/exec` endpoint as the OpenAI adapter but sends
`engine: "claude"` in the runner payload so the runner invokes `claude` (Claude Code CLI)
instead of `codex`.

**Messages flow (`messages()`):**
1. Call `buildPromptPayload($messages)` to flatten the message array into a
   prompt string and extract image attachments.
2. Pass prompt + images + extra params to `runPrompt()`.
3. Extract usage via `extractUsage($result)`.
4. Wrap in Anthropic message format:
   ```json
   {"id":"msg_<hex>","type":"message","role":"assistant",
    "content":[{"type":"text","text":"..."}],
    "model":"...","stop_reason":"end_turn","stop_sequence":null,
    "usage":{...}}
   ```

**Chat completions flow (`chatCompletions()`):** Same runner call, but wraps
the result in OpenAI `chat.completion` format with `prompt_tokens`/`completion_tokens`.

**Text completions flow (`completions()`):** Wraps runner output in OpenAI
`text_completion` format.

**Embeddings:** Returns `not_implemented` error. Anthropic has no embedding endpoint.

**Models:** Iterates `$modelService->supportedModels()` and returns each as
`{id, object:"model", created, owned_by:"anthropic"}`.

**`runPrompt()` -- runner HTTP call:**
1. Empty prompt -> return immediately with status `ok` and empty output.
2. Fetch canonical auth snapshot from `$authService`.
3. Build JSON payload: `auth_json`, `prompt`, `images`, `model`, `engine: "claude"`,
   `timeout_seconds`, plus any optional params (`max_tokens`, `temperature`,
   `top_p`, `top_k`, `stop_sequences`, `system`).
4. POST to runner `/exec` via `file_get_contents()` with `X-Runner-Auth` header.
5. Decode JSON response; `status: "ok"` returns the result array.
6. Non-OK status throws `RuntimeException` with the error message.

**Image handling in `buildPromptPayload()`:**
- Iterates messages, renders each content part.
- Anthropic-native images (`type: "image"` with `source.type: "base64"` or `"url"`)
  are extracted as `{url: "..."}` entries.
- Text is flattened as `"role: content"` lines joined by `\n`.

**Token counts:** Returned by the runner as `input_tokens`, `output_tokens`,
`cache_creation_input_tokens`, `cache_read_input_tokens`. All extracted in
`extractUsage()`.

---

### 8d. Message Normalization (`AnthropicCompat`)

`src/Http/AnthropicCompat.php` is a static utility class that normalizes
Anthropic-format requests and builds Anthropic-format responses.

#### `normalizeChatMessages()`

Normalizes a raw `messages` array for the Messages endpoint:
1. Iterates each message entry.
2. Normalizes roles: `system`/`developer` -> `system`, `assistant` -> `assistant`,
   everything else -> `user`.
3. Normalizes content: strings are trimmed; arrays are processed part-by-part.
4. Content parts are normalized:
   - `text`, `input_text`, `output_text` -> `{type:"text", text:"..."}`.
   - `image` with `source.type:"base64"` or `source.type:"url"` -> kept as-is.
   - OpenAI `image_url`/`input_image` -> converted to Anthropic `image` format
     (data URLs become `base64` source; HTTP URLs become `url` source).
5. Single text-only content blocks are collapsed to a plain string.
6. Returns normalized array or `null` when empty.

#### `extractSystemMessages()`

Splits a normalized message array into system and conversation parts:
- Messages with role `system` or `developer` are extracted; their text content
  is concatenated with `\n\n` separators.
- Returns `{system: ?string, messages: [...]}` where `messages` contains only
  `user`/`assistant` entries.

#### `normalizeResponsesInput()`

Normalizes Responses API `input` parameter (string, content-part array, or
message-style array) into a standard messages array. Optional `instructions`
are prepended as a system message.

#### `responseFromMessage()`

Converts an Anthropic message result into OpenAI Responses API format:
`{id:"resp_...", object:"response", output:[{type:"message",...}], usage:{...}}`.

#### `messageStreamEvents()`

Builds the 6-event SSE sequence from a completed message result:
1. `message_start` -- message envelope with model/role/usage.
2. `content_block_start` -- index 0, type `text`.
3. `content_block_delta` -- `text_delta` with the full response text.
4. `content_block_stop` -- index 0.
5. `message_delta` -- `stop_reason: "end_turn"`, output token count.
6. `message_stop` -- terminal event.

Currently the entire response is emitted in a single `content_block_delta`
event (the runner does not stream incrementally).

---

### 8e. Anthropic Response Layer (`AnthropicResponse`)

`src/Http/AnthropicResponse.php` provides static helpers analogous to
`JsonResponse` but using the Anthropic error envelope and CORS headers.

| Method | Behavior |
|---|---|
| `json(array, status)` | JSON response with Anthropic CORS headers. Calls `exit`. |
| `error(message, type, status, code?)` | Wraps in `{type:"error", error:{type, message, code?}}`. |
| `streamEvents(events[])` | SSE with `event:` + `data:` per event. No `[DONE]` sentinel. |
| `options()` | 204 with CORS headers (preflight). |

CORS headers include `x-api-key` and `anthropic-version` in
`Access-Control-Allow-Headers`.

---

### 8f. Claude Model Service

`src/Services/ClaudeModelService.php` manages the Claude model allowlist.

- **Supported models:** `claude-opus-4-6`, `claude-sonnet-4-6`, `claude-haiku-4-5`.
- **Default model:** resolved from admin config (`claude_model` setting),
  then `claude_default_model` version key, falling back to `claude-sonnet-4-6`.
- **Legacy model upgrades:** 9 legacy model names (e.g. `claude-3-opus-20240229`,
  `claude-sonnet-4-20250514`) are silently mapped to current equivalents.
- **`resolveRequestedModel()`:** validates the requested model against the
  allowlist and legacy map; throws `InvalidArgumentException` for unknown models.

---

### 8g. Claude Usage Tracking (`ClaudeUsageService`)

`src/Services/ClaudeUsageService.php` tracks Anthropic/Claude API token usage and quota metadata for dashboard summaries.

**`aggregateRecentUsage(period)`:** Queries `token_usages` table where `engine = "claude"` for the given window (`24h`, `7d`, or `30d`), grouped by model. Returns per-model token counts.

**`dashboardSummary()`:** Aggregates all three time windows and returns `{usage_24h, usage_7d, usage_30d}`.

---

## 9. Streaming (SSE)

When the request body contains `"stream": true`, the Router calls
`JsonResponse::stream()` instead of `JsonResponse::send()`. The backend
adapter returns the **same** array payload regardless; the Router decides
the transport.

Current streaming is **simplified**: the entire completion is computed first,
then emitted as a single SSE `data:` frame followed by `data: [DONE]`. There
is no incremental token-by-token streaming. A true streaming implementation
would require the adapter to yield chunks via a generator or callback.

SSE wire format:
```
data: {"id":"chatcmpl-...","choices":[...],...}\n\n
data: [DONE]\n\n
```

---

## 10. Security Notes

| Area | Status |
|---|---|
| Auth | Bearer token required but **any non-empty value** is accepted. No secret validation. |
| Shell injection | Mitigated via `escapeshellarg()` + `escapeshellcmd()`. |
| CORS | Wide open (`*`). Fine for local dev; restrict in production. |
| Input validation | Minimal. Body must be valid JSON with correct Content-Type. No schema validation of fields. |
| Error leakage | `cdx` stderr is returned as completion content on failure. |

---

## 11. Adding a New Backend

1. Create `src/Adapters/MyAdapter.php` implementing `BackendAdapter`.
2. Implement all four methods, returning arrays matching the schemas in Section 7.
3. In `public/index.php`, replace `new CdxBackendAdapter()` with `new MyAdapter()`.

No other files need to change.

---

## 12. Adding a New Endpoint

1. Add a route branch in `Router::dispatch()`:
   ```php
   if ($method === 'POST' && $path === '/v1/fine_tuning/jobs') {
       JsonResponse::send($this->backend->fineTuning($request));
       return;
   }
   ```
2. Add the method signature to the `BackendAdapter` interface.
3. Implement the method in every adapter class.

---

## 13. Requirements

- **PHP 8.1+** (uses `str_ends_with()`, typed properties, union type hints)
- **`cdx` binary** at `/usr/local/bin/cdx` (only for `CdxBackendAdapter`)
- No Composer, no extensions beyond defaults
