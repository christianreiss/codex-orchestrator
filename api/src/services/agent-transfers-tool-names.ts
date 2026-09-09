/**
 * The file-transfer MCP tool names, in one place, for every consumer OUTSIDE
 * the registry: the Claude permission allowlist in `client-config.ts`, and
 * anything else that has to name a tool without registering it.
 *
 * The registry itself deliberately spells them as string literals instead of
 * importing these. `test/unit/services/mcp-doc-catalog.test.ts` scans
 * `mcp-tools.ts` for `name: '…'` literals to diff against `docs/MCP.md`, so a
 * constant reference there would make the whole family invisible to the doc
 * check — passing vacuously while the documentation drifted. `mcp-tools.test.ts`
 * asserts the two lists agree, which is what keeps that duplication honest.
 *
 * `transfer_*` rather than `file_*` on purpose: `project_file_*` and the
 * operator-only `fs_*` already exist, and a third file-shaped prefix would make
 * choosing between them a coin flip for an agent that has all three.
 */
export const TRANSFER_TOOL_NAMES = {
  list: 'transfer_list',
  put: 'transfer_put',
  get: 'transfer_get',
  info: 'transfer_info',
  delete: 'transfer_delete',
} as const;

export const TRANSFER_TOOLS: readonly string[] = Object.values(TRANSFER_TOOL_NAMES);
