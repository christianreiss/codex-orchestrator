import { describe, expect, it } from 'vitest';
import { createRunnerClient } from '../../../src/services/runner-client.js';

const baseEnv = {
  AUTH_RUNNER_URL: '',
  AUTH_RUNNER_SHARED_SECRET: '',
  AUTH_RUNNER_TIMEOUT: 1,
} as unknown as Parameters<typeof createRunnerClient>[0]['env'];

describe('runner-client', () => {
  it('reports unconfigured when AUTH_RUNNER_URL is empty', async () => {
    const c = createRunnerClient({ env: baseEnv });
    expect(c.isConfigured()).toBe(false);
    const res = await c.verify({ authJson: {} });
    expect(res.status).toBe('unconfigured');
    expect(res.ok).toBe(false);
  });

  it('returns reachable+ok=true when runner returns status:ok', async () => {
    const env = { ...baseEnv, AUTH_RUNNER_URL: 'https://runner/verify' };
    const fakeFetch = (async () =>
      new Response(JSON.stringify({ status: 'ok', updated_auth: { last_refresh: 'r' } }), {
        status: 200,
      })) as unknown as typeof fetch;
    const c = createRunnerClient({ env, fetchImpl: fakeFetch });
    const res = await c.verify({ authJson: { a: 1 } });
    expect(res.ok).toBe(true);
    expect(res.status).toBe('ok');
    expect(res.updated_auth).toEqual({ last_refresh: 'r' });
    expect(res.reachable).toBe(true);
  });

  it('returns fail+reachable on non-ok runner response', async () => {
    const env = { ...baseEnv, AUTH_RUNNER_URL: 'https://runner/verify' };
    const fakeFetch = (async () =>
      new Response(JSON.stringify({ status: 'fail', reason: 'bad creds' }), {
        status: 200,
      })) as unknown as typeof fetch;
    const c = createRunnerClient({ env, fetchImpl: fakeFetch });
    const res = await c.verify({ authJson: {} });
    expect(res.ok).toBe(false);
    expect(res.status).toBe('fail');
  });

  it('maps FastAPI HTTPException {detail} envelope to reason', async () => {
    const env = { ...baseEnv, AUTH_RUNNER_URL: 'https://runner/verify' };
    const fakeFetch = (async () =>
      new Response(JSON.stringify({ detail: 'invalid shared secret' }), {
        status: 401,
      })) as unknown as typeof fetch;
    const c = createRunnerClient({ env, fetchImpl: fakeFetch });
    const res = await c.verify({ authJson: {} });
    expect(res.ok).toBe(false);
    expect(res.status).toBe('fail');
    expect(res.reason).toBe('invalid shared secret');
  });

  it('maps FastAPI 422 validation-error {detail: [...]} list to reason', async () => {
    const env = { ...baseEnv, AUTH_RUNNER_URL: 'https://runner/verify' };
    const fakeFetch = (async () =>
      new Response(
        JSON.stringify({
          detail: [{ loc: ['body', 'auth_json'], msg: 'field required', type: 'value_error.missing' }],
        }),
        { status: 422 },
      )) as unknown as typeof fetch;
    const c = createRunnerClient({ env, fetchImpl: fakeFetch });
    const res = await c.verify({ authJson: {} });
    expect(res.ok).toBe(false);
    expect(res.status).toBe('fail');
    expect(res.reason).toBe('field required');
  });

  it('handles non-JSON gracefully', async () => {
    const env = { ...baseEnv, AUTH_RUNNER_URL: 'https://runner/verify' };
    const fakeFetch = (async () => new Response('plain text', { status: 200 })) as unknown as typeof fetch;
    const c = createRunnerClient({ env, fetchImpl: fakeFetch });
    const res = await c.verify({ authJson: {} });
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/invalid runner response/);
  });
});
