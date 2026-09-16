import { describe, it, expect, vi } from 'vitest';
import type { SQL } from 'drizzle-orm';
import { MySqlDialect } from 'drizzle-orm/mysql-core';
import type { Database } from '../../../src/db/client.js';
import { authSeedTokens } from '../../../src/db/schema.js';
import { createSeedTokenStore } from '../../../src/services/runner-proxy.js';
import { ValidationError } from '../../../src/http/errors.js';
import type { EnsureServedVerificationInput } from '../../../src/services/canonical-auth-store.js';
import {
  canonicalRow,
  fakeAuthStore,
  fakeRunnerValidation,
  makeRunnerEnv,
  makeRunnerProxy,
  readyRunnerEnv,
  recordingSeedTokens,
} from '../../helpers/runner-proxy-factory.js';
import type { Env } from '../../../src/env.js';

function statusFromVersions(entries: Record<string, string>) {
  const svc = makeRunnerProxy(readyRunnerEnv(), {
    // Telemetry is only projected for an engine that has verified canonical
    // auth, so both engines need a row for these to say anything.
    runnerValidation: fakeRunnerValidation({
      codex: canonicalRow({ id: 1, engine: 'codex' }),
      claude: canonicalRow({ id: 2, engine: 'claude' }),
    }),
    readTelemetry: async () => new Map(Object.entries(entries)),
  });
  return svc.status();
}

describe('RunnerProxyService.status', () => {
  it('reports unconfigured when AUTH_RUNNER_URL is missing', async () => {
    const s = await makeRunnerProxy(makeRunnerEnv()).status();
    expect(s.configured).toBe(false);
    expect(s.ready).toBe(false);
  });

  it('reports not-ready when secret is missing', async () => {
    const s = await makeRunnerProxy(
      makeRunnerEnv({ AUTH_RUNNER_URL: 'https://runner.example.com' } as Partial<Env>),
    ).status();
    expect(s.configured).toBe(true);
    expect(s.ready).toBe(false);
  });

  it('reports ready when both env vars are set', async () => {
    const s = await makeRunnerProxy(readyRunnerEnv()).status();
    expect(s.configured).toBe(true);
    expect(s.ready).toBe(true);
  });

  it('hydrates status from persisted runner telemetry', async () => {
    const s = await statusFromVersions({
      runner_state: 'ok',
      runner_last_check: '2026-05-20T10:09:50Z',
      runner_last_ok: '2026-05-20T10:09:50Z',
      runner_state_claude: 'ok',
      runner_last_check_claude: '2026-05-20T10:09:49Z',
      runner_last_ok_claude: '2026-05-20T10:09:49Z',
    });

    expect(s.ready).toBe(true);
    expect(s.state).toBe('ok');
    expect(s.last_run).toBe('2026-05-20T10:09:50Z');
    expect(s.last_result).toMatchObject({
      codex: { state: 'ok', last_check: '2026-05-20T10:09:50Z' },
      claude: { state: 'ok', last_check: '2026-05-20T10:09:49Z' },
    });
  });

  it('reports idle rather than stale OK telemetry when no canonical auth exists', async () => {
    const svc = makeRunnerProxy(readyRunnerEnv(), {
      runnerValidation: fakeRunnerValidation({ codex: null, claude: null }),
      readTelemetry: async () =>
        new Map([
          ['runner_state', 'ok'],
          ['runner_last_check', '2026-05-20T10:09:50Z'],
          ['runner_last_ok', '2026-05-20T10:09:50Z'],
          ['runner_state_claude', 'ok'],
          ['runner_last_check_claude', '2026-05-20T10:09:49Z'],
          ['runner_last_ok_claude', '2026-05-20T10:09:49Z'],
        ]),
    });

    const s = await svc.status();

    expect(s.state).toBe('idle');
    expect(s.engines?.codex).toMatchObject({ state: 'idle', last_ok: null, last_run: null });
    expect(s.engines?.claude).toMatchObject({ state: 'idle', last_ok: null, last_run: null });
    expect(s.detail).toBe('configured; no verified canonical auth for Codex or Claude');
  });

  it('preserves verified Codex telemetry while projecting missing Claude auth as idle', async () => {
    const svc = makeRunnerProxy(readyRunnerEnv(), {
      runnerValidation: fakeRunnerValidation({
        codex: canonicalRow({ id: 1, engine: 'codex' }),
        claude: null,
      }),
      readTelemetry: async () =>
        new Map([
          ['runner_state', 'ok'],
          ['runner_last_check', '2026-05-20T10:09:50Z'],
          ['runner_last_ok', '2026-05-20T10:09:50Z'],
          ['runner_state_claude', 'ok'],
          ['runner_last_check_claude', '2026-05-20T10:09:49Z'],
          ['runner_last_ok_claude', '2026-05-20T10:09:49Z'],
        ]),
    });

    const s = await svc.status();

    expect(s.state).toBe('ok');
    expect(s.last_run).toBe('2026-05-20T10:09:50Z');
    expect(s.engines?.codex).toMatchObject({ state: 'ok', last_ok: '2026-05-20T10:09:50Z' });
    expect(s.engines?.claude).toMatchObject({ state: 'idle', last_ok: null, last_run: null });
    expect(s.detail).toBe('configured; no verified canonical auth for Claude');
  });

  it('folds a failing Codex engine into a fail state even when Claude is ok', async () => {
    const s = await statusFromVersions({
      runner_state: 'fail',
      runner_last_check: '2026-05-20T10:09:50Z',
      runner_last_fail: '2026-05-20T10:09:50Z',
      runner_state_claude: 'ok',
      runner_last_check_claude: '2026-05-20T10:09:49Z',
      runner_last_ok_claude: '2026-05-20T10:09:49Z',
    });
    expect(s.state).toBe('fail');
    expect(s.last_error).toBe('Codex runner failed at 2026-05-20T10:09:50Z');
  });

  it('folds a failing Claude engine into a fail state even when Codex is ok', async () => {
    const s = await statusFromVersions({
      runner_state: 'ok',
      runner_last_check: '2026-05-20T10:09:50Z',
      runner_last_ok: '2026-05-20T10:09:50Z',
      runner_state_claude: 'fail',
      runner_last_check_claude: '2026-05-20T10:09:49Z',
      runner_last_fail_claude: '2026-05-20T10:09:49Z',
    });
    expect(s.state).toBe('fail');
    expect(s.last_error).toBe('Claude runner failed at 2026-05-20T10:09:49Z');
  });

  it('joins both engine failure labels when both engines fail', async () => {
    const s = await statusFromVersions({
      runner_state: 'fail',
      runner_last_fail: '2026-05-20T10:09:50Z',
      runner_state_claude: 'fail',
      runner_last_fail_claude: '2026-05-20T10:09:49Z',
    });
    expect(s.state).toBe('fail');
    expect(s.last_error).toBe(
      'Codex runner failed at 2026-05-20T10:09:50Z; Claude runner failed at 2026-05-20T10:09:49Z',
    );
  });

  it('reports a null last_error when the failing engine has no last_fail timestamp', async () => {
    const s = await statusFromVersions({
      runner_state: 'fail',
      runner_last_check: '2026-05-20T10:09:50Z',
      runner_state_claude: 'ok',
      runner_last_ok_claude: '2026-05-20T10:09:49Z',
    });
    expect(s.state).toBe('fail');
    expect(s.last_error).toBeNull();
  });

  it('reports ok when only one engine is ok and neither fails', async () => {
    const s = await statusFromVersions({
      runner_state_claude: 'ok',
      runner_last_check_claude: '2026-05-20T10:09:49Z',
      runner_last_ok_claude: '2026-05-20T10:09:49Z',
    });
    expect(s.state).toBe('ok');
    expect(s.last_error).toBeNull();
  });

  it('reports idle when neither engine is ok or fail', async () => {
    const s = await statusFromVersions({
      runner_state: 'pending',
      runner_last_check: '2026-05-20T10:09:50Z',
    });
    expect(s.state).toBe('idle');
    expect(s.last_error).toBeNull();
  });

  it('picks the newest parseable timestamp across both engines for last_run', async () => {
    const s = await statusFromVersions({
      runner_state: 'ok',
      runner_last_check: 'not-a-timestamp',
      runner_last_ok: '',
      runner_last_fail: '2026-05-20T10:00:00Z',
      runner_state_claude: 'ok',
      runner_last_check_claude: '2026-05-20T09:00:00Z',
      runner_last_ok_claude: '2026-05-21T11:30:00Z',
      runner_last_fail_claude: '',
    });
    expect(s.last_run).toBe('2026-05-21T11:30:00Z');
  });

  it('reports a null last_run when no engine timestamp is parseable', async () => {
    const s = await statusFromVersions({
      runner_state: 'ok',
      runner_last_check: 'never',
      runner_last_ok: '',
      runner_state_claude: 'ok',
      runner_last_check_claude: '',
    });
    expect(s.last_run).toBeNull();
  });
});

describe('RunnerProxyService.run', () => {
  it('returns unconfigured when AUTH_RUNNER_URL is missing', async () => {
    const res = await makeRunnerProxy(makeRunnerEnv()).run({}, 'codex');
    expect(res.status).toBe('unconfigured');
    expect(res.probed).toBe(false);
    expect(res.reachable).toBeUndefined();
  });

  it('fails without probing when the engine has no usable canonical payload', async () => {
    let called = false;
    const svc = makeRunnerProxy(readyRunnerEnv(), {
      runnerValidation: fakeRunnerValidation({ claude: null }),
      authStore: fakeAuthStore({}, () => {
        called = true;
      }),
    });

    const res = await svc.run({}, 'claude');

    expect(res.status).toBe('fail');
    expect(res.reason).toBe('Claude canonical auth payload unavailable or invalid');
    expect(res.probed).toBe(false);
    expect(called).toBe(false);
  });

  it('verifies through the canonical store with a forced live probe', async () => {
    const row = canonicalRow({ id: 42, engine: 'claude' });
    let seen: EnsureServedVerificationInput | null = null;
    const svc = makeRunnerProxy(readyRunnerEnv(), {
      runnerValidation: fakeRunnerValidation({ claude: row }),
      authStore: fakeAuthStore(
        { state: 'verified', probe: { reachable: true, definitive: true, latencyMs: 12 } },
        (input) => {
          seen = input as EnsureServedVerificationInput;
        },
      ),
    });

    const res = await svc.run({}, 'claude');

    expect(seen).not.toBeNull();
    const input = seen as unknown as EnsureServedVerificationInput;
    expect(input.engine).toBe('claude');
    expect(input.forceLive).toBe(true);
    expect(input.ttlSeconds).toBe(0);
    expect(input.auth).toEqual(row.auth);

    expect(res.status).toBe('ok');
    expect(res.verdict).toBe('verified');
    expect(res.applied).toBe(false);
    expect(res.probed).toBe(true);
    expect(res.reachable).toBe(true);
    expect(res.latency_ms).toBe(12);
    expect(res.payload_id).toBe(42);
    expect(res.canonical_digest_before).toBe(row.digest);
    expect(res.canonical_digest).toBe(row.digest);
  });

  it('reports applied when the store promoted refreshed credentials', async () => {
    const row = canonicalRow({ id: 7, engine: 'codex' });
    const svc = makeRunnerProxy(readyRunnerEnv(), {
      runnerValidation: fakeRunnerValidation({ codex: row }),
      authStore: fakeAuthStore({
        state: 'verified',
        digest: 'b'.repeat(64),
        lastRefresh: '2026-05-21T09:00:00Z',
        refreshed: true,
        probe: { reachable: true, definitive: true },
      }),
    });

    const res = await svc.run({}, 'codex');

    expect(res.applied).toBe(true);
    expect(res.canonical_digest_before).toBe(row.digest);
    expect(res.canonical_digest).toBe('b'.repeat(64));
    expect(res.canonical_last_refresh).toBe('2026-05-21T09:00:00Z');
    expect(res.detail).toContain('refreshed credentials promoted');
  });

  it('reports a quarantined payload as failed with the store reason', async () => {
    const svc = makeRunnerProxy(readyRunnerEnv(), {
      runnerValidation: fakeRunnerValidation({ codex: canonicalRow() }),
      authStore: fakeAuthStore({
        state: 'failed',
        reason: 'provider rejected the credential',
        probe: { reachable: true, definitive: true },
      }),
    });

    const res = await svc.run({}, 'codex');

    expect(res.status).toBe('fail');
    expect(res.verdict).toBe('failed');
    expect(res.applied).toBe(false);
    expect(res.reason).toBe('provider rejected the credential');
  });

  it('does not claim unreachable when no live probe ran', async () => {
    const svc = makeRunnerProxy(readyRunnerEnv(), {
      runnerValidation: fakeRunnerValidation({ codex: canonicalRow() }),
      // No `probe`: the store answered from a state that never called out.
      authStore: fakeAuthStore({ state: 'unknown' }),
    });

    const res = await svc.run({}, 'codex');

    expect(res.status).toBe('fail');
    expect(res.verdict).toBe('unknown');
    expect(res.probed).toBe(false);
    expect(res.reachable).toBeUndefined();
    expect(res.latency_ms).toBeUndefined();
  });

  it('never echoes credential material back to the caller', async () => {
    const svc = makeRunnerProxy(readyRunnerEnv(), {
      runnerValidation: fakeRunnerValidation({ codex: canonicalRow() }),
      authStore: fakeAuthStore({ state: 'verified', probe: { reachable: true, definitive: true } }),
    });

    const res = await svc.run({}, 'codex');

    expect(JSON.stringify(res)).not.toContain('sk-test-token');
    expect(res).not.toHaveProperty('auth');
    expect(res).not.toHaveProperty('updated_auth');
  });
});

describe('the manual runner trigger accepts no parameters', () => {
  it.each([
    ['prompt', { prompt: 'hello' }],
    ['model', { model: 'gpt-5.6' }],
    ['reasoning_effort', { reasoning_effort: 'high' }],
    ['preview', { preview: true }],
    ['timeout_seconds', { timeout_seconds: 30 }],
  ])('rejects the retired %s field instead of ignoring it', async (_name, body) => {
    const svc = makeRunnerProxy(readyRunnerEnv());
    await expect(svc.run(body as never, 'codex')).rejects.toBeInstanceOf(ValidationError);
  });

  it('accepts an empty body', async () => {
    const svc = makeRunnerProxy(readyRunnerEnv(), {
      runnerValidation: fakeRunnerValidation({ codex: canonicalRow() }),
    });
    await expect(svc.run({}, 'codex')).resolves.toMatchObject({ status: 'ok' });
  });
});

describe('RunnerProxyService.seedCommand', () => {
  it('issues a token and returns the command', async () => {
    const seedTokens = recordingSeedTokens();
    const svc = makeRunnerProxy(
      readyRunnerEnv({ PUBLIC_BASE_URL: 'https://auth.example.com/' } as Partial<Env>),
      { seedTokens },
    );

    const res = await svc.seedCommand({});

    expect(seedTokens.issued).toHaveLength(1);
    expect(seedTokens.purged).toHaveLength(1);
    const issued = seedTokens.issued[0]!;
    expect(issued.engine).toBe('codex');
    expect(res.command).toBe(
      `curl -fsSL "https://auth.example.com/seed/auth/${issued.token}" | bash`,
    );
    expect(res.expires_at).toBe(issued.expiresAt);
  });

  it('refuses to report success when no public base URL is configured', async () => {
    const seedTokens = recordingSeedTokens();
    const svc = makeRunnerProxy(readyRunnerEnv(), { seedTokens });

    await expect(svc.seedCommand({})).rejects.toThrow(/public base URL/i);
    expect(seedTokens.issued).toEqual([]);
  });
});


describe('Runner login expiry metadata', () => {
  it.each([false, true])('reports expiry independently of runner configuration (%s), then clears after renewal', async (configured) => {
    const now = Date.parse('2026-09-15T12:00:00Z');
    vi.useFakeTimers();
    vi.setSystemTime(now);
    try {
      const row = canonicalRow({ engine: 'claude', auth: { claudeAiOauth: {
        accessToken: 'test-access', refreshToken: 'test-refresh',
        expiresAt: now + 3600000, refreshTokenExpiresAt: now + 3 * 86400000,
      } } });
      const svc = makeRunnerProxy(configured ? readyRunnerEnv() : makeRunnerEnv(), {
        runnerValidation: fakeRunnerValidation({ claude: row }),
        readTelemetry: async () => new Map([['runner_state_claude', 'ok']]),
      });
      let status = await svc.status();
      expect(status.ready).toBe(configured);
      expect(status.engines?.claude.state).toBe('ok');
      expect(status.engines?.claude.login_expiry).toEqual({ state: 'expiring', days_remaining: 3, expires_at: '2026-09-18T12:00:00.000Z' });
      expect(status.engines?.codex.login_expiry?.state).toBe('not_applicable');
      expect(JSON.stringify(status)).not.toContain('test-access');
      expect(JSON.stringify(status)).not.toContain('test-refresh');
      row.auth = { claudeAiOauth: { accessToken: 'renewed', refreshToken: 'renewed-refresh', expiresAt: now + 3600000, refreshTokenExpiresAt: now + 30 * 86400000 } };
      status = await svc.status();
      expect(status.engines?.claude.login_expiry?.state).toBe('ok');
      row.verificationState = 'failed';
      expect((await svc.status()).engines?.claude.login_expiry?.state).toBe('ok');
      vi.setSystemTime(now + 31 * 86400000);
      expect((await svc.status()).engines?.claude.login_expiry?.state).toBe('expired');
    } finally { vi.useRealTimers(); }
  });
});


describe('Renewal seed persistence', () => {
  it.each(['codex', 'claude'] as const)('persists the %s grant before returning its renewal command', async (engine) => {
    const writes: Record<string, unknown>[] = [];
    const cleanup: SQL[] = [];
    const db = {
      delete: (table: unknown) => {
        expect(table).toBe(authSeedTokens);
        return { where: async (condition: SQL) => { cleanup.push(condition); } };
      },
      insert: (table: unknown) => {
        expect(table).toBe(authSeedTokens);
        return { values: async (row: Record<string, unknown>) => { writes.push(row); } };
      },
    } as unknown as Database;
    const svc = makeRunnerProxy(
      readyRunnerEnv({ PUBLIC_BASE_URL: 'https://auth.example.com', AUTH_SEED_TOKEN_TTL_SECONDS: 900 } as Partial<Env>),
      { seedTokens: createSeedTokenStore(db) },
    );
    const result = await svc.seedCommand({ engine });
    expect(writes).toHaveLength(1);
    const stored = writes[0]!;
    expect(stored).toMatchObject({ engine, baseUrl: 'https://auth.example.com', tokenEnc: null, usedAt: null, expiresAt: result.expires_at });
    expect(stored.token).toMatch(/^[a-f0-9]{64}$/);
    expect(Date.parse(stored.expiresAt as string) - Date.parse(stored.createdAt as string)).toBe(900000);
    expect(result.command).toContain(`/seed/auth/${stored.token}`);
    expect(cleanup).toHaveLength(1);
    const query = new MySqlDialect().sqlToQuery(cleanup[0]!);
    expect(query.sql).toBe('`auth_seed_tokens`.`expires_at` < ?');
    expect(query.params).toEqual([stored.createdAt]);
  });

  it('propagates a database failure instead of returning an unusable renewal command', async () => {
    const db = {
      delete: () => ({ where: async () => undefined }),
      insert: () => ({ values: async () => { throw new Error('seed insert failed'); } }),
    } as unknown as Database;
    const svc = makeRunnerProxy(
      readyRunnerEnv({ PUBLIC_BASE_URL: 'https://auth.example.com' } as Partial<Env>),
      { seedTokens: createSeedTokenStore(db) },
    );
    await expect(svc.seedCommand({ engine: 'claude' })).rejects.toThrow('seed insert failed');
  });
});
