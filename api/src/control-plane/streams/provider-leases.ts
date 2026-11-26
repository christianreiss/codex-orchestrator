import { assertEmulationAdmission } from '../../services/quota-emulation.js';
import { eq, inArray } from 'drizzle-orm';
import {
  providerAccountSessions,
  providerAccounts,
  authPayloads,
  authEntries,
  grokAuthRefreshState,
  kimiAuthRefreshState,
} from '../../db/schema.js';
import type { OwnerRuntime } from '../state/runtime.js';
import { mutateOwnerState } from '../state/runtime.js';
import { ownerPresence } from '../presence.js';
import type { OwnerStateSnapshot } from '../state/store.js';
import { ConflictError, NotFoundError, ServiceUnavailableError } from '../../http/errors.js';
import { quotaWindowScore } from '../../services/account-selection.js';
import { accountPolicyKey, parseStoredPolicy, selectForLaunch } from '../../services/account-policy.js';
import { DEFAULT_QUOTA_POLICY, quotaPolicySchema } from '../../services/quota-policy.js';
import type { Engine } from '../../util/engine.js';
import type { Json } from '../commands.js';

/**
 * The binding generation of a scope without a live lease. A scope's rows are
 * deleted with its last lease, so nothing remembers the generation it had; a
 * wrapper does (its binding file) and ignores every answer below the number it
 * knows. Counting again from 1 therefore cut a re-reserved session off from
 * all later directives. Seconds since the epoch exceed any generation the
 * scope had before, since a scope cannot switch more than once a second, and
 * fit the unsigned 32-bit column until 2106.
 */
export function freshBindingGeneration(now: number = Date.now()): number {
  return Math.floor(now / 1000);
}

/** How long a connection-owned lease outlives its provider attachment. */
export const DETACHED_LEASE_GRACE_MS = 5 * 60_000;
/** When each attachment was first seen missing. In memory only: absence counts from this owner's boot. */
const detachedSince = new WeakMap<OwnerRuntime, Map<string, number>>();
/**
 * When the holder of a connection-owned lease last renewed it by heartbeat. A
 * wrapper that does so also takes back a lease it finds missing (heartbeat
 * 404, cxx 0.9.207 and later); an older one only redials its attachment and
 * would run on without a lease, its token uploads refused. In memory only.
 */
const renewedByHolder = new WeakMap<OwnerRuntime, Map<string, number>>();

export function noteProviderRenewal(owner: OwnerRuntime, id: string, at: number = Date.now()): void {
  const renewed = renewedByHolder.get(owner) ?? new Map<string, number>();
  renewedByHolder.set(owner, renewed);
  renewed.set(id, at);
}

/**
 * Removes leases nothing holds any more: connection-owned host leases of the
 * given engines that have had neither a provider attachment nor a heartbeat
 * for the grace period (the wrapper was killed or its host went down, so it
 * never released), and leases of any engine whose host was deleted.
 *
 * A lease is removed for absence only once its holder has shown that it can
 * take the lease back (`noteProviderRenewal`): a suspended laptop returns after
 * the grace period and must be able to recover. Internal leases (host 0: AI
 * assist, chat inference) have no attachment at all and end with their task.
 * Returns the removed ids.
 */
export async function reapAbandonedProviders(
  owner: OwnerRuntime,
  engines: ReadonlySet<string>,
  now: number = Date.now(),
): Promise<string[]> {
  owner.assertOwner();
  const presence = ownerPresence(owner);
  const seen = detachedSince.get(owner) ?? new Map<string, number>();
  detachedSince.set(owner, seen);
  const renewed = renewedByHolder.get(owner) ?? new Map<string, number>();
  renewedByHolder.set(owner, renewed);
  const state = owner.state.snapshot();
  const rows = state.table('providerAccountSessions').all();
  const ids = new Set(rows.map((r) => r.id));
  for (const id of seen.keys()) if (!ids.has(id)) seen.delete(id);
  for (const id of renewed.keys()) if (!ids.has(id)) renewed.delete(id);
  const due = new Set<string>();
  for (const row of rows) {
    if (row.hostId > 0 && !state.table('hosts').get(row.hostId)) {
      due.add(row.id);
      continue;
    }
    const renewal = renewed.get(row.id);
    if (
      row.hostId <= 0 ||
      row.ownershipMode !== 'connection' ||
      !engines.has(row.engine) ||
      renewal === undefined ||
      presence.hasProvider(row.id)
    ) {
      seen.delete(row.id);
      continue;
    }
    const since = seen.get(row.id) ?? now;
    seen.set(row.id, since);
    // A heartbeat is a sign of life too: the attachment can be down while HTTP still works.
    if (now - Math.max(since, renewal) >= DETACHED_LEASE_GRACE_MS) due.add(row.id);
  }
  if (!due.size) return [];
  const removed: string[] = [];
  await mutateOwnerState(owner, {
    kind: 'provider.sessions.reap',
    payload: { ids: [...due] },
    prepare({ snapshot: s, draft, write }) {
      removed.length = 0;
      // Presence is read again inside the mutation: an attachment that came
      // back meanwhile keeps its lease.
      for (const id of due) {
        const row = s.table('providerAccountSessions').get(id);
        if (!row) continue;
        const hostGone = row.hostId > 0 && !s.table('hosts').get(row.hostId);
        const alive = presence.hasProvider(id) || now - (renewed.get(id) ?? 0) < DETACHED_LEASE_GRACE_MS;
        if (!hostGone && alive) continue;
        draft.remove('providerAccountSessions', id);
        removed.push(id);
      }
      if (removed.length)
        write((tx) => tx.delete(providerAccountSessions).where(inArray(providerAccountSessions.id, [...removed])));
      return null;
    },
  });
  for (const id of removed) {
    seen.delete(id);
    renewed.delete(id);
  }
  return removed;
}

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
/** Quota position of an account for selection: the score and the weekly reset the policy may race. */
function position(s: OwnerStateSnapshot, engine: Engine, id: number): { score: number | null; weeklyResetsAt: string | null } {
  // Unlimited quota never expires, so it has no reset to race.
  if (unlimited(s, engine, id)) return { score: 0, weeklyResetsAt: null };
  const now = Date.now();
  if (engine === 'grok') return { score: null, weeklyResetsAt: null }; // Grok usage is display-only, as in existing selection.
  let values: Array<number | null>;
  let weeklyResetsAt: string | null;
  if (engine === 'kimi') {
    const r = s.table('kimiUsageSnapshots').get(id);
    values = r?.errorCode ? [] : [quotaWindowScore(r?.fiveHourUsedPercent ?? null, r?.fiveHourResetsAt ?? null, now), quotaWindowScore(r?.weeklyUsedPercent ?? null, r?.weeklyResetsAt ?? null, now)];
    weeklyResetsAt = r?.errorCode ? null : (r?.weeklyResetsAt ?? null);
  } else if (engine === 'claude') {
    const r = [...s.table('claudeUsageSnapshots').by('accountId', id)].sort((a, b) => b.id - a.id)[0];
    values = [
      quotaWindowScore(r?.fiveHourUsedPercent ?? null, r?.fiveHourResetsAt ?? null, now),
      quotaWindowScore(r?.sevenDayUsedPercent ?? null, r?.sevenDayResetsAt ?? null, now),
    ];
    weeklyResetsAt = r?.sevenDayResetsAt ?? null;
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
    weeklyResetsAt = weekly?.reset ?? null;
  }
  const present = values.filter((x): x is number => x !== null);
  return { score: present.length ? Math.max(...present) : null, weeklyResetsAt };
}
export async function acquireOwnedProvider(
  owner: OwnerRuntime,
  hostId: number,
  engine: Engine,
  scopeId: string,
  sessionId: string,
  threshold: number,
  preferred?: number,
  ownershipMode: 'timed' | 'connection' = 'connection',
) {
  return (await mutateOwnerState(owner, {
    kind: 'provider.session.acquire',
    payload: { hostId, engine, scopeId, sessionId, threshold, preferred: preferred ?? null, ownershipMode },
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
            ...position(s, engine, a.id),
            active: sessions.filter((r) => r.accountId === a.id).length,
            lastSelectedAt: a.lastSelectedAt,
          }));
        // A pool only refuses a launch when every account is blocked by its
        // emulated budget; blocked accounts are skipped while others remain.
        const admitted = candidates.filter((a) => {
          try {
            assertEmulationAdmission(s, engine, a.id);
            return true;
          } catch {
            return false;
          }
        });
        const policy = parseStoredPolicy(s.setting(accountPolicyKey(engine)));
        const selected =
          preferred === undefined
            ? selectForLaunch(policy, admitted.length ? admitted : candidates, threshold, Date.now())
            : candidates.find((a) => a.id === (ownedAccount(s, preferred, engine)?.id ?? preferred));
        account = accounts.find((a) => a.id === selected?.id);
      }
      if (!account)
        throw new ServiceUnavailableError('No verified provider account available', 'account_unavailable');
      assertEmulationAdmission(s, engine, account.id);
      // A previously timed grant is never silently upgraded by a connection.
      // A new acquire after expiration is an ordinary new durable grant.
      const mode = previous?.ownershipMode ?? ownershipMode;
      const expiresAt = previous?.expiresAt ?? new Date(Date.now() + 300000).toISOString();
      // A lease joining a live scope inherits its binding generation and any
      // pending switch; a new scope starts at a generation above any it had.
      const scope = previous ?? pinned;
      const lease = {
        id: sessionId,
        hostId,
        engine,
        scopeId,
        accountId: account.id,
        ownershipMode: mode,
        expiresAt,
        createdAt: previous?.createdAt ?? now,
        bindingGeneration: scope?.bindingGeneration ?? freshBindingGeneration(),
        desiredAccountId: scope?.desiredAccountId ?? null,
        desiredReason: scope?.desiredReason ?? null,
        desiredAt: scope?.desiredAt ?? null,
        boundAt: scope?.boundAt ?? now,
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
        if (a.engine === 'kimi') draft.remove('kimiAuthRefreshState', a.id);
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
          if (a.engine === 'kimi') await tx.delete(kimiAuthRefreshState).where(eq(kimiAuthRefreshState.accountId, a.id));
          if (a.engine === 'grok')
            await tx.delete(grokAuthRefreshState).where(eq(grokAuthRefreshState.accountId, a.id));
        });
      }
      return null;
    },
  });
}
