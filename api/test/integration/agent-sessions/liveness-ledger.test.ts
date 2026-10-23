import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { agentBusRelays, agentSessions, hosts } from '../../../src/db/schema.js';
import { AgentPortalService, type RegisterAgentInput } from '../../../src/services/agent-portal.js';
import { LivenessLedger, setLivenessLedger } from '../../../src/services/liveness-ledger.js';
import { getTestDb } from '../../helpers/test-db.js';
import { loadTestEnv, testKeyring } from '../../helpers/test-keyring.js';

const handle = await getTestDb();
const PREFIX = 'ztest-liveness-ledger';

describe.skipIf(!handle)('liveness ledger against MySQL', () => {
  const db = handle?.db;
  let host: typeof hosts.$inferSelect;
  let service: AgentPortalService;
  let ledger: LivenessLedger;
  const exec = async (text: string) => await db!.execute(sql.raw(text));
  const session = async (id: string) => (await db!.select().from(agentSessions).where(eq(agentSessions.id, id)))[0]!;
  const iso = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();

  const cleanup = async () => {
    await exec(`DELETE FROM agent_bus_relays WHERE host_id IN (SELECT id FROM hosts WHERE fqdn = '${PREFIX}.example')`);
    await exec(`DELETE FROM agent_events WHERE session_id IN (SELECT s.id FROM agent_sessions s JOIN hosts h ON h.id = s.host_id WHERE h.fqdn = '${PREFIX}.example')`);
    await exec(`DELETE FROM agent_sessions WHERE host_id IN (SELECT id FROM hosts WHERE fqdn = '${PREFIX}.example')`);
    await exec(`DELETE FROM hosts WHERE fqdn = '${PREFIX}.example'`);
  };

  beforeAll(async () => {
    await cleanup();
    const now = new Date().toISOString();
    await exec(`INSERT INTO hosts (fqdn, api_key, status, engines, created_at, updated_at)
      VALUES ('${PREFIX}.example', '${'c'.repeat(64)}', 'active', 'codex,claude', '${now}', '${now}')`);
    host = (await db!.select().from(hosts).where(eq(hosts.fqdn, `${PREFIX}.example`)))[0]!;
    const env = { ...loadTestEnv(), PUBLIC_BASE_URL: 'https://portal.example', AGENT_PORTAL_HEARTBEAT_FRESH_SECONDS: 45, AGENT_PORTAL_BRIDGE_TTL_SECONDS: 900 };
    service = new AgentPortalService(db!, env, testKeyring());
    await service.setEnabled(true);
    ledger = new LivenessLedger(db!, 3_600_000, (err) => { throw err; });
  });

  afterAll(async () => {
    setLivenessLedger(undefined);
    await ledger?.stop();
    await cleanup();
    await service?.setEnabled(false);
    await handle?.pool.end();
  });

  async function live() {
    const input: RegisterAgentInput = { engine: 'codex', username: 'ledger-test', cwd: '/tmp/ledger-test', invocationKind: 'interactive' };
    const registered = await service.registerAgent(host, input);
    if (!registered.enabled) throw new Error('portal disabled in fixture');
    await service.heartbeatAgent(registered.session_id, registered.bridge_token, {}, host.id);
    return registered;
  }

  it('answers a liveness-only beat from RAM and persists it in the next batch', async () => {
    const { session_id: id, bridge_token: token } = await live();
    const before = await session(id);
    ledger.start();
    setLivenessLedger(ledger);
    try {
      await new Promise((resolve) => setTimeout(resolve, 1100));
      const answer = await service.heartbeatAgent(id, token, {}, host.id);
      expect(answer).toMatchObject({ enabled: true, status: before.status });
      expect(ledger.stats().portalFast).toBe(1);
      expect((await session(id)).heartbeatAt).toBe(before.heartbeatAt);
      await ledger.flush();
      const after = await session(id);
      expect(after.heartbeatAt! > before.heartbeatAt!).toBe(true);
      expect(after.bridgeExpiresAt > before.bridgeExpiresAt).toBe(true);
      // A status change is not liveness-only: it stays transactional.
      await service.heartbeatAgent(id, token, { activeTurnId: 'turn-1' }, host.id);
      expect(ledger.stats().portalFast).toBe(1);
      expect((await session(id)).activeTurnId).toBe('turn-1');
    } finally {
      setLivenessLedger(undefined);
    }
  });

  it('never moves a timestamp backwards or touches an ended session', async () => {
    const a = await live();
    const b = await live();
    const future = iso(600_000);
    await db!.update(agentSessions).set({ heartbeatAt: future }).where(eq(agentSessions.id, a.session_id));
    await db!.update(agentSessions).set({ endedAt: iso(0) }).where(eq(agentSessions.id, b.session_id));
    const ended = await session(b.session_id);
    ledger.notePortal(a.session_id, iso(0), iso(900_000));
    ledger.notePortal(b.session_id, iso(0), iso(900_000));
    await ledger.flush();
    expect((await session(a.session_id)).heartbeatAt).toBe(future);
    const still = await session(b.session_id);
    expect(still.heartbeatAt).toBe(ended.heartbeatAt);
    expect(still.bridgeExpiresAt).toBe(ended.bridgeExpiresAt);
  });

  it('patches the receiver JSON of the same generation only', async () => {
    const { session_id: id } = await live();
    const old = iso(-20_000);
    const receiver = { generation: 'g1', native_session_id: 'n', protocol: 'codex-queue-v1', heartbeat_at: old, failure: null, probes: { peer: {} }, claim_gate: { state: 'open', observed_at: old } };
    await db!.update(agentSessions).set({ receiver, receiveHeartbeatAt: old, relayHeartbeatAt: null }).where(eq(agentSessions.id, id));
    const beat = iso(0);
    ledger.noteReceiver(id, { generation: 'g1', heartbeatAt: beat, claimGate: undefined, addressId: null });
    await ledger.flush();
    let row = await session(id);
    const json = (typeof row.receiver === 'string' ? JSON.parse(row.receiver) : row.receiver) as Record<string, unknown>;
    expect(json.heartbeat_at).toBe(beat);
    expect('claim_gate' in json).toBe(false);
    expect(json.probes).toEqual({ peer: {} });
    expect(row.receiveHeartbeatAt).toBe(beat);
    expect(row.relayHeartbeatAt).toBeNull();
    ledger.noteReceiver(id, { generation: 'g2', heartbeatAt: iso(5000), claimGate: { state: 'held_delivery' }, addressId: null });
    await ledger.flush();
    row = await session(id);
    const unchanged = (typeof row.receiver === 'string' ? JSON.parse(row.receiver) : row.receiver) as Record<string, unknown>;
    expect(unchanged.heartbeat_at).toBe(beat);
    expect(row.receiveHeartbeatAt).toBe(beat);
  });

  it('extends a relay token only for the live generation', async () => {
    const id = randomUUID();
    const now = iso(0);
    const expires = iso(300_000);
    await db!.insert(agentBusRelays).values({
      id, hostId: host.id, username: 'ledger', instanceId: randomUUID(), generation: 2, tokenHash: 'd'.repeat(64),
      tokenExpiresAt: expires, hostAuthFingerprint: 'e'.repeat(64), wrapperVersion: '0.9.121', heartbeatAt: now, createdAt: now, updatedAt: now,
    });
    ledger.noteRelay(id, { generation: 1, heartbeatAt: iso(1000), tokenExpiresAt: iso(900_000) });
    await ledger.flush();
    expect((await db!.select().from(agentBusRelays).where(eq(agentBusRelays.id, id)))[0]!.tokenExpiresAt).toBe(expires);
    const later = iso(900_000);
    ledger.noteRelay(id, { generation: 2, heartbeatAt: iso(1000), tokenExpiresAt: later });
    await ledger.flush();
    expect((await db!.select().from(agentBusRelays).where(eq(agentBusRelays.id, id)))[0]!.tokenExpiresAt).toBe(later);
  });
});
