import { describe, expect, it } from 'vitest';
import { createCanonicalAuthStoreService } from '../../../src/services/canonical-auth-store.js';
import { createRunnerValidationService } from '../../../src/services/runner-validation.js';
import type { RunnerClient, RunnerVerifyInput, RunnerVerifyResult } from '../../../src/services/runner-client.js';
import { authEntries, authPayloads } from '../../../src/db/schema.js';
import { decryptOrNull } from '../../../src/security/secret-box.js';
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

describe('CanonicalAuthStoreService', () => {
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

  it('skips older runner updated_auth and stores the verified upload candidate', async () => {
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

    const out = await svc.storeCandidate({
      auth: {
        last_refresh: '2026-05-20T09:00:00Z',
        claudeAiOauth: { accessToken: 'sk-ant-oat01-upload' },
      },
      engine: 'claude',
      sourceHostId: null,
      requireLastRefresh: true,
      logAction: 'auth.store',
    });

    expect(out.runner_applied).toBe(false);
    expect(out.runner_skipped_reason).toBe('updated_auth_older_than_upload');
    const stored = db.tables.get(authPayloads)![0]!;
    const decoded = JSON.parse(decryptOrNull(stored.body as string, keyring)!);
    expect(decoded.claudeAiOauth.accessToken).toBe('sk-ant-oat01-upload');
  });

  it('blocks persistence when configured runner verification fails', async () => {
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
    ).rejects.toThrow(/Runner verification failed/);
    expect(db.tables.get(authPayloads)).toHaveLength(0);
  });
});
