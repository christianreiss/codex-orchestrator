import { quotaSnapshot } from './quota-observation.js';
import { emulationBlocks, emulationLimitError } from './quota-emulation.js';
import {persistAuditLog} from './audit-log.js';
import { ownerRuntimeFor, mutateOwnerState } from '../control-plane/state/runtime.js';
import { ownedAccount, ownedProviderSession, acquireOwnedProvider, releaseOwnedProvider, drainOwnedProviders, freshBindingGeneration } from '../control-plane/streams/provider-leases.js';
import { readQuotaPolicy } from './quota-policy.js';
import { createHash } from 'node:crypto';
import { and, asc, count, desc, eq, gt, inArray, isNotNull, lte } from 'drizzle-orm';
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
  kimiAuthRefreshState,
} from '../db/schema.js';
import type { Keyring } from '../security/keyring.js';
import { ConflictError, ForbiddenError, NotFoundError, ServiceUnavailableError, ValidationError } from '../http/errors.js';
import { nowIso } from '../util/timestamp.js';
import type { Engine } from '../util/engine.js';
import { selectGrokCredential } from './grok-auth.js';
import { credentialMetadata, inspectCredential } from './auth-generation.js';
import { quotaWindowScore } from './account-selection.js';
import { readAccountPolicy, selectForLaunch } from './account-policy.js';
import { wsPublisher } from '../ws/publisher.js';
import { decrypt } from '../security/secret-box.js';
import { createRunnerValidationService } from './runner-validation.js';
import { resolveProviderAccount } from './provider-account-reference.js';
import { withGrokAccountLock } from './grok-auth-lock.js';
import { withKimiAccountLock } from './kimi-auth-lock.js';
import { readGrokUsage } from './grok-usage.js';
import { readKimiUsage } from './kimi-usage.js';
import { chatGptPlanName, claudePlanName, providerPlan } from './provider-plan.js';
import { claudeAccessToken, claudeIdentityValue, lookupClaudeIdentity, type ClaudeIdentity, type ClaudeIdentityLookup } from './claude-identity.js';
import { ApiError } from '../http/errors.js';
import { appendAuditLog } from './audit-log.js';

type Account = typeof providerAccounts.$inferSelect;
/** One audit row per unresolved credential and outcome, not one per retry of the uploading host. */
const UNRESOLVED_AUDIT_EVERY_MS = 10 * 60_000;
const unresolvedAudits = new Map<string, number>();
const isDefaultLabel = (label: string) => /^(Claude|ChatGPT|Grok|Kimi Code)( account| \d+)?$/.test(label.trim());
const PROVIDER_LABELS: Record<Engine, string> = { codex: 'ChatGPT', claude: 'Claude', grok: 'Grok', kimi: 'Kimi Code' };
export function providerIdentity(auth: Record<string, unknown>, engine: Engine, resolved?: string | null): string | null {
  const tokens = auth.tokens as Record<string, unknown> | undefined;
  // Claude credentials carry no identity; callers pass the profile-derived value.
  const value = resolved ?? (engine === 'codex' ? tokens?.account_id : engine === 'grok' ? selectGrokCredential(auth, true)?.native.user_id : auth.account_identity);
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

  /** The live account whose credential history contains this canonical digest. */
  async accountOfDigest(engine: Engine, digest: string): Promise<number | undefined> {
    const owner = ownerRuntimeFor(this.db);
    let accountId: number | null | undefined;
    if (owner) {
      owner.assertOwner();
      accountId = owner.state
        .snapshot()
        .table('authPayloads')
        .all()
        .find((row) => row.engine === engine && row.sha256 === digest && row.accountId != null)?.accountId;
    } else {
      accountId = (
        await this.db
          .select({ accountId: authPayloads.accountId })
          .from(authPayloads)
          .where(and(eq(authPayloads.engine, engine), eq(authPayloads.sha256, digest), isNotNull(authPayloads.accountId)))
          .orderBy(desc(authPayloads.id))
          .limit(1)
      )[0]?.accountId;
    }
    return accountId == null ? undefined : await this.canonicalId(accountId, engine);
  }

  async resolveCandidate(
    auth: Record<string, unknown>,
    engine: Engine,
    target?: number,
    sourceHostId?: number | null,
    targetIsHint = false,
    enrollAccount = false,
  ): Promise<Account> {
    return (await this.resolveCandidateDetailed(auth, engine, target, sourceHostId, targetIsHint, enrollAccount)).account;
  }

  /**
   * Picks the account an uploaded credential belongs to. For Claude the server
   * resolves the provider identity through Anthropic's OAuth profile: a known
   * identity always routes to its own account (never rejected, so a late
   * rotation of a previous account still reaches it), and an unknown identity
   * enrolls a new account when `autoEnroll` permits it. A login Anthropic did
   * not name is filed only where that cannot merge two subscriptions: under
   * the account that already holds the exact token, or under the sole account.
   * In a pool, for an enrollment and for an operator replacement it is refused
   * with a retryable 503 `account_identity_unavailable`; the caller's lease or
   * saved account is never taken as proof.
   */
  async resolveCandidateDetailed(
    auth: Record<string, unknown>,
    engine: Engine,
    target?: number,
    sourceHostId?: number | null,
    targetIsHint = false,
    enrollAccount = false,
    autoEnroll = true,
  ): Promise<{ account: Account; created: boolean }> {
    const owner=ownerRuntimeFor(this.db);owner?.assertOwner();
    const identity = inspectCredential(auth, engine);
    if (!identity) throw new ValidationError('payload contains no usable auth tokens');
    const lookup: ClaudeIdentityLookup = engine === 'claude' ? await lookupClaudeIdentity(claudeAccessToken(auth)) : { status: 'skipped' };
    const claude: ClaudeIdentity | null = lookup.status === 'resolved' ? lookup.identity : null;
    const identityKey = providerIdentity(auth, engine, claude ? claudeIdentityValue(claude) : null);
    // A Claude OAuth login whose owner Anthropic did not name (refused or unreachable).
    const unresolved = !identityKey && (lookup.status === 'unidentifiable' || lookup.status === 'unavailable');
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
    const resolvedHeads = new Map<number, string | null>();
    const accountIdentity = (a: Account): string | null => {
      if (a.identityKey && !a.identityKey.startsWith('credential:')) return a.identityKey;
      if (resolvedHeads.has(a.id)) return resolvedHeads.get(a.id)!;
      const head = history.find((r) => r.id === a.payloadId);
      try {
        return head?.body ? providerIdentity(JSON.parse(decrypt(head.body, this.keyring)), engine) : null;
      } catch {
        return null;
      }
    };
    // Accounts enrolled before identity detection: ask who their head belongs to.
    // Only Anthropic's refusal proves a head has no identity to compare; a
    // lookup that failed leaves the account unproven, and nothing is filed
    // under an unproven account on the strength of a binding.
    const unprovenHeads = new Set<number>();
    if (engine === 'claude' && identityKey) {
      for (const a of accounts) {
        if (a.state === 'removed' || (a.identityKey && !a.identityKey.startsWith('credential:'))) continue;
        const head = history.find((r) => r.id === a.payloadId);
        let resolved: string | null = null;
        try {
          const headAuth = head?.body ? (JSON.parse(decrypt(head.body, this.keyring)) as Record<string, unknown>) : null;
          const headLookup: ClaudeIdentityLookup = headAuth ? await lookupClaudeIdentity(claudeAccessToken(headAuth)) : { status: 'skipped' };
          if (headLookup.status === 'resolved') resolved = providerIdentity({}, engine, claudeIdentityValue(headLookup.identity));
          else if (headLookup.status === 'unavailable') unprovenHeads.add(a.id);
        } catch {
          resolved = null;
        }
        resolvedHeads.set(a.id, resolved);
      }
    }
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
    const live = (a: Account) => a.state !== 'removed';
    let account = identityKey ? accounts.filter(live).find((a) => accountIdentity(a) === identityKey) : undefined;
    const refusal = { engine, sourceHostId: sourceHostId ?? null, target: target ?? null, strict: target !== undefined && !targetIsHint, enroll: enrollAccount, pool: accounts.filter(live).length };
    if (unresolved) {
      // The exact access or refresh token is already filed under this account:
      // that is proof, whatever the uploading session is bound to.
      const lineage = accounts.find((a) => a.id === matched?.accountId || a.payloadId === matched?.id);
      if (lineage && sourceHostId != null)
        return { account: await this.claimIdentity(lineage, null, null, sourceHostId), created: false };
      if (!lineage) {
        const requested = target !== undefined && !targetIsHint && sourceHostId == null ? await this.get(target, engine) : undefined;
        if (enrollAccount || refusal.pool > 1 || (requested && accountIdentity(requested)))
          throw await this.identityUnavailable(identity, lookup, refusal);
        // A sole account keeps taking its rotations while Anthropic is unreachable.
        await this.auditUnresolved(identity, lookup, refusal, 'legacy_rules');
      }
    }
    if (engine === 'claude' && identityKey) {
      // A removed account stays removed until somebody enrolls it again on
      // purpose (`enroll: true`, the admin console or a seed command). A host
      // that still holds its login must not bring it back by syncing.
      const retired = !account && accounts.some((a) => a.state === 'removed' && a.identityKey === identityKey);
      if (retired && !enrollAccount && sourceHostId != null) throw new ConflictError('Account is retired', 'account_removed');
      // An operator replacing one account's credentials gets a refusal, not a
      // silent move to another account, when the login belongs elsewhere.
      if (target !== undefined && sourceHostId == null && !targetIsHint) {
        const requested = await this.get(target, engine);
        const requestedIdentity = accountIdentity(requested);
        if (requestedIdentity && requestedIdentity !== identityKey)
          throw new ConflictError('Credentials belong to a different account', 'account_identity_mismatch');
        if (!requestedIdentity && unprovenHeads.has(requested.id))
          throw await this.identityUnavailable(identity, { status: 'unavailable', reason: 'account_head' }, refusal);
      }
      // Explicit enrollment: the tombstone gives its identity back before it is claimed again.
      if (retired) await this.releaseRetiredIdentity(engine, identityKey, accounts);
      // Same login family whose identity was never recorded.
      const lineage = accounts.find((a) => a.id === matched?.accountId || a.payloadId === matched?.id);
      if (!account && lineage && !accountIdentity(lineage)) account = lineage;
      // The login matches no known identity, but an account whose own identity
      // could not be established just now may be its owner.
      if (!account && unprovenHeads.size)
        throw await this.identityUnavailable(identity, { status: 'unavailable', reason: 'account_head' }, refusal);
      if (!account && target !== undefined) {
        const requested = await this.get(target, engine);
        // Without a provable identity for the target, keep the previous behaviour.
        if (!accountIdentity(requested)) account = requested;
      }
      if (!account && !enrollAccount && !autoEnroll) {
        const existing = accounts.filter((a) => a.state !== 'removed' && a.state !== 'removing');
        if (existing.length && existing.every((a) => accountIdentity(a)))
          throw new ForbiddenError(
            'This host may not enroll another provider account; use a secure host or the admin console',
            'account_enroll_insecure_host',
          );
        if (existing.length === 1) account = existing[0];
        else if (existing.length > 1)
          throw new ConflictError(
            'Credentials of an unknown account require an explicit enrollment',
            'account_assignment_required',
          );
      }
      if (account) return { account: await this.claimIdentity(account, identityKey, claude, sourceHostId), created: false };
      await this.releaseRetiredIdentity(engine, identityKey, accounts);
      if (owner) return { account: await this.createOwnedAccount(engine, identityKey, null, null, claude?.email ?? `${PROVIDER_LABELS[engine]} account`), created: true };
      return { account: await this.insertAccount(engine, identityKey, claude?.email ?? `${PROVIDER_LABELS[engine]} account`), created: true };
    }
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
    if (account) return { account: await this.claimIdentity(account, identityKey, null, sourceHostId), created: false };
    if(owner)return { account: await this.createOwnedAccount(engine,key,null,null,`${PROVIDER_LABELS[engine]} account`), created: true };
    return { account: await this.insertAccount(engine, key, `${PROVIDER_LABELS[engine]} account`), created: true };
  }

  /**
   * Records that a login could not be attributed. Metadata only: no token
   * material and no fingerprint leaves this process.
   */
  private async auditUnresolved(
    credential: NonNullable<ReturnType<typeof inspectCredential>>,
    lookup: ClaudeIdentityLookup,
    context: { engine: Engine; sourceHostId: number | null; target: number | null; strict: boolean; enroll: boolean; pool: number },
    outcome: 'refused' | 'legacy_rules',
  ): Promise<void> {
    const now = Date.now();
    const key = `${outcome}:${credentialMetadata(credential, this.keyring.active()).pairFingerprint}`;
    const last = unresolvedAudits.get(key);
    if (last !== undefined && now - last < UNRESOLVED_AUDIT_EVERY_MS) return;
    for (const [seen, at] of unresolvedAudits) if (now - at >= UNRESOLVED_AUDIT_EVERY_MS) unresolvedAudits.delete(seen);
    unresolvedAudits.set(key, now);
    try {
      await appendAuditLog(this.db, {
        hostId: context.sourceHostId,
        action: 'provider_account.identity_unresolved',
        details: JSON.stringify({
          engine: context.engine,
          lookup: lookup.status,
          reason: lookup.status === 'unavailable' ? lookup.reason : null,
          outcome,
          account_id: context.target,
          session_bound: context.strict && context.sourceHostId != null,
          enroll: context.enroll,
          accounts: context.pool,
        }),
        createdAt: nowIso(),
      });
    } catch (error) {
      console.warn('provider account: identity audit failed', error instanceof Error ? error.message : String(error));
    }
  }

  /** The fail-closed answer for a login nobody could attribute. Retryable: local credentials stay as they are. */
  private async identityUnavailable(
    credential: NonNullable<ReturnType<typeof inspectCredential>>,
    lookup: ClaudeIdentityLookup,
    context: { engine: Engine; sourceHostId: number | null; target: number | null; strict: boolean; enroll: boolean; pool: number },
  ): Promise<ApiError> {
    await this.auditUnresolved(credential, lookup, context, 'refused');
    return new ApiError(
      'The provider could not confirm which account these credentials belong to; nothing was stored. Keep the local credentials and retry.',
      { status: 503, code: 'account_identity_unavailable', type: 'service_unavailable', headers: { 'retry-after': '30' } },
    );
  }

  /** Retirement checks plus first recording of a provider identity on an account. */
  private async claimIdentity(account: Account, identityKey: string | null, claude: ClaudeIdentity | null, sourceHostId?: number | null): Promise<Account> {
    const owner=ownerRuntimeFor(this.db);
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
      // Default labels become the account's e-mail once the identity is known.
      const label = claude?.email && isDefaultLabel(account.label) ? claude.email : account.label;
      if(owner){const id=account.id;await mutateOwnerState(owner,{kind:'provider.account.identify',payload:{id,identityKey,label},prepare({snapshot,draft,write}){
        const current=snapshot.accounts.get(id);if(!current||current.state==='removed')throw new ConflictError('Account is retired','account_removed');
        if(current.identityKey&&!current.identityKey.startsWith('credential:')&&current.identityKey!==identityKey)throw new ConflictError('Account identity changed','account_identity_mismatch');
        const updatedAt=nowIso();draft.upsert('providerAccounts',{...current,identityKey,label,updatedAt});write(tx=>tx.update(providerAccounts).set({identityKey,label,updatedAt}).where(eq(providerAccounts.id,id)));return null;
      }});}else await this.db.update(providerAccounts).set({identityKey,label,updatedAt:nowIso()}).where(eq(providerAccounts.id,account.id));
      return { ...account, identityKey, label };
    }
    return account;
  }

  /** A retired account must not block re-enrolling the same subscription. */
  private async releaseRetiredIdentity(engine: Engine, identityKey: string, accounts: Account[]) {
    const retired = accounts.find((a) => a.state === 'removed' && a.identityKey === identityKey);
    if (!retired) return;
    const owner=ownerRuntimeFor(this.db);
    if(owner){await mutateOwnerState(owner,{kind:'provider.account.identify',payload:{id:retired.id,identityKey:null},prepare({snapshot,draft,write}){
      const current=snapshot.accounts.get(retired.id);if(!current||current.state!=='removed')return null;
      const updatedAt=nowIso();draft.upsert('providerAccounts',{...current,identityKey:null,updatedAt});write(tx=>tx.update(providerAccounts).set({identityKey:null,updatedAt}).where(eq(providerAccounts.id,retired.id)));return null;
    }});return;}
    await this.db.update(providerAccounts).set({ identityKey: null, updatedAt: nowIso() }).where(and(eq(providerAccounts.engine, engine), eq(providerAccounts.id, retired.id)));
  }

  private async insertAccount(engine: Engine, key: string, label: string): Promise<Account> {
    const now = nowIso();
    await this.db
      .insert(providerAccounts)
      .values({
        engine,
        state: 'enabled',
        payloadId: null,
        generation: null,
        lastSelectedAt: null,
        label,
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
          const refresh = a.engine === 'kimi' ? owner ? owner.state.snapshot().table('kimiAuthRefreshState').get(a.id) : (await this.db.select().from(kimiAuthRefreshState).where(eq(kimiAuthRefreshState.accountId, a.id)))[0] : a.engine === 'grok' ? owner ? owner.state.snapshot().table('grokAuthRefreshState').get(a.id) : (await this.db.select().from(grokAuthRefreshState).where(eq(grokAuthRefreshState.accountId, a.id)))[0] : null;
          return {
            id: a.id,
            engine: a.engine,
            label: a.label,
            email: a.label.includes('@') ? a.label : null,
            identity_known: !!a.identityKey && !a.identityKey.startsWith('credential:'),
            state: a.state,
            ...(['grok','kimi'].includes(a.engine) ? { refresh_state: refresh?.state ?? 'idle', refresh_error: refresh?.errorCode ?? null } : {}),
            verification_state: payload?.verificationState ?? 'pending',
            verification_reason: payload?.verificationReason ?? null,
            verification_checked_at: payload?.verificationCheckedAt ?? null,
            generation: a.generation,
            created_at: a.createdAt,
            updated_at: a.updatedAt,
            last_selected_at: a.lastSelectedAt,
            usage,
            quota_snapshot: await quotaSnapshot(this.db, a.id, a.engine as Engine),
            quota_policy: (await readQuotaPolicy(this.db, a.engine as Engine, a.id)).effective,
            plan,
            sessions: sessions
              .filter((s) => s.accountId === a.id)
              .map((s) => ({
                id: s.id,
                host_id: s.hostId,
                expires_at: s.expiresAt,
                scope_id: s.scopeId,
                binding_generation: s.bindingGeneration ?? 1,
                desired_account_id: s.desiredAccountId ?? null,
              })),
          };
        }),
    );
  }

  async usage(accountId: number, engine: Engine, reader: Pick<Database, 'select'> = this.db) {
    const now = Date.now();
    const owner = ownerRuntimeFor(reader); owner?.assertOwner();
    if (engine === 'grok') return readGrokUsage(reader, accountId);
    if (engine === 'kimi') return readKimiUsage(reader, accountId);
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
    const policy = await readAccountPolicy(this.db, engine);
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
            // Unlimited quota never expires, so it has no reset to race.
            weeklyResetsAt: unlimited ? null : usage.weekly_resets_at,
          });
        }
        const admitted = [];
        for (const candidate of candidates) {
          const snapshot = await quotaSnapshot(tx, candidate.id, engine);
          if (snapshot?.unlimited || !emulationBlocks(snapshot?.short)) admitted.push(candidate);
        }
        const chosen =
          preferred !== undefined
            ? candidates.find((a) => a.id === preferred)
            : selectForLaunch(policy, admitted.length ? admitted : candidates, threshold, Date.now());
        account = accounts.find((a) => a.id === chosen?.id);
      }
      if (!account)
        throw new ServiceUnavailableError(
          `No verified ${PROVIDER_LABELS[engine]} account available`,
          'account_unavailable',
        );
      const quota = await quotaSnapshot(tx, account.id, engine);
      if (!quota?.unlimited && emulationBlocks(quota?.short)) throw emulationLimitError(quota!.short!.resets_at!);
      const expiresAt = new Date(Date.now() + 300_000).toISOString();
      await tx
        .insert(providerAccountSessions)
        .values({
          id: sessionId,
          hostId,
          engine,
          scopeId,
          accountId: account.id,
          expiresAt,
          createdAt: now,
          bindingGeneration: pinned?.bindingGeneration ?? freshBindingGeneration(),
          desiredAccountId: pinned?.desiredAccountId ?? null,
          desiredReason: pinned?.desiredReason ?? null,
          desiredAt: pinned?.desiredAt ?? null,
          boundAt: pinned?.boundAt ?? now,
        })
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
    if (engine === 'grok' || engine === 'kimi') await this.session(hostId, engine, id);
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
        if (a.engine === 'kimi') await tx.delete(kimiAuthRefreshState).where(eq(kimiAuthRefreshState.accountId, a.id));
        // Leave the legacy pointer as a tombstone, never resurrect old history.
      }
    });
    for (const account of candidates.filter(a => a.engine === 'grok')) {
      await withGrokAccountLock(this.db, account.id, owner => drain(owner.db, [account]));
    }
    for (const account of candidates.filter(a => a.engine === 'kimi')) {
      await withKimiAccountLock(this.db, account.id, owner => drain(owner.db, [account]));
    }
    const otherAccounts = candidates.filter(a => a.engine !== 'grok' && a.engine !== 'kimi');
    if (otherAccounts.length) await drain(this.db, otherAccounts);
  }
}
