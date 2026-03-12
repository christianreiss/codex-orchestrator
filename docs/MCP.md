# MCP Server

Native streamable HTTP MCP endpoint plus REST memory helpers for Codex hosts. When the optional Projects module is enabled, the same MCP surface also exposes shared-project coordination tools/resources that back the managed `coco` skill, which now carries the CoCo toolkit/help inline.

## Endpoints

- `POST /mcp` — JSON-RPC 2.0 streamable HTTP endpoint (`protocolVersion: 2025-03-26`). Accepts single or batch requests.
- `GET /mcp` — probe endpoint. Checks `Origin`; when allowed, returns HTTP 405 with `Allow: POST`.
- `POST /mcp/memories/store` — REST helper for memory store.
- `POST /mcp/memories/retrieve` — REST helper for memory retrieve.
- `POST /mcp/memories/search` — REST helper for memory search.
- `POST /mcp/memories/delete` — REST helper for memory delete.
- `DELETE /mcp/memories/{id}` — delete by memory key (URL decoded).

## Auth & safety

- Endpoints that authenticate (`POST /mcp` and `/mcp/memories/*`) accept API keys via `X-API-Key` or `Authorization: Bearer {host_api_key}`.
- `GET /mcp` does not authenticate hosts.
- `/mcp/memories/*` uses normal host IP checks from `AuthService::authenticate` (including `allow_roaming_ips` and insecure-window IP override behavior).
- `POST /mcp` uses the same `AuthService::authenticate` IP policy, then enforces insecure-host sliding-window access via `enforceInsecureWindow($host, 'mcp')`.
- Origin allowlist checks apply to `/mcp` `GET` and `POST` only. Allowed origins come from `MCP_ALLOWED_ORIGINS` and `PUBLIC_BASE_URL`; optional request-host auto-allow is controlled by `MCP_ALLOW_REQUEST_HOST_ORIGIN` (default `0`). Missing `Origin` is allowed.
- Rate limits: global per-IP bucket applies to `/mcp*` (same non-admin bucket; defaults `120` requests per `60` seconds).
- MCP JSON-RPC requests are logged in `mcp_access_logs`; browse via `/admin` (Logs → MCP) or `GET /admin/mcp/logs`.

## JSON-RPC methods

- Core: `initialize`, `notifications/initialized` (also `notifications.initialized`).
- Tools: `tools/list` (`tools.list`, `list_tools`), `tools/call` (`tools.call`, `call_tool`).
- Resources: `resources/templates/list` (`resources.templates.list`, `list_resource_templates`), `resources/list` (`resources.list`, `list_resources`), `resources/read` (`resources.read`, `read_resource`), `resources/create` (`resources.create`, `create_resource`), `resources/update` (`resources.update`, `update_resource`), `resources/delete` (`resources.delete`, `delete_resource`).

## Tools (names satisfy `^[a-zA-Z0-9_-]+$`)

- Memory: `memory_store`, `memory_retrieve`, `memory_search`, `memory_append`, `memory_query`, `memory_list`.
- Filesystem (app root sandbox): `fs_read_file`, `fs_write_file`, `fs_list_dir`, `fs_file_exists`, `fs_stat`, `fs_search_in_files`.
- Resource tools: `resource_read`, `resource_create`, `resource_update`, `resource_delete`, `resource_list`.
- Projects module enabled: `project_list`, `project_detail`, `project_bootstrap`, `project_changes`, `project_note_upsert`, `project_todo_create`, `project_todo_update`, `project_todo_done`, `project_todo_undone`, `project_file_upsert`, `project_feedback_create`.
- Dot aliases are accepted for tool names and normalized to underscores (for example `memory.store`, `resource.read`).
- `resources/templates/list` exposes templates `memory_by_id` (`memory://{id}`) and `memory_store` (`memory://{scope}:{name}`); when the Projects module is enabled it also exposes `project_bootstrap` (`project://{slug}`).
- Memory/FS/resource tool responses are wrapped in `CallToolResult.content` blocks.
- `resources/list` always includes recent `memory://...` resources for the caller; when the Projects module is enabled it also includes concrete `project://{slug}` resources for each active shared project.

## Example JSON-RPC call

```bash
curl -s "$BASE/mcp" \
  -H "Authorization: Bearer $HOST_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc":"2.0",
    "id":1,
    "method":"tools/call",
    "params":{"name":"memory_store","arguments":{"content":"note from mcp doc"}}
  }' | jq .
```

Project bootstrap example when the module is enabled:

```bash
curl -s "$BASE/mcp" \
  -H "Authorization: Bearer $HOST_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc":"2.0",
    "id":2,
    "method":"tools/call",
    "params":{"name":"project_bootstrap","arguments":{"slug":"apollo"}}
  }' | jq .
```

## REST memory examples

Store:
```bash
curl -s "$BASE/mcp/memories/store" \
  -H "Authorization: Bearer $HOST_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"content":"triage notes","tags":["incident-42","ops"]}'
```

Search:
```bash
curl -s "$BASE/mcp/memories/search" \
  -H "Authorization: Bearer $HOST_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"query":"incident-42","limit":5}' | jq .
```

## Client hints

- `cdx` auto-adds a managed MCP server entry when `orchestrator_mcp_enabled = true` (default). Inserted entry uses `name = "cdx"`, `url = "$BASE/mcp"`, static `Authorization` header, and `startup_timeout_sec = 30`.
- When the Projects module is enabled, the normal Skills sync also ships a managed `coco` skill that assumes these `project_*` MCP tools/resources are available and embeds the native CoCo toolkit/help; no extra wrapper-side project sync path is needed.
- Tool names accept dot aliases in calls (`memory.store`, `resource.read`) while advertised tool names stay underscore-based.
- Text content in tool results is wrapped in `CallToolResult.content` blocks for MCP clients that expect it.
