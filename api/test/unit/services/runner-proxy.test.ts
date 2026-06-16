import { describe, it, expect } from 'vitest';
import { RunnerProxyService } from '../../../src/services/runner-proxy.js';
import type { Env } from '../../../src/env.js';
import type { RunnerClient } from '../../../src/services/runner-client.js';
import type { RunnerValidationService } from '../../../src/services/runner-validation.js';

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    AUTH_RUNNER_URL: undefined,
    AUTH_RUNNER_SHARED_SECRET: undefined,
    ...(overrides as object),
  } as Env;
}

describe('RunnerProxyService', () => {
  it('reports unconfigured when AUTH_RUNNER_URL is missing', async () => {
    const svc = new RunnerProxyService(makeEnv());
    const s = await svc.status();
    expect(s.configured).toBe(false);
    expect(s.ready).toBe(false);
  });

  it('reports not-ready when secret is missing', async () => {
    const svc = new RunnerProxyService(
      makeEnv({ AUTH_RUNNER_URL: 'https://runner.example.com' } as Partial<Env>),
    );
    const s = await svc.status();
    expect(s.configured).toBe(true);
    expect(s.ready).toBe(false);
  });

  it('reports ready when both env vars are set', async () => {
    const svc = new RunnerProxyService(
      makeEnv({
        AUTH_RUNNER_URL: 'https://runner.example.com',
        AUTH_RUNNER_SHARED_SECRET: 'secret',
      } as Partial<Env>),
    );
    const s = await svc.status();
    expect(s.configured).toBe(true);
    expect(s.ready).toBe(true);
  });

  it('hydrates status from persisted runner telemetry', async () => {
    const svc = new RunnerProxyService(
      makeEnv({
        AUTH_RUNNER_URL: 'https://runner.example.com/verify',
        AUTH_RUNNER_SHARED_SECRET: 'secret',
      } as Partial<Env>),
      undefined,
      {
        versionReader: async () =>
          new Map([
            ['runner_state', 'ok'],
            ['runner_last_check', '2026-05-20T10:09:50Z'],
            ['runner_last_ok', '2026-05-20T10:09:50Z'],
            ['runner_state_claude', 'ok'],
            ['runner_last_check_claude', '2026-05-20T10:09:49Z'],
            ['runner_last_ok_claude', '2026-05-20T10:09:49Z'],
          ]),
      },
    );

    const s = await svc.status();
    expect(s.ready).toBe(true);
    expect(s.state).toBe('ok');
    expect(s.last_run).toBe('2026-05-20T10:09:50Z');
    expect(s.last_result).toMatchObject({
      codex: { state: 'ok', last_check: '2026-05-20T10:09:50Z' },
      claude: { state: 'ok', last_check: '2026-05-20T10:09:49Z' },
    });
  });

  it('returns unconfigured on run() when AUTH_RUNNER_URL is missing', async () => {
    const svc = new RunnerProxyService(makeEnv());
    const res = await svc.run({ prompt: 'hi' }, 'codex');
    expect(res.status).toBe('unconfigured');
    expect(res.reachable).toBe(false);
  });

  it('verifies Claude with the latest canonical auth payload', async () => {
    let seenAuth: Record<string, unknown> | null = null;
    const runner = {
      isConfigured: () => true,
      verify: async () => {
        throw new Error('unexpected codex verify');
      },
      verifyClaude: async (input) => {
        seenAuth = input.authJson;
        return { ok: true, status: 'ok', reachable: true, latency_ms: 12, claude_version: '1.2.3' };
      },
    } satisfies RunnerClient;
    const runnerValidation = {
      resolveCanonicalPayload: async () => ({
        id: 42,
        lastRefresh: '2026-05-20T10:00:00Z',
        sha256: 'a'.repeat(64),
        body: '{}',
        engine: 'claude',
        createdAt: '2026-05-20T10:00:00Z',
        verificationState: 'verified',
        verificationCheckedAt: '2026-05-20T10:00:00Z',
      }),
      validateCanonicalPayload: () => ({
        auth: { auths: { 'api.anthropic.com': { token: 'sk-ant-test' } } },
        digest: 'a'.repeat(64),
        last_refresh: '2026-05-20T10:00:00Z',
      }),
      canonicalAuthFromPayload: () => null,
      ensureAuthsFallback: (payload) => payload,
      normalizeAuthEntries: () => [],
      canonicalizeAuthPayload: (payload) => payload,
      calculateDigest: () => 'a'.repeat(64),
    } satisfies RunnerValidationService;

    const svc = new RunnerProxyService(
      makeEnv({
        AUTH_RUNNER_URL: 'https://runner.example.com/verify',
        AUTH_RUNNER_SHARED_SECRET: 'secret',
      } as Partial<Env>),
      undefined,
      { runner, runnerValidation },
    );

    const res = await svc.run({}, 'claude');
    expect(res.status).toBe('ok');
    expect(res.canonical_digest).toBe('a'.repeat(64));
    expect(res.payload_id).toBe(42);
    expect(seenAuth).toEqual({ auths: { 'api.anthropic.com': { token: 'sk-ant-test' } } });
  });

  it('returns queued=true from seedCommand stub', async () => {
    const svc = new RunnerProxyService(makeEnv());
    expect(await svc.seedCommand({})).toEqual({ status: 'ok', queued: true });
  });
});
