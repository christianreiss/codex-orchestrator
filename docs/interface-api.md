# API Interface (Source of Truth)

## Host-facing

- `POST /auth` — retrieve/store canonical `auth.json` for the calling host. Requires API key (`X-API-Key` or `Authorization: Bearer`). Accepts `command: "retrieve" | "store"`; for `retrieve` the body must include top-level `last_refresh` and `digest` (64-hex), while `store` requires an `auth` object with RFC3339 `last_refresh` and `auths` (synthesized from `tokens.access_token`/`OPENAI_API_KEY` when missing; `digest` is optional for `store`). Responses include status (`valid`/`upload_required`/`outdated`/`missing` for `retrieve`; `updated`/`unchanged`/`outdated` for `store`) plus versions, API call counts, and (when available) `chatgpt_usage` containing the latest `/wham/usage` snapshot: `primary_window` (5-hour) and `secondary_window` (weekly) blocks with `used_percent`, `limit_seconds`, and reset info alongside plan/status metadata. The server refreshes the snapshot if the cooldown has expired, similar to how client versions are refreshed on demand.
- `DELETE /auth` — deregister host; IP binding enforced unless `?force=1`.
- `POST /usage` — token usage telemetry from `cdx`. Body accepts either a single usage entry or `usages` array; each entry may include numeric `total`/`input`/`output` plus optional `cached`, `reasoning`, `model`, or freeform `line` (at least one numeric field or `line` required). Stores one `token_usages` row per entry and logs `token.usage` for each.
- `GET /wrapper` — wrapper metadata baked for host (version, sha256, `size_bytes`, `url`). Auth required.
- `GET /wrapper/download` — downloads baked `cdx` wrapper (per-host hash). Auth required.
- `GET /slash-commands` — list server-known slash command prompts (`filename`, `sha256`, `description`, `argument_hint`, `updated_at`). Auth required.
- `POST /slash-commands/retrieve` — body: `filename` (required) and optional `sha256` (64-hex). Returns `status` (`missing` | `unchanged` | `updated`) plus metadata and `prompt` when the server copy differs from the provided digest.
- `POST /slash-commands/store` — body: `filename`, `prompt` (full file content, e.g., markdown with `---` front matter), optional `description`/`argument_hint`, optional `sha256` (validated against `prompt`). Stores/updates canonical prompt row, logs `slash.store`, and echoes `status` (`created` | `updated` | `unchanged`) with canonical `sha256`.
- `GET /versions` — current client version (GitHub latest, cached 3h with stale fallback) and wrapper version from the baked script; no publish endpoint.

## Installer

- `GET /install/{token}` — single-use installer script for a pre-registered host. Tokens minted via `/admin/hosts/register`; installs/bakes API key + base URL into `cdx`.

## Admin (mTLS + optional `DASHBOARD_ADMIN_KEY`)

- `GET /admin/overview` — hosts count, avg refresh age, latest log timestamp, versions, token totals (including reasoning tokens), ChatGPT usage snapshot (cached ≤5m), and mTLS metadata.
- `GET /admin/hosts` — list hosts with canonical digest, digests history, versions, API calls, IP, roaming flag, latest token usage (including reasoning tokens).
- `POST /admin/hosts/register` — mint a host + single-use installer token for a given FQDN; calling it again for the same FQDN rotates that host’s API key and issues a fresh installer.
- `GET /admin/hosts/{id}/auth` — canonical digest/last refresh, recent digests, optional `auth` body (`?include_body=1`).
- `POST /admin/hosts/{id}/roaming` — toggle `allow_roaming_ips`.
- `POST /admin/hosts/{id}/clear` — clears canonical auth state for the host (resets `last_refresh`/`auth_digest`, deletes `host_auth_states`, and prunes recent digests).
- `DELETE /admin/hosts/{id}` — delete host + digests.
- `POST /admin/auth/upload` — validate/store canonical `auth.json` (system or host-scoped).
- `GET /admin/api/state` / `POST /admin/api/state` — read/set persisted `api_disabled` flag (not enforced by `/auth`).
- `GET /admin/logs?limit=` — recent audit events.
- `GET /admin/usage?limit=` — recent token usage rows (with host + reasoning tokens when present).
- `GET /admin/tokens?limit=` — token usage aggregates per token line (sums total/input/output/cached/reasoning).
- `GET /admin/runner` — runner config/telemetry; `POST /admin/runner/run` — manual runner execution.
- `POST /admin/versions/check` — refresh GitHub client release cache.
- `GET /admin/chatgpt/usage[?force=1]` — account-level ChatGPT `/wham/usage` snapshot using canonical `auth.json` token (5-minute cooldown unless `force`).
- `POST /admin/chatgpt/usage/refresh` — force-refresh ChatGPT usage snapshot (bypasses cooldown).
- `GET /admin/slash-commands` — list server-stored slash command prompts (filename, sha256, description, argument hint, timestamps).
- Pricing: auto-fetches GPT-5.1 pricing (daily) from `PRICING_URL` or env fallback and surfaces `tokens_month`, `pricing`, and `pricing_month_cost` in `/admin/overview` for dashboard cost calculations.

## Auth + IP rules

- API key is bound to first caller IP; subsequent calls from a new IP are blocked unless `allow_roaming_ips` is enabled via admin or `?force=1` on `DELETE /auth`.
- Admin endpoints require mTLS (`X-mTLS-Present` header) and, if set, `DASHBOARD_ADMIN_KEY`.
