---
title: Welcome to Orchestrator
section: Orientation
verified: 2026-05-20
sources: README.md, api/src/server.ts, api/src/routes/admin/pages/static.ts, api/src/services/admin-auth.ts, api/src/http/plugins/auth-admin.ts
---

Codex Orchestrator is a self-hosted service that keeps **OpenAI Codex** and **Anthropic Claude Code** in sync across every machine you own. You upload your credentials once, register each machine as a *host*, and the orchestrator then distributes encrypted auth payloads, pushes the shared `AGENTS.md`, serves canonical skills through MCP, and collects usage back from every run. Each host gets its own API key baked into a wrapper binary (`cdx` for Codex, `clx` for Claude); there is no shared token pasted across machines.

This manual is the in-app operator reference. Every article on the left is written from the live codebase — filenames in each *Source references* footer point at the exact code the article describes.

## Who uses this admin

The admin surface is gated by `app.requireAdmin` (the Fastify decorator added by `api/src/http/plugins/auth-admin.ts`) which validates a session cookie against `admin_sessions`. Access has two layers:

1. **Transport.** If `ADMIN_ACCESS_MODE` is `mtls` (the default), the reverse proxy must forward an mTLS fingerprint header. Setting it to `open` disables the transport check; `cookie` is the same as `mtls` minus the fingerprint requirement.
2. **Identity.** Once at least one admin exists (`AdminAuthService.countAdmins`), a session cookie is required. The cookie name defaults to `codex_admin_session` and the session TTL is 12 hours (`ADMIN_SESSION_TTL_MINUTES`, clamped to 5 min – 7 days).

Inside the admin there are several role labels stored on `admin_users.access_level` — `owner`, `admin`, `viewer`, plus the legacy `fleet_operator`, `trusted_user`, and `user` rows kept for forward-compat. Today the API only distinguishes "authenticated admin" from "not authenticated" — every gated route hangs off `app.requireAdmin`. The role string is surfaced in *Settings → Users* and is the hook for upcoming finer-grained gating; see the [roles](/admin/manual/roles) article for the current matrix.

## How the admin is laid out

The admin is a single-page Svelte app whose HTML shell is returned by the Fastify static handler (`adminSpaHtmlPreHandler` in `api/src/routes/admin/pages/static.ts`). On boot the SPA hydrates by calling `GET /admin/auth/status` to learn who (if anyone) is signed in. Inside, the left rail groups pages into five areas:

- **Overview** — the dashboard at `/admin/dashboard`, fed by `GET /admin/overview`.
- **Manual** — this manual, at `/admin/manual`.
- **Hosts** — fleet tabs: all, secure, insecure, unprovisioned. Each host has its own detail page at `/admin/hosts/{id}`.
- **Logs** — API logs (`/admin/logs`), MCP logs (`/admin/mcp/logs`), and audit events (read from the logs surface with a type filter).
- **Settings** — grouped into Admin (general, users, agents, OpenAI, Claude, API keys), Authoring (skills, memories), and Workspace (projects, profiles).

An account menu on the right holds theme selection, passkey / password management, and the logout button. A keyboard-shortcut modal pops on `[?]`; press `[m]` from anywhere to jump back to the manual.

## The reading path we suggest

If this is your first time here, read the first three articles in order:

1. [Welcome](/admin/manual/welcome) — this page.
2. [Architecture at a glance](/admin/manual/architecture) — how requests flow through the app.
3. [Installing and bootstrapping](/admin/manual/install) — first boot and how hosts come online.

Then dip into whichever section you need. The left rail is grouped so you can find things by topic; the search box filters by title, summary, section and individual headings from the full body text.

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
