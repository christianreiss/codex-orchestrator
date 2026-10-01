/** Quota observations are percentages of each subscription, not token totals. */
export interface AccountChoice {
  id: number;
  score: number | null;
  active: number;
  lastSelectedAt: string | null;
}

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
  const order = (a: AccountChoice, b: AccountChoice) =>
    a.active - b.active ||
    (Date.parse(a.lastSelectedAt ?? '') || 0) - (Date.parse(b.lastSelectedAt ?? '') || 0) ||
    a.id - b.id;
  // A bounded trial permits a new/reset account to publish its first reading.
  const trials = accounts.filter(
    (a) =>
      a.score === null &&
      a.active === 0 &&
      (!a.lastSelectedAt || now - Date.parse(a.lastSelectedAt) >= 600_000),
  );
  if (trials.length) return trials.sort(order)[0]!;
  const measured = accounts.filter((a) => a.score !== null);
  const eligible = measured.filter((a) => a.score! < threshold);
  const candidates = eligible.length ? eligible : measured;
  if (!candidates.length) return [...accounts].sort(order)[0]!;
  const lowest = Math.min(...candidates.map((a) => a.score!));
  const tolerance = eligible.length ? 5 : 0;
  return candidates.filter((a) => a.score! <= lowest + tolerance).sort(order)[0]!;
}
