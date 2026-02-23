# Auth Runner (Sidecar) Behavior

The auth runner is a FastAPI sidecar (`auth-runner` in `docker-compose.yml`) that sanity-checks auth payloads by running `/usr/local/bin/codex` in an isolated temp `$HOME`.

## HTTP surface (runner container)

- `POST /verify` is the probe entrypoint. Body: `auth_json` (required object) and `timeout_seconds` (optional float). Extra JSON fields are ignored.
- When `RUNNER_SHARED_SECRET` is set, `/verify` requires header `X-Runner-Auth` with an exact secret match (otherwise HTTP 401).
- `GET /health` returns `{"status": "ok"}` and is used by Docker health checks.
- `POST /verify` success responses include: `status`, `latency_ms`, `reachable`, `codex_version`, optional `updated_auth`, and optional `reason`.
- `status` is `ok` only when the probe command exits `0` and stdout contains `banana` (case-insensitive); otherwise `status` is `fail`.
- Error responses: HTTP `400` when no usable token exists, HTTP `504` on probe timeout, HTTP `500` for other exceptions.

## Probe lifecycle (runner/app.py)

1. Optionally persist the incoming auth to `/tmp/last-auth.json` (0600) only when all are true: `RUNNER_DEBUG_DUMP_AUTH=1`, `RUNNER_ALLOW_SECRET_DUMP=1`, and `APP_ENV!=production`.
2. Require at least one usable token from `auths["api.openai.com"]["token"]`, `tokens["access_token"]`, or `tokens["openai_api_key"]`; otherwise return HTTP 400 (`detail: "no usable token in auth_json"`).
3. Create a temp `$HOME` (overriding the container default), write `~/.codex/auth.json`, chmod 0600, and clean up the temp home after the probe.
4. Env for the probe: `CODEX_SYNC_BASE_URL` from runner env when set (otherwise `http://api`), plus `CODEX_SYNC_OPTIONAL=1` and `CODEX_SYNC_BAKED=0`.
5. Run `/usr/local/bin/codex exec "Reply Banana if this works." -s read-only --skip-git-repo-check` with timeout `timeout_seconds` (or `8.0` when unset/falsey).
6. Reload `~/.codex/auth.json` after the probe; when it differs from the input payload, include it in the response as `updated_auth`.
7. Compute `codex_version` from `/usr/local/bin/codex --version`; if that command fails, `codex_version` is `unknown`.

## How the API uses it (AuthService + RunnerVerifier)

- Runner is enabled only when `AUTH_RUNNER_URL` is a non-empty string; otherwise `RunnerVerifier` is not created.
- `RunnerVerifier` readiness probe uses `GET AUTH_RUNNER_URL` (same URL as POST target), retries once after 500ms, and treats transport failure as `reachable=false`. It then `POST`s to the same URL and retries once after 300ms when the first POST attempt is unreachable.
- Runner request payload always includes `auth_json`, `base_url`, and `timeout_seconds`; when host metadata is available it also includes `api_key` and `fqdn`. When `AUTH_RUNNER_SHARED_SECRET` is set, `RunnerVerifier` also sends `X-Runner-Auth`.
- `/auth` `store` with `skipRunner=false`:
  - If the candidate payload would update canonical auth, runner verification is mandatory.
  - If runner is not configured, request fails with HTTP `503` (`Auth runner required`).
  - If runner is unreachable, request fails with HTTP `503` (`Auth runner unavailable`).
  - If runner returns non-`ok`, request fails with validation error.
  - If runner returns `updated_auth`, it is applied only when `updated_auth.last_refresh >= upload.last_refresh`.
- `POST /seed/auth/{token}` and `POST /admin/auth/upload` call `handleAuth(..., skipRunner=true)` and bypass runner verification.
- `store` responses always include `runner_applied`; they include `validation` when a runner call was made.
- Scheduled preflight is triggered by `runDailyPreflight()` on each non-admin request except `/versions` and routes starting with `/mcp`.
- Preflight behavior: refresh GitHub client-version cache and (when runner is configured and canonical auth exists) run runner validation with trigger `scheduled_preflight`; preflight exceptions are caught in `public/index.php` and do not block the request.
- Recovery behavior when `runner_state=fail`: retries are triggered on boot-id change or after ~15 minutes since `runner_last_fail` (`fail_backoff` path). Recovery failures are logged and do not block serving auth.
- Manual trigger `POST /admin/runner/run` forces one runner pass (`trigger=manual`) and returns whether canonical digest changed (`applied`).
- Runner telemetry stored in `versions`: `runner_state`, `runner_last_ok`, `runner_last_fail`, `runner_last_check` (set only when the runner request was reachable), `runner_boot_id`, and `daily_preflight`.

## Network and IP notes

- Runner-originated requests can bypass host-IP rebinding when `AUTH_RUNNER_IP_BYPASS` is truthy (`1`, `true`, `yes`, `on`) and caller IP matches a CIDR in `AUTH_RUNNER_BYPASS_SUBNETS`; those requests are logged as `auth.runner_ip_bypass`.
- Code defaults: `AUTH_RUNNER_IP_BYPASS=0` and `AUTH_RUNNER_BYPASS_SUBNETS=''`. Compose/.env defaults keep bypass disabled unless explicitly enabled.
- Disabling runner (`AUTH_RUNNER_URL` empty/unset) reports `runner_enabled=false` in version snapshots. Host `/auth` store requests that need canonical updates then fail with `503 Auth runner required` (admin/seed upload paths still bypass runner via `skipRunner=true`).

## Configuration quick reference

- `AUTH_RUNNER_URL` (API): runner endpoint URL used for readiness GET + verification POST. Code default: empty (disabled). Compose default: `http://auth-runner:8080/verify`.
- `AUTH_RUNNER_TIMEOUT` (API): default runner timeout passed to verifier payload and HTTP client timeout. Default: `8` seconds.
- `AUTH_RUNNER_CODEX_BASE_URL` (API): populates verifier payload field `base_url`. Code default: `http://api`. Runner currently ignores this field.
- `AUTH_RUNNER_SHARED_SECRET` (API): when non-empty, API includes `X-Runner-Auth` in runner requests.
- `AUTH_RUNNER_PREFLIGHT_SECONDS` (API): preflight interval. Default: `28800` (8h). Non-positive values fall back to `28800`.
- `AUTH_RUNNER_IP_BYPASS` / `AUTH_RUNNER_BYPASS_SUBNETS` (API): controls runner CIDR IP-bypass behavior in host authentication.
- `CODEX_SYNC_BASE_URL` (runner container): used by runner probe process; fallback in runner code is `http://api`.
- `RUNNER_SHARED_SECRET` (runner container): validates incoming `X-Runner-Auth` for `/verify`.
- `RUNNER_DEBUG_DUMP_AUTH` + `RUNNER_ALLOW_SECRET_DUMP` (runner container): both must be `1` to allow `/tmp/last-auth.json` writes; still disabled when `APP_ENV=production`.
