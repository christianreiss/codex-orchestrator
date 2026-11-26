import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ACCOUNT_POLICY,
  parseStoredPolicy,
  poolHeadroomTarget,
  poolRecommendation,
  rebalanceTarget,
  selectForLaunch,
  type AccountPolicy,
} from '../../../src/services/account-policy.js';

const policy = (patch: Partial<AccountPolicy> = {}): AccountPolicy => ({
  ...DEFAULT_ACCOUNT_POLICY,
  spread_points: 20,
  ...patch,
});
const acct = (id: number, score: number | null, active = 0) => ({ id, score, active, lastSelectedAt: null });
const now = Date.parse('2026-11-26T10:00:00Z');
const longAgo = '2026-11-26T08:00:00Z';

describe('account distribution policy', () => {
  it('maps the band words to 10/20/30 points and defaults to automatic balanced', () => {
    expect(parseStoredPolicy(null)).toMatchObject({ mode: 'auto', strategy: 'balanced', spread: 'normal', spread_points: 20 });
    expect(parseStoredPolicy(JSON.stringify({ spread: 'eng' })).spread_points).toBe(10);
    expect(parseStoredPolicy(JSON.stringify({ spread: 'locker' })).spread_points).toBe(30);
    expect(parseStoredPolicy('{broken').strategy).toBe('balanced');
  });

  it('balanced: moves once the bound account is more than the band above the least used', () => {
    const p = policy();
    // 61 vs 40: 21 points apart, beyond the normal band of 20.
    expect(rebalanceTarget(p, 1, [acct(1, 61), acct(2, 40)], longAgo, now)?.id).toBe(2);
    // 55 vs 40: inside the band, stay.
    expect(rebalanceTarget(p, 1, [acct(1, 55), acct(2, 40)], longAgo, now)).toBeNull();
    expect(rebalanceTarget(policy({ spread: 'eng', spread_points: 10 }), 1, [acct(1, 55), acct(2, 40)], longAgo, now)?.id).toBe(2);
  });

  it('respects the minimum dwell, except at the quota limit', () => {
    const p = policy();
    const justBound = new Date(now - 60_000).toISOString();
    expect(rebalanceTarget(p, 1, [acct(1, 70), acct(2, 10)], justBound, now)).toBeNull();
    expect(rebalanceTarget(p, 1, [acct(1, 96), acct(2, 10)], justBound, now, 95)?.id).toBe(2);
  });

  it('exhaust: fills accounts in order to the soft ceiling, then to the hard ceiling', () => {
    const p = policy({ strategy: 'exhaust' });
    expect(selectForLaunch(p, [acct(2, 10), acct(1, 50)], 95, now)?.id).toBe(1);
    expect(selectForLaunch(p, [acct(1, 91), acct(2, 10)], 95, now)?.id).toBe(2);
    expect(selectForLaunch(p, [acct(1, 92), acct(2, 95), acct(3, 97)], 95, now)?.id).toBe(1);
    // Running: below the soft ceiling nothing moves; above it, the next account takes over.
    expect(rebalanceTarget(p, 1, [acct(1, 89), acct(2, 0)], longAgo, now)).toBeNull();
    expect(rebalanceTarget(p, 1, [acct(1, 90), acct(2, 0)], longAgo, now)?.id).toBe(2);
  });

  it('manual never moves automatically', () => {
    expect(rebalanceTarget(policy({ mode: 'manual' }), 1, [acct(1, 99), acct(2, 0)], longAgo, now, 95)).toBeNull();
  });

  it('a bound account that left the pool moves to the best usable account', () => {
    expect(rebalanceTarget(policy(), 9, [acct(1, 50), acct(2, 20)], longAgo, now)?.id).toBe(2);
  });
});

describe('pool-aware quota recommendation', () => {
  const view = (id: number, score: number | null, usable = true) => ({ id, label: `acct${id}`, score, usable });

  it('never advises a pause while another usable account has headroom', () => {
    const r = poolRecommendation(policy({ mode: 'manual' }), view(1, 90), [view(1, 90), view(2, 35), view(3, 61)], 85, 95, true, null);
    expect(r.action).toBe('switch');
    expect(r.account_id).toBe(2);
    expect(r.message).toContain('#account-switch');
  });

  it('automatic mode promises a move only when the policy plans one', () => {
    const accounts = [view(1, 88), view(2, 75)];
    expect(poolRecommendation(policy(), view(1, 88), accounts, 85, 95, true, null)).toMatchObject({ action: 'continue' });
    expect(poolRecommendation(policy(), view(1, 88), accounts, 85, 95, true, 2)).toMatchObject({ action: 'switch', account_id: 2 });
  });

  it('pauses only when the whole pool is at its limit', () => {
    const r = poolRecommendation(policy(), view(1, 99), [view(1, 99), view(2, 97), view(3, 10, false)], 85, 95, true, null);
    expect(r.action).toBe('pause');
  });

  it('engines without live switching keep working and use the pool at the next launch', () => {
    const r = poolRecommendation(policy(), view(1, 99), [view(1, 99), view(2, 10)], 85, 95, false, null);
    expect(r).toMatchObject({ action: 'continue' });
    expect(r.message).toContain('next launch');
  });

  it('headroom: a usable sibling below the ceiling, unmeasured counting as unused', () => {
    // Production shape: bound at 87%, a freshly enrolled sibling without a reading.
    expect(poolHeadroomTarget(policy(), [view(1, 87), view(8, null)], 1, 95)?.id).toBe(8);
    // Paused/unverified siblings and siblings at the ceiling never count.
    expect(poolHeadroomTarget(policy(), [view(1, 87), view(8, 0, false), view(9, 96)], 1, 95)).toBeNull();
    // Without a bound account the question is whether any account can take a launch.
    expect(poolHeadroomTarget(policy(), [view(1, 87), view(8, 99)], null, 95)?.id).toBe(1);
    expect(poolHeadroomTarget(policy(), [view(1, 97), view(8, 99)], null, 95)).toBeNull();
    // exhaust uses its hard ceiling.
    expect(poolHeadroomTarget(policy({ strategy: 'exhaust' }), [view(1, 99), view(2, 97)], 1, 95)?.id).toBe(2);
  });
});
