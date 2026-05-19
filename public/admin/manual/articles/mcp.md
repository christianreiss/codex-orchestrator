---
title: MCP server and tools
section: Integrations and reference
verified: 2026-04-19
sources: src/Mcp/McpServer.php, src/Mcp/McpToolDefinitions.php, src/Mcp/McpResourceHandler.php, src/Mcp/McpFileOperations.php, src/Http/Controllers/McpRouteController.php, src/Services/MemoryService.php, src/Services/ProjectCoordinationService.php, src/Services/SkillManifestService.php, src/Repositories/McpSessionTokenRepository.php, src/Repositories/McpAccessLogRepository.php
---

The Model Context Protocol (MCP) endpoint is how hosts and operator tools read canonical orchestrator data at runtime — skills, project state, memories — without going through the admin UI. It speaks JSON-RPC 2.0 over HTTP.

## Endpoint

- `GET /mcp` (`McpRouteController::probe`) — simple capability probe, returns identity info and confirms the endpoint is reachable.
- `POST /mcp` (`McpRouteController::handle`) — full JSON-RPC surface: `initialize`, `tools/list`, `tools/call`, `resources/list`, `resources/read`, `resources/templates/list`, `resources/create`, `resources/update`, `resources/delete`.

Auth works two ways:

1. **Per-host API key** — the same `sk-…` baked into the host wrapper. The request carries it in the Authorization header. `AuthService::authenticateMcpCredential()` validates it. The caller gets the `host` capability.
2. **MCP session token** — issued out-of-band and stored in `mcp_session_tokens` (`McpSessionTokenRepository`). Gives the caller the `operator` capability, which has a larger tool set (no `fs_*` filter).

The `host` vs `operator` split is declared on `McpServer`:

- `CAPABILITY_HOST = 'host'`
- `CAPABILITY_OPERATOR = 'operator'`

`McpToolDefinitions::capabilityAllowsTool()` hides every `fs_*` tool from the `host` capability; hosts cannot read or write orchestrator-side files.

## Tool catalogue

Defined in `src/Mcp/McpToolDefinitions.php` (`definitions()` method). What you get at runtime depends on capability and whether Projects is enabled:

**Memory**
- `memory_store` — store memory content with tags/metadata.
- `memory_retrieve` — fetch a memory by id.
- `memory_search` — full-text + tag search.
- `memory_append` — append a line to an existing memory.
- `memory_query` — structured query with filters.
- `memory_list` — recent memories for a resource id.

**Filesystem (operator only)**
- `fs_read_file`, `fs_write_file`, `fs_list_dir`, `fs_file_exists`, `fs_stat`, `fs_search_in_files` — rooted to the app directory by `McpFileOperations`. Operator capability only.

**Resources (both capabilities)**
- `resource_read`, `resource_create`, `resource_update`, `resource_delete`, `resource_list` — generic resource CRUD. The URI scheme selects the handler (see *Resources* below).

**Projects (conditional, both capabilities when module enabled)**
- `project_list`, `project_create`, `project_detail`, `project_bootstrap`, `project_changes`
- `project_note_upsert`, `project_todo_create`, `project_todo_update`, `project_todo_done`, `project_todo_undone`
- `project_file_upsert`, `project_feedback_create`

Use `tools/list` at runtime for the authoritative set; what you see depends on who is calling.

## Resources

`McpResourceHandler` registers URI schemes that the generic `resource_*` tools operate on:

- `skill://{slug}` — the canonical skill manifest. `SkillManifestService` materialises this at read time. This is how both `cdx` and `clx` bring in slash-command skills without keeping per-host copies on disk.
- `project://{slug}` — same shape as `project_bootstrap` but consumed as a resource. Only when Projects is enabled.
- Additional internal schemes are registered by the services that own them; `resources/templates/list` enumerates all of them.

Reading a resource is preferred over the more specific tools when the agent only needs to read; it bypasses the tool-call overhead.

## Memory tools vs. repositories

`MemoryService` is the service behind the memory tools. Memories are scoped by `resource_id`, which is normally a canonical URI like `skill://some-slug` or a host-namespaced URI; the full-text search uses MySQL FULLTEXT indexing on the content column of the `memories` table.

Limits enforced at the service layer (see `MemoryService`):

- Content size is bounded (rejected over a small cap with a clear error).
- Tags are normalised and deduplicated.
- `memory_summary` data is derived by `MemorySummaryService` on write.

## Access logging

Every successful and failed dispatch goes into `McpAccessLogRepository`. The admin UI reads these rows through `GET /admin/mcp/logs` (see [logs](/admin/manual/logs)). Failed rows carry the JSON-RPC error body so you can see exactly what the tool complained about.

## Probing from the CLI

```bash
curl -H "Authorization: Bearer $HOST_KEY" \
     -H "Content-Type: application/json" \
     -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' \
     https://your-server/mcp
```

The response is a JSON-RPC envelope with the filtered tool list. `initialize` is the canonical first call for a well-behaved client; `tools/list` without it is accepted but MCP clients should follow the spec.

## Shutting it off

There is no per-host MCP kill-switch. The switches that exist:

- Delete the host → per-host key is invalidated → MCP calls from it stop being authenticated.
- Clear all MCP session tokens from the admin UI → operator-capability callers are immediately cut off.
- Disable Projects → `project_*` and `project://` disappear.

## Source references

- src/Mcp/McpServer.php (dispatch, listTools, listResources, capability constants)
- src/Mcp/McpToolDefinitions.php (the full tool catalogue, capability filter)
- src/Mcp/McpResourceHandler.php (URI-scheme routing for resources)
- src/Mcp/McpFileOperations.php (fs_* implementation, app-root sandboxing)
- src/Http/Controllers/McpRouteController.php (probe, handle)
- src/Services/MemoryService.php, src/Services/MemorySummaryService.php
- src/Services/ProjectCoordinationService.php (project_* backing)
- src/Services/SkillManifestService.php (skill:// resources)
- src/Repositories/McpSessionTokenRepository.php, src/Repositories/McpAccessLogRepository.php
