# Codex Auth Runner

Lightweight HTTP microservice that validates an `auth.json` by running the Codex CLI inside an isolated temp `$HOME`. Intended to run on the internal Docker network (no host ports).

## Build

```bash
docker build -t codex-auth-runner -f runner/Dockerfile .
```

The image bundles the Codex CLI (default `rust-v0.63.0`, musl builds). Override via build args `CODEX_TAG`, `CODEX_ASSET_AMD64`, and `CODEX_ASSET_ARM64` if you need a different release.

## Run (standalone)

```bash
docker run --rm --name codex-auth-runner --network codex_auth codex-auth-runner
```

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
  -d '{ "auth_json": { "tokens": { "access_token": "sk-..." } } }'
```

Response (success):

```json
{
  "status": "ok",
  "latency_ms": 123,
  "reachable": true,
  "codex_version": "rust-v0.63.0"
}
```

Response (failure):

```json
{
  "status": "fail",
  "latency_ms": 123,
  "reachable": true,
  "codex_version": "rust-v0.63.0",
  "reason": "probe failed"
}
```

If the probe updates `~/.codex/auth.json` (for example by refreshing tokens), the response also includes:

```json
{
  "updated_auth": { "...": "..." }
}
```

Behavior details:
- Uses a temporary `$HOME` and writes `~/.codex/auth.json` with mode 0600 for each probe.
- Runs `/usr/local/bin/codex exec "Reply Banana if this works." -s read-only --skip-git-repo-check`.
- Sets `CODEX_SYNC_BASE_URL` from the container env (default `http://api` when unset), plus `CODEX_SYNC_OPTIONAL=1` and `CODEX_SYNC_BAKED=0`.
- `status` is `ok` only when the command exits 0 and stdout contains `banana` (case-insensitive); otherwise `status` is `fail` and `reason` includes trimmed stderr/stdout (up to 400 chars).
- `codex_version` is taken from `/usr/local/bin/codex --version` (last whitespace-separated token), or `"unknown"` when the version call fails.
