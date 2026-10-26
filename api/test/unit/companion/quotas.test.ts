import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { registerCompanionQuotas } from '../../../src/routes/companion/quotas.js';

describe('companion quota boundary', () => {
  it('refuses unauthorized reads before loading fleet usage', async () => {
    const app = Fastify();
    const read = vi.fn();
    registerCompanionQuotas(app, {
      authorize: async () => {
        throw Object.assign(new Error('Forbidden'), { statusCode: 403 });
      },
      read,
    });
    expect((await app.inject('/companion/v1/quotas')).statusCode).toBe(403);
    expect(read).not.toHaveBeenCalled();
    await app.close();
  });
  it('rechecks authorization before disclosing the snapshot', async () => {
    const app = Fastify();
    const authorize = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(Object.assign(new Error('Forbidden'), { statusCode: 403 }));
    registerCompanionQuotas(app, { authorize, read: async () => ({ engines: [{ engine: 'codex' }] }) });
    const response = await app.inject('/companion/v1/quotas');
    expect(response.statusCode).toBe(403);
    expect(response.body).not.toContain('codex');
    await app.close();
  });
  it('returns all engines after both authorization checks', async () => {
    const app = Fastify();
    const snapshot = { engines: ['codex', 'claude', 'grok'].map((engine) => ({ engine, accounts: [] })) };
    const authorize = vi.fn().mockResolvedValue(undefined);
    registerCompanionQuotas(app, { authorize, read: async () => snapshot });
    expect((await app.inject('/companion/v1/quotas')).json()).toEqual(snapshot);
    expect(authorize).toHaveBeenCalledTimes(2);
    await app.close();
  });
});
