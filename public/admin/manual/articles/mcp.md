---
title: MCP server and tools
section: Integrations and reference
verified: 2026-07-31
sources: api/src/services/mcp-server.ts, api/src/services/mcp-tools.ts, api/src/services/mcp-resources.ts, api/src/services/mcp-fs.ts, api/src/services/mcp-session.ts, api/src/services/mcp-access-log.ts, api/src/services/mcp-memories.ts, api/src/services/shared-memories.ts, api/src/services/shared-memory-chunker.ts, api/src/services/memory-tags.ts, api/src/services/host-skills.ts, api/src/services/host-projects.ts, api/src/services/managed-coco-skill.ts, api/src/services/managed-skill-manager.ts, api/src/services/skill-manifest.ts, api/src/routes/mcp/index.ts, api/src/services/client-config.ts, api/src/services/config-normalizer.ts, api/src/db/migrations/0003_add_coord_project_memories.sql, api/src/db/migrations/0006_add_shared_memories.sql, wrappers/cxx/internal/persona/claude/lifecycle/userconfig_merge.go, wrappers/cxx/internal/persona/claude/lifecycle/settings_merge.go
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
- `memory_store`, `memory_retrieve`, `memory_search`, `memory_delete` — host-scoped (see *Memory tools* below)

**Shared memory** (both capabilities — only when the shared-memory service is wired)
- `shared_memory_list`, `shared_memory_search`, `shared_memory_read`, `shared_memory_write`, `shared_memory_append`, `shared_memory_delete` — fleet-wide, neither host- nor project-scoped; registered only when `sharedMemories` is passed to `McpToolsRegistry` (the API wires it, a registry built for a narrower surface may not). `shared_memory_write` replaces the entire body: read an existing slug completely from offset 0 through `truncated:false`, require one stable digest, preserve unaffected content, and never write back an excerpt, preview, chunk, or partial read — see *Shared memory tools* below

**Secrets** (both capabilities — only when the secrets service is wired)
- `secret_list`, `secret_search`, `secret_get`, `secret_store`, `secret_delete` — the fleet credential store: the working credentials agents need to do their job (GitHub tokens, database passwords, Bookstack/Checkmk tokens, SSH keys, third-party service keys), as distinct from the engine-boot auth that gets an agent started. Reading is open to every host. Writing is ownership-scoped: `secret_store` creates a new slug or rotates one owned by the caller, while `secret_delete` only retires a caller-owned slug; operator-provisioned credentials stay read-only to agents and are refused with `secret_not_owned`. Gated at runtime by the `secrets_module_enabled` flag in `versions` — while it is off, list and search return disabled status/capabilities with an empty `secrets` array, and `secret_get` answers `secrets_disabled`. Values are never written to a host filesystem, so revoking a secret takes effect on the next call with no wrapper involvement. Prefer a tool-native secret parameter; otherwise use stdin, an inherited descriptor, or a process-scoped environment variable, never shell text, argv, URLs, source, logged requests, or shell tracing. Sanitize output and unset temporary variables after use. `secret_get` writes its own `mcp_access_logs` row carrying the slug before it returns the value, and does not swallow a failed write, so a credential is never handed out without a trail.

**Filesystem (operator only)**
- `fs_read_file`, `fs_write_file`, `fs_list_dir`, `fs_file_exists`, `fs_stat`, `fs_search_in_files` — only registered when `MCP_FS_ROOT` points at an existing directory; every path argument is resolved beneath that root after symlink follow.

**Resources** (both capabilities)
- `resource_list`, `resource_read`, `resource_create`, `resource_update`, `resource_delete` — `list`/`read` work across every URI scheme; `create`/`update`/`delete` are restricted to `memory://`, `shared://{slug}`, and `project://{slug}/memory/{key}` (see *Resources* below).

**Skills** (both capabilities)
- `skill_list`, `skill_retrieve`, `skill_store`, `skill_delete` — canonical Skill manifest CRUD.

**Projects** (both capabilities — always registered)
- `project_list`, `project_bootstrap`, `project_detail`, `project_changes`, `project_create`
- `project_note_create`, `project_note_upsert`, `project_todo_create`, `project_todo_update`, `project_todo_done`, `project_todo_undone`
- `project_feedback_create`
- `project_file_list`, `project_file_read`, `project_file_upsert`, `project_file_delete`
- `project_memory_list`, `project_memory_get`, `project_memory_upsert`, `project_memory_delete`, `project_memory_search` — project-scoped memory (see *Project memory tools* below)

These tools are unconditional: `McpToolsRegistry` (`mcp-tools.ts`) registers them the same way it registers `memory_*`/`skill_*`, with no dependency on the Projects module toggle (`projects_module_enabled`). What *is* gated by that toggle is the managed `coco` skill (`api/src/services/managed-coco-skill.ts`, `skill://coco`) — see [Projects](/admin/manual/projects) — which onboards agents onto the `project_*` workflow. Disabling the module removes the skill, not the tools.

Use `tools/list` at runtime for the authoritative set; what you see depends on who is calling.

## Skill tools

`skill_store` accepts `{slug, manifest, display_name?, description?}` and creates,
fully replaces, or revives one manifest-only canonical Skill. `skill_delete` accepts
`{slug}` and soft-deletes it, so a later store can recover the same slug. Mutations
are last-writer-wins, attributed to the authenticated host, and always shared as
`engine:null`; there is no per-call engine override. Code-managed slugs and rows
owned by an external Skill source are read-only.

The always-available managed `skill-manager` Skill handles both questions about
this lifecycle and mutations: list first, retrieve before changing a Skill, store
or delete it, then retrieve again to verify the result. On Codex hosts with the
managed MCP available, startup guidance makes this path authoritative and the
baked config disables the competing built-in `skill-creator` by name. Skill text
is still untrusted instruction content and cannot grant authority beyond the
user's request.

## Resources

`McpResourcesService` (`api/src/services/mcp-resources.ts`) registers five URI schemes, all listed by `resources/templates/list`:

- `memory://{key}` — a single host-scoped memory. Together with `shared://{slug}` and `project://{slug}/memory/{key}`, these are the only schemes `resource_create`/`resource_update`/`resource_delete` accept; every other scheme rejects create/update/delete with an explicit error. `resource_update` is a plain alias for `resource_create` (both call the same upsert path).
- `shared://{slug}` — a fleet-wide shared-memory document. Create/update carries only `text` plus optional `expected_sha256`; replacing an existing document still requires the same complete offset-zero read, stable digest, preserved unaffected content, and conflict restart as `shared_memory_write`. Delete is appropriate only when the whole record is invalid or superseded.
- `project://{slug}` — the same shape as `project_bootstrap` but consumed as a resource. Always available (see the Projects note above).
- `project://{slug}/files/{stored_name}` — a single project file's raw content.
- `project://{slug}/memory/{key}` — a single project-scoped memory. Writable, but this path only carries `text`: tags and metadata are unreachable here, so `project_memory_upsert` remains the full-fidelity surface.
- `skill://{slug}` — the canonical skill manifest, materialised at read time by `HostSkillsService.retrieve()` (`api/src/services/host-skills.ts`). `skill-manifest.ts` is a separate helper used by the admin skill-authoring routes (slug/manifest validation for drafts) — it is not on this read path. This is how both `cdx` and `clx` bring in slash-command skills without keeping per-host copies on disk.

`resource_list` enumerates every project (plus up to 50 files and up to 50 memories each) and every skill as browsable entries. It does **not** enumerate host-scoped `memory://` entries — those have no listing path at all (see below). Reading a resource is preferred over the more specific tools when the agent only needs to read; it skips the tool schema-validation step.

## Memory tools

`McpMemoriesService` (`api/src/services/mcp-memories.ts`) backs the memory tools. Memories are scoped per host: the unique key is `(host_id, memory_key)` in the `mcp_memories` table — there is no cross-host or resource-URI namespace. `memory_search` runs a MariaDB `MATCH() AGAINST() IN NATURAL LANGUAGE MODE` full-text query over `content`/`tags_text`, then applies any tag filter in application code.

Limits enforced at the service layer:

- `id` (the memory key): letters, digits, `.`, `_`, `:`, `-` only, 128 characters max. A key equal to `coco` or starting with `coco` followed by a separator (`coco.`, `coco_`, `coco:`, `coco-`) is rejected — that namespace is reserved for CoCo shared-project handoffs (use `project_*` tools for coordination state, or `shared_memory_*` for fleet-wide documents, instead of host-scoped memory).
- `content`: required, 32,000 characters max.
- `tags`: up to 32 tags, 64 characters each, case-insensitively deduplicated.

Two limitations are worth knowing before you build on this surface. Host memories **cannot be enumerated over MCP**: there is no `memory_list` tool, `memory_search` marks `query` required (the tool layer rejects an empty string, so the service's own match-all branch is unreachable), and `resource_list` never lists `memory://`. A caller that does not already know a key can only guess search terms. And `memory_search` is lexical, not semantic — a query sharing no tokens with the stored text returns nothing, and the InnoDB full-text minimum token length silently drops very short terms. If you need memory a fresh agent can discover, or memory visible from more than one host, use the project-scoped store or the fleet-wide store below.

## Project memory tools

`HostProjectsService` (`api/src/services/host-projects.ts`) backs `project_memory_*`, stored in `coord_project_memories` with a unique `(project_id, memory_key)`. The contrast with `memory_*` is the whole point:

| | `memory_*` | `project_memory_*` | `shared_memory_*` |
| --- | --- | --- | --- |
| Scope | one host | one project, visible from every host | the whole fleet — no host, no project |
| Shape | one short fact per key (32k cap) | one short fact per key (32k cap) | documents up to 1 MiB, chunked for retrieval |
| Enumerable | no | yes — `project_memory_list`, `project_memory_search` with no query, and `resource_list` | yes — `shared_memory_list` takes no required argument at all |
| Search | lexical over one host's rows | lexical over one project's rows | lexical over every chunk of every document, returning ranked passages |
| Deletes | soft (`deleted_at`); re-storing resurrects | hard; `coord_project_events` is the audit trail | soft from a host (slug stays reserved, a later write revives it); hard from the admin surface |
| Audit log | none | every mutation records a `memory` event and bumps `latest_event_seq` | `shared_memory_revisions` records op, digest, size delta and author per revision (metadata only, no bodies) |
| Attribution | implicit (`host_id`) | `source_host_id` records the writing host | `source_host_id` + `source_engine` record the last writer — provenance only, never a read filter |
| Concurrent writers | last write wins | last write wins | `shared_memory_append` keeps both writers' text; `expected_sha256` on write turns a lost update into a `409` |

Validation matches `memory_*` (key charset and 128-char cap, 32,000-char content, 32 tags of 64 chars) with three deliberate differences:

- **No reserved prefix.** `mcp_memories` rejects `coco*` keys precisely to redirect callers to a shared store; reserving it here (or in `shared_memories`) too would reject the agent that complied.
- **`key` is required** and never auto-generated. `memory_store` falls back to a random UUID; in a shared namespace a UUID key is unaddressable, so "just dump text" belongs in project notes instead.
- **`query` is optional on `project_memory_search`**, degrading to a recency-ordered listing rather than an error.

`project_memory_upsert` is idempotent and reports `created`, `updated`, or `unchanged`. An `unchanged` re-store writes nothing and records **no** event — otherwise a no-op would bump `latest_event_seq` and make every other host re-sync for nothing. `project_memory_list` returns 280-character previews plus `content_length` by default (pass `include_content: true` for full rows), and `project_bootstrap` surfaces at most 8 previews under `recent_memories` plus a `counts.memories` total.

Search is a project-scoped `MATCH() AGAINST() IN NATURAL LANGUAGE MODE` over `content`/`tags_text` with tag filters applied in application code. If the full-text index is missing — it ships in `api/src/db/migrations/0003_add_coord_project_memories.sql`, and nothing applies migrations automatically — search falls back to a substring scan and sets `degraded: true` in the response rather than failing.

## Shared memory tools

`SharedMemoriesService` (`api/src/services/shared-memories.ts`) backs `shared_memory_*`. It exists because neither store above can hold "everything the fleet knows about X": `mcp_memories` is keyed `(host_id, memory_key)` and `coord_project_memories` needs a project. Shared memories are slug-addressed documents with no host and no project scoping — anything written by `cdx` on one host is found by `clx` on another.

| Tool | What it does |
| --- | --- |
| `shared_memory_list` | The discovery entry point. Needs no arguments; returns slug, title, summary, tags, size, revision and a preview for every document. Optional `prefix`, `tags`, `limit`, `offset`, `include_content`. |
| `shared_memory_search` | Ranked passages across the whole corpus. `mode: "documents"` folds hits into one entry per document. Carries `degraded: true` when the chunk index is missing. |
| `shared_memory_read` | A bounded window over one document — `max_chars` (default 32,000), `offset`, or a `chunk` / `from_chunk`–`to_chunk` range. `truncated` + `next_offset` let you walk a 1 MiB document without holding all of it. |
| `shared_memory_write` | Create or replace, up to 1,048,576 characters. Before replacing an existing slug, read from offset 0 without chunk selectors through `truncated:false`, require the same `memory.sha256` on every window, and preserve all unaffected content. Never reconstruct a replacement from an excerpt, preview, chunk, or partial read. Pass the stable digest as `expected_sha256`; on conflict or a changed digest between windows, restart the complete read. |
| `shared_memory_append` | Grow a document without reading it first. This is the multi-writer-safe path; tags are unioned rather than replaced. Creates the document when the slug is new. Append for concurrency, replace for correction — appending beside a statement that has become wrong leaves both standing. |
| `shared_memory_delete` | Retire a document only when the whole record is invalid or superseded, not merely because one fact is stale. Soft delete: the slug stays reserved and a later write revives it; the admin delete is the hard one. |

Documents are split into chunks on markdown structure — headings first, then paragraph and line boundaries — and it is the chunk, not the document, that carries the full-text index. That is what makes a search hit point at a readable passage with its heading breadcrumb (`Ops > Deploy > Crane`) instead of at a 1 MiB blob. The chunks of one revision tile their document exactly, so a chunk range is also a character range.

Validation: slug `^[a-z0-9][a-z0-9._:-]*$` (≤160 chars, lower-cased on write — the column collation is case-insensitive, so `Deploy` and `deploy` are one row), title ≤255, summary ≤1000, content ≤1,048,576, 32 tags of 64 characters. No reserved prefix applies.

The same caveats as every other full-text search here: InnoDB's default minimum token length is 3 and the stopword list is on, so a two-character or stopword-only query matches nothing and looks identical to "no results". If the chunk index is missing — it ships in `api/src/db/migrations/0006_add_shared_memories.sql`, along with a backstop that adds it to a table `drizzle-kit push` created without it — search falls back to a bounded substring scan — the first 64 KiB of each of at most 200 documents — and sets `degraded: true`. The bound matters: unlike the project-scoped fallback, this corpus has no natural size limit, so an unbounded scan would trade a missing index for an out-of-memory. Listings never read bodies at all (they select a short prefix), which is why `resource_list` stays cheap even though every wrapper calls it on connect.

Documents are also available as resources: `shared://{slug}` returns the body as `text/markdown`, the 50 most recently updated appear in `resource_list`, and the text-only mutation path follows the same complete-read/CAS rule described above.

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

There is no dedicated MCP server editor anywhere in the admin frontend today: `mcp_servers` appears nowhere in `frontend/src` (it is absent from the `ClaudeConfigSettings` TypeScript interface and from all three `/settings` tab forms). In practice, adding or editing an entry means `POST`ing the full `settings` object — including the existing `mcp_servers` array — to `/admin/config/store` (Codex engine) or `/admin/claude/config/store` (Claude engine) directly. The per-host detail page exposes only a single **BrowserOS MCP** toggle (`browseros_mcp_enabled`), not a server list.

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
- api/src/services/mcp-tools.ts (tool registry, capability filter, full project_*/memory_*/shared_memory_*/skill_*/fs_* tool list)
- api/src/services/mcp-resources.ts (URI-scheme routing, resource_* CRUD restricted to the memory:// and project://{slug}/memory/{key} schemes)
- api/src/services/mcp-fs.ts (fs_* tools, root sandboxing)
- api/src/services/mcp-session.ts (mcp_session_tokens)
- api/src/services/mcp-memories.ts (host-scoped memory backing, mcp_memories table, key/content/tag limits)
- api/src/services/memory-tags.ts (tag/metadata normalization shared by both memory stores)
- api/src/db/migrations/0003_add_coord_project_memories.sql (coord_project_memories DDL incl. the full-text index)
- api/src/services/host-skills.ts (skill:// reads plus skill_list/skill_retrieve/skill_store/skill_delete)
- api/src/services/host-projects.ts (project_* tool implementations, unconditional on the Projects module)
- api/src/services/managed-coco-skill.ts (coco skill gated by projects_module_enabled)
- api/src/services/managed-skill-manager.ts (always-available agent runbook for Skill CRUD)
- api/src/services/skill-manifest.ts (slug/manifest validation for admin skill authoring — not the MCP read path)
- api/src/services/mcp-access-log.ts (mcp_access_logs writes)
- api/src/routes/mcp/index.ts (GET/POST /mcp transport, host/operator capability resolution)
- api/src/services/client-config.ts (injectManagedMcp, buildClaudeMcpServers, renderClaudeSettingsPartial/renderClaudeSettingsPartialForHost)
- api/src/services/config-normalizer.ts (mcp_servers / orchestrator_mcp_enabled normalization)
- wrappers/cxx/internal/persona/claude/lifecycle/userconfig_merge.go (splitMcpOwned, applyUserMcpServers, MergeUserMcpServers, stripUserMcpServers)
- wrappers/cxx/internal/persona/claude/lifecycle/settings_merge.go (settings.json merge path)
