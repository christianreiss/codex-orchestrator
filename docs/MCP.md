# MCP Server

Native streamable HTTP MCP endpoint plus REST memory helpers for Codex and Claude hosts. When the optional Projects module is enabled, the same MCP surface also exposes shared-project coordination tools/resources that back the managed `coco` skill, which now carries the CoCo toolkit/help inline.

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
- Origin checks apply to `/mcp` `GET` and `POST` only, and they are a single toggle rather than a list of allowed origins: with `MCP_ALLOW_REQUEST_HOST_ORIGIN` off (default `0`) any request carrying a non-empty `Origin` header is rejected with 403, and turning it on drops the check entirely. A missing or empty `Origin`, the normal case for non-browser MCP clients, is always allowed.
- Request admission: `/mcp*` has no orchestrator-enforced request-rate limit; host authentication and capability checks still apply.
- MCP JSON-RPC requests are logged in `mcp_access_logs`; browse via `/admin` (Logs → MCP) or `GET /admin/mcp/logs`.
- Host-authenticated `/mcp` advertises the host-safe memory, shared-memory, resource, Skill, project, and fleet-secrets tools. Coordinator filesystem helpers (`fs_*`) are not listed and return “method not found” if called on that route.

## JSON-RPC methods

The four `group: methods` bullets below are the dispatch table: everything after the colon is backticked method spellings — a canonical name, then its aliases in parentheses — and nothing else. `api/test/unit/services/mcp-doc-methods.test.ts` compares them against the `case` labels of the `switch (method)` in `api/src/services/mcp-server.ts` and fails on any spelling that is in one and not the other, so notes about a group go on the indented bullet under it.

- Core: `initialize`, `notifications/initialized` (`notifications.initialized`).
  - `initialize` includes server-wide instructions telling clients to inspect deferred tool catalogs instead of inferring absence and to use read-only `secret_list` before answering secrets-store availability or write-capability questions.
- Tools: `tools/list` (`tools.list`, `list_tools`), `tools/call` (`tools.call`, `call_tool`).
- Resources: `resources/templates/list` (`resources.templates.list`, `list_resource_templates`), `resources/list` (`resources.list`, `list_resources`), `resources/read` (`resources.read`, `read_resource`), `resources/create` (`resources.create`, `create_resource`), `resources/update` (`resources.update`, `update_resource`), `resources/delete` (`resources.delete`, `delete_resource`).
- Prompts: `prompts/list` (`prompts.list`), `prompts/get` (`prompts.get`).
  - No prompts are served: the list is always empty, which is what makes a client's prompts capability probe succeed, and a get answers `-32601` deliberately.
- Any other method answers `-32601` “Method not found”.

## Tools (names satisfy `^[a-zA-Z0-9_-]+$`)

The five `group: names` bullets below are the tool catalog: everything after the colon is backticked tool names and nothing else. `api/test/unit/services/mcp-doc-catalog.test.ts` compares them against the `name:` registrations in `api/src/services/mcp-tools.ts` and fails on any name that is in one and not the other, so notes about a group go on the indented bullet under it.

- Host-authenticated tools: `memory_store`, `memory_retrieve`, `memory_search`, `memory_delete`, `skill_list`, `skill_retrieve`, `skill_store`, `skill_delete`, `resource_list`, `resource_read`, `resource_create`, `resource_update`, `resource_delete`.
  - `memory_*` is host-scoped scratch state — one row per host per key, invisible to other hosts. `skill_list`/`skill_retrieve` read synced Skills, which are also readable as `skill://{slug}` resources. Reads honor the caller's `X-Engine`; an omitted or invalid header retains the legacy `codex` default, requests for an engine disabled on that host are rejected before JSON-RPC dispatch, and `skill_list` has no per-call engine override.
  - `skill_store` creates, fully replaces, or revives one manifest-only Skill from `{slug, manifest, display_name?, description?}`. `skill_delete` soft-deletes by slug. Both mutations are last-writer-wins, always write shared `engine:null` Skills, record the authenticated host, and reject code-managed slugs or source-owned rows. The always-available managed `skill-manager` Skill covers both workflow questions and mutations: list first, retrieve before a write, and retrieve again to verify. Served Codex guidance makes that MCP path authoritative.
- Fleet-wide shared memory: `shared_memory_list`, `shared_memory_search`, `shared_memory_read`, `shared_memory_write`, `shared_memory_append`, `shared_memory_delete`.
  - Visible to every host and both engines; `shared_memory_list` takes no required argument, which is what makes the corpus discoverable to an agent that knows nothing yet. Documents cap at 1 MiB; reads return a bounded window with `next_offset` for paging. `shared_memory_write` replaces the entire body: before updating an existing slug, read from offset 0 without chunk selectors through `truncated:false`, require one stable `memory.sha256`, preserve unaffected content, and never write back an excerpt, preview, chunk, or partial read.
- Projects module enabled: `project_list`, `project_bootstrap`, `project_detail`, `project_changes`, `project_create`, `project_note_create`, `project_note_upsert`, `project_todo_create`, `project_todo_update`, `project_todo_done`, `project_todo_undone`, `project_feedback_create`, `project_file_list`, `project_file_read`, `project_file_upsert`, `project_file_delete`, `project_memory_list`, `project_memory_get`, `project_memory_upsert`, `project_memory_delete`, `project_memory_search`.
  - `project_memory_*` is project-scoped coordination state, separate from host-scoped `memory_*` and from the fleet-wide corpus.
- Fleet secrets store: `secret_list`, `secret_search`, `secret_get`, `secret_store`, `secret_delete`.
  - The working credentials agents need to do their job — GitHub tokens, database passwords, Bookstack/Checkmk tokens, SSH keys, third-party service keys — as opposed to the engine-boot auth that gets an agent started, which lives in `auth_payloads` and never surfaces here. Host capability is gated by `secrets_module_enabled`: `secret_list` and `secret_search` return additive `status`, `capabilities`, and `secrets` fields, distinguishing an available-but-empty store from a disabled one without revealing values. The store itself never automatically writes plaintext to a host filesystem. `secret_get` audits the slug before returning plaintext. Prefer a tool-native secret parameter, stdin, an inherited descriptor, or a process-scoped environment variable; an explicitly requested task may render a value into its requested configuration, file, log, or response destination. Do not enable shell tracing; sanitize diagnostic output and unset temporary variables after use. Reading is open to every host; **writing is ownership-scoped**. `secret_store` creates a new slug or rotates one this host owns, and `secret_delete` only retires a slug this host owns. Operator-created (`source_host_id` NULL) and other-host rows are refused with `secret_not_owned`; listings mark each row `owned_by_you`.
- Git Director: `git_register`, `git_list`, `git_join`, `git_merge_request`, `git_merge_status`, `git_release`.
  - A registry of which agent is working in which clone, plus an advisory arbiter over merges into shared branches. The arbitration unit is the clone on a host, keyed by `git rev-parse --git-common-dir`, so every linked worktree of one checkout contends as one; clones are grouped across hosts by normalized remote URL for visibility only and are never arbitrated across hosts. The orchestrator has no filesystem access to any host, so every git fact is reported by the calling agent rather than observed, and the verdict is advice that agent can ignore — there is no hook and no enforcement. Host capability is gated by `git_director_enabled` and, unlike Agent Messaging, by managed MCP reaching the host at all; `git_list` returns additive `status` and `capabilities` fields so an available-but-empty registry is distinguishable from a disabled one. `git_merge_request` requires a caller-generated `client_request_id` and is idempotent on it, because a retried tool call would otherwise queue a phantom second contender. A granted lease is the merge-request row itself, expires on a TTL, and is renewed or re-decided by `git_merge_status`; promotion is poll-driven, so releasing a lease pushes nothing to whoever is waiting. Verdicts are `allow`, `wait` or `deny` with `decided_by` naming `policy` (the uncontended fast path, or the fallback when no arbiter is reachable), `llm` (a model judged a real contention) or `operator` (forced from the console).
- Operator/internal filesystem helpers: `fs_read_file`, `fs_write_file`, `fs_list_dir`, `fs_file_exists`, `fs_stat`, `fs_search_in_files`.
  - Registered with `capability: 'operator'`, and only when `MCP_FS_ROOT` points at an existing directory; they are not listed on the public host-authenticated `/mcp` route and return “method not found” if called there.
- Dot aliases are accepted for tool names and normalized to underscores (for example `memory.store`, `resource.read`).
- `resources/templates/list` exposes templates `memory` (`memory://{key}`), `project` (`project://{slug}`), `project_file` (`project://{slug}/files/{stored_name}`), `project_memory` (`project://{slug}/memory/{key}`), `skill` (`skill://{slug}`), `skill_file` (`skill://{slug}/{path}`), and — only when the shared-memory service is wired — `shared_memory` (`shared://{slug}`).
  - `api/test/unit/services/mcp-doc-templates.test.ts` compares the name/URI pairs on the bullet above against `McpResourcesService.listTemplates()` and fails on any pair one side has and the other lacks, so notes about the templates go here rather than up there.
- Memory/resource/project tool responses are wrapped in `CallToolResult.content` blocks.
- `resources/list` always includes recent `memory://...` resources for the caller, the 50 most recently updated `shared://{slug}` documents, Skills visible to the caller's engine as `skill://{slug}` read-only markdown resources, and source-owned support files as `skill://{slug}/{path}`; when the Projects module is enabled it also includes concrete `project://{slug}` resources for each active shared project.
- `resources/read` fetches a single memory as `text/plain` when given `uri=memory://{id}`, a shared memory body as `text/markdown` when given `uri=shared://{slug}`, a Skill manifest as `text/markdown` when given `uri=skill://{slug}`, an exact bundled Skill support file when given `uri=skill://{slug}/{path}`, or a project bootstrap JSON document when given `uri=project://{slug}`. Bundled manifests map relative references onto that support-file URI; bundled scripts remain reference text and gain no execution authority. `resources/create`/`update`/`delete` also accept `shared://{slug}`, but that path carries only text. Before replacing an existing shared document through either resource mutation, perform the same complete offset-zero read with one stable digest and pass it as `expected_sha256`; delete only when the whole record is invalid or superseded. Use `shared_memory_write` when tags, metadata or engine provenance matter.
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

- Both wrappers auto-add an engine-labelled managed MCP server entry when `orchestrator_mcp_enabled = true` (default). Each entry uses `url = "$BASE/mcp"` (the base baked into the signed wrapper config, which honors `PUBLIC_BASE_URL` when set), static `Authorization` and `X-Engine: codex|claude` headers, and the engine-specific name `cdx` or `clx`.
- `cdx` renders its entry into managed `config.toml` with `startup_timeout_sec = 30`. `clx` merges `mcpServers.clx` into the top level of `~/.claude.json`, where Claude Code reads user-scope MCP servers; user-authored entries and unrelated keys are preserved.
- When the Projects module is enabled, MCP also publishes a managed `coco` skill that assumes these `project_*` MCP tools/resources are available and embeds the native CoCo toolkit/help; no extra wrapper-side project sync path is needed. That skill tells operators that CoCo coordination handoffs are project-only, points fleet-wide reference documents at `shared_memory_*`, and blocks reserved `coco*` memory ids.
- Tool names accept dot aliases in calls (`memory.store`, `resource.read`) while advertised tool names stay underscore-based.
- Text content in tool results is wrapped in `CallToolResult.content` blocks for MCP clients that expect it.
