import { createHash, randomUUID } from 'node:crypto';
import { and, eq, inArray, or, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  advisorSessions,
  agentBusAddresses,
  agentBusConversations,
  agentBusMessages,
  agentSessions,
  hostDaemonSessions,
  hosts,
} from '../../../src/db/schema.js';
import { HostDaemonService } from '../../../src/services/host-daemon/service.js';
import { daemonSettingsSchema } from '../../../src/services/host-daemon/policy.js';
import { AdvisorService, advisorConfigured } from '../../../src/services/advisor.js';
import { parseAdvisorVerdict } from '../../../src/services/advisor-delivery.js';
import { decrypt } from '../../../src/security/secret-box.js';
import { getTestDb } from '../../helpers/test-db.js';
import { loadTestEnv, testKeyring } from '../../helpers/test-keyring.js';

const handle = await getTestDb();
const stamp = () => new Date().toISOString();

describe('parseAdvisorVerdict', () => {
  it('takes the last valid fenced verdict and ignores other blocks', () => {
    const reply = 'Looks fine.\n```json\n{"not":"a verdict"}\n```\n```json\n{"verdict":"agree","tier":3,"summary":"Ship it."}\n```';
    expect(parseAdvisorVerdict(reply)).toEqual({ verdict: 'agree', tier: 3, summary: 'Ship it.' });
    expect(parseAdvisorVerdict('no block')).toBeNull();
  });
});

describe.skipIf(!handle)('Fleet Advisor over the host daemon', () => {
  // describe.skipIf still evaluates this body; build the context only with a database.
  const ctx = handle ? { db: handle.db, env: loadTestEnv(), keyring: testKeyring() } : (null as never);
  let hostId: number, generation: string, daemon: HostDaemonService, advisor: AdvisorService;
  let callerAddress: string, caller: { session: typeof agentSessions.$inferSelect; host: typeof hosts.$inferSelect };

  const created: string[] = [];
  const insertAddress = async (launchName: string) => {
    const id = randomUUID();
    created.push(id);
    await handle!.db.insert(agentBusAddresses).values({
      id,
      address: `agent:${id}`,
      launchName,
      hostId,
      engine: 'codex',
      username: 'root',
      cwd: '/tmp',
      cwdHash: createHash('sha256').update('/tmp').digest('hex'),
      lastUpstreamSessionId: null,
      lastSeenAt: stamp(),
      createdAt: stamp(),
      updatedAt: stamp(),
    });
    return id;
  };
  const insertNative = async (addressId: string | null) => {
    const id = randomUUID();
    await handle!.db.insert(agentSessions).values({
      id,
      hostId,
      engine: 'codex',
      username: 'root',
      cwd: '/tmp',
      invocationKind: 'execute',
      hostAuthFingerprint: 'a'.repeat(64),
      bridgeTokenHash: createHash('sha256').update(id).digest('hex'),
      bridgeExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      agentBusAddressId: addressId,
      startedAt: stamp(),
      heartbeatAt: stamp(),
      createdAt: stamp(),
      updatedAt: stamp(),
    });
    return (await handle!.db.select().from(agentSessions).where(eq(agentSessions.id, id)))[0]!;
  };
  const inbox = () =>
    handle!.db
      .select()
      .from(agentBusMessages)
      .where(eq(agentBusMessages.targetAddressId, callerAddress))
      .orderBy(agentBusMessages.createdAt, agentBusMessages.sequence);

  beforeAll(async () => {
    const fqdn = `advisor-${randomUUID()}.test`;
    await handle!.db.insert(hosts).values({
      fqdn,
      apiKey: 'e'.repeat(64),
      apiKeyHash: createHash('sha256').update(fqdn).digest('hex'),
      reverseDnsMode: 0,
      engines: 'codex,claude,grok',
      secure: 1,
      agentMessagingEnabled: 1,
      authDigest: 'test',
      claudeAuthDigest: 'test',
      grokAuthDigest: 'test',
      status: 'active',
      createdAt: stamp(),
      updatedAt: stamp(),
    });
    hostId = (await handle!.db.select().from(hosts).where(eq(hosts.fqdn, fqdn)))[0]!.id;
    await handle!.db.execute(
      sql`INSERT INTO versions (name,version,updated_at) VALUES ('agent_messaging_enabled','1',${stamp()}) ON DUPLICATE KEY UPDATE version='1'`,
    );
    daemon = new HostDaemonService(ctx);
    advisor = new AdvisorService(ctx);
    await daemon.configure(hostId, daemonSettingsSchema.parse({ enabled: true, max_parallel: 2, default_cwd: '/work' }));
    generation = (
      await daemon.connect(hostId, { instance_id: randomUUID(), username: 'root', version: 'test', engines: ['codex'], error: null })
    ).generation;
    callerAddress = await insertAddress('Caller');
    caller = { session: await insertNative(callerAddress), host: await daemon.host(hostId) };
  });
  afterAll(async () => {
    // Other suites count bus rows globally (master-off cancel totals); leave none behind.
    await handle!.db.delete(advisorSessions).where(eq(advisorSessions.hostId, hostId));
    await handle!.db.delete(agentBusMessages).where(or(inArray(agentBusMessages.senderAddressId, created), inArray(agentBusMessages.targetAddressId, created)));
    await handle!.db.delete(agentBusConversations).where(or(inArray(agentBusConversations.addressAId, created), inArray(agentBusConversations.addressBId, created)));
    await handle!.db.delete(agentSessions).where(eq(agentSessions.hostId, hostId));
    await handle!.db.delete(agentBusAddresses).where(inArray(agentBusAddresses.id, created));
    await handle!.db.delete(hosts).where(eq(hosts.id, hostId));
    await handle!.db.execute(sql`DELETE FROM versions WHERE name = 'advisor_settings'`);
    await handle!.pool.end();
  });

  // One daemon round trip: offer, accept, bind (first turn only), complete.
  const runTurn = async (reply: string, advisorAddress?: string) => {
    const op = (await daemon.offer(hostId, generation))!;
    expect(op).toBeTruthy();
    await daemon.accept(hostId, op.operation_id, op.claim_id);
    let address = advisorAddress;
    if (!address) {
      address = await insertAddress('Advisor');
      const native = await insertNative(address);
      await daemon.bind(hostId, op.operation_id, op.claim_id, native.id, address);
    }
    await daemon.complete(hostId, op.operation_id, op.claim_id, {
      status: 'completed',
      reply,
      upstream_session_id: `upstream-${address}`,
    });
    return address;
  };

  it('stays hidden from guidance and refuses asks until an operator enables it', async () => {
    expect(await advisorConfigured(handle!.db)).toEqual({ enabled: false, reason: 'advisor_disabled' });
    await expect(
      advisor.ask(caller, { question: 'Is this safe?', client_message_id: randomUUID() }),
    ).rejects.toMatchObject({ code: 'advisor_unavailable' });
    await advisor.configure({ enabled: true, host_id: hostId, engine: 'codex' });
    expect(await advisorConfigured(handle!.db)).toEqual({ enabled: true, reason: 'ok' });
  });

  it('answers, follows up, records the verdict and closes on done', async () => {
    const clientId = randomUUID();
    const opened = await advisor.ask(caller, { question: 'Verify this fix', kind: 'verify', client_message_id: clientId });
    expect(opened).toMatchObject({ status: 'starting', kind: 'verify', turns: 0 });
    // A retried ask returns the same advisor instead of opening a second one.
    expect((await advisor.ask(caller, { question: 'Verify this fix', kind: 'verify', client_message_id: clientId })).advisor_session_id)
      .toBe(opened.advisor_session_id);

    const advisorAddress = await runTurn('Looks right.\n```json\n{"verdict":"agree","summary":"Correct."}\n```');
    let messages = await inbox();
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ senderAddressId: advisorAddress, deliveryClass: 'coordination', status: 'queued' });
    const first = decrypt(messages[0]!.contentEnc, ctx.keyring);
    expect(first).toContain(`ADVISOR/1 advisor_session_id=${opened.advisor_session_id} turn=1 kind=verify`);
    expect(first).toContain('advisor_close');
    let status = await advisor.status(caller, { advisor_session_id: opened.advisor_session_id });
    expect(status).toMatchObject({ status: 'open', turns: 1, verdict: { verdict: 'agree' }, advisor_address: `agent:${advisorAddress}` });

    const follow = await advisor.ask(caller, {
      question: 'And the edge case?',
      advisor_session_id: opened.advisor_session_id,
      client_message_id: randomUUID(),
    });
    expect(follow).toMatchObject({ asked: true, busy: true });
    await expect(
      advisor.ask(caller, { question: 'Again?', advisor_session_id: opened.advisor_session_id, client_message_id: randomUUID() }),
    ).rejects.toMatchObject({ code: 'advisor_busy' });
    await runTurn('Edge case missed.\n```json\n{"verdict":"disagree","summary":"Null input."}\n```', advisorAddress);
    messages = await inbox();
    expect(messages).toHaveLength(2);
    // Every turn speaks in the one conversation the first answer opened.
    expect(messages[1]!.conversationId).toBe(messages[0]!.conversationId);
    expect(messages[1]!.sequence).toBe(2);
    expect(decrypt(messages[1]!.contentEnc, ctx.keyring)).toContain('turn=2');

    const closed = await advisor.close(caller, { advisor_session_id: opened.advisor_session_id });
    expect(closed).toMatchObject({ closed: true, status: 'closed', close_reason: 'done', verdict: { verdict: 'disagree' } });
    await expect(
      advisor.ask(caller, { question: 'One more', advisor_session_id: opened.advisor_session_id, client_message_id: randomUUID() }),
    ).rejects.toMatchObject({ code: 'advisor_closed' });
    status = await advisor.status(caller, {});
    expect((status as { advisors: unknown[] }).advisors.length).toBeGreaterThanOrEqual(1);
  });

  it('refuses strangers and advisors calling advisors', async () => {
    const opened = await advisor.ask(caller, { question: 'Classify', kind: 'classify', client_message_id: randomUUID() });
    const advisorAddress = await runTurn('Config drift.');
    const strangerAddress = await insertAddress('Stranger');
    const stranger = { session: await insertNative(strangerAddress), host: caller.host };
    await expect(advisor.close(stranger, { advisor_session_id: opened.advisor_session_id })).rejects.toMatchObject({ status: 403 });
    const self = { session: await insertNative(advisorAddress), host: caller.host };
    await expect(
      advisor.ask(self, { question: 'Help me', client_message_id: randomUUID() }),
    ).rejects.toMatchObject({ code: 'advisor_recursion' });
    await advisor.close(caller, { advisor_session_id: opened.advisor_session_id });
  });

  it('tells the caller when the idle sweep closes an advisor', async () => {
    const opened = await advisor.ask(caller, { question: 'Tier?', kind: 'tier_check', client_message_id: randomUUID() });
    await runTurn('Tier 3.\n```json\n{"verdict":"n/a","tier":3,"summary":"Concurrency."}\n```');
    const before = (await inbox()).length;
    const [row] = await handle!.db.select().from(advisorSessions).where(eq(advisorSessions.id, opened.advisor_session_id));
    await handle!.db
      .update(hostDaemonSessions)
      .set({ lastActivityAt: new Date(Date.now() - 2 * 3_600_000).toISOString() })
      .where(eq(hostDaemonSessions.id, row!.daemonSessionId));
    await daemon.sweep(hostId);
    const after = await inbox();
    expect(after).toHaveLength(before + 1);
    const notice = after.at(-1)!;
    expect(notice.deliveryClass).toBe('notice');
    expect(decrypt(notice.contentEnc, ctx.keyring)).toContain('closed reason=idle');
    expect(await advisor.status(caller, { advisor_session_id: opened.advisor_session_id })).toMatchObject({
      status: 'closed',
      close_reason: 'idle',
      verdict: { tier: 3 },
    });
  });

  it('rejects new asks with advisor_busy when every slot is taken', async () => {
    const [a, b] = [randomUUID(), randomUUID()];
    await advisor.ask(caller, { question: 'one', client_message_id: a });
    await advisor.ask(caller, { question: 'two', client_message_id: b });
    await expect(
      advisor.ask(caller, { question: 'three', client_message_id: randomUUID() }),
    ).rejects.toMatchObject({ code: 'advisor_busy' });
    const rows = await handle!.db
      .select()
      .from(advisorSessions)
      .where(and(eq(advisorSessions.callerAddressId, callerAddress), eq(advisorSessions.status, 'starting')));
    for (const row of rows) await advisor.close(caller, { advisor_session_id: row.id });
  });
});
