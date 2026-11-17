import { describe, expect, it } from 'vitest';
import { advisorStartupDiagnostic } from '../../../src/services/advisor-startup.js';

describe('advisor launch evidence', () => {
  it('retains a bounded explicit pending phase until the operation actually expires', () => {
    const createdAt = '2026-11-17T10:00:00.000Z';
    const at = Date.parse(createdAt) + 18 * 60_000;
    expect(advisorStartupDiagnostic({ status: 'offered', createdAt }, 0, null, at)).toMatchObject({
      code: 'advisor_startup_pending', phase: 'offered', elapsed_seconds: 1080, offer_timeout_seconds: 600,
    });
    expect(advisorStartupDiagnostic({ status: 'expired', createdAt }, 0, null, at)?.code).toBe('advisor_startup_timeout');
  });
  it('does not fabricate startup evidence for completed work or malformed historical rows', () => {
    expect(advisorStartupDiagnostic({ status: 'expired', createdAt: 'bad date' }, 0, null)).toBeNull();
    expect(advisorStartupDiagnostic({ status: 'expired', createdAt: new Date().toISOString() }, 1, null)).toBeNull();
    expect(advisorStartupDiagnostic({ status: 'failed', createdAt: new Date().toISOString() }, 0, null)).toBeNull();
    expect(advisorStartupDiagnostic(undefined, 0, null)).toBeNull();
  });
});
