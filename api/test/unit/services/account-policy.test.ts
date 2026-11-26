import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ACCOUNT_POLICY,
  parseStoredPolicy,
  poolHeadroomTarget,
  poolRecommendation,
  rebalanceTarget,
  resetAwareOrder,
  selectForLaunch,
  type AccountPolicy,
  type PolicyCandidate,
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

describe('reset-aware strategy (use expiring quota first)', () => {
  const p = policy({ strategy: 'reset_aware' });
  // Tuesday 10:00 UTC. Offsets are hours from then.
  const tuesday = Date.parse('2026-11-24T10:00:00Z');
  const inHours = (hours: number) => new Date(tuesday + hours * 3_600_000).toISOString();
  const dated = (id: number, score: number | null, weeklyResetsAt: string | null, patch: Partial<PolicyCandidate> = {}): PolicyCandidate => ({
    id,
    score,
    active: 0,
    lastSelectedAt: null,
    weeklyResetsAt,
    ...patch,
  });
  const ids = (accounts: PolicyCandidate[]) => accounts.map((a) => a.id);
  const idle = new Date(tuesday - 7_200_000).toISOString();
  const justBound = new Date(tuesday - 60_000).toISOString();

  // The operator's pool: one account reset two days ago, two are about to.
  const sunday = dated(1, 15, '2026-11-29T09:00:00Z'); // 119 h left, 85 % unused
  const wednesday = dated(2, 55, '2026-11-25T09:00:00Z'); // 23 h left, 45 % unused
  const thursday = dated(3, 70, '2026-11-26T09:00:00Z'); // 47 h left, 30 % unused
  const pool = [sunday, wednesday, thursday];

  it('stores and reads back; earlier stored policies parse unchanged', () => {
    expect(parseStoredPolicy(JSON.stringify({ strategy: 'reset_aware' }))).toMatchObject({ mode: 'auto', strategy: 'reset_aware', soft_ceiling: 90, hard_ceiling: 99 });
    const stored = { mode: 'auto', strategy: 'exhaust', spread: 'eng', soft_ceiling: 80, hard_ceiling: 95, min_dwell_minutes: 30 } as const;
    expect(parseStoredPolicy(JSON.stringify(stored))).toEqual({ ...stored, spread_points: 10 });
    expect(parseStoredPolicy(JSON.stringify({ ...DEFAULT_ACCOUNT_POLICY }))).toEqual({ ...DEFAULT_ACCOUNT_POLICY, spread_points: 20 });
    expect(parseStoredPolicy(JSON.stringify({ strategy: 'soonest' })).strategy).toBe('balanced');
  });

  it('Wed/Thu/Sun: uses the account closest to its weekly reset first, the fresh one last', () => {
    expect(ids(resetAwareOrder(p, pool, tuesday))).toEqual([2, 3, 1]);
    expect(selectForLaunch(p, pool, 95, tuesday)?.id).toBe(2);
    // The other strategies both start on the account that was reset two days ago.
    expect(selectForLaunch(policy(), pool, 95, tuesday)?.id).toBe(1);
    expect(selectForLaunch(policy({ strategy: 'exhaust' }), pool, 95, tuesday)?.id).toBe(1);
    // A running scope on the fresh account moves to the expiring one after its dwell.
    expect(rebalanceTarget(p, 1, pool, idle, tuesday)?.id).toBe(2);
    expect(rebalanceTarget(p, 2, pool, idle, tuesday)).toBeNull();
  });

  it('Wed/Thu/Sun: walks the pool in reset order as accounts fill, then to the hard ceiling', () => {
    const filled = (wed: number, thu: number, sun: number) => [{ ...sunday, score: sun }, { ...wednesday, score: wed }, { ...thursday, score: thu }];
    // Wednesday reached the soft ceiling: Thursday is next, not the emptier Sunday.
    expect(selectForLaunch(p, filled(90, 70, 15), 95, tuesday)?.id).toBe(3);
    expect(rebalanceTarget(p, 2, filled(90, 70, 15), idle, tuesday)?.id).toBe(3);
    expect(selectForLaunch(p, filled(90, 90, 15), 95, tuesday)?.id).toBe(1);
    // Everything past the soft ceiling: back to the earliest reset, up to the hard ceiling.
    expect(selectForLaunch(p, filled(92, 91, 90), 95, tuesday)?.id).toBe(2);
    expect(selectForLaunch(p, filled(99, 91, 90), 95, tuesday)?.id).toBe(3);
    // Nothing below the hard ceiling: the least used account, as exhaust does.
    expect(selectForLaunch(p, filled(100, 99, 100), 95, tuesday)?.id).toBe(3);
  });

  it('Wed/Thu/Sun: after Wednesday resets, Thursday is first and Wednesday last', () => {
    const afterReset = Date.parse('2026-11-25T09:05:00Z');
    const fresh = [sunday, dated(2, 1, '2026-12-02T09:00:00Z'), thursday];
    expect(ids(resetAwareOrder(p, fresh, afterReset))).toEqual([3, 1, 2]);
    expect(rebalanceTarget(p, 2, fresh, idle, afterReset)?.id).toBe(3);
    // Before the first reading of the new window arrives the old reset has
    // passed: the deadline is unknown, which already sorts the account last.
    const stale = [sunday, dated(2, null, '2026-11-25T09:00:00Z'), thursday];
    expect(ids(resetAwareOrder(p, stale, afterReset))).toEqual([3, 1, 2]);
    expect(selectForLaunch(p, stale, 95, afterReset)?.id).toBe(3);
    expect(rebalanceTarget(p, 2, stale, idle, afterReset)?.id).toBe(3);
  });

  it('orders by reset, not by the burn rate an account would need', () => {
    // 5 % to the ceiling in 10 h needs 0.5 %/h, 80 % in 12 h needs 6.7 %/h. Using
    // the faster-burning account first would let the small early remainder expire.
    const early = dated(1, 85, inHours(10));
    const late = dated(2, 10, inHours(12));
    expect(ids(resetAwareOrder(p, [late, early], tuesday))).toEqual([1, 2]);
    // In the operator's pool Sunday needs 0.71 %/h and Thursday 0.64 %/h; Thursday still goes first.
    expect(ids(resetAwareOrder(p, [sunday, thursday], tuesday))).toEqual([3, 1]);
  });

  it('skips an expiring account whose 5-hour window is full and returns when it recovers', () => {
    // The score is max(5 h, weekly): 92 here comes from the short window.
    const saturated = [sunday, { ...wednesday, score: 92 }, thursday];
    expect(selectForLaunch(p, saturated, 95, tuesday)?.id).toBe(3);
    expect(rebalanceTarget(p, 2, saturated, idle, tuesday)?.id).toBe(3);
    // The short window reset: the scope returns, but only after its dwell.
    expect(rebalanceTarget(p, 3, pool, justBound, tuesday)).toBeNull();
    expect(rebalanceTarget(p, 3, pool, idle, tuesday)?.id).toBe(2);
  });

  it('never treats a missing or stale reset as urgent', () => {
    const noReset = dated(4, 40, null);
    const passed = dated(5, 40, inHours(-1));
    const garbage = dated(6, 40, 'next week');
    const tooFar = dated(7, 40, inHours(24 * 30));
    expect(ids(resetAwareOrder(p, [noReset, passed, garbage, tooFar, sunday], tuesday))).toEqual([1, 4, 5, 6, 7]);
    // Unknown deadlines among themselves fall back to the least used account.
    expect(ids(resetAwareOrder(p, [dated(8, 60, null), dated(9, 20, null), sunday], tuesday))).toEqual([1, 9, 8]);
    // A running scope never moves towards an account whose reset is not proven.
    expect(rebalanceTarget(p, 1, [sunday, noReset, passed, garbage, tooFar], idle, tuesday)).toBeNull();
  });

  it('gives a never-measured idle account one launch, but not one whose reset has passed', () => {
    const unmeasured = dated(4, null, null);
    expect(selectForLaunch(p, [...pool, unmeasured], 95, tuesday)?.id).toBe(4);
    // Already tried within the last ten minutes or busy: no second trial.
    expect(selectForLaunch(p, [...pool, { ...unmeasured, lastSelectedAt: justBound }], 95, tuesday)?.id).toBe(2);
    expect(selectForLaunch(p, [...pool, { ...unmeasured, active: 1 }], 95, tuesday)?.id).toBe(2);
    // Reset passed, no reading since: a new window, saved for last without a trial.
    const justReset = dated(5, null, inHours(-3));
    expect(selectForLaunch(p, [...pool, justReset], 95, tuesday)?.id).toBe(2);
    expect(ids(resetAwareOrder(p, [...pool, justReset], tuesday))).toEqual([2, 3, 1, 5]);
    // An unmeasured account is never the target of a voluntary move.
    expect(rebalanceTarget(p, 2, [...pool, unmeasured], idle, tuesday)).toBeNull();
  });

  it('falls back to the balanced launch when no weekly reset is known at all', () => {
    const blind = [acct(1, 40), acct(2, 20, 1), acct(3, 22)];
    expect(selectForLaunch(p, blind, 95, tuesday)?.id).toBe(selectForLaunch(policy(), blind, 95, tuesday)?.id);
    expect(selectForLaunch(p, blind, 95, tuesday)?.id).toBe(3);
    // Unmeasured pools (an engine that reports no usage) keep their trial rotation.
    expect(selectForLaunch(p, [acct(1, null, 1), acct(2, null)], 95, tuesday)?.id).toBe(2);
  });

  it('without reset data a running scope only moves at a ceiling, never by the band', () => {
    // 60 points apart would move under balanced; here nothing proves an earlier reset.
    expect(rebalanceTarget(policy(), 1, [acct(1, 70), acct(2, 10)], idle, tuesday)?.id).toBe(2);
    expect(rebalanceTarget(p, 1, [acct(1, 70), acct(2, 10)], idle, tuesday)).toBeNull();
    expect(rebalanceTarget(p, 1, [acct(1, 90), acct(2, 10)], idle, tuesday)?.id).toBe(2);
    expect(rebalanceTarget(p, 1, [acct(1, 99), acct(2, 95)], idle, tuesday)?.id).toBe(2);
  });

  it('keeps an unlimited account behind every expiring one', () => {
    // Callers pass score 0 and no reset for unlimited quota.
    const unlimited = dated(4, 0, null);
    expect(ids(resetAwareOrder(p, [unlimited, ...pool], tuesday))).toEqual([2, 3, 1, 4]);
    expect(selectForLaunch(p, [unlimited, ...pool], 95, tuesday)?.id).toBe(2);
    expect(rebalanceTarget(p, 2, [unlimited, ...pool], idle, tuesday)).toBeNull();
  });

  it('never picks a blocked or full account, however close its reset', () => {
    // An emulation-blocked account is scored 100.
    const blocked = dated(4, 100, inHours(2));
    expect(selectForLaunch(p, [...pool, blocked], 95, tuesday)?.id).toBe(2);
    expect(rebalanceTarget(p, 2, [...pool, blocked], idle, tuesday)).toBeNull();
    // A scope on it leaves at once, dwell or not.
    expect(rebalanceTarget(p, 4, [...pool, blocked], justBound, tuesday, 95)?.id).toBe(2);
  });

  it('uses its own hard ceiling for the immediate move, not the fleet limit', () => {
    const at = (score: number) => [{ ...wednesday, score }, thursday, sunday];
    // 97 is past the fleet limit of 95 but below the hard ceiling of 99: the dwell holds.
    expect(rebalanceTarget(p, 2, at(97), justBound, tuesday, 95)).toBeNull();
    expect(rebalanceTarget(p, 2, at(97), idle, tuesday, 95)?.id).toBe(3);
    expect(rebalanceTarget(p, 2, at(99), justBound, tuesday, 95)?.id).toBe(3);
    // Nothing else below the hard ceiling: stay.
    expect(rebalanceTarget(p, 2, [{ ...wednesday, score: 99 }, { ...thursday, score: 99 }], justBound, tuesday, 95)).toBeNull();
  });

  it('moves a running scope only when the cache rebuild is worth it', () => {
    const on = (current: PolicyCandidate, target: PolicyCandidate) => rebalanceTarget(p, current.id, [current, target], idle, tuesday);
    const current = dated(1, 30, inHours(48));
    // Resets less than an hour apart are the same deadline.
    expect(on(current, dated(2, 30, inHours(47.5)))).toBeNull();
    expect(on(current, dated(2, 30, inHours(47)))?.id).toBe(2);
    // A later reset never attracts a scope, however empty the account.
    expect(on(current, dated(2, 0, inHours(72)))).toBeNull();
    // The target needs five points of room below the soft ceiling.
    expect(on(current, dated(2, 86, inHours(20)))).toBeNull();
    expect(on(current, dated(2, 85, inHours(20)))?.id).toBe(2);
    // A reset within 30 minutes no longer pulls a running scope over ...
    expect(on(current, dated(2, 30, inHours(0.4)))).toBeNull();
    expect(on(current, dated(2, 30, inHours(0.6)))?.id).toBe(2);
    // ... but a launch, which has no cache to lose, still takes it.
    expect(selectForLaunch(p, [current, dated(2, 30, inHours(0.4))], 95, tuesday)?.id).toBe(2);
    // A scope already on the expiring account stays until the reset.
    expect(on(dated(1, 30, inHours(0.1)), dated(2, 30, inHours(47)))).toBeNull();
    // The earliest account fails a guard: the next earlier one is still taken.
    expect(rebalanceTarget(p, 1, [current, dated(2, 30, inHours(0.4)), dated(3, 30, inHours(24))], idle, tuesday)?.id).toBe(3);
  });

  it('does not oscillate: after a move the old account does not pull the scope back', () => {
    // Wednesday hit the soft ceiling, the scope moved to Thursday.
    const accounts = [{ ...wednesday, score: 90 }, thursday, sunday];
    expect(rebalanceTarget(p, 2, accounts, idle, tuesday)?.id).toBe(3);
    expect(rebalanceTarget(p, 3, accounts, idle, tuesday)).toBeNull();
    // Past the soft ceiling everywhere, the scope returns only with room below the hard ceiling.
    const full = (wed: number) => [{ ...wednesday, score: wed }, { ...thursday, score: 91 }, { ...sunday, score: 92 }];
    expect(rebalanceTarget(p, 3, full(95), idle, tuesday)).toBeNull();
    expect(rebalanceTarget(p, 3, full(94), idle, tuesday)?.id).toBe(2);
  });

  it('manual mode ignores the strategy', () => {
    const manual = policy({ mode: 'manual', strategy: 'reset_aware' });
    expect(rebalanceTarget(manual, 1, pool, idle, tuesday)).toBeNull();
    // Launches go to the account with the most headroom, as in every manual pool.
    expect(selectForLaunch(manual, pool, 95, tuesday)?.id).toBe(1);
  });

  it('explains the reset-aware pick in the pool recommendation', () => {
    // poolRecommendation reads the clock, so these resets are relative to it.
    const soon = (hours: number) => new Date(Date.now() + hours * 3_600_000).toISOString();
    const view = (id: number, score: number | null, hours: number | null) => ({ id, label: `acct${id}`, score, usable: true, weeklyResetsAt: hours === null ? null : soon(hours) });
    const accounts = [view(1, 92, 100), view(2, 40, 9), view(3, 10, 120)];
    const planned = poolRecommendation(p, accounts[0]!, accounts, 85, 95, true, 2);
    expect(planned).toMatchObject({ action: 'switch', account_id: 2 });
    expect(planned.message).toContain('moves this session to acct2 (its weekly quota resets in 9 h, the soonest with room) at a turn boundary');
    // Nothing planned yet (dwell): the message names where the session will go.
    const waiting = poolRecommendation(p, accounts[0]!, accounts, 85, 95, true, null);
    expect(waiting).toMatchObject({ action: 'continue', account_id: null });
    expect(waiting.message).toContain('before the limit, to acct2 (its weekly quota resets in 9 h, the soonest with room).');
    // Other strategies and accounts without a proven reset keep the plain wording.
    expect(poolRecommendation(policy(), accounts[0]!, accounts, 85, 95, true, 2).message).not.toContain('weekly quota');
    const blind = [view(1, 92, null), view(2, 40, null)];
    expect(poolRecommendation(p, blind[0]!, blind, 85, 95, true, 2).message).toContain('moves this session to acct2 at a turn boundary');
    // The operator's case: the bound account is the fresh one at 15 %, far below any
    // warning, and the session still moves. The message says it is for the reset.
    const fresh = [view(1, 15, 119), view(2, 55, 23), view(3, 70, 47)];
    const early = poolRecommendation(p, fresh[0]!, fresh, 85, 95, true, 2);
    expect(early).toMatchObject({ action: 'continue', account_id: null });
    expect(early.message).toBe('Account acct1 is at 15%. The pool policy moves this session to acct2 at a turn boundary: its weekly quota resets in 23 h, the soonest with room; keep working.');
    // No move planned, another strategy or an engine without live switching: the plain line.
    expect(poolRecommendation(p, fresh[0]!, fresh, 85, 95, true, null).message).toBe('Account acct1 is at 15%.');
    expect(poolRecommendation(policy(), fresh[0]!, fresh, 85, 95, true, 2).message).toBe('Account acct1 is at 15%.');
    expect(poolRecommendation(p, fresh[0]!, fresh, 85, 95, false, 2).message).toBe('Account acct1 is at 15%.');
    // The headroom verdict uses the hard ceiling: 97 still counts while 99 pauses.
    expect(poolRecommendation(p, view(1, 99, 5), [view(1, 99, 5), view(2, 97, 9)], 85, 95, true, null).action).toBe('continue');
    expect(poolRecommendation(p, view(1, 99, 5), [view(1, 99, 5), view(2, 99, 9)], 85, 95, true, null).action).toBe('pause');
  });
});
