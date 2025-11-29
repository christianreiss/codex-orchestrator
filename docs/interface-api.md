# API Interface (Source of Truth)

## Host-facing

- Base URL for baked wrappers/installers honors `PUBLIC_BASE_URL` when set; otherwise it is derived from `X-Forwarded-Host`/`Host` + `X-Forwarded-Proto` (validated against `https?://`). If no valid base can be resolved, installer creation fails and host `/auth` responses omit per-host wrapper baking metadata.
- Pruning: hosts inactive for `INACTIVITY_WINDOW_DAYS` (default 30; set to `0` to disable) are deleted during host auth/register/admin host listings. Never-provisioned hosts older than 30 minutes are also pruned.
- `POST /auth` — retrieve/store canonical `auth.json` for the calling host. Requires API key (`X-API-Key` or `Authorization: Bearer`). Accepts `command: "retrieve" | "store"`; for `retrieve` the body must include top-level `last_refresh` and `digest` (64-hex), while `store` requires an `auth` object with RFC3339 `last_refresh` and `auths` (synthesized from `tokens.access_token`/`OPENAI_API_KEY` when missing; `digest` is optional for `store`). Responses include status (`valid`/`upload_required`/`outdated`/`missing` for `retrieve`; `updated`/`unchanged`/`outdated` for `store`) plus versions, API call counts, and (when available) `chatgpt_usage` containing the latest `/wham/usage` snapshot: `primary_window` (5-hour) and `secondary_window` (weekly) blocks with `used_percent`, `limit_seconds`, and reset info alongside plan/status metadata. Versions also surface runner telemetry (`runner_enabled`, `runner_state`, `runner_last_ok`, `runner_last_fail`, `runner_last_check`) so callers can show when canonical auth was last validated by the runner. The server refreshes the snapshot if the cooldown has expired, similar to how client versions are refreshed on demand. Host metadata is echoed when available (`host.secure`, `allow_roaming_ips`, versions, api_calls); when `secure` is `false`, `cdx` deletes `~/.codex/auth.json` after each run (post-push) so secrets are not persisted on that host. **Insecure hosts default to API deny**: admin must click “Enable” in the dashboard, which opens a 10-minute sliding window for `/auth` calls (each call extends the window). “Disable” closes the window immediately but leaves a 60-minute store-only grace period so the host can still push its final `auth.json` updates.
- `DELETE /auth` — deregister host; IP binding enforced unless `?force=1`.
- `POST /host/users` — record the calling host’s current `username`/`hostname` and return all known users for that host. Requires host API key (`X-API-Key` or `Authorization: Bearer`) and IP binding. Response: `{ users: [{ username, hostname, first_seen, last_seen }, ...] }`. Rows are deleted automatically when the host is removed.
- `POST /usage` — token usage telemetry from `cdx`. Body accepts either a single usage entry or `usages` array; each entry may include numeric `total`/`input`/`output` plus optional `cached`, `reasoning`, `model`, or freeform `line` (at least one numeric field or `line` required). Numeric fields must be non-negative numbers (commas allowed, e.g., `10,000`); `line` is sanitized (ANSI/escape stripped, control codes removed, length capped) before storing. Stores one `token_usages` row per entry and logs `token.usage` for each.
- `GET /wrapper` — wrapper metadata baked for host (version, sha256, `size_bytes`, `url`). Auth required.
- `GET /wrapper/download` — downloads baked `cdx` wrapper (per-host hash). Auth required.
- `GET /slash-commands` — list server-known slash command prompts (`filename`, `sha256`, `description`, `argument_hint`, `updated_at`, optional `deleted_at` for retired commands). Auth required.
- `POST /slash-commands/retrieve` — body: `filename` (required) and optional `sha256` (64-hex). Returns `status` (`missing` | `unchanged` | `updated`) plus metadata and `prompt` when the server copy differs from the provided digest.
- `POST /slash-commands/store` — body: `filename`, `prompt` (full file content, e.g., markdown with `---` front matter), optional `description`/`argument_hint`, optional `sha256` (validated against `prompt`). Stores/updates canonical prompt row, logs `slash.store`, and echoes `status` (`created` | `updated` | `unchanged`) with canonical `sha256`.
- `GET /versions` — current client version (GitHub latest, cached 3h with stale fallback) and wrapper version from the baked script; no publish endpoint.

Daily preflight: on the first API request of each UTC day the server forces a GitHub client version refresh and runs a single auth-runner validation against the canonical `auth.json` (runner writes the payload to `~/.codex/auth.json` and runs `codex`). Runner failures are logged/surfaced but do not block `/auth`; admin seed uploads bypass the runner.

## Installer

- `GET /install/{token}` — single-use installer script for a pre-registered host. Tokens minted via `/admin/hosts/register`; installs/bakes API key + base URL into `cdx`.

## Admin (mTLS on by default + optional `DASHBOARD_ADMIN_KEY`)

- `GET /admin/overview` — hosts count, avg refresh age, latest log timestamp, versions, token totals (including reasoning tokens), ChatGPT usage snapshot (cached ≤5m), mTLS metadata (now includes `required` + `present` flags and fingerprint details when provided), plus seed signals for new installs (`has_canonical_auth`, `seed_required`, `seed_reasons`).
- `GET /admin/hosts` — list hosts with canonical digest, digests history, versions, API calls, IP, roaming flag, security flag (`secure`), insecure window fields (`insecure_enabled_until`, `insecure_grace_until`), latest token usage (including reasoning tokens), and recorded users (username/hostname/first/last seen).
- `POST /admin/hosts/register` — mint a host + single-use installer token for a given FQDN; calling it again for the same FQDN rotates that host’s API key and issues a fresh installer. Optional body `secure` (default `true`) marks the host as secure vs. insecure (ephemeral auth). New insecure hosts auto-open a provisioning window equal to the prune threshold (30 minutes) so setup can proceed without extra clicks.
- `GET /admin/hosts/{id}/auth` — canonical digest/last refresh, recent digests, optional `auth` body (`?include_body=1`).
- `POST /admin/hosts/{id}/secure` — toggle the host’s security mode (`secure: true` keeps auth.json locally; `false` makes `cdx` purge it after each run).
- `POST /admin/hosts/{id}/insecure/enable` — for insecure hosts only; opens a 10-minute sliding window where `/auth` calls are permitted (each call extends the window by another 10 minutes).
- `POST /admin/hosts/{id}/insecure/disable` — closes the window immediately and starts a 60-minute grace period during which `/auth` `store` calls are still allowed (retrieves remain blocked) so hosts can finish uploading changes.
- `POST /admin/hosts/{id}/roaming` — toggle `allow_roaming_ips`.
- `POST /admin/hosts/{id}/clear` — clears canonical auth state for the host (resets `last_refresh`/`auth_digest`, deletes `host_auth_states`, and prunes recent digests).
- `DELETE /admin/hosts/{id}` — delete host + digests.
- `POST /admin/auth/upload` — validate/store canonical `auth.json` (system or host-scoped). Runner is skipped for this seed/upload flow.
- `GET /admin/api/state` / `POST /admin/api/state` — read/set persisted `api_disabled` flag (when true, all API routes return 503; `/admin/api/state` stays reachable so operators can re-enable).
- `GET /admin/quota-mode` / `POST /admin/quota-mode` — read/set ChatGPT quota policy (`hard_fail` boolean). When `false`, `cdx` warns on quota exhaustion but still launches Codex.
- `GET /admin/logs?limit=` — recent audit events.
- `GET /admin/usage?limit=` — recent token usage rows (with host + reasoning tokens when present).
- `GET /admin/tokens?limit=` — token usage aggregates per token line (sums total/input/output/cached/reasoning).
- `GET /admin/runner` — runner config/telemetry; `POST /admin/runner/run` — manual runner execution.
- `POST /admin/versions/check` — refresh GitHub client release cache.
- `GET /admin/chatgpt/usage[?force=1]` — account-level ChatGPT `/wham/usage` snapshot using canonical `auth.json` token (5-minute cooldown unless `force`).
- `GET /admin/chatgpt/usage/history?days=60` — quota history for dashboard graphs (5-hour + weekly `used_percent` with `fetched_at`), capped to the past 180 days; default window is 60 days or since the first data point.
- `POST /admin/chatgpt/usage/refresh` — force-refresh ChatGPT usage snapshot (bypasses cooldown).
- `GET /admin/slash-commands` — list server-stored slash command prompts (filename, sha256, description, argument hint, timestamps).
- `GET /admin/slash-commands/{filename}` — fetch a single slash command (includes full prompt body).
- `POST /admin/slash-commands/store` — create/update a slash command (body: `filename`, `prompt`, optional `description`/`argument_hint`/`sha256`; sha is computed if omitted).
- `DELETE /admin/slash-commands/{filename}` — retire a slash command (marks deleted; hosts remove it on next sync).
- Pricing: auto-fetches GPT-5.1 pricing (daily) from `PRICING_URL` or env fallback and surfaces `tokens_month`, `pricing`, and `pricing_month_cost` in `/admin/overview` for dashboard cost calculations.

## Auth + IP rules

- API key is bound to first caller IP; subsequent calls from a new IP are blocked unless `allow_roaming_ips` is enabled via admin or `?force=1` on `DELETE /auth`.
- Admin endpoints require mTLS (`X-mTLS-Present` header) when `ADMIN_REQUIRE_MTLS=1` (default) and, if set, `DASHBOARD_ADMIN_KEY`. With `ADMIN_REQUIRE_MTLS=0`, mTLS headers become optional—lock down `/admin` via another control (VPN, firewall, or admin key).

## Rate limiting

- Global throttle for non-admin paths: per-IP `global` bucket defaults to `RATE_LIMIT_GLOBAL_PER_MINUTE=120` over `RATE_LIMIT_GLOBAL_WINDOW=60` seconds. Exceeding the limit returns HTTP 429 with `{ bucket: "global", reset_at, limit }`.
- Brute-force guard: repeated missing/invalid API keys are counted per IP in the `auth-fail` bucket. Defaults: `RATE_LIMIT_AUTH_FAIL_COUNT=20` failures within `RATE_LIMIT_AUTH_FAIL_WINDOW=600` seconds, extending the block for `RATE_LIMIT_AUTH_FAIL_BLOCK=1800` seconds once tripped. Limit hits return HTTP 429 `Too many failed authentication attempts` with `reset_at` + `bucket`.
- Admin routes are exempt; when no client IP can be resolved the request proceeds without throttling. Tune the env vars above to tighten or disable the windows (zero/negative disables the guard).
