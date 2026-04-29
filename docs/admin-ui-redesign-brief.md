# Admin UI Redesign — One-Page Brief

**App:** codex-orchestrator admin console (`/admin/*`)
**Goal:** Restyle the existing pages — **inventory unchanged, pixels rebuilt**.
**Direction:** Warm operator console (Anthropic-flavoured, editorial, paper-not-plastic).
**Companion doc:** `admin-ui-design-spec.md` (full inventory + tokens).

---

## What this app is
Self-hosted control plane for a Codex/Claude inference fleet. Single operator, mTLS-gated,
desktop-canonical. Daily-driver console — values **density + keyboard speed + at-a-glance state**
over polish.

## Hard constraints
- Pure PHP + vanilla JS, **no framework, no build step**.
- CSS-variable theming. All existing class names + token names preserved.
- **Six themes must remain**: Auto, Auto Pink, Light, Dark, Bright Pink, Dark Pink. Pink stays
  as-is — only the Auto/Light/Dark trio gets the warm makeover.
- Self-hosted Inter (variable) + JetBrains Mono. Optionally add a self-hosted serif for display.
- Mobile responsive but desktop-first.

## Pages to restyle
| Surface | Notes |
|---|---|
| Login | Username-first; passkey or password; codex+claude brand mark |
| Dashboard | Status bar · ChatGPT card + Claude card · ops strip · Quota & Cost charts |
| Hosts list | Tabs: All / Secure / Insecure / Unprovisioned; sortable table; chip states |
| Host detail | 4 sections: Stats / Action items / Technical context / Host controls |
| Logs | 3 tabs: API logs / MCP logs / Events (audit) — filter-heavy tables |
| Settings — General | 4 groups: Emergency (kill switch) / Security & Access / Fleet / DevEx |
| Settings — Users / Agents / Memories / Projects / Profiles / Skills / OpenAI / Claude / API Keys / Joplin | Each panel is a `.card .panel`; consistent panel-head pattern |
| Project workspace | Tabs: Identity / Notes / Todos / Files / Feedback / Activity |
| Skill detail | Two-pane: chat ↔ AI-managed fields |
| Manual | Markdown viewer with TOC + search |
| Account | Password + Passkeys |

## Components in inventory
Editorial rail (top nav with disclosure menus), card/panel, panel-head, setting-block,
general-group, kv-grid, sortable table with loading rows, modal (with backdrop), toggle
(track+thumb+label), pill-quiet, chip-row, eyebrow/overline, seed-chip with status dot, toast,
range slider, button group as radio, kbd shortcut display, Chart.js canvases.

## Live patterns to support
WebSocket events (`log.created`, `toast`, `auth.insecure.pending`, `host.updated`,
`host-detail-support`). Synthesized **bell sound** on new insecure approval requests. Dirty-edit
guards on Config & Profiles. Full keyboard map (`d`, `h a/s/i/u/n`, `l c/m/e`, `s g/u/a/c/l/i/k/m/p/r`, `?`, `/`, `Esc`).

## Visual direction — "warm operator console"
> Paper, not plastic. Editorial, not playful. Density, with breathing room.

Move the cold default away from midnight-navy + cyan toward warm cream + amber/terracotta:

| Token | Light "Paper" | Dark "Ink" |
|---|---|---|
| `--bg` | `#F7F4EE` (warm cream) | `#1A1614` (espresso) |
| `--bg-2` | `#EFEBE2` | `#221C18` |
| `--card` | `#FFFEFB` | `#28221E` |
| `--text` | `#1B1612` | `#F2EBE0` |
| `--accent` | `#C2410C` (terracotta) | `#F59E0B` (amber) |
| `--btn-text` | `#FFF8F0` | `#1A1614` |

**Surfaces:** drop gradients (except CTA + cost-chart fill), favour 1px hairlines over shadows,
radii bump from 8→10 for cards.
**Type:** keep Inter for UI, add a self-hosted **serif** for h1/h2 (Source Serif 4 or
Newsreader); body 14px, h2 22px serif, h1 30px serif, tabular-nums on every number.
**Spacing:** 4px base scale; cards 20px padding, panels 24px, group separation 32px.
**Motion:** 150ms ease-out on toasts/modals/drawers; instant page transitions; respect
reduced-motion.
**Status colours:** brick-red `#B91C1C` danger, forest `#15803D` success, amber `#B45309`
warning. Mustard-not-cyan harmony.

## Don'ts
- ❌ Don't change IA / routes / tab structure.
- ❌ Don't rename CSS classes or tokens.
- ❌ Don't remove the pink themes.
- ❌ Don't introduce a framework, build step, or icon font.
- ❌ Don't add hero sections, marketing copy, or illustrations.

## Deliverables expected
1. New `theme.css` (all 6 themes).
2. New `dashboard.css` (restyled, classes preserved).
3. New `login.css`.
4. Patch for `dashboard-mobile.css` if needed.
5. Annotated mockups for: Dashboard (light+dark), Hosts list, Host detail (dark), Settings
   General (light), Login.
6. Migration notes — any class/token shifts + JS hooks observed.

---

*Use this brief to scope the work. Use `admin-ui-design-spec.md` for everything else.*
