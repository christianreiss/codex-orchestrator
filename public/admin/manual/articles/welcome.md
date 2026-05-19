---
title: Welcome to Orchestrator
section: Orientation
verified: 2026-04-19
sources: README.md, public/admin/index.html, public/index.php, public/admin/index.php, src/Services/AdminAuthService.php
---

Codex Orchestrator is a self-hosted PHP service that keeps **OpenAI Codex** and **Anthropic Claude Code** in sync across every machine you own. You upload your credentials once, register each machine as a *host*, and the orchestrator then distributes encrypted auth payloads, pushes the shared `AGENTS.md`, serves canonical skills through MCP, and collects usage back from every run. Each host gets its own API key baked into a wrapper binary (`cdx` for Codex, `clx` for Claude); there is no shared token pasted across machines.

This manual is the in-app operator reference. Every article on the left is written from the live codebase — filenames and line numbers in each *Source references* footer point at the exact code the article describes.

## Who uses this admin

The admin surface is gated by `requireAdminAccess()` (`src/Http/helpers.php:210`) which delegates to `AdminSessionHelper::requireAdminAccess()`. Access has two layers:

1. **Transport.** If `ADMIN_ACCESS_MODE` is `mtls` (the default, see `AdminSessionHelper::adminAccessMode`), the reverse proxy must forward a valid client-certificate fingerprint. Setting it to `none` disables the mTLS check; nothing else is a valid value.
2. **Identity.** Once at least one admin exists (`AdminUserRepository::countAdmins`), a session cookie is required. The cookie name defaults to `codex_admin_session` and the session TTL is 8 hours (`ADMIN_SESSION_TTL_SECONDS`, clamped to 5 min – 7 days).

Inside the admin there are four roles, declared as constants on `AdminAuthService`:

- `admin` — every capability, including user management.
- `fleet_operator` — `settings.manage`, `hosts.manage`, `hosts.activate`.
- `trusted_user` — `hosts.activate` only (approve insecure windows).
- `user` — view-only; no capability checks pass.

See the [roles](/admin/manual/roles) article for the full matrix and which screens each role can open.

## How the admin is laid out

The admin is a single-page shell served by `public/admin/index.php` for every `/admin/*` page route. Inside, the left rail groups pages into five areas:

- **Overview** — the dashboard at `/admin/dashboard`, fed by `AdminOverviewController::overview()`.
- **Manual** — this manual, at `/admin/manual`.
- **Hosts** — fleet tabs: all, secure, insecure, unprovisioned. Each host has its own detail page at `/admin/hosts/{id}`.
- **Logs** — API logs (`/admin/logs`), MCP logs (`/admin/logs/mcp`), and audit events (`/admin/logs/events`).
- **Settings** — grouped into Admin (general, users, agents, OpenAI, Claude, API keys), Authoring (skills, memories), and Workspace (projects, profiles).

An account menu on the right holds theme selection (six variants via `data-theme`), passkey / password management, and the logout button. A keyboard-shortcut modal pops on `[?]`; press `[m]` from anywhere to jump back to the manual.

## The reading path we suggest

If this is your first time here, read the first three articles in order:

1. [Welcome](/admin/manual/welcome) — this page.
2. [Architecture at a glance](/admin/manual/architecture) — how requests flow through the app.
3. [Installing and bootstrapping](/admin/manual/install) — first boot and how hosts come online.

Then dip into whichever section you need. The left rail is grouped so you can find things by topic; the search box filters by title, summary, section and individual headings from the full body text.

## Conventions used in the manual

- **Paths** like `src/Services/AuthService.php:478` refer to files in this repository. Click targets are not live yet; they're deliberate pointers you can open in your editor.
- **Routes** are shown with their method and regex as registered in `public/index.php`. The same file is the single source of truth for what is reachable.
- **Capabilities** are shown in code (`settings.manage`, `hosts.manage`, `hosts.activate`, `users.manage`). These string constants live on `AdminAuthService`.
- **Engines** — "Codex" and "Claude" — follow the `App\Support\Engine` constants: `Engine::CODEX` and `Engine::CLAUDE`. A host may run either or both.

## When an article is wrong

Each article is stamped with a `verified:` date visible as the pill at the top. If the code has drifted since that date — new endpoint, renamed service, removed flag — prefer the code over the manual and file a correction. The `scripts/verify-manual-sources.php` helper will at least catch source files that no longer exist.

## Source references

- README.md
- public/admin/index.html (navigation rail, keyboard shortcuts)
- public/admin/index.php (session bootstrap)
- public/index.php (route registrations)
- src/Services/AdminAuthService.php (roles, capabilities, sessions)
- src/Http/helpers.php (requireAdminAccess wrapper)
- src/Http/AdminSessionHelper.php (session + mTLS enforcement)
