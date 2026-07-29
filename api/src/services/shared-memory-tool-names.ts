/**
 * The MCP tool names, in one place.
 *
 * Skill manifests and the managed AGENTS block tell agents which tools to call.
 * When those names are spelled out as free text in prose, a rename silently
 * leaves the fleet with instructions pointing at tools that no longer exist —
 * and nothing fails, agents just quietly stop using the store. Importing the
 * names means a rename breaks the build instead.
 *
 * Only the `#context` manifest is written against these constants; the CoCo
 * manifest and the managed AGENTS block name tools in prose, so their names are
 * held to the registry by `test/unit/services/mcp-tool-name-liveness.test.ts`.
 */
export const MCP_TOOL_NAMES = {
  sharedList: 'shared_memory_list',
  sharedSearch: 'shared_memory_search',
  sharedRead: 'shared_memory_read',
  sharedWrite: 'shared_memory_write',
  sharedAppend: 'shared_memory_append',
  sharedDelete: 'shared_memory_delete',
} as const;
