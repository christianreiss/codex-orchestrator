import { randomUUID } from 'node:crypto';
import { and, eq, gt } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { authPayloads, grokAuthRefreshState, logs, providerAccountSessions } from '../db/schema.js';
import type { Keyring } from '../security/keyring.js';
import { decrypt, encrypt } from '../security/secret-box.js';
import { ApiError, ConflictError, NotFoundError, ServiceUnavailableError } from '../http/errors.js';
import { nowIso } from '../util/timestamp.js';
import { createCanonicalAuthStoreService } from './canonical-auth-store.js';
import { createRunnerValidationService, type CanonicalPayloadRow } from './runner-validation.js';
import type { RunnerClient } from './runner-client.js';
import { resolveProviderAccount } from './provider-account-reference.js';
import { grokNativeAuth, grokProjectionMetadata, GROK_OIDC_ISSUER, normalizeGrokAuth, projectGrokAuth, selectGrokCredential } from './grok-auth.js';
import { withGrokAccountLock } from './grok-auth-lock.js';

export type GrokRefreshState = 'idle' | 'refreshing' | 'pending_verification' | 'uncertain' | 'login_required';
export interface GrokAuthFreshInput {
  accountId?: number;
  sourceHostId?: number;
  sessionId?: string;
  refreshIfGeneration?: number;
  minValiditySeconds?: number;
  deadlineMs?: number;
}
export interface GrokAuthSnapshot {
  row: CanonicalPayloadRow;
  auth: Record<string, unknown>;
  digest: string;
  last_refresh: string;
  canonical_generation: number;
  access_token_digest: string;
  expires_at: string;
  refresh_state: GrokRefreshState;
}
export interface GrokAuthOwnerDeps {
  db: Database;
  keyring: Keyring;
  runner: RunnerClient;
  fetchImpl?: typeof fetch;
}

let discovery: { endpoint: string; until: number } | null = null;

/** Only this owner spends Grok refresh credentials. Neither hosts nor the runner receive them. */
export function createGrokAuthOwner(deps: GrokAuthOwnerDeps) {
  const request = deps.fetchImpl ?? fetch;

  async function ensureFresh(input: GrokAuthFreshInput = {}): Promise<GrokAuthSnapshot> {
    const deadline = Date.now() + Math.min(6000, Math.max(1, input.deadlineMs ?? 6000));
    const minValidity = Math.max(0, input.minValiditySeconds ?? 600);
    const validation = createRunnerValidationService({ db: deps.db, keyring: deps.keyring });
    const initial = await validation.resolveCanonicalPayload('grok', input.accountId);
    const accountId = initial?.accountId ?? input.accountId;
    if (!accountId) throw new ServiceUnavailableError('No verified Grok subscription account is available', 'account_unavailable');
    if (input.refreshIfGeneration !== undefined && (!Number.isSafeInteger(input.refreshIfGeneration) || input.refreshIfGeneration < 0)) {
      throw new ConflictError('refresh_if_generation must name the observed canonical generation', 'grok_generation_conflict');
    }
    if (input.refreshIfGeneration !== undefined && (!input.sessionId || !input.sourceHostId)) {
      throw new ConflictError('Reactive Grok renewal requires a live pinned account session', 'grok_session_required');
    }
    const resolvedAccount = await resolveProviderAccount(deps.db, accountId, 'grok');
    if (!resolvedAccount || resolvedAccount.state === 'removed') throw new NotFoundError('Grok account was removed');
    const account = resolvedAccount;
    return withGrokAccountLock(deps.db, account.id, async owner => {
      const db = owner.db;
      const validation = createRunnerValidationService({ db, keyring: deps.keyring });
      const store = createCanonicalAuthStoreService({ db, keyring: deps.keyring, runnerValidation: validation, runner: deps.runner }, account.id, input.sourceHostId);
      const selectedAccount = await resolveProviderAccount(db, account.id, 'grok');
      if (!selectedAccount || selectedAccount.id !== account.id || selectedAccount.state === 'removed') throw new ConflictError('Grok account changed during renewal', 'grok_generation_conflict');
      if (input.sessionId) await assertSession(db, input, account.id);
      if (selectedAccount.state !== 'enabled' && !input.sessionId) throw new ServiceUnavailableError('Grok account is not enabled', 'account_unavailable');
      const base = await validation.resolveCanonicalPayload('grok', account.id);
      const full = validation.validateCanonicalPayload(base);
      if (!base || !full || base.verificationState !== 'verified') throw loginRequired('No verified Grok canonical login is available');
      const credential = selectGrokCredential(full.auth);
      if (!credential) throw loginRequired('Grok requires a modern subscription login');
      if (input.refreshIfGeneration !== undefined && (base.generation ?? 0) < input.refreshIfGeneration) throw new ConflictError('Observed Grok generation is newer than canonical', 'grok_generation_conflict');
      const force = input.refreshIfGeneration !== undefined && input.refreshIfGeneration === base.generation;
      let state = (await db.select().from(grokAuthRefreshState).where(eq(grokAuthRefreshState.accountId, account.id)))[0];

      async function setState(next: GrokRefreshState, extra: Partial<typeof grokAuthRefreshState.$inferInsert> = {}) {
        const values = { ...extra, state: next, updatedAt: nowIso() };
        await db.insert(grokAuthRefreshState).values({ accountId: account.id, ...values }).onDuplicateKeyUpdate({ set: values });
        state = (await db.select().from(grokAuthRefreshState).where(eq(grokAuthRefreshState.accountId, account.id)))[0];
      }
      async function audit(action: string, detail: Record<string, unknown> = {}) {
        await db.insert(logs).values({ engine: 'grok', action, details: JSON.stringify({ account_id: account.id, attempt_id: state?.attemptId, base_generation: base!.generation, ...detail }), createdAt: nowIso() });
      }
      async function snapshot(row: CanonicalPayloadRow, refreshState: GrokRefreshState): Promise<GrokAuthSnapshot> {
        if (input.sessionId) await assertSession(db, input, account.id);
        const payload = validation.validateCanonicalPayload(row);
        if (!payload || row.verificationState !== 'verified') throw loginRequired('Grok canonical login is not verified');
        const selected = selectGrokCredential(payload.auth);
        if (!selected || Date.parse(selected.expiresAt) <= Date.now() + minValidity * 1000) throw new ServiceUnavailableError('Grok bearer lifetime is insufficient for this operation', 'grok_lifetime_insufficient');
        if (input.refreshIfGeneration !== undefined && (row.generation ?? 0) <= input.refreshIfGeneration) throw new ServiceUnavailableError('Grok successor generation is not yet available', 'grok_refresh_pending');
        const metadata = grokProjectionMetadata(payload.auth) as { access_token_digest: string; expires_at: string };
        return { row, auth: projectGrokAuth(payload.auth), digest: payload.digest, last_refresh: payload.last_refresh, canonical_generation: row.generation ?? 0, ...metadata, refresh_state: refreshState };
      }
      async function verifyPending(payloadId: number) {
        const pending = (await db.select().from(authPayloads).where(eq(authPayloads.id, payloadId)))[0];
        const candidate = pending ? validation.validateCanonicalPayload(pending) : null;
        if (!pending || !candidate || pending.accountId !== account.id) {
          await setState('uncertain', { errorCode: 'candidate_missing' });
          throw unavailable('grok_refresh_uncertain');
        }
        const remaining = deadline - Date.now();
        if (remaining <= 50 || !deps.runner.verifyGrok || !deps.runner.isConfigured()) throw unavailable('grok_refresh_pending');
        const verdict = await deps.runner.verifyGrok({ authJson: projectGrokAuth(candidate.auth), timeoutSeconds: remaining / 1000 });
        if (!verdict.ok || !verdict.reachable || !verdict.definitive) {
          if (verdict.definitive && verdict.reachable) {
            await db.update(authPayloads).set({ verificationState: 'failed', verificationCheckedAt: nowIso(), verificationReason: 'Grok subscription bearer was rejected' }).where(eq(authPayloads.id, payloadId));
            await setState('login_required', { errorCode: 'bearer_rejected' });
            await audit('grok.auth.refresh.failed');
            throw loginRequired('Grok subscription renewal was rejected');
          }
          await setState('pending_verification', { errorCode: 'verification_unavailable' });
          throw unavailable('grok_refresh_pending');
        }
        if (!(await store.promoteGrokRefreshCandidate(payloadId, base!))) throw new ConflictError('Grok generation changed before renewal promotion', 'grok_generation_conflict');
        await setState('idle', { attemptId: null, basePayloadId: null, baseGeneration: null, pendingPayloadId: null, responseEnc: null, nextAttemptAt: null, errorCode: null });
        await audit('grok.auth.refresh.accepted', { payload_id: payloadId, generation: pending.generation });
        return snapshot({ ...pending, verificationState: 'verified' }, 'idle');
      }

      // Known replacement material wins over freshness of a predecessor. Resume
      // only static verification; never spend the predecessor's grant again.
      if (state?.pendingPayloadId === base.id && base.verificationState === 'verified') {
        await setState('idle', { attemptId: null, basePayloadId: null, baseGeneration: null, pendingPayloadId: null, responseEnc: null, nextAttemptAt: null, errorCode: null });
        return snapshot(base, 'idle');
      }
      if (state?.state === 'pending_verification' && state.pendingPayloadId) return verifyPending(state.pendingPayloadId);
      if (state?.state === 'refreshing' && !state.responseEnc) {
        await setState('uncertain', { errorCode: 'owner_lost_after_intent' });
        await audit('grok.auth.refresh.uncertain');
      }
      if (!force && !state?.responseEnc && Date.parse(credential.expiresAt) > Date.now() + minValidity * 1000) {
        return snapshot(base, (state?.state ?? 'idle') as GrokRefreshState);
      }
      if (state?.state === 'uncertain' && !state.responseEnc) throw unavailable('grok_refresh_uncertain');
      if (state?.state === 'login_required') throw loginRequired('Grok subscription login must be renewed');
      if (state?.nextAttemptAt && Date.parse(state.nextAttemptAt) > Date.now()) throw unavailable('grok_refresh_transient');

      let body: string;
      let receivedAt: string;
      if (state?.responseEnc) {
        try {
          const capture = JSON.parse(decrypt(state.responseEnc, deps.keyring)) as { body: string; received_at: string };
          body = capture.body;
          receivedAt = capture.received_at;
        } catch {
          await setState('uncertain', { errorCode: 'response_unreadable' });
          throw unavailable('grok_refresh_uncertain');
        }
      } else {
        if (!credential.refresh) {
          await setState('login_required', { errorCode: 'refresh_token_missing' });
          throw loginRequired('Grok subscription refresh token is missing');
        }
        const endpoint = await discoverEndpoint(request, deadline);
        await setState('refreshing', { attemptId: randomUUID(), basePayloadId: base.id, baseGeneration: base.generation, pendingPayloadId: null, responseEnc: null, errorCode: null, nextAttemptAt: null, startedAt: nowIso() });
        await audit('grok.auth.refresh.started');
        let response: Response;
        try {
          response = await request(endpoint, { method: 'POST', redirect: 'error', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: credential.refresh, client_id: credential.clientId }), signal: AbortSignal.timeout(Math.max(1, Math.min(3500, deadline - Date.now()))) });
          body = await response.text();
        } catch {
          await setState('uncertain', { errorCode: 'transport_outcome_unknown' });
          await audit('grok.auth.refresh.uncertain');
          throw unavailable('grok_refresh_uncertain');
        }
        receivedAt = nowIso();
        if (!response.ok) {
          let error = '';
          try { error = String((JSON.parse(body) as { error?: unknown }).error ?? ''); } catch { /* ambiguous upstream body */ }
          if (error === 'invalid_grant' || error === 'invalid_client') {
            await setState('login_required', { errorCode: error });
            await audit('grok.auth.refresh.failed');
            throw loginRequired('Grok subscription refresh grant was rejected');
          }
          if (error === 'temporarily_unavailable' || error === 'server_error' || response.status === 429) {
            const retry = Number(response.headers.get('retry-after'));
            await setState('idle', { errorCode: error || 'rate_limited', nextAttemptAt: new Date(Date.now() + Math.min(60, Number.isFinite(retry) && retry > 0 ? retry : 5) * 1000).toISOString() });
            await audit('grok.auth.refresh.transient');
            throw unavailable('grok_refresh_transient');
          }
          await setState('uncertain', { errorCode: 'provider_outcome_unknown' });
          await audit('grok.auth.refresh.uncertain');
          throw unavailable('grok_refresh_uncertain');
        }
        // Rotation has happened. Capture before parsing, checking identity or
        // calling the runner, so later failures cannot discard replacement RTs.
        await setState('refreshing', { responseEnc: encrypt(JSON.stringify({ body, received_at: receivedAt }), deps.keyring) });
      }

      let replacement: Record<string, unknown>;
      try {
        const token = JSON.parse(body) as Record<string, unknown>;
        if (typeof token.access_token !== 'string' || token.access_token.trim().length < 8 || typeof token.expires_in !== 'number' || !Number.isFinite(token.expires_in) || token.expires_in <= 0) throw new Error('invalid response');
        if (token.refresh_token !== undefined && (typeof token.refresh_token !== 'string' || !token.refresh_token.trim())) throw new Error('invalid refresh response');
        const native = structuredClone(grokNativeAuth(full.auth));
        native[credential.scope] = { ...credential.native, key: token.access_token, refresh_token: token.refresh_token ?? credential.refresh, create_time: receivedAt, expires_at: new Date(Date.parse(receivedAt) + token.expires_in * 1000).toISOString(), auth_mode: 'oidc', oidc_issuer: GROK_OIDC_ISSUER, oidc_client_id: credential.clientId };
        replacement = normalizeGrokAuth({ last_refresh: new Date(Math.max(Date.parse(receivedAt), Date.parse(full.last_refresh) + 1)).toISOString(), grok_auth: native }, true);
      } catch {
        await setState('uncertain', { errorCode: 'response_invalid' });
        throw unavailable('grok_refresh_uncertain');
      }
      const pending = await store.recordGrokRefreshCandidate(replacement, base);
      await setState('pending_verification', { pendingPayloadId: pending.id });
      return verifyPending(pending.id);
    }, deadline);
  }

  return { ensureFresh };
}

async function assertSession(db: Database, input: GrokAuthFreshInput, accountId: number) {
  if (!input.sourceHostId || !input.sessionId) throw new ConflictError('Grok account session is required', 'grok_session_required');
  const rows = await db.select().from(providerAccountSessions).where(and(eq(providerAccountSessions.id, input.sessionId), eq(providerAccountSessions.hostId, input.sourceHostId), eq(providerAccountSessions.engine, 'grok'), eq(providerAccountSessions.accountId, accountId), gt(providerAccountSessions.expiresAt, nowIso()))).limit(1);
  if (!rows.length) throw new NotFoundError('Account session not found');
}

async function discoverEndpoint(request: typeof fetch, deadline: number): Promise<string> {
  if (discovery && discovery.until > Date.now()) return discovery.endpoint;
  try {
    const response = await request(`${GROK_OIDC_ISSUER}/.well-known/openid-configuration`, { redirect: 'error', headers: { accept: 'application/json' }, signal: AbortSignal.timeout(Math.max(1, Math.min(1000, deadline - Date.now()))) });
    if (!response.ok) throw new Error('discovery unavailable');
    const document = await response.json() as { issuer?: string; token_endpoint?: string };
    if (document.issuer !== GROK_OIDC_ISSUER || !document.token_endpoint || new URL(document.token_endpoint).origin !== GROK_OIDC_ISSUER) throw new Error('invalid issuer metadata');
    discovery = { endpoint: document.token_endpoint, until: Date.now() + 3600_000 };
    return discovery.endpoint;
  } catch { throw unavailable('grok_refresh_transient'); }
}

function unavailable(code: 'grok_refresh_pending' | 'grok_refresh_transient' | 'grok_refresh_uncertain') {
  return new ServiceUnavailableError(code === 'grok_refresh_uncertain' ? 'Grok refresh outcome is uncertain; a new subscription login is required' : 'A fresh Grok subscription bearer is not yet available', code);
}
function loginRequired(message: string) { return new ApiError(message, { status: 401, code: 'grok_login_required' }); }
