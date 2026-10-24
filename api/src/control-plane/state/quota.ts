import type { StateRow } from './catalog.js';
import type { OwnerStateDraft } from './store.js';

/** Preserve latest attempt AND last usable observation; failure is not new quota. */
export function stageChatGptQuota(draft: OwnerStateDraft, row: StateRow<'chatgptUsageSnapshots'>): void {
  draft.upsert('chatgptUsageSnapshots', row);
  const candidates = [...draft.table('chatgptUsageSnapshots').by('accountId', row.accountId)].sort(
    (a, b) => b.fetchedAt.localeCompare(a.fetchedAt) || b.id - a.id,
  );
  const keep = new Set([
    candidates[0]?.id,
    candidates.find((candidate) => candidate.status === 'ok' || candidate.status === 'rate_limited')?.id,
    Math.max(...candidates.map((candidate) => candidate.id)),
  ]);
  for (const candidate of candidates)
    if (!keep.has(candidate.id)) draft.remove('chatgptUsageSnapshots', candidate.id);
}

export function stageClaudeQuota(draft: OwnerStateDraft, row: StateRow<'claudeUsageSnapshots'>): void {
  draft.upsert('claudeUsageSnapshots', row);
  const candidates = [...draft.table('claudeUsageSnapshots').by('accountId', row.accountId)].sort(
    (a, b) => b.fetchedAt.localeCompare(a.fetchedAt) || b.id - a.id,
  );
  const keep = new Set([candidates[0]?.id, Math.max(...candidates.map((candidate) => candidate.id))]);
  for (const candidate of candidates)
    if (!keep.has(candidate.id)) draft.remove('claudeUsageSnapshots', candidate.id);
}

export function stageGrokQuota(draft: OwnerStateDraft, row: StateRow<'grokUsageSnapshots'>): void {
  draft.upsert('grokUsageSnapshots', row);
}
