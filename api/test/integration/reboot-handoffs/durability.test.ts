import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { eq, sql } from 'drizzle-orm';
import { beforeAll, afterAll, afterEach, describe, expect, it } from 'vitest';
import { getTestDb } from '../../helpers/test-db.js';
import { loadTestEnv, testKeyring } from '../../helpers/test-keyring.js';
import { AgentMessagingService } from '../../../src/services/agent-messaging.js';
import { AgentPortalService } from '../../../src/services/agent-portal.js';
import { RebootHandoffs, assertNoRebootRecovery } from '../../../src/services/reboot-handoffs.js';
import {
  agentRebootHandoffs,
  agentBusConversations,
  agentSessions,
  agentBusAddresses,
  agentBusMessages,
  agentMessages,
  agentSchedules,
  agentTaskResults,
  agentEvents,
  hostDaemonSessions,
  hostDaemonOperations,
  hostDaemonPortalBindings,
  hosts,
  versions,
} from '../../../src/db/schema.js';
import { encrypt } from '../../../src/security/secret-box.js';
import { ENGINES, type Engine } from '../../../src/util/engine.js';

const handle = await getTestDb();
describe.skipIf(!handle)('planned reboot durable transfer', { timeout: 120000 }, () => {
  const db = handle?.db as NonNullable<typeof handle>['db'];
  const keyring = testKeyring();
  const bus = new AgentMessagingService(db, loadTestEnv(), keyring);
  const portal = new AgentPortalService(db, loadTestEnv(), keyring);
  const reboots = new RebootHandoffs(db, keyring);
  let host: typeof hosts.$inferSelect;
  const prefix = `reboot-test-${randomUUID()}`;
  const createdHosts: number[] = [];
  beforeAll(async () => {
    // Real DDL twice proves the migration can replay on already-upgraded hosts.
    const ddl = readFileSync(
      new URL('../../../src/db/migrations/0055_reboot_handoffs.sql', import.meta.url),
      'utf8',
    );
    await db.execute(sql.raw(ddl));
    await db.execute(sql.raw(ddl));
    for (const name of ['agent_messaging_enabled', 'agent_portal_enabled'])
      await db
        .insert(versions)
        .values({ name, version: '1', updatedAt: new Date().toISOString() })
        .onDuplicateKeyUpdate({ set: { version: '1' } });
  });
  afterEach(async () => {
    for (const id of createdHosts.splice(0)) {
      for (const query of [
        `DELETE FROM host_daemon_sessions WHERE host_id=${id}`,
        `DELETE FROM agent_task_results WHERE message_id IN (SELECT id FROM agent_bus_messages WHERE target_address_id IN (SELECT id FROM agent_bus_addresses WHERE host_id=${id}))`,
        `DELETE FROM agent_schedules WHERE target_address_id IN (SELECT id FROM agent_bus_addresses WHERE host_id=${id})`,
        `DELETE FROM agent_reboot_handoffs WHERE host_id=${id}`,
        `DELETE FROM agent_messages WHERE session_id IN (SELECT id FROM agent_sessions WHERE host_id=${id})`,
        `DELETE FROM agent_events WHERE session_id IN (SELECT id FROM agent_sessions WHERE host_id=${id})`,
        `DELETE FROM agent_bus_messages WHERE target_address_id IN (SELECT id FROM agent_bus_addresses WHERE host_id=${id})`,
        `DELETE FROM agent_bus_conversations WHERE address_a_id IN (SELECT id FROM agent_bus_addresses WHERE host_id=${id})`,
        `DELETE FROM agent_sessions WHERE host_id=${id}`,
        `DELETE FROM agent_bus_addresses WHERE host_id=${id}`,
        `DELETE FROM hosts WHERE id=${id}`,
      ])
        await db.execute(sql.raw(query));
    }
  });
  afterAll(async () => {
    await handle?.pool.end();
  });
  async function fixture(engine: Engine = 'codex') {
    const now = new Date().toISOString(),
      fqdn = `${prefix}-${randomUUID()}.example`;
    await db.insert(hosts).values({
      fqdn,
      apiKey: 'b'.repeat(64),
      status: 'active',
      secure: 1,
      engines: ENGINES.join(','),
      agentMessagingEnabled: 1,
      createdAt: now,
      updatedAt: now,
    });
    host = (await db.select().from(hosts).where(eq(hosts.fqdn, fqdn)))[0]!;
    createdHosts.push(host.id);
    const input = {
      engine,
      username: 'reboot-test',
      cwd: '/tmp/reboot-test',
      upstreamSessionId: randomUUID(),
      invocationKind: 'interactive' as const,
      sessionId: randomUUID(),
      bridgeToken: randomBytes(32).toString('base64url'),
      adapterProtocol: 'test-live-v1',
      adapterCapabilities: {
        execution_contract_version: 2,
        reboot_protocol_version: 1,
        launch_identity_version: 1,
      },
    };
    const registered = await bus.registerSession(host!, input);
    const address = registered.address as { id: string; binding_generation: number };
    const body = {
      request_id: randomUUID(),
      boot_id: randomUUID(),
      reason: 'Test planned reboot',
      continuation: 'Verify boot and finish the original task.',
    };
    return { input, address, body, host: host! };
  }
  async function accepted(f: Awaited<ReturnType<typeof fixture>>, kind: 'request' | 'schedule') {
    const now = new Date().toISOString(),
      id = randomUUID(),
      claim = randomUUID(),
      conversationId = randomUUID();
    await db.insert(agentBusConversations).values({
      id: conversationId,
      addressAId: f.address.id,
      addressBId: f.address.id,
      createdByAddressId: f.address.id,
      nextSequence: 2,
      lastActivityAt: now,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(agentBusMessages).values({
      id,
      conversationId,
      sequence: 1,
      senderAddressId: f.address.id,
      targetAddressId: f.address.id,
      sourceEngine: f.input.engine,
      targetEngine: f.input.engine,
      kind,
      workKind: kind,
      executionContractVersion: 2,
      executionVersion: 7,
      contentEnc: encrypt('original task', keyring),
      contentBytes: 13,
      clientMessageId: randomUUID(),
      status: 'accepted',
      attempts: 1,
      nextAttemptAt: now,
      leaseOwner: `session:${f.input.sessionId}`,
      leaseUntil: new Date(Date.now() + 60000).toISOString(),
      claimId: claim,
      targetBindingGeneration: f.address.binding_generation,
      deliverySessionId: f.input.sessionId,
      deliveryUpstreamSessionId: f.input.upstreamSessionId,
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
      acceptedAt: now,
      createdAt: now,
      updatedAt: now,
    });
    return { id, claim };
  }
  for (const engine of ENGINES)
    it(`${engine}: transfers Peer, Wake and Portal correlation once`, async () => {
      const f = await fixture(engine),
        work = await accepted(f, 'request'),
        wake = await accepted(f, 'schedule');
      const portalId = randomUUID(),
        now = new Date().toISOString();
      await db.insert(agentMessages).values({
        messageId: portalId,
        sessionId: f.input.sessionId,
        kind: 'message',
        clientMessageId: randomUUID(),
        contentEnc: encrypt('portal task', keyring),
        status: 'accepted',
        nextAttemptAt: now,
        upstreamId: portalId,
        leaseOwner: randomUUID(),
        createdAt: now,
        updatedAt: now,
      });
      await db
        .update(agentSessions)
        .set({ activeTurnId: portalId })
        .where(eq(agentSessions.id, f.input.sessionId));
      await reboots.prepare(f.input.sessionId, f.input.bridgeToken, f.body);
      await reboots.arm(f.input.sessionId, f.body.request_id);
      await bus.finishSession(f.input.sessionId, f.input.bridgeToken, 'failed'); // OS shutdown is not failure of the held task.
      await bus.maintenance();
      expect(
        (await db.select().from(agentBusMessages).where(eq(agentBusMessages.id, work.id)))[0],
      ).toMatchObject({ status: 'reboot_hold', claimId: work.claim, executionVersion: 7 });
      const next = {
        ...f.input,
        sessionId: randomUUID(),
        bridgeToken: randomBytes(32).toString('base64url'),
        rebootRequestId: f.body.request_id,
        rebootBootId: randomUUID(),
      };
      await bus.registerSession(f.host, next);
      await bus.registerSession(f.host, next); // lost registration response
      const restore = await reboots.restore(next.sessionId);
      expect(restore.peer).toHaveLength(2);
      expect(restore.portal?.message_id).toBe(portalId);
      await portal.addAgentEvent(next.sessionId, next.bridgeToken, {
        clientEventId: randomUUID(),
        type: 'message_processing',
        source: 'bridge',
        payload: { message_id: portalId },
      });
      const reply = {
        clientEventId: randomUUID(),
        type: 'assistant_message' as const,
        source: 'bridge' as const,
        payload: { text: 'Verified new boot', message_id: portalId, summary: 'Reboot verified' },
      };
      await portal.addAgentEvent(next.sessionId, next.bridgeToken, reply);
      await portal.addAgentEvent(next.sessionId, next.bridgeToken, reply);
      expect(
        await db.select().from(agentEvents).where(eq(agentEvents.clientEventId, reply.clientEventId)),
      ).toHaveLength(1);
      expect(
        (await db.select().from(agentSessions).where(eq(agentSessions.id, next.sessionId)))[0]
          ?.upstreamSessionId,
      ).toBe(f.input.upstreamSessionId);
      await expect(
        bus.renewSessionDelivery(f.input.sessionId, f.input.bridgeToken, work.id, work.claim),
      ).rejects.toThrow();
      for (const w of [work, wake]) {
        const receipt = {
          claimId: w.claim,
          outcome: 'completed' as const,
          taskResult: { status: 'succeeded' as const, summary: 'verified new boot' },
        };
        await bus.acknowledgeSessionDelivery(next.sessionId, next.bridgeToken, w.id, receipt);
        await bus.acknowledgeSessionDelivery(next.sessionId, next.bridgeToken, w.id, receipt);
        expect(
          await db.select().from(agentTaskResults).where(eq(agentTaskResults.messageId, w.id)),
        ).toHaveLength(1);
      }
      await expect(bus.registerSession(f.host, { ...next, sessionId: randomUUID() })).rejects.toThrow();
      await expect(
        reboots.prepare(next.sessionId, next.bridgeToken, {
          ...f.body,
          request_id: randomUUID(),
          boot_id: next.rebootBootId,
        }),
      ).rejects.toThrow(/consumed/);
    });
  it('serializes two requests for the host and rejects changed replay bodies', async () => {
    const f = await fixture();
    const results = await Promise.allSettled([
      reboots.prepare(f.input.sessionId, f.input.bridgeToken, f.body),
      reboots.prepare(f.input.sessionId, f.input.bridgeToken, { ...f.body, request_id: randomUUID() }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const [r] = await db.select().from(agentRebootHandoffs).where(eq(agentRebootHandoffs.hostId, f.host.id));
    await expect(
      reboots.prepare(f.input.sessionId, f.input.bridgeToken, {
        ...f.body,
        request_id: r!.id,
        reason: 'changed',
      }),
    ).rejects.toThrow(/different input/);
  });
  it('rejects competing recovery before mutation and blocks recovery after prepare', async () => {
    const f = await fixture(),
      now = new Date().toISOString(),
      id = randomUUID();
    await db.insert(agentSchedules).values({
      id,
      name: 'persistent',
      targetAddressId: f.address.id,
      promptEnc: encrypt('test', keyring),
      kind: 'interval',
      intervalMinutes: 5,
      timezone: 'UTC',
      enabled: 1,
      persistent: 1,
      progressTimeoutSeconds: 600,
      createdBy: 'test',
      updatedBy: 'test',
      createdAt: now,
      updatedAt: now,
    });
    await expect(reboots.prepare(f.input.sessionId, f.input.bridgeToken, f.body)).rejects.toThrow(
      /competing/,
    );
    expect(
      await db.select().from(agentRebootHandoffs).where(eq(agentRebootHandoffs.hostId, f.host.id)),
    ).toHaveLength(0);
    await db.delete(agentSchedules).where(eq(agentSchedules.id, id));
    await reboots.prepare(f.input.sessionId, f.input.bridgeToken, f.body);
    await expect(assertNoRebootRecovery(db, f.address.id)).rejects.toThrow();
  });
  it('refuses same boot and canceled work without binding a new launch', async () => {
    const f = await fixture(),
      work = await accepted(f, 'request');
    await reboots.prepare(f.input.sessionId, f.input.bridgeToken, f.body);
    await reboots.arm(f.input.sessionId, f.body.request_id);
    const next = {
      ...f.input,
      sessionId: randomUUID(),
      rebootRequestId: f.body.request_id,
      rebootBootId: f.body.boot_id,
    };
    await expect(bus.registerSession(f.host, next)).rejects.toThrow();
    await db
      .update(agentBusMessages)
      .set({ cancelRequestedAt: new Date().toISOString() })
      .where(eq(agentBusMessages.id, work.id));
    await expect(bus.registerSession(f.host, { ...next, rebootBootId: randomUUID() })).rejects.toThrow(
      /canceled/,
    );
    expect(await db.select().from(agentSessions).where(eq(agentSessions.id, next.sessionId))).toHaveLength(0);
  });
  it('expires an unclaimed handoff as ambiguous, never queued or succeeded', async () => {
    const f = await fixture(),
      work = await accepted(f, 'request');
    await reboots.prepare(f.input.sessionId, f.input.bridgeToken, f.body);
    await reboots.arm(f.input.sessionId, f.body.request_id);
    await db
      .update(agentRebootHandoffs)
      .set({ expiresAt: '2000-01-01T00:00:00.000Z' })
      .where(eq(agentRebootHandoffs.id, f.body.request_id));
    await bus.maintenance();
    expect(
      (await db.select().from(agentBusMessages).where(eq(agentBusMessages.id, work.id)))[0],
    ).toMatchObject({ status: 'ambiguous', taskResultStatus: null });
    expect(
      (await db.select().from(agentRebootHandoffs).where(eq(agentRebootHandoffs.id, f.body.request_id)))[0]
        ?.activeHostId,
    ).toBeNull();
  });
  it('marks held Portal work dead when the continuation cannot start', async () => {
    const f = await fixture(),
      messageId = randomUUID(),
      now = new Date().toISOString();
    await db
      .insert(agentMessages)
      .values({
        messageId,
        sessionId: f.input.sessionId,
        kind: 'message',
        clientMessageId: randomUUID(),
        contentEnc: encrypt('portal task', keyring),
        status: 'accepted',
        nextAttemptAt: now,
        upstreamId: messageId,
        leaseOwner: randomUUID(),
        createdAt: now,
        updatedAt: now,
      });
    await db
      .update(agentSessions)
      .set({ activeTurnId: messageId })
      .where(eq(agentSessions.id, f.input.sessionId));
    await reboots.prepare(f.input.sessionId, f.input.bridgeToken, f.body);
    await reboots.arm(f.input.sessionId, f.body.request_id);
    await reboots.finish(f.host.id, f.body.request_id, true);
    expect(
      (await db.select().from(agentMessages).where(eq(agentMessages.messageId, messageId)))[0]?.status,
    ).toBe('dead');
    await expect(reboots.ready(f.host.id, f.body.request_id, randomUUID())).rejects.toThrow();
  });
  for (const outcome of ['expired', 'finished'] as const)
    it(`preserves the remote logical session and resolves held operation as ${outcome}`, async () => {
      const f = await fixture(),
        now = new Date().toISOString(),
        logical = randomUUID(),
        operation = randomUUID();
      await db.insert(hostDaemonSessions).values({
        id: logical,
        hostId: f.host.id,
        owner: 'test',
        engine: f.input.engine,
        username: f.input.username,
        cwd: f.input.cwd,
        title: 'Reboot test',
        addressId: f.address.id,
        sessionId: f.input.sessionId,
        status: 'running',
        lastActivityAt: now,
        createdAt: now,
      });
      await db
        .insert(hostDaemonPortalBindings)
        .values({ portalSessionId: f.input.sessionId, daemonSessionId: logical });
      await db.insert(hostDaemonOperations).values({
        id: operation,
        sessionId: logical,
        hostId: f.host.id,
        clientKey: randomUUID(),
        requestHash: 'a'.repeat(64),
        promptEnc: encrypt('task', keyring),
        status: 'accepted',
        claimId: randomUUID(),
        createdAt: now,
        updatedAt: now,
      });
      await reboots.prepare(f.input.sessionId, f.input.bridgeToken, f.body);
      await reboots.arm(f.input.sessionId, f.body.request_id);
      if (outcome === 'expired') {
        await reboots.disarm(f.host.id, f.body.request_id);
      } else {
        const next = {
          ...f.input,
          sessionId: randomUUID(),
          bridgeToken: randomBytes(32).toString('base64url'),
          rebootRequestId: f.body.request_id,
          rebootBootId: randomUUID(),
        };
        await bus.registerSession(f.host, next);
        expect(
          (await db.select().from(hostDaemonSessions).where(eq(hostDaemonSessions.id, logical)))[0]
            ?.sessionId,
        ).toBe(next.sessionId);
        await reboots.finish(f.host.id, f.body.request_id, false, {
          status: 'succeeded',
          summary: 'Boot verified',
        });
      }
      expect(
        (await db.select().from(hostDaemonOperations).where(eq(hostDaemonOperations.id, operation)))[0]
          ?.status,
      ).toBe(outcome === 'expired' ? 'unknown' : 'completed');
      expect(
        (await db.select().from(hostDaemonSessions).where(eq(hostDaemonSessions.id, logical)))[0]?.status,
      ).toBe('waiting');
    });
});
