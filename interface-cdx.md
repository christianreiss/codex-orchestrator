# Interface: Codex CLI (`cdx`) ↔ Codex Auth API

## Overview
- `cdx` is the local wrapper that **pulls canonical auth**, **runs Codex**, **pushes changes**, **reports usage**, and **self‑updates** (both Codex binary and the wrapper) using the Auth API.
- Helper scripts (`codex-install`, `codex-uninstall`, `local-bootstrap`, `force-push-auth`, `codex-clean`, `push-wrapper`) provision or clean hosts, write the sync env file, and publish wrapper/admin data.
- All client <-> API calls are authenticated with the per‑host API key via `X-API-Key` (or Bearer) and are IP-bound after first use.

## Sync Config Contract (`codex-sync.env`)
- **Format:** simple KEY=VALUE lines (no quotes required). Recognized keys:
  - `CODEX_SYNC_BASE_URL` (string, trimmed of trailing `/`; default `https://codex-auth.uggs.io`)
  - `CODEX_SYNC_API_KEY` (64‑hex per‑host key from `/register`)
  - `CODEX_SYNC_FQDN` (optional label; not sent to API by `cdx`)
  - `CODEX_SYNC_CA_FILE` (optional path to PEM bundle used for TLS verification)
  - `CODEX_SYNC_ALLOW_INSECURE` (default `0`; set to `1` to allow unverified TLS fallback — break‑glass only)
  - `CODEX_SYNC_OPTIONAL` (default `0`; when `1` and the API key is missing, skip API sync and proceed with the local `auth.json`)
- **Precedence when loading in `cdx`:**
  1) Environment variables override everything.
  2) Files are read in order: `/etc/codex-sync.env` → `/usr/local/etc/codex-sync.env` → `~/.codex/sync.env`; later files override earlier ones.
  3) If `CODEX_SYNC_CONFIG_PATH` is set, only that file is read.
- **Writers & destinations**
  - `codex-install`: tries `/usr/local/etc/codex-sync.env`; falls back to `~/.codex/sync.env` if no sudo. Adds CA path if provided.
  - `local-bootstrap`: default `/usr/local/etc/codex-sync.env`; `--local-env` forces `~/.codex/sync.env`; `--env-path` custom.
  - `codex-clean` / `codex-uninstall`: read both system and user paths; remove them.
  - `cdx` never writes the file; it only reads.

Example:
```env
CODEX_SYNC_BASE_URL=https://codex-auth.example.com
CODEX_SYNC_API_KEY=6c0f...e9a4
CODEX_SYNC_FQDN=ci01.example.net
CODEX_SYNC_CA_FILE=/usr/local/etc/codex-sync-ca.pem
```

## Commands & Flows

### `cdx` (wrapper)
- **Inputs:** env + sync env file above; optional flags `--debug|--verbose` (sets `CODEX_DEBUG=1`), `--allow-insecure-tls` (sets `CODEX_SYNC_ALLOW_INSECURE=1`), `--wrapper-version/-W` (prints wrapper version and exits). All other args are forwarded to the Codex binary.
- **Dependencies:** `python3` (required for API sync), `curl`/`unzip` (auto-installable on Linux when running as root or sudo‑capable `chris`), `sha256sum`, `script` (optional).
- **Flow (pull → run → push):**
  1) Load config; drop malformed `~/.codex/auth.json` (missing `last_refresh` or tokens) before syncing. If no local auth exists (fresh install), skip API sync, mark auth status `missing-local`, and continue so the user can login via Codex without being blocked by a 422. When `CODEX_SYNC_OPTIONAL=1` and the API key is absent, `cdx` also skips API sync (auth status `skip-sync`) but still runs Codex with the provided `auth.json`.
  2) **POST `/auth` retrieve** with body  
     ```json
     {
       "command": "retrieve",
       "last_refresh": "<local or 2000-01-01T00:00:00Z>",
       "digest": "<sha256 of local auth.json>",
       "client_version": "<local Codex version or 'unknown'>",
       "wrapper_version": "<cdx wrapper version>"
     }
     ```
     - Status handling:  
       - `valid` → keep local auth.  
       - `outdated` → write canonical `auth` + `canonical_last_refresh`.  
       - `upload_required` → resend with `command: "store"` using local auth (server believes client is newer).  
       - `missing` → proceed to upload.  
       - Any HTTP failure (401/403/IP bind/503 “API disabled”) stops execution before Codex runs.
  3) If status `missing` (or anything not `valid`/`outdated`), **POST `/auth` store** with `{ "command":"store", "auth":<local auth>, ... }` (includes `digest` when returned).
  4) Capture `versions` block from responses: `client_version`, `wrapper_version`, `wrapper_sha256`, `wrapper_url`, `reported_*`.
  5) **Codex CLI auto‑update:** If `versions.client_version` is newer than local, download GitHub release asset (architecture/GLIBC‑aware) or `npm install -g codex-cli@<version>` when Codex was npm-installed.
  6) **Wrapper self‑update:** If `wrapper_version` or `wrapper_sha256` differs, download `wrapper_url` (relative URLs are joined with `CODEX_SYNC_BASE_URL`) with `X-API-Key`; verify SHA when provided; install to the current script path (uses sudo if needed).
  7) Log summary; refuse to start Codex if auth pull failed.
  8) Run Codex with forced flags `--ask-for-approval never --sandbox danger-full-access` plus user args; capture stdout.
  9) Parse the last `Token usage:` line from Codex output; if present, **POST `/usage`** with `line` and parsed `total/input/output[/cached]` and optional `model`.
  10) After Codex exits, if `last_refresh` changed, re‑run `/auth` store to push the new auth.
- **Example (happy path):**
  ```bash
  CODEX_SYNC_BASE_URL=https://codex-auth.example.com \
  CODEX_SYNC_API_KEY=6c0f...e9a4 \
  cdx run --task "deploy"
  ```
  Requests: POST `/auth` retrieve → (maybe) POST `/auth` store → GET `/wrapper/download` (if update) → POST `/usage` (after run).
- **Failure example:** Wrong API key → `/auth` 401 “Invalid API key”; cdx deletes local `auth.json`, logs `Auth unavailable; refusing to start Codex`, exits 1 (no Codex run).

### `codex-install`
- **Purpose:** Provision a remote host over SSH (default root) with Codex CLI, `cdx`, sync env, and optionally auth.json.
- **Key flags/env:** `--user/-u`, `--ssh-port`, `--identity`, `--ssh-opt`, `--global`, `--sudo`, `--local-bind/--local-port` (for login tunnel, default 127.0.0.1:1455), `--auth-json` (use local auth push), `--sync-base-url`, `--sync-invite-key` (or `CODEX_SYNC_INVITE_KEY`), `--sync-fqdn`, `--sync-ca-file`, `--install-systemd-timer`, `--summary-only/--show-steps`, `-v`.
- **Registration:** Always registers via **POST `/register`** `{ "fqdn": <target fqdn>, "invitation_key": <key> }` (invite key auto-discovered from env/.env/API.md) and uses the returned `api_key`; `--sync-api-key`/`CODEX_SYNC_API_KEY` inputs are ignored to prevent key reuse.
- **Sync env written** to `/usr/local/etc/codex-sync.env` (or `~/.codex/sync.env` if no sudo) containing base URL, API key, FQDN, optional CA path. Optional CA payload installed at `/usr/local/etc/codex-sync-ca.pem`.
- **Auth provisioning modes:**
  - *Auth push flow* (local `auth.json` present): upload the local auth via **`POST /auth` store** before touching the remote, then install Codex + `cdx`; the remote bootstrap runs the same **`POST /auth` retrieve→store** logic to hydrate `~/.codex/auth.json`. Verifies remote `~/.codex/auth.json` exists and is mode 600 (also for user `chris` when root).
  - *Login flow* (no local auth): opens SSH tunnel to remote 1455, runs remote `cdx login`, streams first URL prefixed with `AUTH_URL` so the operator can open a browser; requires manual login completion.
- **Example:**  
  `./bin/codex-install --sync-base-url https://codex-auth.example.com my-host.example.com`
- **Failure example:** Wrong invite key → `/register` 401; installer aborts before any remote changes.

### `codex-uninstall`
- **Purpose:** Remote cleanup + deregistration.
- **Inputs:** `--user`, `--ssh-port`, `--identity`, `--ssh-opt`, `--sudo`, `-v`; target `[user@]host`.
- **Actions on remote:** Load sync env (system + user) to get base URL/API key; attempt **DELETE `/auth?force=1`** (with `X-API-Key`, bypassing IP binding if it drifted). Remove binaries (`/usr/local/bin/{cdx,codex}`, `/opt/codex`), sync env/CA files (system and user), and `~/.codex` for current user, root, and chris. Reports removed/failed items.
- **Failure example:** Missing API key → skips API delete, still removes files.

### `local-bootstrap`
- **Modes:** `full` (default: install `cdx` + register + write env), `cdx` (wrapper only), `register` (refresh API key + env).
- **Inputs:** `--base-url`, `--invite-key|--invite-file`, `--api-key`, `--fqdn`, `--env-path|--local-env`, `--ca-file`, `--wrapper-target`, `--force`.
- **Register:** If no API key (or in `register` mode) calls **POST `/register`** with invite key (found in env, repo `.env`, or API.md). Writes sync env at chosen path with API key/base URL/FQDN/CA. Installs `cdx` from repo `bin/cdx` when mode `full` or `cdx`.
- **Example:** `./bin/local-bootstrap full --base-url https://codex-auth.example.com --invite-key abc123`

### `force-push-auth`
- **Purpose:** Replace canonical auth quickly using local `~/.codex/auth.json`.
- **Inputs:** `--base-url`, `--api-key` (or `--invite-key` to register), `--fqdn`, `--auth <path>`, `--ca-file`.
- **Flow:** If no API key, **POST `/register`**. Build auth payload (uses existing `auths` or synthesizes from `tokens.access_token`). **POST `/auth`** with `command: "store"` including `client_version`/`wrapper_version` env defaults and `last_refresh` (now if missing). Prints server response.

### `push-wrapper`
- **Purpose:** Publish new `cdx` wrapper and optional Codex client version.
- **Inputs:** `--base`, `--key` (`VERSION_ADMIN_KEY`), `--file` (wrapper script), `--version`, `--client`.
- **Calls:** **POST `/wrapper`** multipart (`file`, `version`, `sha256`). If `--client` or `--version` provided, also **POST `/versions`** with JSON `{ client_version?, wrapper_version? }`.
- **Failure example:** Missing admin key → `/wrapper` 401 “Admin key required”.

### `codex-clean`
- **Purpose:** Local wipe; optional API self-delete.
- **Inputs:** `-y/--yes`, `--no-api`; reads env + sync env paths.
- **Calls:** Unless `--no-api`, **DELETE `/auth?force=1`** with `X-API-Key` (force allows IP override). Removes local `~/.codex/{auth.json,sync.env}`, system sync envs, `/usr/local/bin/{cdx,codex}`.

## Auth JSON Contract
- **Required structure:**  
  - `last_refresh`: RFC3339 timestamp, not before 2000-01-01T00:00:00Z, not >5 minutes in the future (server validation).  
  - `auths`: non-empty object keyed by target (string). Each entry must include `token` (no whitespace, min length `TOKEN_MIN_LENGTH` env, default 24, entropy checks), optional `token_type` (default `bearer`), `organization|org|default_organization`, `project|default_project`, `api_base|base_url`, plus any scalar metadata (kept under `meta` in DB but emitted flat).  
  - Any extra top-level fields (e.g., `tokens.access_token`, `OPENAI_API_KEY`, custom metadata) are **preserved verbatim**.
- **Server fallback:** If `auths` is empty but `tokens.access_token` or `OPENAI_API_KEY` is present, the server synthesizes `auths = {"api.openai.com": {"token": <access_token>, "token_type": "bearer"}}`. `cdx` validation allows this fallback too.
- **Canonicalization (server):** Sorts auth targets and entry keys; rewrites to `{ "last_refresh": <ts>, "auths": { ... } }` while keeping other top-level keys intact in the stored JSON blob. Digest = SHA-256 over that canonical JSON (stored in `auth_payloads.sha256` and echoed as `canonical_digest`).
- **Client digest (cdx):** SHA-256 of the local JSON as written; server compares against canonical digest and a 3-entry recent-digest cache.
- **`/auth` behaviors (current code):**
  - Retrieve statuses: `valid` (digest match), `upload_required` (client `last_refresh` newer than canonical), `outdated` (server returns canonical `auth` when server newer or digest mismatch), `missing` (no canonical).
  - Store statuses: `updated` (incoming `last_refresh` newer or no canonical), `unchanged` (timestamps equal), `outdated` (server already newer; returns canonical `auth`).
  - On success, host sync state is updated and `api_calls` incremented.
- **Example canonical auth.json**
```json
{
  "last_refresh": "2025-11-20T09:27:43.373506Z",
  "auths": {
    "api.openai.com": {
      "token": "sk-live-xxxxxxxxxxxxxxxxxxxxxxxxxxxx",
      "token_type": "bearer",
      "organization": "org_123",
      "project": "proj_456"
    },
    "api.codex.example.com": {
      "token": "sk-alt-xxxxxxxxxxxxxxxxxxxxxxxxxxxx",
      "api_base": "https://api.codex.example.com/v1"
    }
  },
  "tokens": {
    "access_token": "eyJhbGciOi...",
    "refresh_token": "r1...",
    "account_id": "92d59f2a-1b48-4466-86a6-cfc3816bfede"
  },
  "OPENAI_API_KEY": null
}
```

## Versioning & Auto-Update
- `/auth` and `/versions` return:
  - `client_version`, `client_version_checked_at`, `client_version_source` (`github|cache|published|cache_stale|unknown`),  
  - `wrapper_version`, `wrapper_sha256`, `wrapper_url` (usually `/wrapper/download`),  
  - `reported_client_version`, `reported_wrapper_version` (highest seen from any host).
- `cdx` update logic:
  - If `client_version` > local (version_compare), download matching GitHub asset (`codex-<arch>-<os>.tar.gz` with musl fallback for glibc<2.39) or `npm install -g codex-cli@<version>` when Codex is npm-installed.
  - If `wrapper_version`/`wrapper_sha256` differs, download `wrapper_url` with API key, verify SHA when provided, install over current `cdx`.
  - Fails closed: if auth pull fails, Codex is not executed.
- Server seeds `wrapper` version from stored file (`storage/wrapper/cdx`) on boot; will also auto-seed from first reported host version if none is published.

## Usage Reporting
- `cdx` scans Codex stdout for `Token usage:` line (e.g., `Token usage: total=985 input=969 (+ 6,912 cached) output=16`).
- Sends **POST `/usage`** with `{ line, total?, input?, output?, cached?, model? }`; at least one field required by server. Uses same API key + IP binding and optional CA. Errors are logged but do not fail the main command.

## Mismatches & Proposed Fixes
- **TLS strictness:** By default `cdx` now fails closed if both custom CA and system trust fail. To allow the legacy unverified fallback explicitly set `CODEX_SYNC_ALLOW_INSECURE=1` or pass `--allow-insecure-tls` to `cdx`. Use only for break-glass scenarios.

## Compatibility / Migration Notes
- Hosts are IP-bound on first successful `/auth`; use `/admin/hosts/{id}/roaming` to allow roaming or re-register to rotate the key. `codex-clean --no-api` leaves the binding intact.
- `DELETE /auth?force=1` (used by `codex-clean`) bypasses IP binding server-side; keep API key secret.
- Token minimum length defaults to 24; override with `TOKEN_MIN_LENGTH` in server env if needed.

## Assumptions
- No additional hidden CLI flags beyond those present in the current scripts.
- Codex GitHub release assets keep the existing naming scheme (`codex-<arch>-unknown-linux-gnu.tar.gz`, etc.).
