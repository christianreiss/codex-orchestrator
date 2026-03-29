# Codex API -- Design Document

Pure-PHP, zero-dependency REST API that exposes an **OpenAI-compatible** interface
(`/v1/chat/completions`, `/v1/completions`, `/v1/embeddings`, `/v1/models`) and
delegates actual inference to a pluggable **backend adapter**. Any OpenAI SDK
client can point at this server and work without code changes.

---

## 1. File Tree

```
codex-api/
  public/
    index.php               # Entry point (autoloader + bootstrap)
  src/
    Router.php              # Request dispatcher (auth, validation, routing)
    Contracts/
      BackendAdapter.php    # Interface: the 4 methods every backend must implement
    Adapters/
      NullBackendAdapter.php   # Stub adapter (returns placeholder text, zero tokens)
      CdxBackendAdapter.php    # Real adapter: shells out to local `cdx` binary
    Http/
      Request.php           # Parses $_SERVER, headers, JSON body
      JsonResponse.php      # Static helpers: send(), sendError(), stream()
    Controllers/            # Empty (reserved)
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
