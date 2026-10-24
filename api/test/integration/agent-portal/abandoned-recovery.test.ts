/**
 * A wrapper that outlives an outage must not be turned into a dead lifecycle by
 * the first sweep after the API starts, and a lifecycle the sweep did end must
 * say how the same native conversation gets its agent address back.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { agentBusAddresses, agentFreshStartGrants, agentSessions, hosts } from '../../../src/db/schema.js';
import type { Env } from '../../../src/env.js';
import { AgentMessagingService } from '../../../src/services/agent-messaging.js';
import { AgentPortalService } from '../../../src/services/agent-portal.js';
import { getTestDb } from '../../helpers/test-db.js';
import { loadTestEnv, testKeyring } from '../../helpers/test-keyring.js';

const handle = await getTestDb();

describe.skipIf(!handle)('abandoned bridge recovery', { timeout: 120_000 }, () => {
  let host: typeof hosts.$inferSelect;
  let messaging: AgentMessagingService;
  let portal: AgentPortalService;
  const username = `abandoned-${randomUUID()}`;

  beforeAll(async () => {
    const db = handle!.db, now = new Date().toISOString();
    const fqdn = `abandoned-${randomUUID()}.test`;
    await db.insert(hosts).values({ fqdn, apiKey: 'f'.repeat(64), engines: 'codex', status: 'active', secure: 1, createdAt: now, updatedAt: now });
    host = (await db.select().from(hosts).where(eq(hosts.fqdn, fqdn)))[0]!;
    await db.execute(sql`INSERT INTO versions (name,version,updated_at) VALUES ('agent_messaging_enabled','1',${now}) ON DUPLICATE KEY UPDATE version=VALUES(version)`);
    const env = { ...loadTestEnv(), AGENT_PORTAL_BRIDGE_TTL_SECONDS: 900, AGENT_PORTAL_RETENTION_HOURS: 24 } as Env;
    messaging = new AgentMessagingService(db, env, testKeyring());
    portal = new AgentPortalService(db, env, testKeyring());
  });
  afterEach(async () => {
    const db = handle!.db;
    await db.execute(sql`DELETE FROM agent_events WHERE session_id IN (SELECT id FROM agent_sessions WHERE host_id=${host.id})`);
    await db.execute(sql`DELETE FROM agent_name_leases WHERE address_id IN (SELECT id FROM agent_bus_addresses WHERE host_id=${host.id})`);
    await db.execute(sql`DELETE FROM agent_sessions WHERE host_id=${host.id}`);
    await db.execute(sql`DELETE FROM agent_bus_addresses WHERE host_id=${host.id}`);
  });
  afterAll(async () => {
    await handle!.db.delete(hosts).where(eq(hosts.id, host.id));
    await handle!.db.execute(sql`UPDATE versions SET version='0' WHERE name='agent_messaging_enabled'`);
    await handle!.pool.end();
  });

  async function register(native: string, sessionId = randomUUID(), token = randomBytes(32).toString('base64url'), resumed = false) {
    const out = await messaging.registerSession(host, {
      sessionId, bridgeToken: token, engine: 'codex', username, cwd: '/tmp/abandoned-recovery',
      invocationKind: 'interactive', upstreamSessionId: native, resumed,
    });
    return { sessionId, token, address: out.address as { id: string; address: string; binding_generation: number } };
  }

  /** What an outage longer than the bridge TTL leaves behind: a live wrapper whose lease lapsed. */
  async function lapse(sessionId: string) {
    await handle!.db.update(agentSessions).set({ bridgeExpiresAt: new Date(Date.now() - 60_000).toISOString() }).where(eq(agentSessions.id, sessionId));
  }

  it('holds the sweep during the start grace so the reconnecting wrapper renews its own lifecycle', async () => {
    const native = randomUUID();
    const a = await register(native);
    await lapse(a.sessionId);

    const held = await portal.purgeExpired({ abandonedGraceUntil: new Date(Date.now() + 60_000).toISOString() });
    expect(held.abandoned_sessions).toBe(0);
    const [row] = await handle!.db.select().from(agentSessions).where(eq(agentSessions.id, a.sessionId));
    expect(row!.endedAt).toBeNull();

    // The wrapper's recovery: the heartbeat answers the recoverable code, the
    // same session id and token register again, and the lifecycle is whole.
    await expect(messaging.heartbeatSession(a.sessionId, a.token, {})).rejects.toMatchObject({ code: 'agent_bridge_expired' });
    const again = await register(native, a.sessionId, a.token);
    expect(again.address.id).toBe(a.address.id);
    await expect(messaging.self(a.sessionId, a.token)).resolves.toMatchObject({ address: a.address.address, session_id: a.sessionId });
  });

  it('sweeps once the grace has passed, names the recovery route, and an exact native resume rebinds the address', async () => {
    const native = randomUUID();
    const a = await register(native);
    await lapse(a.sessionId);

    const swept = await portal.purgeExpired({ abandonedGraceUntil: new Date(Date.now() - 1_000).toISOString() });
    expect(swept.abandoned_sessions).toBe(1);

    const refusal = { code: 'agent_session_finished', extra: { ended_reason: 'abandoned', recovery: 'resume_native_conversation' }, message: expect.stringMatching(/abandoned.*resume the same native conversation/s) };
    await expect(messaging.self(a.sessionId, a.token)).rejects.toMatchObject(refusal);
    await expect(messaging.heartbeatSession(a.sessionId, a.token, {})).rejects.toMatchObject(refusal);
    // The ended lifecycle is never revived, not even by its own credential.
    await expect(register(native, a.sessionId, a.token)).rejects.toMatchObject({ code: 'agent_session_finished' });

    const b = await register(native, undefined, undefined, true);
    expect(b.address.id).toBe(a.address.id);
    expect(b.address.binding_generation).toBeGreaterThan(a.address.binding_generation);
    const [address] = await handle!.db.select().from(agentBusAddresses).where(eq(agentBusAddresses.id, a.address.id));
    expect(address).toMatchObject({ currentSessionId: b.sessionId, continuity: 'native', lastUpstreamSessionId: native });
    expect(await handle!.db.select().from(agentFreshStartGrants).where(eq(agentFreshStartGrants.targetAddressId, a.address.id))).toHaveLength(0);
    await expect(messaging.self(b.sessionId, b.token)).resolves.toMatchObject({ address: a.address.address, session_id: b.sessionId });
  });

  it('keeps advertised interactive suspend recovery nonterminal for one day, with an expired bridge still fenced', async () => {
    const native = randomUUID();
    const a = await register(native);
    await handle!.db.update(agentSessions).set({
      adapterCapabilities: { suspend_recovery_version: 1 },
      heartbeatAt: new Date(Date.now() - 8 * 3600_000).toISOString(),
    }).where(eq(agentSessions.id, a.sessionId));
    await lapse(a.sessionId);
    expect((await portal.purgeExpired()).abandoned_sessions).toBe(0);
    await expect(messaging.self(a.sessionId, a.token)).rejects.toMatchObject({ code: 'agent_bridge_expired' });
    await messaging.registerSession(host, { sessionId: a.sessionId, bridgeToken: a.token, engine: 'codex', username,
      cwd: '/tmp/abandoned-recovery', invocationKind: 'interactive', upstreamSessionId: native,
      requestedAddress: a.address.address, expectedBindingGeneration: a.address.binding_generation,
      adapterCapabilities: { suspend_recovery_version: 1 } });
    await expect(messaging.self(a.sessionId, a.token)).resolves.toMatchObject({ session_id: a.sessionId });
    await handle!.db.update(agentSessions).set({
      heartbeatAt: new Date(Date.now() - 25 * 3600_000).toISOString(),
    }).where(eq(agentSessions.id, a.sessionId));
    await lapse(a.sessionId);
    const longerRetention = new AgentPortalService(handle!.db, { ...loadTestEnv(), AGENT_PORTAL_RETENTION_HOURS: 72 }, testKeyring());
    expect((await longerRetention.purgeExpired()).abandoned_sessions).toBe(1);
    await expect(register(native, a.sessionId, a.token)).rejects.toMatchObject({ code: 'agent_session_finished' });
  });

  it('keeps the plain wording for a lifecycle its wrapper finished', async () => {
    const a = await register(randomUUID());
    await messaging.finishSession(a.sessionId, a.token, 'completed');
    await expect(messaging.self(a.sessionId, a.token)).rejects.toMatchObject({ code: 'agent_session_finished', extra: { ended_reason: 'finished' }, message: expect.stringMatching(/^Agent session is finished\. /) });
  });
});
