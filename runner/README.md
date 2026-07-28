# Codex / Claude Auth Runner

Lightweight HTTP microservice that validates an `auth.json`, generates short summaries, and drafts/revises skills by running the Codex or Claude CLI inside an isolated temp `$HOME`. Intended to run on the internal Docker network (no host ports).

Both engines are supported end-to-end:

- **Codex** path uses `/usr/local/bin/codex exec` with the installed Codex Rust CLI.
- **Claude** path uses `/usr/local/bin/claude --print` with the installed `@anthropic-ai/claude-code` npm CLI.
- Skill/memory/project endpoints accept an `engine: "codex" | "claude"` field in the request body (defaults to `codex` for back-compat).
- A dedicated `POST /verify-claude` endpoint validates Anthropic API keys against
  `api.anthropic.com/v1/messages`, and validates Claude Code OAuth credentials
  through the native Claude CLI so account-login tokens are not treated as public
  API keys.

## Build

```bash
docker build -t codex-auth-runner -f runner/Dockerfile .
```

The image bundles:

- The Codex CLI (default `rust-v0.144.1`, musl builds; see `CODEX_TAG` in `runner/Dockerfile`). The pin has to stay in step with the fleet's codex target so the probe runs the same model catalog as real hosts — an older CLI without the default probe model fails every valid fresh login. Override via build args `CODEX_TAG`, `CODEX_ASSET_AMD64`, `CODEX_ASSET_ARM64`. Supported `TARGETARCH` values are `amd64` and `arm64`.
- Node.js 22 plus the `@anthropic-ai/claude-code` npm package (installed globally), so `/verify-claude` and the Claude `exec` path work without extra setup.

## Run (standalone)

```bash
docker run --rm --name codex-auth-runner --network codex_auth codex-auth-runner
```

The container serves FastAPI via uvicorn on `0.0.0.0:8080`.

## Environment variables

- `CODEX_SYNC_BASE_URL` (optional) — passed to the probe process; defaults to `http://api` when unset.
- `ANTHROPIC_API_BASE` (optional) — Anthropic API base URL used by `POST /verify-claude`; defaults to `https://api.anthropic.com`.
- `RUNNER_SHARED_SECRET` (required) — every POST (`/verify`, `/verify-claude`, `/skills/summarize`, `/memories/summarize`, `/skills/generate`, `/skills/assist`, `/projects/assist`, and `/exec`) requires header `X-Runner-Auth` with an exact secret match. The guard fails closed: a wrong or missing header returns HTTP 401, and an unset `RUNNER_SHARED_SECRET` returns HTTP 500 rather than skipping auth. `GET /health` and the readiness GETs answer without the secret.
- `RUNNER_HOME_PARENT` (optional) — parent directory for the isolated temporary runner `$HOME`; the bundled image sets it to `/dev/shm`, which is writable in the hardened container while still avoiding CLI homes under `/tmp`.
- `RUNNER_DEBUG_DUMP_AUTH=1` (optional) — enables debug dumping only when `RUNNER_ALLOW_SECRET_DUMP=1` is also set and `APP_ENV` is not `production`. Dumps land at `/tmp/last-auth.json` (Codex) and `/tmp/last-claude-auth.json` (Claude).
- `RUNNER_ALLOW_SECRET_DUMP=1` (optional) — second explicit opt-in for debug secret dumps.
- `APP_ENV` (optional) — when `production`, secret dump is always disabled.

## HTTP API

Every route `runner/app.py` registers, and nothing else. `runner/test_app.py`
walks `app.routes` and fails both ways — a registered route missing from this
file, and a `METHOD /path` documented here that the router does not serve — so
this list cannot drift from the code.

- `GET /health` — per-engine CLI availability.
- `POST /verify` — Codex credential probe.
- `POST /verify-claude` — Claude credential probe.
- `GET /skills/summarize` / `POST /skills/summarize` — readiness probe / skill summary.
- `GET /memories/summarize` / `POST /memories/summarize` — readiness probe / memory summary.
- `GET /skills/generate` / `POST /skills/generate` — readiness probe / structured skill draft.
- `GET /skills/assist` / `POST /skills/assist` — readiness probe / skill draft revision.
- `GET /projects/assist` / `POST /projects/assist` — readiness probe / project draft revision.
- `GET /exec` / `POST /exec` — readiness probe / one-shot prompt execution.

### `GET /health`

Returns per-engine CLI availability:

```json
{
  "status": "ok",
  "engines": {
    "codex":  { "available": true },
    "claude": { "available": true }
  }
}
```

Use these flags in the admin dashboard to decide which verification buttons to show.

### `POST /verify`

Request body:

```json
{
  "auth_json": {
    "auth_mode": "chatgpt",
    "tokens": { "access_token": "sk-..." }
  },
  "timeout_seconds": 8.0
}
```

Fields:
- `auth_json` (required object) — written to `~/.codex/auth.json` for the probe and resolved exactly like native Codex. Explicit `auth_mode:"apikey"` requires top-level `OPENAI_API_KEY`; explicit `chatgpt` / `chatgptAuthTokens` requires `tokens.access_token`. With no mode, native inference selects personal-access-token/Bedrock first (unsupported here), then a present top-level `OPENAI_API_KEY`, otherwise ChatGPT tokens. The API normalizes legacy `tokens.openai_api_key` / `auths.api.openai.com.token` inputs into one native mode before calling the runner.
- `timeout_seconds` (optional float) — probe timeout in seconds; defaults to 8.0 when omitted.
- `RUNNER_CODEX_PROBE_MODEL` (environment) — model used for the Codex “Reply Banana” probe; defaults to `gpt-5.6-terra`.

Example:

```bash
curl -s http://codex-auth-runner:8080/verify \
  -H "Content-Type: application/json" \
  -H "X-Runner-Auth: $RUNNER_SHARED_SECRET" \
  -d '{ "auth_json": { "tokens": { "access_token": "sk-..." } } }'
```

Response (success):

```json
{
  "status": "ok",
  "latency_ms": 123,
  "reachable": true,
  "codex_version": "0.101.0"
}
```

Response (failure):

```json
{
  "status": "fail",
  "latency_ms": 123,
  "reachable": true,
  "codex_version": "0.101.0",
  "reason": "probe failed"
}
```

Error responses:
- HTTP 400: invalid input/auth payload (for example missing usable token).
- HTTP 504: probe timeout (`"probe timeout"`).
- HTTP 500: write/probe runtime errors (`detail` contains the exception text).

If the probe updates `~/.codex/auth.json` (for example by refreshing tokens), the response also includes:

```json
{
  "updated_auth": { "...": "..." }
}
```

Behavior details:
- Uses a temporary `$HOME` and writes `~/.codex/auth.json` with mode 0600 for each probe.
- The temporary `$HOME` is created under `RUNNER_HOME_PARENT` (the bundled image defaults this to `/dev/shm`), and the runner also points `TMPDIR`/`TMP`/`TEMP` at a writable subdirectory inside that home.
- Credential selection matches native Codex: explicit `auth_mode` wins; otherwise a present top-level `OPENAI_API_KEY` wins over `tokens.access_token`. Unsupported/unknown modes and a missing credential for the selected mode fail with HTTP 400. The runner does not reinterpret `auths` or `tokens.openai_api_key` as native credentials.
- Runs `/usr/local/bin/codex exec --model "${RUNNER_CODEX_PROBE_MODEL:-gpt-5.6-terra}" -s read-only --skip-git-repo-check "Reply Banana if this works."`.
- Sets `CODEX_SYNC_BASE_URL` from the container env (default `http://api` when unset), plus `CODEX_SYNC_OPTIONAL=1` and `CODEX_SYNC_BAKED=0`.
- `status` is `ok` only when the command exits 0 and stdout contains `banana` (case-insensitive); otherwise `status` is `fail` and `reason` includes trimmed stderr/stdout (up to 400 chars).
- `codex_version` is taken from `/usr/local/bin/codex --version` (last whitespace-separated token), or `"unknown"` when the version call fails.
- The temp `$HOME` directory is always removed after the probe.

### `POST /verify-claude`

Claude credential probe. API-key credentials use a small Anthropic
`/v1/messages` call directly. Claude Code OAuth credentials (`claudeAiOauth` /
`sk-ant-oat...`) are validated by writing the native
`~/.claude/.credentials.json` shape into a temporary HOME and running a lightweight
Claude CLI print probe, because those tokens are not public Anthropic API keys.

Request body:

```json
{
  "auth_json": {
    "auths": { "api.anthropic.com": { "token": "sk-ant-..." } }
  },
  "timeout_seconds": 8.0
}
```

Fields:
- `auth_json` (required object) — credential precedence is native `claudeAiOauth.accessToken`, then top-level `api_key` / `anthropic_api_key` / `ANTHROPIC_API_KEY`, then the same aliases under `tokens`, then `auths["api.anthropic.com"].token`. A `sk-ant-oat...` bearer outside a non-empty native `claudeAiOauth` object is rejected instead of being misclassified as an API key.
- `timeout_seconds` (optional float) — probe timeout in seconds; defaults to 8.0 when omitted.

Example:

```bash
curl -s http://codex-auth-runner:8080/verify-claude \
  -H "Content-Type: application/json" \
  -H "X-Runner-Auth: $RUNNER_SHARED_SECRET" \
  -d '{ "auth_json": { "auths": { "api.anthropic.com": { "token": "sk-ant-..." } } } }'
```

Response (success):

```json
{
  "status": "ok",
  "latency_ms": 410,
  "reachable": true,
  "claude_version": "1.2.3"
}
```

Response (failure):

```json
{
  "status": "fail",
  "latency_ms": 410,
  "reachable": true,
  "claude_version": "1.2.3",
  "reason": "HTTP 401: authentication_error"
}
```

Behavior details:
- API-key payloads POST to `${ANTHROPIC_API_BASE}/v1/messages` (default
  `https://api.anthropic.com/v1/messages`) with `model:
  "claude-sonnet-4-20250514"`, `max_tokens: 16`, and a one-line "Reply Banana"
  probe prompt.
- Claude Code OAuth payloads create a temp `$HOME` under `RUNNER_HOME_PARENT`,
  project the canonical envelope onto the native `claudeAiOauth`-only
  `~/.claude/.credentials.json` shape, clear `ANTHROPIC_API_KEY`, and run
  `/usr/local/bin/claude --print "Reply Banana if this works."`.
- Runner readback compares against that same native projection. Orchestrator
  metadata such as `last_refresh` and derived `auths` entries therefore cannot
  masquerade as a Claude credential rotation.
- Claude's `OAuth session expired and could not be refreshed` failure is a
  definitive credential rejection. If Claude clears the temporary native file
  while returning that error, the API routes the host into canonical repair or
  interactive login instead of treating the empty file as an unsafe rotation.
- `status` is `ok` only when the API/CLI response contains `banana`
  (case-insensitive).
- `claude_version` comes from `/usr/local/bin/claude --version`, or
  `"unavailable"` when the CLI is not installed.

### Engine routing on skill / memory / project endpoints

The POST endpoints that generate or summarize content accept an optional `engine` field:

```json
{
  "auth_json": { "...": "..." },
  "engine": "claude",
  "slug": "deploy",
  "manifest": "# Deploy\n..."
}
```

When `engine: "claude"`, the runner:
1. Resolves the Anthropic credential as native `claudeAiOauth.accessToken` → top-level API-key aliases → `tokens` API-key aliases → `auths["api.anthropic.com"].token`; OAuth bearers in API-key fallback fields are rejected.
2. Creates a temp `$HOME` under `RUNNER_HOME_PARENT`, writes the auth JSON to
   `~/.claude/.credentials.json`, and exports `ANTHROPIC_API_KEY=<token>` only
   for genuine API-key credentials. Native Claude Code OAuth credentials run
   without `ANTHROPIC_API_KEY`.
3. Runs `/usr/local/bin/claude --print --no-input [--model MODEL] [--max-tokens N] [--system-prompt SYS] PROMPT`.
4. Emits `claude_version` in the response instead of `codex_version`.

When `engine` is omitted or set to `"codex"`, the runner uses the existing Codex path unchanged.

### `GET /skills/summarize`

Readiness probe for the skill summary path:

```json
{ "status": "ok" }
```

### `POST /skills/summarize`

Request body:

```json
{
  "auth_json": { "tokens": { "access_token": "sk-..." } },
  "slug": "deploy",
  "manifest": "# Deploy\nUse this skill to roll out safely.\n",
  "timeout_seconds": 8.0
}
```

Fields:
- `auth_json` (required object) — same auth bootstrap used by `/verify`; must contain a usable token.
- `slug` (required string) — skill slug for prompt context.
- `manifest` (required string) — `SKILL.md` contents to summarize.
- `timeout_seconds` (optional float) — summary timeout in seconds; defaults to 8.0 when omitted.

Response (success):

```json
{
  "status": "ok",
  "latency_ms": 123,
  "reachable": true,
  "codex_version": "0.101.0",
  "summary": "Deploys services safely with guided rollout steps."
}
```

Behavior details:
- Uses the same temporary `$HOME` + `~/.codex/auth.json` flow as `/verify`.
- Runs `/usr/local/bin/codex exec` with a strict one-sentence summary prompt.
- Sanitizes the result into a single trimmed line suitable for AGENTS.md inventory output.

### `GET /memories/summarize`

Readiness probe for the memory summary path:

```json
{ "status": "ok" }
```

### `POST /memories/summarize`

Generate a short summary for one stored MCP memory so the API can render a per-host memory inventory inside served `AGENTS.md`.

Request body:

```json
{
  "auth_json": {
    "last_refresh": "2026-03-28T10:00:00Z",
    "auths": {
      "api.openai.com": {
        "token": "sk-..."
      }
    }
  },
  "memory_key": "deploy.notes",
  "content": "Drain the queue before rollout and verify the worker backlog is zero.",
  "timeout_seconds": 8
}
```

Fields:
- `auth_json` (required object) — same auth bootstrap used by `/verify`; must contain a usable token.
- `memory_key` (required string) — memory identifier for prompt context.
- `content` (required string) — stored memory content to summarize.
- `timeout_seconds` (optional float) — summary timeout in seconds; defaults to 8.0 when omitted.

Response (success):

```json
{
  "status": "ok",
  "latency_ms": 123,
  "reachable": true,
  "codex_version": "0.101.0",
  "summary": "Captures deployment notes and host-specific caveats."
}
```

Behavior details:
- Uses the same temporary `$HOME` + `~/.codex/auth.json` flow as `/verify`.
- Runs `/usr/local/bin/codex exec` with a strict one-sentence summary prompt.
- Sanitizes the result into a single trimmed line suitable for AGENTS.md inventory output.

### `GET /skills/generate`

Readiness probe for the skill draft path:

```json
{ "status": "ok" }
```

### `POST /skills/generate`

Draft a structured skill from a short prompt.

Request body:

```json
{
  "auth_json": { "tokens": { "access_token": "sk-..." } },
  "prompt": "Create a deploy skill focused on safe rollouts and rollback checks.",
  "timeout_seconds": 12.0
}
```

Fields:
- `auth_json` (required object) — same auth bootstrap used by `/verify`; must contain a usable token.
- `prompt` (required string) — natural-language request for the initial skill draft.
- `timeout_seconds` (optional float) — generation timeout in seconds; defaults to 12.0 when omitted.

Response (success):

```json
{
  "status": "ok",
  "latency_ms": 123,
  "reachable": true,
  "codex_version": "0.101.0",
  "slug": "deploy",
  "display_name": "Deploy",
  "description": "Helps operators roll out changes safely.",
  "tags": ["deploy", "rollout"],
  "what": "Use this skill to prepare, execute, and verify a rollout.",
  "when": "Use when shipping changes with user impact.",
  "steps": ["Check health", "Deploy", "Verify", "Roll back if needed"]
}
```

Behavior details:
- Uses the same temporary `$HOME` + `~/.codex/auth.json` flow as `/verify`.
- Runs `/usr/local/bin/codex exec` with a prompt that requires strict JSON output for the structured draft fields.
- Returns normalized draft fields only; persistence remains the API/admin app's job.

### `GET /skills/assist`

Readiness probe for the conversational skill refinement path:

```json
{ "status": "ok" }
```

### `POST /skills/assist`

Revise a structured skill draft from a conversation.

Request body:

```json
{
  "auth_json": { "tokens": { "access_token": "sk-..." } },
  "messages": [
    { "role": "user", "content": "Make this skill more incident-focused." }
  ],
  "skill": {
    "slug": "incident-response",
    "display_name": "Incident response",
    "description": "Guides responders through the first pass.",
    "tags": ["incident"],
    "what": "Use when production is degraded.",
    "when": "Use during active incidents.",
    "steps": ["Triage", "Contain", "Communicate"]
  },
  "mode": "edit",
  "slug_locked": true,
  "timeout_seconds": 12.0
}
```

Fields:
- `auth_json` (required object) — same auth bootstrap used by `/verify`; must contain a usable token.
- `messages` (required array) — ordered chat messages with `role` (`user` or `assistant`) and `content`.
- `skill` (required object) — current structured draft fields.
- `mode` (optional string) — `new` or `edit`; used for prompt guidance.
- `slug_locked` (optional boolean) — when true, the runner is told not to rename the slug.
- `timeout_seconds` (optional float) — assist timeout in seconds; defaults to 12.0 when omitted.

Response (success):

```json
{
  "status": "ok",
  "latency_ms": 123,
  "reachable": true,
  "codex_version": "0.101.0",
  "assistant_message": "Tightened the incident framing and made the steps more explicit.",
  "slug": "incident-response",
  "display_name": "Incident response",
  "description": "Guides responders through fast, structured incident handling.",
  "tags": ["incident", "ops"],
  "what": "Use this skill to coordinate the first response to an active incident.",
  "when": "Use when a service is degraded, down, or behaving dangerously.",
  "steps": ["Assess impact", "Stabilize", "Communicate", "Verify recovery"]
}
```

Behavior details:
- Uses the same temporary `$HOME` + `~/.codex/auth.json` flow as `/verify`.
- Runs `/usr/local/bin/codex exec` with the current draft, full conversation, and slug-lock guidance, and requires strict JSON output.
- Returns an `assistant_message` plus a complete updated draft; the API/admin app still validates, normalizes, and persists later via its own `/admin/skills/store` endpoint.

### `GET /projects/assist`

Readiness probe for the admin project draft endpoint:

```json
{ "status": "ok" }
```

### `POST /projects/assist`

Draft project metadata and roster suggestions from an existing project snapshot.

Request body:

```json
{
  "auth_json": { "tokens": { "access_token": "sk-..." } },
  "slug": "sipproxy",
  "project": {
    "slug": "sipproxy",
    "about": {
      "title": "",
      "name": "",
      "description": ""
    },
    "roster_markdown": "",
    "notes": [
      { "header": "Discovery", "body": "Proxying SIP traffic between edges and core." }
    ]
  },
  "timeout_seconds": 12.0
}
```

Fields:
- `auth_json` (required object) — same auth bootstrap used by `/verify`; must contain a usable token.
- `slug` (required string) — target project slug.
- `project` (required object) — current project snapshot from the admin/API service, including existing metadata and recent project context.
- `timeout_seconds` (optional float) — assist timeout in seconds; defaults to 8.0 when omitted.

Response (success):

```json
{
  "status": "ok",
  "latency_ms": 123,
  "reachable": true,
  "codex_version": "0.101.0",
  "assistant_message": "Filled the weak metadata from the current project context.",
  "title": "SIP Proxy",
  "name": "sipproxy",
  "description": "Tracks the shared rollout and operating context for the SIP proxy stack.",
  "roster_markdown": "- Service: SIP proxy\n- Keep handoff notes here."
}
```

Behavior details:
- Uses the same temporary `$HOME` + `~/.codex/auth.json` flow as `/verify`.
- Runs `/usr/local/bin/codex exec` with a strict JSON prompt that is explicitly limited to the provided project snapshot.
- Returns draft fields only; the admin API/UI remains responsible for deciding what to persist.

### `GET /exec`

Readiness probe for the one-shot prompt path:

```json
{ "status": "ok" }
```

### `POST /exec`

Run a single prompt through the engine CLI. This is the route the API uses to serve OpenAI/Anthropic-style completions from a host's stored credentials.

Request body:

```json
{
  "auth_json": { "tokens": { "access_token": "sk-..." } },
  "prompt": "Summarize the rollout plan in one paragraph.",
  "engine": "codex",
  "model": "gpt-5.6-terra",
  "timeout_seconds": 30
}
```

Fields:
- `auth_json` (required object) — same auth bootstrap used by `/verify`; must contain a usable token for the selected engine.
- `prompt` (required string) — the prompt to execute.
- `images` (optional array) — attachments with `url` (http(s) or `data:` URL) and optional `detail`; materialized into the temp `$HOME` and passed to the CLI as image paths.
- `model` (optional string) — model passed to the CLI.
- `engine` (optional string) — `codex` or `claude`; defaults to `codex`.
- `system` (optional string) — system prompt; read only on the `claude` path.
- `max_tokens` (optional int) — read only on the `claude` path, and dropped there too because the Claude CLI has no such flag.
- `temperature`, `top_p`, `top_k`, `stop_sequences` (optional) — accepted for wire-format compatibility and passed to neither CLI.
- `timeout_seconds` (optional float) — exec timeout in seconds; defaults to 30.0 when omitted.

Response (success):

```json
{
  "status": "ok",
  "latency_ms": 1234,
  "reachable": true,
  "output": "The rollout proceeds in three stages..."
}
```

Response (failure):

```json
{
  "status": "fail",
  "latency_ms": 1234,
  "reachable": true,
  "output": "",
  "error": "codex exec failed"
}
```

Behavior details:
- Uses the same temporary `$HOME` flow as `/verify`, writing `~/.codex/auth.json` or `~/.claude/.credentials.json` depending on `engine`, and includes `updated_auth` when the CLI rewrites the credential file.
- The `claude` path runs with `--output-format json`; a 0-exit response that is not that JSON shape is reported as `status:"fail"` rather than being passed through as reply text, and an `is_error` result inside a 0-exit response is a failure too.
- The `claude` path also returns `input_tokens`, `output_tokens`, `cache_creation_input_tokens`, and `cache_read_input_tokens`.
- HTTP 504 on exec timeout (`"exec timeout"`); HTTP 500 on runner exceptions.
