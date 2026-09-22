---
title: Projects workspace
section: Admin workspace
verified: 2026-09-09
sources: api/src/routes/admin/projects/index.ts, api/src/routes/admin/project-board/index.ts, api/src/routes/projects-client/index.ts, api/src/services/projects.ts, api/src/services/project-drafts.ts, api/src/services/project-content.ts, api/src/services/project-board.ts, api/src/services/project-board-roles.ts, api/src/services/host-projects.ts, api/src/services/mcp-tools.ts, api/src/services/mcp-resources.ts, api/src/services/managed-coco-skill.ts, api/src/services/host-skills.ts, api/src/db/schema.ts, api/src/db/migrations/0003_add_coord_project_memories.sql, api/src/db/migrations/0026_add_project_board.sql, api/src/services/shared-memories.ts, api/src/db/migrations/0006_add_shared_memories.sql
---

Projects is an optional workspace module that gives your agents a shared surface: an *about* object, a *roster* markdown document, notes, a board of cards (which todos are a view of), files, memories, feedback, and a derived MCP skill (`coco`) that teaches agents how to use it. It is off by default.

## Turning it on

Two module switches sit in the header area of the `/projects` list page — neither is under a separate Settings section. The backing endpoints:

- `GET /admin/projects/state` — returns `{ enabled: bool, updated_at, managed_skill: { slug, uri } }`.
- `POST /admin/projects/state` — flip the flag.
- `GET /admin/project-board/state` / `POST /admin/project-board/state` — the separate **Project board** switch (`project_board_enabled`), described under "Project board" below. It lives outside `/admin/projects/…` so that a project whose slug is `board` cannot shadow it.

When disabled: the `/projects` list page shows a warning banner and disables the "New project" button, and the synthetic `coco` skill stops being served (`getManagedCocoSkillIfEnabled` in `managed-coco-skill.ts` returns `null` while the flag is off — see "The `coco` skill" below). The flag does **not** gate anything else: the `project_*` MCP tools are unconditionally registered in `McpToolsRegistry` (`mcp-tools.ts`), the host-facing `/projects/*` REST routes (`routes/projects-client/index.ts`) have no enabled check, and the admin CRUD surface bypasses the flag by design (see the comment atop `projects.ts`). The `Projects` sidebar nav item (`frontend/src/lib/nav.ts`) is also always visible regardless of state. In practice the toggle only affects the admin UI's list-page messaging and whether `coco` is offered to agents.

## Creating and listing projects

Admin surface in `api/src/routes/admin/projects/index.ts` (all gated by `requireAdmin`):

- `GET /admin/projects` — list all projects.
- `POST /admin/projects` — create one. Body: `{ slug, about?, roster_markdown? }`. `agents_markdown` is accepted as a legacy alias for `roster_markdown`; both map to the same field. `slug` must be a URL-safe short identifier.
- `DELETE /admin/projects/{slug}` — hard delete with cascade.
- `GET /admin/projects/{slug}` — full state including notes, todos, files, feedback counts, and feedback list.

The list page renders projects as cards in a responsive grid. The "New project" button (disabled when the module is off) opens a `NewProjectDialog`. Each card has a delete action that requires confirmation.

Projects can be closed. **Archive project** in the detail page's *More* menu (or `project_archive` over MCP, or `POST /admin/projects/{slug}/archive`) sets `coord_projects.archived_at`; **Reopen project** clears it. An archived project drops out of `project_list` for hosts and out of the MCP resource catalogue, and the console's project list hides it behind a *Show archived* toggle — but it stays fully readable and writable by slug, because a finished migration is exactly the thing somebody comes back to read. Its slug also stays taken. Deleting a project is still the separate, irreversible action.

Until 2026-09-22 the column existed, carried an index, and was filtered on by every listing path — and no code anywhere wrote it, so nothing could ever leave a list.

Host-facing surface (authenticated by per-host API key, `routes/projects-client/index.ts`):

- `GET /projects`, `POST /projects`, `GET /projects/{slug}`, `GET /projects/{slug}/bootstrap` — the bootstrap endpoint is the compact context payload agents read to orient themselves.
- The full sub-resource set also has host-facing equivalents: notes, todos (including `.../done` and `.../undone`), files, feedback, and `GET /projects/{slug}/changes` all mirror the admin routes described in their respective sections below, one-to-one.

## Project detail layout

The `/projects/[slug]` page fetches full project detail. The page header shows the project `title` (from `about.title`) with the slug as a subtitle when it differs. Below the header, a 4-stat bar shows:

- **Notes** — total note count
- **Open todos** — count of cards not sitting in a terminal lane (`counts.open_todos`)
- **Bugs** — count of feedback items with `type = bug` specifically
- **Files** — total file count

A tab nav (`ProjectTabsNav`) routes to sub-pages: Identity, Notes, Board, Files, Feedback, Activity. The old `/projects/{slug}/todos` URL still resolves but redirects to the board. Header actions include a Back button and a Delete project button (destructive, with a confirm dialog).

## Identity: about and roster

The Identity tab (the project root URL) shows two cards:

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

## Project board

A todo is a checkbox; a card is a claim. `coord_project_todos` could record that work existed and whether it was finished, and nothing else — two agents could pick up the same item without either learning about the other, and an agent that closed its terminal mid-task left no trace. Migration `0026_add_project_board.sql` replaced it with a board (`coord_project_boards`, `coord_project_board_columns`, `coord_project_cards`; one board per project today, slug `default`) whose cards carry a claim: a declared role, a holder, the worktree that holder is working in, and an expiry.

**Todos did not go away; they became a view of the same cards.** The backfill moved every row onto a card and kept its id as the card number, so `project_todo_done(4711)` still resolves to the work item it always did. `project_todo_*`, the host `/projects/{slug}/todos` routes and the admin `/admin/projects/{slug}/todos` routes (including `.../done` and `.../undone`) all read and write cards now with the same signatures and wire shape; `done` means the card sits in a lane flagged terminal, and `undone` is a no-op on a card that is not there — sending it back to Backlog would silently discard its place in the pipeline. `coord_project_todos` is retained but no longer written. One work item is one row, so the two views cannot disagree.

The module switch (`project_board_enabled`, the second `ModuleSwitchRow` on the list page) gates none of that. Todos predate it, and switching it off hides the board's MCP tools and makes its page read-only rather than breaking an older API.

**Lanes and roles.** The migration seeds seven columns, duplicated as `SEEDED_COLUMNS` in `project-board.ts` and pinned against the SQL by a test: `backlog` (intake) → `planning` (`plan`) → `coding` (`code`) → `review` (`review`) → `verifying` (`verify`) → `done` (terminal), plus `blocked`. Roles are fleet-fixed — `plan`, `code`, `review`, `verify`, `ops` (`project-board-roles.ts`) — and self-declared per claim, exactly like `task` in `git_join`; `ops` has no lane of its own because it is the role that acts on the open ones. A lane's `allowed_roles`, `wip_limit` and `title` are reshaped with `POST /admin/projects/{slug}/board/columns/{id}`; there is no column create or delete, because deleting one would have to answer what happens to its cards.

**Advisory, like every verdict this orchestrator issues about a machine it cannot see.** Moving a card into a lane whose `allowed_roles` do not include yours still moves it and returns an `advisories` list (`role_not_allowed`); exceeding a WIP limit does the same (`wip_limit_exceeded`). Both are recorded on the event and in `logs`. The single refusal is `project_card_claim` against a card somebody else holds, and it declines to *record* the claim rather than to permit the work — the reply names the holder, their host and their expiry. A refused claim consumes no event sequence number, so an agent polling a busy card cannot flood the project's change log with its own rejections.

**Claims expire, and reclaiming is the point.** A claim lasts `CARD_CLAIM_TTL_SECONDS` (30 minutes; a board may override it with `claim_ttl_seconds`) and is renewed implicitly by any call naming the card by its holder — `project_card_get` is the cheapest. Passing `worktree_path` and `username` binds the claim to the agent's `agent_bus_addresses` row, and that is what makes reclaim fast: where Agent Messaging bound an address, `current_session_id` going NULL frees the card within seconds; with the module off, the TTL is the only signal. A bound agent that is merely quiet is never evicted, and the sweep fails open if the messaging tables cannot be read. Every reclaim writes a `claim_expired` event, which nothing but the sweep writes — that is what feeds the board page's **Recently reclaimed** list. Releasing (`project_card_release`) auto-advances the card along the lane's `next` pointer, so an agent that finishes coding need not know that review comes next; `resolution: "blocked"` parks it in the blocked lane with a note, `"handoff"` leaves it where it is, `"done"` sends it to the terminal lane, and naming a `column` wins over all of those. A release asserts no role, because the destination lane by construction belongs to a different one. Moving into the terminal lane releases the claim too.

**No history table.** Every create, move, claim, release and reclaim is a `coord_project_events` row with `entity_type = 'card'`, so board activity reaches the `project_changes` poll agents already run and the Activity tab. Every mutation takes `SELECT … FOR UPDATE` on the parent `coord_projects` row first — MySQL has no partial unique index, so that row lock is what makes a claim exclusive and what serialises card moves per project — and records its event through the transaction-scoped `_recordEventTx`, because the standalone recorder would block on a second pool connection until `innodb_lock_wait_timeout`.

Admin surface (`api/src/routes/admin/project-board/index.ts`; `projects.read` to look, `projects.manage` to change):

- `GET /admin/projects/{slug}/board` — the same rendering `project_board_list` gives an agent for one project: columns with their cards and holders, plus `reclaimed_recently`.
- `POST /admin/projects/{slug}/board/cards` — create; `POST .../cards/{id}` — edit title/detail/labels/priority/`blocked_reason`; `POST .../cards/{id}/move` — `{ column, note? }`; `POST .../cards/{id}/release` — force-release a claim from the console with an optional reason, the escape hatch for a holder that is unreachable but not detectably dead (a wedged process, a sleeping laptop), which neither reclaim signal catches; `DELETE .../cards/{id}`.
- `POST /admin/projects/{slug}/board/columns/{id}` — reshape a lane.

The Board tab renders one column per lane with an **Add card** form, a release action on held cards, and the Recently reclaimed list. There is no host-facing REST mirror of the board: agents reach it over MCP only, through `project_board_list` (never fails — with the module off it answers `status: "disabled"`, distinguishable from an empty board) and `project_card_create` / `claim` / `move` / `release` / `update` / `get`; the todo REST mirror remains for the checkbox view. See [MCP server and tools](/admin/manual/mcp) for the tool contracts.

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

The contrast with host-scoped `mcp_memories` is the reason this exists: project memories are visible fleet-wide, can be enumerated without knowing a key (`project_memory_list`), hard-delete rather than soft-delete, and record every mutation in the activity log with `source_host_id` attribution. Host memories can do none of those. Project memories are not the only fleet-visible store any more, though: `shared_memory_*` holds documents up to 1 MiB that belong to no project at all. Use project memories for short facts about *this* workstream and shared memories for reference material that outlives it. See [MCP server and tools](/admin/manual/mcp) for the three-way comparison and the validation rules.

`project_memory_upsert` is idempotent: an identical re-store reports `unchanged`, writes nothing, and deliberately records **no** event, so a no-op cannot bump `latest_event_seq` and force other hosts to re-sync.

## Activity

Every mutation above appends to `coord_project_events`. `GET /admin/projects/{slug}/changes` returns a paginated event log (querystring: `since` sequence number).

The Activity tab shows the 10 most recent events sorted by sequence descending. Each event renders as an expandable card showing: a seq badge, an `event_type.action` label, a relative timestamp, and a collapsible JSON payload panel.

`coord_project_events` columns: `seq`, `event_type`, `action`, `entity_type`, `entity_id`, `payload_json`, `source_host_id`.

## The `coco` skill

When the Projects module is on, a canonical *coco* skill ships to every host. It documents the MCP tools an agent should call (`project_list`, `project_bootstrap`, `project_note_upsert`, `project_board_list`, `project_card_claim`, …), the three-substrate memory routing (`project_memory_*` for this workstream, `shared_memory_*` for fleet-wide documents, `memory_*` never for handoffs), the fixed board role vocabulary, and the expected workflow — call `project_board_list` first, claim a card with a role and `worktree_path`/`username` before starting, release it the moment you stop. Unlike ordinary skills, `coco` is not a row in the `skills` table: its manifest is a hardcoded constant synthesized on demand by `managed-coco-skill.ts` (`buildManagedCocoSkill`), and `getManagedCocoSkillIfEnabled()` returns it only while `projects_module_enabled` is on. `HostSkillsService` (`api/src/services/host-skills.ts`) merges this managed skill into the host-facing `/skills` list, `/skills/retrieve`, and the on-disk Claude skill bundle, and rejects any attempt to store or delete the `coco` slug directly (`SkillsService`/`HostSkillsService` both special-case `isManagedCocoSlug`). Because the manifest text is fixed at deploy time rather than versioned in the DB, "latest version" here means the current build's constant, not a DB-tracked revision history like other skills.

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
4. Call `project_changes` with `since` set to its last seen sequence to catch up on activity — it returns at most 200 events per call, so iterate until `latest_seq`.
5. Call `project_board_list` (no arguments needed) to see which cards are free and who holds the rest, then `project_card_claim` one with a role and `worktree_path`/`username` before starting; `project_card_release` it when done.
6. Use `project_note_upsert` / `project_todo_*` / `project_file_upsert` / `project_memory_upsert` / `project_feedback_create` to record its work.

The MCP tool schemas live in `api/src/services/mcp-tools.ts`.

## Source references

- api/src/routes/admin/projects/index.ts (admin surface)
- api/src/routes/admin/project-board/index.ts (board module switch and per-project card/column routes)
- api/src/routes/projects-client/index.ts (host-facing /projects/* surface — mirrors the admin surface minus the board, not gated by the module flag)
- api/src/services/projects.ts (project CRUD; detail reads todos through the board)
- api/src/services/project-drafts.ts (assist via runner)
- api/src/services/project-content.ts (notes/files/feedback)
- api/src/services/project-board.ts (cards, claims, lanes, reclaim sweep, and the todo view over cards)
- api/src/services/project-board-roles.ts (the fixed plan/code/review/verify/ops vocabulary)
- api/src/db/migrations/0026_add_project_board.sql (board tables, seeded lanes, todo→card backfill)
- api/src/services/host-projects.ts (host-facing project service used by both REST routes and MCP tools)
- api/src/services/mcp-tools.ts (project_* tool definitions; always registered regardless of module state)
- api/src/services/mcp-resources.ts (project:// resource exposure)
- api/src/services/managed-coco-skill.ts (synthesized coco skill manifest, gated on projects_module_enabled)
- api/src/services/host-skills.ts (merges the managed coco skill into host-facing skill list/retrieve/bundle)
- api/src/db/schema.ts (coord_projects, coord_project_notes, coord_project_boards, coord_project_board_columns, coord_project_cards, coord_project_todos — retained, no longer written — coord_project_files, coord_project_feedback, coord_project_memories, coord_project_events)
- api/src/db/migrations/0003_add_coord_project_memories.sql (coord_project_memories DDL — source of truth incl. the full-text index Drizzle cannot express)
