import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  agentBusConferences,
  agentBusMessages,
  agentRoomDeliveries,
  agentRoomEvents,
  agentSessions,
  hosts,
} from '../../src/db/schema.js';
import { runMigrations } from '../../src/db/migrator.js';
import { AgentMessagingService } from '../../src/services/agent-messaging.js';
import { AgentRoomChat } from '../../src/services/agent-room-chat/index.js';
import { encrypt } from '../../src/security/secret-box.js';
import { getTestDb } from '../helpers/test-db.js';
import { loadTestEnv, testKeyring } from '../helpers/test-keyring.js';
import { markPersistentHost, persistRelayUsers } from '../helpers/persistent-host.js';
const handle = await getTestDb();
describe.skipIf(!handle)('shared room chats with MySQL', { timeout: 120000 }, () => {
  let bus: AgentMessagingService, service: AgentRoomChat, root: string, host: typeof hosts.$inferSelect;
  const admin = { adminId: 987654, name: 'Room operator' };
  const rooms: string[] = [];
  const db = handle?.db as NonNullable<typeof handle>['db'];
  const members: { sessionId: string; token: string; addressId: string }[] = [];
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'room-chat-test-'));
    await runMigrations(handle!.pool);
    const now = new Date().toISOString();
    await db.execute(
      sql`INSERT INTO hosts (fqdn,api_key,status,secure,engines,agent_messaging_enabled,created_at,updated_at) VALUES ('ztest-room-chat.example',${'9'.repeat(64)},'active',1,'codex,claude,grok',1,${now},${now})`,
    );
    host = (await db.select().from(hosts).where(eq(hosts.fqdn, 'ztest-room-chat.example')))[0]!;
    await markPersistentHost(db, host.id);
    const env = { ...loadTestEnv(), DATA_ROOT: root };
    bus = persistRelayUsers(db, new AgentMessagingService(db, env, testKeyring()));
    await bus.setEnabled(true);
    service = new AgentRoomChat(db, env, testKeyring(), bus);
    for (const engine of ['codex', 'claude', 'grok'] as const) {
      const sessionId = randomUUID(),
        token = randomBytes(32).toString('base64url');
      const out = await bus.registerSession(host, {
        engine,
        username: `room-${engine}`,
        cwd: `/tmp/room-${engine}`,
        invocationKind: 'interactive',
        sessionId,
        bridgeToken: token,
        adapterProtocol: 'test-live-v1',
        adapterCapabilities: { test: true, execution_contract_version: 2, shared_room_chat_version: 1 },
      });
      members.push({ sessionId, token, addressId: String((out.address as { id: string }).id) });
    }
  });
  afterAll(async () => {
    if (rooms.length) {
      await db.execute(
        sql`DELETE FROM agent_room_deliveries WHERE event_id IN (SELECT id FROM agent_room_events WHERE room_id IN (${sql.join(
          rooms.map((id) => sql`${id}`),
          sql`, `,
        )}))`,
      );
      await db.delete(agentRoomEvents).where(inArray(agentRoomEvents.roomId, rooms));
      for (const id of rooms) {
        await db.execute(
          sql`DELETE FROM agent_bus_subscriptions WHERE topic IN (SELECT CONCAT('group:',slug) FROM agent_bus_groups WHERE id=${id})`,
        );
        await db.execute(sql`DELETE FROM agent_bus_groups WHERE id=${id}`);
        await db.execute(sql`DELETE FROM agent_bus_conference_members WHERE conference_id=${id}`);
        await db.delete(agentBusConferences).where(eq(agentBusConferences.id, id));
        await db.execute(sql`DELETE FROM agent_room_reads WHERE room_id=${id}`);
        await db.execute(sql`DELETE FROM agent_chat_attachments WHERE session_id=${id}`);
      }
    }
    await db.execute(sql`DELETE FROM agent_room_operations WHERE actor=${`admin:${admin.adminId}`}`);
    if (host) {
      const ids = members.map((m) => m.addressId);
      if (ids.length) {
        await db.execute(
          sql`DELETE FROM agent_bus_messages WHERE target_address_id IN (${sql.join(
            ids.map((id) => sql`${id}`),
            sql`, `,
          )})`,
        );
        await db.execute(
          sql`DELETE FROM agent_bus_conversations WHERE address_b_id IN (${sql.join(
            ids.map((id) => sql`${id}`),
            sql`, `,
          )})`,
        );
      }
      await db.execute(sql`DELETE FROM agent_sessions WHERE host_id=${host.id}`);
      await db.execute(sql`DELETE FROM agent_bus_addresses WHERE host_id=${host.id}`);
      await db.execute(sql`DELETE FROM hosts WHERE id=${host.id}`);
    }
    if (root) await rm(root, { recursive: true, force: true });
    await handle?.pool.end();
  });
  async function create(kind: 'group' | 'conference' = 'group') {
    const out = await service.create(admin, {
      client_request_id: randomUUID(),
      kind,
      title: 'Shared test',
      members: members.slice(0, 2).map((m) => m.addressId),
    });
    rooms.push(String(out.room_id));
    return String(out.room_id);
  }
  const actor = (i: number) => ({ sessionId: members[i]!.sessionId, token: members[i]!.token });
  it('creates once and rejects changed retries', async () => {
    const input = {
      client_request_id: randomUUID(),
      kind: 'group',
      title: 'Idempotent group',
      members: [members[0]!.addressId],
    };
    const a = await service.create(admin, input);
    rooms.push(String(a.room_id));
    expect(await service.create(admin, input)).toEqual(a);
    await expect(service.create(admin, { ...input, title: 'Different' })).rejects.toThrow('retry differs');
  });
  it('keeps shared contributions passive; requests only named answers and never fans out replies', async () => {
    const id = await create();
    const before = await db.select().from(agentBusMessages);
    const event = await service.send(admin, {
      room_id: id,
      client_request_id: randomUUID(),
      content: 'Shared note',
    });
    expect((await db.select().from(agentBusMessages)).length).toBe(before.length);
    const request = {
      room_id: id,
      client_request_id: randomUUID(),
      content: 'Please review',
      recipients: [members[0]!.addressId],
    };
    const [first, retry] = await Promise.all([service.send(admin, request), service.send(admin, request)]);
    expect(first.id).toBe(retry.id);
    const deliveries = await db
      .select()
      .from(agentRoomDeliveries)
      .where(eq(agentRoomDeliveries.eventId, first.id));
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]!.messageId).toBeTruthy();
    expect((await service.read(actor(1), { room_id: id })).events.map((e) => e.id)).toContain(first.id);
    await service.send(actor(0), {
      room_id: id,
      client_request_id: randomUUID(),
      content: 'Reviewed',
      reply_to: first.id,
    });
    expect((await db.select().from(agentBusMessages)).length).toBe(before.length + 1);
    await expect(
      service.send(actor(0), {
        room_id: id,
        client_request_id: randomUUID(),
        content: 'loop',
        ask_all: true,
      }),
    ).rejects.toThrow('Only an operator');
    await expect(service.read(actor(2), { room_id: id })).rejects.toThrow('membership');
    await service.manage(admin, {
      room_id: id,
      client_request_id: randomUUID(),
      action: 'remove',
      address_id: members[1]!.addressId,
    });
    await expect(service.read(actor(1), { room_id: id })).rejects.toThrow('membership');
    const other = await create();
    await expect(
      service.send(admin, {
        room_id: other,
        client_request_id: randomUUID(),
        content: 'Wrong room',
        reply_to: event.id,
      }),
    ).rejects.toThrow('Reply target');
  });
  it('binds files to their room and author; unpublished files are private', async () => {
    const id = await create(),
      other = await create(),
      fileId = randomUUID(),
      owner = `room:admin:${admin.adminId}`;
    await service.attachments.create(id, owner, {
      id: fileId,
      name: 'notes.txt',
      mime_type: 'text/plain',
      size_bytes: 4,
    });
    await service.attachments.put(id, owner, fileId, 0, Buffer.from('test').toString('base64'));
    await service.attachments.seal(id, owner, fileId);
    await expect(
      service.attachments.assertReadableDraft(id, fileId, `room:agent:${members[0]!.addressId}`),
    ).rejects.toThrow('not found');
    await expect(
      service.send(admin, { room_id: other, client_request_id: randomUUID(), attachments: [fileId] }),
    ).rejects.toThrow();
    await expect(
      service.send(actor(0), { room_id: id, client_request_id: randomUUID(), attachments: [fileId] }),
    ).rejects.toThrow();
    await service.send(admin, { room_id: id, client_request_id: randomUUID(), attachments: [fileId] });
    await service.attachments.assertReadableDraft(id, fileId, `room:agent:${members[0]!.addressId}`);
    await service.attachments.purge();
    expect((await service.attachments.info(id, fileId)).status).toBe('linked');
  });
  it('operator conferences drain outstanding deliveries, reject new rounds, then close', async () => {
    const id = await create('conference');
    const stored = (await db.select().from(agentBusConferences).where(eq(agentBusConferences.id, id)))[0]!;
    expect(stored.ownerAdminId).toBe(admin.adminId);
    const event = await service.send(admin, {
      room_id: id,
      client_request_id: randomUUID(),
      content: 'One round',
      ask_all: true,
    });
    await service.manage(admin, { room_id: id, client_request_id: randomUUID(), action: 'close' });
    expect((await service.read(admin, { room_id: id })).room.status).toBe('adjourning');
    await expect(
      service.send(admin, { room_id: id, client_request_id: randomUUID(), content: 'Another round' }),
    ).rejects.toThrow('closed');
    await service.send(actor(0), {
      room_id: id,
      client_request_id: randomUUID(),
      content: 'Last answer',
      reply_to: event.id,
    });
    const deliveries = await db
      .select()
      .from(agentRoomDeliveries)
      .where(eq(agentRoomDeliveries.eventId, event.id));
    await db
      .update(agentBusMessages)
      .set({ status: 'completed' })
      .where(
        inArray(
          agentBusMessages.id,
          deliveries.map((d) => d.messageId!),
        ),
      );
    await service.tick();
    expect((await service.read(admin, { room_id: id })).room.status).toBe('adjourned');
  });
  it('shows native conference fanout as one shared contribution', async () => {
    const chair = members[0]!;
    const opened = await bus.openConference(chair.sessionId, chair.token, { topic: 'Native room' });
    const id = String(opened.conference_id);
    rooms.push(id);
    for (const participant of members.slice(1)) {
      await service.manage(admin, {
        room_id: id,
        client_request_id: randomUUID(),
        action: 'invite',
        address_id: participant.addressId,
      });
    }
    await bus.conferenceSay(chair.sessionId, chair.token, {
      conferenceId: id,
      content: 'One contribution, two deliveries',
    });
    const page = await service.read(admin, { room_id: id });
    const contributions = page.events.filter((event) => event.content === 'One contribution, two deliveries');
    expect(contributions).toHaveLength(1);
    expect(contributions[0]!.deliveries).toHaveLength(2);
    const request = await service.send(admin, {
      room_id: id,
      client_request_id: randomUUID(),
      content: 'Final review',
      recipients: [members[1]!.addressId],
    });
    await bus.adjournConference(chair.sessionId, chair.token, { conferenceId: id });
    expect((await service.read(actor(1), { room_id: id })).room.status).toBe('adjourning');
    await service.send(actor(1), {
      room_id: id,
      client_request_id: randomUUID(),
      content: 'Final answer',
      reply_to: request.id,
    });
  });
  it('reports older wrappers without queuing tools they do not have', async () => {
    const id = await create();
    const target = members[1]!;
    await db
      .update(agentSessions)
      .set({ adapterCapabilities: {} })
      .where(eq(agentSessions.id, target.sessionId));
    try {
      const event = await service.send(admin, {
        room_id: id,
        client_request_id: randomUUID(),
        content: 'Please review',
        recipients: [target.addressId],
      });
      const receipts = await db
        .select()
        .from(agentRoomDeliveries)
        .where(eq(agentRoomDeliveries.eventId, event.id));
      expect(receipts).toMatchObject([{ messageId: null, reason: 'wrapper_update_required' }]);
    } finally {
      await db
        .update(agentSessions)
        .set({
          adapterCapabilities: { test: true, execution_contract_version: 2, shared_room_chat_version: 1 },
        })
        .where(eq(agentSessions.id, target.sessionId));
    }
  });
  it('paginates equal timestamps without losing or duplicating events', async () => {
    const id = await create(),
      time = new Date().toISOString();
    const rows = Array.from({ length: 121 }, (_, i) => ({
      id: randomUUID(),
      roomId: id,
      actor: `admin:${admin.adminId}`,
      requestId: randomUUID(),
      payloadHash: '0'.repeat(64),
      createdAt: time,
      bodyEnc: encrypt(
        JSON.stringify({ name: 'Operator', content: `Message ${i}`, kind: 'chat', attachments: [] }),
        testKeyring(),
      ),
    }));
    await db.insert(agentRoomEvents).values(rows);
    const found: string[] = [];
    let before: string | undefined;
    do {
      const page = await service.read(admin, { room_id: id, before, limit: 25 });
      found.push(...page.events.map((e) => e.id));
      before = page.next_before ?? undefined;
    } while (before);
    expect(found).toHaveLength(121);
    expect(new Set(found).size).toBe(121);
  });
});
