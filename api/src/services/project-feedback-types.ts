export const PROJECT_FEEDBACK_TYPES = ['bug', 'feature', 'note', 'issue', 'test'] as const;

export type ProjectFeedbackType = (typeof PROJECT_FEEDBACK_TYPES)[number];

export function normalizeProjectFeedbackType(value: unknown): ProjectFeedbackType {
  const type = String(value ?? 'feature').trim().toLowerCase();
  return isProjectFeedbackType(type) ? type : 'feature';
}

export function isProjectFeedbackType(value: unknown): value is ProjectFeedbackType {
  return typeof value === 'string' && PROJECT_FEEDBACK_TYPES.includes(value as ProjectFeedbackType);
}

export function projectFeedbackTypeList(): string {
  return PROJECT_FEEDBACK_TYPES.join(', ');
}

/**
 * The lifecycle of a feedback item.
 *
 * `coord_project_feedback.status` has existed since the table did, with a
 * DEFAULT of 'open' — and nothing ever wrote anything else. There was no
 * transition route, no MCP tool, no UI control and no test, so every item ever
 * filed is still open. A review that cannot be closed is a list that only grows,
 * which is why nobody reads it.
 *
 * `acknowledged` is deliberately between `open` and `resolved`: on a migration
 * the useful distinction is usually "somebody has seen this" rather than
 * "somebody has fixed it", and collapsing the two loses the state an operator
 * actually wants at a cutover.
 */
export const PROJECT_FEEDBACK_STATUSES = ['open', 'acknowledged', 'resolved', 'dismissed'] as const;

export type ProjectFeedbackStatus = (typeof PROJECT_FEEDBACK_STATUSES)[number];

export function isProjectFeedbackStatus(value: unknown): value is ProjectFeedbackStatus {
  return typeof value === 'string' && PROJECT_FEEDBACK_STATUSES.includes(value as ProjectFeedbackStatus);
}

export function projectFeedbackStatusList(): string {
  return PROJECT_FEEDBACK_STATUSES.join(', ');
}
