import { createHash } from 'node:crypto';
import type { OwnerStateSnapshot } from '../control-plane/state/store.js';
import type { OwnerWorkObligation } from './owner-worker.js';
import { GROK_USAGE_INTERVAL_MS } from '../services/grok-usage.js';
import { MATTPOCOCK_STATE_KEY } from '../services/mattpocock-skills.js';
import { FEEDBACK_CONFIG_KEY, FEEDBACK_MODE_KEY } from '../services/feedback/contract.js';
import type { BuildIdentity } from '../services/feedback/build-identity.js';

const enabled = (snapshot: OwnerStateSnapshot, engine: string) =>
  !['1', 'true', 'yes', 'on'].includes(snapshot.setting(`${engine}_engine_disabled`)?.toLowerCase() ?? '');
const stamp = (value: string | null | undefined) => (value ? Date.parse(value) : NaN);
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
export function grokUsageObligations(snapshot: OwnerStateSnapshot): OwnerWorkObligation[] {
  if (!enabled(snapshot, 'grok')) return [];
  return snapshot.accounts
    .all()
    .filter(
      (account) => account.engine === 'grok' && account.state === 'enabled' && !account.mergedIntoAccountId,
    )
    .map((account) => {
      const previous = snapshot.table('grokUsageSnapshots').get(account.id);
      const checked = stamp(previous?.checkedAt);
      return {
        key: String(account.id),
        revision: `${account.updatedAt}:${previous?.checkedAt ?? 'new'}`,
        dueAt: Number.isFinite(checked) ? checked + GROK_USAGE_INTERVAL_MS : 0,
      };
    });
}
export function chatGptUsageObligations(
  snapshot: OwnerStateSnapshot,
  intervalMs: number,
): OwnerWorkObligation[] {
  if (!enabled(snapshot, 'codex')) return [];
  const accounts = snapshot.accounts
    .all()
    .filter(
      (account) => account.engine === 'codex' && account.state === 'enabled' && !account.mergedIntoAccountId,
    );
  const ids: Array<number | null> = accounts.map((account) => account.id);
  if (
    !ids.length &&
    snapshot
      .table('authCanonicalHeads')
      .all()
      .some((row) => row.engine === 'codex')
  )
    ids.push(null);
  return ids.map((id) => {
    const previous = snapshot
      .table('chatgptUsageSnapshots')
      .all()
      .filter((row) => row.accountId === id)
      .sort((a, b) => b.fetchedAt.localeCompare(a.fetchedAt) || b.id - a.id)[0];
    const fetched = stamp(previous?.fetchedAt);
    const eligible = stamp(previous?.nextEligibleAt);
    return {
      key: id === null ? 'canonical' : String(id),
      revision: String(previous?.id ?? 'new'),
      dueAt:
        previous && Number.isFinite(fetched)
          ? Math.max(fetched + intervalMs, Number.isFinite(eligible) ? eligible : fetched + 300_000)
          : 0,
    };
  });
}
export function skillSourceObligations(snapshot: OwnerStateSnapshot): OwnerWorkObligation[] {
  const raw = snapshot.setting(MATTPOCOCK_STATE_KEY);
  if (!raw) return [];
  const state = JSON.parse(raw) as { enabled?: boolean; auto_update?: boolean; last_checked_at?: string };
  if (!state.enabled || !state.auto_update) return [];
  const checked = stamp(state.last_checked_at);
  return [
    {
      key: 'mattpocock',
      revision: digest(raw),
      dueAt: Number.isFinite(checked) ? checked + 6 * 60 * 60_000 : 0,
    },
  ];
}
export function feedbackObligations(
  snapshot: OwnerStateSnapshot,
  identity: BuildIdentity,
): OwnerWorkObligation[] {
  const claims = snapshot
    .table('feedbackItems')
    .all()
    .flatMap((row) =>
      row.status === 'in_progress' && row.claimExpiresAt
        ? [{ key: `claim:${row.id}`, revision: String(row.version), dueAt: Date.parse(row.claimExpiresAt) }]
        : [],
    );
  if (
    !['1', 'true', 'yes', 'on'].includes(snapshot.setting('feedback_enabled')?.toLowerCase() ?? '') ||
    ['1', 'true', 'yes', 'on'].includes(snapshot.setting('api_disabled')?.toLowerCase() ?? '')
  )
    return claims;
  if (snapshot.setting(FEEDBACK_MODE_KEY) !== 'user') return claims;
  const raw = snapshot.setting(FEEDBACK_CONFIG_KEY);
  const config = raw ? (JSON.parse(raw) as { runner_enabled?: boolean }) : {};
  if (!config.runner_enabled) return claims;
  const lease = snapshot.setting('feedback_runner_lease');
  const until = lease ? stamp((JSON.parse(lease) as { until?: string }).until) : NaN;
  return [
    ...claims,
    ...snapshot
      .table('feedbackPipeline')
      .all()
      .flatMap((row) => {
        const work: OwnerWorkObligation[] =
          identity.commit &&
          !identity.dirty &&
          row.versionState === 'old_version' &&
          row.testedCommit !== identity.commit
            ? [{ key: `build:${row.feedbackId}`, revision: identity.commit, dueAt: 0 }]
            : [];
        const due = stamp(row.nextAttemptAt);
        if (!Number.isFinite(due)) return work;
        const rowLease = stamp(row.leaseExpiresAt);
        return [
          ...work,
          {
            key: row.feedbackId,
            revision: `${row.updatedAt}:${row.leaseToken ?? ''}:${row.nextAttemptAt}`,
            dueAt: Math.max(
              due,
              Number.isFinite(until) ? until : 0,
              Number.isFinite(rowLease) ? rowLease : 0,
            ),
          },
        ];
      }),
  ];
}
