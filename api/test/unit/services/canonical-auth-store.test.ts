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
import { authEntries, authPayloads, hostAuthStates } from '../../../src/db/schema.js';
import { decryptOrNull, encrypt } from '../../../src/security/secret-box.js';
import { Keyring } from '../../../src/security/keyring.js';
import { createDbFake } from '../../helpers/db-fake.js';

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

const CODEX_AUTH = {
  last_refresh: '2026-05-20T09:00:00Z',
  auths: { 'api.openai.com': { token: 'sk-openai-base-token' } },
  tokens: { access_token: 'sk-openai-base-token', refresh_token: 'r1' },
};

function makeStore(client: RunnerClient, seedState = 'pending') {
  const db = createDbFake();
  db.tables.set(authPayloads, [
    { id: 1, verificationState: seedState, verificationCheckedAt: null, verificationReason: null },
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
          claudeAiOauth: { accessToken: 'sk-ant-oat01-pending-refresh-token' },
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
      },
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
    expect(Date.parse(tied.canonical_last_refresh)).toBeGreaterThan(
      Date.parse(newer.canonical_last_refresh),
    );
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
      },
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

  it('does not resurrect a failed canonical while live verification is unavailable', async () => {
    const db = createDbFake();
    db.tables.set(authEntries, []);
    const keyring = makeKeyring();
    const validation = createRunnerValidationService({ db: db as never, keyring });
    const failedAuth = validation.canonicalizeAuthPayload(
      CODEX_AUTH,
      validation.normalizeAuthEntries(CODEX_AUTH, 'codex'),
      '2026-07-17T09:00:00Z',
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
      },
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

  it('does not roll an authoritative pending lineage back to an older different candidate', async () => {
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
      },
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

    expect(result.status).toBe('outdated');
    expect(result.canonical_digest).toBe(validation.calculateDigest(pendingBody));
    expect(r.calls()).toBe(0);
    expect(db.tables.get(authPayloads)).toHaveLength(1);
  });

  it('does not restamp a stale repair over a different newer lineage discovered after the probe', async () => {
    const db = createDbFake();
    db.tables.set(authEntries, []);
    const keyring = makeKeyring();
    const validation = createRunnerValidationService({ db: db as never, keyring });
    const makeRow = (
      id: number,
      stamp: string,
      token: string,
      verificationState: 'failed' | 'pending',
    ) => {
      const source = {
        last_refresh: stamp,
        tokens: { access_token: token, refresh_token: `${token}-refresh` },
      };
      const withFallback = validation.ensureAuthsFallback(source, 'codex');
      const canonical = validation.canonicalizeAuthPayload(
        withFallback,
        validation.normalizeAuthEntries(withFallback, 'codex'),
        stamp,
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
    expect(result.status).toBe('outdated');
    expect(result.canonical_digest).toBe(newer.sha256);
    expect(db.tables.get(authPayloads)).toHaveLength(2);
  });
});

describe('ensureServedVerification (launch-gate proof)', () => {
  const base = {
    engine: 'claude' as const,
    hostId: null,
    auth: CLAUDE_AUTH,
    digest: 'dig',
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
    expect(out.digest).toBe('dig');
    expect(r.calls()).toBe(1);
    expect(db.tables.get(authPayloads)![0]!.verificationState).toBe('verified');
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
    expect(out.reason).toContain('updated_auth_no_usable_tokens');
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
        claudeAiOauth: { accessToken: 'sk-ant-oat01-refreshed-valid-token' },
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
        claudeAiOauth: { accessToken: 'sk-ant-oat01-pending-worker-token' },
      },
    });
    const { db, svc } = makeStore(r.client, 'verified');
    const out = await svc.ensureServedVerification({
      ...base,
      ttlSeconds: 0,
      row: { id: 1, verificationState: 'verified', verificationCheckedAt: nowMinus(99999) },
    });
    expect(out.state).toBe('unknown');
    expect(out.refreshed).toBe(false);
    expect(db.tables.get(authPayloads)).toHaveLength(2);
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

function nowMinus(seconds: number): string {
  return new Date(Date.now() - seconds * 1000).toISOString();
}
