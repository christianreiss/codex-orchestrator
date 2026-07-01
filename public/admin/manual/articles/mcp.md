---
title: MCP server and tools
section: Integrations and reference
verified: 2026-07-01
sources: api/src/services/mcp-server.ts, api/src/services/mcp-tools.ts, api/src/services/mcp-resources.ts, api/src/services/mcp-fs.ts, api/src/services/mcp-session.ts, api/src/services/mcp-access-log.ts, api/src/services/mcp-memories.ts, api/src/services/host-skills.ts, api/src/services/host-projects.ts, api/src/services/managed-coco-skill.ts, api/src/services/skill-manifest.ts, api/src/routes/mcp/index.ts, api/src/services/client-config.ts, api/src/services/config-normalizer.ts, wrappers/clx/internal/lifecycle/userconfig_merge.go, wrappers/clx/internal/lifecycle/settings_merge.go
---

The Model Context Protocol (MCP) endpoint is how hosts and operator tools read canonical orchestrator data at runtime — skills, project state, memories — without going through the admin UI. It speaks JSON-RPC 2.0 over HTTP.

This article covers two distinct topics: the **server-side MCP endpoint** (what JSON-RPC methods exist, how auth works, what tools are available) and the **client-side MCP server configuration** (how user-defined and managed MCP servers are stored, synced to Claude CLI, and cleaned up).

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

Defined in `api/src/services/mcp-tools.ts`. What you get at runtime depends on capability and, for `fs_*`, on server config (`MCP_FS_ROOT`):

**Memory** (both capabilities)
- `memory_store`, `memory_retrieve`, `memory_search`, `memory_delete`

**Filesystem (operator only)**
- `fs_read_file`, `fs_write_file`, `fs_list_dir`, `fs_file_exists`, `fs_stat`, `fs_search_in_files` — only registered when `MCP_FS_ROOT` points at an existing directory; every path argument is resolved beneath that root after symlink follow.

**Resources** (both capabilities)
- `resource_list`, `resource_read`, `resource_create`, `resource_update`, `resource_delete` — `list`/`read` work across every URI scheme; `create`/`update`/`delete` are restricted to `memory://` (see *Resources* below).

**Skills** (both capabilities)
- `skill_list`, `skill_retrieve` — canonical skill manifest entries.

**Projects** (both capabilities — always registered)
- `project_list`, `project_bootstrap`, `project_detail`, `project_changes`, `project_create`
- `project_note_create`, `project_note_upsert`, `project_todo_create`, `project_todo_update`, `project_todo_done`, `project_todo_undone`
- `project_feedback_create`
- `project_file_list`, `project_file_read`, `project_file_upsert`, `project_file_delete`

These tools are unconditional: `McpToolsRegistry` (`mcp-tools.ts`) registers them the same way it registers `memory_*`/`skill_*`, with no dependency on the Projects module toggle (`projects_module_enabled`). What *is* gated by that toggle is the managed `coco` skill (`api/src/services/managed-coco-skill.ts`, `skill://coco`) — see [Projects](/admin/manual/projects) — which onboards agents onto the `project_*` workflow. Disabling the module removes the skill, not the tools.

Use `tools/list` at runtime for the authoritative set; what you see depends on who is calling.

## Resources

`McpResourcesService` (`api/src/services/mcp-resources.ts`) registers four URI schemes, all listed by `resources/templates/list`:

- `memory://{key}` — a single host-scoped memory. This is the **only** scheme `resource_create`/`resource_update`/`resource_delete` accept; each other scheme rejects create/update/delete with an explicit error. `resource_update` is a plain alias for `resource_create` (both call the same upsert path).
- `project://{slug}` — the same shape as `project_bootstrap` but consumed as a resource. Always available (see the Projects note above).
- `project://{slug}/files/{stored_name}` — a single project file's raw content.
- `skill://{slug}` — the canonical skill manifest, materialised at read time by `HostSkillsService.retrieve()` (`api/src/services/host-skills.ts`). `skill-manifest.ts` is a separate helper used by the admin skill-authoring routes (slug/manifest validation for drafts) — it is not on this read path. This is how both `cdx` and `clx` bring in slash-command skills without keeping per-host copies on disk.

`resource_list` enumerates every project (plus up to 50 files each) and every skill as browsable entries. Reading a resource is preferred over the more specific tools when the agent only needs to read; it skips the tool schema-validation step.

## Memory tools

`McpMemoriesService` (`api/src/services/mcp-memories.ts`) backs the memory tools. Memories are scoped per host: the unique key is `(host_id, memory_key)` in the `mcp_memories` table — there is no cross-host or resource-URI namespace. `memory_search` runs a MariaDB `MATCH() AGAINST() IN NATURAL LANGUAGE MODE` full-text query over `content`/`tags_text`, then applies any tag filter in application code.

Limits enforced at the service layer:

- `id` (the memory key): letters, digits, `.`, `_`, `:`, `-` only, 128 characters max. A key equal to `coco` or starting with `coco` followed by a separator (`coco.`, `coco_`, `coco:`, `coco-`) is rejected — that namespace is reserved for CoCo shared-project handoffs (use `project_*` tools instead of host-scoped memory).
- `content`: required, 32,000 characters max.
- `tags`: up to 32 tags, 64 characters each, case-insensitively deduplicated.

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
- Disable the Projects module (`projects_module_enabled`, toggled from `/admin/projects`) → does **not** remove `project_*` tools or `project://` resources; they are always registered. It only removes the managed `coco` skill (`skill://coco`) that documents the workflow.
- Unset `MCP_FS_ROOT` → `fs_*` tools are no longer registered.

---

## MCP server configuration

This section covers how MCP servers (third-party or custom) are defined for fleet hosts and synced to the Claude CLI on each machine.

### Storage format

MCP servers are stored as `[[mcp_servers]]` TOML array entries in the **global** client config document (`client_config_documents` table, managed by `ClientConfigService`). Config is global *per engine*: the Codex engine and the Claude engine each have their own `client_config_documents` row (and therefore their own independent `mcp_servers` array) — there is no per-host or per-project MCP server scope.

Each entry supports the following fields:

| Field | Type | Description |
|---|---|---|
| `name` | string | Server identifier. Reserved names — `cdx`, `codex-memory`, `codex-orchestrator` on every host, `clx` additionally on Claude hosts, and `browseros` on Codex hosts with the BrowserOS MCP toggle on — are filtered out at render time to avoid colliding with managed entries. |
| `command` | string | Executable to launch (stdio transport). |
| `args` | array | Arguments to pass to `command`. |
| `url` | string | HTTP/SSE endpoint URL (HTTP transport). Use instead of `command`. |
| `bearer_token_env_var` | string | Name of an env var whose value is used as the `Authorization: Bearer` token. |
| `http_headers` | object | Static headers to send with every HTTP request. |
| `env_http_headers` | object | Headers whose values are read from env vars at render time. |
| `enabled` | bool | Defaults `true`. Set `false` to exclude the server from rendered config without deleting it. |
| `startup_timeout_sec` | int | Seconds to wait for the server process to become ready. |
| `tool_timeout_sec` | int | Per-tool-call timeout in seconds. |

There is no dedicated MCP server editor anywhere in the admin frontend today: `mcp_servers` appears nowhere in `frontend/src` (it's absent from the `ClaudeConfigSettings` TypeScript interface and from the `/settings` and `/authoring/settings` Svelte forms). In practice, adding or editing an entry means `POST`ing the full `settings` object — including the existing `mcp_servers` array — to `/admin/config/store` (Codex engine) or `/admin/claude/config/store` (Claude engine) directly. The per-host detail page exposes only a single **BrowserOS MCP** toggle (`browseros_mcp_enabled`), not a server list.

### Managed server injection

At config-render time (`client-config.ts`'s `injectManagedMcp`) the orchestrator automatically prepends one or two fleet-managed entries before the user-defined list:

**Orchestrator entry (`clx` / `cdx`)**

An entry named `clx` (for Claude hosts) or `cdx` (for Codex hosts) is injected pointing to `<baseUrl>/mcp` with `Authorization: Bearer <token>`. The token is:

- The host API key, for hosts with a secure (HTTPS/trusted) base URL.
- A per-host `managedMcpToken` (from the `mcp_session_tokens` table), for insecure hosts where the API key must not travel in plaintext.

Injection is skipped entirely when:
- `orchestrator_mcp_enabled` is `false` in that engine's config document (a `NormalizedSettings` field alongside `mcp_servers` itself — see `config-normalizer.ts` — not a per-host database column), or
- `baseUrl` or `apiKey` are not available for that host.

`orchestrator_mcp_enabled` defaults to `true` and, like `mcp_servers`, has no dedicated control in the admin frontend today.

**BrowserOS entry**

When a Codex host has `browserosMcpEnabled=1`, a second entry named `browseros` pointing to `http://127.0.0.1:9000/mcp` is also injected. This corresponds to the **BrowserOS MCP** toggle on the host detail page.

### How servers reach the Claude CLI

The `clx` wrapper syncs MCP server config on every run via a two-step process (`userconfig_merge.go`, `settings_merge.go`):

1. The wrapper fetches the config bundle from the orchestrator, which returns `{partial, owned_paths}` produced by `renderClaudeSettingsPartialForHost`.
2. The wrapper calls `splitMcpOwned` to partition `owned_paths`. Paths beginning with `mcpServers.` are routed to `applyUserMcpServers`, which writes entries into **`~/.claude.json`**. All other paths go through the standard `~/.claude/settings.json` merge.

This split is necessary because Claude Code reads user-scope MCP servers exclusively from the top-level `mcpServers` key of `~/.claude.json`. It does **not** read user-scope MCP servers from `~/.claude/settings.json`.

URL-based TOML entries are converted to `{type: "http", url, headers}` in the Claude JSON format. Command-based entries become `{command, args, env}`. Entries with `enabled: false` are excluded from the rendered output.

Older `clx` versions (before 0.6.21) used a full-file overwrite of `settings.json` instead of the partial/deep-merge path.

### Sidecar tracking file

`~/.clx/state/managed-mcp.json` records which server names are fleet-owned (`managedMcpState{version, names}`). On each sync the wrapper compares current managed names against the sidecar. Servers that have been renamed or removed in the fleet config are deleted from `~/.claude.json` on the next run. This prevents stale entries from accumulating.

The `~/.claude.json` merge is atomic and preserves the original file mode. If the file exists but cannot be parsed, the merge is skipped for that run (fail-safe) — the file is never overwritten in an unparseable state.

### Trust loss and uninstall

When a host loses fleet trust (e.g. host is deleted, wrapper is uninstalled, or the host is reconfigured without MCP), `stripUserMcpServers` re-runs the merge with an empty server map and the sidecar name list. All fleet-managed entries are removed from `~/.claude.json`. User-authored servers with names not in the sidecar survive untouched. The sidecar is then cleared.

## Source references

- api/src/services/mcp-server.ts (JSON-RPC dispatch, capability constants)
- api/src/services/mcp-tools.ts (tool registry, capability filter, full project_*/memory_*/skill_*/fs_* tool list)
- api/src/services/mcp-resources.ts (URI-scheme routing, resource_* CRUD restricted to memory://)
- api/src/services/mcp-fs.ts (fs_* tools, root sandboxing)
- api/src/services/mcp-session.ts (mcp_session_tokens)
- api/src/services/mcp-memories.ts (memory backing, mcp_memories table, key/content/tag limits)
- api/src/services/host-skills.ts (skill:// resource + skill_list/skill_retrieve — the actual read-time materialiser)
- api/src/services/host-projects.ts (project_* tool implementations, unconditional on the Projects module)
- api/src/services/managed-coco-skill.ts (coco skill gated by projects_module_enabled)
- api/src/services/skill-manifest.ts (slug/manifest validation for admin skill authoring — not the MCP read path)
- api/src/services/mcp-access-log.ts (mcp_access_logs writes)
- api/src/routes/mcp/index.ts (GET/POST /mcp transport, host/operator capability resolution)
- api/src/services/client-config.ts (injectManagedMcp, buildClaudeMcpServers, renderClaudeSettingsPartial/renderClaudeSettingsPartialForHost)
- api/src/services/config-normalizer.ts (mcp_servers / orchestrator_mcp_enabled normalization)
- wrappers/clx/internal/lifecycle/userconfig_merge.go (splitMcpOwned, applyUserMcpServers, MergeUserMcpServers, stripUserMcpServers)
- wrappers/clx/internal/lifecycle/settings_merge.go (settings.json merge path)
