/**
 * The project board MCP tool names, in one place, for every consumer OUTSIDE the
 * registry: the Claude permission allowlist in `client-config.ts`, and anything
 * else that has to name a tool without registering it.
 *
 * The registry itself deliberately spells them as string literals instead of
 * importing these, for the reason `git-director-tool-names.ts` documents:
 * `mcp-doc-catalog.test.ts` scans `mcp-tools.ts` for `name: '…'` literals to
 * diff against `docs/MCP.md`, so a constant reference there would make the whole
 * family invisible to the doc check. `mcp-tools.test.ts` asserts the two lists
 * agree, which is what keeps that duplication honest.
 */
export const PROJECT_BOARD_TOOL_NAMES = {
  boardList: 'project_board_list',
  cardCreate: 'project_card_create',
  cardClaim: 'project_card_claim',
  cardMove: 'project_card_move',
  cardRelease: 'project_card_release',
  cardUpdate: 'project_card_update',
  cardGet: 'project_card_get',
} as const;

export const PROJECT_BOARD_TOOLS: readonly string[] = Object.values(PROJECT_BOARD_TOOL_NAMES);
