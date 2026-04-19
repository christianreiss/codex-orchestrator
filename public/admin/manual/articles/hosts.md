---
title: Hosts — secure, insecure, unprovisioned
section: Fleet operations
verified: 2026-04-19
sources: src/Http/Controllers/AdminHostController.php, src/Http/Controllers/AdminOverviewController.php, src/Services/AuthService.php, src/Services/InsecureHostWindowService.php, src/Repositories/HostRepository.php, public/admin/assets/dashboard.js, public/admin/index.html
---

A *host* is any machine running `cdx` or `clx` under your orchestrator. The Hosts rail group splits the fleet into four live views, each backed by an endpoint on `AdminOverviewController`. Detail pages live at `/admin/hosts/{id}` and are driven by `AdminHostController`.

## The four tabs

- **All Hosts** — `GET /admin/hosts` (browser loads the SPA; API returns JSON via `AdminOverviewController::hosts()`). Every registered host, regardless of state.
- **Secure** — a filtered view over the same list where `secure = 1` and auth is not currently purged.
- **Insecure** — `GET /admin/hosts/insecure` (`AdminOverviewController::hostsInsecure`). Hosts whose credentials are purged after each run, plus the pending approval queue.
- **Unprovisioned** — hosts that have registered but never completed their first sync. They appear immediately after `POST /admin/hosts/register` and disappear once `/sync/status` sees them.

The rail shortcuts `[h][a]`, `[h][s]`, `[h][i]`, `[h][u]` map onto the four views; `[h][n]` opens the *New Host* modal.

## Registering a host

`POST /admin/hosts/register` creates the host row and returns an install token. The method lives on `AdminHostController::register` (line 1108) and is gated by `hosts.manage`. Inputs:

- `fqdn` — the canonical hostname you want to assign.
- `secure` — true for a normal host, false to open it insecure-by-default with a one-shot window.
- `engines` — array of `codex` / `claude` the host will run.
- `insecure_window_minutes` — if insecure on registration, the grace window (clamped between `AuthService::MIN_INSECURE_WINDOW_MINUTES` and `MAX_INSECURE_WINDOW_MINUTES = 480`).

The response contains an install URL. Until the host completes its first sync it sits under *Unprovisioned*.

## Host detail page

Visiting `/admin/hosts/{id}` loads the SPA with `viewMode = 'host-detail'`. The page pulls its data from `GET /admin/hosts/{id}/detail` (`AdminOverviewController::hostDetail`) and the canonical auth body from `GET /admin/hosts/{id}/auth` (`AdminHostController::auth`). Every mutating control on the page maps to a `POST /admin/hosts/{id}/...` or `DELETE /admin/hosts/{id}` under `AdminHostController`:

| Action | Endpoint | Controller method |
|--------|----------|-------------------|
| Delete host | `DELETE /admin/hosts/{id}` | `delete` |
| Clear baked auth | `POST /admin/hosts/{id}/clear` | `clear` |
| Toggle roaming (IP re-binding) | `POST /admin/hosts/{id}/roaming` | `roaming` |
| Mark secure / insecure | `POST /admin/hosts/{id}/secure` | `secure` |
| Toggle VIP (bypass quota) | `POST /admin/hosts/{id}/vip` | `vip` |
| Toggle scaling exempt | `POST /admin/hosts/{id}/scaling-exempt` | `scalingExempt` |
| Override auto-update | `POST /admin/hosts/{id}/auto-update` | `autoUpdate` |
| Enable insecure window | `POST /admin/hosts/{id}/insecure/enable` | `insecureEnable` |
| Disable insecure window | `POST /admin/hosts/{id}/insecure/disable` | `insecureDisable` |
| Set per-host model | `POST /admin/hosts/{id}/model` | `model` |
| Pin Codex version | `POST /admin/hosts/{id}/codex-version` | `codexVersion` |
| Pin AGENTS.md version | `POST /admin/hosts/{id}/agents-version` | `agentsVersion` |
| Set reverse-DNS mode | `POST /admin/hosts/{id}/reverse-dns` | `reverseDns` |
| Run "curl insecure" probe | `POST /admin/hosts/{id}/curl-insecure` | `curlInsecure` |

All of these require `hosts.manage` except the insecure-approval endpoints (`hosts.activate`).

## The insecure approval queue

When an insecure host is outside its grace window and tries to pull auth, `AuthService::handleAuth()` does not hand over the payload. Instead, it creates a row in `InsecureAuthRequestRepository` (a pending approval). The queue is visible at the top of the *Insecure* tab and also as a banner in the rail (`navInsecureHosts` button, auto-shown when the count is positive).

The review endpoints on `AdminHostController`:

- `GET /admin/insecure-approvals/pending` — list pending approvals (`insecureApprovalPending`).
- `POST /admin/insecure-approvals/{id}/approve` — approve and hand out auth (`insecureApprovalApprove`).
- `POST /admin/insecure-approvals/{id}/deny` — deny and log (`insecureApprovalDeny`).
- `POST /admin/insecure-approvals/{id}/allow-domain` — add the requester's domain to the trusted list for a grace period (`insecureApprovalAllowDomain`).
- `POST /admin/insecure-domain-allows/{id}/revoke` — reverse a previous domain allow.

All four require `hosts.activate`. `trusted_user` accounts can work the queue without touching anything else.

## Pruning stale hosts

Hosts that have not checked in for a long time can be auto-deleted. `POST /admin/prune-policy` (`AdminSettingsController::postPrunePolicy`) sets the policy; `AuthService::pruneStaleHosts()` runs the removal during the periodic preflight. There is no confirmation modal for this; adjust the policy in *Settings → General*.

## Signals you will see

- **Green lock** — host is secure and has valid baked auth on disk.
- **Amber clock** — host is inside an insecure grace window (`insecure_enabled_until > now`).
- **Red pause** — host is insecure outside its window; auth is held back until an admin approves.
- **Grey dash** — host has never synced; it is unprovisioned.

The host detail page also shows the last `sync_status` digest, IP binding, reverse-DNS verdict, auto-update flag, and the current baked wrapper SHA so you can tell at a glance whether the host is up-to-date.

## Source references

- src/Http/Controllers/AdminHostController.php (full per-host REST surface)
- src/Http/Controllers/AdminOverviewController.php (fleet listings, insecure tab, host detail JSON)
- src/Services/AuthService.php (host registration, handleAuth, pruneStaleHosts)
- src/Services/InsecureHostWindowService.php (grace window maths, approval helpers)
- src/Repositories/HostRepository.php (host state columns)
- src/Repositories/InsecureAuthRequestRepository.php (approval queue)
- src/Repositories/InsecureDomainAllowRepository.php (domain allow-list)
- public/admin/assets/dashboard.js (hosts table, host-detail panel logic)
- public/admin/index.html (hosts and host-detail panels, insecure banner button)
