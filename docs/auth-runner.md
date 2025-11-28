# Auth Runner (Sidecar) Behavior

The auth runner is a lightweight sidecar (`auth-runner` service in `docker-compose.yml`) that probes the canonical `auth.json` by running Codex in an isolated temp `$HOME`.

## When it runs

- On every `/auth` **store** (host API) after the payload is accepted.
- Once per UTC day on the **first API request** (daily preflight).
- **Manual**: `POST /admin/runner/run` triggers a run against the current canonical auth.
- Admin **seed uploads** (`POST /admin/auth/upload`) **skip** the runner to avoid blocking bootstrap.

## What it does

1. Receives the canonical auth payload from the API.
2. Writes it verbatim to `~/.codex/auth.json` inside a temp `$HOME` and sets `CODEX_SYNC_OPTIONAL=1`, `CODEX_SYNC_BAKED=0`.
3. Runs `codex exec "Reply Banana if this works." --dangerously-bypass-approvals-and-sandbox -s danger-full-access --skip-git-repo-check`.
4. Returns a JSON status to the API:
   - `ok` when Codex exits 0 and prints “banana” (case-insensitive).
   - `fail` with `reason` on non-zero/401/etc.
   - `updated_auth` when Codex wrote a newer `auth.json`; the API will store/apply it.

Debug: the last received payload is persisted at `/tmp/last-auth.json` inside the runner container (mode 600).

## How the API treats results

- On `store`: applies `updated_auth` when newer/different; logs `auth.validate`; runner failures are logged/surfaced but **do not block** `/auth`.
- Daily preflight: logs validation; failures are recorded but do not block subsequent `/auth`.
- Manual run: result is shown in the admin dashboard (Runner widget).
- Runner status is tracked in `versions`: `runner_state` (`ok`/`fail`), `runner_last_ok`, `runner_last_fail`, `runner_last_check`, `runner_boot_id`.

## Configuration

- Enabled by default: `AUTH_RUNNER_URL=http://auth-runner:8080/verify` (see `docker-compose.yml`).
- Timeout: `AUTH_RUNNER_TIMEOUT` (seconds; default 8).
- Base URL injected into runner env: `AUTH_RUNNER_CODEX_BASE_URL` (default `http://api` inside compose).
If `AUTH_RUNNER_URL` is unset/empty, the API skips runner calls entirely.
