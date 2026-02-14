# Auth Runner (Sidecar) Behavior

The auth runner is a FastAPI sidecar (`auth-runner` in `docker-compose.yml`) that sanity-checks the canonical `auth.json` by executing the bundled Codex CLI in an isolated temp `$HOME`.

## HTTP surface (runner container)

- `POST /verify` is the probe entrypoint. Body: `auth_json` (required object) and `timeout_seconds` (optional float). Extra JSON fields are ignored by the runner.
- `GET /health` returns `{"status": "ok"}` and is used by Docker health checks.
- Responses include `status` (`ok` only when exit 0 and stdout contains `banana`), `latency_ms`, `reachable`, `codex_version`, and optional `reason` (stderr/stdout trimmed to 400 chars). A probe timeout raises HTTP 504; missing usable tokens raises HTTP 400; unexpected errors raise HTTP 500.

## Probe lifecycle (runner/app.py)

1. Optionally persist the incoming auth to `/tmp/last-auth.json` (0600) when `RUNNER_DEBUG_DUMP_AUTH=1` is set in the runner env.
2. Require at least one usable OpenAI token (`auths.api.openai.com.token` or `tokens.access_token`/`openai_api_key`), otherwise return HTTP 400 with `detail: "no usable token in auth_json"`.
3. Create a temp `$HOME` (overriding the container default), write `~/.codex/auth.json`, chmod 0600, and clean up the temp home after the probe.
4. Env for the probe: `CODEX_SYNC_BASE_URL` from the runner container env (defaults in compose, falls back to `http://api` in code), `CODEX_SYNC_OPTIONAL=1`, `CODEX_SYNC_BAKED=0`.
5. Run `/usr/local/bin/codex exec "Reply Banana if this works." -s read-only --skip-git-repo-check` with the provided or default timeout.
6. Reload `~/.codex/auth.json` after the probe; when it differs from the input payload, include it in the response as `updated_auth`.
7. Status is `ok` only if the command exits 0 and stdout contains `banana` (case-insensitive); otherwise it is `fail` with `reason`. When `codex --version` fails, `codex_version` is set to `unknown`.

## How the API uses it (AuthService + RunnerVerifier)

- RunnerVerifier sends a short GET to `AUTH_RUNNER_URL` (same URL as the POST target) before POSTing; on failure it retries once with a short backoff. If the runner remains unreachable it returns `reachable=false` and does not hit `/verify`.
- `/auth` store calls run the runner **before** persisting the canonical payload when the runner is configured and `skipRunner=false`. Non-OK or unreachable results reject the upload; admin `/admin/auth/upload` bypasses the runner. The `/auth` response includes `validation` (runner result) and `runner_applied` (true only when an `updated_auth` was saved).
- Scheduled preflight: on the first non-admin request after an interval (default 8 hours, configurable via `AUTH_RUNNER_PREFLIGHT_SECONDS`), the API refreshes the cached GitHub client version and, when canonical auth exists, runs one runner probe tagged `scheduled_preflight`. Runner outcomes update runner state and timestamps but never block responses.
- Failure recovery: when `runner_state=fail`, extra probes tagged as a recovery reason (for example `fail_recovery`) may run after a 60 second backoff from the last failure, after a longer retry window (15 minutes), or when the last success is stale (>6h) or the boot id changes. Recovery failures are logged but do not block `/auth`.
- Manual admin trigger `POST /admin/runner/run` forces a probe (bypassing the interval guard) and reports whether the canonical digest changed.
- Runner state lives in `versions`: `runner_state`, `runner_last_ok`, `runner_last_fail`, `runner_last_check` (set only when the runner responded), `runner_boot_id`, and the last preflight timestamp stored under `daily_preflight`.
- Runner host tagging: validations are logged against the current host when available, else the canonical payload `source_host_id`, else the first host in the DB.

## Network and IP notes

- The runner may call the API while Codex syncs. To avoid rebinding host IPs during those calls, requests from configured subnets bypass the IP lock: `AUTH_RUNNER_IP_BYPASS` (default enabled) and `AUTH_RUNNER_BYPASS_SUBNETS` (default `172.28.0.0/16,172.30.0.0/16`).
- Disable the runner by leaving `AUTH_RUNNER_URL` empty or unset; `/versions` will report `runner_enabled=false` and no runner hooks run.

## Configuration quick reference

- `AUTH_RUNNER_URL` (API) - full POST URL (default `http://auth-runner:8080/verify`) and readiness GET target.
- `AUTH_RUNNER_TIMEOUT` (API) - float seconds (default 8).
- `AUTH_RUNNER_CODEX_BASE_URL` (API) - sent in the payload for forward compatibility; the current runner ignores it.
- `AUTH_RUNNER_PREFLIGHT_SECONDS` (API) - preflight interval in seconds (default 28800 = 8h) for automatic runner probes.
- `CODEX_SYNC_BASE_URL` (runner container) - base URL used by Codex during probes.
- `RUNNER_DEBUG_DUMP_AUTH` (runner container) - set to `1` to write the latest auth payload to `/tmp/last-auth.json` for debugging.
- `AUTH_RUNNER_IP_BYPASS`, `AUTH_RUNNER_BYPASS_SUBNETS` - IP bypass controls as noted above.
