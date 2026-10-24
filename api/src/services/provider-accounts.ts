import {persistAuditLog} from './audit-log.js';
import { ownerRuntimeFor, mutateOwnerState } from '../control-plane/state/runtime.js';
import { ownedAccount, ownedProviderSession, acquireOwnedProvider, releaseOwnedProvider, drainOwnedProviders } from '../control-plane/streams/provider-leases.js';
import { readQuotaPolicy } from './quota-policy.js';
import { createHash } from 'node:crypto';
import { and, asc, count, desc, eq, gt, inArray, lte } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import {
  authCanonicalHeads,
  authEntries,
  authPayloads,
  providerAccounts,
  providerAccountSessions,
  chatgptUsageSnapshots,
  claudeUsageSnapshots,
  grokAuthRefreshState,
} from '../db/schema.js';
import type { Keyring } from '../security/keyring.js';
import { ConflictError, NotFoundError, ServiceUnavailableError, ValidationError } from '../http/errors.js';
import { nowIso } from '../util/timestamp.js';
import type { Engine } from '../util/engine.js';
import { selectGrokCredential } from './grok-auth.js';
import { credentialMetadata, inspectCredential } from './auth-generation.js';
import { quotaWindowScore, selectAccount } from './account-selection.js';
import { wsPublisher } from '../ws/publisher.js';
import { decrypt } from '../security/secret-box.js';
import { createRunnerValidationService } from './runner-validation.js';
import { resolveProviderAccount } from './provider-account-reference.js';
import { withGrokAccountLock } from './grok-auth-lock.js';
import { readGrokUsage } from './grok-usage.js';
import { chatGptPlanName, claudePlanName, providerPlan } from './provider-plan.js';

type Account = typeof providerAccounts.$inferSelect;
const PROVIDER_LABELS: Record<Engine, string> = { codex: 'ChatGPT', claude: 'Claude', grok: 'Grok' };
export function providerIdentity(auth: Record<string, unknown>, engine: Engine): string | null {
  const tokens = auth.tokens as Record<string, unknown> | undefined;
  const value = engine === 'codex' ? tokens?.account_id : engine === 'grok' ? selectGrokCredential(auth, true)?.native.user_id : auth.account_identity;
  return typeof value === 'string' && value.trim()
    ? createHash('sha256').update(`${engine}:${value.trim()}`).digest('hex')
    : null;
}

export class ProviderAccountsService {
  constructor(
    private readonly db: Database,
    private readonly keyring: Keyring,
  ) {}

  async get(id: number, engine?: Engine): Promise<Account> {
    const owner = ownerRuntimeFor(this.db);
    const account = owner ? (owner.assertOwner(), ownedAccount(owner.state.snapshot(), id, engine)) : await resolveProviderAccount(this.db, id, engine);
    if (!account) throw new NotFoundError('Provider account not found');
    return account;
  }

  async canonicalId(id: number, engine: Engine): Promise<number> {
    const owner = ownerRuntimeFor(this.db);
    return (owner ? (owner.assertOwner(), ownedAccount(owner.state.snapshot(), id, engine)) : await resolveProviderAccount(this.db, id, engine))?.id ?? id;
  }

  async resolveCandidate(
    auth: Record<string, unknown>,
    engine: Engine,
    target?: number,
    sourceHostId?: number | null,
    targetIsHint = false,
    enrollAccount = false,
  ): Promise<Account> {
    const owner=ownerRuntimeFor(this.db);owner?.assertOwner();
    const identity = inspectCredential(auth, engine);
    if (!identity) throw new ValidationError('payload contains no usable auth tokens');
    const identityKey = providerIdentity(auth, engine);
    let accounts = (
      owner ? owner.state.snapshot().accounts.by('engine',engine) : await this.db.select().from(providerAccounts).where(eq(providerAccounts.engine, engine))
    ).filter((a) => !a.mergedIntoAccountId);
    // A legacy head can be backfilled after schema migration on fresh installs.
    if (!accounts.length) {
      const legacy = await createRunnerValidationService({
        db: this.db,
        keyring: this.keyring,
      }).resolveCanonicalPayload(engine);
      if (legacy && !legacy.accountId) {
        const now = nowIso();
        if(owner){
          await this.createOwnedAccount(engine,null,legacy.id,legacy.generation??null,`${PROVIDER_LABELS[engine]} 1`);
          accounts=owner.state.snapshot().accounts.by('engine',engine).filter(a=>!a.mergedIntoAccountId);
        } else {
        await this.db.insert(providerAccounts).values({
          engine,
          state: 'enabled',
          label: `${PROVIDER_LABELS[engine]} 1`,
          payloadId: legacy.id,
          generation: legacy.generation,
          createdAt: now,
          updatedAt: now,
        });
        accounts = await this.db.select().from(providerAccounts).where(eq(providerAccounts.engine, engine));
        await this.db
          .update(authPayloads)
          .set({ accountId: accounts[0]!.id })
          .where(eq(authPayloads.id, legacy.id));
        const heads = await this.db
          .select()
          .from(authCanonicalHeads)
          .where(eq(authCanonicalHeads.engine, engine));
        if (!heads.length)
          await this.db
            .insert(authCanonicalHeads)
            .values({ engine, payloadId: legacy.id, generation: legacy.generation ?? 0, updatedAt: now });
        }
      }
    }
    const metadataRows=owner?.state.snapshot().table('authPayloads').by('engine',engine);
    // Credential material is cold, read only for this explicit credential mutation.
    const bodies=owner ? await this.db.select({id:authPayloads.id,body:authPayloads.body}).from(authPayloads).where(eq(authPayloads.engine,engine)) : null;
    const history=metadataRows ? metadataRows.map(row=>({...row,body:bodies?.find(b=>b.id===row.id)?.body??null})) : await this.db.select().from(authPayloads).where(eq(authPayloads.engine,engine));
    const accountIdentity = (a: Account): string | null => {
      if (a.identityKey && !a.identityKey.startsWith('credential:')) return a.identityKey;
      const head = history.find((r) => r.id === a.payloadId);
      try {
        return head?.body ? providerIdentity(JSON.parse(decrypt(head.body, this.keyring)), engine) : null;
      } catch {
        return null;
      }
    };
    const metadata = this.keyring.all().map((k) => credentialMetadata(identity, k));
    const matches = history.filter((r) => {
      if (
        metadata.some(
          (m) =>
            m.fingerprintKid === r.fingerprintKid &&
            (m.accessFingerprint === r.accessFingerprint ||
              (m.refreshFingerprint !== null && m.refreshFingerprint === r.refreshFingerprint)),
        )
      )
        return true;
      if (r.fingerprintKid || !r.body) return false;
      try {
        const old = inspectCredential(JSON.parse(decrypt(r.body, this.keyring)), engine);
        return (
          !!old &&
          (old.access === identity.access || (!!identity.refresh && old.refresh === identity.refresh))
        );
      } catch {
        return false;
      }
    });
    // Pre-migration history is deliberately unassigned. Prefer an attributed
    // occurrence of the same credential over an older unassigned login.
    const matched =
      matches.find((r) => accounts.some((a) => a.id === r.accountId || a.payloadId === r.id)) ?? matches[0];
    const key =
      identityKey ?? `credential:${credentialMetadata(identity, this.keyring.active()).pairFingerprint}`;
    // Migrated heads have no identity_key yet. Their native identity still
    // identifies the same subscription across a completely new login.
    let account = identityKey ? accounts.find((a) => accountIdentity(a) === identityKey) : undefined;
    account ??= accounts.find((a) => a.id === matched?.accountId || a.payloadId === matched?.id);
    account ??= accounts.find((a) => a.identityKey === key);
    if (target !== undefined) {
      const requested = await this.get(target, engine);
      const requestedIdentity = accountIdentity(requested);
      const different =
        (account && account.id !== requested.id) ||
        (identityKey && requestedIdentity && identityKey !== requestedIdentity);
      if (different && !targetIsHint) {
        throw new ConflictError('Credentials belong to a different account', 'account_identity_mismatch');
      }
      if (!different) account = requested;
    }
    if (!account && !enrollAccount) {
      const existing = accounts.filter((a) => a.state !== 'removed' && a.state !== 'removing');
      // OAuth tokens identify a login/rotation, not a provider account. With
      // no contrary provider identity, the only account owns this upload.
      if (
        existing.length === 1 &&
        (!identityKey || !accountIdentity(existing[0]!) || accountIdentity(existing[0]!) === identityKey)
      )
        account = existing[0];
      else if (!identityKey && existing.length > 1)
        throw new ConflictError(
          'Opaque credentials require an account assignment; use Add account to enroll another account',
          'account_assignment_required',
        );
    }
    if (!account && matched?.supersededAt)
      throw new ConflictError(
        'Historical credentials cannot enroll a new account',
        'account_history_unassigned',
      );
    if (account) {
      if (account.state === 'removed') throw new ConflictError('Account is retired', 'account_removed');
      if (account.state === 'removing') {
        const live =
          sourceHostId == null
            ? []
            : owner ? owner.state.snapshot().table('providerAccountSessions').by('accountId',account.id).filter(r=>r.hostId===sourceHostId&&(r.ownershipMode==='connection'||r.expiresAt>nowIso())) : await this.db
                .select()
                .from(providerAccountSessions)
                .where(
                  and(
                    eq(providerAccountSessions.accountId, account.id),
                    eq(providerAccountSessions.hostId, sourceHostId),
                    gt(providerAccountSessions.expiresAt, nowIso()),
                  ),
                );
        if (!live.length) throw new ConflictError('Account is retired', 'account_removed');
      }
      if (identityKey && (!account.identityKey || account.identityKey.startsWith('credential:'))) {
        if(owner){const id=account.id;await mutateOwnerState(owner,{kind:'provider.account.identify',payload:{id,identityKey},prepare({snapshot,draft,write}){
          const current=snapshot.accounts.get(id);if(!current||current.state==='removed')throw new ConflictError('Account is retired','account_removed');
          if(current.identityKey&&!current.identityKey.startsWith('credential:')&&current.identityKey!==identityKey)throw new ConflictError('Account identity changed','account_identity_mismatch');
          const updatedAt=nowIso();draft.upsert('providerAccounts',{...current,identityKey,updatedAt});write(tx=>tx.update(providerAccounts).set({identityKey,updatedAt}).where(eq(providerAccounts.id,id)));return null;
        }});}else await this.db.update(providerAccounts).set({identityKey,updatedAt:nowIso()}).where(eq(providerAccounts.id,account.id));
      }
      return account;
    }
    if(owner)return this.createOwnedAccount(engine,key,null,null,`${PROVIDER_LABELS[engine]} account`);
    const now = nowIso();
    await this.db
      .insert(providerAccounts)
      .values({
        engine,
        state: 'enabled',
        payloadId: null,
        generation: null,
        lastSelectedAt: null,
        label: `${PROVIDER_LABELS[engine]} account`,
        identityKey: key,
        createdAt: now,
        updatedAt: now,
      })
      .onDuplicateKeyUpdate({ set: { identityKey: key } });
    const rows = await this.db
      .select()
      .from(providerAccounts)
      .where(and(eq(providerAccounts.engine, engine), eq(providerAccounts.identityKey, key)));
    const created = rows[0]!;
    if (created.state === 'removed' || created.state === 'removing')
      throw new ConflictError('Account is retired', 'account_removed');
    return created;
  }

  private async createOwnedAccount(engine:Engine,identityKey:string|null,payloadId:number|null,generation:number|null,label:string):Promise<Account>{
    const owner=ownerRuntimeFor(this.db)!;
    const result=await mutateOwnerState(owner,{kind:'provider.account.enroll',payload:{engine,identityKey,payloadId,generation,label},prepare({snapshot,draft,write}){
      const duplicate=snapshot.accounts.by('engine',engine).find(a=>identityKey?a.identityKey===identityKey:!a.mergedIntoAccountId);
      if(duplicate){if(['removed','removing'].includes(duplicate.state))throw new ConflictError('Account is retired','account_removed');return {id:duplicate.id};}
      const now=nowIso();const values={engine,label,identityKey,mergedIntoAccountId:null,state:'enabled',payloadId,generation,lastSelectedAt:null,createdAt:now,updatedAt:now};
      let id=0;write(async tx=>{
        const inserted=await tx.insert(providerAccounts).values(values).$returningId();id=Number(inserted[0]?.id);if(!id)throw new Error('Account insert returned no identity');draft.upsert('providerAccounts',{...values,id});
        if(payloadId!==null){
          const payload=snapshot.table('authPayloads').get(payloadId);if(!payload||payload.engine!==engine||payload.accountId!==null)throw new ConflictError('Legacy credential changed');
          await tx.update(authPayloads).set({accountId:id}).where(eq(authPayloads.id,payloadId));draft.upsert('authPayloads',{...payload,accountId:id});
          if(!snapshot.table('authCanonicalHeads').has(engine)){const head={engine,payloadId,generation:generation??0,updatedAt:now};await tx.insert(authCanonicalHeads).values(head);draft.upsert('authCanonicalHeads',head);}
        }
      });return ()=>({id});
    }});
    return this.get((result as {id:number}).id,engine);
  }

  async list(engine?: Engine) {
    await this.drainRemoved();
    const owner=ownerRuntimeFor(this.db); owner?.assertOwner();
    const accounts = owner ? owner.state.snapshot().accounts.all().filter(a=>!engine||a.engine===engine).sort((a,b)=>a.id-b.id) : await this.db
      .select()
      .from(providerAccounts)
      .where(engine ? eq(providerAccounts.engine, engine) : undefined)
      .orderBy(asc(providerAccounts.id));
    const now = nowIso();
    const sessions = owner ? owner.state.snapshot().table('providerAccountSessions').all().filter(r=>r.ownershipMode==='connection'||r.expiresAt>now) : await this.db
      .select()
      .from(providerAccountSessions)
      .where(gt(providerAccountSessions.expiresAt, now));
    return Promise.all(
      accounts
        .filter((a) => a.state !== 'removed')
        .map(async (a) => {
          const payload = owner ? (a.payloadId ? owner.state.snapshot().table('authPayloads').get(a.payloadId) : [...owner.state.snapshot().table('authPayloads').by('accountId',a.id)].sort((a,b)=>b.id-a.id)[0]) : a.payloadId
            ? (await this.db.select().from(authPayloads).where(eq(authPayloads.id, a.payloadId)))[0]
            : (
                await this.db
                  .select()
                  .from(authPayloads)
                  .where(eq(authPayloads.accountId, a.id))
                  .orderBy(desc(authPayloads.id))
                  .limit(1)
              )[0];
          const usage = await this.usage(a.id, a.engine as Engine);
          let plan = 'plan' in usage ? usage.plan : providerPlan(null, 'claude_login', null);
          const body = a.engine === 'claude' && payload?.verificationState === 'verified' ? owner ? (await this.db.select({body:authPayloads.body}).from(authPayloads).where(eq(authPayloads.id,payload.id)))[0]?.body : ('body' in payload ? payload.body : null) : null;
          if (a.engine === 'claude' && payload?.verificationState === 'verified' && typeof body === 'string' && body) {
            try {
              plan = providerPlan(claudePlanName(JSON.parse(decrypt(body, this.keyring))), 'claude_login', payload.createdAt);
            } catch { /* Unreadable metadata stays unavailable; account listing still works. */ }
          }
          const refresh = a.engine === 'grok' ? owner ? owner.state.snapshot().table('grokAuthRefreshState').get(a.id) : (await this.db.select().from(grokAuthRefreshState).where(eq(grokAuthRefreshState.accountId, a.id)))[0] : null;
          return {
            id: a.id,
            engine: a.engine,
            label: a.label,
            state: a.state,
            ...(a.engine === 'grok' ? { refresh_state: refresh?.state ?? 'idle', refresh_error: refresh?.errorCode ?? null } : {}),
            verification_state: payload?.verificationState ?? 'pending',
            verification_reason: payload?.verificationReason ?? null,
            verification_checked_at: payload?.verificationCheckedAt ?? null,
            generation: a.generation,
            created_at: a.createdAt,
            updated_at: a.updatedAt,
            last_selected_at: a.lastSelectedAt,
            usage,
            quota_policy: (await readQuotaPolicy(this.db, a.engine as Engine, a.id)).effective,
            plan,
            sessions: sessions
              .filter((s) => s.accountId === a.id)
              .map((s) => ({ id: s.id, host_id: s.hostId, expires_at: s.expiresAt })),
          };
        }),
    );
  }

  async usage(accountId: number, engine: Engine, reader: Pick<Database, 'select'> = this.db) {
    const now = Date.now();
    const owner = ownerRuntimeFor(reader); owner?.assertOwner();
    if (engine === 'grok') return readGrokUsage(reader, accountId);
    if (engine === 'claude') {
      const rows = owner ? [...owner.state.snapshot().table('claudeUsageSnapshots').by('accountId',accountId)].sort((a,b)=>b.id-a.id).slice(0,1) : await reader
        .select()
        .from(claudeUsageSnapshots)
        .where(eq(claudeUsageSnapshots.accountId, accountId))
        .orderBy(desc(claudeUsageSnapshots.id))
        .limit(1);
      const r = rows[0];
      return {
        fetched_at: r?.fetchedAt ?? null,
        stale: !r || now - Date.parse(r.fetchedAt) > 600_000,
        short_used_percent: r?.fiveHourUsedPercent ?? null,
        short_resets_at: r?.fiveHourResetsAt ?? null,
        short_limit_seconds: r?.fiveHourUsedPercent != null ? 18000 : null,
        weekly_used_percent: r?.sevenDayUsedPercent ?? null,
        weekly_resets_at: r?.sevenDayResetsAt ?? null,
        weekly_limit_seconds: r?.sevenDayUsedPercent != null ? 604800 : null,
      };
    }
    const rows = owner ? [...owner.state.snapshot().table('chatgptUsageSnapshots').by('accountId',accountId)].filter(r=>r.status==='ok').sort((a,b)=>b.id-a.id).slice(0,1) : await reader
      .select()
      .from(chatgptUsageSnapshots)
      .where(and(eq(chatgptUsageSnapshots.accountId, accountId), eq(chatgptUsageSnapshots.status, 'ok')))
      .orderBy(desc(chatgptUsageSnapshots.id))
      .limit(1);
    const r = rows[0];
    // Provider slots can swap meaning or disappear. Keep each reading with
    // its own duration; a second weekly window must never become "short".
    const windows = [
      { used: r?.primaryUsedPercent, reset: r?.primaryResetAt, limit: r?.primaryLimitSeconds },
      { used: r?.secondaryUsedPercent, reset: r?.secondaryResetAt, limit: r?.secondaryLimitSeconds },
    ];
    const short = windows.find((window) => window.used != null && (window.limit ?? 0) < 604800);
    const weekly = windows.find((window) => window.used != null && (window.limit ?? 0) >= 604800);
    return {
      fetched_at: r?.fetchedAt ?? null,
      stale: !r || now - Date.parse(r.fetchedAt) > 600_000,
      plan: providerPlan(chatGptPlanName(r?.planType), 'chatgpt_usage', r?.fetchedAt),
      short_used_percent: short?.used ?? null,
      short_resets_at: short?.reset ?? null,
      short_limit_seconds: short?.limit ?? null,
      weekly_used_percent: weekly?.used ?? null,
      weekly_resets_at: weekly?.reset ?? null,
      weekly_limit_seconds: weekly?.limit ?? null,
    };
  }

  /**
   * Accounts a new lease could choose, with no reservation, refresh or credential
   * read: the candidate filter of `acquire` (enabled, with a verified payload).
   * Quota only ranks those candidates, it never empties the set.
   */
  async countLeasable(engine: Engine): Promise<number> {
    const owner = ownerRuntimeFor(this.db);
    if (owner) { owner.assertOwner(); const s=owner.state.snapshot(); return s.accounts.by('engine',engine).filter(a=>a.state==='enabled'&&a.payloadId&&s.table('authPayloads').get(a.payloadId)?.verificationState==='verified').length; }
    const [row] = await this.db
      .select({ leasable: count() })
      .from(providerAccounts)
      .innerJoin(authPayloads, eq(authPayloads.id, providerAccounts.payloadId))
      .where(
        and(
          eq(providerAccounts.engine, engine),
          eq(providerAccounts.state, 'enabled'),
          eq(authPayloads.verificationState, 'verified'),
        ),
      );
    return Number(row?.leasable ?? 0);
  }

  async acquire(
    hostId: number,
    engine: Engine,
    scopeId: string,
    sessionId: string,
    threshold: number,
    preferred?: number,
    ownershipMode: 'timed' | 'connection' = 'connection',
  ) {
    const owner = ownerRuntimeFor(this.db);
    if (owner) { await drainOwnedProviders(owner); return acquireOwnedProvider(owner,hostId,engine,scopeId,sessionId,threshold,preferred,ownershipMode); }
    if (preferred !== undefined) preferred = await this.canonicalId(preferred, engine);
    await this.drainRemoved();
    return this.db.transaction(async (tx) => {
      // Lock a stable row for this host/engine/scope. Account rows serialize
      // selection and reservation across API processes, not just one instance.
      const accounts = await tx
        .select()
        .from(providerAccounts)
        .where(eq(providerAccounts.engine, engine))
        .orderBy(asc(providerAccounts.id))
        .for('update');
      const now = nowIso();
      const sessions = await tx
        .select()
        .from(providerAccountSessions)
        .where(gt(providerAccountSessions.expiresAt, now));
      const previous = sessions.find((s) => s.id === sessionId);
      if (
        previous &&
        (previous.hostId !== hostId || previous.engine !== engine || previous.scopeId !== scopeId)
      )
        throw new ConflictError('Session ID already in use');
      const pinned =
        previous ?? sessions.find((s) => s.hostId === hostId && s.engine === engine && s.scopeId === scopeId);
      let account = pinned ? accounts.find((a) => a.id === pinned.accountId) : undefined;
      if (account?.state === 'removed') throw new ConflictError('Account has been removed');
      if (!account) {
        const candidates = [];
        for (const a of accounts.filter((r) => r.state === 'enabled')) {
          if (!a.payloadId) continue;
          const row = (await tx.select().from(authPayloads).where(eq(authPayloads.id, a.payloadId)))[0];
          if (row?.verificationState !== 'verified') continue;
          const usage = await this.usage(a.id, engine, tx);
          const unlimited = (await readQuotaPolicy(tx, engine, a.id)).effective.unlimited;
          const scores = [
            quotaWindowScore(usage.short_used_percent, usage.short_resets_at, Date.now()),
            quotaWindowScore(usage.weekly_used_percent, usage.weekly_resets_at, Date.now()),
          ].filter((x): x is number => x !== null);
          candidates.push({
            id: a.id,
            score: unlimited ? 0 : scores.length ? Math.max(...scores) : null,
            active: sessions.filter((s) => s.accountId === a.id).length,
            lastSelectedAt: a.lastSelectedAt,
          });
        }
        const chosen =
          preferred !== undefined
            ? candidates.find((a) => a.id === preferred)
            : selectAccount(candidates, threshold, Date.now());
        account = accounts.find((a) => a.id === chosen?.id);
      }
      if (!account)
        throw new ServiceUnavailableError(
          `No verified ${PROVIDER_LABELS[engine]} account available`,
          'account_unavailable',
        );
      const expiresAt = new Date(Date.now() + 300_000).toISOString();
      await tx
        .insert(providerAccountSessions)
        .values({ id: sessionId, hostId, engine, scopeId, accountId: account.id, expiresAt, createdAt: now })
        .onDuplicateKeyUpdate({ set: { expiresAt } });
      await tx
        .update(providerAccounts)
        .set({ lastSelectedAt: now })
        .where(eq(providerAccounts.id, account.id));
      return { account, session_id: sessionId, expires_at: expiresAt };
    });
  }

  async session(hostId: number, engine: Engine, id: string) {
    const owner = ownerRuntimeFor(this.db); if(owner)return ownedProviderSession(owner,hostId,engine,id);
    const row = (
      await this.db
        .select()
        .from(providerAccountSessions)
        .where(
          and(
            eq(providerAccountSessions.id, id),
            eq(providerAccountSessions.hostId, hostId),
            eq(providerAccountSessions.engine, engine),
          ),
        )
    )[0];
    if (!row || row.expiresAt <= nowIso()) throw new NotFoundError('Account session not found');
    return row;
  }

  async heartbeat(hostId: number, engine: Engine, id: string) {
    const session = await this.session(hostId, engine, id);
    const account = await this.get(session.accountId, engine);
    if (account.state === 'removed') throw new ConflictError('Account removed');
    const owner = ownerRuntimeFor(this.db);
    if(owner && session.ownershipMode==='connection')return {account_id:session.accountId,expires_at:session.expiresAt};
    const expiresAt = new Date(Date.now() + 300_000).toISOString();
    if(owner){
      await mutateOwnerState(owner,{kind:'provider.session.renew',payload:{hostId,engine,id},prepare({snapshot,draft,write}){
        const current=snapshot.table('providerAccountSessions').get(id);
        if(!current||current.hostId!==hostId||current.engine!==engine||Date.parse(current.expiresAt)<=Date.now())throw new NotFoundError('Account session not found');
        draft.upsert('providerAccountSessions',{...current,expiresAt});write(tx=>tx.update(providerAccountSessions).set({expiresAt}).where(eq(providerAccountSessions.id,id)));return null;
      }});return {account_id:session.accountId,expires_at:expiresAt};
    }
    await this.db
      .update(providerAccountSessions)
      .set({ expiresAt })
      .where(and(eq(providerAccountSessions.id, id), eq(providerAccountSessions.hostId, hostId), eq(providerAccountSessions.engine, engine), gt(providerAccountSessions.expiresAt, nowIso())));
    if (engine === 'grok') await this.session(hostId, engine, id);
    return { account_id: session.accountId, expires_at: expiresAt };
  }

  async release(hostId: number, engine: Engine, id: string) {
    const owner=ownerRuntimeFor(this.db);if(owner){await releaseOwnedProvider(owner,hostId,engine,id);await drainOwnedProviders(owner);return;}
    await this.db
      .delete(providerAccountSessions)
      .where(
        and(
          eq(providerAccountSessions.id, id),
          eq(providerAccountSessions.hostId, hostId),
          eq(providerAccountSessions.engine, engine),
        ),
      );
    await this.drainRemoved();
  }

  async update(id: number, changes: { label?: string; state?: 'enabled' | 'paused' | 'removing' }) {
    const owner=ownerRuntimeFor(this.db);
    if(owner){
      await mutateOwnerState(owner,{kind:'provider.account.update',payload:{id,...changes},prepare({snapshot,draft,write}){
        const account=ownedAccount(snapshot,id);if(!account)throw new NotFoundError('Provider account not found');
        if(account.state==='removed'||account.state==='removing')throw new ConflictError('Account is being removed');
        const now=nowIso();draft.upsert('providerAccounts',{...account,...changes,updatedAt:now});
        write(async tx=>{await tx.update(providerAccounts).set({...changes,updatedAt:now}).where(eq(providerAccounts.id,account.id));await persistAuditLog(tx, {action:'account.updated',details:JSON.stringify({account_id:account.id,...changes}),createdAt:now});});return null;
      }});await this.drainRemoved();wsPublisher.publish('accounts.updated',{account_id:id});return;
    }
    const account = await this.get(id);
    if (account.state === 'removed' || account.state === 'removing')
      throw new ConflictError('Account is being removed');
    await this.db
      .update(providerAccounts)
      .set({ ...changes, updatedAt: nowIso() })
      .where(eq(providerAccounts.id, id));
    await persistAuditLog(this.db, {
      action: 'account.updated',
      details: JSON.stringify({ account_id: id, ...changes }),
      createdAt: nowIso(),
    });
    await this.drainRemoved();
    wsPublisher.publish('accounts.updated', { account_id: id });
  }

  async drainRemoved() {
    const owner=ownerRuntimeFor(this.db);if(owner)return drainOwnedProviders(owner);
    // Expiration cleanup must finish before taking any account row lock. The
    // reverse order deadlocks with concurrent account->session reservations.
    await this.db.delete(providerAccountSessions).where(and(eq(providerAccountSessions.ownershipMode, 'timed'), lte(providerAccountSessions.expiresAt, nowIso())));
    const candidates = await this.db
      .select()
      .from(providerAccounts)
      .where(eq(providerAccounts.state, 'removing'));
    if (!candidates.length) return;
    const drain = async (db: Database, candidates: Account[]) => db.transaction(async (tx) => {
      const removing = await tx
        .select()
        .from(providerAccounts)
        .where(
          inArray(
            providerAccounts.id,
            candidates.map((a) => a.id),
          ),
        )
        .orderBy(asc(providerAccounts.id))
        .for('update');
      for (const a of removing) {
        if (a.state !== 'removing') continue;
        const sessions = await tx
          .select()
          .from(providerAccountSessions)
          .where(eq(providerAccountSessions.accountId, a.id));
        if (sessions.length) continue;
        const payloads = await tx
          .select({ id: authPayloads.id })
          .from(authPayloads)
          .where(eq(authPayloads.accountId, a.id));
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
          .set({ state: 'removed', payloadId: null, updatedAt: nowIso() })
          .where(eq(providerAccounts.id, a.id));
        if (a.engine === 'grok') await tx.delete(grokAuthRefreshState).where(eq(grokAuthRefreshState.accountId, a.id));
        // Leave the legacy pointer as a tombstone, never resurrect old history.
      }
    });
    for (const account of candidates.filter(a => a.engine === 'grok')) {
      await withGrokAccountLock(this.db, account.id, owner => drain(owner.db, [account]));
    }
    const otherAccounts = candidates.filter(a => a.engine !== 'grok');
    if (otherAccounts.length) await drain(this.db, otherAccounts);
  }
}
