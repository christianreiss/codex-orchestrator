import { randomBytes, randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { agentBusAddresses, agentBusMessages, agentSessions, hosts } from '../../../src/db/schema.js';
import { AgentMessagingService } from '../../../src/services/agent-messaging.js';
import { AgentReceiverService } from '../../../src/services/agent-receiver.js';
import { getTestDb } from '../../helpers/test-db.js';
import { loadTestEnv, testKeyring } from '../../helpers/test-keyring.js';
import type { Engine } from '../../../src/util/engine.js';

const handle = await getTestDb();
const protocols = { codex: 'codex-queue-v1', claude: 'claude-channel-v1', grok: 'grok-acp-v1' } as const;
interface Peer { id: string; token: string; address: string; addressId: string; generation: number; native: string; engine: Engine; username: string; }

describe.skipIf(!handle)('presence receipts and session-bound return notices', () => {
  let host: typeof hosts.$inferSelect;
  let service: AgentMessagingService;
  let receiver: AgentReceiverService;
  beforeAll(async () => {
    const db = handle!.db, now = new Date().toISOString();
    const fqdn = `presence-${randomUUID()}.test`;
    await db.insert(hosts).values({ fqdn, apiKey: 'e'.repeat(64), engines: 'codex,claude,grok', status: 'active', secure: 1, createdAt: now, updatedAt: now });
    host = (await db.select().from(hosts).where(eq(hosts.fqdn, fqdn)))[0]!;
    await db.execute(sql`INSERT INTO versions (name,version,updated_at) VALUES ('agent_messaging_enabled','1',${now}), ('agent_portal_enabled','0',${now}) ON DUPLICATE KEY UPDATE version=VALUES(version)`);
    service = new AgentMessagingService(db, loadTestEnv(), testKeyring());
    receiver = new AgentReceiverService(db, loadTestEnv(), testKeyring());
  });
  afterEach(async () => {
    const db = handle!.db;
    await db.execute(sql`DELETE FROM agent_bus_messages WHERE sender_address_id IN (SELECT id FROM agent_bus_addresses WHERE host_id=${host.id}) OR target_address_id IN (SELECT id FROM agent_bus_addresses WHERE host_id=${host.id})`);
    await db.execute(sql`DELETE FROM agent_bus_conversations WHERE address_a_id IN (SELECT id FROM agent_bus_addresses WHERE host_id=${host.id}) OR address_b_id IN (SELECT id FROM agent_bus_addresses WHERE host_id=${host.id})`);
    await db.execute(sql`DELETE FROM agent_bus_relays WHERE host_id=${host.id}`);
    await db.execute(sql`DELETE FROM agent_sessions WHERE host_id=${host.id}`);
    await db.execute(sql`DELETE FROM agent_bus_addresses WHERE host_id=${host.id}`);
  });
  afterAll(async () => {
    await handle!.db.delete(hosts).where(eq(hosts.id, host.id));
    await handle!.db.execute(sql`UPDATE versions SET version='0' WHERE name='agent_messaging_enabled'`);
    await handle!.pool.end();
  });
  async function peer(engine: Engine = 'codex', previous?: Peer, ready = false): Promise<Peer> {
    const id = randomUUID(), token = randomBytes(32).toString('base64url');
    const native = previous?.native ?? randomUUID(), username = previous?.username ?? randomUUID();
    const out = await service.registerSession(host, { sessionId: id, bridgeToken: token, engine, username, cwd: '/tmp/presence-feedback', invocationKind: 'interactive', upstreamSessionId: native, resumed: !!previous, requestedAddress: previous?.address, expectedBindingGeneration: previous?.generation, adapterProtocol: ready ? 'test-live-v1' : undefined });
    const address = out.address as any;
    return { id, token, native, engine, username, address: address.address, addressId: address.id, generation: address.binding_generation };
  }
  async function send(b: Peer, a: Peer, clientMessageId = randomUUID(), content = 'hello') {
    return await service.sendMessage(b.id, b.token, { to: a.address, content, clientMessageId }) as any;
  }
  async function ready(a: Peer) {
    const generation = randomUUID();
    await receiver.register(a.id, a.token, { generation, protocol: protocols[a.engine], native_session_id: a.native });
    return generation;
  }
  async function notices(b: Peer) {
    return handle!.db.select().from(agentBusMessages).where(and(eq(agentBusMessages.targetAddressId, b.addressId), eq(agentBusMessages.kind, 'presence_notice')));
  }

  it('distinguishes online, receive-ready and offline, refreshing idempotent receipts', async () => {
    const a = await peer(), b = await peer();
    const client = randomUUID();
    expect(await send(b, a, client)).toMatchObject({ created: true, recipient_presence: 'online', message: { status: 'queued' }, delivery_hint: expect.stringContaining('not ready') });
    const gen = await ready(a);
    expect(await send(b, a, client)).toMatchObject({ created: false, recipient_presence: 'listening' });
    await receiver.update(a.id, a.token, gen, 'stop', {});
    await service.finishSession(a.id, a.token, 'completed');
    expect(await send(b, a, client)).toMatchObject({ created: false, recipient_presence: 'resumable', observed_at: expect.any(String), delivery_hint: expect.stringContaining('offline') });
  });

  for (const engine of Object.keys(protocols) as Engine[]) {
    it(`${engine}: resumes the same address and bundles waiting messages once for live B`, async () => {
      let a = await peer(engine), b = await peer('claude', undefined, true);
      await service.finishSession(a.id, a.token, 'completed');
      const first = await send(b, a), second = await send(b, a);
      a = await peer(engine, a);
      expect(await notices(b)).toHaveLength(0);
      const generation = await ready(a);
      await receiver.register(a.id, a.token, { generation, protocol: protocols[engine], native_session_id: a.native });
      await receiver.update(a.id, a.token, generation, 'heartbeat', {});
      await service.heartbeatSession(a.id, a.token, {});
      const rows = await notices(b);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ targetSessionId: b.id, status: 'queued', awaitingPresence: 0 });
      const delivery = await service.claimForSession(b.id, b.token, randomUUID());
      expect(delivery).toMatchObject({ kind: 'presence_notice', content: expect.stringContaining(first.message.id) });
      expect(delivery?.content).toContain(second.message.id);
      await expect(service.replyMessage(b.id, b.token, delivery!.message_id, { content: 'thanks', clientMessageId: randomUUID() })).rejects.toMatchObject({ code: 'agent_messaging_presence_notice_reply' });
    });
  }

  it('drops a queued notice when B ends and does not block later mail or wake a new B', async () => {
    let a = await peer(), b = await peer('codex', undefined, true);
    await service.finishSession(a.id, a.token, 'completed');
    await send(b, a);
    a = await peer('codex', a);
    await ready(a);
    const [notice] = await notices(b);
    await service.finishSession(b.id, b.token, 'completed');
    expect((await notices(b))[0]!.status).toBe('canceled');
    const relay: any = await service.registerRelay(host, { username: b.username, instanceId: randomUUID(), wrapperVersion: 'test', capabilities: {} });
    expect(await service.claimForRelay(relay.relay_id, relay.relay_token, randomUUID())).toBeNull();
    b = await peer('codex', b, true);
    const followUp = await send(a, b);
    expect(await service.claimForSession(b.id, b.token, randomUUID())).toMatchObject({ message_id: followUp.message.id, kind: 'message' });
    expect((await notices(b))[0]!.id).toBe(notice!.id);
  });

  it('does not notify B that was offline during the return, including a later B launch', async () => {
    let a = await peer(), b = await peer();
    await service.finishSession(a.id, a.token, 'completed');
    await send(b, a);
    await service.finishSession(b.id, b.token, 'completed');
    a = await peer('codex', a);
    const generation = await ready(a);
    expect(await notices(b)).toHaveLength(0);
    b = await peer('codex', b, true);
    await receiver.update(a.id, a.token, generation, 'heartbeat', {});
    expect(await notices(b)).toHaveLength(0);
  });

  it('ignores expired, canceled and already accepted messages', async () => {
    let a = await peer(), b = await peer();
    await service.finishSession(a.id, a.token, 'completed');
    const expired = await send(b, a), canceled = await send(b, a), accepted = await send(b, a);
    await handle!.db.update(agentBusMessages).set({ expiresAt: new Date(Date.now() - 1000).toISOString() }).where(eq(agentBusMessages.id, expired.message.id));
    await handle!.db.update(agentBusMessages).set({ status: 'canceled' }).where(eq(agentBusMessages.id, canceled.message.id));
    await handle!.db.update(agentBusMessages).set({ status: 'accepted' }).where(eq(agentBusMessages.id, accepted.message.id));
    a = await peer('codex', a);
    await ready(a);
    expect(await notices(b)).toHaveLength(0);
  });

  it('includes leased and this resumed launch’s accepted relay message', async () => {
    let a = await peer(), b = await peer();
    await service.finishSession(a.id, a.token, 'completed');
    const leased = await send(b, a), accepted = await send(b, a);
    a = await peer('codex', a);
    await handle!.db.update(agentBusMessages).set({ status: 'leased' }).where(eq(agentBusMessages.id, leased.message.id));
    await handle!.db.update(agentBusMessages).set({ status: 'accepted', deliverySessionId: a.id, leaseOwner: `relay:${randomUUID()}:1` }).where(eq(agentBusMessages.id, accepted.message.id));
    await ready(a);
    const delivery = await service.claimForSession(b.id, b.token, randomUUID()).catch(() => null);
    // B is online without a receiver: its notice still remains queued.
    expect(delivery).toBeNull();
    const [notice] = await notices(b);
    expect(notice).toBeDefined();
    const out: any = await service.getMessage(b.id, b.token, notice!.id);
    expect(JSON.stringify(out)).toContain(leased.message.id);
    expect(JSON.stringify(out)).toContain(accepted.message.id);
  });

  it('notifies multiple live senders but not one with a stale heartbeat', async () => {
    let a = await peer();
    const b = await peer(), c = await peer('grok'), stale = await peer('claude');
    await service.finishSession(a.id, a.token, 'completed');
    await send(b, a); await send(c, a); await send(stale, a);
    await handle!.db.update(agentSessions).set({ heartbeatAt: new Date(Date.now() - 120_000).toISOString() }).where(eq(agentSessions.id, stale.id));
    a = await peer('codex', a); await ready(a);
    expect(await notices(b)).toHaveLength(1);
    expect(await notices(c)).toHaveLength(1);
    expect(await notices(stale)).toHaveLength(0);
  });

  it('returns recipient presence on replies too', async () => {
    const a = await peer('codex', undefined, true), b = await peer('claude', undefined, true);
    const first = await send(b, a);
    await service.finishSession(b.id, b.token, 'completed');
    const receipt = await service.replyMessage(a.id, a.token, first.message.id, { content: 'response', clientMessageId: randomUUID() });
    expect(receipt).toMatchObject({ recipient_presence: 'resumable', message: { kind: 'reply', status: 'queued' } });
  });

  it('marks live queued mail as waiting when A ends regularly', async () => {
    let a = await peer('codex', undefined, true), b = await peer();
    await send(b, a);
    await service.finishSession(a.id, a.token, 'completed');
    a = await peer('codex', a);
    await ready(a);
    expect(await notices(b)).toHaveLength(1);
  });
});
