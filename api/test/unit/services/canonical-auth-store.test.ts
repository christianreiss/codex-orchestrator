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
  auths: { 'api.anthropic.com': { token: 'tok' } },
  claudeAiOauth: { accessToken: 'sk-ant-oat01-a', refreshToken: 'r1' },
};

const CODEX_AUTH = {
  last_refresh: '2026-05-20T09:00:00Z',
  auths: { 'api.openai.com': { token: 'tok' } },
  tokens: { access_token: 'at1', refresh_token: 'r1' },
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
    const r = countingRunner({ ok: false, status: 'fail', reachable: true, reason: 'token expired' });
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

  it('verifies the codex engine via runner.verify and marks a dead token failed', async () => {
    const r = countingRunner({ ok: false, status: 'fail', reachable: true, reason: 'refresh token already used' });
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
