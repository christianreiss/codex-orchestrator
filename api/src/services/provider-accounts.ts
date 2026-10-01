import { createHash } from 'node:crypto';
import { and, asc, desc, eq, gt, inArray, lte } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import {
  authCanonicalHeads,
  authEntries,
  authPayloads,
  providerAccounts,
  providerAccountSessions,
  chatgptUsageSnapshots,
  claudeUsageSnapshots,
  logs,
} from '../db/schema.js';
import type { Keyring } from '../security/keyring.js';
import { ConflictError, NotFoundError, ServiceUnavailableError, ValidationError } from '../http/errors.js';
import { nowIso } from '../util/timestamp.js';
import type { Engine } from '../util/engine.js';
import { credentialMetadata, inspectCredential } from './auth-generation.js';
import { quotaWindowScore, selectAccount } from './account-selection.js';
import { wsPublisher } from '../ws/publisher.js';
import { decrypt } from '../security/secret-box.js';
import { createRunnerValidationService } from './runner-validation.js';
import { resolveProviderAccount } from './provider-account-reference.js';

type Account = typeof providerAccounts.$inferSelect;
export function providerIdentity(auth: Record<string, unknown>, engine: Engine): string | null {
  const tokens = auth.tokens as Record<string, unknown> | undefined;
  const value = engine === 'codex' ? tokens?.account_id : auth.account_identity;
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
    const account = await resolveProviderAccount(this.db, id, engine);
    if (!account) throw new NotFoundError('Provider account not found');
    return account;
  }

  async canonicalId(id: number, engine: Engine): Promise<number> {
    return (await resolveProviderAccount(this.db, id, engine))?.id ?? id;
  }

  async resolveCandidate(
    auth: Record<string, unknown>,
    engine: Engine,
    target?: number,
    sourceHostId?: number | null,
    targetIsHint = false,
    enrollAccount = false,
  ): Promise<Account> {
    const identity = inspectCredential(auth, engine);
    if (!identity) throw new ValidationError('payload contains no usable auth tokens');
    const identityKey = providerIdentity(auth, engine);
    let accounts = (
      await this.db.select().from(providerAccounts).where(eq(providerAccounts.engine, engine))
    ).filter((a) => !a.mergedIntoAccountId);
    // A legacy head can be backfilled after schema migration on fresh installs.
    if (!accounts.length) {
      const legacy = await createRunnerValidationService({
        db: this.db,
        keyring: this.keyring,
      }).resolveCanonicalPayload(engine);
      if (legacy && !legacy.accountId) {
        const now = nowIso();
        await this.db.insert(providerAccounts).values({
          engine,
          state: 'enabled',
          label: engine === 'claude' ? 'Claude 1' : 'ChatGPT 1',
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
    const history = await this.db.select().from(authPayloads).where(eq(authPayloads.engine, engine));
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
            : await this.db
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
        await this.db
          .update(providerAccounts)
          .set({ identityKey, updatedAt: nowIso() })
          .where(eq(providerAccounts.id, account.id));
      }
      return account;
    }
    const now = nowIso();
    await this.db
      .insert(providerAccounts)
      .values({
        engine,
        state: 'enabled',
        payloadId: null,
        generation: null,
        lastSelectedAt: null,
        label: engine === 'claude' ? 'Claude account' : 'ChatGPT account',
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

  async list(engine?: Engine) {
    await this.drainRemoved();
    const accounts = await this.db
      .select()
      .from(providerAccounts)
      .where(engine ? eq(providerAccounts.engine, engine) : undefined)
      .orderBy(asc(providerAccounts.id));
    const now = nowIso();
    const sessions = await this.db
      .select()
      .from(providerAccountSessions)
      .where(gt(providerAccountSessions.expiresAt, now));
    return Promise.all(
      accounts
        .filter((a) => a.state !== 'removed')
        .map(async (a) => {
          const payload = a.payloadId
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
          return {
            id: a.id,
            engine: a.engine,
            label: a.label,
            state: a.state,
            verification_state: payload?.verificationState ?? 'pending',
            verification_reason: payload?.verificationReason ?? null,
            verification_checked_at: payload?.verificationCheckedAt ?? null,
            generation: a.generation,
            created_at: a.createdAt,
            updated_at: a.updatedAt,
            last_selected_at: a.lastSelectedAt,
            usage,
            sessions: sessions
              .filter((s) => s.accountId === a.id)
              .map((s) => ({ id: s.id, host_id: s.hostId, expires_at: s.expiresAt })),
          };
        }),
    );
  }

  async usage(accountId: number, engine: Engine, reader: Pick<Database, 'select'> = this.db) {
    const now = Date.now();
    if (engine === 'claude') {
      const rows = await reader
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
        weekly_used_percent: r?.sevenDayUsedPercent ?? null,
        weekly_resets_at: r?.sevenDayResetsAt ?? null,
      };
    }
    const rows = await reader
      .select()
      .from(chatgptUsageSnapshots)
      .where(and(eq(chatgptUsageSnapshots.accountId, accountId), eq(chatgptUsageSnapshots.status, 'ok')))
      .orderBy(desc(chatgptUsageSnapshots.id))
      .limit(1);
    const r = rows[0];
    const secondaryWeekly = (r?.secondaryLimitSeconds ?? 0) >= 604800;
    const primaryWeekly = (r?.primaryLimitSeconds ?? 0) >= 604800;
    return {
      fetched_at: r?.fetchedAt ?? null,
      stale: !r || now - Date.parse(r.fetchedAt) > 600_000,
      short_used_percent: (primaryWeekly ? r?.secondaryUsedPercent : r?.primaryUsedPercent) ?? null,
      short_resets_at: (primaryWeekly ? r?.secondaryResetAt : r?.primaryResetAt) ?? null,
      weekly_used_percent:
        (secondaryWeekly ? r?.secondaryUsedPercent : primaryWeekly ? r?.primaryUsedPercent : null) ?? null,
      weekly_resets_at:
        (secondaryWeekly ? r?.secondaryResetAt : primaryWeekly ? r?.primaryResetAt : null) ?? null,
    };
  }

  async acquire(
    hostId: number,
    engine: Engine,
    scopeId: string,
    sessionId: string,
    threshold: number,
    preferred?: number,
  ) {
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
          const scores = [
            quotaWindowScore(usage.short_used_percent, usage.short_resets_at, Date.now()),
            quotaWindowScore(usage.weekly_used_percent, usage.weekly_resets_at, Date.now()),
          ].filter((x): x is number => x !== null);
          candidates.push({
            id: a.id,
            score: scores.length ? Math.max(...scores) : null,
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
          `No verified ${engine === 'claude' ? 'Claude' : 'ChatGPT'} account available`,
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
    const expiresAt = new Date(Date.now() + 300_000).toISOString();
    await this.db
      .update(providerAccountSessions)
      .set({ expiresAt })
      .where(eq(providerAccountSessions.id, id));
    return { account_id: session.accountId, expires_at: expiresAt };
  }

  async release(hostId: number, engine: Engine, id: string) {
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
    const account = await this.get(id);
    if (account.state === 'removed' || account.state === 'removing')
      throw new ConflictError('Account is being removed');
    await this.db
      .update(providerAccounts)
      .set({ ...changes, updatedAt: nowIso() })
      .where(eq(providerAccounts.id, id));
    await this.db.insert(logs).values({
      action: 'account.updated',
      details: JSON.stringify({ account_id: id, ...changes }),
      createdAt: nowIso(),
    });
    await this.drainRemoved();
    wsPublisher.publish('accounts.updated', { account_id: id });
  }

  async drainRemoved() {
    // Expiration cleanup must finish before taking any account row lock. The
    // reverse order deadlocks with concurrent account->session reservations.
    await this.db.delete(providerAccountSessions).where(lte(providerAccountSessions.expiresAt, nowIso()));
    const candidates = await this.db
      .select()
      .from(providerAccounts)
      .where(eq(providerAccounts.state, 'removing'));
    if (!candidates.length) return;
    await this.db.transaction(async (tx) => {
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
        // Leave the legacy pointer as a tombstone, never resurrect old history.
      }
    });
  }
}
