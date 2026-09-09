---

title: Welcome to Orchestrator
section: Orientation
verified: 2026-09-09
sources: README.md, api/src/server.ts, api/src/routes/admin/pages/static.ts, api/src/services/admin-auth.ts, api/src/http/plugins/auth-admin.ts, api/src/security/capabilities.ts, api/src/security/route-capabilities.ts, api/src/env.ts, frontend/src/lib/nav.ts, frontend/src/routes/+page.svelte, frontend/src/routes/setup/+page.svelte, frontend/src/routes/dashboard/+page.svelte, frontend/src/routes/logs/+layout.svelte, frontend/src/lib/components/layout/Sidebar.svelte, frontend/src/lib/components/layout/TopBar.svelte, frontend/src/lib/utils/shortcuts.ts, frontend/src/lib/components/shortcuts/ShortcutsModal.svelte, frontend/src/routes/+layout.svelte, wrappers/cxx
---

Codex Orchestrator is a self-hosted service that keeps **OpenAI Codex** and **Anthropic Claude Code** in sync across every machine you own. You upload your credentials once, register each machine as a *host*, and the orchestrator then distributes encrypted auth payloads, pushes the shared agents document (`AGENTS.md` for Codex, `CLAUDE.md` for Claude), serves canonical skills through MCP, and surfaces ChatGPT quota state for operators. Each host gets its own API key delivered in signed per-engine config consumed by one `cxx` wrapper; relative `cdx` and `clx` aliases select the enabled persona without sharing a token across machines.

This manual is the in-app operator reference. Every article is written from the live codebase — filenames in each *Source references* footer point at the exact code the article describes.

## Who uses this admin

The admin surface is gated by `app.requireAdmin` (the Fastify decorator added by `api/src/http/plugins/auth-admin.ts`). It reads the cookie named by `ADMIN_SESSION_COOKIE` (default `codex_admin_session`), hashes the token, joins `adminSessions` + `adminUsers`, and checks expiry and `user.active`. `ADMIN_SESSION_TTL_MINUTES` defaults to `43200` (30 days) in `api/src/env.ts`. At login, `AdminAuthService.sessionTtlSeconds()` clamps that down to 5 min – 7 days, so a freshly created session starts at 7 days; every subsequent authenticated request then rolls `expiresAt` forward by the same TTL, this time clamped to 30 days by the plugin itself, so an actively used session keeps renewing out to 30 days from its last request. `requireAdmin` itself is mode-unaware: it does not inspect `ADMIN_ACCESS_MODE`. Transport-layer concerns (proxy-forwarded mTLS claims via the separate `auth-mtls` plugin) are handled outside this decorator, and no route authorizes on them.

`ADMIN_ACCESS_MODE` (`cookie` default, or `open`) is declared in `env.ts` and consumed by `cli-auth/index.ts` for the CLI login guard; it does not affect the cookie check that `requireAdmin` performs.

Once at least one admin exists (`AdminAuthService.countAdmins`), a valid session cookie is required for every gated route. Role labels are stored on `admin_users.access_level` — `owner`, `admin`, `viewer`, `fleet_operator` (`ROLE_FLEET`), `trusted_user` (`ROLE_TRUSTED`), and the legacy `user`. `requireAdmin` only authenticates; what each role may *do* is decided by the capability layer in `api/src/security/` — every admin route names one capability, and the role → capability matrix is the sole place a role string is compared against anything. The roster is managed under **Admin Users** (`/users`); see [Roles and capabilities](/admin/manual/roles).

## How the admin is laid out

The admin is a single-page SvelteKit app whose HTML shell is returned by the Fastify static handler (`adminSpaHtmlPreHandler` in `api/src/routes/admin/pages/static.ts`). On boot the SPA hydrates by calling `GET /admin/auth/status` to learn who (if anyone) is signed in. The root route waits for that answer before forwarding to `/dashboard`, and stands down entirely when the installation is unclaimed — then the layout gate owns the navigation and sends you to the setup wizard at `/setup` instead. Redirecting immediately used to race that gate, so a brand-new install opened on a dashboard full of 401s.

The desktop sidebar groups destinations by task:

| Group | Destinations |
|---|---|
| **Monitor** | Overview, Active Clients, Activity |
| **Fleet** | Hosts, Engines, Policies |
| **Coordinate** | Projects, Agent Messaging, Git Director, File Transfer, Agent Portal |
| **Knowledge** | Skills, Fleet Instructions, Memories, Subagents, Commands, Output Styles |
| **Access** | API Access, Secrets, Admin Users |

Groups start expanded. Collapse any group to shorten the list; navigating into it opens it again. The active destination and breadcrumb identify your current location. **Overview** contains engine coverage, Codex and Claude usage, and runner verification. **Engines** holds fleet model and update controls; **Policies** holds fleet operational rules. **Git Director** arbitrates merges between agents sharing a clone, and **File Transfer** is the expiring pool of files agents hand each other. Subagents, Commands, and Output Styles are Claude-native collections.

The footer provides **Manual**, **Account**, **Shortcuts**, and an account menu for password, passkeys, appearance, and sign-out. On phones, Overview, Hosts, Projects, and Activity stay in the bottom bar; **Menu** opens the remaining destinations and account actions. Menu is highlighted when the current page belongs to that group.

Theme selection (Light / Dark / System) lives in the icon menu at the right of the top bar, alongside fleet search and the desktop live-update indicator. Press `Ctrl`/`Cmd`+`K` or `/` to open the command palette, `?` for keyboard help, `n` to register a host, and `Esc` to close an overlay. Single-key shortcuts pause while you type in a form or editor. The palette includes destination descriptions and can find shared engine controls by either **Codex** or **Claude**.

## The reading path we suggest

If this is your first time here, read the first three articles in order:

1. [Welcome](/admin/manual/welcome) — this page.
2. [Architecture at a glance](/admin/manual/architecture) — how requests flow through the app.
3. [Installing and bootstrapping](/admin/manual/install) — the `bin/install.sh` installer, the nine-step first-run wizard at `/setup`, and how hosts come online.

If you arrived here mid-setup, that third article is the one you want: it covers what each wizard step writes, which two steps block, and why the Fleet defaults step is the one you should not skip.

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
- api/src/services/admin-auth.ts (login-time session TTL clamp, role constants, countAdmins)
- api/src/http/plugins/auth-admin.ts (requireAdmin, resolveAdmin, rolling session TTL clamp)
- api/src/security/capabilities.ts, api/src/security/route-capabilities.ts (role → capability matrix and the per-route inventory)
- api/src/env.ts (ADMIN_ACCESS_MODE, ADMIN_SESSION_COOKIE, ADMIN_SESSION_TTL_MINUTES)
- frontend/src/routes/+page.svelte (the `/admin` front door and its wait-for-auth behaviour)
- frontend/src/routes/setup/+page.svelte (first-run wizard)
- frontend/src/lib/nav.ts (left rail navigation items)
- frontend/src/routes/dashboard/+page.svelte (dashboard layout and stat cards)
- frontend/src/routes/logs/+layout.svelte (Logs tabs: MCP, Events)
- frontend/src/lib/components/layout/Sidebar.svelte (left rail, footer links, account dropdown)
- frontend/src/lib/components/layout/TopBar.svelte (theme menu, command palette launcher)
- frontend/src/lib/utils/shortcuts.ts (global shortcut key bindings)
- frontend/src/lib/components/shortcuts/ShortcutsModal.svelte (shortcuts list dialog)
- frontend/src/routes/+layout.svelte (wires shortcuts + Mod+K to app actions)
