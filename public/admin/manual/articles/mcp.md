---
title: MCP server and tools
section: Integrations and reference
verified: 2026-05-20
sources: api/src/services/mcp-server.ts, api/src/services/mcp-tools.ts, api/src/services/mcp-resources.ts, api/src/services/mcp-fs.ts, api/src/services/mcp-session.ts, api/src/services/mcp-access-log.ts, api/src/services/mcp-memories.ts, api/src/services/skill-manifest.ts, api/src/routes/mcp/index.ts
---

The Model Context Protocol (MCP) endpoint is how hosts and operator tools read canonical orchestrator data at runtime — skills, project state, memories — without going through the admin UI. It speaks JSON-RPC 2.0 over HTTP.

## Endpoint

- `GET /mcp` — advisory probe. Returns 405 with the body `POST only, JSON-RPC 2.0` (and 403 when an Origin header is present and `MCP_ALLOW_REQUEST_HOST_ORIGIN=false`).
- `POST /mcp` — full JSON-RPC surface: `initialize`, `tools/list`, `tools/call`, `resources/list`, `resources/read`, `resources/templates/list`, `resources/create`, `resources/update`, `resources/delete`.

Both routes live in `api/src/routes/mcp/index.ts` and dispatch into `McpServer` (`api/src/services/mcp-server.ts`).

Auth works two ways:

1. **Per-host API key** — the same `sk-…` baked into the host wrapper. The caller passes it in `Authorization: Bearer …` or `X-Api-Key`. The orchestrator validates against `hosts.api_key_hash` and the caller gets the `host` capability.
2. **MCP operator bearer** — set `MCP_OPERATOR_TOKEN` in the API env. Callers that present `Authorization: Bearer <token>` matching it (timing-safe compare) are granted the `operator` capability, which exposes the additional `fs_*` filesystem tools. The `X-Api-Key` fallback is host-only by design — operator privilege is granted only via the bearer header.

There is also a per-host MCP session token issued by `mcp-session.ts` (stored in `mcp_session_tokens`), used by clients that prefer a separately revocable credential; like the host key it grants `host` capability.

The capability type lives on `mcp-tools.ts`:

```
export type Capability = 'host' | 'operator';
```

Tools tagged `operator` are filtered out of `tools/list` for `host` callers (and treated as `method-not-found` if called directly — no leak of existence).

## Tool catalogue

Defined in `api/src/services/mcp-tools.ts`. What you get at runtime depends on capability and whether Projects is enabled:

**Memory** (both capabilities)
- `memory_store`, `memory_retrieve`, `memory_search`, `memory_delete`

**Filesystem (operator only)**
- `fs_read_file`, `fs_write_file`, `fs_list_dir`, `fs_file_exists`, `fs_stat`, `fs_search_in_files` — only registered when `MCP_FS_ROOT` points at an existing directory; every path argument is resolved beneath that root after symlink follow.

**Resources** (both capabilities)
- `resource_list`, `resource_read`, `resource_create`, `resource_update`, `resource_delete` — generic resource CRUD. The URI scheme selects the handler (see *Resources* below).

**Skills** (both capabilities)
- `skill_list`, `skill_retrieve` — canonical skill manifest entries.

**Projects** (conditional on the Projects module being enabled)
- `project_list`, `project_bootstrap`, `project_detail`, `project_changes`, `project_create`
- `project_note_create`, `project_note_upsert`, `project_todo_create`, `project_todo_update`, `project_todo_done`, `project_todo_undone`
- `project_feedback_create`
- `project_file_list`, `project_file_read`, `project_file_upsert`, `project_file_delete`

Use `tools/list` at runtime for the authoritative set; what you see depends on who is calling.

## Resources

`McpResourcesService` (`api/src/services/mcp-resources.ts`) registers URI schemes that the generic `resource_*` tools operate on:

- `skill://{slug}` — the canonical skill manifest. `skill-manifest.ts` materialises this at read time. This is how both `cdx` and `clx` bring in slash-command skills without keeping per-host copies on disk.
- `project://{slug}` — the same shape as `project_bootstrap` but consumed as a resource. Only when Projects is enabled.

Reading a resource is preferred over the more specific tools when the agent only needs to read; it bypasses the tool-call overhead.

## Memory tools

`McpMemoriesService` (`api/src/services/mcp-memories.ts`) backs the memory tools. Memories are scoped by `resource_id`, which is normally a canonical URI like `skill://some-slug` or a host-namespaced URI; the search uses MariaDB indexing on the `memories` table.

Limits enforced at the service layer:

- Content size is bounded (rejected over a small cap with a clear error).
- Tags are normalised and deduplicated.

## Access logging

Every successful and failed dispatch goes into `mcp_access_logs` via `mcp-access-log.ts`. The admin UI reads these rows through `GET /admin/mcp/logs` (see [logs](/admin/manual/logs)). Failed rows carry the JSON-RPC error body so you can see exactly what the tool complained about.

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
- Rotate `MCP_OPERATOR_TOKEN` and restart the API → operator-capability callers are immediately cut off.
- Disable Projects → `project_*` and `project://` disappear.
- Unset `MCP_FS_ROOT` → `fs_*` tools are no longer registered.

## Source references

- api/src/services/mcp-server.ts (JSON-RPC dispatch, capability constants)
- api/src/services/mcp-tools.ts (tool registry, capability filter)
- api/src/services/mcp-resources.ts (URI-scheme routing)
- api/src/services/mcp-fs.ts (fs_* tools, root sandboxing)
- api/src/services/mcp-session.ts (mcp_session_tokens)
- api/src/services/mcp-memories.ts (memory backing)
- api/src/services/skill-manifest.ts (skill:// resources)
- api/src/services/mcp-access-log.ts (mcp_access_logs writes)
- api/src/routes/mcp/index.ts (GET/POST /mcp transport)
