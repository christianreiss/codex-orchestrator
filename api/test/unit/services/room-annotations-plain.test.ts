import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import * as schema from '../../../src/db/schema.js';
import type { Database } from '../../../src/db/client.js';
import type { AgentMessagingService } from '../../../src/services/agent-messaging.js';
import { AgentRoomChat } from '../../../src/services/agent-room-chat/index.js';
import { MAX_ROOM_PINS } from '../../../src/services/agent-room-chat/annotations.js';
import { encrypt } from '../../../src/security/secret-box.js';
import { wsPublisher } from '../../../src/ws/publisher.js';
import { createDbFake } from '../../helpers/db-fake.js';
import { loadTestEnv, testKeyring } from '../../helpers/test-keyring.js';

/** Plain-database storage mode: one coordination transaction per call, change rows in it. */
function setup(conferenceStatus?: string) {
  const keyring = testKeyring(),
    roomId = randomUUID(),
    eventId = randomUUID(),
    now = new Date().toISOString();
  const event = {
    id: eventId,
    roomId,
    actor: 'agent:x',
    requestId: randomUUID(),
    payloadHash: 'h',
    bodyEnc: encrypt(JSON.stringify({ name: 'Builder', content: 'Build is green', attachments: [], kind: 'chat' }), keyring),
    createdAt: now,
  };
  const room = conferenceStatus
    ? [
        schema.agentBusConferences,
        [
          {
            id: roomId,
            ownerAddressId: 'server',
            ownerAdminId: 7,
            topic: 'Conference',
            purpose: '',
            status: conferenceStatus,
            deadlineAt: '2099-01-01T00:00:00.000Z',
            createdAt: now,
            updatedAt: now,
          },
        ],
      ]
    : [
        schema.agentBusGroups,
        [{ id: roomId, slug: 'annotated', title: 'Annotated', description: '', createdByAddressId: 'server', createdAt: now, updatedAt: now }],
      ];
  const fake = createDbFake(new Map<unknown, Record<string, unknown>[]>([room as [unknown, Record<string, unknown>[]], [schema.agentRoomEvents, [event]]]));
  const bus = {
    isEnabled: async () => true,
    coordinationTransaction: vi.fn(async (_s: unknown, _t: unknown, fn: (tx: unknown, session: null) => unknown) => fn(fake, null)),
  } as unknown as AgentMessagingService;
  const service = new AgentRoomChat(fake as unknown as Database, loadTestEnv(), keyring, bus);
  return { fake, service, roomId, eventId, bus };
}
const operator = { adminId: 7, name: 'Operator' };

describe('room reactions and pins (plain storage)', () => {
  it('writes the reaction and its change row in the room transaction and shows it on reads and deltas', async () => {
    const h = setup();
    const publish = vi.spyOn(wsPublisher, 'publish');
    const body = { room_id: h.roomId, event_id: h.eventId, emoji: '🚀', on: true, client_request_id: randomUUID() };
    expect(await h.service.react(operator, body)).toMatchObject({
      changed: true,
      reactions: [{ emoji: '🚀', count: 1, mine: true }],
    });
    expect(h.bus.coordinationTransaction).toHaveBeenCalled();
    expect(h.fake.inserts.find((i) => i.table === schema.agentRoomChanges)?.values).toMatchObject({
      roomId: h.roomId,
      kind: 'reaction',
      refId: h.eventId,
    });
    expect(publish).toHaveBeenCalledWith('agent_room_chat.changed', { room_id: h.roomId });
    publish.mockClear();
    expect((await h.service.react(operator, body)).changed).toBe(false);
    expect(publish).not.toHaveBeenCalled();
    const read = await h.service.read(operator, { room_id: h.roomId });
    expect(read.events[0]?.reactions).toEqual([{ emoji: '🚀', count: 1, mine: true }]);
    const delta = await h.service.readDelta(operator, { room_id: h.roomId, after: 0 });
    expect(delta.resync).toBe(false);
    if (!delta.resync) {
      expect(delta.events.map((e) => e.id)).toEqual([h.eventId]);
      expect(delta.events[0]?.reactions).toEqual([{ emoji: '🚀', count: 1, mine: true }]);
      expect(delta.changes.map((c) => c.kind)).toEqual(['reaction']);
      expect(delta.pinned).toEqual([]);
    }
    publish.mockRestore();
  });
  it('pins with an operation receipt, enforces the room limit and lists snippets', async () => {
    const h = setup();
    const pin = { room_id: h.roomId, event_id: h.eventId, on: true, client_request_id: randomUUID() };
    expect(await h.service.pin(operator, pin)).toMatchObject({ changed: true, pinned: [h.eventId] });
    expect(h.fake.inserts.filter((i) => i.table === schema.agentRoomOperations)).toHaveLength(1);
    expect(h.fake.inserts.find((i) => i.table === schema.agentRoomChanges)?.values).toMatchObject({ kind: 'pin', refId: h.eventId });
    expect((await h.service.read(operator, { room_id: h.roomId })).pinned).toEqual([h.eventId]);
    const listed = await h.service.pins(operator, h.roomId);
    expect(listed.pins[0]).toMatchObject({ event_id: h.eventId, pinned_by: 'admin:7', event: { snippet: 'Build is green', name: 'Builder' } });
    h.fake.tables.set(
      schema.agentRoomPins,
      Array.from({ length: MAX_ROOM_PINS }, () => ({ roomId: h.roomId, eventId: randomUUID(), pinnedBy: 'admin:7', pinnedAt: new Date().toISOString() })),
    );
    await expect(h.service.pin(operator, { ...pin, client_request_id: randomUUID() })).rejects.toMatchObject({
      status: 409,
      code: 'room_pin_limit',
    });
  });
  it('refuses closed rooms, foreign events and non-operators', async () => {
    const closed = setup('adjourned');
    const body = { room_id: closed.roomId, event_id: closed.eventId, emoji: '👍', on: true, client_request_id: randomUUID() };
    await expect(closed.service.react(operator, body)).rejects.toMatchObject({ status: 409 });
    await expect(
      closed.service.pin(operator, { room_id: closed.roomId, event_id: closed.eventId, on: true, client_request_id: randomUUID() }),
    ).rejects.toMatchObject({ status: 409 });
    const open = setup();
    await expect(
      open.service.react(operator, { ...body, room_id: open.roomId, event_id: randomUUID() }),
    ).rejects.toMatchObject({ status: 404, code: 'room_event_not_found' });
    await expect(open.service.react({ name: 'nobody' }, { ...body, room_id: open.roomId })).rejects.toMatchObject({ status: 403 });
    await expect(open.service.react(operator, { ...body, emoji: 'nope' })).rejects.toThrow();
    expect(open.fake.inserts.filter((i) => i.table === schema.agentRoomReactions)).toHaveLength(0);
  });
  it('lists every room for operator search, and nothing while messaging is disabled', async () => {
    const h = setup();
    expect([...(await h.service.searchRooms(operator))!.entries()]).toEqual([[h.roomId, 'Annotated']]);
    expect([...(await h.service.searchRooms(operator, h.roomId))!.keys()]).toEqual([h.roomId]);
    (h.bus as unknown as { isEnabled: () => Promise<boolean> }).isEnabled = async () => false;
    expect(await h.service.searchRooms(operator)).toBeNull();
  });
});
