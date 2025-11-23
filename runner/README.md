# Codex Auth Runner

Lightweight HTTP microservice that validates an `auth.json` by running `cdx` inside an isolated temp `$HOME`. Intended to run on the internal Docker network (no host ports).

## Build

```bash
docker build -t codex-auth-runner -f runner/Dockerfile .
```

## Run (standalone)

```bash
docker run --rm --name codex-auth-runner --network codex_auth codex-auth-runner
```

## Request

```bash
curl -s http://codex-auth-runner:8080/verify \
  -H "Content-Type: application/json" \
  -d '{
        "auth_json": { "tokens": { "access_token": "sk-..." } },
        "base_url": "http://api",
        "probe": "models"
      }'
```

Response:

```json
{ "status":"ok", "latency_ms":123, "wrapper_version":"2025.11.22-6" }
```

On failure:

```json
{ "status":"fail", "reason":"probe failed", "latency_ms":123, "wrapper_version":"2025.11.22-6" }
```

If `cdx` mutates `~/.codex/auth.json` during the probe (for example by refreshing tokens), the response also includes `updated_auth` (the new auth.json body) and keeps the original status/latency fields.

`probe_args` (array of tokens) and `timeout_seconds` are optional for custom probes. The service defaults to `CODEX_SYNC_BASE_URL=http://api` and sets `CODEX_SYNC_ALLOW_INSECURE=1` so it can talk to the in-network HTTP API.
