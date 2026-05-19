---
title: Projects workspace
section: Admin workspace
verified: 2026-04-19
sources: src/Http/Controllers/AdminProjectController.php, src/Http/Controllers/ProjectApiController.php, src/Services/ProjectCoordinationService.php, src/Services/ProjectDraftService.php, src/Services/ProjectModuleService.php, src/Services/ProjectNormalizer.php, src/Repositories/ProjectRepository.php, src/Repositories/ProjectNoteRepository.php, src/Repositories/ProjectTodoRepository.php, src/Repositories/ProjectFileRepository.php, src/Repositories/ProjectFeedbackRepository.php, src/Repositories/ProjectEventRepository.php, public/admin/assets/projects.js
---

Projects is an optional workspace module that gives your agents a shared surface: an *about* blurb, a *roster* markdown document, notes, todos, files, feedback, and a derived MCP skill (`coco`) that teaches agents how to use it. It is off by default.

## Turning it on

The module toggle lives at *Settings → Projects*. The backing endpoints:

- `GET /admin/projects/state` (`AdminProjectController::state`) — returns `{ enabled: bool, … }`.
- `POST /admin/projects/state` (`stateUpdate`) — flip the flag.

When disabled, the `project_*` MCP tools are not registered (see `McpToolDefinitions::projectsEnabled()`) and the rail section is hidden. When enabled, host API keys can call the project routes and the MCP tools appear in their capability.

## Creating and listing projects

Administrative surface on `AdminProjectController`:

- `GET /admin/projects` (`index`) — list all projects.
- `POST /admin/projects` (`create`) — create one. Body: `{ slug, about?, roster_markdown?, agents_markdown? }`. `slug` must be a URL-safe short identifier.
- `DELETE /admin/projects/{slug}` (`delete`) — delete and cascade.
- `GET /admin/projects/{slug}` (`show`) — full state including notes, todos, files, feedback, change history.

Host-facing surface on `ProjectApiController` (same shapes, authenticated by per-host API key):

- `GET /projects`, `POST /projects`, `GET /projects/{slug}`, `GET /projects/{slug}/bootstrap` — the bootstrap endpoint is the compact context payload agents read to orient themselves.

## Notes

Header + body, versioned by `updated_at`. Endpoints under both surfaces:

- `GET /admin/projects/{slug}/notes` (`notes`) / `GET /projects/{slug}/notes` (`listNotes`).
- `POST /admin/projects/{slug}/notes` (`noteCreate`) / `POST /projects/{slug}/notes` (`createNote`).
- `POST /admin/projects/{slug}/notes/{id}` (`noteUpdate`) / `POST /projects/{slug}/notes/{id}` (`updateNote`).
- `DELETE /admin/projects/{slug}/notes/{id}` (`noteDelete`) / `DELETE /projects/{slug}/notes/{id}` (`deleteNote`).

## Todos

Title + detail + done state; endpoints mirror notes, plus explicit `done/undone` helpers so MCP tool calls can toggle cheaply:

- `POST /admin/projects/{slug}/todos/{id}/done` / `POST /projects/{slug}/todos/{id}/done`.
- `POST /admin/projects/{slug}/todos/{id}/undone` / `POST /projects/{slug}/todos/{id}/undone`.

## Files

Small blob artifacts with a `stored_name`, `description`, `mime_type`, and `content`. `ProjectFileRepository` stores them in the database (no disk). Upsert-style: `POST /admin/projects/{slug}/files` overwrites an existing `stored_name` or creates a new one.

## Feedback

A low-friction queue where agents can drop user complaints or flagged issues:

- `GET /admin/projects/{slug}/feedback` — per-project feedback.
- `POST /admin/projects/{slug}/feedback` — create. Body: `{ type, title, body }`.
- `GET /admin/projects/feedback` (`allFeedback`) — fleet-wide aggregate for triage.

## Change history

Every mutation above appends to `ProjectEventRepository`. `GET /admin/projects/{slug}/changes` (`changes`) — and `GET /projects/{slug}/changes` (`listChanges`) — return a paginated list since a sequence number. The admin UI uses this to show the *Recent activity* panel on the project detail page; agents can use it to figure out what happened since they last checked in.

## The assist button

*Project → Assist* calls `POST /admin/projects/{slug}/assist` (`assist`), which hands the project state to the runner (`RunnerVerifier::assistProjectDraft()`) and returns a suggested update. The admin reviews it before saving. This is how operators iterate on *about* and *roster* copy without hand-editing markdown.

## About and roster

Two structured editable fields:

- `POST /admin/projects/{slug}/about` — replaces the about payload (JSON object).
- `POST /admin/projects/{slug}/roster` — replaces the roster markdown body.

Both are also exposed under `/projects/{slug}/...` on the host-facing surface so agents can self-update with the right capability.

## The `coco` skill

When the Projects module is on, a canonical *coco* skill ships to every host. It documents the MCP tools an agent should call (`project_list`, `project_bootstrap`, `project_note_upsert`, `project_todo_create`, …) and the expected workflow. `SkillService` ensures this skill is always at the latest orchestrator-wide version.

## Bootstrapping an agent into a project

Minimal workflow a Codex or Claude agent will run:

1. Call `project_list` to find the slug it cares about.
2. Call `project_bootstrap` with that slug to receive the compact context.
3. Call `project_changes` with `since` set to its last seen sequence to catch up on activity.
4. Use `project_note_upsert` / `project_todo_*` / `project_file_upsert` / `project_feedback_create` to record its work.

The MCP tool schemas are in `src/Mcp/McpToolDefinitions.php` lines 213–352.

## Source references

- src/Http/Controllers/AdminProjectController.php (admin surface)
- src/Http/Controllers/ProjectApiController.php (host-facing surface)
- src/Services/ProjectCoordinationService.php, ProjectDraftService.php, ProjectModuleService.php, ProjectNormalizer.php
- src/Repositories/ProjectRepository.php, ProjectNoteRepository.php, ProjectTodoRepository.php, ProjectFileRepository.php, ProjectFeedbackRepository.php, ProjectEventRepository.php
- src/Mcp/McpToolDefinitions.php (project_* tool definitions)
- public/admin/assets/projects.js (admin UI)
