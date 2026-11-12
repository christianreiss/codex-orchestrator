import { persistAuditLog } from './audit-log.js';
import {
  canonicalState,
  setOwnedKimiState,
  patchCanonicalPayload,
  canonicalTransaction,
} from '../control-plane/streams/canonical-state.js';
import { ownerRuntimeFor, withOwnerBackgroundScope } from '../control-plane/state/runtime.js';
import { ownerPresence } from '../control-plane/presence.js';
import { ownedProviderSession } from '../control-plane/streams/provider-leases.js';
import { randomUUID } from 'node:crypto';
import { and, eq, gt } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { authPayloads, kimiAuthRefreshState, providerAccountSessions } from '../db/schema.js';
import type { Keyring } from '../security/keyring.js';
import { decrypt, encrypt } from '../security/secret-box.js';
import { ApiError, ConflictError, NotFoundError, ServiceUnavailableError } from '../http/errors.js';
import { nowIso } from '../util/timestamp.js';
import { createCanonicalAuthStoreService } from './canonical-auth-store.js';
import { createRunnerValidationService, type CanonicalPayloadRow } from './runner-validation.js';
import type { RunnerClient } from './runner-client.js';
import { resolveProviderAccount } from './provider-account-reference.js';
import {
  kimiDeviceHeaders,
  kimiProjectionMetadata,
  normalizeKimiAuth,
  projectKimiAuth,
  selectKimiCredential,
} from './kimi-auth.js';
import { withKimiAccountLock } from './kimi-auth-lock.js';
import { assertFleetEngineEnabled } from './engine-switch.js';

export type KimiRefreshState =
  | 'idle'
  | 'refreshing'
  | 'pending_verification'
  | 'uncertain'
  | 'login_required';
export interface KimiAuthFreshInput {
  accountId?: number;
  sourceHostId?: number;
  sessionId?: string;
  /** Server-side launch path only: the just-acquired lease precedes attachment. */
  bootstrapSession?: boolean;
  refreshIfGeneration?: number;
  minValiditySeconds?: number;
  deadlineMs?: number;
}
export interface KimiAuthSnapshot {
  row: CanonicalPayloadRow;
  auth: Record<string, unknown>;
  digest: string;
  last_refresh: string;
  canonical_generation: number;
  access_token_digest: string;
  expires_at: string;
  refresh_state: KimiRefreshState;
}
export interface KimiAuthOwnerDeps {
  db: Database;
  keyring: Keyring;
  runner: RunnerClient;
  fetchImpl?: typeof fetch;
}

/** Only this owner spends Kimi refresh credentials. Neither hosts nor the runner receive them. */
export function createKimiAuthOwner(deps: KimiAuthOwnerDeps) {
  const request = deps.fetchImpl ?? fetch;

  async function ensureFresh(input: KimiAuthFreshInput = {}): Promise<KimiAuthSnapshot> {
    // Kimi switched off fleet-wide: the owner spends no refresh credential.
    await assertFleetEngineEnabled(deps.db, 'kimi');
    const deadline = Date.now() + Math.min(6000, Math.max(1, input.deadlineMs ?? 6000));
    const minValidity = Math.max(0, input.minValiditySeconds ?? 0);
    const validation = createRunnerValidationService({ db: deps.db, keyring: deps.keyring });
    const initial = await validation.resolveCanonicalPayload('kimi', input.accountId);
    const accountId = initial?.accountId ?? input.accountId;
    if (!accountId)
      throw new ServiceUnavailableError(
        'No verified Kimi subscription account is available',
        'account_unavailable',
      );
    if (
      input.refreshIfGeneration !== undefined &&
      (!Number.isSafeInteger(input.refreshIfGeneration) || input.refreshIfGeneration < 0)
    ) {
      throw new ConflictError(
        'refresh_if_generation must name the observed canonical generation',
        'kimi_generation_conflict',
      );
    }
    if (input.refreshIfGeneration !== undefined && (!input.sessionId || !input.sourceHostId)) {
      throw new ConflictError(
        'Reactive Kimi renewal requires a live pinned account session',
        'kimi_session_required',
      );
    }
    const resolvedAccount = await resolveProviderAccount(deps.db, accountId, 'kimi');
    if (!resolvedAccount || resolvedAccount.state === 'removed')
      throw new NotFoundError('Kimi account was removed');
    const account = resolvedAccount;
    return withKimiAccountLock(
      deps.db,
      account.id,
      async (owner) => {
        const db = owner.db;
        const validation = createRunnerValidationService({ db, keyring: deps.keyring });
        const store = createCanonicalAuthStoreService(
          { db, keyring: deps.keyring, runnerValidation: validation, runner: deps.runner },
          account.id,
          input.sourceHostId,
        );
        const selectedAccount = await resolveProviderAccount(db, account.id, 'kimi');
        if (!selectedAccount || selectedAccount.id !== account.id || selectedAccount.state === 'removed')
          throw new ConflictError('Kimi account changed during renewal', 'kimi_generation_conflict');
        if (input.sessionId) await assertSession(db, input, account.id);
        if (selectedAccount.state !== 'enabled' && !input.sessionId)
          throw new ServiceUnavailableError('Kimi account is not enabled', 'account_unavailable');
        const base = await validation.resolveCanonicalPayload('kimi', account.id);
        const full = validation.validateCanonicalPayload(base);
        if (!base || !full || base.verificationState !== 'verified')
          throw loginRequired('No verified Kimi canonical login is available');
        const credential = selectKimiCredential(full.auth);
        if (!credential) throw loginRequired('Kimi requires a modern subscription login');
        if (input.refreshIfGeneration !== undefined && (base.generation ?? 0) < input.refreshIfGeneration)
          throw new ConflictError(
            'Observed Kimi generation is newer than canonical',
            'kimi_generation_conflict',
          );
        const force =
          input.refreshIfGeneration !== undefined && input.refreshIfGeneration === base.generation;
        let state: typeof kimiAuthRefreshState.$inferSelect | undefined;
        const ownedState = canonicalState(db);
        if (ownedState) {
          const metadata = ownedState.table('kimiAuthRefreshState').get(account.id);
          if (metadata) {
            let responseEnc: string | null = null;
            if (metadata.state !== 'idle')
              responseEnc =
                (
                  await db
                    .select({ responseEnc: kimiAuthRefreshState.responseEnc })
                    .from(kimiAuthRefreshState)
                    .where(eq(kimiAuthRefreshState.accountId, account.id))
                )[0]?.responseEnc ?? null;
            state = { ...metadata, responseEnc };
          }
        } else
          state = (
            await db.select().from(kimiAuthRefreshState).where(eq(kimiAuthRefreshState.accountId, account.id))
          )[0];

        async function setState(
          next: KimiRefreshState,
          extra: Partial<typeof kimiAuthRefreshState.$inferInsert> = {},
        ) {
          const values = { ...extra, state: next, updatedAt: nowIso() };
          await setOwnedKimiState(db, account.id, values);
          if (ownerRuntimeFor(db)) {
            const metadata = canonicalState(db)!.table('kimiAuthRefreshState').get(account.id)!;
            state = {
              ...metadata,
              responseEnc: extra.responseEnc === undefined ? (state?.responseEnc ?? null) : extra.responseEnc,
            };
          } else
            state = (
              await db
                .select()
                .from(kimiAuthRefreshState)
                .where(eq(kimiAuthRefreshState.accountId, account.id))
            )[0];
        }
        async function audit(action: string, detail: Record<string, unknown> = {}) {
          await canonicalTransaction(db, 'auth.kimi.audit', async (tx) => {
            await persistAuditLog(tx, {
              engine: 'kimi',
              action,
              details: JSON.stringify({
                account_id: account.id,
                attempt_id: state?.attemptId,
                base_generation: base!.generation,
                ...detail,
              }),
              createdAt: nowIso(),
            });
          });
        }
        async function snapshot(
          row: CanonicalPayloadRow,
          refreshState: KimiRefreshState,
        ): Promise<KimiAuthSnapshot> {
          if (input.sessionId) await assertSession(db, input, account.id);
          const payload = validation.validateCanonicalPayload(row);
          if (!payload || row.verificationState !== 'verified')
            throw loginRequired('Kimi canonical login is not verified');
          const selected = selectKimiCredential(payload.auth);
          if (!selected || Date.parse(selected.expiresAt) <= Date.now() + minValidity * 1000)
            throw new ServiceUnavailableError(
              'Kimi bearer lifetime is insufficient for this operation',
              'kimi_lifetime_insufficient',
            );
          if (input.refreshIfGeneration !== undefined && (row.generation ?? 0) <= input.refreshIfGeneration)
            throw new ServiceUnavailableError(
              'Kimi successor generation is not yet available',
              'kimi_refresh_pending',
            );
          const metadata = kimiProjectionMetadata(payload.auth) as {
            access_token_digest: string;
            expires_at: string;
          };
          return {
            row,
            auth: projectKimiAuth(payload.auth),
            digest: payload.digest,
            last_refresh: payload.last_refresh,
            canonical_generation: row.generation ?? 0,
            ...metadata,
            refresh_state: refreshState,
          };
        }
        async function verifyPending(payloadId: number) {
          const pending = (await db.select().from(authPayloads).where(eq(authPayloads.id, payloadId)))[0];
          const candidate = pending ? validation.validateCanonicalPayload(pending) : null;
          if (!pending || !candidate || pending.accountId !== account.id) {
            await setState('uncertain', { errorCode: 'candidate_missing' });
            throw unavailable('kimi_refresh_uncertain');
          }
          const remaining = deadline - Date.now();
          if (remaining <= 50 || !deps.runner.verifyKimi || !deps.runner.isConfigured())
            throw unavailable('kimi_refresh_pending');
          const verdict = await deps.runner.verifyKimi({
            authJson: projectKimiAuth(candidate.auth),
            timeoutSeconds: remaining / 1000,
          });
          if (!verdict.ok || !verdict.reachable || !verdict.definitive) {
            if (verdict.definitive && verdict.reachable) {
              await patchCanonicalPayload(db, payloadId, {
                verificationState: 'failed',
                verificationCheckedAt: nowIso(),
                verificationReason: 'Kimi subscription bearer was rejected',
              });
              await setState('login_required', { errorCode: 'bearer_rejected' });
              await audit('kimi.auth.refresh.failed');
              throw loginRequired('Kimi subscription renewal was rejected');
            }
            await setState('pending_verification', { errorCode: 'verification_unavailable' });
            throw unavailable('kimi_refresh_pending');
          }
          if (!(await store.promoteKimiRefreshCandidate(payloadId, base!)))
            throw new ConflictError(
              'Kimi generation changed before renewal promotion',
              'kimi_generation_conflict',
            );
          await setState('idle', {
            attemptId: null,
            basePayloadId: null,
            baseGeneration: null,
            pendingPayloadId: null,
            responseEnc: null,
            nextAttemptAt: null,
            errorCode: null,
          });
          await audit('kimi.auth.refresh.accepted', {
            payload_id: payloadId,
            generation: pending.generation,
          });
          return snapshot({ ...pending, verificationState: 'verified' }, 'idle');
        }

        // Known replacement material wins over freshness of a predecessor. Resume
        // only static verification; never spend the predecessor's grant again.
        if (state?.pendingPayloadId === base.id && base.verificationState === 'verified') {
          await setState('idle', {
            attemptId: null,
            basePayloadId: null,
            baseGeneration: null,
            pendingPayloadId: null,
            responseEnc: null,
            nextAttemptAt: null,
            errorCode: null,
          });
          return snapshot(base, 'idle');
        }
        // Captured material belongs to its recorded predecessor, never whichever
        // head a later caller happens to resolve. Keep it durable on conflicts.
        if (
          state?.responseEnc &&
          (state.basePayloadId !== base.id || state.baseGeneration !== base.generation)
        )
          throw new ConflictError(
            'Kimi canonical changed after refresh response capture',
            'kimi_generation_conflict',
          );
        if (state?.state === 'pending_verification' && state.pendingPayloadId)
          return verifyPending(state.pendingPayloadId);
        if (state?.state === 'refreshing' && !state.responseEnc) {
          await setState('uncertain', { errorCode: 'owner_lost_after_intent' });
          await audit('kimi.auth.refresh.uncertain');
        }
        if (
          !force &&
          !state?.responseEnc &&
          Date.parse(credential.expiresAt) >
            Date.now() + Math.max(minValidity, 300, credential.expiresIn / 2) * 1000
        ) {
          return snapshot(base, (state?.state ?? 'idle') as KimiRefreshState);
        }
        if (state?.state === 'uncertain' && !state.responseEnc) throw unavailable('kimi_refresh_uncertain');
        if (state?.state === 'login_required') throw loginRequired('Kimi subscription login must be renewed');
        if (state?.nextAttemptAt && Date.parse(state.nextAttemptAt) > Date.now())
          throw unavailable('kimi_refresh_transient');

        let body: string;
        let receivedAt: string;
        if (state?.responseEnc) {
          try {
            const capture = JSON.parse(decrypt(state.responseEnc, deps.keyring)) as {
              body: string;
              received_at: string;
            };
            body = capture.body;
            receivedAt = capture.received_at;
          } catch {
            await setState('uncertain', { errorCode: 'response_unreadable' });
            throw unavailable('kimi_refresh_uncertain');
          }
        } else {
          if (!credential.refresh) {
            await setState('login_required', { errorCode: 'refresh_token_missing' });
            throw loginRequired('Kimi subscription refresh token is missing');
          }
          const endpoint = `${String(full.auth.oauth_host)}/api/oauth/token`;
          if (Date.now() >= deadline) throw unavailable('kimi_refresh_transient');
          const attempt = {
            attemptId: randomUUID(),
            basePayloadId: base.id,
            baseGeneration: base.generation,
          };
          await setState('refreshing', {
            ...attempt,
            pendingPayloadId: null,
            responseEnc: null,
            errorCode: null,
            nextAttemptAt: null,
            startedAt: nowIso(),
          });
          await audit('kimi.auth.refresh.started');
          // Persistence/owner queueing can consume the caller's whole budget.
          // Nothing has been sent yet: leave the grant retryable, not uncertain.
          if (Date.now() >= deadline) {
            await setState('idle', {
              attemptId: null,
              basePayloadId: null,
              baseGeneration: null,
              errorCode: 'deadline_before_send',
            });
            await audit('kimi.auth.refresh.deferred', { error_code: 'deadline_before_send' });
            throw unavailable('kimi_refresh_transient');
          }
          let response: Response;
          try {
            // Once sent, conserve the rotating response independently of the
            // caller's admission/verification deadline. A tiny remaining caller
            // budget must never manufacture an ambiguous spend.
            response = await request(endpoint, {
              method: 'POST',
              redirect: 'error',
              headers: {
                ...kimiDeviceHeaders(String(full.auth.device_id)),
                'content-type': 'application/x-www-form-urlencoded',
                accept: 'application/json',
              },
              body: new URLSearchParams({
                grant_type: 'refresh_token',
                refresh_token: credential.refresh,
                client_id: credential.clientId,
              }),
              signal: AbortSignal.timeout(15000),
            });
            body = await response.text();
          } catch {
            await setState('uncertain', { errorCode: 'transport_outcome_unknown' });
            await audit('kimi.auth.refresh.uncertain');
            throw unavailable('kimi_refresh_uncertain');
          }
          receivedAt = nowIso();
          if (!response.ok) {
            let error = '';
            try {
              error = String((JSON.parse(body) as { error?: unknown }).error ?? '');
            } catch {
              /* ambiguous upstream body */
            }
            if (error === 'invalid_grant' || error === 'invalid_client') {
              await setState('login_required', { errorCode: error });
              await audit('kimi.auth.refresh.failed');
              throw loginRequired('Kimi subscription refresh grant was rejected');
            }
            if (error === 'temporarily_unavailable' || error === 'server_error' || response.status === 429) {
              const retry = Number(response.headers.get('retry-after'));
              await setState('idle', {
                errorCode: error || 'rate_limited',
                nextAttemptAt: new Date(
                  Date.now() + Math.min(60, Number.isFinite(retry) && retry > 0 ? retry : 5) * 1000,
                ).toISOString(),
              });
              await audit('kimi.auth.refresh.transient');
              throw unavailable('kimi_refresh_transient');
            }
            await setState('uncertain', { errorCode: 'provider_outcome_unknown' });
            await audit('kimi.auth.refresh.uncertain');
            throw unavailable('kimi_refresh_uncertain');
          }
          // Rotation has happened. Capture before parsing, checking identity or
          // calling the runner, so later failures cannot discard replacement RTs.
          // This is conservation of a completed server-owned spend. Caller
          // revocation must still deny candidate promotion and disclosure below,
          // but cannot discard replacement material the provider already issued.
          await withOwnerBackgroundScope(() =>
            setState('refreshing', {
              ...attempt,
              responseEnc: encrypt(JSON.stringify({ body, received_at: receivedAt }), deps.keyring),
            }),
          );
        }

        let replacement: Record<string, unknown>;
        try {
          const token = JSON.parse(body) as Record<string, unknown>;
          if (
            typeof token.access_token !== 'string' ||
            token.access_token.trim().length < 8 ||
            !Number.isFinite(Number(token.expires_in)) ||
            Number(token.expires_in) <= 0
          )
            throw new Error('invalid response');
          if (typeof token.refresh_token !== 'string' || !token.refresh_token.trim())
            throw new Error('missing rotated refresh token');
          replacement = normalizeKimiAuth(
            {
              ...full.auth,
              last_refresh: new Date(
                Math.max(Date.parse(receivedAt), Date.parse(full.last_refresh) + 1),
              ).toISOString(),
              kimi_code: {
                ...credential.native,
                access_token: token.access_token,
                refresh_token: token.refresh_token,
                expires_in: Number(token.expires_in),
                expires_at: Math.floor(Date.parse(receivedAt) / 1000) + Number(token.expires_in),
              },
            },
            true,
          );
        } catch {
          await setState('uncertain', { errorCode: 'response_invalid' });
          throw unavailable('kimi_refresh_uncertain');
        }
        const pending = await store.recordKimiRefreshCandidate(replacement, base);
        await setState('pending_verification', { pendingPayloadId: pending.id });
        return verifyPending(pending.id);
      },
      deadline,
    );
  }

  return { ensureFresh };
}

async function assertSession(db: Database, input: KimiAuthFreshInput, accountId: number) {
  if (!input.sourceHostId || !input.sessionId)
    throw new ConflictError('Kimi account session is required', 'kimi_session_required');
  const runtime = ownerRuntimeFor(db);
  if (runtime) {
    const lease = ownedProviderSession(runtime, input.sourceHostId, 'kimi', input.sessionId);
    const bootstrap =
      input.bootstrapSession === true &&
      input.refreshIfGeneration === undefined &&
      Date.parse(lease.expiresAt) > Date.now();
    if (
      lease.accountId !== accountId ||
      (lease.ownershipMode === 'connection' && !ownerPresence(runtime).hasProvider(lease.id) && !bootstrap)
    )
      throw new NotFoundError('Account session not found');
    return;
  }
  const rows = await db
    .select()
    .from(providerAccountSessions)
    .where(
      and(
        eq(providerAccountSessions.id, input.sessionId),
        eq(providerAccountSessions.hostId, input.sourceHostId),
        eq(providerAccountSessions.engine, 'kimi'),
        eq(providerAccountSessions.accountId, accountId),
        gt(providerAccountSessions.expiresAt, nowIso()),
      ),
    )
    .limit(1);
  if (!rows.length) throw new NotFoundError('Account session not found');
}

function unavailable(code: 'kimi_refresh_pending' | 'kimi_refresh_transient' | 'kimi_refresh_uncertain') {
  return new ServiceUnavailableError(
    code === 'kimi_refresh_uncertain'
      ? 'Kimi refresh outcome is uncertain; a new subscription login is required'
      : 'A fresh Kimi subscription bearer is not yet available',
    code,
  );
}
function loginRequired(message: string) {
  return new ApiError(message, { status: 401, code: 'kimi_login_required' });
}
