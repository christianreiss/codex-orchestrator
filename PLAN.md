# Admin Revamp Plan (single routed page)

## Goals
- [ ] Serve the entire admin experience from one routed entrypoint (`/admin`) instead of discrete HTML files.
- [ ] Centralize auth enforcement: mTLS + passkey handled once, visibly surfaced in UI state.
- [ ] Eliminate static-leak paths: all admin resources flow through PHP routing; assets loaded via that page.
- [ ] Move admin-facing rendering logic into PHP (server-driven routes + JSON endpoints) rather than ad‑hoc API paths.

## Current State (pain points)
- [ ] Multiple static HTML files (`public/admin/*.html`) can bypass new gating rules if the web server maps them directly.
- [ ] Auth gate duplicated in `public/admin/index.php` and `public/index.php`; “last passkey ok” is global, not per session.
- [ ] Caddy/Apache rules are inconsistent; optional mTLS at proxy, but PHP gate expects headers.
- [ ] Admin JS hardcodes paths to several JSON endpoints under `/admin/*` from public/index.php router.

## Target Architecture
- [ ] Single page shell at `/admin` (or `/admin/`) served by `public/admin/index.php`.
- [ ] PHP router dispatches sub-routes (settings, hosts, logs, memories, config builder, agents, etc.) and renders via server-driven views/components or hydrates a JS app with JSON from the same PHP entrypoint.
- [ ] Strict auth middleware (mTLS + passkey) executes before any admin route; passkey becomes per-session (cookie) instead of global flag.
- [ ] Static assets served via versioned paths but only after auth (or from a signed asset bucket if desired).

## Work Plan
- [ ] Routing consolidation: replace per-file HTML with a single routed page; mount sub-routes under `/admin/*` via PHP; add canonical rewrites in Caddy/Apache to funnel everything to the front controller.
- [ ] Auth hardening: add session-bound passkey state (secure, HttpOnly, SameSite=Strict, short TTL, UA/IP binding); keep DB flags for enrollment only; enforce mTLS when required; surface status in UI.
- [ ] UI/UX rebuild: one SPA-like shell (progressive-enhancement friendly) that swaps views via routed states; show mTLS/passkey status + re-auth control; consolidate JS bundles.
- [ ] Backend cleanup: move admin JSON endpoints into a dedicated admin controller layer; standardize responses; align docs (`docs/interface-api.md`, `docs/ADMIN.md`).
- [ ] Tests & smokes: feature tests for all auth mode combos; curl smokes for /admin with/without cert and with/without passkey cookie.

## Risks / Mitigations
- [ ] Session fixation/theft: bind cookie to UA/IP hash + short TTL + secure/httponly/strict.
- [ ] Proxy misconfig: keep explicit header validation; add auth-gated debug endpoint.
- [ ] Regression in admin APIs: shim legacy paths during migration; deprecate with 302 or JSON warning.

## Deliverables
- [ ] Unified admin front controller + templates.
- [ ] Hardened auth middleware with sessionized passkey.
- [ ] Updated Caddy/Apache rewrites and docs.
- [ ] Test suite + smokes demonstrating enforced modes.
