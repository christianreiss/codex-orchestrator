# Codex-Orchestrator Admin UI — Design Spec & Visual Makeover Brief

**Audience for this document:** a designer or design-capable LLM ("Claude Design") who will produce a
new visual layer for the existing admin pages.
**Status:** living spec, captured 2026-04-29 from runtime code.
**Owner:** Christian (codex-orchestrator).

---

## 0. How to use this document

This document has two halves:

1. **Sections 1–8** are the *feature inventory* — what exists today and what must keep working.
   Treat this as ground truth, not opinion. It maps to live code in `public/admin/` and the
   `/admin/*` API surface.
2. **Section 9** is a *recommended visual direction* — an Anthropic-flavoured "warm operator
   console" palette and tone. It is opinionated and replaceable; the inventory in §1–8 is not.

When feeding this into another Claude session for redesign, the prompt should be roughly:

> "Here is the feature spec for an admin console. Sections 1–8 describe what must keep working.
> Section 9 is a recommended visual direction. Produce updated CSS for `theme.css` and
> `dashboard.css` plus annotated mockups for the dashboard, hosts list, host detail, and the
> general settings page. Preserve the six existing themes; redesign only the **Auto/Light/Dark**
> trio in the warm direction. Pink themes stay as-is."

---

## 1. Mission, audience, non-goals

### 1.1 What this app is
`codex-orchestrator` is a self-hosted control plane for a fleet of Codex/Claude inference hosts.
The `/admin/*` UI is the operator console. It is used by **one person at a time** (typically the
fleet's sysadmin), not customers. It is shipped as a single-tenant, mTLS-gated dashboard.

### 1.2 Audience
- Solo or small-team sysadmins running a private inference fleet.
- High technical literacy. Cares about density, keyboard speed, and at-a-glance state.
- Uses the dashboard daily; does not need onboarding hand-holding.

### 1.3 Mission of the UI
- **Operator console first**, marketing surface zero. Every pixel should do work.
- **Trust through transparency**: surface state and quotas without burying them.
- **Fast keyboard paths**: `[h][a]`, `[s][g]`, `[?]` style shortcuts for everything.
- **Live-feeling**: WebSocket-backed updates without manual refresh.
- **Dense but readable**: tables and meters dominate; whitespace is earned, not wasted.

### 1.4 Non-goals
- ❌ Marketing-page polish (no hero sections, no testimonials, no CTAs to "get started").
- ❌ Mobile-first. Mobile is supported (separate `dashboard-mobile.css`) but desktop is canonical.
- ❌ Multi-tenant theming. There is one operator; their theme is their preference.
- ❌ Animations for delight. Motion is reserved for state changes (toasts, modals) and chart hover.
- ❌ Frameworks. No React, Vue, Svelte. No build step. Vanilla JS + PHP only.

---

## 2. Hard constraints (must preserve)

### 2.1 Tech stack
| Constraint | Detail |
|---|---|
| Backend | Pure PHP 8.1+, no Composer/vendor dir for hot path |
| Frontend | Vanilla JS, no framework, no transpilation |
| Build step | None. Files served as-is from `/admin/assets/` |
| Module system | None. Plain `<script src=...>` tags, IIFE patterns |
| CSS | Hand-written, CSS variables, no preprocessor |
| Fonts | Self-hosted: `Inter` (variable, latin + latin-ext, normal + italic), `JetBrains Mono` (400, 600) |
| Icons | None (text glyphs like `↻`, `←`, `→`, `[?]`, emoji-free) |

### 2.2 File layout (assets that the redesign will touch)
```
public/admin/
  index.html                  # Single-page app shell
  login.html                  # Standalone login
  assets/
    theme.css                 # ← canonical design tokens (PRIMARY EDIT TARGET)
    dashboard.css             # ← desktop layout & components (PRIMARY EDIT TARGET)
    dashboard-mobile.css      # ← mobile overrides
    login.css                 # ← login page
    manual.css                # ← in-app manual viewer
    *.js                      # behavior; should not need changes
```

### 2.3 Class names that already exist and must keep working
The redesign should restyle these, not rename them:

- Layout: `.app`, `.content`, `.main`, `.editorial-rail`, `.rail-frame`, `.rail-primary`,
  `.rail-link`, `.rail-group`, `.rail-disclosure`, `.rail-panel`, `.rail-section`,
  `.rail-section-label`, `.rail-sub-link`, `.rail-shortcut`, `.rail-tools`, `.rail-action`,
  `.rail-account-trigger`, `.rail-account-summary`, `.rail-menu-button`.
- Panels: `.panel-set`, `.card`, `.panel`, `.panel-head`, `.panel-subtitle`, `.panel-actions`,
  `.panel-body`.
- Setting blocks: `.settings-grid`, `.setting-block`, `.setting-block--danger`, `.setting-head`,
  `.setting-body`, `.general-group`, `.general-group--danger`, `.general-group-header`,
  `.general-section-nav`, `.general-section-btn`, `.eyebrow`, `.overline`.
- Buttons: `button` (primary by default), `.ghost`, `.tiny-btn`, `.primary`, `.danger`,
  `.login-submit`, `.kbd-hint`.
- Forms: `.field`, `.modal-label`, `.modal-select`, `.toggle`, `.track`, `.thumb`,
  `.toggle-text`, `.inline-group`.
- Tables: `.table-wrap`, `table`, `th.sortable`, `.loading-row`, `.tbl`.
- Status: `.muted`, `.pill-quiet`, `.chip-row`, `.kv-grid`, `.dot`, `.seed-chip`,
  `.dashboard-status-bar`, `.status-ok`, `.status-text`, `.auth-error`.
- Modals: `.modal-backdrop`, `.modal`, `.kbd-shortcuts-modal`, `.kbd-shortcuts-grid`,
  `.kbd-shortcut-row`, `kbd`.
- Dashboard: `.dashboard-shell`, `.dashboard-primary-grid`, `.dashboard-primary-card`,
  `.dashboard-ops-strip`, `.dashboard-charts-grid`, `.dashboard-chart-shell`,
  `.dashboard-chart-card`, `.dashboard-chart-head`, `.dashboard-chart-controls`,
  `.dashboard-chart-canvas-wrap`, `.dashboard-chart-meta`, `.dashboard-chart-status`,
  `.dashboard-chart-ranges`, `.dashboard-range-btn`.
- Host detail: `.host-detail-page`, `.host-detail-head`, `.host-detail-layout`,
  `.host-detail-section`, `.host-detail-section-head`, `.host-detail-summary`,
  `.host-detail-problems`, `.host-detail-actions`, `.host-detail-empty`.
- Project detail: `.project-detail-page`, `.project-detail-section`, `.project-detail-wide`,
  `.project-tab-btn`, `.project-tab-badge`.
- Skill detail: `.skill-detail-page`, `.skill-detail-section`, `.skill-chat-section`,
  `.skill-editor-section`, `.skill-mode-splash`, `.skill-mode-splash-title`.
- Logs: `.logs-layout`, `.logs-sidebar`, `.logs-nav-list`, `.logs-nav-link`, `.logs-content`,
  `.log-panel`, `.log-table-wrap`, `.log-actions`, `.log-footer`, `.log-pagination`,
  `.page-indicator`.
- Mobile: `.hosts-mobile-nav`, `.hosts-mobile-tab`, `.logs-mobile-nav`, `.logs-mobile-tab`,
  `.settings-mobile-nav`, `.settings-mobile-tab`.

### 2.4 Existing CSS variables that must keep their semantics
The redesign will change the **values**; it should keep the **meaning** of these tokens
because JS reads `getComputedStyle` for some of them (charts, toasts):

```
--bg, --bg-2                    background tiers
--panel, --panel-strong         panel surfaces
--card, --card-strong           card surfaces (more opaque than panel)
--border, --border-2            border tiers
--input-border                  form borders (stronger contrast)
--frost                         glass/frost overlay tint
--text                          primary text
--muted                         secondary text
--accent, --accent-2            primary accent + hover
--accent-rgb                    raw RGB for rgba() composition
--accent-soft, --accent-soft-2  tinted accent surfaces
--accent-ring                   focus ring colour
--accent-gradient               accent gradient (used in CTAs / hero pills)
--btn-text                      text colour on accent buttons
--input-bg                      form field background
--logo-bg                       background behind logo marks
--danger, --success, --warning  semantic state colours
--table-row, --table-row-alt    zebra striping
--table-hover                   row hover
--table-header                  table header gradient
--surface-tint                  soft surface gradient
--usage-section, --usage-divider   usage card sub-surfaces
--meter-track, --meter-border, --meter-marker, --meter-marker-glow   meter widget
--radius, --radius-sm, --radius-lg, --radius-xl   corner radii
--shadow, --shadow-soft, --shadow-pop             elevation
--ring, --ring-muted, --focus-ring                focus rings
--font-sans, --font-display, --font-mono          type stack
```

### 2.5 Six themes — all must remain selectable
Christian designed the pink variants. They are a feature, not legacy. The theme cycle is:

1. `auto` — follows OS, dark by default, light if `prefers-color-scheme: light`
2. `auto-pink` — follows OS, but pink in both directions
3. `light` — forced light
4. `dark` — forced dark
5. `bright-pink` — light pink (cherry-blossom)
6. `dark-pink` — dark pink (mulberry/wine)

Theme is stored in `localStorage.adminTheme` and mirrored to server (`versions.admin_theme`)
so the `cdx` CLI can match branding. **All six tokens sets must be defined in `theme.css`.**

### 2.6 Branding marks
- `/admin/assets/openai-logo.svg` — used in the editorial rail header and login page brand pair.
- `/admin/assets/claude-logo.svg` — real Claude mark used in the login page brand pair.
- App name: **Orchestrator**.
- Tagline: **"Engines to Brrr!"** (kept).

### 2.7 Accessibility floor
- Contrast: WCAG AA for body text in every theme.
- Focus rings: visible on every interactive element (`--focus-ring` driven).
- Keyboard navigation: every action reachable; shortcut overlay (`[?]`).
- ARIA: dialogs use `role="dialog" aria-modal="true"`, menus use `role="menu"/menuitem`,
  toggles announce state changes.
- Reduced motion: respect `prefers-reduced-motion` for the (sparse) transitions.

---

## 3. Information architecture

### 3.1 Top-level routes
| Route | Panel | Notes |
|---|---|---|
| `/admin/` | Dashboard | Default landing |
| `/admin/login` | Login | Pre-auth |
| `/admin/dashboard` | Dashboard | Same as `/` |
| `/admin/manual` | In-app manual | Markdown viewer with search |
| `/admin/hosts` | Hosts list (All) | Tabs: All / Secure / Insecure / Unprovisioned |
| `/admin/hosts/secure` | Hosts (Secure tab) | |
| `/admin/hosts/insecure` | Hosts (Insecure tab) | |
| `/admin/hosts/unprovisioned` | Hosts (Unprovisioned tab) | |
| `/admin/hosts/{id}` | Host detail page | Per-host workspace |
| `/admin/logs` | Logs (API tab) | |
| `/admin/logs/mcp` | Logs (MCP tab) | |
| `/admin/logs/events` | Logs (Events / Audit tab) | |
| `/admin/settings/general` | Settings → General | Default settings tab |
| `/admin/settings/users` | Settings → Users | |
| `/admin/settings/agents` | Settings → Agents (AGENTS.md auth) | |
| `/admin/settings/memories` | Settings → Memories | MCP memories |
| `/admin/settings/projects` | Settings → Projects | Index of shared projects |
| `/admin/settings/projects/{slug}` | Project workspace | Per-project tabs |
| `/admin/settings/profiles` | Settings → Profiles | Codex profiles |
| `/admin/settings/skills` | Settings → Skills | List of skills |
| `/admin/settings/skills/{slug}` | Skill detail editor | Chat + AI-managed fields |
| `/admin/settings/config` | Settings → OpenAI | Codex/OpenAI config builder |
| `/admin/settings/claude` | Settings → Claude | Anthropic fleet config |
| `/admin/settings/apikeys` | Settings → API Keys | Self-issued bearer tokens |
| `/admin/settings/joplin` | Settings → Joplin | Note integration |
| `/admin/account/password` | Account → Password | |
| `/admin/account/passkeys` | Account → Passkeys | |

### 3.2 Navigation chrome — "editorial rail"
A sticky top navigation bar (NOT a sidebar) called the **editorial rail**. It collapses into a
drawer on mobile. Structure on desktop:

```
[Brand mark + name + tagline]   [Overview] [Manual] [Hosts ▾] [Logs ▾] [Settings ▾]   [Active Windows]  [Account ▾]
```

- `Hosts`, `Logs`, `Settings`, and `Account` are **disclosure menus** that open a panel.
- The Settings panel is wider and split into 4 sub-sections: **Admin**, **Authoring**,
  **Workspace**, **Integrations**.
- The Account panel includes a Theme submenu (radio group with 6 options).
- `Active Windows` is a contextual button shown only when ≥1 insecure window is open.
- Every link displays a **shortcut hint** like `[h][a]` aligned to the right.

### 3.3 Settings menu sub-grouping
| Group | Items |
|---|---|
| **Admin** | General, Users, Agents, OpenAI, Claude, API Keys |
| **Authoring** | Skills, Memories |
| **Workspace** | Projects, Profiles |
| **Integrations** | Joplin |

### 3.4 Mobile nav
- The rail collapses to a hamburger trigger (`#navMenuToggle`, label "Menu").
- A backdrop dims the page when the drawer is open.
- Inside Hosts / Logs / Settings panels on mobile, **horizontal scrollable tab strips**
  appear above the content (`.hosts-mobile-nav`, `.logs-mobile-nav`, `.settings-mobile-nav`)
  because the disclosure menu is hidden on small screens.

---

## 4. Per-page feature inventory

### 4.1 Login page (`/admin/login`)
**Purpose:** Username-first login with WebAuthn or password (depending on user type).

**Layout:** Centred card, max-width ~420px, single column.

**Elements (top to bottom):**
1. Brand mark — Codex logo + Claude logo side by side (40×40 each, 8px radius), 10px gap.
2. App title `<h1>` — "Orchestrator".
3. Subhead copy — "Enter your username to continue." (changes when password field appears).
4. Form:
   - Username field (`<input>`, autocomplete=username, required).
   - Password field (hidden initially, revealed for password-mode users).
   - Inline error region (`.login-error`, `role="alert"`).
   - Submit button with kbd hint `Enter ↵`.

**States:**
- *Initial*: only username visible.
- *Password-mode*: both visible after username probe returns "password".
- *Passkey-mode*: WebAuthn ceremony triggers automatically; no password field shown.
- *Error*: `.login-error` populated, button stays enabled for retry.
- *Locked out*: shown when admin access mode blocks pre-mTLS access.

### 4.2 Dashboard / Overview (`/admin/`)
**Purpose:** At-a-glance fleet health, usage, and quota state. The most-visited page.

**Page layout (top → bottom):**

1. **Status bar** (`#dashboardStatusBar`) — single line, full width, shows live status text
   (`Loading…` initially, then e.g. `Connected · 4 hosts online · last refresh 12s ago`).
   Status colour reflects health: ok / warning / error.

2. **Primary grid** (`#stats`, two cards side-by-side at desktop):
   - **ChatGPT usage card** (`#chatgpt-usage-card`) — primary card showing:
     - Card title (eyebrow + heading).
     - Lane utilisation meter (primary lane + optional secondary lane).
     - Quota state pill (e.g. "Within limits", "85% used", "Quota hit").
     - 24h / 7d / 30d token counts.
     - Snapshot timestamp.
     - "Refresh" tiny-btn.
   - **Claude usage card** (`#claude-usage-card`) — sibling card showing:
     - 24h / 7d / 30d token counts split by model (Opus/Sonnet/Haiku).
     - Spend-limit meter (used / limit / percent), if a monthly cap is set.

3. **Ops strip** (`#dashboardOpsStrip`, hidden when nothing to show) — horizontal pill row
   surfacing:
   - Pending insecure approval count (with bell icon hint).
   - Active insecure windows count + nearest expiry countdown.
   - Active codex version lock (if pinned).
   - Runner status (online / offline / failing).
   - Auto-update toggle state.

4. **Charts grid** (`#dashboardGrid`) — generated by JS, contains one shell with two charts:
   - **Quota trend** chart (`#dashboardQuotaCanvas`) — Chart.js line chart of ChatGPT lane
     utilisation over the selected range.
   -    - Shared controls above the charts:
     - Range buttons (`7D`, `30D`, `90D`, `180D`, `365D`) — `data-dashboard-range`.
     - Compare-previous toggle.
     - Line-vs-bar toggle (`#dashboardTypeBtn`).
     - Per-chart "Reset zoom" and "Export CSV".

**Live behaviour:**
- `log.created` events trigger targeted refresh of the relevant card.
- `auth.insecure.pending` events bump the ops strip badge and ring a synthesized bell.
- `toast` events render an in-app toast.

### 4.3 Hosts list (`/admin/hosts` + tabs)

**Tabs (4):** All · Secure · Insecure · Unprovisioned. Plus a "New Host" button in the rail menu.

**Layout:**
- Single panel `#hosts-panel` titled "Authorized Hosts".
- `panel-head` with title and a `panel-actions` row (search, filter, "Register new host" button).
- `<table id="hosts-table">` with sortable headers. Columns (current):
  - FQDN (with status dot prefix).
  - State (chips: secure / insecure / vip / roaming / quota-hit).
  - Last seen (relative time).
  - Codex / Claude version pills.
  - Reverse-DNS mode chip.
  - Action menu (kebab) — Open, Clear auth, Toggle VIP, Delete, etc.

**Per-row state chips** can include: `secure`, `insecure`, `vip`, `roaming`, `ipv4-only`,
`curl-insecure`, `temporary`, `unprovisioned`, `quota-warn`, `quota-hit`, `version-locked`.

**Empty state:** "No hosts yet — register your first host." with CTA.

**Modals reachable from this page:**
- **New Host** modal (`#newHostBtn` triggers it): form for FQDN, secure flag, VIP, temporary,
  duration, reverse-DNS mode, curl-insecure. Submitting calls `/admin/hosts/register` which
  returns an installer command.
- **Installer Ready** modal (`#newHostSuccessTitle`): shows the one-shot `curl | bash` installer
  command + token TTL.
- **Active Windows** modal (`#navInsecureHosts`): list of insecure windows with bulk extend / disable.
- **Confirm Remove host** modal — destructive, requires explicit confirmation.

### 4.4 Host detail page (`/admin/hosts/{id}`)

**Header (`.host-detail-head`):**
- Eyebrow: "Authorized Host"
- `<h2>`: FQDN
- Chip row of current states (secure/insecure/vip/etc.)
- "Back to hosts" ghost link (right-aligned)

**Body — four sections (`.host-detail-section`), each with eyebrow + h3:**

1. **Stats — "Current signal"** (`#hostDetailSummary`)
   - Last-seen relative time
   - 24h call count, error rate
   - Token totals (last 24h)
   - Quota lane state

2. **Action Items — "Needs attention"** (`#hostDetailProblems` + empty state)
   - Cards listing issues: e.g. "Insecure window expires in 4 min", "Auth failure 12 min ago",
     "Reverse DNS mismatch".
   - Empty: "No active action items."

3. **Infos — "Technical context"** (`.kv-grid`)
   - Key/value grid of: ID, FQDN, IP (current), reverse-DNS lookups, mTLS fingerprint, codex
     version, claude version, agents version, registered at, last installer token, etc.

4. **Features — "Host controls"** (`.host-detail-actions`)
   - Toggles + buttons for every per-host action:
     - Toggle Secure flag (`POST /admin/hosts/{id}/secure`)
     - Toggle VIP (`POST /admin/hosts/{id}/vip`)
     - Toggle Roaming (`POST /admin/hosts/{id}/roaming`)
     - Toggle IPv4-only wrapper (`POST /admin/hosts/{id}/ipv4`)
     - Toggle curl-insecure wrapper (`POST /admin/hosts/{id}/curl-insecure`)
     - Per-host reverse-DNS mode dropdown
     - Per-host Codex model + reasoning override
     - Per-host Claude model override
     - Per-host Codex/Claude/AGENTS version override
     - Open insecure window (with duration input)
     - Bulk-extend / disable insecure window
     - Clear auth state / digests
     - Delete host (destructive, confirm modal)

**Loading state:** `#hostDetailEmptyState` with title + body, shown until data arrives.

**Live updates:** WS `host-detail-support` request fetches slow metadata (full AGENTS metadata)
when the user opens the page; the page hydrates progressively.

### 4.5 Logs (`/admin/logs/*`)

**Three tabs**, displayed via a shared layout:
- Desktop: `.logs-layout` with a left `.logs-sidebar` (vertical nav) and right `.logs-content`.
- Mobile: horizontal scroll tab strip on top.

#### 4.5.1 API logs (`/admin/logs`)
**Title:** "Client Reports" · subtitle: "Newest first · search by host or IP · click headers to sort."

**Controls:** search box (host/IP), page-size select (25/50/100), refresh button.
**Table columns:** Time · Host · Client IP · Input · Output · Cached · Reasoning — all
sortable, click headers to toggle direction.
**Footer:** status text + paginator (Prev / Page X of Y / Next).

#### 4.5.2 MCP logs (`/admin/logs/mcp`)
**Title:** "MCP Access Logs"
**Controls:** search (host/tool), status filter (All / Success only / Failures only), refresh.
**Columns:** Time · Host · Tool · Status.

#### 4.5.3 Events / Audit (`/admin/logs/events`)
**Title:** "Events / Audit Log"
**Controls:** Host filter (dropdown — populated dynamically), action prefix (text + datalist of
`admin.host.`, `auth.`, `runner.`, `host.`, `register`), time window (15m–30d / Any), search,
row limit (50/100/200/500), refresh.
**Columns:** Time · Host · Action · Details · (action menu — copy JSON for incident tickets).

### 4.6 Settings — General (`/admin/settings/general`)

**Title:** "System Controls" · subtitle: "Fleet-wide policies, security enforcement, and
operational settings."

**Sub-nav** (button group, `.general-section-nav`): **Emergency** · **Security & Access** ·
**Fleet Management** · **Developer Experience**.

#### 4.6.1 Emergency (group with `--danger` tint)
- **API Kill Switch** (`setting-block--danger`): toggle + status pill ("Active" / "DISABLED").
  Toggling it stores `api_disabled` in `versions` and 503s every route except the toggle itself.
- **Quota Policy**: toggle "Deny launches" vs "Warn only" + slider for warn/kill threshold
  (50–100%) + week-partition button group (Off / 7 days / Mon–Fri).

#### 4.6.2 Security & Access
- Reverse-DNS global toggle.
- Insecure-approval gating toggle (also gates the insecure-approval queue feature).
- Auto-update of fleet codex version (toggle).
- Insecure window default duration (number input, minutes).
- Approval queue review section (when there are pending requests).

#### 4.6.3 Fleet Management
- Codex version lock select (`auto/latest` or pinned `x.y.z`).
- Prune policy (inactivity days, slider 0–60).
- Scaling tier list with badge — turn on/off, add tiers, VIP exempt toggle, host-override-wins
  toggle, save button.
- Version refresh button (manual).

#### 4.6.4 Developer Experience
- `cdx silent` toggle.
- (Other DevEx-affecting toggles aggregated here.)

### 4.7 Settings — Users (`/admin/settings/users`)
List of admin users. Columns: username · role (admin / fleet_operator / trusted_user / user) ·
last login · actions (edit / delete / wipe-all-with-confirm). Capability matrix is documented
inline. "Create user" button opens a modal.

### 4.8 Settings — Agents (`/admin/settings/agents`)
**Tabs:** AGENTS metadata · backups list. Editor for the canonical AGENTS.md content + version
history. Buttons: Save, Serve (publish), Delete a version. Status line shows the active version
hash.

### 4.9 Settings — Memories (`/admin/settings/memories`)
MCP memories table. Filters: host, query (text), tags, limit. Refresh button. Each row deletable.
Used to inspect what the MCP server is remembering per-host.

### 4.10 Settings — Projects (`/admin/settings/projects`)
**Module enable toggle** at the top (when off, the rest is collapsed). When on:
- Index card with the list of shared projects.
- Each project card: slug, about excerpt, member count, "Open" button.
- Note explaining the managed `coco` skill is auto-published via MCP.
- "Delete project" goes through a confirm modal.

### 4.11 Settings — Profiles (`/admin/settings/profiles`)
Codex profiles editor — typically a Markdown / YAML / TOML textarea per profile.
Profile list on the left, editor on the right.
**Dirty-edit guard:** if a remote update arrives while there are unsaved changes, the panel
shows "Remote update available (unsaved edits)" instead of overwriting.

### 4.12 Settings — Skills (`/admin/settings/skills`)
List view: table of skills with slug, name, description excerpt, tags, last updated, action.
"New skill" button. The managed `coco` skill is read-only (when Projects module is on).

### 4.13 Settings — OpenAI / Codex config (`/admin/settings/config`)
The **config.toml builder**. Multi-card layout where each card is a TOML section. Cards are
tagged with `data-config-card` and `data-config-title` for navigation. Live render preview +
"Save" button (POSTs to `/admin/config/store`). Header actions also expose Codex credential
seeding, Codex runner verification, and fleet version checks. Same dirty-edit guard as Profiles.

### 4.14 Settings — Claude (`/admin/settings/claude`)
**Title:** "Claude Settings" · eyebrow "Claude / Anthropic" · subtitle: "Configure Claude Code
fleet settings."

**Header actions:** "Seed Claude credentials", "↻ Verify runner" button (live `/verify-claude`
probe), "Save" primary button.

**Three config cards:**
1. **General** — Default model (Sonnet/Opus/Haiku) and default max tokens.
3. **Runner** — Status chip (`Checking…` / `Online` / `Offline`), last verification result.

### 4.15 Settings — API Keys (`/admin/settings/apikeys`)
List of self-issued bearer tokens. Columns: name, last 4 chars, created, last used, actions
(revoke). "Create API Key" button opens a modal that shows the secret **once** and then masks it.

### 4.16 Settings — Joplin (`/admin/settings/joplin`)
Joplin integration: server URL, API key, sync toggle, last sync result.

### 4.17 Project workspace (`/admin/settings/projects/{slug}`)
**Header (`.project-detail-head`):**
- Eyebrow + project title.
- Tab strip (`.project-tab-btn`):
  **Identity** · **Notes** *(badge for unread)* · **Todos** *(badge for open)* · **Files**
  *(badge for new)* · **Feedback** *(badge for triage)* · **Activity**.

**Tabs:**
- **Identity** — Project identity (slug, about, created, owner) + Coordination notes (roster
  markdown editor).
- **Notes** — Durable decisions, append-only log with timestamps.
- **Todos** — Execution queue, checkable items, status chips (open / done / blocked).
- **Files** — Artifacts list, upload/delete.
- **Feedback** — Triage inbox, items with status (new / in-progress / closed).
- **Activity** — Recent changes feed.

### 4.18 Skill detail editor (`/admin/settings/skills/{slug}`)
**Layout:** two columns side-by-side.

**Left — `skill-chat-section`** ("Talk with your skill"):
- Conversation transcript area (`#skillConversation`).
- Empty state nudge.
- Input + send button.
- Status line.

**Right — `skill-editor-section`** ("AI-managed fields"):
- Slug, name, description, tags (chip input + datalist), what / when / steps multiline fields.
- Each field has an "edit" lock button (`data-skill-unlock`) — fields are AI-managed by default.
- Digest badge + Updated badge.
- Save / Cancel / Delete buttons.

**Splash screen** when slug=new:
- "Create a new skill" centered.
- Two big buttons: **AI mode** vs **Manual mode**. Selecting a mode reveals the appropriate
  workflow.

### 4.19 Manual (`/admin/manual`)
In-app markdown viewer with TOC sidebar and search. Manifest-driven (`manual/manifest.json`,
`manual/search-index.json`). Used like a built-in docs site.

### 4.20 Account (`/admin/account/*`)

#### 4.20.1 Password (`/admin/account/password`)
Three fields: current password, new password, confirm. Reset / Change buttons. Status + error region.

#### 4.20.2 Passkeys (`/admin/account/passkeys`)
List of registered passkeys (name, created, last used, transport). Per-row rename and delete.
"Register new passkey" button triggers WebAuthn ceremony.

---

## 5. Component inventory

### 5.1 Surfaces
| Component | Class | Purpose |
|---|---|---|
| Card | `.card` | Generic raised surface |
| Panel | `.panel` | Card variant with stronger framing |
| Panel head | `.panel-head` | Title row inside a panel: `<div>` (title + subtitle) + `.panel-actions` |
| Setting block | `.setting-block` | Single setting unit; danger variant `.setting-block--danger` |
| General group | `.general-group` | Cluster of related settings (Emergency, Security, etc.); danger variant `.general-group--danger` |
| Config card | `.config-card` | Sub-section inside Settings → OpenAI / Claude |
| KV grid | `.kv-grid` | Two-column key/value layout |
| Table wrap | `.table-wrap` | Scroll container for tables |

### 5.2 Buttons
| Variant | Use | Visual hint |
|---|---|---|
| Primary | Default `<button>` and `.primary` | Filled accent, `--btn-text` foreground |
| Ghost | `.ghost` | Transparent fill, accent border |
| Tiny | `.tiny-btn` | Compact size, 12–13px |
| Danger | `.danger` | Filled `--danger` |
| Login submit | `.login-submit` | Full-width primary, includes kbd hint |

### 5.3 Form controls
| Component | Notes |
|---|---|
| Field | `.field` wraps `<label>` + `<input/select/textarea>` |
| Toggle | `.toggle` with `.track` + `.thumb` + `.toggle-text`; checkbox under the hood |
| Range slider | Native `<input type="range">` with custom track/thumb (e.g. `.quota-limit-slider`) |
| Pill / select group | `.quota-partition-buttons` — button group acting as radio |
| Search input | `<input type="search">` with consistent height/padding |

### 5.4 Status & feedback
| Component | Class | Purpose |
|---|---|---|
| Pill (quiet) | `.pill-quiet` | Badge-style status (e.g. "Active", "DISABLED") |
| Chip row | `.chip-row` | Wrap-friendly chips (host states) |
| Eyebrow | `.eyebrow` | All-caps tiny label above an h3 |
| Overline | `.overline` | Same idea, used in host detail head |
| Status text | `.muted .status-text` | Inline status under a control |
| Auth error | `.auth-error` | Red error region inside a form, `role="alert"` |
| Seed chip | `.seed-chip` | Status chip with `.dot` pulse for runner status |
| Toast | (via WS `toast` event) | Top-right corner, auto-dismiss, severity-coloured |

### 5.5 Tables
- Sortable: `<th class="sortable" data-sort="...">`. Click toggles asc/desc; visual arrow.
- Loading row: `<tr class="loading-row"><td colspan="..">Loading…</td></tr>`.
- Zebra: `--table-row` / `--table-row-alt`; hover: `--table-hover`.
- Header: `--table-header` (gradient currently — see §9 for redesign).

### 5.6 Modals
- Backdrop: `.modal-backdrop` covers viewport.
- Modal: `.modal` centred, max-width per use.
- Variants used: `.kbd-shortcuts-modal` (grid of shortcut rows).
- Always uses `role="dialog" aria-modal="true" aria-labelledby="..."`.
- Confirm modal: title + body + Cancel + Confirm pair.

### 5.7 Charts (Chart.js, rendered to `<canvas>`)
- Quota trend canvas: `#dashboardQuotaCanvas`.
- ChatGPT spark in card: small inline chart.
- Chart styling reads from CSS variables (`--accent`, `--text`, `--muted`, `--border`).
- Range buttons + Compare-previous + Line/Bar toggle.

### 5.8 Keyboard shortcuts
- `kbd` element used inline.
- Shortcut overlay accessible via `[?]`.
- Full map (current):
  - `d` → Dashboard
  - `h a / h s / h i / h u` → Hosts (all/secure/insecure/unprovisioned)
  - `h n` → New host
  - `l c / l m / l e` → Logs (client/MCP/events)
  - `s g / s u / s a / s c / s l / s i / s k / s m / s p / s r` → Settings sub-pages
  - `?` → Open shortcut help
  - `/` → Focus host search modal
  - `Esc` → Close any modal

---

## 6. Interactive patterns

### 6.1 Live updates (WebSocket)
- Endpoint: `/admin/ws` (or `ADMIN_WS_PUBLIC_URL`).
- Heartbeat interval and backlog limit configurable.
- Event types consumed by the UI:
  - `log.created` → targeted refresh of the relevant log table or dashboard card.
  - `toast` → render a toast at top-right.
  - `auth.insecure.pending` → bump ops-strip badge **and ring a synthesized bell** (best-effort,
    blocked by autoplay policy on never-interacted tabs).
  - `host.updated` → refresh host row / detail.
  - `versions.changed` → refresh dashboard version pills.
- Targeted request: `host-detail-support` returns slow metadata for the active host page.

### 6.2 Toasts
- Position: top-right, stacked.
- Auto-dismiss after ~5s, severity colours (`--success`, `--warning`, `--danger`, `--accent`).
- Origin: server-side (`POST /admin/toasts`) or auto-emitted from `auth.retrieve` /
  `auth.denied` log actions.

### 6.3 Dirty-edit guard
- Config builder and Profiles tab: when remote state changes during editing, do not auto-overwrite.
  Show a yellow banner `Remote update available (unsaved edits)` with a "Reload from server"
  button.

### 6.4 Insecure approval inline modal
- When the WS reports a fresh request and the operator has WS presence: a modal appears with the
  host FQDN, request time, and Approve / Deny buttons. The bell rings.

### 6.5 Access-blocked overlay
- If session expires or admin access is blocked mid-action, the access block modal appears
  with title + body + dismiss button. Blocks interaction until dismissed.

### 6.6 Initial seeding state
- When `countAdmins(true) === 0`, login is bypassed and a special "Initial seeding required"
  banner / modal appears prompting to create the first admin.

### 6.7 Mobile vs desktop
- Below ~960px: rail collapses into a drawer; in-page tab strips become horizontal scroll.
- Touch targets must meet 44×44 minimum.
- Tables use `overflow-x:auto` to scroll horizontally rather than reflow.

---

## 7. State variations & edge cases

For each major surface, the redesign should account for these states:

| State | Trigger | Visual treatment |
|---|---|---|
| Loading | Initial fetch | Loading row in tables, "Loading…" placeholder, skeleton optional |
| Empty | API returned `[]` | Friendly "no items yet" + relevant CTA |
| Error | Fetch failed | Inline error inside the panel; do not blank out content |
| Permission denied | `users.manage` (or similar) needed | Disabled controls + tooltip / explainer pill |
| Stale | Remote update arrived during edit | Yellow banner "Remote update available (unsaved edits)" |
| Locked | API kill switch on | Persistent banner across all pages: "API disabled — only the kill switch is reachable" |
| Offline | WS disconnected | Status bar shows "Reconnecting…", retries with backoff |
| Read-only | Managed item (e.g. `coco` skill) | Lock icon, edit disabled, explainer in tooltip |
| Pending approval | Insecure request waiting | Ops strip badge + modal pop on receive |
| Quota exceeded | Threshold hit | Red pill on dashboard card + chart marker |

---

## 8. Theme system — full token tables

All six themes must be defined in `theme.css`. Below are the **current** values for reference,
so the redesign can either (a) keep them, (b) tune them, or (c) replace them while keeping the
token names. Section 9 proposes specific replacements for `auto`/`light`/`dark` only.

### 8.1 Common (theme-agnostic)
```
--font-sans: 'Inter', system-ui, -apple-system, 'Segoe UI', sans-serif;
--font-display: same as sans (currently)
--font-mono: 'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;

--radius: 8px;        --radius-sm: 6px;
--radius-lg: 12px;    --radius-xl: 12px;

--shadow: 0 1px 3px rgba(2, 6, 23, 0.06);
--shadow-soft: 0 1px 2px rgba(2, 6, 23, 0.04);
--shadow-pop: 0 4px 12px rgba(2, 6, 23, 0.08);
--ring: 0 0 0 3px rgba(var(--accent-rgb), 0.30);
--ring-muted: 0 0 0 3px rgba(148, 163, 184, 0.35);
--focus-ring: rgba(var(--accent-rgb), 0.72);
```

### 8.2 Dark (also default for `auto`)
```
--bg: #060815;        --bg-2: #0a1021;
--panel: rgba(16, 20, 35, 0.78);
--card: rgba(16, 20, 35, 0.92);
--text: rgba(241, 245, 249, 0.96);
--muted: rgba(226, 232, 240, 0.62);
--accent: #2fe6da;    --accent-2: #1fb7ae;
--accent-rgb: 47, 230, 218;
--danger: #fb7185;    --success: #34d399;    --warning: #fbbf24;
--btn-text: #060815;
```

### 8.3 Light
```
--bg: #f6f7fb;        --bg-2: #eef1f7;
--panel: rgba(255, 255, 255, 0.86);
--card: rgba(255, 255, 255, 0.94);
--text: #0b1220;
--muted: rgba(15, 23, 42, 0.64);
--accent: #0b8f87;    --accent-2: #066b65;
--accent-rgb: 11, 143, 135;
--danger: #dc2f45;    --success: #0b8e68;    --warning: #c98e00;
--btn-text: #f4fbff;
```

### 8.4 Bright Pink (also `auto-pink` light mode)
```
--bg: #fff1f8;        --bg-2: #ffdceb;
--text: #4a0830;
--accent: #ec4899;    --accent-2: #db2777;
--accent-rgb: 236, 72, 153;
--btn-text: #fff7fb;
```

### 8.5 Dark Pink (also `auto-pink` dark mode)
```
--bg: #170711;        --bg-2: #250a1a;
--text: ~ rgba(251, 207, 232, 0.96);
--accent: #f472b6 / #ec4899 (verify in source);
```

(Full pink-theme tokens carry the same shape as Light/Dark — refer to current `theme.css` for
exhaustive values.)

---

## 9. Recommended visual direction — "warm operator console"

This section is **opinion**, not requirement. Sections 1–8 stand even if you discard everything
below. The brief: bring the default `auto`/`light`/`dark` themes closer to an editorial,
Anthropic-flavoured warmth — without sacrificing the operator-console density.

### 9.1 Mood & philosophy

> **Paper, not plastic.** **Editorial, not playful.** **Density, with breathing room.**

The current default leans **cold sci-fi** (cyan accent on midnight navy). It feels capable but
clinical. The proposed direction is **warm utilitarian**: the surface temperature of a
well-made notebook, the structure of a financial terminal, the calm of a long-form blog. Think
of how Anthropic's own product surfaces feel — cream backgrounds, near-black ink, occasional
warm coral or terracotta accents, generous baseline grids, tasteful serifs in display moments.

The result should still look like an admin console, not a Substack. We are warming the palette
and tightening the type, not adding hero illustrations.

### 9.2 Palette evolution

#### 9.2.1 New Light theme — "Paper"
| Token | Old | New | Note |
|---|---|---|---|
| `--bg` | `#f6f7fb` | `#F7F4EE` | Warm cream, ~6° warmer hue |
| `--bg-2` | `#eef1f7` | `#EFEBE2` | Slightly deeper cream for tier 2 |
| `--card` | `rgba(255,255,255,0.94)` | `#FFFEFB` | Solid near-white with warm undertone |
| `--card-strong` | `rgba(247,249,253,0.96)` | `#FAF7F1` | |
| `--panel` | `rgba(255,255,255,0.86)` | `rgba(255,253,247,0.88)` | |
| `--border` | `rgba(15,23,42,0.12)` | `rgba(40,30,20,0.12)` | Warm-tinted hairline |
| `--border-2` | `rgba(15,23,42,0.16)` | `rgba(40,30,20,0.18)` | |
| `--text` | `#0b1220` | `#1B1612` | Warm near-black, easier on eyes |
| `--muted` | `rgba(15,23,42,0.64)` | `rgba(27,22,18,0.62)` | |
| `--accent` | `#0b8f87` (teal) | `#C2410C` (terracotta) | Warm coral/clay primary |
| `--accent-2` | `#066b65` | `#9A2D08` | Hover darken |
| `--accent-rgb` | `11, 143, 135` | `194, 65, 12` | |
| `--danger` | `#dc2f45` | `#B91C1C` | Slightly less candy, more brick |
| `--success` | `#0b8e68` | `#15803D` | Forest, not mint |
| `--warning` | `#c98e00` | `#B45309` | Mustard/amber, harmonises with terracotta |
| `--btn-text` | `#f4fbff` | `#FFF8F0` | Warm white on accent |

#### 9.2.2 New Dark theme — "Ink"
| Token | Old | New | Note |
|---|---|---|---|
| `--bg` | `#060815` | `#1A1614` | Warm near-black (espresso, not navy) |
| `--bg-2` | `#0a1021` | `#221C18` | Tier 2, slightly lifted |
| `--card` | `rgba(16,20,35,0.92)` | `#28221E` | Solid warm charcoal |
| `--card-strong` | `rgba(10,16,33,0.96)` | `#211B17` | |
| `--panel` | `rgba(16,20,35,0.78)` | `rgba(40,34,30,0.82)` | |
| `--border` | `rgba(148,163,184,0.16)` | `rgba(232,210,180,0.14)` | Warm hairline |
| `--text` | `rgba(241,245,249,0.96)` | `#F2EBE0` | Soft cream text |
| `--muted` | `rgba(226,232,240,0.62)` | `rgba(242,235,224,0.62)` | |
| `--accent` | `#2fe6da` (cyan) | `#F59E0B` (amber) | Warm primary, high lumen |
| `--accent-2` | `#1fb7ae` | `#D97706` | |
| `--accent-rgb` | `47, 230, 218` | `245, 158, 11` | |
| `--danger` | `#fb7185` | `#F87171` | |
| `--success` | `#34d399` | `#86EFAC` | |
| `--warning` | `#fbbf24` | `#FBBF24` | Keep; complements amber accent |
| `--btn-text` | `#060815` | `#1A1614` | |

> **Why amber/terracotta and not brand-coral?** The fleet runs both Codex (OpenAI green-leaning)
> and Claude (Anthropic warm-coral). A neutral warm earth-tone reads as "operator's tool",
> independent of upstream brand. It also lets the existing pink themes keep their distinct
> identity — pink stays the colourful choice; warm-amber is the grown-up default.

#### 9.2.3 Pink themes — leave alone
Keep `auto-pink`, `bright-pink`, `dark-pink` exactly as they are. They are the operator's
playful fallback. (Marginal token tuning is fine if the type rhythm in §9.4 changes.)

### 9.3 Surface treatment

- **Reduce gradient usage.** Current `--surface-tint`, `--table-header`, `--accent-gradient`
  are used liberally. Replace gradients with **single solid surfaces** plus a 1px hairline.
  Keep gradients only for: the accent CTA button (subtle)
  fill (functional).
- **Hairlines, not shadows.** Soften `--shadow*` to be barely there; lean on borders.
  Recommended:
  - `--shadow: 0 1px 0 rgba(40,30,20,0.04)`
  - `--shadow-soft: none` (rely on borders)
  - `--shadow-pop: 0 8px 24px -8px rgba(40,30,20,0.18)` (for modals only)
- **Corner radii — slightly larger but consistent.**
  - `--radius-sm: 6px` (form fields, pills) — keep
  - `--radius: 10px` (cards, panels) — was 8px
  - `--radius-lg: 14px` (modals) — was 12px
  - `--radius-xl: 18px` (login card, hero panels) — was 12px
- **Frost / glassmorphism**: drop it. Replace `--frost` with a solid 5% accent-tint surface.

### 9.4 Typography

#### 9.4.1 Pairing
- Keep `Inter` as the UI sans (it is excellent and already self-hosted).
- Add a **serif display face** for h1/h2 in editorial moments: dashboard title, page hero h2s,
  modal titles. Recommended: **Source Serif 4** (open licence, self-hostable, near-Tiempos warmth)
  or **Newsreader** as alternative.
- `--font-display` is currently aliased to Inter. Change it to the new serif.
- Mono stays JetBrains Mono.

#### 9.4.2 Scale & rhythm
Adopt a tight scale tuned for high-density screens:
| Token | Size | Use |
|---|---|---|
| `--type-overline` | 11px / 600 / +0.08em tracking / uppercase | `.eyebrow`, `.overline` |
| `--type-caption` | 12px / 500 | Status text, table footers |
| `--type-body-sm` | 13px / 400 | Subtitles, secondary copy |
| `--type-body` | 14px / 400 | Default body |
| `--type-body-lg` | 15px / 400 / 1.55 lh | Long-form (manual page) |
| `--type-h3` | 16px / 600 sans | Section headings |
| `--type-h2` | 22px / 500 *serif* | Panel titles |
| `--type-h1` | 30px / 500 *serif* | Page headlines |

Line height: 1.5 for body, 1.25 for headings.

#### 9.4.3 Letter-spacing
- Body: 0
- Caps overlines: +0.08em
- Headings: -0.01em (slight tighten on the serif)

### 9.5 Spacing & rhythm
Adopt a 4px base scale: 4 / 8 / 12 / 16 / 20 / 24 / 32 / 48 / 64. Most card paddings should
move from the current ~14–18px to **20px** (cards) / **24px** (panels). Section spacing inside
General settings: **32px** between groups, **20px** between blocks.

### 9.6 Component-level adjustments

#### 9.6.1 Editorial rail (top nav)
- Remove the bottom-border gradient.
- Use a single 1px hairline at the bottom, in `--border`.
- Brand title in serif (`--font-display`), tagline in 11px caps overline.
- Disclosure menus: white panel with hairline border + soft shadow, no gradient.
- Active link gets a 2px underline in `--accent`, no fill.

#### 9.6.2 Cards / panels
- Solid surfaces, 1px hairline border, `--radius` 10px.
- `panel-head`: 24px padding, title in serif, subtitle in 13px muted.
- Drop the inset highlight gradient on `--surface-tint`.

#### 9.6.3 Dashboard primary cards
- Make them feel like newspaper "above-the-fold" cards: serif h2, generous padding (24px),
  numbers set in mono with tabular-nums.
- The lane meter bar: chunky 12px height, rounded ends (`--radius-sm`), with a subtle 1px
  inset border for definition.
- Spend-limit meter: same treatment, with a tick at 100% and a marker dot at current value.

#### 9.6.4 Tables
- Header: solid `--bg-2`, no gradient, with bottom 2px `--border-2`.
- Rows: 12px vertical padding (was tighter), zebra at 2% accent tint.
- Hover row: full `--accent-soft` fill, no border change.
- Sort arrows: simple `▲ ▼` in monospace, `--muted`.
- Sticky table headers when scrolling.

#### 9.6.5 Buttons
- Primary: solid `--accent` fill, `--btn-text`, `--radius-sm`, no gradient. Hover: darken via
  `--accent-2`.
- Ghost: transparent, 1px `--border`, hover gets `--accent-soft` fill.
- Danger: solid `--danger`, white text. Use sparingly.
- Tiny-btn: 12px font, 6px vertical padding, otherwise same.
- Buttons get a 1px focus ring (`--focus-ring`) on `:focus-visible`, never on mouse focus.

#### 9.6.6 Toggles
- Track: 36×20px, `--radius-xl`, `--meter-track` background.
- Thumb: 16×16px, `--card` background with 1px `--border`.
- Active: track turns `--accent`, thumb gets soft glow.

#### 9.6.7 Pills & chips
- `pill-quiet`: 11px caps overline, `--accent-soft` fill, `--accent` text, `--radius-sm`.
- State chips (host states): each has a fixed colour token derived from semantic meaning:
  - `secure` → `--success` background tint
  - `insecure` → `--warning`
  - `vip` → `--accent`
  - `roaming` → muted neutral
  - `quota-hit` → `--danger`

#### 9.6.8 Toasts
- Top-right stack, 360px wide.
- Solid card with 4px left border in the severity colour.
- 200ms slide-in from right, 200ms fade out.
- No emoji icons; use a single character (`•` info, `!` warn, `×` error, `✓` success) in the
  severity colour at left.

#### 9.6.9 Modals
- 480px default width, 600px wide variant.
- `--shadow-pop` plus `backdrop-filter: blur(6px)` on the backdrop.
- Title in serif, body in sans.
- Cancel/confirm row right-aligned with 12px gap.

#### 9.6.10 Charts
- Set chart colours via CSS variables read in JS:
  - Primary line: `--accent`
  - Comparison line: `--muted`
  - Grid: `--border`
  - Axis text: `--muted`
- Reduce default Chart.js padding to ~8px.

### 9.7 Motion

- All transitions: `150ms cubic-bezier(0.2, 0, 0, 1)` (snappy ease-out).
- Page changes are instant (no fade between panels — operators want speed).
- Reserve animation for: toast in/out, modal in/out, drawer open/close, toggle thumb, hover
  fills.
- Respect `prefers-reduced-motion: reduce` → kill all transitions.

### 9.8 Editorial details

- **Section dividers**: between General settings groups, use a 1px hairline with a centred
  small-caps label (Anthropic blog-style).
- **Eyebrow + heading + subtitle stack**: standard editorial triplet for every section head.
- **Numbers in mono with tabular-nums**: every count and percent in tables and dashboards
  uses `font-variant-numeric: tabular-nums` so columns line up.
- **Quote treatment** for inline notes (e.g. "The Projects module is deliberately native to
  codex-orchestrator…"): a left 3px `--accent-soft-2` rule, italic-but-tight type, slightly
  smaller.

### 9.9 Login page redesign

- Centre the card on a warm cream background (light) / espresso (dark).
- Brand mark: codex logo + claude logo, separated by a small `×` (was just adjacent), giving
  a "fleet of two engines" feeling.
- Title: serif, 32px.
- Subhead: 14px muted.
- Input field: 44px tall, 1px `--input-border`, `--radius-sm`.
- Submit: full-width, 44px tall, primary fill, with `Enter ↵` kbd hint inset right.

### 9.10 Mobile
- Same warm palette inherits.
- Ensure tap targets ≥ 44px.
- The hosts/logs/settings horizontal scroll tab strip gets a fade-edge mask (CSS mask-image)
  to hint at scrollability.

---

## 10. Out-of-scope / non-goals (re-stated for the designer)

- ❌ Don't introduce a JS framework (no React, Vue, Svelte, htmx).
- ❌ Don't propose a build pipeline (no Vite, Tailwind compile, PostCSS).
- ❌ Don't redesign the IA. Same routes, same tab structure, same disclosure menus.
- ❌ Don't remove the pink themes. They're a feature.
- ❌ Don't add icons from icon fonts or Lucide/Heroicons unless self-hosted as inline SVG.
- ❌ Don't add marketing copy, hero illustrations, or testimonial blocks.
- ❌ Don't replace charts with a different lib; Chart.js stays.
- ❌ Don't target mobile-first; desktop is canonical.
- ❌ Don't break any of the class names listed in §2.3.

---

## 11. Deliverables expected from the design pass

When the design Claude session produces output, it should hand back:

1. **Updated `theme.css`** — full file, all six themes defined, common tokens at top.
2. **Updated `dashboard.css`** — full file, restyled to match the warm direction. Class names
   preserved.
3. **Updated `login.css`** — full file.
4. **Optional `dashboard-mobile.css` patch** — only the deltas needed for the new tokens.
5. **Annotated mockups** (HTML or SVG artifacts) for at minimum:
   - Dashboard (default) in light + dark.
   - Hosts list in light.
   - Host detail page in dark.
   - Settings → General (Emergency group) in light.
   - Login in light.
6. **Migration notes** — list of any class names that needed changing (ideally none) and any
   JS hooks the designer noticed that read CSS variables (so they keep working).

---

*End of spec. Feed sections 1–8 as ground truth; section 9 as recommended direction; section 10
as guardrails; section 11 as the expected output shape.*
