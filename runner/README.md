# Codex Auth Runner

Lightweight HTTP microservice that validates an `auth.json` and generates short skill summaries by running the Codex CLI inside an isolated temp `$HOME`. Intended to run on the internal Docker network (no host ports).

## Build

```bash
docker build -t codex-auth-runner -f runner/Dockerfile .
```

The image bundles the Codex CLI (default `rust-v0.101.0`, musl builds). Override via build args `CODEX_TAG`, `CODEX_ASSET_AMD64`, and `CODEX_ASSET_ARM64` if you need a different release. Supported `TARGETARCH` values in the Dockerfile are `amd64` and `arm64`.

## Run (standalone)

```bash
docker run --rm --name codex-auth-runner --network codex_auth codex-auth-runner
```

The container serves FastAPI via uvicorn on `0.0.0.0:8080`.

## Environment variables

- `CODEX_SYNC_BASE_URL` (optional) — passed to the probe process; defaults to `http://api` when unset.
- `RUNNER_SHARED_SECRET` (optional, recommended) — when set, `/verify` requires header `X-Runner-Auth` with an exact secret match.
- `RUNNER_SHARED_SECRET` (optional, recommended) — when set, `/verify` and `/skills/summarize` require header `X-Runner-Auth` with an exact secret match.
- `RUNNER_DEBUG_DUMP_AUTH=1` (optional) — enables debug dumping only when `RUNNER_ALLOW_SECRET_DUMP=1` is also set and `APP_ENV` is not `production`.
- `RUNNER_ALLOW_SECRET_DUMP=1` (optional) — second explicit opt-in for writing `/tmp/last-auth.json`.
- `APP_ENV` (optional) — when `production`, secret dump is always disabled.

## HTTP API

### `GET /health`

Simple health check:

```json
{ "status": "ok" }
```

### `POST /verify`

Request body:

```json
{
  "auth_json": { "tokens": { "access_token": "sk-..." } },
  "timeout_seconds": 8.0
}
```

Fields:
- `auth_json` (required object) — written to `~/.codex/auth.json` for the probe; must contain either `auths.api.openai.com.token` or `tokens.access_token` / `tokens.openai_api_key`, or the request fails with HTTP 400 (`"no usable token in auth_json"`).
- `timeout_seconds` (optional float) — probe timeout in seconds; defaults to 8.0 when omitted.

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
- Token extraction order is `auths.api.openai.com.token` first, then `tokens.access_token`, then `tokens.openai_api_key`.
- Runs `/usr/local/bin/codex exec "Reply Banana if this works." -s read-only --skip-git-repo-check`.
- Sets `CODEX_SYNC_BASE_URL` from the container env (default `http://api` when unset), plus `CODEX_SYNC_OPTIONAL=1` and `CODEX_SYNC_BAKED=0`.
- `status` is `ok` only when the command exits 0 and stdout contains `banana` (case-insensitive); otherwise `status` is `fail` and `reason` includes trimmed stderr/stdout (up to 400 chars).
- `codex_version` is taken from `/usr/local/bin/codex --version` (last whitespace-separated token), or `"unknown"` when the version call fails.
- The temp `$HOME` directory is always removed after the probe.

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
