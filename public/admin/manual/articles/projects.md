---
title: Projects workspace
section: Admin workspace
verified: 2026-05-20
sources: api/src/routes/admin/projects/index.ts, api/src/routes/projects-client/index.ts, api/src/services/projects.ts, api/src/services/project-drafts.ts, api/src/services/project-content.ts, api/src/services/host-projects.ts, api/src/db/schema.ts
---

Projects is an optional workspace module that gives your agents a shared surface: an *about* blurb, a *roster* markdown document, notes, todos, files, feedback, and a derived MCP skill (`coco`) that teaches agents how to use it. It is off by default.

## Turning it on

The module toggle lives at *Settings → Projects*. The backing endpoints:

- `GET /admin/projects/state` — returns `{ enabled: bool, … }`.
- `POST /admin/projects/state` — flip the flag.

When disabled, the `project_*` MCP tools are not registered (see `mcp-tools.ts`) and the rail section is hidden. When enabled, host API keys can call the host-facing project routes and the MCP tools appear in their capability.

## Creating and listing projects

Admin surface in `api/src/routes/admin/projects/index.ts` (all gated by `app.requireAdmin`):

- `GET /admin/projects` — list all projects.
- `POST /admin/projects` — create one. Body: `{ slug, about?, roster_markdown?, agents_markdown? }`. `slug` must be a URL-safe short identifier.
- `DELETE /admin/projects/{slug}` — delete and cascade.
- `GET /admin/projects/{slug}` — full state including notes, todos, files, feedback, change history.

Host-facing surface in `api/src/routes/projects-client/index.ts` (authenticated by per-host API key):

- `GET /projects`, `POST /projects`, `GET /projects/{slug}`, `GET /projects/{slug}/bootstrap` — the bootstrap endpoint is the compact context payload agents read to orient themselves.

## Notes

Header + body, versioned by `updated_at`. Endpoints under both surfaces:

- `GET /admin/projects/{slug}/notes` / `GET /projects/{slug}/notes`
- `POST /admin/projects/{slug}/notes` / `POST /projects/{slug}/notes`
- `POST /admin/projects/{slug}/notes/{id}` / `POST /projects/{slug}/notes/{id}`
- `DELETE /admin/projects/{slug}/notes/{id}` / `DELETE /projects/{slug}/notes/{id}`

## Todos

Title + detail + done state; endpoints mirror notes, plus explicit `done/undone` helpers so MCP tool calls can toggle cheaply:

- `POST /admin/projects/{slug}/todos/{id}/done` / `POST /projects/{slug}/todos/{id}/done`
- `POST /admin/projects/{slug}/todos/{id}/undone` / `POST /projects/{slug}/todos/{id}/undone`

## Files

Small blob artifacts with a `stored_name`, `description`, `mime_type`, and `content`. `project_files` stores them in the database (no disk). Upsert-style: `POST /admin/projects/{slug}/files` overwrites an existing `stored_name` or creates a new one.

## Feedback

A low-friction queue where agents can drop user complaints or flagged issues:

- `GET /admin/projects/{slug}/feedback` — per-project feedback.
- `POST /admin/projects/{slug}/feedback` — create. Body: `{ type, title, body }`.
- `GET /admin/projects/feedback` — fleet-wide aggregate for triage.

## Change history

Every mutation above appends to `project_events`. `GET /admin/projects/{slug}/changes` — and `GET /projects/{slug}/changes` — return a paginated list since a sequence number. The admin UI uses this to show the *Recent activity* panel on the project detail page; agents can use it to figure out what happened since they last checked in.

## The assist button

*Project → Assist* calls `POST /admin/projects/{slug}/assist`, which calls `ProjectDraftsService.assist` (`api/src/services/project-drafts.ts`). That service hands the project state to the runner (`POST /projects/assist` on `runner/app.py`) and returns a suggested update. The admin reviews it before saving. The endpoint refuses with a structured error when the runner integration isn't configured (`AUTH_RUNNER_URL` + `AUTH_RUNNER_SHARED_SECRET`).

## About and roster

Two structured editable fields:

- `POST /admin/projects/{slug}/about` — replaces the about payload (JSON object).
- `POST /admin/projects/{slug}/roster` — replaces the roster markdown body.

Both are also exposed under `/projects/{slug}/...` on the host-facing surface so agents can self-update with the right capability.

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
- api/src/db/schema.ts (projects, project_notes, project_todos, project_files, project_feedback, project_events)
