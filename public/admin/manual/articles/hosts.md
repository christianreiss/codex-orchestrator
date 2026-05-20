---
title: Hosts — secure, insecure, unprovisioned
section: Fleet operations
verified: 2026-05-20
sources: api/src/routes/admin/hosts/index.ts, api/src/routes/admin/overview/index.ts, api/src/services/host-auth.ts, api/src/services/host-management.ts, api/src/services/insecure-window-admin.ts, api/src/db/schema.ts
---

A *host* is any machine running `cdx` or `clx` under your orchestrator. The Hosts rail group splits the fleet into four live views, each backed by a JSON endpoint on the admin overview surface. Detail pages live at `/admin/hosts/{id}` and are driven by `api/src/routes/admin/hosts/index.ts`.

## The four tabs

- **All Hosts** — `GET /admin/hosts` returns the full host list (the same URL serves the SPA shell for browsers; JSON callers get the list).
- **Secure** — a filtered view over the same list where `secure = 1` and auth is not currently purged.
- **Insecure** — `GET /admin/hosts/insecure` returns insecure hosts plus the pending approval queue.
- **Unprovisioned** — hosts that have registered but never completed their first sync. They appear immediately after `POST /admin/hosts/register` and disappear once `/sync/status` sees them.

The rail shortcuts `[h][a]`, `[h][s]`, `[h][i]`, `[h][u]` map onto the four views; `[h][n]` opens the *New Host* modal.

## Registering a host

`POST /admin/hosts/register` creates the host row and returns an install token; the route lives in `api/src/routes/admin/hosts/index.ts` and is gated by `app.requireAdmin`. `POST /admin/hosts/quick-register` is the abbreviated form used by *Quick VM*. Inputs:

- `fqdn` — the canonical hostname you want to assign.
- `secure` — true for a normal host, false to open it insecure-by-default with a one-shot window.
- `engines` — array of `codex` / `claude` the host will run. Defaults come from `DEFAULT_HOST_ENGINES`.
- `insecure_window_minutes` — if insecure on registration, the grace window (clamped between `MIN_INSECURE_WINDOW_MINUTES = 0` and `MAX_INSECURE_WINDOW_MINUTES = 480`, see `api/src/services/host-management.ts`).

The response contains an install URL. Until the host completes its first sync it sits under *Unprovisioned*.

## Host detail page

Visiting `/admin/hosts/{id}` loads the SPA. The page pulls its data from `GET /admin/hosts/{id}/detail` and the canonical auth body from `GET /admin/hosts/{id}/auth`. Every mutating control on the page maps to a `POST /admin/hosts/{id}/...` or `DELETE /admin/hosts/{id}` route:

| Action | Endpoint |
|--------|----------|
| Delete host | `DELETE /admin/hosts/{id}` |
| Clear baked auth | `POST /admin/hosts/{id}/clear` |
| Toggle roaming (IP re-binding) | `POST /admin/hosts/{id}/roaming` |
| Mark secure / insecure | `POST /admin/hosts/{id}/secure` |
| Toggle VIP (bypass quota) | `POST /admin/hosts/{id}/vip` |
| Toggle scaling exempt | `POST /admin/hosts/{id}/scaling-exempt` |
| Override auto-update | `POST /admin/hosts/{id}/auto-update` |
| Enable insecure window | `POST /admin/hosts/{id}/insecure/enable` |
| Disable insecure window | `POST /admin/hosts/{id}/insecure/disable` |
| Set per-host model | `POST /admin/hosts/{id}/model` |
| Pin Codex version | `POST /admin/hosts/{id}/codex-version` |
| Pin Claude version | `POST /admin/hosts/{id}/claude-version` |
| Pin AGENTS.md version | `POST /admin/hosts/{id}/agents-version` |
| Set reverse-DNS mode | `POST /admin/hosts/{id}/reverse-dns` |
| Toggle BrowserOS MCP | `POST /admin/hosts/{id}/browseros-mcp` |
| Run "curl insecure" probe | `POST /admin/hosts/{id}/curl-insecure` |
| Get installer script | `GET /admin/hosts/{id}/installer` |

All of these require an authenticated admin session (`app.requireAdmin`).

## The insecure approval queue

When an insecure host is outside its grace window and tries to pull auth, `host-auth.ts` does not hand over the payload. Instead, it creates a row in `insecure_auth_requests` (a pending approval). The queue is visible at the top of the *Insecure* tab and also as a banner in the rail (auto-shown when the count is positive).

The review endpoints (also in `api/src/routes/admin/hosts/index.ts`):

- `GET /admin/insecure-approvals/pending` — list pending approvals.
- `POST /admin/insecure-approvals/{id}/approve` — approve and hand out auth.
- `POST /admin/insecure-approvals/{id}/deny` — deny and log.
- `POST /admin/insecure-approvals/{id}/allow-domain` — add the requester's domain to the trusted list for a grace period.
- `POST /admin/insecure-domain-allows/{id}/revoke` — reverse a previous domain allow.
- `POST /admin/hosts/insecure/extend` — extend the active window for all insecure hosts.
- `POST /admin/hosts/insecure/disable-all` — close every insecure window at once.

## Pruning stale hosts

Hosts that have not checked in for a long time can be auto-deleted. `POST /admin/prune-policy` sets the policy; the cleanup runs during the periodic preflight. There is no confirmation modal for this; adjust the policy in *Settings → General*.

## Signals you will see

- **Green lock** — host is secure and has valid baked auth on disk.
- **Amber clock** — host is inside an insecure grace window (`insecure_enabled_until > now`).
- **Red pause** — host is insecure outside its window; auth is held back until an admin approves.
- **Grey dash** — host has never synced; it is unprovisioned.

The host detail page also shows the last `sync_status` digest, IP binding, reverse-DNS verdict, auto-update flag, and the current baked wrapper SHA so you can tell at a glance whether the host is up-to-date.

## Source references

- api/src/routes/admin/hosts/index.ts (every /admin/hosts/* mutation, insecure approvals)
- api/src/routes/admin/overview/index.ts (fleet listings, insecure tab, host detail JSON)
- api/src/services/host-auth.ts (handleAuth, refusal codes)
- api/src/services/host-management.ts (registration, mutations, insecure-window clamps)
- api/src/services/insecure-window-admin.ts (approval helpers)
- api/src/db/schema.ts (hosts, insecure_auth_requests, insecure_domain_allows)
