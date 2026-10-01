import { describe, expect, it } from 'vitest';
import {
  quotaWindowScore,
  selectAccount,
  type AccountChoice,
} from '../../../src/services/account-selection.js';
const now = Date.parse('2026-09-30T10:00:00Z');
const choice = (
  id: number,
  score: number | null,
  active = 0,
  lastSelectedAt: string | null = null,
): AccountChoice => ({ id, score, active, lastSelectedAt });
describe('account quota selection', () => {
  it('prefers capacity and distributes comparable accounts by reservations', () => {
    expect(selectAccount([choice(1, 80), choice(2, 20, 2), choice(3, 23)], 95, now)?.id).toBe(3);
    expect(selectAccount([choice(1, 80), choice(2, 20, 10)], 95, now)?.id).toBe(2);
  });
  it('uses an idle unknown account for a bounded trial and keeps stale non-reset utilization', () => {
    expect(selectAccount([choice(1, 20), choice(2, null)], 95, now)?.id).toBe(2);
    expect(
      selectAccount([choice(1, 20), choice(2, null, 0, new Date(now - 1000).toISOString())], 95, now)?.id,
    ).toBe(1);
    expect(quotaWindowScore(96, new Date(now + 1000).toISOString(), now)).toBe(96);
    expect(quotaWindowScore(96, new Date(now - 1000).toISOString(), now)).toBeNull();
  });
  it('selects a least-used account when all are exhausted and leaves enforcement to launch policy', () => {
    expect(selectAccount([choice(1, 100), choice(2, 96)], 95, now)?.id).toBe(2);
    expect(selectAccount([], 95, now)).toBeNull();
  });
});
