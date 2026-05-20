import { describe, expect, it } from 'vitest';
import {
  isProjectFeedbackType,
  normalizeProjectFeedbackType,
  PROJECT_FEEDBACK_TYPES,
  projectFeedbackTypeList,
} from '../../../src/services/project-feedback-types.js';

describe('project feedback types', () => {
  it('accepts the full CoCo feedback vocabulary', () => {
    expect(PROJECT_FEEDBACK_TYPES).toEqual(['bug', 'feature', 'note', 'issue', 'test']);
    for (const type of PROJECT_FEEDBACK_TYPES) {
      expect(isProjectFeedbackType(type)).toBe(true);
    }
  });

  it('normalizes missing or invalid types to feature', () => {
    expect(normalizeProjectFeedbackType(undefined)).toBe('feature');
    expect(normalizeProjectFeedbackType('')).toBe('feature');
    expect(normalizeProjectFeedbackType('unknown')).toBe('feature');
  });

  it('normalizes case and whitespace for accepted types', () => {
    expect(normalizeProjectFeedbackType(' Issue ')).toBe('issue');
    expect(normalizeProjectFeedbackType(' TEST ')).toBe('test');
  });

  it('formats the validation list in contract order', () => {
    expect(projectFeedbackTypeList()).toBe('bug, feature, note, issue, test');
  });
});
