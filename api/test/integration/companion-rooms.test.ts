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
  it('keeps History pagination on the paired room directory', async () => {
    const app = await fixture('owner');
    const list = vi
      .spyOn(AgentRoomChat.prototype, 'list')
      .mockResolvedValue({ enabled: true, rooms: [], has_more: false, next_offset: null });
    expect(
      (
        await app.inject({
          url: '/companion/v1/rooms?view=history&offset=50',
          headers: { authorization: 'Bearer device' },
        })
      ).statusCode,
    ).toBe(200);
    expect(list).toHaveBeenCalledWith({ adminId: 7, name: 'Operator', deviceId: ID }, 50, 'history');
  });
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
      .mockResolvedValue({ room: { id: ID } as never, events: [], next_before: 'opaque-history-cursor', next_after: 0 });
    const response = await app.inject({
      method: 'POST',
      url: '/companion/v1/rooms/read',
      headers: { authorization: 'Bearer device' },
      payload: { room_id: ID, before: 'opaque-history-cursor' },
    });
    expect(response.statusCode).toBe(200);
    expect(read).toHaveBeenCalledWith(
      { adminId: 7, name: 'Operator', deviceId: ID },
      { room_id: ID, before: 'opaque-history-cursor' },
    );
    expect(response.json().next_before).toBe('opaque-history-cursor');
  });
  it('routes delta reads by cursor and lists changed rooms', async () => {
    const app = await fixture('owner');
    const delta = vi.spyOn(AgentRoomChat.prototype, 'readDelta').mockResolvedValue({
      room_id: ID,
      resync: true,
      next_after: 9,
      has_more: false,
    });
    const full = vi.spyOn(AgentRoomChat.prototype, 'read');
    const response = await app.inject({
      method: 'POST',
      url: '/companion/v1/rooms/read',
      headers: { authorization: 'Bearer device' },
      payload: { room_id: ID, after: 3 },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ resync: true, next_after: 9 });
    expect(delta).toHaveBeenCalledWith({ adminId: 7, name: 'Operator', deviceId: ID }, { room_id: ID, after: 3 });
    expect(full).not.toHaveBeenCalled();
    const changes = vi
      .spyOn(AgentRoomChat.prototype, 'changes')
      .mockResolvedValue({ enabled: true, rooms: [{ room_id: ID, seq: 12 }], next_after: 12, resync: false, has_more: false });
    const listed = await app.inject({ url: '/companion/v1/rooms/changes?after=4', headers: { authorization: 'Bearer device' } });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().rooms).toEqual([{ room_id: ID, seq: 12 }]);
    expect(changes).toHaveBeenCalledWith({ adminId: 7, name: 'Operator', deviceId: ID }, 4);
  });
  it('reads and stores the per-device room notification mode for a visible room', async () => {
    const app = await fixture('owner');
    const access = vi.spyOn(AgentRoomChat.prototype, 'access').mockResolvedValue({} as never);
    vi.spyOn(CompanionDevices.prototype, 'roomPreference').mockResolvedValue('default');
    const store = vi.spyOn(CompanionDevices.prototype, 'setRoomPreference').mockImplementation(async (_d, _r, mode) => mode);
    const url = `/companion/v1/rooms/${ID}/notifications`;
    const headers = { authorization: 'Bearer device' };
    expect((await app.inject({ url, headers })).json()).toEqual({ room_id: ID, mode: 'default' });
    const put = await app.inject({ method: 'PUT', url, headers, payload: { mode: 'follow' } });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toEqual({ room_id: ID, mode: 'follow' });
    expect(store).toHaveBeenCalledWith(ID, ID, 'follow');
    expect(access).toHaveBeenCalledWith({ adminId: 7, name: 'Operator', deviceId: ID }, ID);
    // Schema rejection (400 behind the production envelope plugin, which this fixture omits).
    expect((await app.inject({ method: 'PUT', url, headers, payload: { mode: 'loud' } })).statusCode).not.toBe(200);
    access.mockRejectedValue(new ForbiddenError('Room membership required'));
    expect((await app.inject({ method: 'PUT', url, headers, payload: { mode: 'mute' } })).statusCode).toBe(403);
    expect(store).toHaveBeenCalledTimes(1);
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
