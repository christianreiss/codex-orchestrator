# MCP Server

Native streamable HTTP MCP endpoint plus REST helpers for Codex hosts. Uses host API keys; IP binding is **not** enforced for `/mcp` (clients may roam), but insecure-host windows still apply.

## Endpoints

- `POST /mcp` — JSON-RPC 2.0, streamable_http spec `2025-03-26`. Accepts batch or single requests.
- `GET /mcp` — JSON-RPC probe endpoint; always returns a 405 error body and `Allow: POST`.
- `POST /mcp/memories/store` — REST helper backing `memory_store`.
- `POST /mcp/memories/retrieve` — REST helper backing `memory_retrieve`.
- `POST /mcp/memories/search` — REST helper backing `memory_search`.
- `POST /mcp/memories/delete` — REST helper backing delete semantics.
- `DELETE /mcp/memories/{id}` — delete by memory key (URL decoded).

## Auth & safety

- `Authorization: Bearer {host_api_key}` required for all `/mcp*` endpoints.
- `/mcp` authentication bypasses IP binding (`allow_roaming_ips` is not used for MCP).
- Insecure hosts: `/mcp` enforces the same sliding window as `/auth` (each successful call extends the window; closed windows return an error).
- Origin allowlist: `MCP_ALLOWED_ORIGINS` plus `PUBLIC_BASE_URL` and the current Host/proto are accepted; disallowed origins get 403 `Origin not allowed` (missing `Origin` is allowed).
- Rate limits: global per-IP bucket applies (same as other non-admin routes).
- Access is logged; browse via `/admin` (Logs → MCP) or `GET /admin/mcp/logs`.

## Tools (names satisfy `^[a-zA-Z0-9_-]+$`)

- Memory: `memory_store`, `memory_retrieve`, `memory_search`.
- Scoped notes: `memory_append`, `memory_query`, `memory_list` (tags memories with `resource:{id}`).
- Resources: `resources/templates/list`, `resources/list`, `resources/read`, plus tool aliases `resource_read|create|update|delete|list`. Templates include `memory_by_id` (`memory://{id}`) and `memory_store` (`memory://{scope}:{name}`).
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

- `cdx` auto-adds an MCP server entry (managed) via the config builder when `orchestrator_mcp_enabled = true`; nothing to configure on the host.
- Tool names also accept dot aliases in calls (`memory.store`, `resources.read`) but responses advertise underscore names.
- Text content in tool results is wrapped in `CallToolResult.content` blocks for MCP clients that expect it.
