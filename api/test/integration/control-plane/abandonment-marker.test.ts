import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import * as schema from '../../../src/db/schema.js';
import { stagePortalEvent } from '../../../src/control-plane/state/portal-events.js';
import { OwnerStateSnapshot, OwnerStateStore } from '../../../src/control-plane/state/store.js';
import type { OwnerMutationContext } from '../../../src/control-plane/state/runtime.js';
import type { PersistenceTransaction } from '../../../src/control-plane/persistence.js';
import { getTestDb } from '../../helpers/test-db.js';

const handle = await getTestDb();
describe.skipIf(!handle)('abandonment marker on MySQL', () => {
  afterAll(async () => { await handle?.pool.end(); });
  it('reuses the old marker, preserves a newer cursor and still rejects unrelated duplicate events', async () => {
    const db = handle!.db, now = new Date().toISOString(), id = randomUUID();
    const [inserted] = await db.insert(schema.hosts).values({
      fqdn: `abandonment-${id}.test`, apiKey: id, secure: 1, status: 'active', engines: 'codex', createdAt: now, updatedAt: now,
    });
    const hostId = Number(inserted.insertId);
    try {
      await db.insert(schema.agentSessions).values({
        id, hostId, engine: 'codex', username: 'root', cwd: '/test', invocationKind: 'interactive', status: 'active',
        hostAuthFingerprint: '0'.repeat(64), bridgeTokenHash: '0'.repeat(64), bridgeExpiresAt: now,
        startedAt: now, heartbeatAt: now, createdAt: now, updatedAt: now,
      });
      const [session] = await db.select().from(schema.agentSessions).where(eq(schema.agentSessions.id, id));
      const store = new OwnerStateStore(new OwnerStateSnapshot({ epoch: randomUUID(), sequence: 0n }, { agentSessions: [session!] }));
      const event = { sessionId: id, clientEventId: 'server:abandoned', eventType: 'failed', source: 'bridge', payloadEnc: 'fixture', createdAt: now };
      const append = async (input: typeof event, once = false) => {
        const snapshot = store.snapshot(), draft = store.begin(), revision = { ...snapshot.revision, sequence: snapshot.revision.sequence + 1n };
        const writes: Array<(tx: PersistenceTransaction) => Promise<unknown>> = [];
        const ctx: OwnerMutationContext = { snapshot, draft, revision, write: operation => { writes.push(operation); }, effect() { throw new Error('unexpected effect'); } };
        const result = stagePortalEvent(ctx, input, { once });
        await db.transaction(async tx => { for (const write of writes) await write(tx); });
        store.publish(draft.seal(revision));
        return result.id;
      };
      const original = await append(event, true);
      const newer = await append({ ...event, clientEventId: 'newer', eventType: 'assistant_message' });
      expect(newer).toBeGreaterThan(original);
      expect(await append(event, true)).toBe(original);
      expect(store.snapshot().sessions.get(id)).toMatchObject({ portalEventCursor: newer, portalLastEventType: 'assistant_message' });
      expect(store.snapshot().setting('owner_portal_event_id')).toBe(String(newer));
      expect(await db.select().from(schema.agentEvents).where(eq(schema.agentEvents.sessionId, id))).toHaveLength(2);
      await expect(append(event)).rejects.toMatchObject({ cause: { code: 'ER_DUP_ENTRY' } });
    } finally {
      await db.delete(schema.agentEvents).where(eq(schema.agentEvents.sessionId, id));
      await db.delete(schema.agentSessions).where(eq(schema.agentSessions.id, id));
      await db.delete(schema.hosts).where(eq(schema.hosts.id, hostId));
    }
  });
});
