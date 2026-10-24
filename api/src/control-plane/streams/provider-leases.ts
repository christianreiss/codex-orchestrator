import { eq, inArray } from 'drizzle-orm';
import {
  providerAccountSessions,
  providerAccounts,
  authPayloads,
  authEntries,
  grokAuthRefreshState,
} from '../../db/schema.js';
import type { OwnerRuntime } from '../state/runtime.js';
import { mutateOwnerState } from '../state/runtime.js';
import type { OwnerStateSnapshot } from '../state/store.js';
import { ConflictError, NotFoundError, ServiceUnavailableError } from '../../http/errors.js';
import { selectAccount, quotaWindowScore } from '../../services/account-selection.js';
import { DEFAULT_QUOTA_POLICY, quotaPolicySchema } from '../../services/quota-policy.js';
import type { Engine } from '../../util/engine.js';
import type { Json } from '../commands.js';

export function ownedAccount(s: OwnerStateSnapshot, id: number, engine?: Engine) {
  const seen = new Set<number>();
  while (!seen.has(id)) {
    seen.add(id);
    const row = s.accounts.get(id);
    if (!row || (engine && row.engine !== engine)) return undefined;
    if (!row.mergedIntoAccountId) return row;
    engine = row.engine as Engine;
    id = row.mergedIntoAccountId;
  }
  throw new ConflictError('Invalid account merge reference', 'account_merge_cycle');
}
export function ownedProviderSession(owner: OwnerRuntime, hostId: number, engine: Engine, id: string) {
  owner.assertOwner();
  const row = owner.state.snapshot().table('providerAccountSessions').get(id);
  if (
    !row ||
    row.hostId !== hostId ||
    row.engine !== engine ||
    (row.ownershipMode !== 'connection' && Date.parse(row.expiresAt) <= Date.now())
  )
    throw new NotFoundError('Account session not found');
  return row;
}
function unlimited(s: OwnerStateSnapshot, engine: Engine, id: number) {
  const raw = s.setting(`quota_policy_account_${id}`) || s.setting(`quota_policy_${engine}`);
  try {
    return raw ? quotaPolicySchema.parse(JSON.parse(raw)).unlimited : DEFAULT_QUOTA_POLICY.unlimited;
  } catch {
    return false;
  }
}
function score(s: OwnerStateSnapshot, engine: Engine, id: number) {
  if (unlimited(s, engine, id)) return 0;
  const now = Date.now();
  if (engine === 'grok') return null; // Grok usage is display-only, as in existing selection.
  let values: Array<number | null>;
  if (engine === 'claude') {
    const r = [...s.table('claudeUsageSnapshots').by('accountId', id)].sort((a, b) => b.id - a.id)[0];
    values = [
      quotaWindowScore(r?.fiveHourUsedPercent ?? null, r?.fiveHourResetsAt ?? null, now),
      quotaWindowScore(r?.sevenDayUsedPercent ?? null, r?.sevenDayResetsAt ?? null, now),
    ];
  } else {
    const r = [...s.table('chatgptUsageSnapshots').by('accountId', id)]
      .filter((r) => r.status === 'ok')
      .sort((a, b) => b.id - a.id)[0];
    const windows = [
      { used: r?.primaryUsedPercent, reset: r?.primaryResetAt, limit: r?.primaryLimitSeconds },
      { used: r?.secondaryUsedPercent, reset: r?.secondaryResetAt, limit: r?.secondaryLimitSeconds },
    ];
    const short = windows.find((w) => w.used != null && (w.limit ?? 0) < 604800);
    const weekly = windows.find((w) => w.used != null && (w.limit ?? 0) >= 604800);
    values = [
      quotaWindowScore(short?.used ?? null, short?.reset ?? null, now),
      quotaWindowScore(weekly?.used ?? null, weekly?.reset ?? null, now),
    ];
  }
  const present = values.filter((x): x is number => x !== null);
  return present.length ? Math.max(...present) : null;
}
export async function acquireOwnedProvider(
  owner: OwnerRuntime,
  hostId: number,
  engine: Engine,
  scopeId: string,
  sessionId: string,
  threshold: number,
  preferred?: number,
) {
  return (await mutateOwnerState(owner, {
    kind: 'provider.session.acquire',
    payload: { hostId, engine, scopeId, sessionId, threshold, preferred: preferred ?? null },
    prepare({ snapshot: s, draft, write }) {
      const now = new Date().toISOString();
      const sessions = s
        .table('providerAccountSessions')
        .all()
        .filter((r) => r.ownershipMode === 'connection' || r.expiresAt > now);
      const prior = s.table('providerAccountSessions').get(sessionId);
      if (prior && (prior.hostId !== hostId || prior.engine !== engine || prior.scopeId !== scopeId))
        throw new ConflictError('Session ID already in use');
      const previous = sessions.find((r) => r.id === sessionId);
      const pinned =
        previous ?? sessions.find((r) => r.hostId === hostId && r.engine === engine && r.scopeId === scopeId);
      const accounts = s.accounts.by('engine', engine);
      let account = pinned ? ownedAccount(s, pinned.accountId, engine) : undefined;
      if (account?.state === 'removed') throw new ConflictError('Account has been removed');
      if (!account) {
        const candidates = accounts
          .filter(
            (a) =>
              a.state === 'enabled' &&
              a.payloadId &&
              s.table('authPayloads').get(a.payloadId)?.verificationState === 'verified',
          )
          .map((a) => ({
            id: a.id,
            score: score(s, engine, a.id),
            active: sessions.filter((r) => r.accountId === a.id).length,
            lastSelectedAt: a.lastSelectedAt,
          }));
        const selected =
          preferred === undefined
            ? selectAccount(candidates, threshold, Date.now())
            : candidates.find((a) => a.id === (ownedAccount(s, preferred, engine)?.id ?? preferred));
        account = accounts.find((a) => a.id === selected?.id);
      }
      if (!account)
        throw new ServiceUnavailableError('No verified provider account available', 'account_unavailable');
      // A previously timed grant is never silently upgraded by a connection.
      // A new acquire after expiration is an ordinary new durable grant.
      const mode = previous?.ownershipMode ?? 'connection';
      const expiresAt = previous?.expiresAt ?? new Date(Date.now() + 300000).toISOString();
      const lease = {
        id: sessionId,
        hostId,
        engine,
        scopeId,
        accountId: account.id,
        ownershipMode: mode,
        expiresAt,
        createdAt: previous?.createdAt ?? now,
      };
      draft.upsert('providerAccountSessions', lease);
      draft.upsert('providerAccounts', { ...account, lastSelectedAt: now });
      write(async (tx) => {
        await tx.insert(providerAccountSessions).values(lease).onDuplicateKeyUpdate({ set: lease });
        await tx
          .update(providerAccounts)
          .set({ lastSelectedAt: now })
          .where(eq(providerAccounts.id, account!.id));
      });
      return {
        account,
        session_id: sessionId,
        expires_at: expiresAt,
        ownership_mode: mode,
      } as unknown as Json;
    },
  })) as unknown as {
    account: typeof providerAccounts.$inferSelect;
    session_id: string;
    expires_at: string;
    ownership_mode: string;
  };
}
export async function releaseOwnedProvider(owner: OwnerRuntime, hostId: number, engine: Engine, id: string) {
  const row = owner.state.snapshot().table('providerAccountSessions').get(id);
  if (!row || row.hostId !== hostId || row.engine !== engine) return;
  await mutateOwnerState(owner, {
    kind: 'provider.session.release',
    payload: { hostId, engine, id },
    prepare({ snapshot, draft, write }) {
      const current = snapshot.table('providerAccountSessions').get(id);
      if (!current || current.hostId !== hostId || current.engine !== engine) return null;
      draft.remove('providerAccountSessions', id);
      write((tx) => tx.delete(providerAccountSessions).where(eq(providerAccountSessions.id, id)));
      return null;
    },
  });
}
export async function drainOwnedProviders(owner: OwnerRuntime) {
  const needsWork = (s: OwnerStateSnapshot) =>
    s
      .table('providerAccountSessions')
      .all()
      .some((r) => r.ownershipMode !== 'connection' && Date.parse(r.expiresAt) <= Date.now()) ||
    s.accounts
      .all()
      .some(
        (a) => a.state === 'removing' && !s.table('providerAccountSessions').by('accountId', a.id).length,
      );
  owner.assertOwner();
  if (!needsWork(owner.state.snapshot())) return;
  await mutateOwnerState(owner, {
    kind: 'provider.sessions.drain',
    payload: {},
    prepare({ snapshot: s, draft, write }) {
      const expired = s
        .table('providerAccountSessions')
        .all()
        .filter((r) => r.ownershipMode !== 'connection' && Date.parse(r.expiresAt) <= Date.now());
      const ids = new Set(expired.map((r) => r.id));
      for (const row of expired) draft.remove('providerAccountSessions', row.id);
      if (expired.length)
        write((tx) =>
          tx.delete(providerAccountSessions).where(inArray(providerAccountSessions.id, [...ids])),
        );
      for (const a of s.accounts.all().filter(
        (a) =>
          a.state === 'removing' &&
          !s
            .table('providerAccountSessions')
            .by('accountId', a.id)
            .some((r) => !ids.has(r.id)),
      )) {
        const payloads = s.table('authPayloads').by('accountId', a.id);
        for (const p of payloads)
          draft.upsert('authPayloads', {
            ...p,
            body: null,
            verificationState: 'failed',
            verificationReason: 'account removed',
          });
        draft.upsert('providerAccounts', {
          ...a,
          state: 'removed',
          payloadId: null,
          updatedAt: new Date().toISOString(),
        });
        if (a.engine === 'grok') draft.remove('grokAuthRefreshState', a.id);
        write(async (tx) => {
          if (payloads.length)
            await tx.delete(authEntries).where(
              inArray(
                authEntries.payloadId,
                payloads.map((p) => p.id),
              ),
            );
          await tx
            .update(authPayloads)
            .set({ body: null, verificationState: 'failed', verificationReason: 'account removed' })
            .where(eq(authPayloads.accountId, a.id));
          await tx
            .update(providerAccounts)
            .set({ state: 'removed', payloadId: null, updatedAt: new Date().toISOString() })
            .where(eq(providerAccounts.id, a.id));
          if (a.engine === 'grok')
            await tx.delete(grokAuthRefreshState).where(eq(grokAuthRefreshState.accountId, a.id));
        });
      }
      return null;
    },
  });
}
