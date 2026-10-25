import { randomBytes, randomUUID } from 'node:crypto';
import mysql from 'mysql2/promise';
import { drizzle } from 'drizzle-orm/mysql2';
import { eq, inArray, or } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../../../src/db/schema.js';
import { AgentMessagingService, AGENT_MESSAGING_ENABLED_KEY } from '../../../src/services/agent-messaging.js';
import { advisorTurnCompleted } from '../../../src/services/advisor-delivery.js';
import { AgentReceiverService } from '../../../src/services/agent-receiver.js';
import { invalidateFleetEngineState } from '../../../src/services/engine-switch.js';
import { ENGINES, type Engine } from '../../../src/util/engine.js';
import { readDbConfig } from '../../helpers/test-db.js';
import { loadTestEnv, testKeyring } from '../../helpers/test-keyring.js';

const config = readDbConfig();
const protocols = { codex: 'codex-queue-v1', claude: 'claude-channel-v1', grok: 'grok-acp-v1' } as const;

describe.skipIf(!config)('smart queue delivery on real MySQL', { timeout: 30_000 }, () => {
  const pool = mysql.createPool({ ...config, connectionLimit: 4 });
  const db = drizzle(pool, { schema, mode: 'default' });
  const env = { ...loadTestEnv(), CXX_QUEUE_DELIVERY_V1_ENABLED: true, CXX_QUEUE_DELIVERY_V1_HOST_IDS: '' };
  const service = new AgentMessagingService(db, env, testKeyring());
  const receiver = new AgentReceiverService(db, env, testKeyring());
  let host: typeof schema.hosts.$inferSelect;
  const prior = new Map<string, string | undefined>();
  const flagNames = [AGENT_MESSAGING_ENABLED_KEY, ...ENGINES.map((e) => `${e}_engine_disabled`)];

  async function flag(name: string, value: string) {
    await db
      .insert(schema.versions)
      .values({ name, version: value, updatedAt: new Date().toISOString() })
      .onDuplicateKeyUpdate({ set: { version: value } });
    invalidateFleetEngineState(db);
  }
  beforeAll(async () => {
    for (const name of flagNames)
      prior.set(
        name,
        (await db.select().from(schema.versions).where(eq(schema.versions.name, name)))[0]?.version ??
          undefined,
      );
    const fqdn = `session-idle-${randomUUID()}.test`,
      now = new Date().toISOString();
    await db.insert(schema.hosts).values({
      fqdn,
      apiKey: randomBytes(32).toString('hex'),
      status: 'active',
      secure: 1,
      engines: ENGINES.join(','),
      createdAt: now,
      updatedAt: now,
    });
    host = (await db.select().from(schema.hosts).where(eq(schema.hosts.fqdn, fqdn)))[0]!;
  });
  beforeEach(async () => {
    env.CXX_QUEUE_DELIVERY_V1_ENABLED = true;
    env.CXX_QUEUE_DELIVERY_V1_HOST_IDS = '';
    await flag(AGENT_MESSAGING_ENABLED_KEY, '1');
    for (const engine of ENGINES) await flag(`${engine}_engine_disabled`, '0');
    await db.update(schema.hosts).set({ status: 'active' }).where(eq(schema.hosts.id, host.id));
  });
  afterAll(async () => {
    if (host) {
      const addresses = await db
        .select()
        .from(schema.agentBusAddresses)
        .where(eq(schema.agentBusAddresses.hostId, host.id));
      const ids = addresses.map((a) => a.id);
      if (ids.length) {
        await db
          .delete(schema.agentBusMessages)
          .where(
            or(
              inArray(schema.agentBusMessages.targetAddressId, ids),
              inArray(schema.agentBusMessages.senderAddressId, ids),
            ),
          );
        await db
          .delete(schema.agentBusConversations)
          .where(
            or(
              inArray(schema.agentBusConversations.addressAId, ids),
              inArray(schema.agentBusConversations.addressBId, ids),
            ),
          );
      }
      await db.delete(schema.agentSessions).where(eq(schema.agentSessions.hostId, host.id));
      await db.delete(schema.agentBusAddresses).where(eq(schema.agentBusAddresses.hostId, host.id));
      await db.delete(schema.logs).where(eq(schema.logs.hostId, host.id));
      await db.delete(schema.hosts).where(eq(schema.hosts.id, host.id));
    }
    for (const [name, value] of prior) {
      if (value === undefined) await db.delete(schema.versions).where(eq(schema.versions.name, name));
      else await flag(name, value);
    }
    await pool.end();
  });

  async function peer(engine: Engine = 'codex', capable = true, batch = false, timing = false) {
    const id = randomUUID(),
      token = randomBytes(32).toString('base64url'),
      generation = randomUUID(),
      native = randomUUID();
    const result = await service.registerSession(host, {
      engine,
      username: randomUUID(),
      cwd: '/tmp/session-idle',
      invocationKind: 'interactive',
      sessionId: id,
      bridgeToken: token,
      upstreamSessionId: native,
      adapterCapabilities: { execution_contract_version: 2 },
    });
    const address = result.address as { id: string; address: string };
    await receiver.register(id, token, {
      generation,
      protocol: protocols[engine],
      native_session_id: native,
      capabilities: capable ? { delivery_timing_v1: timing, queue_delivery_v1: true, ...(batch ? { peer_batch_v1: true } : {}) } : undefined,
    });
    return { id, token, generation, address: address.address, addressId: address.id };
  }
  type Peer = Awaited<ReturnType<typeof peer>>;
  async function send(
    source: Peer,
    target: Peer,
    content: string,
    extra: Partial<Parameters<typeof service.sendMessage>[2]> = {},
  ) {
    return (await service.sendMessage(source.id, source.token, {
      to: target.address,
      content,
      clientMessageId: randomUUID(),
      ...extra,
    })) as { message: { id: string } };
  }
  async function claim(p: Peer, id = randomUUID(), info = false) {
    return service.claimForSession(p.id, p.token, id, p.generation, info);
  }
  async function ack(
    p: Peer,
    d: NonNullable<Awaited<ReturnType<typeof claim>>>,
    outcome: 'accepted' | 'completed',
  ) {
    return service.acknowledgeSessionDelivery(p.id, p.token, d.message_id, { claimId: d.claim_id, outcome });
  }
  for (const engine of ENGINES) {
    it(`${engine}: immediate timing preserves active work and atomically caps concurrent informational claims`, async () => {
      const source = await peer(), target = await peer(engine, true, false, true);
      await send(source, target, 'held task', { kind: 'request' });
      const held = (await claim(target))!;
      await ack(target, held, 'accepted');
      const deferred = await send(source, target, 'after current turn');
      const clientId = randomUUID();
      const first = await send(source, target, 'show during current turn', {
        clientMessageId: clientId, queue: { delivery_timing: 'immediate' },
      });
      await send(source, target, 'second immediate', { queue: { delivery_timing: 'immediate' } });
      await expect(send(source, target, 'show during current turn', { clientMessageId: clientId,
        queue: { delivery_timing: 'after_turn' } })).rejects.toMatchObject({ code: 'agent_messaging_idempotency_conflict' });
      await expect(send(source, target, 'no parallel task', { kind: 'request', queue: { delivery_timing: 'immediate' } })).rejects.toThrow();
      const attempts = await Promise.all([1, 2].map(() => service.claimForSession(target.id, target.token,
        randomUUID(), target.generation, true, true)));
      expect(attempts.filter(Boolean)).toHaveLength(1);
      const immediate = attempts.find(Boolean)!;
      expect(immediate.message_id).toBe(first.message.id);
      expect(immediate.delivery_timing).toBe('immediate');
      expect((await db.select().from(schema.agentBusMessages).where(eq(schema.agentBusMessages.id, held.message_id)))[0]?.status).toBe('accepted');
      expect((await db.select().from(schema.agentBusMessages).where(eq(schema.agentBusMessages.id, deferred.message.id)))[0]?.status).toBe('queued');
    });
    it(`${engine}: unnegotiated immediate remains durable without blocking after-turn work`, async () => {
      const source = await peer(), target = await peer(engine, false);
      const receipt = await service.sendMessage(source.id, source.token, { to: target.address, content: 'wait for capability',
        clientMessageId: randomUUID(), queue: { delivery_timing: 'immediate' } });
      expect(receipt).toMatchObject({ requested_delivery_timing: 'immediate', effective_delivery_timing: null,
        timing_fallback_reason: 'receiver_capability_missing' });
      const ordinary = await send(source, target, 'ordinary work', { kind: 'request' });
      expect((await claim(target))?.message_id).toBe(ordinary.message.id);
      expect((await db.select().from(schema.agentBusMessages).where(eq(schema.agentBusMessages.id, (receipt.message as { id: string }).id)))[0]).toMatchObject({ status: 'queued', deliveryTiming: 'immediate' });
    });
  }

  it('holds immediate progress until its explicitly related work has been admitted', async () => {
    const source = await peer(), target = await peer('codex', true, false, true);
    const work = await send(source, target, 'causal work', { kind: 'request' });
    const progress = await send(source, target, 'causal immediate progress', { queue: {
      delivery_timing: 'immediate', delivery_class: 'progress', related_work_id: work.message.id } });
    expect(await service.claimForSession(target.id, target.token, randomUUID(), target.generation, true, true)).toBeNull();
    const admitted = (await claim(target))!;
    expect(admitted.message_id).toBe(work.message.id);
    await ack(target, admitted, 'accepted');
    expect((await service.claimForSession(target.id, target.token, randomUUID(), target.generation, true, true))?.message_id).toBe(progress.message.id);
  });

  it('does not coalesce identical progress keys across delivery timing', async () => {
    const source = await peer(), target = await peer('codex', true, false, true);
    const first = await send(source, target, 'after turn progress', { queue: { delivery_class: 'progress', coalesce_key: 'same' } });
    const immediate = await send(source, target, 'immediate progress', { queue: { delivery_class: 'progress', coalesce_key: 'same', delivery_timing: 'immediate' } });
    const rows = await db.select().from(schema.agentBusMessages).where(inArray(schema.agentBusMessages.id, [first.message.id, immediate.message.id]));
    expect(rows.map(row => row.status)).toEqual(['queued', 'queued']);
    expect(new Set(rows.map(row => row.deliveryTiming))).toEqual(new Set(['after_turn', 'immediate']));
  });
  it('keeps immediate originals outside after-turn peer digests', async () => {
    const source = await peer(), target = await peer('codex', true, true, true);
    const deferred = [], immediate = [];
    for (let n = 0; n < 2; n++) {
      deferred.push((await send(source, target, `deferred ${n}`)).message.id);
      immediate.push((await send(source, target, `immediate ${n}`, { queue: { delivery_timing: 'immediate' } })).message.id);
    }
    await db.update(schema.agentBusMessages).set({ createdAt: '2026-01-01T00:00:00Z' }).where(eq(schema.agentBusMessages.targetAddressId, target.addressId));
    const digest = (await claim(target))!;
    expect(digest).toMatchObject({ kind: 'digest', delivery_timing: 'after_turn' });
    expect(JSON.parse(digest.content).entries.map((entry: { message_id: string }) => entry.message_id)).toEqual(deferred);
    const originals = await db.select().from(schema.agentBusMessages).where(inArray(schema.agentBusMessages.id, immediate));
    expect(originals.every(row => row.status === 'queued' && row.deliveryTiming === 'immediate')).toBe(true);
  });

  it('batches eight actual Advisor completion hooks without dropping any turn', async () => {
    env.CXX_QUEUE_DELIVERY_V1_ENABLED = false;
    const source = await peer(), target = await peer('codex', true, true);
    const advisorId = randomUUID(), daemonId = randomUUID(), now = new Date().toISOString();
    await db.insert(schema.advisorSessions).values({ id: advisorId, callerAddressId: target.addressId,
      clientKey: randomUUID(), daemonSessionId: daemonId, hostId: host.id, kind: 'verify', status: 'open', createdAt: now, updatedAt: now });
    try {
      const session = { id: daemonId, addressId: source.addressId } as typeof schema.hostDaemonSessions.$inferSelect;
      for (let turn = 1; turn <= 8; turn++) await db.transaction(tx => advisorTurnCompleted(tx, testKeyring(), session,
        { status: 'completed', reply: `Advisor full answer ${turn}\nWhich target needs verification?` }, 'idle', 30));
      await db.update(schema.agentBusMessages).set({ createdAt: '2026-01-01T00:00:00Z' }).where(eq(schema.agentBusMessages.targetAddressId, target.addressId));
      const d = (await claim(target))!;
      expect(d.kind).toBe('digest');
      const entries = JSON.parse(d.content).entries;
      expect(entries).toHaveLength(8);
      expect(entries.every((e: { delivery_class: string }) => e.delivery_class === 'coordination')).toBe(true);
      entries.forEach((e: { content: string }, i: number) => {
        expect(e.content).toContain(`turn=${i + 1}`); expect(e.content).toContain(`Advisor full answer ${i + 1}`);
        expect(e.content).toContain('Which target needs verification?');
      });
      await ack(target, d, 'accepted'); await ack(target, d, 'completed');
      expect((await service.getDigest(target.id, target.token, d.message_id)).messages).toHaveLength(8);
      expect(await claim(target)).toBeNull();
    } finally { await db.delete(schema.advisorSessions).where(eq(schema.advisorSessions.id, advisorId)); }
  });

  it('keeps an earlier work result ahead of a mixed batch with later coordination', async () => {
    env.CXX_QUEUE_DELIVERY_V1_ENABLED = false;
    const source = await peer(), target = await peer('codex', true, true);
    const request = await send(target, source, 'work', { kind: 'request' });
    const held = (await claim(source))!; await ack(source, held, 'accepted');
    await send(source, target, 'old information');
    await service.replyMessage(source.id, source.token, request.message.id, { content: 'Result', claimId: held.claim_id,
      clientMessageId: randomUUID(), taskResult: { status: 'succeeded', summary: 'Result' } });
    await send(source, target, 'later question?', { queue: { delivery_class: 'coordination' } });
    await db.update(schema.agentBusMessages).set({ createdAt: '2026-01-01T00:00:00Z' }).where(eq(schema.agentBusMessages.targetAddressId, target.addressId));
    const first = (await claim(target))!;
    expect(first.reply_to_message_id).toBe(request.message.id); expect(first.kind).toBe('reply');
    await ack(target, first, 'accepted'); await ack(target, first, 'completed');
    const batch = (await claim(target))!; expect(batch.kind).toBe('digest');
    expect(JSON.parse(batch.content).entries).toHaveLength(2);
    await ack(target, batch, 'accepted'); await ack(target, batch, 'completed');
  });

  it('paginates oversized entries without truncation and restores unpresented batches on rollback', async () => {
    env.CXX_QUEUE_DELIVERY_V1_ENABLED = false;
    const source = await peer(), target = await peer('codex', true, true);
    const large = await send(source, target, 'x'.repeat(13000));
    const queue = { delivery_class: 'coordination' as const };
    const one = await send(source, target, 'one', { queue }), two = await send(source, target, 'two', { queue });
    await db.update(schema.agentBusMessages).set({ createdAt: '2026-01-01T00:00:00Z' }).where(eq(schema.agentBusMessages.targetAddressId, target.addressId));
    const batch = (await claim(target))!; expect(batch.kind).toBe('digest');
    expect(JSON.parse(batch.content)).toMatchObject({ entries: [], total: 3, next_after: 0 });
    const retained = await service.getDigest(target.id, target.token, batch.message_id);
    expect((retained.messages as Array<Record<string, unknown>>)[0]).toMatchObject({ id: large.message.id, content: 'x'.repeat(13000) });
    // Certainly unpresented lease expiration, then turn the new presentation policy off.
    await db.update(schema.agentBusMessages).set({ status: 'queued', leaseOwner: null, claimId: null, leaseUntil: null }).where(eq(schema.agentBusMessages.id, batch.message_id));
    env.CXX_PEER_BATCH_V1_ENABLED = false;
    env.CXX_QUEUE_DELIVERY_V1_ENABLED = true; // Preview digests remain enabled on rollback.
    try {
      const first = (await claim(target))!; expect(first.message_id).toBe(one.message.id);
      await ack(target, first, 'accepted'); await ack(target, first, 'completed');
      const second = (await claim(target))!; expect(second.message_id).toBe(two.message.id);
      await ack(target, second, 'accepted'); await ack(target, second, 'completed');
      const last = (await claim(target))!;
      expect(((await service.getDigest(target.id, target.token, last.message_id)).messages as Array<Record<string, unknown>>)[0]).toMatchObject({ content: 'x'.repeat(13000) });
      await ack(target, last, 'accepted'); await ack(target, last, 'completed');
      expect(await claim(target)).toBeNull();
    } finally { env.CXX_PEER_BATCH_V1_ENABLED = true; }
  });

  for (const engine of ENGINES) {
    it(`${engine}: reproduces eleven separate legacy turns and batches the full stale backlog once`, async () => {
      env.CXX_QUEUE_DELIVERY_V1_ENABLED = false;
      const source = await peer(engine), legacy = await peer(engine), target = await peer(engine, true, true);
      const ids: string[] = [];
      const contents = Array.from({ length: 11 }, (_, i) => i === 7
        ? 'ADVISOR/1 advisor_session_id=retained turn=1 kind=verify\n' + 'Complete evidence. '.repeat(30)
        : i === 5 ? 'Question: which deployment should I verify?' : `Closing status ${i}`);
      for (const [i, content] of contents.entries()) {
        const queue = { delivery_class: i % 2 ? 'coordination' as const : 'information' as const };
        await send(source, legacy, content, { queue });
        ids.push((await send(source, target, content, { queue })).message.id);
      }
      await db.update(schema.agentBusMessages).set({ createdAt: '2026-01-01T00:00:00Z' })
        .where(inArray(schema.agentBusMessages.targetAddressId, [legacy.addressId, target.addressId]));
      let legacyTurns = 0;
      for (let d = await claim(legacy); d; d = await claim(legacy)) {
        expect(d.kind).not.toBe('digest');
        await ack(legacy, d, 'accepted'); await ack(legacy, d, 'completed'); legacyTurns++;
      }
      expect(legacyTurns).toBe(11);
      const d = (await claim(target))!;
      expect(d.kind).toBe('digest');
      const body = JSON.parse(d.content);
      expect(body.presentation).toBe('peer_batch_v1');
      expect(body.entries.map((e: { message_id: string }) => e.message_id)).toEqual(ids);
      expect(body.entries.map((e: { content: string }) => e.content)).toEqual(contents);
      await ack(target, d, 'accepted');
      // Reply to the original actionable question while the single presentation is held.
      await service.replyMessage(target.id, target.token, ids[5]!, { content: 'Verify staging.', clientMessageId: randomUUID() });
      expect((await service.getDigest(target.id, target.token, d.message_id)).messages).toHaveLength(11);
      await ack(target, d, 'completed');
      expect(await claim(target)).toBeNull();
      const rows = await db.select().from(schema.agentBusMessages).where(inArray(schema.agentBusMessages.id, ids));
      expect(rows.every(m => m.status === 'digested' && m.attempts === 0 && !m.completedAt)).toBe(true);
    });

    it(`${engine}: full batches preserve held work, unbatched work results, and coordination FIFO`, async () => {
      env.CXX_QUEUE_DELIVERY_V1_ENABLED = false;
      const source = await peer(engine), target = await peer(engine, true, true);
      const request = await send(source, target, 'accepted task', { kind: 'request' });
      const held = (await claim(target))!; await ack(target, held, 'accepted');
      const ids: string[] = [];
      for (let i = 0; i < 21; i++) ids.push((await send(source, target, `coordination ${i}`, { queue: { delivery_class: 'coordination' } })).message.id);
      await db.update(schema.agentBusMessages).set({ createdAt: '2026-01-01T00:00:00Z' }).where(inArray(schema.agentBusMessages.id, ids));
      const batch = (await claim(target, randomUUID(), true))!;
      expect(batch.kind).toBe('digest');
      expect(JSON.parse(batch.content).entries.map((e: { message_id: string }) => e.message_id)).toEqual(ids.slice(0, 20));
      await ack(target, batch, 'accepted');
      const rest = await service.getDigest(target.id, target.token, batch.message_id, JSON.parse(batch.content).next_after);
      expect(rest.messages).toHaveLength(1);
      await ack(target, batch, 'completed');
      expect((await service.getMessage(target.id, target.token, request.message.id)).message).toMatchObject({ status: 'accepted' });
      expect(await claim(target, randomUUID(), true)).toBeNull();
      await service.replyMessage(target.id, target.token, request.message.id, { content: 'done', claimId: held.claim_id,
        clientMessageId: randomUUID(), taskResult: { status: 'succeeded', summary: 'verified' } });
      const result = (await claim(source))!;
      expect(result.kind).toBe('reply'); expect(result.reply_to_message_id).toBe(request.message.id);
    });
  }

  for (const engine of ENGINES) {
    it(`${engine}: seven stale updates are one retrievable digest`, async () => {
      const source = await peer(engine),
        target = await peer(engine),
        ids: string[] = [];
      for (let i = 0; i < 7; i++) ids.push((await send(source, target, `original ${i}`)).message.id);
      await db
        .update(schema.agentBusMessages)
        .set({ createdAt: '2026-01-01T00:00:00Z' })
        .where(inArray(schema.agentBusMessages.id, ids));
      const d = (await claim(target))!;
      expect(d.kind).toBe('digest');
      const body = JSON.parse(d.content);
      expect(body.entries.map((e: { message_id: string }) => e.message_id)).toEqual(ids);
      expect(body.remaining).toBe(0);
      await ack(target, d, 'accepted');
      expect((await service.getDigest(target.id, target.token, d.message_id)).messages).toHaveLength(7);
      await expect(service.getDigest(source.id, source.token, d.message_id)).rejects.toMatchObject({
        status: 404,
      });
      await ack(target, d, 'completed');
      await ack(target, d, 'completed');
      const originals = await db
        .select()
        .from(schema.agentBusMessages)
        .where(inArray(schema.agentBusMessages.id, ids));
      expect(
        originals.every(
          (x) => x.status === 'digested' && x.presentedAt && !x.completedAt && x.attempts === 0,
        ),
      ).toBe(true);
      expect(await claim(target)).toBeNull();
      expect(
        ((await service.getMessage(target.id, target.token, ids[0]!)).message as { content: string }).content,
      ).toBe('original 0');
      await expect(
        service.replyMessage(target.id, target.token, ids[0]!, {
          content: 'substantive answer',
          clientMessageId: randomUUID(),
        }),
      ).resolves.toBeDefined();
    });
    it(`${engine}: approval passes held work and does not start the next task`, async () => {
      const source = await peer(engine),
        target = await peer(engine);
      const first = await send(source, target, 'first task', { kind: 'request' });
      const work = (await claim(target))!;
      await ack(target, work, 'accepted');
      const second = await send(source, target, 'second task', { kind: 'request' });
      await send(source, target, 'old progress');
      const approval = await send(source, target, 'APPROVED full text', {
        queue: { delivery_class: 'coordination', related_work_id: first.message.id },
      });
      const d = (await claim(target, randomUUID(), true))!;
      expect(d.message_id).toBe(approval.message.id);
      expect(d.content).toBe('APPROVED full text');
      await ack(target, d, 'accepted');
      await ack(target, d, 'completed');
      const [held] = await db
        .select()
        .from(schema.agentBusMessages)
        .where(eq(schema.agentBusMessages.id, first.message.id));
      const [waiting] = await db
        .select()
        .from(schema.agentBusMessages)
        .where(eq(schema.agentBusMessages.id, second.message.id));
      expect(held?.status).toBe('accepted');
      expect(waiting?.status).toBe('queued');
      expect(waiting?.attempts).toBe(0);
    });
  }
  it('counts repeated keyed notices once per event, not per transport retry', async () => {
    const source = await peer(),
      target = await peer(),
      clientMessageId = randomUUID();
    const queue = { delivery_class: 'notice' as const, coalesce_key: 'watchdog:one:capacity' };
    const first = await send(source, target, 'tick one', { clientMessageId, queue });
    expect((await send(source, target, 'tick one', { clientMessageId, queue })).message.id).toBe(
      first.message.id,
    );
    await expect(
      send(source, target, 'tick one', {
        clientMessageId,
        queue: { delivery_class: 'progress', coalesce_key: 'different' },
      }),
    ).rejects.toMatchObject({ status: 409 });
    const latest = await send(source, target, 'latest', { queue });
    const d = (await claim(target))!;
    const body = JSON.parse(d.content);
    expect(body.entries).toHaveLength(1);
    expect(body.entries[0]).toMatchObject({
      message_id: latest.message.id,
      event_count: 2,
      preview: 'latest',
    });
    const [old] = await db
      .select()
      .from(schema.agentBusMessages)
      .where(eq(schema.agentBusMessages.id, first.message.id));
    expect(old?.status).toBe('superseded');
    expect(old?.supersededById).toBe(latest.message.id);
  });
  for (const capable of [false, true])
    it(`supersedes a still-pending keyed update at send time (queue_delivery_v1 ${capable ? 'on' : 'off'})`, async () => {
      env.CXX_QUEUE_DELIVERY_V1_ENABLED = capable;
      const source = await peer(),
        target = await peer('codex', capable);
      const queue = { delivery_class: 'progress' as const, coalesce_key: 'build:send-time:compile' };
      const v1 = await send(source, target, 'v1', { queue });
      const v2 = await send(source, target, 'v2', { queue });
      const v3 = await send(source, target, 'v3', { queue });
      // Before any claim: the recipient-side record already shows the replacement.
      for (const old of [v1, v2]) {
        const view = (await service.getMessage(target.id, target.token, old.message.id)).message as Record<string, unknown>;
        expect(view).toMatchObject({ status: 'superseded', superseded_by_id: v3.message.id });
      }
      const latest = (await service.getMessage(target.id, target.token, v3.message.id)).message as Record<string, unknown>;
      expect(latest).toMatchObject({ status: 'queued', event_count: 3, content: 'v3' });
      expect(latest.event_first_at).toBeTruthy();
      const d = (await claim(target))!;
      if (capable) {
        expect(d.kind).toBe('digest');
        const body = JSON.parse(d.content);
        expect(body.entries).toEqual([expect.objectContaining({ message_id: v3.message.id, event_count: 3, preview: 'v3' })]);
        await ack(target, d, 'accepted');
        expect((await service.getDigest(target.id, target.token, d.message_id)).messages).toHaveLength(3);
      } else {
        expect(d).toMatchObject({ kind: 'message', message_id: v3.message.id, content: 'v3', event_count: 3 });
        await ack(target, d, 'accepted');
        await ack(target, d, 'completed');
      }
      expect(await claim(target)).toBeNull();
    });
  it('never supersedes a leased update and keeps other streams independent at send time', async () => {
    env.CXX_QUEUE_DELIVERY_V1_ENABLED = false;
    const source = await peer(),
      target = await peer('codex', false);
    const queue = { delivery_class: 'notice' as const, coalesce_key: 'watchdog:lease:capacity' };
    const v1 = await send(source, target, 'v1', { queue });
    const leased = (await claim(target))!;
    expect(leased.message_id).toBe(v1.message.id);
    const v2 = await send(source, target, 'v2', { queue });
    const other = await send(source, target, 'other key', { queue: { ...queue, coalesce_key: 'watchdog:LEASE:capacity' } });
    const plain = await send(source, target, 'plain info');
    const rows = await db
      .select()
      .from(schema.agentBusMessages)
      .where(inArray(schema.agentBusMessages.id, [v1.message.id, v2.message.id, other.message.id, plain.message.id]));
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get(v1.message.id)).toMatchObject({ status: 'leased', supersededById: null });
    for (const m of [v2, other, plain]) expect(byId.get(m.message.id)).toMatchObject({ status: 'queued', eventCount: 1, supersededById: null });
  });
  it('keeps legacy clients single-message and gated while accepted work is held', async () => {
    const source = await peer(),
      target = await peer('claude', false);
    await send(source, target, 'A');
    await send(source, target, 'B');
    const d = (await claim(target))!;
    expect(d.kind).toBe('message');
    expect(d.content).toBe('A');
    await ack(target, d, 'accepted');
    expect(await claim(target)).toBeNull();
  });
  it('bounds Unicode previews and paginates retained originals', async () => {
    const source = await peer(),
      target = await peer();
    for (let i = 0; i < 25; i++) await send(source, target, '🧯'.repeat(400));
    const d = (await claim(target))!,
      body = JSON.parse(d.content);
    expect(Buffer.byteLength(d.content)).toBeLessThanOrEqual(8192);
    expect(body.entries.length).toBeLessThanOrEqual(20);
    expect(body.entries.length + body.remaining).toBe(25);
    const page = await service.getDigest(target.id, target.token, d.message_id, 0, 2);
    expect(page.messages).toHaveLength(2);
    expect(page.next_after).not.toBeNull();
  });
  it('replays one claim and does not replay a leased digest after feature rollback', async () => {
    const source = await peer(),
      target = await peer();
    await send(source, target, 'A');
    await send(source, target, 'B');
    const id = randomUUID(),
      deliveries = await Promise.all([claim(target, id), claim(target, id)]);
    expect(deliveries[0]?.message_id).toBe(deliveries[1]?.message_id);
    env.CXX_QUEUE_DELIVERY_V1_ENABLED = false;
    expect(await claim(target)).toBeNull();
  });
  it('rejects work condensation and related-work references for another recipient', async () => {
    const source = await peer(),
      target = await peer(),
      other = await peer();
    await expect(
      send(source, target, 'work', {
        kind: 'request',
        queue: { delivery_class: 'notice', coalesce_key: 'no' },
      }),
    ).rejects.toMatchObject({ status: 422 });
    const work = await send(source, other, 'other task', { kind: 'request' });
    await expect(
      send(source, target, 'go', {
        queue: { delivery_class: 'coordination', related_work_id: work.message.id },
      }),
    ).rejects.toMatchObject({ status: 404 });
  });
  it('restores a certainly unpresented digest on rollback without reviving cancellation', async () => {
    const source = await peer(),
      target = await peer();
    const a = await send(source, target, 'cancel me'),
      b = await send(source, target, 'keep me');
    const d = (await claim(target))!;
    await service.acknowledgeSessionDelivery(target.id, target.token, d.message_id, {
      claimId: d.claim_id,
      outcome: 'retry',
    });
    const [original] = await db
      .select()
      .from(schema.agentBusMessages)
      .where(eq(schema.agentBusMessages.id, a.message.id));
    await service.cancelConversation(source.id, source.token, original!.conversationId);
    env.CXX_QUEUE_DELIVERY_V1_ENABLED = false;
    const next = (await claim(target))!;
    expect(next.kind).toBe('message');
    expect(next.message_id).toBe(b.message.id);
    const [canceled] = await db
      .select()
      .from(schema.agentBusMessages)
      .where(eq(schema.agentBusMessages.id, a.message.id));
    expect(canceled?.status).toBe('canceled');
  });
  it('expires individual batched entries before restoring the remaining originals', async () => {
    const source = await peer(),
      target = await peer();
    const a = await send(source, target, 'expires'),
      b = await send(source, target, 'live');
    const d = (await claim(target))!;
    await service.acknowledgeSessionDelivery(target.id, target.token, d.message_id, {
      claimId: d.claim_id,
      outcome: 'retry',
    });
    await db
      .update(schema.agentBusMessages)
      .set({ expiresAt: '2020-01-01T00:00:00Z' })
      .where(eq(schema.agentBusMessages.id, a.message.id));
    expect((await claim(target))?.message_id).toBe(b.message.id);
    expect(
      (await db.select().from(schema.agentBusMessages).where(eq(schema.agentBusMessages.id, a.message.id)))[0]
        ?.status,
    ).toBe('expired');
  });
  it('never replays originals after an accepted digest becomes ambiguous', async () => {
    const source = await peer(),
      target = await peer();
    await send(source, target, 'one');
    await send(source, target, 'two');
    const d = (await claim(target))!;
    await ack(target, d, 'accepted');
    await service.acknowledgeSessionDelivery(target.id, target.token, d.message_id, {
      claimId: d.claim_id,
      outcome: 'ambiguous',
    });
    env.CXX_QUEUE_DELIVERY_V1_ENABLED = false;
    expect(await claim(target)).toBeNull();
    expect((await service.getDigest(target.id, target.token, d.message_id)).messages).toHaveLength(2);
  });
  it('keeps coalescing scoped to sender, recipient, class and explicit key', async () => {
    const source = await peer(),
      other = await peer(),
      target = await peer();
    for (const [sender, key] of [
      [source, 'a'],
      [source, 'b'],
      [other, 'a'],
    ] as const)
      await send(sender, target, key, { queue: { delivery_class: 'progress', coalesce_key: key } });
    const d = (await claim(target))!;
    expect(JSON.parse(d.content).entries.map((x: { event_count: number }) => x.event_count)).toEqual([
      1, 1, 1,
    ]);
  });
  it('allows direct coordination and conferences ahead of catch-up', async () => {
    const source = await peer(),
      target = await peer();
    await send(source, target, 'info one');
    await send(source, target, 'info two');
    await send(source, target, 'LIVE MESSAGE full', { queue: { delivery_class: 'coordination' } });
    const message = (await claim(target))!;
    expect(message.delivery_class).toBe('coordination');
    expect(message.content).toContain('LIVE MESSAGE full');
    expect(message.kind).not.toBe('digest');
    await ack(target, message, 'accepted');
    await ack(target, message, 'completed');
    const room = (await service.openConference(source.id, source.token, { topic: 'full conference' })) as {
      conference_id: string;
    };
    const invited = await service.inviteToConference(source.id, source.token, {
      conferenceId: room.conference_id,
      to: [target.address],
      note: 'LIVE INVITE',
    });
    expect(invited, JSON.stringify(invited)).toMatchObject({ results: [{ delivered: true }] });
    const invite = (await claim(target))!;
    expect(invite.kind).not.toBe('digest');
    expect(invite.delivery_class).toBe('coordination');
    expect(invite.content).toContain('LIVE INVITE');
  });
  it('negotiates only allowlisted hosts and withdraws capability on heartbeat', async () => {
    env.CXX_QUEUE_DELIVERY_V1_HOST_IDS = String(host.id + 9999);
    const source = await peer(),
      target = await peer();
    await send(source, target, 'one');
    await send(source, target, 'two');
    expect((await claim(target))?.kind).toBe('message');
    env.CXX_QUEUE_DELIVERY_V1_HOST_IDS = '';
    const enabled = await peer();
    env.CXX_QUEUE_DELIVERY_V1_ENABLED = false;
    const status = await receiver.update(enabled.id, enabled.token, enabled.generation, 'heartbeat', {});
    expect(status.receiver?.queue_delivery_v1).toBe(false);
  });
  for (const engine of ENGINES)
    it(`${engine}: catch-up preserves auth, engine and receiver fences`, async () => {
      const source = await peer(engine),
        target = await peer(engine);
      await send(source, target, 'A');
      await send(source, target, 'B');
      await expect(
        service.claimForSession(target.id, 'wrong-token', randomUUID(), target.generation),
      ).rejects.toBeDefined();
      await flag(`${engine}_engine_disabled`, '1');
      await expect(claim(target)).rejects.toBeDefined();
      await flag(`${engine}_engine_disabled`, '0');
      await expect(
        service.claimForSession(target.id, target.token, randomUUID(), randomUUID()),
      ).rejects.toBeDefined();
      await db.update(schema.hosts).set({ status: 'disabled' }).where(eq(schema.hosts.id, host.id));
      await expect(claim(target)).rejects.toBeDefined();
      await db.update(schema.hosts).set({ status: 'active' }).where(eq(schema.hosts.id, host.id));
      expect((await claim(target))?.kind).toBe('digest');
    });

  it('restores an expired, never-accepted group even when the queue otherwise looks empty', async () => {
    const source = await peer(),
      target = await peer();
    const a = await send(source, target, 'one'),
      b = await send(source, target, 'two');
    const d = (await claim(target))!;
    await db
      .update(schema.agentBusMessages)
      .set({ status: 'expired', expiredAt: new Date().toISOString(), leaseUntil: null })
      .where(eq(schema.agentBusMessages.id, d.message_id));
    const replacement = (await claim(target))!;
    expect(replacement.kind).toBe('digest');
    expect(replacement.message_id).not.toBe(d.message_id);
    expect(JSON.parse(replacement.content).entries.map((x: { message_id: string }) => x.message_id)).toEqual([
      a.message.id,
      b.message.id,
    ]);
    await expect(service.redriveMessage(d.message_id)).rejects.toMatchObject({ status: 409 });
  });
  it('uses exact case-sensitive keys and retains earlier coalesced events after safe regrouping', async () => {
    const source = await peer(),
      target = await peer();
    const queue = { delivery_class: 'notice' as const, coalesce_key: 'watchdog:exact:capacity' };
    const a = await send(source, target, 'first', { queue });
    const b = await send(source, target, 'second', { queue });
    const first = (await claim(target))!;
    await db
      .update(schema.agentBusMessages)
      .set({ status: 'dead', leaseUntil: null })
      .where(eq(schema.agentBusMessages.id, first.message_id));
    const c = await send(source, target, 'third', { queue });
    const different = await send(source, target, 'different case', {
      queue: { ...queue, coalesce_key: 'watchdog:EXACT:capacity' },
    });
    const next = (await claim(target))!,
      body = JSON.parse(next.content);
    expect(body.entries).toHaveLength(2);
    expect(body.entries.find((x: { message_id: string }) => x.message_id === c.message.id).event_count).toBe(
      3,
    );
    expect(
      body.entries.find((x: { message_id: string }) => x.message_id === different.message.id).event_count,
    ).toBe(1);
    const originals = (await service.getDigest(target.id, target.token, next.message_id)).messages as Array<{
      id: string;
    }>;
    expect(originals.map((x) => x.id)).toEqual([
      a.message.id,
      b.message.id,
      c.message.id,
      different.message.id,
    ]);
  });
  it('delivers one fresh update normally and summarizes one update older than 60 seconds', async () => {
    const source = await peer(),
      target = await peer();
    await send(source, target, 'fresh');
    const fresh = (await claim(target))!;
    expect(fresh.kind).toBe('message');
    await ack(target, fresh, 'accepted');
    await ack(target, fresh, 'completed');
    const old = await send(source, target, 'old full text');
    await db
      .update(schema.agentBusMessages)
      .set({ createdAt: new Date(Date.now() - 61_000).toISOString() })
      .where(eq(schema.agentBusMessages.id, old.message.id));
    const digest = (await claim(target))!;
    expect(digest.kind).toBe('digest');
    expect(JSON.parse(digest.content).entries.map((x: { message_id: string }) => x.message_id)).toEqual([
      old.message.id,
    ]);
  });
});
