# Admin Dashboard

Operator crib sheet for the `/admin/` UI (mTLS by default, see below). If you change behavior, also keep `docs/interface-api.md` and friends in sync—this doc is meant to be the human-friendly map, not a second source of truth.

## Access & Auth
- Base path: `/admin/`.
- mTLS is enforced when `ADMIN_ACCESS_MODE=mtls` (default). If you disable it (`ADMIN_ACCESS_MODE=none`), gate the path another way (VPN/firewall).
- Behind a proxy, make sure it forwards `X-MTLS-*` headers and real client IPs.

## Page-by-page
- **Overview**: fleet counts, avg refresh age, last log time, GitHub client cache, wrapper version/sha, runner state, quota mode/limit, pricing snapshot (GPT-5.1 by default) and estimated monthly cost, ChatGPT usage snapshot (cached ≤5m), mTLS presence flag, and whether canonical auth is seeded.
- **Hosts**:
  - Table: FQDN, digest freshness, versions, IP, roaming flag, secure/insecure, VIP, IPv4-only, API calls, monthly tokens, recent digests, and recorded users.
- Actions per host: enable/disable insecure window (0–480 min log-ish slider; each `/auth` extends it), toggle secure vs insecure (insecure hosts purge `~/.codex/auth.json` after each run), toggle roaming IPs, toggle IPv4-only (re-bakes curl -4 and clears pinned IP), mark VIP (quota never hard-fails), clear canonical auth (reset digest/last_refresh), delete host, view canonical auth (`include_body`); re-register (New Host) to mint a fresh installer token.
  - New Host flow: mint/rotate API key + single-use installer token; insecure hosts auto-open a 30-minute provisioning window.
- **Auth Upload**: seed/replace canonical `auth.json` (system or host-scoped). Runner validation is skipped for this flow.
- **API Kill Switch**: `/admin/api/state` flag. When enabled, every non-admin route (including `/auth`) returns 503 until you clear it.
- **Quota Mode**: toggle hard-fail vs warn-only and set `limit_percent` (50–100). VIP hosts always operate in warn-only regardless of the global toggle.
- **Usage**: recent token rows with host + reasoning tokens where present (`limit` param).
- **Usage Ingests**: per-ingest aggregates with search/sort (host, client IP, totals, cached/reasoning, cost, payload snapshot). `per_page` max 200; sortable keys include totals and cost.
- **Cost History**: daily input/output/cached/total cost series, up to 180 days, anchored to first recorded usage and driven by the latest pricing snapshot.
- **Tokens**: aggregates by token line (total/input/output/cached/reasoning).
- **Runner**: config + telemetry (enabled, URLs, timeouts, boot id, last ok/fail/check, 24h validation counts). Manual **Run now** forces a validation and reports whether canonical auth changed.
- **ChatGPT Usage**: latest `/wham/usage` snapshot (5-minute cooldown unless forced). **History** shows up to 180 days of percent-used points (5-hour + weekly).
- **Slash Commands**: list/create/update/delete prompt files; delete marks propagate to hosts.
- **AGENTS**: edit the canonical `AGENTS.md` (sha + size shown). Hosts sync it on wrapper runs.
- **MCP Memories**: search/browse memories by text, tags, host, limit (1–200) and delete entries directly from the table (uses the numeric `record_id`).
- **Versions Check**: force-refresh the GitHub client release cache.
- **Codex Version**: in Settings → Operations & Settings, choose `Latest` (tracks GitHub latest stable/full release) or pin the fleet to a specific Codex release (dropdown hides alpha/beta prereleases; the currently pinned/in-use version still shows for visibility).
- **Logs**: recent audit events.

## Common workflows
- **Onboard a host**: Overview → ensure canonical auth exists → Hosts → New Host (set secure/insecure, VIP, IPv4-only if needed) → copy installer command → run on target. For insecure hosts, keep the window open or re-enable before `/auth` runs.
- **Rotate auth**: Upload fresh `auth.json` via Auth Upload. Runner is bypassed here; hosts pick up the new digest on next `/auth`.
- **Reopen insecure window**: Hosts → select host → set duration (0–480, log-ish) → enable. Each `/auth` call extends by that duration.
- **Tighten quota**: Quota Mode → set `limit_percent` and choose hard-fail vs warn-only. Remember VIP hosts ignore the hard-fail.
- **Pause the world**: API Kill Switch on; only `/admin/api/state` stays reachable.
- **Check costs/quotas**: Overview for current month + snapshot; Usage/Cost History for trends; ChatGPT Usage/History for account quotas.
- **Troubleshoot runner**: Runner page for last ok/fail, boot id, and logs; use **Run now** to retry after fixes.

## Notes & gotchas
- Installer tokens expire (`INSTALL_TOKEN_TTL_SECONDS`, default 1800s) and are single-use; re-register the host to mint a new one (rotates API key).
- Global rate limits apply to non-admin routes only. Admin pages bypass them but still depend on correct client IP forwarding for host IP binding behavior elsewhere.
- Pricing snapshot drives dashboard costs; if `PRICING_URL` is unset or failing, env defaults (`GPT51_*`, `PRICING_CURRENCY`) are used and cost charts may be zeroed until pricing is available.
- Kill switch and quota settings are persisted; they survive restarts. ChatGPT usage snapshots respect a 5-minute cooldown unless you force refresh.
