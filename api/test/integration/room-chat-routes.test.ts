import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerAgentRoomChatRoutes } from '../../src/routes/agent-room-chat.js';
import { registerAgentChatRoutes } from '../../src/routes/agent-chat.js';
import { AgentRoomChat } from '../../src/services/agent-room-chat/index.js';
import { createDbFake } from '../helpers/db-fake.js';
import { registerCapabilityStack } from '../helpers/capability-stack.js';
import { loadTestEnv, testKeyring } from '../helpers/test-keyring.js';
import type { RouteContext } from '../../src/routes/index.js';
const apps: ReturnType<typeof Fastify>[] = [];
const ID = '11111111-1111-4111-8111-111111111111';
async function appFor(role: string | null, mode: 'strict' | 'compatible') {
  const app = Fastify();
  apps.push(app);
  await registerCapabilityStack(app, { role, mode });
  const ctx = { db: createDbFake(), env: loadTestEnv(), keyring: testKeyring() } as unknown as RouteContext;
  registerAgentRoomChatRoutes(app, ctx);
  await registerAgentChatRoutes(app, ctx);
  return app;
}
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(apps.splice(0).map((a) => a.close()));
});
describe('shared room HTTP access', () => {
  it('forwards History pagination to the shared directory', async () => {
    const list = vi
      .spyOn(AgentRoomChat.prototype, 'list')
      .mockResolvedValue({ enabled: true, rooms: [], has_more: false, next_offset: null });
    const app = await appFor('owner', 'strict');
    expect((await app.inject('/admin/agent-messaging/chats?view=history&offset=50')).statusCode).toBe(200);
    expect(list).toHaveBeenCalledWith(
      expect.objectContaining({ adminId: expect.any(Number) }),
      50,
      'history',
    );
  });
  it.each(['strict', 'compatible'] as const)(
    'refuses private content and mutations to viewers in %s mode',
    async (mode) => {
      const read = vi.spyOn(AgentRoomChat.prototype, 'read'),
        send = vi.spyOn(AgentRoomChat.prototype, 'send');
      const app = await appFor('viewer', mode);
      for (const op of ['read', 'seen', 'send', 'create', 'manage'])
        expect(
          (
            await app.inject({
              method: 'POST',
              url: `/admin/agent-messaging/chats/${op}`,
              payload: { room_id: ID },
            })
          ).statusCode,
        ).toBe(403);
      for (const suffix of ['', '/content'])
        expect(
          (await app.inject(`/admin/agent-messaging/chats/${ID}/attachments/${ID}${suffix}`)).statusCode,
        ).toBe(403);
      expect(read).not.toHaveBeenCalled();
      expect(send).not.toHaveBeenCalled();
    },
  );
  it('requires login and validates bridge credentials', async () => {
    const app = await appFor(null, 'strict');
    expect((await app.inject('/admin/agent-messaging/chats')).statusCode).toBe(401);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/host/agent-sessions/${ID}/agent-messaging/chats/read`,
          payload: { room_id: ID },
        })
      ).statusCode,
    ).toBe(401);
  });
  it('audits operator reads without storing plaintext in audit data', async () => {
    const read = vi
      .spyOn(AgentRoomChat.prototype, 'read')
      .mockResolvedValue({ room: { id: ID } as never, events: [], next_before: null, next_after: 0 });
    const app = await appFor('owner', 'strict');
    const r = await app.inject({
      method: 'POST',
      url: '/admin/agent-messaging/chats/read',
      payload: { room_id: ID },
    });
    expect(r.statusCode).toBe(200);
    expect(r.headers['cache-control']).toBe('no-store');
    expect(read).toHaveBeenCalledWith(expect.objectContaining({ adminId: expect.any(Number) }), {
      room_id: ID,
    });
  });
});
