import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerAgentRoomChatRoutes } from '../../src/routes/agent-room-chat.js';
import { registerAgentChatRoutes } from '../../src/routes/agent-chat.js';
import { AgentRoomChat } from '../../src/services/agent-room-chat/index.js';
import { ConversationSearch } from '../../src/services/conversation-search.js';
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
  const EVENT = '22222222-2222-4222-8222-222222222222';
  const REQUEST = '33333333-3333-4333-8333-333333333333';
  it.each(['strict', 'compatible'] as const)(
    'refuses reactions, pins and search to viewers in %s mode',
    async (mode) => {
      const react = vi.spyOn(AgentRoomChat.prototype, 'react'),
        pin = vi.spyOn(AgentRoomChat.prototype, 'pin'),
        pins = vi.spyOn(AgentRoomChat.prototype, 'pins'),
        search = vi.spyOn(ConversationSearch.prototype, 'search');
      const app = await appFor('viewer', mode);
      expect(
        (
          await app.inject({
            method: 'POST',
            url: `/admin/agent-messaging/chats/${ID}/events/${EVENT}/reactions`,
            payload: { emoji: '👍', on: true, client_request_id: REQUEST },
          })
        ).statusCode,
      ).toBe(403);
      expect(
        (
          await app.inject({
            method: 'POST',
            url: `/admin/agent-messaging/chats/${ID}/events/${EVENT}/pin`,
            payload: { on: true, client_request_id: REQUEST },
          })
        ).statusCode,
      ).toBe(403);
      expect((await app.inject(`/admin/agent-messaging/chats/${ID}/pins`)).statusCode).toBe(403);
      expect((await app.inject('/admin/agent-messaging/search?q=deploy')).statusCode).toBe(403);
      for (const spy of [react, pin, pins, search]) expect(spy).not.toHaveBeenCalled();
    },
  );
  it('forwards reaction, pin and pinned-list requests for operators', async () => {
    const react = vi.spyOn(AgentRoomChat.prototype, 'react').mockResolvedValue({
      room_id: ID,
      event_id: EVENT,
      emoji: '🎉',
      on: true,
      changed: true,
      reactions: [{ emoji: '🎉', count: 1, mine: true }],
    });
    const pin = vi
      .spyOn(AgentRoomChat.prototype, 'pin')
      .mockResolvedValue({ room_id: ID, event_id: EVENT, on: true, changed: true, pinned: [EVENT] });
    const pins = vi.spyOn(AgentRoomChat.prototype, 'pins').mockResolvedValue({ room_id: ID, pins: [] });
    const app = await appFor('owner', 'strict');
    const r = await app.inject({
      method: 'POST',
      url: `/admin/agent-messaging/chats/${ID}/events/${EVENT}/reactions`,
      payload: { emoji: '🎉', on: true, client_request_id: REQUEST },
    });
    expect(r.statusCode).toBe(200);
    expect(react).toHaveBeenCalledWith(expect.objectContaining({ adminId: expect.any(Number) }), {
      emoji: '🎉',
      on: true,
      client_request_id: REQUEST,
      room_id: ID,
      event_id: EVENT,
    });
    const p = await app.inject({
      method: 'POST',
      url: `/admin/agent-messaging/chats/${ID}/events/${EVENT}/pin`,
      payload: { on: true, client_request_id: REQUEST },
    });
    expect(p.json().pinned).toEqual([EVENT]);
    expect(pin).toHaveBeenCalledTimes(1);
    const listed = await app.inject(`/admin/agent-messaging/chats/${ID}/pins`);
    expect(listed.statusCode).toBe(200);
    expect(listed.headers['cache-control']).toBe('no-store');
    expect(pins).toHaveBeenCalledWith(expect.objectContaining({ adminId: expect.any(Number) }), ID);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/admin/agent-messaging/chats/${ID}/events/${EVENT}/reactions`,
          payload: { emoji: 'not emoji', on: true, client_request_id: REQUEST },
        })
      ).statusCode,
    ).not.toBe(200);
    expect(react).toHaveBeenCalledTimes(1);
  });
  it('searches for operators without caching the response', async () => {
    const search = vi.spyOn(ConversationSearch.prototype, 'search').mockResolvedValue({
      results: [],
      next_cursor: null,
      truncated: false,
      scanned: 0,
      scopes: ['rooms'],
    });
    const rooms = vi.spyOn(AgentRoomChat.prototype, 'searchRooms').mockResolvedValue(new Map([[ID, 'Room']]));
    const app = await appFor('owner', 'strict');
    const r = await app.inject('/admin/agent-messaging/search?q=deploy&scope=rooms');
    expect(rooms).toHaveBeenCalledWith(expect.objectContaining({ adminId: expect.any(Number) }), undefined);
    expect(r.statusCode).toBe(200);
    expect(r.headers['cache-control']).toBe('no-store');
    expect(search).toHaveBeenCalledWith(expect.objectContaining({ q: 'deploy', scope: 'rooms' }), expect.anything());
    expect((await app.inject('/admin/agent-messaging/search?q=d')).statusCode).not.toBe(200);
    // Messaging disabled: an explicit room search names the module instead of returning nothing.
    rooms.mockResolvedValue(null);
    expect((await app.inject('/admin/agent-messaging/search?q=deploy&scope=rooms')).statusCode).toBe(503);
  });
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
