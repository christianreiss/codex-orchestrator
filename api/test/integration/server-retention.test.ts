import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChatAttachments } from '../../src/services/agent-chat/attachments.js';
import { randomBytes, randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminSessions, adminUsers, chattySessions, chattyRuns, chattyEvents, agentBusGroups, agentBusConferences, agentBusSubscriptions, agentRoomEvents, hostDaemonSessions, hostDaemonOperations, advisorSessions, agentChatAttachments, agentBusAddresses, agentBusRelays, agentBusConversations, agentBusMessages, agentSchedules, agentSessions, hosts, mcpSessionTokens } from '../../src/db/schema.js';
import { AgentMessagingService } from '../../src/services/agent-messaging.js';
import { AgentPortalService } from '../../src/services/agent-portal.js';
import { hostPresenceViews } from '../../src/services/host-presence.js';
import { recordHostContact } from '../../src/services/host-lifecycle.js';
import { ServerRetentionService } from '../../src/services/server-retention/index.js';
import { getTestDb } from '../helpers/test-db.js';
import { loadTestEnv, testKeyring } from '../helpers/test-keyring.js';

const handle = await getTestDb();
const instant = new Date();
const now = instant.toISOString();
const old = new Date(instant.getTime() - 86400_000 - 1000).toISOString();
describe.skipIf(!handle)('24h server history retention', { timeout: 120_000 }, () => {
  const db = handle?.db;
  let host: typeof hosts.$inferSelect;
  let bus: AgentMessagingService;
  let portal: AgentPortalService;
  let retention: ServerRetentionService;
  const ids: string[] = [];
  beforeAll(async () => {
    const fqdn = `retention-${randomUUID()}.test`;
    await db!.insert(hosts).values({ fqdn, apiKey: randomBytes(32).toString('hex'), engines: 'codex,claude,grok', status: 'active', secure: 1, createdAt: now, updatedAt: now });
    host = (await db!.select().from(hosts).where(eq(hosts.fqdn, fqdn)))[0]!;
    await db!.execute(sql`INSERT INTO versions (name,version,updated_at) VALUES ('agent_messaging_enabled','1',${now}),('agent_portal_enabled','1',${now}) ON DUPLICATE KEY UPDATE version='1'`);
    bus = new AgentMessagingService(db!, loadTestEnv(), testKeyring());
    portal = new AgentPortalService(db!, loadTestEnv(), testKeyring());
    retention = new ServerRetentionService(db!);
  });
  afterAll(async () => {
    await db!.execute(sql`DELETE FROM agent_bus_messages WHERE sender_address_id IN (SELECT id FROM agent_bus_addresses WHERE host_id=${host.id}) OR target_address_id IN (SELECT id FROM agent_bus_addresses WHERE host_id=${host.id})`);
    await db!.execute(sql`DELETE FROM agent_bus_conversations WHERE address_a_id IN (SELECT id FROM agent_bus_addresses WHERE host_id=${host.id}) OR address_b_id IN (SELECT id FROM agent_bus_addresses WHERE host_id=${host.id})`);
    await db!.delete(mcpSessionTokens).where(eq(mcpSessionTokens.hostId, host.id));
    await db!.execute(sql`DELETE FROM agent_schedules WHERE target_address_id IN (SELECT id FROM agent_bus_addresses WHERE host_id=${host.id})`);
    await db!.execute(sql`DELETE FROM agent_name_leases WHERE address_id IN (SELECT id FROM agent_bus_addresses WHERE host_id=${host.id})`);
    await db!.execute(sql`DELETE FROM agent_sessions WHERE host_id=${host.id}`);
    await db!.execute(sql`DELETE FROM agent_bus_addresses WHERE host_id=${host.id}`);
    await db!.delete(hosts).where(eq(hosts.id, host.id));
    await handle!.pool.end();
  });

  async function agent(engine: 'codex' | 'claude' | 'grok' = 'codex') {
    const id = randomUUID(), bridgeToken = randomBytes(32).toString('base64url');
    const registered = await bus.registerSession(host, { sessionId: id, bridgeToken, engine, username: 'test', cwd: '/tmp/retention', invocationKind: 'interactive', upstreamSessionId: randomUUID() });
    ids.push(id);
    return { id, bridgeToken, address: (registered.address as { id: string; address: string }) };
  }
  async function end(a: Awaited<ReturnType<typeof agent>>, status = 'completed') {
    await db!.update(agentSessions).set({ status, endedAt: old, expiresAt: old, heartbeatAt: old, bridgeExpiresAt: old }).where(eq(agentSessions.id, a.id));
    await db!.update(agentBusAddresses).set({ currentSessionId: null, lastSeenAt: old }).where(eq(agentBusAddresses.id, a.address.id));
  }
  async function exists(table: string, id: string) {
    const [result] = await db!.execute(sql`SELECT id FROM ${sql.identifier(table)} WHERE id=${id}`);
    return (result as unknown as unknown[]).length > 0;
  }
  it('purges expired MCP and admin tokens while retaining valid ones', async () => {
    const expired = randomBytes(32).toString('hex'), valid = randomBytes(32).toString('hex');
    await db!.insert(mcpSessionTokens).values([{ token: expired, hostId: host.id, expiresAt: old, createdAt: old, updatedAt: old }, { token: valid, hostId: host.id, expiresAt: new Date(instant.getTime()+3600000).toISOString(), createdAt: now, updatedAt: now }]);
    await db!.insert(adminSessions).values({ userId: 999999, tokenHash: expired, expiresAt: old, lastSeenAt: old, createdAt: old });
    expect((await retention.purge(instant)).credentials).toBeGreaterThanOrEqual(2);
    expect(await db!.select().from(mcpSessionTokens).where(eq(mcpSessionTokens.token, expired))).toHaveLength(0);
    expect(await db!.select().from(mcpSessionTokens).where(eq(mcpSessionTokens.token, valid))).toHaveLength(1);
    await db!.delete(mcpSessionTokens).where(eq(mcpSessionTokens.token, valid));
  });
  it('purges expired dormant relays without revoking a still-valid credential', async () => {
    const expired = randomUUID(), valid = randomUUID();
    for (const [id, expiresAt] of [[expired, old], [valid, new Date(instant.getTime()+3600000).toISOString()]] as const) {
      await db!.insert(agentBusRelays).values({ id, hostId: host.id, username: id, instanceId: randomUUID(), hostAuthFingerprint: 'f'.repeat(64), wrapperVersion: 'test', status: 'stale', heartbeatAt: old, tokenExpiresAt: expiresAt, createdAt: old, updatedAt: old });
    }
    await retention.purge(instant);
    expect(await exists('agent_bus_relays', expired)).toBe(false);
    expect(await exists('agent_bus_relays', valid)).toBe(true);
    await db!.delete(agentBusRelays).where(eq(agentBusRelays.id, valid));
  });
  it('bounds credential catch-up batches and resumes on the next tick', async () => {
    await db!.insert(mcpSessionTokens).values(Array.from({ length: 1002 }, () => ({ token: randomBytes(32).toString('hex'), hostId: host.id, expiresAt: old, createdAt: old, updatedAt: old })));
    await retention.purge(instant);
    expect(await db!.select().from(mcpSessionTokens).where(eq(mcpSessionTokens.hostId, host.id))).toHaveLength(2);
    await retention.purge(instant);
    expect(await db!.select().from(mcpSessionTokens).where(eq(mcpSessionTokens.hostId, host.id))).toHaveLength(0);
  });
  it('retains an unused address until its exact 24 hour boundary', async () => {
    const a = await agent();
    const unrelated = await agent('claude');
    await end(a);
    const contact = new Date(instant.getTime() - 86400_000 + 1).toISOString();
    await db!.update(agentBusAddresses).set({ lastSeenAt: contact }).where(eq(agentBusAddresses.id, a.address.id));
    await portal.purgeExpired();
    await retention.purge(instant);
    expect(await exists('agent_bus_addresses', a.address.id)).toBe(true);
    await retention.purge(new Date(instant.getTime() + 1));
    expect(await exists('agent_bus_addresses', a.address.id)).toBe(false);
    expect(await exists('agent_bus_addresses', unrelated.address.id)).toBe(true);
    await end(unrelated);
    await portal.purgeExpired();
    await retention.purge(instant);
  });
  it.each(['codex','claude','grok'] as const)('purges ended %s identities including rebooted sessions and stale notices', async engine => {
    const a = await agent(engine);
    await end(a, 'rebooted');
    await db!.execute(sql`INSERT INTO agent_chat_notices (id,session_id,severity,payload_enc,event_id,created_at) VALUES (${randomUUID()},${a.id},'warning','redacted',1,${old})`);
    await portal.purgeExpired();
    await retention.purge(instant);
    expect(await exists('agent_sessions', a.id)).toBe(false);
    expect(await exists('agent_bus_addresses', a.address.id)).toBe(false);
  });
  it('preserves a paused explicit job and its native identity', async () => {
    const a = await agent();
    await end(a);
    const scheduleId = randomUUID();
    await db!.insert(agentSchedules).values({ id: scheduleId, name: 'paused', targetAddressId: a.address.id, promptEnc: 'redacted', kind: 'interval', intervalMinutes: 60, timezone: 'UTC', enabled: 0, pauseReason: 'operator', createdBy: 'test', updatedBy: 'test', createdAt: old, updatedAt: old });
    await portal.purgeExpired();
    await retention.purge(instant);
    expect(await exists('agent_sessions', a.id)).toBe(true);
    expect(await exists('agent_bus_addresses', a.address.id)).toBe(true);
    await db!.delete(agentSchedules).where(eq(agentSchedules.id, scheduleId));
    await portal.purgeExpired();
    await retention.purge(instant);
    expect(await exists('agent_bus_addresses', a.address.id)).toBe(false);
  });
  it('retains a peer thread while either participant is live, then removes its message results and identities', async () => {
    const a = await agent(), b = await agent();
    const message = await bus.sendMessage(a.id, a.bridgeToken, { to: b.address.address, content: 'private test', clientMessageId: randomUUID() });
    const messageId = String((message.message as { id: string }).id);
    const [stored] = await db!.select().from(agentBusMessages).where(eq(agentBusMessages.id, messageId));
    expect(stored).toBeDefined();
    await db!.update(agentBusMessages).set({ status: 'completed', completedAt: old, createdAt: old, updatedAt: old }).where(eq(agentBusMessages.id, messageId));
    await db!.update(agentBusConversations).set({ lastActivityAt: old }).where(eq(agentBusConversations.id, stored!.conversationId));
    await end(a);
    await retention.purge(instant);
    expect(await exists('agent_bus_conversations', stored!.conversationId)).toBe(true);
    await end(b);
    await portal.purgeExpired();
    await retention.purge(instant);
    expect(await exists('agent_bus_conversations', stored!.conversationId)).toBe(false);
    expect(await exists('agent_bus_messages', messageId)).toBe(false);
    expect(await exists('agent_bus_addresses', a.address.id)).toBe(false);
    expect(await exists('agent_bus_addresses', b.address.id)).toBe(false);
    await retention.purge(instant); // A retry cannot resurrect or replay work.
  });
  it('protects unfinished delivery until its existing TTL expires', async () => {
    const a = await agent(), b = await agent();
    const receipt = await bus.sendMessage(a.id, a.bridgeToken, { to: b.address.address, content: 'pending', clientMessageId: randomUUID() });
    const message = receipt.message as { id: string; conversation_id: string };
    await db!.update(agentBusConversations).set({ lastActivityAt: old }).where(eq(agentBusConversations.id, message.conversation_id));
    await end(a); await end(b);
    await portal.purgeExpired(); await retention.purge(instant);
    expect(await exists('agent_bus_addresses', b.address.id)).toBe(true);
    expect(await exists('agent_bus_messages', message.id)).toBe(true);
    await db!.update(agentBusMessages).set({ expiresAt: old, status: 'batched' }).where(eq(agentBusMessages.id, message.id));
    await bus.maintenance();
    expect((await db!.select().from(agentBusMessages).where(eq(agentBusMessages.id, message.id)))[0]?.status).toBe('expired');
    await portal.purgeExpired(); await retention.purge(instant);
    expect(await exists('agent_bus_addresses', b.address.id)).toBe(false);
  });
  it('serializes a simultaneous send against thread purging without orphan messages', async () => {
    const a = await agent(), b = await agent();
    const first = await bus.sendMessage(a.id, a.bridgeToken, { to: b.address.address, content: 'old thread', clientMessageId: randomUUID() });
    const message = first.message as { id: string; conversation_id: string };
    await db!.update(agentBusMessages).set({ status: 'completed', updatedAt: old }).where(eq(agentBusMessages.id, message.id));
    await db!.update(agentBusConversations).set({ lastActivityAt: old }).where(eq(agentBusConversations.id, message.conversation_id));
    // Credentials are valid, but the last observation is old. The send and the
    // reaper contend for the same gate; either serialized outcome is valid.
    for (const a0 of [a,b]) {
      await db!.update(agentSessions).set({ heartbeatAt: old }).where(eq(agentSessions.id, a0.id));
      await db!.update(agentBusAddresses).set({ lastSeenAt: old }).where(eq(agentBusAddresses.id, a0.address.id));
    }
    const result = await Promise.allSettled([
      retention.purge(instant),
      bus.sendMessage(a.id, a.bridgeToken, { to: b.address.address, conversationId: message.conversation_id, content: 'concurrent', clientMessageId: randomUUID() }),
    ]);
    expect(result[0].status).toBe('fulfilled');
    const [orphans] = await db!.execute(sql`SELECT m.id FROM agent_bus_messages m LEFT JOIN agent_bus_conversations c ON c.id=m.conversation_id WHERE m.sender_address_id=${a.address.id} AND c.id IS NULL`);
    expect(orphans).toHaveLength(0);
    await db!.execute(sql`UPDATE agent_bus_messages SET status='completed' WHERE sender_address_id=${a.address.id}`);
    await db!.update(agentBusConversations).set({ lastActivityAt: old }).where(eq(agentBusConversations.id, message.conversation_id));
    await end(a); await end(b);
    await portal.purgeExpired(); await retention.purge(instant);
  });
  it('ages shared room history while preserving group definitions, then purges adjourned conferences', async () => {
    const a = await agent();
    const groupId = randomUUID(), conferenceId = randomUUID(), eventId = randomUUID(), slug = `retention-${randomUUID()}`;
    await db!.insert(agentBusGroups).values({ id: groupId, slug, title: 'durable group', createdByAddressId: a.address.id, createdAt: old, updatedAt: old });
    await db!.insert(agentBusSubscriptions).values({ id: randomUUID(), topic: `group:${slug}`, subscriberAddressId: a.address.id, createdAt: old });
    await db!.insert(agentRoomEvents).values({ id: eventId, roomId: groupId, actor: a.address.address, requestId: randomUUID(), payloadHash: 'f'.repeat(64), bodyEnc: 'redacted', createdAt: old });
    await db!.insert(agentBusConferences).values({ id: conferenceId, ownerAddressId: a.address.id, status: 'adjourned', deadlineAt: old, adjournedAt: old, createdAt: old, updatedAt: old });
    await retention.purge(instant);
    expect(await exists('agent_room_events', eventId)).toBe(true);
    expect(await exists('agent_bus_conferences', conferenceId)).toBe(true);
    await end(a);
    await portal.purgeExpired();
    await retention.purge(instant);
    expect(await exists('agent_room_events', eventId)).toBe(false);
    expect(await exists('agent_bus_conferences', conferenceId)).toBe(false);
    expect(await exists('agent_bus_groups', groupId)).toBe(true);
    await db!.delete(agentBusGroups).where(eq(agentBusGroups.id, groupId));
  });
  it('purges disconnected remote/Advisor history and retries retired attachment cleanup', async () => {
    const a = await agent();
    const remote = randomUUID(), operation = randomUUID(), advisor = randomUUID(), attachment = randomUUID();
    await db!.insert(hostDaemonSessions).values({ id: remote, hostId: host.id, owner: 'test', engine: 'codex', username: 'test', cwd: '/tmp/retention', title: 'old remote', addressId: a.address.id, sessionId: a.id, status: 'running', lastActivityAt: old, createdAt: old });
    await db!.insert(hostDaemonOperations).values({ id: operation, sessionId: remote, hostId: host.id, clientKey: randomUUID(), requestHash: 'f'.repeat(64), promptEnc: 'private', status: 'accepted', createdAt: old, updatedAt: old });
    await db!.insert(advisorSessions).values({ id: advisor, callerAddressId: a.address.id, clientKey: randomUUID(), daemonSessionId: remote, hostId: host.id, kind: 'general', status: 'open', createdAt: old, updatedAt: old });
    await db!.insert(agentChatAttachments).values({ id: attachment, sessionId: remote, owner: 'test', metadataEnc: 'redacted', sizeBytes: 4, status: 'linked', createdAt: old, updatedAt: old });
    await retention.purge(instant);
    expect(await exists('host_daemon_sessions', remote)).toBe(true);
    await end(a);
    await portal.purgeExpired();
    await retention.purge(instant);
    expect(await exists('host_daemon_sessions', remote)).toBe(false);
    expect(await exists('host_daemon_operations', operation)).toBe(false);
    expect(await exists('advisor_sessions', advisor)).toBe(false);
    expect((await db!.select().from(agentChatAttachments).where(eq(agentChatAttachments.id, attachment)))[0]?.status).toBe('retired');
    const root = await mkdtemp(join(tmpdir(), 'retention-attachments-'));
    try {
      const files = new ChatAttachments(db!, testKeyring(), root);
      await mkdir(files.directory(attachment), { recursive: true });
      await writeFile(join(files.directory(attachment), 'original'), 'test');
      await files.purge();
      await files.purge();
      expect(await exists('agent_chat_attachments', attachment)).toBe(false);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('purges inactive private Chatty history and advances its generation once', async () => {
    const username = `retention-${randomUUID()}`;
    await db!.insert(adminUsers).values({ name: 'test', username, email: `${username}@test.invalid`, passwordHash: 'unused', accessLevel: 'owner', createdAt: old, updatedAt: old });
    const user = (await db!.select().from(adminUsers).where(eq(adminUsers.username, username)))[0]!;
    const run = randomUUID();
    await db!.insert(chattySessions).values({ userId: user.id, generation: 5, selection: { engine: 'grok', model: null }, updatedAt: old });
    await db!.insert(chattyRuns).values({ id: run, userId: user.id, adminSessionId: 999999, generation: 5, clientMessageId: randomUUID(), requestHash: 'f'.repeat(64), status: 'running', inputEnc: 'private', stateEnc: 'private', leaseUntil: old, createdAt: old, updatedAt: old });
    await db!.insert(chattyEvents).values({ userId: user.id, generation: 5, runId: run, kind: 'user', bodyEnc: 'private', createdAt: old });
    await retention.purge(instant);
    expect(await exists('chatty_runs', run)).toBe(false);
    expect((await db!.select().from(chattySessions).where(eq(chattySessions.userId, user.id)))[0]?.generation).toBe(6);
    await retention.purge(instant);
    expect((await db!.select().from(chattySessions).where(eq(chattySessions.userId, user.id)))[0]?.generation).toBe(6);
    await db!.delete(adminUsers).where(eq(adminUsers.id, user.id));
  });
  it('records authenticated contact without treating administrative edits as online', async () => {
    await recordHostContact(db!, host, instant);
    host = (await db!.select().from(hosts).where(eq(hosts.id, host.id)))[0]!;
    expect(Date.parse(host.lastContactAt!)).toBe(Math.floor(instant.getTime()/1000)*1000);
    const a = await agent('grok');
    await db!.update(hosts).set({ lastContactAt: old }).where(eq(hosts.id, host.id));
    await portal.heartbeatAgent(a.id, a.bridgeToken, {});
    expect(Date.parse((await db!.select().from(hosts).where(eq(hosts.id, host.id)))[0]!.lastContactAt!)).toBeGreaterThan(Date.parse(old));
    await db!.update(hosts).set({ lastContactAt: old }).where(eq(hosts.id, host.id));
    await bus.heartbeatSession(a.id, a.bridgeToken, {});
    expect(Date.parse((await db!.select().from(hosts).where(eq(hosts.id, host.id)))[0]!.lastContactAt!)).toBeGreaterThan(Date.parse(old));
    expect((await hostPresenceViews(db!, [host])).get(host.id)?.presence).toBe('online');
    await end(a);
    await db!.update(hosts).set({ updatedAt: new Date().toISOString(), grokLastRefresh: new Date().toISOString() }).where(eq(hosts.id, host.id));
    expect((await hostPresenceViews(db!, [host])).get(host.id)?.presence).toBe('offline');
  });
});
