# Admin Dashboard

Operator crib sheet for the `/admin/` UI (mTLS by default, see below). If you change behavior, also keep `docs/interface-api.md` and friends in sync—this doc is meant to be the human-friendly map, not a second source of truth.

## Access & Auth
- Base path: `/admin/`.
- mTLS is enforced when `ADMIN_ACCESS_MODE=mtls` (default). If you disable it (`ADMIN_ACCESS_MODE=none`), gate the path another way (VPN/firewall).
- Behind a proxy, make sure it forwards `X-MTLS-*` headers and real client IPs.
- Live updates (optional): enable the admin websocket server (`ADMIN_WS_ENABLED=1`) and run `scripts/admin-ws.php` (or the `admin-ws` compose service). `/admin/ws/info` advertises the public `wss://` URL (or set `ADMIN_WS_PUBLIC_URL`). mTLS is enforced by the proxy the same way as `/admin/`.
  - Wire `/admin/ws` through your proxy (e.g., Caddy reverse_proxy to `ADMIN_WS_BIND`) and keep the `X-MTLS-*` headers intact so the websocket server can enforce admin access.

## Page-by-page
- **Overview**: fleet counts, avg refresh age, last log time, GitHub client cache, wrapper version/sha, runner state, quota mode/limit, pricing snapshot (GPT-5.1 by default) and estimated monthly cost, ChatGPT usage snapshot (cached ≤5m), mTLS presence flag, and whether canonical auth is seeded. With admin websockets enabled, these cards live-update from event streams.
- **Hosts**:
  - Table: FQDN, digest freshness, versions, IP, roaming flag, secure/insecure, VIP, IPv4-only, temporary expiry (`expires_at`), curl-insecure, API calls, monthly tokens, recent digests, and recorded users.
- Actions per host: enable/disable insecure window (0–480 min log-ish slider; each `/auth` extends it), toggle secure vs insecure (insecure hosts purge `~/.codex/auth.json` after each run), toggle roaming IPs, toggle IPv4-only (re-bakes curl -4 and clears pinned IP), toggle curl-insecure (bakes `CODEX_SYNC_ALLOW_INSECURE=1`), set per-host model/reasoning overrides, pin Codex version per host, mark VIP (quota never hard-fails), clear canonical auth (reset digest/last_refresh), delete host, view canonical auth (`include_body`); re-register (New Host) to mint a fresh installer token.
  - New Host flow: mint/rotate API key + single-use installer token; optional temporary host (2‑hour sliding expiry) and curl-insecure; insecure hosts auto-open a 30-minute provisioning window.
- **Auth Upload**: seed/replace canonical `auth.json` (system or host-scoped). Runner validation is skipped for this flow.
- **One-time seed command**: generate a `curl -fsSL ... | bash` command that reads the current user’s `~/.codex/auth.json` and posts it to `/seed/auth/{uuid}`. Tokens expire after `AUTH_SEED_TOKEN_TTL_SECONDS` (default 900s) and are invalidated on first use.
- **API Kill Switch**: `/admin/api/state` flag. When enabled, every non-admin route (including `/auth`) returns 503 until you clear it.
- **Quota Mode**: toggle hard-fail vs warn-only and set `limit_percent` (50–100). VIP hosts always operate in warn-only regardless of the global toggle.
- **Prune Policy**: slider for `inactivity_window_days` (0–60, “Never” disables pruning of inactive hosts).
- **cdx Silent Mode**: fleet-wide wrapper quiet mode toggle (syncs to all hosts).
- **Insecure Host Approval**: when enabled, insecure hosts outside their window will wait for admin approval if a websocket client is connected. A modal pops with hostname/FQDN/time and **Enable**/**Cancel** actions; **Allow domain** adds an auto-allow rule for subdomains (revokable in the Insecure hosts toggler list).
- **Usage**: recent token rows with host + reasoning tokens where present (`limit` param).
- **Usage Ingests**: per-ingest aggregates with search/sort (host, client IP, totals, cached/reasoning, cost, payload snapshot). `per_page` max 200; sortable keys include totals and cost.
- **Cost History**: daily input/output/cached/total cost series, up to 180 days, anchored to first recorded usage and driven by the latest pricing snapshot.
- **Tokens**: aggregates by token line (total/input/output/cached/reasoning).
- **Runner**: config + telemetry (enabled, URLs, timeouts, boot id, last ok/fail/check, 24h validation counts). Manual **Run now** forces a validation and reports whether canonical auth changed.
- **ChatGPT Usage**: latest `/wham/usage` snapshot (5-minute cooldown unless forced). **History** shows up to 180 days of percent-used points (5-hour + weekly). With admin websockets enabled, the 5‑hour + weekly limit boxes update live when new snapshots land, and the “Resets in …” timers tick locally between refreshes.
- **Slash Commands**: list/create/update/delete prompt files; delete marks propagate to hosts.
- **Config Builder**: edit the canonical `config.toml` (settings + rendered TOML), synced to hosts on every `cdx` run.
- **AGENTS**: edit the canonical `AGENTS.md` (sha + size shown). Hosts sync it on wrapper runs.
- **MCP Memories**: search/browse memories by text, tags, host, limit (1–200) and delete entries directly from the table (uses the numeric `record_id`).
- **MCP Logs**: recent MCP tool calls (success/failure, method, host, error details).
- **Versions Check**: force-refresh the GitHub client release cache.
- **Codex Version**: in Settings → Operations & Settings, choose `Latest` (tracks GitHub latest stable/full release) or pin the fleet to a specific Codex release (dropdown hides alpha/beta prereleases; the currently pinned/in-use version still shows for visibility).
- **Logs**: recent audit events.
- **Toasts**: `/admin/toasts` emits a transient on-screen notification to connected admin clients (requires admin websocket server).
  - Test mode: successful `/auth` retrieves emit a “CDX authorized” toast so you can verify live websocket delivery.
  - Refused `/auth` attempts emit “CDX refused” toasts for known hosts (host disabled, IP mismatch, installation mismatch, or insecure window closed). Unknown keys are ignored to avoid noise.

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
- Button hover styles are intentionally flat (no glow or lift); if a halo appears, refresh cached `/admin/assets/dashboard.css`.
