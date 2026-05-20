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
