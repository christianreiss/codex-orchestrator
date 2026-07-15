---
title: Projects workspace
section: Admin workspace
verified: 2026-07-15
sources: api/src/routes/admin/projects/index.ts, api/src/routes/projects-client/index.ts, api/src/services/projects.ts, api/src/services/project-drafts.ts, api/src/services/project-content.ts, api/src/services/host-projects.ts, api/src/services/mcp-tools.ts, api/src/services/mcp-resources.ts, api/src/services/managed-coco-skill.ts, api/src/services/host-skills.ts, api/src/db/schema.ts, api/src/db/migrations/0003_add_coord_project_memories.sql
---

Projects is an optional workspace module that gives your agents a shared surface: an *about* object, a *roster* markdown document, notes, todos, files, memories, feedback, and a derived MCP skill (`coco`) that teaches agents how to use it. It is off by default.

## Turning it on

The module toggle is embedded in the header area of the `/projects` list page — it is not under a separate Settings section. The backing endpoints:

- `GET /admin/projects/state` — returns `{ enabled: bool, updated_at, managed_skill: { slug, uri } }`.
- `POST /admin/projects/state` — flip the flag.

When disabled: the `/projects` list page shows a warning banner and disables the "New project" button, and the synthetic `coco` skill stops being served (`getManagedCocoSkillIfEnabled` in `managed-coco-skill.ts` returns `null` while the flag is off — see "The `coco` skill" below). The flag does **not** gate anything else: the `project_*` MCP tools are unconditionally registered in `McpToolsRegistry` (`mcp-tools.ts`), the host-facing `/projects/*` REST routes (`routes/projects-client/index.ts`) have no enabled check, and the admin CRUD surface bypasses the flag by design (see the comment atop `projects.ts`). The `Projects` sidebar nav item (`frontend/src/lib/nav.ts`) is also always visible regardless of state. In practice the toggle only affects the admin UI's list-page messaging and whether `coco` is offered to agents.

## Creating and listing projects

Admin surface in `api/src/routes/admin/projects/index.ts` (all gated by `requireAdmin`):

- `GET /admin/projects` — list all projects.
- `POST /admin/projects` — create one. Body: `{ slug, about?, roster_markdown? }`. `agents_markdown` is accepted as a legacy alias for `roster_markdown`; both map to the same field. `slug` must be a URL-safe short identifier.
- `DELETE /admin/projects/{slug}` — hard delete with cascade.
- `GET /admin/projects/{slug}` — full state including notes, todos, files, feedback counts, and feedback list.

The list page renders projects as cards in a responsive grid. The "New project" button (disabled when the module is off) opens a `NewProjectDialog`. Each card has a delete action that requires confirmation.

The `coord_projects` table also has an `archived_at` column, which supports soft-archive semantics at the schema level, but this is not currently surfaced in the UI or admin API — though host-facing lookups (`HostProjectsService.listProjects`/`findBySlug`) already filter on it, so a row archived by direct DB access would disappear from a host's `GET /projects` listing.

Host-facing surface (authenticated by per-host API key, `routes/projects-client/index.ts`):

- `GET /projects`, `POST /projects`, `GET /projects/{slug}`, `GET /projects/{slug}/bootstrap` — the bootstrap endpoint is the compact context payload agents read to orient themselves.
- The full sub-resource set also has host-facing equivalents: notes, todos (including `.../done` and `.../undone`), files, feedback, and `GET /projects/{slug}/changes` all mirror the admin routes described in their respective sections below, one-to-one.

## Project detail layout

The `/projects/[slug]` page fetches full project detail. The page header shows the project `title` (from `about.title`) with the slug as a subtitle when it differs. Below the header, a 4-stat bar shows:

- **Notes** — total note count
- **Open todos** — count of incomplete todos
- **Bugs** — count of feedback items with `type = bug` specifically
- **Files** — total file count

A tab nav (`ProjectTabsNav`) routes to sub-pages: About, Notes, Todos, Files, Feedback, Activity. Header actions include a Back button and a Delete project button (destructive, with a confirm dialog).

## About and roster

The About tab shows two cards:

- **About** — three separate text inputs: *Title*, *Name*, and *Description*. These map to the `title`, `name`, and `description` sub-fields of the `about_json` JSON column. The `about_json` column always stores an object with these three canonical keys; the UI exposes them individually.
- **Roster** — a monospace textarea for the roster markdown document.

Each card has Save, Reset, and AI-Assist ("Sparkles") buttons. Unsaved changes are shown with a warning badge.

Endpoints:

- `POST /admin/projects/{slug}/about` — replaces the about value. The service accepts either a bare object (used directly as the stored value) or a wrapper `{ about: <object> }` form; both are equivalent.
- `POST /admin/projects/{slug}/roster` — replaces the roster markdown. Accepts either `{ roster_markdown }` or `{ markdown }` as aliases; both work.

The host-facing surface mirrors these exactly: `POST /projects/{slug}/about` and `POST /projects/{slug}/roster` (`routes/projects-client/index.ts` → `HostProjectsService.updateAbout`/`updateRoster`) accept the same bodies and are safe for agents to call directly for self-updates.

## The assist button

The AI-Assist ("Sparkles") button on the About and Roster cards calls `POST /admin/projects/{slug}/assist`, which calls `ProjectDraftsService.assist` (`api/src/services/project-drafts.ts`). That service hands the project state to the runner (`POST /projects/assist` on `runner/app.py`) and returns a suggested update that pre-fills both forms. The admin must still save manually. The endpoint refuses with a structured error when the runner integration is not configured (`AUTH_RUNNER_URL` + `AUTH_RUNNER_SHARED_SECRET`).

## Notes

Header + body, versioned by `updated_at`. Admin endpoints:

- `GET /admin/projects/{slug}/notes`
- `POST /admin/projects/{slug}/notes`
- `POST /admin/projects/{slug}/notes/{id}` — inline edit
- `DELETE /admin/projects/{slug}/notes/{id}`

The Notes tab shows a create form (Header and Body, both required). Existing notes are listed with inline edit (pencil icon) and delete. Updates are applied optimistically.

## Todos

Title + detail + done state. The Todos tab shows a create form (Title required, Detail optional). The list is split into "Open" and "Done" sections; the Done section is collapsible. A checkbox toggles done/undone state. Inline edit and delete are available per item.

Explicit done/undone helpers so MCP tool calls can toggle cheaply:

- `POST /admin/projects/{slug}/todos/{id}/done`
- `POST /admin/projects/{slug}/todos/{id}/undone`

## Files

Small blob artifacts stored entirely in the database (`coord_project_files` table — no disk). Each file record stores: `stored_name` (unique per project), `description`, `mime_type`, `content` (longtext), and `content_sha256` (SHA-256 hash of the content, computed at upsert). `size_bytes` is not a stored column — it is derived on every read as `Buffer.byteLength(content, 'utf8')` (see `formatFile()` in `projects.ts`).

Upsert-style: `POST /admin/projects/{slug}/files` overwrites an existing `stored_name` or creates a new one.

The Files tab shows an upsert form with fields: Stored name, MIME type, Description, and Content. Existing files are shown in a table with columns: Name, MIME, Description, Size (formatted bytes), Updated, and Actions (Load into form / Delete).

## Feedback

A low-friction queue where agents can drop observations or flagged issues. Valid `type` values are: `bug`, `feature`, `note`, `issue`, `test`.

- `GET /admin/projects/{slug}/feedback` — per-project feedback.
- `POST /admin/projects/{slug}/feedback` — create. Body: `{ type, title, body }`.
- `GET /admin/projects/feedback` — fleet-wide aggregate for triage.

The Feedback tab shows a create form with a Type selector (Feature / Bug / Issue / Test / Note), Title, and Body. The feedback list is read-only in the UI (no edit or delete). Items are sorted newest-first. The `coord_project_feedback` table also has a `status` column (default `'open'`).

## Memories

Durable facts bound to the project rather than to a host (`coord_project_memories` table), addressed by a `memory_key` unique per project. This is the surface for context that must survive across sessions and be readable from any host — decisions and their reasons, constraints, gotchas, environment facts. It is host-facing only: there are no `/admin/projects/{slug}/memories` routes and no UI tab, so memories are reached over MCP (`project_memory_*`) or the host REST mirror (`/projects/{slug}/memories`).

The contrast with host-scoped `mcp_memories` is the reason this exists: project memories are visible fleet-wide, can be enumerated without knowing a key (`project_memory_list`), hard-delete rather than soft-delete, and record every mutation in the activity log with `source_host_id` attribution. Host memories can do none of those. See [MCP server and tools](/admin/manual/mcp) for the full comparison and the validation rules.

`project_memory_upsert` is idempotent: an identical re-store reports `unchanged`, writes nothing, and deliberately records **no** event, so a no-op cannot bump `latest_event_seq` and force other hosts to re-sync.

## Activity

Every mutation above appends to `coord_project_events`. `GET /admin/projects/{slug}/changes` returns a paginated event log (querystring: `since` sequence number).

The Activity tab shows the 10 most recent events sorted by sequence descending. Each event renders as an expandable card showing: a seq badge, an `event_type.action` label, a relative timestamp, and a collapsible JSON payload panel.

`coord_project_events` columns: `seq`, `event_type`, `action`, `entity_type`, `entity_id`, `payload_json`, `source_host_id`.

## The `coco` skill

When the Projects module is on, a canonical *coco* skill ships to every host. It documents the MCP tools an agent should call (`project_list`, `project_bootstrap`, `project_note_upsert`, `project_todo_create`, …) and the expected workflow. Unlike ordinary skills, `coco` is not a row in the `skills` table: its manifest is a hardcoded constant synthesized on demand by `managed-coco-skill.ts` (`buildManagedCocoSkill`), and `getManagedCocoSkillIfEnabled()` returns it only while `projects_module_enabled` is on. `HostSkillsService` (`api/src/services/host-skills.ts`) merges this managed skill into the host-facing `/skills` list, `/skills/retrieve`, and the on-disk Claude skill bundle, and rejects any attempt to store or delete the `coco` slug directly (`SkillsService`/`HostSkillsService` both special-case `isManagedCocoSlug`). Because the manifest text is fixed at deploy time rather than versioned in the DB, "latest version" here means the current build's constant, not a DB-tracked revision history like other skills.

## MCP resource exposure

Beyond the `project_*` tools, projects are also exposed as MCP resources (`resources/list` / `resources/read`) via `McpResourcesService` (`api/src/services/mcp-resources.ts`):

- `project://{slug}` — the same compact bootstrap payload as `project_bootstrap`, JSON-encoded.
- `project://{slug}/files/{stored_name}` — a single project file's raw content; `mimeType` is taken from the file's `mime_type`, with binary-looking types downgraded to `application/octet-stream` for transport.
- `project://{slug}/memory/{key}` — a single project memory, JSON-encoded. Unlike the other `project://` paths this one is writable via `resource_create`/`resource_update`/`resource_delete`, though only `text` survives the trip — use `project_memory_upsert` when tags or metadata matter.

`resources/list` enumerates every project as a `project://` entry plus up to 50 of its files (`PROJECT_FILES_LIST_CAP`) and up to 50 of its memories (`PROJECT_MEMORIES_LIST_CAP`) each; reading a file or memory by exact name works even if it wasn't included in that cap. These templates are advertised via `listTemplates()` alongside `memory://{key}` and `skill://{slug}`.

## Bootstrapping an agent into a project

Minimal workflow a Codex or Claude agent will run:

1. Call `project_list` to find the slug it cares about.
2. Call `project_bootstrap` with that slug to receive the compact context — including `counts.memories` and up to 8 memory previews under `recent_memories`.
3. Call `project_memory_list` to enumerate durable memory in full. A zero-knowledge agent should never guess search terms; listing is the entry point.
4. Call `project_changes` with `since` set to its last seen sequence to catch up on activity.
5. Use `project_note_upsert` / `project_todo_*` / `project_file_upsert` / `project_memory_upsert` / `project_feedback_create` to record its work.

The MCP tool schemas live in `api/src/services/mcp-tools.ts`.

## Source references

- api/src/routes/admin/projects/index.ts (admin surface)
- api/src/routes/projects-client/index.ts (host-facing /projects/* surface — mirrors the admin surface, not gated by the module flag)
- api/src/services/projects.ts (project CRUD)
- api/src/services/project-drafts.ts (assist via runner)
- api/src/services/project-content.ts (notes/todos/files/feedback)
- api/src/services/host-projects.ts (host-facing project service used by both REST routes and MCP tools)
- api/src/services/mcp-tools.ts (project_* tool definitions; always registered regardless of module state)
- api/src/services/mcp-resources.ts (project:// resource exposure)
- api/src/services/managed-coco-skill.ts (synthesized coco skill manifest, gated on projects_module_enabled)
- api/src/services/host-skills.ts (merges the managed coco skill into host-facing skill list/retrieve/bundle)
- api/src/db/schema.ts (coord_projects, coord_project_notes, coord_project_todos, coord_project_files, coord_project_feedback, coord_project_memories, coord_project_events)
- api/src/db/migrations/0003_add_coord_project_memories.sql (coord_project_memories DDL — source of truth incl. the full-text index Drizzle cannot express)
