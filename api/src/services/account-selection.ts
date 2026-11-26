/** Quota observations are percentages of each subscription, not token totals. */
export interface AccountChoice {
  id: number;
  score: number | null;
  active: number;
  lastSelectedAt: string | null;
  /**
   * Weekly reset of the newest reading, as reported (it may have passed).
   * Null or absent: never read, or the account has no quota that expires
   * (unlimited). Only the reset-aware strategy reads it.
   */
  weeklyResetsAt?: string | null;
}

/** A weekly reset further away than this is not a weekly deadline. */
export const WEEKLY_DEADLINE_MAX_MS = 8 * 86_400_000;
/** An idle unmeasured account is tried at most once per this interval. */
export const TRIAL_INTERVAL_MS = 600_000;

/**
 * When the weekly quota of an account expires, or null when that is not
 * proven: no reset on record, an unreadable one, one that has already passed
 * (the reading is stale and the new window is unknown) or one implausibly far
 * away. Unknown is never treated as "expiring soon".
 */
export function weeklyDeadline(resetsAt: string | null | undefined, now: number): number | null {
  const reset = resetsAt ? Date.parse(resetsAt) : NaN;
  return Number.isFinite(reset) && reset > now && reset - now <= WEEKLY_DEADLINE_MAX_MS ? reset : null;
}

/** Fewest reservations first, then least recently selected, then ID. */
export const selectionOrder = (a: AccountChoice, b: AccountChoice) =>
  a.active - b.active ||
  (Date.parse(a.lastSelectedAt ?? '') || 0) - (Date.parse(b.lastSelectedAt ?? '') || 0) ||
  a.id - b.id;

/** Whether an unmeasured account may take one launch to publish a reading. */
export const trialDue = (a: AccountChoice, now: number) =>
  a.score === null && a.active === 0 && (!a.lastSelectedAt || now - Date.parse(a.lastSelectedAt) >= TRIAL_INTERVAL_MS);

export function quotaWindowScore(used: number | null, resetsAt: string | null, now: number): number | null {
  if (used === null || !Number.isFinite(used)) return null;
  const reset = resetsAt ? Date.parse(resetsAt) : NaN;
  return Number.isFinite(reset) && reset <= now ? null : Math.max(0, Math.min(100, used));
}

export function selectAccount(
  accounts: AccountChoice[],
  threshold: number,
  now: number,
): AccountChoice | null {
  if (!accounts.length) return null;
  const order = selectionOrder;
  // A bounded trial permits a new/reset account to publish its first reading.
  const trials = accounts.filter((a) => trialDue(a, now));
  if (trials.length) return trials.sort(order)[0]!;
  const measured = accounts.filter((a) => a.score !== null);
  const eligible = measured.filter((a) => a.score! < threshold);
  const candidates = eligible.length ? eligible : measured;
  if (!candidates.length) return [...accounts].sort(order)[0]!;
  const lowest = Math.min(...candidates.map((a) => a.score!));
  const tolerance = eligible.length ? 5 : 0;
  return candidates.filter((a) => a.score! <= lowest + tolerance).sort(order)[0]!;
}
