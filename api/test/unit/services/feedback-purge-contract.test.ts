import { describe, expect, it } from 'vitest';
import { feedbackPurgeSchema, parseFeedback } from '../../../src/services/feedback-contract.js';

describe('feedback purge contract', () => {
  it('accepts only closed statuses and normalizes older_than to the stored ISO form', () => {
    expect(parseFeedback(feedbackPurgeSchema, { statuses: ['resolved', 'duplicate'], older_than: '2026-10-01T12:00:00+02:00' }))
      .toEqual({ statuses: ['resolved', 'duplicate'], older_than: '2026-10-01T10:00:00.000Z' });
    expect(parseFeedback(feedbackPurgeSchema, { statuses: ['dismissed'] })).toEqual({ statuses: ['dismissed'] });
  });

  it.each([
    [{ statuses: [] }],
    [{ statuses: ['open'] }],
    [{ statuses: ['in_progress'] }],
    [{ statuses: ['blocked'] }],
    [{}],
    [{ statuses: ['resolved'], older_than: 'yesterday' }],
    [{ statuses: ['resolved'], extra: true }],
  ])('rejects %j', (input) => {
    expect(() => parseFeedback(feedbackPurgeSchema, input)).toThrow();
  });
});
