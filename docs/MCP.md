# MCP Server

Native streamable HTTP MCP endpoint plus REST memory helpers for Codex hosts. When the optional Projects module is enabled, the same MCP surface also exposes shared-project coordination tools/resources that back the managed `coco` skill, which now carries the CoCo toolkit/help inline.

Three memory substrates live behind this endpoint and they are not interchangeable: `memory_*` / `memory://...` is host-scoped (one row per host per key, invisible to other hosts), `project_memory_*` / `project://...` is project-scoped coordination state, and `shared_memory_*` / `shared://...` is the fleet-wide document corpus — no host and no project scoping, discoverable with `shared_memory_list` before you know any key. For CoCo specifically, coordination state stays project-only; `memory://...` is never a cross-server fallback.

## Endpoints

- `POST /mcp` — JSON-RPC 2.0 streamable HTTP endpoint (`protocolVersion: 2025-03-26`). Accepts single or batch requests.
- `GET /mcp` — probe endpoint. Checks `Origin`; when allowed, returns HTTP 405 with `Allow: POST`.
- `POST /mcp/memories/store` — REST helper for memory store. Reserved keys matching `^coco(?:$|[._:-])` are rejected so CoCo shared handoffs go through Projects instead.
- `POST /mcp/memories/retrieve` — REST helper for memory retrieve. Reserved `coco*` keys are rejected for the same reason.
- `POST /mcp/memories/search` — REST helper for memory search.
- `POST /mcp/memories/delete` — REST helper for memory delete. Reserved `coco*` keys are rejected.
- `DELETE /mcp/memories/{id}` — delete by memory key (URL decoded).
- `GET /shared-memories` and `POST /shared-memories/list` — REST helpers for the fleet-wide corpus index. No query needed.
- `POST /shared-memories/search` — relevance search over document chunks; `degraded: true` when the full-text index is missing.
- `POST /shared-memories/read` and `GET /shared-memories/{slug}` — bounded read window over a document (up to 1 MiB total).
- `POST /shared-memories/write`, `POST /shared-memories/append` — create/replace and append. `expected_sha256` on write turns a lost update into a `409`.
- `POST /shared-memories/delete` and `DELETE /shared-memories/{slug}` — soft delete; the slug stays reserved.

## Auth & safety

- Endpoints that authenticate (`POST /mcp` and `/mcp/memories/*`) accept MCP credentials via `X-API-Key` or `Authorization: Bearer ...`. Secure hosts typically use the host API key; insecure hosts receive a short-lived MCP bearer token in baked config.
- `GET /mcp` does not authenticate hosts.
- `/mcp/memories/*` authenticates through `app.requireHost` (`api/src/http/plugins/auth-host.ts`): the API key is matched by hash (legacy plaintext keys still resolve) and the host must be `active`. The IP-binding path of `hostAuth.authenticate` (`api/src/services/host-auth.ts`) — `allow_roaming_ips`, reverse DNS, insecure-window IP overrides — is what `/auth` and `/host/*` run, and it does not run here.
- `POST /mcp` authenticates in `resolveHost()` (`api/src/routes/mcp/index.ts`): the credential is verified as a short-lived MCP session token first (`McpSessionService.verify`, 8h TTL) and otherwise resolved as a host API key (`app.resolveHostFromKey`); non-`active` hosts are then rejected. No sliding-window check runs on this route — for insecure hosts the session token's own expiry is the window.
- Origin allowlist checks apply to `/mcp` `GET` and `POST` only. Allowed origins come from `MCP_ALLOWED_ORIGINS` and `PUBLIC_BASE_URL`; optional request-host auto-allow is controlled by `MCP_ALLOW_REQUEST_HOST_ORIGIN` (default `0`). Missing `Origin` is allowed.
- Rate limits: global per-IP bucket applies to `/mcp*` (same non-admin bucket; defaults `120` requests per `60` seconds).
- MCP JSON-RPC requests are logged in `mcp_access_logs`; browse via `/admin` (Logs → MCP) or `GET /admin/mcp/logs`.
- Host-authenticated `/mcp` is intentionally host-scoped: it advertises memory/resource/project tools only. Coordinator filesystem helpers (`fs_*`) are not listed and return “method not found” if called on that route.

## JSON-RPC methods

- Core: `initialize`, `notifications/initialized` (also `notifications.initialized`).
- Tools: `tools/list` (`tools.list`, `list_tools`), `tools/call` (`tools.call`, `call_tool`).
- Resources: `resources/templates/list` (`resources.templates.list`, `list_resource_templates`), `resources/list` (`resources.list`, `list_resources`), `resources/read` (`resources.read`, `read_resource`), `resources/create` (`resources.create`, `create_resource`), `resources/update` (`resources.update`, `update_resource`), `resources/delete` (`resources.delete`, `delete_resource`).

## Tools (names satisfy `^[a-zA-Z0-9_-]+$`)

- Host-authenticated tools: `memory_store`, `memory_retrieve`, `memory_search`, `memory_append`, `memory_query`, `memory_list`, `resource_read`, `resource_create`, `resource_update`, `resource_delete`, `resource_list`.
- Fleet-wide shared memory: `shared_memory_list`, `shared_memory_search`, `shared_memory_read`, `shared_memory_write`, `shared_memory_append`, `shared_memory_delete`. Visible to every host and both engines; `shared_memory_list` takes no required argument, which is what makes the corpus discoverable to an agent that knows nothing yet. Documents cap at 1 MiB; reads return a bounded window with `next_offset` for paging.
- Projects module enabled: `project_list`, `project_create`, `project_detail`, `project_bootstrap`, `project_changes`, `project_note_upsert`, `project_todo_create`, `project_todo_update`, `project_todo_done`, `project_todo_undone`, `project_file_upsert`, `project_feedback_create`.
- Operator/internal filesystem helpers still exist in `McpServer` (`fs_read_file`, `fs_write_file`, `fs_list_dir`, `fs_file_exists`, `fs_stat`, `fs_search_in_files`) but are not exposed on the public host-authenticated `/mcp` route.
- Dot aliases are accepted for tool names and normalized to underscores (for example `memory.store`, `resource.read`).
- `resources/templates/list` exposes templates `memory_by_id` (`memory://{id}`), `memory_store` (`memory://{scope}:{name}`), `skill_manifest` (`skill://{slug}`), and `shared_memory` (`shared://{slug}`); when the Projects module is enabled it also exposes `project_bootstrap` (`project://{slug}`).
- Memory/resource/project tool responses are wrapped in `CallToolResult.content` blocks.
- `resources/list` always includes recent `memory://...` resources for the caller, the 50 most recently updated `shared://{slug}` documents, and synced Skills as `skill://{slug}` read-only markdown resources; when the Projects module is enabled it also includes concrete `project://{slug}` resources for each active shared project.
- `resources/read` fetches a single memory as `text/plain` when given `uri=memory://{id}`, a shared memory body as `text/markdown` when given `uri=shared://{slug}`, a Skill manifest as `text/markdown` when given `uri=skill://{slug}`, or a project bootstrap JSON document when given `uri=project://{slug}`. Clients should use `skill://{slug}` as the Skill read path. `resources/create`/`update`/`delete` also accept `shared://{slug}`, but that path carries only text — use `shared_memory_write` when tags, metadata or engine provenance matter.
- The managed `coco` skill uses the `project_*` / `project://{slug}` side of that surface for coordination handoffs — projects carry notes, todos, files and an event log that shared memories do not. It points durable fleet-wide *documents* at `shared_memory_*`, and never treats `memory://...` as cross-host state.

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

Shared memory search (fleet-wide, no project or host scoping):

```bash
curl -s "$BASE/mcp" \
  -H "Authorization: Bearer $HOST_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc":"2.0",
    "id":3,
    "method":"tools/call",
    "params":{"name":"shared_memory_search","arguments":{"query":"crane rollback","limit":5}}
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
- When the Projects module is enabled, MCP also publishes a managed `coco` skill that assumes these `project_*` MCP tools/resources are available and embeds the native CoCo toolkit/help; no extra wrapper-side project sync path is needed. That skill tells operators that CoCo coordination handoffs are project-only, points fleet-wide reference documents at `shared_memory_*`, and blocks reserved `coco*` memory ids.
- Tool names accept dot aliases in calls (`memory.store`, `resource.read`) while advertised tool names stay underscore-based.
- Text content in tool results is wrapped in `CallToolResult.content` blocks for MCP clients that expect it.
