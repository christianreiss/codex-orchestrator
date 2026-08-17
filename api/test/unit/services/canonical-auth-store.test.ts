import { describe, expect, it, vi } from 'vitest';
import {
  createCanonicalAuthStoreService,
  touchHostAuthState,
} from '../../../src/services/canonical-auth-store.js';
import { ServiceUnavailableError, ValidationError } from '../../../src/http/errors.js';
import { createRunnerValidationService } from '../../../src/services/runner-validation.js';
import type {
  RunnerClient,
  RunnerVerifyInput,
  RunnerVerifyResult,
} from '../../../src/services/runner-client.js';
import { authCanonicalHeads, authEntries, authPayloads, hostAuthStates } from '../../../src/db/schema.js';
import { decryptOrNull, encrypt } from '../../../src/security/secret-box.js';
import { sha256 } from '../../../src/security/hash.js';
import { Keyring } from '../../../src/security/keyring.js';
import { createDbFake } from '../../helpers/db-fake.js';
import { runAuthVerificationWorkerTick } from '../../../src/ops/auth-verification-worker.js';
import { credentialMetadata, inspectCredential } from '../../../src/services/auth-generation.js';

function makeKeyring(): Keyring {
  return Keyring.fromEnv({
    ENCRYPTION_ACTIVE_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
  } as unknown as Parameters<typeof Keyring.fromEnv>[0]);
}

function runner(verdict: RunnerVerifyResult): RunnerClient {
  return {
    isConfigured: () => true,
    verify: async (_input: RunnerVerifyInput) => verdict,
    verifyClaude: async (_input: RunnerVerifyInput) => verdict,
  };
}

function countingRunner(
  verdict: RunnerVerifyResult,
  configured = true,
): { client: RunnerClient; calls: () => number } {
  let calls = 0;
  const probe = async (_input: RunnerVerifyInput) => {
    calls += 1;
    return verdict;
  };
  return {
    client: { isConfigured: () => configured, verify: probe, verifyClaude: probe },
    calls: () => calls,
  };
}

const CLAUDE_AUTH = {
  last_refresh: '2026-05-20T09:00:00Z',
  auths: { 'api.anthropic.com': { token: 'sk-ant-oat01-base-token' } },
  claudeAiOauth: { accessToken: 'sk-ant-oat01-a', refreshToken: 'r1' },
};
const CLAUDE_CANONICAL_AUTH = {
  ...CLAUDE_AUTH,
  auths: {
    'api.anthropic.com': {
      token: CLAUDE_AUTH.claudeAiOauth.accessToken,
      token_type: 'bearer',
    },
  },
};
const CLAUDE_CANONICAL_BODY = JSON.stringify(CLAUDE_CANONICAL_AUTH);
const CLAUDE_CANONICAL_DIGEST = sha256(CLAUDE_CANONICAL_BODY);

const CODEX_AUTH = {
  last_refresh: '2026-05-20T09:00:00Z',
  auths: { 'api.openai.com': { token: 'sk-openai-base-token' } },
  tokens: { access_token: 'sk-openai-base-token', refresh_token: 'r1' },
};

function makeStore(client: RunnerClient, seedState = 'pending') {
  const db = createDbFake();
  db.tables.set(authPayloads, [
    {
      id: 1,
      lastRefresh: CLAUDE_AUTH.last_refresh,
      sha256: CLAUDE_CANONICAL_DIGEST,
      sourceHostId: null,
      createdAt: CLAUDE_AUTH.last_refresh,
      body: encrypt(CLAUDE_CANONICAL_BODY, makeKeyring()),
      verificationState: seedState,
      verificationCheckedAt: null,
      verificationReason: null,
      engine: 'claude',
      generation: 1,
    },
  ]);
  db.tables.set(authCanonicalHeads, [
    { engine: 'claude', payloadId: 1, generation: 1, updatedAt: CLAUDE_AUTH.last_refresh },
  ]);
  db.tables.set(authEntries, []);
  const keyring = makeKeyring();
  const svc = createCanonicalAuthStoreService({
    db: db as never,
    keyring,
    runnerValidation: createRunnerValidationService({ db: db as never, keyring }),
    runner: client,
  });
  return { db, svc };
}

describe('CanonicalAuthStoreService', () => {
  it('persists only the runner-verified engine-native auth target', async () => {
    const db = createDbFake();
    db.tables.set(authPayloads, []);
    db.tables.set(authEntries, []);
    const keyring = makeKeyring();
    const live = countingRunner({ ok: true, status: 'ok', reachable: true });
    const svc = createCanonicalAuthStoreService({
      db: db as never,
      keyring,
      runnerValidation: createRunnerValidationService({ db: db as never, keyring }),
      runner: live.client,
    });
    const nativeToken = 'sk-openai-native-api-key-token-123';

    const stored = await svc.storeCandidate({
      auth: {
        last_refresh: CODEX_AUTH.last_refresh,
        OPENAI_API_KEY: nativeToken,
        auths: {
          'api.openai.com': { token: nativeToken },
          'unverified.example': { token: 'unverified-extra-token-123' },
        },
      },
      engine: 'codex',
      sourceHostId: null,
      requireLastRefresh: true,
      logAction: 'auth.store',
    });

    expect(stored.status).toBe('updated');
    expect(stored.auth?.auths).toEqual({
      'api.openai.com': { token: nativeToken, token_type: 'bearer' },
    });
    expect(db.tables.get(authEntries)).toMatchObject([{ target: 'api.openai.com' }]);
    expect(db.tables.get(authEntries)).toHaveLength(1);
    expect(live.calls()).toBe(1);
  });

  it('rejects an exact superseded Claude token pair before runner verification', async () => {
    const db = createDbFake();
    db.tables.set(authPayloads, []);
    db.tables.set(authEntries, []);
    const keyring = makeKeyring();
    const live = countingRunner({ ok: true, status: 'ok', reachable: true });
    const svc = createCanonicalAuthStoreService({
      db: db as never,
      keyring,
      runnerValidation: createRunnerValidationService({ db: db as never, keyring }),
      runner: live.client,
    });
    // Live (unexpired) tokens: pair-identity replay ordering is what this
    // test pins, and an expired access token would trip the no-probe gate
    // covered by the 'claude expired-access probe gates' suite instead.
    const old = {
      ...CLAUDE_AUTH,
      claudeAiOauth: {
        accessToken: 'sk-ant-oat01-history-a',
        refreshToken: 'history-r1',
        expiresAt: Date.now() + 24 * 3600 * 1000,
        refreshTokenExpiresAt: Date.now() + 30 * 24 * 3600 * 1000,
      },
    };
    const newer = {
      ...CLAUDE_AUTH,
      last_refresh: '2026-05-20T10:00:00Z',
      claudeAiOauth: {
        accessToken: 'sk-ant-oat01-history-b',
        refreshToken: 'history-r2',
        expiresAt: Date.now() + 2 * 24 * 3600 * 1000,
        refreshTokenExpiresAt: Date.now() + 31 * 24 * 3600 * 1000,
      },
    };
    const first = await svc.storeCandidate({
      auth: old,
      engine: 'claude',
      sourceHostId: null,
      requireLastRefresh: true,
      logAction: 'test',
      sourceKind: 'admin',
    });
    const second = await svc.storeCandidate({
      auth: newer,
      engine: 'claude',
      sourceHostId: null,
      requireLastRefresh: true,
      logAction: 'test',
      sourceKind: 'admin',
    });
    expect(first.status).toBe('updated');
    expect(second.status).toBe('updated');
    const beforeReplay = live.calls();
    const replay = await svc.storeCandidate({
      auth: { ...old, last_refresh: '2026-05-20T11:00:00Z' },
      engine: 'claude',
      sourceHostId: null,
      requireLastRefresh: true,
      logAction: 'test',
      sourceKind: 'admin',
    });
    expect(replay.status).toBe('outdated');
    expect(replay.candidate_result).toBe('historical_replay');
    expect(replay.candidate_rejected_definitive).toBe(true);
    expect(live.calls()).toBe(beforeReplay);
  });

  it('rejects an internally older host OAuth generation before runner verification', async () => {
    const db = createDbFake();
    db.tables.set(authPayloads, []);
    db.tables.set(authEntries, []);
    const keyring = makeKeyring();
    const live = countingRunner({ ok: true, status: 'ok', reachable: true });
    const svc = createCanonicalAuthStoreService({
      db: db as never,
      keyring,
      runnerValidation: createRunnerValidationService({ db: db as never, keyring }),
      runner: live.client,
    });
    const current = {
      ...CLAUDE_AUTH,
      claudeAiOauth: {
        accessToken: 'sk-ant-oat01-current-generation',
        refreshToken: 'current-refresh-token',
        expiresAt: Date.UTC(2030, 0, 1),
        refreshTokenExpiresAt: Date.UTC(2031, 0, 1),
      },
    };
    await svc.storeCandidate({
      auth: current,
      engine: 'claude',
      sourceHostId: null,
      requireLastRefresh: true,
      logAction: 'test',
      sourceKind: 'admin',
    });
    const beforeOlder = live.calls();
    const older = await svc.storeCandidate({
      auth: {
        ...CLAUDE_AUTH,
        last_refresh: '2026-05-20T11:00:00Z',
        claudeAiOauth: {
          accessToken: 'sk-ant-oat01-older-generation',
          refreshToken: 'older-refresh-token',
          expiresAt: Date.UTC(2029, 0, 1),
          refreshTokenExpiresAt: Date.UTC(2030, 0, 1),
        },
      },
      engine: 'claude',
      sourceHostId: 42,
      requireLastRefresh: true,
      logAction: 'test',
      sourceKind: 'host',
    });
    expect(older.status).toBe('outdated');
    expect(older.candidate_result).toBe('older_internal');
    expect(older.candidate_rejected_definitive).toBe(true);
    expect(live.calls()).toBe(beforeOlder);
  });

  it('touches first-seen host auth state with one atomic upsert', async () => {
    let upserts = 0;
    const db = {
      insert(table: unknown) {
        expect(table).toBe(hostAuthStates);
        return {
          values() {
            return {
              async onDuplicateKeyUpdate() {
                upserts += 1;
              },
            };
          },
        };
      },
    };
    await Promise.all([
      touchHostAuthState(db as never, 1, 10, 'a'.repeat(64), 'codex'),
      touchHostAuthState(db as never, 1, 11, 'b'.repeat(64), 'codex'),
    ]);
    expect(upserts).toBe(2);
  });

  it.each([
    {
      engine: 'codex' as const,
      upload: CODEX_AUTH,
      updated: { tokens: { access_token: 'sk-openai-updated-token', refresh_token: 'r2' } },
      expectedToken: 'sk-openai-updated-token',
    },
    {
      engine: 'claude' as const,
      upload: CLAUDE_AUTH,
      updated: { claudeAiOauth: { accessToken: 'sk-ant-oat01-new', refreshToken: 'r2' } },
      expectedToken: 'sk-ant-oat01-new',
    },
  ])(
    'keeps native $engine runner refreshes that omit last_refresh',
    async ({ engine, upload, updated, expectedToken }) => {
      const db = createDbFake();
      db.tables.set(authPayloads, []);
      db.tables.set(authEntries, []);
      const keyring = makeKeyring();
      const svc = createCanonicalAuthStoreService({
        db: db as never,
        keyring,
        runnerValidation: createRunnerValidationService({ db: db as never, keyring }),
        runner: runner({ ok: true, status: 'ok', reachable: true, updated_auth: updated }),
      });

      const out = await svc.storeCandidate({
        auth: upload,
        engine,
        sourceHostId: null,
        requireLastRefresh: true,
        logAction: 'auth.store',
      });

      expect(out.runner_applied).toBe(true);
      expect(out.canonical_last_refresh).toBe(upload.last_refresh);
      expect(JSON.stringify(out.auth)).toContain(expectedToken);
    },
  );

  it('applies same-or-newer runner updated_auth and persists the refreshed payload', async () => {
    const db = createDbFake();
    db.tables.set(authPayloads, []);
    db.tables.set(authEntries, []);
    const keyring = makeKeyring();
    const svc = createCanonicalAuthStoreService({
      db: db as never,
      keyring,
      runnerValidation: createRunnerValidationService({ db: db as never, keyring }),
      runner: runner({
        ok: true,
        status: 'ok',
        reachable: true,
        updated_auth: {
          last_refresh: '2026-05-20T10:00:00Z',
          claudeAiOauth: { accessToken: 'sk-ant-oat01-new', refreshToken: 'r2' },
        },
      }),
    });

    const out = await svc.storeCandidate({
      auth: {
        last_refresh: '2026-05-20T09:00:00Z',
        claudeAiOauth: { accessToken: 'sk-ant-oat01-old', refreshToken: 'r1' },
      },
      engine: 'claude',
      sourceHostId: null,
      requireLastRefresh: true,
      logAction: 'auth.store',
    });

    expect(out.runner_applied).toBe(true);
    expect(out.canonical_last_refresh).toBe('2026-05-20T10:00:00Z');
    const stored = db.tables.get(authPayloads)![0]!;
    const decoded = JSON.parse(decryptOrNull(stored.body as string, keyring)!);
    expect(decoded.claudeAiOauth.accessToken).toBe('sk-ant-oat01-new');
  });

  it('rejects older runner updated_auth instead of retaining a possibly consumed upload token', async () => {
    const db = createDbFake();
    db.tables.set(authPayloads, []);
    db.tables.set(authEntries, []);
    const keyring = makeKeyring();
    const svc = createCanonicalAuthStoreService({
      db: db as never,
      keyring,
      runnerValidation: createRunnerValidationService({ db: db as never, keyring }),
      runner: runner({
        ok: true,
        status: 'ok',
        reachable: true,
        updated_auth: {
          last_refresh: '2026-05-20T08:59:00Z',
          claudeAiOauth: { accessToken: 'sk-ant-oat01-old-runner' },
        },
      }),
    });

    await expect(
      svc.storeCandidate({
        auth: {
          last_refresh: '2026-05-20T09:00:00Z',
          claudeAiOauth: { accessToken: 'sk-ant-oat01-upload' },
        },
        engine: 'claude',
        sourceHostId: null,
        requireLastRefresh: true,
        logAction: 'auth.store',
      }),
    ).rejects.toThrow(/updated_auth_older_than_upload/);
    expect(db.tables.get(authPayloads)).toHaveLength(0);
  });

  it('does not claim success when a runner rotation returns unusable credentials', async () => {
    const db = createDbFake();
    db.tables.set(authPayloads, []);
    db.tables.set(authEntries, []);
    const keyring = makeKeyring();
    const svc = createCanonicalAuthStoreService({
      db: db as never,
      keyring,
      runnerValidation: createRunnerValidationService({ db: db as never, keyring }),
      runner: runner({
        ok: true,
        status: 'ok',
        reachable: true,
        updated_auth: { last_refresh: '2026-05-20T10:00:00Z', poem: 'not credentials' },
      }),
    });

    await expect(
      svc.storeCandidate({
        auth: CLAUDE_AUTH,
        engine: 'claude',
        sourceHostId: null,
        requireLastRefresh: true,
        logAction: 'auth.store',
      }),
    ).rejects.toThrow(/runner returned unusable refreshed credentials/);
    expect(db.tables.get(authPayloads)).toHaveLength(0);
  });

  it('maps a definitive expired Claude session with cleared readback to credential rejection', async () => {
    const db = createDbFake();
    db.tables.set(authPayloads, []);
    db.tables.set(authEntries, []);
    const keyring = makeKeyring();
    const svc = createCanonicalAuthStoreService({
      db: db as never,
      keyring,
      runnerValidation: createRunnerValidationService({ db: db as never, keyring }),
      runner: runner({
        ok: false,
        status: 'fail',
        reachable: true,
        definitive: true,
        reason: 'Failed to authenticate: OAuth session expired and could not be refreshed',
        auth_readback: 'updated',
        updated_auth: {},
      }),
    });

    await expect(
      svc.storeCandidate({
        auth: CLAUDE_AUTH,
        engine: 'claude',
        sourceHostId: null,
        requireLastRefresh: true,
        logAction: 'auth.store',
      }),
    ).rejects.toMatchObject({
      status: 422,
      code: 'validation_failed',
      message: expect.stringContaining('OAuth session expired'),
    });
    expect(db.tables.get(authPayloads)).toHaveLength(0);
  });

  it.each([
    {
      engine: 'claude' as const,
      current: CLAUDE_AUTH,
      candidate: {
        ...CLAUDE_AUTH,
        last_refresh: '2026-05-20T10:00:00Z',
        claudeAiOauth: {
          accessToken: 'sk-ant-oat01-new-candidate-token',
          refreshToken: 'new-candidate-refresh',
        },
      },
      downgraded: {
        claudeAiOauth: { accessToken: '', refreshToken: '' },
        auths: { 'api.anthropic.com': { token: 'sk-ant-oat01-derived-only-token' } },
      },
    },
    {
      engine: 'codex' as const,
      current: CODEX_AUTH,
      candidate: {
        ...CODEX_AUTH,
        last_refresh: '2026-05-20T10:00:00Z',
        tokens: {
          access_token: 'sk-openai-new-candidate-token',
          refresh_token: 'new-candidate-refresh',
        },
      },
      downgraded: {
        auths: { 'api.openai.com': { token: 'sk-openai-derived-only-token' } },
      },
    },
  ])(
    'rejects a $engine runner credential-kind downgrade without changing the verified head',
    async ({ engine, current, candidate, downgraded }) => {
      const db = createDbFake();
      db.tables.set(authPayloads, []);
      db.tables.set(authEntries, []);
      const keyring = makeKeyring();
      let verdict: RunnerVerifyResult = { ok: true, status: 'ok', reachable: true };
      const probe = async () => verdict;
      const validation = createRunnerValidationService({ db: db as never, keyring });
      const svc = createCanonicalAuthStoreService({
        db: db as never,
        keyring,
        runnerValidation: validation,
        runner: { isConfigured: () => true, verify: probe, verifyClaude: probe },
      });

      const seeded = await svc.storeCandidate({
        auth: current,
        engine,
        sourceHostId: null,
        requireLastRefresh: true,
        logAction: 'auth.store',
        sourceKind: 'admin',
      });
      verdict = {
        ok: true,
        status: 'ok',
        reachable: true,
        auth_readback: 'updated',
        updated_auth: downgraded,
      };

      await expect(
        svc.storeCandidate({
          auth: candidate,
          engine,
          sourceHostId: null,
          requireLastRefresh: true,
          logAction: 'auth.store',
          sourceKind: 'host',
        }),
      ).rejects.toMatchObject({ code: 'runner_updated_auth_invalid' });

      expect(db.tables.get(authPayloads)).toHaveLength(1);
      expect(db.tables.get(authPayloads)![0]!.verificationState).toBe('verified');
      expect(db.tables.get(authCanonicalHeads)).toEqual([expect.objectContaining({ engine, payloadId: 1 })]);
      expect((await validation.resolveCanonicalPayload(engine))?.sha256).toBe(seeded.canonical_digest);
    },
  );

  it('rejects a Claude OAuth readback that loses the source refresh token', async () => {
    const db = createDbFake();
    db.tables.set(authPayloads, []);
    db.tables.set(authEntries, []);
    const keyring = makeKeyring();
    const svc = createCanonicalAuthStoreService({
      db: db as never,
      keyring,
      runnerValidation: createRunnerValidationService({ db: db as never, keyring }),
      runner: runner({
        ok: true,
        status: 'ok',
        reachable: true,
        updated_auth: {
          claudeAiOauth: { accessToken: 'sk-ant-oat01-refreshed-without-refresh-token' },
        },
      }),
    });

    await expect(
      svc.storeCandidate({
        auth: CLAUDE_AUTH,
        engine: 'claude',
        sourceHostId: null,
        requireLastRefresh: true,
        logAction: 'auth.store',
      }),
    ).rejects.toThrow(/updated_auth_refresh_token_lost/);
    expect(db.tables.get(authPayloads)).toHaveLength(0);
  });

  it('fails an initial store when live runner verification is not configured', async () => {
    const db = createDbFake();
    db.tables.set(authPayloads, []);
    db.tables.set(authEntries, []);
    const keyring = makeKeyring();
    const unconfigured = countingRunner({ ok: true, status: 'ok', reachable: true }, false);
    const svc = createCanonicalAuthStoreService({
      db: db as never,
      keyring,
      runnerValidation: createRunnerValidationService({ db: db as never, keyring }),
      runner: unconfigured.client,
    });

    await expect(
      svc.storeCandidate({
        auth: CLAUDE_AUTH,
        engine: 'claude',
        sourceHostId: null,
        requireLastRefresh: true,
        logAction: 'auth.store',
      }),
    ).rejects.toMatchObject({ code: 'runner_unreachable' });
    expect(db.tables.get(authPayloads)).toHaveLength(0);
    expect(db.tables.get(authCanonicalHeads) ?? []).toHaveLength(0);
  });

  it('never returns auth bytes or updates the head for an internal pending readback', async () => {
    const db = createDbFake();
    db.tables.set(authPayloads, []);
    db.tables.set(authEntries, []);
    const keyring = makeKeyring();
    const unconfigured = countingRunner({ ok: true, status: 'ok', reachable: true }, false);
    const svc = createCanonicalAuthStoreService({
      db: db as never,
      keyring,
      runnerValidation: createRunnerValidationService({ db: db as never, keyring }),
      runner: unconfigured.client,
    });

    const stored = await svc.storeCandidate({
      auth: CLAUDE_AUTH,
      engine: 'claude',
      sourceHostId: null,
      requireLastRefresh: true,
      logAction: 'auth.reverify_refresh_pending',
      sourceKind: 'runner',
      runnerPending: true,
    });

    expect(stored.status).toBe('outdated');
    expect(stored.verification_state).toBe('pending');
    expect(stored.auth).toBeUndefined();
    expect(stored.candidate_result).toBeUndefined();
    expect(db.tables.get(authCanonicalHeads) ?? []).toHaveLength(0);
  });

  it('returns outdated unknown without auth when a CAS observes an unsafe verified head', async () => {
    const db = createDbFake();
    db.tables.set(authEntries, []);
    db.tables.set(hostAuthStates, []);
    const keyring = makeKeyring();
    const validation = createRunnerValidationService({ db: db as never, keyring });
    const unsafe = {
      last_refresh: CLAUDE_AUTH.last_refresh,
      claudeAiOauth: {
        accessToken: 'sk-ant-oat01-native-head-token-123',
        refreshToken: 'native-head-refresh-token-123',
      },
      auths: {
        'api.anthropic.com': { token: 'sk-ant-oat01-stale-derived-token-123' },
      },
    };
    const body = JSON.stringify(unsafe);
    const digest = validation.calculateDigest(body);
    const row = {
      id: 1,
      lastRefresh: CLAUDE_AUTH.last_refresh,
      sha256: digest,
      sourceHostId: null,
      createdAt: CLAUDE_AUTH.last_refresh,
      body: encrypt(body, keyring),
      verificationState: 'verified',
      verificationCheckedAt: CLAUDE_AUTH.last_refresh,
      verificationReason: null,
      engine: 'claude',
      generation: 1,
    };
    db.tables.set(authPayloads, [row]);
    db.tables.set(authCanonicalHeads, [
      {
        engine: 'claude',
        payloadId: 1,
        generation: 1,
        updatedAt: CLAUDE_AUTH.last_refresh,
      },
    ]);
    expect(validation.canonicalAuthFromPayload(row)).toBeNull();

    const svc = createCanonicalAuthStoreService({
      db: db as never,
      keyring,
      runnerValidation: validation,
      runner: countingRunner({ ok: true, status: 'ok', reachable: true }, false).client,
    });
    const out = await svc.storeCandidate({
      auth: {
        ...CLAUDE_AUTH,
        last_refresh: '2026-05-20T10:00:00Z',
        claudeAiOauth: {
          accessToken: 'sk-ant-oat01-worker-candidate-token-123',
          refreshToken: 'worker-candidate-refresh-token-123',
        },
      },
      engine: 'claude',
      sourceHostId: 42,
      requireLastRefresh: true,
      logAction: 'auth.worker',
      sourceKind: 'runner',
      runnerVerified: true,
      expectedCanonicalDigest: 'f'.repeat(64),
    });

    expect(out).toMatchObject({
      status: 'outdated',
      verification_state: 'unknown',
      canonical_digest: digest,
      canonical_generation: 1,
    });
    expect(out.auth).toBeUndefined();
    expect(out.candidate_result).toBeUndefined();
    expect(out.candidate_rejected_definitive).toBeUndefined();
    expect(db.tables.get(authCanonicalHeads)).toHaveLength(1);
    expect(db.tables.get(hostAuthStates)).toHaveLength(0);
  });

  it('maps a malformed runner refresh timestamp to runner_updated_auth_invalid', async () => {
    const db = createDbFake();
    db.tables.set(authPayloads, []);
    db.tables.set(authEntries, []);
    const keyring = makeKeyring();
    const svc = createCanonicalAuthStoreService({
      db: db as never,
      keyring,
      runnerValidation: createRunnerValidationService({ db: db as never, keyring }),
      runner: runner({
        ok: true,
        status: 'ok',
        reachable: true,
        updated_auth: {
          last_refresh: 'not-a-time',
          claudeAiOauth: { accessToken: 'sk-ant-oat01-refreshed-valid-token' },
        },
      }),
    });

    await expect(
      svc.storeCandidate({
        auth: CLAUDE_AUTH,
        engine: 'claude',
        sourceHostId: null,
        requireLastRefresh: true,
        logAction: 'auth.store',
      }),
    ).rejects.toMatchObject({ code: 'runner_updated_auth_invalid' });
    expect(db.tables.get(authPayloads)).toHaveLength(0);
  });

  it('fails a successful probe closed when native credential readback failed', async () => {
    const db = createDbFake();
    db.tables.set(authPayloads, []);
    db.tables.set(authEntries, []);
    const keyring = makeKeyring();
    const svc = createCanonicalAuthStoreService({
      db: db as never,
      keyring,
      runnerValidation: createRunnerValidationService({ db: db as never, keyring }),
      runner: runner({
        ok: true,
        status: 'ok',
        reachable: true,
        auth_readback: 'error',
        auth_readback_error: 'credential file malformed',
      }),
    });

    await expect(
      svc.storeCandidate({
        auth: CLAUDE_AUTH,
        engine: 'claude',
        sourceHostId: null,
        requireLastRefresh: true,
        logAction: 'auth.store',
      }),
    ).rejects.toMatchObject({ code: 'runner_updated_auth_invalid' });
    expect(db.tables.get(authPayloads)).toHaveLength(0);
  });

  it.each([
    {
      label: 'retryable',
      verdict: {
        ok: false,
        status: 'fail',
        reachable: false,
        definitive: false,
        reason: 'CLI timed out after rewriting the file',
      } satisfies RunnerVerifyResult,
      expected: { code: 'runner_unreachable', status: 503 },
    },
    {
      label: 'definitive',
      verdict: {
        ok: false,
        status: 'fail',
        reachable: true,
        definitive: true,
        reason: 'provider rejected token',
      } satisfies RunnerVerifyResult,
      expected: { code: 'validation_failed', status: 422 },
    },
  ])(
    'treats a $label raw readback rewrite with the same canonical digest as unchanged',
    async ({ verdict, expected }) => {
      const db = createDbFake();
      db.tables.set(authPayloads, []);
      db.tables.set(authEntries, []);
      const keyring = makeKeyring();
      const svc = createCanonicalAuthStoreService({
        db: db as never,
        keyring,
        runnerValidation: createRunnerValidationService({ db: db as never, keyring }),
        runner: runner({
          ...verdict,
          auth_readback: 'updated',
          // Claude Code may drop wrapper-only last_refresh/auths fields while
          // retaining the exact native credential pair.
          updated_auth: {
            claudeAiOauth: {
              accessToken: CLAUDE_AUTH.claudeAiOauth.accessToken,
              refreshToken: CLAUDE_AUTH.claudeAiOauth.refreshToken,
            },
          },
        }),
      });

      await expect(
        svc.storeCandidate({
          auth: CLAUDE_AUTH,
          engine: 'claude',
          sourceHostId: null,
          requireLastRefresh: true,
          logAction: 'auth.store',
        }),
      ).rejects.toMatchObject(expected);
      expect(db.tables.get(authPayloads)).toHaveLength(0);
      expect(db.tables.get(authCanonicalHeads) ?? []).toHaveLength(0);
    },
  );

  it('preserves a changed runner file as pending when the final probe is non-definitive', async () => {
    const db = createDbFake();
    db.tables.set(authPayloads, []);
    db.tables.set(authEntries, []);
    const keyring = makeKeyring();
    const svc = createCanonicalAuthStoreService({
      db: db as never,
      keyring,
      runnerValidation: createRunnerValidationService({ db: db as never, keyring }),
      runner: runner({
        ok: false,
        status: 'fail',
        reachable: false,
        definitive: false,
        reason: 'CLI timed out after refresh',
        auth_readback: 'updated',
        updated_auth: {
          last_refresh: '2026-05-20T10:00:00Z',
          claudeAiOauth: {
            accessToken: 'sk-ant-oat01-pending-refresh-token',
            refreshToken: 'pending-refresh-r2',
          },
        },
      }),
    });

    await expect(
      svc.storeCandidate({
        auth: CLAUDE_AUTH,
        engine: 'claude',
        sourceHostId: null,
        requireLastRefresh: true,
        logAction: 'auth.store',
      }),
    ).rejects.toMatchObject({ code: 'runner_updated_auth_invalid' });
    expect(db.tables.get(authPayloads)).toHaveLength(1);
    expect(db.tables.get(authPayloads)![0]!.verificationState).toBe('pending');
    const decoded = JSON.parse(decryptOrNull(db.tables.get(authPayloads)![0]!.body as string, keyring)!);
    expect(decoded.claudeAiOauth.accessToken).toBe('sk-ant-oat01-pending-refresh-token');
  });

  it('withholds a related selected head when an upload probe changes credentials before a non-OK verdict', async () => {
    const db = createDbFake();
    db.tables.set(authPayloads, []);
    db.tables.set(authEntries, []);
    const keyring = makeKeyring();
    const validation = createRunnerValidationService({ db: db as never, keyring });
    let verdict: RunnerVerifyResult = { ok: true, status: 'ok', reachable: true };
    const probe = async () => verdict;
    const svc = createCanonicalAuthStoreService({
      db: db as never,
      keyring,
      runnerValidation: validation,
      runner: { isConfigured: () => true, verify: probe, verifyClaude: probe },
    });

    const initial = await svc.storeCandidate({
      auth: CLAUDE_AUTH,
      engine: 'claude',
      sourceHostId: null,
      requireLastRefresh: true,
      logAction: 'auth.store',
    });
    expect(initial.status).toBe('updated');
    expect(
      validation.canonicalAuthFromPayload((await validation.resolveCanonicalPayload('claude'))!),
    ).not.toBeNull();

    verdict = {
      ok: false,
      status: 'fail',
      reachable: false,
      definitive: false,
      reason: 'CLI timed out after rotating credentials',
      auth_readback: 'updated',
      updated_auth: {
        last_refresh: '2026-05-20T11:00:00Z',
        claudeAiOauth: {
          accessToken: 'sk-ant-oat01-quarantined-replacement-token-123',
          refreshToken: 'quarantined-replacement-refresh-token-123',
        },
      },
    };
    await expect(
      svc.storeCandidate({
        auth: {
          last_refresh: '2026-05-20T10:00:00Z',
          claudeAiOauth: {
            accessToken: 'sk-ant-oat01-upload-candidate-token-123',
            refreshToken: CLAUDE_AUTH.claudeAiOauth.refreshToken,
          },
        },
        engine: 'claude',
        sourceHostId: 42,
        requireLastRefresh: true,
        logAction: 'auth.store',
        sourceKind: 'host',
      }),
    ).rejects.toMatchObject({ code: 'runner_updated_auth_invalid' });

    const selected = await validation.resolveCanonicalPayload('claude');
    expect(selected).toMatchObject({
      id: initial.pending_payload_id,
      verificationState: 'failed',
      verificationReason: expect.stringContaining('prior selected credential may have been consumed'),
    });
    expect(validation.canonicalAuthFromPayload(selected!)).toBeNull();
    const quarantined = await validation.resolvePendingQuarantine?.('claude');
    expect(quarantined).toMatchObject({
      verificationState: 'pending',
      generation: 2,
    });
    expect(db.tables.get(authCanonicalHeads)).toEqual([
      expect.objectContaining({ engine: 'claude', payloadId: initial.pending_payload_id }),
    ]);
  });

  it('preserves an unrelated selected head when another login rotates before a non-OK verdict', async () => {
    const db = createDbFake();
    db.tables.set(authPayloads, []);
    db.tables.set(authEntries, []);
    const keyring = makeKeyring();
    const validation = createRunnerValidationService({ db: db as never, keyring });
    let verdict: RunnerVerifyResult = { ok: true, status: 'ok', reachable: true };
    const probe = async () => verdict;
    const svc = createCanonicalAuthStoreService({
      db: db as never,
      keyring,
      runnerValidation: validation,
      runner: { isConfigured: () => true, verify: probe, verifyClaude: probe },
    });

    const initial = await svc.storeCandidate({
      auth: CLAUDE_AUTH,
      engine: 'claude',
      sourceHostId: null,
      requireLastRefresh: true,
      logAction: 'auth.store',
    });
    verdict = {
      ok: false,
      status: 'fail',
      reachable: false,
      definitive: false,
      reason: 'unrelated login timed out after rotation',
      auth_readback: 'updated',
      updated_auth: {
        last_refresh: '2026-05-20T11:00:00Z',
        claudeAiOauth: {
          accessToken: 'sk-ant-oat01-unrelated-replacement-token-123',
          refreshToken: 'unrelated-replacement-refresh-token-123',
        },
      },
    };
    await expect(
      svc.storeCandidate({
        auth: {
          last_refresh: '2026-05-20T10:00:00Z',
          claudeAiOauth: {
            accessToken: 'sk-ant-oat01-unrelated-candidate-token-123',
            refreshToken: 'unrelated-candidate-refresh-token-123',
          },
        },
        engine: 'claude',
        sourceHostId: 42,
        requireLastRefresh: true,
        logAction: 'auth.store',
        sourceKind: 'host',
      }),
    ).rejects.toMatchObject({ code: 'runner_updated_auth_invalid' });

    const selected = await validation.resolveCanonicalPayload('claude');
    expect(selected).toMatchObject({
      id: initial.pending_payload_id,
      verificationState: 'verified',
    });
    expect(validation.canonicalAuthFromPayload(selected!)).not.toBeNull();
    expect(await validation.resolvePendingQuarantine?.('claude')).toMatchObject({
      verificationState: 'pending',
      generation: 2,
    });
  });

  it('never invalidates a different canonical head that wins during a slow rotating probe', async () => {
    const db = createDbFake();
    db.tables.set(authPayloads, []);
    db.tables.set(authEntries, []);
    const keyring = makeKeyring();
    const validation = createRunnerValidationService({ db: db as never, keyring });
    let calls = 0;
    const probe = async (): Promise<RunnerVerifyResult> => {
      calls += 1;
      if (calls === 1) return { ok: true, status: 'ok', reachable: true };

      const winnerSource = {
        last_refresh: '2026-05-20T10:30:00Z',
        claudeAiOauth: {
          accessToken: 'sk-ant-oat01-concurrent-winner-token-123',
          refreshToken: 'concurrent-winner-refresh-token-123',
        },
      };
      const projected = validation.ensureAuthsFallback(winnerSource, 'claude');
      const winner = validation.canonicalizeAuthPayload(
        projected,
        validation.normalizeAuthEntries(projected, 'claude'),
        winnerSource.last_refresh,
        'claude',
      );
      const body = JSON.stringify(winner);
      const metadata = credentialMetadata(inspectCredential(winner, 'claude')!, keyring.active());
      db.tables.get(authPayloads)!.push({
        id: 2,
        lastRefresh: winnerSource.last_refresh,
        sha256: validation.calculateDigest(body),
        sourceHostId: 99,
        createdAt: winnerSource.last_refresh,
        body: encrypt(body, keyring),
        verificationState: 'verified',
        verificationCheckedAt: winnerSource.last_refresh,
        verificationReason: null,
        engine: 'claude',
        generation: 2,
        ...metadata,
      });
      db.tables.set(authCanonicalHeads, [
        {
          engine: 'claude',
          payloadId: 2,
          generation: 2,
          updatedAt: winnerSource.last_refresh,
        },
      ]);
      return {
        ok: false,
        status: 'fail',
        reachable: false,
        definitive: false,
        reason: 'original candidate timed out after rotation',
        auth_readback: 'updated',
        updated_auth: {
          last_refresh: '2026-05-20T11:00:00Z',
          claudeAiOauth: {
            accessToken: 'sk-ant-oat01-original-replacement-token-123',
            refreshToken: 'original-replacement-refresh-token-123',
          },
        },
      };
    };
    const svc = createCanonicalAuthStoreService({
      db: db as never,
      keyring,
      runnerValidation: validation,
      runner: { isConfigured: () => true, verify: probe, verifyClaude: probe },
    });
    await svc.storeCandidate({
      auth: CLAUDE_AUTH,
      engine: 'claude',
      sourceHostId: null,
      requireLastRefresh: true,
      logAction: 'auth.store',
    });

    await expect(
      svc.storeCandidate({
        auth: {
          last_refresh: '2026-05-20T10:00:00Z',
          claudeAiOauth: {
            accessToken: 'sk-ant-oat01-original-candidate-token-123',
            refreshToken: CLAUDE_AUTH.claudeAiOauth.refreshToken,
          },
        },
        engine: 'claude',
        sourceHostId: 42,
        requireLastRefresh: true,
        logAction: 'auth.store',
        sourceKind: 'host',
      }),
    ).rejects.toMatchObject({ code: 'runner_updated_auth_invalid' });

    const selected = await validation.resolveCanonicalPayload('claude');
    expect(selected).toMatchObject({ id: 2, generation: 2, verificationState: 'verified' });
    expect(validation.canonicalAuthFromPayload(selected!)).not.toBeNull();
    expect(db.tables.get(authPayloads)!.find((row) => row.id === 2)?.verificationState).toBe('verified');
    expect(db.tables.get(authPayloads)!.find((row) => row.id === 3)?.verificationState).toBe('pending');
  });

  it('keeps a nonverified readback unheaded, then promotes it only after a live worker retry', async () => {
    const db = createDbFake();
    db.tables.set(authPayloads, []);
    db.tables.set(authEntries, []);
    const keyring = makeKeyring();
    let verdict: RunnerVerifyResult = {
      ok: false,
      status: 'fail',
      reachable: false,
      definitive: false,
      reason: 'CLI timed out after refresh',
      auth_readback: 'updated',
      updated_auth: {
        last_refresh: '2026-05-20T10:00:00Z',
        claudeAiOauth: {
          accessToken: 'sk-ant-oat01-quarantine-retry-access-token',
          refreshToken: 'quarantine-retry-refresh-token',
        },
      },
    };
    const probe = async () => verdict;
    const validation = createRunnerValidationService({ db: db as never, keyring });
    const svc = createCanonicalAuthStoreService({
      db: db as never,
      keyring,
      runnerValidation: validation,
      runner: { isConfigured: () => true, verify: probe, verifyClaude: probe },
    });

    await expect(
      svc.storeCandidate({
        auth: CLAUDE_AUTH,
        engine: 'claude',
        sourceHostId: null,
        requireLastRefresh: true,
        logAction: 'auth.store',
      }),
    ).rejects.toMatchObject({ code: 'runner_updated_auth_invalid' });

    const quarantined = await validation.resolvePendingQuarantine?.('claude');
    expect(quarantined?.verificationState).toBe('pending');
    expect(db.tables.get(authCanonicalHeads) ?? []).toHaveLength(0);
    expect(db.tables.get(authPayloads)![0]).toMatchObject({
      supersededAt: expect.any(String),
      purgeAfter: expect.any(String),
    });
    const validated = validation.validateCanonicalPayload(quarantined ?? null)!;

    verdict = { ok: true, status: 'ok', reachable: true };
    const retried = await svc.ensureServedVerification({
      engine: 'claude',
      hostId: null,
      row: {
        id: quarantined!.id,
        verificationState: quarantined!.verificationState,
        verificationCheckedAt: quarantined!.verificationCheckedAt,
        verificationReason: quarantined!.verificationReason,
      },
      auth: validated.auth,
      digest: validated.digest,
      lastRefresh: validated.last_refresh,
      ttlSeconds: 0,
    });

    expect(retried.state).toBe('verified');
    expect(db.tables.get(authPayloads)![0]).toMatchObject({
      verificationState: 'verified',
      supersededAt: null,
      purgeAfter: null,
    });
    expect(db.tables.get(authCanonicalHeads)).toEqual([
      expect.objectContaining({ engine: 'claude', payloadId: quarantined!.id }),
    ]);
  });

  it('preserves a changed runner file as failed before returning a definitive unsafe-refresh error', async () => {
    const db = createDbFake();
    db.tables.set(authPayloads, []);
    db.tables.set(authEntries, []);
    const keyring = makeKeyring();
    const svc = createCanonicalAuthStoreService({
      db: db as never,
      keyring,
      runnerValidation: createRunnerValidationService({ db: db as never, keyring }),
      runner: runner({
        ok: false,
        status: 'fail',
        reachable: true,
        definitive: true,
        reason: 'refresh token already used',
        auth_readback: 'updated',
        updated_auth: {
          last_refresh: '2026-05-20T10:00:00Z',
          claudeAiOauth: { accessToken: 'sk-ant-oat01-failed-refresh-token', refreshToken: 'replacement-r2' },
        },
      }),
    });

    await expect(
      svc.storeCandidate({
        auth: CLAUDE_AUTH,
        engine: 'claude',
        sourceHostId: null,
        requireLastRefresh: true,
        logAction: 'auth.store',
      }),
    ).rejects.toMatchObject({ code: 'runner_updated_auth_invalid', status: 503 });
    expect(db.tables.get(authPayloads)).toHaveLength(1);
    const stored = db.tables.get(authPayloads)![0]!;
    expect(stored.verificationState).toBe('failed');
    expect(stored.verificationCheckedAt).not.toBeNull();
    expect(stored.verificationReason).toContain('refresh token already used');
    const decoded = JSON.parse(decryptOrNull(stored.body as string, keyring)!);
    expect(decoded.claudeAiOauth.refreshToken).toBe('replacement-r2');
  });

  it('answers 503 (retry later) when the runner is unreachable — never a credential verdict', async () => {
    const db = createDbFake();
    db.tables.set(authPayloads, []);
    db.tables.set(authEntries, []);
    const keyring = makeKeyring();
    const svc = createCanonicalAuthStoreService({
      db: db as never,
      keyring,
      runnerValidation: createRunnerValidationService({ db: db as never, keyring }),
      runner: runner({ ok: false, status: 'fail', reachable: false, reason: 'down' }),
    });

    const rejected = svc.storeCandidate({
      auth: {
        last_refresh: '2026-05-20T09:00:00Z',
        claudeAiOauth: { accessToken: 'sk-ant-oat01-upload' },
      },
      engine: 'claude',
      sourceHostId: null,
      requireLastRefresh: true,
      logAction: 'auth.store',
    });
    await expect(rejected).rejects.toBeInstanceOf(ServiceUnavailableError);
    await expect(rejected).rejects.not.toBeInstanceOf(ValidationError);
    await expect(rejected).rejects.toThrow(/Auth runner unavailable/);
    expect(db.tables.get(authPayloads)).toHaveLength(0);
  });

  it('answers 503 on a reachable-but-garbled runner response (non-definitive)', async () => {
    const db = createDbFake();
    db.tables.set(authPayloads, []);
    db.tables.set(authEntries, []);
    const keyring = makeKeyring();
    const svc = createCanonicalAuthStoreService({
      db: db as never,
      keyring,
      runnerValidation: createRunnerValidationService({ db: db as never, keyring }),
      runner: runner({
        ok: false,
        status: 'fail',
        reachable: true,
        definitive: false,
        reason: 'invalid runner response (status 502)',
      }),
    });

    await expect(
      svc.storeCandidate({
        auth: {
          last_refresh: '2026-05-20T09:00:00Z',
          claudeAiOauth: { accessToken: 'sk-ant-oat01-upload' },
        },
        engine: 'claude',
        sourceHostId: null,
        requireLastRefresh: true,
        logAction: 'auth.store',
      }),
    ).rejects.toThrow(/Auth runner unavailable/);
    expect(db.tables.get(authPayloads)).toHaveLength(0);
  });

  it('rejects with a validation error when the runner definitively refutes the candidate', async () => {
    const db = createDbFake();
    db.tables.set(authPayloads, []);
    db.tables.set(authEntries, []);
    const keyring = makeKeyring();
    const svc = createCanonicalAuthStoreService({
      db: db as never,
      keyring,
      runnerValidation: createRunnerValidationService({ db: db as never, keyring }),
      runner: runner({
        ok: false,
        status: 'fail',
        reachable: true,
        definitive: true,
        reason: 'provider rejected token',
      }),
    });

    const rejected = svc.storeCandidate({
      auth: {
        last_refresh: '2026-05-20T09:00:00Z',
        claudeAiOauth: { accessToken: 'sk-ant-oat01-upload' },
      },
      engine: 'claude',
      sourceHostId: null,
      requireLastRefresh: true,
      logAction: 'auth.store',
    });
    await expect(rejected).rejects.toBeInstanceOf(ValidationError);
    await expect(rejected).rejects.toThrow(/failed live verification: provider rejected token/);
    expect(db.tables.get(authPayloads)).toHaveLength(0);
  });

  it('serializes and deduplicates concurrent stores across service instances', async () => {
    const db = createDbFake();
    db.tables.set(authPayloads, []);
    db.tables.set(authEntries, []);
    const keyring = makeKeyring();
    const r = countingRunner({ ok: true, status: 'ok', reachable: true });
    const makeService = () =>
      createCanonicalAuthStoreService({
        db: db as never,
        keyring,
        runnerValidation: createRunnerValidationService({ db: db as never, keyring }),
        runner: r.client,
      });
    const svcA = makeService();
    const svcB = makeService();
    const input = {
      auth: CODEX_AUTH,
      engine: 'codex' as const,
      sourceHostId: null,
      requireLastRefresh: true,
      logAction: 'auth.store',
    };

    const results = await Promise.all([svcA.storeCandidate(input), svcB.storeCandidate(input)]);
    expect(results.map((item) => item.status).sort()).toEqual(['updated', 'valid']);
    expect(r.calls()).toBe(1);
    expect(db.tables.get(authPayloads)).toHaveLength(1);
  });

  it('does not roll back a newer generation that differs only below millisecond precision', async () => {
    const db = createDbFake();
    db.tables.set(authPayloads, []);
    db.tables.set(authEntries, []);
    const keyring = makeKeyring();
    const r = countingRunner({ ok: true, status: 'ok', reachable: true });
    const svc = createCanonicalAuthStoreService({
      db: db as never,
      keyring,
      runnerValidation: createRunnerValidationService({ db: db as never, keyring }),
      runner: r.client,
    });

    const newer = await svc.storeCandidate({
      auth: {
        ...CODEX_AUTH,
        last_refresh: '2026-07-17T12:00:00.100000002Z',
        tokens: { access_token: 'sk-openai-newer-nanosecond-token', refresh_token: 'newer-refresh' },
      },
      engine: 'codex',
      sourceHostId: null,
      requireLastRefresh: true,
      logAction: 'auth.store',
    });
    const older = await svc.storeCandidate({
      auth: {
        ...CODEX_AUTH,
        last_refresh: '2026-07-17T12:00:00.100000001Z',
        tokens: { access_token: 'sk-openai-older-nanosecond-token', refresh_token: 'older-refresh' },
      },
      engine: 'codex',
      sourceHostId: null,
      requireLastRefresh: true,
      logAction: 'auth.store',
    });

    expect(newer.status).toBe('updated');
    expect(older.status).toBe('outdated');
    expect(older.canonical_digest).toBe(newer.canonical_digest);
    expect(r.calls()).toBe(1);
    expect(db.tables.get(authPayloads)).toHaveLength(1);
  });

  it.each([
    {
      engine: 'codex' as const,
      current: CODEX_AUTH,
      candidate: {
        ...CODEX_AUTH,
        tokens: {
          access_token: 'sk-openai-direct-same-stamp-token',
          refresh_token: 'direct-same-stamp-refresh',
        },
      },
      expectedToken: 'sk-openai-direct-same-stamp-token',
    },
    {
      engine: 'claude' as const,
      current: CLAUDE_AUTH,
      candidate: {
        ...CLAUDE_AUTH,
        claudeAiOauth: {
          accessToken: 'sk-ant-oat01-direct-same-stamp-token',
          refreshToken: 'direct-same-stamp-refresh',
        },
      },
      expectedToken: 'sk-ant-oat01-direct-same-stamp-token',
    },
  ])(
    'restamps a verified $engine digest change on an exact last_refresh tie',
    async ({ engine, current, candidate, expectedToken }) => {
      const db = createDbFake();
      db.tables.set(authEntries, []);
      const keyring = makeKeyring();
      const validation = createRunnerValidationService({ db: db as never, keyring });
      const canonical = validation.canonicalizeAuthPayload(
        current,
        validation.normalizeAuthEntries(current, engine),
        current.last_refresh,
        engine,
      );
      const encoded = JSON.stringify(canonical);
      db.tables.set(authPayloads, [
        {
          id: 1,
          lastRefresh: current.last_refresh,
          sha256: validation.calculateDigest(encoded),
          sourceHostId: null,
          createdAt: current.last_refresh,
          body: encrypt(encoded, keyring),
          verificationState: 'verified',
          verificationCheckedAt: current.last_refresh,
          verificationReason: null,
          engine,
        },
      ]);
      const svc = createCanonicalAuthStoreService({
        db: db as never,
        keyring,
        runnerValidation: validation,
        runner: runner({ ok: true, status: 'ok', reachable: true }),
      });

      const out = await svc.storeCandidate({
        auth: candidate,
        engine,
        sourceHostId: null,
        requireLastRefresh: true,
        logAction: 'auth.store',
      });

      expect(out.status).toBe('updated');
      expect(Date.parse(out.canonical_last_refresh)).toBeGreaterThan(Date.parse(current.last_refresh));
      expect(JSON.stringify(out.auth)).toContain(expectedToken);
      expect((await validation.resolveCanonicalPayload(engine))?.id).toBe(2);
    },
  );

  it('restamps same-stamp runner updated_auth on a host store', async () => {
    const db = createDbFake();
    db.tables.set(authEntries, []);
    const keyring = makeKeyring();
    const validation = createRunnerValidationService({ db: db as never, keyring });
    const canonical = validation.canonicalizeAuthPayload(
      CLAUDE_AUTH,
      validation.normalizeAuthEntries(CLAUDE_AUTH, 'claude'),
      CLAUDE_AUTH.last_refresh,
'claude',
);
    const encoded = JSON.stringify(canonical);
    db.tables.set(authPayloads, [
      {
        id: 1,
        lastRefresh: CLAUDE_AUTH.last_refresh,
        sha256: validation.calculateDigest(encoded),
        sourceHostId: null,
        createdAt: CLAUDE_AUTH.last_refresh,
        body: encrypt(encoded, keyring),
        verificationState: 'verified',
        verificationCheckedAt: CLAUDE_AUTH.last_refresh,
        verificationReason: null,
        engine: 'claude',
      },
    ]);
    const svc = createCanonicalAuthStoreService({
      db: db as never,
      keyring,
      runnerValidation: validation,
      runner: runner({
        ok: true,
        status: 'ok',
        reachable: true,
        updated_auth: {
          last_refresh: CLAUDE_AUTH.last_refresh,
          claudeAiOauth: {
            accessToken: 'sk-ant-oat01-host-runner-rotated-token',
            refreshToken: 'host-runner-rotated-refresh',
          },
        },
      }),
    });

    const out = await svc.storeCandidate({
      auth: {
        ...CLAUDE_AUTH,
        claudeAiOauth: {
          accessToken: 'sk-ant-oat01-host-login-same-stamp',
          refreshToken: 'host-login-same-stamp-refresh',
        },
      },
      engine: 'claude',
      sourceHostId: null,
      requireLastRefresh: true,
      logAction: 'auth.store',
    });

    expect(out.runner_applied).toBe(true);
    expect(Date.parse(out.canonical_last_refresh)).toBeGreaterThan(Date.parse(CLAUDE_AUTH.last_refresh));
    expect(JSON.stringify(out.auth)).toContain('sk-ant-oat01-host-runner-rotated-token');
  });

  it('fails closed when an equal-stamp digest change cannot advance inside the future bound', async () => {
    const fixedNow = Date.now();
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(fixedNow);
    try {
      const ceilingStamp = new Date(fixedNow + 300_000).toISOString();
      const current = {
        last_refresh: ceilingStamp,
        tokens: {
          access_token: 'sk-openai-future-ceiling-current',
          refresh_token: 'future-ceiling-current-refresh',
        },
      };
      const db = createDbFake();
      db.tables.set(authEntries, []);
      const keyring = makeKeyring();
      const validation = createRunnerValidationService({ db: db as never, keyring });
      const canonical = validation.canonicalizeAuthPayload(
        current,
        validation.normalizeAuthEntries(current, 'codex'),
        ceilingStamp,
'codex',
);
      const encoded = JSON.stringify(canonical);
      db.tables.set(authPayloads, [
        {
          id: 1,
          lastRefresh: ceilingStamp,
          sha256: validation.calculateDigest(encoded),
          sourceHostId: null,
          createdAt: ceilingStamp,
          body: encrypt(encoded, keyring),
          verificationState: 'verified',
          verificationCheckedAt: ceilingStamp,
          verificationReason: null,
          engine: 'codex',
        },
      ]);
      const svc = createCanonicalAuthStoreService({
        db: db as never,
        keyring,
        runnerValidation: validation,
        runner: runner({ ok: true, status: 'ok', reachable: true }),
      });

      await expect(
        svc.storeCandidate({
          auth: {
            ...current,
            tokens: {
              access_token: 'sk-openai-future-ceiling-candidate',
              refresh_token: 'future-ceiling-candidate-refresh',
            },
          },
          engine: 'codex',
          sourceHostId: null,
          requireLastRefresh: true,
          logAction: 'auth.store',
        }),
      ).rejects.toMatchObject({ status: 503, code: 'canonical_timestamp_exhausted' });
      expect(db.tables.get(authPayloads)).toHaveLength(1);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('serializes worker re-verification against a concurrent route store', async () => {
    const db = createDbFake();
    db.tables.set(authEntries, []);
    const keyring = makeKeyring();
    const validationA = createRunnerValidationService({ db: db as never, keyring });
    const canonical = validationA.canonicalizeAuthPayload(
      CODEX_AUTH,
      validationA.normalizeAuthEntries(CODEX_AUTH, 'codex'),
      CODEX_AUTH.last_refresh,
'codex',
);
    const encoded = JSON.stringify(canonical);
    const digest = validationA.calculateDigest(encoded);
    db.tables.set(authPayloads, [
      {
        id: 1,
        lastRefresh: CODEX_AUTH.last_refresh,
        sha256: digest,
        sourceHostId: null,
        createdAt: CODEX_AUTH.last_refresh,
        body: encrypt(encoded, keyring),
        verificationState: 'verified',
        verificationCheckedAt: '2026-01-01T00:00:00Z',
        verificationReason: null,
        engine: 'codex',
        generation: 1,
      },
    ]);
    db.tables.set(authCanonicalHeads, [
      { engine: 'codex', payloadId: 1, generation: 1, updatedAt: '2026-07-17T09:00:00Z' },
    ]);
    let calls = 0;
    let active = 0;
    let maxActive = 0;
    let releaseFirst!: () => void;
    let firstStarted!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const started = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });
    const probe = async (): Promise<RunnerVerifyResult> => {
      calls += 1;
      active += 1;
      maxActive = Math.max(maxActive, active);
      if (calls === 1) {
        firstStarted();
        await firstGate;
      }
      active -= 1;
      return { ok: true, status: 'ok', reachable: true };
    };
    const client: RunnerClient = { isConfigured: () => true, verify: probe, verifyClaude: probe };
    const worker = createCanonicalAuthStoreService({
      db: db as never,
      keyring,
      runnerValidation: validationA,
      runner: client,
    });
    const route = createCanonicalAuthStoreService({
      db: db as never,
      keyring,
      runnerValidation: createRunnerValidationService({ db: db as never, keyring }),
      runner: client,
    });

    const verification = worker.ensureServedVerification({
      engine: 'codex',
      hostId: null,
      row: { id: 1, verificationState: 'verified', verificationCheckedAt: '2026-01-01T00:00:00Z' },
      auth: canonical,
      digest,
      lastRefresh: CODEX_AUTH.last_refresh,
      ttlSeconds: 0,
    });
    await started;
    const upload = route.storeCandidate({
      auth: { ...CODEX_AUTH, last_refresh: '2026-05-20T10:00:00Z' },
      engine: 'codex',
      sourceHostId: null,
      requireLastRefresh: true,
      logAction: 'auth.store',
    });
    await Promise.resolve();
    expect(calls).toBe(1);
    releaseFirst();
    await Promise.all([verification, upload]);
    expect(calls).toBe(2);
    expect(maxActive).toBe(1);
  });

  it('accepts a verified equal-stamp conflict with a strictly newer canonical stamp', async () => {
    const db = createDbFake();
    db.tables.set(authPayloads, []);
    db.tables.set(authEntries, []);
    const keyring = makeKeyring();
    const r = countingRunner({ ok: true, status: 'ok', reachable: true });
    const svc = createCanonicalAuthStoreService({
      db: db as never,
      keyring,
      runnerValidation: createRunnerValidationService({ db: db as never, keyring }),
      runner: r.client,
    });
    const newer = await svc.storeCandidate({
      auth: { ...CODEX_AUTH, last_refresh: '2026-05-20T10:00:00Z' },
      engine: 'codex',
      sourceHostId: null,
      requireLastRefresh: true,
      logAction: 'auth.store',
    });
    const tied = await svc.storeCandidate({
      auth: {
        last_refresh: '2026-05-20T10:00:00Z',
        tokens: { access_token: 'other-valid-token', refresh_token: 'other-r' },
      },
      engine: 'codex',
      sourceHostId: null,
      requireLastRefresh: true,
      logAction: 'auth.store',
    });

    expect(newer.status).toBe('updated');
    expect(tied.status).toBe('updated');
    expect(Date.parse(tied.canonical_last_refresh)).toBeGreaterThan(Date.parse(newer.canonical_last_refresh));
    expect(tied.canonical_digest).not.toBe(newer.canonical_digest);
    expect(r.calls()).toBe(2);
    expect(db.tables.get(authPayloads)).toHaveLength(2);
  });

  it('normalizes stored RFC3339 offsets and lets an older valid client repair a failed canonical', async () => {
    const db = createDbFake();
    db.tables.set(authEntries, []);
    const keyring = makeKeyring();
    const validation = createRunnerValidationService({ db: db as never, keyring });
    const failedAuth = validation.canonicalizeAuthPayload(
      validation.ensureAuthsFallback(CODEX_AUTH, 'codex'),
      validation.normalizeAuthEntries(validation.ensureAuthsFallback(CODEX_AUTH, 'codex'), 'codex'),
      '2026-07-17T09:00:00Z',
'codex',
);
    const failedBody = JSON.stringify(failedAuth);
    db.tables.set(authPayloads, [
      {
        id: 1,
        lastRefresh: '2026-07-17T09:00:00Z',
        sha256: validation.calculateDigest(failedBody),
        sourceHostId: null,
        createdAt: '2026-07-17T09:00:00Z',
        body: encrypt(failedBody, keyring),
        verificationState: 'failed',
        verificationCheckedAt: '2026-07-17T09:00:00Z',
        verificationReason: 'expired',
        engine: 'codex',
        generation: 1,
      },
    ]);
    db.tables.set(authCanonicalHeads, [
      { engine: 'codex', payloadId: 1, generation: 1, updatedAt: '2026-07-17T09:00:00Z' },
    ]);
    const svc = createCanonicalAuthStoreService({
      db: db as never,
      keyring,
      runnerValidation: validation,
      runner: runner({ ok: true, status: 'ok', reachable: true }),
    });

    const repaired = await svc.storeCandidate({
      auth: {
        last_refresh: '2026-07-17T10:30:00+02:00',
        tokens: { access_token: 'working-old', refresh_token: 'working-r' },
      },
      engine: 'codex',
      sourceHostId: null,
      requireLastRefresh: true,
      logAction: 'auth.store',
    });

    expect(repaired.status).toBe('updated');
    expect(repaired.canonical_last_refresh).toBe('2026-07-17T09:00:00.001Z');
    expect((await validation.resolveCanonicalPayload('codex'))?.id).toBe(2);
  });

  it('live-verifies historical local credentials to repair a failed explicit head', async () => {
    const db = createDbFake();
    db.tables.set(authPayloads, []);
    db.tables.set(authEntries, []);
    const keyring = makeKeyring();
    const live = countingRunner({ ok: true, status: 'ok', reachable: true });
    const validation = createRunnerValidationService({ db: db as never, keyring });
    const svc = createCanonicalAuthStoreService({
      db: db as never,
      keyring,
      runnerValidation: validation,
      runner: live.client,
    });
    const historical = {
      ...CODEX_AUTH,
      tokens: {
        access_token: 'sk-openai-historical-repair-access-token',
        refresh_token: 'historical-repair-refresh-token',
      },
    };
    await svc.storeCandidate({
      auth: historical,
      engine: 'codex',
      sourceHostId: null,
      requireLastRefresh: true,
      logAction: 'auth.store',
    });
    await svc.storeCandidate({
      auth: {
        ...CODEX_AUTH,
        last_refresh: '2026-05-20T10:00:00Z',
        tokens: {
          access_token: 'sk-openai-failed-head-access-token',
          refresh_token: 'failed-head-refresh-token',
        },
      },
      engine: 'codex',
      sourceHostId: null,
      requireLastRefresh: true,
      logAction: 'auth.store',
    });
    db.tables.get(authPayloads)![1]!.verificationState = 'failed';
    db.tables.get(authPayloads)![1]!.verificationReason = 'provider rejected token';

    const repaired = await svc.storeCandidate({
      auth: { ...historical, last_refresh: '2026-05-20T11:00:00Z' },
      engine: 'codex',
      sourceHostId: 42,
      requireLastRefresh: true,
      logAction: 'auth.store',
      sourceKind: 'host',
    });

    expect(repaired.status).toBe('updated');
    expect(repaired.verification_state).toBe('verified');
    expect(repaired.auth?.tokens).toMatchObject({
      access_token: 'sk-openai-historical-repair-access-token',
    });
    expect(live.calls()).toBe(3);
    expect((await validation.resolveCanonicalPayload('codex'))?.id).toBe(3);
  });

  it('does not resurrect a failed canonical while live verification is unavailable', async () => {
    const db = createDbFake();
    db.tables.set(authEntries, []);
    const keyring = makeKeyring();
    const validation = createRunnerValidationService({ db: db as never, keyring });
    const failedAuth = validation.canonicalizeAuthPayload(
      CODEX_AUTH,
      validation.normalizeAuthEntries(CODEX_AUTH, 'codex'),
      '2026-07-17T09:00:00Z',
'codex',
);
    const failedBody = JSON.stringify(failedAuth);
    db.tables.set(authPayloads, [
      {
        id: 1,
        lastRefresh: '2026-07-17T09:00:00Z',
        sha256: validation.calculateDigest(failedBody),
        sourceHostId: null,
        createdAt: '2026-07-17T09:00:00Z',
        body: encrypt(failedBody, keyring),
        verificationState: 'failed',
        verificationCheckedAt: '2026-07-17T09:00:00Z',
        verificationReason: 'expired',
        engine: 'codex',
        generation: 1,
      },
    ]);
    db.tables.set(authCanonicalHeads, [
      { engine: 'codex', payloadId: 1, generation: 1, updatedAt: '2026-07-17T09:00:00Z' },
    ]);
    const r = countingRunner({ ok: true, status: 'ok', reachable: true }, false);
    const svc = createCanonicalAuthStoreService({
      db: db as never,
      keyring,
      runnerValidation: validation,
      runner: r.client,
    });

    await expect(
      svc.storeCandidate({
        auth: { ...CODEX_AUTH, last_refresh: '2026-07-17T08:00:00Z' },
        engine: 'codex',
        sourceHostId: null,
        requireLastRefresh: true,
        logAction: 'auth.store',
      }),
    ).rejects.toThrow(/failed canonical cannot be replaced without live verification/);
    expect(r.calls()).toBe(0);
    expect(db.tables.get(authPayloads)).toHaveLength(1);
  });

  it('repairs a legacy pending head only after a different candidate passes live verification', async () => {
    const db = createDbFake();
    db.tables.set(authEntries, []);
    const keyring = makeKeyring();
    const validation = createRunnerValidationService({ db: db as never, keyring });
    const pendingSource = {
      last_refresh: '2026-07-17T09:00:00Z',
      tokens: { access_token: 'pending-new-login', refresh_token: 'pending-new-refresh' },
    };
    const pendingWithFallback = validation.ensureAuthsFallback(pendingSource, 'codex');
    const pendingAuth = validation.canonicalizeAuthPayload(
      pendingWithFallback,
      validation.normalizeAuthEntries(pendingWithFallback, 'codex'),
      pendingSource.last_refresh,
'codex',
);
    const pendingBody = JSON.stringify(pendingAuth);
    db.tables.set(authPayloads, [
      {
        id: 1,
        lastRefresh: pendingSource.last_refresh,
        sha256: validation.calculateDigest(pendingBody),
        sourceHostId: null,
        createdAt: pendingSource.last_refresh,
        body: encrypt(pendingBody, keyring),
        verificationState: 'pending',
        verificationCheckedAt: null,
        verificationReason: null,
        engine: 'codex',
        generation: 1,
      },
    ]);
    db.tables.set(authCanonicalHeads, [
      { engine: 'codex', payloadId: 1, generation: 1, updatedAt: pendingSource.last_refresh },
    ]);
    const r = countingRunner({ ok: true, status: 'ok', reachable: true });
    const svc = createCanonicalAuthStoreService({
      db: db as never,
      keyring,
      runnerValidation: validation,
      runner: r.client,
    });

    const result = await svc.storeCandidate({
      auth: {
        last_refresh: '2026-07-17T08:00:00Z',
        tokens: { access_token: 'older-login', refresh_token: 'older-refresh' },
      },
      engine: 'codex',
      sourceHostId: null,
      requireLastRefresh: true,
      logAction: 'auth.store',
    });

    expect(result.status).toBe('updated');
    expect(result.verification_state).toBe('verified');
    expect(result.auth).toBeDefined();
    expect(r.calls()).toBe(1);
    expect(db.tables.get(authPayloads)).toHaveLength(2);
  });

  it('does not let an unheaded quarantine block a separately live-verified repair', async () => {
    const db = createDbFake();
    db.tables.set(authEntries, []);
    const keyring = makeKeyring();
    const validation = createRunnerValidationService({ db: db as never, keyring });
    const makeRow = (id: number, stamp: string, token: string, verificationState: 'failed' | 'pending') => {
      const source = {
        last_refresh: stamp,
        tokens: { access_token: token, refresh_token: `${token}-refresh` },
      };
      const withFallback = validation.ensureAuthsFallback(source, 'codex');
      const canonical = validation.canonicalizeAuthPayload(
        withFallback,
        validation.normalizeAuthEntries(withFallback, 'codex'),
        stamp,
'codex',
);
      const body = JSON.stringify(canonical);
      return {
        id,
        lastRefresh: stamp,
        sha256: validation.calculateDigest(body),
        sourceHostId: null,
        createdAt: stamp,
        body: encrypt(body, keyring),
        verificationState,
        verificationCheckedAt: stamp,
        verificationReason: verificationState === 'failed' ? 'expired' : null,
        engine: 'codex',
      };
    };
    db.tables.set(authPayloads, [makeRow(1, '2026-07-17T08:00:00Z', 'failed-token', 'failed')]);

    let probeStarted!: () => void;
    let releaseProbe!: () => void;
    const started = new Promise<void>((resolve) => {
      probeStarted = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      releaseProbe = resolve;
    });
    const probe = async (): Promise<RunnerVerifyResult> => {
      probeStarted();
      await gate;
      return { ok: true, status: 'ok', reachable: true };
    };
    const svc = createCanonicalAuthStoreService({
      db: db as never,
      keyring,
      runnerValidation: validation,
      runner: { isConfigured: () => true, verify: probe, verifyClaude: probe },
    });
    const storing = svc.storeCandidate({
      auth: {
        last_refresh: '2026-07-17T07:00:00Z',
        tokens: { access_token: 'repair-token', refresh_token: 'repair-refresh' },
      },
      engine: 'codex',
      sourceHostId: null,
      requireLastRefresh: true,
      logAction: 'auth.store',
    });
    await started;
    const newer = makeRow(2, '2026-07-17T08:30:00Z', 'new-login-token', 'pending');
    db.tables.get(authPayloads)!.push(newer);
    releaseProbe();

    const result = await storing;
    expect(result.status).toBe('updated');
    expect(result.verification_state).toBe('verified');
    expect(result.canonical_digest).not.toBe(newer.sha256);
    expect(db.tables.get(authPayloads)).toHaveLength(3);
  });
});

describe('ensureServedVerification (launch-gate proof)', () => {
  const base = {
    engine: 'claude' as const,
    hostId: null,
    auth: CLAUDE_CANONICAL_AUTH,
    digest: CLAUDE_CANONICAL_DIGEST,
    lastRefresh: CLAUDE_AUTH.last_refresh,
    ttlSeconds: 900,
  };

  it('returns unknown without downgrading when the runner is not configured', async () => {
    const { client } = countingRunner({ ok: true, status: 'ok', reachable: true }, false);
    const { svc } = makeStore(client);
    const out = await svc.ensureServedVerification({
      ...base,
      row: { id: 1, verificationState: 'pending', verificationCheckedAt: null },
    });
    expect(out.state).toBe('unknown');
    expect(out.refreshed).toBe(false);
  });

  it('still blocks a stored definitive failure when the runner is later unconfigured', () => {
    const { client } = countingRunner({ ok: true, status: 'ok', reachable: true }, false);
    const { svc } = makeStore(client, 'failed');
    const out = svc.servedVerificationSnapshot({
      ...base,
      row: {
        id: 1,
        verificationState: 'failed',
        verificationCheckedAt: nowMinus(60),
        verificationReason: 'expired',
      },
    });
    expect(out.state).toBe('failed');
    expect(out.reason).toBe('expired');
  });

  it('serves only the stored verification snapshot without probing the runner', () => {
    const r = countingRunner({ ok: false, status: 'fail', reachable: true, reason: 'would block' });
    const { svc } = makeStore(r.client);
    const verified = svc.servedVerificationSnapshot({
      ...base,
      ttlSeconds: 0,
      row: { id: 1, verificationState: 'verified', verificationCheckedAt: nowMinus(99999) },
    });
    const failed = svc.servedVerificationSnapshot({
      ...base,
      ttlSeconds: 0,
      row: {
        id: 1,
        verificationState: 'failed',
        verificationCheckedAt: nowMinus(99999),
        verificationReason: 'token expired',
      },
    });

    expect(verified.state).toBe('verified');
    expect(failed.state).toBe('failed');
    expect(failed.reason).toBe('token expired');
    expect(r.calls()).toBe(0);
  });

  it('trusts a within-TTL verified verdict and skips the live probe', async () => {
    const r = countingRunner({ ok: true, status: 'ok', reachable: true });
    const { svc } = makeStore(r.client);
    const out = await svc.ensureServedVerification({
      ...base,
      ttlSeconds: 1_000_000,
      row: { id: 1, verificationState: 'verified', verificationCheckedAt: nowMinus(60) },
    });
    expect(out.state).toBe('verified');
    expect(r.calls()).toBe(0);
  });

  it('stamps verified and serves the blob unchanged on a live ok verdict', async () => {
    const r = countingRunner({ ok: true, status: 'ok', reachable: true });
    const { db, svc } = makeStore(r.client);
    const out = await svc.ensureServedVerification({
      ...base,
      ttlSeconds: 0,
      row: { id: 1, verificationState: 'pending', verificationCheckedAt: null },
    });
    expect(out.state).toBe('verified');
    expect(out.digest).toBe(CLAUDE_CANONICAL_DIGEST);
    expect(r.calls()).toBe(1);
    expect(db.tables.get(authPayloads)![0]!.verificationState).toBe('verified');
  });

  it('accepts a successful raw readback rewrite with the same canonical digest without a new generation', async () => {
    const r = countingRunner({
      ok: true,
      status: 'ok',
      reachable: true,
      auth_readback: 'updated',
      updated_auth: {
        claudeAiOauth: {
          accessToken: CLAUDE_AUTH.claudeAiOauth.accessToken,
          refreshToken: CLAUDE_AUTH.claudeAiOauth.refreshToken,
        },
      },
    });
    const { db, svc } = makeStore(r.client);
    const out = await svc.ensureServedVerification({
      ...base,
      ttlSeconds: 0,
      row: { id: 1, verificationState: 'pending', verificationCheckedAt: null },
    });

    expect(out).toMatchObject({
      state: 'verified',
      digest: CLAUDE_CANONICAL_DIGEST,
      refreshed: false,
    });
    expect(db.tables.get(authPayloads)).toHaveLength(1);
    expect(db.tables.get(authPayloads)![0]).toMatchObject({
      id: 1,
      generation: 1,
      verificationState: 'verified',
    });
  });

  it('marks the payload failed when the runner reaches the provider and rejects', async () => {
    const r = countingRunner({
      ok: false,
      status: 'fail',
      reachable: true,
      definitive: true,
      reason: 'token expired',
    });
    const { db, svc } = makeStore(r.client);
    const out = await svc.ensureServedVerification({
      ...base,
      ttlSeconds: 0,
      row: { id: 1, verificationState: 'verified', verificationCheckedAt: nowMinus(99999) },
    });
    expect(out.state).toBe('failed');
    expect(out.reason).toBe('token expired');
    expect(db.tables.get(authPayloads)![0]!.verificationState).toBe('failed');
  });

  it('trusts a within-TTL failed verdict and skips the live probe', async () => {
    const r = countingRunner({ ok: true, status: 'ok', reachable: true });
    const { svc } = makeStore(r.client, 'failed');
    const out = await svc.ensureServedVerification({
      ...base,
      ttlSeconds: 1_000_000,
      row: {
        id: 1,
        verificationState: 'failed',
        verificationCheckedAt: nowMinus(60),
        verificationReason: 'token expired',
      },
    });
    expect(out.state).toBe('failed');
    expect(out.reason).toBe('token expired');
    expect(r.calls()).toBe(0);
  });

  it('returns unknown without downgrading on a runner outage', async () => {
    const r = countingRunner({ ok: false, status: 'fail', reachable: false, reason: 'down' });
    const { db, svc } = makeStore(r.client, 'verified');
    const out = await svc.ensureServedVerification({
      ...base,
      ttlSeconds: 0,
      row: { id: 1, verificationState: 'verified', verificationCheckedAt: nowMinus(99999) },
    });
    expect(out.state).toBe('unknown');
    // Outage must not flip a previously-verified payload to failed.
    expect(db.tables.get(authPayloads)![0]!.verificationState).toBe('verified');
  });

  it('returns unknown without downgrading on a reachable-but-garbled runner response', async () => {
    // Proxy error pages / empty bodies reach the runner URL but prove nothing
    // about the credentials — they must not withhold working auth fleet-wide.
    const r = countingRunner({
      ok: false,
      status: 'fail',
      reachable: true,
      definitive: false,
      reason: 'invalid runner response (status 502)',
    });
    const { db, svc } = makeStore(r.client, 'verified');
    const out = await svc.ensureServedVerification({
      ...base,
      ttlSeconds: 0,
      row: { id: 1, verificationState: 'verified', verificationCheckedAt: nowMinus(99999) },
    });
    expect(out.state).toBe('unknown');
    expect(db.tables.get(authPayloads)![0]!.verificationState).toBe('verified');
  });

  it.each([
    {
      label: 'retryable',
      verdict: {
        ok: false,
        status: 'fail',
        reachable: false,
        definitive: false,
        reason: 'CLI timed out after rewriting the file',
      } satisfies RunnerVerifyResult,
      expectedState: 'unknown',
      expectedStoredState: 'verified',
    },
    {
      label: 'definitive',
      verdict: {
        ok: false,
        status: 'fail',
        reachable: true,
        definitive: true,
        reason: 'token expired',
      } satisfies RunnerVerifyResult,
      expectedState: 'failed',
      expectedStoredState: 'failed',
    },
  ])(
    'applies the ordinary $label reverify verdict when raw readback canonicalizes to the same digest',
    async ({ verdict, expectedState, expectedStoredState }) => {
      const r = countingRunner({
        ...verdict,
        auth_readback: 'updated',
        updated_auth: {
          claudeAiOauth: {
            accessToken: CLAUDE_AUTH.claudeAiOauth.accessToken,
            refreshToken: CLAUDE_AUTH.claudeAiOauth.refreshToken,
          },
        },
      });
      const { db, svc } = makeStore(r.client, 'verified');
      const out = await svc.ensureServedVerification({
        ...base,
        ttlSeconds: 0,
        row: { id: 1, verificationState: 'verified', verificationCheckedAt: nowMinus(99999) },
      });

      expect(out.state).toBe(expectedState);
      expect(db.tables.get(authPayloads)).toHaveLength(1);
      expect(db.tables.get(authPayloads)![0]).toMatchObject({
        id: 1,
        generation: 1,
        verificationState: expectedStoredState,
      });
    },
  );

  it('persists and serves a runner-refreshed blob (rotation-safe)', async () => {
    const r = countingRunner({
      ok: true,
      status: 'ok',
      reachable: true,
      updated_auth: {
        last_refresh: '2026-05-20T10:00:00Z',
        claudeAiOauth: { accessToken: 'sk-ant-oat01-new', refreshToken: 'r2' },
      },
    });
    const { db, svc } = makeStore(r.client);
    const out = await svc.ensureServedVerification({
      ...base,
      ttlSeconds: 0,
      row: { id: 1, verificationState: 'pending', verificationCheckedAt: null },
    });
    expect(out.state).toBe('verified');
    expect(out.refreshed).toBe(true);
    expect(out.lastRefresh).toBe('2026-05-20T10:00:00Z');
    // A fresh canonical row was minted for the refreshed credentials.
    expect(db.tables.get(authPayloads)!.length).toBeGreaterThan(1);
  });

  it('fails closed when a successful probe reports unusable changed credentials', async () => {
    const r = countingRunner({
      ok: true,
      status: 'ok',
      reachable: true,
      updated_auth: { last_refresh: '2026-05-20T10:00:00Z', poem: 'not credentials' },
    });
    const { db, svc } = makeStore(r.client, 'verified');
    const out = await svc.ensureServedVerification({
      ...base,
      ttlSeconds: 0,
      row: { id: 1, verificationState: 'verified', verificationCheckedAt: nowMinus(99999) },
    });
    expect(out.state).toBe('failed');
    expect(out.reason).toContain('updated_auth_no_inspectable_credential');
    expect(db.tables.get(authPayloads)![0]!.verificationState).toBe('failed');
  });

  it('fails the old lineage instead of throwing when runner refresh metadata is malformed', async () => {
    const r = countingRunner({
      ok: true,
      status: 'ok',
      reachable: true,
      auth_readback: 'updated',
      updated_auth: {
        last_refresh: 'malformed',
        claudeAiOauth: {
          accessToken: 'sk-ant-oat01-refreshed-valid-token',
          refreshToken: 'refreshed-valid-r2',
        },
      },
    });
    const { db, svc } = makeStore(r.client, 'verified');
    const out = await svc.ensureServedVerification({
      ...base,
      ttlSeconds: 0,
      row: { id: 1, verificationState: 'verified', verificationCheckedAt: nowMinus(99999) },
    });
    expect(out.state).toBe('failed');
    expect(out.reason).toContain('updated_auth_invalid_last_refresh');
    expect(db.tables.get(authPayloads)![0]!.verificationState).toBe('failed');
  });

  it('fails the old lineage when successful native readback is unreadable', async () => {
    const r = countingRunner({
      ok: true,
      status: 'ok',
      reachable: true,
      auth_readback: 'error',
      auth_readback_error: 'invalid JSON',
    });
    const { db, svc } = makeStore(r.client, 'verified');
    const out = await svc.ensureServedVerification({
      ...base,
      ttlSeconds: 0,
      row: { id: 1, verificationState: 'verified', verificationCheckedAt: nowMinus(99999) },
    });
    expect(out.state).toBe('failed');
    expect(out.reason).toContain('invalid JSON');
    expect(db.tables.get(authPayloads)![0]!.verificationState).toBe('failed');
  });

  it('stores a non-definitive runner rotation pending without reporting a verified refresh', async () => {
    const r = countingRunner({
      ok: false,
      status: 'fail',
      reachable: false,
      definitive: false,
      auth_readback: 'updated',
      reason: 'timed out after refresh',
      updated_auth: {
        last_refresh: '2026-05-20T10:00:00Z',
        claudeAiOauth: {
          accessToken: 'sk-ant-oat01-pending-worker-token',
          refreshToken: 'pending-worker-r2',
        },
      },
    });
    const { db, svc } = makeStore(r.client, 'verified');
    const out = await svc.ensureServedVerification({
      ...base,
      ttlSeconds: 0,
      row: { id: 1, verificationState: 'verified', verificationCheckedAt: nowMinus(99999) },
    });
    expect(out.state).toBe('failed');
    expect(out.refreshed).toBe(false);
    expect(db.tables.get(authPayloads)).toHaveLength(2);
    expect(db.tables.get(authPayloads)![0]!.verificationState).toBe('failed');
    expect(db.tables.get(authPayloads)![1]!.verificationState).toBe('pending');
  });

  it('stores a definitive runner rotation failed so the replacement is retained but never served', async () => {
    const r = countingRunner({
      ok: false,
      status: 'fail',
      reachable: true,
      definitive: true,
      auth_readback: 'updated',
      reason: 'OAuth token has expired',
      updated_auth: {
        last_refresh: '2026-05-20T10:00:00Z',
        claudeAiOauth: {
          accessToken: 'sk-ant-oat01-failed-worker-token',
          refreshToken: 'failed-worker-replacement-r2',
        },
      },
    });
    const { db, svc } = makeStore(r.client, 'verified');
    const out = await svc.ensureServedVerification({
      ...base,
      ttlSeconds: 0,
      row: { id: 1, verificationState: 'verified', verificationCheckedAt: nowMinus(99999) },
    });

    expect(out.state).toBe('failed');
    expect(out.reason).toContain('OAuth token has expired');
    expect(out.refreshed).toBe(false);
    expect(db.tables.get(authPayloads)).toHaveLength(2);
    const stored = db.tables.get(authPayloads)![1]!;
    expect(stored.verificationState).toBe('failed');
    expect(stored.verificationCheckedAt).not.toBeNull();
    const keyring = makeKeyring();
    const decoded = JSON.parse(decryptOrNull(stored.body as string, keyring)!);
    expect(decoded.claudeAiOauth.refreshToken).toBe('failed-worker-replacement-r2');

    const snapshot = svc.servedVerificationSnapshot({
      ...base,
      row: {
        id: stored.id as number,
        verificationState: stored.verificationState as string,
        verificationCheckedAt: stored.verificationCheckedAt as string,
        verificationReason: stored.verificationReason as string,
      },
      auth: out.auth,
      digest: out.digest,
      lastRefresh: out.lastRefresh,
    });
    expect(snapshot.state).toBe('failed');
  });

  it('CAS-replaces the expected canonical when runner refresh keeps the same generation stamp', async () => {
    const db = createDbFake();
    db.tables.set(authEntries, []);
    const keyring = makeKeyring();
    const validation = createRunnerValidationService({ db: db as never, keyring });
    const canonical = validation.canonicalizeAuthPayload(
      CLAUDE_AUTH,
      validation.normalizeAuthEntries(CLAUDE_AUTH, 'claude'),
      CLAUDE_AUTH.last_refresh,
'claude',
);
    const encoded = JSON.stringify(canonical);
    const digest = validation.calculateDigest(encoded);
    db.tables.set(authPayloads, [
      {
        id: 1,
        lastRefresh: CLAUDE_AUTH.last_refresh,
        sha256: digest,
        sourceHostId: null,
        createdAt: CLAUDE_AUTH.last_refresh,
        body: encrypt(encoded, keyring),
        verificationState: 'verified',
        verificationCheckedAt: '2026-01-01T00:00:00Z',
        verificationReason: null,
        engine: 'claude',
      },
    ]);
    const r = countingRunner({
      ok: true,
      status: 'ok',
      reachable: true,
      updated_auth: {
        last_refresh: CLAUDE_AUTH.last_refresh,
        claudeAiOauth: { accessToken: 'sk-ant-oat01-rotated', refreshToken: 'r2' },
      },
    });
    const svc = createCanonicalAuthStoreService({
      db: db as never,
      keyring,
      runnerValidation: validation,
      runner: r.client,
    });

    const out = await svc.ensureServedVerification({
      engine: 'claude',
      hostId: null,
      row: {
        id: 1,
        verificationState: 'verified',
        verificationCheckedAt: '2026-01-01T00:00:00Z',
      },
      auth: canonical,
      digest,
      lastRefresh: CLAUDE_AUTH.last_refresh,
      ttlSeconds: 0,
    });

    expect(out.refreshed).toBe(true);
    expect(Date.parse(out.lastRefresh)).toBeGreaterThan(Date.parse(CLAUDE_AUTH.last_refresh));
    expect(JSON.stringify(out.auth)).toContain('sk-ant-oat01-rotated');
    expect(r.calls()).toBe(1);
    expect((await validation.resolveCanonicalPayload('claude'))?.id).toBe(2);
  });

  it('persists the exact normalized Codex bytes after a live worker verdict', async () => {
    const db = createDbFake();
    db.tables.set(authEntries, []);
    const keyring = makeKeyring();
    const validation = createRunnerValidationService({ db: db as never, keyring });
    const raw = {
      last_refresh: CODEX_AUTH.last_refresh,
      OPENAI_API_KEY: 'sk-native-api-key-winner-123',
      tokens: { access_token: 'old-runner-oauth-winner-123', refresh_token: 'old-refresh-123' },
      auths: { 'api.openai.com': { token: 'old-runner-oauth-winner-123', token_type: 'bearer' } },
    };
    const encoded = JSON.stringify(raw);
    const digest = validation.calculateDigest(encoded);
    db.tables.set(authPayloads, [
      {
        id: 1,
        lastRefresh: CODEX_AUTH.last_refresh,
        sha256: digest,
        sourceHostId: null,
        createdAt: CODEX_AUTH.last_refresh,
        body: encrypt(encoded, keyring),
        verificationState: 'verified',
        verificationCheckedAt: new Date().toISOString(),
        verificationReason: null,
        engine: 'codex',
        generation: 1,
      },
    ]);
    db.tables.set(authCanonicalHeads, [
      {
        engine: 'codex',
        payloadId: 1,
        generation: 1,
        updatedAt: CODEX_AUTH.last_refresh,
      },
    ]);
    const projected = validation.ensureAuthsFallback(raw, 'codex');
    const normalized = validation.canonicalizeAuthPayload(
      projected,
      validation.normalizeAuthEntries(projected, 'codex'),
      CODEX_AUTH.last_refresh,
      'codex',
    );
    const live = countingRunner({ ok: true, status: 'ok', reachable: true });
    const svc = createCanonicalAuthStoreService({
      db: db as never,
      keyring,
      runnerValidation: validation,
      runner: live.client,
    });

    const out = await svc.ensureServedVerification({
      engine: 'codex',
      hostId: null,
      row: {
        id: 1,
        verificationState: 'verified',
        verificationCheckedAt: new Date().toISOString(),
      },
      auth: normalized,
      digest,
      lastRefresh: CODEX_AUTH.last_refresh,
      ttlSeconds: 1_000_000,
      forceLive: true,
    });

    expect(out.state).toBe('verified');
    expect(out.refreshed).toBe(true);
    expect(out.auth).toMatchObject({
      auth_mode: 'apikey',
      OPENAI_API_KEY: 'sk-native-api-key-winner-123',
    });
    expect(out.auth.tokens).toBeUndefined();
    expect(live.calls()).toBe(1);
    expect((await validation.resolveCanonicalPayload('codex'))?.id).toBe(2);
  });

  it('withholds and live-normalizes conflicting verified Claude bytes before distribution', async () => {
    const db = createDbFake();
    db.tables.set(authEntries, []);
    const keyring = makeKeyring();
    const validation = createRunnerValidationService({ db: db as never, keyring });
    const raw = {
      last_refresh: CLAUDE_AUTH.last_refresh,
      claudeAiOauth: {
        accessToken: 'sk-ant-oat01-native-winner-token-123',
        refreshToken: 'native-refresh-token-123',
        expiresAt: 1_797_000_000_000,
      },
      api_key: 'sk-ant-api03-shadow-key-loser-token-123',
      tokens: { anthropic_api_key: 'sk-ant-api03-nested-loser-token-123' },
      auths: {
        'api.anthropic.com': {
          token: 'sk-ant-api03-stale-derived-loser-token-123',
          token_type: 'bearer',
        },
      },
    };
    const encoded = JSON.stringify(raw);
    const digest = validation.calculateDigest(encoded);
    const checkedAt = new Date().toISOString();
    const rawRow = {
      id: 1,
      lastRefresh: CLAUDE_AUTH.last_refresh,
      sha256: digest,
      sourceHostId: null,
      createdAt: CLAUDE_AUTH.last_refresh,
      body: encrypt(encoded, keyring),
      verificationState: 'verified',
      verificationCheckedAt: checkedAt,
      verificationReason: null,
      engine: 'claude',
      generation: 1,
    };
    db.tables.set(authPayloads, [rawRow]);
    db.tables.set(authCanonicalHeads, [
      {
        engine: 'claude',
        payloadId: 1,
        generation: 1,
        updatedAt: CLAUDE_AUTH.last_refresh,
      },
    ]);
    expect(validation.canonicalAuthFromPayload(rawRow)).toBeNull();

    const projected = validation.ensureAuthsFallback(raw, 'claude');
    const normalized = validation.canonicalizeAuthPayload(
      projected,
      validation.normalizeAuthEntries(projected, 'claude'),
      CLAUDE_AUTH.last_refresh,
      'claude',
    );
    const live = countingRunner({ ok: true, status: 'ok', reachable: true });
    const svc = createCanonicalAuthStoreService({
      db: db as never,
      keyring,
      runnerValidation: validation,
      runner: live.client,
    });

    const out = await svc.ensureServedVerification({
      engine: 'claude',
      hostId: null,
      row: {
        id: 1,
        verificationState: 'verified',
        verificationCheckedAt: checkedAt,
      },
      auth: normalized,
      digest,
      lastRefresh: CLAUDE_AUTH.last_refresh,
      ttlSeconds: 1_000_000,
      forceLive: true,
    });

    expect(out.state).toBe('verified');
    expect(out.refreshed).toBe(true);
    expect(out.auth).toMatchObject({
      claudeAiOauth: {
        accessToken: 'sk-ant-oat01-native-winner-token-123',
        refreshToken: 'native-refresh-token-123',
      },
      auths: {
        'api.anthropic.com': { token: 'sk-ant-oat01-native-winner-token-123' },
      },
    });
    expect(out.auth.api_key).toBeUndefined();
    expect(out.auth.tokens).toBeUndefined();
    expect(live.calls()).toBe(1);
    expect((await validation.resolveCanonicalPayload('claude'))?.id).toBe(2);
  });

  it('immediately reissues a fresh verified row with partial fingerprint metadata', async () => {
    const db = createDbFake();
    db.tables.set(authEntries, []);
    const keyring = makeKeyring();
    const validation = createRunnerValidationService({ db: db as never, keyring });
    const projected = validation.ensureAuthsFallback(CODEX_AUTH, 'codex');
    const canonical = validation.canonicalizeAuthPayload(
      projected,
      validation.normalizeAuthEntries(projected, 'codex'),
      CODEX_AUTH.last_refresh,
      'codex',
    );
    const body = JSON.stringify(canonical);
    const digest = validation.calculateDigest(body);
    const checkedAt = new Date().toISOString();
    const brokenRow = {
      id: 1,
      lastRefresh: CODEX_AUTH.last_refresh,
      sha256: digest,
      sourceHostId: null,
      createdAt: CODEX_AUTH.last_refresh,
      body: encrypt(body, keyring),
      verificationState: 'verified',
      verificationCheckedAt: checkedAt,
      verificationReason: null,
      engine: 'codex',
      generation: 1,
      fingerprintKid: keyring.active().kid,
      pairFingerprint: null,
    };
    db.tables.set(authPayloads, [brokenRow]);
    db.tables.set(authCanonicalHeads, [
      {
        engine: 'codex',
        payloadId: 1,
        generation: 1,
        updatedAt: CODEX_AUTH.last_refresh,
      },
    ]);
    expect(validation.canonicalAuthFromPayload(brokenRow)).toBeNull();

    const live = countingRunner({ ok: true, status: 'ok', reachable: true });
    const svc = createCanonicalAuthStoreService({
      db: db as never,
      keyring,
      runnerValidation: validation,
      runner: live.client,
    });
    await runAuthVerificationWorkerTick({
      runnerValidation: validation,
      authStore: svc,
      telemetry: { write: async () => undefined },
      ttlSeconds: 1_000_000,
      reason: 'interval',
    });

    const repaired = await validation.resolveCanonicalPayload('codex');
    expect(live.calls()).toBe(1);
    expect(repaired?.id).toBe(2);
    expect(repaired?.generation).toBe(2);
    expect(repaired?.fingerprintKid).toBe(keyring.active().kid);
    expect(repaired?.pairFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(validation.canonicalAuthFromPayload(repaired!)).not.toBeNull();
  });

  it('verifies the codex engine via runner.verify and marks a dead token failed', async () => {
    const r = countingRunner({
      ok: false,
      status: 'fail',
      reachable: true,
      definitive: true,
      reason: 'refresh token already used',
    });
    const { db, svc } = makeStore(r.client);
    const out = await svc.ensureServedVerification({
      engine: 'codex',
      hostId: null,
      auth: CODEX_AUTH,
      digest: 'dig',
      lastRefresh: CODEX_AUTH.last_refresh,
      ttlSeconds: 0,
      row: { id: 1, verificationState: 'verified', verificationCheckedAt: nowMinus(99999) },
    });
    expect(out.state).toBe('failed');
    expect(out.reason).toBe('refresh token already used');
    expect(db.tables.get(authPayloads)![0]!.verificationState).toBe('failed');
  });

  it('single-flights concurrent codex probes for one canonical row', async () => {
    const r = countingRunner({ ok: true, status: 'ok', reachable: true });
    const { svc } = makeStore(r.client);
    const input = {
      engine: 'codex' as const,
      hostId: null,
      auth: CODEX_AUTH,
      digest: 'dig',
      lastRefresh: CODEX_AUTH.last_refresh,
      ttlSeconds: 0,
      row: { id: 1, verificationState: 'verified' as const, verificationCheckedAt: nowMinus(99999) },
    };
    const [a, b] = await Promise.all([
      svc.ensureServedVerification(input),
      svc.ensureServedVerification(input),
    ]);
    expect(a.state).toBe('verified');
    expect(b.state).toBe('verified');
    // Both callers shared one live probe instead of racing the token rotation.
    expect(r.calls()).toBe(1);
  });
});

// A Claude OAuth credential whose access token has expired can only be
// live-verified by spending its refresh token — which races host-side native
// refreshes of the same rotating grant and gets the family revoked. These
// tests pin the no-probe gates that keep the runner's hands off refresh
// material (see shared://auth.claude-oauth-refresh-race).
describe('claude expired-access probe gates', () => {
  const FUTURE_REFRESH_MS = Date.now() + 30 * 24 * 3600 * 1000;

  function claudeAuthWithExpiry(opts: {
    access: string;
    refresh: string;
    accessExpiresMs: number;
    refreshExpiresMs?: number;
    lastRefresh: string;
  }): Record<string, unknown> {
    return {
      last_refresh: opts.lastRefresh,
      claudeAiOauth: {
        accessToken: opts.access,
        refreshToken: opts.refresh,
        expiresAt: opts.accessExpiresMs,
        refreshTokenExpiresAt: opts.refreshExpiresMs ?? FUTURE_REFRESH_MS,
      },
    };
  }

  function seedClaudeCanonical(
    source: Record<string, unknown>,
    state: 'verified' | 'failed',
    reason: string | null = null,
  ) {
    const db = createDbFake();
    db.tables.set(authEntries, []);
    const keyring = makeKeyring();
    const validation = createRunnerValidationService({ db: db as never, keyring });
    const projected = validation.ensureAuthsFallback(source, 'claude');
    const canonical = validation.canonicalizeAuthPayload(
      projected,
      validation.normalizeAuthEntries(projected, 'claude'),
      String(source.last_refresh),
      'claude',
    );
    const body = JSON.stringify(canonical);
    const digest = validation.calculateDigest(body);
    const metadata = credentialMetadata(inspectCredential(canonical, 'claude')!, keyring.active());
    db.tables.set(authPayloads, [
      {
        id: 1,
        lastRefresh: String(source.last_refresh),
        sha256: digest,
        sourceHostId: null,
        createdAt: String(source.last_refresh),
        body: encrypt(body, keyring),
        verificationState: state,
        verificationCheckedAt: nowMinus(99999),
        verificationReason: reason,
        engine: 'claude',
        generation: 1,
        ...metadata,
      },
    ]);
    db.tables.set(authCanonicalHeads, [
      { engine: 'claude', payloadId: 1, generation: 1, updatedAt: String(source.last_refresh) },
    ]);
    return { db, keyring, validation, canonical, digest };
  }

  it('serves a verified canonical without probing once its access token expired', async () => {
    const source = claudeAuthWithExpiry({
      access: 'sk-ant-oat01-expired-access-token',
      refresh: 'live-refresh-token',
      accessExpiresMs: Date.now() - 60_000,
      lastRefresh: nowMinus(9 * 3600),
    });
    const { db, keyring, validation, canonical, digest } = seedClaudeCanonical(source, 'verified');
    const live = countingRunner({ ok: true, status: 'ok', reachable: true });
    const svc = createCanonicalAuthStoreService({
      db: db as never,
      keyring,
      runnerValidation: validation,
      runner: live.client,
    });

    const out = await svc.ensureServedVerification({
      engine: 'claude',
      hostId: null,
      row: { id: 1, verificationState: 'verified', verificationCheckedAt: nowMinus(99999) },
      auth: canonical,
      digest,
      lastRefresh: String(source.last_refresh),
      ttlSeconds: 0,
    });

    expect(out.state).toBe('verified');
    expect(out.refreshed).toBe(false);
    expect(live.calls()).toBe(0);
    expect(db.tables.get(authPayloads)![0]!.verificationState).toBe('verified');
  });

  it('worker tick reports ok for an expired-access verified canonical without probing', async () => {
    const source = claudeAuthWithExpiry({
      access: 'sk-ant-oat01-expired-access-token',
      refresh: 'live-refresh-token',
      accessExpiresMs: Date.now() - 60_000,
      lastRefresh: nowMinus(9 * 3600),
    });
    const { db, keyring, validation } = seedClaudeCanonical(source, 'verified');
    const live = countingRunner({ ok: true, status: 'ok', reachable: true });
    const svc = createCanonicalAuthStoreService({
      db: db as never,
      keyring,
      runnerValidation: validation,
      runner: live.client,
    });
    const telemetry: Array<{ engine: string; state: string }> = [];

    await runAuthVerificationWorkerTick({
      runnerValidation: validation,
      authStore: svc,
      telemetry: {
        write: async (engine, state) => {
          telemetry.push({ engine, state });
        },
      },
      ttlSeconds: 0,
      reason: 'interval',
    });

    expect(live.calls()).toBe(0);
    expect(db.tables.get(authPayloads)![0]!.verificationState).toBe('verified');
    expect(telemetry).toContainEqual({ engine: 'claude', state: 'ok' });
  });

  it('still probes (and may fail) when the refresh token itself is expired', async () => {
    const source = claudeAuthWithExpiry({
      access: 'sk-ant-oat01-expired-access-token',
      refresh: 'dead-refresh-token',
      accessExpiresMs: Date.now() - 60_000,
      refreshExpiresMs: Date.now() - 30_000,
      lastRefresh: nowMinus(9 * 3600),
    });
    const { db, keyring, validation, canonical, digest } = seedClaudeCanonical(source, 'verified');
    const live = countingRunner({
      ok: false,
      status: 'fail',
      reachable: true,
      definitive: true,
      reason: 'OAuth session expired',
      auth_readback: 'unchanged',
    });
    const svc = createCanonicalAuthStoreService({
      db: db as never,
      keyring,
      runnerValidation: validation,
      runner: live.client,
    });

    const out = await svc.ensureServedVerification({
      engine: 'claude',
      hostId: null,
      row: { id: 1, verificationState: 'verified', verificationCheckedAt: nowMinus(99999) },
      auth: canonical,
      digest,
      lastRefresh: String(source.last_refresh),
      ttlSeconds: 0,
    });

    expect(live.calls()).toBe(1);
    expect(out.state).toBe('failed');
    expect(db.tables.get(authPayloads)![0]!.verificationState).toBe('failed');
  });

  it('arbitrates an unverifiable expired-access candidate against a verified canonical without probing or storing', async () => {
    const source = claudeAuthWithExpiry({
      access: 'sk-ant-oat01-canonical-token',
      refresh: 'canonical-refresh-token',
      accessExpiresMs: Date.now() - 3600_000,
      lastRefresh: nowMinus(10 * 3600),
    });
    const { db, keyring, validation } = seedClaudeCanonical(source, 'verified');
    const live = countingRunner({ ok: true, status: 'ok', reachable: true });
    const svc = createCanonicalAuthStoreService({
      db: db as never,
      keyring,
      runnerValidation: validation,
      runner: live.client,
    });

    const stored = await svc.storeCandidate({
      auth: claudeAuthWithExpiry({
        access: 'sk-ant-oat01-newer-but-expired-token',
        refresh: 'newer-refresh-token',
        accessExpiresMs: Date.now() - 60_000,
        lastRefresh: nowMinus(600),
      }),
      engine: 'claude',
      sourceHostId: 7,
      requireLastRefresh: false,
      logAction: 'auth.store',
      sourceKind: 'host',
    });

    expect(live.calls()).toBe(0);
    expect(stored.status).toBe('outdated');
    expect(stored.candidate_rejected_definitive).toBeUndefined();
    expect(stored.verification_state).toBe('verified');
    expect(stored.auth).toBeDefined();
    // Nothing was persisted: the candidate stays host-side until it refreshes.
    expect(db.tables.get(authPayloads)!.length).toBe(1);
  });

  it('gates an unverifiable expired-access candidate retryably when no verified canonical exists', async () => {
    const source = claudeAuthWithExpiry({
      access: 'sk-ant-oat01-dead-canonical-token',
      refresh: 'dead-canonical-refresh',
      accessExpiresMs: Date.now() - 3600_000,
      lastRefresh: nowMinus(10 * 3600),
    });
    const { db, keyring, validation } = seedClaudeCanonical(
      source,
      'failed',
      'Failed to authenticate: OAuth session expired and could not be refreshed',
    );
    const live = countingRunner({ ok: true, status: 'ok', reachable: true });
    const svc = createCanonicalAuthStoreService({
      db: db as never,
      keyring,
      runnerValidation: validation,
      runner: live.client,
    });

    let caught: unknown;
    try {
      await svc.storeCandidate({
        auth: claudeAuthWithExpiry({
          access: 'sk-ant-oat01-newer-but-expired-token',
          refresh: 'newer-refresh-token',
          accessExpiresMs: Date.now() - 60_000,
          lastRefresh: nowMinus(600),
        }),
        engine: 'claude',
        sourceHostId: 7,
        requireLastRefresh: false,
        logAction: 'auth.store',
        sourceKind: 'host',
      });
    } catch (err) {
      caught = err;
    }

    expect(live.calls()).toBe(0);
    expect(caught).toBeInstanceOf(ServiceUnavailableError);
    expect((caught as ServiceUnavailableError).code).toBe('candidate_unverifiable_expired');
    expect(db.tables.get(authPayloads)!.length).toBe(1);
  });
});

// Same gates, codex flavor: expiry rides in the access JWT's exp claim and the
// refresh token has no expiry of its own (refreshExpiresAt is always null).
describe('codex expired-access probe gates', () => {
  function fakeJwt(expEpochSeconds: number): string {
    const header = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url');
    const payload = Buffer.from(
      JSON.stringify({ exp: expEpochSeconds, iat: expEpochSeconds - 10 * 24 * 3600 }),
    ).toString('base64url');
    return `${header}.${payload}.sig`;
  }

  function codexAuthWithExpiry(opts: {
    accessExpiresMs: number;
    refresh: string;
    lastRefresh: string;
  }): Record<string, unknown> {
    return {
      last_refresh: opts.lastRefresh,
      auth_mode: 'chatgpt',
      tokens: {
        access_token: fakeJwt(Math.floor(opts.accessExpiresMs / 1000)),
        refresh_token: opts.refresh,
        account_id: 'acct-test',
      },
    };
  }

  function seedCodexCanonical(source: Record<string, unknown>, state: 'verified' | 'failed') {
    const db = createDbFake();
    db.tables.set(authEntries, []);
    const keyring = makeKeyring();
    const validation = createRunnerValidationService({ db: db as never, keyring });
    const projected = validation.ensureAuthsFallback(source, 'codex');
    const canonical = validation.canonicalizeAuthPayload(
      projected,
      validation.normalizeAuthEntries(projected, 'codex'),
      String(source.last_refresh),
      'codex',
    );
    const body = JSON.stringify(canonical);
    const digest = validation.calculateDigest(body);
    const metadata = credentialMetadata(inspectCredential(canonical, 'codex')!, keyring.active());
    db.tables.set(authPayloads, [
      {
        id: 1,
        lastRefresh: String(source.last_refresh),
        sha256: digest,
        sourceHostId: null,
        createdAt: String(source.last_refresh),
        body: encrypt(body, keyring),
        verificationState: state,
        verificationCheckedAt: nowMinus(99999),
        verificationReason: null,
        engine: 'codex',
        generation: 1,
        ...metadata,
      },
    ]);
    db.tables.set(authCanonicalHeads, [
      { engine: 'codex', payloadId: 1, generation: 1, updatedAt: String(source.last_refresh) },
    ]);
    return { db, keyring, validation, canonical, digest };
  }

  it('serves a verified codex canonical without probing once its access JWT expired', async () => {
    const source = codexAuthWithExpiry({
      accessExpiresMs: Date.now() - 60_000,
      refresh: 'live-codex-refresh',
      lastRefresh: nowMinus(10 * 24 * 3600),
    });
    const { db, keyring, validation, canonical, digest } = seedCodexCanonical(source, 'verified');
    const live = countingRunner({ ok: true, status: 'ok', reachable: true });
    const svc = createCanonicalAuthStoreService({
      db: db as never,
      keyring,
      runnerValidation: validation,
      runner: live.client,
    });

    const out = await svc.ensureServedVerification({
      engine: 'codex',
      hostId: null,
      row: { id: 1, verificationState: 'verified', verificationCheckedAt: nowMinus(99999) },
      auth: canonical,
      digest,
      lastRefresh: String(source.last_refresh),
      ttlSeconds: 0,
    });

    expect(out.state).toBe('verified');
    expect(live.calls()).toBe(0);
    expect(db.tables.get(authPayloads)![0]!.verificationState).toBe('verified');
  });

  it('still probes a codex credential whose access JWT is comfortably valid', async () => {
    const source = codexAuthWithExpiry({
      accessExpiresMs: Date.now() + 5 * 24 * 3600 * 1000,
      refresh: 'live-codex-refresh',
      lastRefresh: nowMinus(3600),
    });
    const { db, keyring, validation, canonical, digest } = seedCodexCanonical(source, 'verified');
    const live = countingRunner({ ok: true, status: 'ok', reachable: true, auth_readback: 'unchanged' });
    const svc = createCanonicalAuthStoreService({
      db: db as never,
      keyring,
      runnerValidation: validation,
      runner: live.client,
    });

    const out = await svc.ensureServedVerification({
      engine: 'codex',
      hostId: null,
      row: { id: 1, verificationState: 'verified', verificationCheckedAt: nowMinus(99999) },
      auth: canonical,
      digest,
      lastRefresh: String(source.last_refresh),
      ttlSeconds: 0,
    });

    expect(out.state).toBe('verified');
    expect(live.calls()).toBe(1);
  });

  it('arbitrates an unverifiable expired-JWT codex candidate without probing or storing', async () => {
    const source = codexAuthWithExpiry({
      accessExpiresMs: Date.now() - 3600_000,
      refresh: 'canonical-codex-refresh',
      lastRefresh: nowMinus(11 * 24 * 3600),
    });
    const { db, keyring, validation } = seedCodexCanonical(source, 'verified');
    const live = countingRunner({ ok: true, status: 'ok', reachable: true });
    const svc = createCanonicalAuthStoreService({
      db: db as never,
      keyring,
      runnerValidation: validation,
      runner: live.client,
    });

    const stored = await svc.storeCandidate({
      auth: codexAuthWithExpiry({
        accessExpiresMs: Date.now() - 60_000,
        refresh: 'newer-codex-refresh',
        lastRefresh: nowMinus(600),
      }),
      engine: 'codex',
      sourceHostId: 7,
      requireLastRefresh: false,
      logAction: 'auth.store',
      sourceKind: 'host',
    });

    expect(live.calls()).toBe(0);
    expect(stored.status).toBe('outdated');
    expect(stored.candidate_rejected_definitive).toBeUndefined();
    expect(db.tables.get(authPayloads)!.length).toBe(1);
  });
});

function nowMinus(seconds: number): string {
  return new Date(Date.now() - seconds * 1000).toISOString();
}
