---
title: Projects workspace
section: Admin workspace
verified: 2026-06-05
sources: api/src/routes/admin/projects/index.ts, api/src/services/projects.ts, api/src/services/project-drafts.ts, api/src/services/project-content.ts, api/src/services/host-projects.ts, api/src/db/schema.ts
---

Projects is an optional workspace module that gives your agents a shared surface: an *about* object, a *roster* markdown document, notes, todos, files, feedback, and a derived MCP skill (`coco`) that teaches agents how to use it. It is off by default.

## Turning it on

The module toggle is embedded in the header area of the `/projects` list page — it is not under a separate Settings section. The backing endpoints:

- `GET /admin/projects/state` — returns `{ enabled: bool, … }`.
- `POST /admin/projects/state` — flip the flag.

When disabled, a warning alert renders on the list page, the `project_*` MCP tools are not registered (see `mcp-tools.ts`), and the rail section is hidden. When enabled, host API keys can call the host-facing project routes and the MCP tools appear in their capability.

## Creating and listing projects

Admin surface in `api/src/routes/admin/projects/index.ts` (all gated by `requireAdmin`):

- `GET /admin/projects` — list all projects.
- `POST /admin/projects` — create one. Body: `{ slug, about?, roster_markdown? }`. `agents_markdown` is accepted as a legacy alias for `roster_markdown`; both map to the same field. `slug` must be a URL-safe short identifier.
- `DELETE /admin/projects/{slug}` — hard delete with cascade.
- `GET /admin/projects/{slug}` — full state including notes, todos, files, feedback counts, and feedback list.

The list page renders projects as cards in a responsive grid. The "New project" button (disabled when the module is off) opens a `NewProjectDialog`. Each card has a delete action that requires confirmation.

The `coord_projects` table also has an `archived_at` column, which supports soft-archive semantics at the schema level, but this is not currently surfaced in the UI or admin API.

Host-facing surface (authenticated by per-host API key):

- `GET /projects`, `POST /projects`, `GET /projects/{slug}`, `GET /projects/{slug}/bootstrap` — the bootstrap endpoint is the compact context payload agents read to orient themselves.

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

These endpoints are only confirmed on the admin surface. The host-facing `/projects/{slug}/...` surface should be verified separately before relying on it for agent self-updates.

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

Small blob artifacts stored entirely in the database (`coord_project_files` table — no disk). Each file record stores: `stored_name` (unique per project), `description`, `mime_type`, `content` (longtext), `content_sha256` (SHA-256 hash of the content, computed at upsert), and `size_bytes` (computed at upsert).

Upsert-style: `POST /admin/projects/{slug}/files` overwrites an existing `stored_name` or creates a new one.

The Files tab shows an upsert form with fields: Stored name, MIME type, Description, and Content. Existing files are shown in a table with columns: Name, MIME, Description, Size (formatted bytes), Updated, and Actions (Load into form / Delete).

## Feedback

A low-friction queue where agents can drop observations or flagged issues. Valid `type` values are: `bug`, `feature`, `note`, `issue`, `test`.

- `GET /admin/projects/{slug}/feedback` — per-project feedback.
- `POST /admin/projects/{slug}/feedback` — create. Body: `{ type, title, body }`.
- `GET /admin/projects/feedback` — fleet-wide aggregate for triage.

The Feedback tab shows a create form with a Type selector (Feature / Bug / Issue / Test / Note), Title, and Body. The feedback list is read-only in the UI (no edit or delete). Items are sorted newest-first. The `coord_project_feedback` table also has a `status` column (default `'open'`).

## Activity

Every mutation above appends to `coord_project_events`. `GET /admin/projects/{slug}/changes` returns a paginated event log (querystring: `since` sequence number).

The Activity tab shows the 10 most recent events sorted by sequence descending. Each event renders as an expandable card showing: a seq badge, an `event_type.action` label, a relative timestamp, and a collapsible JSON payload panel.

`coord_project_events` columns: `seq`, `event_type`, `action`, `entity_type`, `entity_id`, `payload_json`, `source_host_id`.

## The `coco` skill

When the Projects module is on, a canonical *coco* skill ships to every host. It documents the MCP tools an agent should call (`project_list`, `project_bootstrap`, `project_note_upsert`, `project_todo_create`, …) and the expected workflow. `SkillsService` (`api/src/services/skills.ts`) ensures this skill is always at the latest orchestrator-wide version.

## Bootstrapping an agent into a project

Minimal workflow a Codex or Claude agent will run:

1. Call `project_list` to find the slug it cares about.
2. Call `project_bootstrap` with that slug to receive the compact context.
3. Call `project_changes` with `since` set to its last seen sequence to catch up on activity.
4. Use `project_note_upsert` / `project_todo_*` / `project_file_upsert` / `project_feedback_create` to record its work.

The MCP tool schemas live in `api/src/services/mcp-tools.ts`.

## Source references

- api/src/routes/admin/projects/index.ts (admin surface)
- api/src/routes/projects-client/index.ts (host-facing /projects/* surface)
- api/src/services/projects.ts (project CRUD)
- api/src/services/project-drafts.ts (assist via runner)
- api/src/services/project-content.ts (notes/todos/files/feedback)
- api/src/services/host-projects.ts (MCP-facing access for hosts)
- api/src/services/mcp-tools.ts (project_* tool definitions)
- api/src/db/schema.ts (coord_projects, coord_project_notes, coord_project_todos, coord_project_files, coord_project_feedback, coord_project_events)
