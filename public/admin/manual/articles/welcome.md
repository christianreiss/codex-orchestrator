---

title: Welcome to Orchestrator
section: Orientation
verified: 2026-06-05
sources: README.md, api/src/server.ts, api/src/routes/admin/pages/static.ts, api/src/services/admin-auth.ts, api/src/http/plugins/auth-admin.ts, frontend/src/lib/nav.ts, frontend/src/routes/dashboard/+page.svelte, frontend/src/lib/components/ShortcutsModal.svelte
---

Codex Orchestrator is a self-hosted service that keeps **OpenAI Codex** and **Anthropic Claude Code** in sync across every machine you own. You upload your credentials once, register each machine as a *host*, and the orchestrator then distributes encrypted auth payloads, pushes the shared `AGENTS.md`, serves canonical skills through MCP, and collects usage back from every run. Each host gets its own API key baked into a wrapper binary (`cdx` for Codex, `clx` for Claude); there is no shared token pasted across machines.

This manual is the in-app operator reference. Every article is written from the live codebase — filenames in each *Source references* footer point at the exact code the article describes.

## Who uses this admin

The admin surface is gated by `app.requireAdmin` (the Fastify decorator added by `api/src/http/plugins/auth-admin.ts`). It reads the cookie named by `ADMIN_SESSION_COOKIE` (default `codex_admin_session`), hashes the token, joins `adminSessions` + `adminUsers`, and checks expiry and `user.active`. The session TTL defaults to 12 hours (`ADMIN_SESSION_TTL_MINUTES`, clamped to 5 min – 7 days). `requireAdmin` itself is mode-unaware: it does not inspect `ADMIN_ACCESS_MODE`. Transport-layer concerns (mTLS header parsing via the separate `auth-mtls` plugin) are handled outside this decorator.

`ADMIN_ACCESS_MODE` (default `mtls`) is declared in `env.ts` and consumed by `cli-auth/index.ts` for the CLI login guard; it does not affect the cookie check that `requireAdmin` performs.

Once at least one admin exists (`AdminAuthService.countAdmins`), a valid session cookie is required for every gated route. Role labels are stored on `admin_users.access_level` — `owner`, `admin`, `viewer`, plus the legacy constants `fleet_operator` (`ROLE_FLEET`) and `trusted_user` (`ROLE_TRUSTED`). Today the API distinguishes "authenticated admin" from "not authenticated"; every gated route hangs off `app.requireAdmin`. The role string is surfaced in *Settings → Users* and is the hook for upcoming finer-grained gating.

## How the admin is laid out

The admin is a single-page SvelteKit app whose HTML shell is returned by the Fastify static handler (`adminSpaHtmlPreHandler` in `api/src/routes/admin/pages/static.ts`). On boot the SPA hydrates by calling `GET /admin/auth/status` to learn who (if anyone) is signed in. The root route immediately redirects to `/dashboard`.

The left rail contains seven top-level navigation items:

- **Dashboard** — at `/dashboard`, fed by `GET /admin/overview`. Displays four stat cards (Hosts, Tokens today, Tokens 7d, Tokens 30d), a DashboardAlerts row, side-by-side ChatGPT and Claude usage cards, and a RunnerCard.
- **Hosts** — fleet management at `/hosts`. Each host has its own detail page.
- **Projects** — top-level project management at `/projects`.
- **API Keys** — API key management at `/api-keys`.
- **Authoring** — skills and memories at `/authoring`.
- **Logs** — API logs at `/logs/api`.
- **Settings** — operator configuration at `/settings`.

The sidebar footer contains a **Help & Manual** link to `/manual`; this is not a primary nav item.

An account menu on the right holds theme selection, passkey / password management, and the logout button. A keyboard-shortcut modal opens on `[?]`. The registered shortcuts are: `Mod+K` (command palette), `/` (focus search), `?` (show shortcuts list), and `Esc` (close overlay).

## The reading path we suggest

If this is your first time here, read the first three articles in order:

1. [Welcome](/admin/manual/welcome) — this page.
2. [Architecture at a glance](/admin/manual/architecture) — how requests flow through the app.
3. [Installing and bootstrapping](/admin/manual/install) — first boot and how hosts come online.

Then dip into whichever section you need. The left rail is grouped so you can find things by topic; the search box filters by title, summary, section, and individual headings from the full body text.

## Conventions used in the manual

- **Paths** like `api/src/services/host-auth.ts` refer to files in this repository. They are deliberate pointers you can open in your editor.
- **Routes** are shown as method + path as registered in `api/src/routes/**`. Mounted by `api/src/routes/index.ts`.
- **Engines** — "Codex" and "Claude" — follow the `Engine` union in `api/src/util/engine.ts`: `ENGINE_CODEX` and `ENGINE_CLAUDE`. A host may run either or both.

## When an article is wrong

Each article is stamped with a `verified:` date visible as the pill at the top. If the code has drifted since that date — new endpoint, renamed service, removed flag — prefer the code over the manual and file a correction.

## Source references

- README.md
- api/src/server.ts (Fastify boot, plugin order)
- api/src/routes/admin/pages/static.ts (SPA shell + adminSpaHtmlPreHandler)
- api/src/services/admin-auth.ts (sessions, role constants, countAdmins)
- api/src/http/plugins/auth-admin.ts (requireAdmin, resolveAdmin)
- api/src/env.ts (ADMIN_ACCESS_MODE, ADMIN_SESSION_COOKIE, ADMIN_SESSION_TTL_MINUTES)
- frontend/src/lib/nav.ts (left rail navigation items)
- frontend/src/routes/dashboard/+page.svelte (dashboard layout and stat cards)
- frontend/src/lib/components/ShortcutsModal.svelte (keyboard shortcuts)
