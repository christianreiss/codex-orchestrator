/**
 * The Git Director MCP tool names, in one place, for every consumer OUTSIDE the
 * registry: the Claude permission allowlist in `client-config.ts`, and anything
 * else that has to name a tool without registering it.
 *
 * The registry itself deliberately spells them as string literals instead of
 * importing these. `test/unit/services/mcp-doc-catalog.test.ts` scans
 * `mcp-tools.ts` for `name: '…'` literals to diff against `docs/MCP.md`, so a
 * constant reference there would make the whole family invisible to the doc
 * check — passing vacuously while the documentation drifted. `mcp-tools.test.ts`
 * asserts the two lists agree, which is what keeps that duplication honest.
 *
 * The managed AGENTS.md/CLAUDE.md block names these tools in prose rather than
 * by import; `mcp-tool-name-liveness.test.ts` holds those spellings to the live
 * registry, so a rename that left the prose behind fails the build instead of
 * quietly pointing the fleet at tools that no longer exist.
 */
export const GIT_DIRECTOR_TOOL_NAMES = {
  register: 'git_register',
  list: 'git_list',
  join: 'git_join',
  mergeRequest: 'git_merge_request',
  mergeStatus: 'git_merge_status',
  release: 'git_release',
} as const;

export const GIT_DIRECTOR_TOOLS: readonly string[] = Object.values(GIT_DIRECTOR_TOOL_NAMES);
