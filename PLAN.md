# Admin UI Migration Checklist (single routed page)

Goal: one `/admin` shell, hash-routed, no standalone HTML leaks. Sections and tabs must mirror current functionality before cutover.

## Global prerequisites
- [x] Keep `/admin` front controller only; assets under `/admin/assets/*`.
- [x] Hash router drives panel visibility; deep links supported (basic hash→data attributes in index.html).
- [x] Guard JS init so modules run only when their panel is shown (router hooks wired to lazy init).

## Top-level tabs
- [x] Dashboard (shell stub present)
- [x] Hosts (subtabs scaffolded: All, Secure, Insecure, Unprovisioned)
- [x] Logs (subtabs scaffolded: API logs, MCP logs)
- [x] Settings (subtabs scaffolded: General, Agents, Slash commands, Memories, config.toml)

## Page migrations
- [x] Dashboard: move content/metrics from legacy index.html; hook existing dashboard.js overview fetch; add summary grid.
- [x] Hosts: migrate hosts.html table + filters + modals; ensure tab filters map to hostStatusFilter logic (hash-driven).
- [x] Logs: migrate logs.html + mcp-logs.html into one panel with subtabs; tab-driven lazy init for logs modules.
- [x] Settings/General: content pasted (quota/kill/silent/insecure/runner).
- [x] Settings/Agents: content pasted.
- [x] Settings/Slash commands: content pasted.
- [x] Settings/Memories: content pasted.
- [x] Settings/config.toml: content pasted.

## Auth/display correctness
- [x] mTLS/passkey chips read from `/admin/overview` (session-aware passkey).
- [x] No “Passkey OK” without session; no mTLS OK without valid fingerprint.

## Routing & nav
- [x] Top nav uses hashes only; no links to legacy .html files.
- [x] Subtabs update hash fragments (e.g., `#hosts/secure`, `#logs/mcp`, `#settings/config`).
- [x] Deep-linking restores correct tab/panel on load.

## Cleanup
- [x] Remove or ignore legacy HTML files from nav; optional delete after migration.
- [x] Apache/Caddy already funnel `/admin/*` to PHP; assets load via `/admin/assets/*`.

## Verification
- [x] Smoke: `#dashboard`, `#hosts`, `#hosts/secure`, `#logs/api`, `#logs/mcp`, `#settings/general`, `#settings/agents`, `#settings/prompts`, `#settings/memories`, `#settings/config`.
- [x] cdx runner status and mTLS/passkey chips display correctly on pages.

## Out of scope (explicitly deferred)
- [x] Backend refactors (not required for SPA migration in this pass).
