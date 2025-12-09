# Admin Access Mode v2

## Goal
Give the admin dashboard a configurable, defense-in-depth access model that fits both human operators (passkeys) and automation (mTLS), while preventing footguns like running with no auth in prod.

## Plan
- **Modes & defaults**: Single enum `ADMIN_ACCESS_MODE={none,mtls_only,passkey_only,mtls_and_passkey}`. Default `mtls_and_passkey` in prod, `mtls_only` acceptable for automation, `none` only in local/dev with a loud guardrail.
- **Edge enforcement**: TLS terminator must own `X-MTLS-*` headers; strip client-supplied copies. Add a sanity check on fingerprint/subject, not just “present”.
- **App enforcement**: Every `/admin/*` route checks the mode. In `mtls_and_passkey`, both factors must be satisfied; in `passkey_only`, mTLS is ignored even if present; in `mtls_only`, passkey challenge is skipped.
- **Passkey session model**: WebAuthn ceremony after mTLS (when required). Store short-lived, origin-bound session; no long-lived cookies. Rate-limit challenges; add CSRF tokens even though headers are non-cookie.
- **Automation policy**: Decide if non-browser admin API calls are allowed. If yes, they’re only valid in `mtls_only` or `mtls_and_passkey` with a “service” flag that bypasses WebAuthn; otherwise block.
- **Guardrails & observability**: Refuse to boot in prod with `ADMIN_ACCESS_MODE=none`. Surface current mode on `/admin/overview`. Emit audit log on mode changes and failed factor checks. Add CSP `frame-ancestors 'none'` + `X-Frame-Options: DENY`.
- **Recovery**: Break-glass token (single-use, TTL) that can flip the mode or register a new passkey, only usable from console or a restricted IP list.
- **Migration**: One feature flag to shadow-enforce (`enforce=false`) and log what would have failed; then flip to enforce once clean.

## Implementation Sketch
- **Config & plumbing**
  - Add `ADMIN_ACCESS_MODE` enum parsing with env defaults per `APP_ENV`.
  - Extend `requireMtls()` to demand `X-MTLS-Fingerprint` (64 hex) and optionally match subject/issuer allowlist.
  - Add `requirePasskeySession()` helper that checks WebAuthn session state on admin routes.
- **Routing policy**
  - Wrapper `requireAdminAccess()` branches on mode:
    - `none`: dev-only, emit warning metric.
    - `mtls_only`: mTLS required; passkey skipped.
    - `passkey_only`: mTLS optional; passkey required.
    - `mtls_and_passkey`: both required; fail closed if either missing.
  - Introduce a `?service=1` override only in `mtls_only|mtls_and_passkey`, gated to CLI/automation use and audited.
- **WebAuthn UX**
  - Login screen after mTLS; JS stores admin key in memory (not localStorage); uses `/admin/passkey/challenge` + `/admin/passkey/verify`.
  - Session cookie HttpOnly+SameSite=Strict, short TTL (e.g., 30m), refreshed on use; invalidate on mode change or IP change.
- **Guardrails**
  - Startup check: if prod && `mode=none`, refuse to boot. If prod && `mode=passkey_only`, warn unless behind `ADMIN_VPN_REQUIRED=1`.
  - Response headers on admin HTML/JSON: `Cache-Control: no-store`, `frame-ancestors 'none'`, `X-Content-Type-Options: nosniff`.
- **Observability & audits**
  - Log structured events: `admin.auth.mode_change`, `admin.auth.mtls_missing`, `admin.auth.passkey_required`, `admin.auth.service_override`.
  - Metrics for challenge attempts, failures, and mode distribution.
- **Rollout**
  - Phase 1: implement mode enum + logging only (`dry_run=true`).
  - Phase 2: enable enforcement in staging with passkey + mTLS seeded.
  - Phase 3: prod flip to `mtls_and_passkey`; keep `mtls_only` as documented break-glass.
