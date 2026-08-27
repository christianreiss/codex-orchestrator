/**
 * The project board's role vocabulary: fleet-fixed, not per-board.
 *
 * A role is what an agent says it is doing to a card, and it is self-declared
 * per claim — exactly like `task` and `target_branch` in `git_join`, and for the
 * same reason. It deliberately does NOT live on `agent_bus_addresses`: the board
 * treats that binding as enrichment which may be absent, so hanging roles off it
 * would make the whole feature depend on Agent Messaging being enabled, and
 * would write to a table the board does not own.
 *
 * The set is fixed fleet-wide so that two boards mean the same thing by the same
 * word and the managed `coco` skill can document it once. Board *shape* still
 * varies: `coord_project_board_columns.allowed_roles` says which of these a lane
 * expects, and that mapping is advisory.
 */
export const PROJECT_BOARD_ROLES = ['plan', 'code', 'review', 'verify', 'ops'] as const;

export type ProjectBoardRole = (typeof PROJECT_BOARD_ROLES)[number];

export function isProjectBoardRole(value: unknown): value is ProjectBoardRole {
  return typeof value === 'string' && PROJECT_BOARD_ROLES.includes(value as ProjectBoardRole);
}

/**
 * Unlike `normalizeProjectFeedbackType`, an unrecognised value returns null
 * rather than falling back to a default. A feedback type that guesses wrong
 * mislabels a row; a role that guesses wrong records, as fact, that an agent
 * claimed a card in a capacity it never declared — and every advisory computed
 * from it afterwards inherits the lie. The caller decides what to do with null.
 */
export function normalizeProjectBoardRole(value: unknown): ProjectBoardRole | null {
  if (value === null || value === undefined) return null;
  const role = String(value).trim().toLowerCase();
  return isProjectBoardRole(role) ? role : null;
}

export function projectBoardRoleList(): string {
  return PROJECT_BOARD_ROLES.join(', ');
}
