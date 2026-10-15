import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerCapabilityStack } from '../../helpers/capability-stack.js';
import { registerAdminAgentSessionsRoutes } from '../../../src/routes/admin/agent-sessions/index.js';
const calls = vi.hoisted(() => ({ request: vi.fn(async () => ({ status: 'requested' })), get: vi.fn(async () => ({ status: 'exited' })) }));
vi.mock('../../../src/services/native-stop.js', () => ({ NativeStopService: class { request = calls.request; get = calls.get; } }));
vi.mock('../../../src/services/agent-portal.js', () => ({ createAgentPortalService: () => ({ isEnabled: async () => true }) }));
vi.mock('../../../src/services/admin-events.js', () => ({ AdminEventsService: class { record = async () => {}; } }));
const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())); vi.clearAllMocks(); });
const id = '11111111-1111-4111-8111-111111111111';
const body = { client_message_id: id, expect: { instance_id: id, binding_generation: 3 } };
async function build(role: string | null) {
 const app = Fastify(); apps.push(app);
 await registerCapabilityStack(app, { role, userId: 7 });
 await registerAdminAgentSessionsRoutes(app, { db: {} as never, env: {} as never, keyring: {} as never });
 return app;
}
describe('native process stop authorization', () => {
 for (const role of [null, 'viewer']) it(`refuses ${role ?? 'anonymous'} before dispatch`, async () => {
  const app = await build(role);
  const res = await app.inject({ method: 'POST', url: `/admin/agent-sessions/${id}/stop`, payload: body });
  expect([401,403]).toContain(res.statusCode); expect(calls.request).not.toHaveBeenCalled();
 });
 it('dispatches an exact expected binding with the authenticated actor', async () => {
  const app = await build('owner');
  const res = await app.inject({ method: 'POST', url: `/admin/agent-sessions/${id}/stop`, payload: body });
  expect(res.statusCode).toBe(200);
  expect(calls.request).toHaveBeenCalledWith(id, id, body.expect, 7);
 });
 it('never dispatches an incomplete process identity', async () => {
  const app = await build('owner');
  await app.inject({ method: 'POST', url: `/admin/agent-sessions/${id}/stop`, payload: { client_message_id: id } });
  expect(calls.request).not.toHaveBeenCalled();
 });
});
