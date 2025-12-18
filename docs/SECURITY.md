# Security Policy

This document reflects **current main** behavior in code (see `public/index.php`, `src/Services/AuthService.php`, `src/Security/*`).

## Supported Versions

Security fixes land on `main`. Backports are not guaranteed—cherry-pick fixes to your deployment branch.

## Reporting a Vulnerability

Email the maintainers or open a private channel with ops. Include:
- Impact synopsis and affected surfaces.
- Repro steps or PoC.
- Logs/config that aid triage (redact secrets).

We acknowledge within 3 business days and share an assessment/fix ETA shortly after.

---

## Hardening Checklist (code-backed)

- **TLS/mTLS for admin**: Admin routes require mTLS by default (`ADMIN_ACCESS_MODE=mtls`). If you disable mTLS (`ADMIN_ACCESS_MODE=none`), put the admin surface behind VPN/firewall.
- **API key binding**: Host API keys are IP-bound on first use; later calls from a different IP are 403 unless roaming is allowed or an admin toggles the roaming flag. Runner-only bypass can be enabled via `AUTH_RUNNER_IP_BYPASS` + CIDRs.
- **Encryption at rest**: Canonical auth bodies and per-target tokens are encrypted with libsodium `secretbox` (`sbox:v1:`) using `AUTH_ENCRYPTION_KEY` (auto-generated into `.env` on first boot). Host API keys are hashed (SHA-256) for lookup and also stored encrypted (`api_key_enc`).
- **Rate limits**: Global IP bucket (default 120 req / 60s, non-admin) and a dedicated auth-failure bucket (default 20 fails / 10m, 30m block) backed by `ip_rate_limits`.
- **Insecure hosts are temporary**: Hosts marked `secure=false` get a configurable sliding window (`insecure_enabled_until`) for API use (2–60 minutes, default 10, set via the admin slider/`duration_minutes`). Admins can extend/disable; each `/auth` call refreshes the window by the configured duration. Outside that window, requests are blocked (403 `insecure_api_disabled`). Use only behind a trusted network during bootstrap.
- **TLS verification bypass is risky**: Per-host `curl_insecure` (baked as `CODEX_SYNC_ALLOW_INSECURE=1`) disables TLS certificate verification for host sync traffic. This exposes API keys/auth payloads to MITM; prefer trusting the correct CA whenever possible.
- **Installer tokens**: Single-use UUID tokens (`install_tokens` table) with TTL (`INSTALL_TOKEN_TTL_SECONDS`, default 1800s). Creating a new token deletes any prior pending token for that host. Tokens are stored as SHA-256 hashes plus Secretbox-encrypted ciphertext (token + API key); DB access is still sensitive but plaintext is no longer present at rest.
- **Kill switch**: `api_disabled` flag (set via `/admin/api/state`) returns 503 for all non-admin routes. Keep admin access gated so the flag can be cleared.
- **Forwarded IP trust**: Client IP resolution prefers `X-Forwarded-For` / `X-Real-IP`. Ensure your proxy sets and sanitizes these headers before traffic reaches PHP.

## Data Handling

- **Auth payloads**: Stored in `auth_payloads.body` encrypted; per-target tokens in `auth_entries.token` encrypted. Digests are SHA-256 of the canonical JSON. Canonical payloads are validated on read (timestamp bounds, digest match, token quality).
- **Token quality checks**: Tokens must meet entropy/length rules (`TOKEN_MIN_LENGTH` min 8, default 24), no whitespace, not placeholder strings, and must contain enough unique characters.
- **API keys**: Lookups use SHA-256 hashes; encrypted copy kept for dashboard displays/downloads. Do not expose `api_key_enc`/`api_key_hash` outside trusted operators.
- **Secrets**: `.env`, `storage/wrapper/cdx`, `storage/` contents, and DB volumes contain encryption keys, API keys, and auth snapshots—treat them as secrets and include in backup/restore plans.

## Authentication & Authorization

- **Host calls** (`/auth`, `/usage`, `/wrapper*`, `/slash-commands*`, `/host/users`): require API key + IP binding. Roaming must be explicitly allowed per host.
- **Admin routes** (`/admin/*`): mTLS gate by default. Admins can view/upload raw canonical auth and rotate keys—restrict to trusted operators only.
- **Installer** (`/install/{token}`): public endpoint that returns a shell script; token is validated for expiry/one-time use and tags host/base URL. Returned script bakes API key/FQDN/base URL into the wrapper.
- **Runner**: Optional external validator invoked daily/on store and on admin trigger. Runner receives full auth JSON; deploy it on a trusted, TLS-protected network and secure the endpoint separately (no auth headers are sent by default).

## Abuse Controls

- **Global rate limit**: Configured via `RATE_LIMIT_GLOBAL_PER_MINUTE` and `RATE_LIMIT_GLOBAL_WINDOW` (defaults 120 req/60s) for non-admin paths.
- **Auth-fail rate limit**: `RATE_LIMIT_AUTH_FAIL_COUNT`/`WINDOW`/`BLOCK` guard repeated bad API keys and respond 429 with reset hints.
- **Pruning**: Hosts inactive for 30 days (configurable in Admin Settings → General; 0 disables), never provisioned within 30 minutes, or with `expires_at` in the past are pruned and logged (`host.pruned`). `expires_at` is refreshed on successful host contact (2-hour idle window) for temporary/rescue hosts.

## Logging & PII

- Logs (`logs` table) capture actions, digests, and IP metadata but not tokens. Token usage lines are sanitized to strip ANSI/control characters and capped to 1000 chars.
- Admin endpoints can return canonical auth bodies when explicitly requested; avoid enabling this unless necessary and ensure transport security.

## Backup & Recovery

- Back up the MySQL database **and** `.env` (contains `AUTH_ENCRYPTION_KEY`). Without the key, encrypted auth payloads and API keys cannot be decrypted.
- Wrapper storage (`storage/wrapper/cdx`) is the source of truth for wrapper version/sha; include it in backups if you customize the wrapper.

## Operational Notes

- Keep the public base URL consistent; installer scripts validate it and bake it into the wrapper.
- When using forward proxies/CDN, strip inbound `X-Forwarded-For`/`X-Real-IP` from untrusted clients to prevent IP spoofing of the binding logic.
- Runner IP bypass (`AUTH_RUNNER_IP_BYPASS`, `AUTH_RUNNER_BYPASS_SUBNETS`) should be scoped tightly; otherwise the runner could rebind host IPs indirectly.
