import { describe, expect, it } from 'vitest';
import { AUTH_HISTORY_RETENTION_DAYS, retentionDeadline } from '../../../src/services/auth-generation-retention.js';

describe('auth generation retention', () => {
  it('starts the 180-day clock at supersession', () => {
    const superseded = '2026-07-20T10:00:00.000Z';
    expect(retentionDeadline(superseded)).toBe(
      new Date(Date.parse(superseded) + AUTH_HISTORY_RETENTION_DAYS * 86_400_000).toISOString(),
    );
  });

  it('rejects malformed supersession timestamps', () => {
    expect(() => retentionDeadline('not-a-date')).toThrow('invalid auth superseded_at');
  });
});
