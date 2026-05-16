import { describe, it, expect } from 'vitest';
import { RunnerProxyService } from '../../../src/services/runner-proxy.js';
import { ServiceUnavailableError } from '../../../src/http/errors.js';
import type { Env } from '../../../src/env.js';

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    AUTH_RUNNER_URL: undefined,
    AUTH_RUNNER_SHARED_SECRET: undefined,
    ...(overrides as object),
  } as Env;
}

describe('RunnerProxyService', () => {
  it('reports unconfigured when AUTH_RUNNER_URL is missing', () => {
    const svc = new RunnerProxyService(makeEnv());
    const s = svc.status();
    expect(s.configured).toBe(false);
    expect(s.ready).toBe(false);
  });

  it('reports not-ready when secret is missing', () => {
    const svc = new RunnerProxyService(
      makeEnv({ AUTH_RUNNER_URL: 'https://runner.example.com' } as Partial<Env>),
    );
    const s = svc.status();
    expect(s.configured).toBe(true);
    expect(s.ready).toBe(false);
  });

  it('reports ready when both env vars are set', () => {
    const svc = new RunnerProxyService(
      makeEnv({
        AUTH_RUNNER_URL: 'https://runner.example.com',
        AUTH_RUNNER_SHARED_SECRET: 'secret',
      } as Partial<Env>),
    );
    const s = svc.status();
    expect(s.configured).toBe(true);
    expect(s.ready).toBe(true);
  });

  it('throws ServiceUnavailableError on run()', async () => {
    const svc = new RunnerProxyService(makeEnv());
    await expect(svc.run({ prompt: 'hi' }, 'codex')).rejects.toBeInstanceOf(ServiceUnavailableError);
  });

  it('returns queued=true from seedCommand stub', async () => {
    const svc = new RunnerProxyService(makeEnv());
    expect(await svc.seedCommand({})).toEqual({ status: 'ok', queued: true });
  });
});
