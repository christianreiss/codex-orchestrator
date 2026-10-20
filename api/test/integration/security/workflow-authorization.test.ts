import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { envelopePlugin } from '../../../src/http/plugins/envelope.js';
import { registerCapabilityStack } from '../../helpers/capability-stack.js';

// Exercise the production onRoute guards, including compatibility mode, before
// a mutation handler can run. Workflow access must never inherit legacy grants.
describe.each(['strict', 'compatible'] as const)('workflow authorization in %s mode', (mode) => {
  it.each([
    ['viewer', true, false, false],
    ['user', true, false, false],
    ['trusted_user', true, false, true],
    ['fleet_operator', true, false, true],
    ['admin', true, true, true],
    ['owner', true, true, true],
    [null, false, false, false],
  ] as const)('enforces read/manage/run for %s', async (role, read, manage, run) => {
    const app = Fastify({ logger: false });
    let writes = 0;
    await registerCapabilityStack(app, { role, mode });
    await app.register(envelopePlugin);
    app.get('/admin/workflow-definitions', { preHandler: app.requireAdmin }, async () => ({ items: [] }));
    app.post('/admin/workflow-definitions', { preHandler: app.requireAdmin }, async () => {
      writes++;
      return { created: true };
    });
    app.post('/admin/workflow-runs', { preHandler: app.requireAdmin }, async () => {
      writes++;
      return { created: true };
    });
    try {
      for (const [method, url, allowed] of [
        ['GET', '/admin/workflow-definitions', read],
        ['POST', '/admin/workflow-definitions', manage],
        ['POST', '/admin/workflow-runs', run],
      ] as const) {
        const response = await app.inject({ method, url });
        expect(response.statusCode).toBe(allowed ? 200 : role === null ? 401 : 403);
      }
      expect(writes).toBe(Number(manage) + Number(run));
    } finally {
      await app.close();
    }
  });
});
