# Redesign Discovery Notes

**Date:** 2026-04-29
**Branch:** `redesign/warm-operator-console`
**Design package:** Claude Design export (tarball), contains `theme.css`, `admin.css`, and React mockups for Login, Dashboard, Hosts list.

---

## What the design package provides

### Tokens (theme.css)
Complete 6-theme token file with the "warm operator console" palette:
- **Paper (light):** `--bg: #F7F4EE` (warm cream), `--accent: #C2410C` (terracotta), `--text: #1B1612`
- **Ink (dark):** `--bg: #1A1614` (espresso), `--accent: #F59E0B` (amber), `--text: #F2EBE0`
- **Pink themes:** preserved, lightly retuned (border/panel-strong switched from rgba to solid hex)
- New `--font-display` set to `'Source Serif 4'` (serif) for editorial headings
- New `--ease` and `--dur` motion tokens
- Radii bumped: `--radius: 10px`, `--radius-lg: 14px`, `--radius-xl: 18px`
- Shadows reduced to hairline-first: `--shadow-soft: 0 0 0 transparent`
- `--surface-tint` and `--table-header` changed from gradients to solid colours
- `prefers-reduced-motion` block kills all transitions/animations

### Components (admin.css)
Full component stylesheet covering: editorial rail, cards/panels, buttons, forms, toggles,
pills/chips, tables, tabs, dashboard (status bar, primary cards, lane meters, stat grids,
ops strip, charts), login, kv-grid. All class names match spec §2.3.

### Mockups (mockups.jsx)
Three surfaces rendered as React components (prototype only, not production):
1. **Login** — centred card, now superseded by the Switchyard brand lockup; serif h1, 44px inputs, kbd hint
2. **Dashboard** — full layout: status bar, ChatGPT/Claude primary cards with lane meters + stat grids, ops strip with seed chips, line+bar chart canvases
3. **Hosts list** — panel with tabs (All/Secure/Insecure/Unprovisioned), sortable table, state chips

### What the design package does NOT cover
- Host detail page (dark)
- Settings — General page
- Logs pages
- Project workspace / Skill detail
- Manual viewer
- Account pages
- Mobile-specific layouts
- Toast styling details
- Modal styling (only conceptual from admin.css)

For uncovered pages, I'll follow the component primitives from admin.css and the recommendations in `docs/admin-ui-design-spec.md` §9.

---

## Selector architecture difference

The design package uses `:root[data-theme='...']` selectors, but the existing JS sets `document.body.dataset.theme`. I will keep `body[data-theme="..."]` selectors to match the JS.

The design defaults `auto` to light (dark in media query); current code defaults `auto` to dark (light in media query). I'll keep the design's convention (light default, dark override) since `auto` follows the OS either way.

## Token conflicts with spec

| Token | Design package | Spec §9.2 | Resolution |
|---|---|---|---|
| `--panel-strong` | `#FFFEFB` (light) / `#2E2723` (dark) — solid | Spec doesn't specify | Use design values |
| `--surface-tint` | Solid colour | Spec §9.3 says "drop gradients" | Use design (solid) |
| `--table-header` | Solid colour | Spec §9.6.4 says "solid, no gradient" | Use design (solid) |
| `--frost` | `rgba(194,65,12,0.05)` (light) | Spec §9.3 says "5% accent-tint" | Aligned |

No conflicts with hard constraints (§4). No class renames, no framework additions, no icon fonts.

## Token redeclaration in dashboard.css

Current `dashboard.css` redeclares all theme tokens at lines 1–167. This creates a specificity
fight with `theme.css`. Per the spec comment at line 1 ("do not redeclare shared tokens here"),
I will remove these redeclarations from `dashboard.css` and let `theme.css` be the single source.

## Font: Source Serif 4

The design specifies Source Serif 4 for `--font-display`. I need to download and self-host the
font files under `public/admin/assets/fonts/`. Will use variable-weight woff2 for latin + latin-ext.

## Files to edit

Primary:
- `public/admin/assets/theme.css` — complete token rewrite
- `public/admin/assets/dashboard.css` — remove token redeclarations, restyle components
- `public/admin/assets/login.css` — restyle login
- `public/admin/assets/dashboard-mobile.css` — reconcile with new tokens

Secondary:
- `public/admin/index.html` — bump cache busters, possibly add font preload
- `public/admin/login.html` — bump cache busters
