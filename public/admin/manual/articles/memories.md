---
title: Memories and the Memory Atlas
section: Admin workspace
summary: Host, project, and shared memory in one graph or list, the inspector, and the ETag-guarded create, edit, append, and delete flows.
tags: [memory, atlas, mcp]
verified: 2026-09-09
sources: api/src/routes/admin/memories/index.ts, api/src/services/admin-memory-catalog.ts, api/src/services/admin-memory-lifecycle.ts, api/src/services/shared-memories.ts, api/src/services/mcp-memories.ts, api/src/routes/admin/config/index.ts, api/src/security/capabilities.ts, api/src/security/route-capabilities.ts, frontend/src/routes/memories/+page.svelte, frontend/src/routes/authoring/memories/+page.svelte, frontend/src/lib/ws/events.ts
---

**Memories** (`/memories`, under *Knowledge*) opens the **Memory Atlas**: one filterable workspace over the three memory scopes agents write through MCP — **host** memory (`mcp_memories`, per host and engine, the `memory_*` tools), **project** memory (`coord_project_memories`, per Projects workspace, the `project_memory_*` tools), and **shared** memory (`shared_memories`, fleet-wide, the `shared_memory_*` tools). The legacy `/authoring/memories` URL resolves to the same page.

## Graph and list

The page reads `GET /admin/memories/graph` (`memory.read`) with the current scope, search, tag, host, project, and engine filters. The response omits full bodies and returns stable nodes, explicit relationship edges, facets, totals, and truncation metadata; the server pages with a filter-bound opaque cursor, 500 records by default and 2,000 at most. Two views share it, switched with the **Graph** / **List** buttons (`?view=list`):

- **Graph** draws the newest 150 memories from the loaded page and refuses optional relationship layers above its density guard, saying so rather than drawing an unreadable canvas.
- **List** keeps the complete loaded page, 25 rows at a time.

Host, project, and tag filter choices are capped to the top 200 values and disclose when that cap is active. Either view can load the next server page while the server reports more records.

## The inspector

Selecting a memory opens its inspector: **Overview**, **Content** (`GET /admin/memories/{scope}/{recordId}`), **Metadata**, and **Activity** (`GET /admin/memories/audit?node_id=…`, `audit.read`). The activity tab normalizes body-free admin logs, project events, and shared-memory revision metadata into one timeline; it is retention-bound operational history, not immutable compliance history and not a restore source.

Every detail response carries the record's full-state ETag, both in the JSON and as the HTTP `ETag` header. Mutations are conditional on it.

## Creating, editing, appending, deleting

All four need `memory.write` (owner/admin); each memory row also carries a per-record `capabilities` object (`read`, `create`, `update`, `delete`, `append`) derived from the same grant, which is what the page reads to show or hide controls.

- **Create** (`POST /admin/memories/{scope}`) — pick the scope first, because the key or slug and the host or project ownership cannot be changed afterwards. Content is capped at 1,048,576 characters in every scope.
- **Edit** (`PATCH /admin/memories/{scope}/{recordId}`) — sends `expected_etag` (or `If-Match`); a stale value answers `409 memory_conflict` with `current_etag`, and the inspector asks you to reload before retrying.
- **Append** (`POST /admin/memories/shared/{recordId}/append`) — shared scope only, and the concurrency-safe way to add content: it does not need the ETag because it never rewrites what is already there.
- **Delete** (`DELETE /admin/memories/{scope}/{recordId}`, `expected_etag` required) — a hard, permanent delete in every scope. There is no trash, restore, revision-body diff, or rollback; the confirmation dialog is the final safety boundary.

The older per-scope endpoints — `GET /admin/mcp/memories`, `DELETE /admin/mcp/memories/{id}`, `GET /admin/shared-memories`, `GET`/`DELETE /admin/shared-memories/{slug}` — remain for compatibility but do not carry the unified ETag or response contract; the console uses only `/admin/memories/*`.

## Live updates

Host, project, and shared memory mutations (`memory.*`, `project.memory.*`, `shared_memory.*`) all invalidate the `memories` query root, so both Atlas views and an open inspector refresh together.

## Source references

- api/src/routes/admin/memories/index.ts (graph, audit, and the unified create / detail / patch / delete / append routes)
- api/src/services/admin-memory-catalog.ts (graph query, 500-default / 2,000-maximum page, 200-value facet cap)
- api/src/services/admin-memory-lifecycle.ts (ETag contract, `memory_conflict`, immutable keys and ownership, content cap)
- api/src/services/shared-memories.ts, api/src/services/mcp-memories.ts (shared and host scopes)
- api/src/routes/admin/config/index.ts (the deprecated `/admin/mcp/memories` and `/admin/shared-memories` reads and deletes)
- api/src/security/capabilities.ts, api/src/security/route-capabilities.ts (`memory.read` / `memory.write`, `audit.read`)
- frontend/src/routes/memories/+page.svelte, frontend/src/routes/authoring/memories/+page.svelte (Graph / List switch, 150-node canvas cap, 25-row pages, inspector)
- frontend/src/lib/ws/events.ts (memory events → `memories` invalidation)
