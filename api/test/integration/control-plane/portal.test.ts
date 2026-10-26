import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import mysql from 'mysql2/promise';
import { drizzle } from 'drizzle-orm/mysql2';
import { eq, inArray } from 'drizzle-orm';
import { getTestDb, readDbConfig } from '../../helpers/test-db.js';
import { runMigrations } from '../../../src/db/migrator.js';
import { testKeyring } from '../../helpers/test-keyring.js';
import { installSqlBudget } from '../../helpers/sql-budget.js';
import * as schema from '../../../src/db/schema.js';
import type { Env } from '../../../src/env.js';
import { ControlPlaneOwnership } from '../../../src/control-plane/owner.js';
import { OwnerPersistence } from '../../../src/control-plane/persistence.js';
import { CommandExecutor } from '../../../src/control-plane/commands.js';
import { DeadlineQueue } from '../../../src/control-plane/deadlines.js';
import { ConnectionPresence, bindOwnerPresence } from '../../../src/control-plane/presence.js';
import { ConnectionCredentials } from '../../../src/control-plane/credentials.js';
import { hydrateOwnerState } from '../../../src/control-plane/state/hydrate.js';
import {
  bindOwnerRuntime,
  mutateOwnerState,
  type OwnerRuntime,
} from '../../../src/control-plane/state/runtime.js';
import { stageUpdate } from '../../../src/control-plane/state/rows.js';
import { AgentPortalService } from '../../../src/services/agent-portal.js';
import { sha256 } from '../../../src/security/hash.js';
import { ENGINES } from '../../../src/util/engine.js';
const handle = await getTestDb();
const base = handle;
let scoped = base;
const database = 'portal_owner_' + randomUUID().replaceAll('-', '');
describe.skipIf(!handle)('owned portal MySQL', () => {
  // Other integration fixtures retain visible attention events. Those bodies
  // are intentionally cold, so use an actually idle fleet for the zero-SQL gate.
  beforeAll(async () => {
    await base!.pool.query(`CREATE DATABASE \`${database}\``);
    const pool = mysql.createPool({ ...readDbConfig()!, database });
    scoped = { pool, db: drizzle(pool, { schema, mode: 'default' }) as NonNullable<typeof base>['db'] };
    await runMigrations(pool, { initSchema: true, appliedBy: 'portal-owner-test' });
  });
  afterAll(async () => {
    await scoped?.pool.end();
    if (base) {
      await base.pool.query(`DROP DATABASE IF EXISTS \`${database}\``);
      await base.pool.end();
    }
  });
  it('keeps idle reads SQL-free, fences exact offers and commits prompt/event/receipt metadata for all engines', async () => {
    const keyring = testKeyring(),
      now = new Date().toISOString(),
      suffix = randomUUID(),
      ids: string[] = [],
      commands: string[] = [];
    const env = { AGENT_PORTAL_BRIDGE_TTL_SECONDS: 3600, AGENT_PORTAL_RETENTION_HOURS: 24 } as Env;
    const owner = new ControlPlaneOwnership(scoped!.pool, database),
      deadlines = new DeadlineQueue((error) => {
        throw error;
      }),
      budget = installSqlBudget(scoped!.pool);
    let drain: (() => Promise<void>) | undefined,
      credentials: ConnectionCredentials | undefined,
      presence: ConnectionPresence | undefined;
    const [h] = await scoped!.db
      .insert(schema.hosts)
      .values({
        fqdn: `portal-${suffix}.test`,
        apiKey: `fixture-${suffix}`,
        apiKeyHash: sha256(`fixture-${suffix}`),
        secure: 1,
        status: 'active',
        engines: ENGINES.join(','),
        createdAt: now,
        updatedAt: now,
      });
    const hostId = Number(h.insertId);
    const [host] = await scoped!.db.select().from(schema.hosts).where(eq(schema.hosts.id, hostId));
    const [a] = await scoped!.db
      .insert(schema.adminUsers)
      .values({
        username: `portal-${suffix}`,
        name: 'Fixture Admin',
        email: `portal-${suffix}@fixture.test`,
        passwordHash: 'fixture',
        accessLevel: 'owner',
        active: 1,
        createdAt: now,
        updatedAt: now,
      });
    const adminId = Number(a.insertId),
      actor = { kind: 'admin' as const, user: { id: adminId, displayName: 'Fixture Admin' } };
    const [oldFlag] = await scoped!.db
      .select()
      .from(schema.versions)
      .where(eq(schema.versions.name, 'agent_portal_enabled'));
    await scoped!.db
      .insert(schema.versions)
      .values({ name: 'agent_portal_enabled', version: '1', updatedAt: now })
      .onDuplicateKeyUpdate({ set: { version: '1' } });
    try {
      await owner.acquire();
      const { store } = await owner.hydrate((connection, epoch) =>
        hydrateOwnerState(
          drizzle(connection, { schema, mode: 'default' }),
          { epoch, sequence: 0n },
          { keyring },
        ),
      );
      owner.ready();
      const executor = new CommandExecutor({
        state: store,
        persistence: new OwnerPersistence(owner, keyring),
        assertOwner: () => owner.assertReady(),
        loseOwner: (error) => owner.lose(error),
        notificationError(error) {
          throw error;
        },
        committed(receipt) {
          commands.push(receipt.id);
        },
      });
      drain = () => executor.drain();
      const runtime: OwnerRuntime = {
        state: store,
        deadlines,
        assertOwner: () => owner.assertReady(),
        execute: (command) => executor.execute(command),
      };
      bindOwnerRuntime(scoped!.db, runtime);
      presence = new ConnectionPresence((error) => {
        throw error;
      });
      bindOwnerPresence(runtime, presence);
      credentials = new ConnectionCredentials(runtime, presence, { session: 3600000, relay: 900000 });
      const portal = new AgentPortalService(scoped!.db, env, keyring);
      for (const engine of ENGINES) {
        const id = randomUUID(),
          token = `portal-${randomUUID()}-${randomUUID()}`,
          native = randomUUID();
        ids.push(id);
        const registration = {
          engine,
          username: 'fixture',
          cwd: '/fixture',
          invocationKind: 'interactive' as const,
          sessionId: id,
          bridgeToken: token,
          upstreamSessionId: randomUUID(),
        };
        expect(await portal.registerAgent(host!, registration)).toMatchObject({
          enabled: true,
          session_id: id,
        });
        await mutateOwnerState(runtime, {
          kind: 'fixture.portal.native',
          payload: { id },
          prepare(ctx) {
            const row = {
              sessionId: id,
              instanceId: native,
              bindingGeneration: 0,
              requestId: null,
              clientMessageId: null,
              actorId: null,
              status: 'ready',
              updatedAt: now,
            };
            ctx.draft.upsert('agentNativeControls', row);
            ctx.write(async (tx) => {
              await tx.insert(schema.agentNativeControls).values(row);
            });
            stageUpdate(ctx, 'agentSessions', id, { relayEnabled: 1 });
            return null;
          },
        });
        const attachment = presence.attach({
          connectionId: randomUUID(),
          hostId,
          username: 'fixture',
          scope: { topic: 'session', session_id: id, binding_generation: 0, native_instance_id: native },
        });
        const cursor = await portal.latestEventCursor();
        budget.reset();
        for (let n = 0; n < 50; n++) {
          const operations: Record<string, () => Promise<unknown>> = {
            authenticate: () => portal.authenticateBridge(id, token),
            heartbeat: () => portal.heartbeatAgent(id, token, {}),
            claim: async () => expect(await portal.claimMessage(id, token, randomUUID())).toBeNull(),
            globalEvents: async () => expect((await portal.listEventsAfter(cursor)).events).toEqual([]),
            sessionEvents: async () => expect((await portal.listEvents(id, cursor)).events).toEqual([]),
            health: () => portal.health(),
            snapshot: () => portal.listAgentsSnapshot(),
          };
          for (const [name, operation] of Object.entries(operations)) {
            await operation();
            expect(budget.snapshot(), name).toEqual([]);
          }
        }
        expect(budget.snapshot()).toEqual([]);
        const input = {
          sessionId: id,
          clientMessageId: randomUUID(),
          content: 'Perform exactly one portal instruction',
        };
        const queued = await portal.enqueueMessage(actor, input),
          messageId = String(queued.message_id);
        expect((await portal.enqueueMessage(actor, input)).message_id).toBe(messageId);
        const claim = randomUUID(),
          offer = await portal.claimMessage(id, token, claim);
        expect(offer?.message_id).toBe(messageId);
        expect((await portal.claimMessage(id, token, claim))?.message_id).toBe(messageId);
        attachment.detach();
        expect(store.snapshot().table('agentMessages').by('messageId', messageId)[0]).toMatchObject({
          status: 'leased',
          ownershipMode: 'connection',
          leaseUntil: null,
          ownerInstanceId: native,
        });
        const accepted = {
          messageId,
          leaseOwner: claim,
          outcome: 'accepted' as const,
          upstreamId: 'fixture-turn',
        };
        await portal.acknowledgeMessage(id, token, accepted);
        await portal.acknowledgeMessage(id, token, accepted);
        expect(await portal.claimMessage(id, token, claim)).toBeNull();
        await expect(
          portal.acknowledgeMessage(id, token, { ...accepted, upstreamId: 'different' }),
        ).rejects.toThrow('different payload');
        const attached = presence.attach({
          connectionId: randomUUID(),
          hostId,
          username: 'fixture',
          scope: { topic: 'session', session_id: id, binding_generation: 0, native_instance_id: native },
        });
        const named = await portal.addAgentEvent(id, token, {
          clientEventId: randomUUID(),
          type: 'session_named',
          source: 'engine',
          payload: { name: 'Portal fixture', native_session_id: registration.upstreamSessionId },
        });
        expect(store.snapshot().sessions.get(id)?.taskTitleEventId).toBe(named.cursor);
        expect(await portal.latestEventCursor()).toBe(named.cursor);
        expect(store.snapshot().sessions.get(id)?.portalLastEventType).toBe('session_named');
        const promptId = randomUUID(),
          question = {
            clientEventId: randomUUID(),
            type: 'waiting_input' as const,
            source: 'engine' as const,
            payload: {
              prompt_id: promptId,
              question: 'Choose a fixture action',
              answer_mode: 'buttons',
              choices: [{ label: 'Proceed', value: 'yes' }],
            },
          };
        const event = await portal.addAgentEvent(id, token, question);
        expect(store.snapshot().table('agentPrompts').get(promptId)?.eventId).toBe(event.cursor);
        const prompt = (await portal.listAgentsSnapshot()).sessions.find((s) => s.id === id)?.pending_prompt;
        expect(prompt).toMatchObject({ id: promptId, version: 1, question: 'Choose a fixture action' });
        const answer = {
          sessionId: id,
          promptId,
          clientMessageId: randomUUID(),
          answer: 'yes',
          version: 1,
          metadata: { choice_value: 'yes' },
        };
        const answerReceipt = await portal.answerPrompt(actor, answer);
        expect(store.snapshot().table('agentPrompts').get(promptId)).toMatchObject({
          status: 'answered',
          answerMessageId: answerReceipt.message_id,
          version: 2,
        });
        expect((await portal.answerPrompt(actor, answer)).message_id).toBe(answerReceipt.message_id);
        await expect(
          portal.answerPrompt(actor, { ...answer, clientMessageId: randomUUID() }),
        ).rejects.toThrow('already answered');
        const answerClaim = randomUUID();
        expect((await portal.claimMessage(id, token, answerClaim))?.message_id).toBe(
          answerReceipt.message_id,
        );
        await portal.forceClose(actor, {
          sessionId: id,
          clientMessageId: randomUUID(),
          note: 'Fixture finished',
        });
        expect(store.snapshot().sessions.get(id)?.endedAt).not.toBeNull();
        expect(
          store.snapshot().table('agentMessages').by('messageId', String(answerReceipt.message_id))[0]
            ?.status,
        ).toBe('leased');
        await portal.acknowledgeMessage(id, token, {
          messageId: String(answerReceipt.message_id),
          leaseOwner: answerClaim,
          outcome: 'accepted',
          upstreamId: 'after-force',
        });
        expect(store.snapshot().table('agentMessages').by('messageId', messageId)[0]?.status).toBe(
          'accepted',
        );
        attached.detach();
      }
    } finally {
      await drain?.();
      credentials?.close();
      deadlines.close();
      presence?.close();
      await owner.close();
      budget.restore();
      if (ids.length) {
        await scoped!.db.delete(schema.agentMessages).where(inArray(schema.agentMessages.sessionId, ids));
        await scoped!.db.delete(schema.agentSessions).where(inArray(schema.agentSessions.id, ids));
      }
      if (commands.length)
        await scoped!.db
          .delete(schema.controlPlaneCommandReceipts)
          .where(inArray(schema.controlPlaneCommandReceipts.requestId, commands));
      await scoped!.db.delete(schema.adminUsers).where(eq(schema.adminUsers.id, adminId));
      await scoped!.db.delete(schema.hosts).where(eq(schema.hosts.id, hostId));
      if (oldFlag)
        await scoped!.db
          .update(schema.versions)
          .set(oldFlag)
          .where(eq(schema.versions.name, 'agent_portal_enabled'));
      else await scoped!.db.delete(schema.versions).where(eq(schema.versions.name, 'agent_portal_enabled'));
    }
  });
});
