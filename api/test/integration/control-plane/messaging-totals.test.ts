import { randomUUID } from 'node:crypto';
import mysql from 'mysql2/promise';
import { drizzle } from 'drizzle-orm/mysql2';
import { describe, expect, it, vi } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import * as schema from '../../../src/db/schema.js';
import { createOwnedControlPlane } from '../../../src/control-plane/bootstrap.js';
import { hydrateMessagingTotals } from '../../../src/control-plane/state/messaging-totals.js';
import { mutateOwnerState } from '../../../src/control-plane/state/runtime.js';
import { stageUpdate } from '../../../src/control-plane/state/rows.js';
import { ownedMessagingTotalsView } from '../../../src/services/agent-messaging/owned-totals.js';
import { runOwnerHistoryRetention } from '../../../src/services/server-retention/owner.js';
import { runOwnerPortalRetention } from '../../../src/services/server-retention/portal-owner.js';
import { readDbConfig } from '../../helpers/test-db.js';
import { loadTestEnv, testKeyring } from '../../helpers/test-keyring.js';
const config = readDbConfig();
describe.skipIf(!config)('historical messaging aggregates on MySQL', () => {
  it('counts cold rows, updates status once, subtracts actual retention, and survives restart', async () => {
    const pool = mysql.createPool({ ...config!, connectionLimit: 4 }),
      db = drizzle(pool, { schema, mode: 'default' }),
      now = new Date().toISOString(),
      past = new Date(Date.now() - 3 * 86400_000).toISOString(),
      oldConversation = randomUUID(),
      liveConversation = randomUUID(),
      coldIds = [randomUUID(), randomUUID()],
      liveId = randomUUID(),
      sessionId = randomUUID(),
      epochs: string[] = [],
      errors: unknown[] = [];
    const env = { ...loadTestEnv(), DB_DATABASE: String(config!.database) };
    let owner: Awaited<ReturnType<typeof createOwnedControlPlane>> | undefined,
      hostId = 0;
    try {
      const [host] = await db
        .insert(schema.hosts)
        .values({
          fqdn: 'counts-' + randomUUID() + '.test',
          apiKey: randomUUID(),
          secure: 1,
          status: 'active',
          engines: 'grok',
          createdAt: now,
          updatedAt: now,
        })
        .$returningId();
      hostId = host!.id;
      for (const [id, at] of [
        [oldConversation, past],
        [liveConversation, now],
      ]) {
        const addressAId = randomUUID(),
          addressBId = randomUUID();
        await db.insert(schema.agentBusConversations).values({
          id: id!,
          addressAId,
          addressBId,
          createdByAddressId: addressAId,
          status: 'open',
          lastActivityAt: at!,
          createdAt: at!,
          updatedAt: at!,
        });
        const ids = id === oldConversation ? coldIds : [liveId];
        for (const [index, messageId] of ids.entries())
          await db.insert(schema.agentBusMessages).values({
            id: messageId,
            conversationId: id!,
            sequence: index + 1,
            senderAddressId: addressAId,
            targetAddressId: addressBId,
            sourceEngine: 'codex',
            targetEngine: 'claude',
            contentEnc: 'opaque-history',
            contentBytes: 1,
            clientMessageId: randomUUID(),
            status: id === oldConversation ? (index ? 'dead' : 'completed') : 'queued',
            nextAttemptAt: at!,
            expiresAt: id === oldConversation ? past : '2099-01-01T00:00:00Z',
            createdAt: at!,
            updatedAt: at!,
          });
      }
      await db.insert(schema.agentSessions).values({
        id: sessionId,
        hostId,
        engine: 'grok',
        username: 'root',
        cwd: '/test',
        invocationKind: 'native',
        status: 'ended',
        hostAuthFingerprint: '0'.repeat(64),
        bridgeTokenHash: '0'.repeat(64),
        bridgeExpiresAt: past,
        startedAt: past,
        heartbeatAt: past,
        endedAt: past,
        expiresAt: past,
        createdAt: past,
        updatedAt: past,
      });
      await db.insert(schema.agentMessages).values({
        messageId: randomUUID(),
        sessionId,
        clientMessageId: randomUUID(),
        contentEnc: 'opaque',
        status: 'dead',
        nextAttemptAt: past,
        createdAt: past,
        updatedAt: past,
      });
      for (const source of ['bridge', 'portal'])
        await db.insert(schema.agentEvents).values({
          sessionId,
          clientEventId: randomUUID(),
          eventType: 'assistant_message',
          source,
          payloadEnc: 'opaque',
          createdAt: past,
        });
      owner = await createOwnedControlPlane({
        pool,
        handle: db,
        env,
        keyring: testKeyring(),
        error: (e) => errors.push(e),
      });
      epochs.push(owner.runtime.state.revision().epoch);
      expect(owner.runtime.state.snapshot().messages.has(coldIds[0]!)).toBe(false);
      expect(owner.runtime.state.snapshot().messagingTotals).toEqual(await hydrateMessagingTotals(db));
      const selects = vi.spyOn(db, 'select');
      const first = ownedMessagingTotalsView(db),
        second = ownedMessagingTotalsView(db);
      expect(second).toEqual(first);
      expect(selects).not.toHaveBeenCalled();
      selects.mockRestore();
      await mutateOwnerState(owner.runtime, {
        kind: 'test.message.complete',
        payload: { id: liveId },
        prepare: (ctx) => {
          stageUpdate(ctx, 'agentBusMessages', liveId, { status: 'completed', completedAt: now });
          return null;
        },
      });
      expect(owner.runtime.state.snapshot().messagingTotals).toEqual(await hydrateMessagingTotals(db));
      await runOwnerHistoryRetention(db, owner.runtime, 'conversations', env);
      expect(
        await db.select().from(schema.agentBusMessages).where(inArray(schema.agentBusMessages.id, coldIds)),
      ).toHaveLength(0);
      expect(owner.runtime.state.snapshot().messagingTotals).toEqual(await hydrateMessagingTotals(db));
      await runOwnerPortalRetention(db, owner.runtime, env, {
        key: 'history:portal',
        dueAt: 0,
        revision: 'test',
      });
      expect(
        await db.select().from(schema.agentSessions).where(eq(schema.agentSessions.id, sessionId)),
      ).toHaveLength(0);
      expect(owner.runtime.state.snapshot().messagingTotals).toEqual(await hydrateMessagingTotals(db));
      const totals = owner.runtime.state.snapshot().messagingTotals;
      await owner.close();
      owner = undefined;
      const freshDb = drizzle(pool, { schema, mode: 'default' });
      owner = await createOwnedControlPlane({
        pool,
        handle: freshDb,
        env,
        keyring: testKeyring(),
        error: (e) => errors.push(e),
      });
      epochs.push(owner.runtime.state.revision().epoch);
      expect(owner.runtime.state.snapshot().messagingTotals).toEqual(totals);
      expect(errors).toEqual([]);
    } finally {
      await owner?.close();
      await db
        .delete(schema.agentBusMessages)
        .where(inArray(schema.agentBusMessages.conversationId, [oldConversation, liveConversation]));
      await db
        .delete(schema.agentBusConversations)
        .where(inArray(schema.agentBusConversations.id, [oldConversation, liveConversation]));
      await db.delete(schema.agentMessages).where(eq(schema.agentMessages.sessionId, sessionId));
      await db.delete(schema.agentEvents).where(eq(schema.agentEvents.sessionId, sessionId));
      await db.delete(schema.agentSessions).where(eq(schema.agentSessions.id, sessionId));
      if (hostId) await db.delete(schema.hosts).where(eq(schema.hosts.id, hostId));
      if (epochs.length)
        await db
          .delete(schema.controlPlaneCommandReceipts)
          .where(inArray(schema.controlPlaneCommandReceipts.ownerEpoch, epochs));
      await pool.end();
    }
  }, 90000);
});
