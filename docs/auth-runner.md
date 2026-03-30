# Auth Runner (Sidecar) Behavior

The auth runner is a FastAPI sidecar (`auth-runner` in `docker-compose.yml`) that sanity-checks auth payloads, generates short skill/memory summaries, and drafts new skill manifests by running `/usr/local/bin/codex` in an isolated temp `$HOME`.

## HTTP surface (runner container)

- `POST /verify` is the probe entrypoint. Body: `auth_json` (required object) and `timeout_seconds` (optional float).
- `POST /skills/summarize` generates a short AGENTS-safe skill summary. Body: `auth_json` (required object), `slug` (required string), `manifest` (required string), and optional `timeout_seconds`.
- `POST /memories/summarize` generates a short AGENTS-safe memory summary. Body: `auth_json` (required object), `memory_key` (required string), `content` (required string), and optional `timeout_seconds`.
- `POST /skills/generate` generates a structured skill draft. Body: `auth_json` (required object), `prompt` (required string), optional `slug_hint`, and optional `timeout_seconds`.
- When `RUNNER_SHARED_SECRET` is set, `/verify` requires header `X-Runner-Auth` with an exact secret match (otherwise HTTP 401).
- When `RUNNER_SHARED_SECRET` is set, `/skills/summarize` also requires header `X-Runner-Auth` with an exact secret match.
- When `RUNNER_SHARED_SECRET` is set, `/memories/summarize` also requires header `X-Runner-Auth` with an exact secret match.
- When `RUNNER_SHARED_SECRET` is set, `/skills/generate` also requires header `X-Runner-Auth` with an exact secret match.
- `GET /health` returns `{"status": "ok"}` and is used by Docker health checks.
- `POST /verify` success responses include: `status`, `latency_ms`, `reachable`, `codex_version`, optional `updated_auth`, and optional `reason`.
- `GET /skills/summarize` returns `{"status": "ok"}` so API-side readiness probing can hit the same route used for POST summaries.
- `POST /skills/summarize` success responses include: `status`, `latency_ms`, `reachable`, `codex_version`, optional `summary`, and optional `reason`.
- `GET /memories/summarize` returns `{"status": "ok"}` so API-side readiness probing can hit the same route used for POST summaries.
- `POST /memories/summarize` success responses include: `status`, `latency_ms`, `reachable`, `codex_version`, optional `summary`, and optional `reason`.
- `GET /skills/generate` returns `{"status": "ok"}` so API-side readiness probing can hit the same route used for POST generation.
- `POST /skills/generate` success responses include: `status`, `latency_ms`, `reachable`, `codex_version`, the structured draft fields (`slug`, `display_name`, `description`, `tags`, `what`, `when`, `steps`), and optional `reason`.
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

## Skill summary lifecycle (runner/app.py)

1. Require `slug` and `manifest`; reject blank values with HTTP 400.
2. Reuse the same auth bootstrap path as `/verify`: require a usable token from `auth_json`, create a temp `$HOME`, write `~/.codex/auth.json`, and clean it up after the run.
3. Run `/usr/local/bin/codex exec` with a strict prompt that asks for exactly one short plain-text sentence describing what the skill is used for.
4. Sanitize the result into a single trimmed line (collapse whitespace, strip common bullet/quote wrappers, cap length) before returning it as `summary`.
5. `status` is `ok` only when the command exits `0` and a non-empty sanitized summary is produced; otherwise `status` is `fail` and `reason` includes trimmed stderr/stdout (up to 400 chars).

## Memory summary lifecycle (runner/app.py)

1. Require `memory_key` and `content`; reject blank values with HTTP 400.
2. Reuse the same auth bootstrap path as `/verify` and `/skills/summarize`: require a usable token from `auth_json`, create a temp `$HOME`, write `~/.codex/auth.json`, and clean it up after the run.
3. Run `/usr/local/bin/codex exec` with a strict prompt that asks for exactly one short plain-text sentence describing what the memory contains for AGENTS inventory output.
4. Sanitize the result into a single trimmed line (collapse whitespace, strip common bullet/quote wrappers, cap length) before returning it as `summary`.
5. `status` is `ok` only when the command exits `0` and a non-empty sanitized summary is produced; otherwise `status` is `fail` and `reason` includes trimmed stderr/stdout (up to 400 chars).

## Skill draft lifecycle (runner/app.py)

1. Require a non-empty `prompt`; reject blank values with HTTP 400.
2. Reuse the same auth bootstrap path as `/verify` and `/skills/summarize`: require a usable token from `auth_json`, create a temp `$HOME`, write `~/.codex/auth.json`, and clean it up after the run.
3. Run `/usr/local/bin/codex exec` with a strict prompt that requests exactly one JSON object containing `slug`, `display_name`, `description`, `tags`, `what`, `when`, and `steps`.
4. Parse the returned JSON strictly, sanitize the individual fields, and fail the request when Codex returns malformed or incomplete output.
5. `status` is `ok` only when the command exits `0` and the structured draft parses cleanly; otherwise `status` is `fail` and `reason` includes parse error details plus trimmed stderr/stdout (up to 600 chars).

## How the API uses it (AuthService + RunnerVerifier)

- Runner is enabled only when `AUTH_RUNNER_URL` is a non-empty string; otherwise `RunnerVerifier` is not created.
- `RunnerVerifier` readiness probe uses `GET AUTH_RUNNER_URL` (same URL as POST target), retries once after 500ms, and treats transport failure as `reachable=false`. It then `POST`s to the same URL and retries once after 300ms when the first POST attempt is unreachable.
- Runner request payload includes only `auth_json` and `timeout_seconds`. When `AUTH_RUNNER_SHARED_SECRET` is set, `RunnerVerifier` also sends `X-Runner-Auth`.
- OpenAI-compatible `/exec` request payload includes `auth_json`, `prompt`, optional `model`, and `timeout_seconds`; when `model` is present the runner invokes `codex --model <id> exec ...`.
- Skill summary request payload includes `auth_json`, `slug`, `manifest`, and `timeout_seconds`. The API only asks for summaries when a skill is created or its manifest changes and no explicit description was supplied.
- Memory summary request payload includes `auth_json`, `memory_key`, `content`, and `timeout_seconds`. The API asks for summaries after memory create/update writes and may backfill them on unchanged writes when an older row still lacks `summary`.
- Skill draft request payload includes `auth_json`, `prompt`, optional `slug_hint`, and `timeout_seconds`. The API uses it only for the admin-only `POST /admin/skills/generate` draft flow; generated drafts are not persisted until the admin later calls `POST /admin/skills/store`.
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
- `AUTH_RUNNER_SKILL_SUMMARY_URL` (API): optional explicit runner skill-summary endpoint. When unset, API derives it from `AUTH_RUNNER_URL` by replacing `/verify` with `/skills/summarize`.
- `AUTH_RUNNER_MEMORY_SUMMARY_URL` (API): optional explicit runner memory-summary endpoint. When unset, API derives it from `AUTH_RUNNER_URL` by replacing `/verify` with `/memories/summarize`.
- `AUTH_RUNNER_SKILL_GENERATE_URL` (API): optional explicit runner skill-generation endpoint. When unset, API derives it from `AUTH_RUNNER_URL` by replacing `/verify` with `/skills/generate`.
- `AUTH_RUNNER_TIMEOUT` (API): default runner timeout passed to verifier payload and HTTP client timeout. Default: `8` seconds.
- `AUTH_RUNNER_CODEX_BASE_URL` (API): legacy compatibility setting retained in config/setup flows; runner verification no longer sends a `base_url` field.
- `AUTH_RUNNER_SHARED_SECRET` (API): when non-empty, API includes `X-Runner-Auth` in runner requests.
- `AUTH_RUNNER_PREFLIGHT_SECONDS` (API): preflight interval. Default: `28800` (8h). Non-positive values fall back to `28800`.
- `AUTH_RUNNER_IP_BYPASS` / `AUTH_RUNNER_BYPASS_SUBNETS` (API): controls runner CIDR IP-bypass behavior in host authentication.
- `CODEX_SYNC_BASE_URL` (runner container): used by runner probe process; fallback in runner code is `http://api`.
- `RUNNER_SHARED_SECRET` (runner container): validates incoming `X-Runner-Auth` for `/verify`, `/skills/summarize`, `/memories/summarize`, and `/skills/generate`.
- `RUNNER_DEBUG_DUMP_AUTH` + `RUNNER_ALLOW_SECRET_DUMP` (runner container): both must be `1` to allow `/tmp/last-auth.json` writes; still disabled when `APP_ENV=production`.
