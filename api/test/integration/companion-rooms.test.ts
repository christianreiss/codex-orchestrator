import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerCompanionRooms } from '../../src/routes/companion/rooms.js';
import { registerAgentChatRoutes } from '../../src/routes/agent-chat.js';
import { CompanionDevices } from '../../src/services/companion/devices.js';
import { AgentRoomChat } from '../../src/services/agent-room-chat/index.js';
import { ForbiddenError, UnauthorizedError } from '../../src/http/errors.js';
import { roleHasCapability } from '../../src/security/capabilities.js';
import { createDbFake } from '../helpers/db-fake.js';
import { registerCapabilityStack } from '../helpers/capability-stack.js';
import { loadTestEnv, testKeyring } from '../helpers/test-keyring.js';
import type { RouteContext } from '../../src/routes/index.js';
const ID = '11111111-1111-4111-8111-111111111111';
const apps: ReturnType<typeof Fastify>[] = [];
async function fixture(role: 'owner' | 'viewer') {
  const app = Fastify();
  apps.push(app);
  await registerCapabilityStack(app, { role: null });
  vi.spyOn(CompanionDevices.prototype, 'authenticate').mockImplementation(async (token, capability) => {
    if (token !== 'Bearer device') throw new UnauthorizedError('Device required');
    if (capability && !roleHasCapability(role, capability)) throw new ForbiddenError('Capability required');
    return { user: { id: 7, name: 'Operator' }, device: { id: ID } } as never;
  });
  const ctx = { db: createDbFake(), env: loadTestEnv(), keyring: testKeyring() } as unknown as RouteContext;
  registerCompanionRooms(app, ctx);
  await registerAgentChatRoutes(app, ctx);
  return app;
}
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  vi.restoreAllMocks();
});
describe('Companion shared rooms', () => {
  it('does not accept admin cookies in place of a device credential', async () => {
    const app = await fixture('owner');
    expect((await app.inject('/companion/v1/rooms')).statusCode).toBe(401);
  });
  it('requires explicit private-content and mutation capabilities', async () => {
    const app = await fixture('viewer');
    const read = vi.spyOn(AgentRoomChat.prototype, 'read');
    for (const operation of ['read', 'seen', 'send', 'create', 'manage']) {
      const response = await app.inject({
        method: 'POST',
        url: `/companion/v1/rooms/${operation}`,
        headers: { authorization: 'Bearer device' },
        payload: { room_id: ID },
      });
      expect(response.statusCode).toBe(403);
    }
    for (const suffix of ['', '/content'])
      expect(
        (
          await app.inject({
            url: `/companion/v1/rooms/${ID}/attachments/${ID}${suffix}`,
            headers: { authorization: 'Bearer device' },
          })
        ).statusCode,
      ).toBe(403);
    expect(read).not.toHaveBeenCalled();
  });
  it('uses the paired operator identity and preserves room pagination', async () => {
    const app = await fixture('owner');
    const read = vi
      .spyOn(AgentRoomChat.prototype, 'read')
      .mockResolvedValue({ room: { id: ID } as never, events: [], next_before: 'opaque-history-cursor' });
    const response = await app.inject({
      method: 'POST',
      url: '/companion/v1/rooms/read',
      headers: { authorization: 'Bearer device' },
      payload: { room_id: ID, before: 'opaque-history-cursor' },
    });
    expect(response.statusCode).toBe(200);
    expect(read).toHaveBeenCalledWith(
      { adminId: 7, name: 'Operator' },
      { room_id: ID, before: 'opaque-history-cursor' },
    );
    expect(response.json().next_before).toBe('opaque-history-cursor');
  });
  it('rejects browser origins before accessing a room attachment', async () => {
    const app = await fixture('owner');
    const access = vi.spyOn(AgentRoomChat.prototype, 'access');
    expect(
      (
        await app.inject({
          url: `/companion/v1/rooms/${ID}/attachments/${ID}`,
          headers: { authorization: 'Bearer device', origin: 'https://example.test' },
        })
      ).statusCode,
    ).toBe(403);
    expect(access).not.toHaveBeenCalled();
  });
});
