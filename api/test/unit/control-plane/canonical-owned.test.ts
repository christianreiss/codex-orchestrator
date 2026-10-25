import { randomUUID } from 'node:crypto';
import { describe, it, expect, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import type { Database } from '../../../src/db/client.js';
import type { RunnerVerifyResult } from '../../../src/services/runner-client.js';
import { decrypt, encrypt } from '../../../src/security/secret-box.js';
import { setOwnedGrokState } from '../../../src/control-plane/streams/canonical-state.js';
import { mutateOwnerState, setOwnerRequestPrincipal, withOwnerRequestScope, withOwnerBackgroundScope } from '../../../src/control-plane/state/runtime.js';
import { stageUpdate } from '../../../src/control-plane/state/rows.js';
import * as schema from '../../../src/db/schema.js';
import { ForbiddenError } from '../../../src/http/errors.js';
import { CommandExecutor, OwnerUnavailableError } from '../../../src/control-plane/commands.js';
import { DeadlineQueue } from '../../../src/control-plane/deadlines.js';
import {
  OwnerStateSnapshot,
  OwnerStateStore,
  type PreparedOwnerState,
} from '../../../src/control-plane/state/store.js';
import { bindOwnerRuntime, type OwnerRuntime } from '../../../src/control-plane/state/runtime.js';
import type { PersistenceTransaction } from '../../../src/control-plane/persistence.js';
import type { StateSeed } from '../../../src/control-plane/state/catalog.js';
import { createDbFake } from '../../helpers/db-fake.js';
import { testKeyring } from '../../helpers/test-keyring.js';
import { createCanonicalAuthStoreService } from '../../../src/services/canonical-auth-store.js';
import { createRunnerValidationService } from '../../../src/services/runner-validation.js';
import { withGrokAccountLock } from '../../../src/services/grok-auth-lock.js';
import { createGrokAuthOwner } from '../../../src/services/grok-auth-owner.js';
import { bindOwnerPresence, ConnectionPresence } from '../../../src/control-plane/presence.js';
import { GROK_AUTH_SCOPE, GROK_OIDC_CLIENT_ID, GROK_OIDC_ISSUER } from '../../../src/services/grok-auth.js';
import { ProviderAccountsService } from '../../../src/services/provider-accounts.js';

function fixture(extra: StateSeed = {}) {
  const seed = {
    providerAccounts: [
      {
        id: 1,
        engine: 'claude',
        label: 'fixture',
        state: 'enabled',
        payloadId: null,
        generation: 0,
        mergedIntoAccountId: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ],
    ...extra,
  };
  const db = createDbFake(new Map(Object.entries(seed).map(([name, rows]) => [
    (schema as unknown as Record<string, unknown>)[name], structuredClone([...rows]) as Record<string, unknown>[],
  ])));
  const state = new OwnerStateStore(
    new OwnerStateSnapshot({ epoch: randomUUID(), sequence: 0n }, seed as unknown as StateSeed),
  );
  const deadlines = new DeadlineQueue((e) => {
    throw e;
  });
  const executor = new CommandExecutor<OwnerStateSnapshot, PersistenceTransaction, PreparedOwnerState>({
    state,
    assertOwner() {},
    loseOwner(e) {
      throw e;
    },
    committed() {},
    notificationError(e) {
      throw e;
    },
    persistence: {
      async receipt() {
        return undefined;
      },
      async transaction(run) {
        await run(db as unknown as PersistenceTransaction);
      },
      async record() {},
    },
  });
  const runtime: OwnerRuntime = {
    state,
    deadlines,
    assertOwner() {},
    execute: (command) => executor.execute(command),
  };
  bindOwnerRuntime(db, runtime);
  bindOwnerPresence(runtime, new ConnectionPresence((error) => { throw error; }));
  return { db: db as never, state, runtime, close: () => deadlines.close() };
}
const candidate = {
  last_refresh: '2026-05-20T09:00:00Z',
  auths: { 'api.anthropic.com': { token: 'sk-ant-oat01-owner-a' } },
  claudeAiOauth: {
    accessToken: 'sk-ant-oat01-owner-a',
    refreshToken: 'owner-refresh-a',
    expiresAt: Date.now() + 86400000,
    refreshTokenExpiresAt: Date.now() + 86400000 * 30,
  },
};
async function grokRefreshFixture() {
  const h = fixture({ providerAccounts: [{ id: 1, engine: 'grok', label: 'fixture', state: 'enabled', payloadId: null, generation: 0 } as never] });
  const db = h.db as Database, keyring = testKeyring();
  const verified: RunnerVerifyResult = { ok: true, status: 'ok', reachable: true, definitive: true };
  const runner = { isConfigured: () => true,
    verify: async () => verified, verifyClaude: async () => verified,
    verifyGrok: vi.fn(async (_input: unknown): Promise<RunnerVerifyResult> => verified) };
  const validation = createRunnerValidationService({ db, keyring });
  const store = createCanonicalAuthStoreService({ db, keyring, runnerValidation: validation, runner }, 1);
  await store.storeCandidate({ engine: 'grok', accountId: 1, sourceHostId: null, requireLastRefresh: false,
    logAction: 'owner.test', auth: { [GROK_AUTH_SCOPE]: {
      auth_mode: 'oidc', key: 'fixture-grok-predecessor-access-token', refresh_token: 'fixture-grok-predecessor-refresh-token',
      create_time: new Date().toISOString(), expires_at: new Date(Date.now() + 300000).toISOString(),
      oidc_issuer: GROK_OIDC_ISSUER, oidc_client_id: GROK_OIDC_CLIENT_ID, user_id: 'fixture-user',
    } } });
  runner.verifyGrok.mockClear();
  const base = (await validation.resolveCanonicalPayload('grok', 1))!;
  const replacement = { access_token: 'fixture-grok-successor-access-token', refresh_token: 'fixture-grok-successor-refresh-token', expires_in: 7200 };
  let refresh = async () => new Response(JSON.stringify(replacement), { status: 200 });
  const spend = vi.fn();
  const request: typeof fetch = async url => {
    if (String(url).endsWith('/.well-known/openid-configuration'))
      return new Response(JSON.stringify({ issuer: GROK_OIDC_ISSUER, token_endpoint: `${GROK_OIDC_ISSUER}/oauth/token` }));
    expect(String(url)).toBe(`${GROK_OIDC_ISSUER}/oauth/token`);
    spend();
    return refresh();
  };
  const owner = createGrokAuthOwner({ db, keyring, runner, fetchImpl: request });
  const ledger = async () => (await db.select().from(schema.grokAuthRefreshState).where(eq(schema.grokAuthRefreshState.accountId, 1)))[0]!;
  return { ...h, db, keyring, runner, verified, validation, base, replacement, spend, owner, ledger,
    setRefresh: (callback: typeof refresh) => { refresh = callback; } };
}

describe('canonical credentials under one owner', () => {
  it('captures an owned Grok rotation before verification and promotes it without replay', async () => {
    const h = await grokRefreshFixture();
    try {
      h.runner.verifyGrok.mockImplementation(async input => {
        const state = await h.ledger();
        expect(state).toMatchObject({ state: 'pending_verification', basePayloadId: h.base.id, baseGeneration: h.base.generation });
        expect(JSON.parse(decrypt(state.responseEnc!, h.keyring)).body).toContain(h.replacement.refresh_token);
        expect(JSON.stringify(input)).not.toContain('refresh_token');
        return h.verified;
      });
      const result = await h.owner.ensureFresh({ accountId: 1 });
      expect(result.canonical_generation).toBe(h.base.generation! + 1);
      expect(h.spend).toHaveBeenCalledOnce();
      expect(await h.ledger()).toMatchObject({ state: 'idle', responseEnc: null });
      expect(h.state.snapshot().table('grokAuthRefreshState').get(1)).not.toHaveProperty('responseEnc');
    } finally { h.close(); }
  });

  it('keeps owned response material through runner outage and retries only static verification', async () => {
    const h = await grokRefreshFixture();
    try {
      h.runner.verifyGrok.mockResolvedValue({ ok: false, status: 'fail', reachable: false, definitive: false });
      await expect(h.owner.ensureFresh({ accountId: 1 })).rejects.toMatchObject({ code: 'grok_refresh_pending' });
      const pending = await h.ledger();
      expect(pending.state).toBe('pending_verification');
      expect(JSON.parse(decrypt(pending.responseEnc!, h.keyring)).body).toContain(h.replacement.refresh_token);
      h.runner.verifyGrok.mockResolvedValue(h.verified);
      expect((await h.owner.ensureFresh({ accountId: 1 })).canonical_generation).toBe(h.base.generation! + 1);
      expect(h.spend).toHaveBeenCalledOnce();
    } finally { h.close(); }
  });

  it('retains a known owned response across head advancement but never promotes it against the newer base', async () => {
    const h = await grokRefreshFixture();
    try {
      h.setRefresh(async () => {
        const previous = (await h.db.select().from(schema.authPayloads).where(eq(schema.authPayloads.id, h.base.id)))[0]!;
        const successor = { ...previous, id: previous.id + 100, generation: previous.generation! + 1 };
        await mutateOwnerState(h.runtime, { kind: 'fixture.advance-grok-head', payload: {}, prepare(c) {
          c.draft.upsert('authPayloads', successor);
          c.write(tx => tx.insert(schema.authPayloads).values(successor));
          stageUpdate(c, 'providerAccounts', 1, { payloadId: successor.id, generation: successor.generation });
          stageUpdate(c, 'authCanonicalHeads', 'grok', { payloadId: successor.id, generation: successor.generation });
          return null;
        } });
        return new Response(JSON.stringify(h.replacement), { status: 200 });
      });
      await expect(h.owner.ensureFresh({ accountId: 1 })).rejects.toMatchObject({ code: 'grok_generation_conflict' });
      const captured = await h.ledger();
      expect(JSON.parse(decrypt(captured.responseEnc!, h.keyring)).body).toContain(h.replacement.refresh_token);
      const current = h.state.snapshot().accounts.get(1)!;
      expect(current.payloadId).toBe(h.base.id + 100);
      await expect(h.owner.ensureFresh({ accountId: 1 })).rejects.toMatchObject({ code: 'grok_generation_conflict' });
      expect(h.state.snapshot().accounts.get(1)?.payloadId).toBe(current.payloadId);
      expect((await h.ledger()).responseEnc).toBe(captured.responseEnc);
      expect(h.spend).toHaveBeenCalledOnce();
      expect(h.runner.verifyGrok).not.toHaveBeenCalled();
    } finally { h.close(); }
  });

  it('captures malformed successful response bytes before parsing and never spends the predecessor again', async () => {
    const h = await grokRefreshFixture();
    try {
      h.setRefresh(async () => new Response('fixture-invalid-json-success', { status: 200 }));
      for (let attempt = 0; attempt < 2; attempt++)
        await expect(h.owner.ensureFresh({ accountId: 1 })).rejects.toMatchObject({ code: 'grok_refresh_uncertain' });
      const captured = await h.ledger();
      expect(captured).toMatchObject({ state: 'uncertain', errorCode: 'response_invalid' });
      expect(JSON.parse(decrypt(captured.responseEnc!, h.keyring)).body).toBe('fixture-invalid-json-success');
      expect(h.spend).toHaveBeenCalledOnce();
      expect(h.runner.verifyGrok).not.toHaveBeenCalled();
    } finally { h.close(); }
  });

  it.each([true, false])('never overwrites already captured response material (owned=%s)', async owned => {
    const h = await grokRefreshFixture();
    try {
      const proof = { attemptId: 'write-once-attempt', basePayloadId: h.base.id, baseGeneration: h.base.generation! };
      const legacy = createDbFake(new Map([[schema.grokAuthRefreshState, [{ accountId: 1, state: 'refreshing', ...proof, responseEnc: null }]]]));
      const db = owned ? h.db : legacy as unknown as Database;
      if (owned) await setOwnedGrokState(db, 1, { state: 'refreshing', ...proof, responseEnc: null });
      const original = encrypt('fixture-first-response', h.keyring);
      await setOwnedGrokState(db, 1, { state: 'refreshing', ...proof, responseEnc: original });
      await expect(setOwnedGrokState(db, 1, { state: 'refreshing', ...proof, responseEnc: encrypt('fixture-late-response', h.keyring) }))
        .rejects.toMatchObject({ code: 'grok_generation_conflict' });
      const row = (await db.select().from(schema.grokAuthRefreshState).where(eq(schema.grokAuthRefreshState.accountId, 1)))[0]!;
      expect(row.responseEnc).toBe(original);
      expect(h.spend).not.toHaveBeenCalled();
    } finally { h.close(); }
  });

  it('conserves an already rotated response after caller revocation while denying promotion and disclosure', async () => {
    const h = await grokRefreshFixture();
    let authorized = true;
    const call = () => withOwnerRequestScope(async () => {
      setOwnerRequestPrincipal({ principal: 'fixture:revocable-caller', revalidate() {
        if (!authorized) throw new ForbiddenError('Fixture caller revoked', 'fixture_caller_revoked');
      } });
      return h.owner.ensureFresh({ accountId: 1 });
    });
    try {
      h.setRefresh(async () => {
        authorized = false; // Request was admitted and the provider spent its RT.
        return new Response(JSON.stringify(h.replacement), { status: 200 });
      });
      await expect(call()).rejects.toMatchObject({ status: 403, code: 'fixture_caller_revoked' });
      const captured = await h.ledger();
      expect(JSON.parse(decrypt(captured.responseEnc!, h.keyring)).body).toContain(h.replacement.refresh_token);
      expect((await h.validation.resolveCanonicalPayload('grok', 1))?.id).toBe(h.base.id);
      expect(h.runner.verifyGrok).not.toHaveBeenCalled();
      authorized = true;
      expect((await call()).canonical_generation).toBe(h.base.generation! + 1);
      expect(h.spend).toHaveBeenCalledOnce();
    } finally { h.close(); }
  });

  it('does not let conservation scope authorize the initial provider spend', async () => {
    const h = await grokRefreshFixture();
    try {
      await expect(withOwnerRequestScope(async () => {
        setOwnerRequestPrincipal({ principal: 'fixture:revoked-before-intent', revalidate() {
          throw new ForbiddenError('Fixture caller revoked', 'fixture_caller_revoked');
        } });
        return h.owner.ensureFresh({ accountId: 1 });
      })).rejects.toMatchObject({ status: 403 });
      expect(h.spend).not.toHaveBeenCalled();
      expect(await h.ledger()).toMatchObject({ state: 'idle', responseEnc: null });
    } finally { h.close(); }
  });

  it.each(['owner_lost', 'account_removed'])('keeps %s fenced while conserving a known response', async failure => {
    const h = await grokRefreshFixture();
    try {
      h.setRefresh(async () => {
        if (failure === 'owner_lost') h.runtime.assertOwner = () => { throw new OwnerUnavailableError('fixture owner lost'); };
        else await withOwnerBackgroundScope(() => mutateOwnerState(h.runtime, {
          kind: 'fixture.remove-grok-account', payload: {}, prepare(c) {
            stageUpdate(c, 'providerAccounts', 1, { state: 'removed' }); return null;
          },
        }));
        return new Response(JSON.stringify(h.replacement), { status: 200 });
      });
      const result = h.owner.ensureFresh({ accountId: 1 });
      if (failure === 'owner_lost') await expect(result).rejects.toThrow('fixture owner lost');
      else await expect(result).rejects.toMatchObject({ code: 'grok_generation_conflict' });
      expect((await h.ledger()).responseEnc).toBeNull();
      expect(h.spend).toHaveBeenCalledOnce();
      expect(h.runner.verifyGrok).not.toHaveBeenCalled();
    } finally { h.close(); }
  });

  it('keeps the initial owned refresh intent fenced to the current canonical generation', async () => {
    const h = await grokRefreshFixture();
    try {
      await expect(setOwnedGrokState(h.db, 1, { state: 'refreshing', attemptId: 'wrong-base',
        basePayloadId: h.base.id, baseGeneration: h.base.generation! + 1, responseEnc: null }))
        .rejects.toMatchObject({ code: 'grok_generation_conflict' });
      expect(await h.ledger()).toMatchObject({ state: 'idle', responseEnc: null });
      expect(h.spend).not.toHaveBeenCalled();
    } finally { h.close(); }
  });

  it.each(['accountId', 'attemptId', 'basePayloadId', 'baseGeneration', 'state', 'missing'])(
    'rejects response capture for a mismatched owned %s without overwriting the ledger', async field => {
      const h = await grokRefreshFixture();
      try {
        const proof = { attemptId: 'expected-attempt', basePayloadId: h.base.id, baseGeneration: h.base.generation! };
        await setOwnedGrokState(h.db, 1, { state: 'refreshing', ...proof, responseEnc: null });
        if (field === 'state' || field === 'missing') {
          await mutateOwnerState(h.runtime, { kind: 'fixture.change-grok-attempt', payload: {}, prepare(c) {
            if (field === 'missing') { c.draft.remove('grokAuthRefreshState', 1); c.write(tx => tx.delete(schema.grokAuthRefreshState).where(eq(schema.grokAuthRefreshState.accountId, 1))); }
            else stageUpdate(c, 'grokAuthRefreshState', 1, { state: 'uncertain' });
            return null;
          } });
        }
        const patch = { state: 'refreshing', ...proof, responseEnc: encrypt('fixture-known-response', h.keyring),
          ...(field === 'accountId' ? { accountId: 2 } : {}),
          ...(field === 'attemptId' ? { attemptId: 'wrong-attempt' } : {}),
          ...(field === 'basePayloadId' ? { basePayloadId: h.base.id + 1 } : {}),
          ...(field === 'baseGeneration' ? { baseGeneration: h.base.generation! + 1 } : {}) };
        await expect(setOwnedGrokState(h.db, 1, patch)).rejects.toMatchObject({ code: 'grok_generation_conflict' });
        expect((await h.ledger())?.responseEnc ?? null).toBeNull();
        expect(h.spend).not.toHaveBeenCalled();
      } finally { h.close(); }
    },
  );

  it('keeps renewable timed grants for legacy clients and preserves ownership on retries', async () => {
    const h = fixture({
      providerAccounts: [{ id: 1, engine: 'grok', label: 'fixture', state: 'enabled', payloadId: 2, generation: 1 } as never],
      authPayloads: [{ id: 2, accountId: 1, engine: 'grok', verificationState: 'verified' } as never],
    });
    try {
      const accounts = new ProviderAccountsService(h.db, testKeyring());
      await accounts.acquire(7, 'grok', 'scope', 'legacy-session', 95, 1, 'timed');
      expect(h.state.snapshot().table('providerAccountSessions').get('legacy-session')?.ownershipMode).toBe('timed');
      await expect(accounts.heartbeat(7, 'grok', 'legacy-session')).resolves.toMatchObject({ account_id: 1 });
      await accounts.acquire(7, 'grok', 'scope', 'legacy-session', 95, 1, 'connection');
      expect(h.state.snapshot().table('providerAccountSessions').get('legacy-session')?.ownershipMode).toBe('timed');
      await accounts.acquire(7, 'grok', 'scope', 'modern-session', 95, 1, 'connection');
      await accounts.acquire(7, 'grok', 'scope', 'modern-session', 95, 1, 'timed');
      expect(h.state.snapshot().table('providerAccountSessions').get('modern-session')?.ownershipMode).toBe('connection');
    } finally { h.close(); }
  });

  it('returns initial Grok auth before its provider stream exists, without relaxing later renewals', async () => {
    const h = fixture({
      providerAccounts: [{ id: 1, engine: 'grok', label: 'fixture', state: 'enabled', payloadId: null, generation: 0 } as never],
      providerAccountSessions: [{ id: 'bootstrap', hostId: 7, engine: 'grok', accountId: 1, scopeId: 'fixture', ownershipMode: 'connection', expiresAt: new Date(Date.now() + 300000).toISOString(), createdAt: new Date().toISOString() }],
    });
    try {
      const keyring = testKeyring();
      const runner = {
        isConfigured: () => true,
        verify: async () => ({ ok: true, status: 'ok' as const, reachable: true, definitive: true }),
        verifyClaude: async () => ({ ok: true, status: 'ok' as const, reachable: true, definitive: true }),
        verifyGrok: async () => ({ ok: true, status: 'ok' as const, reachable: true, definitive: true }),
      };
      const store = createCanonicalAuthStoreService({ db: h.db, keyring, runnerValidation: createRunnerValidationService({ db: h.db, keyring }), runner });
      await store.storeCandidate({ engine: 'grok', accountId: 1, sourceHostId: null, requireLastRefresh: false, logAction: 'owner.test', auth: {
        [GROK_AUTH_SCOPE]: { auth_mode: 'oidc', key: 'fixture-grok-access-token-123456789', refresh_token: 'fixture-grok-refresh-token-123456789', create_time: new Date().toISOString(), expires_at: new Date(Date.now() + 7200000).toISOString(), oidc_issuer: GROK_OIDC_ISSUER, oidc_client_id: GROK_OIDC_CLIENT_ID, user_id: 'fixture-user' },
      } });
      const owner = createGrokAuthOwner({ db: h.db, keyring, runner });
      const input = { accountId: 1, sourceHostId: 7, sessionId: 'bootstrap' };
      await expect(owner.ensureFresh(input)).rejects.toMatchObject({ status: 404 });
      const result = await owner.ensureFresh({ ...input, bootstrapSession: true });
      expect(JSON.stringify(result.auth)).toContain('fixture-grok-access-token');
      expect(JSON.stringify(result.auth)).not.toContain('fixture-grok-refresh-token');
      await expect(owner.ensureFresh({ ...input, sourceHostId: 8, bootstrapSession: true })).rejects.toMatchObject({ status: 404 });
      await expect(owner.ensureFresh({ ...input, bootstrapSession: true, refreshIfGeneration: result.canonical_generation })).rejects.toMatchObject({ status: 404 });
      const draft = h.state.begin();
      draft.upsert('providerAccountSessions', { ...draft.table('providerAccountSessions').get('bootstrap')!, expiresAt: new Date(Date.now() - 1).toISOString() });
      h.state.publish(draft.seal({ ...h.state.revision(), sequence: h.state.revision().sequence + 1n }));
      await expect(owner.ensureFresh({ ...input, bootstrapSession: true })).rejects.toMatchObject({ status: 404 });
    } finally { h.close(); }
  });

  it('publishes verified generation, account and head atomically without retaining credential bytes', async () => {
    const h = fixture();
    try {
      const keyring = testKeyring();
      const runner = {
        isConfigured: () => true,
        verify: async () => ({ ok: true, status: 'ok' as const, reachable: true }),
        verifyClaude: async () => ({ ok: true, status: 'ok' as const, reachable: true }),
      };
      const store = createCanonicalAuthStoreService({
        db: h.db,
        keyring,
        runnerValidation: createRunnerValidationService({ db: h.db, keyring }),
        runner,
      });
      const result = await store.storeCandidate({
        accountId: 1,
        engine: 'claude',
        auth: candidate,
        sourceHostId: null,
        requireLastRefresh: true,
        logAction: 'owner.test',
      });
      expect(result.status).toBe('updated');
      const snapshot = h.state.snapshot();
      const payload = snapshot.table('authPayloads').get(result.pending_payload_id)!;
      expect(payload.verificationState).toBe('verified');
      expect(payload).not.toHaveProperty('body');
      expect(snapshot.accounts.get(1)?.payloadId).toBe(payload.id);
      expect(snapshot.table('authCanonicalHeads').get('claude')?.payloadId).toBe(payload.id);
      const reread = await createRunnerValidationService({ db: h.db, keyring }).resolveCanonicalPayload(
        'claude',
        1,
      );
      expect(reread?.id).toBe(payload.id);
      expect(reread?.body).toBeTruthy();
      expect(
        (
          await store.storeCandidate({
            accountId: 1,
            engine: 'claude',
            auth: candidate,
            sourceHostId: null,
            requireLastRefresh: true,
            logAction: 'owner.test',
          })
        ).pending_payload_id,
      ).toBe(payload.id);
    } finally {
      h.close();
    }
  });
  it('does not let a timed-out waiter remove the live Grok refresh lock', async () => {
    const h = fixture();
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let began = false;
    try {
      const first = withGrokAccountLock(h.db, 1, async () => {
        began = true;
        await held;
      });
      while (!began) await Promise.resolve();
      await expect(withGrokAccountLock(h.db, 1, async () => {}, Date.now() + 5)).rejects.toThrow('pending');
      let thirdEntered = false;
      const third = withGrokAccountLock(h.db, 1, async () => {
        thirdEntered = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(thirdEntered).toBe(false);
      release();
      await first;
      await third;
      expect(thirdEntered).toBe(true);
    } finally {
      release?.();
      h.close();
    }
  });
});
