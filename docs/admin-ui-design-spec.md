# Admin Console Design Specification

**Status:** current implementation contract, 2026-08-01.

The admin console is a static Svelte 5/SvelteKit SPA built from `frontend/` into
the committed `public/admin/` directory. Fastify serves the SPA for browser
navigations below `/admin/*`; JSON clients continue to use the same API paths
with `Accept: application/json`. The UI does not change API wire formats,
permissions, or backend ownership.

## Operator model

This is a desktop-first fleet console. It favors compact controls, full-width
data workspaces, direct routes, keyboard navigation, and state that can be
shared in a URL. Mobile remains fully operable through a four-item bottom bar
and a grouped navigation sheet.

The visual system is neutral zinc/slate with restrained blue interaction color.
Light, dark, and system modes use the same semantics. Inter is interface text;
JetBrains Mono is reserved for technical values. Semantic colors indicate real
state only. Decorative gradients, glass, entry motion, serif display type,
oversized radii, and card-within-card presentation are out of scope.

Desktop controls are 32–36px high. Dense table rows are 36–40px when their
content is single-line. Overlays may use a shadow; ordinary surfaces use
hairlines and 4–8px radii.

## One route registry

`frontend/src/lib/nav.ts` is the source of truth for the sidebar, mobile menu,
command palette, location labels, titles, and active state. A record includes a
stable id, group, route, label, description, keywords, match rule, and mobile
priority. Do not add a second navigation list to a page.

| Group | Direct destinations |
| --- | --- |
| Monitor | Overview, Activity |
| Fleet | Hosts, Engines, Policies |
| Coordinate | Projects, Agent Messaging, Agent Portal |
| Knowledge | Skills, Fleet Instructions, Memories, Subagents, Commands, Output Styles |
| Access | API Access, Secrets, Admin Users |
| Utilities | Manual and Account, in the sidebar footer |

Groups are labels, never navigation steps. Every destination is clickable from
the rail and available through Cmd/Ctrl-K. The persistent mobile bar keeps
Overview, Hosts, Projects, and Activity; all other routes are in Menu.

## Canonical control ownership

Each mutable fleet setting has exactly one editable home:

| Owner | Controls |
| --- | --- |
| `/api-keys` | API master state, OpenAI/Claude proxy state and defaults, compatible endpoint URLs, issued API keys |
| `/engines` | Codex/Claude models, effort, version pins, silence, quota enforcement, scaling, Claude client settings |
| `/policies` | Auto-update, reverse DNS, insecure approval, host pruning, log retention |
| `/agent-messaging` | Fleet switch, addresses, conversations, deliveries, audited reveal/redrive |
| `/agent-portal` | Portal switch, users, permanent-link reveal/rotate lifecycle |
| `/projects`, `/secrets` | Their own module switches and data lifecycle |
| `/users` | Admin accounts, roles, and access lifecycle |

Overview reports health and exceptions only. It links to the relevant owner; it
does not duplicate controls. WebSocket invalidation follows the same ownership:
Agent Messaging and Agent Portal changes invalidate only their own query roots.

## Templates and primitives

- Lists use a full-width toolbar plus dense, sortable table, sticky header,
  hover state, and row actions. Hosts, API keys, Secrets, Users, Projects, and
  knowledge lists follow this model.
- Detail pages progress through full-width task sections. A detail route can
  have peer tabs, but a second sidebar tier is not permitted.
- Engine and policy pages use labeled setting boundaries and explicit save
  status rather than nested configuration cards. Related controls stay in one
  full-width task sequence; do not split paired settings into desktop columns.
- Agent Messaging uses one master state at the top with Addresses,
  Conversations, and Deliveries as peer operational views sharing URL filters.
- Memories has alternate Atlas and Inventory views. Editors provide a wide
  writing area and keep history/metadata in dedicated detail surfaces.
- Activity keeps Audit and MCP as peer views with shareable filters. Raw JSON
  belongs in an opened detail, not an always-expanded table cell.

Shared primitives live under `frontend/src/lib/components/layout/`,
`data-table/`, and `ui/`. Prefer them over one-off spacing or card styles.

## Legacy URLs and themes

The retired Settings and Authoring hubs are client 308 redirects. Their mapping
is centralized in `frontend/src/lib/legacy-admin-routes.ts` and tested. In
particular:

- `/settings` and `?tab=availability` redirect to
  `/api-keys#service-availability`.
- `?tab=engines` redirects to `/engines`; `?tab=fleet-policy` to `/policies`.
- `?tab=claude-config` and `/authoring/settings` redirect to
  `/engines#claude-client`.
- `/settings/users` and `/settings/agent-portal` redirect to `/users` and
  `/agent-portal`. Section hashes map to their owning section.
- Old Authoring URLs redirect to the direct Knowledge route while preserving a
  skill, subagent, command, or output-style detail slug.

The server continues to accept `auto-pink`, `bright-pink`, and `dark-pink` for
backward compatibility. The client maps them to `system`, `light`, and `dark`,
removes the old palette local-storage key, and renders the neutral design
system only.

## Verification

For every admin change run from `frontend/`:

```bash
npm run check
npm run test
npm run test:e2e
npm run build
```

`npm run build` rebuilds the committed `public/admin/` SPA. Navigation tests
cover route registry completeness, direct route existence, titles, mobile
partitioning, and legacy mapping. Contrast tests enforce light/dark text and
control contrast. Playwright fixtures keep browser checks deterministic and Axe
gates serious and critical findings. The suite covers desktop 1440×900/1920×900
and a 390px representative mobile flow, including direct navigation, the
command palette, drawers, tables, and neutral theme controls.

The canonical-route browser sweep visits every direct registry destination at
1440×900. It requires the exact page heading and document title, a clean
runtime, and no document-level horizontal overflow, so a page cannot quietly
fall back to a shell-only, mislabeled, or broken deep link.
