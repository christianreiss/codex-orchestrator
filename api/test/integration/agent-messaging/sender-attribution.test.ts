/**
 * One agent address can be written to by several lifecycles over time (an exact
 * native resume rebinds it) and by everything inside one lifecycle's process
 * tree. The message view must say which lifecycle sent a row, so a participant
 * can tell "my own launch" from "another launch under my UUID" without the DB.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { hosts } from '../../../src/db/schema.js';
import { AgentMessagingService } from '../../../src/services/agent-messaging.js';
import { getTestDb } from '../../helpers/test-db.js';
import { loadTestEnv, testKeyring } from '../../helpers/test-keyring.js';

const handle = await getTestDb();
interface Peer { id: string; token: string; address: string; generation: number; native: string; username: string }

describe.skipIf(!handle)('message sender attribution', () => {
  let host: typeof hosts.$inferSelect;
  let service: AgentMessagingService;
  beforeAll(async () => {
    const db = handle!.db, now = new Date().toISOString();
    const fqdn = `attribution-${randomUUID()}.test`;
    await db.insert(hosts).values({ fqdn, apiKey: 'a'.repeat(64), engines: 'codex,claude,grok', status: 'active', secure: 1, createdAt: now, updatedAt: now });
    host = (await db.select().from(hosts).where(eq(hosts.fqdn, fqdn)))[0]!;
    await db.execute(sql`INSERT INTO versions (name,version,updated_at) VALUES ('agent_messaging_enabled','1',${now}) ON DUPLICATE KEY UPDATE version=VALUES(version)`);
    service = new AgentMessagingService(db, loadTestEnv(), testKeyring());
  });
  afterEach(async () => {
    const db = handle!.db;
    await db.execute(sql`DELETE FROM agent_bus_messages WHERE sender_address_id IN (SELECT id FROM agent_bus_addresses WHERE host_id=${host.id}) OR target_address_id IN (SELECT id FROM agent_bus_addresses WHERE host_id=${host.id})`);
    await db.execute(sql`DELETE FROM agent_bus_conversations WHERE address_a_id IN (SELECT id FROM agent_bus_addresses WHERE host_id=${host.id}) OR address_b_id IN (SELECT id FROM agent_bus_addresses WHERE host_id=${host.id})`);
    await db.execute(sql`DELETE FROM agent_name_leases WHERE address_id IN (SELECT id FROM agent_bus_addresses WHERE host_id=${host.id})`);
    await db.execute(sql`DELETE FROM agent_sessions WHERE host_id=${host.id}`);
    await db.execute(sql`DELETE FROM agent_bus_addresses WHERE host_id=${host.id}`);
  });
  afterAll(async () => {
    await handle!.db.delete(hosts).where(eq(hosts.id, host.id));
    await handle!.db.execute(sql`UPDATE versions SET version='0' WHERE name='agent_messaging_enabled'`);
    await handle!.pool.end();
  });

  async function peer(previous?: Peer): Promise<Peer> {
    const id = randomUUID(), token = randomBytes(32).toString('base64url');
    const native = previous?.native ?? randomUUID(), username = previous?.username ?? randomUUID();
    const out = await service.registerSession(host, { sessionId: id, bridgeToken: token, engine: 'codex', username, cwd: '/tmp/sender-attribution', invocationKind: 'interactive', upstreamSessionId: native, resumed: !!previous, requestedAddress: previous?.address, expectedBindingGeneration: previous?.generation });
    const address = out.address as { address: string; binding_generation: number };
    return { id, token, native, username, address: address.address, generation: address.binding_generation };
  }
  const view = async (reader: Peer, messageId: string) =>
    ((await service.getMessage(reader.id, reader.token, messageId)) as { message: Record<string, unknown> }).message;

  it('names the sending lifecycle on sends and replies, distinct across a resume of the same address', async () => {
    let a = await peer();
    const b = await peer();
    const first = await service.sendMessage(a.id, a.token, { to: b.address, content: 'first', clientMessageId: randomUUID() }) as { message: { id: string } };
    expect(await view(b, first.message.id)).toMatchObject({ sender_session_id: a.id });
    expect(await view(a, first.message.id)).toMatchObject({ sender_session_id: a.id });

    const reply = await service.replyMessage(b.id, b.token, first.message.id, { content: 'answer', clientMessageId: randomUUID() }) as { message: { id: string } };
    expect(await view(a, reply.message.id)).toMatchObject({ sender_session_id: b.id });

    const firstLifecycle = a.id;
    await service.finishSession(a.id, a.token, 'completed');
    a = await peer(a);
    const second = await service.sendMessage(a.id, a.token, { to: b.address, content: 'second', clientMessageId: randomUUID() }) as { message: { id: string } };
    const [older, newer] = [await view(b, first.message.id), await view(b, second.message.id)];
    expect((older.sender as { address: string }).address).toBe((newer.sender as { address: string }).address);
    expect(older.sender_session_id).toBe(firstLifecycle);
    expect(newer.sender_session_id).toBe(a.id);
  });
});
