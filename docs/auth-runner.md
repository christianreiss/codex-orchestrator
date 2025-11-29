# Auth Runner (Sidecar) Behavior

The auth runner is a FastAPI sidecar (`auth-runner` in `docker-compose.yml`) that sanity-checks the canonical `auth.json` by executing the bundled Codex CLI in an isolated temp `$HOME`.

## HTTP surface

- `POST /verify` is the probe entrypoint. Body: `auth_json` (required object) and `timeout_seconds` (optional float). Extra fields are ignored by the runner (the API still sends `base_url`, `api_key`, and `fqdn` for forward compatibility).
- `GET /health` is used by Docker health checks. RunnerVerifier also issues a GET to `AUTH_RUNNER_URL` (with the same path as the POST target) before probing; it treats any reachable response as ready.
- Responses include `status` (`ok` only when exit 0 and stdout contains `banana`), `latency_ms`, `reachable`, `codex_version`, and optional `reason` (stderr/stdout trimmed to 400 chars). A probe timeout raises HTTP 504; missing usable tokens raises HTTP 400.

## Probe lifecycle (runner/app.py)

1. Persist the incoming auth to `/tmp/last-auth.json` (0600) for debugging.
2. Require at least one usable OpenAI token (`auths.api.openai.com.token` or `tokens.access_token`/`openai_api_key`), otherwise return 400.
3. Create a temp `$HOME`, write `~/.codex/auth.json`, chmod 0600.
4. Env for the probe: `CODEX_SYNC_BASE_URL` from the runner container env (defaults to `https://codex-auth.example.com` via compose, falls back to `http://api` in code), `CODEX_SYNC_OPTIONAL=1`, `CODEX_SYNC_BAKED=0`.
5. Run `/usr/local/bin/codex exec "Reply Banana if this works." --dangerously-bypass-approvals-and-sandbox -s danger-full-access --skip-git-repo-check` with the provided or default timeout.
6. Status is `ok` only if the command exits 0 and stdout contains `banana` (case-insensitive); otherwise it is `fail` with `reason`.

Note: the current runner implementation does not emit `updated_auth`. The API will still apply it if a future runner version returns the field.

## How the API uses it (AuthService + RunnerVerifier)

- RunnerVerifier pings `AUTH_RUNNER_URL` with a short GET (and one retry) before POSTing. If the runner is unreachable it returns `reachable=false` without hitting the probe.
- `/auth` store calls run the runner after persisting the canonical payload (unless `skipRunner=true`, for example admin uploads). The response includes `validation` (runner result) and `runner_applied` (true only when an `updated_auth` was saved).
- Daily preflight: on the first non-admin request each UTC day or after a container boot, the API refreshes the cached GitHub client version and, when canonical auth exists, forces one runner probe tagged `daily_preflight`. Results update runner state but never block responses.
- Failure recovery: when `runner_state=fail`, extra probes tagged `fail_recovery` may run during requests or preflight after either 15 minutes since the last failure, a boot-id change, or a stale success window (>6h). A 60 second backoff prevents immediate re-probing after a failure. Recovery failures are logged but do not block `/auth`.
- Manual admin trigger `POST /admin/runner/run` forces a probe and reports whether the canonical digest changed.
- Runner state lives in `versions`: `runner_state`, `runner_last_ok`, `runner_last_fail`, `runner_last_check` (set only when the runner responded), `runner_boot_id`, plus the last daily preflight date.
- Runner host tagging: validations are logged against the current host when available, else the canonical payload `source_host_id`, else the first host in the DB.

## Network and IP notes

- The runner may call the API while Codex syncs. To avoid rebinding host IPs during those calls, requests from configured subnets bypass the IP lock: `AUTH_RUNNER_IP_BYPASS` (default enabled) and `AUTH_RUNNER_BYPASS_SUBNETS` (default `172.28.0.0/16,172.30.0.0/16`).
- Disable the runner by leaving `AUTH_RUNNER_URL` empty or unset; `/versions` will report `runner_enabled=false` and no runner hooks run.

## Configuration quick reference

- `AUTH_RUNNER_URL` (API) - full POST URL (default `http://auth-runner:8080/verify`) and readiness GET target.
- `AUTH_RUNNER_TIMEOUT` (API) - float seconds (default 8).
- `AUTH_RUNNER_CODEX_BASE_URL` (API) - sent in the payload for forward compatibility; the current runner ignores it.
- `CODEX_SYNC_BASE_URL` (runner container) - base URL used by Codex during probes.
- `AUTH_RUNNER_IP_BYPASS`, `AUTH_RUNNER_BYPASS_SUBNETS` - IP bypass controls as noted above.
