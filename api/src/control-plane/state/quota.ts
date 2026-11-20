import type { StateRow } from './catalog.js';
import type { OwnerStateDraft } from './store.js';

const USABLE = new Set(['ok', 'rate_limited']);

/** The weekly window can sit in either slot; `dailyUsage` reads whichever holds it. */
function hasWeeklyUsage(row: StateRow<'chatgptUsageSnapshots'>): boolean {
  return (
    (row.primaryLimitSeconds === 604800 && row.primaryUsedPercent !== null) ||
    (row.secondaryLimitSeconds === 604800 && row.secondaryUsedPercent !== null)
  );
}

/**
 * Stage one Codex snapshot and keep the account's RAM history bounded to the
 * rows hydration loads (`catalog.ts`, `chatgptUsageSnapshots`): the newest
 * arrival, the newest observation, the newest usable observation (a failure is
 * not new quota), and today's first usable weekly observation, which
 * `ChatGptUsageService.dailyUsage` uses as its UTC-day baseline. Older rows stay
 * in the database; only owner RAM forgets them, exactly as a restart would.
 */
export function stageChatGptQuota(
  draft: OwnerStateDraft,
  row: StateRow<'chatgptUsageSnapshots'>,
  now: Date = new Date(),
): void {
  draft.upsert('chatgptUsageSnapshots', row);
  const rows = [...draft.table('chatgptUsageSnapshots').by('accountId', row.accountId)];
  const newestFirst = [...rows].sort((a, b) => b.fetchedAt.localeCompare(a.fetchedAt) || b.id - a.id);
  const midnight = new Date(now);
  midnight.setUTCHours(0, 0, 0, 0);
  const today = midnight.toISOString();
  const baseline = rows
    .filter((candidate) => candidate.fetchedAt >= today && USABLE.has(candidate.status) && hasWeeklyUsage(candidate))
    .sort((a, b) => a.fetchedAt.localeCompare(b.fetchedAt) || a.id - b.id)[0];
  const keep = new Set([
    Math.max(...rows.map((candidate) => candidate.id)),
    newestFirst[0]?.id,
    newestFirst.find((candidate) => USABLE.has(candidate.status))?.id,
    baseline?.id,
  ]);
  for (const candidate of rows) if (!keep.has(candidate.id)) draft.remove('chatgptUsageSnapshots', candidate.id);
}

/** Same bound for Claude: hydration keeps the newest arrival and the newest observation. */
export function stageClaudeQuota(draft: OwnerStateDraft, row: StateRow<'claudeUsageSnapshots'>): void {
  draft.upsert('claudeUsageSnapshots', row);
  const candidates = [...draft.table('claudeUsageSnapshots').by('accountId', row.accountId)].sort(
    (a, b) => b.fetchedAt.localeCompare(a.fetchedAt) || b.id - a.id,
  );
  const keep = new Set([candidates[0]?.id, Math.max(...candidates.map((candidate) => candidate.id))]);
  for (const candidate of candidates)
    if (!keep.has(candidate.id)) draft.remove('claudeUsageSnapshots', candidate.id);
}

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
