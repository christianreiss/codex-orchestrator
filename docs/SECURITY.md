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

- **TLS/mTLS for admin**: Admin routes require mTLS by default (`ADMIN_ACCESS_MODE=mtls`). If you disable mTLS (`ADMIN_ACCESS_MODE=none`), put the admin surface behind VPN/firewall; admin login is enforced once at least one active admin user exists.
- **Admin sessions**: Admin login uses an HTTP-only session cookie (`ADMIN_SESSION_COOKIE`) with a configurable TTL (`ADMIN_SESSION_TTL_SECONDS`, clamped between 300 and 604800 seconds). Treat admin cookies as sensitive and ensure TLS is enforced end-to-end.
- **Password reset routes**: `POST /admin/auth/password/request` and `POST /admin/auth/password/reset` return HTTP 410 (`Password reset is disabled`). Treat password reset as unavailable.
- **API key binding**: Host API keys are IP-bound on first successful authenticated host request. Later calls from a different IP are 403 unless roaming is allowed, insecure-host IP override/grace applies, or runner CIDR bypass matches (`AUTH_RUNNER_IP_BYPASS` + `AUTH_RUNNER_BYPASS_SUBNETS`).
- **Reverse DNS checks**: When enabled, forward A/AAAA + PTR matching is enforced only on routes calling `authenticate(..., enforceReverseDns=true)` (`POST /auth`, `DELETE /auth`, `POST /sync/status`, `POST /sync/bootstrap`).
- **Encryption at rest**: Canonical auth bodies and per-target tokens are encrypted with libsodium `secretbox` (`sbox:v1:` legacy, `sbox:v1:kid=<id>:` rotation-aware) using `AUTH_ENCRYPTION_KEY` or keyring mode (`AUTH_ENCRYPTION_KEYS` + `AUTH_ENCRYPTION_ACTIVE_KID`). Host API keys are hashed (SHA-256) for lookup and also stored encrypted (`api_key_enc`).
- **Rate limits**: Global IP bucket (default 120 req / 60s, non-admin) and a dedicated auth-failure bucket (default 20 fails / 10m, 30m block) backed by `ip_rate_limits`.
- **Insecure host windows**: Hosts marked `secure=false` use a sliding window (`insecure_enabled_until`, 0–480 minutes, default stored window 10; initial provisioning window 30). Window enforcement currently applies to `/auth` retrieve-style calls and routes calling `enforceInsecureWindow` (`POST /mcp`, `GET/POST /host/lane`). `store` uploads are not blocked by this window gate in `handleAuth`; they still require normal auth/IP/reverse-DNS/runner checks. Admin disable operations clear both `insecure_enabled_until` and `insecure_grace_until`.
- **Insecure domain auto-allow**: Active `insecure_domain_allows` entries can auto-open insecure windows for matching subdomains.
- **TLS verification bypass is risky**: Per-host `curl_insecure` (baked as `CODEX_SYNC_ALLOW_INSECURE=1`) disables TLS certificate verification for host sync traffic. This exposes API keys/auth payloads to MITM; prefer trusting the correct CA whenever possible.
- **Installer tokens**: Single-use UUID tokens (`install_tokens` table) with TTL (`INSTALL_TOKEN_TTL_SECONDS`, default 1800s). Creating a new token deletes any prior pending token for that host. Tokens are stored as SHA-256 hashes plus Secretbox-encrypted ciphertext (token + API key); DB access is still sensitive but plaintext is no longer present at rest.
- **Kill switch**: `api_disabled` flag (set via `/admin/api/state`) returns 503 for every route except exact path `/admin/api/state`.
- **Forwarded IP trust**: `X-Real-IP`/`X-Forwarded-*` are honored only when `TRUST_X_FORWARDED=1` and `REMOTE_ADDR` matches `TRUSTED_PROXY_CIDRS`; otherwise `REMOTE_ADDR` is authoritative.
- **MCP origin allowlist**: `/mcp` checks `Origin` against `MCP_ALLOWED_ORIGINS` and `PUBLIC_BASE_URL`. Optional request-host auto-allow is controlled by `MCP_ALLOW_REQUEST_HOST_ORIGIN` (default off). Empty `Origin` is allowed; non-matching origins are rejected with 403.
- **MCP privilege boundary**: host-authenticated `POST /mcp` uses dedicated MCP credentials (`authenticateMcpCredential`) and only exposes host-safe memory/resource/project tools. Coordinator filesystem helpers (`fs_*`) are not available on that public route.

## Data Handling

- **Auth payloads**: Stored in `auth_payloads.body` encrypted; per-target tokens in `auth_entries.token` encrypted. Digests are SHA-256 of the canonical JSON. Canonical payloads are validated on read (timestamp bounds, digest match, token quality).
- **Token quality checks**: Tokens must meet entropy/length rules (`TOKEN_MIN_LENGTH` min 8, default 24), no whitespace, not placeholder strings, and must contain enough unique characters.
- **API keys**: Lookups use SHA-256 hashes; encrypted copy kept for dashboard displays/downloads. Do not expose `api_key_enc`/`api_key_hash` outside trusted operators.
- **Secrets**: `.env` and DB data/volumes contain encryption key material, API key ciphertexts/hashes, and encrypted auth/token snapshots. Installer and wrapper downloads also contain plaintext API keys for the target host; treat those responses/logging paths as sensitive.

## Authentication & Authorization

- **Host-authenticated routes**: `POST/DELETE /auth`, `POST /sync/status`, `POST /sync/bootstrap`, `/wrapper*`, `/usage`, `/host/users`, `/host/lane`, `/agents/retrieve`, `/config/retrieve`, `/skills*`, `/mcp/memories/*`, and `POST /mcp` require API key authentication and IP binding (subject to roaming/insecure overrides/runner CIDR bypass rules).
- **Admin routes** (`/admin/*`): mTLS gate by default. Admins can view/upload raw canonical auth and rotate keys—restrict to trusted operators only.
- **Installer** (`/install/{token}`): public endpoint that returns a shell script; token is validated for expiry/one-time use and tags host/base URL plus installer mode. Returned script bakes API key/FQDN/base URL into the engine-appropriate wrapper(s).
- **Installation binding**: If a client sends `installation_id` and it does not match server `INSTALLATION_ID`, auth calls are rejected with `403 installation_mismatch`. Omitted `installation_id` is accepted for legacy clients.
- **Runner**: Optional external validator invoked on preflight/store/admin trigger when configured (`AUTH_RUNNER_URL`). Runner requests can be authenticated with `AUTH_RUNNER_SHARED_SECRET`/`RUNNER_SHARED_SECRET` (`X-Runner-Auth` header).

## Abuse Controls

- **Global rate limit**: Configured via `RATE_LIMIT_GLOBAL_PER_MINUTE` and `RATE_LIMIT_GLOBAL_WINDOW` (defaults 120 req/60s) for non-admin paths.
- **Auth-fail rate limit**: `RATE_LIMIT_AUTH_FAIL_COUNT`/`RATE_LIMIT_AUTH_FAIL_WINDOW`/`RATE_LIMIT_AUTH_FAIL_BLOCK` guard repeated missing/invalid API keys and respond 429 with `bucket` + `reset_at`.
- **Pruning**: Hosts are pruned/logged as `host.pruned` when inactive past `inactivity_window_days` (default 30, max 60, 0 disables inactivity pruning), never provisioned for 30 minutes, or expired via `expires_at`. Temporary host `expires_at` is refreshed by successful authenticated contact (+2h).

## Logging & PII

- Logs (`logs` table) capture action metadata (including digests/IP fields where provided). Token usage lines are sanitized to strip ANSI/control characters and capped to 1000 chars.
- Full auth/API tokens are not intentionally logged in normal flows, but install/seed log entries include a short redacted token prefix (first 8 chars + ellipsis).
- Admin endpoints can return canonical auth bodies when explicitly requested; avoid enabling this unless necessary and ensure transport security.

## Backup & Recovery

- Back up the MySQL database **and** `.env` (contains `AUTH_ENCRYPTION_KEY` or `AUTH_ENCRYPTION_KEYS`). Without key material, encrypted auth payloads and API keys cannot be decrypted.
- Wrapper storage (`storage/wrapper/cdx`) is the source of truth for wrapper version/sha; include it in backups if you customize the wrapper.

## Operational Notes

- In production (`APP_ENV=production`), set `PUBLIC_BASE_URL` and keep `PUBLIC_BASE_URL_REQUIRED=1` so startup/health fails fast on misconfiguration.
- When using forward proxies/CDN, set `TRUST_X_FORWARDED=1`, scope `TRUSTED_PROXY_CIDRS` tightly, and strip inbound forwarded headers from untrusted clients.
- Runner IP bypass (`AUTH_RUNNER_IP_BYPASS`, `AUTH_RUNNER_BYPASS_SUBNETS`) should be scoped tightly and defaults to off in `.env.example`.
