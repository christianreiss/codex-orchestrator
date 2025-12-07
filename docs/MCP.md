# MCP Server

Native streamable HTTP MCP endpoint plus REST helpers for Codex hosts. Uses host API keys; IP binding applies (enable `allow_roaming_ips` if the IDE moves networks). Insecure hosts must still be inside their sliding window.

## Endpoints

- `POST /mcp` — JSON-RPC 2.0, streamable_http spec `2025-03-26`. Accepts batch or single requests.
- `POST /mcp/memories/store|retrieve|search` — REST helpers that back the memory tools.

## Auth & safety

- `Authorization: Bearer {host_api_key}` required.
- IP binding enforced (same rules as `/auth`); enable `allow_roaming_ips` on the host if the IDE moves networks.
- Insecure hosts: window enforced the same as `/auth` (call extends window when enabled).
- Origin allowlist: `MCP_ALLOWED_ORIGINS` controls CORS; disallowed origins get 403 `Origin not allowed`.
- Rate limits: global per-IP bucket applies (same as other non-admin routes).
- Access is logged; browse via `/admin/mcp-logs.html`.

## Tools (names satisfy `^[a-zA-Z0-9_-]+$`)

- Memory: `memory_store`, `memory_retrieve`, `memory_search`.
- Scoped notes: `memory_append`, `memory_query`, `memory_list` (tags memories with `resource:{id}`).
- Resources: `resources/templates/list`, `resources/list`, `resources/read`, plus tool aliases `resource_read|create|update|delete|list`. URIs are `memory://{id}`.
- Filesystem (app root sandbox): `fs_read_file`, `fs_write_file`, `fs_list_dir`, `fs_stat`, `fs_file_exists`, `fs_search_in_files`.
- Aliases: `list_tools|tools.list`, `call_tool|tools.call`, dot variants for tools/resources are accepted; names are normalized with underscores.

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

## REST memory examples

Store:
```bash
curl -s "$BASE/mcp/memories/store" \
  -H "Authorization: Bearer $HOST_API_KEY" \
  -d '{"content":"triage notes","tags":["incident-42","ops"]}'
```

Search:
```bash
curl -s "$BASE/mcp/memories/search" \
  -H "Authorization: Bearer $HOST_API_KEY" \
  -d '{"query":"incident-42","limit":5}' | jq .
```

## Client hints

- `cdx` auto-adds an MCP server entry (managed) via the config builder; nothing to configure on the host.
- Tool names also accept dot aliases in calls (`memory.store`) but responses advertise underscores.
- Text content in tool results is wrapped in `CallToolResult.content` blocks for MCP clients that expect it.
