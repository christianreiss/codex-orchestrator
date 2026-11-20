/** Freshness/countdowns are observations; absolute windows and usage are data. */
export function sameQuotaObservation(before: object, after: object): boolean {
  const volatile = new Set([
    'id',
    'hostId',
    'source',
    'checkedAt',
    'fetchedAt',
    'createdAt',
    'updatedAt',
    'nextEligibleAt',
    'planFetchedAt',
    'raw',
    'error',
    'primaryResetAfterSeconds',
    'secondaryResetAfterSeconds',
    'sparkPrimaryResetAfterSeconds',
    'sparkSecondaryResetAfterSeconds',
  ]);
  const a = before as Record<string, unknown>,
    b = after as Record<string, unknown>;
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].every(
    (key) => volatile.has(key) || JSON.stringify(a[key] ?? null) === JSON.stringify(b[key] ?? null),
  );
}
